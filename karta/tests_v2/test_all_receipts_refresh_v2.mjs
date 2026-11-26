import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as drain } from 'node:timers/promises';

// Real page, multi-selects, event listeners and renderer; only the DOM and
// receipt repository reads are simulated. Each response is released by the test.
let screenNumber = 0;
const owner = 'Selected owner';
const office = 'Selected office';
const mayRange = { from: '2026-05-01', to: '2026-05-31' };
function receipt(id, client = owner, company = office) {
  return { id, created_at: id, receipt_number: String(id), receipt_date: '2026-05-15',
    client_name: client, payment_status: 'unpaid', rows: [{ office: company, kartano: `K${id}` }] };
}

function element() {
  const classes = new Set(), listeners = new Map(), popupParts = new Map();
  return { dataset: {}, classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) }, innerHTML: '',
    children: [], appendChild(child) { this.children.push(child); }, remove() {},
    addEventListener(type, fn) { listeners.set(type, fn); }, fire(type, event) { listeners.get(type)?.(event); },
    querySelector(selector) {
      if (this.className !== 'ms-filter-popup') return null;
      if (!popupParts.has(selector)) popupParts.set(selector, element());
      return popupParts.get(selector);
    },
    querySelectorAll() { return []; } };
}

const dateSelector = key => `[data-filter-tab="receipts"][data-filter-key="${key}"]`;

async function mountScreen(t, filters = {}, slots = ['owner', 'company']) {
  const ids = ['allReceiptsPage', 'receiptsList', 'receiptsSummaryContainer', 'receiptsLoadingOverlay', ...slots.map(key => `ms-slot-${key}`)];
  const elements = new Map(ids.map(id => [id, element()]));
  elements.get('receiptsLoadingOverlay').classList.add('ar-loading-overlay--hidden');
  const page = elements.get('allReceiptsPage');
  const listeners = new Map();
  page.addEventListener = (type, listener) => listeners.set(type, listener);
  page.dispatchEvent = event => {
    // Browser dispatch invokes the registered listener but never observes its returned Promise.
    listeners.get(event.type)(event);
    return true;
  };
  const fire = (type, selector, control) => page.dispatchEvent({
    type, target: { closest: s => s === selector ? control : null },
  });
  const quickRange = days => fire('click', '[data-range]', { dataset: { range: 'receipts', days: days?.toString() } });
  const clearDates = () => fire('click', '[data-action]', { dataset: { action: 'clear-receipt-dates' } });
  globalThis.document = { getElementById: id => elements.get(id) ?? null,
    addEventListener() {}, removeEventListener() {}, createElement: element, querySelector() { return null; } };
  globalThis.window = Object.assign(new EventTarget(), { __APP_CONTEXT__: { username: 'admin' } });
  t.mock.method(globalThis, 'fetch', () => assert.fail('No live HTTP in these tests'));
  const { ReceiptRepository } = await import('../services/receiptRepository.js');
  const screen = await import(`../allReceipts.js?refresh-test=${++screenNumber}`);
  const reads = [];
  let active = 0, peak = 0;
  t.after(() => {
    assert.equal(peak, 1, 'list and search reads must never overlap');
    assert.equal(active, 0, 'no extra read left in flight');
    assert.equal(screen.STATE.loading, false, 'the loader was released');
  });
  function hold(mode, params, options) {
    peak = Math.max(peak, ++active);
    return new Promise((resolve, reject) => {
      reads.push({ mode, params: structuredClone(params), passive: options.passive === true,
        reply(data, opts = {}) { resolve(mode === 'list' ? data : { data, meta: { options: opts } }); },
        fail(err = new Error('receipt read failed')) { reject(err); } });
    }).finally(() => { active--; });
  }
  t.mock.method(ReceiptRepository, 'findByFields', (params, options) => hold('list', params, options));
  t.mock.method(ReceiptRepository, 'search', (params, options) => hold('search', params, options));
  const f = screen.STATE.filters.receipts;
  Object.assign(f, filters);
  const fields = new Map(['from', 'to'].map(key => [dateSelector(key), {
    dataset: { filterTab: 'receipts', filterKey: key }, value: f[key], disabled: false,
  }]));
  const controls = [...fields.values(), { dataset: {}, disabled: true }];
  page.querySelector = selector => fields.get(selector) ?? null;
  const bulkButtons = ['print-filtered', 'export-excel-filtered'].map(action => ({ dataset: { action, tab: 'receipts' } }));
  page.querySelectorAll = selector => selector.includes('.range-toolbar input') ? [...controls, ...bulkButtons]
    : selector.includes('[data-action="print-filtered"]') ? bulkButtons : [];
  const inputDate = (key, value) => {
    const field = page.querySelector(dateSelector(key));
    field.value = value;
    fire('input', '[data-filter-tab][data-filter-key]', field);
  };
  const initial = screen.initAllReceiptsPage();
  assert.doesNotMatch(page.innerHTML, /data-action="apply-filter"|apply-btn/);
  assert.equal(reads.length, 1);
  const cards = () => [...elements.get('receiptsList').innerHTML.matchAll(/data-kind="receipt" data-id="(\d+)"/g)].map(m => Number(m[1]));
  const change = (passive = false, type = 'receipts:changed') =>
    window.dispatchEvent(new CustomEvent(type, { detail: { passive } }));
  const refresh = () => screen.refreshAllReceiptsPage(f.owner.length || f.number.length ? 'search' : 'list');
  return { ...screen, initial, refresh, quickRange, clearDates, inputDate, change, cards, f, page, reads, controls, bulkButtons,
    clickBulk: button => fire('click', '[data-action]', button) };
}

async function openScreen(t, filters) {
  const s = await mountScreen(t, { ...mayRange, ...filters });
  s.reads.pop().reply([receipt(1)]);
  await s.initial;
  assert.deepEqual(s.cards(), [1]);
  return s;
}

