<?php
/**
 * middleware/auth.php — Require authenticated session
 *
 * Include this file at the top of any API endpoint that requires login.
 * If user is not authenticated, returns 401 and exits.
 */

$authUser = getSessionUser();
if ($authUser === null) {
    jsonError('غير مصرح — يرجى تسجيل الدخول', 401);
}
