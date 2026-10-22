<?php
/**
 * PUT /api/entities/vehicles/update.php
 *
 * Updates a vehicle with optimistic locking.
 * Returns 409 Conflict if updated_at mismatch.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../api/middleware/accountantOrAdmin.php';
require_once __DIR__ . '/../../../repositories/VehicleRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('PUT')) {
    jsonMethodNotAllowed('PUT');
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
        jsonError('غير مسموح بالتعديل', 403);
    }

    // Build patch from allowed fields
    $patch = [];
    foreach (['plate', 'owner_id', 'owner_name', 'driver_name', 'notes'] as $field) {
        if (array_key_exists($field, $body)) {
            $patch[$field] = sanitizeString($body[$field] ?? null) ?: null;
        }
    }
    if (isset($patch['plate']) && $patch['plate'] === '') {
        jsonError('رقم اللوحة مطلوب', 400);
    }

    // Optimistic locking
    $expectedUpdatedAt = $body['updated_at'] ?? null;
    $updated = $repo->update($id, $patch, $authUser['username'], $expectedUpdatedAt);

    if ($updated === null) {
        jsonError('تعارض — تم تعديل السجل من مستخدم آخر. أعد تحميل الصفحة.', 409);
    }

    bumpVersion(getDB(), 'vehicles');
    jsonSuccess($updated, 'تم تحديث المركبة بنجاح');

} catch (PDOException $e) {
    error_log('[VEHICLE UPDATE] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