test('direct list: a passive burst yields one current-range read; obsolete rows cannot prune the office or change sorting', async t => {
  const s = await openScreen(t, { company: [office], sortByPayoutDate: true });
  s.refresh();
  assert.equal(s.reads[0].mode, 'list');
  s.change(true);
  await drain();
  s.change(true, 'treasury:changed');
  s.change(true);
  s.f.from = '2026-05-10';
  await drain();
  assert.equal(s.reads.length, 1);
  s.reads[0].reply([receipt(1, owner, 'Obsolete office')]);
  await drain();
  assert.equal(s.reads.length, 2, 'exactly one trailing read');
  assert.deepEqual(s.f.company, [office]);
  assert.deepEqual(s.cards(), [1], 'keep the last published view while the follow-up is held');
  const next = s.reads[1];
  assert.equal(next.mode, 'list');
  assert.equal(next.passive, true);
  assert.deepEqual(next.params, { from_date: '2026-05-10', to_date: '2026-05-31' });
  next.reply(Array.from({ length: 101 }, (_, i) => receipt(i + 1)));
  await drain();
  assert.equal(s.f.sortByPayoutDate, true);
  assert.deepEqual(s.f.company, [office]);
  assert.deepEqual(s.cards(), Array.from({ length: 101 }, (_, i) => 101 - i));
  assert.equal(s.reads.length, 2);
});

test('direct search: mixed events coalesce into one active search without publishing obsolete meta/options', async t => {
  const s = await openScreen(t, { owner: [owner] });
  s.refresh();
  assert.equal(s.reads[0].mode, 'search');
  s.change(true);
  await drain();
  s.change();
  s.change(true);
  s.f.to = '2026-05-20';
  s.f.number = ['2'];
  assert.equal(s.reads.length, 1);
  s.reads[0].reply([receipt(1, 'Obsolete owner')], { client_names: ['Obsolete owner'] });
  await drain();
  assert.equal(s.reads.length, 2);
  assert.equal(s.STATE.meta, null);
  assert.deepEqual(s.f.owner, [owner]);
  const next = s.reads[1];
  assert.equal(next.mode, 'search');
  assert.equal(next.passive, false);
  assert.deepEqual(next.params, { from_date: '2026-05-01', to_date: '2026-05-20',
    limit: 0, offset: 0, include_options: '1', client_name: [owner], receipt_number: ['2'] });
  next.reply([receipt(2)], { client_names: [owner], receipt_numbers: ['2'] });
  await drain();
  assert.deepEqual(s.cards(), [2]);
  assert.deepEqual(s.f.owner, [owner]);
  assert.deepEqual(s.f.number, ['2']);
  assert.equal(s.reads.length, 2);
});

test('a failed direct read still drains the change and selects the mode at dispatch, not at event time', async t => {
  const s = await openScreen(t);
  const direct = s.refreshAllReceiptsPage('list');
  s.change(true);
  await drain();
  s.f.number = ['2'];
  s.reads[0].fail();
  await assert.rejects(direct, /receipt read failed/);
  await drain();
  assert.equal(s.reads.length, 2);
  assert.equal(s.reads[1].mode, 'search');
  assert.deepEqual(s.reads[1].params.receipt_number, ['2']);
  s.reads[1].reply([receipt(2)]);
  await drain();
  assert.deepEqual(s.cards(), [2]);
});

test('failed change refresh stays pending without spinning; re-entry retries once without reinitialization', async t => {
  const s = await openScreen(t);
  const binds = t.mock.method(window, 'addEventListener');
  const pageBinds = t.mock.method(s.page, 'addEventListener');
  const log = t.mock.method(console, 'error', () => {});
  s.page.innerHTML = 'existing shell';
  const direct = s.refreshAllReceiptsPage('list');
  s.change();
  await drain();
  s.reads[0].reply([receipt(1)]);
  await direct;
  await drain();
  assert.equal(s.reads.length, 2);
  s.reads[1].fail();
  await drain();
  assert.equal(log.mock.callCount(), 1, 'background failure is reported');
  assert.equal(s.reads.length, 2, 'no automatic retry after failure');
  assert.deepEqual(s.cards(), [1]);
  s.f.number = ['2'];
  const retry = Promise.all([s.initAllReceiptsPage(), s.initAllReceiptsPage()]);
  await drain();
  assert.equal(s.reads.length, 3);
  assert.equal(s.reads[2].mode, 'search');
  assert.equal(s.reads[2].passive, false);
  s.reads[2].reply([receipt(2)]);
  await retry;
  assert.deepEqual(s.cards(), [2]);
  await s.initAllReceiptsPage();
  await drain();
  assert.equal(s.reads.length, 3, 'clean navigation did not read again');
  assert.equal(s.page.innerHTML, 'existing shell');
  assert.equal(binds.mock.callCount() + pageBinds.mock.callCount(), 0);
});

test('a direct read can win the queued microtask: no overlap, no lost active priority or newer event', async t => {
  const s = await openScreen(t, { owner: [owner] });
  s.change(); // Queued, not yet dispatched.
  const direct = s.refreshAllReceiptsPage('list', { passive: true });
  s.change(true); // New invalidation after the direct read actually started.
  await drain();
  assert.equal(s.reads.length, 1, 'scheduled callback did not start a competing request');
  assert.equal(s.reads[0].mode, 'search');
  assert.equal(s.reads[0].passive, false, 'the read serving the active change cannot be passive');
  s.reads[0].reply([], { client_names: [] });
  await direct;
  await drain();
  assert.equal(s.reads.length, 2);
  assert.equal(s.reads[1].passive, true, 'only the later event belongs to this batch');
  assert.deepEqual(s.reads[1].params.client_name, [owner]);
  s.reads[1].reply([receipt(2)], { client_names: [owner] });
  await drain();
  assert.deepEqual(s.cards(), [2]);
  assert.equal(s.reads.length, 2);
});

test('an ordinary refresh reads once; a passive event during a scheduled active read gets its own passive follow-up', async t => {
  const s = await openScreen(t);
  const ordinary = s.refreshAllReceiptsPage('list');
  s.reads[0].reply([receipt(2)]);
  await ordinary;
  await s.initAllReceiptsPage();
  await drain();
  assert.equal(s.reads.length, 1);
  s.change();
  await drain();
  assert.equal(s.reads.length, 2);
  assert.equal(s.reads[1].passive, false);
  s.change(true);
  s.change(true);
  s.reads[1].reply([receipt(2)]);
  await drain();
  assert.equal(s.reads.length, 3);
  assert.equal(s.reads[2].passive, true);
  s.reads[2].reply([receipt(3)]);
  await drain();
  assert.deepEqual(s.cards(), [3]);
  assert.equal(s.reads.length, 3);
});

// Use the real quick-range calendar and debounce, without wall-clock sleeps.
function clockAtMay15(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-05-15T12:00:00Z') });
  return t.mock.timers;
}

