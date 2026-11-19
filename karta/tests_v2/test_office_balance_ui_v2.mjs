/**
 * test_office_balance_ui_v2.mjs
 *
 * Automated tests for Office Details → Office Balance tab UI in `karta/offices.js`:
 *   1. Separate "إيداع" and "سحب" buttons replace the combined "إيداع / سحب" button.
 *   2. Each button opens the corresponding operation form directly with its operation
 *      type pre-determined and no deposit/withdrawal selector inside the form.
 *   3. Each form exposes only the three user-facing fields:
 *        1) التاريخ (date, defaulting to today)
 *        2) المبلغ (amount)
 *        3) ملاحظة (note, optional)
 *   4. Deposit and withdrawal submit through the existing handlers
 *      (`OfficesModule.depositToOffice` / `FinancialService.createOfficeDeposit` and
 *       `OfficesModule.adjustOfficeBalance` / `FinancialService.createClientBalanceEntry`).
 *   5. Validation rules (date & positive amount) and office balance / ledger behavior
 *      remain unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const elementsById = new Map();
const clickListeners = [];

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
  const el = {
    id,
    tagName,
    value: '',
    textContent: '',
    dataset: {},
    style: {},
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
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
  };
  if (id) elementsById.set(id, el);
  return el;
}

/**
 * Parse key IDs from rendered HTML fragments so `document.getElementById` can
 * inspect and interact with elements rendered into `#officeDetailsPage` and
 * `#officeDetailsContent`.
 */
function syncParsedElements(html) {
  const openTagWithIdRegex = /<([a-zA-Z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g;
  let match;
  while ((match = openTagWithIdRegex.exec(html)) !== null) {
    const tag = match[1].toUpperCase();
    const attrs = match[2];
    const id = match[3];
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
    if (valMatch) {
      el.value = valMatch[1];
    }
    const dataOpMatch = attrs.match(/\bdata-operation="([^"]*)"/);
    if (dataOpMatch) {
      el.dataset.operation = dataOpMatch[1];
    }
    const afterIdx = match.index + match[0].length;
    const closeTag = `</${match[1]}>`;
    const closeIdx = html.indexOf(closeTag, afterIdx);
    if (closeIdx !== -1) {
      const inner = html.slice(afterIdx, closeIdx);
      if (!/<[a-zA-Z0-9]+\b/.test(inner)) {
        el.textContent = inner.trim();
      }
    }
  }
}

makeElement('officesPage', 'DIV');
makeElement('officeDetailsPage', 'DIV');
makeElement('officeDetailsContent', 'DIV');

globalThis.sessionStorage = {
  _store: new Map(),
  setItem(k, v) { this._store.set(k, String(v)); },
  getItem(k) { return this._store.get(k) ?? null; },
};

globalThis.window = {
  SERVER_MODE_READY: true,
  location: { pathname: '/karta/index.html', origin: 'http://localhost', href: '' },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  showPage: async () => {},
};

globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};

globalThis.document = {
  body: {
    dataset: {},
    appendChild() {},
  },
  head: { appendChild() {} },
  getElementById(id) {
    return elementsById.get(id) || null;
  },
  createElement(tag) {
    return makeElement('', String(tag || 'div').toUpperCase());
  },
  addEventListener(type, fn) {
    if (type === 'click') clickListeners.push(fn);
  },
  removeEventListener() {},
  querySelector() { return null; },
  querySelectorAll() { return []; },
};

function triggerActionClick(action, extraDataset = {}) {
  const target = {
    dataset: { action, ...extraDataset },
    closest(selector) {
      const m = selector.match(/^\[data-action="([^"]+)"\]$/);
      if (m && m[1] === action) return this;
      return null;
    },
  };
  return Promise.all(clickListeners.map((fn) => fn({ target })));
}

const { activateServerMode } = await import('../services/apiConfig.js');
activateServerMode();

const { AuthModule } = await import('../auth.js');
const { DateUtils } = await import('../dateUtils.js');
const { OfficeRepository } = await import('../services/officeRepository.js');
const {
  OfficesModule,
  initOfficesPage,
  showOfficeDetails,
  attachOfficesPageListeners,
} = await import('../offices.js');

