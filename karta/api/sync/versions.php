<?php
/**
 * api/sync/versions.php — Data Version Polling Endpoint
 *
 * Returns the current version counter for every tracked entity.
 * READ-ONLY — no writes, no joins, no business logic.
 *
 * Response: { "vehicle_owners": N, "agents": N, ... }
 */
require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');

try {
    $db   = getDB();
    $stmt = $db->query('SELECT entity_name, version FROM data_versions');
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $versions = [];
    foreach ($rows as $row) {
        $versions[$row['entity_name']] = (int) $row['version'];
    }

    jsonSuccess($versions);
} catch (PDOException $e) {
    error_log('[SYNC VERSIONS] ' . $e->getMessage());
    jsonError('خطأ في قراءة إصدارات البيانات', 500);
}
