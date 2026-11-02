<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleDetailsMovementRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');

$body = requireJsonBody();
$ownerId = intval($body['owner_id'] ?? 0);
if ($ownerId <= 0) jsonError('معرّف صاحب المركبة مطلوب', 400);

try {
    $db = getDB();
    $repo = new VehicleDetailsMovementRepository($db);

    $ownerCheck = $repo->validateEligibleOwner($ownerId, $authUser['username']);
    if (!$ownerCheck['ok']) {
        jsonError($ownerCheck['message'], $ownerCheck['status']);
    }

    $movementDate = $repo->validateIsoDate(isset($body['movement_date']) ? (string) $body['movement_date'] : null);
    if ($movementDate === null) {
        jsonError('تاريخ الحركة غير صالح', 400);
    }

    $movementTime = $repo->validateTime(isset($body['movement_time']) ? (string) $body['movement_time'] : null);
    if ($movementTime === null) {
        jsonError('وقت الحركة غير صالح', 400);
    }

    $lah   = $repo->validateAmount($body['lah'] ?? 0);
    $alayh = $repo->validateAmount($body['alayh'] ?? 0);
    if ($lah === null || $alayh === null) {
        jsonError('قيمة له وعليه يجب أن تكون رقماً صحيحاً أكبر من أو يساوي صفر', 400);
    }

    $notesRaw = sanitizeString($body['notes'] ?? null);
    $notes    = $notesRaw !== '' ? $notesRaw : null;

    $record = $repo->create([
        'uuid'          => null,
        'owner_id'      => $ownerId,
        'username'      => $authUser['username'],
        'movement_date' => $movementDate,
        'movement_time' => $movementTime,
        'lah'           => $lah,
        'alayh'         => $alayh,
        'notes'         => $notes,
    ]);

    bumpVersion($db, 'vehicle_details_movements');
    jsonSuccess($record, 'تم حفظ الحركة بنجاح');
} catch (PDOException $e) {
    error_log('[VEHICLE DETAILS CREATE] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
