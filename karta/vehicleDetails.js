/**
 * vehicleDetails.js — صفحة تفاصيل السيارات (Vehicle Details)
 * ─────────────────────────────────────────────────────────────────────────────
 * Standalone module for manually recording and managing vehicle-related
 * movements per vehicle owner.
 *
 * STRICT FINANCIAL ISOLATION:
 *   - Reads ONLY eligible active vehicle owner IDs and names from ClientRepository.
 *   - Stores all movements exclusively in `vehicle_details_movements` via VehicleDetailsRepository.
 *   - NEVER reads or modifies `vehicle_ledger`, `treasury`, `receipts`, `offices`, or balances.
 *   - NEVER dispatches financial events (`receipts:changed`, `treasury:changed`, `offices:changed`, `owners:changed`).
 *   - Uses dedicated event namespace `vehicleDetails:changed`.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { AuthModule } from './auth.js';
import { Money } from './money.js';
import { DateUtils } from './dateUtils.js';
import { printHTML, buildPrintDocument, _escPrint } from './printEngine.js';
import { ClientRepository } from './services/clientRepository.js';
import { VehicleDetailsRepository } from './services/vehicleDetailsRepository.js';

const LAST_PAGE_CTX_KEY = 'karta_v2_last_page_ctx';
const DOMAIN_EVENT_CHANGED = 'vehicleDetails:changed';

// ── Module State ─────────────────────────────────────────────────────────────

let _eligibleOwners = [];
let _ownerListSearchQuery = '';
let _selectedOwner = null;
let _lastSelectedOwnerId = null;
let _activeDetailsTab = 'movements';

let _movementsByOwner = new Map();       // ownerId -> saved movement array
let _draftRowsByOwner = new Map();       // ownerId -> unsaved draft array
let _editingRowIds = new Set();          // Set<string(movementId)>
let _editDraftById = new Map();          // string(movementId) -> { lah, alayh, notes }
let _draftCounter = 0;

let _movementSearchQuery = '';
let _filterFromDate = '';
let _filterToDate = '';
let _listenersBound = false;

// ── Helpers ──────────────────────────────────────────────────────────────────

function _esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function _fmt(amount) {
  return Money.fmt(amount);
}

function _currentUsername() {
  const session = AuthModule.getSession();
  const username = typeof session?.username === 'string' && session.username.trim()
    ? session.username.trim()
    : (typeof window !== 'undefined' && typeof window.__APP_CONTEXT__?.username === 'string'
      ? window.__APP_CONTEXT__.username.trim()
      : '');
  if (!username) {
    throw new Error('Username required');
  }
  return username;
}

function _normalizeDate(value) {
  if (!value) return '';
  return String(value).trim().split('T')[0].split(' ')[0] || '';
}

function _normalizeTime(value) {
  if (!value) return '';
  const raw = String(value).trim();
  const timePart = raw.includes('T') ? raw.split('T')[1] : raw;
  const match = timePart.match(/^(\d{2}:\d{2}(?::\d{2})?)/);
  if (!match) return timePart;
  return match[1].length === 5 ? `${match[1]}:00` : match[1];
}

function _isValidIsoDate(dateStr) {
  if (typeof dateStr !== 'string') return false;
  const m = dateStr.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const dt = new Date(Date.UTC(year, month - 1, day));
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  );
}

function _parseAndValidateAmount(rawValue, fieldLabel) {
  if (rawValue === null || rawValue === undefined) {
    return { ok: true, value: 0 };
  }
  const str = String(rawValue).trim();
  if (str === '') {
    return { ok: true, value: 0 };
  }
  const num = Number(str);
  if (!Number.isFinite(num) || Number.isNaN(num) || num < 0) {
    return {
      ok: false,
      error: `قيمة "${fieldLabel}" يجب أن تكون رقماً صحيحاً أكبر من أو يساوي صفر`,
    };
  }
  return { ok: true, value: Money.round(num) };
}

function _compareMovementsDesc(a, b) {
  const dateA = _normalizeDate(a.movement_date);
  const dateB = _normalizeDate(b.movement_date);
  if (dateA !== dateB) return dateB.localeCompare(dateA);

  const timeA = _normalizeTime(a.movement_time);
  const timeB = _normalizeTime(b.movement_time);
  if (timeA !== timeB) return timeB.localeCompare(timeA);

  return (Number(b.id) || 0) - (Number(a.id) || 0);
}

function _showInlineMessage(text, isError = true) {
  const msgEl = document.getElementById('vdInlineMsg');
  if (!msgEl) return;
  if (!text) {
    msgEl.textContent = '';
    msgEl.classList.remove('is-visible');
    return;
  }
  msgEl.textContent = text;
  msgEl.classList.toggle('field-msg-inline--error', isError);
  msgEl.classList.add('is-visible');
}

function _emitVehicleDetailsChanged(detail = {}) {
  window.dispatchEvent(new CustomEvent(DOMAIN_EVENT_CHANGED, {
    detail: { ...detail, source: detail.source || 'local' },
  }));
}

// ── Owner Retrieval (Read-Only ID + Name Only) ───────────────────────────────

/**
 * Retrieve only active, non-broker vehicle owners with { id, name } only.
 * Zero balance or financial queries.
 */
