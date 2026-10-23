<?php
/**
 * POST /api/financial/receipt-status.php
 *
 * Pay:   BEGIN → update receipt + create ledger + create treasury → COMMIT
 * Unpay: BEGIN → reverse ledger + reverse treasury + update receipt → COMMIT
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
$rawRowId = $body['row_id'] ?? $body['rowId'] ?? null;
$rawStatus = $body['status'] ?? $body['disbursement_status'] ?? '';

if ($receiptId <= 0) jsonError('معرف الإيصال مطلوب', 400);

// If row_id is supplied, perform a row-level disbursement status update
// (completely separate from receipt financial calculations and ledger entries).
if ($rawRowId !== null) {
    $rowId = (is_string($rawRowId) || is_numeric($rawRowId)) ? trim((string)$rawRowId) : '';
    if ($rowId === '') jsonError('معرف الصف مطلوب', 400);
    $validatedRowStatus = ReceiptRepository::validateRowDisbursementStatus($rawStatus);
    if ($validatedRowStatus === null) {
        jsonError('حالة الصرف غير صالحة. القيم المسموحة: تم صرفه أو لم يتم صرفه', 400);
    }
    try {
        $db = getDB();
        $receiptRepo = new ReceiptRepository($db);
        $db->beginTransaction();
        try {
            $res = $receiptRepo->updateRowDisbursementStatus($receiptId, $rowId, $validatedRowStatus, $username);
            if ($res['code'] === ReceiptRepository::RESULT_NOT_FOUND) {
                $db->rollBack(); jsonError('الإيصال غير موجود', 404);
            }
            if ($res['code'] === ReceiptRepository::RESULT_FORBIDDEN) {
                $db->rollBack(); jsonError('غير مسموح', 403);
            }
            if ($res['code'] === ReceiptRepository::RESULT_ARCHIVED) {
                $db->rollBack(); mapResult('ARCHIVED');
            }
            if ($res['code'] === ReceiptRepository::RESULT_ROW_NOT_FOUND) {
                $db->rollBack(); jsonError('الصف المطلوب غير موجود في هذا الإيصال', 404);
            }
            if ($res['code'] !== ReceiptRepository::RESULT_OK) {
                $db->rollBack(); jsonError('فشل تحديث حالة الصف', 400);
            }
            bumpVersions($db, ['receipts']);
            $db->commit();
            jsonSuccess([
                'receipt' => $res['data'],
                'row'     => $res['row'],
                'row_id'  => $rowId,
                'status'  => $validatedRowStatus,
            ], 'تم تحديث حالة الصف بنجاح');
        } catch (Exception $e) {
            if ($db->inTransaction()) $db->rollBack();
            throw $e;
        }
    } catch (Exception $e) {
        error_log('[FINANCIAL RECEIPT-ROW-STATUS] ' . $e->getMessage());
        jsonError($e->getMessage(), 500);
    }
    exit;
}

$status = sanitizeString($rawStatus);
if (!in_array($status, ['paid', 'unpaid'])) jsonError('الحالة يجب أن تكون paid أو unpaid', 400);

try {
    $db = getDB();
    $receiptRepo = new ReceiptRepository($db);
    $treasuryRepo = new TreasuryRepo($db);
    $ledgerRepo = new VehicleLedgerRepository($db);

    $db->beginTransaction();
    try {
        // Row lock: prevent concurrent status changes on the same receipt
        $lockStmt = $db->prepare('SELECT id FROM receipts WHERE id = :id AND deleted_at IS NULL FOR UPDATE');
        $lockStmt->execute([':id' => $receiptId]);
        if (!$lockStmt->fetch()) { $db->rollBack(); jsonError('الإيصال غير موجود', 404); }

        $existing = $receiptRepo->findById($receiptId);
        if (!$existing) { $db->rollBack(); jsonError('الإيصال غير موجود', 404); }
        if ($existing['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }
        if ($existing['is_archived']) { $db->rollBack(); mapResult('ARCHIVED'); }

        $currentStatus = $existing['payout_status'] ?? 'unpaid';
        if ($currentStatus === $status) {
            $db->commit();
            decodeRowsField($existing);
            jsonSuccess(['receipt' => $existing, 'changed' => false]);
        }

        $now = nowEgypt();

        if ($status === 'paid') {
            // Create payment entries
            $paidAmount = intval($existing['paid'] ?? 0);

            if ($paidAmount > 0) {
                // Ledger: receipt_payment
                $ledgerRepo->create([
                    'username' => $username,
                    'client_id' => strval($existing['client_id']),
                    'client_type' => $existing['client_type'] ?? 'owner',
                    'client_name' => $existing['client_name'],
                    'type' => 'receipt_payment',
                    'amount' => $paidAmount,
                    'reference_type' => 'receipt',
                    'reference_id' => strval($receiptId),
                    'receipt_number' => $existing['receipt_number'],
                    'date' => todayEgypt(),
                    'applied_at' => $now,
                    'is_reversed' => 0,
                    'note' => 'صرف نموذج ' . ($existing['receipt_number'] ?? $receiptId),
                ]);

                // Treasury: withdraw (cash out)
                $treasuryRepo->create([
                    'username' => $username,
                    'type' => 'withdraw',
                    'effect' => 'receipt_payout',
                    'amount' => $paidAmount,
                    'account_type' => 'cash',
                    'reference_type' => 'receipt',
                    'reference_id' => strval($receiptId),
                    'receipt_number' => $existing['receipt_number'],
                    'client_id' => strval($existing['client_id']),
                    'client_type' => $existing['client_type'] ?? 'owner',
                    'client_name' => $existing['client_name'],
                    'date' => todayEgypt(),
                    'applied_at' => $now,
                    'is_reversed' => 0,
                    'note' => 'صرف نموذج ' . ($existing['receipt_number'] ?? $receiptId),
                ]);
            }

            // Update receipt status
            $receiptRepo->updateReceipt($receiptId, [
                'payout_status' => 'paid',
                'paid_at' => $now,
            ], $username);

        } else {
            // Unpay: reverse payment entries only (not receipt_due)
            // Find active payment ledger entries
            $ledgerEntries = $ledgerRepo->getByReference(strval($receiptId));
            foreach ($ledgerEntries as $entry) {
                if ($entry['reference_type'] !== 'receipt') continue;
                if ($entry['type'] !== 'receipt_payment') continue;
                if ($entry['is_reversed']) continue;
                $ledgerRepo->update($entry['id'], [
                    'is_reversed' => 1, 'reversed_at' => $now, 'reversed_by' => $username
                ], $username);
            }

            // Reverse treasury payout entries
            $treasuryEntries = $treasuryRepo->getByReference(strval($receiptId));
            foreach ($treasuryEntries as $entry) {
                if ($entry['reference_type'] !== 'receipt') continue;
                if ($entry['effect'] !== 'receipt_payout') continue;
                if ($entry['is_reversed']) continue;
                $treasuryRepo->update($entry['id'], [
                    'is_reversed' => 1, 'reversed_at' => $now, 'reversed_by' => $username
                ], $username);
            }

            // Update receipt status
            $receiptRepo->updateReceipt($receiptId, [
                'payout_status' => 'unpaid',
                'paid_at' => null,
            ], $username);
        }

        bumpVersions($db, ['receipts', 'vehicle_ledger', 'treasury']);
        $db->commit();
        $updated = $receiptRepo->findById($receiptId);
        decodeRowsField($updated);
        jsonSuccess(['receipt' => $updated, 'changed' => true]);

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL RECEIPT-STATUS] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
