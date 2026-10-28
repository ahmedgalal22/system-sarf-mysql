<?php
/**
 * POST /api/financial/treasury-edit.php
 *
 * Atomic: BEGIN → update treasury + update linked ledger
 *         + advance delta allocation (salfa only) → COMMIT
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
    if (array_key_exists('amount', $body)) {
        $body['amount'] = ReceiptRepository::validateFiniteIntCents($body['amount'], 'المبلغ (amount)', false);
    }
} catch (InvalidArgumentException $e) {
    jsonError($e->getMessage(), 400);
}

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
            jsonError('لا يمكن تعديل حركة خزنة معكوسة مسبقاً', 409);
        }
        if (!empty($existing['is_archived'])) {
            $db->rollBack();
            jsonError('لا يمكن تعديل حركة خزنة مؤرشفة', 409);
        }
        if (in_array($existing['reference_type'] ?? '', [ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT, ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT], true)
            || in_array($existing['effect'] ?? '', ['row_disbursement', 'receipt_payout'], true)
        ) {
            $db->rollBack();
            jsonError('لا يمكن تعديل حركة خزنة مرتبطة بحالة صرف أو دفع إيصال من شاشة الخزنة مباشرة', 409);
        }

        $isExistingSalfa = ($existing['effect'] ?? '') === 'salfa' || ($existing['reference_type'] ?? '') === 'salfa';
        if ($isExistingSalfa) {
            if (array_key_exists('effect', $body) && ($body['effect'] ?? '') !== ($existing['effect'] ?? 'salfa')) {
                $db->rollBack();
                jsonError('لا يمكن تغيير نوع تأثير حركة السلفة', 409);
            }
            if (array_key_exists('type', $body) && ($body['type'] ?? '') !== ($existing['type'] ?? 'withdraw')) {
                $db->rollBack();
                jsonError('لا يمكن تغيير اتجاه حركة السلفة', 409);
            }
            if (array_key_exists('client_id', $body) && strval($body['client_id'] ?? '') !== strval($existing['client_id'] ?? '')) {
                $db->rollBack();
                jsonError('لا يمكن تغيير صاحب المركبة المرتبط بحركة السلفة', 409);
            }
            if (array_key_exists('client_type', $body) && strval($body['client_type'] ?? '') !== strval($existing['client_type'] ?? '')) {
                $db->rollBack();
                jsonError('لا يمكن تغيير تصنيف العميل المرتبط بحركة السلفة', 409);
            }
            if (array_key_exists('amount', $body) && intval($body['amount']) <= 0) {
                $db->rollBack();
                jsonError('مبلغ السلفة يجب أن يكون قيمة صحيحة أكبر من صفر', 400);
            }
        } elseif (isset($body['effect']) && $body['effect'] === 'salfa') {
            $db->rollBack();
            jsonError('لا يمكن تحويل حركة خزنة عادية إلى سلفة', 400);
        }

        $isSalfaWithClient = ($existing['effect'] ?? '') === 'salfa' && !empty($existing['reference_id']) && !empty($existing['client_id']);

        // 3. Validate linked receipt for EVERY salfa edit (not only when amount delta != 0),
        //    and apply salfa advance delta on receipts FIRST before mutating treasury/vehicle_ledger.
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
                    jsonError('لا يمكن تعديل السلفة لأن الإيصال المرتبط بها غير موجود أو محذوف', 409);
                }
                if (!empty($target['is_archived'])) {
                    $db->rollBack();
                    jsonError('لا يمكن تعديل السلفة لأن الإيصال المرتبط بها مؤرشف', 409);
                }
                $salfaStatus = ReceiptRepository::inspectReceiptSalfaStatus($target);
                if (!$salfaStatus['eligible']) {
                    $db->rollBack();
                    jsonError($salfaStatus['message'] ?? 'لا يمكن تعديل السلفة بعد دفع الإيصال المرتبط بها', 409);
                }

                if (array_key_exists('amount', $body)) {
                    $oldAmount = intval($existing['amount'] ?? 0);
                    $newAmount = intval($body['amount']);
                    $delta = $newAmount - $oldAmount; // positive = advance increased
                    if ($delta !== 0) {
                        $currentPaid = intval($target['paid'] ?? 0);
                        $netTotal = intval($target['net_total'] ?? 0);
                        $newPaid = $currentPaid - $delta;
                        $newPaid = max(0, min($netTotal, $newPaid));
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
            }
        }

        // 4. Update treasury entry SECOND (never clearing receipt_number or changing salfa identity)
        $patch = [];
        $allowedFields = $isExistingSalfa
            ? ['amount','date','description','note','client_name']
            : ['type','effect','amount','date','description','note','client_id','client_type','client_name'];
        foreach ($allowedFields as $f) {
            if (array_key_exists($f, $body)) $patch[$f] = $body[$f];
        }
        if (isset($patch['effect']) && in_array($patch['effect'], ['row_disbursement', 'receipt_payout'], true)) {
            $db->rollBack();
            jsonError('لا يمكن تحويل حركة الخزنة إلى حركة مرتبطة بحالة صرف أو دفع إيصال', 400);
        }
        $updated = $treasuryRepo->update($id, $patch, $username);

        // 5. Lock and update linked vehicle_ledger entries THIRD (scoped to user, ascending PK order)
        if ($isSalfaWithClient) {
            $ledgerEntries = $ledgerRepo->getActiveByReferenceForUser(
                $username,
                (string)$existing['reference_id'],
                (string)($existing['reference_type'] ?? 'salfa'),
                true
            );
            foreach ($ledgerEntries as $le) {
                $ledgerPatch = [];
                if (array_key_exists('amount', $body)) $ledgerPatch['amount'] = $body['amount'];
                if (array_key_exists('date', $body)) $ledgerPatch['date'] = $body['date'];
                if (array_key_exists('note', $body)) $ledgerPatch['note'] = $body['note'];
                if (!empty($ledgerPatch)) {
                    $ledgerRepo->update(intval($le['id']), $ledgerPatch, $username);
                }
            }
        }

        $bumps = ['treasury'];
        if ($isSalfaWithClient) $bumps[] = 'vehicle_ledger';
        if ($advanceReceipt) $bumps[] = 'receipts';
        bumpVersions($db, $bumps);
        $db->commit();
        jsonSuccess($updated, 'تم التحديث بنجاح');

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL TREASURY-EDIT] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}


