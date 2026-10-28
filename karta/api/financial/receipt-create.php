<?php
/**
 * POST /api/financial/receipt-create.php
 *
 * Atomic: BEGIN → create receipt + treasury entries + ledger entries → COMMIT
 * Mirrors financial.js createReceipt() exactly.
 * Includes _assertNotApplied equivalent.
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../core/validator.php';
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

try {
    $db = getDB();
    $receiptRepo = new ReceiptRepository($db);
    $treasuryRepo = new TreasuryRepo($db);
    $ledgerRepo = new VehicleLedgerRepository($db);
    $officeRepo = new OfficeRepository($db);
    $hamolaRepo = new HamolaRepository($db);

    // UUID resolution: frontend sends 'id', backend contract expects 'uuid'
    $uuid = $body['uuid'] ?? $body['id'] ?? null;
    if (empty($uuid)) {
        jsonError('uuid مطلوب', 400);
    }

    // Idempotency check
    $requestId = $body['request_id'] ?? null;
    if ($requestId) {
        $existing = $receiptRepo->findByRequestId($requestId);
        if ($existing) {
            decodeRowsField($existing);
            mapResult('DUPLICATE', $existing);
        }
    }

    $receiptRepo->ensureCounterExists($username);

    $db->beginTransaction();
    try {
        $receiptNumber = $receiptRepo->allocateReceiptNumber($username);

        // Create receipt (raw financial inputs are validated by ReceiptRepository::insertReceipt before coercion)
        $receipt = $receiptRepo->insertReceipt([
            'uuid'             => $uuid,
            'username'         => $username,
            'receipt_number'   => $receiptNumber,
            'receipt_date'     => $body['receipt_date'] ?? null,
            'client_id'        => $body['client_id'] ?? null,
            'client_type'      => $body['client_type'] ?? null,
            'client_name'      => $body['client_name'] ?? null,
            'payout_status'    => $body['payout_status'] ?? 'unpaid',
            'payment_status'   => $body['payment_status'] ?? null,
            'paid_at'          => $body['paid_at'] ?? null,
            'account_type'     => $body['account_type'] ?? null,
            'total'            => ($body['total'] ?? null) !== null && ($body['total'] ?? null) !== '' ? $body['total'] : 0,
            'net_due'          => $body['net_due'] ?? null,
            'net_total'        => $body['net_total'] ?? null,
            'paid'             => ($body['paid'] ?? null) !== null && ($body['paid'] ?? null) !== '' ? $body['paid'] : 0,
            'previous_balance' => ($body['previous_balance'] ?? null) !== null && ($body['previous_balance'] ?? null) !== '' ? $body['previous_balance'] : 0,
            'general_add'      => ($body['general_add'] ?? null) !== null && ($body['general_add'] ?? null) !== '' ? $body['general_add'] : 0,
            'rows'             => $body['rows'] ?? [],
            'notes'            => $body['notes'] ?? null,
            'shipping_number'  => $body['shipping_number'] ?? null,
            'request_id'       => $requestId,
            'created_by'       => $username,
        ]);

        $receiptId = strval($receipt['id']);
        $effectiveRows = is_array($receipt['rows'] ?? null)
            ? $receipt['rows']
            : (is_string($receipt['rows'] ?? null) ? (json_decode($receipt['rows'], true) ?: []) : []);

        // 1. Create treasury entries FIRST (lock hierarchy: receipts -> treasury -> vehicle_ledger)
        $treasuryResults = [];
        if (!empty($body['treasury_ops']) && is_array($body['treasury_ops'])) {
            foreach ($body['treasury_ops'] as $op) {
                if (!is_array($op)) continue;
                $opEffect = $op['effect'] ?? '';
                $opRefType = $op['reference_type'] ?? '';
                if (in_array($opRefType, [ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT, ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT], true)
                    || in_array($opEffect, ['row_disbursement', 'receipt_payout'], true)
                ) {
                    throw new InvalidArgumentException('لا يمكن تمرير حركات خزنة مرتبطة بحالة الصرف أو الدفع ضمن عمليات إنشاء الإيصال');
                }
                if (array_key_exists('amount', $op) && $op['amount'] !== null && $op['amount'] !== '') {
                    $op['amount'] = ReceiptRepository::validateFiniteIntCents($op['amount'], 'قيمة حركة الخزنة (amount)', false);
                }
                $op['username'] = $username;
                $op['reference_type'] = 'receipt';
                $op['reference_id'] = $receiptId;
                $treasuryResults[] = $treasuryRepo->create($op);
            }
        }

        // 2. Synchronize authoritative owner `receipt_due` entry from server-calculated net_due,
        //    then apply any additional non-status ledger_ops.
        $ledgerResults = [];
        $ownerDueEntry = $ledgerRepo->syncOwnerReceiptDueForReceipt(
            $username,
            $receiptId,
            strval($receipt['receipt_number'] ?? $receiptNumber),
            $receipt['receipt_date'] ?? ($body['receipt_date'] ?? null),
            intval($receipt['net_due'] ?? 0),
            isset($receipt['client_id']) ? strval($receipt['client_id']) : (isset($body['client_id']) ? strval($body['client_id']) : null),
            $receipt['client_type'] ?? ($body['client_type'] ?? 'owner'),
            $receipt['client_name'] ?? ($body['client_name'] ?? null)
        );
        if ($ownerDueEntry !== null) {
            $ledgerResults[] = $ownerDueEntry;
        }

        if (!empty($body['ledger_ops']) && is_array($body['ledger_ops'])) {
            foreach ($body['ledger_ops'] as $op) {
                if (!is_array($op)) continue;
                $opType = $op['type'] ?? '';
                $opEffect = $op['effect'] ?? '';
                $opRefType = $op['reference_type'] ?? '';
                // Skip system-synchronized ledger types (handled by syncOwnerReceiptDueForReceipt & syncOfficeDeductionsForReceipt)
                if ($opType === 'OFFICE_WITHDRAW_AUTO' || $opType === 'receipt_due' || $opEffect === 'receipt_total') continue;
                if (in_array($opRefType, [ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT, ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT], true)
                    || in_array($opType, ['row_disbursement', 'receipt_payment', 'OFFICE_DEPOSIT'], true)
                    || in_array($opEffect, ['row_disbursement', 'receipt_payout'], true)
                ) {
                    throw new InvalidArgumentException('لا يمكن تمرير حركات حالة الصرف أو الدفع ضمن عمليات إنشاء الإيصال');
                }
                if (array_key_exists('amount', $op) && $op['amount'] !== null && $op['amount'] !== '') {
                    $op['amount'] = ReceiptRepository::validateFiniteIntCents($op['amount'], 'قيمة حركة الدفتر (amount)', true);
                }
                $op['username'] = $username;
                $op['reference_type'] = 'receipt';
                $op['reference_id'] = $receiptId;
                $ledgerResults[] = $ledgerRepo->create($op);
            }
        }

        // 3. Synchronize office balance deductions (الصافي + قيمة خانة الصرف) atomically using validated rows
        $officeLedgerResults = $ledgerRepo->syncOfficeDeductionsForReceipt(
            $username,
            $receiptId,
            strval($receipt['receipt_number'] ?? $receiptNumber),
            $receipt['receipt_date'] ?? ($body['receipt_date'] ?? null),
            $effectiveRows,
            $officeRepo,
            $receipt['client_name'] ?? ($body['client_name'] ?? null),
            isset($receipt['client_id']) ? strval($receipt['client_id']) : (isset($body['client_id']) ? strval($body['client_id']) : null)
        );

        // 4. Automatically register any missing office cargo combinations inside the same transaction
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
        decodeRowsField($receipt);
        jsonSuccess([
            'receipt'       => $receipt,
            'ledger'        => $ledgerResults,
            'office_ledger' => $officeLedgerResults,
            'treasury'      => $treasuryResults,
            'synced_hamola' => $syncedHamola,
        ], 'تم إنشاء الإيصال بنجاح', 201);

    } catch (PDOException $e) {
        if ($db->inTransaction()) $db->rollBack();
        // Idempotency: UNIQUE constraint race
        if (strpos($e->getMessage(), '1062') !== false && $requestId) {
            $existing = $receiptRepo->findByRequestId($requestId);
            if ($existing) { decodeRowsField($existing); mapResult('DUPLICATE', $existing); }
        }
        throw $e;
    } catch (Exception $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }
} catch (PDOException $e) {
    error_log('[FINANCIAL RECEIPT-CREATE] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
} catch (Exception $e) {
    error_log('[FINANCIAL RECEIPT-CREATE] ' . $e->getMessage());
    jsonError($e->getMessage(), 400);
}
