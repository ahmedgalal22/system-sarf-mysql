<?php
/**
 * middleware/adminOnly.php — Admin role required
 *
 * MUST be included AFTER auth.php.
 * Blocks accountant from admin-only endpoints.
 */

if (!isset($authUser) || $authUser['role'] !== 'admin') {
    jsonError('هذا الإجراء متاح للمدير فقط', 403);
}
