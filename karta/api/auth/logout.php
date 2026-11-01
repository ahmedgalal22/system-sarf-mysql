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

// ── Destroy session & expire cookie with matching parameters ──────────────────
expireAuthenticatedSession($GLOBALS['sessionConfig'] ?? session_get_cookie_params());

jsonSuccess(null, 'تم تسجيل الخروج بنجاح');
