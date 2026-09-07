/* ==== 22_monsters.js — G.Monsters: every hostile creature in Middle-earth. Spawn groups and bosses from the
   world registry (G.Data.world.monsterTypes / spawns / bosses) become entities only while the player is near
   (spawn < 260 m, despawn > 340 m with hysteresis, kept while fighting or while AI players fight them < 400 m).
   Monster AI runs in LOD tiers (< 60 m every frame, < 260 m every 4th frame with accumulated dt, farther: only
   timers): idle (family growls/howls), wander (land only, gentle slopes, never into towns), chase (threat-first
   targeting, level-difference and stealth scaled aggro, line of sight, leash at 60 m, stuck detection, pack
   calls), attack (basic attacks every 1.8 s ± 10 %, 35 % ability use, elites/bosses telegraph big abilities,
   strafing/circling between swings, ranged opportunists and casters), flee (cowardly families at < 20 % morale),
   leash (1.3× speed home, healing, untouchable) and dead (corpse 20 s, group respawn timer, boss respawn).
   Combat numbers (morale / dmg / armour / power) come from the hero damage curve — G.Combat.suggestMonsterStats(level,
   {elite, boss}) — which folds the elite (×2.5 morale, ×1.5 dmg) and boss (×8 morale, ×2 dmg) multipliers in; the
   registry's speed, aggroRange, size, abilities, loot and flags are kept. Without Combat the registry's own numbers
   are used (05 pre-scales boss/elite types; only opts-flagged ones get ×4 / ×1.8 boss, ×2 / ×1.3 elite here).
   Bosses: stun/knockback immune, ability rotation, boss music while the player fights
   them, "… has awoken!" announcement, crown nameplate. Rigs are built lazily (≤ 60 nearest within 220 m);
   nameplates show name + level coloured by difficulty vs the player and hide beyond 60 m.

   Public API (SPEC §6.3 + extras used by Combat / AutoQuest / Admin / UI):
     init(scene?)                          — reads the registry, builds spawn-group & boss records, hooks events (idempotent)
     update(dt)                            — spawn/despawn by distance, AI, rigs, corpses, respawns
     spawnAt(typeId, x, z, opts)           — opts {level, group, boss, elite, yaw, noRig, extra} → entity | null
     despawn(ent)                          — remove entity + rig immediately (no death, no respawn timer)
     killAllNear(pos, r) → n               — kills through G.Combat.kill when present (else internal kill)
     respawnAll()                          — clears every group/boss and re-populates around the player
     typesInZone(zoneId) → [type]          — types whose zone or spawn groups lie in the zone
     nearestHostile(pos, r, filterFn?)     — nearest living monster; hostilesNear(pos, r) → reused array
     onDamaged(ent, src)                   — Combat hook: wake, (re)target by threat, pack call, flinch
     onTaunt(ent, src)                     — Combat hook: pin the target on `src` for 4 s
     onKilled(ent)                         — entityKilled hook: corpse timer, respawn scheduling, boss bookkeeping
     countAlive(), findType(typeId), groupsForType(typeId), nearestSpawnOf(typeId, pos) → {x,z}|null
     spawnForQuest(typeId, nearPos, count) → [entities]  (AutoQuest: no live target → spawn at the nearest group or nearby)
     stats() → counters; all() → live monster array (read-only); get(id); groups; bosses; setScene(scene);
     setTarget(ent, target); dropTarget(ent); FAMILY (per-family tuning table)
   Entity extras written here (read by Combat/UI): type, typeId, family, elite, boss, dmg (base per hit), armour,
   speed (m/s), aggroRange, abilities (ids), lootTable, xpMult (elite 2, boss 5), attackInterval, home (Vector3),
   group (spawn-group record|null), bossRec, leashing/invulnerable (true while returning home), immune {stun,
   knockback} on bosses, engagedBy (set/cleared by AI players), plate (nameplate sprite), rigSpec.
   Private helpers (rule 2, prefixed _): _dist2sq, _yawTo — tiny math kept local so hot paths never look up G.
   Assumptions: G.Combat.basicAttack/useAbility/kill/damage (guarded), G.Chars.buildMonster/nameplate/
   updateNameplate, G.Physics.moveEntity/nearestFree/lineOfSight, G.Terrain.height/isWater/waterDepth/slope/
   zoneAt/townAt, G.Data.stats.compute/difficultyColor/abilityById, G.FX.spawn, G.Audio.sfx/music, G.UI.notify.
   Scene: init(scene) or G.Game.scene (resolved lazily, so rigs appear once the scene exists). ==== */
