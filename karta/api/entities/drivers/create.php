<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../core/validator.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/DriverRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';
if (!isMethod('POST')) jsonMethodNotAllowed('POST');
$body = requireJsonBody();
$name = validateRequired($body['name'] ?? null, 'الاسم');
try {
    $repo = new DriverRepository(getDB());
    $record = $repo->create(['uuid' => $body['uuid'] ?? null, 'username' => $authUser['username'], 'name' => $name, 'phone' => sanitizeString($body['phone'] ?? null) ?: null, 'notes' => sanitizeString($body['notes'] ?? null) ?: null]);
    bumpVersion(getDB(), 'drivers');
    jsonSuccess($record, 'تم الإنشاء بنجاح', 201);
} catch (PDOException $e) { error_log('[DRIVER CREATE] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
