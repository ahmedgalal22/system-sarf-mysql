<?php
/**
 * test_stage1_financial_invariants_v2.php — Stage 1 / 1.1 / 1.2 Repository & Core Verification Suite
 *
 * SAFETY GUARD:
 *   This test suite connects ONLY to the dedicated `karta_test` database
 *   (or the database explicitly named in KARTA_TEST_DB, which MUST equal 'karta_test').
 *   It refuses to execute against `karta_erp`, `karta_erp_v2`, or any production DB.
 *
 * Usage (XAMPP / MySQL):
 *   KARTA_TEST_DB=karta_test php karta/tests_v2/test_stage1_financial_invariants_v2.php
 */

error_reporting(E_ALL);
ini_set('display_errors', '1');

require_once __DIR__ . '/../repositories/ReceiptRepository.php';
require_once __DIR__ . '/../repositories/TreasuryRepository2.php';
require_once __DIR__ . '/../repositories/VehicleLedgerRepository.php';
require_once __DIR__ . '/../repositories/OfficeRepository.php';
require_once __DIR__ . '/../repositories/VehicleOwnerRepository.php';
require_once __DIR__ . '/../repositories/HamolaRepository.php';
require_once __DIR__ . '/../repositories/ArchiveRepository.php';
require_once __DIR__ . '/../core/versionTracker.php';

$_STAGE1_RESULTS = [];

function s1_assert(bool $cond, string $label, string $reason = ''): void {
    global $_STAGE1_RESULTS;
    $_STAGE1_RESULTS[] = [
        'label'  => $label,
        'pass'   => $cond,
        'reason' => $cond ? '' : ($reason !== '' ? $reason : 'Assertion failed'),
    ];
}

function s1_assert_throws(callable $fn, string $label): void {
    try {
        $fn();
        s1_assert(false, $label, 'Expected InvalidArgumentException, none thrown');
    } catch (InvalidArgumentException $e) {
        s1_assert(true, $label);
    } catch (Throwable $t) {
        s1_assert(false, $label, 'Expected InvalidArgumentException, got ' . get_class($t) . ': ' . $t->getMessage());
    }
}

function s1_uuid(): string {
    return sprintf(
        '%04x%04x-%04x-%04x-%04x-%04x%04x%04x',
        mt_rand(0, 0xffff), mt_rand(0, 0xffff),
        mt_rand(0, 0xffff),
        mt_rand(0, 0x0fff) | 0x4000,
        mt_rand(0, 0x3fff) | 0x8000,
        mt_rand(0, 0xffff), mt_rand(0, 0xffff), mt_rand(0, 0xffff)
    );
}

/**
 * Connect strictly to `karta_test`. Aborts immediately if the target database
 * is not `karta_test`.
 */
function getDedicatedKartaTestDB(): PDO {
    $dbConfig = require __DIR__ . '/../config/database.php';
    $testDbName = getenv('KARTA_TEST_DB') ?: 'karta_test';
    if ($testDbName !== 'karta_test') {
        throw new RuntimeException("SAFETY ABORT: KARTA_TEST_DB must be 'karta_test', got '{$testDbName}'");
    }

    $dsn = "mysql:host={$dbConfig['host']};port={$dbConfig['port']};dbname={$testDbName};charset={$dbConfig['charset']}";
    $pdo = new PDO($dsn, $dbConfig['username'], $dbConfig['password'], $dbConfig['options']);

    $activeDb = (string)$pdo->query('SELECT DATABASE()')->fetchColumn();
    if ($activeDb !== 'karta_test') {
        throw new RuntimeException("SAFETY ABORT: Connected database is '{$activeDb}', expected 'karta_test'");
    }
    return $pdo;
}

/**
 * Deterministic transactional helper exercising the exact salfa edit/delete guards
 * and reconciliation logic used by treasury-edit.php and treasury-delete.php.
 */
