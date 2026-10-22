<?php
/**
 * POST /api/entities/vehicles/create.php
 *
 * Creates a new vehicle with validation and duplicate prevention.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../core/validator.php';
require_once __DIR__ . '/../../../core/permissions.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('POST')) {
    jsonMethodNotAllowed('POST');
}

requirePermission($authUser['role'], 'vehicles', 'write');

$body = requireJsonBody();

// ── Validation ────────────────────────────────────────────────────────────────
$plate = validateRequired($body['plate'] ?? null, 'رقم اللوحة');

// Normalize plate
$plate = mb_strtoupper(trim($plate));
if (mb_strlen($plate) < 2) {
    jsonError('رقم اللوحة قصير جداً', 400);
}

try {
    $repo = new VehicleRepository(getDB());

    // Duplicate prevention — check if plate already exists for this user
    $existing = $repo->findByPlate($plate);
    $userExisting = array_filter($existing, fn($v) => $v['username'] === $authUser['username']);
    if (!empty($userExisting)) {
        jsonError('رقم اللوحة مسجل بالفعل', 400, ['duplicate_plate']);
    }

    $vehicle = $repo->create([
        'plate'       => $plate,
        'owner_id'    => sanitizeString($body['owner_id'] ?? null) ?: null,
        'owner_name'  => sanitizeString($body['owner_name'] ?? null) ?: null,
        'driver_name' => sanitizeString($body['driver_name'] ?? null) ?: null,
        'notes'       => sanitizeString($body['notes'] ?? null) ?: null,
        'username'    => $authUser['username'],
    ]);

    bumpVersion(getDB(), 'vehicles');
    jsonSuccess($vehicle, 'تم إنشاء المركبة بنجاح', 201);

} catch (PDOException $e) {
    error_log('[VEHICLE CREATE] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
