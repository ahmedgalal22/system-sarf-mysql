<?php
/**
 * POST /api/entities/owner-account-details/create.php
 *
 * Appends a new memo row for the specified vehicle owner.
 * Generates entry_date and entry_time from a single server-side DateTimeImmutable
 * instance in the Africa/Cairo timezone.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/VehicleOwnerRepository.php';
require_once __DIR__ . '/../../../repositories/OwnerAccountDetailsRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('POST')) {
    jsonMethodNotAllowed('POST');
}

$body = requireJsonBody();

$rawOwnerId = $body['owner_id'] ?? null;
if ($rawOwnerId === null || is_bool($rawOwnerId) || is_array($rawOwnerId) || !preg_match('/^\d+$/', trim((string) $rawOwnerId))) {
    jsonError('معرف صاحب المركبة مطلوب', 400);
}
$ownerId = (int) trim((string) $rawOwnerId);
if ($ownerId <= 0) {
    jsonError('معرف صاحب المركبة غير صالح', 400);
}

$lehAmount   = OwnerAccountDetailsRepository::validateDecimalField($body['leh_amount']   ?? null, 'له');
$alayhAmount = OwnerAccountDetailsRepository::validateDecimalField($body['alayh_amount'] ?? null, 'عليه');

$rawNotes = $body['notes'] ?? null;
$notes = null;
if ($rawNotes !== null) {
    if (is_array($rawNotes) || is_object($rawNotes)) {
        jsonError('حقل الملاحظات غير صالح', 400);
    }
    $trimmedNotes = trim((string) $rawNotes);
    $notes = $trimmedNotes === '' ? null : $trimmedNotes;
}

try {
    $db = getDB();
    $ownerRepo = new VehicleOwnerRepository($db);
    $owner = $ownerRepo->getById($ownerId);

    if (!$owner || ($owner['deleted_at'] ?? null) !== null || ($owner['owner_type'] ?? 'owner') !== 'owner') {
        jsonError('صاحب المركبة غير موجود', 404);
    }
    if (($owner['username'] ?? '') !== $authUser['username']) {
        jsonError('غير مسموح بالإضافة لهذا الحساب', 403);
    }

    $nowCairo  = new DateTimeImmutable('now', new DateTimeZone('Africa/Cairo'));
    $entryDate = $nowCairo->format('Y-m-d');
    $entryTime = $nowCairo->format('H:i:s');

    $repo = new OwnerAccountDetailsRepository($db);
    $record = $repo->create([
        'owner_id'     => $ownerId,
        'username'     => $authUser['username'],
        'leh_amount'   => $lehAmount,
        'alayh_amount' => $alayhAmount,
        'notes'        => $notes,
        'entry_date'   => $entryDate,
        'entry_time'   => $entryTime,
    ]);

    bumpVersion($db, 'owner_account_details');
    jsonSuccess($record, 'تمت إضافة الصف بنجاح', 201);

} catch (PDOException $e) {
    error_log('[OWNER ACCOUNT DETAILS CREATE] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
