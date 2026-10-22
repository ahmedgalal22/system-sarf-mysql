<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/AgentRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';
if (!isMethod('PUT')) jsonMethodNotAllowed('PUT');
$body = requireJsonBody();
$id = intval($body['id'] ?? 0); if ($id <= 0) jsonError('المعرف مطلوب', 400);
try {
    $repo = new AgentRepository(getDB());
    $existing = $repo->getById($id);
    if (!$existing) jsonError('السجل غير موجود', 404);
    if ($existing['username'] !== $authUser['username']) jsonError('غير مسموح', 403);
    $patch = [];
    foreach (['name','phone','balance','notes'] as $f) {
        if (array_key_exists($f, $body)) $patch[$f] = $body[$f];
    }
    $updated = $repo->update($id, $patch, $authUser['username'], $body['updated_at'] ?? null);
    if ($updated === null) jsonError('تعارض — تم تعديل السجل', 409);
    bumpVersion(getDB(), 'agents');
    jsonSuccess($updated, 'تم التحديث بنجاح');
} catch (PDOException $e) { error_log('[AGENT UPDATE] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
