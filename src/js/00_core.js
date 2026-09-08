/* ==== 00_core.js — Core namespace `window.G` for Chris Jensen's Lord of the Rings Online.
 *
 * Foundation for every other module: constants (G.C), runtime state (G.state), game clock (G.time),
 * event bus, math, seeded RNG (mulberry32), hashing, simplex-2D noise (noise2/fbm/ridged — deterministic,
 * allocation-free, hot-path fast), Three.js helpers (mergeGeometries, colorHex, tmpV3, canvasTexture),
 * formatting, DOM builder, keyboard/mouse/pointer-lock input, spatial hash, and error capture.
 *
 * PUBLIC API — everything from SPEC §2 exactly as named, plus these documented extras:
 *   Math:      G.PI, G.TAU, saturate(x), smootherstep(a,b,x), inverseLerp(a,b,v), remap(v,a,b,c,d),
 *              damp(a,b,lambda,dt) (frame-rate independent lerp), dist2sq(x1,z1,x2,z2), dist3sq(v1,v2), sign(x)
 *   Random:    hash2(x,z,seed?) optional third seed argument; hash3(x,y,z); rng(seed) accepts a number or a string
 *              (hashed) and the returned fn also has .int(a,b) .range(a,b) .pick(arr) .chance(p) .shuffle(arr);
 *              pick(arr, rnd?) / shuffle(arr, rnd?) accept an optional rng fn; weightedPick(items, weightFn|key?, rnd?);
 *              noiseSeeded(seed) → {noise2, fbm, ridged} with independent tables. ridged() returns 0..1.
 *   Three:     mergeGeometries(geoms, {useGroups, materialIndices}) — output is always indexed; attributes are the
 *              union of inputs (missing ones filled: normal (0,1,0), color 1, uv 0). colorHex() returns a SHARED cached
 *              THREE.Color — never mutate it. hexStr(int) → '#rrggbb'. tmpV3(i) pool has 16 entries (i & 15).
 *   Format:    fmtMoneyParts(c) → {g,s,c,neg}, fmtMoneyHTML(c) (spans .money-g/.money-s/.money-c), fmtCompact(n) ('1.2k'),
 *              fmtPct(x, d?), plural(n, word, pluralWord?), escapeHTML(s), pad2(n)
 *   DOM:       el(tag, attrs, children): attrs {class (string|array), id, text, html, style (string|object), data:{}, on:{evt:fn},
 *              on<Event>: fn, ns:'svg', any other → setAttribute/property}; children: string|number|Node|array (nested)|null;
 *              el(tag, children) shorthand. $(sel, root?), $$(sel, root?) → Array.
 *   Misc:      ease {linear,in,out,inOut (quadratic), inCubic,outCubic,inOutCubic,inSine,outSine,inOutSine,outBack,outElastic,outBounce},
 *              roman(n), debounce(fn, ms) (.cancel()), throttle(fn, ms),
 *              tween(obj, props, duration=0.3, easing='inOut'|fn, onDone) → handle {cancel(), onUpdate, done}; duration may be an
 *              options object {duration, delay, easing, onUpdate, onDone}; tweenUpdate(dt) (called by main loop); tweenCancel(obj);
 *              timers.after(sec, fn) / timers.every(sec, fn) (return false from fn to stop) / timers.cancel(h) / timers.clear();
 *              timersUpdate(dt) (called by main loop);
 *              addEntity(ent) / removeEntity(entOrId) / getEntity(id) — maintain G.state.entities, G.state.byId and G.Spatial together;
 *              uidBump(id) (raise the uid counter above a loaded id); reportError(err, where) (record a caught exception);
 *              warn(msg) (console.warn, deduplicated); errorLocation(src, line, col) → 'module.js:line:col' (maps built-HTML lines to modules);
 *              errorsDropped (count beyond the 200 cap). G.debug is also switched on by '#debug' in the URL or localStorage 'cj_lotro_debug'='1'.
 *   Input:     released(code), anyPressed(), pressedCodes(out) (this frame's key edges in arrival order), pendingEdges(),
 *              edge queue: a tap that went down+up between two frames still reports pressed() for exactly one frame, a
 *              second tap of the same key (and everything after it) is replayed on the following frames in order,
 *              mouseDown(b), mousePressed(b), mouseReleased(b) (b: 0 left, 1 middle, 2 right; canvas-origin),
 *              mouse.nx/ny (NDC −1..1), mouse.overCanvas, bound (Set of codes that get preventDefault) + bind(code)/unbind(code),
 *              codeOf(label) ('1'→'Digit1', 'G'→'KeyG'), reset(), frame, lockSupported, onSequence() returns an unsubscribe fn,
 *              bus event 'pointerLock' (bool) on lock change. Sequence letters are not fed while typing in a text field.
 *   Spatial:   query(x,z,r,filter?,out?) optional output array; clear(); count; cellOf(x,z) → packed key.
 * ==== */
