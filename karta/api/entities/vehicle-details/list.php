<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleDetailsMovementRepository.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');

try {
    $db = getDB();
    $repo = new VehicleDetailsMovementRepository($db);

    $ownerId = intval($_GET['owner_id'] ?? 0);
    $fromRaw = sanitizeString($_GET['from_date'] ?? $_GET['from'] ?? null);
    $toRaw   = sanitizeString($_GET['to_date'] ?? $_GET['to'] ?? null);

    $filters = [];
    if ($fromRaw !== '') {
        $fromDate = $repo->validateIsoDate($fromRaw);
        if ($fromDate === null) jsonError('تنسيق تاريخ البداية غير صالح (YYYY-MM-DD)', 400);
        $filters['from_date'] = $fromDate;
    }
    if ($toRaw !== '') {
        $toDate = $repo->validateIsoDate($toRaw);
        if ($toDate === null) jsonError('تنسيق تاريخ النهاية غير صالح (YYYY-MM-DD)', 400);
        $filters['to_date'] = $toDate;
    }
    if (!empty($filters['from_date']) && !empty($filters['to_date']) && $filters['to_date'] < $filters['from_date']) {
        jsonError('تاريخ النهاية لا يمكن أن يكون أقدم من تاريخ البداية', 400);
    }

    if ($ownerId > 0) {
        $ownerCheck = $repo->validateEligibleOwner($ownerId, $authUser['username']);
        if (!$ownerCheck['ok']) {
            jsonError($ownerCheck['message'], $ownerCheck['status']);
        }
        $data = $repo->getByOwnerId($ownerId, $authUser['username'], $filters);
    } else {
        $data = $repo->getAllByUsername($authUser['username'], $filters);
    }

    jsonSuccess($data);
} catch (PDOException $e) {
    error_log('[VEHICLE DETAILS LIST] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
