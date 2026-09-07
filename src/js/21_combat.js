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
     suggestMonsterStats(level, {elite, boss, mult}) → {morale, dmg, armour, power, attackSpeed}  (tuned so a same-level 1v1 lasts ≈ 6 s
       against a hero in uncommon gear and costs it ≈ 35 % morale; ×2.5/×8 morale for elite/boss)   heroDPSEstimate(level)
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

  // ------------------------------------------------------------------------------------------------ threat tables
  function threatOf(dst, src) {
    if (!dst || !src) return 0;
    const id = typeof src === 'string' ? src : src.id;
    const t = dst.threat; if (!t || !id) return 0;
    if (t instanceof Map) return num(t.get(id), 0);
    return num(t[id], 0);
  }
  function setThreat(dst, id, v) {
    if (!dst || !id) return;
    if (!dst.threat || typeof dst.threat !== 'object') dst.threat = {};
    if (dst.threat instanceof Map) { if (v > 0) dst.threat.set(id, v); else dst.threat.delete(id); }
    else { if (v > 0) dst.threat[id] = v; else delete dst.threat[id]; }
  }
  function addThreat(dst, src, n) {
    if (!dst || !src || !(n > 0) || dst === src) return;
    if (dst.kind === 'player' || dst.kind === 'chest' || dst.kind === 'door' || dst.kind === 'node') return;
    const id = typeof src === 'string' ? src : src.id; if (!id) return;
    setThreat(dst, id, threatOf(dst, id) + n);
  }
  function clearThreat(dst) {
    if (!dst || !dst.threat) return;
    if (dst.threat instanceof Map) dst.threat.clear();
    else for (const k in dst.threat) delete dst.threat[k];
  }
  function topThreat(dst) {
    if (!dst || !dst.threat) return null;
    let best = null, bestV = 0;
    const t = dst.threat;
    if (t instanceof Map) {
      for (const [id, v] of t) { const e = G.getEntity(id); if (e && isAlive(e) && v > bestV && isHostile(dst, e)) { best = e; bestV = v; } }
    } else {
      for (const id in t) { const v = t[id]; const e = G.getEntity(id); if (e && isAlive(e) && v > bestV && isHostile(dst, e)) { best = e; bestV = v; } }
    }
    return best;
  }
  function maxThreat(dst) {
    let top = 0; const t = dst && dst.threat; if (!t) return 0;
    if (t instanceof Map) { for (const v of t.values()) if (v > top) top = v; }
    else for (const k in t) if (t[k] > top) top = t[k];
    return top;
  }
  function decayThreat(dst, dt) {
    const t = dst.threat; if (!t) return;
    const f = Math.pow(THREAT_DECAY, dt);
    if (t instanceof Map) { for (const [id, v] of t) { const nv = v * f; if (nv < 1) t.delete(id); else t.set(id, nv); } }
    else for (const id in t) { const nv = t[id] * f; if (nv < 1) delete t[id]; else t[id] = nv; }
  }
  function taunt(dst, src) {
    if (!dst || !src || !isAlive(dst) || !isAlive(src) || dst === src) return false;
    const top = maxThreat(dst);
    setThreat(dst, src.id, Math.max(top * 1.25, threatOf(dst, src) + 50, top + 50));
    dst.target = src;
    if (dst.ai && typeof dst.ai === 'object' && dst.ai.state !== 'attack') dst.ai.state = 'chase';
    const M = G.Monsters;
    if (dst.kind === 'monster' && M && typeof M.onTaunt === 'function') { try { M.onTaunt(dst, src); } catch (e) { report(e, 'Monsters.onTaunt'); } }
    markCombat(dst); markCombat(src);
    floatText(dst, 'Taunted', '#ffb060', null);
    return true;
  }

  // ------------------------------------------------------------------------------------------------ area queries (allocation-light)
  const _bufPool = [];
  function acquire() { return _bufPool.pop() || []; }
  function release(b) { if (!b) return; b.length = 0; if (_bufPool.length < 8) _bufPool.push(b); }
  let _fSrc = null;
  function hostileFilter(e) { return e !== _fSrc && isAlive(e) && e.kind !== 'chest' && e.kind !== 'door' && e.kind !== 'node' && e.kind !== 'fishspot' && e.kind !== 'boat' && isHostile(_fSrc, e); }
  function friendFilter(e) { return e !== _fSrc && isAlive(e) && (e.kind === 'player' || e.kind === 'aiplayer' || e.kind === 'npc') && isFriendly(_fSrc, e); }
  function byDist(a, b) { return a._cbd - b._cbd; }
  function near(centre, radius, out, src, coneDeg, max, filter) {
    out = out || []; out.length = 0;
    const cp = posOf(centre); const SP = G.Spatial;
    if (!cp || !SP || typeof SP.query !== 'function' || !(radius > 0)) return out;
    _fSrc = src || (centre && centre.id ? centre : null) || player();
    let q;
    try { q = SP.query(cp.x, cp.z, radius + 2.5, filter); } catch (e) { report(e, 'Spatial.query'); _fSrc = null; return out; }
    const sp = posOf(src) || cp; const yaw = src ? num(src.yaw, 0) : 0;
    const fx0 = -Math.sin(yaw), fz0 = -Math.cos(yaw);
    const cosCone = (coneDeg > 0 && coneDeg < 360) ? Math.cos(coneDeg * Math.PI / 360) : -2;
    for (let i = 0; i < q.length; i++) {
      const e = q[i]; const p = e.pos; if (!p) continue;
      const dx = p.x - cp.x, dz = p.z - cp.z, dy = num(p.y) - num(cp.y);
      const d = Math.sqrt(dx * dx + dz * dz) - radiusOf(e);
      if (d > radius || Math.abs(dy) > 4.5) continue;
      if (cosCone > -2) {
        const ex = p.x - sp.x, ez = p.z - sp.z; const l = Math.sqrt(ex * ex + ez * ez);
        if (l > 0.3 && (ex * fx0 + ez * fz0) / l < cosCone) continue;
      }
      e._cbd = d; out.push(e);
    }
    _fSrc = null;
    if (out.length > 1) out.sort(byDist);
    if (max > 0 && out.length > max) out.length = max;
    return out;
  }
  function hostilesNear(centre, radius, out, src, coneDeg, max) { return near(centre, radius, out, src, coneDeg, max, hostileFilter); }
  function friendliesNear(centre, radius, out, src, coneDeg, max) { return near(centre, radius, out, src, coneDeg, max, friendFilter); }
  function nearestHostile(ent, radius) {
    const p = posOf(ent); const SP = G.Spatial; if (!p || !SP || typeof SP.nearest !== 'function') return null;
    _fSrc = ent;
    let e = null; try { e = SP.nearest(p.x, p.z, num(radius, 30), hostileFilter); } catch (err) { report(err, 'Spatial.nearest'); }
    _fSrc = null; return e || null;
  }

  // ------------------------------------------------------------------------------------------------ effects
  function effectsOf(e) { if (!Array.isArray(e.effects)) e.effects = []; return e.effects; }
  function hasEffect(dst, id) {
    if (!dst || !id || !Array.isArray(dst.effects)) return false;
    const l = dst.effects; for (let i = 0; i < l.length; i++) if (l[i] && l[i].id === id) return true;
    return false;
  }
  function getEffect(dst, id) {
    if (!dst || !id || !Array.isArray(dst.effects)) return null;
    const l = dst.effects; for (let i = 0; i < l.length; i++) if (l[i] && l[i].id === id) return l[i];
    return null;
  }
  function effectsChanged(dst) { recompute(dst); G.emit('effectsChanged', dst); }
  function removeStances(dst, keepAbility) {
    const l = dst.effects; let removed = false;
    for (let i = l.length - 1; i >= 0; i--) { const e = l[i]; if (e && e.stance && (e.ability || e.id) !== keepAbility) { l.splice(i, 1); removed = true; } }
    return removed;
  }
  function addEffect(dst, effect, srcEnt) {
    if (!dst || !effect || typeof effect !== 'object' || !effect.id) return null;
    const kind = effect.kind || (effect.kind = 'buff');
    if (!isAlive(dst)) return null;
    if ((kind === 'stun' || kind === 'root') && dst.ccImmune) return null;
    if (typeof effect.total !== 'number' || !(effect.total > 0)) effect.total = num(effect.remaining, num(effect.duration, 10)) || 10;
    if (typeof effect.remaining !== 'number' || !isFinite(effect.remaining)) effect.remaining = effect.total;
    if ((kind === 'dot' || kind === 'hot')) {
      if (!(effect.tick > 0)) effect.tick = 2;
      if (typeof effect.nextTick !== 'number') effect.nextTick = effect.tick;
      if (typeof effect.perTick !== 'number') effect.perTick = num(effect.amount, 1);
    }
    const list = effectsOf(dst);
    let existing = null;
    for (let i = 0; i < list.length; i++) if (list[i] && list[i].id === effect.id) { existing = list[i]; break; }
    let out;
    if (existing) {
      const rem = Math.max(num(existing.remaining, 0), effect.remaining);
      const nextTick = existing.nextTick;
      Object.assign(existing, effect);
      existing.remaining = rem;
      if ((kind === 'dot' || kind === 'hot') && typeof nextTick === 'number') existing.nextTick = Math.min(nextTick, existing.tick);
      out = existing;
    } else {
      if (list.length >= MAX_EFFECTS) {
        let drop = -1;
        for (let i = 0; i < list.length; i++) { const e = list[i]; if (e && !e.stance && e.kind !== 'stun' && e.kind !== 'root') { drop = i; break; } }
        if (drop < 0) return null;
        list.splice(drop, 1);
      }
      if (effect.stance) removeStances(dst, effect.ability || effect.id);
      list.push(effect);
      out = effect;
    }
    if (srcEnt && typeof srcEnt === 'object') { hide(out, 'srcEnt', srcEnt); if (!out.src && srcEnt.id) out.src = srcEnt.id; }
    if (kind === 'stun') onStunned(dst);
    effectsChanged(dst);
    return out;
  }
  function removeEffect(dst, id) {
    if (!dst || !id || !Array.isArray(dst.effects)) return false;
    const l = dst.effects; let removed = false;
    for (let i = l.length - 1; i >= 0; i--) if (l[i] && l[i].id === id) { l.splice(i, 1); removed = true; }
    if (removed) effectsChanged(dst);
    return removed;
  }
  function clearEffects(dst, keepFn) {
    if (!dst || !Array.isArray(dst.effects)) return 0;
    const l = dst.effects; let n = 0;
    for (let i = l.length - 1; i >= 0; i--) { const e = l[i]; if (!e || typeof keepFn !== 'function' || !keepFn(e)) { l.splice(i, 1); n++; } }
    if (n) effectsChanged(dst);
    return n;
  }
  function onStunned(dst) {
    cancelCast(dst, 'Interrupted');
    floatText(dst, 'Stunned', '#ffd27a', null);
    playAnim(dst, 'hit', false);
  }
  function tickEffects(ent, dt) {
    const list = ent.effects; let removed = false;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      if (!e) { list.splice(i, 1); removed = true; continue; }
      e.remaining = num(e.remaining, 0) - dt;
      if (e.kind === 'dot' || e.kind === 'hot') {
        const tick = e.tick > 0 ? e.tick : 2;
        e.nextTick = num(e.nextTick, tick) - dt;
        let guard = 0;
        while (e.nextTick <= 0 && guard++ < 4 && isAlive(ent)) { e.nextTick += tick; applyTick(ent, e); }
        if (!isAlive(ent)) return;              // died from the tick: kill() already cleared the list
        if (i >= list.length) continue;         // list was modified re-entrantly
      }
      if (e.remaining <= 0) { list.splice(i, 1); removed = true; }
    }
    if (removed) effectsChanged(ent);
  }
  const _tickOpts = { crit: false, raw: true, kind: 'dot', dot: true, small: true, noFx: true, noAnim: true, sfx: null, threat: 1, ability: null };
  function applyTick(ent, e) {
    const src = e.srcEnt || (e.src ? G.getEntity(e.src) : null);
    if (e.kind === 'dot') {
      _tickOpts.crit = false; _tickOpts.ability = e.ability || null;
      damage(src, ent, num(e.perTick, 1), e.dtype || 'common', _tickOpts);
    } else {
      heal(src, ent, num(e.perTick, 1), _hotOpts);
    }
  }
  const _hotOpts = { hot: true, small: true, noFx: true, silent: true, crit: false };

  // ------------------------------------------------------------------------------------------------ combat state
  let combatUntil = 0, bossFight = false, musicMode = null;
  function markCombat(e) {
    if (!e) return;
    const t = now(); e.lastCombat = t;
    if (isPlayer(e)) combatUntil = t + COMBAT_TIMEOUT;
  }
  function inCombatFor(e) { return !!e && (now() - num(e.lastCombat, -1e9)) < COMBAT_TIMEOUT; }
  function playCombatMusic() {
    const A = G.Audio; if (!A || typeof A.music !== 'function') return;
    musicMode = bossFight ? 'boss' : 'combat';
    try { A.music(musicMode); } catch (e) { report(e, 'Audio.music'); }
    G.emit('combatMusic', musicMode);
  }
  function zoneTheme() {
    const W = G.Data && G.Data.world; const zid = G.state.zone;
    let z = null;
    if (W) {
      if (W.zoneById && W.zoneById[zid]) z = W.zoneById[zid];
      else if (Array.isArray(W.zones)) for (let i = 0; i < W.zones.length; i++) if (W.zones[i] && W.zones[i].id === zid) { z = W.zones[i]; break; }
    }
    if (z && z.music) return z.music;
    const A = G.Audio;
    if (A && typeof A.hasTheme === 'function' && zid && A.hasTheme(zid)) return zid;
    return 'shire';
  }
  function restoreMusic() {
    musicMode = null;
    const P = player(); if (P && !isAlive(P)) return;      // the death theme is playing; main restores on musicEnded
    const GM = G.Game;
    if (GM && typeof GM.zoneMusic === 'function') { try { GM.zoneMusic(); } catch (e) { report(e, 'Game.zoneMusic'); } G.emit('combatMusic', null); return; }
    const A = G.Audio; if (!A || typeof A.music !== 'function') return;
    try { A.music(zoneTheme()); } catch (e) { report(e, 'Audio.music'); }
    G.emit('combatMusic', null);
  }
  function updateCombatState() {
    const st = G.state; const P = st.player; const t = now();
    const should = !!P && isAlive(P) && combatUntil > t;
    if (should !== !!st.inCombat) {
      st.inCombat = should;
      if (should) { G.emit('combatStart'); playCombatMusic(); }
      else { G.emit('combatEnd'); bossFight = false; restoreMusic(); }
    } else if (should && bossFight && musicMode !== 'boss') playCombatMusic();
  }

  // ------------------------------------------------------------------------------------------------ damage pipeline
  const lastHit = { src: null, dst: null, amount: 0, crit: false, avoided: null, dtype: 'common' };
  const counters = { abilities: 0, hits: 0, crits: 0, avoided: 0, kills: 0, heals: 0, casts: 0, interrupted: 0, loot: 0 };
  let _lastHurtAt = -10;
  function critChanceOf(e) {
    if (!e) return 0;
    const s = e.stats;
    if (s && typeof s.critChance === 'number') return s.critChance;
    if (s && typeof s.crit === 'number' && G.Data && G.Data.stats && typeof G.Data.stats.critChance === 'function') return G.Data.stats.critChance(e);
    return e.kind === 'monster' ? 5 : 0;
  }
  function rollCrit(e, bonus) { return rand() * 100 < critChanceOf(e) + num(bonus, 0); }
  function mitigationFor(dst, dtype) {
    if (!dst) return 0;
    const ds = dst.stats;
    if (PHYSICAL[dtype]) {
      if (ds && typeof ds.mitigation === 'number') return ds.mitigation;
      const S = G.Data && G.Data.stats; return (S && typeof S.mitigation === 'function') ? num(S.mitigation(dst), 0) : 0;
    }
    if (dtype === 'fall') return 0;
    if (ds && typeof ds.resistChance === 'number') return ds.resistChance;
    const S = G.Data && G.Data.stats; return (S && typeof S.resistChance === 'function') ? num(S.resistChance(dst), 0) : 0;
  }
  function finesseOf(src) {
    if (!src || !src.stats) return 0;
    const f = num(src.stats.finesse, 0); if (f <= 0) return 0;
    return Math.min(20, f / (f + 40 * levelOf(src) + 300) * 100);
  }
  function rollAvoidance(src, dst, kind) {
    const ds = dst.stats; if (!ds || ds.stunned) return null;
    const fin = finesseOf(src);
    const ev = Math.max(0, num(ds.evadeChance, 0) - fin);
    const pa = kind === 'melee' ? Math.max(0, num(ds.parryChance, 0) - fin) : 0;
    const canBlock = ds.hasShield === true || (ds.hasShield === undefined && dst.kind !== 'monster');
    const bl = (canBlock && kind !== 'tactical') ? Math.max(0, num(ds.blockChance, 0) - fin) : 0;
    if (ev + pa + bl <= 0) return null;
    const r = rand() * 100;
    if (r < ev) return 'evade';
    if (r < ev + pa) return 'parry';
    if (r < ev + pa + bl) return 'block';
    return null;
  }
  function hitReaction(dst) {
    const r = dst.rig; if (!r || typeof r.setAnim !== 'function') return;
    if (dst.casting) return;
    const one = r.oneShot;
    if (typeof one === 'string' && (one.indexOf('attack') === 0 || one === 'cast')) return;
    const t = now();
    if (num(dst._hitAnimAt, -10) + HIT_ANIM_GAP > t) return;
    dst._hitAnimAt = t;
    playAnim(dst, 'hit', false);
  }
  function wakeTarget(dst, src, amount) {
    if (!src || src === dst) return;
    if (dst.kind === 'monster') {
      const M = G.Monsters;
      if (M && typeof M.onDamaged === 'function') { try { M.onDamaged(dst, src, amount); } catch (e) { report(e, 'Monsters.onDamaged'); } }
      else {
        if (!isAlive(dst.target) || !isHostile(dst, dst.target)) dst.target = src;
        if (dst.ai && typeof dst.ai === 'object' && dst.ai.state !== 'attack' && dst.ai.state !== 'chase') dst.ai.state = 'chase';
      }
    } else if (dst.kind === 'aiplayer') {
      const AI = G.AIPlayers;
      if (AI && typeof AI.onDamaged === 'function') { try { AI.onDamaged(dst, src, amount); } catch (e) { report(e, 'AIPlayers.onDamaged'); } }
      else if (!isAlive(dst.target)) dst.target = src;
    } else if (dst.kind === 'npc') {
      const N = G.NPCs;
      if (N && typeof N.onDamaged === 'function') { try { N.onDamaged(dst, src, amount); } catch (e) { report(e, 'NPCs.onDamaged'); } }
    }
  }
  function dismountPlayer(p) {
    if (!p || !p.mounted) return;
    const PL = G.Player;
    if (PL && typeof PL.dismount === 'function') { try { PL.dismount(); } catch (e) { report(e, 'Player.dismount'); } }
    else p.mounted = false;
  }
  function damage(src, dst, amount, dtype, opts) {
    if (!dst || !isAlive(dst)) return 0;
    opts = opts || EMPTY;
    amount = num(amount, 0);
    if (amount <= 0) return 0;
    dtype = dtype || 'common';
    // read every option up front: `opts` may be a shared object that re-entrant calls overwrite
    const optCrit = !!opts.crit, optRaw = !!opts.raw, optKind = opts.kind || 'melee', optThreat = num(opts.threat, 1),
      optSfx = opts.sfx, optNoFx = !!opts.noFx, optNoAnim = !!opts.noAnim, optSmall = !!opts.small, optSilent = !!opts.silent,
      optDot = !!opts.dot, optAbility = opts.ability || null, optFxKind = opts.fxKind || null;
    const st = G.state, stats = statsObj();
    const dstIsPlayer = isPlayer(dst), credit = creditFor(src), srcIsPlayer = !!credit;
    const physical = !!PHYSICAL[dtype];
    const raw0 = amount;
    let avoided = null;

    if (srcIsPlayer) { const m = num(st.damageMult, 1); if (m > 0 && m !== 1) amount *= m; }
    if (dstIsPlayer && st.godMode) amount = 0;
    if (dtype === 'light' && src && src.stats) { const lm = num(src.stats.lightDamageMult, 1); if (lm > 0 && lm !== 1) amount *= lm; }
    if (!optRaw && amount > 0) {
      if (physical && optKind !== 'dot' && optKind !== 'fall') avoided = rollAvoidance(src, dst, optKind);
      if (!avoided) {
        const mit = mitigationFor(dst, dtype);
        if (mit > 0) amount *= 1 - Math.min(75, mit) / 100;
      }
    }
    if (avoided) amount = 0;
    amount = Math.round(amount);
    if (amount < 1 && !avoided && raw0 > 0 && !(dstIsPlayer && st.godMode)) amount = 1;

    // apply
    const before = num(dst.morale, 0);
    dst.morale = Math.max(0, before - amount);
    const dealt = before - dst.morale;
    const crit = optCrit && dealt > 0;
    lastHit.src = src || null; lastHit.dst = dst; lastHit.amount = dealt; lastHit.crit = crit; lastHit.avoided = avoided; lastHit.dtype = dtype;
    counters.hits++; if (crit) counters.crits++; if (avoided) counters.avoided++;

    // bookkeeping
    if (srcIsPlayer) { stats.damageDealt += dealt; if (dealt > stats.biggestHit) stats.biggestHit = dealt; }
    if (dstIsPlayer) stats.damageTaken += dealt;
    if (src && src !== dst) {
      if (srcIsPlayer || dstIsPlayer || isPlayer(rootOwner(dst))) { markCombat(src); markCombat(dst); if (isPlayer(credit) && credit !== src) markCombat(credit); }
      else { src.lastCombat = now(); dst.lastCombat = now(); }
      if (isBoss(src) || isBoss(dst)) { if (srcIsPlayer || dstIsPlayer) bossFight = true; }
      if (isHostile(src, dst)) addThreat(dst, src, Math.max(dealt, 5) * optThreat);
      if (credit && credit !== src && isHostile(credit, dst)) addThreat(dst, credit, Math.max(dealt, 5) * optThreat * 0.5);
    } else if (dstIsPlayer) markCombat(dst);
    if (dstIsPlayer) dismountPlayer(dst);

    // feedback
    const involvesPlayer = srcIsPlayer || dstIsPlayer;
    if (!optSilent && (involvesPlayer || (!optDot && nearPlayer(dst, 60)))) {
      if (avoided) {
        const word = avoided === 'evade' ? 'Evaded' : avoided === 'parry' ? 'Parried' : 'Blocked';
        floatText(dst, word, dstIsPlayer ? COLOR_AVOID_MINE : COLOR_AVOID, null);
        if (srcIsPlayer) chat(nameOf(dst) + (avoided === 'evade' ? ' evades' : avoided === 'parry' ? ' parries' : ' blocks') + ' your attack.', 'combat');
        else if (dstIsPlayer) chat('You ' + (avoided === 'evade' ? 'evade' : avoided === 'parry' ? 'parry' : 'block') + ' the attack of ' + nameOf(src) + '.', 'combat');
      } else {
        let color = dstIsPlayer ? (crit ? COLOR_TAKEN_CRIT : COLOR_TAKEN) : srcIsPlayer ? (crit ? COLOR_CRIT : (DTYPE_COLOR[dtype] || COLOR_DEALT)) : COLOR_OTHER;
        if (st.godMode && dstIsPlayer) color = COLOR_AVOID;
        _ftOpts.crit = crit; _ftOpts.size = optSmall ? 'small' : (crit ? 'big' : 'normal');
        floatText(dst, (st.godMode && dstIsPlayer) ? 'Immune' : '-' + fmtNum(dealt), color, _ftOpts);
        if (srcIsPlayer && !optDot) chat('You ' + (crit ? 'critically hit ' : 'hit ') + nameOf(dst) + ' for ' + fmtNum(dealt) + ' ' + (DTYPE_NAME[dtype] || dtype) + ' damage.', 'combat');
        else if (srcIsPlayer && optDot) chat(nameOf(dst) + ' suffers ' + fmtNum(dealt) + ' ' + (DTYPE_NAME[dtype] || dtype) + ' damage' + (optAbility ? ' from ' + (optAbility.name || optAbility) : '') + '.', 'combat');
        else if (dstIsPlayer && src) chat(nameOf(src) + (crit ? ' critically hits you for ' : ' hits you for ') + fmtNum(dealt) + ' ' + (DTYPE_NAME[dtype] || dtype) + ' damage.', 'combat');
        else if (dstIsPlayer && dtype === 'fall') chat('You take ' + fmtNum(dealt) + ' damage from the fall.', 'combat');
      }
    }
    if (!avoided && !optNoFx && dealt > 0 && nearPlayer(dst, 120)) {
      chestPos(dst, _v5);
      const o = fxReset();
      const sp = posOf(src);
      if (sp && sp !== posOf(dst)) { _v3.set(_v5.x - sp.x, 0, _v5.z - sp.z); if (_v3.x || _v3.z) o.dir = _v3; }
      o.color = DTYPE_HEX[dtype]; o.scale = isBoss(dst) ? 1.4 : 1;
      fx((crit || optFxKind === 'crit') ? 'crit' : 'hit', _v5, o);
    }
    if (avoided) { if (optSfx !== null && !optDot) sfx(avoided === 'evade' ? 'sword_swing' : 'sword_hit', dst, 0.5, avoided === 'evade' ? 1.1 : 0.7); }
    else if (optSfx) sfx(optSfx, dst, 1, 1);
    else if (optSfx !== null && !optDot && HIT_SFX[dtype]) sfx(HIT_SFX[dtype], dst, 0.8, 1);
    if (dstIsPlayer && dealt > 0 && !st.godMode) {
      const t = now(); const maxM = dst.stats ? num(dst.stats.maxMorale, 100) : 100;
      if (dealt >= maxM * 0.01 && t - _lastHurtAt > 0.4) { _lastHurtAt = t; sfx('hurt', dst, Math.min(1, 0.5 + dealt / maxM * 4), 1); }
    }
    if (!optNoAnim && !avoided && dealt > 0) hitReaction(dst);

    // wake / threat / events
    wakeTarget(dst, src, dealt);
    G.emit('entityDamaged', { src: src || null, dst: dst, amount: dealt, crit: crit, dtype: dtype, avoided: avoided, ability: optAbility });
    if (dst.morale <= 0 && isAlive(dst)) kill(dst, src || null);
    return dealt;
  }
  const _ftOpts = { crit: false, size: 'normal' };

  function heal(src, dst, amount, opts) {
    if (!dst || !isAlive(dst)) return 0;
    opts = opts || EMPTY;
    amount = num(amount, 0); if (amount <= 0) return 0;
    const optCrit = !!opts.crit, optSmall = !!opts.small, optNoFx = !!opts.noFx, optSilent = !!opts.silent, optHot = !!opts.hot;
    const ds = dst.stats; const max = ds ? Math.max(1, num(ds.maxMorale, num(dst.morale, 1))) : Math.max(1, num(dst.morale, 1));
    const before = num(dst.morale, 0);
    dst.morale = Math.min(max, before + Math.round(amount));
    const eff = Math.round(dst.morale - before);
    counters.heals++;
    const credit = creditFor(src);
    if (credit) statsObj().healingDone += eff;
    if (eff > 0 && (isPlayer(dst) || credit || nearPlayer(dst, 60))) {
      _ftOpts.crit = optCrit; _ftOpts.size = optSmall ? 'small' : (optCrit ? 'big' : 'normal');
      floatText(dst, '+' + fmtNum(eff), optCrit ? COLOR_HEAL_CRIT : COLOR_HEAL, _ftOpts);
      if (isPlayer(dst) && !optHot) chat((src === dst || !src ? 'You are healed for ' : nameOf(src) + ' heals you for ') + fmtNum(eff) + ' Morale.', 'combat');
      else if (credit && !optHot) chat('You heal ' + nameOf(dst) + ' for ' + fmtNum(eff) + ' Morale.', 'combat');
    }
    if (!optNoFx && nearPlayer(dst, 120)) { const o = fxReset(); o.scale = optSmall ? 0.6 : 1; fx('heal', posOf(dst), o); }
    if (!optSilent) sfx('heal', dst, optSmall ? 0.5 : 0.9, 1);
    if (src && eff > 0 && !optHot) {
      // healing draws a little attention from foes already fighting the healed entity or the healer
      const buf = acquire(); hostilesNear(dst, 20, buf, src, 0, 12);
      for (let i = 0; i < buf.length; i++) { const m = buf[i]; if (threatOf(m, src) > 0 || threatOf(m, dst) > 0 || m.target === src || m.target === dst) addThreat(m, src, eff * 0.5); }
      release(buf);
    }
    G.emit('entityHealed', { src: src || null, dst: dst, amount: eff });
    return eff;
  }

  // ------------------------------------------------------------------------------------------------ ability checks
  const _chk = { ok: false, reason: '', code: '', target: null };
  function canUse(ent, abilityId, target, opts) {
    const r = _chk; r.ok = false; r.reason = ''; r.code = ''; r.target = null;
    const a = resolveAbility(abilityId);
    if (!ent || !a) { r.reason = 'Unknown ability'; r.code = 'unknown'; return r; }
    opts = opts || EMPTY;
    const me = isPlayer(ent);
    if (!isAlive(ent)) { r.reason = me ? 'You are defeated' : 'Defeated'; r.code = 'dead'; return r; }
    if (ent.stats && ent.stats.stunned) { r.reason = me ? 'You are stunned' : 'Stunned'; r.code = 'stunned'; return r; }
    if (ent.casting) { r.reason = 'You are already casting'; r.code = 'casting'; return r; }
    const free = me && !!G.state.noCooldowns;
    if ((me || ent.kind === 'aiplayer') && ent.abilities && a.cls !== 'monster' && !free && !abilitiesHas(ent.abilities, a.id)) {
      r.reason = 'You have not learned ' + a.name; r.code = 'untrained'; return r;
    }
    if (!free) {
      if (typeof ent.power === 'number' && ent.power < num(a.power, 0)) { r.reason = 'Not enough Power'; r.code = 'power'; return r; }
      const cd = ent.cooldowns ? num(ent.cooldowns[a.id], 0) : 0;
      if (cd > now()) { r.reason = a.name + ' is not ready yet'; r.code = 'cooldown'; return r; }
    }
    if (a.gcd !== false && num(ent.gcdReady, 0) > now() + 1e-4 && !opts.ignoreGcd) { r.reason = ''; r.code = 'gcd'; return r; }
    let t = null;
    switch (a.target) {
      case 'self': case 'party': t = ent; break;
      case 'ally': t = (target && target !== ent && isAlive(target) && isFriendly(ent, target)) ? target : ent; break;
      default: {
        t = target || ent.target || null;
        if (!t || !isAlive(t)) { r.reason = 'You need a living target'; r.code = 'notarget'; return r; }
        if (!isHostile(ent, t)) { r.reason = 'That is not a valid target'; r.code = 'badtarget'; return r; }
      }
    }
    if (t !== ent) {
      const range = num(a.range, MELEE);
      if (!inRange(ent, t, range + RANGE_SLACK)) { r.reason = 'Target is out of range'; r.code = 'range'; return r; }
      if (!canSee(ent, t)) { r.reason = 'Target is not in line of sight'; r.code = 'los'; return r; }
      if (a.kind !== 'melee' && me && facing(ent, t) < FACING_DOT) { r.reason = 'You must face your target'; r.code = 'facing'; return r; }
    }
    r.ok = true; r.target = t;
    return r;
  }
  let _lastFailReason = '', _lastFailAt = -10;
  function failFeedback(ent, reason, code) {
    if (!isPlayer(ent)) return;
    Combat.lastError = reason || code || '';
    if (!reason || code === 'gcd') return;
    const t = now();
    if (reason === _lastFailReason && t - _lastFailAt < 1.5) return;
    _lastFailReason = reason; _lastFailAt = t;
    notify(reason, 'warning');
    sfx('ui_error', null, 0.6, 1);
  }
  function abilityReady(ent, id) {
    if (!ent) return false;
    const a = resolveAbility(id); if (!a) return false;
    if (isPlayer(ent) && G.state.noCooldowns) return true;
    const cd = ent.cooldowns ? num(ent.cooldowns[a.id], 0) : 0;
    return cd <= now() && (a.gcd === false || num(ent.gcdReady, 0) <= now());
  }
  function cooldownLeft(ent, id) {
    if (!ent) return 0;
    const a = resolveAbility(id); if (!a) return 0;
    if (isPlayer(ent) && G.state.noCooldowns) return 0;
    const cd = ent.cooldowns ? num(ent.cooldowns[a.id], 0) : 0;
    return Math.max(0, cd - now());
  }
  function cooldownFrac(ent, id) {
    if (!ent) return 0;
    const a = resolveAbility(id); if (!a) return 0;
    if (isPlayer(ent) && G.state.noCooldowns) return 0;
    const t = now();
    let f = 0;
    if (a.cooldown > 0) { const left = Math.max(0, (ent.cooldowns ? num(ent.cooldowns[a.id], 0) : 0) - t); f = Math.min(1, left / a.cooldown); }
    if (a.gcd !== false) { const g = Math.max(0, num(ent.gcdReady, 0) - t) / GCD; if (g > f) f = Math.min(1, g); }
    return f;
  }

  // ------------------------------------------------------------------------------------------------ casting
  function isCasting(ent) { return !!(ent && ent.casting); }
  function castProgress(ent) {
    const c = ent && ent.casting; if (!c) return 0;
    const d = c.end - c.start; if (!(d > 0)) return 1;
    return Math.max(0, Math.min(1, (now() - c.start) / d));
  }
  function startCast(ent, a, t) {
    const p = posOf(ent); const tNow = now();
    const c = { id: a.id, name: a.name, icon: a.icon || '', start: tNow, end: tNow + a.castTime, castTime: a.castTime, x: p ? p.x : 0, z: p ? p.z : 0 };
    hide(c, 'ability', a); hide(c, 'target', t || null); hide(c, 'fx', null);
    ent.casting = c;
    if (a.gcd !== false) ent.gcdReady = tNow + GCD;
    playAnim(ent, 'cast', true);
    sfx('spell_cast', ent, 0.8, 1);
    if (nearPlayer(ent, 120)) { const o = fxReset(); o.target = ent; o.yOff = heightOf(ent) * 0.7; o.duration = a.castTime; o.color = DTYPE_HEX[(a.effects[0] && a.effects[0].dtype) || 'light']; c.fx = fx('sparkle', p, o); }
    counters.casts++;
    G.emit('castStart', ent);
  }
  function cancelCast(ent, reason) {
    const c = ent && ent.casting; if (!c) return false;
    ent.casting = null;
    stopFx(c.fx);
    counters.interrupted++;
    if (reason) { floatText(ent, reason, COLOR_AVOID, null); if (isPlayer(ent)) chat(c.name + ': ' + reason.toLowerCase() + '.', 'combat'); }
    playAnim(ent, 'idle', true);
    G.emit('castEnd', ent);
    return true;
  }
  function interrupt(ent) { return cancelCast(ent, 'Interrupted'); }
  function updateCast(ent) {
    const c = ent.casting; if (!c) return;
    if (!isAlive(ent)) { cancelCast(ent, null); return; }
    if (ent.stats && ent.stats.stunned) { cancelCast(ent, 'Interrupted'); return; }
    const p = posOf(ent);
    if (p) {
      const dx = p.x - c.x, dz = p.z - c.z, tol = isPlayer(ent) ? CAST_MOVE_TOLERANCE : CAST_MOVE_TOLERANCE_AI;
      if (dx * dx + dz * dz > tol * tol) { cancelCast(ent, 'Interrupted'); return; }
    }
    const a = c.ability, tg = c.target;
    if (tg && tg !== ent && (!isAlive(tg) || (a.target === 'enemy' && !isHostile(ent, tg)))) { cancelCast(ent, 'Target lost'); return; }
    if (now() < c.end) return;
    ent.casting = null; stopFx(c.fx);
    if (tg && tg !== ent) {
      if (!inRange(ent, tg, num(a.range, MELEE) + 2)) { failFeedback(ent, 'Target is out of range', 'range'); floatText(ent, 'Out of range', COLOR_AVOID, null); G.emit('castEnd', ent); return; }
      if (!canSee(ent, tg)) { failFeedback(ent, 'Target is not in line of sight', 'los'); G.emit('castEnd', ent); return; }
      if (!isPlayer(ent) || a.kind === 'melee') faceTarget(ent, tg);
    }
    G.emit('castEnd', ent);
    execute(ent, a, tg);
  }

  // ------------------------------------------------------------------------------------------------ ability execution
  const lastAbility = { ent: null, id: null, target: null, time: -1 };
  function useAbility(ent, abilityId, target, opts) {
    const a = resolveAbility(abilityId);
    if (!ent || !a) return false;
    opts = opts || EMPTY;
    const chk = canUse(ent, a, target, opts);
    if (!chk.ok) { failFeedback(ent, chk.reason, chk.code); return false; }
    const t = chk.target;
    if (isPlayer(ent) && ent.mounted) dismountPlayer(ent);
    const aim = (t === ent) ? ((target && target !== ent && isAlive(target)) ? target : ent.target) : t;
    if (aim && aim !== ent && isAlive(aim) && isHostile(ent, aim) && (a.kind === 'melee' || !isPlayer(ent) || opts.face)) faceTarget(ent, aim);
    if (a.castTime > 0) { startCast(ent, a, t); return true; }
    return execute(ent, a, t);
  }
  function execute(ent, a, t) {
    if (!ent || !a || !isAlive(ent)) return false;
    const tNow = now();
    const free = isPlayer(ent) && !!G.state.noCooldowns;
    if (!free) {
      if (typeof ent.power === 'number') ent.power = Math.max(0, ent.power - num(a.power, 0));
      if (a.cooldown > 0) { if (!ent.cooldowns) ent.cooldowns = {}; ent.cooldowns[a.id] = tNow + a.cooldown; }
    }
    if (a.gcd !== false) ent.gcdReady = tNow + (free ? 0.2 : GCD);
    ent.lastAbility = a.id; ent.lastAbilityTime = tNow;
    lastAbility.ent = ent; lastAbility.id = a.id; lastAbility.target = t || null; lastAbility.time = tNow;
    counters.abilities++;
    if (t && t !== ent && isHostile(ent, t)) { markCombat(ent); markCombat(t); }
    playAnim(ent, ent.kind === 'monster' ? 'attack' : (ANIM_MAP[a.anim] || 'attack_slash'), true);
    const pk = (t && t !== ent && a.target === 'enemy') ? PROJ_KIND[a.vfx] : null;
    const F = G.FX;
    let launched = false;
    if (pk && F && typeof F.projectile === 'function' && nearPlayer(ent, 200)) {
      handPos(ent, _v5);
      const dtype = (a.effects[0] && a.effects[0].dtype) || 'common';
      const from = new V3(_v5.x, _v5.y, _v5.z);
      let h = null;
      try {
        h = F.projectile({ from: from, target: t, kind: pk, speed: PROJ_SPEED[pk] || 30, color: pk === 'arrow' ? 0xffffff : (DTYPE_HEX[dtype] || 0x8ec5ff),
          onHit: function (point, hitEnt) { onProjectileHit(ent, a, t, point, hitEnt); } });
      } catch (e) { report(e, 'FX.projectile'); h = null; }
      if (h) { launched = true; sfx(pk === 'arrow' ? 'bow_shoot' : 'spell_cast', ent, 0.9, 1); }
    }
    if (!launched) {
      sfx(a.sfx, (a.target === 'enemy' && t) ? t : ent, 1, 1);
      applyEffects(ent, a, t);
    }
    G.emit('abilityUsed', { ent: ent, ability: a, target: t || null });
    return true;
  }
  function onProjectileHit(ent, a, t, point, hitEnt) {
    if (!isAlive(ent)) return;
    let victim = null;
    if (t && isAlive(t) && isHostile(ent, t)) {
      // hit the intended target if the impact landed near it, or if the projectile reports it
      if (hitEnt === t) victim = t;
      else if (point && t.pos) { const dx = point.x - t.pos.x, dz = point.z - t.pos.z; if (dx * dx + dz * dz < 4) victim = t; }
      else victim = t;
    }
    if (!victim && hitEnt && hitEnt !== ent && isAlive(hitEnt) && isHostile(ent, hitEnt)) victim = hitEnt;
    if (!victim) { if (t && isPlayer(ent)) floatText(t, 'Miss', COLOR_AVOID, null); return; }
    sfx(a.sfx, victim, 1, 1);
    applyEffects(ent, a, victim);
  }

  function spawnAbilityFX(src, a, primary) {
    const kind = a.vfx; if (!kind || kind === 'hit' || kind === 'crit') return;   // per-hit impact FX come from damage()
    if (!nearPlayer(src, 150)) return;
    const o = fxReset();
    const sp = posOf(src), tp = (primary && primary !== src) ? posOf(primary) : null;
    if (sp && tp) { _v3.set(tp.x - sp.x, 0, tp.z - sp.z); if (_v3.x || _v3.z) o.dir = _v3; } else o.yaw = num(src.yaw, 0);
    const dtype = (a.effects[0] && a.effects[0].dtype) || null;
    if (dtype && DTYPE_HEX[dtype] && kind !== 'slash' && kind !== 'thrust' && kind !== 'spin' && kind !== 'heal' && kind !== 'buff') o.color = DTYPE_HEX[dtype];
    o.scale = isBoss(src) ? 1.6 : (src.kind === 'monster' ? Math.max(1, num(src.scale, 1)) : 1);
    if (CASTER_VFX[kind] || !tp) {
      if (kind === 'lightning' && primary && primary !== src) o.target = primary;
      fx(kind, sp, o);
    } else {
      chestPos(primary, _v5);
      if (kind === 'dust' || kind === 'smoke') _v5.y = num(tp.y);
      fx(kind, _v5, o);
    }
  }

  // ---- damage numbers
  function abilityBaseDamage(a, src, e) {
    const D = G.Data; let avg = 0;
    if (D && typeof D.abilityDamage === 'function') { try { const r = D.abilityDamage(a, src, e); if (r && r.avg > 0) avg = r.avg; } catch (err) { report(err, 'abilityDamage'); } }
    if (!(avg > 0)) {
      const mastery = (src && src.stats) ? num(src.stats[masteryKey(a)], 0) : 0;
      avg = Math.max(1, num(e.mult, 1) * mastery / 4 + weaponAvgFor(src, a));
    }
    return avg;
  }
  function weaponAvgFor(src, a) {
    if (!src) return 0;
    if (src.equipment && typeof src.equipment === 'object') {
      const slot = (a && a.kind === 'ranged') ? 'ranged' : 'mainhand';
      const v = itemView(src.equipment[slot] || (slot === 'ranged' ? src.equipment.mainhand : null));
      if (v && v.dmg && typeof v.dmg.min === 'number' && typeof v.dmg.max === 'number') return (v.dmg.min + v.dmg.max) / 2;
      const S = G.Data && G.Data.stats; return (S && typeof S.weaponAvg === 'function') ? num(S.weaponAvg(src), 1) : 2 + levelOf(src) * 0.6;
    }
    return monsterDmg(src);
  }
  const _hitOpts = { crit: false, ability: null, kind: 'melee', threat: 1, sfx: null, fxKind: null, raw: false, noFx: false, noAnim: false, small: false, silent: false, dot: false };
  function hitWithAbility(src, dst, a, e, threatMult) {
    const base = abilityBaseDamage(a, src, e);
    const crit = rollCrit(src);
    const amt = base * variance() * (crit ? CRIT_MULT : 1);
    _hitOpts.crit = crit; _hitOpts.ability = a; _hitOpts.kind = a.kind === 'ranged' ? 'ranged' : (a.kind === 'melee' ? 'melee' : 'tactical');
    _hitOpts.threat = threatMult; _hitOpts.fxKind = a.vfx === 'crit' ? 'crit' : null;
    return damage(src, dst, amt, e.dtype || 'common', _hitOpts);
  }
  const _healOpts = { crit: false, ability: null, small: false, noFx: false, silent: false, hot: false };
  function healWithAbility(src, dst, a, e) {
    const D = G.Data; let amt = 0;
    if (D && typeof D.abilityHeal === 'function') { try { amt = num(D.abilityHeal(a, src, e), 0); } catch (err) { report(err, 'abilityHeal'); } }
    if (!(amt > 0)) { const mastery = (src && src.stats) ? num(src.stats[masteryKey(a)], 0) : 0; amt = num(e.mult, 0) * mastery / 4 + num(e.amount, 0); }
    if (!(amt > 0)) return 0;
    const crit = rollCrit(src);
    amt = amt * (1 - 0.1 + rand() * 0.2) * (crit ? CRIT_MULT : 1);
    _healOpts.crit = crit; _healOpts.ability = a; _healOpts.noFx = false; _healOpts.silent = false;
    return heal(src, dst, amt, _healOpts);
  }
  function makeBuff(src, a, e, idx, kind, dst) {
    const dur = num(e.duration, 10);
    const eff = { id: a.id + '#' + idx, name: e.name || a.name, kind: kind, stat: e.stat, remaining: dur, total: dur, icon: a.icon || '', src: src.id, ability: a.id };
    if (typeof e.pct === 'number') eff.pct = e.pct;
    if (typeof e.amount === 'number') eff.amount = e.amount;
    if (a.kind === 'stance') eff.stance = true;
    const out = addEffect(dst, eff, src);
    if (out && kind === 'debuff' && dst !== src && isPlayer(src)) chat(nameOf(dst) + ' is afflicted by ' + eff.name + '.', 'combat');
    return out;
  }
  function makeDot(src, dst, a, e) {
    const D = G.Data; let per = 0;
    if (D && typeof D.abilityDot === 'function') { try { const r = D.abilityDot(a, src, e); if (r) per = num(r.perTick, 0); } catch (err) { report(err, 'abilityDot'); } }
    if (!(per > 0)) { const mastery = (src && src.stats) ? num(src.stats[masteryKey(a)], 0) : 0; per = Math.max(1, num(e.mult, 0.3) * mastery / 4); }
    const crit = rollCrit(src);
    if (crit) per *= CRIT_MULT;
    if (e.type === 'dot') { const mit = mitigationFor(dst, e.dtype || 'common'); if (mit > 0) per *= 1 - Math.min(75, mit) / 100; }
    per = Math.max(1, Math.round(per));
    const dur = num(e.duration, 10), tick = e.tick > 0 ? e.tick : (e.type === 'dot' ? 2 : 3);
    const eff = { id: a.id + ':' + e.type, name: a.name, kind: e.type, dtype: e.dtype || 'common', tick: tick, perTick: per, nextTick: tick, remaining: dur, total: dur, icon: a.icon || '', src: src.id, ability: a.id, crit: crit };
    return addEffect(dst, eff, src);
  }
  function makeCC(src, dst, a, e) {
    if (!dst || !isAlive(dst) || dst.ccImmune) return null;
    let dur = num(e.duration, 2);
    if (isBoss(dst)) dur *= 0.5;
    if (dur <= 0) return null;
    let eff;
    if (e.type === 'stun') eff = { id: 'stun', name: 'Stunned', kind: 'stun', remaining: dur, total: dur, icon: '💫', src: src.id, ability: a.id };
    else if (e.type === 'root') eff = { id: 'root', name: 'Rooted', kind: 'root', remaining: dur, total: dur, icon: '🕸', src: src.id, ability: a.id };
    else eff = { id: 'slow:' + a.id, name: 'Slowed', kind: 'slow', pct: num(e.pct, 30), remaining: dur, total: dur, icon: '🐌', src: src.id, ability: a.id };
    const out = addEffect(dst, eff, src);
    if (out && e.type !== 'stun') floatText(dst, eff.name, '#a8d8ff', null);
    return out;
  }
  function knockback(src, dst, force) {
    if (!src || !dst || !isAlive(dst) || isBoss(dst) || dst.ccImmune) return false;
    const sp = posOf(src), dp = posOf(dst); if (!sp || !dp) return false;
    let f = num(force, 4);
    const res = dst.stats ? num(dst.stats.knockbackResist, 0) : 0;
    f *= Math.max(0, 1 - res);
    if (f <= 0.05) return false;
    let dx = dp.x - sp.x, dz = dp.z - sp.z; const l = Math.sqrt(dx * dx + dz * dz);
    if (l < 1e-3) { const yaw = num(src.yaw, 0); dx = -Math.sin(yaw); dz = -Math.cos(yaw); } else { dx /= l; dz /= l; }
    if (!dst.knockback || typeof dst.knockback !== 'object') dst.knockback = new V3(0, 0, 0);
    dst.knockback.x = num(dst.knockback.x, 0) + dx * f;
    dst.knockback.z = num(dst.knockback.z, 0) + dz * f;
    dst.knockback.y = Math.max(num(dst.knockback.y, 0), f * 0.45);
    cancelCast(dst, 'Interrupted');
    if (nearPlayer(dst, 120)) { const o = fxReset(); o.dir = _v3.set(dx, 0, dz); fx('dust', dp, o); }
    return true;
  }
  function abilityArea(a) {
    let r = 0; const effs = a.effects;
    for (let i = 0; i < effs.length; i++) if (effs[i] && effs[i].aoe > r) r = effs[i].aoe;
    return r;
  }
  function collectTargets(src, primary, centre, a, e, wantHostile, buf) {
    buf.length = 0;
    if (wantHostile) {
      const hostilePrimary = !!(primary && primary !== src && isAlive(primary) && isHostile(src, primary));
      const r = e.aoe > 0 ? e.aoe : (hostilePrimary ? 0 : abilityArea(a));
      if (r > 0) hostilesNear(centre, r, buf, src, num(a.cone, 0), MAX_AOE);
      else if (hostilePrimary) buf.push(primary);
      return buf;
    }
    const et = e.target || 'self';
    if (et === 'target') { buf.push((primary && primary !== src && isAlive(primary) && isFriendly(src, primary)) ? primary : src); return buf; }
    if (et === 'party') {
      buf.push(src);
      const tmp = acquire(); friendliesNear(src, e.aoe > 0 ? e.aoe : 10, tmp, src, 0, 5);
      for (let i = 0; i < tmp.length; i++) if (tmp[i].kind === 'player' || tmp[i].kind === 'aiplayer') buf.push(tmp[i]);
      release(tmp);
      return buf;
    }
    buf.push(src);
    return buf;
  }
  function applyEffects(src, a, primary) {
    if (!src || !a || !Array.isArray(a.effects) || !isAlive(src)) return;
    const effs = a.effects;
    const selfCentred = a.target === 'self' || a.target === 'party';
    const centre = selfCentred ? src : (primary || src);
    const threatMult = num(a.threat, 1);
    spawnAbilityFX(src, a, primary);
    const buf = acquire();
    for (let i = 0; i < effs.length; i++) {
      const e = effs[i]; if (!e || !e.type) continue;
      if (!isAlive(src)) break;
      switch (e.type) {
        case 'damage': {
          collectTargets(src, primary, centre, a, e, true, buf);
          for (let k = 0; k < buf.length; k++) if (isAlive(buf[k])) hitWithAbility(src, buf[k], a, e, threatMult);
          break;
        }
        case 'heal': {
          collectTargets(src, primary, centre, a, e, false, buf);
          for (let k = 0; k < buf.length; k++) if (isAlive(buf[k])) healWithAbility(src, buf[k], a, e);
          break;
        }
        case 'hot': {
          collectTargets(src, primary, centre, a, e, false, buf);
          for (let k = 0; k < buf.length; k++) if (isAlive(buf[k])) makeDot(src, buf[k], a, e);
          break;
        }
        case 'buff': {
          collectTargets(src, primary, centre, a, e, false, buf);
          for (let k = 0; k < buf.length; k++) if (isAlive(buf[k])) makeBuff(src, a, e, i, 'buff', buf[k]);
          break;
        }
        case 'debuff': {
          if (e.target === 'self') { makeBuff(src, a, e, i, 'debuff', src); break; }
          collectTargets(src, primary, centre, a, e, true, buf);
          for (let k = 0; k < buf.length; k++) if (isAlive(buf[k])) makeBuff(src, a, e, i, 'debuff', buf[k]);
          break;
        }
        case 'dot': {
          collectTargets(src, primary, centre, a, e, true, buf);
          for (let k = 0; k < buf.length; k++) if (isAlive(buf[k])) makeDot(src, buf[k], a, e);
          break;
        }
        case 'stun': case 'root': case 'slow': {
          collectTargets(src, primary, centre, a, e, true, buf);
          for (let k = 0; k < buf.length; k++) if (isAlive(buf[k])) makeCC(src, buf[k], a, e);
          break;
        }
        case 'knockback': {
          collectTargets(src, primary, centre, a, e, true, buf);
          for (let k = 0; k < buf.length; k++) if (isAlive(buf[k])) knockback(src, buf[k], e.force);
          break;
        }
        case 'pet': case 'summon': {
          const dur = num(e.duration, 60);
          addEffect(src, { id: a.id + '#pet', name: e.name || a.name, kind: 'buff', stat: e.stat || 'physMastery', pct: num(e.pct, 10), remaining: dur, total: dur, icon: a.icon || '', src: src.id, ability: a.id }, src);
          break;
        }
        default: break;
      }
    }
    release(buf);
    if (a.kind === 'taunt' || num(a.threat, 0) >= 4) {
      if (primary && primary !== src && isAlive(primary) && isHostile(src, primary)) taunt(primary, src);
      if (a.kind === 'taunt' || a.target === 'self') {
        const tb = acquire(); hostilesNear(src, Math.max(num(a.range, 0), 8), tb, src, 0, MAX_AOE);
        for (let k = 0; k < tb.length; k++) if (tb[k] !== primary) taunt(tb[k], src);
        release(tb);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ basic (auto) attacks
  function weaponSpeed(ent) {
    if (!ent) return 2;
    if (ent.equipment && typeof ent.equipment === 'object') {
      const v = itemView(ent.equipment.mainhand);
      if (v && typeof v.speed === 'number' && v.speed > 0) return v.speed;
      return 2.0;
    }
    if (typeof ent.attackSpeed === 'number' && ent.attackSpeed > 0) return ent.attackSpeed;
    const td = typeDataOf(ent);
    if (td && typeof td.attackSpeed === 'number' && td.attackSpeed > 0) return td.attackSpeed;
    return ent.kind === 'monster' ? 1.8 : 2.0;
  }
  function basicAttackAvg(ent) {
    if (!ent) return 1;
    if (ent.equipment && typeof ent.equipment === 'object') {
      const S = G.Data && G.Data.stats;
      let w = (S && typeof S.weaponAvg === 'function') ? num(S.weaponAvg(ent), 1) : 2 + levelOf(ent) * 0.6;
      const ov = itemView(ent.equipment.offhand);
      if (ov && ov.dmg && typeof ov.dmg.min === 'number') w += (ov.dmg.min + ov.dmg.max) / 2 * 0.5;
      const pm = ent.stats ? num(ent.stats.physMastery, 0) : 0;
      return Math.max(1, w + 0.5 * pm / 4);
    }
    return Math.max(1, monsterDmg(ent));
  }
  function weaponDtype(ent) {
    if (ent && ent.equipment) { const v = itemView(ent.equipment.mainhand); if (v && v.dmg && v.dmg.type) return v.dmg.type; }
    return 'common';
  }
  function weaponHitSfx(ent) {
    if (ent && ent.equipment) { const v = itemView(ent.equipment.mainhand); if (v && v.subtype && WEAPON_HIT_SFX[v.subtype]) return WEAPON_HIT_SFX[v.subtype]; return 'sword_hit'; }
    const fam = familyOf(ent);
    return (fam === 'goblin' || fam === 'orc' || fam === 'uruk' || fam === 'brigand' || fam === 'sorcerer') ? 'sword_hit' : 'blunt_hit';
  }
  function basicAttackDamage(ent) {
    const avg = basicAttackAvg(ent);
    return { min: Math.round(avg * (1 - VARIANCE)), max: Math.round(avg * (1 + VARIANCE)), avg: Math.round(avg), dtype: weaponDtype(ent), speed: weaponSpeed(ent) };
  }
  const _autoOpts = { crit: false, ability: null, kind: 'melee', threat: 1, sfx: 'sword_hit', fxKind: null, raw: false, noFx: false, noAnim: false, small: false, silent: false, dot: false };
  function basicAttack(ent, target, opts) {
    if (!ent || !target || ent === target || !isAlive(ent) || !isAlive(target)) return false;
    opts = opts || EMPTY;
    if (!opts.force && !isHostile(ent, target)) return false;
    if (ent.stats && ent.stats.stunned) return false;
    if (ent.casting) return false;
    if (isPlayer(ent) && ent.mounted) return false;
    const tNow = now();
    if (!opts.force && num(ent.nextSwing, 0) > tNow) return false;
    const range = num(opts.range, MELEE);
    if (!inRange(ent, target, range + RANGE_SLACK)) return false;
    if (!opts.force && !canSee(ent, target)) return false;
    faceTarget(ent, target);
    const speed = weaponSpeed(ent);
    ent.nextSwing = tNow + speed; ent.lastSwing = tNow;
    markCombat(ent); markCombat(target);
    const rig = ent.rig;
    playAnim(ent, ent.kind === 'monster' ? 'attack' : ((rig && typeof rig.attackFor === 'function') ? rig.attackFor() : 'attack_slash'), false);
    if (ent.equipment) sfx('sword_swing', ent, 0.55, 1);
    const crit = rollCrit(ent);
    const amt = basicAttackAvg(ent) * variance() * (crit ? CRIT_MULT : 1);
    _autoOpts.crit = crit; _autoOpts.sfx = weaponHitSfx(ent);
    damage(ent, target, amt, weaponDtype(ent), _autoOpts);
    return true;
  }
  function updateAutoAttack(p, tNow) {
    if (!p.autoAttack) return;
    const t = p.target;
    if (!isAlive(p) || !isAlive(t) || !isHostile(p, t)) { p.autoAttack = false; return; }
    if (p.casting || p.mounted || (p.stats && p.stats.stunned)) return;
    if (num(p.nextSwing, 0) > tNow) return;
    if (!inRange(p, t, MELEE + RANGE_SLACK)) return;
    if (facing(p, t) < 0.3) return;
    basicAttack(p, t, EMPTY);
  }

  // ------------------------------------------------------------------------------------------------ death & loot
  const lootBags = [];
  let _sceneRef = null;
  function sceneRef() {
    if (_sceneRef && _sceneRef.isObject3D) return _sceneRef;
    const GM = G.Game;
    if (GM && GM.scene && GM.scene.isObject3D) { _sceneRef = GM.scene; return _sceneRef; }
    const p = player();
    const grp = p && p.rig && p.rig.group ? p.rig.group : (p && p.mesh ? p.mesh : null);
    if (grp && grp.parent && grp.parent.isScene) { _sceneRef = grp.parent; return _sceneRef; }
    return null;
  }
  function rarityHexOf(list) {
    const I = G.Items; let best = 0;
    const order = C.RARITY || ['common', 'uncommon', 'rare', 'incomparable', 'legendary'];
    if (I && typeof I.rarityOf === 'function') for (let i = 0; i < list.length; i++) { const r = order.indexOf(I.rarityOf(list[i])); if (r > best) best = r; }
    if (best <= 0) return 0xffe08a;
    const col = C.RARITY_COLOR && C.RARITY_COLOR[order[best]];
    if (typeof col === 'string' && col[0] === '#') return parseInt(col.slice(1), 16) || 0xffe08a;
    return 0xffe08a;
  }
  function lootInteract(bag) { return lootBag(bag, player()); }
  function attachLootMesh(bag) {
    const scene = sceneRef(); const CH = G.Chars;
    if (!scene || !CH || typeof CH.buildProp !== 'function') return;
    try {
      const prop = CH.buildProp('bundle');
      const grp = prop && (prop.group || (prop.isObject3D ? prop : null));
      if (!grp) return;
      grp.position.set(bag.pos.x, bag.pos.y, bag.pos.z); grp.rotation.y = bag.yaw;
      scene.add(grp);
      bag.prop = prop; bag.mesh = grp;
    } catch (e) { report(e, 'loot bag mesh'); }
  }
  function detachLootMesh(bag) {
    if (bag.mesh && bag.mesh.parent) bag.mesh.parent.remove(bag.mesh);
    if (bag.prop && typeof bag.prop.dispose === 'function') { try { bag.prop.dispose(); } catch (e) { /* ignore */ } }
    bag.mesh = null; bag.prop = null;
  }
  function dropLoot(victim, forPlayer) {
    const I = G.Items; if (!victim || !I || typeof I.lootFor !== 'function') return null;
    const td = typeDataOf(victim) || { id: victim.typeId || null, name: victim.name, family: familyOf(victim), level: levelOf(victim), loot: Array.isArray(victim.loot) ? victim.loot : [], elite: !!victim.elite, boss: !!victim.boss };
    let items = null;
    try { items = I.lootFor(td, levelOf(victim)); } catch (e) { report(e, 'Items.lootFor'); return null; }
    const gold = Math.max(0, Math.round(num(items && items.gold, 0)));
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!list.length && gold <= 0) return null;
    const p = posOf(victim); if (!p) return null;
    const y = groundYAt(p.x, p.z, num(p.y));
    const bag = {
      id: G.uid(), kind: 'chest', subkind: 'lootbag', name: 'Loot', level: levelOf(victim),
      pos: new V3(p.x, y, p.z), vel: new V3(0, 0, 0), yaw: num(victim.yaw, 0), radius: 0.35, height: 0.5,
      alive: true, dead: false, loot: list, gold: gold, owner: forPlayer ? forPlayer.id : null, from: victim.name || '',
      born: now(), expires: now() + LOOT_LIFE, interact: { label: 'Loot', range: 2.5, fn: lootInteract }, fx: null, mesh: null, prop: null,
    };
    G.addEntity(bag);
    lootBags.push(bag);
    if (nearPlayer(bag, 200)) { const o = fxReset(); o.color = rarityHexOf(list); bag.fx = fx('loot_glow', bag.pos, o); }
    attachLootMesh(bag);
    G.emit('lootDropped', bag);
    return bag;
  }
  function removeBag(bag) {
    if (!bag) return;
    stopFx(bag.fx); bag.fx = null;
    detachLootMesh(bag);
    bag.alive = false; bag.dead = true;
    const i = lootBags.indexOf(bag); if (i >= 0) lootBags.splice(i, 1);
    G.removeEntity(bag);
  }
  function lootBag(bag, ent) {
    ent = ent || player();
    if (!bag || !ent || !isAlive(ent) || bag.subkind !== 'lootbag') return false;
    const I = G.Items;
    const list = bag.loot || (bag.loot = []);
    const taken = []; let full = false;
    for (let i = 0; i < list.length;) {
      const inst = list[i];
      let ok = false;
      if (I && typeof I.addToInventory === 'function') { try { ok = !!I.addToInventory(ent, inst, true); } catch (e) { report(e, 'Items.addToInventory'); ok = false; } }
      if (ok) { taken.push(inst); list.splice(i, 1); } else { full = true; i++; }
    }
    let gold = 0;
    if (bag.gold > 0) { gold = bag.gold; bag.gold = 0; Progress.addGold(gold, { silent: true }); }
    if (taken.length || gold > 0) {
      counters.loot++;
      sfx('loot', ent, 1, 1);
      const U = ui();
      if (U && typeof U.showLoot === 'function') { try { U.showLoot(taken, gold); } catch (e) { report(e, 'UI.showLoot'); } }
      for (let i = 0; i < taken.length; i++) {
        const v = itemView(taken[i]); const cnt = num(taken[i].count, 1);
        chat('You loot: ' + (v ? v.name : taken[i].tid) + (cnt > 1 ? ' ×' + cnt : '') + '.', 'system');
      }
      if (gold > 0) chat('You receive ' + fmtMoney(gold) + '.', 'system');
      G.emit('lootTaken', { items: taken, gold: gold, bag: bag });
    }
    if (full) {
      const t = now();
      if (t - num(bag._fullWarn, -10) > 2) { bag._fullWarn = t; notify('Your inventory is full', 'warning'); sfx('ui_error', null, 0.6, 1); }
    }
    if (!list.length && bag.gold <= 0) removeBag(bag);
    return taken.length > 0 || gold > 0;
  }
  function autoLootEnabled() { const s = G.state.settings; return !(s && s.autoLoot === false); }
  function tryAutoLoot() {
    const p = player();
    if (!p || !isAlive(p) || !p.pos || !lootBags.length || !autoLootEnabled()) return false;
    let any = false;
    for (let i = lootBags.length - 1; i >= 0; i--) {
      const b = lootBags[i]; if (!b || !b.pos) continue;
      const dx = b.pos.x - p.pos.x, dz = b.pos.z - p.pos.z, dy = b.pos.y - p.pos.y;
      if (dx * dx + dz * dz <= AUTO_LOOT_RANGE * AUTO_LOOT_RANGE && Math.abs(dy) < 2.5) { if (lootBag(b, p)) any = true; }
    }
    return any;
  }
  function updateLootBags(t) {
    for (let i = lootBags.length - 1; i >= 0; i--) { const b = lootBags[i]; if (!b || t > num(b.expires, 0)) removeBag(b); }
  }

  function kill(ent, killer) {
    if (!ent || ent.dead === true) return false;
    const st = G.state; const stats = statsObj(); const t = now();
    if (isPlayer(ent) && st.godMode) { ent.morale = Math.max(1, num(ent.morale, 1)); return false; }
    ent.alive = false; ent.dead = true; ent.deathTime = t; ent.morale = 0;
    ent.autoAttack = false; ent.target = null;
    cancelCast(ent, null);
    clearEffects(ent);
    if (ent.knockback && typeof ent.knockback === 'object') { ent.knockback.x = 0; ent.knockback.y = 0; ent.knockback.z = 0; }
    clearThreat(ent);
    playAnim(ent, 'death', true);
    counters.kills++;
    const fam = familyOf(ent);
    const boss = isBoss(ent), elite = isElite(ent);
    sfx(DEATH_SFX[fam] || 'death', ent, 1, isPlayer(ent) ? 0.9 : (boss ? 0.8 : 1));
    if (nearPlayer(ent, 150)) { const o = fxReset(); o.scale = boss ? 2 : elite ? 1.4 : 1; fx('death_puff', posOf(ent), o); }
    const credit = creditFor(killer);
    G.emit('entityKilled', { victim: ent, killer: killer || null });
    if (ent.kind === 'monster') {
      if (credit) {
        stats.kills += 1;
        if (fam) stats.killsByFamily[fam] = num(stats.killsByFamily[fam], 0) + 1;
        chat('You have defeated ' + nameOf(ent) + '.', 'combat');
        const xpApi = G.Data && G.Data.xp;
        const xp = (xpApi && typeof xpApi.killXP === 'function') ? Math.round(num(xpApi.killXP(levelOf(ent), levelOf(credit), boss ? 4 : elite ? 1.5 : 1), 0)) : 0;
        if (xp > 0) Progress.addXP(xp, EMPTY);
        const hk = credit.stats ? num(credit.stats.healOnKillPct, 0) : 0;
        if (hk > 0 && isAlive(credit) && credit.stats) heal(credit, credit, credit.stats.maxMorale * hk / 100, _hotOpts);
        if (boss) { notifyBig(nameOf(ent) + ' defeated', 'A great foe of the Free Peoples is no more'); sfx('achievement', null, 1, 1); }
        dropLoot(ent, credit);
        const Q = G.Quests;
        if (Q && typeof Q.onKill === 'function') { try { Q.onKill(ent.typeId || (typeDataOf(ent) && typeDataOf(ent).id) || null, ent); } catch (e) { report(e, 'Quests.onKill'); } }
        Progress.checkTitles();
      }
    } else if (isPlayer(ent)) {
      stats.deaths += 1;
      combatUntil = 0; bossFight = false;
      dismountPlayer(ent);
      chat('You have been defeated' + (killer ? ' by ' + nameOf(killer) : '') + '.', 'system');
      G.emit('playerDeath');
      const U = ui(); const ds = U && (U.deathScreen || U.DeathScreen);
      if (ds && typeof ds.show === 'function') { try { ds.show(); } catch (e) { report(e, 'UI.deathScreen.show'); } }
      const A = G.Audio;
      if (A && typeof A.music === 'function') { try { A.music('death'); } catch (e) { report(e, 'Audio.music'); } musicMode = 'death'; }
    }
    return true;
  }
  function revive(ent, moraleFrac) {
    if (!ent) return false;
    ent.alive = true; ent.dead = false; ent.deathTime = 0;
    ent.casting = null; ent.autoAttack = false; ent.target = null; ent.nextSwing = 0; ent.gcdReady = 0;
    if (Array.isArray(ent.effects)) ent.effects.length = 0;
    clearThreat(ent);
    if (ent.knockback && typeof ent.knockback === 'object') { ent.knockback.x = 0; ent.knockback.y = 0; ent.knockback.z = 0; }
    recompute(ent);
    const frac = (typeof moraleFrac === 'number') ? Math.max(0.01, Math.min(1, moraleFrac)) : 0.1;
    const s = ent.stats || {};
    ent.morale = Math.max(1, Math.round(num(s.maxMorale, num(ent.morale, 1)) * frac));
    ent.power = Math.max(0, Math.round(num(s.maxPower, num(ent.power, 0)) * Math.max(frac, 0.5)));
    ent.lastCombat = -1e9;
    if (isPlayer(ent)) { combatUntil = 0; bossFight = false; musicMode = null; }
    playAnim(ent, 'idle', true);
    G.emit('effectsChanged', ent);
    return true;
  }
  function fallDamage(ent, fallSpeed) {
    const s = num(fallSpeed, 0);
    if (!ent || !isAlive(ent) || s < 14) return 0;
    if (isPlayer(ent) && G.state.godMode) return 0;
    const max = ent.stats ? num(ent.stats.maxMorale, 100) : 100;
    const mult = ent.stats ? num(ent.stats.fallDamageMult, 1) : 1;
    const amt = Math.round(max * Math.min(1.5, (s - 14) / 22) * mult);
    if (amt <= 0) return 0;
    _fallOpts.sfx = 'land';
    return damage(null, ent, amt, 'fall', _fallOpts);
  }
  const _fallOpts = { crit: false, ability: null, kind: 'fall', threat: 1, sfx: 'land', fxKind: null, raw: true, noFx: false, noAnim: false, small: false, silent: false, dot: false };

  // ------------------------------------------------------------------------------------------------ per-frame update
  let _threatAcc = 0;
  function regen(e, dt, t) {
    const s = e.stats; if (!s) return;
    const inC = (t - num(e.lastCombat, -1e9)) < COMBAT_TIMEOUT;
    const maxM = num(s.maxMorale, 0);
    if (maxM > 0 && typeof e.morale === 'number' && e.morale < maxM) {
      const r = inC ? num(s.moraleRegenCombat, 0) : num(s.moraleRegen, 0);
      if (r > 0) e.morale = Math.min(maxM, e.morale + r * dt);
    }
    const maxP = num(s.maxPower, 0);
    if (maxP > 0 && typeof e.power === 'number' && e.power < maxP) {
      const r = inC ? num(s.powerRegenCombat, 0) : num(s.powerRegen, 0);
      if (r > 0) e.power = Math.min(maxP, e.power + r * dt);
    }
  }
  function update(dt) {
    dt = num(dt, 0); if (dt <= 0) return;
    const st = G.state; const P = st.player; const ents = st.entities; const t = now();
    const px = (P && P.pos) ? P.pos.x : 0, pz = (P && P.pos) ? P.pos.z : 0;
    _threatAcc += dt;
    const doThreat = _threatAcc >= 1; const threatDt = _threatAcc; if (doThreat) _threatAcc = 0;
    const far2 = FAR_DIST * FAR_DIST, regen2 = REGEN_RADIUS * REGEN_RADIUS;
    for (let i = 0; i < ents.length; i++) {
      const e = ents[i];
      if (!e || !e.pos) continue;
      const hasEff = !!(e.effects && e.effects.length);
      if (!e.stats && !hasEff && !e.casting && !e.threat) continue;
      const dx = e.pos.x - px, dz = e.pos.z - pz; const d2 = dx * dx + dz * dz;
      let edt = dt;
      if (d2 > far2 && e !== P) {
        e._cbAcc = num(e._cbAcc, 0) + dt;
        if (e._cbAcc < FAR_TICK) continue;
        edt = e._cbAcc; e._cbAcc = 0;
      }
      if (e.casting) updateCast(e);
      if (hasEff) tickEffects(e, edt);
      if (isAlive(e) && e.stats && (d2 <= regen2 || e === P)) regen(e, edt, t);
      if (doThreat && e.threat && d2 <= far2 * 4) decayThreat(e, threatDt);
    }
    if (P) updateAutoAttack(P, t);
    if (lootBags.length) updateLootBags(t);
    updateCombatState();
  }

  // ------------------------------------------------------------------------------------------------ progression
  function ensureAbilities(p) {
    if (!p) return null;
    if (!(p.abilities instanceof Set)) {
      const src = p.abilities;
      p.abilities = new Set(Array.isArray(src) ? src : (src && typeof src === 'object') ? Object.keys(src) : []);
    }
    return p.abilities;
  }
  function ensurePlayerShape(p) {
    if (!p || typeof p !== 'object') return p;
    ensureAbilities(p);
    if (!Array.isArray(p.hotbar)) p.hotbar = new Array(HOTBAR_SIZE).fill(null);
    else while (p.hotbar.length < HOTBAR_SIZE) p.hotbar.push(null);
    if (!p.cooldowns || typeof p.cooldowns !== 'object') p.cooldowns = {};
    if (!Array.isArray(p.effects)) p.effects = [];
    if (!p.threat || typeof p.threat !== 'object') p.threat = {};
    if (typeof p.xp !== 'number' || !isFinite(p.xp)) p.xp = 0;
    if (typeof p.gold !== 'number' || !isFinite(p.gold)) p.gold = 0;
    if (!Array.isArray(p.titles)) p.titles = [];
    if (typeof p.level !== 'number' || !isFinite(p.level)) p.level = 1;
    if (typeof p.gcdReady !== 'number') p.gcdReady = 0;
    if (typeof p.nextSwing !== 'number') p.nextSwing = 0;
    return p;
  }
  function hasAbility(p, id) { return !!p && abilitiesHas(p.abilities, id); }
  function firstFreeHotbar(p) {
    p = p || player(); if (!p) return -1;
    ensurePlayerShape(p);
    for (let i = 0; i < HOTBAR_SIZE; i++) if (!p.hotbar[i]) return i;
    return -1;
  }
  function hotbarSlotOf(id, p) {
    p = p || player(); if (!p || !Array.isArray(p.hotbar) || !id) return -1;
    for (let i = 0; i < p.hotbar.length; i++) if (p.hotbar[i] === id) return i;
    return -1;
  }
  function setHotbar(slot, abilityId) {
    const p = player(); if (!p) return false;
    ensurePlayerShape(p);
    slot = slot | 0;
    if (slot < 0 || slot >= HOTBAR_SIZE) return false;
    if (abilityId) {
      if (!resolveAbility(abilityId)) return false;
      const prev = hotbarSlotOf(abilityId, p);
      if (prev >= 0 && prev !== slot) p.hotbar[prev] = p.hotbar[slot] || null;   // swap so drag-and-drop feels natural
      p.hotbar[slot] = abilityId;
    } else p.hotbar[slot] = null;
    G.emit('hotbarChanged', slot);
    return true;
  }
  function xpApi() { return (G.Data && G.Data.xp) ? G.Data.xp : null; }
  function xpForLevel(L) { const x = xpApi(); return (x && typeof x.forLevel === 'function') ? num(x.forLevel(L), 0) : 0; }
  function xpToNext() {
    const p = player(); if (!p) return 0;
    if (levelOf(p) >= LEVEL_CAP) return 0;
    return Math.max(0, xpForLevel(levelOf(p) + 1) - num(p.xp, 0));
  }
  function xpProgress() {
    const p = player(); if (!p) return 0;
    const L = levelOf(p);
    if (L >= LEVEL_CAP) return 1;
    const a = xpForLevel(L), b = xpForLevel(L + 1);
    if (!(b > a)) return 0;
    return Math.max(0, Math.min(1, (num(p.xp, 0) - a) / (b - a)));
  }
  function addXP(n, opts) {
    const p = player(); if (!p) return 0;
    ensurePlayerShape(p);
    n = Math.round(num(n, 0)); if (n <= 0) return 0;
    opts = opts || EMPTY;
    const cap = xpForLevel(LEVEL_CAP);
    if (p.level >= LEVEL_CAP) { if (cap > 0 && p.xp < cap) p.xp = cap; return 0; }
    const before = num(p.xp, 0);
    p.xp = cap > 0 ? Math.min(cap, before + n) : before + n;
    const gained = p.xp - before;
    if (gained <= 0) return 0;
    if (!opts.silent) chat('You gain ' + fmtNum(gained) + ' experience.', 'combat');
    G.emit('xpGained', gained);
    let guard = 0;
    while (p.level < LEVEL_CAP && p.xp >= xpForLevel(p.level + 1) && guard++ < LEVEL_CAP) { if (!levelUp()) break; }
    return gained;
  }
  function levelUp() {
    const p = player(); if (!p) return false;
    ensurePlayerShape(p);
    if (p.level >= LEVEL_CAP) return false;
    p.level += 1;
    const L = p.level;
    const need = xpForLevel(L); if (p.xp < need) p.xp = need;
    recompute(p);
    if (p.stats) { p.morale = num(p.stats.maxMorale, p.morale); p.power = num(p.stats.maxPower, p.power); }
    if (p.pos) { const o = fxReset(); o.scale = 1; fx('levelup', p.pos, o); }
    sfx('level_up', null, 1, 1);
    const unlocked = [];
    const list = abilitiesFor(p.cls);
    for (let i = 0; i < list.length; i++) if (list[i].level === L) unlocked.push(list[i]);
    let trait = null;
    const traits = G.Data && G.Data.classTraits && G.Data.classTraits[p.cls];
    if (Array.isArray(traits)) for (let i = 0; i < traits.length; i++) if (traits[i] && traits[i].level === L) { trait = traits[i]; break; }
    let sub = '';
    if (unlocked.length) sub = 'New ' + (unlocked.length > 1 ? 'abilities' : 'ability') + ': ' + unlocked.map(function (a) { return a.name; }).join(', ') + ' — visit a trainer (K)';
    if (trait) sub += (sub ? ' · ' : '') + 'Trait gained: ' + trait.name;
    notifyBig('Level ' + L, sub);
    chat('You have reached level ' + L + '!', 'system');
    for (let i = 0; i < unlocked.length; i++) chat('New ability available: ' + unlocked[i].name + (unlocked[i].cost > 0 ? ' (train for ' + fmtMoney(unlocked[i].cost) + ')' : '') + '.', 'system');
    if (trait) chat('Class trait gained: ' + trait.name + '.', 'system');
    G.emit('playerLevelUp', L);
    checkTitles();
    return true;
  }
  function setLevel(L) {
    const p = player(); if (!p) return false;
    ensurePlayerShape(p);
    L = Math.max(1, Math.min(LEVEL_CAP, Math.round(num(L, 1))));
    p.level = L; p.xp = xpForLevel(L);
    recompute(p);
    if (p.stats) { p.morale = num(p.stats.maxMorale, p.morale); p.power = num(p.stats.maxPower, p.power); }
    G.emit('playerLevelUp', L);
    checkTitles();
    return true;
  }
  function addGold(copper, opts) {
    const p = player(); if (!p) return 0;
    ensurePlayerShape(p);
    opts = opts || EMPTY;
    const c = Math.round(num(copper, 0)); if (!c) return p.gold;
    p.gold = Math.max(0, p.gold + c);
    if (c > 0 && !opts.silent) { sfx('coin', null, 0.8, 1); chat('You receive ' + fmtMoney(c) + '.', 'system'); }
    G.emit('goldChanged', p.gold);
    return p.gold;
  }
  function spendGold(copper) {
    const p = player(); if (!p) return false;
    ensurePlayerShape(p);
    const c = Math.round(num(copper, 0));
    if (c <= 0) return true;
    if (p.gold < c) { notify('You do not have enough coin', 'warning'); sfx('ui_error', null, 0.6, 1); return false; }
    p.gold -= c;
    sfx('coin', null, 0.8, 1);
    G.emit('goldChanged', p.gold);
    return true;
  }
  function trainCostOf(a) { const D = G.Data; if (D && typeof D.trainCost === 'function') return num(D.trainCost(a), 0); return num(a && a.cost, 0); }
  const _trainRes = { ok: false, reason: '', cost: 0 };
  function canTrain(id) {
    const r = _trainRes; r.ok = false; r.reason = ''; r.cost = 0;
    const p = player(); const a = resolveAbility(id);
    if (!p) { r.reason = 'No character'; return r; }
    if (!a || a.cls === 'monster') { r.reason = 'Unknown ability'; return r; }
    ensurePlayerShape(p);
    if (a.cls !== p.cls) { r.reason = 'Not an ability of your class'; return r; }
    if (p.abilities.has(a.id)) { r.reason = 'Already trained'; return r; }
    if (levelOf(p) < num(a.level, 1)) { r.reason = 'Requires level ' + a.level; return r; }
    r.cost = trainCostOf(a);
    if (p.gold < r.cost) { r.reason = 'Not enough coin (costs ' + fmtMoney(r.cost) + ')'; return r; }
    r.ok = true; return r;
  }
  function trainAbility(id) {
    const chk = canTrain(id);
    const out = { ok: chk.ok, reason: chk.reason };
    if (!chk.ok) { if (chk.reason) { notify(chk.reason, 'warning'); sfx('ui_error', null, 0.6, 1); } return out; }
    const p = player(); const a = resolveAbility(id);
    if (chk.cost > 0 && !spendGold(chk.cost)) { out.ok = false; out.reason = 'Not enough coin'; return out; }
    p.abilities.add(a.id);
    if (hotbarSlotOf(a.id, p) < 0) { const slot = firstFreeHotbar(p); if (slot >= 0) setHotbar(slot, a.id); }
    notify('You have learned ' + a.name, 'level');
    chat('You have learned the ability ' + a.name + '.', 'system');
    sfx('achievement', null, 0.9, 1);
    G.emit('abilityTrained', a.id);
    return out;
  }
  function untrainedAvailable() {
    const p = player(); if (!p) return [];
    ensurePlayerShape(p);
    const out = [], list = abilitiesFor(p.cls), L = levelOf(p);
    for (let i = 0; i < list.length; i++) { const a = list[i]; if (a.level <= L && !p.abilities.has(a.id)) out.push(a); }
    return out;
  }
  function grantStarterAbilities(p) {
    p = p || player(); if (!p) return 0;
    ensurePlayerShape(p);
    const list = abilitiesFor(p.cls); let n = 0;
    for (let i = 0; i < list.length; i++) {
      const a = list[i]; if (a.level > 1) continue;
      if (!p.abilities.has(a.id)) { p.abilities.add(a.id); n++; }
      if (hotbarSlotOf(a.id, p) < 0) { const slot = firstFreeHotbar(p); if (slot >= 0) p.hotbar[slot] = a.id; }
    }
    if (n) G.emit('hotbarChanged', -1);
    return n;
  }
  function awardTitle(id) {
    const p = player(); if (!p || !id) return false;
    ensurePlayerShape(p);
    if (p.titles.indexOf(id) >= 0) return false;
    const D = G.Data; let name = id;
    if (D && typeof D.titleName === 'function') { try { name = D.titleName(id, p.gender) || id; } catch (e) { /* ignore */ } }
    p.titles.push(id);
    if (!p.activeTitle) p.activeTitle = id;
    notify('Title earned: ' + name, 'level');
    chat('You have earned the title "' + name + '".', 'system');
    sfx('achievement', null, 1, 1);
    G.emit('titleEarned', id);
    return true;
  }
  function checkTitles() {
    const p = player(); const D = G.Data;
    if (!p || !D || !Array.isArray(D.titles)) return 0;
    ensurePlayerShape(p);
    const st = statsObj(); let n = 0;
    for (let i = 0; i < D.titles.length; i++) {
      const t = D.titles[i]; if (!t || !t.req || p.titles.indexOf(t.id) >= 0) continue;
      const q = t.req; let ok = false;
      if (t.kind === 'level' && typeof q.level === 'number') ok = levelOf(p) >= q.level;
      else if (t.kind === 'deed') {
        if (typeof q.family === 'string' && typeof q.count === 'number') ok = num(st.killsByFamily[q.family], 0) >= q.count;
        else if (typeof q.kills === 'number') ok = num(st.kills, 0) >= q.kills;
        else if (typeof q.deaths === 'number' && typeof q.level === 'number') ok = levelOf(p) >= q.level && num(st.deaths, 0) <= q.deaths;
        else if (typeof q.mounts === 'number') ok = Array.isArray(p.mounts) && p.mounts.length >= q.mounts;
      }
      if (ok && awardTitle(t.id)) n++;
    }
    return n;
  }

  // ------------------------------------------------------------------------------------------------ balance curves
  // Measured with tools/scratch/_balance.js: sustained DPS (full rotation + auto-attack) of a hero wearing uncommon
  // gear in every slot, median over six classes: L10 ≈ 320, L40 ≈ 1280, L80 ≈ 3020 → 50 + 24L + 0.16L².
  // Hero max morale in that gear ≈ 100 + 190L, physical mitigation sits at the 60 % cap from L5 on.
  function heroDPSEstimate(level) { const L = Math.max(1, Math.min(120, num(level, 1))); return 50 + 24 * L + 0.16 * L * L; }
  function suggestMonsterStats(level, opts) {
    opts = opts || EMPTY;
    const L = Math.max(1, Math.min(120, Math.round(num(level, 1))));
    const heroMorale = 100 + 190 * L;
    let morale = heroDPSEstimate(L) * 6;                 // a same-level 1v1 lasts ≈ 6 s (4–8 s across classes/gear)
    let dmg = 0.2625 * heroMorale;                       // 3.3 swings in 6 s at 60 % mitigation ≈ 35 % of the hero's morale
    let armour = 20 + 8 * L;                             // ≈ 17 % physical mitigation at every level
    if (opts.boss) { morale *= 8; dmg *= 2; armour *= 1.5; }
    else if (opts.elite) { morale *= 2.5; dmg *= 1.5; armour *= 1.25; }
    const mult = num(opts.mult, 1) || 1;
    return { morale: Math.round(morale * mult), dmg: Math.round(dmg * mult), armour: Math.round(armour), power: 50 + 10 * L, attackSpeed: 1.8 };
  }

  // ------------------------------------------------------------------------------------------------ namespaces
  const Combat = {
    useAbility: useAbility, basicAttack: basicAttack, damage: damage, heal: heal,
    addEffect: addEffect, removeEffect: removeEffect, clearEffects: clearEffects, hasEffect: hasEffect, getEffect: getEffect,
    kill: kill, update: update,
    isHostile: isHostile, isFriendly: isFriendly, canSee: canSee, distance: distance, distanceXZ: distanceXZ, inRange: inRange,
    facing: facing, faceTarget: faceTarget, headPos: headPos, chestPos: chestPos, handPos: handPos,
    canUse: canUse, abilityReady: abilityReady, cooldownLeft: cooldownLeft, cooldownFrac: cooldownFrac,
    cancelCast: cancelCast, interrupt: interrupt, isCasting: isCasting, castProgress: castProgress,
    hostilesNear: hostilesNear, friendliesNear: friendliesNear, nearestHostile: nearestHostile,
    addThreat: addThreat, threatOf: threatOf, topThreat: topThreat, clearThreat: clearThreat, taunt: taunt,
    tryAutoLoot: tryAutoLoot, lootBag: lootBag, dropLoot: dropLoot, lootBags: lootBags, autoLootEnabled: autoLootEnabled,
    revive: revive, fallDamage: fallDamage, markCombat: markCombat, inCombatFor: inCombatFor,
    basicAttackDamage: basicAttackDamage, weaponSpeed: weaponSpeed, resolveAbility: resolveAbility,
    suggestMonsterStats: suggestMonsterStats, heroDPSEstimate: heroDPSEstimate,
    dtypeColor: function (d) { return DTYPE_COLOR[d] || COLOR_DEALT; }, isPhysical: function (d) { return !!PHYSICAL[d]; },
    lastAbility: lastAbility, lastHit: lastHit, lastError: '',
    stats: function () { return counters; },
    GCD: GCD, COMBAT_TIMEOUT: COMBAT_TIMEOUT, LOOT_LIFE: LOOT_LIFE, AUTO_LOOT_RANGE: AUTO_LOOT_RANGE, CRIT_MULT: CRIT_MULT,
  };
  const Progress = {
    addXP: addXP, levelUp: levelUp, setLevel: setLevel, addGold: addGold, spendGold: spendGold,
    trainAbility: trainAbility, canTrain: canTrain, untrainedAvailable: untrainedAvailable,
    setHotbar: setHotbar, hotbarSlotOf: hotbarSlotOf, firstFreeHotbar: firstFreeHotbar,
    xpToNext: xpToNext, xpProgress: xpProgress, grantStarterAbilities: grantStarterAbilities,
    ensurePlayerShape: ensurePlayerShape, awardTitle: awardTitle, checkTitles: checkTitles, hasAbility: hasAbility,
    LEVEL_CAP: LEVEL_CAP, HOTBAR_SIZE: HOTBAR_SIZE,
  };
  G.Combat = Combat;
  G.Progress = Progress;

  // ------------------------------------------------------------------------------------------------ lifecycle hooks
  function resetState() {
    for (let i = lootBags.length - 1; i >= 0; i--) removeBag(lootBags[i]);
    combatUntil = 0; bossFight = false; musicMode = null; _threatAcc = 0; _sceneRef = null;
    _lastFailReason = ''; _lastFailAt = -10; _lastHurtAt = -10;
    if (G.state) G.state.inCombat = false;
  }
  G.on('gameStart', function () { resetState(); const p = player(); if (p) { ensurePlayerShape(p); if (!p.abilities.size) grantStarterAbilities(p); } });
  G.on('load', function () { const p = player(); if (p) ensurePlayerShape(p); });
  G.on('playerRespawn', function () { combatUntil = 0; bossFight = false; musicMode = null; const p = player(); if (p && !isAlive(p)) revive(p, 0.1); });
})();
