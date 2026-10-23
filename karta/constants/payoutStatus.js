/**
 * payoutStatus.js — Enterprise-grade Payout State Machine
 * Single Source of Truth for Payout States, Transitions, and Metadata
 */

import { DateUtils } from '../dateUtils.js';

export const RECEIPT_PAYOUT_STATUS = Object.freeze({
  PAID: 'paid',
  UNPAID: 'unpaid',
  PARTIAL: 'partial',
  CANCELLED: 'cancelled'
});

const VALID_STATUSES = new Set(Object.values(RECEIPT_PAYOUT_STATUS));

// Static Frozen Metadata Registry (Pre-calculated & cached to avoid allocations)
const STATUS_META_REGISTRY = Object.freeze({
  [RECEIPT_PAYOUT_STATUS.PAID]: Object.freeze({
    id: RECEIPT_PAYOUT_STATUS.PAID,
    label: 'تم صرفه',
    printLabel: '✅ تم صرفه',
    color: '#059669',
    badgeClass: 'badge-green',
    icon: '✅'
  }),
  [RECEIPT_PAYOUT_STATUS.PARTIAL]: Object.freeze({
    id: RECEIPT_PAYOUT_STATUS.PARTIAL,
    label: 'صرف جزئي',
    printLabel: '⚠️ صرف جزئي',
    color: '#fb923c',
    badgeClass: 'badge-orange',
    icon: '⚠️'
  }),
  [RECEIPT_PAYOUT_STATUS.CANCELLED]: Object.freeze({
    id: RECEIPT_PAYOUT_STATUS.CANCELLED,
    label: 'ملغي',
    printLabel: '🚫 ملغي',
    color: '#9ca3af',
    badgeClass: 'badge-gray',
    icon: '🚫'
  }),
  [RECEIPT_PAYOUT_STATUS.UNPAID]: Object.freeze({
    id: RECEIPT_PAYOUT_STATUS.UNPAID,
    label: 'لم يتم الصرف',
    printLabel: '⏳ لم يتم الصرف',
    color: '#dc2626',
    badgeClass: 'badge-red',
    icon: '⏳'
  })
});

/**
 * Asserts whether a given status is valid. Throws error on failure.
 * @param {string} status 
 * @throws {Error}
 */
export function assertValidPayoutStatus(status) {
  if (typeof status !== 'string') {
    throw new Error(`[PayoutState] Invalid status type: expected string, got ${typeof status}`);
  }
  const clean = status.trim().toLowerCase();
  if (!VALID_STATUSES.has(clean)) {
    throw new Error(`[PayoutState] Unsupported payout status: "${status}"`);
  }
}

/**
 * Validates whether a given status string is a known domain status.
 * @param {string} status 
 * @returns {boolean}
 */