function s1_exec_salfa_mutation(
    PDO $db,
    string $op, // 'edit' | 'delete'
    int $treasuryId,
    string $username,
    array $body = []
): array {
    $treasuryRepo = new TreasuryRepo($db);
    $ledgerRepo   = new VehicleLedgerRepository($db);
    $receiptRepo  = new ReceiptRepository($db);

    if ($op === 'edit' && array_key_exists('amount', $body)) {
        try {
            $body['amount'] = ReceiptRepository::validateFiniteIntCents($body['amount'], 'المبلغ (amount)', false);
        } catch (InvalidArgumentException $e) {
            return ['status' => 400, 'message' => $e->getMessage()];
        }
    }

    $preExisting = $treasuryRepo->getById($treasuryId);
    if (!$preExisting) return ['status' => 404, 'message' => 'Not found'];
    if (($preExisting['username'] ?? '') !== $username) return ['status' => 403, 'message' => 'Forbidden'];
    $preReceiptId = !empty($preExisting['receipt_number']) && ctype_digit((string)$preExisting['receipt_number'])
        ? intval($preExisting['receipt_number'])
        : 0;

    $db->beginTransaction();
    try {
        $lockedTargetReceipt = null;
        if ($preReceiptId > 0) {
            $recLockStmt = $db->prepare('SELECT * FROM receipts WHERE id = :rid AND username = :u FOR UPDATE');
            $recLockStmt->execute([':rid' => $preReceiptId, ':u' => $username]);
            $lockedTargetReceipt = $recLockStmt->fetch() ?: null;
        }

        $lockStmt = $db->prepare('SELECT * FROM treasury WHERE id = :id AND deleted_at IS NULL FOR UPDATE');
        $lockStmt->execute([':id' => $treasuryId]);
        $existing = $lockStmt->fetch();
        if (!$existing) { $db->rollBack(); return ['status' => 404, 'message' => 'Not found']; }
        if ($existing['username'] !== $username) { $db->rollBack(); return ['status' => 403, 'message' => 'Forbidden']; }
        if (!empty($existing['is_reversed'])) {
            $db->rollBack();
            return ['status' => 409, 'message' => 'Reversed movement cannot be modified or deleted again'];
        }
        if (!empty($existing['is_archived'])) {
            $db->rollBack();
            return ['status' => 409, 'message' => 'Archived treasury movement'];
        }

        $isExistingSalfa = ($existing['effect'] ?? '') === 'salfa' || ($existing['reference_type'] ?? '') === 'salfa';
        if ($op === 'edit' && $isExistingSalfa) {
            if (array_key_exists('effect', $body) && ($body['effect'] ?? '') !== ($existing['effect'] ?? 'salfa')) {
                $db->rollBack();
                return ['status' => 409, 'message' => 'Cannot change salfa effect'];
            }
            if (array_key_exists('type', $body) && ($body['type'] ?? '') !== ($existing['type'] ?? 'withdraw')) {
                $db->rollBack();
                return ['status' => 409, 'message' => 'Cannot change salfa type'];
            }
            if (array_key_exists('client_id', $body) && strval($body['client_id'] ?? '') !== strval($existing['client_id'] ?? '')) {
                $db->rollBack();
                return ['status' => 409, 'message' => 'Cannot change salfa client_id'];
            }
            if (array_key_exists('amount', $body) && intval($body['amount']) <= 0) {
                $db->rollBack();
                return ['status' => 400, 'message' => 'Salfa amount must be positive'];
            }
        }

        $isSalfaWithClient = ($existing['effect'] ?? '') === 'salfa' && !empty($existing['reference_id']) && !empty($existing['client_id']);
        if ($isSalfaWithClient) {
            $targetReceiptId = $existing['receipt_number'] ?? null;
            if ($targetReceiptId !== null && trim((string)$targetReceiptId) !== '') {
                $targetIdInt = ctype_digit(trim((string)$targetReceiptId)) ? intval($targetReceiptId) : 0;
                if ($targetIdInt <= 0) {
                    $db->rollBack();
                    return ['status' => 409, 'message' => 'Invalid receipt reference'];
                }
                $target = ($targetIdInt === $preReceiptId) ? $lockedTargetReceipt : null;
                if (!$target || $target['deleted_at'] !== null) {
                    $db->rollBack();
                    return ['status' => 409, 'message' => 'Linked receipt missing or deleted'];
                }
                if (!empty($target['is_archived'])) {
                    $db->rollBack();
                    return ['status' => 409, 'message' => 'Linked receipt archived'];
                }
                $salfaStatus = ReceiptRepository::inspectReceiptSalfaStatus($target);
                if (!$salfaStatus['eligible']) {
                    $db->rollBack();
                    return ['status' => 409, 'message' => $salfaStatus['message'] ?? 'Linked receipt paid or inconsistent'];
                }

                if ($op === 'edit' && array_key_exists('amount', $body)) {
                    $oldAmount = intval($existing['amount'] ?? 0);
                    $newAmount = intval($body['amount']);
                    $delta = $newAmount - $oldAmount;
                    if ($delta !== 0) {
                        $currentPaid = intval($target['paid'] ?? 0);
                        $netTotal = intval($target['net_total'] ?? 0);
                        $newPaid = max(0, min($netTotal, $currentPaid - $delta));
                        $updRecRes = $receiptRepo->updateReceipt($targetIdInt, ['paid' => $newPaid], $username);
                        if (($updRecRes['code'] ?? '') !== ReceiptRepository::RESULT_OK) {
                            $db->rollBack();
                            return ['status' => 409, 'message' => 'Failed to update linked receipt'];
                        }
                    }
                } elseif ($op === 'delete') {
                    $advanceAmount = intval($existing['amount'] ?? 0);
                    $currentPaid = intval($target['paid'] ?? 0);
                    $netTotal = intval($target['net_total'] ?? 0);
                    $newPaid = min($netTotal, $currentPaid + $advanceAmount);
                    $updRecRes = $receiptRepo->updateReceipt($targetIdInt, ['paid' => $newPaid], $username);
                    if (($updRecRes['code'] ?? '') !== ReceiptRepository::RESULT_OK) {
                        $db->rollBack();
                        return ['status' => 409, 'message' => 'Failed to update linked receipt'];
                    }
                }
            }
        }

        if ($op === 'edit') {
            $patch = [];
            foreach (['amount', 'date', 'description', 'note', 'client_name'] as $f) {
                if (array_key_exists($f, $body)) $patch[$f] = $body[$f];
            }
            $treasuryRepo->update($treasuryId, $patch, $username);
            if ($isSalfaWithClient) {
                $ledgerEntries = $ledgerRepo->getActiveByReferenceForUser(
                    $username,
                    (string)$existing['reference_id'],
                    (string)($existing['reference_type'] ?? 'salfa'),
                    true
                );
                foreach ($ledgerEntries as $le) {
                    $ledgerPatch = [];
                    if (array_key_exists('amount', $body)) $ledgerPatch['amount'] = $body['amount'];
                    if (array_key_exists('date', $body)) $ledgerPatch['date'] = $body['date'];
                    if (array_key_exists('note', $body)) $ledgerPatch['note'] = $body['note'];
                    if (!empty($ledgerPatch)) {
                        $ledgerRepo->update(intval($le['id']), $ledgerPatch, $username);
                    }
                }
            }
        } else {
            $treasuryRepo->update($treasuryId, [
                'is_reversed' => 1,
                'reversed_at' => (new DateTime('now', new DateTimeZone('Africa/Cairo')))->format('Y-m-d H:i:s.v'),
                'reversed_by' => $username,
            ], $username);
            if ($isSalfaWithClient) {
                $ledgerRepo->reverseByReferenceForUser($username, (string)$existing['reference_id'], (string)($existing['reference_type'] ?? 'salfa'));
            }
        }

        $db->commit();
        return ['status' => 200, 'message' => 'OK'];
    } catch (Throwable $t) {
        if ($db->inTransaction()) $db->rollBack();
        throw $t;
    }
}

// ── 1. Pure Unit Tests (Status Semantics, F1 Incomplete Formula Inputs, & Validation) ──

