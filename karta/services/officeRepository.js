import { DBProvider } from './dbProvider.js';

export const OfficeRepository = {
  async getById(id) {
    return DBProvider.get('offices', String(id));
  },
  async getAll(username) {
    return DBProvider.findByFields('offices', { username });
  },
  async findByFields(filters) {
    return DBProvider.findByFields('offices', filters);
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
  // ── Bolsa forms (read-only from offices context) ────────────────────────
  async getBolsaForms(username) {
    return DBProvider.findByFields('bolsaForms', { username });
  },

  // ── Receipts (read-only from offices context) ───────────────────────────
  async getReceipts(username) {
    return DBProvider.findByFields('receipts', { username });
  },
  async getReceiptById(id) {
    return DBProvider.get('receipts', id);
  },
};
