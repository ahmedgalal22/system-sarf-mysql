<?php
/**
 * POST /api/financial/treasury-entry.php
 *
 * Atomic: BEGIN → create treasury entry + optional ledger entry
 *         + advance allocation (salfa only) → COMMIT
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../core/permissions.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/TreasuryRepository2.php';
require_once __DIR__ . '/../../repositories/VehicleLedgerRepository.php';
require_once __DIR__ . '/../../repositories/ReceiptRepository.php';
require_once __DIR__ . '/../../core/versionTracker.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');
requirePermission($authUser['role'], 'treasury', 'write');

$body = requireJsonBody();
$username = $authUser['username'];

$submittedRefType = $body['reference_type'] ?? '';
$submittedEffect  = $body['effect'] ?? '';
if (in_array($submittedRefType, [ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT, ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT], true)
    || in_array($submittedEffect, ['row_disbursement', 'receipt_payout'], true)
) {
    jsonError('لا يمكن إنشاء حركة خزنة مرتبطة بحالة صرف أو دفع إيصال من شاشة الخزنة مباشرة', 400);
}

try {
    $db = getDB();
    $treasuryRepo = new TreasuryRepo($db);
    $ledgerRepo = new VehicleLedgerRepository($db);
    $receiptRepo = new ReceiptRepository($db);

    $db->beginTransaction();
    try {
        // Create treasury entry
        $body['username'] = $username;
        $treasuryEntry = $treasuryRepo->create($body);

        // Optional: create linked ledger entry
        $ledgerEntry = null;
        if (!empty($body['ledger_op']) && is_array($body['ledger_op'])) {
            $body['ledger_op']['username'] = $username;
            $body['ledger_op']['reference_id'] = $body['ledger_op']['reference_id'] ?? $body['reference_id'] ?? null;
            $ledgerEntry = $ledgerRepo->create($body['ledger_op']);
        }

        // Advance allocation: if this is a salfa for a client,
        // reduce 'paid' on the latest unpaid receipt for that client.
        // Store the target receipt ID on the treasury entry so that
        // edit/delete can reverse the EXACT same receipt later.
        $advanceReceipt = null;
        $effect = $body['effect'] ?? '';
        $clientId = $body['client_id'] ?? null;
        if ($effect === 'salfa' && $clientId) {
            $unpaid = $receiptRepo->findAll($username, [
                'client_id' => $clientId,
                'payout_status' => 'unpaid',
            ]);
            // findAll returns ORDER BY created_at DESC → first = latest
            if (!empty($unpaid)) {
                $target = $unpaid[0];
                $targetId = intval($target['id']);
                $advanceAmount = intval($body['amount'] ?? 0);
                $currentPaid = intval($target['paid'] ?? 0);
                $newPaid = max(0, $currentPaid - $advanceAmount);
                $receiptRepo->updateReceipt($targetId, [
                    'paid' => $newPaid,
                ], $username);
                // Store target receipt ID on the treasury entry for future reversal
                $treasuryRepo->update(intval($treasuryEntry['id']), [
                    'receipt_number' => strval($targetId),
                ], $username);
                $advanceReceipt = ['id' => $targetId, 'old_paid' => $currentPaid, 'new_paid' => $newPaid];
            }
        }

        $bumps = ['treasury'];
        if ($ledgerEntry) $bumps[] = 'vehicle_ledger';
        if ($advanceReceipt) $bumps[] = 'receipts';
        bumpVersions($db, $bumps);
        $db->commit();
        jsonSuccess([
            'treasury' => $treasuryEntry,
            'ledger' => $ledgerEntry,
            'advance_receipt' => $advanceReceipt,
        ], 'تم الإنشاء بنجاح', 201);

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL TREASURY-ENTRY] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}


