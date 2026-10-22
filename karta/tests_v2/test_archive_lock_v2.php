<?php
/**
 * test_archive_lock_v2.php — Archive immutability enforcement
 *
 * Manually marks a receipt as archived, then attempts update/delete.
 * Server MUST reject with 403.
 */

require_once __DIR__ . '/config_test_env.php';
setModule('ARCHIVE_LOCK');

function run_archive_lock_tests(): void {
    $cookie = loginAs(TEST_ADMIN_USER, TEST_ADMIN_PASS);
    assert_true($cookie !== null, 'Admin login for archive lock test');
    if (!$cookie) return;

    $uuid = testUUID();

    // Create a receipt
    $create = authRequest('POST', '/entities/receipts/create.php', [
        'uuid' => $uuid, 'request_id' => testUUID(),
        'receipt_date' => '2025-05-01', 'client_name' => 'Archive Test',
        'total' => 7000, 'net_due' => 7000, 'net_total' => 7000, 'paid' => 0, 'rows' => [],
    ], $cookie);

    assert_true($create['success'] ?? false, 'Create receipt for archive test');
    $id = $create['data']['id'] ?? null;

    // Manually archive it in DB (simulate archive system)
    $db = getTestDB();
    $db->prepare("UPDATE receipts SET is_archived = 1, archive_batch_id = ? WHERE id = ?")
       ->execute([testUUID(), $id]);

    // Attempt UPDATE on archived receipt — must fail 403
    $updateRes = authRequest('PUT', '/entities/receipts/update.php', [
        'id' => $id, 'client_name' => 'Should Fail',
    ], $cookie);

    assert_http(403, $updateRes['status'], 'Update archived receipt returns 403');
    assert_equals('archived', $updateRes['type'] ?? '', 'Response type is "archived"');

    // Attempt DELETE on archived receipt — must fail 403
    $deleteRes = authRequest('DELETE', '/entities/receipts/delete.php', ['id' => $id], $cookie);
    assert_http(403, $deleteRes['status'], 'Delete archived receipt returns 403');

    // Verify record unchanged in DB
    $stmt = $db->prepare("SELECT client_name FROM receipts WHERE id = ?");
    $stmt->execute([$id]);
    $dbName = $stmt->fetch()['client_name'] ?? '';
    assert_equals('Archive Test', $dbName, 'Archived receipt data unchanged after rejected update');

    // Cleanup
    $db->prepare("DELETE FROM receipts WHERE uuid = ?")->execute([$uuid]);
}
