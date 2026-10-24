<?php
/**
 * POST /api/financial/treasury-delete.php
 *
 * Atomic: BEGIN → reverse treasury + reverse linked ledger
 *         + reverse advance allocation (salfa only) → COMMIT
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../core/permissions.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/TreasuryRepository2.php';
require_once __DIR__ . '/../../repositories/VehicleLedgerRepository.php';
require_once __DIR__ . '/../../repositories/ReceiptRepository.php';
require_once __DIR__ . '/../../core/versionTracker.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');
requirePermission($authUser['role'], 'treasury', 'delete');

$body = requireJsonBody();
$username = $authUser['username'];
$id = intval($body['id'] ?? 0);
if ($id <= 0) jsonError('المعرف مطلوب', 400);

try {
    $db = getDB();
    $treasuryRepo = new TreasuryRepo($db);
    $ledgerRepo = new VehicleLedgerRepository($db);
    $receiptRepo = new ReceiptRepository($db);

    $db->beginTransaction();
    try {
        // Row lock: prevent concurrent deletes/edits on the same treasury entry
        $lockStmt = $db->prepare('SELECT id FROM treasury WHERE id = :id AND deleted_at IS NULL FOR UPDATE');
        $lockStmt->execute([':id' => $id]);
        if (!$lockStmt->fetch()) { $db->rollBack(); jsonError('السجل غير موجود', 404); }

        $existing = $treasuryRepo->getById($id);
        if (!$existing) { $db->rollBack(); jsonError('السجل غير موجود', 404); }
        if ($existing['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }
        if (!empty($existing['is_archived'])) {
            $db->rollBack();
            jsonError('لا يمكن حذف حركة خزنة مؤرشفة', 409);
        }
        if (in_array($existing['reference_type'] ?? '', [ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT, ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT], true)
            || in_array($existing['effect'] ?? '', ['row_disbursement', 'receipt_payout'], true)
        ) {
            $db->rollBack();
            jsonError('لا يمكن حذف حركة خزنة مرتبطة بحالة صرف أو دفع إيصال من شاشة الخزنة مباشرة', 409);
        }

        // Reverse the treasury entry
        $treasuryRepo->update($id, [
            'is_reversed' => 1,
            'reversed_at' => nowEgypt(),
            'reversed_by' => $username,
        ], $username);

        // Reverse linked ledger entries
        $isSalfaWithClient = ($existing['effect'] ?? '') === 'salfa' && !empty($existing['reference_id']) && !empty($existing['client_id']);
        if ($isSalfaWithClient) {
            $ledgerRepo->reverseByReference($existing['reference_id'], $existing['reference_type'] ?? 'salfa', $username);
        }

        // Reverse advance allocation: restore 'paid' on the ORIGINAL receipt
        // that was affected when this salfa was created (stored in receipt_number).
        $advanceReceipt = null;
        if ($isSalfaWithClient) {
            $targetReceiptId = $existing['receipt_number'] ?? null;
            if ($targetReceiptId) {
                $target = $receiptRepo->findById(intval($targetReceiptId));
                if ($target && $target['deleted_at'] === null && ($target['payout_status'] ?? '') !== 'paid') {
                    $advanceAmount = intval($existing['amount'] ?? 0);
                    $currentPaid = intval($target['paid'] ?? 0);
                    $netTotal = intval($target['net_total'] ?? 0);
                    // Restore: add back the advance, but never exceed net_total
                    $newPaid = min($netTotal, $currentPaid + $advanceAmount);
                    $receiptRepo->updateReceipt(intval($target['id']), [
                        'paid' => $newPaid,
                    ], $username);
                    $advanceReceipt = ['id' => $target['id'], 'old_paid' => $currentPaid, 'new_paid' => $newPaid];
                }
            }
        }

        $bumps = ['treasury'];
        if ($isSalfaWithClient) $bumps[] = 'vehicle_ledger';
        if ($advanceReceipt) $bumps[] = 'receipts';
        bumpVersions($db, $bumps);
        $db->commit();
        jsonSuccess(['id' => $id], 'تم الحذف بنجاح');

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL TREASURY-DELETE] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}


