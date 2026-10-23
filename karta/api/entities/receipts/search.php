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
 *   from_date       YYYY-MM-DD  Default: 89 days before today (Cairo).
 *   to_date         YYYY-MM-DD  Default: today (Cairo).
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
 * Response:
 *   { success, data[], meta: { total, returned, offset, limit, has_more, summary, options? } }
 *
 * Summary is ALWAYS computed across the FULL filtered dataset
 * BEFORE any LIMIT/OFFSET is applied.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../core/permissions.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/ReceiptRepository.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');
requirePermission($authUser['role'], 'receipts', 'read');

try {
    $repo = new ReceiptRepository(getDB());

    // ── Parse parameters ─────────────────────────────────────────────────

    // Date range defaults: 89 days ago → today (Cairo timezone)
    $today    = todayEgypt();
    $default89 = (new DateTime($today, new DateTimeZone('Africa/Cairo')))
                    ->modify('-89 days')
                    ->format('Y-m-d');

    $fromDate = sanitizeString($_GET['from_date'] ?? null);
    $toDate   = sanitizeString($_GET['to_date'] ?? null);
    if ($fromDate === '') $fromDate = $default89;
    if ($toDate === '')   $toDate   = $today;

    // Validate date formats (YYYY-MM-DD)
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $fromDate)) $fromDate = $default89;
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $toDate))   $toDate   = $today;

    // Multi-value array parameters
    $clientNames    = _sanitizeArray($_GET['client_name'] ?? []);
    $receiptNumbers = _sanitizeArray($_GET['receipt_number'] ?? []);
    $vehicles       = _sanitizeArray($_GET['vehicle'] ?? []);
    $kartas         = _sanitizeArray($_GET['karta'] ?? []);
    $types          = _sanitizeArray($_GET['type'] ?? []);

    // Single-value parameters
    $payoutStatus   = sanitizeString($_GET['payout_status'] ?? ($_GET['row_status'] ?? null));
    $paymentStatus  = sanitizeString($_GET['payment_status'] ?? ($_GET['row_payment_status'] ?? null));
    $sort           = sanitizeString($_GET['sort'] ?? null);
    $sortDir        = sanitizeString($_GET['sort_dir'] ?? null);
    $limit          = (int)($_GET['limit'] ?? 50);
    $offset         = (int)($_GET['offset'] ?? 0);
    $includeOptions = ($_GET['include_options'] ?? '0') === '1';

    // ── Call repository ──────────────────────────────────────────────────

    $params = [
        'from_date'       => $fromDate,
        'to_date'         => $toDate,
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
