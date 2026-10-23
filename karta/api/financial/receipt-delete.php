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

    $db->beginTransaction();
    try {
        // 0. Read receipt
        $existing = $receiptRepo->findById($receiptId);
        if (!$existing) { $db->rollBack(); jsonError('الإيصال غير موجود', 404); }
        if ($existing['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }

        // 1. Reverse all linked financial entries
        $treasuryRepo->reverseByReference(strval($receiptId), 'receipt', $username);
        $ledgerRepo->reverseByReference(strval($receiptId), 'receipt', $username);

        // 2. Soft-delete the receipt
        $result = $receiptRepo->softDelete($receiptId, $username);
        if ($result['code'] !== ReceiptRepository::RESULT_OK) {
            $db->rollBack();
            mapResult($result['code']);
        }

        bumpVersions($db, ['receipts', 'vehicle_ledger', 'treasury', 'offices']);
        $db->commit();
        jsonSuccess(['id' => $receiptId], 'تم حذف الإيصال بنجاح');

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL RECEIPT-DELETE] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
