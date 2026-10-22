<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/MainCapitalRepository.php';
if (!isMethod('GET')) jsonMethodNotAllowed('GET');
try {
    $repo = new MainCapitalRepository(getDB());
    jsonSuccess($repo->getAllByUsername($authUser['username']));
} catch (PDOException $e) { error_log('[CAPITAL LIST] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