const OFFICE_RECORD = {
  id: '10',
  username: 'admin',
  name: 'مكتب النور للنقل',
  phone: '01000000000',
  deleted_at: null,
  hamolaRows: [],
};

let ledgerEntries = [];
const apiCalls = [];

globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  const method = (options.method || 'GET').toUpperCase();
  const bodyObj = options.body ? JSON.parse(options.body) : null;
  apiCalls.push({ url: u, method, body: bodyObj });

  let payload = { ok: true, success: true, data: [] };

  if (u.includes('/auth/login.php')) {
    payload = { ok: true, success: true, data: { username: 'admin' } };
  } else if (u.includes('/entities/offices/list.php')) {
    payload.data = [OFFICE_RECORD];
  } else if (u.includes('/entities/offices/get.php')) {
    payload = { ok: true, success: true, data: OFFICE_RECORD };
  } else if (u.includes('/entities/vehicle-ledger/list.php')) {
    payload = { ok: true, success: true, data: ledgerEntries };
  } else if (u.includes('/financial/office-deposit.php')) {
    const created = {
      id: ledgerEntries.length + 1,
      username: 'admin',
      client_id: String(bodyObj.office_id),
      client_type: 'office',
      type: bodyObj.type || 'OFFICE_DEPOSIT',
      amount: bodyObj.amount,
      reference_type: bodyObj.reference_type || 'office_deposit',
      reference_id: bodyObj.reference_id || 'ref-dep-1',
      date: bodyObj.date,
      applied_at: bodyObj.applied_at,
      is_reversed: false,
      note: bodyObj.note,
    };
    ledgerEntries.push(created);
    payload = { ok: true, success: true, data: created };
  } else if (u.includes('/entities/vehicle-ledger/create.php')) {
    const created = {
      id: ledgerEntries.length + 1,
      username: 'admin',
      client_id: String(bodyObj.client_id),
      client_type: bodyObj.client_type,
      client_name: bodyObj.client_name,
      type: bodyObj.type,
      amount: bodyObj.amount,
      reference_type: bodyObj.reference_type || 'client_balance',
      reference_id: bodyObj.reference_id || 'ref-wd-1',
      date: bodyObj.date,
      applied_at: bodyObj.applied_at,
      is_reversed: false,
      note: bodyObj.note,
    };
    ledgerEntries.push(created);
    payload = { ok: true, success: true, data: created };
  }

  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

await AuthModule.login('admin', 'admin');
attachOfficesPageListeners();

test('1. Office Balance tab renders separate "إيداع" and "سحب" buttons and removes combined "إيداع / سحب"', async () => {
  ledgerEntries = [];
  await showOfficeDetails('10');

  const balanceHtml = elementsById.get('officeDetailsContent').innerHTML;

  // Must NOT contain the old combined button text
  assert.ok(!balanceHtml.includes('إيداع / سحب'), 'Combined "إيداع / سحب" button must be removed');
  assert.ok(!balanceHtml.includes('إيداع/سحب'), 'Combined "إيداع/سحب" button must be removed');

  // Must contain two distinct buttons for Deposit ("إيداع") and Withdrawal ("سحب")
  assert.match(
    balanceHtml,
    /<button[^>]*data-action="office-deposit-open"[^>]*>\s*إيداع\s*<\/button>/,
    'Separate "إيداع" button must be rendered'
  );
  assert.match(
    balanceHtml,
    /<button[^>]*data-action="office-withdraw-open"[^>]*>\s*سحب\s*<\/button>/,
    'Separate "سحب" button must be rendered'
  );
});

