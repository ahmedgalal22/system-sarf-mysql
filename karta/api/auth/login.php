<?php
/**
 * POST /api/auth/login.php
 *
 * Authenticates user with username + password.
 * Creates PHP session on success.
 * Updates last_login_at.
 */

require_once __DIR__ . '/../../core/bootstrap.php';

// ── Method check ──────────────────────────────────────────────────────────────
if (!isMethod('POST')) {
    jsonMethodNotAllowed('POST');
}

// ── Parse input ───────────────────────────────────────────────────────────────
$body = requireJsonBody();

$username = requireNonEmpty($body['username'] ?? null, 'اسم المستخدم');
$password = requireNonEmpty($body['password'] ?? null, 'كلمة المرور');

// ── Query user ────────────────────────────────────────────────────────────────
try {
    $db = getDB();

    $stmt = $db->prepare('SELECT id, uuid, username, password_hash, role, is_active FROM users WHERE username = :username LIMIT 1');
    $stmt->execute([':username' => $username]);
    $user = $stmt->fetch();

    // ── Validate credentials ──────────────────────────────────────────────────
    if (!$user) {
        jsonError('اسم المستخدم أو كلمة المرور غير صحيحة', 401);
    }

    if (!$user['is_active']) {
        jsonError('هذا الحساب غير مفعل', 403);
    }

    if (!password_verify($password, $user['password_hash'])) {
        jsonError('اسم المستخدم أو كلمة المرور غير صحيحة', 401);
    }

    // ── Create session ────────────────────────────────────────────────────────
    // Regenerate session ID to prevent fixation attacks
    session_regenerate_id(true);

    $_SESSION['logged_in'] = true;
    $_SESSION['user_id']   = $user['id'];
    $_SESSION['uuid']      = $user['uuid'];
    $_SESSION['username']  = $user['username'];
    $_SESSION['role']      = $user['role'];

    // ── Update last_login_at ──────────────────────────────────────────────────
    $now = nowEgypt();
    $updateStmt = $db->prepare('UPDATE users SET last_login_at = :now WHERE id = :id');
    $updateStmt->execute([':now' => $now, ':id' => $user['id']]);

    // ── Response ──────────────────────────────────────────────────────────────
    jsonSuccess([
        'user_id'  => $user['id'],
        'uuid'     => $user['uuid'],
        'username' => $user['username'],
        'role'     => $user['role'],
    ], 'تم تسجيل الدخول بنجاح');

} catch (PDOException $e) {
    error_log('[LOGIN ERROR] ' . $e->getMessage());
    jsonError('خطأ في الخادم — يرجى المحاولة لاحقاً', 500);
}
