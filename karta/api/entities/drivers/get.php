<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/DriverRepository.php';
if (!isMethod('GET')) jsonMethodNotAllowed('GET');
$id = intval($_GET['id'] ?? 0);
if ($id <= 0) jsonError('المعرف مطلوب', 400);
try {
    $repo = new DriverRepository(getDB());
    $record = $repo->getById($id);
    if (!$record) jsonError('السجل غير موجود', 404);
    if ($record['username'] !== $authUser['username']) jsonError('غير مسموح', 403);
    jsonSuccess($record);
} catch (PDOException $e) { error_log('[DRIVER GET] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
