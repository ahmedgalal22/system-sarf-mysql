<?php
/**
 * GET /api/archive/list.php
 *
 * Returns all archive batches with inline snapshots.
 * Phase 8A: Optimized from N+1 (1 snapshot query per batch) to 2 total queries.
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/ArchiveRepository.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');

try {
    $db = getDB();
    $repo = new ArchiveRepository($db);
    $username = $authUser['username'];

    // Query 1: all batches
    $batches = $repo->listBatches($username);

    if (empty($batches)) {
        jsonSuccess([]);
    }

    // Query 2: all snapshots for this user's batches in ONE query
    $batchUuids = array_column($batches, 'uuid');
    $placeholders = implode(',', array_fill(0, count($batchUuids), '?'));
    $stmt = $db->prepare(
        "SELECT * FROM financial_snapshots
         WHERE archive_batch_id IN ($placeholders)
           AND deleted_at IS NULL
         ORDER BY created_at DESC"
    );
    $stmt->execute($batchUuids);
    $allSnapshots = $stmt->fetchAll();

    // Decode JSON + index by batch UUID (latest snapshot per batch)
    $snapMap = [];
    foreach ($allSnapshots as $snap) {
        $bid = $snap['archive_batch_id'];
        if (!isset($snapMap[$bid])) {
            if (isset($snap['client_balances']) && is_string($snap['client_balances'])) {
                $snap['client_balances'] = json_decode($snap['client_balances'], true) ?? [];
            }
            $snapMap[$bid] = $snap;
        }
    }

    // Attach snapshots inline
    foreach ($batches as &$b) {
        $b['snapshot'] = $snapMap[$b['uuid']] ?? null;
    }

    jsonSuccess($batches);
} catch (Exception $e) {
    error_log('[ARCHIVE LIST] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
