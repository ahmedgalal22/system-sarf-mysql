<?php
/**
 * repositories/ReceiptRepository.php — Receipt data access layer
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  PRODUCTION LOCKED — Phase 4.8                              ║
 * ║  Do NOT modify without versioned migration + full regression ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * RULES:
 *   - NO financial calculations
 *   - NO formula logic
 *   - NO derived field computation
 *   - PDO + prepared statements ONLY
 *   - Raw data storage/retrieval ONLY
 *
 * CONCURRENCY MODEL (LOCKED):
 *   Receipt number allocation uses MySQL's atomic
 *     UPDATE ... SET next_number = LAST_INSERT_ID(next_number + 1)
 *   Single statement. InnoDB row lock. Connection-scoped state.
 *   Zero race conditions. Zero SELECT dependency.
 *
 * TIMESTAMP MODEL (LOCKED):
 *   All timestamps use MySQL NOW(3) — never PHP date functions.
 *   DATETIME(3) = millisecond precision for optimistic locking.
 *
 * IDEMPOTENCY CONTRACT (LOCKED):
 *   request_id = immutable operation identity.
 *   findByRequestId() returns record regardless of soft-delete or archive.
 *   DB UNIQUE(request_id) is the final enforcement layer.
 *
 * TRANSACTION MODEL (LOCKED):
 *   BEGIN → all writes → COMMIT.
 *   No external calls inside transaction.
 *   No schema operations inside transaction.
 *   ensureCounterExists() is the ONLY write outside transaction.
 */

class ReceiptRepository {

    // ── Result Codes (LOCKED) ─────────────────────────────────────────────
    const RESULT_OK        = 'OK';
    const RESULT_CREATED   = 'CREATED';
    const RESULT_DUPLICATE = 'DUPLICATE';
    const RESULT_NOT_FOUND = 'NOT_FOUND';
    const RESULT_CONFLICT  = 'CONFLICT';
    const RESULT_ARCHIVED  = 'ARCHIVED';
    const RESULT_FORBIDDEN     = 'FORBIDDEN';
    const RESULT_ROW_NOT_FOUND = 'ROW_NOT_FOUND';
    const RESULT_INVALID       = 'INVALID';

    // ── Row-Level Disbursement Status Helpers ─────────────────────────────

    /**
     * Validate a requested row disbursement status against the two supported values:
     *   - 'paid' / 'تم صرفه'       -> 'paid'
     *   - 'unpaid' / 'لم يتم صرفه' -> 'unpaid'
     * Returns null for any unsupported value.
     */
    public static function validateRowDisbursementStatus($status): ?string {
        if (!is_string($status)) {
            return null;
        }
        $clean = trim($status);
        $lower = mb_strtolower($clean, 'UTF-8');
        if ($lower === 'paid' || $clean === 'تم صرفه') {
            return 'paid';
        }
        if ($lower === 'unpaid' || $clean === 'لم يتم صرفه') {
            return 'unpaid';
        }
        return null;
    }

    /**
     * Normalize a row status value, defaulting to 'unpaid' ('لم يتم صرفه').
     */
    public static function normalizeRowDisbursementStatus($status): string {
        return self::validateRowDisbursementStatus($status) ?? 'unpaid';
    }

    /**
     * Read a receipt row's saved disbursement status.
     * Defaults to 'unpaid' ('لم يتم صرفه') when a row does not yet have a row-level status.
     * Never infers row status from receipt-level payout_status.
     */
    public static function getRowDisbursementStatus(array $row): string {
        $raw = $row['disbursement_status']
            ?? $row['row_status']
            ?? $row['payout_status']
            ?? $row['status']
            ?? ((isset($row['rowPayment']) && strtolower(trim((string)$row['rowPayment'])) !== 'pending')
                ? $row['rowPayment']
                : null);
        return self::normalizeRowDisbursementStatus($raw);
    }

    /**
     * Validate a requested receipt-level payment status against the two supported values:
     *   - 'paid' / 'تم دفعه'       -> 'paid'
     *   - 'unpaid' / 'لم يتم دفعه' -> 'unpaid'
     * Returns null for any unsupported value.
     */
    public static function validateReceiptPaymentStatus($status): ?string {
        if (!is_string($status)) {
            return null;
        }
        $clean = trim($status);
        $lower = mb_strtolower($clean, 'UTF-8');
        if ($lower === 'paid' || $clean === 'تم دفعه') {
            return 'paid';
        }
        if ($lower === 'unpaid' || $clean === 'لم يتم دفعه') {
            return 'unpaid';
        }
        return null;
    }

    /**
     * Normalize a receipt payment status value, defaulting to 'unpaid' ('لم يتم دفعه').
     */
    public static function normalizeReceiptPaymentStatus($status): string {
        return self::validateReceiptPaymentStatus($status) ?? 'unpaid';
    }

    /**
     * Read a receipt's saved payment status at the receipt level.
     *
     * Resolution rules (deterministic):
     *   1. If `$receipt['payment_status']` is explicitly present and valid ('paid' / 'تم دفعه'
     *      or 'unpaid' / 'لم يتم دفعه'), return its canonical value ('paid' | 'unpaid').
     *   2. Compatibility fallback for legacy row-level `payment_status`:
     *      If receipt-level `payment_status` is absent/null, inspect all non-separator data
     *      rows in `$receipt['rows']`. If at least one data row exists, EVERY data row has a
     *      valid legacy `payment_status`, and all data rows agree on the exact same value,
     *      return that unanimous value.
     *   3. If legacy row-level values conflict or are missing, return the safe fallback
     *      'unpaid' ('لم يتم دفعه'). Never infer payment status from `payout_status` or
     *      row-level disbursement fields (`disbursement_status`, `row_status`, `rowPayment`).
     */
    public static function getReceiptPaymentStatus(array $receipt): string {
        $rawReceiptStatus = $receipt['payment_status'] ?? null;
        if (is_string($rawReceiptStatus) && trim($rawReceiptStatus) !== '') {
            return self::validateReceiptPaymentStatus($rawReceiptStatus) ?? 'unpaid';
        }

        $rows = $receipt['rows'] ?? [];
        if (is_string($rows)) {
            $rows = json_decode($rows, true) ?? [];
        }
        if (is_array($rows)) {
            $dataRows = array_values(array_filter($rows, function ($r) {
                return is_array($r) && (($r['_type'] ?? '') !== 'separator');
            }));
            if (!empty($dataRows)) {
                $commonStatus = null;
                $allAgree = true;
                foreach ($dataRows as $row) {
                    $rowPay = self::validateReceiptPaymentStatus($row['payment_status'] ?? null);
                    if ($rowPay === null) {
                        $allAgree = false;
                        break;
                    }
                    if ($commonStatus === null) {
                        $commonStatus = $rowPay;
                    } elseif ($commonStatus !== $rowPay) {
                        $allAgree = false;
                        break;
                    }
                }
                if ($allAgree && $commonStatus !== null) {
                    return $commonStatus;
                }
            }
        }

        return 'unpaid';
    }

