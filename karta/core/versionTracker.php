<?php
/**
 * core/versionTracker.php — Data Version Tracking
 *
 * Increments the version counter for an entity in data_versions.
 * Used by sync infrastructure to detect changes across devices.
 *
 * RULES:
 *   - Receives the SAME PDO connection used by the calling operation.
 *   - If inside a transaction: bump is part of that transaction.
 *     Failure propagates (causes rollback) — financial integrity first.
 *   - If outside a transaction: bump is best-effort.
 *     Failure is logged but does not break the operation.
 *   - Never creates its own transaction.
 *   - Never affects business logic.
 */

if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === 'versionTracker.php') {
    http_response_code(403);
    exit('Forbidden');
}

/**
 * Bump version for a single entity.
 *
 * @param PDO    $db         The active database connection
 * @param string $entityName Entity key matching data_versions.entity_name
 */
function bumpVersion(PDO $db, string $entityName): void {
    $inTx = $db->inTransaction();
    try {
        $stmt = $db->prepare(
            'UPDATE data_versions SET version = version + 1, updated_at = NOW() WHERE entity_name = :name'
        );
        $stmt->execute([':name' => $entityName]);
    } catch (Exception $e) {
        if ($inTx) {
            // Inside transaction: let it propagate so the caller can rollback
            throw $e;
        }
        // Outside transaction: log and continue (non-critical)
        error_log('[VersionTracker] bump failed for ' . $entityName . ': ' . $e->getMessage());
    }
}

/**
 * Bump version for multiple entities at once.
 *
 * @param PDO   $db       The active database connection
 * @param array $entities Array of entity names
 */
function bumpVersions(PDO $db, array $entities): void {
    foreach ($entities as $entity) {
        bumpVersion($db, $entity);
    }
}
