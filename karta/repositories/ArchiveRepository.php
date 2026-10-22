<?php
/**
 * repositories/ArchiveRepository.php — Archive data access
 *
 * Manages archive_batches, financial_snapshots, and the is_archived flag
 * on the 4 financial tables (receipts, treasury, vehicle_ledger, main_capital_treasury).
 */

class ArchiveRepository {
    private PDO $db;

    /** Tables that carry the is_archived / archive_batch_id columns. */
    private const ARCHIVABLE_TABLES = [
        'receipts',
        'treasury',
        'vehicle_ledger',
        'main_capital_treasury',
    ];

    /** Business-date column per table. */
    private const DATE_FIELD = [
        'receipts'               => 'receipt_date',
        'treasury'               => 'date',
        'vehicle_ledger'         => 'date',
        'main_capital_treasury'  => 'date',
    ];

    public function __construct(PDO $db) { $this->db = $db; }

    // ── Batches ────────────────────────────────────────────────────────────

    public function createBatch(array $data): array {
        $uuid = $data['uuid'] ?? $data['id'] ?? $this->uuid();
        $stmt = $this->db->prepare(
            'INSERT INTO archive_batches
                (uuid, username, from_date, to_date, status, archive_version,
                 snapshot_id, notes, archived_at, archived_by, created_at, updated_at)
             VALUES
                (:uuid, :username, :from_date, :to_date, :status, :version,
                 :snapshot_id, :notes, :archived_at, :archived_by, NOW(3), NOW(3))'
        );
        $stmt->execute([
            ':uuid'        => $uuid,
            ':username'    => $data['username'],
            ':from_date'   => $data['from_date'],
            ':to_date'     => $data['to_date'],
            ':status'      => $data['status'] ?? 'archived',
            ':version'     => intval($data['archive_version'] ?? 1),
            ':snapshot_id' => $data['snapshot_id'] ?? null,
            ':notes'       => $data['notes'] ?? null,
            ':archived_at' => $data['archived_at'] ?? null,
            ':archived_by' => $data['archived_by'] ?? null,
        ]);
        return $this->getBatchByUuid($uuid);
    }

