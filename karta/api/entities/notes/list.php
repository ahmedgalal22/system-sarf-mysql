<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/NoteRepository.php';
if (!isMethod('GET')) jsonMethodNotAllowed('GET');
try {
    $repo = new NoteRepository(getDB());
    jsonSuccess($repo->getAllByUsername($authUser['username']));
} catch (PDOException $e) { error_log('[NOTES LIST] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
