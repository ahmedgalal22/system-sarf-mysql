/**
 * test_vehicle_details_page_v2.mjs
 *
 * Comprehensive automated test suite for the standalone "تفاصيل السيارات" (Vehicle Details)
 * feature in Karta ERP.
 *
 * NOTE ON EXECUTION ENVIRONMENT:
 *   The sandbox container does not have the `php` CLI binary installed.
 *   This suite verifies:
 *     1. SQL schema, PHP repository, PHP endpoints, and Backup/Restore static & behavioral contracts.
 *     2. Real ES module execution of `vehicleDetails.js`, `vehicleDetailsRepository.js`,
 *        `entities.js`, `financial.js`, `dbProvider.js`, `domainRegistry.js`, `syncService.js`,
 *        `dateUtils.js`, `money.js`, and `printEngine.js`.
 *     3. All 12 required functional scenarios + the critical Zero Financial Impact regression test.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.TZ = 'Africa/Cairo';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KARTA_DIR = path.resolve(__dirname, '..');

function readKartaFile(relPath) {
  return fs.readFileSync(path.join(KARTA_DIR, relPath), 'utf8');
}

// ── Minimal DOM & Browser Environment Harness ────────────────────────────────

const elementsById = new Map();
const docListeners = new Map();
const winListeners = new Map();
const printedDocuments = [];
const sessionStore = new Map();
const localStore = new Map();

function makeClassList(initial = []) {
  const set = new Set(initial.filter(Boolean));
  return {
    add(...cls) { cls.forEach(c => c && set.add(c)); },
    remove(...cls) { cls.forEach(c => set.delete(c)); },
    contains(c) { return set.has(c); },
    toggle(c, force) {
      if (force === undefined) {
        if (set.has(c)) { set.delete(c); return false; }
        set.add(c); return true;
      }
      if (force) set.add(c); else set.delete(c);
      return Boolean(force);
    },
  };
}

function parseAttributes(attrString) {
  const attrs = {};
  const dataset = {};
  const attrRegex = /([a-zA-Z0-9_-]+)(?:="([^"]*)")?/g;
  let m;
  while ((m = attrRegex.exec(attrString)) !== null) {
    const key = m[1];
    const val = m[2] ?? '';
    attrs[key] = val;
    if (key.startsWith('data-')) {
      const camel = key.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      dataset[camel] = val;
    }
  }
  return { attrs, dataset };
}

function parseTableRows(tbodyHtml) {
  const rows = [];
  const trRegex = /<tr\b([^>]*)>([\s\S]*?)<\/tr>/gi;
  let trMatch;
  while ((trMatch = trRegex.exec(tbodyHtml)) !== null) {
    const { attrs, dataset } = parseAttributes(trMatch[1] || '');
    const inner = trMatch[2] || '';
    const rowInputs = new Map();

    const inputRegex = /<input\b([^>]*)\/?>/gi;
    let inMatch;
    while ((inMatch = inputRegex.exec(inner)) !== null) {
      const parsed = parseAttributes(inMatch[1] || '');
      const clsList = (parsed.attrs.class || '').split(/\s+/).filter(Boolean);
      const inputEl = {
        id: parsed.attrs.id || '',
        value: parsed.attrs.value ?? '',
        dataset: parsed.dataset,
        classList: makeClassList(clsList),
        getAttribute(name) { return parsed.attrs[name] ?? null; },
      };
      if (inputEl.id) elementsById.set(inputEl.id, inputEl);
      for (const cls of clsList) {
        rowInputs.set(`.${cls}`, inputEl);
      }
    }

    const rowButtons = [];
    const btnRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
    let btnMatch;
    while ((btnMatch = btnRegex.exec(inner)) !== null) {
      const parsed = parseAttributes(btnMatch[1] || '');
      const text = (btnMatch[2] || '').replace(/<[^>]+>/g, '').trim();
      const btnObj = {
        tagName: 'BUTTON',
        textContent: text,
        dataset: parsed.dataset,
        disabled: Object.prototype.hasOwnProperty.call(parsed.attrs, 'disabled'),
        getAttribute(name) { return parsed.attrs[name] ?? null; },
        closest(sel) {
          if (sel === 'tr') return trObj;
          if (sel.startsWith('[data-action="')) {
            const act = sel.slice(14, -2);
            return parsed.dataset.action === act ? btnObj : null;
          }
          return null;
        },
      };
      rowButtons.push(btnObj);
    }

    const tdContents = [];
    const tdRegex = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(inner)) !== null) {
      const tdParsed = parseAttributes(tdMatch[1] || '');
      const rawContent = tdMatch[2] || '';
      const plainText = rawContent.replace(/<[^>]+>/g, '').trim();
      tdContents.push({
        attrs: tdParsed.attrs,
        dataset: tdParsed.dataset,
        innerHTML: rawContent,
        textContent: plainText,
      });
    }

    const trObj = {
      tagName: 'TR',
      dataset,
      attrs,
      innerHTML: inner,
      cells: tdContents,
      buttons: rowButtons,
      style: { display: '' },
      getAttribute(name) { return attrs[name] ?? null; },
      querySelector(sel) {
        if (rowInputs.has(sel)) return rowInputs.get(sel);
        if (sel.startsWith('[data-action="')) {
          const act = sel.slice(14, -2);
          return rowButtons.find(b => b.dataset.action === act) || null;
        }
        return null;
      },
      querySelectorAll(sel) {
        if (sel === 'td') return tdContents;
        if (sel === 'button') return rowButtons;
        return [];
      },
      closest(sel) {
        if (sel === 'tr') return trObj;
        return null;
      },
    };
    rows.push(trObj);
  }
  return rows;
}

function syncParsedElements(html) {
  const openTagWithIdRegex = /<([a-zA-Z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)\/?>/g;
  let match;
  while ((match = openTagWithIdRegex.exec(html)) !== null) {
    const tag = match[1].toUpperCase();
    const attrStr = match[2] || '';
    const id = match[3];
    const { attrs, dataset } = parseAttributes(attrStr);
    const classes = (attrs.class || '').trim().split(/\s+/).filter(Boolean);

    let el = elementsById.get(id);
    if (!el) {
      el = makeElement(id, tag, classes);
    } else {
      el.tagName = tag;
      el.classList = makeClassList(classes);
    }
    el.dataset = { ...el.dataset, ...dataset };
    if (attrs.value !== undefined) {
      el.value = attrs.value;
    }

    // Extract inner text/HTML for non-void elements
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const closeMatch = new RegExp(`<${match[1]}\\b[^>]*\\bid="${escapedId}"[^>]*>([\\s\\S]*?)<\\/${match[1]}>`, 'i').exec(html);
    if (closeMatch && closeMatch[1] !== undefined) {
      const inner = closeMatch[1];
      if (!inner.includes('<')) {
        el.textContent = inner;
      } else {
        el._setRawInnerHTML(inner);
      }
    }
  }
}

function makeElement(id = '', tagName = 'DIV', initialClasses = []) {
  let _innerHTML = '';
  let _parsedRows = [];
  const el = {
    id,
    tagName,
    value: '',
    textContent: '',
    dataset: {},
    style: { cssText: '', display: '', removeProperty() {} },
    children: [],
    classList: makeClassList(initialClasses),
    _setRawInnerHTML(raw) {
      _innerHTML = String(raw ?? '');
      if (this.tagName === 'TBODY') {
        _parsedRows = parseTableRows(_innerHTML);
        this.children = _parsedRows;
      }
    },
    get innerHTML() {
      return _innerHTML;
    },
    set innerHTML(html) {
      _innerHTML = String(html ?? '');
      if (this.tagName === 'TBODY') {
        _parsedRows = parseTableRows(_innerHTML);
        this.children = _parsedRows;
      }
      syncParsedElements(_innerHTML);
    },
    setAttribute(name, val) {
      if (name.startsWith('data-')) {
        const camel = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        this.dataset[camel] = String(val);
      }
      this[name] = String(val);
    },
    getAttribute(name) {
      if (name.startsWith('data-')) {
        const camel = name.slice(5).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
        return this.dataset[camel] ?? null;
      }
      return this[name] ?? null;
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      if (child && child.id) elementsById.set(child.id, child);
      return child;
    },
    remove() {
      if (this.id) elementsById.delete(this.id);
    },
    querySelector(sel) {
      if (typeof sel === 'string' && sel.startsWith('#')) {
        return elementsById.get(sel.slice(1)) || null;
      }
      return null;
    },
    querySelectorAll(sel) {
      if (this.tagName === 'TBODY' && sel === 'tr') {
        return _parsedRows;
      }
      return [];
    },
    closest() { return null; },
  };
  if (id) elementsById.set(id, el);
  return el;
}

// Setup global browser mocks before importing ES modules
const sidebarLinks = [
  'homePage',
  'dashboardPage',
  'receipt',
  'allReceipts',
  'ownersPage',
  'vehicleDetailsPage',
  'treasuryPage',
  'officesPage',
  'archivePage',
].map(pageKey => {
  const link = makeElement(`sidebar_${pageKey}`, 'BUTTON', ['sidebar-link']);
  link.dataset.page = pageKey;
  return link;
});

const pageIds = [
  'homePage',
  'dashboardPage',
  'receiptPage',
  'allReceiptsPage',
  'ownersPage',
  'ownerDetailsPage',
  'vehicleDetailsPage',
  'vehicleOwnerDetailsPage',
  'treasuryPage',
  'archivePage',
  'officesPage',
  'officeDetailsPage',
];
const pageElements = pageIds.map(pid => makeElement(pid, 'SECTION', ['page', 'hidden']));

globalThis.sessionStorage = {
  getItem(k) { return sessionStore.has(k) ? sessionStore.get(k) : null; },
  setItem(k, v) { sessionStore.set(k, String(v)); },
  removeItem(k) { sessionStore.delete(k); },
  clear() { sessionStore.clear(); },
};

globalThis.localStorage = {
  getItem(k) { return localStore.has(k) ? localStore.get(k) : null; },
  setItem(k, v) { localStore.set(k, String(v)); },
  removeItem(k) { localStore.delete(k); },
  clear() { localStore.clear(); },
};

globalThis.document = {
  readyState: 'complete',
  body: {
    dataset: {},
    classList: makeClassList(),
    appendChild(child) {
      if (child && child.id) elementsById.set(child.id, child);
      return child;
    },
  },
  documentElement: {
    clientWidth: 1280,
    style: { setProperty() {} },
  },
  getElementById(id) {
    return elementsById.get(id) || null;
  },
  createElement(tag) {
    const upper = String(tag).toUpperCase();
    if (upper === 'IFRAME') {
      let writtenHtml = '';
      const iframe = makeElement('', 'IFRAME');
      iframe.contentDocument = {
        open() {},
        write(html) {
          writtenHtml = String(html ?? '');
          printedDocuments.push(writtenHtml);
        },
        close() {},
      };
      iframe.contentWindow = {
        document: iframe.contentDocument,
        focus() {},
        print() {},
      };
      return iframe;
    }
    return makeElement('', upper);
  },
  querySelector(sel) {
    if (sel.startsWith('#')) return elementsById.get(sel.slice(1)) || null;
    return null;
  },
  querySelectorAll(sel) {
    if (sel === '.page') return pageElements;
    if (sel === '#sidebar .sidebar-link') return sidebarLinks;
    if (sel === '#vdMovementsTableBody tr') {
      return elementsById.get('vdMovementsTableBody')?.querySelectorAll('tr') || [];
    }
    if (sel === '#vdOwnersTableBody tr') {
      return elementsById.get('vdOwnersTableBody')?.querySelectorAll('tr') || [];
    }
    if (sel === '#ownersTableBody tr') {
      return elementsById.get('ownersTableBody')?.querySelectorAll('tr') || [];
    }
    return [];
  },
  addEventListener(type, fn) {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  },
  removeEventListener() {},
};

globalThis.CustomEvent = class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail ?? null;
  }
};

globalThis.window = {
  document: globalThis.document,
  sessionStorage: globalThis.sessionStorage,
  localStorage: globalThis.localStorage,
  SERVER_MODE_READY: true,
  __APP_CONTEXT__: { username: 'admin' },
  location: { href: 'index.html', reload() {} },
  innerWidth: 1280,
  innerHeight: 800,
  confirm: () => true,
  alert: () => {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  requestAnimationFrame: (cb) => cb(),
  addEventListener(type, fn) {
    if (!winListeners.has(type)) winListeners.set(type, []);
    winListeners.get(type).push(fn);
  },
  removeEventListener() {},
  dispatchEvent(event) {
    const handlers = winListeners.get(event.type) || [];
    for (const fn of handlers) {
      fn(event);
    }
    return true;
  },
};

// Lightweight showPage router matching app.js sidebar & visibility rules
globalThis.window.showPage = async function showPage(pageName) {
  for (const p of pageElements) {
    p.classList.add('hidden');
  }
  const target = elementsById.get(pageName);
  if (target) {
    target.classList.remove('hidden');
  }
  const sidebarKey = pageName === 'vehicleOwnerDetailsPage' ? 'vehicleDetailsPage' : pageName;
  for (const link of sidebarLinks) {
    link.classList.toggle('active', link.dataset.page === sidebarKey);
  }
  globalThis.sessionStorage.setItem('karta_v2_last_page', pageName);
};

// ── Stateful Mock Backend Server (Mirrors PHP Endpoints & Repositories) ──────

let currentAuthUsername = 'admin';
let nextOwnerId = 1;
let nextMovementId = 100;

const dbState = {
  vehicle_owners: [],
  vehicle_details_movements: [],
  vehicle_ledger: [],
  treasury: [],
  receipts: [],
  offices: [],
  data_versions: {
    vehicle_owners: 1,
    vehicle_details_movements: 1,
    offices: 1,
    vehicles: 1,
    receipts: 1,
    treasury: 1,
    vehicle_ledger: 1,
    main_capital: 1,
    archive_batches: 1,
    drivers: 1,
    notes: 1,
  },
  apiCallLog: [],
};

function resetDbState() {
  currentAuthUsername = 'admin';
  nextOwnerId = 1;
  nextMovementId = 100;
  dbState.vehicle_owners = [
    {
      id: nextOwnerId++,
      uuid: 'owner-uuid-1',
      username: 'admin',
      name: 'أحمد جلال',
      phone: '01000000001',
      owner_type: 'owner',
      notes: null,
      deleted_at: null,
      created_at: '2026-11-01 10:00:00',
      updated_at: '2026-11-01 10:00:00',
    },
    {
      id: nextOwnerId++,
      uuid: 'owner-uuid-2',
      username: 'admin',
      name: 'محمود السيد',
      phone: '01000000002',
      owner_type: 'owner',
      notes: null,
      deleted_at: null,
      created_at: '2026-11-01 11:00:00',
      updated_at: '2026-11-01 11:00:00',
    },
    {
      id: nextOwnerId++,
      uuid: 'broker-uuid-3',
      username: 'admin',
      name: 'مندوب مستبعد',
      phone: '01000000003',
      owner_type: 'broker',
      notes: null,
      deleted_at: null,
      created_at: '2026-11-01 12:00:00',
      updated_at: '2026-11-01 12:00:00',
    },
    {
      id: nextOwnerId++,
      uuid: 'deleted-owner-uuid-4',
      username: 'admin',
      name: 'مالك محذوف',
      phone: '01000000004',
      owner_type: 'owner',
      notes: null,
      deleted_at: '2026-11-01 13:00:00',
      created_at: '2026-11-01 09:00:00',
      updated_at: '2026-11-01 13:00:00',
    },
    {
      id: nextOwnerId++,
      uuid: 'other-user-owner-5',
      username: 'other_user',
      name: 'مالك مستخدم آخر',
      phone: '01000000005',
      owner_type: 'owner',
      notes: null,
      deleted_at: null,
      created_at: '2026-11-01 14:00:00',
      updated_at: '2026-11-01 14:00:00',
    },
  ];
  dbState.vehicle_details_movements = [];
  dbState.vehicle_ledger = [
    {
      id: 1,
      uuid: 'vl-1',
      username: 'admin',
      client_id: '1',
      client_type: 'owner',
      type: 'deposit',
      amount: 250000, // 2500.00 EGP in cents
      date: '2026-11-01',
      applied_at: '2026-11-01T10:00:00',
      note: 'رصيد افتتاحي',
      reference_type: 'client_balance',
      deleted_at: null,
    },
    {
      id: 2,
      uuid: 'vl-2',
      username: 'admin',
      client_id: '2',
      client_type: 'owner',
      type: 'withdraw',
      amount: -120000, // -1200.00 EGP in cents
      date: '2026-11-01',
      applied_at: '2026-11-01T11:00:00',
      note: 'دفعة نقدية',
      reference_type: 'client_balance',
      deleted_at: null,
    },
  ];
  dbState.treasury = [
    {
      id: 1,
      uuid: 'tr-1',
      username: 'admin',
      type: 'deposit',
      amount: 500000, // 5000.00 EGP in cents
      date: '2026-11-01',
      note: 'إيداع خزنة',
      deleted_at: null,
    },
  ];
  dbState.receipts = [
    {
      id: 10,
      uuid: 'rec-10',
      username: 'admin',
      receipt_number: '1001',
      vehicle_owner_id: '1',
      owner_name: 'أحمد جلال',
      total: 150000,
      paid: 50000,
      remaining: 100000,
      net_total: 150000,
      payout_status: 'unpaid',
      date: '2026-11-01',
      rows: [],
      deleted_at: null,
    },
  ];
  dbState.offices = [
    {
      id: 1,
      uuid: 'off-1',
      username: 'admin',
      name: 'مكتب النور',
      phone: '01200000001',
      deleted_at: null,
    },
  ];
  dbState.apiCallLog = [];
}

function validateEligibleOwnerBackend(ownerId, username) {
  const idNum = Number(ownerId);
  if (!idNum || idNum <= 0) {
    return { ok: false, status: 400, message: 'معرّف صاحب المركبة مطلوب' };
  }
  const owner = dbState.vehicle_owners.find(o => Number(o.id) === idNum);
  if (!owner || owner.deleted_at !== null) {
    return { ok: false, status: 404, message: 'صاحب المركبة غير موجود' };
  }
  if (owner.username !== username) {
    return { ok: false, status: 403, message: 'غير مسموح' };
  }
  if (owner.owner_type === 'broker') {
    return { ok: false, status: 400, message: 'لا يمكن تسجيل تفاصيل سيارات لوسيط' };
  }
  return { ok: true, owner };
}

function makeJsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    async text() { return JSON.stringify(body); },
    async json() { return body; },
  };
}

globalThis.fetch = async function mockFetch(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const parsedUrl = new URL(url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const searchParams = parsedUrl.searchParams;
  const body = options.body ? JSON.parse(options.body) : {};

  dbState.apiCallLog.push({ method, pathname, query: Object.fromEntries(searchParams.entries()), body });

  // ── Vehicle Owners endpoints ──
  if (pathname.endsWith('/entities/vehicleOwners/list.php')) {
    let rows = dbState.vehicle_owners.filter(
      o => o.username === currentAuthUsername && o.deleted_at === null
    );
    const nameFilter = searchParams.get('name');
    const typeFilter = searchParams.get('owner_type');
    if (nameFilter) rows = rows.filter(o => o.name === nameFilter);
    if (typeFilter) rows = rows.filter(o => o.owner_type === typeFilter);
    return makeJsonResponse(200, { success: true, data: rows.map(r => ({ ...r })) });
  }

  if (pathname.endsWith('/entities/vehicleOwners/get.php')) {
    const id = Number(searchParams.get('id'));
    const owner = dbState.vehicle_owners.find(o => Number(o.id) === id && o.deleted_at === null);
    if (!owner) return makeJsonResponse(404, { success: false, message: 'السجل غير موجود' });
    if (owner.username !== currentAuthUsername) return makeJsonResponse(403, { success: false, message: 'غير مسموح' });
    return makeJsonResponse(200, { success: true, data: { ...owner } });
  }

  if (pathname.endsWith('/entities/vehicleOwners/create.php')) {
    const newOwner = {
      id: nextOwnerId++,
      uuid: `owner-uuid-${nextOwnerId}`,
      username: currentAuthUsername,
      name: String(body.name || '').trim(),
      phone: body.phone || null,
      owner_type: body.owner_type || 'owner',
      notes: body.notes || null,
      deleted_at: null,
      created_at: '2026-11-02 10:00:00',
      updated_at: '2026-11-02 10:00:00',
    };
    dbState.vehicle_owners.unshift(newOwner);
    dbState.data_versions.vehicle_owners++;
    return makeJsonResponse(200, { success: true, data: { ...newOwner } });
  }

  // ── Vehicle Details Movements endpoints ──
  if (pathname.endsWith('/entities/vehicle-details/list.php')) {
    const ownerId = Number(searchParams.get('owner_id') || 0);
    const fromDate = searchParams.get('from_date') || searchParams.get('from') || '';
    const toDate = searchParams.get('to_date') || searchParams.get('to') || '';

    if (ownerId > 0) {
      const check = validateEligibleOwnerBackend(ownerId, currentAuthUsername);
      if (!check.ok) {
        return makeJsonResponse(check.status, { success: false, message: check.message });
      }
      let rows = dbState.vehicle_details_movements.filter(
        m => m.owner_id === ownerId && m.username === currentAuthUsername && m.deleted_at === null
      );
      if (fromDate) rows = rows.filter(m => m.movement_date >= fromDate);
      if (toDate) rows = rows.filter(m => m.movement_date <= toDate);
      return makeJsonResponse(200, { success: true, data: rows.map(r => ({ ...r })) });
    }

    const rows = dbState.vehicle_details_movements.filter(
      m => m.username === currentAuthUsername && m.deleted_at === null
    );
    return makeJsonResponse(200, { success: true, data: rows.map(r => ({ ...r })) });
  }

  if (pathname.endsWith('/entities/vehicle-details/get.php')) {
    const id = Number(searchParams.get('id') || 0);
    const rec = dbState.vehicle_details_movements.find(m => m.id === id && m.deleted_at === null);
    if (!rec) return makeJsonResponse(404, { success: false, message: 'السجل غير موجود' });
    if (rec.username !== currentAuthUsername) return makeJsonResponse(403, { success: false, message: 'غير مسموح' });
    const check = validateEligibleOwnerBackend(rec.owner_id, currentAuthUsername);
    if (!check.ok) return makeJsonResponse(check.status, { success: false, message: check.message });
    return makeJsonResponse(200, { success: true, data: { ...rec } });
  }

  if (pathname.endsWith('/entities/vehicle-details/create.php')) {
    const ownerId = Number(body.owner_id || 0);
    const check = validateEligibleOwnerBackend(ownerId, currentAuthUsername);
    if (!check.ok) {
      return makeJsonResponse(check.status, { success: false, message: check.message });
    }
    const lah = Number(body.lah ?? 0);
    const alayh = Number(body.alayh ?? 0);
    if (!Number.isFinite(lah) || lah < 0 || !Number.isFinite(alayh) || alayh < 0) {
      return makeJsonResponse(400, { success: false, message: 'قيمة له وعليه يجب أن تكون رقماً صحيحاً أكبر من أو يساوي صفر' });
    }
    const rec = {
      id: nextMovementId++,
      uuid: `vdm-uuid-${nextMovementId}`,
      owner_id: ownerId,
      username: currentAuthUsername,
      movement_date: String(body.movement_date),
      movement_time: String(body.movement_time),
      lah: Math.round(lah * 100) / 100,
      alayh: Math.round(alayh * 100) / 100,
      notes: body.notes ?? null,
      created_by: currentAuthUsername,
      updated_by: null,
      deleted_by: null,
      created_at: '2026-11-02 12:00:00',
      updated_at: '2026-11-02 12:00:00',
      deleted_at: null,
    };
    dbState.vehicle_details_movements.push(rec);
    dbState.data_versions.vehicle_details_movements++;
    return makeJsonResponse(200, { success: true, data: { ...rec } });
  }

  if (pathname.endsWith('/entities/vehicle-details/update.php')) {
    const id = Number(body.id || 0);
    const rec = dbState.vehicle_details_movements.find(m => m.id === id && m.deleted_at === null);
    if (!rec) return makeJsonResponse(404, { success: false, message: 'السجل غير موجود' });
    if (rec.username !== currentAuthUsername) return makeJsonResponse(403, { success: false, message: 'غير مسموح' });
    if (body.owner_id !== undefined && Number(body.owner_id) !== rec.owner_id) {
      return makeJsonResponse(403, { success: false, message: 'الحركة لا تتبع صاحب المركبة المحدد' });
    }
    const check = validateEligibleOwnerBackend(rec.owner_id, currentAuthUsername);
    if (!check.ok) return makeJsonResponse(check.status, { success: false, message: check.message });

    if (body.lah !== undefined) {
      const lah = Number(body.lah);
      if (!Number.isFinite(lah) || lah < 0) return makeJsonResponse(400, { success: false, message: 'قيمة غير صالحة' });
      rec.lah = Math.round(lah * 100) / 100;
    }
    if (body.alayh !== undefined) {
      const alayh = Number(body.alayh);
      if (!Number.isFinite(alayh) || alayh < 0) return makeJsonResponse(400, { success: false, message: 'قيمة غير صالحة' });
      rec.alayh = Math.round(alayh * 100) / 100;
    }
    if (body.notes !== undefined) {
      rec.notes = body.notes ? String(body.notes).trim() : null;
    }
    rec.updated_by = currentAuthUsername;
    dbState.data_versions.vehicle_details_movements++;
    return makeJsonResponse(200, { success: true, data: { ...rec } });
  }

  if (pathname.endsWith('/entities/vehicle-details/delete.php')) {
    const id = Number(body.id || 0);
    const rec = dbState.vehicle_details_movements.find(m => m.id === id && m.deleted_at === null);
    if (!rec) return makeJsonResponse(404, { success: false, message: 'السجل غير موجود' });
    if (rec.username !== currentAuthUsername) return makeJsonResponse(403, { success: false, message: 'غير مسموح' });
    if (body.owner_id !== undefined && Number(body.owner_id) !== rec.owner_id) {
      return makeJsonResponse(403, { success: false, message: 'الحركة لا تتبع صاحب المركبة المحدد' });
    }
    const check = validateEligibleOwnerBackend(rec.owner_id, currentAuthUsername);
    if (!check.ok) return makeJsonResponse(check.status, { success: false, message: check.message });

    rec.deleted_at = '2026-11-02 15:00:00';
    rec.deleted_by = currentAuthUsername;
    dbState.data_versions.vehicle_details_movements++;
    return makeJsonResponse(200, { success: true, data: null });
  }

  // ── Financial / Ledger endpoints (used only by regression assertions) ──
  if (pathname.endsWith('/entities/vehicle-ledger/list.php')) {
    const clientId = searchParams.get('client_id');
    const clientType = searchParams.get('client_type');
    let rows = dbState.vehicle_ledger.filter(
      e => e.username === currentAuthUsername && e.deleted_at === null
    );
    if (clientId) rows = rows.filter(e => String(e.client_id) === String(clientId));
    if (clientType) rows = rows.filter(e => String(e.client_type) === String(clientType));
    return makeJsonResponse(200, { success: true, data: rows.map(r => ({ ...r })) });
  }

  if (pathname.endsWith('/entities/treasury/list.php')) {
    const rows = dbState.treasury.filter(t => t.username === currentAuthUsername && t.deleted_at === null);
    return makeJsonResponse(200, { success: true, data: rows.map(r => ({ ...r })) });
  }

  if (pathname.endsWith('/entities/receipts/list.php')) {
    const rows = dbState.receipts.filter(r => r.username === currentAuthUsername && r.deleted_at === null);
    return makeJsonResponse(200, { success: true, data: rows.map(r => ({ ...r })) });
  }

  if (pathname.endsWith('/archive/list.php')) {
    return makeJsonResponse(200, { success: true, data: [] });
  }

  return makeJsonResponse(404, { success: false, message: `Unhandled mock route: ${pathname}` });
};

// Import real ES modules after environment setup
const { activateServerMode } = await import('../services/apiConfig.js');
activateServerMode();

const { getDomain } = await import('../services/domainRegistry.js');
const { VehicleDetailsRepository } = await import('../services/vehicleDetailsRepository.js');
const {
  VehicleDetailsModule,
  getEligibleVehicleOwners,
  loadVehicleDetailsOwners,
  showVehicleOwnerDetails,
  addMovementDraftRow,
  saveMovementRow,
  editMovementRow,
  deleteMovementRow,
  applyVehicleDetailsFilter,
  clearVehicleDetailsFilter,
  getFilteredMovementsForCurrentOwner,
  printVehicleOwnerMovements,
  attachVehicleDetailsPageListeners,
} = await import('../vehicleDetails.js');
const { OwnersModule } = await import('../entities.js');
const { FinancialService } = await import('../financial.js');

attachVehicleDetailsPageListeners();

// ═════════════════════════════════════════════════════════════════════════════
// 1. STATIC & ARCHITECTURAL VERIFICATION
// ═════════════════════════════════════════════════════════════════════════════

describe('1. Database Schema, Backend Endpoints, and Backup/Restore Architecture', () => {
  it('defines dedicated table vehicle_details_movements with FK to vehicle_owners and sync registration', () => {
    const sql = readKartaFile('database_vehicle_details.sql');
    assert.match(sql, /CREATE TABLE IF NOT EXISTS vehicle_details_movements/i);
    assert.match(sql, /owner_id\s+INT UNSIGNED\s+NOT NULL/i);
    assert.match(sql, /movement_date\s+DATE\s+NOT NULL/i);
    assert.match(sql, /movement_time\s+TIME\s+NOT NULL/i);
    assert.match(sql, /lah\s+DECIMAL\(12,2\)\s+NOT NULL DEFAULT 0\.00/i);
    assert.match(sql, /alayh\s+DECIMAL\(12,2\)\s+NOT NULL DEFAULT 0\.00/i);
    assert.match(sql, /FOREIGN KEY \(owner_id\) REFERENCES vehicle_owners\(id\)/i);
    assert.match(sql, /INSERT IGNORE INTO data_versions[\s\S]*'vehicle_details_movements'/i);

    const syncSql = readKartaFile('database_sync.sql');
    assert.match(syncSql, /'vehicle_details_movements'/);
  });

  it('implements VehicleDetailsMovementRepository and 5 endpoints without automatic DDL or financial coupling', () => {
    const repoPhp = readKartaFile('repositories/VehicleDetailsMovementRepository.php');
    const repoPhpWithoutComments = repoPhp.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.match(repoPhp, /class VehicleDetailsMovementRepository/);
    assert.match(repoPhp, /function validateEligibleOwner/);
    assert.doesNotMatch(repoPhpWithoutComments, /CREATE TABLE/i, 'Must not run DDL migrations during normal API requests');
    assert.doesNotMatch(repoPhpWithoutComments, /vehicle_ledger|treasury|receipts|offices/i, 'Must not reference financial tables in SQL');

    for (const ep of ['list.php', 'get.php', 'create.php', 'update.php', 'delete.php']) {
      const code = readKartaFile(`api/entities/vehicle-details/${ep}`);
      assert.match(code, /VehicleDetailsMovementRepository/);
      assert.match(code, /validateEligibleOwner/);
      assert.doesNotMatch(code, /VehicleLedgerRepository|TreasuryRepository|ReceiptRepository|OfficeRepository/);
    }
  });

  it('registers vehicle_details_movements in BackupRepository after vehicle_owners and excludes archive workflows', () => {
    const backupPhp = readKartaFile('repositories/BackupRepository.php');
    const ownersIdx = backupPhp.indexOf("'vehicle_owners'");
    const detailsIdx = backupPhp.indexOf("'vehicle_details_movements'");
    const vehiclesIdx = backupPhp.indexOf("'vehicles'");
    assert.ok(ownersIdx > 0 && detailsIdx > ownersIdx && detailsIdx < vehiclesIdx,
      'vehicle_details_movements must appear after vehicle_owners in BackupRepository::TABLE_ORDER');

    const restorePhp = readKartaFile('api/backup/restore.php');
    assert.match(restorePhp, /'vehicle_details_movements'/);

    const archivePhp = readKartaFile('repositories/ArchiveRepository.php');
    assert.doesNotMatch(archivePhp, /vehicle_details_movements/);
  });

  it('registers vehicleDetailsMovements in domainRegistry, syncService, index.html, and app.js', () => {
    const domain = getDomain('vehicleDetailsMovements');
    assert.ok(domain, 'vehicleDetailsMovements must be registered in domainRegistry');
    assert.equal(domain.owner, 'SERVER');
    assert.equal(domain.transport, 'MYSQL');
    assert.equal(domain.criticality, 'NORMAL');
    assert.equal(domain.apiPath, '/entities/vehicle-details');

    const syncCode = readKartaFile('services/syncService.js');
    assert.match(syncCode, /vehicle_details_movements:\s*'vehicleDetails:changed'/);

    const indexHtml = readKartaFile('index.html');
    assert.match(indexHtml, /data-page="vehicleDetailsPage"/);
    assert.match(indexHtml, /تفاصيل السيارات/);
    assert.match(indexHtml, /id="vehicleDetailsPage"/);
    assert.match(indexHtml, /id="vehicleOwnerDetailsPage"/);

    const appJs = readKartaFile('app.js');
    assert.match(appJs, /vehicleDetailsPage:\s*'vehicleDetailsPage'/);
    assert.match(appJs, /vehicleOwnerDetailsPage:\s*'vehicleOwnerDetailsPage'/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. FUNCTIONAL & BEHAVIORAL VERIFICATION (SCENARIOS 1–12)
// ═════════════════════════════════════════════════════════════════════════════

describe('2. Vehicle Details Functional Scenarios (1–12)', () => {
  it('Scenario 1: Main page displays eligible active vehicle owners only (excludes brokers, deleted, and other users) without querying balances', async () => {
    resetDbState();
    const owners = await loadVehicleDetailsOwners();

    assert.equal(owners.length, 2);
    assert.deepEqual(owners, [
      { id: '1', name: 'أحمد جلال' },
      { id: '2', name: 'محمود السيد' },
    ]);

    // Ensure only id and name exist on returned owner objects
    for (const o of owners) {
      assert.deepEqual(Object.keys(o), ['id', 'name']);
    }

    // Verify DOM rows on #vehicleDetailsPage
    const rows = document.querySelectorAll('#vdOwnersTableBody tr');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].cells[0].textContent, 'أحمد جلال');
    assert.equal(rows[1].cells[0].textContent, 'محمود السيد');

    // Verify zero financial API calls were made when loading the main page
    const financialCalls = dbState.apiCallLog.filter(c =>
      c.pathname.includes('vehicle-ledger') ||
      c.pathname.includes('treasury') ||
      c.pathname.includes('receipts') ||
      c.pathname.includes('client-karta-counts')
    );
    assert.equal(financialCalls.length, 0, 'Main page must not make any financial or balance API calls');
  });

  it('Scenario 2: Newly added vehicle owners appear automatically via owners:changed without manual registration', async () => {
    resetDbState();
    await loadVehicleDetailsOwners();
    assert.equal(document.querySelectorAll('#vdOwnersTableBody tr').length, 2);

    // Create a new owner through the existing OwnersModule
    const created = await OwnersModule.createOwner('admin', {
      name: 'إبراهيم حسن',
      phone: '01099999999',
    });
    assert.ok(created?.id);

    // Wait a microtask tick for the async owners:changed listener to complete
    await new Promise(r => setTimeout(r, 20));

    const rowsAfter = document.querySelectorAll('#vdOwnersTableBody tr');
    assert.equal(rowsAfter.length, 3);
    const names = rowsAfter.map(r => r.cells[0].textContent);
    assert.ok(names.includes('إبراهيم حسن'), 'Newly created owner must appear automatically');
  });

  it('Scenario 3: Clicking an owner opens that owner details page, highlights sidebar item, and renders الحركات tab with exact 6 columns', async () => {
    resetDbState();
    await window.showPage('vehicleDetailsPage');
    await loadVehicleDetailsOwners();

    const owner = await showVehicleOwnerDetails('1');
    assert.equal(owner.id, '1');
    assert.equal(owner.name, 'أحمد جلال');

    // Page visibility & sidebar active state
    const detailsPage = document.getElementById('vehicleOwnerDetailsPage');
    assert.equal(detailsPage.classList.contains('hidden'), false);
    const vdSidebar = document.getElementById('sidebar_vehicleDetailsPage');
    assert.equal(vdSidebar.classList.contains('active'), true, 'Sidebar item تفاصيل السيارات must remain highlighted on details page');

    // Header & tab
    assert.equal(document.getElementById('vdOwnerDetailsName')?.textContent, 'أحمد جلال');
    const tabBtn = document.getElementById('vdTabBtnMovements');
    assert.ok(tabBtn);
    assert.match(tabBtn.innerHTML, /الحركات/);

    // Verify exact 6 columns in table header
    const pageHtml = detailsPage.innerHTML;
    const thMatches = [...pageHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m => m[1].trim());
    assert.deepEqual(thMatches, ['التاريخ', 'الوقت', 'له', 'عليه', 'ملاحظات', 'إجراءات']);

    // Returning to main Vehicle Details list preserves selected owner context
    await window.showPage('vehicleDetailsPage');
    await loadVehicleDetailsOwners();
    const ownerRows = document.querySelectorAll('#vdOwnersTableBody tr');
    assert.equal(ownerRows[0].getAttribute('data-selected'), 'true');
  });

  it('Scenario 4 & 5: Adding a movement captures exact button-click date/time and does NOT regenerate it on save; validates amounts and stores in vehicle_details_movements', async () => {
    resetDbState();
    await showVehicleOwnerDetails('1');

    // Freeze Date to 2026-11-02 14:22:33 Africa/Cairo (12:22:33 UTC) at button click time
    const RealDate = globalThis.Date;
    const clickInstant = new RealDate('2026-11-02T12:22:33.000Z');
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) return new RealDate(clickInstant.getTime());
        return new RealDate(...args);
      }
      static now() { return clickInstant.getTime(); }
      static UTC(...args) { return RealDate.UTC(...args); }
    };

    let draft;
    try {
      draft = addMovementDraftRow();
    } finally {
      globalThis.Date = RealDate;
    }

    assert.ok(draft);
    assert.equal(draft.movement_date, '2026-11-02');
    assert.equal(draft.movement_time, '14:22:33');

    // Verify draft row in DOM has captured date and time
    const domRows = document.querySelectorAll('#vdMovementsTableBody tr');
    assert.equal(domRows.length, 1);
    assert.equal(domRows[0].cells[0].textContent, '2026-11-02');
    assert.equal(domRows[0].cells[1].textContent, '14:22:33');

    // Advance clock by 45 minutes before clicking Save
    const saveInstant = new RealDate('2026-11-02T13:07:59.000Z');
    globalThis.Date = class extends RealDate {
      constructor(...args) {
        if (args.length === 0) return new RealDate(saveInstant.getTime());
        return new RealDate(...args);
      }
      static now() { return saveInstant.getTime(); }
      static UTC(...args) { return RealDate.UTC(...args); }
    };

    let saved;
    try {
      // Populate manual fields in the draft row
      domRows[0].querySelector('.vd-input-lah').value = '350.5';
      domRows[0].querySelector('.vd-input-alayh').value = '';
      domRows[0].querySelector('.vd-input-notes').value = 'نقلة أسمنت';

      saved = await saveMovementRow({ draftId: draft.draftId, tr: domRows[0] });
    } finally {
      globalThis.Date = RealDate;
    }

    assert.ok(saved);
    assert.equal(saved.owner_id, 1);
    assert.equal(saved.movement_date, '2026-11-02', 'Must preserve click-time movement_date');
    assert.equal(saved.movement_time, '14:22:33', 'Must preserve click-time movement_time');
    assert.equal(saved.lah, 350.5);
    assert.equal(saved.alayh, 0);
    assert.equal(saved.notes, 'نقلة أسمنت');

    // Verify saved row renders formatted amounts and all 3 required action buttons (حفظ، تعديل، حذف)
    const savedRows = document.querySelectorAll('#vdMovementsTableBody tr');
    assert.equal(savedRows.length, 1);
    assert.equal(savedRows[0].cells[0].textContent, '2026-11-02');
    assert.equal(savedRows[0].cells[1].textContent, '14:22:33');
    assert.equal(savedRows[0].cells[2].textContent, '350.50');
    assert.equal(savedRows[0].cells[3].textContent, '0.00');
    assert.equal(savedRows[0].cells[4].textContent, 'نقلة أسمنت');
    const actionLabels = savedRows[0].buttons.map(b => b.textContent);
    assert.deepEqual(actionLabels, ['حفظ', 'تعديل', 'حذف']);
  });

  it('Scenario 6: Editing a saved movement updates only that movement and preserves its original date and time', async () => {
    resetDbState();
    await showVehicleOwnerDetails('1');

    // Seed two movements for owner 1
    const m1 = await VehicleDetailsRepository.create({
      owner_id: 1,
      movement_date: '2026-11-01',
      movement_time: '09:15:00',
      lah: 100,
      alayh: 0,
      notes: 'حركة أولى',
    });
    const m2 = await VehicleDetailsRepository.create({
      owner_id: 1,
      movement_date: '2026-11-02',
      movement_time: '11:45:10',
      lah: 0,
      alayh: 250,
      notes: 'حركة ثانية',
    });
    await showVehicleOwnerDetails('1');

    // Enter edit mode for m1
    const entered = editMovementRow(m1.id);
    assert.equal(entered, true);

    const rows = document.querySelectorAll('#vdMovementsTableBody tr');
    const editingRow = rows.find(r => String(r.dataset.id) === String(m1.id));
    assert.ok(editingRow);
    assert.equal(editingRow.dataset.rowMode, 'editing');

    // Modify manual fields
    editingRow.querySelector('.vd-input-lah').value = '175.75';
    editingRow.querySelector('.vd-input-alayh').value = '25.25';
    editingRow.querySelector('.vd-input-notes').value = 'حركة أولى معدلة';

    const updated = await saveMovementRow({ id: m1.id, tr: editingRow });
    assert.ok(updated);
    assert.equal(updated.id, m1.id);
    assert.equal(updated.movement_date, '2026-11-01', 'Original movement_date must not change on edit');
    assert.equal(updated.movement_time, '09:15:00', 'Original movement_time must not change on edit');
    assert.equal(updated.lah, 175.75);
    assert.equal(updated.alayh, 25.25);
    assert.equal(updated.notes, 'حركة أولى معدلة');

    // Verify m2 remained completely untouched
    const m2Check = await VehicleDetailsRepository.getById(m2.id);
    assert.equal(m2Check.lah, 0);
    assert.equal(m2Check.alayh, 250);
    assert.equal(m2Check.notes, 'حركة ثانية');
  });

  it('Scenario 7: Deleting a movement soft-deletes only that movement and never affects its vehicle owner', async () => {
    resetDbState();
    await showVehicleOwnerDetails('1');

    const m1 = await VehicleDetailsRepository.create({
      owner_id: 1,
      movement_date: '2026-11-02',
      movement_time: '10:00:00',
      lah: 500,
      alayh: 0,
      notes: 'للحذف',
    });
    await showVehicleOwnerDetails('1');
    assert.equal(getFilteredMovementsForCurrentOwner().length, 1);

    const deleted = await deleteMovementRow({ id: m1.id });
    assert.equal(deleted, true);
    assert.equal(getFilteredMovementsForCurrentOwner().length, 0);

    // Owner 1 must still exist and remain active in vehicle_owners and on the main page
    const eligible = await getEligibleVehicleOwners();
    assert.ok(eligible.some(o => o.id === '1' && o.name === 'أحمد جلال'),
      'Deleting a movement must never delete or modify its vehicle owner');
  });

  it('Scenario 8, 9 & 10: Search, Date-Range Filtering, Combined Filters, Clear Reset, and Printing (excluding إجراءات column)', async () => {
    resetDbState();
    await VehicleDetailsRepository.create({
      owner_id: 1,
      movement_date: '2026-10-25',
      movement_time: '08:00:00',
      lah: 100,
      alayh: 0,
      notes: 'نقلة رمل أكتوبر',
    });
    await VehicleDetailsRepository.create({
      owner_id: 1,
      movement_date: '2026-11-01',
      movement_time: '12:30:00',
      lah: 400,
      alayh: 50,
      notes: 'نقلة حديد نوفمبر',
    });
    await VehicleDetailsRepository.create({
      owner_id: 1,
      movement_date: '2026-11-02',
      movement_time: '16:15:00',
      lah: 0,
      alayh: 300,
      notes: 'صيانة إطارات نوفمبر',
    });

    await showVehicleOwnerDetails('1');
    assert.equal(getFilteredMovementsForCurrentOwner().length, 3);

    // 8. Search only
    applyVehicleDetailsFilter({ search: 'حديد', fromDate: '', toDate: '' });
    let filtered = getFilteredMovementsForCurrentOwner();
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].notes, 'نقلة حديد نوفمبر');

    // 9. Date-range only
    applyVehicleDetailsFilter({ search: '', fromDate: '2026-11-01', toDate: '2026-11-02' });
    filtered = getFilteredMovementsForCurrentOwner();
    assert.equal(filtered.length, 2);

    // Combined search + date-range filter
    applyVehicleDetailsFilter({ search: 'صيانة', fromDate: '2026-11-01', toDate: '2026-11-02' });
    filtered = getFilteredMovementsForCurrentOwner();
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].notes, 'صيانة إطارات نوفمبر');

    // 10. Print respects active filters and excludes إجراءات column
    printedDocuments.length = 0;
    const printHtml = printVehicleOwnerMovements();
    assert.ok(printHtml.length > 0);
    assert.equal(printedDocuments.length, 1);
    assert.match(printHtml, /أحمد جلال/, 'Printed report must include vehicle owner name');
    assert.match(printHtml, /2026-11-01/, 'Printed report must include selected start date');
    assert.match(printHtml, /2026-11-02/, 'Printed report must include selected end date');
    assert.match(printHtml, /صيانة إطارات نوفمبر/, 'Printed report must include matching movement');
    assert.doesNotMatch(printHtml, /نقلة رمل أكتوبر/, 'Printed report must exclude movements outside filter');
    assert.doesNotMatch(printHtml, /نقلة حديد نوفمبر/, 'Printed report must exclude movements not matching search');

    const printHeaders = [...printHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map(m => m[1].trim());
    assert.deepEqual(printHeaders, ['التاريخ', 'الوقت', 'له', 'عليه', 'ملاحظات']);
    assert.doesNotMatch(printHtml, /إجراءات/, 'Printed report must NOT include إجراءات column');

    // Clear filters restores all 3 movements
    clearVehicleDetailsFilter();
    assert.equal(getFilteredMovementsForCurrentOwner().length, 3);
  });

  it('Scenario 11 & 12: Movements belonging to different owners remain separated, and user-scope / broker validation blocks unauthorized access', async () => {
    resetDbState();
    await VehicleDetailsRepository.create({
      owner_id: 1,
      movement_date: '2026-11-02',
      movement_time: '10:00:00',
      lah: 700,
      alayh: 0,
      notes: 'حركة خاصة بأحمد جلال',
    });
    await VehicleDetailsRepository.create({
      owner_id: 2,
      movement_date: '2026-11-02',
      movement_time: '11:00:00',
      lah: 0,
      alayh: 900,
      notes: 'حركة خاصة بمحمود السيد',
    });

    await showVehicleOwnerDetails('1');
    const owner1Movements = getFilteredMovementsForCurrentOwner();
    assert.equal(owner1Movements.length, 1);
    assert.equal(owner1Movements[0].notes, 'حركة خاصة بأحمد جلال');

    await showVehicleOwnerDetails('2');
    const owner2Movements = getFilteredMovementsForCurrentOwner();
    assert.equal(owner2Movements.length, 1);
    assert.equal(owner2Movements[0].notes, 'حركة خاصة بمحمود السيد');

    // Attempt to create movement for broker (owner_id = 3) must fail
    await assert.rejects(
      () => VehicleDetailsRepository.create({
        owner_id: 3,
        movement_date: '2026-11-02',
        movement_time: '12:00:00',
        lah: 100,
        alayh: 0,
      }),
      /وسيط/
    );

    // Attempt to create movement for another user's owner (owner_id = 5) must fail with 403
    await assert.rejects(
      () => VehicleDetailsRepository.create({
        owner_id: 5,
        movement_date: '2026-11-02',
        movement_time: '12:00:00',
        lah: 100,
        alayh: 0,
      }),
      /غير مسموح/
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. MOST IMPORTANT REGRESSION TEST: ZERO FINANCIAL IMPACT
// ═════════════════════════════════════════════════════════════════════════════

describe('3. Critical Regression Test: Zero Impact on Existing Financial Records & Balances', () => {
  it('creating, editing, and deleting Vehicle Details movements does NOT change any owner balance, statement, ledger, treasury, receipt, or office record', async () => {
    resetDbState();

    // Capture full financial snapshot BEFORE any Vehicle Details operations
    const owner1BalanceBefore = await FinancialService.getClientBalance('1', 'owner');
    const owner2BalanceBefore = await FinancialService.getClientBalance('2', 'owner');
    const owner1LedgerBefore = await FinancialService.getClientLedger('1', 'owner');
    const owner2LedgerBefore = await FinancialService.getClientLedger('2', 'owner');
    const ledgerSnapshotBefore = JSON.stringify(dbState.vehicle_ledger);
    const treasurySnapshotBefore = JSON.stringify(dbState.treasury);
    const receiptsSnapshotBefore = JSON.stringify(dbState.receipts);
    const officesSnapshotBefore = JSON.stringify(dbState.offices);
    const ownersSnapshotBefore = JSON.stringify(dbState.vehicle_owners);

    const firedFinancialEvents = [];
    for (const evt of ['receipts:changed', 'treasury:changed', 'offices:changed', 'capital:changed', 'owners:changed']) {
      window.addEventListener(evt, () => firedFinancialEvents.push(evt));
    }

    // Perform full lifecycle on Vehicle Details page for Owner 1 and Owner 2:
    // 1. Open Owner 1 details, add draft row, save movement
    await showVehicleOwnerDetails('1');
    const draft1 = addMovementDraftRow();
    const domRows1 = document.querySelectorAll('#vdMovementsTableBody tr');
    domRows1[0].querySelector('.vd-input-lah').value = '5000.00';
    domRows1[0].querySelector('.vd-input-alayh').value = '1250.50';
    domRows1[0].querySelector('.vd-input-notes').value = 'اختبار عزل مالي كامل';
    const created1 = await saveMovementRow({ draftId: draft1.draftId, tr: domRows1[0] });
    assert.ok(created1?.id);

    // 2. Edit the saved movement
    editMovementRow(created1.id);
    const editRows = document.querySelectorAll('#vdMovementsTableBody tr');
    editRows[0].querySelector('.vd-input-lah').value = '9999.99';
    editRows[0].querySelector('.vd-input-alayh').value = '4444.44';
    editRows[0].querySelector('.vd-input-notes').value = 'تعديل حركة بدون أي أثر مالي';
    const updated1 = await saveMovementRow({ id: created1.id, tr: editRows[0] });
    assert.equal(updated1.lah, 9999.99);

    // 3. Delete the movement
    const delResult = await deleteMovementRow({ id: created1.id });
    assert.equal(delResult, true);

    // Capture full financial snapshot AFTER all Vehicle Details operations
    const owner1BalanceAfter = await FinancialService.getClientBalance('1', 'owner');
    const owner2BalanceAfter = await FinancialService.getClientBalance('2', 'owner');
    const owner1LedgerAfter = await FinancialService.getClientLedger('1', 'owner');
    const owner2LedgerAfter = await FinancialService.getClientLedger('2', 'owner');

    // Assert ZERO changes across every financial entity and calculation
    assert.deepEqual(owner1BalanceAfter, owner1BalanceBefore, 'Owner 1 balance must remain identical');
    assert.deepEqual(owner2BalanceAfter, owner2BalanceBefore, 'Owner 2 balance must remain identical');
    assert.deepEqual(owner1LedgerAfter, owner1LedgerBefore, 'Owner 1 account statement must remain identical');
    assert.deepEqual(owner2LedgerAfter, owner2LedgerBefore, 'Owner 2 account statement must remain identical');
    assert.equal(JSON.stringify(dbState.vehicle_ledger), ledgerSnapshotBefore, 'vehicle_ledger records must remain untouched');
    assert.equal(JSON.stringify(dbState.treasury), treasurySnapshotBefore, 'treasury records must remain untouched');
    assert.equal(JSON.stringify(dbState.receipts), receiptsSnapshotBefore, 'receipts records must remain untouched');
    assert.equal(JSON.stringify(dbState.offices), officesSnapshotBefore, 'offices records must remain untouched');
    assert.equal(JSON.stringify(dbState.vehicle_owners), ownersSnapshotBefore, 'vehicle_owners records must remain untouched');
    assert.deepEqual(firedFinancialEvents, [], 'No financial refresh events may be triggered by Vehicle Details operations');
  });
});
