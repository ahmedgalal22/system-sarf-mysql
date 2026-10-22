<?php
/**
 * setup.php — First-time database setup
 *
 * Run this ONCE after importing database SQL files into phpMyAdmin.
 * It creates properly hashed passwords for the default users.
 *
 * IMPORTANT:
 *   - Import SQL files FIRST: database.sql → all 13 SQL schema files in order
 *   - DELETE THIS FILE after setup for security
 *
 * Access: http://localhost/system52/karta/setup.php
 */

require_once __DIR__ . '/core/bootstrap.php';

header('Content-Type: text/html; charset=utf-8');

echo "<h1>Karta ERP — Setup</h1>";

try {
    $db = getDB();

    // ── Check prerequisite tables ─────────────────────────────────────────
    $requiredTables = ['users', 'receipts', 'receipt_counters'];
    $missing = [];
    foreach ($requiredTables as $t) {
        $r = $db->query("SHOW TABLES LIKE '{$t}'")->fetchAll();
        if (count($r) === 0) $missing[] = $t;
    }

    if (!empty($missing)) {
        echo "<p style='color:red'>❌ جداول مفقودة: <strong>" . implode(', ', $missing) . "</strong></p>";
        echo "<p>يرجى استيراد ملفات SQL بالترتيب:</p>";
        echo "<ol><li>database.sql</li><li>database_vehicles.sql</li><li>database_receipts.sql</li></ol>";
        exit;
    }
    echo "<p>✅ جميع الجداول المطلوبة موجودة</p>";

    // ── Check DATETIME(3) schema ──────────────────────────────────────────
    $colInfo = $db->query("SHOW COLUMNS FROM receipts LIKE 'updated_at'")->fetch();
    $colType = strtolower($colInfo['Type'] ?? '');
    if (strpos($colType, 'datetime(3)') !== false) {
        echo "<p>✅ Schema: updated_at is DATETIME(3) (millisecond precision)</p>";
    } else {
        echo "<p style='color:orange'>⚠️ Schema: updated_at is <strong>{$colType}</strong> — ";
        echo "يجب إعادة إنشاء قاعدة البيانات باستخدام ملفات SQL المحدّثة</p>";
    }

    // ── Seed users ────────────────────────────────────────────────────────
    echo "<h2>👤 Users</h2>";

    $users = [
        ['username' => 'admin',      'password' => 'admin123',      'role' => 'admin'],
        ['username' => 'accountant', 'password' => 'accountant123', 'role' => 'accountant'],
    ];

    foreach ($users as $u) {
        $hash = password_hash($u['password'], PASSWORD_BCRYPT);

        $stmt = $db->prepare('SELECT id FROM users WHERE username = :username');
        $stmt->execute([':username' => $u['username']]);
        $existing = $stmt->fetch();

        if ($existing) {
            $update = $db->prepare('UPDATE users SET password_hash = :hash, role = :role WHERE username = :username');
            $update->execute([':hash' => $hash, ':role' => $u['role'], ':username' => $u['username']]);
            echo "<p>✅ تم تحديث كلمة مرور: <strong>{$u['username']}</strong></p>";
        } else {
            $uuid = generateUUID();
            $insert = $db->prepare('INSERT INTO users (uuid, username, password_hash, role, is_active) VALUES (:uuid, :username, :hash, :role, 1)');
            $insert->execute([':uuid' => $uuid, ':username' => $u['username'], ':hash' => $hash, ':role' => $u['role']]);
            echo "<p>✅ تم إنشاء مستخدم: <strong>{$u['username']}</strong></p>";
        }
    }

    echo "<hr>";
    echo "<p style='color:green;font-weight:bold'>✅ الإعداد مكتمل!</p>";
    echo "<p>بيانات الدخول:</p>";
    echo "<ul>";
    echo "<li><strong>المدير:</strong> admin / admin123</li>";
    echo "<li><strong>المحاسب:</strong> accountant / accountant123</li>";
    echo "</ul>";
    echo "<p style='color:red'>⚠️ <strong>احذف هذا الملف (setup.php) بعد الإعداد!</strong></p>";
    echo "<p>فحص النظام: <a href='api/health/ping.php'>api/health/ping.php</a></p>";
    echo "<p>تشغيل الاختبارات: <code>php tests_v2/run_tests_v2.php</code></p>";

} catch (PDOException $e) {
    echo "<p style='color:red'>❌ خطأ في قاعدة البيانات: " . htmlspecialchars($e->getMessage()) . "</p>";
    echo "<p>تأكد من:</p>";
    echo "<ul>";
    echo "<li>XAMPP MySQL يعمل</li>";
    echo "<li>قاعدة البيانات karta_erp_v2 موجودة</li>";
    echo "<li>بيانات الاتصال صحيحة في config/database.php</li>";
    echo "</ul>";
}
