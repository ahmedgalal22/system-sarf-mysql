<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleDetailsMovementRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('PUT')) jsonMethodNotAllowed('PUT');

$body = requireJsonBody();
$id = intval($body['id'] ?? 0);
if ($id <= 0) jsonError('المعرف مطلوب', 400);

try {
    $db = getDB();
    $repo = new VehicleDetailsMovementRepository($db);

    $existing = $repo->getById($id);
    if (!$existing) jsonError('السجل غير موجود', 404);
    if (($existing['username'] ?? '') !== $authUser['username']) jsonError('غير مسموح', 403);

    if (array_key_exists('owner_id', $body) && intval($body['owner_id']) > 0 && intval($body['owner_id']) !== (int) $existing['owner_id']) {
        jsonError('الحركة لا تتبع صاحب المركبة المحدد', 403);
    }

    $ownerCheck = $repo->validateEligibleOwner((int) $existing['owner_id'], $authUser['username']);
    if (!$ownerCheck['ok']) {
        jsonError($ownerCheck['message'], $ownerCheck['status']);
    }

    $patch = [];
    if (array_key_exists('lah', $body)) {
        $lah = $repo->validateAmount($body['lah']);
        if ($lah === null) jsonError('قيمة له وعليه يجب أن تكون رقماً صحيحاً أكبر من أو يساوي صفر', 400);
        $patch['lah'] = $lah;
    }
    if (array_key_exists('alayh', $body)) {
        $alayh = $repo->validateAmount($body['alayh']);
        if ($alayh === null) jsonError('قيمة له وعليه يجب أن تكون رقماً صحيحاً أكبر من أو يساوي صفر', 400);
        $patch['alayh'] = $alayh;
    }
    if (array_key_exists('notes', $body)) {
        $notesRaw = sanitizeString($body['notes'] ?? null);
        $patch['notes'] = $notesRaw !== '' ? $notesRaw : null;
    }

    $updated = $repo->update($id, $patch, $authUser['username']);
    if (!$updated) jsonError('فشل التحديث', 500);

    bumpVersion($db, 'vehicle_details_movements');
    jsonSuccess($updated, 'تم تحديث الحركة بنجاح');
} catch (PDOException $e) {
    error_log('[VEHICLE DETAILS UPDATE] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
