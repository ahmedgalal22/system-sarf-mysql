<?php
/**
 * test_server_failure_v2.php — Server failure mode validation
 *
 * Validates that the API returns proper error structures,
 * and that SERVER_OWNED domains fail explicitly (no silent fallback).
 */

require_once __DIR__ . '/config_test_env.php';
setModule('SERVER_FAILURE');

function run_server_failure_tests(): void {
    $cookie = loginAs(TEST_ADMIN_USER, TEST_ADMIN_PASS);
    assert_true($cookie !== null, 'Admin login for failure tests');
    if (!$cookie) return;

    // ── Invalid JSON body ─────────────────────────────────────────────────
    $ch = curl_init(API_BASE . '/entities/receipts/create.php');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CUSTOMREQUEST  => 'POST',
        CURLOPT_POSTFIELDS     => 'not-json{{{',
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_COOKIEFILE     => $cookie,
        CURLOPT_COOKIEJAR      => $cookie,
    ]);
    $raw = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    assert_http(400, $code, 'Invalid JSON body returns 400');
    $decoded = json_decode($raw, true);
    assert_true(($decoded['success'] ?? true) === false, 'Invalid JSON returns success=false');

    // ── Missing required fields ───────────────────────────────────────────
    $missingRes = authRequest('POST', '/entities/receipts/create.php', [
        // Missing uuid, request_id
        'client_name' => 'Test',
    ], $cookie);
    assert_true(($missingRes['success'] ?? true) === false, 'Missing uuid returns error');
    assert_true($missingRes['status'] === 400, 'Missing required field returns 400');

    // ── Wrong HTTP method ─────────────────────────────────────────────────
    $wrongMethod = authRequest('GET', '/entities/receipts/create.php', null, $cookie);
    assert_http(405, $wrongMethod['status'], 'GET on create endpoint returns 405');

    // ── Update non-existent receipt ───────────────────────────────────────
    $noExist = authRequest('PUT', '/entities/receipts/update.php', [
        'id' => 999999999, 'client_name' => 'Ghost',
    ], $cookie);
    assert_true(!($noExist['success'] ?? true), 'Update non-existent receipt fails');

    // ── Delete non-existent receipt ───────────────────────────────────────
    $noExistDel = authRequest('DELETE', '/entities/receipts/delete.php', [
        'id' => 999999999,
    ], $cookie);
    assert_true(!($noExistDel['success'] ?? true), 'Delete non-existent receipt fails');

    // ── Response structure validation ─────────────────────────────────────
    $errorRes = authRequest('POST', '/entities/receipts/create.php', [], $cookie);
    assert_true(isset($errorRes['success']), 'Error response has "success" field');
    assert_true(isset($errorRes['message']), 'Error response has "message" field');
}
