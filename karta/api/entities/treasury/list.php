<?php
/**
 * GET /api/entities/treasury/list.php
 *
 * Supports filters via query params:
 *   reference_id, agent_id, client_id, reference_type, is_reversed, effect
 *   All filters are optional. Without filters → returns all for user.
 */

require_once __DIR__ . '/../../../core/bootstrap.php';
require_once __DIR__ . '/../../../api/middleware/auth.php';
require_once __DIR__ . '/../../../repositories/TreasuryRepository2.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');

try {
    $db = getDB();
    $repo = new TreasuryRepo($db);
    $username = $authUser['username'];

    // Check for specific reference_id lookup (original behavior)
    $refId = sanitizeString($_GET['reference_id'] ?? null);
    if ($refId !== '') {
        jsonSuccess($repo->getByReference($refId));
    }

    // Build filtered query dynamically
    $sql = 'SELECT * FROM treasury WHERE username = :u AND deleted_at IS NULL AND is_archived = 0';
    $params = [':u' => $username];

    // Optional filters
    $agentId = sanitizeString($_GET['agent_id'] ?? null);
    if ($agentId !== '') {
        $sql .= ' AND agent_id = :agent_id';
        $params[':agent_id'] = $agentId;
    }

    $clientId = sanitizeString($_GET['client_id'] ?? null);
    if ($clientId !== '') {
        $sql .= ' AND client_id = :client_id';
        $params[':client_id'] = $clientId;
    }

    $refType = sanitizeString($_GET['reference_type'] ?? null);
    if ($refType !== '') {
        $sql .= ' AND reference_type = :reference_type';
        $params[':reference_type'] = $refType;
    }

    $effect = sanitizeString($_GET['effect'] ?? null);
    if ($effect !== '') {
        $sql .= ' AND effect = :effect';
        $params[':effect'] = $effect;
    }

    // is_reversed: accept 'false', '0', 'true', '1'
    $isReversed = $_GET['is_reversed'] ?? null;
    if ($isReversed !== null && $isReversed !== '') {
        $reversed = ($isReversed === 'true' || $isReversed === '1') ? 1 : 0;
        $sql .= ' AND is_reversed = :is_reversed';
        $params[':is_reversed'] = $reversed;
    }

    // include_archived flag
    $includeArchived = $_GET['include_archived'] ?? null;
    if ($includeArchived === '1' || $includeArchived === 'true') {
        // Remove the is_archived = 0 condition by rebuilding
        $sql = str_replace(' AND is_archived = 0', '', $sql);
    }

    $sql .= ' ORDER BY created_at DESC';

    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    jsonSuccess($stmt->fetchAll());

} catch (PDOException $e) {
    error_log('[TREASURY LIST] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
