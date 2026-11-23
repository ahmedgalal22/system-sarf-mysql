import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as drain } from 'node:timers/promises';
import { bootApp, change, observe, receipt } from './fixtures/all_forms_boot.mjs';

test('neither an obsolete list nor obsolete search metadata can settle a visible entry', async t => {
  const { nodes, reads } = await bootApp(t);
  const { STATE } = await import('../allReceipts.js');
  const entry = window.showPage('allReceipts');
  // Supply a bounded receipt-level selection; the real dispatcher must now use search.
  Object.assign(STATE.filters.receipts, { from: '1999-01-01', to: '1999-01-31', number: ['2'] });
  change('offices:changed', true);
  const repeated = window.showPage('allReceiptsPage');
  const visits = [observe(entry), observe(repeated)];
  assert.equal(reads.length, 1);
  reads[0].reply([receipt(1)]);
  await drain();
  assert.deepEqual(visits.map(v => v.status), ['pending', 'pending']);
  assert.equal(STATE.ready, false);
  assert.deepEqual(STATE.receipts, []);
  assert.equal(nodes.receiptsList.innerHTML, '');
  assert.equal(reads.length, 2);
  assert.match(reads[1].path, /^\/api\/entities\/receipts\/search\.php\?/);

  change('receipts:changed'); // also supersede the held search
  reads[1].reply([receipt(99)], { total: 99, options: { receipt_numbers: ['99'] } });
  await drain();
  assert.deepEqual(visits.map(v => v.status), ['pending', 'pending']);
  assert.deepEqual(STATE.receipts, []);
  assert.equal(STATE.meta, null);
  assert.equal(STATE.options, null);
  assert.equal(nodes.receiptsList.innerHTML, '');
  assert.equal(reads.length, 3);
  assert.equal(reads[2].path, reads[1].path);
  const currentMeta = { total: 1, options: { receipt_numbers: ['2'] } };
  reads[2].reply([receipt(2)], currentMeta);
  await Promise.all([entry, repeated]);
  assert.equal(STATE.ready, true);
  assert.deepEqual(STATE.meta, currentMeta);
  assert.deepEqual(STATE.receipts.map(r => r.id), [2]);
  assert.match(nodes.receiptsList.innerHTML, /data-id="2"/);
});
