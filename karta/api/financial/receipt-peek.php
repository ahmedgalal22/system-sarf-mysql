<?php
/**
 * GET /api/financial/receipt-peek.php
 *
 * Returns the next available receipt number from MySQL.
 * Read-only preview — does NOT advance the counter.
 * MySQL receipt_counters is the single source of truth.
 */

require_once __DIR__ . '/../../core/bootstrap.php';
require_once __DIR__ . '/../../api/middleware/auth.php';
require_once __DIR__ . '/../../repositories/ReceiptRepository.php';

if (!isMethod('GET')) jsonMethodNotAllowed('GET');

try {
    $db = getDB();
    $username = $authUser['username'];
    $receiptRepo = new ReceiptRepository($db);

    // Ensure counter row exists (auto-heals if missing)
    $receiptRepo->ensureCounterExists($username);

    // Read current counter value
    $stmt = $db->prepare('SELECT next_number FROM receipt_counters WHERE username = :u');
    $stmt->execute([':u' => $username]);
    $row = $stmt->fetch();
    $currentNumber = intval($row['next_number'] ?? 0);
    $nextNumber = $currentNumber + 1;

    // Skip numbers that already exist (handle gaps from deletes/restores)
    $checkStmt = $db->prepare(
        'SELECT 1 FROM receipts WHERE username = :u AND receipt_number = :n AND deleted_at IS NULL LIMIT 1'
    );
    for ($i = 0; $i < 100; $i++) {
        $checkStmt->execute([':u' => $username, ':n' => (string)$nextNumber]);
        if (!$checkStmt->fetch()) break;
        $nextNumber++;
    }

    jsonSuccess(['next_number' => $nextNumber]);

} catch (Exception $e) {
    error_log('[RECEIPT PEEK] ' . $e->getMessage());
    jsonError('خطأ في الخادم', 500);
}
