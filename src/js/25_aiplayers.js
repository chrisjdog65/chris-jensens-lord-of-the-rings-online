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

  // ------------------------------------------------------------------------------------------------ module state
  let inited = false;
  let scene = null;
  const root = THREE ? new THREE.Group() : null;
  if (root) root.name = 'aiplayers';
  const all = [];                 // every AI entity (index order = id order)
  const byId = {};
  const byNameLower = {};
  const fellowships = [];         // { id, name, leaderId, members: [ids] }
  const fellowshipById = {};
  const counters = { farTicks: 0, nearTicks: 0, rigsBuilt: 0, rigsDisposed: 0, chats: 0, replies: 0, levelUps: 0, kills: 0, deaths: 0, quests: 0, fish: 0, fights: 0, abilities: 0, attacks: 0, heals: 0, emotes: 0, travels: 0, sailings: 0 };
  const chatLog = [];             // last 60 lines {from, channel, text, at}
  let cursor = 0;                 // far-tick round robin
  let scanT = 0;
  let rigCount = 0;
  let frame = 0;
  const nearList = [];            // entities within RENDER_DROP (rebuilt every scan, sorted by distance)
  const rigList = [];             // entities that currently own a rig
  const pending = [];             // scheduled chat lines {at, ent, text, channel, to}
  let nextWorldChat = 0;
  let lastWorldLine = '';
  let lastWorldCat = '';
  let lastWorldFrom = null;
  let lastWorldAt = -1e9;
  let heroLastSeen = -1e9;
  const _v = THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0, set() { return this; } };
  const _v2 = THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0, set() { return this; } };
  const _qbuf = [];
  const _tmp = [];
  const _spot = { x: 0, z: 0, kind: '', name: '' };

  // ------------------------------------------------------------------------------------------------ road / dock graph
  const graph = { nodes: {}, list: [], edges: [] };
  function addNode(id, x, z) {
    let n = graph.nodes[id];
    if (!n) { n = { id: id, x: x, z: z, adj: [] }; graph.nodes[id] = n; graph.list.push(n); }
    return n;
  }
  function polyLen(pts) { let l = 0; for (let i = 1; i < pts.length; i++) l += Math.sqrt(_dist2sq(pts[i - 1].x, pts[i - 1].z, pts[i].x, pts[i].z)); return l; }
  function buildGraph(W) {
    graph.nodes = {}; graph.list.length = 0; graph.edges.length = 0;
    const towns = W.towns || [], roads = W.roads || [], docks = W.docks || [];
    for (let i = 0; i < towns.length; i++) { const t = towns[i]; if (t && t.id && t.pos) addNode(t.id, num(t.pos.x), num(t.pos.z)); }
    for (let i = 0; i < roads.length; i++) {
      const r = roads[i]; if (!r || !r.from || !r.to || !Array.isArray(r.points) || r.points.length < 2) continue;
      const pts = r.points.map((p) => ({ x: num(p.x), z: num(p.z), boat: false }));
      const a = graph.nodes[r.from] || addNode(r.from, pts[0].x, pts[0].z);
      const b = graph.nodes[r.to] || addNode(r.to, pts[pts.length - 1].x, pts[pts.length - 1].z);
      const e = { a: a.id, b: b.id, pts: pts, len: polyLen(pts), boat: false };
      const idx = graph.edges.push(e) - 1;
      a.adj.push(idx); b.adj.push(idx);
    }
    const seen = {};
    for (let i = 0; i < docks.length; i++) {
      const d = docks[i]; if (!d || !d.town || !d.pos || !Array.isArray(d.routes)) continue;
      for (let k = 0; k < d.routes.length; k++) {
        const o = (W.dockById && W.dockById[d.routes[k]]) || docks.find((x) => x && x.id === d.routes[k]);
        if (!o || !o.town || !o.pos || o.town === d.town) continue;
        const key = d.town < o.town ? d.town + '|' + o.town : o.town + '|' + d.town;
        if (seen[key]) continue; seen[key] = true;
        const a = graph.nodes[d.town], b = graph.nodes[o.town]; if (!a || !b) continue;
        const pts = [{ x: a.x, z: a.z, boat: false }, { x: num(d.pos.x), z: num(d.pos.z), boat: false }, { x: num(o.pos.x), z: num(o.pos.z), boat: true }, { x: b.x, z: b.z, boat: false }];
        const e = { a: a.id, b: b.id, pts: pts, len: polyLen(pts) * 1.2 + 60, boat: true };
        const idx = graph.edges.push(e) - 1;
        a.adj.push(idx); b.adj.push(idx);
      }
    }
  }
  function nearestNode(x, z, preferId) {
    if (preferId && graph.nodes[preferId]) { const n = graph.nodes[preferId]; if (_dist2sq(x, z, n.x, n.z) < 200 * 200) return n; }
    let best = null, bd = Infinity;
    for (let i = 0; i < graph.list.length; i++) { const n = graph.list[i]; const d = _dist2sq(x, z, n.x, n.z); if (d < bd) { bd = d; best = n; } }
    return best;
  }
  // Dijkstra over ≤ 30 nodes: returns [{edge, reverse}] or null
  function routeNodes(fromId, toId) {
    if (fromId === toId) return [];
    const dist = {}, prev = {}, done = {};
    const list = graph.list;
    for (let i = 0; i < list.length; i++) dist[list[i].id] = Infinity;
    if (!(fromId in dist) || !(toId in dist)) return null;
    dist[fromId] = 0;
    for (let iter = 0; iter < list.length; iter++) {
      let u = null, ud = Infinity;
      for (let i = 0; i < list.length; i++) { const id = list[i].id; if (!done[id] && dist[id] < ud) { ud = dist[id]; u = id; } }
      if (u === null) break;
      if (u === toId) break;
      done[u] = true;
      const n = graph.nodes[u];
      for (let k = 0; k < n.adj.length; k++) {
        const e = graph.edges[n.adj[k]]; const v = e.a === u ? e.b : e.a;
        const nd = ud + e.len;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = { from: u, edge: e }; }
      }
    }
    if (dist[toId] === Infinity) return null;
    const out = [];
    let cur = toId;
    while (cur !== fromId) { const p = prev[cur]; if (!p) return null; out.push({ edge: p.edge, reverse: p.edge.b !== cur }); cur = p.from; }
    out.reverse();
    return out;
  }
  // Full polyline from a world position to a town: straight leg to the entry node, roads/boats, final leg to the town centre.
  function routeTo(x, z, toTownId, fromTownId) {
    const target = townData(toTownId);
    if (!target || !target.pos) return null;
    const start = nearestNode(x, z, fromTownId);
    const end = graph.nodes[toTownId] || nearestNode(target.pos.x, target.pos.z, null);
    const path = [];
    if (!start || !end) { path.push({ x: num(target.pos.x), z: num(target.pos.z), boat: false }); return path; }
    if (_dist2sq(x, z, start.x, start.z) > 4) path.push({ x: start.x, z: start.z, boat: false });
    const legs = routeNodes(start.id, end.id);
    if (legs) {
      for (let i = 0; i < legs.length; i++) {
        const e = legs[i].edge, pts = e.pts;
        if (!legs[i].reverse) { for (let k = 1; k < pts.length; k++) path.push(pts[k]); }
        else { for (let k = pts.length - 2; k >= 0; k--) path.push({ x: pts[k].x, z: pts[k].z, boat: !!pts[k + 1].boat }); }
      }
    }
    if (_dist2sq(end.x, end.z, target.pos.x, target.pos.z) > 4) path.push({ x: num(target.pos.x), z: num(target.pos.z), boat: false });
    return path;
  }
  function pathRemaining(path, idx, x, z) {
    if (!path || idx >= path.length) return 0;
    let l = Math.sqrt(_dist2sq(x, z, path[idx].x, path[idx].z));
    for (let i = idx + 1; i < path.length; i++) l += Math.sqrt(_dist2sq(path[i - 1].x, path[i - 1].z, path[i].x, path[i].z));
    return l;
  }
  // Walled towns: leave/enter through the gate nearest to the direction of travel.
  function gatesOf(town) {
    if (!town) return null;
    if (town._aiGates !== undefined) return town._aiGates;
    let gates = null;
    if (town.walls || town.id === 'bree') {
      gates = [];
      const R = num(town.wallRadius, num(town.radius, 60) * 0.85);
      if (Array.isArray(town.gates) && town.gates.length) {
        for (let i = 0; i < town.gates.length; i++) { const g = town.gates[i]; const ang = typeof g === 'number' ? g : Math.atan2(num(g.x) - town.pos.x, num(g.z) - town.pos.z); gates.push({ x: town.pos.x + Math.sin(ang) * R, z: town.pos.z + Math.cos(ang) * R }); }
      } else {
        const W = world(); const roads = (W && W.roads) || [];
        for (let i = 0; i < roads.length; i++) {
          const r = roads[i]; if (!r || (r.from !== town.id && r.to !== town.id) || !r.points) continue;
          const pts = r.from === town.id ? r.points : r.points.slice().reverse();
          for (let k = 1; k < pts.length; k++) {
            const a = pts[k - 1], b = pts[k]; const da = Math.sqrt(_dist2sq(a.x, a.z, town.pos.x, town.pos.z)), db = Math.sqrt(_dist2sq(b.x, b.z, town.pos.x, town.pos.z));
            if (da <= R && db >= R) { const t = (R - da) / Math.max(1e-6, db - da); gates.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }); break; }
          }
        }
      }
      if (!gates.length) gates = null;
    }
    town._aiGates = gates;
    return gates;
  }
  function insertGates(path, x, z, townId) {
    const town = townData(townId); const gates = gatesOf(town);
    if (!gates || !path || !path.length) return path;
    const R = num(town.wallRadius, num(town.radius, 60) * 0.85);
    const out = []; let px = x, pz = z;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const inA = _dist2sq(px, pz, town.pos.x, town.pos.z) < R * R, inB = _dist2sq(p.x, p.z, town.pos.x, town.pos.z) < R * R;
      if (inA !== inB && !p.boat) {
        const mx = inA ? p.x : px, mz = inA ? p.z : pz;   // point outside: pick the gate nearest to it
        let g = gates[0], gd = Infinity;
        for (let k = 0; k < gates.length; k++) { const d = _dist2sq(gates[k].x, gates[k].z, mx, mz); if (d < gd) { gd = d; g = gates[k]; } }
        const dx = g.x - town.pos.x, dz = g.z - town.pos.z, l = Math.sqrt(dx * dx + dz * dz) || 1;
        const inner = { x: g.x - dx / l * 7, z: g.z - dz / l * 7, boat: false }, outer = { x: g.x + dx / l * 7, z: g.z + dz / l * 7, boat: false };
        if (inA) { out.push(inner); out.push(outer); } else { out.push(outer); out.push(inner); }
      }
      out.push(p); px = p.x; pz = p.z;
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------------ world lookups
  function zonesForLevel(L) {
    const W = world(); const out = [];
    const zs = (W && W.zones) || [];
    for (let i = 0; i < zs.length; i++) { const z = zs[i]; const lv = z.level || [1, 80]; if (L >= lv[0] && L <= lv[1]) out.push(z); }
    if (!out.length) { let best = null, bd = Infinity; for (let i = 0; i < zs.length; i++) { const z = zs[i]; const lv = z.level || [1, 80]; const d = L < lv[0] ? lv[0] - L : L - lv[1]; if (d < bd) { bd = d; best = z; } } if (best) out.push(best); }
    return out;
  }
  function townsInZone(zoneId) { const W = world(); const ts = (W && W.towns) || []; const out = []; for (let i = 0; i < ts.length; i++) if (ts[i].zone === zoneId) out.push(ts[i]); return out; }
  function pickTown(zoneId, rnd) {
    const ts = townsInZone(zoneId);
    if (!ts.length) { const W = world(); return (W && W.towns && W.towns[0]) || null; }
    return G.weightedPick(ts, (t) => (t.hasInn ? 2.2 : 1) + (t.style === 'ruin' ? -0.4 : 0) + (t.hasStable ? 0.4 : 0) + (t.id === 'bree' ? 1.5 : 0), rnd) || ts[0];
  }
  function spawnsInZone(zoneId) {
    const W = world(); if (!W) return _tmp;
    if (hasFn(W, 'spawnsInZone')) { try { return W.spawnsInZone(zoneId) || []; } catch (e) { /* fall through */ } }
    const out = []; const sp = W.spawns || [];
    for (let i = 0; i < sp.length; i++) { const s = sp[i]; if (s.zone === zoneId || (!s.zone && s.center && zoneAtPos(s.center.x, s.center.z) === zoneId)) out.push(s); }
    return out;
  }
  function monsterType(id) { const W = world(); if (!W) return null; if (W.monsterById && W.monsterById[id]) return W.monsterById[id]; const mt = W.monsterTypes || []; for (let i = 0; i < mt.length; i++) if (mt[i].id === id) return mt[i]; return null; }
  function pickSpawn(zoneId, L) {
    const sp = spawnsInZone(zoneId); if (!sp.length) return null;
    let best = null, n = 0;
    for (let i = 0; i < sp.length; i++) {
      const s = sp[i]; const mt = monsterType(s.type); if (!mt || !s.center) continue;
      const lv = mt.level || [1, 80]; const lo = Array.isArray(lv) ? lv[0] : lv, hi = Array.isArray(lv) ? lv[1] : lv;
      if (hi < L - 7 || lo > L + 4) continue;
      n++; if (schance(1 / n)) best = s;                    // reservoir pick among suitable groups
    }
    return best || spick(sp);
  }
  function spawnName(s) { if (!s) return ''; if (s.name) return s.name; const mt = monsterType(s.type); return mt ? 'the ' + mt.name + ' grounds' : 'the wilds'; }
  function fishSpotsIn(zoneId) { const W = world(); const fs = (W && W.fishingSpots) || []; const out = []; for (let i = 0; i < fs.length; i++) if (fs[i].zone === zoneId && fs[i].pos) out.push(fs[i]); return out; }
  function poisIn(zoneId) { const W = world(); const ps = (W && W.pois) || []; const out = []; for (let i = 0; i < ps.length; i++) if (ps[i].zone === zoneId && ps[i].pos) out.push(ps[i]); return out; }
  function innOf(town) {
    if (!town) return null;
    if (town._aiInn !== undefined) return town._aiInn;
    let inn = null;
    const bl = town.buildings || [];
    for (let i = 0; i < bl.length; i++) if (bl[i] && bl[i].recipe === 'inn') { inn = { x: num(bl[i].x), z: num(bl[i].z), yaw: num(bl[i].yaw), name: bl[i].name || (town.name + ' inn') }; break; }
    town._aiInn = inn;
    return inn;
  }
  function innName(town) { const inn = innOf(town); return inn ? inn.name : (town ? 'the ' + town.name + ' inn' : 'the inn'); }
  function propsOf(town, kind) { const out = []; const ps = (town && town.props) || []; for (let i = 0; i < ps.length; i++) if (ps[i] && ps[i].kind === kind) out.push(ps[i]); return out; }
  // Runtime building lookups (G.Buildings) with data fallbacks
  function buildingsNear(x, z, r, recipe) {
    _tmp.length = 0;
    const B = G.Buildings; const list = (B && Array.isArray(B.all)) ? B.all : null;
    if (!list) return _tmp;
    const r2 = r * r;
    for (let i = 0; i < list.length; i++) { const b = list[i]; if (!b || (recipe && b.recipe !== recipe)) continue; if (_dist2sq(x, z, num(b.x), num(b.z)) <= r2) _tmp.push(b); }
    return _tmp;
  }
  function doorFront(b, dist, out) {
    if (b && b.door && b.door.pos) { const yaw = num(b.door.yaw); out.x = b.door.pos.x - Math.sin(yaw) * dist; out.z = b.door.pos.z - Math.cos(yaw) * dist; return out; }
    return null;
  }
  // A spot in town for a given purpose: 'inn' | 'vendor' | 'well' | 'campfire' | 'market' | 'stable' | 'any'
  function townSpot(town, kind, out) {
    out = out || _spot;
    out.kind = kind; out.name = town ? town.name : '';
    if (!town || !town.pos) { out.x = 0; out.z = 0; return out; }
    const cx = num(town.pos.x), cz = num(town.pos.z), R = Math.max(12, num(town.radius, 40));
    const jitter = () => { const a = S() * TAU, d = sr(1.5, 4); out.x += Math.sin(a) * d; out.z += Math.cos(a) * d; };
    const fromBuilding = (recipe, dataList) => {
      const bl = buildingsNear(cx, cz, R * 1.3, recipe);
      if (bl.length) { const b = spick(bl); if (doorFront(b, sr(2.5, 4.5), out)) { out.name = b.name || out.name; jitter(); return true; } }
      if (dataList && dataList.length) { const d = spick(dataList); const dx = cx - num(d.x), dz = cz - num(d.z), l = Math.sqrt(dx * dx + dz * dz) || 1; out.x = num(d.x) + dx / l * 8; out.z = num(d.z) + dz / l * 8; out.name = d.name || out.name; jitter(); return true; }
      return false;
    };
    const dataBuildings = (recipe) => { const bl = town.buildings || []; const o = []; for (let i = 0; i < bl.length; i++) if (bl[i] && bl[i].recipe === recipe) o.push(bl[i]); return o; };
    const fromProp = (pk) => { const ps = propsOf(town, pk); if (!ps.length) return false; const p = spick(ps); out.x = num(p.x); out.z = num(p.z); const a = S() * TAU, d = sr(2, 3.2); out.x += Math.sin(a) * d; out.z += Math.cos(a) * d; return true; };
    let ok = false;
    switch (kind) {
      case 'inn': ok = fromBuilding('inn', dataBuildings('inn')); if (ok) out.name = innName(town); break;
      case 'vendor': ok = fromBuilding('shop', dataBuildings('shop')) || fromProp('market_stall'); break;
      case 'market': ok = fromProp('market_stall') || fromBuilding('shop', dataBuildings('shop')); break;
      case 'well': ok = fromProp('well'); break;
      case 'campfire': ok = fromProp('campfire'); break;
      case 'stable': ok = fromBuilding('stable', dataBuildings('stable')); break;
      default: ok = false;
    }
    if (!ok) {
      // somewhere on the town square, away from the very centre
      for (let k = 0; k < 6; k++) { const a = S() * TAU, d = sr(R * 0.15, R * 0.5); out.x = cx + Math.sin(a) * d; out.z = cz + Math.cos(a) * d; if (!isWaterAt(out.x, out.z)) break; }
      out.kind = 'square';
    }
    return out;
  }
  function campfireNear(x, z, r) {
    const W = world(); const ts = (W && W.towns) || [];
    for (let i = 0; i < ts.length; i++) { const t = ts[i]; if (!t.pos || _dist2sq(x, z, t.pos.x, t.pos.z) > (num(t.radius, 40) + r) * (num(t.radius, 40) + r)) continue; const ps = propsOf(t, 'campfire'); for (let k = 0; k < ps.length; k++) if (_dist2sq(x, z, ps[k].x, ps[k].z) <= r * r) return ps[k]; }
    return null;
  }
  function rallyOf(town) { if (!town) return { x: 0, z: 0 }; const rp = town.rallyPoint || town.pos; return { x: num(rp.x), z: num(rp.z) }; }

  // ------------------------------------------------------------------------------------------------ gear / stats / abilities
  function armourTypeOf(cls) { const c = classOf(cls); return (c && c.armourType) || 'medium'; }
  function rarityFor(L, rnd) {
    const w = RARITY_W[L < 10 ? 0 : L < 30 ? 1 : L < 60 ? 2 : L < 80 ? 3 : 4];
    let total = 0; for (let i = 0; i < w.length; i++) total += w[i];
    let r = rnd() * total;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r < 0) return RARITIES[i] || 'common'; }
    return 'common';
  }
  function gearTier(L) { return Math.floor(L / 5); }
  function equipFor(e) {
    const eq = {};
    for (let i = 0; i < EQUIP_SLOTS.length; i++) eq[EQUIP_SLOTS[i]] = null;
    const I = G.Items;
    if (!I) { e.equipment = eq; return eq; }
    if (e.lostKingdom && hasFn(I, 'bestSet')) {
      try { const set = I.bestSet(LEVEL_CAP, e.cls) || []; for (let i = 0; i < EQUIP_SLOTS.length; i++) eq[EQUIP_SLOTS[i]] = set[i] || null; e.equipment = eq; e.gearTier = gearTier(e.level); return eq; } catch (err) { report(err, 'bestSet'); }
    }
    if (!hasFn(I, 'generate')) { e.equipment = eq; return eq; }
    const tier = gearTier(e.level);
    const rnd = hasFn(G, 'rng') ? G.rng('ai-gear:' + e.id + ':' + tier) : S;
    const L = e.level, at = armourTypeOf(e.cls);
    const twoHanded = (e.cls === 'champion' || e.cls === 'captain') && rnd() < 0.25;
    for (let i = 0; i < EQUIP_SLOTS.length; i++) {
      const slot = EQUIP_SLOTS[i];
      // low levels have gaps in their kit, like real fresh characters
      if (L < 12 && (slot === 'shoulder' || slot === 'head' || slot === 'ear2' || slot === 'wrist2' || slot === 'ring2' || slot === 'pocket' || slot === 'neck') && rnd() < 0.55) continue;
      if (L < 25 && (slot === 'pocket' || slot === 'ear2') && rnd() < 0.3) continue;
      if (slot === 'offhand' && eq.mainhand && hasFn(I, 'isTwoHanded') && I.isTwoHanded(eq.mainhand)) continue;
      let inst = null;
      try {
        inst = I.generate({ level: L, slot: slot, cls: e.cls, seed: 'ai:' + e.id + ':' + slot + ':' + tier, rarity: rarityFor(L, rnd), armourType: (slot === 'back') ? 'light' : at, noTwoHanded: slot === 'mainhand' ? !twoHanded : true });
      } catch (err) { report(err, 'generate'); inst = null; }
      eq[slot] = inst || null;
    }
    e.equipment = eq; e.gearTier = tier;
    return eq;
  }
  function abilitiesForLevel(cls, L) {
    const set = new Set();
    const D = G.Data; if (!D || !hasFn(D, 'abilitiesFor')) return set;
    let list = []; try { list = D.abilitiesFor(cls) || []; } catch (e) { list = []; }
    for (let i = 0; i < list.length; i++) if (num(list[i].level, 1) <= L) set.add(list[i].id);
    return set;
  }
  function buildRotation(e) {
    const D = G.Data; const rot = { attack: [], heal: [], buff: [], selfHeal: [] };
    e.rotation = rot;
    if (!D || !hasFn(D, 'abilitiesFor')) return rot;
    let list = []; try { list = D.abilitiesFor(e.cls) || []; } catch (err) { list = []; }
    for (let i = 0; i < list.length; i++) {
      const a = list[i]; if (num(a.level, 1) > e.level) continue;
      if (a.kind === 'heal') { if (a.target === 'self') rot.selfHeal.push(a.id); else rot.heal.push(a.id); }
      else if (a.kind === 'buff' || a.kind === 'stance') rot.buff.push(a.id);
      else if (a.target === 'enemy' || a.kind === 'melee' || a.kind === 'ranged' || a.kind === 'tactical' || a.kind === 'aoe' || a.kind === 'debuff' || a.kind === 'taunt') { if (a.target !== 'self' && a.target !== 'party') rot.attack.push(a.id); }
    }
    rot.attack.reverse();      // strongest (highest unlock) first
    return rot;
  }
  function computeStats(e) {
    const D = G.Data;
    if (D && D.stats && hasFn(D.stats, 'compute')) { try { D.stats.compute(e); } catch (err) { report(err, 'stats.compute'); } }
    if (!e.stats || typeof e.stats !== 'object') e.stats = {};
    if (!(e.stats.maxMorale > 0)) e.stats.maxMorale = 100 + e.level * 40;
    if (!(e.stats.maxPower > 0)) e.stats.maxPower = 80 + e.level * 15;
    return e.stats;
  }
  function fullHeal(e) { computeStats(e); e.morale = e.stats.maxMorale; e.power = e.stats.maxPower; }
  function titleFor(e) {
    const D = G.Data; const titles = (D && D.titles) || [];
    if (e.lostKingdom) { for (let i = 0; i < titles.length; i++) if (titles[i].id === 'lord_lost_kingdom') return hasFn(D, 'titleName') ? D.titleName(titles[i].id, e.gender) : titles[i].name; }
    let best = null;
    for (let i = 0; i < titles.length; i++) { const t = titles[i]; if (t.kind !== 'level' || !t.req || !(t.req.level <= e.level)) continue; if (!best || t.req.level > best.req.level) best = t; }
    if (!best) return '';
    return hasFn(D, 'titleName') ? D.titleName(best.id, e.gender) : best.name;
  }
  function xpForLevel(L) { const X = G.Data && G.Data.xp; return (X && hasFn(X, 'forLevel')) ? num(X.forLevel(L), 0) : (L - 1) * 500; }
  function needFor(L) { const X = G.Data && G.Data.xp; return (X && hasFn(X, 'needFor')) ? num(X.needFor(L), 500) : 500; }
  function killXP(mobL, L, mult) { const X = G.Data && G.Data.xp; return (X && hasFn(X, 'killXP')) ? num(X.killXP(mobL, L, mult), 5) : 5; }
  function questXP(L, type) { const X = G.Data && G.Data.xp; return (X && hasFn(X, 'questXP')) ? num(X.questXP(L, type), 100) : 100; }
  function xpPace(L) { return 1 / (1 + L / 40); }     // 1.0 at L1 → 0.5 at L40 → 0.33 at L80 (levels slow down)

  // ------------------------------------------------------------------------------------------------ population
  function uniqueName(race, gender, rng, used) {
    const D = G.Data;
    for (let k = 0; k < 40; k++) {
      let n = hasFn(D, 'randomName') ? D.randomName(race, gender, rng) : ('Wanderer' + Math.floor(rng() * 9999));
      if (!n) continue;
      const key = n.toLowerCase();
      if (!used.has(key)) { used.add(key); return n; }
    }
    let base = hasFn(D, 'randomName') ? D.randomName(race, gender, rng) : 'Wanderer';
    let n = 2; while (used.has((base + n).toLowerCase())) n++;
    used.add((base + n).toLowerCase());
    return base + n;
  }
  function newAiState() {
    return { state: 'town', phase: '', timer: 5, goal: { x: 0, z: 0 }, path: null, pathIdx: 0, spawn: null, spot: null, spotKind: '', fightTarget: null,
      nextScan: 0, nextCast: 0, rot: 0, fightUntil: 0, killsThisFight: 0, hadTarget: false, stuckT: 0, lastX: 0, lastZ: 0, moveT: 0, avoidSide: 1, avoidUntil: 0,
      probeT: 0, probeYaw: 0, sit: false, eatUntil: 0, retreatUntil: 0, travelTo: null, arrive: 'town', inInn: false, innSpot: null, outside: null, explore: null,
      waveT: 0, emoteUntil: 0, fishCastT: 0, abstractT: 0, arriveDist: 2.5, sailFrom: null, lastActivityT: 0, deathAt: 0, nudges: 0, wander: 0 };
  }
  function makeRecord(i, rng, ctx) {
    const race = ctx.race, cls = ctx.cls, L = ctx.level, gender = ctx.gender;
    const rd = raceOf(race);
    const name = uniqueName(race, gender, rng, ctx.used);
    const surname = hasFn(G.Data, 'randomSurname') ? (G.Data.randomSurname(race, rng) || '') : '';
    const style = G.weightedPick(STYLES, (s) => s[1], rng)[0];
    let ps = G.weightedPick(PLAYSTYLES, (s) => s[1] * ((s[0] === 'fisher' && (race === 'hobbit' || race === 'riverhobbit')) ? 2.5 : 1) * ((s[0] === 'social' && cls === 'minstrel') ? 2 : 1) * ((s[0] === 'grinder' && (cls === 'hunter' || cls === 'champion')) ? 1.6 : 1), rng)[0];
    let chatty = Math.pow(rng(), 1.25);
    if (style === 'quiet') chatty *= 0.3; else if (style === 'jokester' || style === 'trader') chatty = Math.max(chatty, 0.45);
    const friendly = clamp(0.2 + 0.8 * rng() + (style === 'helper' ? 0.2 : 0) + (style === 'roleplay' ? 0.1 : 0), 0, 1);
    const e = {
      id: 'ai' + pad3(i + 1), kind: 'aiplayer', name: name, surname: surname, fullName: surname ? name + ' ' + surname : name,
      race: race, gender: gender, cls: cls, level: L, xp: 0, title: '', faction: 'free', hostile: false, online: true,
      pos: THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0 }, vel: THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0 }, yaw: rng() * TAU,
      radius: 0.4, height: 1.8 * (rd ? num(rd.height, 1) : 1), onGround: true, inWater: false, swimming: false,
      stats: {}, morale: 0, power: 0, alive: true, dead: false, deathTime: 0,
      effects: [], cooldowns: {}, target: null, threat: {}, knockback: THREE ? new THREE.Vector3() : { x: 0, y: 0, z: 0 },
      mesh: null, rig: null, anim: 'idle', animTime: 0,
      equipment: {}, abilities: null, rotation: null, lostKingdom: !!ctx.lostKingdom,
      persona: { chatty: chatty, friendly: friendly, style: style, playstyle: ps },
      fellowshipId: null, fellowshipRole: '', formation: 0,
      kills: Math.round(L * L * 2.2 + L * 8 * rng()), questsDone: Math.min(150, Math.round(L * 1.8 + rng() * 3)), deaths: Math.round(L / 7 * (0.4 + rng())),
      fish: ps === 'fisher' ? Math.round(L * 4 + rng() * 40) : Math.round(rng() * L * 0.4), playTime: Math.round(L * L * 40 + rng() * L * 1200 + 600),
      zone: ctx.zone, townId: ctx.townId, activity: '', mounted: false, mountRig: null, sailing: false, inCombat: false,
      chatTimer: sr(20, 200), lastLine: '', lastChatAt: -1e9, lastWave: -1e9, lastBow: -1e9, lastDing: -1e9,
      look: null, gearTier: 0, seed: hasFn(G, 'hashStr') ? G.hashStr('ai:' + name) : i * 7919,
      ai: newAiState(), _lastTick: 0, _d2: Infinity, _near: false, _rank: 999, interact: undefined,
    };
    e.xp = xpForLevel(L) + Math.floor(rng() * needFor(L) * 0.9);
    e.abilities = abilitiesForLevel(cls, L);
    equipFor(e);
    buildRotation(e);
    fullHeal(e);
    e.title = titleFor(e);
    e.chatTimer = sr(20, 200) / Math.max(0.05, chatty);
    return e;
  }
  function placeAt(e, x, z, yaw) {
    e.pos.x = x; e.pos.z = z; e.pos.y = coarseY(x, z);
    if (typeof yaw === 'number') e.yaw = yaw;
    e.vel.x = 0; e.vel.y = 0; e.vel.z = 0;
    e.ai.lastX = x; e.ai.lastZ = z; e.ai.stuckT = 0;
    if (e.rig) { e.pos.y = terrainY(x, z); syncRig(e); }
    if (G.Spatial && hasFn(G.Spatial, 'update')) G.Spatial.update(e);
  }
  function buildPopulation(W) {
    const rng = hasFn(G, 'rng') ? G.rng('aiplayers') : S;
    const races = G.Data.races || [], classes = G.Data.classes || [];
    const raceIds = races.map((r) => r.id), classIds = classes.map((c) => c.id);
    if (!raceIds.length || !classIds.length) return;
    const levels = [];
    for (let b = 0; b < LEVEL_BANDS.length; b++) for (let i = 0; i < LEVEL_BANDS[b][2]; i++) levels.push(rng.int(LEVEL_BANDS[b][0], LEVEL_BANDS[b][1]));
    while (levels.length < POP) levels.push(rng.int(1, 20));
    rng.shuffle(levels);
    const firstRaces = rng.shuffle(raceIds.slice()), firstClasses = rng.shuffle(classIds.slice());
    const used = new Set();
    let lk = 0;
    for (let i = 0; i < POP; i++) {
      const race = i < raceIds.length ? firstRaces[i] : (G.weightedPick(raceIds, (id) => RACE_W[id] || 1, rng) || raceIds[0]);
      const cls = i < classIds.length ? firstClasses[i] : (G.weightedPick(classIds, (id) => CLASS_W[id] || 1, rng) || classIds[0]);
      const gender = rng() < 0.55 ? 'male' : 'female';
      const L = levels[i];
      const rd = raceOf(race);
      const zones = zonesForLevel(L);
      const zone = G.weightedPick(zones, (z) => { const lv = z.level || [1, 80]; const mid = (lv[0] + lv[1]) / 2, span = Math.max(1, (lv[1] - lv[0]) / 2); return 0.4 + (1 - Math.min(1, Math.abs(L - mid) / span)) + (rd && rd.homeZone === z.id ? 3 : 0); }, rng) || zones[0];
      const town = pickTown(zone.id, rng);
      const lostKingdom = L >= LEVEL_CAP && lk < 2; if (lostKingdom) lk++;
      let e;
      try { e = makeRecord(i, rng, { race: race, cls: cls, gender: gender, level: L, zone: zone.id, townId: town ? town.id : null, used: used, lostKingdom: lostKingdom }); }
      catch (err) { report(err, 'makeRecord'); continue; }
      all.push(e); byId[e.id] = e; byNameLower[e.name.toLowerCase()] = e;
    }
    // fellowships: 25 groups of 2–5 with similar levels (consecutive in level order, one group per 6 players)
    const order = all.slice().sort((a, b) => a.level - b.level);
    const stride = Math.max(2, Math.floor(order.length / 25));
    const names = rng.shuffle(FELLOWSHIP_NAMES.slice());
    for (let g = 0; g < 25; g++) {
      const size = rng.int(2, 5), members = [];
      for (let j = 0; j < size; j++) { const m = order[g * stride + j]; if (m && !m.fellowshipId) members.push(m); }
      if (members.length < 2) continue;
      const leader = members[members.length - 1];
      const f = { id: 'f' + (g + 1), name: names[g % names.length], leaderId: leader.id, members: members.map((m) => m.id) };
      fellowships.push(f); fellowshipById[f.id] = f;
      for (let j = 0; j < members.length; j++) { const m = members[j]; m.fellowshipId = f.id; m.fellowshipRole = m === leader ? 'leader' : 'member'; m.formation = j; m.zone = leader.zone; m.townId = leader.townId; }
    }
    // initial placement: on the town square, fellowships together
    for (let i = 0; i < all.length; i++) {
      const e = all[i]; const town = townData(e.townId);
      if (town) { const sp = townSpot(town, spick(['well', 'market', 'vendor', 'inn', 'any']), _spot); placeAt(e, sp.x, sp.z, e.yaw); e.ai.spot = { x: sp.x, z: sp.z }; e.ai.spotKind = sp.kind; }
      else placeAt(e, 0, 0, e.yaw);
      e.ai.timer = sr(5, 60);
      e.activity = fillActivity(e, TOWN_ACTIVITIES);
      if (hasFn(G, 'addEntity')) G.addEntity(e); else if (G.state) { G.state.entities.push(e); G.state.byId[e.id] = e; }
    }
  }

  // ------------------------------------------------------------------------------------------------ progression
  function refreshGear(e) { equipFor(e); computeStats(e); if (e.rig && hasFn(e.rig, 'setEquipment')) { try { e.rig.setEquipment(e.equipment); } catch (err) { report(err, 'rig.setEquipment'); } } }
  function zoneMaxLevel(zoneId) { const z = zoneData(zoneId); return z && z.level ? num(z.level[1], LEVEL_CAP) : LEVEL_CAP; }
  function promoteZone(e) {
    if (e.level <= zoneMaxLevel(e.zone)) return false;
    const zones = zonesForLevel(e.level); if (!zones.length) return false;
    const rd = raceOf(e.race);
    const z = G.weightedPick(zones, (zz) => { const lv = zz.level || [1, 80]; return 0.5 + (e.level - lv[0]) / Math.max(1, lv[1] - lv[0]) + (rd && rd.homeZone === zz.id ? 0.5 : 0); }, S) || zones[0];
    if (z.id === e.zone) return false;
    const town = pickTown(z.id, S);
    e.zone = z.id;
    e.ai.travelTo = town ? town.id : null;
    // fellowship members move with their leader
    if (e.fellowshipRole === 'leader') { const f = fellowshipById[e.fellowshipId]; if (f) for (let i = 0; i < f.members.length; i++) { const m = byId[f.members[i]]; if (m && m !== e) { m.zone = z.id; m.ai.travelTo = e.ai.travelTo; } } }
    return true;
  }
  function levelUp(e, quiet) {
    if (e.level >= LEVEL_CAP) { e.level = LEVEL_CAP; e.xp = Math.max(e.xp, xpForLevel(LEVEL_CAP)); return false; }
    e.level++;
    counters.levelUps++;
    e.abilities = abilitiesForLevel(e.cls, e.level);
    buildRotation(e);
    if (gearTier(e.level) !== e.gearTier || e.level === LEVEL_CAP) refreshGear(e); else computeStats(e);
    e.morale = e.stats.maxMorale; e.power = e.stats.maxPower;
    e.title = titleFor(e) || e.title;
    if (e.rig && e.rig.nameplate) refreshNameplate(e);
    if (e.level >= LEVEL_CAP) e.xp = xpForLevel(LEVEL_CAP);
    const t = now();
    if (!quiet) {
      if (e.pos && nearHero(e.pos.x, e.pos.z, 60)) {
        _v.set(e.pos.x, e.pos.y, e.pos.z); fx('levelup', _v, { scale: 0.9 });
        sfx('level_up', e.pos, 0.45);
      }
      if (e.persona.chatty > 0.35 && schance(e.persona.chatty * 0.9) && t - e.lastDing > 30 && chatEnabled()) {
        e.lastDing = t;
        const line = pickLine(e, 'ding', null);
        schedule(e, line, 'world', sr(0.5, 3));
        followUp('ding_reply', e, sr(2, 7), si(0, 2));
      }
    }
    promoteZone(e);
    emit('aiLevelUp', e);
    return true;
  }
  function addXP(e, n) {
    if (!(n > 0) || e.level >= LEVEL_CAP) return 0;
    e.xp += n;
    let guard = 0;
    while (e.level < LEVEL_CAP && e.xp >= xpForLevel(e.level + 1) && guard++ < 10) levelUp(e, false);
    return n;
  }
