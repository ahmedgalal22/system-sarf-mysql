<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/HamolaRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';
if (!isMethod('PUT')) jsonMethodNotAllowed('PUT');
$body = requireJsonBody();
$id = intval($body['id'] ?? 0);
if ($id <= 0) jsonError('المعرف مطلوب', 400);
try {
    $db = getDB();
    $repo = new HamolaRepository($db);
    $existing = $repo->getById($id);
    if (!$existing) jsonError('السجل غير موجود', 404);
    if ($existing['username'] !== $authUser['username']) jsonError('غير مسموح', 403);
    $patch = [];
    foreach (['loading_place', 'destination_place', 'nolon', 'office_amount', 'item_type', 'price'] as $f) {
        if (array_key_exists($f, $body)) $patch[$f] = $body[$f];
    }
    $updated = $repo->update($id, $patch, $authUser['username']);
    if (!$updated) jsonError('فشل التحديث', 500);
    bumpVersion($db, 'hamola_details');
    jsonSuccess($updated, 'تم التحديث بنجاح');
} catch (PDOException $e) {
    error_log('[HAMOLA UPDATE] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
