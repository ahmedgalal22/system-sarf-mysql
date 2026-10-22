<?php
/**
 * POST /api/financial/mandoub-deposit.php
 *
 * Atomic: BEGIN → SELECT agent FOR UPDATE → update balance → insert treasury → COMMIT
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
$amount = intval($body['amount'] ?? 0); // cents
$date = sanitizeString($body['date'] ?? null) ?: date('Y-m-d');
$note = sanitizeString($body['note'] ?? null) ?: '';
$referenceId = $body['reference_id'] ?? null;
$effect = $body['effect'] ?? 'mandoub_cash_out';

if ($agentId <= 0) jsonError('معرف المندوب مطلوب', 400);
if ($amount <= 0) jsonError('المبلغ يجب أن يكون أكبر من صفر', 400);

try {
    $db = getDB();
    $agentRepo = new AgentRepository($db);
    $treasuryRepo = new TreasuryRepo($db);

    $db->beginTransaction();
    try {
        // Lock agent row
        $stmt = $db->prepare('SELECT * FROM agents WHERE id = :id AND deleted_at IS NULL FOR UPDATE');
        $stmt->execute([':id' => $agentId]);
        $agent = $stmt->fetch();
        if (!$agent) { $db->rollBack(); jsonError('المندوب غير موجود', 404); }
        if ($agent['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }

        // Update balance:
        // - bolsa_deduction (explicitly sent by deductFromAgent) → SUBTRACT
        // - manual deposit (effect key absent or 'mandoub_cash_out') → ADD
        $isBolsaDeduction = isset($body['effect']) && $body['effect'] === 'bolsa_deduction';
        if ($isBolsaDeduction) {
            $newBalance = intval($agent['balance'] ?? 0) - $amount;
        } else {
            $newBalance = intval($agent['balance'] ?? 0) + $amount;
        }
        $agentRepo->update($agentId, ['balance' => $newBalance], $username);

        // Create treasury entry
        $treasuryEntry = $treasuryRepo->create([
            'username' => $username,
            'type' => 'withdraw',
            'effect' => $effect,
            'amount' => $amount,
            'account_type' => 'cash',
            'reference_type' => $body['reference_type'] ?? 'mandoub_balance',
            'reference_id' => $referenceId,
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
        jsonSuccess([
            'agent' => $updatedAgent,
            'treasury' => $treasuryEntry,
        ], 'تمت العملية بنجاح');

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[FINANCIAL MANDOUB-DEPOSIT] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
