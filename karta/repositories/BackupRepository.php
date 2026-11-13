<?php
/**
 * repositories/BackupRepository.php — MySQL Native Backup & Restore (Phase 10B)
 *
 * Full-snapshot backup: reads ALL tables from MySQL, outputs JSON.
 * Full-destructive restore: validates JSON, clears tables, inserts all data.
 * Zero IndexedDB involvement. Zero client-side storage.
 */

class BackupRepository {
    private PDO $db;

    /**
     * Tables in restore order (parents before children).
     * This order prevents FK violations during restore.
     */
    private const TABLE_ORDER = [
        'users',
        'vehicle_owners',
        'owner_account_details',
        'vehicles',
        'offices',
        'hamola_details',
        'drivers',
        'notes',
        'receipt_counters',
        'receipts',
        'treasury',
        'vehicle_ledger',
        'main_capital_treasury',
        'archive_batches',
        'financial_snapshots',
    ];

    /**
     * Archive tables retained in schema and backup format during Phase 1.
     */
    private const ARCHIVE_TABLES = [
        'archive_batches',
        'financial_snapshots',
    ];

    /**
     * Business tables that carry the retained `is_archived` / `archive_batch_id` columns.
     */
    private const ARCHIVABLE_BUSINESS_TABLES = [
        'receipts',
        'treasury',
        'vehicle_ledger',
        'main_capital_treasury',
    ];

    /**
     * Tables introduced after the original v2.0.0 snapshot format or optional
     * in legacy backups.
     * Pre-existing backups that omit these keys continue to validate with their
     * original checksum rules, while newer backups include them in validation,
     * checksum calculation, and restore ordering.
     */
    private const OPTIONAL_LEGACY_TABLES = [
        'owner_account_details',
        'archive_batches',
        'financial_snapshots',
    ];

    public function __construct(PDO $db) { $this->db = $db; }

    // ── BACKUP ────────────────────────────────────────────────────────────

    /**
     * Create a full snapshot of all tables.
     * Returns associative array: { tables: { tableName: [rows], ... }, meta: {...} }
     */
    public function createBackup(string $username): array {
        $tables = [];
        $totalRows = 0;

        foreach (self::TABLE_ORDER as $table) {
            // Verify table exists
            $check = $this->db->query("SHOW TABLES LIKE '$table'")->fetchAll();
            if (empty($check)) {
                $tables[$table] = [];
                continue;
            }

            $stmt = $this->db->query("SELECT * FROM `$table`");
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            // Decode JSON columns inline
            foreach ($rows as &$row) {
                foreach ($row as $col => &$val) {
                    if (is_string($val) && strlen($val) > 1) {
                        $first = $val[0];
                        if ($first === '[' || $first === '{') {
                            $decoded = json_decode($val, true);
                            if (json_last_error() === JSON_ERROR_NONE) {
                                $val = $decoded;
                            }
                        }
                    }
                }
                unset($val);
            }
            unset($row);

            $tables[$table] = $rows;
            $totalRows += count($rows);
        }

        $now = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d H:i:s');

        $backup = [
            'system' => [
                'name'       => 'Karta ERP v2',
                'version'    => '2.0.0',
                'format'     => 'mysql-full-snapshot',
                'created_at' => $now,
                'created_by' => $username,
                'tables'     => count(self::TABLE_ORDER),
                'total_rows' => $totalRows,
                'checksum'   => '', // computed below
            ],
            'tables' => $tables,
        ];

        // Compute checksum from row counts per table
        $backup['system']['checksum'] = $this->computeChecksum($backup);

        return $backup;
    }

    // ── RESTORE ───────────────────────────────────────────────────────────

