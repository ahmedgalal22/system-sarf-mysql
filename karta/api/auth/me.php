<?php
/**
 * GET /api/auth/me.php
 *
 * Returns the currently authenticated user's profile.
 * Requires active session.
 */

require_once __DIR__ . '/../../core/bootstrap.php';

if (!isMethod('GET')) {
    jsonMethodNotAllowed('GET');
}

// ── Require authentication ────────────────────────────────────────────────────
require_once __DIR__ . '/../middleware/auth.php';

// ── Fetch fresh user data from DB ─────────────────────────────────────────────
try {
    $db = getDB();
    $stmt = $db->prepare('SELECT id, uuid, username, role, is_active, created_at, last_login_at FROM users WHERE id = :id LIMIT 1');
    $stmt->execute([':id' => $authUser['user_id']]);
    $user = $stmt->fetch();

    if (!$user || !$user['is_active']) {
        // User was deactivated while logged in
        $_SESSION = [];
        session_destroy();
        jsonError('الحساب غير مفعل', 403);
    }

    jsonSuccess([
        'user_id'       => $user['id'],
        'uuid'          => $user['uuid'],
        'username'      => $user['username'],
        'role'          => $user['role'],
        'created_at'    => $user['created_at'],
        'last_login_at' => $user['last_login_at'],
    ]);

} catch (PDOException $e) {
    error_log('[ME ERROR] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
