<?php
require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/ArchiveRepository.php';
if (!isMethod('GET')) jsonMethodNotAllowed('GET');
$batchId = sanitizeString($_GET['id'] ?? $_GET['batch_id'] ?? '');
if (!$batchId) jsonError('معرف الأرشيف مطلوب', 400);
try {
    $repo = new ArchiveRepository(getDB());
    $batch = $repo->getBatchByUuid($batchId);
    if (!$batch) jsonError('الأرشيف غير موجود', 404);
    if ($batch['username'] !== $authUser['username']) jsonError('غير مسموح', 403);
    $batch['snapshot'] = $repo->getSnapshotByBatchUuid($batchId);
    jsonSuccess($batch);
} catch (Exception $e) { error_log('[ARCHIVE GET] ' . $e->getMessage()); jsonError($e->getMessage(), 500); }