    /**
     * Validate a backup structure before restore.
     * Returns ['valid' => bool, 'errors' => [...]]
     */
    public function validateBackup(array $backup): array {
        $errors = [];

        if (!isset($backup['system']['version'])) {
            $errors[] = 'Missing system.version';
        }
        if (!isset($backup['system']['checksum'])) {
            $errors[] = 'Missing system.checksum';
        }
        if (!isset($backup['tables']) || !is_array($backup['tables'])) {
            $errors[] = 'Missing or invalid tables section';
        }

        if (!empty($errors)) return ['valid' => false, 'errors' => $errors];

        // Verify all required tables exist in backup
        foreach (self::TABLE_ORDER as $table) {
            if (!array_key_exists($table, $backup['tables'])) {
                if (in_array($table, self::OPTIONAL_LEGACY_TABLES, true)) {
                    continue;
                }
                $errors[] = "Missing table: $table";
            } elseif (!is_array($backup['tables'][$table])) {
                $errors[] = "Invalid data for table: $table";
            }
        }

        // Verify checksum (supports both skipped-key legacy checksums and zero-count archive checksums when archive keys are omitted)
        $expected = $this->computeChecksum($backup);
        $legacyZeroArchiveExpected = $this->computeChecksumWithZeroOmittedArchive($backup);
        if (
            $backup['system']['checksum'] !== $expected &&
            $backup['system']['checksum'] !== $legacyZeroArchiveExpected
        ) {
            $errors[] = "Checksum mismatch: expected=$expected, got={$backup['system']['checksum']}";
        }

        // Reject backups containing archive batches, financial snapshots, or archived business records
        $backupArchiveData = $this->findBackupArchiveData($backup['tables']);
        if (!empty($backupArchiveData)) {
            $details = implode(', ', array_map(
                fn($t, $c) => "$t ($c rows)",
                array_keys($backupArchiveData),
                array_values($backupArchiveData)
            ));
            $errors[] = "Cannot restore backup because it contains data from the removed Archive feature ($details).";
        }

        // Prevent silent loss of existing archive data if a legacy backup omits archive table keys
        $nonEmptyArchive = $this->findNonEmptyOmittedArchiveTables($backup['tables']);
        if (!empty($nonEmptyArchive)) {
            $details = implode(', ', array_map(
                fn($t, $c) => "$t ($c rows)",
                array_keys($nonEmptyArchive),
                array_values($nonEmptyArchive)
            ));
            $errors[] = "Cannot restore legacy backup missing archive table keys because the target database contains existing archive data ($details). Export a full backup with archive tables or clear archive data first.";
        }

        return ['valid' => empty($errors), 'errors' => $errors];
    }

    /**
     * Full destructive restore from a validated backup.
     * MUST be called inside a transaction.
     */
    public function restore(array $backup, string $username): array {
        // Enforce all validation and archive-safety guards BEFORE any destructive operation
        $validation = $this->validateBackup($backup);
        if (!$validation['valid']) {
            throw new RuntimeException(implode(' | ', $validation['errors']));
        }

        $stats = [];
        $tables = (isset($backup['tables']) && is_array($backup['tables'])) ? $backup['tables'] : [];

        // Disable FK checks for safe truncation
        $this->db->exec('SET FOREIGN_KEY_CHECKS = 0');

        try {
            // Clear all tables in reverse order (children first)
            // NOTE: Do NOT use ALTER TABLE here — DDL causes implicit COMMIT
            // in MySQL, which kills the active transaction. Auto-increment
            // resets naturally when rows are inserted with explicit id values.
            foreach (array_reverse(self::TABLE_ORDER) as $table) {
                if (in_array($table, self::ARCHIVE_TABLES, true) && !array_key_exists($table, $tables)) {
                    continue;
                }
                if (!$this->tableExists($table)) {
                    continue;
                }
                $this->db->exec("DELETE FROM `$table`");
            }

            // Insert data in correct order (parents first)
            foreach (self::TABLE_ORDER as $table) {
                if (!array_key_exists($table, $tables) && in_array($table, self::OPTIONAL_LEGACY_TABLES, true)) {
                    $stats[$table] = 0;
                    continue;
                }

                $rows = $tables[$table] ?? [];
                $inserted = 0;

                if (!empty($rows) && $this->tableExists($table)) {
                    $columns = array_keys($rows[0]);
                    $placeholders = implode(', ', array_fill(0, count($columns), '?'));
                    $colList = implode(', ', array_map(fn($c) => "`$c`", $columns));
                    $sql = "INSERT INTO `$table` ($colList) VALUES ($placeholders)";
                    $stmt = $this->db->prepare($sql);

                    foreach ($rows as $row) {
                        $values = [];
                        foreach ($columns as $col) {
                            $val = $row[$col] ?? null;
                            // Re-encode JSON arrays/objects back to strings for storage
                            if (is_array($val)) {
                                $val = json_encode($val, JSON_UNESCAPED_UNICODE);
                            }
                            $values[] = $val;
                        }
                        $stmt->execute($values);
                        $inserted++;
                    }
                }

                $stats[$table] = $inserted;
            }

        } finally {
            // Always re-enable FK checks
            $this->db->exec('SET FOREIGN_KEY_CHECKS = 1');
        }

        return $stats;
    }