    public function getBatchByUuid(string $uuid): ?array {
        $stmt = $this->db->prepare('SELECT * FROM archive_batches WHERE uuid = :uuid AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':uuid' => $uuid]);
        $r = $stmt->fetch(); return $r ?: null;
    }

    public function getBatchById(int $id): ?array {
        $stmt = $this->db->prepare('SELECT * FROM archive_batches WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':id' => $id]);
        $r = $stmt->fetch(); return $r ?: null;
    }

    public function listBatches(string $username): array {
        $stmt = $this->db->prepare(
            'SELECT * FROM archive_batches WHERE username = :u AND deleted_at IS NULL ORDER BY created_at DESC'
        );
        $stmt->execute([':u' => $username]);
        return $stmt->fetchAll();
    }

    public function updateBatch(int $id, array $patch, string $username): array {
        $fields = [];
        $params = [':id' => $id];
        foreach (['status','archive_version','snapshot_id','restored_at','last_rearchived_at','notes'] as $f) {
            if (array_key_exists($f, $patch)) {
                $fields[] = "$f = :$f";
                $params[":$f"] = $patch[$f];
            }
        }
        if (empty($fields)) return $this->getBatchById($id);
        $sql = 'UPDATE archive_batches SET ' . implode(', ', $fields) . ', updated_at = NOW(3) WHERE id = :id AND deleted_at IS NULL';
        $this->db->prepare($sql)->execute($params);
        return $this->getBatchById($id);
    }

    public function softDeleteBatch(int $id): bool {
        $stmt = $this->db->prepare('UPDATE archive_batches SET deleted_at = NOW(3) WHERE id = :id AND deleted_at IS NULL');
        $stmt->execute([':id' => $id]);
        return $stmt->rowCount() > 0;
    }

    // ── Snapshots ──────────────────────────────────────────────────────────

    public function createSnapshot(array $data): array {
        $uuid = $data['uuid'] ?? $data['id'] ?? $this->uuid();
        $clientBal = $data['client_balances'] ?? null;
        if (is_array($clientBal)) $clientBal = json_encode($clientBal, JSON_UNESCAPED_UNICODE);

        $stmt = $this->db->prepare(
            'INSERT INTO financial_snapshots
                (uuid, archive_batch_id, snapshot_date, treasury_balance, client_balances, integrity_hash, created_at)
             VALUES
                (:uuid, :batch_id, :snap_date, :treasury, :clients, :hash, NOW(3))'
        );
        $stmt->execute([
            ':uuid'      => $uuid,
            ':batch_id'  => $data['archive_batch_id'],
            ':snap_date' => $data['snapshot_date'] ?? null,
            ':treasury'  => intval($data['treasury_balance'] ?? 0),
            ':clients'   => $clientBal,
            ':hash'      => $data['integrity_hash'] ?? null,
        ]);
        return $this->getSnapshotByUuid($uuid);
    }

    public function getSnapshotByUuid(string $uuid): ?array {
        $stmt = $this->db->prepare('SELECT * FROM financial_snapshots WHERE uuid = :uuid AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':uuid' => $uuid]);
        $r = $stmt->fetch();
        if ($r) $r = $this->decodeSnapshot($r);
        return $r ?: null;
    }

    public function getSnapshotByBatchUuid(string $batchUuid): ?array {
        $stmt = $this->db->prepare(
            'SELECT * FROM financial_snapshots WHERE archive_batch_id = :bid AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1'
        );
        $stmt->execute([':bid' => $batchUuid]);
        $r = $stmt->fetch();
        if ($r) $r = $this->decodeSnapshot($r);
        return $r ?: null;
    }

    public function softDeleteSnapshot(string $uuid): bool {
        $stmt = $this->db->prepare('UPDATE financial_snapshots SET deleted_at = NOW(3) WHERE uuid = :uuid AND deleted_at IS NULL');
        $stmt->execute([':uuid' => $uuid]);
        return $stmt->rowCount() > 0;
    }

    // ── Archive / Restore records ──────────────────────────────────────────

    /**
     * Set is_archived = 1 on all matching records within the date range.
     */
    public function archiveRecords(string $username, string $fromDate, string $toDate, string $batchUuid, string $now): int {
        $total = 0;
        foreach (self::ARCHIVABLE_TABLES as $table) {
            $dateCol = self::DATE_FIELD[$table];
            $sql = "UPDATE $table
                    SET is_archived = 1, archive_batch_id = :batch, archived_at = :now
                    WHERE username = :u
                      AND deleted_at IS NULL
                      AND is_archived = 0
                      AND $dateCol >= :from_date
                      AND $dateCol <= :to_date";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([
                ':batch'     => $batchUuid,
                ':now'       => $now,
                ':u'         => $username,
                ':from_date' => $fromDate,
                ':to_date'   => $toDate,
            ]);
            $total += $stmt->rowCount();
        }
        return $total;
    }

    /**
     * Remove archive flags from all records belonging to a specific batch.
     */
    public function restoreRecords(string $batchUuid): int {
        $total = 0;
        foreach (self::ARCHIVABLE_TABLES as $table) {
            $sql = "UPDATE $table
                    SET is_archived = 0, archive_batch_id = NULL, archived_at = NULL
                    WHERE archive_batch_id = :batch AND is_archived = 1";
            $stmt = $this->db->prepare($sql);
            $stmt->execute([':batch' => $batchUuid]);
            $total += $stmt->rowCount();
        }
        return $total;
    }

    /**
     * Compute financial snapshot from current live data up to $toDate.
     * Both treasury and vehicle_ledger are scoped to $username.
     */
    public function computeSnapshot(string $username, string $toDate): array {
        // Treasury balance — scoped to username
        $stmt = $this->db->prepare(
            "SELECT
                COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) AS total_in,
                COALESCE(SUM(CASE WHEN type = 'withdraw' THEN amount ELSE 0 END), 0) AS total_out
             FROM treasury
             WHERE username = :u AND is_reversed = 0 AND deleted_at IS NULL AND date <= :d"
        );
        $stmt->execute([':u' => $username, ':d' => $toDate]);
        $row = $stmt->fetch();
        $treasuryBalance = intval($row['total_in']) - intval($row['total_out']);

        // Client balances — scoped to username + isolated by client_type
        $stmt = $this->db->prepare(
            "SELECT
                client_id AS cid,
                client_type AS ctype,
                client_name AS cname,
                SUM(CASE
                    WHEN type IN ('deposit','receipt_due') THEN amount
                    ELSE -ABS(amount)
                END) AS balance
             FROM vehicle_ledger
             WHERE username = :u AND is_reversed = 0 AND deleted_at IS NULL AND date <= :d
             GROUP BY cid, ctype, cname
             HAVING cid IS NOT NULL"
        );
        $stmt->execute([':u' => $username, ':d' => $toDate]);
        $clients = [];
        while ($r = $stmt->fetch()) {
            $clients[] = [
                'id'      => $r['cid'],
                'type'    => $r['ctype'],
                'name'    => $r['cname'] ?? '',
                'balance' => intval($r['balance']),
            ];
        }

        return [
            'treasury_balance' => $treasuryBalance,
            'client_balances'  => $clients,
        ];
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    private function decodeSnapshot(array $row): array {
        if (isset($row['client_balances']) && is_string($row['client_balances'])) {
            $row['client_balances'] = json_decode($row['client_balances'], true) ?? [];
        }
        return $row;
    }

    private function uuid(): string {
        $d = random_bytes(16);
        $d[6] = chr(ord($d[6]) & 0x0f | 0x40);
        $d[8] = chr(ord($d[8]) & 0x3f | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }
}
