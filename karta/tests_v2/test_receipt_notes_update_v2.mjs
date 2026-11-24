import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { addEventListener() {}, dispatchEvent() {}, location: {} };
globalThis.document = { addEventListener() {}, getElementById() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; } };
globalThis.CustomEvent = class { constructor(type) { this.type = type; } };

const { ReceiptsModule } = await import('../receipts.js');
const { DBProvider } = await import('../services/dbProvider.js');

const rawReceipt = () => ({
  receipt_date: '2026-11-01', receipt_number: '123',
  client_id: 'owner-1', client_type: 'owner', client_name: 'Test client',
  rows: [{ _type: 'data', row_id: 'row-1', owner_id: 'owner-1',
    vehicle_id: 'vehicle-1', vehicle_plate: 'TEST', kartano: 'changed', data: 'New driver',
    weight: 10, noloon: 5 }],
});

// The simulated endpoint applies only keys present in the JSON patch, as the
// real endpoint and repository do. No database or network is used.
async function updateWithNote(existingNote, noteInput = {}) {
  let saved = { id: 42, username: 'test', notes: existingNote, updated_at: 'version-1' };
  let request;
  const originalGet = DBProvider.get;
  const originalFetch = globalThis.fetch;
  DBProvider.get = async () => ({ ...saved });
  globalThis.fetch = async (url, options) => {
    assert.match(String(url), /financial\/receipt-update\.php$/);
    request = JSON.parse(options.body);
    saved = { ...saved, ...request };
    const body = { success: true, data: { receipt: saved, synced_hamola: [] } };
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  try {
    await ReceiptsModule.update('test', 42, { ...rawReceipt(), ...noteInput });
    return { saved, request };
  } finally {
    DBProvider.get = originalGet;
    globalThis.fetch = originalFetch;
  }
}

test('unrelated edit omits an uncollected note and preserves the saved value', async () => {
  const { saved, request } = await updateWithNote('Existing general note');
  assert.equal(Object.hasOwn(request, 'notes'), false);
  assert.equal(request.rows[0].kartano, 'changed');
  assert.equal(request.rows[0].data, 'New driver');
  assert.equal(saved.notes, 'Existing general note');
});

test('explicit note change is normalized and sent', async () => {
  const { saved, request } = await updateWithNote('Old note', { notes: '  New   note  ' });
  assert.equal(request.notes, 'New note');
  assert.equal(saved.notes, 'New note');
});

test('explicit null or empty note clears an existing note', async () => {
  for (const notes of [null, '', '   ']) {
    const { saved, request } = await updateWithNote('Old note', { notes });
    assert.equal(Object.hasOwn(request, 'notes'), true);
    assert.equal(request.notes, null);
    assert.equal(saved.notes, null);
  }
});

test('unrelated edits retain an absent or null note', async () => {
  for (const existingNote of [null, undefined]) {
    const { saved, request } = await updateWithNote(existingNote);
    assert.equal(Object.hasOwn(request, 'notes'), false);
    assert.equal(saved.notes, existingNote);
  }
});
