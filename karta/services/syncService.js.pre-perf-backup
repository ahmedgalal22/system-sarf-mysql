/**
 * syncService.js — Real-Time Data Version Polling
 * ─────────────────────────────────────────────────────────────────────────────
 * RESPONSIBILITY (ONLY):
 *   1. Poll /api/sync/versions.php every POLL_INTERVAL ms
 *   2. Compare server versions with local lastVersions
 *   3. Dispatch domain events for changed entities
 *
 * DOES NOT:
 *   - Fetch any business data
 *   - Know how data is loaded or displayed
 *   - Perform any calculations
 *   - Modify any state outside its own lastVersions
 *
 * PATTERN:
 *   Uses the same ApiClient + window CustomEvent pattern as all other modules.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ApiClient } from './apiClient.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL = 4000; // ms

const ENDPOINT = '/sync/versions.php';

/**
 * Entity → domain event mapping.
 * Each key is an entity_name from data_versions.
 * Each value is the CustomEvent name to dispatch on window.
 */
const ENTITY_EVENT_MAP = Object.freeze({
  vehicle_owners:  'owners:changed',
  agents:          'agents:changed',
  offices:         'offices:changed',
  hamola_details:  'offices:changed',
  receipts:        'receipts:changed',
  treasury:        'treasury:changed',
  bolsa_forms:     'bolsaForms:changed',
  main_capital:    'capital:changed',
  vehicle_ledger:  'receipts:changed',
  archive_batches: 'archive:changed',
  drivers:         'drivers:changed',
  notes:           'notes:changed',
});

// ── Internal State ────────────────────────────────────────────────────────────

let _lastVersions = {};
let _timerId = null;
let _running = false;

// ── Core Logic ────────────────────────────────────────────────────────────────

/**
 * Single poll cycle:
 *   1. GET versions from server
 *   2. Compare each entity version with lastVersions
 *   3. Dispatch events for entities that changed
 *   4. Update lastVersions
 *
 * On failure: log, keep lastVersions intact, retry next cycle.
 */
async function _poll() {
  try {
    const res = await ApiClient.get(ENDPOINT, { retries: 0, timeout: 8000 });

    if (!res.success || !res.data) {
      // API failed — do nothing, retry next cycle
      return;
    }

    const serverVersions = res.data;

    // Collect unique events to dispatch (avoid duplicate dispatches
    // when multiple entities map to the same event, e.g. receipts + vehicle_ledger)
    const eventsToFire = new Set();

    for (const [entity, version] of Object.entries(serverVersions)) {
      const prev = _lastVersions[entity];

      // Skip if this is the first poll (seeding) or version unchanged
      if (prev === undefined || prev === version) continue;

      const eventName = ENTITY_EVENT_MAP[entity];
      if (eventName) {
        eventsToFire.add(eventName);
      }
    }

    // Update stored versions BEFORE dispatching events
    // (so listeners that re-query versions see the new state)
    _lastVersions = { ...serverVersions };

    // Dispatch all changed events
    for (const eventName of eventsToFire) {
      window.dispatchEvent(new CustomEvent(eventName));
    }

  } catch (err) {
    // Unexpected error — log and continue. Do NOT clear lastVersions.
    console.warn('[SyncService] poll error:', err.message || err);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Start polling. Safe to call multiple times (no-op if already running).
 */
function start() {
  if (_running) return;
  _running = true;
  console.log('[SyncService] ▶ بدء مراقبة التغييرات — كل', POLL_INTERVAL, 'ms');

  // Run first poll immediately to seed lastVersions
  _poll();

  _timerId = setInterval(_poll, POLL_INTERVAL);
}

/**
 * Stop polling. Preserves lastVersions for potential restart.
 */
function stop() {
  if (!_running) return;
  _running = false;
  if (_timerId !== null) {
    clearInterval(_timerId);
    _timerId = null;
  }
  console.log('[SyncService] ⏹ توقف مراقبة التغييرات');
}

/**
 * Is the service currently polling?
 */
function isRunning() {
  return _running;
}

// ── Export ─────────────────────────────────────────────────────────────────────

const SyncService = Object.freeze({
  start,
  stop,
  isRunning,
});

export { SyncService };
export default SyncService;
