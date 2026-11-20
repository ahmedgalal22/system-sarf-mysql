<?php
/** Read model for the vehicle owners table only. All reads use the caller's one snapshot. */
require_once __DIR__ . '/VehicleOwnerRepository.php';

final class VehicleOwnerListRepository {
    private PDO $db;
    public function __construct(PDO $db) { $this->db = $db; }

    // Match the original bound *string* client_id using the ledger column's collation.
    // For eligibility, by contrast, space-only names count and only byte-exact 'broker'
    // is excluded. A normal SQL comparison would fold case and/or trailing spaces.
    private const SCOPED_LEDGER = " FROM vehicle_owners o JOIN vehicle_ledger l ON l.client_id = CAST(o.id AS CHAR)
        WHERE o.username = ? AND o.deleted_at IS NULL AND HEX(o.name) <> ''
            AND (o.owner_type IS NULL OR HEX(o.owner_type) <> HEX('broker'))
            AND l.username = ? AND l.client_type = 'owner' AND l.deleted_at IS NULL AND l.is_reversed = 0";

    public function getForUser(string $username): array {
        $owners = [];
        // Keep the very same input order for stable UI ties, including equal created_at.
        foreach ((new VehicleOwnerRepository($this->db))->getAllByUsername($username) as $o) {
            if ($o['deleted_at'] !== null || !is_string($o['name']) || $o['name'] === '' || $o['owner_type'] === 'broker') continue;
            $owners[$o['id']] = ['id' => (string)$o['id'], 'name' => $o['name'], 'phone' => $o['phone'],
                'summary' => ['balance_cents' => 0, 'activity' => null]];
        }
        if (!$owners) return [];

        // First nonempty raw date (not trimmed/parsed in SQL). No ID, time sort keys or
        // ledger history buffer needed to prove the ordinary result. PDO is unbuffered.
        $scan = $this->db->prepare("SELECT o.id AS owner_id, l.type, CAST(l.amount AS CHAR) AS amount,
                CASE WHEN LENGTH(l.date) > 0 THEN CAST(l.date AS CHAR)
                     WHEN HEX(l.applied_at) <> '' THEN l.applied_at ELSE CAST(l.created_at AS CHAR) END AS raw_activity"
            . self::SCOPED_LEDGER);
        $scan->execute([$username, $username]);
        $states = [];
        while ($row = $scan->fetch(PDO::FETCH_ASSOC)) {
            $id = $row['owner_id'];
            if (!isset($owners[$id])) continue;
            $states[$id] ??= new VehicleOwnerListScan();
            $states[$id]->add($row);
        }
        $scan->closeCursor();

        $precision = $activity = [];
        foreach ($states as $id => $state) {
            $summary = $state->summary();
            $owners[$id]['summary'] = $summary;
            if (isset($summary['precision_entries'])) $precision[] = $id;
            elseif (is_array($summary['activity'])) $activity[] = $id;
        }
        $this->replay($precision, true, $username, $owners, $states);
        $this->replay($activity, false, $username, $owners, $states);
        return array_values($owners);
    }

    /** Only the exceptional owners, batched below DB parameter limits, on the same PDO transaction. */
    private function replay(array $ids, bool $precision, string $username, array &$owners, array $states): void {
        // For precision, keep EVERY operand + sort key. For activity alone, identical
        // date/time inputs tie until the JS comparator's last key, the unique UINT id.
        // Only the greatest ID in such a tie can win. HEX distinguishes even case/space
        // differences in the VARCHAR applied_at; date/created_at are DATE/DATETIME(3).
        $columns = $precision ? 'l.id, l.type, CAST(l.amount AS CHAR) AS amount' : 'MAX(l.id) AS id';
        $group = $precision ? '' : ' GROUP BY o.id, l.date, l.applied_at, HEX(l.applied_at), l.created_at';
        foreach (array_chunk($ids, 512) as $batch) {
            $markers = implode(',', array_fill(0, count($batch), '?'));
            $q = $this->db->prepare("SELECT o.id AS owner_id, $columns, l.date, l.applied_at, l.created_at"
                . self::SCOPED_LEDGER . " AND o.id IN ($markers)" . $group);
            $q->execute([$username, $username, ...$batch]);
            while ($row = $q->fetch(PDO::FETCH_ASSOC)) {
                $id = $row['owner_id'];
                unset($row['owner_id']);
                $states[$id]->appendReplay($owners[$id]['summary'], $row);
            }
            $q->closeCursor();
        }
    }
}

