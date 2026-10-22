/**
 * archiveViewer.js — Enterprise Read-Only Archive Exploration System
 * ─────────────────────────────────────────────────────────────────────────────
 * RUNTIME ISOLATION: This module is COMPLETELY isolated from the live system.
 *
 * - Uses ONLY ArchiveRepository.getArchivedRecords() — never live queries
 * - ZERO mutation paths — no edit, delete, status change, or financial writes
 * - ZERO event dispatching — no treasury:changed, receipts:changed
 * - ZERO service calls to FinancialService, TreasuryService, etc.
 * - All data is READ-ONLY and batch-scoped
 *
 * The viewer renders inside #archiveViewerPage (a separate page section).
 * When active, the main archive page hides and this page shows.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Money } from './money.js';
import { ArchiveRepository } from './services/archiveRepository.js';
import { printHTML, buildPrintDocument } from './printEngine.js';
import { ARCHIVABLE_STORES } from './archiveConstants.js';
import { buildReceiptCardHtml, summarizeReceipts, printSingleReceipt } from './allReceipts.js';

function _esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _fmt(v) { return Money.fmt(v); }
function _dateStr(v) { return v ? String(v).split('T')[0] : '—'; }

// ═══════════════════════════════════════════════════════════════════════════════
// State — completely isolated from all other modules
// ═══════════════════════════════════════════════════════════════════════════════

const VIEWER = {
  active: false,
  batchId: null,
  batch: null,
  snapshot: null,
  tab: 'treasury',
  search: '',
  data: {
    treasury: [],
    vehicle_ledger: [],
    receipts: [],
    mainCapitalTreasury: [],
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// Data Loading — read-only, batch-scoped
// ═══════════════════════════════════════════════════════════════════════════════

async function _loadBatchData(batchId) {
  VIEWER.batch = await ArchiveRepository.getBatchById(batchId);
  VIEWER.snapshot = await ArchiveRepository.getSnapshotByBatchId(batchId);

  for (const store of ARCHIVABLE_STORES) {
    VIEWER.data[store] = await ArchiveRepository.getArchivedRecords(store, batchId);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Rendering
// ═══════════════════════════════════════════════════════════════════════════════

const TAB_LABELS = {
  treasury: '💰 الخزنة',
  receipts: '📄 النماذج',
  vehicle_ledger: '📒 دفتر الحسابات',
  mainCapitalTreasury: '🏦 رأس المال',
  snapshot: '📊 اللقطة المالية',
};

function _renderViewer() {
  const page = document.getElementById('archiveViewerPage');
  if (!page) return;

  const b = VIEWER.batch;
  const tabButtons = Object.entries(TAB_LABELS).map(([key, label]) =>
    `<button type="button" data-viewer-tab="${key}" style="padding:8px 16px;border:none;border-bottom:3px solid ${VIEWER.tab === key ? '#2563eb' : 'transparent'};background:${VIEWER.tab === key ? '#eff6ff' : 'transparent'};color:${VIEWER.tab === key ? '#2563eb' : '#6b7280'};font-weight:${VIEWER.tab === key ? '700' : '500'};font-size:0.8125rem;cursor:pointer;font-family:inherit;transition:all 0.2s;">${label}</button>`
  ).join('');

  page.innerHTML = `
    <div style="background:#fef3c7;border:2px solid #f59e0b;border-radius:12px;padding:12px 20px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span style="font-size:1.25rem;">📦</span>
        <div>
          <strong style="color:#92400e;">وضع استعراض الأرشيف — البيانات للقراءة فقط</strong>
          <p style="margin:2px 0 0;font-size:0.8125rem;color:#a16207;">${_esc(b?.from_date || '')} → ${_esc(b?.to_date || '')} | ${_esc(b?.notes || '')}</p>
        </div>
      </div>
      <button type="button" data-action="close-viewer" style="background:#dc2626;color:#fff;border:none;border-radius:8px;padding:6px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">✕ إغلاق</button>
    </div>

    <div style="display:flex;flex-wrap:wrap;border-bottom:1px solid #e2e8f0;margin-bottom:16px;">
      ${tabButtons}
    </div>

    <div style="margin-bottom:12px;">
      <input id="archiveViewerSearch" type="text" placeholder="🔍 بحث داخل السجلات المؤرشفة..." value="${_esc(VIEWER.search)}"
        style="width:100%;max-width:500px;padding:10px 16px;border:1.5px solid #d1d5db;border-radius:12px;font-family:inherit;font-size:0.875rem;outline:none;box-sizing:border-box;" />
      <button type="button" data-action="print-archive-tab" style="margin-right:8px;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;border:none;border-radius:12px;padding:8px 18px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">🖨️ طباعة</button>
    </div>

    <div id="archiveViewerContent"></div>
  `;

  _renderTabContent();
}

function _renderTabContent() {
  const container = document.getElementById('archiveViewerContent');
  if (!container) return;

  if (VIEWER.tab === 'snapshot') {
    _renderSnapshotTab(container);
    return;
  }

  const records = VIEWER.data[VIEWER.tab] || [];
  const query = VIEWER.search.trim().toLowerCase();

  const filtered = query
    ? records.filter(r => JSON.stringify(r).toLowerCase().includes(query))
    : records;

  if (!filtered.length) {
    container.innerHTML = '<div style="text-align:center;padding:32px;color:#9ca3af;">لا توجد سجلات مؤرشفة في هذا القسم</div>';
    return;
  }

  switch (VIEWER.tab) {
    case 'treasury': _renderTreasuryTab(container, filtered); break;
    case 'receipts': _renderReceiptsTab(container, filtered); break;
    case 'vehicle_ledger': _renderLedgerTab(container, filtered); break;
    case 'mainCapitalTreasury': _renderCapitalTab(container, filtered); break;
    default: container.innerHTML = '<div style="padding:24px;color:#9ca3af;">غير متاح</div>';
  }
}

// ── Tab Renderers ──────────────────────────────────────────────────────────────

function _renderTreasuryTab(container, entries) {
  const dec = entries.map(Money.decimalizeRecord);
  let totalIn = 0, totalOut = 0;
  for (const e of dec) {
    if (e.type === 'deposit') totalIn += Money.toCents(e.amount);
    if (e.type === 'withdraw') totalOut += Money.toCents(e.amount);
  }

  container.innerHTML = `
    <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
      <div style="flex:1;min-width:150px;background:linear-gradient(135deg,#059669,#10b981);border-radius:12px;padding:12px;color:#fff;">
        <p style="font-size:0.75rem;opacity:0.9;margin:0;">إجمالي الداخل</p>
        <p style="font-size:1.25rem;font-weight:800;margin:4px 0 0;">${_fmt(Money.toDecimal(totalIn))}</p>
      </div>
      <div style="flex:1;min-width:150px;background:linear-gradient(135deg,#dc2626,#ef4444);border-radius:12px;padding:12px;color:#fff;">
        <p style="font-size:0.75rem;opacity:0.9;margin:0;">إجمالي الخارج</p>
        <p style="font-size:1.25rem;font-weight:800;margin:4px 0 0;">${_fmt(Money.toDecimal(totalOut))}</p>
      </div>
      <div style="flex:1;min-width:150px;background:linear-gradient(135deg,#1e40af,#3b82f6);border-radius:12px;padding:12px;color:#fff;">
        <p style="font-size:0.75rem;opacity:0.9;margin:0;">الصافي</p>
        <p style="font-size:1.25rem;font-weight:800;margin:4px 0 0;">${_fmt(Money.toDecimal(totalIn - totalOut))}</p>
      </div>
      <div style="flex:1;min-width:100px;background:linear-gradient(135deg,#6b7280,#4b5563);border-radius:12px;padding:12px;color:#fff;">
        <p style="font-size:0.75rem;opacity:0.9;margin:0;">عدد الحركات</p>
        <p style="font-size:1.25rem;font-weight:800;margin:4px 0 0;">${dec.length}</p>
      </div>
    </div>
    <div class="table-wrapper" style="max-height:60vh;overflow-y:auto;">
      <table class="table"><thead><tr>
        <th>التاريخ</th><th>النوع</th><th>الوصف</th><th>الشخص</th><th>المبلغ</th>
      </tr></thead><tbody>
      ${dec.map(e => `<tr>
        <td>${_dateStr(e.date)}</td>
        <td>${e.type === 'deposit' ? '⬇️ إيداع' : '⬆️ سحب'}</td>
        <td>${_esc(e.description || e.note || '—')}</td>
        <td>${_esc(e.client_name || e.employee_name || '—')}</td>
        <td style="font-weight:700;color:${e.type === 'deposit' ? '#059669' : '#dc2626'}">${e.type === 'deposit' ? '+' : '-'}${_fmt(e.amount)}</td>
      </tr>`).join('')}
      </tbody></table>
    </div>`;
}

function _renderReceiptsTab(container, entries) {
  // Use the SAME summarizeReceipts from allReceipts.js for consistent totals
  const sums = summarizeReceipts(entries);

  const summaryHtml = `
    <div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">
      <div style="flex:1;min-width:120px;background:linear-gradient(135deg,#6b7280,#4b5563);border-radius:12px;padding:12px;color:#fff;">
        <p style="font-size:0.75rem;opacity:0.9;margin:0;">عدد النماذج</p>
        <p style="font-size:1.25rem;font-weight:800;margin:4px 0 0;">${sums.count}</p>
      </div>
      <div style="flex:1;min-width:120px;background:linear-gradient(135deg,#2563eb,#1d4ed8);border-radius:12px;padding:12px;color:#fff;">
        <p style="font-size:0.75rem;opacity:0.9;margin:0;">الصافي المستحق</p>
        <p style="font-size:1.25rem;font-weight:800;margin:4px 0 0;">${Money.fmtCents(sums.netDue)}</p>
      </div>
      <div style="flex:1;min-width:120px;background:linear-gradient(135deg,#059669,#10b981);border-radius:12px;padding:12px;color:#fff;">
        <p style="font-size:0.75rem;opacity:0.9;margin:0;">المدفوع</p>
        <p style="font-size:1.25rem;font-weight:800;margin:4px 0 0;">${Money.fmtCents(sums.paid)}</p>
      </div>
    </div>`;

  // Render using the EXACT same card renderer as the live receipts page
  // readOnly: true — hides edit/delete/status buttons
  const sorted = [...entries].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
  const cardsHtml = sorted.map(record => buildReceiptCardHtml(record, { readOnly: true })).join('');

  container.innerHTML = summaryHtml + cardsHtml;
}

function _renderLedgerTab(container, entries) {
  const dec = entries.map(Money.decimalizeRecord);
  container.innerHTML = `
    <p style="margin-bottom:12px;color:#6b7280;font-size:0.875rem;">عدد القيود: ${dec.length}</p>
    <div class="table-wrapper" style="max-height:60vh;overflow-y:auto;">
      <table class="table"><thead><tr>
        <th>التاريخ</th><th>العميل</th><th>النوع</th><th>المبلغ</th><th>مرجع</th>
      </tr></thead><tbody>
      ${dec.map(e => `<tr>
        <td>${_dateStr(e.date)}</td>
        <td>${_esc(e.client_name || '—')}</td>
        <td>${_esc(e.type || '—')}</td>
        <td style="font-weight:700;">${_fmt(e.amount)}</td>
        <td style="font-size:0.75rem;color:#6b7280;">${_esc(e.reference_type || '—')}</td>
      </tr>`).join('')}
      </tbody></table>
    </div>`;
}

function _renderCapitalTab(container, entries) {
  const dec = entries.map(Money.decimalizeRecord);
  container.innerHTML = `
    <p style="margin-bottom:12px;color:#6b7280;font-size:0.875rem;">عدد الحركات: ${dec.length}</p>
    <div class="table-wrapper" style="max-height:60vh;overflow-y:auto;">
      <table class="table"><thead><tr>
        <th>التاريخ</th><th>النوع</th><th>المبلغ</th><th>ملاحظة</th>
      </tr></thead><tbody>
      ${dec.map(e => `<tr>
        <td>${_dateStr(e.date)}</td>
        <td>${e.type === 'deposit' ? 'إيداع' : 'سحب'}</td>
        <td style="font-weight:700;">${_fmt(e.amount)}</td>
        <td>${_esc(e.note || '—')}</td>
      </tr>`).join('')}
      </tbody></table>
    </div>`;
}

function _renderSnapshotTab(container) {
  const s = VIEWER.snapshot;
  if (!s) {
    container.innerHTML = '<div style="padding:24px;color:#9ca3af;">لا توجد لقطة مالية لهذا الأرشيف</div>';
    return;
  }

  const clients = Array.isArray(s.client_balances) ? s.client_balances : [];
  container.innerHTML = `
    <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin-bottom:16px;">
      <h3 style="margin:0 0 12px;font-size:1rem;font-weight:700;">رصيد الخزنة عند الأرشفة</h3>
      <p style="font-size:1.5rem;font-weight:800;color:#1e40af;margin:0;">${_fmt(Money.toDecimal(s.treasury_balance || 0))}</p>
      <p style="font-size:0.8125rem;color:#6b7280;margin:4px 0 0;">تاريخ اللقطة: ${_dateStr(s.snapshot_date)}</p>
    </div>
    ${clients.length ? `
      <h3 style="font-size:1rem;font-weight:700;margin:0 0 12px;">أرصدة العملاء عند الأرشفة</h3>
      <div class="table-wrapper" style="max-height:40vh;overflow-y:auto;">
        <table class="table"><thead><tr>
          <th>العميل</th><th>الرصيد</th>
        </tr></thead><tbody>
        ${clients.map(c => `<tr>
          <td>${_esc(c.name || c.id)}</td>
          <td style="font-weight:700;">${_fmt(Money.toDecimal(c.balance || 0))}</td>
        </tr>`).join('')}
        </tbody></table>
      </div>
    ` : '<p style="color:#9ca3af;">لا توجد أرصدة عملاء</p>'}
  `;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Print — read-only, from cached data
// ═══════════════════════════════════════════════════════════════════════════════

function _printCurrentTab() {
  const content = document.getElementById('archiveViewerContent');
  if (!content) return;
  const b = VIEWER.batch;
  const tabLabel = TAB_LABELS[VIEWER.tab] || VIEWER.tab;

  printHTML(buildPrintDocument({
    title: `أرشيف: ${tabLabel} (${b?.from_date || ''} → ${b?.to_date || ''})`,
    body: `
      <div style="text-align:center;margin-bottom:16px;border-bottom:2px solid #1e3a8a;padding-bottom:10px;">
        <h2 style="margin:0;color:#1e3a8a;">أرشيف: ${_esc(tabLabel)}</h2>
        <p style="margin:4px 0 0;color:#6b7280;font-size:9pt;">${_esc(b?.from_date || '')} → ${_esc(b?.to_date || '')}</p>
      </div>
      ${content.innerHTML}
    `,
    orientation: 'landscape',
  }), { id: 'archive-viewer-print' });
}

// ═══════════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Open the archive viewer for a specific batch.
 * Called from archive.js when user clicks "استعراض".
 */
