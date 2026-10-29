/**
 * receipts.js — consolidated module
 * Internal structure: Constants → State → Services → Helpers → Rendering → Events → Public API → Boot
 */

import { FinancialService } from './financial.js';
import { ApiClient } from './services/apiClient.js';
import { OfficesService } from './offices.js';
import { AuthModule } from './auth.js';
import { OwnersModule, VehiclesModule } from './entities.js';
import { Money } from './money.js';
import { printHTML } from './printEngine.js';
import { ExcelService } from './excelService.js';
import { DBProvider } from './services/dbProvider.js';
import { ReceiptRepository } from './services/receiptRepository.js';
import { ClientRepository } from './services/clientRepository.js';
import { calculateRowNet, calculateReceiptTotals, shortageKgToTons } from './services/financialCalculator.js';
import {
  RECEIPT_PAYOUT_STATUS,
  ROW_DISBURSEMENT_STATUS,
  RECEIPT_PAYMENT_STATUS,
  getRowDisbursementStatus,
  validateRowDisbursementStatus,
  getRowDisbursementStatusLabel,
  getReceiptPaymentStatus,
  validateReceiptPaymentStatus,
  getReceiptPaymentStatusLabel,
  getStableRowId,
} from './constants/payoutStatus.js';
import { DateUtils } from './dateUtils.js';
import { generateId as _uuid } from './utils/idGenerator.js';


// ========================================
// Module — ReceiptsModule
// ========================================

// ─── INTERNAL ENUMS ────────────────────────────────────────────────────────────

const ROW_TYPES = {
  DATA      : 'data',
  SEPARATOR : 'separator',
};

const ROW_PAYMENT = {
  PENDING : 'pending',
};

const STORE = 'receipts';

// _uuid imported from utils/idGenerator.js

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const v = String(value).trim().replace(/\s+/g, ' ');
  return v === '' ? null : v;
}

// ─── VALIDATION ───────────────────────────────────────────────────────────────

function _validate(rawData) {
  if (!rawData || typeof rawData !== 'object') {
    throw new Error('[ReceiptsModule] rawData must be a plain object.');
  }

  if (!rawData.receipt_date || isNaN(Date.parse(rawData.receipt_date))) {
    throw new Error('[ReceiptsModule] receipt_date is required and must be a valid date.');
  }

  if (!Array.isArray(rawData.rows) || rawData.rows.length === 0) {
    throw new Error('[ReceiptsModule] rows must be a non-empty array.');
  }

  const dataRows = rawData.rows.filter(r => r._type !== ROW_TYPES.SEPARATOR);
  if (dataRows.length === 0) {
    throw new Error('[ReceiptsModule] At least one data row is required.');
  }


  if (rawData.client_id == null || String(rawData.client_id).trim() === '') {
    throw new Error('[ReceiptsModule] client_id is required.');
  }
  if (rawData.client_type !== 'owner') {
    throw new Error('[ReceiptsModule] client_type must be owner.');
  }

  const generalAdd = Number(rawData.general_add ?? 0);
  if (!Number.isFinite(generalAdd) || generalAdd < 0) {
    throw new Error('[ReceiptsModule] general_add must be a non-negative number.');
  }
  const paid = Number(rawData.paid ?? 0);
  if (!Number.isFinite(paid) || paid < 0) {
    throw new Error('[ReceiptsModule] paid must be a non-negative number.');
  }

  for (const row of dataRows) {
    if (!row || typeof row !== 'object') {
      throw new Error('[ReceiptsModule] Each data row must be a plain object.');
    }
    if (typeof row.owner_id !== 'string' || row.owner_id.trim() === '') {
      throw new Error('[ReceiptsModule] row.owner_id is required and must be a non-empty UUID string.');
    }
  }

  const VALID_ACCOUNT_TYPES = ['cash', 'bank', 'vodafone'];
  if (rawData.account_type != null) {
    const normalized = String(rawData.account_type).toLowerCase();
    if (!VALID_ACCOUNT_TYPES.includes(normalized)) {
      throw new Error(
        `[ReceiptsModule] Invalid account_type "${rawData.account_type}". ` +
        `Allowed: ${VALID_ACCOUNT_TYPES.join(', ')}.`
      );
    }
  }
}

// ─── NORMALIZE ROW ────────────────────────────────────────────────────────────

function _normalizeRow(row) {
  if (row._type === ROW_TYPES.SEPARATOR) {
    return {
      ...row,
      _rowId      : row._rowId || _uuid(),
      _type       : ROW_TYPES.SEPARATOR,
      vehicleName : normalizeOptionalString(row.vehicleName),
      subtotal    : Number(row.subtotal) || 0,
      notes       : normalizeOptionalString(row.notes),
    };
  }

  const hasFormulaInputs = row.weight !== undefined || row.noloon !== undefined;
  const net = (!hasFormulaInputs && row.net !== undefined && row.net !== null && row.net !== '')
    ? Money.round(Number(row.net) || 0)
    : calculateRowNet(row);
  const {
    discount: _unusedDiscount,
    army: _unusedArmy,
    weight2: _unusedWeight2,
    weightTotal: _unusedWeightTotal,
    weight_total: _unusedWeightTotalSnake,
    payment_status: _legacyRowPaymentStatus,
    payment_status_updated_at: _legacyRowPaymentUpdatedAt,
    ...restRow
  } = row;

  const rowStatus = getRowDisbursementStatus(row);
  const candidateRowId = row.row_id || row._rowId || _uuid();

  return {
    ...restRow,
    _rowId             : String(candidateRowId).trim(),
    row_id             : String(candidateRowId).trim(),
    _type              : row._type  || ROW_TYPES.DATA,
    owner_id           : row.owner_id != null ? String(row.owner_id).trim() : null,
    owner_name         : normalizeOptionalString(row.owner_name),
    vehicle_id         : row.vehicle_id != null ? String(row.vehicle_id).trim() : null,
    vehicle_plate      : normalizeOptionalString(row.vehicle_plate ?? row.car),
    disbursement_status: rowStatus,
    payout_status      : rowStatus,
    rowPayment         : rowStatus,
    weight: Number(row.weight) || 0,
    deficit: Number(row.deficit) || 0,
    noloon: Number(row.noloon) || 0,
    ohda: Number(row.ohda) || 0,
    officeAmount: Number(row.officeAmount) || 0,
    add: Number(row.add) || 0,
    sarf: Number(row.sarf) || 0,
    net,
  };
}

// ─── NORMALIZE RECEIPT ────────────────────────────────────────────────────────

function _normalize(rawData) {
  const receiptId = rawData.id ?? _uuid();
  const payment_status = getReceiptPaymentStatus(rawData);
  const topClientName = normalizeOptionalString(rawData.client_name);
  const usedRowIds = new Set();
  const rows     = rawData.rows.map((r, idx) => {
    const norm = _normalizeRow({ ...r });
    let rowId = norm.row_id || norm._rowId || _uuid();
    if (usedRowIds.has(rowId)) {
      rowId = _uuid();
    }
    usedRowIds.add(rowId);
    return {
      ...norm,
      _rowId: rowId,
      row_id: rowId,
      owner_name: norm.owner_name || topClientName || null,
      receipt_id: receiptId,
      row_order: idx,
      row_type: norm._type || 'data',
      is_auto: norm.isAuto || norm.is_auto || false,
    };
  });
  const dataRows = rows.filter(r => r.row_type !== ROW_TYPES.SEPARATOR);
  const resolvedClientName = topClientName || dataRows.find(r => r.owner_name)?.owner_name || null;

  const previous_balance = Number(rawData.previous_balance) || 0;
  const general_add      = Number(rawData.general_add)      || 0;
  const paid             = Number(rawData.paid)             || 0;

  const calcs = calculateReceiptTotals(rows, general_add, previous_balance, paid);
  const total = calcs.total;
  const net_due = calcs.net_due;
  const net_total = calcs.net_total;
  const balance = calcs.balance;
  const row_count        = dataRows.length;

  return {
    id             : receiptId,
    receipt_date   : rawData.receipt_date,
    receipt_number : rawData.receipt_number  ?? null,
    client_id      : rawData.client_id != null ? String(rawData.client_id).trim() : null,
    client_type    : rawData.client_type,
    client_name    : resolvedClientName,
    payment_status,
    notes          : normalizeOptionalString(rawData.notes),
    shipping_number: null,
    vehicle_id     : rawData.vehicle_id != null ? String(rawData.vehicle_id) : null,
    account_type   : rawData.account_type ? String(rawData.account_type).toLowerCase() : null,
    rows,
    row_count,
    total,
    previous_balance,
    general_add,
    net_due,
    net_total,
    paid,
    balance,
  };
}

// ─── SERVICE PAYLOAD ──────────────────────────────────────────────────────────

function _buildServicePayload(n) {
  const firstDataRow = n.rows.find(r => r._type !== ROW_TYPES.SEPARATOR) || null;
  return {
    id               : n.id,
    receipt_date     : n.receipt_date,
    receipt_number   : n.receipt_number,
    client_id        : n.client_id,
    client_type      : n.client_type,
    client_name      : n.client_name,
    payment_status   : n.payment_status,
    notes          : n.notes,
    shipping_number: null,
    vehicle_id       : n.vehicle_id || firstDataRow?.vehicle_id || null,
    account_type     : n.account_type,
    rows             : n.rows,
    row_count        : n.row_count,
    total            : n.total,
    general_add      : n.general_add,
    net_due          : n.net_due,
    previous_balance : n.previous_balance,
    paid             : n.paid,
    balance          : n.balance,
  };
}

function isConstraintError(err) {
  const msg = String(err?.message || '');
  return err?.name === 'ConstraintError'
    || msg.includes('ConstraintError')
    || msg.includes('uniqueness requirements');
}

function assignReceiptNumber(data, number) {
  return {
    ...data,
    receipt_number: number,
  };
}

// ─── PUBLIC: create ───────────────────────────────────────────────────────────

async function create(username, rawData) {
  if (!username) throw new Error('[ReceiptsModule:create] username is required.');

  _validate(rawData);

  const normalized     = _normalize(rawData);
  const servicePayload = _buildServicePayload(normalized);
  servicePayload.request_id = rawData.request_id || _uuid();

  const dataRows = normalized.rows.filter(r => r._type !== ROW_TYPES.SEPARATOR);
  const kartaNos = new Set(
    dataRows.map(r => (r.kartano != null ? String(r.kartano).trim() : '')).filter(Boolean)
  );

  let warning = null;
  if (kartaNos.size === 0) {
    warning = 'تنبيه: لا توجد أرقام كارتة في هذا الإيصال';
  }

  // ── Receipt-number allocation + atomic save (with retry on constraint clash) ──
  const MAX_RETRIES = 5;
  let nextNumber = parseInt(
    await allocateReceiptNumber(username, servicePayload.receipt_number),
    10
  );
  if (isNaN(nextNumber)) throw new Error('[ReceiptsModule] Invalid receipt number seed');

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const payloadWithNumber = assignReceiptNumber(servicePayload, String(nextNumber));
      const result = await FinancialService.createReceipt(username, payloadWithNumber, []);

      const syncedHamola = await OfficesService.syncHamolaFromReceiptRows(
        username,
        normalized.rows,
        result?.synced_hamola ?? null
      );
      if (result && typeof result === 'object') {
        result.synced_hamola = syncedHamola;
      }

      window.dispatchEvent(new CustomEvent('offices:changed'));
      if (warning) console.warn('[ReceiptsModule]', warning);
      return { result, normalized, warning, syncedHamola };
    } catch (err) {
      if (isConstraintError(err) && attempt < MAX_RETRIES) {
        const fresh = await allocateReceiptNumber(username);
        nextNumber = parseInt(fresh, 10);
        if (isNaN(nextNumber)) throw new Error('[ReceiptsModule] Invalid receipt number during retry');
        continue;
      }
      throw err;
    }
  }
}

// ─── PUBLIC: update ───────────────────────────────────────────────────────────

async function update(username, id, rawData) {
  if (!username) throw new Error('[ReceiptsModule:update] username is required.');
  if (!id)       throw new Error('[ReceiptsModule:update] id is required.');

  _validate(rawData);

  const normalized     = _normalize({ ...rawData, id });
  const servicePayload = _buildServicePayload(normalized);

  const result = await FinancialService.updateReceipt(username, id, servicePayload, []);

  const syncedHamola = await OfficesService.syncHamolaFromReceiptRows(
    username,
    normalized.rows,
    result?.synced_hamola ?? null
  );
  if (result && typeof result === 'object') {
    result.synced_hamola = syncedHamola;
  }

  window.dispatchEvent(new CustomEvent('offices:changed'));
  return { result, normalized, syncedHamola };
}

// ─── PUBLIC: delete ───────────────────────────────────────────────────────────

async function remove(username, id) {
  if (!username) throw new Error('[ReceiptsModule:delete] username is required.');
  if (!id)       throw new Error('[ReceiptsModule:delete] id is required.');

  const res = await FinancialService.deleteReceipt(username, id, []);
  window.dispatchEvent(new CustomEvent('receipts:changed'));
  window.dispatchEvent(new CustomEvent('offices:changed'));
  return res;
}

// ─── PUBLIC: getAll ───────────────────────────────────────────────────────────

async function getAll(username) {
  if (!username) throw new Error('[ReceiptsModule:getAll] username is required.');

  return await ReceiptRepository.getAll(username);
}

async function getByDateRange(username, from_date, to_date) {
  if (!username) throw new Error('[ReceiptsModule:getByDateRange] username is required.');
  const filters = {};
  if (from_date) filters.from_date = from_date;
  if (to_date) filters.to_date = to_date;
  return ReceiptRepository.findByFields(filters);
}

/**
 * Search receipts via the dedicated search.php endpoint.
 * Returns { data: receipt[], meta: { total, summary, options?, ... } }.
 *
 * Used exclusively by the All Receipts page (allReceipts.js).
 * Does NOT affect getAll() or getByDateRange() — those remain for
 * dashboard, home, entities, and receipt validation.
 */
async function searchReceipts(params = {}) {
  return ReceiptRepository.search(params);
}

// ─── PUBLIC: getClientBalance ─────────────────────────────────────────────

async function getClientBalance(client_id, client_type) {
  if (!client_type) throw new Error('[ReceiptsModule:getClientBalance] client_type is required.');
  return FinancialService.getClientBalance(client_id, client_type);
}

async function getClientLedger(client_id, client_type) {
  if (!client_type) throw new Error('[ReceiptsModule:getClientLedger] client_type is required.');
  return FinancialService.getClientLedger(client_id, client_type);
}

/**
 * Preview the next receipt number — reads from MySQL via API.
 */
async function peekNextReceiptNumber(username = null) {
  const owner = username || _currentUsername();
  if (!owner) throw new Error('[ReceiptsModule:peekNextReceiptNumber] username is required.');
  try {
    const res = await ApiClient.get('/financial/receipt-peek.php');
    if (res.success && res.data?.next_number != null) {
      return String(res.data.next_number);
    }
  } catch (_) { /* fallback to 1 on error */ }
  return '1';
}

/**
 * Reserve a receipt number — returns the preferred number or next available.
 * Actual allocation happens server-side in receipt-create.php.
 */
async function allocateReceiptNumber(username = null, preferred = null) {
  if (preferred != null && String(preferred).trim()) {
    return String(preferred).trim();
  }
  return peekNextReceiptNumber(username);
}


async function getReceiptByNumber(receipt_number) {
  if (!receipt_number) return null;
  const rows = await ReceiptRepository.findByFields({ receipt_number });
  return rows[0] || null;
}

async function getDrivers(username) {
  if (!username) throw new Error('[ReceiptsModule:getDrivers] username is required.');
  return ClientRepository.getDrivers(username);
}

async function saveDriverName(username, name) {
  if (!username) throw new Error('[ReceiptsModule:saveDriverName] username is required.');
  const n = String(name || '').trim();
  if (!n) return;
  const existing = await getDrivers(username);
  const alreadyExists = existing.some(d => String(d.name || '').toLowerCase() === n.toLowerCase());
  if (!alreadyExists) {
    await ClientRepository.addDriver({ username, name: n }, { username });
  }
}

async function getVehicleById(vehicle_id) {
  if (!vehicle_id) return null;
  return ClientRepository.getVehicleById(vehicle_id);
}

async function getVehiclesByPlate(plate) {
  const p = normalizeOptionalString(plate);
  if (!p) return [];
  return ClientRepository.getVehiclesByPlate(p);
}

async function getOfficesForUser(username) {
  if (!username) throw new Error('[ReceiptsModule:getOfficesForUser] username is required.');
  return OfficesService.getOffices(username);
}

async function getOffices(username) {
  return getOfficesForUser(username);
}

/**
 * Update the disbursement status ('paid' / 'تم صرفه' or 'unpaid' / 'لم يتم صرفه')
 * of a single row within a receipt without altering financial calculations or ledgers.
 */
async function updateRowStatus(username, receiptId, rowId, status) {
  if (!username) throw new Error('[ReceiptsModule:updateRowStatus] username is required.');
  if (!receiptId) throw new Error('[ReceiptsModule:updateRowStatus] receiptId is required.');
  if (!rowId) throw new Error('[ReceiptsModule:updateRowStatus] rowId is required.');
  return ReceiptRepository.updateRowStatus(receiptId, rowId, status, { username });
}

