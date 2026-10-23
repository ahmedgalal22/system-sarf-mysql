import { DBProvider } from './dbProvider.js';
import { ApiClient } from './apiClient.js';
import { isServerMode } from './apiConfig.js';
import {
  validateRowDisbursementStatus,
  getStableRowId,
  normalizeReceiptRowWithStatus,
} from '../constants/payoutStatus.js';

const _rowStatusLocks = new Map();

async function _withReceiptLock(receiptId, fn) {
  const key = String(receiptId);
  const prev = _rowStatusLocks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((resolve) => {
    release = resolve;
  });
  _rowStatusLocks.set(key, prev.then(() => next, () => next));
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (_rowStatusLocks.get(key) === next) {
      _rowStatusLocks.delete(key);
    }
  }
}

export const ReceiptRepository = {
  async getById(id) {
    return DBProvider.get('receipts', id);
  },
  async getAll(username) {
    return DBProvider.getAll('receipts', { username });
  },
  async save(payload, meta) {
    return DBProvider.save('receipts', payload, meta);
  },
  async update(id, patch, meta) {
    return DBProvider.update('receipts', id, patch, meta);
  },
  async delete(id, meta) {
    return DBProvider.delete('receipts', id, meta);
  },
  async getByIndex(indexName, value) {
    return DBProvider.getByIndex('receipts', indexName, value);
  },
  async findByFields(filters, options = {}) {
    return DBProvider.findByFields('receipts', filters, options);
  },

  /**
   * Persist the disbursement status of a single row within a receipt.
   * Serialized per receiptId so concurrent row-status updates on the same
   * receipt never overwrite each other.
   *
   * @param {string|number} receiptId
   * @param {string} rowId
   * @param {string} status — 'paid' | 'unpaid' | 'تم صرفه' | 'لم يتم صرفه'
   * @param {{ username?: string }} [meta]
   */
  async updateRowStatus(receiptId, rowId, status, meta = {}) {
    if (receiptId === undefined || receiptId === null || String(receiptId).trim() === '') {
      throw new Error('معرف الإيصال مطلوب');
    }
    if (typeof rowId !== 'string' && typeof rowId !== 'number') {
      throw new Error('معرف الصف مطلوب');
    }
    const cleanRowId = String(rowId).trim();
    if (!cleanRowId) {
      throw new Error('معرف الصف مطلوب');
    }
    const canonicalStatus = validateRowDisbursementStatus(status);

    return _withReceiptLock(receiptId, async () => {
      if (isServerMode()) {
        const res = await ApiClient.post('/entities/receipts/row-status.php', {
          receipt_id: receiptId,
          row_id: cleanRowId,
          status: canonicalStatus,
        });
        if (!res.success) {
          throw new Error(res.message || 'فشل تحديث حالة الصف');
        }
        return res.data;
      }

      const existing = await DBProvider.get('receipts', receiptId);
      if (!existing || existing.deleted_at) {
        throw new Error('الإيصال غير موجود');
      }
      if (meta?.username && existing.username && existing.username !== meta.username) {
        throw new Error('غير مسموح بتعديل هذا الإيصال');
      }
      if (existing.is_archived) {
        throw new Error('لا يمكن تعديل سجل مؤرشف');
      }

      const rawRows = Array.isArray(existing.rows)
        ? existing.rows
        : typeof existing.rows === 'string'
          ? JSON.parse(existing.rows || '[]')
          : [];

      let found = false;
      let updatedRow = null;
      const nowIso = new Date().toISOString();

      const updatedRows = rawRows.map((row, idx) => {
        if (!row || row._type === 'separator') return row;
        const normalized = normalizeReceiptRowWithStatus(row, existing.id ?? receiptId, idx);
        if (normalized.row_id === cleanRowId) {
          found = true;
          updatedRow = {
            ...normalized,
            disbursement_status: canonicalStatus,
            payout_status: canonicalStatus,
            rowPayment: canonicalStatus,
            status_updated_at: nowIso,
          };
          return updatedRow;
        }
        return normalized;
      });

      if (!found) {
        throw new Error('الصف المطلوب غير موجود في هذا الإيصال');
      }

      const saved = await DBProvider.update('receipts', receiptId, { rows: updatedRows }, meta);
      return {
        receipt: saved || { ...existing, rows: updatedRows },
        row: updatedRow,
        row_id: cleanRowId,
        status: canonicalStatus,
      };
    });
  },

  /**
   * Search receipts via the dedicated search.php endpoint.
   *
   * @param {object} params — search parameters (all optional):
   *   limit, offset, from_date, to_date,
   *   client_name (string[]), receipt_number (string[]),
   *   vehicle (string[]), karta (string[]), type (string[]),
   *   payout_status (string), sort (string), sort_dir (string),
   *   include_options ('1'|'0')
   *
   * @returns {{ data: object[], meta: object }}
   *   data  — receipt records (same shape as list.php)
   *   meta  — { total, returned, offset, limit, has_more, summary, options? }
   */
  async search(params = {}) {
    const qs = _buildSearchQueryString(params);
    const res = await ApiClient.get(`/entities/receipts/search.php?${qs}`);
    if (!res.success) throw new Error(res.message || 'Search failed');
    return { data: res.data || [], meta: res.meta || {} };
  },
};

/**
 * Build a URL query string from search params.
 * Handles array parameters (client_name[], vehicle[], etc.)
 * by repeating the key with [] suffix.
 */
function _buildSearchQueryString(params) {
  const parts = [];
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      // Multi-value: param[]=a&param[]=b
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') {
          parts.push(`${encodeURIComponent(key)}[]=${encodeURIComponent(item)}`);
        }
      }
    } else {
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.join('&');
}
