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
 * Detect API base URL from current page location.
 * Works on localhost AND LAN (192.168.x.x) without hardcoding.
 */
function _detectApiBase() {
  const loc = window.location;
  // If page is served from /karta/..., API is at /karta/api
  // If page is at root, API is at /api
  const pathParts = loc.pathname.split('/').filter(Boolean);
  // Find 'karta' in path or use first segment
  const kartaIdx = pathParts.indexOf('karta');
  if (kartaIdx !== -1) {
    return `${loc.protocol}//${loc.host}/${pathParts.slice(0, kartaIdx + 1).join('/')}/api`;
  }
  return `${loc.protocol}//${loc.host}/karta/api`;
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
  getMode,
  isServerMode,
  isLocalMode,
  activateServerMode,
  activateLocalMode,
};
