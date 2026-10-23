/**
 * financial.js — treasury, ledger, shared financial operations
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 6: All financial writes go through ApiClient → PHP → MySQL.
 *          Reads go through DBProvider → domainResolver → API (SERVER_OWNED).
 *
 * DESIGN DECISION: Pre-generated UUID for receipts
 *   receipts.id is a UUID string (not autoIncrement integer).
 *   This lets us pass reference_id to treasury + vehicle_ledger entries
 *   BEFORE any insert fires — enabling a single atomic PHP transaction
 *   across all three tables with zero orphan-record risk.
 *
 * RULE 2  : ALL money operations live here. Zero treasury/ledger writes elsewhere.
 * RULE 3  : Every operation executes inside ONE atomic PHP endpoint.
 * RULE 4  : update/delete MUST reverse old entries before applying new ones.
 * RULE 5  : Every financial record carries { reference_type, reference_id }.
 * RULE 6  : All monetary values are numbers — never strings.
 * RULE 9  : MySQL stores integers (cents). money.js handles all conversion.
 *
 * Reversal strategy: is_reversed: true  (NOT soft-delete)
 *   Reversed entries remain fully visible in the audit trail.
 *   Soft-delete (deleted_at) is reserved for user-initiated receipt deletion only.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Money } from './money.js';
import { RECEIPT_PAYOUT_STATUS, normalizePayoutStatus } from './constants/payoutStatus.js';
import { DateUtils } from './dateUtils.js';
import { ArchiveService } from './services/archiveService.js';
import { DBProvider } from './services/dbProvider.js';
import { ApiClient } from './services/apiClient.js';
import { dbBool } from './dbTypes.js';
import { generateId as _uuid } from './utils/idGenerator.js';

// ─── CONSTANTS ─────────────────────────────────────────────────────────────────

const STORE = Object.freeze({
  RECEIPTS : 'receipts',
  TREASURY : 'treasury',
  LEDGER   : 'vehicle_ledger',
  OFFICES  : 'offices',
});

const REF_TYPE      = 'receipt';
const ACCOUNT_TYPES = Object.freeze(['cash', 'bank', 'vodafone', 'none']);
const OFFICE_LEDGER_TYPES = Object.freeze({
  DEPOSIT       : 'OFFICE_DEPOSIT',
  WITHDRAW_AUTO : 'OFFICE_WITHDRAW_AUTO',
});

// _uuid imported from utils/idGenerator.js

// ─── INTERNAL HELPERS ──────────────────────────────────────────────────────────

function _normalizePayoutStatus(value) {
  if (value == null) return null;
  return normalizePayoutStatus(value);
}

function _toKey(value) {
  return String(value || '').trim().toLowerCase();
}

function _requireText(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`[FinancialService] ${label} is required.`);
  return text;
}

// ─── (Phase 6: _storesForOps removed — no longer needed, PHP handles store routing) ──

// ─── VALIDATION ────────────────────────────────────────────────────────────────

/**
 * Validate and normalise raw input.
 * INPUT:  decimal values from UI  (e.g. total: 1500.50)
 * OUTPUT: clean object with cents (e.g. total: 150050)
 */
