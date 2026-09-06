/* ==== 04_data_abilities.js — every class's abilities (13 per class × 10 classes = 130, LOTRO-flavoured) plus a small
   set of elite/boss monster abilities in the same schema. Pure data + pure functions; no engine references at top level.

   Public API (all on G.Data):
     abilities                      map id → ability. Contains the 130 class abilities AND the monster abilities
                                    (monster ones carry cls:'monster', monster:true) so G.Combat.useAbility(ent, id) can
                                    resolve any id from one map.
     abilitiesFor(clsId)            → array sorted by unlock level (definition order within a level). Fresh copy each call.
                                    abilitiesFor('monster') returns the monster set.
     abilityById(id)                → ability | null
     abilityDesc(abilityOrId, ent?) → plain-text description. With an entity (needs ent.stats) the live numbers are
                                    filled in; without one the multipliers are shown ("1.5×").
     abilityTooltipHTML(a, ent?)    → HTML using the #tooltip classes from 00_theme.css (.tt-name/.tt-line/.tt-desc/.tt-req).
     abilityDamage(a, ent, effect?) → {min, max, avg, dtype, mastery} for a damage effect (±15 % variance), or null.
     abilityHeal(a, ent, effect?)   → number (average heal) for a heal effect, 0 if none.
     abilityDot(a, ent, effect?)    → {perTick, total, ticks} for a dot/hot effect, or null.
     abilityMastery(a)              → 'physMastery' | 'tactMastery'  (kind melee/ranged → phys, else tact; `a.mastery` overrides)
     trainCost(a)                   → copper (0 at level 1; G.Data.xp.abilityCost(level) if 02 provides it, else fallback curve)
     abilityKeyDefaults(clsId)      → ordered ability ids that fill hotbar slots as they are trained (level order)
     monsterAbilities               map id → ability (subset of `abilities`)
     monsterAbilitiesFor(family)    → array of monster abilities for a monster family ('troll', 'wight', ...)
     ABILITY_UNLOCK_LEVELS, ABILITY_KINDS, ABILITY_ANIMS, ABILITY_VFX, ABILITY_SFX, ABILITY_DTYPES, ABILITY_EFFECT_TYPES,
     ABILITY_STAT_NAMES             the allowed sets (frozen arrays / display-name map) for validation & UI.

   Ability schema — exactly SPEC §4.5 plus these optional hints (safe to ignore):
     target:   'enemy' | 'self' | 'ally' | 'party'   who the ability is used on. An effect with `aoe: radius` splashes
               around the target when target==='enemy', or around the caster when target==='self'/'party'.
     threat:   number   threat multiplier for tank skills (taunt kinds use ≥ 4 = force the target onto the user).
     mastery:  'phys'|'tact'   overrides the kind-derived mastery (used by physical classes' self-heals).
     monster:  true, family: 'troll' …   on monster abilities only.
     descTemplate / desc:  `desc` is the tooltip template with {dmg} {dmg2} {heal} {hot} {dot} {dotTotal} {tick} {duration}
               {duration2} {durationText} {amount} {amount2} {amount3} {stat} {stun} {root} {slow} {slowDuration} {force}
               {radius} {range} {power} {cooldown} {cast} {level} {name} placeholders; abilityDesc() fills them.
               `descPlain` is the same text pre-filled with multipliers for UIs that never pass an entity.
     tooltip(ent) → html   present on every ability (wraps abilityTooltipHTML).
   Effect semantics used by the numbers here (documented so 21_combat can match the tooltips):
     damage: mult × mastery/4 + weaponAvg (mainhand, or ranged weapon for kind 'ranged'; monsters use their type dmg).
     dot/hot: `mult` is PER TICK (per-tick = mult × mastery/4, no weapon component), `tick` seconds apart, for `duration` s.
     heal:  mult × mastery/4 (+ flat `amount` if present); mastery per abilityMastery(a).
     buff/debuff: `pct` is a percentage change of `stat` (negative = reduction) for `duration` s; `target` 'self'|'target'|'party'.
     stun/root: `duration` s; slow: `pct` speed reduction for `duration` s; knockback: `force` metres/s.
     Stances are buffs with a 1800 s duration (re-applied by re-casting; cooldown 5 s).
   Private helpers (prefixed _): _fmtMoney (fallback for G.fmtMoney), _esc (html escape), _monsterTypeDmg (world lookup cache).
==== */
(function () {
  'use strict';
  const G = window.G;
  G.Data = G.Data || {};

  // ------------------------------------------------------------------------------------------------------------------
  // Allowed sets (SPEC §4.5, §5.5 anims, §5.7 FX kinds, §5.9 SFX names)
  // ------------------------------------------------------------------------------------------------------------------
  const UNLOCK_LEVELS = Object.freeze([1, 1, 4, 8, 12, 16, 20, 26, 32, 40, 50, 60, 70]);
  const KINDS = Object.freeze(['melee', 'ranged', 'tactical', 'heal', 'buff', 'debuff', 'aoe', 'taunt', 'summon', 'stance']);
  const ANIMS = Object.freeze(['slash', 'thrust', 'spin', 'cast', 'shoot', 'shout', 'block']);
  const VFX = Object.freeze(['hit', 'crit', 'slash', 'thrust', 'spin', 'arrow', 'bolt', 'fire', 'frost', 'light', 'lightning',
    'heal', 'buff', 'levelup', 'dust', 'splash', 'bubbles', 'smoke', 'fire_static', 'torch', 'sparkle', 'blood', 'quest_beacon',
    'footstep', 'questmark_glow', 'death_puff', 'water_ring', 'snow_puff']);
  const SFX = Object.freeze(['ui_click', 'ui_open', 'ui_close', 'ui_error', 'sword_swing', 'sword_hit', 'axe_hit', 'blunt_hit',
    'bow_shoot', 'arrow_hit', 'spell_cast', 'spell_hit', 'fire_hit', 'frost_hit', 'light_hit', 'heal', 'buff', 'footstep_grass',
    'footstep_stone', 'footstep_wood', 'footstep_water', 'footstep_snow', 'jump', 'land', 'roll', 'hurt', 'death', 'level_up',
    'quest_accept', 'quest_progress', 'quest_complete', 'coin', 'loot', 'equip', 'door_open', 'door_close', 'horse_mount',
    'horse_gallop', 'horse_neigh', 'fish_cast', 'fish_bite', 'fish_catch', 'fish_fail', 'boat_creak', 'boat_bell', 'wolf_howl',
    'boar_grunt', 'bear_roar', 'spider_hiss', 'orc_growl', 'troll_roar', 'wight_moan', 'thunder', 'rain_loop', 'wind_loop',
    'birds_loop', 'crickets_loop', 'waves_loop', 'fire_loop', 'splash', 'swim', 'eat', 'drink', 'chat_ping', 'admin_open',
    'achievement']);
  const DTYPES = Object.freeze(['common', 'fire', 'light', 'frost', 'lightning', 'beleriand']);
  const EFFECT_TYPES = Object.freeze(['damage', 'heal', 'buff', 'debuff', 'dot', 'hot', 'stun', 'root', 'slow', 'knockback', 'pet']);
  const TARGETS = Object.freeze(['enemy', 'self', 'ally', 'party']);
  const STAT_NAMES = Object.freeze({
    might: 'Might', agility: 'Agility', vitality: 'Vitality', will: 'Will', fate: 'Fate',
    maxMorale: 'maximum Morale', maxPower: 'maximum Power', armour: 'Armour',
    physMastery: 'Physical Mastery', tactMastery: 'Tactical Mastery', crit: 'Critical Rating', finesse: 'Finesse',
    block: 'Block Rating', parry: 'Parry Rating', evade: 'Evade Rating', resist: 'Resistance',
    moraleRegen: 'Morale regeneration', powerRegen: 'Power regeneration', speed: 'movement speed',
  });
  const DTYPE_NAMES = Object.freeze({ common: 'Common', fire: 'Fire', light: 'Light', frost: 'Frost', lightning: 'Lightning', beleriand: 'Beleriand' });
  const KIND_NAMES = Object.freeze({ melee: 'Melee', ranged: 'Ranged', tactical: 'Tactical', heal: 'Healing', buff: 'Buff', debuff: 'Debuff',
    aoe: 'Area', taunt: 'Taunt', summon: 'Summon', stance: 'Stance' });

  const MELEE = 3.2;   // G.C.MELEE_RANGE
  const RANGED = 30;   // G.C.RANGED_RANGE
  const SHOUT = 10;    // shouts / tricks / taunts

  // Power cost curve: base by unlock level, scaled per ability, clamped to the 10–60 band.
  const POWER_BASE = { 1: 10, 4: 13, 8: 16, 12: 19, 16: 22, 20: 25, 26: 29, 32: 33, 40: 38, 50: 44, 60: 50, 70: 56 };
  function pw(level, f) {
    const base = POWER_BASE[level] !== undefined ? POWER_BASE[level] : (10 + level * 0.66);
    return Math.max(10, Math.min(60, Math.round(base * (f === undefined ? 1 : f))));
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Effect constructors (keep the data below terse and uniform)
  // ------------------------------------------------------------------------------------------------------------------
  function D(mult, dtype, aoe) { const e = { type: 'damage', mult: mult, dtype: dtype || 'common' }; if (aoe) e.aoe = aoe; return e; }
  function DOT(mult, duration, tick, dtype, aoe) {
    const e = { type: 'dot', mult: mult, duration: duration, tick: tick || 2, dtype: dtype || 'common' }; if (aoe) e.aoe = aoe; return e;
  }
  function HOT(mult, duration, tick, target, aoe) {
    const e = { type: 'hot', mult: mult, duration: duration, tick: tick || 3, target: target || 'self' }; if (aoe) e.aoe = aoe; return e;
  }
  function HEAL(mult, target, aoe) { const e = { type: 'heal', mult: mult, target: target || 'self' }; if (aoe) e.aoe = aoe; return e; }
  function BUFF(stat, pct, duration, target, name) {
    const e = { type: 'buff', stat: stat, pct: pct, duration: duration, target: target || 'self' }; if (name) e.name = name; return e;
  }
  function DEBUFF(stat, pct, duration, target, aoe) {
    const e = { type: 'debuff', stat: stat, pct: pct, duration: duration, target: target || 'target' }; if (aoe) e.aoe = aoe; return e;
  }
  function STUN(duration, aoe) { const e = { type: 'stun', duration: duration }; if (aoe) e.aoe = aoe; return e; }
  function ROOT(duration, aoe) { const e = { type: 'root', duration: duration }; if (aoe) e.aoe = aoe; return e; }
  function SLOW(pct, duration, aoe) { const e = { type: 'slow', pct: pct, duration: duration }; if (aoe) e.aoe = aoe; return e; }
  function KNOCK(force) { return { type: 'knockback', force: force }; }

  // ------------------------------------------------------------------------------------------------------------------
  // Class ability definitions — 13 per class, unlock levels 1,1,4,8,12,16,20,26,32,40,50,60,70 in this order.
  // Fields not given: castTime 0, cooldown 0, gcd true, target derived from kind, power from pw(level, pf).
  // ------------------------------------------------------------------------------------------------------------------
  const CLASS_ABILITIES = {

    // ---------------------------------------------------------------- GUARDIAN (tank, sword & shield) ----------------
    guardian: [
      { id: 'guardian_sting', name: 'Sting', icon: '🗡', level: 1, kind: 'melee', range: MELEE, threat: 1.5,
        effects: [D(1.0)], anim: 'thrust', vfx: 'thrust', sfx: 'sword_hit',
        desc: 'A quick jab that stings your foe and draws its ire. Deals {dmg} Common damage and generates extra threat.' },
      { id: 'guardian_guardians_ward', name: "Guardian's Ward", icon: '🛡', level: 1, kind: 'buff', range: 0, cooldown: 30, pf: 1.2,
        effects: [BUFF('parry', 15, 20), BUFF('block', 15, 20)], anim: 'block', vfx: 'buff', sfx: 'buff',
        desc: 'You raise your guard and watch for every opening. Increases Parry and Block Rating by {amount} for {duration} seconds.' },
      { id: 'guardian_sweeping_cut', name: 'Sweeping Cut', icon: '⚔', level: 4, kind: 'melee', range: MELEE, cooldown: 6, pf: 1.1,
        effects: [D(0.8, 'common', 4)], anim: 'slash', vfx: 'slash', sfx: 'sword_swing',
        desc: 'A wide, sweeping stroke that catches every foe before you. Deals {dmg} Common damage to enemies within {radius} metres of your target.' },
      { id: 'guardian_shield_blow', name: 'Shield-blow', icon: '🛡', level: 8, kind: 'melee', range: MELEE, cooldown: 8, threat: 2,
        effects: [D(1.2), DEBUFF('physMastery', -10, 10)], anim: 'thrust', vfx: 'hit', sfx: 'blunt_hit',
        desc: "You slam your shield into your foe, rattling its teeth and its resolve. Deals {dmg} Common damage and lowers the target's Physical Mastery by {amount} for {duration} seconds." },
      { id: 'guardian_retaliation', name: 'Retaliation', icon: '⚔', level: 12, kind: 'melee', range: MELEE, cooldown: 10,
        effects: [D(1.6)], anim: 'slash', vfx: 'slash', sfx: 'sword_hit',
        desc: 'A heavy counter-stroke with all the weight of your shoulder behind it. Deals {dmg} Common damage.' },
      { id: 'guardian_challenge', name: 'Challenge', icon: '📯', level: 16, kind: 'taunt', range: SHOUT, cooldown: 20, threat: 5, pf: 0.9,
        effects: [DEBUFF('physMastery', -10, 10)], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'A ringing challenge that no foe can ignore. Forces the target to attack you and reduces its Physical Mastery by {amount} for {duration} seconds.' },
      { id: 'guardian_whirling_retaliation', name: 'Whirling Retaliation', icon: '🌀', level: 20, kind: 'melee', target: 'self', range: MELEE, cooldown: 12, pf: 1.1,
        effects: [D(1.0, 'common', 5)], anim: 'spin', vfx: 'spin', sfx: 'sword_swing',
        desc: 'You whirl about with your blade outstretched, striking every foe around you. Deals {dmg} Common damage to all enemies within {radius} metres.' },
      { id: 'guardian_vexing_blow', name: 'Vexing Blow', icon: '💢', level: 26, kind: 'melee', range: MELEE, cooldown: 8,
        effects: [D(0.9), DOT(0.25, 10, 2)], anim: 'slash', vfx: 'slash', sfx: 'sword_hit',
        desc: 'A cunning cut that leaves a wound your foe cannot ignore. Deals {dmg} Common damage and a further {dot} Common damage every {tick} seconds for {duration} seconds.' },
      { id: 'guardian_fray_the_edge', name: 'Fray the Edge', icon: '🔧', level: 32, kind: 'melee', range: MELEE, cooldown: 15,
        effects: [D(0.8), DEBUFF('physMastery', -15, 20)], anim: 'slash', vfx: 'hit', sfx: 'sword_hit',
        desc: "You turn your foe's blade aside, chipping and dulling its edge. Deals {dmg} Common damage and reduces the target's Physical Mastery by {amount} for {duration} seconds." },
      { id: 'guardian_bash', name: 'Bash', icon: '💫', level: 40, kind: 'melee', range: MELEE, cooldown: 30, pf: 1.1,
        effects: [D(0.7), STUN(3)], anim: 'thrust', vfx: 'hit', sfx: 'blunt_hit',
        desc: 'A brutal shield-bash that leaves your foe reeling. Deals {dmg} Common damage and stuns the target for {stun} seconds.' },
      { id: 'guardian_thrill_of_battle', name: 'Thrill of Battle', icon: '💚', level: 50, kind: 'heal', target: 'self', range: 0, cooldown: 60, mastery: 'phys',
        effects: [HEAL(5, 'self'), BUFF('maxMorale', 10, 30)], anim: 'shout', vfx: 'heal', sfx: 'heal',
        desc: 'The joy of battle steels your heart against every hurt. Restores {heal} Morale and increases your maximum Morale by {amount} for {duration} seconds.' },
      { id: 'guardian_litany_of_defiance', name: 'Litany of Defiance', icon: '✨', level: 60, kind: 'buff', range: 0, cooldown: 90, threat: 3,
        effects: [BUFF('armour', 25, 20), BUFF('block', 20, 20)], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'You recite the oath of the Guardians and dare the darkness to break you. Increases Armour by {amount} and Block Rating by {amount2} for {duration} seconds, and draws the attention of every nearby foe.' },
      { id: 'guardian_shield_smash', name: 'Shield-smash', icon: '💥', level: 70, kind: 'melee', range: MELEE, cooldown: 60, pf: 1.1,
        effects: [D(3.2), STUN(4)], anim: 'thrust', vfx: 'crit', sfx: 'blunt_hit',
        desc: 'You put the whole weight of your body behind your shield and drive it through your foe. Deals {dmg} Common damage and stuns the target for {stun} seconds.' },
    ],

    // ---------------------------------------------------------------- CHAMPION (dps, twin blades) --------------------
    champion: [
      { id: 'champion_swift_strike', name: 'Swift Strike', icon: '⚔', level: 1, kind: 'melee', range: MELEE,
        effects: [D(0.9)], anim: 'slash', vfx: 'slash', sfx: 'sword_hit',
        desc: "A swift cut that opens your foe's guard. Deals {dmg} Common damage." },
      { id: 'champion_wild_attack', name: 'Wild Attack', icon: '🗡', level: 1, kind: 'melee', range: MELEE, cooldown: 4, pf: 1.2,
        effects: [D(1.3)], anim: 'slash', vfx: 'slash', sfx: 'sword_swing',
        desc: 'A reckless, powerful swing with little thought for defence. Deals {dmg} Common damage.' },
      { id: 'champion_blade_storm', name: 'Blade Storm', icon: '🌀', level: 4, kind: 'melee', target: 'self', range: MELEE, cooldown: 8, pf: 1.2,
        effects: [D(0.9, 'common', 4.5)], anim: 'spin', vfx: 'spin', sfx: 'sword_swing',
        desc: 'You spin in a storm of steel, striking every foe within reach. Deals {dmg} Common damage to all enemies within {radius} metres.' },
      { id: 'champion_savage_strikes', name: 'Savage Strikes', icon: '⚔', level: 8, kind: 'melee', range: MELEE, cooldown: 6,
        effects: [D(0.8), D(0.8)], anim: 'slash', vfx: 'slash', sfx: 'sword_hit',
        desc: 'Two savage blows in quick succession. Deals {dmg} Common damage, then strikes again for {dmg2}.' },
      { id: 'champion_fervour', name: 'Fervour', icon: '🔥', level: 12, kind: 'stance', range: 0, cooldown: 5, pf: 0.8,
        effects: [BUFF('physMastery', 15, 1800), DEBUFF('armour', -10, 1800, 'self')], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'You throw yourself into the fray with reckless fervour. Increases Physical Mastery by {amount} but reduces Armour by {amount2} for {durationText}.' },
      { id: 'champion_rend', name: 'Rend', icon: '💢', level: 16, kind: 'melee', range: MELEE, cooldown: 10,
        effects: [D(0.7), DOT(0.3, 12, 2), DEBUFF('armour', -10, 12)], anim: 'slash', vfx: 'slash', sfx: 'sword_hit',
        desc: 'A tearing cut that leaves your foe bleeding and its armour torn. Deals {dmg} Common damage, then {dot} Common damage every {tick} seconds for {duration} seconds, and lowers Armour by {amount}.' },
      { id: 'champion_bracing_attack', name: 'Bracing Attack', icon: '💚', level: 20, kind: 'melee', range: MELEE, cooldown: 20,
        effects: [D(1.0), HEAL(3, 'self')], anim: 'slash', vfx: 'heal', sfx: 'sword_hit',
        desc: 'A bracing strike that steadies your nerve as it lands. Deals {dmg} Common damage and restores {heal} Morale to you.' },
      { id: 'champion_horn_of_champions', name: 'Horn of Champions', icon: '📯', level: 26, kind: 'melee', target: 'self', range: MELEE, cooldown: 30, pf: 1.1,
        effects: [D(0.5, 'common', 6), STUN(3, 6)], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'A mighty blast of your war-horn that staggers every foe around you. Deals {dmg} Common damage and stuns enemies within {radius} metres for {stun} seconds.' },
      { id: 'champion_remorseless_strike', name: 'Remorseless Strike', icon: '🎯', level: 32, kind: 'melee', range: MELEE, cooldown: 10, pf: 1.1,
        effects: [D(2.0)], anim: 'thrust', vfx: 'crit', sfx: 'sword_hit',
        desc: "A merciless thrust aimed at a weak point in your foe's defence. Deals {dmg} Common damage." },
      { id: 'champion_blade_wall', name: 'Blade-wall', icon: '⚔', level: 40, kind: 'melee', target: 'self', range: MELEE, cooldown: 15, pf: 1.1,
        effects: [D(1.2, 'common', 5)], anim: 'spin', vfx: 'slash', sfx: 'sword_swing',
        desc: 'A wall of flashing blades that no foe can pass. Deals {dmg} Common damage to all enemies within {radius} metres.' },
      { id: 'champion_raging_blade', name: 'Raging Blade', icon: '🌪', level: 50, kind: 'melee', target: 'self', range: MELEE, cooldown: 20, pf: 1.1,
        effects: [D(1.6, 'common', 5)], anim: 'spin', vfx: 'spin', sfx: 'sword_swing',
        desc: 'Your blades become a raging storm of steel. Deals {dmg} Common damage to all enemies within {radius} metres.' },
      { id: 'champion_battle_frenzy', name: 'Battle-frenzy', icon: '💪', level: 60, kind: 'buff', range: 0, cooldown: 90,
        effects: [BUFF('crit', 30, 30), BUFF('physMastery', 15, 30)], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'A red frenzy takes you and every blow lands harder. Increases Critical Rating by {amount} and Physical Mastery by {amount2} for {duration} seconds.' },
      { id: 'champion_merciful_strike', name: 'Merciful Strike', icon: '💥', level: 70, kind: 'melee', range: MELEE, cooldown: 45, pf: 1.1,
        effects: [D(3.5)], anim: 'slash', vfx: 'crit', sfx: 'sword_hit',
        desc: 'A single merciful stroke that ends the fight. Deals {dmg} Common damage.' },
    ],

    // ---------------------------------------------------------------- CAPTAIN (support, halberd & banner) ------------
    captain: [
      { id: 'captain_battle_shout', name: 'Battle-shout', icon: '📣', level: 1, kind: 'melee', range: SHOUT, threat: 1.5,
        effects: [D(0.9)], anim: 'shout', vfx: 'hit', sfx: 'blunt_hit',
        desc: 'A war-cry that strikes fear into your foe. Deals {dmg} Common damage.' },
      { id: 'captain_sure_strike', name: 'Sure Strike', icon: '⚔', level: 1, kind: 'melee', range: MELEE, cooldown: 3,
        effects: [D(1.1)], anim: 'slash', vfx: 'slash', sfx: 'sword_hit',
        desc: 'A sure and steady blow. Deals {dmg} Common damage.' },
      { id: 'captain_devastating_blow', name: 'Devastating Blow', icon: '💥', level: 4, kind: 'melee', range: MELEE, cooldown: 8, pf: 1.1,
        effects: [D(1.6)], anim: 'slash', vfx: 'crit', sfx: 'sword_hit',
        desc: 'A devastating overhand blow. Deals {dmg} Common damage.' },
      { id: 'captain_motivating_speech', name: 'Motivating Speech', icon: '🎺', level: 8, kind: 'buff', target: 'party', range: 0, cooldown: 30,
        effects: [BUFF('physMastery', 10, 30, 'party'), BUFF('tactMastery', 10, 30, 'party')], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'Stirring words that hearten all who fight beside you. Increases the Physical and Tactical Mastery of you and your fellows by {amount} for {duration} seconds.' },
      { id: 'captain_rallying_cry', name: 'Rallying Cry', icon: '💚', level: 12, kind: 'heal', target: 'party', range: 0, cooldown: 15, pf: 1.3,
        effects: [HEAL(2.5, 'party', 10)], anim: 'shout', vfx: 'heal', sfx: 'heal',
        desc: 'A rallying cry that lifts the spirits of the weary. Restores {heal} Morale to you and your fellows within {radius} metres.' },
      { id: 'captain_cutting_attack', name: 'Cutting Attack', icon: '💢', level: 16, kind: 'melee', range: MELEE, cooldown: 8,
        effects: [D(0.8), DOT(0.3, 12, 2)], anim: 'slash', vfx: 'slash', sfx: 'sword_hit',
        desc: 'A cutting blow that leaves a bleeding wound. Deals {dmg} Common damage and a further {dot} Common damage every {tick} seconds for {duration} seconds.' },
      { id: 'captain_herald_of_war', name: 'Herald of War', icon: '🚩', level: 20, kind: 'buff', range: 0, castTime: 1.5, cooldown: 60, pf: 1.4,
        effects: [BUFF('physMastery', 10, 600, 'self', 'Herald'), BUFF('maxMorale', 10, 600, 'self', 'Herald')], anim: 'cast', vfx: 'sparkle', sfx: 'buff',
        desc: 'You summon a herald to bear your standard into battle. While the Herald stands with you, Physical Mastery and maximum Morale are increased by {amount} for {durationText}.' },
      { id: 'captain_pressing_attack', name: 'Pressing Attack', icon: '⚔', level: 26, kind: 'melee', range: MELEE, cooldown: 10, pf: 1.1,
        effects: [D(1.0, 'common', 4)], anim: 'slash', vfx: 'slash', sfx: 'sword_swing',
        desc: 'A pressing assault that drives back every foe before you. Deals {dmg} Common damage to enemies within {radius} metres of your target.' },
      { id: 'captain_make_haste', name: 'Make Haste', icon: '💨', level: 32, kind: 'buff', target: 'party', range: 0, cooldown: 60, pf: 0.8,
        effects: [BUFF('speed', 30, 15, 'party')], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'You urge your fellows onward with a shout. Increases the movement speed of you and your fellows by {amount} for {duration} seconds.' },
      { id: 'captain_routing_cry', name: 'Routing Cry', icon: '🌀', level: 40, kind: 'melee', target: 'self', range: MELEE, cooldown: 30, pf: 1.1,
        effects: [D(0.8, 'common', 6), SLOW(40, 8, 6)], anim: 'shout', vfx: 'hit', sfx: 'blunt_hit',
        desc: 'A terrible cry that routs your enemies. Deals {dmg} Common damage to all enemies within {radius} metres and slows them by {slow} for {slowDuration} seconds.' },
      { id: 'captain_blade_of_elendil', name: 'Blade of Elendil', icon: '☀', level: 50, kind: 'melee', range: MELEE, cooldown: 30, pf: 1.1,
        effects: [D(2.8, 'light')], anim: 'slash', vfx: 'light', sfx: 'light_hit',
        desc: 'You strike with the light of the Faithful in your blade. Deals {dmg} Light damage.' },
      { id: 'captain_in_defence_of_middle_earth', name: 'In Defence of Middle-earth', icon: '🌟', level: 60, kind: 'buff', target: 'party', range: 0, cooldown: 30,
        effects: [BUFF('might', 10, 600, 'party'), BUFF('vitality', 10, 600, 'party'), BUFF('will', 10, 600, 'party')], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'You remind your fellows what they fight for. Increases the Might, Vitality and Will of you and your fellows by {amount} for {durationText}.' },
      { id: 'captain_strength_of_morale', name: 'Strength of Morale', icon: '✨', level: 70, kind: 'heal', target: 'party', range: 0, castTime: 1.5, cooldown: 90, pf: 1.1,
        effects: [HEAL(6, 'party', 10)], anim: 'shout', vfx: 'heal', sfx: 'heal',
        desc: 'Your unbreakable will becomes a shield for all around you. Restores {heal} Morale to you and your fellows within {radius} metres.' },
    ],

    // ---------------------------------------------------------------- HUNTER (ranged dps, bow) -----------------------
    hunter: [
      { id: 'hunter_quick_shot', name: 'Quick Shot', icon: '🏹', level: 1, kind: 'ranged', range: RANGED,
        effects: [D(0.9)], anim: 'shoot', vfx: 'arrow', sfx: 'bow_shoot',
        desc: 'A quick shot loosed without pause. Deals {dmg} Common damage.' },
      { id: 'hunter_swift_bow', name: 'Swift Bow', icon: '🏹', level: 1, kind: 'ranged', range: RANGED, castTime: 1.5, cooldown: 3, pf: 1.2,
        effects: [D(1.5)], anim: 'shoot', vfx: 'arrow', sfx: 'bow_shoot',
        desc: 'You draw fully and loose two arrows in quick succession. Deals {dmg} Common damage.' },
      { id: 'hunter_low_cut', name: 'Low Cut', icon: '🗡', level: 4, kind: 'melee', range: MELEE, cooldown: 8,
        effects: [D(0.9), SLOW(30, 6)], anim: 'slash', vfx: 'slash', sfx: 'sword_hit',
        desc: 'A low slash at the legs that hobbles your foe. Deals {dmg} Common damage and slows the target by {slow} for {slowDuration} seconds.' },
      { id: 'hunter_penetrating_shot', name: 'Penetrating Shot', icon: '🎯', level: 8, kind: 'ranged', range: RANGED, cooldown: 6, pf: 1.1,
        effects: [D(1.4), DEBUFF('armour', -10, 15)], anim: 'shoot', vfx: 'arrow', sfx: 'arrow_hit',
        desc: "An arrow driven clean through armour. Deals {dmg} Common damage and reduces the target's Armour by {amount} for {duration} seconds." },
      { id: 'hunter_barbed_arrow', name: 'Barbed Arrow', icon: '💢', level: 12, kind: 'ranged', range: RANGED, cooldown: 8,
        effects: [D(0.8), DOT(0.3, 12, 2)], anim: 'shoot', vfx: 'arrow', sfx: 'arrow_hit',
        desc: 'A barbed arrow that tears with every movement. Deals {dmg} Common damage and a further {dot} Common damage every {tick} seconds for {duration} seconds.' },
      { id: 'hunter_strength_stance', name: 'Strength Stance', icon: '💪', level: 16, kind: 'stance', range: 0, cooldown: 5, pf: 0.8,
        effects: [BUFF('physMastery', 15, 1800)], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'You draw with the strength of your whole body. Increases Physical Mastery by {amount} for {durationText}.' },
      { id: 'hunter_rain_of_arrows', name: 'Rain of Arrows', icon: '🌧', level: 20, kind: 'ranged', range: RANGED, castTime: 1, cooldown: 10, pf: 1.2,
        effects: [D(0.9, 'common', 6)], anim: 'shoot', vfx: 'arrow', sfx: 'bow_shoot',
        desc: 'A volley of arrows that falls like rain. Deals {dmg} Common damage to enemies within {radius} metres of your target.' },
      { id: 'hunter_agile_rejoinder', name: 'Agile Rejoinder', icon: '💚', level: 26, kind: 'melee', range: MELEE, cooldown: 20,
        effects: [D(1.0), HEAL(3, 'self')], anim: 'slash', vfx: 'heal', sfx: 'sword_hit',
        desc: 'A nimble riposte that gives you a moment to catch your breath. Deals {dmg} Common damage and restores {heal} Morale to you.' },
      { id: 'hunter_bards_arrow', name: "Bard's Arrow", icon: '💫', level: 32, kind: 'ranged', range: RANGED, cooldown: 30,
        effects: [D(0.6), STUN(5)], anim: 'shoot', vfx: 'sparkle', sfx: 'bow_shoot',
        desc: 'An arrow that sings as it flies, leaving your foe dazed. Deals {dmg} Common damage and stuns the target for {stun} seconds.' },
      { id: 'hunter_rain_of_thorns', name: 'Rain of Thorns', icon: '🌿', level: 40, kind: 'ranged', range: RANGED, cooldown: 45, pf: 1.1,
        effects: [ROOT(6, 6), D(0.3, 'common', 6)], anim: 'shoot', vfx: 'dust', sfx: 'arrow_hit',
        desc: 'Thorned arrows that snare every foe where they stand. Roots enemies within {radius} metres of your target for {root} seconds and deals {dmg} Common damage.' },
      { id: 'hunter_burn_hot', name: 'Burn Hot', icon: '🔥', level: 50, kind: 'buff', range: 0, cooldown: 90,
        effects: [BUFF('crit', 30, 30), BUFF('physMastery', 15, 30)], anim: 'shout', vfx: 'fire', sfx: 'buff',
        desc: 'You burn hot with the fury of the hunt. Increases Critical Rating by {amount} and Physical Mastery by {amount2} for {duration} seconds.' },
      { id: 'hunter_merciful_shot', name: 'Merciful Shot', icon: '🎯', level: 60, kind: 'ranged', range: RANGED, cooldown: 20, pf: 1.1,
        effects: [D(2.4)], anim: 'shoot', vfx: 'crit', sfx: 'arrow_hit',
        desc: "A merciful shot that ends a wounded foe's suffering. Deals {dmg} Common damage." },
      { id: 'hunter_heart_seeker', name: 'Heart Seeker', icon: '❤', level: 70, kind: 'ranged', range: RANGED, castTime: 2.5, cooldown: 60, pf: 1.1,
        effects: [D(4.0)], anim: 'shoot', vfx: 'crit', sfx: 'bow_shoot',
        desc: 'A long, patient draw and an arrow that seeks the heart. Deals {dmg} Common damage.' },
    ],

    // ---------------------------------------------------------------- BURGLAR (dps, daggers & tricks) ---------------
    burglar: [
      { id: 'burglar_surprise_strike', name: 'Surprise Strike', icon: '🗡', level: 1, kind: 'melee', range: MELEE, cooldown: 3, pf: 1.1,
        effects: [D(1.2)], anim: 'thrust', vfx: 'crit', sfx: 'sword_hit',
        desc: 'A sudden strike from where your foe least expects it. Deals {dmg} Common damage.' },
      { id: 'burglar_subtle_stab', name: 'Subtle Stab', icon: '🗡', level: 1, kind: 'melee', range: MELEE,
        effects: [D(0.9)], anim: 'thrust', vfx: 'thrust', sfx: 'sword_hit',
        desc: 'A quick and subtle stab. Deals {dmg} Common damage.' },
      { id: 'burglar_cunning_attack', name: 'Cunning Attack', icon: '💢', level: 4, kind: 'melee', range: MELEE, cooldown: 8,
        effects: [D(0.7), DOT(0.3, 12, 2)], anim: 'slash', vfx: 'slash', sfx: 'sword_hit',
        desc: 'A cunning cut that opens a wound slow to close. Deals {dmg} Common damage and a further {dot} Common damage every {tick} seconds for {duration} seconds.' },
      { id: 'burglar_riddle', name: 'Riddle', icon: '❓', level: 8, kind: 'debuff', range: SHOUT, cooldown: 30, pf: 1.1,
        effects: [STUN(5)], anim: 'shout', vfx: 'sparkle', sfx: 'spell_cast',
        desc: 'You pose a riddle so puzzling that your foe forgets to fight. Stuns the target for {stun} seconds.' },
      { id: 'burglar_trick_disable', name: 'Trick: Disable', icon: '🎭', level: 12, kind: 'debuff', range: SHOUT, cooldown: 20,
        effects: [DEBUFF('physMastery', -15, 20), DEBUFF('speed', -15, 20)], anim: 'shout', vfx: 'dust', sfx: 'spell_cast',
        desc: "A dirty trick that hampers your foe. Reduces the target's Physical Mastery by {amount} and movement speed by {amount2} for {duration} seconds." },
      { id: 'burglar_addle', name: 'Addle', icon: '🌀', level: 16, kind: 'melee', range: MELEE, cooldown: 15,
        effects: [D(0.6), DEBUFF('tactMastery', -20, 15)], anim: 'thrust', vfx: 'hit', sfx: 'blunt_hit',
        desc: "A rap on the skull that addles your foe's wits. Deals {dmg} Common damage and reduces the target's Tactical Mastery by {amount} for {duration} seconds." },
      { id: 'burglar_marbles', name: 'Marbles', icon: '🎱', level: 20, kind: 'melee', target: 'self', range: MELEE, cooldown: 30, pf: 1.1,
        effects: [D(0.4, 'common', 5), STUN(3, 5)], anim: 'shoot', vfx: 'dust', sfx: 'blunt_hit',
        desc: 'A handful of marbles scattered underfoot. Deals {dmg} Common damage and knocks down enemies within {radius} metres for {stun} seconds.' },
      { id: 'burglar_exposed_throat', name: 'Exposed Throat', icon: '🎯', level: 26, kind: 'melee', range: MELEE, cooldown: 10, pf: 1.1,
        effects: [D(1.8)], anim: 'thrust', vfx: 'crit', sfx: 'sword_hit',
        desc: 'A precise strike at an exposed throat. Deals {dmg} Common damage.' },
      { id: 'burglar_knives_out', name: 'Knives Out', icon: '⚔', level: 32, kind: 'buff', range: 0, cooldown: 60,
        effects: [BUFF('physMastery', 20, 20), BUFF('parry', 15, 20)], anim: 'spin', vfx: 'buff', sfx: 'buff',
        desc: 'Every blade you carry comes out at once. Increases Physical Mastery by {amount} and Parry Rating by {amount2} for {duration} seconds.' },
      { id: 'burglar_mischievous_glee', name: 'Mischievous Glee', icon: '💚', level: 40, kind: 'heal', target: 'self', range: 0, cooldown: 45, mastery: 'phys',
        effects: [HEAL(4, 'self'), HOT(0.5, 15, 3, 'self')], anim: 'shout', vfx: 'heal', sfx: 'heal',
        desc: 'A moment of mischievous glee restores your spirits. Restores {heal} Morale, and a further {hot} Morale every {tick} seconds for {duration} seconds.' },
      { id: 'burglar_flashing_blades', name: 'Flashing Blades', icon: '🌪', level: 50, kind: 'melee', target: 'self', range: MELEE, cooldown: 15, pf: 1.1,
        effects: [D(1.3, 'common', 4)], anim: 'spin', vfx: 'spin', sfx: 'sword_swing',
        desc: 'A whirl of flashing blades. Deals {dmg} Common damage to all enemies within {radius} metres.' },
      { id: 'burglar_quite_a_snag', name: 'Quite a Snag', icon: '⛓', level: 60, kind: 'debuff', range: SHOUT, cooldown: 30,
        effects: [ROOT(8)], anim: 'shoot', vfx: 'dust', sfx: 'spell_cast',
        desc: 'A well-placed snare that trips your foe. Roots the target in place for {root} seconds.' },
      { id: 'burglar_coup_de_grace', name: 'Coup de Grâce', icon: '💥', level: 70, kind: 'melee', range: MELEE, cooldown: 60, pf: 1.1,
        effects: [D(3.6)], anim: 'thrust', vfx: 'crit', sfx: 'sword_hit',
        desc: 'The final blow of a duel, delivered with perfect timing. Deals {dmg} Common damage.' },
    ],

    // ---------------------------------------------------------------- MINSTREL (healer, songs of Light) --------------
    minstrel: [
      { id: 'minstrel_ballad_of_war', name: 'Ballad of War', icon: '🎵', level: 1, kind: 'tactical', range: RANGED,
        effects: [D(0.9, 'light')], anim: 'cast', vfx: 'light', sfx: 'spell_cast',
        desc: 'A ballad of old battles that strikes at your foe. Deals {dmg} Light damage.' },
      { id: 'minstrel_raise_the_spirit', name: 'Raise the Spirit', icon: '💚', level: 1, kind: 'heal', range: RANGED, castTime: 1, cooldown: 3, pf: 1.3,
        effects: [HEAL(2.0, 'ally')], anim: 'cast', vfx: 'heal', sfx: 'heal',
        desc: 'A gentle song that raises the spirit. Restores {heal} Morale to the target.' },
      { id: 'minstrel_piercing_cry', name: 'Piercing Cry', icon: '📣', level: 4, kind: 'tactical', range: RANGED, cooldown: 5, pf: 1.1,
        effects: [D(1.3, 'light')], anim: 'shout', vfx: 'light', sfx: 'light_hit',
        desc: 'A piercing cry that no armour can turn aside. Deals {dmg} Light damage.' },
      { id: 'minstrel_timeless_echoes', name: 'Timeless Echoes of Battle', icon: '🌀', level: 8, kind: 'tactical', range: RANGED, cooldown: 12,
        effects: [D(0.6, 'light'), DEBUFF('armour', -15, 20)], anim: 'cast', vfx: 'sparkle', sfx: 'spell_hit',
        desc: "Echoes of ancient battles rattle your foe's armour. Deals {dmg} Light damage and reduces the target's Armour by {amount} for {duration} seconds." },
      { id: 'minstrel_bolster_courage', name: 'Bolster Courage', icon: '❤', level: 12, kind: 'heal', range: RANGED, castTime: 2, cooldown: 5, pf: 1.5,
        effects: [HEAL(3.5, 'ally')], anim: 'cast', vfx: 'heal', sfx: 'heal',
        desc: 'A song of courage that mends grievous hurts. Restores {heal} Morale to the target.' },
      { id: 'minstrel_anthem_of_composure', name: 'Anthem of Composure', icon: '🎶', level: 16, kind: 'buff', target: 'party', range: 0, cooldown: 30,
        effects: [BUFF('powerRegen', 30, 60, 'party'), BUFF('moraleRegen', 30, 60, 'party')], anim: 'cast', vfx: 'buff', sfx: 'buff',
        desc: 'A calming anthem that steadies breath and heart. Increases the Power and Morale regeneration of you and your fellows by {amount} for {duration} seconds.' },
      { id: 'minstrel_soliloquy_of_spirit', name: 'Soliloquy of Spirit', icon: '✨', level: 20, kind: 'heal', range: RANGED, cooldown: 10,
        effects: [HOT(0.6, 15, 3, 'ally')], anim: 'cast', vfx: 'heal', sfx: 'heal',
        desc: 'A soft soliloquy that mends over time. Restores {hot} Morale to the target every {tick} seconds for {duration} seconds.' },
      { id: 'minstrel_echoes_of_battle', name: 'Echoes of Battle', icon: '💫', level: 26, kind: 'tactical', range: RANGED, cooldown: 30, pf: 1.1,
        effects: [D(0.8, 'light'), STUN(3)], anim: 'shout', vfx: 'light', sfx: 'light_hit',
        desc: 'A thunderous echo that leaves your foe stunned. Deals {dmg} Light damage and stuns the target for {stun} seconds.' },
      { id: 'minstrel_coda_of_fury', name: 'Coda of Fury', icon: '🎼', level: 32, kind: 'aoe', range: RANGED, cooldown: 12, pf: 1.2,
        effects: [D(1.2, 'light', 6)], anim: 'cast', vfx: 'light', sfx: 'light_hit',
        desc: 'A furious coda that bursts upon your enemies. Deals {dmg} Light damage to enemies within {radius} metres of your target.' },
      { id: 'minstrel_war_speech', name: 'War-speech', icon: '⚔', level: 40, kind: 'stance', range: 0, cooldown: 5, pf: 0.8,
        effects: [BUFF('tactMastery', 20, 1800)], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'You raise your voice in the harsh speech of war. Increases Tactical Mastery by {amount} for {durationText}.' },
      { id: 'minstrel_call_to_greatness', name: 'Call to Greatness', icon: '🌟', level: 50, kind: 'buff', target: 'party', range: 0, cooldown: 90,
        effects: [BUFF('physMastery', 10, 30, 'party'), BUFF('tactMastery', 10, 30, 'party'), BUFF('crit', 15, 30, 'party')], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'A call to greatness that stirs every heart. Increases Physical and Tactical Mastery by {amount} and Critical Rating by {amount3} for you and your fellows for {duration} seconds.' },
      { id: 'minstrel_fellowships_heart', name: "Fellowship's Heart", icon: '💖', level: 60, kind: 'heal', target: 'party', range: 0, castTime: 2, cooldown: 45, pf: 1.2,
        effects: [HEAL(4, 'party', 10)], anim: 'cast', vfx: 'heal', sfx: 'heal',
        desc: 'A song for the whole fellowship. Restores {heal} Morale to you and your fellows within {radius} metres.' },
      { id: 'minstrel_call_of_orome', name: 'Call of Oromë', icon: '📯', level: 70, kind: 'aoe', range: RANGED, castTime: 2, cooldown: 60, pf: 1.1,
        effects: [D(3.0, 'light', 8)], anim: 'cast', vfx: 'light', sfx: 'light_hit',
        desc: 'You sound the horn-call of Oromë the Hunter. Deals {dmg} Light damage to all enemies within {radius} metres of your target.' },
    ],

    // ---------------------------------------------------------------- LORE-MASTER (support, staff & lore) ------------
    loremaster: [
      { id: 'loremaster_wizards_fire', name: "Wizard's Fire", icon: '🔥', level: 1, kind: 'tactical', range: RANGED,
        effects: [D(0.9, 'fire')], anim: 'cast', vfx: 'fire', sfx: 'fire_hit',
        desc: "A bolt of wizard's fire hurled from your staff. Deals {dmg} Fire damage." },
      { id: 'loremaster_burning_embers', name: 'Burning Embers', icon: '♨', level: 1, kind: 'tactical', range: RANGED, cooldown: 3,
        effects: [D(0.4, 'fire'), DOT(0.35, 10, 2, 'fire')], anim: 'cast', vfx: 'fire', sfx: 'fire_hit',
        desc: 'Embers that cling and smoulder. Deals {dmg} Fire damage and a further {dot} Fire damage every {tick} seconds for {duration} seconds.' },
      { id: 'loremaster_gust_of_wind', name: 'Gust of Wind', icon: '💨', level: 4, kind: 'tactical', range: RANGED, cooldown: 6,
        effects: [D(1.1, 'common'), KNOCK(3)], anim: 'cast', vfx: 'dust', sfx: 'spell_hit',
        desc: 'A sudden gust that batters your foe. Deals {dmg} Common damage and throws the target back.' },
      { id: 'loremaster_light_of_the_rising_dawn', name: 'Light of the Rising Dawn', icon: '☀', level: 8, kind: 'tactical', range: RANGED, cooldown: 20, pf: 1.1,
        effects: [D(0.6, 'light'), STUN(3)], anim: 'cast', vfx: 'light', sfx: 'light_hit',
        desc: 'A blinding light like the first dawn. Deals {dmg} Light damage and stuns the target for {stun} seconds.' },
      { id: 'loremaster_beacon_of_hope', name: 'Beacon of Hope', icon: '💚', level: 12, kind: 'heal', range: RANGED, castTime: 1.5, cooldown: 8, pf: 1.3,
        effects: [HEAL(2.5, 'ally')], anim: 'cast', vfx: 'heal', sfx: 'heal',
        desc: 'A beacon of hope kindled in a dark hour. Restores {heal} Morale to the target.' },
      { id: 'loremaster_sign_of_power_command', name: 'Sign of Power: Command', icon: '✋', level: 16, kind: 'debuff', range: RANGED, cooldown: 20,
        effects: [DEBUFF('physMastery', -20, 15), DEBUFF('tactMastery', -20, 15)], anim: 'cast', vfx: 'sparkle', sfx: 'spell_cast',
        desc: "A sign of power that commands your foe to stay its hand. Reduces the target's Physical and Tactical Mastery by {amount} for {duration} seconds." },
      { id: 'loremaster_cracked_earth', name: 'Cracked Earth', icon: '⛰', level: 20, kind: 'aoe', range: RANGED, castTime: 1, cooldown: 30, pf: 1.1,
        effects: [D(0.5, 'common', 5), ROOT(6, 5)], anim: 'cast', vfx: 'dust', sfx: 'blunt_hit',
        desc: "The earth cracks and closes about your enemies' feet. Deals {dmg} Common damage and roots enemies within {radius} metres of your target for {root} seconds." },
      { id: 'loremaster_lightning_storm', name: 'Lightning-storm', icon: '⚡', level: 26, kind: 'aoe', range: RANGED, castTime: 1.5, cooldown: 12, pf: 1.2,
        effects: [D(1.2, 'lightning', 6)], anim: 'cast', vfx: 'lightning', sfx: 'spell_hit',
        desc: 'You call down a storm of lightning. Deals {dmg} Lightning damage to enemies within {radius} metres of your target.' },
      { id: 'loremaster_storm_lore', name: 'Storm-lore', icon: '🌩', level: 32, kind: 'tactical', range: RANGED, castTime: 1, cooldown: 8, pf: 1.1,
        effects: [D(1.6, 'lightning')], anim: 'cast', vfx: 'lightning', sfx: 'spell_hit',
        desc: 'The lore of storms, hurled as a single bolt. Deals {dmg} Lightning damage.' },
      { id: 'loremaster_sticky_tar', name: 'Sticky Tar', icon: '🌫', level: 40, kind: 'debuff', range: RANGED, cooldown: 30,
        effects: [SLOW(50, 10, 6)], anim: 'cast', vfx: 'smoke', sfx: 'spell_hit',
        desc: 'A gourd of sticky tar bursts underfoot. Slows enemies within {radius} metres of your target by {slow} for {slowDuration} seconds.' },
      { id: 'loremaster_wisdom_of_the_council', name: 'Wisdom of the Council', icon: '📜', level: 50, kind: 'heal', target: 'self', range: 0, cooldown: 90,
        effects: [HEAL(5, 'self'), BUFF('tactMastery', 15, 20)], anim: 'cast', vfx: 'heal', sfx: 'heal',
        desc: 'You recall the wisdom of the White Council. Restores {heal} Morale and increases your Tactical Mastery by {amount} for {duration} seconds.' },
      { id: 'loremaster_ancient_craft', name: 'Ancient Craft', icon: '🔮', level: 60, kind: 'buff', range: 0, cooldown: 60,
        effects: [BUFF('tactMastery', 20, 30), BUFF('crit', 20, 30)], anim: 'cast', vfx: 'buff', sfx: 'buff',
        desc: 'You draw on the ancient craft of the Eldar. Increases Tactical Mastery by {amount} and Critical Rating by {amount2} for {duration} seconds.' },
      { id: 'loremaster_ents_go_to_war', name: 'Ents go to War', icon: '🌲', level: 70, kind: 'aoe', range: RANGED, castTime: 2.5, cooldown: 90, pf: 1.1,
        effects: [D(3.0, 'common', 8), STUN(2, 8)], anim: 'cast', vfx: 'dust', sfx: 'blunt_hit',
        desc: 'The very trees answer your call and march to war. Deals {dmg} Common damage to enemies within {radius} metres of your target and stuns them for {stun} seconds.' },
    ],

    // ---------------------------------------------------------------- RUNE-KEEPER (dps/healer, rune-stone) ----------
    runekeeper: [
      { id: 'runekeeper_shocking_touch', name: 'Shocking Touch', icon: '⚡', level: 1, kind: 'tactical', range: RANGED,
        effects: [D(1.0, 'lightning')], anim: 'cast', vfx: 'lightning', sfx: 'spell_hit',
        desc: 'A shocking touch of lightning from your rune-stone. Deals {dmg} Lightning damage.' },
      { id: 'runekeeper_scribes_spark', name: "Scribe's Spark", icon: '✍', level: 1, kind: 'tactical', range: RANGED, cooldown: 4, pf: 1.2,
        effects: [D(1.3, 'lightning')], anim: 'cast', vfx: 'bolt', sfx: 'spell_hit',
        desc: "A spark leaps from the scribe's pen to the foe. Deals {dmg} Lightning damage." },
      { id: 'runekeeper_chilling_rhetoric', name: 'Chilling Rhetoric', icon: '❄', level: 4, kind: 'tactical', range: RANGED, cooldown: 8,
        effects: [D(1.0, 'frost'), SLOW(30, 8)], anim: 'cast', vfx: 'frost', sfx: 'frost_hit',
        desc: 'Words cold enough to freeze the blood. Deals {dmg} Frost damage and slows the target by {slow} for {slowDuration} seconds.' },
      { id: 'runekeeper_rousing_words', name: 'Rousing Words', icon: '💚', level: 8, kind: 'heal', range: RANGED, castTime: 1.5, cooldown: 4, pf: 1.3,
        effects: [HEAL(2.2, 'ally')], anim: 'cast', vfx: 'heal', sfx: 'heal',
        desc: 'Rousing words written in runes of healing. Restores {heal} Morale to the target.' },
      { id: 'runekeeper_fiery_ridicule', name: 'Fiery Ridicule', icon: '🔥', level: 12, kind: 'tactical', range: RANGED, cooldown: 6,
        effects: [D(0.5, 'fire'), DOT(0.4, 12, 2, 'fire')], anim: 'cast', vfx: 'fire', sfx: 'fire_hit',
        desc: 'A ridicule so scathing it sets your foe alight. Deals {dmg} Fire damage and a further {dot} Fire damage every {tick} seconds for {duration} seconds.' },
      { id: 'runekeeper_writ_of_cold', name: 'Writ of Cold', icon: '❆', level: 16, kind: 'tactical', range: RANGED, cooldown: 10,
        effects: [D(0.6, 'frost'), DEBUFF('physMastery', -15, 12)], anim: 'cast', vfx: 'frost', sfx: 'frost_hit',
        desc: "A writ of cold that numbs your foe's sword-arm. Deals {dmg} Frost damage and reduces the target's Physical Mastery by {amount} for {duration} seconds." },
      { id: 'runekeeper_prelude_to_hope', name: 'Prelude to Hope', icon: '✨', level: 20, kind: 'heal', range: RANGED, cooldown: 10,
        effects: [HOT(0.5, 15, 3, 'ally')], anim: 'cast', vfx: 'heal', sfx: 'heal',
        desc: 'A prelude that promises hope to come. Restores {hot} Morale to the target every {tick} seconds for {duration} seconds.' },
      { id: 'runekeeper_thunderous_words', name: 'Thunderous Words', icon: '🌩', level: 26, kind: 'aoe', range: RANGED, castTime: 1, cooldown: 20, pf: 1.2,
        effects: [D(1.0, 'lightning', 6), STUN(2, 6)], anim: 'cast', vfx: 'lightning', sfx: 'thunder',
        desc: 'Words that crack like thunder over the battlefield. Deals {dmg} Lightning damage to enemies within {radius} metres of your target and stuns them for {stun} seconds.' },
      { id: 'runekeeper_armour_of_storm', name: 'Armour of Storm', icon: '🌀', level: 32, kind: 'stance', range: 0, cooldown: 5, pf: 0.8,
        effects: [BUFF('tactMastery', 15, 1800), BUFF('armour', 10, 1800)], anim: 'cast', vfx: 'buff', sfx: 'buff',
        desc: 'You wrap yourself in a mantle of storm. Increases Tactical Mastery by {amount} and Armour by {amount2} for {durationText}.' },
      { id: 'runekeeper_scathing_mockery', name: 'Scathing Mockery', icon: '☄', level: 40, kind: 'aoe', range: RANGED, castTime: 1.5, cooldown: 12, pf: 1.2,
        effects: [D(1.3, 'fire', 6)], anim: 'cast', vfx: 'fire', sfx: 'fire_hit',
        desc: 'Mockery so scathing that it scorches all who hear it. Deals {dmg} Fire damage to enemies within {radius} metres of your target.' },
      { id: 'runekeeper_self_motivation', name: 'Self-motivation', icon: '📜', level: 50, kind: 'heal', target: 'self', range: 0, cooldown: 60,
        effects: [HEAL(5, 'self'), HOT(0.5, 15, 3, 'self')], anim: 'cast', vfx: 'heal', sfx: 'heal',
        desc: 'A few well-chosen runes of self-encouragement. Restores {heal} Morale, and a further {hot} Morale every {tick} seconds for {duration} seconds.' },
      { id: 'runekeeper_fall_to_winter', name: 'Fall to Winter', icon: '☃', level: 60, kind: 'aoe', range: RANGED, castTime: 1.5, cooldown: 30, pf: 1.1,
        effects: [D(1.5, 'frost', 8), SLOW(50, 8, 8)], anim: 'cast', vfx: 'frost', sfx: 'frost_hit',
        desc: 'Winter falls upon your enemies all at once. Deals {dmg} Frost damage to enemies within {radius} metres of your target and slows them by {slow} for {slowDuration} seconds.' },
      { id: 'runekeeper_epic_conclusion', name: 'Epic Conclusion', icon: '💥', level: 70, kind: 'tactical', range: RANGED, castTime: 2.5, cooldown: 60, pf: 1.1,
        effects: [D(4.0, 'fire')], anim: 'cast', vfx: 'fire', sfx: 'fire_hit',
        desc: 'The epic conclusion to a tale of fire. Deals {dmg} Fire damage.' },
    ],

    // ---------------------------------------------------------------- WARDEN (tank, spear, shield & javelin) ---------
    warden: [
      { id: 'warden_quick_thrust', name: 'Quick Thrust', icon: '🔱', level: 1, kind: 'melee', range: MELEE,
        effects: [D(0.9)], anim: 'thrust', vfx: 'thrust', sfx: 'sword_hit',
        desc: 'A quick thrust of the spear. Deals {dmg} Common damage.' },
      { id: 'warden_shield_mastery', name: 'Shield Mastery', icon: '🛡', level: 1, kind: 'buff', range: 0, cooldown: 25, pf: 1.2,
        effects: [BUFF('block', 20, 20), BUFF('parry', 10, 20)], anim: 'block', vfx: 'buff', sfx: 'buff',
        desc: 'Mastery of the shield turns aside every blow. Increases Block Rating by {amount} and Parry Rating by {amount2} for {duration} seconds.' },
      { id: 'warden_goad', name: 'Goad', icon: '💢', level: 4, kind: 'melee', range: MELEE, cooldown: 8, threat: 2,
        effects: [D(0.5), DOT(0.3, 12, 2)], anim: 'thrust', vfx: 'thrust', sfx: 'sword_hit',
        desc: 'A goading jab that leaves a festering wound. Deals {dmg} Common damage and a further {dot} Common damage every {tick} seconds for {duration} seconds.' },
      { id: 'warden_persevere', name: 'Persevere', icon: '💚', level: 8, kind: 'heal', target: 'self', range: 0, cooldown: 30, mastery: 'phys',
        effects: [HEAL(3, 'self'), HOT(0.5, 15, 3, 'self')], anim: 'shout', vfx: 'heal', sfx: 'heal',
        desc: 'You grit your teeth and persevere. Restores {heal} Morale, and a further {hot} Morale every {tick} seconds for {duration} seconds.' },
      { id: 'warden_spear_of_virtue', name: 'Spear of Virtue', icon: '⚔', level: 12, kind: 'melee', range: MELEE, cooldown: 8, pf: 1.1,
        effects: [D(1.5)], anim: 'thrust', vfx: 'crit', sfx: 'sword_hit',
        desc: 'A righteous thrust that finds its mark. Deals {dmg} Common damage.' },
      { id: 'warden_hampering_javelin', name: 'Hampering Javelin', icon: '🎯', level: 16, kind: 'ranged', range: RANGED, cooldown: 15,
        effects: [D(0.9), SLOW(40, 10)], anim: 'shoot', vfx: 'arrow', sfx: 'arrow_hit',
        desc: "A thrown javelin that hampers your foe's legs. Deals {dmg} Common damage and slows the target by {slow} for {slowDuration} seconds." },
      { id: 'warden_wall_of_steel', name: 'Wall of Steel', icon: '🌀', level: 20, kind: 'melee', target: 'self', range: MELEE, cooldown: 15, pf: 1.1,
        effects: [D(1.0, 'common', 4), BUFF('block', 15, 10)], anim: 'spin', vfx: 'spin', sfx: 'sword_swing',
        desc: 'Spear and shield become a wall of steel. Deals {dmg} Common damage to all enemies within {radius} metres and increases Block Rating by {amount} for {duration} seconds.' },
      { id: 'warden_wardens_taunt', name: "Warden's Taunt", icon: '📣', level: 26, kind: 'taunt', range: SHOUT, cooldown: 15, threat: 4,
        effects: [D(0.6), DEBUFF('physMastery', -10, 10)], anim: 'shout', vfx: 'hit', sfx: 'blunt_hit',
        desc: 'A taunt that no foe can bear to ignore. Deals {dmg} Common damage, forces the target to attack you and reduces its Physical Mastery by {amount} for {duration} seconds.' },
      { id: 'warden_boars_rush', name: "Boar's Rush", icon: '🐗', level: 32, kind: 'melee', range: MELEE, cooldown: 30, pf: 1.1,
        effects: [D(1.0), STUN(3)], anim: 'thrust', vfx: 'dust', sfx: 'blunt_hit',
        desc: 'You charge like a boar and bowl your foe over. Deals {dmg} Common damage and stuns the target for {stun} seconds.' },
      { id: 'warden_conviction', name: 'Conviction', icon: '✨', level: 40, kind: 'heal', target: 'party', range: 0, cooldown: 45, mastery: 'phys',
        effects: [HOT(0.8, 30, 3, 'party', 10)], anim: 'shout', vfx: 'heal', sfx: 'heal',
        desc: 'Your conviction bolsters all who stand with you. Restores {hot} Morale to you and your fellows every {tick} seconds for {duration} seconds.' },
      { id: 'warden_exultation_of_battle', name: 'Exultation of Battle', icon: '💫', level: 50, kind: 'melee', target: 'self', range: MELEE, cooldown: 20, pf: 1.1,
        effects: [D(0.9, 'common', 6), HOT(0.4, 10, 2, 'self')], anim: 'spin', vfx: 'slash', sfx: 'sword_swing',
        desc: 'You exult in battle, and every foe struck restores you. Deals {dmg} Common damage to all enemies within {radius} metres and restores {hot} Morale to you every {tick} seconds for {duration} seconds.' },
      { id: 'warden_defiant_challenge', name: 'Defiant Challenge', icon: '📯', level: 60, kind: 'taunt', target: 'self', range: 0, cooldown: 90, threat: 5,
        effects: [BUFF('armour', 30, 20), BUFF('maxMorale', 15, 20)], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'A defiant challenge hurled at every enemy around you. Draws the attention of all nearby foes and increases your Armour by {amount} and maximum Morale by {amount2} for {duration} seconds.' },
      { id: 'warden_the_dark_before_dawn', name: 'The Dark Before Dawn', icon: '🌙', level: 70, kind: 'melee', range: MELEE, cooldown: 60, pf: 1.1,
        effects: [D(3.2), HEAL(4, 'self')], anim: 'thrust', vfx: 'crit', sfx: 'sword_hit',
        desc: 'In the darkest hour you strike hardest. Deals {dmg} Common damage and restores {heal} Morale to you.' },
    ],

    // ---------------------------------------------------------------- BRAWLER (dps/tank, gauntlets) -----------------
    brawler: [
      { id: 'brawler_fulgurant_strike', name: 'Fulgurant Strike', icon: '👊', level: 1, kind: 'melee', range: MELEE,
        effects: [D(1.0)], anim: 'thrust', vfx: 'hit', sfx: 'blunt_hit',
        desc: 'A lightning-fast punch. Deals {dmg} Common damage.' },
      { id: 'brawler_innate_strength', name: 'Innate Strength', icon: '💪', level: 1, kind: 'stance', range: 0, cooldown: 5, pf: 0.8,
        effects: [BUFF('physMastery', 15, 1800), BUFF('maxMorale', 5, 1800)], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'You draw on your innate strength. Increases Physical Mastery by {amount} and maximum Morale by {amount2} for {durationText}.' },
      { id: 'brawler_batter', name: 'Batter', icon: '🥊', level: 4, kind: 'melee', range: MELEE, cooldown: 4,
        effects: [D(0.6), D(0.6)], anim: 'slash', vfx: 'hit', sfx: 'blunt_hit',
        desc: 'A flurry of battering blows. Deals {dmg} Common damage, then strikes again for {dmg2}.' },
      { id: 'brawler_iron_fists', name: 'Iron Fists', icon: '⚒', level: 8, kind: 'buff', range: 0, cooldown: 40,
        effects: [BUFF('physMastery', 20, 15)], anim: 'shout', vfx: 'buff', sfx: 'buff',
        desc: 'Your fists become as iron. Increases Physical Mastery by {amount} for {duration} seconds.' },
      { id: 'brawler_pummel', name: 'Pummel', icon: '💫', level: 12, kind: 'melee', range: MELEE, cooldown: 20, pf: 1.1,
        effects: [D(0.8), STUN(3)], anim: 'thrust', vfx: 'hit', sfx: 'blunt_hit',
        desc: 'A pummelling blow to the head. Deals {dmg} Common damage and stuns the target for {stun} seconds.' },
      { id: 'brawler_low_blow', name: 'Low Blow', icon: '💢', level: 16, kind: 'melee', range: MELEE, cooldown: 8,
        effects: [D(0.7), DOT(0.3, 10, 2)], anim: 'thrust', vfx: 'hit', sfx: 'blunt_hit',
        desc: 'A low blow that leaves your foe winded and bruised. Deals {dmg} Common damage and a further {dot} Common damage every {tick} seconds for {duration} seconds.' },
      { id: 'brawler_concussive_blow', name: 'Concussive Blow', icon: '🌀', level: 20, kind: 'melee', target: 'self', range: MELEE, cooldown: 12, pf: 1.1,
        effects: [D(1.0, 'common', 4.5), SLOW(30, 6, 4.5)], anim: 'slash', vfx: 'dust', sfx: 'blunt_hit',
        desc: 'A concussive blow that shakes the ground. Deals {dmg} Common damage to all enemies within {radius} metres and slows them by {slow} for {slowDuration} seconds.' },
      { id: 'brawler_thunderous_blow', name: 'Thunderous Blow', icon: '⚡', level: 26, kind: 'melee', range: MELEE, cooldown: 10, pf: 1.1,
        effects: [D(1.8)], anim: 'thrust', vfx: 'crit', sfx: 'blunt_hit',
        desc: 'A blow that lands like thunder. Deals {dmg} Common damage.' },
      { id: 'brawler_second_wind', name: 'Second Wind', icon: '💨', level: 32, kind: 'heal', target: 'self', range: 0, cooldown: 45, mastery: 'phys',
        effects: [HEAL(4, 'self'), BUFF('powerRegen', 50, 15)], anim: 'shout', vfx: 'heal', sfx: 'heal',
        desc: 'You find your second wind. Restores {heal} Morale and increases Power regeneration by {amount} for {duration} seconds.' },
      { id: 'brawler_skyward_strike', name: 'Skyward Strike', icon: '🌠', level: 40, kind: 'melee', range: MELEE, cooldown: 15, pf: 1.1,
        effects: [D(1.5), KNOCK(4)], anim: 'thrust', vfx: 'thrust', sfx: 'blunt_hit',
        desc: 'An uppercut that sends your foe skyward. Deals {dmg} Common damage and hurls the target back.' },
      { id: 'brawler_hurricane_strike', name: 'Hurricane Strike', icon: '🌪', level: 50, kind: 'melee', target: 'self', range: MELEE, cooldown: 20, pf: 1.1,
        effects: [D(1.4, 'common', 5)], anim: 'spin', vfx: 'spin', sfx: 'blunt_hit',
        desc: 'You spin like a hurricane, striking all around you. Deals {dmg} Common damage to all enemies within {radius} metres.' },
      { id: 'brawler_shattering_fist', name: 'Shattering Fist', icon: '💥', level: 60, kind: 'melee', range: MELEE, cooldown: 30, pf: 1.1,
        effects: [D(2.2), DEBUFF('armour', -25, 15)], anim: 'thrust', vfx: 'crit', sfx: 'blunt_hit',
        desc: "A fist that shatters shield and mail alike. Deals {dmg} Common damage and reduces the target's Armour by {amount} for {duration} seconds." },
      { id: 'brawler_anvil_of_judgement', name: 'Anvil of Judgement', icon: '🔨', level: 70, kind: 'melee', range: MELEE, cooldown: 60, pf: 1.1,
        effects: [D(3.8), STUN(2)], anim: 'thrust', vfx: 'crit', sfx: 'blunt_hit',
        desc: 'You bring your fists down like a hammer upon the anvil. Deals {dmg} Common damage and stuns the target for {stun} seconds.' },
    ],
  };

  // ------------------------------------------------------------------------------------------------------------------
  // Monster abilities (elite/boss monsters; referenced from G.Data.world.monsterTypes[].abilities by id)
  // ------------------------------------------------------------------------------------------------------------------
  const MONSTER_ABILITIES = [
    { id: 'troll_smash', name: 'Troll Smash', icon: '💥', family: 'troll', kind: 'melee', target: 'self', range: MELEE, power: 20, cooldown: 20,
      effects: [D(1.5, 'common', 5), KNOCK(6)], anim: 'slash', vfx: 'dust', sfx: 'troll_roar',
      desc: 'The troll brings both fists down with earth-shaking force. Deals {dmg} Common damage to everything within {radius} metres and hurls them back.' },
    { id: 'giant_stomp', name: 'Giant Stomp', icon: '🗿', family: 'giant', kind: 'melee', target: 'self', range: MELEE, power: 25, cooldown: 30,
      effects: [D(1.2, 'common', 7), STUN(3, 7)], anim: 'thrust', vfx: 'dust', sfx: 'blunt_hit',
      desc: 'The giant stamps and the ground heaves. Deals {dmg} Common damage to everything within {radius} metres and stuns them for {stun} seconds.' },
    { id: 'wight_drain', name: 'Chill Drain', icon: '💀', family: 'wight', kind: 'tactical', range: SHOUT, power: 15, cooldown: 15,
      effects: [D(0.4, 'frost'), DOT(0.5, 10, 2, 'frost'), HEAL(1.5, 'self')], anim: 'cast', vfx: 'smoke', sfx: 'wight_moan',
      desc: 'A grave-cold touch that draws the warmth from the living. Deals {dmg} Frost damage, a further {dot} Frost damage every {tick} seconds for {duration} seconds, and restores {heal} Morale to the wight.' },
    { id: 'goblin_poison_arrow', name: 'Poison Arrow', icon: '🏹', family: 'goblin', kind: 'ranged', range: 25, power: 12, cooldown: 12,
      effects: [D(0.8), DOT(0.3, 12, 2)], anim: 'shoot', vfx: 'arrow', sfx: 'bow_shoot',
      desc: 'A crude arrow smeared with goblin poison. Deals {dmg} Common damage and a further {dot} Common damage every {tick} seconds for {duration} seconds.' },
    { id: 'drake_breath', name: 'Fiery Breath', icon: '🔥', family: 'drake', kind: 'aoe', target: 'self', range: MELEE, power: 25, castTime: 1, cooldown: 18, cone: 60,
      effects: [D(1.6, 'fire', 6)], anim: 'cast', vfx: 'fire', sfx: 'fire_hit',
      desc: 'The drake draws breath and spews a gout of flame. Deals {dmg} Fire damage to everything within {radius} metres before it.' },
    { id: 'sorcerer_shadow_bolt', name: 'Shadow Bolt', icon: '🌑', family: 'sorcerer', kind: 'tactical', range: RANGED, power: 20, castTime: 1.5, cooldown: 8,
      effects: [D(1.5, 'lightning'), DEBUFF('armour', -10, 10)], anim: 'cast', vfx: 'bolt', sfx: 'spell_hit',
      desc: "A bolt of black lightning from Angmar's sorceries. Deals {dmg} Lightning damage and reduces the target's Armour by {amount} for {duration} seconds." },
    { id: 'warg_bite', name: 'Rending Bite', icon: '🐺', family: 'warg', kind: 'melee', range: MELEE, power: 10, cooldown: 10,
      effects: [D(1.0), DOT(0.3, 8, 2)], anim: 'slash', vfx: 'hit', sfx: 'wolf_howl',
      desc: 'A savage bite that tears the flesh. Deals {dmg} Common damage and a further {dot} Common damage every {tick} seconds for {duration} seconds.' },
    { id: 'spider_venom', name: 'Venomous Bite', icon: '🕷', family: 'spider', kind: 'melee', range: MELEE, power: 12, cooldown: 15,
      effects: [D(0.6), SLOW(40, 8), DOT(0.25, 10, 2)], anim: 'thrust', vfx: 'smoke', sfx: 'spider_hiss',
      desc: 'Fangs dripping with venom. Deals {dmg} Common damage, slows the target by {slow} for {slowDuration} seconds and poisons it for {dot} Common damage every {tick} seconds for {duration} seconds.' },
    { id: 'bear_maul', name: 'Maul', icon: '🐻', family: 'bear', kind: 'melee', range: MELEE, power: 15, cooldown: 12,
      effects: [D(1.6)], anim: 'slash', vfx: 'crit', sfx: 'bear_roar',
      desc: 'A mauling swipe of great claws. Deals {dmg} Common damage.' },
    { id: 'boar_charge', name: 'Charge', icon: '🐗', family: 'boar', kind: 'melee', range: MELEE, power: 10, cooldown: 15,
      effects: [D(1.2), KNOCK(4)], anim: 'thrust', vfx: 'dust', sfx: 'boar_grunt',
      desc: 'The boar lowers its tusks and charges. Deals {dmg} Common damage and hurls the target back.' },
    { id: 'orc_cleave', name: 'Cleave', icon: '⚔', family: 'orc', kind: 'melee', target: 'self', range: MELEE, power: 15, cooldown: 12,
      effects: [D(1.1, 'common', 4)], anim: 'slash', vfx: 'slash', sfx: 'orc_growl',
      desc: 'A wide, cleaving swing of a jagged blade. Deals {dmg} Common damage to everything within {radius} metres.' },
    { id: 'uruk_warcry', name: 'War-cry', icon: '📣', family: 'uruk', kind: 'buff', target: 'self', range: 0, power: 15, cooldown: 45,
      effects: [BUFF('physMastery', 20, 15)], anim: 'shout', vfx: 'buff', sfx: 'orc_growl',
      desc: 'A bellowing war-cry that drives the Uruk into a frenzy. Increases Physical Mastery by {amount} for {duration} seconds.' },
    { id: 'brigand_throw', name: 'Thrown Knife', icon: '🗡', family: 'brigand', kind: 'ranged', range: 20, power: 10, cooldown: 8,
      effects: [D(0.9)], anim: 'shoot', vfx: 'bolt', sfx: 'arrow_hit',
      desc: 'A knife flung from the hip. Deals {dmg} Common damage.' },
    { id: 'serpent_spray', name: 'Icy Spray', icon: '🌊', family: 'sea-serpent', kind: 'aoe', target: 'self', range: MELEE, power: 25, cooldown: 20,
      effects: [D(1.3, 'frost', 6), SLOW(30, 6, 6)], anim: 'cast', vfx: 'frost', sfx: 'splash',
      desc: 'The serpent rears and sprays freezing brine. Deals {dmg} Frost damage to everything within {radius} metres and slows them by {slow} for {slowDuration} seconds.' },
  ];

  // ------------------------------------------------------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------------------------------------------------------
  function _fmtMoney(copper) {
    if (typeof G.fmtMoney === 'function') return G.fmtMoney(copper);
    const c = Math.max(0, Math.round(copper || 0));
    const g = Math.floor(c / 100000), s = Math.floor((c % 100000) / 100), cp = c % 100;
    const parts = [];
    if (g) parts.push(g + 'g'); if (s || g) parts.push(s + 's'); parts.push(cp + 'c');
    return parts.join(' ');
  }
  function _esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;';
    });
  }
  function _num(v) { return typeof v === 'number' && isFinite(v); }

  function trainCost(a) {
    if (!a) return 0;
    const level = _num(a.level) ? a.level : 1;
    if (level <= 1 || a.monster) return 0;
    const xp = G.Data.xp;
    if (xp && typeof xp.abilityCost === 'function') {
      const v = xp.abilityCost(level);
      if (_num(v)) return Math.max(0, Math.round(v));
    }
    // Fallback curve (copper), rounded to whole silver: L4 ≈ 35s, L20 ≈ 5g 60s … L70 ≈ 61g. (100c = 1s, 1000s = 1g)
    return Math.round(level * level * 1.2 + level * 4) * 100;
  }

  function abilityMastery(a) {
    if (!a) return 'physMastery';
    if (a.mastery === 'phys') return 'physMastery';
    if (a.mastery === 'tact') return 'tactMastery';
    return (a.kind === 'melee' || a.kind === 'ranged') ? 'physMastery' : 'tactMastery';
  }

  let _monsterDmgCache = null;
  function _monsterTypeDmg(typeId) {
    if (!typeId) return 0;
    if (!_monsterDmgCache) {
      _monsterDmgCache = {};
      const world = G.Data.world;
      const types = world && Array.isArray(world.monsterTypes) ? world.monsterTypes : [];
      for (let i = 0; i < types.length; i++) if (types[i] && types[i].id) _monsterDmgCache[types[i].id] = _num(types[i].dmg) ? types[i].dmg : 0;
    }
    return _monsterDmgCache[typeId] || 0;
  }

  function _weaponAvg(a, ent) {
    if (!ent) return 0;
    const eq = ent.equipment;
    if (eq && typeof eq === 'object') {
      const slot = a && a.kind === 'ranged' ? 'ranged' : 'mainhand';
      const inst = eq[slot] || (slot === 'ranged' ? eq.mainhand : null);
      if (inst) {
        let view = null;
        if (G.Items && typeof G.Items.get === 'function') view = G.Items.get(inst);
        if (!view && G.Data.items && inst.tid) view = G.Data.items[inst.tid];
        const d = view && view.dmg;
        if (d && _num(d.min) && _num(d.max)) return (d.min + d.max) / 2;
      }
      return 0;
    }
    if (_num(ent.dmg)) return ent.dmg;
    if (ent.type && _num(ent.type.dmg)) return ent.type.dmg;
    return _monsterTypeDmg(ent.typeId);
  }

  function _masteryValue(a, ent) {
    if (!ent || !ent.stats) return null;
    const v = ent.stats[abilityMastery(a)];
    return _num(v) ? v : 0;
  }

  function _firstEffect(a, types) {
    if (!a || !Array.isArray(a.effects)) return null;
    for (let i = 0; i < a.effects.length; i++) if (a.effects[i] && types.indexOf(a.effects[i].type) >= 0) return a.effects[i];
    return null;
  }

  function abilityDamage(a, ent, effect) {
    a = _resolve(a);
    const e = effect || _firstEffect(a, ['damage']);
    if (!a || !e || e.type !== 'damage') return null;
    const mastery = _masteryValue(a, ent);
    if (mastery === null) return null;
    const avg = Math.max(1, e.mult * mastery / 4 + _weaponAvg(a, ent));
    return { min: Math.round(avg * 0.85), max: Math.round(avg * 1.15), avg: Math.round(avg), dtype: e.dtype || 'common', mastery: abilityMastery(a) };
  }

  function abilityHeal(a, ent, effect) {
    a = _resolve(a);
    const e = effect || _firstEffect(a, ['heal']);
    if (!a || !e || e.type !== 'heal') return 0;
    const mastery = _masteryValue(a, ent);
    if (mastery === null) return 0;
    return Math.round((_num(e.mult) ? e.mult * mastery / 4 : 0) + (_num(e.amount) ? e.amount : 0));
  }

  function abilityDot(a, ent, effect) {
    a = _resolve(a);
    const e = effect || _firstEffect(a, ['dot', 'hot']);
    if (!a || !e || (e.type !== 'dot' && e.type !== 'hot')) return null;
    const mastery = _masteryValue(a, ent);
    if (mastery === null) return null;
    const tick = _num(e.tick) && e.tick > 0 ? e.tick : 2;
    const ticks = Math.max(1, Math.floor((e.duration || tick) / tick));
    const perTick = Math.max(1, Math.round(e.mult * mastery / 4));
    return { perTick: perTick, total: perTick * ticks, ticks: ticks, tick: tick };
  }

  function _fmtPct(pct) { return Math.abs(Math.round(pct * 10) / 10) + '%'; }
  function _fmtDurationText(sec) {
    if (!_num(sec)) return '';
    if (sec >= 120 && sec % 60 === 0) return (sec / 60) + ' minutes';
    return sec + (sec === 1 ? ' second' : ' seconds');
  }
  function _fmtNum(v) { return _num(v) ? String(Math.round(v * 10) / 10) : String(v); }

  // Builds the placeholder dictionary for a description. Live values when ent has stats, else multipliers ("1.5×").
  function _descVars(a, ent) {
    const vars = {};
    const live = !!(ent && ent.stats);
    function set(k, v) {
      if (vars[k] === undefined) { vars[k] = v; return; }
      let n = 2; while (vars[k + n] !== undefined) n++; vars[k + n] = v;
    }
    const effects = Array.isArray(a.effects) ? a.effects : [];
    for (let i = 0; i < effects.length; i++) {
      const e = effects[i]; if (!e) continue;
      if (e.aoe) set('radius', _fmtNum(e.aoe));
      switch (e.type) {
        case 'damage': {
          const r = live ? abilityDamage(a, ent, e) : null;
          set('dmg', r ? String(r.avg) : (_fmtNum(e.mult) + '×'));
          set('dtype', DTYPE_NAMES[e.dtype] || 'Common');
          break;
        }
        case 'heal': {
          set('heal', live ? String(abilityHeal(a, ent, e)) : (_fmtNum(e.mult) + '×'));
          break;
        }
        case 'dot': case 'hot': {
          const r = live ? abilityDot(a, ent, e) : null;
          const key = e.type;
          set(key, r ? String(r.perTick) : (_fmtNum(e.mult) + '×'));
          set(key + 'Total', r ? String(r.total) : (_fmtNum(e.mult * Math.max(1, Math.floor((e.duration || 1) / (e.tick || 2)))) + '×'));
          set('tick', _fmtNum(e.tick || 2));
          set('duration', _fmtNum(e.duration));
          set('durationText', _fmtDurationText(e.duration));
          break;
        }
        case 'buff': case 'debuff': {
          set('amount', _num(e.pct) ? _fmtPct(e.pct) : _fmtNum(Math.abs(e.amount || 0)));
          set('stat', STAT_NAMES[e.stat] || e.stat || '');
          set('duration', _fmtNum(e.duration));
          set('durationText', _fmtDurationText(e.duration));
          break;
        }
        case 'stun': set('stun', _fmtNum(e.duration)); set('duration', _fmtNum(e.duration)); set('durationText', _fmtDurationText(e.duration)); break;
        case 'root': set('root', _fmtNum(e.duration)); set('duration', _fmtNum(e.duration)); set('durationText', _fmtDurationText(e.duration)); break;
        case 'slow':
          set('slow', _fmtPct(e.pct || 0)); set('slowDuration', _fmtNum(e.duration));
          set('duration', _fmtNum(e.duration)); set('durationText', _fmtDurationText(e.duration)); break;
        case 'knockback': set('force', _fmtNum(e.force)); break;
        default: break;
      }
    }
    vars.range = _fmtNum(a.range || 0);
    vars.power = _fmtNum(a.power || 0);
    vars.cooldown = _fmtNum(a.cooldown || 0);
    vars.cast = _fmtNum(a.castTime || 0);
    vars.level = _fmtNum(a.level || 1);
    vars.name = a.name || '';
    return vars;
  }

  function _fill(template, vars) {
    return String(template || '').replace(/\{(\w+)\}/g, function (m, k) { return vars[k] !== undefined ? vars[k] : m; });
  }

  function _resolve(a) {
    if (!a) return null;
    if (typeof a === 'string') return G.Data.abilities[a] || null;
    return a;
  }

  function abilityDesc(a, ent) {
    a = _resolve(a);
    if (!a) return '';
    return _fill(a.descTemplate || a.desc, _descVars(a, ent));
  }

  function abilityTooltipHTML(a, ent) {
    a = _resolve(a);
    if (!a) return '';
    const kindName = KIND_NAMES[a.kind] || a.kind;
    const line1 = [];
    if (a.monster) line1.push('Monster ability'); else line1.push('Level ' + a.level);
    line1.push(kindName);
    if (a.range > 0) line1.push('Range ' + _fmtNum(a.range) + ' m'); else line1.push(a.target === 'party' ? 'Fellowship' : 'Self');
    const line2 = [];
    line2.push(_fmtNum(a.power) + ' Power');
    line2.push(a.castTime > 0 ? _fmtNum(a.castTime) + ' s cast' : 'Instant');
    if (a.cooldown > 0) line2.push('Cooldown ' + _fmtNum(a.cooldown) + ' s');
    let html = '<div class="tt-name">' + _esc(a.icon || '') + ' ' + _esc(a.name) + '</div>';
    html += '<div class="tt-line">' + _esc(line1.join(' · ')) + '</div>';
    html += '<div class="tt-line">' + _esc(line2.join(' · ')) + '</div>';
    html += '<div class="tt-desc">' + _esc(abilityDesc(a, ent)) + '</div>';
    if (ent && !a.monster) {
      const trained = ent.abilities && typeof ent.abilities.has === 'function' ? ent.abilities.has(a.id)
        : (Array.isArray(ent.abilities) ? ent.abilities.indexOf(a.id) >= 0 : false);
      if (trained) html += '<div class="tt-stat">Trained</div>';
      else if (_num(ent.level) && ent.level < a.level) html += '<div class="tt-req">Requires level ' + a.level + '</div>';
      else html += '<div class="tt-line">Train for ' + _esc(a.cost > 0 ? _fmtMoney(a.cost) : 'free') + '</div>';
    } else if (!a.monster && a.level > 1) {
      html += '<div class="tt-line">Level ' + a.level + ' · ' + _esc(_fmtMoney(a.cost)) + ' to train</div>';
    }
    return html;
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Build the registry
  // ------------------------------------------------------------------------------------------------------------------
  const abilities = {};
  const byClass = {};
  const monsterAbilities = {};
  let order = 0;

  function defaultTarget(kind) {
    switch (kind) {
      case 'heal': return 'ally';
      case 'buff': case 'stance': return 'self';
      default: return 'enemy';
    }
  }

  function finalize(raw, cls) {
    const a = {
      id: raw.id, cls: cls, name: raw.name, icon: raw.icon || '✨', level: _num(raw.level) ? raw.level : 1,
      cost: 0,
      power: _num(raw.power) ? raw.power : pw(_num(raw.level) ? raw.level : 1, raw.pf),
      cooldown: _num(raw.cooldown) ? raw.cooldown : 0,
      castTime: _num(raw.castTime) ? raw.castTime : 0,
      range: _num(raw.range) ? raw.range : (raw.kind === 'melee' ? MELEE : RANGED),
      gcd: raw.gcd === undefined ? true : !!raw.gcd,
      kind: raw.kind,
      target: raw.target || defaultTarget(raw.kind),
      effects: Array.isArray(raw.effects) ? raw.effects.map(function (e) { return Object.assign({}, e); }) : [],
      anim: raw.anim, vfx: raw.vfx, sfx: raw.sfx,
      desc: raw.desc, descTemplate: raw.desc, descPlain: '',
      order: order++,
    };
    if (_num(raw.threat)) a.threat = raw.threat;
    if (raw.mastery) a.mastery = raw.mastery;
    if (_num(raw.cone)) a.cone = raw.cone;
    if (cls === 'monster') { a.monster = true; a.family = raw.family || null; }
    a.cost = trainCost(a);
    a.descPlain = _fill(a.descTemplate, _descVars(a, null));
    a.tooltip = function (ent) { return abilityTooltipHTML(a, ent); };
    return a;
  }

  Object.keys(CLASS_ABILITIES).forEach(function (cls) {
    byClass[cls] = CLASS_ABILITIES[cls].map(function (raw) {
      const a = finalize(raw, cls);
      abilities[a.id] = a;
      return a;
    });
  });
  byClass.monster = MONSTER_ABILITIES.map(function (raw) {
    const a = finalize(raw, 'monster');
    abilities[a.id] = a;
    monsterAbilities[a.id] = a;
    return a;
  });

  function abilitiesFor(clsId) {
    const list = byClass[clsId];
    if (!list) return [];
    return list.slice().sort(function (x, y) { return (x.level - y.level) || (x.order - y.order); });
  }
  function abilityById(id) { return (id && abilities[id]) || null; }
  function abilityKeyDefaults(clsId) { return abilitiesFor(clsId).map(function (a) { return a.id; }); }
  function monsterAbilitiesFor(family) {
    return byClass.monster.filter(function (a) { return !family || a.family === family; });
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Self-validation (misconfiguration only → console.warn; never throws)
  // ------------------------------------------------------------------------------------------------------------------
  (function validate() {
    const problems = [];
    Object.keys(byClass).forEach(function (cls) {
      const list = byClass[cls];
      if (cls !== 'monster') {
        const levels = list.map(function (a) { return a.level; });
        if (list.length !== 13 || levels.join(',') !== UNLOCK_LEVELS.join(',')) problems.push(cls + ': unlock levels ' + levels.join(','));
      }
      list.forEach(function (a) {
        if (!a.id || !a.name || !a.icon || !a.desc) problems.push(a.id + ': missing id/name/icon/desc');
        if (KINDS.indexOf(a.kind) < 0) problems.push(a.id + ': bad kind ' + a.kind);
        if (ANIMS.indexOf(a.anim) < 0) problems.push(a.id + ': bad anim ' + a.anim);
        if (VFX.indexOf(a.vfx) < 0) problems.push(a.id + ': bad vfx ' + a.vfx);
        if (SFX.indexOf(a.sfx) < 0) problems.push(a.id + ': bad sfx ' + a.sfx);
        if (TARGETS.indexOf(a.target) < 0) problems.push(a.id + ': bad target ' + a.target);
        if (!a.effects.length) problems.push(a.id + ': no effects');
        a.effects.forEach(function (e) {
          if (EFFECT_TYPES.indexOf(e.type) < 0) problems.push(a.id + ': bad effect type ' + e.type);
          if ((e.type === 'damage' || e.type === 'dot') && DTYPES.indexOf(e.dtype) < 0) problems.push(a.id + ': bad dtype ' + e.dtype);
          if ((e.type === 'buff' || e.type === 'debuff') && !STAT_NAMES[e.stat]) problems.push(a.id + ': bad stat ' + e.stat);
        });
        if (a.power < 10 || a.power > 60) problems.push(a.id + ': power out of band ' + a.power);
        if (a.cooldown < 0 || a.cooldown > 90) problems.push(a.id + ': cooldown out of band ' + a.cooldown);
        if (/\{\w+\}/.test(a.descPlain)) problems.push(a.id + ': unfilled placeholder in desc');
      });
    });
    if (problems.length) console.warn('[04_data_abilities] misconfigured abilities:\n' + problems.join('\n'));
  })();

  // ------------------------------------------------------------------------------------------------------------------
  // Export
  // ------------------------------------------------------------------------------------------------------------------
  G.Data.abilities = abilities;
  G.Data.monsterAbilities = monsterAbilities;
  G.Data.abilitiesFor = abilitiesFor;
  G.Data.abilityById = abilityById;
  G.Data.abilityDesc = abilityDesc;
  G.Data.abilityTooltipHTML = abilityTooltipHTML;
  G.Data.abilityDamage = abilityDamage;
  G.Data.abilityHeal = abilityHeal;
  G.Data.abilityDot = abilityDot;
  G.Data.abilityMastery = abilityMastery;
  G.Data.trainCost = trainCost;
  G.Data.abilityKeyDefaults = abilityKeyDefaults;
  G.Data.monsterAbilitiesFor = monsterAbilitiesFor;
  G.Data.ABILITY_UNLOCK_LEVELS = UNLOCK_LEVELS;
  G.Data.ABILITY_KINDS = KINDS;
  G.Data.ABILITY_ANIMS = ANIMS;
  G.Data.ABILITY_VFX = VFX;
  G.Data.ABILITY_SFX = SFX;
  G.Data.ABILITY_DTYPES = DTYPES;
  G.Data.ABILITY_EFFECT_TYPES = EFFECT_TYPES;
  G.Data.ABILITY_STAT_NAMES = STAT_NAMES;
})();
