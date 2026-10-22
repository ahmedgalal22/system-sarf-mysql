<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleOwnerRepository.php';
if (!isMethod('GET')) jsonMethodNotAllowed('GET');
try {
    $repo = new VehicleOwnerRepository(getDB());
    $filters = [];
    $name = sanitizeString($_GET['name'] ?? null); if ($name !== '') $filters['name'] = $name;
    $ownerType = sanitizeString($_GET['owner_type'] ?? null); if ($ownerType !== '') $filters['owner_type'] = $ownerType;
    $data = empty($filters) ? $repo->getAllByUsername($authUser['username']) : $repo->findByFields($authUser['username'], $filters);
    jsonSuccess($data);
} catch (PDOException $e) { error_log('[OWNERS LIST] ' . $e->getMessage()); jsonError('خطأ في الخادم', 500); }
