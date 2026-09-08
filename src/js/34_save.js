/* ==== 34_save.js — G.Save: localStorage save / load / export / import and autosave for Chris Jensen's Lord of the
   Rings Online. Builds a compact, readable JSON snapshot of everything the player would miss (character spec and
   appearance, position, level / xp / gold, bags and equipment as plain item instances, abilities, hotbar, mounts,
   titles, admin stat overrides, world statistics, fishing skill, zone, time of day, weather, quest state, AI-player
   compact state, settings and graphics quality, custom map places, waypoint, admin flags and the uid counter),
   validates and migrates it on load, and re-applies it onto a freshly created player.

   Public API (SPEC §7.5):
     G.Save.save(opts?)        → snapshot|null   opts { silent:bool, reason:string }. Writes localStorage[G.C.SAVE_KEY]
                                 (in-memory fallback when storage is blocked/full), emits 'save' (snapshot), notifies
                                 'Game saved' unless silent. Never throws.
     G.Save.load()             → snapshot|null   parsed + validated + migrated; null when absent / corrupt / newer version.
     G.Save.hasSave()          → bool
     G.Save.clear()            → bool            removes the stored save (emits 'saveCleared').
     G.Save.exportJSON()       → string          pretty JSON of the LIVE game when a player exists, else of the stored save.
     G.Save.importJSON(str)    → {ok, error?, data?, summary?}   validates and STORES the save (it is not applied to the
                                 running game — call G.Game.startFromSave() afterwards to enter the world with it).
     G.Save.summary(data?)     → {name, race, raceName, cls, className, gender, level, zone, zoneName, playTime, playTimeText,
                                  savedAt (game s), savedWall (ms epoch), savedAgoText, gold, questsDone, version} | null
     G.Save.apply(data)        → bool            call AFTER G.Player.create(data.charSpec) (and after G.Quests.init()):
                                 restores every field onto the live player / world, emits 'load' (snapshot). Never throws.
   Extras:
     G.Save.snapshot()         → snapshot|null   build without writing         G.Save.validate(data) → {ok, error?, data?}
     G.Save.autosave(reason?)  → snapshot|null   silent save when allowed      G.Save.autosaveEnabled (bool, default true)
     G.Save.fmtPlayTime(sec)   → '3h 12m'         G.Save.storageAvailable() → bool
     G.Save.last / lastSavedAt / lastError / lastSize / persisted / saves     (diagnostics)
   Autosave: every 60 s of game time (G.timers.every) while G.state.phase === 'playing', the player is alive and not
     sailing; on questCompleted / playerLevelUp / panelClosed (debounced 5 s); on beforeunload / pagehide /
     visibilitychange → hidden. Silent saves show a small 'Saved' chip at most once per game minute.
   Save format (version 1): { version, game, gameVersion, savedAt, savedWall, playTime, charSpec, player:{pos, yaw, level,
     xp, gold, morale, power, inventory (trailing empty slots trimmed), equipment, abilities, hotbar, mounts, activeMount,
     titles, activeTitle, statBonus, statOverride}, stats, fishingSkill, zone, time:{dayTime, dayIndex, dayLengthMinutes},
     weather, quests, aiplayers, autoQuest:{speed}, settings, quality, customPlaces, waypoint, adminFlags:{godMode,
     damageMult, noCooldowns, speedMult}, uidCounter }.
   Contracts with concurrently written modules (all optional and guarded — see docs/INTEGRATION_NOTES.md):
     G.Quests.serialize() → JSON-safe object / G.Quests.restore(obj); fallback = {state, tracked} snapshot and assignment
       (unknown quest ids dropped). G.AIPlayers.serialize() / restore(obj).
     G.Sky.setTime(h) / setWeather(kind, true) / dayIndex; G.Audio.setVolumes(music, sfx); G.PostFX.setQuality(q);
     G.Player.spawnAt(x, z, yaw) (teleport fallback) / computeStats() / setCameraDistance(d);
     G.Progress.ensurePlayerShape(p) / grantStarterAbilities(p); G.UI.notify(text, kind); G.UI.waypoint (restored by
     assignment so no 'Waypoint set' notice fires); G.AutoQuest.speed.
   Shared runtime state written on apply (G.state): stats, fishingSkill, zone (only when no terrain), weather (only when no
     Sky), settings, quality (only when no PostFX), customPlaces, godMode / damageMult / noCooldowns / speedMult, and
     player.speedMult. Keys beginning with '_' are never persisted. Private helpers are file-local. ==== */
