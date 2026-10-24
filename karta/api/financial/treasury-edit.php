<?php
/**
 * POST /api/financial/treasury-edit.php
 *
 * Atomic: BEGIN → update treasury + update linked ledger
 *         + advance delta allocation (salfa only) → COMMIT
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
$id = intval($body['id'] ?? 0);
if ($id <= 0) jsonError('المعرف مطلوب', 400);

try {
    $db = getDB();
    $treasuryRepo = new TreasuryRepo($db);
    $ledgerRepo = new VehicleLedgerRepository($db);
    $receiptRepo = new ReceiptRepository($db);

    $db->beginTransaction();
    try {
        // Row lock: prevent concurrent edits on the same treasury entry
        $lockStmt = $db->prepare('SELECT id FROM treasury WHERE id = :id AND deleted_at IS NULL FOR UPDATE');
        $lockStmt->execute([':id' => $id]);
        if (!$lockStmt->fetch()) { $db->rollBack(); jsonError('السجل غير موجود', 404); }

        $existing = $treasuryRepo->getById($id);
        if (!$existing) { $db->rollBack(); jsonError('السجل غير موجود', 404); }
        if ($existing['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }
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

        // Update treasury entry
        $patch = [];
        foreach (['type','effect','amount','date','description','note','client_id','client_type','client_name'] as $f) {
            if (array_key_exists($f, $body)) $patch[$f] = $body[$f];
        }
        if (isset($patch['effect']) && in_array($patch['effect'], ['row_disbursement', 'receipt_payout'], true)) {
            $db->rollBack();
            jsonError('لا يمكن تحويل حركة الخزنة إلى حركة مرتبطة بحالة صرف أو دفع إيصال', 400);
        }
        $updated = $treasuryRepo->update($id, $patch, $username);

        // Update linked ledger entries if this is a salfa with client
        $isSalfaWithClient = ($existing['effect'] ?? '') === 'salfa' && !empty($existing['reference_id']) && !empty($existing['client_id']);
        if ($isSalfaWithClient) {
            $ledgerEntries = $ledgerRepo->getByReference($existing['reference_id']);
            foreach ($ledgerEntries as $le) {
                if ($le['is_reversed']) continue;
                $ledgerPatch = [];
                if (array_key_exists('amount', $body)) $ledgerPatch['amount'] = $body['amount'];
                if (array_key_exists('date', $body)) $ledgerPatch['date'] = $body['date'];
                if (array_key_exists('note', $body)) $ledgerPatch['note'] = $body['note'];
                if (!empty($ledgerPatch)) {
                    $ledgerRepo->update($le['id'], $ledgerPatch, $username);
                }
            }
        }

        // Advance delta: if salfa amount changed, adjust 'paid' on the ORIGINAL
        // receipt that was affected (stored in receipt_number on the treasury entry).
        $advanceReceipt = null;
        if ($isSalfaWithClient && array_key_exists('amount', $body)) {
            $oldAmount = intval($existing['amount'] ?? 0);
            $newAmount = intval($body['amount'] ?? 0);
            $delta = $newAmount - $oldAmount; // positive = advance increased
            if ($delta !== 0) {
                $targetReceiptId = $existing['receipt_number'] ?? null;
                if ($targetReceiptId) {
                    $target = $receiptRepo->findById(intval($targetReceiptId));
                    if ($target && $target['deleted_at'] === null && ($target['payout_status'] ?? '') !== 'paid') {
                        $currentPaid = intval($target['paid'] ?? 0);
                        $netTotal = intval($target['net_total'] ?? 0);
                        // delta > 0: advance increased → reduce paid more
                        // delta < 0: advance decreased → restore paid
                        $newPaid = $currentPaid - $delta;
                        $newPaid = max(0, min($netTotal, $newPaid));
                        $receiptRepo->updateReceipt(intval($target['id']), [
                            'paid' => $newPaid,
                        ], $username);
                        $advanceReceipt = ['id' => $target['id'], 'old_paid' => $currentPaid, 'new_paid' => $newPaid];
                    }
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