async function getEligibleVehicleOwners(options = {}) {
  const allOwners = await ClientRepository.getAllOwners(options);
  const seenIds = new Set();
  const eligible = [];

  for (const raw of (Array.isArray(allOwners) ? allOwners : [])) {
    if (!raw || raw.deleted_at !== null && raw.deleted_at !== undefined) continue;
    if (raw.owner_type === 'broker') continue;
    const id = String(raw.id ?? '').trim();
    const name = String(raw.name ?? '').trim();
    if (!id || !name || seenIds.has(id)) continue;
    seenIds.add(id);
    eligible.push({ id, name });
  }

  return eligible;
}

async function getEligibleVehicleOwnerById(ownerId, options = {}) {
  const targetId = String(ownerId ?? '').trim();
  if (!targetId) return null;

  const list = await getEligibleVehicleOwners(options);
  return list.find(o => o.id === targetId) || null;
}

// ── Main Page (#vehicleDetailsPage) Rendering ────────────────────────────────

function _renderMainPageShell() {
  const page = document.getElementById('vehicleDetailsPage');
  if (!page) return;

  page.innerHTML = `
    <div class="ent-top-card">
      <div class="ent-header-row">
        <div>
          <h2 class="ent-page-title">تفاصيل السيارات</h2>
          <p class="text-muted text-sm mb-0">عرض أصحاب المركبات المسجلين وإدارة حركات وتفاصيل السيارات الخاصة بكل صاحب مركبة</p>
        </div>
      </div>

      <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;" class="ent-search-wrap">
        <input
          id="vdOwnerSearchInput"
          type="text"
          class="ent-search-input"
          placeholder="🔍 ابحث عن صاحب مركبة..."
          value="${_esc(_ownerListSearchQuery)}"
          style="flex:1;min-width:200px;"
        >
      </div>
    </div>

    <div class="ent-columns-grid" style="grid-template-columns: 1fr;">
      <div class="ent-column-card">
        <div class="ent-column-header">
          <h3 class="ent-column-title ent-column-title--blue">🚗 أصحاب المركبات</h3>
        </div>
        <div class="table-wrapper ent-column-scroll">
          <table class="table" id="vdOwnersTable">
            <thead style="background:linear-gradient(135deg,#2563eb,#1d4ed8);">
              <tr>
                <th style="color:#fff;">الاسم</th>
              </tr>
            </thead>
            <tbody id="vdOwnersTableBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function _renderOwnersRows() {
  const tbody = document.getElementById('vdOwnersTableBody');
  if (!tbody) return;

  const query = String(_ownerListSearchQuery || '').trim().toLowerCase();
  const filtered = _eligibleOwners.filter(owner => {
    if (!query) return true;
    return owner.name.toLowerCase().includes(query);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td class="text-muted text-center p-6">لا توجد أصحاب مركبات</td></tr>';
    return;
  }

  const activeOwnerId = String(_selectedOwner?.id || _lastSelectedOwnerId || '');
  tbody.innerHTML = filtered.map(owner => {
    const isSelected = activeOwnerId !== '' && activeOwnerId === owner.id;
    return `
      <tr data-owner-id="${_esc(owner.id)}" data-owner-name="${_esc(owner.name.toLowerCase())}" ${isSelected ? 'data-selected="true"' : ''}>
        <td
          data-action="vd-open-owner"
          data-owner-id="${_esc(owner.id)}"
          class="ent-name-cell ent-name-cell--blue"
          style="cursor:pointer;"
        >${_esc(owner.name)}</td>
      </tr>
    `;
  }).join('');
}

async function loadVehicleDetailsOwners(options = {}) {
  const page = document.getElementById('vehicleDetailsPage');
  if (!page) return [];

  if (!document.getElementById('vdOwnersTableBody')) {
    _renderMainPageShell();
  }

  const searchInput = document.getElementById('vdOwnerSearchInput');
  if (searchInput && searchInput.value !== _ownerListSearchQuery) {
    searchInput.value = _ownerListSearchQuery;
  }

  _eligibleOwners = await getEligibleVehicleOwners(options);
  _renderOwnersRows();
  return _eligibleOwners;
}

// ── Movements Filtering & Syncing Draft Inputs ───────────────────────────────

function _getOwnerMovements(ownerId) {
  return _movementsByOwner.get(String(ownerId)) || [];
}

function _getOwnerDrafts(ownerId) {
  const key = String(ownerId);
  if (!_draftRowsByOwner.has(key)) {
    _draftRowsByOwner.set(key, []);
  }
  return _draftRowsByOwner.get(key);
}

function _syncActiveInputsFromDOM() {
  if (!_selectedOwner) return;
  const tbody = document.getElementById('vdMovementsTableBody');
  if (!tbody || typeof tbody.querySelectorAll !== 'function') return;

  const ownerDrafts = _getOwnerDrafts(_selectedOwner.id);
  const rows = tbody.querySelectorAll('tr');
  for (const tr of rows) {
    const draftId = tr.dataset?.draftId || tr.getAttribute?.('data-draft-id');
    if (draftId) {
      const draft = ownerDrafts.find(d => d.draftId === draftId);
      if (draft) {
        const lahEl = tr.querySelector('.vd-input-lah');
        const alayhEl = tr.querySelector('.vd-input-alayh');
        const notesEl = tr.querySelector('.vd-input-notes');
        if (lahEl) draft.lah = lahEl.value;
        if (alayhEl) draft.alayh = alayhEl.value;
        if (notesEl) draft.notes = notesEl.value;
      }
      continue;
    }

    const rowId = tr.dataset?.id || tr.getAttribute?.('data-id');
    if (rowId && _editingRowIds.has(String(rowId))) {
      const editDraft = _editDraftById.get(String(rowId)) || {};
      const lahEl = tr.querySelector('.vd-input-lah');
      const alayhEl = tr.querySelector('.vd-input-alayh');
      const notesEl = tr.querySelector('.vd-input-notes');
      if (lahEl) editDraft.lah = lahEl.value;
      if (alayhEl) editDraft.alayh = alayhEl.value;
      if (notesEl) editDraft.notes = notesEl.value;
      _editDraftById.set(String(rowId), editDraft);
    }
  }
}

function getFilteredMovementsForCurrentOwner() {
  if (!_selectedOwner) return [];
  const all = _getOwnerMovements(_selectedOwner.id).slice().sort(_compareMovementsDesc);
  const q = String(_movementSearchQuery || '').trim().toLowerCase();
  const from = String(_filterFromDate || '').trim();
  const to = String(_filterToDate || '').trim();

  return all.filter(item => {
    const dateStr = _normalizeDate(item.movement_date);
    const timeStr = _normalizeTime(item.movement_time);
    if (from && dateStr < from) return false;
    if (to && dateStr > to) return false;

    if (!q) return true;
    const lahFmt = _fmt(item.lah).toLowerCase();
    const lahRaw = String(item.lah ?? '').toLowerCase();
    const alayhFmt = _fmt(item.alayh).toLowerCase();
    const alayhRaw = String(item.alayh ?? '').toLowerCase();
    const notesStr = String(item.notes ?? '').toLowerCase();

    return (
      dateStr.toLowerCase().includes(q) ||
      timeStr.toLowerCase().includes(q) ||
      lahFmt.includes(q) ||
      lahRaw.includes(q) ||
      alayhFmt.includes(q) ||
      alayhRaw.includes(q) ||
      notesStr.includes(q)
    );
  });
}

// ── Owner Details Page (#vehicleOwnerDetailsPage) Rendering ──────────────────

function _buildDraftRowHtml(draft) {
  const dateStr = _normalizeDate(draft.movement_date);
  const timeStr = _normalizeTime(draft.movement_time);
  return `
    <tr
      data-draft-id="${_esc(draft.draftId)}"
      data-row-mode="draft"
      data-movement-date="${_esc(dateStr)}"
      data-movement-time="${_esc(timeStr)}"
    >
      <td class="vd-cell-date">${_esc(dateStr)}</td>
      <td class="vd-cell-time" dir="ltr">${_esc(timeStr)}</td>
      <td>
        <input
          type="number"
          step="0.01"
          min="0"
          id="vdDraftLah_${_esc(draft.draftId)}"
          class="input input-sm vd-input-lah"
          placeholder="0.00"
          value="${_esc(draft.lah)}"
        >
      </td>
      <td>
        <input
          type="number"
          step="0.01"
          min="0"
          id="vdDraftAlayh_${_esc(draft.draftId)}"
          class="input input-sm vd-input-alayh"
          placeholder="0.00"
          value="${_esc(draft.alayh)}"
        >
      </td>
      <td>
        <input
          type="text"
          id="vdDraftNotes_${_esc(draft.draftId)}"
          class="input input-sm vd-input-notes"
          placeholder="ملاحظات..."
          value="${_esc(draft.notes)}"
        >
      </td>
      <td class="vd-actions-cell">
        <div class="flex gap-2 flex-wrap">
          <button type="button" data-action="vd-save-row" data-draft-id="${_esc(draft.draftId)}" class="btn btn-primary btn-sm">حفظ</button>
          <button type="button" data-action="vd-edit-row" data-draft-id="${_esc(draft.draftId)}" class="btn btn-secondary btn-sm">تعديل</button>
          <button type="button" data-action="vd-delete-row" data-draft-id="${_esc(draft.draftId)}" class="btn btn-danger btn-sm">حذف</button>
        </div>
      </td>
    </tr>
  `;
}

function _buildSavedRowHtml(row) {
  const idStr = String(row.id);
  const dateStr = _normalizeDate(row.movement_date);
  const timeStr = _normalizeTime(row.movement_time);
  const isEditing = _editingRowIds.has(idStr);

  if (isEditing) {
    const draft = _editDraftById.get(idStr) || {
      lah: Money.round(row.lah),
      alayh: Money.round(row.alayh),
      notes: row.notes || '',
    };
    return `
      <tr
        data-id="${_esc(idStr)}"
        data-row-mode="editing"
        data-movement-date="${_esc(dateStr)}"
        data-movement-time="${_esc(timeStr)}"
      >
        <td class="vd-cell-date">${_esc(dateStr)}</td>
        <td class="vd-cell-time" dir="ltr">${_esc(timeStr)}</td>
        <td>
          <input
            type="number"
            step="0.01"
            min="0"
            id="vdEditLah_${_esc(idStr)}"
            class="input input-sm vd-input-lah"
            placeholder="0.00"
            value="${_esc(draft.lah)}"
          >
        </td>
        <td>
          <input
            type="number"
            step="0.01"
            min="0"
            id="vdEditAlayh_${_esc(idStr)}"
            class="input input-sm vd-input-alayh"
            placeholder="0.00"
            value="${_esc(draft.alayh)}"
          >
        </td>
        <td>
          <input
            type="text"
            id="vdEditNotes_${_esc(idStr)}"
            class="input input-sm vd-input-notes"
            placeholder="ملاحظات..."
            value="${_esc(draft.notes)}"
          >
        </td>
        <td class="vd-actions-cell">
          <div class="flex gap-2 flex-wrap">
            <button type="button" data-action="vd-save-row" data-id="${_esc(idStr)}" class="btn btn-primary btn-sm">حفظ</button>
            <button type="button" data-action="vd-edit-row" data-id="${_esc(idStr)}" class="btn btn-secondary btn-sm">تعديل</button>
            <button type="button" data-action="vd-delete-row" data-id="${_esc(idStr)}" class="btn btn-danger btn-sm">حذف</button>
          </div>
        </td>
      </tr>
    `;
  }

  return `
    <tr
      data-id="${_esc(idStr)}"
      data-row-mode="saved"
      data-movement-date="${_esc(dateStr)}"
      data-movement-time="${_esc(timeStr)}"
    >
      <td class="vd-cell-date">${_esc(dateStr)}</td>
      <td class="vd-cell-time" dir="ltr">${_esc(timeStr)}</td>
      <td class="vd-cell-lah font-semibold">${_fmt(row.lah)}</td>
      <td class="vd-cell-alayh font-semibold">${_fmt(row.alayh)}</td>
      <td class="vd-cell-notes">${_esc(row.notes || '—')}</td>
      <td class="vd-actions-cell">
        <div class="flex gap-2 flex-wrap">
          <button type="button" data-action="vd-save-row" data-id="${_esc(idStr)}" class="btn btn-primary btn-sm">حفظ</button>
          <button type="button" data-action="vd-edit-row" data-id="${_esc(idStr)}" class="btn btn-secondary btn-sm">تعديل</button>
          <button type="button" data-action="vd-delete-row" data-id="${_esc(idStr)}" class="btn btn-danger btn-sm">حذف</button>
        </div>
      </td>
    </tr>
  `;
}

function _renderMovementsTableBody() {
  const tbody = document.getElementById('vdMovementsTableBody');
  if (!tbody || !_selectedOwner) return;

  const drafts = _getOwnerDrafts(_selectedOwner.id);
  const filteredSaved = getFilteredMovementsForCurrentOwner();

  const countEl = document.getElementById('vdMovementsCount');
  if (countEl) {
    countEl.textContent = String(filteredSaved.length);
  }

  if (drafts.length === 0 && filteredSaved.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-muted text-center p-4">لا توجد حركات</td>
      </tr>
    `;
    return;
  }

  const draftHtml = drafts.map(_buildDraftRowHtml).join('');
  const savedHtml = filteredSaved.map(_buildSavedRowHtml).join('');
  tbody.innerHTML = draftHtml + savedHtml;
}

