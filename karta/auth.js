/**
 * auth.js — Unified Authentication Module
 * ─────────────────────────────────────────────────────────────────────────────
 * Phase 4.9: PHP Session is the SOLE authentication authority.
 *
 * Login:  POST /api/auth/login.php → PHP session + KARTA_SESSION cookie
 * Check:  GET  /api/auth/session.php → validates PHP session
 * Logout: POST /api/auth/logout.php → destroys PHP session
 *
 * NO IndexedDB authentication.
 * NO localStorage for identity/role (UI navigation state only).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { AuthApiService } from './services/authApiService.js';


// ═══════════════════════════════════════════════════════════════════════════════
// Session State — in-memory cache of PHP session (set once on boot/login)
// ═══════════════════════════════════════════════════════════════════════════════

let _sessionCache = null; // { username, role } or null


// ═══════════════════════════════════════════════════════════════════════════════
// Auth Service
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Login via PHP API.
 * On success: PHP session is created, KARTA_SESSION cookie is set by browser,
 * and session data is cached in memory for sync access.
 */
async function login(username, password) {
  if (typeof username !== 'string' || username.trim() === '') {
    throw new Error('اسم المستخدم مطلوب');
  }
  if (typeof password !== 'string' || password.trim() === '') {
    throw new Error('كلمة المرور مطلوبة');
  }

  const res = await AuthApiService.login(username.trim(), password);

  if (!res.success) {
    throw new Error(res.message || 'فشل تسجيل الدخول');
  }

  // Cache session from PHP response
  _sessionCache = {
    username: res.data.username,
    role:     res.data.role,
  };

  return _sessionCache;
}

/**
 * Check PHP session and populate in-memory cache.
 * Called ONCE during app boot. Returns session or null.
 */
async function checkSession() {
  try {
    const session = await AuthApiService.checkSession();
    if (session.loggedIn) {
      _sessionCache = {
        username: session.username,
        role:     session.role,
      };
      return _sessionCache;
    }
  } catch (e) {
    console.warn('[Auth] Session check failed:', e.message);
  }
  _sessionCache = null;
  return null;
}

/**
 * Get cached session (sync). Returns { username, role } or null.
 * Must call checkSession() or login() before using this.
 */
function getSession() {
  return _sessionCache;
}

/**
 * Require a valid session or throw.
 */
function requireSession() {
  if (!_sessionCache) {
    throw new Error('Session required');
  }
  return _sessionCache;
}

/**
 * Logout — destroy PHP session, clear cache, clear UI state.
 */
async function logout() {
  try {
    await AuthApiService.logout();
  } catch (e) {
    console.warn('[Auth] Server logout failed:', e.message);
  }
  _sessionCache = null;
  // Clear UI-only navigation state (NOT auth data)
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.clear();
  }
}

const AuthService = Object.freeze({
  login,
  logout,
  checkSession,
  getSession,
  requireSession,
});


// ═══════════════════════════════════════════════════════════════════════════════
// AuthModule — public API consumed by all UI modules
// ═══════════════════════════════════════════════════════════════════════════════

const AuthModule = Object.freeze({
  login:          (u, p) => AuthService.login(u, p),
  logout:         ()     => AuthService.logout(),
  checkSession:   ()     => AuthService.checkSession(),
  getSession:     ()     => AuthService.getSession(),
  requireSession: ()     => AuthService.requireSession(),
});


// ═══════════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════════

function isAdmin() {
  return _sessionCache?.role === 'admin';
}


// ═══════════════════════════════════════════════════════════════════════════════
// Login Page — UI (only runs on login.html)
// ═══════════════════════════════════════════════════════════════════════════════

function _byId(id) {
  return document.getElementById(id);
}

function _setError(message) {
  const errorEl = _byId('error');
  if (!errorEl) return;
  errorEl.textContent = message || '';
}

async function _handleSubmit(event) {
  event.preventDefault();
  _setError('');

  const username = _byId('username')?.value;
  const password = _byId('password')?.value;

  try {
    await AuthModule.login(username, password);
    window.location.href = 'index.html';
  } catch (err) {
    _setError(err?.message || 'خطأ غير متوقع');
  }
}

let _redirecting = false;

async function bootLoginPage() {
  if (typeof document === 'undefined') return;
  const form = _byId('loginForm');
  if (!form) return;

  // Attach submit handler IMMEDIATELY — never block the user
  form.addEventListener('submit', function (event) {
    if (_redirecting) { event.preventDefault(); return; }
    _handleSubmit(event);
  });

  // Password visibility toggle
  const toggleBtn = _byId('togglePassword');
  const passInput = _byId('password');
  if (toggleBtn && passInput) {
    toggleBtn.addEventListener('mousedown', function (e) {
      e.preventDefault(); // prevent focus steal from password input
      const pos = passInput.selectionStart;
      const end = passInput.selectionEnd;
      const isHidden = passInput.type === 'password';
      passInput.type = isHidden ? 'text' : 'password';
      toggleBtn.textContent = isHidden ? '🙈' : '👁';
      passInput.setSelectionRange(pos, end);
    });
  }

  // Check session in background — redirect if already logged in
  const existing = await AuthModule.checkSession();
  if (existing) {
    _redirecting = true;
    const submitBtn = _byId('loginSubmitBtn');
    if (submitBtn) submitBtn.disabled = true;
    window.location.href = 'index.html';
  }
}

bootLoginPage();


// ═══════════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════════

export { AuthService, AuthModule, isAdmin };
