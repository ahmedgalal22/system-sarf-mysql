<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/BolsaFormRepository.php';
if (!isMethod('POST')) jsonMethodNotAllowed('POST');
$body = requireJsonBody();
try {
    $repo = new BolsaFormRepository(getDB());
    $body['username'] = $authUser['username'];
    $record = $repo->create($body);
    jsonSuccess($record, 'تم الإنشاء بنجاح', 201);
} catch (PDOException $e) { error_log('[BOLSA CREATE] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
