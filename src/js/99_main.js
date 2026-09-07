/* ==== 99_main.js — G.Game + window.__T: the integrator. Creates the renderer / scene / camera, runs the progressive
   boot (every engine and gameplay system in the order the integration notes require, yielding to the browser between
   steps so the loading bar animates), owns the game flow (loading → menu → character creation → playing → menu), the
   main loop in exactly the SPEC §8 order, adaptive graphics quality, window resize, zone music restoration and the
   headless test hooks the smoke / play harnesses drive.

   Public API (G.Game):
     boot() → Promise            idempotent; runs on DOMContentLoaded (or at once when the DOM is already parsed)
     readyPromise                resolves when the boot has finished (with or without failed optional systems)
     booted, version, renderer, scene, camera, canvas, timings ([{name, ms}], .total), loadPct
     progress(pct, text)         forwards to G.UI.Menu.progress (falls back to writing into #loading)
     startNew(spec) → player     hides menus, creates the hero, inits quests, snaps the camera, shows the HUD, music, gameStart
     startFromSave() → bool      G.Save.load → Player.create(charSpec) → Quests.init → Save.apply → … → gameStart
     toMenu(), toCharCreate(), restart()      tear the session down (save first for toMenu) and change phase
     zoneMusic(force?)           G.Audio.music(zone theme | 'tavern' inside inns) + G.Audio.ambient(biome, G.Sky.phase);
                                 re-run on zoneChanged / dayPhase / musicEnded / enter & leave buildings (skipped in combat & while sailing)
     togglePause(), setPaused(bool), paused
     fps (EMA), frameMs (EMA wall ms per frame), jsMs (EMA JS ms per frame), drawCalls, triangles (last rendered frame)
     autoQuality (bool — true while G.state.settings.quality is 'auto'; assignable), stepQuality(dir) (manual −1 / +1)
     sessions, startedAt (G.time.now of the current session), lastSpec
   Events emitted: bootStep({name, pct, ms}), booted, gameEnd (before a session is torn down), qualityAuto(q).
   Test hooks (window.__T): ready, inGame, errors (= G.errors), G, quickStart(opts) → Promise<player>, stats(),
     press(code, holdMs?) → Promise, teleport(x, z) → pos, setTime(hours), screenshotReady(), waitFrames(n) → Promise,
     timings, game (= G.Game).
   Every cross-module call is guarded; a system that throws inside the loop is reported through G.reportError at most
   once per 5 s per system and the loop keeps running. console.error is mirrored into G.errors (once, at load) so the
   smoke test sees library errors too. ==== */
