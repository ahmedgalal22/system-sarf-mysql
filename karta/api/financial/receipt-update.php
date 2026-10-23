<?php
/**
 * POST /api/financial/receipt-update.php
 *
 * Two modes:
 *   UNPAID: BEGIN → reverse old ledger/treasury + update receipt + apply new → COMMIT
 *   PAID:   BEGIN → update receipt data ONLY (no financial reversal) → COMMIT
 *
 * Editing a paid receipt NEVER reverses or recreates payment entries.
 * Financial adjustments for paid receipts are handled separately.
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../core/errorMapper.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/ReceiptRepository.php';
require_once __DIR__ . '/../../repositories/TreasuryRepository2.php';
require_once __DIR__ . '/../../repositories/VehicleLedgerRepository.php';
require_once __DIR__ . '/../../repositories/OfficeRepository.php';
require_once __DIR__ . '/../../repositories/HamolaRepository.php';
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
    $officeRepo = new OfficeRepository($db);
    $hamolaRepo = new HamolaRepository($db);

    $db->beginTransaction();
    try {
        // 0. Read existing receipt
        $existing = $receiptRepo->findById($receiptId);
        if (!$existing) { $db->rollBack(); jsonError('الإيصال غير موجود', 404); }
        if ($existing['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }

        $isPaid = ($existing['payout_status'] ?? 'unpaid') === 'paid';

        // 1. Reverse old entries — ONLY if receipt is unpaid
        if (!$isPaid) {
            $treasuryRepo->reverseByReference(strval($receiptId), 'receipt', $username);
            $ledgerRepo->reverseByReference(strval($receiptId), 'receipt', $username);
        }

        // 2. Update receipt data
        $patch = [];
        $allowed = ['receipt_date','client_id','client_type','client_name',
                     'account_type',
                     'total','net_due','net_total','paid','previous_balance','general_add',
                     'rows','notes','shipping_number'];
        foreach ($allowed as $f) { if (array_key_exists($f, $body)) $patch[$f] = $body[$f]; }

        // PAID receipt: preserve payout_status and paid_at — never overwrite
        if ($isPaid) {
            unset($patch['payout_status']);
            unset($patch['paid_at']);
        }

        $result = $receiptRepo->updateReceipt($receiptId, $patch, $username, $body['updated_at'] ?? null);
        if ($result['code'] !== ReceiptRepository::RESULT_OK) {
            $db->rollBack();
            mapResult($result['code'], $result['data']);
        }

        // 3. Apply new entries — ONLY if receipt is unpaid
        $ledgerResults = [];
        $treasuryResults = [];
        if (!$isPaid) {
            if (!empty($body['ledger_ops'])) {
                foreach ($body['ledger_ops'] as $op) {
                    if (($op['type'] ?? '') === 'OFFICE_WITHDRAW_AUTO') continue;
                    $op['username'] = $username;
                    $op['reference_id'] = strval($receiptId);
                    $ledgerResults[] = $ledgerRepo->create($op);
                }
            }
            if (!empty($body['treasury_ops'])) {
                foreach ($body['treasury_ops'] as $op) {
                    $op['username'] = $username;
                    $op['reference_id'] = strval($receiptId);
                    $treasuryResults[] = $treasuryRepo->create($op);
                }
            }
        }

        // 4. Synchronize office balance deductions (الصافي + قيمة خانة الصرف) atomically
        $updated = $result['data'];
        $effectiveRows = is_array($body['rows'] ?? null)
            ? $body['rows']
            : (is_string($updated['rows'] ?? null) ? (json_decode($updated['rows'], true) ?: []) : ($updated['rows'] ?? []));
        $officeLedgerResults = $ledgerRepo->syncOfficeDeductionsForReceipt(
            $username,
            strval($receiptId),
            strval($updated['receipt_number'] ?? $existing['receipt_number'] ?? $receiptId),
            $updated['receipt_date'] ?? $existing['receipt_date'] ?? null,
            $effectiveRows,
            $officeRepo
        );

        // 5. Automatically register any missing office cargo combinations inside the same transaction
        $syncedHamola = $hamolaRepo->syncFromReceiptRows(
            $username,
            $effectiveRows,
            $officeRepo
        );

        $bumps = ['receipts', 'vehicle_ledger', 'offices'];
        if (!$isPaid) {
            $bumps[] = 'treasury';
        }
        if (!empty($syncedHamola)) {
            $bumps[] = 'hamola_details';
        }
        bumpVersions($db, $bumps);
        $db->commit();
        decodeRowsField($updated);
        jsonSuccess([
            'receipt'       => $updated,
            'ledger'        => $ledgerResults,
            'office_ledger' => $officeLedgerResults,
            'treasury'      => $treasuryResults,
            'synced_hamola' => $syncedHamola,
        ]);

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL RECEIPT-UPDATE] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
