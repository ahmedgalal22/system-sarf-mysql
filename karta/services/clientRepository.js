import { DBProvider } from './dbProvider.js';

export const ClientRepository = {
  // ── Vehicle Owners ──────────────────────────────────────────────────────
  async getOwnerById(id) {
    return DBProvider.get('vehicleOwners', id);
  },
  async getAllOwners() {
    return DBProvider.getAll('vehicleOwners');
  },
  async getOwnersForUser(username) {
    return DBProvider.findByFields('vehicleOwners', { username });
  },
  async findOwnersByName(name, ownerType = null) {
    const filters = { name };
    if (ownerType) filters.owner_type = ownerType;
    return DBProvider.findByFields('vehicleOwners', filters);
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

  // ── Agents (mandoubs + brokers) ─────────────────────────────────────────
  async getAgentById(id) {
    return DBProvider.get('agents', id);
  },
  async getAllAgents() {
    return DBProvider.getAll('agents');
  },
  async getAgents(username) {
    return DBProvider.getAll('agents', { username });
  },
  async findAgentsByFields(filters) {
    return DBProvider.findByFields('agents', filters);
  },
  async saveAgent(payload, meta) {
    return DBProvider.save('agents', payload, meta);
  },
  async updateAgent(id, patch, meta) {
    return DBProvider.update('agents', id, patch, meta);
  },
  async deleteAgent(id, meta) {
    return DBProvider.delete('agents', id, meta);
  },

  // ── Vehicles ────────────────────────────────────────────────────────────
  async getVehicleById(id) {
    return DBProvider.get('vehicles', id);
  },
  async getAllVehicles() {
    return DBProvider.getAll('vehicles');
  },
  async getVehiclesByPlate(plate) {
    return DBProvider.findByFields('vehicles', { plate });
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