(function () {
  'use strict';
  const G = window.G;
  const THREE = window.THREE;
  if (!G) return;

  // ------------------------------------------------------------------------------------------------ helpers
  function has(obj, fn) { return !!obj && typeof obj[fn] === 'function'; }
  function num(v, d) { return (typeof v === 'number' && v === v) ? v : d; }
  function report(e, where) { if (has(G, 'reportError')) G.reportError(e, where); else if (typeof console !== 'undefined') console.warn(where, e); }
  function warn(msg) { if (has(G, 'warn')) G.warn(msg); else console.warn(msg); }
  function log() { if (has(G, 'log')) G.log.apply(G, arguments); }
  function emit(evt, a, b) { if (has(G, 'emit')) G.emit(evt, a, b); }
  function notify(text, kind) { if (G.UI && has(G.UI, 'notify')) { try { G.UI.notify(text, kind || 'system'); } catch (e) { /* cosmetic */ } } }
  function title(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function byId(id) { return document.getElementById(id); }
  function nowMs() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }
  function zoneData(id) {
    const W = G.Data && G.Data.world;
    if (!W || !id) return null;
    if (W.zoneById && W.zoneById[id]) return W.zoneById[id];
    if (Array.isArray(W.zones)) for (let i = 0; i < W.zones.length; i++) if (W.zones[i] && W.zones[i].id === id) return W.zones[i];
    return null;
  }

  // ------------------------------------------------------------------------------------------------ console.error mirror (once)
  (function mirrorConsoleError() {
    if (typeof console === 'undefined' || console.__cjMirrored) return;
    const orig = console.error;
    console.__cjMirrored = true;
    console.error = function () {
      try {
        const parts = [];
        for (let i = 0; i < arguments.length; i++) {
          const a = arguments[i];
          parts.push(typeof a === 'string' ? a : (a && typeof a === 'object' && a.message) ? (a.name ? a.name + ': ' : '') + a.message : String(a));
        }
        const text = '[console.error] ' + parts.join(' ').slice(0, 600);
        if (Array.isArray(G.errors)) { if (G.errors.length < 200) G.errors.push(text); else G.errorsDropped = (G.errorsDropped | 0) + 1; }
      } catch (_) { /* never break logging */ }
      return typeof orig === 'function' ? orig.apply(console, arguments) : undefined;
    };
  })();

  // ------------------------------------------------------------------------------------------------ state
  let resolveReady = null;
  const Game = G.Game = {
    version: G.VERSION || '1.0.0',
    renderer: null, scene: null, camera: null, canvas: null,
    booted: false, booting: false, loadPct: 0,
    readyPromise: null,
    timings: [],
    fps: 0, frameMs: 0, jsMs: 0, drawCalls: 0, triangles: 0,
    sessions: 0, startedAt: 0, startedWall: 0, lastSpec: null,
    lastAutoQuality: null,
  };
  Game.readyPromise = new Promise(function (res) { resolveReady = res; });
  Game.timings.total = 0;

  const T = window.__T = {
    ready: false, inGame: false, errors: G.errors, G: G, game: Game, timings: Game.timings,
  };

  let renderer = null, scene = null, camera = null, canvas = null;
  let rafId = 0, loopRunning = false, lastT = 0, frames = 0, framesSinceChange = 0;
  const loopErrAt = Object.create(null);
  const waiters = [];
  const _origin = new THREE.Vector3(0, 0, 0);

  function loopError(name, e) {
    const t = nowMs();
    const last = loopErrAt[name];
    if (last !== undefined && t - last < 5000) return;
    loopErrAt[name] = t;
    report(e, 'loop:' + name);
  }
  // Method call with error isolation; no allocation (fixed arity).
  function run(name, obj, method, a, b) {
    if (!obj) return;
    const fn = obj[method];
    if (typeof fn !== 'function') return;
    try { fn.call(obj, a, b); } catch (e) { loopError(name, e); }
  }

  // ------------------------------------------------------------------------------------------------ progress / loading screen
  function progress(pct, text) {
    pct = Math.max(0, Math.min(100, num(pct, Game.loadPct)));
    Game.loadPct = pct;
    if (G.UI && G.UI.Menu && has(G.UI.Menu, 'progress')) {
      try { G.UI.Menu.progress(pct, text); return; } catch (e) { report(e, 'Game.progress'); }
    }
    const L = byId('loading');
    if (L) {
      let bar = L.querySelector('.cj-fallback-bar');
      if (!bar) {
        L.textContent = '';
        L.style.cssText = 'position:fixed;inset:0;background:#0b0f16;color:#e8dcb5;font:16px/1.5 Georgia,serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;z-index:50';
        L.appendChild(document.createElement('div')).className = 'cj-fallback-title';
        L.querySelector('.cj-fallback-title').textContent = "Chris Jensen's Lord of the Rings Online";
        bar = document.createElement('div'); bar.className = 'cj-fallback-bar';
        bar.style.cssText = 'width:320px;height:6px;background:#222a36;border-radius:3px;overflow:hidden';
        const fill = document.createElement('div'); fill.className = 'cj-fallback-fill'; fill.style.cssText = 'height:100%;width:0%;background:#d5b35a';
        bar.appendChild(fill); L.appendChild(bar);
        const st = document.createElement('div'); st.className = 'cj-fallback-status'; L.appendChild(st);
      }
      const fill = L.querySelector('.cj-fallback-fill'); if (fill) fill.style.width = pct.toFixed(0) + '%';
      const st = L.querySelector('.cj-fallback-status'); if (st) st.textContent = Math.round(pct) + '%' + (text ? ' · ' + text : '');
      if (pct >= 100 && !L.__cjClick) { L.__cjClick = true; if (st) st.textContent += ' — click to begin'; L.addEventListener('click', function () { L.hidden = true; }); }
    }
  }
  Game.progress = progress;

  function hideMenus() {
    try {
      const L = byId('loading'); if (L && !L.hidden) L.hidden = true;
      if (G.UI && G.UI.Menu && G.UI.Menu.visible && has(G.UI.Menu, 'hide')) G.UI.Menu.hide();
      if (G.UI && G.UI.CharCreate && G.UI.CharCreate.visible && has(G.UI.CharCreate, 'hide')) G.UI.CharCreate.hide();
      const M = byId('mainMenu'); if (M && !M.hidden) M.hidden = true;
      const C = byId('charCreate'); if (C && !C.hidden) C.hidden = true;
    } catch (e) { report(e, 'Game.hideMenus'); }
  }

  // ------------------------------------------------------------------------------------------------ boot
  function nextTick() {
    return new Promise(function (resolve) {
      let done = false;
      const fin = function () { if (!done) { done = true; resolve(); } };
      try { requestAnimationFrame(function () { setTimeout(fin, 0); }); } catch (_) { /* no rAF */ }
      setTimeout(fin, 120);   // hidden tab: rAF never fires
    });
  }

  function createRenderer() {
    canvas = byId('game');
    if (!canvas) { canvas = document.createElement('canvas'); canvas.id = 'game'; canvas.tabIndex = 0; document.body.insertBefore(canvas, document.body.firstChild); }
    Game.canvas = canvas;
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, powerPreference: 'high-performance', alpha: false, stencil: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(window.innerWidth || 1280, window.innerHeight || 720, false);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.autoClear = true;
    renderer.info.autoReset = false;
    renderer.setClearColor(0x0b1020, 1);
    Game.renderer = renderer;

    scene = new THREE.Scene();
    scene.name = 'middleEarth';
    scene.background = new THREE.Color(0x0b1020);
    Game.scene = scene;

    if (G.Player && G.Player.camera && G.Player.camera.isCamera) camera = G.Player.camera;
    else { camera = new THREE.PerspectiveCamera(60, (window.innerWidth || 1280) / (window.innerHeight || 720), 0.1, 2500); if (G.Player) G.Player.camera = camera; }
    camera.aspect = (window.innerWidth || 1280) / Math.max(1, window.innerHeight || 720);
    camera.updateProjectionMatrix();
    Game.camera = camera;
  }

  async function step(name, pct, text, fn) {
    progress(pct, text);
    await nextTick();
    const t0 = nowMs();
    try { await fn(); } catch (e) { report(e, 'boot:' + name); }
    const ms = nowMs() - t0;
    Game.timings.push({ name: name, ms: Math.round(ms * 10) / 10 });
    emit('bootStep', { name: name, pct: pct, ms: ms });
  }

  async function boot() {
    if (Game.booting || Game.booted) return Game.readyPromise;
    Game.booting = true;
    const bootT0 = nowMs();
    G.state.phase = 'loading';
    progress(2, 'Lighting the lamps');

    // core engine objects — nothing else can run without them
    let ok = true;
    try { createRenderer(); }
    catch (e) {
      ok = false;
      report(e, 'boot:renderer');
      progress(100, 'WebGL is not available in this browser — the world cannot be drawn');
    }
    if (ok) {
      try { if (G.Input && has(G.Input, 'init')) G.Input.init(canvas); } catch (e) { report(e, 'boot:input'); }
      try { if (G.Player && has(G.Player, 'setScene')) G.Player.setScene(scene); } catch (e) { report(e, 'boot:player.setScene'); }
      const tInit = nowMs();
      try { G.emit('init'); } catch (e) { report(e, 'boot:init'); }
      Game.timings.push({ name: 'init', ms: Math.round((nowMs() - tInit) * 10) / 10 });
      const W = G.Data && G.Data.world;

      await step('terrain.init', 6, 'Shaping the land', function () { if (G.Terrain) G.Terrain.init(); });
      await step('terrain.build', 10, 'Raising hills and carving rivers', function () {
        if (G.Terrain) G.Terrain.build(scene);
        G.emit('sceneReady', scene);
      });
      await step('sky', 15, 'Painting the sky', function () { if (G.Sky) G.Sky.init(scene, renderer); });
      await step('physics', 18, 'Laying foundations', function () { if (G.Physics) G.Physics.init(); });
      await step('fx', 21, 'Kindling the hearth-fires', function () { if (G.FX) G.FX.init(scene); });
      await step('vegetation', 26, 'Planting the forests of Eriador', function () { if (G.Veg) G.Veg.build(scene); });
      // towns / points of interest / docks — one town per tick so the bar creeps along instead of freezing
      await step('buildings', 30, 'Raising the towns', async function () {
        if (!G.Buildings) return;
        G.Buildings.init(scene);
        const towns = (W && Array.isArray(W.towns)) ? W.towns : [];
        const pois = (W && Array.isArray(W.pois)) ? W.pois : [];
        const docks = (W && Array.isArray(W.docks)) ? W.docks : [];
        if (has(G.Buildings, 'buildTown') && has(G.Buildings, 'buildPOI') && has(G.Buildings, 'buildDocks')) {
          let n = 0;
          for (let i = 0; i < towns.length; i++) {
            const t = towns[i];
            try { n += (G.Buildings.buildTown(t) || []).length; } catch (e) { report(e, 'boot:buildTown ' + (t && t.id)); }
            progress(30 + 20 * (i + 1) / Math.max(1, towns.length), 'Raising ' + ((t && t.name) || 'a town'));
            await nextTick();
          }
          for (let i = 0; i < pois.length; i++) {
            const p = pois[i];
            try { n += (G.Buildings.buildPOI(p) || []).length; } catch (e) { report(e, 'boot:buildPOI ' + (p && p.id)); }
            if ((i & 7) === 7) { progress(50 + 6 * (i + 1) / Math.max(1, pois.length), 'Uncovering ancient ruins'); await nextTick(); }
          }
          try { n += (G.Buildings.buildDocks(docks) || []).length; } catch (e) { report(e, 'boot:buildDocks'); }
          log('[Game] buildings placed:', n);
        } else if (has(G.Buildings, 'build')) G.Buildings.build();
      });
      await step('npcs', 58, 'Waking the folk of Eriador', function () { if (G.NPCs) G.NPCs.init(); if (G.NPCs && has(G.NPCs, 'setScene')) G.NPCs.setScene(scene); });
      await step('monsters', 63, 'Stirring the wild things', function () { if (G.Monsters) G.Monsters.init(scene); });
      await step('boats', 67, 'Mooring the boats', function () {
        if (G.Fishing && has(G.Fishing, 'init')) G.Fishing.init();
        if (G.Boats) G.Boats.init(scene);
      });
      await step('aiplayers', 72, 'Summoning fellow adventurers', function () { if (G.AIPlayers) G.AIPlayers.init(scene); });
      await step('postfx', 78, 'Polishing the lens', function () { if (G.PostFX) G.PostFX.init(renderer, scene, camera); });
      await step('ui', 83, 'Preparing the interface', function () {
        if (G.UI && has(G.UI, 'init')) G.UI.init();
        if (G.UI && has(G.UI, 'showHUD')) G.UI.showHUD(false);
        if (G.UI && G.UI.Admin && has(G.UI.Admin, 'init')) G.UI.Admin.init();
      });
      await step('warmup', 88, 'Walking the roads to Hobbiton', function () {
        if (G.Terrain && has(G.Terrain, 'warmup')) G.Terrain.warmup(-1085, -120, 320);
        if (G.Sky && has(G.Sky, 'update')) G.Sky.update(0, camera.position);
      });
      await step('map', 94, 'Charting the map of Eriador', function () { if (G.Terrain && has(G.Terrain, 'mapCanvas')) G.Terrain.mapCanvas(1024); });
      await step('shaders', 97, 'Tempering the light', function () {
        // one throw-away frame so every material's program is compiled before the menu fades in
        if (has(renderer, 'compile')) { try { renderer.compile(scene, camera); } catch (e) { /* optional */ } }
      });
      doResize();
    }

    Game.timings.total = Math.round(nowMs() - bootT0);
    Game.booted = true; Game.booting = false;
    G.state.phase = 'menu';
    progress(100, 'Middle-earth awaits');
    startLoop();
    T.ready = true;
    emit('booted');
    if (resolveReady) { resolveReady(Game); resolveReady = null; }
    try { if (G.UI && G.UI.Menu && has(G.UI.Menu, 'show')) G.UI.Menu.show(); } catch (e) { report(e, 'boot:menu.show'); }
    let summary = '[Game] boot ' + Game.timings.total + ' ms:';
    for (let i = 0; i < Game.timings.length; i++) summary += ' ' + Game.timings[i].name + ' ' + Math.round(Game.timings[i].ms);
    log(summary);
    return Game;
  }
  Game.boot = boot;

  // ------------------------------------------------------------------------------------------------ main loop
  function playerPos() {
    const p = G.state.player;
    if (p && p.pos) return p.pos;
    return camera ? camera.position : _origin;
  }
  function menuCamera() {
    if (G.UI && G.UI.Menu && has(G.UI.Menu, 'getCamera')) { try { const c = G.UI.Menu.getCamera(); if (c && c.isCamera) return c; } catch (e) { /* fall back */ } }
    return camera;
  }
  function menuDrivesWorld() {
    const M = G.UI && G.UI.Menu;
    if (!M || !M.driveWorld) return false;
    return !!(M.visible || (G.UI.CharCreate && G.UI.CharCreate.visible));
  }

  function updatePlaying(dt) {
    run('Player', G.Player, 'update', dt);
    run('Combat', G.Combat, 'update', dt);
    run('Monsters', G.Monsters, 'update', dt);
    run('NPCs', G.NPCs, 'update', dt);
    run('AIPlayers', G.AIPlayers, 'update', dt);
    run('Fishing', G.Fishing, 'update', dt);
    run('Boats', G.Boats, 'update', dt);
    run('Quests', G.Quests, 'update', dt);
    run('AutoQuest', G.AutoQuest, 'update', dt);
    const pos = playerPos();
    run('Terrain', G.Terrain, 'update', pos, dt);
    run('Veg', G.Veg, 'update', pos, dt);
    run('Buildings', G.Buildings, 'update', pos, dt);
    run('Sky', G.Sky, 'update', dt, pos);
    run('FX', G.FX, 'update', dt, camera);
    G.emit('update', dt);
    run('UI', G.UI, 'update', dt);
    run('Audio', G.Audio, 'update', dt);
  }

  function updateMenu(dt) {
    const cam = menuCamera();
    run('Menu', G.UI && G.UI.Menu, 'update', dt);
    if (!menuDrivesWorld()) {
      const pos = cam ? cam.position : _origin;
      run('Terrain', G.Terrain, 'update', pos, dt);
      run('Veg', G.Veg, 'update', pos, dt);
      run('Buildings', G.Buildings, 'update', pos, dt);
      run('Sky', G.Sky, 'update', dt, pos);
    }
    run('NPCs', G.NPCs, 'update', dt);        // villagers wander through the menu vista
    run('FX', G.FX, 'update', dt, cam);
    G.emit('update', dt);
    run('UI', G.UI, 'update', dt);
    run('Audio', G.Audio, 'update', dt);
  }

  function render(cam) {
    if (!renderer || !scene || !cam) return;
    renderer.info.reset();
    if (G.PostFX && has(G.PostFX, 'render') && G.PostFX.ready && G.PostFX.enabled && !G.PostFX.failed) {
      try { G.PostFX.render(scene, cam); }
      catch (e) { loopError('PostFX', e); try { renderer.render(scene, cam); } catch (e2) { loopError('render', e2); } }
    } else {
      try { renderer.render(scene, cam); } catch (e) { loopError('render', e); }
    }
    const info = renderer.info.render;
    Game.drawCalls = info.calls; Game.triangles = info.triangles;
  }

  function frame() {
    rafId = requestAnimationFrame(frame);
    const t0 = nowMs();
    let raw = (t0 - lastT) / 1000;
    lastT = t0;
    if (!(raw >= 0)) raw = 0;
    if (raw > 0.05) raw = 0.05;
    if (raw > 0) {
      const f = 1 / raw;
      Game.fps = Game.fps > 0 ? Game.fps + (f - Game.fps) * 0.1 : f;
      Game.frameMs = Game.frameMs > 0 ? Game.frameMs + (raw * 1000 - Game.frameMs) * 0.1 : raw * 1000;
    }
    if (document.hidden) { if (G.Input && has(G.Input, 'endFrame')) G.Input.endFrame(); return; }

    const scale = (G.time.scale > 0) ? G.time.scale : 0;
    const dt = raw * scale;
    G.time.dt = dt; G.time.now += dt; G.time.frame++;
    frames++; framesSinceChange++;

    if (G.Input && has(G.Input, 'beginFrame')) G.Input.beginFrame();
    try { if (has(G, 'tweenUpdate')) G.tweenUpdate(dt); } catch (e) { loopError('tween', e); }
    try { if (has(G, 'timersUpdate')) G.timersUpdate(dt); } catch (e) { loopError('timers', e); }

    const phase = G.state.phase;
    let cam = camera;
    if (phase === 'playing') {
      if (G.time.paused) { run('UI', G.UI, 'update', dt); run('FX', G.FX, 'update', 0, camera); }
      else updatePlaying(dt);
    } else {
      cam = menuCamera();
      updateMenu(dt);
    }
    tuneQuality(t0);
    render(cam);
    if (G.Input && has(G.Input, 'endFrame')) G.Input.endFrame();

    const js = nowMs() - t0;
    Game.jsMs = Game.jsMs > 0 ? Game.jsMs + (js - Game.jsMs) * 0.1 : js;
    if (waiters.length) {
      for (let i = waiters.length - 1; i >= 0; i--) if (frames >= waiters[i].at) { const w = waiters[i]; waiters.splice(i, 1); try { w.resolve(frames); } catch (_) { /* test code */ } }
    }
  }
  function startLoop() {
    if (loopRunning || !renderer) return;
    loopRunning = true;
    lastT = nowMs();
    rafId = requestAnimationFrame(frame);
  }
  function stopLoop() { if (rafId) cancelAnimationFrame(rafId); rafId = 0; loopRunning = false; }
  Game.startLoop = startLoop;
  Game.stopLoop = stopLoop;
  document.addEventListener('visibilitychange', function () { if (!document.hidden) lastT = nowMs(); });

  // ------------------------------------------------------------------------------------------------ pause
  function setPaused(v) {
    v = !!v;
    if (G.time.paused === v) return v;
    G.time.paused = v;
    if (G.state.phase === 'playing') notify(v ? 'Game paused' : 'Game resumed', 'system');
    emit(v ? 'gamePaused' : 'gameResumed');
    return v;
  }
  Game.setPaused = setPaused;
  Game.togglePause = function () { return setPaused(!G.time.paused); };
  Object.defineProperty(Game, 'paused', { get: function () { return !!G.time.paused; }, set: function (v) { setPaused(v); }, enumerable: true });

  // ------------------------------------------------------------------------------------------------ resize
  let resizeTimer = 0;
  function doResize() {
    if (!renderer) return;
    const w = Math.max(1, window.innerWidth || 1), h = Math.max(1, window.innerHeight || 1);
    try {
      if (G.PostFX && has(G.PostFX, 'resize') && G.PostFX.ready) G.PostFX.resize(w, h);
      else renderer.setSize(w, h, false);
    } catch (e) { report(e, 'Game.resize'); }
    try {
      if (G.Player && has(G.Player, 'resize')) G.Player.resize(w, h);
      if (camera && camera !== (G.Player && G.Player.camera)) { camera.aspect = w / h; camera.updateProjectionMatrix(); }
    } catch (e) { report(e, 'Game.resize.camera'); }
    try { if (G.UI && has(G.UI, 'reflow')) G.UI.reflow(w, h); } catch (e) { report(e, 'Game.resize.ui'); }
    framesSinceChange = 0;
  }
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () { resizeTimer = 0; doResize(); }, 100);
  });
  Game.resize = doResize;

  // ------------------------------------------------------------------------------------------------ music
  function insideInn() {
    const B = G.Buildings;
    if (!B) return false;
    let b = B.playerInside;
    if (!b && has(B, 'isInside') && G.state.player) { try { b = B.isInside(G.state.player.pos); } catch (e) { b = null; } }
    if (!b) return false;
    const r = b.recipe || (b.spec && b.spec.recipe) || (b.data && b.data.recipe) || '';
    return r === 'inn';
  }
  function zoneMusic(force) {
    const A = G.Audio;
    if (!A) return null;
    if (G.state.phase !== 'playing') return null;
    if (!force) {
      if (G.state.inCombat) return null;
      if (G.Boats && (G.Boats.travelling || G.Boats.sailing)) return null;
      const p = G.state.player; if (p && (p.dead || p.alive === false)) return null;
    }
    const z = zoneData(G.state.zone);
    let theme = (z && z.music) ? z.music : 'shire';
    if (insideInn() && (!has(A, 'hasTheme') || A.hasTheme('tavern'))) theme = 'tavern';
    try { if (has(A, 'music') && (!has(A, 'hasTheme') || A.hasTheme(theme))) A.music(theme); } catch (e) { report(e, 'Game.zoneMusic'); }
    try { if (has(A, 'ambient')) A.ambient((z && z.biome) || 'shire', (G.Sky && G.Sky.phase) || 'day'); } catch (e) { report(e, 'Game.ambient'); }
    return theme;
  }
  Game.zoneMusic = zoneMusic;

  // ------------------------------------------------------------------------------------------------ quality auto-tune
  const Q_ORDER = ['low', 'medium', 'high', 'ultra'];
  const QT = { winStart: 0, frames: 0, goodSince: -1, lastChange: 0, downCount: { low: 0, medium: 0, high: 0, ultra: 0 } };
  function autoEnabled() {
    const s = G.state.settings;
    return !s || s.quality == null || s.quality === 'auto';
  }
  Object.defineProperty(Game, 'autoQuality', {
    get: autoEnabled,
    set: function (v) { const s = G.state.settings || (G.state.settings = {}); s.quality = v ? 'auto' : (G.state.quality || 'high'); },
    enumerable: true,
  });
  function qIndex(q) { const i = Q_ORDER.indexOf(String(q || '').toLowerCase()); return i < 0 ? 2 : i; }
  function applyQuality(q, dir, silent) {
    let applied = q;
    if (G.PostFX && has(G.PostFX, 'setQuality')) { try { applied = G.PostFX.setQuality(q) || q; } catch (e) { report(e, 'Game.setQuality'); return null; } }
    else G.state.quality = q;
    Game.lastAutoQuality = applied;
    QT.lastChange = nowMs();
    QT.winStart = nowMs(); QT.frames = 0; QT.goodSince = -1;
    framesSinceChange = 0;
    if (!silent) notify('Graphics quality ' + (dir === 'down' ? 'lowered' : 'raised') + ' to ' + title(applied) + ' (auto)', 'system');
    emit('qualityAuto', applied);
    return applied;
  }
  function tuneQuality(tNow) {
    if (G.state.phase !== 'playing' || !Game.booted || G.time.paused || document.hidden || !autoEnabled()) { QT.winStart = tNow; QT.frames = 0; QT.goodSince = -1; return; }
    if (tNow - Game.startedWall < 5000) { QT.winStart = tNow; QT.frames = 0; return; }   // wall clock: game time crawls on a slow GPU
    if (!QT.winStart) { QT.winStart = tNow; QT.frames = 0; return; }
    QT.frames++;
    const span = tNow - QT.winStart;
    if (span < 3000) return;
    const fps = QT.frames * 1000 / span;
    QT.winStart = tNow; QT.frames = 0;
    const cur = qIndex(G.state.quality);
    if (fps < 50) {
      QT.goodSince = -1;
      if (cur > 0 && tNow - QT.lastChange > 3000) { QT.downCount[Q_ORDER[cur]]++; applyQuality(Q_ORDER[cur - 1], 'down'); }
    } else if (fps > 58) {
      if (QT.goodSince < 0) QT.goodSince = tNow;
      else if (tNow - QT.goodSince >= 10000 && cur < Q_ORDER.length - 1) {
        const next = Q_ORDER[cur + 1];
        if (QT.downCount[next] < 2) applyQuality(next, 'up'); else QT.goodSince = -1;
      }
    } else QT.goodSince = -1;
  }
  Game.stepQuality = function (dir) {
    const cur = qIndex(G.state.quality);
    const nx = Math.max(0, Math.min(Q_ORDER.length - 1, cur + (dir < 0 ? -1 : 1)));
    if (nx === cur) return G.state.quality;
    return applyQuality(Q_ORDER[nx], dir < 0 ? 'down' : 'up', true);
  };

  // ------------------------------------------------------------------------------------------------ game flow
  function teardown() {
    const p = G.state.player;
    if (!p && !Game.sessions) return;
    emit('gameEnd');
    try { if (G.AutoQuest && G.AutoQuest.active && has(G.AutoQuest, 'stop')) G.AutoQuest.stop('session end'); } catch (e) { report(e, 'Game.teardown.autoquest'); }
    try { if (G.Fishing && G.Fishing.state && G.Fishing.state !== 'idle' && has(G.Fishing, 'cancel')) G.Fishing.cancel(false); } catch (e) { report(e, 'Game.teardown.fishing'); }
    try { if (G.Boats && G.Boats.sailing && has(G.Boats, 'disembark')) G.Boats.disembark(true); } catch (e) { report(e, 'Game.teardown.boats'); }
    try {
      if (G.UI) {
        if (has(G.UI, 'closeAll')) G.UI.closeAll();
        if (G.UI.DeathScreen && has(G.UI.DeathScreen, 'hide')) G.UI.DeathScreen.hide();
        if (G.UI.tooltip && has(G.UI.tooltip, 'hide')) G.UI.tooltip.hide();
        if (has(G.UI, 'showHUD')) G.UI.showHUD(false);
      }
    } catch (e) { report(e, 'Game.teardown.ui'); }
    try { if (G.Input && has(G.Input, 'exitLock')) G.Input.exitLock(); } catch (e) { /* ignore */ }
    try { if (G.Audio && has(G.Audio, 'stopMusic')) G.Audio.stopMusic(1); } catch (e) { /* ignore */ }
    try { if (G.Player && has(G.Player, 'dispose')) G.Player.dispose(); } catch (e) { report(e, 'Game.teardown.player'); }
    try { if (G.Monsters && has(G.Monsters, 'init') && Game.sessions > 0) G.Monsters.init(scene); } catch (e) { report(e, 'Game.teardown.monsters'); }
    try { if (G.FX && has(G.FX, 'setBeacon')) G.FX.setBeacon(null); } catch (e) { /* ignore */ }
    G.state.inCombat = false;
    G.state.questTarget = null;
    if (G.state.player === p) G.state.player = null;
    T.inGame = false;
    framesSinceChange = 0;
  }

  function enterWorld(player, how) {
    try { if (G.Player && has(G.Player, 'snapCamera')) G.Player.snapCamera(); } catch (e) { report(e, 'Game.snapCamera'); }
    G.state.phase = 'playing';
    G.state.inCombat = false;
    G.time.paused = false;
    if (player && player.pos) {
      try { if (G.Terrain && has(G.Terrain, 'warmup')) G.Terrain.warmup(player.pos.x, player.pos.z, 320); } catch (e) { report(e, 'Game.warmup'); }
      try { if (G.Veg && has(G.Veg, 'update')) G.Veg.update(player.pos, 1 / 60); } catch (e) { report(e, 'Game.vegPrefill'); }
      try { if (G.Buildings && has(G.Buildings, 'update')) G.Buildings.update(player.pos, 1 / 60); } catch (e) { report(e, 'Game.buildingsPrefill'); }
      try { if (G.Sky && has(G.Sky, 'update')) G.Sky.update(0, player.pos); } catch (e) { report(e, 'Game.skyPrefill'); }
    }
    try { if (G.UI && has(G.UI, 'showHUD')) G.UI.showHUD(true); } catch (e) { report(e, 'Game.showHUD'); }
    Game.sessions++;
    Game.startedAt = G.time.now;
    Game.startedWall = nowMs();
    QT.winStart = 0; QT.frames = 0; QT.goodSince = -1;
    zoneMusic(true);
    G.emit('gameStart', player);
    T.inGame = true;
    framesSinceChange = 0;
    try { if (canvas && has(canvas, 'focus')) canvas.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    log('[Game] entered the world (' + how + ')', player && player.name, G.state.zone);
    return player;
  }

  function startNew(spec) {
    spec = spec || {};
    if (!Game.booted) {
      warn('G.Game.startNew called before the boot finished — deferred');
      return Game.readyPromise.then(function () { return startNew(spec); });
    }
    const t0 = nowMs();
    hideMenus();
    teardown();
    Game.lastSpec = Object.assign({}, spec);
    if (!G.Player || !has(G.Player, 'create')) { report(new Error('G.Player.create missing'), 'Game.startNew'); return null; }
    let player = null;
    try { if (has(G.Player, 'setScene')) G.Player.setScene(scene); } catch (e) { report(e, 'Game.startNew.setScene'); }
    try { player = G.Player.create(spec); } catch (e) { report(e, 'Game.startNew.create'); }
    if (!player) { G.state.phase = 'menu'; try { if (G.UI && G.UI.Menu && has(G.UI.Menu, 'show')) G.UI.Menu.show(); } catch (e) { /* ignore */ } return null; }
    try { if (G.Quests && has(G.Quests, 'init')) G.Quests.init(); } catch (e) { report(e, 'Game.startNew.quests'); }
    enterWorld(player, 'new');
    log('[Game] startNew ' + Math.round(nowMs() - t0) + ' ms');
    return player;
  }
  Game.startNew = startNew;

  function startFromSave() {
    if (!Game.booted) {
      warn('G.Game.startFromSave called before the boot finished — deferred');
      Game.readyPromise.then(function () { startFromSave(); });
      return false;
    }
    if (!G.Save || !has(G.Save, 'load')) { notify('Saving is not available in this build.', 'warning'); return false; }
    let data = null;
    try { data = G.Save.load(); } catch (e) { report(e, 'Game.startFromSave.load'); data = null; }
    if (!data) {
      notify(G.Save.lastError ? 'The saved game could not be read: ' + G.Save.lastError : 'No saved game was found.', 'warning');
      if (G.state.phase !== 'playing') { try { if (G.UI && G.UI.Menu && has(G.UI.Menu, 'show')) G.UI.Menu.show(); } catch (e) { /* ignore */ } }
      return false;
    }
    const t0 = nowMs();
    hideMenus();
    teardown();
    const spec = Object.assign({}, data.charSpec || {});
    Game.lastSpec = Object.assign({}, spec);
    let player = null;
    try { if (has(G.Player, 'setScene')) G.Player.setScene(scene); } catch (e) { report(e, 'Game.startFromSave.setScene'); }
    try { player = G.Player.create(spec); } catch (e) { report(e, 'Game.startFromSave.create'); }
    if (!player) { G.state.phase = 'menu'; try { if (G.UI && G.UI.Menu && has(G.UI.Menu, 'show')) G.UI.Menu.show(); } catch (e) { /* ignore */ } return false; }
    try { if (G.Quests && has(G.Quests, 'init')) G.Quests.init(); } catch (e) { report(e, 'Game.startFromSave.quests'); }
    try { if (has(G.Save, 'apply')) G.Save.apply(data); } catch (e) { report(e, 'Game.startFromSave.apply'); }
    enterWorld(player, 'save');
    log('[Game] startFromSave ' + Math.round(nowMs() - t0) + ' ms');
    return true;
  }
  Game.startFromSave = startFromSave;

  function toMenu() {
    const p = G.state.player;
    if (G.state.phase === 'playing' && p && p.alive !== false && !p.dead && G.Save && has(G.Save, 'save')) {
      try { G.Save.save({ silent: true, reason: 'menu' }); } catch (e) { report(e, 'Game.toMenu.save'); }
    }
    G.state.phase = 'menu';
    teardown();
    G.time.paused = false;
    try { if (G.UI && G.UI.Menu && has(G.UI.Menu, 'show')) G.UI.Menu.show(); else notify('Main menu is not available.', 'warning'); } catch (e) { report(e, 'Game.toMenu.show'); }
    framesSinceChange = 0;
  }
  Game.toMenu = toMenu;

  function toCharCreate() {
    G.state.phase = 'create';
    teardown();
    G.time.paused = false;
    try {
      if (G.UI && G.UI.CharCreate && has(G.UI.CharCreate, 'show')) G.UI.CharCreate.show();
      else if (G.UI && G.UI.Menu && has(G.UI.Menu, 'show')) G.UI.Menu.show();
    } catch (e) { report(e, 'Game.toCharCreate'); }
    framesSinceChange = 0;
  }
  Game.toCharCreate = toCharCreate;

  function restart() {
    const spec = Game.lastSpec || (G.state.player && G.state.player.spec) || null;
    if (!spec) { toCharCreate(); return null; }
    G.state.phase = 'create';
    return startNew(spec);
  }
  Game.restart = restart;

  // ------------------------------------------------------------------------------------------------ events
  if (has(G, 'on')) {
    G.on('zoneChanged', function () { zoneMusic(false); });
    G.on('dayPhase', function (phase) {
      const A = G.Audio;
      if (!A || G.state.phase !== 'playing' || !has(A, 'ambient')) return;
      const z = zoneData(G.state.zone);
      try { A.ambient((z && z.biome) || 'shire', phase || (G.Sky && G.Sky.phase) || 'day'); } catch (e) { report(e, 'Game.dayPhase'); }
    });
    G.on('musicEnded', function (id) {
      if (G.state.phase !== 'playing') return;
      if (G.state.inCombat) return;                  // Combat owns the music until combatEnd
      zoneMusic(false);
    });
    G.on('enterBuilding', function () { if (G.state.phase === 'playing' && !G.state.inCombat && insideInn()) zoneMusic(false); });
    G.on('leaveBuilding', function () { if (G.state.phase === 'playing' && !G.state.inCombat && G.Audio && G.Audio.currentTheme === 'tavern') zoneMusic(false); });
    G.on('playerRespawn', function () { if (G.state.phase === 'playing') zoneMusic(true); });
    G.on('menuShown', function () { if (G.state.phase !== 'playing') G.state.phase = 'menu'; framesSinceChange = 0; });
    G.on('createShown', function () { if (G.state.phase !== 'playing') G.state.phase = 'create'; framesSinceChange = 0; });
    G.on('createHidden', function () { if (G.state.phase === 'create') G.state.phase = 'menu'; });
    G.on('load', function () { framesSinceChange = 0; });
    G.on('qualityChanged', function () { framesSinceChange = 0; });
  }

  // ------------------------------------------------------------------------------------------------ test hooks
  function waitFrames(n) {
    n = Math.max(1, num(n, 1) | 0);
    return new Promise(function (resolve) {
      if (!loopRunning) { setTimeout(function () { resolve(frames); }, 50 * n); return; }
      waiters.push({ at: frames + n, resolve: resolve });
    });
  }
  T.waitFrames = waitFrames;

  T.quickStart = function (opts) {
    const spec = Object.assign({ name: 'Tester', race: 'man', cls: 'champion', gender: 'male' }, opts || {});
    return Game.readyPromise.then(function () {
      try { if (G.Audio && has(G.Audio, 'init')) G.Audio.init(); } catch (e) { /* audio is optional in headless runs */ }
      hideMenus();
      const p = startNew(spec);
      return waitFrames(2).then(function () { return p; });
    });
  };

  T.stats = function () {
    const r = renderer;
    const p = G.state.player;
    const out = {
      fps: Math.round(Game.fps * 10) / 10,
      frameMs: Math.round(Game.frameMs * 100) / 100,
      jsMs: Math.round(Game.jsMs * 100) / 100,
      drawCalls: r ? r.info.render.calls : 0,
      triangles: r ? r.info.render.triangles : 0,
      entities: Array.isArray(G.state.entities) ? G.state.entities.length : 0,
      chunks: null, veg: null, fx: null,
      phase: G.state.phase,
      quality: G.state.quality,
      zone: G.state.zone,
      pos: p && p.pos ? { x: Math.round(p.pos.x * 10) / 10, y: Math.round(p.pos.y * 10) / 10, z: Math.round(p.pos.z * 10) / 10 } : null,
      level: p ? p.level : 0,
      time: Math.round(G.time.now * 10) / 10,
      dayTime: Math.round(num(G.time.dayTime, 0) * 100) / 100,
      errors: Array.isArray(G.errors) ? G.errors.length : 0,
      bootMs: Game.timings.total,
      sessions: Game.sessions,
      postfx: !!(G.PostFX && G.PostFX.ready && G.PostFX.enabled),
    };
    try { if (G.Terrain && has(G.Terrain, 'stats')) out.chunks = G.Terrain.stats(); } catch (e) { out.chunks = null; }
    try { if (G.Veg && has(G.Veg, 'stats')) out.veg = G.Veg.stats(); } catch (e) { out.veg = null; }
    try { if (G.FX && has(G.FX, 'count')) out.fx = G.FX.count(); } catch (e) { out.fx = null; }
    try { if (G.Monsters && has(G.Monsters, 'stats')) { const s = G.Monsters.stats(); out.monsters = s ? { alive: s.alive, rigs: s.rigs } : null; } } catch (e) { out.monsters = null; }
    try { if (G.NPCs && has(G.NPCs, 'stats')) out.npcs = G.NPCs.stats(); } catch (e) { out.npcs = null; }
    try { if (G.AIPlayers && has(G.AIPlayers, 'stats')) out.aiplayers = G.AIPlayers.stats(); } catch (e) { out.aiplayers = null; }
    return out;
  };

  const KEY_NAMES = { Space: ' ', Escape: 'Escape', Tab: 'Tab', Enter: 'Enter', NumpadEnter: 'Enter', Backspace: 'Backspace', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Control', AltLeft: 'Alt', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', NumLock: 'NumLock' };
  function keyOfCode(code) {
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    if (/^Key[A-Z]$/.test(code)) return code.charAt(3).toLowerCase();
    if (/^Digit\d$/.test(code)) return code.charAt(5);
    if (/^F\d{1,2}$/.test(code)) return code;
    return code;
  }
  T.press = function (code, holdMs) {
    code = String(code || '');
    holdMs = num(holdMs, 120);
    const target = canvas || document.body || window;
    const key = keyOfCode(code);
    return new Promise(function (resolve) {
      try { target.dispatchEvent(new KeyboardEvent('keydown', { code: code, key: key, bubbles: true, cancelable: true })); } catch (e) { report(e, '__T.press'); }
      setTimeout(function () {
        try { target.dispatchEvent(new KeyboardEvent('keyup', { code: code, key: key, bubbles: true, cancelable: true })); } catch (e) { report(e, '__T.press'); }
        waitFrames(2).then(resolve);
      }, Math.max(0, holdMs));
    });
  };

  T.teleport = function (x, z, yaw) {
    const p = G.state.player;
    if (!p || !G.Player) return null;
    try { if (has(G.Player, 'teleport')) G.Player.teleport(num(x, p.pos.x), num(z, p.pos.z), yaw); else if (has(G.Player, 'spawnAt')) G.Player.spawnAt(num(x, p.pos.x), num(z, p.pos.z), yaw); } catch (e) { report(e, '__T.teleport'); }
    try { if (G.Terrain && has(G.Terrain, 'warmup')) G.Terrain.warmup(p.pos.x, p.pos.z, 320); } catch (e) { /* optional */ }
    try { if (G.Veg && has(G.Veg, 'update')) G.Veg.update(p.pos, 1 / 60); } catch (e) { /* optional */ }
    framesSinceChange = 0;
    return { x: p.pos.x, y: p.pos.y, z: p.pos.z };
  };

  T.setTime = function (hours) {
    hours = num(hours, G.time.dayTime);
    try { if (G.Sky && has(G.Sky, 'setTime')) G.Sky.setTime(hours); else G.time.dayTime = ((hours % 24) + 24) % 24; } catch (e) { report(e, '__T.setTime'); }
    framesSinceChange = 0;
    return G.time.dayTime;
  };

  T.screenshotReady = function () {
    if (!Game.booted || !loopRunning) return false;
    if (framesSinceChange < 3) return false;
    if (G.state.phase === 'playing' && !G.state.player) return false;
    try { if (G.Terrain && has(G.Terrain, 'stats')) { const s = G.Terrain.stats(); if (s && s.queued > 0) return false; } } catch (e) { /* ignore */ }
    return true;
  };

  // ------------------------------------------------------------------------------------------------ go
  function onDomReady() {
    boot().catch(function (e) {
      report(e, 'boot');
      Game.booted = true; Game.booting = false;
      if (G.state.phase === 'loading') G.state.phase = 'menu';
      startLoop();
      T.ready = true;
      if (resolveReady) { resolveReady(Game); resolveReady = null; }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onDomReady);
  else onDomReady();

  log('99_main ready');
})();
