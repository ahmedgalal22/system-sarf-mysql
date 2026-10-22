<?php
/**
 * GET /api/entities/vehicles/list.php
 *
 * Returns all vehicles for the authenticated user.
 * Supports filtering by: plate, owner_id
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../api/middleware/accountantOrAdmin.php';
require_once __DIR__ . '/../../../repositories/VehicleRepository.php';

if (!isMethod('GET')) {
    jsonMethodNotAllowed('GET');
}

try {
    $repo = new VehicleRepository(getDB());
    $vehicles = $repo->getAllByUsername($authUser['username']);

    // Optional filters
    $plate = sanitizeString($_GET['plate'] ?? null);
    if ($plate !== '') {
        $vehicles = array_values(array_filter($vehicles, function($v) use ($plate) {
            return $v['plate'] === $plate;
        }));
    }

    $ownerId = sanitizeString($_GET['owner_id'] ?? null);
    if ($ownerId !== '') {
        $vehicles = array_values(array_filter($vehicles, function($v) use ($ownerId) {
            return ($v['owner_id'] ?? '') === $ownerId;
        }));
    }

    jsonSuccess($vehicles);

} catch (PDOException $e) {
    error_log('[VEHICLES LIST] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