test('2. Deposit and Withdrawal forms expose only Date (التاريخ), Amount (المبلغ), and Note (ملاحظة) and no operation selector', async () => {
  await showOfficeDetails('10');
  const pageHtml = elementsById.get('officeDetailsPage').innerHTML;

  // Extract the #officeDepositModal block
  const modalStart = pageHtml.indexOf('id="officeDepositModal"');
  assert.ok(modalStart !== -1, '#officeDepositModal must exist in Office Details page');
  const modalHtml = pageHtml.slice(modalStart);

  // Extract all <label> texts inside the modal
  const labels = [...modalHtml.matchAll(/<label[^>]*>([\s\S]*?)<\/label>/g)].map((m) =>
    m[1].trim()
  );
  assert.deepEqual(
    labels,
    ['التاريخ', 'المبلغ', 'ملاحظة'],
    'Form must expose only the three user-facing fields in order: التاريخ, المبلغ, ملاحظة'
  );

  // Extract all user-facing inputs/selects/textareas inside the modal
  const fieldIds = [
    ...modalHtml.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(
    fieldIds,
    ['officeDepositDate', 'officeDepositAmount', 'officeDepositNote'],
    'Form must contain only officeDepositDate, officeDepositAmount, and officeDepositNote inputs'
  );
  assert.ok(!/<select\b/i.test(modalHtml), 'Form must not include a combined deposit/withdrawal select dropdown');
  assert.ok(!/type="radio"/i.test(modalHtml), 'Form must not include radio buttons for operation type');

  // Clicking "إيداع" opens the modal in deposit mode with today's default date
  await triggerActionClick('office-deposit-open');
  const modalEl = elementsById.get('officeDepositModal');
  const titleEl = elementsById.get('officeDepositModalTitle');
  const dateEl = elementsById.get('officeDepositDate');
  assert.equal(modalEl.classList.contains('hidden'), false, 'Modal should be visible after clicking إيداع');
  assert.equal(modalEl.dataset.operation, 'deposit');
  assert.equal(titleEl.textContent, 'إيداع رصيد');
  assert.equal(dateEl.value, DateUtils.todayLocal(), 'Default date must be today');

  // Clicking "سحب" opens the modal in withdrawal mode with today's default date
  await triggerActionClick('office-deposit-close');
  assert.equal(modalEl.classList.contains('hidden'), true);

  await triggerActionClick('office-withdraw-open');
  assert.equal(modalEl.classList.contains('hidden'), false, 'Modal should be visible after clicking سحب');
  assert.equal(modalEl.dataset.operation, 'withdraw');
  assert.equal(titleEl.textContent, 'سحب رصيد');
  assert.equal(dateEl.value, DateUtils.todayLocal(), 'Default date must be today');
});

test('3. Validation rejects missing date or non-positive amount without calling backend handlers', async () => {
  await showOfficeDetails('10');
  await triggerActionClick('office-deposit-open');

  const dateEl = elementsById.get('officeDepositDate');
  const amountEl = elementsById.get('officeDepositAmount');
  const msgEl = elementsById.get('officeDepositMsg');

  const beforeCalls = apiCalls.filter(
    (c) => c.url.includes('/financial/office-deposit.php') || c.url.includes('/entities/vehicle-ledger/create.php')
  ).length;

  // Missing date
  dateEl.value = '';
  amountEl.value = '500';
  await triggerActionClick('office-deposit-save');
  assert.equal(msgEl.textContent, 'التاريخ مطلوب');

  // Zero amount
  dateEl.value = '2026-10-25';
  amountEl.value = '0';
  await triggerActionClick('office-deposit-save');
  assert.equal(msgEl.textContent, 'المبلغ مطلوب ويجب أن يكون أكبر من صفر');

  const afterCalls = apiCalls.filter(
    (c) => c.url.includes('/financial/office-deposit.php') || c.url.includes('/entities/vehicle-ledger/create.php')
  ).length;
  assert.equal(afterCalls, beforeCalls, 'No backend write should occur when validation fails');
});

test('4. Submitting Deposit and Withdrawal calls existing handlers and updates Office Balance accurately', async () => {
  ledgerEntries = [];
  await showOfficeDetails('10');

  // 1) Perform a Deposit of 1500.00 on 2026-10-20
  await triggerActionClick('office-deposit-open');
  elementsById.get('officeDepositDate').value = '2026-10-20';
  elementsById.get('officeDepositAmount').value = '1500';
  elementsById.get('officeDepositNote').value = 'دفعة أولى';
  await triggerActionClick('office-deposit-save');

  const depositCall = apiCalls.findLast((c) => c.url.includes('/financial/office-deposit.php'));
  assert.ok(depositCall, 'Deposit must submit through /financial/office-deposit.php');
  assert.equal(depositCall.body.office_id, '10');
  assert.equal(depositCall.body.type, 'OFFICE_DEPOSIT');
  assert.equal(depositCall.body.amount, 150000); // 1500.00 in cents
  assert.equal(depositCall.body.date, '2026-10-20');
  assert.equal(depositCall.body.note, 'دفعة أولى');

  let balanceHtml = elementsById.get('officeDetailsContent').innerHTML;
  assert.ok(balanceHtml.includes('1500.00'), 'Office balance must reflect 1500.00 after deposit');

  // 2) Perform a Withdrawal of 400.00 on 2026-10-22 (with optional empty note)
  await triggerActionClick('office-withdraw-open');
  elementsById.get('officeDepositDate').value = '2026-10-22';
  elementsById.get('officeDepositAmount').value = '400';
  elementsById.get('officeDepositNote').value = '';
  await triggerActionClick('office-deposit-save');

  const withdrawCall = apiCalls.findLast((c) => c.url.includes('/entities/vehicle-ledger/create.php'));
  assert.ok(withdrawCall, 'Withdrawal must submit through /entities/vehicle-ledger/create.php');
  assert.equal(withdrawCall.body.client_id, '10');
  assert.equal(withdrawCall.body.client_type, 'office');
  assert.equal(withdrawCall.body.type, 'withdraw');
  assert.equal(withdrawCall.body.amount, 40000); // 400.00 in cents
  assert.equal(withdrawCall.body.date, '2026-10-22');
  assert.equal(withdrawCall.body.note, 'سحب رصيد');

  balanceHtml = elementsById.get('officeDetailsContent').innerHTML;
  assert.ok(balanceHtml.includes('1100.00'), 'Office balance must be 1100.00 (1500 - 400) after withdrawal');
  assert.ok(balanceHtml.includes('-400.00'), 'Withdrawal row delta (-400.00) must be rendered in movement table');
});

test('Office creation modal shows only the Arabic duplicate-name message and saves no partial batch', async (t) => {
  initOfficesPage();
  await triggerActionClick('office-add');
  let names;
  t.mock.method(document, 'querySelectorAll', (sel) => sel === '#officeModalBody tr'
    ? names.map((name) => ({ querySelector: (field) => ({ value: field === '.office-modal-name' ? name : '' }) }))
    : []);
  const start = apiCalls.length;
  for (const inputs of [[` ${OFFICE_RECORD.name} `], ['مكتب الدلتا', ' مكتب الدلتا ']]) {
    names = inputs;
    await triggerActionClick('office-modal-save');
    const msg = elementsById.get('officeModalMsg');
    assert.equal(msg.textContent, `اسم هذا المكتب موجود بالفعل: ${inputs.at(-1).trim()}`);
    assert.ok(msg.classList.contains('is-visible'));
  }
  assert.ok(apiCalls.slice(start).every((call) => call.method === 'GET'));
});

test('Paid-row credit references use the receipt customer, preserving the posted amounts and running balances', async (t) => {
  const receiptRead = t.mock.method(OfficeRepository, 'getReceiptById', async (id) => id === '41'
    ? { id, client_name: 'منى علي', rows: [{ owner_name: 'مالك المركبة', office: OFFICE_RECORD.name }] }
    : null);
  const base = {
    client_id: '10', client_type: 'office', client_name: OFFICE_RECORD.name, type: 'OFFICE_DEPOSIT',
    is_reversed: 0, date: '2026-10-24', vehicle_owner_name: 'مالك المركبة',
  };
  const credit = { ...base, reference_type: 'receipt_row_disbursement', effect: 'row_disbursement',
    receipt_number: 'RC-41', note: `صرف كارتة - ${OFFICE_RECORD.name}` };
  ledgerEntries = [
    { ...base, id: 1, amount: 1000, reference_type: 'office_deposit', receipt_number: 'M-1' },
    { ...credit, id: 2, amount: 12345, reference_id: '41:row-a' },
    { ...credit, id: 3, amount: 5, is_reversed: '0', reference_id: `41:h_${'a'.repeat(32)}` },
    { ...credit, id: 4, amount: 2000, reference_id: '42:row-c', receipt_number: 'RC-42',
      note: 'إضافة رصيد - قيمة كارتة مريم <حسن>' },
  ];
  const start = apiCalls.length;
  await showOfficeDetails('10');
  const html = elementsById.get('officeDetailsContent').innerHTML;
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1);
  assert.deepEqual(rows.map(([, row]) => [...row.matchAll(/<td>(.*?)<\/td>/g)].slice(3).map((m) => m[1])), [
    ['20.00', '153.50', 'إضافة رصيد - قيمة كارتة مريم &lt;حسن&gt;'],
    ['0.05', '133.50', 'إضافة رصيد - قيمة كارتة منى علي'],
    ['123.45', '133.45', 'إضافة رصيد - قيمة كارتة منى علي'],
    ['10.00', '10.00', 'إضافة رصيد — إذن صرف رقم M-1'],
  ]);
  assert.match(html, /<p class="text-2xl font-bold balance-positive">153\.50<\/p>/);
  assert.deepEqual(receiptRead.mock.calls.map((call) => call.arguments[0]), ['41']);
  assert.ok(apiCalls.slice(start).every((call) => call.method === 'GET'));
});

