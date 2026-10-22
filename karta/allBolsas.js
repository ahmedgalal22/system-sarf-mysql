/**
 * allBolsas.js — Bolsa Forms Listing Page (جميع البوالص)
 *
 * Independent listing page for bolsa discharge records.
 * Separated from allReceipts.js during the Bolsa migration.
 *
 * Step 1: Empty shell.
 * Step 2: Data loading.
 * Step 3: Full rendering (filters, summary, cards, datalists).
 * Step 4: Card actions (edit/delete/print), bulk print, event listeners,
 *         refresh coalescing.
 */

import { ReceiptsModule } from './receipts.js';
import { ClientRepository } from './services/clientRepository.js';
import { Money } from './money.js';
import { DateUtils } from './dateUtils.js';
import { printHTML } from './printEngine.js';
import { FinancialService } from './financial.js';
import { loadBolsaForEdit } from './bolsas.js';

const PAGE_ID = 'allBolsasPage';

// ── Date formatters (same as allReceipts.js) ──────────────────────────────
// TEMPORARY DUPLICATE - Step 3 Migration
const DATE_FMT = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'full' });
const SHORT_DATE_FMT = new Intl.DateTimeFormat('ar-EG', { dateStyle: 'medium' });
const TIME_FMT = new Intl.DateTimeFormat('ar-EG', { timeStyle: 'short' });

const STATE = {
  ready: false,
  loading: false,
  bolsas: [],
  filters: createBolsaFilterState(),
};

// ── TEMPORARY DUPLICATE utilities - Step 3 Migration ──────────────────────
// These functions are copied from allReceipts.js because they are defined
// locally there and not exported. They will be deduplicated after the
// migration is complete.

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// TEMPORARY DUPLICATE - Step 3 Migration
function fmtMoney(value) { return Money.fmt(value); }

// TEMPORARY DUPLICATE - Step 3 Migration
function toNumber(value) { return Number(value) || 0; }

// TEMPORARY DUPLICATE - Step 3 Migration
function getLast30DaysRange() {
  const today = new Date();
  const to = DateUtils.toLocalDate(today);
  const fromDate = new Date(today);
  fromDate.setDate(fromDate.getDate() - 89);
  return { from: DateUtils.toLocalDate(fromDate), to };
}

// TEMPORARY DUPLICATE - Step 3 Migration
function normalizeDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return DateUtils.toLocalDate(date);
}

// TEMPORARY DUPLICATE - Step 3 Migration
function inRange(dateValue, from, to) {
  const value = normalizeDate(dateValue);
  if (!value) return false;
  if (from && value < from) return false;
  if (to && value > to) return false;
  return true;
}

// TEMPORARY DUPLICATE - Step 3 Migration
function rowContains(value, query) {
  if (!query) return true;
  return String(value ?? '').toLowerCase().includes(query);
}

// TEMPORARY DUPLICATE - Step 3 Migration
function receiptDisplayDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return SHORT_DATE_FMT.format(date);
}

// TEMPORARY DUPLICATE - Step 3 Migration
function receiptFullDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return DATE_FMT.format(date);
}

// TEMPORARY DUPLICATE - Step 3 Migration
function receiptDayName(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ar-EG', { weekday: 'long' }).format(date);
}

// TEMPORARY DUPLICATE - Step 3 Migration
function receiptTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return TIME_FMT.format(date);
}

// TEMPORARY DUPLICATE - Step 3 Migration
function summaryCard(label, value, extraClass) {
  return `
    <div class="summary-card ${extraClass}">
      <div class="summary-card__label">${esc(label)}</div>
      <div class="summary-card__value">${esc(value)}</div>
    </div>
  `;
}

// TEMPORARY DUPLICATE - Step 3 Migration
function setDatalist(id, values) {
  const list = document.getElementById(id);
  if (!list) return;
  const unique = [...new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 200);
  list.innerHTML = unique.map((value) => `<option value="${esc(value)}"></option>`).join('');
}

