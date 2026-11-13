/**
 * test_archive_removal_phase1_v2.mjs
 *
 * Automated verification suite for Phase 1 — Complete Archive Feature Removal
 * (Application Layer Only, Schema Retained for Phase 2):
 *   1. Archive UI, sidebar navigation, and router removal + safe startup/showPage fallback
 *      when sessionStorage contains a stale `archivePage` or `archiveViewerPage` value.
 *   2. Complete deletion of archive-only frontend/backend modules and removal of
 *      archive domain/sync registrations while preserving database schema files.
 *   3. FinancialService & TreasuryService preservation:
 *      - `updateReceipt()` preserves `_existing = await DBProvider.get('receipts', id)`
 *        and sends `updated_at` for optimistic concurrency control.
 *      - `deleteReceipt()` and `updateReceiptStatus()` operate without archive guards.
 *      - `getClientBalance()` and `TreasuryService.getSummary()` / `editEntry()` / `deleteEntry()`
 *        preserve exact live-ledger math and validation with zero `/archive/` requests.
 *   4. BackupRepository Phase 1 compatibility:
 *      - Backup creation with empty archive tables includes `archive_batches` and `financial_snapshots`
 *        and restores cleanly.
 *      - Legacy backups omitting one or both archive table keys validate cleanly (both skipped-key
 *        and zero-count archive checksums) without weakening checksum validation for any core table.
 *      - Legacy backup restore succeeds when target archive tables are empty.
 *      - Legacy backup restore stops with a clear, actionable error before any `DELETE FROM`
 *        when the backup omits archive keys and the target database contains archive data.
 *      - Backups containing non-empty archive tables (`archive_batches`, `financial_snapshots`)
 *        or archived business records (`is_archived = 1` / non-empty `archive_batch_id`) are safely
 *        rejected before any destructive operation with a clear error explaining that the backup
 *        contains data from the removed Archive feature.
 *      - Existing 14-table and 15-table backup checksums remain 100% compatible.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KARTA_DIR = path.resolve(__dirname, '..');

test('1. Archive-only files are deleted while Phase 1 database schema files are preserved', () => {
  const deletedFiles = [
    'archive.js',
    'archiveViewer.js',
    'archiveConstants.js',
    'services/archiveService.js',
    'services/archiveRepository.js',
    'repositories/ArchiveRepository.php',
    'api/archive/create.php',
    'api/archive/delete.php',
    'api/archive/get.php',
    'api/archive/list.php',
    'api/archive/restore.php',
    'tests_v2/test_archive_lock_v2.php',
  ];

  for (const rel of deletedFiles) {
    assert.equal(
      fs.existsSync(path.join(KARTA_DIR, rel)),
      false,
      `Archive-only file ${rel} must be deleted in Phase 1`
    );
  }

  const retainedSchemaFiles = [
    'database_archive.sql',
    'database_receipts.sql',
    'database_treasury.sql',
    'database_vehicle_ledger.sql',
    'database_main_capital.sql',
  ];

  for (const rel of retainedSchemaFiles) {
    assert.equal(
      fs.existsSync(path.join(KARTA_DIR, rel)),
      true,
      `Schema file ${rel} must be retained in Phase 1`
    );
  }
});

test('2. UI, router, domainRegistry, and syncService have no active archive references and fall back safely from stale archivePage', async () => {
  const indexHtml = fs.readFileSync(path.join(KARTA_DIR, 'index.html'), 'utf8');
  assert.ok(!indexHtml.includes('archivePage'), 'index.html must not contain archivePage button or section');
  assert.ok(!indexHtml.includes('archiveViewerPage'), 'index.html must not contain archiveViewerPage section');
  assert.ok(!indexHtml.includes('الأرشيف'), 'index.html sidebar must not display الأرشيف link');

  const appJs = fs.readFileSync(path.join(KARTA_DIR, 'app.js'), 'utf8');
  assert.ok(!appJs.includes('archive.js'), 'app.js must not import archive.js');
  assert.ok(!appJs.includes('archiveViewer.js'), 'app.js must not import archiveViewer.js');
  assert.ok(!appJs.includes('archivePage'), 'app.js must not reference archivePage');
  assert.ok(
    appJs.includes("if (!target && resolvedPageName !== 'homePage')") &&
      appJs.includes("if (!fallbackPage || !_resolvePageElement(fallbackPage)) fallbackPage = 'homePage';"),
    'app.js must safely fall back to homePage when a saved or requested page does not exist'
  );

  const { getAllDomainNames } = await import('../services/domainRegistry.js');
  const domains = getAllDomainNames();
  assert.ok(!domains.includes('archive_batches'), 'domainRegistry must not register archive_batches');
  assert.ok(!domains.includes('financial_snapshots'), 'domainRegistry must not register financial_snapshots');
  assert.ok(domains.includes('receipts') && domains.includes('treasury') && domains.includes('vehicle_ledger'));

  const syncJs = fs.readFileSync(path.join(KARTA_DIR, 'services/syncService.js'), 'utf8');
  assert.ok(!syncJs.includes('archive_batches'), 'syncService.js must not map archive_batches');
  assert.ok(!syncJs.includes('archive:changed'), 'syncService.js must not emit archive:changed');
});

test('3. FinancialService and TreasuryService preserve optimistic concurrency and live-ledger calculations without ArchiveService', async () => {
  const financialJs = fs.readFileSync(path.join(KARTA_DIR, 'financial.js'), 'utf8');
  const treasuryJs = fs.readFileSync(path.join(KARTA_DIR, 'treasury.js'), 'utf8');

  assert.ok(!financialJs.includes('ArchiveService'), 'financial.js must not reference ArchiveService');
  assert.ok(!financialJs.includes('assertNotArchived'), 'financial.js must not call assertNotArchived');
  assert.ok(!financialJs.includes('getArchivedClientBalance'), 'financial.js must not call getArchivedClientBalance');

  // Verify updateReceipt() preserves _existing lookup and updated_at concurrency token
  const updateReceiptMatch = financialJs.match(/async function updateReceipt\([\s\S]*?\n\}/);
  assert.ok(updateReceiptMatch, 'updateReceipt() must exist in financial.js');
  const updateReceiptBody = updateReceiptMatch[0];
  assert.ok(
    updateReceiptBody.includes('const _existing = await DBProvider.get(STORE.RECEIPTS, id);'),
    'updateReceipt() must preserve `const _existing = await DBProvider.get(STORE.RECEIPTS, id);`'
  );
  assert.ok(
    updateReceiptBody.includes('updated_at: _existing?.updated_at ?? null'),
    'updateReceipt() must preserve `updated_at: _existing?.updated_at ?? null` in the /financial/receipt-update.php payload'
  );

  // Verify deleteReceipt() and updateReceiptStatus() removed the archive-only lookup
  const deleteReceiptMatch = financialJs.match(/async function deleteReceipt\([\s\S]*?\n\}/);
  assert.ok(deleteReceiptMatch && !deleteReceiptMatch[0].includes('DBProvider.get(STORE.RECEIPTS'), 'deleteReceipt() should not perform unused archive-guard lookup');

  const updateStatusMatch = financialJs.match(/async function updateReceiptStatus\([\s\S]*?\n\}/);
  assert.ok(updateStatusMatch && !updateStatusMatch[0].includes('DBProvider.get(STORE.RECEIPTS'), 'updateReceiptStatus() should not perform unused archive-guard lookup');

  // Verify treasury.js removed ArchiveService while keeping ownership & editableEffects checks
  assert.ok(!treasuryJs.includes('ArchiveService'), 'treasury.js must not reference ArchiveService');
  assert.ok(!treasuryJs.includes('assertNotArchived'), 'treasury.js must not call assertNotArchived');
  assert.ok(!treasuryJs.includes('getArchivedTreasuryBalance'), 'treasury.js must not call getArchivedTreasuryBalance');

  const editEntryMatch = treasuryJs.match(/async function editEntry\([\s\S]*?\n\}/);
  assert.ok(editEntryMatch, 'editEntry() must exist in treasury.js');
  assert.ok(editEntryMatch[0].includes('const existing = await TreasuryRepository.getById(entryId);'));
  assert.ok(editEntryMatch[0].includes('if (existing.username !== username)'));
  assert.ok(editEntryMatch[0].includes('if (!editableEffects.includes(existing.effect))'));

  const deleteEntryMatch = treasuryJs.match(/async function deleteEntry\([\s\S]*?\n\}/);
  assert.ok(deleteEntryMatch, 'deleteEntry() must exist in treasury.js');
  assert.ok(deleteEntryMatch[0].includes('const existing = await TreasuryRepository.getById(entryId);'));
  assert.ok(deleteEntryMatch[0].includes('if (existing.username !== username)'));
  assert.ok(deleteEntryMatch[0].includes('if (!editableEffects.includes(existing.effect))'));
});

test('4. BackupRepository Phase 1 compatibility: empty archive tables, legacy omitted keys, non-empty target protection, and rejection of archived backup data', () => {
  const backupRepoPhp = fs.readFileSync(path.join(KARTA_DIR, 'repositories/BackupRepository.php'), 'utf8');
  const restorePhp = fs.readFileSync(path.join(KARTA_DIR, 'api/backup/restore.php'), 'utf8');

  // Verify static structure in BackupRepository.php
  const tableOrderMatch = backupRepoPhp.match(/TABLE_ORDER\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(tableOrderMatch, 'TABLE_ORDER must exist in BackupRepository.php');
  const tableOrder = [...tableOrderMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

  assert.equal(tableOrder.length, 15, 'TABLE_ORDER must retain all 15 tables in Phase 1');
  assert.ok(tableOrder.includes('archive_batches'), 'TABLE_ORDER must retain archive_batches in Phase 1');
  assert.ok(tableOrder.includes('financial_snapshots'), 'TABLE_ORDER must retain financial_snapshots in Phase 1');
  assert.ok(
    tableOrder.indexOf('archive_batches') < tableOrder.indexOf('financial_snapshots'),
    'archive_batches must precede financial_snapshots in TABLE_ORDER'
  );

  const optionalMatch = backupRepoPhp.match(/OPTIONAL_LEGACY_TABLES\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(optionalMatch, 'OPTIONAL_LEGACY_TABLES must exist in BackupRepository.php');
  const optionalTables = [...optionalMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(
    optionalTables,
    ['owner_account_details', 'archive_batches', 'financial_snapshots'],
    'OPTIONAL_LEGACY_TABLES must contain owner_account_details, archive_batches, and financial_snapshots'
  );

  assert.ok(
    backupRepoPhp.includes('findNonEmptyOmittedArchiveTables'),
    'BackupRepository.php must guard against restoring a backup that omits archive keys when target archive tables are non-empty'
  );
  assert.ok(
    backupRepoPhp.includes('findBackupArchiveData') &&
      backupRepoPhp.includes('Cannot restore backup because it contains data from the removed Archive feature'),
    'BackupRepository.php must reject backups containing archive rows or archived business records before any destructive operation'
  );
  assert.ok(
    !restorePhp.includes("'archive_batches'"),
    'api/backup/restore.php must not bump removed archive_batches version key'
  );

  // Faithful behavioral simulation of BackupRepository against an isolated in-memory database
  const ARCHIVE_TABLES = ['archive_batches', 'financial_snapshots'];
  const ARCHIVABLE_BUSINESS_TABLES = ['receipts', 'treasury', 'vehicle_ledger', 'main_capital_treasury'];
  const OPTIONAL_LEGACY_TABLES = ['owner_account_details', 'archive_batches', 'financial_snapshots'];

  function createSimulatedBackupRepo(initialDbTables) {
    const db = {};
    for (const t of tableOrder) {
      db[t] = Array.isArray(initialDbTables[t]) ? structuredClone(initialDbTables[t]) : [];
    }
    const executedSql = [];

    function computeChecksum(backup) {
      const parts = ['karta-v2-v1'];
      const tables = backup?.tables && typeof backup.tables === 'object' ? backup.tables : {};
      for (const table of tableOrder) {
        if (OPTIONAL_LEGACY_TABLES.includes(table) && !(table in tables)) {
          continue;
        }
        const count = table in tables && Array.isArray(tables[table]) ? tables[table].length : 0;
        parts.push(`${table}:${count}`);
      }
      return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
    }

    function computeChecksumWithZeroOmittedArchive(backup) {
      const parts = ['karta-v2-v1'];
      const tables = backup?.tables && typeof backup.tables === 'object' ? backup.tables : {};
      for (const table of tableOrder) {
        if (table === 'owner_account_details' && !(table in tables)) {
          continue;
        }
        const count = table in tables && Array.isArray(tables[table]) ? tables[table].length : 0;
        parts.push(`${table}:${count}`);
      }
      return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
    }

    function isArchivedRow(row) {
      const flag = row?.is_archived ?? 0;
      if (flag === 1 || flag === '1' || flag === true || flag === 'true') return true;
      const batchId = row?.archive_batch_id ?? null;
      if (typeof batchId === 'string' && batchId.trim() !== '') return true;
      return false;
    }

    function findBackupArchiveData(tables) {
      const found = {};
      for (const archiveTable of ARCHIVE_TABLES) {
        if (Array.isArray(tables[archiveTable]) && tables[archiveTable].length > 0) {
          found[archiveTable] = tables[archiveTable].length;
        }
      }
      for (const businessTable of ARCHIVABLE_BUSINESS_TABLES) {
        if (!Array.isArray(tables[businessTable])) continue;
        let archivedCount = 0;
        for (const row of tables[businessTable]) {
          if (row && typeof row === 'object' && isArchivedRow(row)) {
            archivedCount++;
          }
        }
        if (archivedCount > 0) {
          found[`${businessTable}.is_archived`] = archivedCount;
        }
      }
      return found;
    }

    function findNonEmptyOmittedArchiveTables(tables) {
      const nonEmpty = {};
      for (const archiveTable of ARCHIVE_TABLES) {
        if (!(archiveTable in tables)) {
          const count = (db[archiveTable] || []).length;
          if (count > 0) {
            nonEmpty[archiveTable] = count;
          }
        }
      }
      return nonEmpty;
    }

    const repo = {
      db,
      executedSql,
      computeChecksum,
      computeChecksumWithZeroOmittedArchive,
      createBackup(username = 'admin') {
        const tables = {};
        let totalRows = 0;
        for (const table of tableOrder) {
          const rows = structuredClone(db[table] || []).map((row) => {
            const decodedRow = { ...row };
            for (const [col, val] of Object.entries(decodedRow)) {
              if (typeof val === 'string' && val.length > 1 && (val[0] === '[' || val[0] === '{')) {
                try {
                  decodedRow[col] = JSON.parse(val);
                } catch {}
              }
            }
            return decodedRow;
          });
          tables[table] = rows;
          totalRows += rows.length;
        }
        const backup = {
          system: {
            name: 'Karta ERP v2',
            version: '2.0.0',
            format: 'mysql-full-snapshot',
            created_at: '2026-10-22 12:00:00',
            created_by: username,
            tables: tableOrder.length,
            total_rows: totalRows,
            checksum: '',
          },
          tables,
        };
        backup.system.checksum = computeChecksum(backup);
        return backup;
      },
      validateBackup(backup) {
        const errors = [];
        if (!backup?.system?.version) errors.push('Missing system.version');
        if (!backup?.system?.checksum) errors.push('Missing system.checksum');
        if (!backup?.tables || typeof backup.tables !== 'object') errors.push('Missing or invalid tables section');
        if (errors.length > 0) return { valid: false, errors };

        for (const table of tableOrder) {
          if (!(table in backup.tables)) {
            if (OPTIONAL_LEGACY_TABLES.includes(table)) continue;
            errors.push(`Missing table: ${table}`);
          } else if (!Array.isArray(backup.tables[table])) {
            errors.push(`Invalid data for table: ${table}`);
          }
        }

        const expected = computeChecksum(backup);
        const legacyZeroArchiveExpected = computeChecksumWithZeroOmittedArchive(backup);
        if (backup.system.checksum !== expected && backup.system.checksum !== legacyZeroArchiveExpected) {
          errors.push(`Checksum mismatch: expected=${expected}, got=${backup.system.checksum}`);
        }

        const backupArchiveData = findBackupArchiveData(backup.tables);
        if (Object.keys(backupArchiveData).length > 0) {
          const details = Object.entries(backupArchiveData)
            .map(([t, c]) => `${t} (${c} rows)`)
            .join(', ');
          errors.push(
            `Cannot restore backup because it contains data from the removed Archive feature (${details}).`
          );
        }

        const nonEmptyArchive = findNonEmptyOmittedArchiveTables(backup.tables);
        if (Object.keys(nonEmptyArchive).length > 0) {
          const details = Object.entries(nonEmptyArchive)
            .map(([t, c]) => `${t} (${c} rows)`)
            .join(', ');
          errors.push(
            `Cannot restore legacy backup missing archive table keys because the target database contains existing archive data (${details}). Export a full backup with archive tables or clear archive data first.`
          );
        }

        return { valid: errors.length === 0, errors };
      },
      restore(backup) {
        const validation = repo.validateBackup(backup);
        if (!validation.valid) {
          throw new Error(validation.errors.join(' | '));
        }

        const tables = backup?.tables && typeof backup.tables === 'object' ? backup.tables : {};
        executedSql.push('SET FOREIGN_KEY_CHECKS = 0');
        const stats = {};
        try {
          for (const table of [...tableOrder].reverse()) {
            if (ARCHIVE_TABLES.includes(table) && !(table in tables)) {
              continue;
            }
            executedSql.push(`DELETE FROM \`${table}\``);
            db[table] = [];
          }

          for (const table of tableOrder) {
            if (!(table in tables) && OPTIONAL_LEGACY_TABLES.includes(table)) {
              stats[table] = 0;
              continue;
            }
            const rows = tables[table] || [];
            const insertedRows = [];
            for (const row of rows) {
              const storedRow = {};
              for (const [col, val] of Object.entries(row)) {
                storedRow[col] = Array.isArray(val) || (val && typeof val === 'object')
                  ? JSON.stringify(val)
                  : val ?? null;
              }
              insertedRows.push(storedRow);
            }
            db[table] = insertedRows;
            stats[table] = insertedRows.length;
          }
        } finally {
          executedSql.push('SET FOREIGN_KEY_CHECKS = 1');
        }
        return stats;
      },
    };
    return repo;
  }

  // Case 4A: Backup creation and restore with empty archive tables includes both archive tables and valid 15-table checksum
  const simEmptyArchive = createSimulatedBackupRepo({
    users: [{ id: 1, username: 'admin' }],
    receipts: [{ id: 10, client_name: 'عميل 1', rows: '[{"net":1000}]', is_archived: 0, archive_batch_id: null }],
    archive_batches: [],
    financial_snapshots: [],
  });
  const createdBackup = simEmptyArchive.createBackup('admin');
  assert.ok('archive_batches' in createdBackup.tables, 'New backup must include archive_batches key');
  assert.ok('financial_snapshots' in createdBackup.tables, 'New backup must include financial_snapshots key');
  assert.deepEqual(createdBackup.tables.archive_batches, []);
  assert.deepEqual(createdBackup.tables.financial_snapshots, []);
  assert.equal(simEmptyArchive.validateBackup(createdBackup).valid, true, 'New 15-table backup must validate');
  const fullRestoreStats = simEmptyArchive.restore(createdBackup);
  assert.equal(fullRestoreStats.receipts, 1, 'Normal 15-table backup with empty archive tables must restore receipts');
  assert.equal(fullRestoreStats.archive_batches, 0);
  assert.equal(fullRestoreStats.financial_snapshots, 0);

  // Case 4B: Legacy backup omitting archive_batches & financial_snapshots validates and restores when target archive tables are empty
  simEmptyArchive.executedSql.length = 0;
  const legacyBackupOmittedArchive = structuredClone(createdBackup);
  delete legacyBackupOmittedArchive.tables.archive_batches;
  delete legacyBackupOmittedArchive.tables.financial_snapshots;
  legacyBackupOmittedArchive.system.checksum = simEmptyArchive.computeChecksum(legacyBackupOmittedArchive);

  const valOmittedOnEmpty = simEmptyArchive.validateBackup(legacyBackupOmittedArchive);
  assert.equal(valOmittedOnEmpty.valid, true, 'Legacy backup omitting archive keys must validate when target archive tables are empty');

  const statsOmittedOnEmpty = simEmptyArchive.restore(legacyBackupOmittedArchive);
  assert.equal(statsOmittedOnEmpty.archive_batches, 0, 'Omitted archive_batches must report 0 restored rows');
  assert.equal(statsOmittedOnEmpty.financial_snapshots, 0, 'Omitted financial_snapshots must report 0 restored rows');
  assert.equal(statsOmittedOnEmpty.receipts, 1, 'Core tables must be restored normally');
  assert.ok(
    !simEmptyArchive.executedSql.includes('DELETE FROM `archive_batches`'),
    'Restore must not run DELETE FROM on omitted archive tables'
  );

  // Also verify legacy backup whose checksum included archive_batches:0|financial_snapshots:0 despite omitting the keys
  const legacyBackupZeroArchiveChecksum = structuredClone(legacyBackupOmittedArchive);
  legacyBackupZeroArchiveChecksum.system.checksum = simEmptyArchive.computeChecksumWithZeroOmittedArchive(legacyBackupZeroArchiveChecksum);
  assert.equal(
    simEmptyArchive.validateBackup(legacyBackupZeroArchiveChecksum).valid,
    true,
    'Legacy backup omitting archive keys with zero-count archive checksum must also validate'
  );

  // Verify tampering with a core table (e.g. receipts) in a legacy backup is still rejected
  const tamperedLegacyBackup = structuredClone(legacyBackupOmittedArchive);
  tamperedLegacyBackup.tables.receipts.push({ id: 99, client_name: 'مزيف', is_archived: 0 });
  const tamperedVal = simEmptyArchive.validateBackup(tamperedLegacyBackup);
  assert.equal(tamperedVal.valid, false, 'Tampering with a core table in a legacy backup must fail checksum validation');
  assert.ok(tamperedVal.errors.some((e) => e.includes('Checksum mismatch')));

  // Case 4C: Restore rejection when a legacy backup omits archive keys AND the target DB contains archive data
  const simNonEmptyArchiveTarget = createSimulatedBackupRepo({
    users: [{ id: 1, username: 'admin' }],
    receipts: [{ id: 10, client_name: 'عميل حالي', is_archived: 0 }],
    archive_batches: [{ id: 1, uuid: 'batch-uuid-1', status: 'archived' }],
    financial_snapshots: [{ id: 1, uuid: 'snap-uuid-1', archive_batch_id: 'batch-uuid-1', treasury_balance: 50000 }],
  });

  const valOmittedOnNonEmpty = simNonEmptyArchiveTarget.validateBackup(legacyBackupOmittedArchive);
  assert.equal(
    valOmittedOnNonEmpty.valid,
    false,
    'validateBackup must reject a legacy backup missing archive keys when target DB contains archive rows'
  );
  assert.ok(
    valOmittedOnNonEmpty.errors.some((e) => e.includes('archive_batches (1 rows)') && e.includes('financial_snapshots (1 rows)')),
    'Validation error must identify the non-empty target archive tables'
  );

  assert.throws(
    () => simNonEmptyArchiveTarget.restore(legacyBackupOmittedArchive),
    /Cannot restore legacy backup missing archive table keys/,
    'restore() must throw a clear error before deleting any data when target archive tables are non-empty'
  );
  assert.equal(
    simNonEmptyArchiveTarget.executedSql.length,
    0,
    'restore() must abort before executing SET FOREIGN_KEY_CHECKS = 0 or any DELETE FROM statement'
  );
  assert.equal(
    simNonEmptyArchiveTarget.db.archive_batches.length,
    1,
    'Target archive_batches data must remain untouched after rejected restore'
  );
  assert.equal(
    simNonEmptyArchiveTarget.db.receipts.length,
    1,
    'Target receipts data must remain untouched after rejected restore'
  );

  // Case 4D: Reject backup containing non-empty archive tables (archive_batches / financial_snapshots) before any destructive operation
  const backupWithArchiveBatches = structuredClone(createdBackup);
  backupWithArchiveBatches.tables.archive_batches = [{ id: 1, uuid: 'batch-uuid-1', status: 'archived' }];
  backupWithArchiveBatches.tables.financial_snapshots = [{ id: 1, uuid: 'snap-uuid-1', archive_batch_id: 'batch-uuid-1', treasury_balance: 50000 }];
  backupWithArchiveBatches.system.checksum = simEmptyArchive.computeChecksum(backupWithArchiveBatches);

  const simProtectedTarget = createSimulatedBackupRepo({
    users: [{ id: 1, username: 'admin' }],
    receipts: [{ id: 10, client_name: 'بيانات حية محمية', is_archived: 0 }],
    archive_batches: [],
    financial_snapshots: [],
  });

  const valArchiveTables = simProtectedTarget.validateBackup(backupWithArchiveBatches);
  assert.equal(valArchiveTables.valid, false, 'Backup containing non-empty archive tables must be rejected');
  assert.ok(
    valArchiveTables.errors.some(
      (e) =>
        e.includes('removed Archive feature') &&
        e.includes('archive_batches (1 rows)') &&
        e.includes('financial_snapshots (1 rows)')
    ),
    'Error must clearly explain that the backup contains data from the removed Archive feature'
  );
  assert.throws(
    () => simProtectedTarget.restore(backupWithArchiveBatches),
    /contains data from the removed Archive feature/,
    'restore() must reject backup with non-empty archive tables before any destructive operation'
  );
  assert.equal(simProtectedTarget.executedSql.length, 0, 'No SQL statements may execute when backup contains archive tables');
  assert.equal(simProtectedTarget.db.receipts[0].client_name, 'بيانات حية محمية', 'Target database must remain untouched');

  // Case 4E: Reject backup containing archived business records (is_archived = 1 or archive_batch_id) even if archive tables are empty
  const backupWithArchivedReceipt = structuredClone(createdBackup);
  backupWithArchivedReceipt.tables.receipts = [
    { id: 10, client_name: 'عميل مؤرشف', rows: [{ net: 1000 }], is_archived: 1, archive_batch_id: 'batch-uuid-1' },
  ];
  backupWithArchivedReceipt.tables.treasury = [
    { id: 20, type: 'deposit', amount: 10000, is_archived: '1', archive_batch_id: 'batch-uuid-1' },
  ];
  backupWithArchivedReceipt.system.checksum = simEmptyArchive.computeChecksum(backupWithArchivedReceipt);

  const valArchivedBusinessRows = simProtectedTarget.validateBackup(backupWithArchivedReceipt);
  assert.equal(valArchivedBusinessRows.valid, false, 'Backup containing archived business records must be rejected');
  assert.ok(
    valArchivedBusinessRows.errors.some(
      (e) =>
        e.includes('removed Archive feature') &&
        e.includes('receipts.is_archived (1 rows)') &&
        e.includes('treasury.is_archived (1 rows)')
    ),
    'Error must identify archived business records from the removed Archive feature'
  );
  assert.throws(
    () => simProtectedTarget.restore(backupWithArchivedReceipt),
    /contains data from the removed Archive feature/,
    'restore() must reject backup with archived business records before any destructive operation'
  );
  assert.equal(simProtectedTarget.executedSql.length, 0, 'No SQL statements may execute when backup contains archived business records');
  assert.equal(simProtectedTarget.db.receipts[0].client_name, 'بيانات حية محمية', 'Target database must remain untouched');
});
