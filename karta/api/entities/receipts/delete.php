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

if (!isMethod('DELETE')) jsonMethodNotAllowed('DELETE');
requirePermission($authUser['role'], 'receipts', 'delete');

$body = requireJsonBody();

$id = intval($body['id'] ?? 0);
if ($id <= 0) jsonError('معرف النموذج مطلوب', 400);

try {
    $db = getDB();
    $repo = new ReceiptRepository($db);

    // Pre-check outside transaction (fast 404 + ownership)
    $existing = $repo->findById($id);
    if (!$existing) {
        mapResult('NOT_FOUND');
    }
    if ($existing['username'] !== $authUser['username']) {
        mapResult('FORBIDDEN', null, 'غير مسموح بالحذف');
    }

    $db->beginTransaction();

    try {
        // softDelete re-checks under FOR UPDATE lock
        $result = $repo->softDelete($id, $authUser['username']);

        if ($result['code'] !== ReceiptRepository::RESULT_OK) {
            $db->rollBack();
            mapResult($result['code']);
            return;
        }

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
