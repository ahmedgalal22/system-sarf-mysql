<?php
require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/ArchiveRepository.php';
require_once __DIR__ . '/../../core/versionTracker.php';
if (!isMethod('POST')) jsonMethodNotAllowed('POST');
$body = requireJsonBody();
$batchId = sanitizeString($body['batch_id'] ?? '');
if (!$batchId) jsonError('معرف الأرشيف مطلوب', 400);
try {
    $db = getDB();
    $repo = new ArchiveRepository($db);
    $batch = $repo->getBatchByUuid($batchId);
    if (!$batch) jsonError('الأرشيف غير موجود', 404);
    if ($batch['username'] !== $authUser['username']) jsonError('غير مسموح', 403);
    $repo->softDeleteBatch($batch['id']);
    bumpVersion($db, 'archive_batches');
    jsonSuccess(['batch_id' => $batchId], 'تم حذف الأرشيف');
} catch (Exception $e) { error_log('[ARCHIVE DELETE] ' . $e->getMessage()); jsonError($e->getMessage(), 500); }
