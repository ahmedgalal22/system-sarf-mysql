<?php
/**
 * test_idempotency_v2.php — Request idempotency validation
 *
 * Submits the SAME request_id multiple times.
 * Must return the SAME receipt, never create duplicates.
 */

require_once __DIR__ . '/config_test_env.php';
setModule('IDEMPOTENCY');

function run_idempotency_tests(): void {
    $cookie = loginAs(TEST_ADMIN_USER, TEST_ADMIN_PASS);
    assert_true($cookie !== null, 'Admin login for idempotency test');
    if (!$cookie) return;

    $requestId = testUUID();
    $uuid = testUUID();

    $payload = [
        'uuid'        => $uuid,
        'request_id'  => $requestId,
        'receipt_date' => '2025-02-01',
        'client_name' => 'Idempotency Test',
        'total'       => 50000,
        'net_due'     => 50000,
        'net_total'   => 50000,
        'paid'        => 0,
        'rows'        => [],
    ];

    // First submission — should create
    $res1 = authRequest('POST', '/entities/receipts/create.php', $payload, $cookie);
    assert_true($res1['success'] ?? false, 'First create succeeds');
    assert_true(in_array($res1['status'], [200, 201]), 'First create returns 200 or 201');

    $firstId = $res1['data']['id'] ?? null;
    $firstNumber = $res1['data']['receipt_number'] ?? null;
    assert_true($firstId !== null, 'First create returns receipt ID');

    // Second submission — same request_id — must return SAME receipt
    $res2 = authRequest('POST', '/entities/receipts/create.php', $payload, $cookie);
    assert_true($res2['success'] ?? false, 'Second (idempotent) create succeeds');

    $secondId = $res2['data']['id'] ?? null;
    $secondNumber = $res2['data']['receipt_number'] ?? null;

    assert_equals($firstId, $secondId, 'Same receipt ID returned on retry');
    assert_equals($firstNumber, $secondNumber, 'Same receipt_number returned on retry');

    // Third submission — triple check
    $res3 = authRequest('POST', '/entities/receipts/create.php', $payload, $cookie);
    assert_equals($firstId, $res3['data']['id'] ?? null, 'Third retry returns same ID');

    // Verify only ONE record in database
    $db = getTestDB();
    $stmt = $db->prepare("SELECT COUNT(*) as cnt FROM receipts WHERE request_id = ? AND deleted_at IS NULL");
    $stmt->execute([$requestId]);
    $count = $stmt->fetch()['cnt'];
    assert_equals(1, (int)$count, 'Exactly 1 record in DB despite 3 submissions');

    // Cleanup
    $db->prepare("DELETE FROM receipts WHERE uuid = ?")->execute([$uuid]);
}
