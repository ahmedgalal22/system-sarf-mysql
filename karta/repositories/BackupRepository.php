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
        'vehicles',
        'agents',
        'offices',
        'hamola_details',
        'drivers',
        'notes',
        'receipt_counters',
        'receipts',
        'treasury',
        'vehicle_ledger',
        'bolsa_forms',
        'main_capital_treasury',
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
                'name'       => 'Karta ERP',
                'version'    => '1.0.0',
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

        // Verify checksum
        $expected = $this->computeChecksum($backup);
        if ($backup['system']['checksum'] !== $expected) {
            $errors[] = "Checksum mismatch: expected=$expected, got={$backup['system']['checksum']}";
        }

        // Verify all required tables exist in backup
        foreach (self::TABLE_ORDER as $table) {
            if (!array_key_exists($table, $backup['tables'])) {
                $errors[] = "Missing table: $table";
            } elseif (!is_array($backup['tables'][$table])) {
                $errors[] = "Invalid data for table: $table";
            }
        }

        return ['valid' => empty($errors), 'errors' => $errors];
    }

    /**
     * Full destructive restore from a validated backup.
     * MUST be called inside a transaction.
     */
    public function restore(array $backup, string $username): array {
        $stats = [];

        // Disable FK checks for safe truncation
        $this->db->exec('SET FOREIGN_KEY_CHECKS = 0');

        try {
            // Clear all tables in reverse order (children first)
            // NOTE: Do NOT use ALTER TABLE here — DDL causes implicit COMMIT
            // in MySQL, which kills the active transaction. Auto-increment
            // resets naturally when rows are inserted with explicit id values.
            foreach (array_reverse(self::TABLE_ORDER) as $table) {
                $this->db->exec("DELETE FROM `$table`");
            }

            // Insert data in correct order (parents first)
            foreach (self::TABLE_ORDER as $table) {
                $rows = $backup['tables'][$table] ?? [];
                $inserted = 0;

                if (!empty($rows)) {
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

    // ── CHECKSUM ──────────────────────────────────────────────────────────

    private function computeChecksum(array $backup): string {
        $parts = ['karta-v1'];
        foreach (self::TABLE_ORDER as $table) {
            $count = count($backup['tables'][$table] ?? []);
            $parts[] = "$table:$count";
        }
        return hash('sha256', implode('|', $parts));
    }
}
