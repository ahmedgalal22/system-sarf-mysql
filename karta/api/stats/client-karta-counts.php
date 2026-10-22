<?php
/**
 * GET /api/stats/client-karta-counts.php
 *
 * Returns unpaid karta (receipt row) counts grouped by client_type:client_id.
 * Replaces N × receipts/list.php calls with 1 lightweight query.
 *
 * Response: { success: true, data: { "owner:1": 5, "office:2": 12, ... } }
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');

try {
    $db = getDB();

    // Count non-separator rows per unpaid receipt per client — single query
    $stmt = $db->prepare(
        "SELECT client_id, client_type, `rows`
         FROM receipts
         WHERE username = :u
           AND deleted_at IS NULL
           AND payout_status = 'unpaid'
           AND client_id IS NOT NULL"
    );
    $stmt->execute([':u' => $authUser['username']]);
    $receipts = $stmt->fetchAll();

    $counts = [];
    foreach ($receipts as $r) {
        $ctype = $r['client_type'] ?? 'owner';
        $key = $ctype . ':' . $r['client_id'];
        $rows = json_decode($r['rows'] ?? '[]', true) ?: [];
        $rowCount = 0;
        foreach ($rows as $row) {
            if (($row['_type'] ?? '') !== 'separator') {
                $rowCount++;
            }
        }
        $counts[$key] = ($counts[$key] ?? 0) + $rowCount;
    }

    jsonSuccess($counts);

} catch (PDOException $e) {
    error_log('[STATS CLIENT KARTA] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
