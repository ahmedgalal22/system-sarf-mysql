<?php
require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/HamolaRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';
if (!isMethod('POST')) jsonMethodNotAllowed('POST');
$body = requireJsonBody();
$officeId = intval($body['office_id'] ?? 0);
if ($officeId <= 0) jsonError('office_id مطلوب', 400);
$loading = preg_replace('/\s+/u', ' ', trim((string) sanitizeString($body['loading_place'] ?? null)));
$destination = preg_replace('/\s+/u', ' ', trim((string) sanitizeString($body['destination_place'] ?? null)));
$itemTypeRaw = sanitizeString($body['item_type'] ?? null);
$itemType = $itemTypeRaw !== '' ? preg_replace('/\s+/u', ' ', trim((string) $itemTypeRaw)) : null;
if ($loading === '' || $destination === '') jsonError('مكان التحميل والجهة مطلوبان', 400);
try {
    $db = getDB();
    $repo = new HamolaRepository($db);
    $existing = $repo->findExistingCombination($officeId, $authUser['username'], $loading, $destination, $itemType);
    if ($existing) {
        jsonSuccess($existing, 'المسار مسجل بالفعل');
    }
    $record = $repo->create([
        // UUID always generated server-side — never accepted from client
        'uuid'              => null,
        'office_id'         => $officeId,
        'username'          => $authUser['username'],
        'loading_place'     => $loading,
        'destination_place' => $destination,
        'nolon'             => floatval($body['nolon'] ?? 0),
        'office_amount'     => floatval($body['office_amount'] ?? 0),
        'item_type'         => $itemType ?: null,
        'price'             => floatval($body['price'] ?? 0),
    ]);
    bumpVersion($db, 'hamola_details');
    jsonSuccess($record, 'تم الإضافة بنجاح');
} catch (PDOException $e) {
    error_log('[HAMOLA CREATE] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