function _validate(data) {
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService] data must be a plain object.');
  }

  const rows = Array.isArray(data.rows) ? data.rows : [];
  const dataRows = rows.filter(r => r && r._type !== 'separator');
  if (dataRows.length === 0) {
    throw new Error('[FinancialService] rows must contain at least one data row.');
  }

  const client_id = data.client_id != null ? String(data.client_id).trim() : '';
  const client_type = (data.client_type === 'owner' || data.client_type === 'office')
    ? data.client_type
    : '';
  const client_name = typeof data.client_name === 'string' ? data.client_name.trim() : '';
  if (!client_id) {
    throw new Error('[FinancialService] client_id is required.');
  }
  if (!client_type) {
    throw new Error('[FinancialService] client_type must be owner or office.');
  }

  const clientVehicleGroups = new Map();
  for (const row of dataRows) {
    const owner_id = typeof row.owner_id === 'string' ? row.owner_id.trim() : '';
    if (!owner_id) {
      throw new Error('[FinancialService] row.owner_id must be a non-empty UUID string.');
    }
    const vehicle_id = typeof row.vehicle_id === 'string' ? row.vehicle_id.trim() : '';
    if (!vehicle_id) {
      throw new Error('[FinancialService] row.vehicle_id must be a non-empty UUID string.');
    }

    const owner_name = typeof row.owner_name === 'string' ? row.owner_name.trim() : '';
    const vehicle_plate = typeof row.vehicle_plate === 'string' ? row.vehicle_plate.trim() : '';
    const rowNet = Money.toCents(row.net ?? 0);
    const key = `${client_id}__${vehicle_id}`;
    const prev = clientVehicleGroups.get(key) || {
      client_id,
      client_type,
      client_name: client_name || null,
      vehicle_owner_id: owner_id,
      vehicle_owner_name: owner_name || null,
      vehicle_id,
      vehicle_plate: vehicle_plate || null,
      total: 0,
    };
    prev.total += rowNet;
    clientVehicleGroups.set(key, prev);
  }

  const account_type = data.account_type ?? null;
  if (account_type !== null && !ACCOUNT_TYPES.includes(account_type)) {
    throw new Error(
      `[FinancialService] account_type must be one of: ${ACCOUNT_TYPES.join(', ')}, or null.`
    );
  }

  const receipt_date = data.receipt_date;
  if (!receipt_date || isNaN(Date.parse(receipt_date))) {
    throw new Error('[FinancialService] receipt_date must be a valid ISO date string.');
  }

  // Convert decimals → cents (RULE 9)
  const total = Money.toCents(data.total);
  if (total < 0) {
    throw new Error('[FinancialService] total must be a non-negative number.');
  }

  const general_add = Money.toCents(data.general_add ?? data.generalAdd ?? 0);
  if (general_add < 0) {
    throw new Error('[FinancialService] general_add must be a non-negative number.');
  }
  const previous_balance = Money.toCents(data.previous_balance ?? data.previousBalance ?? 0);
  const net_due_calc = total + general_add;
  const net_due_input = data.net_due != null ? Money.toCents(data.net_due) : null;
  const net_due = net_due_input != null ? net_due_input : net_due_calc;
  const net_total = net_due + previous_balance;

  const paid = Money.toCents(data.paid ?? 0);
  if (paid < 0) {
    throw new Error('[FinancialService] paid must be a non-negative number.');
  }

  const groups = [...clientVehicleGroups.values()].filter(g => g.total !== 0);
  if (groups.length === 0) {
    throw new Error('[FinancialService] rows total must be greater than zero.');
  }

  return {
    account_type,
    receipt_date,
    total,
    general_add,
    net_due,
    previous_balance,
    net_total,
    paid,
    groups,
    client_id,
    client_type,
    client_name,
  };
}

// ─── (Phase 6: _buildReverseOps & _assertNotApplied removed — PHP handles reversal/guard atomically) ──

// ─── PRIVATE: BUILD APPLY OPS ──────────────────────────────────────────────────

function _buildApplyOps(username, clean, receiptId) {
  const {
    receipt_date,
    net_due,
    client_id,
    client_type,
    client_name,
  } = clean;

  const ops = [];

  if (net_due !== 0) {
    ops.push({
      op: 'add', store: STORE.LEDGER,
      payload: {
        username,
        client_id     : client_id,
        client_type   : client_type,
        client_name   : client_name || null,
        vehicle_owner_id  : null,
        vehicle_owner_name: null,
        vehicle_id    : null,
        vehicle_plate : null,
        type           : 'receipt_due',
        amount         : net_due,
        reference_type : REF_TYPE,
        reference_id   : receiptId,
        date           : receipt_date,
        applied_at     : DateUtils.nowLocal(),
        is_reversed    : false,
        note           : `Receipt ${receiptId} — net due`,
      },
    });
  }

  return ops;
}

