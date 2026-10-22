<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleOwnerRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';
if (!isMethod('DELETE')) jsonMethodNotAllowed('DELETE');
$body = requireJsonBody();
$id = intval($body['id'] ?? 0); if ($id <= 0) jsonError('المعرف مطلوب', 400);
try {
    $repo = new VehicleOwnerRepository(getDB());
    $existing = $repo->getById($id);
    if (!$existing) jsonError('السجل غير موجود', 404);
    if ($existing['username'] !== $authUser['username']) jsonError('غير مسموح', 403);
    $repo->softDelete($id, $authUser['username']);
    bumpVersion(getDB(), 'vehicle_owners');
    jsonSuccess(['id' => $id], 'تم الحذف بنجاح');
} catch (PDOException $e) { error_log('[OWNER DELETE] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