// TEMPORARY DUPLICATE - Step 3 Migration
function setFilterValue(key, value) {
  STATE.filters[key] = value;
}

// TEMPORARY DUPLICATE - Step 3 Migration
function setQuickRange(days) {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - (days - 1));
  STATE.filters.from = DateUtils.toLocalDate(fromDate);
  STATE.filters.to = DateUtils.toLocalDate(toDate);
  STATE.filters.date = '';
}

// ── END TEMPORARY DUPLICATES ──────────────────────────────────────────────

function getPage() {
  return document.getElementById(PAGE_ID);
}

function getSessionUsername() {
  return window.__APP_CONTEXT__?.username || '';
}

// ── Bolsa filter state ────────────────────────────────────────────────────
// TEMPORARY DUPLICATE - Step 3 Migration
function createBolsaFilterState() {
  const range = getLast30DaysRange();
  return {
    global: '',
    owner: '',
    company: '',
    date: '',
    number: '',
    vehicle: '',
    karta: '',
    agent: '',
    type: '',
    paidDate: '',
    status: 'all',
    from: range.from,
    to: range.to,
    sortByPayoutDate: false,
  };
}

// ── Bolsa data helpers ────────────────────────────────────────────────────
// TEMPORARY DUPLICATE - Step 3 Migration

function getBolsaRows(record) {
  return Array.isArray(record?.rows) ? record.rows : [];
}

function getBolsaWeight(record) {
  return getBolsaRows(record).reduce((sum, row) => sum + toNumber(row.weight) + toNumber(row.weight2), 0);
}

function getBolsaOhda(record) {
  return getBolsaRows(record).reduce((sum, row) => sum + toNumber(row.ohda), 0);
}

function getBolsaDokhan(record) {
  return getBolsaRows(record).reduce((sum, row) => sum + toNumber(row.dokhan), 0);
}

// ── Bolsa print helpers ───────────────────────────────────────────────────
// TEMPORARY DUPLICATE - Step 4 Migration

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

