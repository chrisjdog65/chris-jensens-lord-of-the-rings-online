/* ==== 02_data_races_classes.js — Races, classes, stat formulas, XP/gold economy, names & titles.
 *
 * Pure data + pure functions (no THREE, no DOM, no per-frame code). Loads right after core/audio.
 *
 * Public API (everything under G.Data):
 *   G.Data.races            array of 10 races in §4.1 order         G.Data.raceById[id]
 *   G.Data.classes          array of 10 classes (§4.2)               G.Data.classById[id]
 *   G.Data.classTraits[cls] 8 passive traits (levels 10..80)         G.Data.traitsFor(cls, level) / nextTrait(cls, level)
 *   G.Data.randomName(raceId, gender, rng?)      single-word first name (ASCII letters, 3–16 chars)
 *   G.Data.randomSurname(raceId, rng?)           '' for races without surnames
 *   G.Data.randomFullName(raceId, gender, rng?)  'First Surname' where the race uses surnames
 *   G.Data.titles / titleById / titleName(idOrName, gender)
 *   G.Data.difficultyColor(entityLevel, playerLevel) → '#rrggbb'   G.Data.conLabel(...) → 'Trivial'…'Deadly'
 *   G.Data.difficulty(entityLevel, playerLevel) → { key, color, label, diff }
 *   G.Data.describeBonus(bonus, level) → 'human readable list of stat bonuses'
 *   G.Data.stats: compute(ent), STAT_NAMES, STAT_KEYS, PRIMARY_KEYS, RATING_KEYS, describe(stat),
 *                 mitigation(ent), critChance(ent), blockChance(ent), parryChance(ent), evadeChance(ent),
 *                 resistChance(ent), percentages(ent), weaponAvg(ent), preview(clsId, raceId, level)
 *   G.Data.xp: MAX_LEVEL, forLevel(L), needFor(L), levelForXP(xp), progress(xp), total80,
 *              questXP(level, type), killXP(mobLevel, playerLevel, mult), goldReward(level, type),
 *              abilityCost(level), storyLevelPlan, sideLevel(index), storyLevel(index)
 *
 * Entity conventions read by stats.compute (all optional, all defensive):
 *   ent.cls, ent.race, ent.level, ent.equipment {slot: ItemInstance|null}, ent.effects [ {kind, stat, amount, pct} ],
 *   ent.statBonus {stat: +n}   free-form additive bonuses (admin panel, consumables that are not effects)
 *   ent.statOverride {primary: value}   admin override of a primary stat (applied after all bonuses)
 *   ent.baseStats {…}          creature (class-less entity) baseline: might…fate, maxMorale, maxPower, armour
 * Debuff effects are applied as a reduction regardless of the sign of `amount`; buffs use the sign as given.
 * `pct` values with |pct| <= 1 are treated as fractions (0.25 = 25%), larger values as percentages (25 = 25%).
 * ==== */
