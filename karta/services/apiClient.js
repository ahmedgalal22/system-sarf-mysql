/**
 * apiClient.js — HTTP client for PHP API (Hardened)
 * ─────────────────────────────────────────────────────────────────────────────
 * RULES:
 *   - Retry ONLY on safe GET requests (never on writes)
 *   - Timeout normalized
 *   - All responses normalized to standard shape
 *   - Error types classified: auth | validation | conflict | network | server
 *   - Session credentials always included
 *   - No raw fetch errors exposed to UI
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { API_CONFIG } from './apiConfig.js';

/**
 * @typedef {Object} ApiResponse
 * @property {boolean} success
 * @property {string} type — 'ok' | 'auth' | 'validation' | 'conflict' | 'network' | 'server'
 * @property {string} message
 * @property {any} data
 * @property {number} status — HTTP status code (0 for network failures)
 * @property {string[]} errors
 * @property {object|null} latest — latest server version (for conflict responses)
 */

function _classifyError(status) {
  if (status === 401) return 'auth';
  if (status === 403) return 'auth';
  if (status === 400) return 'validation';
  if (status === 409) return 'conflict';
  if (status === 404) return 'validation';
  if (status >= 500) return 'server';
  if (status === 0)  return 'network';
  return 'server';
}

function _fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timeoutId));
}

async function _normalizeResponse(response) {
  const status = response.status;
  let body;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : {};
  } catch {
    return {
      success: false,
      type: _classifyError(status),
      message: `Server returned invalid JSON (HTTP ${status})`,
      data: null,
      status,
      errors: [],
      latest: null,
    };
  }

  return {
    success: body.success === true,
    type: body.success ? 'ok' : _classifyError(status),
    message: body.message || (body.success ? 'OK' : 'Error'),
    data: body.data ?? null,
    meta: body.meta ?? null,
    status,
    errors: Array.isArray(body.errors) ? body.errors : [],
    latest: body.latest ?? null,
  };
}

async function request(method, endpoint, body = null, options = {}) {
  const url = `${API_CONFIG.BASE_URL}${endpoint}`;
  const timeout = options.timeout || API_CONFIG.TIMEOUT;
  const isGet = method.toUpperCase() === 'GET';
  // Retry ONLY on safe GET requests
  const maxRetries = isGet ? (options.retries ?? API_CONFIG.RETRY_COUNT) : 0;

  const fetchOptions = {
    method: method.toUpperCase(),
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
  };

  if (body !== null && !isGet) {
    fetchOptions.body = JSON.stringify(body);
  }

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await _fetchWithTimeout(url, fetchOptions, timeout);
      return await _normalizeResponse(response);
    } catch (err) {
      lastError = err;
      if (err.name === 'AbortError') {
        return {
          success: false, type: 'network',
          message: 'انتهت مهلة الاتصال بالخادم', data: null,
          status: 0, errors: ['TIMEOUT'], latest: null,
        };
      }
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, API_CONFIG.RETRY_DELAY));
      }
    }
  }

  return {
    success: false, type: 'network',
    message: 'تعذر الاتصال بالخادم — تحقق من الشبكة', data: null,
    status: 0, errors: [lastError?.message || 'NETWORK_ERROR'], latest: null,
  };
}

const ApiClient = Object.freeze({
  get:    (endpoint, opts) => request('GET', endpoint, null, opts),
  post:   (endpoint, body, opts) => request('POST', endpoint, body, opts),
  put:    (endpoint, body, opts) => request('PUT', endpoint, body, opts),
  delete: (endpoint, body, opts) => request('DELETE', endpoint, body, opts),
});

export { ApiClient };
export default ApiClient;
