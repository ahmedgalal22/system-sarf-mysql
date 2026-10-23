import { ReceiptsModule } from './receipts.js';
import { Money } from './money.js';
import { FinancialService } from './financial.js';
import {
  loadReceiptForEdit,
  renderReceiptSnapshotTableHead,
  renderReceiptSnapshotRowsHtml,
  DATA_COL_COUNT,
} from './receipts.js';
import { printHTML, buildPrintDocument } from './printEngine.js';
import { ExcelService } from './excelService.js';
import { ReceiptRepository } from './services/receiptRepository.js';
import { RECEIPT_PAYOUT_STATUS, getPayoutStatusMeta } from './constants/payoutStatus.js';
import { DateUtils } from './dateUtils.js';
import { MultiSelectFilter } from './components/multiSelectFilter.js';
import { notifyReceiptStatusChanged } from './entities.js';

const PAGE_ID = 'allReceiptsPage';
const SHORT_DATE_FMT = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' });
const TIME_FMT = new Intl.DateTimeFormat('ar-EG', { timeStyle: 'short' });

let _filterDebounceTimer = null;

/**
 * Multi-select filter instances — created ONCE in _initMultiSelectFilters(),
 * updated via setOptions()/setSelected() thereafter. Never recreated.
 */
const _msFilters = {};

/**
 * Filter definitions: key → { label, stateKey, optionsKey, level }
 *
 * level = 'receipt' → server-side filter (WHERE clause in search.php)
 *                     determines which receipt cards are returned
 * level = 'row'     → client-side filter (getDisplayRowsForReceipt)
 *                     determines which rows are shown within each receipt card
 */
const MS_FILTER_DEFS = [
  { key: 'owner',   label: 'العميل',       stateKey: 'owner',   optionsKey: 'client_names',    level: 'receipt', apiParam: 'client_name' },
  { key: 'company', label: 'اسم المكتب',   stateKey: 'company', optionsKey: 'company_names',   level: 'row' },
  { key: 'number',  label: 'إذن الصرف',    stateKey: 'number',  optionsKey: 'receipt_numbers',  level: 'receipt', apiParam: 'receipt_number' },
  { key: 'vehicle', label: 'رقم المركبة',  stateKey: 'vehicle', optionsKey: 'vehicles',         level: 'row' },
  { key: 'karta',   label: 'رقم الكارتة',  stateKey: 'karta',   optionsKey: 'kartas',           level: 'row' },
  { key: 'type',    label: 'النوع',        stateKey: 'type',    optionsKey: 'types',            level: 'row' },
];

const STATE = {
  tab: 'receipts',
  ready: false,
  loading: false,
  receipts: [],
  meta: null,       // server response meta (total, summary, options)
  options: null,     // cached meta.options for multi-select popups (Phase 4)
  filters: {
    receipts: createReceiptFilterState(),
  },
};

function createReceiptFilterState() {
  const range = getLast30DaysRange();
  return {
    owner: [],       // string[] — multi-select values (Phase 4)
    company: [],     // string[] — multi-select values (Phase 4)
    number: [],      // string[] — multi-select values (Phase 4)
    vehicle: [],     // string[] — multi-select values (Phase 4)
    karta: [],       // string[] — multi-select values (Phase 4)
    type: [],        // string[] — multi-select values (Phase 4)
    status: 'all',
    from: range.from,
    to: range.to,
    sortByPayoutDate: false,
    pageSize: 50,
  };
}


function getPage() {
  return document.getElementById(PAGE_ID);
}

/* ─── LOADING OVERLAY ────────────────────────────────────────────────────── */

function _showReceiptsLoading() {
  const overlay = document.getElementById('receiptsLoadingOverlay');
  if (overlay) overlay.classList.remove('ar-loading-overlay--hidden');
  // Disable filter controls while loading
  const page = getPage();
  if (page) {
    page.querySelectorAll('.receipt-filters input, .receipt-filters button, .range-toolbar input, .range-toolbar button, .range-toolbar select').forEach(el => {
      el.dataset.wasDisabled = el.disabled ? '1' : '';
      el.disabled = true;
    });
  }
}

function _hideReceiptsLoading() {
  const overlay = document.getElementById('receiptsLoadingOverlay');
  if (overlay) overlay.classList.add('ar-loading-overlay--hidden');
  // Re-enable filter controls
  const page = getPage();
  if (page) {
    page.querySelectorAll('.receipt-filters input, .receipt-filters button, .range-toolbar input, .range-toolbar button, .range-toolbar select').forEach(el => {
      if (el.dataset.wasDisabled !== '1') el.disabled = false;
      delete el.dataset.wasDisabled;
    });
  }
}

function getSessionUsername() {
  return window.__APP_CONTEXT__?.username || '';
}

/* ─── TARGETED STYLE UPDATES (avoid full renderShell during loading) ────── */

function _updateStatusButtonStyles() {
  const page = getPage();
  if (!page) return;
  const status = STATE.filters.receipts.status;
  page.querySelectorAll('[data-action="status-filter"]').forEach(btn => {
    const s = btn.dataset.status;
    if (s === 'all')    btn.style.cssText = status === 'all'    ? 'background:#2563eb;color:#fff;border-color:#2563eb;' : '';
    if (s === 'paid')   btn.style.cssText = status === 'paid'   ? 'background:#059669;color:#fff;border-color:#059669;' : '';
    if (s === 'unpaid') btn.style.cssText = status === 'unpaid' ? 'background:#dc2626;color:#fff;border-color:#dc2626;' : '';
  });
}

function _updateSortButtonStyle() {
  const page = getPage();
  if (!page) return;
  const btn = page.querySelector('[data-action="sort-by-payout-date"]');
  if (btn) {
    btn.style.cssText = STATE.filters.receipts.sortByPayoutDate
      ? 'background:#7c3aed;color:#fff;border-color:#7c3aed;'
      : '';
  }
}

function _updateDateInputValues() {
  const page = getPage();
  if (!page) return;
  const f = STATE.filters.receipts;
  const fromInput = page.querySelector('[data-filter-tab="receipts"][data-filter-key="from"]');
  const toInput   = page.querySelector('[data-filter-tab="receipts"][data-filter-key="to"]');
  if (fromInput) fromInput.value = f.from;
  if (toInput)   toInput.value = f.to;
}

/* ─── MULTI-SELECT FILTER LIFECYCLE ──────────────────────────────────────── */

/**
 * Create MultiSelectFilter instances ONCE and mount them into the
 * container slots rendered by renderReceiptsControls().
 * Called from initAllReceiptsPage() after renderShell().
 * Instances persist for the lifetime of the page — never recreated.
 */
function _initMultiSelectFilters() {
  for (const def of MS_FILTER_DEFS) {
    const container = document.getElementById(`ms-slot-${def.key}`);
    if (!container) continue;
    // If already created (should not happen, but guard), skip
    if (_msFilters[def.key]) continue;

    _msFilters[def.key] = new MultiSelectFilter({
      container,
      label: def.label,
      key: def.key,
      options: STATE.options?.[def.optionsKey] || [],
      selected: STATE.filters.receipts[def.stateKey] || [],
      onConfirm: (values) => _onMultiSelectConfirm(def.stateKey, values),
      rtl: true,
    });
  }
}

/**
 * Update options on all existing MultiSelectFilter instances.
 * Called when STATE.options changes (initial load, date change, receipts:changed).
 * Does NOT recreate instances — calls setOptions() on existing ones.
 */
function _updateMultiSelectOptions() {
  if (!STATE.options) return;
  for (const def of MS_FILTER_DEFS) {
    const instance = _msFilters[def.key];
    if (!instance) continue;
    instance.setOptions(STATE.options[def.optionsKey] || []);
    // Sync back: setOptions() may have dropped selected values that no
    // longer exist in the new options. Read back the component's actual
    // selection to keep STATE.filters.receipts as the single source of truth.
    STATE.filters.receipts[def.stateKey] = instance.getSelected();
  }
}

/**
 * Populate MultiSelect options from STATE.receipts (client-side extraction).
 * Used in 'list' mode where meta.options is not available.
 * Extracts distinct values from the loaded receipts for multi-select filter options.
 */
function _populateMultiSelectOptionsFromState() {
  const receipts = STATE.receipts;
  if (!Array.isArray(receipts)) return;

  // Column-level values
  const clientNames = [...new Set(receipts.map(r => r.client_name).filter(Boolean))].sort();
  const receiptNumbers = [...new Set(receipts.map(r => r.receipt_number).filter(Boolean))];
  receiptNumbers.sort((a, b) => Number(a) - Number(b));

  // Row-level values — single pass
  const vehicleSet = new Set();
  const kartaSet = new Set();
  const typeSet = new Set();
  const officeSet = new Set();
  for (const r of receipts) {
    const rows = Array.isArray(r.rows) ? r.rows : [];
    for (const row of rows) {
      if (row._type === 'separator') continue;
      const car = (row.car || row.carNo || row.vehicle_plate || '').trim();
      if (car) vehicleSet.add(car);
      const karta = (row.kartano || row.kartaNo || row.karta || '').trim();
      if (karta) kartaSet.add(karta);
      const type = (row.type || '').trim();
      if (type) typeSet.add(type);
      const office = (row.office || '').trim();
      if (office) officeSet.add(office);
    }
  }

  const allCompanies = [...officeSet].sort();
  const vehicles = [...vehicleSet].sort();
  const kartas = [...kartaSet].sort();
  const types = [...typeSet].sort();

  // Feed each MultiSelect instance
  const optionsMap = {
    client_names: clientNames,
    company_names: allCompanies,
    receipt_numbers: receiptNumbers,
    vehicles: vehicles,
    kartas: kartas,
    types: types,
  };

  for (const def of MS_FILTER_DEFS) {
    const instance = _msFilters[def.key];
    if (!instance) continue;
    instance.setOptions(optionsMap[def.optionsKey] || []);
    STATE.filters.receipts[def.stateKey] = instance.getSelected();
  }
}

