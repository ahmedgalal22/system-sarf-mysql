/**
 * archiveRepository.js — Archive data access (Phase 7 — MySQL-routed)
 *
 * All reads go through ApiClient → PHP → MySQL.
 * archive_batches and financial_snapshots are now SERVER_OWNED.
 */
import { ApiClient } from './apiClient.js';
import { dbBool } from '../dbTypes.js';

export const ArchiveRepository = {
  // ── Batches ──────────────────────────────────────────────────────────────
  async getAllBatches() {
    const res = await ApiClient.get('/archive/list.php');
    return (res.success && res.data) ? res.data : [];
  },

  async getBatchById(id) {
    const res = await ApiClient.get(`/archive/get.php?id=${encodeURIComponent(id)}`);
    return (res.success && res.data) ? res.data : null;
  },

  // ── Snapshots ────────────────────────────────────────────────────────────
  async getSnapshotByBatchId(batchId) {
    const batch = await this.getBatchById(batchId);
    return batch?.snapshot || null;
  },

  // ── Archived record queries (uses entity list endpoints with includeArchived) ──
  async getArchivedRecords(storeName, batchId) {
    const storeApiMap = {
      'receipts': '/entities/receipts/list.php?include_archived=1',
      'treasury': '/entities/treasury/list.php?include_archived=1',
      'vehicle_ledger': '/entities/vehicle-ledger/list.php?include_archived=1',
      'bolsaForms': '/entities/bolsa-forms/list.php?include_archived=1',
      'mainCapitalTreasury': '/entities/capital/list.php?include_archived=1',
    };
    const path = storeApiMap[storeName];
    if (!path) return [];
    const res = await ApiClient.get(path);
    const all = (res.success && res.data) ? res.data : [];
    return all.filter(r => dbBool(r.is_archived) && r.archive_batch_id === batchId);
  },
};
