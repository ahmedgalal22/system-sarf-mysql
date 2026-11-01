<?php
/**
 * core/helpers.php — General utility functions
 */

/**
 * Get authenticated user from session.
 * Returns null if not logged in.
 */
function getSessionUser(): ?array {
    if (empty($_SESSION['logged_in']) || $_SESSION['logged_in'] !== true) {
        return null;
    }
    return [
        'user_id'  => $_SESSION['user_id']  ?? null,
        'username' => $_SESSION['username'] ?? null,
        'role'     => $_SESSION['role']     ?? null,
    ];
}

/**
 * Check if the current request method matches.
 */
function isMethod(string $method): bool {
    return strtoupper($_SERVER['REQUEST_METHOD']) === strtoupper($method);
}

/**
 * Egypt local datetime string (YYYY-MM-DD HH:MM:SS).
 */
function nowEgypt(): string {
    return (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d H:i:s');
}

/**
 * Egypt local date string (YYYY-MM-DD).
 */
function todayEgypt(): string {
    return (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d');
}

/**
 * Safely initialize the dedicated PHP session storage directory before session_start().
 *
 * - Creates the directory if it does not exist (without clearing or recreating existing files).
 * - Resolves the path and verifies PHP write access.
 * - Reports creation/permission failures via error_log() without exposing filesystem paths to users.
 */
function initSessionSavePath(string $configuredPath): bool {
    $trimmed = trim($configuredPath);
    if ($trimmed === '') {
        return false;
    }

    $normalized = str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $trimmed);

    if (!is_dir($normalized)) {
        if (!@mkdir($normalized, 0700, true) && !is_dir($normalized)) {
            error_log('[SESSION] Failed to create dedicated session storage directory.');
            return false;
        }
    }

    $resolved   = @realpath($normalized);
    $targetPath = ($resolved !== false && $resolved !== '') ? $resolved : $normalized;

    if (!is_dir($targetPath) || !is_writable($targetPath)) {
        error_log('[SESSION] Dedicated session storage directory is not writable.');
        return false;
    }

    session_save_path($targetPath);
    return true;
}

/**
 * Emit the session cookie with the configured security parameters.
 */
function sendSessionCookie(array $sessionConfig, string $cookieValue, int $expiresAt): void {
    if (headers_sent() || !ini_get('session.use_cookies')) {
        return;
    }

    $cookieName = session_name();
    if ($cookieName === '' && !empty($sessionConfig['name'])) {
        $cookieName = (string) $sessionConfig['name'];
    }

    setcookie($cookieName, $cookieValue, [
        'expires'  => $expiresAt,
        'path'     => $sessionConfig['path']     ?? '/',
        'domain'   => $sessionConfig['domain']   ?? '',
        'secure'   => (bool) ($sessionConfig['secure']   ?? false),
        'httponly' => (bool) ($sessionConfig['httponly'] ?? true),
        'samesite' => $sessionConfig['samesite'] ?? 'Lax',
    ]);
}

/**
 * Immediately invalidate the authenticated session, expire the browser cookie
 * with matching parameters, and destroy the server-side session file.
 */
function expireAuthenticatedSession(array $sessionConfig, ?int $now = null): void {
    $currentTime = $now ?? time();
    $_SESSION = [];

    sendSessionCookie($sessionConfig, '', $currentTime - 42000);

    if (session_status() === PHP_SESSION_ACTIVE) {
        @session_destroy();
    }
}

/**
 * Identify passive requests that must never extend the 30-day inactivity timer
 * or renew the session cookie:
 *   - /api/sync/versions.php
 *   - /api/auth/session.php
 *   - /api/health/ping.php
 *   - Any request carrying X-Background-Poll: 1 or X-Passive-Request: 1
 */
function isPassiveSessionRequest(): bool {
    $script = basename($_SERVER['SCRIPT_FILENAME'] ?? $_SERVER['SCRIPT_NAME'] ?? '');
    if ($script === 'versions.php' || $script === 'session.php' || $script === 'ping.php') {
        return true;
    }
    if (($_SERVER['HTTP_X_BACKGROUND_POLL'] ?? '') === '1') {
        return true;
    }
    if (($_SERVER['HTTP_X_PASSIVE_REQUEST'] ?? '') === '1') {
        return true;
    }
    return false;
}

/**
 * Backward-compatible alias for isPassiveSessionRequest().
 */
function isBackgroundSyncRequest(): bool {
    return isPassiveSessionRequest();
}

/**
 * Release the PHP session lock safely:
 * - When $preserveChanges is false (unmodified passive request), calls session_abort()
 *   so the session file is not rewritten and its mtime is not updated on disk,
 *   while keeping $_SESSION values available in memory for the current request.
 * - When $preserveChanges is true, calls session_write_close() to persist changes.
 */
function releasePassiveSessionLock(bool $preserveChanges = false): void {
    if (session_status() !== PHP_SESSION_ACTIVE) {
        return;
    }
    if ($preserveChanges) {
        @session_write_close();
    } else {
        @session_abort();
    }
}

/**
 * Stamp initial authenticated activity at login and issue the 30-day persistent cookie.
 */
function markSessionAuthenticated(array $sessionConfig, ?int $now = null): void {
    $currentTime = $now ?? time();
    $lifetime    = (int) ($sessionConfig['lifetime'] ?? 2592000);

    $_SESSION['last_activity_at']    = $currentTime;
    $_SESSION['cookie_refreshed_at'] = $currentTime;

    sendSessionCookie($sessionConfig, session_id(), $currentTime + $lifetime);
}

/**
 * Enforce the 30-day rolling inactivity policy after session_start():
 *
 * 1. Unauthenticated requests are never renewed or given activity timestamps.
 * 2. Sessions exceeding 30 days (lifetime) without authenticated activity are
 *    immediately expired and destroyed (cannot be revived by passive or active requests).
 * 3. Passive requests (versions.php, session.php, ping.php, or X-Background-Poll: 1)
 *    never establish or advance last_activity_at, never update cookie_refreshed_at,
 *    and never emit Set-Cookie renewal headers.
 * 4. Genuine authenticated non-passive requests monotonically update last_activity_at
 *    via max() and renew the browser cookie when renewal_interval has elapsed.
 */
function enforceAndRenewRollingSession(array $sessionConfig, ?int $now = null): void {
    $script = basename($_SERVER['SCRIPT_FILENAME'] ?? $_SERVER['SCRIPT_NAME'] ?? '');
    if ($script === 'login.php' || $script === 'logout.php') {
        return;
    }

    if (empty($_SESSION['logged_in']) || $_SESSION['logged_in'] !== true) {
        return;
    }

    $currentTime     = $now ?? time();
    $lifetime        = (int) ($sessionConfig['lifetime'] ?? 2592000);
    $renewalInterval = (int) ($sessionConfig['renewal_interval'] ?? 60);

    if (isset($_SESSION['last_activity_at'])) {
        $idleSeconds = $currentTime - (int) $_SESSION['last_activity_at'];
        if ($idleSeconds > $lifetime) {
            expireAuthenticatedSession($sessionConfig, $currentTime);
            return;
        }
    }

    if (isPassiveSessionRequest()) {
        return;
    }

    $previousActivity = isset($_SESSION['last_activity_at'])
        ? (int) $_SESSION['last_activity_at']
        : 0;
    $_SESSION['last_activity_at'] = max($previousActivity, $currentTime);

    $lastCookieRefresh = isset($_SESSION['cookie_refreshed_at'])
        ? (int) $_SESSION['cookie_refreshed_at']
        : 0;

    if ($lastCookieRefresh === 0 || ($currentTime - $lastCookieRefresh) >= $renewalInterval) {
        $_SESSION['cookie_refreshed_at'] = max($lastCookieRefresh, $currentTime);
        sendSessionCookie($sessionConfig, session_id(), $currentTime + $lifetime);
    }
}

