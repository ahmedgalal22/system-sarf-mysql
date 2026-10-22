<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../core/validator.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleOwnerRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';
if (!isMethod('POST')) jsonMethodNotAllowed('POST');
$body = requireJsonBody();
$name = validateRequired($body['name'] ?? null, 'الاسم');
try {
    $repo = new VehicleOwnerRepository(getDB());
    $record = $repo->create([
        'uuid'     => $body['uuid'] ?? $body['id'] ?? null,
        'username' => $authUser['username'],
        'name'     => $name,
        'phone'    => sanitizeString($body['phone'] ?? null) ?: null,
        'owner_type' => sanitizeString($body['owner_type'] ?? null) ?: 'owner',
        'notes'    => sanitizeString($body['notes'] ?? null) ?: null,
    ]);
    bumpVersion(getDB(), 'vehicle_owners');
    jsonSuccess($record, 'تم الإنشاء بنجاح', 201);
} catch (PDOException $e) { error_log('[OWNER CREATE] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
