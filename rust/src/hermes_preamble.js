// Host environment for the single-process Hermes runtime. Wires JS globals to the Rust
// host functions installed by rust/src/hermes.rs, and is evaluated before the app bundle.
// Hermes provides ES built-ins (JSON, Promise + microtasks, Date, Map, etc.); this layer
// adds the browser/RN-ish globals the app expects: console, timers, rAF, performance.
(function () {
  var g = globalThis;

  // some libraries reference `global` / `process.env` / `self`.
  g.global = g;
  g.self = g;
  if (!g.process) g.process = { env: {} };
  if (!g.process.env) g.process.env = {};
  if (typeof g.process.exit !== 'function') {
    g.process.exit = function (code) { g.__rngpui_exit(String(code == null ? 0 : code | 0)); };
  }
  if (typeof g.process.kill !== 'function') {
    g.process.kill = function (pid, signal) {
      if (+pid !== g.process.pid) throw new Error('rngpui process.kill only supports the current process');
      if (signal === 'SIGUSR2') {
        g.__rngpui_reloadApp('');
        return true;
      }
      throw new Error('rngpui process.kill only supports SIGUSR2 reload');
    };
  }

  // console → host stderr sink.
  function fmt(args) {
    var parts = [];
    for (var i = 0; i < args.length; i++) {
      var a = args[i];
      if (typeof a === 'string') {
        parts.push(a);
      } else if (a instanceof Error) {
        parts.push(a.stack || a.message || String(a));
      } else {
        try { parts.push(JSON.stringify(a)); } catch (e) { parts.push(String(a)); }
      }
    }
    return parts.join(' ');
  }
  function mk(level) {
    return function () { g.__rngpui_log(level + ': ' + fmt(arguments)); };
  }
  g.console = { log: mk('log'), info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug'), trace: mk('trace') };

  // performance.now() → monotonic ms from the host clock.
  g.performance = g.performance || { now: function () { return g.__rngpui_now(''); } };

  // timers — JS owns the id→callback map; the Rust event loop schedules + fires them.
  var timers = Object.create(null);
  var nextTimerId = 1;
  function schedule(cb, ms, repeat, extraArgs) {
    if (typeof cb !== 'function') return 0;
    var id = nextTimerId++;
    timers[id] = { cb: cb, args: extraArgs || [], repeat: !!repeat };
    g.__rngpui_setTimer(JSON.stringify([id, ms > 0 ? ms : 0, repeat ? 1 : 0]));
    return id;
  }
  g.setTimeout = function (cb, ms) { return schedule(cb, ms | 0, false, Array.prototype.slice.call(arguments, 2)); };
  g.setInterval = function (cb, ms) { return schedule(cb, ms | 0, true, Array.prototype.slice.call(arguments, 2)); };
  g.setImmediate = function (cb) { return schedule(cb, 0, false, Array.prototype.slice.call(arguments, 1)); };
  g.clearTimeout = function (id) {
    if (id && timers[id]) { delete timers[id]; g.__rngpui_clearTimer(JSON.stringify([id])); }
  };
  g.clearInterval = g.clearTimeout;
  g.clearImmediate = g.clearTimeout;

  // Rust calls this (with the id as a string) when a timer's deadline passes.
  g.__rngpui_fireTimer = function (idStr) {
    var id = +idStr;
    var t = timers[id];
    if (!t) return;
    if (!t.repeat) delete timers[id];
    try {
      t.cb.apply(null, t.args);
    } catch (e) {
      g.__rngpui_log('error: timer threw ' + ((e && e.stack) || e));
    }
  };

  // requestAnimationFrame rides the host's real vsync (rust frame_clock.rs /
  // CVDisplayLink): arming __rngpui_requestFrame gets ONE __rngpui_fireFrame back
  // on the next display refresh. At most one fire is in flight — the host only
  // fires while armed, and we only re-arm after running callbacks. Both runtimes
  // (React + reanimated worklet/UI) get this same implementation here, before any
  // bundle evaluates.
  var __rafDebug = g.process && g.process.env && g.process.env.RNGPUI_RAF_DEBUG;
  var __rafSeq = 0;
  var __rafCallbacks = new Map();
  var __rafNextId = 1;
  g.requestAnimationFrame = function (cb) {
    var id = __rafNextId++;
    __rafCallbacks.set(id, cb);
    if (__rafDebug) { g.__rngpui_log('debug: rAF schedule #' + (++__rafSeq)); }
    if (__rafCallbacks.size === 1) g.__rngpui_requestFrame('');
    return id;
  };
  g.cancelAnimationFrame = function (id) { __rafCallbacks.delete(id); };
  g.__rngpui_fireFrame = function () {
    if (__rafCallbacks.size === 0) return;
    // snapshot ids: callbacks registered DURING this frame run next frame, and a
    // callback cancelling a same-frame sibling must win (browser semantics).
    var ids = Array.from(__rafCallbacks.keys());
    var ts = g.__rngpui_now('');
    for (var i = 0; i < ids.length; i++) {
      var cb = __rafCallbacks.get(ids[i]);
      if (!cb) continue;
      __rafCallbacks.delete(ids[i]);
      try { cb(ts); } catch (e) { g.__rngpui_log('error: rAF callback threw ' + ((e && e.stack) || e)); }
    }
    // registrations made while firing may not have crossed size 0→1; re-arm.
    if (__rafCallbacks.size > 0) g.__rngpui_requestFrame('');
  };

  // queueMicrotask via Promise (Hermes drains microtasks after each Rust loop tick).
  if (typeof g.queueMicrotask !== 'function') {
    g.queueMicrotask = function (cb) { Promise.resolve().then(cb); };
  }

  function abortError() {
    var e = new Error('The operation was aborted');
    e.name = 'AbortError';
    return e;
  }
  if (typeof g.AbortController !== 'function') {
    function AbortSignal() {
      this.aborted = false;
      this.reason = undefined;
      this._listeners = [];
    }
    AbortSignal.prototype.addEventListener = function (type, cb, options) {
      if (type !== 'abort' || typeof cb !== 'function') return;
      this._listeners.push({ cb: cb, once: !!(options && options.once) });
    };
    AbortSignal.prototype.removeEventListener = function (type, cb) {
      if (type !== 'abort') return;
      this._listeners = this._listeners.filter(function (item) { return item.cb !== cb; });
    };
    AbortSignal.prototype._abort = function (reason) {
      if (this.aborted) return;
      this.aborted = true;
      this.reason = reason || abortError();
      var listeners = this._listeners.slice();
      this._listeners = listeners.filter(function (item) { return !item.once; });
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i].cb.call(this, { type: 'abort', target: this }); } catch (e) { g.__rngpui_log('error: abort listener threw ' + ((e && e.stack) || e)); }
      }
    };
    function AbortController() {
      this.signal = new AbortSignal();
    }
    AbortController.prototype.abort = function (reason) {
      this.signal._abort(reason);
    };
    g.AbortSignal = AbortSignal;
    g.AbortController = AbortController;
  }

  // fetch — bridged to the Rust host (ureq) on a worker thread; resolves with a minimal
  // Response (ok/status/text()/json()). Enough for the agentbus REST client.
  var fetchSeq = 1;
  var fetchPending = Object.create(null);
  g.fetch = function (url, init) {
    init = init || {};
    var signal = init.signal;
    if (signal && signal.aborted) return Promise.reject(signal.reason || abortError());
    var id = fetchSeq++;
    var headers = {};
    if (init.headers) {
      if (typeof init.headers.forEach === 'function') init.headers.forEach(function (v, k) { headers[k] = v; });
      else for (var k in init.headers) headers[k] = init.headers[k];
    }
    return new Promise(function (resolve, reject) {
      var onAbort = function () {
        var p = fetchPending[id];
        if (!p) return;
        delete fetchPending[id];
        reject((signal && signal.reason) || abortError());
      };
      fetchPending[id] = { resolve: resolve, reject: reject, signal: signal, onAbort: onAbort };
      if (signal && typeof signal.addEventListener === 'function') signal.addEventListener('abort', onAbort, { once: true });
      g.__rngpui_fetch(JSON.stringify({
        id: id,
        url: String(url),
        method: init.method || 'GET',
        headers: headers,
        body: init.body != null ? String(init.body) : null,
      }));
    });
  };
  g.__rngpui_fetchDone = function (jsonStr) {
    var r = JSON.parse(jsonStr);
    var p = fetchPending[r.id];
    if (!p) return;
    delete fetchPending[r.id];
    if (p.signal && typeof p.signal.removeEventListener === 'function') p.signal.removeEventListener('abort', p.onAbort);
    if (r.error != null) { p.reject(new Error(r.error)); return; }
    var body = r.body || '';
    p.resolve({
      ok: r.ok, status: r.status, statusText: '', url: '', redirected: false,
      text: function () { return Promise.resolve(body); },
      json: function () { try { return Promise.resolve(JSON.parse(body)); } catch (e) { return Promise.reject(e); } },
      headers: { get: function () { return null; }, has: function () { return false; } },
    });
  };

  // WebSocket — one Rust worker per connection; events arrive via __rngpui_wsEvent.
  var wsSeq = 1;
  var wsConns = Object.create(null);
  function WS(url) {
    this._id = wsSeq++;
    this.url = String(url);
    this.readyState = 0; // CONNECTING
    this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
    this._listeners = { open: [], message: [], close: [], error: [] };
    wsConns[this._id] = this;
    g.__rngpui_wsOpen(JSON.stringify({ id: this._id, url: this.url }));
  }
  WS.CONNECTING = 0; WS.OPEN = 1; WS.CLOSING = 2; WS.CLOSED = 3;
  WS.prototype.addEventListener = function (type, cb) { if (this._listeners[type]) this._listeners[type].push(cb); };
  WS.prototype.removeEventListener = function (type, cb) {
    var l = this._listeners[type]; if (!l) return;
    var i = l.indexOf(cb); if (i >= 0) l.splice(i, 1);
  };
  WS.prototype._emit = function (type, evt) {
    var on = this['on' + type]; if (typeof on === 'function') on.call(this, evt);
    var l = this._listeners[type] || [];
    for (var i = 0; i < l.length; i++) l[i].call(this, evt);
  };
  WS.prototype.send = function (data) {
    if (this.readyState !== 1) return;
    g.__rngpui_wsSend(JSON.stringify([this._id, typeof data === 'string' ? data : String(data)]));
  };
  WS.prototype.close = function () {
    if (this.readyState === 3 || this.readyState === 2) return;
    this.readyState = 2;
    g.__rngpui_wsClose(JSON.stringify([this._id]));
  };
  g.WebSocket = WS;
  g.__rngpui_wsEvent = function (jsonStr) {
    var e = JSON.parse(jsonStr);
    var ws = wsConns[e.id];
    if (!ws) return;
    if (e.type === 'open') { ws.readyState = 1; ws._emit('open', { type: 'open' }); }
    else if (e.type === 'message') { ws._emit('message', { type: 'message', data: e.data }); }
    else if (e.type === 'close') {
      ws.readyState = 3; delete wsConns[e.id];
      ws._emit('close', { type: 'close', code: e.code || 1000, reason: e.reason || '', wasClean: (e.code || 1000) === 1000 });
    }
  };

  // ── web globals Hermes doesn't ship (the app + RN APIs expect them) ─────────
  // Headers (used by the agentbus REST client — `new Headers()` per request).
  function Headers(init) {
    this._m = {};
    if (init) {
      if (init instanceof Headers) { for (var k in init._m) this._m[k] = init._m[k]; }
      else if (Array.isArray(init)) { for (var i = 0; i < init.length; i++) this.set(init[i][0], init[i][1]); }
      else if (typeof init.forEach === 'function') { var s = this; init.forEach(function (v, k) { s.set(k, v); }); }
      else { for (var k2 in init) this.set(k2, init[k2]); }
    }
  }
  Headers.prototype.set = function (k, v) { this._m[String(k).toLowerCase()] = String(v); };
  Headers.prototype.get = function (k) { var v = this._m[String(k).toLowerCase()]; return v == null ? null : v; };
  Headers.prototype.has = function (k) { return Object.prototype.hasOwnProperty.call(this._m, String(k).toLowerCase()); };
  Headers.prototype.append = function (k, v) { var e = this.get(k); this.set(k, e ? e + ', ' + v : v); };
  Headers.prototype['delete'] = function (k) { delete this._m[String(k).toLowerCase()]; };
  Headers.prototype.forEach = function (cb, thisArg) { for (var k in this._m) cb.call(thisArg, this._m[k], k, this); };
  g.Headers = Headers;

  // base64
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  g.btoa = function (input) {
    input = String(input); var out = ''; var i = 0;
    while (i < input.length) {
      var c1 = input.charCodeAt(i++) & 0xff, c2 = input.charCodeAt(i++), c3 = input.charCodeAt(i++);
      var h2 = isNaN(c2), h3 = isNaN(c3); c2 = c2 & 0xff; c3 = c3 & 0xff;
      var e1 = c1 >> 2, e2 = ((c1 & 3) << 4) | (c2 >> 4), e3 = ((c2 & 15) << 2) | (c3 >> 6), e4 = c3 & 63;
      out += B64[e1] + B64[e2] + (h2 ? '=' : B64[e3]) + (h2 || h3 ? '=' : B64[e4]);
    }
    return out;
  };
  g.atob = function (input) {
    var str = String(input).replace(/[=]+$/, ''); var out = ''; var bc = 0, bs = 0, i = 0, ch;
    while ((ch = str.charAt(i++))) {
      var idx = B64.indexOf(ch); if (idx === -1) continue;
      bs = bc % 4 ? bs * 64 + idx : idx;
      if (bc++ % 4) out += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
    }
    return out;
  };

  // UTF-8 TextEncoder/TextDecoder (Hermes has Uint8Array).
  if (typeof g.TextEncoder === 'undefined') {
    g.TextEncoder = function () {};
    g.TextEncoder.prototype.encode = function (str) {
      str = String(str); var b = [];
      for (var i = 0; i < str.length; i++) {
        var c = str.charCodeAt(i);
        if (c < 0x80) b.push(c);
        else if (c < 0x800) b.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else if (c >= 0xd800 && c <= 0xdbff) {
          var c2 = str.charCodeAt(++i), cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
          b.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        } else b.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
      return new Uint8Array(b);
    };
  }
  if (typeof g.TextDecoder === 'undefined') {
    g.TextDecoder = function () {};
    g.TextDecoder.prototype.decode = function (buf) {
      var b = buf instanceof Uint8Array ? buf : new Uint8Array(buf || []); var s = '', i = 0;
      while (i < b.length) {
        var c = b[i++];
        if (c < 0x80) s += String.fromCharCode(c);
        else if (c < 0xe0) s += String.fromCharCode(((c & 0x1f) << 6) | (b[i++] & 0x3f));
        else if (c < 0xf0) s += String.fromCharCode(((c & 0x0f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f));
        else { var cp = ((c & 0x07) << 18) | ((b[i++] & 0x3f) << 12) | ((b[i++] & 0x3f) << 6) | (b[i++] & 0x3f); cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff)); }
      }
      return s;
    };
  }

  // in-memory localStorage (not persisted across launches; a host-fn-backed store can
  // replace this later if persistence is needed).
  if (typeof g.localStorage === 'undefined') {
    var _ls = Object.create(null);
    g.localStorage = {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(_ls, k) ? _ls[k] : null; },
      setItem: function (k, v) { _ls[k] = String(v); },
      removeItem: function (k) { delete _ls[k]; },
      clear: function () { _ls = Object.create(null); },
      key: function (i) { return Object.keys(_ls)[i] || null; },
      get length() { return Object.keys(_ls).length; },
    };
  }

  if (typeof g.navigator === 'undefined') {
    g.navigator = { userAgent: 'rngpui-hermes', platform: 'MacIntel', language: 'en-US', onLine: true, product: 'ReactNative' };
  }

  // URLSearchParams (basic).
  if (typeof g.URLSearchParams === 'undefined') {
    function USP(init) {
      this._p = [];
      if (typeof init === 'string') {
        init = init.replace(/^\?/, '');
        if (init) init.split('&').forEach(function (pair) {
          var kv = pair.split('='); this._p.push([decodeURIComponent(kv[0]), decodeURIComponent(kv[1] || '')]);
        }, this);
      } else if (init) { for (var k in init) this._p.push([k, String(init[k])]); }
    }
    USP.prototype.get = function (k) { for (var i = 0; i < this._p.length; i++) if (this._p[i][0] === k) return this._p[i][1]; return null; };
    USP.prototype.getAll = function (k) { return this._p.filter(function (p) { return p[0] === k; }).map(function (p) { return p[1]; }); };
    USP.prototype.has = function (k) { return this.get(k) !== null; };
    USP.prototype.set = function (k, v) { this['delete'](k); this._p.push([k, String(v)]); };
    USP.prototype.append = function (k, v) { this._p.push([k, String(v)]); };
    USP.prototype['delete'] = function (k) { this._p = this._p.filter(function (p) { return p[0] !== k; }); };
    USP.prototype.forEach = function (cb, t) { this._p.forEach(function (p) { cb.call(t, p[1], p[0], this); }, this); };
    USP.prototype.toString = function () { return this._p.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&'); };
    g.URLSearchParams = USP;
  }
})();
