<?php
/**
 * GET /api/health/ping.php
 *
 * Health check endpoint — verifies:
 *   1. PHP is running
 *   2. MySQL is reachable
 *   3. Session system works
 *
 * No authentication required.
 */

require_once __DIR__ . '/../../core/bootstrap.php';

if (!isMethod('GET')) {
    jsonMethodNotAllowed('GET');
}

$health = [
    'status'    => 'ok',
    'php'       => PHP_VERSION,
    'timestamp' => nowEgypt(),
    'timezone'  => date_default_timezone_get(),
    'session'   => session_status() === PHP_SESSION_ACTIVE ? 'active' : 'inactive',
    'mysql'     => 'unknown',
];

try {
    $db = getDB();
    $stmt = $db->query('SELECT 1');
    $health['mysql'] = 'connected';

    // Check if users table exists
    $tables = $db->query("SHOW TABLES LIKE 'users'")->fetchAll();
    $health['users_table'] = count($tables) > 0 ? 'exists' : 'missing';

} catch (PDOException $e) {
    $health['status'] = 'degraded';
    $health['mysql']  = 'error: ' . $e->getMessage();
}

$status = $health['status'] === 'ok' ? 200 : 503;
http_response_code($status);
echo json_encode([
    'success' => $health['status'] === 'ok',
    'message' => 'Karta ERP Health Check',
    'data'    => $health,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
exit;
