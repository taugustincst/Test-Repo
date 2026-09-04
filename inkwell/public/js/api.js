/* Tiny fetch wrapper for the Inkwell API. */
(function () {
  'use strict';

  const isNative = () => !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  const TOKEN_KEY = 'inkwell_token';
  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
  const setToken = (t) => { try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } };

  async function request(method, url, body, opts = {}) {
    const init = { method, headers: {}, credentials: 'include' };
    // The native shell keeps the session as a bearer token because webview cookies are unreliable.
    if (isNative()) init.headers['X-Inkwell-Client'] = 'native';
    const token = getToken();
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (body instanceof FormData) {
      init.body = body;
    } else if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || (res.status === 503 && data && data.offline ? data.error : `Request failed (${res.status})`));
      err.status = res.status;
      err.data = data;
      if (res.status === 401 && opts.onUnauthorized) opts.onUnauthorized();
      throw err;
    }
    if (data && data.token) setToken(data.token);
    return data;
  }

  function qs(params) {
    const entries = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (!entries.length) return '';
    return `?${new URLSearchParams(entries).toString()}`;
  }

  window.api = {
    get: (url, params) => request('GET', url + qs(params)),
    post: (url, body) => request('POST', url, body),
    put: (url, body) => request('PUT', url, body),
    del: (url, body) => request('DELETE', url, body),
    isNative,
    clearToken: () => setToken(null),
  };
})();
