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
require_once __DIR__ . '/../../repositories/VehicleOwnerRepository.php';
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
    $ownerRepo = new VehicleOwnerRepository($db);
    $hamolaRepo = new HamolaRepository($db);

    $db->beginTransaction();
    try {
        // 1. Update receipt data under exclusive FOR UPDATE lock (also validates row IDs & status immutability)
        $patch = [];
        $allowed = ['receipt_date','client_id','client_type','client_name',
                     'payout_status','payment_status','account_type',
                     'total','net_due','net_total','paid','previous_balance','general_add',
                     'rows','notes','shipping_number'];
        foreach ($allowed as $f) { if (array_key_exists($f, $body)) $patch[$f] = $body[$f]; }

        $result = $receiptRepo->updateReceipt($receiptId, $patch, $username, $body['updated_at'] ?? null);
        if ($result['code'] !== ReceiptRepository::RESULT_OK) {
            $db->rollBack();
            mapResult($result['code'], $result['data']);
        }

        $existing = $result['previous'] ?? $result['data'];
        $updated = $result['data'];
        $isPaid = ($existing['payout_status'] ?? 'unpaid') === 'paid';

        // 2. Reconcile status-linked movements (row disbursements and receipt-level payment)
        $reconcileRes = $receiptRepo->reconcileStatusMovementsOnReceiptUpdate(
            $existing,
            $updated,
            $username,
            $treasuryRepo,
            $ledgerRepo,
            $officeRepo,
            $ownerRepo
        );
        if ($reconcileRes['code'] !== ReceiptRepository::RESULT_OK) {
            $db->rollBack();
            if ($reconcileRes['code'] === ReceiptRepository::RESULT_INCONSISTENT_LEDGER) {
                jsonError($reconcileRes['message'] ?? 'تعارض في القيود المالية للإيصال', 409);
            }
            jsonError($reconcileRes['message'] ?? 'فشل تحديث القيود المالية للإيصال', 400);
        }

        // 3. Reverse old receipt-creation entries — ONLY if legacy payout_status is unpaid
        if (!$isPaid) {
            $treasuryRepo->reverseByReference(strval($receiptId), 'receipt', $username);
            $ledgerRepo->reverseByReference(strval($receiptId), 'receipt', $username);
        }

        // 4. Apply new receipt-creation entries — ONLY if legacy payout_status is unpaid
        $ledgerResults = [];
        $treasuryResults = [];
        if (!$isPaid) {
            if (!empty($body['ledger_ops']) && is_array($body['ledger_ops'])) {
                foreach ($body['ledger_ops'] as $op) {
                    if (!is_array($op)) continue;
                    $opType = $op['type'] ?? '';
                    $opEffect = $op['effect'] ?? '';
                    $opRefType = $op['reference_type'] ?? '';
                    if ($opType === 'OFFICE_WITHDRAW_AUTO') continue;
                    if (in_array($opRefType, [ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT, ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT], true)
                        || in_array($opType, ['row_disbursement', 'receipt_payment', 'OFFICE_DEPOSIT'], true)
                        || in_array($opEffect, ['row_disbursement', 'receipt_payout'], true)
                    ) {
                        throw new InvalidArgumentException('لا يمكن تمرير حركات حالة الصرف أو الدفع ضمن عمليات تعديل الإيصال');
                    }
                    $op['username'] = $username;
                    $op['reference_type'] = 'receipt';
                    $op['reference_id'] = strval($receiptId);
                    $ledgerResults[] = $ledgerRepo->create($op);
                }
            }
            if (!empty($body['treasury_ops']) && is_array($body['treasury_ops'])) {
                foreach ($body['treasury_ops'] as $op) {
                    if (!is_array($op)) continue;
                    $opEffect = $op['effect'] ?? '';
                    $opRefType = $op['reference_type'] ?? '';
                    if (in_array($opRefType, [ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT, ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT], true)
                        || in_array($opEffect, ['row_disbursement', 'receipt_payout'], true)
                    ) {
                        throw new InvalidArgumentException('لا يمكن تمرير حركات خزنة مرتبطة بحالة الصرف أو الدفع ضمن عمليات تعديل الإيصال');
                    }
                    $op['username'] = $username;
                    $op['reference_type'] = 'receipt';
                    $op['reference_id'] = strval($receiptId);
                    $treasuryResults[] = $treasuryRepo->create($op);
                }
            }
        }

        // 5. Synchronize office balance deductions (الصافي + قيمة خانة الصرف) atomically
        $effectiveRows = is_array($updated['rows'] ?? null)
            ? $updated['rows']
            : (is_string($updated['rows'] ?? null) ? (json_decode($updated['rows'], true) ?: []) : []);
        $officeLedgerResults = $ledgerRepo->syncOfficeDeductionsForReceipt(
            $username,
            strval($receiptId),
            strval($updated['receipt_number'] ?? $existing['receipt_number'] ?? $receiptId),
            $updated['receipt_date'] ?? $existing['receipt_date'] ?? null,
            $effectiveRows,
            $officeRepo,
            $updated['client_name'] ?? ($body['client_name'] ?? ($existing['client_name'] ?? null)),
            isset($updated['client_id']) ? strval($updated['client_id']) : (isset($body['client_id']) ? strval($body['client_id']) : (isset($existing['client_id']) ? strval($existing['client_id']) : null)),
            $existing['client_name'] ?? null
        );

        // 6. Automatically register any missing office cargo combinations inside the same transaction
        $syncedHamola = $hamolaRepo->syncFromReceiptRows(
            $username,
            $effectiveRows,
            $officeRepo
        );

        $bumps = ['receipts', 'vehicle_ledger', 'treasury', 'offices', 'vehicle_owners'];
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
} catch (InvalidArgumentException $e) {
    error_log('[FINANCIAL RECEIPT-UPDATE] ' . $e->getMessage());
    jsonError($e->getMessage(), 400);
} catch (Exception $e) {
    error_log('[FINANCIAL RECEIPT-UPDATE] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
