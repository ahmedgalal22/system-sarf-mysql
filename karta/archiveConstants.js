/**
 * archiveConstants.js — Archive system domain constants.
 */

export const ARCHIVE_STATUS = Object.freeze({
  ARCHIVED : 'archived',
  RESTORED : 'restored',
});

// Backward compatibility — 'active' maps to 'archived'
export const ARCHIVE_STATUS_ACTIVE_LEGACY = 'active';

// Stores that contain transactional records eligible for archiving.
export const ARCHIVABLE_STORES = Object.freeze([
  'treasury',
  'vehicle_ledger',
  'receipts',
  'bolsaForms',
  'mainCapitalTreasury',
]);

// Business date field per store.
export const ARCHIVE_DATE_FIELD = Object.freeze({
  treasury:              'date',
  vehicle_ledger:        'date',
  receipts:              'receipt_date',
  bolsaForms:            'bolsa_date',
  mainCapitalTreasury:   'date',
});

export const ARCHIVE_BATCH_STORE = 'archive_batches';
export const FINANCIAL_SNAPSHOT_STORE = 'financial_snapshots';
