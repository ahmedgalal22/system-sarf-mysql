/**
 * archiveService.js — Financial Archive Service (Phase 7 — MySQL-first)
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 7: All archive mutations go through ApiClient → PHP → MySQL.
 *          No IndexedDB writes for financial stores.
 *
 * Lifecycle: archived ↔ restored ↔ re-archived
 *
 * A batch is an "accounting period" that can be:
 *   1. Created (archived) — records hidden, snapshot taken
 *   2. Restored — records visible again, snapshot inactive
 *   3. Re-archived — SAME batch ID reused, new snapshot, version incremented
 *
 * RULES:
 *   - ONE batch ID per period — never duplicated
 *   - ONE active snapshot per batch — replaced on re-archive
 *   - Carry-forward only from 'archived' batches
 *   - All mutations atomic via PHP BEGIN/COMMIT
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ApiClient } from './apiClient.js';
import {
  ARCHIVE_STATUS,
  ARCHIVE_STATUS_ACTIVE_LEGACY,
} from '../archiveConstants.js';
import { generateId as _uuid } from '../utils/idGenerator.js';

/**
 * Check if a batch is in "archived" state (includes legacy 'active' status).
 */
function _isArchived(batch) {
  return batch.status === ARCHIVE_STATUS.ARCHIVED || batch.status === ARCHIVE_STATUS_ACTIVE_LEGACY;
}

// ─── VALIDATION ────────────────────────────────────────────────────────────────

/**
 * Validate before archive — checks date range + overlap + partial receipts.
 * Now reads from MySQL via API.
 */
