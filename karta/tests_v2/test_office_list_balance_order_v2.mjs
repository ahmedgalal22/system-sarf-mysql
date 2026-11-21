import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as drain } from 'node:timers/promises';
import { AuthModule } from '../auth.js';
import { DBProvider } from '../services/dbProvider.js';
import { OfficeRepository } from '../services/officeRepository.js';

// Keep the real summary, rendering and event handlers. Model just the data rows
// of the table, including DOM insertion while a summary read is still pending.
let screenNumber = 0;
async function mount(t, entries) {
  const offices = entries.map(([id]) => ({ id, name: id }));
  const cents = new Map(entries);
  const getAll = t.mock.method(OfficeRepository, 'getAll', async () => offices);
  const ledger = t.mock.method(DBProvider, 'findByFields', async (store, filters) => {
    assert.equal(store, 'vehicle_ledger');
    assert.equal(filters.client_type, 'office');
    const amount = cents.get(filters.client_id) ?? 0;
    return amount === 0 ? [] : [{ client_type: 'office', date: '2026-01-15',
      type: amount < 0 ? 'withdraw' : 'deposit', amount: Math.abs(amount) }];
  });
  t.mock.method(globalThis, 'fetch', async url => {
    const { pathname } = new URL(url, 'https://fixture.invalid');
    if (pathname.endsWith('/auth/session.php')) return Response.json({ success: true, data: { logged_in: true, username: 'fixture' } });
    if (pathname.endsWith('/stats/office-summary.php')) return Response.json({ success: true, data: [] });
    assert.fail(`Unexpected request: ${pathname}`);
  });
  await AuthModule.checkSession();

  const dataKey = attr => attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  function createRow() {
    return { dataset: {}, style: {}, after(row) { table.children.splice(table.children.indexOf(this) + 1, 0, row); } };
  }
  const table = {
    children: [],
    set innerHTML(html) {
      this.markup = html;
      this.children = [];
      for (const [, attrs, contents] of html.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)) {
        const row = createRow();
        row.innerHTML = contents;
        for (const [, attr, value] of attrs.matchAll(/\bdata-([\w-]+)(?:="([^"]*)")?/g)) row.dataset[dataKey(attr)] = value ?? '';
        if ('id' in row.dataset) this.children.push(row);
      }
    },
    querySelector: () => null,
    querySelectorAll(selector) {
      const [, key] = /^tr\[data-([\w-]+)\]$/.exec(selector);
      return this.children.filter(row => dataKey(key) in row.dataset);
    },
    prepend(row) { this.children.unshift(row); },
  };
  const elements = { officesTableBody: table, officeListPrint: { disabled: true }, officeTotalBalance: {},
    officeSearch: { id: 'officeSearch', value: '' }, officeDateFrom: { value: '' } };
  const listeners = new Map(), drafts = [];
  const globals = { window: globalThis.window, document: globalThis.document };
  t.after(() => Object.assign(globalThis, globals));
  globalThis.window = new EventTarget();
  globalThis.document = {
    body: { dataset: {} }, getElementById: id => elements[id] ?? null, createElement: createRow,
    addEventListener: (type, fn) => listeners.set(type, fn),
    querySelectorAll: selector => selector === '#officeModalBody tr'
      ? drafts.map(name => ({ querySelector: sel => ({ value: sel === '.office-modal-name' ? name : '' }) })) : [],
  };
  const page = await import(`../offices.js?balance-order=${++screenNumber}`);
  page.attachOfficesPageListeners();
  const click = action => listeners.get('click')({ target: { closest: sel => sel === `[data-action="${action}"]` ? {} : null } });
  const search = value => {
    elements.officeSearch.value = value;
    return listeners.get('input')({ target: elements.officeSearch });
  };
  return { ...page, table, elements, offices, cents, getAll, ledger, drafts, click, search, ids: () => table.children.map(r => r.dataset.id) };
}

