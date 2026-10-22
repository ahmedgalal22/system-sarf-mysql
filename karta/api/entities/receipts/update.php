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
require_once __DIR__ . '/../../../core/permissions.php';
require_once __DIR__ . '/../../../core/errorMapper.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/ReceiptRepository.php';
require_once __DIR__ . '/../../../core/versionTracker.php';

if (!isMethod('PUT')) jsonMethodNotAllowed('PUT');
requirePermission($authUser['role'], 'receipts', 'write');

$body = requireJsonBody();

$id = validatePositiveInt($body['id'] ?? 0, 'معرف النموذج');

try {
    $db = getDB();
    $repo = new ReceiptRepository($db);

    $db->beginTransaction();

    try {
        $patch = [];
        $allowed = [
            'receipt_date', 'client_id', 'client_type', 'client_name',
            'payout_status', 'paid_at', 'account_type',
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

        bumpVersion($db, 'receipts');
        $db->commit();
        $updated = $result['data'];
        decodeRowsField($updated);
        mapResult('OK', $updated, 'تم تحديث النموذج بنجاح');

    } catch (Exception $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }

} catch (PDOException $e) {
    error_log('[RECEIPT UPDATE] ' . $e->getMessage());
    $debugMsg = 'خطأ في الخادم';
    $appCfg = require __DIR__ . '/../../../config/app.php';
    if (!empty($appCfg['debug'])) $debugMsg .= ' — ' . $e->getMessage();
    jsonError($debugMsg, 500);
}
