/**
 * ============================================================================
 * Automated Test Suite: 30-Day Rolling PHP Session Persistence (v2 — Review Corrections)
 * ============================================================================
 *
 * NOTE ON EXECUTION ENVIRONMENT:
 *   The sandbox container does not have the `php` CLI binary installed.
 *   Therefore, this test suite verifies:
 *     1. Exact PHP source structure & invariants across `karta/config/session.php`,
 *        `karta/core/helpers.php`, `karta/core/bootstrap.php`,
 *        `karta/api/middleware/auth.php`, `karta/api/auth/session.php`,
 *        `karta/api/health/ping.php`, `karta/api/sync/versions.php`,
 *        `karta/api/auth/login.php`, and `karta/api/auth/logout.php`.
 *     2. Deterministic time-travel simulation of the exact PHP rolling-session
 *        lifecycle (`markSessionAuthenticated`, `enforceAndRenewRollingSession`,
 *        `isPassiveSessionRequest`, `releasePassiveSessionLock`, `expireAuthenticatedSession`)
 *        combined with the real ES modules (`ApiClient`, `ServerVerification`,
 *        `SyncService`, `AuthModule`, `DBProvider`, `ReceiptRepository`,
 *        `OfficeRepository`, `ClientRepository`, `TreasuryRepository`,
 *        `DashboardRepository`, `FinancialService`).
 *
 * Covers all 9 required review scenarios:
 *   1. GET /api/auth/session.php does NOT renew session activity or extend expiration
 *   2. GET /api/health/ping.php does NOT renew session activity or extend expiration
 *   3. GET /api/sync/versions.php does NOT renew session activity or extend expiration
 *   4. Startup readiness checks (ServerVerification) do NOT renew session activity
 *   5. Sync-triggered automatic refreshes do NOT renew session activity
 *   6. Genuine interactive authenticated requests DO renew session activity & extend expiration
 *   7. Passive requests still enforce 30-day inactivity expiration
 *   8. An expired session cannot be revived by any passive, background, or active request
 *   9. Login, logout, session lock release (session_abort vs session_write_close),
 *      monotonic max() timestamps, and legacy session safety remain intact
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const KARTA_ROOT = path.resolve(__dirname, '..');

function readKartaFile(relPath) {
  return fs.readFileSync(path.join(KARTA_ROOT, relPath), 'utf8');
}

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60; // 2,592,000
const RENEWAL_INTERVAL_SECONDS = 60;

/**
 * Faithful behavioral model of the PHP session lifecycle in:
 *   - karta/config/session.php
 *   - karta/core/helpers.php
 *   - karta/core/bootstrap.php
 *   - karta/api/middleware/auth.php
 *   - karta/api/auth/login.php
 *   - karta/api/auth/logout.php
 *   - karta/api/auth/session.php
 *   - karta/api/health/ping.php
 *   - karta/api/sync/versions.php
 */
class PhpSessionSimulator {
  constructor(config = {}) {
    this.config = {
      name: 'KARTA_SESSION',
      lifetime: THIRTY_DAYS_SECONDS,
      gc_maxlifetime: THIRTY_DAYS_SECONDS,
      renewal_interval: RENEWAL_INTERVAL_SECONDS,
      path: '/',
      httponly: true,
      samesite: 'Lax',
      ...config,
    };
    this.sessionFiles = new Map(); // sessionId -> { data, mtime, writeCount, abortCount, lockReleased }
    this.currentCookie = null;     // { id, expiresAt }
    this.cookieHistory = [];
  }

  _isPassiveSessionRequest(scriptName, headers = {}) {
    const base = path.basename(scriptName);
    if (base === 'versions.php' || base === 'session.php' || base === 'ping.php') {
      return true;
    }
    if (String(headers['X-Background-Poll'] ?? headers['x-background-poll'] ?? '') === '1') {
      return true;
    }
    if (String(headers['X-Passive-Request'] ?? headers['x-passive-request'] ?? '') === '1') {
      return true;
    }
    return false;
  }