function _renderOwnerDetailsShell(owner) {
  const page = document.getElementById('vehicleOwnerDetailsPage');
  if (!page) return;

  const filteredSaved = getFilteredMovementsForCurrentOwner();

  page.innerHTML = `
    <div class="ent-details-page">
      <div class="ent-details-header">
        <div class="ent-details-header__top">
          <button type="button" id="vdBackBtn" data-action="vd-back-to-owners" class="ent-btn-back">← رجوع</button>
          <div class="ent-details-identity">
            <h2 class="ent-details-name" id="vdOwnerDetailsName">${_esc(owner.name)}</h2>
            <div class="ent-details-badges">
              <span class="ent-details-type">تفاصيل السيارات</span>
            </div>
          </div>
        </div>
      </div>

      <div class="ent-details-tabs-wrap">
        <div class="ent-details-tabs" role="tablist" aria-label="أقسام تفاصيل السيارات">
          <button
            type="button"
            id="vdTabBtnMovements"
            role="tab"
            data-action="vd-details-tab"
            data-vd-tab="movements"
            aria-selected="true"
            aria-controls="vdTabPanelMovements"
            tabindex="0"
            class="ent-details-tab is-active"
          >
            <span class="ent-details-tab__label">الحركات</span>
            <span class="ent-details-tab__count" id="vdMovementsCount">${filteredSaved.length}</span>
          </button>
        </div>
      </div>

      <div
        id="vdTabPanelMovements"
        role="tabpanel"
        aria-labelledby="vdTabBtnMovements"
        data-vd-tab-panel="movements"
        class="ent-details-tab-panel is-active"
      >
        <section class="ent-tab-section">
          <div class="ent-section-header flex items-center justify-between flex-wrap gap-3 mb-4">
            <h3 class="ent-section-title text-lg font-bold mb-0">الحركات</h3>
            <div class="flex gap-2 flex-wrap">
              <button type="button" id="vdAddRowBtn" data-action="vd-add-row" class="ent-btn-add">➕ إضافة صف</button>
              <button type="button" id="vdPrintBtn" data-action="vd-print-movements" class="ent-btn-print">🖨️ طباعة</button>
            </div>
          </div>

          <div class="filter-row ent-filter-bar mb-4 flex-wrap">
            <div class="form-group mb-0" style="flex:1;min-width:200px;">
              <label class="label mb-2 text-muted text-xs" for="vdMovementSearchInput">بحث</label>
              <input
                id="vdMovementSearchInput"
                type="text"
                class="input input-sm"
                placeholder="🔍 ابحث في الحركات..."
                value="${_esc(_movementSearchQuery)}"
              >
            </div>
            <div class="form-group mb-0">
              <label class="label mb-2 text-muted text-xs" for="vdFromDate">من</label>
              <input id="vdFromDate" type="date" class="input input-sm" value="${_esc(_filterFromDate)}">
            </div>
            <div class="form-group mb-0">
              <label class="label mb-2 text-muted text-xs" for="vdToDate">إلى</label>
              <input id="vdToDate" type="date" class="input input-sm" value="${_esc(_filterToDate)}">
            </div>
            <div class="ent-filter-actions">
              <button type="button" id="vdApplyFilterBtn" data-action="vd-apply-filter" class="btn btn-primary btn-sm">
                تطبيق
              </button>
              <button type="button" id="vdClearFilterBtn" data-action="vd-clear-filter" class="btn btn-secondary btn-sm">
                مسح التحديد
              </button>
            </div>
          </div>

          <div id="vdInlineMsg" class="field-msg-inline field-msg-inline--error mb-3" role="alert" aria-live="polite"></div>

          <div class="table-wrapper">
            <table class="table" id="vdMovementsTable">
              <thead>
                <tr>
                  <th>التاريخ</th>
                  <th>الوقت</th>
                  <th>له</th>
                  <th>عليه</th>
                  <th>ملاحظات</th>
                  <th>إجراءات</th>
                </tr>
              </thead>
              <tbody id="vdMovementsTableBody"></tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  `;

  _renderMovementsTableBody();
}

