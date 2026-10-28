<?php
/**
 * POST /api/financial/treasury-delete.php
 *
 * Atomic: BEGIN → reverse treasury + reverse linked ledger
 *         + reverse advance allocation (salfa only) → COMMIT
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
$id = intval($body['id'] ?? 0);
if ($id <= 0) jsonError('المعرف مطلوب', 400);

try {
    $db = getDB();
    $treasuryRepo = new TreasuryRepo($db);
    $ledgerRepo = new VehicleLedgerRepository($db);
    $receiptRepo = new ReceiptRepository($db);

    // Pre-read treasury row outside transaction so any linked receipt can be locked
    // BEFORE treasury (preserving canonical lock hierarchy: receipts -> treasury -> vehicle_ledger).
    $preExisting = $treasuryRepo->getById($id);
    if (!$preExisting) jsonError('السجل غير موجود', 404);
    if (($preExisting['username'] ?? '') !== $username) jsonError('غير مسموح', 403);
    $preReceiptId = !empty($preExisting['receipt_number']) && ctype_digit((string)$preExisting['receipt_number'])
        ? intval($preExisting['receipt_number'])
        : 0;

    $db->beginTransaction();
    try {
        // 1. Lock linked receipt FIRST (if present)
        $lockedTargetReceipt = null;
        if ($preReceiptId > 0) {
            $recLockStmt = $db->prepare('SELECT * FROM receipts WHERE id = :rid AND username = :u FOR UPDATE');
            $recLockStmt->execute([':rid' => $preReceiptId, ':u' => $username]);
            $lockedTargetReceipt = $recLockStmt->fetch() ?: null;
        }

        // 2. Lock treasury entry SECOND
        $lockStmt = $db->prepare('SELECT * FROM treasury WHERE id = :id AND deleted_at IS NULL FOR UPDATE');
        $lockStmt->execute([':id' => $id]);
        $existing = $lockStmt->fetch();
        if (!$existing) { $db->rollBack(); jsonError('السجل غير موجود', 404); }
        if ($existing['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }
        if (!empty($existing['is_reversed'])) {
            $db->rollBack();
            jsonError('لا يمكن حذف حركة خزنة معكوسة مسبقاً', 409);
        }
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

        $isSalfaWithClient = ($existing['effect'] ?? '') === 'salfa' && !empty($existing['reference_id']) && !empty($existing['client_id']);

        // 3. Validate & restore advance allocation on receipts FIRST (before mutating treasury/vehicle_ledger)
        $advanceReceipt = null;
        if ($isSalfaWithClient) {
            $targetReceiptId = $existing['receipt_number'] ?? null;
            if ($targetReceiptId !== null && trim((string)$targetReceiptId) !== '') {
                $targetIdInt = ctype_digit(trim((string)$targetReceiptId)) ? intval($targetReceiptId) : 0;
                if ($targetIdInt <= 0) {
                    $db->rollBack();
                    jsonError('مرجع الإيصال المرتبط بالسلفة غير صالح', 409);
                }
                $target = ($targetIdInt === $preReceiptId) ? $lockedTargetReceipt : null;
                if (!$target || $target['deleted_at'] !== null) {
                    $db->rollBack();
                    jsonError('لا يمكن حذف السلفة لأن الإيصال المرتبط بها غير موجود أو محذوف', 409);
                }
                if (!empty($target['is_archived'])) {
                    $db->rollBack();
                    jsonError('لا يمكن حذف السلفة لأن الإيصال المرتبط بها مؤرشف', 409);
                }
                $salfaStatus = ReceiptRepository::inspectReceiptSalfaStatus($target);
                if (!$salfaStatus['eligible']) {
                    $db->rollBack();
                    jsonError($salfaStatus['message'] ?? 'لا يمكن حذف السلفة بعد دفع الإيصال المرتبط بها', 409);
                }

                $advanceAmount = intval($existing['amount'] ?? 0);
                $currentPaid = intval($target['paid'] ?? 0);
                $netTotal = intval($target['net_total'] ?? 0);
                $newPaid = min($netTotal, $currentPaid + $advanceAmount);
                $updRecRes = $receiptRepo->updateReceipt($targetIdInt, [
                    'paid' => $newPaid,
                ], $username);
                if (($updRecRes['code'] ?? '') !== ReceiptRepository::RESULT_OK) {
                    $db->rollBack();
                    jsonError('فشل تحديث الإيصال المرتبط بالسلفة', 409);
                }
                $advanceReceipt = ['id' => $targetIdInt, 'old_paid' => $currentPaid, 'new_paid' => $newPaid];
            }
        }

        // 4. Reverse the treasury entry SECOND (preserving receipt_number audit link)
        $treasuryRepo->update($id, [
            'is_reversed' => 1,
            'reversed_at' => nowEgypt(),
            'reversed_by' => $username,
        ], $username);

        // 5. Reverse linked vehicle_ledger entries THIRD (scoped to user)
        if ($isSalfaWithClient) {
            $ledgerRepo->reverseByReferenceForUser($username, (string)$existing['reference_id'], (string)($existing['reference_type'] ?? 'salfa'));
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