/**
 * Callback when any multi-select filter confirms new values.
 *
 * Receipt-level filters (owner, number) → server search via loadReceiptsData('search').
 * Row-level filters (company, vehicle, karta, type) → instant client-side re-render.
 */
async function _onMultiSelectConfirm(stateKey, values) {
  STATE.filters.receipts[stateKey] = values;
  const def = MS_FILTER_DEFS.find(d => d.stateKey === stateKey);
  if (def?.level === 'receipt') {
    await loadReceiptsData('search');
  } else {
    renderAll();
  }
}

/* ─── GENERAL NOTE — MANUAL SAVE ─────────────────────────────────────────── */

async function _saveReceiptNote(receiptId) {
  if (!receiptId) return;
  const username = getSessionUsername();
  if (!username) return;
  const textarea = document.querySelector(`[data-receipt-note="${CSS.escape(String(receiptId))}"]`);
  if (!textarea) return;
  const btn = document.querySelector(`[data-action="save-receipt-note"][data-id="${CSS.escape(String(receiptId))}"]`);
  const value = textarea.value.trim() || null;
  try {
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    await ReceiptRepository.update(receiptId, { notes: value }, { username });
    const receipt = STATE.receipts.find((r) => String(r.id) === String(receiptId));
    if (receipt) receipt.notes = value;
    if (btn) { btn.textContent = '✅'; setTimeout(() => { btn.textContent = '💾 حفظ'; }, 1200); }
  } catch (err) {
    console.error('[allReceipts] note save failed:', err);
    if (btn) { btn.textContent = '❌'; setTimeout(() => { btn.textContent = '💾 حفظ'; btn.disabled = false; }, 1500); }
  }
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtMoney(value) { // delegated to Money.fmt
  return Money.fmt(value);

}

function centsToMoney(value) { // delegated to Money.fmtCents
  return Money.fmtCents(value);
}

function toNumber(value) {
  return Number(value) || 0;
}

function getLast30DaysRange() {
  const today = new Date();
  const to = DateUtils.toLocalDate(today);
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - 89);
  return { from: DateUtils.toLocalDate(fromDate), to };
}

function normalizeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return DateUtils.toLocalDate(date);
}



function receiptDisplayDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return SHORT_DATE_FMT.format(date);
}

function receiptDayName(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ar-EG', { weekday: 'long' }).format(date);
}

function receiptTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return TIME_FMT.format(date);
}

function normalizePersistedRow(row) {
  if (!row || typeof row !== 'object') return row;
  if (row._type === 'separator') return row;
  const hasSeparatorShape = row.vehicleName != null
    && row.subtotal != null
    && !row.kartano
    && !row.kartaNo
    && !row.karta;
  if (hasSeparatorShape) return { ...row, _type: 'separator' };
  return row;
}

function getReceiptRows(record) {
  const rows = Array.isArray(record?.rows) ? record.rows : [];
  return rows.map(normalizePersistedRow);
}

/**
 * getDisplayRowsForReceipt(record)
 *
 * Returns the rows of a receipt that should be displayed.
 *
 * Server-side filtering determines which receipt CARDS are loaded.
 * Client-side row-level filters (company, vehicle, karta, type) determine
 * which ROWS within each card are visible.
 *
 * When no row-level filters are active, returns all rows (fast path).
 *
 * Used by: buildReceiptCardHtml, _exportReceiptsToExcel (frozen),
 *          serializeCurrentView (frozen), summarizeReceipts.
 */
function getDisplayRowsForReceipt(record) {
  const rows = getReceiptRows(record);
  const f = STATE.filters.receipts;

  // Check if any row-level filter is active
  const companyVals  = f.company;
  const vehicleVals  = f.vehicle;
  const kartaVals    = f.karta;
  const typeVals     = f.type;

  const hasRowFilter = (companyVals.length > 0 || vehicleVals.length > 0 ||
                        kartaVals.length > 0 || typeVals.length > 0);

  if (!hasRowFilter) return rows;

  // Build lowercase Sets for fast matching
  const companySet = companyVals.length > 0 ? new Set(companyVals.map(v => v.toLowerCase())) : null;
  const vehicleSet = vehicleVals.length > 0 ? new Set(vehicleVals.map(v => v.toLowerCase())) : null;
  const kartaSet   = kartaVals.length > 0   ? new Set(kartaVals.map(v => v.toLowerCase()))   : null;
  const typeSet    = typeVals.length > 0     ? new Set(typeVals.map(v => v.toLowerCase()))    : null;

  return rows.filter(row => {
    // Separator rows: show if adjacent data rows match, or no data-specific filter
    if (row._type === 'separator') return true;

    // Each active filter must match (AND logic)
    if (companySet) {
      const office = (row.office || '').toLowerCase();
      if (!office || !companySet.has(office)) return false;
    }
    if (vehicleSet) {
      const car = (row.car || row.carNo || row.vehicle_plate || '').toLowerCase();
      if (!car || !vehicleSet.has(car)) return false;
    }
    if (kartaSet) {
      const karta = (row.kartano || row.kartaNo || row.karta || '').toLowerCase();
      if (!karta || !kartaSet.has(karta)) return false;
    }
    if (typeSet) {
      const type = (row.type || '').toLowerCase();
      if (!type || !typeSet.has(type)) return false;
    }
    return true;
  });
}

function sumVisibleRowWeight(rows) {
  return rows
    .filter((row) => row._type !== 'separator')
    .reduce((sum, row) => {
      if (row.weightTotal != null && row.weightTotal !== '') {
        return sum + toNumber(row.weightTotal);
      }
      if (row.weight_total != null && row.weight_total !== '') {
        return sum + toNumber(row.weight_total);
      }
      return sum + toNumber(row.weight) + toNumber(row.weight2) - toNumber(row.deficit);
    }, 0);
}

function sumVisibleRowField(rows, field) {
  return rows
    .filter((row) => row._type !== 'separator')
    .reduce((sum, row) => sum + toNumber(row[field]), 0);
}

/**
 * getReceiptCardsFiltered()
 *
 * Server handles receipt-level filters (date range, owner, receipt number).
 * STATE.receipts contains the server-filtered dataset.
 *
 * Client handles:
 *   - Status filter (paid/unpaid/all) — presentation filter
 *   - Row-level filters (company, vehicle, karta, type) — filters rows
 *     within each card, hides cards with zero matching rows
 *
 * Kept as a named function because frozen systems (print/export) call it.
 */
function getReceiptCardsFiltered() {
  const f = STATE.filters.receipts;
  const status = f.status || 'all';

  // Check if any row-level filter is active
  const hasRowFilter = (f.company.length > 0 || f.vehicle.length > 0 ||
                        f.karta.length > 0 || f.type.length > 0);

  return STATE.receipts.filter(record => {
    // Status filter
    if (status !== 'all' && String(record.payout_status || RECEIPT_PAYOUT_STATUS.UNPAID) !== status) {
      return false;
    }
    // Row-level filter: hide receipts with zero matching data rows
    if (hasRowFilter) {
      const visibleRows = getDisplayRowsForReceipt(record);
      const hasDataRows = visibleRows.some(row => row._type !== 'separator');
      if (!hasDataRows) return false;
    }
    return true;
  });
}


/**
 * summarizeReceipts(records)
 *
 * Client-side summary computation. Uses getDisplayRowsForReceipt()
 * so row-level filters (company, vehicle, karta, type) affect the totals.
 *
 * Used when client-side filters are active (status, row-level) and
 * meta.summary does not apply. Also called by frozen print system.
 */
function summarizeReceipts(records) {
  return records.reduce((acc, record) => {
    acc.netDue += toNumber(record.net_due);
    acc.netTotal += toNumber(record.net_total);
    acc.paid += toNumber(record.paid);
    const rows = getDisplayRowsForReceipt(record);
    acc.count += rows.filter((row) => row._type !== 'separator').length;
    acc.weight += sumVisibleRowWeight(rows);
    acc.noloon += sumVisibleRowField(rows, 'noloon');
    acc.ohda += sumVisibleRowField(rows, 'ohda');
    return acc;
  }, { netDue: 0, netTotal: 0, paid: 0, count: 0, weight: 0, noloon: 0, ohda: 0 });
}



