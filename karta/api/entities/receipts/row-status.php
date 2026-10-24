<?php
/**
 * POST|PUT /api/entities/receipts/row-status.php
 *
 * Updates the disbursement status of a single receipt row inside `receipts.rows`.
 *
 * Supported status values:
 *   - 'paid' / 'تم صرفه'       -> 'paid'
 *   - 'unpaid' / 'لم يتم صرفه' -> 'unpaid'
 *
 * Data Integrity & Concurrency:
 *   - Uses InnoDB `SELECT ... FOR UPDATE` row lock inside a transaction so
 *     concurrent updates to different rows on the same receipt never overwrite
 *     each other.
 *   - Verifies that the receipt exists, belongs to the authenticated user,
 *     is not archived, and contains the target `row_id`.
 *   - Prevents a `row_id` from another receipt from modifying this receipt.
 *   - Keeps status changes completely separate from receipt financial
 *     calculations, treasury entries, and vehicle/office ledger entries.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../core/validator.php';
require_once __DIR__ . '/../../../core/permissions.php';
require_once __DIR__ . '/../../../core/errorMapper.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/ReceiptRepository.php';
require_once __DIR__ . '/../../../repositories/TreasuryRepository2.php';
require_once __DIR__ . '/../../../repositories/VehicleLedgerRepository.php';
require_once __DIR__ . '/../../../repositories/OfficeRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('POST') && !isMethod('PUT')) {
    jsonMethodNotAllowed('POST, PUT');
}
requirePermission($authUser['role'], 'receipts', 'write');

$body = requireJsonBody();

$receiptId = intval($body['receipt_id'] ?? $body['id'] ?? 0);
if ($receiptId <= 0) {
    jsonError('معرف الإيصال مطلوب', 400);
}

$rawRowId = $body['row_id'] ?? $body['rowId'] ?? null;
if (!is_string($rawRowId) && !is_numeric($rawRowId)) {
    jsonError('معرف الصف مطلوب', 400);
}
$rowId = trim((string)$rawRowId);
if ($rowId === '') {
    jsonError('معرف الصف مطلوب', 400);
}

if (array_key_exists('payment_status', $body)
    || array_key_exists('paymentStatus', $body)
    || (($body['field'] ?? $body['status_type'] ?? '') === 'payment_status')
) {
    jsonError('حالة الدفع تطبق على الإيصال بالكامل وليس على مستوى الصف', 400);
}

$rawStatus = $body['status'] ?? $body['disbursement_status'] ?? null;
$validatedStatus = ReceiptRepository::validateRowDisbursementStatus($rawStatus);
if ($validatedStatus === null) {
    jsonError('حالة الصرف غير صالحة. القيم المسموحة: تم صرفه أو لم يتم صرفه', 400);
}

try {
    $db = getDB();
    $repo = new ReceiptRepository($db);
    $treasuryRepo = new TreasuryRepo($db);
    $ledgerRepo = new VehicleLedgerRepository($db);
    $officeRepo = new OfficeRepository($db);

    $db->beginTransaction();
    try {
        $result = $repo->transitionRowDisbursementStatus(
            $receiptId,
            $rowId,
            $validatedStatus,
            $authUser['username'],
            $treasuryRepo,
            $ledgerRepo,
            $officeRepo
        );

        switch ($result['code']) {
            case ReceiptRepository::RESULT_NOT_FOUND:
                $db->rollBack();
                jsonError($result['message'] ?? 'الإيصال غير موجود', 404);
                break;

            case ReceiptRepository::RESULT_FORBIDDEN:
                $db->rollBack();
                jsonError($result['message'] ?? 'غير مسموح بتعديل هذا الإيصال', 403);
                break;

            case ReceiptRepository::RESULT_ARCHIVED:
                $db->rollBack();
                mapResult('ARCHIVED');
                break;

            case ReceiptRepository::RESULT_ROW_NOT_FOUND:
                $db->rollBack();
                jsonError($result['message'] ?? 'الصف المطلوب غير موجود في هذا الإيصال', 404);
                break;

            case ReceiptRepository::RESULT_NEGATIVE_AMOUNT:
            case ReceiptRepository::RESULT_DUPLICATE_ROW_ID:
            case ReceiptRepository::RESULT_INVALID:
                $db->rollBack();
                jsonError($result['message'] ?? 'بيانات حالة الصف غير صالحة', 400);
                break;

            case ReceiptRepository::RESULT_INCONSISTENT_LEDGER:
                $db->rollBack();
                jsonError($result['message'] ?? 'تعارض في القيود المالية لحركة صرف الصف', 409);
                break;

            case ReceiptRepository::RESULT_OK:
                if (!empty($result['changed'])) {
                    bumpVersions($db, ['receipts', 'treasury', 'vehicle_ledger', 'offices']);
                }
                $db->commit();
                jsonSuccess([
                    'receipt'  => $result['data'],
                    'row'      => $result['row'],
                    'row_id'   => $rowId,
                    'status'   => $validatedStatus,
                    'changed'  => !empty($result['changed']),
                    'treasury' => $result['treasury'] ?? null,
                    'ledger'   => $result['ledger'] ?? null,
                ], 'تم تحديث حالة الصف بنجاح');
                break;

            default:
                $db->rollBack();
                jsonError('خطأ غير متوقع أثناء تحديث حالة الصف', 500);
                break;
        }
    } catch (Exception $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }
} catch (PDOException $e) {
    error_log('[RECEIPT ROW-STATUS] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
