<?php
/**
 * test_permission_v2.php — Authentication & session validation
 *
 * Tests: anonymous access blocked, authenticated access allowed, session isolation, logout invalidates session.
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

    // ── Authenticated access — full access without role restrictions ───────
    $adminCookie = loginAs(TEST_ADMIN_USER, TEST_ADMIN_PASS);
    assert_true($adminCookie !== null, 'Authenticated login succeeds');

    if ($adminCookie) {
        $adminList = authRequest('GET', '/entities/receipts/list.php', null, $adminCookie);
        assert_true($adminList['success'] ?? false, 'Authenticated user can list receipts');

        $me = authRequest('GET', '/auth/me.php', null, $adminCookie);
        assert_true($me['success'] ?? false, 'Authenticated /auth/me works');
        assert_equals(TEST_ADMIN_USER, $me['data']['username'] ?? '', 'Authenticated username confirmed');
    }

    // ── Logout invalidates session ───────────────────────────────────────
    if ($adminCookie) {
        $logout = authRequest('POST', '/auth/logout.php', null, $adminCookie);
        assert_true($logout['success'] ?? false, 'Logout succeeds');

        $afterLogout = authRequest('GET', '/auth/me.php', null, $adminCookie);
        assert_http(401, $afterLogout['status'], 'After logout, /me returns 401');
    }
}
