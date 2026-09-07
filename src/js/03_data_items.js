/* ==== 03_data_items.js — Item templates (≈1,900), gear sets, procedural gear generation, inventory & equipment
   logic, loot tables and vendor stock for Chris Jensen's Lord of the Rings Online.
   Public API:
     G.Data.items (id → template), G.Data.sets (id → set), G.Data.addItem(tmpl) → template (validates/normalises,
     registers; safe for later quest files), G.Data.addSet(set) → set,
     G.Data.lostKingdom = { armour:{light:[tids], medium:[tids], heavy:[tids]}, weapons:{subtype: tid},
                            jewellery:[tids], sets:[setIds], mount: tid }   (granted by the final story quest)
     G.Items = { create, get, template, all, byType, bySlot, search, generate, bestInSlot, bestSet, lostKingdomSet,
                 starterGear, addToInventory, removeFromInventory, countInInventory, findInInventory, freeSlots,
                 usedSlots, moveSlot, sort, destroy, equip, equipDirect, unequip, canEquip, use, sellValue, buyValue,
                 tooltipHTML, compare, lootFor, rollGold, vendorStock, setBonuses, slotLabel, typeLabel, baseSlot,
                 pairSlots, slotsFor, iconHTML, rarityClass, rarityColor, rarityOf, isJunk, isEquippable, isUsable,
                 isTwoHanded, autoEquipBetter, score, dps, weaponPrefs, classCanWield, TIERS, tierFor, STAT_KEYS,
                 WEAPON_SUBTYPES, ARMOUR_SLOTS, JEWEL_SLOTS }
   Conventions (beyond §4.4):
     * Extra weapon subtypes 'throwing' (ranged-slot knives/axes for classes whose rangedWeapon is 'throwing') and
       'talisman' (off-hand focus for light-armour casters) so EVERY class can fill all 18 equipment slots.
     * Slot of a weapon subtype: bow/crossbow/javelin/throwing/staff/runestone/instrument → 'ranged' (matches
       class.rangedWeapon in §4.2), shield/talisman → 'offhand', everything else → 'mainhand'. Only 'halberd' is
       two-handed (blocks the off-hand). One-handed weapons may be equipped in the off-hand by dual-wield classes.
     * Paired jewellery templates use the base slot 'ear1'/'wrist1'/'ring1'; equip() picks the first free of the pair.
     * Generated gear instances carry overrides (name, ilvl, rarity, level, stats, dmg, value, visual) on top of a
       hidden base template (tid 'gen_*'); G.Items.get(inst) merges them.
     * Loot: lootFor() returns an array of instances with a `.gold` property (copper) attached.
   Private helpers prefixed with '_' are local to this file. ==== */
