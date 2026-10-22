<?php
/**
 * config_test_env.php — Test environment configuration & helpers
 *
 * Provides: API base detection, DB read-only connection, HTTP helpers,
 * session management, assertion framework.
 *
 * ALL tests use this as their foundation.
 */

// ── Environment Detection ─────────────────────────────────────────────────────

function detectApiBase(): string {
    // Priority 1: Explicit environment variable
    $env = getenv('KARTA_API_BASE');
    if ($env) return rtrim($env, '/');

    // Priority 2: Auto-detect from filesystem location
    // This file lives at: <docroot>/<project>/karta/tests_v2/config_test_env.php
    // We need to find the project folder name relative to htdocs
    $thisDir = str_replace('\\', '/', __DIR__);

    // Find 'htdocs' in path to determine the web-relative path
    $htdocsPos = strpos($thisDir, 'htdocs/');
    if ($htdocsPos !== false) {
        // Extract everything after htdocs/ up to /tests_v2
        $webPath = substr($thisDir, $htdocsPos + 7); // after "htdocs/"
        // Remove /tests_v2 from end → gives "system52/karta" or "karta"
        $webPath = preg_replace('#/tests_v2$#', '', $webPath);
        $host = $_SERVER['HTTP_HOST'] ?? $_SERVER['SERVER_NAME'] ?? 'localhost';
        $port = $_SERVER['SERVER_PORT'] ?? '80';
        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $base = "{$scheme}://{$host}";
        if ($port !== '80' && $port !== '443') $base .= ":{$port}";
        return "{$base}/{$webPath}/api";
    }

    // Priority 3: Fallback — try to detect from SCRIPT_FILENAME
    $script = $_SERVER['SCRIPT_FILENAME'] ?? '';
    $script = str_replace('\\', '/', $script);
    $htdocsPos2 = strpos($script, 'htdocs/');
    if ($htdocsPos2 !== false) {
        $rel = substr($script, $htdocsPos2 + 7);
        $parts = explode('/', $rel);
        // Walk up from script to find 'karta' folder
        $kartaPath = [];
        foreach ($parts as $p) {
            if ($p === 'tests_v2' || str_ends_with($p, '.php')) break;
            $kartaPath[] = $p;
        }
        $webPath = implode('/', $kartaPath);
        return "http://localhost/{$webPath}/api";
    }

    // Priority 4: Derive from current application directory name
    $appFolder = basename(dirname(__DIR__));
    return "http://localhost/{$appFolder}/api";
}

define('API_BASE', detectApiBase());
define('TEST_ADMIN_USER', 'admin');
define('TEST_ADMIN_PASS', 'admin123');
define('TEST_ACCOUNTANT_USER', 'accountant');
define('TEST_ACCOUNTANT_PASS', 'accountant123');

// ── Database Connection (READ-ONLY for verification) ──────────────────────────

function getTestDB(): PDO {
    static $pdo = null;
    if ($pdo === null) {
        $dbConfig = require __DIR__ . '/../config/database.php';
        $dsn = "mysql:host={$dbConfig['host']};port={$dbConfig['port']};dbname={$dbConfig['dbname']};charset={$dbConfig['charset']}";
        $pdo = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], $dbConfig['options']);
    }
    return $pdo;
}

// ── HTTP Client ───────────────────────────────────────────────────────────────

/**
 * Make an HTTP request to the API. Returns normalized response.
 * Supports session persistence via cookie jar.
 */