// TEMPORARY DUPLICATE - Step 4 Migration
function buildBolsaPrintBlock(record) {
  const rows = getBolsaRows(record);
  return `
    <section class="print-card print-card--emerald">
      <header><strong>${esc(receiptDisplayDate(record.bolsa_date))}</strong> - ${esc(receiptDayName(record.bolsa_date))} - ${esc(record.agent_name || record.agent_id || '')}</header>
      <div class="print-meta">الإجمالي الكلي: ${esc(fmtMoney(toNumber(record.totals?.grand_total)))}</div>
      <table>
        <thead>
          <tr>
            <th>رقم الكارتة</th><th>التاريخ</th><th>اسم السائق</th><th>صاحب المركبة</th><th>رقم المركبة</th>
            <th>وزن وش</th><th>اسم الشركة</th><th>التحميل</th><th>الجهة</th>
            <th>النوع</th><th>العهدة</th><th>اكرامية</th><th>نولون</th><th>سولار</th><th>ملاحظات</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((row) => `
            <tr>
              <td>${esc(row.kartaNo || '')}</td>
              <td>${esc(row.rowdate || '')}</td>
              <td>${esc(row.driver || '')}</td>
              <td>${esc(row.owner_name || '')}</td>
              <td>${esc(row.carNo || '')}</td>
              <td>${esc(row.weight ?? '')}</td>
              <td>${esc(row.office || '')}</td>
              <td>${esc(row.loading || '')}</td>
              <td>${esc(row.direction || '')}</td>
              <td>${esc(row.type || '')}</td>
              <td>${esc(row.ohda ?? '')}</td>
              <td>${esc(row.dokhan ?? '')}</td>
              <td>${esc(row.noloon ?? '')}</td>
              <td>${esc(row.solar ?? '')}</td>
              <td>${esc(row.notes || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      <div class="print-footer">
        <span>عدد الصفوف: <strong>${rows.length}</strong></span>
        <span>إجمالي الوزن: <strong>${fmtMoney(getBolsaWeight(record))}</strong></span>
        <span>إجمالي العهدة: <strong>${fmtMoney(getBolsaOhda(record))}</strong></span>
        <span>إجمالي اكرامية: <strong>${fmtMoney(getBolsaDokhan(record))}</strong></span>
        <span>الإجمالي الكلي: <strong>${fmtMoney(toNumber(record.totals?.grand_total))}</strong></span>
      </div>
    </section>
  `;
}

// TEMPORARY DUPLICATE - Step 4 Migration
function printSingleBolsa(record) {
  if (!record) return;
  const body = buildBolsaPrintBlock(record);
  const title = 'طباعة نموذج تفريغ البوالص';
  const html = `<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="UTF-8"><title>${title}</title>
<style>
body{font-family:Arial,sans-serif;direction:rtl;margin:0;padding:15mm;background:#fff;color:#000;font-size:10pt;}
table{width:100%;border-collapse:collapse;font-size:8pt;margin-bottom:8px;}
th,td{border:1px solid #000;padding:4px 5px;text-align:center;vertical-align:middle;}
th{background:#0f766e;color:#fff;font-weight:700;-webkit-print-color-adjust:exact;print-color-adjust:exact;}
.print-card{border:1.5px solid #0f766e;border-radius:8px;padding:12px 14px;margin-bottom:16px;}
.print-card header{font-size:12pt;font-weight:700;padding-bottom:8px;margin-bottom:6px;border-bottom:2px solid #0f766e;color:#0f766e;}
.print-meta{margin:6px 0 10px;color:#374151;font-size:9pt;font-weight:600;}
.print-footer{display:flex;flex-wrap:wrap;gap:10px 20px;padding:8px 0 0;border-top:1px solid #e5e7eb;font-size:9pt;color:#374151;}
.print-footer strong{color:#0f766e;font-weight:800;}
@page{size:A4 landscape;margin:10mm;}
</style></head><body>${body}</body></html>`;

  printHTML(html, { id: 'bolsa-print-iframe' });
}

/**
 * serializeBolsaCurrentView()
 *
 * Builds a full printable HTML document for all currently filtered bolsa
 * records (bulk print / PDF export). Identical layout to the allReceipts.js
 * serializeCurrentView('bolsas') branch.
 */
// TEMPORARY DUPLICATE - Step 4 Migration
function serializeBolsaCurrentView() {
  const records = getBolsaCardsFiltered();
  const title = 'تفريغ البوالص';

  const body = records.map((record) => buildBolsaPrintBlock(record)).join('');

  const content = body
    ? body
    : '<div class="print-empty">لا توجد بيانات للطباعة</div>';

  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${printStyles()}</style></head><body><div class="print-page"><h1>${esc(title)}</h1>${content}</div></body></html>`;
}

// ── Card action handler ───────────────────────────────────────────────────
// TEMPORARY DUPLICATE - Step 4 Migration (bolsa-only subset of allReceipts handleCardAction)

async function handleBolsaCardAction(action, id) {
  const username = getSessionUsername();
  if (!username) return;

  const record = STATE.bolsas.find((item) => String(item.id) === String(id));
  if (!record) return;

  if (action === 'edit-bolsa') {
    if (typeof window.showPage === 'function') await window.showPage('bolsaPage');
    loadBolsaForEdit(record);
    return;
  }
  if (action === 'print-bolsa') {
    printSingleBolsa(record);
    return;
  }
  if (action === 'delete-bolsa') {
    if (!window.confirm('هل تريد حذف سجل تفريغ البوالص؟')) return;
    try {
      await FinancialService.deleteBolsaForm(username, id);
      alert('✅ تم حذف النموذج بنجاح');
    } catch (err) {
      alert('❌ ' + (err.message || 'فشل حذف النموذج'));
    }
  }
}

// ── Bolsa filtering ───────────────────────────────────────────────────────
// TEMPORARY DUPLICATE - Step 3 Migration

function getBolsaCardsFiltered() {
  const filters = STATE.filters;
  const global = String(filters.global || '').trim().toLowerCase();
  const owner = String(filters.owner || '').trim().toLowerCase();
  const company = String(filters.company || '').trim().toLowerCase();
  const vehicle = String(filters.vehicle || '').trim().toLowerCase();
  const karta = String(filters.karta || '').trim().toLowerCase();
  const agent = String(filters.agent || '').trim().toLowerCase();
  const from = filters.from || '';
  const to = filters.to || '';
  const date = String(filters.date || '').trim();

  return STATE.bolsas
    .filter((record) => inRange(record.bolsa_date, from, to))
    .filter((record) => !date || normalizeDate(record.bolsa_date) === normalizeDate(date))
    .filter((record) => {
      const rows = Array.isArray(record.rows) ? record.rows : [];

      if (global) {
        const haystack = [
          record.bolsa_date,
          record.agent_name,
          record.agent_id,
          record.totals?.grand_total,
          ...rows.map((row) => [row.kartaNo, row.owner_name, row.carNo, row.office, row.loading, row.direction, row.notes, row.driver, row.rowdate, row.type, row.ohda, row.dokhan, row.noloon, row.solar].join(' ')),
        ].join(' ').toLowerCase();
        if (!haystack.includes(global)) return false;
      }
      if (agent && !rowContains(record.agent_name || record.agent_id, agent)) return false;
      if (owner && !rows.some((row) => rowContains(row.owner_name, owner))) return false;
      if (company && !rows.some((row) => rowContains(row.office, company))) return false;
      if (vehicle && !rows.some((row) => rowContains(row.carNo, vehicle))) return false;
      if (karta && !rows.some((row) => rowContains(row.kartaNo, karta))) return false;
      return true;
    });
}

function _bolsaRowMatchesFilters(row) {
  const filters = STATE.filters;
  const global  = String(filters.global  || '').trim().toLowerCase();
  const owner   = String(filters.owner   || '').trim().toLowerCase();
  const company = String(filters.company || '').trim().toLowerCase();
  const vehicle = String(filters.vehicle || '').trim().toLowerCase();
  const karta   = String(filters.karta   || '').trim().toLowerCase();

  if (!global && !owner && !company && !vehicle && !karta) return true;

  if (owner   && !rowContains(row.owner_name, owner))   return false;
  if (company && !rowContains(row.office, company))     return false;
  if (vehicle && !rowContains(row.carNo, vehicle))      return false;
  if (karta   && !rowContains(row.kartaNo, karta))      return false;
  if (global) {
    const hay = [row.kartaNo, row.owner_name, row.carNo, row.office, row.loading,
                 row.direction, row.notes, row.driver, row.rowdate, row.type,
                 row.ohda, row.dokhan, row.noloon, row.solar].join(' ').toLowerCase();
    if (!hay.includes(global)) return false;
  }
  return true;
}

// ── Bolsa summary ─────────────────────────────────────────────────────────
// TEMPORARY DUPLICATE - Step 3 Migration

function summarizeBolsas(records) {
  return records.reduce((acc, record) => {
    const visibleRows = getBolsaRows(record).filter(_bolsaRowMatchesFilters);
    acc.count  += visibleRows.length;
    acc.weight += visibleRows.reduce((s, r) => s + toNumber(r.weight) + toNumber(r.weight2), 0);
    acc.ohda   += visibleRows.reduce((s, r) => s + toNumber(r.ohda), 0);
    acc.dokhan += visibleRows.reduce((s, r) => s + toNumber(r.dokhan), 0);
    acc.solar  += visibleRows.reduce((s, r) => s + toNumber(r.solar), 0);
    acc.grand  += toNumber(record.totals?.grand_total);
    return acc;
  }, { weight: 0, count: 0, ohda: 0, dokhan: 0, solar: 0, grand: 0 });
}

// ── Agent enrichment ──────────────────────────────────────────────────────
// TEMPORARY DUPLICATE - Step 3 Migration

async function _enrichBolsasWithAgentName(bolsas) {
  if (!Array.isArray(bolsas) || bolsas.length === 0) return bolsas;

  const allAgents = await ClientRepository.getAgents(window.__APP_CONTEXT__?.username || 'admin');
  const nameById = new Map();
  for (const a of allAgents) {
    if (!a || a.deleted_at !== null) continue;
    nameById.set(String(a.id), String(a.name || '').trim());
  }

  return bolsas.map((record) => {
    if (record && record.agent_id != null) {
      const name = nameById.get(String(record.agent_id));
      if (name) return { ...record, agent_name: name };
    }
    return record;
  });
}

// ── Rendering ─────────────────────────────────────────────────────────────

function renderBolsasControls() {
  const f = STATE.filters;
  return `
    <div class="filter-grid bolsa-filters no-print">
      <label>
        <span>بحث عام</span>
        <input data-filter-key="global" type="text" value="${esc(f.global)}" placeholder="بحث في جميع الحقول" />
      </label>
      <label>
        <span>اسم المندوب</span>
        <input data-filter-key="agent" type="text" value="${esc(f.agent)}" placeholder="اسم المندوب" list="bolsaAgentsDatalist2" class="agent-filter" />
      </label>
      <label>
        <span>صاحب المركبة</span>
        <input data-filter-key="owner" type="text" value="${esc(f.owner)}" placeholder="صاحب المركبة" list="bolsaOwnersDatalist2" />
      </label>
      <label>
        <span>اسم الشركة</span>
        <input data-filter-key="company" type="text" value="${esc(f.company)}" placeholder="اسم الشركة" list="bolsaCompaniesDatalist2" />
      </label>
      <label>
        <span>رقم السيارة</span>
        <input data-filter-key="vehicle" type="text" value="${esc(f.vehicle)}" placeholder="رقم السيارة" list="bolsaVehiclesDatalist2" />
      </label>
      <label>
        <span>رقم الكارتة</span>
        <input data-filter-key="karta" type="text" value="${esc(f.karta)}" placeholder="رقم الكارتة" list="bolsaKartasDatalist2" />
      </label>
      <label>
        <span>التاريخ</span>
        <input data-filter-key="date" type="date" value="${esc(f.date)}" />
      </label>
    </div>
    <div class="range-toolbar no-print">
      <button type="button" data-range-days="1" class="range-btn">يوم</button>
      <button type="button" data-range-days="7" class="range-btn">أسبوع</button>
      <button type="button" data-range-days="30" class="range-btn">شهر</button>
      <label>
        <span>من</span>
        <input data-filter-key="from" type="date" value="${esc(f.from)}" />
      </label>
      <label>
        <span>إلى</span>
        <input data-filter-key="to" type="date" value="${esc(f.to)}" />
      </label>
      <button type="button" data-action="apply-filter" class="apply-btn apply-btn--bolsas">تطبيق</button>
      <button type="button" data-action="print-filtered" class="pdf-btn">📄 تصدير PDF</button>
    </div>
    <datalist id="bolsaAgentsDatalist2"></datalist>
    <datalist id="bolsaOwnersDatalist2"></datalist>
    <datalist id="bolsaCompaniesDatalist2"></datalist>
    <datalist id="bolsaVehiclesDatalist2"></datalist>
    <datalist id="bolsaKartasDatalist2"></datalist>
  `;
}

function renderSummaryCards(_preFiltered) {
  const filtered = _preFiltered || getBolsaCardsFiltered();
  const sums = summarizeBolsas(filtered);
  const html = `
    <div class="summary-grid summary-grid--bolsas">
      ${summaryCard('⚖️ إجمالي الوزن', fmtMoney(sums.weight), 'summary-card--green')}
      ${summaryCard('🗂️ عدد الكارتات', String(sums.count), 'summary-card--blue')}
      ${summaryCard('🏦 إجمالي العهدة', fmtMoney(sums.ohda), 'summary-card--blue')}
      ${summaryCard('🚬 إجمالي الاكرامية', fmtMoney(sums.dokhan), 'summary-card--orange')}
      ${summaryCard('💎 الإجمالي الكلي', fmtMoney(sums.grand), 'summary-card--violet')}
      ${summaryCard('⛽ إجمالي السولار', fmtMoney(sums.solar), 'summary-card--cyan')}
    </div>
  `;
  const container = document.getElementById('bolsasSummaryContainer2');
  if (container) container.innerHTML = html;
}

function renderBolsaList(_preFiltered) {
  const container = document.getElementById('bolsasList2');
  if (!container) return;
  const filtered = _preFiltered || getBolsaCardsFiltered();

  if (!filtered.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state__icon">📦</div>
        <p class="empty-state__text">لا توجد سجلات بعد</p>
        <p class="empty-state__sub">جرّب تغيير نطاق التاريخ أو شروط البحث</p>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered
    .sort((a, b) => new Date(b.bolsa_date || 0) - new Date(a.bolsa_date || 0))
    .map((record) => {
      const allRows = getBolsaRows(record);
      const visibleRows = allRows.filter(_bolsaRowMatchesFilters);
      if (visibleRows.length === 0) return '';
      return `
        <article class="record-card bolsa-record" data-kind="bolsa" data-id="${esc(record.id)}">
          <header class="record-card__header record-card__header--emerald">
            <div class="record-card__heading">
              <h3>${esc(receiptDisplayDate(record.bolsa_date))} — ${esc(receiptDayName(record.bolsa_date))} — ${esc(record.agent_name || record.agent_id || '—')}</h3>
              <p>عدد الصفوف: ${visibleRows.length} / ${allRows.length}</p>
              <span class="record-card__meta">تم الحفظ: ${esc(receiptFullDate(record.created_at || record.updated_at || record.bolsa_date))} ${esc(receiptTime(record.created_at || record.updated_at || record.bolsa_date))}</span>
            </div>
            <div class="record-card__actions no-print">
              <button type="button" data-action="edit-bolsa" data-id="${esc(record.id)}">✏️ تعديل</button>
              <button type="button" data-action="print-bolsa" data-id="${esc(record.id)}">🖨️ طباعة</button>
              <button type="button" data-action="delete-bolsa" data-id="${esc(record.id)}">🗑️ حذف</button>
            </div>
          </header>
          <div class="record-card__table-wrap">
            <table class="record-table record-table--emerald">
              <thead>
                <tr>
                  <th>رقم الكارتة</th>
                  <th>التاريخ</th>
                  <th>اسم السائق</th>
                  <th>صاحب المركبة</th>
                  <th>رقم المركبة</th>
                  <th>وزن وش</th>
                  <th>اسم الشركة</th>
                  <th>التحميل</th>
                  <th>الجهة</th>
                  <th>النوع</th>
                  <th>العهدة</th>
                  <th>اكرامية</th>
                  <th>نولون</th>
                  <th>سولار</th>
                  <th>ملاحظات</th>
                </tr>
              </thead>
              <tbody>
                ${visibleRows.map((row) => `
                  <tr>
                    <td>${esc(row.kartaNo || '')}</td>
                    <td>${esc(row.rowdate || '')}</td>
                    <td>${esc(row.driver || '')}</td>
                    <td>${esc(row.owner_name || '')}</td>
                    <td>${esc(row.carNo || '')}</td>
                    <td>${esc(row.weight ?? '')}</td>
                    <td>${esc(row.office || '')}</td>
                    <td>${esc(row.loading || '')}</td>
                    <td>${esc(row.direction || '')}</td>
                    <td>${esc(row.type || '')}</td>
                    <td>${esc(row.ohda ?? '')}</td>
                    <td>${esc(row.dokhan ?? '')}</td>
                    <td>${esc(row.noloon ?? '')}</td>
                    <td>${esc(row.solar ?? '')}</td>
                    <td>${esc(row.notes || '')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
          <div class="record-card__footer record-card__footer--emerald">
            <div>
              <span>عدد الصفوف</span>
              <strong>${visibleRows.length}</strong>
            </div>
            <div>
              <span>إجمالي الوزن</span>
              <strong>${fmtMoney(visibleRows.reduce((s, r) => s + toNumber(r.weight) + toNumber(r.weight2), 0))}</strong>
            </div>
            <div>
              <span>إجمالي العهدة</span>
              <strong>${fmtMoney(visibleRows.reduce((s, r) => s + toNumber(r.ohda), 0))}</strong>
            </div>
            <div>
              <span>إجمالي اكرامية</span>
              <strong>${fmtMoney(visibleRows.reduce((s, r) => s + toNumber(r.dokhan), 0))}</strong>
            </div>
            <div>
              <span>الإجمالي الكلي</span>
              <strong>${fmtMoney(toNumber(record.totals?.grand_total))}</strong>
            </div>
          </div>
        </article>
      `;
    })
    .filter(Boolean)
    .join('');
}

function renderDatalists() {
  const bolsas = STATE.bolsas;

  setDatalist('bolsaAgentsDatalist2', bolsas.map((r) => r.agent_name || r.agent_id).filter(Boolean));

  const bOwners = [];
  const bCompanies = [];
  const bVehicles = [];
  const bKartas = [];
  for (const r of bolsas) {
    for (const row of getBolsaRows(r)) {
      if (row.owner_name) bOwners.push(row.owner_name);
      if (row.office) bCompanies.push(row.office);
      if (row.carNo) bVehicles.push(row.carNo);
      if (row.kartaNo) bKartas.push(row.kartaNo);
    }
  }
  setDatalist('bolsaOwnersDatalist2', bOwners);
  setDatalist('bolsaCompaniesDatalist2', bCompanies);
  setDatalist('bolsaVehiclesDatalist2', bVehicles);
  setDatalist('bolsaKartasDatalist2', bKartas);
}

function renderAll() {
  const filtered = getBolsaCardsFiltered();
  renderSummaryCards(filtered);
  renderBolsaList(filtered);
  renderDatalists();
}

// ── Data loading ──────────────────────────────────────────────────────────

async function loadBolsasData() {
  const username = getSessionUsername();
  if (!username) return;
  if (STATE.loading) return;
  STATE.loading = true;

  try {
    const bolsas = await ReceiptsModule.getBolsaForms(username);
    STATE.bolsas = await _enrichBolsasWithAgentName(bolsas);
    renderAll();
  } finally {
    STATE.loading = false;
  }
}

// ── Shell & init ──────────────────────────────────────────────────────────

function renderShell() {
  const page = getPage();
  if (!page) return;

  page.classList.remove('card');
  page.classList.add('all-receipts-page');
  page.innerHTML = `
    <div class="all-receipts-bg">
      <div class="all-receipts-card">
        <div class="all-receipts-header">
          <h2 class="all-receipts-title">جميع سجلات تفريغ البوالص</h2>
          <p class="all-receipts-subtitle">عرض مركزي لسجلات تفريغ البوالص مع التصفية والطباعة والتعديل الآمن.</p>
        </div>
        <div class="all-receipts-panels">
          <section class="all-panel">
            ${renderBolsasControls()}
            <div id="bolsasSummaryContainer2"></div>
            <div id="bolsasList2" class="all-list"></div>
          </section>
        </div>
      </div>
    </div>
  `;
}

// ── Event handling ────────────────────────────────────────────────────────
//
// Named module-scoped handlers — enables explicit removeEventListener
// in destroyAllBolsasPage(). No anonymous listeners.

let _filterDebounceTimer = null;

function _handleBolsaPageInput(event) {
  const field = event.target.closest('[data-filter-key]');
  if (!field) return;
  const key = field.dataset.filterKey;
  setFilterValue(key, field.value);
  clearTimeout(_filterDebounceTimer);
  if (key === 'from' || key === 'to') {
    _filterDebounceTimer = setTimeout(() => loadBolsasData(), 400);
  } else {
    _filterDebounceTimer = setTimeout(renderAll, 250);
  }
}

async function _handleBolsaPageClick(event) {
  const rangeBtn = event.target.closest('[data-range-days]');
  if (rangeBtn) {
    const days = Number(rangeBtn.dataset.rangeDays) || 30;
    setQuickRange(days);
    clearTimeout(_filterDebounceTimer);
    // Update the date input values in the DOM
    const page = getPage();
    const fromInput = page?.querySelector('[data-filter-key="from"]');
    const toInput = page?.querySelector('[data-filter-key="to"]');
    if (fromInput) fromInput.value = STATE.filters.from;
    if (toInput) toInput.value = STATE.filters.to;
    loadBolsasData();
    return;
  }

  if (event.target.closest('[data-action="apply-filter"]')) {
    renderAll();
    return;
  }

  if (event.target.closest('[data-action="print-filtered"]')) {
    const html = serializeBolsaCurrentView();
    printHTML(html, { id: 'all-bolsas-print-iframe' });
    return;
  }

  // Card actions: edit / print / delete
  const recordAction = event.target.closest('[data-id][data-action]');
  if (recordAction) {
    await handleBolsaCardAction(recordAction.dataset.action, recordAction.dataset.id);
    return;
  }
}

function bindPageEvents() {
  const page = getPage();
  if (!page || page.dataset.bound === '1') return;
  page.dataset.bound = '1';

  page.addEventListener('input', _handleBolsaPageInput);
  page.addEventListener('click', _handleBolsaPageClick);
}

function unbindPageEvents(page) {
  if (!page) return;

  page.removeEventListener('input', _handleBolsaPageInput);
  page.removeEventListener('click', _handleBolsaPageClick);
  page.dataset.bound = '';
}

// ── Refresh coalescing (mirrors allReceipts.js Phase 2 TASK F) ────────────
// Domain events may fire in bursts (e.g. bolsaForms:changed + agents:changed
// back-to-back after a save). This scheduler ensures exactly ONE reload per
// burst, with deferred re-fetch if a second burst arrives during inflight load.

let _refreshScheduled = false;
let _refreshInflight  = false;
let _refreshAgainAfter = false;

function _scheduleBolsasRefresh() {
  if (_refreshInflight) { _refreshAgainAfter = true; return; }
  if (_refreshScheduled) return;
  _refreshScheduled = true;
  queueMicrotask(async () => {
    _refreshScheduled = false;
    _refreshInflight = true;
    try {
      await loadBolsasData();
    } finally {
      _refreshInflight = false;
      if (_refreshAgainAfter) {
        _refreshAgainAfter = false;
        _scheduleBolsasRefresh();
      }
    }
  });
}

// ── Page lifecycle ────────────────────────────────────────────────────────

async function initAllBolsasPage() {
  const page = getPage();
  if (!page) return;
  if (page.dataset.initialized === '1') return;
  page.dataset.initialized = '1';
  renderShell();
  bindPageEvents();

  // Event listeners — coalesced, same pattern as allReceipts.js.
  // These fire when bolsa data or agents change in any other module.
  window.addEventListener('bolsaForms:changed', _scheduleBolsasRefresh);
  window.addEventListener('agents:changed',     _scheduleBolsasRefresh);

  await loadBolsasData();
  STATE.ready = true;
}

/**
 * destroyAllBolsasPage()
 *
 * Removes window-level event listeners and resets state so the page
 * can be cleanly re-initialized if the user navigates back.
 * Called by app.js showPage() when navigating AWAY from allBolsas.
 */
function destroyAllBolsasPage() {
  const page = getPage();

  // Remove window-level event listeners
  window.removeEventListener('bolsaForms:changed', _scheduleBolsasRefresh);
  window.removeEventListener('agents:changed',     _scheduleBolsasRefresh);

  // Remove page-level event listeners (named references)
  unbindPageEvents(page);

  // Clear any pending debounce timer
  clearTimeout(_filterDebounceTimer);

  // Reset coalescing flags
  _refreshScheduled = false;
  _refreshInflight  = false;
  _refreshAgainAfter = false;

  // Allow re-initialization on next visit
  if (page) {
    page.dataset.initialized = '';
  }
}

export { initAllBolsasPage, destroyAllBolsasPage };
