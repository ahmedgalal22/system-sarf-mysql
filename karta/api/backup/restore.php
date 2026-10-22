<?php
/**
 * POST /api/backup/restore.php
 *
 * Full destructive restore from a JSON backup file.
 * Target: MySQL ONLY. Zero IndexedDB.
 * Requires: admin role.
 *
 * Atomic: BEGIN → validate → clear all → insert all → verify checksum → COMMIT
 * On failure: ROLLBACK — no partial state.
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/BackupRepository.php';
require_once __DIR__ . '/../../core/versionTracker.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');

// Admin only
if (($authUser['role'] ?? '') !== 'admin') {
    jsonError('غير مسموح — يتطلب صلاحيات المدير', 403);
}

// Accept JSON body or file upload
$backup = null;

if (isset($_FILES['backup_file'])) {
    // File upload
    $file = $_FILES['backup_file'];
    if ($file['error'] !== UPLOAD_ERR_OK) {
        jsonError('فشل رفع الملف', 400);
    }
    // Max 50MB
    if ($file['size'] > 50 * 1024 * 1024) {
        jsonError('حجم الملف كبير جداً (الحد: 50MB)', 400);
    }
    $content = file_get_contents($file['tmp_name']);
    $backup = json_decode($content, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        jsonError('ملف JSON غير صالح: ' . json_last_error_msg(), 400);
    }
} else {
    // JSON body
    $raw = file_get_contents('php://input');
    if (empty($raw)) {
        jsonError('لم يتم إرسال بيانات النسخة الاحتياطية', 400);
    }
    $backup = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        jsonError('بيانات JSON غير صالحة: ' . json_last_error_msg(), 400);
    }
}

if (!$backup) {
    jsonError('بيانات النسخة الاحتياطية فارغة', 400);
}

try {
    $db = getDB();
    $repo = new BackupRepository($db);

    // Step 1: Validate
    $validation = $repo->validateBackup($backup);
    if (!$validation['valid']) {
        jsonError('النسخة الاحتياطية غير صالحة: ' . implode(', ', $validation['errors']), 400);
    }

    // Step 2: Atomic restore
    $db->beginTransaction();
    try {
        $stats = $repo->restore($backup, $authUser['username']);

        bumpVersions($db, [
            'vehicle_owners', 'offices', 'vehicles',
            'receipts', 'treasury', 'vehicle_ledger',
            'main_capital', 'archive_batches', 'drivers', 'notes'
        ]);
        $db->commit();

        $totalRestored = array_sum($stats);
        jsonSuccess([
            'stats'          => $stats,
            'total_restored' => $totalRestored,
            'backup_date'    => $backup['system']['created_at'] ?? 'unknown',
            'backup_by'      => $backup['system']['created_by'] ?? 'unknown',
        ], "تم استعادة النسخة الاحتياطية بنجاح — $totalRestored سجل");

    } catch (Exception $e) {
        if ($db->inTransaction()) $db->rollBack();
        throw $e;
    }

} catch (PDOException $e) {
    error_log('[BACKUP RESTORE] ' . $e->getMessage());
    jsonError('فشل استعادة النسخة الاحتياطية: ' . $e->getMessage(), 500);
} catch (Exception $e) {
    error_log('[BACKUP RESTORE] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}
