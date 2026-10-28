<?php
/**
 * POST /api/financial/treasury-entry.php
 *
 * Atomic: BEGIN → create treasury entry + optional ledger entry
 *         + advance allocation (salfa only) → COMMIT
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/TreasuryRepository2.php';
require_once __DIR__ . '/../../repositories/VehicleLedgerRepository.php';
require_once __DIR__ . '/../../repositories/ReceiptRepository.php';
require_once __DIR__ . '/../../core/versionTracker.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');

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
    if (array_key_exists('amount', $body) && $body['amount'] !== null && $body['amount'] !== '') {
        $body['amount'] = ReceiptRepository::validateFiniteIntCents($body['amount'], 'المبلغ (amount)', false);
    }
    if ($submittedEffect === 'salfa' && intval($body['amount'] ?? 0) <= 0) {
        jsonError('مبلغ السلفة يجب أن يكون قيمة صحيحة أكبر من صفر', 400);
    }
    if (!empty($body['ledger_op']) && is_array($body['ledger_op']) && array_key_exists('amount', $body['ledger_op'])) {
        $body['ledger_op']['amount'] = ReceiptRepository::validateFiniteIntCents($body['ledger_op']['amount'], 'مبلغ الدفتر (amount)', false);
    }
} catch (InvalidArgumentException $e) {
    jsonError($e->getMessage(), 400);
}

try {
    $db = getDB();
    $treasuryRepo = new TreasuryRepo($db);
    $ledgerRepo = new VehicleLedgerRepository($db);
    $receiptRepo = new ReceiptRepository($db);

    $db->beginTransaction();
    try {
        // 1. Advance allocation FIRST (lock hierarchy: receipts -> treasury -> vehicle_ledger):
        //    If this is a salfa for a client, lock the client's candidate receipts first,
        //    select the latest eligible unpaid receipt via isReceiptUnpaidForSalfa(),
        //    reduce 'paid', and store the target receipt ID in receipt_number.
        $advanceReceipt = null;
        $effect = $body['effect'] ?? '';
        $clientId = $body['client_id'] ?? null;
        if ($effect === 'salfa' && $clientId) {
            $candStmt = $db->prepare(
                'SELECT * FROM receipts
                 WHERE username = :u
                   AND client_id = :cid
                   AND deleted_at IS NULL
                   AND is_archived = 0
                 ORDER BY created_at DESC, id DESC
                 FOR UPDATE'
            );
            $candStmt->execute([':u' => $username, ':cid' => strval($clientId)]);
            $candidates = $candStmt->fetchAll();

            $target = null;
            foreach ($candidates as $cand) {
                $statusCheck = ReceiptRepository::inspectReceiptSalfaStatus($cand);
                if ($statusCheck['status'] === 'inconsistent') {
                    $db->rollBack();
                    jsonError($statusCheck['message'] ?? 'تعارض في حالة الإيصال المرتبط بالسلفة', 409);
                }
                if ($statusCheck['eligible']) {
                    $target = $cand;
                    break;
                }
            }

            if ($target) {
                $targetId = intval($target['id']);
                $advanceAmount = intval($body['amount'] ?? 0);
                $currentPaid = intval($target['paid'] ?? 0);
                $newPaid = max(0, $currentPaid - $advanceAmount);
                $receiptRepo->updateReceipt($targetId, [
                    'paid' => $newPaid,
                ], $username);
                $body['receipt_number'] = strval($targetId);
                $advanceReceipt = ['id' => $targetId, 'old_paid' => $currentPaid, 'new_paid' => $newPaid];
            }
        }

        // 2. Create treasury entry SECOND
        $body['username'] = $username;
        $treasuryEntry = $treasuryRepo->create($body);

        // 3. Optional: create linked ledger entry THIRD
        $ledgerEntry = null;
        if (!empty($body['ledger_op']) && is_array($body['ledger_op'])) {
            $body['ledger_op']['username'] = $username;
            $body['ledger_op']['reference_id'] = $body['ledger_op']['reference_id'] ?? $body['reference_id'] ?? null;
            $ledgerEntry = $ledgerRepo->create($body['ledger_op']);
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