async function openArchiveViewer(batchId) {
  VIEWER.active = true;
  VIEWER.batchId = batchId;
  VIEWER.tab = 'treasury';
  VIEWER.search = '';

  // Load all batch data
  await _loadBatchData(batchId);

  // Hide archive management page, show viewer
  const archivePage = document.getElementById('archivePage');
  const viewerPage = document.getElementById('archiveViewerPage');
  if (archivePage) archivePage.classList.add('hidden');
  if (viewerPage) viewerPage.classList.remove('hidden');

  _renderViewer();
}

/**
 * Close the viewer and return to archive management.
 */
function closeArchiveViewer() {
  VIEWER.active = false;
  VIEWER.batchId = null;
  VIEWER.batch = null;
  VIEWER.snapshot = null;
  VIEWER.search = '';
  for (const key of ARCHIVABLE_STORES) VIEWER.data[key] = [];

  const archivePage = document.getElementById('archivePage');
  const viewerPage = document.getElementById('archiveViewerPage');
  if (viewerPage) {
    viewerPage.classList.add('hidden');
    viewerPage.innerHTML = '';
  }
  if (archivePage) archivePage.classList.remove('hidden');
}

/**
 * Check if archive viewer is currently active.
 */
function isViewerActive() {
  return VIEWER.active;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Event Handling — isolated, no mutations, no event dispatching
// ═══════════════════════════════════════════════════════════════════════════════

let _viewerBound = false;

function attachArchiveViewerListeners() {
  if (_viewerBound) return;
  _viewerBound = true;

  document.addEventListener('click', (e) => {
    const root = e.target.closest('#archiveViewerPage');
    if (!root) return;

    // Close viewer
    if (e.target.closest('[data-action="close-viewer"]')) {
      closeArchiveViewer();
      return;
    }

    // Tab switch
    const tabBtn = e.target.closest('[data-viewer-tab]');
    if (tabBtn) {
      VIEWER.tab = tabBtn.dataset.viewerTab;
      _renderViewer();
      return;
    }

    // Print whole tab
    if (e.target.closest('[data-action="print-archive-tab"]')) {
      _printCurrentTab();
      return;
    }

    // Print single receipt (read-only — reuses existing printSingleReceipt)
    const printBtn = e.target.closest('[data-action="print-single-receipt"]');
    if (printBtn && VIEWER.active) {
      const id = printBtn.dataset.id;
      const record = (VIEWER.data.receipts || []).find(r => String(r.id) === String(id));
      if (record) printSingleReceipt(record);
      return;
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'archiveViewerSearch') {
      VIEWER.search = e.target.value || '';
      _renderTabContent();
    }
  });
}

export { openArchiveViewer, closeArchiveViewer, isViewerActive, attachArchiveViewerListeners };
