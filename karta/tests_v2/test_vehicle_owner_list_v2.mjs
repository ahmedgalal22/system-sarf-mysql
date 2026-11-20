/** node --test karta/tests_v2/test_vehicle_owner_list_v2.mjs
 * PHP_BIN defaults to php (CLI + pdo_sqlite). SQL fixture lives exclusively in :memory:.
 * All HTTP (including import POSTs) is mocked in-process; no application server or DB config.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'Africa/Cairo';
globalThis.window = Object.assign(new EventTarget(), { SERVER_MODE_READY: true });
const { activateServerMode } = await import('../services/apiConfig.js');
activateServerMode();
const { FinancialService } = await import('../financial.js');
const { Money } = await import('../money.js');
const { OwnerListRepository } = await import('../services/ownerListRepository.js');
const { loadOwners, attachOwnersPageListeners, notifyReceiptStatusChanged } = await import('../entities.js');
const { AuthModule } = await import('../auth.js');
const fixture = fileURLToPath(new URL('./fixtures/owner_list_snapshot.php', import.meta.url));
const owner = (id, extra = {}) => ({ id, username: 'alpha', name: `Owner ${id}`, phone: null, owner_type: 'owner',
  created_at: '2026-01-01', updated_at: '2026-07-31', deleted_at: null, ...extra });
const entry = (id, client, type, amount, extra = {}) => ({ id, username: 'alpha', client_id: String(client), client_type: 'owner',
  vehicle_owner_id: null, type, amount: String(amount), date: '2026-06-10', applied_at: null,
  created_at: '2026-06-10 08:10:00', deleted_at: null, is_reversed: 0, ...extra });
function php(owners, ledger) {
  const run = spawnSync(process.env.PHP_BIN || 'php', [fixture], { encoding: 'utf8', input: JSON.stringify({ owners, ledger }), maxBuffer: 12 * 1024 * 1024 });
  if (run.error) throw run.error;
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const data = JSON.parse(run.stdout);
  if (data.error) throw new Error(data.error);
  return data;
}
const summaryPath = '/api/entities/vehicleOwners/list-summary.php';
const ledgerPath = '/api/entities/vehicle-ledger/list.php';
const countPath = '/api/stats/client-karta-counts.php';
const ok = data => Response.json({ success: true, data });
const failed = () => Response.json({ success: false, message: 'simulated primary failure' }, { status: 500 });
function network(data, { primary = () => ok(data.summary), counter = () => ok({}) } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const { pathname, searchParams } = new URL(url, 'https://erp.test');
    assert.equal(opts.method, 'GET');
    calls.push({ path: pathname, opts });
    if (pathname === summaryPath) return primary();
    if (pathname === countPath) return counter();
    if (pathname === ledgerPath) {
      assert.equal(searchParams.get('client_type'), 'owner');
      assert.equal(searchParams.get('is_reversed'), 'false');
      return ok(data.ledger[searchParams.get('client_id')]);
    }
    return failed();
  };
  return calls;
}
async function reference(data) {
  // Original eligibility/projection, real unmodified getClientBalance, original stable comparator.
  const rows = await Promise.all(data.owners.filter(o => o.deleted_at === null && o.name && o.owner_type !== 'broker').map(async o => {
    const id = String(o.id);
    const { balance, last_transaction_date } = await FinancialService.getClientBalance(id, 'owner');
    return { id, type: 'owner', name: o.name, phone: o.phone || null, balance,
      last_activity: Math.max(0, last_transaction_date ? new Date(last_transaction_date).getTime() || 0 : 0) };
  }));
  return { rows, sorted: rows.slice().sort((a, b) => Number(b.balance < 0) - Number(a.balance < 0) || b.last_activity - a.last_activity) };
}

// Small DOM covering the actual table operations (including cell-only late updates).
function screen() {
  notifyReceiptStatusChanged();
  const total = { textContent: '' };
  const search = { value: '', dataset: {}, addEventListener(_, f) { this.listener = f; },
    input(value) { this.value = value; this.listener(); } };
  const body = { rows: [], get children() { return this.rows; },
    set innerHTML(s) {
      this.html = s;
      this.rows = [...s.matchAll(/<tr\b([^>]*)>([\s\S]*?)<\/tr>/g)].map(([, attrs, html]) => {
        const cells = [...html.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/g)].map(([, attr, innerHTML]) => ({
          dataset: { ownerKarta: attr.match(/data-owner-karta="(\d+)"/)?.[1] }, innerHTML,
          get textContent() { return this.innerHTML.replace(/<[^>]+>/g, '').trim(); },
        }));
        return { dataset: { clientName: attrs.match(/data-client-name="([^"]*)"/)?.[1] }, style: {}, cells,
          querySelectorAll: sel => sel === 'td' ? cells : [] };
      });
    },
    querySelectorAll(sel) { assert.equal(sel, '[data-owner-karta]'); return this.rows.flatMap(r => r.cells.filter(c => c.dataset.ownerKarta)); },
  };
  globalThis.document = {
    getElementById: id => ({ ownersTableBody: body, totalBalanceDisplay: total, ownerSearchInput: search })[id],
    querySelectorAll: sel => sel.endsWith('[data-client-name]') ? body.rows.filter(r => r.dataset.clientName !== undefined) : body.rows,
  };
  return { body, total, search, ids: () => body.rows.filter(r => r.cells.length === 5).map(r => r.cells[3].dataset.ownerKarta) };
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
test.afterEach(tick); // finish mock badge responses before installing an independent screen/network
const summary = (id, balance) => ({ id: String(id), name: `Owner ${id}`, phone: null, summary: { balance_cents: balance, activity: null } });

test('per-owner cent equivalence for every owner leg, both signs, unknowns, empty/net zero, and isolation', async () => {
  const owners = [], entries = [], expected = [];
  for (const [type, effect] of [['deposit', c => c], ['withdraw', c => -c], ['receipt_due', c => c],
    ['receipt_payment', c => -Math.abs(c)], ['OFFICE_DEPOSIT', c => c], ['OFFICE_WITHDRAW_AUTO', c => -Math.abs(c)],
    ['new_type', () => 0], ['DEPOSIT', () => 0], ['withdraw ', () => 0]]) {
    for (const c of [4711, -4711, 1, -1, 0]) {
      const id = owners.length + 1;
      owners.push(owner(id)); entries.push(entry(id, id, type, c)); expected.push([String(id), Money.toDecimal(effect(c))]);
    }
  }
  owners.push(owner(51, { name: '0' }), owner(52, { owner_type: 'BROKER', name: ' ' }), owner(53, { name: 'not eligible', owner_type: 'broker' }),
    owner(54, { name: '' }), owner(55, { deleted_at: '2026-01-01' }), owner(56, { username: 'beta' }));
  entries.push(entry(100, 52, 'deposit', 10025), entry(101, 52, 'withdraw', 10025),
    entry(102, 51, 'deposit', 300, { username: 'beta' }), entry(103, 51, 'withdraw', 25, { client_type: 'office' }),
    entry(104, 51, 'deposit', 99, { is_reversed: 1 }), entry(105, 51, 'withdraw', 99, { deleted_at: '2026-07-01' }),
    entry(106, '051', 'deposit', 99999), entry(107, 53, 'deposit', 999, { vehicle_owner_id: '51' }),
    entry(108, null, 'deposit', 900, { client_id: null, vehicle_owner_id: '51' }));
  expected.push(['51', 0], ['52', 0]);
  const data = php(owners, entries); network(data);
  const actual = await OwnerListRepository.getAll();
  assert.deepEqual(actual, (await reference(data)).rows);
  assert.deepEqual(new Map(actual.map(o => [o.id, o.balance])), new Map(expected));
  assert.equal(data.reads, 2);
  assert.ok(data.summary.every(o => Number.isSafeInteger(o.summary.balance_cents) && !Array.isArray(o.summary.activity)));
});

test('entire list has the legacy ID order: signs, activity, missing/zero dates, Cairo times, numeric ID ties, stable input ties', async () => {
  const owners = Array.from({ length: 12 }, (_, i) => owner(i + 1));
  owners[0].updated_at = '2099-12-31'; // must not become activity
  const entries = [entry(1, 1, 'withdraw', 50000, { date: '2026-06-01' }), entry(2, 2, 'withdraw', 1000, { date: '2026-06-02' }),
    entry(3, 3, 'deposit', 1), entry(4, 3, 'withdraw', 1, { date: '2026-06-30' }),
    entry(5, 4, 'deposit', 10, { applied_at: '2026-06-10 20:30:00' }),
    entry(6, 4, 'unknown', 55, { date: null, applied_at: '2026-06-10T18:45:00Z' }), // later in Cairo; returns raw timestamp, not just the day
    entry(7, 5, 'deposit', 5, { date: null, applied_at: '2026-06-10T17:30:00Z' }),
    entry(8, 6, 'deposit', 50, { applied_at: '2026-06-10 20:30:00' }),
    entry(9, 7, 'deposit', 10, { applied_at: '2026-06-10 01:00:00' }), // different time, same raw day as owner 6
    entry(99, 8, 'unknown', 20, { applied_at: '2026-06-10 10:00:00' }),
    entry(100, 8, 'unknown', 20, { date: null, created_at: '2026-06-10 10:00:00' }), // numeric ID wins, raw created_at
    entry(101, 9, 'unknown', 20, { date: '0000-00-00', applied_at: '2026-07-01T10:00:00Z' }),
    entry(102, 10, 'unknown', 30, { date: null, applied_at: 'n/a', created_at: '2026-07-01 16:00:00' }),
    entry(103, 11, 'deposit', 0, { date: null, applied_at: ' 2026-06-15 08:15:00 ' }),
    entry(104, 11, 'unknown', 0, { date: '2026-06-14' })]; // uncertain prefix cannot be discarded
  const data = php(owners, entries); network(data);
  const ref = await reference(data);
  assert.deepEqual(await OwnerListRepository.getAll(), ref.rows);
  const ui = screen(); await loadOwners();
  assert.deepEqual(ui.ids(), ref.sorted.map(o => o.id));
  assert.deepEqual(ui.ids().slice(0, 3), ['2', '1', '3']);
  assert.ok(ui.ids().indexOf('4') < ui.ids().indexOf('5'));
  assert.ok(ui.ids().indexOf('8') < ui.ids().indexOf('6'));
  assert.deepEqual(ui.ids().filter(id => ['6', '7'].includes(id)), ref.rows.filter(o => ['6', '7'].includes(o.id)).map(o => o.id));
});

test('large BIGINT and cumulative totals retain authoritative rounding and ordered two-accumulator results', async () => {
  const big = '9007199254740992';
  const entries = [entry(1, 1, 'deposit', '-' + big, { date: '2026-06-01' }), entry(2, 1, 'deposit', 1, { date: '2026-06-02' }),
    entry(3, 1, 'deposit', big, { date: '2026-06-03' }), // ordered JS sum is 0, not the algebraic integer sum of 1
    entry(4, 2, 'withdraw', '-9223372036854775808'), entry(5, 2, 'receipt_payment', '7036874417766401'),
    entry(6, 2, 'receipt_due', '-7036874417766401'), entry(7, 2, 'OFFICE_WITHDRAW_AUTO', '-9223372036854775808'),
    entry(8, 2, 'unknown', 1), entry(9, 2, 'OFFICE_DEPOSIT', '9007199254740993'),
    entry(10, 3, 'deposit', '999999999999999'), entry(11, 3, 'withdraw', '-1'),
    entry(12, 4, 'receipt_due', '999999999999999'), entry(13, 4, 'receipt_payment', 2)];
  const data = php([1, 2, 3, 4].map(id => owner(id)), entries); network(data);
  const actual = await OwnerListRepository.getAll(); assert.deepEqual(actual, (await reference(data)).rows);
  assert.equal(actual.find(o => o.id === '1').balance, 0);
  const wire = id => data.summary.find(o => o.id === String(id)).summary;
  assert.ok(wire(1).precision_entries && wire(2).precision_entries && wire(4).precision_entries);
  assert.equal(wire(3).balance_cents, 1000000000000000);
});

test('late precision replay is batched across owners and retains the complete chronological input', async () => {
  const owners = Array.from({ length: 513 }, (_, i) => owner(i + 1));
  const ledger = owners.flatMap(({ id }) => [entry(id * 2, id, 'deposit', '999999999999999'), entry(id * 2 + 1, id, 'withdraw', 2)]);
  const data = php(owners, ledger); network(data);
  assert.equal(data.reads, 4); // owner read + one stream + two precision batches, not 513 extra SELECTs
  assert.ok(data.summary.every(o => o.summary.precision_entries.length === 2));
  assert.deepEqual(await OwnerListRepository.getAll(), (await reference(data)).rows);
});

test('mixed histories: exact per-owner snapshots and whole-list order against the authoritative reader', async () => {
  let seed = 4132;
  const random = n => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return Math.floor(seed / 2 ** 32 * n); };
  const owners = Array.from({ length: 32 }, (_, i) => owner(i + 1));
  const types = ['deposit', 'withdraw', 'receipt_due', 'receipt_payment', 'OFFICE_DEPOSIT', 'OFFICE_WITHDRAW_AUTO', 'other'];
  const ledger = Array.from({ length: 1536 }, (_, i) => {
    const id = 1 + random(32), day = `2026-05-${String(1 + random(28)).padStart(2, '0')}`;
    return entry(i + 1, id, types[random(types.length)], random(200001) - 100000, {
      client_id: random(8) ? String(id) : String(id) + ' ', client_type: random(4) ? 'owner' : 'OWNER',
      date: [day, day, null, '0000-00-00'][random(4)], applied_at: [null, `${day}T21:15:28.031Z`,
        `${day}T22:49:20+02:00`, `${day} 11:02:00`, 'invalid'][random(5)], created_at: `${day} 15:10:00.999`,
      is_reversed: random(9) ? 0 : 1, deleted_at: random(13) ? null : day, username: random(7) ? 'alpha' : 'beta',
    });
  });
  const data = php(owners, ledger); network(data);
  const ref = await reference(data); assert.deepEqual(await OwnerListRepository.getAll(), ref.rows);
  const ui = screen(); await loadOwners(); assert.deepEqual(ui.ids(), ref.sorted.map(o => o.id));
});

test('invalid stored operands abort the PHP projection rather than returning zero', () => {
  for (const patch of [{ amount: null }, { amount: 'not-cents' }, { type: null }]) {
    assert.throws(() => php([owner(1)], [entry(1, 1, 'deposit', 0, patch)]), /Invalid owner ledger operand/);
  }
});

test('one primary GET for 0, 1 or 100 owners; no full ledger requests; options and constant DB read count', async () => {
  for (const n of [0, 1, 100]) {
    const owners = Array.from({ length: n }, (_, i) => owner(i + 1));
    const ledger = owners.flatMap((o, i) => Array.from({ length: 12 }, (_, j) => entry(1 + i * 12 + j, o.id, 'deposit', 1)));
    const data = php(owners, ledger); const calls = network(data); const ui = screen();
    await loadOwners({ passive: true });
    assert.deepEqual(calls.map(c => c.path), n ? [summaryPath, countPath] : [summaryPath]);
    assert.equal(calls[0].opts.headers['X-Background-Poll'], '1'); assert.equal(calls[0].opts.credentials, 'include');
    assert.equal(data.reads, n ? 2 : 1); assert.equal(ui.ids().length, n);
    for (const row of data.summary) {
      assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'phone', 'summary']);
      assert.deepEqual(row.summary, { balance_cents: 12, activity: '2026-06-10' });
    }
    if (n) assert.ok(ui.body.rows.every(r => r.cells[2].textContent === '0.12'));
    else assert.match(ui.body.html, /لا توجد أصحاب مركبات/);
    await tick();
  }
});

test('rows, balances, total and local search are ready while the existing counter is still pending', { timeout: 5000 }, async () => {
  const hold = deferred(); const ui = screen(); const data = { summary: [summary(1, 333), summary(2, -25)] };
  const calls = network(data, { counter: () => hold.promise });
  try {
    await loadOwners(); assert.deepEqual(ui.ids(), ['2', '1']); assert.equal(ui.total.textContent, '3.08');
    const before = ui.body.rows.slice(); ui.search.input(' oWneR 2 '); assert.equal(ui.total.textContent, '-0.25');
    hold.resolve(ok({ 'owner:2': 5 })); await tick();
    assert.equal(ui.body.rows[0], before[0]); assert.equal(ui.body.rows[1], before[1]);
    assert.equal(ui.body.rows[0].cells[3].textContent, '5'); assert.equal(ui.body.rows[1].style.display, 'none');
    assert.equal(ui.total.textContent, '-0.25'); assert.deepEqual(calls.map(c => c.path), [summaryPath, countPath]);
    await loadOwners(); assert.notEqual(ui.body.rows[1].style.display, 'none'); assert.equal(ui.total.textContent, '3.08');
    ui.search.input(''); assert.equal(ui.total.textContent, '3.08'); assert.equal(calls.length, 3);
  } finally { hold.resolve(ok({})); }
});

test('refresh with an active search keeps its text but restores all rows to the total and printout, as in HEAD', async t => {
  const ui = screen();
  globalThis.fetch = async () => ok({ logged_in: true, username: 'alpha', role: 'accountant' });
  await AuthModule.checkSession();
  const calls = network({ summary: [summary(1, 333), summary(2, -25)] });

  // Exercise the registered print button and capture the real printEngine document.
  let click, printDocument;
  document.body = { dataset: {}, appendChild() {} };
  document.addEventListener = (event, listener) => { if (event === 'click') click = listener; };
  document.createElement = tag => {
    assert.equal(tag, 'iframe');
    return { style: {}, contentDocument: { open() {}, write(html) { printDocument = html; }, close() {} } };
  };
  attachOwnersPageListeners();
  const printed = async () => {
    printDocument = null;
    // Only suppress the physical printing timer; selection and document.write are real.
    const timer = t.mock.method(globalThis, 'setTimeout', () => 0);
    try { await click({ target: { closest: s => s === '[data-action="print-owners"]' } }); }
    finally { timer.mock.restore(); }
    const tbody = printDocument.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];
    return [...tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
      [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(([, value]) => value));
  };
  const visible = () => ui.body.rows.filter(r => r.style.display !== 'none').map(r => r.cells[0].textContent);
  const negative = ['Owner 2', '—', '-0.25'], positive = ['Owner 1', '—', '3.33'];
  const query = ' oWneR 2 ';
  await loadOwners();
  ui.search.input(query);
  assert.deepEqual(visible(), ['Owner 2']); assert.equal(ui.total.textContent, '-0.25');
  assert.deepEqual(await printed(), [negative]);

  await loadOwners();
  assert.equal(ui.search.value, query); assert.deepEqual(visible(), ['Owner 2', 'Owner 1']);
  assert.equal(ui.total.textContent, '3.08'); assert.deepEqual(await printed(), [negative, positive]);
  ui.search.input(query); // Only the next input event reapplies the unchanged text.
  assert.deepEqual(visible(), ['Owner 2']); assert.equal(ui.total.textContent, '-0.25');
  assert.deepEqual(await printed(), [negative]);
  assert.equal(calls.filter(c => c.path === summaryPath).length, 2);
});

test('primary errors and incomplete financial responses never display a made-up balance or request badges', async () => {
  const ui = screen(); const valid = summary(1, 123);
  network({ summary: [valid] }); await loadOwners(); assert.equal(ui.total.textContent, '1.23');
  for (const response of [failed(), ok(null), ok([null]), ok([valid, { ...valid, summary: { activity: null } }]),
    ok([{ ...valid, summary: { balance_cents: null, activity: null } }]), ok([{ ...valid, summary: { balance_cents: 0 } }]),
    ok([{ ...valid, summary: { precision_entries: [] } }])]) {
    const calls = network({}, { primary: () => response });
    await assert.rejects(loadOwners(), /simulated primary failure|بيانات أرصدة أصحاب المركبات غير مكتملة/);
    ui.search.input('x'); assert.notEqual(ui.body.rows[0].style.display, 'none');
    assert.deepEqual(ui.ids(), []); assert.equal(ui.total.textContent, '—'); assert.match(ui.body.html, /تعذر تحميل/);
    assert.deepEqual(calls.map(c => c.path), [summaryPath]);
  }
});

test('only the newest overlapping load may publish rows or errors', async () => {
  for (const late of [ok([summary(1, -999)]), failed()]) {
    const ui = screen(); const old = deferred(); let n = 0;
    const calls = network({}, { primary: () => ++n === 1 ? old.promise : ok([summary(2, 205)]) });
    const a = loadOwners(); await loadOwners(); assert.deepEqual(ui.ids(), ['2']);
    old.resolve(late);
    if (late.ok) await a; else await assert.rejects(a, /simulated primary failure/);
    assert.deepEqual(ui.ids(), ['2']); assert.equal(ui.total.textContent, '2.05');
    assert.equal(calls.filter(c => c.path === countPath).length, 1);
  }
});

// Drive the registered import button, real Excel parser, createOwner and owners:changed
// listeners. Only the browser file picker/reader, alerts and HTTP transport are stand-ins.
async function importScreen(t, primary, counter = () => ok({})) {
  const ui = screen(), writes = [], alerts = [], notified = deferred();
  let changes = 0, click;
  t.mock.method(window, 'dispatchEvent', function (event) {
    if (event.type === 'owners:changed') ++changes;
    return EventTarget.prototype.dispatchEvent.call(this, event);
  });
  const calls = network({}, { primary: () => primary(changes), counter });
  const listFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const { pathname, searchParams } = new URL(url, 'https://erp.test');
    if (pathname === '/api/auth/session.php') return ok({ logged_in: true, username: 'alpha', role: 'accountant' });
    if (pathname === '/api/entities/vehicleOwners/list.php' && searchParams.get('name') === 'Owner 2') return ok([]);
    if (pathname === '/api/entities/vehicleOwners/create.php' && opts.method === 'POST') {
      writes.push(JSON.parse(opts.body).name);
      return ok(owner(2));
    }
    return listFetch(url, opts);
  };
  await AuthModule.checkSession();
  const { default: xl } = await import('../xlsx.full.min.js');
  window.XLSX = xl;
  const wb = xl.utils.book_new();
  xl.utils.book_append_sheet(wb, xl.utils.aoa_to_sheet([['اسم صاحب المركبة'], ['Owner 2']]), 'Owners');
  const file = new File([xl.write(wb, { type: 'buffer', bookType: 'xlsx' })], 'owners.xlsx');
  globalThis.FileReader = class {
    async readAsArrayBuffer(f) { this.onload({ target: { result: await f.arrayBuffer() } }); }
  };
  document.body = { dataset: {}, appendChild() {} };
  document.addEventListener = (event, listener) => { if (event === 'click') click = listener; };
  document.createElement = tag => {
    assert.equal(tag, 'input');
    return { files: [file], style: {}, remove() {}, addEventListener(event, fn) { this[event] = fn; }, click() { this.change(); } };
  };
  globalThis.alert = message => { alerts.push(message); notified.resolve(); };
  t.after(() => {
    delete window.XLSX; delete globalThis.FileReader; delete globalThis.alert;
  });
  attachOwnersPageListeners();
  return { ui, writes, alerts, calls, notified: notified.promise, get changes() { return changes; },
    importFile: () => click({ target: { closest: sel => sel === '[data-action="import-owners-excel"]' } }) };
}

test('Excel import: a late count of 5 cannot replace the fresh badge of 4', { timeout: 5000 }, async t => {
  const beforeWrite = deferred(), duringImport = deferred(), finalSummary = deferred(), fresh = deferred();
  const duringStarted = deferred(); let reads = 0;
  const rows = [summary(1, 123), summary(2, 0)];
  const h = await importScreen(t, async changes => {
    if (changes === 2) await finalSummary.promise;
    return ok(changes ? rows : rows.slice(0, 1));
  }, () => {
    if (++reads === 1) return beforeWrite.promise;
    if (reads === 2) { duringStarted.resolve(); return duringImport.promise; }
    return fresh.promise;
  });
  const badge = () => h.ui.body.rows.find(r => r.dataset.clientName === 'owner 1').cells[3].textContent;
  try {
    await loadOwners(); // first pending GET, orphaned by createOwner's invalidation
    await h.importFile(); await duringStarted.promise; await tick();
    assert.deepEqual(h.ui.ids(), ['1', '2']); assert.equal(h.ui.total.textContent, '1.23');
    assert.equal(badge(), '—', 'rows and balances do not wait for either counter');
    // On the broken path the final invalidation has already fired. Let both older
    // responses populate the cache before the final summary is allowed to render.
    duringImport.resolve(ok({ 'owner:1': 5 })); await tick();
    beforeWrite.resolve(ok({ 'owner:1': 5 })); await tick();
    finalSummary.resolve(); fresh.resolve(ok({ 'owner:1': 4 })); await h.notified; await tick();
    assert.equal(badge(), '4'); assert.equal(reads, 3);
    assert.equal(h.changes, 2); assert.deepEqual(h.writes, ['Owner 2']);
    assert.deepEqual(h.alerts, ['✅ تم إضافة 1 صاحب مركبة']);
    await loadOwners(); assert.equal(badge(), '4'); assert.equal(reads, 3, 'warm cache is fresh too');
  } finally {
    beforeWrite.resolve(ok({})); duringImport.resolve(ok({})); finalSummary.resolve(); fresh.resolve(ok({}));
  }
});

test('Excel import: a committed write and a failed list refresh are reported separately, once', { timeout: 5000 }, async t => {
  const h = await importScreen(t, failed);
  await h.importFile(); await h.notified; await tick();
  assert.deepEqual(h.writes, ['Owner 2']); assert.equal(h.alerts.length, 1);
  assert.match(h.alerts[0], /تم إضافة 1 صاحب مركبة/);
  assert.match(h.alerts[0], /تعذر تحديث.*simulated primary failure/);
  assert.equal(h.changes, 1, 'only the event for the successful create, no success-only final event');
  assert.equal(h.ui.total.textContent, '—'); assert.match(h.ui.body.html, /تعذر تحميل أرصدة أصحاب المركبات/);
  assert.ok(h.calls.every(c => c.path === summaryPath), 'no badges on a failed primary read');
  await assert.rejects(loadOwners(), /simulated primary failure/);
});

test('empty owners list: non-empty search hides the placeholder and clearing it restores it', async () => {
  const ui = screen(); const calls = network({ summary: [] }); await loadOwners();
  const row = ui.body.rows[0]; assert.match(row.cells[0].textContent, /لا توجد أصحاب مركبات/);
  ui.search.input('  Owner 2 '); assert.equal(row.style.display, 'none'); assert.equal(ui.total.textContent, '0.00');
  ui.search.input('  '); assert.equal(row.style.display, ''); assert.equal(ui.total.textContent, '0.00');
  assert.deepEqual(calls.map(c => c.path), [summaryPath]);
});
