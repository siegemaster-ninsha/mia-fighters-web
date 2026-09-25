/* Mia Fighters auth bridge (GDD 12.9 / WP12). Loaded by the web export's <head> (export_presets.cfg head_include
 * -> <script src="auth_bridge.js">; deploy_web.sh copies this file next to index.html), so it runs BEFORE the engine
 * and a token that arrives while Godot is still loading is not lost.
 *
 * Handshake (the board embeds the game in an iframe, or opens it with window.open):
 *   game  -> board   {type:"mia:hello", v:1}                      targetOrigin = each allowed board origin
 *   board -> game    {type:"mia:token", v:1, token, exp}          exp = unix seconds
 *   game  -> board   {type:"mia:status", v:1, status}             the "N fights ready" badge (no token inside)
 * A message is accepted only when event.origin is an allowed board origin AND event.source is this window's parent or
 * opener. Production allows exactly https://fcc.tryworks.dev. Only when the game itself is served from
 * localhost/127.0.0.1 (dev + tests) are http://localhost:3000 / http://127.0.0.1:3000 (the board's `npm run dev`) and
 * a `?board=http://localhost:<port>` override also allowed.
 *
 * Storage: localStorage "miaFighters.token" = {"token", "exp", "got", "via"}. The token leaves this page only as the
 * Authorization header on API calls made by feed.gd (and the pairing exchange below goes to the API only).
 *
 * GDScript side: scripts/auth_bridge.gd (AuthBridge.*) calls window.MiaAuth:
 *   token() -> "" | token        state() -> "ok" | "refresh" | "expired" | "none"
 *   exp() -> unix s (0 = none)   hello()   canHandshake()   status(json)   reject(token)   clear()
 *   openBoard()   pair(apiBase, code)   pairState() -> "idle" | "busy" | "ok" | "bad" | "error"
 */
(function () {
  'use strict';
  var BOARD_ORIGIN = 'https://fcc.tryworks.dev';
  var BOARD_PLAY_URL = BOARD_ORIGIN + '/?page=mia-fighters';
  var TOKEN_KEY = 'miaFighters.token';
  var REFRESH_MAX = 3 * 86400;      // re-handshake within 3 days of expiry (30-day game tokens)...
  var REFRESH_FRAC = 0.25;          // ...or in the last quarter of a short-lived token's life (1 h board login)
  var HELLO_EVERY_MS = 10000;       // throttle for automatic re-hellos
  var TOKEN_RE = /^[A-Za-z0-9._~+\/=-]{16,8192}$/;

  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  var allowed = [BOARD_ORIGIN];
  if (isLocal) {
    allowed.push('http://localhost:3000', 'http://127.0.0.1:3000');
    var q = null;
    try { q = new URLSearchParams(location.search).get('board'); } catch (e) { q = null; }
    if (q && /^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(q) && allowed.indexOf(q) < 0) allowed.push(q);
  }

  var mem = null;          // copy of the stored token (localStorage may be blocked)
  var lastHello = 0;
  var pairStatus = 'idle';

  function now() { return Date.now() / 1000; }

  function hosts() {
    var w = [];
    try { if (window.parent && window.parent !== window) w.push(window.parent); } catch (e) { /* cross-origin ok */ }
    try { if (window.opener && !window.opener.closed) w.push(window.opener); } catch (e) { /* ignore */ }
    return w;
  }

  function read() {
    if (mem) return mem;
    try {
      var t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
      if (t && typeof t.token === 'string' && typeof t.exp === 'number') mem = t;
    } catch (e) { /* ignore */ }
    return mem;
  }

  function store(token, exp, via) {
    mem = { token: token, exp: exp, got: now(), via: via };
    try { localStorage.setItem(TOKEN_KEY, JSON.stringify(mem)); } catch (e) { /* private mode: memory only */ }
  }

  function clear() {
    mem = null;
    try { localStorage.removeItem(TOKEN_KEY); } catch (e) { /* ignore */ }
  }

  function state() {
    var t = read();
    if (!t) return 'none';
    var left = t.exp - now();
    if (left <= 30) return 'expired';
    var life = Math.max(1, t.exp - (t.got || t.exp - 30 * 86400));
    return left < Math.min(REFRESH_MAX, life * REFRESH_FRAC) ? 'refresh' : 'ok';
  }

  function hello() {
    lastHello = Date.now();
    var msg = { type: 'mia:hello', v: 1 };
    hosts().forEach(function (w) {
      allowed.forEach(function (o) {
        try { w.postMessage(msg, o); } catch (e) { /* origin mismatch is dropped by the browser */ }
      });
    });
  }

  function maybeHello() {
    if (hosts().length && Date.now() - lastHello >= HELLO_EVERY_MS) hello();
  }

  function valid(token, exp) {
    return typeof token === 'string' && TOKEN_RE.test(token) && typeof exp === 'number' && isFinite(exp);
  }

  window.addEventListener('message', function (ev) {
    if (allowed.indexOf(ev.origin) < 0) return;               // strict origin check
    if (hosts().indexOf(ev.source) < 0) return;               // only our embedder / opener
    var d = ev.data;
    if (!d || typeof d !== 'object' || d.type !== 'mia:token') return;
    if (!valid(d.token, d.exp) || d.exp <= now() + 30) return;  // expired on arrival: keep the sign-in screen
    store(d.token, d.exp, ev.origin);
  });

  function status(json) {
    if (typeof json !== 'string' || json.length > 20000) return;
    var parsed;
    try { parsed = JSON.parse(json); } catch (e) { return; }
    var msg = { type: 'mia:status', v: 1, status: parsed };
    hosts().forEach(function (w) {
      allowed.forEach(function (o) {
        try { w.postMessage(msg, o); } catch (e) { /* ignore */ }
      });
    });
  }

  function pair(apiBase, code) {
    code = String(code || '');
    if (!/^\d{6}$/.test(code) || pairStatus === 'busy') { if (pairStatus !== 'busy') pairStatus = 'bad'; return; }
    pairStatus = 'busy';
    fetch(String(apiBase) + '/mia-fighters/session/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: code }),
      credentials: 'omit'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (b) { return { ok: r.ok, code: r.status, b: b }; });
    }).then(function (res) {
      if (res.ok && valid(res.b.token, res.b.exp) && res.b.exp > now() + 30) {
        store(res.b.token, res.b.exp, 'pair');
        pairStatus = 'ok';
      } else {
        pairStatus = res.code >= 500 ? 'error' : 'bad';
      }
    }).catch(function () { pairStatus = 'error'; });
  }

  window.MiaAuth = {
    token: function () {
      var s = state();
      if (s === 'refresh' || s === 'expired' || s === 'none') maybeHello();
      return s === 'ok' || s === 'refresh' ? read().token : '';
    },
    exp: function () { var t = read(); return t ? t.exp : 0; },
    state: state,
    hello: hello,
    canHandshake: function () { return hosts().length > 0; },
    status: status,
    reject: function (token) { var t = read(); if (t && t.token === token) { clear(); maybeHello(); } },
    clear: clear,
    openBoard: function () { window.open(BOARD_PLAY_URL, '_blank', 'noopener'); },
    boardUrl: function () { return BOARD_PLAY_URL; },
    pair: pair,
    pairState: function () { var s = pairStatus; if (s !== 'busy') pairStatus = 'idle'; return s; },
    allowedOrigins: function () { return allowed.slice(); }
  };

  hello();   // as early as possible: the board answers while the engine downloads
})();