(function () {
  'use strict';
  const G = window.G;
  G.Data = G.Data || {};
  const D = G.Data;
  const C = G.C || {};
  const LEVEL_CAP = C.LEVEL_CAP || 80;

  /* ------------------------------------------------------------------------------------------------
   * small helpers (no dependency on later modules)
   * ---------------------------------------------------------------------------------------------- */
  function _rngOf(rng) {
    if (typeof rng === 'function') return rng;
    if (typeof G.rand === 'function') return G.rand;
    return Math.random;
  }
  function _pick(arr, rng) { return arr[Math.floor(rng() * arr.length) % arr.length]; }
  function _clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function _lvl(ent) {
    const L = ent && typeof ent.level === 'number' && isFinite(ent.level) ? ent.level : 1;
    return _clamp(Math.floor(L), 1, 120);
  }
  function _num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }

  /* ------------------------------------------------------------------------------------------------
   * §4.1 RACES
   * racialTrait: { name, desc, stats {flat}, perLevel {stat: n per level}, pct {stat: %}, special {…} }
   * ---------------------------------------------------------------------------------------------- */
  const RACES = [
    {
      id: 'man', name: 'Man', plural: 'Men',
      desc: 'The Men of Eriador are the heirs of a long and troubled history: the folk of Bree who kept the Greenway open when the North-kingdom fell, the hardy Dalesmen, and the river-folk who ply the Brandywine. Adaptable and stout-hearted, they lack the ageless grace of the Elves and the stone-patience of the Dwarves, but no people in Middle-earth is quicker to rally when the Shadow stirs. Their villages of timber and thatch stand at the crossroads of the world, and they have learned to greet a stranger with one hand on the sword-hilt and a mug of ale in the other. In these latter days many of them look upon the Rangers with unease, never guessing that the blood of kings walks unlooked-for among them.',
      homeZone: 'breeland', startTown: 'archet', startPos: { x: -60, z: -250 },
      statBonus: { might: 8, agility: 0, vitality: 6, will: -3, fate: 0 },
      height: 1.0, build: 'normal',
      skinTones: [0xf1d2b4, 0xe6bb95, 0xd9a878, 0xc48f5e, 0xa5714a, 0x7c5033],
      hairColors: [0x2b1b12, 0x4a2c17, 0x7a4a24, 0xb07a3a, 0xd9b26b, 0x8c8c8c, 0xe8e2d2, 0x9b2f1f],
      hairStyles: 5,
      racialTrait: {
        name: 'Valour of Men',
        desc: 'The sons and daughters of Men fight hardest when their homes are at their backs. Increases Might and maximum Morale.',
        stats: { might: 5, maxMorale: 30 }, perLevel: { might: 0.5, maxMorale: 2 }, pct: { maxMorale: 3 }, special: {},
      },
      namesM: [
        ['Bar', 'Har', 'Wil', 'Rob', 'Tom', 'Wat', 'Ned', 'Hob', 'Ed', 'Al', 'Os', 'Ber', 'Gil', 'Ran', 'Ald', 'Wal', 'Hen', 'Ger', 'Ar', 'Ord', 'Cal', 'Ead', 'Wig', 'Hum', 'Sig', 'Cuth', 'Bald', 'Ulf', 'Row', 'Mat', 'Ham', 'Jas', 'Ren', 'Tam', 'Dun', 'Col', 'Ash', 'Bran', 'Cor', 'Ev', 'Fal', 'Gar', 'Hal', 'Jor', 'Lam', 'Mar', 'Nor', 'Pet', 'Rad', 'Ter', 'Web', 'Wes', 'Ott', 'Godd', 'Herb', 'Tob'],
        ['', '', '', '', '', 'a', 'e', 'i', 'o', 'el', 'er', 'en', 'ar'],
        ['liman', 'ry', 'fred', 'bert', 'wald', 'win', 'ric', 'mund', 'ward', 'ley', 'cott', 'son', 'kin', 'ard', 'oth', 'ert', 'ald', 'ulf', 'bald', 'stan', 'ton', 'ith', 'iam', 'vin', 'tin', 'dric', 'red', 'lin', 'bin', 'nard', 'dan', 'mon', 'ric', 'wick', 'ham'],
      ],
      namesF: [
        ['Ma', 'El', 'Ro', 'Be', 'Hil', 'Ag', 'Win', 'Ed', 'Al', 'Mar', 'Til', 'Sar', 'Cor', 'Jes', 'Fay', 'Ide', 'Mil', 'Gwen', 'Ceo', 'Aud', 'Eth', 'Ber', 'Ann', 'Bri', 'Cat', 'Dor', 'Em', 'Fen', 'Gis', 'Hen', 'Is', 'Jon', 'Kat', 'Lin', 'Mor', 'Nel', 'Or', 'Pen', 'Ros', 'Sel', 'Tam', 'Ver', 'Wen', 'Yol', 'Mab', 'Hol', 'Ell', 'Ad'],
        ['', '', '', '', 'a', 'e', 'i', 'o', 'el', 'er', 'an', 'il'],
        ['ry', 'sa', 'lind', 'da', 'wyn', 'ith', 'a', 'bel', 'sy', 'na', 'ette', 'ie', 'is', 'en', 'ora', 'eth', 'ina', 'ella', 'ia', 'ene', 'lee', 'cy', 'ny', 'ily', 'ise', 'dith', 'beth', 'gard', 'rid', 'win', 'elle', 'ot', 'wen', 'da'],
      ],
      exemplarsM: ['Barliman', 'Harry', 'Rowlie', 'Wilfred', 'Osric', 'Aldric', 'Ranulf', 'Edwald', 'Gerard', 'Cuthbert', 'Baldwin', 'Halbert', 'Mattock', 'Herbert', 'Tobias', 'Ordric'],
      exemplarsF: ['Marigold', 'Elsa', 'Rosalind', 'Bethany', 'Hilda', 'Agnes', 'Winifred', 'Edith', 'Alwen', 'Tilda', 'Corliss', 'Fayre', 'Idelle', 'Gwendolyn', 'Audrey', 'Ethelinda'],
      surnames: ['Butterbur', 'Ferny', 'Goatleaf', 'Appledore', 'Heathertoes', 'Pickthorn', 'Thistlewool', 'Mugwort', 'Rushlight', 'Underhill', 'Longholes', 'Brockhouse', 'Hedgerow', 'Fernbrake', 'Dogwood', 'Oakenshaw', 'Sandybanks', 'Hayward', 'Mossfoot', 'Marshbottom', 'Thornbush', 'Whitecliff', 'Ashdown', 'Greenway', 'Milburn', 'Stonehewer', 'Fletcher', 'Cooper', 'Thatcher', 'Wainwright', 'Fowler', 'Smallwood', 'Bramblecote', 'Woodward', 'Chubb', 'Tunnelly', 'Rushey', 'Ashcombe', 'Bracken', 'Holloway'],
    },
    {
      id: 'elf', name: 'Elf', plural: 'Elves',
      desc: 'The Elves of Lindon and Rivendell are the Firstborn, eldest of the Free Peoples and the most sorrowful, for they remember an Age before the Sun when the world was young and the Enemy had not yet marred it. Long years have made them swift and sure of hand, keen of eye and ear, and patient beyond the understanding of mortals. Though many have taken ship into the West, some linger still in the fading havens of the Grey Havens and the hidden valley of Imladris, unwilling to abandon Middle-earth while the Shadow endures. An Elf who takes up arms does so with the memory of ten thousand years of war, and with the grace of one who has never known haste.',
      homeZone: 'eredluin', startTown: 'celondim', startPos: { x: -1410, z: -690 },
      statBonus: { might: -4, agility: 10, vitality: -4, will: 4, fate: 2 },
      height: 1.05, build: 'slim',
      skinTones: [0xf6e4d1, 0xf1d7bf, 0xe9c9ab, 0xdcb995, 0xc9a37f],
      hairColors: [0x1b1410, 0x3a2a1c, 0x6b4a2a, 0xd8c27a, 0xf0e6c4, 0xb8b8c8, 0x8a5a2a],
      hairStyles: 5,
      racialTrait: {
        name: 'Elven Grace',
        desc: 'The Eldar move as a leaf moves on the wind. Increases Evade rating and Agility, and Elves suffer no harm from a fall that would bruise a Man.',
        stats: { evade: 30, agility: 4 }, perLevel: { evade: 3, agility: 0.3 }, pct: {}, special: { fallDamageMult: 0.5 },
      },
      namesM: [
        ['Leg', 'Gal', 'Thran', 'Elr', 'Glor', 'Hal', 'Cel', 'Am', 'Ar', 'Bel', 'Cir', 'Dae', 'Ec', 'Eg', 'Fin', 'Gil', 'Gwin', 'Hir', 'Idh', 'Lin', 'Mael', 'Nim', 'Or', 'Pen', 'Rad', 'Sael', 'Tal', 'Thal', 'Ul', 'Vor', 'Ith', 'Mith', 'Nar', 'Ber', 'Cal', 'Dor', 'Erest', 'Gwae', 'Lind', 'Mal', 'Oro', 'Rin', 'Sar', 'Tath', 'Thor', 'Aer', 'Bar', 'Den', 'Fan', 'Hen', 'Gaer', 'Mor', 'Nel'],
        ['', '', '', '', 'a', 'e', 'i', 'o', 'ad', 'or', 'en', 'il', 'ar', 'eb', 'on'],
        ['las', 'dir', 'dor', 'ion', 'ael', 'orn', 'ond', 'dril', 'on', 'ros', 'dan', 'dhel', 'thor', 'rim', 'fin', 'mir', 'ndil', 'rond', 'thir', 'ras', 'rion', 'duin', 'rin', 'gil', 'lad', 'har', 'ur', 'ran', 'we', 'nor', 'dorn', 'vain', 'hael', 'ost'],
      ],
      namesF: [
        ['Gal', 'Cel', 'Ar', 'Nim', 'Ith', 'Mith', 'Ael', 'Ear', 'Luth', 'Nien', 'Sil', 'Tin', 'Idr', 'Fin', 'Lal', 'Gwen', 'Mel', 'Nel', 'Nar', 'Ost', 'El', 'Ind', 'Mir', 'Lin', 'Aer', 'Bel', 'Dae', 'Eir', 'Gil', 'Hir', 'Lor', 'Mael', 'Ner', 'Rin', 'Sael', 'Tath', 'Thal', 'Uin', 'Vor', 'Edh', 'Mor', 'Nith', 'Aeg', 'Cal'],
        ['', '', '', '', 'a', 'e', 'i', 'o', 'ad', 'or', 'en', 'il', 'ar', 'eb', 'em'],
        ['iel', 'wen', 'eth', 'ril', 'dis', 'ien', 'ith', 'ian', 'riel', 'lith', 'neth', 'reth', 'wing', 'gwen', 'uil', 'iant', 'loth', 'laith', 'ariel', 'oriel', 'ethel', 'is', 'os', 'ael', 'ien', 'wen', 'iel'],
      ],
      exemplarsM: ['Legolin', 'Galdor', 'Thandir', 'Elrohir', 'Glorendil', 'Halmir', 'Celebros', 'Amdir', 'Belegorn', 'Cirion', 'Daeron', 'Egalmoth', 'Finduilas', 'Gilrond', 'Hirgon', 'Maelros', 'Nimrodel', 'Orophin', 'Saelon', 'Tathar'],
      exemplarsF: ['Galadwen', 'Celebrian', 'Arwen', 'Nimloth', 'Ithilwen', 'Mithrellas', 'Aelinel', 'Eariel', 'Luthien', 'Nienor', 'Silmariel', 'Tinuviel', 'Idril', 'Findis', 'Lalaith', 'Gwenniel', 'Meleth', 'Nellas', 'Narwen', 'Ostoriel'],
      surnames: [],
    },
    {
      id: 'dwarf', name: 'Dwarf', plural: 'Dwarves',
      desc: 'The Dwarves of the Blue Mountains are Durin\'s folk, hewers of stone and masters of forge and anvil, whose halls under Ered Luin ring with hammer-song from dawn to dusk. They are a secret and stubborn people, slow to friendship and slower to forgive, but no ally is more loyal once their word is given. Their armour is the finest wrought by mortal hands and their axes remember the goblin-wars of old, when the Dwarves marched to Azanulbizar and paid a terrible price for vengeance. A Dwarf who leaves the mountain for the wide world does so with an eye for treasure, a nose for good ale, and a grudge or two to settle.',
      homeZone: 'eredluin', startTown: 'thorinshall', startPos: { x: -1290, z: -1090 },
      statBonus: { might: 8, agility: -6, vitality: 8, will: -4, fate: 0 },
      height: 0.85, build: 'stocky',
      skinTones: [0xf0cfb0, 0xe2b48e, 0xcf9a6f, 0xb98257, 0x9a6a45],
      hairColors: [0x1c120b, 0x4d2a12, 0x8a3d19, 0xc2601f, 0xd2a44a, 0x8e8e8e, 0xf0eadb],
      hairStyles: 5,
      racialTrait: {
        name: 'Stone-hardy',
        desc: 'Dwarves are made of sterner stuff than other folk. Increases Armour and Block rating, and Dwarves are harder to knock about.',
        stats: { armour: 20, block: 20 }, perLevel: { armour: 2.5, block: 3 }, pct: {}, special: { knockbackResist: 0.5 },
      },
      namesM: [
        ['Thor', 'Dwal', 'Bal', 'Kil', 'Fil', 'Glo', 'Dor', 'Nor', 'Bif', 'Bof', 'Bomb', 'Dain', 'Nain', 'Thra', 'Gim', 'Far', 'Frer', 'Frar', 'Lon', 'Nar', 'Grim', 'Hal', 'Bru', 'Skar', 'Vig', 'Hrol', 'Sig', 'Ulf', 'Bran', 'Thur', 'Dur', 'Ag', 'Hak', 'Sten', 'Orv', 'Brok', 'Rag', 'Ket', 'Aud', 'Bjar', 'Har', 'Kol', 'Mog', 'Snor', 'Tof', 'Vest', 'Yng', 'Thrain', 'Gror', 'Flo', 'Ori', 'Lofn', 'Bal', 'Dvar', 'Ein'],
        ['', '', '', '', '', 'a', 'i', 'o', 'ar', 'or', 'ul', 'un'],
        ['in', 'ur', 'or', 'li', 'ri', 'ain', 'mir', 'grim', 'ar', 'mund', 'vald', 'bur', 'din', 'ni', 'bek', 'ulf', 'mar', 'rak', 'nor', 'fur', 'vi', 'gar', 'sten', 'brand', 'thor', 'kel', 'di', 'ir', 'un', 'rin', 'bor', 'dur', 'lin'],
      ],
      namesF: [
        ['Dis', 'Hild', 'Brun', 'Gud', 'Sig', 'Rag', 'Alf', 'Thor', 'Frid', 'Hel', 'Ing', 'Sol', 'Ast', 'Ber', 'Dag', 'Ey', 'Ger', 'Hul', 'Jor', 'Kat', 'Odd', 'Sign', 'Thyr', 'Vig', 'Yl', 'Bor', 'Eir', 'Gun', 'Hall', 'Lif', 'Nal', 'Tor', 'Vals', 'Hrafn', 'Aud', 'Bryn', 'Grim', 'Kar', 'Mal', 'Ran'],
        ['', '', '', '', 'a', 'i', 'ar', 'hild', 'un'],
        ['a', 'dis', 'hild', 'run', 'rid', 'ny', 'veig', 'unn', 'la', 'ra', 'da', 'gard', 'borg', 'laug', 'vor', 'id', 'ild', 'frid', 'gerd', 'a', 'is', 'va', 'lin'],
      ],
      exemplarsM: ['Thorvald', 'Dwalgrim', 'Balmund', 'Kilbur', 'Glorin', 'Norbek', 'Bofrar', 'Dainar', 'Nainor', 'Gimrak', 'Farin', 'Frerin', 'Lonvi', 'Narvi', 'Grimbrand', 'Halkel', 'Brunulf', 'Skardin', 'Vigmar', 'Hrolgar'],
      exemplarsF: ['Disa', 'Hildrun', 'Brunhild', 'Gudrun', 'Sigrid', 'Ragna', 'Alfhild', 'Thora', 'Frida', 'Helga', 'Ingrid', 'Solveig', 'Asta', 'Bera', 'Dagny', 'Eydis', 'Gerda', 'Hulda', 'Jorunn', 'Katla'],
      surnames: [],
    },
    {
      id: 'hobbit', name: 'Hobbit', plural: 'Hobbits',
      desc: 'Hobbits are a small and unobtrusive people who love peace and quiet and good tilled earth, and who have lived in the Shire so long that they have half forgotten the world outside it. They are quick of hearing and sharp-eyed, and can disappear swiftly and silently when large folk they do not wish to meet come blundering by. Most hobbits hold that adventures are nasty, disturbing, uncomfortable things that make you late for dinner, yet there is a seed of courage hidden in even the fattest and most timid of them. When the Shadow reaches at last into the Shire, it is the halflings who are the hardest to daunt or to kill.',
      homeZone: 'shire', startTown: 'hobbiton', startPos: { x: -1040, z: -120 },
      statBonus: { might: -6, agility: 6, vitality: 6, will: 0, fate: 4 },
      height: 0.75, build: 'normal',
      skinTones: [0xf3d6b8, 0xeac09b, 0xdba97f, 0xc89466, 0xa97a52],
      hairColors: [0x3a2415, 0x5c3a1e, 0x8a5a2e, 0xb8843f, 0xd9b26b, 0x8c8c8c],
      hairStyles: 5,
      racialTrait: {
        name: 'Hobbit-stealth',
        desc: 'Hobbits can vanish when they wish, and their contentment mends them quickly. Monsters notice you from a shorter distance, and Morale recovers faster out of combat.',
        stats: { evade: 10 }, perLevel: { evade: 1 }, pct: { moraleRegen: 30 }, special: { stealth: 0.25 },
      },
      namesM: [
        ['Bil', 'Fro', 'Mer', 'Per', 'Fal', 'Fol', 'Dro', 'Bun', 'Bal', 'Mun', 'Lar', 'Lon', 'Pol', 'Pos', 'Pon', 'Rol', 'Mil', 'Min', 'Mos', 'Ham', 'Hal', 'Hob', 'Hol', 'Tol', 'And', 'Wil', 'Fil', 'Fer', 'Isen', 'Hild', 'Adal', 'Reg', 'Ever', 'Pal', 'Sar', 'Mar', 'Ser', 'Dod', 'Ilb', 'Tob', 'Rud', 'Sig', 'Fas', 'Ban', 'Gor', 'Hug', 'Ot', 'Lot', 'Bod', 'Nob', 'Rob', 'Wist', 'Fred'],
        ['', '', '', '', '', 'i', 'o', 'a', 'di', 'li'],
        ['bo', 'do', 'go', 'co', 'fo', 'mo', 'ro', 'wise', 'fast', 'fred', 'man', 'son', 'ric', 'bert', 'grim', 'ard', 'adoc', 'egrin', 'imac', 'edic', 'eric', 'old', 'bard', 'bras', 'olph', 'ibald', 'igar', 'ismond', 'ias', 'win', 'inard', 'ho', 'to', 'mund', 'ibert'],
      ],
      namesF: [
        ['Bel', 'Prim', 'Ros', 'Lob', 'Pim', 'Per', 'Esme', 'Egl', 'Dai', 'Mari', 'Lil', 'Pop', 'Rub', 'Amar', 'Asph', 'Cam', 'Cel', 'Dia', 'Donna', 'Dor', 'Est', 'Gil', 'Han', 'Hil', 'Lal', 'Laur', 'Lin', 'Mel', 'Men', 'Mim', 'Mira', 'Myr', 'Peo', 'Pris', 'Row', 'Sal', 'Tan', 'Ang', 'Pearl', 'May', 'Pet', 'Ivy', 'Bry', 'Cor', 'Tul', 'Prim', 'Lav'],
        ['', '', '', '', 'a', 'i', 'e', 'la', 'li', 'ra'],
        ['a', 'ia', 'ella', 'ina', 'ilda', 'y', 'ie', 'wyn', 'inca', 'ula', 'anna', 'lot', 'bella', 'ony', 'osa', 'dora', 'ily', 'erly', 'odel', 'antha', 'ilot', 'na', 'sa', 'ma', 'sy', 'dy', 'andine', 'tle', 'rose', 'belle', 'vender'],
      ],
      exemplarsM: ['Tobold', 'Andwise', 'Hamson', 'Halfast', 'Fastolph', 'Marroc', 'Wilibald', 'Rudigar', 'Hildibrand', 'Sigismond', 'Bandobras', 'Ferumbras', 'Isengrim', 'Adalgrim', 'Reginard', 'Everard', 'Gorbadoc', 'Dodinas', 'Ilberic', 'Falco', 'Ponto', 'Hobson', 'Wiseman', 'Tolman'],
      exemplarsF: ['Belladonna', 'Primula', 'Rosamunda', 'Lobelia', 'Pimpernel', 'Pervinca', 'Esmeralda', 'Eglantine', 'Daisy', 'Marigold', 'Lily', 'Poppy', 'Ruby', 'Amaranth', 'Asphodel', 'Camellia', 'Celandine', 'Diamond', 'Donnamira', 'Estella', 'Gilly', 'Hilda', 'Melilot', 'Mentha', 'Mimosa', 'Myrtle', 'Peony', 'Salvia'],
      surnames: ['Took', 'Brandybuck', 'Proudfoot', 'Baggins', 'Gamgee', 'Cotton', 'Bolger', 'Boffin', 'Burrows', 'Chubb', 'Grubb', 'Hornblower', 'Goodbody', 'Bracegirdle', 'Sackville', 'Underhill', 'Brownlock', 'Greenhand', 'Twofoot', 'Sandheaver', 'Goldworthy', 'Hayward', 'Whitfoot', 'Bunce', 'Puddifoot', 'Smallburrow', 'Gardner', 'Roper', 'Headstrong', 'Mugwort', 'Banks', 'Longhole', 'Tunnelly', 'Brockhouse', 'Fairbairn', 'Maggot', 'Noakes', 'Rumble', 'Diggle', 'Goold', 'Lightfoot', 'Hedgeworth', 'Bramblebury', 'Pennyworth', 'Applewhite', 'Thistlefoot', 'Mossburrow', 'Bywater'],
    },
    {
      id: 'highelf', name: 'High Elf', plural: 'High Elves',
      desc: 'The High Elves are those Eldar who once beheld the light of the Two Trees in Valinor, or their children, and something of that light lingers still in their eyes. They returned to Middle-earth in the Elder Days to make war upon Morgoth, and though the Wars of Beleriand ended in ruin, they have never laid down the fight against his servant. Proud, learned and terrible in wrath, they wield the arts of the Noldor that shaped the Rings of Power and the swords that still gleam blue at the coming of orcs. Few of them now remain east of the Sea, and each one who takes the field is worth a company of lesser warriors.',
      homeZone: 'eredluin', startTown: 'celondim', startPos: { x: -1410, z: -690 },
      statBonus: { might: -2, agility: 6, vitality: -4, will: 10, fate: 2 },
      height: 1.07, build: 'slim',
      skinTones: [0xf8ebdc, 0xf3dfcb, 0xecd1b7, 0xdfc0a0],
      hairColors: [0x14100c, 0x2c2018, 0xe9dcae, 0xf5f0da, 0x8b5a2b, 0xc0c0d0, 0xa63d1e],
      hairStyles: 5,
      racialTrait: {
        name: 'Light of Aman',
        desc: 'The memory of the Blessed Realm burns in the High Elf. Increases Tactical Mastery and Will, and light-based damage you deal is strengthened.',
        stats: { tactMastery: 25, will: 4 }, perLevel: { tactMastery: 3, will: 0.3 }, pct: {}, special: { lightDamageMult: 1.1 },
      },
      namesM: [
        ['Fin', 'Glor', 'Fea', 'Mae', 'Mag', 'Cel', 'Car', 'Cur', 'Am', 'Tur', 'Ec', 'Ele', 'Eg', 'Gal', 'Duil', 'Pen', 'Ing', 'Vor', 'Aeg', 'Ang', 'Orod', 'Gil', 'Ell', 'Elr', 'Er', 'Lin', 'Ar', 'Ea', 'Cal', 'Tin', 'Val', 'Sil', 'Ist', 'Nol', 'Mah', 'Aul', 'Oss', 'Sal', 'Rum', 'Tel', 'Lom', 'Nar', 'Elem', 'Fal', 'Hal'],
        ['', '', '', '', 'a', 'e', 'i', 'o', 'ar', 'en', 'il', 'or', 'an', 'em'],
        ['rod', 'findel', 'nor', 'golfin', 'arfin', 'dhros', 'lor', 'gorm', 'thir', 'fin', 'ras', 'gon', 'thelion', 'makil', 'moth', 'dor', 'lin', 'lod', 'wion', 'il', 'we', 'dan', 'hir', 'estor', 'dir', 'tar', 'mo', 'rion', 'nar', 'quar', 'mar', 'ion', 'las', 'ndil'],
      ],
      namesF: [
        ['Gal', 'Ar', 'Idr', 'Ele', 'Ana', 'Ear', 'Am', 'Ner', 'Mir', 'Ind', 'Find', 'Ir', 'Elem', 'Cel', 'Lal', 'Nim', 'Sil', 'Tin', 'Val', 'Var', 'Est', 'Nes', 'Vai', 'Yav', 'Ilm', 'Nien', 'Tar', 'Alm', 'Cal', 'Fan', 'Ist', 'Lin', 'Mel', 'Ol', 'Ser', 'Tel', 'Ul', 'Wil', 'Aeg', 'Eir'],
        ['', '', '', '', 'a', 'e', 'i', 'ar', 'en', 'il', 'em', 'an'],
        ['adriel', 'edhel', 'ril', 'enwe', 'aire', 'wen', 'arie', 'danel', 'iel', 'dis', 'ime', 'brian', 'loth', 'ien', 'inde', 'is', 'ire', 'mire', 'na', 'wende', 'anna', 'iel', 'wen', 'ie', 'lime', 'rian', 'diel'],
      ],
      exemplarsM: ['Findarato', 'Glorindir', 'Feanaro', 'Maedhil', 'Maglorion', 'Celegil', 'Carandir', 'Curumo', 'Amrothion', 'Turgonil', 'Ecthelas', 'Elemmir', 'Egalion', 'Galdorion', 'Duilinor', 'Penlodir', 'Ingwion', 'Voronwe', 'Aegnorion', 'Angrodil'],
      exemplarsF: ['Galadhriel', 'Aredhil', 'Idrilwen', 'Elenwe', 'Anaire', 'Earwen', 'Amarie', 'Nerdanel', 'Miriel', 'Indis', 'Findis', 'Irime', 'Elemmire', 'Celebrindal', 'Lalwende', 'Nimrodel', 'Silmarien', 'Tindomiel', 'Vanimelde', 'Varda'],
      surnames: [],
    },
    {
      id: 'beorning', name: 'Beorning', plural: 'Beornings',
      desc: 'The Beornings are the kin of Beorn the skin-changer, a tall and grim-faced folk who dwell between the Misty Mountains and Mirkwood, keeping the High Pass and the Ford of Carrock open at a toll. They are great lovers of honey and of beasts, and keep neither slave nor bondsman, but they are no friends to orcs and wargs, and hunt them with an ancient hatred. In moments of great need a Beorning may call upon the bear-blood that runs in the family, taking on the shape and fury of a great bear. Some of the younger folk have wandered west across the mountains, seeking word of the growing darkness, and their strength is a welcome gift to Eriador.',
      homeZone: 'breeland', startTown: 'archet', startPos: { x: -60, z: -250 },
      statBonus: { might: 6, agility: -2, vitality: 10, will: -4, fate: 0 },
      height: 1.1, build: 'stocky',
      skinTones: [0xedcfb0, 0xdfb890, 0xcc9d72, 0xb8865b],
      hairColors: [0x1a1208, 0x3d2a17, 0x6b4324, 0x9e6b33, 0xcaa055, 0x6e6e6e],
      hairStyles: 5,
      racialTrait: {
        name: 'Bear-blood',
        desc: 'The blood of Beorn runs hot in your veins. Increases Vitality, and every kill you make restores a portion of your maximum Morale.',
        stats: { vitality: 10 }, perLevel: { vitality: 0.5 }, pct: {}, special: { healOnKillPct: 4 },
      },
      namesM: [
        ['Beorn', 'Grim', 'Ulf', 'Bern', 'Bjor', 'Hrod', 'Wulf', 'Thur', 'Art', 'Ing', 'Ask', 'Hal', 'Gunn', 'Sig', 'Bran', 'Thor', 'Hun', 'Eg', 'Rag', 'Sten', 'Ake', 'Bard', 'Vidar', 'Hild', 'Ead', 'Os', 'Aethel', 'Beorht', 'Cyne', 'Leod', 'Wig', 'Ath', 'Har', 'Frod', 'Grym'],
        ['', '', '', '', 'a', 'i', 'o', 'e', 'ar', 'ul', 'en'],
        ['wald', 'beorn', 'ric', 'ulf', 'mund', 'gar', 'bjorn', 'stan', 'mar', 'vald', 'hard', 'old', 'bald', 'grim', 'ir', 'brand', 'ketil', 'fast', 'helm', 'red', 'bert', 'noth', 'weard', 'win', 'bern', 'ar'],
      ],
      namesF: [
        ['Ber', 'Grim', 'Ulf', 'Hild', 'Sig', 'Ing', 'Ask', 'Gunn', 'Thor', 'Rag', 'Hal', 'Ast', 'Eir', 'Frey', 'Ger', 'Sol', 'Tor', 'Yng', 'Aethel', 'Ead', 'Wyn', 'Bryn', 'Sae', 'Leof', 'Hun', 'Ald', 'Ida', 'Mild', 'Oda', 'Vig'],
        ['', '', '', '', 'a', 'i', 'e', 'ar', 'el', 'un'],
        ['a', 'hild', 'run', 'dis', 'gerd', 'ny', 'vor', 'wyn', 'laug', 'veig', 'unn', 'id', 'borg', 'gifu', 'swith', 'burg', 'lind', 'ith', 'a', 'ina'],
      ],
      exemplarsM: ['Grimbeorn', 'Beornwald', 'Ulfgar', 'Bjornulf', 'Hrodgar', 'Wulfstan', 'Thurbrand', 'Arthulf', 'Ingmar', 'Askhard', 'Halbjorn', 'Gunnvald', 'Sigmund', 'Branulf', 'Thorgrim', 'Hunwald', 'Egbert', 'Ragnbald', 'Stenketil', 'Akebrand'],
      exemplarsF: ['Bera', 'Grimhild', 'Ulfrun', 'Hildegerd', 'Signy', 'Ingunn', 'Asklaug', 'Gunnvor', 'Thora', 'Ragndis', 'Halveig', 'Asta', 'Eira', 'Freydis', 'Gerda', 'Solvor', 'Torhild', 'Yngvild', 'Aethelburg', 'Eadgifu'],
      surnames: [],
    },
    {
      id: 'stoutaxe', name: 'Stout-axe Dwarf', plural: 'Stout-axes',
      desc: 'The Stout-axes are a lost house of the Dwarves, descended from those who long ago went east into the lands beneath the Shadow and were there enslaved by Sauron\'s servants. Generations of hard labour under cruel masters bred a people of iron endurance and sullen, unbreakable pride, whose axes fall heavier for every year of bondage remembered. In recent times a band of them has broken free and fled west across the mountains, seeking the kinship of Durin\'s folk and a chance to strike back at the Enemy. Grim in speech and suspicious of soft-handed strangers, a Stout-axe measures every companion by one question only: will you stand beside me when the orcs come?',
      homeZone: 'eredluin', startTown: 'thorinshall', startPos: { x: -1290, z: -1090 },
      statBonus: { might: 10, agility: -4, vitality: 6, will: -4, fate: 0 },
      height: 0.87, build: 'stocky',
      skinTones: [0xe6c3a0, 0xd2a77e, 0xba8a5f, 0x9c6f48, 0x7d5636],
      hairColors: [0x120d08, 0x2e1d10, 0x5a3418, 0x8c4e1c, 0x6f6f6f, 0xe8e0cf],
      hairStyles: 5,
      racialTrait: {
        name: 'Stout-axe Ferocity',
        desc: 'Every blow of a Stout-axe carries the weight of a hundred years of chains. Increases Physical Mastery and Might.',
        stats: { physMastery: 30, might: 4 }, perLevel: { physMastery: 3, might: 0.3 }, pct: {}, special: {},
      },
      namesM: [
        ['Kaz', 'Thraz', 'Bur', 'Nar', 'Vor', 'Zur', 'Khar', 'Dol', 'Gaz', 'Mor', 'Har', 'Ruz', 'Skar', 'Tar', 'Var', 'Zan', 'Bal', 'Kro', 'Drun', 'Gor', 'Thok', 'Baz', 'Mek', 'Ruk', 'Tor', 'Ur', 'Zar', 'Hak', 'Nur', 'Dar', 'Kul', 'Gar', 'Brak', 'Vul', 'Tuz'],
        ['', '', '', '', 'a', 'u', 'o', 'ar', 'un', 'ol', 'az'],
        ['ak', 'ur', 'in', 'im', 'uk', 'ad', 'ok', 'ar', 'din', 'ul', 'og', 'ir', 'gar', 'mund', 'rok', 'thak', 'bur', 'kar', 'zad', 'nak', 'dum', 'ash', 'ruk', 'tar'],
      ],
      namesF: [
        ['Kaz', 'Thraz', 'Bur', 'Nar', 'Vor', 'Zur', 'Khar', 'Dol', 'Gaz', 'Mor', 'Har', 'Ruz', 'Tar', 'Var', 'Zan', 'Bal', 'Kir', 'Dun', 'Gil', 'Thal', 'Baz', 'Mir', 'Ruk', 'Tor', 'Ur', 'Zar', 'Hal', 'Nur', 'Dar', 'Kul'],
        ['', '', '', 'a', 'i', 'u', 'ar', 'un', 'il'],
        ['a', 'i', 'ia', 'un', 'is', 'ra', 'ka', 'na', 'da', 'ith', 'ika', 'ula', 'ina', 'ash', 'ia', 'ra'],
      ],
      exemplarsM: ['Kazrak', 'Thrazur', 'Burin', 'Narthak', 'Vorgar', 'Zurmund', 'Kharak', 'Dolbur', 'Gazrok', 'Morduk', 'Harzad', 'Ruzokar', 'Skardin', 'Tarnak', 'Varok', 'Zandum', 'Balkar', 'Kroash', 'Drunak', 'Gortar'],
      exemplarsF: ['Kazra', 'Thrazia', 'Burika', 'Nardis', 'Vorina', 'Zurka', 'Kharina', 'Dolith', 'Gazula', 'Morna', 'Harika', 'Ruzia', 'Tarna', 'Varis', 'Zanra', 'Balda', 'Kirash', 'Dunia', 'Gilka', 'Thalis'],
      surnames: [],
    },
    {
      id: 'riverhobbit', name: 'River Hobbit', plural: 'River Hobbits',
      desc: 'The River Hobbits are the Stoor-folk of the Marish and the Brandywine banks, broader and heavier than their cousins of the hills, with a fondness for boats, swimming and the eels of the reed-beds that other hobbits find quite shocking. They have webbed the river with weirs and jetties and know every fish that swims it by name, and it is said that their luck at the water\'s edge is not entirely natural. Long ago a branch of their kin dwelt by the Gladden Fields under the Misty Mountains, and some River-folk still tell strange tales of a thing that was found in the mud there. Cheerful, practical and surprisingly nimble for their girth, they make excellent scouts, anglers and, if pressed, thieves.',
      homeZone: 'shire', startTown: 'hobbiton', startPos: { x: -1040, z: -120 },
      statBonus: { might: -6, agility: 8, vitality: 4, will: 2, fate: 4 },
      height: 0.76, build: 'stocky',
      skinTones: [0xf0d0b0, 0xe2b48e, 0xd09c74, 0xbb8560],
      hairColors: [0x2a1a10, 0x4a3018, 0x6f4a24, 0x9a6a30, 0xc59a4e],
      hairStyles: 5,
      racialTrait: {
        name: 'River-folk Luck',
        desc: 'The Stoors have fished the Brandywine for a thousand years. Increases Agility, and rare catches are far more common on your line.',
        stats: { agility: 6 }, perLevel: { agility: 0.4 }, pct: {}, special: { fishingLuck: 0.25, swimSpeedMult: 1.25 },
      },
      namesM: [
        ['Sme', 'Dea', 'Rus', 'Mud', 'Gol', 'Reed', 'Fen', 'Wat', 'Sedge', 'Osk', 'Wyn', 'Bul', 'Nod', 'Tar', 'Peb', 'Bram', 'Marl', 'Wil', 'Tuck', 'Hob', 'Pud', 'Eel', 'Carl', 'Farm', 'Bob', 'Tod', 'Grib', 'Otter', 'Pike', 'Dab', 'Fisk', 'Halb', 'Mag'],
        ['', '', '', '', 'a', 'o', 'i', 'e', 'de', 'di'],
        ['agol', 'gol', 'ric', 'bo', 'do', 'kin', 'wise', 'fast', 'man', 'bert', 'bin', 'go', 'wick', 'fer', 'ton', 'wold', 'sey', 'dock', 'ley', 'sen'],
      ],
      namesF: [
        ['Sme', 'Dea', 'Rus', 'Reed', 'Fen', 'Sedge', 'Wyn', 'Peb', 'Bram', 'Wil', 'Marl', 'Pud', 'Lil', 'Ros', 'Nel', 'Bel', 'Mag', 'Tans', 'Cress', 'Minn', 'Dab', 'Ott', 'Mist', 'Bry', 'Fern', 'Mor', 'Sal', 'Tam'],
        ['', '', '', 'a', 'i', 'e', 'la', 'li'],
        ['a', 'y', 'ie', 'ella', 'ina', 'bell', 'wyn', 'ony', 'sy', 'ette', 'na', 'ia', 'ily', 'ora', 'dine', 'lot', 'da'],
      ],
      exemplarsM: ['Smeador', 'Deagolf', 'Rusbin', 'Mudwick', 'Golfer', 'Reedman', 'Fenwick', 'Watkin', 'Sedgeley', 'Oskar', 'Wynbert', 'Bulwise', 'Nodbo', 'Tarkin', 'Pebble', 'Bramton', 'Marlfast', 'Tuckwold', 'Puddock', 'Eelsey'],
      exemplarsF: ['Smeabell', 'Deawyn', 'Rusella', 'Reedina', 'Fenny', 'Sedgelot', 'Wynora', 'Pebbly', 'Bramble', 'Willa', 'Marlina', 'Puddy', 'Lily', 'Rosedine', 'Nella', 'Belia', 'Maggy', 'Tansy', 'Cressida', 'Minnow'],
      surnames: ['Maggot', 'Puddifoot', 'Banks', 'Rushbottom', 'Sedgewick', 'Reedman', 'Marishfoot', 'Fenwick', 'Mudbrook', 'Otterburn', 'Willowmere', 'Eelbarrow', 'Bulrush', 'Riddlecombe', 'Deepwater', 'Goldbank', 'Brackwater', 'Sandheaver', 'Duckwood', 'Weirwater', 'Pikestaff', 'Netmender', 'Shallowford', 'Osierbank', 'Mistybottom', 'Fishbourne', 'Waterlily'],
    },
    {
      id: 'dunedain', name: 'Dúnadan', plural: 'Dúnedain',
      desc: 'The Dúnedain of the North are the last remnant of the kingdom of Arnor, heirs of Elendil who came out of the drowning of Númenor with the Seven Stars and the White Tree. When Angmar broke Arthedain they did not perish but became the Rangers, grey-cloaked wanderers who guard the Shire and Bree-land unthanked, hunting orcs in the wild and keeping the old roads safe for folk who call them vagabonds. Longer-lived than other Men, taller and keener-eyed, they carry the wisdom of the West in their blood and the sorrow of a fallen realm in their hearts. Their Chieftain walks unnamed among them, and every Ranger holds themselves ready for the day the King returns.',
      homeZone: 'breeland', startTown: 'archet', startPos: { x: -60, z: -250 },
      statBonus: { might: 3, agility: 3, vitality: 3, will: 3, fate: 6 },
      height: 1.04, build: 'normal',
      skinTones: [0xf2dcc4, 0xe8c9ab, 0xd8b08f, 0xc09571],
      hairColors: [0x15100c, 0x2e211a, 0x4a3628, 0x6c4c33, 0x9c9c9c, 0xdcd6c8],
      hairStyles: 5,
      racialTrait: {
        name: 'Blood of Númenor',
        desc: 'The West lives on in the Dúnedain. Increases Fate and, slightly, every other stat; the strength of Númenor grows with your experience.',
        stats: { fate: 6, might: 2, agility: 2, vitality: 2, will: 2 }, perLevel: { fate: 0.4, might: 0.15, agility: 0.15, vitality: 0.15, will: 0.15 }, pct: {}, special: {},
      },
      namesM: [
        ['Ar', 'Ara', 'Hal', 'El', 'Isil', 'Val', 'Eld', 'Tar', 'Aml', 'Bel', 'Mal', 'Cel', 'Arg', 'Arv', 'Cand', 'Saer', 'Rad', 'Cal', 'Am', 'Tor', 'Cor', 'Gil', 'Nar', 'Ost', 'Edh', 'Hir', 'Lang', 'Men', 'Ang', 'Bar', 'Dir', 'For', 'Gol', 'Ith', 'Len', 'Mor', 'Orn', 'Pel', 'Ran', 'Thar', 'Ven', 'Dun'],
        ['', '', '', '', 'a', 'e', 'i', 'o', 'an', 'en', 'ar', 'el', 'or'],
        ['gorn', 'barad', 'thorn', 'dor', 'nui', 'suil', 'had', 'vir', 'narth', 'dui', 'dil', 'dur', 'car', 'tar', 'cil', 'don', 'mir', 'laith', 'eg', 'lor', 'pharn', 'leb', 'phor', 'phant', 'aith', 'adan', 'nir', 'glad', 'linn', 'thir', 'gil', 'dain', 'ion', 'rod'],
      ],
      namesF: [
        ['Gil', 'Ivor', 'Fir', 'El', 'Silm', 'Tind', 'Anc', 'Van', 'Alm', 'Nim', 'Ar', 'Mor', 'Cel', 'Ith', 'Lin', 'Mel', 'Nar', 'Ost', 'Bel', 'Dir', 'Ear', 'Hal', 'Idh', 'Lor', 'Mir', 'Nien', 'Ril', 'Sael', 'Tar', 'Vor', 'Aer', 'Cal', 'Edh', 'Ind'],
        ['', '', '', '', 'a', 'e', 'i', 'an', 'en', 'ar', 'el', 'em'],
        ['raen', 'wen', 'iel', 'ien', 'mien', 'miel', 'ime', 'elde', 'ian', 'eth', 'ril', 'wing', 'indis', 'loth', 'dis', 'neth', 'ariel', 'is', 'wen', 'iel', 'reth', 'ith'],
      ],
      exemplarsM: ['Halbarad', 'Arathorn', 'Arador', 'Argonui', 'Aravir', 'Aranarth', 'Elendur', 'Valandil', 'Eldacar', 'Tarcil', 'Amlaith', 'Beleg', 'Mallor', 'Celepharn', 'Argeleb', 'Arveleg', 'Candaith', 'Saeradan', 'Radanir', 'Calenglad', 'Lenglinn', 'Torthann', 'Corunir', 'Golodir'],
      exemplarsF: ['Gilraen', 'Ivorwen', 'Firiel', 'Elwen', 'Silmarien', 'Tindomiel', 'Ancalime', 'Vanimelde', 'Almarian', 'Nimloth', 'Arwen', 'Morwen', 'Celebrindis', 'Ithilwen', 'Lindis', 'Meldis', 'Narwen', 'Ostoriel', 'Belwen', 'Diriel'],
      surnames: [],
    },
    {
      id: 'rohirrim', name: 'Rohirrim', plural: 'Rohirrim',
      desc: 'The Rohirrim are the Horse-lords of the Mark, a proud and golden-haired people who came down out of the North in the days of Eorl the Young and were given the green plains of Calenardhon for their aid to Gondor. They live for the horse and the open sky, and a rider of Rohan on his steed is the swiftest and deadliest thing on the plains of the West, with spear and sword and the great war-horns of the Riddermark. Their halls are of timber hung with tapestries of their kings, and their songs are long and sad and stirring, full of the wind in the grass and the thunder of hooves. A few have ridden north on errands of the King, and find Eriador strange and cramped, but its enemies familiar enough.',
      homeZone: 'breeland', startTown: 'archet', startPos: { x: -60, z: -250 },
      statBonus: { might: 6, agility: 8, vitality: 2, will: -4, fate: 0 },
      height: 1.02, build: 'normal',
      skinTones: [0xf3dcc2, 0xe9c8a5, 0xd9b08a, 0xc4976d],
      hairColors: [0xf2e2a0, 0xe4c46a, 0xd1a94a, 0xb8863a, 0x8a5c2c, 0x5a3a1e, 0xd9d3c4],
      hairStyles: 5,
      racialTrait: {
        name: 'Rider of the Mark',
        desc: 'Born in the saddle. Your mounts run faster, and the Riddermark breeds quick hands and quicker reflexes. Increases Agility and Evade rating.',
        stats: { agility: 6, evade: 10 }, perLevel: { agility: 0.4, evade: 1 }, pct: {}, special: { mountSpeedMult: 1.1 },
      },
      namesM: [
        ['Eo', 'Theo', 'Ha', 'Gam', 'Erk', 'Grim', 'Elf', 'Dun', 'Deor', 'Here', 'Heru', 'Fast', 'Guth', 'Hard', 'Wal', 'Fol', 'Fen', 'Bryt', 'Ald', 'Frea', 'Gold', 'Gram', 'Helm', 'Leof', 'Then', 'Wid', 'Ceor', 'Ead', 'Wulf', 'Sig', 'Os', 'Cyne', 'Beorht', 'Aethel', 'Ecg', 'Frith', 'Wig', 'Hun', 'Ord', 'Sae', 'Hroth', 'Ead', 'God', 'Beorn', 'Aelf'],
        ['', '', '', '', '', 'a', 'e', 'o', 'el', 'er', 'en'],
        ['mer', 'den', 'mund', 'ma', 'ling', 'brand', 'bold', 'helm', 'here', 'wine', 'fara', 'red', 'laf', 'ing', 'da', 'ca', 'gel', 'ta', 'dor', 'wald', 'ric', 'stan', 'noth', 'weard', 'frith', 'gar', 'wulf', 'heah', 'hild', 'sig', 'wig', 'thain', 'bald', 'nard', 'lac'],
      ],
      namesF: [
        ['Eo', 'Theod', 'Elf', 'Hild', 'Ald', 'Cyne', 'Ead', 'Frith', 'God', 'Here', 'Leof', 'Wyn', 'Aethel', 'Os', 'Wulf', 'Sae', 'Ethel', 'Mild', 'Bur', 'Ceol', 'Eal', 'Aelf', 'Ead', 'Gyth', 'Wil', 'Sig', 'Ecg', 'Hroth', 'Beorht', 'Eor'],
        ['', '', '', '', 'a', 'e', 'el', 'en', 'ar'],
        ['wyn', 'hild', 'gifu', 'swith', 'run', 'flaed', 'gyth', 'burg', 'thryth', 'wen', 'frith', 'ith', 'leofu', 'wynn', 'gard', 'lind', 'wara', 'hild', 'wyn'],
      ],
      exemplarsM: ['Eomund', 'Theodred', 'Hama', 'Gamling', 'Erkenbrand', 'Grimbold', 'Elfhelm', 'Dunhere', 'Deorwine', 'Herefara', 'Herubrand', 'Fastred', 'Guthlaf', 'Harding', 'Walda', 'Folca', 'Fengel', 'Brytta', 'Aldor', 'Freawine', 'Goldwine', 'Gram', 'Frealaf', 'Leofa', 'Thengel', 'Widfara', 'Ceorl', 'Eothain', 'Elfwine'],
      exemplarsF: ['Eowyn', 'Theodwyn', 'Elfhild', 'Hild', 'Aldwyn', 'Cynewyn', 'Eadgyth', 'Frithswith', 'Godgifu', 'Hereswith', 'Leofrun', 'Wynflaed', 'Aethelflaed', 'Osgyth', 'Wulfrun', 'Saewyn', 'Ethelburg', 'Mildthryth', 'Burgwyn', 'Ceolwen'],
      surnames: [],
    },
  ];

  /* ------------------------------------------------------------------------------------------------
   * §4.2 CLASSES
   * ---------------------------------------------------------------------------------------------- */
  const CLASSES = [
    {
      id: 'guardian', name: 'Guardian', role: 'tank', mainStat: 'might', armourType: 'heavy',
      desc: 'The Guardian stands where the fighting is thickest, shield raised and sword drawn, so that the folk behind may live. Trained in the ancient shield-arts of Arnor, a Guardian turns aside blows that would fell lesser warriors and answers every parried strike with a punishing riposte. Foes that would rather hunt the weak find their attention seized and held by challenges no orc can ignore. It is a hard road and a thankless one, but the Guardian asks no thanks; only that the line hold.',
      weaponTypes: ['sword', 'axe', 'mace', 'dagger', 'spear', 'shield'],
      baseStats: { might: 20, agility: 12, vitality: 22, will: 10, fate: 10 },
      perLevel: { might: 4.6, agility: 2.2, vitality: 5.2, will: 1.6, fate: 1.8 },
      baseMorale: 90, moralePerLevel: 130, basePower: 60, powerPerLevel: 26,
      rangedWeapon: 'throwing', color: 0x4a7fd6, icon: '🛡',
    },
    {
      id: 'champion', name: 'Champion', role: 'dps', mainStat: 'might', armourType: 'heavy',
      desc: 'The Champion is a whirlwind of steel, a warrior who has traded the safety of the shield for a second blade and the fury to use it. Where the Guardian holds the line, the Champion breaks it, wading into a press of enemies with sweeping strokes that strike three foes at once. Fervour builds in the heat of battle until the Champion fights faster than the eye can follow, heedless of wounds, drunk on the joy of the fray. Such warriors do not grow old, but they are long remembered in song.',
      weaponTypes: ['sword', 'axe', 'mace', 'halberd', 'spear'],
      baseStats: { might: 24, agility: 16, vitality: 18, will: 8, fate: 10 },
      perLevel: { might: 5.6, agility: 3.0, vitality: 4.0, will: 1.2, fate: 2.0 },
      baseMorale: 80, moralePerLevel: 108, basePower: 60, powerPerLevel: 28,
      rangedWeapon: 'throwing', color: 0xd64a4a, icon: '⚔',
    },
    {
      id: 'captain', name: 'Captain', role: 'support', mainStat: 'might', armourType: 'heavy',
      desc: 'The Captain is a leader of the Free Peoples, a warrior whose greatest weapon is the courage of those who follow. With banner and halberd, shout and standard, a Captain rallies the faltering, heals the wounded with words of hope, and marks the enemy for a swift and terrible defeat. A herald fights at the Captain\'s side, bearing the colours of Gondor or the Mark into the thick of battle. Alone the Captain is formidable; at the head of a fellowship, unstoppable.',
      weaponTypes: ['sword', 'axe', 'mace', 'halberd', 'spear', 'shield'],
      baseStats: { might: 20, agility: 12, vitality: 20, will: 14, fate: 10 },
      perLevel: { might: 4.8, agility: 2.2, vitality: 4.4, will: 2.6, fate: 2.0 },
      baseMorale: 85, moralePerLevel: 112, basePower: 70, powerPerLevel: 32,
      rangedWeapon: 'javelin', color: 0xd6a54a, icon: '🚩',
    },
    {
      id: 'hunter', name: 'Hunter', role: 'dps', mainStat: 'agility', armourType: 'medium',
      desc: 'The Hunter is the master of the wild, a tracker and archer who can put an arrow through a warg\'s eye at a hundred paces and be gone before its pack-mates turn. Long years in the forests of Eriador have taught the Hunter every trail, every hiding place and every trick of wind and weather. Enemies who close the distance find traps at their feet and a blade in their ribs, but few ever get that close. When the fellowship must travel far and fast, it is the Hunter who knows the way.',
      weaponTypes: ['bow', 'crossbow', 'sword', 'axe', 'dagger', 'spear'],
      baseStats: { might: 14, agility: 26, vitality: 16, will: 10, fate: 10 },
      perLevel: { might: 2.6, agility: 5.8, vitality: 3.4, will: 1.6, fate: 2.2 },
      baseMorale: 70, moralePerLevel: 92, basePower: 65, powerPerLevel: 30,
      rangedWeapon: 'bow', color: 0x4ab86a, icon: '🏹',
    },
    {
      id: 'burglar', name: 'Burglar', role: 'dps', mainStat: 'agility', armourType: 'medium',
      desc: 'The Burglar is a creature of shadow and misdirection, a cutpurse turned hero who fights with tricks, riddles and a blade slipped between the ribs. Hobbits make the finest Burglars, as a certain Mr. Baggins once proved, but any quick-witted soul can learn to vanish from sight, confound an enemy with a well-timed jest, and open a foe\'s defences for the whole fellowship to exploit. A Burglar does not seek a fair fight and would consider it a failure to be caught in one. Riches, of course, are merely a happy side-effect.',
      weaponTypes: ['dagger', 'sword', 'mace', 'crossbow'],
      baseStats: { might: 14, agility: 24, vitality: 16, will: 12, fate: 12 },
      perLevel: { might: 2.8, agility: 5.6, vitality: 3.6, will: 1.8, fate: 2.4 },
      baseMorale: 70, moralePerLevel: 92, basePower: 65, powerPerLevel: 30,
      rangedWeapon: 'crossbow', color: 0x9a7ad6, icon: '🗡',
    },
    {
      id: 'minstrel', name: 'Minstrel', role: 'healer', mainStat: 'will', armourType: 'light',
      desc: 'The Minstrel is a keeper of the old songs, whose music holds a power older than any sorcery of the Enemy: the power to mend hearts and lift the spirit in the darkest hour. A ballad of the Minstrel knits wounds and steadies trembling hands; a battle-cry drives dread into the hearts of orcs and lays them low with the sheer force of hope. In the halls of the Elves such singers are honoured above warriors, for it was by song that the world was made. On the road, the fellowship that has a Minstrel walks lighter and comes home more often.',
      weaponTypes: ['sword', 'dagger', 'mace', 'instrument'],
      baseStats: { might: 8, agility: 12, vitality: 16, will: 26, fate: 14 },
      perLevel: { might: 1.2, agility: 2.0, vitality: 3.4, will: 5.8, fate: 2.6 },
      baseMorale: 65, moralePerLevel: 90, basePower: 90, powerPerLevel: 40,
      rangedWeapon: 'staff', color: 0xe2c04a, icon: '🎵',
    },
    {
      id: 'loremaster', name: 'Lore-master', role: 'support', mainStat: 'will', armourType: 'light',
      desc: 'The Lore-master has studied the deep lore of Middle-earth — the tongues of birds and beasts, the secret names of fire and storm, the weaknesses of every creature bred in the pits of the Enemy. With a staff of ancient wood and a loyal animal companion at heel, the Lore-master unravels the foe with knowledge: burning them with remembered fire, binding them with roots, and stripping away their strength with a word. Slow to anger and slower to boast, the Lore-master is nonetheless the most dangerous member of any fellowship to underestimate. Knowledge, after all, is the oldest power of all.',
      weaponTypes: ['staff', 'sword', 'dagger', 'mace'],
      baseStats: { might: 8, agility: 12, vitality: 16, will: 26, fate: 12 },
      perLevel: { might: 1.2, agility: 2.0, vitality: 3.4, will: 5.8, fate: 2.4 },
      baseMorale: 65, moralePerLevel: 86, basePower: 95, powerPerLevel: 42,
      rangedWeapon: 'staff', color: 0x4ac3d6, icon: '📖',
    },
    {
      id: 'runekeeper', name: 'Rune-keeper', role: 'dps', mainStat: 'will', armourType: 'light',
      desc: 'The Rune-keeper wields the eldest art of the Dwarves and the Elves: the carving of runes of power into stone, and the reading aloud of what is written there. Fire, lightning and the cold of the deep places answer the Rune-keeper\'s call, and the same runes that shatter a troll can be turned to knit a companion\'s wounds. It is a demanding art, for the Rune-keeper must choose in the heat of battle between the runes of ruin and the runes of restoration and cannot easily turn back. Those who master it become a storm in mortal shape.',
      weaponTypes: ['runestone', 'dagger', 'mace'],
      baseStats: { might: 6, agility: 12, vitality: 14, will: 28, fate: 14 },
      perLevel: { might: 1.0, agility: 2.0, vitality: 3.2, will: 6.0, fate: 2.6 },
      baseMorale: 60, moralePerLevel: 84, basePower: 100, powerPerLevel: 44,
      rangedWeapon: 'runestone', color: 0xd66ad6, icon: '🔮',
    },
    {
      id: 'warden', name: 'Warden', role: 'tank', mainStat: 'agility', armourType: 'medium',
      desc: 'The Warden is a guardian of the borderlands, trained in the spear-and-shield discipline of the old Dúnedain outposts of Annúminas. Where the Guardian relies on heavy plate, the Warden relies on speed, footwork and the ancient gambits: chains of spear-thrust, shield-bash and battle-cry that build into devastating combinations. A Warden can hurl a javelin to draw a foe, dance aside from its charge, and turn its own weight against it. Lightly armoured but never lightly beaten, the Warden holds the line by never quite being where the enemy expects.',
      weaponTypes: ['spear', 'sword', 'javelin', 'shield', 'dagger'],
      baseStats: { might: 16, agility: 22, vitality: 20, will: 10, fate: 10 },
      perLevel: { might: 3.2, agility: 4.8, vitality: 4.8, will: 1.6, fate: 1.8 },
      baseMorale: 85, moralePerLevel: 120, basePower: 60, powerPerLevel: 28,
      rangedWeapon: 'javelin', color: 0x7a9ad6, icon: '🔱',
    },
    {
      id: 'brawler', name: 'Brawler', role: 'dps', mainStat: 'might', armourType: 'medium',
      desc: 'The Brawler fights with fist and gauntlet, a pit-fighter and tavern-champion who has turned a talent for breaking noses into a martial art. Where other warriors hide behind steel, the Brawler closes in, absorbs the blow and answers with a flurry of hammering strikes that stagger even a cave-troll. Mettle builds with every hit taken and given, until the Brawler explodes into a battle-fury that no orc can weather. Dwarves and Men of the Dale-lands are the most celebrated Brawlers, but the Prancing Pony has seen a few hobbits hold their own.',
      weaponTypes: ['gauntlets'],
      baseStats: { might: 24, agility: 18, vitality: 18, will: 8, fate: 10 },
      perLevel: { might: 5.4, agility: 3.6, vitality: 4.0, will: 1.2, fate: 2.0 },
      baseMorale: 80, moralePerLevel: 104, basePower: 55, powerPerLevel: 26,
      rangedWeapon: 'throwing', color: 0xd6804a, icon: '👊',
    },
  ];

  /* ------------------------------------------------------------------------------------------------
   * Class traits — 8 passives per class, unlocked at levels 10..80.
   * { level, name, desc, stats {flat}, perLevel {stat: n per level}, pct {stat: %}, special {…} }
   * ---------------------------------------------------------------------------------------------- */
  function T(level, name, desc, stats, perLevel, pct, special) {
    return { level: level, name: name, desc: desc, stats: stats || {}, perLevel: perLevel || {}, pct: pct || {}, special: special || {} };
  }
  const CLASS_TRAITS = {
    guardian: [
      T(10, 'Shield Discipline', 'Years drilling with shield and blade teach the Guardian to catch a blow on the shield-boss and answer it.', { block: 40 }, { block: 4 }),
      T(20, 'Stalwart Heart', 'A Guardian\'s heart does not quail. Your body is hardened by the wounds it has borne.', { vitality: 20 }, {}, { maxMorale: 6 }),
      T(30, 'Iron Hide', 'You wear your armour like a second skin, and blows that should have broken it merely ring.', { armour: 60 }, { armour: 5 }),
      T(40, 'Reactive Parry', 'Every parried stroke opens the enemy to a riposte. Your parries come easier and hit harder.', { parry: 40 }, { parry: 3, physMastery: 2 }),
      T(50, 'Bulwark of the West', 'The Guardian is a wall against the dark; the wall grows thicker with each battle.', {}, { might: 0.6 }, { maxMorale: 6 }),
      T(60, 'Unbreakable', 'Neither sorcery nor steel finds an easy purchase on you.', {}, { resist: 4, vitality: 0.5 }),
      T(70, 'Warrior\'s Fortitude', 'You recover from your wounds with a soldier\'s stubbornness.', {}, {}, { moraleRegen: 25, armour: 6 }),
      T(80, 'Guardian\'s Ward', 'The mastery of a lifetime: your shield is a bulwark for all who stand behind it.', {}, { block: 2 }, { armour: 8, maxMorale: 6 }),
    ],
    champion: [
      T(10, 'Fervour', 'The joy of battle quickens your blows.', { physMastery: 50 }, { physMastery: 3 }),
      T(20, 'Deadly Strikes', 'Your blades find the gaps in any armour.', { crit: 40 }, { crit: 3 }),
      T(30, 'Blade-mastery', 'Two swords, one will. Your Might grows with every foe cut down.', { might: 15 }, { might: 0.6 }),
      T(40, 'Relentless', 'You press the attack without pause, and the enemy has no time to guard.', {}, { finesse: 3 }, { physMastery: 5 }),
      T(50, 'Battle-hardened', 'Scars are only stories. You shrug off blows that would fell others.', {}, { armour: 3 }, { maxMorale: 5 }),
      T(60, 'Heroic Vigour', 'The fire in you burns hotter, and it does not gutter.', {}, { vitality: 0.5 }, { powerRegen: 20 }),
      T(70, 'Storm of Steel', 'You are a whirlwind: every stroke lands harder, every third stroke lands true.', {}, { crit: 3 }, { physMastery: 6 }),
      T(80, 'Champion of Eriador', 'Songs are already being sung of you. Your strength is the stuff of legend.', { might: 40 }, {}, { physMastery: 8, maxMorale: 5 }),
    ],
    captain: [
      T(10, 'Rallying Presence', 'Those who fight beside you find their courage; so do you.', { maxMorale: 150 }, { maxMorale: 6 }),
      T(20, 'Leader\'s Resolve', 'A Captain must be seen to stand. Your will is iron and your arm is strong.', { might: 15, resist: 40 }, { might: 0.4 }),
      T(30, 'Tactician', 'You read the battle as a scholar reads a page, and your words strike as true as your blade.', { will: 15 }, { tactMastery: 3 }),
      T(40, 'Steeled Command', 'Your armour is your banner; it must not fall.', { block: 60 }, { armour: 4 }),
      T(50, 'Words of Courage', 'Your voice mends the wounded and steadies the shaken.', {}, {}, { maxMorale: 6, moraleRegen: 20 }),
      T(60, 'Master of Arms', 'There is no weapon in the armouries of the West you cannot wield.', { crit: 80 }, { physMastery: 4 }),
      T(70, 'Inspiring Valour', 'The greatest captains fight with sword and with hope alike.', {}, {}, { physMastery: 5, tactMastery: 5 }),
      T(80, 'Captain of the West', 'Your standard flies over every victory of the Free Peoples.', { might: 30, will: 30, fate: 20 }, {}, { maxMorale: 6 }),
    ],
    hunter: [
      T(10, 'Keen Eye', 'You see the weak point before you loose.', { crit: 50 }, { crit: 3 }),
      T(20, 'Fleet-footed', 'Long years on forest trails make you swift and hard to catch.', { evade: 40 }, { evade: 3 }, { speed: 3 }),
      T(30, 'Steady Hands', 'Your draw is smooth and your hands never shake.', { agility: 15 }, { agility: 0.6 }),
      T(40, 'Deadly Aim', 'Every arrow is loosed with intent.', {}, { finesse: 3 }, { physMastery: 5 }),
      T(50, 'Woodcraft', 'The wild is your home. You move through it unseen and rest in it untroubled.', {}, {}, { maxMorale: 4, moraleRegen: 25 }, { stealth: 0.1 }),
      T(60, 'Swift Recovery', 'Your focus returns as quickly as your breath.', {}, { vitality: 0.4 }, { powerRegen: 30 }),
      T(70, 'Heart-seeker', 'You have loosed ten thousand arrows; the next one will not miss.', {}, { crit: 3 }, { physMastery: 5 }),
      T(80, 'Hunter of the North', 'No beast or orc in Eriador is safe from your bow.', { agility: 40, evade: 100 }, {}, { physMastery: 8 }),
    ],
    burglar: [
      T(10, 'Sleight of Hand', 'Quick fingers, quicker blade.', { finesse: 50 }, { finesse: 4 }),
      T(20, 'Shadow-step', 'You are gone before the blow lands, and often before it is swung.', { evade: 40 }, { evade: 3 }, {}, { stealth: 0.15 }),
      T(30, 'Cunning', 'You have a nose for trouble and the luck to survive it.', { fate: 15 }, { agility: 0.6 }),
      T(40, 'Exploit Opening', 'Where the enemy is careless, you are merciless.', { crit: 40 }, { crit: 3 }),
      T(50, 'Trickster\'s Luck', 'Fortune loves a rogue.', {}, { fate: 0.5 }, { maxMorale: 4 }),
      T(60, 'Quick Recovery', 'A Burglar who cannot catch a breath cannot pick a lock.', {}, {}, { moraleRegen: 25, powerRegen: 25 }),
      T(70, 'Deadly Precision', 'One knife, one rib, one fewer orc.', {}, { finesse: 3 }, { physMastery: 6 }),
      T(80, 'Master Burglar', 'Bilbo himself would be proud. Or worried about his silverware.', { agility: 40, evade: 100 }, {}, { physMastery: 8 }),
    ],
    minstrel: [
      T(10, 'Harmony', 'Your voice and instrument become one.', { tactMastery: 50 }, { tactMastery: 3 }),
      T(20, 'Soothing Voice', 'Your songs mend you as well as your fellows.', {}, {}, { maxMorale: 4, moraleRegen: 20 }),
      T(30, 'Studied Lore', 'You have learned the oldest lays, and their power runs deep.', { will: 15 }, { will: 0.6 }),
      T(40, 'Resonance', 'Your music echoes long after the last note.', {}, { maxPower: 8 }, { tactMastery: 5 }),
      T(50, 'Heart of Song', 'Music is armour of a kind, and yours is well-forged.', {}, { vitality: 0.5, resist: 4 }),
      T(60, 'Ballad-master', 'Your cries strike at the heart, and sometimes stop it.', { crit: 40 }, { crit: 3 }),
      T(70, 'Anthem of the Free Peoples', 'Your song carries the hope of all the West.', {}, {}, { tactMastery: 6, powerRegen: 30 }),
      T(80, 'Voice of Valinor', 'The Elves say a Minstrel of your gift is heard even across the Sea.', { will: 40 }, {}, { tactMastery: 8, maxMorale: 5 }),
    ],
    loremaster: [
      T(10, 'Ancient Knowledge', 'You have read what others have forgotten.', { tactMastery: 50 }, { tactMastery: 3 }),
      T(20, 'Ward of Lore', 'The words of the Enemy hold no terror for one who knows their true names.', { resist: 60 }, { resist: 4 }),
      T(30, 'Sage\'s Insight', 'Your Will is a lantern in the dark.', { will: 15 }, { will: 0.6 }),
      T(40, 'Beast-lore', 'Your companion guards you, and you have learned a little of its toughness.', {}, { armour: 3 }, { maxMorale: 4 }),
      T(50, 'Power of Knowledge', 'The deep well of lore never runs dry.', {}, { maxPower: 10 }, { powerRegen: 30 }),
      T(60, 'Fire-lore', 'The secret name of fire is yours to speak.', {}, { crit: 3 }, { tactMastery: 5 }),
      T(70, 'Master of Wisdom', 'Few living know more; none know it better.', {}, { fate: 0.4 }, { tactMastery: 6 }),
      T(80, 'Keeper of Ancient Lore', 'Rivendell keeps a chair for you in its library.', { will: 40, resist: 150 }, {}, { tactMastery: 8 }),
    ],
    runekeeper: [
      T(10, 'Rune-attunement', 'The runes answer you more readily.', { tactMastery: 50 }, { tactMastery: 3 }),
      T(20, 'Fiery Focus', 'Your runes of fire burn hotter and strike truer.', { crit: 50 }, { crit: 3 }),
      T(30, 'Deep Runes', 'You carve deeper, and the stone remembers longer.', { will: 15 }, { will: 0.6 }),
      T(40, 'Steady Hand', 'A rune miscarved is a rune wasted; yours never are.', {}, { finesse: 3 }, { tactMastery: 5 }),
      T(50, 'Writ of Vitality', 'The runes of healing linger on your own skin.', {}, { vitality: 0.4 }, { maxMorale: 5 }),
      T(60, 'Bountiful Power', 'The rune-stone hums with a power that never quite runs out.', {}, { maxPower: 10 }, { powerRegen: 30 }),
      T(70, 'Master of Runes', 'Lightning and frost come at a whisper.', {}, { crit: 3 }, { tactMastery: 6 }),
      T(80, 'Rune-lord', 'The Dwarves of Ered Luin speak your name with respect, which is rarer than gold.', { will: 40, crit: 100 }, {}, { tactMastery: 8 }),
    ],
    warden: [
      T(10, 'Spear and Shield', 'The first gambit: shield up, spear ready.', { block: 40, evade: 20 }, { block: 3 }),
      T(20, 'Gambit-master', 'Your chains of blows flow like water.', { physMastery: 40 }, { physMastery: 3 }),
      T(30, 'Nimble Defence', 'You are never quite where the enemy strikes.', { agility: 15 }, { evade: 3 }),
      T(40, 'Determined', 'A Warden holds the border until relieved, and relief is slow in coming.', {}, { vitality: 0.4 }, { maxMorale: 6 }),
      T(50, 'Way of the Spear', 'Your spear turns aside what your shield does not.', {}, { parry: 3, agility: 0.5 }),
      T(60, 'Enduring', 'You have marched further and slept less than any soldier of the West.', {}, { armour: 4 }, { moraleRegen: 30 }),
      T(70, 'Shield-mastery', 'Even a light shield is a wall in the right hands.', {}, { block: 3 }, { armour: 6 }),
      T(80, 'Warden of Annúminas', 'The old towers of the North would welcome you as one of their own.', { evade: 100 }, {}, { maxMorale: 8, physMastery: 5 }),
    ],
    brawler: [
      T(10, 'Iron Fists', 'Your knuckles have broken harder things than orc-jaws.', { physMastery: 50 }, { physMastery: 3 }),
      T(20, 'Toughened', 'You have learned to take a hit, mostly by taking a lot of them.', { armour: 50 }, { armour: 3 }),
      T(30, 'Battle-fury', 'The fury builds, and your strength with it.', { might: 15 }, { might: 0.6 }),
      T(40, 'Fleet Fighter', 'Light on your feet, heavy with your hands.', { evade: 40 }, { evade: 3 }),
      T(50, 'Second Wind', 'Down is not out. You get back up faster than anyone expects.', {}, {}, { maxMorale: 5, moraleRegen: 25 }),
      T(60, 'Hardened Knuckles', 'Every strike is a hammer-blow now.', {}, { crit: 3 }, { physMastery: 5 }),
      T(70, 'Relentless Assault', 'You do not stop. You have forgotten how.', {}, { agility: 0.4 }, { physMastery: 6 }),
      T(80, 'Champion of the Ring', 'Undefeated in every pit from Bree to Dale.', { might: 40 }, {}, { physMastery: 8, maxMorale: 5 }),
    ],
  };

  /* ------------------------------------------------------------------------------------------------
   * Titles registry
   * ---------------------------------------------------------------------------------------------- */
  const TITLES = [
    // level titles
    { id: 'wanderer', name: 'the Wanderer', kind: 'level', req: { level: 10 }, desc: 'Reached level 10.' },
    { id: 'bold', name: 'the Bold', kind: 'level', req: { level: 20 }, desc: 'Reached level 20.' },
    { id: 'steadfast', name: 'the Steadfast', kind: 'level', req: { level: 30 }, desc: 'Reached level 30.' },
    { id: 'renowned', name: 'the Renowned', kind: 'level', req: { level: 40 }, desc: 'Reached level 40.' },
    { id: 'valiant', name: 'the Valiant', kind: 'level', req: { level: 50 }, desc: 'Reached level 50.' },
    { id: 'undaunted', name: 'the Undaunted', kind: 'level', req: { level: 60 }, desc: 'Reached level 60.' },
    { id: 'legendary', name: 'the Legendary', kind: 'level', req: { level: 70 }, desc: 'Reached level 70.' },
    { id: 'hero_eriador', name: 'Hero of Eriador', kind: 'level', req: { level: 80 }, desc: 'Reached level 80, the pinnacle of skill.' },
    // story books
    { id: 'defender_shire', name: 'Defender of the Shire', kind: 'quest', req: { quest: 's012' }, desc: 'Completed Book 1: The Shadow in the Shire.' },
    { id: 'sword_bree', name: 'Sword of Bree', kind: 'quest', req: { quest: 's025' }, desc: 'Completed Book 2.' },
    { id: 'barrow_breaker', name: 'Barrow-breaker', kind: 'quest', req: { quest: 's037' }, desc: 'Completed Book 3 in the Barrow-downs.' },
    { id: 'watcher_weathertop', name: 'Watcher of Weathertop', kind: 'quest', req: { quest: 's050' }, desc: 'Completed Book 4 in the Lone-lands and North Downs.' },
    { id: 'warden_annuminas', name: 'Warden of Annúminas', kind: 'quest', req: { quest: 's062' }, desc: 'Completed Book 5 in Evendim and the Trollshaws.' },
    { id: 'elf_friend', name: 'Elf-friend', kind: 'quest', req: { quest: 's075' }, desc: 'Completed Book 6 in the Misty Mountains and Rivendell.' },
    { id: 'bane_angmar', name: 'Bane of Angmar', kind: 'quest', req: { quest: 's088' }, desc: 'Completed Book 7 in Angmar and Forochel.' },
    { id: 'lord_lost_kingdom', name: 'Lord of the Lost Kingdom', fem: 'Lady of the Lost Kingdom', kind: 'quest', req: { quest: 's100' }, desc: 'Defeated the Gaunt-lord Draugmar and completed the epic story.' },
    // deeds (kill counts by family)
    { id: 'boar_hunter', name: 'Boar-hunter', kind: 'deed', req: { family: 'boar', count: 30 }, desc: 'Slew 30 boars.' },
    { id: 'wolf_bane', name: 'Wolf-bane', kind: 'deed', req: { family: 'wolf', count: 40 }, desc: 'Slew 40 wolves.' },
    { id: 'spider_foe', name: 'Spider-foe', kind: 'deed', req: { family: 'spider', count: 40 }, desc: 'Slew 40 spiders.' },
    { id: 'goblin_slayer', name: 'Goblin-slayer', kind: 'deed', req: { family: 'goblin', count: 60 }, desc: 'Slew 60 goblins.' },
    { id: 'orc_bane', name: 'Orc-bane', kind: 'deed', req: { family: 'orc', count: 80 }, desc: 'Slew 80 orcs.' },
    { id: 'brigand_breaker', name: 'Brigand-breaker', kind: 'deed', req: { family: 'brigand', count: 50 }, desc: 'Slew 50 brigands.' },
    { id: 'wight_breaker', name: 'Wight-breaker', kind: 'deed', req: { family: 'wight', count: 40 }, desc: 'Laid 40 wights to rest.' },
    { id: 'warg_hunter', name: 'Warg-hunter', kind: 'deed', req: { family: 'warg', count: 40 }, desc: 'Slew 40 wargs.' },
    { id: 'troll_slayer', name: 'Troll-slayer', kind: 'deed', req: { family: 'troll', count: 20 }, desc: 'Slew 20 trolls.' },
    { id: 'drake_slayer', name: 'Drake-slayer', kind: 'deed', req: { family: 'drake', count: 20 }, desc: 'Slew 20 drakes.' },
    { id: 'giant_bane', name: 'Giant-bane', kind: 'deed', req: { family: 'giant', count: 15 }, desc: 'Slew 15 giants.' },
    { id: 'uruk_foe', name: 'Foe of the Uruks', kind: 'deed', req: { family: 'uruk', count: 40 }, desc: 'Slew 40 Uruks.' },
    { id: 'serpent_slayer', name: 'Serpent-slayer', kind: 'deed', req: { family: 'sea-serpent', count: 5 }, desc: 'Slew 5 sea-serpents.' },
    { id: 'slayer_500', name: 'the Slayer', kind: 'deed', req: { kills: 500 }, desc: 'Defeated 500 enemies.' },
    { id: 'slayer_2000', name: 'the Reaper', kind: 'deed', req: { kills: 2000 }, desc: 'Defeated 2,000 enemies.' },
    // fishing
    { id: 'angler', name: 'the Angler', kind: 'fishing', req: { fish: 25 }, desc: 'Caught 25 fish.' },
    { id: 'skilled_angler', name: 'the Skilled Angler', kind: 'fishing', req: { fish: 100 }, desc: 'Caught 100 fish.' },
    { id: 'master_angler', name: 'Master Angler', kind: 'fishing', req: { fishingSkill: 100 }, desc: 'Reached fishing skill 100.' },
    { id: 'lord_lakes', name: 'Lord of the Lakes', fem: 'Lady of the Lakes', kind: 'fishing', req: { fish: 500 }, desc: 'Caught 500 fish.' },
    // exploration / regional
    { id: 'explorer_shire', name: 'Explorer of the Shire', kind: 'explore', req: { zone: 'shire' }, desc: 'Visited every town of the Shire.' },
    { id: 'friend_bree', name: 'Friend of Bree', kind: 'explore', req: { zone: 'breeland' }, desc: 'Visited every village of Bree-land.' },
    { id: 'lonelands_wanderer', name: 'Wanderer of the Lone-lands', kind: 'explore', req: { zone: 'lonelands' }, desc: 'Explored the Lone-lands.' },
    { id: 'ranger_north', name: 'Ranger of the North Downs', kind: 'explore', req: { zone: 'northdowns' }, desc: 'Explored the North Downs.' },
    { id: 'lakewarden', name: 'Lake-warden of Evendim', kind: 'explore', req: { zone: 'evendim' }, desc: 'Explored Evendim.' },
    { id: 'troll_hunter', name: 'Troll-hunter of the Trollshaws', kind: 'explore', req: { zone: 'trollshaws' }, desc: 'Explored the Trollshaws.' },
    { id: 'mountaineer', name: 'the Mountaineer', kind: 'explore', req: { zone: 'misty' }, desc: 'Explored the Misty Mountains.' },
    { id: 'scourge_angmar', name: 'Scourge of Angmar', kind: 'explore', req: { zone: 'angmar' }, desc: 'Explored Angmar.' },
    { id: 'lossoth_friend', name: 'Lossoth-friend', kind: 'explore', req: { zone: 'forochel' }, desc: 'Explored Forochel.' },
    { id: 'isle_wanderer', name: 'Isle-wanderer', kind: 'explore', req: { zones: ['tolfuin', 'tolmorwen', 'himling'] }, desc: 'Set foot on all three of the Sundered Isles.' },
    { id: 'world_traveller', name: 'the World-traveller', kind: 'explore', req: { allZones: true }, desc: 'Visited every zone in Eriador.' },
    // misc
    { id: 'questmaster', name: 'the Diligent', kind: 'quest', req: { quests: 75 }, desc: 'Completed 75 quests.' },
    { id: 'completionist', name: 'the Accomplished', kind: 'quest', req: { quests: 150 }, desc: 'Completed all 150 quests.' },
    { id: 'undying', name: 'the Undying', kind: 'deed', req: { level: 20, deaths: 0 }, desc: 'Reached level 20 without being defeated.' },
    { id: 'horse_friend', name: 'Horse-friend', kind: 'deed', req: { mounts: 3 }, desc: 'Learned three mounts.' },
  ];

  /* ------------------------------------------------------------------------------------------------
   * Lookups
   * ---------------------------------------------------------------------------------------------- */
  const raceById = {}, classById = {}, titleById = {};
  for (const r of RACES) raceById[r.id] = r;
  for (const c of CLASSES) classById[c.id] = c;
  for (const t of TITLES) titleById[t.id] = t;

  /* ------------------------------------------------------------------------------------------------
   * Name generator
   * ---------------------------------------------------------------------------------------------- */
  const _BAD = ['sambo', 'nigg', 'fag', 'cunt', 'shit', 'fuck', 'dick', 'cock', 'twat', 'rape', 'nazi', 'kike', 'spic', 'coon', 'wank', 'slut', 'whore', 'anus', 'piss', 'arse', 'boob', 'penis', 'vagin', 'porn', 'sex'];
  const _VOWELS = 'aeiouy';
  function _isVowel(ch) { return _VOWELS.indexOf(ch.toLowerCase()) >= 0; }
  function _joinSyllables(parts) {
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      let s = parts[i];
      if (!s) continue;
      if (out.length) {
        const a = out[out.length - 1].toLowerCase(), b = s[0].toLowerCase();
        if (a === b && _isVowel(a)) s = s.slice(1);                       // "Fro" + "o..." → drop duplicate vowel
        else if (a === b && !_isVowel(a) && out.length > 1 && out[out.length - 2].toLowerCase() === a) s = s.slice(1); // avoid triple consonant
        else if (!_isVowel(a) && !_isVowel(b) && out.length > 1 && !_isVowel(out[out.length - 2]) && s.length > 1 && !_isVowel(s[1])) {
          // four consonants in a row (e.g. "Thran" + "dr") → add a soft vowel
          s = 'a' + s;
        }
      }
      out += s;
    }
    if (!out.length) return '';
    return out[0].toUpperCase() + out.slice(1).toLowerCase();
  }
  function _clean(name) {
    return /^[A-Za-z]{3,16}$/.test(name) && !_BAD.some(function (b) { return name.toLowerCase().indexOf(b) >= 0; });
  }
  function randomName(raceId, gender, rng) {
    const race = raceById[raceId] || RACES[0];
    const r = _rngOf(rng);
    const fem = (gender === 'female' || gender === 'f' || gender === 'F');
    const lists = fem ? race.namesF : race.namesM;
    const exemplars = fem ? race.exemplarsF : race.exemplarsM;
    for (let attempt = 0; attempt < 14; attempt++) {
      let name;
      if (exemplars && exemplars.length && r() < 0.22) name = _pick(exemplars, r);
      else {
        const parts = [];
        for (let i = 0; i < lists.length; i++) parts.push(_pick(lists[i], r));
        name = _joinSyllables(parts);
      }
      if (_clean(name)) return name;
    }
    return (exemplars && exemplars.length) ? _pick(exemplars, r) : (fem ? 'Rosalind' : 'Aldric');
  }
  function randomSurname(raceId, rng) {
    const race = raceById[raceId];
    if (!race || !race.surnames || !race.surnames.length) return '';
    return _pick(race.surnames, _rngOf(rng));
  }
  function randomFullName(raceId, gender, rng) {
    const r = _rngOf(rng);
    const first = randomName(raceId, gender, r);
    const sur = randomSurname(raceId, r);
    return sur ? first + ' ' + sur : first;
  }

  /* ------------------------------------------------------------------------------------------------
   * Difficulty colours (target frame / nameplates)
   * ---------------------------------------------------------------------------------------------- */
  const DIFF = [
    { key: 'trivial', color: '#9a9a9a', label: 'Trivial' },
    { key: 'easy', color: '#5fd35f', label: 'Easy' },
    { key: 'even', color: '#f2e34a', label: 'Even' },
    { key: 'tough', color: '#ff9a2e', label: 'Tough' },
    { key: 'hard', color: '#ff4a3a', label: 'Hard' },
    { key: 'deadly', color: '#c86bff', label: 'Deadly' },
  ];
  function difficulty(entityLevel, playerLevel) {
    const el = _num(entityLevel, 1), pl = _num(playerLevel, 1);
    const diff = Math.round(el - pl);
    let d;
    if (diff <= -8) d = DIFF[0];
    else if (diff <= -3) d = DIFF[1];
    else if (diff <= 0) d = DIFF[2];
    else if (diff <= 2) d = DIFF[3];
    else if (diff <= 4) d = DIFF[4];
    else d = DIFF[5];
    return { key: d.key, color: d.color, label: d.label, diff: diff };
  }
  function difficultyColor(entityLevel, playerLevel) { return difficulty(entityLevel, playerLevel).color; }
  function conLabel(entityLevel, playerLevel) { return difficulty(entityLevel, playerLevel).label; }

  /* ------------------------------------------------------------------------------------------------
   * §4.3 STATS
   * ---------------------------------------------------------------------------------------------- */
  const PRIMARY_KEYS = ['might', 'agility', 'vitality', 'will', 'fate'];
  const RATING_KEYS = ['maxMorale', 'maxPower', 'armour', 'physMastery', 'tactMastery', 'crit', 'finesse', 'block', 'parry', 'evade', 'resist', 'moraleRegen', 'powerRegen'];
  const SPECIAL_KEYS = ['stealth', 'fishingLuck', 'healOnKillPct', 'mountSpeedMult', 'swimSpeedMult', 'fallDamageMult', 'knockbackResist', 'lightDamageMult'];
  const STAT_KEYS = PRIMARY_KEYS.concat(RATING_KEYS, ['speed']);
  const STAT_NAMES = {
    might: 'Might', agility: 'Agility', vitality: 'Vitality', will: 'Will', fate: 'Fate',
    maxMorale: 'Morale', maxPower: 'Power', armour: 'Armour',
    physMastery: 'Physical Mastery', tactMastery: 'Tactical Mastery', crit: 'Critical Rating', finesse: 'Finesse',
    block: 'Block Rating', parry: 'Parry Rating', evade: 'Evade Rating', resist: 'Resistance',
    moraleRegen: 'Morale Regeneration', powerRegen: 'Power Regeneration', speed: 'Run Speed',
    stealth: 'Stealth', fishingLuck: 'Fishing Luck', healOnKillPct: 'Morale on Kill', mountSpeedMult: 'Mount Speed',
    swimSpeedMult: 'Swim Speed', fallDamageMult: 'Fall Damage', knockbackResist: 'Knockback Resistance', lightDamageMult: 'Light Damage',
    mitigation: 'Physical Mitigation', critChance: 'Critical Chance', blockChance: 'Block Chance', parryChance: 'Parry Chance', evadeChance: 'Evade Chance', resistChance: 'Tactical Mitigation',
  };
  const STAT_DESC = {
    might: 'Might is the measure of raw strength. Each point adds 2 Physical Mastery and 1 Parry rating, and 1 Block rating when a shield is carried. The main stat of Guardians, Champions, Captains and Brawlers.',
    agility: 'Agility governs speed and precision. Each point adds 1 Physical Mastery, 1.5 Evade rating and 1 Finesse. The main stat of Hunters, Burglars and Wardens.',
    vitality: 'Vitality is toughness of body. Each point adds 3 maximum Morale and improves Morale regeneration.',
    will: 'Will is strength of mind and spirit. Each point adds 2 Tactical Mastery, 2 maximum Power and 1 Resistance. The main stat of Minstrels, Lore-masters and Rune-keepers.',
    fate: 'Fate is fortune itself. Each point adds 1.5 Critical rating and 0.5 Resistance, and quickens the recovery of Power.',
    maxMorale: 'Morale is your will to fight on. When it reaches zero you are defeated and must retreat to the nearest rally point.',
    maxPower: 'Power fuels your abilities. It recovers slowly in combat and quickly while resting.',
    armour: 'Armour reduces the physical damage you take. Mitigation % = armour / (armour + 30 × level + 100), up to 60%.',
    physMastery: 'Physical Mastery increases the damage of melee and ranged attacks. Damage = ability multiplier × Physical Mastery / 4 + weapon damage.',
    tactMastery: 'Tactical Mastery increases the damage of tactical (spell-like) abilities and the strength of your healing.',
    crit: 'Critical rating raises the chance that an attack or heal is a critical (×1.6). Chance % = rating / (rating + 40 × level + 200), up to 25%.',
    finesse: 'Finesse lets your attacks slip past an enemy\'s block, parry and evade. Each 100 points reduces their avoidance chance by about 1%.',
    block: 'Block rating gives a chance to stop an attack with your shield. Requires a shield in the off-hand. Chance % = rating / (rating + 40 × level + 300), up to 20%.',
    parry: 'Parry rating gives a chance to turn aside a melee attack with your weapon. Requires a weapon in the main hand. Chance capped at 20%.',
    evade: 'Evade rating gives a chance to dodge an attack entirely. Chance % = rating / (rating + 40 × level + 300), up to 20%.',
    resist: 'Resistance reduces the damage of tactical attacks (fire, frost, lightning, light and shadow). Mitigation % = rating / (rating + 30 × level + 100), up to 50%.',
    moraleRegen: 'Morale recovered per second while out of combat. In combat you recover one sixth of this.',
    powerRegen: 'Power recovered per second while out of combat. In combat you recover one quarter of this.',
    speed: 'Movement speed multiplier. Slows, roots and stuns reduce it; some traits and effects increase it.',
    stealth: 'Reduces the distance from which monsters notice you.',
    fishingLuck: 'Raises the chance of rare catches while fishing.',
    healOnKillPct: 'Percentage of maximum Morale restored whenever you defeat an enemy.',
    mountSpeedMult: 'Multiplier applied to the speed of your mounts.',
    swimSpeedMult: 'Multiplier applied to your swimming speed.',
    fallDamageMult: 'Multiplier applied to damage taken from falls.',
    knockbackResist: 'Reduces the distance you are knocked back by heavy blows.',
    lightDamageMult: 'Multiplier applied to light-based damage you deal.',
    mitigation: 'Percentage of incoming physical damage that your Armour absorbs.',
    critChance: 'Chance that your attacks and heals strike critically for 160% effect.',
    blockChance: 'Chance to block an incoming attack with your shield.',
    parryChance: 'Chance to parry an incoming melee attack with your weapon.',
    evadeChance: 'Chance to evade an incoming attack entirely.',
    resistChance: 'Percentage of incoming tactical damage that your Resistance absorbs.',
  };
  function describe(stat) { return STAT_DESC[stat] || (STAT_NAMES[stat] ? STAT_NAMES[stat] + '.' : ''); }

  // Innate armour per level by armour training (so a naked hero is not made of paper).
  const INNATE_ARMOUR = { heavy: 8, medium: 5, light: 3 };

  function _pctFrac(v) { v = _num(v, 0); return Math.abs(v) <= 1 ? v : v / 100; }

  // Accumulator used by compute(): flat primaries, flat ratings, pct multipliers, specials.
  function _acc() {
    const a = { p: {}, f: {}, pct: {}, sp: {} };
    for (const k of PRIMARY_KEYS) { a.p[k] = 0; a.pct[k] = 0; }
    for (const k of RATING_KEYS) { a.f[k] = 0; a.pct[k] = 0; }
    a.pct.speed = 0;
    a.sp.stealth = 0; a.sp.fishingLuck = 0; a.sp.healOnKillPct = 0;
    a.sp.mountSpeedMult = 1; a.sp.swimSpeedMult = 1; a.sp.fallDamageMult = 1; a.sp.knockbackResist = 0; a.sp.lightDamageMult = 1;
    return a;
  }
  function _addFlat(a, key, v, sign) {
    v = _num(v, 0) * (sign || 1);
    if (!v) return;
    if (a.p.hasOwnProperty(key)) a.p[key] += v;
    else if (a.f.hasOwnProperty(key)) a.f[key] += v;
    else if (key === 'morale') a.f.maxMorale += v;
    else if (key === 'power') a.f.maxPower += v;
  }
  function _addPct(a, key, v, sign) {
    v = _num(v, 0) * (sign || 1);
    if (!v) return;
    if (a.pct.hasOwnProperty(key)) a.pct[key] += v;
    else if (key === 'morale') a.pct.maxMorale += v;
    else if (key === 'power') a.pct.maxPower += v;
  }
  function _addSpecial(a, sp) {
    if (!sp) return;
    for (const k in sp) {
      const v = _num(sp[k], 0);
      if (!v) continue;
      if (k === 'mountSpeedMult' || k === 'swimSpeedMult' || k === 'fallDamageMult' || k === 'lightDamageMult') a.sp[k] = (a.sp[k] || 1) * v;
      else a.sp[k] = (a.sp[k] || 0) + v;
    }
  }
  // Adds a bonus block { stats, perLevel, pct, special } (traits) or a plain stats map (race statBonus / gear).
  function _addBonus(a, b, L) {
    if (!b) return;
    if (b.stats || b.perLevel || b.pct || b.special) {
      if (b.stats) for (const k in b.stats) _addFlat(a, k, b.stats[k]);
      if (b.perLevel) for (const k in b.perLevel) _addFlat(a, k, b.perLevel[k] * L);
      if (b.pct) for (const k in b.pct) _addPct(a, k, b.pct[k]);
      _addSpecial(a, b.special);
    } else {
      for (const k in b) {
        if (a.sp.hasOwnProperty(k)) { const o = {}; o[k] = b[k]; _addSpecial(a, o); }
        else _addFlat(a, k, b[k]);
      }
    }
  }

  function _equipView(inst) {
    if (!inst) return null;
    try {
      if (G.Items && typeof G.Items.get === 'function') return G.Items.get(inst) || null;
    } catch (e) { /* item module not ready or bad instance */ }
    // fallback (items module absent): merge template + instance overrides ourselves
    const tpl = (D.items && inst.tid && D.items[inst.tid]) ? D.items[inst.tid] : null;
    if (!tpl) return (inst.stats || inst.subtype || inst.type || inst.dmg) ? inst : null;
    return inst.stats ? Object.assign({}, tpl, { stats: inst.stats }) : tpl;
  }

  function compute(ent) {
    if (!ent || typeof ent !== 'object') return null;
    const cls = ent.cls ? classById[ent.cls] : null;
    const race = ent.race ? raceById[ent.race] : null;
    let L = _lvl(ent);
    if (cls && L > LEVEL_CAP) L = LEVEL_CAP;
    const st = (ent.stats && typeof ent.stats === 'object') ? ent.stats : (ent.stats = {});
    const a = _acc();

    // ---- 1. base primaries -------------------------------------------------------------------
    if (cls) {
      for (const k of PRIMARY_KEYS) a.p[k] += _num(cls.baseStats[k], 0) + _num(cls.perLevel[k], 0) * (L - 1);
    } else {
      // creature / class-less entity: owner-supplied baseline or a generic curve
      const bs = ent.baseStats || null;
      const gen = { might: 8 + 4 * L, agility: 8 + 3 * L, vitality: 8 + 4 * L, will: 6 + 2 * L, fate: 4 + L };
      for (const k of PRIMARY_KEYS) a.p[k] += (bs && typeof bs[k] === 'number') ? bs[k] : gen[k];
    }

    // ---- 2. race ------------------------------------------------------------------------------
    if (race) {
      _addBonus(a, race.statBonus, L);
      _addBonus(a, race.racialTrait, L);
    }

    // ---- 3. class traits ----------------------------------------------------------------------
    if (cls && CLASS_TRAITS[cls.id]) {
      const traits = CLASS_TRAITS[cls.id];
      for (let i = 0; i < traits.length; i++) if (L >= traits[i].level) _addBonus(a, traits[i], L);
    }

    // ---- 4. equipment -------------------------------------------------------------------------
    let hasShield = false, hasWeapon = false;
    const eq = ent.equipment;
    if (eq && typeof eq === 'object') {
      for (const slot in eq) {
        const inst = eq[slot];
        if (!inst) continue;
        const view = _equipView(inst);
        if (!view) continue;
        if (view.stats) _addBonus(a, view.stats, L);
        if (slot === 'offhand' && (view.subtype === 'shield' || view.armourType === 'shield')) hasShield = true;
        if (slot === 'mainhand' && (view.type === 'weapon' || view.dmg)) hasWeapon = true;
      }
      // gear set bonuses (03_data_items)
      try {
        if (G.Items && typeof G.Items.setBonuses === 'function') {
          const sb = G.Items.setBonuses(ent);
          if (sb) {
            if (Array.isArray(sb)) for (const b of sb) _addBonus(a, b, L);
            else _addBonus(a, sb, L);
          }
        }
      } catch (e) { /* defensive */ }
    }

    // ---- 5. free-form bonuses (admin, food that is not an effect, …) ----------------------------
    if (ent.statBonus && typeof ent.statBonus === 'object') _addBonus(a, ent.statBonus, L);

    // ---- 6. active effects --------------------------------------------------------------------
    let stunned = false, rooted = false, slowFrac = 0;
    const effs = ent.effects;
    if (Array.isArray(effs)) {
      for (let i = 0; i < effs.length; i++) {
        const e = effs[i];
        if (!e) continue;
        const kind = e.kind || 'buff';
        if (kind === 'stun') { stunned = true; continue; }
        if (kind === 'root') { rooted = true; continue; }
        if (kind === 'slow' && !e.stat) { slowFrac = Math.max(slowFrac, Math.abs(_pctFrac(e.pct != null ? e.pct : e.amount))); continue; }
        if (!e.stat) continue;
        const sign = (kind === 'debuff' || kind === 'slow') ? -1 : 1;
        if (typeof e.amount === 'number' && e.amount !== 0) _addFlat(a, e.stat, sign < 0 ? -Math.abs(e.amount) : e.amount);
        if (typeof e.pct === 'number' && e.pct !== 0) {
          const p = _pctFrac(e.pct) * 100;
          _addPct(a, e.stat, sign < 0 ? -Math.abs(p) : p);
        }
      }
    }

    // ---- 7. primaries: percentage multipliers, overrides, floor -------------------------------
    const p = a.p;
    for (const k of PRIMARY_KEYS) {
      p[k] = p[k] * (1 + a.pct[k] / 100);
      if (ent.statOverride && typeof ent.statOverride[k] === 'number') p[k] = ent.statOverride[k];
      p[k] = Math.max(1, Math.round(p[k]));
    }

    // ---- 8. derived ---------------------------------------------------------------------------
    const f = a.f, pct = a.pct;
    const mul = function (k) { return 1 + pct[k] / 100; };
    let maxMorale, maxPower, armour;
    if (cls) {
      maxMorale = cls.baseMorale + cls.moralePerLevel * L + p.vitality * 3 + f.maxMorale;
      maxPower = cls.basePower + cls.powerPerLevel * L + p.will * 2 + f.maxPower;
      armour = 10 + (INNATE_ARMOUR[cls.armourType] || 4) * L + f.armour;
    } else {
      // creatures: keep the owner's baseline (monster type morale/armour) if one was given
      let base = ent.baseStats;
      if (!base || typeof base.maxMorale !== 'number') {
        if (!ent._statBase) {
          ent._statBase = {
            maxMorale: (typeof st.maxMorale === 'number' && st.maxMorale > 0) ? st.maxMorale : (typeof ent.morale === 'number' && ent.morale > 0 ? ent.morale : 0),
            maxPower: (typeof st.maxPower === 'number' && st.maxPower > 0) ? st.maxPower : 0,
            armour: (typeof st.armour === 'number') ? st.armour : -1,
          };
        }
        base = Object.assign({}, ent._statBase, base || {});
      }
      maxMorale = (base.maxMorale > 0 ? base.maxMorale : (40 + 24 * L + p.vitality * 3)) + f.maxMorale;
      maxPower = (base.maxPower > 0 ? base.maxPower : (40 + 10 * L + p.will * 2)) + f.maxPower;
      armour = (typeof base.armour === 'number' && base.armour >= 0 ? base.armour : L * 6) + f.armour;
    }
    maxMorale = Math.max(1, Math.round(maxMorale * mul('maxMorale')));
    maxPower = Math.max(0, Math.round(maxPower * mul('maxPower')));
    armour = Math.max(0, Math.round(armour * mul('armour')));

    const physMastery = Math.max(0, Math.round((p.might * 2 + p.agility + f.physMastery) * mul('physMastery')));
    const tactMastery = Math.max(0, Math.round((p.will * 2 + f.tactMastery) * mul('tactMastery')));
    const crit = Math.max(0, Math.round((p.fate * 1.5 + f.crit) * mul('crit')));
    const finesse = Math.max(0, Math.round((p.agility + f.finesse) * mul('finesse')));
    const block = (cls && !hasShield) ? 0 : Math.max(0, Math.round((p.might + f.block) * mul('block')));
    const parry = (cls && !hasWeapon) ? 0 : Math.max(0, Math.round((p.might + f.parry) * mul('parry')));
    const evade = Math.max(0, Math.round((p.agility * 1.5 + f.evade) * mul('evade')));
    const resist = Math.max(0, Math.round((p.will + p.fate * 0.5 + f.resist) * mul('resist')));
    const moraleRegen = Math.max(0, Math.round((maxMorale * 0.025 + p.vitality * 0.1 + f.moraleRegen) * mul('moraleRegen') * 10) / 10);
    const powerRegen = Math.max(0, Math.round((maxPower * 0.02 + p.fate * 0.1 + f.powerRegen) * mul('powerRegen') * 10) / 10);

    let speed = mul('speed');
    if (slowFrac > 0) speed *= Math.max(0, 1 - slowFrac);
    if (stunned || rooted) speed = 0;
    speed = Math.max(0, Math.round(speed * 1000) / 1000);

    // ---- 9. write results ---------------------------------------------------------------------
    for (const k of PRIMARY_KEYS) st[k] = p[k];
    st.maxMorale = maxMorale; st.maxPower = maxPower; st.armour = armour;
    st.physMastery = physMastery; st.tactMastery = tactMastery; st.crit = crit; st.finesse = finesse;
    st.block = block; st.parry = parry; st.evade = evade; st.resist = resist;
    st.moraleRegen = moraleRegen; st.powerRegen = powerRegen; st.speed = speed;
    st.moraleRegenCombat = Math.round(moraleRegen / 6 * 10) / 10;
    st.powerRegenCombat = Math.round(powerRegen / 4 * 10) / 10;
    st.stunned = stunned; st.rooted = rooted;
    st.hasShield = hasShield; st.hasWeapon = hasWeapon;
    for (const k of SPECIAL_KEYS) st[k] = a.sp[k];
    st.mitigation = _mitFromArmour(armour, L);
    st.critChance = _chance(crit, 40 * L + 200, 25);
    st.blockChance = _chance(block, 40 * L + 300, 20);
    st.parryChance = _chance(parry, 40 * L + 300, 20);
    st.evadeChance = _chance(evade, 40 * L + 300, 20);
    st.resistChance = Math.min(50, resist / (resist + 30 * L + 100) * 100);

    // ---- 10. clamp current pools --------------------------------------------------------------
    if (typeof ent.morale !== 'number' || !isFinite(ent.morale)) ent.morale = maxMorale;
    else if (ent.morale > maxMorale) ent.morale = maxMorale;
    if (typeof ent.power !== 'number' || !isFinite(ent.power)) ent.power = maxPower;
    else if (ent.power > maxPower) ent.power = maxPower;
    return st;
  }

  function _chance(rating, k, cap) { rating = Math.max(0, _num(rating, 0)); return rating <= 0 ? 0 : Math.min(cap, rating / (rating + k) * 100); }
  function _mitFromArmour(armour, L) { armour = Math.max(0, _num(armour, 0)); return armour <= 0 ? 0 : Math.min(60, armour / (armour + 30 * L + 100) * 100); }
  function _st(ent) { return (ent && ent.stats) ? ent.stats : null; }
  function mitigation(ent) { const s = _st(ent); return s ? _mitFromArmour(s.armour, _lvl(ent)) : 0; }
  function critChance(ent) { const s = _st(ent); return s ? _chance(s.crit, 40 * _lvl(ent) + 200, 25) : 0; }
  function blockChance(ent) { const s = _st(ent); return s ? _chance(s.block, 40 * _lvl(ent) + 300, 20) : 0; }
  function parryChance(ent) { const s = _st(ent); return s ? _chance(s.parry, 40 * _lvl(ent) + 300, 20) : 0; }
  function evadeChance(ent) { const s = _st(ent); return s ? _chance(s.evade, 40 * _lvl(ent) + 300, 20) : 0; }
  function resistChance(ent) { const s = _st(ent); if (!s) return 0; const r = Math.max(0, _num(s.resist, 0)); return r <= 0 ? 0 : Math.min(50, r / (r + 30 * _lvl(ent) + 100) * 100); }
  function percentages(ent) {
    return { mitigation: mitigation(ent), critChance: critChance(ent), blockChance: blockChance(ent), parryChance: parryChance(ent), evadeChance: evadeChance(ent), resistChance: resistChance(ent) };
  }
  // Average damage of the main-hand weapon (or unarmed) — used by combat's damage formula.
  function weaponAvg(ent) {
    if (!ent) return 1;
    const L = _lvl(ent);
    const inst = ent.equipment ? ent.equipment.mainhand : null;
    const view = inst ? _equipView(inst) : null;
    if (view && view.dmg && typeof view.dmg.min === 'number' && typeof view.dmg.max === 'number') return (view.dmg.min + view.dmg.max) / 2;
    if (ent.cls === 'brawler') return 3 + L * 1.2;
    return 2 + L * 0.6;
  }
  // Character-creation / AI-player preview: compute for a bare (ungeared) hero.
  function preview(clsId, raceId, level, gender) {
    const ent = { cls: clsId, race: raceId, level: level || 1, gender: gender || 'male', equipment: {}, effects: [], stats: {} };
    return compute(ent);
  }

  /* ------------------------------------------------------------------------------------------------
   * XP, gold and training costs
   *
   * XP to go from level L to L+1:  need(L) = 150 + 40·L + 10·L²          (L = 1..79)
   *   need(1) = 200 · need(10) = 1,550 · need(40) = 17,750 · need(79) = 65,720
   *   total to 80 = Σ need(1..79) = 150·79 + 40·3160 + 10·167,480 = 1,813,050  (G.Data.xp.total80)
   *
   * Quest reward:  questXP(L,'story') = 0.45·need(L) = round(67.5 + 18·L + 4.5·L²);  side = 0.6× story.
   * Kill reward:   killXP(m, p) = base(m)·f(m−p),  base(m) = 4 + 0.7·m + 0.16·m²  (≈ 1.4 % of need(m)),
   *                f = 0 at −8 levels or lower (grey), rising linearly to 1 at even level, +8 % per level above (max +40 %).
   *
   * Budget (simulated in tools/scratch/check_data.js with the §9 level flow: story quests s001–s100 spread over
   * the eight Books, side quests q001–q050 spread over levels 2–78, and ≈ 10 same-level kills per quest):
   *   story quests ≈ 1,167,000 · side quests ≈ 274,000 · kills ≈ 380,000  →  ≈ 1,821,000 ≥ 1,813,050
   * so the hero reaches level 80 while finishing s099/s100 (any additional exploration kills only add slack).
   * ---------------------------------------------------------------------------------------------- */
  const XP_TABLE = [0, 0];       // XP_TABLE[L] = cumulative XP required to *reach* level L (L=1 → 0)
  function _need(L) { return 150 + 40 * L + 10 * L * L; }
  for (let L = 1; L <= LEVEL_CAP; L++) XP_TABLE[L + 1] = XP_TABLE[L] + _need(L);
  const total80 = XP_TABLE[LEVEL_CAP];

  function forLevel(L) {
    L = Math.floor(_num(L, 1));
    if (L <= 1) return 0;
    if (L > LEVEL_CAP + 1) L = LEVEL_CAP + 1;
    return XP_TABLE[L];
  }
  function needFor(L) { L = _clamp(Math.floor(_num(L, 1)), 1, LEVEL_CAP); return _need(L); }
  function levelForXP(xp) {
    xp = _num(xp, 0);
    let L = 1;
    while (L < LEVEL_CAP && xp >= XP_TABLE[L + 1]) L++;
    return L;
  }
  function progress(xp) {
    xp = Math.max(0, _num(xp, 0));
    const L = levelForXP(xp);
    if (L >= LEVEL_CAP) return { level: L, into: xp - XP_TABLE[L], need: _need(L), pct: 100, toNext: 0, capped: true };
    const into = xp - XP_TABLE[L], need = _need(L);
    return { level: L, into: into, need: need, pct: _clamp(into / need * 100, 0, 100), toNext: need - into, capped: false };
  }
  const QUEST_TYPE_MULT = { story: 1.0, side: 0.6, daily: 0.5, deed: 0.4 };
  function questXP(level, type) {
    const L = _clamp(Math.round(_num(level, 1)), 1, LEVEL_CAP);
    const m = QUEST_TYPE_MULT[type] != null ? QUEST_TYPE_MULT[type] : QUEST_TYPE_MULT.side;
    return Math.round(0.45 * _need(L) * m);
  }
  function killXP(mobLevel, playerLevel, mult) {
    const m = Math.max(1, _num(mobLevel, 1)), pl = Math.max(1, _num(playerLevel, 1));
    const diff = m - pl;
    if (diff <= -8) return 0;
    let f;
    if (diff < 0) f = 1 + diff / 8;                 // -1 → 0.875 … -7 → 0.125
    else f = 1 + Math.min(diff, 5) * 0.08;          // tougher foes are worth a little more (max +40 %)
    const base = 4 + 0.7 * m + 0.16 * m * m;
    return Math.max(1, Math.round(base * f * (_num(mult, 1) || 1)));
  }
  const GOLD_TYPE_MULT = { story: 1.0, side: 0.6, daily: 0.5, deed: 0.3 };
  function goldReward(level, type) {
    const L = _clamp(Math.round(_num(level, 1)), 1, LEVEL_CAP);
    const m = GOLD_TYPE_MULT[type] != null ? GOLD_TYPE_MULT[type] : GOLD_TYPE_MULT.side;
    // copper: 94 c at L1 · 47 s at L10 · 72 s at L40 · 2 g 95 s at L80 (story)
    return Math.round((40 + 8 * L + 46 * L * L) * m);
  }
  function abilityCost(level) {
    const L = Math.round(_num(level, 1));
    if (L <= 1) return 0;
    // 31.25·L²  → 500 c (5 s) at L4 · 20 s at L8 · 50 s at L40 · 2 g at L80; rounded to 50 c
    return Math.round(31.25 * L * L / 50) * 50;
  }
  // §9 story level flow — quest index (1..100) → recommended level; side index (1..50) → level 2..78.
  const STORY_LEVEL_PLAN = [
    { book: 1, name: 'The Shadow in the Shire', from: 1, to: 12, levels: [1, 10] },
    { book: 2, name: 'Roads to Bree and the Blue Mountains', from: 13, to: 25, levels: [8, 20] },
    { book: 3, name: 'The Old Forest and the Barrow-downs', from: 26, to: 37, levels: [15, 28] },
    { book: 4, name: 'The Lone-lands and the North Downs', from: 38, to: 50, levels: [26, 40] },
    { book: 5, name: 'Evendim and the Trollshaws', from: 51, to: 62, levels: [38, 50] },
    { book: 6, name: 'The Misty Mountains and Rivendell', from: 63, to: 75, levels: [48, 58] },
    { book: 7, name: 'Angmar and Forochel', from: 76, to: 88, levels: [56, 70] },
    { book: 8, name: 'The Sundered Isles', from: 89, to: 100, levels: [68, 80] },
  ];
  function storyLevel(index) {
    const i = _clamp(Math.round(_num(index, 1)), 1, 100);
    for (const b of STORY_LEVEL_PLAN) {
      if (i >= b.from && i <= b.to) {
        const t = (i - b.from) / Math.max(1, b.to - b.from);
        return Math.round(b.levels[0] + (b.levels[1] - b.levels[0]) * t);
      }
    }
    return LEVEL_CAP;
  }
  function sideLevel(index) {
    const i = _clamp(Math.round(_num(index, 1)), 1, 50);
    return Math.round(2 + 76 * (i - 1) / 49);
  }

  /* ------------------------------------------------------------------------------------------------
   * Trait helpers & bonus formatting
   * ---------------------------------------------------------------------------------------------- */
  function traitsFor(clsId, level) {
    const list = CLASS_TRAITS[clsId] || [];
    const L = _num(level, 1);
    return list.filter(function (t) { return L >= t.level; });
  }
  function nextTrait(clsId, level) {
    const list = CLASS_TRAITS[clsId] || [];
    const L = _num(level, 1);
    for (const t of list) if (t.level > L) return t;
    return null;
  }
  function _fmtStat(k, v) {
    const name = STAT_NAMES[k] || k;
    if (k === 'speed') return (v > 0 ? '+' : '') + v + '% ' + name;
    if (k === 'stealth' || k === 'fishingLuck') return '+' + Math.round(v * 100) + '% ' + name;
    if (k === 'healOnKillPct') return '+' + v + '% ' + name;
    if (k === 'mountSpeedMult' || k === 'swimSpeedMult' || k === 'lightDamageMult') return '+' + Math.round((v - 1) * 100) + '% ' + name;
    if (k === 'fallDamageMult') return '-' + Math.round((1 - v) * 100) + '% ' + name;
    if (k === 'knockbackResist') return '+' + Math.round(v * 100) + '% ' + name;
    return (v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + ' ' + name;
  }
  // { stats, perLevel, pct, special } → 'Text, text, text' (level resolves per-level bonuses; omit for generic text)
  function describeBonus(b, level) {
    if (!b) return '';
    const parts = [];
    const L = (typeof level === 'number' && level > 0) ? level : 0;
    const merged = {};
    if (b.stats) for (const k in b.stats) merged[k] = (merged[k] || 0) + b.stats[k];
    if (b.perLevel) {
      for (const k in b.perLevel) {
        if (L) merged[k] = (merged[k] || 0) + b.perLevel[k] * L;
        else parts.push('+' + b.perLevel[k] + ' ' + (STAT_NAMES[k] || k) + ' per level');
      }
    }
    for (const k in merged) if (merged[k]) parts.unshift(_fmtStat(k, Math.round(merged[k] * 10) / 10));
    if (b.pct) for (const k in b.pct) if (b.pct[k]) parts.push((b.pct[k] > 0 ? '+' : '') + b.pct[k] + '% ' + (STAT_NAMES[k] || k));
    if (b.special) for (const k in b.special) parts.push(_fmtStat(k, b.special[k]));
    if (!b.stats && !b.perLevel && !b.pct && !b.special) for (const k in b) if (typeof b[k] === 'number' && b[k]) parts.push(_fmtStat(k, b[k]));
    return parts.join(', ');
  }
  function titleName(idOrName, gender) {
    const t = titleById[idOrName] || TITLES.find(function (x) { return x.name === idOrName || x.fem === idOrName; });
    if (!t) return typeof idOrName === 'string' ? idOrName : '';
    return (gender === 'female' && t.fem) ? t.fem : t.name;
  }

  /* ------------------------------------------------------------------------------------------------
   * Export
   * ---------------------------------------------------------------------------------------------- */
  D.races = RACES;
  D.classes = CLASSES;
  D.raceById = raceById;
  D.classById = classById;
  D.classTraits = CLASS_TRAITS;
  D.traitsFor = traitsFor;
  D.nextTrait = nextTrait;
  D.describeBonus = describeBonus;
  D.titles = TITLES;
  D.titleById = titleById;
  D.titleName = titleName;
  D.randomName = randomName;
  D.randomSurname = randomSurname;
  D.randomFullName = randomFullName;
  D.difficulty = difficulty;
  D.difficultyColor = difficultyColor;
  D.conLabel = conLabel;
  D.DIFFICULTY = DIFF;
  D.startPosFor = function (raceId) { const r = raceById[raceId] || RACES[0]; return { x: r.startPos.x, z: r.startPos.z, town: r.startTown, zone: r.homeZone }; };

  D.stats = {
    STAT_NAMES: STAT_NAMES,
    STAT_KEYS: STAT_KEYS,
    PRIMARY_KEYS: PRIMARY_KEYS,
    RATING_KEYS: RATING_KEYS,
    SPECIAL_KEYS: SPECIAL_KEYS,
    INNATE_ARMOUR: INNATE_ARMOUR,
    compute: compute,
    describe: describe,
    mitigation: mitigation,
    critChance: critChance,
    blockChance: blockChance,
    parryChance: parryChance,
    evadeChance: evadeChance,
    resistChance: resistChance,
    percentages: percentages,
    weaponAvg: weaponAvg,
    preview: preview,
  };

  D.xp = {
    MAX_LEVEL: LEVEL_CAP,
    forLevel: forLevel,
    needFor: needFor,
    levelForXP: levelForXP,
    progress: progress,
    total80: total80,
    questXP: questXP,
    killXP: killXP,
    goldReward: goldReward,
    abilityCost: abilityCost,
    storyLevelPlan: STORY_LEVEL_PLAN,
    storyLevel: storyLevel,
    sideLevel: sideLevel,
    QUEST_TYPE_MULT: QUEST_TYPE_MULT,
  };
})();
