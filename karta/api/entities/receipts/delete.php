<?php
/**
 * DELETE /api/entities/receipts/delete.php
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  PRODUCTION LOCKED — Phase 4.8                              ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * TRANSACTION MODEL:
 *   Pre-check: findById (fast 404 + ownership, outside tx)
 *   BEGIN
 *     softDelete: FOR UPDATE → archive check → set deleted_at/by
 *   COMMIT
 *
 * No external calls inside transaction. No schema operations.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../core/permissions.php';
require_once __DIR__ . '/../../../core/errorMapper.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/ReceiptRepository.php';
require_once __DIR__ . '/../../../repositories/TreasuryRepository2.php';
require_once __DIR__ . '/../../../repositories/VehicleLedgerRepository.php';
require_once __DIR__ . '/../../../repositories/OfficeRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('DELETE')) jsonMethodNotAllowed('DELETE');
requirePermission($authUser['role'], 'receipts', 'delete');

$body = requireJsonBody();

$id = intval($body['id'] ?? 0);
if ($id <= 0) jsonError('معرف النموذج مطلوب', 400);

try {
    $db = getDB();
    $repo = new ReceiptRepository($db);
    $treasuryRepo = new TreasuryRepo($db);
    $ledgerRepo = new VehicleLedgerRepository($db);
    $officeRepo = new OfficeRepository($db);

    $db->beginTransaction();

    try {
        $revStatus = $repo->reverseAllStatusMovementsOnReceiptDelete(
            $id,
            $authUser['username'],
            $treasuryRepo,
            $ledgerRepo,
            $officeRepo
        );
        if ($revStatus['code'] === ReceiptRepository::RESULT_NOT_FOUND) {
            $db->rollBack();
            mapResult('NOT_FOUND');
            return;
        }
        if ($revStatus['code'] === ReceiptRepository::RESULT_FORBIDDEN) {
            $db->rollBack();
            mapResult('FORBIDDEN', null, 'غير مسموح بالحذف');
            return;
        }
        if ($revStatus['code'] === ReceiptRepository::RESULT_ARCHIVED) {
            $db->rollBack();
            mapResult('ARCHIVED');
            return;
        }
        if ($revStatus['code'] === ReceiptRepository::RESULT_INCONSISTENT_LEDGER) {
            $db->rollBack();
            jsonError($revStatus['message'] ?? 'تعارض في القيود المالية للإيصال', 409);
            return;
        }
        if ($revStatus['code'] !== ReceiptRepository::RESULT_OK) {
            $db->rollBack();
            jsonError($revStatus['message'] ?? 'فشل حذف النموذج', 400);
            return;
        }

        $treasuryRepo->reverseByReferenceForUser($authUser['username'], strval($id), 'receipt');
        $ledgerRepo->reverseByReferenceForUser($authUser['username'], strval($id), 'receipt');

        // softDelete re-checks under FOR UPDATE lock
        $result = $repo->softDelete($id, $authUser['username']);

        if ($result['code'] !== ReceiptRepository::RESULT_OK) {
            $db->rollBack();
            mapResult($result['code']);
            return;
        }

        bumpVersions($db, ['receipts', 'vehicle_ledger', 'treasury', 'offices', 'vehicle_owners']);
        $db->commit();
        mapResult('OK', ['id' => $id], 'تم حذف النموذج بنجاح');

    } catch (Exception $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }

} catch (PDOException $e) {
    error_log('[RECEIPT DELETE] ' . $e->getMessage());
    $debugMsg = 'خطأ في الخادم';
    $appCfg = require __DIR__ . '/../../../config/app.php';
    if (!empty($appCfg['debug'])) $debugMsg .= ' — ' . $e->getMessage();
    jsonError($debugMsg, 500);
}
