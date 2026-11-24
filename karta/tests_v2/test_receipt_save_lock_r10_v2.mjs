import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Execute the actual save and validation functions in isolation with synthetic
// collaborators. This tests their control flow without a browser or database.
const source = readFileSync(new URL('../receipts.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from !== -1 && to !== -1, `Missing source section: ${start}`);
  return source.slice(from, to);
}
const validation = section('async function validateBeforeSave(rawData) {', '// ─── SAVE FLOW');
const save = section('async function saveReceipt() {', '// ─── PRINT');

function harness(mode = 'edit') {
  const calls = { collect: 0, all: 0, offices: 0, update: 0, create: 0, events: [], alerts: [], logs: [] };
  const behavior = {};
  let usernameCalls = 0;
  const row = { _type: 'data', kartano: 'K1', office: 'Office', loading: 'A', taktik: 'B', owner_id: 'owner', vehicle_id: 'vehicle', data: '' };
  const raw = () => ({ receipt_date: '2026-11-01', receipt_number: '123', client_id: 'owner', client_type: 'owner', rows: [{ ...row }] });
  const state = { isEditing: mode === 'edit', editingReceiptId: mode === 'edit' ? 42 : null };
  const context = vm.createContext({
    ReceiptState: state,
    collectRawData: async () => { calls.collect++; if (behavior.collect) throw new Error('collect failed'); return raw(); },
    ReceiptsModule: {
      getAll: async () => { calls.all++; if (behavior.wait) await behavior.wait; if (behavior.all) throw new Error('receipt read failed'); return []; },
      getOffices: async () => { calls.offices++; if (behavior.offices) throw new Error('office read failed'); return [{ name: 'Office' }]; },
      update: async () => { calls.update++; if (behavior.update) throw new Error('update failed'); },
      create: async () => { calls.create++; if (behavior.create) throw new Error('create failed'); },
    },
    OfficesService: { normalizeCargoKey: value => String(value || '').trim().toLowerCase() },
    _currentUsername: () => { usernameCalls++; if (behavior.usernameAt === usernameCalls) throw new Error('session failed'); return 'test-user'; },
    _assertCriticalSaveInputs: () => { if (behavior.critical) throw new Error('critical failed'); },
    _vehicleAnalysisCache: { clear() {} },
    _exitEditMode() {},
    clearReceiptSilent() {},
    _uiSaveDriverName() {},
    window: { dispatchEvent: event => calls.events.push(event.type) },
    CustomEvent: class { constructor(type) { this.type = type; } },
    alert: message => calls.alerts.push(message),
    console: { error: (...args) => calls.logs.push(args) },
    setTimeout() {},
  });
  vm.runInContext(`let _isSaving = false;\n${validation}\n${save}`, context);
  return { calls, behavior, row, state, save: () => vm.runInContext('saveReceipt()', context), locked: () => vm.runInContext('_isSaving', context) };
}

for (const mode of ['edit', 'create']) {
  for (const failing of ['collect', 'all', 'offices']) {
    test(`${mode}: ${failing} failure releases lock and retry reaches save`, async () => {
      const h = harness(mode);
      h.behavior[failing] = true;
      await h.save();
      assert.equal(h.locked(), false);
      assert.equal(h.calls.alerts.length, 1);
      assert.match(h.calls.alerts[0], /failed/);
      assert.equal(h.calls.update + h.calls.create, 0);
      h.behavior[failing] = false;
      await h.save();
      assert.equal(h.locked(), false);
      assert.equal(mode === 'edit' ? h.calls.update : h.calls.create, 1);
      assert.equal(h.calls.alerts.length, 2);
      assert.ok(h.calls.alerts[1].includes('✅'));
      assert.deepEqual(h.calls.events, ['receipts:changed']);
    });
  }

  test(`${mode}: ordinary validation failure releases lock for retry`, async () => {
    const h = harness(mode);
    h.row.office = '';
    await h.save();
    assert.equal(h.locked(), false);
    assert.equal(h.calls.alerts.length, 1);
    assert.equal(h.calls.update + h.calls.create, 0);
    h.row.office = 'Office';
    await h.save();
    assert.equal(mode === 'edit' ? h.calls.update : h.calls.create, 1);
    assert.equal(h.locked(), false);
  });

  test(`${mode}: save rejection releases lock and a subsequent success completes`, async () => {
    const h = harness(mode);
    h.behavior[mode === 'edit' ? 'update' : 'create'] = true;
    await h.save();
    assert.equal(h.locked(), false);
    assert.equal(h.calls.alerts.length, 1);
    assert.match(h.calls.alerts[0], /failed/);
    assert.equal(h.calls.logs.length, mode === 'create' ? 1 : 0);
    h.behavior[mode === 'edit' ? 'update' : 'create'] = false;
    await h.save();
    assert.equal(mode === 'edit' ? h.calls.update : h.calls.create, 2);
    assert.equal(h.locked(), false);
    assert.ok(h.calls.alerts[1].includes('✅'));
    assert.deepEqual(h.calls.events, ['receipts:changed']);
  });
}

test('critical input assertion failure releases the lock', async () => {
  const h = harness();
  h.behavior.critical = true;
  await h.save();
  assert.equal(h.locked(), false);
  assert.equal(h.calls.alerts.length, 1);
  h.behavior.critical = false;
  await h.save();
  assert.equal(h.calls.update, 1);
});

test('an exception outside inner catches still releases the lock', async () => {
  const h = harness();
  h.behavior.usernameAt = 3; // after the two validation reads
  await assert.rejects(h.save(), /session failed/);
  assert.equal(h.locked(), false);
  await h.save();
  assert.equal(h.calls.update, 1);
});

test('the existing guard ignores a simultaneous save while validation is pending', async () => {
  const h = harness();
  let release;
  h.behavior.wait = new Promise(resolve => { release = resolve; });
  const first = h.save();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.locked(), true);
  await h.save();
  assert.equal(h.calls.collect, 1);
  release();
  await first;
  assert.equal(h.calls.update, 1);
  assert.equal(h.locked(), false);
});
