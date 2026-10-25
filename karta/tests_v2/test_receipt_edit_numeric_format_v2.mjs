/**
 * test_receipt_edit_numeric_format_v2.mjs — Regression tests for saved receipt
 * edit-form numeric input prefill formatting.
 *
 * Verifies:
 *   1. Integer input: 30 remains '30' (not '30.00').
 *   2. Integer money values: 40, 500, 150, 400 remain '40', '500', '150', '400'.
 *   3. Decimal input: 30.5 remains '30.5' (not '30.50').
 *   4. Meaningful precision (e.g. 30.125, 150.75) is preserved without rounding or truncation.
 *   5. Zero, empty, null, and undefined values retain their intended behavior.
 *   6. End-to-end loadReceiptForEdit() populates all row numeric inputs and #generalAdd
 *      without unnecessary '.00' while keeping existing receipt calculations unchanged.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// ─── Minimal DOM & Browser Environment for Node.js ───────────────────────────

const elementsById = new Map();
let tbodyChildren = [];

function createMockClassList(initial = '') {
  const set = new Set(String(initial).split(/\s+/).filter(Boolean));
  return {
    add: (...tokens) => tokens.forEach((t) => t && set.add(t)),
    remove: (...tokens) => tokens.forEach((t) => set.delete(t)),
    contains: (t) => set.has(t),
    toggle: (t, force) => {
      if (force === undefined) {
        if (set.has(t)) { set.delete(t); return false; }
        set.add(t); return true;
      }
      if (force) set.add(t); else set.delete(t);
      return Boolean(force);
    },
  };
}

function createMockInput(cls = '', initialValue = '') {
  return {
    tagName: 'INPUT',
    className: cls,
    classList: createMockClassList(cls),
    value: initialValue,
    dataset: {},
    style: {},
    attributes: {},
    setAttribute(k, v) { this.attributes[k] = String(v); },
    getAttribute(k) { return this.attributes[k] ?? null; },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    closest() { return null; },
  };
}

function createMockTr() {
  const inputsByClass = new Map();
  let _innerHTML = '';
  let _className = '';
  const classList = createMockClassList();

  const rowClasses = [
    'receipt-kartano',
    'receipt-date',
    'receipt-data',
    'receipt-car',
    'receipt-weight',
    'receipt-deficit',
    'receipt-office',
    'receipt-loading',
    'receipt-taktik',
    'receipt-type',
    'receipt-noloon',
    'receipt-ohda',
    'receipt-office-amount',
    'receipt-add',
    'receipt-sarf',
    'receipt-net',
    'separator-vehicle-name',
    'separator-subtotal',
    'separator-notes',
  ];

  const tr = {
    tagName: 'TR',
    id: '',
    dataset: {},
    style: {},
    get className() { return _className; },
    set className(val) {
      _className = String(val || '');
      _className.split(/\s+/).filter(Boolean).forEach((c) => classList.add(c));
    },
    classList,
    get innerHTML() { return _innerHTML; },
    set innerHTML(html) {
      _innerHTML = String(html || '');
      inputsByClass.clear();
      for (const cls of rowClasses) {
        if (_innerHTML.includes(cls)) {
          const inp = createMockInput(cls, cls === 'receipt-net' ? '0' : '');
          if (cls === 'separator-subtotal') {
            const m = _innerHTML.match(/separator-subtotal[^>]*>([^<]*)</);
            inp.textContent = m ? m[1] : '0.00';
          }
          inputsByClass.set(cls, inp);
        }
      }
    },
    querySelector(selector) {
      if (selector.startsWith('.')) {
        const cls = selector.slice(1);
        return inputsByClass.get(cls) || null;
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'input') {
        return [...inputsByClass.values()];
      }
      return [];
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };
  return tr;
}

function resetDom() {
  elementsById.clear();
  tbodyChildren = [];

  const registerEl = (id, initialVal = '') => {
    const el = {
      id,
      value: initialVal,
      textContent: initialVal,
      innerHTML: '',
      dataset: {},
      style: {},
      classList: createMockClassList(),
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
    };
    elementsById.set(id, el);
    return el;
  };

  registerEl('receiptDate', '');
  registerEl('clientInput', '');
  registerEl('receiptNumber', '');
  registerEl('receiptBalance', '0.00');
  elementsById.get('receiptBalance').dataset.previous = '0';
  registerEl('paidAmount', '0');
  elementsById.get('paidAmount').dataset.auto = '1';
  registerEl('generalAdd', '0');
  registerEl('totalAmount', '0.00');
  registerEl('rowCount', '0');
  registerEl('netDueAmount', '0.00');
  registerEl('netTotalAmount', '0.00');
  registerEl('cancelEditBtn', '');
  elementsById.get('cancelEditBtn').classList.add('hidden');
  registerEl('saveReceiptBtn', '');

  const tbody = {
    id: 'receiptTableBody',
    get innerHTML() { return ''; },
    set innerHTML(_v) { tbodyChildren = []; },
    get firstChild() { return tbodyChildren[0] || null; },
    appendChild(child) {
      tbodyChildren.push(child);
      return child;
    },
    insertBefore(child, ref) {
      const idx = tbodyChildren.indexOf(ref);
      if (idx === -1) tbodyChildren.unshift(child);
      else tbodyChildren.splice(idx, 0, child);
      return child;
    },
    querySelector(sel) {
      if (sel === '#receiptFillArrowRow') {
        return tbodyChildren.find((r) => r.id === 'receiptFillArrowRow') || null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (sel === 'tr') return [...tbodyChildren];
      return [];
    },
  };
  elementsById.set('receiptTableBody', tbody);
}

resetDom();

globalThis.window = {
  SERVER_MODE_READY: true,
  location: { href: '' },
  addEventListener() {},
  dispatchEvent() {},
};
globalThis.CustomEvent = class CustomEvent {
  constructor(name, detail) { this.type = name; this.detail = detail?.detail; }
};
globalThis.Event = class Event {
  constructor(type) { this.type = type; }
};
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  getElementById(id) {
    return elementsById.get(id) || null;
  },
  createElement(tag) {
    const t = String(tag).toLowerCase();
    if (t === 'tr') return createMockTr();
    return createMockInput();
  },
  querySelector(sel) {
    if (sel === '#receiptPage button[data-action="save-receipt"]') {
      return elementsById.get('saveReceiptBtn');
    }
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '#receiptTableBody tr') {
      return [...tbodyChildren];
    }
    return [];
  },
  addEventListener() {},
};

globalThis.fetch = async (url) => {
  const u = String(url);
  let payload = { ok: true, success: true, data: [] };
  if (u.includes('/auth/login.php')) {
    payload = { ok: true, success: true, data: { username: 'admin' } };
  }
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
};

const { activateServerMode } = await import('../services/apiConfig.js');
activateServerMode();

const { AuthModule } = await import('../auth.js');
await AuthModule.login('admin', 'admin');

const {
  formatReceiptInputNumber,
  formatShortageForInput,
  loadReceiptForEdit,
} = await import('../receipts.js');
const { calculateRowNet, calculateReceiptTotals } = await import('../services/financialCalculator.js');

// ─── TESTS ───────────────────────────────────────────────────────────────────

test('1. Integer inputs format without .00 suffix (30 -> "30", 500 -> "500")', () => {
  assert.equal(formatReceiptInputNumber(30), '30');
  assert.equal(formatReceiptInputNumber(40), '40');
  assert.equal(formatReceiptInputNumber(500), '500');
  assert.equal(formatReceiptInputNumber(150), '150');
  assert.equal(formatReceiptInputNumber(400), '400');
  assert.equal(formatReceiptInputNumber('30.00'), '30');
  assert.equal(formatReceiptInputNumber('500.00'), '500');
  assert.equal(formatShortageForInput(200), '200');
  assert.equal(formatShortageForInput('200.00'), '200');
});

test('2. Decimal and high-precision inputs preserve exact precision without rounding or trailing zeros', () => {
  assert.equal(formatReceiptInputNumber(30.5), '30.5');
  assert.equal(formatReceiptInputNumber('30.50'), '30.5');
  assert.equal(formatReceiptInputNumber(30.25), '30.25');
  assert.equal(formatReceiptInputNumber(30.125), '30.125');
  assert.equal(formatReceiptInputNumber(150.75), '150.75');
  assert.equal(formatShortageForInput(12.5), '12.5');
  assert.equal(formatShortageForInput(12.375), '12.375');
});

test('3. Zero, empty, null, and undefined values retain empty-string input behavior', () => {
  assert.equal(formatReceiptInputNumber(0), '');
  assert.equal(formatReceiptInputNumber('0'), '');
  assert.equal(formatReceiptInputNumber('0.00'), '');
  assert.equal(formatReceiptInputNumber(''), '');
  assert.equal(formatReceiptInputNumber(null), '');
  assert.equal(formatReceiptInputNumber(undefined), '');
  assert.equal(formatReceiptInputNumber(NaN), '');
  assert.equal(formatShortageForInput(0), '');
  assert.equal(formatShortageForInput(null), '');
  assert.equal(formatShortageForInput(undefined), '');
  assert.equal(formatShortageForInput(''), '');
});

test('4. End-to-end loadReceiptForEdit() prefills integer, decimal, and zero/empty fields accurately and preserves calculations', async () => {
  resetDom();

  const savedReceipt = {
    id: 42,
    receipt_date: '2026-10-25',
    receipt_number: '105',
    client_id: 'owner-1',
    client_type: 'owner',
    client_name: 'عميل تجريبي',
    payout_status: 'unpaid',
    payment_status: 'unpaid',
    previous_balance: 0,
    general_add: 0,      // 0 cents -> '0' in #generalAdd
    total: 95000,        // 950.00 EGP in cents
    net_due: 95000,
    net_total: 95000,
    paid: 95000,
    rows: [
      {
        _type: 'data',
        row_id: 'row-int',
        kartano: 'K-1',
        date: '2026-10-25',
        data: 'سائق 1',
        vehicle_plate: 'أ ب ج 123',
        weight: 30,
        deficit: 0,
        noloon: 40,
        ohda: 500,
        officeAmount: 150,
        add: 400,
        sarf: 0,
        net: 950,
      },
      {
        _type: 'data',
        row_id: 'row-dec',
        kartano: 'K-2',
        date: '2026-10-25',
        data: 'سائق 2',
        vehicle_plate: 'د هـ و 456',
        weight: 30.5,
        deficit: 250,
        noloon: 40.25,
        ohda: 500.5,
        officeAmount: 150.75,
        add: 30.125,
        sarf: 100,
      },
    ],
  };

  await loadReceiptForEdit(savedReceipt);

  const dataRows = tbodyChildren.filter((r) => r.id !== 'receiptFillArrowRow');
  assert.equal(dataRows.length, 2, 'Two data rows should be rendered in edit mode');

  // Row 1: integer values must NOT have .00 suffixes; zero values must be ''
  const r1 = dataRows[0];
  assert.equal(r1.querySelector('.receipt-weight').value, '30');
  assert.equal(r1.querySelector('.receipt-deficit').value, '');
  assert.equal(r1.querySelector('.receipt-noloon').value, '40');
  assert.equal(r1.querySelector('.receipt-ohda').value, '500');
  assert.equal(r1.querySelector('.receipt-office-amount').value, '150');
  assert.equal(r1.querySelector('.receipt-add').value, '400');
  assert.equal(r1.querySelector('.receipt-sarf').value, '');
  assert.equal(r1.querySelector('.receipt-net').value, '950.00');

  // Row 2: decimal & multi-decimal values preserved without trailing zeros or truncation
  const r2 = dataRows[1];
  assert.equal(r2.querySelector('.receipt-weight').value, '30.5');
  assert.equal(r2.querySelector('.receipt-deficit').value, '250');
  assert.equal(r2.querySelector('.receipt-noloon').value, '40.25');
  assert.equal(r2.querySelector('.receipt-ohda').value, '500.5');
  assert.equal(r2.querySelector('.receipt-office-amount').value, '150.75');
  assert.equal(r2.querySelector('.receipt-add').value, '30.125');
  assert.equal(r2.querySelector('.receipt-sarf').value, '100');

  // Footer generalAdd: 0 cents -> '0' (not '0.00')
  assert.equal(elementsById.get('generalAdd').value, '0');

  // Verify financial calculations for both rows and receipt totals remain unchanged
  const expectedNet1 = calculateRowNet(savedReceipt.rows[0]);
  const expectedNet2 = calculateRowNet(savedReceipt.rows[1]);
  assert.equal(expectedNet1, 950);
  const expectedTotals = calculateReceiptTotals(savedReceipt.rows, 0, 0, 0);
  assert.equal(elementsById.get('totalAmount').textContent, (expectedNet1 + expectedNet2).toFixed(2));
  assert.equal(elementsById.get('netDueAmount').textContent, expectedTotals.net_due.toFixed(2));
  assert.equal(elementsById.get('netTotalAmount').textContent, expectedTotals.net_total.toFixed(2));
});
