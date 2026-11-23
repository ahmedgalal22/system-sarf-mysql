import assert from 'node:assert/strict';
import { setImmediate as drain } from 'node:timers/promises';
import { SyncService } from '../../services/syncService.js';

function element(id) {
  const classes = new Set();
  const node = Object.assign(new EventTarget(), { id, dataset: {}, children: [],
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    appendChild(child) { this.children.push(child); },
    contains(child) { return this === child || this.children.some(n => n.contains(child)); },
    insertBefore() {}, querySelector: () => null, querySelectorAll: () => [] });
  let html = '';
  Object.defineProperty(node, 'innerHTML', { get: () => html, set(value) {
    html = value;
    node.children.length = 0; // replacing #app must detach the old pages
  } });
  return node;
}

export const receipt = id => ({ id, receipt_date: '1999-01-01', receipt_number: String(id), rows: [{ kartano: `K${id}` }] });
export const listPath = '/api/entities/receipts/list.php';
export function change(type, passive = false) {
  window.dispatchEvent(new CustomEvent(type, { detail: { passive } }));
}

// Inspect a visit after draining microtasks without releasing the held HTTP response.
export function observe(promise) {
  const visit = { status: 'pending' };
  promise.then(() => { visit.status = 'fulfilled'; }, () => { visit.status = 'rejected'; });
  return visit;
}

// Supply the child control a delegated browser event would have targeted.
export function fireControl(node, type, selector, control) {
  const event = new Event(type);
  Object.defineProperty(event, 'target', { value: { closest: s => s === selector ? control : null } });
  node.dispatchEvent(event);
}

// Each boot scenario runs in its own test file/process: a fresh module graph,
// the real router and listeners, a minimal DOM, and no live HTTP or timer polls.
export async function bootApp(t, lastPage, { beforeBoot, session = { logged_in: true, username: 'fixture', role: 'user' } } = {}) {
  const ids = ['app', 'sidebar', 'homePage', 'allReceiptsPage', 'receiptPage', 'treasuryPage', 'receiptTableBody', 'receiptNumber', 'receiptsList', 'receiptsFirstLoadError'];
  const nodes = Object.fromEntries(ids.map(id => [id, element(id)]));
  const pages = ids.filter(id => id.endsWith('Page')).map(id => nodes[id]);
  const body = element();
  // As in index.html, the sidebar is outside #app, but the route targets are inside it.
  body.appendChild(nodes.sidebar);
  body.appendChild(nodes.app);
  for (const page of pages) {
    nodes.app.appendChild(page);
    page.classList.add('hidden');
  }
  const slots = { receiptTableBody: nodes.receiptPage, receiptNumber: nodes.receiptPage,
    receiptsList: nodes.allReceiptsPage, receiptsFirstLoadError: nodes.allReceiptsPage };
  const sidebarBinds = t.mock.method(nodes.sidebar, 'addEventListener');
  globalThis.document = Object.assign(new EventTarget(), { body, head: element(), readyState: 'loading',
    getElementById(id) {
      const parent = slots[id];
      if (parent) return body.contains(parent) && parent.innerHTML.includes(`id="${id}"`) ? nodes[id] : null;
      return body.contains(nodes[id]) ? nodes[id] : null;
    }, createElement: () => element(),
    querySelector: () => null, querySelectorAll: s => s === '.page' ? pages.filter(p => body.contains(p)) : [] });
  globalThis.window = Object.assign(new EventTarget(), { location: {
    protocol: 'https:', host: 'fixture.invalid', pathname: '/index.html', href: 'https://fixture.invalid/index.html',
  } });
  const storage = new Map(lastPage ? [['karta_v2_last_page', lastPage]] : []);
  globalThis.sessionStorage = { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) };
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(() => SyncService.stop());

  const intervals = t.mock.method(globalThis, 'setInterval');
  const reads = [];
  let active = 0, peak = 0;
  t.after(() => {
    assert.ok(peak <= 1, `unexpected overlapping Forms reads: ${peak}`);
    assert.equal(active, 0, 'no Forms request left in flight');
  });
  const fetch = t.mock.method(globalThis, 'fetch', async (href, options) => {
    const url = new URL(href, 'https://fixture.invalid');
    if (/\/entities\/receipts\/(list|search)\.php$/.test(url.pathname)) {
      peak = Math.max(peak, ++active);
      return new Promise(resolve => reads.push({ path: url.pathname + url.search,
        passive: options.headers['X-Background-Poll'] === '1',
        reply: (data, meta) => resolve(Response.json({ success: true, data, meta })),
        fail: message => resolve(Response.json({ success: false, message }, { status: 503 })),
      })).finally(() => { active--; });
    }
    let data = [];
    if (url.pathname.endsWith('/health/ping.php')) data = { mysql: 'connected' };
    if (url.pathname.endsWith('/auth/session.php')) data = session;
    return Response.json({ success: true, data });
  });
  const requests = () => fetch.mock.calls.map(({ arguments: [href, options] }) => {
    assert.equal(options.method, 'GET');
    const url = new URL(href, 'https://fixture.invalid');
    return url.pathname + url.search;
  });
  beforeBoot?.(nodes);
  await import('../../app.js');
  await drain();
  return { nodes, storage, reads, requests, sidebarBinds, intervals };
}
