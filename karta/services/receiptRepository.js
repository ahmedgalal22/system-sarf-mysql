import { DBProvider } from './dbProvider.js';
import { ApiClient } from './apiClient.js';

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