    // ── INTERNAL HELPERS & CHECKSUM ──────────────────────────────────────

    private function tableExists(string $table): bool {
        $stmt = $this->db->query("SHOW TABLES LIKE '$table'");
        if (!$stmt) return false;
        $rows = $stmt->fetchAll();
        return !empty($rows);
    }

    private function getTableRowCount(string $table): int {
        if (!$this->tableExists($table)) {
            return 0;
        }
        $stmt = $this->db->query("SELECT COUNT(*) AS cnt FROM `$table`");
        if (!$stmt) {
            return 0;
        }
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (is_array($row)) {
            return intval($row['cnt'] ?? reset($row) ?? 0);
        }
        return intval($row ?? 0);
    }

    private function isArchivedRow(array $row): bool {
        $flag = $row['is_archived'] ?? 0;
        if ($flag === 1 || $flag === '1' || $flag === true || $flag === 'true') {
            return true;
        }
        $batchId = $row['archive_batch_id'] ?? null;
        if (is_string($batchId) && trim($batchId) !== '') {
            return true;
        }
        return false;
    }

    /**
     * Inspect backup payload for non-empty archive tables (`archive_batches`,
     * `financial_snapshots`) or archived business records (`is_archived = 1` or
     * non-empty `archive_batch_id` in `receipts`, `treasury`, `vehicle_ledger`,
     * `main_capital_treasury`).
     *
     * @return array<string,int>
     */
    private function findBackupArchiveData(array $tables): array {
        $found = [];

        foreach (self::ARCHIVE_TABLES as $archiveTable) {
            if (isset($tables[$archiveTable]) && is_array($tables[$archiveTable])) {
                $count = count($tables[$archiveTable]);
                if ($count > 0) {
                    $found[$archiveTable] = $count;
                }
            }
        }

        foreach (self::ARCHIVABLE_BUSINESS_TABLES as $businessTable) {
            if (!isset($tables[$businessTable]) || !is_array($tables[$businessTable])) {
                continue;
            }
            $archivedCount = 0;
            foreach ($tables[$businessTable] as $row) {
                if (is_array($row) && $this->isArchivedRow($row)) {
                    $archivedCount++;
                }
            }
            if ($archivedCount > 0) {
                $found["$businessTable.is_archived"] = $archivedCount;
            }
        }

        return $found;
    }

    /**
     * If a backup omits one or both archive table keys (`archive_batches`, `financial_snapshots`),
     * inspect the target database and return any omitted archive table that currently contains rows.
     *
     * @return array<string,int>
     */
    private function findNonEmptyOmittedArchiveTables(array $tables): array {
        $nonEmpty = [];
        foreach (self::ARCHIVE_TABLES as $archiveTable) {
            if (!array_key_exists($archiveTable, $tables)) {
                $count = $this->getTableRowCount($archiveTable);
                if ($count > 0) {
                    $nonEmpty[$archiveTable] = $count;
                }
            }
        }
        return $nonEmpty;
    }

    private function computeChecksum(array $backup): string {
        $parts = ['karta-v2-v1'];
        $tables = (isset($backup['tables']) && is_array($backup['tables'])) ? $backup['tables'] : [];
        foreach (self::TABLE_ORDER as $table) {
            if (
                in_array($table, self::OPTIONAL_LEGACY_TABLES, true) &&
                !array_key_exists($table, $tables)
            ) {
                continue;
            }
            $count = (array_key_exists($table, $tables) && is_array($tables[$table]))
                ? count($tables[$table])
                : 0;
            $parts[] = "$table:$count";
        }
        return hash('sha256', implode('|', $parts));
    }

    private function computeChecksumWithZeroOmittedArchive(array $backup): string {
        $parts = ['karta-v2-v1'];
        $tables = (isset($backup['tables']) && is_array($backup['tables'])) ? $backup['tables'] : [];
        foreach (self::TABLE_ORDER as $table) {
            if (
                $table === 'owner_account_details' &&
                !array_key_exists($table, $tables)
            ) {
                continue;
            }
            $count = array_key_exists($table, $tables) && is_array($tables[$table])
                ? count($tables[$table])
                : 0;
            $parts[] = "$table:$count";
        }
        return hash('sha256', implode('|', $parts));
    }
}