(function () {
  'use strict';
  const G = window.G;
  const THREE = window.THREE;
  if (!G) return;

  // ------------------------------------------------------------------------------------------------ tunables
  const C = G.C || {};
  const SPAWN_DIST = C.MONSTER_SPAWN_DIST > 0 ? C.MONSTER_SPAWN_DIST : 260;
  const DESPAWN_DIST = SPAWN_DIST + 80;          // 340 m hysteresis
  const ENGAGED_KEEP_DIST = 400;                  // monsters AI players are fighting stay alive within this
  const RENDER_DIST = C.ENTITY_RENDER_DIST > 0 ? C.ENTITY_RENDER_DIST : 220;
  const RIG_CAP = 60;
  const RIG_BUILDS_PER_SCAN = 6;
  // ---- rig LOD / draw-call budget: only the nearest 24 rigs are fully animated; beyond LOD2_DIST (or past that
  // cap) a rig shows its one cached static mesh, and shadows are cast only within SHADOW_DIST. 5 m hysteresis.
  const LOD1_DIST = 45, LOD2_DIST = 90, SHADOW_DIST = 35, LOD_HYST = 2.5, ANIM_CAP = 24;
  function _lodQuality() { const q = G.state && G.state.quality; return q === 'low' ? 0.5 : q === 'medium' ? 0.75 : 1; }
  function _lodFor(d, cur, mul) {
    const l1 = LOD1_DIST * mul, l2 = LOD2_DIST * mul; let lv = cur;
    if (lv < 2 && d > l2 + LOD_HYST) lv = 2; else if (lv === 2 && d < l2 - LOD_HYST) lv = 1;
    if (lv < 1 && d > l1 + LOD_HYST) lv = 1; else if (lv === 1 && d < l1 - LOD_HYST) lv = 0;
    return lv;
  }
  // returns the rig's effective level (a rig in a state/one-shot animation clamps itself to 1)
  function _applyRigLod(e, rig, d, rank, mul) {
    let lv = _lodFor(d, e._lod || 0, mul);
    if (rank >= Math.round(ANIM_CAP * mul)) lv = 2;
    e._lod = lv;
    if (rig.lodLevel !== lv && typeof rig.setLOD === 'function') rig.setLOD(lv);
    const sd = SHADOW_DIST * mul, sh = e._shadow !== false ? d < sd + LOD_HYST * 2 : d < sd - LOD_HYST * 2;
    if (sh !== e._shadow) { e._shadow = sh; if (typeof rig.setShadow === 'function') rig.setShadow(sh); }
    return typeof rig.lodLevel === 'number' ? rig.lodLevel : lv;
  }
  function _camDist(camera, e) {
    const c = camera && camera.position ? camera.position : null;
    if (!c) return Math.sqrt(e._d2 || 0);
    const dx = e.pos.x - c.x, dy = e.pos.y - c.y, dz = e.pos.z - c.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  const NEAR_TIER = 60;
  const NAMEPLATE_DIST = 60;
  const CORPSE_TIME = 20;
  const CORPSE_SINK_TIME = 3;
  const LEASH_DIST = 60;
  const AGGRO_DROP_DIST = 80;
  const UNREACHABLE_TIME = 10;
  const ATTACK_INTERVAL = 1.8;
  const ABILITY_CHANCE = 0.35;
  const TELEGRAPH_TIME = 0.6;
  const BIG_ABILITY_CD = 10;                      // abilities with a cooldown ≥ this get a telegraph (elite/boss)
  const FLEE_TIME = 4;
  const FLEE_PCT = 0.2;
  const PACK_RADIUS = 12;
  const SEPARATION = 2;
  const BOSS_ANNOUNCE_DIST = 40;
  const WANDER_SPEED = 0.45;
  const LEASH_SPEED = 1.3;
  const LEASH_HEAL_PCT = 0.05;
  const SCAN_INTERVAL = 0.5;
  const BUDGET_INTERVAL = 0.25;
  const AGGRO_SCAN_INTERVAL = 0.3;
  const IDLE_SFX_RATE = 0.035;                    // per second, per monster near the player
  const MAX_SPEED = 20;
  const PI = Math.PI, TAU = Math.PI * 2;

  // per-family flavour: idle sound, cowardice, aquatic, caster / ranged opportunist, default speed
  const FAMILY = {
    wolf: { sfx: 'wolf_howl', pitch: 1.0, coward: true, speed: 7.5 },
    warg: { sfx: 'wolf_howl', pitch: 0.85, speed: 8 },
    lynx: { sfx: 'wolf_howl', pitch: 1.3, speed: 8 },
    boar: { sfx: 'boar_grunt', pitch: 1.0, speed: 6.5 },
    bear: { sfx: 'bear_roar', pitch: 1.0, speed: 6 },
    'lossoth-bear': { sfx: 'bear_roar', pitch: 0.85, speed: 6 },
    spider: { sfx: 'spider_hiss', pitch: 1.0, speed: 6 },
    crawler: { sfx: 'spider_hiss', pitch: 0.8, speed: 5.5 },
    goblin: { sfx: 'orc_growl', pitch: 1.25, coward: true, ranged: true, speed: 6.5 },
    orc: { sfx: 'orc_growl', pitch: 1.0, speed: 6 },
    uruk: { sfx: 'orc_growl', pitch: 0.8, speed: 6.2 },
    brigand: { sfx: null, pitch: 1.0, coward: true, ranged: true, speed: 6.5 },
    troll: { sfx: 'troll_roar', pitch: 1.0, speed: 5 },
    giant: { sfx: 'troll_roar', pitch: 0.75, speed: 4.8 },
    wight: { sfx: 'wight_moan', pitch: 1.0, speed: 4.5 },
    bat: { sfx: 'spider_hiss', pitch: 1.6, speed: 7 },
    drake: { sfx: 'troll_roar', pitch: 1.2, ranged: true, speed: 6.5 },
    slug: { sfx: null, pitch: 1.0, speed: 2.5 },
    sorcerer: { sfx: 'wight_moan', pitch: 1.2, caster: true, speed: 5.5 },
    'sea-serpent': { sfx: 'troll_roar', pitch: 0.9, aquatic: true, ranged: true, speed: 6 },
  };
  const DEFAULT_FAMILY = { sfx: null, pitch: 1.0, speed: 6 };

  // ------------------------------------------------------------------------------------------------ helpers
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  function _dist2sq(x1, z1, x2, z2) { const dx = x2 - x1, dz = z2 - z1; return dx * dx + dz * dz; }
  function _yawTo(dx, dz) { return Math.atan2(-dx, -dz); }
  function wrapA(a) { a = a % TAU; if (a > PI) a -= TAU; else if (a < -PI) a += TAU; return a; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }
  function now() { return (G.time && typeof G.time.now === 'number') ? G.time.now : 0; }
  function rnd() { return typeof G.rand === 'function' ? G.rand() : Math.random(); }
  function hash(x, z, seed) { return typeof G.hash2 === 'function' ? G.hash2(x, z, seed) : ((Math.sin(x * 12.9898 + z * 78.233 + (seed || 0)) * 43758.5453) % 1 + 1) % 1; }
  function hashStr(s) { if (typeof G.hashStr === 'function') return G.hashStr(s) | 0; let h = 0; s = String(s); for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0; return h; }
  function fam(f) { return FAMILY[f] || DEFAULT_FAMILY; }
  function terrainH(x, z) { const T = G.Terrain; return (T && typeof T.height === 'function') ? T.height(x, z) : 0; }
  function isWater(x, z) { const T = G.Terrain; if (T && typeof T.isWater === 'function') return T.isWater(x, z); return terrainH(x, z) < (C.SEA_LEVEL || 0); }
  function waterDepth(x, z) { const T = G.Terrain; if (T && typeof T.waterDepth === 'function') return T.waterDepth(x, z); const d = (C.SEA_LEVEL || 0) - terrainH(x, z); return d > 0 ? d : 0; }
  function slopeAt(x, z) { const T = G.Terrain; return (T && typeof T.slope === 'function') ? T.slope(x, z) : 0; }
  function zoneAt(x, z) { const T = G.Terrain; if (T && typeof T.zoneAt === 'function') return T.zoneAt(x, z); return (G.state && G.state.zone) || 'shire'; }
  function player() { return (G.state && G.state.player) || null; }
  function world() { return (G.Data && G.Data.world) ? G.Data.world : null; }
  function sfx(name, pos, vol, pitch) {
    const A = G.Audio;
    if (!A || typeof A.sfx !== 'function' || !name) return;
    if (typeof A.has === 'function' && !A.has(name)) return;
    _sfxOpts.pos = pos || null; _sfxOpts.vol = vol == null ? 1 : vol; _sfxOpts.pitch = pitch == null ? 1 : pitch;
    try { A.sfx(name, _sfxOpts); } catch (e) { /* audio is optional */ }
  }
  const _sfxOpts = { pos: null, vol: 1, pitch: 1 };
  function fx(kind, pos, opts) {
    const F = G.FX;
    if (!F || typeof F.spawn !== 'function') return null;
    try { return F.spawn(kind, pos, opts); } catch (e) { return null; }
  }
  function notify(text, kind) { const U = G.UI; if (U && typeof U.notify === 'function') { try { U.notify(text, kind || 'warning'); } catch (e) { /* UI optional */ } } }

  // scratch (never allocated in hot paths)
  const _want = THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; } };
  const _eyeA = THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0 };
  const _eyeB = THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0 };
  const _qbuf = [];          // Spatial query output (aggro scan / separation)
  const _hostBuf = [];       // hostilesNear output
  const _cand = [];          // rig budget candidates
  const _tmpList = [];       // kill/despawn iteration copies
  const _fxOpts = { color: 0xff5030, scale: 1, duration: 0.6 };

  // ------------------------------------------------------------------------------------------------ state
  const M = {};
  G.Monsters = M;
  let inited = false;
  let scene = null;
  const types = {};             // typeId → registry type
  const typeList = [];
  const groups = [];            // spawn group records
  const groupsById = {};
  const groupsByType = {};      // typeId → [group]
  const bosses = [];            // boss records
  const bossesById = {};
  const live = [];              // every monster entity (alive + corpses)
  const byId = {};
  let towns = null;             // [{id, x, z, r2}] from the registry (null → G.Terrain.townAt)
  let rigCount = 0;
  let frame = 0;
  let scanT = 0, budgetT = 0;
  let bossMusicRec = null;      // boss record whose music is currently playing
  let zoneTypeCache = {};
  let serial = 0;
  const counters = { spawned: 0, despawned: 0, killed: 0, respawned: 0, attacks: 0, abilities: 0, tier0: 0, tier1: 0, tier2: 0, aiSteps: 0 };
  let _userFilter = null;

  // ------------------------------------------------------------------------------------------------ registry
  function findType(typeId) {
    if (!typeId) return null;
    if (typeof typeId === 'object') return typeId.id && types[typeId.id] ? types[typeId.id] : typeId;
    return types[typeId] || null;
  }
  function levelRange(type) {
    const L = type && type.level;
    if (Array.isArray(L)) { const a = num(L[0], 1), b = num(L[1], a); return a <= b ? [a, b] : [b, a]; }
    const l = num(L, 1);
    return [l, l];
  }
  function midLevel(type) { const r = levelRange(type); return (r[0] + r[1]) * 0.5; }
  function levelScale(level, type) {
    const mid = Math.max(1, midLevel(type));
    const diff = Math.abs(level - mid);
    // packmates of slightly different level differ a little; far outside the type's band the stats follow the world curve
    const exp = 0.7 + 0.8 * clamp((diff - 2) / 6, 0, 1);
    return Math.pow(Math.max(1, level) / mid, exp);
  }
  /** Hero-curve combat numbers from Combat (null when Combat is absent or returns nonsense → registry fallback). */
  function suggestStats(level, elite, boss) {
    const Cb = G.Combat;
    if (!Cb || typeof Cb.suggestMonsterStats !== 'function') return null;
    let s = null;
    _sugOpts.elite = !!elite; _sugOpts.boss = !!boss;
    try { s = Cb.suggestMonsterStats(level, _sugOpts); } catch (e) { if (G.reportError) G.reportError(e, 'Monsters suggestMonsterStats'); return null; }
    if (!s || !(s.morale > 0) || !(s.dmg > 0) || !(s.armour >= 0)) return null;
    return s;
  }
  const _sugOpts = { elite: false, boss: false };
  function loadRegistry() {
    const w = world();
    for (const k in types) delete types[k];
    typeList.length = 0;
    groups.length = 0; bosses.length = 0;
    for (const k in groupsById) delete groupsById[k];
    for (const k in groupsByType) delete groupsByType[k];
    for (const k in bossesById) delete bossesById[k];
    zoneTypeCache = {};
    towns = null;
    if (!w) { if (G.warn) G.warn('G.Monsters: G.Data.world missing — no monsters will spawn'); return; }
    const mt = Array.isArray(w.monsterTypes) ? w.monsterTypes : [];
    for (let i = 0; i < mt.length; i++) {
      const t = mt[i];
      if (!t || !t.id) continue;
      types[t.id] = t;
      typeList.push(t);
    }
    const sp = Array.isArray(w.spawns) ? w.spawns : [];
    for (let i = 0; i < sp.length; i++) {
      const s = sp[i];
      if (!s || !s.type || !types[s.type] || !s.center) continue;
      const g = {
        id: s.id || ('spawn_' + i), type: s.type, typeData: types[s.type],
        center: { x: num(s.center.x, 0), z: num(s.center.z, 0) }, radius: Math.max(4, num(s.radius, 20)),
        count: Math.max(1, Math.round(num(s.count, 3))), respawn: Math.max(1, num(s.respawn, 45)),
        members: [], nextRespawn: [], alive: 0, active: false, serial: 0, zone: null, extras: 0,
      };
      groups.push(g);
      groupsById[g.id] = g;
      (groupsByType[g.type] || (groupsByType[g.type] = [])).push(g);
    }
    const bs = Array.isArray(w.bosses) ? w.bosses : [];
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (!b || !b.type || !types[b.type] || !b.pos) continue;
      const rec = {
        id: b.id || ('boss_' + i), type: b.type, typeData: types[b.type], name: b.name || types[b.type].name,
        pos: { x: num(b.pos.x, 0), z: num(b.pos.z, 0) }, respawn: Math.max(5, num(b.respawn, 120)),
        ent: null, active: false, deadAt: -1, respawnAt: 0, announced: false, engaged: false, serial: 0, yaw: num(b.yaw, 0),
      };
      bosses.push(rec);
      bossesById[rec.id] = rec;
    }
    if (Array.isArray(w.towns) && w.towns.length) {
      towns = [];
      for (let i = 0; i < w.towns.length; i++) {
        const t = w.towns[i];
        if (!t || !t.pos) continue;
        const r = Math.max(10, num(t.radius, 40));
        towns.push({ id: t.id, x: num(t.pos.x, 0), z: num(t.pos.z, 0), r: r, r2: r * r });
      }
    }
    if (G.log) G.log('Monsters: types', typeList.length, 'groups', groups.length, 'bosses', bosses.length);
  }
  function inTown(x, z) {
    if (towns) {
      for (let i = 0; i < towns.length; i++) { const t = towns[i]; if (_dist2sq(x, z, t.x, t.z) < t.r2) return true; }
      return false;
    }
    const T = G.Terrain;
    if (T && typeof T.townAt === 'function') return !!T.townAt(x, z);
    return false;
  }
  function groupsForType(typeId) { return groupsByType[typeId] || []; }
  function typesInZone(zoneId) {
    if (!zoneId) return [];
    if (zoneTypeCache[zoneId]) return zoneTypeCache[zoneId].slice();
    const out = [];
    for (let i = 0; i < typeList.length; i++) if (typeList[i].zone === zoneId) out.push(typeList[i]);
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      if (!g.zone) g.zone = zoneAt(g.center.x, g.center.z);
      if (g.zone === zoneId && out.indexOf(g.typeData) < 0) out.push(g.typeData);
    }
    for (let i = 0; i < bosses.length; i++) {
      const b = bosses[i];
      if (!b.zone) b.zone = zoneAt(b.pos.x, b.pos.z);
      if (b.zone === zoneId && out.indexOf(b.typeData) < 0) out.push(b.typeData);
    }
    zoneTypeCache[zoneId] = out;
    return out.slice();
  }
  function nearestSpawnOf(typeId, pos) {
    const px = pos ? num(pos.x, 0) : 0, pz = pos ? num(pos.z, 0) : 0;
    let best = null, bestD = Infinity;
    const gl = groupsByType[typeId];
    if (gl) for (let i = 0; i < gl.length; i++) { const d = _dist2sq(px, pz, gl[i].center.x, gl[i].center.z); if (d < bestD) { bestD = d; best = gl[i].center; } }
    for (let i = 0; i < bosses.length; i++) { const b = bosses[i]; if (b.type !== typeId && b.id !== typeId) continue; const d = _dist2sq(px, pz, b.pos.x, b.pos.z); if (d < bestD) { bestD = d; best = b.pos; } }
    return best ? { x: best.x, z: best.z, dist: Math.sqrt(bestD) } : null;
  }

  // ------------------------------------------------------------------------------------------------ scene / rigs
  function getScene() {
    if (scene) return scene;
    if (G.Game && G.Game.scene) return (scene = G.Game.scene);
    if (G.scene && G.scene.isScene) return (scene = G.scene);
    return null;
  }
  function getCamera() {
    if (G.Player && G.Player.camera) return G.Player.camera;
    if (G.Game && G.Game.camera) return G.Game.camera;
    return null;
  }
  // nameplate text must fit the 512 px plate canvas (bold 42 px): measure, then shorten gracefully
  let _measureCtx;
  function plateWidth(s) {
    if (_measureCtx === undefined) { try { _measureCtx = document.createElement('canvas').getContext('2d') || null; } catch (e) { _measureCtx = null; } }
    if (!_measureCtx) return s.length * 23;
    _measureCtx.font = 'bold 42px "Trebuchet MS", "Segoe UI", Arial, sans-serif';
    return _measureCtx.measureText(s).width;
  }
  const PLATE_MAX_W = 500;
  const _plateOut = { text: '', tagDropped: false };
  function plateText(ent) {
    let prefix = ent.boss ? '♛ ' : '', suffix = ent.elite ? ' (Elite)' : '';
    let name = String(ent.name || '');
    _plateOut.tagDropped = false;
    let text = prefix + name + suffix;
    if (plateWidth(text) <= PLATE_MAX_W) { _plateOut.text = text; return _plateOut; }
    const comma = name.indexOf(',');                      // "Lómëcar, the Serpent of…" → "Lómëcar"
    if (comma > 0) { name = name.slice(0, comma); text = prefix + name + suffix; if (plateWidth(text) <= PLATE_MAX_W) { _plateOut.text = text; return _plateOut; } }
    // the sub-line already says Elite / Boss: drop the tag, then the crown, before touching the name itself
    if (suffix) { _plateOut.tagDropped = true; suffix = ''; text = prefix + name; if (plateWidth(text) <= PLATE_MAX_W) { _plateOut.text = text; return _plateOut; } }
    if (prefix) { _plateOut.tagDropped = true; prefix = ''; text = name; if (plateWidth(text) <= PLATE_MAX_W) { _plateOut.text = text; return _plateOut; } }
    const words = name.split(' ');
    while (words.length > 1) { words.pop(); text = words.join(' ') + '…'; if (plateWidth(text) <= PLATE_MAX_W) { _plateOut.text = text; return _plateOut; } }
    let s = name;
    while (s.length > 3 && plateWidth(s + '…') > PLATE_MAX_W) s = s.slice(0, -1);
    _plateOut.text = s + '…';
    return _plateOut;
  }
  function makeNameplate(ent) {
    const Ch = G.Chars;
    if (!ent.rig || !Ch || typeof Ch.nameplate !== 'function') return;
    if (ent.plate) { if (typeof Ch.releaseNameplate === 'function') Ch.releaseNameplate(ent.plate); ent.plate = null; }
    const p = player();
    const pl = p ? num(p.level, 1) : 1;
    let color = '#ff6a6a';
    if (G.Data && typeof G.Data.difficultyColor === 'function') { try { color = G.Data.difficultyColor(ent.level, pl) || color; } catch (e) { /* keep default */ } }
    const subColor = ent.boss ? '#ff9c3a' : ent.elite ? '#c48bff' : undefined;
    let sp = null;
    const pt = plateText(ent);
    const sub = (ent.boss && pt.tagDropped ? '♛ ' : '') + 'Level ' + ent.level + (ent.boss ? ' Boss' : (ent.elite && pt.tagDropped ? ' Elite' : ''));
    try { sp = Ch.nameplate(pt.text, color, { sub: sub, subColor: subColor }); } catch (e) { sp = null; }
    if (!sp) return;
    const rig = ent.rig;
    const sc = rig.scale > 0 ? rig.scale : 1;
    sp.position.set(0, (rig.height > 0 ? rig.height : ent.height) / sc + 0.45, 0);
    sp.visible = false;
    rig.group.add(sp);
    ent.plate = sp;
    ent.plateLevel = pl;
  }
  function buildRig(ent) {
    if (ent.rig || ent.noRig || ent.despawned) return false;
    const sc = getScene();
    const Ch = G.Chars;
    if (!sc || !Ch || typeof Ch.buildMonster !== 'function') return false;
    if (!ent.rigSpec) ent.rigSpec = Object.assign({}, ent.type, { nameplate: false, level: ent.level, elite: ent.elite, boss: ent.boss, size: ent.size, name: ent.name });
    let rig = null;
    try { rig = Ch.buildMonster(ent.rigSpec); } catch (e) { if (G.reportError) G.reportError(e, 'Monsters.buildRig'); rig = null; }
    if (!rig || !rig.group) return false;
    rig.group.position.copy(ent.pos);
    rig.group.rotation.y = ent.yaw;
    rig.group.userData.entity = ent;
    rig.group.userData.entityId = ent.id;
    sc.add(rig.group);
    ent.rig = rig; ent.mesh = rig.group;
    rigCount++;
    if (ent.dead && typeof rig.setAnim === 'function') rig.setAnim('death');
    makeNameplate(ent);
    return true;
  }
  function disposeRig(ent) {
    const rig = ent.rig;
    if (!rig) return;
    const Ch = G.Chars;
    if (ent.plate) { if (Ch && typeof Ch.releaseNameplate === 'function') Ch.releaseNameplate(ent.plate); else if (ent.plate.parent) ent.plate.parent.remove(ent.plate); ent.plate = null; }
    if (rig.group && rig.group.parent) rig.group.parent.remove(rig.group);
    try { if (typeof rig.dispose === 'function') rig.dispose(); } catch (e) { /* already disposed */ }
    ent.rig = null; ent.mesh = null;
    rigCount = Math.max(0, rigCount - 1);
  }
  const _byD2 = function (a, b) { return a._d2 - b._d2; };
  function rigBudget(px, pz) {
    _cand.length = 0;
    const r2 = RENDER_DIST * RENDER_DIST, far2 = (RENDER_DIST + 15) * (RENDER_DIST + 15);
    for (let i = 0; i < live.length; i++) {
      const e = live[i];
      const d2 = _dist2sq(px, pz, e.pos.x, e.pos.z);
      e._d2 = d2;
      if (e.noRig) continue;
      if (d2 < r2) _cand.push(e);
      else if (e.rig && d2 > far2) disposeRig(e);
    }
    _cand.sort(_byD2);
    let builds = 0;
    for (let i = 0; i < _cand.length; i++) {
      const e = _cand[i];
      e._rank = i;
      if (i < RIG_CAP) { if (!e.rig && builds < RIG_BUILDS_PER_SCAN && buildRig(e)) builds++; }
      else if (e.rig) disposeRig(e);
    }
    _cand.length = 0;
  }

  // ------------------------------------------------------------------------------------------------ spawning
  function pickLevel(type, opts, boss) {
    if (opts && typeof opts.level === 'number' && isFinite(opts.level)) return Math.max(1, Math.round(opts.level));
    const r = levelRange(type);
    if (boss) return r[1];
    if (r[0] === r[1]) return r[0];
    const h = (opts && typeof opts.seed === 'number') ? hash(opts.seed, 17.3, 5) : rnd();
    return r[0] + Math.floor(h * (r[1] - r[0] + 1));
  }
  function landOk(x, z, aquatic) {
    if (x !== x || z !== z) return false;
    const lim = (C.WORLD_SIZE ? C.WORLD_SIZE * 0.5 : 2048) - 8;
    if (x < -lim || x > lim || z < -lim || z > lim) return false;
    if (aquatic) return waterDepth(x, z) >= 1.5;
    if (isWater(x, z)) return false;
    if (slopeAt(x, z) > 0.7) return false;
    if (inTown(x, z)) return false;
    return true;
  }
  function spawnAt(typeId, x, z, opts) {
    opts = opts || {};
    const type = findType(typeId);
    if (!type) { if (G.warn) G.warn('Monsters.spawnAt: unknown monster type ' + typeId); return null; }
    if (!THREE) return null;
    x = num(x, 0); z = num(z, 0);
    const boss = !!(opts.boss || type.boss);
    const elite = !boss && !!(opts.elite || type.elite);
    const level = pickLevel(type, opts, boss);
    const family = type.family || 'wolf';
    const F = fam(family);
    const size = clamp(num(type.size, 1), 0.25, 6);
    const radius = clamp(0.5 * size, 0.3, 2.5);
    const height = clamp(1.6 * size, 0.6, 9);
    // Combat numbers: the hero damage curve (G.Combat.suggestMonsterStats already folds the elite/boss multipliers
    // in, so they are NOT applied again here); fallback = registry numbers (05 pre-scales boss/elite types, so the
    // ×4 morale / ×1.8 dmg boss and ×2 / ×1.3 elite multipliers only apply when the flag comes from opts).
    const sug = suggestStats(level, elite, boss);
    const scale = sug ? 1 : levelScale(level, type);
    const moraleMult = sug ? 1 : boss ? (type.boss ? 1 : 4) : elite ? (type.elite ? 1 : 2) : 1;
    const dmgMult = sug ? 1 : boss ? (type.boss ? 1 : 1.8) : elite ? (type.elite ? 1 : 1.3) : 1;
    const baseMorale = sug ? sug.morale : num(type.morale, 30 + 12 * level);
    const baseDmg = sug ? sug.dmg : num(type.dmg, 3 + level * 1.2);
    const baseArmour = sug ? sug.armour : num(type.armour, level * 5);
    const basePower = sug && sug.power >= 0 ? sug.power : 60 + 10 * level;
    const attackInterval = sug && sug.attackSpeed > 0 ? sug.attackSpeed : ATTACK_INTERVAL;
    const speed = clamp(num(type.speed, F.speed), 0.5, MAX_SPEED);

    const ent = {
      id: undefined, kind: 'monster', typeId: type.id, type: type, name: type.name || type.id, family: family,
      level: level, hostile: type.hostile !== false, faction: 'enemy', elite: elite, boss: boss, size: size,
      pos: new THREE.Vector3(x, 0, z), yaw: num(opts.yaw, hash(x, z, 91) * TAU), vel: new THREE.Vector3(),
      radius: radius, height: height, onGround: true, inWater: false, swimming: false,
      stats: {}, morale: 0, power: 0, alive: true, dead: false, deathTime: 0,
      effects: [], cooldowns: {}, target: null, threat: {},
      mesh: null, rig: null, plate: null, anim: 'idle', animTime: 0, _lod: 0, _shadow: true, _rank: 999,
      dmg: Math.max(1, Math.round(baseDmg * scale * dmgMult)), armour: Math.max(0, Math.round(baseArmour * scale)),
      speed: speed, aggroRange: Math.max(3, num(type.aggroRange, C.AGGRO_RANGE || 14)),
      abilities: Array.isArray(type.abilities) ? type.abilities.slice() : [], lootTable: type.loot || null,
      xpMult: boss ? 5 : elite ? 2 : 1, attackInterval: attackInterval,
      home: new THREE.Vector3(x, 0, z), group: null, bossRec: null, extra: !!opts.extra, noRig: !!opts.noRig,
      leashing: false, invulnerable: false, engagedBy: null, interact: undefined,
      ai: null, _d2: 0, _k: (serial++) & 3, despawned: false, color: type.color,
    };
    if (boss) { ent.immune = { stun: true, knockback: true }; ent.statBonus = { knockbackResist: 1 }; }
    // stats through the shared formula (creature profile: owner baseline for morale/armour)
    ent.baseStats = {
      might: Math.round((8 + 4 * level) * dmgMult), agility: 8 + 3 * level, vitality: Math.round((8 + 4 * level) * moraleMult * 0.5 + 8),
      will: Math.round((6 + 2 * level) * dmgMult), fate: 4 + level,
      maxMorale: Math.max(5, Math.round(baseMorale * scale * moraleMult)), maxPower: basePower, armour: ent.armour,
    };
    ent.stats.maxMorale = ent.baseStats.maxMorale; ent.stats.armour = ent.armour; ent.stats.maxPower = ent.baseStats.maxPower; ent.stats.speed = 1;
    if (G.Data && G.Data.stats && typeof G.Data.stats.compute === 'function') {
      try { G.Data.stats.compute(ent); } catch (e) { if (G.reportError) G.reportError(e, 'Monsters stats.compute'); }
    }
    if (!(ent.stats.maxMorale > 0)) ent.stats.maxMorale = ent.baseStats.maxMorale;
    if (!(ent.stats.maxPower >= 0)) ent.stats.maxPower = ent.baseStats.maxPower;
    if (typeof ent.stats.speed !== 'number') ent.stats.speed = 1;
    ent.morale = ent.stats.maxMorale; ent.power = ent.stats.maxPower;

    // ground placement
    const aquatic = !!F.aquatic;
    let px = x, pz = z, py;
    if (aquatic) {
      py = (C.SEA_LEVEL || 0) - height * 0.55;
      if (!landOk(px, pz, true)) { const w = findWaterNear(px, pz, 40); if (w) { px = w.x; pz = w.z; } }
    } else {
      const P = G.Physics;
      let p = null;
      if (P && typeof P.nearestFree === 'function') { try { p = P.nearestFree(x, z, radius); } catch (e) { p = null; } }
      if (p) { px = num(p.x, x); pz = num(p.z, z); py = num(p.y, NaN); }
      if (!(py === py)) py = (P && typeof P.groundY === 'function') ? P.groundY(px, pz) : terrainH(px, pz);
    }
    ent.pos.set(px, py, pz);
    ent.home.set(px, py, pz);
    ent.ai = {
      state: 'idle', timer: 1 + rnd() * 3, wanderX: px, wanderZ: pz, hasWander: false, leash: LEASH_DIST,
      lastAttack: 0, nextAttack: 0, fleeing: false, fledOnce: false, fleeT: 0, packId: null, acc: 0,
      scanT: rnd() * AGGRO_SCAN_INTERVAL, idleT: 0, strafeDir: 0, strafeT: 0, stuckT: 0, lastX: px, lastZ: pz,
      progressT: 0, bestD: Infinity, telegraphT: 0, telegraphId: null, rot: 0, blockedT: 0, rangedT: 0,
      moving: false, alertYaw: false, sinceDamage: 1e9, tauntedUntil: 0, stuck: false,
    };
    G.addEntity(ent);
    byId[ent.id] = ent;
    live.push(ent);
    counters.spawned++;
    // group / boss bookkeeping
    const g = opts.group ? (typeof opts.group === 'string' ? groupsById[opts.group] : opts.group) : null;
    if (g) {
      ent.group = g; ent.ai.packId = g.id;
      g.members.push(ent);
      if (ent.extra) g.extras++; else g.alive++;
    }
    if (opts.bossRec) { ent.bossRec = opts.bossRec; opts.bossRec.ent = ent; }
    // FX when the player can see it (quest/admin spawns)
    const p = player();
    if (p && p.pos && _dist2sq(p.pos.x, p.pos.z, px, pz) < 60 * 60 && !opts.silent) fx('dust', ent.pos, null);
    return ent;
  }
  function findWaterNear(x, z, r) {
    for (let ring = 1; ring <= 6; ring++) {
      const rr = r * ring / 6;
      for (let i = 0; i < 12; i++) { const a = i * TAU / 12 + ring * 0.5; const px = x + Math.cos(a) * rr, pz = z + Math.sin(a) * rr; if (waterDepth(px, pz) >= 1.5) return { x: px, z: pz }; }
    }
    return null;
  }
  function groupPoint(g, aquatic, out) {
    const s = ++g.serial;
    for (let t = 0; t < 10; t++) {
      const h1 = hash(g.center.x + s * 7.31, g.center.z + t * 3.17, 11), h2 = hash(g.center.x - t * 1.91, g.center.z + s * 5.03, 23);
      const a = h1 * TAU, r = g.radius * (0.15 + 0.85 * Math.sqrt(h2));
      const x = g.center.x + Math.cos(a) * r, z = g.center.z + Math.sin(a) * r;
      if (landOk(x, z, aquatic)) { out.x = x; out.z = z; return true; }
    }
    out.x = g.center.x; out.z = g.center.z;
    return false;
  }
  const _pt = { x: 0, z: 0 };
  function spawnMember(g) {
    const aquatic = !!fam(g.typeData.family).aquatic;
    groupPoint(g, aquatic, _pt);
    const seed = hashStr(g.id) + g.serial * 131;
    return spawnAt(g.type, _pt.x, _pt.z, { group: g, seed: seed, silent: true, yaw: hash(_pt.x, _pt.z, 7) * TAU });
  }
  function fillGroup(g, t) {
    let need = g.count - g.alive - g.nextRespawn.length;
    while (need-- > 0) { if (!spawnMember(g)) break; }
    while (g.nextRespawn.length && g.nextRespawn[0] <= t && g.alive < g.count) {
      g.nextRespawn.shift();
      if (spawnMember(g)) counters.respawned++; else break;
    }
    if (g.nextRespawn.length > g.count) g.nextRespawn.length = g.count;
  }
  function activateGroup(g, t) { g.active = true; fillGroup(g, t); }
  function deactivateGroup(g) {
    g.active = false;
    _tmpList.length = 0;
    for (let i = 0; i < g.members.length; i++) _tmpList.push(g.members[i]);
    for (let i = 0; i < _tmpList.length; i++) despawn(_tmpList[i]);
    _tmpList.length = 0;
  }
  function groupEngaged(g, px, pz) {
    for (let i = 0; i < g.members.length; i++) {
      const m = g.members[i];
      if (m.dead) continue;
      if (m.target && validTarget(m, m.target)) return true;
      if (m.engagedBy && _dist2sq(px, pz, m.pos.x, m.pos.z) < ENGAGED_KEEP_DIST * ENGAGED_KEEP_DIST) return true;
    }
    return false;
  }
  function spawnBoss(rec) {
    const ent = spawnAt(rec.type, rec.pos.x, rec.pos.z, { boss: true, bossRec: rec, silent: true, yaw: rec.yaw });
    if (!ent) return null;
    if (rec.name) ent.name = rec.name;
    ent.ai.leash = LEASH_DIST * 1.2;
    rec.announced = false; rec.engaged = false; rec.deadAt = -1;
    return ent;
  }
  function activateBoss(rec, t) {
    rec.active = true;
    if (!rec.ent && t >= rec.respawnAt) spawnBoss(rec);
  }
  function deactivateBoss(rec) {
    rec.active = false;
    if (rec.ent) despawn(rec.ent);
  }
  function bossEngaged(rec, px, pz) {
    const e = rec.ent;
    if (!e || e.dead) return false;
    if (e.target && validTarget(e, e.target)) return true;
    if (e.engagedBy && _dist2sq(px, pz, e.pos.x, e.pos.z) < ENGAGED_KEEP_DIST * ENGAGED_KEEP_DIST) return true;
    return false;
  }
  function groupScan(px, pz, t) {
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const d = Math.sqrt(_dist2sq(px, pz, g.center.x, g.center.z)) - g.radius;
      if (!g.active) { if (d < SPAWN_DIST) activateGroup(g, t); }
      else if (d > DESPAWN_DIST && !groupEngaged(g, px, pz)) deactivateGroup(g);
      else fillGroup(g, t);
    }
    for (let i = 0; i < bosses.length; i++) {
      const b = bosses[i];
      const d = Math.sqrt(_dist2sq(px, pz, b.pos.x, b.pos.z));
      if (!b.active) { if (d < SPAWN_DIST) activateBoss(b, t); }
      else if (d > DESPAWN_DIST && !bossEngaged(b, px, pz)) deactivateBoss(b);
      else if (!b.ent && t >= b.respawnAt) spawnBoss(b);
    }
  }

  // ------------------------------------------------------------------------------------------------ removal
  function despawn(ent) {
    if (!ent || ent.kind !== 'monster' || ent.despawned) return false;
    ent.despawned = true;
    disposeRig(ent);
    const g = ent.group;
    if (g) {
      const i = g.members.indexOf(ent);
      if (i >= 0) g.members.splice(i, 1);
      if (!ent.dead) { if (ent.extra) g.extras = Math.max(0, g.extras - 1); else g.alive = Math.max(0, g.alive - 1); }
      ent.group = null;
    }
    if (ent.bossRec) {
      const rec = ent.bossRec;
      if (rec.ent === ent) rec.ent = null;
      if (bossMusicRec === rec) restoreMusic();
      ent.bossRec = null;
    }
    const li = live.indexOf(ent);
    if (li >= 0) live.splice(li, 1);
    delete byId[ent.id];
    ent.target = null;
    if (typeof G.removeEntity === 'function') G.removeEntity(ent);
    counters.despawned++;
    return true;
  }
  function killInternal(ent, killer) {
    if (!ent || ent.dead) return;
    ent.morale = 0;
    if (typeof G.emit === 'function') G.emit('entityKilled', { victim: ent, killer: killer || null });
    if (!ent.dead) onKilled(ent);
  }
  function onKilled(ent) {
    if (!ent || ent.kind !== 'monster' || ent.despawned) return;
    if (ent.dead && ent.ai && ent.ai.state === 'dead') return;
    const t = now();
    ent.dead = true; ent.alive = false; ent.deathTime = t; ent.morale = 0;
    ent.target = null; ent.leashing = false; ent.invulnerable = false; ent.engagedBy = null;
    ent.vel.set(0, 0, 0);
    ent.anim = 'death';
    if (ent.ai) { ent.ai.state = 'dead'; ent.ai.telegraphT = 0; ent.ai.telegraphId = null; ent.ai.moving = false; }
    if (ent.rig && typeof ent.rig.setAnim === 'function') ent.rig.setAnim('death', true);
    if (ent.plate) ent.plate.visible = false;
    counters.killed++;
    const g = ent.group;
    if (g) {
      if (ent.extra) g.extras = Math.max(0, g.extras - 1);
      else { g.alive = Math.max(0, g.alive - 1); g.nextRespawn.push(t + g.respawn); }
    }
    const rec = ent.bossRec;
    if (rec) {
      rec.deadAt = t; rec.respawnAt = t + rec.respawn; rec.engaged = false;
      if (rec.ent === ent) rec.ent = null;          // the corpse lingers but the record is free to respawn later
      ent.bossRec = null;
      if (bossMusicRec === rec) restoreMusic();
      const p = player();
      if (p && p.pos && _dist2sq(p.pos.x, p.pos.z, ent.pos.x, ent.pos.z) < 120 * 120) notify(ent.name + ' has been defeated!', 'quest');
    }
    // packmates lose their interest in a dead friend's target only if they never saw it; nothing else to do here
  }
  function corpseStep(ent, dt, t) {
    const age = t - ent.deathTime;
    if (age >= CORPSE_TIME) {
      const p = player();
      if (ent.rig && p && p.pos && _dist2sq(p.pos.x, p.pos.z, ent.pos.x, ent.pos.z) < 80 * 80) fx('death_puff', ent.pos, null);
      despawn(ent);
      return;
    }
    if (ent.rig) {
      const rig = ent.rig;
      const sink = age > CORPSE_TIME - CORPSE_SINK_TIME ? (age - (CORPSE_TIME - CORPSE_SINK_TIME)) / CORPSE_SINK_TIME : 0;
      rig.group.position.set(ent.pos.x, ent.pos.y - sink * sink * ent.height * 1.1, ent.pos.z);
      rig.group.rotation.y = ent.yaw;
      if (typeof rig.play === 'function') rig.play(dt, ent);
    }
  }

  // ------------------------------------------------------------------------------------------------ targeting
  function isFreeTarget(e) {
    if (!e || e.alive === false || e.dead) return false;
    if (e.kind !== 'player' && e.kind !== 'aiplayer' && e.kind !== 'pet') return false;
    if (e.faction === 'enemy') return false;
    if (e.invisible || e.untargetable) return false;
    return true;
  }
  function validTarget(ent, t) {
    if (!isFreeTarget(t) || t === ent || !t.pos) return false;
    return _dist2sq(ent.pos.x, ent.pos.z, t.pos.x, t.pos.z) <= AGGRO_DROP_DIST * AGGRO_DROP_DIST;
  }
  function hasLOS(ent, t) {
    const P = G.Physics;
    if (!P || typeof P.lineOfSight !== 'function' || !THREE) return true;
    _eyeA.set(ent.pos.x, ent.pos.y + ent.height * 0.7, ent.pos.z);
    _eyeB.set(t.pos.x, t.pos.y + (t.height > 0 ? t.height : 1.8) * 0.6, t.pos.z);
    try { return P.lineOfSight(_eyeA, _eyeB); } catch (e) { return true; }
  }
  function effectiveAggro(ent, t) {
    let r = ent.aggroRange;
    const diff = num(t.level, 1) - ent.level;
    if (diff > 0) r *= Math.max(0, 1 - 0.15 * diff);
    const st = t.stats && typeof t.stats.stealth === 'number' ? clamp(t.stats.stealth, 0, 0.9) : 0;
    if (st > 0) r *= (1 - st);
    return Math.max(3, r);
  }
  function threatOf(ent, t) {
    const th = ent.threat;
    if (!th || !t) return 0;
    if (typeof th.get === 'function') { const v = th.get(t.id); return typeof v === 'number' ? v : (v && typeof v.value === 'number' ? v.value : 0); }
    const v = th[t.id]; return typeof v === 'number' ? v : (v && typeof v.value === 'number' ? v.value : 0);
  }
  function topThreat(ent) {
    const th = ent.threat;
    if (!th) return null;
    let best = null, bestV = 0;
    if (typeof th.forEach === 'function' && typeof th.get === 'function') {
      th.forEach(function (v, id) {
        const val = typeof v === 'number' ? v : (v && typeof v.value === 'number' ? v.value : 0);
        if (val <= bestV) return;
        const e = G.getEntity ? G.getEntity(id) : null;
        if (e && validTarget(ent, e)) { best = e; bestV = val; }
      });
    } else if (typeof th === 'object') {
      for (const id in th) {
        const v = th[id];
        const val = typeof v === 'number' ? v : (v && typeof v.value === 'number' ? v.value : 0);
        if (val <= bestV) continue;
        const e = G.getEntity ? G.getEntity(id) : null;
        if (e && validTarget(ent, e)) { best = e; bestV = val; }
      }
    }
    return best;
  }
  const _freeFilter = function (e) { return isFreeTarget(e); };
  function scanForTarget(ent) {
    if (!ent.hostile || !G.Spatial || typeof G.Spatial.query !== 'function') return null;
    if (inTown(ent.pos.x, ent.pos.z)) return null;
    const list = G.Spatial.query(ent.pos.x, ent.pos.z, ent.aggroRange, _freeFilter, _qbuf);
    let best = null, bestD = Infinity;
    for (let i = 0; i < list.length; i++) {
      const t = list[i];
      if (t === ent) continue;
      const d2 = _dist2sq(ent.pos.x, ent.pos.z, t.pos.x, t.pos.z);
      const r = effectiveAggro(ent, t);
      if (d2 > r * r || d2 >= bestD) continue;
      if (inTown(t.pos.x, t.pos.z)) continue;
      if (fam(ent.family).aquatic && waterDepth(t.pos.x, t.pos.z) < 0.4) continue;
      if (!hasLOS(ent, t)) continue;
      best = t; bestD = d2;
    }
    _qbuf.length = 0;
    return best;
  }
  function setTarget(ent, t, quiet) {
    if (!ent || !ent.ai || ent.dead || !t) return false;
    const ai = ent.ai;
    const fresh = ent.target !== t;
    ent.target = t;
    if (ai.state !== 'attack' && ai.state !== 'flee') ai.state = 'chase';
    if (ai.state === 'flee' && !ai.fleeing) ai.state = 'chase';
    ai.bestD = Infinity; ai.progressT = 0; ai.blockedT = 0; ai.stuckT = 0; ai.moving = true;
    ent.leashing = false; ent.invulnerable = false;
    if (fresh && !quiet) {
      const p = player();
      if (p && p.pos && _dist2sq(p.pos.x, p.pos.z, ent.pos.x, ent.pos.z) < 80 * 80) {
        const F = fam(ent.family);
        sfx(F.sfx, ent.pos, 0.9, F.pitch * (0.95 + rnd() * 0.1));
      }
      packCall(ent, t);
    }
    return true;
  }
  function dropTarget(ent) {
    if (!ent || !ent.ai) return;
    ent.target = null;
    const ai = ent.ai;
    if (ai.state === 'chase' || ai.state === 'attack' || ai.state === 'flee') {
      ai.telegraphT = 0; ai.telegraphId = null;
      const dh = _dist2sq(ent.pos.x, ent.pos.z, ent.home.x, ent.home.z);
      if (dh > 16) startLeash(ent); else { ai.state = 'idle'; ai.timer = 1 + rnd() * 2; }
    }
  }
  function packCall(ent, t) {
    const g = ent.group;
    if (!g) return;
    for (let i = 0; i < g.members.length; i++) {
      const m = g.members[i];
      if (m === ent || m.dead || m.target || !m.ai) continue;
      if (m.ai.state === 'leash') continue;
      if (_dist2sq(ent.pos.x, ent.pos.z, m.pos.x, m.pos.z) > PACK_RADIUS * PACK_RADIUS) continue;
      setTarget(m, t, true);
    }
  }
  function startLeash(ent) {
    const ai = ent.ai;
    ai.state = 'leash';
    ent.target = null;
    ent.leashing = true; ent.invulnerable = true;
    ai.telegraphT = 0; ai.telegraphId = null; ai.moving = true;
    if (ent.threat && typeof ent.threat.clear === 'function') ent.threat.clear();
    else if (ent.threat && typeof ent.threat === 'object') for (const k in ent.threat) delete ent.threat[k];
    if (ent.bossRec && bossMusicRec === ent.bossRec) restoreMusic();
    if (ent.bossRec) ent.bossRec.engaged = false;
  }

  // ------------------------------------------------------------------------------------------------ boss music
  function zoneTheme() {
    const w = world();
    const zid = (G.state && G.state.zone) || 'shire';
    if (w && Array.isArray(w.zones)) for (let i = 0; i < w.zones.length; i++) { const z = w.zones[i]; if (z && z.id === zid) return z.music || z.biome || zid; }
    return zid;
  }
  function startBossMusic(rec) {
    if (bossMusicRec === rec) return;
    bossMusicRec = rec;
    rec.engaged = true;
    const A = G.Audio;
    if (A && typeof A.music === 'function') { try { A.music('boss'); } catch (e) { /* audio optional */ } }
  }
  function restoreMusic() {
    if (!bossMusicRec) return;
    bossMusicRec.engaged = false;
    bossMusicRec = null;
    const A = G.Audio;
    if (A && typeof A.music === 'function' && A.currentTheme === 'boss') { try { A.music(zoneTheme()); } catch (e) { /* audio optional */ } }
  }

  // ------------------------------------------------------------------------------------------------ movement
  function faceTo(ent, x, z, dt, rate) {
    const dx = x - ent.pos.x, dz = z - ent.pos.z;
    if (dx * dx + dz * dz < 1e-4) return;
    const want = _yawTo(dx, dz);
    const k = dt * (rate || 10);
    ent.yaw = ent.yaw + wrapA(want - ent.yaw) * (k > 1 ? 1 : k);
  }
  function stepBlocked(ent, dirX, dirZ) {
    // non-swimmers refuse deep water; the serpent refuses land
    const px = ent.pos.x + dirX * 1.6, pz = ent.pos.z + dirZ * 1.6;
    if (fam(ent.family).aquatic) return waterDepth(px, pz) < 0.9;
    if (ent.family === 'bat') return waterDepth(px, pz) > 2.5;
    return waterDepth(px, pz) > 0.9;
  }
  // Moves ent toward (tx,tz) at `speed` m/s. Returns 0 = moving, 1 = arrived, 2 = blocked by water/shore.
  function moveToward(ent, tx, tz, speed, dt, stopDist) {
    const dx = tx - ent.pos.x, dz = tz - ent.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= stopDist) { _want.set(0, 0, 0); return 1; }
    const nx = dx / d, nz = dz / d;
    if (stepBlocked(ent, nx, nz)) { _want.set(0, 0, 0); faceTo(ent, tx, tz, dt, 8); return 2; }
    _want.set(nx * speed, 0, nz * speed);
    faceTo(ent, tx, tz, dt, 9);
    return 0;
  }
  const _sepFilter = function (e) { return e.kind === 'monster' && !e.dead; };
  function separation(ent) {
    if (!G.Spatial || typeof G.Spatial.query !== 'function') return;
    const list = G.Spatial.query(ent.pos.x, ent.pos.z, SEPARATION, _sepFilter, _qbuf);
    let fx_ = 0, fz = 0;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      if (o === ent) continue;
      let dx = ent.pos.x - o.pos.x, dz = ent.pos.z - o.pos.z;
      let d = Math.sqrt(dx * dx + dz * dz);
      if (d < 1e-3) { dx = Math.cos(ent._k * 1.7 + ent.yaw); dz = Math.sin(ent._k * 1.7 + ent.yaw); d = 1; }
      const push = (SEPARATION - d) / SEPARATION;
      fx_ += dx / d * push; fz += dz / d * push;
    }
    _qbuf.length = 0;
    if (fx_ || fz) { _want.x += fx_ * 1.6; _want.z += fz * 1.6; }
  }
  function applyMove(ent, dt) {
    const P = G.Physics;
    const moving = _want.x !== 0 || _want.z !== 0;
    ent.ai.moving = moving;
    if (P && typeof P.moveEntity === 'function') {
      if (moving || !ent.onGround || ent.inWater || ent.swimming || (ent.knockback && (ent.knockback.x || ent.knockback.z || ent.knockback.y))) {
        let left = dt;
        while (left > 0) { const s = left > 0.1 ? 0.1 : left; P.moveEntity(ent, _want, s); left -= s; }
      } else { ent.vel.x = 0; ent.vel.z = 0; }
    } else {
      // no physics module: glide over the analytic terrain
      ent.pos.x += _want.x * dt; ent.pos.z += _want.z * dt;
      ent.pos.y = terrainH(ent.pos.x, ent.pos.z);
      ent.vel.set(_want.x, 0, _want.z);
      if (G.Spatial && typeof G.Spatial.update === 'function') G.Spatial.update(ent);
    }
    // stuck detection (only while trying to move)
    const ai = ent.ai;
    ai.stuckT += dt;
    if (ai.stuckT >= 1) {
      const moved = _dist2sq(ai.lastX, ai.lastZ, ent.pos.x, ent.pos.z);
      ai.lastX = ent.pos.x; ai.lastZ = ent.pos.z; ai.stuckT = 0;
      ai.stuck = moving && moved < 0.09;
    }
  }
  function pickWanderTarget(ent) {
    const ai = ent.ai;
    const g = ent.group;
    const aquatic = !!fam(ent.family).aquatic;
    const cx = g ? g.center.x : ent.home.x, cz = g ? g.center.z : ent.home.z;
    const R = g ? g.radius : (ent.boss ? 10 : 15);
    for (let t = 0; t < 6; t++) {
      const a = rnd() * TAU, r = R * (0.2 + 0.8 * Math.sqrt(rnd()));
      const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
      if (!landOk(x, z, aquatic)) continue;
      // mid-point must be walkable too (no wandering across ponds / cliffs)
      const mx = (ent.pos.x + x) * 0.5, mz = (ent.pos.z + z) * 0.5;
      if (!aquatic && (isWater(mx, mz) || slopeAt(mx, mz) > 0.7)) continue;
      ai.wanderX = x; ai.wanderZ = z; ai.hasWander = true;
      return true;
    }
    ai.hasWander = false;
    return false;
  }

  // ------------------------------------------------------------------------------------------------ abilities
  function abilityData(id) {
    if (!G.Data) return null;
    if (typeof G.Data.abilityById === 'function') return G.Data.abilityById(id);
    return (G.Data.abilities && G.Data.abilities[id]) || null;
  }
  function abilityReady(ent, id, t) {
    const cd = ent.cooldowns;
    if (cd && cd[id] > t) return false;
    if (ent.gcdReady > t + 1e-4) return false;        // Combat's global cooldown field
    if (ent.gcdUntil > t) return false;
    return true;
  }
  function pickAbility(ent, t, wantRanged, dist) {
    const list = ent.abilities;
    if (!list || !list.length) return null;
    const n = list.length;
    const start = ent.boss ? ent.ai.rot % n : Math.floor(rnd() * n);
    for (let i = 0; i < n; i++) {
      const id = list[(start + i) % n];
      if (!abilityReady(ent, id, t)) continue;
      const a = abilityData(id);
      if (a && a.power > 0 && typeof ent.power === 'number' && ent.power < a.power) continue;
      const range = a ? num(a.range, 3.2) : 3.2;
      const selfTarget = a && (a.target === 'self' || a.target === 'party');
      if (wantRanged) { if (selfTarget || range < 8) continue; if (dist > range - 0.5) continue; }
      else if (!selfTarget && dist > range + 0.5) continue;
      if (ent.boss) ent.ai.rot = (start + i + 1) % n;
      return id;
    }
    return null;
  }
  function fireAbility(ent, id, target, t) {
    const Cb = G.Combat;
    let ok = false;
    if (Cb && typeof Cb.useAbility === 'function') {
      try { ok = !!Cb.useAbility(ent, id, target); } catch (e) { if (G.reportError) G.reportError(e, 'Monsters useAbility ' + id); ok = false; }
    }
    const a = abilityData(id);
    if (!ent.cooldowns) ent.cooldowns = {};
    if (ok) {
      if (!(ent.cooldowns[id] > t)) ent.cooldowns[id] = t + (a ? Math.max(1, num(a.cooldown, 6)) : 6);
      counters.abilities++;
      if (ent.rig && typeof ent.rig.setAnim === 'function') ent.rig.setAnim(a && a.anim === 'cast' ? 'cast' : 'attack', true);
    } else {
      // cannot use it now (Combat refused or absent): don't spam — retry after a short while
      ent.cooldowns[id] = t + 2.5;
    }
    return ok;
  }
  function basicAttack(ent, target, t) {
    const Cb = G.Combat;
    let ok = true;
    if (Cb && typeof Cb.basicAttack === 'function') {
      try { const r = Cb.basicAttack(ent, target); ok = r !== false; } catch (e) { if (G.reportError) G.reportError(e, 'Monsters basicAttack'); ok = false; }
    } else if (Cb && typeof Cb.damage === 'function') {
      try { Cb.damage(ent, target, ent.dmg, 'common', null); } catch (e) { ok = false; }
    }
    counters.attacks++;
    ent.ai.lastAttack = t;
    if (ent.rig && typeof ent.rig.setAnim === 'function') ent.rig.setAnim('attack', true);
    return ok;
  }
  function isBig(id) { const a = abilityData(id); return !!a && num(a.cooldown, 0) >= BIG_ABILITY_CD; }
  function isCasting(ent) { return !!(ent.casting || ent.cast || (ent.castBar && ent.castBar.active)); }

  // ------------------------------------------------------------------------------------------------ AI states
  function idleStep(ent, dt, t, d2p) {
    const ai = ent.ai;
    _want.set(0, 0, 0);
    ai.timer -= dt;
    ai.scanT -= dt;
    if (ai.scanT <= 0) {
      ai.scanT = AGGRO_SCAN_INTERVAL;
      const tgt = scanForTarget(ent);
      if (tgt) { setTarget(ent, tgt); return; }
    }
    // menace: turn toward a nearby free person even before aggro
    const p = player();
    if (p && p.pos && ent.hostile && d2p < ent.aggroRange * ent.aggroRange * 2.6 && !inTown(ent.pos.x, ent.pos.z)) faceTo(ent, p.pos.x, p.pos.z, dt, 2.5);
    if (d2p < 70 * 70) {
      const F = fam(ent.family);
      if (F.sfx && rnd() < IDLE_SFX_RATE * dt) sfx(F.sfx, ent.pos, 0.55, F.pitch * (0.92 + rnd() * 0.16));
    }
    if (ai.timer <= 0) {
      if (pickWanderTarget(ent)) { ai.state = 'wander'; ai.timer = 12 + rnd() * 8; }
      else ai.timer = 2 + rnd() * 3;
    }
  }
  function wanderStep(ent, dt, t) {
    const ai = ent.ai;
    ai.scanT -= dt;
    if (ai.scanT <= 0) {
      ai.scanT = AGGRO_SCAN_INTERVAL;
      const tgt = scanForTarget(ent);
      if (tgt) { setTarget(ent, tgt); _want.set(0, 0, 0); return; }
    }
    ai.timer -= dt;
    const spd = ent.speed * WANDER_SPEED * ent.stats.speed;
    const r = moveToward(ent, ai.wanderX, ai.wanderZ, spd, dt, 0.8);
    if (r !== 0 || ai.timer <= 0 || ai.stuck) {
      ai.stuck = false;
      ai.state = 'idle'; ai.timer = 2 + rnd() * 5; ai.hasWander = false;
      // group members rest where they stopped: a leash brings them back here (wander stays bounded by the group radius)
      if (r === 1 && ent.group && !ent.boss && !isWater(ent.pos.x, ent.pos.z)) ent.home.set(ent.pos.x, ent.pos.y, ent.pos.z);
      _want.set(0, 0, 0);
    }
  }
  function chaseStep(ent, dt, t, d2p) {
    const ai = ent.ai;
    const target = ent.target;
    if (!validTarget(ent, target)) { dropTarget(ent); _want.set(0, 0, 0); return; }
    // towns are safe ground
    if (inTown(ent.pos.x, ent.pos.z) || inTown(target.pos.x, target.pos.z)) { startLeash(ent); _want.set(0, 0, 0); return; }
    const dh2 = _dist2sq(ent.pos.x, ent.pos.z, ent.home.x, ent.home.z);
    if (dh2 > ai.leash * ai.leash) { startLeash(ent); _want.set(0, 0, 0); return; }
    // re-evaluate threat every so often (a taunt pins the target for a few seconds)
    ai.scanT -= dt;
    if (ai.scanT <= 0) { ai.scanT = SCAN_INTERVAL; if (!(ai.tauntedUntil > t)) { const top = topThreat(ent); if (top && top !== target) setTarget(ent, top, true); } }
    const dx = target.pos.x - ent.pos.x, dz = target.pos.z - ent.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const reach = ent.radius + (target.radius > 0 ? target.radius : 0.4) + 1.0;
    if (d <= reach) {
      ai.state = 'attack'; ai.strafeT = 0; ai.strafeDir = 0;
      if (ai.nextAttack < t + 0.25) ai.nextAttack = t + 0.25 + rnd() * 0.3;
      _want.set(0, 0, 0);
      faceTo(ent, target.pos.x, target.pos.z, dt, 12);
      return;
    }
    const F = fam(ent.family);
    // casters hold position at range while a ranged ability is ready; opportunists shoot on the run
    if (!isCasting(ent) && !ent.stats.stunned) {
      ai.rangedT -= dt;
      if ((F.caster || F.ranged || ent.boss) && ai.rangedT <= 0 && d > reach + 1.5) {
        ai.rangedT = F.caster ? 0.6 : 1.4;
        if (rnd() < (F.caster ? 0.8 : ABILITY_CHANCE) && hasLOS(ent, target)) {
          const id = pickAbility(ent, t, true, d);
          if (id) { faceTo(ent, target.pos.x, target.pos.z, dt, 14); fireAbility(ent, id, target, t); _want.set(0, 0, 0); ai.progressT = 0; return; }
        }
      }
      if (F.caster && d < 14 && d > reach + 2 && ai.rangedT > 0 && rnd() < 0.5) { _want.set(0, 0, 0); faceTo(ent, target.pos.x, target.pos.z, dt, 10); return; }
    }
    if (isCasting(ent)) { _want.set(0, 0, 0); faceTo(ent, target.pos.x, target.pos.z, dt, 10); return; }
    const spd = ent.speed * ent.stats.speed;
    const r = moveToward(ent, target.pos.x, target.pos.z, spd, dt, reach * 0.9);
    // progress / unreachable tracking
    if (d < ai.bestD - 0.25) { ai.bestD = d; ai.progressT = 0; } else ai.progressT += dt;
    if (r === 2) ai.blockedT += dt; else ai.blockedT = 0;
    if (ai.progressT > UNREACHABLE_TIME || ai.blockedT > 4 || (ai.stuck && ai.progressT > 3)) { ai.stuck = false; dropTarget(ent); _want.set(0, 0, 0); }
  }
  function attackStep(ent, dt, t, d2p) {
    const ai = ent.ai;
    const target = ent.target;
    if (!validTarget(ent, target)) { dropTarget(ent); _want.set(0, 0, 0); return; }
    if (inTown(target.pos.x, target.pos.z)) { startLeash(ent); _want.set(0, 0, 0); return; }
    const dx = target.pos.x - ent.pos.x, dz = target.pos.z - ent.pos.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    const reach = ent.radius + (target.radius > 0 ? target.radius : 0.4) + 1.0;
    faceTo(ent, target.pos.x, target.pos.z, dt, 12);
    // flee check for cowardly families
    const F = fam(ent.family);
    if (F.coward && !ai.fledOnce && ent.morale < ent.stats.maxMorale * FLEE_PCT && !ent.boss && !ent.elite) {
      ai.fledOnce = true; ai.fleeing = true; ai.fleeT = FLEE_TIME; ai.state = 'flee';
      ai.telegraphT = 0; ai.telegraphId = null;
      if (d2p < 80 * 80) sfx(F.sfx || 'hurt', ent.pos, 0.8, (F.pitch || 1) * 1.15);
      return;
    }
    // telegraph in progress?
    if (ai.telegraphId) {
      ai.telegraphT -= dt;
      _want.set(0, 0, 0);
      if (ai.telegraphT <= 0) {
        const id = ai.telegraphId; ai.telegraphId = null;
        fireAbility(ent, id, target, t);
        ai.nextAttack = t + ent.attackInterval * (0.9 + rnd() * 0.2);
      }
      return;
    }
    if (d > reach + 0.6) { ai.state = 'chase'; ai.bestD = Infinity; ai.progressT = 0; _want.set(0, 0, 0); return; }
    if (isCasting(ent) || ent.stats.stunned) { _want.set(0, 0, 0); return; }
    if (t >= ai.nextAttack) {
      let id = null;
      if (ent.abilities.length && (ent.boss || rnd() < ABILITY_CHANCE)) id = pickAbility(ent, t, false, d);
      if (id && (ent.elite || ent.boss) && isBig(id)) {
        // wind-up: everybody can see the big one coming
        ai.telegraphId = id; ai.telegraphT = TELEGRAPH_TIME;
        if (ent.rig && typeof ent.rig.setAnim === 'function') ent.rig.setAnim('attack', true);
        _fxOpts.color = ent.boss ? 0xff3020 : 0xffa030; _fxOpts.scale = clamp(ent.radius * 2.2, 1, 5); _fxOpts.duration = TELEGRAPH_TIME + 0.2;
        fx('ring', ent.pos, _fxOpts);
        if (d2p < 90 * 90) sfx(F.sfx || 'orc_growl', ent.pos, 1, (F.pitch || 1) * 0.85);
        _want.set(0, 0, 0);
        return;
      }
      if (id) fireAbility(ent, id, target, t); else basicAttack(ent, target, t);
      ai.nextAttack = t + ent.attackInterval * (0.9 + rnd() * 0.2);
      ai.strafeT = 0.25; ai.strafeDir = 0;
      _want.set(0, 0, 0);
      return;
    }
    // between swings: circle / shuffle to feel alive, keep inside reach
    ai.strafeT -= dt;
    if (ai.strafeT <= 0) {
      const roll = rnd();
      ai.strafeDir = roll < 0.45 ? 0 : roll < 0.75 ? 1 : -1;
      ai.strafeT = 0.4 + rnd() * 0.8;
    }
    const spd = ent.speed * ent.stats.speed;
    if (ai.strafeDir !== 0 && d > 0.3 && spd > 0) {
      const nx = dx / d, nz = dz / d;
      const px = -nz * ai.strafeDir, pz = nx * ai.strafeDir;
      let radial = 0;
      if (d > reach - 0.2) radial = 0.5; else if (d < reach - 1.0) radial = -0.3;
      const s = spd * 0.32;
      _want.set((px + nx * radial) * s, 0, (pz + nz * radial) * s);
      if (stepBlocked(ent, px, pz)) _want.set(0, 0, 0);
    } else if (d > reach - 0.15 && spd > 0) {
      _want.set(dx / d * spd * 0.5, 0, dz / d * spd * 0.5);
    } else _want.set(0, 0, 0);
  }
  function fleeStep(ent, dt, t) {
    const ai = ent.ai;
    ai.fleeT -= dt;
    const target = ent.target;
    if (ai.fleeT <= 0 || !target) {
      ai.fleeing = false;
      if (validTarget(ent, target)) { ai.state = 'chase'; ai.bestD = Infinity; ai.progressT = 0; }
      else dropTarget(ent);
      _want.set(0, 0, 0);
      return;
    }
    let dx = ent.pos.x - target.pos.x, dz = ent.pos.z - target.pos.z;
    let d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-3) { dx = Math.cos(ent.yaw); dz = Math.sin(ent.yaw); d = 1; }
    dx /= d; dz /= d;
    // wobble so the run looks panicked
    const w = Math.sin(t * 6 + ent._k) * 0.45;
    const rx = dx * Math.cos(w) - dz * Math.sin(w), rz = dx * Math.sin(w) + dz * Math.cos(w);
    const spd = ent.speed * ent.stats.speed;
    if (stepBlocked(ent, rx, rz)) { // turn along the shore
      _want.set(-rz * spd, 0, rx * spd);
    } else _want.set(rx * spd, 0, rz * spd);
    faceTo(ent, ent.pos.x + rx, ent.pos.z + rz, dt, 8);
  }
  function leashStep(ent, dt, t) {
    const ai = ent.ai;
    ent.target = null;
    const max = ent.stats.maxMorale;
    if (ent.morale < max) ent.morale = Math.min(max, ent.morale + max * LEASH_HEAL_PCT * dt);
    const spd = ent.speed * LEASH_SPEED * Math.max(0.35, ent.stats.speed);
    const r = moveToward(ent, ent.home.x, ent.home.z, spd, dt, 1.5);
    if (r === 1 || (ai.stuck && _dist2sq(ent.pos.x, ent.pos.z, ent.home.x, ent.home.z) < 36)) {
      ai.stuck = false;
      ai.state = 'idle'; ai.timer = 2 + rnd() * 3;
      ent.leashing = false; ent.invulnerable = false;
      ai.fledOnce = false;
      _want.set(0, 0, 0);
    } else if (r === 2 || ai.stuck) {
      // cannot walk home (fell in water / wedged): nudge sideways for a moment
      ai.stuck = false;
      const a = ent.yaw + PI * 0.5;
      _want.set(-Math.sin(a) * spd * 0.6, 0, -Math.cos(a) * spd * 0.6);
    }
  }
  function bossStep(ent, dt, t, d2p) {
    const rec = ent.bossRec;
    if (!rec) return;
    const p = player();
    if (!rec.announced && d2p < BOSS_ANNOUNCE_DIST * BOSS_ANNOUNCE_DIST && p) {
      rec.announced = true;
      notify(ent.name + ' has awoken!', 'warning');
      const F = fam(ent.family);
      sfx(F.sfx || 'troll_roar', ent.pos, 1, (F.pitch || 1) * 0.8);
      if (ent.rig && typeof ent.rig.setAnim === 'function') ent.rig.setAnim('attack', true);
      _fxOpts.color = 0xff3020; _fxOpts.scale = clamp(ent.radius * 3, 2, 8); _fxOpts.duration = 1.2;
      fx('ring', ent.pos, _fxOpts);
    }
    const fightingPlayer = p && ent.target === p && (ent.ai.state === 'chase' || ent.ai.state === 'attack');
    if (fightingPlayer) { if (bossMusicRec !== rec) startBossMusic(rec); }
    else if (bossMusicRec === rec && ent.ai.state !== 'chase' && ent.ai.state !== 'attack') restoreMusic();
    // stun immunity: shrug off any stun/root that landed
    const effs = ent.effects;
    if (Array.isArray(effs) && effs.length) {
      for (let i = effs.length - 1; i >= 0; i--) {
        const e = effs[i];
        if (!e || (e.kind !== 'stun' && e.kind !== 'root')) continue;
        const Cb = G.Combat;
        if (Cb && typeof Cb.removeEffect === 'function') { try { Cb.removeEffect(ent, e.id); } catch (err) { effs.splice(i, 1); } }
        else effs.splice(i, 1);
        if (G.Data && G.Data.stats && typeof G.Data.stats.compute === 'function') { try { G.Data.stats.compute(ent); } catch (err) { /* keep going */ } }
      }
    }
  }
  function aiStep(ent, dt, t, d2p) {
    const ai = ent.ai;
    if (!ai || ent.dead) return;
    counters.aiSteps++;
    if (dt > 0.25) dt = 0.25;
    ai.sinceDamage += dt;
    const st = ent.stats;
    if (typeof st.speed !== 'number') st.speed = 1;
    _want.set(0, 0, 0);
    if (st.stunned && ai.state !== 'leash') {
      // stunned: no thinking, just physics settling
      if (ai.telegraphId) { ai.telegraphT = TELEGRAPH_TIME; }
      applyMove(ent, dt);
      ent.anim = 'hit';
      return;
    }
    switch (ai.state) {
      case 'idle': idleStep(ent, dt, t, d2p); break;
      case 'wander': wanderStep(ent, dt, t); break;
      case 'chase': chaseStep(ent, dt, t, d2p); break;
      case 'attack': attackStep(ent, dt, t, d2p); break;
      case 'flee': fleeStep(ent, dt, t); break;
      case 'leash': leashStep(ent, dt, t); break;
      default: ai.state = 'idle'; ai.timer = 1; break;
    }
    if (ent.boss) bossStep(ent, dt, t, d2p);
    // soft separation from packmates (near tier only — it needs a spatial query)
    if (d2p < NEAR_TIER * NEAR_TIER && ((frame + ent._k) & 1) === 0 && !ent.boss) separation(ent);
    applyMove(ent, dt);
    ent.anim = ai.state === 'attack' ? (ai.telegraphId ? 'attack' : 'idle') : ai.moving ? (ai.state === 'wander' ? 'walk' : 'run') : 'idle';
    if (ent.pos.y !== ent.pos.y) { ent.pos.set(ent.home.x, ent.home.y, ent.home.z); ent.vel.set(0, 0, 0); }
  }

  // ------------------------------------------------------------------------------------------------ hooks
  function onDamaged(ent, src) {
    if (!ent || ent.kind !== 'monster' || ent.dead || !ent.ai) return;
    const ai = ent.ai;
    ai.sinceDamage = 0;
    if (ai.state === 'leash') return;                    // untouchable while going home
    if (src && src.kind === 'monster') src = src.owner || src.master || null;
    if (src && isFreeTarget(src) && src !== ent && src.pos) {
      const cur = ent.target;
      if (!cur || !validTarget(ent, cur)) setTarget(ent, src);
      else if (cur !== src && threatOf(ent, src) > threatOf(ent, cur) * 1.1) setTarget(ent, src, true);
      else packCall(ent, cur);
      if (ent.bossRec && src === player()) startBossMusic(ent.bossRec);
    } else if (ai.state === 'idle' || ai.state === 'wander') {
      // hit by something we cannot see: look around
      ai.scanT = 0; ai.timer = 0.5;
    }
    // flinch (Combat plays the hit animation itself when present)
    if (!(G.Combat && typeof G.Combat.damage === 'function') && ent.rig && typeof ent.rig.setAnim === 'function' && !ent.rig.oneShot && ai.state !== 'attack') ent.rig.setAnim('hit');
  }
  function onTaunt(ent, src) {
    if (!ent || ent.kind !== 'monster' || ent.dead || !ent.ai || !src) return;
    if (ent.ai.state === 'leash') return;
    if (!isFreeTarget(src) || !src.pos) return;
    setTarget(ent, src, true);
    ent.ai.tauntedUntil = now() + 4;
    ent.ai.sinceDamage = 0;
  }
  function onEntityKilled(ev) {
    const v = ev && (ev.victim || ev.entity || ev);
    if (!v) return;
    if (v.kind === 'monster') { onKilled(v); return; }
    // a free person died: everyone hunting them gives up
    for (let i = 0; i < live.length; i++) { const m = live[i]; if (m.target === v && !m.dead) dropTarget(m); }
    if (v === player()) restoreMusic();
  }
  function onPlayerDeath() {
    const p = player();
    for (let i = 0; i < live.length; i++) { const m = live[i]; if (!m.dead && m.target && (m.target === p || m.target.kind === 'player')) dropTarget(m); }
    restoreMusic();
  }
  function onCombatEnd() {
    if (!bossMusicRec) return;
    const e = bossMusicRec.ent;
    if (!e || e.dead || !(e.target && validTarget(e, e.target))) restoreMusic();
  }
  function onPlayerLevelUp() { /* nameplates recolour lazily (plateLevel check in the rig loop) */ }

  // ------------------------------------------------------------------------------------------------ queries
  const _liveFilter = function (e) { return e.kind === 'monster' && !e.dead && e.alive !== false && !e.despawned; };
  const _liveUserFilter = function (e) { return _liveFilter(e) && (!_userFilter || _userFilter(e)); };
  function hostilesNear(pos, r) {
    _hostBuf.length = 0;
    if (!pos || !G.Spatial || typeof G.Spatial.query !== 'function') return _hostBuf;
    return G.Spatial.query(num(pos.x, 0), num(pos.z, 0), num(r, 30), _liveFilter, _hostBuf);
  }
  function nearestHostile(pos, r, filterFn) {
    if (!pos || !G.Spatial || typeof G.Spatial.nearest !== 'function') return null;
    _userFilter = typeof filterFn === 'function' ? filterFn : null;
    const e = G.Spatial.nearest(num(pos.x, 0), num(pos.z, 0), num(r, 30), _liveUserFilter);
    _userFilter = null;
    return e;
  }
  function countAlive() { let n = 0; for (let i = 0; i < live.length; i++) if (!live[i].dead) n++; return n; }
  function killAllNear(pos, r) {
    if (!pos) return 0;
    const list = hostilesNear(pos, r);
    _tmpList.length = 0;
    for (let i = 0; i < list.length; i++) _tmpList.push(list[i]);
    const killer = player();
    let n = 0;
    for (let i = 0; i < _tmpList.length; i++) {
      const e = _tmpList[i];
      if (e.dead) continue;
      const Cb = G.Combat;
      let done = false;
      if (Cb && typeof Cb.kill === 'function') { try { Cb.kill(e, killer); done = true; } catch (err) { if (G.reportError) G.reportError(err, 'Monsters killAllNear'); } }
      if (!done || !e.dead) killInternal(e, killer);
      n++;
    }
    _tmpList.length = 0;
    return n;
  }
  function respawnAll() {
    for (let i = 0; i < groups.length; i++) { const g = groups[i]; deactivateGroup(g); g.nextRespawn.length = 0; g.alive = 0; g.extras = 0; }
    for (let i = 0; i < bosses.length; i++) { const b = bosses[i]; deactivateBoss(b); b.respawnAt = 0; b.deadAt = -1; b.announced = false; }
    // anything not owned by a group (quest / admin spawns)
    _tmpList.length = 0;
    for (let i = 0; i < live.length; i++) _tmpList.push(live[i]);
    for (let i = 0; i < _tmpList.length; i++) despawn(_tmpList[i]);
    _tmpList.length = 0;
    const p = player();
    if (p && p.pos) groupScan(p.pos.x, p.pos.z, now());
    scanT = SCAN_INTERVAL; budgetT = 0;
  }
  function spawnForQuest(typeId, nearPos, count) {
    const out = [];
    const type = findType(typeId);
    if (!type) return out;
    count = Math.max(1, Math.round(num(count, 1)));
    const px = nearPos ? num(nearPos.x, 0) : 0, pz = nearPos ? num(nearPos.z, 0) : 0;
    const aquatic = !!fam(type.family).aquatic;
    // the type's nearest group, if it is close enough to be the natural place
    let g = null, gd = Infinity;
    const gl = groupsByType[type.id];
    if (gl) for (let i = 0; i < gl.length; i++) { const d = _dist2sq(px, pz, gl[i].center.x, gl[i].center.z); if (d < gd) { gd = d; g = gl[i]; } }
    if (g && gd > 150 * 150) g = null;
    for (let i = 0; i < count; i++) {
      let x, z;
      if (g) { groupPoint(g, aquatic, _pt); x = _pt.x; z = _pt.z; }
      else {
        let ok = false;
        for (let tries = 0; tries < 12 && !ok; tries++) {
          const a = rnd() * TAU, r = 8 + rnd() * 12;
          x = px + Math.cos(a) * r; z = pz + Math.sin(a) * r;
          ok = landOk(x, z, aquatic);
        }
        if (!ok) { x = px + (rnd() - 0.5) * 6; z = pz + (rnd() - 0.5) * 6; }
      }
      const e = spawnAt(type.id, x, z, { group: g, extra: true });
      if (e) out.push(e);
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ main update
  function update(dt) {
    if (!inited) return;
    dt = num(dt, 0);
    if (dt <= 0) return;
    if (dt > 0.1) dt = 0.1;
    const p = player();
    if (!p || !p.pos) return;
    frame++;
    const t = now();
    const px = p.pos.x, pz = p.pos.z;
    const playerLevel = num(p.level, 1);
    scanT -= dt;
    if (scanT <= 0) { scanT = SCAN_INTERVAL; groupScan(px, pz, t); }
    budgetT -= dt;
    if (budgetT <= 0) { budgetT = BUDGET_INTERVAL; rigBudget(px, pz); }
    const cam = getCamera(), lodMul = _lodQuality();
    const near2 = NEAR_TIER * NEAR_TIER, mid2 = SPAWN_DIST * SPAWN_DIST, plate2 = NAMEPLATE_DIST * NAMEPLATE_DIST;
    counters.tier0 = 0; counters.tier1 = 0; counters.tier2 = 0;
    for (let i = live.length - 1; i >= 0; i--) {
      const e = live[i];
      if (!e || e.despawned) { if (e) live.splice(i, 1); continue; }
      if (e.dead) { corpseStep(e, dt, t); continue; }
      const d2 = _dist2sq(px, pz, e.pos.x, e.pos.z);
      e._d2 = d2;
      let tier;
      if (d2 < near2) tier = 0;
      else if (d2 < mid2 || e.target || e.engagedBy) tier = 1;
      else tier = 2;
      if (e.engagedBy && d2 > ENGAGED_KEEP_DIST * ENGAGED_KEEP_DIST) e.engagedBy = null;
      if (tier === 0) { counters.tier0++; aiStep(e, dt, t, d2); e.ai.acc = 0; }
      else if (tier === 1) {
        counters.tier1++;
        e.ai.acc += dt;
        if (((frame + e._k) & 3) === 0) { aiStep(e, e.ai.acc, t, d2); e.ai.acc = 0; }
      } else { counters.tier2++; e.ai.acc = 0; if (e.ai.state !== 'idle' && e.ai.state !== 'wander') { e.target = null; e.ai.state = 'idle'; e.ai.timer = 1; } }
      // visuals
      const rig = e.rig;
      if (rig) {
        rig.group.position.copy(e.pos);
        rig.group.rotation.y = e.yaw;
        const level = _applyRigLod(e, rig, _camDist(cam, e), e._rank, lodMul);
        if (level === 2) { /* static far mesh: no pose update */ }
        else if (tier === 0) { if (typeof rig.play === 'function') rig.play(dt, e); }
        else if (((frame + e._k) & 1) === 0 && typeof rig.play === 'function') rig.play(dt * 2, e);
        const plate = e.plate;
        if (plate) {
          if (d2 < plate2) {
            if (e.plateLevel !== playerLevel) makeNameplate(e);
            const pl = e.plate;
            if (pl) { pl.visible = true; if (cam && G.Chars && typeof G.Chars.updateNameplate === 'function') G.Chars.updateNameplate(pl, cam); }
          } else plate.visible = false;
        }
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ init
  let hooked = false;
  function init(sc) {
    if (sc && sc.isScene) scene = sc;
    if (inited) {
      // re-init (new game / registry reload): clear everything and rebuild the records
      _tmpList.length = 0;
      for (let i = 0; i < live.length; i++) _tmpList.push(live[i]);
      for (let i = 0; i < _tmpList.length; i++) despawn(_tmpList[i]);
      _tmpList.length = 0;
      restoreMusic();
    }
    loadRegistry();
    inited = true;
    scanT = 0; budgetT = 0; frame = 0;
    if (!hooked && typeof G.on === 'function') {
      hooked = true;
      G.on('entityKilled', onEntityKilled);
      G.on('playerDeath', onPlayerDeath);
      G.on('combatEnd', onCombatEnd);
      G.on('playerLevelUp', onPlayerLevelUp);
    }
    return M;
  }
  function stats() {
    let alive = 0, rigs = 0, inCombat = 0, corpses = 0, activeGroups = 0, activeBosses = 0, liveBosses = 0, statics = 0;
    for (let i = 0; i < live.length; i++) { const e = live[i]; if (e.dead) corpses++; else alive++; if (e.rig) { rigs++; if (e.rig.lodLevel === 2) statics++; } if (e.target && !e.dead) inCombat++; if (e.boss && !e.dead) liveBosses++; }
    for (let i = 0; i < groups.length; i++) if (groups[i].active) activeGroups++;
    for (let i = 0; i < bosses.length; i++) if (bosses[i].active) activeBosses++;
    return {
      types: typeList.length, groups: groups.length, activeGroups: activeGroups, bosses: bosses.length, activeBosses: activeBosses, liveBosses: liveBosses,
      live: live.length, alive: alive, corpses: corpses, rigs: rigs, rigCount: rigCount, inCombat: inCombat, bossMusic: !!bossMusicRec,
      spawned: counters.spawned, despawned: counters.despawned, killed: counters.killed, respawned: counters.respawned,
      attacks: counters.attacks, abilities: counters.abilities, tier0: counters.tier0, tier1: counters.tier1, tier2: counters.tier2, aiSteps: counters.aiSteps,
    };
  }

  // ------------------------------------------------------------------------------------------------ export
  M.init = init;
  M.update = update;
  M.spawnAt = spawnAt;
  M.despawn = despawn;
  M.killAllNear = killAllNear;
  M.respawnAll = respawnAll;
  M.typesInZone = typesInZone;
  M.nearestHostile = nearestHostile;
  M.hostilesNear = hostilesNear;
  M.onDamaged = onDamaged;
  M.onTaunt = onTaunt;
  M.onKilled = onKilled;
  M.countAlive = countAlive;
  M.findType = findType;
  M.spawnForQuest = spawnForQuest;
  M.nearestSpawnOf = nearestSpawnOf;
  M.groupsForType = groupsForType;
  M.stats = stats;
  M.all = function () { return live; };
  M.get = function (id) { return byId[id] || null; };
  M.groups = groups;
  M.bosses = bosses;
  M.types = types;
  M.typeList = typeList;
  M.setScene = function (sc) { scene = sc || null; };
  M.setTarget = setTarget;
  M.dropTarget = dropTarget;
  M.inTown = inTown;
  M.FAMILY = FAMILY;
  M.CONST = { SPAWN_DIST, DESPAWN_DIST, ENGAGED_KEEP_DIST, RENDER_DIST, RIG_CAP, NEAR_TIER, NAMEPLATE_DIST, CORPSE_TIME, LEASH_DIST, AGGRO_DROP_DIST, ATTACK_INTERVAL, ABILITY_CHANCE, TELEGRAPH_TIME, FLEE_TIME, PACK_RADIUS, SEPARATION, BOSS_ANNOUNCE_DIST };
  Object.defineProperty(M, 'inited', { get: function () { return inited; } });
})();