// Override just one GET endpoint; all other requests still use this suite's in-memory fetch.
function mockLedgerGet(t, endpoint, respond) {
  const suiteFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const request = new URL(url, 'http://localhost');
    if (options.method === 'GET' && request.pathname.endsWith(endpoint)) return respond(request);
    return suiteFetch(url, options);
  });
}

const bareCreditReference = 'إضافة رصيد - قيمة كارتة';
for (const [scenario, client_name, expected] of [
  ['U+0085 only', '\u0085', bareCreditReference],
  ['U+0085 at both edges', '\u0085منى علي\u0085', `${bareCreditReference} منى علي`],
  ['U+00A0 only', '\u00A0', bareCreditReference],
  ['ordinary Arabic name', 'ليلى حسن', `${bareCreditReference} ليلى حسن`],
  ['internal whitespace', 'عبد  الله\u0085حسن', `${bareCreditReference} عبد  الله\u0085حسن`],
]) {
  test(`Office ledger paid-row reference: ${scenario}`, async (t) => {
    ledgerEntries = [{
      id: 1, client_id: '10', client_type: 'office', date: '2026-10-24', is_reversed: 0,
      type: 'OFFICE_DEPOSIT', effect: 'row_disbursement', reference_type: 'receipt_row_disbursement',
      reference_id: '41:row-a', amount: 100, note: bareCreditReference,
    }];
    mockLedgerGet(t, '/entities/receipts/get.php', () => Response.json({ success: true, data: { id: 41, client_name } }));
    const [credit] = await OfficesModule.getOfficeLedger('10');
    assert.equal(credit.reference_label, expected);
  });
}

