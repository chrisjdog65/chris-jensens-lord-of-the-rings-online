/* ==== 26_fishing_boats.js — G.Fishing: the F-key fishing mini-game (cast → wait → bite → reel-tension game → catch;
   bobber, line and rod visuals, splash/ripple FX, catch tables per fishing spot or zone, junk & treasure, fishing
   skill 1..100 with rank titles, AutoQuest auto-fishing) and G.Boats: dock entities with interaction, moored
   decoration rowboats, free sailing in a rowboat (W/S row, A/D steer, momentum & drag, shallows bump, wave bobbing,
   wake FX, E to land) and elf-ship fast travel between docks with a 9 s sea-route cinematic (coarse A* over a
   water grid whenever the straight line crosses land, slowly orbiting camera, bells, sailing music, fades) plus the
   route / dock / land-connectivity queries AutoQuest needs.

   Public API (SPEC §6.7):
     G.Fishing: canFish(ent?) → {ok, reason}, start(), toggle(), cancel(reason?), update(dt), state, isFishing(),
                autoFish() (drives a perfect cycle without key input), skillLevel() → 'Novice' … 'Master'
     G.Boats:   init(scene?), board(dock), disembark(force?), sailTo(dockId, fromDock?, opts?), update(dt), sailing,
                travelling, openDockMenu(dock), routesFrom(dockId) → [{dock, id, name, cost, dist}], nearestDock(pos),
                dockForZone(zoneId), pathToZone(fromPos, zoneId) → [dock, …] | [] | null, instantTravel(dockId, opts?)
   Extras (documented; harmless if unused):
     G.Fishing: handlesKey (true — this module reads KeyF itself; the Player module must not also call toggle()),
                autoActive, init(), catchTable(x, z) → [{tid, weight}], skillLabel(skill), bobber (THREE.Group),
                lastCatch, resolveFishTid(tid) (maps the world registry's short fish ids — fish_trout, fish_cod, … —
                onto the item templates 03_data_items actually defines), rodTip(out), castPoint, waitTime()
     G.Boats:   waveHeight(x, z, t?) (matches the water shader's vertex waves), waveTime(), travelCost(from, to) →
                copper, dockById(id), docks (the world dock objects), boat (current boat entity | null), speed,
                seaPath(a, b) → [{x, z} …], waterSide(dock) → {x, z}, landComponent(x, z), nearShore(pos, r) →
                {x, z} | null, fade(on), group (THREE.Group root), travel (cinematic state | null), stats()
   Events emitted: fishingStart, fishCaught {tid, inst, kind, name}, fishingEnd {caught}, boarded (boat entity),
                   disembarked, sailDepart {from, to}, sailArrived {dock}.
   Assumptions about other modules (every call is guarded): G.Player.dismount() / spawnAt(x, z, yaw) / teleport /
   getForward(out) / cam {yaw, pitch, dist, targetDist}; G.UI.notify / chat / showLoot / addCSS / registerPanel /
   openPanel / anyOpen / Travel.openDock; G.Items.create / get / addToInventory / generate / rollGold / rarityColor;
   G.Progress.addGold / spendGold; G.Quests.onFish(tid, spotId); G.Game.scene / zoneMusic(); Buildings' dock.building
   .dockEnd; G.Terrain.waterMaterial.uniforms.uTime / uWaveAmp (wave phase). Fares: sailTo() charges the fare itself
   through G.Progress.spendGold unless opts.paid or opts.free — the Travel panel must not charge a second time.
   Private helpers are prefixed with _ or are module-local. No per-frame allocations (module-level scratch). ==== */
