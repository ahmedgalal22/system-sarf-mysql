/**
 * test_dashboard_office_collected_v2.mjs
 *
 * Automated tests for Dashboard metric "إجمالي المحصل من المكاتب"
 * (`calculateTotalCollectedFromCompanies` & `initDashboardPage` in `karta/dashboard.js`).
 *
 * Covers:
 *   1. A single disbursed row (`disbursement_status: 'paid'`, canonical `net + sarf` formula)
 *   2. Multiple rows credited to different offices (by normalized name & `office_id` fallback,
 *      excluding deleted or unregistered offices)
 *   3. A reversed disbursement (`unpaid` transition and `is_reversed = 1` movement reconciliation,
 *      plus subsequent re-disbursement)
 *   4. Prevention of double-counting across duplicate receipts, duplicate rows, and paired
 *      treasury/vehicle_ledger movements
 *   5. Non-inflation by receipt payment status transitions (`payment_status: 'paid'` / `تم دفعه`)
 *      and unrelated office/treasury movements
 *   6. End-to-end Dashboard rendering (`initDashboardPage`) and preservation of other metrics
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM & browser globals before importing Dashboard modules
const elementsById = new Map();
function makeElement(id = '', tagName = 'DIV') {
  const el = {
    id,
    tagName,
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    dataset: {},
    style: {},
    classList: {
      _set: new Set(),
      add(...cls) { cls.forEach((c) => this._set.add(c)); },
      remove(...cls) { cls.forEach((c) => this._set.delete(c)); },
      toggle(c, force) {
        if (force === undefined) {
          if (this._set.has(c)) { this._set.delete(c); return false; }
          this._set.add(c); return true;
        }
        if (force) this._set.add(c); else this._set.delete(c);
        return !!force;
      },
      contains(c) { return this._set.has(c); },
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild() {},
    closest() { return null; },
    querySelector() { return makeElement(); },
    querySelectorAll() { return []; },
  };
  return el;
}

function registerId(id) {
  const el = makeElement(id);
  elementsById.set(id, el);
  return el;
}

[
  'dashboardPage',
  'dashboardStatsGrid',
  'capitalTableBody',
  'capitalBalanceVal',
  'dashFromDate',
  'dashToDate',
  'btnRangeDay',
  'btnRangeWeek',
  'btnRangeMonth',
  'btnRangeAll',
  'dashCapitalModal',
].forEach(registerId);

globalThis.window = {
  SERVER_MODE_READY: true,
  location: { pathname: '/karta/index.html', origin: 'http://localhost' },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
};
globalThis.document = {
  head: { appendChild() {} },
  body: { appendChild() {} },
  getElementById(id) {
    return elementsById.get(id) || null;
  },
  createElement(tag) {
    return makeElement('', String(tag || 'div').toUpperCase());
  },
  addEventListener() {},
  removeEventListener() {},
  querySelectorAll() { return []; },
};

const { activateServerMode } = await import('../services/apiConfig.js');
activateServerMode();

const { calculateRowNet, calculateRowOfficeDeduction } = await import('../services/financialCalculator.js');
const {
  calculateTotalCollectedFromCompanies,
  calculateDashboardNetProfit,
  initDashboardPage,
} = await import('../dashboard.js');
const { AuthModule } = await import('../auth.js');

const ACTIVE_OFFICES = [
  { id: 'off-1', name: 'مكتب النور للنقل', deleted_at: null },
  { id: 'off-2', name: 'مكتب الأمل', deleted_at: null },
  { id: 'off-deleted', name: 'مكتب محذوف', deleted_at: '2026-10-01T00:00:00Z' },
];

test('1. Single disbursed row uses canonical net + sarf office credit formula', () => {
  // weight = 50 tons, deficit = 500 kg (0.5 ton) -> billable = 49.5 tons
  // gross = 49.5 * 200 = 9900
  // net = 9900 - (1000 + 300 + 200) + 50 = 8450
  // office credit (net + sarf) = 8450 + 200 = 8650
  const row = {
    row_id: 'row-1',
    office: 'مكتب النور للنقل',
    weight: 50,
    deficit: 500,
    noloon: 200,
    ohda: 1000,
    officeAmount: 300,
    sarf: 200,
    add: 50,
    disbursement_status: 'paid',
  };

  assert.equal(calculateRowNet(row), 8450);
  assert.equal(calculateRowOfficeDeduction(row), 8650);

  const receipts = [
    {
      id: 'rec-100',
      receipt_date: '2026-10-25',
      payment_status: 'unpaid',
      rows: [row],
    },
  ];

  const movements = [
    {
      id: 'tr-1',
      type: 'deposit',
      effect: 'row_disbursement',
      reference_type: 'receipt_row_disbursement',
      reference_id: 'rec-100:row-1',
      client_type: 'office',
      client_id: 'off-1',
      amount: 865000,
      date: '2026-10-25',
      is_reversed: 0,
    },
  ];

  const total = calculateTotalCollectedFromCompanies(receipts, ACTIVE_OFFICES, movements);
  assert.equal(total, 8650);
});

test('2. Multiple rows credited to different offices (name normalization, office_id fallback, and active office filter)', () => {
  // Row A -> off-1 by normalized whitespace/case name:
  //   weight=20, deficit=0, noloon=100, ohda=200, officeAmount=100, sarf=50, add=0
  //   net = 2000 - 350 = 1650; credit = net + sarf = 1700
  const rowA = {
    row_id: 'row-a',
    office: '  مكتب   النور للنقل ',
    weight: 20,
    deficit: 0,
    noloon: 100,
    ohda: 200,
    officeAmount: 100,
    sarf: 50,
    add: 0,
    disbursement_status: 'paid',
  };

  // Row B -> off-2 via office_id fallback (when row.office name is empty):
  //   weight=10, deficit=250 (0.25t), noloon=400 -> gross = 9.75 * 400 = 3900
  //   net = 3900 - (500 + 100 + 100) + 25 = 3225; credit = net + sarf = 3325
  const rowB = {
    row_id: 'row-b',
    office: '',
    office_id: 'off-2',
    weight: 10,
    deficit: 250,
    noloon: 400,
    ohda: 500,
    officeAmount: 100,
    sarf: 100,
    add: 25,
    disbursement_status: 'تم صرفه',
  };

  // Row C -> unpaid row for off-1 (must NOT be counted)
  const rowC = {
    row_id: 'row-c',
    office: 'مكتب النور للنقل',
    weight: 30,
    noloon: 100,
    sarf: 50,
    disbursement_status: 'unpaid',
  };

  // Row D -> disbursed row linked to soft-deleted office (must NOT be counted)
  const rowD = {
    row_id: 'row-d',
    office: 'مكتب محذوف',
    weight: 15,
    noloon: 100,
    sarf: 50,
    disbursement_status: 'paid',
  };

  // Row E -> disbursed row linked to unknown office (must NOT be counted)
  const rowE = {
    row_id: 'row-e',
    office: 'مكتب غير مسجل',
    weight: 15,
    noloon: 100,
    sarf: 50,
    disbursement_status: 'paid',
  };

  const receipts = [
    { id: 'rec-201', receipt_date: '2026-10-25', rows: [rowA, rowC] },
    { id: 'rec-202', receipt_date: '2026-10-25', rows: [rowB, rowD, rowE] },
  ];

  const total = calculateTotalCollectedFromCompanies(receipts, ACTIVE_OFFICES);
  assert.equal(total, 1700 + 3325);
});

test('3. Reversed disbursement reduces the metric and re-disbursement restores it without duplication', () => {
  const baseRow = {
    row_id: 'row-rev-1',
    office: 'مكتب النور للنقل',
    weight: 10,
    deficit: 0,
    noloon: 300,
    ohda: 400,
    officeAmount: 100,
    sarf: 150,
    add: 0,
  };
  // net = 3000 - 650 = 2350; credit = 2350 + 150 = 2500

  // Step 1: Row is disbursed (paid)
  const paidReceipts = [
    {
      id: 'rec-300',
      receipt_date: '2026-10-25',
      rows: [{ ...baseRow, disbursement_status: 'paid' }],
    },
  ];
  const initialMovements = [
    {
      id: 'mov-1',
      type: 'deposit',
      effect: 'row_disbursement',
      reference_type: 'receipt_row_disbursement',
      reference_id: 'rec-300:row-rev-1',
      client_type: 'office',
      client_id: 'off-1',
      amount: 250000,
      is_reversed: 0,
    },
  ];
  assert.equal(
    calculateTotalCollectedFromCompanies(paidReceipts, ACTIVE_OFFICES, initialMovements),
    2500
  );

  // Step 2a: Reversed via status transition (row -> 'unpaid' and movement -> is_reversed: 1)
  const unpaidReceipts = [
    {
      id: 'rec-300',
      receipt_date: '2026-10-25',
      rows: [{ ...baseRow, disbursement_status: 'unpaid', payout_status: 'unpaid', rowPayment: 'unpaid' }],
    },
  ];
  const reversedMovements = [
    {
      ...initialMovements[0],
      is_reversed: 1,
    },
  ];
  assert.equal(
    calculateTotalCollectedFromCompanies(unpaidReceipts, ACTIVE_OFFICES, reversedMovements),
    0
  );

  // Step 2b: Even if a stale row snapshot still shows 'paid', a reversed movement (with no active replacement) excludes it
  assert.equal(
    calculateTotalCollectedFromCompanies(paidReceipts, ACTIVE_OFFICES, reversedMovements),
    0
  );

  // Step 3: Row is disbursed again later (reversed movement + new active movement) -> counted once
  const redisbursedMovements = [
    ...reversedMovements,
    {
      id: 'mov-2',
      type: 'deposit',
      effect: 'row_disbursement',
      reference_type: 'receipt_row_disbursement',
      reference_id: 'rec-300:row-rev-1',
      client_type: 'office',
      client_id: 'off-1',
      amount: 250000,
      is_reversed: 0,
    },
  ];
  assert.equal(
    calculateTotalCollectedFromCompanies(paidReceipts, ACTIVE_OFFICES, redisbursedMovements),
    2500
  );
});

test('4. Prevention of double-counting across duplicate receipts, duplicate rows, and paired movements', () => {
  const row = {
    row_id: 'row-dup-1',
    office: 'مكتب الأمل',
    weight: 12,
    deficit: 0,
    noloon: 250,
    ohda: 300,
    officeAmount: 100,
    sarf: 100,
    add: 0,
    disbursement_status: 'paid',
  };
  // gross = 3000, net = 2500, sarf = 100 -> credit = 2600

  const receipt = {
    id: 'rec-400',
    receipt_date: '2026-10-25',
    // Duplicate row entries with same row_id inside the same receipt
    rows: [row, { ...row }],
  };

  // Duplicate receipt objects in array
  const duplicateReceipts = [receipt, { ...receipt }];

  // Paired treasury + vehicle_ledger movements plus duplicate movement objects
  const pairedAndDuplicateMovements = [
    {
      id: 'tr-400',
      type: 'deposit',
      effect: 'row_disbursement',
      reference_type: 'receipt_row_disbursement',
      reference_id: 'rec-400:row-dup-1',
      client_type: 'office',
      client_id: 'off-2',
      amount: 260000,
      is_reversed: 0,
    },
    {
      id: 'tr-400',
      type: 'deposit',
      effect: 'row_disbursement',
      reference_type: 'receipt_row_disbursement',
      reference_id: 'rec-400:row-dup-1',
      client_type: 'office',
      client_id: 'off-2',
      amount: 260000,
      is_reversed: 0,
    },
    {
      id: 'vl-400',
      type: 'OFFICE_DEPOSIT',
      effect: 'row_disbursement',
      reference_type: 'receipt_row_disbursement',
      reference_id: 'rec-400:row-dup-1',
      client_type: 'office',
      client_id: 'off-2',
      amount: 260000,
      is_reversed: 0,
    },
  ];

  const total = calculateTotalCollectedFromCompanies(
    duplicateReceipts,
    ACTIVE_OFFICES,
    pairedAndDuplicateMovements
  );
  assert.equal(total, 2600);
});

test('5. Receipt payment transitions and unrelated office/treasury movements do not inflate the metric', () => {
  // Receipt is marked as PAID at the receipt level (تم دفعه), and payout_status is 'paid',
  // but its rows have disbursement_status = 'unpaid' (لم يتم صرفه).
  const unpaidRowInPaidReceipt = {
    row_id: 'row-501',
    office: 'مكتب النور للنقل',
    weight: 25,
    noloon: 200,
    ohda: 500,
    officeAmount: 100,
    sarf: 100,
    disbursement_status: 'unpaid',
    payout_status: 'unpaid',
    rowPayment: 'unpaid',
  };

  const receipts = [
    {
      id: 'rec-500',
      receipt_date: '2026-10-25',
      payment_status: 'paid', // تم دفعه (receipt-level payment status)
      payout_status: 'paid',
      net_due: 430000,
      rows: [unpaidRowInPaidReceipt],
    },
  ];

  // Unrelated movements:
  //   - Receipt-level payment status treasury withdrawal & owner ledger entry
  //   - Manual office deposit (no row_disbursement effect/reference_type)
  //   - Automatic receipt-save office deduction (OFFICE_WITHDRAW_AUTO / office_deduction)
  //   - General treasury expense & salary
  const unrelatedMovements = [
    {
      id: 'tr-pay-500',
      type: 'withdraw',
      effect: 'receipt_payout',
      reference_type: 'receipt_payment_status',
      reference_id: 'rec-500',
      client_type: 'owner',
      client_id: 'own-1',
      amount: 430000,
      is_reversed: 0,
    },
    {
      id: 'vl-pay-500',
      type: 'receipt_payment',
      effect: 'receipt_payout',
      reference_type: 'receipt_payment_status',
      reference_id: 'rec-500',
      client_type: 'owner',
      client_id: 'own-1',
      amount: 430000,
      is_reversed: 0,
    },
    {
      id: 'manual-office-dep',
      type: 'OFFICE_DEPOSIT',
      effect: 'manual_deposit',
      reference_type: 'manual',
      reference_id: 'man-1',
      client_type: 'office',
      client_id: 'off-1',
      amount: 999900,
      is_reversed: 0,
    },
    {
      id: 'auto-office-ded',
      type: 'OFFICE_WITHDRAW_AUTO',
      effect: 'office_deduction',
      reference_type: 'receipt_auto_deduction',
      reference_id: 'rec-500:row-501',
      client_type: 'office',
      client_id: 'off-1',
      amount: 440000,
      is_reversed: 0,
    },
    {
      id: 'exp-1',
      type: 'withdraw',
      effect: 'expense',
      amount: 50000,
      is_reversed: 0,
    },
  ];

  const total = calculateTotalCollectedFromCompanies(receipts, ACTIVE_OFFICES, unrelatedMovements);
  assert.equal(total, 0);
});

test('6. End-to-end Dashboard rendering updates "إجمالي المحصل من المكاتب" and preserves other summary metrics', async () => {
  const apiReceipts = [
    {
      id: 'rec-600',
      receipt_date: '2026-10-25',
      payment_status: 'paid',
      net_due: 500000, // 5000.00 EGP
      rows: [
        {
          row_id: 'r-600-1',
          office: 'مكتب النور للنقل',
          weight: 20,
          deficit: 0,
          noloon: 150,
          ohda: 300,
          officeAmount: 100,
          sarf: 100,
          add: 0,
          disbursement_status: 'paid', // net = 3000 - 500 = 2500; credit = 2500 + 100 = 2600
        },
        {
          row_id: 'r-600-2',
          office: 'مكتب الأمل',
          weight: 10,
          deficit: 0,
          noloon: 100,
          ohda: 100,
          officeAmount: 50,
          sarf: 50,
          add: 0,
          disbursement_status: 'unpaid', // unpaid row -> 0 office credit, but sarf=50 still counts in net profit
        },
      ],
    },
  ];

  const apiTreasury = [
    {
      id: 'tr-600-1',
      type: 'deposit',
      effect: 'row_disbursement',
      reference_type: 'receipt_row_disbursement',
      reference_id: 'rec-600:r-600-1',
      client_type: 'office',
      client_id: 'off-1',
      amount: 260000,
      date: '2026-10-25',
      is_reversed: 0,
    },
    {
      id: 'tr-exp-1',
      type: 'withdraw',
      effect: 'expense',
      amount: 4000, // 40.00 EGP expense
      date: '2026-10-25',
      is_reversed: 0,
    },
  ];

  globalThis.fetch = async (url) => {
    const u = String(url);
    let payload = { ok: true, success: true, data: [] };
    if (u.includes('/auth/login.php')) {
      payload = { ok: true, success: true, data: { username: 'admin' } };
    } else if (u.includes('/receipts')) {
      payload = { ok: true, success: true, data: apiReceipts };
    } else if (u.includes('/treasury')) {
      payload = { ok: true, success: true, data: apiTreasury };
    } else if (u.includes('/offices')) {
      payload = { ok: true, success: true, data: ACTIVE_OFFICES };
    } else if (u.includes('/owners') || u.includes('/clients')) {
      payload = { ok: true, success: true, data: [] };
    } else if (u.includes('/dashboard') || u.includes('/capital')) {
      payload = { ok: true, success: true, data: [] };
    }
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  };

  await AuthModule.login('admin', 'admin');
  await initDashboardPage();

  const statsHtml = elementsById.get('dashboardStatsGrid').innerHTML;
  assert.ok(statsHtml.includes('إجمالي المحصل من المكاتب'), 'Dashboard card label must be rendered');
  assert.ok(statsHtml.includes('2600.00'), 'Disbursed row office credit (2600.00) must be rendered');
  assert.ok(statsHtml.includes('5000.00'), 'Other metric (إجمالي صرف الكارتات = 5000.00) must be preserved');

  // Verify net profit calculation remains intact: sarf (100 + 50 = 150) - expense (40) = 110.00
  const profit = calculateDashboardNetProfit(apiReceipts, apiTreasury);
  assert.equal(profit.totalSarfCents, 15000);
  assert.equal(profit.totalExpenseCents, 4000);
  assert.equal(profit.netProfitCents, 11000);
  assert.ok(statsHtml.includes('110.00'), 'Net profit card (110.00) must be preserved');
});