    /**
     * Resolve a stable identifier for a receipt row.
     */
    public static function getStableRowId(array $row, $receiptId = '', int $rowIndex = 0): string {
        foreach (['row_id', '_rowId', 'id'] as $key) {
            if (isset($row[$key]) && trim((string)$row[$key]) !== '') {
                return trim((string)$row[$key]);
            }
        }
        $recPart = ($receiptId !== null && trim((string)$receiptId) !== '')
            ? trim((string)$receiptId)
            : 'rec';
        return 'row-' . $recPart . '-' . $rowIndex;
    }

    /**
     * Normalize all rows of a receipt so each data row carries a stable row_id,
     * _rowId, and row-level disbursement_status ('paid' | 'unpaid').
     * Strips any legacy row-level `payment_status` fields so payment status is
     * maintained exclusively at the receipt level.
     */
    public static function normalizeReceiptRows($rows, $receiptId = ''): array {
        if (is_string($rows)) {
            $rows = json_decode($rows, true) ?? [];
        }
        if (!is_array($rows)) {
            return [];
        }
        $normalized = [];
        foreach (array_values($rows) as $idx => $row) {
            if (!is_array($row)) continue;
            if (($row['_type'] ?? '') === 'separator') {
                $normalized[] = $row;
                continue;
            }
            $stableId = self::getStableRowId($row, $receiptId, $idx);
            $status = self::getRowDisbursementStatus($row);
            unset($row['payment_status'], $row['payment_status_updated_at']);
            $row['row_id']              = $stableId;
            $row['_rowId']              = $stableId;
            $row['disbursement_status'] = $status;
            $row['payout_status']       = $status;
            $row['rowPayment']          = $status;
            $normalized[] = $row;
        }
        return $normalized;
    }

    /**
     * Normalize a receipt record in place:
     *   1. Resolves receipt-level `payment_status` ('paid' | 'unpaid'), including the
     *      unanimous legacy row-level fallback before stripping row-level payment fields.
     *   2. Decodes and normalizes `rows` with stable row IDs and row-level disbursement statuses.
     */
    public static function normalizeReceiptRecord(?array &$receipt): void {
        if (!$receipt) return;
        $receipt['payment_status'] = self::getReceiptPaymentStatus($receipt);
        $receipt['rows'] = self::normalizeReceiptRows($receipt['rows'] ?? [], $receipt['id'] ?? '');
    }

    private PDO $db;
    private static ?bool $hasPaymentStatusColumn = null;

    public function __construct(PDO $db) {
        $this->db = $db;
        $this->ensurePaymentStatusColumn();
    }

    /**
     * Check whether the `receipts` table has a `payment_status` column, adding it
     * non-destructively (`VARCHAR(20) DEFAULT NULL`) when not inside an active transaction.
     */
    private function ensurePaymentStatusColumn(): bool {
        if (self::$hasPaymentStatusColumn === true) {
            return true;
        }
        try {
            $stmt = $this->db->query("SHOW COLUMNS FROM receipts LIKE 'payment_status'");
            if ($stmt && $stmt->fetch()) {
                self::$hasPaymentStatusColumn = true;
                return true;
            }
            if (!$this->db->inTransaction()) {
                $this->db->exec(
                    'ALTER TABLE receipts ADD COLUMN payment_status VARCHAR(20) DEFAULT NULL AFTER payout_status'
                );
                self::$hasPaymentStatusColumn = true;
                return true;
            }
            return false;
        } catch (Throwable $e) {
            // Safe fallback if column cannot be added in this context
            self::$hasPaymentStatusColumn = false;
            return false;
        }
    }

    // ── READ ──────────────────────────────────────────────────────────────

    public function findById(int $id): ?array {
        $stmt = $this->db->prepare(
            'SELECT * FROM receipts WHERE id = :id AND deleted_at IS NULL LIMIT 1'
        );
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch();
        if (!$row) return null;
        self::normalizeReceiptRecord($row);
        return $row;
    }

    public function findByUuid(string $uuid): ?array {
        $stmt = $this->db->prepare(
            'SELECT * FROM receipts WHERE uuid = :uuid AND deleted_at IS NULL LIMIT 1'
        );
        $stmt->execute([':uuid' => $uuid]);
        $row = $stmt->fetch();
        if (!$row) return null;
        self::normalizeReceiptRecord($row);
        return $row;
    }

    /**
     * Find by request_id — idempotency lookup.
     *
     * CONTRACT: No deleted_at filter. No is_archived filter.
     * A processed request_id is an immutable fact.
     */
    public function findByRequestId(string $requestId): ?array {
        $stmt = $this->db->prepare(
            'SELECT * FROM receipts WHERE request_id = :rid LIMIT 1'
        );
        $stmt->execute([':rid' => $requestId]);
        $row = $stmt->fetch();
        if (!$row) return null;
        self::normalizeReceiptRecord($row);
        return $row;
    }

    public function findAll(string $username, array $filters = []): array {
        $sql = 'SELECT * FROM receipts WHERE username = :username AND deleted_at IS NULL AND is_archived = 0';
        $params = [':username' => $username];

        if (!empty($filters['client_id'])) {
            $sql .= ' AND client_id = :client_id';
            $params[':client_id'] = $filters['client_id'];
        }
        if (!empty($filters['payout_status'])) {
            $sql .= ' AND payout_status = :payout_status';
            $params[':payout_status'] = $filters['payout_status'];
        }
        if (!empty($filters['from_date'])) {
            $sql .= ' AND receipt_date >= :from_date';
            $params[':from_date'] = $filters['from_date'];
        }
        if (!empty($filters['to_date'])) {
            $sql .= ' AND receipt_date <= :to_date';
            $params[':to_date'] = $filters['to_date'];
        }
        if (!empty($filters['receipt_number'])) {
            $sql .= ' AND receipt_number = :receipt_number';
            $params[':receipt_number'] = $filters['receipt_number'];
        }

        $sql .= ' ORDER BY created_at DESC, id DESC';

        $stmt = $this->db->prepare($sql);
        $stmt->execute($params);
        return $stmt->fetchAll();
    }