(function () {
  'use strict';

  const G = window.G = {};
  G.VERSION = '1.0.0';

  /* ------------------------------------------------------------------ constants */
  G.C = {
    WORLD_SIZE: 4096,
    SEA_LEVEL: 0,
    LEVEL_CAP: 80,
    INVENTORY_SLOTS: 200,
    HOTBAR_KEYS: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', 'G', 'T', 'V', 'X', 'Y', 'Z', 'L', 'N', 'O', 'U'],
    RUN_SPEED: 6.5, WALK_SPEED: 2.5, MOUNT_SPEED: 15, SWIM_SPEED: 3, ROLL_SPEED: 10, ROLL_TIME: 0.55, ROLL_CD: 3,
    JUMP_VEL: 6.5, GRAVITY: -20,
    PLAYER_RADIUS: 0.4,
    INTERACT_RANGE: 4, MELEE_RANGE: 3.2, RANGED_RANGE: 30, AGGRO_RANGE: 14,
    ENTITY_RENDER_DIST: 220, MONSTER_SPAWN_DIST: 260, NPC_RENDER_DIST: 200, AIPLAYER_RENDER_DIST: 180, MAX_RENDERED_CHARS: 40,
    MONEY: { SILVER: 100, GOLD: 100000 },
    RARITY: ['common', 'uncommon', 'rare', 'incomparable', 'legendary'],
    RARITY_COLOR: { common: '#d9d9d9', uncommon: '#ffe86b', rare: '#c48bff', incomparable: '#52b7ff', legendary: '#ff9c3a' },
    EQUIP_SLOTS: ['head', 'shoulder', 'back', 'chest', 'hands', 'legs', 'feet', 'mainhand', 'offhand', 'ranged', 'neck', 'ear1', 'ear2', 'wrist1', 'wrist2', 'ring1', 'ring2', 'pocket'],
    ADMIN_CODE: 'chris',
    SAVE_KEY: 'cj_lotro_save_v1',
  };

  /* ------------------------------------------------------------------ state & time */
  G.state = {
    phase: 'loading',
    player: null,
    entities: [],
    byId: {},
    zone: 'shire',
    inCombat: false,
    quality: 'high',
    settings: { music: 0.6, sfx: 0.8, mouseSens: 1.0, invertY: false, showFps: false, cameraDist: 7, shadows: true },
    weather: 'clear',
    fishingSkill: 1,
    stats: { kills: 0, quests: 0, fish: 0, deaths: 0, playTime: 0 },
  };

  G.time = { now: 0, dt: 0, frame: 0, dayTime: 8.0, dayLengthMinutes: 24, scale: 1, paused: false };

  G.debug = false;
  try {
    if (/debug/.test(window.location.hash) || (window.localStorage && window.localStorage.getItem('cj_lotro_debug') === '1')) G.debug = true;
  } catch (_) { /* storage may be unavailable */ }

  G.log = function () { if (G.debug) console.log.apply(console, arguments); };

  const _warned = new Set();
  G.warn = function (msg) {
    msg = String(msg);
    if (_warned.has(msg)) return;
    if (_warned.size < 500) _warned.add(msg);
    console.warn('[G] ' + msg);
  };

  /* ------------------------------------------------------------------ error capture */
  const errors = G.errors = [];
  G.errorsDropped = 0;
  const ERROR_CAP = 200;

  function pushError(text) {
    if (errors.length < ERROR_CAP) errors.push(text); else G.errorsDropped++;
    G.log('[error]', text);
  }

  // Line-number mapping: in the single-file build every module is an inline <script data-module="..."> and the
  // browser reports HTML document lines. We learn the core script's document line once (marker trick) and
  // derive every later inline module's line range from the DOM, so errors read "20_player.js:123:4".
  const _coreScript = (typeof document !== 'undefined' && document.currentScript) || null;
  let _lineTable = null;
  const _coreBase = (function () {
    try {
      if (!_coreScript || _coreScript.src) return -1;
      const tc = _coreScript.textContent || '';
      const marker = '/*@CORE' + '_LINE@*/';
      const idx = tc.indexOf(marker);
      if (idx < 0) return -1;
      let local = 1;
      for (let i = 0; i < idx; i++) if (tc.charCodeAt(i) === 10) local++;
      const st = String(new Error('probe').stack || ''); /*@CORE_LINE@*/
      const frame = st.split('\n')[1] || '';
      const m = /:(\d+):(\d+)\)?\s*$/.exec(frame);
      if (!m) return -1;
      return (+m[1]) - local + 1;
    } catch (_) { return -1; }
  })();

  function countLines(s) { let n = 1; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++; return n; }

  function buildLineTable() {
    _lineTable = [];
    if (_coreBase < 0 || !_coreScript) return;
    try {
      let s = _coreScript, base = _coreBase;
      while (s) {
        const lines = countLines(s.textContent || '');
        _lineTable.push({ name: s.getAttribute('data-module') || 'inline', base: base, end: base + lines - 1 });
        let n = s.nextSibling, nl = 0;
        while (n && n.nodeType === 3) { nl += countLines(n.nodeValue || '') - 1; n = n.nextSibling; }
        if (!n || n.nodeType !== 1 || n.tagName !== 'SCRIPT' || n.src) break;
        base = base + lines - 1 + nl;
        s = n;
      }
    } catch (_) { /* keep whatever we built */ }
  }

  function stripUrl(u) { return String(u || '').split('#')[0].split('?')[0]; }

  G.errorLocation = function (src, line, col) {
    line = +line || 0; col = +col || 0;
    const here = typeof location !== 'undefined' ? stripUrl(location.href) : '';
    if (!src || stripUrl(src) === here) {
      if (!_lineTable) buildLineTable();
      for (let i = 0; i < _lineTable.length; i++) {
        const e = _lineTable[i];
        if (line >= e.base && line <= e.end) return e.name + ':' + (line - e.base) + ':' + col;
      }
    }
    const base = stripUrl(src).split('/').pop() || 'anonymous';
    return base + ':' + line + ':' + col;
  };

  // Matches V8 ("    at fn (url:line:col)" / "    at url:line:col") and Gecko ("fn@url:line:col") frames only.
  const FRAME_RE = /^(?:\s+at\s.*?|.*@)([^\s()@]+?):(\d+):(\d+)\)?\s*$/;
  function mapStack(stack, max) {
    const out = [];
    const lines = String(stack || '').split('\n');
    for (let i = 0; i < lines.length && out.length < max; i++) {
      const m = FRAME_RE.exec(lines[i]);
      if (!m) continue;
      let src = m[1];
      if (!/^(file|https?|blob|data|chrome-extension):/.test(src) && src.indexOf('/') < 0) src = '';   // "<anonymous>", "eval" …
      out.push(G.errorLocation(src, m[2], m[3]));
    }
    return out;
  }

  function describeError(err, fallbackMsg, src, line, col) {
    let text;
    if (err && typeof err === 'object') {
      text = (err.name ? err.name + ': ' : '') + (err.message !== undefined ? err.message : String(err));
      const frames = mapStack(err.stack, 4);
      if (frames.length) text += ' @ ' + frames.join(' < ');
      else if (line) text += ' @ ' + G.errorLocation(src, line, col);
    } else {
      text = String(fallbackMsg !== undefined ? fallbackMsg : err);
      if (line) text += ' @ ' + G.errorLocation(src, line, col);
    }
    return text;
  }

  window.onerror = function (msg, src, line, col, err) {
    try { pushError(describeError(err, msg, src, line, col)); } catch (_) { pushError(String(msg)); }
    return false;
  };
  window.addEventListener('unhandledrejection', function (e) {
    try {
      const r = e && e.reason;
      pushError('Unhandled rejection: ' + describeError(r, r === undefined ? 'unknown' : r));
    } catch (_) { pushError('Unhandled rejection'); }
  });

  G.reportError = function (err, where) {
    const text = (where ? where + ': ' : '') + describeError(err, err);
    pushError(text);
    G.warn(text);
    return text;
  };

  function safeCall(fn, a, b) {
    try { return fn(a, b); } catch (e) { G.reportError(e, 'callback'); return undefined; }
  }

  /* ------------------------------------------------------------------ event bus */
  const _handlers = Object.create(null);

  G.on = function (evt, fn) {
    if (typeof fn !== 'function' || !evt) return fn;
    const list = _handlers[evt];
    _handlers[evt] = list ? list.concat([fn]) : [fn];   // copy-on-write: emit iterates immutable snapshots
    return fn;
  };
  G.off = function (evt, fn) {
    const list = _handlers[evt];
    if (!list) return;
    if (!fn) { delete _handlers[evt]; return; }
    const next = [];
    for (let i = 0; i < list.length; i++) { const h = list[i]; if (h !== fn && h._orig !== fn) next.push(h); }
    if (next.length) _handlers[evt] = next; else delete _handlers[evt];
  };
  G.once = function (evt, fn) {
    if (typeof fn !== 'function') return fn;
    const w = function (a, b, c) { G.off(evt, w); return fn.apply(null, arguments); };
    w._orig = fn;
    G.on(evt, w);
    return w;
  };
  G.emit = function (evt, a, b, c) {
    const list = _handlers[evt];
    if (!list) return 0;
    const n = arguments.length;
    for (let i = 0; i < list.length; i++) {
      const fn = list[i];
      try {
        if (n <= 4) fn(a, b, c);
        else fn.apply(null, Array.prototype.slice.call(arguments, 1));
      } catch (e) { G.reportError(e, 'emit(' + evt + ')'); }
    }
    return list.length;
  };

  /* ------------------------------------------------------------------ math */
  const PI = Math.PI, TAU = Math.PI * 2;
  G.PI = PI; G.TAU = TAU;
  G.clamp = function (v, a, b) { return v < a ? a : v > b ? b : v; };
  G.saturate = function (v) { return v < 0 ? 0 : v > 1 ? 1 : v; };
  G.lerp = function (a, b, t) { return a + (b - a) * t; };
  G.inverseLerp = function (a, b, v) { return a === b ? 0 : (v - a) / (b - a); };
  G.remap = function (v, a, b, c, d) { const t = a === b ? 0 : (v - a) / (b - a); return c + (d - c) * (t < 0 ? 0 : t > 1 ? 1 : t); };
  G.smoothstep = function (a, b, x) { const t = a === b ? (x < a ? 0 : 1) : G.saturate((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  G.smootherstep = function (a, b, x) { const t = a === b ? (x < a ? 0 : 1) : G.saturate((x - a) / (b - a)); return t * t * t * (t * (t * 6 - 15) + 10); };
  G.mod = function (a, n) { return ((a % n) + n) % n; };
  G.rad = function (deg) { return deg * (PI / 180); };
  G.deg = function (rad) { return rad * (180 / PI); };
  G.sign = function (x) { return x > 0 ? 1 : x < 0 ? -1 : 0; };
  G.wrapAngle = function (a) { a = a % TAU; if (a > PI) a -= TAU; else if (a < -PI) a += TAU; return a; };
  G.angleLerp = function (a, b, t) { return a + G.wrapAngle(b - a) * t; };
  G.damp = function (a, b, lambda, dt) { return a + (b - a) * (1 - Math.exp(-lambda * dt)); };
  G.dist2 = function (x1, z1, x2, z2) { const dx = x2 - x1, dz = z2 - z1; return Math.sqrt(dx * dx + dz * dz); };
  G.dist2sq = function (x1, z1, x2, z2) { const dx = x2 - x1, dz = z2 - z1; return dx * dx + dz * dz; };
  G.dist3 = function (v1, v2) { const dx = v2.x - v1.x, dy = v2.y - v1.y, dz = v2.z - v1.z; return Math.sqrt(dx * dx + dy * dy + dz * dz); };
  G.dist3sq = function (v1, v2) { const dx = v2.x - v1.x, dy = v2.y - v1.y, dz = v2.z - v1.z; return dx * dx + dy * dy + dz * dz; };
  G.dist2v = function (v1, v2) { const dx = v2.x - v1.x, dz = v2.z - v1.z; return Math.sqrt(dx * dx + dz * dz); };

  /* ------------------------------------------------------------------ random & hashing */
  function mulberry32(a) {
    a |= 0;
    return function () {
      a = a + 0x6D2B79F5 | 0;
      let t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  G.hashStr = function (s) {
    s = String(s);
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
  };

  function toSeed(seed) {
    if (typeof seed === 'string') return G.hashStr(seed);
    if (typeof seed !== 'number' || seed !== seed) return 1337;
    return (seed === (seed | 0)) ? seed : (Math.floor(seed) ^ Math.floor(seed * 1000003)) | 0;
  }

  let _randState = 1337;
  G.seed = function (n) { _randState = toSeed(n === undefined ? 1337 : n); };
  G.rand = function () {
    _randState = _randState + 0x6D2B79F5 | 0;
    let t = Math.imul(_randState ^ _randState >>> 15, 1 | _randState);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  G.randInt = function (a, b) { if (b === undefined) { b = a; a = 0; } a = Math.ceil(a); b = Math.floor(b); return a + Math.floor(G.rand() * (b - a + 1)); };
  G.randRange = function (a, b) { return a + (b - a) * G.rand(); };
  G.chance = function (p) { return G.rand() < p; };
  G.pick = function (arr, rnd) { if (!arr || !arr.length) return undefined; return arr[Math.floor((rnd || G.rand)() * arr.length)]; };
  G.shuffle = function (arr, rnd) {
    if (!arr) return arr;
    const r = rnd || G.rand;
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    return arr;
  };
  G.weightedPick = function (items, weightFn, rnd) {
    if (!items || !items.length) return null;
    let getW;
    if (typeof weightFn === 'function') getW = weightFn;
    else if (typeof weightFn === 'string') getW = function (it) { return it ? +it[weightFn] || 0 : 0; };
    else getW = function (it) { return it && typeof it === 'object' ? (+it.weight || 0) : 1; };
    let total = 0;
    for (let i = 0; i < items.length; i++) { const w = +getW(items[i], i) || 0; if (w > 0) total += w; }
    if (total <= 0) return null;
    let r = (rnd || G.rand)() * total;
    for (let i = 0; i < items.length; i++) {
      const w = +getW(items[i], i) || 0;
      if (w <= 0) continue;
      r -= w;
      if (r < 0) return items[i];
    }
    return items[items.length - 1];
  };
  G.rng = function (seed) {
    const s = toSeed(seed);
    const fn = mulberry32(s);
    fn.seed = s;
    fn.int = function (a, b) { if (b === undefined) { b = a; a = 0; } a = Math.ceil(a); b = Math.floor(b); return a + Math.floor(fn() * (b - a + 1)); };
    fn.range = function (a, b) { return a + (b - a) * fn(); };
    fn.chance = function (p) { return fn() < p; };
    fn.pick = function (arr) { return G.pick(arr, fn); };
    fn.shuffle = function (arr) { return G.shuffle(arr, fn); };
    return fn;
  };

  // Float → integer bits (allocation-free), used to hash arbitrary real coordinates exactly.
  const _f64 = new Float64Array(1);
  const _i32 = new Int32Array(_f64.buffer);
  function mix32(h) { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16; return h; }
  G.hash2 = function (x, z, seed) {
    _f64[0] = x + 0;                                   // "+ 0" folds -0 into +0
    let h = Math.imul(_i32[0], 0x27d4eb2d) ^ Math.imul(_i32[1] + 0x165667b1, 0x9e3779b1);
    _f64[0] = z + 0;
    h = Math.imul(h ^ Math.imul(_i32[0] + 0x7f4a7c15, 0x85ebca6b) ^ Math.imul(_i32[1] + 0x2545f491, 0xc2b2ae35), 0x9e3779b1);
    if (seed) h ^= Math.imul(seed | 0, 0x27d4eb2d);
    return (mix32(h) >>> 0) / 4294967296;
  };
  G.hash3 = function (x, y, z) {
    _f64[0] = x + 0;
    let h = Math.imul(_i32[0], 0x27d4eb2d) ^ Math.imul(_i32[1] + 0x165667b1, 0x9e3779b1);
    _f64[0] = y + 0;
    h = Math.imul(h ^ Math.imul(_i32[0] + 0x7f4a7c15, 0x85ebca6b) ^ Math.imul(_i32[1] + 0x2545f491, 0xc2b2ae35), 0x9e3779b1);
    _f64[0] = z + 0;
    h = Math.imul(h ^ Math.imul(_i32[0] + 0x3c6ef372, 0x27d4eb2d) ^ Math.imul(_i32[1] + 0x6a09e667, 0x85ebca6b), 0xc2b2ae35);
    return (mix32(h) >>> 0) / 4294967296;
  };

  /* ------------------------------------------------------------------ simplex noise */
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;
  const GRAD2 = new Float64Array([1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 1, 0, -1, 0, 0, 1, 0, -1, 0, 1, 0, -1]);

  function makeNoise(seed) {
    const perm = new Uint8Array(512), pm12 = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    const r = mulberry32(toSeed(seed));
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    for (let i = 0; i < 512; i++) { perm[i] = p[i & 255]; pm12[i] = perm[i] % 12; }

    function noise2(xin, zin) {
      const s = (xin + zin) * F2;
      const i = Math.floor(xin + s), j = Math.floor(zin + s);
      const t = (i + j) * G2;
      const x0 = xin - (i - t), y0 = zin - (j - t);
      let i1, j1;
      if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
      const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
      const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
      const ii = i & 255, jj = j & 255;
      let n0 = 0, n1 = 0, n2 = 0;
      let t0 = 0.5 - x0 * x0 - y0 * y0;
      if (t0 >= 0) { const gi = pm12[ii + perm[jj]] * 2; t0 *= t0; n0 = t0 * t0 * (GRAD2[gi] * x0 + GRAD2[gi + 1] * y0); }
      let t1 = 0.5 - x1 * x1 - y1 * y1;
      if (t1 >= 0) { const gi = pm12[ii + i1 + perm[jj + j1]] * 2; t1 *= t1; n1 = t1 * t1 * (GRAD2[gi] * x1 + GRAD2[gi + 1] * y1); }
      let t2 = 0.5 - x2 * x2 - y2 * y2;
      if (t2 >= 0) { const gi = pm12[ii + 1 + perm[jj + 1]] * 2; t2 *= t2; n2 = t2 * t2 * (GRAD2[gi] * x2 + GRAD2[gi + 1] * y2); }
      return 70 * (n0 + n1 + n2);
    }

    // Fractal Brownian motion, normalised to -1..1. Each octave is offset so lattice features don't stack.
    function fbm(x, z, octaves, lacunarity, gain) {
      if (octaves === undefined) octaves = 4;
      if (lacunarity === undefined) lacunarity = 2;
      if (gain === undefined) gain = 0.5;
      let sum = 0, amp = 1, norm = 0, f = 1;
      for (let o = 0; o < octaves; o++) {
        sum += amp * noise2(x * f + o * 31.416, z * f - o * 27.183);
        norm += amp; amp *= gain; f *= lacunarity;
      }
      return norm > 0 ? sum / norm : 0;
    }

    // Ridged multifractal (sharp mountain ridges), 0..1.
    function ridged(x, z, octaves, lacunarity, gain) {
      if (octaves === undefined) octaves = 4;
      if (lacunarity === undefined) lacunarity = 2;
      if (gain === undefined) gain = 0.5;
      let sum = 0, amp = 1, norm = 0, f = 1, weight = 1;
      for (let o = 0; o < octaves; o++) {
        let n = 1 - Math.abs(noise2(x * f + o * 31.416, z * f - o * 27.183));
        n *= n; n *= weight;
        weight = n * 2; if (weight > 1) weight = 1;
        sum += n * amp; norm += amp; amp *= gain; f *= lacunarity;
      }
      return norm > 0 ? sum / norm : 0;
    }

    return { noise2: noise2, fbm: fbm, ridged: ridged, seed: seed };
  }

  const _defaultNoise = makeNoise(1337);
  G.noise2 = _defaultNoise.noise2;
  G.fbm = _defaultNoise.fbm;
  G.ridged = _defaultNoise.ridged;
  G.noiseSeeded = function (seed) { return makeNoise(seed); };

  /* ------------------------------------------------------------------ three.js helpers */
  const ATTR_FILL = { normal: [0, 1, 0, 0], color: [1, 1, 1, 1], uv: [0, 0, 0, 0], uv2: [0, 0, 0, 0] };

  G.mergeGeometries = function (geoms, opts) {
    const out = new THREE.BufferGeometry();
    if (!geoms) return out;
    if (!Array.isArray(geoms)) geoms = geoms.isBufferGeometry ? [geoms] : [];
    const list = [];
    for (let i = 0; i < geoms.length; i++) {
      const g = geoms[i];
      if (g && g.isBufferGeometry && g.attributes && g.attributes.position && g.attributes.position.count > 0) list.push(g);
    }
    if (!list.length) return out;
    const useGroups = !!(opts && opts.useGroups);
    const matIdx = opts && opts.materialIndices;

    // Union of attribute names; remember layout of the first occurrence and whether all inputs agree.
    const names = [], info = Object.create(null);
    for (let gi = 0; gi < list.length; gi++) {
      const attrs = list[gi].attributes;
      for (const name in attrs) {
        const a = attrs[name];
        if (!a || !a.itemSize) continue;
        const f = info[name];
        if (!f) {
          names.push(name);
          info[name] = { itemSize: a.itemSize, normalized: !!a.normalized, Type: (a.array && a.array.constructor) || Float32Array, uniform: !a.isInterleavedBufferAttribute };
        } else if (a.itemSize !== f.itemSize || !a.array || a.array.constructor !== f.Type || !!a.normalized !== f.normalized || a.isInterleavedBufferAttribute) {
          f.uniform = false;
        }
      }
    }
    for (let k = 0; k < names.length; k++) {
      const f = info[names[k]];
      for (let gi = 0; gi < list.length; gi++) if (!list[gi].attributes[names[k]]) { f.uniform = f.uniform && f.Type === Float32Array; break; }
    }

    let vCount = 0, iCount = 0;
    for (let gi = 0; gi < list.length; gi++) {
      const g = list[gi], n = g.attributes.position.count;
      vCount += n; iCount += g.index ? g.index.count : n;
    }
    const arrays = Object.create(null);
    for (let k = 0; k < names.length; k++) {
      const f = info[names[k]];
      const T = f.uniform ? f.Type : Float32Array;
      arrays[names[k]] = new T(vCount * f.itemSize);
    }
    const index = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);

    let vOff = 0, iOff = 0;
    for (let gi = 0; gi < list.length; gi++) {
      const g = list[gi], n = g.attributes.position.count;
      for (let k = 0; k < names.length; k++) {
        const name = names[k], f = info[name], dst = arrays[name], sz = f.itemSize, base = vOff * sz;
        const a = g.attributes[name];
        if (!a) {
          const fill = ATTR_FILL[name];
          for (let v = 0; v < n; v++) for (let c = 0; c < sz; c++) dst[base + v * sz + c] = fill ? fill[c] : 0;
        } else if (f.uniform && a.array && a.array.length === n * sz) {
          dst.set(a.array, base);
        } else {
          const asz = a.itemSize;
          for (let v = 0; v < n; v++) {
            const o = base + v * sz;
            dst[o] = a.getX(v);
            if (sz > 1) dst[o + 1] = asz > 1 ? a.getY(v) : 0;
            if (sz > 2) dst[o + 2] = asz > 2 ? a.getZ(v) : 0;
            if (sz > 3) dst[o + 3] = asz > 3 ? a.getW(v) : (name === 'color' ? 1 : 0);
          }
        }
      }
      let count;
      if (g.index) {
        const ia = g.index.array; count = g.index.count;
        for (let q = 0; q < count; q++) index[iOff + q] = ia[q] + vOff;
      } else {
        count = n;
        for (let q = 0; q < n; q++) index[iOff + q] = vOff + q;
      }
      if (useGroups) out.addGroup(iOff, count, matIdx && matIdx[gi] !== undefined ? matIdx[gi] : gi);
      vOff += n; iOff += count;
    }
    out.setIndex(new THREE.BufferAttribute(index, 1));
    for (let k = 0; k < names.length; k++) {
      const f = info[names[k]];
      out.setAttribute(names[k], new THREE.BufferAttribute(arrays[names[k]], f.itemSize, f.uniform ? f.normalized : false));
    }
    return out;
  };

  function toHexInt(h) {
    if (typeof h === 'number') return h & 0xffffff;
    if (typeof h === 'string') {
      let s = h.trim();
      if (s.charCodeAt(0) === 35) s = s.slice(1);
      if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
      const v = parseInt(s, 16);
      return v === v ? (v & 0xffffff) : 0;
    }
    if (h && typeof h.getHex === 'function') return h.getHex();
    return 0;
  }
  G.hexStr = function (h) { const s = (toHexInt(h) >>> 0).toString(16); return '#' + '000000'.slice(s.length) + s; };

  const _colorCache = new Map();
  G.colorHex = function (h) {
    const key = typeof h === 'number' ? h : String(h);
    let c = _colorCache.get(key);
    if (!c) {
      if (typeof THREE === 'undefined') return null;
      c = new THREE.Color();
      if (typeof h === 'number') c.setHex(h); else { try { c.set(h); } catch (_) { c.setHex(toHexInt(h)); } }
      _colorCache.set(key, c);
    }
    return c;
  };

  G.lerpColor = function (a, b, t) {
    a = toHexInt(a); b = toHexInt(b);
    t = t < 0 ? 0 : t > 1 ? 1 : (t || 0);
    const ar = a >> 16 & 255, ag = a >> 8 & 255, ab = a & 255;
    const br = b >> 16 & 255, bg = b >> 8 & 255, bb = b & 255;
    const r = Math.round(ar + (br - ar) * t), g = Math.round(ag + (bg - ag) * t), bl = Math.round(ab + (bb - ab) * t);
    return (r << 16) | (g << 8) | bl;
  };

  const _v3pool = [];
  G.tmpV3 = function (i) {
    if (_v3pool.length === 0) for (let k = 0; k < 16; k++) _v3pool.push(new THREE.Vector3());
    return _v3pool[(i | 0) & 15];
  };

  G.canvasTexture = function (w, h, drawFn, opts) {
    w = Math.max(1, w | 0); h = Math.max(1, h | 0);
    opts = opts || {};
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (ctx && typeof drawFn === 'function') {
      try { drawFn(ctx, w, h); } catch (e) { G.reportError(e, 'canvasTexture draw'); }
    }
    const tex = new THREE.CanvasTexture(canvas);
    const wrap = opts.wrap === false ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.wrapS = tex.wrapT = wrap;
    const rep = opts.repeat;
    if (rep) { if (Array.isArray(rep)) tex.repeat.set(+rep[0] || 1, +rep[1] || 1); else if (typeof rep === 'number') tex.repeat.set(rep, rep); }
    if (opts.nearest) { tex.magFilter = THREE.NearestFilter; tex.minFilter = opts.mipmaps === false ? THREE.NearestFilter : THREE.NearestMipmapLinearFilter; }
    else if (opts.mipmaps === false) { tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false; }
    tex.colorSpace = opts.linear ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    tex.anisotropy = opts.anisotropy !== undefined ? opts.anisotropy : 4;
    if (opts.flipY !== undefined) tex.flipY = !!opts.flipY;
    tex.needsUpdate = true;
    return tex;
  };

  /* ------------------------------------------------------------------ ids & formatting */
  let _uid = 0;
  G.uid = function () { return 'u' + (++_uid); };
  G.uidBump = function (id) {
    const n = typeof id === 'number' ? id : parseInt(String(id || '').replace(/^u/, ''), 10);
    if (n === n && n > _uid) _uid = n;
    return _uid;
  };

  G.pad2 = function (n) { n = n | 0; return (n < 10 && n >= 0 ? '0' : '') + n; };
  G.fmtNum = function (n, decimals) {
    n = +n;
    if (n !== n || n === Infinity || n === -Infinity) return '0';
    const d = decimals | 0;
    const fixed = Math.abs(n).toFixed(d);
    const dot = fixed.indexOf('.');
    const int = dot < 0 ? fixed : fixed.slice(0, dot);
    const frac = dot < 0 ? '' : fixed.slice(dot);
    return (n < 0 && +fixed !== 0 ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + frac;
  };
  G.fmtCompact = function (n) {
    n = +n || 0;
    const a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e9) return s + (a / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (a >= 1e6) return s + (a / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (a >= 1e4) return s + (a / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
    return G.fmtNum(n);
  };
  G.fmtPct = function (x, decimals) { return (+x || 0).toFixed(decimals === undefined ? 1 : decimals | 0) + '%'; };
  G.fmtMoneyParts = function (copper) {
    const v = +copper || 0;
    let c = Math.round(Math.abs(v));
    const M = G.C.MONEY;
    const g = Math.floor(c / M.GOLD); c -= g * M.GOLD;
    const s = Math.floor(c / M.SILVER); c -= s * M.SILVER;
    return { g: g, s: s, c: c, neg: v < 0 };
  };
  G.fmtMoney = function (copper) {
    const p = G.fmtMoneyParts(copper);
    let out = '';
    if (p.g) out += p.g + 'g ';
    if (p.g || p.s) out += p.s + 's ';
    out += p.c + 'c';
    return (p.neg ? '-' : '') + out;
  };
  G.fmtMoneyHTML = function (copper) {
    const p = G.fmtMoneyParts(copper);
    let out = '<span class="money">' + (p.neg ? '-' : '');
    if (p.g) out += '<span class="money-g">' + G.fmtNum(p.g) + 'g</span> ';
    if (p.g || p.s) out += '<span class="money-s">' + p.s + 's</span> ';
    out += '<span class="money-c">' + p.c + 'c</span></span>';
    return out;
  };
  G.fmtTime = function (sec) {
    sec = Math.max(0, Math.floor(+sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? h + ':' + G.pad2(m) + ':' + G.pad2(s) : m + ':' + G.pad2(s);
  };
  G.titleCase = function (s) {
    return String(s == null ? '' : s).replace(/_+/g, ' ').toLowerCase().replace(/(^|\s)(\S)/g, function (_, a, b) { return a + b.toUpperCase(); });
  };
  G.plural = function (n, word, pluralWord) { return (n === 1 || n === -1) ? word : (pluralWord || (word + 's')); };
  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  G.escapeHTML = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) { return ESC_MAP[ch]; }); };
  G.roman = function (n) {
    n = Math.floor(+n || 0);
    if (n <= 0 || n >= 4000) return n <= 0 ? '' : String(n);
    const V = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
    const S = ['M', 'CM', 'D', 'CD', 'C', 'XC', 'L', 'XL', 'X', 'IX', 'V', 'IV', 'I'];
    let out = '';
    for (let i = 0; i < V.length; i++) while (n >= V[i]) { out += S[i]; n -= V[i]; }
    return out;
  };

  /* ------------------------------------------------------------------ DOM */
  const PROP_KEYS = new Set(['value', 'checked', 'disabled', 'selected', 'readOnly', 'multiple', 'tabIndex', 'hidden', 'draggable', 'indeterminate', 'scrollTop', 'scrollLeft', 'volume', 'muted', 'currentTime']);
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function appendChildren(e, c) {
    if (c == null || c === false || c === true) return;
    if (Array.isArray(c)) { for (let i = 0; i < c.length; i++) appendChildren(e, c[i]); }
    else if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(String(c)));
    else if (c.nodeType) e.appendChild(c);
  }

  G.el = function (tag, attrs, children) {
    if (attrs != null && (typeof attrs === 'string' || typeof attrs === 'number' || Array.isArray(attrs) || attrs.nodeType)) { children = attrs; attrs = null; }
    const ns = attrs && attrs.ns;
    const e = ns ? document.createElementNS(ns === 'svg' ? SVG_NS : ns, tag) : document.createElement(tag || 'div');
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false || k === 'ns') continue;
        if (k === 'class' || k === 'className') e.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v));
        else if (k === 'id') e.id = String(v);
        else if (k === 'text') e.textContent = String(v);
        else if (k === 'html') e.innerHTML = String(v);
        else if (k === 'style') {
          if (typeof v === 'string') e.style.cssText = v;
          else for (const s in v) { if (s.indexOf('-') >= 0) e.style.setProperty(s, v[s]); else e.style[s] = v[s]; }
        }
        else if (k === 'data' && typeof v === 'object') { for (const d in v) if (v[d] !== undefined && v[d] !== null) e.dataset[d] = String(v[d]); }
        else if (k === 'on' && typeof v === 'object') { for (const ev in v) if (typeof v[ev] === 'function') e.addEventListener(ev, v[ev]); }
        else if (k.length > 2 && k.charCodeAt(0) === 111 && k.charCodeAt(1) === 110 && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
        else if (PROP_KEYS.has(k)) e[k] = v;
        else if (v === true) e.setAttribute(k, '');
        else e.setAttribute(k, String(v));
      }
    }
    if (children != null) appendChildren(e, children);
    return e;
  };
  G.$ = function (sel, root) { if (!sel) return null; if (typeof sel !== 'string') return sel.nodeType ? sel : null; return (root || document).querySelector(sel); };
  G.$$ = function (sel, root) { if (!sel) return []; if (typeof sel !== 'string') return sel.nodeType ? [sel] : Array.from(sel); return Array.from((root || document).querySelectorAll(sel)); };

  /* ------------------------------------------------------------------ easing, debounce */
  G.ease = {
    linear: function (t) { return t; },
    in: function (t) { return t * t; },
    out: function (t) { return t * (2 - t); },
    inOut: function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; },
    inCubic: function (t) { return t * t * t; },
    outCubic: function (t) { const u = 1 - t; return 1 - u * u * u; },
    inOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    inSine: function (t) { return 1 - Math.cos(t * PI / 2); },
    outSine: function (t) { return Math.sin(t * PI / 2); },
    inOutSine: function (t) { return -(Math.cos(PI * t) - 1) / 2; },
    outBack: function (t) { const c1 = 1.70158, c3 = c1 + 1, u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; },
    outElastic: function (t) { return t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1; },
    outBounce: function (t) {
      const n1 = 7.5625, d1 = 2.75;
      if (t < 1 / d1) return n1 * t * t;
      if (t < 2 / d1) { t -= 1.5 / d1; return n1 * t * t + 0.75; }
      if (t < 2.5 / d1) { t -= 2.25 / d1; return n1 * t * t + 0.9375; }
      t -= 2.625 / d1; return n1 * t * t + 0.984375;
    },
  };

  G.debounce = function (fn, ms) {
    let handle = 0, lastArgs = null, lastThis = null;
    const wrapped = function () {
      lastArgs = arguments; lastThis = this;
      if (handle) clearTimeout(handle);
      handle = setTimeout(function () { handle = 0; const a = lastArgs; lastArgs = null; fn.apply(lastThis, a); }, ms || 0);
    };
    wrapped.cancel = function () { if (handle) clearTimeout(handle); handle = 0; lastArgs = null; };
    wrapped.flush = function () { if (handle) { clearTimeout(handle); handle = 0; const a = lastArgs; lastArgs = null; if (a) fn.apply(lastThis, a); } };
    return wrapped;
  };
  G.throttle = function (fn, ms) {
    let last = -Infinity, handle = 0, pendingArgs = null, pendingThis = null;
    const wrapped = function () {
      const now = performance.now();
      if (now - last >= (ms || 0)) { last = now; fn.apply(this, arguments); return; }
      pendingArgs = arguments; pendingThis = this;
      if (!handle) handle = setTimeout(function () { handle = 0; last = performance.now(); const a = pendingArgs; pendingArgs = null; if (a) fn.apply(pendingThis, a); }, (ms || 0) - (now - last));
    };
    wrapped.cancel = function () { if (handle) clearTimeout(handle); handle = 0; pendingArgs = null; };
    return wrapped;
  };

  /* ------------------------------------------------------------------ tweens */
  const _tweens = [];
  G.tweens = _tweens;

  G.tween = function (obj, props, duration, easing, onDone) {
    if (!obj || !props || typeof obj !== 'object') return null;
    let opts = null;
    if (duration && typeof duration === 'object') { opts = duration; duration = opts.duration; easing = opts.easing; onDone = opts.onDone; }
    if (duration === undefined || duration === null) duration = 0.3;
    const dur = Math.max(0, +duration || 0);
    const easeFn = typeof easing === 'function' ? easing : (G.ease[easing] || G.ease.inOut);
    const keys = [], from = [], to = [];
    for (const k in props) {
      const tv = +props[k];
      if (tv !== tv || tv === Infinity || tv === -Infinity) continue;
      const cv = +obj[k];
      keys.push(k); from.push(cv === cv ? cv : tv); to.push(tv);
    }
    // A new tween on the same object takes over its properties from older ones.
    for (let i = 0; i < _tweens.length; i++) {
      const t = _tweens[i];
      if (t.obj !== obj || t.done) continue;
      for (let k = 0; k < keys.length; k++) {
        const idx = t.keys.indexOf(keys[k]);
        if (idx >= 0) { t.keys.splice(idx, 1); t.from.splice(idx, 1); t.to.splice(idx, 1); }
      }
      if (!t.keys.length) t.done = true;
    }
    const tw = {
      obj: obj, keys: keys, from: from, to: to, t: 0, dur: dur,
      delay: opts && opts.delay > 0 ? +opts.delay : 0,
      ease: easeFn, onDone: typeof onDone === 'function' ? onDone : null,
      onUpdate: opts && typeof opts.onUpdate === 'function' ? opts.onUpdate : null,
      done: false,
      cancel: function () { this.done = true; return this; },
    };
    _tweens.push(tw);
    return tw;
  };
  G.tweenCancel = function (obj) {
    let n = 0;
    for (let i = 0; i < _tweens.length; i++) if (_tweens[i].obj === obj && !_tweens[i].done) { _tweens[i].done = true; n++; }
    return n;
  };
  G.tweenUpdate = function (dt) {
    dt = +dt || 0;
    for (let i = _tweens.length - 1; i >= 0; i--) {
      const t = _tweens[i];
      if (!t.done) {
        let step = dt;
        if (t.delay > 0) {
          t.delay -= step;
          if (t.delay > 0) continue;
          step = -t.delay; t.delay = 0;
        }
        t.t += step;
        const k = t.dur > 0 ? (t.t >= t.dur ? 1 : t.t / t.dur) : 1;
        const e = k >= 1 ? 1 : t.ease(k);
        const o = t.obj, keys = t.keys, from = t.from, to = t.to;
        for (let j = 0; j < keys.length; j++) o[keys[j]] = from[j] + (to[j] - from[j]) * e;
        if (t.onUpdate) safeCall(t.onUpdate, k, o);
        if (k >= 1) { t.done = true; if (t.onDone) safeCall(t.onDone, o); }
      }
      if (t.done) {
        const last = _tweens.pop();
        if (i < _tweens.length) _tweens[i] = last;
      }
    }
  };

  /* ------------------------------------------------------------------ timers (game-time) */
  const _timers = [];
  function makeTimer(sec, fn, repeat) {
    const h = { t: Math.max(0, +sec || 0), interval: Math.max(0.001, +sec || 0), fn: fn, repeat: repeat, done: false, cancel: function () { this.done = true; return this; } };
    _timers.push(h);
    return h;
  }
  G.timers = {
    after: function (sec, fn) { if (typeof fn !== 'function') return null; return makeTimer(sec, fn, false); },
    every: function (sec, fn) { if (typeof fn !== 'function') return null; return makeTimer(sec, fn, true); },
    cancel: function (h) { if (h && typeof h === 'object') h.done = true; },
    clear: function () { for (let i = 0; i < _timers.length; i++) _timers[i].done = true; _timers.length = 0; },
    get count() { return _timers.length; },
  };
  G.timersUpdate = function (dt) {
    dt = +dt || 0;
    const n = _timers.length;               // timers added by callbacks start ticking next update
    for (let i = 0; i < n; i++) {
      const h = _timers[i];
      if (h.done) continue;
      h.t -= dt;
      if (h.t > 0) continue;
      if (h.repeat) {
        h.t += h.interval;
        if (h.t < 0) h.t = h.interval;
        if (safeCall(h.fn, h) === false) h.done = true;
      } else {
        h.done = true;
        safeCall(h.fn, h);
      }
    }
    let w = 0;
    for (let i = 0; i < _timers.length; i++) { const h = _timers[i]; if (!h.done) _timers[w++] = h; }
    _timers.length = w;
  };

  /* ------------------------------------------------------------------ spatial hash */
  const CELL = 32, INV_CELL = 1 / CELL;
  const _cells = new Map();
  const _qbuf = [];
  function cellKey(cx, cz) { return ((cx & 0xffff) << 16) | (cz & 0xffff); }
  function tagEntity(ent) {
    if (!Object.prototype.hasOwnProperty.call(ent, '_sb')) {
      Object.defineProperty(ent, '_sb', { value: null, writable: true, enumerable: false, configurable: true });
      Object.defineProperty(ent, '_scx', { value: 0, writable: true, enumerable: false, configurable: true });
      Object.defineProperty(ent, '_scz', { value: 0, writable: true, enumerable: false, configurable: true });
    }
  }
  function bucketRemove(ent) {
    const b = ent._sb;
    if (!b) return;
    const i = b.indexOf(ent);
    if (i >= 0) { const last = b.pop(); if (i < b.length) b[i] = last; }
    ent._sb = null;
  }
  function bucketInsert(ent, cx, cz) {
    const k = cellKey(cx, cz);
    let b = _cells.get(k);
    if (!b) { b = []; _cells.set(k, b); }
    b.push(ent);
    ent._sb = b; ent._scx = cx; ent._scz = cz;
  }

  const Spatial = G.Spatial = {
    CELL: CELL,
    cells: _cells,
    count: 0,
    cellOf: function (x, z) { return cellKey(Math.floor(x * INV_CELL), Math.floor(z * INV_CELL)); },
    insert: function (ent) {
      if (!ent || !ent.pos) return false;
      tagEntity(ent);
      if (ent._sb) return Spatial.update(ent);
      bucketInsert(ent, Math.floor(ent.pos.x * INV_CELL), Math.floor(ent.pos.z * INV_CELL));
      Spatial.count++;
      return true;
    },
    remove: function (ent) {
      if (!ent || !ent._sb) return false;
      bucketRemove(ent);
      Spatial.count--;
      return true;
    },
    update: function (ent) {
      if (!ent || !ent.pos) return false;
      if (!ent._sb) return Spatial.insert(ent);
      const cx = Math.floor(ent.pos.x * INV_CELL), cz = Math.floor(ent.pos.z * INV_CELL);
      if (cx === ent._scx && cz === ent._scz) return true;
      bucketRemove(ent);
      bucketInsert(ent, cx, cz);
      return true;
    },
    query: function (x, z, radius, filterFn, out) {
      const res = out || _qbuf;
      res.length = 0;
      if (!(radius >= 0) || x !== x || z !== z) return res;
      const r2 = radius * radius;
      const cx0 = Math.floor((x - radius) * INV_CELL), cx1 = Math.floor((x + radius) * INV_CELL);
      const cz0 = Math.floor((z - radius) * INV_CELL), cz1 = Math.floor((z + radius) * INV_CELL);
      const span = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);
      if (span > _cells.size) {
        // Huge radius: cheaper to scan every bucket than the empty cell grid.
        for (const b of _cells.values()) {
          for (let i = 0; i < b.length; i++) {
            const e = b[i], dx = e.pos.x - x, dz = e.pos.z - z;
            if (dx * dx + dz * dz <= r2 && (!filterFn || filterFn(e))) res.push(e);
          }
        }
        return res;
      }
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const b = _cells.get(cellKey(cx, cz));
          if (!b) continue;
          for (let i = 0; i < b.length; i++) {
            const e = b[i], dx = e.pos.x - x, dz = e.pos.z - z;
            if (dx * dx + dz * dz <= r2 && (!filterFn || filterFn(e))) res.push(e);
          }
        }
      }
      return res;
    },
    nearest: function (x, z, radius, filterFn) {
      if (!(radius >= 0) || x !== x || z !== z) return null;
      let best = null, bestD = radius * radius;
      const cx0 = Math.floor((x - radius) * INV_CELL), cx1 = Math.floor((x + radius) * INV_CELL);
      const cz0 = Math.floor((z - radius) * INV_CELL), cz1 = Math.floor((z + radius) * INV_CELL);
      const span = (cx1 - cx0 + 1) * (cz1 - cz0 + 1);
      if (span > _cells.size) {
        for (const b of _cells.values()) {
          for (let i = 0; i < b.length; i++) {
            const e = b[i], dx = e.pos.x - x, dz = e.pos.z - z, d = dx * dx + dz * dz;
            if (d <= bestD && (!filterFn || filterFn(e))) { best = e; bestD = d; }
          }
        }
        return best;
      }
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cz = cz0; cz <= cz1; cz++) {
          const b = _cells.get(cellKey(cx, cz));
          if (!b) continue;
          for (let i = 0; i < b.length; i++) {
            const e = b[i], dx = e.pos.x - x, dz = e.pos.z - z, d = dx * dx + dz * dz;
            if (d <= bestD && (!filterFn || filterFn(e))) { best = e; bestD = d; }
          }
        }
      }
      return best;
    },
    clear: function () {
      for (const b of _cells.values()) { for (let i = 0; i < b.length; i++) b[i]._sb = null; b.length = 0; }
      _cells.clear();
      Spatial.count = 0;
    },
  };

  /* ------------------------------------------------------------------ entity registry helpers */
  G.addEntity = function (ent) {
    if (!ent || typeof ent !== 'object') return null;
    if (!ent.id) ent.id = G.uid(); else G.uidBump(ent.id);
    if (typeof THREE !== 'undefined') {
      if (!ent.pos) ent.pos = new THREE.Vector3();
      if (!ent.vel) ent.vel = new THREE.Vector3();
    }
    const st = G.state;
    if (st.byId[ent.id] === ent) { Spatial.update(ent); return ent; }
    if (st.byId[ent.id]) G.removeEntity(st.byId[ent.id]);
    st.entities.push(ent);
    st.byId[ent.id] = ent;
    if (ent.pos) Spatial.insert(ent);
    return ent;
  };
  G.removeEntity = function (entOrId) {
    const st = G.state;
    const ent = typeof entOrId === 'string' ? st.byId[entOrId] : entOrId;
    if (!ent) return false;
    Spatial.remove(ent);
    if (st.byId[ent.id] === ent) delete st.byId[ent.id];
    const i = st.entities.indexOf(ent);
    if (i >= 0) st.entities.splice(i, 1);
    return true;
  };
  G.getEntity = function (id) { return (id && G.state.byId[id]) || null; };

  /* ------------------------------------------------------------------ input */
  const KEY_NAMES = {
    Space: 'Space', Tab: 'Tab', Escape: 'Esc', Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Bksp', Delete: 'Del', Insert: 'Ins',
    Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    ShiftLeft: 'Shift', ShiftRight: 'RShift', ControlLeft: 'Ctrl', ControlRight: 'RCtrl', AltLeft: 'Alt', AltRight: 'RAlt',
    MetaLeft: 'Meta', MetaRight: 'Meta', CapsLock: 'Caps', NumLock: 'NumLock', ScrollLock: 'ScrLk', ContextMenu: 'Menu',
    PrintScreen: 'PrtSc', Pause: 'Pause', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    Semicolon: ';', Quote: "'", Backquote: '`', Comma: ',', Period: '.', Slash: '/', IntlBackslash: '\\',
    NumpadAdd: 'Num +', NumpadSubtract: 'Num -', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .',
    Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'M4', Mouse4: 'M5', Wheel: 'Wheel',
  };
  const NAME_CODES = Object.create(null);
  for (const code in KEY_NAMES) if (!NAME_CODES[KEY_NAMES[code]]) NAME_CODES[KEY_NAMES[code]] = code;
  NAME_CODES['Escape'] = 'Escape'; NAME_CODES['Esc'] = 'Escape'; NAME_CODES['Return'] = 'Enter'; NAME_CODES['Up'] = 'ArrowUp';
  NAME_CODES['Down'] = 'ArrowDown'; NAME_CODES['Left'] = 'ArrowLeft'; NAME_CODES['Right'] = 'ArrowRight';

  const DEFAULT_BOUND = [
    'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyQ', 'KeyR', 'KeyE', 'Tab', 'KeyI', 'KeyC', 'KeyK', 'KeyJ', 'KeyM', 'KeyP',
    'KeyH', 'KeyF', 'KeyB', 'Enter', 'Escape', 'F1', 'NumLock',
    'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0',
    'KeyG', 'KeyT', 'KeyV', 'KeyX', 'KeyY', 'KeyZ', 'KeyL', 'KeyN', 'KeyO', 'KeyU',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace',
  ];
  const BUTTON_BIT = [1, 4, 2, 8, 16];
  const SEQ_WINDOW_MS = 3000;
  const TEXT_INPUT_TYPES = { text: 1, password: 1, search: 1, number: 1, email: 1, url: 1, tel: 1, date: 1, time: 1, 'datetime-local': 1, month: 1, week: 1 };

  function isTypingEl(node) {
    if (!node || node === document.body || node === document.documentElement) return false;
    const tag = node.tagName;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') { const t = (node.getAttribute('type') || 'text').toLowerCase(); return !!TEXT_INPUT_TYPES[t]; }
    return !!node.isContentEditable;
  }

  function codeOfEvent(e) {
    if (e.code) return e.code;
    const k = e.key || '';
    if (k.length === 1) {
      if (/[a-z]/i.test(k)) return 'Key' + k.toUpperCase();
      if (/[0-9]/.test(k)) return 'Digit' + k;
      if (k === ' ') return 'Space';
    }
    return k;
  }

  const Input = G.Input = {
    canvas: null,
    keys: new Set(),
    typing: false,
    frame: 0,
    lockSupported: false,
    mouse: { x: 0, y: 0, nx: 0, ny: 0, dx: 0, dy: 0, wheel: 0, buttons: 0, locked: false, overCanvas: false },
    bound: new Set(DEFAULT_BOUND),
    _inited: false,
    _pressed: new Set(),      // key-down edges exposed through pressed() this frame (insertion order = arrival order)
    _queue: [],               // further edges that arrived before this frame ran (a second tap of the same key, or anything
                              // after it) — replayed one frame at a time so a slow frame never loses or merges taps
    _released: new Set(),
    _mPressed: 0,
    _mReleased: 0,
    _btnMask: 0,        // authoritative button mask kept from down/up (mousemove lies under pointer lock)
    _downOnCanvas: 0,
    _rmbDrag: false,
    _rmbMoved: false,
    _lastX: 0, _lastY: 0,
    _seqs: [], _seqBuf: '', _seqLast: 0, _seqMax: 0,

    init: function (canvas) {
      if (Input._inited) { if (canvas && canvas !== Input.canvas) attachCanvas(canvas); return Input; }
      Input._inited = true;
      window.addEventListener('keydown', onKeyDown, true);
      window.addEventListener('keyup', onKeyUp, true);
      window.addEventListener('blur', function () { Input.reset(); });
      document.addEventListener('visibilitychange', function () { if (document.hidden) Input.reset(); });
      document.addEventListener('focusin', onFocusChange, true);
      document.addEventListener('focusout', onFocusOut, true);
      document.addEventListener('mousedown', onMouseDown, true);
      document.addEventListener('mouseup', onMouseUp, true);
      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('contextmenu', onContextMenu, true);
      document.addEventListener('pointerlockchange', onLockChange);
      document.addEventListener('pointerlockerror', onLockError);
      if (canvas) attachCanvas(canvas);
      Input.typing = isTypingEl(document.activeElement);
      return Input;
    },

    down: function (code) { return Input.keys.has(code); },
    pressed: function (code) { return Input._pressed.has(code); },
    released: function (code) { return Input._released.has(code); },
    consume: function (code) {
      if (Input._pressed.delete(code)) { Input._released.delete(code); return true; }
      // not exposed yet: a DOM handler reacting to the same keydown (e.g. a context menu's Escape) may consume an edge
      // that is still waiting in the queue — drop the most recent one so it is not replayed later
      const q = Input._queue;
      for (let i = q.length - 1; i >= 0; i--) if (q[i] === code) { q.splice(i, 1); Input._released.delete(code); return true; }
      Input._released.delete(code);
      return false;
    },
    anyPressed: function () { return Input._pressed.size > 0; },
    /** Codes with a pending edge this frame, in arrival order, written into `out` (reused; no allocation when given). */
    pressedCodes: function (out) {
      out = out || [];
      out.length = 0;
      for (const c of Input._pressed) out.push(c);
      return out;
    },
    /** Number of edges still queued for later frames (taps that landed during one slow frame). */
    pendingEdges: function () { return Input._queue.length; },
    mouseDown: function (button) { return (Input.mouse.buttons & (BUTTON_BIT[button | 0] || 0)) !== 0; },
    mousePressed: function (button) { return (Input._mPressed & (1 << (button | 0))) !== 0; },
    mouseReleased: function (button) { return (Input._mReleased & (1 << (button | 0))) !== 0; },
    bind: function (code) { if (code) Input.bound.add(code); },
    unbind: function (code) { Input.bound.delete(code); },

    requestLock: function () {
      const c = Input.canvas;
      if (!c || Input.mouse.locked || !Input.lockSupported) return false;
      const plain = function () { try { const q = c.requestPointerLock(); if (q && typeof q.catch === 'function') q.catch(noop); } catch (_) { /* denied */ } };
      try {
        const p = c.requestPointerLock({ unadjustedMovement: true });
        if (p && typeof p.catch === 'function') p.catch(function (err) { if (err && err.name === 'NotSupportedError') plain(); });
      } catch (_) { plain(); }
      return true;
    },
    exitLock: function () {
      try { if (document.pointerLockElement) document.exitPointerLock(); } catch (_) { /* ignore */ }
      if (!document.pointerLockElement) Input.mouse.locked = false;
    },

    onSequence: function (seq, fn) {
      if (!seq || typeof fn !== 'function') return noop;
      const s = String(seq).toLowerCase().replace(/[^a-z]/g, '');
      if (!s) return noop;
      const rec = { seq: s, fn: fn };
      Input._seqs.push(rec);
      if (s.length > Input._seqMax) Input._seqMax = s.length;
      return function () { const i = Input._seqs.indexOf(rec); if (i >= 0) Input._seqs.splice(i, 1); };
    },

    keyName: function (code) {
      if (!code) return '';
      code = String(code);
      const n = KEY_NAMES[code];
      if (n) return n;
      if (code.length === 4 && code.indexOf('Key') === 0) return code.charAt(3);
      if (code.length === 6 && code.indexOf('Digit') === 0) return code.charAt(5);
      if (code.indexOf('Numpad') === 0) return 'Num ' + code.slice(6);
      return code;
    },
    codeOf: function (label) {
      if (!label) return '';
      label = String(label);
      if (label.length === 1) {
        if (/[a-z]/i.test(label)) return 'Key' + label.toUpperCase();
        if (/[0-9]/.test(label)) return 'Digit' + label;
        if (label === ' ') return 'Space';
      }
      if (NAME_CODES[label]) return NAME_CODES[label];
      if (/^F\d{1,2}$/.test(label)) return label;
      if (/^Num ?(\d)$/.test(label)) return 'Numpad' + label.slice(-1);
      return label;
    },

    beginFrame: function () {
      Input.frame++;
      Input.typing = isTypingEl(document.activeElement);
      drainQueue();
      return Input;
    },
    endFrame: function () {
      const m = Input.mouse;
      m.dx = 0; m.dy = 0; m.wheel = 0;
      Input._pressed.clear();
      Input._released.clear();
      Input._mPressed = 0; Input._mReleased = 0;
      drainQueue();                       // expose the next batch of queued taps to the coming frame
      return Input;
    },
    reset: function () {
      Input.keys.clear();
      Input._pressed.clear();
      Input._queue.length = 0;
      Input._released.clear();
      Input._mPressed = 0; Input._mReleased = 0; Input._downOnCanvas = 0; Input._btnMask = 0; Input.mouse.buttons = 0;
      Input._rmbDrag = false; Input._rmbMoved = false;
      const m = Input.mouse;
      m.buttons = 0; m.dx = 0; m.dy = 0; m.wheel = 0;
      Input._seqBuf = '';
      return Input;
    },
  };

  function noop() {}

  function attachCanvas(canvas) {
    Input.canvas = canvas;
    Input.lockSupported = !!(canvas.requestPointerLock && 'pointerLockElement' in document);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
  }

  function shouldPrevent(e, code) {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    return code === 'Tab' || code === 'Space' || Input.bound.has(code);
  }

  function feedSequence(ch) {
    if (!Input._seqs.length) return;
    const now = performance.now();
    if (now - Input._seqLast > SEQ_WINDOW_MS) Input._seqBuf = '';
    Input._seqLast = now;
    let buf = Input._seqBuf + ch;
    if (buf.length > Input._seqMax) buf = buf.slice(buf.length - Input._seqMax);
    Input._seqBuf = buf;
    for (let i = 0; i < Input._seqs.length; i++) {
      const s = Input._seqs[i];
      if (buf.length >= s.seq.length && buf.lastIndexOf(s.seq) === buf.length - s.seq.length) {
        Input._seqBuf = '';
        safeCall(s.fn, s.seq);
      }
    }
  }

  const QUEUE_MAX = 32;
  /** Record a key-down edge. pressed(code) reports each code at most once per frame; a repeat tap of a code that is
   *  already exposed — and every edge after it, to keep arrival order — waits in the queue for the following frames.
   *  So a key that went down and up between two frames (low FPS, headless GL) still counts for exactly one frame. */
  function queueEdge(code) {
    if (Input._queue.length || Input._pressed.has(code)) {
      if (Input._queue.length >= QUEUE_MAX) Input._queue.shift();
      Input._queue.push(code);
    } else Input._pressed.add(code);
  }
  /** Move queued edges into the exposed set, in order, stopping at the first code already exposed this frame. */
  function drainQueue() {
    const q = Input._queue;
    while (q.length && !Input._pressed.has(q[0])) Input._pressed.add(q.shift());
  }

  function onKeyDown(e) {
    // Decide from the live DOM, never from the cached flag: a stale `typing` (a text field removed without focusout)
    // must not swallow the keys of a player who is back on the canvas.
    if (isTypingEl(e.target) || isTypingEl(document.activeElement)) { Input.typing = true; return; }
    Input.typing = false;
    const code = codeOfEvent(e);
    if (!code) return;
    if (code.length === 4 && code.charCodeAt(0) === 75 && code.charCodeAt(1) === 101 && code.charCodeAt(2) === 121) feedSequence(code.charAt(3).toLowerCase());
    if (!e.repeat && !Input.keys.has(code)) queueEdge(code);
    Input.keys.add(code);
    if (shouldPrevent(e, code)) e.preventDefault();
  }
  function onKeyUp(e) {
    const code = codeOfEvent(e);
    if (!code) return;
    if (Input.keys.delete(code)) Input._released.add(code);
    if (!Input.typing && !isTypingEl(e.target) && shouldPrevent(e, code)) e.preventDefault();
  }
  function onFocusChange(e) {
    const t = isTypingEl(e.target);
    // Held keys must not keep steering while a text field has focus. Pending edges are kept: they were tapped while
    // the canvas still had focus (e.g. Escape right after the Enter that opened the chat, in one slow frame) and the
    // HUD replays them in order — feeding those that landed after the focus change to the chat instead.
    if (t && !Input.typing) { Input.keys.clear(); Input._seqBuf = ''; }
    Input.typing = t;
  }
  function onFocusOut() {
    Input.typing = false;
  }
  function onMouseDown(e) {
    const m = Input.mouse;
    const onCanvas = !!Input.canvas && e.target === Input.canvas;
    Input._btnMask |= 1 << (e.button | 0);
    m.buttons = e.buttons || Input._btnMask;
    m.overCanvas = onCanvas;
    Input._lastX = e.clientX; Input._lastY = e.clientY;
    if (onCanvas) {
      const bit = 1 << (e.button | 0);
      Input._mPressed |= bit;
      Input._downOnCanvas |= bit;
      if (e.button === 2) { Input._rmbDrag = true; Input._rmbMoved = false; }
      if (document.activeElement !== Input.canvas) { try { Input.canvas.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
    }
  }
  function onMouseUp(e) {
    const m = Input.mouse;
    Input._btnMask &= ~(1 << (e.button | 0));
    m.buttons = Input._btnMask;
    const bit = 1 << (e.button | 0);
    if (Input._downOnCanvas & bit) { Input._mReleased |= bit; Input._downOnCanvas &= ~bit; }
    if (e.button === 2) Input._rmbDrag = false;
  }
  function onMouseMove(e) {
    const m = Input.mouse;
    m.x = e.clientX; m.y = e.clientY;
    const c = Input.canvas;
    const w = (c && c.clientWidth) || window.innerWidth || 1, h = (c && c.clientHeight) || window.innerHeight || 1;
    m.nx = (m.x / w) * 2 - 1; m.ny = -(m.y / h) * 2 + 1;
    m.overCanvas = !!c && e.target === c;
    // Under pointer lock Chromium reports buttons:0 on mousemove even while a button is held,
    // so only an unlocked move (or a non-zero mask) may update the held-button state.
    if (!m.locked || e.buttons) { Input._btnMask = e.buttons; m.buttons = e.buttons; }
    if (m.locked) {
      m.dx += e.movementX || 0; m.dy += e.movementY || 0;
    } else if (Input._rmbDrag) {
      if (e.buttons & 2) {
        const dx = e.clientX - Input._lastX, dy = e.clientY - Input._lastY;
        m.dx += dx; m.dy += dy;
        if (dx * dx + dy * dy > 4) Input._rmbMoved = true;
      } else Input._rmbDrag = false;
    }
    Input._lastX = e.clientX; Input._lastY = e.clientY;
  }
  function onWheel(e) {
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 16; else if (e.deltaMode === 2) d *= 400;
    Input.mouse.wheel += d;
    e.preventDefault();
  }
  function onContextMenu(e) {
    if ((Input.canvas && e.target === Input.canvas) || Input._rmbMoved || Input.mouse.locked) { e.preventDefault(); Input._rmbMoved = false; }
  }
  function onLockChange() {
    const locked = !!Input.canvas && document.pointerLockElement === Input.canvas;
    if (locked === Input.mouse.locked) return;
    Input.mouse.locked = locked;
    Input.mouse.dx = 0; Input.mouse.dy = 0;
    Input._rmbDrag = false;
    G.emit('pointerLock', locked);
  }
  function onLockError() {
    Input.mouse.locked = false;
  }

  G.log('core ready', G.VERSION);
})();
