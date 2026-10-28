import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function readRepoFile(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

test('Stage 1.2 — versionTracker.php deduplicates and sorts entity names in ascending order', () => {
  const src = readRepoFile('karta/core/versionTracker.php');
  assert.match(src, /\$sorted = array_values\(\$unique\);/);
  assert.match(src, /sort\(\$sorted,\s*SORT_STRING\);/);
});

test('Stage 1.2 (SV-3 & SV-4) — TreasuryRepository2.php uses PK-targeted FOR UPDATE in getActiveByReferenceForUser & lockActiveForReceipt and PK-targeted reverseByReferenceForUser', () => {
  const src = readRepoFile('karta/repositories/TreasuryRepository2.php');
  const pkLocks = src.match(/WHERE id IN \(\{\$inClause\}\)\s+AND username = :u\s+AND is_reversed = 0\s+AND deleted_at IS NULL\s+ORDER BY id ASC FOR UPDATE/g) || [];
  assert.equal(pkLocks.length, 2, 'Both getActiveByReferenceForUser and lockActiveForReceipt must lock via PRIMARY KEY id IN (...) ORDER BY id ASC FOR UPDATE');
  assert.match(src, /UPDATE treasury\s+SET is_reversed = 1, reversed_at = :now, reversed_by = :rev_by, updated_at = NOW\(3\)\s+WHERE id IN \(\{\$inClause\}\)/);
});

test('Stage 1.2 (SV-3, SV-4, SV-5) — VehicleLedgerRepository.php uses PK-targeted locking/reversals and provides reverseCustomReceiptEntriesForUser & syncOwnerReceiptDueForReceipt', () => {
  const src = readRepoFile('karta/repositories/VehicleLedgerRepository.php');
  const pkLocks = src.match(/WHERE id IN \(\{\$inClause\}\)\s+AND username = :u\s+AND is_reversed = 0\s+AND deleted_at IS NULL\s+ORDER BY id ASC FOR UPDATE/g) || [];
  assert.equal(pkLocks.length, 2, 'Both getActiveByReferenceForUser and lockActiveForReceipt must lock via PRIMARY KEY id IN (...) ORDER BY id ASC FOR UPDATE');
  assert.match(src, /public function reverseCustomReceiptEntriesForUser\(/);
  assert.match(src, /public function syncOwnerReceiptDueForReceipt\(/);
});

test('Stage 1.2 (SV-5) — All 4 receipt create/update endpoints synchronize owner receipt_due from server-calculated net_due', () => {
  for (const relPath of [
    'karta/api/financial/receipt-create.php',
    'karta/api/financial/receipt-update.php',
    'karta/api/entities/receipts/create.php',
    'karta/api/entities/receipts/update.php',
  ]) {
    const src = readRepoFile(relPath);
    assert.match(src, /\$ledgerRepo->syncOwnerReceiptDueForReceipt\(/, `${relPath} must call syncOwnerReceiptDueForReceipt`);
  }

  const finCreate = readRepoFile('karta/api/financial/receipt-create.php');
  assert.match(finCreate, /\$opType === 'OFFICE_WITHDRAW_AUTO' \|\| \$opType === 'receipt_due' \|\| \$opEffect === 'receipt_total'/);

  const finUpdate = readRepoFile('karta/api/financial/receipt-update.php');
  assert.match(finUpdate, /\$isPaid = ReceiptRepository::getReceiptPaymentStatus\(\$existing\) === 'paid';/);
  assert.match(finUpdate, /\$ledgerRepo->reverseCustomReceiptEntriesForUser\(\$username, strval\(\$receiptId\)\);/);
});

test('Stage 1.2 (SV-1 & SV-2) — Salfa endpoints reject already-reversed records, validate positive integer amounts, lock/check receipt on all edits, and block entity-endpoint bypasses', () => {
  const salfaEntry = readRepoFile('karta/api/financial/treasury-entry.php');
  assert.match(salfaEntry, /ReceiptRepository::validateFiniteIntCents\(\$body\['amount'\]/);
  assert.match(salfaEntry, /if \(\$submittedEffect === 'salfa' && intval\(\$body\['amount'\] \?\? 0\) <= 0\)/);

  const salfaEdit = readRepoFile('karta/api/financial/treasury-edit.php');
  assert.match(salfaEdit, /if \(!empty\(\$existing\['is_reversed'\]\)\)/);
  assert.match(salfaEdit, /\$isExistingSalfa = \(\$existing\['effect'\] \?\? ''\) === 'salfa' \|\| \(\$existing\['reference_type'\] \?\? ''\) === 'salfa';/);
  assert.match(salfaEdit, /'amount','date','description','note','client_name'/);

  const salfaDelete = readRepoFile('karta/api/financial/treasury-delete.php');
  assert.match(salfaDelete, /if \(!empty\(\$existing\['is_reversed'\]\)\)/);

  const entityUpdate = readRepoFile('karta/api/entities/treasury/update.php');
  assert.match(entityUpdate, /'receipt_row_disbursement', 'receipt_payment_status', 'salfa'/);

  const entityDelete = readRepoFile('karta/api/entities/treasury/delete.php');
  assert.match(entityDelete, /'receipt_row_disbursement', 'receipt_payment_status', 'salfa'/);
});

test('Stage 1.2 (SV-3) — ArchiveRepository.php and api/archive/create.php serialize via receipt_counters and lockArchivableRecords before computeSnapshot', () => {
  const archiveRepo = readRepoFile('karta/repositories/ArchiveRepository.php');
  assert.match(archiveRepo, /public function lockArchivableRecords\(string \$username, string \$fromDate, string \$toDate\): array/);
  assert.match(archiveRepo, /\?array \$prelockedIdsByTable = null/);

  const archiveCreate = readRepoFile('karta/api/archive/create.php');
  assert.match(archiveCreate, /\$receiptRepo->ensureCounterExists\(\$username\);/);
  assert.match(archiveCreate, /SELECT next_number FROM receipt_counters WHERE username = :u FOR UPDATE/);
  const idxLockRecords = archiveCreate.indexOf('$repo->lockArchivableRecords(');
  const idxComputeSnap = archiveCreate.indexOf('$repo->computeSnapshot(');
  assert.ok(idxLockRecords > 0 && idxComputeSnap > idxLockRecords, 'lockArchivableRecords must run before computeSnapshot');
});

test('Stage 1.2 (SV-6) — test_stage1_financial_invariants_v2.php covers legacy rows, reversed salfa, receipt_due parity, archive locking, and two-connection contention on karta_test', () => {
  const testSrc = readRepoFile('karta/tests_v2/test_stage1_financial_invariants_v2.php');
  assert.dontMatch ? assert.doesNotMatch(testSrc, /strpos\(\(string\)\(\$planTExact\['possible_keys'\]/) : assert.ok(!testSrc.includes("planTExact['possible_keys']"));
  assert.match(testSrc, /SV-6 \(1\) Legacy receipt with rows lacking net & formula inputs/);
  assert.match(testSrc, /SV-1 & SV-6 \(2\): Deleting salfa restores receipt\.paid once/);
  assert.match(testSrc, /SV-5 & SV-6 \(4, 5, 6\): Owner receipt_due is synced/);
  assert.match(testSrc, /SV-6 \(7\): Two-connection contention test/);
  assert.match(testSrc, /SV-3 & SV-6 \(8\): lockArchivableRecords and archiveRecords/);
});
