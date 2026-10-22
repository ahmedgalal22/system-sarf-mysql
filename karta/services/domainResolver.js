/**
 * domainResolver.js — Domain Resolution Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Given a domain name and operation type, returns:
 *   - which transport to use (IndexedDB or API)
 *   - whether the operation is allowed
 *   - the API path (if server-routed)
 *
 * This is the SINGLE decision point. DBProvider calls this before every op.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getDomain, DOMAIN_OWNER, DOMAIN_STATUS } from './domainRegistry.js';
import { isServerMode } from './apiConfig.js';

/**
 * @typedef {Object} DomainResolution
 * @property {'INDEXEDDB'|'API'} transport — where to route the operation
 * @property {boolean} allowed — whether the operation is permitted
 * @property {string|null} apiPath — API base path (if transport is API)
 * @property {string|null} reason — why blocked (if not allowed)
 * @property {string} owner — CLIENT or SERVER
 */

/**
 * Resolve how a specific operation should be handled for a domain.
 *
 * @param {string} storeName — the store/table name
 * @param {'read'|'write'|'delete'} operation — what we're trying to do
 * @returns {DomainResolution}
 */
export function resolveDomain(storeName, operation = 'read') {
  const domain = getDomain(storeName);

  // Unknown domain — default to local IndexedDB (backward compatible)
  if (!domain) {
    return {
      transport: 'INDEXEDDB',
      allowed: true,
      apiPath: null,
      reason: null,
      owner: 'CLIENT',
    };
  }

  const isWrite = operation === 'write' || operation === 'delete';

  // ── IMMUTABLE domains: block all writes, allow reads locally ──
  if (domain.status === DOMAIN_STATUS.IMMUTABLE && isWrite) {
    return {
      transport: 'INDEXEDDB',
      allowed: false,
      apiPath: null,
      reason: `Domain "${storeName}" is IMMUTABLE — writes are blocked`,
      owner: domain.owner,
    };
  }

  // ── SERVER-OWNED: route to API when in SERVER mode ──
  if (domain.owner === DOMAIN_OWNER.SERVER && isServerMode()) {
    return {
      transport: 'API',
      allowed: true,
      apiPath: domain.apiPath,
      reason: null,
      owner: 'SERVER',
    };
  }

  // ── CLIENT-OWNED or SERVER mode not active: use IndexedDB ──
  return {
    transport: 'INDEXEDDB',
    allowed: true,
    apiPath: null,
    reason: null,
    owner: domain.owner,
  };
}

/**
 * Quick check: is this domain server-managed right now?
 */
export function isServerDomain(storeName) {
  const r = resolveDomain(storeName, 'read');
  return r.transport === 'API';
}

/**
 * Quick check: can we write to this domain?
 */
export function canWriteDomain(storeName) {
  const r = resolveDomain(storeName, 'write');
  return r.allowed;
}