test('clear dates uses the automatic debounce and preserves other filters', async t => {
  const clock = clockAtMay15(t);
  const s = await openScreen(t, { owner: [owner], number: ['1'], company: [office], sortByPayoutDate: true });
  assert.match(s.page.innerHTML, /data-action="clear-receipt-dates"[^>]*>مسح<\/button>/);
  s.clearDates();
  assert.deepEqual([s.f.from, s.f.to], ['', '']);
  assert.equal(s.page.querySelector(dateSelector('from')).value, '');
  assert.equal(s.page.querySelector(dateSelector('to')).value, '');
  assert.deepEqual([s.f.owner, s.f.number, s.f.company, s.f.sortByPayoutDate], [[owner], ['1'], [office], true]);
  clock.tick(399); await drain();
  assert.equal(s.reads.length, 0);
  clock.tick(1); await drain();
  assert.equal(s.reads.length, 1);
  assert.equal(s.reads[0].mode, 'list');
  assert.deepEqual(s.reads[0].params, {});
  const old = { ...receipt(1), receipt_date: '2000-01-01', paid: 12345 };
  s.reads[0].reply([old, receipt(2), receipt(3, 'Other owner')]);
  await drain();
  assert.deepEqual(s.cards(), [1]);
  assert.deepEqual(summaryValues(), ['123.45', '1', '0.00']);
  assert.deepEqual([s.f.owner, s.f.number, s.f.company, s.f.sortByPayoutDate], [[owner], ['1'], [office], true]);
  s.clearDates();
  clock.tick(400); await drain();
  assert.equal(s.reads.length, 1, 'clearing already empty dates does not initiate a read');
});

test('clear dates coalesces a pending single-bound edit into one unbounded read', async t => {
  const clock = clockAtMay15(t);
  const s = await openScreen(t);
  s.inputDate('from', '');
  clock.tick(250);
  s.clearDates();
  assert.deepEqual([s.f.from, s.f.to], ['', '']);
  assert.equal(s.page.querySelector(dateSelector('from')).value, '');
  assert.equal(s.page.querySelector(dateSelector('to')).value, '');
  clock.tick(399); await drain();
  assert.equal(s.reads.length, 0);
  clock.tick(1); await drain();
  assert.equal(s.reads.length, 1);
  assert.deepEqual(s.reads[0].params, {});
  s.reads[0].reply([receipt(1)]);
  await drain();
  clock.tick(400); await drain();
  assert.equal(s.reads.length, 1);
});

test('clear dates during an in-flight read drains the latest unbounded range', async t => {
  const clock = clockAtMay15(t);
  const s = await openScreen(t, { owner: [owner] });
  const held = s.refresh();
  assert.equal(s.reads[0].mode, 'search');
  s.clearDates();
  assert.deepEqual([s.f.from, s.f.to], ['', '']);
  assert.deepEqual(s.f.owner, [owner]);
  clock.tick(400); await drain();
  assert.equal(s.reads.length, 1, 'no overlapping request');
  s.reads[0].reply([receipt(9, 'Obsolete')], { client_names: ['Obsolete'] });
  await held; await drain();
  assert.equal(s.reads.length, 2);
  assert.equal(s.reads[1].mode, 'list');
  assert.deepEqual(s.reads[1].params, {});
  assert.deepEqual(s.cards(), [1], 'stale data was not published');
  s.reads[1].reply([{ ...receipt(2), receipt_date: '2000-01-01' }]);
  await drain();
  assert.deepEqual(s.cards(), [2]);
  assert.deepEqual(s.f.owner, [owner]);
});

function assertList(read, from, to, passive = false) {
  assert.equal(read.mode, 'list');
  assert.deepEqual(read.params, { from_date: from, to_date: to });
  assert.equal(read.passive, passive);
}

test('a quick range during the initial list invalidates it before it can render or prune', async t => {
  clockAtMay15(t);
  const s = await mountScreen(t, { ...mayRange, company: [office] });
  assertList(s.reads[0], '2026-05-01', '2026-05-31');
  s.quickRange(7);
  assert.equal(s.page.querySelector(dateSelector('from')).value, '2026-05-09');
  assert.equal(s.page.querySelector(dateSelector('to')).value, '2026-05-15');
  assert.equal(s.reads.length, 1, 'wait for the initial read to release');
  s.reads[0].reply([receipt(9, owner, 'Obsolete office')]);
  await drain();
  assert.equal(s.reads.length, 2);
  assertList(s.reads[1], '2026-05-09', '2026-05-15');
  assert.deepEqual(s.STATE.receipts, []);
  assert.equal(s.STATE.ready, false);
  assert.deepEqual(s.cards(), []);
  assert.deepEqual(s.f.company, [office]);
  s.reads[1].reply([receipt(2)]);
  await s.initial;
  await drain();
  assert.equal(s.STATE.ready, true);
  assert.deepEqual(s.cards(), [2]);
  assert.equal(s.reads.length, 2);
});

test('several quick ranges during the trailing passive list produce one active read for the last range', async t => {
  clockAtMay15(t);
  const s = await openScreen(t, { company: [office] });
  s.refresh();
  s.change(true);
  s.reads[0].reply([receipt(8)]);
  await drain();
  assert.equal(s.reads.length, 2);
  assertList(s.reads[1], '2026-05-01', '2026-05-31', true);

  // No further domain event: the buttons alone must invalidate this trailing read.
  s.quickRange(7);
  s.quickRange(1);
  await drain();
  assert.equal(s.reads.length, 2);
  s.reads[1].reply([receipt(9, owner, 'Obsolete office')]);
  await drain();
  assert.equal(s.reads.length, 3);
  assertList(s.reads[2], '2026-05-15', '2026-05-15');
  assert.deepEqual(s.cards(), [1]);
  assert.deepEqual(s.STATE.receipts.map(r => r.id), [1]);
  assert.deepEqual(s.f.company, [office]);
  s.quickRange(1); // unchanged: don't invalidate the read already serving this day
  s.inputDate('to', '2026-05-15');
  s.reads[2].reply([receipt(3)]);
  await drain();
  assert.deepEqual(s.cards(), [3]);
  assert.equal(s.reads.length, 3);
});