test('mixed balances: negatives, positives, then exact zeros, stable within all three groups', async t => {
  const entries = [['z2', 0], ['p2', 25], ['n3', -30], ['z3', 0], ['n1', -1], ['p3', 1], ['n2', -250], ['p1', 250], ['z1', 0]];
  const s = await mount(t, entries);
  await s.loadOffices();
  assert.deepEqual(s.ids(), ['n3', 'n1', 'n2', 'p2', 'p3', 'p1', 'z2', 'z3', 'z1']);
  assert.equal(s.ledger.mock.callCount(), entries.length, 'one existing all-time balance lookup per office');
  const summary = await s.OfficesModule.getOfficeSummary();
  assert.deepEqual(summary.rows.map(r => r.office.id), entries.map(([id]) => id), 'the summary itself keeps its source order');
});

for (const [label, entries] of [['empty', []], ['single zero-balance office', [['only', 0]]]]) {
  test(`balance order: ${label}`, async t => {
    const s = await mount(t, entries);
    await s.loadOffices();
    assert.deepEqual(s.ids(), entries.map(([id]) => id));
    assert.equal(s.elements.officeListPrint.disabled, false);
    if (!entries.length) assert.match(s.table.markup, /لا يوجد مكاتب/);
  });
}

test('a searched, date-filtered list uses the displayed all-time balance, not the period total', async t => {
  const s = await mount(t, [['match-zero', 0], ['match-credit', 500], ['other-debt', -9], ['match-debt', -100]]);
  s.elements.officeDateFrom.value = '2026-02-01'; // all ledger activity predates the filter
  await s.click('office-apply-date-filter');
  await s.search('match');
  assert.equal(s.elements.officeTotalBalance.textContent, '0.00');
  assert.deepEqual(s.ids(), ['match-debt', 'match-credit', 'match-zero']);
});

test('print uses the displayed order across all three groups', async t => {
  const s = await mount(t, [['z', 0], ['p2', 100], ['n', -1], ['p1', 20]]);
  await s.loadOffices();
  const displayed = s.ids(); // fixture names are the IDs
  assert.deepEqual(displayed, ['n', 'p2', 'p1', 'z']);
  t.mock.method(document, 'querySelectorAll', selector => {
    assert.equal(selector, '#officesTableBody > tr[data-id]');
    return s.table.children.map(row => ({
      cells: [...row.innerHTML.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, text]) => ({ textContent: text, querySelector: () => null })),
    }));
  });
  let printed;
  t.mock.method(document, 'createElement', tag => {
    assert.equal(tag, 'iframe');
    return { style: {}, contentDocument: { open() {}, write(html) { printed = html; }, close() {} } };
  });
  document.body.appendChild = () => {};
  t.mock.timers.enable({ apis: ['setTimeout'] }); // capture document.write without invoking a printer
  await s.click('office-list-print');
  assert.deepEqual([...printed.matchAll(/<tr><td>([^<]*)<\/td>/g)].map(([, name]) => name), displayed);
  assert.equal(s.ledger.mock.callCount(), displayed.length, 'printing did not refetch balances');
});

test('new offices immediately lead the zero group; the refresh groups their authoritative balances', async t => {
  const s = await mount(t, [['debt', -1], ['credit', 100], ['old-zero', 0]]);
  await s.loadOffices();
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  t.mock.method(OfficeRepository, 'save', async ({ name }) => {
    const record = { id: name, name };
    s.offices.unshift(record); // newest first in the source list
    s.getAll.mock.mockImplementation(async () => { await pending; return s.offices; });
    return record;
  });
  s.drafts.push('first-new', 'last-new');
  let temporary;
  try {
    await s.click('office-modal-save');
    temporary = s.ids();
    s.cents.set('last-new', -5); // only the background refresh sees this balance
  } finally {
    release();
    await drain();
  }
  assert.deepEqual(temporary, ['debt', 'credit', 'last-new', 'first-new', 'old-zero']);
  assert.deepEqual(s.ids(), ['last-new', 'debt', 'credit', 'first-new', 'old-zero']);
});
