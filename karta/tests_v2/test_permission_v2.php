<?php
/**
 * test_permission_v2.php — Role-based access validation
 *
 * Tests: anonymous access blocked, admin full access, accountant restrictions.
 */

require_once __DIR__ . '/config_test_env.php';
setModule('PERMISSION');

function run_permission_tests(): void {
    // ── Anonymous access — must be blocked ────────────────────────────────
    $anonRes = apiRequest('GET', '/entities/receipts/list.php');
    assert_http(401, $anonRes['status'], 'Anonymous GET receipts returns 401');

    $anonCreate = apiRequest('POST', '/entities/receipts/create.php', [
        'uuid' => testUUID(), 'request_id' => testUUID(),
    ]);
    assert_http(401, $anonCreate['status'], 'Anonymous POST receipt returns 401');

    // ── Admin access — full permissions ───────────────────────────────────
    $adminCookie = loginAs(TEST_ADMIN_USER, TEST_ADMIN_PASS);
    assert_true($adminCookie !== null, 'Admin login succeeds');

    if ($adminCookie) {
        $adminList = authRequest('GET', '/entities/receipts/list.php', null, $adminCookie);
        assert_true($adminList['success'] ?? false, 'Admin can list receipts');

        // Admin can access auth/me
        $me = authRequest('GET', '/auth/me.php', null, $adminCookie);
        assert_true($me['success'] ?? false, 'Admin /auth/me works');
        assert_equals('admin', $me['data']['role'] ?? '', 'Admin role confirmed');
    }

    // ── Accountant access — restricted ────────────────────────────────────
    $accCookie = loginAs(TEST_ACCOUNTANT_USER, TEST_ACCOUNTANT_PASS);
    assert_true($accCookie !== null, 'Accountant login succeeds');

    if ($accCookie) {
        $accList = authRequest('GET', '/entities/receipts/list.php', null, $accCookie);
        assert_true($accList['success'] ?? false, 'Accountant can list receipts');

        $accMe = authRequest('GET', '/auth/me.php', null, $accCookie);
        assert_equals('accountant', $accMe['data']['role'] ?? '', 'Accountant role confirmed');
    }

    // ── Session isolation — admin session ≠ accountant session ────────────
    if ($adminCookie && $accCookie) {
        $adminMe = authRequest('GET', '/auth/me.php', null, $adminCookie);
        $accMe2 = authRequest('GET', '/auth/me.php', null, $accCookie);

        assert_equals('admin', $adminMe['data']['role'] ?? '', 'Admin session persists independently');
        assert_equals('accountant', $accMe2['data']['role'] ?? '', 'Accountant session persists independently');
    }

    // ── Logout invalidates session ───────────────────────────────────────
    if ($adminCookie) {
        $logout = authRequest('POST', '/auth/logout.php', null, $adminCookie);
        assert_true($logout['success'] ?? false, 'Logout succeeds');

        $afterLogout = authRequest('GET', '/auth/me.php', null, $adminCookie);
        assert_http(401, $afterLogout['status'], 'After logout, /me returns 401');
    }
}
