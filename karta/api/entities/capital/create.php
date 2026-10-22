<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/MainCapitalRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';
if (!isMethod('POST')) jsonMethodNotAllowed('POST');
$body = requireJsonBody();
try {
    $repo = new MainCapitalRepository(getDB());
    $body['username'] = $authUser['username'];
    $record = $repo->create($body);
    bumpVersion(getDB(), 'main_capital');
    jsonSuccess($record, 'تم الإنشاء بنجاح', 201);
} catch (PDOException $e) { error_log('[CAPITAL CREATE] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
