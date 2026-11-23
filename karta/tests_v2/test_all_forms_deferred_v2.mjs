import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as drain } from 'node:timers/promises';
import { SyncService } from '../services/syncService.js';
import { bootApp, change, fireControl, listPath, observe, receipt } from './fixtures/all_forms_boot.mjs';

test('saved All Forms route reads on entry; queued and in-flight refreshes respect leaving the page', async t => {
  const { nodes, reads, storage } = await bootApp(t, 'allReceipts');
  const forms = nodes.allReceiptsPage;
  const { STATE } = await import('../allReceipts.js');
  assert.equal(forms.classList.contains('hidden'), false);
  assert.match(forms.innerHTML, /id="receiptsList"/);
  assert.equal(nodes.homePage.innerHTML, '');
  assert.equal(STATE.loading, true);
  assert.deepEqual(reads.map(r => r.path), [listPath]);
  assert.equal(SyncService.isRunning(), true, 'restoring Forms data does not block shell startup');
  fireControl(nodes.sidebar, 'click', '[data-page]', { dataset: { page: 'receipt' } });
  assert.equal(nodes.receiptPage.classList.contains('hidden'), false, 'sidebar works during the restored read');
  const sameRead = window.showPage('allReceiptsPage');
  const sameVisit = observe(sameRead);
  await drain();
  assert.equal(sameVisit.status, 'pending');
  assert.equal(reads.length, 1, 'return joins the still-valid first read');
  const history = Array.from({ length: 205 }, (_, i) => receipt(i + 1));
  reads[0].reply(history);
  await sameRead;
  await drain();
  assert.equal(storage.get('karta_v2_last_page'), 'allReceipts');
  assert.equal(SyncService.isRunning(), true);
  assert.equal(STATE.ready, true);
  assert.equal(STATE.receipts.length, history.length, 'all history is loaded, not just the first screen of cards');
  const cards = () => (nodes.receiptsList.innerHTML.match(/data-kind="receipt"/g) || []).length;
  assert.equal(cards(), 50);
  fireControl(forms, 'change', 'select[data-action="page-size"]', { value: '100' });
  assert.equal(cards(), 100, 'display size still operates on the loaded history');
  await window.showPage('homePage');
  change('owners:changed', true); // editor lookup, not a receipt invalidation
  await window.showPage('allReceiptsPage');
  await drain();
  assert.equal(cards(), 100);
  assert.equal(STATE.filters.receipts.pageSize, 100);
  assert.equal(reads.length, 1, 'a clean return retains the display and does not re-read');

  // The change queues a microtask while visible; the router hides Forms before dispatch.
  change('treasury:changed', true);
  const departed = observe(window.showPage('allReceipts'));
  await window.showPage('homePage');
  await drain();
  assert.equal(departed.status, 'fulfilled', 'departure releases the visit without any hidden dispatch');
  assert.equal(reads.length, 1);
  const visit = window.showPage('allReceipts');
  await drain();
  assert.equal(reads.length, 2);
  assert.equal(reads[1].passive, true);
  await window.showPage('homePage');
  change('receipts:changed');
  change('offices:changed', true);
  reads[1].reply([receipt(100)]);
  await visit;
  await drain();
  assert.equal(STATE.receipts.length, history.length, 'the superseded response was not published');
  assert.equal(reads.length, 2, 'loader finally did not dispatch a hidden trailing read');

  const retry = window.showPage('allReceipts');
  await drain();
  assert.deepEqual(reads.map(r => r.path), [listPath, listPath, listPath]);
  assert.equal(reads[2].passive, false);
  reads[2].reply([receipt(101)]);
  await retry;
  assert.deepEqual(STATE.receipts.map(r => r.id), [101]);
  assert.match(nodes.receiptsList.innerHTML, /data-kind="receipt" data-id="101"/);

  // A date debounce armed while visible and the legacy explicit refresh entry
  // point must not start a hidden read. Re-entry uses the actual current range.
  fireControl(forms, 'input', '[data-filter-tab][data-filter-key]', {
    dataset: { filterTab: 'receipts', filterKey: 'from' }, value: '1998-12-01',
  });
  await window.showPage('receipt');
  t.mock.timers.tick(401);
  await drain();
  assert.equal(reads.length, 3);
  const explicit = window.refreshAllReceiptsPage();
  await drain();
  assert.equal(reads.length, 3);
  await explicit;
  const ranged = window.showPage('allReceipts');
  await drain();
  assert.equal(reads.length, 4);
  assert.equal(reads[3].path, listPath + '?from_date=1998-12-01');
  // This time return *before* the obsolete read settles. No overlap, and the
  // visible loader now drains exactly one newer revision with the same range.
  await window.showPage('homePage');
  change('receipts:changed', true);
  const earlyReturn = window.showPage('allReceipts');
  const returning = observe(earlyReturn);
  await drain();
  assert.equal(returning.status, 'pending');
  assert.equal(reads.length, 4);
  reads[3].reply([receipt(102)]);
  await ranged;
  await drain();
  assert.deepEqual(STATE.receipts.map(r => r.id), [101]);
  assert.equal(reads.length, 5);
  assert.equal(reads[4].path, reads[3].path);
  assert.equal(reads[4].passive, true);
  assert.equal(returning.status, 'pending', 'the obsolete response did not satisfy the return visit');
  reads[4].reply([receipt(103)]);
  await earlyReturn;
  await drain();
  assert.equal(STATE.filters.receipts.pageSize, 100);
  assert.deepEqual(STATE.receipts.map(r => r.id), [103]);
  assert.equal(reads.length, 5);
});