// ─── OFFICE BALANCE: PRICE RESOLUTION ───────────────────────────────────────

async function resolveHamolaPrice(username, officeName, loadingPlace, destinationPlace, officeMap = null) {
  if (!username) throw new Error('[FinancialService:resolveHamolaPrice] username is required.');

  const name = _requireText(officeName, 'office_name');
  const loading = _requireText(loadingPlace, 'loading_place');
  const destination = _requireText(destinationPlace, 'destination');

  let map = officeMap;
  if (!map) {
    const offices = await DBProvider.findByFields(STORE.OFFICES, { username });
    map = new Map(offices.map((o) => [_toKey(o.name), o]));
  }

  const office = map.get(_toKey(name));
  if (!office) {
    throw new Error(`❌ المكتب غير موجود: ${name}`);
  }

  const hamola = Array.isArray(office.hamolaRows) ? office.hamolaRows : [];
  const match = hamola.find((row) => {
    const loadKey = _toKey(row.loading_place ?? row.loading);
    const destKey = _toKey(row.destination_place ?? row.direction ?? row.taktik);
    return loadKey === _toKey(loading) && destKey === _toKey(destination);
  });

  if (!match) {
    throw new Error(`❌ لا يوجد سعر مطابق للمكتب "${name}" لمسار (${loading} → ${destination})`);
  }

  const price = Number(match.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`❌ سعر التحميل غير صالح للمكتب "${name}" لمسار (${loading} → ${destination})`);
  }

  return { office, price };

}
// ─── (Phase 6: _parseApplyResults removed — response parsing done inline from PHP response) ──

// ─── PUBLIC: createReceipt ─────────────────────────────────────────────────────

async function createReceipt(username, data, extraOps = []) {
  if (!username) throw new Error('[FinancialService:create] username is required.');

  const receiptId = data.id || _uuid();
  const clean = _validate(data);

  const firstDataRow = (Array.isArray(data.rows) ? data.rows : []).find(r => r && r._type !== 'separator') || null;
  const payout_status = _normalizePayoutStatus(data.payout_status) || RECEIPT_PAYOUT_STATUS.UNPAID;
  const receiptOp = {
    op: 'add', store: STORE.RECEIPTS,
    payload: {
      id           : receiptId,
      username,
      client_id    : clean.client_id,
      client_type  : clean.client_type,
      client_name  : clean.client_name,
      vehicle_id   : data.vehicle_id ?? firstDataRow?.vehicle_id ?? null,
      account_type : clean.account_type,
      receipt_date : clean.receipt_date,
      receipt_number: data.receipt_number ?? null,
      payout_status : payout_status,
      rows         : data.rows ?? [],
      total        : clean.total,
      paid         : clean.paid,
      previous_balance: clean.previous_balance,
      general_add     : clean.general_add,
      net_due         : clean.net_due,
      net_total       : clean.net_total,
      notes          : data.notes ?? null,
      shipping_number: data.shipping_number ?? null,
    },
  };

  const applyOps = _buildApplyOps(username, clean, receiptId);
  // Separate ops by store for the PHP endpoint
  const ledgerOps = applyOps.filter(o => o.store === STORE.LEDGER).map(o => o.payload);
  const treasuryOps = [...applyOps.filter(o => o.store === STORE.TREASURY).map(o => o.payload),
                       ...extraOps.filter(o => o.store === STORE.TREASURY).map(o => o.payload)];

  const apiRes = await ApiClient.post('/financial/receipt-create.php', {
    ...receiptOp.payload,
    request_id: _uuid(),
    ledger_ops: ledgerOps,
    treasury_ops: treasuryOps,
  });
  if (!apiRes.success) throw new Error(apiRes.message || 'فشل إنشاء الإيصال');

  const receipt = Money.decimalizeRecord(apiRes.data.receipt);
  const treasury = apiRes.data.treasury?.[0] ? Money.decimalizeRecord(apiRes.data.treasury[0]) : null;
  const ledger_due = apiRes.data.ledger?.[0] ? Money.decimalizeRecord(apiRes.data.ledger[0]) : null;
  const ledger_deposit = null;
  const ledger_withdraw = null;

  return {
    receipt,
    treasury       : Money.decimalizeRecord(treasury),
    ledger_deposit : Money.decimalizeRecord(ledger_deposit),
    ledger_withdraw: Money.decimalizeRecord(ledger_withdraw),
    ledger_due     : Money.decimalizeRecord(ledger_due),
  };
}