function run_stage1_unit_tests(): void {
    // 1.1 Canonical unpaid receipt (even when row disbursement_status is 'paid')
    $rUnpaid = [
        'payment_status' => 'unpaid',
        'payout_status'  => 'unpaid',
        'rows'           => [
            ['row_id' => 'r1', 'disbursement_status' => 'paid', 'payout_status' => 'paid'],
        ],
    ];
    $st1 = ReceiptRepository::inspectReceiptSalfaStatus($rUnpaid);
    s1_assert($st1['eligible'] === true && $st1['status'] === 'unpaid',
        'Canonical unpaid receipt with paid row disbursement_status is eligible for salfa');
    s1_assert(ReceiptRepository::isReceiptUnpaidForSalfa($rUnpaid) === true,
        'isReceiptUnpaidForSalfa returns true for canonical unpaid receipt');

    // 1.2 Canonical paid receipt (payment_status = 'paid', legacy payout_status = 'unpaid')
    $rPaid = [
        'payment_status' => 'paid',
        'payout_status'  => 'unpaid',
        'rows'           => [['row_id' => 'r1', 'disbursement_status' => 'unpaid']],
    ];
    $st2 = ReceiptRepository::inspectReceiptSalfaStatus($rPaid);
    s1_assert($st2['eligible'] === false && $st2['status'] === 'paid',
        'Canonical paid receipt (payment_status=paid, payout_status=unpaid) is ineligible for salfa');

    // 1.3 Legacy unpaid receipt (payment_status = null, payout_status = 'unpaid', no legacy row payment_status)
    $rLegacyUnpaid = [
        'payment_status' => null,
        'payout_status'  => 'unpaid',
        'rows'           => [['row_id' => 'r1', 'disbursement_status' => 'paid']],
    ];
    $st3 = ReceiptRepository::inspectReceiptSalfaStatus($rLegacyUnpaid);
    s1_assert($st3['eligible'] === true && $st3['status'] === 'unpaid',
        'Legacy unpaid receipt (payment_status=null, payout_status=unpaid) is eligible for salfa');

    // 1.4 Legacy unanimous row-level payment_status = 'paid'
    $rLegacyRowPaid = [
        'payment_status' => null,
        'payout_status'  => 'unpaid',
        'rows'           => [
            ['row_id' => 'r1', 'payment_status' => 'paid'],
            ['row_id' => 'r2', 'payment_status' => 'تم دفعه'],
        ],
    ];
    $st4 = ReceiptRepository::inspectReceiptSalfaStatus($rLegacyRowPaid);
    s1_assert($st4['eligible'] === false && $st4['status'] === 'paid',
        'Legacy receipt with unanimous row.payment_status=paid is ineligible for salfa');

    // 1.5 Legacy conflicting row-level payment_status
    $rLegacyConflict = [
        'payment_status' => null,
        'payout_status'  => 'unpaid',
        'rows'           => [
            ['row_id' => 'r1', 'payment_status' => 'paid'],
            ['row_id' => 'r2', 'payment_status' => 'unpaid'],
        ],
    ];
    $st5 = ReceiptRepository::inspectReceiptSalfaStatus($rLegacyConflict);
    s1_assert($st5['eligible'] === false && $st5['status'] === 'inconsistent',
        'Legacy receipt with conflicting row.payment_status values is flagged inconsistent');

    // 1.6 Explicit conflict: payment_status = 'unpaid' while payout_status = 'paid'
    $rExplicitConflict = [
        'payment_status' => 'unpaid',
        'payout_status'  => 'paid',
        'rows'           => [],
    ];
    $st6 = ReceiptRepository::inspectReceiptSalfaStatus($rExplicitConflict);
    s1_assert($st6['eligible'] === false && $st6['status'] === 'inconsistent',
        'Receipt with explicit payment_status=unpaid and payout_status=paid is flagged inconsistent');

    // 1.7 Legacy payout_status = 'paid' / 'partial' / 'cancelled' with payment_status = null
    foreach (['paid', 'partial', 'cancelled'] as $legacyPayout) {
        $stLegacy = ReceiptRepository::inspectReceiptSalfaStatus([
            'payment_status' => null,
            'payout_status'  => $legacyPayout,
            'rows'           => [],
        ]);
        s1_assert($stLegacy['eligible'] === false && $stLegacy['status'] === $legacyPayout,
            "Legacy receipt with payment_status=null and payout_status={$legacyPayout} is ineligible");
    }

    // 1.8 Server-authoritative row formula recalculation overrides tampered net when weight & noloon are present
    $normRows = ReceiptRepository::prepareRowsForCreate([
        [
            'weight'       => 50,
            'deficit'      => 200, // 0.2 ton
            'noloon'       => 100, // (50 - 0.2) * 100 = 4980
            'ohda'         => 500,
            'officeAmount' => 300,
            'sarf'         => 200,
            'add'          => 20,  // 4980 - 1000 + 20 = 4000
            'net'          => 999999, // tampered client value
        ],
    ]);
    s1_assert(abs($normRows[0]['net'] - 4000.0) < 1e-6,
        'prepareRowsForCreate recomputes authoritative row.net (4000.00) and ignores tampered net');

    // 1.9 F1 Regression: ['net' => 2500, 'sarf' => 100, 'ohda' => 0] preserves net = 2500.00
    $f1Case1 = ReceiptRepository::prepareRowsForCreate([
        ['net' => 2500, 'sarf' => 100, 'ohda' => 0],
    ]);
    $f1Calc1 = VehicleLedgerRepository::calculateRowNetAndSarfCents(['net' => 2500, 'sarf' => 100, 'ohda' => 0]);
    s1_assert(
        abs($f1Case1[0]['net'] - 2500.0) < 1e-6
        && $f1Calc1['net_cents'] === 250000
        && $f1Calc1['sarf_cents'] === 10000
        && $f1Calc1['total_cents'] === 260000,
        'F1 Regression: ["net" => 2500, "sarf" => 100, "ohda" => 0] preserves net=2500 and total_cents=260000'
    );

    // 1.10 F1 Regression: ['weight' => 40, 'net' => 2500, 'sarf' => 100] (incomplete formula without noloon)
    s1_assert_throws(function () {
        ReceiptRepository::prepareRowsForCreate([
            ['weight' => 40, 'net' => 2500, 'sarf' => 100],
        ]);
    }, 'F1 Regression: Reject incomplete formula ["weight" => 40, "net" => 2500, "sarf" => 100] on create');

    s1_assert_throws(function () {
        ReceiptRepository::prepareRowsForUpdate(
            [['row_id' => 'r1', 'weight' => 40, 'net' => 2500, 'sarf' => 100]],
            [['row_id' => 'r1', 'net' => 2500, 'sarf' => 100]], // existing row also lacks noloon
            10
        );
    }, 'F1 Regression: Reject incomplete formula ["weight" => 40, "net" => 2500, "sarf" => 100] on update when existing row lacks noloon');

    // Valid partial update where existing row has trusted noloon/ohda/sarf
    $f1PartialUpdate = ReceiptRepository::prepareRowsForUpdate(
        [['row_id' => 'r1', 'weight' => 40, 'net' => 2500, 'sarf' => 100]],
        [['row_id' => 'r1', 'weight' => 26, 'noloon' => 100, 'ohda' => 0, 'sarf' => 100, 'net' => 2500]],
        10
    );
    s1_assert(
        abs($f1PartialUpdate[0]['net'] - 3900.0) < 1e-6 && (float)$f1PartialUpdate[0]['noloon'] === 100.0,
        'F1 Regression: Partial row update preserves existing noloon=100 and recalculates net=3900.00 for weight=40'
    );

    // Reject non-zero ohda/add/officeAmount when weight & noloon are absent
    s1_assert_throws(function () {
        ReceiptRepository::prepareRowsForCreate([
            ['net' => 2500, 'sarf' => 100, 'ohda' => 50],
        ]);
    }, 'F1 Regression: Reject non-zero ohda without weight and noloon');

    // 1.11 Preserve legitimate negative row.net when net + sarf >= 0
    $negNetRows = ReceiptRepository::prepareRowsForCreate([
        [
            'weight'       => 10,
            'deficit'      => 0,
            'noloon'       => 100, // 1000
            'ohda'         => 600,
            'officeAmount' => 0,
            'sarf'         => 500, // net = 1000 - 1100 = -100, but net + sarf = +400 >= 0
            'add'          => 0,
        ],
    ]);
    s1_assert(abs($negNetRows[0]['net'] - (-100.0)) < 1e-6,
        'Legitimate negative row.net (-100.00) is preserved when net + sarf (+400.00) >= 0');

    // 1.12 Reject negative (net + sarf < 0) and negative raw row inputs
    s1_assert_throws(function () {
        ReceiptRepository::prepareRowsForCreate([
            ['weight' => 1, 'noloon' => 100, 'ohda' => 500, 'sarf' => 50], // net = -450, net + sarf = -400 < 0
        ]);
    }, 'Reject row where net + sarf < 0');

    foreach (['weight', 'deficit', 'noloon', 'ohda', 'officeAmount', 'add', 'sarf'] as $negKey) {
        s1_assert_throws(function () use ($negKey) {
            ReceiptRepository::prepareRowsForCreate([
                ['weight' => 10, 'noloon' => 100, $negKey => -1],
            ]);
        }, "Reject negative raw row input: {$negKey}");
    }

    s1_assert_throws(function () {
        ReceiptRepository::validateFiniteIntCents(-100, 'paid', false);
    }, 'Reject negative paid cents');

    s1_assert_throws(function () {
        ReceiptRepository::validateFiniteIntCents('not-a-number', 'general_add', false);
    }, 'Reject non-numeric cents input');

    s1_assert_throws(function () {
        ReceiptRepository::validateFiniteIntCents(12.34, 'paid', false);
    }, 'Reject fractional cents input (12.34)');
}

// ── 2. Database Integration, Index Usage & Rollback Tests (`karta_test` ONLY) ─

