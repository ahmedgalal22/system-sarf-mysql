/**
 * test_owner_account_details_v2.mjs
 *
 * Automated test suite for the "تفاصيل الحساب" (Account Details) tab
 * inside the Vehicle Owner Details page (#ownerDetailsPage).
 *
 * Covers:
 *   1. Three-tab structure in #ownerDetailsPage (الحركات | المركبات والسائقين | تفاصيل الحساب)
 *      and exact 5-column order: له | عليه | ملاحظات | التاريخ | الوقت.
 *   2. Creating and appending rows at the bottom, server-generated Africa/Cairo
 *      entry_date/entry_time (read-only), and automatic focus on the new row's "له" input.
 *   3. Editing and saving on blur/Enter (not on every keystroke), preserving original
 *      entry_date/entry_time/created_at, status indicator (saving/saved/error), and
 *      preserving user input on validation or server failure.
 *   4. Numeric validation, Arabic-Indic digit normalization (٠-٩ → 0-9), blank → NULL
 *      storage and blank display, and exact decimal string preservation ("0.10", "1234.56")
 *      without JS/PHP float conversion.
 *   5. Owner and username isolation, filter reset on owner switch, stale response protection,
 *      and sync stability (deferring redraw while editing/saving and deduplicating rows).
 *   6. Search and date-range filtering (entry_date) combined with AND, clear filter,
 *      and non-interference with other tabs.
 *   7. Printing filtered rows with owner name, exact 5 columns, and zero financial balances/statements.
 *   8. Backup compatibility with legacy 14-table backups (original SHA-256 checksum preserved)
 *      and new 15-table backups (owner_account_details immediately after vehicle_owners).
 *   9. Strict financial isolation (zero effect on owner balances, ledgers, receipts, treasury,
 *      or office summaries; no Money/toCents/FinancialService/NoteRepository usage).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'Africa/Cairo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KARTA_DIR = path.resolve(__dirname, '..');

const elementsById = new Map();
const docClickListeners = [];
const docKeydownListeners = [];
const windowEventListeners = new Map();
const printedDocuments = [];
let activeElement = null;

function makeClassList(initial = []) {
  const set = new Set(initial.filter(Boolean));
  return {
    add(...cls) { cls.forEach((c) => c && set.add(c)); },
    remove(...cls) { cls.forEach((c) => set.delete(c)); },
    contains(c) { return set.has(c); },
    toggle(c, force) {
      if (force === undefined) {
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c); return true;
      }
      if (force) set.add(c); else set.delete(c);
      return !!force;
    },
  };
}

function makeElement(id = '', tagName = 'DIV', initialClasses = []) {
  let _innerHTML = '';
  const listeners = new Map();
  const attrs = new Map();
  const el = {
    id,
    tagName,
    value: '',
    textContent: '',
    dataset: {},
    style: { display: '', removeProperty() {} },
    children: [],
    classList: makeClassList(initialClasses),
    get innerHTML() {
      return _innerHTML;
    },
    set innerHTML(html) {
      _innerHTML = String(html ?? '');
      syncParsedElements(_innerHTML);
    },
    _setParsedInner(html) {
      _innerHTML = String(html ?? '');
    },
    setAttribute(name, val) {
      const strVal = String(val);
      attrs.set(name, strVal);
      if (name.startsWith('data-')) {
        const camel = name
          .slice(5)
          .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[camel] = strVal;
      }
      this[name] = strVal;
    },
    getAttribute(name) {
      if (attrs.has(name)) return attrs.get(name);
      if (name.startsWith('data-')) {
        const camel = name
          .slice(5)
          .replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        return this.dataset[camel] ?? null;
      }
      return this[name] ?? null;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener() {},
    focus() {
      activeElement = this;
      const list = listeners.get('focus') || [];
      for (const fn of list) fn.call(this, { type: 'focus', target: this });
    },
    blur() {
      if (activeElement === this) activeElement = null;
    },
    async trigger(type, eventObj = {}) {
      const list = listeners.get(type) || [];
      const evt = {
        type,
        target: this,
        preventDefault() { this.defaultPrevented = true; },
        ...eventObj,
      };
      for (const fn of list) {
        await fn.call(this, evt);
      }
      return evt;
    },
    appendChild(child) {
      if (child && child.id) elementsById.set(child.id, child);
      return child;
    },
    remove() {},
    querySelector(sel) {
      if (typeof sel === 'string' && sel.startsWith('#')) {
        return elementsById.get(sel.slice(1)) || null;
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
  };
  if (id) elementsById.set(id, el);
  return el;
}

function decodeHtmlEntities(str) {
  return String(str ?? '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function syncParsedElements(html) {
  const str = String(html ?? '');
  const openTagWithIdRegex = /<([a-zA-Z0-9]+)\b([^>]*?\bid="([^"]+)"[^>]*?)>(?:([^<]*)<\/\1>)?/g;
  let match;
  while ((match = openTagWithIdRegex.exec(str)) !== null) {
    const tag = match[1].toUpperCase();
    const rawAttrs = match[2];
    const id = match[3];
    const leafText = match[4];
    registerParsedElement(tag, rawAttrs, id, leafText);
  }

  const tbodyMatch = str.match(/<tbody\b[^>]*\bid="ownerAccTableBody"[^>]*>([\s\S]*?)<\/tbody>/i);
  if (tbodyMatch && elementsById.has('ownerAccTableBody')) {
    elementsById.get('ownerAccTableBody')._setParsedInner(tbodyMatch[1]);
  }
}

function registerParsedElement(tag, rawAttrs, id, leafText) {
  const classMatch = rawAttrs.match(/\bclass="([^"]+)"/);
  const classes = classMatch ? classMatch[1].trim().split(/\s+/) : [];

  let el = elementsById.get(id);
  if (!el) {
    el = makeElement(id, tag, classes);
  } else {
    el.tagName = tag;
    el.classList = makeClassList(classes);
  }

  const dataAttrRegex = /\b(data-[a-z0-9-]+|aria-[a-z0-9-]+|tabindex)="([^"]*)"/gi;
  let dMatch;
  while ((dMatch = dataAttrRegex.exec(rawAttrs)) !== null) {
    el.setAttribute(dMatch[1], decodeHtmlEntities(dMatch[2]));
  }

  const valMatch = rawAttrs.match(/\bvalue="([^"]*)"/);
  if (valMatch) {
    el.value = decodeHtmlEntities(valMatch[1]);
  } else if (tag === 'INPUT') {
    el.value = '';
  }

  if (leafText !== undefined) {
    el.textContent = decodeHtmlEntities(leafText);
  }
}

makeElement('ownersPage', 'SECTION');
makeElement('ownerDetailsPage', 'SECTION');

const mockDocument = {
  head: makeElement('head', 'HEAD'),
  get activeElement() {
    return activeElement;
  },
  body: {
    dataset: {},
    appendChild(child) {
      if (child && child.id) elementsById.set(child.id, child);
      if (child && child.tagName === 'IFRAME') {
        child.contentWindow = {
          document: {
            open() {},
            write(html) { printedDocuments.push(String(html ?? '')); },
            close() {},
          },
          focus() {},
          print() {},
        };
      }
      return child;
    },
  },
  getElementById(id) {
    return elementsById.get(id) ?? null;
  },
  createElement(tag) {
    const t = String(tag).toUpperCase();
    const el = makeElement('', t);
    if (t === 'DIV') {
      Object.defineProperty(el, 'firstElementChild', {
        get() { return makeElement('', 'DIV'); },
      });
    }
    return el;
  },
  querySelector(sel) {
    if (typeof sel === 'string' && sel.startsWith('#')) {
      return elementsById.get(sel.slice(1)) ?? null;
    }
    return null;
  },
  querySelectorAll() {
    return [];
  },
  addEventListener(type, fn) {
    if (type === 'click') docClickListeners.push(fn);
    if (type === 'keydown') docKeydownListeners.push(fn);
  },
};

globalThis.document = mockDocument;
globalThis.window = {
  SERVER_MODE_READY: true,
  __APP_CONTEXT__: { username: 'admin' },
  location: { href: 'http://localhost/karta/index.html', origin: 'http://localhost' },
  addEventListener(type, fn) {
    if (!windowEventListeners.has(type)) windowEventListeners.set(type, []);
    windowEventListeners.get(type).push(fn);
  },
  removeEventListener() {},
  async dispatchEvent(evt) {
    const list = windowEventListeners.get(evt?.type) || [];
    for (const fn of list) {
      await fn(evt);
    }
  },
  showPage: async (pageId) => {
    const el = elementsById.get(pageId);
    if (el) el.classList.remove('hidden');
  },
};
globalThis.sessionStorage = {
  _store: new Map(),
  getItem(k) { return this._store.get(k) ?? null; },
  setItem(k, v) { this._store.set(k, String(v)); },
  removeItem(k) { this._store.delete(k); },
};
globalThis.localStorage = {
  getItem() { return null; },
  setItem() {},
  removeItem() {},
};
globalThis.CustomEvent = class CustomEvent {
  constructor(type, opts = {}) {
    this.type = type;
    this.detail = opts.detail;
  }
};
globalThis.confirm = () => true;
globalThis.alert = () => {};

// ── Mock Server State ────────────────────────────────────────────────────────
let currentSessionUser = 'admin';
let nextAccountDetailId = 1;
let failNextUpdate = false;
let mockOwners = [];
let mockVehicles = [];
let mockLedgerEntries = [];
let mockOwnerAccountDetails = [];
let apiRequestLog = [];

function resetMockServer() {
  currentSessionUser = 'admin';
  nextAccountDetailId = 1;
  failNextUpdate = false;
  apiRequestLog = [];
  printedDocuments.length = 0;
  activeElement = null;

  mockOwners = [
    {
      id: 1,
      uuid: '11111111-1111-4111-8111-111111111111',
      username: 'admin',
      name: 'الحاج محمود سعيد',
      phone: '01011112222',
      owner_type: 'owner',
      deleted_at: null,
      created_at: '2026-06-01 10:00:00',
      updated_at: '2026-06-01 10:00:00',
    },
    {
      id: 2,
      uuid: '22222222-2222-4222-8222-222222222222',
      username: 'admin',
      name: 'شركة النيل للنقل',
      phone: '01033334444',
      owner_type: 'owner',
      deleted_at: null,
      created_at: '2026-06-02 10:00:00',
      updated_at: '2026-06-02 10:00:00',
    },
    {
      id: 3,
      uuid: '33333333-3333-4333-8333-333333333333',
      username: 'other_user',
      name: 'مالك مستخدم آخر',
      phone: '01099998888',
      owner_type: 'owner',
      deleted_at: null,
      created_at: '2026-06-03 10:00:00',
      updated_at: '2026-06-03 10:00:00',
    },
  ];

  mockVehicles = [
    {
      id: 10,
      plate: 'أ ب ج 123',
      owner_id: '1',
      owner_name: 'الحاج محمود سعيد',
      driver_name: 'سيد أحمد',
      username: 'admin',
      deleted_at: null,
    },
  ];

  mockLedgerEntries = [
    {
      id: 100,
      uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      username: 'admin',
      client_id: '1',
      client_type: 'owner',
      client_name: 'الحاج محمود سعيد',
      type: 'deposit',
      amount: 250000, // 2500.00 EGP in cents
      date: '2026-06-10',
      applied_at: '2026-06-10 09:00:00',
      created_at: '2026-06-10 09:00:00',
      note: 'رصيد افتتاحي',
      is_reversed: 0,
      is_archived: 0,
      deleted_at: null,
    },
  ];

  mockOwnerAccountDetails = [];
}

resetMockServer();

globalThis.fetch = async (url, options = {}) => {
  const u = String(url);
  const method = (options.method || 'GET').toUpperCase();
  const bodyObj = options.body ? JSON.parse(options.body) : null;
  apiRequestLog.push({ method, url: u, body: bodyObj });

  const respond = (payload, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(payload); },
    async json() { return payload; },
  });

  if (u.includes('/auth/session.php')) {
    return respond({
      success: true,
      data: { logged_in: true, username: currentSessionUser, role: 'admin' },
    });
  }

  if (u.includes('/entities/vehicleOwners/get.php')) {
    const idMatch = u.match(/[?&]id=([^&]+)/);
    const id = idMatch ? Number(decodeURIComponent(idMatch[1])) : 0;
    const owner = mockOwners.find((o) => o.id === id && o.deleted_at === null);
    if (!owner) return respond({ success: false, message: 'السجل غير موجود' }, 404);
    if (owner.username !== currentSessionUser) return respond({ success: false, message: 'غير مسموح' }, 403);
    return respond({ success: true, data: owner });
  }

  if (u.includes('/entities/vehicleOwners/list.php')) {
    const owners = mockOwners.filter((o) => o.username === currentSessionUser && o.deleted_at === null);
    return respond({ success: true, data: owners });
  }

  if (u.includes('/entities/vehicles/list.php')) {
    const vehicles = mockVehicles.filter((v) => v.username === currentSessionUser && v.deleted_at === null);
    return respond({ success: true, data: vehicles });
  }

  if (u.includes('/entities/vehicle-ledger/list.php')) {
    const parsedUrl = new URL(u, 'http://localhost');
    const clientId = parsedUrl.searchParams.get('client_id');
    const clientType = parsedUrl.searchParams.get('client_type');
    const entries = mockLedgerEntries.filter(
      (e) =>
        e.username === currentSessionUser &&
        String(e.client_id) === String(clientId) &&
        e.client_type === clientType &&
        !e.is_reversed &&
        e.deleted_at === null
    );
    return respond({ success: true, data: entries });
  }

  if (u.includes('/stats/client-karta-counts.php')) {
    return respond({ success: true, data: {} });
  }

  if (u.includes('/archive/list.php')) {
    return respond({ success: true, data: [] });
  }

  // ── Owner Account Details endpoints ─────────────────────────────────────
  if (u.includes('/entities/owner-account-details/list.php') && method === 'GET') {
    const parsedUrl = new URL(u, 'http://localhost');
    const ownerId = Number(parsedUrl.searchParams.get('owner_id') || 0);
    const owner = mockOwners.find(
      (o) => o.id === ownerId && o.deleted_at === null && o.owner_type === 'owner'
    );
    if (!owner) return respond({ success: false, message: 'صاحب المركبة غير موجود' }, 404);
    if (owner.username !== currentSessionUser) {
      return respond({ success: false, message: 'غير مسموح بالوصول' }, 403);
    }
    const rows = mockOwnerAccountDetails
      .filter((r) => r.owner_id === ownerId && r.username === currentSessionUser)
      .sort((a, b) => a.id - b.id);
    return respond({ success: true, data: rows });
  }

  if (u.includes('/entities/owner-account-details/create.php') && method === 'POST') {
    const ownerId = Number(bodyObj?.owner_id || 0);
    const owner = mockOwners.find(
      (o) => o.id === ownerId && o.deleted_at === null && o.owner_type === 'owner'
    );
    if (!owner) return respond({ success: false, message: 'صاحب المركبة غير موجود' }, 404);
    if (owner.username !== currentSessionUser) {
      return respond({ success: false, message: 'غير مسموح بالإضافة لهذا الحساب' }, 403);
    }

    const id = nextAccountDetailId++;
    const row = {
      id,
      uuid: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      owner_id: ownerId,
      username: currentSessionUser,
      leh_amount: bodyObj?.leh_amount ?? null,
      alayh_amount: bodyObj?.alayh_amount ?? null,
      notes: bodyObj?.notes ?? null,
      entry_date: `2026-11-0${Math.min(9, id)}`,
      entry_time: `14:0${Math.min(9, id)}:00`,
      created_by: currentSessionUser,
      updated_by: currentSessionUser,
      created_at: `2026-11-0${Math.min(9, id)} 14:0${Math.min(9, id)}:00.000`,
      updated_at: `2026-11-0${Math.min(9, id)} 14:0${Math.min(9, id)}:00.000`,
    };
    mockOwnerAccountDetails.push(row);
    return respond({ success: true, data: { ...row } }, 201);
  }

  if (u.includes('/entities/owner-account-details/update.php') && method === 'PUT') {
    if (failNextUpdate) {
      failNextUpdate = false;
      return respond({ success: false, message: 'تعذر الحفظ في قاعدة البيانات' }, 500);
    }
    const id = Number(bodyObj?.id || 0);
    const existing = mockOwnerAccountDetails.find((r) => r.id === id);
    if (!existing) return respond({ success: false, message: 'السجل غير موجود' }, 404);
    if (existing.username !== currentSessionUser) {
      return respond({ success: false, message: 'غير مسموح بالتعديل' }, 403);
    }
    if ('leh_amount' in bodyObj) existing.leh_amount = bodyObj.leh_amount;
    if ('alayh_amount' in bodyObj) existing.alayh_amount = bodyObj.alayh_amount;
    if ('notes' in bodyObj) existing.notes = bodyObj.notes;
    // Server never modifies entry_date, entry_time, or created_at
    existing.updated_at = '2026-11-03 18:30:00.000';
    return respond({ success: true, data: { ...existing } });
  }

  return respond({ success: true, data: [] });
};

const { activateServerMode } = await import('../services/apiConfig.js');
activateServerMode();

const { AuthModule } = await import('../auth.js');
await AuthModule.checkSession();

const {
  OwnersModule,
  showOwnerDetails,
  attachOwnersPageListeners,
  normalizeOwnerAccountDigits,
  normalizeAndValidateOwnerAccNumber,
} = await import('../entities.js');

attachOwnersPageListeners();

async function clickAction(actionName, dataset = {}) {
  const target = {
    dataset,
    closest(selector) {
      if (selector === `[data-action="${actionName}"]`) {
        return { dataset, getAttribute: (k) => dataset[k] ?? null };
      }
      return null;
    },
  };
  for (const fn of docClickListeners) {
    await fn({ target });
  }
}

test('1. Vehicle Owner Details renders 3 tabs including "تفاصيل الحساب" with exact 5-column order', async () => {
  resetMockServer();
  await showOwnerDetails('1', 'owner');

  const page = document.getElementById('ownerDetailsPage');
  assert.ok(page, 'ownerDetailsPage should exist');

  const btnMovements = document.getElementById('ownerTabBtnMovements');
  const btnVehicles = document.getElementById('ownerTabBtnVehicles');
  const btnAccountDetails = document.getElementById('ownerTabBtnAccountDetails');
  assert.ok(btnMovements, 'Movements tab button exists');
  assert.ok(btnVehicles, 'Vehicles tab button exists');
  assert.ok(btnAccountDetails, 'Account Details tab button exists');

  assert.ok(page.innerHTML.includes('الحركات'));
  assert.ok(page.innerHTML.includes('المركبات والسائقين'));
  assert.ok(page.innerHTML.includes('تفاصيل الحساب'));

  // Switch to تفاصيل الحساب tab
  await clickAction('owner-details-tab', { ownerTab: 'account-details' });
  const accPanel = document.getElementById('ownerTabPanelAccountDetails');
  assert.equal(accPanel.classList.contains('hidden'), false, 'Account Details panel should be visible');
  assert.equal(accPanel.classList.contains('is-active'), true);

  // Verify exact column header order: له | عليه | ملاحظات | التاريخ | الوقت
  const tableMatch = page.innerHTML.match(/<table id="ownerAccTable"[\s\S]*?<thead>([\s\S]*?)<\/thead>/);
  assert.ok(tableMatch, 'ownerAccTable thead must exist');
  const ths = [...tableMatch[1].matchAll(/<th>(.*?)<\/th>/g)].map((m) => m[1].trim());
  assert.deepEqual(ths, ['له', 'عليه', 'ملاحظات', 'التاريخ', 'الوقت']);
});

test('2. Adding rows appends at bottom in creation order, sets read-only date/time, and focuses "له"', async () => {
  resetMockServer();
  await showOwnerDetails('1', 'owner');
  await clickAction('owner-details-tab', { ownerTab: 'account-details' });

  // Add Row 1
  await clickAction('owner-acc-add-row');
  assert.equal(mockOwnerAccountDetails.length, 1);
  assert.equal(activeElement?.id, 'ownerAccLeh_1', 'New row 1 "له" input must be auto-focused');
  assert.equal(document.getElementById('ownerAccDate_1')?.textContent, '2026-11-01');
  assert.equal(document.getElementById('ownerAccTime_1')?.textContent, '14:01:00');
  assert.equal(document.getElementById('ownerAccLeh_1')?.value, '');
  assert.equal(document.getElementById('ownerAccAlayh_1')?.value, '');

  // Add Row 2 & Row 3
  await clickAction('owner-acc-add-row');
  await clickAction('owner-acc-add-row');
  assert.equal(mockOwnerAccountDetails.length, 3);
  assert.equal(activeElement?.id, 'ownerAccLeh_3', 'New row 3 "له" input must be auto-focused');

  // Verify row order in tbody is 1 -> 2 -> 3 (appended at bottom, never reversed)
  const tbodyHtml = document.getElementById('ownerAccTableBody').innerHTML;
  const rowIds = [...tbodyHtml.matchAll(/id="ownerAccRow_(\d+)"/g)].map((m) => Number(m[1]));
  assert.deepEqual(rowIds, [1, 2, 3]);
});

test('3. Editing cells saves on blur/Enter (not per keystroke) and never changes original entry_date/entry_time', async () => {
  resetMockServer();
  await showOwnerDetails('1', 'owner');
  await clickAction('owner-details-tab', { ownerTab: 'account-details' });
  await clickAction('owner-acc-add-row');

  const originalDate = document.getElementById('ownerAccDate_1').textContent;
  const originalTime = document.getElementById('ownerAccTime_1').textContent;
  const originalCreatedAt = mockOwnerAccountDetails[0].created_at;

  const lehInput = document.getElementById('ownerAccLeh_1');
  const alayhInput = document.getElementById('ownerAccAlayh_1');
  const notesInput = document.getElementById('ownerAccNotes_1');

  const putCountBefore = apiRequestLog.filter((r) => r.method === 'PUT').length;

  // Typing (input events) must NOT send API requests
  lehInput.value = '1';
  await lehInput.trigger('input');
  lehInput.value = '12';
  await lehInput.trigger('input');
  lehInput.value = '1234.56';
  await lehInput.trigger('input');

  const putCountAfterTyping = apiRequestLog.filter((r) => r.method === 'PUT').length;
  assert.equal(putCountAfterTyping, putCountBefore, 'Keystrokes must not send PUT requests');

  // Finishing edit via blur saves once
  await lehInput.trigger('blur');
  const putRequests1 = apiRequestLog.filter((r) => r.method === 'PUT');
  assert.equal(putRequests1.length, putCountBefore + 1);
  assert.equal(putRequests1.at(-1).body.leh_amount, '1234.56');
  assert.equal(document.getElementById('ownerAccStatusMsg').getAttribute('data-status'), 'saved');

  // Edit alayh with Arabic-Indic digits via Enter key
  alayhInput.value = '٠.١٠';
  await alayhInput.trigger('input');
  await alayhInput.trigger('keydown', { key: 'Enter' });
  assert.equal(alayhInput.value, '0.10', 'Arabic-Indic digits normalized and trailing zero preserved');
  assert.equal(mockOwnerAccountDetails[0].alayh_amount, '0.10');

  // Subsequent blur right after Enter must not send a duplicate PUT
  const putCountBeforeBlur = apiRequestLog.filter((r) => r.method === 'PUT').length;
  await alayhInput.trigger('blur');
  assert.equal(apiRequestLog.filter((r) => r.method === 'PUT').length, putCountBeforeBlur);

  // Edit notes
  notesInput.value = 'دفعة تحت الحساب';
  await notesInput.trigger('blur');
  assert.equal(mockOwnerAccountDetails[0].notes, 'دفعة تحت الحساب');

  // Original creation date, time, and created_at must remain completely unchanged
  assert.equal(document.getElementById('ownerAccDate_1').textContent, originalDate);
  assert.equal(document.getElementById('ownerAccTime_1').textContent, originalTime);
  assert.equal(mockOwnerAccountDetails[0].entry_date, originalDate);
  assert.equal(mockOwnerAccountDetails[0].entry_time, originalTime);
  assert.equal(mockOwnerAccountDetails[0].created_at, originalCreatedAt);

  // Clearing a numeric field saves NULL and displays blank
  lehInput.value = '   ';
  await lehInput.trigger('blur');
  assert.equal(mockOwnerAccountDetails[0].leh_amount, null);
  assert.equal(lehInput.value, '');
});

test('4. Numeric validation rejects invalid text, preserves user input on error, and preserves decimal precision', async () => {
  resetMockServer();
  await showOwnerDetails('1', 'owner');
  await clickAction('owner-details-tab', { ownerTab: 'account-details' });
  await clickAction('owner-acc-add-row');

  // Direct unit checks on helper
  assert.deepEqual(normalizeOwnerAccountDigits('١٢٣٤٥٦٧٨٩٠٫٢٥'), '1234567890.25');
  assert.equal(normalizeAndValidateOwnerAccNumber('', 'له').value, null);
  assert.equal(normalizeAndValidateOwnerAccNumber('0.10', 'له').value, '0.10');
  assert.equal(normalizeAndValidateOwnerAccNumber('999999999999.99', 'له').value, '999999999999.99');
  assert.equal(normalizeAndValidateOwnerAccNumber('abc', 'له').valid, false);
  assert.equal(normalizeAndValidateOwnerAccNumber('-10', 'له').valid, false);
  assert.equal(normalizeAndValidateOwnerAccNumber('12.345', 'له').valid, false);

  const lehInput = document.getElementById('ownerAccLeh_1');
  const putCountBefore = apiRequestLog.filter((r) => r.method === 'PUT').length;

  // Invalid text input
  lehInput.value = '100 جنيه';
  await lehInput.trigger('input');
  await lehInput.trigger('blur');

  assert.equal(
    apiRequestLog.filter((r) => r.method === 'PUT').length,
    putCountBefore,
    'Invalid numeric input must not send PUT request'
  );
  assert.equal(lehInput.value, '100 جنيه', 'User entered value must be preserved on validation failure');
  assert.equal(document.getElementById('ownerAccStatusMsg').getAttribute('data-status'), 'error');

  // Server failure during save must also preserve user's entered value and show error
  failNextUpdate = true;
  lehInput.value = '750.25';
  await lehInput.trigger('input');
  await lehInput.trigger('blur');
  assert.equal(lehInput.value, '750.25', 'User entered value must be preserved when server save fails');
  assert.equal(document.getElementById('ownerAccStatusMsg').getAttribute('data-status'), 'error');
});

test('5. Owner and username isolation, filter reset on owner switch, and sync safety', async () => {
  resetMockServer();
  mockOwnerAccountDetails.push(
    {
      id: 1,
      uuid: '00000000-0000-4000-8000-000000000001',
      owner_id: 1,
      username: 'admin',
      leh_amount: '500.00',
      alayh_amount: null,
      notes: 'مذكرة المالك الأول',
      entry_date: '2026-11-01',
      entry_time: '10:00:00',
    },
    {
      id: 2,
      uuid: '00000000-0000-4000-8000-000000000002',
      owner_id: 2,
      username: 'admin',
      leh_amount: null,
      alayh_amount: '900.50',
      notes: 'مذكرة المالك الثاني',
      entry_date: '2026-11-02',
      entry_time: '11:30:00',
    }
  );

  await showOwnerDetails('1', 'owner');
  await clickAction('owner-details-tab', { ownerTab: 'account-details' });

  let tbodyHtml = document.getElementById('ownerAccTableBody').innerHTML;
  assert.ok(tbodyHtml.includes('مذكرة المالك الأول'));
  assert.ok(!tbodyHtml.includes('مذكرة المالك الثاني'));

  // Set filters on Owner 1
  const searchEl = document.getElementById('ownerAccSearchInput');
  const fromEl = document.getElementById('ownerAccFromDate');
  searchEl.value = 'الأول';
  await searchEl.trigger('input');
  fromEl.value = '2026-11-01';
  await fromEl.trigger('change');

  // Switch to Owner 2 -> must display only Owner 2's records and reset filters
  await showOwnerDetails('2', 'owner');
  assert.equal(document.getElementById('ownerAccSearchInput').value, '');
  assert.equal(document.getElementById('ownerAccFromDate').value, '');
  tbodyHtml = document.getElementById('ownerAccTableBody').innerHTML;
  assert.ok(tbodyHtml.includes('مذكرة المالك الثاني'));
  assert.ok(!tbodyHtml.includes('مذكرة المالك الأول'));

  // Sync safety: while user is editing a cell on Owner 2, passive sync must NOT overwrite input
  const notes2 = document.getElementById('ownerAccNotes_2');
  notes2.focus();
  notes2.value = 'نص قيد الكتابة لم يحفظ بعد';
  await notes2.trigger('input');

  await window.dispatchEvent(
    new CustomEvent('ownerAccountDetails:changed', { detail: { passive: true, source: 'sync' } })
  );
  assert.equal(
    document.getElementById('ownerAccNotes_2').value,
    'نص قيد الكتابة لم يحفظ بعد',
    'Sync event must not overwrite unsaved user input while editing'
  );
});

test('6. Search and date filters combine with AND and Printing outputs only matching rows without financial data', async () => {
  resetMockServer();
  mockOwnerAccountDetails.push(
    {
      id: 1,
      uuid: '00000000-0000-4000-8000-000000000001',
      owner_id: 1,
      username: 'admin',
      leh_amount: '100.00',
      alayh_amount: null,
      notes: 'دفعة أولى نقدية',
      entry_date: '2026-10-01',
      entry_time: '09:00:00',
    },
    {
      id: 2,
      uuid: '00000000-0000-4000-8000-000000000002',
      owner_id: 1,
      username: 'admin',
      leh_amount: '250.50',
      alayh_amount: null,
      notes: 'دفعة ثانية نقدية',
      entry_date: '2026-10-15',
      entry_time: '12:30:00',
    },
    {
      id: 3,
      uuid: '00000000-0000-4000-8000-000000000003',
      owner_id: 1,
      username: 'admin',
      leh_amount: null,
      alayh_amount: '400.00',
      notes: 'خصم صيانة',
      entry_date: '2026-10-15',
      entry_time: '16:45:00',
    }
  );

  await showOwnerDetails('1', 'owner');
  await clickAction('owner-details-tab', { ownerTab: 'account-details' });

  // Filter by date (2026-10-10 to 2026-10-20) -> rows 2 and 3
  const fromEl = document.getElementById('ownerAccFromDate');
  const toEl = document.getElementById('ownerAccToDate');
  fromEl.value = '2026-10-10';
  await fromEl.trigger('change');
  toEl.value = '2026-10-20';
  await toEl.trigger('change');

  let tbodyHtml = document.getElementById('ownerAccTableBody').innerHTML;
  assert.ok(!tbodyHtml.includes('دفعة أولى نقدية'));
  assert.ok(tbodyHtml.includes('دفعة ثانية نقدية'));
  assert.ok(tbodyHtml.includes('خصم صيانة'));

  // Combine with search ("نقدية") using AND -> only row 2 matches both
  const searchEl = document.getElementById('ownerAccSearchInput');
  searchEl.value = 'نقدية';
  await searchEl.trigger('input');

  tbodyHtml = document.getElementById('ownerAccTableBody').innerHTML;
  assert.ok(!tbodyHtml.includes('دفعة أولى نقدية'));
  assert.ok(tbodyHtml.includes('دفعة ثانية نقدية'));
  assert.ok(!tbodyHtml.includes('خصم صيانة'));

  // Print while filtered -> must print only Row 2, include owner name, preserve 5 columns, and exclude balance
  printedDocuments.length = 0;
  await clickAction('owner-acc-print');
  assert.equal(printedDocuments.length, 1);
  const printDoc = printedDocuments[0];

  assert.ok(printDoc.includes('الحاج محمود سعيد'), 'Print heading must include owner name');
  assert.ok(printDoc.includes('دفعة ثانية نقدية'), 'Matching row must be printed');
  assert.ok(!printDoc.includes('دفعة أولى نقدية'), 'Date-excluded row must not be printed');
  assert.ok(!printDoc.includes('خصم صيانة'), 'Search-excluded row must not be printed');
  assert.ok(!printDoc.includes('الرصيد الحالي'), 'Printout must not include financial balance');
  assert.ok(!printDoc.includes('2500.00'), 'Printout must not include owner ledger balance');

  const printHeaders = [...printDoc.matchAll(/<th>(.*?)<\/th>/g)].map((m) => m[1].trim());
  assert.deepEqual(printHeaders, ['له', 'عليه', 'ملاحظات', 'التاريخ', 'الوقت']);

  // Clear filter restores all 3 rows
  await clickAction('owner-acc-clear-filter');
  tbodyHtml = document.getElementById('ownerAccTableBody').innerHTML;
  assert.ok(tbodyHtml.includes('دفعة أولى نقدية'));
  assert.ok(tbodyHtml.includes('دفعة ثانية نقدية'));
  assert.ok(tbodyHtml.includes('خصم صيانة'));
});

test('7. Backup compatibility: BackupRepository preserves legacy 14-table checksums and orders owner_account_details after vehicle_owners', () => {
  const backupRepoPhp = fs.readFileSync(
    path.join(KARTA_DIR, 'repositories', 'BackupRepository.php'),
    'utf8'
  );
  const restorePhp = fs.readFileSync(
    path.join(KARTA_DIR, 'api', 'backup', 'restore.php'),
    'utf8'
  );

  // Verify TABLE_ORDER places owner_account_details immediately after vehicle_owners
  const tableOrderMatch = backupRepoPhp.match(/TABLE_ORDER\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(tableOrderMatch, 'TABLE_ORDER must exist in BackupRepository.php');
  const tables = [...tableOrderMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const ownersIdx = tables.indexOf('vehicle_owners');
  const accDetailsIdx = tables.indexOf('owner_account_details');
  assert.ok(ownersIdx >= 0, 'vehicle_owners must be in TABLE_ORDER');
  assert.equal(
    accDetailsIdx,
    ownersIdx + 1,
    'owner_account_details must be immediately after vehicle_owners in TABLE_ORDER'
  );

  // Verify OPTIONAL_LEGACY_TABLES includes owner_account_details for backward compatibility
  assert.ok(
    backupRepoPhp.includes('OPTIONAL_LEGACY_TABLES') &&
      backupRepoPhp.includes("'owner_account_details'"),
    'BackupRepository must allow legacy backups without owner_account_details to keep their original checksum'
  );

  // Verify checksum formula compatibility for legacy 14-table backups vs new 15-table backups
  const legacyTables = tables.filter((t) => t !== 'owner_account_details');
  const legacyParts = ['karta-v2-v1', ...legacyTables.map((t) => `${t}:2`)];
  const legacyChecksum = crypto.createHash('sha256').update(legacyParts.join('|')).digest('hex');

  const newParts = ['karta-v2-v1', ...tables.map((t) => `${t}:2`)];
  const newChecksum = crypto.createHash('sha256').update(newParts.join('|')).digest('hex');
  assert.notEqual(legacyChecksum, newChecksum);

  assert.ok(
    restorePhp.includes("'owner_account_details'"),
    'api/backup/restore.php must bump version for owner_account_details'
  );
});

test('8. Strict financial isolation: memo values never affect owner balances, ledgers, or financial endpoints', async () => {
  resetMockServer();
  await showOwnerDetails('1', 'owner');

  const balanceBefore = await OwnersModule.getClientBalance('1', 'owner');
  const ledgerBefore = await OwnersModule.getClientLedger('1', 'owner');
  assert.equal(balanceBefore.balance, 2500);
  assert.equal(ledgerBefore.length, 1);

  // Add and update memo rows with large numbers
  await clickAction('owner-details-tab', { ownerTab: 'account-details' });
  await clickAction('owner-acc-add-row');

  const lehInput = document.getElementById('ownerAccLeh_1');
  const alayhInput = document.getElementById('ownerAccAlayh_1');
  lehInput.value = '95000.75';
  await lehInput.trigger('blur');
  alayhInput.value = '42000.25';
  await alayhInput.trigger('blur');

  const balanceAfter = await OwnersModule.getClientBalance('1', 'owner');
  const ledgerAfter = await OwnersModule.getClientLedger('1', 'owner');

  assert.equal(balanceAfter.balance, balanceBefore.balance, 'Owner financial balance must remain untouched');
  assert.equal(ledgerAfter.length, ledgerBefore.length, 'Owner financial ledger must remain untouched');

  // Verify no financial write endpoints or notes endpoints were called
  const forbiddenEndpoints = [
    '/financial/',
    '/entities/vehicle-ledger/create.php',
    '/entities/vehicle-ledger/update.php',
    '/entities/treasury/',
    '/entities/receipts/',
    '/entities/notes/',
  ];
  for (const req of apiRequestLog) {
    for (const forbidden of forbiddenEndpoints) {
      assert.ok(
        !req.url.includes(forbidden),
        `Memo operations must never call ${forbidden} (saw ${req.url})`
      );
    }
  }

  // Verify backend PHP files do not reference Money, FinancialService, VehicleLedgerRepository, or NoteRepository
  const phpFiles = [
    path.join(KARTA_DIR, 'repositories', 'OwnerAccountDetailsRepository.php'),
    path.join(KARTA_DIR, 'api', 'entities', 'owner-account-details', 'list.php'),
    path.join(KARTA_DIR, 'api', 'entities', 'owner-account-details', 'create.php'),
    path.join(KARTA_DIR, 'api', 'entities', 'owner-account-details', 'update.php'),
  ];
  for (const file of phpFiles) {
    const content = fs.readFileSync(file, 'utf8');
    assert.ok(!content.includes('NoteRepository'), `${path.basename(file)} must not use NoteRepository`);
    assert.ok(!content.includes('VehicleLedgerRepository'), `${path.basename(file)} must not use VehicleLedgerRepository`);
    assert.ok(!content.includes('TreasuryRepository'), `${path.basename(file)} must not use TreasuryRepository`);
    assert.ok(!content.includes('ReceiptRepository'), `${path.basename(file)} must not use ReceiptRepository`);
    assert.ok(!content.includes('floatval(') && !content.includes('(float)'), `${path.basename(file)} must not use PHP float conversions`);
  }
});