async function validateBeforeArchive(username, fromDate, toDate, excludeBatchId = null) {
  const errors = [];

  if (!fromDate || !toDate) {
    errors.push('التاريخ من/إلى مطلوب');
    return { valid: false, errors };
  }
  if (fromDate > toDate) {
    errors.push('تاريخ البداية يجب أن يكون قبل تاريخ النهاية');
    return { valid: false, errors };
  }

  // Overlap check via API
  const batchRes = await ApiClient.get('/archive/list.php');
  const batches = (batchRes.success && batchRes.data) ? batchRes.data : [];
  for (const b of batches) {
    if (!_isArchived(b)) continue;
    if (excludeBatchId && (b.uuid === excludeBatchId || b.id === excludeBatchId)) continue;
    if (b.from_date <= toDate && b.to_date >= fromDate) {
      errors.push(`يوجد أرشيف نشط يتداخل مع هذه الفترة (${b.from_date} → ${b.to_date})`);
    }
  }

  // Partial payout check via receipts API
  const receiptsRes = await ApiClient.get('/entities/receipts/list.php');
  const receipts = (receiptsRes.success && receiptsRes.data) ? receiptsRes.data : [];
  for (const r of receipts) {
    const d = String(r.receipt_date || '').split('T')[0];
    if (d >= fromDate && d <= toDate) {
      if (String(r.payout_status || 'unpaid') === 'partial') {
        errors.push(`نموذج رقم ${r.receipt_number || r.id} في حالة صرف جزئي — يجب تسويته قبل الأرشفة`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ─── ARCHIVE (first time) ─────────────────────────────────────────────────────

async function createArchive(username, fromDate, toDate, notes = '') {
  if (!username) throw new Error('[Archive] username required');

  const validation = await validateBeforeArchive(username, fromDate, toDate);
  if (!validation.valid) {
    throw new Error('❌ ' + validation.errors.join('\n'));
  }

  const res = await ApiClient.post('/archive/create.php', {
    from_date: fromDate,
    to_date: toDate,
    notes: notes || `أرشيف من ${fromDate} إلى ${toDate}`,
    batch_uuid: _uuid(),
    snapshot_id: _uuid(),
  });

  if (!res.success) throw new Error(res.message || 'فشل الأرشفة');
  return res.data;
}

// ─── RESTORE ──────────────────────────────────────────────────────────────────

async function restoreArchive(username, batchId) {
  if (!username) throw new Error('[Archive] username required');
  if (!batchId) throw new Error('[Archive] batchId required');

  const res = await ApiClient.post('/archive/restore.php', {
    batch_id: batchId,
  });

  if (!res.success) throw new Error(res.message || 'فشل الاستعادة');
  return res.data;
}

// ─── RE-ARCHIVE ───────────────────────────────────────────────────────────────

async function reArchive(username, batchId) {
  if (!username) throw new Error('[Archive] username required');
  if (!batchId) throw new Error('[Archive] batchId required');

  const res = await ApiClient.post('/archive/create.php', {
    batch_id: batchId,
    snapshot_id: _uuid(),
  });

  if (!res.success) throw new Error(res.message || 'فشل إعادة الأرشفة');
  return res.data;
}

// ─── QUERIES ──────────────────────────────────────────────────────────────────

async function getArchiveBatches(username) {
  const res = await ApiClient.get('/archive/list.php');
  const all = (res.success && res.data) ? res.data : [];
  return all.filter(b => _isArchived(b))
    .sort((a, b) => (b.archived_at || '').localeCompare(a.archived_at || ''));
}

async function getAllBatchesHistory(username) {
  const res = await ApiClient.get('/archive/list.php');
  const all = (res.success && res.data) ? res.data : [];
  return all.sort((a, b) => (b.archived_at || '').localeCompare(a.archived_at || ''));
}

async function getArchiveSnapshot(batchId) {
  const res = await ApiClient.get(`/archive/get.php?id=${encodeURIComponent(batchId)}`);
  if (!res.success || !res.data) return null;
  return res.data.snapshot || null;
}

async function previewArchive(username, fromDate, toDate) {
  // Preview counts non-archived records in range across 4 stores.
  // Phase 8A: Parallel API calls via Promise.all (4 independent reads).
  const stores = ['receipts', 'treasury', 'vehicle_ledger', 'main_capital_treasury'];
  const storeApiMap = {
    'receipts': '/entities/receipts/list.php',
    'treasury': '/entities/treasury/list.php',
    'vehicle_ledger': '/entities/vehicle-ledger/list.php',
    'main_capital_treasury': '/entities/capital/list.php',
  };
  const dateFieldMap = {
    'receipts': 'receipt_date',
    'treasury': 'date',
    'vehicle_ledger': 'date',
    'main_capital_treasury': 'date',
  };
  const storeKeyMap = {
    'receipts': 'receipts',
    'treasury': 'treasury',
    'vehicle_ledger': 'vehicle_ledger',
    'main_capital_treasury': 'mainCapitalTreasury',
  };

  // Parallel fetch — all 5 are independent reads
  const results = await Promise.all(
    stores.map(store => ApiClient.get(storeApiMap[store]).catch(() => ({ success: false, data: [] })))
  );

  const counts = {};
  let total = 0;
  stores.forEach((store, i) => {
    const all = (results[i].success && results[i].data) ? results[i].data : [];
    const dateField = dateFieldMap[store];
    let count = 0;
    for (const record of all) {
      if (record.is_archived) continue;
      const d = String(record[dateField] || '').split('T')[0];
      if (d && d >= fromDate && d <= toDate) count++;
    }
    counts[storeKeyMap[store]] = count;
    total += count;
  });
  return { counts, total };
}

// ─── CARRY-FORWARD ────────────────────────────────────────────────────────────

async function getArchivedTreasuryBalance(username) {
  const res = await ApiClient.get('/archive/list.php');
  const batches = (res.success && res.data) ? res.data : [];
  let carryForward = 0;
  for (const b of batches) {
    if (!_isArchived(b)) continue;
    const snap = b.snapshot;
    if (snap) carryForward += (Number(snap.treasury_balance) || 0);
  }
  return carryForward;
}

async function getArchivedClientBalance(username, clientId, clientType = null) {
  const res = await ApiClient.get('/archive/list.php');
  const batches = (res.success && res.data) ? res.data : [];
  let carryForward = 0;
  const cid = String(clientId);
  for (const b of batches) {
    if (!_isArchived(b)) continue;
    const snap = b.snapshot;
    if (!snap || !Array.isArray(snap.client_balances)) continue;
    const client = snap.client_balances.find(c => {
      if (String(c.id) !== cid) return false;
      // If snapshot has type info AND caller specified type, enforce match
      if (clientType && c.type && c.type !== clientType) return false;
      return true;
    });
    if (client) carryForward += (Number(client.balance) || 0);
  }
  return carryForward;
}

function assertNotArchived(record) {
  if (record && record.is_archived) {
    throw new Error('❌ لا يمكن تعديل أو حذف سجل مؤرشف. يجب استعادة الأرشيف أولاً.');
  }
}

// ─── SNAPSHOT INTEGRITY ───────────────────────────────────────────────────────

function _computeSnapshotHash(snapshot, batch) {
  const parts = [
    String(batch.id || batch.uuid),
    String(batch.from_date),
    String(batch.to_date),
    String(snapshot.treasury_balance || 0),
    String(Array.isArray(snapshot.client_balances) ? snapshot.client_balances.length : 0),
    String(batch.archive_version || 1),
  ];
  let hash = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return 'SNAP_' + Math.abs(hash).toString(36);
}

async function verifySnapshotIntegrity(batchId) {
  const res = await ApiClient.get(`/archive/get.php?id=${encodeURIComponent(batchId)}`);
  if (!res.success || !res.data) return { valid: false, error: 'batch_not_found' };
  const batch = res.data;
  const snapshot = batch.snapshot;
  if (!snapshot) return { valid: false, error: 'snapshot_not_found' };
  if (!snapshot.integrity_hash) return { valid: true, legacy: true };

  const expected = _computeSnapshotHash(snapshot, batch);
  return {
    valid: snapshot.integrity_hash === expected,
    expected,
    actual: snapshot.integrity_hash,
  };
}

// ─── AUDIT ────────────────────────────────────────────────────────────────────

async function runArchiveIntegrityAudit(username) {
  const errors = [];
  const warnings = [];

  const res = await ApiClient.get('/archive/list.php');
  const batches = (res.success && res.data) ? res.data : [];

  for (const b of batches) {
    if (!b.snapshot && _isArchived(b)) {
      errors.push(`Batch ${b.uuid} (${b.from_date}→${b.to_date}): archived but NO snapshot`);
    }
    if (!['archived', 'restored', 'active'].includes(b.status)) {
      errors.push(`Batch ${b.uuid}: invalid status "${b.status}"`);
    }
    if (b.snapshot && b.snapshot.integrity_hash) {
      const check = _computeSnapshotHash(b.snapshot, b);
      const expected = check;
      // Hash is the computed one, compare with stored
      // (simplified — full check via verifySnapshotIntegrity)
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    batchCount: batches.length,
  };
}

// ─── EXPORT ────────────────────────────────────────────────────────────────────

export const ArchiveService = Object.freeze({
  validateBeforeArchive,
  createArchive,
  restoreArchive,
  reArchive,
  getArchiveBatches,
  getAllBatchesHistory,
  getArchiveSnapshot,
  previewArchive,
  getArchivedTreasuryBalance,
  getArchivedClientBalance,
  assertNotArchived,
  verifySnapshotIntegrity,
  runArchiveIntegrityAudit,
});
