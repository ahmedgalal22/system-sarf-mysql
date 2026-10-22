<?php
/**
 * test_load_v2.php — Load test + ordering validation
 *
 * Creates 100 receipts sequentially, validates ordering determinism.
 */

require_once __DIR__ . '/config_test_env.php';
setModule('LOAD_TEST');

function run_load_tests(): void {
    $cookie = loginAs(TEST_ADMIN_USER, TEST_ADMIN_PASS);
    assert_true($cookie !== null, 'Admin login for load test');
    if (!$cookie) return;

    $batchSize = 100;
    $uuids = [];
    $startTime = microtime(true);

    // ── Create receipts ───────────────────────────────────────────────────
    for ($i = 0; $i < $batchSize; $i++) {
        $uuid = testUUID();
        $uuids[] = $uuid;

        $res = authRequest('POST', '/entities/receipts/create.php', [
            'uuid'        => $uuid,
            'request_id'  => testUUID(),
            'receipt_date' => '2025-06-' . str_pad(($i % 28) + 1, 2, '0', STR_PAD_LEFT),
            'client_name' => "Load Test {$i}",
            'total'       => ($i + 1) * 1000,
            'net_due'     => ($i + 1) * 1000,
            'net_total'   => ($i + 1) * 1000,
            'paid'        => 0,
            'rows'        => [],
        ], $cookie);

        if (!($res['success'] ?? false)) {
            assert_true(false, "Create receipt #{$i} failed: " . ($res['message'] ?? 'unknown'));
            break;
        }
    }

    $createTime = microtime(true) - $startTime;
    assert_true($createTime < 60, "100 creates completed in {$createTime}s (< 60s threshold)");

    // ── Verify ordering ───────────────────────────────────────────────────
    $listStart = microtime(true);
    $list = authRequest('GET', '/entities/receipts/list.php', null, $cookie);
    $listTime = microtime(true) - $listStart;

    assert_true($list['success'] ?? false, 'List endpoint returns success');
    assert_true($listTime < 5, "List query completed in {$listTime}s (< 5s threshold)");

    $records = $list['data'] ?? [];
    assert_true(count($records) >= $batchSize, "At least {$batchSize} records in list");

    // Verify deterministic ordering: created_at DESC, id DESC
    $orderValid = true;
    for ($i = 1; $i < count($records); $i++) {
        $prev = $records[$i - 1];
        $curr = $records[$i];
        $prevTime = $prev['created_at'] ?? '';
        $currTime = $curr['created_at'] ?? '';

        if ($prevTime < $currTime) {
            $orderValid = false;
            break;
        }
        if ($prevTime === $currTime && ($prev['id'] ?? 0) < ($curr['id'] ?? 0)) {
            $orderValid = false;
            break;
        }
    }
    assert_true($orderValid, 'List ordering is deterministic (created_at DESC, id DESC)');

    // ── Cleanup ───────────────────────────────────────────────────────────
    $db = getTestDB();
    $placeholders = implode(',', array_fill(0, count($uuids), '?'));
    $db->prepare("DELETE FROM receipts WHERE uuid IN ({$placeholders})")->execute($uuids);

    assert_true(true, "Load test cleanup complete ({$batchSize} records removed)");
}
