<?php
/**
 * POST /api/financial/bolsa-delete.php
 *
 * Atomic: BEGIN → reverse treasury + restore agent balance + soft-delete bolsa → COMMIT
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/BolsaFormRepository.php';
require_once __DIR__ . '/../../repositories/AgentRepository.php';
require_once __DIR__ . '/../../repositories/TreasuryRepository2.php';
require_once __DIR__ . '/../../core/versionTracker.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');

$body = requireJsonBody();
$username = $authUser['username'];
$bolsaId = intval($body['bolsa_id'] ?? $body['id'] ?? 0);
if ($bolsaId <= 0) jsonError('معرف البولصة مطلوب', 400);

try {
    $db = getDB();
    $bolsaRepo = new BolsaFormRepository($db);
    $agentRepo = new AgentRepository($db);
    $treasuryRepo = new TreasuryRepo($db);

    $db->beginTransaction();
    try {
        // Row lock: prevent concurrent deletes/edits on the same bolsa form
        $lockStmt = $db->prepare('SELECT id FROM bolsa_forms WHERE id = :id AND deleted_at IS NULL FOR UPDATE');
        $lockStmt->execute([':id' => $bolsaId]);
        if (!$lockStmt->fetch()) { $db->rollBack(); jsonError('البولصة غير موجودة', 404); }

        $existing = $bolsaRepo->getById($bolsaId);
        if (!$existing) { $db->rollBack(); jsonError('البولصة غير موجودة', 404); }
        if ($existing['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }

        // Reverse treasury entries — use UUID (financial reference identity)
        $bolsaUuid = $existing['uuid'] ?? '';
        $treasuryRepo->reverseByReference($bolsaUuid, 'bolsa', $username);

        // Apply agent balance DELTA — PHP reads current balance with FOR UPDATE
        if (!empty($body['agent_id']) && isset($body['agent_balance_delta'])) {
            $aid = intval($body['agent_id']);
            $delta = intval($body['agent_balance_delta']);
            if ($aid > 0 && $delta !== 0) {
                $stmt = $db->prepare('SELECT balance FROM agents WHERE id = :id FOR UPDATE');
                $stmt->execute([':id' => $aid]);
                $agent = $stmt->fetch();
                if ($agent) {
                    $newBal = intval($agent['balance'] ?? 0) + $delta;
                    $agentRepo->update($aid, ['balance' => $newBal], $username);
                }
            }
        }

        // Soft-delete bolsa
        $bolsaRepo->softDelete($bolsaId, $username);

        bumpVersions($db, ['bolsa_forms', 'agents', 'treasury']);
        $db->commit();
        jsonSuccess(['id' => $bolsaId], 'تم الحذف بنجاح');

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL BOLSA-DELETE] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
