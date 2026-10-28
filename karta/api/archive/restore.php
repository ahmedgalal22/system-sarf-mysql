<?php
/**
 * POST /api/archive/restore.php
 *
 * Atomic: BEGIN → restore records in 5 tables + update batch status → COMMIT
 * Restore = unarchive only. Does NOT recreate rows.
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/ArchiveRepository.php';
require_once __DIR__ . '/../../core/versionTracker.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');

$body = requireJsonBody();
$username = $authUser['username'];
$batchId  = sanitizeString($body['batch_id'] ?? '');

if (!$batchId) jsonError('معرف الأرشيف مطلوب', 400);

try {
    $db = getDB();
    $repo = new ArchiveRepository($db);

    $db->beginTransaction();
    try {
        $batch = $repo->getBatchByUuid($batchId, true);
        if (!$batch) { $db->rollBack(); jsonError('الأرشيف غير موجود', 404); }
        if ($batch['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }
        if ($batch['status'] !== 'archived' && $batch['status'] !== 'active') {
            $db->rollBack();
            jsonError('هذا الأرشيف تم استعادته بالفعل', 400);
        }

        // Verify snapshot integrity before restore
        $snap = $repo->getSnapshotByBatchUuid($batchId);
        if ($snap && !empty($snap['integrity_hash'])) {
            $expected = _computeHash(
                $batch['uuid'], $batch['from_date'], $batch['to_date'],
                $snap['treasury_balance'],
                is_array($snap['client_balances']) ? count($snap['client_balances']) : 0,
                $batch['archive_version'] ?? 1
            );
            if ($snap['integrity_hash'] !== $expected) {
                $db->rollBack();
                jsonError('فشل التحقق من سلامة اللقطة المالية — لا يمكن الاستعادة', 400);
            }
        }

        // Restore records (remove archive flags scoped to $username)
        $restored = $repo->restoreRecords($batchId, $username);

        // Update batch status
        $now = nowEgypt();
        $repo->updateBatch($batch['id'], [
            'status'      => 'restored',
            'restored_at' => $now,
        ], $username);

        bumpVersions($db, ['receipts', 'treasury', 'vehicle_ledger', 'main_capital', 'archive_batches']);
        $db->commit();
        jsonSuccess([
            'batch_id'        => $batchId,
            'recordsRestored' => $restored,
        ], 'تمت الاستعادة بنجاح');

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[ARCHIVE RESTORE] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}

function _computeHash($batchId, $from, $to, $treasuryBal, $clientCount, $version) {
    $str = implode('|', [$batchId, $from, $to, $treasuryBal, $clientCount, $version]);
    $hash = 0;
    for ($i = 0; $i < strlen($str); $i++) {
        $hash = (($hash << 5) - $hash + ord($str[$i])) & 0xFFFFFFFF;
        if ($hash > 0x7FFFFFFF) $hash -= 0x100000000;
    }
    return 'SNAP_' . base_convert(abs($hash), 10, 36);
}
