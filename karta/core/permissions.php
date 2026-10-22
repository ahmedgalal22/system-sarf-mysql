<?php
/**
 * core/permissions.php — Server-side permission enforcement
 *
 * RULE: Server is the FINAL authority on write permissions.
 *       Frontend may show/hide UI, but server enforces on every request.
 *
 * Roles:
 *   admin      → full access
 *   accountant → restricted (no dashboard, no archive)
 */

/**
 * Permission map — which roles can access which modules.
 */
function getPermissions(): array {
    return [
        'admin' => [
            'vehicles'   => ['read', 'write', 'delete'],
            'treasury'   => ['read', 'write', 'delete'],
            'receipts'   => ['read', 'write', 'delete'],
            'offices'    => ['read', 'write', 'delete'],
            'entities'   => ['read', 'write', 'delete'],
            'dashboard'  => ['read'],
            'archive'    => ['read', 'write'],
            'users'      => ['read', 'write'],
        ],
        'accountant' => [
            'vehicles'   => ['read', 'write', 'delete'],
            'treasury'   => ['read', 'write', 'delete'],
            'receipts'   => ['read', 'write', 'delete'],
            'offices'    => ['read', 'write', 'delete'],
            'entities'   => ['read', 'write', 'delete'],
            'dashboard'  => [],  // NO access
            'archive'    => [],  // NO access
            'users'      => [],  // NO access
        ],
    ];
}

/**
 * Check if the current user has a specific permission.
 *
 * @param string $role — user's role
 * @param string $module — e.g. 'dashboard', 'archive'
 * @param string $action — 'read', 'write', 'delete'
 * @return bool
 */
function hasPermission(string $role, string $module, string $action = 'read'): bool {
    $perms = getPermissions();
    if (!isset($perms[$role][$module])) return false;
    return in_array($action, $perms[$role][$module], true);
}

/**
 * Require a specific permission — exits with 403 if denied.
 */
function requirePermission(string $role, string $module, string $action = 'read'): void {
    if (!hasPermission($role, $module, $action)) {
        jsonError("ليس لديك صلاحية للوصول إلى {$module}", 403);
    }
}
