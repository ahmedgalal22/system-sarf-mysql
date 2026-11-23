import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncService } from '../services/syncService.js';
import { bootApp } from './fixtures/all_forms_boot.mjs';

test('restoring Forms does not suppress genuine shell setup failures', async t => {
  const fault = new Error('unable to bind Forms controls');
  const log = t.mock.method(console, 'error', () => {});
  const { nodes, reads } = await bootApp(t, 'allReceipts', {
    beforeBoot({ allReceiptsPage }) {
      t.mock.method(allReceiptsPage, 'addEventListener', () => { throw fault; });
    },
  });
  assert.deepEqual(log.mock.calls.filter(c => c.arguments[0] === '[app] Boot failed:').map(c => c.arguments[1]), [fault]);
  assert.match(nodes.app.innerHTML, /unable to bind Forms controls/);
  assert.equal(document.getElementById('allReceiptsPage'), null, 'fatal boot replacement detaches the page in this DOM');
  assert.equal(document.getElementById('sidebar'), nodes.sidebar, 'the sidebar alone cannot restore a detached page');
  assert.equal(reads.length, 0);
  assert.equal(SyncService.isRunning(), false);
});
