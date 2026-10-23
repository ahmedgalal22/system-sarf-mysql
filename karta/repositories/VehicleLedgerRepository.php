<?php
/**
 * repositories/VehicleLedgerRepository.php — Vehicle Ledger data access
 *
 * Financial identity: client_id + client_type (canonical, single source of truth).
 * Asset ownership: vehicle_owner_id + vehicle_owner_name (separate concept).
 */

class VehicleLedgerRepository {
    private PDO $db;
    public function __construct(PDO $db) { $this->db = $db; }

    public function getById(int $id): ?array {
        $stmt = $this->db->prepare('SELECT * FROM vehicle_ledger WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':id' => $id]);
        $r = $stmt->fetch(); return $r ?: null;
    }

    public function getAllByUsername(string $username): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicle_ledger WHERE username = :u AND deleted_at IS NULL AND is_archived = 0 ORDER BY created_at DESC'
        );
        $stmt->execute([':u' => $username]);
        return $stmt->fetchAll();
    }

    public function getByVehicle(string $vehicleId): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicle_ledger WHERE vehicle_id = :vid AND deleted_at IS NULL ORDER BY created_at DESC'
        );
        $stmt->execute([':vid' => $vehicleId]);
        return $stmt->fetchAll();
    }

    public function getByClient(string $clientId, string $clientType): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicle_ledger WHERE client_id = :cid AND client_type = :ct AND deleted_at IS NULL AND is_reversed = 0 ORDER BY date DESC, created_at DESC'
        );
        $stmt->execute([':cid' => $clientId, ':ct' => $clientType]);
        return $stmt->fetchAll();
    }

    public function getByReference(string $referenceId): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicle_ledger WHERE reference_id = :rid AND deleted_at IS NULL ORDER BY created_at DESC'
        );
        $stmt->execute([':rid' => $referenceId]);
        return $stmt->fetchAll();
    }

    public function getActiveByReference(string $referenceId, string $referenceType): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM vehicle_ledger WHERE reference_id = :rid AND reference_type = :rt AND is_reversed = 0 AND deleted_at IS NULL'
        );
        $stmt->execute([':rid' => $referenceId, ':rt' => $referenceType]);
        return $stmt->fetchAll();
    }

    public function create(array $data): array {
        $uuid = $data['uuid'] ?? $this->uuid();
        $stmt = $this->db->prepare(
            'INSERT INTO vehicle_ledger (uuid, username, vehicle_id, vehicle_plate, vehicle_owner_id, vehicle_owner_name,
                client_id, client_type, client_name,
                type, effect, amount, reference_type, reference_id, receipt_number,
                date, applied_at, note, is_reversed, is_archived, archive_batch_id,
                created_by, created_at, updated_at)
             VALUES (:uuid, :username, :vehicle_id, :vehicle_plate, :vehicle_owner_id, :vehicle_owner_name,
                :client_id, :client_type, :client_name,
                :type, :effect, :amount, :reference_type, :reference_id, :receipt_number,
                :date, :applied_at, :note, :is_reversed, :is_archived, :archive_batch_id,
                :created_by, NOW(3), NOW(3))'
        );
        $stmt->execute([
            ':uuid'              => $uuid,
            ':username'          => $data['username'],
            ':vehicle_id'        => $data['vehicle_id'] ?? null,
            ':vehicle_plate'     => $data['vehicle_plate'] ?? null,
            ':vehicle_owner_id'  => $data['vehicle_owner_id'] ?? null,
            ':vehicle_owner_name'=> $data['vehicle_owner_name'] ?? null,
            ':client_id'         => $data['client_id'] ?? null,
            ':client_type'       => $data['client_type'] ?? null,
            ':client_name'       => $data['client_name'] ?? null,
            ':type'              => $data['type'] ?? 'deposit',
            ':effect'            => $data['effect'] ?? null,
            ':amount'            => intval($data['amount'] ?? 0),
            ':reference_type'    => $data['reference_type'] ?? null,
            ':reference_id'      => $data['reference_id'] ?? null,
            ':receipt_number'    => $data['receipt_number'] ?? null,
            ':date'              => $data['date'] ?? null,
            ':applied_at'        => $data['applied_at'] ?? null,
            ':note'              => $data['note'] ?? null,
            ':is_reversed'       => intval($data['is_reversed'] ?? 0),
            ':is_archived'       => intval($data['is_archived'] ?? 0),
            ':archive_batch_id'  => $data['archive_batch_id'] ?? null,
            ':created_by'        => $data['username'],
        ]);
        return $this->getById((int)$this->db->lastInsertId());
    }

    public function update(int $id, array $patch, string $username, ?string $expectedUpdatedAt = null): ?array {
        if ($expectedUpdatedAt !== null) {
            $cur = $this->getById($id);
            if ($cur && $cur['updated_at'] !== $expectedUpdatedAt) return null;
        }
        $allowed = ['type','effect','amount','date','note','is_reversed','reversed_at','reversed_by',
                     'client_id','client_type','client_name','vehicle_owner_id','vehicle_owner_name'];
        $fields = []; $params = [':id' => $id, ':updated_by' => $username];
        foreach ($allowed as $f) {
            if (array_key_exists($f, $patch)) { $fields[] = "`{$f}` = :{$f}"; $params[":{$f}"] = $patch[$f]; }
        }
        if (empty($fields)) return $this->getById($id);
        $fields[] = 'updated_by = :updated_by';
        $fields[] = 'updated_at = NOW(3)';
        $this->db->prepare('UPDATE vehicle_ledger SET ' . implode(', ', $fields) . ' WHERE id = :id AND deleted_at IS NULL')->execute($params);
        return $this->getById($id);
    }

    public function reverseByReference(string $referenceId, string $referenceType, string $username): int {
        $now = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d H:i:s.v');
        $stmt = $this->db->prepare(
            'UPDATE vehicle_ledger SET is_reversed = 1, reversed_at = :now, reversed_by = :u, updated_at = NOW(3)
             WHERE reference_id = :rid AND reference_type = :rt AND is_reversed = 0 AND deleted_at IS NULL'
        );
        $stmt->execute([':rid' => $referenceId, ':rt' => $referenceType, ':u' => $username, ':now' => $now]);
        return $stmt->rowCount();
    }

    /**
     * Format the office balance withdrawal reference string:
     *   "قيمة كارتة - {selected vehicle owner's name}"
     * Avoids duplicating the prefix if already formatted.
     */
    public static function formatOfficeWithdrawalReference(?string $ownerName): string {
        $clean = preg_replace('/\s+/u', ' ', trim((string)($ownerName ?? '')));
        if (preg_match('/^(?:قيمة\s+كارتة\s*-\s*)+(.+)$/u', $clean, $m)) {
            $clean = trim($m[1]);
        }
        return $clean !== '' ? ('قيمة كارتة - ' . $clean) : 'قيمة كارتة';
    }

    /**
     * Synchronize office balance deductions (OFFICE_WITHDRAW_AUTO) for a receipt
     * inside the active database transaction.
     *
     * Exact deduction rule per row:
     *   Office balance deduction = الصافي (net) + قيمة خانة الصرف (sarf)
     *   where net = (weight - deficit) * noloon - (ohda + officeAmount + sarf) + add
     *
     * Exact reference format:
     *   قيمة كارتة - {selected vehicle owner's name}
     *
     * Reverses any previous active OFFICE_WITHDRAW_AUTO entries for this receipt
     * before inserting the new deduction entries so edits/retries never duplicate
     * deductions and always reflect the exact current receipt state.
     */
    public function syncOfficeDeductionsForReceipt(
        string $username,
        string $receiptId,
        ?string $receiptNumber,
        ?string $receiptDate,
        array $rows,
        OfficeRepository $officeRepo,
        ?string $receiptClientName = null,
        ?string $receiptClientId = null,
        ?string $previousClientName = null
    ): array {
        $now = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d H:i:s.v');

        // 1. Reverse any existing active office deduction entries for this receipt
        $revStmt = $this->db->prepare(
            "UPDATE vehicle_ledger
             SET is_reversed = 1, reversed_at = :now, reversed_by = :u, updated_at = NOW(3)
             WHERE reference_id = :rid
               AND reference_type = 'receipt'
               AND client_type = 'office'
               AND type = 'OFFICE_WITHDRAW_AUTO'
               AND is_reversed = 0
               AND deleted_at IS NULL"
        );
        $revStmt->execute([
            ':rid' => $receiptId,
            ':u'   => $username,
            ':now' => $now,
        ]);

        if (empty($rows)) {
            return [];
        }

        // 2. Map user's active offices by normalized name and ID
        $allOffices = $officeRepo->getAllByUsername($username);
        if (empty($allOffices)) {
            return [];
        }

        $officeByNameKey = [];
        $officeById = [];
        foreach ($allOffices as $o) {
            $oid = (int)($o['id'] ?? 0);
            if ($oid <= 0) continue;
            $officeById[$oid] = $o;
            $nameKey = mb_strtolower(preg_replace('/\s+/u', ' ', trim((string)($o['name'] ?? ''))), 'UTF-8');
            if ($nameKey !== '') {
                $officeByNameKey[$nameKey] = $o;
            }
        }

        // Detect whether rows carry multiple distinct vehicle owners
        $distinctRowOwners = [];
        foreach ($rows as $r) {
            if (!is_array($r)) continue;
            $rt = $r['_type'] ?? ($r['type'] ?? ($r['row_type'] ?? ''));
            if ($rt === 'separator') continue;
            $rn = preg_replace('/\s+/u', ' ', trim((string)($r['owner_name'] ?? ($r['vehicle_owner_name'] ?? ''))));
            if ($rn !== '') {
                $distinctRowOwners[mb_strtolower($rn, 'UTF-8')] = $rn;
            }
        }
        $hasMultipleRowOwners = count($distinctRowOwners) > 1;
        $recOwnerName = preg_replace('/\s+/u', ' ', trim((string)($receiptClientName ?? '')));
        $prevOwnerName = preg_replace('/\s+/u', ' ', trim((string)($previousClientName ?? '')));

        // 3. Aggregate (net + sarf) in cents per (office, vehicle_owner)
        $deductionGroups = [];
        foreach ($rows as $row) {
            if (!is_array($row)) continue;
            $rowType = $row['_type'] ?? ($row['type'] ?? ($row['row_type'] ?? ''));
            if ($rowType === 'separator') continue;

            $office = null;
            if (!empty($row['office_id']) && isset($officeById[(int)$row['office_id']])) {
                $office = $officeById[(int)$row['office_id']];
            } else {
                $officeKey = mb_strtolower(preg_replace('/\s+/u', ' ', trim((string)($row['office'] ?? ''))), 'UTF-8');
                if ($officeKey !== '' && isset($officeByNameKey[$officeKey])) {
                    $office = $officeByNameKey[$officeKey];
                }
            }
            if (!$office) continue;

            $hasFormulaInputs = array_key_exists('weight', $row) || array_key_exists('noloon', $row);
            if (!$hasFormulaInputs && isset($row['net']) && $row['net'] !== '') {
                $rowNetDecimal = round(floatval($row['net']), 2);
            } else {
                $w   = floatval($row['weight'] ?? 0);
                $def = floatval($row['deficit'] ?? 0);
                $nol = floatval($row['noloon'] ?? 0);
                $ohd = floatval($row['ohda'] ?? 0);
                $ofc = floatval($row['officeAmount'] ?? ($row['office_amount'] ?? 0));
                $srf = floatval($row['sarf'] ?? 0);
                $add = floatval($row['add'] ?? 0);
                $rowNetDecimal = round((($w - $def) * $nol) - ($ohd + $ofc + $srf) + $add, 2);
            }

            $rowSarfDecimal = round(floatval($row['sarf'] ?? 0), 2);
            $rowDeductionCents = (int)round($rowNetDecimal * 100) + (int)round($rowSarfDecimal * 100);

            $rowOwnerName = preg_replace('/\s+/u', ' ', trim((string)($row['owner_name'] ?? ($row['vehicle_owner_name'] ?? ''))));
            $rowOwnerId   = trim((string)($row['owner_id'] ?? ($row['vehicle_owner_id'] ?? '')));

            if ($hasMultipleRowOwners) {
                $effectiveOwnerName = $rowOwnerName !== '' ? $rowOwnerName : $recOwnerName;
                $effectiveOwnerId   = $rowOwnerId !== '' ? $rowOwnerId : (trim((string)($receiptClientId ?? '')) ?: null);
            } else {
                if ($recOwnerName !== '' && $rowOwnerName !== '' && $recOwnerName !== $rowOwnerName) {
                    $effectiveOwnerName = ($prevOwnerName !== '' && $recOwnerName === $prevOwnerName)
                        ? $rowOwnerName
                        : $recOwnerName;
                } else {
                    $effectiveOwnerName = $recOwnerName !== '' ? $recOwnerName : $rowOwnerName;
                }
                $effectiveOwnerId = trim((string)($receiptClientId ?? '')) ?: ($rowOwnerId !== '' ? $rowOwnerId : null);
            }

            $oid = (int)$office['id'];
            $groupKey = $oid . '::' . mb_strtolower($effectiveOwnerName, 'UTF-8');
            if (!isset($deductionGroups[$groupKey])) {
                $deductionGroups[$groupKey] = [
                    'office_id'   => $oid,
                    'owner_id'    => $effectiveOwnerId,
                    'owner_name'  => $effectiveOwnerName,
                    'total_cents' => 0,
                ];
            }
            $deductionGroups[$groupKey]['total_cents'] += $rowDeductionCents;
        }

        // 4. Create ledger entry per (office, vehicle_owner) with reference "قيمة كارتة - {owner_name}"
        $created = [];
        $effectiveDate = !empty($receiptDate) ? $receiptDate : (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d');

        foreach ($deductionGroups as $group) {
            $totalDeductionCents = (int)$group['total_cents'];
            if ($totalDeductionCents === 0) continue;
            $oid = (int)$group['office_id'];
            $office = $officeById[$oid];
            $ownerName = $group['owner_name'];
            $refNote = self::formatOfficeWithdrawalReference($ownerName);

            $created[] = $this->create([
                'username'           => $username,
                'vehicle_owner_id'   => $group['owner_id'],
                'vehicle_owner_name' => $ownerName !== '' ? $ownerName : null,
                'client_id'          => strval($oid),
                'client_type'        => 'office',
                'client_name'        => $office['name'] ?? null,
                'type'               => 'OFFICE_WITHDRAW_AUTO',
                'effect'             => 'office_deduction',
                'amount'             => -$totalDeductionCents,
                'reference_type'     => 'receipt',
                'reference_id'       => strval($receiptId),
                'receipt_number'     => $receiptNumber !== null ? strval($receiptNumber) : null,
                'date'               => $effectiveDate,
                'applied_at'         => $now,
                'is_reversed'        => 0,
                'note'               => $refNote,
            ]);
        }

        return $created;
    }

    public function softDelete(int $id, string $username): bool {
        $stmt = $this->db->prepare('UPDATE vehicle_ledger SET deleted_at = NOW(3), deleted_by = :u WHERE id = :id AND deleted_at IS NULL');
        $stmt->execute([':id' => $id, ':u' => $username]);
        return $stmt->rowCount() > 0;
    }

    private function uuid(): string {
        $d = random_bytes(16); $d[6] = chr(ord($d[6]) & 0x0f | 0x40); $d[8] = chr(ord($d[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
