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
  const FISH_LEVEL = { fish_brandywine_trout: 1, fish_bywater_perch: 1, fish_midgewater_eel: 12, fish_lune_herring: 8, fish_hoarwell_grayling: 25, fish_nenuial_pike: 38, fish_evendim_salmon: 40, fish_golden_carp: 45, fish_forochel_icecod: 62, fish_tolfuin_seabass: 68, fish_himling_sturgeon: 74, fish_silver_trout: 20 };
  function fishLevelOf(tid) {
    const t = G.Data && G.Data.items && G.Data.items[tid]; if (!t) return 1;
    if (typeof t.fishLevel === 'number') return t.fishLevel;
    if (FISH_LEVEL[tid] != null) return FISH_LEVEL[tid];
    if (typeof t.value === 'number' && t.type === 'fish') return clamp(Math.round(t.value * 0.5), 1, 80);   // vendor value tracks difficulty
    return num(t.level, 1);
  }
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
    const top = new THREE.SphereGeometry(0.115, 14, 8, 0, TAU, 0, PI / 2);
    const tip = new THREE.SphereGeometry(0.028, 8, 6); tip.translate(0, 0.3, 0);
    const bot = new THREE.SphereGeometry(0.115, 14, 8, 0, TAU, PI / 2, PI / 2);
    const stem = new THREE.CylinderGeometry(0.012, 0.016, 0.22, 6); stem.translate(0, 0.18, 0);
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
    if (Fishing.autoActive) FS.waitT = Math.min(FS.waitT, 2.0);           // the auto angler never sits through a long wait
    FS.nibbleN = rand() < 0.55 ? (rand() < 0.4 ? 2 : 1) : 0;
    FS.nibbleAt[0] = CAST_TIME + 0.7 + rand() * Math.max(0.2, FS.waitT - 1.2); FS.nibbleAt[1] = CAST_TIME + 0.7 + rand() * Math.max(0.2, FS.waitT - 1.2);
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
    if (Fishing.autoActive) R.dur = Math.min(R.dur, 2.0);                 // a perfect angler lands it briskly
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
  /** Largest step the fishing clock accepts per frame: the main loop clamps raw dt to 0.05 s and multiplies by
   *  G.time.scale, so clamping at a flat 0.1 would silently run the cycle at half speed under time ×4 (bots, verification). */
  function maxStep() { const sc = (G.time && G.time.scale > 0) ? G.time.scale : 1; return clamp(0.05 * sc, 0.1, 0.5); }
  function update(dt) {
    dt = clamp(num(dt, 0), 0, maxStep());
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
          if (FS.t >= CAST_TIME + FS.waitT) bite();
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

  // ================================================================================================ BOATS
  const GRID_CELL = 64, TRAVEL_TIME = 9, FADE_T = 0.6;
  const ROW_MAX = 9, ROW_REV = 3, ROW_ACCEL = 3.2, ROW_BRAKE = 4.5, ROW_DRAG = 0.55, TURN_RATE = 1.35;
  const DRAFT_ROW = 0.10, DRAFT_SHIP = 0.16, DISEMBARK_R = 8, MOOR_BUILD = 380, MOOR_DISPOSE = 480, RETIRE_T = 30, RETIRE_FADE = 2.2;
  const HULL_L = { rowboat: 2.1, elfship: 3.9, ferry: 3.3 }, HULL_W = { rowboat: 0.95, elfship: 1.2, ferry: 1.8 };
  const Boats = { sailing: false, travelling: false, boat: null, speed: 0, travel: null, docks: [], group: root };
  G.Boats = Boats;
  const BS = {
    inited: false, subscribed: false, recs: [], byId: {}, ents: [], cur: null, retired: [], travel: null,
    moorT: 0, wakeT: 0, splashT: 0, creakT: 3, oarT: 0, shoreT: 0, shoreNear: false, hint: null, hintText: '',
    menuDock: null, menuRegistered: false, sceneArg: null, camYaw: 0,
  };
  const _shore = { x: 0, z: 0, d: 0 };
  const _rally = { x: 0, z: 0 };

  function recOf(x) {
    if (!x) return null;
    if (typeof x === 'string') return BS.byId[x] || null;
    if (typeof x === 'object') { if (x.data && x.id && BS.byId[x.id] === x) return x; if (x.id && BS.byId[x.id]) return BS.byId[x.id]; if (x.dock && x.dock.id && BS.byId[x.dock.id]) return BS.byId[x.dock.id]; }
    return null;
  }
  function pierDir(rec) {
    const b = rec.data.building, e = b && b.dockEnd;
    if (e && typeof e.x === 'number') { const dx = e.x - rec.pos.x, dz = e.z - rec.pos.z; if (dx * dx + dz * dz > 0.25) return Math.atan2(dx, dz); }
    return rec.yaw + PI;                                                     // forward of yaw = (sin a, cos a) with a = yaw + π
  }
  function pierEnd(rec, out) {
    const b = rec.data.building, e = b && b.dockEnd;
    if (e && typeof e.x === 'number') { out.x = e.x; out.z = e.z; return out; }
    const a = pierDir(rec); out.x = rec.pos.x + Math.sin(a) * 12; out.z = rec.pos.z + Math.cos(a) * 12; return out;
  }
  const _pe = { x: 0, z: 0 };
  function waterSide(rec) {
    if (rec.water && rec.waterHadBuilding === !!rec.data.building) return rec.water;
    const a = pierDir(rec), sx = Math.sin(a), cz = Math.cos(a);
    pierEnd(rec, _pe);
    let found = null;
    for (let r = 0; r <= 40 && !found; r += 2) { const x = _pe.x + sx * r, z = _pe.z + cz * r; if (depth(x, z) >= 1.6) found = { x: x, z: z, dir: a }; }
    if (!found) {                                                           // 16 directions from the dock position
      let bestD = 0, bx = 0, bz = 0, ba = a;
      for (let i = 0; i < 16; i++) {
        const ang = i / 16 * TAU;
        for (let r = 4; r <= 30; r += 2) { const x = rec.pos.x + Math.sin(ang) * r, z = rec.pos.z + Math.cos(ang) * r; const d = depth(x, z); if (d >= 1.6) { if (d > bestD || (bestD < 1.6)) { bestD = d; bx = x; bz = z; ba = ang; } break; } }
        if (bestD >= 1.6) break;
      }
      found = bestD >= 1.6 ? { x: bx, z: bz, dir: ba } : { x: _pe.x + sx * 8, z: _pe.z + cz * 8, dir: a };
    }
    rec.water = found; rec.waterHadBuilding = !!rec.data.building;
    return found;
  }
  function moorPoint(rec) {
    const w = waterSide(rec), a = w.dir, rx = Math.cos(a), rz = -Math.sin(a);
    let side = 1;
    if (depth(w.x - rx * 2.6, w.z - rz * 2.6) > depth(w.x + rx * 2.6, w.z + rz * 2.6)) side = -1;
    let x = w.x + rx * 2.6 * side, z = w.z + rz * 2.6 * side;
    if (depth(x, z) < 1.2) { x = w.x + Math.sin(a) * 3; z = w.z + Math.cos(a) * 3; }
    if (depth(x, z) < 1.2) { x = w.x; z = w.z; }
    return { x: x, z: z, yaw: wrapA(a + PI) };
  }
  function outOfWorld(x, z) { const lim = worldSize() * 0.5 - 8; return x < -lim || x > lim || z < -lim || z > lim; }

  // ---- dock entities
  function placeDockEntity(rec) {
    const d = rec.data, ent = rec.ent; if (!ent) return;
    const a = pierDir(rec); pierEnd(rec, _pe);
    let x = _pe.x - Math.sin(a) * 4.5, z = _pe.z - Math.cos(a) * 4.5;
    if (!d.building) { x = rec.pos.x + Math.sin(a) * 5; z = rec.pos.z + Math.cos(a) * 5; }
    const y = typeof d.deckY === 'number' ? d.deckY : Math.max(groundY(x, z), SEA() + 0.5);
    ent.pos.set(x, y, z); ent.yaw = rec.yaw;
    rec.placedWithBuilding = !!d.building; rec.placed = true;
    if (G.Spatial && isFn(G.Spatial, 'update')) G.Spatial.update(ent);
  }
  function openDock(rec) {
    const U = G.UI;
    if (U && U.Travel && isFn(U.Travel, 'openDock')) { try { U.Travel.openDock(rec.data, rec.ent); return true; } catch (e) { report(e, 'Travel.openDock'); } }
    return openDockMenu(rec);
  }
  function subscribe() {
    if (BS.subscribed || typeof G.on !== 'function') return; BS.subscribed = true;
    G.on('playerDeath', function () { if (Boats.sailing) disembark(true); });
    const reset = function () { if (Boats.sailing) endSail(true, true); if (Boats.travelling) { abortTravel(); } for (let i = BS.retired.length - 1; i >= 0; i--) removeBoat(BS.retired[i].ent); BS.retired.length = 0; };
    G.on('gameStart', function () { if (!BS.inited) init(); reset(); });
    G.on('load', reset);
  }
  function init(scene) {
    subscribe();
    BS.sceneArg = (scene && scene.isScene) ? scene : null;
    attachRoot(BS.sceneArg);
    for (let i = 0; i < BS.ents.length; i++) { if (isFn(G, 'removeEntity')) G.removeEntity(BS.ents[i]); }
    for (let i = 0; i < BS.recs.length; i++) disposeMoor(BS.recs[i]);
    BS.ents.length = 0; BS.recs.length = 0; BS.byId = {};
    const W = world(); const docks = (W && Array.isArray(W.docks)) ? W.docks : [];
    for (let i = 0; i < docks.length; i++) {
      const d = docks[i]; if (!d || !d.id || !d.pos) continue;
      const rec = { id: String(d.id), name: d.name || 'Dock', town: d.town || null, data: d, pos: { x: num(d.pos.x, 0), z: num(d.pos.z, 0) }, yaw: num(d.yaw, 0), routes: Array.isArray(d.routes) ? d.routes.slice() : [], ent: null, water: null, moor: null, placed: false };
      const ent = { id: 'dock:' + rec.id, kind: 'dock', name: rec.name, pos: new THREE.Vector3(rec.pos.x, 0, rec.pos.z), vel: new THREE.Vector3(), yaw: rec.yaw, radius: 1.2, height: 2, alive: true, dock: d,
        interact: { label: 'Sail from ' + rec.name, range: 5, fn: function () { return openDock(rec); } } };
      rec.ent = ent;
      if (isFn(G, 'addEntity')) G.addEntity(ent);
      BS.ents.push(ent); BS.recs.push(rec); BS.byId[rec.id] = rec;
      placeDockEntity(rec);
    }
    Boats.docks = docks;
    BS.inited = true;
    return BS.recs.length;
  }

  // ---- boat spawning / placement
  function spawnBoat(kind, x, z, yaw) {
    let b = null;
    if (isFn(G.Chars, 'buildBoat')) { try { b = G.Chars.buildBoat(kind); } catch (e) { report(e, 'buildBoat'); b = null; } }
    if (!b || !b.group) {
      const g = new THREE.Group(); const hull = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.5, 3.6), new THREE.MeshStandardMaterial({ color: 0x8a6a42 })); hull.position.y = 0.1; g.add(hull);
      const seat = new THREE.Group(); seat.position.set(0, 0.35, 0.1); g.add(seat);
      b = { group: g, seat: seat, mast: null, oars: [], animate: function () { }, dispose: function () { if (g.parent) g.parent.remove(g); hull.geometry.dispose(); hull.material.dispose(); } };
    }
    b.group.position.set(x, SEA(), z); b.group.rotation.set(0, yaw, 0);
    root.add(b.group);
    const ent = { id: isFn(G, 'uid') ? G.uid() : 'boat' + Math.floor(rand() * 1e9), kind: 'boat', name: kind === 'elfship' ? 'Elven Ship' : kind === 'ferry' ? 'Ferry' : 'Rowboat',
      pos: new THREE.Vector3(x, SEA(), z), vel: new THREE.Vector3(), yaw: yaw, radius: kind === 'elfship' ? 2.5 : 1.2, height: 1.6, alive: true,
      mesh: b.group, boat: b, boatKind: kind, speed: 0, throttle: 0, steer: 0, roll: 0, pitch: 0 };
    if (isFn(G, 'addEntity')) G.addEntity(ent);
    placeBoat(ent, 0);
    return ent;
  }
  function removeBoat(ent) {
    if (!ent) return;
    const b = ent.boat;
    if (ent._fadeMats) { for (let i = 0; i < ent._fadeMats.length; i++) ent._fadeMats[i].dispose(); ent._fadeMats = null; }
    if (b && isFn(b, 'dispose')) { try { b.dispose(); } catch (e) { /* ignore */ } }
    if (b && b.group && b.group.parent) b.group.parent.remove(b.group);
    if (isFn(G, 'removeEntity')) G.removeEntity(ent);
    ent.boat = null; ent.mesh = null;
  }
  function placeBoat(ent, dt) {
    const g = ent.mesh; if (!g) return;
    const t = waveTime();
    waveAt(ent.pos.x, ent.pos.z, t);
    const draft = ent.boatKind === 'elfship' ? DRAFT_SHIP : DRAFT_ROW;
    const y = SEA() + wave.h - draft;
    ent.pos.y = y;
    const fx_ = -Math.sin(ent.yaw), fz = -Math.cos(ent.yaw), rx = Math.cos(ent.yaw), rz = -Math.sin(ent.yaw);
    const slopeF = wave.dx * fx_ + wave.dz * fz, slopeR = wave.dx * rx + wave.dz * rz;
    const maxV = ent.boatKind === 'elfship' ? 60 : ROW_MAX;
    const tp = Math.atan(slopeF) * 0.8 + clamp(ent.speed / maxV, -1, 1) * 0.045;
    const trl = Math.atan(slopeR) * 0.8 + num(ent.steer, 0) * clamp(Math.abs(ent.speed) / maxV, 0, 1) * 0.11;
    if (dt > 0) { ent.pitch = damp(ent.pitch, tp, 4, dt); ent.roll = damp(ent.roll, trl, 4, dt); } else { ent.pitch = tp; ent.roll = trl; }
    g.position.set(ent.pos.x, y, ent.pos.z);
    g.rotation.set(ent.pitch, ent.yaw, ent.roll, 'YXZ');
    g.updateMatrixWorld(true);
  }
  function seatPlayer(ent) {
    const pl = player(); if (!pl || !pl.pos || !ent.boat || !ent.boat.seat) return;
    ent.boat.seat.getWorldPosition(_v1);
    pl.pos.set(_v1.x, _v1.y - 0.08, _v1.z);
    pl.yaw = ent.yaw;
    if (pl.vel) pl.vel.set(0, 0, 0);
    pl.onGround = true; pl.swimming = false; pl.inWater = false; pl.sliding = false;
    if (pl.mesh) { pl.mesh.position.copy(pl.pos); pl.mesh.rotation.set(0, pl.yaw, 0); pl.mesh.updateMatrixWorld(true); }
    if (G.Spatial && isFn(G.Spatial, 'update')) G.Spatial.update(pl);
    rigAnim('sit');
  }
  function retireBoat(ent) { if (!ent) return; ent.speed = 0; ent.steer = 0; BS.retired.push({ ent: ent, t: 0, fading: false }); }
  function updateRetired(dt) {
    for (let i = BS.retired.length - 1; i >= 0; i--) {
      const r = BS.retired[i], ent = r.ent; r.t += dt;
      if (!ent || !ent.mesh) { BS.retired.splice(i, 1); continue; }
      placeBoat(ent, dt);
      if (r.t >= RETIRE_T - RETIRE_FADE) {
        if (!r.fading) {
          r.fading = true; const mats = [];
          ent.mesh.traverse(function (o) { if (o.isMesh && o.material && !o.material.userData.fadeClone) { const m = o.material.clone(); m.transparent = true; m.userData.fadeClone = true; o.material = m; mats.push(m); } });
          ent._fadeMats = mats;
        }
        const op = clamp((RETIRE_T - r.t) / RETIRE_FADE, 0, 1);
        if (ent._fadeMats) for (let k = 0; k < ent._fadeMats.length; k++) ent._fadeMats[k].opacity = op;
      }
      if (r.t >= RETIRE_T) { removeBoat(ent); BS.retired.splice(i, 1); }
    }
  }
  function disposeMoor(rec) {
    if (!rec || !rec.moor) return;
    const b = rec.moor.boat;
    if (b && isFn(b, 'dispose')) { try { b.dispose(); } catch (e) { /* ignore */ } }
    if (b && b.group && b.group.parent) b.group.parent.remove(b.group);
    rec.moor = null;
  }
  function updateMoored(dt) {
    const pl = player();
    BS.moorT -= dt;
    if (BS.moorT <= 0) {
      BS.moorT = 0.5;
      for (let i = 0; i < BS.recs.length; i++) {
        const rec = BS.recs[i];
        if (!rec.placed || (rec.placedWithBuilding !== !!rec.data.building)) placeDockEntity(rec);
        if (!pl || !pl.pos) continue;
        const d = Math.hypot(rec.pos.x - pl.pos.x, rec.pos.z - pl.pos.z);
        if (d < MOOR_BUILD && !rec.moor && isFn(G.Chars, 'buildBoat')) {
          let b = null; try { b = G.Chars.buildBoat('rowboat'); } catch (e) { report(e, 'moorBoat'); }
          if (b && b.group) { const mp = moorPoint(rec); rec.moor = { boat: b, x: mp.x, z: mp.z, yaw: mp.yaw, roll: 0, pitch: 0, hidden: false }; b.group.position.set(mp.x, SEA(), mp.z); b.group.rotation.set(0, mp.yaw, 0); root.add(b.group); }
        } else if (d > MOOR_DISPOSE && rec.moor) disposeMoor(rec);
      }
    }
    const t = waveTime();
    for (let i = 0; i < BS.recs.length; i++) {
      const m = BS.recs[i].moor; if (!m) continue;
      const g = m.boat.group; g.visible = !m.hidden; if (m.hidden) continue;
      waveAt(m.x, m.z, t);
      const fx_ = -Math.sin(m.yaw), fz = -Math.cos(m.yaw), rx = Math.cos(m.yaw), rz = -Math.sin(m.yaw);
      m.pitch = damp(m.pitch, Math.atan(wave.dx * fx_ + wave.dz * fz) * 0.7, 3, dt); m.roll = damp(m.roll, Math.atan(wave.dx * rx + wave.dz * rz) * 0.7, 3, dt);
      g.position.set(m.x, SEA() + wave.h - DRAFT_ROW, m.z);
      g.rotation.set(m.pitch, m.yaw, m.roll, 'YXZ');
    }
  }

  // ---- sailing hint (tiny HUD line)
  const HINT_CSS = '#boatHint{position:absolute;left:50%;bottom:168px;transform:translateX(-50%);padding:6px 14px;background:var(--glass,rgba(10,8,5,.65));border:1px solid var(--border,#6f5322);border-radius:var(--radius,6px);color:var(--parch,#e8dcc0);font-family:var(--font-ui,Georgia,serif);font-size:13px;pointer-events:none;z-index:29;white-space:nowrap}#boatHint b{color:var(--gold,#d4af5a)}#boatHint.bh-hidden{display:none}';
  let hintCss = false;
  function ensureHint() {
    if (BS.hint || typeof document === 'undefined') return BS.hint;
    if (!hintCss) { hintCss = true; if (isFn(G.UI, 'addCSS')) { try { G.UI.addCSS(HINT_CSS); } catch (e) { report(e, 'addCSS'); } } else { const s = document.createElement('style'); s.textContent = HINT_CSS; (document.head || document.documentElement).appendChild(s); } }
    BS.hint = el('div', { id: 'boatHint', class: 'bh-hidden' });
    const host = document.getElementById('hud') || document.getElementById('overlays') || document.body;
    if (host) host.appendChild(BS.hint);
    return BS.hint;
  }
  function showHint(html) { const h = ensureHint(); if (!h) return; if (html !== BS.hintText) { BS.hintText = html; h.innerHTML = html; } h.classList.remove('bh-hidden'); }
  function hideHint() { if (BS.hint) { BS.hint.classList.add('bh-hidden'); BS.hintText = ''; } }

  // ---- shore search (reused result object)
  function nearShore(pos, r) {
    if (!pos) return null;
    let best = null, bd = Infinity;
    const R = num(r, DISEMBARK_R);
    for (let i = 0; i < 16; i++) {
      const ang = i / 16 * TAU, sx = Math.sin(ang), cz = Math.cos(ang);
      for (let d = 2; d <= R + 0.001; d += 2) {
        const x = pos.x + sx * d, z = pos.z + cz * d;
        if (isWater(x, z)) { if (depth(x, z) < 1.5 && d + 2 > R) { /* shallow at the edge of the search: keep looking for actual land */ } continue; }
        if (!slopeOk(x, z)) break;
        if (d < bd) { bd = d; _shore.x = x; _shore.z = z; _shore.d = d; best = _shore; }
        break;
      }
    }
    return best;
  }
  function boardPoint(rec) {
    const w = waterSide(rec), a = w.dir, rx = Math.cos(a), rz = -Math.sin(a);
    let side = 1;
    if (depth(w.x - rx * 2.4, w.z - rz * 2.4) > depth(w.x + rx * 2.4, w.z + rz * 2.4)) side = -1;
    const yaw = wrapA(a + PI), sx = Math.sin(a), cz = Math.cos(a);
    for (let r = 0; r <= 16; r += 1) {
      const x = w.x + sx * r + rx * 2.4 * side, z = w.z + cz * r + rz * 2.4 * side;
      if (hullFits(x, z, yaw, 'rowboat')) return { x: x, z: z, yaw: yaw };
      if (hullFits(w.x + sx * r, w.z + cz * r, yaw, 'rowboat')) return { x: w.x + sx * r, z: w.z + cz * r, yaw: yaw };
    }
    return { x: w.x + sx * 6, z: w.z + cz * 6, yaw: yaw };
  }

  // ---- free sailing
  function board(dock) {
    if (Boats.travelling) return false;
    const pl = player(); if (!pl || !pl.pos || pl.dead || pl.alive === false) return false;
    if (Boats.sailing) return true;
    let rec = recOf(dock);
    if (!rec) rec = nearestRec(pl.pos, null);
    if (!rec) { notify('There is no boat to be had here.', 'warning'); return false; }
    if (pl.mounted && isFn(G.Player, 'dismount')) { try { G.Player.dismount(); } catch (e) { report(e, 'dismount'); } }
    if (G.Fishing && G.Fishing.state !== 'idle') G.Fishing.cancel(false);
    if (isFn(G.Player, 'autoStop')) { try { G.Player.autoStop(); } catch (e) { /* ignore */ } }
    attachRoot();
    const bp = boardPoint(rec);
    const ent = spawnBoat('rowboat', bp.x, bp.z, bp.yaw);
    BS.cur = { ent: ent, rec: rec, kind: 'rowboat' };
    Boats.boat = ent; Boats.sailing = true; Boats.speed = 0; pl.onBoat = ent;
    if (rec.moor) rec.moor.hidden = true;
    BS.creakT = 4 + rand() * 3; BS.wakeT = 0; BS.splashT = 0; BS.shoreT = 0; BS.shoreNear = false;
    rigAnim('sit', true);
    placeBoat(ent, 0); seatPlayer(ent);
    const cam = G.Player && G.Player.cam; if (cam) { cam.yaw = ent.yaw; if (num(cam.targetDist, 0) < 5) cam.targetDist = 7; }
    music('sailing');
    sfx('boat_creak', { pos: ent.pos, vol: 0.8 }); sfx('splash', { pos: ent.pos, vol: 0.35, pitch: 0.9 });
    notify('You push off from ' + rec.name + '. W/S to row, A/D to steer, E near the shore to land.', 'info');
    chat('You take a rowboat from ' + rec.name + '.');
    showHint('<b>W</b>/<b>S</b> row &middot; <b>A</b>/<b>D</b> steer &middot; <b>E</b> near the shore to land');
    emit('boarded', ent);
    return true;
  }
  function endSail(silent, removeNow) {
    const cur = BS.cur;
    const pl = player();
    if (pl) { pl.onBoat = null; if (pl.vel) pl.vel.set(0, 0, 0); }
    if (cur) {
      if (removeNow) removeBoat(cur.ent); else retireBoat(cur.ent);
      if (cur.rec && cur.rec.moor) cur.rec.moor.hidden = false;
    }
    BS.cur = null; Boats.boat = null; Boats.sailing = false; Boats.speed = 0;
    hideHint();
    if (!silent) rigAnim('idle', true);
  }
  function placePlayerOnLand(x, z, yaw) {
    const pl = player(); if (!pl) return;
    if (isFn(G.Player, 'spawnAt')) { try { G.Player.spawnAt(x, z, yaw); return; } catch (e) { report(e, 'spawnAt'); } }
    if (isFn(G.Player, 'teleport')) { try { G.Player.teleport(x, z, yaw); return; } catch (e) { report(e, 'teleport'); } }
    let fx_ = x, fz = z, fy;
    if (isFn(G.Physics, 'nearestFree')) { const f = G.Physics.nearestFree(x, z, num(pl.radius, 0.4)); if (f) { fx_ = num(f.x, x); fz = num(f.z, z); } }
    fy = groundY(fx_, fz);
    pl.pos.set(fx_, fy, fz); if (pl.vel) pl.vel.set(0, 0, 0); pl.onGround = true; pl.swimming = false; pl.inWater = false;
    if (typeof yaw === 'number') pl.yaw = wrapA(yaw);
    if (pl.mesh) { pl.mesh.position.copy(pl.pos); pl.mesh.rotation.set(0, pl.yaw, 0); }
    if (G.Spatial && isFn(G.Spatial, 'update')) G.Spatial.update(pl);
  }
  function disembark(force) {
    if (!Boats.sailing || !BS.cur) return false;
    const ent = BS.cur.ent, pl = player(); if (!pl) { endSail(true, true); return false; }
    let shore = nearShore(ent.pos, DISEMBARK_R);
    if (!shore && !force) { notify('You are too far from the shore to land here.', 'warning'); sfx('ui_error', { vol: 0.4 }); return false; }
    let tx, tz;
    if (shore) { tx = shore.x; tz = shore.z; }
    else {
      const s2 = nearShore(ent.pos, 60);
      if (s2) { tx = s2.x; tz = s2.z; }
      else { const rec = BS.cur.rec; const rp = rec ? rallyOf(rec) : null; tx = rp ? rp.x : ent.pos.x; tz = rp ? rp.z : ent.pos.z; }
    }
    const yaw = yawTo(tx - ent.pos.x, tz - ent.pos.z);
    const originRec = BS.cur.rec;
    endSail(false, false);
    rigAnim('idle', true);
    placePlayerOnLand(tx, tz, yaw);
    sfx('splash', { pos: pl.pos, vol: 0.35, pitch: 1.1 });
    fx('splash', ent.pos, { scale: 0.5 });
    notify('You step ashore.', 'info');
    chat('You bring the rowboat in and step ashore' + (originRec ? ' (from ' + originRec.name + ')' : '') + '.');
    restoreZoneMusic();
    emit('disembarked');
    return true;
  }
  function updateSail(dt) {
    const cur = BS.cur; if (!cur || !cur.ent || !cur.ent.mesh) { endSail(true, true); return; }
    const ent = cur.ent, pl = player();
    if (!pl || !pl.pos) { endSail(true, true); return; }
    if (pl.dead || pl.alive === false) { disembark(true); return; }
    const free = !typing() && !uiOpen();
    let thr = 0, steer = 0;
    if (free) {
      if (keyDown('KeyW') || keyDown('ArrowUp')) thr += 1;
      if (keyDown('KeyS') || keyDown('ArrowDown')) thr -= 1;
      if (keyDown('KeyA') || keyDown('ArrowLeft')) steer += 1;
      if (keyDown('KeyD') || keyDown('ArrowRight')) steer -= 1;
      if (keyPressed('KeyE')) { consumeKey('KeyE'); if (disembark(false)) return; }
    }
    let v = ent.speed;
    if (thr > 0) v += ROW_ACCEL * dt * (v < 0 ? 1.6 : 1);
    else if (thr < 0) v -= (v > 0 ? ROW_BRAKE : ROW_ACCEL * 0.6) * dt;
    v *= Math.exp(-ROW_DRAG * dt * (thr === 0 ? 1.4 : 1));
    v = clamp(v, -ROW_REV, ROW_MAX);
    if (thr === 0 && Math.abs(v) < 0.05) v = 0;
    const tr = TURN_RATE * clamp(Math.abs(v) / 4, 0.3, 1) * (v < -0.2 ? -1 : 1);
    if (steer) ent.yaw = wrapA(ent.yaw + steer * tr * dt);
    ent.steer = damp(ent.steer, steer, 6, dt); ent.throttle = thr;
    const fx_ = -Math.sin(ent.yaw), fz = -Math.cos(ent.yaw), rx = Math.cos(ent.yaw), rz = -Math.sin(ent.yaw);
    const nx = ent.pos.x + fx_ * v * dt, nz = ent.pos.z + fz * v * dt;
    const L = HULL_L[ent.boatKind] || 2.1, Wd = HULL_W[ent.boatKind] || 0.95;
    let blocked = outOfWorld(nx, nz);
    if (!blocked && v !== 0) {
      const dNew = hullDepth(nx, nz, fx_, fz, rx, rz, L, Wd);
      if (dNew < 1.0) { const dOld = hullDepth(ent.pos.x, ent.pos.z, fx_, fz, rx, rz, L, Wd); blocked = !(dNew > dOld + 1e-4); }   // escaping the shallows is allowed
    }
    if (blocked) {
      if (Math.abs(v) > 1.2) {
        sfx('boat_creak', { pos: ent.pos, vol: 0.9, pitch: 1.1 });
        _v2.set(ent.pos.x + fx_ * L * (v > 0 ? 1 : -1), SEA() + 0.05, ent.pos.z + fz * L * (v > 0 ? 1 : -1));
        fx('splash', _v2, { scale: 0.45 });
      }
      v = -v * 0.35;                                                           // bump back off the shallows
    } else { ent.pos.x = nx; ent.pos.z = nz; }
    ent.speed = v; Boats.speed = v; ent.vel.set(fx_ * v, 0, fz * v);
    placeBoat(ent, dt); seatPlayer(ent);
    if (G.Spatial && isFn(G.Spatial, 'update')) G.Spatial.update(ent);
    wakeFX(ent, dt, fx_, fz, L);
    // oars
    if (Math.abs(v) > 0.3 && ent.boat && isFn(ent.boat, 'animate')) { BS.oarT += dt * (0.6 + Math.abs(v) / ROW_MAX * 1.4); ent.boat.animate(BS.oarT); }
    // chase camera (mouse-look is disabled by the Player module while sailing)
    const cam = G.Player && G.Player.cam;
    if (cam) cam.yaw = adamp(cam.yaw, ent.yaw, Math.abs(v) > 0.5 ? 2.4 : 0.9, dt);
    // creaks
    BS.creakT -= dt;
    if (BS.creakT <= 0) { BS.creakT = 4 + rand() * 5; if (Math.abs(v) > 0.5) sfx('boat_creak', { pos: ent.pos, vol: 0.5 }); }
    // shore hint (4 Hz)
    BS.shoreT -= dt;
    if (BS.shoreT <= 0) { BS.shoreT = 0.25; BS.shoreNear = !!nearShore(ent.pos, DISEMBARK_R); }
    showHint(BS.shoreNear ? 'Press <b>E</b> to go ashore' : '<b>W</b>/<b>S</b> row &middot; <b>A</b>/<b>D</b> steer &middot; <b>E</b> near the shore to land');
  }
  function hullDepth(x, z, fx_, fz, rx, rz, L, Wd) {                       // shallowest of the bow / stern / port / starboard probes
    let d = depth(x + fx_ * L, z + fz * L), e = depth(x - fx_ * L * 0.9, z - fz * L * 0.9); if (e < d) d = e;
    e = depth(x + rx * Wd, z + rz * Wd); if (e < d) d = e; e = depth(x - rx * Wd, z - rz * Wd); if (e < d) d = e;
    return d;
  }
  function hullFits(x, z, yaw, kind) { const L = HULL_L[kind] || 2.1, Wd = HULL_W[kind] || 0.95; return depth(x, z) >= 1.2 && hullDepth(x, z, -Math.sin(yaw), -Math.cos(yaw), Math.cos(yaw), -Math.sin(yaw), L, Wd) >= 1.05; }
  function wakeFX(ent, dt, fx_, fz, L) {
    const v = ent.speed;
    BS.wakeT -= dt; BS.splashT -= dt;
    if (Math.abs(v) > 1.5 && BS.wakeT <= 0) {
      BS.wakeT = ent.boatKind === 'elfship' ? 0.16 : 0.22;
      _v2.set(ent.pos.x - fx_ * L * 0.85 * (v > 0 ? 1 : -1), SEA() + 0.02 + wave.h * 0.5, ent.pos.z - fz * L * 0.85 * (v > 0 ? 1 : -1));
      fx('water_ring', _v2, { scale: ent.boatKind === 'elfship' ? 0.9 + Math.min(1.0, Math.abs(v) / 40) : 0.45 + Math.min(0.5, Math.abs(v) / 18), duration: 1.3 });
    }
    if (v > 5 && BS.splashT <= 0) {
      BS.splashT = 0.4;
      _v2.set(ent.pos.x + fx_ * L, SEA() + 0.05, ent.pos.z + fz * L);
      fx('splash', _v2, { scale: 0.32 });
    }
  }

  // ---- routes, docks, costs
  function nearestRec(pos, exclude) {
    if (!pos) return null;
    let best = null, bd = Infinity;
    for (let i = 0; i < BS.recs.length; i++) { const r = BS.recs[i]; if (r === exclude) continue; const d = Math.hypot(r.pos.x - pos.x, r.pos.z - pos.z); if (d < bd) { bd = d; best = r; } }
    return best;
  }
  function recZone(rec) { const t = rec.town ? townData(rec.town) : null; if (t && t.zone) return t.zone; return zoneAt(rec.pos.x, rec.pos.z); }
  function rallyOf(rec) {
    const t = rec.town ? townData(rec.town) : null;
    const rp = t && (t.rallyPoint || t.pos);
    if (rp && typeof rp.x === 'number' && Math.hypot(rp.x - rec.pos.x, rp.z - rec.pos.z) < 160) { _rally.x = rp.x; _rally.z = rp.z; return _rally; }
    const a = pierDir(rec); _rally.x = rec.pos.x - Math.sin(a) * 6; _rally.z = rec.pos.z - Math.cos(a) * 6;
    if (isWater(_rally.x, _rally.z)) { _rally.x = rec.pos.x; _rally.z = rec.pos.z; }
    return _rally;
  }
  function travelCost(a, b) {
    const ra = recOf(a), rb = recOf(b); if (!ra || !rb) return 0;
    const d = Math.hypot(ra.pos.x - rb.pos.x, ra.pos.z - rb.pos.z);
    return Math.round(20 + d / 20) * 100;                                   // 20 s + 5 s per 100 m, in copper
  }
  function routesFrom(dockId) {
    const rec = recOf(dockId); const out = [];
    if (!rec) return out;
    for (let i = 0; i < rec.routes.length; i++) {
      const r = recOf(rec.routes[i]); if (!r || r === rec) continue;
      out.push({ dock: r.data, id: r.id, name: r.name, cost: travelCost(rec, r), dist: Math.hypot(rec.pos.x - r.pos.x, rec.pos.z - r.pos.z) });
    }
    return out;
  }
  function dockForZone(zoneId) {
    if (!zoneId) return null;
    for (let i = 0; i < BS.recs.length; i++) { const r = BS.recs[i]; const t = r.town ? townData(r.town) : null; if (t && t.zone === zoneId) return r.data; }
    for (let i = 0; i < BS.recs.length; i++) { const r = BS.recs[i]; if (zoneAt(r.pos.x, r.pos.z) === zoneId) return r.data; }
    return null;
  }

  // ---- coarse grids: navigable water (A*) and walkable land components (AutoQuest routing)
  let gridN = 0, gridHalf = 0, waterGrid = null, landComp = null;
  function cellIndex(x, z) {
    if (!gridN) return -1;
    const i = Math.floor((x + gridHalf) / GRID_CELL), j = Math.floor((z + gridHalf) / GRID_CELL);
    if (i < 0 || j < 0 || i >= gridN || j >= gridN) return -1;
    return j * gridN + i;
  }
  function cellX(idx) { return -gridHalf + ((idx % gridN) + 0.5) * GRID_CELL; }
  function cellZ(idx) { return -gridHalf + (Math.floor(idx / gridN) + 0.5) * GRID_CELL; }
  function ensureWaterGrid() {
    if (waterGrid) return true;
    if (!isFn(G.Terrain, 'height')) return false;
    const size = worldSize(); gridN = Math.ceil(size / GRID_CELL); gridHalf = size * 0.5;
    waterGrid = new Uint8Array(gridN * gridN);
    const o = GRID_CELL * 0.3;
    for (let j = 0; j < gridN; j++) for (let i = 0; i < gridN; i++) {
      const cx = -gridHalf + (i + 0.5) * GRID_CELL, cz = -gridHalf + (j + 0.5) * GRID_CELL;
      const d0 = depth(cx, cz);
      if (d0 <= 1.5) continue;
      let v = 1;
      if (d0 > 3 && depth(cx - o, cz) > 2.5 && depth(cx + o, cz) > 2.5 && depth(cx, cz - o) > 2.5 && depth(cx, cz + o) > 2.5) v = 2;
      waterGrid[j * gridN + i] = v;
    }
    return true;
  }
  function ensureLandGrid() {
    if (landComp) return true;
    if (!ensureWaterGrid()) return false;
    const N = gridN * gridN, land = new Uint8Array(N);
    for (let idx = 0; idx < N; idx++) { const x = cellX(idx), z = cellZ(idx); if (height(x, z) > SEA() - 1.2 || onRoad(x, z) > 0.4) land[idx] = 1; }
    landComp = new Int16Array(N); landComp.fill(-1);
    const stack = new Int32Array(N); let comp = 0;
    for (let s = 0; s < N; s++) {
      if (!land[s] || landComp[s] >= 0) continue;
      let sp = 0; stack[sp++] = s; landComp[s] = comp;
      while (sp > 0) {
        const c = stack[--sp], ci = c % gridN, cj = (c / gridN) | 0;
        if (ci > 0 && land[c - 1] && landComp[c - 1] < 0) { landComp[c - 1] = comp; stack[sp++] = c - 1; }
        if (ci < gridN - 1 && land[c + 1] && landComp[c + 1] < 0) { landComp[c + 1] = comp; stack[sp++] = c + 1; }
        if (cj > 0 && land[c - gridN] && landComp[c - gridN] < 0) { landComp[c - gridN] = comp; stack[sp++] = c - gridN; }
        if (cj < gridN - 1 && land[c + gridN] && landComp[c + gridN] < 0) { landComp[c + gridN] = comp; stack[sp++] = c + gridN; }
      }
      comp++;
    }
    return true;
  }
  function landComponent(x, z) {
    if (!ensureLandGrid()) return -1;
    const idx = cellIndex(num(x, 0), num(z, 0)); if (idx < 0) return -1;
    if (landComp[idx] >= 0) return landComp[idx];
    const ci = idx % gridN, cj = (idx / gridN) | 0;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= gridN || nj >= gridN) continue;
      const c = landComp[nj * gridN + ni]; if (c >= 0) return c;
    }
    return -1;
  }
  function nearestNavCell(x, z) {
    const idx = cellIndex(x, z); if (idx < 0) return -1;
    if (waterGrid[idx]) return idx;
    const ci = idx % gridN, cj = (idx / gridN) | 0;
    for (let ring = 1; ring <= 6; ring++) {
      let best = -1, bv = 0, bd = Infinity;
      for (let dj = -ring; dj <= ring; dj++) for (let di = -ring; di <= ring; di++) {
        if (Math.abs(di) !== ring && Math.abs(dj) !== ring) continue;
        const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= gridN || nj >= gridN) continue;
        const c = nj * gridN + ni, v = waterGrid[c]; if (!v) continue;
        const d = di * di + dj * dj;
        if (v > bv || (v === bv && d < bd)) { bv = v; bd = d; best = c; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }
  // binary heap keyed by f
  function heapPush(heap, f, idx, n) { let i = n; heap[i * 2] = f; heap[i * 2 + 1] = idx; while (i > 0) { const p = (i - 1) >> 1; if (heap[p * 2] <= heap[i * 2]) break; const tf = heap[p * 2], ti = heap[p * 2 + 1]; heap[p * 2] = heap[i * 2]; heap[p * 2 + 1] = heap[i * 2 + 1]; heap[i * 2] = tf; heap[i * 2 + 1] = ti; i = p; } return n + 1; }
  function heapPop(heap, n) { const outIdx = heap[1]; n--; heap[0] = heap[n * 2]; heap[1] = heap[n * 2 + 1]; let i = 0; for (;;) { const l = i * 2 + 1, r = l + 1; let m = i; if (l < n && heap[l * 2] < heap[m * 2]) m = l; if (r < n && heap[r * 2] < heap[m * 2]) m = r; if (m === i) break; const tf = heap[m * 2], ti = heap[m * 2 + 1]; heap[m * 2] = heap[i * 2]; heap[m * 2 + 1] = heap[i * 2 + 1]; heap[i * 2] = tf; heap[i * 2 + 1] = ti; i = m; } return outIdx; }
  function astar(a, b) {
    const N = gridN * gridN;
    const g = new Float32Array(N); g.fill(Infinity);
    const came = new Int32Array(N); came.fill(-1);
    const closed = new Uint8Array(N);
    const heap = new Float64Array(N * 2 * 2 + 4); let hn = 0;
    const bi = b % gridN, bj = (b / gridN) | 0;
    const h = (c) => { const di = Math.abs((c % gridN) - bi), dj = Math.abs(((c / gridN) | 0) - bj); return Math.max(di, dj) + 0.4142 * Math.min(di, dj); };
    g[a] = 0; hn = heapPush(heap, h(a), a, hn);
    let iter = 0;
    while (hn > 0 && iter++ < N * 4) {
      const c = heapPop(heap, hn); hn--;
      if (closed[c]) continue;
      if (c === b) break;
      closed[c] = 1;
      const ci = c % gridN, cj = (c / gridN) | 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ni = ci + di, nj = cj + dj; if (ni < 0 || nj < 0 || ni >= gridN || nj >= gridN) continue;
        const n = nj * gridN + ni, v = waterGrid[n]; if (!v || closed[n]) continue;
        if (di && dj && (!waterGrid[cj * gridN + ni] || !waterGrid[nj * gridN + ci])) continue;   // no corner cutting past land
        const step = (di && dj ? 1.4142 : 1) * (v === 2 ? 1 : 3);
        const ng = g[c] + step;
        if (ng < g[n]) { g[n] = ng; came[n] = c; if (hn * 2 + 2 < heap.length) hn = heapPush(heap, ng + h(n), n, hn); }
      }
    }
    if (came[b] < 0 && a !== b) return null;
    const path = []; let c = b; let guard = 0;
    while (c >= 0 && guard++ < N) { path.push(c); if (c === a) break; c = came[c]; }
    path.reverse();
    return path;
  }
  function segmentClear(ax, az, bx, bz, minDepth) {
    const d = Math.hypot(bx - ax, bz - az); const n = Math.max(1, Math.ceil(d / 10));
    for (let i = 0; i <= n; i++) { const k = i / n; if (depth(lerp(ax, bx, k), lerp(az, bz, k)) < minDepth) return false; }
    return true;
  }
  function stringPull(pts) {
    const out = [pts[0]]; let i = 0; const n = pts.length;
    while (i < n - 1) {
      let j = n - 1;
      while (j > i + 1 && !segmentClear(pts[i].x, pts[i].z, pts[j].x, pts[j].z, 1.5)) j--;
      out.push(pts[j]); i = j;
    }
    return out;
  }
  function seaPath(a, b) {
    const A = { x: num(a && a.x, 0), z: num(a && a.z, 0) }, B = { x: num(b && b.x, 0), z: num(b && b.z, 0) };
    if (segmentClear(A.x, A.z, B.x, B.z, 1.2)) return [A, B];
    if (!ensureWaterGrid()) return [A, B];
    const ca = nearestNavCell(A.x, A.z), cb = nearestNavCell(B.x, B.z);
    if (ca < 0 || cb < 0) return [A, B];
    const cells = astar(ca, cb);
    if (!cells) return [A, B];
    const pts = [A];
    for (let i = 0; i < cells.length; i++) pts.push({ x: cellX(cells[i]), z: cellZ(cells[i]) });
    pts.push(B);
    return stringPull(pts);
  }
  function polyLen(pts) { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z); return l; }
  function buildRoute(pts) {
    let samples = null;
    if (pts.length >= 3) {
      try {
        const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p.x, 0, p.z)), false, 'catmullrom', 0.5);
        const n = Math.max(24, Math.round(polyLen(pts) / 8));
        samples = curve.getSpacedPoints(n);
        for (let i = 0; i < samples.length; i++) if (depth(samples[i].x, samples[i].z) < 0.8) { samples = null; break; }
      } catch (e) { samples = null; }
    }
    if (!samples) samples = pts.map(p => new THREE.Vector3(p.x, 0, p.z));
    if (samples.length < 2) samples.push(samples[0].clone());
    const cum = new Float32Array(samples.length); let len = 0;
    for (let i = 1; i < samples.length; i++) { len += Math.hypot(samples[i].x - samples[i - 1].x, samples[i].z - samples[i - 1].z); cum[i] = len; }
    return { pts: samples, cum: cum, len: len, cursor: 0 };
  }
  function routePoint(route, s, out) {
    s = clamp(s, 0, route.len);
    const pts = route.pts, cum = route.cum; let i = route.cursor;
    while (i < pts.length - 2 && cum[i + 1] < s) i++;
    while (i > 0 && cum[i] > s) i--;
    route.cursor = i;
    const a = pts[i], b = pts[Math.min(i + 1, pts.length - 1)];
    const seg = cum[Math.min(i + 1, pts.length - 1)] - cum[i];
    const k = seg > 1e-6 ? (s - cum[i]) / seg : 0;
    return out.set(lerp(a.x, b.x, k), 0, lerp(a.z, b.z, k));
  }
  function pathToZone(fromPos, zoneId) {
    if (!zoneId || !fromPos) return null;
    const fx_ = num(fromPos.x, 0), fz = num(fromPos.z, 0);
    if (zoneAt(fx_, fz) === zoneId) return [];
    const targets = []; for (let i = 0; i < BS.recs.length; i++) if (recZone(BS.recs[i]) === zoneId) targets.push(BS.recs[i]);
    if (!targets.length) return null;
    const comp = landComponent(fx_, fz);
    let starts = BS.recs.slice().sort((p, q) => Math.hypot(p.pos.x - fx_, p.pos.z - fz) - Math.hypot(q.pos.x - fx_, q.pos.z - fz));
    if (comp >= 0) { const same = starts.filter(r => landComponent(r.pos.x, r.pos.z) === comp); if (same.length) starts = same; }
    for (let s = 0; s < starts.length; s++) {
      const start = starts[s];
      const prev = {}; prev[start.id] = null; const queue = [start]; let found = null;
      for (let qi = 0; qi < queue.length && !found; qi++) {
        const r = queue[qi];
        if (targets.indexOf(r) >= 0) { found = r; break; }
        for (let k = 0; k < r.routes.length; k++) { const nr = recOf(r.routes[k]); if (!nr || prev[nr.id] !== undefined) continue; prev[nr.id] = r; queue.push(nr); }
      }
      if (found) { const path = []; let c = found; while (c) { path.push(c.data); c = prev[c.id]; } return path.reverse(); }
    }
    return null;
  }

  // ---- fast travel cinematic
  function sailTo(dockId, fromDock, opts) {
    opts = opts || EMPTY;
    if (Boats.travelling) return false;
    const to = recOf(dockId);
    if (!to) { if (isFn(G, 'warn')) G.warn('Boats.sailTo: unknown dock ' + (dockId && dockId.id ? dockId.id : dockId)); return false; }
    const pl = player(); if (!pl || !pl.pos) return false;
    let from = fromDock ? recOf(fromDock) : null;
    if (!from) from = (Boats.sailing && BS.cur && BS.cur.rec) ? BS.cur.rec : nearestRec(pl.pos, null);
    if (!from) return false;
    if (from === to) { notify('You are already at ' + to.name + '.', 'info'); return false; }
    const cost = opts.free ? 0 : travelCost(from, to);
    if (cost > 0 && !opts.paid) {
      if (isFn(G.Progress, 'spendGold')) { let ok = false; try { ok = !!G.Progress.spendGold(cost); } catch (e) { report(e, 'spendGold'); } if (!ok) { notify('You cannot afford the fare (' + fmtMoney(cost) + ').', 'warning'); sfx('ui_error', { vol: 0.5 }); return false; } }
      else if (typeof pl.gold === 'number') { if (pl.gold < cost) { notify('You cannot afford the fare (' + fmtMoney(cost) + ').', 'warning'); return false; } pl.gold -= cost; }
    }
    if (pl.mounted && isFn(G.Player, 'dismount')) { try { G.Player.dismount(); } catch (e) { report(e, 'dismount'); } }
    if (G.Fishing && G.Fishing.state !== 'idle') G.Fishing.cancel(false);
    if (Boats.sailing) endSail(true, true);
    if (isFn(G.Player, 'autoStop')) { try { G.Player.autoStop(); } catch (e) { /* ignore */ } }
    if (isFn(G.UI, 'closeAll')) { try { G.UI.closeAll(); } catch (e) { /* ignore */ } }
    attachRoot();
    Boats.travelling = true; Boats.speed = 0;
    BS.travel = Boats.travel = { phase: 'out', t: 0, from: from, to: to, ent: null, route: null, dur: opts.instant ? 0 : Math.max(2, num(opts.duration, TRAVEL_TIME)), instant: !!opts.instant, cost: cost, cam: null, camYaw0: 0, orbit: 0, bell2: false, fadingIn: false };
    fade(true, FADE_T);
    sfx('boat_bell', { vol: 0.8 });
    notify('Setting sail for ' + to.name + (cost ? ' (' + fmtMoney(cost) + ')' : '') + '.', 'info');
    emit('sailDepart', { from: from.data, to: to.data, cost: cost });
    if (opts.instant) {
      // Instant travel must not depend on frames elapsing (the fade-out alone is 0.6 game-s ≈ many frames at low fps,
      // and callers such as the auto-quest bot / verification poll `travelling`): cut to black now, put the player on
      // the far quay in this very call and let only the fade-in play out over the following frames.
      fadeAlpha = 1; fadeTarget = 1;
      { const fe = ensureFade(); if (fe) { fe.style.display = 'block'; fe.style.opacity = '1'; } }
      const tv = BS.travel;
      try { arrive(tv); } catch (e) { report(e, 'arrive'); abortTravel(); return true; }
      finishTravel();
      fade(false, FADE_T);
    }
    return true;
  }
  function instantTravel(dockId, opts) { const o = Object.assign({}, opts || EMPTY, { instant: true }); return sailTo(dockId, o.from || null, o); }
  function beginVoyage(tv) {
    const pl = player();
    const w0 = waterSide(tv.from), w1 = waterSide(tv.to);
    tv.route = buildRoute(seaPath(w0, w1));
    routePoint(tv.route, Math.min(4, tv.route.len), _v2); routePoint(tv.route, 0, _v1);
    const yaw0 = (tv.route.len > 0.5) ? yawTo(_v2.x - _v1.x, _v2.z - _v1.z) : wrapA(w0.dir + PI);
    let sx0 = w0.x, sz0 = w0.z;
    for (let r = 0; r <= 24; r += 2) { const x = w0.x + Math.sin(w0.dir) * r, z = w0.z + Math.cos(w0.dir) * r; if (hullFits(x, z, yaw0, 'elfship')) { sx0 = x; sz0 = z; break; } }
    const ent = spawnBoat('elfship', sx0, sz0, yaw0);
    tv.ent = ent; BS.cur = { ent: ent, rec: tv.from, kind: 'elfship' }; Boats.boat = ent; if (pl) pl.onBoat = ent;
    rigAnim('sit', true);
    placeBoat(ent, 0); seatPlayer(ent);
    const cam = G.Player && G.Player.cam;
    if (cam) {
      tv.cam = { yaw: num(cam.yaw, 0), pitch: num(cam.pitch, 0.28), dist: num(cam.dist, 7), targetDist: num(cam.targetDist, num(cam.dist, 7)) };
      tv.camYaw0 = yaw0 + 0.85; cam.yaw = tv.camYaw0; cam.pitch = 0.3; cam.dist = 14; cam.targetDist = 14;
    }
    BS.wakeT = 0; BS.splashT = 0; BS.creakT = 3;
    music('sailing');
    tv.phase = 'sail'; tv.t = 0;
    fade(false, FADE_T);
    chat('You set sail from ' + tv.from.name + ' for ' + tv.to.name + '.');
  }
  function arrive(tv) {
    const rec = tv.to, pl = player();
    const rp = rallyOf(rec);
    const t = rec.town ? townData(rec.town) : null;
    const yaw = t && t.pos ? yawTo(t.pos.x - rp.x, t.pos.z - rp.z) : wrapA(pierDir(rec) + PI);
    const cam = G.Player && G.Player.cam;
    if (cam && tv.cam) { cam.pitch = tv.cam.pitch; cam.dist = tv.cam.dist; cam.targetDist = tv.cam.targetDist; }
    endSail(true, true);
    rigAnim('idle', true);
    placePlayerOnLand(rp.x, rp.z, yaw);
    sfx('boat_bell', { vol: 0.8 });
    notify('You arrive at ' + rec.name + '.', 'quest');
    chat('The ship puts in at ' + rec.name + '.');
    restoreZoneMusic();
    emit('sailArrived', { dock: rec.data });
    tv.phase = 'done'; tv.t = 0;
    fade(false, FADE_T);
  }
  function finishTravel() { Boats.travelling = false; BS.travel = Boats.travel = null; Boats.speed = 0; }
  function abortTravel() {
    const tv = BS.travel;
    if (tv) { const cam = G.Player && G.Player.cam; if (cam && tv.cam) { cam.pitch = tv.cam.pitch; cam.dist = tv.cam.dist; cam.targetDist = tv.cam.targetDist; } }
    endSail(true, true);
    finishTravel();
    fade(false, 0.3);
  }
  function updateTravel(dt) {
    const tv = BS.travel; if (!tv) { Boats.travelling = false; return; }
    const pl = player(); if (!pl || !pl.pos) { abortTravel(); return; }
    tv.t += dt;
    if (tv.phase === 'out') {
      if (tv.t >= FADE_T) { if (tv.instant) arrive(tv); else beginVoyage(tv); }
      return;
    }
    if (tv.phase === 'sail') {
      const ent = tv.ent; if (!ent || !ent.mesh) { arrive(tv); return; }
      const k = clamp(tv.t / tv.dur, 0, 1), e = easeInOut(k);
      const s = e * tv.route.len;
      routePoint(tv.route, s, _v1);
      routePoint(tv.route, Math.min(tv.route.len, s + 3), _v2); routePoint(tv.route, Math.max(0, s - 3), _v3);
      const dx = _v2.x - _v3.x, dz = _v2.z - _v3.z;
      if (dx * dx + dz * dz > 0.01) ent.yaw = adamp(ent.yaw, yawTo(dx, dz), 3, dt);
      ent.pos.x = _v1.x; ent.pos.z = _v1.z;
      const speed = (tv.route.len / tv.dur) * (k < 0.5 ? 4 * k : 4 * (1 - k));            // d(easeInOut)/dk
      ent.speed = speed; Boats.speed = speed; ent.vel.set(-Math.sin(ent.yaw) * speed, 0, -Math.cos(ent.yaw) * speed);
      placeBoat(ent, dt); seatPlayer(ent);
      if (G.Spatial && isFn(G.Spatial, 'update')) G.Spatial.update(ent);
      wakeFX(ent, dt, -Math.sin(ent.yaw), -Math.cos(ent.yaw), HULL_L.elfship);
      if (ent.boat && isFn(ent.boat, 'animate')) ent.boat.animate(tv.t);
      const cam = G.Player && G.Player.cam;
      if (cam) { tv.orbit += dt * 0.13; cam.yaw = tv.camYaw0 + tv.orbit; cam.pitch = 0.3; cam.dist = 14; cam.targetDist = 14; }
      BS.creakT -= dt; if (BS.creakT <= 0) { BS.creakT = 3 + rand() * 4; sfx('boat_creak', { pos: ent.pos, vol: 0.4 }); }
      if (!tv.bell2 && k > 0.9) { tv.bell2 = true; sfx('boat_bell', { vol: 0.7 }); }
      if (!tv.fadingIn && tv.t >= tv.dur - FADE_T) { tv.fadingIn = true; fade(true, FADE_T); }
      if (k >= 1) { tv.phase = 'in'; tv.t = 0; }
      return;
    }
    if (tv.phase === 'in') { if (tv.t >= 0.12) arrive(tv); return; }
    if (tv.phase === 'done') { if (tv.t >= FADE_T) finishTravel(); }
  }

  // ---- fallback dock menu (used when the Travel panel is absent)
  function openDockMenu(dock) {
    const rec = recOf(dock); if (!rec) return false;
    BS.menuDock = rec;
    const U = G.UI;
    if (!isFn(U, 'registerPanel') || !isFn(U, 'openPanel')) return board(rec);
    if (!BS.menuRegistered) { BS.menuRegistered = true; U.registerPanel('dockmenu', { title: 'Harbour', width: 420, pos: 'center', rebuildOnOpen: true, remember: false, build: buildDockMenu }); }
    if (isFn(U, 'isOpen') && U.isOpen('dockmenu') && isFn(U, 'refresh')) U.refresh('dockmenu'); else U.openPanel('dockmenu', rec.data);
    const p = isFn(U, 'getPanel') ? U.getPanel('dockmenu') : null; if (p && isFn(p, 'setTitle')) p.setTitle(rec.name);
    return true;
  }
  function buildDockMenu(body) {
    if (!body) return;
    body.innerHTML = '';
    const rec = BS.menuDock; if (!rec) return;
    const routes = routesFrom(rec.id), pl = player(), gold = pl ? num(pl.gold, 0) : 0;
    body.appendChild(el('div', { style: 'margin-bottom:8px;color:var(--parch-dim,#b8ad94)', text: 'The boatmaster of ' + rec.name + ' offers passage:' }));
    routes.forEach(function (r) {
      const can = gold >= r.cost;
      body.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:6px 0;border-bottom:1px solid rgba(111,83,34,.35)' }, [
        el('div', {}, [el('div', { style: 'font-weight:600', text: r.name }), el('div', { style: 'font-size:12px;color:var(--parch-dim,#b8ad94)', text: Math.round(r.dist) + ' m by sea' })]),
        el('div', { style: 'display:flex;align-items:center;gap:8px' }, [el('span', { html: fmtMoneyHTML(r.cost) }), el('button', { class: 'btn small' + (can ? ' primary' : ' disabled'), text: 'Sail', onclick: function () { if (isFn(G.UI, 'closePanel')) G.UI.closePanel('dockmenu'); sailTo(r.id, rec); } })]),
      ]));
    });
    if (!routes.length) body.appendChild(el('div', { text: 'No ships sail from here today.' }));
    body.appendChild(el('div', { style: 'margin-top:10px;display:flex;justify-content:flex-end' }, [el('button', { class: 'btn', text: 'Take a rowboat', onclick: function () { if (isFn(G.UI, 'closePanel')) G.UI.closePanel('dockmenu'); board(rec); } })]));
  }

  // ---- main update
  function boatsUpdate(dt) {
    dt = clamp(num(dt, 0), 0, 0.1);
    if (!rootAttached) attachRoot(BS.sceneArg);
    updateFade(dt);
    if (BS.recs.length) updateMoored(dt);
    if (BS.retired.length) updateRetired(dt);
    if (Boats.travelling) updateTravel(dt);
    else if (Boats.sailing) updateSail(dt);
  }
  function stats() {
    let moored = 0; for (let i = 0; i < BS.recs.length; i++) if (BS.recs[i].moor) moored++;
    return { docks: BS.recs.length, moored: moored, retired: BS.retired.length, sailing: Boats.sailing, travelling: Boats.travelling, speed: Boats.speed, gridBuilt: !!waterGrid, landGridBuilt: !!landComp };
  }

  Boats.init = init;
  Boats.board = board;
  Boats.disembark = disembark;
  Boats.sailTo = sailTo;
  Boats.instantTravel = instantTravel;
  Boats.update = boatsUpdate;
  Boats.openDockMenu = openDockMenu;
  Boats.routesFrom = routesFrom;
  Boats.nearestDock = function (pos) { const r = nearestRec(pos || (player() && player().pos), null); return r ? r.data : null; };
  Boats.dockForZone = dockForZone;
  Boats.pathToZone = pathToZone;
  Boats.travelCost = travelCost;
  Boats.dockById = function (id) { const r = recOf(id); return r ? r.data : null; };
  Boats.waterSide = function (dock) { const r = recOf(dock); if (!r) return null; const w = waterSide(r); return { x: w.x, z: w.z, dir: w.dir }; };
  Boats.seaPath = seaPath;
  Boats.landComponent = landComponent;
  Boats.nearShore = function (pos, r) { const s = nearShore(pos, r); return s ? { x: s.x, z: s.z, dist: s.d } : null; };
  Boats.waveHeight = waveHeight;
  Boats.waveTime = waveTime;
  Boats.fade = function (on, dur) { fade(!!on, dur); };
  Boats.stats = stats;
  if (typeof G.on === 'function') G.on('init', subscribe);
})();
