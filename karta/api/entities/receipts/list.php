<?php
/**
 * GET /api/entities/receipts/list.php
 *
 * Returns receipts for the authenticated user.
 * Deterministic ordering: created_at DESC, id DESC.
 * Supports filters: client_id, payout_status, from_date, to_date.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../core/permissions.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/ReceiptRepository.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');
requirePermission($authUser['role'], 'receipts', 'read');

try {
    $repo = new ReceiptRepository(getDB());

    $filters = [];
    foreach (['client_id', 'payout_status', 'from_date', 'to_date', 'receipt_number'] as $key) {
        $val = sanitizeString($_GET[$key] ?? null);
        if ($val !== '') $filters[$key] = $val;
    }

    $receipts = $repo->findAll($authUser['username'], $filters);

    // Decode and normalize receipt-level payment_status and JSON rows for each receipt
    foreach ($receipts as &$r) {
        ReceiptRepository::normalizeReceiptRecord($r);
    }
    unset($r);

    jsonSuccess($receipts);

} catch (PDOException $e) {
    error_log('[RECEIPTS LIST] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
