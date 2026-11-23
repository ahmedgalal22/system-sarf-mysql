import assert from 'node:assert/strict';
import test from 'node:test';
import { SyncService } from '../services/syncService.js';
import { bootApp } from './fixtures/all_forms_boot.mjs';

test('a saved Forms route does not bypass the signed-out redirect', async t => {
  const { nodes, reads, sidebarBinds } = await bootApp(t, 'allReceipts', { session: { logged_in: false } });
  assert.equal(window.location.href, 'login.html');
  assert.equal(window.__APP_CONTEXT__, undefined);
  assert.equal(nodes.allReceiptsPage.dataset.initialized, undefined);
  assert.equal(reads.length, 0);
  assert.equal(sidebarBinds.mock.callCount(), 0);
  assert.equal(SyncService.isRunning(), false);
});
