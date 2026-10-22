/**
 * entities.js — consolidated module
 * Internal structure: Constants → State → Services → Helpers → Rendering → Events → Public API → Boot
 */

import { FinancialService } from './financial.js';
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

async function getAllOwners() {
  return ClientRepository.getAllOwners();
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

async function getOwnerById(id) {
  if (!id) return null;
  const owner = await ClientRepository.getOwnerById(id);
  if (!owner || owner.deleted_at !== null) return null;
  return owner;
}



async function getClientsByTab(_tab) {
  const owners = await ClientRepository.getAllOwners();
  return owners
    .filter(o => o.deleted_at === null && o.owner_type !== 'broker')
    .map(o => ({ id: String(o.id), type: 'owner', name: o.name || '', phone: o.phone || null }))
    .filter(x => x.name);
}

async function getClientByType(_type, id) {
  const owner = await ClientRepository.getOwnerById(String(id));
  if (!owner || owner.deleted_at !== null || owner.owner_type === 'broker') return null;
  return { id: String(owner.id), type: 'owner', name: owner.name || '', phone: owner.phone || null };
}

async function getClientBalance(client_id, client_type) {
  if (!client_type) throw new Error('[OwnersModule:getClientBalance] client_type is required.');
  return FinancialService.getClientBalance(client_id, 'owner');
}

async function getClientLedger(client_id, client_type) {
  if (!client_type) throw new Error('[OwnersModule:getClientLedger] client_type is required.');
  return FinancialService.getClientLedger(client_id, 'owner');
}

async function createClientBalanceEntry(username, payload) {
  return FinancialService.createClientBalanceEntry(username, payload);
}

async function getOwnerVehicles(owner_id) {
  const vehicles = await ClientRepository.getAllVehicles();
  return vehicles.filter(v => String(v.owner_id || '') === String(owner_id));
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
  addAccount,
});

window.OwnersModule = OwnersModule;



// ========================================
// Owners Page — Rendering / Events
// ========================================

let _selectedClient = null;
let _balanceActionType = 'deposit';
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
  if (type === 'OFFICE_DEPOSIT') return 'إيداع شركة';
  if (type === 'OFFICE_WITHDRAW_AUTO') return 'سحب شركة';
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
  if (type === 'OFFICE_DEPOSIT') return note || 'إيداع شركة';
  if (type === 'OFFICE_WITHDRAW_AUTO') return note || 'سحب شركة';
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



