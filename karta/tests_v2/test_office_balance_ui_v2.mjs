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
const {
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
    payload = { ok: true, success: true, data: { username: 'admin', role: 'admin' } };
  } else if (u.includes('/entities/offices/get.php') || u.includes('/offices')) {
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
