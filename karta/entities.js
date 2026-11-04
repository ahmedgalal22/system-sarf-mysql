/**
 * entities.js — consolidated module
 * Internal structure: Constants → State → Services → Helpers → Rendering → Events → Public API → Boot
 */

import {
  FinancialService,
  formatLedgerEntryTime,
  compareLedgerEntriesChronologicalDesc,
} from './financial.js';
import { AuthModule } from './auth.js';
import { Money } from './money.js';
import { printHTML } from './printEngine.js';
import { ExcelService } from './excelService.js';
import { DateUtils } from './dateUtils.js';
import { ClientRepository } from './services/clientRepository.js';
import { ReceiptRepository } from './services/receiptRepository.js';
import { ApiClient } from './services/apiClient.js';
import { generateId as _uuid } from './utils/idGenerator.js';


// _uuid imported from utils/idGenerator.js

function _todayISO() {
  return DateUtils.todayLocal();
}

function _resolveUsername(username, context) {
  const clean = typeof username === 'string' ? username.trim() : '';
  if (clean) return clean;
  const session = AuthModule.getSession();
  const sessionUser = typeof session?.username === 'string' ? session.username.trim() : '';
  if (!sessionUser) {
    throw new Error(`[${context}] username is required.`);
  }
  return sessionUser;
}



// ========================================
// Services — Vehicles
// ========================================

