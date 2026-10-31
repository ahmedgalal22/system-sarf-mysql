/**
 * test_four_ui_financial_enhancements_v2.mjs
 *
 * Automated tests for the 4 UI and Financial Workflow Enhancements and the
 * 5 corrective pass requirements:
 *   1. Treasury Page (`الخزنة`):
 *      - Search by transaction type (`النوع` column via `#treasuryTypeSearch`).
 *      - Hide `رصيد الخزنة` (Treasury Balance) when printing while keeping it visible on screen.
 *   2. Offices Page (`المكاتب`) & Ledger Date Filtering:
 *      - Local-date conversion in `_resolveRange` (`today`, `week`, `month` presets) under positive
 *        UTC offset (`Africa/Cairo`) without shifting to the previous calendar day.
 *      - Server-side `/stats/office-summary.php?from=...&to=...` on date filter without fetching
 *        the unpaginated `/entities/receipts/list.php` dataset.
 *      - Period-scoped top summary (`#officeTotalBalance` + `#officeTotalBalanceLabel` = `إجمالي الرصيد خلال الفترة`)
 *        while preserving all-time per-office row balances (`item.balance` in `#officesTableBody` and `#officeDetailsPage`).
 *      - Restoring all-time balance (including `archivedCents`) and `إجمالي الرصيد` label when cleared.
 *      - Strict calendar-date validation (`YYYY-MM-DD` only; rejecting `10/20/2026`, `2026-02-30`, `2026-13-01`, and `to < from`).
 *   3. All Forms Page (`جميع النماذج`):
 *      - Replace `إجمالي الصافي الكلي` / `إجمالي الصرف الكلي` with `إجمالي المدفوع` (`sums.paid` in cents),
 *        with deduplication across records.
 *      - Bulk-PDF summary (`_buildReceiptsBulkSummary` via `[data-action="print-filtered"]`) renders the 3 metrics
 *        (`إجمالي المدفوع | عدد الكارتات | إجمالي الصرف`) using canonical `paid` in cents and the same deduplicated scope.
 *   4. Disbursement Form Page (`نموذج الصرف`):
 *      - Column order `مكتب | الصرف | إضافة | الصافي` (`officeAmount`, `sarf`, `add`, `net`) across
 *        on-screen table, snapshot view, print layouts, and Excel exports without altering net math.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'Africa/Cairo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KARTA_DIR = path.resolve(__dirname, '..');

const elementsById = new Map();
const docClickListeners = [];
const docInputListeners = [];
const printedDocuments = [];

function makeClassList(initial = []) {
  const set = new Set(initial);
  return {
    add(...cls) { cls.forEach((c) => c && set.add(c)); },
    remove(...cls) { cls.forEach((c) => set.delete(c)); },
    contains(c) { return set.has(c); },
    toggle(c, force) {
      if (force === undefined) {
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c); return true;
      }
      if (force) set.add(c); else set.delete(c);
      return !!force;
    },
  };
}

function makeElement(id = '', tagName = 'DIV', initialClasses = []) {
  let _innerHTML = '';
  const listeners = new Map();
  const el = {
    id,
    tagName,
    value: '',
    textContent: '',
    dataset: {},
    style: { removeProperty() {} },
    children: [],
    classList: makeClassList(initialClasses),
    get innerHTML() {
      return _innerHTML;
    },
    set innerHTML(html) {
      _innerHTML = String(html ?? '');
      syncParsedElements(_innerHTML);
    },
    setAttribute(name, val) {
      if (name.startsWith('data-')) {
        const camel = name
          .slice(5)
          .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[camel] = String(val);
      }
      this[name] = String(val);
    },
    getAttribute(name) {
      if (name.startsWith('data-')) {
        const camel = name
          .slice(5)
          .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        return this.dataset[camel] ?? null;
      }
      return this[name] ?? null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    dispatchEvent() {},
    async trigger(type, eventObj) {
      const list = listeners.get(type) || [];
      for (const fn of list) {
        await fn(eventObj);
      }
    },
    appendChild(child) {
      if (child && child.id) elementsById.set(child.id, child);
      return child;
    },
    remove() {},
    querySelector(sel) {
      if (typeof sel === 'string' && sel.startsWith('#')) {
        return elementsById.get(sel.slice(1)) || null;
      }
      return null;
    },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
  if (id) elementsById.set(id, el);
  return el;
}

function syncParsedElements(html) {
  const tagWithIdRegex = /<([a-zA-Z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>([\s\S]*?)<\/\1>|<([a-zA-Z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)\/?>/g;
  let match;
  while ((match = tagWithIdRegex.exec(html)) !== null) {
    const tag = (match[1] || match[5]).toUpperCase();
    const attrs = match[2] || match[6];
    const id = match[3] || match[7];
    const innerText = match[4];
    const classMatch = attrs.match(/\bclass="([^"]+)"/);
    const classes = classMatch ? classMatch[1].trim().split(/\s+/) : [];
    let el = elementsById.get(id);
    if (!el) {
      el = makeElement(id, tag, classes);
    } else {
      el.tagName = tag;
      el.classList = makeClassList(classes);
    }
    const valMatch = attrs.match(/\bvalue="([^"]*)"/);
    if (valMatch) el.value = valMatch[1];
    if (innerText !== undefined && !innerText.includes('<')) {
      el.textContent = innerText;
    }
  }
}

makeElement('treasuryPage', 'SECTION');
makeElement('officesPage', 'SECTION');
makeElement('allReceiptsPage', 'DIV');
makeElement('receiptPage', 'DIV');

let mockTreasuryEntries = [];
let mockOffices = [];
let mockOfficeLedgerEntries = [];
let mockOfficeArchivedLedgerEntries = [];
let mockOfficeSummaries = [];
let mockReceipts = [];
let fetchedUrls = [];
let lastLedgerRequestUrl = '';
let lastOfficeSummaryUrl = '';

const mockDocument = {
  head: makeElement('head', 'HEAD'),
  body: {
    dataset: {},
    appendChild(child) {
      if (child && child.id) elementsById.set(child.id, child);
      if (child && child.tagName === 'IFRAME') {
        child.contentWindow = {
          document: {
            open() {},
            write(html) { printedDocuments.push(String(html ?? '')); },
            close() {},
          },
          focus() {},
          print() {},
        };
      }
      return child;
    },
  },
  getElementById(id) {
    return elementsById.get(id) ?? null;
  },
  createElement(tag) {
    const t = String(tag).toUpperCase();
    const el = makeElement('', t);
    if (t === 'DIV') {
      Object.defineProperty(el, 'firstElementChild', {
        get() { return makeElement('', 'DIV'); },
      });
    }
    return el;
  },
  querySelector(sel) {
    if (typeof sel === 'string' && sel.startsWith('#')) {
      return elementsById.get(sel.slice(1)) ?? null;
    }
    return null;
  },
  querySelectorAll() {
    return [];
  },
  addEventListener(type, fn) {
    if (type === 'click') docClickListeners.push(fn);
    if (type === 'input') docInputListeners.push(fn);
  },
};

globalThis.document = mockDocument;
globalThis.window = {
  SERVER_MODE_READY: true,
  __APP_CONTEXT__: { username: 'admin' },
  location: { href: 'http://localhost/karta/index.html', origin: 'http://localhost' },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};
globalThis.sessionStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.detail = opts.detail;
  }
};
globalThis.confirm = () => true;
globalThis.alert = () => {};

globalThis.fetch = async (url) => {
  const u = String(url);
  fetchedUrls.push(u);
  const respond = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  });

  if (u.includes('/auth/login.php')) {
    return respond({
      success: true,
      data: { id: 1, username: 'admin', display_name: 'Admin' },
    });
  }

  if (u.includes('/entities/treasury/list.php')) {
    return respond({ success: true, data: mockTreasuryEntries });
  }

  if (u.includes('/entities/offices/list.php')) {
    return respond({ success: true, data: mockOffices });
  }

  if (u.includes('/stats/office-summary.php')) {
    lastOfficeSummaryUrl = u;
    return respond({ success: true, data: mockOfficeSummaries });
  }

  if (u.includes('/entities/receipts/list.php')) {
    return respond({ success: true, data: mockReceipts });
  }

  if (u.includes('/entities/vehicle-ledger/list.php')) {
    lastLedgerRequestUrl = u;
    const parsed = new URL(u, 'http://localhost');
    const cid = parsed.searchParams.get('client_id');
    const ctype = parsed.searchParams.get('client_type');
    const fromParam = parsed.searchParams.get('from');
    const toParam = parsed.searchParams.get('to');

    let rows = mockOfficeLedgerEntries.filter(
      (e) => String(e.client_id) === String(cid) && e.client_type === ctype && !e.is_reversed
    );
    if (fromParam) rows = rows.filter((e) => String(e.date).slice(0, 10) >= fromParam);
    if (toParam) rows = rows.filter((e) => String(e.date).slice(0, 10) <= toParam);
    return respond({ success: true, data: rows });
  }

  if (u.includes('/archive/list.php')) {
    return respond({ success: true, data: mockOfficeArchivedLedgerEntries });
  }

  return respond({ success: true, data: [] });
};

const { activateServerMode } = await import('../services/apiConfig.js');
activateServerMode();

const { AuthModule } = await import('../auth.js');
await AuthModule.login('admin', 'admin');

const { initTreasuryPage } = await import('../treasury.js');
const { initOfficesPage, loadOffices, attachOfficesPageListeners, OfficesModule } = await import('../offices.js');
const {
  FinancialService,
  extractLedgerEntryDateIso,
  extractLedgerEntryTimeParts,
  formatLedgerEntryTime,
  compareLedgerEntriesChronologicalAsc,
  compareLedgerEntriesChronologicalDesc,
} = await import('../financial.js');
const { summarizeReceipts, initAllReceiptsPage, refreshAllReceiptsPage, printSingleReceipt } = await import('../allReceipts.js');
const { renderReceiptSnapshotTableHead, renderReceiptSnapshotRowsHtml } = await import('../receipts.js');
const { calculateRowNet } = await import('../services/financialCalculator.js');

attachOfficesPageListeners();

test('1. Treasury Page — Search by transaction type (#treasuryTypeSearch) and hide رصيد الخزنة when printing', async () => {
  mockTreasuryEntries = [
    {
      id: 101,
      username: 'admin',
      type: 'deposit',
      effect: 'capital_deposit',
      amount: 500000, // 5000.00
      date: '2026-10-20',
      applied_at: '2026-10-20T09:00:00',
      description: 'إيداع افتتاحي',
      client_name: 'الإدارة',
      is_reversed: 0,
    },
    {
      id: 102,
      username: 'admin',
      type: 'withdraw',
      effect: 'salfa',
      amount: 120000, // 1200.00
      date: '2026-10-21',
      applied_at: '2026-10-21T10:00:00',
      description: 'سلفة سائق',
      client_name: 'أحمد حسن',
      is_reversed: 0,
    },
    {
      id: 103,
      username: 'admin',
      type: 'withdraw',
      effect: 'expense',
      amount: 45000, // 450.00
      date: '2026-10-22',
      applied_at: '2026-10-22T11:00:00',
      description: 'صيانة مكتبية',
      client_name: '',
      is_reversed: 0,
    },
  ];

  initTreasuryPage();
  await new Promise((r) => setTimeout(r, 30));

  const treasuryPageEl = elementsById.get('treasuryPage');
  assert.ok(treasuryPageEl.innerHTML.includes('id="treasuryTypeSearch"'), 'Treasury page must render #treasuryTypeSearch');

  // Verify on-screen summary cards still show رصيد الخزنة with no-print class
  const summaryCardsEl = elementsById.get('treasurySummaryCards');
  assert.ok(summaryCardsEl.innerHTML.includes('رصيد الخزنة'), 'On-screen Treasury summary must keep رصيد الخزنة visible');
  assert.ok(summaryCardsEl.innerHTML.includes('no-print'), 'On-screen رصيد الخزنة card must have print-hiding class');

  // Verify all 3 entries are initially visible
  const tbodyEl = elementsById.get('treasuryTableBody');
  assert.ok(tbodyEl.innerHTML.includes('إيداع رأس مال'));
  assert.ok(tbodyEl.innerHTML.includes('سلفة'));
  assert.ok(tbodyEl.innerHTML.includes('مصروف'));

  // Filter by transaction type "سلفة"
  const typeSearchInput = elementsById.get('treasuryTypeSearch');
  typeSearchInput.value = 'سلفة';
  for (const listener of docInputListeners) {
    listener({
      target: {
        id: 'treasuryTypeSearch',
        value: 'سلفة',
        classList: makeClassList(),
        dataset: { filter: 'treasury-type-search' },
        closest(sel) {
          return sel === '#treasuryPage' ? treasuryPageEl : null;
        },
      },
    });
  }
  await new Promise((r) => setTimeout(r, 30));

  assert.ok(tbodyEl.innerHTML.includes('أحمد حسن'), 'Matching سلفة row must remain visible');
  assert.ok(!tbodyEl.innerHTML.includes('إيداع افتتاحي'), 'Non-matching إيداع رأس مال row must be hidden');
  assert.ok(!tbodyEl.innerHTML.includes('صيانة مكتبية'), 'Non-matching مصروف row must be hidden');

  // Clear type search -> all rows return
  typeSearchInput.value = '';
  for (const listener of docInputListeners) {
    listener({
      target: {
        id: 'treasuryTypeSearch',
        value: '',
        classList: makeClassList(),
        dataset: { filter: 'treasury-type-search' },
        closest(sel) {
          return sel === '#treasuryPage' ? treasuryPageEl : null;
        },
      },
    });
  }
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(tbodyEl.innerHTML.includes('إيداع افتتاحي'));
  assert.ok(tbodyEl.innerHTML.includes('أحمد حسن'));
  assert.ok(tbodyEl.innerHTML.includes('صيانة مكتبية'));

  // Trigger Treasury print and verify رصيد الخزنة is NOT in the printed output
  printedDocuments.length = 0;
  for (const listener of docClickListeners) {
    await listener({
      target: {
        closest(sel) {
          if (sel === '#treasuryPage') return treasuryPageEl;
          if (sel === '[data-action="treasury-print-tab"]') return { dataset: { action: 'treasury-print-tab' } };
          return null;
        },
      },
    });
  }
  assert.equal(printedDocuments.length, 1, 'Treasury print action must generate a print document');
  const treasuryPrintHtml = printedDocuments[0];
  assert.ok(!treasuryPrintHtml.includes('رصيد الخزنة'), 'Printed Treasury document must NOT include رصيد الخزنة');
  assert.ok(treasuryPrintHtml.includes('إجمالي الداخل'), 'Printed Treasury document must keep other summary metrics aligned');
});

test('2. Offices Page — Preset local dates in Africa/Cairo, server-side office-summary filter, preserved all-time row balances, and strict validation', async () => {
  mockOffices = [
    { id: 1, username: 'admin', name: 'مكتب النور', phone: '01000000001', hamolaRows: [] },
    { id: 2, username: 'admin', name: 'مكتب السلام', phone: '01000000002', hamolaRows: [] },
  ];

  mockOfficeSummaries = [
    { office_name: 'مكتب النور', total_sarf: 300, total_maktab: 150, karta_count: 3, receipts_count: 2 },
    { office_name: 'مكتب السلام', total_sarf: 200, total_maktab: 100, karta_count: 2, receipts_count: 1 },
  ];

  // Office 1 active ledger: +1000.00 on 2026-10-05, +500.00 on 2026-10-15, -200.00 on 2026-10-25 (active = 1300.00)
  // Office 1 archived ledger: +200.00 on 2026-01-10 -> Office 1 all-time = 1500.00
  // Office 2 active ledger: +800.00 on 2026-10-18 -> Office 2 all-time = 800.00
  // All-time total = 1500.00 + 800.00 = 2300.00
  // Period 2026-10-10 .. 2026-10-20: Office 1 = 500.00, Office 2 = 800.00 -> Period total = 1300.00
  mockOfficeLedgerEntries = [
    { id: 1, client_id: '1', client_type: 'office', type: 'OFFICE_DEPOSIT', amount: 100000, date: '2026-10-05', is_reversed: 0 },
    { id: 2, client_id: '1', client_type: 'office', type: 'OFFICE_DEPOSIT', amount: 50000, date: '2026-10-15', is_reversed: 0 },
    { id: 3, client_id: '1', client_type: 'office', type: 'OFFICE_WITHDRAW_AUTO', amount: 20000, date: '2026-10-25', is_reversed: 0 },
    { id: 4, client_id: '2', client_type: 'office', type: 'OFFICE_DEPOSIT', amount: 80000, date: '2026-10-18', is_reversed: 0 },
  ];
  mockOfficeArchivedLedgerEntries = [
    {
      id: 900,
      status: 'archived',
      from_date: '2026-01-01',
      to_date: '2026-01-31',
      snapshot: {
        client_balances: [{ id: '1', type: 'office', balance: 20000 }],
      },
    },
  ];

  // 2A. Verify positive UTC offset (Africa/Cairo) preset date formatting does NOT shift back 1 day
  const tzOffsetMin = new Date(2026, 9, 28, 0, 0, 0).getTimezoneOffset();
  assert.ok(tzOffsetMin < 0, `Test must run in positive UTC offset timezone (Africa/Cairo), got offset=${tzOffsetMin}`);

  await OfficesModule.getOfficeSummary({ range: 'today' });
  const todayLocal = new Date();
  const expectedTodayIso = `${todayLocal.getFullYear()}-${String(todayLocal.getMonth() + 1).padStart(2, '0')}-${String(todayLocal.getDate()).padStart(2, '0')}`;
  assert.ok(
    lastOfficeSummaryUrl.includes(`from=${expectedTodayIso}`) && lastOfficeSummaryUrl.includes(`to=${expectedTodayIso}`),
    `Preset 'today' in Africa/Cairo must resolve to local date ${expectedTodayIso} without UTC day shift (got ${lastOfficeSummaryUrl})`
  );

  await OfficesModule.getOfficeSummary({ range: 'week' });
  const expectedWeekStart = new Date(todayLocal.getFullYear(), todayLocal.getMonth(), todayLocal.getDate() - todayLocal.getDay());
  const expectedWeekStartIso = `${expectedWeekStart.getFullYear()}-${String(expectedWeekStart.getMonth() + 1).padStart(2, '0')}-${String(expectedWeekStart.getDate()).padStart(2, '0')}`;
  assert.ok(
    lastOfficeSummaryUrl.includes(`from=${expectedWeekStartIso}`),
    `Preset 'week' in Africa/Cairo must start on ${expectedWeekStartIso} without UTC day shift (got ${lastOfficeSummaryUrl})`
  );

  await OfficesModule.getOfficeSummary({ range: 'month' });
  const expectedMonthStartIso = `${todayLocal.getFullYear()}-${String(todayLocal.getMonth() + 1).padStart(2, '0')}-01`;
  assert.ok(
    lastOfficeSummaryUrl.includes(`from=${expectedMonthStartIso}`),
    `Preset 'month' in Africa/Cairo must start on ${expectedMonthStartIso} (not previous month's last day), got ${lastOfficeSummaryUrl}`
  );

  // 2B. Initial unfiltered load: includes archivedCents (1500.00 + 800.00 = 2300.00) and default label 'إجمالي الرصيد'
  initOfficesPage();
  await loadOffices();

  const totalBalanceEl = elementsById.get('officeTotalBalance');
  const totalBalanceLabelEl = elementsById.get('officeTotalBalanceLabel');
  const officesTbodyEl = elementsById.get('officesTableBody');
  assert.equal(totalBalanceEl.textContent, '2300.00', 'Default unfiltered إجمالي الرصيد must equal all-time balance including archivedCents (2300.00)');
  assert.equal(totalBalanceLabelEl.textContent, 'إجمالي الرصيد', 'Default unfiltered label must be إجمالي الرصيد');
  assert.ok(officesTbodyEl.innerHTML.includes('1500.00'), 'Unfiltered table must show Office 1 all-time balance (1500.00)');
  assert.ok(officesTbodyEl.innerHTML.includes('800.00'), 'Unfiltered table must show Office 2 all-time balance (800.00)');

  // 2C. Strict date validation: reject to < from, slash dates (10/20/2026), and impossible calendar dates (2026-02-30)
  const fromEl = elementsById.get('officeDateFrom');
  const toEl = elementsById.get('officeDateTo');
  const dateMsgEl = elementsById.get('officeDateFilterMsg');

  for (const invalidPair of [
    { from: '2026-10-25', to: '2026-10-10', desc: 'to < from' },
    { from: '10/20/2026', to: '2026-10-25', desc: 'slash date 10/20/2026' },
    { from: '2026-02-30', to: '2026-03-05', desc: 'impossible date 2026-02-30' },
  ]) {
    fromEl.value = invalidPair.from;
    toEl.value = invalidPair.to;
    for (const listener of docClickListeners) {
      await listener({
        target: {
          closest(sel) {
            if (sel === '[data-action="office-apply-date-filter"]') return { dataset: { action: 'office-apply-date-filter' } };
            return null;
          },
        },
      });
    }
    assert.ok(dateMsgEl.textContent.length > 0, `Invalid filter (${invalidPair.desc}) must display validation error`);
    assert.equal(totalBalanceEl.textContent, '2300.00', `Invalid filter (${invalidPair.desc}) must not corrupt displayed إجمالي الرصيد`);
  }

  // Also test FinancialService.getClientBalance / getClientLedger direct strict date validation
  await assert.rejects(
    () => FinancialService.getClientBalance(1, 'office', { from: '10/20/2026', to: '2026-10-25' }),
    /YYYY-MM-DD/,
    'FinancialService.getClientBalance must reject non-ISO slash date 10/20/2026'
  );
  await assert.rejects(
    () => FinancialService.getClientBalance(1, 'office', { from: '2026-02-30', to: '2026-03-01' }),
    /YYYY-MM-DD/,
    'FinancialService.getClientBalance must reject impossible calendar date 2026-02-30'
  );
  await assert.rejects(
    () => FinancialService.getClientBalance(1, 'office', { from: '2026-13-01', to: '2026-13-10' }),
    /YYYY-MM-DD/,
    'FinancialService.getClientBalance must reject invalid month 2026-13-01'
  );
  await assert.rejects(
    () => FinancialService.getClientBalance(1, 'office', { from: '2026-10-25', to: '2026-10-10' }),
    /تاريخ النهاية/,
    'FinancialService.getClientBalance must reject to < from'
  );

  // 2D. Valid date range: 2026-10-10 to 2026-10-20
  fetchedUrls = [];
  fromEl.value = '2026-10-10';
  toEl.value = '2026-10-20';
  for (const listener of docClickListeners) {
    await listener({
      target: {
        closest(sel) {
          if (sel === '[data-action="office-apply-date-filter"]') return { dataset: { action: 'office-apply-date-filter' } };
          return null;
        },
      },
    });
  }

  assert.equal(dateMsgEl.textContent, '', 'Valid date range must clear validation error');
  assert.equal(totalBalanceEl.textContent, '1300.00', 'Filtered top summary must equal period balance (500.00 + 800.00 = 1300.00)');
  assert.equal(totalBalanceLabelEl.textContent, 'إجمالي الرصيد خلال الفترة', 'Filtered top summary label must indicate period-scoped balance');

  // Verify NO unpaginated receipt fetch occurred and /stats/office-summary.php received from/to
  const receiptFetchCalls = fetchedUrls.filter((u) => u.includes('/entities/receipts/list.php'));
  assert.equal(receiptFetchCalls.length, 0, 'Applying date filter on Offices page must NOT fetch unpaginated /entities/receipts/list.php');
  assert.ok(
    lastOfficeSummaryUrl.includes('from=2026-10-10') && lastOfficeSummaryUrl.includes('to=2026-10-20'),
    '/stats/office-summary.php must be called with from=2026-10-10&to=2026-10-20'
  );
  assert.ok(
    lastLedgerRequestUrl.includes('from=2026-10-10') && lastLedgerRequestUrl.includes('to=2026-10-20'),
    'Backend ledger query must receive inclusive from/to params'
  );

  // Verify individual office rows in #officesTableBody STILL display all-time balances (1500.00 and 800.00)
  assert.ok(
    officesTbodyEl.innerHTML.includes('1500.00'),
    'Individual office row for Office 1 in #officesTableBody must preserve its all-time balance (1500.00) even when date filter is active'
  );
  assert.ok(
    !officesTbodyEl.innerHTML.includes('>500.00<'),
    'Individual office row for Office 1 must NOT be overwritten with its 500.00 period balance'
  );

  // 2E. Clear/reset date filter -> restores 2300.00 all-time total (including archivedCents) and default label
  for (const listener of docClickListeners) {
    await listener({
      target: {
        closest(sel) {
          if (sel === '[data-action="office-clear-date-filter"]') return { dataset: { action: 'office-clear-date-filter' } };
          return null;
        },
      },
    });
  }

  assert.equal(fromEl.value, '');
  assert.equal(toEl.value, '');
  assert.equal(totalBalanceEl.textContent, '2300.00', 'Clearing date filter must restore all-time إجمالي الرصيد including archivedCents (2300.00)');
  assert.equal(totalBalanceLabelEl.textContent, 'إجمالي الرصيد', 'Clearing date filter must restore default label إجمالي الرصيد');

  // 2F. Verify PHP endpoints enforce strict calendar-date checkdate() validation
  const ledgerListPhp = fs.readFileSync(path.join(KARTA_DIR, 'api/entities/vehicle-ledger/list.php'), 'utf8');
  const officeSummaryPhp = fs.readFileSync(path.join(KARTA_DIR, 'api/stats/office-summary.php'), 'utf8');
  assert.ok(ledgerListPhp.includes('checkdate('), 'vehicle-ledger/list.php must validate calendar dates via checkdate()');
  assert.ok(officeSummaryPhp.includes('checkdate('), 'stats/office-summary.php must validate calendar dates via checkdate()');
});

test('3. All Forms Page (جميع النماذج) — On-screen summary cards and bulk-PDF summary match (إجمالي المدفوع | عدد الكارتات | إجمالي الصرف)', async () => {
  mockReceipts = [
    {
      id: 'rec-1',
      receipt_number: '1001',
      receipt_date: '2026-10-20',
      client_name: 'عميل 1',
      total: 400000,
      general_add: 0,
      net_due: 400000,
      previous_balance: 0,
      net_total: 400000,
      paid: 350000, // 3500.00
      sarf: 100,
      rows: [
        { _rowId: 'r1', kartano: 'K1', weight: 20, deficit: 0, noloon: 200, ohda: 0, officeAmount: 0, sarf: 100, add: 0, net: 3900 },
      ],
    },
    {
      id: 'rec-2',
      receipt_number: '1002',
      receipt_date: '2026-10-21',
      client_name: 'عميل 2',
      total: 300000,
      general_add: 0,
      net_due: 300000,
      previous_balance: -50000,
      net_total: 250000,
      paid: 250000, // 2500.00
      sarf: 50,
      rows: [
        { _rowId: 'r2', kartano: 'K2', weight: 15, deficit: 0, noloon: 200, ohda: 0, net: 2950, officeAmount: 0, sarf: 50, add: 0 },
      ],
    },
  ];

  // Verify summarizeReceipts deduplicates duplicate IDs and sums canonical paid field (in cents)
  const summaryWithDup = summarizeReceipts([mockReceipts[0], mockReceipts[1], mockReceipts[0]]);
  assert.equal(summaryWithDup.paid, 600000, 'summarizeReceipts must sum paid (350000 + 250000 = 600000 cents) without double-counting duplicates');
  assert.equal(summaryWithDup.count, 2, 'summarizeReceipts must count 2 karta rows without double-counting');
  assert.equal(summaryWithDup.sarf, 150, 'summarizeReceipts must sum sarf (100 + 50 = 150) without double-counting');

  await initAllReceiptsPage();
  await refreshAllReceiptsPage('list');

  const summaryContainer = elementsById.get('receiptsSummaryContainer');
  assert.ok(summaryContainer, '#receiptsSummaryContainer must exist');
  assert.ok(summaryContainer.innerHTML.includes('إجمالي المدفوع'), 'Summary area must display إجمالي المدفوع');
  assert.ok(summaryContainer.innerHTML.includes('6000.00'), 'إجمالي المدفوع must display 6000.00');
  assert.ok(!summaryContainer.innerHTML.includes('إجمالي الصافي الكلي'), 'إجمالي الصافي الكلي must be removed from summary area');
  assert.ok(!summaryContainer.innerHTML.includes('إجمالي الصرف الكلي'), 'إجمالي الصرف الكلي must not appear in summary area');
  assert.ok(summaryContainer.innerHTML.includes('عدد الكارتات'), 'عدد الكارتات must remain in summary area');
  assert.ok(summaryContainer.innerHTML.includes('إجمالي الصرف'), 'إجمالي الصرف must remain in summary area');

  // Trigger bulk-PDF export ([data-action="print-filtered"]) and verify _buildReceiptsBulkSummary matches the 3-card UI
  printedDocuments.length = 0;
  const allReceiptsPageEl = elementsById.get('allReceiptsPage');
  await allReceiptsPageEl.trigger('click', {
    target: {
      closest(sel) {
        if (sel === '[data-action]') return { dataset: { action: 'print-filtered', tab: 'receipts' } };
        return null;
      },
    },
  });

  assert.equal(printedDocuments.length, 1, 'Bulk PDF export action (print-filtered) must produce a print document');
  const bulkPdfHtml = printedDocuments[0];
  const firstTableEnd = bulkPdfHtml.indexOf('</table>');
  assert.ok(firstTableEnd > 0, 'Bulk PDF must contain summary table at top');
  const bulkSummaryTableHtml = bulkPdfHtml.slice(0, firstTableEnd);

  assert.ok(bulkSummaryTableHtml.includes('إجمالي المدفوع'), 'Bulk PDF summary table must include إجمالي المدفوع');
  assert.ok(bulkSummaryTableHtml.includes('عدد الكارتات'), 'Bulk PDF summary table must include عدد الكارتات');
  assert.ok(bulkSummaryTableHtml.includes('إجمالي الصرف'), 'Bulk PDF summary table must include إجمالي الصرف');
  assert.ok(bulkSummaryTableHtml.includes('>6000.00<'), 'Bulk PDF summary table must render canonical paid in cents formatted as 6000.00');
  assert.ok(bulkSummaryTableHtml.includes('>2<'), 'Bulk PDF summary table must render deduplicated karta count 2');
  assert.ok(bulkSummaryTableHtml.includes('>150.00<'), 'Bulk PDF summary table must render total sarf 150.00');
  assert.ok(!bulkSummaryTableHtml.includes('الصافي المستحق'), 'Bulk PDF summary table must NOT render legacy 7-column الصافي المستحق header');
  assert.ok(!bulkSummaryTableHtml.includes('الصافي الكلي'), 'Bulk PDF summary table must NOT render legacy 7-column الصافي الكلي header');
  assert.ok(!bulkSummaryTableHtml.includes('إجمالي الوزن'), 'Bulk PDF summary table must NOT render legacy 7-column إجمالي الوزن header');
  assert.ok(!bulkSummaryTableHtml.includes('إجمالي النولون'), 'Bulk PDF summary table must NOT render legacy 7-column إجمالي النولون header');
  assert.ok(!bulkSummaryTableHtml.includes('إجمالي العهدة'), 'Bulk PDF summary table must NOT render legacy 7-column إجمالي العهدة header');
});

test('4. Disbursement Form Page (نموذج الصرف) — Column order مكتب | الصرف | إضافة | الصافي across screen, snapshot, print, and Excel export', () => {
  // 4A. Snapshot table header order
  const headHtml = renderReceiptSnapshotTableHead({ showRowStatus: true });
  const maktabIdx = headHtml.indexOf('>مكتب<');
  const sarfIdx = headHtml.indexOf('>الصرف<');
  const addIdx = headHtml.indexOf('>إضافة<');
  const netIdx = headHtml.indexOf('>الصافي<');

  assert.ok(maktabIdx !== -1 && sarfIdx !== -1 && addIdx !== -1 && netIdx !== -1, 'All 4 headers must be present');
  assert.ok(
    maktabIdx < sarfIdx && sarfIdx < addIdx && addIdx < netIdx,
    `Snapshot header order must be مكتب -> الصرف -> إضافة -> الصافي (got indices ${maktabIdx}, ${sarfIdx}, ${addIdx}, ${netIdx})`
  );

  // 4B. Snapshot row cell alignment
  const sampleRow = {
    _rowId: 'row-order-1',
    kartano: '9001',
    date: '2026-10-28',
    data: 'سائق تجريبي',
    car: 'أ ب ج 123',
    weight: 10,
    deficit: 0,
    office: 'مكتب النور',
    loading: 'طنطا',
    taktik: 'القاهرة',
    type: 'قمح',
    noloon: 100,
    ohda: 50,
    officeAmount: 111,
    sarf: 222,
    add: 333,
    net: 970,
  };
  const rowHtml = renderReceiptSnapshotRowsHtml([sampleRow], { showRowStatus: false, readOnly: true });
  const val111Idx = rowHtml.indexOf('>111<');
  const val222Idx = rowHtml.indexOf('>222<');
  const val333Idx = rowHtml.indexOf('>333.00<');
  const val970Idx = rowHtml.indexOf('>970.00<');
  assert.ok(
    val111Idx < val222Idx && val222Idx < val333Idx && val333Idx < val970Idx,
    `Snapshot row cells must align with مكتب (111) -> الصرف (222) -> إضافة (333.00) -> الصافي (970.00)`
  );

  // 4C. Single-receipt print column order
  printedDocuments.length = 0;
  printSingleReceipt({
    id: 'rec-print-1',
    receipt_number: '5001',
    receipt_date: '2026-10-28',
    client_name: 'عميل طباعة',
    total: 97000,
    general_add: 0,
    net_due: 97000,
    previous_balance: 0,
    net_total: 97000,
    paid: 97000,
    rows: [sampleRow],
  });
  assert.equal(printedDocuments.length, 1, 'printSingleReceipt must produce print HTML');
  const printDoc = printedDocuments[0];
  const pMaktabIdx = printDoc.indexOf('>مكتب<');
  const pSarfIdx = printDoc.indexOf('>الصرف<');
  const pAddIdx = printDoc.indexOf('>إضافة<');
  const pNetIdx = printDoc.indexOf('>الصافي<');
  assert.ok(
    pMaktabIdx < pSarfIdx && pSarfIdx < pAddIdx && pAddIdx < pNetIdx,
    'Print header order must be مكتب -> الصرف -> إضافة -> الصافي'
  );
  const pVal111 = printDoc.indexOf('>111.00<');
  const pVal222 = printDoc.indexOf('>222.00<');
  const pVal333 = printDoc.indexOf('>333.00<');
  const pVal970 = printDoc.indexOf('>970.00<');
  assert.ok(
    pVal111 < pVal222 && pVal222 < pVal333 && pVal333 < pVal970,
    'Print row cells must align with مكتب (111.00) -> الصرف (222.00) -> إضافة (333.00) -> الصافي (970.00)'
  );

  // 4D. ExcelService column definitions order
  const excelSrc = fs.readFileSync(path.join(KARTA_DIR, 'excelService.js'), 'utf8');
  const receiptColsBlock = excelSrc.slice(
    excelSrc.indexOf('const _RECEIPT_COLS ='),
    excelSrc.indexOf('const _RECEIPT_REQUIRED_HEADERS')
  );
  assert.ok(
    receiptColsBlock.indexOf("key: 'officeAmount'") < receiptColsBlock.indexOf("key: 'sarf'") &&
      receiptColsBlock.indexOf("key: 'sarf'") < receiptColsBlock.indexOf("key: 'add'"),
    '_RECEIPT_COLS in excelService.js must order officeAmount -> sarf -> add'
  );

  const allReceiptsColsBlock = excelSrc.slice(
    excelSrc.indexOf('const _ALL_RECEIPTS_COLS ='),
    excelSrc.indexOf('function _allReceiptsNum')
  );
  assert.ok(
    allReceiptsColsBlock.indexOf("header: 'مكتب'") < allReceiptsColsBlock.indexOf("header: 'الصرف'") &&
      allReceiptsColsBlock.indexOf("header: 'الصرف'") < allReceiptsColsBlock.indexOf("header: 'اضافة'") &&
      allReceiptsColsBlock.indexOf("header: 'اضافة'") < allReceiptsColsBlock.indexOf("header: 'الصافي'"),
    '_ALL_RECEIPTS_COLS in excelService.js must order مكتب -> الصرف -> اضافة -> الصافي'
  );

  // 4E. Row net calculation formula unchanged: (10*100) - (50+111+222) + 333 = 950
  const computedNet = calculateRowNet(sampleRow);
  assert.equal(computedNet, 950, 'calculateRowNet formula must remain (10*100) - (50+111+222) + 333 = 950');
});

test('5. Disbursement Form & All Disbursement Forms — Show اسم المكتب in print, rename وزن وش to الوزن, and always print الوزن even when zero or empty', async () => {
  // 5A. Verify receipts.js COL_DEFS sets printConditional: false on weight (الوزن) and printHide: false on office (اسم المكتب)
  const receiptsSrc = fs.readFileSync(path.join(KARTA_DIR, 'receipts.js'), 'utf8');
  assert.ok(
    /key:\s*'weight'[^\n]*label:\s*'الوزن'[^\n]*printHide:\s*false\s*,\s*printConditional:\s*false/.test(receiptsSrc),
    'receipts.js COL_DEFS must configure weight (الوزن) with printHide: false, printConditional: false'
  );
  assert.ok(
    /key:\s*'office'[^\n]*label:\s*'اسم المكتب'[^\n]*printHide:\s*false/.test(receiptsSrc),
    'receipts.js COL_DEFS must configure office (اسم المكتب) with printHide: false'
  );

  // 5B. Verify single-receipt print in allReceipts.js includes الوزن and اسم المكتب even when weight is 0 or empty
  printedDocuments.length = 0;
  printSingleReceipt({
    id: 'rec-zero-weight',
    receipt_number: '7001',
    receipt_date: '2026-10-31',
    client_name: 'عميل صفر وزن',
    total: 50000,
    general_add: 0,
    net_due: 50000,
    previous_balance: 0,
    net_total: 50000,
    paid: 50000,
    rows: [
      {
        _rowId: 'rz-1',
        kartano: '7001',
        date: '2026-10-31',
        data: 'سائق أ',
        car: 'س ص ع 456',
        weight: 0,
        deficit: 0,
        office: 'مكتب الصفا',
        loading: 'طنطا',
        taktik: 'الإسكندرية',
        type: 'ذرة',
        noloon: 500,
        ohda: 0,
        officeAmount: 0,
        sarf: 0,
        add: 0,
        net: 500,
      },
    ],
  });

  assert.equal(printedDocuments.length, 1, 'printSingleReceipt must emit 1 print document');
  const singlePrintHtml = printedDocuments[0];
  assert.ok(singlePrintHtml.includes('>الوزن<'), 'Single receipt print must display header الوزن even when weight is 0');
  assert.ok(!singlePrintHtml.includes('وزن وش'), 'Single receipt print must NOT display legacy header وزن وش');
  assert.ok(singlePrintHtml.includes('>اسم المكتب<'), 'Single receipt print must display header اسم المكتب');
  assert.ok(singlePrintHtml.includes('>مكتب الصفا<'), 'Single receipt print must render row.office value (مكتب الصفا)');

  // 5C. Verify bulk print (print-filtered) in allReceipts.js includes الوزن and اسم المكتب when all rows have weight: 0
  mockReceipts = [
    {
      id: 'rec-bulk-zero',
      receipt_number: '7002',
      receipt_date: '2026-10-31',
      client_name: 'عميل مجمع',
      total: 50000,
      general_add: 0,
      net_due: 50000,
      previous_balance: 0,
      net_total: 50000,
      paid: 50000,
      sarf: 0,
      rows: [
        {
          _rowId: 'rz-2',
          kartano: '7002',
          date: '2026-10-31',
          data: 'سائق ب',
          car: 'أ ب ج 999',
          weight: '',
          deficit: 0,
          office: 'مكتب المروة',
          noloon: 500,
          ohda: 0,
          officeAmount: 0,
          sarf: 0,
          add: 0,
          net: 500,
        },
      ],
    },
  ];
  await refreshAllReceiptsPage('list');
  printedDocuments.length = 0;
  const allReceiptsPageEl = elementsById.get('allReceiptsPage');
  await allReceiptsPageEl.trigger('click', {
    target: {
      closest(sel) {
        if (sel === '[data-action]') return { dataset: { action: 'print-filtered', tab: 'receipts' } };
        return null;
      },
    },
  });
  assert.equal(printedDocuments.length, 1, 'Bulk print must emit 1 document');
  const bulkPrintHtml = printedDocuments[0];
  assert.ok(bulkPrintHtml.includes('>الوزن<'), 'Bulk print must always include الوزن header even when weight is empty');
  assert.ok(!bulkPrintHtml.includes('وزن وش'), 'Bulk print must NOT include legacy وزن وش header');
  assert.ok(bulkPrintHtml.includes('>اسم المكتب<'), 'Bulk print must include اسم المكتب header');
  assert.ok(bulkPrintHtml.includes('>مكتب المروة<'), 'Bulk print must render row.office value (مكتب المروة)');

  // 5D. Verify excelService.js headers use الوزن while preserving legacyHeader: 'وزن وش' for import compatibility
  const excelSrc = fs.readFileSync(path.join(KARTA_DIR, 'excelService.js'), 'utf8');
  assert.ok(
    /key:\s*'weight'\s*,\s*header:\s*'الوزن'\s*,\s*legacyHeader:\s*'وزن وش'/.test(excelSrc),
    'excelService.js _RECEIPT_COLS must use header: الوزن and preserve legacyHeader: وزن وش'
  );
  const allReceiptsColsSection = excelSrc.slice(
    excelSrc.indexOf('const _ALL_RECEIPTS_COLS ='),
    excelSrc.indexOf('function _allReceiptsNum')
  );
  assert.ok(allReceiptsColsSection.includes("header: 'الوزن'"), '_ALL_RECEIPTS_COLS must use header: الوزن');
  assert.ok(!allReceiptsColsSection.includes("header: 'وزن وش'"), '_ALL_RECEIPTS_COLS must not use legacy header: وزن وش');
});

test('6. Vehicle Owner Details & Office Details — الوقت column after التاريخ, Africa/Cairo wall-clock time formatting & fallback, and exact-inverse chronological sorting', async () => {
  // 6A. Primary source (applied_at) vs fallback (created_at) vs missing ('—')
  const withAppliedIso = {
    id: 10,
    date: '2026-10-31',
    applied_at: '2026-10-31T14:25:30',
    created_at: '2026-10-31 10:00:00.000',
  };
  const partsApplied = extractLedgerEntryTimeParts(withAppliedIso);
  assert.equal(partsApplied.source, 'applied_at');
  assert.equal(partsApplied.hour, 14);
  assert.equal(partsApplied.minute, 25);
  assert.equal(partsApplied.second, 30);

  const expectedAr1425 = new Intl.DateTimeFormat('ar-EG', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(2000, 0, 1, 14, 25, 30)));
  assert.equal(formatLedgerEntryTime(withAppliedIso), expectedAr1425, 'formatLedgerEntryTime must format applied_at in ar-EG without timezone shift');

  // Fallback to created_at when applied_at is date-only or empty
  const withDateOnlyApplied = {
    id: 11,
    date: '2026-10-31',
    applied_at: '2026-10-31',
    created_at: '2026-10-31 09:05:12.450',
  };
  const partsCreated = extractLedgerEntryTimeParts(withDateOnlyApplied);
  assert.equal(partsCreated.source, 'created_at', 'Date-only applied_at must fall back to created_at');
  assert.equal(partsCreated.hour, 9);
  assert.equal(partsCreated.minute, 5);
  assert.equal(partsCreated.second, 12);
  assert.equal(partsCreated.millis, 450);

  // Missing time in both applied_at and created_at -> '—'
  const withoutTime = {
    id: 12,
    date: '2026-10-31',
    applied_at: '2026-10-31',
    created_at: '',
  };
  assert.equal(extractLedgerEntryTimeParts(withoutTime), null);
  assert.equal(formatLedgerEntryTime(withoutTime), '—', 'Entries without any time component must display —');

  // 6B. Verify compareLedgerEntriesChronologicalAsc and compareLedgerEntriesChronologicalDesc are exact inverses
  const sampleEntries = [
    { id: 1, date: '2026-10-29', applied_at: '2026-10-29T18:00:00', amount: 10000 },
    { id: 2, date: '2026-10-30', applied_at: '', created_at: '', amount: 20000 },
    { id: 3, date: '2026-10-30', applied_at: '2026-10-30T08:15:00', amount: 30000 },
    { id: 4, date: '2026-10-30', applied_at: '2026-10-30', created_at: '2026-10-30 11:45:00.000', amount: 40000 },
    { id: 5, date: '2026-10-30', applied_at: '2026-10-30T11:45:00', amount: 50000 },
    { id: 6, date: '2026-10-31', applied_at: '2026-10-31T07:00:00', amount: 60000 },
  ];

  for (const a of sampleEntries) {
    for (const b of sampleEntries) {
      const asc = compareLedgerEntriesChronologicalAsc(a, b);
      const desc = compareLedgerEntriesChronologicalDesc(a, b);
      assert.equal(desc, asc === 0 ? 0 : -asc, `Asc and Desc comparators must be exact inverses for ids (${a.id}, ${b.id})`);
    }
  }

  const ascIds = sampleEntries.slice().sort(compareLedgerEntriesChronologicalAsc).map((e) => e.id);
  const descIds = sampleEntries.slice().sort(compareLedgerEntriesChronologicalDesc).map((e) => e.id);
  assert.deepEqual(ascIds, [1, 2, 3, 4, 5, 6], 'Ascending chronological order must sort by date -> time (missing first) -> id');
  assert.deepEqual(descIds, [6, 5, 4, 3, 2, 1], 'Descending chronological order must be the exact reverse of ascending order');

  // 6C. Verify FinancialService.getClientLedger returns newest-first using compareLedgerEntriesChronologicalDesc
  mockOfficeLedgerEntries = [
    { id: 201, client_id: '77', client_type: 'owner', type: 'deposit', amount: 10000, date: '2026-10-30', applied_at: '2026-10-30T09:00:00', is_reversed: 0 },
    { id: 202, client_id: '77', client_type: 'owner', type: 'withdraw', amount: 5000, date: '2026-10-30', applied_at: '2026-10-30T15:30:00', is_reversed: 0 },
    { id: 203, client_id: '77', client_type: 'owner', type: 'deposit', amount: 20000, date: '2026-10-30', applied_at: '2026-10-30T15:30:00', is_reversed: 0 },
    { id: 204, client_id: '77', client_type: 'owner', type: 'deposit', amount: 30000, date: '2026-10-29', applied_at: '2026-10-29T22:00:00', is_reversed: 0 },
  ];
  const ownerLedger = await FinancialService.getClientLedger('77', 'owner');
  assert.deepEqual(
    ownerLedger.map((e) => e.id),
    [203, 202, 201, 204],
    'FinancialService.getClientLedger must sort newest-first by date, time-of-day, and ID tie-breaker'
  );

  // 6D. Verify entities.js and offices.js table headers, time cells, and empty-state colspans
  const entitiesSrc = fs.readFileSync(path.join(KARTA_DIR, 'entities.js'), 'utf8');
  assert.ok(
    entitiesSrc.includes('<th>التاريخ</th>\n              <th>الوقت</th>\n              <th>المبلغ</th>\n              <th>ملاحظة</th>'),
    'entities.js _renderLedger must include <th>الوقت</th> immediately after <th>التاريخ</th>'
  );
  assert.ok(
    entitiesSrc.includes('<td colspan="4" class="text-muted text-center">لا توجد حركات</td>'),
    'entities.js _renderLedger empty state must use colspan="4"'
  );

  const officesSrc = fs.readFileSync(path.join(KARTA_DIR, 'offices.js'), 'utf8');
  assert.ok(
    officesSrc.includes('<th style="color:#fff;">التاريخ</th>\n            <th style="color:#fff;">الوقت</th>\n            <th style="color:#fff;">النوع</th>'),
    'offices.js _renderOfficeBalance must include <th>الوقت</th> immediately after <th>التاريخ</th>'
  );
  assert.ok(
    officesSrc.includes('<td colspan="6" class="text-center text-muted p-4">لا توجد حركات</td>'),
    'offices.js _renderOfficeBalance empty state must use colspan="6"'
  );
});