test('date inputs supersede a held search before the debounce expires; stale meta/options cannot prune selections', async t => {
  const clock = clockAtMay15(t);
  const s = await openScreen(t, { owner: [owner], company: [office] });
  s.refresh();
  assert.equal(s.reads[0].mode, 'search');
  s.inputDate('from', '2026-05-04');
  s.inputDate('to', '2026-05-25');
  s.inputDate('from', '2026-05-12');
  s.reads[0].reply([receipt(9, 'Obsolete owner', 'Obsolete office')],
    { client_names: ['Obsolete owner'], company_names: ['Obsolete office'] });
  await drain(); // no clock tick: the change was recorded by the input, not by its timer
  assert.equal(s.reads.length, 2);
  assert.deepEqual(s.STATE.receipts.map(r => r.id), [1]);
  assert.deepEqual(s.cards(), [1]);
  assert.equal(s.STATE.meta, null);
  assert.equal(s.STATE.options, null);
  assert.deepEqual(s.f.owner, [owner]);
  assert.deepEqual(s.f.company, [office]);
  const next = s.reads[1];
  assert.equal(next.mode, 'search');
  assert.equal(next.passive, false);
  assert.deepEqual(next.params, { from_date: '2026-05-12', to_date: '2026-05-25',
    limit: 0, offset: 0, include_options: '1', client_name: [owner] });
  const options = { client_names: [owner], company_names: [office] };
  next.reply([receipt(2)], options);
  await drain();
  clock.tick(800);
  await drain();
  assert.deepEqual(s.STATE.options, options);
  assert.deepEqual(s.cards(), [2]);
  assert.equal(s.reads.length, 2, 'no delayed duplicate');
});

test('idle date typing debounces; a newer date while that list is held still drains after rejection', async t => {
  const clock = clockAtMay15(t);
  const s = await openScreen(t);
  const log = t.mock.method(console, 'error', () => {});
  s.inputDate('from', '2026-05-03');
  clock.tick(300);
  s.inputDate('from', '2026-05-10');
  clock.tick(399);
  await drain();
  assert.equal(s.reads.length, 0);
  clock.tick(1);
  await drain();
  assert.equal(s.reads.length, 1);
  assertList(s.reads[0], '2026-05-10', '2026-05-31');
  s.inputDate('to', '2026-05-24');
  clock.tick(800);
  await drain();
  assert.equal(s.reads.length, 1, 'even after the debounce interval, the loader is still busy');
  s.reads[0].fail();
  await drain();
  assert.equal(log.mock.callCount(), 1);
  assert.equal(s.reads.length, 2);
  assertList(s.reads[1], '2026-05-10', '2026-05-24');
  assert.deepEqual(s.cards(), [1]);
  s.reads[1].reply([receipt(2)]);
  await drain();
  assert.deepEqual(s.cards(), [2]);
  assert.equal(s.reads.length, 2);
});

test('failed automatic date read stays pending; re-entry and later domain refreshes work', async t => {
  const clock = clockAtMay15(t);
  const s = await openScreen(t);
  const log = t.mock.method(console, 'error', () => {});
  s.inputDate('from', '2026-05-11');
  clock.tick(400); await drain();
  assertList(s.reads[0], '2026-05-11', '2026-05-31');
  s.reads[0].fail();
  await drain();
  assert.equal(log.mock.callCount(), 1);
  assert.equal(s.STATE.loading, false);
  clock.tick(1000);
  await drain();
  assert.equal(s.reads.length, 1, 'failure must not trigger a timer retry');
  assert.deepEqual(s.cards(), [1]);
  const retry = s.initAllReceiptsPage();
  await drain();
  assert.equal(s.reads.length, 2);
  assertList(s.reads[1], '2026-05-11', '2026-05-31');
  s.reads[1].reply([receipt(2)]);
  await retry;
  assert.deepEqual(s.cards(), [2]);
  s.change(true, 'offices:changed');
  s.change(true, 'receipts:changed');
  await drain();
  assert.equal(s.reads.length, 3);
  assertList(s.reads[2], '2026-05-11', '2026-05-31', true);
  s.reads[2].reply([receipt(3)]);
  await drain();
  assert.deepEqual(s.cards(), [3]);
  await s.initAllReceiptsPage();
  assert.equal(s.reads.length, 3);
});

function assertSearch(read, from, to, filters, passive = false) {
  assert.equal(read.mode, 'search');
  assert.deepEqual(read.params, { from_date: from, to_date: to, limit: 0, offset: 0, include_options: '1', ...filters });
  assert.equal(read.passive, passive);
}

test('date-wide options prune the last owner: never publish the narrow result; one list shows the new owner', async t => {
  const clock = clockAtMay15(t);
  const s = await mountScreen(t, { from: '2000-04-01', to: '2000-04-30', owner: [owner], company: [office] });
  const previous = { ...receipt(1), receipt_date: '2000-04-15' };
  const current = receipt(2, 'Owner B');
  s.reads.shift().reply([previous]);
  await s.initial;
  assert.deepEqual(s.cards(), [1]);
  const list = document.getElementById('receiptsList');
  let html = list.innerHTML;
  const publish = t.mock.fn(value => { html = value; });
  Object.defineProperty(list, 'innerHTML', { get: () => html, set: publish });

  s.quickRange(1);
  assertSearch(s.reads[0], '2026-05-15', '2026-05-15', { client_name: [owner] });
  s.reads[0].reply([], { client_names: ['Owner B'], company_names: [office], receipt_numbers: ['2'] });
  await drain();
  assert.equal(s.reads.length, 2);
  assertList(s.reads[1], '2026-05-15', '2026-05-15');
  assert.deepEqual(s.f.owner, []);
  assert.deepEqual(s.f.company, [office]);
  assert.deepEqual(s.STATE.receipts, [previous]);
  assert.equal(s.STATE.meta, null, 'the empty owner search did not publish its summary/meta');
  assert.equal(publish.mock.callCount(), 0, 'not even a transient empty-state render');
  assert.deepEqual(s.cards(), [1]);
  s.reads[1].reply([current]);
  await drain();
  assert.deepEqual(s.cards(), [2]);
  assert.equal(publish.mock.callCount(), 1);
  clock.tick(1000);
  await drain();
  assert.equal(s.reads.length, 2, 'exactly one corrective read, without navigation');
});

