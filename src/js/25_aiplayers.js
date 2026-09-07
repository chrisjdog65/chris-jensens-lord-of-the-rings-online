/* ==== 25_aiplayers.js — G.AIPlayers: 150 simulated players who share Middle-earth with the hero. A two-LOD
   simulation: the whole population is a cheap goal-driven state machine (questing at real spawn groups, travelling
   along the real road graph and dock routes between towns, idling in towns and inns, fishing at real spots, dying
   and returning to rally points, levelling with real XP maths, refreshing gear at level milestones, moving to
   higher zones as they outgrow one, travelling as fellowships); everyone within G.C.AIPLAYER_RENDER_DIST gets a
   real rig (G.Chars.buildHumanoid), physics-driven movement with obstacle avoidance (G.Physics.moveEntity),
   mounts for long legs, REAL combat against nearby monsters through G.Combat (class ability rotations, healers
   healing their fellowship and the hero, retreating to eat when low), emotes toward the hero, fishing animations
   and campfire/inn loitering. A chat scheduler produces LFG / trade / question / joke / role-play / "gz" world chat,
   context-aware "say" lines near the hero, keyword replies to what the hero types, whisper replies and level-up
   congratulations, from a bank of 400+ templates with {zone} {town} {class} {level} {name} {item} … interpolation.

   Public API (SPEC §6.6 + extras used by the P panel, admin, save and HUD):
     init()                       build the population (deterministic from G.rng('aiplayers')) and the road graph; idempotent
     update(dt)                   far tick (all 150 every ~0.5 s, round-robin), near sim, chat scheduler
     list() → [{id, name, fullName, race, cls, gender, level, zone, zoneName, town, state, activity, pos:{x,z}, fellowshipId, online:true}]
     get(id) → entity             byName(name) → entity (case-insensitive, prefix match accepted)
     inspect(id) → {…record, stats, equipment (18 slots), xp, xpNext, xpPct, kills, questsDone, deaths, fish, fellowship:[names],
                    fellowshipName, playTime, title, persona, activity, mounted, morale, power, alive}
     teleportTo(id) → bool        move the hero next to the AI (G.Player.teleport)
     summon(id, pos?) → bool      admin: bring an AI to the hero (or to pos)
     setChatRate(mult)            multiplies the global chat rate (0 silences AI chat; stored in G.state.settings.aiChat)
     levelAll(n) → number         admin: +n levels for everyone (gear/stats/zones follow)
     serialize() → [{id, level, xp, zone, x, z, state, kills, deaths, questsDone, fish, playTime}]   restore(data) → number restored
     stats() → counters           nearPlayer(r) → [entities within r of the hero]
     whisper(name, text) → bool   the named AI answers a whisper (HUD's /w routes here through the 'chat' event too)
     say(idOrName, text, channel?)  admin: make an AI speak      spawnNear(pos?) → entity  admin: summon a random AI
     onDamaged(ent, src, amount)  Combat hook (fight back / wake up)     setScene(scene)
     all (array of entities), fellowships (array), count, chatLog (last 60 lines sent), FELLOWSHIP_NAMES
   Entity extras written here (kind:'aiplayer'): fullName, surname, persona, fellowshipId, kills, questsDone, deaths, fish,
     playTime, activity, zone (home zone id), townId, mounted, mountRig, sailing, chatTimer, ai {state, phase, …}, online.
   Assumptions (all guarded): G.Data.randomName/randomFullName/stats.compute/xp/abilitiesFor/titles, G.Items.generate/bestSet/
     isTwoHanded/get, G.Data.world (zones/towns/roads/docks/spawns/fishingSpots/pois/monsterTypes), G.Terrain.height/isWater/
     zoneAt, G.Physics.moveEntity/groundY/isFree/nearestFree, G.Veg.treesNear, G.Chars.buildHumanoid/buildHorse/updateNameplate,
     G.Combat.useAbility/basicAttack/kill/revive/isHostile, G.Monsters.nearestHostile, G.FX.spawn, G.Audio.sfx, G.UI.chat,
     G.Player.teleport/camera, G.Buildings.all. Scene: setScene(scene) or G.Game.scene (resolved lazily).
   Private helpers (rule 2, prefixed _): _dist2sq/_yawTo (local math), _fmtGold (tiny money formatter for chat). ==== */