async function _loadOwnerMovementsFromServer(ownerId, options = {}) {
  const rows = await VehicleDetailsRepository.getByOwnerId(ownerId, {}, options);
  const normalized = (Array.isArray(rows) ? rows : [])
    .filter(r => r && r.deleted_at === null || r?.deleted_at === undefined)
    .filter(r => String(r.owner_id) === String(ownerId))
    .sort(_compareMovementsDesc);
  _movementsByOwner.set(String(ownerId), normalized);
  return normalized;
}

async function showVehicleOwnerDetails(ownerId, options = {}) {
  const owner = await getEligibleVehicleOwnerById(ownerId, options);
  if (!owner) return null;

  const isDifferentOwner = String(_lastSelectedOwnerId || '') !== owner.id;
  _selectedOwner = owner;
  _lastSelectedOwnerId = owner.id;
  _activeDetailsTab = 'movements';

  if (isDifferentOwner) {
    _movementSearchQuery = '';
    _filterFromDate = '';
    _filterToDate = '';
    _editingRowIds.clear();
    _editDraftById.clear();
  }

  try {
    sessionStorage.setItem(LAST_PAGE_CTX_KEY, JSON.stringify({
      page: 'vehicleOwnerDetailsPage',
      ownerId: owner.id,
    }));
  } catch {
    // Ignore sessionStorage errors in restricted environments
  }

  await _loadOwnerMovementsFromServer(owner.id, options);
  _renderOwnerDetailsShell(owner);

  if (typeof window.showPage === 'function') {
    await window.showPage('vehicleOwnerDetailsPage');
  }
  return owner;
}