test('two pruned query selections share one passive follow-up; newer dates supersede it without pruning valid choices', async t => {
  const clock = clockAtMay15(t);
  const other = 'Owner B';
  const s = await mountScreen(t, { ...mayRange, owner: [owner, other], number: ['1', '2'], company: [office] }, ['owner', 'number', 'company']);
  s.reads.shift().reply([receipt(1), receipt(2, other)]);
  await s.initial;
  const kept = { client_names: [owner], receipt_numbers: ['1'], company_names: [office] };
  const filters = { client_name: [owner], receipt_number: ['1'] };
  s.change(true);
  await drain();
  assertSearch(s.reads[0], '2026-05-01', '2026-05-31', { client_name: [owner, other], receipt_number: ['1', '2'] }, true);
  s.reads[0].reply([receipt(1)], kept);
  await drain();
  assert.equal(s.reads.length, 2);
  assertSearch(s.reads[1], '2026-05-01', '2026-05-31', filters, true);
  assert.deepEqual(s.cards(), [2, 1], 'a partial prune must not publish the old search either');

  s.inputDate('from', '2026-05-04');
  s.inputDate('to', '2026-05-25');
  s.inputDate('from', '2026-05-12');
  clock.tick(800);
  await drain();
  assert.equal(s.reads.length, 2, 'no overlapping read while the correction is in flight');
  s.reads[1].reply([], { client_names: [other], receipt_numbers: ['2'], company_names: [] });
  await drain();
  assert.equal(s.reads.length, 3);
  assertSearch(s.reads[2], '2026-05-12', '2026-05-25', filters);
  assert.deepEqual(s.f.owner, [owner]);
  assert.deepEqual(s.f.number, ['1']);
  assert.deepEqual(s.f.company, [office]);
  assert.deepEqual(s.STATE.options, kept, 'obsolete options did not reach the controls or cache');
  s.reads[2].reply([receipt(1)], kept);
  await drain();
  assert.deepEqual(s.cards(), [1]);
  assert.equal(s.reads.length, 3, 'unchanged effective query is settled');
});

test('a search snapshot detects a replaced number even without a date or domain event', async t => {
  const s = await openScreen(t, { owner: [owner], number: ['1'] });
  s.refresh();
  assertSearch(s.reads[0], s.f.from, s.f.to, { client_name: [owner], receipt_number: ['1'] });
  s.f.number[0] = '2'; // same array, same length, different effective query
  s.reads[0].reply([], { client_names: [], receipt_numbers: [] });
  await drain();
  assert.equal(s.reads.length, 2);
  assertSearch(s.reads[1], '2026-05-01', '2026-05-31', { client_name: [owner], receipt_number: ['2'] });
  assert.deepEqual(s.f.owner, [owner]);
  assert.equal(s.STATE.options, null);
  assert.deepEqual(s.cards(), [1]);
  s.reads[1].reply([receipt(2)], { client_names: [owner], receipt_numbers: ['2'] });
  await drain();
  assert.deepEqual(s.cards(), [2]);
  assert.equal(s.reads.length, 2);
});

test('partial options do not clear an omitted owner selection; row-only pruning does not repeat the search', async t => {
  const s = await openScreen(t, { owner: [owner], company: [office] });
  s.refresh();
  assertSearch(s.reads[0], '2026-05-01', '2026-05-31', { client_name: [owner] });
  s.reads[0].reply([receipt(2, owner, 'New office')], { company_names: ['New office'] });
  await drain();
  assert.deepEqual(s.f.owner, [owner]);
  assert.deepEqual(s.f.company, [], 'the supplied office options are still authoritative');
  assert.deepEqual(s.cards(), [2]);
  assert.equal(s.reads.length, 1);
});

test('a failed corrective list keeps the pruned query pending for re-entry without retrying on a timer', async t => {
  const clock = clockAtMay15(t);
  const s = await openScreen(t, { owner: [owner] });
  const log = t.mock.method(console, 'error', () => {});
  s.change(true);
  await drain();
  assertSearch(s.reads[0], '2026-05-01', '2026-05-31', { client_name: [owner] }, true);
  s.reads[0].reply([], { client_names: ['Owner B'] });
  await drain();
  assertList(s.reads[1], '2026-05-01', '2026-05-31', true);
  s.reads[1].fail();
  await drain();
  clock.tick(1000);
  await drain();
  assert.equal(log.mock.callCount(), 1);
  assert.equal(s.reads.length, 2);
  assert.equal(s.STATE.loading, false);
  assert.deepEqual(s.f.owner, []);
  assert.deepEqual(s.cards(), [1]);
  const retry = Promise.all([s.initAllReceiptsPage(), s.initAllReceiptsPage()]);
  await drain();
  assert.equal(s.reads.length, 3);
  assertList(s.reads[2], '2026-05-01', '2026-05-31', true);
  s.reads[2].reply([receipt(2, 'Owner B')]);
  await retry;
  assert.deepEqual(s.cards(), [2]);
});

test('clearing both dates during search coalesces to one unbounded list with owner AND number applied', async t => {
  const s = await mountScreen(t, { ...mayRange, owner: [owner], number: ['1', '2'] }, ['owner', 'number']);
  const match = receipt(1), wrongOwner = receipt(2, 'Other owner'), wrongNumber = receipt(3);
  s.reads.shift().reply([match, wrongOwner]);
  await s.initial;
  s.refresh();
  assertSearch(s.reads[0], '2026-05-01', '2026-05-31', { client_name: [owner], receipt_number: ['1', '2'] });
  s.inputDate('from', '');
  s.inputDate('to', '');
  s.reads[0].reply([], { client_names: [], receipt_numbers: [] });
  await drain();
  assert.equal(s.reads.length, 2);
  assert.equal(s.reads[1].mode, 'list');
  assert.deepEqual(s.reads[1].params, {});
  s.reads[1].reply([match, wrongOwner, wrongNumber]);
  await drain();
  assert.deepEqual(s.f.owner, [owner]);
  assert.deepEqual(s.f.number, ['1', '2']);
  assert.deepEqual(s.cards(), [1]);
  assert.equal(s.reads.length, 2);
});

for (const filter of ['owner', 'number']) {
  for (const cleared of ['from', 'to']) {
    test(`clearing ${cleared} with ${filter} selected uses an open list bound for debounce and explicit refresh`, async t => {
      const clock = clockAtMay15(t);
      // An open upper bound must reach future receipts; an open lower bound must reach old ones.
      const year = cleared === 'from' ? '2000' : '2040';
      const from = `${year}-04-01`, to = `${year}-04-30`;
      const selected = filter === 'owner' ? [owner] : ['1'];
      const s = await mountScreen(t, { from, to, [filter]: selected }, ['owner', 'number']);
      const match = { ...receipt(1), receipt_date: `${year}-04-15` };
      const other = { ...receipt(2, 'Other owner'), receipt_date: `${year}-04-20` };
      const beyond = { ...receipt(3), receipt_date: cleared === 'from' ? '1990-01-01' : '2050-01-01' };
      s.reads.shift().reply([match, other]);
      await s.initial;
      assert.deepEqual(s.cards(), [1]);

      s.inputDate(cleared, '');
      clock.tick(400);
      await drain();
      const params = cleared === 'from' ? { to_date: to } : { from_date: from };
      const visible = filter === 'owner' ? [3, 1] : [1];
      function releaseOpenList(read) {
        assert.equal(read.mode, 'list');
        assert.deepEqual(read.params, params, 'only the non-empty date is sent, without a default or sentinel');
        read.reply([match, other, beyond]);
      }
      assert.equal(s.reads.length, 1);
      releaseOpenList(s.reads[0]);
      await drain();
      assert.equal(s.f[cleared], '');
      assert.deepEqual(s.f[filter], selected);
      assert.deepEqual(s.cards(), visible);
      assert.equal(s.STATE.meta, null);
      assert.equal(s.reads.length, 1);

      // Even a direct search request must not reintroduce a default after the date change settled.
      s.refresh();
      releaseOpenList(s.reads[1]);
      await drain();
      assert.deepEqual(s.cards(), visible);
      assert.equal(s.reads.length, 2);
    });
  }
}