    // ── SEARCH (Phase 2 — All Receipts page) ───────────────────────────────
    //
    // New method for the All Receipts search endpoint (search.php).
    // Does NOT modify findAll() — this is a separate method with different
    // contract: multi-value filters, server-side summary, optional options.
    //
    // TWO EXECUTION PATHS:
    //
    //   Path A — SQL-only filters (no vehicle/karta/type):
    //     Q1: COUNT + SUM aggregate (full filtered set, no row data)
    //     Q2: SELECT `rows` only (full filtered set, for JSON-derived summary)
    //     Q3: SELECT * with ORDER BY + LIMIT/OFFSET (paged data)
    //     PHP never loads the full dataset as SELECT *.
    //
    //   Path B — JSON filters active (vehicle, karta, type):
    //     Q1: SELECT * full candidate set (needed for PHP post-filter)
    //     PHP post-filters, computes summary, then applies LIMIT/OFFSET.
    //
    // Summary is ALWAYS computed from the FULL filtered set BEFORE
    // any LIMIT/OFFSET. The summary never represents only the current page.
    // ──────────────────────────────────────────────────────────────────────

    /**
     * Search receipts with multi-value filters, summary, and options.
     *
     * @param string $username
     * @param array  $params {
     *   from_date, to_date, limit, offset,
     *   client_name (string[]), receipt_number (string[]),
     *   vehicle (string[]), karta (string[]), type (string[]),
     *   payout_status (string), sort (string), sort_dir (string),
     *   include_options (bool)
     * }
     * @return array { records: array, total: int, summary: array, options?: array }
     */
    public function search(string $username, array $params): array {

        // ── 1. Build shared WHERE clause from column-level filters ────────

        $whereBase = 'username = :username AND deleted_at IS NULL AND is_archived = 0';
        $bindParams = [':username' => $username];

        // Date range
        $fromDate = $params['from_date'] ?? null;
        $toDate   = $params['to_date'] ?? null;
        if ($fromDate) {
            $whereBase .= ' AND receipt_date >= :from_date';
            $bindParams[':from_date'] = $fromDate;
        }
        if ($toDate) {
            $whereBase .= ' AND receipt_date <= :to_date';
            $bindParams[':to_date'] = $toDate;
        }

        // Multi-value column filters: client_name IN (...)
        $clientNames = $params['client_name'] ?? [];
        if (!empty($clientNames)) {
            $placeholders = [];
            foreach ($clientNames as $i => $name) {
                $key = ':cn_' . $i;
                $placeholders[] = $key;
                $bindParams[$key] = $name;
            }
            $whereBase .= ' AND client_name IN (' . implode(',', $placeholders) . ')';
        }

        // Multi-value: receipt_number IN (...)
        $receiptNumbers = $params['receipt_number'] ?? [];
        if (!empty($receiptNumbers)) {
            $placeholders = [];
            foreach ($receiptNumbers as $i => $num) {
                $key = ':rn_' . $i;
                $placeholders[] = $key;
                $bindParams[$key] = $num;
            }
            $whereBase .= ' AND receipt_number IN (' . implode(',', $placeholders) . ')';
        }

        // Single-value row status filter ('paid' or 'unpaid') operates on individual rows,
        // NOT on the receipt-level payout_status column.
        $rawRowStatus = $params['row_status'] ?? ($params['payout_status'] ?? '');
        $rowStatusFilter = self::validateRowDisbursementStatus($rawRowStatus);

        // Single-value receipt payment status filter ('paid' or 'unpaid') operates on the
        // entire receipt, combined with $rowStatusFilter (which filters rows inside matching receipts).
        $rawReceiptPaymentStatus = $params['payment_status'] ?? '';
        $receiptPaymentStatusFilter = self::validateReceiptPaymentStatus($rawReceiptPaymentStatus);

        // ── Sort ──────────────────────────────────────────────────────────

        $sortField = $params['sort'] ?? 'created_at';
        $sortDir   = strtoupper($params['sort_dir'] ?? 'DESC');
        if (!in_array($sortDir, ['ASC', 'DESC'], true)) $sortDir = 'DESC';

        $sortAllowed = [
            'created_at'     => "created_at $sortDir, id $sortDir",
            'receipt_date'   => "receipt_date $sortDir, id $sortDir",
            'paid_at'        => "CASE WHEN payout_status='paid' THEN 0 ELSE 1 END ASC, paid_at $sortDir, id $sortDir",
            'receipt_number' => "CAST(receipt_number AS UNSIGNED) $sortDir, id $sortDir",
        ];
        $orderBy = $sortAllowed[$sortField] ?? $sortAllowed['created_at'];

        // ── Limit / Offset ────────────────────────────────────────────────

        $limit  = (int)($params['limit'] ?? 50);
        $offset = (int)($params['offset'] ?? 0);
        if ($limit < 0) $limit = 50;
        if ($limit > 10000) $limit = 10000;
        if ($offset < 0) $offset = 0;

        // ── Detect execution path ─────────────────────────────────────────

        $vehicleFilter = $params['vehicle'] ?? [];
        $kartaFilter   = $params['karta'] ?? [];
        $typeFilter    = $params['type'] ?? [];
        $hasJsonFilter = !empty($vehicleFilter) || !empty($kartaFilter) || !empty($typeFilter)
                         || ($rowStatusFilter !== null) || ($receiptPaymentStatusFilter !== null);

        if ($hasJsonFilter) {
            $result = $this->_searchPathB($whereBase, $bindParams, $orderBy, $limit, $offset,
                                          $vehicleFilter, $kartaFilter, $typeFilter,
                                          $rowStatusFilter, $receiptPaymentStatusFilter);
        } else {
            $result = $this->_searchPathA($whereBase, $bindParams, $orderBy, $limit, $offset);
        }

        // ── Options (distinct values for multi-select popups) ─────────────

        if (!empty($params['include_options'])) {
            $result['options'] = $this->_buildSearchOptions($username, $fromDate, $toDate);
        }

        return $result;
    }