  _sendSessionCookie(sessionId, expiresAt, now) {
    this.currentCookie = {
      name: this.config.name,
      id: sessionId,
      expiresAt,
      issuedAt: now,
      maxAge: Math.max(0, expiresAt - now),
    };
    this.cookieHistory.push({ ...this.currentCookie });
  }

  _expireAuthenticatedSession(sessionId, now) {
    this.sessionFiles.delete(sessionId);
    this._sendSessionCookie('', now - 42000, now);
  }

  runGarbageCollection(now) {
    for (const [sid, record] of this.sessionFiles.entries()) {
      if (now - record.mtime > this.config.gc_maxlifetime) {
        this.sessionFiles.delete(sid);
      }
    }
  }

  login(username, role, now) {
    const sessionId = `sess_${Math.random().toString(36).slice(2, 10)}_${now}`;
    const sessionData = {
      user_id: 1,
      username,
      full_name: 'مدير النظام',
      role,
      logged_in: true,
      login_at: now,
      last_activity_at: now,
      cookie_refreshed_at: now,
    };
    this.sessionFiles.set(sessionId, {
      data: sessionData,
      mtime: now,
      writeCount: 1,
      abortCount: 0,
      lockReleased: true,
    });
    this._sendSessionCookie(sessionId, now + this.config.lifetime, now);
    return sessionId;
  }

  logout(now) {
    if (this.currentCookie && this.currentCookie.id) {
      this._expireAuthenticatedSession(this.currentCookie.id, now);
    }
    return { status: 200, body: { success: true, type: 'ok' } };
  }

  /**
   * Simulate an HTTP request hitting a PHP endpoint that requires bootstrap.php.
   */
  request(scriptName, { now, headers = {}, requireAuth = true } = {}) {
    this.runGarbageCollection(now);

    if (this.currentCookie && this.currentCookie.expiresAt <= now) {
      this.currentCookie = null;
    }

    const sid = this.currentCookie?.id || null;
    const record = sid ? this.sessionFiles.get(sid) : null;
    const session = record ? { ...record.data } : {};
    const snapshotBefore = JSON.stringify(session);

    const base = path.basename(scriptName);
    const passive = this._isPassiveSessionRequest(scriptName, headers);
    let expiredByPolicy = false;

    if (base !== 'login.php' && base !== 'logout.php') {
      if (session.logged_in === true) {
        // 1. Inactivity expiration check (applies to BOTH passive and active requests)
        if (typeof session.last_activity_at === 'number') {
          const idleSeconds = now - session.last_activity_at;
          if (idleSeconds > this.config.lifetime) {
            this._expireAuthenticatedSession(sid, now);
            expiredByPolicy = true;
          }
        }

        // 2. Passive requests never establish or advance last_activity_at or renew cookies
        if (!expiredByPolicy && !passive) {
          const prevActivity = typeof session.last_activity_at === 'number'
            ? session.last_activity_at
            : 0;
          session.last_activity_at = Math.max(prevActivity, now);

          const lastRefresh = typeof session.cookie_refreshed_at === 'number'
            ? session.cookie_refreshed_at
            : 0;
          if (lastRefresh === 0 || (now - lastRefresh) >= this.config.renewal_interval) {
            session.cookie_refreshed_at = Math.max(lastRefresh, now);
            this._sendSessionCookie(sid, now + this.config.lifetime, now);
          }
        }
      }
    }

    // Commit or abort session changes matching releasePassiveSessionLock()
    if (!expiredByPolicy && sid && this.sessionFiles.has(sid)) {
      if (passive && JSON.stringify(session) === snapshotBefore) {
        // session_abort(): no disk write, mtime unchanged
        record.abortCount += 1;
        record.lockReleased = true;
      } else {
        // session_write_close() / normal shutdown: persist changes & update mtime
        record.data = session;
        record.mtime = now;
        record.writeCount += 1;
        record.lockReleased = true;
      }
    }

    const isAuthenticated = !expiredByPolicy && session.logged_in === true;

    if (base === 'ping.php') {
      return {
        status: 200,
        passive,
        body: {
          success: true,
          type: 'ok',
          data: {
            status: 'ok',
            session: 'active',
            mysql: 'connected',
          },
        },
      };
    }

    if (base === 'session.php') {
      return {
        status: 200,
        passive,
        body: {
          success: true,
          type: 'ok',
          data: isAuthenticated
            ? {
                logged_in: true,
                user_id: session.user_id,
                username: session.username,
                full_name: session.full_name,
                role: session.role,
              }
            : {
                logged_in: false,
              },
        },
      };
    }

    if (requireAuth && !isAuthenticated) {
      return {
        status: 401,
        passive,
        body: {
          success: false,
          type: 'auth',
          message: 'غير مصرح — يرجى تسجيل الدخول',
          data: null,
        },
      };
    }

    if (base === 'versions.php') {
      return {
        status: 200,
        passive,
        body: {
          success: true,
          type: 'ok',
          data: {
            vehicle_owners: '1:100',
            vehicles: '1:100',
            offices: '1:100',
            receipts: '1:100',
            treasury: '1:100',
            vehicle_ledger: '1:100',
            capital: '1:100',
          },
        },
      };
    }

    return {
      status: 200,
      passive,
      body: {
        success: true,
        type: 'ok',
        data: [],
      },
    };
  }
}

