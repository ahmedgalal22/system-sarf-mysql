import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as drain } from 'node:timers/promises';
import { bootApp, change, observe, receipt } from './fixtures/all_forms_boot.mjs';

test('recovery preserves passive changes; later background errors report once and settle only the required visit', async t => {
  const { nodes, reads } = await bootApp(t, 'allReceipts');
  const { STATE } = await import('../allReceipts.js');
  const log = t.mock.method(console, 'error', () => {});
  const errors = () => log.mock.calls.map(c => c.arguments[1].message);
  const unhandled = t.mock.fn();
  process.on('unhandledRejection', unhandled);
  t.after(() => process.off('unhandledRejection', unhandled));

  // This time the *only* invalidation arrives AFTER the first failure,
  // without leaving the visible page. A retry with nothing pending would be active.
  reads[0].fail('initial list');
  await drain();
  assert.equal(STATE.ready, false);
  assert.equal(nodes.allReceiptsPage.classList.contains('hidden'), false);
  change('receipts:changed', true);
  await drain();
  assert.equal(reads.length, 1);
  const retry = window.showPage('allReceipts');
  await drain();
  assert.equal(reads.length, 2);
  assert.equal(reads[1].passive, true);
  reads[1].reply([receipt(1)]);
  await retry;
  assert.deepEqual(errors(), ['initial list']);

  change('receipts:changed', true);
  await drain();
  assert.equal(reads.length, 3);
  const departed = observe(window.showPage('allReceipts'));
  await window.showPage('receipt');
  change('treasury:changed', true);
  const current = window.showPage('allReceipts');
  const returning = observe(current);
  await drain();
  assert.equal(departed.status, 'fulfilled', 'the old visit did not wait for the next visit');
  assert.equal(returning.status, 'pending');
  assert.equal(reads.length, 3);
  reads[2].fail('obsolete background list');
  await drain();
  assert.equal(returning.status, 'pending', 'the failed revision was not the one needed on return');
  assert.deepEqual(STATE.receipts.map(r => r.id), [1]);
  assert.deepEqual(errors(), ['initial list', 'obsolete background list']);
  assert.equal(reads.length, 4);
  reads[3].reply([receipt(3)]);
  await current;
  assert.deepEqual(STATE.receipts.map(r => r.id), [3]);

  change('offices:changed', true);
  await drain();
  const joined = window.showPage('allReceipts');
  assert.equal(reads.length, 5);
  reads[4].fail('current background list');
  await assert.rejects(joined, /current background list/);
  await drain();
  assert.deepEqual(errors(), ['initial list', 'obsolete background list', 'current background list']);
  assert.equal(STATE.ready, false);
  assert.equal(reads.length, 5);

  change('receipts:changed', true); // a later refresh failure must not re-arm the first-load gate
  await drain();
  assert.equal(reads.length, 6);
  await window.showPage('homePage'); // nobody is awaiting this Forms refresh
  reads[5].fail('background list while away');
  await drain();
  assert.equal(nodes.homePage.classList.contains('hidden'), false);
  assert.deepEqual(STATE.receipts.map(r => r.id), [3]);
  assert.equal(reads.length, 6, 'no hidden follow-up');
  assert.equal(unhandled.mock.callCount(), 0);
  assert.deepEqual(errors(), ['initial list', 'obsolete background list', 'current background list', 'background list while away']);
});
