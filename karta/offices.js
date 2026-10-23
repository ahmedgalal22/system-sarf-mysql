/**
 * offices.js — consolidated module
 * Internal structure: Constants → State → Services → Helpers → Rendering → Events → Public API → Boot
 */

import { FinancialService } from './financial.js';
import { AuthModule } from './auth.js';
import { Money } from './money.js';
import { DateUtils } from './dateUtils.js';
import { calculateRowNet, calculateWeightTotal } from './services/financialCalculator.js';
import { OfficeRepository } from './services/officeRepository.js';
import { ApiClient } from './services/apiClient.js';
import { generateId as _uuid } from './utils/idGenerator.js';


// ========================================
// Services — OfficesService
// ========================================

const STORE = 'offices';
const RECEIPTS_STORE = 'receipts';

const _hamolaCache = new Map();

function _cacheKey(username, officeId) {
  return `${username}::${officeId}`;
}

// _uuid imported from utils/idGenerator.js

function _requireUsername(username, ctx) {
  if (!username) throw new Error(`[OfficesService:${ctx}] username is required.`);
  return username;
}

function _toText(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function _requireText(value, label) {
  const text = _toText(value).trim();
  if (!text) throw new Error(`[OfficesService] ${label} is required.`);
  return text;
}

function _optionalText(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function _requireNumber(value, label) {
  if (value === undefined || value === null) {
    throw new Error(`[OfficesService] ${label} is required.`);
  }
  if (typeof value === 'string' && value.trim() === '') {
    throw new Error(`[OfficesService] ${label} is required.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`[OfficesService] ${label} must be a number.`);
  }
  return n;
}

function _normalizeHamolaRow(input, keepId = false) {
  if (!input || typeof input !== 'object') {
    throw new Error('[OfficesService] hamola row must be a plain object.');
  }

  const loading_place = _requireText(
    input.loading_place ?? input.loading,
    'loading_place'
  );
  const destination_place = _requireText(
    input.destination_place ?? input.direction ?? input.taktik,
    'destination_place'
  );
  const nolon = _requireNumber(input.nolon ?? input.noloon, 'nolon');
  const office_amount = Number(input.office_amount ?? input.maktab ?? 0) || 0;
  const item_type = _optionalText(input.item_type ?? input.type) || null;
  const price = Number(input.price ?? 0) || 0;

  return {
    id: keepId && input.id ? String(input.id) : _uuid(),
    loading_place,
    destination_place,
    nolon,
    office_amount,
    item_type,
    price,
  };
}

function _applyHamolaPatch(existing, patch) {
  const next = { ...existing };

  if ('loading_place' in patch || 'loading' in patch) {
    next.loading_place = _requireText(
      patch.loading_place ?? patch.loading,
      'loading_place'
    );
  }
  if ('destination_place' in patch || 'direction' in patch || 'taktik' in patch) {
    next.destination_place = _requireText(
      patch.destination_place ?? patch.direction ?? patch.taktik,
      'destination_place'
    );
  }
  if ('price' in patch) {
    next.price = Number(patch.price ?? 0) || 0;
  }
  if ('nolon' in patch || 'noloon' in patch) {
    next.nolon = _requireNumber(patch.nolon ?? patch.noloon, 'nolon');
  }
  if ('office_amount' in patch || 'maktab' in patch) {
    next.office_amount = Number(patch.office_amount ?? patch.maktab ?? 0) || 0;
  }
  if ('item_type' in patch || 'type' in patch) {
    next.item_type = _optionalText(patch.item_type ?? patch.type) || null;
  }

  return next;
}

function _normalizeOffice(office) {
  const hamolaRows = Array.isArray(office?.hamolaRows)
    ? office.hamolaRows.map((row) => _normalizeHamolaRow(row, true))
    : [];

  return {
    ...office,
    hamolaRows,
  };
}

function _cacheHamola(username, officeId, rows) {
  if (!username || !officeId) return;
  _hamolaCache.set(_cacheKey(username, officeId), rows);
}

function _getCachedHamola(username, officeId) {
  return _hamolaCache.get(_cacheKey(username, officeId)) || null;
}

async function createOffices(username, rows) {
  _requireUsername(username, 'createOffices');
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('[OfficesService] rows must be a non-empty array.');
  }

  const existing = await OfficeRepository.getAll(username);
  const existingNames = new Set(
    existing.map((o) => String(o.name || '').trim().toLowerCase()).filter(Boolean)
  );

  const seen = new Set();
  const payloads = rows.map((row) => {
    if (!row || typeof row !== 'object') {
      throw new Error('[OfficesService] office row must be a plain object.');
    }

    const name = _requireText(row.name, 'name');
    const lower = name.toLowerCase();

    if (existingNames.has(lower) || seen.has(lower)) {
      throw new Error(`[OfficesService] duplicate office name: ${name}`);
    }
    seen.add(lower);

    const hamolaRows = Array.isArray(row.hamolaRows)
      ? row.hamolaRows.map((r) => _normalizeHamolaRow(r, false))
      : [];

    return {
      id: _uuid(),
      username,
      name,
      phone: _optionalText(row.phone),
      hamolaRows,
    };
  });

  // Save each office via API (SERVER_OWNED domain → MySQL).
  // Sequential saves preserve order and provide clear error per office.
  const saved = [];
  for (const payload of payloads) {
    const record = await OfficeRepository.save(payload, { username });
    saved.push(record);
  }
  saved.forEach((record) => _cacheHamola(username, record.id, record.hamolaRows || []));

  window.dispatchEvent(new CustomEvent('offices:changed'));
  return saved;
}

async function updateOffice(username, id, patch) {
  _requireUsername(username, 'updateOffice');
  if (!id) throw new Error('[OfficesService:updateOffice] id is required.');
  if (!patch || typeof patch !== 'object') {
    throw new Error('[OfficesService] patch must be a plain object.');
  }

  const office = await getOfficeById(id, username);

  if ('name' in patch) {
    const name = _requireText(patch.name, 'name');
    const existing = await OfficeRepository.getAll(username);
    const dup = existing.some((o) => String(o.id) !== String(id)
      && String(o.name || '').trim().toLowerCase() === name.toLowerCase());
    if (dup) throw new Error(`[OfficesService] duplicate office name: ${name}`);
  }

  const nextPatch = {
    ...(patch.name !== undefined ? { name: _requireText(patch.name, 'name') } : {}),
    ...(patch.phone !== undefined ? { phone: _optionalText(patch.phone) } : {}),
  };

  const updated = await OfficeRepository.update(String(id), nextPatch, { username });
  _cacheHamola(username, updated.id, updated.hamolaRows || office.hamolaRows || []);
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return updated;
}

async function deleteOffice(username, id) {
  _requireUsername(username, 'deleteOffice');
  if (!id) throw new Error('[OfficesService:deleteOffice] id is required.');
  const office = await getOfficeById(id, username);
  if (!office) throw new Error('[OfficesService] office not found.');
  const deleted = await OfficeRepository.delete(String(id), { username });
  _hamolaCache.delete(_cacheKey(username, id));
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return deleted;
}

async function getOffices(username) {
  _requireUsername(username, 'getOffices');
  const offices = await OfficeRepository.getAll(username);
  const normalized = offices.map(_normalizeOffice);
  normalized.forEach((o) => _cacheHamola(username, o.id, o.hamolaRows || []));
  return normalized;
}

async function getOfficeById(id, username) {
  _requireUsername(username, 'getOfficeById');
  if (!id) throw new Error('[OfficesService:getOfficeById] id is required.');
  const office = await OfficeRepository.getById(String(id));
  if (!office || office.deleted_at !== null) return null;
  if (office.username !== username) {
    throw new Error('[OfficesService] cross-user access is forbidden.');
  }
  const normalized = _normalizeOffice(office);
  _cacheHamola(username, normalized.id, normalized.hamolaRows || []);
  return normalized;
}

export function normalizeCargoText(value) {
  if (value === undefined || value === null) return '';
  const trimmed = String(value).trim();
  if (!trimmed) return '';
  return trimmed.replace(/\s+/g, ' ');
}

export function normalizeCargoKey(value) {
  const text = normalizeCargoText(value);
  return text ? text.toLowerCase() : '';
}

export function findMissingCargoCombinations(rows, offices) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  if (!Array.isArray(offices) || offices.length === 0) return [];

  const officeByName = new Map();
  const exactByOffice = new Map();
  const routeByOffice = new Map();

  for (const o of offices) {
    if (!o || !o.id) continue;
    const oNameKey = normalizeCargoKey(o.name);
    if (!oNameKey) continue;
    const officeId = String(o.id);
    officeByName.set(oNameKey, o);

    const exactSet = new Set();
    const routeSet = new Set();
    const hamolaRows = Array.isArray(o.hamolaRows) ? o.hamolaRows : [];
    for (const h of hamolaRows) {
      if (!h) continue;
      const lKey = normalizeCargoKey(h.loading_place ?? h.loading);
      const dKey = normalizeCargoKey(h.destination_place ?? h.direction ?? h.taktik);
      const tKey = normalizeCargoKey(h.item_type ?? h.type);
      if (!lKey || !dKey) continue;
      const routeKey = `${lKey}::${dKey}`;
      routeSet.add(routeKey);
      exactSet.add(`${routeKey}::${tKey}`);
    }
    exactByOffice.set(officeId, exactSet);
    routeByOffice.set(officeId, routeSet);
  }

  const missing = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const rowType = r._type || r.row_type || 'data';
    if (rowType === 'separator') continue;

    const officeName = normalizeCargoText(r.office);
    const loading = normalizeCargoText(r.loading ?? r.loading_place);
    const destination = normalizeCargoText(r.taktik ?? r.destination_place ?? r.direction);
    const itemType = normalizeCargoText(r.type ?? r.item_type);

    if (!officeName || !loading || !destination) continue;

    const office = officeByName.get(normalizeCargoKey(officeName));
    if (!office || !office.id) continue;

    const officeId = String(office.id);
    const exactSet = exactByOffice.get(officeId);
    const routeSet = routeByOffice.get(officeId);
    if (!exactSet || !routeSet) continue;

    const loadKey = normalizeCargoKey(loading);
    const destKey = normalizeCargoKey(destination);
    const typeKey = normalizeCargoKey(itemType);
    const routeKey = `${loadKey}::${destKey}`;
    const exactKey = `${routeKey}::${typeKey}`;

    if (exactSet.has(exactKey)) continue;
    if (typeKey === '' && routeSet.has(routeKey)) continue;

    exactSet.add(exactKey);
    routeSet.add(routeKey);

    missing.push({
      office_id: office.id,
      office_name: office.name,
      loading_place: loading,
      destination_place: destination,
      item_type: itemType || null,
      nolon: 0,
      office_amount: 0,
      price: 0,
    });
  }

  return missing;
}

async function addHamolaRow(username, office_id, row) {
  _requireUsername(username, 'addHamolaRow');
  if (!office_id) throw new Error('[OfficesService:addHamolaRow] office_id is required.');

  const loading_place = normalizeCargoText(row.loading_place ?? row.loading ?? '');
  const destination_place = normalizeCargoText(row.destination_place ?? row.direction ?? row.taktik ?? '');
  const item_type = normalizeCargoText(row.item_type ?? row.type ?? '') || null;

  // Validation + UUID generation handled server-side.
  // Frontend sends business fields only — no _normalizeHamolaRow (avoids client UUID).
  const res = await ApiClient.post('/entities/hamola/create.php', {
    office_id:         Number(office_id),
    loading_place,
    destination_place,
    nolon:             Number(row.nolon ?? row.noloon ?? 0) || 0,
    office_amount:     Number(row.office_amount ?? row.maktab ?? 0) || 0,
    item_type,
    price:             Number(row.price ?? 0) || 0,
  });
  if (!res.success) throw new Error(res.message || 'فشل إضافة الحمولة');

  const cached = _getCachedHamola(username, office_id) || [];
  if (res.data) {
    const existsInCache = cached.some(
      (h) => String(h.id) === String(res.data.id)
        || (
          normalizeCargoKey(h.loading_place ?? h.loading) === normalizeCargoKey(res.data.loading_place)
          && normalizeCargoKey(h.destination_place ?? h.direction ?? h.taktik) === normalizeCargoKey(res.data.destination_place)
          && normalizeCargoKey(h.item_type ?? h.type) === normalizeCargoKey(res.data.item_type)
        )
    );
    if (!existsInCache) {
      _cacheHamola(username, office_id, [...cached, _normalizeHamolaRow(res.data, true)]);
    }
  }

  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('offices:changed'));
  }
  return res.data;
}

async function syncHamolaFromReceiptRows(username, rows, serverSyncedHamola = null) {
  _requireUsername(username, 'syncHamolaFromReceiptRows');
  if (!Array.isArray(rows) || rows.length === 0) return [];

  // When the PHP endpoint already synchronized hamola_details atomically inside
  // the receipt transaction, update local cache and notify listeners without extra API writes.
  if (Array.isArray(serverSyncedHamola)) {
    if (serverSyncedHamola.length > 0) {
      for (const rec of serverSyncedHamola) {
        if (!rec || !rec.office_id) continue;
        const oid = String(rec.office_id);
        const cached = _getCachedHamola(username, oid) || [];
        const exists = cached.some(
          (h) => String(h.id) === String(rec.id)
            || (
              normalizeCargoKey(h.loading_place ?? h.loading) === normalizeCargoKey(rec.loading_place)
              && normalizeCargoKey(h.destination_place ?? h.direction ?? h.taktik) === normalizeCargoKey(rec.destination_place)
              && normalizeCargoKey(h.item_type ?? h.type) === normalizeCargoKey(rec.item_type)
            )
        );
        if (!exists) {
          _cacheHamola(username, oid, [...cached, _normalizeHamolaRow(rec, true)]);
        }
      }
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent('offices:changed'));
      }
    }
    return serverSyncedHamola;
  }

  const offices = await getOffices(username);
  const missing = findMissingCargoCombinations(rows, offices);
  if (missing.length === 0) return [];

  const created = [];
  for (const item of missing) {
    const rec = await addHamolaRow(username, item.office_id, item);
    if (rec) created.push(rec);
  }
  return created;
}

async function updateHamolaRow(username, office_id, row_id, patch) {
  _requireUsername(username, 'updateHamolaRow');
  if (!office_id) throw new Error('[OfficesService:updateHamolaRow] office_id is required.');
  if (!row_id) throw new Error('[OfficesService:updateHamolaRow] row_id is required.');
  if (!patch || typeof patch !== 'object') {
    throw new Error('[OfficesService] patch must be a plain object.');
  }

  const payload = { id: Number(row_id) };
  if ('loading_place' in patch || 'loading' in patch) payload.loading_place = patch.loading_place ?? patch.loading;
  if ('destination_place' in patch || 'direction' in patch || 'taktik' in patch) payload.destination_place = patch.destination_place ?? patch.direction ?? patch.taktik;
  if ('nolon' in patch || 'noloon' in patch) payload.nolon = Number(patch.nolon ?? patch.noloon ?? 0);
  if ('office_amount' in patch || 'maktab' in patch) payload.office_amount = Number(patch.office_amount ?? patch.maktab ?? 0);
  if ('item_type' in patch || 'type' in patch) payload.item_type = patch.item_type ?? patch.type ?? null;
  if ('price' in patch) payload.price = Number(patch.price ?? 0);

  const res = await ApiClient.put('/entities/hamola/update.php', payload);
  if (!res.success) throw new Error(res.message || 'فشل تحديث الحمولة');
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return res.data;
}

async function deleteHamolaRow(username, office_id, row_id) {
  _requireUsername(username, 'deleteHamolaRow');
  if (!office_id) throw new Error('[OfficesService:deleteHamolaRow] office_id is required.');
  if (!row_id) throw new Error('[OfficesService:deleteHamolaRow] row_id is required.');

  const res = await ApiClient.delete('/entities/hamola/delete.php', { id: Number(row_id) });
  if (!res.success) throw new Error(res.message || 'فشل حذف الحمولة');
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return res.data;
}

// _calcWeight and _calcReceiptNet replaced by financialCalculator imports.
// Aliases kept for minimal call-site diff:
const _calcWeight = calculateWeightTotal;
const _calcReceiptNet = calculateRowNet;

function _resolveRange(filters) {
  if (!filters || typeof filters !== 'object') return null;

  const now = new Date();
  if (filters.range === 'today') {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const end = start + 24 * 60 * 60 * 1000 - 1;
    return { from: start, to: end };
  }
  if (filters.range === 'week') {
    const day = now.getDay();
    const diff = now.getDate() - day;
    const start = new Date(now.getFullYear(), now.getMonth(), diff).getTime();
    const end = start + 7 * 24 * 60 * 60 * 1000 - 1;
    return { from: start, to: end };
  }
  if (filters.range === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - 1;
    return { from: start, to: end };
  }

  const from = filters.from ? new Date(filters.from).getTime() : null;
  const to = filters.to
    ? (/^\d{4}-\d{2}-\d{2}$/.test(String(filters.to).trim())
        ? new Date(String(filters.to).trim() + 'T23:59:59.999Z').getTime()
        : new Date(filters.to).getTime())
    : null;
  if ((filters.from && Number.isNaN(from)) || (filters.to && Number.isNaN(to))) {
    throw new Error('[OfficesService] invalid date range.');
  }
  if (from == null && to == null) return null;

  return {
    from: from ?? 0,
    to: to ?? Date.now(),
  };
}

async function getOfficeFinancialSummary(username, filters = null) {
  _requireUsername(username, 'getOfficeFinancialSummary');

  const offices = await getOffices(username);
  const nameMap = new Map(
    offices.map((o) => [String(o.name || '').trim().toLowerCase(), o])
  );

  const summary = new Map();
  for (const office of offices) {
    summary.set(String(office.id), {
      office,
      net: 0,
      weight: 0,
      balance: 0,
    });
  }

  const range = _resolveRange(filters);

  if (range) {
    const receipts = await OfficeRepository.getReceipts(username);
    const filtered = receipts.filter((r) => {
      if (r.deleted_at != null || r.is_archived) return false;
      const rawDate = r.receipt_date || r.date || r.created_at || 0;
      const t = new Date(rawDate).getTime();
      return t >= range.from && t <= range.to;
    });

    for (const receipt of filtered) {
      const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
      for (const row of rows) {
        if (row?._type === 'separator' || row?.type === 'separator' || row?.row_type === 'separator') continue;
        const officeName = String(row.office || '').trim();
        if (!officeName) continue;
        const office = nameMap.get(officeName.toLowerCase());
        if (!office) continue;
        const item = summary.get(String(office.id));
        item.weight += _calcWeight(row);
        item.net += _calcReceiptNet(row);
      }
    }
  } else {
    // Server-side aggregation — replaces loading ALL receipts (2MB+) client-side
    try {
      const statsRes = await ApiClient.get('/stats/office-summary.php');
      if (statsRes.success && Array.isArray(statsRes.data)) {
        for (const s of statsRes.data) {
          const key = String(s.name || '').trim().toLowerCase();
          const office = nameMap.get(key);
          if (office) {
            const item = summary.get(String(office.id));
            item.weight += Number(s.weight) || 0;
            item.net += Number(s.net) || 0;
          }
        }
      }
    } catch (e) {
      // Fallback: load receipts client-side (legacy path)
      console.warn('[offices] Server stats failed, using client fallback:', e.message);
      const receipts = await OfficeRepository.getReceipts(username);
      for (const receipt of receipts) {
        const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
        for (const row of rows) {
          if (row?._type === 'separator') continue;
          const officeName = String(row.office || '').trim();
          if (!officeName) continue;
          const office = nameMap.get(officeName.toLowerCase());
          if (!office) continue;
          const item = summary.get(String(office.id));
          item.weight += _calcWeight(row);
          item.net += _calcReceiptNet(row);
        }
      }
    }
  }

  const rows = Array.from(summary.values());
  const balances = await Promise.all(
    rows.map((item) => FinancialService.getClientBalance(item.office.id, 'office'))
  );
  rows.forEach((item, idx) => {
    const snap = balances[idx];
    if (!snap) {
      throw new Error('[OfficesService] balance lookup failed.');
    }
    item.balance = snap.balance;
  });

  const totals = rows.reduce(
    (acc, item) => {
      acc.total_net += item.net;
      acc.total_weight += item.weight;
      return acc;
    },
    { total_net: 0, total_weight: 0 }
  );

  return {
    total_offices: rows.length,
    total_net: totals.total_net,
    total_weight: totals.total_weight,
    rows,
  };
}

function _isOpaqueReferenceString(value) {
  const s = String(value || '').trim();
  if (!s) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(s)) return true;
  if (/^id_[a-z0-9_]+$/i.test(s)) return true;
  if (/^Receipt\s+\S+/i.test(s)) return true;
  return false;
}

function _cleanMovementNote(note) {
  const s = String(note || '').trim();
  if (!s || _isOpaqueReferenceString(s)) return '';
  const boilerplate = new Set([
    'إيداع رصيد',
    'سحب رصيد',
    'إضافة رصيد',
    'خصم من الرصيد',
    'إيداع مكتب',
    'سحب مكتب',
    'إيداع شركة',
    'سحب شركة',
  ]);
  if (boilerplate.has(s)) return '';
  return s;
}

function _extractReadableDocumentNumber(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const candidates = [entry.reference_number, entry.receipt_number];
  for (const c of candidates) {
    const val = String(c ?? '').trim();
    if (val && !_isOpaqueReferenceString(val)) {
      return val;
    }
  }
  const note = String(entry.note || '').trim();
  const match = note.match(/^(?:صرف نموذج|نموذج رقم|إذن رقم|إذن صرف رقم)\s+([^\s—-]+)/);
  if (match && match[1] && !_isOpaqueReferenceString(match[1])) {
    return match[1];
  }
  return null;
}

export function formatMovementTypeLabel(entry) {
  if (!entry || typeof entry !== 'object') return 'حركة مالية';
  const type = String(entry.type || '').trim();
  const refType = String(entry.reference_type || '').trim();
  const effect = String(entry.effect || '').trim();

  if (entry.is_reversed || ['reversal', 'cancel', 'refund', 'void'].includes(type) || ['reversal', 'cancel', 'refund', 'void'].includes(refType)) {
    return 'مرتجع / إلغاء';
  }
  if (['opening_balance', 'initial_balance'].includes(type) || ['opening_balance', 'initial_balance'].includes(refType)) {
    return 'رصيد افتتاحي';
  }
  if (['adjustment', 'settlement', 'balance_adjustment'].includes(type) || ['adjustment', 'settlement', 'balance_adjustment', 'receipt_adjustment'].includes(refType) || effect === 'adjustment') {
    return 'تسوية رصيد';
  }
  if (type === 'receipt_due' || effect === 'receipt_due') return 'مستحق إذن صرف';
  if (type === 'receipt_payment' || effect === 'receipt_payout') return 'صرف إذن';
  if (type === 'OFFICE_DEPOSIT' && Number(entry.amount) < 0) return 'سحب';
  if (type === 'OFFICE_DEPOSIT' || type === 'deposit') return 'إيداع';
  if (type === 'OFFICE_WITHDRAW_AUTO' || type === 'withdraw') return 'سحب';
  return 'حركة مالية';
}

export function formatMovementReference(entry) {
  if (!entry || typeof entry !== 'object') return 'حركة مالية';
  const type = String(entry.type || '').trim();
  const refType = String(entry.reference_type || '').trim();
  const effect = String(entry.effect || '').trim();
  const rawNote = String(entry.note || '').trim();
  const cleanNote = _cleanMovementNote(rawNote);
  const docNum = _extractReadableDocumentNumber(entry);

  // 1. Reversed / cancelled / refunded movements
  if (
    entry.is_reversed ||
    ['reversal', 'cancel', 'refund', 'void'].includes(type) ||
    ['reversal', 'cancel', 'refund', 'void'].includes(refType) ||
    ['reversal', 'cancel', 'refund', 'void'].includes(effect)
  ) {
    if (docNum) return `مرتجع أو إلغاء عملية — إذن صرف رقم ${docNum}`;
    if (cleanNote) return `مرتجع أو إلغاء عملية — ${cleanNote}`;
    return 'مرتجع أو إلغاء عملية';
  }

  // 2. Opening / initial balance
  if (
    ['opening_balance', 'initial_balance'].includes(type) ||
    ['opening_balance', 'initial_balance'].includes(refType) ||
    ['opening_balance', 'initial_balance'].includes(effect) ||
    rawNote === 'رصيد افتتاحي'
  ) {
    if (cleanNote && cleanNote !== 'رصيد افتتاحي') return `رصيد افتتاحي — ${cleanNote}`;
    return 'رصيد افتتاحي';
  }

  // 3. Movements linked to a disbursement receipt
  if (
    refType === 'receipt' ||
    type === 'receipt_due' ||
    type === 'receipt_payment' ||
    effect === 'receipt_due' ||
    effect === 'receipt_payout'
  ) {
    const base = docNum ? `حركة مرتبطة بإذن صرف رقم ${docNum}` : 'حركة مرتبطة بإذن صرف';
    if (type === 'receipt_due' || effect === 'receipt_due') {
      return `${base} (صافي مستحق)`;
    }
    if (type === 'receipt_payment' || effect === 'receipt_payout') {
      return `${base} (صرف مستحق)`;
    }
    if (type === 'OFFICE_WITHDRAW_AUTO' || type === 'withdraw') {
      return `${base} (خصم من الرصيد)`;
    }
    return base;
  }

  // 4. Balance adjustments / settlements
  if (
    refType === 'receipt_adjustment' ||
    ['adjustment', 'settlement', 'balance_adjustment'].includes(type) ||
    ['adjustment', 'settlement', 'balance_adjustment'].includes(refType) ||
    effect === 'adjustment'
  ) {
    if (docNum) return `تسوية رصيد — إذن صرف رقم ${docNum}`;
    if (cleanNote) return `تسوية رصيد — ${cleanNote}`;
    return 'تسوية رصيد';
  }

  // 5. Salfa / advance
  if (refType === 'salfa' || type === 'salfa' || effect === 'salfa') {
    if (cleanNote) return `سلفة مالية — ${cleanNote}`;
    return 'سلفة مالية';
  }

  // 6. Office auto-withdrawal / balance deduction
  if (
    type === 'OFFICE_WITHDRAW_AUTO' ||
    refType === 'office_withdraw' ||
    type === 'withdraw' ||
    (type === 'OFFICE_DEPOSIT' && Number(entry.amount) < 0)
  ) {
    if (docNum) return `خصم من الرصيد — إذن صرف رقم ${docNum}`;
    if (cleanNote) return `خصم من الرصيد — ${cleanNote}`;
    return 'خصم من الرصيد';
  }

  // 7. Office deposit / balance addition
  if (
    type === 'OFFICE_DEPOSIT' ||
    refType === 'office_deposit' ||
    type === 'deposit'
  ) {
    if (docNum) return `إضافة رصيد — إذن صرف رقم ${docNum}`;
    if (cleanNote) return `إضافة رصيد — ${cleanNote}`;
    return 'إضافة رصيد';
  }

  // 8. Safe Arabic fallback for historical or unknown types
  if (cleanNote) return `حركة مالية — ${cleanNote}`;
  const amt = Number(entry.amount) || 0;
  if (amt > 0) return 'إضافة رصيد';
  if (amt < 0) return 'خصم من الرصيد';
  return 'حركة مالية';
}

async function getOfficeLedger(username, office_id) {
  _requireUsername(username, 'getOfficeLedger');
  if (!office_id) throw new Error('[OfficesService:getOfficeLedger] office_id is required.');
  const office = await getOfficeById(office_id, username);
  if (!office) throw new Error('[OfficesService] office not found.');
  const ledger = await FinancialService.getClientLedger(String(office_id), 'office');

  const receiptIds = [...new Set(
    ledger
      .filter((e) => e.reference_type === 'receipt' && e.reference_id)
      .map((e) => String(e.reference_id))
  )];

  const receiptMap = new Map();
  for (const id of receiptIds) {
    const receipt = await OfficeRepository.getReceiptById(id);
    if (receipt && receipt.receipt_number) {
      receiptMap.set(id, String(receipt.receipt_number));
    }
  }

  return ledger.map((entry) => {
    const reference_number = entry.receipt_number || receiptMap.get(String(entry.reference_id)) || null;
    const enriched = {
      ...entry,
      reference_number,
    };
    return {
      ...enriched,
      reference_label: formatMovementReference(enriched),
    };
  });
}

async function depositToOffice(username, office_id, payload) {
  _requireUsername(username, 'depositToOffice');
  if (!office_id) throw new Error('[OfficesService:depositToOffice] office_id is required.');
  if (!payload || typeof payload !== 'object') {
    throw new Error('[OfficesService] payload must be a plain object.');
  }

  const office = await getOfficeById(office_id, username);
  if (!office) throw new Error('[OfficesService] office not found.');

  const data = {
    ...payload,
    office_id: String(office.id),
  };

  return FinancialService.createOfficeDeposit(username, data);
}

async function adjustOfficeBalance(username, office_id, payload) {
  _requireUsername(username, 'adjustOfficeBalance');
  if (!office_id) throw new Error('[OfficesService:adjustOfficeBalance] office_id is required.');
  if (!payload || typeof payload !== 'object') {
    throw new Error('[OfficesService] payload must be a plain object.');
  }

  const office = await getOfficeById(office_id, username);
  if (!office) throw new Error('[OfficesService] office not found.');

  if (payload.type === 'deposit') {
    return FinancialService.createOfficeDeposit(username, {
      office_id: String(office.id),
      amount: payload.amount,
      note: payload.note,
      date: payload.date,
    });
  }

  const data = {
    ...payload,
    client_id: String(office.id),
    client_type: 'office',
    client_name: office.name || '',
  };

  return FinancialService.createClientBalanceEntry(username, data);
}

const OfficesService = Object.freeze({
  createOffices,
  updateOffice,
  deleteOffice,
  getOffices,
  getOfficeById,
  addHamolaRow,
  updateHamolaRow,
  deleteHamolaRow,
  syncHamolaFromReceiptRows,
  findMissingCargoCombinations,
  normalizeCargoText,
  normalizeCargoKey,
  getOfficeFinancialSummary,
  getOfficeLedger,
  depositToOffice,
  adjustOfficeBalance,
  _getCachedHamola,
});



// ========================================
// Module — OfficesModule
// ========================================

function _moduleSessionUsername() {
  const session = AuthModule.getSession();
  if (!session?.username) {
    throw new Error('Username required');
  }
  return session.username;
}

const OfficesModule = Object.freeze({
  getOffices: () => OfficesService.getOffices(_moduleSessionUsername()),
  createOffices: (rows) => OfficesService.createOffices(_moduleSessionUsername(), rows),
  updateOffice: (id, patch) => OfficesService.updateOffice(_moduleSessionUsername(), id, patch),
  deleteOffice: (id) => OfficesService.deleteOffice(_moduleSessionUsername(), id),
  getOfficeDetails: (id) => OfficesService.getOfficeById(id, _moduleSessionUsername()),
  getOfficeLedger: (office_id) => OfficesService.getOfficeLedger(_moduleSessionUsername(), office_id),
  adjustOfficeBalance: (office_id, payload) =>
    OfficesService.adjustOfficeBalance(_moduleSessionUsername(), office_id, payload),
  depositToOffice: (office_id, payload) =>
    OfficesService.depositToOffice(_moduleSessionUsername(), office_id, payload),
  addHamolaRow: (office_id, row) =>
    OfficesService.addHamolaRow(_moduleSessionUsername(), office_id, row),
  updateHamolaRow: (office_id, row_id, patch) =>
    OfficesService.updateHamolaRow(_moduleSessionUsername(), office_id, row_id, patch),
  deleteHamolaRow: (office_id, row_id) =>
    OfficesService.deleteHamolaRow(_moduleSessionUsername(), office_id, row_id),
  syncHamolaFromReceiptRows: (rows, serverSyncedHamola = null) =>
    OfficesService.syncHamolaFromReceiptRows(_moduleSessionUsername(), rows, serverSyncedHamola),
  getOfficeSummary: (filters = null) =>
    OfficesService.getOfficeFinancialSummary(_moduleSessionUsername(), filters),
});



// ========================================
// Offices Page — Rendering / Events
// ========================================

let _searchQuery = '';
let _editingOfficeId = null;
let _editingOfficeDraft = null;
let _activeDetailsTab = 'balance';
let _detailsOfficeId = null;
let _officeCardsSearchQuery = '';
let _officeCardsCache = [];
let _hamolaEditId = null;
const LAST_PAGE_CTX_KEY = 'karta_v2_last_page_ctx';

function _requireSession() {
  const session = AuthModule.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return null;
  }
  return session;
}

function _fmt(n) {
  return Money.fmt(n);
}

function _balanceClass(value) {
  return Number(value) < 0 ? 'balance-negative' : 'balance-positive';
}

function _text(value) {
  return value == null ? '' : String(value);
}

function _renderListShell() {
  const page = document.getElementById('officesPage');
  if (!page) return;

  page.innerHTML = `
    <div class="p-6 card">

      <!-- العنوان والأزرار -->
      <div class="flex items-center justify-between flex-wrap gap-3 mb-6">
        <h2 class="text-2xl font-bold text-gray-800 mb-0">إدارة المكاتب</h2>
        <div class="flex gap-2">
          <button type="button" data-action="office-add" style="background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;border:none;border-radius:10px;padding:8px 18px;font-weight:700;font-size:0.875rem;cursor:pointer;font-family:inherit;transition:box-shadow 0.2s;">➕ إضافة مكتب</button>
        </div>
      </div>

      <!-- بطاقات الملخص -->
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-6">
        <div style="background:linear-gradient(135deg,#22c55e,#16a34a);border-radius:12px;padding:16px;color:#fff;">
          <p style="font-size:0.75rem;opacity:0.9;margin:0 0 4px;">عدد المكاتب</p>
          <p style="font-size:1.5rem;font-weight:800;margin:0;" id="officeTotalCount">0</p>
        </div>
        <div style="background:linear-gradient(135deg,#f97316,#ea580c);border-radius:12px;padding:16px;color:#fff;">
          <p style="font-size:0.75rem;opacity:0.9;margin:0 0 4px;">إجمالي الرصيد</p>
          <p style="font-size:1.5rem;font-weight:800;margin:0;" id="officeTotalBalance">0.00</p>
        </div>
      </div>

      <!-- شريط البحث -->
      <div class="mb-6">
        <input id="officeSearch" type="text" class="input" placeholder="🔍 ابحث عن مكتب..." style="border-radius:12px;padding:10px 16px 10px 40px;" />
      </div>

      <!-- قائمة المكاتب -->
      <div style="margin-bottom:8px;">
        <h3 class="text-lg font-bold text-gray-800 mb-3">قائمة المكاتب</h3>
      </div>
      <div class="table-wrapper overflow-x-auto">
        <table class="table">
          <thead style="background:linear-gradient(135deg,#1e3a8a,#2563eb);">
            <tr>
              <th style="color:#fff;">اسم المكتب</th>
              <th style="color:#fff;">رقم الهاتف</th>
              <th style="color:#fff;">الرصيد</th>
              <th style="color:#fff;">إجراءات</th>
            </tr>
          </thead>
          <tbody id="officesTableBody"></tbody>
        </table>
      </div>

      <div id="officesInlineMsg" class="field-msg-inline field-msg-inline--error" role="alert" aria-live="polite"></div>
    </div>
  `;

  if (!document.getElementById('officeModal')) {
    const modal = document.createElement('div');
    modal.innerHTML = _renderOfficeModal();
    document.body.appendChild(modal.firstElementChild);
  }
}

function _renderOfficeModal() {
  return `
    <div id="officeModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-3xl">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold">إضافة مكاتب</h3>
          <button type="button" data-action="office-modal-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>

        <div class="table-wrapper overflow-x-auto mb-4">
          <table class="table">
            <thead>
              <tr>
                <th>الاسم</th>
                <th>الهاتف</th>
                <th>إجراءات</th>
              </tr>
            </thead>
            <tbody id="officeModalBody"></tbody>
          </table>
        </div>

        <div class="flex gap-2">
          <button type="button" data-action="office-modal-add-row" class="btn btn-secondary btn-sm">➕ إضافة صف</button>
          <button type="button" data-action="office-modal-save" class="btn btn-primary btn-sm">حفظ الكل</button>
        </div>
        <div id="officeModalMsg" class="field-msg-inline field-msg-inline--error" role="alert" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function _renderOfficeModalRow() {
  return `
    <tr>
      <td><input type="text" class="input input-sm office-modal-name" placeholder="اسم المكتب" /></td>
      <td><input type="text" class="input input-sm office-modal-phone" placeholder="الهاتف" /></td>
      <td><button type="button" data-action="office-modal-remove-row" class="btn btn-secondary btn-sm">حذف</button></td>
    </tr>
  `;
}

function _renderDetailsShell(office) {
  const page = document.getElementById('officeDetailsPage');
  if (!page) return;

  page.innerHTML = `
    <div class="p-6 card">

      <!-- رأس التفاصيل -->
      <div class="flex items-center justify-between flex-wrap gap-3 mb-4">
        <div class="flex items-center gap-3">
          <button type="button" data-action="office-back" style="background:#6b7280;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">← العودة</button>
          <div>
            <h2 class="text-xl font-bold text-gray-800 mb-0">${office.name}</h2>
            <p class="text-muted text-xs mb-0">عرض وإدارة البيانات الكاملة</p>
          </div>
        </div>
        <button type="button" data-action="office-print" style="background:#7c3aed;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">🖨️ طباعة</button>
      </div>

      <!-- بيانات المكتب -->
      <div style="background:linear-gradient(135deg,#f0fdf4,#f0fdfa);border-radius:12px;padding:16px 20px;margin-bottom:20px;display:flex;flex-wrap:wrap;gap:20px;">
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:200px;">
          <div style="width:40px;height:40px;border-radius:50%;background:#22c55e;display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.125rem;flex-shrink:0;">🏢</div>
          <div>
            <p style="font-size:0.6875rem;color:#6b7280;margin:0;">اسم المكتب</p>
            <p style="font-size:1.0625rem;font-weight:700;color:#1f2937;margin:0;">${office.name}</p>
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:10px;flex:1;min-width:200px;">
          <div style="width:40px;height:40px;border-radius:50%;background:#0f766e;display:flex;align-items:center;justify-content:center;color:#fff;font-size:1.125rem;flex-shrink:0;">📞</div>
          <div>
            <p style="font-size:0.6875rem;color:#6b7280;margin:0;">رقم الهاتف</p>
            <p style="font-size:1.0625rem;font-weight:700;color:#1f2937;margin:0;">${office.phone || '—'}</p>
          </div>
        </div>
      </div>

      <!-- التبويبات -->
      <div style="display:flex;border-bottom:2px solid #e5e7eb;margin-bottom:20px;" role="tablist">
        <button type="button" data-tab="balance" style="padding:12px 20px;border:none;border-bottom:3px solid ${_activeDetailsTab === 'balance' ? '#1f2937' : 'transparent'};background:${_activeDetailsTab === 'balance' ? '#f3f4f6' : 'transparent'};color:${_activeDetailsTab === 'balance' ? '#1f2937' : '#9ca3af'};font-weight:${_activeDetailsTab === 'balance' ? '700' : '500'};font-size:0.9375rem;cursor:pointer;font-family:inherit;transition:all 0.2s;">💰 رصيد المكتب</button>
        <button type="button" data-tab="hamola" style="padding:12px 20px;border:none;border-bottom:3px solid ${_activeDetailsTab === 'hamola' ? '#1f2937' : 'transparent'};background:${_activeDetailsTab === 'hamola' ? '#f3f4f6' : 'transparent'};color:${_activeDetailsTab === 'hamola' ? '#1f2937' : '#9ca3af'};font-weight:${_activeDetailsTab === 'hamola' ? '700' : '500'};font-size:0.9375rem;cursor:pointer;font-family:inherit;transition:all 0.2s;">🚚 تفاصيل الحمولة</button>
        <button type="button" data-tab="cards" style="padding:12px 20px;border:none;border-bottom:3px solid ${_activeDetailsTab === 'cards' ? '#1f2937' : 'transparent'};background:${_activeDetailsTab === 'cards' ? '#f3f4f6' : 'transparent'};color:${_activeDetailsTab === 'cards' ? '#1f2937' : '#9ca3af'};font-weight:${_activeDetailsTab === 'cards' ? '700' : '500'};font-size:0.9375rem;cursor:pointer;font-family:inherit;transition:all 0.2s;">📋 الكارتات</button>
      </div>

      <div id="officeDetailsContent"></div>
    </div>
  `;

  if (!document.getElementById('hamolaModal')) {
    const modal = document.createElement('div');
    modal.innerHTML = _renderHamolaModal();
    document.body.appendChild(modal.firstElementChild);
  }

  if (!document.getElementById('officeDepositModal')) {
    const modal = document.createElement('div');
    modal.innerHTML = _renderOfficeDepositModal();
    document.body.appendChild(modal.firstElementChild);
  }
}

function _renderHamolaModal() {
  return `
    <div id="hamolaModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-lg">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold" id="hamolaModalTitle">إضافة حمولة</h3>
          <button type="button" data-action="hamola-modal-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
          <div>
            <label class="label mb-1" for="hamolaLoading">مكان التحميل</label>
            <input id="hamolaLoading" type="text" class="input input-sm" />
          </div>
          <div>
            <label class="label mb-1" for="hamolaDestination">الجهة</label>
            <input id="hamolaDestination" type="text" class="input input-sm" />
          </div>
          <div>
            <label class="label mb-1" for="hamolaNolon">النولون</label>
            <input id="hamolaNolon" type="number" step="0.01" class="input input-sm" />
          </div>
          <div>
            <label class="label mb-1" for="hamolaMaktab">المكتب</label>
            <input id="hamolaMaktab" type="number" step="0.01" class="input input-sm" />
          </div>
          <div>
            <label class="label mb-1" for="hamolaType">النوع</label>
            <input id="hamolaType" type="text" class="input input-sm" />
          </div>
        </div>

        <div class="flex gap-2">
          <button type="button" data-action="hamola-modal-save" class="btn btn-primary btn-sm">حفظ</button>
        </div>
        <div id="hamolaModalMsg" class="field-msg-inline field-msg-inline--error" role="alert" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function _renderOfficeDepositModal() {
  return `
    <div id="officeDepositModal" class="hidden fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div class="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-lg font-bold">إيداع رصيد</h3>
          <button type="button" data-action="office-deposit-close" class="btn btn-secondary btn-sm">إغلاق</button>
        </div>

        <div class="grid grid-cols-1 gap-3 mb-4">
          <div>
            <label class="label mb-1" for="officeDepositAmount">المبلغ</label>
            <input id="officeDepositAmount" type="number" step="0.01" min="0" class="input input-sm" />
          </div>
          <div>
            <label class="label mb-1" for="officeDepositNote">ملاحظة</label>
            <input id="officeDepositNote" type="text" class="input input-sm" />
          </div>
        </div>

        <div class="flex gap-2">
          <button type="button" data-action="office-deposit-save" class="btn btn-primary btn-sm">حفظ</button>
        </div>
        <div id="officeDepositMsg" class="field-msg-inline field-msg-inline--error" role="alert" aria-live="polite"></div>
      </div>
    </div>
  `;
}

function _renderOfficeBalance(entries) {
  function entryDate(entry) {
    return entry.date || entry.applied_at || entry.created_at || '';
  }

  function entryTypeLabel(entry) {
    return formatMovementTypeLabel(entry);
  }

  function entryDelta(entry) {
    const amount = Number(entry.amount) || 0;
    if (entry.type === 'OFFICE_DEPOSIT') return amount;
    if (entry.type === 'OFFICE_WITHDRAW_AUTO') return amount <= 0 ? amount : -amount;
    if (entry.type === 'deposit' || entry.type === 'receipt_due') return Math.abs(amount);
    if (entry.type === 'withdraw' || entry.type === 'receipt_payment') return -Math.abs(amount);
    return amount;
  }

  const sorted = entries.slice().sort((a, b) => {
    const da = new Date(entryDate(a) || 0).getTime();
    const db = new Date(entryDate(b) || 0).getTime();
    return da - db;
  });

  let running = 0;
  const withBalance = sorted.map((entry) => {
    const delta = entryDelta(entry);
    running += delta;
    return { entry, delta, balance: running };
  });

  const currentBalance = withBalance.length
    ? withBalance[withBalance.length - 1].balance
    : 0;
  const currentClass = _balanceClass(currentBalance);

  const displayRows = withBalance.slice().reverse();
  const rows = displayRows.length
    ? displayRows.map(({ entry, delta, balance }) => `
      <tr>
        <td>${_text(entryDate(entry))}</td>
        <td>${entryTypeLabel(entry)}</td>
        <td>${delta < 0 ? '-' : ''}${_fmt(Math.abs(delta))}</td>
        <td>${_fmt(balance)}</td>
        <td>${_text(formatMovementReference(entry))}</td>
      </tr>
    `).join('')
    : `<tr><td colspan="5" class="text-center text-muted p-4">لا توجد حركات</td></tr>`;

  return `
    <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;">
      <div>
        <p class="text-muted text-xs mb-1">الرصيد الحالي</p>
        <p class="text-2xl font-bold ${currentClass}">${_fmt(currentBalance)}</p>
      </div>
      <div class="flex gap-2">
        <button type="button" data-action="office-deposit-open" style="background:#2563eb;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">💰 إيداع / سحب</button>
      </div>
    </div>
    <div class="table-wrapper">
      <table class="table">
        <thead style="background:linear-gradient(135deg,#1e3a8a,#2563eb);">
          <tr>
            <th style="color:#fff;">التاريخ</th>
            <th style="color:#fff;">النوع</th>
            <th style="color:#fff;">المبلغ</th>
            <th style="color:#fff;">الرصيد بعد العملية</th>
            <th style="color:#fff;">المرجع</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}


/**
 * Compute total weight per (loading_place, destination_place) from saved receipts.
 * Returns map: { "loading__destination": totalWeight }
 */
async function _computeWeightMap(office) {
  const username = _moduleSessionUsername();
  const officeName = String(office.name || '').trim().toLowerCase();
  const receipts = await OfficeRepository.getReceipts(username);
  const weightMap = {};

  for (const receipt of receipts) {
    if (receipt.deleted_at !== null) continue;
    const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
    for (const row of rows) {
      if (row._type === 'separator') continue;
      const rowOffice = String(row.office || '').trim().toLowerCase();
      if (rowOffice !== officeName) continue;

      const loading = String(row.loading || '').trim().toLowerCase();
      const dest = String(row.taktik || row.direction || '').trim().toLowerCase();
      const w = (Number(row.weight) || 0) + (Number(row.weight2) || 0);
      if (!loading || !dest) continue;

      const key = loading + '__' + dest;
      weightMap[key] = (weightMap[key] || 0) + w;
    }
  }

  return weightMap;
}

/**
 * Attach auto-save for inline price inputs in hamola table
 */
function _attachPriceSaveListeners(office) {
  const inputs = document.querySelectorAll('.hamola-price-input');
  inputs.forEach(inp => {
    inp.addEventListener('change', async function() {
      const rowId = this.dataset.hamolaId;
      const price = parseFloat(this.value) || 0;
      try {
        await OfficesModule.updateHamolaRow(office.id, rowId, { price });
        // Re-render to update total prices
        const updatedOffice = await OfficesModule.getOfficeDetails(office.id);
        await _renderDetailsContent(updatedOffice);
      } catch (err) {
        console.error('[hamola] price save failed:', err);
      }
    });
  });
}

function _renderHamolaTable(rows) {
  const body = rows.length
    ? rows.map((r) => {
        const itemType = String(r.item_type ?? r.type ?? '').trim() || '—';
        return `
      <tr data-id="${r.id}">
        <td>${_text(r.loading_place)}</td>
        <td>${_text(r.destination_place)}</td>
        <td>${_text(itemType)}</td>
        <td>
          <button type="button" data-action="hamola-edit" data-id="${r.id}" class="btn-icon" title="تعديل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">✏️</button>
          <button type="button" data-action="hamola-delete" data-id="${r.id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
        </td>
      </tr>`;
      }).join('')
    : `<tr><td colspan="4" class="text-center text-muted p-6" style="color:#94a3b8;">لا توجد بيانات — اضغط إضافة حمولة</td></tr>`;

  return `
    <div class="flex justify-between items-center flex-wrap gap-3 mb-4">
      <h3 class="text-xl font-bold text-gray-800">قائمة أماكن التحميل والتعتيق</h3>
      <div class="flex items-center gap-3 flex-wrap">
        <button type="button" data-action="hamola-add" style="background:#16a34a;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;font-size:0.8125rem;cursor:pointer;font-family:inherit;">➕ إضافة حمولة</button>
      </div>
    </div>
    <div class="table-wrapper">
      <table class="table">
        <thead style="background:linear-gradient(135deg,#16a34a,#15803d);">
          <tr>
            <th style="color:#fff;">التحميل</th>
            <th style="color:#fff;">الجهة</th>
            <th style="color:#fff;">النوع</th>
            <th style="color:#fff;">إجراءات</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

async function loadOffices() {
  const session = _requireSession();
  if (!session) return;

  // Build the shell only on first render — never destroy existing data
  if (!document.getElementById('officesTableBody')) {
    _renderListShell();
  }

  const searchEl = document.getElementById('officeSearch');
  if (searchEl) searchEl.value = _searchQuery || '';

  // Show lightweight loading indicator inside existing table
  const tbodyPreview = document.getElementById('officesTableBody');
  if (tbodyPreview && tbodyPreview.children.length === 0) {
    tbodyPreview.innerHTML = '<tr><td colspan="4" class="text-center text-muted p-6">⏳ جاري التحميل...</td></tr>';
  }

  const summary = await OfficesModule.getOfficeSummary();
  const totalCountEl = document.getElementById('officeTotalCount');

  if (totalCountEl) totalCountEl.textContent = String(summary.total_offices || 0);
  const totalBalanceEl = document.getElementById("officeTotalBalance");
  if (totalBalanceEl) totalBalanceEl.textContent = _fmt(summary.rows.reduce((s, r) => s + (r.balance || 0), 0));

  const tbody = document.getElementById('officesTableBody');
  if (!tbody) return;

  const query = _searchQuery.trim().toLowerCase();
  const rows = summary.rows.filter((item) => {
    if (!query) return true;
    const name = String(item.office.name || '').toLowerCase();
    const phone = String(item.office.phone || '').toLowerCase();
    return name.includes(query) || phone.includes(query);
  });

  tbody.innerHTML = rows.map((item) => {
    const office = item.office;
    const isEditing = _editingOfficeId && String(_editingOfficeId) === String(office.id);
    const nameVal = isEditing ? _editingOfficeDraft?.name ?? office.name : office.name;
    const phoneVal = isEditing ? _editingOfficeDraft?.phone ?? office.phone : office.phone;

    return `
      <tr data-id="${office.id}" style="transition:background 0.15s;">
        <td ${!isEditing ? `data-action="office-details" data-id="${office.id}" style="cursor:pointer;color:#2563eb;font-weight:700;" onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background=''"` : ''}>
          ${isEditing
            ? `<input type="text" class="input input-sm office-edit-name" value="${_text(nameVal)}" />`
            : _text(office.name)
          }
        </td>
        <td style="color:#374151;">
          ${isEditing
            ? `<input type="text" class="input input-sm office-edit-phone" value="${_text(phoneVal)}" />`
            : _text(office.phone || '—')
          }
        </td>
        <td class="${Number(item.balance) < 0 ? 'balance-negative' : ''}" style="font-weight:700;">${_fmt(item.balance)}</td>
        <td>
          ${isEditing
            ? `
              <button type="button" data-action="office-save" data-id="${office.id}" class="btn btn-primary btn-sm">حفظ</button>
              <button type="button" data-action="office-cancel" class="btn btn-secondary btn-sm">إلغاء</button>
            `
            : `
              <button type="button" data-action="office-edit" data-id="${office.id}" class="btn-icon" title="تعديل" style="background:#fef3c7;color:#d97706;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">✏️</button>
              <button type="button" data-action="office-details" data-id="${office.id}" class="btn-icon" title="تفاصيل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">📋</button>
              <button type="button" data-action="office-delete" data-id="${office.id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
            `
          }
        </td>
      </tr>
    `;
  }).join('') || `<tr><td colspan="4" class="text-center text-muted p-6">
    <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:24px;">
      <div style="width:64px;height:64px;background:#e2e8f0;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:2rem;">🏢</div>
      <p style="font-weight:700;color:#64748b;margin:0;">لا يوجد مكاتب</p>
      <p style="font-size:0.8125rem;color:#94a3b8;margin:0;">ابدأ بإضافة المكاتب من الزر أعلاه</p>
    </div>
  </td></tr>`;
}

async function showOfficeDetails(id) {
  const session = _requireSession();
  if (!session) return;
  if (!id) throw new Error('[offices-page] office id is required');

  _detailsOfficeId = String(id);
  _activeDetailsTab = 'balance';
  const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
  if (!office) throw new Error('Office not found');

  sessionStorage.setItem(LAST_PAGE_CTX_KEY, JSON.stringify({
    page: 'officeDetailsPage',
    officeId: _detailsOfficeId,
  }));

  _renderDetailsShell(office);
  await _renderDetailsContent(office);

  if (typeof window.showPage === 'function') {
    await window.showPage('officeDetailsPage');
  }
}


/**
 * Get all receipt rows linked to a specific office/company.
 * Each row includes parent receipt metadata for display.
 * 
 * MySQL-ready: This will become:
 *   SELECT rr.*, r.receipt_number, r.client_name, r.payout_status
 *   FROM receipt_rows rr
 *   JOIN receipts r ON rr.receipt_id = r.id
 *   WHERE rr.office = ?
 */
async function _getOfficeCards(office) {
  const username = _moduleSessionUsername();
  const officeName = String(office.name || '').trim().toLowerCase();
  const allReceipts = await OfficeRepository.getReceipts(username);

  const cards = [];
  for (const receipt of allReceipts) {
    if (receipt.deleted_at !== null) continue;
    const rows = Array.isArray(receipt.rows) ? receipt.rows : [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row._type === 'separator') continue;
      const rowOffice = String(row.office || '').trim().toLowerCase();
      if (rowOffice !== officeName) continue;

      cards.push({
        receipt_id: receipt.id,
        receipt_number: receipt.receipt_number || '',
        client_name: receipt.client_name || '',
        payout_status: receipt.payout_status || 'unpaid',
        receipt_date: receipt.receipt_date || '',
        row_index: i,
        _rowId: row._rowId || null,
        kartano: row.kartano || row.kartaNo || '',
        date: row.date || '',
        car: row.car || row.carNo || row.vehicle_plate || '',
        driver: row.data || row.driver || row.driver_name || '',
        weight: (Number(row.weight) || 0) + (Number(row.weight2) || 0),
        noloon: Number(row.noloon) || 0,
        loading: row.loading || '',
        taktik: row.taktik || row.direction || '',
        type: row.type || '',
        notes: row.notes || '',
      });
    }
  }

  // Sort by receipt date descending
  cards.sort((a, b) => {
    const da = new Date(b.receipt_date || 0).getTime();
    const db = new Date(a.receipt_date || 0).getTime();
    return da - db;
  });

  return cards;
}

function _renderOfficeCards(allCards) {
  // ── Filter by search query ──
  const query = _officeCardsSearchQuery.trim().toLowerCase();
  const cards = query
    ? allCards.filter(c => {
        const hay = [
          c.receipt_number, c.client_name, c.kartano, c.date, c.car,
          c.driver, c.loading, c.taktik, c.type, c.notes,
          c.payout_status === 'paid' ? 'تم صرفه' : 'لم يتم صرفه',
          String(c.weight), String(c.noloon),
        ].join(' ').toLowerCase();
        return hay.includes(query);
      })
    : allCards;

  const totalWeight = cards.reduce((s, c) => s + c.weight, 0);
  const totalNoloon = cards.reduce((s, c) => s + c.noloon, 0);

  const summaryHTML = `
    <div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:16px;">
      <div style="flex:1;min-width:120px;background:linear-gradient(135deg,#6b7280,#4b5563);border-radius:12px;padding:12px 16px;color:#fff;">
        <p style="font-size:0.75rem;opacity:0.9;margin:0 0 4px;">عدد الكارتات</p>
        <p style="font-size:1.25rem;font-weight:800;margin:0;">${cards.length}</p>
      </div>
      <div style="flex:1;min-width:120px;background:linear-gradient(135deg,#0f766e,#0d9488);border-radius:12px;padding:12px 16px;color:#fff;">
        <p style="font-size:0.75rem;opacity:0.9;margin:0 0 4px;">إجمالي الوزن</p>
        <p style="font-size:1.25rem;font-weight:800;margin:0;">${_fmt(totalWeight)}</p>
      </div>
      <div style="flex:1;min-width:120px;background:linear-gradient(135deg,#2563eb,#1d4ed8);border-radius:12px;padding:12px 16px;color:#fff;">
        <p style="font-size:0.75rem;opacity:0.9;margin:0 0 4px;">إجمالي النولون</p>
        <p style="font-size:1.25rem;font-weight:800;margin:0;">${_fmt(totalNoloon)}</p>
      </div>
    </div>`;

  const searchHTML = `
    <div style="margin-bottom:12px;">
      <input id="officeCardsSearch" type="text" placeholder="🔍 ابحث داخل الكارتات..." value="${_toText(_officeCardsSearchQuery)}"
        style="width:100%;padding:10px 16px;border:1.5px solid #d1d5db;border-radius:12px;font-family:inherit;font-size:0.875rem;outline:none;box-sizing:border-box;" />
    </div>`;

  if (allCards.length === 0) {
    return summaryHTML + '<div style="text-align:center;padding:32px;color:#94a3b8;">لا توجد كارتات لهذا المكتب</div>';
  }

  if (cards.length === 0 && query) {
    return summaryHTML + searchHTML + '<div style="text-align:center;padding:24px;color:#94a3b8;">لا توجد نتائج للبحث</div>';
  }

  const statusLabel = (s) => s === 'paid' ? '<span style="color:#16a34a;font-weight:700;">تم صرفه</span>' : '<span style="color:#dc2626;font-weight:700;">لم يتم صرفه</span>';

  const tableRows = cards.map(c => `
    <tr>
      <td>${_text(c.receipt_number)}</td>
      <td>${_text(c.client_name)}</td>
      <td>${_text(c.kartano)}</td>
      <td>${_text(c.date)}</td>
      <td>${_text(c.car)}</td>
      <td>${_text(c.driver)}</td>
      <td>${_fmt(c.weight)}</td>
      <td>${_fmt(c.noloon)}</td>
      <td>${_text(c.loading)}</td>
      <td>${_text(c.taktik)}</td>
      <td>${_text(c.type)}</td>
      <td>${statusLabel(c.payout_status)}</td>
      <td>${_text(c.notes)}</td>
    </tr>
  `).join('');

  return summaryHTML + searchHTML + `
    <div class="table-wrapper" style="max-height:60vh;overflow-y:auto;">
      <table class="table">
        <thead style="background:linear-gradient(135deg,#1e3a8a,#2563eb);">
          <tr>
            <th style="color:#fff;">رقم الإذن</th>
            <th style="color:#fff;">العميل</th>
            <th style="color:#fff;">رقم الكارتة</th>
            <th style="color:#fff;">التاريخ</th>
            <th style="color:#fff;">رقم المركبة</th>
            <th style="color:#fff;">السائق</th>
            <th style="color:#fff;">الوزن</th>
            <th style="color:#fff;">النولون</th>
            <th style="color:#fff;">التحميل</th>
            <th style="color:#fff;">الجهة</th>
            <th style="color:#fff;">النوع</th>
            <th style="color:#fff;">الحالة</th>
            <th style="color:#fff;">ملاحظات</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>`;
}

async function _renderDetailsContent(office) {
  const content = document.getElementById('officeDetailsContent');
  if (!content) return;

  if (_activeDetailsTab === 'balance') {
    const ledger = await OfficesModule.getOfficeLedger(office.id);
    content.innerHTML = _renderOfficeBalance(ledger || []);
    return;
  }

  if (_activeDetailsTab === 'hamola') {
    content.innerHTML = _renderHamolaTable(office.hamolaRows || []);
  }

  if (_activeDetailsTab === 'cards') {
    content.innerHTML = '<div style="text-align:center;padding:24px;color:#9ca3af;">جاري التحميل...</div>';
    const cardsData = await _getOfficeCards(office);
    _officeCardsCache = cardsData;
    content.innerHTML = _renderOfficeCards(cardsData);
  }
}

function _openOfficeModal() {
  const modal = document.getElementById('officeModal');
  const body = document.getElementById('officeModalBody');
  const msg = document.getElementById('officeModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  if (body) body.innerHTML = _renderOfficeModalRow();
  modal?.classList.remove('hidden');
}

function _closeOfficeModal() {
  document.getElementById('officeModal')?.classList.add('hidden');
}

function _openHamolaModal(title, row = null) {
  const modal = document.getElementById('hamolaModal');
  const msg = document.getElementById('hamolaModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }

  const t = document.getElementById('hamolaModalTitle');
  if (t) t.textContent = title;

  const loading = document.getElementById('hamolaLoading');
  const destination = document.getElementById('hamolaDestination');
  const price = document.getElementById('hamolaPrice');
  const nolon = document.getElementById('hamolaNolon');

  if (loading) loading.value = row?.loading_place || '';
  if (destination) destination.value = row?.destination_place || '';
  if (nolon) nolon.value = row?.nolon ?? '';

  const maktab = document.getElementById('hamolaMaktab');
  const typeInp = document.getElementById('hamolaType');
  if (maktab) maktab.value = row?.office_amount ?? '';
  if (typeInp) typeInp.value = row?.item_type ?? '';

  modal?.classList.remove('hidden');
}

function _closeHamolaModal() {
  document.getElementById('hamolaModal')?.classList.add('hidden');
}

function _openOfficeDepositModal() {
  const modal = document.getElementById('officeDepositModal');
  const msg = document.getElementById('officeDepositMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }
  const amountEl = document.getElementById('officeDepositAmount');
  const noteEl = document.getElementById('officeDepositNote');
  if (amountEl) amountEl.value = '';
  if (noteEl) noteEl.value = '';
  modal?.classList.remove('hidden');
}

function _closeOfficeDepositModal() {
  document.getElementById('officeDepositModal')?.classList.add('hidden');
}

async function _saveOfficeDeposit() {
  const msg = document.getElementById('officeDepositMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }

  const amountVal = parseFloat(document.getElementById('officeDepositAmount')?.value) || 0;
  const note = document.getElementById('officeDepositNote')?.value || '';

  if (!_detailsOfficeId) {
    if (msg) {
      msg.textContent = 'لا يوجد مكتب محدد';
      msg.classList.add('is-visible');
    }
    return;
  }

  if (amountVal <= 0) {
    if (msg) {
      msg.textContent = 'المبلغ مطلوب ويجب أن يكون أكبر من صفر';
      msg.classList.add('is-visible');
    }
    return;
  }

  try {
    const depositFn = typeof OfficesModule.depositToOffice === 'function'
      ? OfficesModule.depositToOffice
      : OfficesModule.adjustOfficeBalance;

    if (typeof depositFn !== 'function') {
      throw new Error('Office deposit handler is not available');
    }

    await depositFn(_detailsOfficeId, {
      amount: amountVal,
      note: note.trim() || null,
      date: DateUtils.todayLocal(),
      type: 'deposit',
      client_id: _detailsOfficeId,
      client_type: 'office',
    });

    _closeOfficeDepositModal();
    const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
    await _renderDetailsContent(office);
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || 'حدث خطأ أثناء الإيداع';
      msg.classList.add('is-visible');
    }
  }
}

async function _saveHamolaRow() {
  const msg = document.getElementById('hamolaModalMsg');
  if (msg) { msg.textContent = ''; msg.classList.remove('is-visible'); }

  const loading = document.getElementById('hamolaLoading')?.value;
  const destination = document.getElementById('hamolaDestination')?.value;
  const nolon = document.getElementById('hamolaNolon')?.value;
  const maktab = document.getElementById('hamolaMaktab')?.value;
  const itemType = document.getElementById('hamolaType')?.value;

  try {
    if (_hamolaEditId) {
      await OfficesModule.updateHamolaRow(_detailsOfficeId, _hamolaEditId, {
        loading_place: loading,
        destination_place: destination,
        nolon,
        office_amount: maktab,
        item_type: itemType,
      });
    } else {
      await OfficesModule.addHamolaRow(_detailsOfficeId, {
        loading_place: loading,
        destination_place: destination,
        nolon,
        office_amount: maktab,
        item_type: itemType,
      });
    }

    _hamolaEditId = null;
    _closeHamolaModal();
    const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
    await _renderDetailsContent(office);
  } catch (err) {
    if (msg) {
      msg.textContent = err.message || 'حدث خطأ أثناء الحفظ';
      msg.classList.add('is-visible');
    }
  }
}

function attachOfficesPageListeners() {
  if (document.body.dataset.officesBound) return;
  document.body.dataset.officesBound = '1';

  document.addEventListener('click', async (e) => {
    const target = e.target;

    if (target.closest('[data-action="office-add"]')) {
      _openOfficeModal();
      return;
    }
    if (target.closest('[data-action="office-modal-close"]')) {
      _closeOfficeModal();
      return;
    }
    if (target.closest('[data-action="office-modal-add-row"]')) {
      document.getElementById('officeModalBody')?.insertAdjacentHTML('beforeend', _renderOfficeModalRow());
      return;
    }
    if (target.closest('[data-action="office-modal-remove-row"]')) {
      target.closest('tr')?.remove();
      return;
    }
    if (target.closest('[data-action="office-modal-save"]')) {
      const rows = [...document.querySelectorAll('#officeModalBody tr')].map((tr) => ({
        name: tr.querySelector('.office-modal-name')?.value,
        phone: tr.querySelector('.office-modal-phone')?.value,
      }));
      try {
        const created = await OfficesModule.createOffices(rows);
        _closeOfficeModal();
        // Optimistic: append new rows immediately, then background refresh summary
        const tbody = document.getElementById('officesTableBody');
        if (tbody && Array.isArray(created)) {
          for (const record of created) {
            const tr = document.createElement('tr');
            tr.dataset.id = String(record.id);
            tr.style.transition = 'background 0.15s';
            tr.innerHTML = `
              <td data-action="office-details" data-id="${record.id}" style="cursor:pointer;color:#2563eb;font-weight:700;">${_text(record.name)}</td>
              <td style="color:#374151;">${_text(record.phone || '—')}</td>
              <td style="font-weight:700;">0.00</td>
              <td>
                <button type="button" data-action="office-details" data-id="${record.id}" class="btn-icon" title="تفاصيل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">📋</button>
                <button type="button" data-action="office-delete" data-id="${record.id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>
              </td>`;
            // Remove 'no offices' placeholder if present
            const placeholder = tbody.querySelector('td[colspan]');
            if (placeholder) placeholder.closest('tr')?.remove();
            tbody.prepend(tr);
          }
          // Update count
          const countEl = document.getElementById('officeTotalCount');
          if (countEl) countEl.textContent = String(tbody.querySelectorAll('tr[data-id]').length);
        }
        // Background: refresh summary data (weight/balance) without blocking UI
        loadOffices();
      } catch (err) {
        const msg = document.getElementById('officeModalMsg');
        if (msg) {
          msg.textContent = err.message || 'حدث خطأ أثناء الحفظ';
          msg.classList.add('is-visible');
        }
      }
      return;
    }

    if (target.closest('[data-action="office-edit"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      _editingOfficeId = id;
      _editingOfficeDraft = null;
      await loadOffices();
      return;
    }
    if (target.closest('[data-action="office-cancel"]')) {
      _editingOfficeId = null;
      _editingOfficeDraft = null;
      await loadOffices();
      return;
    }
    if (target.closest('[data-action="office-save"]')) {
      const row = target.closest('tr');
      const id = row?.dataset.id;
      const name = row?.querySelector('.office-edit-name')?.value;
      const phone = row?.querySelector('.office-edit-phone')?.value;
      try {
        await OfficesModule.updateOffice(id, { name, phone });
        _editingOfficeId = null;
        _editingOfficeDraft = null;
        // Optimistic: update row in-place, then background refresh
        if (row) {
          const cells = row.querySelectorAll('td');
          if (cells[0]) { cells[0].textContent = name; cells[0].setAttribute('data-action','office-details'); cells[0].setAttribute('data-id', id); cells[0].style.cssText='cursor:pointer;color:#2563eb;font-weight:700;'; }
          if (cells[1]) { cells[1].textContent = phone || '—'; cells[1].style.color = '#374151'; }
          if (cells[3]) { cells[3].innerHTML = `<button type="button" data-action="office-edit" data-id="${id}" class="btn-icon" title="تعديل" style="background:#fef3c7;color:#d97706;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">✏️</button><button type="button" data-action="office-details" data-id="${id}" class="btn-icon" title="تفاصيل" style="background:#dbeafe;color:#2563eb;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">📋</button><button type="button" data-action="office-delete" data-id="${id}" class="btn-icon" title="حذف" style="background:#fee2e2;color:#dc2626;width:28px;height:28px;border:none;border-radius:6px;cursor:pointer;">🗑️</button>`; }
        }
        loadOffices(); // background refresh for summary
      } catch (err) {
        const msg = document.getElementById('officesInlineMsg');
        if (msg) {
          msg.textContent = err.message || 'حدث خطأ أثناء التعديل';
          msg.classList.add('is-visible');
        }
      }
      return;
    }
    if (target.closest('[data-action="office-delete"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      if (!id) return;
      if (!confirm('هل أنت متأكد من حذف المكتب؟')) return;
      // Optimistic: remove row immediately
      const delRow = document.querySelector(`#officesTableBody tr[data-id="${id}"]`);
      if (delRow) delRow.remove();
      const countEl = document.getElementById('officeTotalCount');
      const tbody = document.getElementById('officesTableBody');
      if (countEl && tbody) countEl.textContent = String(tbody.querySelectorAll('tr[data-id]').length);
      try {
        await OfficesModule.deleteOffice(id);
        loadOffices(); // non-blocking summary refresh
      } catch (err) {
        alert(err.message || 'فشل الحذف');
        await loadOffices(); // rollback: reload full list from server
      }
      return;
    }
    if (target.closest('[data-action="office-details"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      if (id) await showOfficeDetails(id);
      return;
    }

    if (target.closest('[data-action="office-back"]')) {
      _activeDetailsTab = 'balance';
      _detailsOfficeId = null;
      _officeCardsSearchQuery = '';
      _officeCardsCache = [];
      if (typeof window.showPage === 'function') await window.showPage('officesPage');
      return;
    }

    if (target.closest('[data-action="office-deposit-open"]')) {
      _openOfficeDepositModal();
      return;
    }

    if (target.closest('[data-action="office-deposit-close"]')) {
      _closeOfficeDepositModal();
      return;
    }

    if (target.closest('[data-action="office-deposit-save"]')) {
      await _saveOfficeDeposit();
      return;
    }



    if (target.closest('[data-action="office-print"]')) {
      if (_detailsOfficeId) {
        const content = document.getElementById('officeDetailsContent');
        if (content) {
          const { printHTML, buildPrintDocument } = await import('./printEngine.js');
          const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
          printHTML(buildPrintDocument({
            title: 'طباعة تفاصيل المكتب',
            body: '<h2 style="text-align:center;color:#0f766e;margin-bottom:12px;">' + (office?.name || '') + '</h2>' + content.innerHTML,
            orientation: 'portrait',
          }), { id: 'office-print-iframe' });
        }
      }
      return;
    }

    const tabBtn = target.closest('[data-tab]');
    if (tabBtn) {
      _activeDetailsTab = tabBtn.dataset.tab;
      _officeCardsSearchQuery = '';
      _officeCardsCache = [];
      if (_detailsOfficeId) {
        const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
        // Re-render full shell to update tab active state
        _renderDetailsShell(office);
        await _renderDetailsContent(office);
      }
      return;
    }

    if (target.closest('[data-action="hamola-add"]')) {
      _hamolaEditId = null;
      _openHamolaModal('إضافة حمولة');
      return;
    }

    if (target.closest('[data-action="hamola-edit"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
      const row = office?.hamolaRows?.find((r) => String(r.id) === String(id));
      if (!row) return;
      _hamolaEditId = id;
      _openHamolaModal('تعديل حمولة', row);
      return;
    }

    if (target.closest('[data-action="hamola-delete"]')) {
      const id = target.closest('[data-id]')?.dataset.id;
      if (!id) return;
      if (!confirm('هل أنت متأكد من حذف الحمولة؟')) return;
      await OfficesModule.deleteHamolaRow(_detailsOfficeId, id);
      const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
      await _renderDetailsContent(office);
      return;
    }

    if (target.closest('[data-action="hamola-modal-close"]')) {
      _hamolaEditId = null;
      _closeHamolaModal();
      return;
    }

    if (target.closest('[data-action="hamola-modal-save"]')) {
      await _saveHamolaRow();
      return;
    }
  });

  document.addEventListener('input', async (e) => {
    const target = e.target;
    if (target?.id === 'officeSearch') {
      _searchQuery = target.value || '';
      await loadOffices();
      return;
    }
    // Office cards search — re-render from cache, no DB call
    if (target?.id === 'officeCardsSearch') {
      _officeCardsSearchQuery = target.value || '';
      const content = document.getElementById('officeDetailsContent');
      if (content && _officeCardsCache.length > 0) {
        content.innerHTML = _renderOfficeCards(_officeCardsCache);
        // Restore focus to search input after re-render
        const searchInput = document.getElementById('officeCardsSearch');
        if (searchInput) {
          searchInput.focus();
          searchInput.selectionStart = searchInput.selectionEnd = searchInput.value.length;
        }
      }
    }
  });


  window.addEventListener('offices:changed', async () => {
    await loadOffices();
    // Refresh details panel if open (hamola tab etc.)
    if (_detailsOfficeId) {
      const office = await OfficesModule.getOfficeDetails(_detailsOfficeId);
      if (office) await _renderDetailsContent(office);
    }
  });
}


function initOfficesPage() {
  const session = _requireSession();
  if (!session) return;
  _renderListShell();
}

if (typeof window !== 'undefined') {
  window.showOfficeDetails = showOfficeDetails;
}


// ========================================
// Public API
// ========================================

export { OfficesService, OfficesModule, initOfficesPage, loadOffices, attachOfficesPageListeners, showOfficeDetails };
