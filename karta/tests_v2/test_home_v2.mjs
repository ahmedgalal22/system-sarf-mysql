import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as drain } from 'node:timers/promises';
import { AuthModule } from '../auth.js';
import { ClientRepository } from '../services/clientRepository.js';
import { OfficeRepository } from '../services/officeRepository.js';
import { ReceiptRepository } from '../services/receiptRepository.js';
import { SyncService } from '../services/syncService.js';

const welcome = 'مرحباً بك في نظام Karta';

for (const username of [null, 'fixture']) {
  test(`Home ${username ? 'with' : 'without'} a cached username renders and navigates without cards or data reads`, async t => {
    const home = { innerHTML: '' }, clicks = [];
    globalThis.document = { getElementById: id => id === 'homePage' ? home : null,
      addEventListener(type, listener) { if (type === 'click') clicks.push(listener); } };
    globalThis.window = { showPage: t.mock.fn() };
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({
      success: true, data: { logged_in: !!username, username },
    }));
    assert.equal((await AuthModule.checkSession())?.username ?? null, username);
    fetch.mock.mockImplementation(async () => Response.json({ success: false }, { status: 503 }));
    fetch.mock.resetCalls(); // only count activity attributable to Home
    const offline = async () => { throw new Error('Data service unavailable'); };
    const reads = [fetch,
      t.mock.method(ClientRepository, 'getAllOwners', offline),
      t.mock.method(OfficeRepository, 'getAll', offline),
      t.mock.method(ReceiptRepository, 'getAll', offline),
    ];
    // A separate Home instance for this document (the integration test boots its own).
    const { initHomePage } = await import(`../home.js?standalone=${username ?? 'anonymous'}`);
    initHomePage();
    initHomePage();
    const html = home.innerHTML;
    for (const text of [welcome, 'نظام شامل لإدارة الكارتات وأصحاب المركبات والمكاتب', 'مميزات النظام',
      'إدارة شاملة لأصحاب المركبات والمكاتب', 'نموذج صرف احترافي مع حسابات تلقائية', 'تتبع المديونيات والمدفوعات',
      'طباعة احترافية لجميع التقارير', 'حفظ تلقائي للبيانات', 'متوافق مع جميع الأجهزة', 'البدء السريع',
      'أضف أصحاب المركبات', 'أضف المكاتب', 'أنشئ نماذج الصرف']) {
      assert.ok(html.includes(text), text);
    }
    // Owner/office words still belong in the intro and links; check standalone card labels.
    assert.doesNotMatch(html, />\s*(أصحاب المركبات|المكاتب|إجمالي الكارتات|قيد الانتظار)\s*</);
    assert.doesNotMatch(html, /grid-template-columns:\s*repeat\(4,/);
    const pages = [...html.matchAll(/<div\b[^>]*\bdata-action="home-navigate"[^>]*>/g)]
      .map(([tag]) => tag.match(/\bdata-page="([^"]+)"/)?.[1]);
    assert.deepEqual(pages, ['ownersPage', 'officesPage', 'receipt']);
    assert.equal(clicks.length, 1, 're-entry must not double-bind navigation');
    for (const page of pages) {
      clicks[0]({ target: { closest: s => s === '[data-action="home-navigate"]' ? { dataset: { page } } : null } });
    }
    assert.deepEqual(window.showPage.mock.calls.map(c => c.arguments), pages.map(page => [page]));
    await drain();
    for (const read of reads) assert.equal(read.mock.callCount(), 0);
  });
}