    // ── Path A: SQL-only filters (no JSON post-filter needed) ─────────────
    //
    // Three targeted queries — PHP never loads the full dataset as SELECT *:
    //
    //   Q1: COUNT(*) + SUM(net_due, net_total, paid)
    //       → total count + SQL-level summary (no row data transferred)
    //
    //   Q2: SELECT `rows` (only the JSON column, full filtered set)
    //       → PHP iterates to compute row_count, weight, noloon, ohda
    //       → Minimal data transfer: only the rows column, no other columns
    //
    //   Q3: SELECT * ... ORDER BY ... LIMIT ? OFFSET ?
    //       → Paged result — MySQL does sort + LIMIT, PHP gets only N records
    //
    // ──────────────────────────────────────────────────────────────────────

    private function _searchPathA(string $whereBase, array $bindParams,
                                   string $orderBy, int $limit, int $offset): array {

        // Q1: Aggregate query — count + sums over full filtered set
        $aggSql = "SELECT COUNT(*) as cnt,
                          COALESCE(SUM(net_due),0) as sum_net_due,
                          COALESCE(SUM(net_total),0) as sum_net_total,
                          COALESCE(SUM(paid),0) as sum_paid
                   FROM receipts WHERE $whereBase";
        $stmt = $this->db->prepare($aggSql);
        $stmt->execute($bindParams);
        $agg = $stmt->fetch();

        $total      = (int)$agg['cnt'];
        $sumNetDue  = (int)$agg['sum_net_due'];
        $sumNetTotal= (int)$agg['sum_net_total'];
        $sumPaid    = (int)$agg['sum_paid'];

        // Q2: JSON-derived summary — fetch only `rows` column, delegate to shared helper
        $rowsSql = "SELECT `rows` FROM receipts WHERE $whereBase";
        $stmt = $this->db->prepare($rowsSql);
        $stmt->execute($bindParams);
        $jsonSums = $this->_computeJsonSummary($stmt);

        $summary = [
            'net_due'   => $sumNetDue,
            'net_total' => $sumNetTotal,
            'paid'      => $sumPaid,
            'row_count' => $jsonSums['row_count'],
            'weight'    => $jsonSums['weight'],
            'noloon'    => $jsonSums['noloon'],
            'ohda'      => $jsonSums['ohda'],
        ];

        // Q3: Paged data query — MySQL performs ORDER BY + LIMIT/OFFSET
        $dataSql = "SELECT * FROM receipts WHERE $whereBase ORDER BY $orderBy";
        if ($limit > 0) {
            $dataSql .= " LIMIT $limit OFFSET $offset";
        }
        $stmt = $this->db->prepare($dataSql);
        $stmt->execute($bindParams);
        $records = $stmt->fetchAll();

        // Decode and normalize receipt records (receipt-level payment_status + row IDs/statuses)
        foreach ($records as &$r) {
            self::normalizeReceiptRecord($r);
        }
        unset($r);

        return [
            'records' => $records,
            'total'   => $total,
            'summary' => $summary,
        ];
    }

    // ── Path B: JSON filters active — must load candidate set into PHP ────
    //
    // When vehicle, karta, type, row_status, or payment_status filters are active,
    // we load the full SQL-filtered candidate set, then post-filter in PHP.
    // Summary is computed from the post-filtered result. LIMIT/OFFSET applied last.
    // ──────────────────────────────────────────────────────────────────────

    private function _searchPathB(string $whereBase, array $bindParams,
                                   string $orderBy, int $limit, int $offset,
                                   array $vehicleFilter, array $kartaFilter,
                                   array $typeFilter, ?string $rowStatusFilter = null,
                                   ?string $receiptPaymentStatusFilter = null): array {

        // Fetch full candidate set — needed for PHP post-filter
        $sql = "SELECT * FROM receipts WHERE $whereBase ORDER BY $orderBy";
        $stmt = $this->db->prepare($sql);
        $stmt->execute($bindParams);
        $allRecords = $stmt->fetchAll();

        // Decode and normalize receipt records (resolves receipt-level payment_status first,
        // then normalizes rows with row_id and disbursement_status)
        foreach ($allRecords as &$r) {
            self::normalizeReceiptRecord($r);
        }
        unset($r);

        // PHP post-filter: receipt-level payment_status + row-level vehicle, karta, type, disbursement status
        $vehicleLower = array_map('mb_strtolower', $vehicleFilter);
        $kartaLower   = array_map('mb_strtolower', $kartaFilter);
        $typeLower    = array_map('mb_strtolower', $typeFilter);

        $allRecords = array_values(array_filter($allRecords, function ($record) use ($vehicleLower, $kartaLower, $typeLower, $rowStatusFilter, $receiptPaymentStatusFilter) {
            if ($receiptPaymentStatusFilter !== null) {
                if (self::getReceiptPaymentStatus($record) !== $receiptPaymentStatusFilter) {
                    return false;
                }
            }

            $rows = is_array($record['rows']) ? $record['rows'] : [];

            if (!empty($vehicleLower)) {
                $found = false;
                foreach ($rows as $row) {
                    $car = mb_strtolower($row['car'] ?? $row['carNo'] ?? $row['vehicle_plate'] ?? '');
                    if ($car !== '' && in_array($car, $vehicleLower, true)) { $found = true; break; }
                }
                if (!$found) return false;
            }

            if (!empty($kartaLower)) {
                $found = false;
                foreach ($rows as $row) {
                    $karta = mb_strtolower($row['kartano'] ?? $row['kartaNo'] ?? $row['karta'] ?? '');
                    if ($karta !== '' && in_array($karta, $kartaLower, true)) { $found = true; break; }
                }
                if (!$found) return false;
            }

            if (!empty($typeLower)) {
                $found = false;
                foreach ($rows as $row) {
                    $type = mb_strtolower($row['type'] ?? '');
                    if ($type !== '' && in_array($type, $typeLower, true)) { $found = true; break; }
                }
                if (!$found) return false;
            }

            if ($rowStatusFilter !== null) {
                $found = false;
                foreach ($rows as $row) {
                    if (($row['_type'] ?? '') === 'separator') continue;
                    if (self::getRowDisbursementStatus($row) === $rowStatusFilter) {
                        $found = true;
                        break;
                    }
                }
                if (!$found) return false;
            }

            return true;
        }));

        // Summary from FULL post-filtered set (before LIMIT/OFFSET)
        $total = count($allRecords);
        $sumNetDue = 0; $sumNetTotal = 0; $sumPaid = 0;
        foreach ($allRecords as $rec) {
            $sumNetDue   += (int)($rec['net_due'] ?? 0);
            $sumNetTotal += (int)($rec['net_total'] ?? 0);
            $sumPaid     += (int)($rec['paid'] ?? 0);
        }

        $jsonSums = $this->_computeJsonSummary($allRecords, $rowStatusFilter);

        $summary = [
            'net_due'   => $sumNetDue,
            'net_total' => $sumNetTotal,
            'paid'      => $sumPaid,
            'row_count' => $jsonSums['row_count'],
            'weight'    => $jsonSums['weight'],
            'noloon'    => $jsonSums['noloon'],
            'ohda'      => $jsonSums['ohda'],
        ];

        // LIMIT/OFFSET in PHP (after post-filter)
        if ($limit > 0) {
            $pagedRecords = array_slice($allRecords, $offset, $limit);
        } else {
            $pagedRecords = $allRecords;
        }

        return [
            'records' => $pagedRecords,
            'total'   => $total,
            'summary' => $summary,
        ];
    }