// ─── PUBLIC: updateReceipt ─────────────────────────────────────────────────────

async function updateReceipt(username, id, data, extraOps = []) {
  if (!username) throw new Error('[FinancialService:update] username is required.');
  if (!id)       throw new Error('[FinancialService:update] id is required.');

  // Archive guard — cannot modify archived receipts
  const _existing = await DBProvider.get(STORE.RECEIPTS, id);
  ArchiveService.assertNotArchived(_existing);

  const clean    = _validate(data);
  const firstDataRow = (Array.isArray(data.rows) ? data.rows : []).find(r => r && r._type !== 'separator') || null;
  const payout_status = _normalizePayoutStatus(data.payout_status);
  const updateOp = {
    op: 'update', store: STORE.RECEIPTS, id,
    patch: {
      username,
      client_id    : clean.client_id,
      client_type  : clean.client_type,
      client_name  : clean.client_name,
      vehicle_id   : data.vehicle_id ?? firstDataRow?.vehicle_id ?? null,
      account_type : clean.account_type,
      receipt_date : clean.receipt_date,
      receipt_number: data.receipt_number ?? null,
      ...(payout_status !== null ? { payout_status } : {}),
      rows         : data.rows ?? [],
      total        : clean.total,
      paid         : clean.paid,
      previous_balance: clean.previous_balance,
      general_add     : clean.general_add,
      net_due         : clean.net_due,
      net_total       : clean.net_total,
      ...(data.notes !== undefined ? { notes: data.notes || null } : {}),
      ...(data.shipping_number !== undefined ? { shipping_number: data.shipping_number || null } : {}),
    },
  };

  const applyOps = _buildApplyOps(username, clean, id);
  // Phase 2 TASK E — extraOps lets the caller (ReceiptsModule.update) atomically
  // unlink stale used_receipt_id references in bolsaForms and re-link new ones,
  // all inside the same DB transaction as the receipt update.
  const ledgerOps = applyOps.filter(o => o.store === STORE.LEDGER).map(o => o.payload);
  const treasuryOps = applyOps.filter(o => o.store === STORE.TREASURY).map(o => o.payload);

  const apiRes = await ApiClient.post('/financial/receipt-update.php', {
    receipt_id: id,
    ...updateOp.patch,
    updated_at: _existing?.updated_at ?? null,
    ledger_ops: ledgerOps,
    treasury_ops: treasuryOps,
  });
  if (!apiRes.success) throw new Error(apiRes.message || 'فشل تحديث الإيصال');

  const receipt = Money.decimalizeRecord(apiRes.data.receipt);
  const treasury = apiRes.data.treasury?.[0] ? Money.decimalizeRecord(apiRes.data.treasury[0]) : null;
  const ledger_due = apiRes.data.ledger?.[0] ? Money.decimalizeRecord(apiRes.data.ledger[0]) : null;
  const ledger_deposit = null;
  const ledger_withdraw = null;

  return {
    receipt,
    treasury       : Money.decimalizeRecord(treasury),
    ledger_deposit : Money.decimalizeRecord(ledger_deposit),
    ledger_withdraw: Money.decimalizeRecord(ledger_withdraw),
    ledger_due     : Money.decimalizeRecord(ledger_due),
  };
}

// ─── PUBLIC: deleteReceipt ─────────────────────────────────────────────────────