function apiRequest(string $method, string $endpoint, ?array $body = null, ?string $cookieJar = null): array {
    $url = API_BASE . $endpoint;
    $ch = curl_init();

    curl_setopt_array($ch, [
        CURLOPT_URL            => $url,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_CUSTOMREQUEST  => strtoupper($method),
        CURLOPT_HTTPHEADER     => [
            'Content-Type: application/json',
            'Accept: application/json',
        ],
    ]);

    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }

    // Session cookie persistence
    $jar = $cookieJar ?? tempnam(sys_get_temp_dir(), 'karta_test_');
    curl_setopt($ch, CURLOPT_COOKIEFILE, $jar);
    curl_setopt($ch, CURLOPT_COOKIEJAR, $jar);

    $raw = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);

    if ($raw === false) {
        return ['success' => false, 'status' => 0, 'data' => null, 'message' => "CURL error: {$error}", '_cookie' => $jar];
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return ['success' => false, 'status' => $httpCode, 'data' => null, 'message' => "Invalid JSON: " . substr($raw, 0, 200), '_cookie' => $jar];
    }

    $decoded['status'] = $httpCode;
    $decoded['_cookie'] = $jar;
    return $decoded;
}

/**
 * Login and return cookie jar path for authenticated requests.
 */
function loginAs(string $username, string $password): ?string {
    $res = apiRequest('POST', '/auth/login.php', [
        'username' => $username,
        'password' => $password,
    ]);
    if ($res['success'] ?? false) {
        return $res['_cookie'];
    }
    return null;
}

/**
 * Make an authenticated request.
 */
function authRequest(string $method, string $endpoint, ?array $body, string $cookie): array {
    return apiRequest($method, $endpoint, $body, $cookie);
}

// ── UUID Generator ────────────────────────────────────────────────────────────

function testUUID(): string {
    $data = random_bytes(16);
    $data[6] = chr(ord($data[6]) & 0x0f | 0x40);
    $data[8] = chr(ord($data[8]) & 0x3f | 0x80);
    return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($data), 4));
}

// ── Assertion Framework ───────────────────────────────────────────────────────

$_TEST_RESULTS = [];
$_CURRENT_MODULE = '';

function setModule(string $name): void {
    global $_CURRENT_MODULE;
    $_CURRENT_MODULE = $name;
}

function assert_true(bool $condition, string $label): void {
    global $_TEST_RESULTS, $_CURRENT_MODULE;
    $_TEST_RESULTS[] = [
        'module' => $_CURRENT_MODULE,
        'label'  => $label,
        'pass'   => $condition,
        'reason' => $condition ? '' : 'Assertion failed',
    ];
}

function assert_equals($expected, $actual, string $label): void {
    global $_TEST_RESULTS, $_CURRENT_MODULE;
    $pass = $expected === $actual;
    $_TEST_RESULTS[] = [
        'module' => $_CURRENT_MODULE,
        'label'  => $label,
        'pass'   => $pass,
        'reason' => $pass ? '' : "Expected " . json_encode($expected) . ", got " . json_encode($actual),
    ];
}

function assert_http(int $expected, int $actual, string $label): void {
    assert_equals($expected, $actual, "{$label} [HTTP {$expected}]");
}

function getResults(): array {
    global $_TEST_RESULTS;
    return $_TEST_RESULTS;
}

// ── Environment Sanity Check ──────────────────────────────────────────────────

function validateEnvironment(): bool {
    echo "Environment: " . API_BASE . "\n";

    // Check API reachable
    $health = apiRequest('GET', '/health/ping.php');
    if (!($health['success'] ?? false)) {
        echo "❌ API not reachable\n";
        return false;
    }
    echo "✅ API reachable\n";

    // Check MySQL
    if (($health['data']['mysql'] ?? '') !== 'connected') {
        echo "❌ MySQL not connected\n";
        return false;
    }
    echo "✅ MySQL connected\n";

    // Check DB direct
    try {
        $db = getTestDB();
        $db->query('SELECT 1');
        echo "✅ Direct DB connection OK\n";
    } catch (Exception $e) {
        echo "❌ Direct DB error: " . $e->getMessage() . "\n";
        return false;
    }

    // Check login
    $cookie = loginAs(TEST_ADMIN_USER, TEST_ADMIN_PASS);
    if (!$cookie) {
        echo "❌ Admin login failed\n";
        return false;
    }
    echo "✅ Admin login OK\n";

    return true;
}
