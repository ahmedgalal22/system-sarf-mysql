/**
 * utils/idGenerator.js — Centralized ID Generation
 * ─────────────────────────────────────────────────────────────────────────────
 * Provides a single generateId() function used across the entire application.
 *
 * Priority:
 *   1. crypto.randomUUID()       — native, available on HTTPS + modern browsers
 *   2. crypto.getRandomValues()  — RFC 4122 v4 UUID, works on HTTP + LAN
 *   3. Legacy fallback           — timestamp + counter + Math.random
 *
 * RULES:
 *   - NEVER throws
 *   - Works on HTTP (LAN deployments)
 *   - Works on HTTPS
 *   - Works in older browsers
 *   - Output is always a valid UUID-format string when crypto APIs are available
 *   - No external dependencies
 * ─────────────────────────────────────────────────────────────────────────────
 */

let _counter = 0;

/**
 * Generate a unique identifier.
 *
 * @returns {string} UUID-format string (or UUID-like string in legacy fallback)
 */
function generateId() {
  // 1. Native UUID — fastest, cryptographically secure
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  // 2. RFC 4122 v4 via getRandomValues — works on HTTP + LAN
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 1
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return (
      hex.slice(0, 8) + '-' +
      hex.slice(8, 12) + '-' +
      hex.slice(12, 16) + '-' +
      hex.slice(16, 20) + '-' +
      hex.slice(20, 32)
    );
  }

  // 3. Legacy fallback — timestamp + counter + Math.random
  _counter = (_counter + 1) & 0xffff;
  const ts = Date.now().toString(16).padStart(12, '0');
  const ct = _counter.toString(16).padStart(4, '0');
  const r1 = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  const r2 = Math.floor(Math.random() * 0x1000000000000).toString(16).padStart(12, '0');
  return (
    ts.slice(0, 8) + '-' +
    ts.slice(8, 12) + '-' +
    '4' + ct.slice(1, 4) + '-' +
    '8' + r1.slice(1, 4) + '-' +
    r2
  );
}

export { generateId };
export default generateId;
