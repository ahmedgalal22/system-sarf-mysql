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
    const RESULT_FORBIDDEN           = 'FORBIDDEN';
    const RESULT_ROW_NOT_FOUND       = 'ROW_NOT_FOUND';
    const RESULT_INVALID             = 'INVALID';
    const RESULT_NEGATIVE_AMOUNT     = 'NEGATIVE_AMOUNT';
    const RESULT_DUPLICATE_ROW_ID    = 'DUPLICATE_ROW_ID';
    const RESULT_INCONSISTENT_LEDGER = 'INCONSISTENT_LEDGER';

    // ── Financial Reference Types for Status Transitions ──────────────────
    const REF_TYPE_ROW_DISBURSEMENT = 'receipt_row_disbursement';
    const REF_TYPE_RECEIPT_PAYMENT  = 'receipt_payment_status';

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
     * Generate a unique non-positional row identifier for newly created rows.
     */
    public static function generateUniqueRowId(): string {
        return 'r-' . bin2hex(random_bytes(8));
    }

    /**
     * Extract an explicit row identifier (row_id, _rowId, or id) if present.
     */
    public static function extractExplicitRowId(array $row): ?string {
        foreach (['row_id', '_rowId', 'id'] as $key) {
            if (isset($row[$key]) && (is_string($row[$key]) || is_numeric($row[$key]))) {
                $val = trim((string)$row[$key]);
                if ($val !== '') {
                    return $val;
                }
            }
        }
        return null;
    }

    /**
     * Build a deterministic, collision-free reference_id (<= 50 chars) for a
     * receipt row's disbursement movements.
     */
    public static function buildRowDisbursementRefId(int $receiptId, string $rowId): string {
        $clean = trim($rowId);
        $candidate = $receiptId . ':' . $clean;
        if (preg_match('/^[A-Za-z0-9_-]{1,36}$/', $clean) && strlen($candidate) <= 50) {
            return $candidate;
        }
        return $receiptId . ':h_' . substr(hash('sha256', $clean), 0, 32);
    }

    /**
     * Resolve a stable identifier for a receipt row.
     */
    public static function getStableRowId(array $row, $receiptId = '', int $rowIndex = 0): string {
        $explicit = self::extractExplicitRowId($row);
        if ($explicit !== null) {
            return $explicit;
        }
        $recPart = ($receiptId !== null && trim((string)$receiptId) !== '')
            ? trim((string)$receiptId)
            : 'rec';
        return 'row-' . $recPart . '-' . $rowIndex;
    }

    /**
     * Validate and normalize rows when creating a new receipt:
     *   - Assigns a unique non-positional row_id to any row lacking an ID.
     *   - Rejects duplicate row_ids within the same receipt.
     *   - Rejects any attempt to create a row already marked as 'paid'.
     */
    public static function prepareRowsForCreate($rows): array {
        if (is_string($rows)) {
            $rows = json_decode($rows, true) ?? [];
        }
        if (!is_array($rows)) {
            return [];
        }
        $normalized = [];
        $seenIds = [];
        foreach (array_values($rows) as $row) {
            if (!is_array($row)) continue;
            if (($row['_type'] ?? '') === 'separator') {
                $normalized[] = $row;
                continue;
            }
            if (self::getRowDisbursementStatus($row) === 'paid'
                || self::validateReceiptPaymentStatus($row['payment_status'] ?? null) === 'paid'
            ) {
                throw new InvalidArgumentException('لا يمكن إنشاء صف بحالة مدفوع أو تم صرفه مباشرة؛ يجب استخدام عملية تغيير الحالة المعتمدة');
            }
            $rowId = self::extractExplicitRowId($row);
            if ($rowId === null) {
                do {
                    $rowId = self::generateUniqueRowId();
                } while (isset($seenIds[$rowId]));
            }
            if (strlen($rowId) > 64 || preg_match('/[\x00-\x1F\x7F]/', $rowId)) {
                throw new InvalidArgumentException('معرف الصف غير صالح');
            }
            if (isset($seenIds[$rowId])) {
                throw new InvalidArgumentException('تكرار معرف الصف داخل نفس الإيصال غير مسموح: ' . $rowId);
            }
            $seenIds[$rowId] = true;
            unset($row['payment_status'], $row['payment_status_updated_at']);
            $row['row_id']              = $rowId;
            $row['_rowId']              = $rowId;
            $row['disbursement_status'] = 'unpaid';
            $row['payout_status']       = 'unpaid';
            $row['rowPayment']          = 'unpaid';
            $normalized[] = $row;
        }
        return $normalized;
    }

    /**
     * Validate and normalize rows when updating an existing receipt:
     *   - Preserves existing row_ids and their saved disbursement_status.
     *   - Assigns a unique non-positional row_id to genuinely new rows (which must start as 'unpaid').
     *   - Rejects duplicate row_ids within the receipt.
     *   - Rejects any attempt to change an existing row's disbursement_status via receipt update.
     */
    public static function prepareRowsForUpdate($submittedRows, array $existingRows, int $receiptId): array {
        if (is_string($submittedRows)) {
            $submittedRows = json_decode($submittedRows, true) ?? [];
        }
        if (!is_array($submittedRows)) {
            return [];
        }

        $oldNormalized = self::normalizeReceiptRows($existingRows, $receiptId);
        $oldById = [];
        foreach ($oldNormalized as $oldRow) {
            if (!is_array($oldRow) || ($oldRow['_type'] ?? '') === 'separator') continue;
            $oid = self::extractExplicitRowId($oldRow);
            if ($oid !== null) {
                $oldById[$oid] = $oldRow;
            }
        }

        $normalized = [];
        $seenIds = [];
        foreach (array_values($submittedRows) as $row) {
            if (!is_array($row)) continue;
            if (($row['_type'] ?? '') === 'separator') {
                $normalized[] = $row;
                continue;
            }

            if (array_key_exists('payment_status', $row) && $row['payment_status'] !== null && $row['payment_status'] !== '') {
                throw new InvalidArgumentException('حالة الدفع تطبق على الإيصال بالكامل ولا تقبل على مستوى الصف');
            }

            $rowId = self::extractExplicitRowId($row);
            if ($rowId === null) {
                do {
                    $rowId = self::generateUniqueRowId();
                } while (isset($seenIds[$rowId]) || isset($oldById[$rowId]));
            }
            if (strlen($rowId) > 64 || preg_match('/[\x00-\x1F\x7F]/', $rowId)) {
                throw new InvalidArgumentException('معرف الصف غير صالح');
            }
            if (isset($seenIds[$rowId])) {
                throw new InvalidArgumentException('تكرار معرف الصف داخل نفس الإيصال غير مسموح: ' . $rowId);
            }
            $seenIds[$rowId] = true;

            if (isset($oldById[$rowId])) {
                $oldRow = $oldById[$rowId];
                $savedStatus = self::getRowDisbursementStatus($oldRow);
                $submittedRawStatus = $row['disbursement_status'] ?? $row['row_status'] ?? null;
                if ($savedStatus === 'unpaid' && $submittedRawStatus !== null && $submittedRawStatus !== '') {
                    $validatedSub = self::validateRowDisbursementStatus($submittedRawStatus);
                    if ($validatedSub === null || $validatedSub === 'paid') {
                        throw new InvalidArgumentException('لا يمكن تغيير حالة صرف الصف من خلال تعديل الإيصال؛ يجب استخدام عملية تغيير حالة الصرف');
                    }
                }
                $effectiveStatus = $savedStatus;

                $oldOfficeKey = mb_strtolower(preg_replace('/\s+/u', ' ', trim((string)($oldRow['office'] ?? ''))), 'UTF-8');
                $newOfficeKey = mb_strtolower(preg_replace('/\s+/u', ' ', trim((string)($row['office'] ?? ''))), 'UTF-8');
                if ($newOfficeKey !== '' && $newOfficeKey === $oldOfficeKey) {
                    if (empty($row['office_id']) && !empty($oldRow['office_id'])) {
                        $row['office_id'] = (int)$oldRow['office_id'];
                    }
                } elseif ($newOfficeKey !== '' && $newOfficeKey !== $oldOfficeKey) {
                    if (!empty($row['office_id']) && !empty($oldRow['office_id']) && (int)$row['office_id'] === (int)$oldRow['office_id']) {
                        unset($row['office_id']);
                    }
                }
            } else {
                $submittedRawStatus = $row['disbursement_status'] ?? $row['row_status'] ?? $row['payout_status'] ?? $row['status'] ?? null;
                if ($submittedRawStatus !== null && self::validateRowDisbursementStatus($submittedRawStatus) === 'paid') {
                    throw new InvalidArgumentException('لا يمكن إضافة صف جديد بحالة تم صرفه مباشرة؛ يجب استخدام عملية تغيير حالة الصرف');
                }
                $effectiveStatus = 'unpaid';
            }

            unset($row['payment_status'], $row['payment_status_updated_at']);
            $row['row_id']              = $rowId;
            $row['_rowId']              = $rowId;
            $row['disbursement_status'] = $effectiveStatus;
            $row['payout_status']       = $effectiveStatus;
            $row['rowPayment']          = $effectiveStatus;
            $normalized[] = $row;
        }

        return $normalized;
    }

    /**
     * Resolve and stamp stable `office_id` on each data row using active offices for $username.
     */
    private function attachOfficeIdsToRows(array $rows, string $username): array {
        if (empty($rows) || $username === '') {
            return $rows;
        }
        $stmt = $this->db->prepare('SELECT id, name FROM offices WHERE username = :u AND deleted_at IS NULL');
        $stmt->execute([':u' => $username]);
        $allOffices = $stmt->fetchAll();
        if (empty($allOffices)) {
            return $rows;
        }
        foreach ($rows as $idx => $row) {
            if (!is_array($row) || ($row['_type'] ?? '') === 'separator') continue;
            $office = VehicleLedgerRepository::resolveOfficeForRow($row, $allOffices);
            if ($office && !empty($office['id'])) {
                $rows[$idx]['office_id'] = (int)$office['id'];
            }
        }
        return $rows;
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
                $totalWeight += (float)($row['weight'] ?? 0) - ((float)($row['deficit'] ?? 0) / 1000.0);
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
     * Enforces initial unpaid state for receipt-level payment_status, payout_status,
     * and all rows' disbursement_status, and assigns unique non-positional row_ids.
     */
    public function insertReceipt(array $data): array {
        if (isset($data['payment_status']) && $data['payment_status'] !== null && $data['payment_status'] !== '') {
            $validatedPay = self::validateReceiptPaymentStatus($data['payment_status']);
            if ($validatedPay === null || $validatedPay === 'paid') {
                throw new InvalidArgumentException('لا يمكن إنشاء إيصال بحالة مدفوع مباشرة؛ يجب استخدام عملية تغيير حالة الدفع المعتمدة');
            }
        }
        if (isset($data['payout_status']) && $data['payout_status'] !== null && $data['payout_status'] !== '') {
            if (strtolower(trim((string)$data['payout_status'])) !== 'unpaid') {
                throw new InvalidArgumentException('لا يمكن إنشاء إيصال بحالة صرف مدفوعة مباشرة');
            }
        }
        $paymentStatus = 'unpaid';
        $cleanRows = self::prepareRowsForCreate($data['rows'] ?? []);
        $cleanRows = $this->attachOfficeIdsToRows($cleanRows, (string)($data['username'] ?? ''));
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
            'SELECT * FROM receipts WHERE id = :id AND deleted_at IS NULL FOR UPDATE'
        );
        $lockStmt->execute([':id' => $id]);
        $current = $lockStmt->fetch();

        if (!$current) {
            return ['code' => self::RESULT_NOT_FOUND, 'data' => null];
        }

        if (($current['username'] ?? '') !== $username) {
            return ['code' => self::RESULT_FORBIDDEN, 'data' => null];
        }

        if ($current['is_archived']) {
            return ['code' => self::RESULT_ARCHIVED, 'data' => null];
        }

        if ($expectedUpdatedAt !== null && $current['updated_at'] !== $expectedUpdatedAt) {
            $latest = $this->findById($id);
            return ['code' => self::RESULT_CONFLICT, 'data' => $latest];
        }

        $savedPaymentStatus = self::getReceiptPaymentStatus($current);
        if ($savedPaymentStatus === 'unpaid' && array_key_exists('payment_status', $patch) && $patch['payment_status'] !== null && $patch['payment_status'] !== '') {
            $validatedPay = self::validateReceiptPaymentStatus($patch['payment_status']);
            if ($validatedPay === null || $validatedPay === 'paid') {
                throw new InvalidArgumentException('لا يمكن تغيير حالة الدفع للإيصال من خلال تعديل الإيصال؛ يجب استخدام عملية تغيير حالة الدفع المعتمدة');
            }
        }
        $savedPayout = strtolower(trim((string)($current['payout_status'] ?? 'unpaid')));
        if ($savedPayout === 'unpaid' && array_key_exists('payout_status', $patch) && $patch['payout_status'] !== null && $patch['payout_status'] !== '') {
            if (strtolower(trim((string)$patch['payout_status'])) !== 'unpaid') {
                throw new InvalidArgumentException('لا يمكن تغيير حالة الصرف من خلال تعديل الإيصال');
            }
        }

        // Build patch (status columns are managed exclusively by transition methods)
        $allowed = [
            'receipt_date', 'client_id', 'client_type', 'client_name',
            'account_type',
            'total', 'net_due', 'net_total', 'paid', 'previous_balance', 'general_add',
            'rows', 'notes', 'shipping_number',
        ];

        $fields = [];
        $params = [':id' => $id, ':updated_by' => $username];

        foreach ($allowed as $field) {
            if (array_key_exists($field, $patch)) {
                $value = $patch[$field];
                if ($field === 'rows') {
                    $normalizedRows = self::prepareRowsForUpdate($value, is_string($current['rows'] ?? null) ? (json_decode($current['rows'], true) ?: []) : ($current['rows'] ?? []), $id);
                    $normalizedRows = $this->attachOfficeIdsToRows($normalizedRows, $username);
                    $value = json_encode($normalizedRows, JSON_UNESCAPED_UNICODE);
                }
                $fields[] = "`{$field}` = :{$field}";
                $params[":{$field}"] = $value;
            }
        }

        if (empty($fields)) {
            return ['code' => self::RESULT_OK, 'data' => $this->findById($id), 'previous' => $current];
        }

        $fields[] = 'updated_by = :updated_by';
        $fields[] = 'updated_at = NOW(3)';

        $sql = 'UPDATE receipts SET ' . implode(', ', $fields) . ' WHERE id = :id';
        $this->db->prepare($sql)->execute($params);

        return ['code' => self::RESULT_OK, 'data' => $this->findById($id), 'previous' => $current];
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

    /**
     * Resolve the vehicle owner associated with a receipt using stable database
     * identifiers (`client_id` against `vehicle_owners.id` or `vehicle_owners.uuid`).
     *
     * @return ?array{client_id:string, owner_db_id:string, client_type:string, name:string}
     */
    public static function resolveOwnerForReceipt(
        array $receipt,
        string $username,
        VehicleOwnerRepository $ownerRepo
    ): ?array {
        $rawClientId = trim((string)($receipt['client_id'] ?? ''));
        if ($rawClientId === '') {
            return null;
        }

        $owner = null;
        if (ctype_digit($rawClientId)) {
            $candidate = $ownerRepo->getById((int)$rawClientId);
            if ($candidate && ($candidate['username'] ?? '') === $username) {
                $owner = $candidate;
            }
        }
        if (!$owner) {
            $candidate = $ownerRepo->getByUuid($rawClientId);
            if ($candidate && ($candidate['username'] ?? '') === $username) {
                $owner = $candidate;
            }
        }
        if (!$owner) {
            foreach ($ownerRepo->getAllByUsername($username) as $candidate) {
                if ((string)($candidate['id'] ?? '') === $rawClientId
                    || (string)($candidate['uuid'] ?? '') === $rawClientId
                ) {
                    $owner = $candidate;
                    break;
                }
            }
        }
        if (!$owner) {
            return null;
        }

        $ownerName = preg_replace('/\s+/u', ' ', trim((string)($owner['name'] ?? '')));
        if ($ownerName === '') {
            $ownerName = preg_replace('/\s+/u', ' ', trim((string)($receipt['client_name'] ?? '')));
        }

        return [
            'client_id'   => $rawClientId,
            'owner_db_id' => (string)($owner['id'] ?? $rawClientId),
            'client_type' => 'owner',
            'name'        => $ownerName,
        ];
    }

    /**
     * Validate the active financial movement pair (treasury + vehicle_ledger) for a
     * row-level disbursement reference before repeating a transition or reversing it.
     *
     * Validates by stable identifiers (`client_id`, `client_type`, `reference_type`,
     * `reference_id`, `amount`, `type`, `effect`, `account_type`, `is_archived = 0`).
     * Does NOT reject a valid movement if the office's display name changed later.
     */
    public static function validateRowDisbursementPair(
        string $username,
        string $rowRefId,
        string $expectedState,
        int $expectedCents,
        string $expectedOfficeId,
        TreasuryRepo $treasuryRepo,
        VehicleLedgerRepository $ledgerRepo
    ): array {
        $tRows = $treasuryRepo->getActiveByReferenceForUser($username, $rowRefId, self::REF_TYPE_ROW_DISBURSEMENT, true);
        $lRows = $ledgerRepo->getActiveByReferenceForUser($username, $rowRefId, self::REF_TYPE_ROW_DISBURSEMENT, true);

        if ($expectedState === 'unpaid' || $expectedCents === 0) {
            if (count($tRows) !== 0 || count($lRows) !== 0) {
                return [
                    'valid'   => false,
                    'message' => 'تعارض في القيود المالية للصف: توجد حركات نشطة غير متوقعة',
                ];
            }
            return ['valid' => true, 'treasury' => [], 'ledger' => []];
        }

        if (count($tRows) !== 1 || count($lRows) !== 1) {
            return [
                'valid'   => false,
                'message' => 'تعارض أو نقص في زوج القيود المالية لحركة صرف الصف',
            ];
        }

        $t = $tRows[0];
        $l = $lRows[0];

        if (!empty($t['is_archived']) || !empty($l['is_archived'])) {
            return [
                'valid'   => false,
                'message' => 'لا يمكن تعديل أو عكس حركة صرف صف مرتبطة بسجل مؤرشف',
            ];
        }

        $validTreasury = intval($t['amount'] ?? -1) === $expectedCents
            && ($t['type'] ?? '') === 'deposit'
            && ($t['effect'] ?? '') === 'row_disbursement'
            && ($t['account_type'] ?? 'cash') === 'cash'
            && ($t['client_type'] ?? '') === 'office'
            && ($expectedOfficeId === '' || strval($t['client_id'] ?? '') === $expectedOfficeId);

        $validLedger = intval($l['amount'] ?? -1) === $expectedCents
            && ($l['type'] ?? '') === 'OFFICE_DEPOSIT'
            && ($l['effect'] ?? '') === 'row_disbursement'
            && ($l['client_type'] ?? '') === 'office'
            && ($expectedOfficeId === '' || strval($l['client_id'] ?? '') === $expectedOfficeId);

        if (!$validTreasury || !$validLedger || strval($t['client_id'] ?? '') !== strval($l['client_id'] ?? '')) {
            return [
                'valid'   => false,
                'message' => 'تعارض في بيانات زوج القيود المالية لحركة صرف الصف',
            ];
        }

        return ['valid' => true, 'treasury' => $tRows, 'ledger' => $lRows];
    }

    /**
     * Validate the active financial movement pair (treasury + vehicle_ledger) for a
     * receipt-level payment reference before repeating a transition or reversing it.
     *
     * Validates by stable identifiers (`client_id`, `client_type`, `reference_type`,
     * `reference_id`, `amount`, `type`, `effect`, `account_type`, `is_archived = 0`).
     * Does NOT reject a valid movement solely because the owner's display name changed
     * after the movement was created.
     */
    public static function validateReceiptPaymentPair(
        string $username,
        string $receiptRefId,
        string $expectedState,
        int $expectedPaidCents,
        string $expectedOwnerId,
        TreasuryRepo $treasuryRepo,
        VehicleLedgerRepository $ledgerRepo
    ): array {
        $tRows = $treasuryRepo->getActiveByReferenceForUser($username, $receiptRefId, self::REF_TYPE_RECEIPT_PAYMENT, true);
        $lRows = $ledgerRepo->getActiveByReferenceForUser($username, $receiptRefId, self::REF_TYPE_RECEIPT_PAYMENT, true);

        if ($expectedState === 'unpaid') {
            if (count($tRows) !== 0 || count($lRows) !== 0) {
                return [
                    'valid'   => false,
                    'message' => 'تعارض في القيود المالية للإيصال: توجد حركات دفع نشطة غير متوقعة',
                ];
            }
            return ['valid' => true, 'treasury' => [], 'ledger' => []];
        }

        if (count($tRows) === 0 && count($lRows) === 0) {
            if ($expectedPaidCents === 0) {
                return ['valid' => true, 'treasury' => [], 'ledger' => []];
            }
            return [
                'valid'   => false,
                'message' => 'تعارض أو نقص في زوج القيود المالية لحركة دفع الإيصال',
            ];
        }

        if (count($tRows) !== 1 || count($lRows) !== 1) {
            return [
                'valid'   => false,
                'message' => 'تعارض أو نقص في زوج القيود المالية لحركة دفع الإيصال',
            ];
        }

        $t = $tRows[0];
        $l = $lRows[0];

        if (!empty($t['is_archived']) || !empty($l['is_archived'])) {
            return [
                'valid'   => false,
                'message' => 'لا يمكن تعديل أو عكس حركة دفع إيصال مرتبطة بسجل مؤرشف',
            ];
        }

        $tAmount = intval($t['amount'] ?? -1);
        $lAmount = intval($l['amount'] ?? -2);
        $desc = trim((string)($t['description'] ?? ''));
        $validTreasury = $tAmount > 0
            && $tAmount === $lAmount
            && ($t['type'] ?? '') === 'withdraw'
            && ($t['effect'] ?? '') === 'receipt_payout'
            && ($t['account_type'] ?? 'cash') === 'cash'
            && ($t['client_type'] ?? '') === 'owner'
            && ($expectedOwnerId === '' || strval($t['client_id'] ?? '') === $expectedOwnerId)
            && strpos($desc, 'صرف كارتة - ') === 0
            && strlen($desc) > strlen('صرف كارتة - ');

        $validLedger = $lAmount > 0
            && $lAmount === $tAmount
            && ($l['type'] ?? '') === 'receipt_payment'
            && ($l['effect'] ?? '') === 'receipt_payout'
            && ($l['client_type'] ?? '') === 'owner'
            && ($expectedOwnerId === '' || strval($l['client_id'] ?? '') === $expectedOwnerId);

        if (!$validTreasury || !$validLedger || strval($t['client_id'] ?? '') !== strval($l['client_id'] ?? '')) {
            return [
                'valid'   => false,
                'message' => 'تعارض في بيانات زوج القيود المالية لحركة دفع الإيصال',
            ];
        }

        return ['valid' => true, 'treasury' => $tRows, 'ledger' => $lRows];
    }

    /**
     * Canonical atomic transition for a single row's disbursement status
     * ('unpaid' / 'لم يتم صرفه' <-> 'paid' / 'تم صرفه').
     *
     * Must be invoked inside an active PDO transaction owned by the caller.
     * Acquires SELECT ... FOR UPDATE on the receipt row first.
     */
    public function transitionRowDisbursementStatus(
        int $receiptId,
        string $rowId,
        string $targetStatus,
        string $username,
        TreasuryRepo $treasuryRepo,
        VehicleLedgerRepository $ledgerRepo,
        OfficeRepository $officeRepo
    ): array {
        $canonicalStatus = self::validateRowDisbursementStatus($targetStatus);
        if ($canonicalStatus === null) {
            return ['code' => self::RESULT_INVALID, 'message' => 'حالة الصرف غير صالحة', 'data' => null, 'row' => null];
        }

        $cleanRowId = trim($rowId);
        if ($cleanRowId === '') {
            return ['code' => self::RESULT_INVALID, 'message' => 'معرف الصف مطلوب', 'data' => null, 'row' => null];
        }

        $lockStmt = $this->db->prepare(
            'SELECT * FROM receipts WHERE id = :id AND deleted_at IS NULL FOR UPDATE'
        );
        $lockStmt->execute([':id' => $receiptId]);
        $current = $lockStmt->fetch();

        if (!$current) {
            return ['code' => self::RESULT_NOT_FOUND, 'message' => 'الإيصال غير موجود', 'data' => null, 'row' => null];
        }

        if (($current['username'] ?? '') !== $username) {
            return ['code' => self::RESULT_FORBIDDEN, 'message' => 'غير مسموح بتعديل هذا الإيصال', 'data' => null, 'row' => null];
        }

        if (!empty($current['is_archived'])) {
            return ['code' => self::RESULT_ARCHIVED, 'message' => 'الإيصال مؤرشف', 'data' => null, 'row' => null];
        }

        $preservedPaymentStatus = self::getReceiptPaymentStatus($current);
        $rows = self::normalizeReceiptRows($current['rows'] ?? [], $receiptId);

        // Verify row IDs are unique within this receipt
        $seenRowIds = [];
        $targetIndex = null;
        foreach ($rows as $idx => $r) {
            if (!is_array($r) || ($r['_type'] ?? '') === 'separator') continue;
            $sid = self::getStableRowId($r, $receiptId, $idx);
            if (isset($seenRowIds[$sid])) {
                return [
                    'code'    => self::RESULT_DUPLICATE_ROW_ID,
                    'message' => 'تكرار معرف الصف داخل الإيصال',
                    'data'    => null,
                    'row'     => null,
                ];
            }
            $seenRowIds[$sid] = true;
            if ($sid === $cleanRowId) {
                $targetIndex = $idx;
            }
        }

        if ($targetIndex === null) {
            return ['code' => self::RESULT_ROW_NOT_FOUND, 'message' => 'الصف المطلوب غير موجود في هذا الإيصال', 'data' => null, 'row' => null];
        }

        $targetRow = $rows[$targetIndex];
        $prevStatus = self::getRowDisbursementStatus($targetRow);
        $calc = VehicleLedgerRepository::calculateRowNetAndSarfCents($targetRow);
        $rowCents = $calc['total_cents'];

        if ($canonicalStatus === 'paid' && $rowCents < 0) {
            return [
                'code'    => self::RESULT_NEGATIVE_AMOUNT,
                'message' => 'لا يمكن صرف صف بقيمة سالبة (الصافي + الصرف أقل من صفر)',
                'data'    => null,
                'row'     => null,
            ];
        }

        if ($prevStatus === 'paid' && $rowCents < 0) {
            return [
                'code'    => self::RESULT_INCONSISTENT_LEDGER,
                'message' => 'تعارض في قيمة الصف المصروف (قيمة سالبة)',
                'data'    => null,
                'row'     => null,
            ];
        }

        $allOffices = $officeRepo->getAllByUsername($username);
        $office = VehicleLedgerRepository::resolveOfficeForRow($targetRow, $allOffices);
        if (!$office && ($canonicalStatus === 'paid' || ($prevStatus === 'paid' && $rowCents > 0))) {
            return [
                'code'    => self::RESULT_INVALID,
                'message' => 'المكتب المرتبط بالصف غير موجود أو غير نشط',
                'data'    => null,
                'row'     => null,
            ];
        }

        $officeIdStr = $office ? strval($office['id']) : '';
        $rowRefId = self::buildRowDisbursementRefId($receiptId, $cleanRowId);

        // Validate existing movement pair before repeating or transitioning
        $pairCheck = self::validateRowDisbursementPair(
            $username,
            $rowRefId,
            $prevStatus,
            max(0, $rowCents),
            $officeIdStr,
            $treasuryRepo,
            $ledgerRepo
        );
        if (!$pairCheck['valid']) {
            return [
                'code'    => self::RESULT_INCONSISTENT_LEDGER,
                'message' => $pairCheck['message'],
                'data'    => null,
                'row'     => null,
            ];
        }

        // Idempotent repeated request: status already equals target and pair is verified
        if ($prevStatus === $canonicalStatus) {
            $existingNormalized = $this->findById($receiptId);
            return [
                'code'     => self::RESULT_OK,
                'changed'  => false,
                'data'     => $existingNormalized,
                'row'      => $targetRow,
                'treasury' => $pairCheck['treasury'][0] ?? null,
                'ledger'   => $pairCheck['ledger'][0] ?? null,
            ];
        }

        $now = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d H:i:s.v');
        $today = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d');
        $effectiveDate = !empty($current['receipt_date']) ? $current['receipt_date'] : $today;
        $createdTreasury = null;
        $createdLedger = null;

        if ($canonicalStatus === 'paid') {
            if ($rowCents > 0) {
                $officeName = preg_replace('/\s+/u', ' ', trim((string)($office['name'] ?? '')));
                $ownerId = trim((string)($targetRow['owner_id'] ?? ($current['client_id'] ?? ''))) ?: null;
                $ownerName = preg_replace('/\s+/u', ' ', trim((string)($targetRow['owner_name'] ?? ($current['client_name'] ?? '')))) ?: null;
                $desc = 'صرف كارتة - ' . $officeName;

                $createdTreasury = $treasuryRepo->create([
                    'username'       => $username,
                    'type'           => 'deposit',
                    'effect'         => 'row_disbursement',
                    'account_type'   => 'cash',
                    'amount'         => $rowCents,
                    'reference_type' => self::REF_TYPE_ROW_DISBURSEMENT,
                    'reference_id'   => $rowRefId,
                    'client_id'      => $officeIdStr,
                    'client_type'    => 'office',
                    'client_name'    => $officeName,
                    'receipt_number' => strval($current['receipt_number'] ?? $receiptId),
                    'date'           => $effectiveDate,
                    'applied_at'     => $now,
                    'description'    => $desc,
                    'note'           => $desc,
                    'is_reversed'    => 0,
                ]);

                $createdLedger = $ledgerRepo->create([
                    'username'           => $username,
                    'vehicle_owner_id'   => $ownerId,
                    'vehicle_owner_name' => $ownerName,
                    'client_id'          => $officeIdStr,
                    'client_type'        => 'office',
                    'client_name'        => $officeName,
                    'type'               => 'OFFICE_DEPOSIT',
                    'effect'             => 'row_disbursement',
                    'amount'             => $rowCents,
                    'reference_type'     => self::REF_TYPE_ROW_DISBURSEMENT,
                    'reference_id'       => $rowRefId,
                    'receipt_number'     => strval($current['receipt_number'] ?? $receiptId),
                    'date'               => $effectiveDate,
                    'applied_at'         => $now,
                    'note'               => $desc,
                    'is_reversed'        => 0,
                ]);
            }
        } else {
            if (!empty($pairCheck['treasury'])) {
                $revT = $treasuryRepo->reverseByReferenceForUser($username, $rowRefId, self::REF_TYPE_ROW_DISBURSEMENT);
                $revL = $ledgerRepo->reverseByReferenceForUser($username, $rowRefId, self::REF_TYPE_ROW_DISBURSEMENT);
                if ($revT !== 1 || $revL !== 1) {
                    return [
                        'code'    => self::RESULT_INCONSISTENT_LEDGER,
                        'message' => 'فشل عكس زوج القيود المالية لحركة صرف الصف بشكل متطابق',
                        'data'    => null,
                        'row'     => null,
                    ];
                }
            }
        }

        $rows[$targetIndex]['row_id']              = $cleanRowId;
        $rows[$targetIndex]['_rowId']              = $cleanRowId;
        if ($office) {
            $rows[$targetIndex]['office_id']       = (int)$office['id'];
        }
        $rows[$targetIndex]['disbursement_status'] = $canonicalStatus;
        $rows[$targetIndex]['payout_status']       = $canonicalStatus;
        $rows[$targetIndex]['rowPayment']          = $canonicalStatus;
        $rows[$targetIndex]['status_updated_at']   = $now;
        $updatedRow = $rows[$targetIndex];

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

        return [
            'code'     => self::RESULT_OK,
            'changed'  => true,
            'data'     => $this->findById($receiptId),
            'row'      => $updatedRow,
            'treasury' => $createdTreasury,
            'ledger'   => $createdLedger,
        ];
    }

    /**
     * Canonical atomic transition for receipt-level payment status
     * ('unpaid' / 'لم يتم دفعه' <-> 'paid' / 'تم دفعه').
     *
     * Must be invoked inside an active PDO transaction owned by the caller.
     * Acquires SELECT ... FOR UPDATE on the receipt row first.
     */
    public function transitionReceiptPaymentStatus(
        int $receiptId,
        string $targetPaymentStatus,
        string $username,
        TreasuryRepo $treasuryRepo,
        VehicleLedgerRepository $ledgerRepo,
        VehicleOwnerRepository $ownerRepo
    ): array {
        $canonicalPaymentStatus = self::validateReceiptPaymentStatus($targetPaymentStatus);
        if ($canonicalPaymentStatus === null) {
            return [
                'code'           => self::RESULT_INVALID,
                'message'        => 'حالة الدفع غير صالحة',
                'data'           => null,
                'payment_status' => null,
            ];
        }

        $lockStmt = $this->db->prepare(
            'SELECT * FROM receipts WHERE id = :id AND deleted_at IS NULL FOR UPDATE'
        );
        $lockStmt->execute([':id' => $receiptId]);
        $current = $lockStmt->fetch();

        if (!$current) {
            return [
                'code'           => self::RESULT_NOT_FOUND,
                'message'        => 'الإيصال غير موجود',
                'data'           => null,
                'payment_status' => null,
            ];
        }

        if (($current['username'] ?? '') !== $username) {
            return [
                'code'           => self::RESULT_FORBIDDEN,
                'message'        => 'غير مسموح بتعديل هذا الإيصال',
                'data'           => null,
                'payment_status' => null,
            ];
        }

        if (!empty($current['is_archived'])) {
            return [
                'code'           => self::RESULT_ARCHIVED,
                'message'        => 'الإيصال مؤرشف',
                'data'           => null,
                'payment_status' => null,
            ];
        }

        $prevPaymentStatus = self::getReceiptPaymentStatus($current);
        $paidCents = intval($current['paid'] ?? 0);

        if ($canonicalPaymentStatus === 'paid' && $paidCents < 0) {
            return [
                'code'           => self::RESULT_NEGATIVE_AMOUNT,
                'message'        => 'لا يمكن تأكيد دفع إيصال بقيمة مدفوعة سالبة',
                'data'           => null,
                'payment_status' => null,
            ];
        }

        if ($prevPaymentStatus === 'paid' && $paidCents < 0) {
            return [
                'code'           => self::RESULT_INCONSISTENT_LEDGER,
                'message'        => 'تعارض في القيمة المدفوعة للإيصال (قيمة سالبة)',
                'data'           => null,
                'payment_status' => null,
            ];
        }

        $ownerInfo = self::resolveOwnerForReceipt($current, $username, $ownerRepo);
        if (!$ownerInfo && ($canonicalPaymentStatus === 'paid' || ($prevPaymentStatus === 'paid' && $paidCents > 0))) {
            return [
                'code'           => self::RESULT_INVALID,
                'message'        => 'صاحب المركبة المرتبط بالإيصال غير موجود أو غير نشط',
                'data'           => null,
                'payment_status' => null,
            ];
        }

        $ownerIdStr = $ownerInfo ? $ownerInfo['client_id'] : trim((string)($current['client_id'] ?? ''));
        $receiptRefId = strval($receiptId);

        $pairCheck = self::validateReceiptPaymentPair(
            $username,
            $receiptRefId,
            $prevPaymentStatus,
            max(0, $paidCents),
            $ownerIdStr,
            $treasuryRepo,
            $ledgerRepo
        );
        if (!$pairCheck['valid']) {
            return [
                'code'           => self::RESULT_INCONSISTENT_LEDGER,
                'message'        => $pairCheck['message'],
                'data'           => null,
                'payment_status' => null,
            ];
        }

        // Idempotent repeated request
        if ($prevPaymentStatus === $canonicalPaymentStatus) {
            $existingNormalized = $this->findById($receiptId);
            if ($existingNormalized) {
                $existingNormalized['payment_status'] = $canonicalPaymentStatus;
            }
            return [
                'code'           => self::RESULT_OK,
                'changed'        => false,
                'data'           => $existingNormalized,
                'payment_status' => $canonicalPaymentStatus,
                'treasury'       => $pairCheck['treasury'][0] ?? null,
                'ledger'         => $pairCheck['ledger'][0] ?? null,
            ];
        }

        $now = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d H:i:s.v');
        $today = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d');
        $effectiveDate = !empty($current['receipt_date']) ? $current['receipt_date'] : $today;
        $createdTreasury = null;
        $createdLedger = null;

        if ($canonicalPaymentStatus === 'paid') {
            if ($paidCents > 0) {
                $ownerName = $ownerInfo['name'] ?? '';
                if ($ownerName === '') {
                    return [
                        'code'           => self::RESULT_INVALID,
                        'message'        => 'اسم صاحب المركبة مطلوب لتسجيل حركة الخزنة',
                        'data'           => null,
                        'payment_status' => null,
                    ];
                }
                $exactDesc = 'صرف كارتة - ' . $ownerName;

                $createdTreasury = $treasuryRepo->create([
                    'username'       => $username,
                    'type'           => 'withdraw',
                    'effect'         => 'receipt_payout',
                    'account_type'   => 'cash',
                    'amount'         => $paidCents,
                    'reference_type' => self::REF_TYPE_RECEIPT_PAYMENT,
                    'reference_id'   => $receiptRefId,
                    'client_id'      => $ownerIdStr,
                    'client_type'    => 'owner',
                    'client_name'    => $ownerName,
                    'receipt_number' => strval($current['receipt_number'] ?? $receiptId),
                    'date'           => $effectiveDate,
                    'applied_at'     => $now,
                    'description'    => $exactDesc,
                    'note'           => $exactDesc,
                    'is_reversed'    => 0,
                ]);

                $createdLedger = $ledgerRepo->create([
                    'username'       => $username,
                    'client_id'      => $ownerIdStr,
                    'client_type'    => 'owner',
                    'client_name'    => $ownerName,
                    'type'           => 'receipt_payment',
                    'effect'         => 'receipt_payout',
                    'amount'         => $paidCents,
                    'reference_type' => self::REF_TYPE_RECEIPT_PAYMENT,
                    'reference_id'   => $receiptRefId,
                    'receipt_number' => strval($current['receipt_number'] ?? $receiptId),
                    'date'           => $effectiveDate,
                    'applied_at'     => $now,
                    'note'           => $exactDesc,
                    'is_reversed'    => 0,
                ]);
            }
        } else {
            if (!empty($pairCheck['treasury'])) {
                $revT = $treasuryRepo->reverseByReferenceForUser($username, $receiptRefId, self::REF_TYPE_RECEIPT_PAYMENT);
                $revL = $ledgerRepo->reverseByReferenceForUser($username, $receiptRefId, self::REF_TYPE_RECEIPT_PAYMENT);
                if ($revT !== 1 || $revL !== 1) {
                    return [
                        'code'           => self::RESULT_INCONSISTENT_LEDGER,
                        'message'        => 'فشل عكس زوج القيود المالية لحركة دفع الإيصال بشكل متطابق',
                        'data'           => null,
                        'payment_status' => null,
                    ];
                }
            }
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
            'changed'        => true,
            'data'           => $updatedReceipt,
            'payment_status' => $canonicalPaymentStatus,
            'treasury'       => $createdTreasury,
            'ledger'         => $createdLedger,
        ];
    }

    /**
     * Reconcile status-linked movements (`receipt_row_disbursement` and
     * `receipt_payment_status`) when a receipt is edited inside an active transaction.
     *
     * Rules:
     *   - Validates all existing paired movements before making changes.
     *   - Reverses and recreates ONLY the movements whose row was deleted or whose
     *     amount or stable office/owner identity changed.
     *   - Leaves unchanged rows' movements untouched.
     *
     * @return array{code:string, message?:string}
     */
    public function reconcileStatusMovementsOnReceiptUpdate(
        array $previousReceipt,
        array $updatedReceipt,
        string $username,
        TreasuryRepo $treasuryRepo,
        VehicleLedgerRepository $ledgerRepo,
        OfficeRepository $officeRepo,
        VehicleOwnerRepository $ownerRepo
    ): array {
        $receiptId = (int)($updatedReceipt['id'] ?? $previousReceipt['id'] ?? 0);
        $oldRows = self::normalizeReceiptRows($previousReceipt['rows'] ?? [], $receiptId);
        $newRows = self::normalizeReceiptRows($updatedReceipt['rows'] ?? [], $receiptId);

        $oldById = [];
        $knownRefIds = [];
        foreach ($oldRows as $idx => $r) {
            if (!is_array($r) || ($r['_type'] ?? '') === 'separator') continue;
            $sid = self::getStableRowId($r, $receiptId, $idx);
            $oldById[$sid] = $r;
            $knownRefIds[self::buildRowDisbursementRefId($receiptId, $sid)] = true;
        }

        $newById = [];
        foreach ($newRows as $idx => $r) {
            if (!is_array($r) || ($r['_type'] ?? '') === 'separator') continue;
            $sid = self::getStableRowId($r, $receiptId, $idx);
            $newById[$sid] = $r;
        }

        // Check for any orphaned active row-disbursement entries with this receiptId prefix
        $prefix = $receiptId . ':%';
        $orphanTStmt = $this->db->prepare(
            'SELECT reference_id FROM treasury WHERE username = :u AND reference_type = :rt AND reference_id LIKE :pfx AND is_reversed = 0 AND deleted_at IS NULL FOR UPDATE'
        );
        $orphanTStmt->execute([':u' => $username, ':rt' => self::REF_TYPE_ROW_DISBURSEMENT, ':pfx' => $prefix]);
        foreach ($orphanTStmt->fetchAll() as $ot) {
            if (!isset($knownRefIds[$ot['reference_id']])) {
                return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => 'توجد حركات خزنة نشطة لصف غير معروف في هذا الإيصال'];
            }
        }
        $orphanLStmt = $this->db->prepare(
            'SELECT reference_id FROM vehicle_ledger WHERE username = :u AND reference_type = :rt AND reference_id LIKE :pfx AND is_reversed = 0 AND deleted_at IS NULL FOR UPDATE'
        );
        $orphanLStmt->execute([':u' => $username, ':rt' => self::REF_TYPE_ROW_DISBURSEMENT, ':pfx' => $prefix]);
        foreach ($orphanLStmt->fetchAll() as $ol) {
            if (!isset($knownRefIds[$ol['reference_id']])) {
                return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => 'توجد حركات دفتر نشطة لصف غير معروف في هذا الإيصال'];
            }
        }

        $allOffices = $officeRepo->getAllByUsername($username);
        $now = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d H:i:s.v');
        $today = (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d');
        $effectiveDate = !empty($updatedReceipt['receipt_date'])
            ? $updatedReceipt['receipt_date']
            : (!empty($previousReceipt['receipt_date']) ? $previousReceipt['receipt_date'] : $today);
        $receiptNumStr = strval($updatedReceipt['receipt_number'] ?? $previousReceipt['receipt_number'] ?? $receiptId);

        // 1. Reconcile row-level disbursement movements
        foreach ($oldById as $rowId => $oldRow) {
            $oldStatus = self::getRowDisbursementStatus($oldRow);
            $rowRefId = self::buildRowDisbursementRefId($receiptId, $rowId);
            $oldCalc = VehicleLedgerRepository::calculateRowNetAndSarfCents($oldRow);
            $oldCents = $oldCalc['total_cents'];
            $oldOffice = VehicleLedgerRepository::resolveOfficeForRow($oldRow, $allOffices);
            $oldOfficeId = $oldOffice ? strval($oldOffice['id']) : '';

            if ($oldStatus === 'paid' && $oldCents < 0) {
                return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => 'تعارض في قيمة الصف المصروف السابق'];
            }

            $pairCheck = self::validateRowDisbursementPair(
                $username,
                $rowRefId,
                $oldStatus,
                max(0, $oldCents),
                $oldOfficeId,
                $treasuryRepo,
                $ledgerRepo
            );
            if (!$pairCheck['valid']) {
                return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => $pairCheck['message']];
            }

            if ($oldStatus !== 'paid') {
                continue;
            }

            $oldPostedCents = !empty($pairCheck['treasury']) ? intval($pairCheck['treasury'][0]['amount']) : 0;
            $oldPostedOfficeId = !empty($pairCheck['treasury']) ? strval($pairCheck['treasury'][0]['client_id'] ?? '') : $oldOfficeId;
            $oldPostedDate = !empty($pairCheck['treasury']) ? strval($pairCheck['treasury'][0]['date'] ?? '') : '';

            // Row was deleted during edit -> reverse its disbursement pair
            if (!isset($newById[$rowId])) {
                if ($oldPostedCents > 0) {
                    $revT = $treasuryRepo->reverseByReferenceForUser($username, $rowRefId, self::REF_TYPE_ROW_DISBURSEMENT);
                    $revL = $ledgerRepo->reverseByReferenceForUser($username, $rowRefId, self::REF_TYPE_ROW_DISBURSEMENT);
                    if ($revT !== 1 || $revL !== 1) {
                        return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => 'فشل عكس حركة الصف المحذوف'];
                    }
                }
                continue;
            }

            // Row still exists and is 'paid' -> check if amount, office, or receipt_date changed
            $newRow = $newById[$rowId];
            $newCalc = VehicleLedgerRepository::calculateRowNetAndSarfCents($newRow);
            $newCents = $newCalc['total_cents'];
            if ($newCents < 0) {
                return [
                    'code'    => self::RESULT_NEGATIVE_AMOUNT,
                    'message' => 'لا يمكن حفظ صف مصروف بقيمة سالبة (الصافي + الصرف أقل من صفر)',
                ];
            }
            $newOffice = VehicleLedgerRepository::resolveOfficeForRow($newRow, $allOffices);
            if (!$newOffice && $newCents > 0) {
                return [
                    'code'    => self::RESULT_INVALID,
                    'message' => 'المكتب المرتبط بالصف المصروف غير موجود أو غير نشط',
                ];
            }
            $newOfficeId = $newOffice ? strval($newOffice['id']) : $oldPostedOfficeId;

            if ($newCents !== $oldPostedCents
                || ($newCents > 0 && $newOfficeId !== $oldPostedOfficeId)
                || ($oldPostedCents > 0 && $effectiveDate !== $oldPostedDate)
            ) {
                if ($oldPostedCents > 0) {
                    $revT = $treasuryRepo->reverseByReferenceForUser($username, $rowRefId, self::REF_TYPE_ROW_DISBURSEMENT);
                    $revL = $ledgerRepo->reverseByReferenceForUser($username, $rowRefId, self::REF_TYPE_ROW_DISBURSEMENT);
                    if ($revT !== 1 || $revL !== 1) {
                        return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => 'فشل عكس حركة الصف المعدل'];
                    }
                }
                if ($newCents > 0 && $newOffice) {
                    $officeName = preg_replace('/\s+/u', ' ', trim((string)($newOffice['name'] ?? '')));
                    $ownerId = trim((string)($newRow['owner_id'] ?? ($updatedReceipt['client_id'] ?? ''))) ?: null;
                    $ownerName = preg_replace('/\s+/u', ' ', trim((string)($newRow['owner_name'] ?? ($updatedReceipt['client_name'] ?? '')))) ?: null;
                    $desc = 'صرف كارتة - ' . $officeName;

                    $treasuryRepo->create([
                        'username'       => $username,
                        'type'           => 'deposit',
                        'effect'         => 'row_disbursement',
                        'account_type'   => 'cash',
                        'amount'         => $newCents,
                        'reference_type' => self::REF_TYPE_ROW_DISBURSEMENT,
                        'reference_id'   => $rowRefId,
                        'client_id'      => $newOfficeId,
                        'client_type'    => 'office',
                        'client_name'    => $officeName,
                        'receipt_number' => $receiptNumStr,
                        'date'           => $effectiveDate,
                        'applied_at'     => $now,
                        'description'    => $desc,
                        'note'           => $desc,
                        'is_reversed'    => 0,
                    ]);

                    $ledgerRepo->create([
                        'username'           => $username,
                        'vehicle_owner_id'   => $ownerId,
                        'vehicle_owner_name' => $ownerName,
                        'client_id'          => $newOfficeId,
                        'client_type'        => 'office',
                        'client_name'        => $officeName,
                        'type'               => 'OFFICE_DEPOSIT',
                        'effect'             => 'row_disbursement',
                        'amount'             => $newCents,
                        'reference_type'     => self::REF_TYPE_ROW_DISBURSEMENT,
                        'reference_id'       => $rowRefId,
                        'receipt_number'     => $receiptNumStr,
                        'date'               => $effectiveDate,
                        'applied_at'         => $now,
                        'note'               => $desc,
                        'is_reversed'        => 0,
                    ]);
                }
            }
        }

        // 2. Reconcile receipt-level payment movements
        $payStatus = self::getReceiptPaymentStatus($previousReceipt);
        $oldPaidCents = intval($previousReceipt['paid'] ?? 0);
        $oldOwnerId = trim((string)($previousReceipt['client_id'] ?? ''));
        $receiptRefId = strval($receiptId);

        if ($payStatus === 'paid' && $oldPaidCents < 0) {
            return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => 'تعارض في القيمة المدفوعة السابقة للإيصال'];
        }

        $payPairCheck = self::validateReceiptPaymentPair(
            $username,
            $receiptRefId,
            $payStatus,
            max(0, $oldPaidCents),
            $oldOwnerId,
            $treasuryRepo,
            $ledgerRepo
        );
        if (!$payPairCheck['valid']) {
            return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => $payPairCheck['message']];
        }

        if ($payStatus === 'paid') {
            $oldPostedPaidCents = !empty($payPairCheck['treasury']) ? intval($payPairCheck['treasury'][0]['amount']) : 0;
            $oldPostedOwnerId = !empty($payPairCheck['treasury']) ? strval($payPairCheck['treasury'][0]['client_id'] ?? '') : $oldOwnerId;
            $oldPostedDate = !empty($payPairCheck['treasury']) ? strval($payPairCheck['treasury'][0]['date'] ?? '') : '';

            $newPaidCents = intval($updatedReceipt['paid'] ?? 0);
            if ($newPaidCents < 0) {
                return [
                    'code'    => self::RESULT_NEGATIVE_AMOUNT,
                    'message' => 'لا يمكن حفظ إيصال مدفوع بقيمة مدفوعة سالبة',
                ];
            }
            $newOwnerInfo = self::resolveOwnerForReceipt($updatedReceipt, $username, $ownerRepo);
            if (!$newOwnerInfo && $newPaidCents > 0) {
                return [
                    'code'    => self::RESULT_INVALID,
                    'message' => 'صاحب المركبة المرتبط بالإيصال المدفوع غير موجود أو غير نشط',
                ];
            }
            $newOwnerId = $newOwnerInfo ? $newOwnerInfo['client_id'] : $oldPostedOwnerId;

            if ($newPaidCents !== $oldPostedPaidCents
                || ($newPaidCents > 0 && $newOwnerId !== $oldPostedOwnerId)
                || ($oldPostedPaidCents > 0 && $effectiveDate !== $oldPostedDate)
            ) {
                if ($oldPostedPaidCents > 0) {
                    $revT = $treasuryRepo->reverseByReferenceForUser($username, $receiptRefId, self::REF_TYPE_RECEIPT_PAYMENT);
                    $revL = $ledgerRepo->reverseByReferenceForUser($username, $receiptRefId, self::REF_TYPE_RECEIPT_PAYMENT);
                    if ($revT !== 1 || $revL !== 1) {
                        return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => 'فشل عكس حركة دفع الإيصال المعدل'];
                    }
                }
                if ($newPaidCents > 0 && $newOwnerInfo) {
                    $ownerName = $newOwnerInfo['name'];
                    if ($ownerName === '') {
                        return ['code' => self::RESULT_INVALID, 'message' => 'اسم صاحب المركبة مطلوب لتسجيل حركة الخزنة'];
                    }
                    $exactDesc = 'صرف كارتة - ' . $ownerName;

                    $treasuryRepo->create([
                        'username'       => $username,
                        'type'           => 'withdraw',
                        'effect'         => 'receipt_payout',
                        'account_type'   => 'cash',
                        'amount'         => $newPaidCents,
                        'reference_type' => self::REF_TYPE_RECEIPT_PAYMENT,
                        'reference_id'   => $receiptRefId,
                        'client_id'      => $newOwnerId,
                        'client_type'    => 'owner',
                        'client_name'    => $ownerName,
                        'receipt_number' => $receiptNumStr,
                        'date'           => $effectiveDate,
                        'applied_at'     => $now,
                        'description'    => $exactDesc,
                        'note'           => $exactDesc,
                        'is_reversed'    => 0,
                    ]);

                    $ledgerRepo->create([
                        'username'       => $username,
                        'client_id'      => $newOwnerId,
                        'client_type'    => 'owner',
                        'client_name'    => $ownerName,
                        'type'           => 'receipt_payment',
                        'effect'         => 'receipt_payout',
                        'amount'         => $newPaidCents,
                        'reference_type' => self::REF_TYPE_RECEIPT_PAYMENT,
                        'reference_id'   => $receiptRefId,
                        'receipt_number' => $receiptNumStr,
                        'date'           => $effectiveDate,
                        'applied_at'     => $now,
                        'note'           => $exactDesc,
                        'is_reversed'    => 0,
                    ]);
                }
            }
        }

        return ['code' => self::RESULT_OK];
    }

    /**
     * Validate and reverse all status-linked movements (`receipt_row_disbursement`
     * and `receipt_payment_status`) when a receipt is deleted inside an active transaction.
     *
     * @return array{code:string, message?:string}
     */
    public function reverseAllStatusMovementsOnReceiptDelete(
        int $receiptId,
        string $username,
        TreasuryRepo $treasuryRepo,
        VehicleLedgerRepository $ledgerRepo,
        OfficeRepository $officeRepo
    ): array {
        $lockStmt = $this->db->prepare(
            'SELECT * FROM receipts WHERE id = :id AND deleted_at IS NULL FOR UPDATE'
        );
        $lockStmt->execute([':id' => $receiptId]);
        $current = $lockStmt->fetch();

        if (!$current) {
            return ['code' => self::RESULT_NOT_FOUND, 'message' => 'الإيصال غير موجود'];
        }
        if (($current['username'] ?? '') !== $username) {
            return ['code' => self::RESULT_FORBIDDEN, 'message' => 'غير مسموح بحذف هذا الإيصال'];
        }
        if (!empty($current['is_archived'])) {
            return ['code' => self::RESULT_ARCHIVED, 'message' => 'الإيصال مؤرشف'];
        }

        $rows = self::normalizeReceiptRows($current['rows'] ?? [], $receiptId);
        $allOffices = $officeRepo->getAllByUsername($username);
        $knownRefIds = [];

        foreach ($rows as $idx => $row) {
            if (!is_array($row) || ($row['_type'] ?? '') === 'separator') continue;
            $rowId = self::getStableRowId($row, $receiptId, $idx);
            $rowRefId = self::buildRowDisbursementRefId($receiptId, $rowId);
            $knownRefIds[$rowRefId] = true;

            $status = self::getRowDisbursementStatus($row);
            $calc = VehicleLedgerRepository::calculateRowNetAndSarfCents($row);
            $rowCents = $calc['total_cents'];
            $office = VehicleLedgerRepository::resolveOfficeForRow($row, $allOffices);
            $officeIdStr = $office ? strval($office['id']) : '';

            $pairCheck = self::validateRowDisbursementPair(
                $username,
                $rowRefId,
                $status,
                max(0, $rowCents),
                $officeIdStr,
                $treasuryRepo,
                $ledgerRepo
            );
            if (!$pairCheck['valid']) {
                return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => $pairCheck['message']];
            }

            if (!empty($pairCheck['treasury'])) {
                $revT = $treasuryRepo->reverseByReferenceForUser($username, $rowRefId, self::REF_TYPE_ROW_DISBURSEMENT);
                $revL = $ledgerRepo->reverseByReferenceForUser($username, $rowRefId, self::REF_TYPE_ROW_DISBURSEMENT);
                if ($revT !== 1 || $revL !== 1) {
                    return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => 'فشل عكس حركة صرف الصف عند حذف الإيصال'];
                }
            }
        }

        // Check for any unexpected active row-disbursement entries under this receiptId prefix
        $prefix = $receiptId . ':%';
        $orphanTStmt = $this->db->prepare(
            'SELECT reference_id FROM treasury WHERE username = :u AND reference_type = :rt AND reference_id LIKE :pfx AND is_reversed = 0 AND deleted_at IS NULL FOR UPDATE'
        );
        $orphanTStmt->execute([':u' => $username, ':rt' => self::REF_TYPE_ROW_DISBURSEMENT, ':pfx' => $prefix]);
        if ($orphanTStmt->fetch()) {
            return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => 'توجد حركات خزنة نشطة غير متطابقة لصفوف هذا الإيصال'];
        }
        $orphanLStmt = $this->db->prepare(
            'SELECT reference_id FROM vehicle_ledger WHERE username = :u AND reference_type = :rt AND reference_id LIKE :pfx AND is_reversed = 0 AND deleted_at IS NULL FOR UPDATE'
        );
        $orphanLStmt->execute([':u' => $username, ':rt' => self::REF_TYPE_ROW_DISBURSEMENT, ':pfx' => $prefix]);
        if ($orphanLStmt->fetch()) {
            return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => 'توجد حركات دفتر نشطة غير متطابقة لصفوف هذا الإيصال'];
        }

        // Validate and reverse receipt-level payment movement
        $payStatus = self::getReceiptPaymentStatus($current);
        $paidCents = intval($current['paid'] ?? 0);
        $ownerIdStr = trim((string)($current['client_id'] ?? ''));
        $receiptRefId = strval($receiptId);

        $payPairCheck = self::validateReceiptPaymentPair(
            $username,
            $receiptRefId,
            $payStatus,
            max(0, $paidCents),
            $ownerIdStr,
            $treasuryRepo,
            $ledgerRepo
        );
        if (!$payPairCheck['valid']) {
            return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => $payPairCheck['message']];
        }

        if (!empty($payPairCheck['treasury'])) {
            $revT = $treasuryRepo->reverseByReferenceForUser($username, $receiptRefId, self::REF_TYPE_RECEIPT_PAYMENT);
            $revL = $ledgerRepo->reverseByReferenceForUser($username, $receiptRefId, self::REF_TYPE_RECEIPT_PAYMENT);
            if ($revT !== 1 || $revL !== 1) {
                return ['code' => self::RESULT_INCONSISTENT_LEDGER, 'message' => 'فشل عكس حركة دفع الإيصال عند الحذف'];
            }
        }

        return ['code' => self::RESULT_OK];
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