export function isValidPayoutStatus(status) {
  try {
    assertValidPayoutStatus(status);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Performs defensive normalization of status values.
 * Returns PAID or UNPAID as a fallback for any corrupted/unknown values.
 * @param {string} status 
 * @returns {string}
 */
export function normalizePayoutStatus(status) {
  if (!status) return RECEIPT_PAYOUT_STATUS.UNPAID;
  const clean = String(status).trim().toLowerCase();
  if (VALID_STATUSES.has(clean)) {
    return clean;
  }
  return RECEIPT_PAYOUT_STATUS.UNPAID;
}

/**
 * Returns metadata (labels, colors, badges, icons) for any payout status.
 * Reads from the cached, frozen static registry.
 * @param {string} status 
 * @returns {{ id: string, label: string, printLabel: string, color: string, badgeClass: string, icon: string }}
 */
export function getPayoutStatusMeta(status) {
  const clean = normalizePayoutStatus(status);
  return STATUS_META_REGISTRY[clean] || STATUS_META_REGISTRY[RECEIPT_PAYOUT_STATUS.UNPAID];
}

// State Machine transition rules
const TRANSITION_RULES = Object.freeze({
  [RECEIPT_PAYOUT_STATUS.UNPAID]: new Set([RECEIPT_PAYOUT_STATUS.PAID, RECEIPT_PAYOUT_STATUS.PARTIAL, RECEIPT_PAYOUT_STATUS.CANCELLED]),
  [RECEIPT_PAYOUT_STATUS.PAID]: new Set([RECEIPT_PAYOUT_STATUS.UNPAID, RECEIPT_PAYOUT_STATUS.PARTIAL, RECEIPT_PAYOUT_STATUS.CANCELLED]),
  [RECEIPT_PAYOUT_STATUS.PARTIAL]: new Set([RECEIPT_PAYOUT_STATUS.PAID, RECEIPT_PAYOUT_STATUS.UNPAID, RECEIPT_PAYOUT_STATUS.CANCELLED]),
  [RECEIPT_PAYOUT_STATUS.CANCELLED]: new Set([RECEIPT_PAYOUT_STATUS.UNPAID])
});

/**
 * Checks if a transition from one state to another is allowed.
 * @param {string} from 
 * @param {string} to 
 * @returns {boolean}
 */
export function canTransition(from, to) {
  const cleanFrom = normalizePayoutStatus(from);
  const cleanTo = normalizePayoutStatus(to);
  if (cleanFrom === cleanTo) return true;
  return TRANSITION_RULES[cleanFrom]?.has(cleanTo) || false;
}

/**
 * Transition engine for changing payout status.
 * Ensures the transition is valid, returns a new mutated copy of the receipt.
 * @param {object} receipt 
 * @param {string} nextStatus 
 * @returns {object}
 */
export function transitionReceiptState(receipt, nextStatus) {
  if (!receipt) throw new Error('[PayoutState] Receipt object is required');
  assertValidPayoutStatus(nextStatus);

  const currentStatus = normalizePayoutStatus(receipt.payout_status);
  const targetStatus = normalizePayoutStatus(nextStatus);

  if (!canTransition(currentStatus, targetStatus)) {
    throw new Error(`[PayoutState] Transition not allowed from "${currentStatus}" to "${targetStatus}"`);
  }

  const localISO = DateUtils.nowLocal();

  return Object.freeze({
    ...receipt,
    payout_status: targetStatus,
    paid_at: targetStatus === RECEIPT_PAYOUT_STATUS.PAID ? localISO : null
  });
}

// ─── PER-ROW DISBURSEMENT STATUS ─────────────────────────────────────────────

export const ROW_DISBURSEMENT_STATUS = Object.freeze({
  PAID: 'paid',
  UNPAID: 'unpaid',
});

export const ROW_DISBURSEMENT_LABELS = Object.freeze({
  [ROW_DISBURSEMENT_STATUS.PAID]: 'تم صرفه',
  [ROW_DISBURSEMENT_STATUS.UNPAID]: 'لم يتم صرفه',
});

/**
 * Validate a requested row disbursement status against the two supported values:
 *   - 'paid' / 'تم صرفه'   -> 'paid'
 *   - 'unpaid' / 'لم يتم صرفه' -> 'unpaid'
 * Throws an Error for any other value.
 *
 * @param {string} status
 * @returns {'paid'|'unpaid'}
 */
export function validateRowDisbursementStatus(status) {
  if (typeof status !== 'string') {
    throw new Error(`[RowPayoutState] Invalid row status type: expected string, got ${typeof status}`);
  }
  const clean = status.trim();
  const lower = clean.toLowerCase();
  if (lower === ROW_DISBURSEMENT_STATUS.PAID || clean === 'تم صرفه') {
    return ROW_DISBURSEMENT_STATUS.PAID;
  }
  if (lower === ROW_DISBURSEMENT_STATUS.UNPAID || clean === 'لم يتم صرفه') {
    return ROW_DISBURSEMENT_STATUS.UNPAID;
  }
  throw new Error(`[RowPayoutState] Unsupported row disbursement status: "${status}"`);
}

export function isValidRowDisbursementStatus(status) {
  try {
    validateRowDisbursementStatus(status);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Determine a receipt row's saved disbursement status.
 * Default for rows that do not yet have a row-level status is 'unpaid' ('لم يتم صرفه').
 * Never infers row status from receipt-level payout_status.
 *
 * @param {object} row
 * @returns {'paid'|'unpaid'}
 */
export function getRowDisbursementStatus(row) {
  if (!row || typeof row !== 'object') return ROW_DISBURSEMENT_STATUS.UNPAID;
  const raw =
    row.disbursement_status ??
    row.row_status ??
    row.payout_status ??
    row.status ??
    (row.rowPayment && String(row.rowPayment).trim().toLowerCase() !== 'pending' ? row.rowPayment : null);

  if (typeof raw === 'string') {
    const clean = raw.trim();
    const lower = clean.toLowerCase();
    if (lower === ROW_DISBURSEMENT_STATUS.PAID || clean === 'تم صرفه') {
      return ROW_DISBURSEMENT_STATUS.PAID;
    }
    if (lower === ROW_DISBURSEMENT_STATUS.UNPAID || clean === 'لم يتم صرفه') {
      return ROW_DISBURSEMENT_STATUS.UNPAID;
    }
  }
  return ROW_DISBURSEMENT_STATUS.UNPAID;
}

/**
 * Get the Arabic label ('تم صرفه' or 'لم يتم صرفه') for a row or status value.
 *
 * @param {object|string} rowOrStatus
 * @returns {string}
 */
export function getRowDisbursementStatusLabel(rowOrStatus) {
  const status =
    rowOrStatus && typeof rowOrStatus === 'object'
      ? getRowDisbursementStatus(rowOrStatus)
      : (() => {
          try {
            return validateRowDisbursementStatus(String(rowOrStatus ?? ''));
          } catch (_) {
            return ROW_DISBURSEMENT_STATUS.UNPAID;
          }
        })();
  return ROW_DISBURSEMENT_LABELS[status] || ROW_DISBURSEMENT_LABELS[ROW_DISBURSEMENT_STATUS.UNPAID];
}

// ─── RECEIPT-LEVEL PAYMENT STATUS ────────────────────────────────────────────

export const RECEIPT_PAYMENT_STATUS = Object.freeze({
  PAID: 'paid',
  UNPAID: 'unpaid',
});

export const RECEIPT_PAYMENT_LABELS = Object.freeze({
  [RECEIPT_PAYMENT_STATUS.PAID]: 'تم دفعه',
  [RECEIPT_PAYMENT_STATUS.UNPAID]: 'لم يتم دفعه',
});

/**
 * Validate a requested receipt payment status against the two supported values:
 *   - 'paid' / 'تم دفعه'       -> 'paid'
 *   - 'unpaid' / 'لم يتم دفعه' -> 'unpaid'
 * Throws an Error for any other value.
 *
 * @param {string} status
 * @returns {'paid'|'unpaid'}
 */
export function validateReceiptPaymentStatus(status) {
  if (typeof status !== 'string') {
    throw new Error(`[ReceiptPaymentState] Invalid receipt payment status type: expected string, got ${typeof status}`);
  }
  const clean = status.trim();
  const lower = clean.toLowerCase();
  if (lower === RECEIPT_PAYMENT_STATUS.PAID || clean === 'تم دفعه') {
    return RECEIPT_PAYMENT_STATUS.PAID;
  }
  if (lower === RECEIPT_PAYMENT_STATUS.UNPAID || clean === 'لم يتم دفعه') {
    return RECEIPT_PAYMENT_STATUS.UNPAID;
  }
  throw new Error(`[ReceiptPaymentState] Unsupported receipt payment status: "${status}"`);
}

export function isValidReceiptPaymentStatus(status) {
  try {
    validateReceiptPaymentStatus(status);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Determine a receipt's saved payment status at the receipt level.
 *
 * Resolution rules (deterministic):
 *   1. If `receipt.payment_status` is explicitly present and valid ('paid' / 'تم دفعه'
 *      or 'unpaid' / 'لم يتم دفعه'), return its canonical value ('paid' | 'unpaid').
 *   2. Compatibility fallback for legacy row-level `payment_status`:
 *      If receipt-level `payment_status` is absent, inspect all non-separator data rows
 *      in `receipt.rows`. If at least one data row exists, EVERY data row has a valid
 *      legacy `row.payment_status`, and all data rows agree on the exact same value,
 *      return that unanimous value.
 *   3. If legacy row-level values conflict or are missing, return the safe fallback
 *      'unpaid' ('لم يتم دفعه'). Never infer payment status from `receipt.payout_status`
 *      or row-level disbursement fields (`disbursement_status`, `row_status`, `rowPayment`).
 *
 * @param {object} receipt
 * @returns {'paid'|'unpaid'}
 */
export function getReceiptPaymentStatus(receipt) {
  if (!receipt || typeof receipt !== 'object') return RECEIPT_PAYMENT_STATUS.UNPAID;

  const rawReceiptStatus = receipt.payment_status;
  if (typeof rawReceiptStatus === 'string' && rawReceiptStatus.trim() !== '') {
    try {
      return validateReceiptPaymentStatus(rawReceiptStatus);
    } catch (_) {
      // Fall through to safe fallback if corrupted
      return RECEIPT_PAYMENT_STATUS.UNPAID;
    }
  }

  const rawRows = Array.isArray(receipt.rows)
    ? receipt.rows
    : typeof receipt.rows === 'string'
      ? (() => {
          try {
            return JSON.parse(receipt.rows) || [];
          } catch (_) {
            return [];
          }
        })()
      : [];

  const dataRows = rawRows.filter(
    (r) => r && typeof r === 'object' && r._type !== 'separator'
  );

  if (dataRows.length > 0) {
    let commonStatus = null;
    let allAgree = true;
    for (const row of dataRows) {
      if (typeof row.payment_status !== 'string' || row.payment_status.trim() === '') {
        allAgree = false;
        break;
      }
      try {
        const rowPayStatus = validateReceiptPaymentStatus(row.payment_status);
        if (commonStatus === null) {
          commonStatus = rowPayStatus;
        } else if (commonStatus !== rowPayStatus) {
          allAgree = false;
          break;
        }
      } catch (_) {
        allAgree = false;
        break;
      }
    }
    if (allAgree && commonStatus !== null) {
      return commonStatus;
    }
  }

  return RECEIPT_PAYMENT_STATUS.UNPAID;
}

/**
 * Get the Arabic label ('تم دفعه' or 'لم يتم دفعه') for a receipt or payment status value.
 *
 * @param {object|string} receiptOrStatus
 * @returns {string}
 */
export function getReceiptPaymentStatusLabel(receiptOrStatus) {
  const status =
    receiptOrStatus && typeof receiptOrStatus === 'object'
      ? getReceiptPaymentStatus(receiptOrStatus)
      : (() => {
          try {
            return validateReceiptPaymentStatus(String(receiptOrStatus ?? ''));
          } catch (_) {
            return RECEIPT_PAYMENT_STATUS.UNPAID;
          }
        })();
  return RECEIPT_PAYMENT_LABELS[status] || RECEIPT_PAYMENT_LABELS[RECEIPT_PAYMENT_STATUS.UNPAID];
}

/**
 * Resolve a stable row identifier for a receipt row.
 * Uses row.row_id / row._rowId / row.id when present, or a deterministic
 * fallback keyed by receiptId and stored row index.
 *
 * @param {object} row
 * @param {string|number} [receiptId]
 * @param {number} [rowIndex]
 * @returns {string}
 */
export function getStableRowId(row, receiptId = '', rowIndex = 0) {
  if (row && typeof row === 'object') {
    const existing = row.row_id ?? row._rowId ?? row.id;
    if (existing !== undefined && existing !== null && String(existing).trim() !== '') {
      return String(existing).trim();
    }
  }
  const recPart =
    receiptId !== undefined && receiptId !== null && String(receiptId).trim() !== ''
      ? String(receiptId).trim()
      : 'rec';
  return `row-${recPart}-${rowIndex}`;
}

/**
 * Normalize a persisted receipt row so it always carries a stable row_id, _rowId,
 * and row-level disbursement_status ('paid' | 'unpaid') without mutating financial fields.
 * Removes any legacy per-row `payment_status` fields so payment status is maintained
 * exclusively at the receipt level.
 *
 * @param {object} row
 * @param {string|number} [receiptId]
 * @param {number} [rowIndex]
 * @returns {object}
 */
export function normalizeReceiptRowWithStatus(row, receiptId = '', rowIndex = 0) {
  if (!row || typeof row !== 'object') return row;
  if (row._type === 'separator') return row;
  const stableId = getStableRowId(row, receiptId, rowIndex);
  const status = getRowDisbursementStatus(row);
  const {
    payment_status: _legacyRowPaymentStatus,
    payment_status_updated_at: _legacyRowPaymentUpdatedAt,
    ...cleanRow
  } = row;
  return {
    ...cleanRow,
    row_id: stableId,
    _rowId: stableId,
    disbursement_status: status,
    payout_status: status,
    rowPayment: status,
  };
}

/**
 * Normalize a receipt record so its receipt-level `payment_status` is resolved
 * (including unanimous legacy row-level fallback if receipt-level status was absent)
 * and its rows carry stable row IDs and row-level disbursement statuses only.
 *
 * @param {object} receipt
 * @returns {object}
 */
export function normalizeReceiptWithStatus(receipt) {
  if (!receipt || typeof receipt !== 'object') return receipt;
  const paymentStatus = getReceiptPaymentStatus(receipt);
  const rawRows = Array.isArray(receipt.rows)
    ? receipt.rows
    : typeof receipt.rows === 'string'
      ? (() => {
          try {
            return JSON.parse(receipt.rows) || [];
          } catch (_) {
            return [];
          }
        })()
      : [];
  const receiptId = receipt.id ?? '';
  const rows = rawRows.map((r, idx) => normalizeReceiptRowWithStatus(r, receiptId, idx));
  return {
    ...receipt,
    payment_status: paymentStatus,
    rows,
  };
}