for (const [action, click, from, to] of [
  ['quick range', s => s.quickRange(7), '2026-05-09', '2026-05-15'],
]) {
  test(`browser click: failed ${action} reports once, restores controls, and retries only on re-entry`, async t => {
    const clock = clockAtMay15(t);
    const s = await openScreen(t, { owner: [owner] }); // a search actually disables the controls
    const log = t.mock.method(console, 'error', () => {});
    const unhandled = t.mock.fn();
    process.on('unhandledRejection', unhandled);
    t.after(() => process.off('unhandledRejection', unhandled));
    const overlay = document.getElementById('receiptsLoadingOverlay');
    const hidden = () => overlay.classList.contains('ar-loading-overlay--hidden');
    const disabled = () => s.controls.map(el => el.disabled);
    const original = disabled();
    assert.ok(original.includes(true) && original.includes(false));
    assert.ok(hidden());

    assert.equal(click(s), true, 'dispatch returns synchronously, not a listener Promise');
    assertSearch(s.reads[0], from, to, { client_name: [owner] });
    assert.equal(s.STATE.loading, true);
    assert.equal(hidden(), false);
    assert.ok(disabled().every(Boolean));
    const failure = new Error(`${action} read failed`);
    s.reads[0].fail(failure);
    await drain(); // cross the unhandled-rejection checkpoint, without catching the listener's return
    assert.equal(unhandled.mock.callCount(), 0);
    assert.deepEqual(log.mock.calls.map(c => c.arguments), [['[allReceipts] refresh failed:', failure]]);
    assert.equal(s.STATE.loading, false);
    assert.ok(hidden());
    assert.deepEqual(disabled(), original, 'previously disabled controls must stay disabled');
    assert.ok(s.controls.every(el => !('wasDisabled' in el.dataset)));
    assert.deepEqual(s.cards(), [1]);
    clock.tick(1000);
    await drain();
    assert.equal(s.reads.length, 1, 'no automatic retry');

    const retry = Promise.all([s.initAllReceiptsPage(), s.initAllReceiptsPage()]);
    await drain();
    assert.equal(s.reads.length, 2, 'two re-entries share one retry');
    assertSearch(s.reads[1], from, to, { client_name: [owner] });
    s.reads[1].reply([receipt(2)], { client_names: [owner] });
    await retry;
    assert.deepEqual(s.cards(), [2]);
    await s.initAllReceiptsPage();
    assert.equal(s.reads.length, 2);
    assert.equal(log.mock.callCount(), 1);
  });
}

test('a failed quick range superseded by passive events leaves their single follow-up passive', async t => {
  clockAtMay15(t);
  const s = await openScreen(t, { from: '2026-04-16', to: '2026-05-15' });
  const log = t.mock.method(console, 'error', () => {});
  s.quickRange(30);
  s.change(true);
  s.change(true, 'offices:changed');
  s.reads[0].fail();
  await drain();
  assert.equal(log.mock.callCount(), 1);
  assert.equal(s.reads.length, 2);
  assertList(s.reads[1], s.f.from, s.f.to, true);
  s.reads[1].reply([receipt(2)]);
  await drain();
  assert.deepEqual(s.cards(), [2]);
  await s.initAllReceiptsPage();
  assert.equal(s.reads.length, 2, 'the older click failure must not leave another retry behind');
});

test('initialization and explicit refresh still reject with the original error to their callers', async t => {
  const s = await mountScreen(t, mayRange);
  const log = t.mock.method(console, 'error', () => {});
  const initialError = new Error('initial list unavailable');
  s.reads[0].fail(initialError);
  await assert.rejects(s.initial, err => err === initialError);
  assert.equal(s.STATE.loading, false);
  const direct = s.refreshAllReceiptsPage('search');
  const searchError = new Error('explicit search unavailable');
  s.reads[1].fail(searchError);
  await assert.rejects(direct, err => err === searchError);
  await drain();
  assert.equal(s.STATE.ready, false);
  assert.equal(s.reads.length, 2);
  assert.equal(log.mock.callCount(), 0, 'programmatic errors belong to the caller, not the click reporter');
});

// Type in the real multi-select, check the matching option and confirm (OK).
function selectOption(key, query, value) {
  const slot = document.getElementById(`ms-slot-${key}`);
  slot.children[0].fire('click');
  const popup = slot.children.at(-1);
  const input = popup.querySelector('.ms-filter-search');
  input.value = query;
  input.fire('input');
  const list = popup.querySelector('.ms-filter-list');
  const choices = [...list.innerHTML.matchAll(/data-value="([^"]*)"/g)].map(m => m[1]);
  assert.ok(choices.includes(value), 'option exists in the current date-wide choices');
  list.fire('change', { target: { closest: () => ({ checked: true, dataset: { value } }) } });
  popup.fire('click', { target: { closest: selector => selector === '.ms-filter-btn--ok' } });
  return choices;
}

function summaryValues() {
  const html = document.getElementById('receiptsSummaryContainer').innerHTML;
  return [...html.matchAll(/class="summary-card__value">([^<]+)</g)].map(m => m[1]);
}

