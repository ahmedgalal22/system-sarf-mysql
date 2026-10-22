<?php
/**
 * test_conflict_v2.php — Optimistic locking (409 Conflict) validation
 *
 * Creates a receipt, then attempts update with stale updated_at.
 * Must return 409 with latest record.
 */

require_once __DIR__ . '/config_test_env.php';
setModule('CONFLICT');

function run_conflict_tests(): void {
    $cookie = loginAs(TEST_ADMIN_USER, TEST_ADMIN_PASS);
    assert_true($cookie !== null, 'Admin login for conflict test');
    if (!$cookie) return;

    $uuid = testUUID();
    $requestId = testUUID();

    // Create a receipt
    $createRes = authRequest('POST', '/entities/receipts/create.php', [
        'uuid' => $uuid, 'request_id' => $requestId,
        'receipt_date' => '2025-03-01', 'client_name' => 'Conflict Test',
        'total' => 10000, 'net_due' => 10000, 'net_total' => 10000, 'paid' => 0, 'rows' => [],
    ], $cookie);

    assert_true($createRes['success'] ?? false, 'Create receipt for conflict test');
    $id = $createRes['data']['id'] ?? null;
    $updatedAt = $createRes['data']['updated_at'] ?? null;
    assert_true($id !== null, 'Receipt created with ID');

    // Update #1 — valid updated_at — should succeed
    $update1 = authRequest('PUT', '/entities/receipts/update.php', [
        'id' => $id, 'updated_at' => $updatedAt, 'client_name' => 'Updated Once',
    ], $cookie);
    assert_true($update1['success'] ?? false, 'First update succeeds with correct updated_at');

    $newUpdatedAt = $update1['data']['updated_at'] ?? null;
    assert_true($newUpdatedAt !== $updatedAt, 'updated_at changed after update');

    // Update #2 — stale updated_at (use the OLD one) — should return 409
    $update2 = authRequest('PUT', '/entities/receipts/update.php', [
        'id' => $id, 'updated_at' => $updatedAt, 'client_name' => 'Stale Update',
    ], $cookie);

    assert_http(409, $update2['status'], 'Stale update returns 409 Conflict');
    assert_true(isset($update2['latest']), '409 response includes latest record');

    if (isset($update2['latest'])) {
        assert_equals('Updated Once', $update2['latest']['client_name'] ?? '',
            'Latest record reflects the successful update');
    }

    // Verify DB state — should show first update's value
    $db = getTestDB();
    $stmt = $db->prepare("SELECT client_name FROM receipts WHERE id = ?");
    $stmt->execute([$id]);
    $dbName = $stmt->fetch()['client_name'] ?? '';
    assert_equals('Updated Once', $dbName, 'DB reflects first update, not stale update');

    // Cleanup
    $db->prepare("DELETE FROM receipts WHERE uuid = ?")->execute([$uuid]);
}