    /**
     * Compute JSON-derived summary fields from receipt rows.
     *
     * Iterates the `rows` JSON of each record to compute row_count, weight,
     * noloon, and ohda. This is the single source of truth for these 4
     * fields — called by both _searchPathA and _searchPathB.
     *
     * @param iterable $records — each element must have a 'rows' key (array or JSON string)
     * @param ?string  $rowStatusFilter — optional row-level disbursement status filter ('paid'|'unpaid')
     * @return array { row_count: int, weight: float, noloon: float, ohda: float }
     */
    private function _computeJsonSummary(
        iterable $records,
        ?string $rowStatusFilter = null
    ): array {
        $rowCount = 0;
        $totalWeight = 0.0;
        $totalNoloon = 0.0;
        $totalOhda   = 0.0;

        foreach ($records as $rec) {
            $rows = $rec['rows'] ?? [];
            if (is_string($rows)) {
                $rows = json_decode($rows, true) ?? [];
            }
            if (!is_array($rows)) continue;
            foreach ($rows as $row) {
                if (isset($row['_type']) && $row['_type'] === 'separator') continue;
                if ($rowStatusFilter !== null && self::getRowDisbursementStatus($row) !== $rowStatusFilter) continue;
                $rowCount++;
                $totalWeight += (float)($row['weight'] ?? 0) - (float)($row['deficit'] ?? 0);
                $totalNoloon += (float)($row['noloon'] ?? 0);
                $totalOhda   += (float)($row['ohda'] ?? 0);
            }
        }

        return [
            'row_count' => $rowCount,
            'weight'    => $totalWeight,
            'noloon'    => $totalNoloon,
            'ohda'      => $totalOhda,
        ];
    }

    private function _buildSearchOptions(string $username, ?string $fromDate, ?string $toDate): array {
        $baseWhere = 'username = :username AND deleted_at IS NULL AND is_archived = 0';
        $baseParams = [':username' => $username];
        if ($fromDate) {
            $baseWhere .= ' AND receipt_date >= :from_date';
            $baseParams[':from_date'] = $fromDate;
        }
        if ($toDate) {
            $baseWhere .= ' AND receipt_date <= :to_date';
            $baseParams[':to_date'] = $toDate;
        }

        // Column-level DISTINCT queries
        $clientNames = [];
        $stmt = $this->db->prepare("SELECT DISTINCT client_name FROM receipts WHERE $baseWhere AND client_name IS NOT NULL AND client_name != '' ORDER BY client_name");
        $stmt->execute($baseParams);
        $clientNames = $stmt->fetchAll(PDO::FETCH_COLUMN);

        $receiptNumbers = [];
        $stmt = $this->db->prepare("SELECT DISTINCT receipt_number FROM receipts WHERE $baseWhere ORDER BY CAST(receipt_number AS UNSIGNED)");
        $stmt->execute($baseParams);
        $receiptNumbers = $stmt->fetchAll(PDO::FETCH_COLUMN);

        // JSON-level: iterate all receipts in date range for row-level values
        $stmt = $this->db->prepare("SELECT `rows` FROM receipts WHERE $baseWhere");
        $stmt->execute($baseParams);

        $vehicleSet = [];
        $kartaSet   = [];
        $typeSet    = [];
        // Collect office names from rows (for row-level company filter)
        $officeSet  = [];

        while ($row = $stmt->fetch()) {
            $rows = is_string($row['rows']) ? json_decode($row['rows'], true) : ($row['rows'] ?? []);
            if (!is_array($rows)) continue;
            foreach ($rows as $r) {
                if (isset($r['_type']) && $r['_type'] === 'separator') continue;
                // Vehicle
                $car = trim($r['car'] ?? $r['carNo'] ?? $r['vehicle_plate'] ?? '');
                if ($car !== '') $vehicleSet[$car] = true;
                // Karta
                $karta = trim($r['kartano'] ?? $r['kartaNo'] ?? $r['karta'] ?? '');
                if ($karta !== '') $kartaSet[$karta] = true;
                // Type
                $type = trim($r['type'] ?? '');
                if ($type !== '') $typeSet[$type] = true;
                // Office (row-level company)
                $office = trim($r['office'] ?? '');
                if ($office !== '') $officeSet[$office] = true;
            }
        }

        $allCompanies = array_keys($officeSet);
        sort($allCompanies);

        $vehicles = array_keys($vehicleSet);
        sort($vehicles);
        $kartas = array_keys($kartaSet);
        sort($kartas);
        $types = array_keys($typeSet);
        sort($types);

        return [
            'client_names'    => $clientNames,
            'company_names'   => $allCompanies,
            'receipt_numbers' => $receiptNumbers,
            'vehicles'        => $vehicles,
            'kartas'          => $kartas,
            'types'           => $types,
        ];
    }

