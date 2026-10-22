<?php
/**
 * POST /api/auth/logout.php
 *
 * Destroys session completely and clears cookie.
 */

require_once __DIR__ . '/../../core/bootstrap.php';

if (!isMethod('POST')) {
    jsonMethodNotAllowed('POST');
}

// ── Destroy session ───────────────────────────────────────────────────────────
$_SESSION = [];

// Destroy session cookie
if (ini_get('session.use_cookies')) {
    $params = session_get_cookie_params();
    setcookie(
        session_name(),
        '',
        time() - 42000,
        $params['path'],
        $params['domain'],
        $params['secure'],
        $params['httponly']
    );
}

session_destroy();

jsonSuccess(null, 'تم تسجيل الخروج بنجاح');
