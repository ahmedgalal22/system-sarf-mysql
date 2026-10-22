<?php
/**
 * POST /api/entities/receipts/create.php
 *
 * ╔══════════════════════════════════════════════════════════════╗
 * ║  PRODUCTION LOCKED — Phase 4.8                              ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * IDEMPOTENCY CONTRACT:
 *   request_id = immutable operation identity.
 *   ┌────────────────────────┬──────────────────────────────────┐
 *   │ State                  │ Result                           │
 *   ├────────────────────────┼──────────────────────────────────┤
 *   │ request_id exists      │ return same response (DUPLICATE) │
 *   │ request_id new         │ create new receipt (CREATED)     │
 *   │ request_id race crash  │ DB UNIQUE handles it (DUPLICATE) │
 *   └────────────────────────┴──────────────────────────────────┘
 *
 * TRANSACTION MODEL:
 *   ensureCounterExists() — OUTSIDE tx (auto-commit, idempotent)
 *   BEGIN
 *     allocateReceiptNumber() — atomic UPDATE, InnoDB row lock
 *     insertReceipt() — INSERT with allocated number
 *   COMMIT — both succeed or both rollback
 *
 * NO financial calculations. NO external calls inside tx.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../core/validator.php';
require_once __DIR__ . '/../../../core/permissions.php';
require_once __DIR__ . '/../../../core/errorMapper.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/ReceiptRepository.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');
requirePermission($authUser['role'], 'receipts', 'write');

$body = requireJsonBody();

// ── Validation ────────────────────────────────────────────────────────────
$requestId = validateRequired($body['request_id'] ?? null, 'request_id');
$uuid      = validateRequired($body['uuid'] ?? null, 'uuid');

try {
    $db = getDB();
    $repo = new ReceiptRepository($db);

    // ── Idempotency pre-check (fast path, outside transaction) ────────────
    $existing = $repo->findByRequestId($requestId);
    if ($existing) {
        decodeRowsField($existing);
        mapResult('DUPLICATE', $existing);
    }

    // ── Counter init OUTSIDE transaction (prevents gap-lock deadlock) ─────
    $repo->ensureCounterExists($authUser['username']);

    // ── Transaction: allocate number + insert (atomic) ────────────────────
    $db->beginTransaction();

    try {
        $receiptNumber = $repo->allocateReceiptNumber($authUser['username']);

        $receipt = $repo->insertReceipt([
            'uuid'             => $uuid,
            'username'         => $authUser['username'],
            'receipt_number'   => $receiptNumber,
            'receipt_date'     => sanitizeString($body['receipt_date'] ?? null) ?: null,
            'client_id'        => sanitizeString($body['client_id'] ?? null) ?: null,
            'client_type'      => sanitizeString($body['client_type'] ?? null) ?: null,
            'client_name'      => sanitizeString($body['client_name'] ?? null) ?: null,
            'recipient_name'   => sanitizeString($body['recipient_name'] ?? null) ?: null,
            'company_name'     => sanitizeString($body['company_name'] ?? null) ?: null,
            'payout_status'    => sanitizeString($body['payout_status'] ?? null) ?: 'unpaid',
            'paid_at'          => sanitizeString($body['paid_at'] ?? null) ?: null,
            'account_type'     => sanitizeString($body['account_type'] ?? null) ?: null,
            'total'            => intval($body['total'] ?? 0),
            'net_due'          => intval($body['net_due'] ?? 0),
            'net_total'        => intval($body['net_total'] ?? 0),
            'paid'             => intval($body['paid'] ?? 0),
            'previous_balance' => intval($body['previous_balance'] ?? 0),
            'general_add'      => intval($body['general_add'] ?? 0),
            'rows'             => $body['rows'] ?? [],
            'notes'            => sanitizeString($body['notes'] ?? null) ?: null,
            'shipping_number'  => sanitizeString($body['shipping_number'] ?? null) ?: null,
            'request_id'       => $requestId,
            'created_by'       => $authUser['username'],
        ]);

        $db->commit();

        decodeRowsField($receipt);
        mapResult('CREATED', $receipt);

    } catch (PDOException $e) {
        if ($db->inTransaction()) $db->rollBack();

        // ── DB UNIQUE constraint caught a race condition ──────────────────
        // Two concurrent identical request_ids both passed pre-check.
        // The loser hits UNIQUE(request_id) or UNIQUE(uuid).
        // Find the winner's record and return it as DUPLICATE.
        if (strpos($e->getMessage(), '1062') !== false) {
            $dup = $repo->findByRequestId($requestId);
            if (!$dup) $dup = $repo->findByUuid($uuid);
            if ($dup) {
                decodeRowsField($dup);
                mapResult('DUPLICATE', $dup);
            }
        }

        throw $e;

    } catch (Exception $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }

} catch (PDOException $e) {
    error_log('[RECEIPT CREATE] ' . $e->getMessage());
    $debugMsg = 'خطأ في الخادم';
    $appCfg = require __DIR__ . '/../../../config/app.php';
    if (!empty($appCfg['debug'])) $debugMsg .= ' — ' . $e->getMessage();
    jsonError($debugMsg, 500);
} catch (Exception $e) {
    error_log('[RECEIPT CREATE GENERAL] ' . $e->getMessage());
    $debugMsg = 'خطأ غير متوقع';
    $appCfg = require __DIR__ . '/../../../config/app.php';
    if (!empty($appCfg['debug'])) $debugMsg .= ' — ' . $e->getMessage();
    jsonError($debugMsg, 500);
}
