<?php
/**
 * POST /api/financial/office-deposit.php
 *
 * Atomic: BEGIN → read office → create ledger entry → COMMIT
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/OfficeRepository.php';
require_once __DIR__ . '/../../repositories/VehicleLedgerRepository.php';
require_once __DIR__ . '/../../core/versionTracker.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');

$body = requireJsonBody();
$username = $authUser['username'];

try {
    $db = getDB();
    $officeRepo = new OfficeRepository($db);
    $ledgerRepo = new VehicleLedgerRepository($db);

    $db->beginTransaction();
    try {
        // Verify office exists
        $officeId = intval($body['office_id'] ?? 0);
        if ($officeId <= 0) { $db->rollBack(); jsonError('معرف المكتب مطلوب', 400); }

        $office = $officeRepo->getById($officeId);
        if (!$office) { $db->rollBack(); jsonError('المكتب غير موجود', 404); }
        if ($office['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }

        // Create ledger entry
        $body['username'] = $username;
        $body['client_id'] = strval($officeId);
        $body['client_type'] = 'office';
        $body['client_name'] = $office['name'] ?? null;

        $entry = $ledgerRepo->create($body);

        bumpVersion($db, 'vehicle_ledger');
        $db->commit();
        jsonSuccess($entry, 'تم الإنشاء بنجاح', 201);

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL OFFICE-DEPOSIT] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
