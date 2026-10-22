/**
 * apiConfig.js — Server connection configuration
 * ─────────────────────────────────────────────────────────────────────────────
 * Controls whether the system uses IndexedDB (LOCAL) or PHP API (SERVER).
 *
 * RULE: The system operates in ONE mode only — never both simultaneously.
 *       MODE is set once at startup and does not change during a session.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const DATA_MODE = Object.freeze({
  LOCAL:  'LOCAL',   // IndexedDB — current default
  SERVER: 'SERVER',  // PHP + MySQL via REST API
});

// ── Active mode — start LOCAL, switch to SERVER only after verification ──
let _currentMode = DATA_MODE.LOCAL;

/**
 * Detect API base URL relative to the running application directory.
 * Works on localhost AND LAN (192.168.x.x) under any folder name in htdocs
 * without hardcoding 'karta' or falling back to another installation's API.
 */
function _detectApiBase(customLoc = null) {
  if (!customLoc && typeof import.meta !== 'undefined' && import.meta.url && /^https?:\/\//i.test(import.meta.url)) {
    return new URL('../api', import.meta.url).href.replace(/\/+$/, '');
  }
  const loc = customLoc || (typeof window !== 'undefined' ? window.location : null);
  if (!loc) return '/api';
  const rawPath = String(loc.pathname || '/').replace(/\/+$/, '');
  const segments = rawPath.split('/').filter(Boolean);
  if (segments.length > 0 && /\.[a-z0-9]+$/i.test(segments[segments.length - 1])) {
    segments.pop();
  }
  const basePath = segments.length > 0 ? `/${segments.join('/')}` : '';
  return `${loc.protocol}//${loc.host}${basePath}/api`;
}

const API_BASE = _detectApiBase();

const API_CONFIG = Object.freeze({
  BASE_URL:    API_BASE,
  TIMEOUT:     15000,   // 15 seconds
  RETRY_COUNT: 1,       // 1 retry on network failure
  RETRY_DELAY: 1000,    // 1 second between retries
});

// ── Mode control ──────────────────────────────────────────────────────────────

function getMode() {
  return _currentMode;
}

function isServerMode() {
  return _currentMode === DATA_MODE.SERVER;
}

function isLocalMode() {
  return _currentMode === DATA_MODE.LOCAL;
}

/**
 * Switch to SERVER mode. Only callable after server verification.
 * Cannot be called from console without SERVER_MODE_READY flag.
 */
function activateServerMode() {
  if (!window.SERVER_MODE_READY) {
    console.error('[apiConfig] Cannot activate SERVER mode — verification not complete');
    return false;
  }
  _currentMode = DATA_MODE.SERVER;
  console.log('[apiConfig] ✅ SERVER mode activated');
  return true;
}

function activateLocalMode() {
  _currentMode = DATA_MODE.LOCAL;
  console.log('[apiConfig] ✅ LOCAL mode activated');
}

export {
  API_CONFIG,
  DATA_MODE,
  _detectApiBase,
  getMode,
  isServerMode,
  isLocalMode,
  activateServerMode,
  activateLocalMode,
};
