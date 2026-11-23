import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as drain } from 'node:timers/promises';
import { bootApp, fireControl, listPath } from './fixtures/all_forms_boot.mjs';

test('saved editor route stays cold; a failed first sidebar entry reports the error and retries only on demand', async t => {
  const { nodes, reads, storage } = await bootApp(t, 'receipt');
  const { STATE, initAllReceiptsPage } = await import('../allReceipts.js');
  assert.equal(storage.get('karta_v2_last_page'), 'receipt');
  assert.equal(nodes.receiptPage.classList.contains('hidden'), false);
  await initAllReceiptsPage(); // even a premature call must not mount or load a hidden page
  assert.equal(nodes.allReceiptsPage.dataset.initialized, undefined);
  assert.equal(reads.length, 0);

  const log = t.mock.method(console, 'error', () => {});
  fireControl(nodes.sidebar, 'click', '[data-page]', { dataset: { page: 'allReceipts' } });
  await drain();
  assert.deepEqual(reads.map(r => r.path), [listPath]);
  const caller = assert.rejects(initAllReceiptsPage(), /first list unavailable/);
  reads[0].fail('first list unavailable');
  await caller;
  await drain(); // cross the unhandled-rejection checkpoint; DOM dispatch did not await navigation
  assert.equal(log.mock.callCount(), 1);
  assert.equal(log.mock.calls[0].arguments[1].message, 'first list unavailable');
  assert.equal(STATE.loading, false);
  assert.equal(STATE.ready, false);
  t.mock.timers.tick(1000);
  await drain();
  assert.equal(reads.length, 1, 'failure alone does not spin up another read');

  await window.showPage('receipt');
  const retry = window.showPage('allReceipts'); // no change event needed to retry the failed first read
  await drain();
  assert.deepEqual(reads.map(r => r.path), [listPath, listPath]);
  assert.equal(reads[1].passive, false);
  reads[1].reply([]);
  await retry;
  assert.equal(STATE.ready, true, 'an empty result is a successfully loaded view');
  assert.deepEqual(STATE.receipts, []);
  await window.showPage('receipt');
  await window.showPage('allReceipts');
  assert.equal(reads.length, 2);
});
