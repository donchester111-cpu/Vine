/* Vine storefront API adapter. Keep API base URLs blank until Render services are configured.
 * Never place Supabase service-role keys, Paystack secret keys, or database passwords here.
 */
(function attachVineAPI(global) {
  'use strict';
  const config = Object.assign({ accountsApiBaseUrl: '', storeApiBaseUrl: '', operationsApiBaseUrl: '' }, global.VINE_CONFIG || {});
  const SESSION_KEY = 'vine_session_v1';
  let session = null;
  try { session = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null'); } catch { session = null; }
  let refreshInFlight = null;

  function baseUrl(value) { return String(value || '').trim().replace(/\/+$/, ''); }
  const accountsBase = baseUrl(config.accountsApiBaseUrl);
  const storeBase = baseUrl(config.storeApiBaseUrl);
  const operationsBase = baseUrl(config.operationsApiBaseUrl);
  const configured = Boolean(accountsBase && storeBase && operationsBase);

  function saveSession(next) {
    session = next || null;
    try {
      if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
      else sessionStorage.removeItem(SESSION_KEY);
    } catch { /* The current tab can still use its in-memory session. */ }
    global.dispatchEvent(new CustomEvent('vine:session-changed', { detail: { signedIn: Boolean(session?.accessToken), email: session?.user?.email || '' } }));
  }

  function getSession() { return session; }
  function isSignedIn() { return Boolean(session?.accessToken); }

  async function rawRequest(base, path, options = {}, useAuth = false) {
    if (!base) throw new Error('This Vine API URL is not configured yet.');
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (useAuth && session?.accessToken) headers.set('Authorization', `Bearer ${session.accessToken}`);
    let response;
    try {
      response = await fetch(`${base}${path}`, { ...options, headers, cache: 'no-store' });
    } catch {
      throw new Error('Vine could not reach the server. Check your connection and try again.');
    }
    let payload = null;
    if (response.status !== 204) {
      try { payload = await response.json(); }
      catch { payload = null; }
    }
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `Request failed (${response.status}).`);
      error.status = response.status;
      error.code = payload?.error?.code || 'REQUEST_FAILED';
      throw error;
    }
    return payload;
  }

  async function refreshSession() {
    if (!session?.refreshToken) { saveSession(null); throw new Error('Your session expired. Please sign in again.'); }
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      const result = await rawRequest(accountsBase, '/api/v1/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: session.refreshToken }) });
      const next = result?.data?.session;
      if (!next?.accessToken) { saveSession(null); throw new Error('Your session expired. Please sign in again.'); }
      saveSession({ ...next, user: result.data.user });
      return session;
    })();
    try { return await refreshInFlight; } finally { refreshInFlight = null; }
  }

  async function request(base, path, options = {}, useAuth = false) {
    try { return await rawRequest(base, path, options, useAuth); }
    catch (error) {
      if (useAuth && error.status === 401 && session?.refreshToken && !path.includes('/auth/refresh')) {
        await refreshSession();
        return rawRequest(base, path, options, true);
      }
      throw error;
    }
  }

  async function storeSessionResult(result) {
    const user = result?.data?.user || null;
    const next = result?.data?.session;
    if (next?.accessToken && next?.refreshToken) saveSession({ ...next, user });
    return result.data;
  }

  const api = {
    config, configured,
    getSession, isSignedIn,
    async signup({ fullName, phone, email, password }) {
      const result = await request(accountsBase, '/api/v1/auth/signup', { method: 'POST', body: JSON.stringify({ fullName, phone: phone || undefined, email, password }) });
      return storeSessionResult(result);
    },
    async login({ email, password }) {
      const result = await request(accountsBase, '/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) });
      return storeSessionResult(result);
    },
    async logout() {
      try { if (session?.accessToken) await request(accountsBase, '/api/v1/auth/logout', { method: 'POST' }, true); }
      finally { saveSession(null); }
    },
    async profile() { return (await request(accountsBase, '/api/v1/me', {}, true)).data; },
    async updateProfile(input) { return (await request(accountsBase, '/api/v1/me/profile', { method: 'PATCH', body: JSON.stringify(input) }, true)).data; },
    async addresses() { return (await request(accountsBase, '/api/v1/me/addresses', {}, true)).data; },
    async createAddress(input) { return (await request(accountsBase, '/api/v1/me/addresses', { method: 'POST', body: JSON.stringify(input) }, true)).data; },
    async products({ search = '', category = 'all', sort = 'featured', page = 1, limit = 48 } = {}) {
      const params = new URLSearchParams({ search, category, sort, page: String(page), limit: String(limit) });
      return (await request(storeBase, `/api/v1/products?${params.toString()}`)).data;
    },
    async categories() { return (await request(storeBase, '/api/v1/categories')).data; },
    async createCheckout(items, addressId, paymentMethod, idempotencyKey) {
      const result = await request(storeBase, '/api/v1/checkout', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ items, addressId, paymentMethod }) }, true);
      return result.data;
    },
    async initializePayment(orderId) {
      return (await request(operationsBase, '/api/v1/payments/initialize', { method: 'POST', body: JSON.stringify({ orderId }) }, true)).data;
    },
    async paymentStatus(reference) {
      const params = new URLSearchParams({ reference });
      return (await request(operationsBase, `/api/v1/payments/status?${params.toString()}`, {}, true)).data;
    },
    async myOrders() { return (await request(storeBase, '/api/v1/me/orders', {}, true)).data; }
  };
  global.VineAPI = api;
})(window);