(function () {
  'use strict';
  const G = window.G;
  const C = G.C;
  G.Data = G.Data || {};
  const items = G.Data.items = G.Data.items || {};
  const sets = G.Data.sets = G.Data.sets || {};

  // ------------------------------------------------------------------ constants
  const RARITY = C.RARITY;                                      // ['common','uncommon','rare','incomparable','legendary']
  const RAR_IDX = {}; RARITY.forEach((r, i) => { RAR_IDX[r] = i; });
  const RAR_MULT = [1, 1.15, 1.35, 1.6, 1.9];                   // stat budget multiplier
  const RAR_ILVL = [0, 2, 5, 8, 12];                             // ilvl bonus over level*10
  const RAR_VALUE = [1, 1.4, 2.0, 3.0, 4.5];                     // vendor value multiplier
  const RAR_DMG = [1, 1.08, 1.18, 1.3, 1.45];                    // weapon damage multiplier
  const TYPES = ['weapon', 'armour', 'jewellery', 'consumable', 'material', 'quest', 'fish', 'misc', 'mount', 'bait'];
  const STAT_KEYS = ['might', 'agility', 'vitality', 'will', 'fate', 'maxMorale', 'maxPower', 'armour', 'physMastery',
    'tactMastery', 'crit', 'finesse', 'block', 'parry', 'evade', 'resist', 'moraleRegen', 'powerRegen', 'speed'];
  const STAT_SET = new Set(STAT_KEYS);
  const DMG_TYPES = ['common', 'beleriand', 'westernesse', 'ancientDwarf', 'fire', 'light', 'lightning', 'frost'];
  const ARMOUR_SLOTS = ['head', 'shoulder', 'back', 'chest', 'hands', 'legs', 'feet'];
  const JEWEL_SLOTS = ['neck', 'ear1', 'wrist1', 'ring1', 'pocket'];        // base slots of jewellery templates
  const WEAPON_SLOTS = ['mainhand', 'offhand', 'ranged'];
  const PAIRS = { ear1: ['ear1', 'ear2'], ear2: ['ear1', 'ear2'], wrist1: ['wrist1', 'wrist2'], wrist2: ['wrist1', 'wrist2'], ring1: ['ring1', 'ring2'], ring2: ['ring1', 'ring2'] };
  const BASE_SLOT = { ear2: 'ear1', wrist2: 'wrist1', ring2: 'ring1', ear: 'ear1', wrist: 'wrist1', ring: 'ring1' };
  const SLOT_LABEL = { head: 'Head', shoulder: 'Shoulders', back: 'Back', chest: 'Chest', hands: 'Hands', legs: 'Legs', feet: 'Feet',
    mainhand: 'Main-hand', offhand: 'Off-hand', ranged: 'Ranged', neck: 'Neck', ear1: 'Ear', ear2: 'Ear', wrist1: 'Wrist', wrist2: 'Wrist',
    ring1: 'Ring', ring2: 'Ring', pocket: 'Pocket' };
  const SLOT_MULT = { head: 0.8, shoulder: 0.7, back: 0.6, chest: 1.0, hands: 0.6, legs: 0.9, feet: 0.6, mainhand: 0.9, offhand: 0.6,
    ranged: 0.7, neck: 0.7, ear1: 0.4, wrist1: 0.45, ring1: 0.5, pocket: 0.6 };
  const ARMOUR_SLOT_BASE = { chest: 3.0, legs: 2.4, head: 1.9, shoulder: 1.5, hands: 1.2, feet: 1.2, back: 1.0 };
  const ARMOUR_TYPE_MULT = { light: 0.7, medium: 1.0, heavy: 1.35 };
  const ARMOUR_RANK = { light: 1, medium: 2, heavy: 3 };
  const RATING_MULT = { physMastery: 3, tactMastery: 3, crit: 3, finesse: 3, block: 3, parry: 3, evade: 3, resist: 3, maxMorale: 4, maxPower: 3, armour: 2, moraleRegen: 0.3, powerRegen: 0.3, speed: 0.1 };
  const STAT_NAMES = { might: 'Might', agility: 'Agility', vitality: 'Vitality', will: 'Will', fate: 'Fate', maxMorale: 'Maximum Morale',
    maxPower: 'Maximum Power', armour: 'Armour', physMastery: 'Physical Mastery', tactMastery: 'Tactical Mastery', crit: 'Critical Rating',
    finesse: 'Finesse', block: 'Block Rating', parry: 'Parry Rating', evade: 'Evade Rating', resist: 'Resistance', moraleRegen: 'Morale Regen',
    powerRegen: 'Power Regen', speed: 'Speed' };
  const DMG_LABEL = { common: 'Common', beleriand: 'Beleriand', westernesse: 'Westernesse', ancientDwarf: 'Ancient Dwarf-make', fire: 'Fire', light: 'Light', lightning: 'Lightning', frost: 'Frost' };
  const TIERS = [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80];
  const TWO_HANDED = new Set(['halberd']);

  // Weapon subtype registry. slot = equipment slot; prim = primary stat for class-agnostic tier items.
  const WEAPON = {
    sword:      { slot: 'mainhand', speed: 2.0, mult: 1.0,  shape: 'sword',     icon: '🗡', prim: 'might',   label: 'Sword',        nouns: ['Shortsword', 'Longsword', 'Broadsword', 'War-blade'] },
    axe:        { slot: 'mainhand', speed: 2.4, mult: 1.05, shape: 'axe',       icon: '🪓', prim: 'might',   label: 'Axe',          nouns: ['Hatchet', 'Hand-axe', 'War-axe', 'Bearded Axe'] },
    mace:       { slot: 'mainhand', speed: 2.6, mult: 1.05, shape: 'mace',      icon: '🔨', prim: 'might',   label: 'Mace',         nouns: ['Cudgel', 'Mace', 'Morning-star', 'War-hammer'] },
    dagger:     { slot: 'mainhand', speed: 1.4, mult: 0.9,  shape: 'dagger',    icon: '🔪', prim: 'agility', label: 'Dagger',       nouns: ['Knife', 'Dagger', 'Dirk', 'Stiletto'] },
    spear:      { slot: 'mainhand', speed: 2.4, mult: 1.0,  shape: 'spear',     icon: '🔱', prim: 'might',   label: 'Spear',        nouns: ['Hunting Spear', 'Spear', 'Boar-spear', 'War-spear'] },
    halberd:    { slot: 'mainhand', speed: 3.0, mult: 1.45, shape: 'halberd',   icon: '⚔', prim: 'might',   label: 'Halberd',      nouns: ['Pike', 'Halberd', 'Glaive', 'Great Halberd'], twoHanded: true },
    gauntlets:  { slot: 'mainhand', speed: 1.6, mult: 0.95, shape: 'gauntlets', icon: '👊', prim: 'might',   label: 'Battle Gauntlets', nouns: ['Hand-wraps', 'Knuckle-guards', 'Iron Knuckles', 'Battle Gauntlets'] },
    staff:      { slot: 'ranged',   speed: 2.8, mult: 1.0,  shape: 'staff',     icon: '🪄', prim: 'will',    label: 'Staff',        nouns: ['Walking Staff', 'Staff', 'Rune-staff', 'Lore-staff'], dtype: 'light' },
    runestone:  { slot: 'ranged',   speed: 2.2, mult: 0.9,  shape: 'runestone', icon: '🔮', prim: 'will',    label: 'Rune-stone',   nouns: ['Rune-stone', 'Carved Rune-stone', 'Rune-crystal', 'Star-stone'], dtype: 'lightning' },
    instrument: { slot: 'ranged',   speed: 2.5, mult: 0.8,  shape: 'lute',      icon: '🪕', prim: 'will',    label: 'Instrument',   nouns: ['Lute', 'Pipes', 'Harp', 'Silver Harp'], dtype: 'light' },
    bow:        { slot: 'ranged',   speed: 2.6, mult: 1.1,  shape: 'bow',       icon: '🏹', prim: 'agility', label: 'Bow',          nouns: ['Shortbow', 'Bow', 'Longbow', 'Great Bow'] },
    crossbow:   { slot: 'ranged',   speed: 3.0, mult: 1.2,  shape: 'crossbow',  icon: '🎯', prim: 'agility', label: 'Crossbow',     nouns: ['Light Crossbow', 'Crossbow', 'Heavy Crossbow', 'Arbalest'] },
    javelin:    { slot: 'ranged',   speed: 2.2, mult: 1.0,  shape: 'javelin',   icon: '➹', prim: 'might',   label: 'Javelin',      nouns: ['Throwing Spear', 'Javelin', 'Barbed Javelin', 'War-javelin'] },
    throwing:   { slot: 'ranged',   speed: 1.8, mult: 0.85, shape: 'dagger',    icon: '✴', prim: 'agility', label: 'Throwing Weapon', nouns: ['Throwing Stones', 'Throwing Knives', 'Throwing Axes', 'Throwing Daggers'] },
    shield:     { slot: 'offhand',  speed: 0,   mult: 0,    shape: 'shield',    icon: '🛡', prim: 'vitality', label: 'Shield',      nouns: ['Buckler', 'Round Shield', 'Kite Shield', 'Tower Shield'], noDmg: true },
    talisman:   { slot: 'offhand',  speed: 0,   mult: 0,    shape: 'runestone', icon: '📖', prim: 'will',    label: 'Talisman',     nouns: ['Charm', 'Talisman', 'Phial', 'Book of Lore'], noDmg: true },
  };
  const WEAPON_SUBTYPES = Object.keys(WEAPON);

  // Per-class weapon preferences (first entry = preferred). Merged with G.Data.classes[].weaponTypes/rangedWeapon at runtime.
  const CLASS_WEAPONS = {
    guardian:   { main: ['sword', 'axe', 'mace', 'dagger', 'spear'],              off: ['shield'],                         ranged: ['throwing', 'javelin'] },
    champion:   { main: ['sword', 'axe', 'mace', 'spear', 'dagger', 'halberd'],   off: ['sword', 'axe', 'mace', 'dagger'], ranged: ['throwing', 'bow'] },
    captain:    { main: ['sword', 'axe', 'mace', 'spear', 'dagger', 'halberd'],   off: ['shield'],                         ranged: ['javelin', 'throwing'] },
    hunter:     { main: ['sword', 'axe', 'dagger', 'spear', 'mace'],              off: ['dagger', 'sword', 'axe', 'mace'], ranged: ['bow', 'crossbow'] },
    burglar:    { main: ['dagger', 'sword', 'mace', 'axe'],                       off: ['dagger', 'sword', 'mace'],        ranged: ['throwing'] },
    minstrel:   { main: ['mace', 'sword', 'dagger'],                              off: ['shield', 'talisman'],             ranged: ['instrument'] },
    loremaster: { main: ['sword', 'dagger', 'mace'],                              off: ['talisman'],                       ranged: ['staff'] },
    runekeeper: { main: ['dagger', 'mace', 'sword'],                              off: ['talisman'],                       ranged: ['runestone'] },
    warden:     { main: ['spear', 'sword', 'axe', 'mace', 'dagger'],              off: ['shield'],                         ranged: ['javelin'] },
    brawler:    { main: ['gauntlets'],                                            off: ['gauntlets'],                      ranged: ['throwing'] },
  };
  const CLASS_ARMOUR = { guardian: 'heavy', champion: 'heavy', captain: 'heavy', hunter: 'medium', burglar: 'medium', warden: 'medium', brawler: 'medium', minstrel: 'light', loremaster: 'light', runekeeper: 'light' };
  const CLASS_MAINSTAT = { guardian: 'might', champion: 'might', captain: 'might', hunter: 'agility', burglar: 'agility', warden: 'agility', brawler: 'might', minstrel: 'will', loremaster: 'will', runekeeper: 'will' };
  const CLASS_NAME = { guardian: 'Guardian', champion: 'Champion', captain: 'Captain', hunter: 'Hunter', burglar: 'Burglar', minstrel: 'Minstrel', loremaster: 'Lore-master', runekeeper: 'Rune-keeper', warden: 'Warden', brawler: 'Brawler' };
  const TYPE_MAINSTAT = { heavy: 'might', medium: 'agility', light: 'will' };

  // Icon backgrounds (hex ints)
  const BG = { light: 0x5a4a8a, medium: 0x6a4a2a, heavy: 0x4a5566, jewel: 0x7a6a2a, weapon: 0x4a4a52, potion: 0x7a2020, power: 0x203a7a,
    food: 0x6a4a1a, drink: 0x5a3a10, scroll: 0x8a7a4a, fish: 0x2a5a7a, bait: 0x4a5a2a, material: 0x4a4a3a, junk: 0x3a3a3a, quest: 0x5a5a2a,
    mount: 0x5a3a1a, key: 0x6a6a5a, map: 0x4a6a4a, misc: 0x444444 };
  const ARMOUR_ICON = { head: '⛑', shoulder: '🧣', back: '🧥', chest: { light: '👘', medium: '🦺', heavy: '🥋' }, hands: '🧤', legs: '👖', feet: { light: '🥿', medium: '👢', heavy: '👢' } };
  const JEWEL_ICON = { neck: '📿', ear1: '💎', wrist1: '⛓', ring1: '💍', pocket: '🧿' };

  // ------------------------------------------------------------------ small helpers
  function _r(n) { return Math.round(n); }
  function _clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function _cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
  function _hex(n) { return '#' + ('000000' + ((n | 0) & 0xffffff).toString(16)).slice(-6); }
  function _shade(n, f) {
    const r = _clamp(_r(((n >> 16) & 255) * f), 0, 255), g = _clamp(_r(((n >> 8) & 255) * f), 0, 255), b = _clamp(_r((n & 255) * f), 0, 255);
    return _hex((r << 16) | (g << 8) | b);
  }
  function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function _fmtMoney(c) { return G.fmtMoney ? G.fmtMoney(c) : (c + 'c'); }
  let _uidCounter = 0;
  function _uid() { return G.uid ? G.uid() : ('i' + (++_uidCounter)); }
  function _rand() { return G.rand ? G.rand() : Math.random(); }
  function _chance(p) { return _rand() < p; }
  function _randInt(a, b) { return a + Math.floor(_rand() * (b - a + 1)); }
  function _pickR(rnd, arr) { return arr[Math.floor(rnd() * arr.length) % arr.length]; }
  function _hashStr(s) {
    if (G.hashStr) return G.hashStr(s);
    let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0;
  }
  function _rng(seed) {
    if (G.rng) return G.rng(seed);
    let a = (seed >>> 0) || 1;
    return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  function _emit(evt, arg) { if (G.emit) G.emit(evt, arg); }
  function _sfx(name) { if (G.Audio && G.Audio.sfx) G.Audio.sfx(name); }
  function _notify(text, kind) { if (G.UI && G.UI.notify) G.UI.notify(text, kind || 'warning'); }
  function _now() { return (G.time && typeof G.time.now === 'number') ? G.time.now : 0; }

  function baseSlot(slot) { return BASE_SLOT[slot] || slot; }
  function pairSlots(slot) { return PAIRS[slot] || null; }
  function tierFor(level) { let t = TIERS[0]; for (let i = 0; i < TIERS.length; i++) if (TIERS[i] <= level) t = TIERS[i]; return t; }
  function tierIndex(level) { let ti = 0; for (let i = 0; i < TIERS.length; i++) if (TIERS[i] <= level) ti = i; return ti; }
  function bandOf(ti) { return ti < 4 ? 0 : ti < 9 ? 1 : ti < 13 ? 2 : 3; }
  function classData(id) {
    const arr = G.Data.classes;
    if (Array.isArray(arr)) { for (let i = 0; i < arr.length; i++) if (arr[i] && arr[i].id === id) return arr[i]; }
    else if (arr && typeof arr === 'object' && arr[id]) return arr[id];
    return null;
  }
  function classArmourType(id) { const c = classData(id); return (c && c.armourType) || CLASS_ARMOUR[id] || 'medium'; }
  function classMainStat(id) { const c = classData(id); return (c && c.mainStat) || CLASS_MAINSTAT[id] || 'might'; }
  function className(id) { const c = classData(id); return (c && c.name) || CLASS_NAME[id] || _cap(id); }
  function isTactical(id) { return classMainStat(id) === 'will'; }

  // ------------------------------------------------------------------ stat budgets
  function budget(ilvl, rarity, slot) { return (3 + ilvl * 0.55) * RAR_MULT[RAR_IDX[rarity] || 0] * (SLOT_MULT[baseSlot(slot)] || 0.6); }
  function armourValue(ilvl, rarity, slot, at) {
    return _r((ARMOUR_SLOT_BASE[slot] || 1) * ilvl * 0.45 * (ARMOUR_TYPE_MULT[at] || 1) * (1 + (RAR_IDX[rarity] || 0) * 0.08));
  }
  function distribute(B, profile, rnd, variance) {
    let total = 0; for (let i = 0; i < profile.length; i++) total += profile[i][1];
    const out = {};
    for (let i = 0; i < profile.length; i++) {
      const s = profile[i][0], w = profile[i][1];
      let v = B * (w / total) * (RATING_MULT[s] || 1);
      if (rnd && variance) v *= 1 - variance + rnd() * variance * 2;
      v = Math.round(v);
      if (v >= 1) out[s] = (out[s] || 0) + v;
    }
    return out;
  }
  const PROFILES = {
    heavy:   [['might', 0.45], ['vitality', 0.3], ['fate', 0.08], ['physMastery', 0.17]],
    heavyB:  [['might', 0.42], ['vitality', 0.3], ['fate', 0.08], ['crit', 0.2]],
    medium:  [['agility', 0.4], ['vitality', 0.3], ['might', 0.12], ['crit', 0.18]],
    mediumB: [['agility', 0.4], ['vitality', 0.28], ['might', 0.12], ['physMastery', 0.2]],
    light:   [['will', 0.45], ['vitality', 0.28], ['fate', 0.1], ['tactMastery', 0.17]],
    lightB:  [['will', 0.42], ['vitality', 0.28], ['fate', 0.1], ['crit', 0.2]],
    jewel:   [['vitality', 0.34], ['might', 0.16], ['agility', 0.16], ['will', 0.16], ['crit', 0.18]],
    jewelB:  [['vitality', 0.3], ['might', 0.15], ['agility', 0.15], ['will', 0.15], ['fate', 0.1], ['finesse', 0.15]],
    might:   [['might', 0.5], ['vitality', 0.28], ['physMastery', 0.22]],
    agility: [['agility', 0.5], ['vitality', 0.28], ['crit', 0.22]],
    will:    [['will', 0.5], ['vitality', 0.28], ['tactMastery', 0.22]],
    vitality:[['vitality', 0.55], ['might', 0.15], ['block', 0.3]],
    tank:    [['vitality', 0.4], ['might', 0.25], ['block', 0.15], ['parry', 0.2]],
    caster:  [['will', 0.42], ['fate', 0.2], ['vitality', 0.16], ['tactMastery', 0.22]],
    healer:  [['will', 0.4], ['fate', 0.25], ['maxPower', 0.15], ['tactMastery', 0.2]],
    crit:    [['agility', 0.3], ['might', 0.2], ['fate', 0.2], ['crit', 0.3]],
    fate:    [['fate', 0.45], ['vitality', 0.3], ['crit', 0.25]],
    evasive: [['agility', 0.4], ['vitality', 0.25], ['evade', 0.2], ['finesse', 0.15]],
    morale:  [['vitality', 0.4], ['maxMorale', 0.35], ['might', 0.25]],
    all:     [['might', 0.2], ['agility', 0.2], ['will', 0.2], ['vitality', 0.25], ['fate', 0.15]],
    lkHeavy: [['might', 0.34], ['vitality', 0.26], ['fate', 0.08], ['physMastery', 0.12], ['crit', 0.1], ['finesse', 0.1]],
    lkMedium:[['agility', 0.28], ['might', 0.12], ['vitality', 0.24], ['fate', 0.08], ['physMastery', 0.1], ['crit', 0.1], ['finesse', 0.08]],
    lkLight: [['will', 0.34], ['vitality', 0.24], ['fate', 0.1], ['tactMastery', 0.12], ['crit', 0.1], ['finesse', 0.1]],
    lkJewel: [['might', 0.16], ['agility', 0.16], ['will', 0.16], ['vitality', 0.22], ['fate', 0.1], ['crit', 0.1], ['finesse', 0.1]],
  };
  function profileFor(key) { return Array.isArray(key) ? key : (PROFILES[key] || PROFILES.all); }
  function valueFor(ilvl, rarity, slot) {
    const base = 6 + ilvl * 2.2 + ilvl * ilvl * 0.05;
    return _r(base * RAR_VALUE[RAR_IDX[rarity] || 0] * (0.5 + (SLOT_MULT[baseSlot(slot)] || 0.6) * 0.5));
  }
  function weaponDmg(ilvl, rarity, sub) {
    const W = WEAPON[sub]; if (!W || W.noDmg) return null;
    const avg = (5 + ilvl * 0.5) * W.mult * (W.speed / 2.0) * RAR_DMG[RAR_IDX[rarity] || 0];
    return { min: Math.max(1, _r(avg * 0.8)), max: Math.max(2, _r(avg * 1.2)) };
  }

  // ------------------------------------------------------------------ registration & validation
  let _indexDirty = true;
  function addItem(t) {
    if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id) { console.warn('[items] addItem: template needs a string id', t); return null; }
    if (items[t.id] && items[t.id] !== t) console.warn('[items] duplicate item id "' + t.id + '" — replacing');
    if (!t.name) t.name = _cap(t.id.replace(/_/g, ' '));
    if (TYPES.indexOf(t.type) < 0) { console.warn('[items] item "' + t.id + '" has unknown type "' + t.type + '" — using misc'); t.type = 'misc'; }
    if (t.slot != null && C.EQUIP_SLOTS.indexOf(t.slot) < 0) {
      if (BASE_SLOT[t.slot]) t.slot = BASE_SLOT[t.slot];
      else { console.warn('[items] item "' + t.id + '" has unknown slot "' + t.slot + '"'); t.slot = null; }
    }
    if (t.slot == null) t.slot = null;
    if (t.subtype === undefined) t.subtype = null;
    if (t.armourType && !ARMOUR_TYPE_MULT[t.armourType]) { console.warn('[items] item "' + t.id + '" bad armourType'); t.armourType = null; }
    if (!t.armourType) t.armourType = null;
    t.level = _clamp(_r(+t.level || 1), 1, C.LEVEL_CAP || 80);
    if (!t.rarity || RAR_IDX[t.rarity] == null) t.rarity = 'common';
    if (t.ilvl == null) t.ilvl = t.level * 10 + RAR_ILVL[RAR_IDX[t.rarity]];
    if (!Array.isArray(t.classes) || !t.classes.length) t.classes = null;
    if (!t.stats || typeof t.stats !== 'object') t.stats = {};
    for (const k in t.stats) { if (!STAT_SET.has(k)) { console.warn('[items] item "' + t.id + '" unknown stat "' + k + '"'); delete t.stats[k]; } }
    if (t.type === 'weapon') {
      const W = WEAPON[t.subtype];
      if (!W) console.warn('[items] weapon "' + t.id + '" unknown subtype "' + t.subtype + '"');
      if (!t.slot && W) t.slot = W.slot;
      if (W && !W.noDmg) {
        if (!t.dmg) t.dmg = weaponDmg(t.ilvl, t.rarity, t.subtype);
        if (t.dmg && !t.dmg.type) t.dmg.type = W.dtype || 'common';
        if (t.dmg && DMG_TYPES.indexOf(t.dmg.type) < 0) t.dmg.type = 'common';
        if (!t.speed) t.speed = W.speed;
      } else { t.dmg = null; }
      if (!t.visual) t.visual = { weaponShape: W ? W.shape : 'sword', color: 0x9a9a9a };
      else if (!t.visual.weaponShape) t.visual.weaponShape = W ? W.shape : 'sword';
    } else if (t.dmg === undefined) t.dmg = null;
    if (t.type === 'armour' && !t.slot) console.warn('[items] armour "' + t.id + '" has no slot');
    if (t.set === undefined) t.set = null;
    if (t.value == null) t.value = (t.slot ? valueFor(t.ilvl, t.rarity, t.slot) : 5);
    t.value = Math.max(0, _r(t.value));
    if (!t.maxStack) t.maxStack = (t.slot || t.type === 'mount') ? 1 : (t.type === 'consumable' || t.type === 'bait' ? 20 : 100);
    if (!t.icon) t.icon = t.type === 'weapon' && WEAPON[t.subtype] ? WEAPON[t.subtype].icon : (t.type === 'quest' ? '📦' : '▪');
    if (t.iconBg == null) t.iconBg = BG[t.armourType] || BG[t.type] || BG.misc;
    if (!t.desc) t.desc = '';
    if (t.use && typeof t.use === 'object' && !t.use.kind) { console.warn('[items] item "' + t.id + '" use without kind'); t.use = null; }
    if (!t.use) t.use = null;
    items[t.id] = t;
    _indexDirty = true;
    return t;
  }
  function addSet(s) {
    if (!s || typeof s.id !== 'string') { console.warn('[items] addSet: set needs an id'); return null; }
    if (!s.name) s.name = _cap(s.id);
    if (!Array.isArray(s.pieces)) s.pieces = [];
    for (let i = 0; i < s.pieces.length; i++) if (!items[s.pieces[i]]) console.warn('[items] set "' + s.id + '" references missing item "' + s.pieces[i] + '"');
    if (!s.bonuses || typeof s.bonuses !== 'object') s.bonuses = {};
    for (const k in s.bonuses) { if (!(+k > 0) || typeof s.bonuses[k] !== 'object') { console.warn('[items] set "' + s.id + '" bad bonus key ' + k); delete s.bonuses[k]; } }
    if (!s.desc) s.desc = '';
    for (let i = 0; i < s.pieces.length; i++) { const t = items[s.pieces[i]]; if (t) t.set = s.id; }
    sets[s.id] = s;
    return s;
  }
  G.Data.addItem = addItem;
  G.Data.addSet = addSet;

  // ------------------------------------------------------------------ tier tables (hand-picked flavour per level band)
  const TIER = [
    { lvl: 1,  adjC: ['Worn', 'Plain'],               adjU: ['Sturdy', 'Well-kept'],              place: 'the Shire',           jewel: 'Copper',        mat: { light: 'Linen', medium: 'Leather', heavy: 'Iron' },                         wcol: 0x8a8a8a, dtype: 'common' },
    { lvl: 5,  adjC: ['Rustic', 'Farm-made'],         adjU: ["Bounder's", 'Hobbiton'],            place: 'Bywater',             jewel: 'Bronze',        mat: { light: 'Wool', medium: 'Hide', heavy: 'Riveted Iron' },                     wcol: 0x9a9a9a, dtype: 'common' },
    { lvl: 10, adjC: ['Iron', 'Bree-made'],           adjU: ['Bree-forged', 'Militia'],           place: 'Bree',                jewel: 'Brass',         mat: { light: 'Woollen', medium: 'Boiled Leather', heavy: 'Bree Iron' },           wcol: 0xa8a8a8, dtype: 'common' },
    { lvl: 15, adjC: ['Steel', 'Chetwood'],           adjU: ["Watcher's", 'Staddle'],             place: 'Archet',              jewel: 'Silver',        mat: { light: 'Dyed Linen', medium: 'Studded Leather', heavy: 'Steel' },           wcol: 0xb8bcc0, dtype: 'common' },
    { lvl: 20, adjC: ['Old Forest', 'Tempered'],      adjU: ["Barrow-warden's", 'Withywindle'],   place: 'the Old Forest',      jewel: 'Silvered',      mat: { light: 'Grey Wool', medium: 'Hardened Leather', heavy: 'Tempered Steel' },  wcol: 0xa0a8b0, dtype: 'westernesse' },
    { lvl: 25, adjC: ["Lone-lander's", 'Weathered'],  adjU: ['Forsaken', 'Weathertop'],           place: 'the Lone-lands',      jewel: 'Jade',          mat: { light: 'Homespun', medium: 'Scaled Leather', heavy: 'Blued Steel' },        wcol: 0x8fa0b8, dtype: 'common' },
    { lvl: 30, adjC: ["Ranger's", 'Dúnadan'],         adjU: ['Esteldín', 'Grey Company'],         place: 'Esteldín',            jewel: 'Amber',         mat: { light: 'Ranger-cloth', medium: 'Ranger Leather', heavy: 'Arnorian Steel' }, wcol: 0xc0c8d0, dtype: 'westernesse' },
    { lvl: 35, adjC: ['Fornost', 'Downs-forged'],     adjU: ['Trestlebridge', 'Arnorian'],        place: 'Fornost',             jewel: 'Gold',          mat: { light: 'Fine Wool', medium: 'Riveted Leather', heavy: 'Fornost Steel' },    wcol: 0xcfd4d8, dtype: 'westernesse' },
    { lvl: 40, adjC: ['Evendim', 'Lake-blessed'],     adjU: ['Annúminas', 'Tinnudir'],            place: 'Evendim',             jewel: 'Pearl',         mat: { light: 'Lake-silk', medium: 'Lake-leather', heavy: 'Annúminas Steel' },     wcol: 0xd8dde0, dtype: 'westernesse' },
    { lvl: 45, adjC: ['Trollshaw', 'Hoarwell'],       adjU: ['Thorenhad', 'Troll-bane'],          place: 'the Trollshaws',      jewel: 'Garnet',        mat: { light: 'Quilted', medium: 'Troll-hide', heavy: 'Hoarwell Steel' },          wcol: 0x9aa0a0, dtype: 'common' },
    { lvl: 50, adjC: ['Elven', 'Rivendell'],          adjU: ['Imladris', "Elrond's"],             place: 'Imladris',            jewel: 'Elven-silver',  mat: { light: 'Elven Silk', medium: 'Elven Leather', heavy: 'Elven Steel' },       wcol: 0xdfe8f0, dtype: 'beleriand', glow: 0x88aaff },
    { lvl: 55, adjC: ['Mountain', 'High Crag'],       adjU: ["Giant-slayer's", 'Snowbound'],      place: 'the Misty Mountains', jewel: 'Sapphire',      mat: { light: 'Snow-wool', medium: 'Goat-hide', heavy: 'Mountain Steel' },         wcol: 0xc8d8e8, dtype: 'common' },
    { lvl: 60, adjC: ['Moria-forged', 'Dwarf-steel'], adjU: ['Khazad', 'Mithril-etched'],         place: 'Khazad-dûm',          jewel: 'Mithril-laced', mat: { light: 'Dwarf-silk', medium: 'Dwarf-leather', heavy: 'Dwarf-steel' },       wcol: 0x9aa8bb, dtype: 'ancientDwarf' },
    { lvl: 65, adjC: ['Angmarim', 'Carn Dûm'],        adjU: ['Angmar-bane', 'Rammas'],            place: 'Angmar',              jewel: 'Onyx',          mat: { light: 'Black-silk', medium: 'Warg-hide', heavy: 'Angmarim Steel' },        wcol: 0x6a6070, dtype: 'westernesse' },
    { lvl: 70, adjC: ['Lossoth', 'Ice-bound'],        adjU: ['Forochel', 'Sûri-kylä'],            place: 'Forochel',            jewel: 'Ivory',         mat: { light: 'Sealskin', medium: 'Mammoth-hide', heavy: 'Ice-forged Steel' },     wcol: 0xbfe0f0, dtype: 'frost', glow: 0x9be8ff },
    { lvl: 75, adjC: ['Sea-tempered', 'Tol Fuin'],    adjU: ['Fuinlindë', 'Sundered Isle'],       place: 'Tol Fuin',            jewel: 'Sea-pearl',     mat: { light: 'Sea-silk', medium: 'Serpent-scale', heavy: 'Sea-steel' },           wcol: 0xd0e8e8, dtype: 'beleriand', glow: 0x88ffee },
    { lvl: 80, adjC: ['Himling', 'Draug-bane'],       adjU: ['Himring', 'Hapless'],               place: 'Himring',             jewel: 'Star-silver',   mat: { light: 'Star-silk', medium: 'Drake-scale', heavy: 'Mithril-plated' },       wcol: 0xe8f0ff, dtype: 'beleriand', glow: 0xffe8a0 },
  ];
  const ARMOUR_COLOR = { light: [0xd8cfb0, 0xb8b0c8, 0x8090c0, 0xe0e8ff], medium: [0x8a5a2a, 0x6a4a2a, 0x5a4030, 0x4a5040], heavy: [0x8a8a8a, 0xa8b0b8, 0x7a8898, 0xdfe8f0] };
  const ARMOUR_NOUNS = {
    light:  { head: ['Hood', 'Circlet', 'Cowl'], shoulder: ['Mantle', 'Shoulder-wrap', 'Epaulets'], back: ['Cape', 'Shawl'], chest: ['Robe', 'Tunic', 'Vestment'], hands: ['Mitts', 'Wraps'], legs: ['Trousers', 'Hose'], feet: ['Shoes', 'Slippers', 'Soft Boots'] },
    medium: { head: ['Cap', 'Coif', 'Leather Helm'], shoulder: ['Shoulder-guards', 'Shoulder-pads'], back: ['Cloak', 'Travelling Cloak'], chest: ['Jerkin', 'Jacket', 'Brigandine'], hands: ['Gloves', 'Handguards'], legs: ['Leggings', 'Breeches'], feet: ['Boots', 'Riding Boots'] },
    heavy:  { head: ['Helm', 'Great Helm', 'War-helm'], shoulder: ['Pauldrons', 'Spaulders'], back: ['War-cloak', 'Heavy Cloak'], chest: ['Breastplate', 'Cuirass', 'Hauberk'], hands: ['Gauntlets', 'Iron Gloves'], legs: ['Greaves', 'Leg-plates'], feet: ['Sabatons', 'Iron Boots'] },
  };
  const JEWEL_NOUNS = { neck: ['Necklace', 'Pendant', 'Torc', 'Amulet'], ear1: ['Earring', 'Ear-cuff', 'Ear-stud'], wrist1: ['Bracelet', 'Bracer', 'Armlet', 'Wristband'], ring1: ['Ring', 'Band', 'Signet'], pocket: ['Charm', 'Keepsake', 'Locket', 'Trinket'] };
  const JEWEL_LABEL = { neck: 'Necklace', ear1: 'Earring', wrist1: 'Bracelet', ring1: 'Ring', pocket: 'Pocket item' };

  // ------------------------------------------------------------------ template builders
  function weaponTemplate(o) {
    const W = WEAPON[o.sub];
    const rarity = o.rarity || 'common';
    const ilvl = o.ilvl != null ? o.ilvl : o.level * 10 + RAR_ILVL[RAR_IDX[rarity]];
    const B = budget(ilvl, rarity, W.slot) * (o.mult || 1);
    let stats;
    if (o.sub === 'shield') {
      stats = distribute(B, o.profile ? profileFor(o.profile) : PROFILES.vitality);
      stats.armour = _r(4.0 * ilvl * 0.45 * (1 + RAR_IDX[rarity] * 0.08) * (o.mult || 1));
    } else if (o.sub === 'talisman') {
      stats = distribute(B, o.profile ? profileFor(o.profile) : PROFILES.caster);
    } else {
      stats = distribute(B, o.profile ? profileFor(o.profile) : PROFILES[o.prim || W.prim]);
    }
    let dmg = null;
    if (!W.noDmg) { dmg = weaponDmg(ilvl, rarity, o.sub); if (o.mult) { dmg.min = _r(dmg.min * o.mult); dmg.max = _r(dmg.max * o.mult); } dmg.type = o.dtype || W.dtype || 'common'; }
    return {
      id: o.id, name: o.name, type: 'weapon', slot: W.slot, subtype: o.sub, armourType: null, level: o.level, ilvl, rarity,
      classes: o.classes || null, stats, dmg, speed: W.speed || 0, set: o.set || null,
      value: o.value != null ? o.value : valueFor(ilvl, rarity, W.slot), maxStack: 1, icon: W.icon,
      iconBg: o.iconBg != null ? o.iconBg : BG.weapon, desc: o.desc || '', flavor: o.flavor || '',
      visual: { weaponShape: W.shape, color: o.color != null ? o.color : 0x9a9a9a, glow: o.glow },
    };
  }
  function armourTemplate(o) {
    const rarity = o.rarity || 'common';
    const ilvl = o.ilvl != null ? o.ilvl : o.level * 10 + RAR_ILVL[RAR_IDX[rarity]];
    const at = o.at || 'medium';
    const B = budget(ilvl, rarity, o.slot) * (o.mult || 1);
    const stats = distribute(B, profileFor(o.profile || at));
    stats.armour = _r(armourValue(ilvl, rarity, o.slot, at) * (o.mult || 1));
    const ic = ARMOUR_ICON[o.slot]; const icon = typeof ic === 'string' ? ic : ic[at];
    return {
      id: o.id, name: o.name, type: 'armour', slot: o.slot, subtype: o.slot === 'back' ? 'cloak' : (o.subtype || at), armourType: o.anyType ? null : at,
      level: o.level, ilvl, rarity, classes: o.classes || null, stats, dmg: null, set: o.set || null,
      value: o.value != null ? o.value : valueFor(ilvl, rarity, o.slot), maxStack: 1, icon,
      iconBg: o.iconBg != null ? o.iconBg : BG[at], desc: o.desc || '', flavor: o.flavor || '',
      visual: { color: o.color != null ? o.color : ARMOUR_COLOR[at][0], glow: o.glow },
    };
  }
  function jewelTemplate(o) {
    const rarity = o.rarity || 'common';
    const ilvl = o.ilvl != null ? o.ilvl : o.level * 10 + RAR_ILVL[RAR_IDX[rarity]];
    const slot = baseSlot(o.slot);
    const B = budget(ilvl, rarity, slot) * (o.mult || 1);
    const stats = distribute(B, profileFor(o.profile || 'jewel'));
    return {
      id: o.id, name: o.name, type: 'jewellery', slot, subtype: JEWEL_LABEL[slot].toLowerCase().split(' ')[0], armourType: null,
      level: o.level, ilvl, rarity, classes: o.classes || null, stats, dmg: null, set: o.set || null,
      value: o.value != null ? o.value : valueFor(ilvl, rarity, slot), maxStack: 1, icon: o.icon || JEWEL_ICON[slot],
      iconBg: o.iconBg != null ? o.iconBg : BG.jewel, desc: o.desc || '', flavor: o.flavor || '',
      visual: { color: o.color != null ? o.color : 0xd4af5a, glow: o.glow },
    };
  }

  // ------------------------------------------------------------------ hidden base templates for generated gear
  ARMOUR_SLOTS.forEach(slot => { ['light', 'medium', 'heavy'].forEach(at => {
    const t = armourTemplate({ id: 'gen_a_' + at + '_' + slot, name: _cap(at) + ' ' + ARMOUR_NOUNS[at][slot][0], slot, at, level: 1 });
    t.hidden = true; addItem(t);
  }); });
  WEAPON_SUBTYPES.forEach(sub => { const t = weaponTemplate({ id: 'gen_w_' + sub, name: WEAPON[sub].nouns[1], sub, level: 1 }); t.hidden = true; addItem(t); });
  JEWEL_SLOTS.forEach(slot => { const t = jewelTemplate({ id: 'gen_j_' + slot, name: JEWEL_NOUNS[slot][0], slot, level: 1 }); t.hidden = true; addItem(t); });

  // ------------------------------------------------------------------ tiered weapons (every subtype × 17 tiers × common/uncommon)
  const WEAPON_DESC = { sword: 'A one-handed blade, the mainstay of the Free Peoples.', axe: 'A hewing axe, favoured by dwarves and woodsmen.', mace: 'A heavy bludgeon that cares nothing for armour.',
    dagger: 'A quick, light blade for close work.', spear: 'A long-hafted thrusting weapon.', halberd: 'A two-handed polearm with a wicked blade. Requires both hands.', gauntlets: 'Reinforced fighting gauntlets for the pugilist.',
    staff: "A lore-master's staff, humming with old power.", runestone: 'A rune-carved stone that channels the fury of the elements.', instrument: 'An instrument whose music rallies allies and dismays foes.',
    bow: 'A bow of seasoned wood. Deadly at range.', crossbow: 'A slow but punishing crossbow.', javelin: 'A weighted javelin for the throwing arm.', throwing: 'A bundle of thrown weapons for the quick-handed.',
    shield: 'Raise it and hold the line.', talisman: 'An off-hand focus for those who fight with lore and song.' };
  WEAPON_SUBTYPES.forEach((sub, si) => {
    const W = WEAPON[sub];
    TIERS.forEach((lvl, ti) => {
      const T = TIER[ti], band = bandOf(ti), noun = W.nouns[band];
      ['common', 'uncommon'].forEach((rar, ri) => {
        let name;
        if (ri === 0) name = T.adjC[si % T.adjC.length] + ' ' + noun;
        else name = ((si + ti) % 2 === 0) ? (T.adjU[si % T.adjU.length] + ' ' + noun) : (noun + ' of ' + T.place);
        let dtype = W.dtype || T.dtype;
        if (sub === 'runestone') dtype = ['lightning', 'fire', 'frost'][ti % 3];
        if (sub === 'staff') dtype = ti >= 12 ? 'fire' : 'light';
        addItem(weaponTemplate({ id: 'w_' + sub + '_' + lvl + '_' + rar.charAt(0), name, sub, level: lvl, rarity: rar, dtype,
          color: sub === 'bow' || sub === 'staff' || sub === 'crossbow' ? [0x8a6a3a, 0x7a5a2a, 0x6a4a2a, 0x5a3a1a][band] : T.wcol, glow: ri === 1 ? T.glow : undefined,
          desc: WEAPON_DESC[sub] }));
      });
    });
  });

  // ------------------------------------------------------------------ tiered armour (3 types × 7 slots × 17 tiers × common/uncommon)
  ['light', 'medium', 'heavy'].forEach((at, ai) => {
    ARMOUR_SLOTS.forEach((slot, sli) => {
      TIERS.forEach((lvl, ti) => {
        const T = TIER[ti], band = bandOf(ti);
        const nouns = ARMOUR_NOUNS[at][slot]; const noun = nouns[(ti + sli) % nouns.length];
        ['common', 'uncommon'].forEach((rar, ri) => {
          let name;
          if (ri === 0) name = T.mat[at] + ' ' + noun;
          else name = ((sli + ti) % 2 === 0) ? (T.adjU[sli % T.adjU.length] + ' ' + noun) : (noun + ' of ' + T.place);
          addItem(armourTemplate({ id: 'a_' + at + '_' + slot + '_' + lvl + '_' + rar.charAt(0), name, slot, at, level: lvl, rarity: rar,
            profile: (sli % 2 === 0) ? at : at + 'B', color: ARMOUR_COLOR[at][band], glow: ri === 1 ? T.glow : undefined,
            desc: _cap(at) + ' armour of ' + T.mat[at].toLowerCase() + ', ' + (ri ? 'made with care in ' + T.place + '.' : 'of plain make.') }));
        });
      });
    });
  });

  // ------------------------------------------------------------------ tiered jewellery (5 slots × 17 tiers × common/uncommon)
  JEWEL_SLOTS.forEach((slot, ji) => {
    TIERS.forEach((lvl, ti) => {
      const T = TIER[ti]; const nouns = JEWEL_NOUNS[slot]; const noun = nouns[(ti + ji) % nouns.length];
      ['common', 'uncommon'].forEach((rar, ri) => {
        let name;
        if (ri === 0) name = T.jewel + ' ' + noun;
        else name = ((ji + ti) % 2 === 0) ? (T.adjU[ji % T.adjU.length] + ' ' + noun) : (noun + ' of ' + T.place);
        addItem(jewelTemplate({ id: 'j_' + slot.replace(/1$/, '') + '_' + lvl + '_' + rar.charAt(0), name, slot, level: lvl, rarity: rar, profile: ri ? 'jewelB' : 'jewel',
          glow: ri === 1 ? T.glow : undefined, desc: 'A ' + noun.toLowerCase() + ' of ' + T.jewel.toLowerCase() + '.' }));
      });
    });
  });

  // ------------------------------------------------------------------ gear sets (9 families × 3 armour types)
  const SET_SLOTS = ['head', 'shoulder', 'chest', 'hands', 'legs', 'feet'];
  const FAMILIES = [
    { id: 'starter', lvl: 1, rar: 'uncommon', pat: 'prefix', prefix: { light: "Apprentice's", medium: "Recruit's", heavy: "Recruit's" }, names: { light: "Apprentice's Vestments", medium: "Recruit's Leathers", heavy: "Recruit's Mail" },
      desc: 'Simple but honest gear given to those who first take up arms for the Free Peoples.', color: { light: 0xd8cfb0, medium: 0x8a5a2a, heavy: 0x8a8a8a } },
    { id: 'wanderer', lvl: 10, rar: 'uncommon', pat: 'prefix', prefix: "Wanderer's", names: { light: "Wanderer's Raiment", medium: "Wanderer's Leathers", heavy: "Wanderer's Plate" },
      desc: 'Travel-worn gear of the kind carried by those who walk the roads between the Shire and Bree.', color: { light: 0xc8c0a0, medium: 0x7a5030, heavy: 0x9a9a9a } },
    { id: 'militia', lvl: 20, rar: 'uncommon', pat: 'prefix', prefix: 'Bree-land Militia', names: { light: 'Bree-land Militia Vestments', medium: 'Bree-land Militia Leathers', heavy: 'Bree-land Militia Plate' },
      desc: 'Standard issue of the Bree-land Militia, stamped with the sign of the Prancing Pony.', color: { light: 0xb0a890, medium: 0x6a4828, heavy: 0xa0a8b0 } },
    { id: 'ranger', lvl: 30, rar: 'rare', pat: 'prefix', prefix: "Ranger's", names: { light: "Ranger's Weeds", medium: "Ranger's Leathers", heavy: "Ranger's Mail" },
      desc: 'Grey-green gear of the Rangers of the North, made to pass unseen through the wild.', color: { light: 0x6a7a5a, medium: 0x4a5a3a, heavy: 0x6a7a70 } },
    { id: 'annuminas', lvl: 40, rar: 'rare', pat: 'of', of: 'Annúminas', names: { light: 'Vestments of Annúminas', medium: 'Leathers of Annúminas', heavy: 'Plate of Annúminas' },
      desc: 'Recovered from the drowned halls of the old capital of Arnor and restored by the smiths of Tinnudir.', color: { light: 0x8090c0, medium: 0x5a5a70, heavy: 0xc0c8d8 }, glow: 0x88aaff },
    { id: 'rivendell', lvl: 50, rar: 'rare', pat: 'of', of: 'Rivendell', names: { light: 'Raiment of Rivendell', medium: 'Leathers of Rivendell', heavy: 'Mail of Rivendell' },
      desc: 'Wrought in the Last Homely House; light as leaves and strong as the roots of the mountains.', color: { light: 0xa8c0e8, medium: 0x5a7060, heavy: 0xdfe8f0 }, glow: 0x88aaff },
    { id: 'moria', lvl: 60, rar: 'incomparable', pat: 'prefix', prefix: 'Moria-forged', names: { light: 'Moria-forged Vestments', medium: 'Moria-forged Leathers', heavy: 'Moria-forged Plate' },
      desc: 'Forged in the deep furnaces of Khazad-dûm by the Iron Garrison. Nothing lighter, nothing stronger.', color: { light: 0x6a6a9a, medium: 0x4a4a50, heavy: 0x9aa8bb }, glow: 0xffa040 },
    { id: 'angmarbane', lvl: 70, rar: 'incomparable', pat: 'prefix', prefix: 'Angmar-bane', names: { light: 'Angmar-bane Robes', medium: 'Angmar-bane Leathers', heavy: 'Angmar-bane Plate' },
      desc: 'Blessed against the sorcery of Carn Dûm; worn by those who broke the gates of Angmar.', color: { light: 0x3a3050, medium: 0x2a2a30, heavy: 0x5a5060 }, glow: 0xc080ff },
    { id: 'lostkingdom', lvl: 80, rar: 'legendary', pat: 'of', of: 'the Lost Kingdom', names: { light: 'Armour of the Lost Kingdom (Light)', medium: 'Armour of the Lost Kingdom (Medium)', heavy: 'Armour of the Lost Kingdom (Heavy)' },
      desc: 'The regalia of the lost kingdom of Arnor, restored at last to a worthy bearer. The finest armour in all of Middle-earth.', color: { light: 0xe0e8ff, medium: 0x8a7a40, heavy: 0xfff0c0 }, glow: 0xffe8a0, slots: ARMOUR_SLOTS, mult: 1.2 },
  ];
  const lostKingdom = G.Data.lostKingdom = { armour: { light: [], medium: [], heavy: [] }, weapons: {}, jewellery: [], sets: [], mount: 'mount_lostkingdom' };
  function setBonusesFor(lvl, at, family) {
    const main = TYPE_MAINSTAT[at]; const mastery = at === 'light' ? 'tactMastery' : 'physMastery';
    if (family.id === 'lostkingdom') {
      const b = { 2: { vitality: _r(lvl * 1.2) }, 4: { might: _r(lvl * 0.9), agility: _r(lvl * 0.9), will: _r(lvl * 0.9), maxMorale: lvl * 8 }, 6: { crit: lvl * 6, physMastery: lvl * 5, tactMastery: lvl * 5, fate: _r(lvl * 0.6) }, 7: { maxMorale: lvl * 15, armour: lvl * 12, finesse: lvl * 5 } };
      return b;
    }
    const b = {}; b[2] = { vitality: _r(lvl * 0.5 + 3) }; b[4] = {}; b[4][main] = _r(lvl * 0.7 + 4); b[4].maxMorale = _r(lvl * 3 + 15);
    b[6] = { crit: _r(lvl * 3 + 10) }; b[6][mastery] = _r(lvl * 3 + 10);
    if (at === 'medium') b[4].might = _r(lvl * 0.3 + 2);
    return b;
  }
  FAMILIES.forEach((F, fi) => {
    ['light', 'medium', 'heavy'].forEach(at => {
      const setId = 'set_' + F.id + '_' + at; const pieces = []; const slotsUsed = F.slots || SET_SLOTS;
      slotsUsed.forEach((slot, sli) => {
        const nouns = ARMOUR_NOUNS[at][slot]; const noun = nouns[fi % nouns.length];
        const prefix = typeof F.prefix === 'object' ? F.prefix[at] : F.prefix;
        const name = F.pat === 'of' ? (noun + ' of ' + F.of) : (prefix + ' ' + noun);
        const id = 's_' + F.id + '_' + at + '_' + slot;
        addItem(armourTemplate({ id, name, slot, at, level: F.lvl, rarity: F.rar, profile: F.id === 'lostkingdom' ? ('lk' + _cap(at)) : ((sli % 2) ? at + 'B' : at),
          mult: F.mult || 1.08, ilvl: F.id === 'lostkingdom' ? 815 : undefined, color: F.color[at], glow: F.glow, set: setId,
          desc: F.desc, flavor: F.id === 'lostkingdom' ? 'Part of the Armour of the Lost Kingdom.' : ('Part of the ' + F.names[at] + '.') }));
        pieces.push(id);
        if (F.id === 'lostkingdom') lostKingdom.armour[at].push(id);
      });
      addSet({ id: setId, name: F.names[at], family: F.id, armourType: at, level: F.lvl, rarity: F.rar, pieces, bonuses: setBonusesFor(F.lvl, at, F), desc: F.desc });
      if (F.id === 'lostkingdom') lostKingdom.sets.push(setId);
    });
  });

  // Lost Kingdom weapons (every subtype) and jewellery (8 pieces for the 8 jewellery slots)
  const LK_WEAPON_NOUN = { sword: 'Blade', axe: 'War-axe', mace: 'Sceptre', dagger: 'Knife', spear: 'Spear', halberd: 'Halberd', gauntlets: 'Battle Gauntlets', staff: 'Staff', runestone: 'Rune-stone',
    instrument: 'Harp', bow: 'Bow', crossbow: 'Crossbow', javelin: 'Javelin', throwing: 'Throwing Knives', shield: 'Shield', talisman: 'Phial' };
  const LK_PROFILE = { might: 'lkHeavy', agility: 'lkMedium', will: 'lkLight', vitality: 'lkHeavy' };
  (function () {
    const pieces = [];
    WEAPON_SUBTYPES.forEach(sub => {
      const W = WEAPON[sub]; const id = 'lk_w_' + sub;
      const dtype = sub === 'runestone' ? 'lightning' : sub === 'staff' || sub === 'instrument' ? 'light' : 'beleriand';
      addItem(weaponTemplate({ id, name: LK_WEAPON_NOUN[sub] + ' of the Lost Kingdom', sub, level: 80, rarity: 'legendary', ilvl: 815, mult: 1.2, profile: sub === 'shield' ? 'tank' : LK_PROFILE[W.prim], dtype,
        color: 0xfff0c0, glow: 0xffe8a0, iconBg: 0x8a6a1a, set: 'set_lostkingdom_arms', desc: 'A weapon of the lost kingdom of Arnor, reforged for the final battle.', flavor: 'The star of the Dúnedain is graven upon it.' }));
      // Brawlers need two distinct gauntlet items for main- and off-hand
      pieces.push(id); lostKingdom.weapons[sub] = id;
    });
    addItem(weaponTemplate({ id: 'lk_w_gauntlets_off', name: 'Cestus of the Lost Kingdom', sub: 'gauntlets', level: 80, rarity: 'legendary', ilvl: 815, mult: 1.2, profile: 'lkHeavy', dtype: 'beleriand',
      color: 0xfff0c0, glow: 0xffe8a0, iconBg: 0x8a6a1a, set: 'set_lostkingdom_arms', desc: 'The off-hand gauntlet of the lost kingdom.', flavor: 'The star of the Dúnedain is graven upon it.' }));
    pieces.push('lk_w_gauntlets_off'); lostKingdom.weapons.gauntlets_off = 'lk_w_gauntlets_off';
    addSet({ id: 'set_lostkingdom_arms', name: 'Arms of the Lost Kingdom', family: 'lostkingdom', level: 80, rarity: 'legendary', pieces,
      bonuses: { 2: { physMastery: 400, tactMastery: 400 }, 3: { crit: 500, finesse: 400, fate: 60 } }, desc: 'The reforged weapons of the lost kingdom of Arnor.' });
    lostKingdom.sets.push('set_lostkingdom_arms');
    const jew = [['neck', 'Torc'], ['ear1', 'Earring'], ['ear1', 'Ear-cuff'], ['wrist1', 'Bracelet'], ['wrist1', 'Armlet'], ['ring1', 'Ring'], ['ring1', 'Signet'], ['pocket', 'Keepsake']];
    const jp = [];
    jew.forEach((j, i) => {
      const id = 'lk_j_' + j[1].toLowerCase().replace(/[^a-z]/g, '');
      addItem(jewelTemplate({ id, name: j[1] + ' of the Lost Kingdom', slot: j[0], level: 80, rarity: 'legendary', ilvl: 815, mult: 1.2, profile: 'lkJewel', color: 0xfff0c0, glow: 0xffe8a0, iconBg: 0x8a6a1a,
        set: 'set_lostkingdom_jewels', desc: 'A jewel of the lost kingdom of Arnor.', flavor: 'It gleams with a light that was not made in these latter days.' }));
      jp.push(id); lostKingdom.jewellery.push(id);
    });
    addSet({ id: 'set_lostkingdom_jewels', name: 'Jewels of the Lost Kingdom', family: 'lostkingdom', level: 80, rarity: 'legendary', pieces: jp,
      bonuses: { 2: { vitality: 100 }, 4: { fate: 80, maxPower: 600 }, 6: { crit: 600, maxMorale: 1500 }, 8: { might: 120, agility: 120, will: 120, finesse: 500 } }, desc: 'The jewels of the lost kingdom of Arnor.' });
    lostKingdom.sets.push('set_lostkingdom_jewels');
  })();

  // ------------------------------------------------------------------ named stand-alone items (hand-written)
  // N(id, name, spec, flavour). spec: {w:subtype | a:slot | j:slot, at, lvl, rar, prof, dtype, color, glow, classes, any}
  function N(id, name, s, flavor) {
    const lvl = s.lvl, rar = s.rar || 'rare';
    if (s.w) {
      addItem(weaponTemplate({ id, name, sub: s.w, level: lvl, rarity: rar, profile: s.prof, dtype: s.dtype, color: s.color, glow: s.glow, classes: s.classes, mult: 1.06, desc: s.desc || WEAPON_DESC[s.w], flavor, iconBg: s.bg }));
    } else if (s.a) {
      addItem(armourTemplate({ id, name, slot: s.a, at: s.at || 'medium', anyType: !!s.any, level: lvl, rarity: rar, profile: s.prof, color: s.color, glow: s.glow, classes: s.classes, mult: 1.06, desc: s.desc || '', flavor, iconBg: s.bg }));
    } else if (s.j) {
      addItem(jewelTemplate({ id, name, slot: s.j, level: lvl, rarity: rar, profile: s.prof, color: s.color, glow: s.glow, classes: s.classes, mult: 1.06, desc: s.desc || '', flavor, icon: s.icon, iconBg: s.bg }));
    }
  }
  // Cloaks (usable by every class)
  N('n_bounders_cloak', "Bounder's Cloak", { a: 'back', at: 'light', any: 1, lvl: 5, rar: 'uncommon', prof: 'evasive', color: 0x4a6a3a }, 'Issued to every hobbit who patrols the borders of the Shire. Smells faintly of pipe-weed.');
  N('n_cloak_withywindle', 'Cloak of the Withywindle', { a: 'back', at: 'light', any: 1, lvl: 20, rar: 'rare', prof: 'evasive', color: 0x3a5a3a }, 'Woven of willow-green thread on the banks of the Withywindle, where old Tom sings.');
  N('n_cloak_barrow', 'Shroud of the Barrow-downs', { a: 'back', at: 'light', any: 1, lvl: 25, rar: 'rare', prof: 'caster', color: 0x4a4a5a }, 'Taken from a barrow. It is very cold, and it never quite dries.');
  N('n_cloak_grey_company', 'Cloak of the Grey Company', { a: 'back', at: 'medium', any: 1, lvl: 30, rar: 'rare', prof: 'agility', color: 0x6a7a70 }, 'Woven in Esteldín; grey as the mist over the Downs. Those who wear it are seldom seen before they choose to be.');
  N('n_cloak_elven_imladris', 'Elven Cloak of Imladris', { a: 'back', at: 'light', any: 1, lvl: 50, rar: 'incomparable', prof: 'all', color: 0x8090c0, glow: 0x88aaff }, 'A gift of the Last Homely House. Its colour shifts with the land like the leaves of a wood in changing light.');
  N('n_cloak_moria', 'Cloak of the Iron Garrison', { a: 'back', at: 'heavy', any: 1, lvl: 60, rar: 'rare', prof: 'tank', color: 0x5a5a60 }, 'Stitched with the sigil of the Iron Garrison who reclaimed Khazad-dûm.');
  N('n_cloak_lossoth', 'Sealskin Cloak of the Lossoth', { a: 'back', at: 'medium', any: 1, lvl: 70, rar: 'rare', prof: 'morale', color: 0xbfd0d8 }, 'The Lossoth make these for their hunters. Warm even on the Ice-bay in the depths of winter.');
  N('n_cloak_himring', 'Cloak of the Lord of Himring', { a: 'back', at: 'heavy', any: 1, lvl: 78, rar: 'incomparable', prof: 'all', color: 0x8a1a1a, glow: 0xff9c3a }, 'Crimson and gold, in the colours of the house that once held the fortress of Himring against the North.');
  // Helms and hoods
  N('n_cap_bounder', "Bounder's Cap", { a: 'head', at: 'medium', lvl: 6, rar: 'uncommon', prof: 'evasive', color: 0x6a5a2a }, 'A leather cap with a feather stuck in it. Regulation, apparently.');
  N('n_helm_bree_watch', 'Helm of the Bree Watch', { a: 'head', at: 'heavy', lvl: 12, rar: 'uncommon', prof: 'tank', color: 0x9a9a9a }, 'Dented in a dozen places from a dozen tavern brawls.');
  N('n_hood_ranger', 'Hood of the Grey Company', { a: 'head', at: 'medium', lvl: 32, rar: 'rare', prof: 'agility', color: 0x5a6a5a }, 'Deep enough to hide a face and a purpose both.');
  N('n_helm_fornost', 'Crown-helm of Fornost', { a: 'head', at: 'heavy', lvl: 37, rar: 'rare', prof: 'heavy', color: 0xcfd4d8, glow: 0xffe8a0 }, 'Dug from the ruins of Fornost Erain, where the last host of Arthedain was broken.');
  N('n_circlet_imladris', 'Circlet of Imladris', { a: 'head', at: 'light', lvl: 50, rar: 'rare', prof: 'caster', color: 0xdfe8f0, glow: 0x88aaff }, 'A slender band of elven-silver set with a single white gem.');
  N('n_mantle_highcrag_helm', 'Snow-hood of High Crag', { a: 'head', at: 'light', lvl: 56, rar: 'rare', prof: 'healer', color: 0xe8f0ff }, 'Lined with the fur of a mountain goat. The wind of the high passes cannot find its way in.');
  N('n_helm_iron_garrison', 'Helm of the Iron Garrison', { a: 'head', at: 'heavy', lvl: 60, rar: 'incomparable', prof: 'tank', color: 0x9aa8bb, glow: 0xffa040 }, 'Forged by the dwarves who went back into Moria, and made to be worn at the Bridge.');
  N('n_helm_khazad', 'Great Helm of Khazad-dûm', { a: 'head', at: 'heavy', lvl: 62, rar: 'incomparable', prof: 'heavy', color: 0x8a98ab, glow: 0xffa040 }, 'Runes of the Longbeards run about its brow. It has seen the Dimrill Stair and come back.');
  N('n_hood_lossoth', 'Fur-lined Hood of Sûri-kylä', { a: 'head', at: 'light', lvl: 70, rar: 'rare', prof: 'light', color: 0xd8e0e8 }, 'A white hood of the Lossoth, trimmed with fox-fur.');
  // Shoulders
  N('n_mantle_lune', 'Mantle of the Lune', { a: 'shoulder', at: 'light', lvl: 14, rar: 'uncommon', prof: 'light', color: 0x8090c0 }, 'Blue as the Gulf of Lune on a summer morning.');
  N('n_pauldrons_fornost', 'Pauldrons of the Fornost Guard', { a: 'shoulder', at: 'heavy', lvl: 36, rar: 'rare', prof: 'tank', color: 0xcfd4d8 }, 'Heavy, scarred and unbroken, like the men who wore them.');
  N('n_shoulders_tinnudir', 'Shoulder-guards of Tinnudir', { a: 'shoulder', at: 'medium', lvl: 40, rar: 'rare', prof: 'medium', color: 0x5a5a70 }, 'Made on the island of Tinnudir from the hide of the great boars of Evendim.');
  N('n_mantle_highcrag', 'Snowbound Mantle of High Crag', { a: 'shoulder', at: 'light', lvl: 56, rar: 'rare', prof: 'caster', color: 0xe8f0ff }, 'Frost never melts from its fringe.');
  N('n_spaulders_angmar', 'Spaulders of the Carn Dûm Breaker', { a: 'shoulder', at: 'heavy', lvl: 67, rar: 'incomparable', prof: 'heavy', color: 0x5a5060, glow: 0xc080ff }, 'Worn by the captain who first set foot upon the walls of Carn Dûm.');
  N('n_mantle_sea', 'Mantle of the Sundered Isles', { a: 'shoulder', at: 'medium', lvl: 76, rar: 'incomparable', prof: 'crit', color: 0x2a6a7a, glow: 0x88ffee }, 'Salt-stained and sea-blue, from the havens of Tol Fuin.');
  // Chests
  N('n_mail_thorin', "Hauberk of Thorin's Hall", { a: 'chest', at: 'heavy', lvl: 15, rar: 'rare', prof: 'tank', color: 0xa8b0b8 }, 'Fine dwarf-mail from the forges under the Blue Mountains. Every ring is stamped with an anvil.');
  N('n_tunic_withywindle', 'Tunic of the Withywindle', { a: 'chest', at: 'light', lvl: 22, rar: 'rare', prof: 'healer', color: 0x5a7a4a }, 'Yellow as Goldberry\'s hair, green as the river-reeds.');
  N('n_jerkin_esteldin', 'Jerkin of the Esteldín Rangers', { a: 'chest', at: 'medium', lvl: 30, rar: 'rare', prof: 'mediumB', color: 0x4a5a3a }, 'Oiled leather, patched and re-patched by a dozen hands over a hundred years.');
  N('n_cuirass_arnor', 'Cuirass of the Kings of Arnor', { a: 'chest', at: 'heavy', lvl: 42, rar: 'incomparable', prof: 'heavy', color: 0xc0c8d8, glow: 0xffe8a0 }, 'Recovered from the drowned throne-room of Annúminas. The Seven Stars are still bright upon it.');
  N('n_jerkin_trollshaw', 'Stone-troll Jerkin', { a: 'chest', at: 'medium', lvl: 46, rar: 'rare', prof: 'morale', color: 0x5a5040 }, 'Cut from a stone-troll who went back to the dark a little too slowly.');
  N('n_robe_elrond', "Robe of Elrond's Council", { a: 'chest', at: 'light', lvl: 52, rar: 'incomparable', prof: 'caster', color: 0xa8c0e8, glow: 0x88aaff }, 'Worn by those who sat in council in the Hall of Fire, when great matters were decided.');
  N('n_robe_ice_mage', "Ice-seer's Robe", { a: 'chest', at: 'light', lvl: 70, rar: 'rare', prof: 'caster', color: 0xbfd8e8, glow: 0x9be8ff }, 'The seers of the Lossoth read the ice and the stars. This robe is bleached by both.');
  N('n_plate_angmar', 'Breastplate of the Angmar-bane', { a: 'chest', at: 'heavy', lvl: 68, rar: 'incomparable', prof: 'tank', color: 0x5a5060, glow: 0xc080ff }, 'Black steel, warded against the sorcery of the Witch-realm.');
  N('n_hauberk_himring', 'Hauberk of the Himring Guard', { a: 'chest', at: 'heavy', lvl: 77, rar: 'incomparable', prof: 'heavy', color: 0x8a1a1a, glow: 0xff9c3a }, 'Red-enamelled mail in the fashion of the Elder Days.');
  // Hands
  N('n_gloves_hobbiton', 'Gardener\'s Gloves of Hobbiton', { a: 'hands', at: 'light', lvl: 3, rar: 'uncommon', prof: 'healer', color: 0x8a7a4a }, 'Good for potatoes. Surprisingly good for everything else.');
  N('n_gauntlets_thorin', "Gauntlets of Thorin's Guard", { a: 'hands', at: 'heavy', lvl: 14, rar: 'rare', prof: 'heavyB', color: 0xa8b0b8 }, 'Heavy, plated and very hard to argue with.');
  N('n_gloves_archer', 'Archer\'s Gloves of the North Downs', { a: 'hands', at: 'medium', lvl: 34, rar: 'rare', prof: 'crit', color: 0x6a5a3a }, 'Worn thin at the fingertips by a thousand bowstrings.');
  N('n_gloves_elven', 'Silken Gloves of Imladris', { a: 'hands', at: 'light', lvl: 51, rar: 'rare', prof: 'healer', color: 0xdfe8f0, glow: 0x88aaff }, 'They leave no fingerprints on anything, including hearts.');
  N('n_gauntlets_moria', 'Mithril-scaled Gauntlets', { a: 'hands', at: 'heavy', lvl: 61, rar: 'incomparable', prof: 'heavy', color: 0xdfe8f0, glow: 0xffa040 }, 'Scales of true-silver on the backs of the hands. The dwarves do not part with these lightly.');
  N('n_gloves_lossoth', 'Sealskin Mittens of the Lossoth', { a: 'hands', at: 'medium', lvl: 71, rar: 'rare', prof: 'medium', color: 0xbfd0d8 }, 'Warm, waterproof and only slightly fishy.');
  // Legs
  N('n_leggings_ranger', "Ranger's Riding Breeches", { a: 'legs', at: 'medium', lvl: 31, rar: 'rare', prof: 'medium', color: 0x4a5a3a }, 'Reinforced at the knee for long days in the saddle.');
  N('n_greaves_annuminas', 'Greaves of the Lake-guard', { a: 'legs', at: 'heavy', lvl: 41, rar: 'rare', prof: 'tank', color: 0xc0c8d8 }, 'Made for wading the shallows of Nenuial in full harness.');
  N('n_leggings_elven', 'Silken Leggings of Imladris', { a: 'legs', at: 'light', lvl: 51, rar: 'rare', prof: 'light', color: 0xa8c0e8, glow: 0x88aaff }, 'Elven silk, cool in summer and warm in winter.');
  N('n_greaves_angmar', 'Greaves of the Carn Dûm Breaker', { a: 'legs', at: 'heavy', lvl: 66, rar: 'incomparable', prof: 'heavy', color: 0x5a5060, glow: 0xc080ff }, 'The steel of Angmar turned against its makers.');
  N('n_leggings_serpent', "Leggings of the Serpent's Coil", { a: 'legs', at: 'medium', lvl: 75, rar: 'rare', prof: 'evasive', color: 0x2a6a5a, glow: 0x88ffee }, 'Scales from the sea-serpent of Tol Fuin, sewn onto leather. They shed water like a duck.');
  // Feet
  N('n_boots_wanderer', 'Boots of the Long Road', { a: 'feet', at: 'medium', lvl: 18, rar: 'uncommon', prof: 'evasive', color: 0x6a4a2a }, 'Resoled three times. They know the way to Bree by themselves.');
  N('n_shoes_elven', 'Soft Shoes of the Elves', { a: 'feet', at: 'light', lvl: 48, rar: 'rare', prof: 'evasive', color: 0xdfe8f0 }, 'They make no sound at all on fallen leaves.');
  N('n_sabatons_dwarf', 'Iron-shod Sabatons of Khazad-dûm', { a: 'feet', at: 'heavy', lvl: 63, rar: 'rare', prof: 'tank', color: 0x9aa8bb }, 'Every step rings like a hammer on an anvil.');
  N('n_boots_lossoth', "Mammoth-hunter's Boots", { a: 'feet', at: 'medium', lvl: 71, rar: 'rare', prof: 'morale', color: 0x6a5a4a }, 'The Lossoth hunt the great beasts of the ice for hide such as this.');
  N('n_boots_himring', 'Warboots of Himring', { a: 'feet', at: 'heavy', lvl: 77, rar: 'incomparable', prof: 'heavy', color: 0x8a1a1a, glow: 0xff9c3a }, 'Made to hold a wall against all the hosts of the North.');
  // Weapons
  N('n_throwing_bounder', "Bounder's Throwing Stones", { w: 'throwing', lvl: 4, rar: 'uncommon', prof: 'agility', color: 0x8a8a7a }, 'Smooth river-stones from the Water. Hobbits have a good eye and a better arm.');
  N('n_lute_bywater', 'Bywater Lute', { w: 'instrument', lvl: 5, rar: 'uncommon', prof: 'healer', color: 0xa07040 }, 'It has played at every birthday party in Bywater for thirty years.');
  N('n_gauntlets_pony', 'Knuckles of the Prancing Pony', { w: 'gauntlets', lvl: 10, rar: 'uncommon', prof: 'might', color: 0x7a5a3a }, 'Barliman keeps a pair behind the bar for difficult customers.');
  N('n_sword_bree', "Watchman's Longsword", { w: 'sword', lvl: 10, rar: 'uncommon', prof: 'might', color: 0xa8a8a8 }, 'Plain steel, kept sharp by the Bree Watch.');
  N('n_talisman_bree', 'Bree-land Almanac', { w: 'talisman', lvl: 10, rar: 'uncommon', prof: 'healer', color: 0x7a5a3a }, 'Weather, tides, planting dates and a great many charms against warts.');
  N('n_mace_bard', "Bree Bard's Cudgel", { w: 'mace', lvl: 11, rar: 'uncommon', prof: 'will', color: 0x8a6a3a }, 'For when the audience turns.');
  N('n_axe_thorin', "Thorin's Hall Bearded Axe", { w: 'axe', lvl: 12, rar: 'uncommon', prof: 'might', dtype: 'ancientDwarf', color: 0xa8b0b8 }, 'A sound axe of the Blue Mountains, made by apprentices under a stern eye.');
  N('n_shield_bree', 'Shield of the Bree-land Watch', { w: 'shield', lvl: 12, rar: 'uncommon', prof: 'tank', color: 0x6a4a2a }, 'A round wooden shield painted with a rearing pony.');
  N('n_hammer_thorin', "Hammer of Thorin's Hall", { w: 'mace', lvl: 15, rar: 'rare', prof: 'might', dtype: 'ancientDwarf', color: 0xc0c8d0 }, 'A war-hammer from the forges under the Blue Mountains. It rings when it strikes.');
  N('n_crossbow_dwarf', 'Dwarf-crossbow of the Blue Mountains', { w: 'crossbow', lvl: 16, rar: 'rare', prof: 'agility', color: 0x5a4a3a }, 'Heavy, slow and utterly reliable, like its makers.');
  N('n_dagger_midge', 'Midgewater Sting', { w: 'dagger', lvl: 18, rar: 'uncommon', prof: 'agility', color: 0x9aa8a0 }, 'A brigand\'s knife from the marshes. It itches to be used.');
  N('n_barrow_blade', 'Barrow-blade of Westernesse', { w: 'dagger', lvl: 22, rar: 'rare', prof: 'agility', dtype: 'westernesse', color: 0xb8c8d8, glow: 0x88aaff }, 'Forged in Westernesse long ago, and laid in a barrow with one who fought the Witch-king. It has not forgotten.');
  N('n_lute_forsaken', 'Fiddle of the Forsaken Inn', { w: 'instrument', lvl: 26, rar: 'rare', prof: 'healer', color: 0x6a4a2a }, 'Left behind by a travelling player who never came back down the Great East Road.');
  N('n_throwing_ranger', "Ranger's Throwing Knives", { w: 'throwing', lvl: 32, rar: 'rare', prof: 'agility', dtype: 'westernesse', color: 0xc0c8d0 }, 'Balanced for the hand of a Dúnadan. They fly true.');
  N('n_javelin_esteldin', 'Javelin of Esteldín', { w: 'javelin', lvl: 33, rar: 'rare', prof: 'might', dtype: 'westernesse', color: 0xc0c8d0 }, 'Ash and steel from the hidden refuge of the Rangers.');
  N('n_bow_northdowns', 'Longbow of the North Downs', { w: 'bow', lvl: 35, rar: 'rare', prof: 'agility', color: 0x6a4a2a }, 'Cut from a yew that grew on the Downs before Fornost fell.');
  N('n_shield_fornost', 'Shield of Fornost', { w: 'shield', lvl: 37, rar: 'rare', prof: 'tank', color: 0xcfd4d8, glow: 0xffe8a0 }, 'Seven stars on a black field, chipped and faded but still proud.');
  N('n_sword_westernesse', 'Blade of Westernesse', { w: 'sword', lvl: 38, rar: 'rare', prof: 'might', dtype: 'westernesse', color: 0xd8dde0, glow: 0x88aaff }, 'A sword of the North-kingdom, written with spells for the bane of Angmar.');
  N('n_halberd_captain', 'Halberd of the Captain of Arnor', { w: 'halberd', lvl: 42, rar: 'rare', prof: 'might', dtype: 'westernesse', color: 0xd8dde0 }, 'Recovered from Annúminas. Its haft is bound in silver wire.');
  N('n_spear_warden', 'Spear of the Lake-warden', { w: 'spear', lvl: 44, rar: 'rare', prof: 'agility', dtype: 'westernesse', color: 0xd8dde0 }, 'The wardens of Evendim hunt the shallows with spears such as this.');
  N('n_mace_dwarf_blue', 'Dwarf-hammer of the Blue Mountains', { w: 'mace', lvl: 45, rar: 'rare', prof: 'might', dtype: 'ancientDwarf', color: 0x9aa8bb }, 'Old work. The head is a single piece of dark iron.');
  N('n_runestone_ember', 'Rune-stone of Ember', { w: 'runestone', lvl: 45, rar: 'rare', prof: 'caster', dtype: 'fire', color: 0xff6a20, glow: 0xff8040 }, 'It is always warm to the touch, and sometimes rather more than warm.');
  N('n_gauntlets_troll', 'Troll-bone Gauntlets', { w: 'gauntlets', lvl: 47, rar: 'rare', prof: 'might', color: 0x9a9a8a }, 'Knuckle-guards carved from the bones of a troll of the Trollshaws.');
  N('n_talisman_lore', 'Tome of the Lore-masters', { w: 'talisman', lvl: 50, rar: 'rare', prof: 'caster', color: 0x4a3a6a, glow: 0x88aaff }, 'Copied in Rivendell from books older than the Shire.');
  N('n_staff_wizard', 'Staff of the Wandering Wizard', { w: 'staff', lvl: 50, rar: 'incomparable', prof: 'caster', dtype: 'light', color: 0x6a4a2a, glow: 0xffe8a0 }, 'Left leaning against a wall of the Prancing Pony one night, and never collected.');
  N('n_harp_rivendell', 'Harp of the Hall of Fire', { w: 'instrument', lvl: 52, rar: 'incomparable', prof: 'healer', dtype: 'light', color: 0xdfe8f0, glow: 0x88aaff }, 'Its strings were strung by Lindir himself. They never go out of tune.');
  N('n_sword_last_alliance', 'Blade of the Last Alliance', { w: 'sword', lvl: 55, rar: 'incomparable', prof: 'might', dtype: 'beleriand', color: 0xdfe8f0, glow: 0x88aaff }, 'Carried at Dagorlad, and kept in Rivendell ever since. It glows faintly when orcs are near.');
  N('n_spear_rohan', 'Boar-spear of the Riddermark', { w: 'spear', lvl: 58, rar: 'rare', prof: 'might', color: 0xa07040 }, 'A gift of a Rider of Rohan far from home.');
  N('n_shield_rohan', 'Shield of the Riddermark', { w: 'shield', lvl: 58, rar: 'rare', prof: 'tank', color: 0x2a6a3a }, 'A green shield with a white horse. It has never been turned.');
  N('n_axe_dwarf_lord', 'Axe of the Dwarf-lords', { w: 'axe', lvl: 60, rar: 'incomparable', prof: 'might', dtype: 'ancientDwarf', color: 0x9aa8bb, glow: 0xffa040 }, 'Forged in Khazad-dûm in the days of Durin. The edge has never needed a whetstone.');
  N('n_shield_khazad', 'Aegis of Khazad-dûm', { w: 'shield', lvl: 62, rar: 'incomparable', prof: 'tank', color: 0x9aa8bb, glow: 0xffa040 }, 'A tower-shield of dwarf-steel from the armouries of Moria.');
  N('n_axe_forochel', 'Ice-axe of Forochel', { w: 'axe', lvl: 69, rar: 'rare', prof: 'might', dtype: 'frost', color: 0xbfe0f0, glow: 0x9be8ff }, 'The Lossoth cut ice with it. It cuts other things too.');
  N('n_staff_lossoth', 'Staff of the Lossoth Seer', { w: 'staff', lvl: 70, rar: 'rare', prof: 'caster', dtype: 'frost', color: 0xd8e0e8, glow: 0x9be8ff }, 'Hung with bone charms that click in the wind.');
  N('n_runestone_icebay', 'Rune-stone of the Ice-bay', { w: 'runestone', lvl: 70, rar: 'incomparable', prof: 'caster', dtype: 'frost', color: 0x9be8ff, glow: 0xbfe8ff }, 'A stone from the frozen shore, and the cold of the bay is in it.');
  N('n_talisman_phial', 'Phial of Starlight', { w: 'talisman', lvl: 75, rar: 'incomparable', prof: 'caster', color: 0xdfe8f0, glow: 0xffffff }, 'A crystal phial that holds a little of the light of a star. It is very bright in dark places.');
  N('n_bow_isles', 'Bow of the Sundered Isles', { w: 'bow', lvl: 76, rar: 'incomparable', prof: 'agility', dtype: 'beleriand', color: 0xd0e8e8, glow: 0x88ffee }, 'Strung with the hair of a sea-serpent, or so the elves of Tol Fuin claim.');
  N('n_sword_draugbane', 'Draug-bane', { w: 'sword', lvl: 79, rar: 'incomparable', prof: 'might', dtype: 'beleriand', color: 0xffffff, glow: 0xff9c3a }, 'Named for the Gaunt-lord it was made to slay. It is not finished with him yet.');
  // Jewellery
  N('n_silver_trout_charm', 'Silver Trout Charm', { j: 'pocket', lvl: 1, rar: 'rare', prof: 'fate', color: 0xdfe8f0, icon: '🐟' }, 'A tiny silver trout on a chain. Fishermen say it brings luck; fish say nothing at all.');
  N('n_wrist_shire', 'Bywater Wristband', { j: 'wrist1', lvl: 4, rar: 'uncommon', prof: 'jewel', color: 0x8a7a4a }, 'Braided leather with a bright bead. A hobbit-lass made it.');
  N('n_pocket_pipe', "Old Toby's Pipe", { j: 'pocket', lvl: 8, rar: 'uncommon', prof: 'fate', color: 0x6a4a2a, icon: '🪈' }, 'A long-stemmed pipe of cherrywood. Very calming.');
  N('n_neck_bree', 'Locket of the Prancing Pony', { j: 'neck', lvl: 12, rar: 'uncommon', prof: 'jewel', color: 0xb08d57 }, 'A brass locket stamped with a rearing pony. It opens on a tiny painting of the inn.');
  N('n_ring_bree', 'Signet of the Bree-land Council', { j: 'ring1', lvl: 15, rar: 'uncommon', prof: 'jewel', color: 0xb08d57 }, 'Seals letters, opens doors, and impresses nobody outside Bree.');
  N('n_ear_dwarf', 'Dwarf-gold Ear-stud', { j: 'ear1', lvl: 16, rar: 'uncommon', prof: 'jewelB', color: 0xd4af5a }, 'Small, heavy and very yellow.');
  N('n_pocket_map', 'Well-thumbed Map of the Wild', { j: 'pocket', lvl: 20, rar: 'rare', prof: 'evasive', color: 0x9a8a6a, icon: '🗺' }, 'Annotated in three hands and two languages. Most of the notes say "here be trolls".');
  N('n_neck_wight', 'Wight-bane Amulet', { j: 'neck', lvl: 24, rar: 'rare', prof: 'caster', color: 0x8a8ab0, glow: 0x88aaff }, 'A silver amulet that turns cold when the dead are near.');
  N('n_ring_ranger', "Ranger's Star-ring", { j: 'ring1', lvl: 30, rar: 'rare', prof: 'crit', color: 0xc0c8d0 }, 'A plain silver ring with a single star. Rangers know each other by it.');
  N('n_pocket_ranger', 'Star of the Dúnedain', { j: 'pocket', lvl: 38, rar: 'rare', prof: 'all', color: 0xdfe8f0, glow: 0x88aaff, icon: '✨' }, 'The six-rayed brooch of the Rangers of the North.');
  N('n_neck_evendim', 'Pearl Necklace of Nenuial', { j: 'neck', lvl: 40, rar: 'rare', prof: 'healer', color: 0xf0f0e8 }, 'Pearls from the great lake, strung in Tinnudir.');
  N('n_ring_arnor', 'Ring of the Kings of Arnor', { j: 'ring1', lvl: 40, rar: 'incomparable', prof: 'all', color: 0xd4af5a, glow: 0xffe8a0 }, 'Not THE ring. But a ring of kings nonetheless, with the Seven Stars in tiny gems.');
  N('n_wrist_evendim', 'Lake-pearl Bracelet', { j: 'wrist1', lvl: 41, rar: 'rare', prof: 'jewelB', color: 0xf0f0e8 }, 'Cool to the touch, like the water it came from.');
  N('n_ear_troll', 'Troll-tooth Earring', { j: 'ear1', lvl: 46, rar: 'rare', prof: 'might', color: 0xe8e0c8 }, 'A trophy of the Trollshaws. Rather heavy for the ear.');
  N('n_ear_elven', 'Star-drop Earring of Imladris', { j: 'ear1', lvl: 50, rar: 'rare', prof: 'caster', color: 0xdfe8f0, glow: 0x88aaff }, 'A single white gem on a thread of elven-silver.');
  N('n_pocket_waybread', 'Crumb of Waybread', { j: 'pocket', lvl: 52, rar: 'rare', prof: 'morale', color: 0xe8d8a0, icon: '🍪' }, 'Wrapped in a mallorn-leaf. One does not eat it; one keeps it, for the heart it gives.');
  N('n_pocket_giant', "Giant's Lucky Pebble", { j: 'pocket', lvl: 56, rar: 'rare', prof: 'tank', color: 0x8a8a8a, icon: '🪨' }, 'It is the size of your head. The giant seemed to think it was small.');
  N('n_wrist_dwarf', 'Dwarf-gold Bracelet', { j: 'wrist1', lvl: 60, rar: 'rare', prof: 'might', color: 0xd4af5a }, 'Thick, plain and worth a small farm.');
  N('n_ring_moria', 'Ring of the Iron Garrison', { j: 'ring1', lvl: 62, rar: 'incomparable', prof: 'tank', color: 0x9aa8bb, glow: 0xffa040 }, 'Iron set with a chip of mithril. Given to those who held the Bridge.');
  N('n_ring_hapless', 'Ring of the Hapless', { j: 'ring1', lvl: 66, rar: 'rare', prof: 'fate', color: 0x6a6a7a }, 'Found near the Stone of the Hapless on Tol Morwen. It is heavy with old sorrow, and old luck.');
  N('n_wrist_angmar', 'Bracer of the Angmar-bane', { j: 'wrist1', lvl: 67, rar: 'incomparable', prof: 'crit', color: 0x5a5060, glow: 0xc080ff }, 'Black steel, engraved with the ward against the Witch-realm.');
  N('n_neck_forochel', 'Ice-crystal Pendant', { j: 'neck', lvl: 70, rar: 'incomparable', prof: 'caster', color: 0x9be8ff, glow: 0xbfe8ff }, 'A shard of ice that never melts, hung on a sinew cord.');
  N('n_ear_lossoth', 'Ivory Ear-cuff of the Lossoth', { j: 'ear1', lvl: 70, rar: 'rare', prof: 'evasive', color: 0xf0e8d8 }, 'Carved from mammoth ivory in the shape of a leaping fish.');
  N('n_ring_serpent', 'Ring of the Sea-serpent', { j: 'ring1', lvl: 74, rar: 'incomparable', prof: 'all', color: 0x2a6a7a, glow: 0x88ffee }, 'A single serpent-scale set in sea-silver.');
  N('n_neck_himring', 'Torc of Himring', { j: 'neck', lvl: 78, rar: 'incomparable', prof: 'all', color: 0xd4af5a, glow: 0xff9c3a }, 'A neck-ring of red gold from the hill that stood ever-cold against the North.');

  // ------------------------------------------------------------------ consumables
  function CONS(id, name, o) {
    return addItem({ id, name, type: o.type || 'consumable', slot: null, subtype: o.subtype || null, level: o.level || 1, rarity: o.rarity || 'common', stats: {}, dmg: null,
      value: o.value != null ? o.value : 10, maxStack: o.maxStack || 20, icon: o.icon, iconBg: o.iconBg, desc: o.desc || '', flavor: o.flavor || '', use: o.use || null, bait: o.bait, mount: o.mount, junk: o.junk, sell: o.sell });
  }
  const FOODS = [
    ['food_seedcake', 'Hobbit Seed-cake', 1, 'A small, dense cake of the kind hobbits keep in every pocket.'],
    ['food_mushroom_pie', 'Mushroom Pie of Bywater', 5, 'Farmer Maggot would not approve of where the mushrooms came from.'],
    ['food_bree_bread', 'Bree Bread and Cheese', 10, 'Honest fare from the Prancing Pony.'],
    ['food_roast_boar', 'Roast Boar Haunch', 15, 'Still warm. Still enormous.'],
    ['food_honey_cake', 'Beorning Honey-cake', 25, 'Sweet and heavy, made by folk who have a great deal of honey.'],
    ['food_ranger_stew', "Ranger's Trail Stew", 35, 'Whatever was to hand, cooked a long time. Better than it sounds.'],
    ['food_cram', 'Cram of the Dwarves', 45, 'Keeps forever. Tastes like it, too.'],
    ['food_waybread', 'Elven Waybread', 55, 'One small cake will keep a traveller on his feet for a day of long labour.'],
    ['food_fish_stew', 'Lossoth Fish Stew', 65, 'Cod, seal-fat and something green. Warms you to the toes.'],
    ['food_isles_feast', 'Feast of the Sundered Isles', 75, 'Sea-bass, samphire and elven wine from the havens of Tol Fuin.'],
  ];
  FOODS.forEach((f, i) => CONS(f[0], f[1], { subtype: 'food', level: f[2], icon: ['🍪', '🥧', '🧀', '🍖', '🍯', '🍲', '🍞', '🥮', '🍲', '🍽'][i], iconBg: BG.food, value: 4 + f[2] * 3, desc: f[3],
    use: { kind: 'buff', stat: 'moraleRegen', amount: _r(2 + f[2] * 0.25), duration: 600, cd: 2, group: 'food', sfx: 'eat', label: 'Eat' } }));
  CONS('drink_pony_ale', 'Prancing Pony Ale', { subtype: 'food', level: 8, icon: '🍺', iconBg: BG.drink, value: 15, desc: 'The best beer in the Bree-land, which is not saying much, but it is saying something.',
    use: { kind: 'buff', stat: 'powerRegen', amount: 3, duration: 600, cd: 2, group: 'drink', sfx: 'drink', label: 'Drink' } });
  CONS('drink_miruvor', 'Miruvor of Imladris', { subtype: 'food', level: 50, rarity: 'uncommon', icon: '🍶', iconBg: BG.drink, value: 180, desc: 'The cordial of Imladris. A mouthful puts heart into the weary.',
    use: { kind: 'buff', stat: 'powerRegen', amount: 14, duration: 600, cd: 2, group: 'drink', sfx: 'drink', label: 'Drink' } });
  CONS('drink_lossoth_tea', 'Lossoth Lichen Tea', { subtype: 'food', level: 68, icon: '🍵', iconBg: BG.drink, value: 120, desc: 'Bitter, hot and much needed on the Ice-bay.',
    use: { kind: 'buff', stat: 'powerRegen', amount: 19, duration: 600, cd: 2, group: 'drink', sfx: 'drink', label: 'Drink' } });
  const POTS = [
    ['salve', 'Salve of Healing', 1, 60], ['draught', 'Draught of Healing', 15, 220], ['elixir', 'Elixir of Healing', 30, 520], ['greater', 'Greater Draught of Healing', 45, 950],
    ['athelas', 'Athelas Essence', 60, 1700], ['lostkingdom', 'Draught of the Lost Kingdom', 75, 3000]];
  POTS.forEach((p, i) => CONS('pot_heal_' + p[0], p[1], { subtype: 'potion', level: p[2], rarity: i >= 4 ? 'uncommon' : 'common', icon: '🧪', iconBg: BG.potion, value: 6 + p[2] * 6,
    desc: 'Restores ' + p[3] + ' morale.', use: { kind: 'heal', amount: p[3], cd: 30, group: 'potion_heal', sfx: 'drink', label: 'Drink' } }));
  const PPOTS = [
    ['tonic', 'Tonic of Vigour', 1, 40], ['draught', 'Draught of Vigour', 15, 150], ['elixir', 'Elixir of Vigour', 30, 350], ['greater', 'Greater Draught of Vigour', 45, 640],
    ['celebrant', 'Water of the Celebrant', 60, 1100], ['lostkingdom', 'Vigour of the Lost Kingdom', 75, 2000]];
  PPOTS.forEach((p, i) => CONS('pot_power_' + p[0], p[1], { subtype: 'potion', level: p[2], rarity: i >= 4 ? 'uncommon' : 'common', icon: '⚗', iconBg: BG.power, value: 6 + p[2] * 6,
    desc: 'Restores ' + p[3] + ' power.', use: { kind: 'power', amount: p[3], cd: 30, group: 'potion_power', sfx: 'drink', label: 'Drink' } }));
  const SCROLLS = [
    ['battle', 'Scroll of Battle-lore', 'physMastery', 'Physical Mastery'], ['tactics', 'Scroll of Tactical Lore', 'tactMastery', 'Tactical Mastery'], ['warding', 'Scroll of Warding', 'armour', 'Armour'],
    ['fortitude', 'Scroll of Fortitude', 'maxMorale', 'Maximum Morale'], ['fortune', 'Scroll of Fortune', 'fate', 'Fate'], ['swiftfoot', 'Scroll of the Swift Foot', 'speed', 'run speed'], ['angler', 'Scroll of the Patient Angler', 'fate', 'Fate']];
  SCROLLS.forEach(s => { [10, 50].forEach((lvl, ti) => {
    const amt = s[2] === 'speed' ? (ti ? 15 : 10) : s[2] === 'fate' ? (ti ? 40 : 10) : s[2] === 'maxMorale' ? (ti ? 600 : 120) : (ti ? 500 : 100);
    CONS('scroll_' + s[0] + '_' + lvl, s[1] + (ti ? ' (Greater)' : ''), { subtype: 'scroll', level: lvl, rarity: 'uncommon', icon: '📜', iconBg: BG.scroll, value: 40 + lvl * 4,
      desc: 'Grants +' + amt + (s[2] === 'speed' ? '% ' : ' ') + s[3] + ' for 15 minutes.', flavor: s[0] === 'angler' ? 'Copied out by a hobbit who spent a great deal of time at the Water.' : '',
      use: { kind: 'buff', stat: s[2], amount: amt, duration: 900, cd: 2, group: 'scroll', sfx: 'buff', label: 'Read' } });
  }); });

  // ------------------------------------------------------------------ fish, bait, fishing gear
  const FISH = [
    ['brandywine_trout', 'Brandywine Trout', 1, 12, 'A speckled trout from the Brandywine. Good eating.', 1],
    ['bywater_perch', 'Bywater Perch', 1, 8, 'A small perch from the Bywater pool.'],
    ['midgewater_eel', 'Midgewater Eel', 12, 20, 'Slippery, muddy and surprisingly strong.'],
    ['lune_herring', 'Lune Herring', 8, 14, 'Silver herring from the Gulf of Lune.'],
    ['hoarwell_grayling', 'Hoarwell Grayling', 25, 30, 'A grayling from the cold fast water of the Hoarwell.'],
    ['nenuial_pike', 'Nenuial Pike', 38, 55, 'A great pike from the deeps of Evendim. Mind the teeth.'],
    ['evendim_salmon', 'Evendim Salmon', 40, 60, 'A fat salmon of the lake, prized at every table in Tinnudir.', 1],
    ['golden_carp', 'Golden Carp', 45, 70, 'A carp of the Bruinen shallows, gold as a coin.'],
    ['forochel_icecod', 'Forochel Ice-cod', 62, 80, 'Cod from beneath the ice of the Bay. The Lossoth live on it.', 1],
    ['tolfuin_seabass', 'Sea-bass of Tol Fuin', 68, 110, 'A sea-bass taken off the elven haven of Ost Fuin.'],
    ['himling_sturgeon', 'Himling Sturgeon', 74, 160, 'An enormous sturgeon from the cold waters about Himling.'],
    ['silver_trout', 'Silver Trout', 20, 250, 'A rare trout with scales like silver coins. Old fishermen speak of it in whispers.', 0, 'rare'],
  ];
  FISH.forEach(f => CONS('fish_' + f[0], f[1], { type: 'fish', subtype: 'fish', level: 1, rarity: f[6] || 'common', icon: '🐟', iconBg: BG.fish, value: f[3], maxStack: 20, desc: f[4], fishLevel: f[2],
    use: f[5] ? { kind: 'heal', amount: 40 + f[2] * 12, cd: 10, group: 'food', sfx: 'eat', label: 'Eat' } : null }));
  items.fish_silver_trout.icon = '🐠'; items.fish_himling_sturgeon.icon = '🐡';
  [['worms', 'Earthworms', 1, 0.0, 3, 'Dug from a hobbit garden. The hobbit was not consulted.'], ['bread', 'Bread-crumb Bait', 5, 0.05, 5, 'Stale bread from the Prancing Pony.'],
   ['cricket', 'Cricket Bait', 15, 0.1, 8, 'Lively crickets in a wicker box.'], ['minnow', 'Minnow Lure', 30, 0.18, 14, 'A painted wooden minnow with a wicked hook.'],
   ['shrimp', 'Salt-shrimp Bait', 50, 0.28, 25, 'Shrimp from the Gulf of Lune, packed in salt. The big fish love it.']]
    .forEach(b => CONS('bait_' + b[0], b[1], { type: 'bait', subtype: 'bait', level: b[2], icon: '🪱', iconBg: BG.bait, value: b[4], maxStack: 100, desc: 'Fishing bait. Improves the chance of a bite' + (b[3] ? ' by ' + _r(b[3] * 100) + '%.' : '.'), bait: { bonus: b[3] } }));
  CONS('misc_fishing_rod', 'Willow Fishing Rod', { type: 'misc', subtype: 'tool', level: 1, icon: '🎣', iconBg: BG.bait, value: 30, maxStack: 1, desc: 'A supple rod of Shire willow. Any water will do; the fish decide the rest.' });
  CONS('misc_fishing_rod_elven', 'Elven Fishing Rod', { type: 'misc', subtype: 'tool', level: 40, rarity: 'uncommon', icon: '🎣', iconBg: BG.bait, value: 400, maxStack: 1, desc: 'A rod of grey elven wood, light as a wand.' });

  // ------------------------------------------------------------------ materials
  const MATS = [
    ['wolf_pelt', 'Wolf Pelt', 'pelt', 6, 'A thick grey wolf-pelt.'], ['boar_hide', 'Boar Hide', 'pelt', 5, 'Tough, bristly hide of a wild boar.'], ['bear_pelt', 'Bear Pelt', 'pelt', 14, 'A heavy bear-pelt, still smelling of the den.'],
    ['warg_hide', 'Warg Hide', 'pelt', 22, 'The mangy hide of a warg. Even tanned it looks angry.'], ['lynx_fur', 'Lynx Fur', 'pelt', 28, 'Soft, spotted fur of a lynx.'], ['white_bear_pelt', 'White Bear Pelt', 'pelt', 60, 'The snowy pelt of a bear of Forochel.'],
    ['troll_hide', 'Troll Hide', 'pelt', 40, 'A slab of grey troll-hide. It blunts knives.'], ['drake_scale', 'Drake Scale', 'pelt', 55, 'A scale the size of a hand, warm to the touch.'], ['serpent_scale', 'Sea-serpent Scale', 'pelt', 70, 'A blue-green scale from the serpent of Tol Fuin.'],
    ['spider_silk', 'Spider Silk', 'cloth', 12, 'Strong, sticky silk from the spiders of the Chetwood.'], ['linen_scrap', 'Linen Scrap', 'cloth', 2, 'A scrap of clean linen.'], ['wool_bolt', 'Bolt of Wool', 'cloth', 8, 'Good Shire wool.'], ['elven_silk', 'Elven Silk', 'cloth', 60, 'Silk of Imladris, light as air.'],
    ['copper_ore', 'Copper Ore', 'ore', 4, 'A lump of green-streaked copper ore.'], ['iron_ore', 'Iron Ore', 'ore', 10, 'Heavy, rusty iron ore.'], ['silver_ore', 'Silver Ore', 'ore', 25, 'Ore with a bright silver seam.'], ['dwarf_iron', 'Dwarf-iron Ore', 'ore', 45, 'Dark ore from the mines under the Blue Mountains.'], ['mithril_flake', 'Mithril Flake', 'ore', 400, 'A flake of true-silver, worth more than its weight in gold many times over.'],
    ['athelas', 'Athelas Leaf', 'herb', 12, 'Kingsfoil. Sweet-smelling, and a healing virtue for those who know how to use it.'], ['pipeweed', 'Pipe-weed Leaf', 'herb', 5, 'Longbottom Leaf, or near enough.'], ['nightshade', 'Nightshade', 'herb', 15, 'Dark berries. Do not eat.'],
    ['moonflower', 'Moonflower', 'herb', 30, 'A pale flower that opens only at night.'], ['snow_lichen', 'Snow-lichen', 'herb', 45, 'Grey-green lichen from the rocks of Forochel.'],
    ['ash_branch', 'Ash Branch', 'wood', 3, 'A straight length of ash.'], ['yew_bough', 'Yew Bough', 'wood', 12, 'A bough of yew, good for bows.'], ['rowan_wood', 'Rowan Wood', 'wood', 20, 'Rowan, the warding tree.'], ['mallorn_wood', 'Mallorn Wood', 'wood', 80, 'Silver-grey wood that no worm will touch.'],
  ];
  const MAT_ICON = { pelt: '🧶', cloth: '🧵', ore: '⛏', herb: '🌿', wood: '🪵' };
  MATS.forEach(m => CONS('mat_' + m[0], m[1], { type: 'material', subtype: m[2], icon: MAT_ICON[m[2]], iconBg: BG.material, value: m[3], maxStack: 100, desc: m[4] }));
  // Gather-node items referenced by the world registry (05_data_world.js)
  addItem({ id: 'mat_mushroom', name: 'Wild Mushrooms', type: 'material', subtype: 'herb', icon: '🍄', iconBg: BG.material, value: 6, maxStack: 100, desc: 'Plump wild mushrooms, prized by hobbit cooks and wary travellers alike.' });
  addItem({ id: 'misc_treasure_cache', name: 'Treasure Cache', type: 'misc', subtype: null, icon: '💰', iconBg: BG.material, value: 250, maxStack: 20, desc: 'A small locked cache of coin and oddments, left by someone who never came back for it.' });

  // ------------------------------------------------------------------ trophies (junk), generic quest items, keys, mounts, maps
  const JUNK = [
    ['goblin_ear', 'Goblin Ear', 3, '🦻', 'Proof of a goblin slain. Nobody wants to touch it.'], ['orc_tooth', 'Orc Tooth', 5, '🦷', 'A yellow orc-tusk.'], ['wolf_fang', 'Wolf Fang', 4, '🦷', 'A long white fang.'],
    ['boar_tusk', 'Boar Tusk', 4, '🦷', 'A curved tusk.'], ['bear_claw', 'Bear Claw', 8, '🪝', 'A claw as long as a finger.'], ['bat_wing', 'Bat Wing', 2, '🦇', 'A leathery wing.'], ['warg_claw', 'Warg Claw', 12, '🪝', 'A black warg-claw.'],
    ['spider_venom', 'Spider Venom Sac', 9, '🧫', 'A sac of pale venom. Handle with care.'], ['bone_dust', "Wight's Bone-dust", 14, '⚱', 'Grey dust that was once a barrow-wight.'], ['troll_toenail', 'Troll Toe-nail', 25, '🦶', 'It is as large as a dinner plate.'],
    ['giant_tooth', "Giant's Tooth", 40, '🦷', 'A tooth the size of a loaf.'], ['drake_tooth', 'Drake Tooth', 45, '🦷', 'Curved and black, still hot.'], ['serpent_fang', 'Sea-serpent Fang', 60, '🦷', 'A fang as long as a sword.'], ['slug_slime', 'Slug Slime', 2, '🫧', 'Do not ask.'],
    ['crawler_shell', 'Crawler Carapace', 20, '🐚', 'A plate of chitin from a marsh-crawler.'], ['rusty_dagger', 'Rusty Goblin Dagger', 3, '🔪', 'Useless as a weapon. Sells for scrap.'], ['broken_arrowhead', 'Broken Arrowhead', 1, '➤', 'Somebody missed.'],
    ['bent_coin', 'Bent Copper Coin', 1, '🪙', 'Bree-land coinage, bent in a brigand\'s pocket.'], ['cracked_shield_boss', 'Cracked Shield-boss', 6, '⭕', 'The iron boss of an orc shield.'], ['old_boot', 'Old Boot', 1, '🥾', 'Fished from the Water. There is a fish in it.'],
    ['tattered_banner', 'Tattered Brigand Banner', 8, '🚩', 'A ragged flag with a crude device.'], ['goblin_totem', 'Goblin Totem', 10, '🗿', 'A small carved totem, ugly even for goblin work.'], ['angmarim_sigil', 'Angmarim Sigil', 30, '🜏', 'An iron badge of the Witch-realm.'],
    ['uruk_iron', 'Uruk Iron Scrap', 28, '⚙', 'A shard of black uruk-plate.'], ['dark_tome_scrap', 'Page of a Dark Tome', 35, '📃', 'A page of sorcerous scrawl. It makes the eyes ache.'], ['lossoth_carving', 'Lossoth Bone Carving', 30, '🦴', 'A small carved seal.'],
    ['barrow_relic', 'Barrow Relic', 20, '🏺', 'A tarnished relic of Cardolan, from a barrow.'], ['giant_bone', "Giant's Knucklebone", 30, '🦴', 'A knucklebone the size of a keg.'], ['white_bear_claw', 'White Bear Claw', 35, '🪝', 'A claw of a bear of the ice.'], ['wight_shroud', "Wight's Shroud", 12, '🧻', 'A rotten grave-cloth.'],
  ];
  JUNK.forEach(j => CONS('junk_' + j[0], j[1], { type: 'misc', subtype: 'trophy', icon: j[3], iconBg: BG.junk, value: j[2], maxStack: 100, desc: j[4], junk: true }));
  const QUESTITEMS = [
    ['brigand_map', "Brigand's Map", '🗺', 'A crude map of the Chetwood, marked with camps and hiding-places.'], ['sealed_letter', 'Sealed Letter', '✉', 'A letter sealed with wax. It is not addressed to you.'], ['bounder_report', "Bounder's Report", '📋', 'Notes on strange folk seen at the borders of the Shire.'],
    ['bundle_athelas', 'Bundle of Athelas', '🌿', 'Fresh kingsfoil, wrapped in a damp cloth.'], ['stolen_goods', 'Stolen Goods', '📦', 'A sack of goods taken from a Bree-land farm.'], ['ranger_token', "Ranger's Token", '⭐', 'A star-shaped token of the Dúnedain. It will open doors in the North.'],
    ['dwarf_deed', 'Dwarven Deed', '📜', 'A deed to a mine under the Blue Mountains, written in runes.'], ['elven_missive', 'Elven Missive', '📜', 'A letter in a flowing elven hand.'], ['ancient_tome', 'Ancient Tome', '📕', 'A book so old the pages crackle. It speaks of the North-kingdom.'],
    ['watch_lantern', "Watchman's Lantern", '🏮', 'A hooded lantern of the Bree Watch.'], ['supply_crate', 'Supply Crate', '📦', 'A crate of supplies for a distant camp.'], ['barrow_treasure', 'Barrow Treasure', '💰', 'Gold and gems from a barrow of the Downs. The wight will want it back.'],
    ['troll_keystone', 'Troll-hoard Keystone', '🪨', 'A carved stone from a troll-hoard.'], ['goblin_orders', 'Goblin Orders', '📃', 'Scrawled orders from Goblin-town. Someone in the Misty Mountains gives commands.'], ['angmar_dispatch', 'Angmarim Dispatch', '📃', 'A dispatch bearing the seal of Carn Dûm.'],
    ['lossoth_charm', 'Lossoth Charm', '🧿', 'A charm of bone and sinew, given for a favour owed.'], ['elf_lantern', 'Lantern of Ost Fuin', '🏮', 'A silver lantern that burns without oil.'], ['himring_seal', 'Seal of Himring', '🔏', 'A seal of the fortress of Himring. The Gaunt-lord fears it.'],
    ['shard_of_arnor', 'Shard of the Lost Crown', '💎', 'A shard of the crown of the lost kingdom, cold and bright.'], ['old_map_shire', 'Map of the Shire', '🗺', 'A hand-drawn map of the Four Farthings.'],
  ];
  QUESTITEMS.forEach(q => CONS('q_' + q[0], q[1], { type: 'quest', subtype: 'quest', icon: q[2], iconBg: BG.quest, value: 0, maxStack: 20, desc: q[3] }));
  [['rusty', 'Rusty Iron Key', 'Opens something old and probably damp.', 1], ['barrow', 'Barrow Key', 'A key of green bronze, taken from a wight.', 20], ['carndum', 'Key of Carn Dûm', 'A black iron key to the dungeons of Angmar.', 60],
   ['himring', 'Himring Vault Key', 'A key of red gold. It opens the vault beneath the fortress of Himring.', 78]]
    .forEach(k => CONS('key_' + k[0], k[1], { type: 'quest', subtype: 'key', level: k[3], icon: '🗝', iconBg: BG.key, value: 0, maxStack: 1, desc: k[2] }));
  CONS('map_home', 'Homeward Map', { type: 'misc', subtype: 'map', level: 1, rarity: 'uncommon', icon: '🗺', iconBg: BG.map, value: 0, maxStack: 1, sell: 0,
    desc: 'Study it, and you will find yourself on the road home. Can be used once every 30 minutes.', flavor: 'Every road leads home, if you know how to read the map.',
    use: { kind: 'teleport', target: 'home', cd: 1800, consume: false, sfx: 'spell_cast', label: 'Travel home' } });
  const MOUNTS = [
    ['starter', 'Starter Pony', 1, 0, 12, 0x8a6a4a, 'A patient, shaggy pony. Not fast, but it goes where it is pointed.'], ['bree', 'Bree Horse', 10, 25000, 15, 0x5a3a20, 'A sturdy bay horse from the stables of Bree.'],
    ['shire', 'Shire Pony', 8, 18000, 14, 0xd8c8a8, 'A dappled pony bred in the Shire. Fond of apples.'], ['dwarf', 'Dwarf Pony', 15, 30000, 14, 0x3a3a3a, 'A black pony of the Blue Mountains, strong enough to carry a dwarf in full mail.'],
    ['elven', 'Elven Steed', 40, 120000, 17, 0xe8e8f0, 'A grey horse of Rivendell. It runs like the wind on the water.'], ['ranger', "Ranger's Steed", 30, 90000, 17, 0x4a4a4a, 'A rangy, tireless horse of the Dúnedain.'],
    ['rohan', 'Warhorse of Rohan', 55, 300000, 18, 0xb08050, 'A great chestnut warhorse of the Riddermark, unafraid of anything.'], ['lostkingdom', 'Steed of the Lost Kingdom', 80, 0, 20, 0xfff0d0, 'A white horse in silver harness, the steed of the kings of Arnor returned.'],
  ];
  MOUNTS.forEach((m, i) => CONS('mount_' + m[0], m[1], { type: 'mount', subtype: 'mount', level: m[2], rarity: i === 7 ? 'legendary' : i >= 4 ? 'rare' : 'uncommon', icon: '🐎', iconBg: BG.mount, value: m[3], maxStack: 1, sell: 0,
    desc: 'Teaches you to summon this steed (H). Speed ' + m[4] + '.', flavor: m[6], mount: { speed: m[4], color: m[5] }, use: { kind: 'learnMount', cd: 1, sfx: 'horse_neigh', label: 'Learn' } }));

  // ================================================================== G.Items API
  const _uidSalt = (Date.now() % 1679616).toString(36);          // uid salt only (not gameplay time)
  let _uidN = 0;
  function newUid() { return 'i' + _uidSalt + (++_uidN).toString(36); }

  // ---- indexes (rebuilt lazily after addItem)
  const _idx = { byType: {}, bySlot: {}, list: [] };
  function rebuildIndex() {
    _idx.byType = {}; _idx.bySlot = {}; _idx.list = [];
    for (const id in items) {
      const t = items[id]; _idx.list.push(t);
      (_idx.byType[t.type] || (_idx.byType[t.type] = [])).push(t);
      if (t.slot) (_idx.bySlot[t.slot] || (_idx.bySlot[t.slot] = [])).push(t);
    }
    _indexDirty = false;
  }
  function all(includeHidden) { if (_indexDirty) rebuildIndex(); return includeHidden ? _idx.list.slice() : _idx.list.filter(t => !t.hidden); }
  function byType(type) { if (_indexDirty) rebuildIndex(); return (_idx.byType[type] || []).filter(t => !t.hidden); }
  function bySlot(slot) { if (_indexDirty) rebuildIndex(); return (_idx.bySlot[baseSlot(slot)] || []).filter(t => !t.hidden); }
  function search(text) {
    const q = String(text || '').trim().toLowerCase();
    const out = all(false);
    if (!q) return out.sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
    return out.filter(t => t.name.toLowerCase().indexOf(q) >= 0 || t.id.indexOf(q) >= 0 || (t.type && t.type.indexOf(q) >= 0) || (t.subtype && String(t.subtype).indexOf(q) >= 0) || (t.desc && t.desc.toLowerCase().indexOf(q) >= 0))
      .sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
  }
  function template(tid) { return items[tid] || null; }

  // ---- instances & merged views
  function create(tid, count) {
    const t = items[tid]; if (!t) return null;
    return { uid: newUid(), tid, count: Math.max(1, _r(count || 1)) };
  }
  const OVERRIDES = ['name', 'ilvl', 'rarity', 'level', 'stats', 'dmg', 'value', 'visual', 'icon', 'iconBg', 'speed', 'classes'];
  function get(inst) {
    if (!inst) return null;
    if (typeof inst === 'string') inst = { tid: inst, count: 1 };
    const t = items[inst.tid]; if (!t) return null;
    const v = Object.assign({}, t);
    for (let i = 0; i < OVERRIDES.length; i++) { const k = OVERRIDES[i]; if (inst[k] != null) v[k] = inst[k]; }
    v.count = inst.count || 1; v.uid = inst.uid; v.tid = inst.tid; v.tmpl = t; v.inst = inst; v.generated = !!inst.gen;
    return v;
  }
  function rarityOf(inst) { const v = get(inst); return v ? v.rarity : 'common'; }
  function rarityClass(inst) { return 'rarity-' + rarityOf(inst); }
  function rarityColor(inst) { return C.RARITY_COLOR[rarityOf(inst)] || '#d9d9d9'; }
  function slotLabel(slot) { return SLOT_LABEL[slot] || _cap(slot || ''); }
  function isTwoHanded(inst) { const v = get(inst); return !!(v && v.type === 'weapon' && TWO_HANDED.has(v.subtype)); }
  function isEquippable(inst) { const v = get(inst); return !!(v && v.slot); }
  function isUsable(inst) { const v = get(inst); return !!(v && v.use); }
  function isJunk(inst, player) {
    const v = get(inst); if (!v) return false;
    if (v.junk) return true;
    if (v.type === 'quest' || v.type === 'mount' || v.type === 'bait' || v.use) return false;
    if (v.type === 'misc' && !v.use && v.subtype !== 'tool') return true;
    if (v.slot && player && typeof player.level === 'number' && v.rarity === 'common' && v.level + 15 < player.level) return true;
    return false;
  }
  function typeLabel(v) {
    if (!v) return '';
    if (v.type === 'weapon') { const W = WEAPON[v.subtype]; return (TWO_HANDED.has(v.subtype) ? 'Two-handed ' : (W && !W.noDmg && v.slot === 'mainhand') ? 'One-handed ' : '') + (W ? W.label : _cap(v.subtype || 'Weapon')); }
    if (v.type === 'armour') return (v.slot === 'back' ? 'Cloak' : (_cap(v.armourType || 'Any') + ' Armour'));
    if (v.type === 'jewellery') return JEWEL_LABEL[baseSlot(v.slot)] || 'Jewellery';
    if (v.type === 'consumable') return _cap(v.subtype || 'Consumable');
    if (v.type === 'fish') return 'Fish';
    if (v.type === 'bait') return 'Fishing Bait';
    if (v.type === 'material') return 'Crafting Material';
    if (v.type === 'quest') return v.subtype === 'key' ? 'Key' : 'Quest Item';
    if (v.type === 'mount') return 'Mount';
    return v.junk ? 'Trophy' : _cap(v.subtype || 'Item');
  }
  function dps(inst) { const v = get(inst); if (!v || !v.dmg || !v.speed) return 0; return (v.dmg.min + v.dmg.max) / 2 / v.speed; }
  function iconHTML(x, size) {
    const v = (x && x.tid && !x.type) ? get(x) : (x && x.tid && x.inst ? x : (x && x.id && !x.tid ? x : get(x)));
    if (!v) return '<div class="icon' + (size === 'sm' ? ' sm' : size === 'lg' ? ' lg' : '') + '"></div>';
    const bg = v.iconBg != null ? v.iconBg : 0x333333;
    let cls = 'icon' + (size === 'sm' ? ' sm' : size === 'lg' ? ' lg' : '') + ' border-' + (v.rarity || 'common');
    let style = 'background:linear-gradient(160deg,' + _shade(bg, 1.45) + ',' + _shade(bg, 0.55) + ');border:1px solid ' + (C.RARITY_COLOR[v.rarity] || '#777') + ';';
    if (typeof size === 'number') style += 'width:' + size + 'px;height:' + size + 'px;font-size:' + _r(size * 0.6) + 'px;';
    if (v.visual && v.visual.glow) style += 'box-shadow:0 0 6px ' + _hex(v.visual.glow) + ';';
    return '<div class="' + cls + '" style="' + style + '" data-tid="' + _esc(v.tid || v.id) + '">' + _esc(v.icon || '▪') + '</div>';
  }

  // ---- class / equip rules
  function weaponPrefs(clsId) {
    const c = classData(clsId); const T = CLASS_WEAPONS[clsId] || { main: ['sword'], off: ['shield'], ranged: ['throwing'] };
    const main = [], off = [], ranged = [];
    const add = (arr, s) => { if (WEAPON[s] && arr.indexOf(s) < 0) arr.push(s); };
    if (c && c.rangedWeapon) add(ranged, c.rangedWeapon);
    T.ranged.forEach(s => add(ranged, s));
    T.main.forEach(s => add(main, s));
    T.off.forEach(s => add(off, s));
    if (c && Array.isArray(c.weaponTypes)) c.weaponTypes.forEach(s => {
      if (!WEAPON[s]) return;
      if (WEAPON[s].slot === 'mainhand') add(main, s);
      else if (WEAPON[s].slot === 'ranged') add(ranged, s);
      else if (s === 'shield') add(off, s);
    });
    return { main, off, ranged };
  }
  function classCanWield(clsId, subtype) {
    if (!clsId) return true;
    const c = classData(clsId); const T = CLASS_WEAPONS[clsId];
    if (!c && !T) return true;
    if (c && Array.isArray(c.weaponTypes) && c.weaponTypes.indexOf(subtype) >= 0) return true;
    if (c && c.rangedWeapon === subtype) return true;
    if (T && (T.main.indexOf(subtype) >= 0 || T.off.indexOf(subtype) >= 0 || T.ranged.indexOf(subtype) >= 0)) return true;
    return false;
  }
  function offhandCapable(clsId, subtype) { const p = weaponPrefs(clsId); return p.off.indexOf(subtype) >= 0; }
  function classOk(clsId, v) {
    if (!clsId) return true;
    if (v.classes && v.classes.indexOf(clsId) < 0) return false;
    if (v.armourType && ARMOUR_RANK[v.armourType] > ARMOUR_RANK[classArmourType(clsId)]) return false;
    if (v.type === 'weapon' && !classCanWield(clsId, v.subtype)) return false;
    return true;
  }
  function canEquip(player, inst) {
    const v = get(inst);
    if (!player) return { ok: false, reason: 'No player' };
    if (!v) return { ok: false, reason: 'Unknown item' };
    if (!v.slot) return { ok: false, reason: 'This item cannot be equipped' };
    if (typeof player.level === 'number' && v.level > player.level) return { ok: false, reason: 'Requires level ' + v.level };
    if (v.classes && player.cls && v.classes.indexOf(player.cls) < 0) return { ok: false, reason: 'Not usable by your class' };
    if (v.armourType && player.cls && ARMOUR_RANK[v.armourType] > ARMOUR_RANK[classArmourType(player.cls)]) return { ok: false, reason: 'Requires ' + v.armourType + ' armour proficiency' };
    if (v.type === 'weapon' && player.cls && !classCanWield(player.cls, v.subtype)) return { ok: false, reason: className(player.cls) + 's cannot wield ' + (WEAPON[v.subtype] ? WEAPON[v.subtype].label.toLowerCase() + 's' : 'this') };
    return { ok: true, reason: '' };
  }
  function slotsFor(player, inst) {
    const v = get(inst); if (!v || !v.slot) return [];
    const base = v.slot; const out = PAIRS[base] ? PAIRS[base].slice() : [base];
    if (v.type === 'weapon' && base === 'mainhand' && !TWO_HANDED.has(v.subtype) && player && offhandCapable(player.cls, v.subtype)) out.push('offhand');
    return out;
  }
  function targetSlot(player, v, preferred) {
    const eq = player.equipment; const options = slotsFor(player, v.inst || v);
    if (preferred && options.indexOf(preferred) >= 0) return preferred;
    for (let i = 0; i < options.length; i++) { if (PAIRS[options[i]] || options[i] === v.slot) { if (!eq[options[i]]) return options[i]; } }
    return options[0] || v.slot;
  }

  // ---- inventory
  function ensurePlayer(p) {
    if (!p || typeof p !== 'object') return false;
    const n = C.INVENTORY_SLOTS || 200;
    if (!Array.isArray(p.inventory)) p.inventory = new Array(n).fill(null);
    else while (p.inventory.length < n) p.inventory.push(null);
    if (!p.equipment || typeof p.equipment !== 'object') p.equipment = {};
    for (let i = 0; i < C.EQUIP_SLOTS.length; i++) if (!(C.EQUIP_SLOTS[i] in p.equipment)) p.equipment[C.EQUIP_SLOTS[i]] = null;
    if (!p.cooldowns) p.cooldowns = {};
    return true;
  }
  function firstFree(player, skip) { const inv = player.inventory; for (let i = 0; i < inv.length; i++) if (!inv[i] && i !== skip) return i; return -1; }
  function freeSlots(player) { if (!ensurePlayer(player)) return 0; let n = 0; for (let i = 0; i < player.inventory.length; i++) if (!player.inventory[i]) n++; return n; }
  function usedSlots(player) { if (!ensurePlayer(player)) return 0; return player.inventory.length - freeSlots(player); }
  function stackable(inst) { const t = items[inst.tid]; return !!(t && t.maxStack > 1 && !inst.gen && !inst.stats && !inst.name); }
  function addToInventory(player, inst, quiet) {
    if (!ensurePlayer(player)) return false;
    if (typeof inst === 'string') inst = create(inst, 1);
    if (!inst || !items[inst.tid]) return false;
    const t = items[inst.tid]; const inv = player.inventory; const max = t.maxStack || 1;
    let remaining = inst.count || 1;
    // capacity check first so the operation is atomic
    let room = 0;
    if (max > 1 && stackable(inst)) for (let i = 0; i < inv.length; i++) { const s = inv[i]; if (s && s.tid === inst.tid && stackable(s)) room += Math.max(0, max - (s.count || 1)); }
    for (let i = 0; i < inv.length && room < remaining; i++) if (!inv[i]) room += max;
    if (room < remaining) { if (!quiet) { _notify('Your inventory is full', 'warning'); _sfx('ui_error'); } return false; }
    if (max > 1 && stackable(inst)) {
      for (let i = 0; i < inv.length && remaining > 0; i++) {
        const s = inv[i]; if (!s || s.tid !== inst.tid || !stackable(s)) continue;
        const take = Math.min(remaining, max - (s.count || 1)); if (take > 0) { s.count = (s.count || 1) + take; remaining -= take; }
      }
    }
    let placedOriginal = false;
    for (let i = 0; i < inv.length && remaining > 0; i++) {
      if (inv[i]) continue;
      const take = Math.min(remaining, max);
      if (!placedOriginal) { inst.count = take; inv[i] = inst; placedOriginal = true; }
      else { const copy = Object.assign({}, inst, { uid: newUid(), count: take }); inv[i] = copy; }
      remaining -= take;
    }
    _emit('itemGained', { item: inst, count: inst.count || 1, tid: inst.tid, name: get(inst).name });
    _emit('inventoryChanged', player);
    return true;
  }
  function removeFromInventory(player, tid, count) {
    if (!ensurePlayer(player)) return 0;
    let need = count == null ? 1 : count; let removed = 0;
    const inv = player.inventory;
    for (let i = 0; i < inv.length && need > 0; i++) {
      const s = inv[i]; if (!s || s.tid !== tid) continue;
      const take = Math.min(need, s.count || 1); s.count = (s.count || 1) - take; need -= take; removed += take;
      if (s.count <= 0) inv[i] = null;
    }
    if (removed) _emit('inventoryChanged', player);
    return removed;
  }
  function countInInventory(player, tid) {
    if (!ensurePlayer(player)) return 0; let n = 0;
    for (let i = 0; i < player.inventory.length; i++) { const s = player.inventory[i]; if (s && s.tid === tid) n += (s.count || 1); }
    return n;
  }
  function findInInventory(player, tidOrUid) {
    if (!ensurePlayer(player)) return -1;
    for (let i = 0; i < player.inventory.length; i++) { const s = player.inventory[i]; if (s && (s.tid === tidOrUid || s.uid === tidOrUid)) return i; }
    return -1;
  }
  function destroy(player, slotIndex) {
    if (!ensurePlayer(player)) return false;
    const s = player.inventory[slotIndex]; if (!s) return false;
    player.inventory[slotIndex] = null; _emit('inventoryChanged', player); return true;
  }
  function moveSlot(player, from, to) {
    if (!ensurePlayer(player)) return false;
    const inv = player.inventory;
    if (typeof to === 'string') { return equip(player, from, to); }
    if (from === to || from < 0 || to < 0 || from >= inv.length || to >= inv.length) return false;
    const a = inv[from]; if (!a) return false;
    const b = inv[to];
    if (b && b.tid === a.tid && stackable(a) && stackable(b)) {
      const max = items[a.tid].maxStack || 1; const take = Math.min(a.count || 1, max - (b.count || 1));
      if (take > 0) { b.count = (b.count || 1) + take; a.count = (a.count || 1) - take; if (a.count <= 0) inv[from] = null; _emit('inventoryChanged', player); return true; }
    }
    inv[to] = a; inv[from] = b || null;
    _emit('inventoryChanged', player);
    return true;
  }
  const TYPE_ORDER = { weapon: 0, armour: 1, jewellery: 2, consumable: 3, bait: 4, mount: 5, quest: 6, material: 7, fish: 8, misc: 9 };
  function sort(player) {
    if (!ensurePlayer(player)) return false;
    const inv = player.inventory; const list = [];
    for (let i = 0; i < inv.length; i++) if (inv[i]) list.push(inv[i]);
    // merge stacks
    for (let i = 0; i < list.length; i++) {
      const a = list[i]; if (!a || !stackable(a)) continue; const max = items[a.tid].maxStack || 1;
      for (let j = i + 1; j < list.length && (a.count || 1) < max; j++) {
        const b = list[j]; if (!b || b.tid !== a.tid || !stackable(b)) continue;
        const take = Math.min(max - (a.count || 1), b.count || 1); a.count = (a.count || 1) + take; b.count = (b.count || 1) - take; if (b.count <= 0) list[j] = null;
      }
    }
    const out = list.filter(Boolean).map(s => ({ s, v: get(s) }));
    out.sort((x, y) => {
      const a = x.v, b = y.v;
      if (!a || !b) return a ? -1 : 1;
      const to = (TYPE_ORDER[a.type] || 0) - (TYPE_ORDER[b.type] || 0); if (to) return to;
      const sl = C.EQUIP_SLOTS.indexOf(a.slot) - C.EQUIP_SLOTS.indexOf(b.slot); if (sl) return sl;
      const il = (b.ilvl || 0) - (a.ilvl || 0); if (il) return il;
      const rr = RAR_IDX[b.rarity] - RAR_IDX[a.rarity]; if (rr) return rr;
      return String(a.name).localeCompare(String(b.name));
    });
    for (let i = 0; i < inv.length; i++) inv[i] = i < out.length ? out[i].s : null;
    _emit('inventoryChanged', player);
    return true;
  }

  // ---- equipment
  function afterEquipChange(player) {
    try { if (G.Data.stats && typeof G.Data.stats.compute === 'function') G.Data.stats.compute(player); } catch (e) { /* defensive */ }
    if (player.rig && typeof player.rig.setEquipment === 'function') { try { player.rig.setEquipment(player.equipment); } catch (e) { /* defensive */ } }
    _emit('equipChanged', player); _emit('inventoryChanged', player);
    _sfx('equip');
  }
  function fail(reason) { if (reason) _notify(reason, 'warning'); _sfx('ui_error'); return false; }
  function equip(player, slotIndex, preferredSlot) {
    if (!ensurePlayer(player)) return false;
    const inst = player.inventory[slotIndex]; if (!inst) return false;
    const ce = canEquip(player, inst); if (!ce.ok) return fail(ce.reason);
    const v = get(inst); const eq = player.equipment;
    const slot = targetSlot(player, v, preferredSlot);
    if (slot === 'mainhand' && TWO_HANDED.has(v.subtype) && eq.offhand) {
      const free = firstFree(player, slotIndex); if (free < 0) return fail('Your inventory is full');
      player.inventory[free] = eq.offhand; eq.offhand = null;
    }
    if (slot === 'offhand' && eq.mainhand && isTwoHanded(eq.mainhand)) {
      const free = firstFree(player, slotIndex); if (free < 0) return fail('Your inventory is full');
      player.inventory[free] = eq.mainhand; eq.mainhand = null;
    }
    const prev = eq[slot] || null;
    eq[slot] = inst; player.inventory[slotIndex] = prev;
    afterEquipChange(player);
    return true;
  }
  function equipDirect(player, inst, preferredSlot) {
    if (!ensurePlayer(player)) return false;
    if (typeof inst === 'string') inst = create(inst, 1);
    if (!inst) return false;
    const ce = canEquip(player, inst); if (!ce.ok) return fail(ce.reason);
    const v = get(inst); const eq = player.equipment; const slot = targetSlot(player, v, preferredSlot);
    const displaced = [];
    if (slot === 'mainhand' && TWO_HANDED.has(v.subtype) && eq.offhand) displaced.push('offhand');
    if (slot === 'offhand' && eq.mainhand && isTwoHanded(eq.mainhand)) displaced.push('mainhand');
    if (eq[slot]) displaced.push(slot);
    if (displaced.length > freeSlots(player)) return fail('Your inventory is full');
    for (let i = 0; i < displaced.length; i++) { const free = firstFree(player, -1); player.inventory[free] = eq[displaced[i]]; eq[displaced[i]] = null; }
    eq[slot] = inst;
    afterEquipChange(player);
    return true;
  }
  function unequip(player, slot) {
    if (!ensurePlayer(player)) return false;
    const inst = player.equipment[slot]; if (!inst) return false;
    const free = firstFree(player, -1); if (free < 0) return fail('Your inventory is full');
    player.inventory[free] = inst; player.equipment[slot] = null;
    afterEquipChange(player);
    return true;
  }

  // ---- scoring & comparison
  function score(inst, clsId) {
    const v = get(inst); if (!v || !v.slot) return 0;
    const main = clsId ? classMainStat(clsId) : 'might'; const tact = main === 'will';
    const prefs = clsId ? weaponPrefs(clsId) : null;
    const usesShield = !prefs || prefs.off.indexOf('shield') >= 0;
    const W = { vitality: 0.7, fate: 0.45, maxMorale: 0.12, maxPower: 0.06, armour: 0.2, physMastery: tact ? 0.08 : 0.3, tactMastery: tact ? 0.3 : 0.08,
      crit: 0.3, finesse: 0.2, block: usesShield ? 0.25 : 0.05, parry: 0.2, evade: 0.2, resist: 0.1, moraleRegen: 0.5, powerRegen: 0.5, speed: 1 };
    let s = 0; const st = v.stats || {};
    for (const k in st) {
      const n = +st[k] || 0;
      if (k === 'might' || k === 'agility' || k === 'will') s += n * (k === main ? 1.0 : 0.2);
      else s += n * (W[k] || 0.1);
    }
    if (v.dmg) s += (v.dmg.min + v.dmg.max) / 2 * 1.5;
    s += (v.ilvl || 0) * 0.4 + (RAR_IDX[v.rarity] || 0) * 5;
    return s;
  }
  function compare(inst, equipped) {
    const a = get(inst); const b = equipped ? get(equipped) : null;
    const delta = {}; const keys = new Set();
    const sa = a ? a.stats || {} : {}, sb = b ? b.stats || {} : {};
    for (const k in sa) keys.add(k); for (const k in sb) keys.add(k);
    keys.forEach(k => { const d = (+sa[k] || 0) - (+sb[k] || 0); if (d) delta[k] = d; });
    let dmg = 0; if ((a && a.dmg) || (b && b.dmg)) dmg = dps(inst) - (b ? dps(equipped) : 0);
    const parts = []; const html = [];
    STAT_KEYS.forEach(k => { if (delta[k]) { const txt = (delta[k] > 0 ? '+' : '') + delta[k] + ' ' + (STAT_NAMES[k] || k); parts.push(txt); html.push('<div class="' + (delta[k] > 0 ? 'tt-stat' : 'tt-req') + '">' + _esc(txt) + '</div>'); } });
    if (Math.abs(dmg) >= 0.05) { const txt = (dmg > 0 ? '+' : '') + dmg.toFixed(1) + ' DPS'; parts.push(txt); html.push('<div class="' + (dmg > 0 ? 'tt-stat' : 'tt-req') + '">' + _esc(txt) + '</div>'); }
    return { delta, dps: dmg, text: parts.join(', '), html: html.join(''), better: parts.length ? (score(inst) > (b ? score(equipped) : 0)) : false };
  }

  // ---- sets
  function setBonuses(ent) {
    const out = { stats: {}, sets: [] };
    if (!ent || !ent.equipment) return out;
    const counts = {};
    for (const slot in ent.equipment) { const inst = ent.equipment[slot]; if (!inst) continue; const t = items[inst.tid]; if (t && t.set && sets[t.set]) counts[t.set] = (counts[t.set] || 0) + 1; }
    for (const id in counts) {
      const s = sets[id]; const n = counts[id]; const active = [];
      const thresholds = Object.keys(s.bonuses).map(Number).sort((a, b) => a - b);
      for (let i = 0; i < thresholds.length; i++) {
        const th = thresholds[i]; if (n >= th) { active.push(th); const b = s.bonuses[th]; for (const k in b) out.stats[k] = (out.stats[k] || 0) + b[k]; }
      }
      out.sets.push({ id, name: s.name, count: n, total: Math.min(s.pieces.length, thresholds.length ? thresholds[thresholds.length - 1] : s.pieces.length), bonusesActive: active, bonuses: s.bonuses });
    }
    return out;
  }

  // ---- tooltip
  function tooltipHTML(inst, player) {
    const v = get(inst); if (!v) return '<div class="tt-name">Unknown item</div>';
    const h = [];
    h.push('<div class="tt-name rarity-' + v.rarity + '">' + _esc(v.name) + (v.count > 1 ? ' <span class="muted">×' + v.count + '</span>' : '') + '</div>');
    const tl = typeLabel(v);
    if (v.slot) h.push('<div class="tt-line">' + _esc(tl) + ' · ' + _esc(slotLabel(v.slot)) + (v.ilvl ? ' · <span class="muted">Item level ' + v.ilvl + '</span>' : '') + '</div>');
    else h.push('<div class="tt-line">' + _esc(tl) + (v.maxStack > 1 ? ' · stacks to ' + v.maxStack : '') + '</div>');
    if (v.dmg) h.push('<div class="tt-line" style="color:#f0e6c8">' + v.dmg.min + ' - ' + v.dmg.max + ' ' + _esc(DMG_LABEL[v.dmg.type] || v.dmg.type) + ' Damage · ' + (v.speed || 0).toFixed(1) + 's · <b>' + dps(inst).toFixed(1) + ' DPS</b></div>');
    if (v.stats && v.stats.armour) h.push('<div class="tt-line" style="color:#f0e6c8"><b>' + v.stats.armour + ' Armour</b></div>');
    if (v.stats) STAT_KEYS.forEach(k => { if (k === 'armour' || !v.stats[k]) return; h.push('<div class="tt-stat">' + (v.stats[k] > 0 ? '+' : '') + v.stats[k] + (k === 'speed' ? '% ' : ' ') + _esc(STAT_NAMES[k] || k) + '</div>'); });
    if (v.set && sets[v.set]) {
      const s = sets[v.set]; let n = 0; const eqTids = {};
      if (player && player.equipment) for (const slot in player.equipment) { const e = player.equipment[slot]; if (e && items[e.tid] && items[e.tid].set === v.set) { n++; eqTids[e.tid] = 1; } }
      const ths = Object.keys(s.bonuses).map(Number).sort((a, b) => a - b); const total = Math.min(s.pieces.length, ths.length ? ths[ths.length - 1] : s.pieces.length);
      h.push('<div class="tt-set" style="margin-top:4px">' + _esc(s.name) + ' (' + n + '/' + total + ')</div>');
      if (s.pieces.length <= 8) s.pieces.forEach(p => { const pt = items[p]; if (pt) h.push('<div class="tt-line" style="padding-left:8px;' + (eqTids[p] ? 'color:#ffe86b' : '') + '">' + _esc(pt.name) + '</div>'); });
      else h.push('<div class="tt-line" style="padding-left:8px">Any ' + total + ' pieces of the set</div>');
      Object.keys(s.bonuses).map(Number).sort((a, b) => a - b).forEach(th => {
        const b = s.bonuses[th]; const parts = []; for (const k in b) parts.push('+' + b[k] + ' ' + (STAT_NAMES[k] || k));
        h.push('<div class="tt-line" style="' + (n >= th ? 'color:#a6e39f' : 'opacity:.6') + '">(' + th + ') ' + _esc(parts.join(', ')) + '</div>');
      });
    }
    if (v.use) {
      const u = v.use; let txt = '';
      if (u.kind === 'heal') txt = 'Restores ' + u.amount + ' morale';
      else if (u.kind === 'power') txt = 'Restores ' + u.amount + ' power';
      else if (u.kind === 'buff') txt = '+' + u.amount + (u.stat === 'speed' ? '% ' : ' ') + (STAT_NAMES[u.stat] || u.stat) + ' for ' + _r((u.duration || 0) / 60) + ' min';
      else if (u.kind === 'teleport') txt = 'Travel to your home';
      else if (u.kind === 'learnMount') txt = 'Learn this steed' + (v.mount ? ' (speed ' + v.mount.speed + ')' : '');
      else if (u.kind === 'summon') txt = 'Summon an ally';
      if (txt) h.push('<div class="tt-line" style="color:#8fd0ff">Use: ' + _esc(txt) + (u.cd > 5 ? ' (' + (u.cd >= 60 ? _r(u.cd / 60) + ' min' : u.cd + ' s') + ' cooldown)' : '') + '</div>');
    }
    if (v.bait) h.push('<div class="tt-line" style="color:#8fd0ff">Bait: +' + _r(v.bait.bonus * 100) + '% bite chance</div>');
    if (v.slot || v.type === 'mount' || (v.use && v.level > 1)) {
      const unmet = player && typeof player.level === 'number' && player.level < v.level;
      h.push('<div class="' + (unmet ? 'tt-req' : 'tt-line') + '">Requires level ' + v.level + '</div>');
    }
    if (v.armourType && v.type === 'armour') { const unmet = player && player.cls && ARMOUR_RANK[v.armourType] > ARMOUR_RANK[classArmourType(player.cls)]; h.push('<div class="' + (unmet ? 'tt-req' : 'tt-line') + '">' + _cap(v.armourType) + ' armour</div>'); }
    if (v.classes) { const ok = !player || !player.cls || v.classes.indexOf(player.cls) >= 0; h.push('<div class="' + (ok ? 'tt-line' : 'tt-req') + '">Classes: ' + _esc(v.classes.map(className).join(', ')) + '</div>'); }
    else if (v.type === 'weapon' && player && player.cls && !classCanWield(player.cls, v.subtype)) h.push('<div class="tt-req">Cannot be wielded by your class</div>');
    if (v.flavor) h.push('<div class="tt-desc">' + _esc(v.flavor) + '</div>');
    else if (v.desc && !v.slot) h.push('<div class="tt-desc">' + _esc(v.desc) + '</div>');
    else if (v.desc && v.slot && !v.set) h.push('<div class="tt-desc">' + _esc(v.desc) + '</div>');
    if (v.type === 'quest') h.push('<div class="tt-line" style="color:#ffe86b">Quest item</div>');
    else if (sellValue(inst) > 0) h.push('<div class="tt-line" style="margin-top:3px">Sell value: ' + _fmtMoney(sellValue(inst)) + '</div>');
    if (player && v.slot && player.equipment) {
      const slots = slotsFor(player, inst); let eqInst = null;
      for (let i = 0; i < slots.length; i++) if (player.equipment[slots[i]]) { eqInst = player.equipment[slots[i]]; break; }
      if (eqInst && eqInst !== inst && eqInst.uid !== inst.uid) {
        const cmp = compare(inst, eqInst);
        if (cmp.html) h.push('<div class="divider"></div><div class="tt-line">Compared with ' + _esc(get(eqInst).name) + ':</div>' + cmp.html);
      }
    }
    return h.join('');
  }

  // ---- value
  function sellValue(inst) { const v = get(inst); if (!v) return 0; if (v.type === 'quest' || v.sell === 0) return 0; if (v.sell != null) return v.sell; return Math.max(1, Math.floor(v.value * 0.25)) * (v.count || 1); }
  function buyValue(inst) { const v = get(inst); return v ? v.value : 0; }

  // ---- use
  function homePos(player) {
    if (player.home && typeof player.home.x === 'number') return player.home;
    const races = G.Data.races;
    if (Array.isArray(races)) { for (let i = 0; i < races.length; i++) if (races[i].id === player.race && races[i].startPos) return races[i].startPos; }
    return { x: -1040, z: -120 };
  }
  function use(player, slotIndex) {
    if (!ensurePlayer(player)) return false;
    const inst = player.inventory[slotIndex]; if (!inst) return false;
    const v = get(inst); if (!v || !v.use) return false;
    if (v.slot && !v.use) return equip(player, slotIndex);
    const u = v.use;
    if (typeof player.level === 'number' && v.level > player.level) return fail('Requires level ' + v.level);
    if (player.dead || player.alive === false) return fail('You cannot do that while defeated');
    const key = 'item_' + (u.group || v.tid); const now = _now();
    if (player.cooldowns[key] && player.cooldowns[key] > now) return fail('Not ready yet (' + Math.ceil(player.cooldowns[key] - now) + 's)');
    let consume = u.consume !== false;
    switch (u.kind) {
      case 'heal': {
        if (G.Combat && typeof G.Combat.heal === 'function') G.Combat.heal(player, player, u.amount || 0);
        else { const max = (player.stats && player.stats.maxMorale) || 100; player.morale = Math.min(max, (player.morale || 0) + (u.amount || 0)); }
        if (G.UI && G.UI.floatText && player.pos) G.UI.floatText(player.pos, '+' + u.amount, '#7fd47a');
        break;
      }
      case 'power': {
        const max = (player.stats && player.stats.maxPower) || 100; player.power = Math.min(max, (player.power || 0) + (u.amount || 0));
        if (G.UI && G.UI.floatText && player.pos) G.UI.floatText(player.pos, '+' + u.amount, '#6aa7ff');
        break;
      }
      case 'buff': {
        const eff = { id: 'item_' + (u.group || v.tid), name: v.name, kind: 'buff', stat: u.stat, amount: u.amount, remaining: u.duration || 60, total: u.duration || 60, icon: v.icon, src: 'item' };
        if (u.stat === 'speed') { eff.pct = u.amount; delete eff.amount; }
        if (G.Combat && typeof G.Combat.addEffect === 'function') G.Combat.addEffect(player, eff);
        else { if (!Array.isArray(player.effects)) player.effects = []; player.effects = player.effects.filter(e => e.id !== eff.id); player.effects.push(eff); }
        try { if (G.Data.stats && G.Data.stats.compute) G.Data.stats.compute(player); } catch (e) { /* defensive */ }
        break;
      }
      case 'teleport': {
        if (G.state && G.state.inCombat) return fail('You cannot travel while in combat');
        const hp = homePos(player);
        if (G.Player && typeof G.Player.teleport === 'function') G.Player.teleport(hp.x, hp.z);
        else if (player.pos) { player.pos.x = hp.x; player.pos.z = hp.z; }
        _notify('You follow the map home.', 'info');
        break;
      }
      case 'learnMount': {
        if (!Array.isArray(player.mounts)) player.mounts = [];
        if (player.mounts.indexOf(v.tid) >= 0) return fail('You already know this steed');
        player.mounts.push(v.tid); if (!player.mountId) player.mountId = v.tid;
        _notify('You have learned to ride the ' + v.name + '. Press H to mount.', 'info');
        _emit('mountLearned', v.tid);
        break;
      }
      case 'summon': { _emit('itemSummon', { player, item: v }); _notify('You call for aid.', 'info'); break; }
      default: return fail('This item cannot be used');
    }
    player.cooldowns[key] = now + (u.cd || 1);
    _sfx(u.sfx || 'ui_click');
    if (consume) { inst.count = (inst.count || 1) - 1; if (inst.count <= 0) player.inventory[slotIndex] = null; }
    _emit('inventoryChanged', player);
    return true;
  }

  // ---- procedural gear
  const GEN_PREFIX = { common: ['Sturdy', 'Worn', 'Plain', 'Simple', 'Serviceable'], uncommon: ['Fine', 'Well-made', 'Polished', 'Reinforced', 'Keen'], rare: ['Exquisite', 'Masterwork', 'Gleaming', 'Runed', 'Blessed'],
    incomparable: ['Ancient', 'Kingly', 'Mithril-laced', 'Star-forged', 'Hallowed'], legendary: ['Fabled', 'Legendary', 'Númenórean', 'Sunlit', 'Undying'] };
  const GEN_SUFFIX = [
    ['of Vigour', [['vitality', 1]]], ['of Might', [['might', 1]]], ['of Grace', [['agility', 1]]], ['of Wisdom', [['will', 1]]], ['of Fortune', [['fate', 1]]],
    ['of the Bear', [['vitality', 0.6], ['might', 0.4]]], ['of the Hawk', [['agility', 0.5], ['crit', 0.5]]], ['of the Sage', [['will', 0.5], ['tactMastery', 0.5]]], ['of Warding', [['armour', 0.6], ['vitality', 0.4]]],
    ['of the Eagle', [['crit', 0.7], ['fate', 0.3]]], ['of the Oak', [['maxMorale', 0.6], ['vitality', 0.4]]], ['of the Wolf', [['physMastery', 0.7], ['might', 0.3]]], ['of the Stars', [['tactMastery', 0.6], ['will', 0.4]]],
    ['of the Fox', [['evade', 0.5], ['finesse', 0.5]]], ['of the Wall', [['block', 0.5], ['parry', 0.5]]], ['of the Dúnedain', [['might', 0.3], ['vitality', 0.3], ['fate', 0.4]]], ['of the Elves', [['will', 0.3], ['agility', 0.3], ['fate', 0.4]]],
    ['of the Deep', [['maxPower', 0.5], ['will', 0.5]]], ['of the Road', [['vitality', 0.5], ['evade', 0.5]]], ['of the North', [['might', 0.4], ['armour', 0.3], ['resist', 0.3]]]];
  const GEN_SLOT_POOL = ['head', 'shoulder', 'back', 'chest', 'hands', 'legs', 'feet', 'mainhand', 'offhand', 'ranged', 'neck', 'ear1', 'wrist1', 'ring1', 'pocket', 'chest', 'legs', 'mainhand'];
  function rollRarity(rnd, weights) { let r = rnd() * (weights[0] + weights[1] + weights[2] + weights[3] + weights[4]); for (let i = 0; i < 5; i++) { r -= weights[i]; if (r < 0) return RARITY[i]; } return 'common'; }
  function generate(opts) {
    const o = opts || {};
    const level = _clamp(_r(+o.level || 1), 1, C.LEVEL_CAP || 80);
    let rnd;
    if (o.seed != null) rnd = _rng(typeof o.seed === 'string' ? _hashStr(o.seed) : (o.seed | 0));
    else rnd = _rand;
    const rarity = (o.rarity && RAR_IDX[o.rarity] != null) ? o.rarity : rollRarity(rnd, [0.5, 0.3, 0.14, 0.05, 0.01]);
    const ri = RAR_IDX[rarity];
    const clsId = o.cls || null;
    let slot = o.slot ? baseSlot(o.slot) : _pickR(rnd, GEN_SLOT_POOL);
    if (C.EQUIP_SLOTS.indexOf(slot) < 0) slot = 'chest';
    const mainStat = o.mainStat || (clsId ? classMainStat(clsId) : _pickR(rnd, ['might', 'agility', 'will']));
    const ti = tierIndex(level); const T = TIER[ti]; const band = bandOf(ti);
    const ilvl = level * 10 + RAR_ILVL[ri] + Math.floor(rnd() * 5);
    const prefix = _pickR(rnd, GEN_PREFIX[rarity]);
    const suffix = _pickR(rnd, GEN_SUFFIX);
    const base = [[mainStat, 0.4], ['vitality', 0.25]];
    const profile = base.concat(suffix[1].map(p => [p[0], p[1] * 0.35]));
    let tid, name, dmg = null, visual, isWeapon = false, sub = null, at = null;
    if (ARMOUR_SLOTS.indexOf(slot) >= 0) {
      at = o.armourType || (clsId ? classArmourType(clsId) : _pickR(rnd, ['light', 'medium', 'heavy']));
      if (!ARMOUR_TYPE_MULT[at]) at = 'medium';
      tid = 'gen_a_' + at + '_' + slot;
      const nouns = ARMOUR_NOUNS[at][slot]; const noun = _pickR(rnd, nouns);
      name = prefix + ' ' + T.mat[at] + ' ' + noun + ' ' + suffix[0];
      visual = { color: ARMOUR_COLOR[at][band], glow: ri >= 3 ? (T.glow || 0xffe8a0) : undefined };
    } else if (WEAPON_SLOTS.indexOf(slot) >= 0) {
      isWeapon = true;
      const prefs = weaponPrefs(clsId || 'guardian');
      const pool = slot === 'mainhand' ? prefs.main.filter(s => !o.noTwoHanded || !TWO_HANDED.has(s)) : slot === 'offhand' ? prefs.off : prefs.ranged;
      sub = (o.subtype && WEAPON[o.subtype]) ? o.subtype : _pickR(rnd, pool.length ? pool : ['sword']);
      if (!clsId && !o.subtype) { const any = WEAPON_SUBTYPES.filter(s => WEAPON[s].slot === slot || (slot === 'offhand' && ['sword', 'axe', 'mace', 'dagger'].indexOf(s) >= 0)); sub = _pickR(rnd, any); }
      tid = 'gen_w_' + sub;
      const W = WEAPON[sub]; const noun = W.nouns[band];
      name = prefix + ' ' + T.adjC[Math.floor(rnd() * T.adjC.length)] + ' ' + noun + ' ' + suffix[0];
      visual = { weaponShape: W.shape, color: (sub === 'bow' || sub === 'crossbow' || sub === 'staff') ? [0x8a6a3a, 0x7a5a2a, 0x6a4a2a, 0x5a3a1a][band] : T.wcol, glow: ri >= 3 ? (T.glow || 0xffe8a0) : undefined };
      if (!W.noDmg) { dmg = weaponDmg(ilvl, rarity, sub); const varr = 0.94 + rnd() * 0.12; dmg.min = Math.max(1, _r(dmg.min * varr)); dmg.max = Math.max(dmg.min + 1, _r(dmg.max * varr)); dmg.type = sub === 'runestone' ? _pickR(rnd, ['lightning', 'fire', 'frost']) : (W.dtype || T.dtype); }
    } else {
      tid = 'gen_j_' + slot;
      const noun = _pickR(rnd, JEWEL_NOUNS[slot]);
      name = prefix + ' ' + T.jewel + ' ' + noun + ' ' + suffix[0];
      visual = { color: 0xd4af5a, glow: ri >= 3 ? (T.glow || 0xffe8a0) : undefined };
    }
    if (!items[tid]) return null;
    const B = budget(ilvl, rarity, slot);
    const stats = distribute(B, profile, rnd, 0.1);
    if (at) stats.armour = _r(armourValue(ilvl, rarity, slot, at) * (0.95 + rnd() * 0.1));
    if (sub === 'shield') stats.armour = _r(4.0 * ilvl * 0.45 * (1 + ri * 0.08));
    const inst = { uid: newUid(), tid, count: 1, gen: true, name, ilvl, level, rarity, stats, value: valueFor(ilvl, rarity, slot), visual };
    if (isWeapon) { inst.dmg = dmg; }
    return inst;
  }

  // ---- best in slot / sets
  function bestInSlot(level, clsId, slot, opts) {
    const o = opts || {}; level = _clamp(_r(+level || 1), 1, C.LEVEL_CAP || 80);
    const base = baseSlot(slot); if (C.EQUIP_SLOTS.indexOf(base) < 0) return null;
    const prefs = weaponPrefs(clsId || 'guardian');
    let cands;
    if (base === 'offhand') {
      cands = [];
      prefs.off.forEach(s => { const W = WEAPON[s]; if (!W) return; cands = cands.concat(byType('weapon').filter(t => t.subtype === s)); });
    } else if (base === 'mainhand' || base === 'ranged') {
      const pool = (base === 'mainhand' ? prefs.main : prefs.ranged).filter(s => !o.noTwoHanded || !TWO_HANDED.has(s));
      cands = bySlot(base).filter(t => pool.indexOf(t.subtype) >= 0);
    } else cands = bySlot(base);
    let best = null, bestScore = -Infinity;
    for (let i = 0; i < cands.length; i++) {
      const t = cands[i]; if (t.level > level || t.hidden) continue;
      if (clsId && !classOk(clsId, t)) continue;
      if (o.exclude && o.exclude.indexOf(t.id) >= 0) continue;
      const s = score(t.id, clsId); if (s > bestScore) { bestScore = s; best = t; }
    }
    if (best && best.rarity === 'legendary' && best.level === level) return create(best.id, 1);
    const subtype = base === 'mainhand' ? prefs.main.filter(s => !o.noTwoHanded || !TWO_HANDED.has(s))[0] : base === 'offhand' ? prefs.off[0] : base === 'ranged' ? prefs.ranged[0] : undefined;
    const gen = generate({ level, slot: base, rarity: 'legendary', cls: clsId, seed: _hashStr('bis:' + level + ':' + clsId + ':' + base + ':' + (o.seed || 0)), subtype, noTwoHanded: o.noTwoHanded, armourType: clsId ? classArmourType(clsId) : undefined });
    if (gen && (!best || score(gen, clsId) >= bestScore)) return gen;
    return best ? create(best.id, 1) : gen;
  }
  function bestSet(level, clsId) {
    level = _clamp(_r(+level || 1), 1, C.LEVEL_CAP || 80);
    if (level >= 80) { const lk = lostKingdomSet(clsId); if (lk && lk.length === 18 && lk.every(Boolean)) return lk; }
    const out = []; let mainTid = null;
    for (let i = 0; i < C.EQUIP_SLOTS.length; i++) {
      const slot = C.EQUIP_SLOTS[i];
      const inst = bestInSlot(level, clsId, slot, { noTwoHanded: true, seed: slot, exclude: slot === 'offhand' && mainTid ? [mainTid] : null });
      if (slot === 'mainhand' && inst) mainTid = inst.tid;
      out.push(inst);
    }
    return out;
  }
  function lostKingdomSet(clsId) {
    const at = classArmourType(clsId || 'guardian'); const prefs = weaponPrefs(clsId || 'guardian');
    const out = [];
    const armour = {}; lostKingdom.armour[at].forEach(id => { armour[items[id].slot] = id; });
    for (let i = 0; i < C.EQUIP_SLOTS.length; i++) {
      const slot = C.EQUIP_SLOTS[i]; let tid = null;
      if (armour[slot]) tid = armour[slot];
      else if (slot === 'mainhand') { const s = prefs.main.filter(x => !TWO_HANDED.has(x))[0] || prefs.main[0]; tid = lostKingdom.weapons[s]; }
      else if (slot === 'offhand') {
        const mainSub = prefs.main.filter(x => !TWO_HANDED.has(x))[0] || prefs.main[0];
        const s = prefs.off.filter(x => x !== mainSub)[0] || prefs.off[0];
        tid = (s === 'gauntlets') ? lostKingdom.weapons.gauntlets_off : lostKingdom.weapons[s];
      }
      else if (slot === 'ranged') { const s = prefs.ranged[0]; tid = lostKingdom.weapons[s]; }
      else if (slot === 'neck') tid = 'lk_j_torc';
      else if (slot === 'ear1') tid = 'lk_j_earring'; else if (slot === 'ear2') tid = 'lk_j_earcuff';
      else if (slot === 'wrist1') tid = 'lk_j_bracelet'; else if (slot === 'wrist2') tid = 'lk_j_armlet';
      else if (slot === 'ring1') tid = 'lk_j_ring'; else if (slot === 'ring2') tid = 'lk_j_signet';
      else if (slot === 'pocket') tid = 'lk_j_keepsake';
      out.push(tid && items[tid] ? create(tid, 1) : null);
    }
    return out;
  }
  function starterGear(clsId) {
    const at = classArmourType(clsId || 'guardian'); const prefs = weaponPrefs(clsId || 'guardian'); const out = [];
    SET_SLOTS.forEach(slot => { const id = 's_starter_' + at + '_' + slot; if (items[id]) out.push(create(id, 1)); });
    out.push(create('a_' + at + '_back_1_c', 1));
    const m = prefs.main.filter(s => !TWO_HANDED.has(s))[0]; if (m && items['w_' + m + '_1_c']) out.push(create('w_' + m + '_1_c', 1));
    const r = prefs.ranged[0]; if (r && items['w_' + r + '_1_c']) out.push(create('w_' + r + '_1_c', 1));
    if (prefs.off[0] === 'shield' && items.w_shield_1_c) out.push(create('w_shield_1_c', 1));
    else if (prefs.off[0] === 'talisman' && items.w_talisman_1_c) out.push(create('w_talisman_1_c', 1));
    return out.filter(Boolean);
  }

  // ---- auto-equip (used by the auto-quest bot and AI players)
  function autoEquipBetter(player) {
    if (!ensurePlayer(player)) return 0;
    let count = 0, changed = true, guard = 0;
    while (changed && guard++ < 40) {
      changed = false;
      const inv = player.inventory;
      for (let i = 0; i < inv.length; i++) {
        const inst = inv[i]; if (!inst) continue;
        const v = get(inst); if (!v || !v.slot) continue;
        if (!canEquip(player, inst).ok) continue;
        const options = slotsFor(player, inst);
        let bestSlot = null, bestGain = 0;
        const mine = score(inst, player.cls);
        for (let k = 0; k < options.length; k++) {
          const slot = options[k]; const cur = player.equipment[slot];
          let curScore = cur ? score(cur, player.cls) : 0;
          if (slot === 'mainhand' && TWO_HANDED.has(v.subtype) && player.equipment.offhand) curScore += score(player.equipment.offhand, player.cls);
          if (slot === 'offhand' && player.equipment.mainhand && isTwoHanded(player.equipment.mainhand)) curScore += score(player.equipment.mainhand, player.cls) * 0.5;
          const gain = mine - curScore;
          if (gain > bestGain + 0.01) { bestGain = gain; bestSlot = slot; }
        }
        if (bestSlot && bestGain > 0.5) { if (equip(player, i, bestSlot)) { count++; changed = true; break; } }
      }
    }
    return count;
  }

  // ---- loot
  const FAMILY_DROPS = {
    wolf: [['mat_wolf_pelt', 0.45, 2], ['junk_wolf_fang', 0.3, 1]], boar: [['mat_boar_hide', 0.45, 2], ['junk_boar_tusk', 0.3, 1]], bear: [['mat_bear_pelt', 0.4, 1], ['junk_bear_claw', 0.3, 2]],
    spider: [['mat_spider_silk', 0.4, 2], ['junk_spider_venom', 0.25, 1]], goblin: [['junk_goblin_ear', 0.5, 1], ['junk_rusty_dagger', 0.2, 1], ['junk_goblin_totem', 0.08, 1]],
    orc: [['junk_orc_tooth', 0.45, 1], ['junk_cracked_shield_boss', 0.2, 1], ['mat_iron_ore', 0.1, 1]], brigand: [['junk_bent_coin', 0.4, 3], ['q_brigand_map', 0.05, 1], ['junk_tattered_banner', 0.12, 1]],
    troll: [['junk_troll_toenail', 0.5, 1], ['mat_troll_hide', 0.35, 1]], wight: [['junk_barrow_relic', 0.35, 1], ['junk_bone_dust', 0.4, 1], ['junk_wight_shroud', 0.2, 1]],
    bat: [['junk_bat_wing', 0.5, 2]], warg: [['mat_warg_hide', 0.4, 1], ['junk_warg_claw', 0.3, 1]], crawler: [['junk_crawler_shell', 0.45, 1]], lynx: [['mat_lynx_fur', 0.45, 1]],
    drake: [['mat_drake_scale', 0.4, 1], ['junk_drake_tooth', 0.3, 1]], giant: [['junk_giant_tooth', 0.4, 1], ['junk_giant_bone', 0.3, 1]], slug: [['junk_slug_slime', 0.5, 2]],
    uruk: [['junk_uruk_iron', 0.4, 1], ['junk_orc_tooth', 0.3, 1]], sorcerer: [['junk_angmarim_sigil', 0.4, 1], ['junk_dark_tome_scrap', 0.3, 1]],
    'lossoth-bear': [['mat_white_bear_pelt', 0.4, 1], ['junk_white_bear_claw', 0.3, 1]], 'sea-serpent': [['junk_serpent_fang', 0.4, 1], ['mat_serpent_scale', 0.35, 1]],
  };
  function rollGold(level) { const L = _clamp(+level || 1, 1, 80); const base = 3 + L * 2.2 + L * L * 0.09; return Math.max(1, _r(base * (0.6 + _rand() * 0.8))); }
  function potionsNear(level) { const out = []; for (const id in items) { const t = items[id]; if (t.type === 'consumable' && (t.subtype === 'potion' || t.subtype === 'food') && t.level <= level && t.level >= level - 20) out.push(id); } return out; }
  function lootFor(mt, level) {
    const out = [];
    let lvl = level;
    if (lvl == null && mt) lvl = Array.isArray(mt.level) ? _r((mt.level[0] + mt.level[1]) / 2) : mt.level;
    lvl = _clamp(_r(+lvl || 1), 1, 80);
    const boss = !!(mt && mt.boss), elite = !!(mt && mt.elite);
    if (mt && Array.isArray(mt.loot)) for (let i = 0; i < mt.loot.length; i++) {
      const e = mt.loot[i]; if (!e || !items[e.tid]) continue;
      if (_chance(e.chance == null ? 1 : e.chance)) out.push(create(e.tid, e.count || 1));
    }
    const fam = mt && FAMILY_DROPS[mt.family];
    if (fam) for (let i = 0; i < fam.length; i++) { const d = fam[i]; if (_chance(d[1] * (boss ? 2 : elite ? 1.5 : 1))) out.push(create(d[0], d[2] > 1 ? _randInt(1, d[2]) : 1)); }
    const gearChance = boss ? 1 : elite ? 0.35 : 0.08; const rolls = boss ? 2 : 1;
    for (let r = 0; r < rolls; r++) if (_chance(r === 0 ? gearChance : 0.5)) {
      const rarity = rollRarity(_rand, boss ? [0, 0.3, 0.45, 0.2, 0.05] : elite ? [0.2, 0.45, 0.28, 0.06, 0.01] : [0.55, 0.32, 0.11, 0.02, 0]);
      const g = generate({ level: lvl, rarity }); if (g) out.push(g);
    }
    if (_chance(boss ? 0.6 : elite ? 0.3 : 0.12)) { const pool = potionsNear(lvl); if (pool.length) out.push(create(pool[_randInt(0, pool.length - 1)], 1)); }
    if (boss && _chance(0.35)) {
      const named = all(false).filter(t => t.id.indexOf('n_') === 0 && t.level <= lvl + 2 && t.level >= lvl - 10);
      if (named.length) out.push(create(named[_randInt(0, named.length - 1)].id, 1));
    }
    out.gold = rollGold(lvl) * (boss ? 5 : elite ? 2 : 1);
    return out;
  }

  // ---- vendors
  function vendorStock(kind, level) {
    const L = _clamp(_r(+level || 1), 1, 80); const ti = tierIndex(L); const t0 = TIERS[ti], t1 = TIERS[Math.min(ti + 1, TIERS.length - 1)];
    const out = [];
    const push = id => { if (items[id] && out.indexOf(id) < 0) out.push(id); };
    switch (kind) {
      case 'armour': {
        ['light', 'medium', 'heavy'].forEach(at => ARMOUR_SLOTS.forEach(slot => { push('a_' + at + '_' + slot + '_' + t0 + '_c'); push('a_' + at + '_' + slot + '_' + t0 + '_u'); if (t1 !== t0) push('a_' + at + '_' + slot + '_' + t1 + '_c'); }));
        all(false).forEach(t => { if (t.type === 'armour' && t.id.indexOf('n_') === 0 && t.level <= L + 3 && t.level >= L - 6 && RAR_IDX[t.rarity] <= 2) push(t.id); });
        break;
      }
      case 'weapons': {
        WEAPON_SUBTYPES.forEach(sub => { push('w_' + sub + '_' + t0 + '_c'); push('w_' + sub + '_' + t0 + '_u'); if (t1 !== t0) push('w_' + sub + '_' + t1 + '_c'); });
        all(false).forEach(t => { if (t.type === 'weapon' && t.id.indexOf('n_') === 0 && t.level <= L + 3 && t.level >= L - 6 && RAR_IDX[t.rarity] <= 2) push(t.id); });
        break;
      }
      case 'food': {
        FOODS.forEach(f => { if (f[2] <= L + 3) push(f[0]); });
        push('drink_pony_ale'); if (L >= 45) push('drink_miruvor'); if (L >= 60) push('drink_lossoth_tea');
        ['fish_brandywine_trout', 'fish_evendim_salmon', 'fish_forochel_icecod'].forEach(id => { if (items[id].fishLevel <= L + 5) push(id); });
        POTS.forEach(p => { if (p[2] <= L) push('pot_heal_' + p[0]); });
        break;
      }
      case 'fishing': {
        ['bait_worms', 'bait_bread', 'bait_cricket', 'bait_minnow', 'bait_shrimp'].forEach(id => { if (items[id].level <= L + 4) push(id); });
        push('misc_fishing_rod'); if (L >= 35) push('misc_fishing_rod_elven');
        push('scroll_angler_10'); if (L >= 45) push('scroll_angler_50');
        FISH.forEach(f => { if (f[5] && f[2] <= L + 5) push('fish_' + f[0]); });
        break;
      }
      default: { // general
        POTS.forEach(p => { if (p[2] <= L && p[2] >= L - 30) push('pot_heal_' + p[0]); });
        PPOTS.forEach(p => { if (p[2] <= L && p[2] >= L - 30) push('pot_power_' + p[0]); });
        FOODS.forEach(f => { if (f[2] <= L && f[2] >= L - 20) push(f[0]); });
        SCROLLS.forEach(s => { if (s[0] === 'angler') return; push('scroll_' + s[0] + '_' + (L >= 50 ? 50 : 10)); });
        push('bait_worms'); push('map_home');
        JEWEL_SLOTS.forEach(slot => push('j_' + slot.replace(/1$/, '') + '_' + t0 + '_c'));
        push('a_light_back_' + t0 + '_c'); push('a_medium_back_' + t0 + '_c'); push('a_heavy_back_' + t0 + '_c');
        if (L >= 8) push('mount_shire'); if (L >= 10) push('mount_bree'); if (L >= 15) push('mount_dwarf');
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ export
  G.Items = {
    TIERS, STAT_KEYS, STAT_NAMES, WEAPON_SUBTYPES, ARMOUR_SLOTS, JEWEL_SLOTS, WEAPON_SLOTS, PAIRS, PROFILES,
    template, all, byType, bySlot, search, tierFor,
    create, get, rarityOf, rarityClass, rarityColor, slotLabel, typeLabel, baseSlot, pairSlots, slotsFor, iconHTML, isJunk, isEquippable, isUsable, isTwoHanded, dps,
    weaponPrefs, classCanWield, classOk, canEquip,
    addToInventory, removeFromInventory, countInInventory, findInInventory, freeSlots, usedSlots, moveSlot, sort, destroy,
    equip, equipDirect, unequip, use, sellValue, buyValue, tooltipHTML, compare, score, setBonuses, autoEquipBetter,
    generate, bestInSlot, bestSet, lostKingdomSet, starterGear, lootFor, rollGold, vendorStock,
  };
})();
