<?php
/**
 * PUT /api/entities/owner-account-details/update.php
 *
 * Updates only leh_amount, alayh_amount, and notes for an existing memo row.
 * Never modifies entry_date, entry_time, created_at, or owner_id.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleOwnerRepository.php';
require_once __DIR__ . '/../../../repositories/OwnerAccountDetailsRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('PUT')) {
    jsonMethodNotAllowed('PUT');
}

$body = requireJsonBody();

$rawId = $body['id'] ?? null;
if ($rawId === null || is_bool($rawId) || is_array($rawId) || !preg_match('/^\d+$/', trim((string) $rawId))) {
    jsonError('معرف الصف مطلوب', 400);
}
$id = (int) trim((string) $rawId);
if ($id <= 0) {
    jsonError('معرف الصف غير صالح', 400);
}

$patch = [];
if (array_key_exists('leh_amount', $body)) {
    $patch['leh_amount'] = OwnerAccountDetailsRepository::validateDecimalField($body['leh_amount'], 'له');
}
if (array_key_exists('alayh_amount', $body)) {
    $patch['alayh_amount'] = OwnerAccountDetailsRepository::validateDecimalField($body['alayh_amount'], 'عليه');
}
if (array_key_exists('notes', $body)) {
    $rawNotes = $body['notes'];
    if ($rawNotes === null) {
        $patch['notes'] = null;
    } elseif (is_array($rawNotes) || is_object($rawNotes)) {
        jsonError('حقل الملاحظات غير صالح', 400);
    } else {
        $trimmed = trim((string) $rawNotes);
        $patch['notes'] = $trimmed === '' ? null : $trimmed;
    }
}

try {
    $db = getDB();
    $repo = new OwnerAccountDetailsRepository($db);

    $existing = $repo->getById($id);
    if (!$existing) {
        jsonError('السجل غير موجود', 404);
    }
    if (($existing['username'] ?? '') !== $authUser['username']) {
        jsonError('غير مسموح بالتعديل', 403);
    }

    $ownerRepo = new VehicleOwnerRepository($db);
    $owner = $ownerRepo->getById((int) $existing['owner_id']);
    if (!$owner || ($owner['deleted_at'] ?? null) !== null || ($owner['owner_type'] ?? 'owner') !== 'owner') {
        jsonError('صاحب المركبة غير موجود', 404);
    }
    if (($owner['username'] ?? '') !== $authUser['username']) {
        jsonError('غير مسموح بالتعديل', 403);
    }

    $updated = $repo->update($id, $patch, $authUser['username']);
    if (!$updated) {
        jsonError('فشل تحديث السجل', 500);
    }

    bumpVersion($db, 'owner_account_details');
    jsonSuccess($updated, 'تم حفظ التعديلات بنجاح');

} catch (PDOException $e) {
    error_log('[OWNER ACCOUNT DETAILS UPDATE] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
