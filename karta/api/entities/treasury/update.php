<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/TreasuryRepository2.php';
if (!isMethod('PUT')) jsonMethodNotAllowed('PUT');
$body = requireJsonBody();
$id = intval($body['id'] ?? 0);
if ($id <= 0) jsonError('المعرف مطلوب', 400);
try {
    $repo = new TreasuryRepo(getDB());
    $existing = $repo->getById($id);
    if (!$existing) jsonError('السجل غير موجود', 404);
    if ($existing['username'] !== $authUser['username']) jsonError('غير مسموح', 403);
    if (!empty($existing['is_archived'])) jsonError('لا يمكن تعديل حركة خزنة مؤرشفة', 409);
    if (in_array($existing['reference_type'] ?? '', ['receipt_row_disbursement', 'receipt_payment_status', 'salfa'], true)
        || in_array($existing['effect'] ?? '', ['row_disbursement', 'receipt_payout', 'salfa'], true)
        || (($body['effect'] ?? '') === 'salfa')
    ) {
        jsonError('لا يمكن تعديل حركة سلفة أو حركة مرتبطة بحالة صرف أو دفع إيصال من هذا المسار مباشرة', 409);
    }
    $patch = [];
    foreach (['type','effect','account_type','amount','date','description','note','is_reversed','reversed_at','reversed_by','client_id','client_type','client_name'] as $f) {
        if (array_key_exists($f, $body)) $patch[$f] = $body[$f];
    }
    $updated = $repo->update($id, $patch, $authUser['username'], $body['updated_at'] ?? null);
    if ($updated === null) jsonError('تعارض — تم تعديل السجل', 409);
    jsonSuccess($updated, 'تم التحديث بنجاح');
} catch (PDOException $e) { error_log('[TREASURY UPDATE] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