function _normalizePlate(rawPlate) {
  return String(rawPlate ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

async function resolveVehicle(username, rawPlate, owner = null) {
  if (!username) throw new Error('[VehiclesModule:resolveVehicle] username is required.');
  const normalizedPlate = _normalizePlate(rawPlate);

  if (!normalizedPlate) {
    throw new Error('رقم المركبة مطلوب');
  }

  const existing = await ClientRepository.getVehiclesByPlate(normalizedPlate);

  if (existing.length > 0) {
    const vehicle = existing[0];
    if (!vehicle.owner_id && owner?.id) {
      return ClientRepository.updateVehicle(vehicle.id, {
        owner_id: String(owner.id),
        owner_name: owner.name || null,
      }, { username });
    }
    return vehicle;
  }

  if (!owner?.id) {
    throw new Error('يجب تحديد مالك المركبة قبل تسجيل المركبة');
  }

  const vehicle = await ClientRepository.saveVehicle({
    id: _uuid(),
    plate: normalizedPlate,
    owner_id: String(owner.id),
    owner_name: owner.name || null,
    notes: null,
  }, { username });

  return vehicle;
}

const VehiclesModule = { resolveVehicle };

window.VehiclesModule = VehiclesModule;



// ========================================
// Services — OwnersModule
// ========================================

function _toText(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function _emitOwnersChanged() {
  window.dispatchEvent(new CustomEvent('owners:changed'));
}

async function createOwner(username, payload) {
  if (!username) throw new Error('[OwnersModule:createOwner] username is required.');
  const name = _toText(payload?.name).trim();
  const phone = _toText(payload?.phone).trim();
  const notes = _toText(payload?.notes).trim();

  if (!name) {
    throw new Error('اسم صاحب المركبة مطلوب');
  }

  const exists = await ClientRepository.findOwnersByName(name, 'owner');
  if (exists.length > 0) {
    throw new Error('اسم صاحب المركبة مستخدم بالفعل');
  }

  const record = await ClientRepository.saveOwner({
    id: _uuid(),
    username,
    name,
    phone: phone || null,
    owner_type: 'owner',
    notes: notes || null,
  }, { username });

  _emitOwnersChanged();
  return record;
}

async function getAllOwners(options = {}) {
  return ClientRepository.getAllOwners(options);
}

async function updateOwner(username, id, patch) {
  if (!username) throw new Error('[OwnersModule:updateOwner] username is required.');
  if (!id) throw new Error('معرّف صاحب المركبة مطلوب');
  const name = patch?.name === undefined ? undefined : _toText(patch.name).trim();
  const notes = patch?.notes === undefined ? undefined : _toText(patch.notes).trim();

  if (name !== undefined) {
    if (!name) throw new Error('اسم صاحب المركبة مطلوب');
    // Scope duplicate check to the same owner_type domain
    const current = await ClientRepository.getOwnerById(id);
    const ownerType = current?.owner_type || 'owner';
    const exists = (await ClientRepository.findOwnersByName(name, ownerType))
      .filter(o => String(o.id) !== String(id));
    if (exists.length > 0) {
      throw new Error('الاسم مستخدم بالفعل');
    }
  }

  const updated = await ClientRepository.updateOwner(id, {
    ...(name !== undefined ? { name } : {}),
    ...(notes !== undefined ? { notes: notes || null } : {}),
  }, { username });

  _emitOwnersChanged();
  return updated;
}

async function deleteOwner(username, id) {
  if (!username) throw new Error('[OwnersModule:deleteOwner] username is required.');
  if (!id) throw new Error('معرّف صاحب المركبة مطلوب');

  // Receipts contain immutable snapshots with owner_name — safe to delete entity
  const deleted = await ClientRepository.deleteOwner(id, { username });
  _emitOwnersChanged();
  return deleted;
}

async function getOwnerById(id, options = {}) {
  if (!id) return null;
  const owner = await ClientRepository.getOwnerById(id, options);
  if (!owner || owner.deleted_at !== null) return null;
  return owner;
}



async function getClientsByTab(_tab, options = {}) {
  const owners = await ClientRepository.getAllOwners(options);
  return owners
    .filter(o => o.deleted_at === null && o.owner_type !== 'broker')
    .map(o => ({ id: String(o.id), type: 'owner', name: o.name || '', phone: o.phone || null }))
    .filter(x => x.name);
}

async function getClientByType(_type, id, options = {}) {
  const owner = await ClientRepository.getOwnerById(String(id), options);
  if (!owner || owner.deleted_at !== null || owner.owner_type === 'broker') return null;
  return { id: String(owner.id), type: 'owner', name: owner.name || '', phone: owner.phone || null };
}

async function getClientBalance(client_id, client_type, options = {}) {
  if (!client_type) throw new Error('[OwnersModule:getClientBalance] client_type is required.');
  return FinancialService.getClientBalance(client_id, 'owner', null, options);
}

async function getClientLedger(client_id, client_type, options = {}) {
  if (!client_type) throw new Error('[OwnersModule:getClientLedger] client_type is required.');
  return FinancialService.getClientLedger(client_id, 'owner', null, options);
}

async function createClientBalanceEntry(username, payload) {
  return FinancialService.createClientBalanceEntry(username, payload);
}

async function getOwnerVehicles(owner_id, options = {}) {
  const vehicles = await ClientRepository.getAllVehicles(options);
  return vehicles.filter(v => String(v.owner_id || '') === String(owner_id));
}

function normalizeOwnerAccountDigits(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');
}

function normalizeAndValidateOwnerAccNumber(rawValue, fieldLabel = 'القيمة') {
  if (rawValue === null || rawValue === undefined) {
    return { valid: true, value: null, display: '', error: null };
  }
  if (typeof rawValue === 'boolean' || typeof rawValue === 'object') {
    return {
      valid: false,
      value: String(rawValue),
      display: String(rawValue),
      error: `حقل ${fieldLabel} يقبل أرقاماً موجبة فقط (حتى خانتين عشريتين)`,
    };
  }
  const clean = normalizeOwnerAccountDigits(String(rawValue)).trim();
  if (clean === '') {
    return { valid: true, value: null, display: '', error: null };
  }
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(clean)) {
    return {
      valid: false,
      value: String(rawValue),
      display: String(rawValue),
      error: `حقل ${fieldLabel} يقبل أرقاماً موجبة فقط (حتى خانتين عشريتين)`,
    };
  }
  return { valid: true, value: clean, display: clean, error: null };
}

async function getOwnerAccountDetails(owner_id, options = {}) {
  if (!owner_id) return [];
  const rows = await ClientRepository.getOwnerAccountDetails(String(owner_id), options);
  return Array.isArray(rows) ? rows : [];
}

async function createOwnerAccountDetail(username, payload = {}) {
  if (!username) throw new Error('[OwnersModule:createOwnerAccountDetail] username is required.');
  const ownerId = payload?.owner_id;
  if (!ownerId) throw new Error('معرّف صاحب المركبة مطلوب');

  const lehCheck = normalizeAndValidateOwnerAccNumber(payload?.leh_amount ?? null, 'له');
  if (!lehCheck.valid) throw new Error(lehCheck.error);

  const alayhCheck = normalizeAndValidateOwnerAccNumber(payload?.alayh_amount ?? null, 'عليه');
  if (!alayhCheck.valid) throw new Error(alayhCheck.error);

  const rawNotes = payload?.notes;
  const trimmedNotes = rawNotes === null || rawNotes === undefined ? '' : String(rawNotes).trim();

  return ClientRepository.createOwnerAccountDetail({
    owner_id: Number(ownerId),
    leh_amount: lehCheck.value,
    alayh_amount: alayhCheck.value,
    notes: trimmedNotes === '' ? null : trimmedNotes,
  }, { username });
}

async function updateOwnerAccountDetail(username, id, patch = {}) {
  if (!username) throw new Error('[OwnersModule:updateOwnerAccountDetail] username is required.');
  if (!id) throw new Error('معرّف الصف مطلوب');

  const cleanPatch = {};
  if ('leh_amount' in patch) {
    const lehCheck = normalizeAndValidateOwnerAccNumber(patch.leh_amount, 'له');
    if (!lehCheck.valid) throw new Error(lehCheck.error);
    cleanPatch.leh_amount = lehCheck.value;
  }
  if ('alayh_amount' in patch) {
    const alayhCheck = normalizeAndValidateOwnerAccNumber(patch.alayh_amount, 'عليه');
    if (!alayhCheck.valid) throw new Error(alayhCheck.error);
    cleanPatch.alayh_amount = alayhCheck.value;
  }
  if ('notes' in patch) {
    const rawNotes = patch.notes;
    const trimmedNotes = rawNotes === null || rawNotes === undefined ? '' : String(rawNotes).trim();
    cleanPatch.notes = trimmedNotes === '' ? null : trimmedNotes;
  }

  return ClientRepository.updateOwnerAccountDetail(Number(id), cleanPatch, { username });
}

async function deleteOwnerAccountDetail(username, id) {
  if (!username) throw new Error('[OwnersModule:deleteOwnerAccountDetail] username is required.');
  if (!id) throw new Error('معرّف الصف مطلوب');
  return ClientRepository.deleteOwnerAccountDetail(Number(id), { username });
}

async function addAccount(username, _kind, payload) {
  if (!username) throw new Error('[OwnersModule:addAccount] username is required.');
  const name = _toText(payload?.name).trim();
  const notes = _toText(payload?.notes).trim();
  if (!name) throw new Error('❌ الاسم مطلوب');

  await createOwner(username, { name, phone: payload?.phone || null, notes });
}


// ─── DEPRECATED PROXIES (delegate to FinancialService) ─────────────────────
const OwnersModule = Object.freeze({
  createOwner,
  getAllOwners,
  updateOwner,
  deleteOwner,
  getOwnerById,
  getClientsByTab,
  getClientByType,
  getClientBalance,
  getClientLedger,
  createClientBalanceEntry,
  getOwnerVehicles,
  getOwnerAccountDetails,
  createOwnerAccountDetail,
  updateOwnerAccountDetail,
  deleteOwnerAccountDetail,
  addAccount,
});

window.OwnersModule = OwnersModule;



// ========================================
// Owners Page — Rendering / Events
// ========================================

let _selectedClient = null;
let _balanceActionType = 'deposit';
let _activeOwnerDetailsTab = 'movements';
let _lastOwnerDetailsClientId = null;
let _ownerDetailsLoadSeq = 0;
let _ownerAccountDetailRows = [];
let _ownerAccSearchQuery = '';
let _ownerAccFromDate = '';
let _ownerAccToDate = '';
let _ownerAccStatusText = '';
let _ownerAccStatusKind = '';
let _ownerAccActiveInputId = null;
let _ownerAccPendingSaves = 0;
let _ownerAccMutationSeq = 0;
const _ownerAccUnsavedDrafts = new Map();
const _ownerAccInFlightValues = new Map();
const _ownerAccDeletingRowIds = new Set();
const LAST_PAGE_CTX_KEY = 'karta_v2_last_page_ctx';

function _fmt(n) {
  return Money.fmt(n);
}

function _dateLabel(value) {
  if (!value) return '-';
  return String(value).split('T')[0] || '-';
}

function _ledgerType(type) {
  if (type === 'deposit') return 'إضافة';
  if (type === 'withdraw') return 'سداد';
  if (type === 'receipt_due') return 'صافي مستحق';
  if (type === 'receipt_payment') return 'صرف نموذج';
  if (type === 'OFFICE_DEPOSIT') return 'إيداع مكتب';
  if (type === 'OFFICE_WITHDRAW_AUTO') return 'سحب مكتب';
  return type || '-';
}

function _ledgerNote(entry) {
  const receiptNum = entry.receipt_number || '';
  const refType = entry.reference_type || '';
  const type = entry.type || '';
  const note = entry.note || '';

  // Receipt due — نموذج صرف أُضيف
  if (type === 'receipt_due') {
    return receiptNum ? 'إيداع نموذج صرف — إذن: ' + receiptNum : 'إيداع نموذج صرف';
  }
  // Receipt payment — نموذج صرف تم صرفه
  if (type === 'receipt_payment') {
    return receiptNum ? 'سحب نموذج صرف — إذن: ' + receiptNum : 'سحب نموذج صرف';
  }
  // Client balance — manual deposit/withdraw
  if (refType === 'client_balance') {
    if (type === 'deposit') return note || 'إيداع رصيد يدوي';
    if (type === 'withdraw') return note || 'سحب رصيد يدوي';
  }
  // Salfa
  if (refType === 'salfa') {
    return note || 'سلفة';
  }
  // Office entries
  if (type === 'OFFICE_DEPOSIT') return note || 'إيداع مكتب';
  if (type === 'OFFICE_WITHDRAW_AUTO') {
    const raw = String(note || entry.vehicle_owner_name || entry.owner_name || '').trim().replace(/\s+/g, ' ');
    if (raw) {
      const m = raw.match(/^(?:قيمة\s+كارتة\s*-\s*)+(.+)$/);
      const owner = m ? m[1].trim() : (raw === 'قيمة كارتة' ? '' : raw);
      if (owner && !/^خصم\s+من\s+الرصيد/.test(owner)) {
        return `قيمة كارتة - ${owner}`;
      }
      return raw;
    }
    return 'قيمة كارتة';
  }
  // Generic
  if (note) return note;
  return _ledgerType(type);
}

function _balanceClass(balance) {
  if (Number(balance) < 0) return 'balance-negative';
  if (Number(balance) > 0) return 'balance-positive';
  return '';
}

function _currentUsername() {
  const session = AuthModule.getSession();
  if (!session?.username) {
    throw new Error('Username required');
  }
  return session.username;
}



async function _clientSnapshot(client, options = {}) {
  const balance = await OwnersModule.getClientBalance(client.id, client.type, options);
  // last_activity = most recent of: entity update OR financial transaction
  const entityTime = Number(client.updated_at || client.created_at || 0);
  const txTime = balance.last_transaction_date
    ? new Date(balance.last_transaction_date).getTime() || 0
    : 0;
  const lastActivity = Math.max(entityTime, txTime);
  return {
    ...client,
    phone: client.phone || null,
    balance: balance.balance,
    last_transaction_date: balance.last_transaction_date,
    updated_at: entityTime,
    last_activity: lastActivity,
  };
}



function _renderShell() {
  const page = document.getElementById('ownersPage');
  if (!page) return;

  page.innerHTML = _renderCustomersShell();
}

function _renderCustomersShell() {
  return `
    <!-- البطاقة العلوية -->
    <div class="ent-top-card">
      <div class="ent-header-row">
        <h2 class="ent-page-title">إدارة أصحاب المركبات</h2>
        <div class="ent-header-actions">
          <button type="button" data-action="add-owner-type" data-kind="owner" class="ent-btn-add">➕ إضافة صاحب مركبة</button>
          <button type="button" data-action="print-owners" class="ent-btn-print">🖨️ طباعة</button>
          <button type="button" data-action="export-owners-excel" class="ent-btn-print" style="background:#0f766e;" title="تصدير أصحاب المركبات إلى Excel">📤 تصدير Excel</button>
          <button type="button" data-action="import-owners-excel" class="ent-btn-print" style="background:#7c3aed;" title="استيراد أصحاب المركبات من Excel">📥 استيراد Excel</button>
        </div>
      </div>

      <!-- شريط البحث -->
      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;" class="ent-search-wrap">
        <input id="ownerSearchInput" type="text" class="ent-search-input" placeholder="🔍 ابحث عن صاحب مركبة..." style="flex:1;min-width:200px;">
        <div style="background:linear-gradient(135deg,#1e40af,#3b82f6);color:#fff;padding:8px 20px;border-radius:12px;font-weight:700;font-size:0.875rem;white-space:nowrap;">
          الرصيد الكلي: <span id="totalBalanceDisplay">0.00</span>
        </div>
      </div>

    </div>

    <!-- قائمة أصحاب المركبات -->
    <div class="ent-columns-grid" id="ownersColumnsGrid" style="grid-template-columns: 1fr;">
      <div class="ent-column-card">
        <div class="ent-column-header">
          <h3 class="ent-column-title ent-column-title--blue">🚗 أصحاب المركبات</h3>
        </div>
        <div class="table-wrapper ent-column-scroll">
          <table class="table">
            <thead style="background:linear-gradient(135deg,#2563eb,#1d4ed8);">
              <tr>
                <th style="color:#fff;">الاسم</th>
                <th style="color:#fff;">الهاتف</th>
                <th style="color:#fff;">الرصيد</th>
                <th style="color:#fff;">كارتات</th>
                <th style="color:#fff;">إجراءات</th>
              </tr>
            </thead>
            <tbody id="ownersTableBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}


let _addModalKind = 'owner';
let _editingAccountId = null;
let _editingAccountKind = null;


function _openEditModal(id, kind, currentName, currentPhone) {
  // Ensure modal exists first (before setting edit state)
  let modal = document.getElementById('ownerAddModal');
  if (!modal) {
    _openAddModal('صاحب مركبة', 'owner');
    modal = document.getElementById('ownerAddModal');
    modal?.classList.add('hidden');
  }

  // NOW set edit state (after modal creation won't reset it)
  _addModalKind = 'owner';
  _editingAccountId = id;
  _editingAccountKind = 'owner';

  const header = document.getElementById('addModalHeader');
  if (header) {
    header.style.background = 'linear-gradient(135deg,#2563eb,#1d4ed8)';
  }
  const titleEl = document.getElementById('addModalTitle');
  if (titleEl) titleEl.textContent = '✏️ تعديل البيانات';

  const tbody = document.getElementById('addModalRows');
  if (tbody) tbody.innerHTML = `<tr><td><input type="text" class="input input-sm add-m-name" placeholder="الاسم" value="${currentName || ''}"></td><td><input type="text" class="input input-sm add-m-phone" placeholder="رقم الهاتف" value="${currentPhone || ''}"></td><td></td></tr>`;

  const msg = document.getElementById('addModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

function _openAddModal(title = 'صاحب مركبة', _kind = 'owner') {
  _addModalKind = 'owner';
  let modal = document.getElementById('ownerAddModal');
  if (!modal) {
    const div = document.createElement('div');
    div.innerHTML = `
      <div id="ownerAddModal" class="hidden fixed inset-0 flex items-center justify-center z-50 p-4" style="background:rgba(0,0,0,0.4);backdrop-filter:blur(2px);">
        <div style="background:#fff;border-radius:24px;box-shadow:0 25px 50px rgba(0,0,0,0.25);width:100%;max-width:32rem;max-height:90vh;overflow:auto;">
          <div id="addModalHeader" style="padding:20px 24px;border-radius:24px 24px 0 0;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;">
            <div>
              <h3 style="color:#fff;font-size:1.25rem;font-weight:700;margin:0;" id="addModalTitle">➕ إضافة صاحب مركبة</h3>
              <p style="color:rgba(255,255,255,0.8);font-size:0.8125rem;margin:4px 0 0;">أدخل البيانات ثم اضغط حفظ</p>
            </div>
            <button type="button" data-action="close-add-modal" style="background:rgba(255,255,255,0.2);border:none;border-radius:8px;color:#fff;padding:6px 10px;cursor:pointer;font-size:1.125rem;">✕</button>
          </div>
          <div style="padding:20px 24px;">
            <div class="table-wrapper mb-4">
              <table class="table"><thead><tr><th>الاسم</th><th>رقم الهاتف</th><th>حذف</th></tr></thead>
              <tbody id="addModalRows">
                <tr><td><input type="text" class="input input-sm add-m-name" placeholder="الاسم"></td><td><input type="text" class="input input-sm add-m-phone" placeholder="رقم الهاتف"></td><td><button type="button" data-action="add-modal-remove-row" class="btn-icon" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button></td></tr>
              </tbody></table>
            </div>
            <div class="flex gap-2">
              <button type="button" data-action="add-modal-add-row" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">➕ إضافة صف</button>
              <button type="button" data-action="save-add-modal" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">💾 حفظ</button>
              <button type="button" data-action="close-add-modal" class="btn btn-secondary btn-sm">إلغاء</button>
            </div>
            <div id="addModalMsg" class="field-msg-inline field-msg-inline--error mt-3" role="alert"></div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div.firstElementChild);
    modal = document.getElementById('ownerAddModal');
  }

  const header = document.getElementById('addModalHeader');
  if (header) {
    header.style.background = 'linear-gradient(135deg,#2563eb,#1d4ed8)';
  }
  const titleEl = document.getElementById('addModalTitle');
  if (titleEl) titleEl.textContent = '➕ إضافة ' + title;

  // Reset rows
  const tbody = document.getElementById('addModalRows');
  if (tbody) tbody.innerHTML = '<tr><td><input type="text" class="input input-sm add-m-name" placeholder="الاسم"></td><td><input type="text" class="input input-sm add-m-phone" placeholder="رقم الهاتف"></td><td><button type="button" data-action="add-modal-remove-row" class="btn-icon" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button></td></tr>';
  _editingAccountId = null;
  _editingAccountKind = null;
  const msg = document.getElementById('addModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal.classList.remove('hidden');
}

async function _saveFromAddModal() {
  const msg = document.getElementById('addModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }

  // ── EDIT MODE ──
  if (_editingAccountId) {
    const nameVal = (document.querySelector('#addModalRows .add-m-name')?.value || '').trim();
    const phoneVal = (document.querySelector('#addModalRows .add-m-phone')?.value || '').trim() || null;
    if (!nameVal) { if (msg) { msg.textContent = '❌ الاسم مطلوب'; msg.classList.add('is-visible'); } return; }
    try {
      await OwnersModule.updateOwner(_currentUsername(), _editingAccountId, { name: nameVal });
      await ClientRepository.updateOwner(_editingAccountId, { phone: phoneVal }, { username: _currentUsername() });
      window.dispatchEvent(new CustomEvent('owners:changed'));
    } catch (err) { if (msg) { msg.textContent = err.message; msg.classList.add('is-visible'); } return; }
    _editingAccountId = null;
    _editingAccountKind = null;
    document.getElementById('ownerAddModal')?.classList.add('hidden');
    loadOwners(); // non-blocking background refresh
    return;
  }

  // ── ADD MODE ──
  const rows = [...document.querySelectorAll('#addModalRows tr')];
  const entries = rows.map(tr => ({
    name: (tr.querySelector('.add-m-name')?.value || '').trim(),
    phone: (tr.querySelector('.add-m-phone')?.value || '').trim() || null,
  })).filter(e => e.name);

  if (entries.length === 0) {
    if (msg) { msg.textContent = '❌ أدخل اسم واحد على الأقل'; msg.classList.add('is-visible'); }
    return;
  }

  const username = _currentUsername();
  for (const entry of entries) {
    try {
      await OwnersModule.addAccount(username, 'owner', { name: entry.name, phone: entry.phone });
    } catch (err) {
      if (msg) { msg.textContent = err.message || '❌ حدث خطأ'; msg.classList.add('is-visible'); }
      return;
    }
  }

  document.getElementById('ownerAddModal')?.classList.add('hidden');
  _invalidateKartaCounts();
  loadOwners(); // non-blocking background refresh
}



function _updateTotalBalance() {
  let total = 0;
  document.querySelectorAll('#ownersTableBody tr').forEach(tr => {
    if (tr.style.display === 'none') return;
    const cells = tr.querySelectorAll('td');
    if (cells.length >= 3) {
      const val = parseFloat(cells[2]?.textContent) || 0;
      total += val;
    }
  });
  const el = document.getElementById('totalBalanceDisplay');
  if (el) el.textContent = Money.fmt(total);
}

function _printEntities(mode) {
  // Collect rows to print
  let rows = [];
  const ownerRows = document.querySelectorAll('#ownersTableBody tr');

  const collectFromNodeList = (nodeList, groupName) => {
    nodeList.forEach(tr => {
      if (tr.style.display === 'none') return; // skip filtered

      const cells = tr.querySelectorAll('td');
      if (cells.length < 4) return;
      // Get name from cell[0]
      const name = (cells[0]?.textContent || '').trim();
      const phone = (cells[1]?.textContent || '').trim();
      const balance = (cells[2]?.textContent || '').trim();
      rows.push({ name, phone, balance, group: groupName });
    });
  };

  collectFromNodeList(ownerRows, 'أصحاب المركبات');

  if (rows.length === 0) {
    alert('لا توجد بيانات للطباعة');
    return;
  }

  const tableRows = rows.map(r => `
    <tr>
      <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:right;">${r.name}</td>
      <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:center;">${r.phone}</td>
      <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:center;font-weight:700;">${r.balance}</td>
    </tr>
  `).join('');

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <title>طباعة كشف حساب العملاء</title>
  <style>
    @import url('cairo-font.css');
    body { font-family: 'Cairo', Arial, sans-serif; direction: rtl; margin: 0; padding: 20px; }
    h2 { text-align: center; color: #1f2937; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1e3a8a; color: #fff; padding: 10px 12px; text-align: center; border: 1px solid #1e3a8a; font-size: 0.875rem; }
    td { font-size: 0.875rem; }
    @page { size: A4 portrait; margin: 15mm; }
  </style>
</head>
<body>
  <h2>${mode === 'selected' ? 'طباعة المحدد' : 'كشف حساب العملاء'}</h2>
  <table>
    <thead><tr><th>الاسم</th><th>رقم الهاتف</th><th>الرصيد</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;

  printHTML(html, { id: 'entities-print-iframe' });
}

function _sortByPriority(list) {
  return list.slice().sort((a, b) => {
    // 1. Negative balance first
    const aNeg = (a.balance || 0) < 0 ? 1 : 0;
    const bNeg = (b.balance || 0) < 0 ? 1 : 0;
    if (aNeg !== bNeg) return bNeg - aNeg;
    // 2. Then by last activity (entity update OR financial transaction)
    const aTime = a.last_activity || a.updated_at || 0;
    const bTime = b.last_activity || b.updated_at || 0;
    return bTime - aTime;
  });
}

// ── Batch karta counts — single API call for all clients ──
let _kartaCountsCache = null;
let _kartaCountsPromise = null; // dedup concurrent calls

async function _loadKartaCounts(options = {}) {
  if (_kartaCountsCache) return _kartaCountsCache;
  // If a request is already in flight, reuse it (prevents N parallel duplicates)
  if (_kartaCountsPromise) return _kartaCountsPromise;
  _kartaCountsPromise = (async () => {
    try {
      const res = await ApiClient.get('/stats/client-karta-counts.php', options);
      _kartaCountsCache = (res.success && res.data) ? res.data : {};
    } catch {
      _kartaCountsCache = {};
    }
    _kartaCountsPromise = null;
    return _kartaCountsCache;
  })();
  return _kartaCountsPromise;
}

function _invalidateKartaCounts() {
  _kartaCountsCache = null;
  _kartaCountsPromise = null;
}

/**
 * Public notification: a receipt's payout status changed.
 * Called by external modules (e.g. allReceipts.js) after a local
 * optimistic update, so entities can invalidate relevant caches
 * without requiring a full receipts:changed event dispatch.
 */
function notifyReceiptStatusChanged() {
  _invalidateKartaCounts();
}

async function _getUnpaidKartaCount(clientId, clientType = 'owner', options = {}) {
  const counts = await _loadKartaCounts(options);
  const key = clientType + ':' + String(clientId);
  return counts[key] || 0;
}

function _buildClientRow(client, kartaCount, _kind = 'owner') {
  return `
    <tr data-client-name="${(client.name || '').toLowerCase()}">
      <td data-action="view-client" data-id="${client.id}" data-type="owner" class="ent-name-cell ent-name-cell--blue">
        ${client.name}
      </td>
      <td>${client.phone || '—'}</td>
      <td class="${_balanceClass(client.balance)}">${_fmt(client.balance)}</td>
      <td class="text-center">${kartaCount > 0 ? '<span class="ent-karta-badge">' + kartaCount + '</span>' : '—'}</td>
      <td>
        <button type="button" data-action="edit-account" data-id="${client.id}" data-kind="owner" class="ent-action-btn ent-action-btn--edit" title="تعديل">✏️</button>
        <button type="button" data-action="delete-account" data-id="${client.id}" data-kind="owner" class="ent-action-btn ent-action-btn--delete" title="حذف">🗑️</button>
      </td>
    </tr>`;
}

async function loadOwners(options = {}) {
  if (!document.getElementById('ownersTableBody')) {
    _renderShell();
  }

  const ownersTbody = document.getElementById('ownersTableBody');
  if (!ownersTbody) return;

  // Show loading indicator on first render only
  if (ownersTbody.children.length === 0) {
    ownersTbody.innerHTML = '<tr><td colspan="5" class="text-muted text-center p-6">⏳ جاري التحميل...</td></tr>';
  }

  // Owners (exclude brokers)
  const owners = await ClientRepository.getAllOwners(options);
  const ownerList = owners.filter(o => o.deleted_at === null && o.name && o.owner_type !== 'broker').map(o => ({
    id: String(o.id), type: 'owner', name: o.name || '', phone: o.phone || null
  }));
  const ownerSnaps = await Promise.all(ownerList.map(o => _clientSnapshot(o, options)));
  const ownerKartas = await Promise.all(ownerList.map(o => _getUnpaidKartaCount(o.id, 'owner', options)));

  const sortedOwners = _sortByPriority(ownerSnaps);
  if (sortedOwners.length === 0) {
    ownersTbody.innerHTML = '<tr><td colspan="5" class="text-muted text-center p-6">لا توجد أصحاب مركبات</td></tr>';
  } else {
    ownersTbody.innerHTML = sortedOwners.map((client) => {
      const idx = ownerSnaps.indexOf(client);
      return _buildClientRow(client, ownerKartas[idx], 'owner');
    }).join('');
  }

  // Update total balance
  _updateTotalBalance();

  // Search handler
  const searchInput = document.getElementById('ownerSearchInput');
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = '1';
    searchInput.addEventListener('input', function() {
      const query = this.value.trim().toLowerCase();
      document.querySelectorAll('#ownersTableBody tr').forEach(tr => {
        const name = tr.dataset.clientName || '';
        tr.style.display = (!query || name.includes(query)) ? '' : 'none';
      });
      _updateTotalBalance();
    });
  }
}

async function _getClient(type, id, options = {}) {
  return OwnersModule.getClientByType(type, id, options);
}

async function _renderLedger(client, preloadedLedger = null) {
  const rawLedger = Array.isArray(preloadedLedger)
    ? preloadedLedger
    : await OwnersModule.getClientLedger(client.id, client.type);
  const ledger = rawLedger.slice().sort(compareLedgerEntriesChronologicalDesc);
  return `
    <section class="ent-tab-section">
      <div class="ent-section-header">
        <h3 class="ent-section-title text-lg font-bold mb-0">الحركات</h3>
      </div>
      <div class="filter-row ent-filter-bar mb-6 flex-wrap">
        <div class="form-group mb-0">
          <label class="label mb-2 text-muted text-xs" for="clientFromDate">من</label>
          <input id="clientFromDate" type="date" class="input input-sm">
        </div>
        <div class="form-group mb-0">
          <label class="label mb-2 text-muted text-xs" for="clientToDate">إلى</label>
          <input id="clientToDate" type="date" class="input input-sm">
        </div>
        <div class="ent-filter-actions">
          <button type="button" data-action="client-apply-filter" data-id="${client.id}" data-type="${client.type}"
            class="btn btn-primary btn-sm">
            تطبيق
          </button>
          <button type="button" data-action="client-clear-filter" data-id="${client.id}" data-type="${client.type}"
            class="btn btn-secondary btn-sm">
            مسح التحديد
          </button>
        </div>
      </div>
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>الوقت</th>
              <th>المبلغ</th>
              <th>ملاحظة</th>
            </tr>
          </thead>
          <tbody id="clientLedgerBody">
            ${ledger.length ? ledger.map(e => `
              <tr>
                <td>${_dateLabel(e.date || e.applied_at)}</td>
                <td>${formatLedgerEntryTime(e)}</td>
                <td class="font-semibold">${_fmt(e.amount)}</td>
                <td>${_ledgerNote(e)}</td>
              </tr>
            `).join('') : `
              <tr>
                <td colspan="4" class="text-muted text-center">لا توجد حركات</td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    </section>
  `;
}


function _ensureVehicleModal() {
  if (document.getElementById('vehicleModal')) return;
  const div = document.createElement('div');
  div.innerHTML = `
    <div id="vehicleModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold" id="vehicleModalTitle">إضافة مركبة</h3>
          <button type="button" data-action="vehicle-modal-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>
        <div class="grid gap-3 mb-4">
          <div>
            <label class="label mb-1" for="vehicleModalPlate">رقم المركبة</label>
            <input id="vehicleModalPlate" type="text" class="input input-sm" placeholder="أدخل رقم المركبة">
          </div>
          <div>
            <label class="label mb-1" for="vehicleModalDriver">اسم السائق</label>
            <input id="vehicleModalDriver" type="text" class="input input-sm" placeholder="اسم السائق (اختياري)">
          </div>
        </div>
        <div class="flex gap-2">
          <button type="button" data-action="vehicle-modal-save" class="btn btn-primary btn-sm btn-full">حفظ</button>
        </div>
        <div id="vehicleModalMsg" class="field-msg-inline field-msg-inline--error mt-3" role="alert"></div>
      </div>
    </div>
  `;
  document.body.appendChild(div.firstElementChild);
}

let _vehicleEditId = null;
let _vehicleOwnerId = null;

function _openVehicleModal(title, plate, driver, ownerId, editId) {
  _ensureVehicleModal();
  _vehicleOwnerId = ownerId || null;
  _vehicleEditId = editId || null;
  const modal = document.getElementById('vehicleModal');
  const titleEl = document.getElementById('vehicleModalTitle');
  const plateEl = document.getElementById('vehicleModalPlate');
  const driverEl = document.getElementById('vehicleModalDriver');
  const msg = document.getElementById('vehicleModalMsg');
  if (titleEl) titleEl.textContent = title;
  if (plateEl) plateEl.value = plate || '';
  if (driverEl) driverEl.value = driver || '';
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  modal?.classList.remove('hidden');
}

async function _renderOwnerVehicles(client, preloadedVehicles = null) {
  const owned = Array.isArray(preloadedVehicles)
    ? preloadedVehicles
    : await OwnersModule.getOwnerVehicles(client.id);

  return `
    <section class="ent-tab-section">
      <div class="ent-section-header flex items-center justify-between mb-4">
        <h3 class="ent-section-title text-lg font-bold mb-0">المركبات والسائقين</h3>
        <div class="flex gap-2">
          <button type="button" data-action="add-vehicle-manual" data-owner-id="${client.id}" class="ent-btn-add-vehicle">➕ إضافة مركبة</button>
        </div>
      </div>
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>رقم المركبة</th>
              <th>اسم السائق</th>
              <th>إجراءات</th>
            </tr>
          </thead>
          <tbody>
            ${owned.length ? owned.map(v => `
              <tr>
                <td>${v.plate || '-'}</td>
                <td>${v.driver_name || '—'}</td>
                <td>
                  <button type="button" data-action="edit-vehicle" data-vehicle-id="${v.id}" class="btn-icon" title="تعديل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">✏️</button>
                  <button type="button" data-action="delete-vehicle" data-vehicle-id="${v.id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
                </td>
              </tr>
            `).join('') : `
              <tr>
                <td colspan="3" class="text-muted text-center">لا توجد مركبات</td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function _escHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _escAttr(value) {
  return _escHtml(value);
}

function _formatOwnerAccNumericDisplay(value) {
  if (value === null || value === undefined) return '';
  const trimmed = String(value).trim();
  return trimmed === '' ? '' : trimmed;
}

function _dedupOwnerAccountRows(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const key = row.id !== undefined && row.id !== null ? String(row.id) : '';
    if (key) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push({ ...row });
  }
  return out;
}

function _resetOwnerAccTabState() {
  _ownerAccountDetailRows = [];
  _ownerAccSearchQuery = '';
  _ownerAccFromDate = '';
  _ownerAccToDate = '';
  _ownerAccStatusText = '';
  _ownerAccStatusKind = '';
  _ownerAccActiveInputId = null;
  _ownerAccPendingSaves = 0;
  _ownerAccUnsavedDrafts.clear();
  _ownerAccInFlightValues.clear();
  _ownerAccDeletingRowIds.clear();
}

function _shouldDeferOwnerAccRedraw() {
  if (_ownerAccPendingSaves > 0) return true;
  if (_ownerAccDeletingRowIds.size > 0) return true;
  if (_ownerAccUnsavedDrafts.size > 0) return true;
  if (_ownerAccActiveInputId) return true;
  const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
  if (activeEl && activeEl.id && /^ownerAcc(Leh|Alayh|Notes)_/.test(activeEl.id)) {
    return true;
  }
  return false;
}

function _isOwnerAccountRowBusy(rowId) {
  const rowKey = String(rowId || '').trim();
  if (!rowKey) return false;
  for (const key of _ownerAccInFlightValues.keys()) {
    if (key.startsWith(`${rowKey}:`)) return true;
  }
  const activeEl = typeof document !== 'undefined' ? document.activeElement : null;
  const activeId = _ownerAccActiveInputId || (activeEl && activeEl.id ? activeEl.id : null);
  if (
    activeId &&
    (activeId === `ownerAccLeh_${rowKey}` ||
      activeId === `ownerAccAlayh_${rowKey}` ||
      activeId === `ownerAccNotes_${rowKey}`)
  ) {
    for (const key of _ownerAccUnsavedDrafts.keys()) {
      if (key.startsWith(`${rowKey}:`)) return true;
    }
  }
  return false;
}

function _setOwnerAccStatus(text, kind = '') {
  _ownerAccStatusText = String(text || '');
  _ownerAccStatusKind = String(kind || '');
  const el = document.getElementById('ownerAccStatusMsg');
  if (!el) return;
  el.textContent = _ownerAccStatusText;
  el.setAttribute('data-status', _ownerAccStatusKind);
  el.classList?.remove('owner-acc-status--saving', 'owner-acc-status--saved', 'owner-acc-status--error');
  if (_ownerAccStatusKind === 'saving') el.classList?.add('owner-acc-status--saving');
  if (_ownerAccStatusKind === 'saved') el.classList?.add('owner-acc-status--saved');
  if (_ownerAccStatusKind === 'error') el.classList?.add('owner-acc-status--error');
}

function _getFilteredOwnerAccountRows() {
  const rawQuery = normalizeOwnerAccountDigits(_ownerAccSearchQuery || '').trim().toLowerCase();
  const fromDate = String(_ownerAccFromDate || '').trim();
  const toDate = String(_ownerAccToDate || '').trim();

  return _ownerAccountDetailRows.filter((row) => {
    if (!row) return false;
    const rowDate = String(row.entry_date || '').trim().slice(0, 10);
    if (fromDate && (!rowDate || rowDate < fromDate)) return false;
    if (toDate && (!rowDate || rowDate > toDate)) return false;

    if (rawQuery) {
      const leh = normalizeOwnerAccountDigits(row.leh_amount ?? '').toLowerCase();
      const alayh = normalizeOwnerAccountDigits(row.alayh_amount ?? '').toLowerCase();
      const notes = normalizeOwnerAccountDigits(row.notes ?? '').toLowerCase();
      const dateStr = normalizeOwnerAccountDigits(row.entry_date ?? '').toLowerCase();
      const timeStr = normalizeOwnerAccountDigits(row.entry_time ?? '').toLowerCase();
      const combined = `${leh} ${alayh} ${notes} ${dateStr} ${timeStr}`;
      if (!combined.includes(rawQuery)) return false;
    }

    return true;
  });
}

function _renderOwnerAccountTableRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return `
      <tr>
        <td colspan="6" class="text-muted text-center p-4">لا توجد سجلات في تفاصيل الحساب</td>
      </tr>
    `;
  }

  return rows.map((row) => {
    const rowId = String(row.id);
    const isDeleting = _ownerAccDeletingRowIds.has(rowId);
    const lehDraftKey = `${rowId}:leh_amount`;
    const alayhDraftKey = `${rowId}:alayh_amount`;
    const notesDraftKey = `${rowId}:notes`;

    const lehVal = _ownerAccUnsavedDrafts.has(lehDraftKey)
      ? _ownerAccUnsavedDrafts.get(lehDraftKey)
      : _formatOwnerAccNumericDisplay(row.leh_amount);
    const alayhVal = _ownerAccUnsavedDrafts.has(alayhDraftKey)
      ? _ownerAccUnsavedDrafts.get(alayhDraftKey)
      : _formatOwnerAccNumericDisplay(row.alayh_amount);
    const notesVal = _ownerAccUnsavedDrafts.has(notesDraftKey)
      ? _ownerAccUnsavedDrafts.get(notesDraftKey)
      : (row.notes ?? '');

    const dateVal = row.entry_date ?? '';
    const timeVal = row.entry_time ?? '';

    return `
      <tr id="ownerAccRow_${_escAttr(rowId)}" data-row-id="${_escAttr(rowId)}">
        <td>
          <input
            id="ownerAccLeh_${_escAttr(rowId)}"
            type="text"
            inputmode="decimal"
            class="input input-sm owner-acc-input"
            data-acc-field="leh_amount"
            data-row-id="${_escAttr(rowId)}"
            value="${_escAttr(lehVal)}"
            placeholder="له"
          >
        </td>
        <td>
          <input
            id="ownerAccAlayh_${_escAttr(rowId)}"
            type="text"
            inputmode="decimal"
            class="input input-sm owner-acc-input"
            data-acc-field="alayh_amount"
            data-row-id="${_escAttr(rowId)}"
            value="${_escAttr(alayhVal)}"
            placeholder="عليه"
          >
        </td>
        <td>
          <input
            id="ownerAccNotes_${_escAttr(rowId)}"
            type="text"
            class="input input-sm owner-acc-input"
            data-acc-field="notes"
            data-row-id="${_escAttr(rowId)}"
            value="${_escAttr(notesVal)}"
            placeholder="ملاحظات"
          >
        </td>
        <td id="ownerAccDate_${_escAttr(rowId)}" class="owner-acc-readonly-cell">${_escHtml(dateVal)}</td>
        <td id="ownerAccTime_${_escAttr(rowId)}" class="owner-acc-readonly-cell">${_escHtml(timeVal)}</td>
        <td class="owner-acc-actions-cell">
          <button
            type="button"
            id="ownerAccDelete_${_escAttr(rowId)}"
            data-action="owner-acc-delete-row"
            data-row-id="${_escAttr(rowId)}"
            class="ent-action-btn ent-action-btn--delete owner-acc-delete-btn"
            title="حذف"
            ${isDeleting ? 'disabled' : ''}
          >حذف</button>
        </td>
      </tr>
    `;
  }).join('');
}

function _renderOwnerAccountDetails(client, preloadedRows = null) {
  const rows = Array.isArray(preloadedRows) ? preloadedRows : _ownerAccountDetailRows;
  _ownerAccountDetailRows = _dedupOwnerAccountRows(rows);
  const filteredRows = _getFilteredOwnerAccountRows();
  const statusClass = _ownerAccStatusKind
    ? `owner-acc-status--${_ownerAccStatusKind}`
    : '';

  return `
    <section class="ent-tab-section">
      <div class="ent-section-header flex items-center justify-between mb-4 flex-wrap gap-3">
        <div class="flex items-center gap-3 flex-wrap">
          <h3 class="ent-section-title text-lg font-bold mb-0">تفاصيل الحساب</h3>
          <span
            id="ownerAccStatusMsg"
            role="status"
            aria-live="polite"
            data-status="${_escAttr(_ownerAccStatusKind)}"
            class="owner-acc-status ${statusClass}"
          >${_escHtml(_ownerAccStatusText)}</span>
        </div>
        <div class="flex gap-2 flex-wrap">
          <button
            type="button"
            id="ownerAccAddRowBtn"
            data-action="owner-acc-add-row"
            data-owner-id="${_escAttr(client.id)}"
            class="ent-btn-add-vehicle"
          >➕ إضافة صف</button>
          <button
            type="button"
            id="ownerAccPrintBtn"
            data-action="owner-acc-print"
            data-owner-id="${_escAttr(client.id)}"
            class="btn btn-secondary btn-sm"
          >🖨️ طباعة</button>
        </div>
      </div>

      <div class="filter-row ent-filter-bar mb-6 flex-wrap">
        <div class="form-group mb-0" style="flex:1;min-width:200px;">
          <label class="label mb-2 text-muted text-xs" for="ownerAccSearchInput">بحث</label>
          <input
            id="ownerAccSearchInput"
            type="text"
            class="input input-sm"
            placeholder="🔍 ابحث في تفاصيل الحساب..."
            value="${_escAttr(_ownerAccSearchQuery)}"
          >
        </div>
        <div class="form-group mb-0">
          <label class="label mb-2 text-muted text-xs" for="ownerAccFromDate">من</label>
          <input
            id="ownerAccFromDate"
            type="date"
            class="input input-sm"
            value="${_escAttr(_ownerAccFromDate)}"
          >
        </div>
        <div class="form-group mb-0">
          <label class="label mb-2 text-muted text-xs" for="ownerAccToDate">إلى</label>
          <input
            id="ownerAccToDate"
            type="date"
            class="input input-sm"
            value="${_escAttr(_ownerAccToDate)}"
          >
        </div>
        <div class="ent-filter-actions">
          <button
            type="button"
            id="ownerAccApplyFilterBtn"
            data-action="owner-acc-apply-filter"
            data-id="${_escAttr(client.id)}"
            class="btn btn-primary btn-sm"
          >تطبيق</button>
          <button
            type="button"
            id="ownerAccClearFilterBtn"
            data-action="owner-acc-clear-filter"
            data-id="${_escAttr(client.id)}"
            class="btn btn-secondary btn-sm"
          >مسح التحديد</button>
        </div>
      </div>

      <div class="table-wrapper">
        <table id="ownerAccTable" class="table">
          <thead>
            <tr>
              <th>له</th>
              <th>عليه</th>
              <th>ملاحظات</th>
              <th>التاريخ</th>
              <th>الوقت</th>
              <th class="owner-acc-actions-col">حذف</th>
            </tr>
          </thead>
          <tbody id="ownerAccTableBody">
            ${_renderOwnerAccountTableRows(filteredRows)}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

async function _commitOwnerAccountCellEdit(rowId, field, rawValue, inputEl = null) {
  const rowKey = String(rowId || '').trim();
  if (!rowKey || _ownerAccDeletingRowIds.has(rowKey)) return false;

  const row = _ownerAccountDetailRows.find((r) => String(r.id) === rowKey);
  if (!row) return false;

  const draftKey = `${rowKey}:${field}`;
  let normalizedValue = null;
  let displayValue = '';

  if (field === 'leh_amount' || field === 'alayh_amount') {
    const label = field === 'leh_amount' ? 'له' : 'عليه';
    const check = normalizeAndValidateOwnerAccNumber(rawValue, label);
    if (!check.valid) {
      const preserved = String(rawValue ?? '');
      _ownerAccUnsavedDrafts.set(draftKey, preserved);
      if (inputEl) {
        inputEl.value = preserved;
        inputEl.classList?.add('owner-acc-input--error');
      }
      _setOwnerAccStatus(`❌ ${check.error}`, 'error');
      return false;
    }
    normalizedValue = check.value;
    displayValue = check.display;
  } else if (field === 'notes') {
    const trimmed = String(rawValue ?? '').trim();
    normalizedValue = trimmed === '' ? null : trimmed;
    displayValue = trimmed;
  } else {
    return false;
  }

  const currentRaw = row[field];
  const currentSaved =
    currentRaw === null || currentRaw === undefined || String(currentRaw).trim() === ''
      ? null
      : String(currentRaw).trim();

  if (normalizedValue === currentSaved && !inputEl?.classList?.contains('owner-acc-input--error')) {
    _ownerAccUnsavedDrafts.delete(draftKey);
    if (inputEl) inputEl.value = displayValue;
    return true;
  }

  if (_ownerAccInFlightValues.get(draftKey) === normalizedValue) {
    return true;
  }

  _ownerAccInFlightValues.set(draftKey, normalizedValue);
  _ownerAccPendingSaves += 1;
  _ownerAccMutationSeq += 1;
  if (inputEl) {
    inputEl.value = displayValue;
    inputEl.classList?.remove('owner-acc-input--error');
  }
  _setOwnerAccStatus('⏳ جاري الحفظ...', 'saving');

  try {
    const updated = await OwnersModule.updateOwnerAccountDetail(_currentUsername(), Number(rowId), {
      [field]: normalizedValue,
    });
    _ownerAccMutationSeq += 1;

    row[field] = updated && field in updated ? updated[field] : normalizedValue;
    if (updated?.updated_at) {
      row.updated_at = updated.updated_at;
    }

    _ownerAccUnsavedDrafts.delete(draftKey);
    if (inputEl) {
      inputEl.value = field === 'notes'
        ? (row.notes ?? '')
        : _formatOwnerAccNumericDisplay(row[field]);
      inputEl.classList?.remove('owner-acc-input--error');
    }
    _setOwnerAccStatus('✓ تم الحفظ', 'saved');
    return true;
  } catch (err) {
    const preserved = String(rawValue ?? '');
    _ownerAccUnsavedDrafts.set(draftKey, preserved);
    if (inputEl) {
      inputEl.value = preserved;
      inputEl.classList?.add('owner-acc-input--error');
    }
    _setOwnerAccStatus(`❌ فشل الحفظ: ${err.message || 'خطأ في الخادم'}`, 'error');
    return false;
  } finally {
    _ownerAccInFlightValues.delete(draftKey);
    _ownerAccPendingSaves = Math.max(0, _ownerAccPendingSaves - 1);
  }
}

function _bindOwnerAccountRowInputs() {
  for (const row of _ownerAccountDetailRows) {
    const rowId = String(row.id);
    const configs = [
      { id: `ownerAccLeh_${rowId}`, field: 'leh_amount' },
      { id: `ownerAccAlayh_${rowId}`, field: 'alayh_amount' },
      { id: `ownerAccNotes_${rowId}`, field: 'notes' },
    ];

    for (const { id, field } of configs) {
      const inputEl = document.getElementById(id);
      if (!inputEl || inputEl.dataset.accBound === '1') continue;
      inputEl.dataset.accBound = '1';

      inputEl.addEventListener('focus', function () {
        _ownerAccActiveInputId = id;
      });

      inputEl.addEventListener('input', function () {
        _ownerAccActiveInputId = id;
        _ownerAccUnsavedDrafts.set(`${rowId}:${field}`, this.value);
      });

      inputEl.addEventListener('blur', async function () {
        if (_ownerAccActiveInputId === id) {
          _ownerAccActiveInputId = null;
        }
        await _commitOwnerAccountCellEdit(rowId, field, this.value, this);
      });

      inputEl.addEventListener('change', async function () {
        await _commitOwnerAccountCellEdit(rowId, field, this.value, this);
      });

      inputEl.addEventListener('keydown', async function (e) {
        if (e && e.key === 'Enter') {
          if (typeof e.preventDefault === 'function') e.preventDefault();
          await _commitOwnerAccountCellEdit(rowId, field, this.value, this);
        }
      });
    }
  }
}

function _refreshOwnerAccountTableBody() {
  const tbody = document.getElementById('ownerAccTableBody');
  if (tbody) {
    const filtered = _getFilteredOwnerAccountRows();
    tbody.innerHTML = _renderOwnerAccountTableRows(filtered);
  }
  const countEl = document.getElementById('ownerTabCountAccountDetails');
  if (countEl) {
    countEl.textContent = String(_ownerAccountDetailRows.length);
  }
  _bindOwnerAccountRowInputs();
}

function _bindOwnerAccountDetailsControls() {
  const searchEl = document.getElementById('ownerAccSearchInput');
  if (searchEl && searchEl.dataset.accBound !== '1') {
    searchEl.dataset.accBound = '1';
    searchEl.addEventListener('input', function () {
      _ownerAccSearchQuery = this.value || '';
      _refreshOwnerAccountTableBody();
    });
  }

  const fromEl = document.getElementById('ownerAccFromDate');
  if (fromEl && fromEl.dataset.accBound !== '1') {
    fromEl.dataset.accBound = '1';
    const onFromChange = function () {
      _ownerAccFromDate = this.value || '';
      _refreshOwnerAccountTableBody();
    };
    fromEl.addEventListener('change', onFromChange);
    fromEl.addEventListener('input', onFromChange);
  }

  const toEl = document.getElementById('ownerAccToDate');
  if (toEl && toEl.dataset.accBound !== '1') {
    toEl.dataset.accBound = '1';
    const onToChange = function () {
      _ownerAccToDate = this.value || '';
      _refreshOwnerAccountTableBody();
    };
    toEl.addEventListener('change', onToChange);
    toEl.addEventListener('input', onToChange);
  }

  _bindOwnerAccountRowInputs();
}

async function _handleAddOwnerAccountRow() {
  if (!_selectedClient || !_selectedClient.id) return null;
  const targetOwnerId = String(_selectedClient.id);
  _ownerAccPendingSaves += 1;
  _ownerAccMutationSeq += 1;
  _setOwnerAccStatus('⏳ جاري الحفظ...', 'saving');

  try {
    const created = await OwnersModule.createOwnerAccountDetail(_currentUsername(), {
      owner_id: Number(targetOwnerId),
      leh_amount: null,
      alayh_amount: null,
      notes: null,
    });
    _ownerAccMutationSeq += 1;

    if (String(_selectedClient?.id) !== targetOwnerId) {
      return null;
    }

    if (created && created.id !== undefined && created.id !== null) {
      const exists = _ownerAccountDetailRows.some((r) => String(r.id) === String(created.id));
      if (!exists) {
        _ownerAccountDetailRows.push({ ...created });
      }
      _refreshOwnerAccountTableBody();
      _setOwnerAccStatus('✓ تم الحفظ', 'saved');

      const lehInput = document.getElementById(`ownerAccLeh_${created.id}`);
      if (lehInput && typeof lehInput.focus === 'function') {
        lehInput.focus();
      }
    }
    return created;
  } catch (err) {
    if (String(_selectedClient?.id) === targetOwnerId) {
      _setOwnerAccStatus(`❌ فشل إضافة الصف: ${err.message || 'خطأ في الخادم'}`, 'error');
    }
    return null;
  } finally {
    _ownerAccPendingSaves = Math.max(0, _ownerAccPendingSaves - 1);
  }
}

async function _handleDeleteOwnerAccountRow(rowId) {
  if (!_selectedClient || !_selectedClient.id) return false;
  const rowKey = String(rowId || '').trim();
  if (!rowKey) return false;

  const row = _ownerAccountDetailRows.find((r) => String(r.id) === rowKey);
  if (!row) return false;

  if (_ownerAccDeletingRowIds.has(rowKey)) {
    return false;
  }

  if (_isOwnerAccountRowBusy(rowKey)) {
    _setOwnerAccStatus('❌ لا يمكن حذف الصف أثناء تعديله أو حفظه', 'error');
    return false;
  }

  const rowDateLabel = row.entry_date ? ` (${row.entry_date})` : '';
  const confirmFn =
    typeof window !== 'undefined' && typeof window.confirm === 'function'
      ? window.confirm
      : confirm;
  if (!confirmFn(`هل تريد حذف هذا الصف من تفاصيل الحساب${rowDateLabel}؟`)) {
    return false;
  }

  if (_ownerAccDeletingRowIds.has(rowKey) || _isOwnerAccountRowBusy(rowKey)) {
    return false;
  }

  const targetOwnerId = String(_selectedClient.id);
  _ownerAccDeletingRowIds.add(rowKey);
  _ownerAccPendingSaves += 1;
  _ownerAccMutationSeq += 1;
  const deleteBtn = document.getElementById(`ownerAccDelete_${rowKey}`);
  if (deleteBtn) deleteBtn.disabled = true;
  _setOwnerAccStatus('⏳ جاري حذف الصف...', 'saving');

  try {
    await OwnersModule.deleteOwnerAccountDetail(_currentUsername(), Number(rowKey));
    _ownerAccMutationSeq += 1;

    if (String(_selectedClient?.id) !== targetOwnerId) {
      return false;
    }

    _ownerAccountDetailRows = _ownerAccountDetailRows.filter((r) => String(r.id) !== rowKey);
    _ownerAccUnsavedDrafts.delete(`${rowKey}:leh_amount`);
    _ownerAccUnsavedDrafts.delete(`${rowKey}:alayh_amount`);
    _ownerAccUnsavedDrafts.delete(`${rowKey}:notes`);
    _ownerAccInFlightValues.delete(`${rowKey}:leh_amount`);
    _ownerAccInFlightValues.delete(`${rowKey}:alayh_amount`);
    _ownerAccInFlightValues.delete(`${rowKey}:notes`);
    if (
      _ownerAccActiveInputId === `ownerAccLeh_${rowKey}` ||
      _ownerAccActiveInputId === `ownerAccAlayh_${rowKey}` ||
      _ownerAccActiveInputId === `ownerAccNotes_${rowKey}`
    ) {
      _ownerAccActiveInputId = null;
    }

    _refreshOwnerAccountTableBody();
    _setOwnerAccStatus('✓ تم حذف الصف', 'saved');
    return true;
  } catch (err) {
    if (deleteBtn) deleteBtn.disabled = false;
    if (String(_selectedClient?.id) === targetOwnerId) {
      _setOwnerAccStatus(`❌ فشل حذف الصف: ${err.message || 'خطأ في الخادم'}`, 'error');
    }
    return false;
  } finally {
    _ownerAccDeletingRowIds.delete(rowKey);
    _ownerAccPendingSaves = Math.max(0, _ownerAccPendingSaves - 1);
  }
}

function _printOwnerAccountDetails() {
  if (!_selectedClient) return;
  const filteredRows = _getFilteredOwnerAccountRows();

  const ownerName = _escHtml(_selectedClient.name || '');
  const tableRowsHtml = filteredRows.length
    ? filteredRows.map((r) => `
      <tr>
        <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:center;">${_escHtml(_formatOwnerAccNumericDisplay(r.leh_amount))}</td>
        <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:center;">${_escHtml(_formatOwnerAccNumericDisplay(r.alayh_amount))}</td>
        <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:right;">${_escHtml(r.notes ?? '')}</td>
        <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:center;">${_escHtml(r.entry_date ?? '')}</td>
        <td style="border:1px solid #d1d5db;padding:8px 12px;text-align:center;">${_escHtml(r.entry_time ?? '')}</td>
      </tr>
    `).join('')
    : `
      <tr>
        <td colspan="5" style="border:1px solid #d1d5db;padding:12px;text-align:center;">لا توجد سجلات مطابقة</td>
      </tr>
    `;

  const html = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <title>تفاصيل الحساب — ${ownerName}</title>
  <style>
    @import url('cairo-font.css');
    body { font-family: 'Cairo', Arial, sans-serif; direction: rtl; margin: 0; padding: 20px; }
    h2 { text-align: center; color: #1f2937; margin-bottom: 16px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #1e3a8a; color: #fff; padding: 10px 12px; text-align: center; border: 1px solid #1e3a8a; font-size: 0.875rem; }
    td { font-size: 0.875rem; }
    @page { size: A4 portrait; margin: 15mm; }
  </style>
</head>
<body>
  <h2>تفاصيل الحساب — ${ownerName}</h2>
  <table>
    <thead>
      <tr>
        <th>له</th>
        <th>عليه</th>
        <th>ملاحظات</th>
        <th>التاريخ</th>
        <th>الوقت</th>
      </tr>
    </thead>
    <tbody>${tableRowsHtml}</tbody>
  </table>
</body>
</html>`;

  printHTML(html, { id: 'owner-account-details-print-iframe' });
}

function _normalizeOwnerDetailsTab(tabName) {
  if (tabName === 'vehicles') return 'vehicles';
  if (tabName === 'account-details') return 'account-details';
  return 'movements';
}

function _switchOwnerDetailsTab(tabName) {
  const nextTab = _normalizeOwnerDetailsTab(tabName);
  _activeOwnerDetailsTab = nextTab;

  const page = document.getElementById('ownerDetailsPage');
  if (!page) return;

  const tabBtns = page.querySelectorAll('[data-owner-tab]');
  tabBtns.forEach((btn) => {
    const isMatch = btn.getAttribute('data-owner-tab') === nextTab;
    btn.classList.toggle('is-active', isMatch);
    btn.setAttribute('aria-selected', isMatch ? 'true' : 'false');
    btn.setAttribute('tabindex', isMatch ? '0' : '-1');
  });

  const explicitTabButtons = [
    ['movements', 'ownerTabBtnMovements'],
    ['vehicles', 'ownerTabBtnVehicles'],
    ['account-details', 'ownerTabBtnAccountDetails'],
  ];
  for (const [key, btnId] of explicitTabButtons) {
    const btn = document.getElementById(btnId);
    if (!btn) continue;
    const isMatch = key === nextTab;
    btn.classList?.toggle('is-active', isMatch);
    btn.setAttribute?.('aria-selected', isMatch ? 'true' : 'false');
    btn.setAttribute?.('tabindex', isMatch ? '0' : '-1');
  }

  const panels = page.querySelectorAll('[data-owner-tab-panel]');
  panels.forEach((panel) => {
    const isMatch = panel.getAttribute('data-owner-tab-panel') === nextTab;
    panel.classList.toggle('is-active', isMatch);
    panel.classList.toggle('hidden', !isMatch);
  });

  const explicitPanels = [
    ['movements', 'ownerTabPanelMovements'],
    ['vehicles', 'ownerTabPanelVehicles'],
    ['account-details', 'ownerTabPanelAccountDetails'],
  ];
  for (const [key, panelId] of explicitPanels) {
    const panel = document.getElementById(panelId);
    if (!panel) continue;
    const isMatch = key === nextTab;
    panel.classList?.toggle('is-active', isMatch);
    panel.classList?.toggle('hidden', !isMatch);
  }
}

async function showOwnerDetails(id, type = 'owner', options = {}) {
  const isPassive = options?.passive === true;
  if (isPassive && _shouldDeferOwnerAccRedraw()) {
    return;
  }

  const isSwitchingOwner = String(_lastOwnerDetailsClientId) !== String(id);
  if (!isPassive) {
    _ownerAccStatusText = '';
    _ownerAccStatusKind = '';
    _ownerAccActiveInputId = null;
    _ownerAccPendingSaves = 0;
    _ownerAccUnsavedDrafts.clear();
    _ownerAccInFlightValues.clear();
    _ownerAccDeletingRowIds.clear();
    if (isSwitchingOwner) {
      _activeOwnerDetailsTab = 'movements';
      _resetOwnerAccTabState();
    }
  }

  const loadSeq = ++_ownerDetailsLoadSeq;
  const client = await _getClient(type, id, options);
  if (!client) return;
  if (loadSeq !== _ownerDetailsLoadSeq) return;

  if (String(_lastOwnerDetailsClientId) !== String(client.id)) {
    _activeOwnerDetailsTab = 'movements';
    _lastOwnerDetailsClientId = String(client.id);
    _resetOwnerAccTabState();
  }
  _selectedClient = client;

  sessionStorage.setItem(LAST_PAGE_CTX_KEY, JSON.stringify({
    page: 'ownerDetailsPage',
    ownerId: String(id),
    ownerType: type,
  }));

  const [balance, ledger, owned, accountDetails] = await Promise.all([
    OwnersModule.getClientBalance(client.id, client.type, options),
    OwnersModule.getClientLedger(client.id, client.type, options),
    OwnersModule.getOwnerVehicles(client.id, options),
    OwnersModule.getOwnerAccountDetails(client.id, options),
  ]);

  if (loadSeq !== _ownerDetailsLoadSeq || String(_selectedClient?.id) !== String(client.id)) {
    return;
  }
  if (isPassive && _shouldDeferOwnerAccRedraw()) {
    return;
  }

  const dedupedAccountDetails = _dedupOwnerAccountRows(accountDetails);
  const ledgerHtml = await _renderLedger(client, ledger);
  const relatedHtml = await _renderOwnerVehicles(client, owned);
  const accountDetailsHtml = _renderOwnerAccountDetails(client, dedupedAccountDetails);
  const activeTab = _normalizeOwnerDetailsTab(_activeOwnerDetailsTab);
  const phoneText = String(client.phone || '').trim();

  const page = document.getElementById('ownerDetailsPage');
  if (!page) return;

  page.innerHTML = `
    <div class="ent-details-page">
      <div class="ent-details-header">
        <div class="ent-details-header__top">
          <button type="button" data-action="back-to-customers" class="ent-btn-back">← رجوع</button>
          <div class="ent-details-identity">
            <h2 class="ent-details-name">${client.name}</h2>
            <div class="ent-details-badges">
              <span class="ent-details-type">صاحب مركبة</span>
              ${phoneText ? `<span class="ent-details-meta-item" dir="ltr">📞 ${phoneText}</span>` : ''}
            </div>
          </div>
        </div>

        <div class="stat-grid ent-details-balance-grid">
          <div class="card ent-details-balance-card">
            <div class="ent-details-balance-info">
              <p class="ent-details-balance-label text-muted text-xs mb-2">الرصيد الحالي</p>
              <div class="ent-details-balance-value text-3xl font-bold ${_balanceClass(balance.balance)}">${_fmt(balance.balance)}</div>
            </div>
            <div class="ent-details-balance-actions flex gap-2 flex-wrap justify-end">
              <button type="button" data-action="open-balance-entry" data-entry-type="deposit"
                class="btn btn-success btn-sm ent-balance-btn ent-balance-btn--deposit">
                إيداع رصيد
              </button>
              <button type="button" data-action="open-balance-entry" data-entry-type="withdraw"
                class="btn btn-danger btn-sm ent-balance-btn ent-balance-btn--withdraw">
                سحب رصيد
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="ent-details-tabs-wrap">
        <div class="ent-details-tabs" role="tablist" aria-label="أقسام حساب صاحب المركبة">
          <button
            type="button"
            id="ownerTabBtnMovements"
            role="tab"
            data-action="owner-details-tab"
            data-owner-tab="movements"
            aria-selected="${activeTab === 'movements' ? 'true' : 'false'}"
            aria-controls="ownerTabPanelMovements"
            tabindex="${activeTab === 'movements' ? '0' : '-1'}"
            class="ent-details-tab ${activeTab === 'movements' ? 'is-active' : ''}"
          >
            <span class="ent-details-tab__label">الحركات</span>
            <span class="ent-details-tab__count">${ledger.length}</span>
          </button>
          <button
            type="button"
            id="ownerTabBtnVehicles"
            role="tab"
            data-action="owner-details-tab"
            data-owner-tab="vehicles"
            aria-selected="${activeTab === 'vehicles' ? 'true' : 'false'}"
            aria-controls="ownerTabPanelVehicles"
            tabindex="${activeTab === 'vehicles' ? '0' : '-1'}"
            class="ent-details-tab ${activeTab === 'vehicles' ? 'is-active' : ''}"
          >
            <span class="ent-details-tab__label">المركبات والسائقين</span>
            <span class="ent-details-tab__count">${owned.length}</span>
          </button>
          <button
            type="button"
            id="ownerTabBtnAccountDetails"
            role="tab"
            data-action="owner-details-tab"
            data-owner-tab="account-details"
            aria-selected="${activeTab === 'account-details' ? 'true' : 'false'}"
            aria-controls="ownerTabPanelAccountDetails"
            tabindex="${activeTab === 'account-details' ? '0' : '-1'}"
            class="ent-details-tab ${activeTab === 'account-details' ? 'is-active' : ''}"
          >
            <span class="ent-details-tab__label">تفاصيل الحساب</span>
            <span id="ownerTabCountAccountDetails" class="ent-details-tab__count">${dedupedAccountDetails.length}</span>
          </button>
        </div>
      </div>

      <div
        id="ownerTabPanelMovements"
        role="tabpanel"
        aria-labelledby="ownerTabBtnMovements"
        data-owner-tab-panel="movements"
        class="ent-details-tab-panel ${activeTab === 'movements' ? 'is-active' : 'hidden'}"
      >
        ${ledgerHtml}
      </div>

      <div
        id="ownerTabPanelVehicles"
        role="tabpanel"
        aria-labelledby="ownerTabBtnVehicles"
        data-owner-tab-panel="vehicles"
        class="ent-details-tab-panel ${activeTab === 'vehicles' ? 'is-active' : 'hidden'}"
      >
        ${relatedHtml}
      </div>

      <div
        id="ownerTabPanelAccountDetails"
        role="tabpanel"
        aria-labelledby="ownerTabBtnAccountDetails"
        data-owner-tab-panel="account-details"
        class="ent-details-tab-panel ${activeTab === 'account-details' ? 'is-active' : 'hidden'}"
      >
        ${accountDetailsHtml}
      </div>

      <div id="balanceEntryModal" class="modal-overlay hidden">
        <div class="modal">
          <div class="modal-body">
            <div class="flex items-center justify-between mb-6">
              <button type="button" data-action="close-balance-entry" class="btn btn-secondary btn-sm">إغلاق</button>
              <h3 id="balanceEntryTitle" class="text-lg font-bold mb-0">إيداع رصيد</h3>
            </div>

            <div class="grid gap-4">
              <div class="form-group mb-0">
                <label class="label mb-2" for="balanceEntryDate">التاريخ</label>
                <input id="balanceEntryDate" type="date" class="input input-sm">
              </div>
              <div class="form-group mb-0">
                <label class="label mb-2" for="balanceEntryAmount">المبلغ</label>
                <input id="balanceEntryAmount" type="number" min="0" step="0.01" class="input input-sm" placeholder="0.00">
              </div>
              <div class="form-group mb-0">
                <label class="label mb-2" for="balanceEntryNote">ملاحظة</label>
                <input id="balanceEntryNote" type="text" class="input input-sm" placeholder="اختياري">
              </div>
              <button type="button" data-action="save-balance-entry" class="btn btn-primary btn-full mt-4">
                حفظ الحركة
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  _bindOwnerAccountDetailsControls();

  if (typeof window.showPage === 'function') {
    await window.showPage('ownerDetailsPage');
  }
}

function _openBalanceEntryModal(type) {
  if (!_selectedClient) return;
  _balanceActionType = type === 'withdraw' ? 'withdraw' : 'deposit';

  const modal = document.getElementById('balanceEntryModal');
  const title = document.getElementById('balanceEntryTitle');
  const dateEl = document.getElementById('balanceEntryDate');
  const amountEl = document.getElementById('balanceEntryAmount');
  const noteEl = document.getElementById('balanceEntryNote');

  if (title) title.textContent = _balanceActionType === 'deposit' ? 'إيداع رصيد' : 'سحب رصيد';
  if (dateEl) dateEl.value = DateUtils.todayLocal();
  if (amountEl) amountEl.value = '';
  if (noteEl) noteEl.value = '';
  modal?.classList.remove('hidden');
}

function _closeBalanceEntryModal() {
  document.getElementById('balanceEntryModal')?.classList.add('hidden');
}

async function _saveBalanceEntry() {
  if (!_selectedClient) return;

  const date = document.getElementById('balanceEntryDate')?.value;
  const amount = parseFloat(document.getElementById('balanceEntryAmount')?.value) || 0;
  const note = document.getElementById('balanceEntryNote')?.value || '';

  if (!date) {
    alert('التاريخ مطلوب');
    return;
  }
  if (amount <= 0) {
    alert('المبلغ يجب أن يكون أكبر من صفر');
    return;
  }

  await OwnersModule.createClientBalanceEntry(_currentUsername(), {
    client_id: _selectedClient.id,
    client_type: _selectedClient.type,
    client_name: _selectedClient.name,
    type: _balanceActionType,
    amount,
    date,
    note,
  });

  _closeBalanceEntryModal();
  _activeOwnerDetailsTab = 'movements';
  await showOwnerDetails(_selectedClient.id, _selectedClient.type);
  loadOwners(); // non-blocking background refresh
}

// ─── EXCEL HANDLERS ───────────────────────────────────────────────────────────

/**
 * Reads all active vehicle owners and exports them to an Excel file.
 */
async function _handleExportOwnersExcel() {
  try {
    const allOwners = await ClientRepository.getAllOwners();
    const owners = allOwners
      .filter(o => o.deleted_at === null && o.name && o.owner_type !== 'broker')
      .map(o => ({
        name:  String(o.name  || '').trim(),
        phone: String(o.phone || '').trim(),
      }))
      .filter(o => o.name);

    if (owners.length === 0) {
      alert('لا توجد أسماء للتصدير.');
      return;
    }

    ExcelService.exportEntitiesExcel({ owners });
  } catch (err) {
    console.error('[entities] Excel export entities failed:', err);
    alert(err.message || '❌ فشل تصدير Excel');
  }
}

/**
 * Opens a file picker, parses vehicle owners from the Excel file, and
 * writes them into the vehicleOwners store. Duplicates are skipped.
 */
function _handleImportOwnersExcel() {
  ExcelService.openFilePicker(async (file) => {
    try {
      const username = _currentUsername();
      const { owners } = await ExcelService.importEntitiesExcel(file);

      let ownersAdded = 0, ownersSkipped = 0;
      const errors = [];

      // ── Owners → vehicleOwners store ──────────────────────────────────
      for (const { name, phone } of owners) {
        try {
          await createOwner(username, { name, phone });
          ownersAdded++;
        } catch (err) {
          if (String(err.message || '').includes('مستخدم بالفعل')) {
            ownersSkipped++;
          } else {
            errors.push(`صاحب مركبة "${name}": ${err.message}`);
          }
        }
      }

      await loadOwners();
      if (ownersAdded > 0) window.dispatchEvent(new CustomEvent('owners:changed'));

      const parts = [];
      if (ownersAdded   > 0) parts.push(`✅ تم إضافة ${ownersAdded} صاحب مركبة`);
      if (ownersSkipped > 0) parts.push(`⏭️ تم تخطي ${ownersSkipped} صاحب مركبة موجود مسبقاً`);
      if (errors.length > 0) parts.push(`❌ أخطاء: ${errors.join('، ')}`);

      alert(parts.join('\n') || 'لم يتم إضافة أي اسم.');
    } catch (err) {
      console.error('[entities] Excel import entities failed:', err);
      alert(err.message || '❌ فشل استيراد Excel');
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function attachOwnersPageListeners() {
  const session = AuthModule.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return;
  }

  if (document.body.dataset.customerStatementBound) return;
  document.body.dataset.customerStatementBound = '1';

  document.addEventListener('click', async (e) => {
    // ── Add owner button ──
    const addTypeBtn = e.target.closest('[data-action="add-owner-type"]');
    if (addTypeBtn) {
      _openAddModal('صاحب مركبة', 'owner');
      return;
    }

    // ── Add modal: close, add-row, remove-row, save ──
    if (e.target.closest('[data-action="close-add-modal"]')) {
      document.getElementById('ownerAddModal')?.classList.add('hidden');
      return;
    }
    if (e.target.closest('[data-action="add-modal-add-row"]')) {
      document.getElementById('addModalRows')?.insertAdjacentHTML('beforeend',
        '<tr><td><input type="text" class="input input-sm add-m-name" placeholder="الاسم"></td><td><input type="text" class="input input-sm add-m-phone" placeholder="رقم الهاتف"></td><td><button type="button" data-action="add-modal-remove-row" class="btn-icon" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button></td></tr>');
      return;
    }
    if (e.target.closest('[data-action="add-modal-remove-row"]')) {
      const tr = e.target.closest('tr');
      const tbody = document.getElementById('addModalRows');
      if (tbody && tbody.querySelectorAll('tr').length > 1) tr?.remove();
      return;
    }
    if (e.target.closest('[data-action="save-add-modal"]')) {
      await _saveFromAddModal();
      return;
    }

    // ── Print all ──
    if (e.target.closest('[data-action="print-owners"]')) {
      _printEntities('all');
      return;
    }

    // ── Export owners to Excel ──
    if (e.target.closest('[data-action="export-owners-excel"]')) {
      await _handleExportOwnersExcel();
      return;
    }

    // ── Import owners from Excel ──
    if (e.target.closest('[data-action="import-owners-excel"]')) {
      _handleImportOwnersExcel();
      return;
    }

    const viewBtn = e.target.closest('[data-action="view-client"]');
    if (viewBtn) {
      await showOwnerDetails(viewBtn.dataset.id, 'owner');
      return;
    }

    const editAccBtn = e.target.closest('[data-action="edit-account"]');
    if (editAccBtn) {
      const id = editAccBtn.dataset.id;
      const owner = await OwnersModule.getOwnerById(id);
      const currentName = owner?.name || '';
      const currentPhone = owner?.phone || '';
      _openEditModal(id, 'owner', currentName, currentPhone);
      return;
    }

    const delAccBtn = e.target.closest('[data-action="delete-account"]');
    if (delAccBtn) {
      if (!confirm('هل تريد حذف هذا الحساب؟')) return;
      const id = delAccBtn.dataset.id;
      const delRow = delAccBtn.closest('tr');
      if (delRow) delRow.remove();
      try {
        await OwnersModule.deleteOwner(_currentUsername(), id);
        _invalidateKartaCounts();
        loadOwners(); // background refresh (non-blocking)
      } catch (err) { alert(err.message); loadOwners(); }
      return;
    }

    const balanceBtn = e.target.closest('[data-action="open-balance-entry"]');
    if (balanceBtn) {
      _openBalanceEntryModal(balanceBtn.dataset.entryType);
      return;
    }

    if (e.target.closest('[data-action="close-balance-entry"]')) {
      _closeBalanceEntryModal();
      return;
    }

    if (e.target.closest('[data-action="save-balance-entry"]')) {
      try {
        await _saveBalanceEntry();
      } catch (err) {
        alert(err.message || 'حدث خطأ أثناء حفظ حركة الرصيد');
      }
      return;
    }

    // ── Vehicle management ──
    const addVehicleBtn = e.target.closest('[data-action="add-vehicle-manual"]');
    if (addVehicleBtn) {
      _openVehicleModal('إضافة مركبة', '', '', addVehicleBtn.dataset.ownerId, null);
      return;
    }

    const editVehicleBtn = e.target.closest('[data-action="edit-vehicle"]');
    if (editVehicleBtn) {
      const vehicleId = editVehicleBtn.dataset.vehicleId;
      const vehicle = await ClientRepository.getVehicleById(vehicleId);
      if (!vehicle) return;
      _openVehicleModal('تعديل مركبة', vehicle.plate || '', vehicle.driver_name || '', vehicle.owner_id, vehicleId);
      return;
    }

    if (e.target.closest('[data-action="vehicle-modal-close"]')) {
      document.getElementById('vehicleModal')?.classList.add('hidden');
      _vehicleEditId = null;
      _vehicleOwnerId = null;
      return;
    }

    if (e.target.closest('[data-action="vehicle-modal-save"]')) {
      const plate = (document.getElementById('vehicleModalPlate')?.value || '').trim();
      const driverName = (document.getElementById('vehicleModalDriver')?.value || '').trim();
      const msg = document.getElementById('vehicleModalMsg');
      if (!plate) {
        if (msg) { msg.textContent = '❌ رقم المركبة مطلوب'; msg.classList.add('is-visible'); }
        return;
      }
      try {
        if (_vehicleEditId) {
          // Edit existing
          const patch = { plate };
          patch.driver_name = driverName || null;
          await ClientRepository.updateVehicle(_vehicleEditId, patch, { username: _currentUsername() });
        } else {
          // Add new
          const owner = _vehicleOwnerId ? await OwnersModule.getOwnerById(_vehicleOwnerId) : null;
          if (!owner) { if (msg) { msg.textContent = '❌ صاحب المركبة غير موجود'; msg.classList.add('is-visible'); } return; }
          await VehiclesModule.resolveVehicle(_currentUsername(), plate, owner);
          if (driverName) {
            const vehicles = await ClientRepository.getVehiclesByPlate(plate);
            if (vehicles[0]) {
              await ClientRepository.updateVehicle(vehicles[0].id, { driver_name: driverName }, { username: _currentUsername() });
            }
          }
        }
        document.getElementById('vehicleModal')?.classList.add('hidden');
        _vehicleEditId = null;
        _vehicleOwnerId = null;
        if (_selectedClient) await showOwnerDetails(_selectedClient.id, _selectedClient.type);
      } catch (err) {
        if (msg) { msg.textContent = err.message || '❌ حدث خطأ'; msg.classList.add('is-visible'); }
      }
      return;
    }

    const deleteVehicleBtn = e.target.closest('[data-action="delete-vehicle"]');
    if (deleteVehicleBtn) {
      if (!confirm('هل تريد حذف هذه المركبة؟')) return;
      try {
        await ClientRepository.deleteVehicle(deleteVehicleBtn.dataset.vehicleId, { username: _currentUsername() });
        if (_selectedClient) await showOwnerDetails(_selectedClient.id, _selectedClient.type);
      } catch (err) { alert(err.message); }
      return;
    }

    if (e.target.closest('[data-action="back-to-customers"]') || e.target.closest('[data-action="back-to-accounts"]')) {
      _lastOwnerDetailsClientId = null;
      _activeOwnerDetailsTab = 'movements';
      _resetOwnerAccTabState();
      if (typeof window.showPage === 'function') {
        await window.showPage('ownersPage');
      }
      return;
    }

    const ownerTabBtn = e.target.closest('[data-action="owner-details-tab"]');
    if (ownerTabBtn) {
      _switchOwnerDetailsTab(ownerTabBtn.dataset.ownerTab);
      return;
    }

    if (e.target.closest('[data-action="owner-acc-add-row"]')) {
      await _handleAddOwnerAccountRow();
      return;
    }

    const deleteAccRowBtn = e.target.closest('[data-action="owner-acc-delete-row"]');
    if (deleteAccRowBtn) {
      const rowId =
        deleteAccRowBtn.dataset?.rowId ||
        deleteAccRowBtn.getAttribute?.('data-row-id');
      await _handleDeleteOwnerAccountRow(rowId);
      return;
    }

    if (e.target.closest('[data-action="owner-acc-print"]')) {
      _printOwnerAccountDetails();
      return;
    }

    if (e.target.closest('[data-action="owner-acc-apply-filter"]')) {
      const searchEl = document.getElementById('ownerAccSearchInput');
      const fromEl = document.getElementById('ownerAccFromDate');
      const toEl = document.getElementById('ownerAccToDate');
      _ownerAccSearchQuery = searchEl?.value || '';
      _ownerAccFromDate = fromEl?.value || '';
      _ownerAccToDate = toEl?.value || '';
      _refreshOwnerAccountTableBody();
      return;
    }

    if (e.target.closest('[data-action="owner-acc-clear-filter"]')) {
      const searchEl = document.getElementById('ownerAccSearchInput');
      const fromEl = document.getElementById('ownerAccFromDate');
      const toEl = document.getElementById('ownerAccToDate');
      if (searchEl) searchEl.value = '';
      if (fromEl) fromEl.value = '';
      if (toEl) toEl.value = '';
      _ownerAccSearchQuery = '';
      _ownerAccFromDate = '';
      _ownerAccToDate = '';
      _refreshOwnerAccountTableBody();
      return;
    }

    const clientFilterBtn = e.target.closest('[data-action="client-apply-filter"]');
    if (clientFilterBtn) {
      const id = clientFilterBtn.dataset.id;
      const ctype = clientFilterBtn.dataset.type || _selectedClient?.type || 'owner';
      const from = document.getElementById('clientFromDate')?.value || '';
      const to = document.getElementById('clientToDate')?.value || '';
      const body = document.getElementById('clientLedgerBody');
      if (!body) return;
      const ledger = await OwnersModule.getClientLedger(String(id), ctype);
      const filtered = ledger
        .filter(e1 => {
          const d = _dateLabel(e1.date || e1.applied_at);
          if (from && d < from) return false;
          if (to && d > to) return false;
          return true;
        })
        .sort(compareLedgerEntriesChronologicalDesc);
      body.innerHTML = filtered.length ? filtered.map(e1 => `
        <tr>
          <td class="p-2 text-right">${_dateLabel(e1.date || e1.applied_at)}</td>
          <td class="p-2 text-right">${formatLedgerEntryTime(e1)}</td>
          <td class="p-2 text-right font-semibold">${_fmt(e1.amount)}</td>
          <td class="p-2 text-right">${_ledgerNote(e1)}</td>
        </tr>
      `).join('') : `<tr><td colspan="4" class="text-center text-muted p-4">لا توجد حركات</td></tr>`;
      return;
    }

    const clientClearBtn = e.target.closest('[data-action="client-clear-filter"]');
    if (clientClearBtn) {
      const fromEl = document.getElementById('clientFromDate');
      const toEl = document.getElementById('clientToDate');
      if (fromEl) fromEl.value = '';
      if (toEl) toEl.value = '';
      const id = clientClearBtn.dataset.id;
      const ctype = clientClearBtn.dataset.type || _selectedClient?.type || 'owner';
      const body = document.getElementById('clientLedgerBody');
      if (!body) return;
      const rawLedger = await OwnersModule.getClientLedger(String(id), ctype);
      const ledger = rawLedger.slice().sort(compareLedgerEntriesChronologicalDesc);
      body.innerHTML = ledger.length ? ledger.map(e1 => `
        <tr>
          <td class="p-2 text-right">${_dateLabel(e1.date || e1.applied_at)}</td>
          <td class="p-2 text-right">${formatLedgerEntryTime(e1)}</td>
          <td class="p-2 text-right font-semibold">${_fmt(e1.amount)}</td>
          <td class="p-2 text-right">${_ledgerNote(e1)}</td>
        </tr>
      `).join('') : `<tr><td colspan="4" class="text-center text-muted p-4">لا توجد حركات</td></tr>`;
      return;
    }
  });

  document.addEventListener('keydown', (e) => {
    const tabBtn = e.target?.closest?.('[data-action="owner-details-tab"]');
    if (!tabBtn) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tablist = tabBtn.closest('[role="tablist"]');
    if (!tablist) return;
    const tabs = Array.from(tablist.querySelectorAll('[data-action="owner-details-tab"]'));
    if (tabs.length < 2) return;
    e.preventDefault();
    const currentIndex = tabs.indexOf(tabBtn);
    let nextIndex = currentIndex;
    if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = tabs.length - 1;
    } else {
      nextIndex = (currentIndex + 1) % tabs.length;
    }
    const nextBtn = tabs[nextIndex];
    if (nextBtn) {
      _switchOwnerDetailsTab(nextBtn.dataset.ownerTab);
      nextBtn.focus?.();
    }
  });
}

window.addEventListener('owners:changed', (event) => {
  const options = event?.detail?.passive === true ? { passive: true } : {};
  _invalidateKartaCounts();
  const detailsPage = document.getElementById('ownerDetailsPage');
  if (detailsPage && !detailsPage.classList.contains('hidden') && _selectedClient?.type === 'owner') {
    showOwnerDetails(_selectedClient.id, 'owner', options);
  }
  loadOwners(options);
});

window.addEventListener('ownerAccountDetails:changed', async (event) => {
  const detailsPage = document.getElementById('ownerDetailsPage');
  if (!detailsPage || detailsPage.classList.contains('hidden') || !_selectedClient?.id) {
    return;
  }
  if (_shouldDeferOwnerAccRedraw()) {
    return;
  }
  const targetOwnerId = String(_selectedClient.id);
  const mutationSeqAtStart = _ownerAccMutationSeq;
  const options = event?.detail?.passive === true ? { passive: true } : {};
  try {
    const rows = await OwnersModule.getOwnerAccountDetails(targetOwnerId, options);
    if (
      String(_selectedClient?.id) !== targetOwnerId ||
      mutationSeqAtStart !== _ownerAccMutationSeq ||
      _shouldDeferOwnerAccRedraw()
    ) {
      return;
    }
    _ownerAccountDetailRows = _dedupOwnerAccountRows(rows);
    _refreshOwnerAccountTableBody();
  } catch (err) {
    console.warn('[entities] ownerAccountDetails sync refresh failed:', err.message || err);
  }
});

window.addEventListener('receipts:changed', () => {
  _invalidateKartaCounts();
});

window.showOwnerDetails = showOwnerDetails;


// ========================================
// Public API
// ========================================

export {
  VehiclesModule,
  resolveVehicle,
  OwnersModule,
  createOwner,
  getAllOwners,
  updateOwner,
  deleteOwner,
  getOwnerById,
  getClientsByTab,
  getClientByType,
  getClientBalance,
  getClientLedger,
  createClientBalanceEntry,
  getOwnerVehicles,
  getOwnerAccountDetails,
  createOwnerAccountDetail,
  updateOwnerAccountDetail,
  deleteOwnerAccountDetail,
  normalizeOwnerAccountDigits,
  normalizeAndValidateOwnerAccNumber,
  addAccount,
  loadOwners,
  attachOwnersPageListeners,
  showOwnerDetails,
  notifyReceiptStatusChanged,
};