function setFilterValue(tab, key, value) {
  STATE.filters[tab][key] = value;
}

function setQuickRange(tab, days) {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - (days - 1));
  STATE.filters[tab].from = DateUtils.toLocalDate(fromDate);
  STATE.filters[tab].to = DateUtils.toLocalDate(toDate);
  STATE.filters[tab].date = '';
}

function renderShell() {
  const page = getPage();
  if (!page) return;

  page.classList.remove('card');
  page.classList.add('all-receipts-page');
  page.innerHTML = `
    <div class="all-receipts-bg">
      <div class="all-receipts-card">

        <div class="all-receipts-header">
          <h2 class="all-receipts-title">جميع الكارتات</h2>
          <p class="all-receipts-subtitle">عرض مركزي للكارتات مع التصفية والطباعة والتعديل الآمن.</p>
          <div class="all-receipts-tabs no-print" role="tablist" aria-label="جميع النماذج">
            <button type="button" class="all-tab" data-tab="receipts">📋 الكارتات</button>
          </div>
        </div>

        <div class="all-receipts-panels">
          <section class="all-panel" data-panel="receipts">
            ${renderReceiptsControls()}
            <div id="receiptsSummaryContainer"></div>
            <div id="receiptsListWrap" style="position:relative;">
              <div id="receiptsLoadingOverlay" class="ar-loading-overlay ar-loading-overlay--hidden">
                <div class="ar-loading-spinner"></div>
                <span>جارٍ التحميل...</span>
              </div>
              <div id="receiptsList" class="all-list"></div>
            </div>
          </section>
        </div>

      </div>
    </div>
  `;
  setActiveTabButtons();
}

function renderReceiptsControls() {
  const f = STATE.filters.receipts;
  // Phase 4: multi-select filter containers.
  // Instances are created ONCE in _initMultiSelectFilters() and mounted into these divs.
  const filterSlots = MS_FILTER_DEFS.map(def =>
    `<div id="ms-slot-${def.key}" class="ms-filter-slot" style="position:relative;"></div>`
  ).join('');
  return `
    <div class="filter-grid receipt-filters no-print">
      ${filterSlots}
    </div>
    <div class="range-toolbar no-print">
      <button type="button" data-range="receipts" data-days="1" class="range-btn">يوم</button>
      <button type="button" data-range="receipts" data-days="7" class="range-btn">أسبوع</button>
      <button type="button" data-range="receipts" data-days="30" class="range-btn">شهر</button>
      <label>
        <span>من</span>
        <input data-filter-tab="receipts" data-filter-key="from" type="date" value="${esc(f.from)}" />
      </label>
      <label>
        <span>إلى</span>
        <input data-filter-tab="receipts" data-filter-key="to" type="date" value="${esc(f.to)}" />
      </label>
      <label class="page-size-label">
        <span>عرض:</span>
        <select id="receiptPageSize" data-action="page-size">
          <option value="50" ${f.pageSize === 50 ? 'selected' : ''}>50</option>
          <option value="100" ${f.pageSize === 100 ? 'selected' : ''}>100</option>
          <option value="200" ${f.pageSize === 200 ? 'selected' : ''}>200</option>
          <option value="0" ${f.pageSize === 0 ? 'selected' : ''}>الكل</option>
        </select>
      </label>
      <button type="button" data-action="apply-filter" data-tab="receipts" class="apply-btn apply-btn--receipts">تطبيق</button>
      <button type="button" data-action="print-filtered" data-tab="receipts" class="pdf-btn">📄 تصدير PDF</button>
      <button type="button" data-action="export-excel-filtered" data-tab="receipts" class="excel-btn">📊 تصدير Excel</button>
       <button type="button" data-action="sort-by-payout-date" class="range-btn" style="${f.sortByPayoutDate ? 'background:#7c3aed;color:#fff;border-color:#7c3aed;' : ''}">📅 تنظيم الصرف</button>
      <div style="display:flex;gap:6px;align-items:flex-end;">
        <button type="button" data-action="status-filter" data-status="all"
          class="range-btn" style="${f.status === 'all' ? 'background:#2563eb;color:#fff;border-color:#2563eb;' : ''}">📋 الكل</button>
        <button type="button" data-action="status-filter" data-status="paid"
          class="range-btn" style="${f.status === 'paid' ? 'background:#059669;color:#fff;border-color:#059669;' : ''}">✅ تم صرفه</button>
        <button type="button" data-action="status-filter" data-status="unpaid"
          class="range-btn" style="${f.status === 'unpaid' ? 'background:#dc2626;color:#fff;border-color:#dc2626;' : ''}">⏳ لم يتم صرفه</button>
      </div>
    </div>
  `;
}


function renderSummaryCards(_preFiltered) {
  // Summary source: use server meta.summary only when NO client-side filters are active.
  // When status filter or row-level filters are active, use client-side summarizeReceipts().
  const f = STATE.filters.receipts;
  const statusFilter = f.status || 'all';
  const hasRowFilter = (f.company.length > 0 || f.vehicle.length > 0 ||
                        f.karta.length > 0 || f.type.length > 0);
  const useServerSummary = (statusFilter === 'all' && !hasRowFilter && STATE.meta?.summary);
  const filtered = _preFiltered || getReceiptCardsFiltered();
  const sums = useServerSummary
    ? {
        netDue:  STATE.meta.summary.net_due  ?? 0,
        netTotal: STATE.meta.summary.net_total ?? 0,
        paid:    STATE.meta.summary.paid     ?? 0,
        count:   STATE.meta.summary.row_count ?? 0,
        weight:  STATE.meta.summary.weight   ?? 0,
        noloon:  STATE.meta.summary.noloon   ?? 0,
        ohda:    STATE.meta.summary.ohda     ?? 0,
      }
    : summarizeReceipts(filtered);

  const html = `
    <div class="summary-grid summary-grid--receipts">
      ${summaryCard('💰 إجمالي الصافي المستحق', centsToMoney(sums.netDue), 'summary-card--violet')}
      ${summaryCard('💰 إجمالي الصافي الكلي', centsToMoney(sums.netTotal), 'summary-card--violet')}
      ${summaryCard('📊 إجمالي المدفوع', centsToMoney(sums.paid), 'summary-card--red')}
      ${summaryCard('🗂️ عدد الكارتات', String(sums.count), 'summary-card--blue')}
      ${summaryCard('⚖️ إجمالي الوزن', fmtMoney(sums.weight), 'summary-card--green')}
      ${summaryCard('🚛 إجمالي النولون', fmtMoney(sums.noloon), 'summary-card--cyan')}
      ${summaryCard('🏦 إجمالي العهدة', fmtMoney(sums.ohda), 'summary-card--emerald')}
    </div>
  `;
  const container = document.getElementById('receiptsSummaryContainer');
  if (container) container.innerHTML = html;
  return html;
}

function summaryCard(label, value, extraClass) {
  return `
    <div class="summary-card ${extraClass}">
      <div class="summary-card__label">${esc(label)}</div>
      <div class="summary-card__value">${esc(value)}</div>
    </div>
  `;
}


function setActiveTabButtons() {
  const page = getPage();
  if (!page) return;
  page.querySelectorAll('.all-tab').forEach((btn) => {
    const isActive = btn.dataset.tab === STATE.tab;
    btn.classList.toggle('is-active', isActive);
  });
  page.querySelectorAll('.all-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.panel !== STATE.tab);
  });
}

/**
 * Build the HTML for a single receipt card.
 * @param {object} record — receipt record (from DB, cents-based)
 * @param {object} [opts] — { readOnly: false }
 * @returns {string} HTML
 */