    // ── RECEIPT NUMBER ALLOCATION (LOCKED) ────────────────────────────────
    //
    // Pattern: UPDATE ... SET next_number = LAST_INSERT_ID(next_number + 1)
    //
    // Semantics:
    //   next_number = last allocated number (starts at 0).
    //   LAST_INSERT_ID(next_number + 1) atomically:
    //     1. Computes next_number + 1
    //     2. Stores that value in the connection's LAST_INSERT_ID register
    //     3. Sets next_number = that value
    //   SELECT LAST_INSERT_ID() returns the allocated number.
    //
    // Concurrency:
    //   InnoDB exclusive row lock on UPDATE serializes all callers.
    //   LAST_INSERT_ID is connection-scoped — no cross-contamination.
    //
    // Transaction safety:
    //   Called INSIDE transaction. ROLLBACK undoes the counter increment.
    //   No orphan counter updates possible.
    // ──────────────────────────────────────────────────────────────────────

    /**
     * Ensure the counter row exists for a user, synced to actual data.
     * MUST be called OUTSIDE the main transaction (prevents gap-lock deadlock).
     *
     * For NEW users: inserts counter with next_number = 0.
     * For EXISTING users: verifies counter >= max(receipt_number) in DB.
     *   This self-heals any counter drift from old schema versions.
     *
     * INSERT IGNORE + conditional UPDATE. Both auto-commit. Safe for concurrency.
     */
    public function ensureCounterExists(string $username): void {
        // 1. Insert row if not exists (next_number = 0 for new users)
        $this->db->prepare(
            'INSERT IGNORE INTO receipt_counters (username, next_number) VALUES (:u, 0)'
        )->execute([':u' => $username]);

        // 2. Self-heal: ensure counter >= max receipt_number actually used.
        //    This fixes counter drift from old schema or manual edits.
        //    Only updates if counter is BEHIND the actual data — never decreases.
        $this->db->prepare(
            'UPDATE receipt_counters rc
               SET rc.next_number = (
                 SELECT COALESCE(MAX(CAST(r.receipt_number AS UNSIGNED)), 0)
                 FROM receipts r
                 WHERE r.username = rc.username
               )
             WHERE rc.username = :u
               AND rc.next_number < (
                 SELECT COALESCE(MAX(CAST(r2.receipt_number AS UNSIGNED)), 0)
                 FROM receipts r2
                 WHERE r2.username = rc.username
               )'
        )->execute([':u' => $username]);
    }

    /**
     * Allocate the next receipt number atomically.
     * MUST be called INSIDE a BEGIN TRANSACTION block.
     *
     * @return string The allocated receipt number.
     * @throws RuntimeException if counter row is missing.
     */
    public function allocateReceiptNumber(string $username): string {
        // Single atomic statement — 1 statement, 1 lock, 0 race conditions
        $stmt = $this->db->prepare(
            'UPDATE receipt_counters
               SET next_number = LAST_INSERT_ID(next_number + 1)
             WHERE username = :u'
        );
        $stmt->execute([':u' => $username]);

        if ($stmt->rowCount() === 0) {
            throw new RuntimeException('receipt_counters row missing for user: ' . $username);
        }

        // LAST_INSERT_ID() is connection-scoped — returns the value we just stored
        $allocated = (int) $this->db->query('SELECT LAST_INSERT_ID()')->fetchColumn();

        return (string) $allocated;
    }

    // ── CREATE ────────────────────────────────────────────────────────────

