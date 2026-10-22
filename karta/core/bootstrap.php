<?php
/**
 * core/bootstrap.php — System initialization
 *
 * This file MUST be required at the top of every API entry point.
 * It sets up: error handling, timezone, session, database connection.
 */

// ── Prevent direct browser access to PHP files ────────────────────────────────
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === 'bootstrap.php') {
    http_response_code(403);
    exit('Forbidden');
}

// ── Load configuration ────────────────────────────────────────────────────────
$appConfig     = require __DIR__ . '/../config/app.php';
$dbConfig      = require __DIR__ . '/../config/database.php';
$sessionConfig = require __DIR__ . '/../config/session.php';

// ── Timezone ──────────────────────────────────────────────────────────────────
date_default_timezone_set($appConfig['timezone']);

// ── Error handling ────────────────────────────────────────────────────────────
ini_set('display_errors', $appConfig['debug'] ? '1' : '0');
ini_set('display_startup_errors', $appConfig['debug'] ? '1' : '0');
error_reporting(E_ALL);

if ($appConfig['log_errors'] && $appConfig['log_file']) {
    ini_set('log_errors', '1');
    ini_set('error_log', $appConfig['log_file']);
}

// ── Session setup ─────────────────────────────────────────────────────────────
if (session_status() === PHP_SESSION_NONE) {
    $sp = $sessionConfig['save_path'] ?? '';
    if ($sp !== '') {
        session_save_path($sp);
    }

    ini_set('session.gc_maxlifetime', $sessionConfig['gc_maxlifetime']);

    session_set_cookie_params([
        'lifetime' => $sessionConfig['lifetime'],
        'path'     => $sessionConfig['path'],
        'domain'   => $sessionConfig['domain'],
        'secure'   => $sessionConfig['secure'],
        'httponly'  => $sessionConfig['httponly'],
        'samesite' => $sessionConfig['samesite'],
    ]);

    session_name($sessionConfig['name']);
    session_start();
}

// ── Database connection (singleton) ───────────────────────────────────────────
function getDB(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $c = $GLOBALS['dbConfig'];
        $dsn = "mysql:host={$c['host']};port={$c['port']};dbname={$c['dbname']};charset={$c['charset']}";
        $pdo = new PDO($dsn, $c['username'], $c['password'], $c['options']);
    }
    return $pdo;
}

// ── Load helpers ──────────────────────────────────────────────────────────────
require_once __DIR__ . '/response.php';
require_once __DIR__ . '/json.php';
require_once __DIR__ . '/security.php';
require_once __DIR__ . '/helpers.php';

// ── CORS for LAN (allow any origin on local network) ─────────────────────────
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if ($origin !== '') {
    header("Access-Control-Allow-Origin: {$origin}");
    header('Access-Control-Allow-Credentials: true');
    header('Access-Control-Allow-Headers: Content-Type, Accept');
    header('Access-Control-Allow-Methods: GET, POST, PUT, DELETE, OPTIONS');
}

// Handle CORS preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(204);
    exit;
}