async function _clientSnapshot(client) {
  const balance = await OwnersModule.getClientBalance(client.id, client.type);
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

async function _loadKartaCounts() {
  if (_kartaCountsCache) return _kartaCountsCache;
  // If a request is already in flight, reuse it (prevents N parallel duplicates)
  if (_kartaCountsPromise) return _kartaCountsPromise;
  _kartaCountsPromise = (async () => {
    try {
      const res = await ApiClient.get('/stats/client-karta-counts.php');
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

async function _getUnpaidKartaCount(clientId, clientType = 'owner') {
  const counts = await _loadKartaCounts();
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

async function loadOwners() {
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
  const owners = await ClientRepository.getAllOwners();
  const ownerList = owners.filter(o => o.deleted_at === null && o.name && o.owner_type !== 'broker').map(o => ({
    id: String(o.id), type: 'owner', name: o.name || '', phone: o.phone || null
  }));
  const ownerSnaps = await Promise.all(ownerList.map(_clientSnapshot));
  const ownerKartas = await Promise.all(ownerList.map(o => _getUnpaidKartaCount(o.id, 'owner')));

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

async function _getClient(type, id) {
  return OwnersModule.getClientByType(type, id);
}

async function _renderLedger(client) {
  const ledger = await OwnersModule.getClientLedger(client.id, client.type);
  return `
    <section class="mb-8">
      <h3 class="text-lg font-bold mb-4">الحركات</h3>
      <div class="filter-row mb-6 flex-wrap">
        <div class="form-group mb-0">
          <label class="label mb-2 text-muted text-xs" for="clientFromDate">من</label>
          <input id="clientFromDate" type="date" class="input input-sm">
        </div>
        <div class="form-group mb-0">
          <label class="label mb-2 text-muted text-xs" for="clientToDate">إلى</label>
          <input id="clientToDate" type="date" class="input input-sm">
        </div>
        <button type="button" data-action="client-apply-filter" data-id="${client.id}" data-type="${client.type}"
          class="btn btn-primary btn-sm mb-4">
          تطبيق
        </button>
        <button type="button" data-action="client-clear-filter" data-id="${client.id}" data-type="${client.type}"
          class="btn btn-secondary btn-sm mb-4">
          مسح التحديد
        </button>
      </div>
      <div class="table-wrapper">
        <table class="table">
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>المبلغ</th>
              <th>المركبة</th>
              <th>ملاحظة</th>
            </tr>
          </thead>
          <tbody id="clientLedgerBody">
            ${ledger.length ? ledger.map(e => `
              <tr>
                <td>${_dateLabel(e.date || e.applied_at)}</td>
                <td class="font-semibold">${_fmt(e.amount)}</td>
                <td>${e.vehicle_plate || '-'}</td>
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

async function _renderOwnerVehicles(client) {
  const owned = await OwnersModule.getOwnerVehicles(client.id);

  return `
    <section>
      <div class="flex items-center justify-between mb-4">
        <h3 class="text-lg font-bold mb-0">المركبات والسائقين</h3>
        <div class="flex gap-2">
          <button type="button" data-action="add-vehicle-manual" data-owner-id="${client.id}" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:6px 14px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">➕ إضافة مركبة</button>
        </div>
      </div>
      <div class="table-wrapper mb-10">
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

async function showOwnerDetails(id, type = 'owner') {
  const client = await _getClient(type, id);
  if (!client) return;
  _selectedClient = client;

  sessionStorage.setItem(LAST_PAGE_CTX_KEY, JSON.stringify({
    page: 'ownerDetailsPage',
    ownerId: String(id),
    ownerType: type,
  }));

  const balance = await OwnersModule.getClientBalance(client.id, client.type);
  const ledgerHtml = await _renderLedger(client);
  const relatedHtml = await _renderOwnerVehicles(client);

  const page = document.getElementById('ownerDetailsPage');
  if (!page) return;

  page.innerHTML = `
    <div class="ent-details-page">
      <div class="ent-details-header">
        <button type="button" data-action="back-to-customers" class="ent-btn-back">← رجوع</button>
        <h2 class="ent-details-name">${client.name}</h2>
        <span class="ent-details-type">صاحب مركبة</span>
      </div>

      <div class="stat-grid mb-8">
        <div class="card">
          <p class="text-muted text-xs mb-2">الرصيد الحالي</p>
          <div class="text-3xl font-bold ${_balanceClass(balance.balance)} mb-6">${_fmt(balance.balance)}</div>
          <div class="flex gap-2 flex-wrap justify-end">
            <button type="button" data-action="open-balance-entry" data-entry-type="deposit"
              class="btn btn-success btn-sm">
              إيداع رصيد
            </button>
            <button type="button" data-action="open-balance-entry" data-entry-type="withdraw"
              class="btn btn-danger btn-sm">
              سحب رصيد
            </button>
          </div>
        </div>
      </div>

      ${ledgerHtml}
      ${relatedHtml}

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
      if (typeof window.showPage === 'function') {
        await window.showPage('ownersPage');
      }
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
      const filtered = ledger.filter(e1 => {
        const d = _dateLabel(e1.date || e1.applied_at);
        if (from && d < from) return false;
        if (to && d > to) return false;
        return true;
      });
      body.innerHTML = filtered.length ? filtered.map(e1 => `
        <tr>
          <td class="p-2 text-right">${_dateLabel(e1.date || e1.applied_at)}</td>
          <td class="p-2 text-right font-semibold">${_fmt(e1.amount)}</td>
          <td class="p-2 text-right">${e1.vehicle_plate || '-'}</td>
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
      const ledger = await OwnersModule.getClientLedger(String(id), ctype);
      body.innerHTML = ledger.length ? ledger.map(e1 => `
        <tr>
          <td class="p-2 text-right">${_dateLabel(e1.date || e1.applied_at)}</td>
          <td class="p-2 text-right font-semibold">${_fmt(e1.amount)}</td>
          <td class="p-2 text-right">${e1.vehicle_plate || '-'}</td>
          <td class="p-2 text-right">${_ledgerNote(e1)}</td>
        </tr>
      `).join('') : `<tr><td colspan="4" class="text-center text-muted p-4">لا توجد حركات</td></tr>`;
      return;
    }
  });
}

window.addEventListener('owners:changed', () => {
  _invalidateKartaCounts();
  const detailsPage = document.getElementById('ownerDetailsPage');
  if (detailsPage && !detailsPage.classList.contains('hidden') && _selectedClient?.type === 'owner') {
    showOwnerDetails(_selectedClient.id, 'owner');
  }
  loadOwners();
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
  addAccount,
  loadOwners,
  attachOwnersPageListeners,
  showOwnerDetails,
  notifyReceiptStatusChanged,
};