function buildReceiptCardHtml(record, opts = {}) {
  const readOnly = opts.readOnly === true;
  const title = `${receiptDisplayDate(record.receipt_date)} — ${receiptDayName(record.receipt_date)} — ${receiptTime(record.created_at || record.updated_at || record.receipt_date)}`;
  const displayRows = getDisplayRowsForReceipt(record);
  const kartaCount = record.row_count != null
    ? record.row_count
    : displayRows.filter((row) => row._type !== 'separator').length;
  const meta = getPayoutStatusMeta(record.payout_status);
  const payoutStatus = meta.id;

  const actionsHtml = readOnly
    ? `<div class="record-card__actions no-print">
         <button type="button" data-action="edit-receipt" data-id="${esc(record.id)}">✏️ تعديل</button>
         <button type="button" data-action="print-single-receipt" data-id="${esc(record.id)}">🖨️ طباعة</button>
         <span style="background:${meta.color};color:#fff;padding:3px 10px;border-radius:999px;font-size:0.75rem;font-weight:700;">${esc(meta.label)}</span>
       </div>`
    : `<div class="record-card__actions no-print">
         <button type="button" data-action="edit-receipt" data-id="${esc(record.id)}">✏️ تعديل</button>
         <button type="button" data-action="print-single-receipt" data-id="${esc(record.id)}">🖨️ طباعة</button>
         <button type="button" data-action="delete-receipt" data-id="${esc(record.id)}">🗑️ حذف</button>
         <label class="status-select-wrap" title="حالة الصرف">
           <span class="sr-only">حالة الصرف</span>
           <select data-action="toggle-receipt-status" data-id="${esc(record.id)}">
             <option value="${RECEIPT_PAYOUT_STATUS.PAID}" ${payoutStatus === RECEIPT_PAYOUT_STATUS.PAID ? 'selected' : ''}>✅ تم صرفه</option>
             <option value="${RECEIPT_PAYOUT_STATUS.UNPAID}" ${payoutStatus === RECEIPT_PAYOUT_STATUS.UNPAID ? 'selected' : ''}>⏳ لم يتم صرفه</option>
           </select>
         </label>
       </div>`;

  const noteHtml = readOnly
    ? (record.notes ? `<div style="padding:14px 22px;background:#f8fafc;border-top:1px solid #e5e7eb;border-radius:0 0 20px 20px;font-size:0.8125rem;color:#475569;">📝 ${esc(record.notes)}</div>` : '')
    : `<div class="receipt-general-note no-print" style="padding: 14px 22px; background: #f8fafc; border-top: 1px solid #e5e7eb; border-radius: 0 0 20px 20px;">
         <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;">
           <div style="flex:1;">
             <label style="display: block; font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 8px; font-family: inherit;">📝 ملاحظة عامة</label>
             <div style="display:flex;gap:8px;align-items:flex-start;">
               <textarea data-receipt-note="${esc(record.id)}" class="input" style="flex:1;min-height:52px;resize:vertical;font-size:13px;line-height:1.6;" rows="1" placeholder="اكتب ملاحظة عامة لهذا النموذج...">${esc(record.notes || '')}</textarea>
               <button type="button" data-action="save-receipt-note" data-id="${esc(record.id)}" disabled class="btn btn-sm" style="background:#2563eb;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-weight:700;font-size:0.75rem;cursor:pointer;opacity:0.5;white-space:nowrap;align-self:stretch;">💾 حفظ</button>
             </div>
           </div>
         </div>
       </div>`;

  return `
    <article class="record-card receipt-record" data-kind="receipt" data-id="${esc(record.id)}">
      <header class="record-card__header">
        <div class="record-card__heading">
          <h3>${esc(title)}</h3>
          <p style="font-size:1rem;font-weight:700;color:#1e3a8a;margin:0 0 4px;">
            <span>صاحب المركبة: ${esc(record.client_name || '—')}</span>
            <span style="margin:0 8px;color:#cbd5e1;">|</span>
            <span>إذن الصرف: ${esc(record.receipt_number || '—')}</span>
            ${record.paid_at ? `<span style="margin:0 8px;color:#cbd5e1;">|</span><span>تاريخ الصرف: ${esc(record.paid_at.split('T')[0])}</span>` : ''}
          </p>
        </div>
        ${actionsHtml}
      </header>
      <div class="record-card__table-wrap">
        <table class="record-table receipt-snapshot-table">
          <thead class="bg-gradient-to-r from-blue-600 to-blue-700 text-white">
            <tr>${renderReceiptSnapshotTableHead()}</tr>
          </thead>
          <tbody>
            ${renderReceiptSnapshotRowsHtml(displayRows, { colSpan: DATA_COL_COUNT })}
          </tbody>
        </table>
      </div>
      <div class="record-card__footer">
        <div><span>عدد الكارتات</span><strong>${kartaCount}</strong></div>
        <div><span>الإجمالي</span><strong>${Money.fmtCents(record.total)}</strong></div>
        <div><span>اضافة عام</span><strong>${Money.fmtCents(record.general_add)}</strong></div>
        <div><span>الصافي المستحق</span><strong>${Money.fmtCents(record.net_due)}</strong></div>
       <div><span>رصيد العميل</span><strong>${Money.fmtCents((record.net_total ?? 0) - (record.paid ?? 0))}</strong></div>
        <div><span>الصافي الكلي</span><strong>${Money.fmtCents(record.net_total)}</strong></div>
        <div><span>المدفوع</span><strong>${Money.fmtCents(record.paid)}</strong></div>
      </div>
      ${noteHtml}
    </article>
  `;
}