test('Office ledger renders every movement when ordinary and credit receipt lookups fail', async (t) => {
  const receipts = new Map([
    ['42', { id: 42, client_name: 'منى علي' }],
    ['43', { id: 43, client_name: '   ' }],
  ]);
  const receiptReads = [];
  mockLedgerGet(t, '/entities/receipts/get.php', (request) => {
    const id = request.searchParams.get('id');
    receiptReads.push(id);
    return receipts.has(id) ? Response.json({ success: true, data: receipts.get(id) })
      : Response.json({ success: false, message: 'السجل غير موجود' }, { status: 404 });
  });
  const base = { client_id: '10', client_type: 'office', client_name: OFFICE_RECORD.name, date: '2026-10-24', is_reversed: 0 };
  const deduction = { ...base, type: 'OFFICE_WITHDRAW_AUTO', effect: 'office_deduction', reference_type: 'receipt' };
  const credit = { ...base, type: 'OFFICE_DEPOSIT', effect: 'row_disbursement', reference_type: 'receipt_row_disbursement',
    vehicle_owner_name: 'مالك المركبة', note: `صرف كارتة - ${OFFICE_RECORD.name}` };
  const unnamed = 'إضافة رصيد - قيمة كارتة';
  ledgerEntries = [
    { ...deduction, id: 1, reference_id: '42', amount: -329 },
    { ...deduction, id: 2, reference_id: '41', amount: -12345 },
    { ...credit, id: 3, reference_id: '41:row-a', amount: 12345 }, // same unavailable receipt
    { ...credit, id: 4, reference_id: '42:row-b', amount: 329 },
    { ...credit, id: 5, reference_id: '43:row-c', amount: 5, note: unnamed }, // blank receipt customer
    { ...credit, id: 6, reference_id: '44:row-d', amount: 1001, note: unnamed }, // new unnamed credit, 404
  ];
  const start = apiCalls.length;
  await showOfficeDetails('10');
  const html = elementsById.get('officeDetailsContent').innerHTML;
  const rows = [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1);
  assert.deepEqual(rows.map(([, row]) => [...row.matchAll(/<td>(.*?)<\/td>/g)].slice(3).map((m) => m[1])), [
    ['10.01', '10.06', unnamed],
    ['0.05', '0.05', unnamed],
    ['3.29', '0.00', 'إضافة رصيد - قيمة كارتة منى علي'],
    ['123.45', '-3.29', unnamed],
    ['-123.45', '-126.74', 'قيمة كارتة'],
    ['-3.29', '-3.29', 'قيمة كارتة - منى علي'],
  ]);
  assert.match(html, /<p class="text-2xl font-bold balance-positive">10\.06<\/p>/);
  assert.deepEqual(receiptReads.sort(), ['41', '42', '43', '44']); // once per id, even on failure
  assert.ok(apiCalls.slice(start).every((call) => call.method === 'GET'));
});