async function deleteReceipt(username, id, extraOps = []) {
  if (!username) throw new Error('[FinancialService:delete] username is required.');
  if (!id)       throw new Error('[FinancialService:delete] id is required.');

  const _existing = await DBProvider.get(STORE.RECEIPTS, id);
  ArchiveService.assertNotArchived(_existing);

  // Phase 2 TASK E — extraOps lets the caller atomically unlink any bolsa
  // rows that pointed back to this receipt.  They are inserted BEFORE the
  // receipt delete op so the soft-deleted receipt remains the last op,
  // preserving the existing result-shape contract (caller still reads the
  // deleted receipt from allResults[length-1]-equivalent index).
  const apiRes = await ApiClient.post('/financial/receipt-delete.php', {
    receipt_id: id,
  });
  if (!apiRes.success) throw new Error(apiRes.message || 'فشل حذف الإيصال');

  const txResult = {
    results: [apiRes.data],
    treasury_count: 0,
    ledger_count: 0,
  };

  const allResults = txResult.results;
  const receipt = Money.decimalizeRecord(allResults[allResults.length - 1]);

  return {
    receipt,
    reversed: {
      treasury_count: txResult.treasury_count,
      ledger_count: txResult.ledger_count,
    },
  };
}

// ─── PUBLIC: updateReceiptStatus ─────────────────────────────────────────────

async function updateReceiptStatus(username, receiptId, status) {
  if (!username) throw new Error('[FinancialService:updateReceiptStatus] username is required.');
  if (!receiptId) throw new Error('[FinancialService:updateReceiptStatus] receiptId is required.');

  const _existing = await DBProvider.get(STORE.RECEIPTS, String(receiptId));
  ArchiveService.assertNotArchived(_existing);

  const normalized = _normalizePayoutStatus(status);
  if (!normalized) {
    throw new Error('[FinancialService:updateReceiptStatus] status must be paid or unpaid.');
  }

  const apiRes = await ApiClient.post('/financial/receipt-status.php', {
    receipt_id: receiptId,
    status: normalized,
  });
  if (!apiRes.success) throw new Error(apiRes.message || 'فشل تغيير حالة الإيصال');

  const result = apiRes.data;
  return Money.decimalizeRecord(result.receipt);
}

// ─── PUBLIC: rebuildVehicleBalance ────────────────────────────────────────────

async function rebuildVehicleBalance(vehicle_id) {
  if (!vehicle_id) throw new Error('[FinancialService:rebuildVehicleBalance] vehicle_id is required.');

  const allEntries = await DBProvider.getByIndex(STORE.LEDGER, 'by_vehicle', vehicle_id);
  const active     = allEntries.filter(e => !dbBool(e.is_reversed) && e.deleted_at === null);

  let deposit_total  = 0;
  let withdraw_total = 0;

  for (const entry of active) {
    if (entry.type === 'deposit')  deposit_total  += Number(entry.amount) || 0;
    if (entry.type === 'withdraw') withdraw_total += Number(entry.amount) || 0;
  }

  const balance = deposit_total - withdraw_total;

  return {
    vehicle_id,
    balance        : Money.toDecimal(balance),
    deposit_total  : Money.toDecimal(deposit_total),
    withdraw_total : Money.toDecimal(withdraw_total),
    entry_count    : active.length,
  };
}

// ─── PUBLIC: rebuildTreasuryBalance ───────────────────────────────────────────