// ── Movement CRUD Operations ─────────────────────────────────────────────────

/**
 * Add a new editable movement draft row.
 * Captures Egypt local date and time at the exact moment of button click
 * using DateUtils.nowLocal().
 */
function addMovementDraftRow() {
  if (!_selectedOwner) return null;

  _syncActiveInputsFromDOM();
  _showInlineMessage('');

  const nowLocal = DateUtils.nowLocal(); // "YYYY-MM-DDTHH:mm:ss"
  const [datePart, timePart] = String(nowLocal).split('T');
  const movement_date = _normalizeDate(datePart || DateUtils.todayLocal());
  const movement_time = _normalizeTime(timePart || '00:00:00');

  const draft = {
    draftId: `draft-${++_draftCounter}`,
    owner_id: _selectedOwner.id,
    movement_date,
    movement_time,
    lah: '',
    alayh: '',
    notes: '',
  };

  const drafts = _getOwnerDrafts(_selectedOwner.id);
  drafts.unshift(draft);
  _renderMovementsTableBody();
  return draft;
}

/**
 * Save a new draft row or an existing edited row.
 * Preserves the original captured movement_date and movement_time.
 */
async function saveMovementRow({ draftId = null, id = null, tr = null } = {}) {
  if (!_selectedOwner) return null;
  _syncActiveInputsFromDOM();
  _showInlineMessage('');

  const username = _currentUsername();

  // Case 1: Saving a newly added draft row
  if (draftId) {
    const drafts = _getOwnerDrafts(_selectedOwner.id);
    const idx = drafts.findIndex(d => d.draftId === String(draftId));
    if (idx === -1) return null;
    const draft = drafts[idx];

    const rawLah = tr?.querySelector?.('.vd-input-lah')?.value ?? draft.lah;
    const rawAlayh = tr?.querySelector?.('.vd-input-alayh')?.value ?? draft.alayh;
    const rawNotes = tr?.querySelector?.('.vd-input-notes')?.value ?? draft.notes;

    const lahCheck = _parseAndValidateAmount(rawLah, 'له');
    if (!lahCheck.ok) {
      _showInlineMessage(lahCheck.error, true);
      return null;
    }
    const alayhCheck = _parseAndValidateAmount(rawAlayh, 'عليه');
    if (!alayhCheck.ok) {
      _showInlineMessage(alayhCheck.error, true);
      return null;
    }

    const notesClean = String(rawNotes ?? '').trim() || null;

    // Do NOT regenerate movement_date or movement_time on save!
    const created = await VehicleDetailsRepository.create({
      owner_id: Number(_selectedOwner.id) || _selectedOwner.id,
      movement_date: draft.movement_date,
      movement_time: draft.movement_time,
      lah: lahCheck.value,
      alayh: alayhCheck.value,
      notes: notesClean,
    }, { username });

    drafts.splice(idx, 1);
    await _loadOwnerMovementsFromServer(_selectedOwner.id);
    _renderMovementsTableBody();
    _emitVehicleDetailsChanged({ ownerId: _selectedOwner.id, action: 'create', id: String(created?.id ?? '') });
    return created;
  }

  // Case 2: Saving an existing saved row
  if (id !== null && id !== undefined && String(id) !== '') {
    const idStr = String(id);
    const existingList = _getOwnerMovements(_selectedOwner.id);
    const existingRow = existingList.find(r => String(r.id) === idStr);
    if (!existingRow) {
      _showInlineMessage('السجل غير موجود', true);
      return null;
    }

    const editDraft = _editDraftById.get(idStr);
    const rawLah = tr?.querySelector?.('.vd-input-lah')?.value
      ?? (editDraft ? editDraft.lah : existingRow.lah);
    const rawAlayh = tr?.querySelector?.('.vd-input-alayh')?.value
      ?? (editDraft ? editDraft.alayh : existingRow.alayh);
    const rawNotes = tr?.querySelector?.('.vd-input-notes')?.value
      ?? (editDraft ? editDraft.notes : (existingRow.notes ?? ''));

    const lahCheck = _parseAndValidateAmount(rawLah, 'له');
    if (!lahCheck.ok) {
      _showInlineMessage(lahCheck.error, true);
      return null;
    }
    const alayhCheck = _parseAndValidateAmount(rawAlayh, 'عليه');
    if (!alayhCheck.ok) {
      _showInlineMessage(alayhCheck.error, true);
      return null;
    }

    const notesClean = String(rawNotes ?? '').trim() || null;

    // Only update lah, alayh, notes — original movement_date and movement_time are never modified
    const updated = await VehicleDetailsRepository.update(idStr, {
      owner_id: Number(_selectedOwner.id) || _selectedOwner.id,
      lah: lahCheck.value,
      alayh: alayhCheck.value,
      notes: notesClean,
    }, { username });

    _editingRowIds.delete(idStr);
    _editDraftById.delete(idStr);
    await _loadOwnerMovementsFromServer(_selectedOwner.id);
    _renderMovementsTableBody();
    _emitVehicleDetailsChanged({ ownerId: _selectedOwner.id, action: 'update', id: idStr });
    return updated;
  }

  return null;
}

