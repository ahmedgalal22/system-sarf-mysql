<?php
/**
 * GET /api/auth/session.php
 *
 * Lightweight session check — no DB query.
 * Returns whether the user is currently logged in.
 */

require_once __DIR__ . '/../../core/bootstrap.php';

if (!isMethod('GET')) {
    jsonMethodNotAllowed('GET');
}

$user = getSessionUser();

if ($user !== null) {
    jsonSuccess([
        'logged_in' => true,
        'username'  => $user['username'],
        'role'      => $user['role'],
    ]);
} else {
    jsonSuccess([
        'logged_in' => false,
        'username'  => null,
        'role'      => null,
    ]);
}