test('Home boot leaves All Forms cold until entry; hidden changes refresh once on return', async t => {
  const { bootApp, change, listPath, receipt } = await import('./fixtures/all_forms_boot.mjs');
  const { nodes, storage, reads, requests } = await bootApp(t);
  const forms = nodes.allReceiptsPage;
  const changeTypes = ['receipts:changed', 'offices:changed', 'treasury:changed'];
  const editorLists = requests().filter(path => /\/entities\/(vehicleOwners|offices|drivers|receipts)\//.test(path));
  assert.deepEqual(editorLists, ['/api/entities/vehicleOwners/list.php', '/api/entities/offices/list.php?username=fixture',
    '/api/entities/drivers/list.php?by_username=fixture']);
  assert.ok(requests().includes('/api/entities/treasury/list.php?username=fixture'));
  assert.equal(SyncService.isRunning(), true, 'boot completed without releasing any receipt response');
  assert.equal(storage.get('karta_v2_last_page'), 'homePage');
  assert.equal(nodes.homePage.classList.contains('hidden'), false);
  assert.ok(nodes.homePage.innerHTML.includes(welcome));
  assert.equal(forms.classList.contains('hidden'), true);
  assert.equal(forms.dataset.initialized, undefined);
  assert.equal(reads.length, 0);

  for (const type of changeTypes) change(type, true);
  t.mock.timers.tick(4000); // the editor's delayed number lookup and a normal sync tick still run
  await drain();
  assert.ok(requests().includes('/api/financial/receipt-peek.php'));
  assert.equal(forms.dataset.initialized, undefined, 'events must not mount a cold page');
  assert.equal(forms.innerHTML, '');
  assert.equal(reads.length, 0);

  const binds = t.mock.method(forms, 'addEventListener');
  const windowBinds = t.mock.method(window, 'addEventListener');
  const entry = window.showPage('allReceipts');
  let repeatDone = false;
  const repeat = window.showPage('allReceiptsPage').then(() => { repeatDone = true; });
  await drain();
  assert.equal(repeatDone, false, 'both entries await the first read');
  assert.equal(forms.classList.contains('hidden'), false);
  assert.equal(forms.dataset.initialized, '1');
  assert.deepEqual(reads.map(r => r.path), [listPath], 'one unbounded first read, not one per event or click');
  assert.equal(reads[0].passive, false);
  reads[0].reply([receipt(17)]);
  await Promise.all([entry, repeat]);
  assert.match(nodes.receiptsList.innerHTML, /data-kind="receipt" data-id="17"/);

  const before = requests().length;
  await window.showPage('homePage');
  assert.equal(nodes.homePage.classList.contains('hidden'), false);
  await window.showPage('allReceipts');
  await drain();
  assert.deepEqual(requests().slice(before), [], 'clean re-entry is read-free');
  await window.showPage('treasuryPage');
  await drain();
  assert.equal(nodes.treasuryPage.classList.contains('hidden'), false);
  assert.equal(nodes.homePage.classList.contains('hidden'), true);
  assert.deepEqual(requests().slice(before), ['/api/entities/treasury/list.php?username=fixture'],
    'Treasury still loads its own list; its hidden Home render adds nothing');

  // Distinct turns, not just a synchronous event burst. Other pages are free to refresh.
  for (const type of changeTypes) {
    change(type, type !== 'offices:changed');
    await drain();
    assert.equal(reads.length, 1, type);
  }
  const reopen = window.showPage('allReceipts');
  await drain();
  assert.deepEqual(reads.map(r => r.path), [listPath, listPath]);
  assert.equal(reads[1].passive, false, 'active change in a hidden batch takes priority');
  reads[1].reply([receipt(18)]);
  await reopen;
  assert.match(nodes.receiptsList.innerHTML, /data-kind="receipt" data-id="18"/);

  for (const [i, type] of changeTypes.entries()) {
    change(type, true);
    await drain();
    assert.equal(reads.length, 3 + i, type);
    assert.equal(reads.at(-1).passive, true);
    reads.at(-1).reply([receipt(20 + i)]);
    await drain();
    assert.ok(nodes.receiptsList.innerHTML.includes(`data-kind="receipt" data-id="${20 + i}"`));
  }
  const types = spy => spy.mock.calls.map(call => call.arguments[0]);
  assert.deepEqual(types(binds), ['click', 'input', 'change'], 'one set of page handlers across all visits');
  assert.deepEqual(types(windowBinds).filter(type => changeTypes.includes(type)), changeTypes, 'one listener per domain');
});
