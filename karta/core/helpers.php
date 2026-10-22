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
