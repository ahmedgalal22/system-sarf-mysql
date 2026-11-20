// Invoked by run_owner_list_mariadb.py inside its private namespace. Real HTTP, no stub responses.
import assert from 'node:assert/strict';
import { readFileSync, readlinkSync } from 'node:fs';
assert.equal(process.argv[2], readlinkSync('/proc/self/ns/net'), 'Use the private fixture launcher');
assert.match(process.cwd(), /^\/tmp\/karta-owner-fixture-[\w-]+$/);
const cookies = JSON.parse(readFileSync(0, 'utf8'));
const counts = { alpha: 42, beta: 1, nobody: 0, volume: 3, single1k: 1, single8k: 1, single64k: 1,
  distinct32k: 1, precision1k: 1, precision8k: 1, activity4k: 1, mixed: 64, edge: 6 };
assert.deepEqual(Object.keys(cookies).sort(), Object.keys(counts).sort());
const sizes = { volume: 4096, single1k: 1024, single8k: 8192, single64k: 65536, distinct32k: 32768, precision1k: 1024, precision8k: 8192, activity4k: 4096 };
const loc = new URL('http://127.0.0.1:18748/');
process.env.TZ = 'Africa/Cairo';
globalThis.window = { SERVER_MODE_READY: true, location: loc, addEventListener() {} };
const { activateServerMode } = await import('../../services/apiConfig.js');
const { ClientRepository } = await import('../../services/clientRepository.js');
const { FinancialService, compareLedgerEntriesChronologicalDesc } = await import('../../financial.js');
const { loadOwners } = await import('../../entities.js');
const { OwnerListRepository } = await import('../../services/ownerListRepository.js');
activateServerMode();
const send = globalThis.fetch;
let user;
// Node has no browser cookie jar. Attach only the fixture session cookie to private GETs.
globalThis.fetch = (url, opts = {}) => {
  assert.equal(new URL(url).origin, loc.origin); assert.equal(opts.method ?? 'GET', 'GET');
  return send(url, { ...opts, redirect: 'error', headers: { ...opts.headers, Cookie: `KARTA_V2_SESSION=${cookies[user]}` } });
};
const get = async path => {
  const res = await fetch(new URL('/api/entities/' + path, loc));
  assert.equal(res.status, 200); const body = await res.json(); assert.equal(body.success, true); return body.data;
};
const anonymous = await send(new URL('/api/entities/vehicleOwners/list-summary.php', loc), { redirect: 'error' });
assert.equal(anonymous.status, 401); await anonymous.arrayBuffer();
for (user of Object.keys(counts)) {
  const owners = (await ClientRepository.getAllOwners()).filter(o => o.deleted_at === null && o.name && o.owner_type !== 'broker');
  const reference = [];
  for (const o of owners) {
    const id = String(o.id), { balance, last_transaction_date: date, entry_count } = await FinancialService.getClientBalance(id, 'owner');
    const expectedCount = user === 'mixed' ? [0, 1, 7, 33, 128, 257, 513, 1024][(Number(id) - 700) % 8]
      : sizes[user];
    if (expectedCount !== undefined) assert.equal(entry_count, expectedCount, `${user}/${id}: full reference ledger`);
    reference.push({ id, type: 'owner', name: o.name, phone: o.phone || null, balance,
      last_activity: Math.max(0, date ? new Date(date).getTime() || 0 : 0) });
  }
  const actual = await OwnerListRepository.getAll();
  assert.deepEqual(actual, reference, `Every eligible owner, balance and activity, in source order (${user})`);
  assert.equal(actual.length, counts[user]);
  // Render the real list against this same HTTP endpoint. No counter cells mounted here.
  const body = { children: [], querySelectorAll: () => [] };
  globalThis.document = { getElementById: id => id === 'ownersTableBody' ? body : null, querySelectorAll: () => [] };
  await loadOwners();
  const displayed = [...body.innerHTML.matchAll(/data-action="view-client" data-id="(\d+)"/g)].map(m => m[1]);
  const ordered = reference.slice().sort((a, b) => Number(b.balance < 0) - Number(a.balance < 0) || b.last_activity - a.last_activity);
  assert.deepEqual(displayed, ordered.map(o => o.id), `Displayed order including stable ties (${user})`);
  const byId = Object.fromEntries(actual.map(o => [o.id, o.balance]));
  if (user === 'alpha') {
    for (const [id, balance] of [[1, 0], [2, 0], [3, 0], [4, 0], [7, .75], [8, 0], [4294967295, 1.01]]) assert.equal(byId[id], balance);
    const signed = [.37, -.37, 0], subtracted = [-.37, .37, 0], absoluteDebit = [-.37, -.37, 0];
    const signCases = [signed, subtracted, signed, absoluteDebit, signed, absoluteDebit, [0, 0, 0], [0, 0, 0]];
    signCases.flat().forEach((expected, i) => assert.equal(byId[20 + i], expected));
    assert.equal(actual.length, 42);
    for (const id of [9, 10, 11, 12]) assert.ok(!(id in byId));
    const scoped = await get('vehicle-ledger/list.php?client_type=owner&is_reversed=false&client_id=7');
    assert.deepEqual(scoped.map(e => e.client_id).sort(), ['7', '7 ']);
    assert.ok(scoped.every(e => e.username === 'alpha' && e.client_type.toLowerCase() === 'owner'));
    const wire = await get('vehicleOwners/list-summary.php?username=beta&client_type=office');
    // SQL never promised an intra-owner row order. Compare all replay operands in the
    // browser's actual order, without normalizing owner order, values or membership.
    const inReplayOrder = rows => rows.map(({ summary: s, ...o }) => ({ ...o, summary: {
      ...s, ...Object.fromEntries(Object.entries(s).filter(([, v]) => Array.isArray(v))
        .map(([k, v]) => [k, v.slice().sort(compareLedgerEntriesChronologicalDesc)])),
    } }));
    assert.deepEqual(inReplayOrder(wire), inReplayOrder(await get('vehicleOwners/list-summary.php')), 'query parameters cannot override scope');
    assert.deepEqual(wire.map(o => o.id), actual.map(o => o.id));
    const s = id => wire.find(o => o.id === String(id)).summary;
    for (const [i, c] of [2n**63n-1n, -(2n**63n), 2n**53n-1n, 2n**53n, 2n**53n+1n, 1n-2n**53n, -(2n**53n), -1n-2n**53n].entries()) {
      assert.equal(s(i + 44).precision_entries[0].amount, c.toString());
    }
    if ('balance_cents' in s(5)) assert.equal(s(5).balance_cents, 10**15);
    else assert.equal(s(5).precision_entries[0].amount, String(10**15)); // PHP_INT_MAX on a 32-bit PHP
    assert.equal(s(6).precision_entries.length, 2);
    assert.ok(s(13).activity.some(e => String(e.id) === '4294967295'));
  } else if (user === 'beta') assert.deepEqual(byId, { 9: -1.23 });
  else if (user === 'nobody') assert.deepEqual(actual, []);
  else if (user === 'edge') assert.equal(byId[811], .37); // concurrent fixture write is now committed
  console.log(`${user}: ${actual.length} owner snapshots match the original reader`);
}
