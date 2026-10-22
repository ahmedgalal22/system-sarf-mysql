<?php
/**
 * test_soft_delete_v2.php — Soft delete correctness
 *
 * Validates: deleted_at + deleted_by set, record excluded from list,
 * record still exists in DB.
 */

require_once __DIR__ . '/config_test_env.php';
setModule('SOFT_DELETE');

function run_soft_delete_tests(): void {
    $cookie = loginAs(TEST_ADMIN_USER, TEST_ADMIN_PASS);
    assert_true($cookie !== null, 'Admin login for soft delete test');
    if (!$cookie) return;

    $uuid = testUUID();

    // Create
    $create = authRequest('POST', '/entities/receipts/create.php', [
        'uuid' => $uuid, 'request_id' => testUUID(),
        'receipt_date' => '2025-04-01', 'client_name' => 'Delete Test',
        'total' => 5000, 'net_due' => 5000, 'net_total' => 5000, 'paid' => 0, 'rows' => [],
    ], $cookie);

    assert_true($create['success'] ?? false, 'Create receipt for delete test');
    $id = $create['data']['id'] ?? null;

    // Delete
    $del = authRequest('DELETE', '/entities/receipts/delete.php', ['id' => $id], $cookie);
    assert_true($del['success'] ?? false, 'Soft delete succeeds');

    // Verify NOT in list
    $list = authRequest('GET', '/entities/receipts/list.php', null, $cookie);
    $found = false;
    foreach (($list['data'] ?? []) as $r) {
        if (($r['id'] ?? '') == $id) { $found = true; break; }
    }
    assert_true(!$found, 'Deleted receipt NOT in list endpoint');

    // Verify STILL in database with deleted_at set
    $db = getTestDB();
    $stmt = $db->prepare("SELECT deleted_at, deleted_by FROM receipts WHERE id = ?");
    $stmt->execute([$id]);
    $row = $stmt->fetch();

    assert_true($row !== false, 'Record still exists in DB (soft deleted)');
    assert_true(!empty($row['deleted_at']), 'deleted_at is set');
    assert_equals(TEST_ADMIN_USER, $row['deleted_by'], 'deleted_by = authenticated user');

    // Cleanup (hard delete for test data)
    $db->prepare("DELETE FROM receipts WHERE uuid = ?")->execute([$uuid]);
}
