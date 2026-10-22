<?php
/**
 * POST /api/financial/bolsa-update.php
 *
 * Atomic: BEGIN → reverse old treasury + restore agent + update bolsa + apply new → COMMIT
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
        // Row lock: prevent concurrent edits on the same bolsa form
        $lockStmt = $db->prepare('SELECT id FROM bolsa_forms WHERE id = :id AND deleted_at IS NULL FOR UPDATE');
        $lockStmt->execute([':id' => $bolsaId]);
        if (!$lockStmt->fetch()) { $db->rollBack(); jsonError('البولصة غير موجودة', 404); }

        $existing = $bolsaRepo->getById($bolsaId);
        if (!$existing) { $db->rollBack(); jsonError('البولصة غير موجودة', 404); }
        if ($existing['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }

        // Reverse old treasury entries — use UUID (financial reference identity)
        $bolsaUuid = $existing['uuid'] ?? '';
        $treasuryRepo->reverseByReference($bolsaUuid, 'bolsa', $username);

        // Apply agent balance DELTAS — PHP reads current balance with FOR UPDATE
        if (!empty($body['agent_balance_ops']) && is_array($body['agent_balance_ops'])) {
            foreach ($body['agent_balance_ops'] as $aop) {
                $aid = intval($aop['id'] ?? 0);
                $delta = intval($aop['delta'] ?? 0);
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
        }

        // Update bolsa form
        $patch = [];
        foreach (['agent_id','bolsa_date','rows','totals','amount'] as $f) {
            if (array_key_exists($f, $body)) $patch[$f] = $body[$f];
        }
        $updated = $bolsaRepo->update($bolsaId, $patch, $username);

        // Create new treasury entry
        $treasuryEntry = null;
        if (!empty($body['treasury_op'])) {
            $body['treasury_op']['username'] = $username;
            $treasuryEntry = $treasuryRepo->create($body['treasury_op']);
        }

        bumpVersions($db, ['bolsa_forms', 'agents', 'treasury']);
        $db->commit();
        jsonSuccess(['bolsa' => $updated, 'treasury' => $treasuryEntry]);

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL BOLSA-UPDATE] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