function renderReceiptList(_preFiltered) {
  const container = document.getElementById('receiptsList');
  if (!container) return;
  const filtered = _preFiltered || getReceiptCardsFiltered();

  // Preserve active note focus before rebuild
  const activeEl = document.activeElement;
  const activeNoteId = activeEl?.closest?.('[data-receipt-note]')?.dataset?.receiptNote;
  const activeNoteCursor = activeEl?.selectionStart;

  if (!filtered.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📄</div>
        <p class="empty-state__text">لا توجد نماذج في هذه الفترة</p>
        <p class="empty-state__sub">جرّب تغيير نطاق التاريخ أو شروط البحث</p>
      </div>
    `;
    return;
  }

  // ── Sort pipeline (data-driven, never mutates source) ──
  const sorted = [...filtered];
  if (STATE.filters.receipts.sortByPayoutDate) {
    // Paid receipts first (sorted by paid_at DESC), then unpaid in default order
    sorted.sort((a, b) => {
      const aPaid = String(a.payout_status || 'unpaid') === 'paid';
      const bPaid = String(b.payout_status || 'unpaid') === 'paid';
      // Paid before unpaid
      if (aPaid && !bPaid) return -1;
      if (!aPaid && bPaid) return 1;
      // Both paid: sort by paid_at DESC (newest first)
      if (aPaid && bPaid) {
        const aTime = a.paid_at ? new Date(a.paid_at).getTime() : 0;
        const bTime = b.paid_at ? new Date(b.paid_at).getTime() : 0;
        if (isNaN(aTime) && isNaN(bTime)) return 0;
        if (isNaN(aTime)) return 1;
        if (isNaN(bTime)) return -1;
        return bTime - aTime;
      }
      // Both unpaid: default order (created_at DESC)
      return (b.created_at || 0) - (a.created_at || 0);
    });
  } else {
    sorted.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  }

  container.innerHTML = sorted
    .map((record) => buildReceiptCardHtml(record))
    .join('');

  // Restore focus if user was typing in a note
  if (activeNoteId) {
    const restored = container.querySelector(`[data-receipt-note="${activeNoteId}"]`);
    if (restored) {
      restored.focus();
      if (typeof activeNoteCursor === 'number') {
        restored.setSelectionRange(activeNoteCursor, activeNoteCursor);
      }
    }
  }
}


function renderLists(_preFilteredReceipts) {
  renderReceiptList(_preFilteredReceipts);
}





/**
 * Determine whether any receipt multi-select filter is active.
 * Used to decide limit=0 (all matches) vs limit=50 (default page).
 */
/**
 * Check if any SERVER-SIDE receipt filter is active.
 * Only receipt-level filters (level='receipt') affect the server query.
 * Row-level filters (level='row') are client-side only.
 * Status and sort are client-side only.
 */
function _hasActiveReceiptFilters() {
  const f = STATE.filters.receipts;
  return MS_FILTER_DEFS.some(def =>
    def.level === 'receipt' && f[def.stateKey]?.length > 0
  );
}

/**
 * loadReceiptsData(mode)
 *
 * Single entry point for loading receipt data.
 * mode = 'list'   → list.php (fast, 1 query, all receipts in date range, no overlay)
 * mode = 'search' → search.php (multi-select filters, meta, options, overlay)
 *
 * The ONLY difference between modes is the data source.
 * After STATE.receipts is assigned, the rendering pipeline is identical.
 */
async function loadReceiptsData(mode) {
  const username = getSessionUsername();
  if (!username) return;
  if (STATE.loading) return;
  STATE.loading = true;
  if (mode === 'search') _showReceiptsLoading();

  try {
    const f = STATE.filters.receipts;

    if (mode === 'list') {
      // ── list.php: fast, 1 query, all receipts in date range ──
      const receipts = await ReceiptsModule.getByDateRange(username, f.from, f.to);
      STATE.receipts = receipts.slice();
      STATE.meta = null;
    } else {
      // ── search.php: multi-select filters + meta + options ──
      const searchParams = {
        from_date: f.from,
        to_date:   f.to,
        limit:     0,
        offset:    0,
        include_options: '1',
      };
      for (const def of MS_FILTER_DEFS) {
        if (def.level === 'receipt' && def.apiParam && f[def.stateKey]?.length > 0) {
          searchParams[def.apiParam] = f[def.stateKey];
        }
      }
      const searchResult = await ReceiptsModule.searchReceipts(searchParams);
      STATE.receipts = searchResult.data;
      STATE.meta = searchResult.meta;
      if (searchResult.meta?.options) {
        STATE.options = searchResult.meta.options;
        _updateMultiSelectOptions();
      }
    }


    if (mode === 'list') {
      _populateMultiSelectOptionsFromState();
    }

    const _cachedR = getReceiptCardsFiltered();
    renderSummaryCards(_cachedR);
    renderLists(_cachedR);
    setActiveTabButtons();

  } finally {
    STATE.loading = false;
    if (mode === 'search') _hideReceiptsLoading();
  }
}

function serializeCurrentView() {
  const records = getReceiptCardsFiltered();
  const title   = 'جميع الكارتات';

  const summaryHTML = _buildReceiptsBulkSummary(summarizeReceipts(records));

  const body = records.map((record) => buildReceiptPrintBlock(record)).join('');

  const content = body
    ? `${summaryHTML}${body}`
    : '<div class="print-empty">لا توجد بيانات للطباعة</div>';

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${printStyles()}</style></head><body><div class="print-page"><h1>${esc(title)}</h1>${content}</div></body></html>`;
}

/**
 * _buildReceiptsBulkSummary(sums)
 *
 * Renders a summary bar for the bulk PDF export (تصدير PDF) of receipt cards.
 * Mirrors exactly the 7 summary cards shown on screen above the list.
 *
 * Money units:
 *   netDue, netTotal, paid → CENTS   (from summarizeReceipts which reads record.net_due etc.)
 *   weight, noloon, ohda   → DECIMAL (summed directly from row fields)
 *   count                  → integer
 */
function _buildReceiptsBulkSummary(sums) {
  const th = (label) => `<th style="background:#fff;color:#000;padding:4px 6px;border:1.5px solid #000;text-align:center;font-size:7pt;font-weight:700;">${esc(label)}</th>`;
  const td = (value) => `<td style="background:#fff;color:#000;padding:5px 6px;border:1.5px solid #000;text-align:center;font-size:11pt;font-weight:800;">${esc(value)}</td>`;

  return `
    <table style="width:100%;border-collapse:collapse;margin-bottom:16px;page-break-inside:avoid;">
      <thead>
        <tr>
          ${th('الصافي المستحق')}
          ${th('الصافي الكلي')}
          ${th('المدفوع')}
          ${th('عدد الكارتات')}
          ${th('إجمالي الوزن')}
          ${th('إجمالي النولون')}
          ${th('إجمالي العهدة')}
        </tr>
      </thead>
      <tbody>
        <tr>
          ${td(centsToMoney(sums.netDue))}
          ${td(centsToMoney(sums.netTotal))}
          ${td(centsToMoney(sums.paid))}
          ${td(String(sums.count))}
          ${td(fmtMoney(sums.weight))}
          ${td(fmtMoney(sums.noloon))}
          ${td(fmtMoney(sums.ohda))}
        </tr>
      </tbody>
    </table>`;
}

/**
 * _bulkReceiptBuildTableHead(activeCols)
 *
 * Builds a clean <thead> for the bulk PDF export of receipt cards.
 * Uses plain <th> tags with inline styles only — no Tailwind, no .no-print classes.
 * This is required because printStyles() has no Tailwind reset.
 */
function _bulkReceiptBuildTableHead(activeCols) {
  const cells = activeCols.map((col) =>
    `<th>${esc(col.label)}</th>`
  ).join('');
  return `<thead><tr>${cells}</tr></thead>`;
}

/**
 * _bulkReceiptBuildTableBody(rows, activeCols)
 *
 * Builds a clean <tbody> for the bulk PDF export.
 * Reads values directly from stored row objects — no DOM, no Tailwind classes.
 * Handles both data rows and separator rows.
 */
function _bulkReceiptBuildTableBody(rows, activeCols) {
  if (!rows.length) return '<tbody></tbody>';

  const colSpan = activeCols.length;

  const html = rows.map((row) => {
    // ── Separator row ─────────────────────────────────────────────────────
    if (row._type === 'separator') {
      const vehicleName = esc(row.vehicleName || '');
      const subtotal    = Money.fmt(Number(row.subtotal) || 0);
      const notes       = row.notes ? ` | ملاحظات: ${esc(row.notes)}` : '';
      return `<tr class="sep-row">
        <td colspan="${colSpan}" style="text-align:right;padding:4px 8px;background:#fff7ed;border-top:2px solid #fb923c;color:#9a3412;font-weight:700;">
          <strong>🔄 رقم المركبة: ${vehicleName}</strong>
          &nbsp;&nbsp; إجمالي ما سبق: <strong>${subtotal}</strong>${notes}
        </td>
      </tr>`;
    }

    // ── Data row ──────────────────────────────────────────────────────────
    const cells = activeCols.map((col) => {
      const raw       = _receiptPrintGetCellValue(row, col.key);
      const formatted = _receiptPrintFormatCell(raw, col.type);
      const align     = col.type === 'number' ? 'center' : 'right';
      return `<td style="text-align:${align};">${formatted}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  return `<tbody>${html}</tbody>`;
}

function buildReceiptPrintBlock(record) {
  const allRows  = getReceiptRows(record);
  const dataRows = allRows.filter((r) => r._type !== 'separator');

  const kartaCount = record.row_count != null
    ? record.row_count
    : dataRows.length;

  // Resolve columns using the same logic as printSingleReceipt —
  // strips printHide columns and empty conditional columns.
  const activeCols = _receiptPrintResolveColumns(dataRows);
  const thead      = _bulkReceiptBuildTableHead(activeCols);
  const tbody      = _bulkReceiptBuildTableBody(allRows, activeCols);

  const payoutStatus = String(record.payout_status || 'unpaid');
  const statusLabel  = payoutStatus === 'paid' ? 'تم صرفه' : 'لم يتم الصرف';

  return `
    <section class="print-card">
      <header>
        <strong>${esc(receiptDisplayDate(record.receipt_date))}</strong>
        - ${esc(receiptDayName(record.receipt_date))}
        - ${esc(record.receipt_number || '')}
      </header>
      <div class="print-meta">
        ${esc(record.client_name || '')}
        · ${esc(statusLabel)}
      </div>
      <table>
        ${thead}
        ${tbody}
      </table>
      ${record.notes ? `<div style="margin-top:8px;padding:6px 10px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:4px;font-size:9pt;"><strong style="color:#334155;">ملاحظة:</strong> <span style="color:#475569;">${esc(record.notes)}</span></div>` : ''}
      <div class="print-footer">
        <span>عدد الكارتات: <strong>${kartaCount}</strong></span>
        <span>الإجمالي: <strong>${Money.fmtCents(record.total)}</strong></span>
        <span>إضافة عام: <strong>${Money.fmtCents(record.general_add)}</strong></span>
        <span>الصافي المستحق: <strong>${Money.fmtCents(record.net_due)}</strong></span>
        <span>رصيد العميل: <strong>${Money.fmtCents((record.net_total ?? 0) - (record.paid ?? 0))}</strong></span>
        <span>الصافي الكلي: <strong>${Money.fmtCents(record.net_total)}</strong></span>
        <span>المدفوع: <strong>${Money.fmtCents(record.paid)}</strong></span>
      </div>
    </section>
  `;
}


// ─────────────────────────────────────────────────────────────────────────────
// RECEIPT CARD PRINT SYSTEM
// Single-receipt print — allReceipts page, Kارتات tab.
//
// Design contract:
//   • Source of truth: the stored record object from STATE.receipts (never DOM).
//   • Top-level money fields (total, paid, net_due, net_total, general_add,
//     previous_balance) are stored as CENTS  → Money.fmtCents().
//   • Row-level numeric fields (net, ohda, noloon, officeAmount, add, weight,
//     weight2, deficit, weightTotal) are stored as DECIMALS → Money.fmt().
//   • Separator rows (_type === 'separator') carry vehicleName, subtotal, notes.
//     subtotal is a DECIMAL (not cents) — matches how getSnapshotCellRawValue
//     handles separator rows.
//   • Conditional columns (weight, weight2, add) are included only when at
//     least one data row has a non-zero value for that field.
//   • Rendered via printEngine.js buildPrintDocument() — no raw HTML wrapper,
//     no window.open, no DOM cloning.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Column definitions for receipt print.
 * Mirrors the COL_DEFS shape from receipts.js but is scoped exclusively to
 * this print system — independent, no shared reference.
 *
 * printHide: true  → column is never rendered in print output.
 * conditional: true → column is rendered only when ≥1 data row has value > 0.
 */
const _RECEIPT_PRINT_COLS = Object.freeze([
  { key: 'kartano',      label: 'رقم الكارتة',  type: 'text',   printHide: false, conditional: false },
  { key: 'date',         label: 'التاريخ',       type: 'text',   printHide: false, conditional: false },
  { key: 'data',         label: 'اسم السائق',    type: 'text',   printHide: false, conditional: false },
  { key: 'car',          label: 'رقم المركبة',   type: 'text',   printHide: false, conditional: false },
  { key: 'weight',       label: 'وزن وش',        type: 'number', printHide: false, conditional: true  },
  { key: 'weight2',      label: 'وزن م',         type: 'number', printHide: false, conditional: true  },
  { key: 'deficit',      label: 'عجز',           type: 'number', printHide: false, conditional: false },
  { key: 'weightTotal',  label: 'الوزن',         type: 'number', printHide: false, conditional: false },
  { key: 'loading',      label: 'التحميل',       type: 'text',   printHide: false, conditional: false },
  { key: 'taktik',       label: 'الجهة',         type: 'text',   printHide: false, conditional: false },
  { key: 'type',         label: 'النوع',         type: 'text',   printHide: false, conditional: false },
  { key: 'noloon',       label: 'نولون',         type: 'number', printHide: false, conditional: false },
  { key: 'ohda',         label: 'عهدة',          type: 'number', printHide: false, conditional: false },
  { key: 'officeAmount', label: 'مكتب',          type: 'number', printHide: false, conditional: false },
  { key: 'add',          label: 'إضافة',         type: 'number', printHide: false, conditional: true  },
  { key: 'sarf',         label: 'الصرف',         type: 'number', printHide: false, conditional: false },
  { key: 'net',          label: 'الصافي',        type: 'number', printHide: false, conditional: false },
]);

/**
 * _receiptPrintGetCellValue(row, colKey)
 *
 * Reads a single cell value from a persisted data row.
 * Handles all field aliases used across different save-format versions.
 * Returns the raw value (string or number) — formatting is applied separately.
 *
 * Row field storage:
 *   - Text fields  → stored as strings.
 *   - Number fields → stored as DECIMALS (not cents).
 *   - weightTotal  → may be pre-calculated or absent (fallback: w+w2-deficit).
 */
function _receiptPrintGetCellValue(row, colKey) {
  switch (colKey) {
    case 'kartano':
      return row.kartano ?? row.kartaNo ?? row.karta ?? '';
    case 'date':
      return row.date ?? row.rowdate ?? '';
    case 'data':
      return row.data ?? row.driver ?? '';
    case 'car': {
      // Guard: skip UUID values that may have been stored in car/vehicle_plate
      // fields in legacy data (vehicle_id leak).
      const _carVal = row.car ?? row.vehicle_plate ?? row.carNo ?? row.vehicle_no ?? '';
      if (typeof _carVal === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(_carVal)) return '';
      return _carVal;
    }
    case 'weight':
      return row.weight ?? '';
    case 'weight2':
      return row.weight2 ?? '';
    case 'deficit':
      return row.deficit ?? '';
    case 'weightTotal': {
      // Pre-calculated field — fall back to arithmetic for legacy records.
      if (row.weightTotal != null && row.weightTotal !== '') return row.weightTotal;
      if (row.weight_total != null && row.weight_total !== '') return row.weight_total;
      const w1 = Number(row.weight)  || 0;
      const w2 = Number(row.weight2) || 0;
      const d  = Number(row.deficit) || 0;
      return (w1 > 0 || w2 > 0) ? (w1 + w2 - d) : '';
    }
    case 'loading':
      return row.loading ?? '';
    case 'taktik':
      return row.taktik ?? row.direction ?? '';
    case 'type':
      return row.type ?? '';
    case 'noloon':
      return row.noloon ?? '';
    case 'ohda':
      return row.ohda ?? '';
    case 'officeAmount':
      return row.officeAmount ?? '';
    case 'add':
      return row.add ?? '';
    case 'sarf':
      return row.sarf ?? '';
    case 'net':
      return row.net ?? '';
    default:
      return '';
  }
}

/**
 * _receiptPrintFormatCell(value, colType)
 *
 * Formats a raw cell value for print output.
 *   - Number columns: Money.fmt() (decimal formatting with 2dp).
 *   - Text columns:   HTML-escaped string.
 *   - Empty values:   '' (not '0.00' — keeps print clean).
 */
function _receiptPrintFormatCell(value, colType) {
  if (value === '' || value === null || value === undefined) return '';
  if (colType === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? Money.fmt(n) : esc(String(value));
  }
  return esc(String(value));
}

/**
 * _receiptPrintResolveColumns(dataRows)
 *
 * Determines the final set of columns to render in the print table.
 * Strips printHide columns always.
 * Strips conditional columns when no data row carries a non-zero value.
 *
 * @param {object[]} dataRows - Non-separator rows from the record.
 * @returns {object[]} Active column definitions.
 */
function _receiptPrintResolveColumns(dataRows) {
  // Find which conditional keys have at least one row with value > 0
  const conditionalKeys = new Set(
    _RECEIPT_PRINT_COLS
      .filter((col) => col.conditional)
      .map((col) => col.key)
  );

  const activeConditionals = new Set();
  for (const col of _RECEIPT_PRINT_COLS) {
    if (!col.conditional) continue;
    const hasData = dataRows.some((row) => {
      const val = Number(_receiptPrintGetCellValue(row, col.key));
      return Number.isFinite(val) && val !== 0;
    });
    if (hasData) activeConditionals.add(col.key);
  }

  return _RECEIPT_PRINT_COLS.filter((col) => {
    if (col.printHide) return false;
    if (conditionalKeys.has(col.key) && !activeConditionals.has(col.key)) return false;
    return true;
  });
}

/**
 * _receiptPrintBuildTableHead(activeCols)
 *
 * Renders the print table <thead> from the resolved active column list.
 * Uses blue header style matching the system's print standard.
 */
function _receiptPrintBuildTableHead(activeCols) {
  const cells = activeCols.map((col) =>
    `<th class="print-th">${esc(col.label)}</th>`
  ).join('');
  return `<thead><tr>${cells}</tr></thead>`;
}

/**
 * _receiptPrintBuildTableBody(rows, activeCols)
 *
 * Renders the print table <tbody> from stored rows.
 * Handles both data rows and separator rows correctly.
 * Never touches the DOM. All values come from the stored row objects.
 *
 * Separator row rendering:
 *   - subtotal is a DECIMAL value (not cents) — use Money.fmt().
 *   - vehicleName and notes are plain strings.
 */
function _receiptPrintBuildTableBody(rows, activeCols) {
  if (!rows.length) return '<tbody></tbody>';

  const colSpan = activeCols.length;

  const rowsHtml = rows.map((row) => {
    // ── Separator row ────────────────────────────────────────────────────────
    if (row._type === 'separator') {
      const vehicleName = esc(row.vehicleName || '');
      const subtotal    = Money.fmt(Number(row.subtotal) || 0);
      const notes       = row.notes ? ` &nbsp;|&nbsp; ملاحظات: ${esc(row.notes)}` : '';
      return `
        <tr class="print-separator">
          <td colspan="${colSpan}" style="text-align:right;padding:4px 8px;">
            <strong style="color:#c2410c;">🔄 رقم المركبة: ${vehicleName}</strong>
            &nbsp;&nbsp; إجمالي ما سبق: <strong>${subtotal}</strong>${notes}
          </td>
        </tr>`;
    }

    // ── Data row ─────────────────────────────────────────────────────────────
    const cells = activeCols.map((col) => {
      const raw       = _receiptPrintGetCellValue(row, col.key);
      const formatted = _receiptPrintFormatCell(raw, col.type);
      const align     = col.type === 'number' ? 'center' : 'right';
      return `<td style="text-align:${align};">${formatted}</td>`;
    }).join('');

    return `<tr>${cells}</tr>`;
  }).join('');

  return `<tbody>${rowsHtml}</tbody>`;
}

/**
 * _receiptPrintBuildTotalsRow(record, kartaCount)
 *
 * Renders the coloured totals strip at the bottom of the print page.
 * All top-level money values are CENTS in DB → Money.fmtCents().
 * kartaCount is derived from record.row_count or counted from rows.
 */
function _receiptPrintBuildTotalsRow(record, kartaCount) {
  const total           = Money.fmtCents(record.total           ?? 0);
  const generalAdd      = Money.fmtCents(record.general_add     ?? 0);
  const netDue          = Money.fmtCents(record.net_due         ?? 0);
  const previousBalance = Money.fmtCents((record.net_total ?? 0) - (record.paid ?? 0));
  const netTotal        = Money.fmtCents(record.net_total       ?? 0);
  const paid            = Money.fmtCents(record.paid            ?? 0);

  const th = (label) => `<th style="background:#fff;color:#000;padding:4px 6px;border:1.5px solid #000;text-align:center;font-size:7pt;font-weight:700;">${label}</th>`;
  const td = (value) => `<td style="background:#fff;color:#000;padding:5px 6px;border:1.5px solid #000;text-align:center;font-size:11pt;font-weight:800;">${esc(value)}</td>`;

  return `
    <table style="width:100%;border-collapse:collapse;margin-top:8px;page-break-inside:avoid;">
      <thead>
        <tr>
          ${th('عدد الكارتات')}
          ${th('الإجمالي')}
          ${th('إضافة عام')}
          ${th('الصافي المستحق')}
          ${th('رصيد العميل')}
          ${th('الصافي الكلي')}
          ${th('المدفوع')}
        </tr>
      </thead>
      <tbody>
        <tr>
          ${td(String(kartaCount))}
          ${td(total)}
          ${td(generalAdd)}
          ${td(netDue)}
          ${td(previousBalance)}
          ${td(netTotal)}
          ${td(paid)}
        </tr>
      </tbody>
    </table>`;
}

/**
 * _receiptPrintBuildHeader(record)
 *
 * Renders the document header block:
 *   - Header image (wasel.png) — absolute URL built from window.location, no DOM read.
 *   - Title, receipt number, date.
 *   - Owner name.
 *   - Payout status badge.
 *   - Optional shipping number and notes.
 */
function _receiptPrintBuildHeader(record) {
  const receiptNumber = esc(record.receipt_number || '—');
  const receiptDate   = esc(receiptDisplayDate(record.receipt_date));
  const dayName       = esc(receiptDayName(record.receipt_date));
  const ownerName     = esc(record.client_name || '—');
  const meta          = getPayoutStatusMeta(record.payout_status);
  const statusLabel   = meta.printLabel;
  const statusColor   = meta.color;
  const shipping      = record.paid_at
    ? `<span>تاريخ الصرف: <strong>${esc(record.paid_at.split('T')[0])}</strong></span>`
    : '';

  // Build absolute URL for the header image (wasel.png sits next to the app files).
  // We use window.location.href so the iframe can load it without a relative-path issue.
  // No DOM read — purely derived from the current page origin + path.
  const _headerImgAbsUrl = (() => {
    try {
      return new URL('wasel.png', window.location.href).href;
    } catch (_) {
      return '';
    }
  })();

  const headerImgHTML = _headerImgAbsUrl
    ? `<div style="margin-bottom:10px;">
         <img src="${_headerImgAbsUrl}" alt="Header"
              style="width:100%;height:auto;max-height:80px;object-fit:cover;display:block;">
       </div>`
    : '';

  return `
    ${headerImgHTML}
    <div class="print-header">
      <h2>نموذج الصرف</h2>
      <div class="print-header-info">
        <span>إذن الصرف: <strong>${receiptNumber}</strong></span>
        <span>التاريخ: <strong>${receiptDate} — ${dayName}</strong></span>
        ${shipping}
        <span style="color:${statusColor};font-weight:800;">${statusLabel}</span>
      </div>
      <div class="print-header-info" style="margin-top:4px;">
        <span>صاحب المركبة: <strong>${ownerName}</strong></span>
      </div>
    </div>`;
}

/**
 * _receiptPrintBuildBody(record)
 *
 * Assembles the complete print body from the stored record.
 * Orchestrates: header → table → notes → totals.
 * Returns a self-contained HTML string (no external dependencies at runtime).
 *
 * @param {object} record - The raw record from STATE.receipts (cents for money fields).
 * @returns {string} HTML body string for buildPrintDocument().
 */
function _receiptPrintBuildBody(record) {
  const allRows  = getReceiptRows(record);  // normalizes separator shapes
  const dataRows = allRows.filter((r) => r._type !== 'separator');

  const kartaCount = record.row_count != null
    ? record.row_count
    : dataRows.length;

  const activeCols = _receiptPrintResolveColumns(dataRows);
  const thead      = _receiptPrintBuildTableHead(activeCols);
  const tbody      = _receiptPrintBuildTableBody(allRows, activeCols);
  const totals     = _receiptPrintBuildTotalsRow(record, kartaCount);
  const header     = _receiptPrintBuildHeader(record);

  const notesBlock = record.notes
    ? `<div class="print-note">
        <strong style="color:#334155;">📝 ملاحظة عامة:</strong>
        <span style="color:#475569;">${esc(record.notes)}</span>
       </div>`
    : '';

  return `
    ${header}
    <table>
      ${thead}
      ${tbody}
    </table>
    ${notesBlock}
    ${totals}`;
}

/**
 * printSingleReceipt(record)
 *
 * Entry point for single-receipt printing from the allReceipts page.
 * Called by the event handler when data-action="print-single-receipt" is clicked.
 *
 * Validation:
 *   - Record must exist and have rows.
 *   - At least one non-separator data row must be present.
 *   - Errors are logged to console — no crash, no alert.
 *
 * Print output:
 *   - A4 landscape via buildPrintDocument().
 *   - Isolated iframe via printHTML().
 *   - No DOM reads, no inputs, no cloning.
 *
 * @param {object} record - The raw record from STATE.receipts.
 */
function printSingleReceipt(record) {
  // ── Validation ─────────────────────────────────────────────────────────────
  if (!record || typeof record !== 'object') {
    console.error('[printSingleReceipt] record is missing or invalid.');
    return;
  }

  const rows = Array.isArray(record.rows) ? record.rows : [];
  if (rows.length === 0) {
    console.error('[printSingleReceipt] record has no rows — cannot print.', { id: record.id });
    return;
  }

  const dataRows = rows.filter((r) => r && r._type !== 'separator');
  if (dataRows.length === 0) {
    console.error('[printSingleReceipt] record has no data rows (only separators) — cannot print.', { id: record.id });
    return;
  }

  // ── Build & print ──────────────────────────────────────────────────────────
  try {
    const receiptNumber = record.receipt_number ? ` — ${record.receipt_number}` : '';
    const title         = `نموذج الصرف${receiptNumber}`;
    const body          = _receiptPrintBuildBody(record);

    const html = buildPrintDocument({
      title,
      body,
      orientation: 'landscape',
      extraCSS: `
        .print-separator td {
          background: #fff7ed !important;
          border-top: 2px solid #fb923c !important;
          color: #9a3412;
          font-weight: 700;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
      `,
    });

    printHTML(html, { id: 'receipt-card-print-iframe' });

  } catch (err) {
    console.error('[printSingleReceipt] Failed to build print document:', err);
  }
}

// ─── END: RECEIPT CARD PRINT SYSTEM ──────────────────────────────────────────


function printStyles() {
  return `
    * { box-sizing: border-box; }
    body {
      direction: rtl;
      font-family: 'Cairo', Arial, sans-serif;
      margin: 0;
      padding: 16px;
      color: #111827;
      font-size: 11pt;
      background: #fff;
    }
    .print-page { display: flex; flex-direction: column; gap: 20px; }
    h1 { margin: 0 0 14px; font-size: 20pt; font-weight: 800; color: #111827; text-align: center; }
    .print-card {
      border: 1.5px solid #d1d5db;
      border-radius: 10px;
      padding: 12px 14px;
      page-break-inside: avoid;
      break-inside: avoid;
    }
    .print-card--emerald { border-color: #0f766e; }
    .print-card header {
      font-size: 12pt;
      font-weight: 700;
      padding-bottom: 8px;
      margin-bottom: 6px;
      border-bottom: 2px solid #e5e7eb;
      color: #1e3a8a;
    }
    .print-card--emerald header { border-color: #0f766e; color: #0f766e; }
    .print-meta { margin: 6px 0 10px; color: #374151; font-size: 9pt; font-weight: 600; }
    table { width: 100%; border-collapse: collapse; font-size: 7.5pt; margin-bottom: 8px; }
    th, td {
      border: 1px solid #d1d5db;
      padding: 4px 5px;
      text-align: center;
      vertical-align: middle;
      word-break: break-word;
    }
    th {
      background: #1e3a8a !important;
      color: #fff !important;
      font-weight: 700;
      font-size: 7pt;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    .print-card--emerald th {
      background: #0f766e !important;
    }
    .sep-row td,
    .vehicle-separator-row td,
    .separator-row td {
      background: #fff7ed !important;
      border-top: 2px solid #fb923c !important;
      color: #9a3412;
      font-weight: 700;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    .print-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 10px 20px;
      padding: 8px 0 0;
      border-top: 1px solid #e5e7eb;
      font-size: 9pt;
      color: #374151;
    }
    .print-footer strong { color: #1e40af; font-weight: 800; }
    .print-empty { padding: 24px; text-align: center; color: #6b7280; font-size: 11pt; }
  `;
}


/**
 * Print a single receipt from saved data — same layout as receipt page printer.
 * Builds the print HTML from stored record data, no DOM/page switch needed.
 */
async function printCurrentView() {
  const html = serializeCurrentView();
  printHTML(html, { id: 'all-receipts-print-iframe' });
}

async function handleCardAction(action, id, tab) {
  const username = getSessionUsername();
  if (!username) return;

  if (tab === 'receipts' || tab === 'receipt') {
    const record = STATE.receipts.find((item) => String(item.id) === String(id));
    if (!record) return;
    if (action === 'edit-receipt') {
      if (typeof window.showPage === 'function') await window.showPage('receipt');
      await loadReceiptForEdit(record);
      return;
    }

    if (action === 'print-single-receipt') {
      printSingleReceipt(record);
      return;
    }

    if (action === 'delete-receipt') {
      if (!window.confirm('هل تريد حذف هذا النموذج؟')) return;
      await FinancialService.deleteReceipt(username, id);
      window.dispatchEvent(new CustomEvent('receipts:changed'));
      return;
    }
    if (action === 'toggle-receipt-status') {
      const control = document.querySelector(`[data-action="toggle-receipt-status"][data-id="${CSS.escape(String(id))}"]`);
      const nextStatus = String(control?.value || RECEIPT_PAYOUT_STATUS.UNPAID);
      const updatedReceipt = await FinancialService.updateReceiptStatus(username, id, nextStatus);

      // Local STATE update — no full reload needed.
      // The POST already committed all financial operations server-side.
      // The returned receipt is the final committed state.
      const idx = STATE.receipts.findIndex(r => String(r.id) === String(id));
      if (idx !== -1) {
        // Decode rows if needed (server returns decoded, but ensure consistency)
        if (updatedReceipt.rows && typeof updatedReceipt.rows === 'string') {
          updatedReceipt.rows = JSON.parse(updatedReceipt.rows) || [];
        }
        STATE.receipts[idx] = updatedReceipt;
      }
      renderAll();
      notifyReceiptStatusChanged();
      return;
    }
  }

}

/**
 * _exportReceiptsToExcel()
 *
 * Collects the receipts currently visible on screen (after all search,
 * filter, date-range, and status filters) and exports them to a single
 * flat Excel sheet via ExcelService.exportAllReceiptsRows().
 *
 * Data flow:
 *   1. getReceiptCardsFiltered() → filtered + sorted record list
 *      (same source used by renderReceiptList — guarantees we export
 *       exactly what the user sees)
 *   2. For each record, getDisplayRowsForReceipt(record) → visible rows
 *      (honours row-level text filters such as karta / vehicle search)
 *   3. Pairs { record, rows } are passed to ExcelService — no DOM reads,
 *      no DB access — pure data transform.
 *
 * Rules followed:
 *   - Only data rows exported (separator rows skipped by the service).
 *   - Empty records (0 visible data rows) are silently skipped.
 *   - No financial recalculation — values read as stored.
 */
function _exportReceiptsToExcel() {
  try {
    // Step 1: get filtered records in display order
    // renderReceiptList() applies .sort((a,b) => (b.created_at||0)-(a.created_at||0))
    // We replicate that sort here to match what the user sees exactly.
    const filtered = getReceiptCardsFiltered()
      .slice()
      .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    if (filtered.length === 0) {
      alert('لا توجد نماذج معروضة للتصدير.');
      return;
    }

    // Step 2: pair each record with its visible rows
    // getDisplayRowsForReceipt respects active row-level filters
    const receiptsWithRows = filtered.map(record => ({
      record,
      rows: getDisplayRowsForReceipt(record),
    }));

    // Step 3: delegate to excelService — pure data export, no DOM
    ExcelService.exportAllReceiptsRows(receiptsWithRows);

  } catch (err) {
    console.error('[allReceipts] Excel export failed:', err);
    alert(err.message || '❌ فشل تصدير Excel');
  }
}

function bindPageEvents() {
  const page = getPage();
  if (!page || page.dataset.bound === '1') return;
  page.dataset.bound = '1';

  page.addEventListener('click', async (event) => {
    const tabBtn = event.target.closest('[data-tab]');
    if (tabBtn && tabBtn.closest('.all-receipts-tabs')) {
      STATE.tab = tabBtn.dataset.tab;
      setActiveTabButtons();
      return;
    }

    const statusBtn = event.target.closest('[data-action="status-filter"]');
    if (statusBtn) {
      STATE.filters.receipts.status = statusBtn.dataset.status || 'all';
      _updateStatusButtonStyles();
      renderAll();
      return;
    }

    // Manual note save
    const noteSaveBtn = event.target.closest('[data-action="save-receipt-note"]');
    if (noteSaveBtn) {
      await _saveReceiptNote(noteSaveBtn.dataset.id);
      return;
    }

    if (event.target.closest('[data-action="sort-by-payout-date"]')) {
      STATE.filters.receipts.sortByPayoutDate = !STATE.filters.receipts.sortByPayoutDate;
      _updateSortButtonStyle();
      renderAll();
      return;
    }

    const rangeBtn = event.target.closest('[data-range]');
    if (rangeBtn) {
      const tab = rangeBtn.dataset.range;
      const days = Number(rangeBtn.dataset.days) || 30;
      setQuickRange(tab, days);
      clearTimeout(_filterDebounceTimer);
      _updateDateInputValues();
      await loadReceiptsData('list');
      return;
    }

    const actionBtn = event.target.closest('[data-action]');
    if (actionBtn) {
      const tab = actionBtn.dataset.tab || STATE.tab;
      const action = actionBtn.dataset.action;
      if (action === 'toggle-receipt-status') {
        return;
      }
      if (action === 'apply-filter') {
        await loadReceiptsData(_hasActiveReceiptFilters() ? 'search' : 'list');
        return;
      }
      if (action === 'print-filtered') {
        await printCurrentView();
        return;
      }
      if (action === 'export-excel-filtered' && tab === 'receipts') {
        _exportReceiptsToExcel();
        return;
      }
    }

    const recordAction = event.target.closest('[data-id][data-action]');
    if (recordAction) {
      await handleCardAction(recordAction.dataset.action, recordAction.dataset.id, recordAction.closest('[data-kind]')?.dataset.kind || STATE.tab);
      return;
    }
  });

  page.addEventListener('input', (event) => {
    const field = event.target.closest('[data-filter-tab][data-filter-key]');
    if (field) {
      const tab = field.dataset.filterTab;
      const key = field.dataset.filterKey;

      if (tab === 'receipts') {
        // Receipt date inputs trigger server re-query with options refresh.
        // Multi-select filters are handled by _onMultiSelectConfirm (no input events).
        if (key === 'from' || key === 'to') {
          setFilterValue(tab, key, field.value);
          clearTimeout(_filterDebounceTimer);
          _filterDebounceTimer = setTimeout(() => loadReceiptsData('list'), 400);
        }
      }
      return;
    }

    const noteField = event.target.closest('[data-receipt-note]');
    if (noteField) {
      const receiptId = noteField.dataset.receiptNote;
      // Enable save button when user types (no auto-save)
      const btn = document.querySelector(`[data-action="save-receipt-note"][data-id="${CSS.escape(String(receiptId))}"]`);
      if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
    }
  });

  page.addEventListener('change', async (event) => {
    // Page size selector — update STATE only, no reload (Apply button triggers reload)
    const pageSizeField = event.target.closest('select[data-action="page-size"]');
    if (pageSizeField) {
      STATE.filters.receipts.pageSize = parseInt(pageSizeField.value, 10);
      return;
    }

    const statusField = event.target.closest('select[data-action="toggle-receipt-status"]');
    if (!statusField) return;
    await handleCardAction('toggle-receipt-status', statusField.dataset.id, 'receipts');
  });
}

function renderAll() {
  setActiveTabButtons();
  // Server-filtered dataset in STATE.receipts.
  // Client-side status filter + sort applied via getReceiptCardsFiltered() + renderReceiptList().
  const _cachedReceiptsFiltered = getReceiptCardsFiltered();
  renderSummaryCards(_cachedReceiptsFiltered);
  renderLists(_cachedReceiptsFiltered);

}

async function refreshAllReceiptsPage(mode = 'list') {
  const page = getPage();
  if (!page) return;
  await loadReceiptsData(mode);
  STATE.ready = true;
}

/**
 * Phase 2 TASK F — coalesced refresh scheduler.
 *
 * Domain events frequently fire in pairs (e.g. agents:changed and
 * offices:changed back-to-back after a save).  Each listener
 * previously called refreshAllReceiptsPage → loadReceiptsData()
 * → and although a STATE.loading guard prevented the SECOND DB read,
 * the listener still ran a redundant async chain.
 *
 * This scheduler ensures that no matter how many *:changed events fire
 * in the same synchronous burst, exactly ONE loadReceiptsData() call
 * is scheduled for the next microtask.  Subsequent bursts during the
 * inflight load are deferred and run as a single re-fetch after the
 * current one settles.
 *
 * Behaviour preserved:
 *   - UI still updates after every save/delete (cache invalidation works).
 *   - First-page-load behavior unchanged (init triggers a direct refresh).
 *   - Filter clicks call refreshAllReceiptsPage(false) directly (no DB).
 */
let _refreshScheduled = false;
let _refreshInflight = false;
let _refreshAgainAfter = false;
function _scheduleAllReceiptsRefresh() {
  if (_refreshInflight) { _refreshAgainAfter = true; return; }
  if (_refreshScheduled) return;
  _refreshScheduled = true;
  queueMicrotask(async () => {
    _refreshScheduled = false;
    _refreshInflight = true;
    try {
      await refreshAllReceiptsPage('list');
    } finally {
      _refreshInflight = false;
      if (_refreshAgainAfter) {
        _refreshAgainAfter = false;
        _scheduleAllReceiptsRefresh();
      }
    }
  });
}

async function initAllReceiptsPage() {
  const page = getPage();
  if (!page) return;
  if (page.dataset.initialized === '1') return;
  page.dataset.initialized = '1';
  renderShell();
  _initMultiSelectFilters();
  bindPageEvents();
  window.applyAllReceiptsFilter = () => renderAll();
  window.refreshAllReceiptsPage = () => refreshAllReceiptsPage('list');

  // Phase 2 TASK F — coalesced single-refresh-per-burst listeners.
  window.addEventListener('receipts:changed',    _scheduleAllReceiptsRefresh);
  window.addEventListener('offices:changed',     _scheduleAllReceiptsRefresh);
  window.addEventListener('treasury:changed',    _scheduleAllReceiptsRefresh);

  await refreshAllReceiptsPage('list');
}

export { initAllReceiptsPage, refreshAllReceiptsPage, buildReceiptCardHtml, summarizeReceipts, printSingleReceipt };
