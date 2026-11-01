import { DBProvider } from './dbProvider.js';

export const ClientRepository = {
  // ── Vehicle Owners ──────────────────────────────────────────────────────
  async getOwnerById(id, options = {}) {
    return DBProvider.get('vehicleOwners', id, options);
  },
  async getAllOwners(options = {}) {
    return DBProvider.getAll('vehicleOwners', null, options);
  },
  async getOwnersForUser(username, options = {}) {
    return DBProvider.findByFields('vehicleOwners', { username }, options);
  },
  async findOwnersByName(name, ownerType = null, options = {}) {
    const filters = { name };
    if (ownerType) filters.owner_type = ownerType;
    return DBProvider.findByFields('vehicleOwners', filters, options);
  },
  async saveOwner(payload, meta) {
    return DBProvider.save('vehicleOwners', payload, meta);
  },
  async updateOwner(id, patch, meta) {
    return DBProvider.update('vehicleOwners', id, patch, meta);
  },
  async deleteOwner(id, meta) {
    return DBProvider.delete('vehicleOwners', id, meta);
  },

  // ── Vehicles ────────────────────────────────────────────────────────────
  async getVehicleById(id, options = {}) {
    return DBProvider.get('vehicles', id, options);
  },
  async getAllVehicles(options = {}) {
    return DBProvider.getAll('vehicles', null, options);
  },
  async getVehiclesByPlate(plate, options = {}) {
    return DBProvider.findByFields('vehicles', { plate }, options);
  },
  async saveVehicle(payload, meta) {
    return DBProvider.save('vehicles', payload, meta);
  },
  async updateVehicle(id, patch, meta) {
    return DBProvider.update('vehicles', id, patch, meta);
  },
  async deleteVehicle(id, meta) {
    return DBProvider.delete('vehicles', id, meta);
  },

  // ── Drivers ─────────────────────────────────────────────────────────────
  async getDrivers(username) {
    return DBProvider.getByIndex('drivers', 'by_username', username);
  },
  async addDriver(payload, meta) {
    return DBProvider.save('drivers', payload, meta);
  },

};
