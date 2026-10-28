<?php
/**
 * POST /api/archive/create.php
 *
 * Atomic: BEGIN → create batch + snapshot + archive records in 5 tables → COMMIT
 *
 * Also handles re-archive: if batch_id is provided and batch status = 'restored',
 * performs re-archive on the same batch (increments version, replaces snapshot).
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/ArchiveRepository.php';
require_once __DIR__ . '/../../repositories/ReceiptRepository.php';
require_once __DIR__ . '/../../core/versionTracker.php';

if (!isMethod('POST')) jsonMethodNotAllowed('POST');

$body = requireJsonBody();
$username = $authUser['username'];
$fromDate = sanitizeString($body['from_date'] ?? '');
$toDate   = sanitizeString($body['to_date'] ?? '');
$notes    = sanitizeString($body['notes'] ?? '');
$batchId  = $body['batch_id'] ?? null; // For re-archive

if (!$fromDate || !$toDate) jsonError('التاريخ من/إلى مطلوب', 400);
if ($fromDate > $toDate) jsonError('تاريخ البداية يجب أن يكون قبل تاريخ النهاية', 400);

try {
    $db = getDB();
    $repo = new ArchiveRepository($db);
    $receiptRepo = new ReceiptRepository($db);
    $now = nowEgypt();

    // Ensure per-user counter row exists outside transaction so archive creation
    // can deterministically serialize per user even when archive_batches is empty.
    $receiptRepo->ensureCounterExists($username);

    $db->beginTransaction();
    try {
        // ── RE-ARCHIVE path ───────────────────────────────────────────────
        if ($batchId) {
            // 1. Lock archive_batches FIRST
            $batch = $repo->getBatchByUuid($batchId, true);
            if (!$batch) { $db->rollBack(); jsonError('الأرشيف غير موجود', 404); }
            if ($batch['username'] !== $username) { $db->rollBack(); jsonError('غير مسموح', 403); }
            if ($batch['status'] !== 'restored') { $db->rollBack(); jsonError('لا يمكن إعادة الأرشفة — الدفعة ليست مستعادة', 400); }

            // 2. Lock per-user receipt_counters SECOND
            $cntStmt = $db->prepare('SELECT next_number FROM receipt_counters WHERE username = :u FOR UPDATE');
            $cntStmt->execute([':u' => $username]);

            $fromDate = $batch['from_date'];
            $toDate   = $batch['to_date'];

            // 3. Lock all archivable records in [fromDate, toDate] in canonical table & PK order
            //    BEFORE computing the snapshot so snapshot and archived rows are identical.
            $lockedRecordsMap = $repo->lockArchivableRecords($username, $fromDate, $toDate);

            // Soft-delete old snapshot
            $oldSnap = $repo->getSnapshotByBatchUuid($batchId);
            if ($oldSnap) {
                $repo->softDeleteSnapshot($oldSnap['uuid']);
            }

            // Compute fresh snapshot over the locked period records
            $snapshot = $repo->computeSnapshot($username, $toDate, $fromDate);
            $newVersion = intval($batch['archive_version'] ?? 1) + 1;
            $snapUuid = $body['snapshot_id'] ?? bin2hex(random_bytes(18));

            $hash = _computeHash($batchId, $fromDate, $toDate, $snapshot['treasury_balance'], count($snapshot['client_balances']), $newVersion);

            $repo->createSnapshot([
                'uuid'              => $snapUuid,
                'archive_batch_id'  => $batchId,
                'snapshot_date'     => $toDate,
                'treasury_balance'  => $snapshot['treasury_balance'],
                'client_balances'   => $snapshot['client_balances'],
                'integrity_hash'    => $hash,
            ]);

            // Archive the exact locked records
            $archived = $repo->archiveRecords($username, $fromDate, $toDate, $batchId, $now, $lockedRecordsMap);

            // Update batch
            $repo->updateBatch($batch['id'], [
                'status'              => 'archived',
                'archive_version'     => $newVersion,
                'snapshot_id'         => $snapUuid,
                'last_rearchived_at'  => $now,
                'restored_at'         => null,
            ], $username);

            bumpVersions($db, ['receipts', 'treasury', 'vehicle_ledger', 'main_capital', 'archive_batches']);
            $db->commit();
            jsonSuccess([
                'batch_id'        => $batchId,
                'version'         => $newVersion,
                'recordsArchived' => $archived,
            ], 'تمت إعادة الأرشفة بنجاح');
        }

        // ── FIRST-TIME ARCHIVE path ───────────────────────────────────────
        // 1. Lock existing archive_batches FIRST
        $existing = $repo->listBatches($username, true);

        // 2. Lock per-user receipt_counters SECOND to serialize concurrent first-time
        //    archive requests even when archive_batches had 0 rows at Step 1.
        $cntStmt = $db->prepare('SELECT next_number FROM receipt_counters WHERE username = :u FOR UPDATE');
        $cntStmt->execute([':u' => $username]);
        if (empty($existing)) {
            $existing = $repo->listBatches($username, true);
        }

        foreach ($existing as $b) {
            if ($b['status'] !== 'archived' && $b['status'] !== 'active') continue;
            if ($b['from_date'] <= $toDate && $b['to_date'] >= $fromDate) {
                $db->rollBack();
                jsonError("يوجد أرشيف نشط يتداخل مع هذه الفترة ({$b['from_date']} → {$b['to_date']})", 400);
            }
        }

        // 3. Lock all archivable records in [fromDate, toDate] in canonical table & PK order
        //    BEFORE computing the snapshot so snapshot and archived rows cannot diverge.
        $lockedRecordsMap = $repo->lockArchivableRecords($username, $fromDate, $toDate);

        // Compute snapshot over the locked period records
        $snapshot = $repo->computeSnapshot($username, $toDate, $fromDate);

        $batchUuid = $body['batch_uuid'] ?? bin2hex(random_bytes(18));
        $snapUuid  = $body['snapshot_id'] ?? bin2hex(random_bytes(18));
        $hash = _computeHash($batchUuid, $fromDate, $toDate, $snapshot['treasury_balance'], count($snapshot['client_balances']), 1);

        // Create batch
        $batch = $repo->createBatch([
            'uuid'            => $batchUuid,
            'username'        => $username,
            'from_date'       => $fromDate,
            'to_date'         => $toDate,
            'status'          => 'archived',
            'archive_version' => 1,
            'snapshot_id'     => $snapUuid,
            'notes'           => $notes ?: "أرشيف من $fromDate إلى $toDate",
            'archived_at'     => $now,
            'archived_by'     => $username,
        ]);

        // Create snapshot
        $repo->createSnapshot([
            'uuid'              => $snapUuid,
            'archive_batch_id'  => $batchUuid,
            'snapshot_date'     => $toDate,
            'treasury_balance'  => $snapshot['treasury_balance'],
            'client_balances'   => $snapshot['client_balances'],
            'integrity_hash'    => $hash,
        ]);

        // Archive the exact locked records in all 4 tables
        $archived = $repo->archiveRecords($username, $fromDate, $toDate, $batchUuid, $now, $lockedRecordsMap);

        bumpVersions($db, ['receipts', 'treasury', 'vehicle_ledger', 'main_capital', 'archive_batches']);
        $db->commit();
        jsonSuccess([
            'batch_id'        => $batchUuid,
            'snapshot_id'     => $snapUuid,
            'from_date'       => $fromDate,
            'to_date'         => $toDate,
            'recordsArchived' => $archived,
        ], 'تمت الأرشفة بنجاح', 201);

    } catch (Exception $e) { if ($db->inTransaction()) $db->rollBack(); throw $e; }
} catch (Exception $e) {
    error_log('[ARCHIVE CREATE] ' . $e->getMessage());
    jsonError($e->getMessage(), 500);
}

// ── Hash helper (mirrors archiveService.js _computeSnapshotHash) ──────────
function _computeHash($batchId, $from, $to, $treasuryBal, $clientCount, $version) {
    $str = implode('|', [$batchId, $from, $to, $treasuryBal, $clientCount, $version]);
    $hash = 0;
    for ($i = 0; $i < strlen($str); $i++) {
        $hash = (($hash << 5) - $hash + ord($str[$i])) & 0xFFFFFFFF;
        if ($hash > 0x7FFFFFFF) $hash -= 0x100000000;
    }
    return 'SNAP_' . base_convert(abs($hash), 10, 36);
}
