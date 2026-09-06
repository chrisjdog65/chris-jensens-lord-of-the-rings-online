/* ==== 21_combat.js — G.Combat + G.Progress: the heart of gameplay. Ability execution (target resolution, range /
   line-of-sight / facing checks, power, cooldowns, the 1 s global cooldown, cast bars interrupted by movement or
   stuns, projectiles for bolt/arrow abilities), the damage pipeline (mult × mastery/4 + weapon average, ±15 %
   variance, ×1.6 crits, block/parry/evade rolls reduced by finesse, armour mitigation for physical damage and
   resistance for tactical damage, admin god mode / damage multiplier), heals, buffs/debuffs/stances, dots/hots,
   stuns/roots/slows, knockbacks, taunts and threat tables, auto-attack, in/out-of-combat state with music,
   regeneration, death (loot bags with auto-loot, XP, quest hook, death screen) and progression (XP & levels to the
   cap, gold, ability training, hotbar, titles).

   Public API — SPEC §6.2 exactly, plus the documented extras below.
   G.Combat:
     useAbility(ent, abilityId|ability, target?, opts?) → bool         basicAttack(ent, target, opts?) → bool
     damage(src, dst, amount, dtype, opts?) → number actually dealt    heal(src, dst, amount, opts?) → number healed
        damage opts: { crit, ability, raw (skip avoidance+mitigation), kind:'melee'|'ranged'|'tactical'|'dot'|'fall', threat (mult),
                       sfx (name|null), noFx, noAnim, small (small float text), silent (no float text), dot }
     addEffect(dst, effect, srcEnt?) → effect|null   removeEffect(dst, id) → bool   clearEffects(dst, keepFn?)   hasEffect(dst, id)   getEffect(dst, id)
     kill(ent, killer?) → bool   update(dt)   isHostile(a, b)   isFriendly(a, b)   canSee(a, b)   distance(a, b)   distanceXZ(a, b)
     inRange(a, b, r) (edge-to-edge, uses radii)   facing(a, b) → dot   faceTarget(ent, target)   headPos/chestPos/handPos(ent, out?)
     canUse(ent, abilityId, target?) → {ok, reason, code, target} (REUSED object — read immediately)   abilityReady(ent, id)
     cooldownLeft(ent, id) → s   cooldownFrac(ent, id) → 0..1 remaining (includes the GCD)   cancelCast(ent, reason?)   interrupt(ent)
     isCasting(ent)   castProgress(ent) → 0..1   hostilesNear(centre, radius, out?, src?, coneDeg?, max?)   friendliesNear(...)
     nearestHostile(ent, radius)   addThreat(dst, src, n)   threatOf(dst, src)   topThreat(dst) → entity|null   clearThreat(dst)   taunt(dst, src)
     tryAutoLoot() → bool   lootBag(bag, ent?) → bool   dropLoot(victim, forPlayer) → bag|null   lootBags (live array)   autoLootEnabled()
     revive(ent, moraleFrac?)   fallDamage(ent, fallSpeed) → dealt   markCombat(ent)   inCombatFor(ent) → bool
     basicAttackDamage(ent) → {min, max, avg, dtype, speed}   weaponSpeed(ent)   dtypeColor(dtype)   isPhysical(dtype)   resolveAbility(idOrObj)
     lastAbility {ent, id, target, time}   lastHit {src, dst, amount, crit, avoided, dtype}   lastError (string)   stats() (counters)
   G.Progress:
     addXP(n, opts?) → gained   levelUp() → bool   setLevel(L)   addGold(copper, opts?) → gold   spendGold(copper) → bool
     trainAbility(id) → {ok, reason}   canTrain(id) → {ok, reason, cost}   untrainedAvailable() → [ability]   setHotbar(slot, id|null) → bool
     hotbarSlotOf(id) → index|-1   firstFreeHotbar() → index|-1   xpToNext()   xpProgress() → 0..1   grantStarterAbilities(player)
     ensurePlayerShape(player)   awardTitle(id) → bool   checkTitles() → number awarded   hasAbility(player, id)
   Events emitted beyond SPEC: abilityUsed {ent, ability, target}, entityDamaged {src, dst, amount, crit, dtype, avoided},
     entityHealed {src, dst, amount}, effectsChanged (ent), castStart (ent), castEnd (ent), lootDropped (bag), lootTaken {items, gold, bag},
     xpGained (n), hotbarChanged (slot), titleEarned (id), combatMusic (theme).
   Fields written on entities: cooldowns{}, gcdReady, casting {id, name, icon, start, end, castTime, ability*, target*, fx*} (* = hidden),
     nextSwing, lastCombat, lastAbility, autoAttack, threat {id → number}, knockback (Vector3), effects[], _cbAcc (far-tick accumulator).
   Loot bag entity: { kind:'chest', subkind:'lootbag', loot:[instances], gold, owner, expires, interact:{label:'Loot', range:2.5, fn} }.
   Assumptions: G.Data.stats.compute reads effect kinds stun/root/slow (02); G.Physics.lineOfSight/moveEntity applies ent.knockback (15);
     G.FX.spawn/projectile (16); G.Audio.sfx/music (01); G.UI.floatText/notify/notifyBig/chat/showLoot/deathScreen (30);
     G.Monsters.onDamaged/onTaunt, G.AIPlayers.onDamaged (optional); G.Quests.onKill; G.Player.dismount; G.Game.zoneMusic/scene (optional);
     G.Items.lootFor/addToInventory/get/rarityOf; G.Chars.buildProp('bundle') for the loot-bag mesh (optional).
   Private helpers are file-local (no shared globals). ==== */
