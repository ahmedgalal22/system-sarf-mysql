/**
 * dbProvider.js — Domain-Aware DB Provider
 * ─────────────────────────────────────────────────────────────────────────────
 * Routes ALL data operations through the Domain Registry.
 *
 * Flow: Frontend → DBProvider → domainResolver → transport (IDB or API)
 *
 * RULES:
 *   - DBProvider does NOT decide storage — domainResolver does
 *   - SERVER writes fail explicitly — NEVER fall back to IndexedDB
 *   - SERVER reads fall back to IndexedDB on network failure
 *   - Unknown domains default to IndexedDB (backward compatible)
 *   - IMMUTABLE domains block writes
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { resolveDomain } from './domainResolver.js';
import { ApiClient } from './apiClient.js';
import { logAccessViolation } from './domainTransitionLogger.js';

// ── Transport helpers ─────────────────────────────────────────────────────────

/**
 * Execute a SERVER read — fails explicitly on error, no silent fallback.
 */
async function _apiRead(store, apiFn) {
  return apiFn();
}

/**
 * Execute a SERVER write — NO fallback. Fails explicitly.
 */
async function _apiWriteStrict(store, apiFn) {
  try {
    return await apiFn();
  } catch (err) {
    // Re-throw with context — never silent
    if (err.status === 409) throw err; // Preserve conflict errors
    throw new Error(`[${store}] فشل الحفظ في الخادم: ${err.message}`);
  }
}

// ── CRUD operations ───────────────────────────────────────────────────────────

async function getAll(store, filters = null) {
  const r = resolveDomain(store, 'read');
  if (r.transport === 'API' && r.apiPath) {
    return _apiRead(store,
      async () => {
        const params = filters ? '?' + new URLSearchParams(
          Object.entries(filters).filter(([k]) => k !== 'includeArchived')
        ).toString() : '';
        const res = await ApiClient.get(`${r.apiPath}/list.php${params}`);
        if (!res.success) throw new Error(res.message);
        return res.data || [];
      }
    );
  }
  throw new Error('[DBProvider] No IDB store: ' + store);
}

async function get(store, id) {
  const r = resolveDomain(store, 'read');
  if (r.transport === 'API' && r.apiPath) {
    return _apiRead(store,
      async () => {
        const res = await ApiClient.get(`${r.apiPath}/get.php?id=${encodeURIComponent(id)}`);
        if (!res.success) throw new Error(res.message);
        return res.data;
      }
    );
  }
  throw new Error('[DBProvider] No IDB store: ' + store);
}

async function save(store, payload, meta) {
  const r = resolveDomain(store, 'write');
  if (!r.allowed) {
    logAccessViolation(store, 'save', r.transport, 'BLOCKED');
    throw new Error(r.reason || `Write blocked for domain "${store}"`);
  }
  if (r.transport === 'API' && r.apiPath) {
    return _apiWriteStrict(store, async () => {
      const res = await ApiClient.post(`${r.apiPath}/create.php`, payload);
      if (!res.success) throw new Error(res.message);
      return res.data;
    });
  }
  throw new Error('[DBProvider] No IDB store: ' + store);
}

async function update(store, id, patch, meta) {
  const r = resolveDomain(store, 'write');
  if (!r.allowed) {
    logAccessViolation(store, 'update', r.transport, 'BLOCKED');
    throw new Error(r.reason || `Write blocked for domain "${store}"`);
  }
  if (r.transport === 'API' && r.apiPath) {
    return _apiWriteStrict(store, async () => {
      const res = await ApiClient.put(`${r.apiPath}/update.php`, { id, ...patch });
      if (!res.success) {
        if (res.status === 409) {
          const err = new Error(res.message);
          err.status = 409;
          err.latest = res.latest || res.data || null;
          throw err;
        }
        throw new Error(res.message);
      }
      return res.data;
    });
  }
  throw new Error('[DBProvider] No IDB store: ' + store);
}

async function del(store, id, meta) {
  const r = resolveDomain(store, 'delete');
  if (!r.allowed) {
    logAccessViolation(store, 'delete', r.transport, 'BLOCKED');
    throw new Error(r.reason || `Delete blocked for domain "${store}"`);
  }
  if (r.transport === 'API' && r.apiPath) {
    return _apiWriteStrict(store, async () => {
      const res = await ApiClient.delete(`${r.apiPath}/delete.php`, { id });
      if (!res.success) throw new Error(res.message);
      return res.data;
    });
  }
  throw new Error('[DBProvider] No IDB store: ' + store);
}

async function hardDelete(store, id) {
  const r = resolveDomain(store, 'delete');
  if (!r.allowed) throw new Error(r.reason || `Delete blocked for "${store}"`);
  if (r.transport === 'API') return del(store, id);
  throw new Error('[DBProvider] No IDB store: ' + store);
}

async function transaction(opsOrCallback, meta) {
  // ── SERVER_OWNED guard (Phase 6 hardening) ──────────────────────────────
  // If any WRITE operation in the batch targets a SERVER_OWNED store, throw
  // immediately.  Financial writes MUST go through ApiClient → PHP → MySQL.
  // DBProvider.transaction() is IndexedDB-only and must never silently write
  // SERVER data to IDB.
  //
  // Array-style: each op has { op, store } — we check write ops only.
  // Callback-style: the callback may READ server stores inside a
  //   multi-store IDB transaction (e.g. receipts.js reads 'receipts' +
  //   writes 'counters'). We cannot pre-detect writes in a callback, so
  //   we trust the callback author and skip the check. Array-style ops are
  //   the primary vector for accidental server writes (archiveService, etc).
  if (Array.isArray(opsOrCallback)) {
    for (const op of opsOrCallback) {
      if (!op || !op.store) continue;
      const r = resolveDomain(op.store, 'write');
      if (r.transport === 'API') {
        const msg = `[DBProvider.transaction] SERVER_OWNED store "${op.store}" cannot use IndexedDB transaction. Use ApiClient → PHP atomic endpoint instead.`;
        logAccessViolation(op.store, 'transaction', r.transport, 'BLOCKED');
        throw new Error(msg);
      }
    }
  }
  // Safe: proceed to IndexedDB
  throw new Error('[DBProvider] No IDB transaction support');
}

async function findByFields(store, filters, options = {}) {
  const r = resolveDomain(store, 'read');
  if (r.transport === 'API' && r.apiPath) {
    return _apiRead(store,
      async () => {
        const params = new URLSearchParams(filters).toString();
        const res = await ApiClient.get(`${r.apiPath}/list.php?${params}`);
        if (!res.success) throw new Error(res.message);
        return res.data || [];
      }
    );
  }
  throw new Error('[DBProvider] No IDB store: ' + store);
}

async function getByIndex(store, indexName, value, options = {}) {
  const r = resolveDomain(store, 'read');
  if (r.transport === 'API' && r.apiPath) {
    return _apiRead(store,
      async () => {
        const res = await ApiClient.get(`${r.apiPath}/list.php?${indexName}=${encodeURIComponent(value)}`);
        if (!res.success) throw new Error(res.message);
        return res.data || [];
      }
    );
  }
  throw new Error('[DBProvider] No IDB store: ' + store);
}

// ── Export ─────────────────────────────────────────────────────────────────────

export const DBProvider = {
  getAll,
  get,
  save,
  update,
  delete: del,
  hardDelete,
  transaction,
  findByFields,
  getByIndex,
};