/**
 * Put a saved movement row into inline edit mode without altering its date or time.
 */
function editMovementRow(id) {
  if (!_selectedOwner || id === null || id === undefined) return false;
  const idStr = String(id);
  _syncActiveInputsFromDOM();
  _showInlineMessage('');

  const existingList = _getOwnerMovements(_selectedOwner.id);
  const existingRow = existingList.find(r => String(r.id) === idStr);
  if (!existingRow) return false;

  _editingRowIds.add(idStr);
  if (!_editDraftById.has(idStr)) {
    _editDraftById.set(idStr, {
      lah: Money.round(existingRow.lah),
      alayh: Money.round(existingRow.alayh),
      notes: existingRow.notes || '',
    });
  }

  _renderMovementsTableBody();
  return true;
}

/**
 * Delete a movement row (unsaved draft or saved movement).
 * Never modifies or deletes the vehicle owner record.
 */
async function deleteMovementRow({ draftId = null, id = null } = {}) {
  if (!_selectedOwner) return false;
  _syncActiveInputsFromDOM();
  _showInlineMessage('');

  if (draftId) {
    const drafts = _getOwnerDrafts(_selectedOwner.id);
    const idx = drafts.findIndex(d => d.draftId === String(draftId));
    if (idx !== -1) {
      drafts.splice(idx, 1);
      _renderMovementsTableBody();
      return true;
    }
    return false;
  }

  if (id !== null && id !== undefined && String(id) !== '') {
    if (typeof window.confirm === 'function' && !window.confirm('هل تريد حذف هذه الحركة؟')) {
      return false;
    }
    const idStr = String(id);
    const username = _currentUsername();
    await VehicleDetailsRepository.delete(idStr, { username });
    _editingRowIds.delete(idStr);
    _editDraftById.delete(idStr);
    await _loadOwnerMovementsFromServer(_selectedOwner.id);
    _renderMovementsTableBody();
    _emitVehicleDetailsChanged({ ownerId: _selectedOwner.id, action: 'delete', id: idStr });
    return true;
  }

  return false;
}

// ── Search & Date-Range Filtering ────────────────────────────────────────────