test('Office ledger attempts each optional receipt GET once on transport failure and recovers on reload', async (t) => {
  const attempts = [];
  let offline = true;
  mockLedgerGet(t, '/entities/receipts/get.php', (request) => {
    const id = request.searchParams.get('id');
    attempts.push(id);
    if (id === '41' && offline) throw new TypeError('Simulated network failure');
    return Response.json({ success: true, data: { id, client_name: id === '41' ? 'منى علي' : 'ليلى عمر' } });
  });
  const base = { client_id: '10', client_type: 'office', date: '2026-10-24', is_reversed: 0 };
  const credit = { ...base, type: 'OFFICE_DEPOSIT', effect: 'row_disbursement', reference_type: 'receipt_row_disbursement' };
  ledgerEntries = [
    { ...base, id: 1, type: 'OFFICE_WITHDRAW_AUTO', effect: 'office_deduction', reference_type: 'receipt', reference_id: '41', amount: -12345 },
    { ...credit, id: 2, reference_id: '41:row-a', amount: 12345 },
    { ...credit, id: 3, reference_id: '42:row-b', amount: 50 },
  ];
  const label = 'إضافة رصيد - قيمة كارتة';
  const options = Object.freeze({ passive: true, retries: 1 });
  for (const unavailable of [true, false]) {
    offline = unavailable;
    attempts.length = 0;
    const ledger = await OfficesModule.getOfficeLedger('10', options);
    assert.deepEqual(attempts.sort(), ['41', '42']);
    assert.deepEqual(Object.fromEntries(ledger.map((entry) => [entry.id, entry.reference_label])), {
      1: offline ? 'قيمة كارتة' : 'قيمة كارتة - منى علي',
      2: offline ? label : `${label} منى علي`,
      3: `${label} ليلى عمر`,
    });
  }
});

for (const [endpoint, status, message] of [
  ['/entities/offices/get.php', 403, 'غير مسموح'],
  ['/entities/vehicle-ledger/list.php', 500, 'خطأ في الخادم'],
]) {
  test(`Office ledger propagates HTTP ${status} from the required ${endpoint} read`, async (t) => {
    mockLedgerGet(t, endpoint, () => Response.json({ success: false, message }, { status }));
    await assert.rejects(OfficesModule.getOfficeLedger('10'), { message });
  });
}