// ============================================================================
// 1. PHP Configuration & Passive Classification Source Verification
// ============================================================================
describe('1. PHP Source Verification — Passive Request Classification & Lock Release', () => {
  it('configures 30-day (2,592,000s) lifetime, gc_maxlifetime, 60s renewal_interval, and storage/sessions path', () => {
    const configPhp = readKartaFile('config/session.php');
    assert.match(configPhp, /'lifetime'\s*=>\s*2592000\b/);
    assert.match(configPhp, /'gc_maxlifetime'\s*=>\s*2592000\b/);
    assert.match(configPhp, /'renewal_interval'\s*=>\s*60\b/);
    assert.match(configPhp, /'save_path'\s*=>\s*__DIR__\s*\.\s*'\/\.\.\/storage\/sessions'/);
  });

  it('defines isPassiveSessionRequest() classifying versions.php, session.php, ping.php, X-Background-Poll: 1, and X-Passive-Request: 1', () => {
    const helpersPhp = readKartaFile('core/helpers.php');
    assert.match(helpersPhp, /function\s+isPassiveSessionRequest\s*\(\s*\)\s*:\s*bool/);
    assert.match(helpersPhp, /\$script\s*===\s*'versions\.php'\s*\|\|\s*\$script\s*===\s*'session\.php'\s*\|\|\s*\$script\s*===\s*'ping\.php'/);
    assert.match(helpersPhp, /HTTP_X_BACKGROUND_POLL/);
    assert.match(helpersPhp, /HTTP_X_PASSIVE_REQUEST/);
  });

  it('defines releasePassiveSessionLock() using session_abort() when unmodified and session_write_close() when preserving changes', () => {
    const helpersPhp = readKartaFile('core/helpers.php');
    assert.match(helpersPhp, /function\s+releasePassiveSessionLock\s*\(\s*bool\s+\$preserveChanges\s*=\s*false\s*\)\s*:\s*void/);
    assert.match(helpersPhp, /@session_write_close\s*\(\s*\)/);
    assert.match(helpersPhp, /@session_abort\s*\(\s*\)/);

    const authMiddlewarePhp = readKartaFile('api/middleware/auth.php');
    assert.match(authMiddlewarePhp, /if\s*\(\s*isPassiveSessionRequest\s*\(\s*\)\s*\)\s*\{\s*releasePassiveSessionLock\s*\(\s*false\s*\)\s*;/);

    const sessionPhp = readKartaFile('api/auth/session.php');
    assert.match(sessionPhp, /\$user\s*=\s*getSessionUser\s*\(\s*\)\s*;\s*releasePassiveSessionLock\s*\(\s*false\s*\)\s*;/);

    const pingPhp = readKartaFile('api/health/ping.php');
    assert.match(pingPhp, /'session'\s*=>\s*session_status\s*\(\s*\)\s*===\s*PHP_SESSION_ACTIVE\s*\?\s*'active'\s*:\s*'inactive'/);
    assert.match(pingPhp, /releasePassiveSessionLock\s*\(\s*false\s*\)\s*;/);

    const versionsPhp = readKartaFile('api/sync/versions.php');
    assert.match(versionsPhp, /releasePassiveSessionLock\s*\(\s*false\s*\)\s*;/);
  });

  it('enforces inactivity expiration BEFORE passive return and updates activity monotonically with max()', () => {
    const helpersPhp = readKartaFile('core/helpers.php');
    const fnStart = helpersPhp.indexOf('function enforceAndRenewRollingSession');
    assert.ok(fnStart !== -1, 'enforceAndRenewRollingSession must exist');
    const fnBody = helpersPhp.slice(fnStart);

    const expireIndex = fnBody.indexOf('expireAuthenticatedSession($sessionConfig, $currentTime)');
    const passiveReturnIndex = fnBody.indexOf('if (isPassiveSessionRequest())');
    const updateActivityIndex = fnBody.indexOf("$_SESSION['last_activity_at'] = max(");

    assert.ok(expireIndex !== -1, 'Must call expireAuthenticatedSession on idle > lifetime');
    assert.ok(passiveReturnIndex !== -1, 'Must check isPassiveSessionRequest()');
    assert.ok(updateActivityIndex !== -1, 'Must update last_activity_at monotonically via max()');
    assert.ok(
      expireIndex < passiveReturnIndex && passiveReturnIndex < updateActivityIndex,
      'Order must be: (1) check idle expiration -> (2) return early if passive -> (3) update last_activity_at via max()'
    );
  });

  it('allows X-Background-Poll and X-Passive-Request in CORS Access-Control-Allow-Headers', () => {
    const bootstrapPhp = readKartaFile('core/bootstrap.php');
    assert.match(bootstrapPhp, /Access-Control-Allow-Headers:\s*Content-Type,\s*Accept,\s*X-Background-Poll,\s*X-Passive-Request/);
  });
});

// ============================================================================
// 2. Scenario 1, 2, 3: Passive Endpoints Never Renew Activity or Extend Expiry
// ============================================================================
describe('2. Passive Endpoints (session.php, ping.php, versions.php) Never Extend Session', () => {
  it('Scenario 1: GET /api/auth/session.php does NOT update last_activity_at, cookie_refreshed_at, mtime, or cookie expiry', () => {
    const sim = new PhpSessionSimulator();
    const t0 = 1_700_000_000;
    const sid = sim.login('admin', 'admin', t0);
    const cookieCountAfterLogin = sim.cookieHistory.length;

    const tCheck = t0 + 14 * 86400; // Day 14
    const res = sim.request('/api/auth/session.php', { now: tCheck, requireAuth: false });
    assert.equal(res.status, 200);
    assert.equal(res.passive, true);
    assert.equal(res.body.data.logged_in, true);

    const record = sim.sessionFiles.get(sid);
    assert.equal(record.data.last_activity_at, t0, 'session.php must not advance last_activity_at');
    assert.equal(record.data.cookie_refreshed_at, t0, 'session.php must not advance cookie_refreshed_at');
    assert.equal(record.mtime, t0, 'session.php must not rewrite session file or advance mtime');
    assert.equal(record.writeCount, 1, 'session.php must not write to session file');
    assert.equal(record.abortCount, 1, 'session.php must release lock via session_abort()');
    assert.equal(sim.cookieHistory.length, cookieCountAfterLogin, 'session.php must not reissue cookie');
  });

  it('Scenario 2: GET /api/health/ping.php does NOT update last_activity_at, cookie_refreshed_at, mtime, or cookie expiry', () => {
    const sim = new PhpSessionSimulator();
    const t0 = 1_700_000_000;
    const sid = sim.login('admin', 'admin', t0);
    const cookieCountAfterLogin = sim.cookieHistory.length;

    const tPing = t0 + 10 * 86400; // Day 10
    const res = sim.request('/api/health/ping.php', { now: tPing, requireAuth: false });
    assert.equal(res.status, 200);
    assert.equal(res.passive, true);
    assert.equal(res.body.data.session, 'active');

    const record = sim.sessionFiles.get(sid);
    assert.equal(record.data.last_activity_at, t0, 'ping.php must not advance last_activity_at');
    assert.equal(record.data.cookie_refreshed_at, t0, 'ping.php must not advance cookie_refreshed_at');
    assert.equal(record.mtime, t0, 'ping.php must not rewrite session file');
    assert.equal(record.abortCount, 1);
    assert.equal(sim.cookieHistory.length, cookieCountAfterLogin);
  });

  it('Scenario 3: GET /api/sync/versions.php does NOT update last_activity_at, cookie_refreshed_at, mtime, or cookie expiry', () => {
    const sim = new PhpSessionSimulator();
    const t0 = 1_700_000_000;
    const sid = sim.login('admin', 'admin', t0);
    const cookieCountAfterLogin = sim.cookieHistory.length;

    // Poll every day for 29 days
    for (let day = 1; day <= 29; day++) {
      const tPoll = t0 + day * 86400;
      const res = sim.request('/api/sync/versions.php', {
        now: tPoll,
        headers: { 'X-Background-Poll': '1' },
      });
      assert.equal(res.status, 200);
      assert.equal(res.passive, true);
    }

    const record = sim.sessionFiles.get(sid);
    assert.equal(record.data.last_activity_at, t0, 'versions.php must never advance last_activity_at');
    assert.equal(record.data.cookie_refreshed_at, t0, 'versions.php must never advance cookie_refreshed_at');
    assert.equal(record.mtime, t0, 'versions.php must never rewrite session file');
    assert.equal(record.writeCount, 1);
    assert.equal(record.abortCount, 29);
    assert.equal(sim.cookieHistory.length, cookieCountAfterLogin);
  });
});

// ============================================================================
// 3. Scenario 4: Startup Readiness Checks (ServerVerification) Are Passive
// ============================================================================
describe('3. Scenario 4 — Startup Readiness Checks (ServerVerification) Are Passive', () => {
  it('ServerVerification.verifyServerReady() and isServerReachable() attach X-Background-Poll: 1 and do NOT renew session activity', async () => {
    const sim = new PhpSessionSimulator();
    const t0 = 1_700_000_000;
    const sid = sim.login('admin', 'admin', t0);
    const tStartup = t0 + 7 * 86400; // 7 days after login

    const capturedRequests = [];
    const origFetch = globalThis.fetch;
    const origWindow = globalThis.window;

    globalThis.window = {
      location: {
        protocol: 'http:',
        hostname: 'localhost',
        port: '8080',
        origin: 'http://localhost:8080',
        pathname: '/karta/index.html',
      },
    };

    globalThis.fetch = async (url, options = {}) => {
      const endpoint = String(url).replace(/^https?:\/\/[^/]+\/karta\/api/, '/api');
      const headers = options.headers || {};
      capturedRequests.push({ endpoint, headers });
      const simRes = sim.request(endpoint, {
        now: tStartup,
        headers,
        requireAuth: !endpoint.endsWith('ping.php') && !endpoint.endsWith('session.php'),
      });
      return {
        ok: simRes.status >= 200 && simRes.status < 300,
        status: simRes.status,
        text: async () => JSON.stringify(simRes.body),
      };
    };

    try {
      const { verifyServerReady, isServerReachable } = await import('../services/serverVerification.js');
      const readyReport = await verifyServerReady();
      assert.equal(readyReport.ready, true);

      const reachable = await isServerReachable();
      assert.equal(reachable, true);

      assert.equal(capturedRequests.length, 4);
      for (const req of capturedRequests) {
        assert.equal(
          req.headers['X-Background-Poll'],
          '1',
          `Expected startup request ${req.endpoint} to carry X-Background-Poll: 1`
        );
      }

      // Verify session timestamps and file mtime were untouched by startup checks
      const record = sim.sessionFiles.get(sid);
      assert.equal(record.data.last_activity_at, t0);
      assert.equal(record.data.cookie_refreshed_at, t0);
      assert.equal(record.mtime, t0);
      assert.equal(record.writeCount, 1);
    } finally {
      globalThis.fetch = origFetch;
      globalThis.window = origWindow;
    }
  });
});

// ============================================================================
// 4. Scenario 5: SyncService & Sync-Triggered Automatic Refreshes Are Passive
// ============================================================================
describe('4. Scenario 5 — SyncService and Sync-Triggered Automatic Refreshes Are Passive', () => {
  it('SyncService dispatches { detail: { passive: true, source: "sync" } } and sync-triggered repository fetches send X-Background-Poll: 1 without renewing activity', async () => {
    const sim = new PhpSessionSimulator();
    const t0 = 1_700_000_000;
    const sid = sim.login('admin', 'admin', t0);
    let currentNow = t0 + 5 * 86400; // Day 5

    let receiptVersion = '1:100';
    const capturedRequests = [];
    const listeners = new Map();

    const origFetch = globalThis.fetch;
    const origWindow = globalThis.window;
    const origDocument = globalThis.document;
    const origCustomEvent = globalThis.CustomEvent;

    class MockCustomEvent {
      constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail ?? null;
      }
    }

    globalThis.CustomEvent = MockCustomEvent;
    globalThis.document = {
      hidden: false,
      getElementById: () => null,
      addEventListener: () => {},
    };
    globalThis.window = {
      SERVER_MODE_READY: true,
      __APP_CONTEXT__: { username: 'admin', role: 'admin' },
      location: {
        protocol: 'http:',
        hostname: 'localhost',
        port: '8080',
        origin: 'http://localhost:8080',
        pathname: '/karta/index.html',
      },
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(fn);
      },
      dispatchEvent(evt) {
        const fns = listeners.get(evt.type) || [];
        for (const fn of fns) fn(evt);
      },
    };

    globalThis.fetch = async (url, options = {}) => {
      const endpoint = String(url).replace(/^https?:\/\/[^/]+\/karta\/api/, '/api');
      const headers = options.headers || {};
      capturedRequests.push({ endpoint, headers });

      const simRes = sim.request(endpoint, { now: currentNow, headers });
      if (endpoint.endsWith('/sync/versions.php') && simRes.status === 200) {
        simRes.body.data.receipts = receiptVersion;
      }
      return {
        ok: simRes.status >= 200 && simRes.status < 300,
        status: simRes.status,
        text: async () => JSON.stringify(simRes.body),
      };
    };

    try {
      const { activateServerMode } = await import('../services/apiConfig.js');
      activateServerMode();
      const { SyncService } = await import('../services/syncService.js');
      const { ReceiptRepository } = await import('../services/receiptRepository.js');
      const { OfficeRepository } = await import('../services/officeRepository.js');
      const { ClientRepository } = await import('../services/clientRepository.js');
      const { TreasuryRepository } = await import('../services/treasuryRepository.js');
      const { DashboardRepository } = await import('../services/dashboardRepository.js');

      const refreshPromises = [];
      globalThis.window.addEventListener('receipts:changed', (event) => {
        const options = event?.detail?.passive === true ? { passive: true } : {};
        refreshPromises.push(
          Promise.all([
            ReceiptRepository.getAll('admin', options),
            OfficeRepository.getAll('admin', options),
            ClientRepository.getAllOwners(options),
            TreasuryRepository.getAll('admin', options),
            DashboardRepository.getCapitalTransactions('admin', options),
          ])
        );
      });

      // Poll 1: seeds initial versions
      SyncService.start();
      await new Promise((r) => setTimeout(r, 30));
      SyncService.stop();

      // Advance receiptVersion so next poll fires receipts:changed
      receiptVersion = '2:200';
      SyncService.start();
      await new Promise((r) => setTimeout(r, 30));
      SyncService.stop();
      await Promise.all(refreshPromises);

      assert.ok(capturedRequests.length >= 7, 'Should have captured polls + 5 repository refreshes');
      for (const req of capturedRequests) {
        assert.equal(
          req.headers['X-Background-Poll'],
          '1',
          `Expected sync/refresh request ${req.endpoint} to carry X-Background-Poll: 1`
        );
      }

      // Session activity and mtime must still equal t0!
      const record = sim.sessionFiles.get(sid);
      assert.equal(record.data.last_activity_at, t0, 'Sync-triggered refreshes must NOT update last_activity_at');
      assert.equal(record.data.cookie_refreshed_at, t0, 'Sync-triggered refreshes must NOT update cookie_refreshed_at');
      assert.equal(record.mtime, t0, 'Sync-triggered refreshes must NOT rewrite session file');
    } finally {
      globalThis.fetch = origFetch;
      globalThis.window = origWindow;
      globalThis.document = origDocument;
      globalThis.CustomEvent = origCustomEvent;
    }
  });

  it('verifies event listeners in allReceipts.js, offices.js, entities.js, treasury.js, dashboard.js, and receipts.js forward { passive: true } on sync events', () => {
    const allReceiptsSrc = readKartaFile('allReceipts.js');
    assert.match(allReceiptsSrc, /const\s+isPassive\s*=\s*event\?\.detail\?\.passive\s*===\s*true/);
    assert.match(allReceiptsSrc, /const\s+options\s*=\s*_refreshPassiveOnly\s*\?\s*\{\s*passive:\s*true\s*\}\s*:\s*\{\s*\}/);

    for (const file of [
      'offices.js',
      'entities.js',
      'treasury.js',
      'dashboard.js',
      'receipts.js',
    ]) {
      const src = readKartaFile(file);
      assert.match(
        src,
        /event\?\.detail\?\.passive\s*===\s*true\s*\?\s*\{\s*passive:\s*true\s*\}/,
        `Expected ${file} to propagate { passive: true } when event?.detail?.passive === true`
      );
    }
  });
});

