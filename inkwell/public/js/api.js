/* Tiny fetch wrapper for the Inkwell API. */
(function () {
  'use strict';

  async function request(method, url, body, opts = {}) {
    const init = { method, headers: {}, credentials: 'same-origin' };
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
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      if (res.status === 401 && opts.onUnauthorized) opts.onUnauthorized();
      throw err;
    }
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
    del: (url) => request('DELETE', url),
  };
})();