    /**
     * Insert a new receipt. All timestamps via MySQL NOW(3).
     */
    public function insertReceipt(array $data): array {
        $paymentStatus = isset($data['payment_status'])
            ? self::validateReceiptPaymentStatus($data['payment_status'])
            : null;
        if ($paymentStatus === null) {
            $paymentStatus = self::getReceiptPaymentStatus($data);
        }
        $cleanRows = self::normalizeReceiptRows($data['rows'] ?? [], '');
        $hasPayCol = $this->ensurePaymentStatusColumn();

        if ($hasPayCol) {
            $stmt = $this->db->prepare(
                'INSERT INTO receipts (
                    uuid, username, receipt_number, receipt_date,
                    client_id, client_type, client_name,
                    payout_status, payment_status, paid_at, account_type,
                    total, net_due, net_total, paid, previous_balance, general_add,
                    `rows`, notes, shipping_number, request_id,
                    is_archived, archive_batch_id, archived_at,
                    created_by, created_at, updated_at
                ) VALUES (
                    :uuid, :username, :receipt_number, :receipt_date,
                    :client_id, :client_type, :client_name,
                    :payout_status, :payment_status, :paid_at, :account_type,
                    :total, :net_due, :net_total, :paid, :previous_balance, :general_add,
                    :rows, :notes, :shipping_number, :request_id,
                    :is_archived, :archive_batch_id, :archived_at,
                    :created_by, NOW(3), NOW(3)
                )'
            );
        } else {
            $stmt = $this->db->prepare(
                'INSERT INTO receipts (
                    uuid, username, receipt_number, receipt_date,
                    client_id, client_type, client_name,
                    payout_status, paid_at, account_type,
                    total, net_due, net_total, paid, previous_balance, general_add,
                    `rows`, notes, shipping_number, request_id,
                    is_archived, archive_batch_id, archived_at,
                    created_by, created_at, updated_at
                ) VALUES (
                    :uuid, :username, :receipt_number, :receipt_date,
                    :client_id, :client_type, :client_name,
                    :payout_status, :paid_at, :account_type,
                    :total, :net_due, :net_total, :paid, :previous_balance, :general_add,
                    :rows, :notes, :shipping_number, :request_id,
                    :is_archived, :archive_batch_id, :archived_at,
                    :created_by, NOW(3), NOW(3)
                )'
            );
        }

        $bind = [
            ':uuid'             => $data['uuid'],
            ':username'         => $data['username'],
            ':receipt_number'   => $data['receipt_number'],
            ':receipt_date'     => $data['receipt_date'] ?? null,
            ':client_id'        => $data['client_id'] ?? null,
            ':client_type'      => $data['client_type'] ?? null,
            ':client_name'      => $data['client_name'] ?? null,
            ':payout_status'    => $data['payout_status'] ?? 'unpaid',
            ':paid_at'          => $data['paid_at'] ?? null,
            ':account_type'     => $data['account_type'] ?? null,
            ':total'            => $data['total'] ?? 0,
            ':net_due'          => $data['net_due'] ?? 0,
            ':net_total'        => $data['net_total'] ?? 0,
            ':paid'             => $data['paid'] ?? 0,
            ':previous_balance' => $data['previous_balance'] ?? 0,
            ':general_add'      => $data['general_add'] ?? 0,
            ':rows'             => json_encode($cleanRows, JSON_UNESCAPED_UNICODE),
            ':notes'            => $data['notes'] ?? null,
            ':shipping_number'  => $data['shipping_number'] ?? null,
            ':request_id'       => $data['request_id'] ?? null,
            ':is_archived'      => $data['is_archived'] ?? 0,
            ':archive_batch_id' => $data['archive_batch_id'] ?? null,
            ':archived_at'      => $data['archived_at'] ?? null,
            ':created_by'       => $data['created_by'] ?? null,
        ];
        if ($hasPayCol) {
            $bind[':payment_status'] = $paymentStatus;
        }

        $stmt->execute($bind);

        $id = (int) $this->db->lastInsertId();
        return $this->findById($id);
    }

    // ── UPDATE ────────────────────────────────────────────────────────────

    /**
     * Update a receipt with row locking + optimistic locking.
     *
     * Check order: NOT_FOUND → ARCHIVED → CONFLICT → apply patch.
     * Timestamp: explicit NOW(3) for millisecond-precision versioning.
     *
     * @return array ['code' => string, 'data' => ?array]
     */
    public function updateReceipt(int $id, array $patch, string $username, ?string $expectedUpdatedAt = null): array {
        // Exclusive row lock
        $lockStmt = $this->db->prepare(
            'SELECT id, updated_at, is_archived FROM receipts WHERE id = :id AND deleted_at IS NULL FOR UPDATE'
        );
        $lockStmt->execute([':id' => $id]);
        $current = $lockStmt->fetch();

        if (!$current) {
            return ['code' => self::RESULT_NOT_FOUND, 'data' => null];
        }

        if ($current['is_archived']) {
            return ['code' => self::RESULT_ARCHIVED, 'data' => null];
        }

        if ($expectedUpdatedAt !== null && $current['updated_at'] !== $expectedUpdatedAt) {
            $latest = $this->findById($id);
            return ['code' => self::RESULT_CONFLICT, 'data' => $latest];
        }

        // Build patch
        $allowed = [
            'receipt_date', 'client_id', 'client_type', 'client_name',
            'payout_status', 'paid_at', 'account_type',
            'total', 'net_due', 'net_total', 'paid', 'previous_balance', 'general_add',
            'rows', 'notes', 'shipping_number',
        ];
        if ($this->ensurePaymentStatusColumn()) {
            $allowed[] = 'payment_status';
        }

        $fields = [];
        $params = [':id' => $id, ':updated_by' => $username];

        foreach ($allowed as $field) {
            if (array_key_exists($field, $patch)) {
                $value = $patch[$field];
                if ($field === 'payment_status') {
                    $validatedPay = self::validateReceiptPaymentStatus($value);
                    if ($validatedPay === null) continue;
                    $value = $validatedPay;
                }
                if ($field === 'rows') {
                    $normalizedRows = self::normalizeReceiptRows($value, $id);
                    $value = json_encode($normalizedRows, JSON_UNESCAPED_UNICODE);
                }
                $fields[] = "`{$field}` = :{$field}";
                $params[":{$field}"] = $value;
            }
        }

        if (empty($fields)) {
            return ['code' => self::RESULT_OK, 'data' => $this->findById($id)];
        }

        $fields[] = 'updated_by = :updated_by';
        $fields[] = 'updated_at = NOW(3)';

        $sql = 'UPDATE receipts SET ' . implode(', ', $fields) . ' WHERE id = :id';
        $this->db->prepare($sql)->execute($params);

        return ['code' => self::RESULT_OK, 'data' => $this->findById($id)];
    }

    /**
     * Atomically update the disbursement status of a single row inside a receipt.
     *
     * Concurrency & Data Integrity:
     *   - Acquires an exclusive row lock (`SELECT ... FOR UPDATE`) on the receipt row
     *     so concurrent updates to different rows of the same receipt are serialized
     *     and never overwrite each other.
     *   - Verifies receipt ownership (`username`) and non-archived status.
     *   - Validates `$status` strictly against the two supported values ('paid' / 'unpaid').
     *   - Verifies that `$rowId` exists as a non-separator row within `$receiptId`
     *     (preventing another receipt's row identifier from modifying this receipt).
     *   - Modifies ONLY the target row's status fields inside `rows` JSON; does not
     *     alter receipt-level `payment_status`, weights, net amounts, receipt financial totals,
     *     office balances, or any ledger/treasury entries.
     *
     * @return array ['code' => string, 'data' => ?array, 'row' => ?array]
     */
    public function updateRowDisbursementStatus(
        int $receiptId,
        string $rowId,
        string $status,
        string $username
    ): array {
        $canonicalStatus = self::validateRowDisbursementStatus($status);
        if ($canonicalStatus === null) {
            return ['code' => self::RESULT_INVALID, 'data' => null, 'row' => null];
        }

        $cleanRowId = trim($rowId);
        if ($cleanRowId === '') {
            return ['code' => self::RESULT_INVALID, 'data' => null, 'row' => null];
        }

        $lockStmt = $this->db->prepare(
            'SELECT * FROM receipts WHERE id = :id AND deleted_at IS NULL FOR UPDATE'
        );
        $lockStmt->execute([':id' => $receiptId]);
        $current = $lockStmt->fetch();

        if (!$current) {
            return ['code' => self::RESULT_NOT_FOUND, 'data' => null, 'row' => null];
        }

        if (($current['username'] ?? '') !== $username) {
            return ['code' => self::RESULT_FORBIDDEN, 'data' => null, 'row' => null];
        }

        if (!empty($current['is_archived'])) {
            return ['code' => self::RESULT_ARCHIVED, 'data' => null, 'row' => null];
        }

        // Preserve resolved receipt-level payment_status (including unanimous legacy row fallback)
        $preservedPaymentStatus = self::getReceiptPaymentStatus($current);
        $rows = self::normalizeReceiptRows($current['rows'] ?? [], $receiptId);
        $found = false;
        $updatedRow = null;
        $now = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d H:i:s.v');

        foreach ($rows as $idx => &$row) {
            if (!is_array($row) || ($row['_type'] ?? '') === 'separator') {
                continue;
            }
            $stableId = self::getStableRowId($row, $receiptId, $idx);
            if ($stableId === $cleanRowId) {
                $row['row_id']              = $stableId;
                $row['_rowId']              = $stableId;
                $row['disbursement_status'] = $canonicalStatus;
                $row['payout_status']       = $canonicalStatus;
                $row['rowPayment']          = $canonicalStatus;
                $row['status_updated_at']   = $now;
                $found = true;
                $updatedRow = $row;
                break;
            }
        }
        unset($row);

        if (!$found) {
            return ['code' => self::RESULT_ROW_NOT_FOUND, 'data' => null, 'row' => null];
        }

        if ($this->ensurePaymentStatusColumn()) {
            $updStmt = $this->db->prepare(
                'UPDATE receipts SET `rows` = :rows, payment_status = :payment_status, updated_by = :updated_by, updated_at = NOW(3) WHERE id = :id'
            );
            $updStmt->execute([
                ':rows'           => json_encode($rows, JSON_UNESCAPED_UNICODE),
                ':payment_status' => $preservedPaymentStatus,
                ':updated_by'     => $username,
                ':id'             => $receiptId,
            ]);
        } else {
            $updStmt = $this->db->prepare(
                'UPDATE receipts SET `rows` = :rows, updated_by = :updated_by, updated_at = NOW(3) WHERE id = :id'
            );
            $updStmt->execute([
                ':rows'       => json_encode($rows, JSON_UNESCAPED_UNICODE),
                ':updated_by' => $username,
                ':id'         => $receiptId,
            ]);
        }

        $updatedReceipt = $this->findById($receiptId);

        return [
            'code' => self::RESULT_OK,
            'data' => $updatedReceipt,
            'row'  => $updatedRow,
        ];
    }

    /**
     * Atomically update the receipt-level payment status ('paid' / 'تم دفعه'
     * or 'unpaid' / 'لم يتم دفعه') for an entire receipt.
     *
     * Concurrency & Data Integrity:
     *   - Acquires an exclusive row lock (`SELECT ... FOR UPDATE`) on the receipt row.
     *   - Verifies receipt ownership (`username`) and non-archived status.
     *   - Validates `$paymentStatus` strictly against the two supported values ('paid' / 'unpaid').
     *   - Stores one `payment_status` for the entire receipt and strips any legacy
     *     row-level `payment_status` fields from `rows` JSON while preserving each
     *     row's `row_id` and `disbursement_status`.
     *   - Does not alter row weights, net amounts, receipt financial totals,
     *     office balances, or any ledger/treasury entries.
     *
     * @return array ['code' => string, 'data' => ?array, 'payment_status' => ?string]
     */
    public function updateReceiptPaymentStatus(
        int $receiptId,
        string $paymentStatus,
        string $username
    ): array {
        $canonicalPaymentStatus = self::validateReceiptPaymentStatus($paymentStatus);
        if ($canonicalPaymentStatus === null) {
            return ['code' => self::RESULT_INVALID, 'data' => null, 'payment_status' => null];
        }

        $lockStmt = $this->db->prepare(
            'SELECT * FROM receipts WHERE id = :id AND deleted_at IS NULL FOR UPDATE'
        );
        $lockStmt->execute([':id' => $receiptId]);
        $current = $lockStmt->fetch();

        if (!$current) {
            return ['code' => self::RESULT_NOT_FOUND, 'data' => null, 'payment_status' => null];
        }

        if (($current['username'] ?? '') !== $username) {
            return ['code' => self::RESULT_FORBIDDEN, 'data' => null, 'payment_status' => null];
        }

        if (!empty($current['is_archived'])) {
            return ['code' => self::RESULT_ARCHIVED, 'data' => null, 'payment_status' => null];
        }

        $rows = self::normalizeReceiptRows($current['rows'] ?? [], $receiptId);

        if ($this->ensurePaymentStatusColumn()) {
            $updStmt = $this->db->prepare(
                'UPDATE receipts SET payment_status = :payment_status, `rows` = :rows, updated_by = :updated_by, updated_at = NOW(3) WHERE id = :id'
            );
            $updStmt->execute([
                ':payment_status' => $canonicalPaymentStatus,
                ':rows'           => json_encode($rows, JSON_UNESCAPED_UNICODE),
                ':updated_by'     => $username,
                ':id'             => $receiptId,
            ]);
        } else {
            $updStmt = $this->db->prepare(
                'UPDATE receipts SET `rows` = :rows, updated_by = :updated_by, updated_at = NOW(3) WHERE id = :id'
            );
            $updStmt->execute([
                ':rows'       => json_encode($rows, JSON_UNESCAPED_UNICODE),
                ':updated_by' => $username,
                ':id'         => $receiptId,
            ]);
        }

        $updatedReceipt = $this->findById($receiptId);
        if ($updatedReceipt) {
            $updatedReceipt['payment_status'] = $canonicalPaymentStatus;
        }

        return [
            'code'           => self::RESULT_OK,
            'data'           => $updatedReceipt,
            'payment_status' => $canonicalPaymentStatus,
        ];
    }

    // ── SOFT DELETE ───────────────────────────────────────────────────────

    /**
     * Soft-delete with archive protection.
     * Check order: NOT_FOUND → ARCHIVED → apply delete.
     * Sets deleted_at + deleted_by atomically under FOR UPDATE lock.
     *
     * @return array ['code' => string]
     */
    public function softDelete(int $id, string $username): array {
        $check = $this->db->prepare(
            'SELECT is_archived FROM receipts WHERE id = :id AND deleted_at IS NULL FOR UPDATE'
        );
        $check->execute([':id' => $id]);
        $row = $check->fetch();

        if (!$row) return ['code' => self::RESULT_NOT_FOUND];
        if ($row['is_archived']) return ['code' => self::RESULT_ARCHIVED];

        $this->db->prepare(
            'UPDATE receipts SET deleted_at = NOW(3), deleted_by = :username WHERE id = :id AND deleted_at IS NULL'
        )->execute([':id' => $id, ':username' => $username]);

        return ['code' => self::RESULT_OK];
    }
}
