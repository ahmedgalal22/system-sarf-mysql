import { DBProvider } from './dbProvider.js';

export const OfficeRepository = {
  async getById(id, options = {}) {
    return DBProvider.get('offices', String(id), options);
  },
  async getAll(username, options = {}) {
    return DBProvider.findByFields('offices', { username }, options);
  },
  async findByFields(filters, options = {}) {
    return DBProvider.findByFields('offices', filters, options);
  },
  async save(payload, meta) {
    return DBProvider.save('offices', payload, meta);
  },
  async update(id, patch, meta) {
    return DBProvider.update('offices', String(id), patch, meta);
  },
  async delete(id, meta) {
    return DBProvider.delete('offices', String(id), meta);
  },

  // ── Receipts (read-only from offices context) ───────────────────────────
  async getReceipts(username, options = {}) {
    return DBProvider.findByFields('receipts', { username }, options);
  },
  async getReceiptById(id, options = {}) {
    return DBProvider.get('receipts', id, options);
  },
};
