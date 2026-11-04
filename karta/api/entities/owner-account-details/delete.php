<?php
/**
 * DELETE /api/entities/owner-account-details/delete.php
 *
 * Deletes a single memo row from owner_account_details.
 * Enforces authenticated session username and parent vehicle owner ownership.
 * Strictly isolated from all financial ledgers, balances, and generic notes.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleOwnerRepository.php';
require_once __DIR__ . '/../../../repositories/OwnerAccountDetailsRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('DELETE')) {
    jsonMethodNotAllowed('DELETE');
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

try {
    $db = getDB();
    $repo = new OwnerAccountDetailsRepository($db);

    $existing = $repo->getById($id);
    if (!$existing) {
        jsonError('السجل غير موجود', 404);
    }
    if (($existing['username'] ?? '') !== $authUser['username']) {
        jsonError('غير مسموح بالحذف', 403);
    }

    $ownerRepo = new VehicleOwnerRepository($db);
    $owner = $ownerRepo->getById((int) $existing['owner_id']);
    if (!$owner || ($owner['deleted_at'] ?? null) !== null || ($owner['owner_type'] ?? 'owner') !== 'owner') {
        jsonError('صاحب المركبة غير موجود', 404);
    }
    if (($owner['username'] ?? '') !== $authUser['username']) {
        jsonError('غير مسموح بالحذف', 403);
    }

    $deleted = $repo->delete($id, $authUser['username']);
    if (!$deleted) {
        jsonError('فشل حذف السجل', 500);
    }

    bumpVersion($db, 'owner_account_details');
    jsonSuccess(['id' => $id], 'تم حذف الصف بنجاح');

} catch (PDOException $e) {
    error_log('[OWNER ACCOUNT DETAILS DELETE] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
