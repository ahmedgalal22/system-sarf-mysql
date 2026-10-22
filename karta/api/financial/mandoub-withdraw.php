<?php
/**
 * POST /api/financial/mandoub-withdraw.php
 *
 * Atomic: BEGIN → SELECT agent FOR UPDATE → update balance → insert treasury → COMMIT
 * Mandoub returns money → balance increases, treasury deposits
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/AgentRepository.php';
require_once __DIR__ . '/../../repositories/TreasuryRepository2.php';
require_once __DIR__ . '/../../core/versionTracker.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');

$body = requireJsonBody();
$username = $authUser['username'];
$agentId = intval($body['agent_id'] ?? 0);
$amount = intval($body['amount'] ?? 0);
$date = sanitizeString($body['date'] ?? null) ?: date('Y-m-d');
$note = sanitizeString($body['note'] ?? null) ?: '';
$treasuryType = $body['treasury_type'] ?? 'deposit';
$treasuryEffect = $body['treasury_effect'] ?? 'mandoub_cash_in';

if ($agentId <= 0) jsonError('معرف المندوب مطلوب', 400);
if ($amount <= 0) jsonError('المبلغ يجب أن يكون أكبر من صفر', 400);

try {
    $db = getDB();
    $agentRepo = new AgentRepository($db);
    $treasuryRepo = new TreasuryRepo($db);

    $db->beginTransaction();
    try {
        $stmt = $db->prepare('SELECT * FROM agents WHERE id = :id AND deleted_at IS NULL FOR UPDATE');
        $stmt->execute([':id' => $agentId]);
        $agent = $stmt->fetch();
        if (!$agent) { $db->rollBack(); jsonError('المندوب غير موجود', 404); }
        if ($agent['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }

        // Balance decrease (taking money FROM mandoub)
        $newBalance = intval($agent['balance'] ?? 0) - $amount;
        $agentRepo->update($agentId, ['balance' => $newBalance], $username);

        $treasuryEntry = $treasuryRepo->create([
            'username' => $username,
            'type' => $treasuryType,
            'effect' => $treasuryEffect,
            'amount' => $amount,
            'account_type' => 'cash',
            'reference_type' => 'mandoub_balance',
            'reference_id' => $body['reference_id'] ?? null,
            'agent_id' => strval($agentId),
            'client_id' => strval($agentId),
            'client_type' => 'mandoub',
            'client_name' => $agent['name'] ?? null,
            'date' => $date,
            'applied_at' => nowEgypt(),
            'is_reversed' => 0,
            'note' => $note,
        ]);

        bumpVersions($db, ['agents', 'treasury']);
        $db->commit();
        $updatedAgent = $agentRepo->getById($agentId);
        jsonSuccess(['agent' => $updatedAgent, 'treasury' => $treasuryEntry]);

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL MANDOUB-WITHDRAW] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