(function () {
  'use strict';
  const G = window.G;
  const THREE = window.THREE;
  const C = G.C || {};
  const EMPTY = Object.freeze({});

  // ------------------------------------------------------------------------------------------------ tunables
  const GCD = 1.0;                       // global cooldown (s)
  const COMBAT_TIMEOUT = 6;              // seconds after the last exchange before leaving combat
  const LOOT_LIFE = 60;                  // loot bag lifetime (s)
  const AUTO_LOOT_RANGE = 1.5;
  const MAX_AOE = 8;
  const CRIT_MULT = 1.6;
  const VARIANCE = 0.15;
  const FACING_DOT = -0.2;               // ranged/tactical abilities need the target at least this much "in front"
  const RANGE_SLACK = 0.5;
  const MELEE = (typeof C.MELEE_RANGE === 'number') ? C.MELEE_RANGE : 3.2;
  const REGEN_RADIUS = 300;
  const FAR_DIST = 120, FAR_TICK = 0.5;  // entities beyond FAR_DIST from the player tick every FAR_TICK seconds
  const THREAT_DECAY = 0.96;             // per second, for hostiles that are not being fought
  const LEVEL_CAP = (typeof C.LEVEL_CAP === 'number') ? C.LEVEL_CAP : 80;
  const HOTBAR_SIZE = (C.HOTBAR_KEYS && C.HOTBAR_KEYS.length) || 20;
  const MAX_EFFECTS = 24;
  const HIT_ANIM_GAP = 0.45;
  const CAST_MOVE_TOLERANCE = 0.5;       // metres of movement that interrupt a cast (players)
  const CAST_MOVE_TOLERANCE_AI = 1.5;    // non-players get more slack (steering jitter)

  const PHYSICAL = { common: 1, beleriand: 1, westernesse: 1, ancientDwarf: 1 };
  const DTYPE_NAME = { common: 'Common', beleriand: 'Beleriand', westernesse: 'Westernesse', ancientDwarf: 'Ancient Dwarf-make', fire: 'Fire', frost: 'Frost', light: 'Light', lightning: 'Lightning', fall: 'fall', shadow: 'Shadow' };
  const DTYPE_COLOR = { common: '#ffffff', beleriand: '#bfe3ff', westernesse: '#e6d6ff', ancientDwarf: '#ffd9a8', fire: '#ff8a3a', frost: '#8fd8ff', light: '#fff2a8', lightning: '#c9a8ff', fall: '#ff7a6a', shadow: '#b48cff' };
  const DTYPE_HEX = { common: 0xffffff, beleriand: 0xbfe3ff, westernesse: 0xe6d6ff, ancientDwarf: 0xffd9a8, fire: 0xff8a3a, frost: 0x8fd8ff, light: 0xfff2a8, lightning: 0xc9a8ff, shadow: 0xb48cff };
  const HIT_SFX = { fire: 'fire_hit', frost: 'frost_hit', light: 'light_hit', lightning: 'spell_hit', shadow: 'spell_hit' };
  const WEAPON_HIT_SFX = { axe: 'axe_hit', mace: 'blunt_hit', gauntlets: 'blunt_hit', staff: 'blunt_hit', halberd: 'axe_hit', runestone: 'spell_hit', instrument: 'blunt_hit', bow: 'arrow_hit', crossbow: 'arrow_hit', javelin: 'arrow_hit', throwing: 'arrow_hit' };
  const ANIM_MAP = { slash: 'attack_slash', thrust: 'attack_thrust', spin: 'attack_spin', shoot: 'attack_shoot', cast: 'cast', shout: 'cast', block: 'idle' };
  const CASTER_VFX = { slash: 1, thrust: 1, spin: 1, buff: 1, heal: 1, lightning: 1, levelup: 1, sparkle: 1 };
  const PROJ_KIND = { arrow: 'arrow', bolt: 'bolt', fire: 'fire', frost: 'bolt' };
  const PROJ_SPEED = { arrow: 42, bolt: 30, fire: 22 };
  const DEATH_SFX = { wolf: 'wolf_howl', warg: 'wolf_howl', boar: 'boar_grunt', bear: 'bear_roar', 'lossoth-bear': 'bear_roar', spider: 'spider_hiss',
    crawler: 'spider_hiss', goblin: 'orc_growl', orc: 'orc_growl', uruk: 'orc_growl', troll: 'troll_roar', giant: 'troll_roar', drake: 'troll_roar',
    wight: 'wight_moan', sorcerer: 'wight_moan', 'sea-serpent': 'splash', slug: 'splash' };
  const COLOR_DEALT = '#ffffff', COLOR_CRIT = '#ffd84a', COLOR_TAKEN = '#ff5a4a', COLOR_TAKEN_CRIT = '#ff2f2f', COLOR_HEAL = '#7fd47a',
    COLOR_HEAL_CRIT = '#b8ff8a', COLOR_AVOID = '#c8c8c8', COLOR_AVOID_MINE = '#9ec5ff', COLOR_OTHER = '#bdbdbd';

  // ------------------------------------------------------------------------------------------------ vectors
  const V3 = (THREE && THREE.Vector3) ? THREE.Vector3 : function (x, y, z) {
    this.x = x || 0; this.y = y || 0; this.z = z || 0;
    this.set = function (a, b, c) { this.x = a; this.y = b; this.z = c; return this; };
    this.copy = function (v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; };
  };
  const _v1 = new V3(), _v2 = new V3(), _v3 = new V3(), _v4 = new V3(), _v5 = new V3();

  // ------------------------------------------------------------------------------------------------ small helpers
  function now() { return (G.time && typeof G.time.now === 'number') ? G.time.now : 0; }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function player() { return G.state ? G.state.player : null; }
  function isPlayer(e) { return !!e && (e.kind === 'player' || (G.state && e === G.state.player)); }
  function isAlive(e) { return !!e && e.alive !== false && e.dead !== true; }
  function posOf(e) { if (!e) return null; if (e.pos && typeof e.pos.x === 'number') return e.pos; if (typeof e.x === 'number' && typeof e.z === 'number') return e; return null; }
  function radiusOf(e) { return (e && typeof e.radius === 'number' && e.radius > 0) ? e.radius : 0.4; }
  function heightOf(e) { return (e && typeof e.height === 'number' && e.height > 0) ? e.height : 1.8; }
  function levelOf(e) { return (e && typeof e.level === 'number' && isFinite(e.level)) ? Math.max(1, Math.floor(e.level)) : 1; }
  function nameOf(e) { return (e && e.name) ? String(e.name) : (e && e.kind === 'player' ? 'You' : 'Something'); }
  function report(err, where) { if (typeof G.reportError === 'function') G.reportError(err, where); else G.log('[combat]', where, err); }
  function fmtMoney(c) { return typeof G.fmtMoney === 'function' ? G.fmtMoney(c) : String(c) + 'c'; }
  function fmtNum(n) { return typeof G.fmtNum === 'function' ? G.fmtNum(n) : String(n); }
  function hide(obj, key, val) { Object.defineProperty(obj, key, { value: val, writable: true, enumerable: false, configurable: true }); }
  function rand() { return typeof G.rand === 'function' ? G.rand() : Math.random(); }
  function variance() { return 1 - VARIANCE + rand() * 2 * VARIANCE; }
  function statsObj() {
    const st = G.state.stats || (G.state.stats = {});
    if (typeof st.kills !== 'number') st.kills = 0;
    if (typeof st.deaths !== 'number') st.deaths = 0;
    if (typeof st.damageDealt !== 'number') st.damageDealt = 0;
    if (typeof st.damageTaken !== 'number') st.damageTaken = 0;
    if (typeof st.healingDone !== 'number') st.healingDone = 0;
    if (typeof st.biggestHit !== 'number') st.biggestHit = 0;
    if (!st.killsByFamily || typeof st.killsByFamily !== 'object') st.killsByFamily = {};
    return st;
  }

  function rootOwner(e) {
    let cur = e, guard = 0;
    while (cur && cur.owner && guard++ < 4) {
      const o = typeof cur.owner === 'string' ? (G.getEntity ? G.getEntity(cur.owner) : null) : cur.owner;
      if (!o || o === cur) break;
      cur = o;
    }
    return cur;
  }
  function creditFor(e) { if (!e) return null; const o = rootOwner(e); return isPlayer(o) ? o : null; }
  function factionOf(e) {
    if (!e) return 'neutral';
    if (e.owner) { const o = rootOwner(e); if (o && o !== e) return factionOf(o); }
    if (e.faction) return e.faction;
    switch (e.kind) {
      case 'player': case 'aiplayer': case 'npc': case 'mount': return 'free';
      case 'monster': return e.hostile === false ? 'neutral' : 'enemy';
      default: return e.hostile === true ? 'enemy' : 'neutral';
    }
  }
  function isHostile(a, b) {
    if (!a || !b || a === b) return false;
    const fa = factionOf(a), fb = factionOf(b);
    if (fa === 'neutral' || fb === 'neutral') return false;
    return fa !== fb;
  }
  function isFriendly(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const fa = factionOf(a), fb = factionOf(b);
    return fa === fb && fa !== 'neutral';
  }

  // ------------------------------------------------------------------------------------------------ geometry
  function distanceXZ(a, b) {
    const pa = posOf(a), pb = posOf(b); if (!pa || !pb) return Infinity;
    const dx = pa.x - pb.x, dz = pa.z - pb.z; return Math.sqrt(dx * dx + dz * dz);
  }
  function distance(a, b) {
    const pa = posOf(a), pb = posOf(b); if (!pa || !pb) return Infinity;
    const dx = pa.x - pb.x, dy = num(pa.y) - num(pb.y), dz = pa.z - pb.z; return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  function inRange(a, b, r) {
    const pa = posOf(a), pb = posOf(b); if (!pa || !pb) return false;
    const dx = pa.x - pb.x, dz = pa.z - pb.z, dy = num(pa.y) - num(pb.y);
    const reach = num(r, MELEE) + radiusOf(a) + radiusOf(b);
    if (dx * dx + dz * dz > reach * reach) return false;
    return Math.abs(dy) <= Math.max(3.5, reach * 0.6);
  }
  function facing(a, b) {
    const pa = posOf(a), pb = posOf(b); if (!pa || !pb) return 1;
    let dx = pb.x - pa.x, dz = pb.z - pa.z; const l = Math.sqrt(dx * dx + dz * dz);
    if (l < 1e-4) return 1;
    dx /= l; dz /= l; const yaw = num(a.yaw, 0);
    return -Math.sin(yaw) * dx - Math.cos(yaw) * dz;
  }
  function faceTarget(ent, t) {
    const pa = posOf(ent), pb = posOf(t); if (!pa || !pb || !ent) return;
    const dx = pb.x - pa.x, dz = pb.z - pa.z; if (dx * dx + dz * dz < 1e-6) return;
    ent.yaw = Math.atan2(-dx, -dz);
    if (typeof ent.targetYaw === 'number') ent.targetYaw = ent.yaw;
  }
  function headPos(e, out) { out = out || _v4; const p = posOf(e); if (!p) return out.set(0, 0, 0); return out.set(p.x, num(p.y) + heightOf(e) * 0.95, p.z); }
  function chestPos(e, out) { out = out || _v4; const p = posOf(e); if (!p) return out.set(0, 0, 0); return out.set(p.x, num(p.y) + heightOf(e) * 0.55, p.z); }
  function handPos(e, out) {
    out = out || _v4; const p = posOf(e); if (!p) return out.set(0, 0, 0);
    const yaw = num(e.yaw, 0);
    return out.set(p.x - Math.sin(yaw) * 0.5, num(p.y) + heightOf(e) * 0.65, p.z - Math.cos(yaw) * 0.5);
  }
  function groundYAt(x, z, fallback) {
    const P = G.Physics;
    if (P && typeof P.groundY === 'function') { const y = P.groundY(x, z); if (typeof y === 'number' && y === y) return y; }
    const T = G.Terrain;
    if (T && typeof T.height === 'function') { const y = T.height(x, z); if (typeof y === 'number' && y === y) return y; }
    return num(fallback, 0);
  }
  function canSee(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const P = G.Physics; if (!P || typeof P.lineOfSight !== 'function') return true;
    const pa = posOf(a), pb = posOf(b); if (!pa || !pb) return false;
    _v1.set(pa.x, num(pa.y) + heightOf(a) * 0.8, pa.z); _v2.set(pb.x, num(pb.y) + heightOf(b) * 0.6, pb.z);
    let ok = false;
    try {
      ok = !!P.lineOfSight(_v1, _v2);
      if (!ok) { _v2.y = num(pb.y) + heightOf(b) * 0.95; ok = !!P.lineOfSight(_v1, _v2); }
    } catch (e) { report(e, 'lineOfSight'); ok = true; }
    return ok;
  }

  // ------------------------------------------------------------------------------------------------ feedback plumbing
  function ui() { return G.UI || null; }
  function nearPlayer(e, r) { const p = player(); if (!p || !p.pos || !e) return true; return distanceXZ(p, e) <= r; }
  function floatText(e, text, color, opts) {
    const U = ui(); if (!U || typeof U.floatText !== 'function' || !e) return;
    if (!nearPlayer(e, 90)) return;
    const p = posOf(e); if (!p) return;
    try { U.floatText(new V3(p.x, num(p.y) + heightOf(e) * 1.0, p.z), text, color, opts || null); } catch (err) { report(err, 'UI.floatText'); }
  }
  function notify(text, kind) { const U = ui(); if (U && typeof U.notify === 'function') { try { U.notify(text, kind || 'info'); } catch (e) { report(e, 'UI.notify'); } } }
  function notifyBig(title, sub) {
    const U = ui(); if (!U) return;
    try {
      if (typeof U.notifyBig === 'function') U.notifyBig(title, sub || '');
      else if (typeof U.notify === 'function') U.notify(title + (sub ? ' — ' + sub : ''), 'level');
    } catch (e) { report(e, 'UI.notifyBig'); }
  }
  function chat(text, channel) { const U = ui(); if (U && typeof U.chat === 'function') { try { U.chat(text, channel || 'combat'); } catch (e) { report(e, 'UI.chat'); } } }
  const _sfxOpts = { pos: null, vol: 1, pitch: 1 };
  function sfx(name, e, vol, pitch) {
    const A = G.Audio; if (!A || typeof A.sfx !== 'function' || !name) return;
    if (e && !nearPlayer(e, 120)) return;
    _sfxOpts.pos = e ? posOf(e) : null; _sfxOpts.vol = vol == null ? 1 : vol; _sfxOpts.pitch = pitch || 1;
    try { A.sfx(name, _sfxOpts); } catch (err) { report(err, 'Audio.sfx ' + name); }
  }
  const _fxOpts = { dir: null, yaw: undefined, color: undefined, scale: 1, target: null, yOff: undefined, duration: undefined, from: null };
  function fxReset() { _fxOpts.dir = null; _fxOpts.yaw = undefined; _fxOpts.color = undefined; _fxOpts.scale = 1; _fxOpts.target = null; _fxOpts.yOff = undefined; _fxOpts.duration = undefined; _fxOpts.from = null; return _fxOpts; }
  function fx(kind, pos, opts) {
    const F = G.FX; if (!F || typeof F.spawn !== 'function' || !pos || !kind) return null;
    try { return F.spawn(kind, pos, opts || EMPTY); } catch (e) { report(e, 'FX.spawn ' + kind); return null; }
  }
  function stopFx(h) { if (h && h.alive && typeof h.stop === 'function') { try { h.stop(); } catch (e) { /* ignore */ } } }
  function playAnim(ent, name, force) {
    const r = ent && ent.rig; if (!r || typeof r.setAnim !== 'function' || !name) return;
    try { r.setAnim(name, !!force); } catch (e) { report(e, 'rig.setAnim'); }
  }
  function recompute(e) {
    const S = G.Data && G.Data.stats;
    if (e && S && typeof S.compute === 'function') { try { S.compute(e); } catch (err) { report(err, 'stats.compute'); } }
    return e ? e.stats : null;
  }
  function itemView(inst) {
    if (!inst) return null;
    const I = G.Items;
    if (I && typeof I.get === 'function') { try { return I.get(inst) || null; } catch (e) { /* fall through */ } }
    return (G.Data && G.Data.items && inst.tid) ? G.Data.items[inst.tid] || null : null;
  }

  // ------------------------------------------------------------------------------------------------ monster type data
  let _typeMap = null, _typeMapSrc = null;
  function typeDataOf(e) {
    if (!e) return null;
    if (e.typeData && typeof e.typeData === 'object') return e.typeData;
    if (e.type && typeof e.type === 'object') return e.type;
    const id = e.typeId || (typeof e.type === 'string' ? e.type : null);
    if (!id) return null;
    const W = G.Data && G.Data.world; if (!W) return null;
    if (W.monsterTypeById && W.monsterTypeById[id]) return W.monsterTypeById[id];
    const arr = Array.isArray(W.monsterTypes) ? W.monsterTypes : null;
    if (!arr) return null;
    if (!_typeMap || _typeMapSrc !== arr) { _typeMap = {}; _typeMapSrc = arr; for (let i = 0; i < arr.length; i++) if (arr[i] && arr[i].id) _typeMap[arr[i].id] = arr[i]; }
    return _typeMap[id] || null;
  }
  function familyOf(e) { if (!e) return null; if (e.family) return e.family; const td = typeDataOf(e); return (td && td.family) || null; }
  function isBoss(e) { if (!e) return false; if (e.boss) return true; const td = typeDataOf(e); return !!(td && td.boss); }
  function isElite(e) { if (!e) return false; if (e.elite) return true; const td = typeDataOf(e); return !!(td && td.elite); }
  function monsterDmg(e) {
    if (!e) return 1;
    if (typeof e.dmg === 'number' && e.dmg > 0) return e.dmg;
    const td = typeDataOf(e);
    if (td && typeof td.dmg === 'number' && td.dmg > 0) return td.dmg;
    return 4 + 2.2 * levelOf(e);
  }

  // ------------------------------------------------------------------------------------------------ abilities lookup
  function resolveAbility(x) {
    if (!x) return null;
    if (typeof x === 'string') {
      const D = G.Data; if (!D) return null;
      if (typeof D.abilityById === 'function') return D.abilityById(x) || null;
      return (D.abilities && D.abilities[x]) || null;
    }
    if (typeof x === 'object' && x.id && Array.isArray(x.effects)) return x;
    return null;
  }
  function masteryKey(a) {
    const D = G.Data;
    if (D && typeof D.abilityMastery === 'function') return D.abilityMastery(a);
    if (a && a.mastery === 'phys') return 'physMastery';
    if (a && a.mastery === 'tact') return 'tactMastery';
    return (a && (a.kind === 'melee' || a.kind === 'ranged')) ? 'physMastery' : 'tactMastery';
  }
  function abilitiesHas(abil, id) {
    if (!abil || !id) return false;
    if (abil instanceof Set) return abil.has(id);
    if (Array.isArray(abil)) return abil.indexOf(id) >= 0;
    return !!abil[id];
  }
  function abilitiesFor(cls) { const D = G.Data; if (!D || typeof D.abilitiesFor !== 'function' || !cls) return []; try { return D.abilitiesFor(cls) || []; } catch (e) { return []; } }
