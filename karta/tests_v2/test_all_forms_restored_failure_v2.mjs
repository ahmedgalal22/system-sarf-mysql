import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as drain } from 'node:timers/promises';
import { SyncService } from '../services/syncService.js';
import { bootApp, change, fireControl, listPath, receipt } from './fixtures/all_forms_boot.mjs';

test('a restored Forms failure is local to the view; only explicit entry retries it', async t => {
  const { nodes, reads, requests, intervals, sidebarBinds } = await bootApp(t, 'allReceiptsPage');
  const log = t.mock.method(console, 'error', () => {}); // first response still held; exclude Node's MockTimers warning
  const { STATE } = await import('../allReceipts.js');
  const click = page => fireControl(document.getElementById('sidebar'), 'click', '[data-page]', { dataset: { page } });
  const errors = () => log.mock.calls.map(c => c.arguments[1]?.message);
  function checkShell() {
    assert.equal(document.getElementById('sidebar'), nodes.sidebar);
    for (const id of ['homePage', 'receiptPage', 'allReceiptsPage', 'treasuryPage']) {
      assert.equal(document.getElementById(id), nodes[id], id);
      assert.ok(nodes.app.contains(nodes[id]), id);
    }
    assert.doesNotMatch(nodes.app.innerHTML, /فشل تحميل التطبيق/);
    assert.equal(sidebarBinds.mock.calls.filter(c => c.arguments[0] === 'click').length, 1);
    assert.equal(SyncService.isRunning(), true);
    assert.equal(intervals.mock.calls.filter(c => c.arguments[1] === 4000).length, 1);
  }
  checkShell(); // while the first response is still held
  assert.equal(requests().filter(p => p.endsWith('/sync/versions.php')).length, 1, 'one seed poll');
  assert.deepEqual(reads.map(r => r.path), [listPath]);
  change('treasury:changed', true);
  reads[0].fail('restored list unavailable');
  await drain();
  assert.deepEqual(errors(), ['restored list unavailable']);
  assert.equal(STATE.ready, false);
  assert.equal(STATE.loading, false);
  const error = document.getElementById('receiptsFirstLoadError');
  assert.ok(error.classList.contains('is-visible'), 'a failed list is not presented as a successful empty list');
  assert.equal(reads.length, 1, 'in-flight event must not retry a failed first load');
  checkShell();

  // No second event yet: the passive header on the retry below can only come
  // from the invalidation during the failed read, not from a later poll/click.
  t.mock.timers.tick(4000);
  await drain();
  assert.equal(reads.length, 1, 'still waiting for explicit entry');
  click('homePage');
  assert.equal(nodes.homePage.classList.contains('hidden'), false);
  click('allReceipts');
  const retry = window.showPage('allReceiptsPage'); // shares the sidebar retry
  await drain();
  assert.equal(reads.length, 2);
  assert.equal(reads[1].passive, true, 'serve the invalidation from the failed first read');
  assert.equal(error.classList.contains('is-visible'), false, 'retry clears the previous error');
  reads[1].fail('explicit retry unavailable');
  await assert.rejects(retry, /explicit retry unavailable/);
  await drain();
  assert.deepEqual(errors(), ['restored list unavailable', 'explicit retry unavailable']);
  assert.equal(STATE.ready, false);
  assert.ok(error.classList.contains('is-visible'));
  checkShell();

  assert.equal(nodes.allReceiptsPage.classList.contains('hidden'), false);
  change('offices:changed'); // upgrade the pending passive revision after failure
  t.mock.timers.tick(4000);
  await drain();
  assert.equal(reads.length, 2, 'a new event on the failed, visible page did not dispatch');
  click('receipt');
  assert.equal(nodes.receiptPage.classList.contains('hidden'), false);
  const recovery = window.showPage('allReceipts');
  await drain();
  assert.deepEqual(reads.map(r => r.path), [listPath, listPath, listPath]);
  assert.equal(reads[2].passive, false, 'active post-failure invalidation survived');
  reads[2].reply([receipt(51)]);
  await recovery;
  assert.equal(STATE.ready, true);
  assert.equal(error.classList.contains('is-visible'), false);
  assert.match(nodes.receiptsList.innerHTML, /data-id="51"/);
  change('receipts:changed', true);
  await drain();
  assert.equal(reads.length, 4, 'automatic refresh resumed after first publication');
  assert.equal(reads[3].passive, true);
  reads[3].reply([receipt(52)]);
  await drain();
  assert.match(nodes.receiptsList.innerHTML, /data-id="52"/);
  checkShell();
});
