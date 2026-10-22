<?php
/**
 * POST /api/financial/bolsa-create.php
 *
 * Atomic: BEGIN → create bolsa + update agent balance + create treasury → COMMIT
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

try {
    $db = getDB();
    $bolsaRepo = new BolsaFormRepository($db);
    $agentRepo = new AgentRepository($db);
    $treasuryRepo = new TreasuryRepo($db);

    $db->beginTransaction();
    try {
        // Create bolsa form
        $bolsa = $bolsaRepo->create([
            'uuid' => $body['uuid'] ?? $body['id'] ?? null,
            'username' => $username,
            'agent_id' => $body['agent_id'] ?? null,
            'bolsa_date' => $body['bolsa_date'] ?? null,
            'rows' => $body['rows'] ?? [],
            'totals' => $body['totals'] ?? [],
            'amount' => intval($body['amount'] ?? 0),
        ]);

        // Update agent balance
        $agentId = intval($body['agent_id'] ?? 0);
        if ($agentId > 0 && isset($body['agent_balance_delta'])) {
            $stmt = $db->prepare('SELECT balance FROM agents WHERE id = :id FOR UPDATE');
            $stmt->execute([':id' => $agentId]);
            $agent = $stmt->fetch();
            if ($agent) {
                $newBal = intval($agent['balance'] ?? 0) + intval($body['agent_balance_delta']);
                $agentRepo->update($agentId, ['balance' => $newBal], $username);
            }
        }

        // Create treasury entry
        $treasuryEntry = null;
        if (!empty($body['treasury_op']) && is_array($body['treasury_op'])) {
            $body['treasury_op']['username'] = $username;
            $treasuryEntry = $treasuryRepo->create($body['treasury_op']);
        }

        bumpVersions($db, ['bolsa_forms', 'agents', 'treasury']);
        $db->commit();
        jsonSuccess([
            'bolsa' => $bolsa,
            'treasury' => $treasuryEntry,
        ], 'تم الإنشاء بنجاح', 201);

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL BOLSA-CREATE] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
