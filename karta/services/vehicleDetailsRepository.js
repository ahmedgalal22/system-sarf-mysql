/**
 * vehicleDetailsRepository.js — Vehicle Details Movements Repository
 * ─────────────────────────────────────────────────────────────────────────────
 * Dedicated repository for the standalone "تفاصيل السيارات" feature.
 * Routes all CRUD operations through DBProvider → /api/entities/vehicle-details.
 * Zero interaction with financial tables, vehicle_ledger, treasury, or receipts.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { DBProvider } from './dbProvider.js';

export const VehicleDetailsRepository = {
  async getByOwnerId(ownerId, filters = {}, options = {}) {
    const query = { owner_id: String(ownerId) };
    if (filters?.from_date) query.from_date = String(filters.from_date);
    if (filters?.to_date) query.to_date = String(filters.to_date);
    return DBProvider.findByFields('vehicleDetailsMovements', query, options);
  },

  async getById(id, options = {}) {
    return DBProvider.get('vehicleDetailsMovements', String(id), options);
  },

  async create(payload, meta) {
    return DBProvider.save('vehicleDetailsMovements', payload, meta);
  },

  async update(id, patch, meta) {
    return DBProvider.update('vehicleDetailsMovements', String(id), patch, meta);
  },

  async delete(id, meta) {
    return DBProvider.delete('vehicleDetailsMovements', String(id), meta);
  },
};
