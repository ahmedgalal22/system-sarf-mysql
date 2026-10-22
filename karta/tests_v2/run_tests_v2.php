<?php
/**
 * run_tests_v2.php — Master Test Runner
 *
 * Executes all test modules and produces a full report.
 *
 * Usage:
 *   Browser: http://localhost/<project>/karta/tests_v2/run_tests_v2.php
 *   CLI:     cd C:\xampp\htdocs\<project>\karta && php tests_v2/run_tests_v2.php
 *   Override: set KARTA_API_BASE=http://localhost/system52/karta/api
 *
 * Output: JSON report + human-readable summary
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');
set_time_limit(300); // 5 minutes max

$isCli = php_sapi_name() === 'cli';
if (!$isCli) {
    header('Content-Type: text/plain; charset=utf-8');
}

echo "═══════════════════════════════════════════════════\n";
echo "  Karta ERP — Phase 4.1 System Validation Suite\n";
echo "═══════════════════════════════════════════════════\n\n";

// ── Load framework ────────────────────────────────────────────────────────────
require_once __DIR__ . '/config_test_env.php';

// ── Environment check ─────────────────────────────────────────────────────────
echo "── Environment Validation ──\n";
if (!validateEnvironment()) {
    echo "\n❌ ENVIRONMENT VALIDATION FAILED — Cannot run tests.\n";
    echo "   Fix the issues above and try again.\n";
    exit(1);
}
echo "\n";

// ── Load test modules ─────────────────────────────────────────────────────────
require_once __DIR__ . '/test_permission_v2.php';
require_once __DIR__ . '/test_idempotency_v2.php';
require_once __DIR__ . '/test_conflict_v2.php';
require_once __DIR__ . '/test_soft_delete_v2.php';
require_once __DIR__ . '/test_archive_lock_v2.php';
require_once __DIR__ . '/test_server_failure_v2.php';
require_once __DIR__ . '/test_concurrency_v2.php';
require_once __DIR__ . '/test_load_v2.php';

// ── Execute tests ─────────────────────────────────────────────────────────────
$modules = [
    'PERMISSION'     => 'run_permission_tests',
    'IDEMPOTENCY'    => 'run_idempotency_tests',
    'CONFLICT'       => 'run_conflict_tests',
    'SOFT_DELETE'    => 'run_soft_delete_tests',
    'ARCHIVE_LOCK'   => 'run_archive_lock_tests',
    'SERVER_FAILURE' => 'run_server_failure_tests',
    'CONCURRENCY'    => 'run_concurrency_tests',
    'LOAD_TEST'      => 'run_load_tests',
];

foreach ($modules as $name => $fn) {
    echo "── Running: {$name} ──\n";
    setModule($name);
    try {
        $fn();
        echo "   Done.\n";
    } catch (Throwable $e) {
        echo "   ❌ EXCEPTION: " . $e->getMessage() . "\n";
        global $_TEST_RESULTS, $_CURRENT_MODULE;
        $_TEST_RESULTS[] = [
            'module' => $_CURRENT_MODULE,
            'label'  => 'Module execution',
            'pass'   => false,
            'reason' => 'Exception: ' . $e->getMessage(),
        ];
    }
    echo "\n";
}

// ── Generate Report ───────────────────────────────────────────────────────────
$results = getResults();
$total = count($results);
$passed = count(array_filter($results, fn($r) => $r['pass']));
$failed = $total - $passed;

echo "═══════════════════════════════════════════════════\n";
echo "  TEST RESULTS\n";
echo "═══════════════════════════════════════════════════\n\n";

// Per-module summary
$byModule = [];
foreach ($results as $r) {
    $m = $r['module'];
    if (!isset($byModule[$m])) $byModule[$m] = ['pass' => 0, 'fail' => 0, 'failures' => []];
    if ($r['pass']) {
        $byModule[$m]['pass']++;
    } else {
        $byModule[$m]['fail']++;
        $byModule[$m]['failures'][] = $r['label'] . ($r['reason'] ? " ({$r['reason']})" : '');
    }
}

foreach ($byModule as $module => $stats) {
    $icon = $stats['fail'] === 0 ? '✅' : '❌';
    echo "  {$icon} {$module}: {$stats['pass']} passed, {$stats['fail']} failed\n";
    foreach ($stats['failures'] as $f) {
        echo "      ↳ FAIL: {$f}\n";
    }
}

echo "\n─────────────────────────────────────────────────\n";
echo "  Total:  {$total}\n";
echo "  Passed: {$passed}\n";
echo "  Failed: {$failed}\n";
echo "─────────────────────────────────────────────────\n\n";

$verdict = $failed === 0 ? '✅ SYSTEM STABLE' : '❌ SYSTEM NOT STABLE';
echo "  FINAL VERDICT: {$verdict}\n\n";

// ── Save JSON report ──────────────────────────────────────────────────────────
$report = [
    'timestamp' => date('Y-m-d H:i:s'),
    'api_base'  => API_BASE,
    'total'     => $total,
    'passed'    => $passed,
    'failed'    => $failed,
    'verdict'   => $failed === 0 ? 'STABLE' : 'NOT_STABLE',
    'modules'   => $byModule,
    'details'   => $results,
];

$reportPath = __DIR__ . '/report_' . date('Y-m-d_His') . '.json';
file_put_contents($reportPath, json_encode($report, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
echo "  Report saved: {$reportPath}\n";

exit($failed === 0 ? 0 : 1);
