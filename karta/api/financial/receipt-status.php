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
require_once __DIR__ . '/../../repositories/OfficeRepository.php';
require_once __DIR__ . '/../../repositories/VehicleOwnerRepository.php';
require_once __DIR__ . '/../../core/versionTracker.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');

$body = requireJsonBody();
$username = $authUser['username'];
$receiptId = intval($body['receipt_id'] ?? $body['id'] ?? 0);
$rawRowId = $body['row_id'] ?? $body['rowId'] ?? null;
$rawStatus = $body['status'] ?? $body['disbursement_status'] ?? '';

if ($receiptId <= 0) jsonError('معرف الإيصال مطلوب', 400);

$isPaymentUpdate = array_key_exists('payment_status', $body)
    || array_key_exists('paymentStatus', $body)
    || (($body['field'] ?? $body['status_type'] ?? '') === 'payment_status');

// 1. Receipt-level payment status update ('paid' / 'تم دفعه' or 'unpaid' / 'لم يتم دفعه').
// Applies to the entire receipt (never to individual rows) and atomically posts/reverses
// the paired treasury withdrawal ('صرف كارتة - {ownerName}') and vehicle owner ledger movement.
if ($isPaymentUpdate) {
    if ($rawRowId !== null) {
        jsonError('حالة الدفع تطبق على الإيصال بالكامل ولا تقبل معرف صف', 400);
    }
    $rawPaymentStatus = $body['payment_status'] ?? $body['paymentStatus'] ?? $body['status'] ?? null;
    $validatedPaymentStatus = ReceiptRepository::validateReceiptPaymentStatus($rawPaymentStatus);
    if ($validatedPaymentStatus === null) {
        jsonError('حالة الدفع غير صالحة. القيم المسموحة: تم دفعه أو لم يتم دفعه', 400);
    }
    try {
        $db = getDB();
        $receiptRepo = new ReceiptRepository($db);
        $treasuryRepo = new TreasuryRepo($db);
        $ledgerRepo = new VehicleLedgerRepository($db);
        $ownerRepo = new VehicleOwnerRepository($db);

        $db->beginTransaction();
        try {
            $res = $receiptRepo->transitionReceiptPaymentStatus(
                $receiptId,
                $validatedPaymentStatus,
                $username,
                $treasuryRepo,
                $ledgerRepo,
                $ownerRepo
            );
            if ($res['code'] === ReceiptRepository::RESULT_NOT_FOUND) {
                $db->rollBack(); jsonError($res['message'] ?? 'الإيصال غير موجود', 404);
            }
            if ($res['code'] === ReceiptRepository::RESULT_FORBIDDEN) {
                $db->rollBack(); jsonError($res['message'] ?? 'غير مسموح', 403);
            }
            if ($res['code'] === ReceiptRepository::RESULT_ARCHIVED) {
                $db->rollBack(); mapResult('ARCHIVED');
            }
            if (in_array($res['code'], [
                ReceiptRepository::RESULT_NEGATIVE_AMOUNT,
                ReceiptRepository::RESULT_INVALID,
                ReceiptRepository::RESULT_DUPLICATE_ROW_ID,
            ], true)) {
                $db->rollBack(); jsonError($res['message'] ?? 'فشل تحديث حالة الدفع للإيصال', 400);
            }
            if ($res['code'] === ReceiptRepository::RESULT_INCONSISTENT_LEDGER) {
                $db->rollBack(); jsonError($res['message'] ?? 'تعارض في القيود المالية لحركة دفع الإيصال', 409);
            }
            if ($res['code'] !== ReceiptRepository::RESULT_OK) {
                $db->rollBack(); jsonError($res['message'] ?? 'فشل تحديث حالة الدفع للإيصال', 400);
            }
            if (!empty($res['changed'])) {
                bumpVersions($db, ['receipts', 'treasury', 'vehicle_ledger', 'vehicle_owners']);
            }
            $db->commit();
            jsonSuccess([
                'receipt'        => $res['data'],
                'receipt_id'     => $receiptId,
                'payment_status' => $validatedPaymentStatus,
                'changed'        => !empty($res['changed']),
                'treasury'       => $res['treasury'] ?? null,
                'ledger'         => $res['ledger'] ?? null,
            ], 'تم تحديث حالة الدفع للإيصال بنجاح');
        } catch (Exception $e) {
            if ($db->inTransaction()) $db->rollBack();
            throw $e;
        }
    } catch (Exception $e) {
        error_log('[FINANCIAL RECEIPT-PAYMENT-STATUS] ' . $e->getMessage());
        jsonError($e->getMessage(), 500);
    }
    exit;
}

// 2. Row-level disbursement status update ('paid' / 'تم صرفه' or 'unpaid' / 'لم يتم صرفه').
// Atomically posts/reverses the paired treasury deposit and office ledger deposit (net + sarf).
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
        $treasuryRepo = new TreasuryRepo($db);
        $ledgerRepo = new VehicleLedgerRepository($db);
        $officeRepo = new OfficeRepository($db);

        $db->beginTransaction();
        try {
            $res = $receiptRepo->transitionRowDisbursementStatus(
                $receiptId,
                $rowId,
                $validatedRowStatus,
                $username,
                $treasuryRepo,
                $ledgerRepo,
                $officeRepo
            );
            if ($res['code'] === ReceiptRepository::RESULT_NOT_FOUND) {
                $db->rollBack(); jsonError($res['message'] ?? 'الإيصال غير موجود', 404);
            }
            if ($res['code'] === ReceiptRepository::RESULT_FORBIDDEN) {
                $db->rollBack(); jsonError($res['message'] ?? 'غير مسموح', 403);
            }
            if ($res['code'] === ReceiptRepository::RESULT_ARCHIVED) {
                $db->rollBack(); mapResult('ARCHIVED');
            }
            if ($res['code'] === ReceiptRepository::RESULT_ROW_NOT_FOUND) {
                $db->rollBack(); jsonError($res['message'] ?? 'الصف المطلوب غير موجود في هذا الإيصال', 404);
            }
            if (in_array($res['code'], [
                ReceiptRepository::RESULT_NEGATIVE_AMOUNT,
                ReceiptRepository::RESULT_DUPLICATE_ROW_ID,
                ReceiptRepository::RESULT_INVALID,
            ], true)) {
                $db->rollBack(); jsonError($res['message'] ?? 'فشل تحديث حالة الصف', 400);
            }
            if ($res['code'] === ReceiptRepository::RESULT_INCONSISTENT_LEDGER) {
                $db->rollBack(); jsonError($res['message'] ?? 'تعارض في القيود المالية لحركة صرف الصف', 409);
            }
            if ($res['code'] !== ReceiptRepository::RESULT_OK) {
                $db->rollBack(); jsonError($res['message'] ?? 'فشل تحديث حالة الصف', 400);
            }
            if (!empty($res['changed'])) {
                bumpVersions($db, ['receipts', 'treasury', 'vehicle_ledger', 'offices']);
            }
            $db->commit();
            jsonSuccess([
                'receipt'  => $res['data'],
                'row'      => $res['row'],
                'row_id'   => $rowId,
                'status'   => $validatedRowStatus,
                'changed'  => !empty($res['changed']),
                'treasury' => $res['treasury'] ?? null,
                'ledger'   => $res['ledger'] ?? null,
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

// 3. Reject ambiguous legacy status requests lacking both payment_status and row_id
// so legacy payout_status cannot create competing financial postings or conflate statuses.
jsonError('يجب تحديد نوع الحالة: حالة الدفع للإيصال (payment_status) أو معرف الصف لحالة الصرف (row_id)', 400);