async function rebuildTreasuryBalance(account_type = null) {
  if (account_type !== null && !ACCOUNT_TYPES.includes(account_type)) {
    throw new Error(
      `[FinancialService:rebuildTreasuryBalance] Invalid account_type "${account_type}". ` +
      `Allowed: ${ACCOUNT_TYPES.join(', ')}, or omit for all.`
    );
  }

  const allEntries = await DBProvider.getAll(STORE.TREASURY);
  const active     = allEntries.filter(e => !dbBool(e.is_reversed) && e.deleted_at === null);

  function _calcAccount(entries) {
    let deposit_total  = 0;
    let withdraw_total = 0;
    for (const e of entries) {
      if (e.type === 'deposit')  deposit_total  += Number(e.amount) || 0;
      if (e.type === 'withdraw') withdraw_total += Number(e.amount) || 0;
    }
    return {
      balance        : Money.toDecimal(deposit_total - withdraw_total),
      deposit_total  : Money.toDecimal(deposit_total),
      withdraw_total : Money.toDecimal(withdraw_total),
      entry_count    : entries.length,
    };
  }

  if (account_type !== null) {
    const filtered = active.filter(e => e.account_type === account_type);
    return { account_type, ..._calcAccount(filtered) };
  }

  const result   = {};
  let   cBal = 0, cDep = 0, cWith = 0, cCount = 0;

  for (const acct of ACCOUNT_TYPES) {
    const filtered  = active.filter(e => e.account_type === acct);
    const snap      = _calcAccount(filtered);
    result[acct]    = snap;
    cDep   += Money.toCents(snap.deposit_total);
    cWith  += Money.toCents(snap.withdraw_total);
    cCount += snap.entry_count;
  }
  cBal = cDep - cWith;

  result.combined = {
    balance        : Money.toDecimal(cBal),
    deposit_total  : Money.toDecimal(cDep),
    withdraw_total : Money.toDecimal(cWith),
    entry_count    : cCount,
  };

  return result;
}

// ─── CLIENT LEDGER & BALANCE ───────────────────────────────────────────────────

async function getClientLedger(client_id, client_type) {
  const key = client_id != null ? String(client_id).trim() : '';
  if (!key) throw new Error('[FinancialService:getClientLedger] client_id is required.');
  if (!client_type) throw new Error('[FinancialService:getClientLedger] client_type is required for entity isolation.');

  const filters = {
    client_id: key,
    is_reversed: false,
    client_type: client_type,
  };

  const entries = await DBProvider.findByFields(STORE.LEDGER, filters);

  return entries
    .slice()
    .sort((a, b) => {
      const db = new Date(b.date || b.applied_at || b.created_at || 0).getTime();
      const da = new Date(a.date || a.applied_at || a.created_at || 0).getTime();
      return db - da;
    })
    .map(Money.decimalizeRecord);
}

async function getClientBalance(client_id, client_type) {
  if (!client_type) throw new Error('[FinancialService:getClientBalance] client_type is required for entity isolation.');
  const ledger = await getClientLedger(client_id, client_type);
  let deposit_total = 0;
  let withdraw_total = 0;

  for (const entry of ledger) {
    // entry.amount is already decimal (from decimalizeRecord)
    // convert back to cents for safe integer arithmetic
    const cents = Money.toCents(entry.amount);
    const isOfficeEntry = entry.client_type === 'office'
      || entry.type === OFFICE_LEDGER_TYPES.DEPOSIT
      || entry.type === OFFICE_LEDGER_TYPES.WITHDRAW_AUTO;

    if (isOfficeEntry) {
      if (cents >= 0) deposit_total += cents;
      else withdraw_total += Math.abs(cents);
      continue;
    }

    if (entry.type === 'receipt_due') {
      if (cents >= 0) deposit_total += cents;
      else withdraw_total += Math.abs(cents);
      continue;
    }

    if (entry.type === 'receipt_payment') {
      withdraw_total += Math.abs(cents);
      continue;
    }

    if (entry.type === 'deposit') deposit_total += cents;
    if (entry.type === 'withdraw') withdraw_total += cents;
  }

  // Add carry-forward balance from archived periods
  let archivedCents = 0;
  try {
    const session = (typeof window !== 'undefined' && window.__APP_CONTEXT__?.username) || '';
    if (session) {
      archivedCents = await ArchiveService.getArchivedClientBalance(session, client_id, client_type);
    }
  } catch (_) { /* no archive data — continue with zero */ }

  return {
    client_id: String(client_id),
    balance: Money.toDecimal(deposit_total - withdraw_total + archivedCents),
    deposit_total: Money.toDecimal(deposit_total),
    withdraw_total: Money.toDecimal(withdraw_total),
    entry_count: ledger.length,
    last_transaction_date: ledger[0]?.date || ledger[0]?.applied_at || ledger[0]?.created_at || null,
  };
}