test('fresh fields and list are unbounded; clearing a preset reveals old Ahmed to customer and receipt-number searches', async t => {
  const clock = clockAtMay15(t);
  globalThis.requestAnimationFrame = () => {}; // popup focus is immaterial to selection
  t.after(() => { delete globalThis.requestAnimationFrame; });
  const s = await mountScreen(t, {}, ['owner', 'number', 'company']); // no injected dates
  assert.deepEqual([s.f.from, s.f.to], ['', '']);
  for (const key of ['from', 'to']) assert.match(s.page.innerHTML, new RegExp(`data-filter-key="${key}" type="date" value=""`));
  const customer = 'أحمد', selectedOffice = 'مكتب طنطا';
  const old = { ...receipt(1, customer), receipt_date: '2000-04-15', receipt_number: '001', paid: 12345,
    rows: [{ kartano: 'OLD-A', office: selectedOffice, sarf: 1.25 }, { _type: 'separator' }, { kartano: 'OLD-B', office, sarf: 2.5 }] };
  const alsoAhmed = { ...receipt(2, customer), receipt_date: '2001-04-15' };
  const recent = Array.from({ length: 51 }, (_, i) => receipt(3 + i, 'Other'));
  const all = [...recent, alsoAhmed, old];
  function replyAll() {
    const read = s.reads.shift();
    assert.equal(read.mode, 'list');
    assert.deepEqual(read.params, {}, 'neither a hidden bound nor a display limit is sent');
    read.reply(all);
  }
  replyAll();
  await s.initial;
  assert.equal(s.cards().length, 53);
  assert.ok(s.cards().includes(old.id), 'all loaded records are displayed');
  assert.deepEqual(summaryValues(), ['123.45', '54', '3.75']);

  s.quickRange(7);
  assertList(s.reads[0], '2026-05-09', '2026-05-15');
  s.reads.shift().reply(recent);
  await drain();
  s.inputDate('from', ''); s.inputDate('to', '');
  clock.tick(400); await drain();
  replyAll(); await drain();
  selectOption('owner', 'أحم', customer);
  replyAll(); await drain();
  assert.deepEqual(s.cards(), [2, 1]);
  selectOption('number', '001', '001');
  replyAll(); await drain();
  assert.deepEqual(s.cards(), [1]);
  assert.deepEqual(summaryValues(), ['123.45', '2', '3.75']);

  selectOption('company', 'طنطا', selectedOffice); // only one row in the selected receipt
  assert.deepEqual(s.cards(), [1]);
  assert.deepEqual(summaryValues(), ['123.45', '1', '1.25']);
  const out = captureBulkOutput(t, s);
  out.clickBoth(true);
  assert.equal((out.pdf[0].match(/<section class="print-card">/g) || []).length, 1);
  assert.ok(out.pdf[0].includes(customer));
  assert.match(out.pdf[0], /OLD-A/); assert.doesNotMatch(out.pdf[0], /OLD-B|Other/);
  const printSummary = out.pdf[0].split('</table>', 1)[0];
  for (const value of summaryValues()) assert.ok(printSummary.includes(`>${value}<`));
  assert.deepEqual(out.excel[0].map(row => [row['صاحب المركبة'], row['رقم الكارتة'], row['الصرف']]), [[customer, 'OLD-A', 1.25]]);

  s.inputDate('from', old.receipt_date); s.inputDate('to', old.receipt_date);
  clock.tick(400); await drain();
  assertSearch(s.reads[0], old.receipt_date, old.receipt_date, { client_name: [customer], receipt_number: ['001'] });
  s.reads.shift().reply([old], { client_names: [customer], receipt_numbers: ['001'], company_names: [selectedOffice, office] });
  await drain();
  assert.deepEqual(s.cards(), [1], 'both explicit boundaries are inclusive');
  assert.deepEqual(summaryValues(), ['123.45', '1', '1.25']);
});

for (const [label, row, option] of [
  ['string', { kartano: '101' }, '101'],
  ['number', { kartano: 101 }, '101'],
  ['zero with legacy subtotal fields', { kartano: 0, vehicleName: 'V', subtotal: 0 }, '0'],
  ['null', { kartano: null }, null],
  ['missing', {}, null],
  ['empty with legacy kartaNo', { kartano: '', kartaNo: '00101' }, '00101'],
  ['zero before a fallback alias', { kartaNo: 0, karta: 'other' }, '0'],
]) {
  test(`unbounded startup and karta filter: ${label} identifier`, async t => {
    globalThis.requestAnimationFrame = () => {}; // popup focus only
    t.after(() => { delete globalThis.requestAnimationFrame; });
    const s = await mountScreen(t, {}, ['karta']);
    const old = { ...receipt(1, 'أحمد'), receipt_date: '2000-04-15', rows: [structuredClone(row)] };
    const read = s.reads.shift();
    assert.equal(read.mode, 'list');
    assert.deepEqual(read.params, {});
    read.reply([old, receipt(2)]);
    await s.initial;
    assert.equal(s.STATE.ready, true);
    assert.deepEqual(s.cards(), [2, 1], 'the old receipt is visible before filtering');
    assert.equal(summaryValues()[1], '2', 'both data rows count, including an identifier of zero');

    const choices = selectOption('karta', '', option ?? 'K2');
    assert.deepEqual(choices, option === null ? ['K2'] : [option, 'K2']);
    assert.deepEqual(s.cards(), option === null ? [2] : [1]);
    assert.deepEqual(s.STATE.receipts.find(r => r.id === old.id).rows[0], row, 'stored identifier is unchanged');
    assert.equal(s.reads.length, 0, 'karta filtering is local');
  });
}

test('each bound is inclusive and independently removable; an inverted range is not repaired', async t => {
  const clock = clockAtMay15(t);
  const s = await mountScreen(t);
  const from = '2000-02-29', to = '2000-03-01';
  const all = ['1990-01-01', from, to, '2040-01-01'].map((date, i) => ({ ...receipt(i + 1), receipt_date: date }));
  s.reads.shift().reply(all); await s.initial;
  assert.deepEqual(s.cards(), [4, 3, 2, 1]);
  for (const [lower, upper, params, ids] of [
    [from, '', { from_date: from }, [4, 3, 2]],
    [from, to, { from_date: from, to_date: to }, [3, 2]],
    ['', to, { to_date: to }, [3, 2, 1]],
    [to, from, { from_date: to, to_date: from }, []],
    ['', '', {}, [4, 3, 2, 1]],
  ]) {
    s.inputDate('from', lower); s.inputDate('to', upper);
    clock.tick(400); await drain();
    const read = s.reads.shift();
    assert.equal(read.mode, 'list');
    assert.deepEqual(read.params, params);
    read.reply(all); // deliberate superset: exercise the view's own date checks too
    await drain();
    assert.deepEqual(s.cards(), ids);
    assert.equal(summaryValues()[1], String(ids.length));
  }
});

