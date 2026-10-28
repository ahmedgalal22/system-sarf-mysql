<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/TreasuryRepository2.php';
if (!isMethod('DELETE')) jsonMethodNotAllowed('DELETE');
$body = requireJsonBody();
$id = intval($body['id'] ?? 0);
if ($id <= 0) jsonError('المعرف مطلوب', 400);
try {
    $repo = new TreasuryRepo(getDB());
    $existing = $repo->getById($id);
    if (!$existing) jsonError('السجل غير موجود', 404);
    if ($existing['username'] !== $authUser['username']) jsonError('غير مسموح', 403);
    if (!empty($existing['is_archived'])) jsonError('لا يمكن حذف حركة خزنة مؤرشفة', 409);
    if (in_array($existing['reference_type'] ?? '', ['receipt_row_disbursement', 'receipt_payment_status', 'salfa'], true)
        || in_array($existing['effect'] ?? '', ['row_disbursement', 'receipt_payout', 'salfa'], true)
    ) {
        jsonError('لا يمكن حذف حركة سلفة أو حركة مرتبطة بحالة صرف أو دفع إيصال من هذا المسار مباشرة', 409);
    }
    $repo->softDelete($id, $authUser['username']);
    jsonSuccess(['id' => $id], 'تم الحذف بنجاح');
} catch (PDOException $e) { error_log('[TREASURY DELETE] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
