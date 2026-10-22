/**
 * domainTransitionLogger.js — Domain transition audit log
 * ─────────────────────────────────────────────────────────────────────────────
 * Logs domain ownership transitions and access violations.
 * No sensitive financial data is logged — only domain/operation metadata.
 *
 * In production, these logs help diagnose migration issues.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const _log = [];
const MAX_LOG_SIZE = 500;

/**
 * Log a domain transition event.
 *
 * @param {string} domain — store name
 * @param {string} event — e.g. 'MIGRATION_ALLOWED', 'MIGRATION_BLOCKED', 'ACCESS_VIOLATION'
 * @param {string} detail — human-readable reason
 */
export function logTransition(domain, event, detail = '') {
  const entry = {
    timestamp: new Date().toISOString(),
    domain,
    event,
    detail,
  };

  _log.push(entry);
  if (_log.length > MAX_LOG_SIZE) {
    _log.splice(0, _log.length - MAX_LOG_SIZE);
  }

  // Console output for development
  const prefix = event.includes('BLOCK') || event.includes('VIOLATION')
    ? '⚠️' : '✅';
  console.log(`[DomainLog] ${prefix} ${domain}: ${event}${detail ? ' — ' + detail : ''}`);
}

/**
 * Log a domain access violation (write to wrong transport).
 */
export function logAccessViolation(domain, operation, expectedTransport, attemptedTransport) {
  logTransition(domain, 'ACCESS_VIOLATION',
    `${operation} attempted via ${attemptedTransport}, expected ${expectedTransport}`);
}

/**
 * Get all logged transitions (for diagnostics).
 */
export function getTransitionLog() {
  return [..._log];
}

/**
 * Clear the log.
 */
export function clearTransitionLog() {
  _log.length = 0;
}