/**
 * Update the receipt-level payment status ('paid' / 'تم دفعه' or 'unpaid' / 'لم يتم دفعه')
 * of an entire receipt without altering row disbursement statuses, financial calculations,
 * or ledgers.
 */
async function updateReceiptPaymentStatus(username, receiptId, paymentStatus) {
  if (!username) throw new Error('[ReceiptsModule:updateReceiptPaymentStatus] username is required.');
  if (!receiptId) throw new Error('[ReceiptsModule:updateReceiptPaymentStatus] receiptId is required.');
  return ReceiptRepository.updateReceiptPaymentStatus(receiptId, paymentStatus, { username });
}

// ─── NAMED EXPORT ─────────────────────────────────────────────────────────

const ReceiptsModule = Object.freeze({
  create,
  update,
  delete : remove,
  updateRowStatus,
  updateReceiptPaymentStatus,
  getAll,
  getByDateRange,
  searchReceipts,
  getClientBalance,
  getClientLedger,
  peekNextReceiptNumber,
  allocateReceiptNumber,
  getReceiptByNumber,
  getDrivers,
  saveDriverName,
  getVehicleById,
  getVehiclesByPlate,
  getOfficesForUser,
  getOffices,
});



// ========================================
// Receipt Page — State / Rendering / Events
// ========================================

// ─── STATE ────────────────────────────────────────────────────────────────────

/** Session state for the receipt form — single object for future MySQL/API sync. */
const ReceiptState = {
  editingAccountType: null,
  editingPaymentStatus: null,
  editingReceiptId: null,
  isEditing: false,
};

function _resetReceiptEditingState() {
  ReceiptState.editingAccountType = null;
  ReceiptState.editingPaymentStatus = null;
  ReceiptState.editingReceiptId = null;
  ReceiptState.isEditing = false;
}

function _enterReceiptEditMode(receiptData) {
  ReceiptState.editingReceiptId = receiptData?.id ?? null;
  ReceiptState.editingAccountType = receiptData?.account_type ?? null;
  ReceiptState.editingPaymentStatus = receiptData ? getReceiptPaymentStatus(receiptData) : null;
  ReceiptState.isEditing = ReceiptState.editingReceiptId != null;
}

let receiptRowCounter = 0;
let _isSaving         = false;
let _clientsCache     = [];
const _vehicleAnalysisCache = new Map();

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const SEPARATOR_CLASS = 'vehicle-separator-row';

/**
 * COLUMN DEFINITIONS — Single source of truth for column order, headers, classes.
 * ترتيب جديد حسب المطلوب
 */
const COL_DEFS = [
  // index: 0
  { key: 'kartano',      label: 'رقم الكارتة',      cls: 'receipt-kartano',      type: 'text',   minW: '60px',  printHide: false },
  // index: 1
  { key: 'date',         label: 'التاريخ',            cls: 'receipt-date',         type: 'text',   minW: '60px',  printHide: false },
  // index: 2
  { key: 'data',         label: 'اسم السائق',         cls: 'receipt-data',         type: 'text',   minW: '90px',  printHide: false },
  // index: 3 (owner column removed — owner comes from clientInput)
  { key: 'car',          label: 'رقم المركبة',        cls: 'receipt-car',          type: 'text',   minW: '80px',  printHide: false },
  // index: 4
  { key: 'weight',       label: 'الوزن',              cls: 'receipt-weight',       type: 'number', minW: '55px',  printHide: false, printConditional: true },
  // index: 5
  { key: 'deficit',      label: 'عجز',                cls: 'receipt-deficit',      type: 'number', minW: '45px',  printHide: false },
  // index: 6  ← اسم المكتب (office) — مخفي في الطباعة (Feature 4)
  { key: 'office',       label: 'اسم المكتب',         cls: 'receipt-office',       type: 'text',   minW: '90px',  printHide: true  },
  // index: 7
  { key: 'loading',      label: 'التحميل',             cls: 'receipt-loading',      type: 'text',   minW: '85px',  printHide: false },
  // index: 8
  { key: 'taktik',       label: 'الجهة',              cls: 'receipt-taktik',       type: 'text',   minW: '85px',  printHide: false },
  // index: 9 ← النوع بعد الجهة
  { key: 'type',         label: 'النوع',              cls: 'receipt-type',         type: 'text',   minW: '50px',  printHide: false },
  // index: 10
  { key: 'noloon',       label: 'نولون',              cls: 'receipt-noloon',       type: 'number', minW: '55px',  printHide: false },
  // index: 11
  { key: 'ohda',         label: 'عهدة',               cls: 'receipt-ohda',         type: 'number', minW: '55px',  printHide: false },
  // index: 12
  { key: 'officeAmount', label: 'مكتب',               cls: 'receipt-office-amount',type: 'number', minW: '45px',  printHide: false },
  // index: 13
  { key: 'sarf',         label: 'الصرف',              cls: 'receipt-sarf',         type: 'number', minW: '45px',  printHide: false },
  // index: 14
  { key: 'add',          label: 'إضافة',              cls: 'receipt-add',          type: 'number', minW: '45px',  printHide: false, printConditional: true },
  // index: 15
  { key: 'net',          label: 'الصافي',             cls: 'receipt-net',          type: 'number', minW: '90px',  printHide: false, readonly: true },
  // index: 16 — إجراءات (no print)
  { key: '_actions',     label: 'إجراءات',            cls: '',                     type: 'actions',minW: '70px',  printHide: true  },
];

// عدد أعمدة البيانات (بدون إجراءات)
const DATA_COL_COUNT = COL_DEFS.filter(c => c.key !== '_actions').length; // 16

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function _currentUsername() {
  const session = AuthModule.getSession();
  if (!session?.username) {
    throw new Error('Username required');
  }
  return session.username;
}

function _field(row, cls) {
  const el = row.querySelector('.' + cls);
  return el ? el.value.trim() : '';
}

function _num(row, cls) {
  const el = row.querySelector('.' + cls);
  return parseFloat(el?.value) || 0;
}

/**
 * Converts the shortage (العجز) value in kilograms (e.g. 200)
 * into the ton calculation value (e.g. 0.2) by dividing by 1000.
 */
function convertShortageToCalculationValue(rawInput) {
  return shortageKgToTons(rawInput);
}

/**
 * Formats a persisted numeric value for display in a receipt form <input type="number">
 * without appending unnecessary '.00' suffixes or rounding/truncating decimal precision.
 * Empty, null, undefined, NaN, or 0 values return '' so the input shows its placeholder.
 */
function formatReceiptInputNumber(value) {
  if (value === '' || value === null || value === undefined) return '';
  const num = Number(value);
  if (!Number.isFinite(num) || num === 0) return '';
  return String(num);
}

/**
 * Formats a persisted shortage (العجز) value in kilograms (e.g. 200) for
 * display in the `.receipt-deficit` input when opening a receipt for editing.
 */
function formatShortageForInput(deficitKg) {
  return formatReceiptInputNumber(deficitKg);
}

function _deficitNum(row) {
  return _num(row, 'receipt-deficit');
}

function tFmt(n) { // delegated to Money.fmt
  return Money.fmt(n);
}

// ─── SEPARATOR ROW HTML ───────────────────────────────────────────────────────

