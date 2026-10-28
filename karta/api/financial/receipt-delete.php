<?php
/**
 * POST /api/financial/receipt-delete.php
 *
 * Atomic: BEGIN → read receipt + reverse treasury + reverse ledger + soft-delete → COMMIT
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../core/errorMapper.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/ReceiptRepository.php';
require_once __DIR__ . '/../../repositories/TreasuryRepository2.php';
require_once __DIR__ . '/../../repositories/VehicleLedgerRepository.php';
require_once __DIR__ . '/../../repositories/OfficeRepository.php';
require_once __DIR__ . '/../../core/versionTracker.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');

$body = requireJsonBody();
$username = $authUser['username'];
$receiptId = intval($body['receipt_id'] ?? $body['id'] ?? 0);
if ($receiptId <= 0) jsonError('معرف الإيصال مطلوب', 400);

try {
    $db = getDB();
    $receiptRepo = new ReceiptRepository($db);
    $treasuryRepo = new TreasuryRepo($db);
    $ledgerRepo = new VehicleLedgerRepository($db);
    $officeRepo = new OfficeRepository($db);

    $db->beginTransaction();
    try {
        // 1. Lock receipt & validate/reverse all status-linked movements AND receipt-creation treasury entries
        $revStatus = $receiptRepo->reverseAllStatusMovementsOnReceiptDelete(
            $receiptId,
            $username,
            $treasuryRepo,
            $ledgerRepo,
            $officeRepo,
            true
        );
        if ($revStatus['code'] === ReceiptRepository::RESULT_NOT_FOUND) {
            $db->rollBack(); jsonError('الإيصال غير موجود', 404);
        }
        if ($revStatus['code'] === ReceiptRepository::RESULT_FORBIDDEN) {
            $db->rollBack(); jsonError('غير مسموح', 403);
        }
        if ($revStatus['code'] === ReceiptRepository::RESULT_ARCHIVED) {
            $db->rollBack(); mapResult('ARCHIVED');
        }
        if ($revStatus['code'] === ReceiptRepository::RESULT_INCONSISTENT_LEDGER) {
            $db->rollBack(); jsonError($revStatus['message'] ?? 'تعارض في القيود المالية للإيصال', 409);
        }
        if ($revStatus['code'] !== ReceiptRepository::RESULT_OK) {
            $db->rollBack(); jsonError($revStatus['message'] ?? 'فشل حذف الإيصال', 400);
        }

        // 2. Reverse all original receipt-creation vehicle_ledger entries
        $ledgerRepo->reverseByReferenceForUser($username, strval($receiptId), 'receipt');

        // 3. Soft-delete the receipt
        $result = $receiptRepo->softDelete($receiptId, $username);
        if ($result['code'] !== ReceiptRepository::RESULT_OK) {
            $db->rollBack();
            mapResult($result['code']);
        }

        bumpVersions($db, ['receipts', 'vehicle_ledger', 'treasury', 'offices', 'vehicle_owners']);
        $db->commit();
        jsonSuccess(['id' => $receiptId], 'تم حذف الإيصال بنجاح');

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL RECEIPT-DELETE] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
