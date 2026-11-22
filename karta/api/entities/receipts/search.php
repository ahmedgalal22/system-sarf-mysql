<?php
/**
 * GET /api/entities/receipts/search.php
 *
 * Server-side search endpoint for the All Receipts page.
 * Supports multi-value filters, server-computed summary, and
 * optional distinct-value lists for multi-select popups.
 *
 * This is a NEW additive endpoint. list.php is NOT modified.
 *
 * Parameters (all optional, via GET):
 *   limit           int       Default 50. 0 = no limit. Max 10000.
 *   offset          int       Default 0.
 *   from_date       YYYY-MM-DD  Inclusive lower bound on receipt_date.
 *   to_date         YYYY-MM-DD  Inclusive upper bound on receipt_date.
 *   client_name[]   string[]  Multi-value: match ANY.
 *   receipt_number[] string[] Multi-value: match ANY.
 *   vehicle[]       string[]  Multi-value: match ANY (searches rows JSON).
 *   karta[]         string[]  Multi-value: match ANY (searches rows JSON).
 *   type[]          string[]  Multi-value: match ANY (searches rows JSON).
 *   payout_status   string    Single value: paid, unpaid, partial, cancelled.
 *   sort            string    created_at, receipt_date, paid_at, receipt_number.
 *   sort_dir        string    asc or desc.
 *   include_options  1/0      If 1, response includes meta.options.
 *
 * Each date is independent: omitted or blank means no bound on that side.
 * Non-string or invalid calendar dates return HTTP 400. Two valid bounds
 * are applied as given (an inverted range is not swapped).
 *
 * Response:
 *   { success, data[], meta: { total, returned, offset, limit, has_more, summary, options? } }
 *
 * Summary is ALWAYS computed across the FULL filtered dataset
 * BEFORE any LIMIT/OFFSET is applied.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../core/allFormsSearchDates.php';
require_once __DIR__ . '/../../../repositories/ReceiptRepository.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');

try {
    $dates = parseAllFormsSearchDates($_GET);
} catch (InvalidArgumentException $e) {
    jsonError($e->getMessage(), 400);
}

try {
    // Multi-value array parameters
    $clientNames    = _sanitizeArray($_GET['client_name'] ?? []);
    $receiptNumbers = _sanitizeArray($_GET['receipt_number'] ?? []);
    $vehicles       = _sanitizeArray($_GET['vehicle'] ?? []);
    $kartas         = _sanitizeArray($_GET['karta'] ?? []);
    $types          = _sanitizeArray($_GET['type'] ?? []);

    // Single-value parameters
    $payoutStatus   = sanitizeString($_GET['payout_status'] ?? ($_GET['row_status'] ?? null));
    $paymentStatus  = sanitizeString($_GET['payment_status'] ?? null);
    $sort           = sanitizeString($_GET['sort'] ?? null);
    $sortDir        = sanitizeString($_GET['sort_dir'] ?? null);
    $limit          = (int)($_GET['limit'] ?? 50);
    $offset         = (int)($_GET['offset'] ?? 0);
    $includeOptions = ($_GET['include_options'] ?? '0') === '1';

    // ── Call repository ──────────────────────────────────────────────────

    $params = [
        'from_date'       => $dates['from_date'],
        'to_date'         => $dates['to_date'],
        'client_name'     => $clientNames,
        'receipt_number'  => $receiptNumbers,
        'vehicle'         => $vehicles,
        'karta'           => $kartas,
        'type'            => $types,
        'payout_status'   => $payoutStatus,
        'payment_status'  => $paymentStatus,
        'sort'            => $sort ?: 'created_at',
        'sort_dir'        => $sortDir ?: 'desc',
        'limit'           => $limit,
        'offset'          => $offset,
        'include_options' => $includeOptions,
    ];

    $repo = new ReceiptRepository(getDB());
    $result = $repo->search($authUser['username'], $params);

    // ── Build response ───────────────────────────────────────────────────

    $records  = $result['records'];
    $total    = $result['total'];
    $returned = count($records);

    $meta = [
        'total'    => $total,
        'returned' => $returned,
        'offset'   => $offset,
        'limit'    => $limit,
        'has_more' => ($limit > 0) && (($offset + $returned) < $total),
        'summary'  => $result['summary'],
    ];

    if (isset($result['options'])) {
        $meta['options'] = $result['options'];
    }

    jsonSuccess($records, 'OK', 200, $meta);

} catch (PDOException $e) {
    error_log('[RECEIPTS SEARCH] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}

// ── Helper ────────────────────────────────────────────────────────────────────

/**
 * Sanitize an array of strings from GET parameters.
 * PHP parses `param[]=a&param[]=b` into an array automatically.
 * This function ensures we have an array of clean non-empty strings.
 */
function _sanitizeArray($input): array {
    if (!is_array($input)) {
        $val = sanitizeString((string)$input);
        return $val !== '' ? [$val] : [];
    }
    $result = [];
    foreach ($input as $item) {
        $val = sanitizeString((string)$item);
        if ($val !== '') $result[] = $val;
    }
    return $result;
}
