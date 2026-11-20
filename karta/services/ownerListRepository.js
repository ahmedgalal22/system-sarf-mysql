/** Read-only adapter for ownersPage, not for selects, statements, or posting operations. */
import { ApiClient } from './apiClient.js';
import { resolveDomain } from './domainResolver.js';
import { compareLedgerEntriesChronologicalDesc } from '../financial.js';
import { Money } from '../money.js';

function invalidSummary() { throw new Error('بيانات أرصدة أصحاب المركبات غير مكتملة'); }

function chronological(entries) {
  if (!Array.isArray(entries) || !entries.length) invalidSummary();
  for (const e of entries) {
    if (!e || e.id == null ||
        !['date', 'applied_at', 'created_at'].every(k => e[k] === null || typeof e[k] === 'string')) {
      invalidSummary();
    }
  }
  return entries.slice().sort(compareLedgerEntriesChronologicalDesc);
}

const rawDate = e => e.date || e.applied_at || e.created_at || null;

function snapshot(row) {
  if (!row || typeof row.id !== 'string' || !/^\d+$/.test(row.id) ||
      typeof row.name !== 'string' || !row.name || !row.summary || typeof row.summary !== 'object') {
    invalidSummary();
  }
  const s = row.summary;
  let cents, activity;
  if ('precision_entries' in s) {
    // Rare BIGINT/large cumulative totals: replay classified legs with the same Money
    // conversions, in the same order and in the same two accumulators as getClientBalance.
    const entries = chronological(s.precision_entries);
    let deposits = 0, withdrawals = 0;
    for (const e of entries) {
      if (typeof e.amount !== 'string' || !/^-?\d+$/.test(e.amount)) invalidSummary();
      const c = Money.toCents(Money.toDecimal(e.amount));
      if (!Number.isFinite(c)) invalidSummary();
      switch (e.leg) {
        case 'deposit': deposits += c; break;
        case 'withdraw': withdrawals += c; break;
        case 'withdraw_abs': withdrawals += Math.abs(c); break;
        case 'none': break;
        default: invalidSummary();
      }
    }
    cents = deposits - withdrawals;
    activity = rawDate(entries[0]);
  } else {
    if (!Number.isSafeInteger(s.balance_cents)) invalidSummary();
    cents = s.balance_cents;
    activity = Array.isArray(s.activity) ? rawDate(chronological(s.activity)[0]) : s.activity;
    if (activity !== null && typeof activity !== 'string') invalidSummary();
  }
  if (!Number.isFinite(cents)) invalidSummary();
  // The old list projected away owner timestamps before computing last_activity.
  return { id: row.id, type: 'owner', name: row.name, phone: row.phone || null,
    balance: Money.toDecimal(cents), last_activity: Math.max(0, activity ? new Date(activity).getTime() || 0 : 0) };
}

export const OwnerListRepository = {
  async getAll(options = {}) {
    const route = resolveDomain('vehicleOwners', 'read');
    if (route.transport !== 'API' || !route.apiPath) throw new Error('تعذر الاتصال بالخادم');
    const res = await ApiClient.get(`${route.apiPath}/list-summary.php`, options);
    if (!res.success || res.status >= 400) throw new Error(res.message);
    if (!Array.isArray(res.data)) invalidSummary();
    return res.data.map(snapshot);
  },
};
