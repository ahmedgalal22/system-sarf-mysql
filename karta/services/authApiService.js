/**
 * authApiService.js — Server-side authentication service
 * ─────────────────────────────────────────────────────────────────────────────
 * Replaces localStorage-based auth with PHP session-based auth.
 * Used when DATA_MODE is SERVER.
 *
 * RULE: All role/permission decisions come from the server session.
 *       Frontend NEVER stores credentials or role in localStorage.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ApiClient } from './apiClient.js';

/**
 * Login via server API.
 * @returns {{ success, data: { username, role, ... }, message }}
 */
async function login(username, password) {
  return ApiClient.post('/auth/login.php', { username, password });
}

/**
 * Logout — destroys server session.
 */
async function logout() {
  return ApiClient.post('/auth/logout.php');
}

/**
 * Get current authenticated user profile from server.
 * Returns null if not authenticated.
 */
async function getCurrentUser() {
  const res = await ApiClient.get('/auth/me.php');
  if (res.success && res.data) {
    return {
      username: res.data.username,
      role: res.data.role,
      user_id: res.data.user_id,
    };
  }
  return null;
}

/**
 * Lightweight session check — no DB query on server.
 */
async function checkSession() {
  const res = await ApiClient.get('/auth/session.php');
  if (res.success && res.data?.logged_in) {
    return {
      loggedIn: true,
      username: res.data.username,
      role: res.data.role,
    };
  }
  return { loggedIn: false, username: null, role: null };
}

/**
 * Verify that the server is reachable and healthy.
 */
async function verifyServer() {
  const res = await ApiClient.get('/health/ping.php');
  return res.success && res.data?.mysql === 'connected';
}

const AuthApiService = Object.freeze({
  login,
  logout,
  getCurrentUser,
  checkSession,
  verifyServer,
});

export { AuthApiService };
export default AuthApiService;
