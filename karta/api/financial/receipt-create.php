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

        // Create receipt
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
            'total'            => intval($body['total'] ?? 0),
            'net_due'          => intval($body['net_due'] ?? 0),
            'net_total'        => intval($body['net_total'] ?? 0),
            'paid'             => intval($body['paid'] ?? 0),
            'previous_balance' => intval($body['previous_balance'] ?? 0),
            'general_add'      => intval($body['general_add'] ?? 0),
            'rows'             => $body['rows'] ?? [],
            'notes'            => $body['notes'] ?? null,
            'shipping_number'  => $body['shipping_number'] ?? null,
            'request_id'       => $requestId,
            'created_by'       => $username,
        ]);

        $receiptId = strval($receipt['id']);

        // Create ledger entries (from ledger_ops array)
        // IMPORTANT: Always use the DB integer ID as reference_id and 'receipt'
        // as reference_type, and reject status-linked movement types.
        $ledgerResults = [];
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
                    throw new InvalidArgumentException('لا يمكن تمرير حركات حالة الصرف أو الدفع ضمن عمليات إنشاء الإيصال');
                }
                $op['username'] = $username;
                $op['reference_type'] = 'receipt';
                $op['reference_id'] = $receiptId;
                $ledgerResults[] = $ledgerRepo->create($op);
            }
        }

        // Synchronize office balance deductions (الصافي + قيمة خانة الصرف) atomically
        $officeLedgerResults = $ledgerRepo->syncOfficeDeductionsForReceipt(
            $username,
            $receiptId,
            strval($receipt['receipt_number'] ?? $receiptNumber),
            $receipt['receipt_date'] ?? ($body['receipt_date'] ?? null),
            is_array($body['rows'] ?? null) ? $body['rows'] : [],
            $officeRepo,
            $receipt['client_name'] ?? ($body['client_name'] ?? null),
            isset($receipt['client_id']) ? strval($receipt['client_id']) : (isset($body['client_id']) ? strval($body['client_id']) : null)
        );

        // Create treasury entries (from treasury_ops array)
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
                $op['username'] = $username;
                $op['reference_type'] = 'receipt';
                $op['reference_id'] = $receiptId;
                $treasuryResults[] = $treasuryRepo->create($op);
            }
        }

        // Automatically register any missing office cargo combinations inside the same transaction
        $syncedHamola = $hamolaRepo->syncFromReceiptRows(
            $username,
            is_array($body['rows'] ?? null) ? $body['rows'] : [],
            $officeRepo
        );

        $bumps = ['receipts', 'vehicle_ledger', 'treasury', 'offices'];
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
