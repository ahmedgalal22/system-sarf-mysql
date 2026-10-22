<?php
/**
 * GET /api/backup/create.php
 *
 * Creates a full MySQL snapshot backup and streams it as JSON download.
 * Source: MySQL ONLY. Zero IndexedDB.
 * Requires: admin role.
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/BackupRepository.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');

// Admin only
if (($authUser['role'] ?? '') !== 'admin') {
    jsonError('غير مسموح — يتطلب صلاحيات المدير', 403);
}

try {
    $db = getDB();
    $repo = new BackupRepository($db);
    $username = $authUser['username'];

    $backup = $repo->createBackup($username);

    // Encode once — reuse for both metadata size and response output
    $json = json_encode($backup, JSON_UNESCAPED_UNICODE | JSON_PRETTY_PRINT);

    // Record successful backup metadata (best-effort — never blocks the download)
    // Uses INSERT ... ON DUPLICATE KEY UPDATE so the singleton row is
    // self-healing: if deleted or missing, it is recreated automatically.
    try {
        $meta = $db->prepare(
            'INSERT INTO backup_metadata (id, last_backup_at, last_backup_by, backup_count, last_backup_size)
             VALUES (1, NOW(), :username, 1, :size)
             ON DUPLICATE KEY UPDATE
                last_backup_at   = NOW(),
                last_backup_by   = VALUES(last_backup_by),
                backup_count     = backup_count + 1,
                last_backup_size = VALUES(last_backup_size)'
        );
        $meta->execute([':username' => $username, ':size' => strlen($json)]);
    } catch (Exception $metaErr) {
        error_log('[BACKUP META] ' . $metaErr->getMessage());
    }

    // Stream as JSON download
    $now = date('Y-m-d_H-i');
    $filename = "karta-v2-backup-{$now}.json";

    header('Content-Type: application/json; charset=utf-8');
    header("Content-Disposition: attachment; filename=\"{$filename}\"");
    header('Cache-Control: no-cache');

    echo $json;
    exit;

} catch (Exception $e) {
    error_log('[BACKUP CREATE] ' . $e->getMessage());
    jsonError('فشل إنشاء النسخة الاحتياطية: ' . $e->getMessage(), 500);
}