/** Constant scan state per nonempty owner; only actual browser replay output grows with rows. */
final class VehicleOwnerListScan {
    private int $budget;
    private int $net = 0;
    private string $maxDay = '';
    // For each set of possible winners: null = unseen, string = one raw value, false = mixed.
    private string|false|null $latestRaw = null;
    private string|false|null $unknownRaw = null;

    public function __construct() { $this->budget = min(1_000_000_000_000_000, PHP_INT_MAX); }

    /** financial.js:getClientBalance, scoped to rows returned for client_type=owner. */
    private static function leg(string $type, string $amount): string {
        return match ($type) {
            'deposit' => 'deposit',
            'withdraw' => 'withdraw', // signed, NOT absolute
            'OFFICE_DEPOSIT', 'receipt_due' => $amount[0] === '-' ? 'withdraw_abs' : 'deposit',
            'OFFICE_WITHDRAW_AUTO', 'receipt_payment' => 'withdraw_abs',
            default => 'none', // still participates in activity
        };
    }

    /** Only accept proven leading days. Whitespace, zero date, etc. stay possible winners. */
    private static function knownDay(string $raw): ?string {
        return preg_match('/^([0-9]{4}-[0-9]{2}-[0-9]{2})/', $raw, $m) && $m[1] !== '0000-00-00' ? $m[1] : null;
    }

    public function add(array $e): void {
        if (!is_string($e['amount']) || !preg_match('/^-?[0-9]+$/D', $e['amount']) || !is_string($e['type'])) {
            throw new UnexpectedValueException('Invalid owner ledger operand');
        }
        if ($this->budget < 0) return; // replay will include the entire history, even earlier small/ignored legs
        $leg = self::leg($e['type'], $e['amount']);
        if ($leg !== 'none') {
            // Same sum-of-absolute-cents guard as before. Inside it every Money round-trip
            // and intermediate sum is exact in any order. Outside it DO NOT use this net.
            if (abs((float)$e['amount']) > $this->budget) {
                $this->budget = -1;
                return;
            }
            $c = (int)$e['amount'];
            $this->budget -= abs($c);
            $this->net += match ($leg) {
                'deposit' => $c,
                'withdraw' => -$c,
                'withdraw_abs' => -abs($c),
            };
        }
        $raw = $e['raw_activity'] ?? '';
        $day = self::knownDay($raw);
        if ($day === null) {
            $this->unknownRaw = self::common($this->unknownRaw, $raw);
        } elseif (strcmp($day, $this->maxDay) > 0) {
            $this->maxDay = $day;
            $this->latestRaw = $raw;
        } elseif ($day === $this->maxDay) {
            $this->latestRaw = self::common($this->latestRaw, $raw);
        }
    }

    private static function common(string|false|null $a, string|false|null $b): string|false|null {
        if ($a === null) return $b;
        if ($b === null) return $a;
        return $a === $b ? $a : false;
    }

    public function summary(): array {
        if ($this->budget < 0) return ['precision_entries' => []];
        // Unknown days cannot be pruned. If ALL possible winners return the same raw
        // date||applied_at||created_at, no Cairo/time/ID comparison can change activity.
        $raw = self::common($this->latestRaw, $this->unknownRaw);
        return ['balance_cents' => $this->net, 'activity' => $raw === false ? [] : ($raw === '' ? null : $raw)];
    }

    public function appendReplay(array &$summary, array $e): void {
        if (isset($summary['precision_entries'])) {
            $e['leg'] = self::leg($e['type'], $e['amount']);
            unset($e['type']);
            $summary['precision_entries'][] = $e; // untouched JS comparator, Money conversions and accumulation order
            return;
        }
        foreach (['date', 'applied_at', 'created_at'] as $key) {
            if ($e[$key] === null || $e[$key] === '') continue;
            $day = self::knownDay($e[$key]);
            if ($day !== null && $day !== $this->maxDay) return;
            break;
        }
        $summary['activity'][] = $e;
    }
}
