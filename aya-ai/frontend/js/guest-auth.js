/* ==========================================================================
 * TEMPORARY GUEST MODE: guest session provider (local development only)
 *
 * Provides window.GEMAuth.getSession() for the booking page when the real
 * Login/Register (built by another team member) is not connected yet.
 *
 * It returns the shape the booking page expects:
 *     { user: { id }, accessToken, expiresAt }
 * and the page sends that token to our Node backend as a Bearer token. The
 * backend still verifies it with Supabase Auth on every request.
 *
 * Isolation rules:
 *  - Does nothing unless GEM_GUEST.enabled is true (see guest-config.js).
 *  - Does nothing outside localhost / 127.0.0.1.
 *  - Never replaces an existing window.GEMAuth: the real authentication wins.
 *  - Uses no library: plain fetch to the Supabase Auth REST API.
 *  - Never touches the other team member's auth files or visit.js.
 * ========================================================================== */
(function () {
  'use strict';

  var cfg = window.GEM_GUEST;
  if (!cfg || cfg.enabled !== true) return;

  var host = window.location.hostname;
  if (host !== 'localhost' && host !== '127.0.0.1') {
    console.warn('[GEM guest mode] Refused: guest mode only runs on localhost.');
    return;
  }
  if (window.GEMAuth) {
    console.info('[GEM guest mode] Real authentication found (window.GEMAuth). Guest mode stays off.');
    return;
  }

  var STORAGE_KEY = 'gem-guest-session-v1';
  var SAFETY_MARGIN_S = 60;          // renew a minute before the token expires
  var MODE = cfg.mode === 'memory' ? 'memory' : 'supabase';
  var pending = null;                // one sign-in at a time

  var nowS = function () { return Math.floor(Date.now() / 1000); };

  /* ---------- storage ---------- */
  function load() {
    try {
      var s = JSON.parse(window.localStorage.getItem(STORAGE_KEY));
      if (s && s.mode === MODE && typeof s.accessToken === 'string' && s.user && typeof s.user.id === 'string') return s;
    } catch (_) { /* unreadable: ignore */ }
    return null;
  }
  function save(s) { try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (_) { /* private mode */ } }
  function clear() { try { window.localStorage.removeItem(STORAGE_KEY); } catch (_) { /* ignore */ } }
  var fresh = function (s) { return s && Number.isFinite(s.expiresAt) && s.expiresAt - SAFETY_MARGIN_S > nowS(); };
  var view = function (s) { return { user: { id: s.user.id }, accessToken: s.accessToken, expiresAt: s.expiresAt }; };

  /* ---------- configuration check ---------- */
  function jwtRole(key) {
    try {
      var part = key.split('.')[1];
      return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))).role;
    } catch (_) { return null; }
  }
  function configProblem() {
    var url = String(cfg.supabaseUrl || '').replace(/\/+$/, '');
    var key = String(cfg.supabasePublishableKey || '');
    if (!url || !key) return 'Fill supabaseUrl and supabasePublishableKey in js/guest-config.js (or use mode: "memory" with the in-memory test backend).';
    if (!/^https:\/\//.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) return 'supabaseUrl must start with https:// (or be a local http://localhost Supabase).';
    if (/^sb_secret_/.test(key) || jwtRole(key) === 'service_role') return 'That is a SECRET key. Only the publishable (anon) key may be used in the browser. Remove it from guest-config.js now.';
    return null;
  }

  /* ---------- Supabase Anonymous Authentication (REST) ---------- */
  function authFetch(path, body) {
    var url = String(cfg.supabaseUrl).replace(/\/+$/, '') + path;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: String(cfg.supabasePublishableKey) },
      body: JSON.stringify(body)
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (json) { return { ok: res.ok, status: res.status, json: json }; });
    });
  }
  function fromAuthResponse(json) {
    if (!json || typeof json.access_token !== 'string' || !json.user || typeof json.user.id !== 'string') return null;
    var expiresAt = Number.isFinite(json.expires_at) ? json.expires_at : nowS() + (Number(json.expires_in) || 3600);
    return { mode: 'supabase', user: { id: json.user.id }, accessToken: json.access_token, refreshToken: json.refresh_token || null, expiresAt: expiresAt };
  }
  function signInAnonymously() {
    // Same request that supabase-js signInAnonymously() sends.
    return authFetch('/auth/v1/signup', { data: {}, gotrue_meta_security: {} }).then(function (r) {
      if (!r.ok) {
        var code = r.json && (r.json.error_code || r.json.code || r.json.msg);
        if (r.status === 422 || /anonymous/i.test(String(code))) {
          console.error('[GEM guest mode] Supabase refused the guest sign-in (' + code + '). Turn ON "Allow anonymous sign-ins" in Supabase: Authentication > Sign In / Providers. Until then use mode: "memory" with the in-memory test backend.');
        } else {
          console.error('[GEM guest mode] Guest sign-in failed (HTTP ' + r.status + ').');
        }
        return null;
      }
      return fromAuthResponse(r.json);
    });
  }
  function refresh(session) {
    if (!session.refreshToken) return Promise.resolve(null);
    return authFetch('/auth/v1/token?grant_type=refresh_token', { refresh_token: session.refreshToken })
      .then(function (r) {
        if (r.ok) return fromAuthResponse(r.json);
        // A temporary Supabase problem (5xx / rate limit) must not make us forget this guest: keep the stored session and retry later.
        if (r.status >= 500 || r.status === 429) throw new Error('Supabase Auth is temporarily unavailable (HTTP ' + r.status + ').');
        return null;   // the refresh token was refused (expired / used): a new guest is created
      });
  }

  /* ---------- in-memory dev mode (NO Supabase, NO real security) ---------- */
  function memorySession() {
    var id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : '00000000-0000-4000-8000-' + String(Date.now()).padStart(12, '0');
    // Only the in-memory test backend (test/dev-memory-server.js) accepts this token.
    return { mode: 'memory', user: { id: id }, accessToken: 'dev-guest-' + id, refreshToken: null, expiresAt: nowS() + 12 * 3600 };
  }

  /* ---------- the GEMAuth hook the booking page reads ---------- */
  function obtain() {
    var stored = load();
    if (fresh(stored)) return Promise.resolve(stored);
    if (MODE === 'memory') { var m = memorySession(); save(m); return Promise.resolve(m); }

    var problem = configProblem();
    if (problem) { console.error('[GEM guest mode] ' + problem); return Promise.resolve(null); }

    // A network or 5xx failure here rejects and is handled below: the stored guest is kept, no new guest is created.
    var attempt = stored ? refresh(stored) : Promise.resolve(null);
    return attempt
      .then(function (renewed) { return renewed || signInAnonymously(); })
      .then(function (s) { if (s) save(s); else clear(); return s; })
      .catch(function (error) {
        console.error('[GEM guest mode] Could not reach Supabase Auth.', error && error.message);
        return null;
      });
  }

  window.GEMAuth = {
    isGuest: true,
    getSession: function () {
      if (!pending) pending = obtain().then(function (s) { pending = null; return s ? view(s) : null; }, function () { pending = null; return null; });
      return pending;
    },
    /** Forget the guest (a new guest identity is created on the next request). */
    signOutGuest: function () { clear(); }
  };
  console.info('[GEM guest mode] ACTIVE (' + MODE + '). Temporary: local testing only.');
})();