<?php
/**
 * test_concurrency_v2.php — Parallel receipt creation concurrency test
 *
 * Simulates 20 parallel receipt creation requests.
 * Validates: no duplicate receipt_numbers, no race corruption, all succeed.
 */

require_once __DIR__ . '/config_test_env.php';
setModule('CONCURRENCY');

function run_concurrency_tests(): void {
    $cookie = loginAs(TEST_ADMIN_USER, TEST_ADMIN_PASS);
    assert_true($cookie !== null, 'Admin login for concurrency test');
    if (!$cookie) return;

    $parallelCount = 20;
    $requestIds = [];
    $uuids = [];

    // Prepare unique request data
    for ($i = 0; $i < $parallelCount; $i++) {
        $requestIds[] = testUUID();
        $uuids[] = testUUID();
    }

    // Launch parallel requests using curl_multi
    $multiHandle = curl_multi_init();
    $handles = [];

    for ($i = 0; $i < $parallelCount; $i++) {
        $ch = curl_init();
        $body = json_encode([
            'uuid'         => $uuids[$i],
            'request_id'   => $requestIds[$i],
            'receipt_date'  => '2025-01-15',
            'client_name'  => "Concurrency Test Client {$i}",
            'total'        => ($i + 1) * 10000,
            'net_due'      => ($i + 1) * 10000,
            'net_total'    => ($i + 1) * 10000,
            'paid'         => 0,
            'rows'         => [],
        ]);

        curl_setopt_array($ch, [
            CURLOPT_URL            => API_BASE . '/entities/receipts/create.php',
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 30,
            CURLOPT_CUSTOMREQUEST  => 'POST',
            CURLOPT_POSTFIELDS     => $body,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json', 'Accept: application/json'],
            CURLOPT_COOKIEFILE     => $cookie,
            CURLOPT_COOKIEJAR      => $cookie,
        ]);

        curl_multi_add_handle($multiHandle, $ch);
        $handles[] = $ch;
    }

    // Execute all in parallel
    $running = null;
    do {
        curl_multi_exec($multiHandle, $running);
        curl_multi_select($multiHandle);
    } while ($running > 0);

    // Collect results
    $responses = [];
    $receiptNumbers = [];
    $successCount = 0;

    foreach ($handles as $ch) {
        $raw = curl_multi_getcontent($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_multi_remove_handle($multiHandle, $ch);
        curl_close($ch);

        $decoded = json_decode($raw, true);
        if (($decoded['success'] ?? false) && isset($decoded['data']['receipt_number'])) {
            $successCount++;
            $receiptNumbers[] = $decoded['data']['receipt_number'];
        }
        $responses[] = ['status' => $httpCode, 'data' => $decoded];
    }

    curl_multi_close($multiHandle);

    // ── Assertions ────────────────────────────────────────────────────────
    assert_equals($parallelCount, $successCount,
        "All {$parallelCount} parallel creates succeeded");

    // No duplicate receipt numbers
    $uniqueNumbers = array_unique($receiptNumbers);
    assert_equals(count($receiptNumbers), count($uniqueNumbers),
        'No duplicate receipt_numbers across parallel requests');

    // Verify in database
    $db = getTestDB();
    $placeholders = implode(',', array_fill(0, count($uuids), '?'));
    $stmt = $db->prepare("SELECT uuid, receipt_number FROM receipts WHERE uuid IN ({$placeholders}) AND deleted_at IS NULL");
    $stmt->execute($uuids);
    $dbRows = $stmt->fetchAll();

    assert_equals($parallelCount, count($dbRows),
        "All {$parallelCount} receipts exist in database");

    $dbNumbers = array_column($dbRows, 'receipt_number');
    $dbUniqueNumbers = array_unique($dbNumbers);
    assert_equals(count($dbNumbers), count($dbUniqueNumbers),
        'No duplicate receipt_numbers in database');

    // Cleanup test data
    foreach ($uuids as $uuid) {
        $db->prepare("DELETE FROM receipts WHERE uuid = ?")->execute([$uuid]);
    }
}
