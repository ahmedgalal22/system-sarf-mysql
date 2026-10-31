<?php
/**
 * PUT /api/entities/receipts/update.php
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  PRODUCTION LOCKED — Phase 4.8                              ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * TRANSACTION MODEL:
 *   BEGIN
 *     SELECT FOR UPDATE — exclusive row lock
 *     Check: NOT_FOUND → ARCHIVED → CONFLICT
 *     UPDATE with NOW(3) timestamp
 *   COMMIT
 *
 * No external calls inside transaction. No schema operations.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../core/validator.php';
require_once __DIR__ . '/../../../core/errorMapper.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/ReceiptRepository.php';
require_once __DIR__ . '/../../../repositories/TreasuryRepository2.php';
require_once __DIR__ . '/../../../repositories/OfficeRepository.php';
require_once __DIR__ . '/../../../repositories/VehicleOwnerRepository.php';
require_once __DIR__ . '/../../../repositories/HamolaRepository.php';
require_once __DIR__ . '/../../../repositories/VehicleLedgerRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('PUT')) jsonMethodNotAllowed('PUT');

$body = requireJsonBody();

$id = validatePositiveInt($body['id'] ?? 0, 'معرف النموذج');

try {
    $db = getDB();
    $repo = new ReceiptRepository($db);
    $treasuryRepo = new TreasuryRepo($db);
    $officeRepo = new OfficeRepository($db);
    $ownerRepo = new VehicleOwnerRepository($db);
    $hamolaRepo = new HamolaRepository($db);
    $ledgerRepo = new VehicleLedgerRepository($db);

    $db->beginTransaction();

    try {
        $patch = [];
        $allowed = [
            'receipt_date', 'client_id', 'client_type', 'client_name',
            'payout_status', 'payment_status', 'paid_at', 'account_type',
            'total', 'net_due', 'net_total', 'paid', 'previous_balance', 'general_add',
            'rows', 'notes', 'shipping_number',
        ];
        foreach ($allowed as $field) {
            if (array_key_exists($field, $body)) $patch[$field] = $body[$field];
        }

        $result = $repo->updateReceipt($id, $patch, $authUser['username'], $body['updated_at'] ?? null);

        if ($result['code'] !== ReceiptRepository::RESULT_OK) {
            $db->rollBack();
            $data = $result['data'] ?? null;
            if ($data) decodeRowsField($data);
            mapResult($result['code'], $data);
            return;
        }

        $existing = $result['previous'] ?? $result['data'];
        $updated = $result['data'];

        $reconcileRes = $repo->reconcileStatusMovementsOnReceiptUpdate(
            $existing,
            $updated,
            $authUser['username'],
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

        $effectiveRows = is_array($updated['rows'] ?? null)
            ? $updated['rows']
            : (is_string($updated['rows'] ?? null) ? (json_decode($updated['rows'], true) ?: []) : []);
        $ledgerRepo->syncOfficeDeductionsForReceipt(
            $authUser['username'],
            strval($id),
            strval($updated['receipt_number'] ?? $id),
            $updated['receipt_date'] ?? null,
            $effectiveRows,
            $officeRepo,
            $updated['client_name'] ?? ($body['client_name'] ?? null),
            isset($updated['client_id']) ? strval($updated['client_id']) : (isset($body['client_id']) ? strval($body['client_id']) : null),
            $existing['client_name'] ?? null
        );
        $syncedHamola = $hamolaRepo->syncFromReceiptRows(
            $authUser['username'],
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
        mapResult('OK', $updated, 'تم تحديث النموذج بنجاح');

    } catch (Exception $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }

} catch (InvalidArgumentException $e) {
    jsonError($e->getMessage(), 400);
} catch (PDOException $e) {
    error_log('[RECEIPT UPDATE] ' . $e->getMessage());
    $debugMsg = 'خطأ في الخادم';
    $appCfg = require __DIR__ . '/../../../config/app.php';
    if (!empty($appCfg['debug'])) $debugMsg .= ' — ' . $e->getMessage();
    jsonError($debugMsg, 500);
}
