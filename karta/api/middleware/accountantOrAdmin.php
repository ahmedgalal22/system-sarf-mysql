<?php
/**
 * middleware/accountantOrAdmin.php — Any authenticated role
 *
 * MUST be included AFTER auth.php.
 * Allows both admin and accountant.
 */

if (!isset($authUser) || !in_array($authUser['role'], ['admin', 'accountant'], true)) {
    jsonError('غير مصرح بالوصول', 403);
}