function applyVehicleDetailsFilter({ search, fromDate, toDate } = {}) {
  _syncActiveInputsFromDOM();
  _showInlineMessage('');

  const searchEl = document.getElementById('vdMovementSearchInput');
  const fromEl = document.getElementById('vdFromDate');
  const toEl = document.getElementById('vdToDate');

  const nextSearch = search !== undefined ? String(search) : String(searchEl?.value ?? _movementSearchQuery);
  const nextFrom = (fromDate !== undefined ? String(fromDate) : String(fromEl?.value ?? _filterFromDate)).trim();
  const nextTo = (toDate !== undefined ? String(toDate) : String(toEl?.value ?? _filterToDate)).trim();

  if (nextFrom && !_isValidIsoDate(nextFrom)) {
    _showInlineMessage('تنسيق تاريخ البداية غير صالح (YYYY-MM-DD)', true);
    return false;
  }
  if (nextTo && !_isValidIsoDate(nextTo)) {
    _showInlineMessage('تنسيق تاريخ النهاية غير صالح (YYYY-MM-DD)', true);
    return false;
  }
  if (nextFrom && nextTo && nextTo < nextFrom) {
    _showInlineMessage('تاريخ النهاية لا يمكن أن يكون أقدم من تاريخ البداية', true);
    return false;
  }

  _movementSearchQuery = nextSearch;
  _filterFromDate = nextFrom;
  _filterToDate = nextTo;

  if (searchEl && searchEl.value !== _movementSearchQuery) searchEl.value = _movementSearchQuery;
  if (fromEl && fromEl.value !== _filterFromDate) fromEl.value = _filterFromDate;
  if (toEl && toEl.value !== _filterToDate) toEl.value = _filterToDate;

  _renderMovementsTableBody();
  return true;
}

function clearVehicleDetailsFilter() {
  _syncActiveInputsFromDOM();
  _showInlineMessage('');

  _movementSearchQuery = '';
  _filterFromDate = '';
  _filterToDate = '';

  const searchEl = document.getElementById('vdMovementSearchInput');
  const fromEl = document.getElementById('vdFromDate');
  const toEl = document.getElementById('vdToDate');
  if (searchEl) searchEl.value = '';
  if (fromEl) fromEl.value = '';
  if (toEl) toEl.value = '';

  _renderMovementsTableBody();
}

// ── Printing (Excludes Actions Column) ───────────────────────────────────────

function buildVehicleOwnerMovementsPrintHTML() {
  if (!_selectedOwner) return '';

  const filtered = getFilteredMovementsForCurrentOwner();
  const ownerName = _escPrint(_selectedOwner.name);
  const from = String(_filterFromDate || '').trim();
  const to = String(_filterToDate || '').trim();

  let rangeLabel = '';
  if (from && to) {
    rangeLabel = `الفترة: من ${_escPrint(from)} إلى ${_escPrint(to)}`;
  } else if (from) {
    rangeLabel = `الفترة: من ${_escPrint(from)}`;
  } else if (to) {
    rangeLabel = `الفترة: حتى ${_escPrint(to)}`;
  }

  const rowsHtml = filtered.length
    ? filtered.map(row => `
        <tr>
          <td style="text-align:center;">${_escPrint(_normalizeDate(row.movement_date))}</td>
          <td style="text-align:center;" dir="ltr">${_escPrint(_normalizeTime(row.movement_time))}</td>
          <td style="text-align:center;font-weight:700;">${_escPrint(_fmt(row.lah))}</td>
          <td style="text-align:center;font-weight:700;">${_escPrint(_fmt(row.alayh))}</td>
          <td style="text-align:right;">${_escPrint(row.notes || '—')}</td>
        </tr>
      `).join('')
    : `
      <tr>
        <td colspan="5" style="text-align:center;padding:12px;">لا توجد حركات</td>
      </tr>
    `;

  const body = `
    <div class="print-header">
      <h2>تفاصيل السيارات — الحركات</h2>
      <div class="print-header-info">
        <div><strong>صاحب المركبة:</strong> ${ownerName}</div>
        ${rangeLabel ? `<div><strong>${rangeLabel}</strong></div>` : ''}
      </div>
    </div>
    <table>
      <thead>
        <tr>
          <th class="print-th">التاريخ</th>
          <th class="print-th">الوقت</th>
          <th class="print-th">له</th>
          <th class="print-th">عليه</th>
          <th class="print-th">ملاحظات</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  `;

  return buildPrintDocument({
    title: `تفاصيل السيارات - ${_selectedOwner.name}`,
    body,
    orientation: 'portrait',
  });
}

function printVehicleOwnerMovements() {
  if (!_selectedOwner) return '';
  const html = buildVehicleOwnerMovementsPrintHTML();
  if (!html) return '';
  printHTML(html, { id: 'vehicle-details-print-iframe' });
  return html;
}

// ── Event Listeners ──────────────────────────────────────────────────────────

