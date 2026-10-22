/**
 * domainRegistry.js — System-wide Data Ownership Registry
 * ─────────────────────────────────────────────────────────────────────────────
 * Single source of truth: WHO owns WHAT data and HOW it's transported.
 *
 * Every IndexedDB store / MySQL table MUST be registered here.
 * DBProvider queries this registry BEFORE routing any operation.
 *
 * RULES:
 *   - No domain without explicit owner
 *   - No transport without authority
 *   - Financial domains are LOCKED until explicit migration gate
 *   - Archive is IMMUTABLE — never migrated at runtime
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const DOMAIN_OWNER = Object.freeze({
  CLIENT: 'CLIENT',
  SERVER: 'SERVER',
});

export const DOMAIN_TRANSPORT = Object.freeze({
  INDEXEDDB: 'INDEXEDDB',
  MYSQL:     'MYSQL',
});

export const DOMAIN_STATUS = Object.freeze({
  ACTIVE:            'ACTIVE',
  LOCKED:            'LOCKED',
  PENDING_MIGRATION: 'PENDING_MIGRATION',
  IMMUTABLE:         'IMMUTABLE',
  SERVER_OWNED:      'SERVER_OWNED',
  CLIENT_OWNED:      'CLIENT_OWNED',
});

export const DOMAIN_CRITICALITY = Object.freeze({
  NORMAL:             'NORMAL',
  FINANCIAL_CRITICAL: 'FINANCIAL_CRITICAL',
  SYSTEM_CRITICAL:    'SYSTEM_CRITICAL',
});

/**
 * The registry — every store/table mapped to its owner, transport, and rules.
 * This is the ONLY place ownership is defined.
 */
const DOMAIN_REGISTRY = Object.freeze({

  // ── SERVER-OWNED (migrated to MySQL) ────────────────────────────────────
  vehicles: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.NORMAL,
    apiPath:     '/entities/vehicles',
  },

  // ── SERVER-OWNED: Financial Core (Phase 6 — migrated to MySQL) ──────────
  treasury: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.FINANCIAL_CRITICAL,
    apiPath:     '/entities/treasury',
  },
  vehicle_ledger: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.FINANCIAL_CRITICAL,
    apiPath:     '/entities/vehicle-ledger',
  },
  receipts: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.FINANCIAL_CRITICAL,
    apiPath:     '/entities/receipts',
  },
  bolsaForms: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.FINANCIAL_CRITICAL,
    apiPath:     '/entities/bolsa-forms',
  },
  mainCapitalTreasury: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.FINANCIAL_CRITICAL,
    apiPath:     '/entities/capital',
  },

  // ── CLIENT-OWNED: Archive (IMMUTABLE) ───────────────────────────────────
  // ── SERVER-OWNED: Archive (Phase 7 — migrated to MySQL) ──────────────────
  archive_batches: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.FINANCIAL_CRITICAL,
    apiPath:     '/archive',
  },
  financial_snapshots: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.FINANCIAL_CRITICAL,
    apiPath:     '/archive',
  },

  // ── SERVER-OWNED: Entities (Phase 5 — migrated to MySQL) ─────────────────
  vehicleOwners: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.NORMAL,
    apiPath:     '/entities/vehicleOwners',
  },
  agents: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.NORMAL,
    apiPath:     '/entities/agents',
  },
  offices: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.NORMAL,
    apiPath:     '/entities/offices',
  },

  hamolaDetails: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.NORMAL,
    apiPath:     '/entities/hamola',
  },

  drivers: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.NORMAL,
    apiPath:     '/entities/drivers',
  },
  notes: {
    owner:       DOMAIN_OWNER.SERVER,
    transport:   DOMAIN_TRANSPORT.MYSQL,
    status:      DOMAIN_STATUS.SERVER_OWNED,
    criticality: DOMAIN_CRITICALITY.NORMAL,
    apiPath:     '/entities/notes',
  },
  // bolsa IDB store removed — Phase 9A (dead code, zero operations)
});

/**
 * Get the domain definition for a store name.
 * Returns null for unknown domains — callers must handle this.
 */
export function getDomain(storeName) {
  return DOMAIN_REGISTRY[storeName] || null;
}

/**
 * Get all domain names.
 */
export function getAllDomainNames() {
  return Object.keys(DOMAIN_REGISTRY);
}

export default DOMAIN_REGISTRY;
