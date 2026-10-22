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

    // Route validation: verify each row's (office, loading, destination) exists in hamola_details
    $rows = $body['rows'] ?? [];
    if (is_array($rows)) {
        require_once __DIR__ . '/../../repositories/HamolaRepository.php';
        $hamolaRepo = new HamolaRepository($db);
        $allHamola = $hamolaRepo->getAllByUsername($username);
        $hamolaByOffice = [];
        foreach ($allHamola as $h) {
            $key = strtolower(trim($h['loading_place'] ?? '')) . '::' . strtolower(trim($h['destination_place'] ?? ''));
            $officeId = $h['office_id'];
            if (!isset($hamolaByOffice[$officeId])) $hamolaByOffice[$officeId] = [];
            $hamolaByOffice[$officeId][$key] = true;
        }
        require_once __DIR__ . '/../../repositories/OfficeRepository.php';
        $officeRepo = new OfficeRepository($db);
        $allOffices = $officeRepo->getAllByUsername($username);
        $officeIdByName = [];
        foreach ($allOffices as $o) { $officeIdByName[trim($o['name'])] = $o['id']; }

        foreach ($rows as $r) {
            if (($r['_type'] ?? '') === 'separator') continue;
            $office = trim($r['office'] ?? '');
            $loading = trim($r['loading'] ?? '');
            $taktik = trim($r['taktik'] ?? '');
            if (!$office || !$loading || !$taktik) continue;
            $oid = $officeIdByName[$office] ?? null;
            if (!$oid) continue;
            $routeKey = strtolower($loading) . '::' . strtolower($taktik);
            if (empty($hamolaByOffice[$oid][$routeKey])) {
                jsonError("المسار غير موجود: $office → $loading → $taktik", 400);
            }
        }
    }

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

        $bumps = ['receipts'];
        if (!$isPaid) {
            $bumps[] = 'vehicle_ledger';
            $bumps[] = 'treasury';
        }
        bumpVersions($db, $bumps);
        $db->commit();
        $updated = $result['data'];
        decodeRowsField($updated);
        jsonSuccess(['receipt' => $updated, 'ledger' => $ledgerResults, 'treasury' => $treasuryResults]);

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL RECEIPT-UPDATE] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