function run_stage1_db_tests(PDO $db): void {
    $userA = 's1_test_user_a_' . bin2hex(random_bytes(3));
    $userB = 's1_test_user_b_' . bin2hex(random_bytes(3));

    $receiptRepo  = new ReceiptRepository($db);
    $treasuryRepo = new TreasuryRepo($db);
    $ledgerRepo   = new VehicleLedgerRepository($db);
    $officeRepo   = new OfficeRepository($db);
    $ownerRepo    = new VehicleOwnerRepository($db);
    $archiveRepo  = new ArchiveRepository($db);

    try {
        // 2.1 Seed representative rows first, then verify EXPLAIN chosen key (SV-4)
        $seedT1 = $treasuryRepo->create([
            'username'       => $userA,
            'type'           => 'withdraw',
            'effect'         => 'receipt_payout',
            'account_type'   => 'cash',
            'amount'         => 100000,
            'reference_type' => ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT,
            'reference_id'   => '9001',
            'date'           => '2026-10-20',
            'is_reversed'    => 0,
        ]);
        $seedT2 = $treasuryRepo->create([
            'username'       => $userA,
            'type'           => 'deposit',
            'effect'         => 'row_disbursement',
            'account_type'   => 'cash',
            'amount'         => 50000,
            'reference_type' => ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT,
            'reference_id'   => '9001:r1',
            'date'           => '2026-10-20',
            'is_reversed'    => 0,
        ]);
        $seedL1 = $ledgerRepo->create([
            'username'       => $userA,
            'type'           => 'receipt_payment',
            'effect'         => 'receipt_payout',
            'amount'         => 100000,
            'reference_type' => ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT,
            'reference_id'   => '9001',
            'date'           => '2026-10-20',
            'is_reversed'    => 0,
        ]);
        $seedL2 = $ledgerRepo->create([
            'username'       => $userA,
            'type'           => 'OFFICE_DEPOSIT',
            'effect'         => 'row_disbursement',
            'amount'         => 50000,
            'reference_type' => ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT,
            'reference_id'   => '9001:r1',
            'date'           => '2026-10-20',
            'is_reversed'    => 0,
        ]);

        $expTExact = $db->prepare(
            "EXPLAIN SELECT * FROM treasury
             WHERE username = :u
               AND reference_id = :rid
               AND reference_type IN ('receipt', 'receipt_payment_status')
               AND is_reversed = 0
               AND deleted_at IS NULL
             ORDER BY id ASC"
        );
        $expTExact->execute([':u' => $userA, ':rid' => '9001']);
        $planTExact = $expTExact->fetch();
        s1_assert(
            in_array($planTExact['key'] ?? '', ['idx_ref_active', 'idx_reference_id', 'idx_username'], true),
            'SV-4 EXPLAIN treasury exact-reference lookup selects an active index key (' . ($planTExact['key'] ?? 'NULL') . ')'
        );

        $expTPrefix = $db->prepare(
            "EXPLAIN SELECT * FROM treasury
             WHERE username = :u
               AND reference_id LIKE :pfx
               AND reference_type = 'receipt_row_disbursement'
               AND is_reversed = 0
               AND deleted_at IS NULL
             ORDER BY id ASC"
        );
        $expTPrefix->execute([':u' => $userA, ':pfx' => '9001:%']);
        $planTPrefix = $expTPrefix->fetch();
        s1_assert(
            in_array($planTPrefix['key'] ?? '', ['idx_ref_active', 'idx_reference_id', 'idx_username', 'idx_reference_type'], true),
            'SV-4 EXPLAIN treasury prefix lookup (LIKE :pfx) selects an active index key (' . ($planTPrefix['key'] ?? 'NULL') . ')'
        );

        $tIds = [(int)$seedT1['id'], (int)$seedT2['id']];
        sort($tIds, SORT_NUMERIC);
        $expTPkLock = $db->prepare(
            "EXPLAIN SELECT * FROM treasury
             WHERE id IN ({$tIds[0]}, {$tIds[1]})
               AND username = :u
               AND is_reversed = 0
               AND deleted_at IS NULL
             ORDER BY id ASC FOR UPDATE"
        );
        $expTPkLock->execute([':u' => $userA]);
        $planTPkLock = $expTPkLock->fetch();
        s1_assert(
            ($planTPkLock['key'] ?? '') === 'PRIMARY',
            'SV-4 EXPLAIN treasury FOR UPDATE lock query uses key=PRIMARY'
        );

        $lIds = [(int)$seedL1['id'], (int)$seedL2['id']];
        sort($lIds, SORT_NUMERIC);
        $expLPkLock = $db->prepare(
            "EXPLAIN SELECT * FROM vehicle_ledger
             WHERE id IN ({$lIds[0]}, {$lIds[1]})
               AND username = :u
               AND is_reversed = 0
               AND deleted_at IS NULL
             ORDER BY id ASC FOR UPDATE"
        );
        $expLPkLock->execute([':u' => $userA]);
        $planLPkLock = $expLPkLock->fetch();
        s1_assert(
            ($planLPkLock['key'] ?? '') === 'PRIMARY',
            'SV-4 EXPLAIN vehicle_ledger FOR UPDATE lock query uses key=PRIMARY'
        );

        // Clean up EXPLAIN seed rows before counter/receipt tests
        $db->prepare("DELETE FROM treasury WHERE id IN ({$tIds[0]}, {$tIds[1]})")->execute();
        $db->prepare("DELETE FROM vehicle_ledger WHERE id IN ({$lIds[0]}, {$lIds[1]})")->execute();

        // 2.2 Counter self-healing, F2 empty/rowless/legacy totals, and SV-5 insertReceipt validation
        $receiptRepo->ensureCounterExists($userA);

        s1_assert_throws(function () use ($receiptRepo, $userA) {
            $receiptRepo->insertReceipt([
                'uuid'           => s1_uuid(),
                'username'       => $userA,
                'receipt_number' => '999',
                'total'          => 'not-an-int', // SV-5: must reject malformed total even when rows are present
                'rows'           => [['weight' => 10, 'noloon' => 100]],
            ]);
        }, 'SV-5 insertReceipt rejects malformed total even when data rows are present');

        $db->beginTransaction();
        $num1 = $receiptRepo->allocateReceiptNumber($userA);
        $rec1 = $receiptRepo->insertReceipt([
            'uuid'             => s1_uuid(),
            'username'         => $userA,
            'receipt_number'   => $num1,
            'receipt_date'     => '2026-10-25',
            'client_id'        => '1',
            'client_type'      => 'owner',
            'client_name'      => 'Owner A',
            'total'            => 999999, // tampered total — recomputed from row
            'general_add'      => 5000,   // +50.00 EGP
            'previous_balance' => -20000, // -200.00 EGP
            'paid'             => 100000,
            'rows'             => [
                [
                    'row_id'   => 'row-a1',
                    'weight'   => 20,
                    'deficit'  => 0,
                    'noloon'   => 100, // 2000.00 EGP = 200000 cents
                    'ohda'     => 200, // -200.00
                    'sarf'     => 100, // -100.00 -> net = 1700.00 EGP (170000 cents)
                    'add'      => 0,
                    'net'      => 12345, // tampered
                ],
            ],
        ]);
        $db->commit();

        s1_assert($num1 === '1', 'First allocated receipt_number is 1');
        s1_assert((int)$rec1['total'] === 170000, 'insertReceipt recomputes authoritative total (170000 cents)');
        s1_assert((int)$rec1['net_due'] === 175000, 'insertReceipt recomputes authoritative net_due (175000 cents)');
        s1_assert((int)$rec1['net_total'] === 155000, 'insertReceipt recomputes authoritative net_total with negative previous_balance (155000 cents)');

        // Partial salfa-style update of `paid` must NOT recalculate or require rows
        $db->beginTransaction();
        $updPaid = $receiptRepo->updateReceipt((int)$rec1['id'], ['paid' => 80000], $userA);
        $db->commit();
        s1_assert($updPaid['code'] === ReceiptRepository::RESULT_OK && (int)$updPaid['data']['paid'] === 80000 && (int)$updPaid['data']['net_total'] === 155000,
            'Partial updateReceipt(["paid" => 80000]) preserves total, net_due, net_total, and rows untouched');

        // F2 Regression: Removing all rows (rows => []) resets total to 0 and recalculates net_due / net_total
        $db->beginTransaction();
        $updEmptyRows = $receiptRepo->updateReceipt((int)$rec1['id'], ['rows' => []], $userA);
        $db->commit();
        s1_assert(
            $updEmptyRows['code'] === ReceiptRepository::RESULT_OK
            && (int)$updEmptyRows['data']['total'] === 0
            && (int)$updEmptyRows['data']['net_due'] === 5000
            && (int)$updEmptyRows['data']['net_total'] === -15000,
            'F2 Regression: Removing all rows resets total=0 and updates net_due=5000, net_total=-15000'
        );

        // F2 Regression: Updating general_add and previous_balance on a rowless receipt recalculates net_due and net_total
        $db->beginTransaction();
        $updRowlessTotals = $receiptRepo->updateReceipt((int)$rec1['id'], [
            'total'            => 100000,
            'general_add'      => 10000,
            'previous_balance' => -30000,
        ], $userA);
        $db->commit();
        s1_assert(
            $updRowlessTotals['code'] === ReceiptRepository::RESULT_OK
            && (int)$updRowlessTotals['data']['total'] === 100000
            && (int)$updRowlessTotals['data']['net_due'] === 110000
            && (int)$updRowlessTotals['data']['net_total'] === 80000,
            'F2 Regression: Updating general_add/previous_balance on rowless receipt recalculates net_due=110000, net_total=80000'
        );

        // SV-6 (1): Legacy receipt with existing rows lacking both `net` and formula inputs (`weight`/`noloon`)
        //           Updating general_add or previous_balance must preserve the existing `total`.
        $db->prepare('UPDATE receipts SET `rows` = :rows, total = 250000, general_add = 0, previous_balance = 0, net_due = 250000, net_total = 250000 WHERE id = :id')
            ->execute([
                ':rows' => json_encode([['row_id' => 'legacy-r1', 'driver' => 'Legacy Driver', 'office' => 'Legacy Office']], JSON_UNESCAPED_UNICODE),
                ':id'   => (int)$rec1['id'],
            ]);
        $db->beginTransaction();
        $updLegacy = $receiptRepo->updateReceipt((int)$rec1['id'], [
            'general_add'      => 15000,
            'previous_balance' => -5000,
        ], $userA);
        $db->commit();
        s1_assert(
            $updLegacy['code'] === ReceiptRepository::RESULT_OK
            && (int)$updLegacy['data']['total'] === 250000
            && (int)$updLegacy['data']['net_due'] === 265000
            && (int)$updLegacy['data']['net_total'] === 260000,
            'SV-6 (1) Legacy receipt with rows lacking net & formula inputs preserves total=250000 and updates net_due=265000, net_total=260000'
        );

        // Soft-delete rec1, simulate counter drift to 0, and verify ensureCounterExists self-heals to 1 so next is 2
        $db->beginTransaction();
        $receiptRepo->softDelete((int)$rec1['id'], $userA);
        $db->commit();
        $db->prepare('UPDATE receipt_counters SET next_number = 0 WHERE username = :u')->execute([':u' => $userA]);
        $receiptRepo->ensureCounterExists($userA);

        $db->beginTransaction();
        $num2 = $receiptRepo->allocateReceiptNumber($userA);
        $rec2 = $receiptRepo->insertReceipt([
            'uuid'             => s1_uuid(),
            'username'         => $userA,
            'receipt_number'   => $num2,
            'receipt_date'     => '2026-10-25',
            'total'            => 50000,
            'general_add'      => 5000,
            'previous_balance' => -10000,
            'net_due'          => 999999, // SV-5: rowless receipt must still compute net_due = total + general_add
            'net_total'        => 888888, // SV-5: rowless receipt must still compute net_total = net_due + previous_balance
            'rows'             => [],
        ]);
        $db->commit();
        s1_assert($num2 === '2', 'ensureCounterExists self-heals across soft-deleted receipts and never reuses receipt_number 1');
        s1_assert(
            (int)$rec2['net_due'] === 55000 && (int)$rec2['net_total'] === 45000,
            'SV-5 insertReceipt on rowless receipt computes net_due=55000 and net_total=45000 from total+general_add+previous_balance'
        );

        // Archive rec2 (is_archived = 1), simulate counter drift to 0, and verify ensureCounterExists self-heals to 2 so next is 3
        $db->prepare('UPDATE receipts SET is_archived = 1 WHERE id = :id')->execute([':id' => (int)$rec2['id']]);
        $db->prepare('UPDATE receipt_counters SET next_number = 0 WHERE username = :u')->execute([':u' => $userA]);
        $receiptRepo->ensureCounterExists($userA);

        $db->beginTransaction();
        $num3 = $receiptRepo->allocateReceiptNumber($userA);
        $db->rollBack();
        s1_assert($num3 === '3', 'ensureCounterExists self-heals across archived receipts and never reuses receipt_number 2');
        $db->prepare('UPDATE receipts SET is_archived = 0 WHERE id = :id')->execute([':id' => (int)$rec2['id']]);

        // 2.3 SV-5 & SV-6 (4, 5, 6): Owner `receipt_due` parity, omitted ledger_ops preservation, and zero duplicates across repeated updates
        $ownerDueTest = $ownerRepo->create(['username' => $userA, 'name' => 'Owner Due Parity']);
        $db->beginTransaction();
        $numDue = $receiptRepo->allocateReceiptNumber($userA);
        $recDue = $receiptRepo->insertReceipt([
            'uuid'           => s1_uuid(),
            'username'       => $userA,
            'receipt_number' => $numDue,
            'receipt_date'   => '2026-10-25',
            'client_id'      => (string)$ownerDueTest['id'],
            'client_type'    => 'owner',
            'client_name'    => $ownerDueTest['name'],
            'general_add'    => 10000, // +100 EGP
            'rows'           => [
                ['row_id' => 'r-due-1', 'weight' => 10, 'noloon' => 100, 'sarf' => 100], // net = 900 EGP (90000 cents) -> net_due = 100000 cents
            ],
        ]);
        $dueIdStr = (string)$recDue['id'];
        $syncedDue1 = $ledgerRepo->syncOwnerReceiptDueForReceipt(
            $userA, $dueIdStr, $recDue['receipt_number'], $recDue['receipt_date'],
            (int)$recDue['net_due'], (string)$ownerDueTest['id'], 'owner', $ownerDueTest['name']
        );
        $db->commit();

        // Simulate receipt-update with omitted ledger_ops (`reverseCustomReceiptEntriesForUser` + `syncOwnerReceiptDueForReceipt`)
        // repeated twice with updated rows
        for ($iter = 1; $iter <= 2; $iter++) {
            $db->beginTransaction();
            $updDueRes = $receiptRepo->updateReceipt((int)$recDue['id'], [
                'general_add' => 20000, // +200 EGP -> net_due = 110000 cents
            ], $userA);
            $ledgerRepo->reverseCustomReceiptEntriesForUser($userA, $dueIdStr);
            $ledgerRepo->syncOwnerReceiptDueForReceipt(
                $userA, $dueIdStr, $updDueRes['data']['receipt_number'], $updDueRes['data']['receipt_date'],
                (int)$updDueRes['data']['net_due'], (string)$ownerDueTest['id'], 'owner', $ownerDueTest['name']
            );
            $db->commit();
        }
        $activeDueRows = $ledgerRepo->getActiveByReferenceForUser($userA, $dueIdStr, 'receipt', false);
        s1_assert(
            count($activeDueRows) === 1
            && ($activeDueRows[0]['type'] ?? '') === 'receipt_due'
            && (int)$activeDueRows[0]['amount'] === 110000,
            'SV-5 & SV-6 (4, 5, 6): Owner receipt_due is synced from server net_due (110000), preserved when ledger_ops is omitted, and never duplicated across repeated updates'
        );

        // 2.4 SV-1, SV-2, SV-6 (2, 3): Salfa edit/delete rejection for paid, archived, deleted, inconsistent receipts & repeated delete/edit on reversed salfa
        $db->beginTransaction();
        $numSalfa = $receiptRepo->allocateReceiptNumber($userA);
        $recSalfa = $receiptRepo->insertReceipt([
            'uuid'           => s1_uuid(),
            'username'       => $userA,
            'receipt_number' => $numSalfa,
            'receipt_date'   => '2026-10-25',
            'client_id'      => (string)$ownerDueTest['id'],
            'client_type'    => 'owner',
            'client_name'    => $ownerDueTest['name'],
            'paid'           => 100000, // 1000 EGP
            'rows'           => [
                ['row_id' => 'r-salfa-1', 'weight' => 10, 'noloon' => 100], // net_total = 100000 cents
            ],
        ]);
        $salfaRecId = (int)$recSalfa['id'];
        // Apply 200 EGP (20000 cents) salfa -> receipt.paid becomes 80000 cents
        $receiptRepo->updateReceipt($salfaRecId, ['paid' => 80000], $userA);
        $salfaRef = 'salfa-ref-' . bin2hex(random_bytes(4));
        $salfaT = $treasuryRepo->create([
            'username'       => $userA,
            'type'           => 'withdraw',
            'effect'         => 'salfa',
            'account_type'   => 'cash',
            'amount'         => 20000,
            'reference_type' => 'salfa',
            'reference_id'   => $salfaRef,
            'client_id'      => (string)$ownerDueTest['id'],
            'client_type'    => 'owner',
            'client_name'    => $ownerDueTest['name'],
            'receipt_number' => (string)$salfaRecId,
            'date'           => '2026-10-25',
            'is_reversed'    => 0,
        ]);
        $salfaL = $ledgerRepo->create([
            'username'       => $userA,
            'client_id'      => (string)$ownerDueTest['id'],
            'client_type'    => 'owner',
            'client_name'    => $ownerDueTest['name'],
            'type'           => 'withdraw',
            'effect'         => 'salfa',
            'amount'         => 20000,
            'reference_type' => 'salfa',
            'reference_id'   => $salfaRef,
            'date'           => '2026-10-25',
            'is_reversed'    => 0,
        ]);
        $db->commit();
        $salfaTId = (int)$salfaT['id'];

        // (a) Reject salfa edit & delete when linked receipt is PAID (payment_status = 'paid'), including $delta === 0 note edit
        $db->prepare("UPDATE receipts SET payment_status = 'paid' WHERE id = :id")->execute([':id' => $salfaRecId]);
        $resPaidEditAmount = s1_exec_salfa_mutation($db, 'edit', $salfaTId, $userA, ['amount' => 30000]);
        $resPaidEditNote   = s1_exec_salfa_mutation($db, 'edit', $salfaTId, $userA, ['note' => 'attempt note edit while paid']);
        $resPaidDelete     = s1_exec_salfa_mutation($db, 'delete', $salfaTId, $userA);
        $db->prepare("UPDATE receipts SET payment_status = 'unpaid' WHERE id = :id")->execute([':id' => $salfaRecId]);
        s1_assert(
            $resPaidEditAmount['status'] === 409 && $resPaidEditNote['status'] === 409 && $resPaidDelete['status'] === 409,
            'SV-2 & SV-6 (3): Salfa amount edit, non-amount edit, and delete are rejected (409) when linked receipt is paid'
        );

        // (b) Reject salfa edit & delete when linked receipt is ARCHIVED
        $db->prepare("UPDATE receipts SET is_archived = 1 WHERE id = :id")->execute([':id' => $salfaRecId]);
        $resArchEdit   = s1_exec_salfa_mutation($db, 'edit', $salfaTId, $userA, ['amount' => 30000]);
        $resArchDelete = s1_exec_salfa_mutation($db, 'delete', $salfaTId, $userA);
        $db->prepare("UPDATE receipts SET is_archived = 0 WHERE id = :id")->execute([':id' => $salfaRecId]);
        s1_assert(
            $resArchEdit['status'] === 409 && $resArchDelete['status'] === 409,
            'SV-6 (3): Salfa edit and delete are rejected (409) when linked receipt is archived'
        );

        // (c) Reject salfa edit & delete when linked receipt is SOFT-DELETED
        $db->prepare("UPDATE receipts SET deleted_at = NOW(3) WHERE id = :id")->execute([':id' => $salfaRecId]);
        $resDelEdit   = s1_exec_salfa_mutation($db, 'edit', $salfaTId, $userA, ['amount' => 30000]);
        $resDelDelete = s1_exec_salfa_mutation($db, 'delete', $salfaTId, $userA);
        $db->prepare("UPDATE receipts SET deleted_at = NULL WHERE id = :id")->execute([':id' => $salfaRecId]);
        s1_assert(
            $resDelEdit['status'] === 409 && $resDelDelete['status'] === 409,
            'SV-6 (3): Salfa edit and delete are rejected (409) when linked receipt is soft-deleted'
        );

        // (d) Reject salfa edit & delete when linked receipt is INCONSISTENT (payment_status = 'unpaid', payout_status = 'paid')
        $db->prepare("UPDATE receipts SET payment_status = 'unpaid', payout_status = 'paid' WHERE id = :id")->execute([':id' => $salfaRecId]);
        $resIncEdit   = s1_exec_salfa_mutation($db, 'edit', $salfaTId, $userA, ['amount' => 30000]);
        $resIncDelete = s1_exec_salfa_mutation($db, 'delete', $salfaTId, $userA);
        $db->prepare("UPDATE receipts SET payment_status = 'unpaid', payout_status = 'unpaid' WHERE id = :id")->execute([':id' => $salfaRecId]);
        s1_assert(
            $resIncEdit['status'] === 409 && $resIncDelete['status'] === 409,
            'SV-6 (3): Salfa edit and delete are rejected (409) when linked receipt status is inconsistent'
        );

        // (e) Valid salfa delete restores receipt.paid from 80000 -> 100000; repeated delete/edit on reversed salfa is rejected (409)
        //     and does NOT change receipt.paid again (even if receipt.paid is later lowered to 60000)!
        $resValidDelete = s1_exec_salfa_mutation($db, 'delete', $salfaTId, $userA);
        $recAfterFirstDelete = $receiptRepo->findById($salfaRecId);
        $db->prepare("UPDATE receipts SET paid = 60000 WHERE id = :id")->execute([':id' => $salfaRecId]);
        $resSecondDelete = s1_exec_salfa_mutation($db, 'delete', $salfaTId, $userA);
        $resEditReversed = s1_exec_salfa_mutation($db, 'edit', $salfaTId, $userA, ['amount' => 10000]);
        $recAfterSecondDelete = $receiptRepo->findById($salfaRecId);
        $salfaTAfter = $treasuryRepo->getById($salfaTId);
        s1_assert(
            $resValidDelete['status'] === 200
            && (int)$recAfterFirstDelete['paid'] === 100000
            && $resSecondDelete['status'] === 409
            && $resEditReversed['status'] === 409
            && (int)$recAfterSecondDelete['paid'] === 60000
            && (string)$salfaTAfter['receipt_number'] === (string)$salfaRecId,
            'SV-1 & SV-6 (2): Deleting salfa restores receipt.paid once; repeated delete/edit on reversed salfa is rejected (409) without altering receipt.paid or clearing receipt_number'
        );

        // 2.5 F7 & SV-6 (10): Multi-tenant isolation using real second test user ($userB)
        $officeA = $officeRepo->create(['username' => $userA, 'name' => 'Office Shared']);
        $officeB = $officeRepo->create(['username' => $userB, 'name' => 'Office Shared']);
        $sharedRefId = '777888';

        $db->beginTransaction();
        $ledgerRepo->syncOfficeDeductionsForReceipt(
            $userA, $sharedRefId, '10', '2026-10-25',
            [['office' => 'Office Shared', 'net' => 1000, 'sarf' => 100]],
            $officeRepo, 'Owner A', '1'
        );
        $ledgerRepo->syncOfficeDeductionsForReceipt(
            $userB, $sharedRefId, '10', '2026-10-25',
            [['office' => 'Office Shared', 'net' => 2000, 'sarf' => 200]],
            $officeRepo, 'Owner B', '2'
        );
        $ledgerRepo->syncOwnerReceiptDueForReceipt($userA, $sharedRefId, '10', '2026-10-25', 100000, '1', 'owner', 'Owner A');
        $ledgerRepo->syncOwnerReceiptDueForReceipt($userB, $sharedRefId, '10', '2026-10-25', 200000, '2', 'owner', 'Owner B');

        // Re-sync userA with empty rows and reverse userA's receipt_due — userB must remain untouched!
        $ledgerRepo->syncOfficeDeductionsForReceipt($userA, $sharedRefId, '10', '2026-10-25', [], $officeRepo, 'Owner A', '1');
        $ledgerRepo->reverseOwnerReceiptDueForReceipt($userA, $sharedRefId);
        $db->commit();

        $activeB = $ledgerRepo->getActiveByReferenceForUser($userB, $sharedRefId, 'receipt', false);
        s1_assert(
            count($activeB) === 2,
            'SV-6 (10) Multi-tenant isolation: userA office-deduction & receipt_due reversals never affect userB rows'
        );

        // 2.6 F7 & SV-6 (9): Movement-pair parity, zero duplicates, reconciliation, and atomic rollback on RESULT_INCONSISTENT_LEDGER
        $ownerA = $ownerRepo->create(['username' => $userA, 'name' => 'Owner Parity']);
        $db->beginTransaction();
        $numParity = $receiptRepo->allocateReceiptNumber($userA);
        $recParity = $receiptRepo->insertReceipt([
            'uuid'           => s1_uuid(),
            'username'       => $userA,
            'receipt_number' => $numParity,
            'receipt_date'   => '2026-10-26',
            'client_id'      => (string)$ownerA['id'],
            'client_type'    => 'owner',
            'client_name'    => $ownerA['name'],
            'paid'           => 90000,
            'rows'           => [
                [
                    'row_id' => 'row-p1',
                    'office' => 'Office Shared',
                    'weight' => 10,
                    'noloon' => 100, // 1000 EGP
                    'sarf'   => 100, // net = 900 EGP, net + sarf = 1000 EGP (100000 cents)
                ],
            ],
        ]);
        $db->commit();
        $parityId = (int)$recParity['id'];
        $rowRefId = ReceiptRepository::buildRowDisbursementRefId($parityId, 'row-p1');

        // Transition row unpaid -> paid
        $db->beginTransaction();
        $trRow1 = $receiptRepo->transitionRowDisbursementStatus($parityId, 'row-p1', 'paid', $userA, $treasuryRepo, $ledgerRepo, $officeRepo);
        $db->commit();

        // Repeated idempotent transition paid -> paid must NOT create duplicate movements
        $db->beginTransaction();
        $trRowDup = $receiptRepo->transitionRowDisbursementStatus($parityId, 'row-p1', 'paid', $userA, $treasuryRepo, $ledgerRepo, $officeRepo);
        $db->commit();

        $activeRowT = $treasuryRepo->getActiveByReferenceForUser($userA, $rowRefId, ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT, false);
        $activeRowL = $ledgerRepo->getActiveByReferenceForUser($userA, $rowRefId, ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT, false);
        s1_assert(
            $trRow1['code'] === ReceiptRepository::RESULT_OK
            && $trRowDup['code'] === ReceiptRepository::RESULT_OK
            && $trRowDup['changed'] === false
            && count($activeRowT) === 1
            && count($activeRowL) === 1
            && (int)$activeRowT[0]['amount'] === 100000
            && (int)$activeRowL[0]['amount'] === 100000,
            'F7 Movement-pair parity & idempotency: 1 treasury + 1 vehicle_ledger row (100000 cents) and 0 duplicates'
        );

        // Transition receipt payment unpaid -> paid
        $db->beginTransaction();
        $trPay1 = $receiptRepo->transitionReceiptPaymentStatus($parityId, 'paid', $userA, $treasuryRepo, $ledgerRepo, $ownerRepo);
        $db->commit();
        $activePayT = $treasuryRepo->getActiveByReferenceForUser($userA, (string)$parityId, ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT, false);
        $activePayL = $ledgerRepo->getActiveByReferenceForUser($userA, (string)$parityId, ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT, false);
        s1_assert(
            $trPay1['code'] === ReceiptRepository::RESULT_OK
            && count($activePayT) === 1
            && count($activePayL) === 1
            && $activePayT[0]['description'] === 'صرف كارتة - ' . $ownerA['name'],
            'F7 Receipt payment parity: 1 treasury + 1 vehicle_ledger row with exact description'
        );

        // Inject an orphaned active row-disbursement movement and verify atomic rollback on RESULT_INCONSISTENT_LEDGER
        $orphanT = $treasuryRepo->create([
            'username'       => $userA,
            'type'           => 'deposit',
            'effect'         => 'row_disbursement',
            'account_type'   => 'cash',
            'amount'         => 50000,
            'reference_type' => ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT,
            'reference_id'   => $parityId . ':orphan-row',
            'client_id'      => (string)$officeA['id'],
            'client_type'    => 'office',
            'date'           => '2026-10-26',
            'is_reversed'    => 0,
        ]);

        $verBeforeStmt = $db->query("SELECT entity_name, version FROM data_versions ORDER BY entity_name ASC");
        $versionsBefore = $verBeforeStmt ? $verBeforeStmt->fetchAll(PDO::FETCH_KEY_PAIR) : [];
        $recBeforeRollback = $receiptRepo->findById($parityId);

        $db->beginTransaction();
        $updAttempt = $receiptRepo->updateReceipt($parityId, ['paid' => 70000], $userA);
        $reconcileFail = $receiptRepo->reconcileStatusMovementsOnReceiptUpdate(
            $updAttempt['previous'],
            $updAttempt['data'],
            $userA,
            $treasuryRepo,
            $ledgerRepo,
            $officeRepo,
            $ownerRepo
        );
        if ($reconcileFail['code'] !== ReceiptRepository::RESULT_OK) {
            $db->rollBack();
        } else {
            $db->commit();
        }

        $recAfterRollback = $receiptRepo->findById($parityId);
        $verAfterStmt = $db->query("SELECT entity_name, version FROM data_versions ORDER BY entity_name ASC");
        $versionsAfter = $verAfterStmt ? $verAfterStmt->fetchAll(PDO::FETCH_KEY_PAIR) : [];
        $activePayTAfter = $treasuryRepo->getActiveByReferenceForUser($userA, (string)$parityId, ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT, false);

        s1_assert(
            $reconcileFail['code'] === ReceiptRepository::RESULT_INCONSISTENT_LEDGER
            && (int)$recAfterRollback['paid'] === (int)$recBeforeRollback['paid']
            && count($activePayTAfter) === 1
            && (int)$activePayTAfter[0]['amount'] === 90000
            && $versionsBefore === $versionsAfter,
            'SV-6 (9) Atomic rollback on RESULT_INCONSISTENT_LEDGER leaves receipts, treasury, vehicle_ledger, and data_versions unchanged'
        );

        // Remove the orphan and verify reverseAllStatusMovementsOnReceiptDelete reverses all pairs cleanly
        $db->prepare('DELETE FROM treasury WHERE id = :id')->execute([':id' => (int)$orphanT['id']]);
        $db->beginTransaction();
        $delRevRes = $receiptRepo->reverseAllStatusMovementsOnReceiptDelete($parityId, $userA, $treasuryRepo, $ledgerRepo, $officeRepo, true);
        $db->commit();

        $remRowT = $treasuryRepo->getActiveByReferenceForUser($userA, $rowRefId, ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT, false);
        $remRowL = $ledgerRepo->getActiveByReferenceForUser($userA, $rowRefId, ReceiptRepository::REF_TYPE_ROW_DISBURSEMENT, false);
        $remPayT = $treasuryRepo->getActiveByReferenceForUser($userA, (string)$parityId, ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT, false);
        $remPayL = $ledgerRepo->getActiveByReferenceForUser($userA, (string)$parityId, ReceiptRepository::REF_TYPE_RECEIPT_PAYMENT, false);
        s1_assert(
            $delRevRes['code'] === ReceiptRepository::RESULT_OK
            && count($remRowT) === 0 && count($remRowL) === 0
            && count($remPayT) === 0 && count($remPayL) === 0,
            'F7 reverseAllStatusMovementsOnReceiptDelete reverses all row and receipt movement pairs atomically'
        );

        // 2.7 SV-3 & SV-6 (8): Archive lockArchivableRecords + snapshot consistency
        $db->beginTransaction();
        $lockedMap = $archiveRepo->lockArchivableRecords($userA, '2026-10-01', '2026-10-31');
        $snap = $archiveRepo->computeSnapshot($userA, '2026-10-31', '2026-10-01');
        $batchUuid = s1_uuid();
        $archivedCount = $archiveRepo->archiveRecords($userA, '2026-10-01', '2026-10-31', $batchUuid, '2026-10-26 12:00:00', $lockedMap);
        $expectedLockedTotal = array_sum(array_map('count', $lockedMap));
        $db->rollBack();
        s1_assert(
            $archivedCount === $expectedLockedTotal && is_int($snap['treasury_balance']),
            'SV-3 & SV-6 (8): lockArchivableRecords and archiveRecords archive the exact locked record set (' . $archivedCount . ' records)'
        );

        // 2.8 SV-6 (7): Two-connection PDO lock contention test against karta_test
        $db2 = getDedicatedKartaTestDB();
        $db2->exec('SET innodb_lock_wait_timeout = 1');
        $db->beginTransaction();
        // Connection 1 locks userA's receipt_counters row (used by receipt allocation & first-time archive serialization)
        $c1Stmt = $db->prepare('SELECT next_number FROM receipt_counters WHERE username = :u FOR UPDATE');
        $c1Stmt->execute([':u' => $userA]);

        $db2->beginTransaction();
        $lockBlockedAsExpected = false;
        try {
            $c2Stmt = $db2->prepare('SELECT next_number FROM receipt_counters WHERE username = :u FOR UPDATE');
            $c2Stmt->execute([':u' => $userA]);
        } catch (PDOException $lockEx) {
            // SQLSTATE HY000 / 1205 Lock wait timeout exceeded proves Connection 1 holds the exclusive row lock
            $lockBlockedAsExpected = true;
        }
        $db2->rollBack();
        $db->rollBack();
        s1_assert(
            $lockBlockedAsExpected === true,
            'SV-6 (7): Two-connection contention test confirms exclusive FOR UPDATE serialization on receipt_counters in karta_test'
        );
    } finally {
        // Cleanup test records in karta_test
        $db->prepare('DELETE FROM archive_batches WHERE username IN (:ua, :ub)')->execute([':ua' => $userA, ':ub' => $userB]);
        $db->prepare('DELETE FROM vehicle_ledger WHERE username IN (:ua, :ub)')->execute([':ua' => $userA, ':ub' => $userB]);
        $db->prepare('DELETE FROM treasury WHERE username IN (:ua, :ub)')->execute([':ua' => $userA, ':ub' => $userB]);
        $db->prepare('DELETE FROM receipts WHERE username IN (:ua, :ub)')->execute([':ua' => $userA, ':ub' => $userB]);
        $db->prepare('DELETE FROM receipt_counters WHERE username IN (:ua, :ub)')->execute([':ua' => $userA, ':ub' => $userB]);
        $db->prepare('DELETE FROM offices WHERE username IN (:ua, :ub)')->execute([':ua' => $userA, ':ub' => $userB]);
        $db->prepare('DELETE FROM vehicle_owners WHERE username IN (:ua, :ub)')->execute([':ua' => $userA, ':ub' => $userB]);
    }
}

if (php_sapi_name() === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    echo "═══════════════════════════════════════════════════════════════\n";
    echo "  Karta ERP — Stage 1 / 1.1 / 1.2 Verification Suite (karta_test)\n";
    echo "═══════════════════════════════════════════════════════════════\n\n";

    run_stage1_unit_tests();

    try {
        $db = getDedicatedKartaTestDB();
        echo "✅ Connected exclusively to dedicated database: karta_test\n";
        run_stage1_db_tests($db);
    } catch (Throwable $e) {
        echo "⚠️ Database tests skipped or aborted: " . $e->getMessage() . "\n";
        s1_assert(false, 'Dedicated karta_test DB connection & integration suite', $e->getMessage());
    }

    $passed = count(array_filter($_STAGE1_RESULTS, fn($r) => $r['pass']));
    $failed = count($_STAGE1_RESULTS) - $passed;
    foreach ($_STAGE1_RESULTS as $r) {
        $icon = $r['pass'] ? '✅' : '❌';
        echo "  {$icon} {$r['label']}" . ($r['reason'] ? " — {$r['reason']}" : '') . "\n";
    }
    echo "\nSummary: {$passed} passed, {$failed} failed\n";
    exit($failed === 0 ? 0 : 1);
}