(function () {
  'use strict';
  const G = window.G;
  const C = G.C || {};

  // ------------------------------------------------------------------------------------------------ constants
  const VERSION = 1;
  const KEY = C.SAVE_KEY || 'cj_lotro_save_v1';
  const GAME_NAME = "Chris Jensen's Lord of the Rings Online";
  const LEVEL_CAP = (typeof C.LEVEL_CAP === 'number') ? C.LEVEL_CAP : 80;
  const INV_SLOTS = (typeof C.INVENTORY_SLOTS === 'number') ? C.INVENTORY_SLOTS : 200;
  const HOTBAR_SIZE = Array.isArray(C.HOTBAR_KEYS) ? C.HOTBAR_KEYS.length : 20;
  const EQUIP_SLOTS = Array.isArray(C.EQUIP_SLOTS) ? C.EQUIP_SLOTS : ['head', 'shoulder', 'back', 'chest', 'hands', 'legs', 'feet', 'mainhand', 'offhand', 'ranged', 'neck', 'ear1', 'ear2', 'wrist1', 'wrist2', 'ring1', 'ring2', 'pocket'];
  const WORLD_HALF = ((typeof C.WORLD_SIZE === 'number') ? C.WORLD_SIZE : 4096) / 2;
  const AUTOSAVE_PERIOD = 60;            // s of game time
  const EVENT_DEBOUNCE_MS = 5000;        // wall-clock, for event-triggered autosaves
  const CHIP_PERIOD = 60;                // s of game time between 'Saved' chips
  const MAX_CUSTOM_PLACES = 200;
  const MAX_SAVE_BYTES = 4 * 1024 * 1024;
  const SETTINGS_DEFAULTS = { music: 0.6, sfx: 0.8, mouseSens: 1.0, invertY: false, showFps: false, cameraDist: 7, shadows: true };
  const QUALITIES = ['ultra', 'high', 'medium', 'low', 'auto'];
  const WEATHERS = ['clear', 'cloudy', 'rain', 'snow', 'storm'];
  const QUEST_STATUS = ['available', 'active', 'complete', 'done'];

  // ------------------------------------------------------------------------------------------------ small helpers
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function int(v, d) { v = num(v, NaN); return v === v ? Math.round(v) : d; }
  function str(v, d) { return typeof v === 'string' ? v : (d === undefined ? '' : d); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isPlain(v) { if (!isObj(v)) return false; const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; }
  function hasFn(o, k) { return !!(o && typeof o[k] === 'function'); }
  function now() { return (G.time && typeof G.time.now === 'number') ? G.time.now : 0; }
  function player() { return (G.state && G.state.player) || null; }
  function report(e, where) { if (typeof G.reportError === 'function') G.reportError(e, 'Save.' + where); }
  function warn(msg) { if (typeof G.warn === 'function') G.warn('Save: ' + msg); }
  function notify(text, kind) { try { if (G.UI && typeof G.UI.notify === 'function') G.UI.notify(text, kind || 'info'); } catch (e) { /* the HUD's problem */ } }
  function emit(evt, a) { try { if (typeof G.emit === 'function') G.emit(evt, a); } catch (e) { report(e, 'emit:' + evt); } }
  function stage(name, fn) { try { fn(); return true; } catch (e) { report(e, 'apply:' + name); return false; } }

  /** JSON-safe deep clone. Keeps primitives, arrays and plain objects; Set → array, Map → object; drops functions,
   *  undefined, symbols, non-plain objects (THREE.Vector3, DOM nodes, class instances), keys starting with '_' and
   *  anything nested deeper than `depth`. Non-finite numbers become null. */
  function jsonClone(v, depth) {
    if (depth === undefined) depth = 8;
    if (v === null) return null;
    if (v === undefined) return undefined;
    const t = typeof v;
    if (t === 'number') return isFinite(v) ? v : null;
    if (t === 'string' || t === 'boolean') return v;
    if (t !== 'object') return undefined;
    if (depth <= 0) return undefined;
    if (v instanceof Set) v = Array.from(v);
    else if (v instanceof Map) { const o = {}; v.forEach(function (val, k) { o[String(k)] = val; }); v = o; }
    if (Array.isArray(v)) {
      const out = new Array(v.length);
      for (let i = 0; i < v.length; i++) { const c = jsonClone(v[i], depth - 1); out[i] = c === undefined ? null : c; }
      return out;
    }
    if (!isPlain(v)) return undefined;
    const out = {};
    for (const k in v) {
      if (!Object.prototype.hasOwnProperty.call(v, k) || k.charCodeAt(0) === 95) continue;
      const c = jsonClone(v[k], depth - 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }
  function numericMap(o) {
    if (!isObj(o)) return null;
    const out = {}; let n = 0;
    for (const k in o) { const v = o[k]; if (typeof v === 'number' && isFinite(v)) { out[k] = v; n++; } }
    return n ? out : null;
  }
  function trimTrailingNulls(arr) { let n = arr.length; while (n > 0 && arr[n - 1] == null) n--; arr.length = n; return arr; }
  function fmtPlayTime(sec) {
    sec = Math.max(0, num(sec, 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm';
    return Math.floor(sec) + 's';
  }
  function fmtAgo(ms) {
    if (!(ms > 0)) return '';
    const s = Math.max(0, (Date.now() - ms) / 1000);      // wall-clock metadata for the menu card only (not gameplay time)
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    const d = Math.floor(s / 86400);
    return d + (d === 1 ? ' day ago' : ' days ago');
  }

  // ------------------------------------------------------------------------------------------------ data lookups
  function itemTemplate(tid) {
    if (typeof tid !== 'string' || !tid) return null;
    if (G.Items && hasFn(G.Items, 'template')) { try { return G.Items.template(tid) || null; } catch (e) { return null; } }
    return (G.Data && G.Data.items && G.Data.items[tid]) || null;
  }
  function abilityData(id) {
    if (typeof id !== 'string' || !id || !G.Data) return null;
    if (hasFn(G.Data, 'abilityById')) { try { return G.Data.abilityById(id) || null; } catch (e) { return null; } }
    if (isObj(G.Data.abilityById)) return G.Data.abilityById[id] || null;
    if (isObj(G.Data.abilities)) return G.Data.abilities[id] || null;
    return null;
  }
  function abilityDataAvailable() { return !!(G.Data && (hasFn(G.Data, 'abilityById') || isObj(G.Data.abilityById) || isObj(G.Data.abilities))); }
  function validAbility(id, cls) {
    if (typeof id !== 'string' || !id) return false;
    if (!abilityDataAvailable()) return true;
    const a = abilityData(id);
    if (!a || a.monster || a.cls === 'monster') return false;
    return !a.cls || !cls || a.cls === cls;
  }
  function questKnown(id) {
    const q = G.Data && G.Data.questById;
    if (!q) return true;                                   // no quest data loaded → cannot judge, keep
    if (typeof q === 'function') { try { return !!q(id); } catch (e) { return false; } }
    return !!q[id];
  }
  function titleKnown(id) {
    const t = G.Data && G.Data.titleById;
    if (!t) return typeof id === 'string' && !!id;
    return !!t[id];
  }
  function zoneKnown(id) {
    const w = G.Data && G.Data.world;
    if (!w) return typeof id === 'string' && !!id;
    if (w.zoneById) return !!w.zoneById[id];
    if (Array.isArray(w.zones)) return w.zones.some(function (z) { return z && z.id === id; });
    return true;
  }
  function raceName(id) { const r = G.Data && G.Data.raceById && G.Data.raceById[id]; return r ? r.name : (id ? String(id) : ''); }
  function className(id) { const c = G.Data && G.Data.classById && G.Data.classById[id]; return c ? c.name : (id ? String(id) : ''); }
  function zoneName(id) { const w = G.Data && G.Data.world; const z = w && w.zoneById && w.zoneById[id]; return z ? z.name : (id ? String(id) : ''); }
  function weatherKnown(kind) {
    if (typeof kind !== 'string' || !kind) return false;
    if (G.Sky && Array.isArray(G.Sky.WEATHER_KINDS)) return G.Sky.WEATHER_KINDS.indexOf(kind) >= 0;
    return WEATHERS.indexOf(kind) >= 0;
  }

  // ------------------------------------------------------------------------------------------------ item instances
  let _loadUidN = 0;
  function freshUid() { return 'ix_' + (++_loadUidN).toString(36); }     // '_' never appears in G.Items' salted uids
  function cleanStats(o) { return numericMap(o); }
  /** Validated plain copy of a saved item instance, or null (template gone / malformed). `dropped` collects tids. */
  function sanitizeInstance(raw, dropped) {
    if (!isObj(raw)) return null;
    if (typeof raw.tid !== 'string' || !raw.tid) { dropped.push('?'); return null; }
    if (!itemTemplate(raw.tid)) { dropped.push(raw.tid); return null; }
    const inst = jsonClone(raw, 6) || {};
    inst.tid = raw.tid;
    inst.count = Math.max(1, int(inst.count, 1));
    if (typeof inst.uid !== 'string' || !inst.uid) inst.uid = freshUid();
    if (inst.stats !== undefined) { const st = cleanStats(inst.stats); if (st) inst.stats = st; else delete inst.stats; }
    if (inst.dmg !== undefined) {
      const d = isObj(inst.dmg) ? inst.dmg : null;
      if (d && typeof d.min === 'number' && typeof d.max === 'number') inst.dmg = { min: d.min, max: d.max, type: str(d.type, 'common') };
      else delete inst.dmg;
    }
    if (inst.rarity !== undefined && (!Array.isArray(C.RARITY) || C.RARITY.indexOf(inst.rarity) < 0)) delete inst.rarity;
    if (inst.level !== undefined) inst.level = clamp(int(inst.level, 1), 1, LEVEL_CAP);
    if (inst.ilvl !== undefined) inst.ilvl = Math.max(0, int(inst.ilvl, 0));
    if (inst.name !== undefined && typeof inst.name !== 'string') delete inst.name;
    return inst;
  }
  function isEquippable(inst) {
    if (G.Items && hasFn(G.Items, 'isEquippable')) { try { return !!G.Items.isEquippable(inst); } catch (e) { return false; } }
    const t = itemTemplate(inst && inst.tid); return !!(t && t.slot);
  }

  // ------------------------------------------------------------------------------------------------ storage
  let _mem = null;                    // in-memory copy (fallback when localStorage is blocked or full)
  let _storageWarned = false;
  function storage() {
    try { const s = window.localStorage; if (s && typeof s.getItem === 'function' && typeof s.setItem === 'function') return s; } catch (e) { /* blocked */ }
    return null;
  }
  function storageAvailable() {
    const s = storage(); if (!s) return false;
    try { const k = KEY + '__probe'; s.setItem(k, '1'); s.removeItem(k); return true; } catch (e) { return false; }
  }
  function readRaw() {
    const s = storage();
    if (s) { try { const r = s.getItem(KEY); if (typeof r === 'string' && r) return r; } catch (e) { report(e, 'storage.read'); } }
    return _mem;
  }
  function isQuotaError(e) {
    if (!e) return false;
    const name = String(e.name || ''), code = e.code;
    return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED' || code === 22 || code === 1014 || /quota/i.test(String(e.message || ''));
  }
  /** → { ok, persisted, error, quota } — `ok` is true when the text is retrievable again (storage or memory). */
  function writeRaw(text) {
    _mem = text;
    const s = storage();
    if (!s) {
      if (!_storageWarned) { _storageWarned = true; warn('localStorage is unavailable — saves are kept in memory for this session only'); }
      return { ok: true, persisted: false, error: 'Browser storage is unavailable', quota: false };
    }
    try { s.setItem(KEY, text); return { ok: true, persisted: true, error: null, quota: false }; }
    catch (e) {
      const quota = isQuotaError(e);
      report(e, quota ? 'storage.quota' : 'storage.write');
      return { ok: true, persisted: false, error: quota ? 'Browser storage is full' : ('Browser storage refused the save: ' + (e && e.message ? e.message : e)), quota: quota };
    }
  }
  function removeRaw() {
    _mem = null;
    const s = storage();
    if (!s) return true;
    try { s.removeItem(KEY); return true; } catch (e) { report(e, 'storage.remove'); return false; }
  }

  // ------------------------------------------------------------------------------------------------ snapshot
  function charSpecOf(p) {
    return {
      race: p.race, cls: p.cls, gender: p.gender, name: p.name,
      skin: p.skin, hair: p.hair, hairColor: p.hairColor, hairStyle: p.hairStyle, eyes: p.eyes,
      height: num(p.heightScale, 1), build: p.build,
      level: clamp(int(p.level, 1), 1, LEVEL_CAP),
      x: p.pos ? num(p.pos.x, 0) : undefined, z: p.pos ? num(p.pos.z, 0) : undefined, yaw: num(p.yaw, 0),
    };
  }
  function abilityList(p) {
    const a = p.abilities;
    if (a instanceof Set) return Array.from(a);
    if (Array.isArray(a)) return a.slice();
    if (isObj(a)) return Object.keys(a);
    return [];
  }
  function questsSnapshot() {
    const Q = G.Quests; if (!Q) return null;
    if (hasFn(Q, 'serialize')) {
      try { const s = jsonClone(Q.serialize(), 10); if (s !== undefined) return s; } catch (e) { report(e, 'quests.serialize'); }
    }
    const state = jsonClone(Q.state || {}, 8) || {};
    const tracked = (typeof Q.tracked === 'string' && Q.tracked) ? Q.tracked : null;
    return { state: state, tracked: tracked };
  }
  function aiSnapshot() {
    const A = G.AIPlayers; if (!A || !hasFn(A, 'serialize')) return null;
    try { const s = jsonClone(A.serialize(), 10); return s === undefined ? null : s; } catch (e) { report(e, 'aiplayers.serialize'); return null; }
  }
  function playerSnapshot(p) {
    const inv = [];
    const src = Array.isArray(p.inventory) ? p.inventory : [];
    for (let i = 0; i < src.length; i++) inv.push(src[i] ? (jsonClone(src[i], 6) || null) : null);
    trimTrailingNulls(inv);
    const eq = {};
    const slots = EQUIP_SLOTS.slice();
    if (isObj(p.equipment)) for (const k in p.equipment) if (slots.indexOf(k) < 0) slots.push(k);
    for (let i = 0; i < slots.length; i++) { const inst = p.equipment ? p.equipment[slots[i]] : null; eq[slots[i]] = inst ? (jsonClone(inst, 6) || null) : null; }
    const hotbar = [];
    for (let i = 0; i < HOTBAR_SIZE; i++) { const id = Array.isArray(p.hotbar) ? p.hotbar[i] : null; hotbar.push(typeof id === 'string' && id ? id : null); }
    return {
      // Saving mid-voyage would reload the player floating in open water with no boat, so
      // record the nearest shore instead (an explicit Save Now is the only way to get here;
      // autosave and the unload flush already refuse while sailing).
      pos: shorePos(p),
      yaw: num(p.yaw, 0),
      level: clamp(int(p.level, 1), 1, LEVEL_CAP), xp: Math.max(0, num(p.xp, 0)), gold: Math.max(0, int(p.gold, 0)),
      morale: num(p.morale, 0), power: num(p.power, 0),
      inventory: inv, equipment: eq,
      abilities: abilityList(p).filter(function (id) { return typeof id === 'string'; }).sort(),
      hotbar: hotbar,
      mounts: Array.isArray(p.mounts) ? p.mounts.filter(function (t) { return typeof t === 'string'; }) : [],
      activeMount: typeof p.activeMount === 'string' ? p.activeMount : null,
      titles: Array.isArray(p.titles) ? p.titles.filter(function (t) { return typeof t === 'string'; }) : [],
      activeTitle: typeof p.activeTitle === 'string' ? p.activeTitle : null,
      statBonus: numericMap(p.statBonus), statOverride: numericMap(p.statOverride),
    };
  }
  /** Build the JSON-safe snapshot of the running game (null without a player). Throws only on programmer error. */
  // Land position to persist: the player's own spot, unless they are afloat.
  function shorePos(p) {
    const at = { x: num(p.pos && p.pos.x, 0), y: num(p.pos && p.pos.y, 0), z: num(p.pos && p.pos.z, 0) };
    const afloat = !!(G.Boats && (G.Boats.sailing || G.Boats.travelling)) ||
      !!(G.Terrain && typeof G.Terrain.isWater === 'function' && G.Terrain.isWater(at.x, at.z));
    if (!afloat) return at;
    let best = null;
    if (G.Physics && typeof G.Physics.nearestFree === 'function') {
      try { best = G.Physics.nearestFree(at.x, at.z, (p.radius || 0.4) + 0.2); } catch (e) { best = null; }
    }
    if (best && G.Terrain && typeof G.Terrain.isWater === 'function' && G.Terrain.isWater(best.x, best.z)) best = null;
    if (!best && G.Boats && typeof G.Boats.nearestDock === 'function') {
      try { const d = G.Boats.nearestDock(p.pos); if (d && d.pos) best = { x: d.pos.x, z: d.pos.z }; } catch (e) { /* ignore */ }
    }
    if (!best) return at;
    const y = (G.Physics && typeof G.Physics.groundY === 'function') ? G.Physics.groundY(best.x, best.z) : at.y;
    return { x: num(best.x, at.x), y: num(y, at.y), z: num(best.z, at.z) };
  }

  function snapshot() {
    const p = player(); if (!p) return null;
    const st = G.state || {};
    const stats = isObj(st.stats) ? st.stats : {};
    const UI = G.UI;
    const wp = (UI && isObj(UI.waypoint) && typeof UI.waypoint.x === 'number' && typeof UI.waypoint.z === 'number') ? UI.waypoint : null;
    const data = {
      version: VERSION,
      game: GAME_NAME, gameVersion: str(G.VERSION, ''),
      savedAt: now(),
      savedWall: Date.now(),                // wall-clock metadata for the 'Continue' card only (never used as gameplay time)
      playTime: Math.max(0, num(stats.playTime, 0)),
      charSpec: jsonClone(charSpecOf(p), 3),
      player: playerSnapshot(p),
      stats: jsonClone(stats, 4) || {},
      fishingSkill: clamp(num(st.fishingSkill, 1), 1, 100),
      zone: str(st.zone, 'shire'),
      time: {
        dayTime: num(G.time && G.time.dayTime, 8),
        dayIndex: Math.max(0, int(G.Sky && G.Sky.dayIndex, 0)),
        dayLengthMinutes: num(G.time && G.time.dayLengthMinutes, 24),
      },
      weather: str(st.weather, 'clear'),
      quests: questsSnapshot(),
      aiplayers: aiSnapshot(),
      autoQuest: G.AutoQuest ? { speed: num(G.AutoQuest.speed, 3) } : null,
      settings: jsonClone(isObj(st.settings) ? st.settings : SETTINGS_DEFAULTS, 3) || {},
      quality: str(st.quality, 'high'),
      customPlaces: Array.isArray(st.customPlaces) ? (jsonClone(st.customPlaces.slice(0, MAX_CUSTOM_PLACES), 4) || []) : [],
      waypoint: wp ? { x: wp.x, z: wp.z, label: str(wp.label, 'Waypoint') } : null,
      adminFlags: {
        godMode: !!st.godMode, damageMult: num(st.damageMult, 1), noCooldowns: !!st.noCooldowns,
        speedMult: num(p.speedMult, num(st.speedMult, 1)),
      },
      uidCounter: hasFn(G, 'uidBump') ? int(G.uidBump(), 0) : 0,
    };
    return data;
  }

  // ------------------------------------------------------------------------------------------------ validation & migration
  // MIGRATIONS[v] upgrades a save of version v to v+1. Version 0 = pre-release saves without a version field (same shape).
  const MIGRATIONS = [
    function v0to1(d) { return d; },
  ];
  /** → { ok, data (detached, migrated, normalised) } or { ok:false, error }. Never throws. */
  function validate(input) {
    try {
      if (!isObj(input)) return { ok: false, error: 'the save is not an object' };
      let v = num(input.version, NaN); if (v !== v) v = 0;
      if (v > VERSION) return { ok: false, error: 'this save was written by a newer version of the game (v' + v + ')' };
      let data = jsonClone(input, 14);
      if (!isObj(data)) return { ok: false, error: 'the save could not be read' };
      while (v < VERSION) {
        const m = MIGRATIONS[v];
        if (typeof m !== 'function') return { ok: false, error: 'no migration path from save version ' + v };
        data = m(data) || data; v++; data.version = v;
      }
      data.version = VERSION;
      if (!isObj(data.player)) return { ok: false, error: 'the save holds no character' };
      if (!isObj(data.charSpec)) {
        const pl = data.player;
        if (typeof pl.race === 'string' && typeof pl.cls === 'string') data.charSpec = { race: pl.race, cls: pl.cls, gender: pl.gender, name: pl.name };
        else return { ok: false, error: 'the save holds no character description' };
      }
      const cs = data.charSpec;
      const D = G.Data;
      if (D && D.raceById && !D.raceById[cs.race]) { warn('unknown race "' + cs.race + '" in save — using the default'); cs.race = (D.races && D.races[0]) ? D.races[0].id : 'man'; }
      if (D && D.classById && !D.classById[cs.cls]) { warn('unknown class "' + cs.cls + '" in save — using the default'); cs.cls = (D.classes && D.classes[0]) ? D.classes[0].id : 'guardian'; }
      cs.gender = cs.gender === 'female' ? 'female' : 'male';
      if (typeof cs.name !== 'string' || !cs.name.trim()) cs.name = str(data.player.name, 'Wanderer');
      cs.name = cs.name.trim().slice(0, 24);
      cs.level = clamp(int(cs.level, int(data.player.level, 1)), 1, LEVEL_CAP);
      data.player.level = clamp(int(data.player.level, cs.level), 1, LEVEL_CAP);
      if (!isObj(data.player.pos)) { delete data.player.pos; delete cs.x; delete cs.z; }
      else {
        const half = WORLD_HALF - 8;
        data.player.pos.x = clamp(num(data.player.pos.x, 0), -half, half);
        data.player.pos.z = clamp(num(data.player.pos.z, 0), -half, half);
        cs.x = data.player.pos.x; cs.z = data.player.pos.z; cs.yaw = num(data.player.yaw, 0);
      }
      if (!isObj(data.stats)) data.stats = {};
      if (!isObj(data.settings)) data.settings = {};
      if (!isObj(data.time)) data.time = {};
      if (!isObj(data.adminFlags)) data.adminFlags = {};
      if (!Array.isArray(data.customPlaces)) data.customPlaces = [];
      data.playTime = Math.max(0, num(data.playTime, num(data.stats.playTime, 0)));
      data.savedAt = num(data.savedAt, 0);
      data.savedWall = num(data.savedWall, 0);
      return { ok: true, data: data };
    } catch (e) { report(e, 'validate'); return { ok: false, error: 'the save could not be validated' }; }
  }

  // ------------------------------------------------------------------------------------------------ apply
  function computeStats(p) {
    if (G.Player && hasFn(G.Player, 'computeStats') && p === player()) { try { G.Player.computeStats(); } catch (e) { report(e, 'computeStats'); } }
    else if (G.Data && G.Data.stats && hasFn(G.Data.stats, 'compute')) { try { G.Data.stats.compute(p); } catch (e) { report(e, 'stats.compute'); } }
    const st = p.stats || (p.stats = {});
    if (typeof st.maxMorale !== 'number') st.maxMorale = 100;
    if (typeof st.maxPower !== 'number') st.maxPower = 100;
    if (typeof st.speed !== 'number') st.speed = 1;
    return st;
  }
  function firstFreeSlot(inv) { for (let i = 0; i < inv.length; i++) if (!inv[i]) return i; return -1; }

  function applyPlayer(p, d, dropped) {
    const pl = d.player;
    if (G.Progress && hasFn(G.Progress, 'ensurePlayerShape')) { try { G.Progress.ensurePlayerShape(p); } catch (e) { report(e, 'ensurePlayerShape'); } }
    // ---- level / xp / gold
    const level = clamp(int(pl.level, 1), 1, LEVEL_CAP);
    p.level = level;
    const XP = G.Data && G.Data.xp;
    let lo = 0, hi = Infinity;
    if (XP && hasFn(XP, 'forLevel')) { lo = num(XP.forLevel(level), 0); hi = level < LEVEL_CAP ? Math.max(lo, num(XP.forLevel(level + 1), lo + 1) - 1) : num(XP.forLevel(LEVEL_CAP), lo); }
    p.xp = clamp(num(pl.xp, lo), lo, hi);
    p.gold = Math.max(0, int(pl.gold, 0));
    // ---- inventory (in place — other modules may hold the array)
    if (!Array.isArray(p.inventory)) p.inventory = [];
    const inv = p.inventory;
    inv.length = INV_SLOTS;
    for (let i = 0; i < INV_SLOTS; i++) inv[i] = null;
    const src = Array.isArray(pl.inventory) ? pl.inventory : [];
    const overflow = [];
    for (let i = 0; i < src.length; i++) {
      const inst = src[i] ? sanitizeInstance(src[i], dropped.items) : null;
      if (!inst) continue;
      if (i < INV_SLOTS) inv[i] = inst; else overflow.push(inst);
    }
    for (let i = 0; i < overflow.length; i++) { const f = firstFreeSlot(inv); if (f < 0) { dropped.items.push(overflow[i].tid); break; } inv[f] = overflow[i]; }
    // ---- equipment
    if (!isObj(p.equipment)) p.equipment = {};
    const eqSrc = isObj(pl.equipment) ? pl.equipment : {};
    const eqSlots = EQUIP_SLOTS.slice();
    for (const k in p.equipment) if (eqSlots.indexOf(k) < 0) eqSlots.push(k);
    for (let i = 0; i < eqSlots.length; i++) {
      const slot = eqSlots[i];
      const inst = eqSrc[slot] ? sanitizeInstance(eqSrc[slot], dropped.items) : null;
      if (inst && !isEquippable(inst)) { const f = firstFreeSlot(inv); if (f >= 0) inv[f] = inst; else dropped.items.push(inst.tid); p.equipment[slot] = null; continue; }
      p.equipment[slot] = inst;
    }
    // ---- abilities
    const list = Array.isArray(pl.abilities) ? pl.abilities : [];
    if (!(p.abilities instanceof Set)) p.abilities = new Set();
    p.abilities.clear();
    for (let i = 0; i < list.length; i++) { const id = list[i]; if (validAbility(id, p.cls)) p.abilities.add(id); else dropped.abilities++; }
    if (!p.abilities.size && G.Progress && hasFn(G.Progress, 'grantStarterAbilities')) { try { G.Progress.grantStarterAbilities(p); } catch (e) { report(e, 'grantStarterAbilities'); } }
    // ---- hotbar
    if (!Array.isArray(p.hotbar)) p.hotbar = [];
    p.hotbar.length = HOTBAR_SIZE;
    const hb = Array.isArray(pl.hotbar) ? pl.hotbar : [];
    for (let i = 0; i < HOTBAR_SIZE; i++) { const id = hb[i]; p.hotbar[i] = (typeof id === 'string' && p.abilities.has(id)) ? id : null; }
    // ---- mounts
    if (Array.isArray(pl.mounts)) {
      const mounts = [];
      for (let i = 0; i < pl.mounts.length; i++) { const tid = pl.mounts[i]; const t = itemTemplate(tid); if (t && t.type === 'mount' && mounts.indexOf(tid) < 0) mounts.push(tid); }
      p.mounts = mounts;
      p.activeMount = (typeof pl.activeMount === 'string' && mounts.indexOf(pl.activeMount) >= 0) ? pl.activeMount : (mounts[0] || null);
    }
    p.mounted = false; p.mountId = null;
    // ---- titles
    if (Array.isArray(pl.titles)) {
      const titles = [];
      for (let i = 0; i < pl.titles.length; i++) { const id = pl.titles[i]; if (titleKnown(id) && titles.indexOf(id) < 0) titles.push(id); }
      p.titles = titles;
      p.activeTitle = (typeof pl.activeTitle === 'string' && titles.indexOf(pl.activeTitle) >= 0) ? pl.activeTitle : null;
    }
    // ---- admin stat overrides
    p.statBonus = numericMap(pl.statBonus);
    p.statOverride = numericMap(pl.statOverride);
    // ---- fresh session state
    if (Array.isArray(p.effects)) p.effects.length = 0; else p.effects = [];
    p.cooldowns = {}; p.gcdReady = 0; p.casting = null; p.target = null; p.autoAttack = false;
    p.alive = true; p.dead = false; p.deathTime = 0; p.invulnerable = false;
    // ---- derived stats & pools
    const st = computeStats(p);
    p.morale = clamp(num(pl.morale, st.maxMorale), 1, st.maxMorale);
    p.power = clamp(num(pl.power, st.maxPower), 0, st.maxPower);
    // ---- visuals
    if (p.rig && hasFn(p.rig, 'setEquipment')) { try { p.rig.setEquipment(p.equipment); } catch (e) { report(e, 'rig.setEquipment'); } }
    emit('equipChanged', p); emit('inventoryChanged', p); emit('hotbarChanged', -1); emit('goldChanged', p.gold);
  }

  function applyPosition(p, d) {
    const pos = d.player.pos;
    if (!isObj(pos)) return;
    const x = num(pos.x, NaN), z = num(pos.z, NaN), y = num(pos.y, NaN);
    const yaw = num(d.player.yaw, num(p.yaw, 0));
    if (x !== x || z !== z) return;
    const P = G.Player;
    if (P && hasFn(P, 'spawnAt')) P.spawnAt(x, z, yaw);
    else if (P && hasFn(P, 'teleport')) P.teleport(x, z, yaw);
    else if (p.pos && hasFn(p.pos, 'set')) { p.pos.set(x, y === y ? y : p.pos.y, z); p.yaw = yaw; }
    // upper floors / bridges / docks: keep the saved height when it is a little above the resolved ground (physics settles it)
    if (p.pos && y === y && y > p.pos.y && y - p.pos.y < 8) p.pos.y = y;
    if (G.Spatial && hasFn(G.Spatial, 'update')) { try { G.Spatial.update(p); } catch (e) { /* not registered yet */ } }
    const zone = str(d.zone, '');
    const terrainKnowsZones = !!(G.Terrain && hasFn(G.Terrain, 'zoneAt'));
    if (zone && zoneKnown(zone) && (!terrainKnowsZones || !G.state.zone)) G.state.zone = zone;
  }

  function applyWorld(d) {
    const t = d.time || {};
    const h = num(t.dayTime, NaN);
    if (h === h) {
      if (G.Sky && hasFn(G.Sky, 'setTime')) G.Sky.setTime(h);
      else if (G.time) G.time.dayTime = ((h % 24) + 24) % 24;
    }
    if (G.Sky && typeof t.dayIndex === 'number') { try { G.Sky.dayIndex = Math.max(0, int(t.dayIndex, 0)); } catch (e) { /* read-only in some builds */ } }
    if (G.time && typeof t.dayLengthMinutes === 'number') G.time.dayLengthMinutes = clamp(t.dayLengthMinutes, 1, 24 * 60);
    const w = str(d.weather, '');
    if (w && weatherKnown(w)) {
      if (G.Sky && hasFn(G.Sky, 'setWeather')) G.Sky.setWeather(w, true);
      else G.state.weather = w;
    }
    G.state.fishingSkill = clamp(num(d.fishingSkill, 1), 1, 100);
    const st = isObj(G.state.stats) ? G.state.stats : (G.state.stats = {});
    const saved = isObj(d.stats) ? d.stats : {};
    for (const k in saved) {
      const v = saved[k];
      if (typeof v === 'number' && isFinite(v)) st[k] = v;
      else if (isPlain(v)) st[k] = jsonClone(v, 3) || {};
    }
    st.playTime = Math.max(0, num(d.playTime, num(saved.playTime, 0)));
    if (typeof st.kills !== 'number') st.kills = 0;
    if (typeof st.quests !== 'number') st.quests = 0;
    if (typeof st.fish !== 'number') st.fish = 0;
    if (typeof st.deaths !== 'number') st.deaths = 0;
  }

  function sanitizeQuestState(src, dropped) {
    const out = {};
    if (!isObj(src)) return out;
    for (const id in src) {
      if (!questKnown(id)) { dropped.quests++; continue; }
      const e = src[id]; if (!isObj(e)) continue;
      const entry = {
        status: QUEST_STATUS.indexOf(e.status) >= 0 ? e.status : 'active',
        progress: Array.isArray(e.progress) ? e.progress.map(function (n) { return Math.max(0, int(n, 0)); }) : [],
        accepted: num(e.accepted, 0),
      };
      for (const k in e) if (!(k in entry) && k.charCodeAt(0) !== 95) { const c = jsonClone(e[k], 4); if (c !== undefined) entry[k] = c; }
      out[id] = entry;
    }
    return out;
  }
  function applyQuests(d, dropped) {
    const Q = G.Quests; if (!Q) return;
    const q = d.quests; if (q == null) return;
    if (hasFn(Q, 'restore')) { Q.restore(q); return; }
    // fallback contract: G.Quests.state (id → entry) + G.Quests.tracked
    const state = sanitizeQuestState(isObj(q) ? q.state : null, dropped);
    if (Q.state instanceof Map) { Q.state.clear(); for (const id in state) Q.state.set(id, state[id]); }
    else if (isObj(Q.state)) { for (const k in Q.state) delete Q.state[k]; for (const id in state) Q.state[id] = state[id]; }
    else Q.state = state;
    const tracked = (isObj(q) && typeof q.tracked === 'string' && state[q.tracked]) ? q.tracked : null;
    if (hasFn(Q, 'setTracked')) { try { Q.setTracked(tracked); } catch (e) { Q.tracked = tracked; } }
    else Q.tracked = tracked;
  }
  function applyAIPlayers(d) {
    const A = G.AIPlayers; if (!A || d.aiplayers == null) return;
    if (hasFn(A, 'restore')) A.restore(d.aiplayers);
  }
  function applySettings(d) {
    const s = isObj(G.state.settings) ? G.state.settings : (G.state.settings = Object.assign({}, SETTINGS_DEFAULTS));
    const saved = isObj(d.settings) ? d.settings : {};
    for (const k in saved) {
      const v = saved[k];
      if (v == null || typeof v === 'object' || typeof v === 'function') continue;
      if (k in SETTINGS_DEFAULTS && typeof SETTINGS_DEFAULTS[k] !== typeof v) continue;
      s[k] = v;
    }
    s.music = clamp(num(s.music, SETTINGS_DEFAULTS.music), 0, 1);
    s.sfx = clamp(num(s.sfx, SETTINGS_DEFAULTS.sfx), 0, 1);
    s.mouseSens = clamp(num(s.mouseSens, 1), 0.1, 5);
    s.cameraDist = clamp(num(s.cameraDist, 7), 1.5, 28);
    if (G.Audio && hasFn(G.Audio, 'setVolumes')) { try { G.Audio.setVolumes(s.music, s.sfx); } catch (e) { report(e, 'setVolumes'); } }
    const q = str(d.quality, '');
    if (q && QUALITIES.indexOf(q) >= 0) {
      if (G.PostFX && hasFn(G.PostFX, 'setQuality')) { try { G.PostFX.setQuality(q); } catch (e) { report(e, 'setQuality'); } }
      else G.state.quality = q;
    }
    if (G.Player && hasFn(G.Player, 'setCameraDistance')) { try { G.Player.setCameraDistance(s.cameraDist); } catch (e) { /* camera not ready */ } }
    if (G.AutoQuest && isObj(d.autoQuest) && typeof d.autoQuest.speed === 'number') { try { G.AutoQuest.speed = clamp(d.autoQuest.speed, 1, 10); } catch (e) { /* read-only */ } }
  }
  function applyPlaces(d) {
    const list = Array.isArray(d.customPlaces) ? d.customPlaces : [];
    const out = [];
    for (let i = 0; i < list.length && out.length < MAX_CUSTOM_PLACES; i++) {
      const src = list[i]; if (!isObj(src)) continue;
      const x = num(src.x, num(src.pos && src.pos.x, NaN)), z = num(src.z, num(src.pos && src.pos.z, NaN));
      if (x !== x || z !== z) continue;
      const place = jsonClone(src, 4) || {};
      place.x = clamp(x, -WORLD_HALF, WORLD_HALF); place.z = clamp(z, -WORLD_HALF, WORLD_HALF);
      place.name = str(place.name, 'Place').slice(0, 48) || 'Place';
      delete place.pos;
      out.push(place);
    }
    G.state.customPlaces = out;
    const wp = d.waypoint;
    if (G.UI && isObj(wp) && typeof wp.x === 'number' && typeof wp.z === 'number') G.UI.waypoint = { x: wp.x, z: wp.z, label: str(wp.label, 'Waypoint') };
  }
  function applyAdmin(p, d) {
    const a = isObj(d.adminFlags) ? d.adminFlags : {};
    G.state.godMode = !!a.godMode;
    G.state.damageMult = clamp(num(a.damageMult, 1), 0, 1000);
    G.state.noCooldowns = !!a.noCooldowns;
    const sm = clamp(num(a.speedMult, 1), 0.1, 50);
    G.state.speedMult = sm;
    p.speedMult = sm;
  }

  let _pendingQuests = null;
  /** Restore a validated snapshot onto the live game. Call after G.Player.create(data.charSpec). Never throws. */
  function apply(data) {
    const p = player();
    if (!p) { warn('apply() called without a player — create the character first'); return false; }
    const v = validate(data);
    if (!v.ok) { notify('This save could not be loaded: ' + v.error + '.', 'warning'); S.lastError = v.error; return false; }
    data = v.data;
    const dropped = { items: [], abilities: 0, quests: 0 };
    S.suspended = true;
    try {
      stage('uid', function () { if (hasFn(G, 'uidBump')) G.uidBump(Math.max(0, int(data.uidCounter, 0))); });
      stage('player', function () { applyPlayer(p, data, dropped); });
      stage('position', function () { applyPosition(p, data); });
      stage('world', function () { applyWorld(data); });
      stage('quests', function () { applyQuests(data, dropped); });
      stage('aiplayers', function () { applyAIPlayers(data); });
      stage('settings', function () { applySettings(data); });
      stage('places', function () { applyPlaces(data); });
      stage('admin', function () { applyAdmin(p, data); });
      _pendingQuests = data.quests;
      if (dropped.items.length) notify(dropped.items.length + (dropped.items.length === 1 ? ' item' : ' items') + ' from an older version no longer exist and left your bags.', 'warning');
      if (dropped.abilities) warn(dropped.abilities + ' unknown ability id(s) dropped from the save');
      if (dropped.quests) warn(dropped.quests + ' unknown quest id(s) dropped from the save');
      S.last = data; S.lastError = null;
      _lastAutoAt = now();
      emit('load', data);
      return true;
    } catch (e) { report(e, 'apply'); notify('Something went wrong while loading the save.', 'warning'); return false; }
    finally { S.suspended = false; }
  }

  // ------------------------------------------------------------------------------------------------ save / load / etc
  function save(opts) {
    opts = opts || {};
    try {
      if (!player()) { if (!opts.silent) notify('There is no character to save.', 'warning'); return null; }
      let data = snapshot();
      if (!data) return null;
      let text = JSON.stringify(data);
      let w = writeRaw(text);
      if (!w.persisted && w.quota && data.aiplayers != null) {           // retry slimmer (AI players rebuild deterministically)
        data.aiplayers = null; data.slim = true;
        text = JSON.stringify(data); w = writeRaw(text);
      }
      S.last = data; S.lastSavedAt = data.savedAt; S.lastSize = text.length; S.persisted = !!w.persisted; S.saves++;
      S.lastReason = str(opts.reason, opts.silent ? 'auto' : 'manual');
      if (w.persisted) S.lastError = null;
      else {
        S.lastError = w.error;
        if (w.quota) notify('Save failed: the browser storage is full. Export your save from the admin panel (type "chris").', 'warning');
        else if (!opts.silent) notify('Save kept in memory only: ' + w.error + '.', 'warning');
      }
      if (text.length > MAX_SAVE_BYTES) warn('save is unusually large (' + Math.round(text.length / 1024) + ' KB)');
      emit('save', data);
      if (!opts.silent) notify('Game saved', 'info');
      else chip();
      return data;
    } catch (e) { report(e, 'save'); S.lastError = 'exception'; notify('Could not save the game.', 'warning'); return null; }
  }
  function load() {
    try {
      const raw = readRaw();
      if (!raw) return null;
      let parsed;
      try { parsed = JSON.parse(raw); } catch (e) { S.lastError = 'corrupt'; report(e, 'load:parse'); return null; }
      const v = validate(parsed);
      if (!v.ok) { S.lastError = v.error; warn('stored save rejected: ' + v.error); return null; }
      S.lastError = null;
      return v.data;
    } catch (e) { report(e, 'load'); return null; }
  }
  function hasSave() { return load() !== null; }
  function clear() {
    const ok = removeRaw();
    S.last = null; S.lastSavedAt = -1; S.lastSize = 0; S.persisted = false;
    emit('saveCleared');
    return ok;
  }
  function exportJSON() {
    try {
      const data = player() ? snapshot() : load();
      return data ? JSON.stringify(data, null, 2) : '';
    } catch (e) { report(e, 'exportJSON'); return ''; }
  }
  function importJSON(text) {
    try {
      if (typeof text !== 'string' || !text.trim()) return { ok: false, error: 'nothing to import' };
      let parsed;
      try { parsed = JSON.parse(text); } catch (e) { return { ok: false, error: 'not valid JSON (' + (e && e.message ? e.message : 'parse error') + ')' }; }
      const v = validate(parsed);
      if (!v.ok) return { ok: false, error: v.error };
      const w = writeRaw(JSON.stringify(v.data));
      if (!w.persisted && w.quota) return { ok: false, error: w.error };
      S.last = v.data; S.persisted = !!w.persisted; S.lastError = w.persisted ? null : w.error;
      return { ok: true, data: v.data, summary: summary(v.data), persisted: !!w.persisted };
    } catch (e) { report(e, 'importJSON'); return { ok: false, error: 'import failed' }; }
  }
  function countDone(q) {
    if (!isObj(q)) return 0;
    if (typeof q.done === 'number') return q.done;
    const st = q.state;
    let n = 0;
    if (isObj(st)) for (const id in st) { const e = st[id]; if (e && e.status === 'done') n++; }
    return n;
  }
  function summary(data) {
    try {
      data = isObj(data) ? data : load();
      if (!data) return null;
      const cs = isObj(data.charSpec) ? data.charSpec : {};
      const pl = isObj(data.player) ? data.player : {};
      return {
        name: str(cs.name, 'Unknown'), race: str(cs.race, ''), raceName: raceName(cs.race), cls: str(cs.cls, ''), className: className(cs.cls),
        gender: str(cs.gender, 'male'), level: clamp(int(pl.level, 1), 1, LEVEL_CAP),
        zone: str(data.zone, ''), zoneName: zoneName(data.zone),
        playTime: num(data.playTime, 0), playTimeText: fmtPlayTime(data.playTime),
        savedAt: num(data.savedAt, 0), savedWall: num(data.savedWall, 0), savedAgoText: fmtAgo(num(data.savedWall, 0)),
        gold: Math.max(0, int(pl.gold, 0)), questsDone: countDone(data.quests), version: int(data.version, VERSION),
      };
    } catch (e) { report(e, 'summary'); return null; }
  }

  // ------------------------------------------------------------------------------------------------ autosave
  let _timer = null, _chipAt = -Infinity, _lastAutoAt = -Infinity;
  function chip() { const t = now(); if (t - _chipAt >= CHIP_PERIOD) { _chipAt = t; notify('Saved', 'info'); } }
  function canAutosave() {
    if (!S.autosaveEnabled || S.suspended) return false;
    if (!G.state || G.state.phase !== 'playing') return false;
    const p = player();
    if (!p || p.alive === false || p.dead) return false;
    if (G.Boats && G.Boats.sailing) return false;
    return true;
  }
  function autosave(reason) {
    if (!canAutosave()) return null;
    const r = save({ silent: true, reason: reason || 'auto' });
    if (r) _lastAutoAt = now();
    return r;
  }
  function armTimer() {
    if (_timer && G.timers && hasFn(G.timers, 'cancel')) G.timers.cancel(_timer);
    _timer = (G.timers && hasFn(G.timers, 'every')) ? G.timers.every(AUTOSAVE_PERIOD, function () { autosave('periodic'); }) : null;
  }
  const debouncedAutosave = (typeof G.debounce === 'function')
    ? G.debounce(function (reason) { autosave(reason); }, EVENT_DEBOUNCE_MS)
    : function (reason) { autosave(reason); };
  function flushAutosave(reason) {
    if (typeof debouncedAutosave.cancel === 'function') debouncedAutosave.cancel();
    return autosave(reason);
  }

  // ------------------------------------------------------------------------------------------------ namespace
  const S = G.Save = {
    VERSION: VERSION, KEY: KEY,
    save: save, load: load, hasSave: hasSave, clear: clear, exportJSON: exportJSON, importJSON: importJSON, summary: summary,
    apply: apply, snapshot: snapshot, validate: validate, autosave: autosave, flushAutosave: flushAutosave,
    fmtPlayTime: fmtPlayTime, storageAvailable: storageAvailable,
    autosaveEnabled: true, suspended: false,
    last: null, lastSavedAt: -1, lastError: null, lastSize: 0, lastReason: '', persisted: false, saves: 0,
    get lastAutosaveAt() { return _lastAutoAt; },
    get autosavePeriod() { return AUTOSAVE_PERIOD; },
  };

  // ------------------------------------------------------------------------------------------------ hooks
  if (typeof G.on === 'function') {
    G.on('gameStart', function () {
      armTimer();
      _lastAutoAt = now(); _chipAt = -Infinity;
      // safety net: if G.Quests.init() ran after apply() and wiped the restored state, put it back once
      const Q = G.Quests, pq = _pendingQuests; _pendingQuests = null;
      if (Q && pq && hasFn(Q, 'restore') && isObj(pq)) {
        const live = Q.state;
        const liveEmpty = live instanceof Map ? live.size === 0 : (isObj(live) ? Object.keys(live).length === 0 : true);
        const savedHas = isObj(pq.state) ? Object.keys(pq.state).length > 0 : false;
        if (liveEmpty && savedHas) { try { Q.restore(pq); warn('quest state restored again after G.Quests.init() — call init() before G.Save.apply()'); } catch (e) { report(e, 'quests.restore(late)'); } }
      }
    });
    G.on('questCompleted', function () { debouncedAutosave('quest'); });
    G.on('playerLevelUp', function () { debouncedAutosave('level'); });
    G.on('panelClosed', function () { debouncedAutosave('panel'); });
    G.on('playerDeath', function () { if (typeof debouncedAutosave.cancel === 'function') debouncedAutosave.cancel(); });
  }
  armTimer();
  try {
    window.addEventListener('beforeunload', function () { flushAutosave('unload'); });
    window.addEventListener('pagehide', function () { flushAutosave('pagehide'); });
    document.addEventListener('visibilitychange', function () { if (document.hidden) flushAutosave('hidden'); });
  } catch (e) { /* no DOM (tests) */ }
})();