(function () {
  'use strict';
  const G = window.G;
  const THREE = window.THREE;
  if (!G) return;
  const AI = {};
  G.AIPlayers = AI;

  // ------------------------------------------------------------------------------------------------ tunables
  const C = G.C || {};
  const POP = 150;
  const FAR_TICK = 0.5;                       // seconds between abstract ticks of one AI
  const RENDER_DIST = C.AIPLAYER_RENDER_DIST > 0 ? C.AIPLAYER_RENDER_DIST : 180;
  const RENDER_DROP = RENDER_DIST + 30;       // hysteresis for rig disposal
  const MAX_RIGS = 25;
  const RIG_BUILDS_PER_FRAME = 2;
  const NAMEPLATE_DIST = 60;
  const NEAR_SIM_DIST = 120;                  // physics + real combat within this distance of the hero
  const RUN_SPEED = C.RUN_SPEED > 0 ? C.RUN_SPEED : 6.5;
  const MOUNT_SPEED = C.MOUNT_SPEED > 0 ? C.MOUNT_SPEED : 15;
  const BOAT_SPEED = 11;
  const MOUNT_MIN_DIST = 100;
  const LEVEL_CAP = C.LEVEL_CAP > 0 ? C.LEVEL_CAP : 80;
  const CHAT_INTERVAL = 25;                   // ≈ one world message per 25 s across the population (× settings.aiChat)
  const SAY_RANGE = 30;
  const WAVE_RANGE = 8;
  const COMBAT_SCAN_RANGE = 30;
  const ENGAGE_LEVEL_SLACK = 5;
  const RETREAT_PCT = 0.25;
  const EAT_TIME = 6;
  const RESPAWN_TIME = 10;
  const FIGHT_TIME = [20, 60];
  const TOWN_TIME = [30, 120];
  const FISH_TIME = [60, 180];
  const NIGHT_START = 22, NIGHT_END = 5;
  const PI = Math.PI, TAU = Math.PI * 2;
  const EQUIP_SLOTS = C.EQUIP_SLOTS || ['head', 'shoulder', 'back', 'chest', 'hands', 'legs', 'feet', 'mainhand', 'offhand', 'ranged', 'neck', 'ear1', 'ear2', 'wrist1', 'wrist2', 'ring1', 'ring2', 'pocket'];
  const NAME_COLOR = '#8cc4ff';               // blue-ish like other players
  const JUMP_VEL = C.JUMP_VEL > 0 ? C.JUMP_VEL : 6.5;

  // ------------------------------------------------------------------------------------------------ helpers
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : (d || 0);
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrapA = (a) => { a = a % TAU; if (a > PI) a -= TAU; else if (a < -PI) a += TAU; return a; };
  const alerp = (a, b, t) => a + wrapA(b - a) * t;
  const now = () => (G.time && typeof G.time.now === 'number') ? G.time.now : 0;
  const dayTime = () => (G.time && typeof G.time.dayTime === 'number') ? ((G.time.dayTime % 24) + 24) % 24 : 12;
  const isNight = () => { const h = dayTime(); return h >= NIGHT_START || h < NIGHT_END; };
  const hasFn = (o, f) => !!(o && typeof o[f] === 'function');
  const report = (e, where) => { if (hasFn(G, 'reportError')) G.reportError(e, 'AIPlayers.' + where); else if (hasFn(G, 'warn')) G.warn('[AIPlayers] ' + where + ': ' + (e && e.message)); };
  const warn = (m) => { if (hasFn(G, 'warn')) G.warn('[AIPlayers] ' + m); };
  const emit = (evt, a, b) => { if (hasFn(G, 'emit')) G.emit(evt, a, b); };
  const world = () => (G.Data && G.Data.world) || null;
  const player = () => (G.state && G.state.player) || null;
  const _dist2sq = (ax, az, bx, bz) => { const dx = bx - ax, dz = bz - az; return dx * dx + dz * dz; };
  const _yawTo = (dx, dz) => Math.atan2(-dx, -dz);        // 0 = facing −Z
  const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
  const pad3 = (n) => (n < 10 ? '00' : n < 100 ? '0' : '') + n;
  function _fmtGold(copper) {
    copper = Math.max(0, Math.round(num(copper, 0)));
    const g = Math.floor(copper / 100000), s = Math.floor((copper % 100000) / 100);
    if (g > 0) return g + 'g' + (s ? ' ' + s + 's' : '');
    if (s > 0) return s + 's';
    return copper + 'c';
  }
  function alive(e) { return !!e && e.alive !== false && e.dead !== true && !e.despawned; }
  function raceOf(id) { const D = G.Data; return (D && D.raceById && D.raceById[id]) || null; }
  function classOf(id) { const D = G.Data; return (D && D.classById && D.classById[id]) || null; }
  function className(id) { const c = classOf(id); return c ? c.name : cap(id || 'adventurer'); }
  function raceName(id) { const r = raceOf(id); return r ? r.name : cap(id || 'wanderer'); }
  function zoneData(id) { const W = world(); if (!W) return null; if (W.zoneById && W.zoneById[id]) return W.zoneById[id]; const zs = W.zones || []; for (let i = 0; i < zs.length; i++) if (zs[i].id === id) return zs[i]; return null; }
  function townData(id) { const W = world(); if (!W) return null; if (W.townById && W.townById[id]) return W.townById[id]; const ts = W.towns || []; for (let i = 0; i < ts.length; i++) if (ts[i].id === id) return ts[i]; return null; }
  function zoneName(id) { const z = zoneData(id); return z ? z.name : cap(id || 'the wild'); }
  function townName(id) { const t = townData(id); return t ? t.name : cap(id || 'town'); }
  function terrainY(x, z) {
    const P = G.Physics, T = G.Terrain;
    if (P && hasFn(P, 'groundY')) { try { return num(P.groundY(x, z), 0); } catch (e) { /* fall through */ } }
    if (T && hasFn(T, 'height')) { try { return Math.max(num(C.SEA_LEVEL, 0), num(T.height(x, z), 0)); } catch (e) { /* fall through */ } }
    return 0;
  }
  function coarseY(x, z) {
    const T = G.Terrain;
    if (T && hasFn(T, 'coarseHeight')) { try { return Math.max(num(C.SEA_LEVEL, 0), num(T.coarseHeight(x, z), 0)); } catch (e) { /* ignore */ } }
    return terrainY(x, z);
  }
  function isWaterAt(x, z) {
    const T = G.Terrain;
    if (T && hasFn(T, 'isWater') && T.ready !== false) { try { return !!T.isWater(x, z); } catch (e) { /* fall through */ } }
    const W = world();
    if (W && hasFn(W, 'isWater')) { try { return !!W.isWater(x, z); } catch (e) { /* ignore */ } }
    return false;
  }
  function zoneAtPos(x, z) {
    const T = G.Terrain;
    if (T && hasFn(T, 'zoneAt')) { try { const id = T.zoneAt(x, z); if (id) return id; } catch (e) { /* fall through */ } }
    const W = world();
    if (W && hasFn(W, 'zoneAt')) { try { return W.zoneAt(x, z) || null; } catch (e) { /* ignore */ } }
    return null;
  }
  function sfx(name, pos, vol) {
    const A = G.Audio; if (!A || !hasFn(A, 'sfx')) return;
    try { A.sfx(name, pos ? { pos: pos, vol: vol == null ? 1 : vol } : { vol: vol == null ? 1 : vol }); } catch (e) { /* ignore */ }
  }
  function fx(kind, pos, opts) {
    const F = G.FX; if (!F || !hasFn(F, 'spawn') || !pos) return null;
    try { return F.spawn(kind, pos, opts || {}); } catch (e) { report(e, 'fx'); return null; }
  }
  function nearHero(x, z, r) { const p = player(); if (!p || !p.pos) return false; return _dist2sq(p.pos.x, p.pos.z, x, z) <= r * r; }

  // ------------------------------------------------------------------------------------------------ RNGs
  const S = hasFn(G, 'rng') ? G.rng('aiplayers-sim') : Math.random;     // runtime decisions (never touches G.rand)
  const sr = (a, b) => a + (b - a) * S();
  const si = (a, b) => a + Math.floor(S() * (b - a + 1));
  const schance = (p) => S() < p;
  const spick = (arr) => (arr && arr.length) ? arr[Math.floor(S() * arr.length) % arr.length] : undefined;

  // ------------------------------------------------------------------------------------------------ population tables
  const RACE_W = { man: 30, elf: 20, hobbit: 15, dwarf: 10, highelf: 7, beorning: 5, dunedain: 4, rohirrim: 4, stoutaxe: 3, riverhobbit: 2 };
  const CLASS_W = { hunter: 16, champion: 14, guardian: 10, minstrel: 10, captain: 9, loremaster: 9, burglar: 8, warden: 8, runekeeper: 9, brawler: 7 };
  const LEVEL_BANDS = [[1, 20, 52], [21, 40, 38], [41, 60, 30], [61, 79, 18], [80, 80, 12]];     // 35 / 25 / 20 / 12 / 8 %
  const STYLES = [['casual', 34], ['roleplay', 12], ['trader', 12], ['helper', 13], ['jokester', 13], ['quiet', 16]];
  const PLAYSTYLES = [['quester', 40], ['grinder', 20], ['explorer', 15], ['social', 15], ['fisher', 10]];
  const RARITY_W = [[55, 35, 10, 0, 0], [35, 40, 20, 5, 0], [22, 40, 26, 10, 2], [10, 35, 35, 15, 5], [0, 20, 35, 30, 15]];
  const RARITIES = C.RARITY || ['common', 'uncommon', 'rare', 'incomparable', 'legendary'];
  const RANGED_CLASSES = { hunter: 1, runekeeper: 1, loremaster: 1, minstrel: 1 };
  const HEALER_CLASSES = { minstrel: 1, captain: 1, runekeeper: 1, loremaster: 1 };
  const HORSE_COLORS = [0x6b4a2e, 0x3a2a1e, 0x8a6a4a, 0xb8a894, 0x2a2420, 0x9a7a5a, 0x5a3a24, 0xd8c8b4];
  const FELLOWSHIP_NAMES = ['The Grey Company', 'Wardens of the Brandywine', 'Bree-land Irregulars', 'The Shirriffs', 'Ered Luin Prospectors',
    'Lanterns of Evendim', 'The Weathertop Watch', 'Rangers of the North', 'Sons of Durin', 'The Withywindle Waders', 'Order of the Silver Leaf',
    'The Forsaken Company', 'Hunters of the Trollshaws', 'Imladris Vanguard', 'The Barrow-breakers', 'Hearth of Sûri-kylä', 'The Angmar Bane',
    'Lossoth Icewalkers', 'Sundered Isles Expedition', 'The Prancing Ponies', 'Mathom-house Society', 'Blades of the Lost Kingdom',
    'The Chetwood Hunt', 'Company of the Hoarwell', 'Himling Reavers', 'The Long Road', 'Ost Guruth Free Company', 'Dúnedain of Esteldín',
    'The Party Tree Revellers', 'Michel Delving Moot'];
  const TOWN_ACTIVITIES = ['Browsing the vendors in {town}', 'Repairing gear in {town}', 'Chatting by the well in {town}', 'Sorting the bags in {town}',
    'Looking for a group in {town}', 'Idling in {town}', 'Checking the mail in {town}', 'Haggling at the market in {town}', 'Waiting for friends in {town}',
    'Training new skills in {town}', 'Visiting the stable-master in {town}', 'Selling loot in {town}', 'Crafting in {town}'];
  const INN_ACTIVITIES = ['Resting at {inn}', 'Drinking at {inn}', 'Singing at {inn}', 'Having a late supper at {inn}', 'Playing dice at {inn}', 'Dozing by the fire at {inn}'];
  const CAMP_ACTIVITIES = ['Sitting at the campfire in {town}', 'Warming up by the fire in {town}', 'Telling stories at the fire in {town}'];
  const EXPLORE_ACTIVITIES = ['Exploring {poi}', 'Sightseeing at {poi}', 'Mapping {poi}', 'Looking for deeds near {poi}'];

  // ------------------------------------------------------------------------------------------------ message bank
  // {zone} {town} {class} {level} {name} {item} {gold} {pzone} {ptown} {pclass} {plevel} {pname} {monster} {spawn} {poi} {race} {fish} {boss} {dungeon} {inn} {othertown} {otherzone} {hour}
  const BANK = {
    lfg: ['LFM {dungeon}, need healer', 'LFM {dungeon}, need a tank and one more dps', 'LF2M {dungeon} run, have healer', 'LFG {zone} quests, lvl {level} {class}',
      'anyone up for {boss}? need 3 more', 'LFM {spawn}, killing {monster}s for the deed', 'lvl {level} {class} LFG, will follow anything', 'LF healer for {dungeon}, we have everything else',
      'need 1 more for {boss}, pst', 'group for {zone} book quests forming at {town}, w me', 'LFM {dungeon} last spot, hurry', 'anyone doing {spawn} quests? inv me', 'LFG {otherzone} instances, {class} {level}',
      'LFM {boss} — full group in 5 if we get a tank', 'LF fellowship for the {zone} deeds, lvl {level}', 'LFM deed run, {monster} slayer, meet at {town}', 'need a lore-master for {dungeon} crowd control',
      'LFG anything really, {class} {level}, bored in {town}', 'LFM {dungeon} hard mode, must know the fights', 'tank LFG {zone}, {level} {class} with real gear', 'grp for {poi} forming, need 2'],
    wts: ['WTS {item} {gold}', 'WTS {item}, pst offers', 'WTS {item} cheap, {gold} obo', 'WTS {item} — great for a {class}', 'WTS stack of {fish} for {gold}', 'WTS {item} lvl {level}, {gold} or best offer',
      'selling {item}, whisper me', 'WTS {item}, {gold}, no lowballs pls', 'WTS crafted {item}, {gold} — mats included', 'WTS {item} and some {monster} hides', 'selling {item} in {town} market right now',
      'WTS {item}, will trade for a {class} weapon', 'WTS {item}! {gold}! last one!', 'WTS 20 x {fish}, fresh from {poi}', 'WTS {item} — {gold} and it is yours', 'WTS {item}, need gold for my mount',
      'WTS {item} lvl {level} {gold}, pst in {town}', 'WTS all my {monster} loot, cheap'],
    wtb: ['WTB {item}, paying {gold}', 'WTB {class} weapon around lvl {level}', 'WTB {fish} stacks, paying well', 'WTB anything with vitality for a {class} lvl {level}', 'WTB {item} or similar, pst',
      'WTB {monster} hides x20', 'WTB a decent cloak for lvl {level}, paying {gold}', 'anyone selling {item}? WTB', 'WTB rare recipes from {zone}', 'WTB {item}, will overpay'],
    question: ['anyone know where the {poi} is?', 'where do I find {monster}s? need 10 for a quest', 'how do I get to {othertown} from {town}?', 'is {boss} up? anyone seen him?',
      'what level should I be for {otherzone}?', 'does anyone know where the stable-master in {town} stands?', 'where is the {dungeon} entrance?', 'best place to fish {fish}?',
      'how do you get across the river near {spawn}?', 'is {item} any good for a {class}?', 'where can I buy bait around {town}?', 'anyone know a good spot for {monster} deeds?',
      'is the boat from {town} free?', 'where does the road from {town} lead?', 'what drops {item}?', 'how many quests are in {zone}? feels endless', 'is {otherzone} worth it at {level}?',
      'anyone got a map of {poi}? lost again', 'why do the {monster}s hit so hard here', 'what time does the {inn} close, in game I mean', 'trainer for {class} in {town}, anyone?',
      'how far is {othertown} from {town} on foot?', 'do wights respawn fast in the barrows?', 'can a {class} solo {boss} at {level}?'],
    joke: ['a hobbit walks into the Prancing Pony… well, walks under the door', 'my {class} is so squishy the {monster}s look at me and I fall over', 'one does not simply walk into {zone}. you take the road',
      'why did the troll cross the Trollshaws? it didn\'t, it was daytime', 'my bags are 200/200 and 199 of them are {fish}', 'second breakfast is the real endgame', 'I asked Tom Bombadil for a quest. he sang at me for ten minutes',
      'my horse runs faster than my internet', 'died to a {monster}. in my defence, there were four of it', 'tried to sell {item} to Barliman. he offered me a beer', 'what do you call a lost dwarf? a Lone-lander',
      'gandalf is late because he hasn\'t finished the {zone} quests either', '{monster}s are just spiders with extra steps', 'if I had a coin for every {monster} I\'ve killed I could buy Bree',
      'my {class} rotation: press 1, panic, press 1 again', 'the Old Forest is fine. the trees are friendly. the trees are always watching', 'took a boat to {othertown}, forgot the boat comes back',
      'the eagles are a fast travel option nobody unlocks', 'they told me {zone} was easy. they lied. they were {level} levels higher', 'auto-run into the Brandywine again. my wet {race} is a legend',
      'weathertop: great view, terrible neighbours', 'rolled a hobbit for the free pipe-weed. still waiting', 'fished for two hours, caught one boot. the boot was rare', 'brawlers punch trolls. that is the whole class'],
    rp: ['Hail, travellers of {zone}! May your blades stay sharp.', 'The road to {othertown} is long, but good company makes it shorter.', 'Well met, friends. Has anyone news from {otherzone}?',
      'Strange lights over {poi} tonight. I do not like it.', 'A {race} of {town} bids you good {hour}.', 'Rest a while at {inn}, the ale is honest and the fire is warm.',
      'Beware the {spawn}: the {monster}s there grow bold.', 'I have walked from {othertown} to {town} and seen no Rangers. Where have they gone?', 'Elbereth guide you, wanderer.',
      'The Enemy stirs in {otherzone}. We must be ready.', 'A song for the road, friends? The {inn} lacks a minstrel tonight.', 'By my beard, {zone} is colder than Thorin\'s Hall in winter.',
      'The Shire seems very far from here. I miss the Green Dragon.', 'Who guards the road to {othertown} these days? Brigands grow thick.', 'I have seen {boss}. Pray you never do.',
      'Rangers of {town}, the {monster}s have returned. Gather at the gate.', 'May the stars shine upon the hour of our meeting, {pname}.'],
    gz: ['gz!', 'grats!', 'gratz {name}', 'nice, gz', 'gz gz', 'congrats!', 'woo gz', 'gz! almost caught up with you', 'grats, {level} already?', 'gz, buy the good gear now', 'nice one, gz',
      'GZ!!', 'gz {name}, well earned', 'grats mate', 'ding gz', 'gz! that was fast'],
    ding: ['Ding! {level}', 'ding {level}!', 'DING {level}', 'level {level}, finally', 'ding! {level} — who said {monster}s were a waste of time', '{level}! new skills time', 'ding {level}, off to {otherzone} soon',
      'ding! {level} {class} reporting', 'level {level}. only {plevel} more to catch {pname}', 'ding {level}!! trainer here I come', 'ding! {level}. that {monster} quest chain paid off', '{level}!'],
    casual: ['lag anyone?', 'that {monster} respawn is brutal', 'love the sunrise over {zone}', 'anyone else stuck on the {spawn} quest?', 'finally got {item} to drop', 'the rain in {zone} never stops',
      'who else is doing {zone} deeds', 'afk 2 min, dog', 'back', 'brb, tea', 'that {boss} fight was intense', 'evening all', 'morning everyone', 'good night {zone}, off to bed',
      'anyone seen {name}? was supposed to meet in {town}', 'off to {othertown}, cya', 'so many players in {town} tonight', 'nice, {item} finally', 'I swear {monster}s hit harder at night',
      'need a coffee before {dungeon}', 'my fellowship left me at {poi} lol', 'is the {inn} always this loud', 'servers feel smooth tonight', 'took the long road from {town}, worth it for the view',
      'just hit {kills} kills on the {monster} deed', 'anyone want to duo {spawn}?', 'love this game', 'hobbits of {town}, hi', 'this {class} at {level} is a lot of fun', 'walking to {othertown}, pray for me',
      'saw {pname} in {pzone} earlier, hi!', 'the mist over {poi} is beautiful right now', '{fish} fishing at {poi} is so relaxing'],
    tip: ['tip: {monster}s are weak to fire, lore-masters rejoice', 'if you are lost, the road from {town} goes straight to {othertown}', 'the stable-master in {town} sells the {othertown} route cheap',
      'always keep a stack of food for fights with {monster}s', 'press M and look for the {poi} marker, it is right there', 'you can fish anywhere near water, but {poi} has the best {fish}',
      '{boss} hits hard: bring a healer or a lot of morale', 'talk to every innkeeper — Rest & Save is free', 'gear from {monster}s is fine until {level}, then hit the vendors', 'auto-loot is on by default, just walk over the bags',
      'the {dungeon} needs a full fellowship, do not try it alone at {level}', 'the best {class} stat is not what you think — check the C panel', 'dodge roll (Q) has i-frames, use it on big swings',
      'the dock in {town} links to the islands, no walking required', 'level titles come at 10, 20, 30… you get one for {level} soon', 'tab targets the nearest enemy, saves a lot of clicking'],
    death: ['died to a {monster} at {spawn}, anyone near {town}?', 'wiped at {spawn}… running back', 'ok {boss} is not a solo fight, lesson learned', 'respawned in {town}, my gear is crying',
      'note to self: do not pull three {monster}s at {level}', 'lol died. rezzing at {town}', 'the {monster}s at {spawn} are not lvl {level} friendly', 'retreated. defeated. embarrassed. {town} here I come'],
    // context-aware "say" lines when the hero is within 30 m
    say_zone: ['{zone} is beautiful this time of year', 'the {monster}s around here are relentless', 'never a quiet day in {zone}', 'you doing the {zone} quests too?', 'careful past {spawn}, it is crawling',
      'the road to {othertown} is that way if you are heading out', 'I always get lost around {poi}', 'good hunting around here, if you like {monster}s', 'lots of us in {zone} tonight', 'is it just me or is {zone} bigger every time',
      'the {inn} is the best thing about {town}', 'quest-givers in {town} keep me busy', 'watch your step near the water here', 'the deeds in {zone} take forever', 'I keep coming back to {zone}, the views',
      'these {monster}s drop nothing but hides', 'heading to {spawn}, want to come?', 'first time in {zone}? it gets better'],
    say_rain: ['this rain won\'t quit', 'soaked to the bone, again', 'rain in {zone}, of course', 'I should have stayed at the {inn}', 'wet cloak, wet boots, wet hobbit', 'the rain makes the {monster}s grumpy'],
    say_snow: ['my toes are ice', 'snow again. I miss the Shire', 'the snow hides the {monster}s, careful', 'cold enough to freeze a dwarf\'s beard', 'beautiful snow, terrible for fishing'],
    say_storm: ['that thunder is right on top of us', 'a storm like this and I am still out here fighting {monster}s', 'lightning over {poi}, do not stand on the hill', 'storm\'s getting worse, {town} soon'],
    say_clear: ['what a clear sky', 'perfect weather for {zone}', 'not a cloud. the {monster}s will see us coming', 'sun on my face, sword in my hand', 'nice day for a ride to {othertown}'],
    say_cloudy: ['grey skies over {zone} again', 'looks like rain later', 'cloudy but dry, I will take it'],
    say_night: ['late night grind', 'can barely see the {monster}s in this dark', 'the {inn} is calling my name', 'night in {zone} gives me the creeps', 'the stars over {zone} are worth the walk', 'should sleep. one more quest'],
    say_dawn: ['up early? me too', 'dawn already, been up all night', 'sunrise over {poi}, look at that'],
    say_dusk: ['sun is going down, {town} soon', 'dusk in {zone} is my favourite', 'one more fight before dark'],
    say_day: ['good hunting weather', 'busy day in {zone}', 'midday and already tired'],
    say_class: ['nice, a {pclass}!', 'a {pclass}! we need one of those', 'oh a {pclass}, rare around here', 'is that a {pclass}? how is it at {plevel}?', '{pclass} lvl {plevel}, not bad', 'a {pclass}. respect',
      'you play {pclass}? I could never', 'hey {pname}, {pclass}s are underrated', 'a {pclass} in {zone}, brave', 'nice gear for a {pclass} lvl {plevel}', '{pname}! love the {pclass} look'],
    say_greet: ['hi {pname}', 'hey there', 'hello!', 'o/', 'hail {pname}', 'greetings, {pclass}', 'well met, {pname}', 'hi! {class} here, need anything?', 'evening', 'hey {pname}, how goes it', 'good {hour}, {pname}'],
    say_wave: ['o/', 'hi {pname}!', '*waves*', 'hey!', 'well met!', 'hail!'],
    say_bow: ['an honour, {pname}', 'lvl {plevel}… wow', 'teach me your ways, {pclass}', 'my lord {pname}', 'one day I will be {plevel} too', 'a legend walks among us'],
    say_camp: ['sit with us', 'the fire is warm, come sit', 'nothing like a fire after {monster}s', 'pull up a log', 'we are just resting before {spawn}', 'the fire keeps the {monster}s away, mostly'],
    say_fish: ['the {fish} are biting today', 'shh, you will scare the {fish}', 'caught three {fish} already', 'fishing beats fighting {monster}s', 'best spot in {zone} for {fish}', 'quiet please, fishing'],
    say_inn: ['the {inn} never sleeps', 'best ale in {zone}', 'the innkeeper knows everything, ask him', 'saving here before {dungeon}', 'rest and save, then back out'],
    say_fight: ['a little help here?', 'these {monster}s again', 'come on, hit back!', 'one more and the deed is done', 'this {monster} is tougher than it looks', 'got this one, thanks', 'need a heal!', 'ha, got you'],
    // replies to the hero
    r_hi: ['hi {pname}!', 'hello!', 'hey {pname}', 'o/ {pname}', 'hail, {pclass}', 'hi there', 'hey! how is {pzone} treating you?', 'greetings {pname}, from {town}', 'hi hi', 'yo', 'well met, {pname}', 'evening {pname}'],
    r_help: ['what do you need help with?', 'ask away, I have been playing since the Shire', 'tip: the {inn} innkeeper lets you rest and save', 'try the M map, it shows quest markers', 'if it is {monster}s, fire damage works wonders',
      'level a bit in {pzone}, then head for {otherzone}', 'press K to train skills, C for gear', 'keep food on the hotbar, saves lives', 'need a hand? I am at {town}', 'what is the problem, {pname}?'],
    r_lfg: ['inv me', 'inv me, {class} {level}', 'I am in! inv', 'sure, what are we doing?', 'invite me, I am near {town}', 'me me, inv', 'I can heal if you need', 'group? inv me, {pname}', 'I will tank, inv', 'coming, invite'],
    r_where: ['{poi} is north of {town}, follow the road', 'check the map, {othertown} is on the road out of {town}', 'the {dungeon}? past {spawn}, cannot miss it', 'try the stable-master in {town}',
      'it is near {poi}, look for the {monster}s', 'follow the road from {town} toward {othertown}', 'east of {town}, past the {spawn}', '{othertown} is a long walk, take a horse', 'the M map has it, press M',
      'past the bridge, then left at {poi}', 'ask at the {inn}, the innkeeper knows', 'not far from {spawn}, careful of the {monster}s'],
    r_quest: ['the {zone} quests start in {town}, talk to anyone with a !', 'that quest is at {poi}', 'quest? the {spawn} chain is quick xp', 'go to {town}, the quest-givers are by the well', 'the story quests take you to {otherzone} next',
      'which quest? the {monster} one is at {spawn}', 'press J for your journal, track it', 'talk to the folk at {town}, they all want something'],
    r_sell: ['WTS {item} if you want, {gold}', 'what are you selling? I have {gold}', 'I buy {fish}, pst', 'vendors in {town} pay better than you think', 'I will buy that {item} for {gold}',
      'selling? meet me in {town}', 'I have {item} for {gold}, interested?', 'always buying {monster} hides', 'gold is tight after that mount, sorry', 'sell junk at the vendor, then we talk'],
    r_thanks: ['np', 'np!', 'no problem', 'anytime', 'np {pname}', 'you are welcome', 'happy to help', 'np, good luck out there'],
    r_gg: ['gg', 'gz!', 'gg wp', 'grats', 'nice one', 'gz {pname}', 'well played', 'gg, that was fun'],
    r_lol: ['lol', 'haha', 'lmao', ':D', 'hahaha', 'lol {pname}', 'made my night', 'rofl', 'that is {zone} for you', 'ha! same'],
    r_bye: ['cya', 'bye {pname}', 'gn!', 'see you in {zone}', 'safe travels', 'take care', 'later', 'good night'],
    r_default: ['yeah', 'true', 'lol', 'hmm', 'agreed', 'I hear you', 'same', 'fair enough', 'right?', 'heh', 'indeed', 'maybe later, fighting {monster}s', 'in a fight, sec', 'hm, maybe'],
    r_whisper: ['hey {pname}, what\'s up?', 'hi! I am at {town} right now', 'yes?', 'hello {pname}, busy with {monster}s but go on', 'sup', 'hey! need something?', 'hi {pname} :)', 'yo, {class} {level} here, what do you need?',
      'sure, what is it?', 'hey. fighting at {spawn}, talk fast :)', 'hello! do I know you from {pzone}?', 'hi {pname}, {town} is lovely tonight'],
    r_whisper_lfg: ['inv me!', 'I am in, invite', 'sure, coming to {town}', 'inv, {class} {level} ready'],
    r_whisper_where: ['{poi} is near {spawn}, follow the road out of {town}', 'take the road from {town} toward {othertown}', 'check M, it is marked'],
    r_whisper_thanks: ['np!', 'anytime {pname}', 'no worries'],
    r_whisper_bye: ['cya {pname}', 'safe travels!', 'later!'],
    ding_reply: ['gz {name}!', 'grats {name}', 'gz!', 'nice {name}', 'gratz', 'gz {name}, {level} already'],
    lfg_reply: ['inv', 'inv me pls', 'I can heal, inv', 'tank here, inv', 'what level?', 'still need one?'],
    q_reply: ['{poi} is just north of {town}', 'follow the road from {town}, you cannot miss it', 'past {spawn}, near the {monster}s', 'ask the stable-master in {town}', 'it is in {otherzone}, take the road east',
      'M map, look for the marker', 'near {poi}, at the top of the hill', 'last I checked {boss} was up', 'no idea, sorry', 'level {level} is fine for it', 'the {dungeon} entrance is by {poi}', 'take the boat from {town}'],
    emote_line: ['*stretches*', '*sits by the fire*', '*waves*', '*bows*', '*dances*', '*cheers*', '*yawns*', '*sharpens blade*'],
  };
  const DUNGEONS = ['Great Barrow', 'Fornost', 'Carn Dûm', 'Goblin-town', 'Annúminas', 'the Barrow-downs', 'Sambrog\'s crypt', 'Weathertop', 'Himring', 'the Rift'];
  const HOUR_WORD = () => { const h = dayTime(); return h < 5 ? 'night' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : h < 22 ? 'evening' : 'night'; };