// ============================================================================
// 5. Scenario 6, 7, 8, 9: Genuine Activity Renewal, 30-Day Expiry, No Revival, Auth Intact
// ============================================================================
describe('5. Scenarios 6, 7, 8, 9 — Genuine Activity Renewal, 30-Day Expiration, No Revival, and Auth Lifecycle', () => {
  it('Scenario 6 (Fixed Test 4C): Genuine interactive authenticated request renews session activity and extends expiration by 30 days, whereas AuthModule.checkSession() is passive', async () => {
    const sim = new PhpSessionSimulator();
    const t0 = 1_700_000_000;
    const sid = sim.login('admin', 'admin', t0);

    let currentNow = t0 + 20 * 86400; // Day 20
    const origFetch = globalThis.fetch;
    const origWindow = globalThis.window;
    const origDocument = globalThis.document;
    const origSessionStorage = globalThis.sessionStorage;

    const storageMap = new Map();
    globalThis.sessionStorage = {
      getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
      setItem: (k, v) => storageMap.set(k, String(v)),
      removeItem: (k) => storageMap.delete(k),
      clear: () => storageMap.clear(),
    };
    globalThis.document = {
      hidden: false,
      getElementById: () => null,
      addEventListener: () => {},
    };
    globalThis.window = {
      SERVER_MODE_READY: true,
      __APP_CONTEXT__: null,
      location: {
        protocol: 'http:',
        hostname: 'localhost',
        port: '8080',
        origin: 'http://localhost:8080',
        pathname: '/karta/index.html',
      },
    };

    globalThis.fetch = async (url, options = {}) => {
      const endpoint = String(url).replace(/^https?:\/\/[^/]+\/karta\/api/, '/api');
      const headers = options.headers || {};
      const simRes = sim.request(endpoint, {
        now: currentNow,
        headers,
        requireAuth: !endpoint.endsWith('session.php') && !endpoint.endsWith('ping.php'),
      });
      return {
        ok: simRes.status >= 200 && simRes.status < 300,
        status: simRes.status,
        text: async () => JSON.stringify(simRes.body),
      };
    };

    try {
      const { activateServerMode } = await import('../services/apiConfig.js');
      activateServerMode();
      const { AuthModule } = await import('../auth.js');
      const { ReceiptRepository } = await import('../services/receiptRepository.js');

      // 1. Passive AuthModule.checkSession() on Day 20 does NOT extend activity
      const sessionUser = await AuthModule.checkSession();
      assert.equal(sessionUser?.username, 'admin');
      assert.equal(
        sim.sessionFiles.get(sid).data.last_activity_at,
        t0,
        'AuthModule.checkSession() (GET /api/auth/session.php) must NOT advance last_activity_at'
      );

      // 2. Genuine interactive authenticated request on Day 20 DOES renew activity to Day 20 + 30 days
      await ReceiptRepository.getAll('admin');
      assert.equal(
        sim.sessionFiles.get(sid).data.last_activity_at,
        currentNow,
        'Interactive ReceiptRepository.getAll("admin") must advance last_activity_at to Day 20'
      );
      assert.equal(
        sim.currentCookie.expiresAt,
        currentNow + THIRTY_DAYS_SECONDS,
        'Interactive request must extend cookie expiration to Day 50'
      );

      // 3. On Day 45 (25 days after Day 20 interactive request), session is still valid
      currentNow = t0 + 45 * 86400;
      const checkDay45 = await AuthModule.checkSession();
      assert.equal(checkDay45?.username, 'admin');

      // 4. On Day 51 (31 days after Day 20 interactive request, with only passive checkSession on Day 45),
      //    session expires!
      currentNow = t0 + 51 * 86400;
      const checkDay51 = await AuthModule.checkSession();
      assert.equal(checkDay51, null, 'Session must expire 30 days after the last genuine interactive request');
    } finally {
      globalThis.fetch = origFetch;
      globalThis.window = origWindow;
      globalThis.document = origDocument;
      globalThis.sessionStorage = origSessionStorage;
    }
  });

  it('Scenario 7 & 8: Passive requests enforce 30-day inactivity expiration, and an expired session cannot be revived by passive or active requests', () => {
    const sim = new PhpSessionSimulator();
    const t0 = 1_700_000_000;
    const sid = sim.login('admin', 'admin', t0);

    // At 30 days + 1 second, a passive versions.php poll immediately expires the session
    const tExpired = t0 + THIRTY_DAYS_SECONDS + 1;
    const pollRes = sim.request('/api/sync/versions.php', {
      now: tExpired,
      headers: { 'X-Background-Poll': '1' },
    });
    assert.equal(pollRes.status, 401);
    assert.equal(sim.sessionFiles.has(sid), false);

    // Subsequent passive or active requests cannot revive the expired session
    const passiveSessionCheck = sim.request('/api/auth/session.php', {
      now: tExpired + 5,
      requireAuth: false,
    });
    assert.equal(passiveSessionCheck.body.data.logged_in, false);

    const activeAttempt = sim.request('/api/entities/receipts/list.php', {
      now: tExpired + 10,
    });
    assert.equal(activeAttempt.status, 401);
  });

  it('Scenario 9: Enforces monotonic max() activity timestamps, safe legacy session handling, 60s cookie throttle, and clean logout', () => {
    const sim = new PhpSessionSimulator();
    const t0 = 1_700_000_000;
    const sid = sim.login('admin', 'admin', t0);

    // Active request at t0 + 120 updates last_activity_at to t0 + 120
    sim.request('/api/entities/owners/list.php', { now: t0 + 120 });
    assert.equal(sim.sessionFiles.get(sid).data.last_activity_at, t0 + 120);

    // Out-of-order concurrent request with slightly earlier timestamp (t0 + 115) must NOT move timestamp backwards
    sim.request('/api/entities/owners/list.php', { now: t0 + 115 });
    assert.equal(
      sim.sessionFiles.get(sid).data.last_activity_at,
      t0 + 120,
      'last_activity_at must be monotonic via max()'
    );

    // Legacy session without last_activity_at: passive request must NOT stamp last_activity_at
    delete sim.sessionFiles.get(sid).data.last_activity_at;
    sim.request('/api/auth/session.php', { now: t0 + 500, requireAuth: false });
    assert.equal(
      sim.sessionFiles.get(sid).data.last_activity_at,
      undefined,
      'Passive request must not initialize last_activity_at on legacy session'
    );

    // First active request on legacy session initializes last_activity_at
    sim.request('/api/entities/offices/list.php', { now: t0 + 600 });
    assert.equal(sim.sessionFiles.get(sid).data.last_activity_at, t0 + 600);

    // Logout destroys session and expires cookie
    const logoutRes = sim.logout(t0 + 700);
    assert.equal(logoutRes.status, 200);
    assert.equal(sim.sessionFiles.has(sid), false);
  });
});