test('only configured quick-range actions change dates; a missing or invalid day count never selects a month', async t => {
  clockAtMay15(t);
  const s = await openScreen(t);
  for (const days of [undefined, '', 'invalid', -1, 0, 1.5, 90]) s.quickRange(days);
  assert.deepEqual([s.f.from, s.f.to], [mayRange.from, mayRange.to]);
  assert.equal(s.reads.length, 0);
  s.quickRange(30);
  assertList(s.reads[0], '2026-04-16', '2026-05-15');
  s.reads[0].reply([receipt(1)]);
  await drain();
});

// Capture the existing output generators at their boundaries. No printer or filesystem I/O.
function captureBulkOutput(t, s) {
  const pdf = [], excel = [];
  document.body = { appendChild() {} };
  const create = document.createElement;
  t.mock.method(document, 'createElement', tag => tag === 'iframe' ? {
    style: {}, contentDocument: { open() {}, write: html => pdf.push(html), close() {} },
    contentWindow: { focus() {}, print() {} }, remove() {},
  } : create(tag));
  window.XLSX = { utils: { json_to_sheet: rows => rows, book_new: () => ({}),
    book_append_sheet: (wb, rows) => { wb.rows = rows; } }, writeFile: wb => excel.push(wb.rows) };
  function clickBoth(ready) {
    const n = pdf.length;
    for (const button of s.bulkButtons) {
      assert.equal(button.disabled, !ready, button.dataset.action);
      s.clickBulk(button); // even a delegated/programmatic click must not bypass the guard
    }
    assert.equal(pdf.length, ready ? n + 1 : n);
    assert.equal(excel.length, pdf.length);
  }
  return { pdf, excel, clickBoth };
}

test('bulk output waits for the completed range across debounce, an obsolete read and a failed refresh', async t => {
  const clock = clockAtMay15(t);
  const s = await mountScreen(t, mayRange);
  const out = captureBulkOutput(t, s);
  const log = t.mock.method(console, 'error', () => {});
  out.clickBoth(false); // the first read has not published anything yet
  s.reads.shift().reply([receipt(1)]); await s.initial;
  s.inputDate('from', '2026-05-20');
  s.renderAll(); // a local redraw during debounce must not mix the new range with the old data
  assert.deepEqual(s.cards(), [1]);
  assert.deepEqual(summaryValues(), ['0.00', '1', '0.00']);
  s.inputDate('from', ''); s.inputDate('to', '');
  clock.tick(399); await drain();
  assert.equal(s.reads.length, 0);
  out.clickBoth(false);
  clock.tick(1); await drain();
  assert.deepEqual(s.reads[0].params, {});
  out.clickBoth(false);
  s.change(true);
  s.reads[0].reply([receipt(5, 'Obsolete')]);
  await drain();
  out.clickBoth(false);
  s.reads[1].fail(); await drain();
  assert.equal(log.mock.calls.filter(({ arguments: [message] }) => message === '[allReceipts] refresh failed:').length, 1);
  out.clickBoth(false);
  assert.deepEqual(s.cards(), [1], 'last completed view retained');

  const retry = s.initAllReceiptsPage();
  await drain();
  const old = { ...receipt(2, 'Ahmed'), receipt_date: '1999-01-01', paid: 100, rows: [{ kartano: 'Old', sarf: 7.5 }] };
  const recent = Array.from({ length: 50 }, (_, i) => receipt(10 + i));
  s.reads[2].reply([...recent, old]); await retry;
  assert.equal(s.cards().length, 51);
  assert.ok(s.cards().includes(old.id));
  assert.deepEqual(summaryValues(), ['1.00', '51', '7.50']);
  assert.equal(out.pdf.length + out.excel.length, 0, 'blocked clicks were not queued for replay');
  out.clickBoth(true);
  assert.equal((out.pdf[0].match(/<section class="print-card">/g) || []).length, 51);
  assert.match(out.pdf[0], /Ahmed/); assert.doesNotMatch(out.pdf[0], /Obsolete/);
  assert.equal(out.excel[0].length, 51);
  assert.equal(out.excel[0].at(-1)['رقم الكارتة'], 'Old');
});

test('bulk actions also block an ordinary in-flight search and only resume after successful publication', async t => {
  clockAtMay15(t);
  const s = await openScreen(t, { owner: [owner] });
  const out = captureBulkOutput(t, s);
  out.clickBoth(true);
  const search = s.refreshAllReceiptsPage('search'); // no date or revision change
  out.clickBoth(false);
  s.reads[0].fail(); await assert.rejects(search);
  out.clickBoth(false);
  const retry = s.refreshAllReceiptsPage('search');
  s.reads[1].reply([receipt(3)], { client_names: [owner] }); await retry;
  out.clickBoth(true);
  assert.equal(out.excel.at(-1)[0]['رقم الكارتة'], 'K3');
  s.change(true); // event scheduled, but the next read has not started
  out.clickBoth(false);
  await drain();
  s.reads[2].reply([receipt(4)], { client_names: [owner] }); await drain();
  out.clickBoth(true);
  assert.equal(out.excel.at(-1)[0]['رقم الكارتة'], 'K4');
});

test('list and direct search serialize only the supplied date boundaries on the wire', async t => {
  globalThis.document = { addEventListener() {}, getElementById: () => null };
  globalThis.window = Object.assign(new EventTarget(), { SERVER_MODE_READY: true });
  const { activateServerMode, activateLocalMode } = await import('../services/apiConfig.js');
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ success: true, data: [] }));
  activateServerMode();
  t.after(activateLocalMode);
  const { ReceiptsModule } = await import('../receipts.js');
  for (const bounds of [{}, { from_date: '2040-01-01' }, { to_date: '1999-01-01' },
    { from_date: '2000-01-01', to_date: '2000-01-31' }]) {
    const { from_date = '', to_date = '' } = bounds;
    await ReceiptsModule.getByDateRange('fixture', from_date, to_date);
    await ReceiptsModule.searchReceipts({ from_date, to_date, client_name: ['Ahmed'], limit: 0 });
    const [list, search] = fetch.mock.calls.slice(-2).map(({ arguments: [url, options] }) => {
      assert.equal(options.method, 'GET');
      return new URL(url, 'https://fixture.invalid');
    });
    assert.ok(list.pathname.endsWith('/entities/receipts/list.php'));
    assert.ok(search.pathname.endsWith('/entities/receipts/search.php'));
    assert.deepEqual(Object.fromEntries(list.searchParams), bounds);
    assert.deepEqual(Object.fromEntries(search.searchParams), { ...bounds, 'client_name[]': 'Ahmed', limit: '0' });
  }
  assert.equal(fetch.mock.callCount(), 8);
});