function attachVehicleDetailsPageListeners() {
  if (_listenersBound || document.body?.dataset?.vehicleDetailsBound === '1') return;
  _listenersBound = true;
  if (document.body?.dataset) {
    document.body.dataset.vehicleDetailsBound = '1';
  }

  document.addEventListener('click', async (e) => {
    const target = e.target;
    if (!target || typeof target.closest !== 'function') return;

    const openOwnerBtn = target.closest('[data-action="vd-open-owner"]');
    if (openOwnerBtn) {
      const ownerId = openOwnerBtn.dataset?.ownerId || openOwnerBtn.getAttribute?.('data-owner-id');
      if (ownerId) {
        await showVehicleOwnerDetails(ownerId);
      }
      return;
    }

    if (target.closest('[data-action="vd-back-to-owners"]')) {
      if (typeof window.showPage === 'function') {
        await window.showPage('vehicleDetailsPage');
      }
      return;
    }

    const tabBtn = target.closest('[data-action="vd-details-tab"]');
    if (tabBtn) {
      _activeDetailsTab = tabBtn.dataset?.vdTab || 'movements';
      return;
    }

    if (target.closest('[data-action="vd-add-row"]')) {
      addMovementDraftRow();
      return;
    }

    const saveBtn = target.closest('[data-action="vd-save-row"]');
    if (saveBtn) {
      const draftId = saveBtn.dataset?.draftId || saveBtn.getAttribute?.('data-draft-id') || null;
      const id = saveBtn.dataset?.id || saveBtn.getAttribute?.('data-id') || null;
      const tr = saveBtn.closest('tr');
      try {
        await saveMovementRow({ draftId, id, tr });
      } catch (err) {
        _showInlineMessage(err.message || 'حدث خطأ أثناء حفظ الحركة', true);
      }
      return;
    }

    const editBtn = target.closest('[data-action="vd-edit-row"]');
    if (editBtn) {
      const id = editBtn.dataset?.id || editBtn.getAttribute?.('data-id') || null;
      if (id) {
        editMovementRow(id);
      }
      return;
    }

    const deleteBtn = target.closest('[data-action="vd-delete-row"]');
    if (deleteBtn) {
      const draftId = deleteBtn.dataset?.draftId || deleteBtn.getAttribute?.('data-draft-id') || null;
      const id = deleteBtn.dataset?.id || deleteBtn.getAttribute?.('data-id') || null;
      try {
        await deleteMovementRow({ draftId, id });
      } catch (err) {
        _showInlineMessage(err.message || 'حدث خطأ أثناء حذف الحركة', true);
      }
      return;
    }

    if (target.closest('[data-action="vd-apply-filter"]')) {
      applyVehicleDetailsFilter();
      return;
    }

    if (target.closest('[data-action="vd-clear-filter"]')) {
      clearVehicleDetailsFilter();
      return;
    }

    if (target.closest('[data-action="vd-print-movements"]')) {
      printVehicleOwnerMovements();
      return;
    }
  });

  document.addEventListener('input', (e) => {
    const target = e.target;
    if (!target) return;

    if (target.id === 'vdOwnerSearchInput') {
      _ownerListSearchQuery = String(target.value || '');
      _renderOwnersRows();
      return;
    }

    if (target.id === 'vdMovementSearchInput') {
      _syncActiveInputsFromDOM();
      _movementSearchQuery = String(target.value || '');
      _renderMovementsTableBody();
    }
  });
}

// Listen to owners:changed (read-only refresh when owners are added/edited/deleted)
window.addEventListener('owners:changed', async (event) => {
  const options = event?.detail?.passive === true ? { passive: true } : {};
  await loadVehicleDetailsOwners(options);

  const detailsPage = document.getElementById('vehicleOwnerDetailsPage');
  if (detailsPage && !detailsPage.classList.contains('hidden') && _selectedOwner) {
    const updatedOwner = _eligibleOwners.find(o => o.id === String(_selectedOwner.id));
    if (!updatedOwner) {
      _selectedOwner = null;
      if (typeof window.showPage === 'function') {
        await window.showPage('vehicleDetailsPage');
      }
    } else {
      _selectedOwner = updatedOwner;
      const nameEl = document.getElementById('vdOwnerDetailsName');
      if (nameEl) nameEl.textContent = updatedOwner.name;
    }
  }
});

// Listen to vehicleDetails:changed from background sync (passive refresh)
window.addEventListener(DOMAIN_EVENT_CHANGED, async (event) => {
  if (event?.detail?.source !== 'sync') return;
  const options = event?.detail?.passive === true ? { passive: true } : {};
  const detailsPage = document.getElementById('vehicleOwnerDetailsPage');
  if (detailsPage && !detailsPage.classList.contains('hidden') && _selectedOwner) {
    _syncActiveInputsFromDOM();
    await _loadOwnerMovementsFromServer(_selectedOwner.id, options);
    _renderMovementsTableBody();
  }
});

window.showVehicleOwnerDetails = showVehicleOwnerDetails;

const VehicleDetailsModule = Object.freeze({
  getEligibleVehicleOwners,
  getEligibleVehicleOwnerById,
  loadVehicleDetailsOwners,
  showVehicleOwnerDetails,
  addMovementDraftRow,
  saveMovementRow,
  editMovementRow,
  deleteMovementRow,
  applyVehicleDetailsFilter,
  clearVehicleDetailsFilter,
  getFilteredMovementsForCurrentOwner,
  buildVehicleOwnerMovementsPrintHTML,
  printVehicleOwnerMovements,
  attachVehicleDetailsPageListeners,
});

window.VehicleDetailsModule = VehicleDetailsModule;

export {
  VehicleDetailsModule,
  getEligibleVehicleOwners,
  getEligibleVehicleOwnerById,
  loadVehicleDetailsOwners,
  showVehicleOwnerDetails,
  addMovementDraftRow,
  saveMovementRow,
  editMovementRow,
  deleteMovementRow,
  applyVehicleDetailsFilter,
  clearVehicleDetailsFilter,
  getFilteredMovementsForCurrentOwner,
  buildVehicleOwnerMovementsPrintHTML,
  printVehicleOwnerMovements,
  attachVehicleDetailsPageListeners,
};