function _separatorRowInnerHTML(subtotal, vehicleValue = '', notesValue = '') {
  const esc = String(vehicleValue ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const escNotes = String(notesValue ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const leftSpan = Math.min(5, DATA_COL_COUNT - 1);
  const rightSpan = DATA_COL_COUNT - leftSpan;

  return `
    <td colspan="${leftSpan}" class="px-2 py-2 bg-orange-50">
      <div class="flex items-center gap-2">
        <span class="text-orange-700 font-bold text-xs whitespace-nowrap">🔄 رقم المركبة:</span>
        <input type="text" class="separator-vehicle-name px-2 py-1 border-2 border-orange-400 rounded text-xs font-bold w-40 focus:ring-1 focus:ring-orange-500 outline-none bg-white"
          placeholder="أدخل رقم المركبة" value="${esc}">
      </div>
    </td>
    <td colspan="${rightSpan}" class="px-2 py-2 bg-orange-50 text-left">
      <div class="flex items-center gap-2 justify-end">
        <span class="text-orange-700 font-bold text-xs whitespace-nowrap">إجمالي ما سبق:</span>
        <span class="separator-subtotal text-orange-800 font-bold text-sm bg-orange-100 px-3 py-1 rounded border border-orange-300">${tFmt(Number(subtotal) || 0)}</span>
        <span class="text-orange-700 font-bold text-xs whitespace-nowrap">ملاحظات:</span>
        <input type="text" class="separator-notes px-2 py-1 border border-orange-300 rounded text-xs focus:ring-1 focus:ring-orange-400 outline-none bg-white"
          style="min-width:160px; flex:1;" placeholder="اكتب ملاحظة..." value="${escNotes}">
      </div>
    </td>
    <td colspan="1" class="px-1 py-1 text-center no-print bg-orange-50">
      <button type="button" data-action="remove-row" class="text-red-600 hover:text-red-800 transition" aria-label="حذف الفاصل">
        <svg width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
        </svg>
      </button>
    </td>`;
}

// ─── SNAPSHOT RENDERING (immutable persisted rows — allReceipts / print) ───────

function _snapshotEsc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Display-only: stable 2-decimal formatting without mutating stored values. */
function formatSnapshotNumber(value) {
  if (value === '' || value === null || value === undefined) return '';
  const n = Number(value);
  if (!Number.isFinite(n)) return _snapshotEsc(value);
  return tFmt(n);
}

function getSnapshotCellRawValue(row, col) {
  switch (col.key) {
    case 'kartano':
      return row.kartano ?? row.kartaNo ?? row.karta ?? '';
    case 'date':
      return row.date ?? row.rowdate ?? '';
    case 'data':
      return row.data ?? row.driver ?? '';
    case 'owner':
      return row.owner_name ?? '';
    case 'car': {
      // Guard: skip UUID values that may have been stored in car/vehicle_plate
      // fields in legacy data (vehicle_id leak).
      const _carVal = row.car ?? row.carNo ?? row.vehicle_plate ?? row.vehicle_no ?? '';
      if (typeof _carVal === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(_carVal)) return '';
      return _carVal;
    }
    case 'weight':
    case 'deficit':
      return row[col.key] ?? '';
    case 'office':
      return row.office ?? '';
    case 'loading':
      return row.loading ?? '';
    case 'taktik':
      return row.taktik ?? row.direction ?? '';
    case 'type':
      return row.type ?? '';
    case 'noloon':
    case 'ohda':
    case 'officeAmount':
    case 'add':
    case 'sarf':
    case 'net':
      return row[col.key] ?? '';
    default:
      return '';
  }
}

function formatSnapshotCellValue(row, col) {
  const raw = getSnapshotCellRawValue(row, col);
  if (col.key === 'add') {
    const val = parseFloat(raw) || 0;
    if (val === 0) {
      return '';
    }
  }
  if (col.key === 'noloon' || col.key === 'ohda' || col.key === 'officeAmount' || col.key === 'sarf' || col.key === 'deficit') {
    const n = Number(raw);
    if (Number.isFinite(n)) {
      if (Number.isInteger(n)) {
        return String(n);
      }
    }
  }
  if (col.type === 'number') return formatSnapshotNumber(raw);
  return _snapshotEsc(raw);
}

function renderReceiptSnapshotSeparatorRow(row, colSpan = DATA_COL_COUNT + 1) {
  const vehicleName = _snapshotEsc(row.vehicleName || '');
  const subtotal = tFmt(Number(row.subtotal) || 0);
  const notes = _snapshotEsc(row.notes || '');
  return `
    <tr class="${SEPARATOR_CLASS} vehicle-separator-row separator-row">
      <td colspan="${colSpan}" class="px-2 py-2 bg-orange-50">
        <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;">
          <span class="text-orange-700 font-bold text-xs"><strong>🔄 رقم المركبة:</strong> ${vehicleName}</span>
          <span class="text-orange-700 font-bold text-xs"><strong>إجمالي ما سبق:</strong> <span class="text-orange-800 font-bold">${subtotal}</span></span>
          ${notes ? `<span class="text-orange-700 font-bold text-xs"><strong>ملاحظات:</strong> ${notes}</span>` : ''}
        </div>
      </td>
    </tr>`;
}

function renderReceiptSnapshotDataRow(row, options = {}) {
  const showRowStatus = options.showRowStatus !== false;
  const readOnly = options.readOnly === true;
  const receiptId = options.receiptId ?? row?.receipt_id ?? '';
  const rowIndex = options.rowIndex ?? 0;
  const rowId = getStableRowId(row, receiptId, rowIndex);
  const rowStatus = getRowDisbursementStatus(row);

  const cells = COL_DEFS.filter((col) => col.key !== '_actions').map((col) => {
    const printClass = col.printHide ? ' no-print' : '';
    const align = col.type === 'number' ? 'center' : 'right';
    
    // Add specific visual style classes only for snapshot render
    let cellClass = '';
    if (col.key === 'weight') {
      cellClass = ' snapshot-cell-weight';
    } else if (col.key === 'noloon') {
      cellClass = ' snapshot-cell-noloon';
    } else if (col.key === 'ohda') {
      cellClass = ' snapshot-cell-ohda';
    } else if (col.key === 'net') {
      cellClass = ' snapshot-cell-net';
    }
    
    return `<td class="px-1 py-1 text-${align}${printClass}${cellClass}">${formatSnapshotCellValue(row, col)}</td>`;
  }).join('');

  let statusCell = '';
  if (showRowStatus) {
    const isPaid = rowStatus === ROW_DISBURSEMENT_STATUS.PAID;
    if (readOnly) {
      const label = getRowDisbursementStatusLabel(rowStatus);
      const bg = isPaid ? '#059669' : '#dc2626';
      statusCell = `<td class="px-1 py-1 text-center no-print snapshot-cell-status"><span class="row-status-badge" data-row-status="${_snapshotEsc(rowStatus)}" style="background:${bg};color:#fff;padding:2px 8px;border-radius:999px;font-size:0.75rem;font-weight:700;">${_snapshotEsc(label)}</span></td>`;
    } else {
      const border = isPaid ? '#059669' : '#dc2626';
      const bg = isPaid ? '#ecfdf5' : '#fef2f2';
      const fg = isPaid ? '#065f46' : '#991b1b';
      statusCell = `<td class="px-1 py-1 text-center no-print snapshot-cell-status"><div class="row-status-control" style="display:inline-flex;align-items:center;gap:4px;"><select class="row-status-select" data-action="toggle-row-status" data-receipt-id="${_snapshotEsc(receiptId)}" data-row-id="${_snapshotEsc(rowId)}" data-prev-status="${_snapshotEsc(rowStatus)}" aria-label="الحالة" style="padding:2px 6px;border-radius:6px;font-size:0.75rem;font-weight:700;border:1px solid ${border};background:${bg};color:${fg};cursor:pointer;"><option value="${ROW_DISBURSEMENT_STATUS.PAID}" ${isPaid ? 'selected' : ''}>تم صرفه</option><option value="${ROW_DISBURSEMENT_STATUS.UNPAID}" ${!isPaid ? 'selected' : ''}>لم يتم صرفه</option></select><span class="row-status-feedback" data-row-feedback="${_snapshotEsc(rowId)}" style="font-size:0.75rem;min-width:14px;display:inline-block;"></span></div></td>`;
    }
  }

  return `<tr data-row-id="${_snapshotEsc(rowId)}" data-receipt-id="${_snapshotEsc(receiptId)}" data-row-status="${_snapshotEsc(rowStatus)}">${cells}${statusCell}</tr>`;
}

function renderReceiptSnapshotTableHead(options = {}) {
  const showRowStatus = options.showRowStatus !== false;
  const baseHeaders = COL_DEFS.filter((col) => col.key !== '_actions').map((col) => {
    const printClass = col.printHide ? ' no-print' : '';
    return `<th class="px-1 py-2 text-center${printClass}" style="min-width:${col.minW};">${col.label}</th>`;
  }).join('');
  const statusHeader = showRowStatus
    ? `<th class="px-1 py-2 text-center no-print" style="min-width:115px;">الحالة</th>`
    : '';
  return `${baseHeaders}${statusHeader}`;
}

/**
 * Renders persisted receipt rows as an immutable HTML snapshot (no recalculation).
 * @param {object[]} rows
 * @param {{ colSpan?: number, showRowStatus?: boolean, receiptId?: string|number, readOnly?: boolean }} [options]
 */
function renderReceiptSnapshotRowsHtml(rows, options = {}) {
  const showRowStatus = options.showRowStatus !== false;
  const colSpan = options.colSpan ?? (showRowStatus ? DATA_COL_COUNT + 1 : DATA_COL_COUNT);
  if (!Array.isArray(rows) || rows.length === 0) return '';
  return rows.map((row, idx) => {
    if (row && row._type === 'separator') {
      return renderReceiptSnapshotSeparatorRow(row, colSpan);
    }
    return renderReceiptSnapshotDataRow(row, { ...options, rowIndex: idx });
  }).join('');
}

// ─── RENDER: HEADER ───────────────────────────────────────────────────────────

function renderHeader() {
  return `
    <div class="flex items-center justify-between mb-4 no-print" style="padding: 24px 24px 0 24px;">
      <h2 class="text-2xl font-bold text-gray-800" style="margin:0;">نموذج الصرف</h2>
    </div>
    <div class="no-print" style="padding: 12px 24px 0 24px;"></div>`;
}

// ─── RENDER: META FIELDS ──────────────────────────────────────────────────────

function renderMetaFields() {
  return `
    <div id="receiptDateOwner" class="grid grid-cols-1 md:grid-cols-3 gap-4 p-4 rounded-lg" style="margin-bottom: -15px;">
      <div>
        <label class="block text-sm font-semibold text-gray-700 mb-2">التاريخ</label>
        <input id="receiptDate" type="date"
          class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none">
      </div>
      <div id="receiptClientFieldWrap">
        <label class="block text-sm font-semibold text-gray-700 mb-2">صاحب المركبة</label>
        <div class="relative">
          <input id="clientInput" type="text" list="clientsList"
            class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
            placeholder="اختر من القائمة أو اتركه فارغاً"
            autocomplete="off">
          <datalist id="clientsList"></datalist>
          <datalist id="officesList"></datalist>
        </div>
      </div>
      <div>
        <label class="block text-sm font-semibold text-gray-700 mb-2">إذن الصرف</label>
        <input id="receiptNumber" type="text" readonly tabindex="-1"
          class="w-full px-4 py-2 border border-gray-200 rounded-lg text-gray-700 font-bold outline-none"
          placeholder="">
      </div>
    </div>
    <datalist id="ownersList"></datalist>`;
}

// ─── RENDER: TABLE ────────────────────────────────────────────────────────────

/**
 * بناء صف الأسهم (fill-column-down) من COL_DEFS
 * الأسهم تكون على كل عمود بيانات فقط (ليس الإجراءات)
 */
function _buildArrowRowHTML() {
  const cells = COL_DEFS.map((col, i) => {
    if (col.key === '_actions') {
      // خلية فارغة لعمود الإجراءات
      return `<td class="no-print receipt-arrow-cell receipt-arrow-cell--empty"></td>`;
    }
    return `<td class="no-print receipt-arrow-cell">
      <button
        data-action="fill-column-down"
        data-col-index="${i}"
        class="receipt-arrow-btn"
        title="نسخ للأسفل في عمود: ${col.label}"
        aria-label="نسخ عمود ${col.label} للأسفل"
      >⬇</button>
    </td>`;
  }).join('');
  return cells;
}

function renderTable() {
  // بناء رؤوس الأعمدة من COL_DEFS
  const headers = COL_DEFS.map(col => {
    const printClass = col.printHide ? ' no-print' : '';
    return `<th class="px-1 py-2 text-center${printClass}" style="min-width:${col.minW};">${col.label}</th>`;
  }).join('');

  return `
    <div style="overflow-x:auto; overflow-y:visible; width:100%;" class="receipt-table-wrapper">
      <table class="text-xs" id="receiptTable" style="table-layout:auto; width:100%; border-collapse:collapse;">
        <thead class="bg-gradient-to-r from-blue-600 to-blue-700 text-white">
          <tr>
            ${headers}
          </tr>
        </thead>
        <tbody id="receiptTableBody">
          <tr id="receiptFillArrowRow">${_buildArrowRowHTML()}</tr>
        </tbody>
      </table>
    </div>`;
}

function ensureReceiptArrowRow() {
  const tbody = document.getElementById('receiptTableBody');
  if (!tbody) return;
  if (tbody.querySelector('#receiptFillArrowRow')) return;

  const row = document.createElement('tr');
  row.id = 'receiptFillArrowRow';
  row.innerHTML = _buildArrowRowHTML();
  tbody.insertBefore(row, tbody.firstChild);
}

// ─── RENDER: TABLE HEADER WITH BUTTONS (نقل الأزرار لداخل header الجدول) ─────

function renderTableSectionHeader() {
  return `
    <div class="receipt-table-header no-print" style="
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: linear-gradient(to left, #1e40af, #1e3a8a);
      border-radius: 10px 10px 0 0;
      padding: 10px 16px;
      margin-bottom: 0;
    ">
      <h3 style="
        color: #fff;
        font-size: 1rem;
        font-weight: 700;
        margin: 0;
        display: flex;
        align-items: center;
        gap: 6px;
      ">
        <svg width="18" height="18" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="opacity:.85;">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M3 10h18M3 6h18M3 14h18M3 18h18"/>
        </svg>
        جدول الصرف
      </h3>
      <div style="display:flex; gap:8px; align-items:center;">
        <button type="button" data-action="organize-vehicles"
          class="receipt-header-btn"
          style="background: linear-gradient(135deg, #0284c7, #0369a1); font-weight:700;"
          title="تنظيم المركبات وإضافة الفواصل تلقائياً">
          🔄 تنظيم المركبات
        </button>
        <button type="button" data-action="add-row"
          class="receipt-header-btn receipt-header-btn--green"
          title="إضافة صف جديد">
          <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
          </svg>
          إضافة صف
        </button>
        <button type="button" data-action="add-4-rows"
          class="receipt-header-btn receipt-header-btn--blue"
          title="إضافة 4 صفوف دفعة واحدة">
          <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
          </svg>
          إضافة 4 صفوف
        </button>
        <button type="button" data-action="export-receipt-excel"
          class="receipt-header-btn receipt-header-btn--teal"
          title="تصدير الصفوف إلى Excel">
          <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"/>
          </svg>
          📤 تصدير Excel
        </button>
        <button type="button" data-action="import-receipt-excel"
          class="receipt-header-btn receipt-header-btn--violet"
          title="استيراد صفوف من Excel">
          <svg width="15" height="15" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0l-4 4m4-4v12"/>
          </svg>
          📥 استيراد Excel
        </button>
      </div>
    </div>`;
}

// ─── RENDER: FOOTER ACTIONS ───────────────────────────────────────────────────

function renderFooterActions() {
  return `
    <div class="flex flex-wrap gap-2 no-print" style="margin-top: 12px;">
      <button type="button" data-action="save-receipt"
        class="bg-gradient-to-r from-blue-600 to-blue-700 hover:shadow-lg text-white px-8 py-3 rounded-lg transition flex items-center gap-2 font-semibold">
        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"/>
        </svg>
        حفظ النموذج
      </button>
      <button type="button" data-action="print-receipt"
        class="bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg transition flex items-center gap-2">
        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
        </svg>
        طباعة
      </button>
      <button type="button" data-action="clear-receipt"
        class="bg-gray-500 hover:bg-gray-600 text-white px-6 py-3 rounded-lg transition">
        مسح النموذج
      </button>
      <button type="button" id="cancelEditBtn" data-action="cancel-edit"
        class="hidden bg-red-500 hover:bg-red-600 text-white px-6 py-3 rounded-lg transition flex items-center gap-2 font-semibold">
        <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
        </svg>
        إلغاء التعديل
      </button>
    </div>`;
}

// ─── RENDER: TOTALS FOOTER ────────────────────────────────────────────────────

function renderTotals() {
  return `
    <div id="finalTotalsContainer"
      style="background:#f8fafc;border-radius:10px;padding:12px;margin-bottom:20px;display:flex;gap:8px;align-items:stretch;overflow-x:auto;">
      <div class="totals-frame totals-frame--main"
        style="flex:1.35;min-width:520px;border:1px solid #d1d5db;border-radius:8px;background:#fff;overflow:hidden;">
        <table class="totals-table" style="width:100%;border-collapse:collapse;table-layout:fixed;">
          <tr>
            <td class="totals-cell" style="background:#6b7280;color:white;border:1px solid #e5e7eb;padding:8px;text-align:center;">
              <div style="font-size:10px;opacity:.9;margin:0 0 4px 0;">عدد الكارتات</div>
              <div style="font-size:18px;font-weight:bold;margin:0;" id="rowCount">0</div>
            </td>
            <td class="totals-cell" style="background:#7c3aed;color:white;border:1px solid #e5e7eb;padding:8px;text-align:center;">
              <div style="font-size:10px;opacity:.9;margin:0 0 4px 0;">الإجمالي</div>
              <div style="font-size:18px;font-weight:bold;margin:0;" id="totalAmount">0.00</div>
            </td>

            <td class="totals-cell" style="background:#16a34a;color:white;border:1px solid #e5e7eb;padding:8px;text-align:center;">
              <div style="font-size:10px;opacity:.9;margin:0 0 4px 0;">إضافة عام</div>
              <input type="number" id="generalAdd" value="0" min="0" step="0.01"
                style="width:100%;background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);border-radius:6px;padding:3px 6px;font-size:15px;font-weight:bold;color:white;text-align:center;box-sizing:border-box;">
            </td>
            <td class="totals-cell" style="background:#0d9488;color:white;border:1px solid #e5e7eb;padding:8px;text-align:center;">
              <div style="font-size:10px;opacity:.9;margin:0 0 4px 0;">الصافي المستحق</div>
              <div style="font-size:18px;font-weight:bold;margin:0;" id="netDueAmount">0.00</div>
            </td>
          </tr>
        </table>
      </div>
      <div class="totals-frame totals-frame--side"
        style="flex:1;min-width:340px;border:1px solid #d1d5db;border-radius:8px;background:#fff;overflow:hidden;">
        <table class="totals-table" style="width:100%;border-collapse:collapse;table-layout:fixed;">
          <tr>
            <td class="totals-cell" style="background:#2563eb;color:white;border:1px solid #e5e7eb;padding:8px;text-align:center;">
              <div style="font-size:10px;opacity:.9;margin:0 0 4px 0;">رصيد العميل</div>
              <div style="font-size:18px;font-weight:bold;margin:0;" id="receiptBalance" data-previous="0">0.00</div>
            </td>
            <td class="totals-cell" style="background:#0ea5e9;color:white;border:1px solid #e5e7eb;padding:8px;text-align:center;">
              <div style="font-size:10px;opacity:.9;margin:0 0 4px 0;">الصافي الكلي</div>
              <div style="font-size:18px;font-weight:bold;margin:0;" id="netTotalAmount">0.00</div>
            </td>
            <td class="totals-cell" style="background:#16a34a;color:white;border:1px solid #e5e7eb;padding:8px;text-align:center;">
              <div style="font-size:10px;opacity:.9;margin:0 0 4px 0;">المدفوع</div>
              <input type="number" id="paidAmount" value="0" min="0" step="0.01" data-auto="1"
                style="width:100%;background:rgba(255,255,255,0.2);border:1px solid rgba(255,255,255,0.4);border-radius:6px;padding:3px 6px;font-size:15px;font-weight:bold;color:white;text-align:center;box-sizing:border-box;">
            </td>
          </tr>
        </table>
      </div>
    </div>`;
}

// ─── RENDER: COMPOSE & INJECT ─────────────────────────────────────────────────

function renderReceiptPage() {
  const page = document.getElementById('receiptPage');
  if (!page) return;

  page.innerHTML = `
    <div class="bg-white rounded-t-xl shadow-lg p-6 pb-0">
      ${renderHeader()}
      <div class="overflow-hidden" style="margin-top: -10px;">
        <img id="receiptHeaderImage" src="wasel.png" alt="Header" class="w-full h-24 object-cover">
      </div>
      ${renderMetaFields()}
    </div>
    <div class="bg-white overflow-hidden" style="padding: 16px 24px 0 24px;">
      ${renderTableSectionHeader()}
      ${renderTable()}
    </div>
    <div class="bg-white" style="padding: 16px 24px;">
      ${renderTotals()}
      ${renderFooterActions()}
    </div>`;

  document.getElementById('receiptSaveWithdrawModal')?.remove();

  // Print + UI styles
  _injectReceiptStyles();
}

// ─── INJECT STYLES ────────────────────────────────────────────────────────────

function _injectReceiptStyles() {
  if (document.getElementById('receipt-module-styles')) return;

  const style = document.createElement('style');
  style.id = 'receipt-module-styles';
  style.textContent = `
    /* ═══ ARROW ROW CELLS ═══ */
    .receipt-arrow-cell {
      background: #5083f1d2;
      padding: 0;
      text-align: center;
      height: 28px;
    }
    .receipt-arrow-cell--empty {
      background: #5083f1d2;
    }

    /* ═══ ARROW BUTTON — مستطيل يملأ الخانة ═══ */
    .receipt-arrow-btn {
      display: block;
      width: 100%;
      height: 100%;
      min-height: 26px;
      background: rgba(255,255,255,0.18);
      border: none;
      border-left: 1px solid rgba(255,255,255,0.25);
      color: #fff;
      font-size: 13px;
      font-weight: bold;
      cursor: pointer;
      transition: background 0.15s ease;
      line-height: 26px;
      padding: 0;
      text-align: center;
      font-family: inherit;
    }
    .receipt-arrow-btn:hover {
      background: rgba(255,255,255,0.35);
    }
    .receipt-arrow-btn:active {
      background: rgba(255,255,255,0.50);
    }

    /* ═══ TABLE SECTION HEADER BUTTONS ═══ */
    .receipt-header-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 6px 12px;
      border: none;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      white-space: nowrap;
      transition: all 0.15s ease;
      color: #fff;
    }
    .receipt-header-btn--green  { background: #16a34a; }
    .receipt-header-btn--green:hover  { background: #15803d; }
    .receipt-header-btn--blue   { background: #2563eb; }
    .receipt-header-btn--blue:hover   { background: #1d4ed8; }
    .receipt-header-btn--orange { background: #ea580c; }
    .receipt-header-btn--orange:hover { background: #c2410c; }
    .receipt-header-btn--teal   { background: #0f766e; }
    .receipt-header-btn--teal:hover   { background: #0d6b63; }
    .receipt-header-btn--violet { background: #7c3aed; }
    .receipt-header-btn--violet:hover { background: #6d28d9; }

    /* ═══ ACTIONS COLUMN BUTTONS ═══ */
    .row-action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      transition: all 0.15s;
      padding: 0;
      flex-shrink: 0;
    }
    .row-action-btn--delete  { background: #fee2e2; color: #dc2626; }
    .row-action-btn--delete:hover  { background: #dc2626; color: #fff; }
    .row-action-btn--add     { background: #dcfce7; color: #16a34a; }
    .row-action-btn--add:hover     { background: #16a34a; color: #fff; }
    .row-action-btn--sep     { background: #fff7ed; color: #ea580c; }
    .row-action-btn--sep:hover     { background: #ea580c; color: #fff; }

        /* ═══ KEYBOARD NAV FOCUS ═══ */
    .receipt-cell-focused {
      outline: 2px solid #3b82f6 !important;
      outline-offset: -1px;
      background: #eff6ff !important;
    }

    /* ═══ SARF FIELD VISUAL HIGHLIGHT ═══ */
    #receiptPage .receipt-sarf,
    #receiptPage .receipt-sarf-highlight {
      background-color: #fffbeb !important;
      border: 1.5px solid #f59e0b !important;
      color: #78350f !important;
      font-weight: 600;
    }
    #receiptPage .receipt-sarf:focus,
    #receiptPage .receipt-sarf-highlight:focus {
      background-color: #fef3c7 !important;
      border-color: #d97706 !important;
      box-shadow: 0 0 0 2px rgba(245, 158, 11, 0.25) !important;
    }

    /* ═══ SNAPSHOT COLUMNS VISUAL ENHANCEMENTS ═══ */
    .record-table .snapshot-cell-weight { background-color: #f0fdf4 !important; color: #166534 !important; font-weight: 600; }
    .record-table .snapshot-cell-noloon { background-color: #eff6ff !important; color: #1e40af !important; font-weight: 600; }
    .record-table .snapshot-cell-ohda   { background-color: #fff7ed !important; color: #c2410c !important; font-weight: 600; }
    .record-table .snapshot-cell-net    { background-color: #f5f3ff !important; color: #6d28d9 !important; font-weight: 700; }

    @media print {
      .record-table .snapshot-cell-weight,
      .record-table .snapshot-cell-noloon,
      .record-table .snapshot-cell-ohda,
      .record-table .snapshot-cell-net {
        background-color: transparent !important;
        color: #000 !important;
        font-weight: normal !important;
      }
    }
  `;
  document.head.appendChild(style);
}

// ─── INITIALIZATION ───────────────────────────────────────────────────────────

function setCurrentDate() {
  const today = DateUtils.todayLocal();
  const el    = document.getElementById('receiptDate');
  if (el) el.value = today;
}

async function generateReceiptNumber() {
  const el = document.getElementById('receiptNumber');
  if (!el || ReceiptState.isEditing) return;
  el.value = await ReceiptsModule.peekNextReceiptNumber();
}

function _assertCriticalSaveInputs(username, rawData) {
  if (!username) throw new Error('username missing');
  if (!rawData?.client_id) throw new Error('client_id missing');
  if (!Array.isArray(rawData?.rows) || rawData.rows.length === 0) throw new Error('rows missing');
}




// ─── OWNER ↔ CAR LINKING ──────────────────────────────────────────────────────

// _linkCarToOwner / _linkOwnerToCar / _setRowOwnerDatalist / _setRowCarDatalist
// removed — owner column no longer in receipt table (owner = clientInput)


// ─── RECEIPT: CAR → DRIVER LINKING ────────────────────────────────────────────

async function _receiptLinkCarToDriver(row) {
  if (!row) return;
  const carInput = row.querySelector('.receipt-car');
  const driverInput = row.querySelector('.receipt-data');
  if (!carInput || !driverInput) return;
  const plate = (carInput.value || '').trim();
  if (!plate) return;

  const vehicles = await ReceiptsModule.getVehiclesByPlate(plate);
  if (vehicles.length === 0) return;

  const v = vehicles[0];
  // Auto-fill driver from vehicle if empty
  if (v.driver_name && !driverInput.value.trim()) {
    driverInput.value = v.driver_name;
  }
}

async function _receiptPopulateClientVehicles() {
  // ── Step 1: Clear datalists ───────────────────────────────────────────────
  let carDl = document.getElementById('receiptClientCarsDL');
  if (carDl) carDl.innerHTML = '';

  let driverDl = document.getElementById('receiptClientDriversDL');
  if (driverDl) driverDl.innerHTML = '';

  // ── Step 2: Clear input values (car + driver) in all rows ────────────────
  document.querySelectorAll('#receiptTableBody tr:not(.vehicle-separator-row):not(#receiptFillArrowRow)').forEach(row => {
    const carInp = row.querySelector('.receipt-car');
    if (carInp) carInp.value = '';
    const driverInp = row.querySelector('.receipt-data');
    if (driverInp) driverInp.value = '';
  });

  // ── Step 3: Validate — check selected client ─────────────────────────────
  const client = _selectedClient();
  if (!client) return;

  const vehicles = await OwnersModule.getOwnerVehicles(client.id);
  if (vehicles.length === 0) return;

  // ── Step 4: Populate datalists with new client's data ────────────────────
  const plates = vehicles.map(v => v.plate).filter(Boolean);
  const drivers = [...new Set(vehicles.map(v => v.driver_name).filter(Boolean))];

  if (!carDl) {
    carDl = document.createElement('datalist');
    carDl.id = 'receiptClientCarsDL';
    document.body.appendChild(carDl);
  }
  carDl.innerHTML = plates.map(p => `<option value="${p}"></option>`).join('');

  if (!driverDl) {
    driverDl = document.createElement('datalist');
    driverDl.id = 'receiptClientDriversDL';
    document.body.appendChild(driverDl);
  }
  driverDl.innerHTML = drivers.map(d => `<option value="${d}"></option>`).join('');

  // Apply datalists to all car/driver inputs
  document.querySelectorAll('#receiptTableBody .receipt-car').forEach(inp => {
    inp.setAttribute('list', 'receiptClientCarsDL');
  });
  document.querySelectorAll('#receiptTableBody .receipt-data').forEach(inp => {
    inp.setAttribute('list', 'receiptClientDriversDL');
  });

  // ── Step 5: Auto-fill if exactly 1 vehicle ───────────────────────────────
  if (vehicles.length === 1) {
    const firstRow = document.querySelector('#receiptTableBody tr:not(.vehicle-separator-row):not(#receiptFillArrowRow)');
    if (firstRow) {
      const carInp = firstRow.querySelector('.receipt-car');
      if (carInp) carInp.value = vehicles[0].plate || '';
      const driverInp = firstRow.querySelector('.receipt-data');
      if (driverInp && vehicles[0].driver_name) driverInp.value = vehicles[0].driver_name;
    }
  }
}

async function loadClientsList() {
  // Vehicle owners only (exclude brokers)
  const allOwners = (await OwnersModule.getAllOwners())
    .filter(o => o.deleted_at === null && o.owner_type !== 'broker')
    .map(o => ({
      id: String(o.id),
      type: 'owner',
      name: o.name || '',
      label: `${o.name || ''} `,
      record: o,
    }));

  _clientsCache = allOwners.filter(c => c.name);
  const list = document.getElementById('clientsList');
  if (!list) return;
  list.innerHTML = _clientsCache
    .map(c => `<option value="${c.label}" data-id="${c.id}" data-type="${c.type}"></option>`)
    .join('');
}

function _selectedClient() {
  const value = document.getElementById('clientInput')?.value.trim() || '';
  if (!value) return null;
  return _clientsCache.find(c => c.label === value || (c.name === value && _clientsCache.filter(x => x.name === value).length === 1)) || null;
}

async function updateSelectedClientBalance() {
  // Edit mode: previous_balance is locked to the saved value.
  // Overwriting it with the LIVE client balance would duplicate it
  // in net_total (bug: 0 → 50 → net_total doubles on save-without-change).
  if (ReceiptState.isEditing) return;

  const client = _selectedClient();
  const balEl = document.getElementById('receiptBalance');
  if (!balEl) return;
  if (!client) {
    balEl.dataset.previous = '0';
    calculateTotals();
    return;
  }
  const snapshot = await ReceiptsModule.getClientBalance(client.id, client.type || 'owner');
  // Only carry forward NEGATIVE balance (customer owes us).
  // Positive balance (we owe customer) does NOT carry forward between receipts.
  const liveBalance = snapshot.balance || 0;
  balEl.dataset.previous = String(liveBalance < 0 ? liveBalance : 0);
  calculateTotals();
  await refreshVehicleWarnings();
}

async function loadOfficesForReceipt() {
  const username = _currentUsername();
  if (!username) return;
  const offices = await ReceiptsModule.getOffices(username);
  const dl      = document.getElementById('officesList');
  if (dl) dl.innerHTML = offices.map(o => `<option value="${o.name}">`).join('');
}

async function loadDriversDatalist() {
  const username = _currentUsername();
  if (!username) return;
  let dl = document.getElementById('driversList');
  if (!dl) {
    dl    = document.createElement('datalist');
    dl.id = 'driversList';
    document.body.appendChild(dl);
  }
  const drivers = await ReceiptsModule.getDrivers(username);
  dl.innerHTML  = drivers.map(d => `<option value="${d.name}">`).join('');
}

async function _uiSaveDriverName(name) {
  const username = _currentUsername();
  if (!name || !username) return;
  name = name.trim();
  if (!name) return;
  await ReceiptsModule.saveDriverName(username, name);
}

// ─── ROW TEMPLATE (from COL_DEFS) ────────────────────────────────────────────

function _buildRowHTML() {
  const cells = COL_DEFS.map(col => {
    const printClass = col.printHide ? ' no-print' : '';

    if (col.key === '_actions') {
      return `
        <td class="px-1 py-1 text-center no-print receipt-actions-cell">
          <div style="display:flex;gap:3px;justify-content:center;align-items:center;flex-wrap:nowrap;">
            <button type="button"
              data-action="remove-row"
              class="row-action-btn row-action-btn--delete"
              title="حذف الصف"
              aria-label="حذف الصف">
              <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
              </svg>
            </button>
            <button type="button"
              data-action="add-row-after"
              class="row-action-btn row-action-btn--add"
              title="إضافة صف أسفل هذا الصف"
              aria-label="إضافة صف أسفل">
              <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
              </svg>
            </button>
            <button type="button"
              data-action="add-separator-after"
              class="row-action-btn row-action-btn--sep"
              title="إضافة صف مركبة أسفل هذا الصف"
              aria-label="إضافة صف مركبة أسفل">
              <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"/>
              </svg>
            </button>
          </div>
        </td>`;
    }

    if (col.key === 'net') {
      return `
        <td class="px-1 py-1 text-center${printClass}">
          <input type="number"
            class="${col.cls} w-full px-1 py-1 border border-gray-300 rounded bg-blue-50 text-xs font-semibold text-blue-900"
            readonly value="0">
        </td>`;
    }

    // owner column removed — warning moved to car column

    if (col.key === 'data') {
      return `
        <td class="px-1 py-1 text-center${printClass}">
          <input type="text" list="driversList"
            class="${col.cls} w-full px-1 py-1 border border-gray-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none">
        </td>`;
    }

    if (col.key === 'office') {
      return `
        <td class="px-1 py-1 text-center${printClass}">
          <input type="text" list="officesList"
            class="${col.cls} w-full px-1 py-1 border border-gray-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none"
            placeholder="المكتب">
        </td>`;
    }

    // Car field with warning message (moved from owner column)
    if (col.key === 'car') {
      return `
        <td class="px-1 py-1 text-center${printClass}">
          <input type="text"
            class="${col.cls} w-full px-1 py-1 border border-gray-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none"
            placeholder="رقم المركبة">
          <div class="vehicle-owner-warning-msg field-msg-inline field-msg-inline--warn" role="status"></div>
        </td>`;
    }

    if (col.key === 'sarf') {
      return `
        <td class="px-1 py-1 text-center receipt-sarf-cell${printClass}">
          <input type="number"
            class="${col.cls} receipt-sarf-highlight w-full px-1 py-1 border border-amber-400 bg-amber-50 rounded text-xs font-semibold text-amber-950 focus:ring-2 focus:ring-amber-500 focus:border-amber-500 outline-none"
            placeholder="0">
        </td>`;
    }

    // تحديد نوع input من COL_DEFS
    const inputType = col.type === 'number' ? 'number' : 'text';
    const placeholder = col.type === 'number' ? '0' : '';

    return `
      <td class="px-1 py-1 text-center${printClass}">
        <input type="${inputType}"
          class="${col.cls} w-full px-1 py-1 border border-gray-300 rounded text-xs focus:ring-1 focus:ring-blue-500 outline-none"
          ${placeholder ? `placeholder="${placeholder}"` : ''}>
      </td>`;
  }).join('');

  return cells;
}

// ─── ROW LOGIC ────────────────────────────────────────────────────────────────

function addReceiptRow(count = 1) {
  const tbody = document.getElementById('receiptTableBody');
  for (let i = 0; i < count; i++) {
    receiptRowCounter++;
    const newRow = document.createElement('tr');
    newRow.innerHTML = _buildRowHTML();
    tbody.appendChild(newRow);
    newRow.dataset.calcAttached = '1';
    attachRowCalculation(newRow);
    fillFromPreviousRow(newRow);
    attachKeyboardNav(newRow);
    attachInputRestrictions(newRow);
    // Apply client's vehicle/driver datalists to new row
    const clientCarsDL = document.getElementById('receiptClientCarsDL');
    const clientDriversDL = document.getElementById('receiptClientDriversDL');
    if (clientCarsDL) newRow.querySelector('.receipt-car')?.setAttribute('list', 'receiptClientCarsDL');
    if (clientDriversDL) newRow.querySelector('.receipt-data')?.setAttribute('list', 'receiptClientDriversDL');
  }
  ensureReceiptArrowRow();
  updateRowNumbers();
}

/**
 * إضافة صف عادي أسفل صف محدد
 */
function addRowAfter(refRow) {
  const tbody = document.getElementById('receiptTableBody');
  receiptRowCounter++;
  const newRow = document.createElement('tr');
  newRow.innerHTML = _buildRowHTML();

  // إدراج بعد refRow مباشرة
  if (refRow.nextSibling) {
    tbody.insertBefore(newRow, refRow.nextSibling);
  } else {
    tbody.appendChild(newRow);
  }

  newRow.dataset.calcAttached = '1';
  attachRowCalculation(newRow);
  attachKeyboardNav(newRow);
  attachInputRestrictions(newRow);
  ensureReceiptArrowRow();
  updateRowNumbers();

  // Focus على أول input في الصف الجديد
  const firstInput = newRow.querySelector('input:not([readonly])');
  if (firstInput) firstInput.focus();
}

/**
 * إضافة صف مركبة (separator) أسفل صف محدد
 */
function addSeparatorAfter(refRow) {
  const tbody = document.getElementById('receiptTableBody');

  // حساب subtotal من الصفوف السابقة حتى refRow
  const allRows = [...tbody.querySelectorAll('tr')];
  let subtotal = 0;
  let startIdx = 0;
  for (let i = 0; i < allRows.length; i++) {
    if (allRows[i].classList.contains(SEPARATOR_CLASS)) {
      startIdx = i + 1;
    }
    if (allRows[i] === refRow) break;
  }
  for (let i = startIdx; i < allRows.length; i++) {
    if (allRows[i] === refRow || allRows[i].compareDocumentPosition(refRow) & Node.DOCUMENT_POSITION_FOLLOWING) {
      if (!allRows[i].classList.contains(SEPARATOR_CLASS) && allRows[i].id !== 'receiptFillArrowRow') {
        subtotal += parseFloat(allRows[i].querySelector('.receipt-net')?.value) || 0;
      }
    }
    if (allRows[i] === refRow) break;
  }

  const sepRow = document.createElement('tr');
  sepRow.className = `${SEPARATOR_CLASS} table-sep-row`;
  sepRow.innerHTML = _separatorRowInnerHTML(subtotal);

  if (refRow.nextSibling) {
    tbody.insertBefore(sepRow, refRow.nextSibling);
  } else {
    tbody.appendChild(sepRow);
  }

  // إضافة صف عادي بعد الفاصل
  addRowAfter(sepRow);
  updateRowNumbers();
  calculateTotals();
}

function removeReceiptRow(btn) {
  const tbody = document.getElementById('receiptTableBody');
  const dataRows = [...tbody.querySelectorAll('tr')].filter(r => r.id !== 'receiptFillArrowRow');
  if (dataRows.length > 1) {
    btn.closest('tr').remove();
    updateRowNumbers();
    calculateTotals();
  } else {
    alert('يجب الاحتفاظ بصف واحد على الأقل');
  }
}

function updateRowNumbers() {
  const rows        = [...document.querySelectorAll('#receiptTableBody tr')]
    .filter(r => !r.classList.contains(SEPARATOR_CLASS));
  receiptRowCounter = rows.length;
  calculateTotals();
}

function fillFromPreviousRow(newRow) {
  const tbody    = document.getElementById('receiptTableBody');
  const dataRows = [...tbody.querySelectorAll('tr')].filter(r => !r.classList.contains(SEPARATOR_CLASS) && r.id !== 'receiptFillArrowRow');
  if (dataRows.length >= 2) {
    const prevRow = dataRows[dataRows.length - 2];
    const carEl   = newRow.querySelector('.receipt-car');
    const dataEl  = newRow.querySelector('.receipt-data');
    if (carEl)   carEl.value   = prevRow.querySelector('.receipt-car')?.value   || '';
    if (dataEl)  dataEl.value  = prevRow.querySelector('.receipt-data')?.value  || '';
  }
}

function addVehicleChangeRow() {
  const tbody   = document.getElementById('receiptTableBody');
  const allRows = [...tbody.querySelectorAll('tr')];

  let subtotal = 0;
  let startIdx = 0;
  for (let i = allRows.length - 1; i >= 0; i--) {
    if (allRows[i].classList.contains(SEPARATOR_CLASS)) { startIdx = i + 1; break; }
  }
  for (let i = startIdx; i < allRows.length; i++) {
    if (!allRows[i].classList.contains(SEPARATOR_CLASS) && allRows[i].id !== 'receiptFillArrowRow') {
      subtotal += parseFloat(allRows[i].querySelector('.receipt-net')?.value) || 0;
    }
  }

  // Feature 2: أخذ رقم المركبة من آخر صف بيانات قبل الفاصل
  const dataRowsBefore = allRows.filter(r =>
    r.id !== 'receiptFillArrowRow' && !r.classList.contains(SEPARATOR_CLASS)
  );
  const lastCarValue = dataRowsBefore.length > 0
    ? (dataRowsBefore[dataRowsBefore.length - 1].querySelector('.receipt-car')?.value || '')
    : '';

  const sepRow = document.createElement('tr');
  sepRow.className = `${SEPARATOR_CLASS} table-sep-row`;
  sepRow.innerHTML = _separatorRowInnerHTML(subtotal, lastCarValue);
  tbody.appendChild(sepRow);
  addReceiptRow(1);
}

// ─── CALCULATIONS ─────────────────────────────────────────────────────────────

function attachRowCalculation(row) {
  if (!row || row.classList.contains(SEPARATOR_CLASS)) return;

  const weight    = row.querySelector('.receipt-weight');
  const deficit   = row.querySelector('.receipt-deficit');
  const noloon    = row.querySelector('.receipt-noloon');
  const ohda      = row.querySelector('.receipt-ohda');
  const officeAmt = row.querySelector('.receipt-office-amount');
  const add       = row.querySelector('.receipt-add');
  const sarf      = row.querySelector('.receipt-sarf');
  const net       = row.querySelector('.receipt-net');
  const officeInp = row.querySelector('.receipt-office');
  const loadingInp = row.querySelector('.receipt-loading');
  const taktikInp  = row.querySelector('.receipt-taktik');

  if (!net) return;

  function calculateNet() {
    const w1   = parseFloat(weight?.value)    || 0;
    const d    = parseFloat(deficit?.value)   || 0;
    const n    = parseFloat(noloon?.value)    || 0;
    const o    = parseFloat(ohda?.value)      || 0;
    const of_  = parseFloat(officeAmt?.value) || 0;
    const a    = parseFloat(add?.value)       || 0;
    const s    = parseFloat(sarf?.value)      || 0;

    // Delegate row net calculation directly to financialCalculator
    const rowObj = {
      weight: w1,
      deficit: d,
      noloon: n,
      ohda: o,
      officeAmount: of_,
      add: a,
      sarf: s,
    };
    net.value = Money.fmt(calculateRowNet(rowObj));
    calculateTotals();
  }

  weight    && weight.addEventListener('input',    calculateNet);
  deficit   && deficit.addEventListener('input',   calculateNet);
  noloon    && noloon.addEventListener('input',    calculateNet);
  ohda      && ohda.addEventListener('input',      calculateNet);
  officeAmt && officeAmt.addEventListener('input', calculateNet);
  add       && add.addEventListener('input',       calculateNet);
  sarf      && sarf.addEventListener('input',      calculateNet);

  // ── Office → loading / taktik / type / noloon autofill (Bidirectional) ──

  const typeInp = row.querySelector('.receipt-type');

  async function getOfficeHamolaForRow(officeName) {
    const key = OfficesService.normalizeCargoKey(officeName);
    if (!key) return [];
    const username = _currentUsername();
    if (!username) return [];
    const offices = await ReceiptsModule.getOffices(username);
    const office  = offices.find(o => OfficesService.normalizeCargoKey(o.name) === key);
    if (!office?.id) return [];
    return office?.hamolaRows || [];
  }

  function setDL(id, values) {
    if (typeof document === 'undefined') return;
    let dl = document.getElementById(id);
    if (!dl) { dl = document.createElement('datalist'); dl.id = id; document.body.appendChild(dl); }
    dl.innerHTML = values.map(v => `<option value="${v}"></option>`).join('');
  }

  async function bindOfficeHamolaToRow(officeName, { preserveExistingValues = false } = {}) {
    const hamola = await getOfficeHamolaForRow(officeName);
    const loadVals = [...new Set(
      hamola.map(r => OfficesService.normalizeCargoText(r.loading_place || r.loading || '')).filter(Boolean)
    )];
    const allDirVals = [...new Set(
      hamola.map(r => OfficesService.normalizeCargoText(r.destination_place || r.direction || r.taktik || '')).filter(Boolean)
    )];
    const allTypeVals = [...new Set(
      hamola.map(r => OfficesService.normalizeCargoText(r.item_type || r.type || '')).filter(Boolean)
    )];

    const uid = row._dlUid || ('r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5));
    row._dlUid = uid;
    row._loadDlId = 'dl_rl_' + uid;
    row._dirDlId  = 'dl_rd_' + uid;
    row._typeDlId = 'dl_rt_' + uid;
    row._hamolaData = hamola;

    setDL(row._loadDlId, loadVals);
    if (loadingInp) loadingInp.setAttribute('list', row._loadDlId);
    setDL(row._dirDlId, allDirVals);
    if (taktikInp) taktikInp.setAttribute('list', row._dirDlId);
    setDL(row._typeDlId, allTypeVals);
    if (typeInp) typeInp.setAttribute('list', row._typeDlId);

    if (!preserveExistingValues) {
      // Clear previous office's selections so invalid values from a prior office are never retained
      if (loadingInp) loadingInp.value = '';
      if (taktikInp)  taktikInp.value  = '';
      if (typeInp)    typeInp.value    = '';
      row._lastAutoFilledTaktik = null;
      row._lastAutoFilledType   = null;

      // Auto-fill loading when only ONE valid option exists for the new office
      if (loadVals.length === 1 && loadingInp) {
        loadingInp.value = loadVals[0];
      }
    }

    // ── Rebuild destination list when loading changes (non-restrictive) ──
    function _rebuildDirList(isInitialPreserved = false) {
      const selectedLoadKey = OfficesService.normalizeCargoKey(loadingInp?.value || '');
      const matchingLoadRows = selectedLoadKey
        ? hamola.filter(r => OfficesService.normalizeCargoKey(r.loading_place || r.loading || '') === selectedLoadKey)
        : [];

      const newDirVals = matchingLoadRows.length > 0
        ? [...new Set(
            matchingLoadRows
              .map(r => OfficesService.normalizeCargoText(r.destination_place || r.direction || r.taktik || ''))
              .filter(Boolean)
          )]
        : allDirVals;

      setDL(row._dirDlId, newDirVals);
      row._currentDirVals = newDirVals;

      if (isInitialPreserved || !taktikInp) return;

      if (matchingLoadRows.length > 0) {
        if (newDirVals.length === 1 && (!taktikInp.value.trim() || taktikInp.value === row._lastAutoFilledTaktik)) {
          taktikInp.value = newDirVals[0];
          row._lastAutoFilledTaktik = newDirVals[0];
        } else if (
          row._lastAutoFilledTaktik
          && taktikInp.value === row._lastAutoFilledTaktik
          && !newDirVals.some(v => OfficesService.normalizeCargoKey(v) === OfficesService.normalizeCargoKey(taktikInp.value))
        ) {
          taktikInp.value = '';
          row._lastAutoFilledTaktik = null;
        }
      } else if (row._lastAutoFilledTaktik && taktikInp.value === row._lastAutoFilledTaktik) {
        // User changed loading to a custom value — clear stale auto-filled destination
        taktikInp.value = '';
        row._lastAutoFilledTaktik = null;
      }
    }

    // ── autoFillNoloon: populate noloon / officeAmount / type when route exists in hamola ──
    function autoFillNoloon(isInitialPreserved = false) {
      const loadKey   = OfficesService.normalizeCargoKey(loadingInp?.value || '');
      const taktikKey = OfficesService.normalizeCargoKey(taktikInp?.value || '');
      const matchingRouteRows = (loadKey && taktikKey)
        ? hamola.filter(h =>
            OfficesService.normalizeCargoKey(h.loading_place || h.loading || '') === loadKey
            && OfficesService.normalizeCargoKey(h.destination_place || h.direction || h.taktik || '') === taktikKey
          )
        : [];

      const routeTypeVals = matchingRouteRows.length > 0
        ? [...new Set(
            matchingRouteRows
              .map(r => OfficesService.normalizeCargoText(r.item_type || r.type || ''))
              .filter(Boolean)
          )]
        : allTypeVals;
      setDL(row._typeDlId, routeTypeVals.length > 0 ? routeTypeVals : allTypeVals);

      if (isInitialPreserved || matchingRouteRows.length === 0) return;

      const currentTypeKey = OfficesService.normalizeCargoKey(typeInp?.value || '');
      const matchRow = (
        currentTypeKey &&
        matchingRouteRows.find(h => OfficesService.normalizeCargoKey(h.item_type || h.type || '') === currentTypeKey)
      ) || matchingRouteRows[0];

      if (!matchRow) return;

      // النولون — display raw stored value (no forced .toFixed(2))
      const noloonRaw = matchRow.nolon ?? matchRow.noloon;
      const noloonVal = parseFloat(noloonRaw) || 0;
      const noloonInp = row.querySelector('.receipt-noloon');
      if (noloonInp && noloonVal > 0) {
        noloonInp.value = formatReceiptInputNumber(noloonRaw);
        noloonInp.dispatchEvent(new Event('input'));
      }
      // المكتب — display raw stored value (no forced .toFixed(2))
      const maktabRaw = matchRow.office_amount ?? matchRow.maktab;
      const maktabVal = parseFloat(maktabRaw) || 0;
      const maktabInp = row.querySelector('.receipt-office-amount');
      if (maktabInp && maktabVal > 0) {
        maktabInp.value = formatReceiptInputNumber(maktabRaw);
        maktabInp.dispatchEvent(new Event('input'));
      }
      // النوع — auto-fill when empty or previously auto-filled
      const typeVal = OfficesService.normalizeCargoText(matchRow.item_type ?? matchRow.type ?? '');
      if (typeInp && typeVal && (!typeInp.value.trim() || typeInp.value === row._lastAutoFilledType)) {
        typeInp.value = typeVal;
        row._lastAutoFilledType = typeVal;
      }
    }

    // Remove any legacy blur handlers if present
    [loadingInp, taktikInp].forEach(function (inp, idx) {
      if (!inp) return;
      const prevBlurKey = idx === 0 ? '_blurHandlerLoading' : '_blurHandlerTaktik';
      if (row[prevBlurKey]) {
        inp.removeEventListener('blur', row[prevBlurKey]);
        row[prevBlurKey] = null;
      }
    });

    // Remove previous change listeners before re-adding
    if (row._autoFillLoadingHandler && loadingInp) {
      loadingInp.removeEventListener('change', row._autoFillLoadingHandler);
    }
    if (row._rebuildDirHandler && loadingInp) {
      loadingInp.removeEventListener('change', row._rebuildDirHandler);
    }
    if (row._autoFillTaktikHandler && taktikInp) {
      taktikInp.removeEventListener('change', row._autoFillTaktikHandler);
    }

    function _onLoadingChange() {
      _rebuildDirList(false);
      autoFillNoloon(false);
    }
    function _onTaktikChange() {
      autoFillNoloon(false);
    }

    row._rebuildDirHandler      = _onLoadingChange;
    row._autoFillLoadingHandler = _onLoadingChange;
    row._autoFillTaktikHandler  = _onTaktikChange;
    if (loadingInp) loadingInp.addEventListener('change', _onLoadingChange);
    if (taktikInp)  taktikInp.addEventListener('change',  _onTaktikChange);

    if (preserveExistingValues) {
      _rebuildDirList(true);
      autoFillNoloon(true);
    } else if (loadVals.length === 1) {
      _rebuildDirList(false);
      autoFillNoloon(false);
    }
  }

  if (officeInp) {
    officeInp.addEventListener('change', async function () {
      await bindOfficeHamolaToRow(this.value, { preserveExistingValues: false });
    });
    if (officeInp.value && officeInp.value.trim()) {
      bindOfficeHamolaToRow(officeInp.value, { preserveExistingValues: true });
    }
  }
}

function calculateTotals() {
  const rows = [...document.querySelectorAll('#receiptTableBody tr')];
  
  // Map DOM rows to plain objects for the calculator
  const rowObjs = rows
    .filter(row => row.id !== 'receiptFillArrowRow' && !row.classList.contains(SEPARATOR_CLASS))
    .map(row => ({
      weight: parseFloat(row.querySelector('.receipt-weight')?.value) || 0,
      deficit: parseFloat(row.querySelector('.receipt-deficit')?.value) || 0,
      noloon: parseFloat(row.querySelector('.receipt-noloon')?.value) || 0,
      ohda: parseFloat(row.querySelector('.receipt-ohda')?.value) || 0,
      officeAmount: parseFloat(row.querySelector('.receipt-office-amount')?.value) || 0,
      add: parseFloat(row.querySelector('.receipt-add')?.value) || 0,
      sarf: parseFloat(row.querySelector('.receipt-sarf')?.value) || 0,
    }));

  const addEl = document.getElementById('generalAdd');
  const add = parseFloat(addEl?.value) || 0;

  const balEl = document.getElementById('receiptBalance');
  const previousBalance = parseFloat(balEl?.dataset.previous || '0') || 0;

  const paidEl = document.getElementById('paidAmount');
  const paidAuto = paidEl ? paidEl.dataset.auto !== '0' : true;
  
  // Calculate using our unified financial calculator!
  const calcs = calculateReceiptTotals(rowObjs, add, previousBalance, 0);
  const total = calcs.total;
  const netDue = calcs.net_due;
  const netTotal = calcs.net_total;

  const totalEl = document.getElementById('totalAmount');
  if (totalEl) totalEl.textContent = Money.fmt(total);

  const dataRows = rows.filter(r => r.id !== 'receiptFillArrowRow' && !r.classList.contains(SEPARATOR_CLASS));
  const rowCountEl = document.getElementById('rowCount');
  if (rowCountEl) rowCountEl.textContent = dataRows.length;

  // separator subtotals
  let sectionTotal = 0;
  rows.forEach(row => {
    if (row.classList.contains(SEPARATOR_CLASS)) {
      const subtotalEl = row.querySelector('.separator-subtotal');
      if (subtotalEl) subtotalEl.textContent = Money.fmt(sectionTotal);
      sectionTotal = 0;
    } else if (row.id !== 'receiptFillArrowRow') {
      sectionTotal += parseFloat(row.querySelector('.receipt-net')?.value) || 0;
    }
  });

  const netEl = document.getElementById('netDueAmount');
  if (netEl) netEl.textContent = Money.fmt(netDue);

  const netTotalEl = document.getElementById('netTotalAmount');
  if (netTotalEl) netTotalEl.textContent = Money.fmt(netTotal);

  if (paidEl && paidAuto) {
    const autoMode = paidEl.dataset.auto;
    if (autoMode === 'advance') {
      // Preserve advance offset: paid = netTotal - offset (clamped ≥ 0)
      const offset = parseFloat(paidEl.dataset.advanceOffset) || 0;
      paidEl.value = Money.fmt(Math.max(0, netTotal - offset));
    } else {
      paidEl.value = Money.fmt(netTotal);
    }
  }
  const paid = parseFloat(paidEl?.value) || 0;
  const projectedBalance = netTotal - paid;

  // Show: previous balance when no rows yet, projected balance otherwise
  if (balEl) {
    if (total === 0 && previousBalance !== 0) {
      balEl.textContent = Money.fmt(previousBalance);
    } else {
      balEl.textContent = Money.fmt(projectedBalance);
    }
  }
}

// ─── FILL COLUMN DOWN ─────────────────────────────────────────────────────────

function fillColumnDown(colIndex) {
  const rows = [...document.querySelectorAll('#receiptTableBody tr')]
    .filter(r => r.id !== 'receiptFillArrowRow' && !r.classList.contains(SEPARATOR_CLASS));

  if (rows.length < 2) return;

  // Find the last row that has a value in this column
  let sourceRowIdx = -1;
  let sourceVal = '';
  for (let i = rows.length - 1; i >= 0; i--) {
    const cell = [...rows[i].querySelectorAll('td')][colIndex];
    const inp = cell?.querySelector('input');
    if (inp && inp.value.trim() !== '') {
      sourceRowIdx = i;
      sourceVal = inp.value;
      break;
    }
  }

  if (!sourceVal || sourceRowIdx === -1) return;

  // Copy to the NEXT row only
  const nextIdx = sourceRowIdx + 1;
  if (nextIdx >= rows.length) return;

  const nextCell = [...rows[nextIdx].querySelectorAll('td')][colIndex];
  const nextInp = nextCell?.querySelector('input');
  if (nextInp) {
    nextInp.value = sourceVal;
    nextInp.dispatchEvent(new Event('input'));
  }
}

// ─── KEYBOARD NAVIGATION ──────────────────────────────────────────────────────

/**
 * التنقل بالكيبورد داخل الجدول
 * ← → : داخل نفس الصف
 * ↑ ↓ : بين الصفوف
 * Enter : ينتقل للخانة التالية أفقياً (Feature 5) حتى receipt-add ثم أول خانة في الصف التالي
 */
function attachKeyboardNav(row) {
  if (!row || row.classList.contains(SEPARATOR_CLASS)) return;
  // Guard: prevent duplicate listeners
  if (row.dataset.kbNavBound === '1') return;
  row.dataset.kbNavBound = '1';

  row.addEventListener('keydown', function (e) {
    // Skip IME composition (Arabic typing, etc.)
    if (e.isComposing) return;

    const activeEl = document.activeElement;
    if (!activeEl || !row.contains(activeEl)) return;

    const key = e.key;
    // Enter: let browser/datalist handle naturally — no interception
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) return;

    // Skip arrow interception if input has active datalist showing
    if (activeEl.list && (key === 'ArrowUp' || key === 'ArrowDown')) return;

    // ArrowLeft/Right: navigate between cells (only when cursor is at edge)
    if (key === 'ArrowRight' || key === 'ArrowLeft') {
      // For text inputs: only navigate if cursor is at the boundary
      if (activeEl.type === 'text' || activeEl.type === 'search') {
        const len = (activeEl.value || '').length;
        const pos = activeEl.selectionStart ?? len;
        if (key === 'ArrowRight' && pos > 0) return; // let cursor move inside text
        if (key === 'ArrowLeft' && pos < len) return; // let cursor move inside text
      }

      e.preventDefault();
      const inputs = _getNavigableInputs(row);
      const currentIdx = inputs.indexOf(activeEl);
      if (currentIdx === -1) return;

      if (key === 'ArrowRight') {
        const prevIdx = currentIdx - 1;
        if (prevIdx >= 0) inputs[prevIdx].focus();
      } else {
        const nextIdx = currentIdx + 1;
        if (nextIdx < inputs.length) inputs[nextIdx].focus();
      }
      return;
    }

    // ArrowUp/Down: navigate between rows vertically
    e.preventDefault();
    _focusVertical(row, activeEl, key === 'ArrowUp' ? -1 : 1);
  });
}

function _getNavigableInputs(row) {
  return [...row.querySelectorAll('input, select')].filter(el => {
    if (el.disabled || el.readOnly) return false;
    if (el.closest('.no-print') && el.type !== 'text' && el.type !== 'number') return false;
    return true;
  });
}

function _focusVertical(currentRow, activeEl, direction) {
  const tbody = document.getElementById('receiptTableBody');
  if (!tbody) return;

  // الحصول على index الـ td الحالي
  const currentTd = activeEl.closest('td');
  if (!currentTd) return;
  const tdIdx = [...currentRow.querySelectorAll('td')].indexOf(currentTd);

  // الحصول على الصفوف القابلة للتنقل
  const allRows = [...tbody.querySelectorAll('tr')].filter(r =>
    r.id !== 'receiptFillArrowRow' && !r.classList.contains(SEPARATOR_CLASS)
  );
  const rowIdx = allRows.indexOf(currentRow);
  const targetRowIdx = rowIdx + direction;

  if (targetRowIdx < 0 || targetRowIdx >= allRows.length) return;

  const targetRow = allRows[targetRowIdx];
  const targetTds = [...targetRow.querySelectorAll('td')];
  const targetTd  = targetTds[tdIdx];
  if (!targetTd) return;

  const targetInput = targetTd.querySelector('input:not([readonly]), select');
  if (targetInput) targetInput.focus();
}

// ─── INPUT RESTRICTIONS ───────────────────────────────────────────────────────

/**
 * تطبيق قيود الإدخال على الخانات الرقمية
 * منع الأحرف غير المسموحة بدون alerts
 */
function attachInputRestrictions(row) {
  if (!row || row.classList.contains(SEPARATOR_CLASS)) return;

  // الحقول الرقمية — منع الأحرف النصية
  const numericClasses = [
    'receipt-weight', 'receipt-deficit',
    'receipt-noloon', 'receipt-ohda', 'receipt-office-amount',
    'receipt-add', 'receipt-sarf', 'receipt-net',
  ];

  numericClasses.forEach(cls => {
    const el = row.querySelector('.' + cls);
    if (!el) return;

    el.addEventListener('keypress', function (e) {
      const char = e.key;
      // السماح: أرقام، نقطة عشرية، علامة سالب، مفاتيح تحكم
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (['Backspace', 'Delete', 'Tab', 'Enter', 'ArrowLeft', 'ArrowRight',
           'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(char)) return;
      if (!/[\d.\-]/.test(char)) {
        e.preventDefault();
      }
    });

    el.addEventListener('paste', function (e) {
      const text = e.clipboardData?.getData('text') || '';
      if (!/^-?\d*\.?\d*$/.test(text.trim())) {
        e.preventDefault();
      }
    });
  });
}

// ─── VEHICLE OWNER → PREVIOUS BALANCE ────────────────────────────────────────

async function _onClientChange(input) {
  document.getElementById('clientWarningMsg')?.remove();
  const client = _selectedClient();

  if (input.value.trim() && !client) {
    const warn = document.createElement('div');
    warn.id = 'clientWarningMsg';
    warn.className = 'alert alert-warning mb-0 mt-2';
    warn.textContent = '⚠️ اسم العميل غير موجود في القائمة، برجاء الاختيار من القائمة.';
    document.getElementById('receiptClientFieldWrap')?.appendChild(warn);
  }

  await updateSelectedClientBalance();
  // Ensure vehicle datalists refresh even when updateSelectedClientBalance
  // exits early (e.g. no client selected). _receiptPopulateClientVehicles
  // is the single owner of the datalist lifecycle (Clear → Validate → Populate)
  // and is safe to call multiple times — it always clears first.
  await _receiptPopulateClientVehicles();
}

async function _getVehicleAnalysis(vehicleId) {
  const key = String(vehicleId || '');
  if (!key) return null;
  if (_vehicleAnalysisCache.has(key)) return _vehicleAnalysisCache.get(key);

  const vehicle = await ReceiptsModule.getVehicleById(key);
  if (!vehicle?.owner_id) {
    const missing = { vehicle, owner: null, balance: null };
    _vehicleAnalysisCache.set(key, missing);
    return missing;
  }

  let owner = await OwnersModule.getOwnerById(String(vehicle.owner_id));
  if (!owner) {
    const client = _selectedClient();
    if (client) {
      owner = client;
    }
  }
  const balance = await ReceiptsModule.getClientBalance(String(vehicle.owner_id), 'owner');
  const analysis = { vehicle, owner, balance };
  _vehicleAnalysisCache.set(key, analysis);
  return analysis;
}

async function _onVehicleCrossOwnerWarning(row) {
  if (!row || row.classList.contains(SEPARATOR_CLASS)) return;

  const plate = normalizeOptionalString(_field(row, 'receipt-car'));
  const warnEl = row.querySelector('.vehicle-owner-warning-msg');
  if (warnEl) {
    warnEl.textContent = '';
    warnEl.classList.remove('is-visible');
  }
  if (!plate || !warnEl) return;

  const selectedClient = _selectedClient();
  if (!selectedClient) return;

  const existing = await ReceiptsModule.getVehiclesByPlate(plate);
  const vehicle = existing[0] || null;
  if (!vehicle?.id) return;

  const analysis = await _getVehicleAnalysis(vehicle.id);
  const ownerId = analysis?.vehicle?.owner_id ? String(analysis.vehicle.owner_id) : '';
  const balance = analysis?.balance?.balance || 0;
  if (!ownerId || ownerId === String(selectedClient.id)) return;

  const ownerName = analysis?.owner?.name || analysis?.vehicle?.owner_name || 'المالك';
  if (balance < 0) {
    warnEl.textContent = `⚠️ هذه المركبة تخص العميل (${ownerName}) عليه مديونية ${Money.fmt(Math.abs(balance))} جنيه`;
  } else {
    warnEl.textContent = `⚠️ هذه المركبة مسجلة باسم: ${ownerName}`;
  }
  warnEl.classList.add('is-visible');
}

async function refreshVehicleWarnings() {
  const rows = [...document.querySelectorAll('#receiptTableBody tr')]
    .filter(row => !row.classList.contains(SEPARATOR_CLASS));
  await Promise.all(rows.map(row => _onVehicleCrossOwnerWarning(row)));
}

// ─── OFFICE VALIDATION ────────────────────────────────────────────────────────

async function _onOfficeValidation(input) {
  const officeName = input.value.trim();
  if (!officeName) {
    input.classList.remove('input-error');
    input.parentElement.querySelector('.office-warning-msg')?.remove();
    return;
  }
  const username = _currentUsername();
  const offices  = await ReceiptsModule.getOffices(username);
  const found    = offices.some(o => o.name === officeName);
  input.parentElement.querySelector('.office-warning-msg')?.remove();
  if (!found) {
    input.classList.add('input-error');
    const warn = document.createElement('div');
    warn.className = 'office-warning-msg field-msg-inline field-msg-inline--error is-visible';
    warn.textContent = '⚠️ غير موجود في القائمة';
    input.parentElement.appendChild(warn);
  } else {
    input.classList.remove('input-error');
  }
}

// ─── AUTO VEHICLE SEPARATOR RECONCILIATION ────────────────────────────────────

// ─── AUTO VEHICLE SEPARATOR RECONCILIATION ────────────────────────────────────

function groupDataRowsStably(dataRows) {
  const order = [];
  const groups = {}; // carValue -> array of rows
  
  for (const row of dataRows) {
    const carVal = row.carValue;
    if (!groups[carVal]) {
      groups[carVal] = [];
      order.push(carVal);
    }
    groups[carVal].push(row);
  }
  
  const sorted = [];
  for (const carVal of order) {
    sorted.push(...groups[carVal]);
  }
  
  return sorted;
}

function reconcileVehicleSeparators() {
  const tbody = document.getElementById('receiptTableBody');
  if (!tbody) return;

  const rows = [...tbody.querySelectorAll('tr')];
  
  // Step 1: Parse rows into sections separated by manual separators
  const sections = [];
  let currentSection = [];

  for (const tr of rows) {
    if (tr.id === 'receiptFillArrowRow') continue;

    if (tr.classList.contains(SEPARATOR_CLASS)) {
      const isAuto = tr.dataset.auto === '1';
      const vehicleName = tr.querySelector('.separator-vehicle-name')?.value || '';
      const subtotal = tr.querySelector('.separator-subtotal')?.textContent || '0.00';
      const notes = tr.querySelector('.separator-notes')?.value || '';

      if (isAuto) {
        // Automatically delete old auto-generated separators
        tr.remove();
      } else {
        // Manual separator acts as a boundary!
        sections.push({
          type: 'data-section',
          rows: currentSection
        });
        currentSection = [];
        
        // Push the manual separator itself
        sections.push({
          type: 'separator-manual',
          element: tr,
          vehicleName,
          subtotal,
          notes
        });
      }
    } else {
      // Data row
      const carValue = tr.querySelector('.receipt-car')?.value || '';
      currentSection.push({
        type: 'data',
        element: tr,
        carValue: carValue.trim()
      });
    }
  }
  
  // Push the final section
  sections.push({
    type: 'data-section',
    rows: currentSection
  });

  // Step 2: For each data-section, perform stable grouping
  const finalSequence = [];

  for (const sec of sections) {
    if (sec.type === 'separator-manual') {
      finalSequence.push(sec);
    } else {
      // It is a data-section. Let's group its data rows stably!
      const groupedRows = groupDataRowsStably(sec.rows);
      
      // Now, let's insert auto-separators between different vehicles in this section!
      let lastVehicle = '';
      for (const current of groupedRows) {
        const currentVehicle = current.carValue;

        // Check if we need to insert an auto separator
        if (
          lastVehicle !== '' &&
          currentVehicle !== '' &&
          currentVehicle !== lastVehicle
        ) {
          const lastAdded = finalSequence[finalSequence.length - 1];
          if (lastAdded && lastAdded.type !== 'separator-manual' && lastAdded.type !== 'separator-auto') {
            // Calculate the subtotal of the previous group
            let subtotal = 0;
            for (let j = finalSequence.length - 1; j >= 0; j--) {
              const fs = finalSequence[j];
              if (fs.type === 'separator-manual' || fs.type === 'separator-auto') {
                break;
              }
              subtotal += parseFloat(fs.element.querySelector('.receipt-net')?.value) || 0;
            }

            finalSequence.push({
              type: 'separator-auto',
              vehicleName: lastVehicle,
              subtotal: Money.fmt(subtotal),
              notes: ''
            });
          }
        }

        finalSequence.push(current);
        if (currentVehicle !== '') {
          lastVehicle = currentVehicle;
        }
      }
    }
  }

  // Clear tbody completely (except arrow row)
  const arrowRow = document.getElementById('receiptFillArrowRow');
  while (tbody.firstChild) {
    tbody.removeChild(tbody.firstChild);
  }

  if (arrowRow) {
    tbody.appendChild(arrowRow);
  }

  // Re-append items in the final sequence
  for (const item of finalSequence) {
    if (item.type === 'separator-manual') {
      tbody.appendChild(item.element);
    } else if (item.type === 'separator-auto') {
      const sepRow = document.createElement('tr');
      sepRow.className = `${SEPARATOR_CLASS} table-sep-row`;
      sepRow.dataset.auto = '1'; // Mark as auto-generated
      sepRow.innerHTML = _separatorRowInnerHTML(item.subtotal, item.vehicleName, '');
      tbody.appendChild(sepRow);
    } else {
      tbody.appendChild(item.element);
    }
  }

  // Recalculate totals and refresh UI
  calculateTotals();
}

// ─── COLLECT DATA FROM DOM ────────────────────────────────────────────────────

async function collectReceiptRows() {
  const rows        = document.querySelectorAll('#receiptTableBody tr');
  const receiptRows = [];
  const owners = await OwnersModule.getAllOwners();

  for (const row of rows) {
    if (row.id === 'receiptFillArrowRow') continue;

    if (row.classList.contains(SEPARATOR_CLASS)) {
      const vehicleName = normalizeOptionalString(row.querySelector('.separator-vehicle-name')?.value);
      const subtotal    = parseFloat(row.querySelector('.separator-subtotal')?.textContent) || 0;
      const notes       = normalizeOptionalString(row.querySelector('.separator-notes')?.value);
      const isAuto      = row.dataset.auto === '1';
      receiptRows.push({ _type: 'separator', vehicleName, subtotal, notes, isAuto });
      continue;
    }

    const plate = normalizeOptionalString(_field(row, 'receipt-car'));
    // Owner comes from clientInput (top of form), not from each row
    const client = _selectedClient();
    if (!client) {
      throw new Error('يجب اختيار العميل أولاً');
    }
    let clientOwner = owners.find(o => o.id === client.id);
    if (!clientOwner && client) {
      clientOwner = { id: client.id, name: client.name };
    }
    const vehicle = await VehiclesModule.resolveVehicle(_currentUsername(), plate, clientOwner);
    if (!vehicle?.owner_id) {
      throw new Error('يجب أن تكون كل مركبة مرتبطة بمالك مركبة مسجل');
    }
    // Save driver_name to vehicle record if typed in form
    const typedDriver = normalizeOptionalString(_field(row, 'receipt-data'));
    if (typedDriver && vehicle.id && typedDriver !== (vehicle.driver_name || '')) {
      try {
        await DBProvider.update('vehicles', vehicle.id, { driver_name: typedDriver }, { username: _currentUsername() });
        vehicle.driver_name = typedDriver;
      } catch(_e) { /* silent — non-critical */ }
    }
    let vehicleOwner = await OwnersModule.getOwnerById(String(vehicle.owner_id));
    if (!vehicleOwner && clientOwner) {
      vehicleOwner = clientOwner;
      try {
        await DBProvider.update('vehicles', vehicle.id, {
          owner_id: String(clientOwner.id),
          owner_name: clientOwner.name || null,
        }, { username: _currentUsername() });
      } catch (_) {}
    }
    if (!vehicleOwner) {
      throw new Error('مالك المركبة غير موجود أو تم حذفه');
    }
    const finalOwner = vehicleOwner;

    const preservedRowId = row.dataset?.rowId ? String(row.dataset.rowId).trim() : null;
    const preservedStatus = row.dataset?.disbursementStatus
      ? getRowDisbursementStatus({ disbursement_status: row.dataset.disbursementStatus })
      : ROW_DISBURSEMENT_STATUS.UNPAID;

    receiptRows.push({
      _type              : 'data',
      ...(preservedRowId ? { _rowId: preservedRowId, row_id: preservedRowId } : {}),
      disbursement_status: preservedStatus,
      payout_status      : preservedStatus,
      rowPayment         : preservedStatus,
      owner_id           : String(finalOwner.id),
      owner_name         : finalOwner.name,
      kartano      : normalizeOptionalString(_field(row, 'receipt-kartano')),
      date         : normalizeOptionalString(_field(row, 'receipt-date')),
      data         : normalizeOptionalString(_field(row, 'receipt-data')),
      driver_name  : normalizeOptionalString(_field(row, 'receipt-data')) || vehicle.driver_name || null,
      car          : vehicle.plate,
      vehicle_id   : vehicle.id,
      vehicle_plate: vehicle.plate,
      bolsa        : null, // محذوف من الواجهة — نحفظ null للتوافق مع البيانات القديمة
      loading      : normalizeOptionalString(_field(row, 'receipt-loading')),
      taktik       : normalizeOptionalString(_field(row, 'receipt-taktik')),
      type         : normalizeOptionalString(_field(row, 'receipt-type')),
      office       : normalizeOptionalString(_field(row, 'receipt-office')),
      weight       : _num(row, 'receipt-weight'),
      deficit      : _deficitNum(row),
      noloon       : _num(row, 'receipt-noloon'),
      ohda         : _num(row, 'receipt-ohda'),
      officeAmount : _num(row, 'receipt-office-amount'),
      add          : _num(row, 'receipt-add'),
      sarf         : _num(row, 'receipt-sarf'),
      net          : _num(row, 'receipt-net'),
    });
  }

  return receiptRows;
}

async function collectRawData() {
  const previousBalance = parseFloat(document.getElementById('receiptBalance')?.dataset.previous || '0') || 0;
  const receiptDateInput = document.getElementById('receiptDate')?.value;
  const receiptNumberInput = document.getElementById('receiptNumber')?.value;
  const client = _selectedClient();
  const generalAdd      = parseFloat(document.getElementById('generalAdd')?.value) || 0;
  return {
    id               : ReceiptState.editingReceiptId || undefined,
    receipt_date     : (receiptDateInput || '').trim(),
    receipt_number   : (receiptNumberInput || '').trim(),
    client_id        : client?.id || null,
    client_type      : client?.type || null,
    client_name      : client?.name || null,
    ...(ReceiptState.isEditing && ReceiptState.editingPaymentStatus
      ? { payment_status: ReceiptState.editingPaymentStatus }
      : {}),
    previous_balance : previousBalance,
    general_add      : generalAdd,
    paid             : parseFloat(document.getElementById('paidAmount')?.value) || 0,
    total            : parseFloat(document.getElementById('totalAmount')?.textContent) || 0,
    net_due          : parseFloat(document.getElementById('netDueAmount')?.textContent) || 0,
    net_total        : parseFloat(document.getElementById('netTotalAmount')?.textContent) || 0,
    rows             : await collectReceiptRows(),
  };
}

// ─── VALIDATION ───────────────────────────────────────────────────────────────

async function validateBeforeSave(rawData) {
  if (!rawData.receipt_date) {
    alert('الرجاء إدخال التاريخ');
    return false;
  }

  if (!rawData.receipt_number) {
    alert('رقم النموذج مطلوب');
    return false;
  }

  if (!rawData.client_id || !rawData.client_type) {
    alert('⚠️ يجب اختيار اسم العميل من القائمة.');
    return false;
  }

  const dataRows = rawData.rows.filter(r => r._type !== 'separator');
  if (dataRows.length === 0) {
    alert('الرجاء إضافة صف واحد على الأقل');
    return false;
  }

  // ── Karta duplicate check: within current form ──
  const kartaValues = dataRows
    .map(r => (r.kartano || '').trim())
    .filter(Boolean);
  const kartaSet = new Set();
  for (const k of kartaValues) {
    if (kartaSet.has(k)) {
      alert(`❌ رقم الكارتة مكرر داخل النموذج: ${k}`);
      return false;
    }
    kartaSet.add(k);
  }

  // ── Karta duplicate check: across saved receipts ──
  const allSavedReceipts = await ReceiptsModule.getAll(_currentUsername());
  const savedKartas = new Set();
  for (const receipt of allSavedReceipts) {
    if (ReceiptState.isEditing && receipt.id === ReceiptState.editingReceiptId) continue;
    const rRows = Array.isArray(receipt.rows) ? receipt.rows : [];
    for (const row of rRows) {
      if (row._type === 'separator') continue;
      const k = (row.kartano || '').trim();
      if (k) savedKartas.add(k);
    }
  }
  for (const k of kartaValues) {
    if (savedKartas.has(k)) {
      alert(`❌ رقم الكارتة "${k}" مستخدم بالفعل في نموذج محفوظ`);
      return false;
    }
  }

  const username = _currentUsername();

  // office validation
  const offices        = await ReceiptsModule.getOffices(username);
  const allOfficeKeys  = new Set(offices.map(o => OfficesService.normalizeCargoKey(o.name)).filter(Boolean));
  const invalidOffices = [...new Set(
    rawData.rows
      .filter(r => r._type !== 'separator' && r.office && !allOfficeKeys.has(OfficesService.normalizeCargoKey(r.office)))
      .map(r => r.office)
  )];
  if (invalidOffices.length > 0) {
    alert(`⚠️ الأسماء التالية غير موجودة في قائمة المكاتب:\n${invalidOffices.join('\n')}\nبرجاء الاختيار من القائمة أو إضافتها من خلال صفحة المكاتب.`);
    return false;
  }

  const missingOfficeInfo = rawData.rows
    .filter(r => r._type !== 'separator')
    .filter(r => !r.office || !r.loading || !r.taktik);
  if (missingOfficeInfo.length > 0) {
    alert('⚠️ يجب اختيار المكتب ومكان التحميل والجهة لكل صف قبل الحفظ.');
    return false;
  }

  const invalidVehicles = rawData.rows
    .filter(r => r._type !== 'separator' && !r.vehicle_id);
  if (invalidVehicles.length > 0) {
    alert('⚠️ يجب اختيار مركبة مسجلة من القائمة لكل صف.');
    return false;
  }

  const invalidOwners = rawData.rows
    .filter(r => r._type !== 'separator' && !r.owner_id);
  if (invalidOwners.length > 0) {
    alert('⚠️ يجب اختيار صاحب المركبة من القائمة لكل صف.');
    return false;
  }

  const invalidVehicleOwners = rawData.rows
    .filter(r => r._type !== 'separator' && (!r.owner_id || !r.vehicle_id));
  if (invalidVehicleOwners.length > 0) {
    alert('⚠️ يجب أن تكون كل مركبة مرتبطة بمالك مركبة مسجل.');
    return false;
  }

  return true;
}

// ─── SAVE FLOW ────────────────────────────────────────────────────────────────

async function saveReceipt() {
  if (_isSaving) return;
  _isSaving = true;

  let rawData;
  try {
    rawData = await collectRawData();
  } catch (err) {
    alert(err.message || '❌ حدث خطأ أثناء تجهيز بيانات الحفظ');
    _isSaving = false;
    return;
  }
  const valid = await validateBeforeSave(rawData);
  if (!valid) {
    _isSaving = false;
    return;
  }

  const username = _currentUsername();
  try {
    _assertCriticalSaveInputs(username, rawData);
  } catch (err) {
    _isSaving = false;
    alert(err.message || '❌ بيانات الحفظ غير مكتملة');
    return;
  }

  // EDIT MODE — no modal
  if (ReceiptState.isEditing && ReceiptState.editingReceiptId) {
    rawData.account_type = null;

    try {
      await ReceiptsModule.update(username, ReceiptState.editingReceiptId, rawData);
      _vehicleAnalysisCache.clear();
      _exitEditMode();
      window.dispatchEvent(new CustomEvent('receipts:changed'));
      alert('✅ تم تحديث النموذج بنجاح');
      clearReceiptSilent();
      if (typeof showPage === 'function') showPage('allReceipts');
      setTimeout(() => { if (typeof applyAllReceiptsFilter === 'function') applyAllReceiptsFilter(); }, 400);
    } catch (err) {
      alert(err.message || '❌ حدث خطأ أثناء التحديث');
    } finally {
      _isSaving = false;
    }
    return;
  }

  // CREATE MODE
  rawData.account_type = null;

  try {
    await ReceiptsModule.create(username, rawData);

    _vehicleAnalysisCache.clear();
    rawData.rows
      .filter(r => r._type !== 'separator' && r.data)
      .forEach(r => _uiSaveDriverName(r.data));

    if (typeof updateDashboardStats === 'function') updateDashboardStats();
    window.dispatchEvent(new CustomEvent('receipts:changed'));
    alert('✅ تم حفظ النموذج بنجاح');
    clearReceiptSilent();
  } catch (err) {
    console.error('[SAVE ERROR]', err);
    alert(err.message || '❌ حدث خطأ أثناء الحفظ');
  } finally {
    _isSaving = false;
  }
}

// ─── PRINT ────────────────────────────────────────────────────────────────────

/**
 * printReceipt — iframe print فقط، بدون window.open
 * يطبع: جدول الصرف + الإجماليات
 * لا يطبع: اسم المكتب، الإجراءات، عناصر UI غير مطلوبة
 */
function printReceipt() {
  // جمع بيانات الجدول للطباعة
  const table = document.getElementById('receiptTable');
  if (!table) return;

  const totalsContainer = document.getElementById('finalTotalsContainer');
  const receiptNumber = document.getElementById('receiptNumber')?.value || '';
  const receiptDate   = document.getElementById('receiptDate')?.value || '';
  const clientName    = document.getElementById('clientInput')?.value?.trim() || '';

  // Feature 3: الصورة في الطباعة — تحويل المسار لـ absolute URL
  const headerImgEl  = document.getElementById('receiptHeaderImage');
  let   headerImgSrc = '';
  if (headerImgEl) {
    headerImgSrc = headerImgEl.src
      ? new URL(headerImgEl.src, window.location.href).href
      : '';
  }
  const headerImgHTML = headerImgSrc
    ? `<div style="margin-bottom:10px;"><img src="${headerImgSrc}" alt="Header" style="width:100%;height:auto;max-height:80px;object-fit:cover;display:block;"></div>`
    : '';

  // بناء HTML للطباعة
  let printHeaderHTML = `
    <div style="text-align:center; margin-bottom:12px; border-bottom:2px solid #1e3a8a; padding-bottom:8px;">
      <h2 style="margin:0; color:#1e3a8a; font-size:16pt;">نموذج الصرف</h2>
      <div style="display:flex; justify-content:space-between; margin-top:6px; font-size:10pt;">
        <span>رقم الإذن: <strong>${receiptNumber}</strong></span>
        <span>التاريخ: <strong>${receiptDate}</strong></span>
        ${clientName ? `<span>العميل: <strong>${clientName}</strong></span>` : ''}
      </div>
    </div>`;

  // بناء رؤوس جدول الطباعة (بدون أعمدة الطباعة المخفية)
  const tbody = document.getElementById('receiptTableBody');
  // Determine which conditional columns have data > 0 in any row
  const allPrintDataRows = [...(tbody?.querySelectorAll('tr') || [])]
    .filter(r => r.id !== 'receiptFillArrowRow' && !r.classList.contains(SEPARATOR_CLASS));
  const conditionalHasData = new Set();
  for (const col of COL_DEFS) {
    if (!col.printConditional) continue;
    for (const row of allPrintDataRows) {
      const inp = row.querySelector('.' + col.cls);
      const val = parseFloat(inp?.value) || 0;
      if (val > 0) { conditionalHasData.add(col.key); break; }
    }
  }
  const printCols = COL_DEFS.filter(c => {
    if (c.key === '_actions') return false;
    if (c.printHide) return false;
    if (c.printConditional && !conditionalHasData.has(c.key)) return false;
    return true;
  });

  let tableHeaderHTML = '<thead><tr>' +
    printCols.map(c => `<th style="background:#1e3a8a;color:#fff;padding:4px 6px;font-size:8pt;border:1px solid #000;text-align:center;">${c.label}</th>`).join('') +
    '</tr></thead>';

  const rows = tbody ? [...tbody.querySelectorAll('tr')] : [];



  let tableBodyHTML = '<tbody>';
  rows.forEach(row => {
    if (row.id === 'receiptFillArrowRow') return;

    if (row.classList.contains(SEPARATOR_CLASS)) {
      // صف المركبة / الملاحظات
      const vehicleName = row.querySelector('.separator-vehicle-name')?.value || '';
      const subtotal    = row.querySelector('.separator-subtotal')?.textContent || '0.00';
      const notes       = row.querySelector('.separator-notes')?.value || '';
      tableBodyHTML += `<tr style="background:#fff7ed;">
        <td colspan="${printCols.length}" style="padding:4px 8px;border:1px solid #000;font-size:8pt;">
          <strong style="color:#c2410c;">🔄 رقم المركبة: ${vehicleName}</strong>
          &nbsp;&nbsp; إجمالي: <strong>${subtotal}</strong>
          ${notes ? `&nbsp;&nbsp; ملاحظات: ${notes}` : ''}
        </td>
      </tr>`;
      return;
    }

    // صف بيانات عادي
    tableBodyHTML += '<tr>';
    printCols.forEach(col => {
      let val = '';
      if (col.key === 'net') {
        val = row.querySelector('.receipt-net')?.value || '0';
      } else {
        const inp = row.querySelector('.' + col.cls);
        val = inp ? inp.value : '';
      }
      const isNum = col.type === 'number';
      tableBodyHTML += `<td style="padding:3px 5px;border:1px solid #000;font-size:8pt;text-align:${isNum ? 'center' : 'right'};">${val}</td>`;
    });
    tableBodyHTML += '</tr>';
  });
  tableBodyHTML += '</tbody>';

  // إجماليات الطباعة
  let totalsHTML = '';
  if (totalsContainer) {
    const rowCount   = document.getElementById('rowCount')?.textContent || '0';
    const total      = document.getElementById('totalAmount')?.textContent || '0.00';
    const generalAdd = document.getElementById('generalAdd')?.value || '0';
    const netDue = document.getElementById('netDueAmount')?.textContent || '0.00';
    const netTotal = document.getElementById('netTotalAmount')?.textContent || '0.00';
    const paid       = document.getElementById('paidAmount')?.value || '0';
    const balance    = document.getElementById('receiptBalance')?.textContent || '0.00';

    totalsHTML = `
      <table style="width:100%;border-collapse:collapse;margin-top:10px;page-break-inside:avoid;">
        <thead>
          <tr>
            <th style="background:#fff;color:#000;padding:5px 8px;border:1.5px solid #000;text-align:center;font-size:8pt;font-weight:700;">عدد الكارتات</th>
            <th style="background:#fff;color:#000;padding:5px 8px;border:1.5px solid #000;text-align:center;font-size:8pt;font-weight:700;">الإجمالي</th>
            <th style="background:#fff;color:#000;padding:5px 8px;border:1.5px solid #000;text-align:center;font-size:8pt;font-weight:700;">إضافة عام</th>
            <th style="background:#fff;color:#000;padding:5px 8px;border:1.5px solid #000;text-align:center;font-size:8pt;font-weight:700;">الصافي المستحق</th>
            <th style="background:#fff;color:#000;padding:5px 8px;border:1.5px solid #000;text-align:center;font-size:8pt;font-weight:700;">رصيد العميل</th>
            <th style="background:#fff;color:#000;padding:5px 8px;border:1.5px solid #000;text-align:center;font-size:8pt;font-weight:700;">الصافي الكلي</th>
            <th style="background:#fff;color:#000;padding:5px 8px;border:1.5px solid #000;text-align:center;font-size:8pt;font-weight:700;">المدفوع</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td style="background:#fff;color:#000;padding:6px 8px;border:1.5px solid #000;text-align:center;font-size:12pt;font-weight:800;">${rowCount}</td>
            <td style="background:#fff;color:#000;padding:6px 8px;border:1.5px solid #000;text-align:center;font-size:12pt;font-weight:800;">${total}</td>
            <td style="background:#fff;color:#000;padding:6px 8px;border:1.5px solid #000;text-align:center;font-size:12pt;font-weight:800;">${generalAdd}</td>
            <td style="background:#fff;color:#000;padding:6px 8px;border:1.5px solid #000;text-align:center;font-size:12pt;font-weight:800;">${netDue}</td>
            <td style="background:#fff;color:#000;padding:6px 8px;border:1.5px solid #000;text-align:center;font-size:12pt;font-weight:800;">${balance}</td>
            <td style="background:#fff;color:#000;padding:6px 8px;border:1.5px solid #000;text-align:center;font-size:12pt;font-weight:800;">${netTotal}</td>
            <td style="background:#fff;color:#000;padding:6px 8px;border:1.5px solid #000;text-align:center;font-size:12pt;font-weight:800;">${paid}</td>
          </tr>
        </tbody>
      </table>`;
  }

  const printHTMLDoc = `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<head>
  <meta charset="UTF-8">
  <title>طباعة نموذج الصرف</title>
  <link rel="stylesheet" href="cairo-font.css">
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: 'Cairo', Arial, sans-serif;
      direction: rtl;
      margin: 0;
      padding: 10mm;
      background: #fff;
      color: #000;
      font-size: 10pt;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: auto;
      page-break-inside: auto;
    }
    tr { page-break-inside: avoid; }
    th, td {
      border: 1px solid #000;
      padding: 3px 5px;
      font-size: 8pt;
      vertical-align: middle;
    }
    thead {
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    @page { size: A4 landscape; margin: 10mm; }
  </style>
</head>
<body>
  ${headerImgHTML}
  ${printHeaderHTML}
  <table>
    ${tableHeaderHTML}
    ${tableBodyHTML}
  </table>
  ${totalsHTML}
</body>
</html>`;

  // Print via unified engine
  printHTML(printHTMLDoc, { id: 'receipt-print-iframe' });
}

// ─── CLEAR / CANCEL ───────────────────────────────────────────────────────────

function clearReceiptSilent() {
  _isSaving         = false;
  _vehicleAnalysisCache.clear();
  _exitEditMode();

  const rnInput = document.getElementById('receiptNumber');
  if (rnInput) rnInput.value = '';
  
  const clientInp = document.getElementById('clientInput');
  if (clientInp) clientInp.value = '';
  
  const tbody = document.getElementById('receiptTableBody');
  if (tbody) tbody.innerHTML = '';
  
  const ga = document.getElementById('generalAdd');
  if (ga) ga.value = '0';
  
  const paidEl = document.getElementById('paidAmount');
  if (paidEl) { paidEl.value = '0'; paidEl.dataset.auto = '1'; paidEl.dataset.advanceOffset = '0'; }
  
  const netEl = document.getElementById('netDueAmount');
  if (netEl) netEl.textContent = '0.00';
  
  const netTotalEl = document.getElementById('netTotalAmount');
  if (netTotalEl) netTotalEl.textContent = '0.00';
  
  const balEl = document.getElementById('receiptBalance');
  if (balEl) { balEl.textContent = '0.00'; balEl.dataset.previous = '0'; }
  
  receiptRowCounter = 0;
  setCurrentDate();
  ensureReceiptArrowRow();
  addReceiptRow(1);
  calculateTotals();
  generateReceiptNumber();
}

function clearReceipt() {
  if (!confirm('هل أنت متأكد من مسح جميع البيانات؟')) return;
  clearReceiptSilent();
}

function cancelReceiptEdit() {
  clearReceiptSilent(); // Fully reset state first
  if (typeof showPage === 'function') showPage('allReceipts');
}

function _exitEditMode() {
  _resetReceiptEditingState();
  const saveBtn = document.querySelector('#receiptPage button[data-action="save-receipt"]');
  if (saveBtn) saveBtn.innerHTML = `
    <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"/>
    </svg>
    حفظ النموذج`;
  const cancelBtn = document.getElementById('cancelEditBtn');
  if (cancelBtn) cancelBtn.classList.add('hidden');
}

// ─── LOAD RECEIPT FOR EDIT ────────────────────────────────────────────────────

async function loadReceiptForEdit(receiptData) {
  _enterReceiptEditMode(receiptData);

  const setV = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ''; };
  setV('receiptDate',       receiptData.receipt_date   || receiptData.receiptDate   || '');
  const clientType = receiptData.client_type || (receiptData.client_id ? 'owner' : null);
  const clientId = receiptData.client_id != null ? String(receiptData.client_id) : '';
  const client = _clientsCache.find(c => c.type === clientType && c.id === clientId);
  setV('clientInput', client?.label || receiptData.client_name || '');
  setV('receiptNumber',     receiptData.receipt_number || receiptData.receiptNumber || '');

  // Financial fields are stored as cents in DB — convert to decimals for UI
  const generalAdd      = String(Money.toDecimal(receiptData.general_add ?? receiptData.generalAdd ?? receiptData.totals?.general_add ?? 0));

  const balEl           = document.getElementById('receiptBalance');
  const paidEl = document.getElementById('paidAmount');
  const isPaid = String(receiptData.payout_status || RECEIPT_PAYOUT_STATUS.UNPAID) === RECEIPT_PAYOUT_STATUS.PAID;

  if (isPaid) {
    // "تم صرفه" — keep historical balance as saved (no live update)
    const previousBalance = Money.fmtCents(receiptData.previous_balance);
    if (balEl) balEl.dataset.previous = String(previousBalance);
    const paid = Money.fmtCents(receiptData.paid ?? receiptData.totals?.paid ?? 0);
    setV('paidAmount', paid);
    if (paidEl) paidEl.dataset.auto = '0'; // keep saved paid value
  } else {
    // "لم يتم صرفه" — use saved values as-is (snapshot)
    const previousBalance = Money.fmtCents(receiptData.previous_balance);
    if (balEl) balEl.dataset.previous = String(previousBalance);
    const paid = Money.fmtCents(receiptData.paid ?? receiptData.totals?.paid ?? 0);
    const netTotal = Money.fmtCents(receiptData.net_total ?? 0);
    const advanceOffset = parseFloat(netTotal) - parseFloat(paid);
    setV('paidAmount', paid);
    if (paidEl) {
      // Always use 'advance' mode during edit so paid auto-adjusts
      // when user changes rows. offset=0 means no salfa → paid = net_total.
      // offset>0 means salfa exists → paid = net_total - offset.
      paidEl.dataset.auto = 'advance';
      paidEl.dataset.advanceOffset = String(Math.max(0, advanceOffset));
    }
  }

  setV('generalAdd',      generalAdd);

  const tbody       = document.getElementById('receiptTableBody');
  tbody.innerHTML   = '';
  receiptRowCounter = 0;

  const rows = receiptData.rows || [];
  rows.forEach((rowData, rowIdx) => {
    if (rowData._type === 'separator') {
      const sepRow = document.createElement('tr');
      sepRow.className = `${SEPARATOR_CLASS} table-sep-row`;
      if (rowData.isAuto) sepRow.dataset.auto = '1';
      sepRow.innerHTML = _separatorRowInnerHTML(
        rowData.subtotal || 0,
        rowData.vehicleName || '',
        rowData.notes || ''
      );
      tbody.appendChild(sepRow);
      return;
    }

    receiptRowCounter++;
    const tr = document.createElement('tr');
    tr.dataset.rowId = getStableRowId(rowData, receiptData.id, rowIdx);
    tr.dataset.disbursementStatus = getRowDisbursementStatus(rowData);
    tr.innerHTML = _buildRowHTML();
    tbody.appendChild(tr);

    const setF = (cls, val) => { const el = tr.querySelector('.' + cls); if (el) el.value = val ?? ''; };
    setF('receipt-kartano',       rowData.kartano      || '');
    setF('receipt-date',          rowData.date         || '');
    setF('receipt-data',          rowData.data         || '');
    // receipt-owner removed from table
    setF('receipt-car',           rowData.vehicle_plate || rowData.car || '');
    setF('receipt-weight',        formatReceiptInputNumber(rowData.weight));
    setF('receipt-deficit',       formatShortageForInput(rowData.deficit));
    setF('receipt-type',          rowData.type         || '');
    setF('receipt-office',        rowData.office       || '');
    setF('receipt-loading',       rowData.loading      || '');
    setF('receipt-taktik',        rowData.taktik       || '');
    setF('receipt-ohda',          formatReceiptInputNumber(rowData.ohda));
    // bolsa محذوف من الواجهة — البيانات القديمة محفوظة في rowData.bolsa
    setF('receipt-noloon',        formatReceiptInputNumber(rowData.noloon));
    setF('receipt-office-amount', formatReceiptInputNumber(rowData.officeAmount));
    setF('receipt-add',           formatReceiptInputNumber(rowData.add));
    setF('receipt-sarf',          formatReceiptInputNumber(rowData.sarf));
    setF('receipt-net',           Money.fmt(calculateRowNet(rowData)));

    tr.dataset.calcAttached = '1';
    attachRowCalculation(tr);
    attachKeyboardNav(tr);
    attachInputRestrictions(tr);
  });

  ensureReceiptArrowRow();

  // Both paid and unpaid: use the saved previous_balance as-is.
  // Editing a receipt does NOT recalculate the client balance.
  calculateTotals();

  const saveBtn = document.querySelector('#receiptPage button[data-action="save-receipt"]');
  if (saveBtn) saveBtn.innerHTML = `
    <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
        d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4"/>
    </svg>
    ✏️ حفظ التعديلات`;
  const cancelBtn = document.getElementById('cancelEditBtn');
  if (cancelBtn) cancelBtn.classList.remove('hidden');

  if (typeof showPage === 'function') showPage('receipt');
}

// ── Feature 2: مزامنة رقم المركبة في الـ separator التالي مباشرة ──────────────
function _syncNextSeparatorVehicle(changedRow) {
  if (!changedRow || changedRow.classList.contains(SEPARATOR_CLASS)) return;
  const tbody = document.getElementById('receiptTableBody');
  if (!tbody) return;
  const allRows = [...tbody.querySelectorAll('tr')].filter(r => r.id !== 'receiptFillArrowRow');
  const idx = allRows.indexOf(changedRow);
  if (idx === -1) return;
  // ابحث عن السيباريتر الأول مباشرة بعد هذا الصف
  for (let i = idx + 1; i < allRows.length; i++) {
    if (allRows[i].classList.contains(SEPARATOR_CLASS)) {
      const sepInput = allRows[i].querySelector('.separator-vehicle-name');
      if (sepInput) sepInput.value = changedRow.querySelector('.receipt-car')?.value || '';
      break;
    }
    // إذا وجد صف بيانات آخر قبل السيباريتر — هذا الصف ليس الأخير قبله، توقف
    if (!allRows[i].classList.contains(SEPARATOR_CLASS)) break;
  }
}

// ─── DELEGATED EVENT BINDING ──────────────────────────────────────────────────

function attachPageListeners() {
  // ── delegated: change ──────────────────────────────────────────────────────
  document.addEventListener('change', function (e) {
    if (e.target.id === 'clientInput') {
      _onClientChange(e.target);
      return;
    }
    if (e.target.classList.contains('receipt-car')) {
      const changedRow = e.target.closest('tr');
      _onVehicleCrossOwnerWarning(changedRow);
      _receiptLinkCarToDriver(changedRow);
      _syncNextSeparatorVehicle(changedRow);
      return;
    }
    if (e.target.classList.contains('receipt-office')) {
      _onOfficeValidation(e.target);
      return;
    }
  });

  // ── delegated: input ───────────────────────────────────────────────────────
  document.addEventListener('input', function (e) {
    if (e.target.id === 'paidAmount') {
      e.target.dataset.auto = '0';
      calculateTotals();
      return;
    }
    if (e.target.id === 'generalAdd') {
      calculateTotals();
      return;
    }
    if (e.target.id === 'clientInput') {
      _onClientChange(e.target);
      return;
    }
    if (e.target.classList.contains('receipt-car')) {
      _syncNextSeparatorVehicle(e.target.closest('tr'));
      return;
    }
  });

  // ── delegated: click ───────────────────────────────────────────────────────
  document.addEventListener('click', function (e) {
    // حذف صف
    if (e.target.closest('[data-action="remove-row"]')) {
      removeReceiptRow(e.target.closest('[data-action="remove-row"]'));
      return;
    }

    // إضافة صف أسفل هذا الصف (من عمود الإجراءات)
    if (e.target.closest('[data-action="add-row-after"]')) {
      const refRow = e.target.closest('tr');
      if (refRow) addRowAfter(refRow);
      return;
    }

    // إضافة فاصل أسفل هذا الصف (من عمود الإجراءات)
    if (e.target.closest('[data-action="add-separator-after"]')) {
      const refRow = e.target.closest('tr');
      if (refRow) addSeparatorAfter(refRow);
      return;
    }

    // حفظ
    if (e.target.closest('[data-action="save-receipt"]')) {
      saveReceipt();
      return;
    }
    // مسح
    if (e.target.closest('[data-action="clear-receipt"]')) {
      clearReceipt();
      return;
    }
    // إلغاء تعديل
    if (e.target.closest('[data-action="cancel-edit"]')) {
      cancelReceiptEdit();
      return;
    }
    // طباعة
    if (e.target.closest('[data-action="print-receipt"]')) {
      printReceipt();
      return;
    }
    // تنظيم المركبات (تلقائياً)
    if (e.target.closest('[data-action="organize-vehicles"]')) {
      reconcileVehicleSeparators();
      return;
    }
    // إضافة صف (من header الجدول)
    if (e.target.closest('[data-action="add-row"]')) {
      addReceiptRow(1);
      return;
    }
    // إضافة 4 صفوف (من header الجدول)
    if (e.target.closest('[data-action="add-4-rows"]')) {
      addReceiptRow(4);
      return;
    }
    // إضافة فاصل مركبة (من header الجدول)
    if (e.target.closest('[data-action="add-vehicle-separator"]')) {
      addVehicleChangeRow();
      return;
    }
    // fill column down
    const fillBtn = e.target.closest('[data-action="fill-column-down"]');
    if (fillBtn) {
      fillColumnDown(parseInt(fillBtn.dataset.colIndex, 10));
      return;
    }
    // ── Excel Export ──────────────────────────────────────────────────────────
    if (e.target.closest('[data-action="export-receipt-excel"]')) {
      _handleReceiptExcelExport();
      return;
    }
    // ── Excel Import ──────────────────────────────────────────────────────────
    if (e.target.closest('[data-action="import-receipt-excel"]')) {
      _handleReceiptExcelImport();
      return;
    }
  });
}

// ─── EXCEL HANDLERS ───────────────────────────────────────────────────────────

/**
 * Collects current form rows as plain objects, then exports to Excel.
 * Reads from DOM inputs — this is one of the few valid DOM reads in the system
 * because the receipt form has not been saved yet (no DB record exists at this point).
 */
function _handleReceiptExcelExport() {
  const tbody = document.getElementById('receiptTableBody');
  if (!tbody) return;

  const trs = [...tbody.querySelectorAll('tr')].filter(
    r => r.id !== 'receiptFillArrowRow' && !r.classList.contains('vehicle-separator-row')
  );

  if (trs.length === 0) {
    alert('لا توجد صفوف بيانات للتصدير.');
    return;
  }

  // Build row objects from DOM inputs — consistent with COL_DEFS keys
  const rows = trs.map(tr => ({
    _type:        'data',
    kartano:       tr.querySelector('.receipt-kartano')?.value       ?? '',
    date:          tr.querySelector('.receipt-date')?.value          ?? '',
    data:          tr.querySelector('.receipt-data')?.value          ?? '',
    car:           tr.querySelector('.receipt-car')?.value           ?? '',
    weight:        parseFloat(tr.querySelector('.receipt-weight')?.value)       || 0,
    deficit:       parseFloat(tr.querySelector('.receipt-deficit')?.value)      || 0,
    office:        tr.querySelector('.receipt-office')?.value        ?? '',
    loading:       tr.querySelector('.receipt-loading')?.value       ?? '',
    taktik:        tr.querySelector('.receipt-taktik')?.value        ?? '',
    type:          tr.querySelector('.receipt-type')?.value          ?? '',
    noloon:        parseFloat(tr.querySelector('.receipt-noloon')?.value)       || 0,
    ohda:          parseFloat(tr.querySelector('.receipt-ohda')?.value)         || 0,
    officeAmount:  parseFloat(tr.querySelector('.receipt-office-amount')?.value) || 0,
    add:           parseFloat(tr.querySelector('.receipt-add')?.value)          || 0,
    sarf:          parseFloat(tr.querySelector('.receipt-sarf')?.value)         || 0,
    net:           parseFloat(tr.querySelector('.receipt-net')?.value)          || 0,
  }));

  try {
    ExcelService.exportReceiptRows(rows);
  } catch (err) {
    console.error('[receipts] Excel export failed:', err);
    alert(err.message || '❌ فشل تصدير Excel');
  }
}

/**
 * Opens a file picker, imports rows from Excel, then fills the form.
 * Appends imported rows to any existing rows in the table.
 */
function _handleReceiptExcelImport() {
  ExcelService.openFilePicker(async (file) => {
    try {
      const importedRows = await ExcelService.importReceiptRows(file);

      const tbody = document.getElementById('receiptTableBody');
      if (!tbody) return;

      for (const rowData of importedRows) {
        // Add a new empty row using the existing system
        receiptRowCounter++;
        const tr = document.createElement('tr');
        tr.innerHTML = _buildRowHTML();
        tbody.appendChild(tr);
        tr.dataset.calcAttached = '1';
        attachRowCalculation(tr);
        attachKeyboardNav(tr);
        attachInputRestrictions(tr);

        // Fill values from imported data
        const setVal = (cls, val) => {
          const el = tr.querySelector('.' + cls);
          if (el) el.value = val ?? '';
        };

        setVal('receipt-kartano',       rowData.kartano      ?? '');
        setVal('receipt-date',          rowData.date         ?? '');
        setVal('receipt-data',          rowData.data         ?? '');
        setVal('receipt-car',           rowData.car          ?? '');
        setVal('receipt-weight',        formatReceiptInputNumber(rowData.weight));
        setVal('receipt-deficit',       formatShortageForInput(rowData.deficit));
        setVal('receipt-office',        rowData.office       ?? '');
        setVal('receipt-loading',       rowData.loading      ?? '');
        setVal('receipt-taktik',        rowData.taktik       ?? '');
        setVal('receipt-type',          rowData.type         ?? '');
        setVal('receipt-noloon',        formatReceiptInputNumber(rowData.noloon));
        setVal('receipt-ohda',          formatReceiptInputNumber(rowData.ohda));
        setVal('receipt-office-amount', formatReceiptInputNumber(rowData.officeAmount));
        setVal('receipt-add',           formatReceiptInputNumber(rowData.add));
        setVal('receipt-sarf',          formatReceiptInputNumber(rowData.sarf));

        // Compute net inline using the same formula as calculateNet()
        const _net = calculateRowNet(rowData);

        const netEl = tr.querySelector('.receipt-net');
        if (netEl) netEl.value = Money.fmt(_net);
      }

      // Recalculate all totals after all rows are filled
      calculateTotals();

      alert(`✅ تم استيراد ${importedRows.length} صف بنجاح.`);
    } catch (err) {
      console.error('[receipts] Excel import failed:', err);
      alert(err.message || '❌ فشل استيراد Excel');
    }
  });
}

// ─── PAGE INITIALIZATION ──────────────────────────────────────────────────────

function initReceiptPage() {
  const session = AuthModule.getSession();
  if (!session) {
    window.location.href = 'login.html';
    return;
  }

  renderReceiptPage();
  setCurrentDate();
  loadClientsList();
  loadOfficesForReceipt();
  loadDriversDatalist();

  const tbody = document.getElementById('receiptTableBody');
  const dataRows = tbody ? [...tbody.querySelectorAll('tr')].filter(r => r.id !== 'receiptFillArrowRow') : [];
  if (dataRows.length === 0) addReceiptRow(1);

  setTimeout(() => generateReceiptNumber(), 300);
}

// ─── BOOT ─────────────────────────────────────────────────────────────────────

attachPageListeners();

// ── Feature 1: Auto-select خانة عند التنقل إليها (Tab / Enter / Arrow / Click) ──
document.addEventListener('focusin', function (e) {
  const el = e.target;
  if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'SELECT')) return;
  if (!el.closest('#receiptTableBody')) return;
  setTimeout(function () { try { el.select(); } catch (_) {} }, 0);
});

window.addEventListener('owners:changed', () => {
  loadClientsList();
});
window.addEventListener('offices:changed', () => {
  loadOfficesForReceipt();
});


// ========================================
// Public API
// ========================================

export {
  ReceiptState,
  ReceiptsModule,
  initReceiptPage,
  renderReceiptPage,
  loadReceiptForEdit,
  addReceiptRow,
  addVehicleChangeRow,
  fillColumnDown,
  saveReceipt,
  clearReceipt,
  clearReceiptSilent,
  cancelReceiptEdit,
  printReceipt,
  renderReceiptSnapshotTableHead,
  renderReceiptSnapshotRowsHtml,
  formatSnapshotNumber,
  formatSnapshotCellValue,
  getSnapshotCellRawValue,
  convertShortageToCalculationValue,
  formatReceiptInputNumber,
  formatShortageForInput,
  COL_DEFS,
  DATA_COL_COUNT,
};