async function createClientBalanceEntry(username, data) {
  if (!username) throw new Error('[FinancialService:createClientBalanceEntry] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createClientBalanceEntry] data must be a plain object.');
  }

  const client_id = data.client_id != null
    ? String(data.client_id).trim()
    : (data.office_id != null ? String(data.office_id).trim() : '');
  let client_type = data.client_type;
  if (client_type !== 'owner' && client_type !== 'office') {
    if (data.office_id) client_type = 'office';
    else client_type = 'owner';
  }
  const client_name = typeof data.client_name === 'string' ? data.client_name.trim() : '';
  const type = data.type === 'deposit' || data.type === 'withdraw' ? data.type : '';
  const amount = Money.toCents(data.amount);
  const date = data.date;
  const note = typeof data.note === 'string' && data.note.trim()
    ? data.note.trim()
    : (type === 'deposit' ? 'إيداع رصيد' : 'سحب رصيد');

  if (!client_id) throw new Error('[FinancialService:createClientBalanceEntry] client_id is required.');
  if (!client_type) throw new Error('[FinancialService:createClientBalanceEntry] client_type must be owner or office.');
  if (!type) throw new Error('[FinancialService:createClientBalanceEntry] type must be deposit or withdraw.');
  if (amount <= 0) throw new Error('[FinancialService:createClientBalanceEntry] amount must be greater than zero.');
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createClientBalanceEntry] date must be a valid ISO date string.');
  }

  const referenceId = _uuid();
  const apiRes = await ApiClient.post('/entities/vehicle-ledger/create.php', {
    client_id,
    client_type,
    client_name: client_name || null,
    type,
    amount,
    reference_type: 'client_balance',
    reference_id: referenceId,
    date,
    applied_at: DateUtils.nowLocal(),
    is_reversed: false,
    note,
  });
  if (!apiRes.success) throw new Error(apiRes.message || 'فشل إنشاء الحركة');
  return Money.decimalizeRecord(apiRes.data);
}

async function createOfficeDeposit(username, data) {
  if (!username) throw new Error('[FinancialService:createOfficeDeposit] username is required.');
  if (!data || typeof data !== 'object') {
    throw new Error('[FinancialService:createOfficeDeposit] data must be a plain object.');
  }

  const office_id = String(data.office_id || data.client_id || '').trim();
  if (!office_id) throw new Error('[FinancialService:createOfficeDeposit] office_id is required.');

  const amount = Money.toCents(data.amount);
  if (amount <= 0) throw new Error('[FinancialService:createOfficeDeposit] amount must be greater than zero.');

  const date = data.date || DateUtils.todayLocal();
  if (!date || isNaN(Date.parse(date))) {
    throw new Error('[FinancialService:createOfficeDeposit] date must be a valid ISO date string.');
  }

  const note = typeof data.note === 'string' && data.note.trim()
    ? data.note.trim()
    : 'إيداع رصيد';

  const referenceId = _uuid();
  const apiRes = await ApiClient.post('/financial/office-deposit.php', {
    office_id,
    type: OFFICE_LEDGER_TYPES.DEPOSIT,
    amount,
    reference_type: 'office_deposit',
    reference_id: referenceId,
    date,
    applied_at: DateUtils.nowLocal(),
    is_reversed: false,
    note,
  });
  if (!apiRes.success) throw new Error(apiRes.message || 'فشل إنشاء إيداع المكتب');
  const entry = apiRes.data;

  return Money.decimalizeRecord(entry);
}

// ─── EXPORT ────────────────────────────────────────────────────────────────────


export const FinancialService = Object.freeze({
  createReceipt,
  updateReceipt,
  deleteReceipt,
  rebuildVehicleBalance,
  rebuildTreasuryBalance,
  getClientBalance,
  getClientLedger,
  createClientBalanceEntry,
  createOfficeDeposit,
  resolveHamolaPrice,
  updateReceiptStatus,
});
