<?php
/**
 * DELETE /api/entities/vehicles/delete.php
 *
 * Soft-deletes a vehicle.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('DELETE')) {
    jsonMethodNotAllowed('DELETE');
}

$body = requireJsonBody();

$id = intval($body['id'] ?? 0);
if ($id <= 0) {
    jsonError('معرف المركبة مطلوب', 400);
}

try {
    $repo = new VehicleRepository(getDB());

    // Check existence and ownership
    $existing = $repo->getById($id);
    if (!$existing) {
        jsonError('المركبة غير موجودة', 404);
    }
    if ($existing['username'] !== $authUser['username']) {
        jsonError('غير مسموح بالحذف', 403);
    }

    $deleted = $repo->softDelete($id, $authUser['username']);

    if (!$deleted) {
        jsonError('فشل حذف المركبة', 500);
    }

    bumpVersion(getDB(), 'vehicles');
    jsonSuccess(['id' => $id], 'تم حذف المركبة بنجاح');

} catch (PDOException $e) {
    error_log('[VEHICLE DELETE] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
