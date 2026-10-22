/**
 * serverVerification.js — Server readiness verification (Hardened)
 * ─────────────────────────────────────────────────────────────────────────────
 * Verifies all server endpoints are functional before allowing SERVER mode.
 * Sets window.SERVER_MODE_READY = true ONLY when ALL checks pass.
 *
 * IF ANY CHECK FAILS:
 *   → System remains in LOCAL mode
 *   → No data loss
 *   → No error to user (silent degradation)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ApiClient } from './apiClient.js';

/**
 * Run all verification checks.
 * @returns {{ ready: boolean, results: object, errors: string[] }}
 */
async function verifyServerReady() {
  window.SERVER_MODE_READY = false;

  const results = {
    health: false,
    mysql: false,
    session: false,
    vehiclesApi: false,
  };
  const errors = [];

  try {
    // 1. Health check — PHP running + MySQL connected
    const health = await ApiClient.get('/health/ping.php');
    results.health = health.success;
    results.mysql = health.data?.mysql === 'connected';

    if (!results.health) errors.push('PHP server not reachable');
    if (!results.mysql) errors.push('MySQL not connected');

    if (!results.health || !results.mysql) {
      return { ready: false, results, errors };
    }

    // 2. Session system works
    const session = await ApiClient.get('/auth/session.php');
    results.session = session.success && session.type === 'ok';
    if (!results.session) errors.push('Session system not working');

    // 3. Vehicles API reachable (401 = exists but not logged in = OK)
    const vehicles = await ApiClient.get('/entities/vehicles/list.php');
    results.vehiclesApi = vehicles.success || vehicles.status === 401;
    if (!results.vehiclesApi) errors.push('Vehicles API not reachable');

    // ── Final decision ──
    const allPassed = Object.values(results).every(v => v === true);

    if (allPassed) {
      window.SERVER_MODE_READY = true;
      console.log('[ServerVerify] ✅ All checks passed — SERVER mode available');
    } else {
      console.warn('[ServerVerify] ⚠️ Checks failed:', errors);
    }

    return { ready: allPassed, results, errors };

  } catch (err) {
    errors.push(`Verification error: ${err.message}`);
    console.warn('[ServerVerify] Error:', err.message);
    return { ready: false, results, errors };
  }
}

/**
 * Quick check — is the server currently reachable?
 * Used for degraded mode detection.
 */
async function isServerReachable() {
  try {
    const res = await ApiClient.get('/health/ping.php');
    return res.success && res.data?.mysql === 'connected';
  } catch {
    return false;
  }
}

export { verifyServerReady, isServerReachable };