(function () {
  'use strict';
  const G = window.G;
  const THREE = window.THREE;
  if (!G || !THREE) return;

  // ================================================================================================ shared helpers
  const PI = Math.PI, TAU = Math.PI * 2;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrapA = (a) => { a = a % TAU; if (a > PI) a -= TAU; else if (a < -PI) a += TAU; return a; };
  const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
  const adamp = (a, b, l, dt) => a + wrapA(b - a) * (1 - Math.exp(-l * dt));
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  const isFn = (o, k) => !!(o && typeof o[k] === 'function');
  const easeInOut = (t) => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  const rand = () => (typeof G.rand === 'function') ? G.rand() : Math.random();       // gameplay randomness (rule 6)
  const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
  const _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3(), _v7 = new THREE.Vector3();
  const EMPTY = {};

  function SEA() { return (G.C && typeof G.C.SEA_LEVEL === 'number') ? G.C.SEA_LEVEL : 0; }
  function worldSize() { return (G.C && G.C.WORLD_SIZE > 0) ? G.C.WORLD_SIZE : 4096; }
  function height(x, z) { const t = G.Terrain; return isFn(t, 'height') ? t.height(x, z) : 0; }
  function isWater(x, z) { const t = G.Terrain; if (isFn(t, 'isWater')) return t.isWater(x, z); return height(x, z) < SEA(); }
  function depth(x, z) { const t = G.Terrain; if (isFn(t, 'waterDepth')) return t.waterDepth(x, z); const d = SEA() - height(x, z); return d > 0 ? d : 0; }
  function slopeOk(x, z) { const t = G.Terrain; return isFn(t, 'slope') ? t.slope(x, z) <= 0.85 : true; }
  function onRoad(x, z) { const t = G.Terrain; return isFn(t, 'onRoad') ? (t.onRoad(x, z) || 0) : 0; }
  function groundY(x, z) { const P = G.Physics; if (isFn(P, 'groundY')) return P.groundY(x, z); const h = height(x, z); return h > SEA() ? h : SEA(); }
  function now() { return (G.time && typeof G.time.now === 'number') ? G.time.now : 0; }
  function player() { return G.state ? G.state.player : null; }
  function rigOf(ent) { return (ent && ent.rig && !ent.rig.disposed) ? ent.rig : null; }
  function world() { return (G.Data && G.Data.world) ? G.Data.world : null; }
  function report(e, where) { if (typeof G.reportError === 'function') G.reportError(e, '26_fishing_boats.' + where); }
  function emit(evt, a) { if (typeof G.emit === 'function') { try { G.emit(evt, a); } catch (e) { report(e, 'emit:' + evt); } } }
  function sfx(name, o) { const A = G.Audio; if (!isFn(A, 'sfx')) return null; try { return A.sfx(name, o); } catch (e) { report(e, 'sfx'); return null; } }
  function notify(text, kind) { const U = G.UI; if (isFn(U, 'notify')) { try { U.notify(text, kind || 'info'); } catch (e) { report(e, 'notify'); } } }
  function chat(text) { const U = G.UI; if (isFn(U, 'chat')) { try { U.chat(text, 'system'); } catch (e) { report(e, 'chat'); } } }
  function uiOpen() { const U = G.UI; return !!(isFn(U, 'anyOpen') && U.anyOpen()); }
  function typing() { return !!(G.Input && G.Input.typing); }
  function keyPressed(code) { const I = G.Input; return !!(isFn(I, 'pressed') && I.pressed(code)); }
  function keyDown(code) { const I = G.Input; return !!(isFn(I, 'down') && I.down(code)); }
  function consumeKey(code) { const I = G.Input; if (isFn(I, 'consume')) I.consume(code); }
  function inputFrame() { const I = G.Input; return I ? (I.frame | 0) : 0; }
  function fx(kind, pos, opts) { const F = G.FX; if (!isFn(F, 'spawn')) return null; try { return F.spawn(kind, pos, opts || EMPTY); } catch (e) { report(e, 'fx'); return null; } }
  function fxStop(h) { const F = G.FX; if (h && isFn(F, 'stop')) F.stop(h); }
  function zoneData(id) { const W = world(); if (!W || !Array.isArray(W.zones)) return null; for (let i = 0; i < W.zones.length; i++) if (W.zones[i] && W.zones[i].id === id) return W.zones[i]; return null; }
  function townData(id) { const W = world(); if (!W || !Array.isArray(W.towns)) return null; for (let i = 0; i < W.towns.length; i++) if (W.towns[i] && W.towns[i].id === id) return W.towns[i]; return null; }
  function zoneAt(x, z) { const t = G.Terrain; return isFn(t, 'zoneAt') ? t.zoneAt(x, z) : (G.state ? G.state.zone : null); }
  function biomeAt(x, z) { const t = G.Terrain; if (isFn(t, 'biomeAt')) return t.biomeAt(x, z); const zd = zoneData(zoneAt(x, z)); return zd ? zd.biome : 'shire'; }
  function yawTo(dx, dz) { return Math.atan2(-dx, -dz); }                                   // yaw 0 = facing −Z
  function forwardOf(ent, out) {
    if (ent && ent === player() && isFn(G.Player, 'getForward')) {
      try { const r = G.Player.getForward(out); if (r && typeof r.x === 'number') { out.y = 0; const l = Math.hypot(out.x, out.z); if (l > 1e-4) { out.x /= l; out.z /= l; return out; } } } catch (e) { /* fall through */ }
    }
    const yaw = num(ent && ent.yaw, 0);
    return out.set(-Math.sin(yaw), 0, -Math.cos(yaw));
  }
  function fmtMoney(c) { return isFn(G, 'fmtMoney') ? G.fmtMoney(c) : String(c) + 'c'; }
  function fmtMoneyHTML(c) { return isFn(G, 'fmtMoneyHTML') ? G.fmtMoneyHTML(c) : fmtMoney(c); }
  function esc(s) { return isFn(G, 'escapeHTML') ? G.escapeHTML(s) : String(s == null ? '' : s); }
  function el(tag, attrs, children) { if (isFn(G, 'el')) return G.el(tag, attrs, children); const e = document.createElement(tag); if (attrs) { for (const k in attrs) { if (k === 'class') e.className = attrs[k]; else if (k === 'text') e.textContent = attrs[k]; else if (k === 'html') e.innerHTML = attrs[k]; else if (k === 'style' && typeof attrs[k] === 'string') e.style.cssText = attrs[k]; else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') e.addEventListener(k.slice(2).toLowerCase(), attrs[k]); else e.setAttribute(k, attrs[k]); } } if (children) (Array.isArray(children) ? children : [children]).forEach(c => { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }); return e; }
  function restoreZoneMusic() {
    if (isFn(G.Game, 'zoneMusic')) { try { G.Game.zoneMusic(); return; } catch (e) { report(e, 'zoneMusic'); } }
    const zd = zoneData(G.state && G.state.zone);
    if (zd && zd.music && isFn(G.Audio, 'music')) G.Audio.music(zd.music);
  }
  function music(id) { if (isFn(G.Audio, 'music') && (!isFn(G.Audio, 'hasTheme') || G.Audio.hasTheme(id))) G.Audio.music(id); }

  // ---- scene root: attached lazily to whatever scene the game exposes (G.Game.scene, or the parent of the terrain / FX groups)
  const root = new THREE.Group(); root.name = 'fishing_boats';
  let rootAttached = false;
  function sceneOf(explicit) {
    if (explicit && explicit.isScene) return explicit;
    if (G.Game && G.Game.scene && G.Game.scene.isScene) return G.Game.scene;
    const t = G.Terrain; if (t && t.group && t.group.parent && t.group.parent.isScene) return t.group.parent;
    const f = G.FX; const fg = f && f.group; if (fg && fg.parent && fg.parent.isScene) return fg.parent;
    const pl = player(); if (pl && pl.mesh && pl.mesh.parent && pl.mesh.parent.isScene) return pl.mesh.parent;
    return null;
  }
  function attachRoot(scene) {
    if (rootAttached && root.parent) return true;
    const sc = sceneOf(scene);
    if (!sc) return false;
    sc.add(root); rootAttached = true;
    return true;
  }
  if (typeof G.on === 'function') G.on('sceneReady', function (sc) { attachRoot(sc && sc.isScene ? sc : null); });

  // ---- waves: the same three layered sines the water shader displaces its vertices with (phase = the shader's uTime)
  const W1L = Math.hypot(0.82, 0.57), W1X = 0.82 / W1L, W1Z = 0.57 / W1L, K1 = TAU / 23, A1 = 0.28, S1 = 1.05;
  const W2L = Math.hypot(0.35, 0.94), W2X = -0.35 / W2L, W2Z = 0.94 / W2L, K2 = TAU / 11, A2 = 0.13, S2 = 1.55;
  const W3X = 0.6, W3Z = -0.8, K3 = TAU / 5.5, A3 = 0.05, S3 = 2.3;
  const wave = { h: 0, dx: 0, dz: 0 };
  function waterUniform(name) { const t = G.Terrain; const m = t && t.waterMaterial; const u = m && m.uniforms && m.uniforms[name]; return (u && typeof u.value === 'number') ? u.value : null; }
  function waveTime() { const v = waterUniform('uTime'); return v == null ? now() : v; }
  function waveAt(x, z, t) {
    const av = waterUniform('uWaveAmp'); const amp = av == null ? 1 : av;
    const p1 = (W1X * x + W1Z * z) * K1 + t * S1, p2 = (W2X * x + W2Z * z) * K2 + t * S2, p3 = (W3X * x + W3Z * z) * K3 + t * S3;
    const c1 = Math.cos(p1) * K1 * A1, c2 = Math.cos(p2) * K2 * A2, c3 = Math.cos(p3) * K3 * A3;
    wave.h = (A1 * Math.sin(p1) + A2 * Math.sin(p2) + A3 * Math.sin(p3)) * amp;
    wave.dx = (W1X * c1 + W2X * c2 + W3X * c3) * amp;
    wave.dz = (W1Z * c1 + W2Z * c2 + W3Z * c3) * amp;
    return wave;
  }
  function waveHeight(x, z, t) {
    const T = G.Terrain;
    if (isFn(T, 'waveHeight')) { const v = T.waveHeight(x, z, t == null ? waveTime() : t); if (typeof v === 'number' && isFinite(v)) return v; }
    return waveAt(num(x, 0), num(z, 0), t == null ? waveTime() : t).h;
  }

  // ---- black fade overlay owned here (used by boat travel); G.UI.fade(bool|dur) is preferred when a HUD provides it
  let fadeEl = null, fadeTarget = 0, fadeAlpha = 0, fadeSpeed = 1 / 0.6;
  function ensureFade() {
    if (fadeEl || typeof document === 'undefined') return fadeEl;
    fadeEl = document.getElementById('boatFade');
    if (!fadeEl) {
      fadeEl = el('div', { id: 'boatFade', style: 'position:fixed;left:0;top:0;right:0;bottom:0;background:#000;opacity:0;pointer-events:none;z-index:950;display:none' });
      const host = document.getElementById('overlays') || document.body;
      if (host) host.appendChild(fadeEl);
    }
    return fadeEl;
  }
  function fade(on, dur) {
    fadeTarget = on ? 1 : 0; fadeSpeed = 1 / Math.max(0.05, num(dur, 0.6));
    const U = G.UI;
    if (isFn(U, 'fade')) { try { U.fade(on ? num(dur, 0.6) : false); } catch (e) { /* the HUD decides */ } }
    ensureFade();
  }
  function updateFade(dt) {
    if (fadeAlpha === fadeTarget) return;
    const step = fadeSpeed * dt;
    fadeAlpha = fadeAlpha < fadeTarget ? Math.min(fadeTarget, fadeAlpha + step) : Math.max(fadeTarget, fadeAlpha - step);
    const e = ensureFade(); if (!e) return;
    e.style.display = fadeAlpha > 0.001 ? 'block' : 'none';
    e.style.opacity = fadeAlpha.toFixed(3);
  }

  // ================================================================================================ FISHING
  const CAST_TIME = 0.8, FLIGHT_START = 0.48, FLIGHT_TIME = 0.5, BITE_WINDOW = 1.6, CAUGHT_TIME = 1.1, RETRACT_TIME = 0.45;
  const LINE_SNAP_TIME = 0.6, SLACK_TIME = 0.35, RIPPLE_EVERY = 2.0, ROD_TIP_LOCAL = 1.35, LINE_SEGS = 14;
  const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'Escape', 'KeyH', 'KeyQ'];
  const SKILL_RANKS = [[85, 'Master'], [65, 'Expert'], [40, 'Journeyman'], [20, 'Apprentice'], [0, 'Novice']];
  // the world registry's short fish ids → the templates 03_data_items defines
  const FISH_ALIAS = {
    fish_trout: 'fish_brandywine_trout', fish_perch: 'fish_bywater_perch', fish_carp: 'fish_golden_carp', fish_pike: 'fish_nenuial_pike',
    fish_salmon: 'fish_evendim_salmon', fish_eel: 'fish_midgewater_eel', fish_cod: 'fish_forochel_icecod', fish_herring: 'fish_lune_herring',
    fish_mackerel: 'fish_tolfuin_seabass', fish_sturgeon: 'fish_himling_sturgeon', fish_char: 'fish_hoarwell_grayling', fish_grayling: 'fish_hoarwell_grayling',
    fish_golden_perch: 'fish_silver_trout', fish_seabass: 'fish_tolfuin_seabass', fish_icecod: 'fish_forochel_icecod',
  };
  // zone-default catch tables by biome (weights); a coast adds the 'sea' table
  const BIOME_FISH = {
    shire: [['fish_brandywine_trout', 6], ['fish_bywater_perch', 6], ['fish_golden_carp', 1]],
    breeland: [['fish_brandywine_trout', 5], ['fish_bywater_perch', 4], ['fish_midgewater_eel', 2], ['fish_golden_carp', 1]],
    forest: [['fish_midgewater_eel', 5], ['fish_bywater_perch', 3], ['fish_brandywine_trout', 2], ['fish_hoarwell_grayling', 1]],
    marsh: [['fish_midgewater_eel', 7], ['fish_bywater_perch', 3]],
    barren: [['fish_hoarwell_grayling', 5], ['fish_bywater_perch', 3], ['fish_brandywine_trout', 2]],
    downs: [['fish_hoarwell_grayling', 5], ['fish_brandywine_trout', 3], ['fish_bywater_perch', 2]],
    lake: [['fish_nenuial_pike', 5], ['fish_evendim_salmon', 5], ['fish_brandywine_trout', 1]],
    elven: [['fish_evendim_salmon', 4], ['fish_golden_carp', 4], ['fish_hoarwell_grayling', 2]],
    mountain: [['fish_lune_herring', 5], ['fish_hoarwell_grayling', 3], ['fish_brandywine_trout', 2]],
    dwarven: [['fish_hoarwell_grayling', 4], ['fish_brandywine_trout', 3], ['fish_lune_herring', 2]],
    dark: [['fish_hoarwell_grayling', 4], ['fish_midgewater_eel', 3], ['fish_nenuial_pike', 1]],
    arctic: [['fish_forochel_icecod', 7], ['fish_lune_herring', 2]],
    island: [['fish_tolfuin_seabass', 5], ['fish_lune_herring', 4], ['fish_himling_sturgeon', 2]],
    sea: [['fish_lune_herring', 5], ['fish_tolfuin_seabass', 2], ['fish_forochel_icecod', 1], ['fish_himling_sturgeon', 0.5]],
  };
  const ZONE_TABLE = { trollshaws: 'elven', evendim: 'lake', souththicket: 'marsh', oldforest: 'forest', eredluin: 'mountain' };
  const RARE_TID = 'fish_silver_trout', JUNK_TID = 'junk_old_boot', CHARM_TID = 'n_silver_trout_charm';

  const Fishing = {
    state: 'idle', handlesKey: true, autoActive: false, lastCatch: null,
    castPoint: new THREE.Vector3(), bobber: null,
  };
  G.Fishing = Fishing;

  // ---- fishing runtime
  const FS = {
    t: 0, waitT: 0, nibbleAt: [0, 0], nibbleN: 0, nibbleT: 0, rippleT: 0, ringT: 0, retractT: 0,
    flight: 0, landed: false, launch: new THREE.Vector3(), bobPos: new THREE.Vector3(), tip: new THREE.Vector3(),
    dive: 0, wobble: 0, bubbles: null, spot: null, catchRes: null, caughtItem: null, failed: false,
    reel: { t: 0, tension: 0.5, progress: 0, gh: 0.25, dur: 3, amp: 0.4, w1: 2.5, w2: 5.1, p1: 0, p2: 0, surge: 0, surgeT: 0.6, maxT: 0, zeroT: 0, splashT: 0 },
    lastToggleFrame: -1, ownRod: null, bar: null, barEls: null, barState: '', needle: -1, fill: -1, inited: false,
  };
  let lineGeo = null, lineMesh = null, linePos = null;

  function skillValue() { const s = G.state ? +G.state.fishingSkill : 1; return clamp(isFinite(s) ? s : 1, 1, 100); }
  function skillLabel(s) { s = num(s, skillValue()); for (let i = 0; i < SKILL_RANKS.length; i++) if (s >= SKILL_RANKS[i][0]) return SKILL_RANKS[i][1]; return 'Novice'; }
  function luckOf(ent) { const st = ent && ent.stats; const l = st && +st.fishingLuck; return clamp(isFinite(l) ? l : 0, 0, 2); }
  function itemExists(tid) { return !!(tid && G.Data && G.Data.items && G.Data.items[tid]); }
  function resolveFishTid(tid) {
    if (!tid) return null;
    if (itemExists(tid)) return tid;
    const a = FISH_ALIAS[tid] || FISH_ALIAS['fish_' + tid];
    if (a && itemExists(a)) return a;
    if (itemExists('fish_' + tid)) return 'fish_' + tid;
    return null;
  }
  function fishLevelOf(tid) { const t = G.Data && G.Data.items && G.Data.items[tid]; return t ? num(t.fishLevel, num(t.level, 1)) : 1; }
  function itemName(inst) { if (!inst) return 'something'; const v = isFn(G.Items, 'get') ? G.Items.get(inst) : null; return (v && v.name) || (G.Data && G.Data.items && G.Data.items[inst.tid] && G.Data.items[inst.tid].name) || inst.tid || 'something'; }

  function nearestSpot(x, z, maxR) {
    const W = world(); if (!W || !Array.isArray(W.fishingSpots)) return null;
    let best = null, bd = Infinity;
    for (let i = 0; i < W.fishingSpots.length; i++) {
      const s = W.fishingSpots[i]; if (!s || !s.pos) continue;
      const dx = s.pos.x - x, dz = s.pos.z - z, d = Math.sqrt(dx * dx + dz * dz) - num(s.radius, 0);
      if (d < bd) { bd = d; best = s; }
    }
    return (best && bd <= maxR) ? best : null;
  }
  function coastal(x, z) {
    const W = world(); const wd = W && W.water;
    const sx = num(wd && wd.seaWestX, -1500), sz = num(wd && wd.seaNorthZ, -1650);
    return x < sx + 80 || z < sz + 80;
  }
  const _tableOut = [];
  function catchTable(x, z) {
    _tableOut.length = 0;
    const skill = skillValue();
    const spot = nearestSpot(x, z, 40);
    const push = (tid, w) => { const r = resolveFishTid(tid); if (!r || !(w > 0)) return; const fl = fishLevelOf(r); const k = clamp(1 - (fl - skill * 1.2) / 40, 0.15, 1); for (let i = 0; i < _tableOut.length; i++) if (_tableOut[i].tid === r) { _tableOut[i].weight += w * k; return; } _tableOut.push({ tid: r, weight: w * k }); };
    if (spot && Array.isArray(spot.fish)) for (let i = 0; i < spot.fish.length; i++) { const f = spot.fish[i]; if (f) push(f.tid || f.id, num(f.weight, 1)); }
    if (!_tableOut.length) {
      const zid = zoneAt(x, z); const key = ZONE_TABLE[zid] || biomeAt(x, z);
      const tbl = BIOME_FISH[key] || BIOME_FISH.shire;
      for (let i = 0; i < tbl.length; i++) push(tbl[i][0], tbl[i][1]);
      if (coastal(x, z) && key !== 'island' && key !== 'sea') { const st = BIOME_FISH.sea; for (let i = 0; i < st.length; i++) push(st[i][0], st[i][1] * 0.8); }
    }
    if (!_tableOut.length) { const all = G.Data && G.Data.items; if (all) for (const id in all) if (all[id] && all[id].type === 'fish' && all[id].rarity !== 'rare') _tableOut.push({ tid: id, weight: 1 }); }
    FS.spot = spot;
    return _tableOut;
  }
  function pickWeighted(list) {
    let sum = 0; for (let i = 0; i < list.length; i++) sum += list[i].weight;
    if (!(sum > 0)) return list.length ? list[0] : null;
    let r = rand() * sum;
    for (let i = 0; i < list.length; i++) { r -= list[i].weight; if (r <= 0) return list[i]; }
    return list[list.length - 1];
  }
  function bestBait(pl) {
    if (!pl || !Array.isArray(pl.inventory) || !G.Data || !G.Data.items) return -1;
    let best = -1, bb = -1;
    for (let i = 0; i < pl.inventory.length; i++) {
      const s = pl.inventory[i]; if (!s) continue;
      const t = G.Data.items[s.tid]; if (!t || t.type !== 'bait') continue;
      const b = t.bait ? num(t.bait.bonus, 0) : 0;
      if (b > bb) { bb = b; best = i; }
    }
    return best;
  }
  function rollCatch(pl, x, z, baitBonus) {
    const skill = skillValue(), luck = luckOf(pl);
    const r = rand();
    const pTreasure = 0.03 * (1 + luck), pJunk = 0.08 * (1 - skill / 200), pRare = 0.02 * (1 + luck) * (1 + skill / 100) * (1 + baitBonus);
    if (r < pTreasure) return { kind: 'treasure', tid: null, fishLevel: 30, rare: false, name: 'a sunken strongbox' };
    if (r < pTreasure + pJunk && itemExists(JUNK_TID)) return { kind: 'junk', tid: JUNK_TID, fishLevel: 1, rare: false, name: 'an old boot' };
    if (r < pTreasure + pJunk + pRare && itemExists(RARE_TID)) return { kind: 'fish', tid: RARE_TID, fishLevel: fishLevelOf(RARE_TID), rare: true, name: 'a Silver Trout' };
    const e = pickWeighted(catchTable(x, z));
    if (!e) return { kind: 'junk', tid: itemExists(JUNK_TID) ? JUNK_TID : null, fishLevel: 1, rare: false, name: 'an old boot' };
    return { kind: 'fish', tid: e.tid, fishLevel: fishLevelOf(e.tid), rare: false, name: null };
  }

  // ---- visuals: bobber, line, rod
  function buildBobber() {
    const g = new THREE.Group(); g.name = 'bobber';
    const red = new THREE.MeshStandardMaterial({ color: 0xd8262a, roughness: 0.45, metalness: 0.05 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf4f0e4, roughness: 0.5, metalness: 0.02 });
    const top = new THREE.SphereGeometry(0.09, 14, 8, 0, TAU, 0, PI / 2);
    const tip = new THREE.SphereGeometry(0.022, 8, 6); tip.translate(0, 0.25, 0);
    const bot = new THREE.SphereGeometry(0.09, 14, 8, 0, TAU, PI / 2, PI / 2);
    const stem = new THREE.CylinderGeometry(0.011, 0.014, 0.2, 6); stem.translate(0, 0.14, 0);
    let redGeo, whiteGeo;
    if (isFn(G, 'mergeGeometries')) { try { redGeo = G.mergeGeometries([top, tip]); whiteGeo = G.mergeGeometries([bot, stem]); } catch (e) { redGeo = null; } }
    if (redGeo && whiteGeo) { g.add(new THREE.Mesh(redGeo, red)); g.add(new THREE.Mesh(whiteGeo, white)); }
    else { g.add(new THREE.Mesh(top, red), new THREE.Mesh(tip, red), new THREE.Mesh(bot, white), new THREE.Mesh(stem, white)); }
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    g.visible = false;
    return g;
  }
  function ensureVisuals() {
    if (!Fishing.bobber) { Fishing.bobber = buildBobber(); root.add(Fishing.bobber); }
    if (!lineMesh) {
      linePos = new Float32Array((LINE_SEGS + 1) * 3);
      lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(linePos, 3));
      lineMesh = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xe9e9e9, transparent: true, opacity: 0.7, depthWrite: false }));
      lineMesh.name = 'fishingLine'; lineMesh.frustumCulled = false; lineMesh.visible = false;
      root.add(lineMesh);
    }
    attachRoot();
  }
  function ensureRod(rig) {
    if (!rig) return;
    if (isFn(rig, 'setProp')) {
      if (rig.propKind !== 'rod') { try { rig.setProp('rod'); } catch (e) { report(e, 'setProp'); } }
      if (rig.prop && rig.parts && rig.parts.propGroup) return;                       // the rig's own rod is in hand
    }
    if (FS.ownRod || !rig.parts || !rig.parts.handR) return;
    const g = new THREE.Group(); g.name = 'ownRod';
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.016, 1.6, 6), new THREE.MeshStandardMaterial({ color: 0x8a6a3a, roughness: 0.8 })); shaft.position.y = 0.55;
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.22, 8), new THREE.MeshStandardMaterial({ color: 0x3a2a1a, roughness: 0.9 })); grip.position.y = -0.05;
    g.add(shaft, grip); g.position.set(0, -0.05, 0); g.rotation.set(-PI / 2, PI / 2, 0);
    rig.parts.handR.add(g); FS.ownRod = g;
  }
  function removeRod(rig) {
    if (FS.ownRod) { if (FS.ownRod.parent) FS.ownRod.parent.remove(FS.ownRod); FS.ownRod = null; }
    if (rig && isFn(rig, 'setProp') && rig.propKind === 'rod') { try { rig.setProp(null); } catch (e) { /* ignore */ } }
  }
  function rodTip(out) {
    const pl = player(), rig = rigOf(pl);
    let g = null, s = 1;
    if (FS.ownRod) { g = FS.ownRod; }
    else if (rig && rig.parts && rig.parts.propGroup && rig.prop && rig.propKind === 'rod') { g = rig.parts.propGroup; s = num(rig.weaponScale, 1); }
    if (g && g.parent) { g.updateWorldMatrix(true, false); return out.set(0, ROD_TIP_LOCAL * s, 0).applyMatrix4(g.matrixWorld); }
    if (pl && pl.pos) { forwardOf(pl, _v2); return out.set(pl.pos.x + _v2.x * 0.9, pl.pos.y + num(pl.height, 1.8) * 0.85, pl.pos.z + _v2.z * 0.9); }
    return out.set(0, 0, 0);
  }
  function updateLine(tip, bob, sag) {
    if (!lineMesh) return;
    for (let i = 0; i <= LINE_SEGS; i++) {
      const t = i / LINE_SEGS, o = i * 3;
      linePos[o] = lerp(tip.x, bob.x, t); linePos[o + 1] = lerp(tip.y, bob.y, t) - sag * Math.sin(PI * t); linePos[o + 2] = lerp(tip.z, bob.z, t);
    }
    lineGeo.attributes.position.needsUpdate = true;
  }
  function rigAnim(name, force) { const rig = rigOf(player()); if (rig && isFn(rig, 'setAnim')) { try { rig.setAnim(name, force); } catch (e) { report(e, 'setAnim'); } } }
  function facePlayerToCast() {
    const pl = player(); if (!pl || !pl.pos) return;
    const dx = Fishing.castPoint.x - pl.pos.x, dz = Fishing.castPoint.z - pl.pos.z;
    if (dx * dx + dz * dz > 0.04) pl.yaw = yawTo(dx, dz);
  }

  // ---- HUD bar
  const BAR_CSS = [
    '#fishingBar{position:absolute;left:50%;bottom:168px;transform:translateX(-50%);width:360px;padding:8px 14px 10px;box-sizing:border-box;',
    'background:var(--panel,rgba(14,11,8,.9));border:1px solid var(--border,#6f5322);border-radius:var(--radius,6px);box-shadow:var(--shadow,0 8px 28px rgba(0,0,0,.6));',
    'color:var(--parch,#e8dcc0);font-family:var(--font-ui,Georgia,serif);text-align:center;pointer-events:none;z-index:30;transition:opacity .25s}',
    '#fishingBar.fb-hidden{opacity:0;visibility:hidden}',
    '#fishingBar .fb-title{font-family:var(--font-head,Georgia,serif);color:var(--gold,#d4af5a);font-size:12px;letter-spacing:.14em;text-transform:uppercase}',
    '#fishingBar .fb-status{font-size:17px;margin:3px 0 7px;min-height:22px;line-height:22px}',
    '#fishingBar.fb-bite .fb-status{color:var(--gold-bright,#ffe08a);text-shadow:0 0 10px rgba(255,224,138,.7);animation:fbPulse .45s ease-in-out infinite alternate}',
    '#fishingBar.fb-caught .fb-status{color:var(--green,#5fbf5a)}',
    '@keyframes fbPulse{from{transform:scale(1)}to{transform:scale(1.07)}}',
    '#fishingBar .fb-meter{position:relative;height:14px;border:1px solid var(--border,#6f5322);border-radius:7px;',
    'background:linear-gradient(90deg,#8a2a22 0%,#8a2a22 var(--fb-g0,35%),#3f8a3a var(--fb-g0,35%),#3f8a3a var(--fb-g1,65%),#8a2a22 var(--fb-g1,65%),#8a2a22 100%);box-shadow:inset 0 2px 4px rgba(0,0,0,.6)}',
    '#fishingBar .fb-needle{position:absolute;top:-5px;left:50%;width:7px;height:24px;margin-left:-4px;background:var(--parch,#e8dcc0);border:1px solid #000;border-radius:2px;box-shadow:0 0 6px rgba(0,0,0,.8)}',
    '#fishingBar .fb-progress{height:8px;margin-top:7px;border:1px solid var(--border,#6f5322);border-radius:4px;background:rgba(0,0,0,.45);overflow:hidden}',
    '#fishingBar .fb-fill{height:100%;width:0;background:linear-gradient(90deg,var(--gold-dim,#8a6d2f),var(--gold-bright,#ffe08a))}',
    '#fishingBar .fb-hint{font-size:12px;color:var(--parch-dim,#b8ad94);margin-top:6px}',
    '#fishingBar .fb-hint b{color:var(--gold,#d4af5a)}',
    '#fishingBar.fb-wait .fb-meter,#fishingBar.fb-wait .fb-progress{opacity:.28}',
  ].join('\n');
  let barCssAdded = false;
  function ensureBar() {
    if (FS.bar || typeof document === 'undefined') return FS.bar;
    if (!barCssAdded) {
      barCssAdded = true;
      if (isFn(G.UI, 'addCSS')) { try { G.UI.addCSS(BAR_CSS); } catch (e) { report(e, 'addCSS'); } }
      else { const s = document.createElement('style'); s.textContent = BAR_CSS; (document.head || document.documentElement).appendChild(s); }
    }
    const E = {};
    E.title = el('div', { class: 'fb-title', text: 'Fishing' });
    E.status = el('div', { class: 'fb-status', text: '' });
    E.needle = el('div', { class: 'fb-needle' });
    E.meter = el('div', { class: 'fb-meter' }, [E.needle]);
    E.fill = el('div', { class: 'fb-fill' });
    E.progress = el('div', { class: 'fb-progress' }, [E.fill]);
    E.hint = el('div', { class: 'fb-hint', html: 'Hold <b>F</b> to reel in &middot; keep the tension in the green' });
    const bar = el('div', { id: 'fishingBar', class: 'fb-hidden fb-wait' }, [E.title, E.status, E.meter, E.progress, E.hint]);
    const host = document.getElementById('hud') || document.getElementById('overlays') || document.body;
    if (host) host.appendChild(bar);
    FS.bar = bar; FS.barEls = E;
    return bar;
  }
  function barShow(on) { const b = ensureBar(); if (b) { if (on) b.classList.remove('fb-hidden'); else b.classList.add('fb-hidden'); } }
  function barMode(mode, status, hint) {
    const b = ensureBar(); if (!b) return;
    if (FS.barState !== mode) { FS.barState = mode; b.className = 'fb-' + mode + (mode === 'reel' || mode === 'caught' ? '' : ' fb-wait'); }
    if (status != null) FS.barEls.status.textContent = status;
    if (hint != null) FS.barEls.hint.innerHTML = hint;
  }
  function barMeter(tension, progress) {
    const E = FS.barEls; if (!E) return;
    const n = Math.round(clamp(tension, 0, 1) * 1000) / 10, f = Math.round(clamp(progress, 0, 1) * 1000) / 10;
    if (n !== FS.needle) { FS.needle = n; E.needle.style.left = n + '%'; }
    if (f !== FS.fill) { FS.fill = f; E.fill.style.width = f + '%'; }
  }
  function barZone(gh) { const E = FS.barEls; if (!E) return; E.meter.style.setProperty('--fb-g0', Math.round((0.5 - gh) * 100) + '%'); E.meter.style.setProperty('--fb-g1', Math.round((0.5 + gh) * 100) + '%'); }

  // ---- state machine
  function setState(s) { Fishing.state = s; FS.t = 0; }
  function canFish(ent) {
    ent = ent || player();
    if (!ent || !ent.pos) return { ok: false, reason: 'There is no one to fish.' };
    if (ent.dead || ent.alive === false) return { ok: false, reason: 'You cannot fish while defeated.' };
    if (G.Boats && (G.Boats.sailing || G.Boats.travelling)) return { ok: false, reason: 'You cannot fish from the boat.' };
    if (ent.mounted) return { ok: false, reason: 'You cannot fish while mounted.', mounted: true };
    if (ent.swimming) return { ok: false, reason: 'You cannot fish while swimming.' };
    const x = ent.pos.x, z = ent.pos.z;
    const onLand = !isWater(x, z) || ent.pos.y > SEA() + 0.35 || depth(x, z) < 0.45;
    if (!onLand) return { ok: false, reason: 'You cannot fish while swimming.' };
    forwardOf(ent, _v1);
    let found = false;
    for (let d = 2; d <= 6 && !found; d += 2) if (isWater(x + _v1.x * d, z + _v1.z * d)) found = true;
    if (!found) return { ok: false, reason: 'You need to stand at the water\'s edge, facing the water.' };
    return { ok: true };
  }
  function computeCastPoint(pl) {
    forwardOf(pl, _v1);
    const x = pl.pos.x, z = pl.pos.z;
    let bestD = -1, bestDepth = 0, fallbackD = -1;
    for (let d = 4; d <= 7.001; d += 0.5) {
      const px = x + _v1.x * d, pz = z + _v1.z * d;
      if (!isWater(px, pz)) continue;
      const dp = depth(px, pz);
      if (dp >= 0.6) { bestD = d; bestDepth = dp; }
      else if (fallbackD < 0 || dp > bestDepth) { fallbackD = d; }
    }
    if (bestD < 0) { for (let d = 2; d < 4 && bestD < 0; d += 0.5) { const px = x + _v1.x * d, pz = z + _v1.z * d; if (isWater(px, pz) && depth(px, pz) >= 0.3) bestD = d; } }
    if (bestD < 0) bestD = fallbackD >= 0 ? fallbackD : 4;
    const d = clamp(bestD - rand() * 0.6, 2, 7);
    Fishing.castPoint.set(x + _v1.x * d, SEA(), z + _v1.z * d);
    return Fishing.castPoint;
  }
  function waitTime(pl, baitBonus) {
    const skill = skillValue(), luck = luckOf(pl);
    const base = 2 + rand() * 5;
    return clamp(base * (1 - 0.3 * luck) * (1 - 0.3 * (skill / 100)) * (1 - 0.5 * baitBonus), 1.4, 7);
  }
  function start() {
    if (Fishing.state !== 'idle') return false;
    const pl = player(); if (!pl || !pl.pos) return false;
    if (pl.mounted && isFn(G.Player, 'dismount')) { try { G.Player.dismount(); } catch (e) { report(e, 'dismount'); } }
    const c = canFish(pl);
    if (!c.ok) { notify(c.reason, 'warning'); sfx('ui_error', { vol: 0.5 }); return false; }
    ensureVisuals();
    computeCastPoint(pl);
    facePlayerToCast();
    // bait (best in bags; consumed on the cast)
    let baitBonus = 0;
    const bi = bestBait(pl);
    if (bi >= 0) {
      const s = pl.inventory[bi]; const t = G.Data.items[s.tid];
      baitBonus = t.bait ? num(t.bait.bonus, 0) : 0;
      if (isFn(G.Items, 'removeFromInventory')) G.Items.removeFromInventory(pl, s.tid, 1);
      chat('You bait your hook with ' + (t.name || 'bait') + '.');
    }
    FS.baitBonus = baitBonus;
    FS.waitT = waitTime(pl, baitBonus);
    FS.nibbleN = rand() < 0.55 ? (rand() < 0.4 ? 2 : 1) : 0;
    FS.nibbleAt[0] = 0.6 + rand() * Math.max(0.2, FS.waitT - 1.2); FS.nibbleAt[1] = 0.6 + rand() * Math.max(0.2, FS.waitT - 1.2);
    if (FS.nibbleAt[1] < FS.nibbleAt[0] + 0.6) FS.nibbleAt[1] = FS.nibbleAt[0] + 0.6;
    FS.nibbleT = 0; FS.rippleT = 0.8; FS.landed = false; FS.flight = 0; FS.dive = 0; FS.wobble = 0; FS.catchRes = null; FS.caughtItem = null; FS.failed = false; FS.retractT = 0;
    FS.spot = nearestSpot(Fishing.castPoint.x, Fishing.castPoint.z, 40);
    const rig = rigOf(pl);
    rigAnim('fish_cast', true);
    ensureRod(rig);
    rodTip(FS.tip); FS.launch.copy(FS.tip); FS.bobPos.copy(FS.tip);
    Fishing.bobber.visible = true; Fishing.bobber.position.copy(FS.tip); Fishing.bobber.rotation.set(0, 0, 0);
    lineMesh.visible = true;
    sfx('fish_cast', { pos: pl.pos });
    setState('casting');
    barMode('cast', 'Casting…', 'Hold <b>F</b> to reel in &middot; keep the tension in the green');
    barShow(true);
    emit('fishingStart');
    return true;
  }
  function finish(caught) {
    const pl = player(), rig = rigOf(pl);
    removeRod(rig);
    rigAnim('idle', true);
    if (Fishing.bobber) Fishing.bobber.visible = false;
    if (lineMesh) lineMesh.visible = false;
    if (FS.bubbles) { fxStop(FS.bubbles); FS.bubbles = null; }
    setState('idle');
    Fishing.autoActive = false;
    barShow(false);
    emit('fishingEnd', { caught: !!caught });
  }
  function cancel(reason) {
    if (Fishing.state === 'idle') return false;
    const pl = player();
    if (Fishing.state !== 'caught' && lineMesh) { FS.retractT = RETRACT_TIME; }
    if (reason !== false) notify(typeof reason === 'string' ? reason : 'You reel in your line.', 'info');
    if (pl) sfx('splash', { pos: Fishing.castPoint, vol: 0.2, pitch: 1.4 });
    finish(false);
    return true;
  }
  function fail(msg) {
    const pl = player();
    sfx('fish_fail', { pos: pl ? pl.pos : null });
    notify(msg || 'The fish got away.', 'warning');
    fx('water_ring', FS.bobPos, { scale: 0.7 });
    FS.retractT = RETRACT_TIME;
    finish(false);
  }
  function hook() {
    if (Fishing.state !== 'bite') return false;
    const pl = player();
    const R = FS.reel, skill = skillValue();
    const c = FS.catchRes;
    let diff = c.kind === 'fish' ? clamp(0.3 + c.fishLevel / 100 + (c.rare ? 0.3 : 0), 0.25, 1) : 0.35;
    diff *= 1 - skill / 250;
    R.t = 0; R.tension = 0.5; R.progress = 0; R.gh = clamp(0.13 + 0.12 * (1 - diff) + skill * 0.0012, 0.12, 0.38);
    R.dur = 2 + 2 * diff; R.amp = 0.3 + 0.55 * diff; R.w1 = 2.1 + diff * 1.5; R.w2 = 5.3 + diff; R.p1 = rand() * TAU; R.p2 = rand() * TAU;
    R.surge = 0; R.surgeT = 0.5 + rand() * 0.6; R.maxT = 0; R.zeroT = 0; R.splashT = 0.3;
    rigAnim('fish_reel', true);
    sfx('splash', { pos: FS.bobPos, vol: 0.4, pitch: 1.1 });
    fx('splash', FS.bobPos, { scale: 0.5 });
    setState('reeling');
    barZone(R.gh);
    barMode('reel', 'Reel it in!', 'Hold <b>F</b> to reel in &middot; keep the tension in the green');
    barMeter(R.tension, R.progress);
    return true;
  }
  function toggle() {
    const f = inputFrame();
    if (FS.lastToggleFrame === f && f > 0) return false;                 // exactly one path per frame
    FS.lastToggleFrame = f;
    const s = Fishing.state;
    if (s === 'idle') return start();
    if (s === 'bite') return hook();
    if (s === 'reeling' || s === 'caught') return false;                   // F is the reel input / catch is finishing
    return cancel();
  }
  function grantCatch() {
    const pl = player(); if (!pl) return;
    const c = FS.catchRes || { kind: 'junk', tid: null };
    let inst = null, extra = null, gold = 0, label = '';
    if (c.kind === 'treasure') {
      const lvl = clamp(num(pl.level, 1), 1, 80);
      gold = Math.round((isFn(G.Items, 'rollGold') ? G.Items.rollGold(lvl) : 20 + lvl * 4) * 3);
      if (isFn(G.Progress, 'addGold')) { try { G.Progress.addGold(gold); } catch (e) { report(e, 'addGold'); } } else pl.gold = num(pl.gold, 0) + gold;
      const wantCharm = itemExists(CHARM_TID) && rand() < 0.18 && !(isFn(G.Items, 'countInInventory') && G.Items.countInInventory(pl, CHARM_TID) > 0);
      if (wantCharm) inst = G.Items.create(CHARM_TID, 1);
      else if (isFn(G.Items, 'generate')) { try { inst = G.Items.generate({ level: lvl, cls: pl.cls || undefined, rarity: rand() < 0.3 ? 'rare' : 'uncommon' }); } catch (e) { report(e, 'generate'); inst = null; } }
      label = 'a sunken strongbox';
    } else if (c.tid && isFn(G.Items, 'create')) {
      inst = G.Items.create(c.tid, 1);
    }
    const added = inst ? (isFn(G.Items, 'addToInventory') ? G.Items.addToInventory(pl, inst) : false) : false;
    const name = inst ? itemName(inst) : label;
    Fishing.lastCatch = { kind: c.kind, tid: inst ? inst.tid : null, inst: inst, name: name, gold: gold };
    FS.caughtItem = inst;
    if (c.kind === 'treasure') {
      notify('You haul up a sunken strongbox: ' + fmtMoney(gold) + (inst && added ? ' and ' + name : '') + '!', 'gold');
      chat('Your line snags something heavy… a strongbox lost to the water: ' + fmtMoney(gold) + (inst && added ? ' and ' + name : '') + '.');
      sfx('coin', { vol: 0.8 });
      if (inst && added && isFn(G.UI, 'showLoot')) { try { G.UI.showLoot([inst], gold); } catch (e) { report(e, 'showLoot'); } }
      else if (isFn(G.UI, 'showLoot')) { try { G.UI.showLoot([], gold); } catch (e) { /* ignore */ } }
    } else if (c.kind === 'junk') {
      notify('You caught ' + (inst ? 'an ' + name : 'an old boot') + '. There is a fish in it.', 'info');
      chat('You fish an old boot out of the water. The fish inside declines to comment.');
      if (inst && added && isFn(G.UI, 'showLoot')) { try { G.UI.showLoot([inst]); } catch (e) { report(e, 'showLoot'); } }
    } else {
      if (inst && added) {
        notify('You caught a ' + name + '!', 'loot');
        chat('You caught a ' + name + (FS.spot ? ' at ' + FS.spot.name : '') + '.');
        if (isFn(G.UI, 'showLoot')) { try { G.UI.showLoot([inst]); } catch (e) { report(e, 'showLoot'); } }
      } else if (inst) {
        notify('Your bags are full — the ' + name + ' slips back into the water.', 'warning');
      }
    }
    if (inst && added && c.kind === 'fish') {
      if (G.state && G.state.stats) G.state.stats.fish = num(G.state.stats.fish, 0) + 1;
      if (isFn(G.Quests, 'onFish')) { try { G.Quests.onFish(inst.tid, FS.spot ? FS.spot.id : null); } catch (e) { report(e, 'Quests.onFish'); } }
    }
    // skill
    const before = skillValue();
    const gain = clamp(0.3 + 0.7 * clamp(num(c.fishLevel, 1) / 60, 0, 1) * (c.rare ? 1.5 : 1), 0.3, 1.0);
    const after = clamp(before + gain, 1, 100);
    if (G.state) G.state.fishingSkill = Math.round(after * 100) / 100;
    if (Math.floor(after / 10) > Math.floor(before / 10) || (after >= 100 && before < 100)) {
      sfx('achievement');
      notify('Your fishing skill has reached ' + Math.floor(after) + ' (' + skillLabel(after) + ').', 'level');
      chat('Fishing skill: ' + Math.floor(after) + ' — ' + skillLabel(after) + '.');
    }
    emit('fishCaught', { tid: inst ? inst.tid : null, inst: inst, kind: c.kind, name: name, added: added, spot: FS.spot ? FS.spot.id : null });
  }
  function caught() {
    const pl = player();
    sfx('fish_catch', { pos: pl ? pl.pos : null });
    fx('splash', FS.bobPos, { scale: 0.8 });
    if (FS.bubbles) { fxStop(FS.bubbles); FS.bubbles = null; }
    grantCatch();
    setState('caught');
    FS.flight = 0;
    FS.launch.copy(FS.bobPos);
    barMode('caught', FS.catchRes && FS.catchRes.kind === 'treasure' ? 'A sunken strongbox!' : 'Caught: ' + (Fishing.lastCatch ? Fishing.lastCatch.name : 'a fish'), 'Nicely done');
    barMeter(0.5, 1);
    if (pl && pl.pos) { _v3.set(pl.pos.x, pl.pos.y + num(pl.height, 1.8) * 0.75, pl.pos.z); fx('sparkle', _v3, { scale: 1.1, color: FS.catchRes && FS.catchRes.rare ? 0xc48bff : 0xfff3b0 }); }
  }
  function bite() {
    const pl = player();
    FS.catchRes = rollCatch(pl, FS.bobPos.x, FS.bobPos.z, FS.baitBonus || 0);
    sfx('fish_bite', { pos: FS.bobPos });
    fx('splash', FS.bobPos, { scale: 1.0 });
    FS.bubbles = fx('bubbles', FS.bobPos, { scale: 0.8, duration: 1.4 });
    notify('Something bites! Press F', 'quest');
    setState('bite');
    barMode('bite', 'Something bites! Press F', 'Press <b>F</b> now to set the hook');
  }
  function readInput() {
    if (!Fishing.handlesKey || !G.Input) return;
    if (typing() || uiOpen()) return;
    if (keyPressed('KeyF')) { const s = Fishing.state; if (toggle() || s !== 'idle') consumeKey('KeyF'); }
    if (Fishing.state !== 'idle') {
      for (let i = 0; i < MOVE_KEYS.length; i++) if (keyPressed(MOVE_KEYS[i])) { cancel(Fishing.state === 'reeling' ? 'You let the fish go.' : 'You reel in your line.'); break; }
    }
  }
  function update(dt) {
    dt = clamp(num(dt, 0), 0, 0.1);
    readInput();
    if (Fishing.state === 'idle') {
      if (FS.retractT > 0 && lineMesh && Fishing.bobber) {                  // line snapping back after a cancel / fail
        FS.retractT -= dt; const k = 1 - clamp(FS.retractT / RETRACT_TIME, 0, 1);
        rodTip(FS.tip); FS.bobPos.lerpVectors(FS.launch.copy(FS.bobPos), FS.tip, Math.min(1, k * 0.5 + 0.2));
        Fishing.bobber.visible = FS.retractT > 0; Fishing.bobber.position.copy(FS.bobPos);
        lineMesh.visible = FS.retractT > 0; if (lineMesh.visible) updateLine(FS.tip, FS.bobPos, 0.05);
      }
      return;
    }
    const pl = player(); const rig = rigOf(pl);
    if (!pl || !pl.pos || pl.dead || pl.alive === false || pl.mounted || pl.swimming) { cancel(false); return; }
    if (G.Boats && (G.Boats.sailing || G.Boats.travelling)) { cancel(false); return; }
    FS.t += dt;
    facePlayerToCast();
    if (pl.vel) { pl.vel.x = 0; pl.vel.z = 0; }
    const t = waveTime();
    rodTip(FS.tip);
    const wh = waveHeight(Fishing.castPoint.x, Fishing.castPoint.z, t);
    const surfaceY = SEA() + wh + 0.03;
    const bob = Fishing.bobber;
    let sag = 0.12;
    switch (Fishing.state) {
      case 'casting': {
        rigAnim('fish_cast');
        if (FS.t < FLIGHT_START) { FS.bobPos.copy(FS.tip); FS.launch.copy(FS.tip); }
        else {
          const k = clamp((FS.t - FLIGHT_START) / FLIGHT_TIME, 0, 1);
          const arcH = 1.0 + FS.launch.distanceTo(Fishing.castPoint) * 0.12;
          FS.bobPos.lerpVectors(FS.launch, Fishing.castPoint, k);
          FS.bobPos.y = lerp(FS.launch.y, surfaceY, k) + arcH * 4 * k * (1 - k);
          sag = 0.02 + 0.2 * (1 - k);
        }
        if (FS.t >= CAST_TIME) { setState('waiting'); FS.t = CAST_TIME; barMode('wait', 'Waiting for a bite… (' + skillLabel() + ')', 'Hold <b>F</b> to reel in &middot; keep the tension in the green'); }
        break;
      }
      case 'waiting': {
        if (!(rig && rig.oneShot === 'fish_cast')) rigAnim('fish_wait');
        if (!FS.landed) {
          const k = clamp((FS.t - FLIGHT_START) / FLIGHT_TIME, 0, 1);
          const arcH = 1.0 + FS.launch.distanceTo(Fishing.castPoint) * 0.12;
          FS.bobPos.lerpVectors(FS.launch, Fishing.castPoint, k);
          FS.bobPos.y = lerp(FS.launch.y, surfaceY, k) + arcH * 4 * k * (1 - k);
          sag = 0.02 + 0.2 * (1 - k);
          if (k >= 1) { FS.landed = true; fx('splash', FS.bobPos, { scale: 0.55 }); fx('water_ring', FS.bobPos, { scale: 0.6 }); sfx('splash', { pos: FS.bobPos, vol: 0.4, pitch: 1.25 }); }
        } else {
          // nibbles: quick dips with a soft plip
          let dip = 0;
          if (FS.nibbleT > 0) { FS.nibbleT -= dt; dip = 0.12 * Math.sin(PI * clamp(1 - FS.nibbleT / 0.35, 0, 1)); }
          for (let i = 0; i < FS.nibbleN; i++) if (FS.nibbleAt[i] > 0 && FS.t >= FS.nibbleAt[i]) { FS.nibbleAt[i] = -1; FS.nibbleT = 0.35; fx('water_ring', FS.bobPos, { scale: 0.35 }); sfx('splash', { pos: FS.bobPos, vol: 0.12, pitch: 1.7 }); }
          FS.rippleT -= dt;
          if (FS.rippleT <= 0) { FS.rippleT = RIPPLE_EVERY; fx('water_ring', FS.bobPos, { scale: 0.45, duration: 1.4 }); }
          FS.bobPos.set(Fishing.castPoint.x, surfaceY - dip, Fishing.castPoint.z);
          bob.rotation.z = 0.16 * Math.sin(t * 2.3); bob.rotation.x = 0.1 * Math.sin(t * 1.7 + 1);
          if (FS.t >= FS.waitT) bite();
        }
        break;
      }
      case 'bite': {
        rigAnim('fish_wait');
        FS.dive = damp(FS.dive, 0.34, 14, dt);
        FS.wobble += dt * 18;
        FS.bobPos.set(Fishing.castPoint.x + 0.06 * Math.sin(FS.wobble), surfaceY - FS.dive, Fishing.castPoint.z + 0.06 * Math.cos(FS.wobble * 1.3));
        bob.rotation.z = 0.45 * Math.sin(FS.wobble); bob.rotation.x = 0.35 * Math.cos(FS.wobble * 0.8);
        if (FS.bubbles && FS.bubbles.pos) FS.bubbles.pos.copy(FS.bobPos);
        if (Fishing.autoActive && FS.t >= 0.15) { hook(); break; }
        if (FS.t >= BITE_WINDOW) { fail('The fish got away.'); return; }
        break;
      }
      case 'reeling': {
        rigAnim('fish_reel');
        const R = FS.reel; R.t += dt;
        if (Fishing.autoActive) { R.tension = damp(R.tension, 0.5, 8, dt); }
        else {
          const hold = keyDown('KeyF');
          R.surgeT -= dt;
          if (R.surgeT <= 0) { R.surge = (rand() - 0.5) * 2 * R.amp * 0.9; R.surgeT = 0.5 + rand() * 0.9; } else R.surge *= Math.exp(-3 * dt);
          const pull = R.amp * (0.6 * Math.sin(R.t * R.w1 + R.p1) + 0.4 * Math.sin(R.t * R.w2 + R.p2)) + R.surge;
          R.tension = clamp(R.tension + ((hold ? 0.85 : -0.62) + pull) * dt, 0, 1);
        }
        const inGreen = Math.abs(R.tension - 0.5) <= R.gh;
        if (inGreen) R.progress = Math.min(1, R.progress + dt / R.dur);
        else if (R.tension > 0.85 || R.tension < 0.15) R.progress = Math.max(0, R.progress - dt * 0.12);
        if (R.tension >= 0.995) { R.maxT += dt; if (R.maxT >= LINE_SNAP_TIME) { fail('Your line snaps!'); return; } } else R.maxT = Math.max(0, R.maxT - dt * 2);
        if (R.tension <= 0.005) { R.zeroT += dt; if (R.zeroT >= SLACK_TIME) { fail('The fish got away.'); return; } } else R.zeroT = 0;
        barMeter(R.tension, R.progress);
        // the fish is dragged toward the angler as progress fills; it thrashes about
        FS.wobble += dt * (8 + R.tension * 10);
        const toward = R.progress * 0.55;
        FS.bobPos.set(lerp(Fishing.castPoint.x, FS.tip.x, toward) + 0.25 * Math.sin(FS.wobble), surfaceY - 0.1 - 0.15 * Math.abs(Math.sin(FS.wobble * 0.7)), lerp(Fishing.castPoint.z, FS.tip.z, toward) + 0.25 * Math.cos(FS.wobble * 0.9));
        bob.rotation.z = 0.6 * Math.sin(FS.wobble); bob.rotation.x = 0.4 * Math.cos(FS.wobble * 1.1);
        R.splashT -= dt;
        if (R.splashT <= 0) { R.splashT = 0.35 + rand() * 0.5; fx('water_ring', FS.bobPos, { scale: 0.5 }); if (R.tension > 0.7) { fx('splash', FS.bobPos, { scale: 0.35 }); sfx('splash', { pos: FS.bobPos, vol: 0.18, pitch: 1.3 }); } }
        sag = 0.03 + (1 - R.tension) * 0.12;
        if (R.progress >= 1) { caught(); return; }
        break;
      }
      case 'caught': {
        rigAnim('fish_reel');
        const k = clamp(FS.t / 0.55, 0, 1);
        FS.bobPos.lerpVectors(FS.launch, FS.tip, k);
        FS.bobPos.y = lerp(FS.launch.y, FS.tip.y, k) + 1.2 * 4 * k * (1 - k);
        sag = 0.02;
        if (FS.t >= CAUGHT_TIME) { finish(true); return; }
        break;
      }
      default: break;
    }
    bob.position.copy(FS.bobPos);
    updateLine(FS.tip, FS.bobPos, sag);
  }
  function autoFish() {
    Fishing.autoActive = true;
    if (Fishing.state === 'idle') { const ok = start(); if (!ok) Fishing.autoActive = false; return ok; }
    return true;
  }
  function fishingInit() {
    if (FS.inited) return; FS.inited = true;
    if (typeof G.on !== 'function') return;
    G.on('playerDeath', function () { if (Fishing.state !== 'idle') cancel(false); });
    G.on('gameStart', function () { if (Fishing.state !== 'idle') cancel(false); });
    G.on('load', function () { if (Fishing.state !== 'idle') cancel(false); });
  }
  Fishing.canFish = canFish;
  Fishing.start = start;
  Fishing.toggle = toggle;
  Fishing.cancel = cancel;
  Fishing.update = update;
  Fishing.isFishing = function () { return Fishing.state !== 'idle'; };
  Fishing.autoFish = autoFish;
  Fishing.skillLevel = function () { return skillLabel(skillValue()); };
  Fishing.skillLabel = skillLabel;
  Fishing.catchTable = function (x, z) { return catchTable(num(x, 0), num(z, 0)).slice(); };
  Fishing.resolveFishTid = resolveFishTid;
  Fishing.rodTip = function (out) { return rodTip(out || new THREE.Vector3()); };
  Fishing.waitTime = function () { return waitTime(player(), 0); };
  Fishing.init = fishingInit;
  Fishing.group = root;
  if (typeof G.on === 'function') G.on('init', fishingInit);
