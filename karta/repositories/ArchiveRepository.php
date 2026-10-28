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

    public function getBatchByUuid(string $uuid, bool $forUpdate = false): ?array {
        $sql = 'SELECT * FROM archive_batches WHERE uuid = :uuid AND deleted_at IS NULL LIMIT 1';
        if ($forUpdate) {
            $sql .= ' FOR UPDATE';
        }
        $stmt = $this->db->prepare($sql);
        $stmt->execute([':uuid' => $uuid]);
        $r = $stmt->fetch(); return $r ?: null;
    }

    public function getBatchById(int $id): ?array {
        $stmt = $this->db->prepare('SELECT * FROM archive_batches WHERE id = :id AND deleted_at IS NULL LIMIT 1');
        $stmt->execute([':id' => $id]);
        $r = $stmt->fetch(); return $r ?: null;
    }

    public function listBatches(string $username, bool $forUpdate = false): array {
        $order = $forUpdate ? 'ORDER BY id ASC FOR UPDATE' : 'ORDER BY created_at DESC, id DESC';
        $stmt = $this->db->prepare(
            "SELECT * FROM archive_batches WHERE username = :u AND deleted_at IS NULL {$order}"
        );
        $stmt->execute([':u' => $username]);
        return $stmt->fetchAll();
    }

    public function updateBatch(int $id, array $patch, string $username): array {
        $fields = [];
        $params = [':id' => $id, ':u' => $username];
        foreach (['status','archive_version','snapshot_id','restored_at','last_rearchived_at','notes'] as $f) {
            if (array_key_exists($f, $patch)) {
                $fields[] = "$f = :$f";
                $params[":$f"] = $patch[$f];
            }
        }
        if (empty($fields)) return $this->getBatchById($id);
        $sql = 'UPDATE archive_batches SET ' . implode(', ', $fields) . ', updated_at = NOW(3) WHERE id = :id AND username = :u AND deleted_at IS NULL';
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
     * Lock all active, non-archived records within [fromDate, toDate] across
     * ARCHIVABLE_TABLES in canonical table order (receipts -> treasury ->
     * vehicle_ledger -> main_capital_treasury) and ascending primary-key (`id ASC`) order.
     *
     * Calling this before `computeSnapshot()` and `archiveRecords()` guarantees
     * that the financial snapshot and the archived record set are 100% consistent.
     *
     * @return array<string, int[]> Map of table name => sorted locked primary-key IDs
     */
    public function lockArchivableRecords(string $username, string $fromDate, string $toDate): array {
        $lockedByTable = [];
        foreach (self::ARCHIVABLE_TABLES as $table) {
            $dateCol = self::DATE_FIELD[$table];
            $idStmt = $this->db->prepare(
                "SELECT id FROM {$table}
                 WHERE username = :u
                   AND deleted_at IS NULL
                   AND is_archived = 0
                   AND {$dateCol} >= :from_date
                   AND {$dateCol} <= :to_date
                 ORDER BY id ASC"
            );
            $idStmt->execute([
                ':u'         => $username,
                ':from_date' => $fromDate,
                ':to_date'   => $toDate,
            ]);
            $ids = array_values(array_unique(array_filter(array_map('intval', $idStmt->fetchAll(PDO::FETCH_COLUMN)), fn($v) => $v > 0)));
            if (empty($ids)) {
                $lockedByTable[$table] = [];
                continue;
            }
            sort($ids, SORT_NUMERIC);

            $placeholders = [];
            $bind = [':u' => $username];
            foreach ($ids as $i => $cid) {
                $ph = ':id_' . $i;
                $placeholders[] = $ph;
                $bind[$ph] = $cid;
            }
            $inClause = implode(', ', $placeholders);
            $lockStmt = $this->db->prepare(
                "SELECT id FROM {$table}
                 WHERE id IN ({$inClause})
                   AND username = :u
                   AND deleted_at IS NULL
                   AND is_archived = 0
                 ORDER BY id ASC FOR UPDATE"
            );
            $lockStmt->execute($bind);
            $lockedByTable[$table] = array_values(array_map('intval', $lockStmt->fetchAll(PDO::FETCH_COLUMN)));
        }
        return $lockedByTable;
    }

    /**
     * Set is_archived = 1 on all matching records within the date range.
     * When $prelockedIdsByTable is provided from lockArchivableRecords(), updates
     * only the exact locked primary keys so snapshot and archived rows cannot diverge.
     */
    public function archiveRecords(
        string $username,
        string $fromDate,
        string $toDate,
        string $batchUuid,
        string $now,
        ?array $prelockedIdsByTable = null
    ): int {
        $total = 0;
        foreach (self::ARCHIVABLE_TABLES as $table) {
            if ($prelockedIdsByTable !== null && array_key_exists($table, $prelockedIdsByTable)) {
                $ids = $prelockedIdsByTable[$table];
                if (empty($ids)) {
                    continue;
                }
                $placeholders = [];
                $bind = [
                    ':batch' => $batchUuid,
                    ':now'   => $now,
                    ':u'     => $username,
                ];
                foreach (array_values($ids) as $i => $cid) {
                    $ph = ':id_' . $i;
                    $placeholders[] = $ph;
                    $bind[$ph] = intval($cid);
                }
                $inClause = implode(', ', $placeholders);
                $sql = "UPDATE {$table}
                        SET is_archived = 1, archive_batch_id = :batch, archived_at = :now
                        WHERE id IN ({$inClause})
                          AND username = :u
                          AND deleted_at IS NULL
                          AND is_archived = 0";
                $stmt = $this->db->prepare($sql);
                $stmt->execute($bind);
                $total += $stmt->rowCount();
                continue;
            }

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
     * Executes in ARCHIVABLE_TABLES order (receipts -> treasury -> vehicle_ledger -> main_capital_treasury).
     */
    public function restoreRecords(string $batchUuid, ?string $username = null): int {
        $total = 0;
        $hasUser = $username !== null && trim($username) !== '';
        foreach (self::ARCHIVABLE_TABLES as $table) {
            if ($hasUser) {
                $sql = "UPDATE $table
                        SET is_archived = 0, archive_batch_id = NULL, archived_at = NULL
                        WHERE username = :u AND archive_batch_id = :batch AND is_archived = 1";
                $stmt = $this->db->prepare($sql);
                $stmt->execute([':u' => $username, ':batch' => $batchUuid]);
            } else {
                $sql = "UPDATE $table
                        SET is_archived = 0, archive_batch_id = NULL, archived_at = NULL
                        WHERE archive_batch_id = :batch AND is_archived = 1";
                $stmt = $this->db->prepare($sql);
                $stmt->execute([':batch' => $batchUuid]);
            }
            $total += $stmt->rowCount();
        }
        return $total;
    }

    /**
     * Compute financial snapshot from current live (non-archived) data in the archived period.
     * Both treasury and vehicle_ledger are scoped to $username, is_reversed = 0,
     * deleted_at IS NULL, is_archived = 0, and the batch's date range.
     * Sign conventions and client grouping match FinancialService.getClientBalance().
     */
    public function computeSnapshot(string $username, string $toDate, ?string $fromDate = null): array {
        $hasFrom = $fromDate !== null && trim($fromDate) !== '';
        $dateFilter = $hasFrom ? 'AND date >= :from_date AND date <= :d' : 'AND date <= :d';
        $params = [':u' => $username, ':d' => $toDate];
        if ($hasFrom) {
            $params[':from_date'] = $fromDate;
        }

        // Treasury balance — scoped to username and non-archived period records
        $stmt = $this->db->prepare(
            "SELECT
                COALESCE(SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END), 0) AS total_in,
                COALESCE(SUM(CASE WHEN type = 'withdraw' THEN amount ELSE 0 END), 0) AS total_out
             FROM treasury
             WHERE username = :u AND is_reversed = 0 AND deleted_at IS NULL AND is_archived = 0 $dateFilter"
        );
        $stmt->execute($params);
        $row = $stmt->fetch();
        $treasuryBalance = intval($row['total_in']) - intval($row['total_out']);

        // Client balances — grouped by stable (client_id, client_type), matching getClientBalance()
        $stmt = $this->db->prepare(
            "SELECT
                client_id AS cid,
                client_type AS ctype,
                MAX(client_name) AS cname,
                SUM(CASE
                    WHEN (client_type = 'office' OR type IN ('OFFICE_DEPOSIT', 'OFFICE_WITHDRAW_AUTO')) THEN
                        CASE
                            WHEN type IN ('OFFICE_WITHDRAW_AUTO', 'withdraw', 'receipt_payment') THEN -ABS(amount)
                            ELSE amount
                        END
                    WHEN type IN ('deposit', 'receipt_due') THEN amount
                    ELSE -ABS(amount)
                END) AS balance
             FROM vehicle_ledger
             WHERE username = :u AND is_reversed = 0 AND deleted_at IS NULL AND is_archived = 0 $dateFilter
             GROUP BY client_id, client_type
             HAVING cid IS NOT NULL"
        );
        $stmt->execute($params);
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
