<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleDetailsMovementRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('DELETE')) jsonMethodNotAllowed('DELETE');

$body = requireJsonBody();
$id = intval($body['id'] ?? 0);
if ($id <= 0) jsonError('المعرف مطلوب', 400);

try {
    $db = getDB();
    $repo = new VehicleDetailsMovementRepository($db);

    $existing = $repo->getById($id);
    if (!$existing) jsonError('السجل غير موجود', 404);
    if (($existing['username'] ?? '') !== $authUser['username']) jsonError('غير مسموح', 403);

    if (array_key_exists('owner_id', $body) && intval($body['owner_id']) > 0 && intval($body['owner_id']) !== (int) $existing['owner_id']) {
        jsonError('الحركة لا تتبع صاحب المركبة المحدد', 403);
    }

    $ownerCheck = $repo->validateEligibleOwner((int) $existing['owner_id'], $authUser['username']);
    if (!$ownerCheck['ok']) {
        jsonError($ownerCheck['message'], $ownerCheck['status']);
    }

    $repo->softDelete($id, $authUser['username']);
    bumpVersion($db, 'vehicle_details_movements');
    jsonSuccess(null, 'تم حذف الحركة بنجاح');
} catch (PDOException $e) {
    error_log('[VEHICLE DETAILS DELETE] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
