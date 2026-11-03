<?php
/**
 * GET /api/entities/owner-account-details/list.php
 *
 * Returns all memo rows for the specified vehicle owner belonging to the authenticated user.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleOwnerRepository.php';
require_once __DIR__ . '/../../../repositories/OwnerAccountDetailsRepository.php';

if (!isMethod('GET')) {
    jsonMethodNotAllowed('GET');
}

$rawOwnerId = $_GET['owner_id'] ?? null;
if ($rawOwnerId === null || !preg_match('/^\d+$/', trim((string) $rawOwnerId))) {
    jsonError('معرف صاحب المركبة مطلوب', 400);
}
$ownerId = (int) trim((string) $rawOwnerId);
if ($ownerId <= 0) {
    jsonError('معرف صاحب المركبة غير صالح', 400);
}

try {
    $db = getDB();
    $ownerRepo = new VehicleOwnerRepository($db);
    $owner = $ownerRepo->getById($ownerId);

    if (!$owner || ($owner['deleted_at'] ?? null) !== null || ($owner['owner_type'] ?? 'owner') !== 'owner') {
        jsonError('صاحب المركبة غير موجود', 404);
    }
    if (($owner['username'] ?? '') !== $authUser['username']) {
        jsonError('غير مسموح بالوصول', 403);
    }

    $repo = new OwnerAccountDetailsRepository($db);
    $rows = $repo->getByOwnerId($ownerId, $authUser['username']);
    jsonSuccess($rows);

} catch (PDOException $e) {
    error_log('[OWNER ACCOUNT DETAILS LIST] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
