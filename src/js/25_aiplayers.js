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
  const FIGHT_TIME = [30, 75];
  const TOWN_TIME = [20, 75];
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
      const R = num(town.wallRadius, num(town.radius, 60) * 1.05 + 6);
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
    const R = num(town.wallRadius, num(town.radius, 60) * 1.05 + 6);
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
    for (let pass = 0; pass < 2 && !best; pass++) {
      const slack = pass === 0 ? 3 : 7;                     // level-matched groups first, then anything not grey
      for (let i = 0; i < sp.length; i++) {
        const s = sp[i]; const mt = monsterType(s.type); if (!mt || !s.center) continue;
        const lv = mt.level || [1, 80]; const lo = Array.isArray(lv) ? lv[0] : lv, hi = Array.isArray(lv) ? lv[1] : lv;
        if (hi < L - slack || lo > L + 4) continue;
        n++; if (schance(1 / n)) best = s;                  // reservoir pick among suitable groups
      }
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
  function xpPace(L) { return 1.3 / (1 + L / 40); }   // 1.27 at L1 → 0.65 at L40 → 0.43 at L80 (levels slow down)

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

  // ------------------------------------------------------------------------------------------------ far simulation
  function speedOf(e) { return e.sailing ? BOAT_SPEED : e.mounted ? MOUNT_SPEED : RUN_SPEED * (e.stats && e.stats.speed > 0 ? e.stats.speed : 1); }
  function setPath(e, pts, arriveDist) {
    const a = e.ai;
    a.path = pts && pts.length ? pts : null; a.pathIdx = 0; a.arriveDist = arriveDist || 2.5;
    a.stuckT = 0; a.nudges = 0; a.lastX = e.pos.x; a.lastZ = e.pos.z;
    if (a.path) { const last = a.path[a.path.length - 1]; a.goal.x = last.x; a.goal.z = last.z; }
    updateMount(e);
  }
  function walledTowns() {
    const W = world(); if (!W) return _tmp;
    if (W._aiWalled) return W._aiWalled;
    const out = []; const ts = W.towns || [];
    for (let i = 0; i < ts.length; i++) if (ts[i] && ts[i].pos && (ts[i].walls || ts[i].id === 'bree')) out.push(ts[i]);
    W._aiWalled = out;
    return out;
  }
  function withGates(pts, x, z) {
    const wt = walledTowns(); let path = pts;
    for (let i = 0; i < wt.length; i++) path = insertGates(path, x, z, wt[i].id);
    return path;
  }
  function goStraight(e, x, z, arriveDist) { setPath(e, withGates([{ x: x, z: z, boat: false }], e.pos.x, e.pos.z), arriveDist); }
  function landPointNear(x, z, r) {
    for (let k = 0; k < 8; k++) { const a = S() * TAU, d = sr(r * 0.3, r); const px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d; if (!isWaterAt(px, pz)) { _spot.x = px; _spot.z = pz; return _spot; } }
    _spot.x = x; _spot.z = z; return _spot;
  }
  function updateMount(e) {
    const a = e.ai;
    if (e.dead || e.sailing || a.fightTarget || a.sit) { setMounted(e, false); return; }
    const rem = pathRemaining(a.path, a.pathIdx, e.pos.x, e.pos.z);
    if (!e.mounted && rem > MOUNT_MIN_DIST && (a.state === 'travelling' || a.state === 'questing' || a.state === 'exploring' || a.state === 'fishing')) setMounted(e, true);
    else if (e.mounted && (rem < 12 || !a.path)) setMounted(e, false);
  }
  function setMounted(e, on) {
    on = !!on;
    if (e.mounted === on) return;
    e.mounted = on;
    if (e.rig) syncMountRig(e);
    if (on && e.rig && nearHero(e.pos.x, e.pos.z, 40)) { fx('mount_dust', e.pos, { yaw: e.yaw, scale: 0.7 }); sfx('horse_mount', e.pos, 0.5); }
  }
  // Advance along the current path (abstract LOD). Returns true when the path is finished.
  function advancePath(e, dt) {
    const a = e.ai; const path = a.path;
    if (!path) return true;
    if (a.pathIdx >= path.length) { a.path = null; e.sailing = false; return true; }
    if (e._near && !e.sailing && !path[a.pathIdx].boat) return false;   // physics moves it; nearMove() advances pathIdx
    let remaining = speedOf(e) * dt;
    let moved = false;
    while (remaining > 0 && a.pathIdx < path.length) {
      const wp = path[a.pathIdx];
      const boat = !!wp.boat;
      if (boat !== e.sailing) { e.sailing = boat; if (boat) { counters.sailings++; setMounted(e, false); if (e.rig) disposeRig(e); } }
      const dx = wp.x - e.pos.x, dz = wp.z - e.pos.z; const d = Math.sqrt(dx * dx + dz * dz);
      if (d <= remaining) { e.pos.x = wp.x; e.pos.z = wp.z; remaining -= d; a.pathIdx++; }
      else { e.pos.x += dx / d * remaining; e.pos.z += dz / d * remaining; e.yaw = _yawTo(dx, dz); remaining = 0; }
      moved = true;
    }
    if (moved) {
      e.pos.y = e.sailing ? num(C.SEA_LEVEL, 0) : coarseY(e.pos.x, e.pos.z);
      if (G.Spatial && hasFn(G.Spatial, 'update')) G.Spatial.update(e);
    }
    if (a.pathIdx >= path.length) { a.path = null; if (e.sailing) { e.sailing = false; } updateMount(e); return true; }
    if (((frame + a.pathIdx) & 7) === 0) updateMount(e);
    return false;
  }
  function fillActivity(e, list) { return fill(spick(list) || '', e, null); }
  function setActivity(e, text) { e.activity = text; e.ai.lastActivityT = now(); }
  function fellowshipOf(e) { return e && e.fellowshipId ? fellowshipById[e.fellowshipId] : null; }
  function leaderOf(e) { const f = fellowshipOf(e); if (!f) return null; const l = byId[f.leaderId]; return (l && l !== e && l.online !== false) ? l : null; }
  function forEachMember(e, fn) { const f = fellowshipOf(e); if (!f) return; for (let i = 0; i < f.members.length; i++) { const m = byId[f.members[i]]; if (m && m !== e) fn(m); } }

  // ---- state entries
  function enterTown(e, opts) {
    const a = e.ai; opts = opts || {};
    const town = townData(e.townId);
    a.state = 'town'; a.phase = 'walk'; a.fightTarget = null; e.target = null; a.sit = false; a.inInn = false; a.explore = null;
    const night = isNight();
    let kind = 'any';
    if (town) {
      const hasFire = propsOf(town, 'campfire').length > 0, hasInn = !!innOf(town);
      if (night && hasInn && schance(0.7)) kind = 'inn';
      else if (night && hasFire && schance(0.7)) kind = 'campfire';
      else if (opts.turnin) kind = spick(['well', 'vendor', 'market', 'any']);
      else kind = G.weightedPick(['vendor', 'market', 'well', 'campfire', 'stable', 'inn', 'any'], (k) => k === 'campfire' ? (hasFire ? 1.4 : 0) : k === 'inn' ? (hasInn ? 1 : 0) : k === 'stable' ? (town.hasStable ? 0.5 : 0) : k === 'vendor' ? 1.6 : k === 'market' ? 1.1 : k === 'well' ? 1 : 0.8, S) || 'any';
      const sp = townSpot(town, kind, _spot);
      a.spot = { x: sp.x, z: sp.z }; a.spotKind = sp.kind;
      if (_dist2sq(e.pos.x, e.pos.z, sp.x, sp.z) > 2) goStraight(e, sp.x, sp.z, 1.8); else { a.path = null; a.phase = 'idle'; }
      a.inInn = sp.kind === 'inn';
    } else { a.path = null; a.phase = 'idle'; }
    a.timer = opts.timer != null ? opts.timer : sr(TOWN_TIME[0], TOWN_TIME[1]) * (night ? 2.5 : 1) * (e.persona.playstyle === 'social' ? 1.5 : 1) * (opts.turnin ? 0.6 : 1);
    setActivity(e, a.inInn ? fillActivity(e, INN_ACTIVITIES) : a.spotKind === 'campfire' ? fillActivity(e, CAMP_ACTIVITIES) : opts.turnin ? 'Turning in quests in ' + townName(e.townId) : fillActivity(e, TOWN_ACTIVITIES));
    setMounted(e, false);
  }
  function startQuesting(e, grind) {
    const a = e.ai;
    const sp = pickSpawn(e.zone, e.level);
    if (!sp) { enterTown(e, { timer: 20 }); return; }
    a.state = 'questing'; a.phase = 'walk'; a.spawn = sp; a.grind = !!grind; a.killsThisFight = 0;
    const p = landPointNear(num(sp.center.x), num(sp.center.z), Math.max(6, num(sp.radius, 20) * 0.7));
    goStraight(e, p.x, p.z, 4);
    setActivity(e, (grind ? 'Off to grind ' : 'Heading to ') + spawnName(sp));
    counters.fights++;
  }
  function startTravel(e, townId) {
    const a = e.ai; const town = townData(townId);
    if (!town) { enterTown(e, { timer: 15 }); return; }
    a.state = 'travelling'; a.phase = 'walk'; a.travelTo = null; a.arrive = townId;
    let path = routeTo(e.pos.x, e.pos.z, townId, e.townId);
    if (!path) { enterTown(e, { timer: 15 }); return; }
    path = withGates(path, e.pos.x, e.pos.z);
    setPath(e, path, 4);
    setActivity(e, 'Travelling to ' + town.name);
    counters.travels++;
  }
  function startFishing(e) {
    const a = e.ai; const spots = fishSpotsIn(e.zone);
    if (!spots.length) { startQuesting(e, false); return; }
    const spot = spick(spots);
    a.state = 'fishing'; a.phase = 'walk'; a.fishSpot = spot;
    const p = landPointNear(num(spot.pos.x), num(spot.pos.z), Math.max(3, num(spot.radius, 10) * 0.8));
    goStraight(e, p.x, p.z, 2);
    setActivity(e, 'Heading to ' + (spot.name || 'the water') + ' to fish');
  }
  function startExplore(e) {
    const a = e.ai; const pois = poisIn(e.zone);
    const towns = townsInZone(e.zone).filter((t) => t.id !== e.townId);
    if (!pois.length && !towns.length) { startQuesting(e, false); return; }
    if (towns.length && (!pois.length || schance(0.35))) { startTravel(e, spick(towns).id); return; }
    const poi = spick(pois);
    a.state = 'exploring'; a.phase = 'walk'; a.explore = poi;
    const p = landPointNear(num(poi.pos.x), num(poi.pos.z), 8);
    goStraight(e, p.x, p.z, 4);
    setActivity(e, 'Heading to ' + poi.name);
  }
  function chooseNext(e) {
    const a = e.ai;
    if (a.travelTo && a.travelTo !== e.townId) { startTravel(e, a.travelTo); return; }
    a.travelTo = null;
    if (e.level > zoneMaxLevel(e.zone) && promoteZone(e) && a.travelTo) { startTravel(e, a.travelTo); return; }
    if (isNight() && a.state === 'town' && schance(0.4)) { enterTown(e, {}); return; }
    const ps = e.persona.playstyle; const r = S();
    const hasFish = fishSpotsIn(e.zone).length > 0;
    switch (ps) {
      case 'grinder': if (r < 0.8) startQuesting(e, true); else if (r < 0.9) enterTown(e, {}); else startExplore(e); break;
      case 'explorer': if (r < 0.45) startExplore(e); else if (r < 0.85) startQuesting(e, false); else startTravel(e, (spick(townsInZone(e.zone)) || townData(e.townId) || {}).id); break;
      case 'social': if (r < 0.4) enterTown(e, {}); else if (r < 0.75) startQuesting(e, false); else if (r < 0.9) startTravel(e, (spick(townsInZone(e.zone)) || townData(e.townId) || {}).id); else startExplore(e); break;
      case 'fisher': if (r < 0.5 && hasFish) startFishing(e); else if (r < 0.85) startQuesting(e, false); else enterTown(e, {}); break;
      default: if (r < 0.7) startQuesting(e, false); else if (r < 0.8) startExplore(e); else if (r < 0.9 && hasFish) startFishing(e); else enterTown(e, {});
    }
  }
  function returnToTown(e, turnin) {
    const a = e.ai; const town = townData(e.townId);
    a.phase = 'return'; a.turnin = !!turnin; a.fightTarget = null; e.target = null; a.sit = false;
    if (!town) { enterTown(e, {}); return; }
    const sp = townSpot(town, turnin ? 'well' : 'any', _spot);
    goStraight(e, sp.x, sp.z, 3);
    setActivity(e, 'Returning to ' + town.name);
  }
  function arriveTown(e, townId) {
    const town = townData(townId);
    if (town) { e.townId = town.id; const z = town.zone; if (z && (zoneData(z) && e.level >= num(zoneData(z).level[0], 1) - 3)) e.zone = z; }
    forEachMember(e, (m) => { m.townId = e.townId; m.zone = e.zone; });
    enterTown(e, {});
  }

  // ---- abstract combat
  function spawnLevelFor(e, sp) {
    const mt = sp ? monsterType(sp.type) : null; if (!mt) return e.level;
    const lv = mt.level; const lo = Array.isArray(lv) ? num(lv[0], e.level) : num(lv, e.level), hi = Array.isArray(lv) ? num(lv[1], lo) : lo;
    return clamp(e.level, lo, hi);
  }
  function abstractKill(e, mobLevel) {
    e.kills++; counters.kills++;
    addXP(e, killXP(mobLevel, e.level) * xpPace(e.level));
    forEachMember(e, (m) => { if (alive(m) && m.fellowshipRole === 'member') { m.kills++; addXP(m, killXP(mobLevel, m.level) * xpPace(m.level) * 0.8); } });
  }
  function die(e, killer, abstract) {
    if (e.dead) return;
    const a = e.ai;
    e.deaths++; counters.deaths++;
    releaseTarget(e);
    if (abstract || !hasFn(G.Combat, 'kill')) { e.alive = false; e.dead = true; e.deathTime = now(); e.morale = 0; e.target = null; if (e.rig && hasFn(e.rig, 'setAnim')) e.rig.setAnim('death', true); }
    setMounted(e, false);
    a.state = 'dead'; a.phase = ''; a.timer = RESPAWN_TIME; a.path = null; a.sit = false; a.deathAt = now();
    setActivity(e, 'Defeated — retreating to ' + townName(e.townId));
    if (e.persona.chatty > 0.3 && schance(e.persona.chatty * 0.35) && chatEnabled()) schedule(e, pickLine(e, 'death', null), 'world', sr(3, 9));
    emit('aiDeath', e);
  }
  function respawn(e) {
    const a = e.ai; const town = townData(e.townId);
    const rp = rallyOf(town);
    const wasNear = e.pos && nearHero(e.pos.x, e.pos.z, 60);
    if (G.Combat && hasFn(G.Combat, 'revive')) { try { G.Combat.revive(e, 0.5); } catch (err) { report(err, 'revive'); } }
    else { e.alive = true; e.dead = false; e.deathTime = 0; e.target = null; e.casting = null; computeStats(e); e.morale = Math.round(e.stats.maxMorale * 0.5); e.power = Math.round(e.stats.maxPower * 0.5); }
    e.alive = true; e.dead = false;
    if (e.rig && hasFn(e.rig, 'setAnim')) e.rig.setAnim('idle', true);
    if (wasNear) fx('teleport', e.pos, { out: true, scale: 0.7 });
    const p = landPointNear(rp.x, rp.z, 4);
    placeAt(e, p.x, p.z, S() * TAU);
    if (nearHero(e.pos.x, e.pos.z, 60)) fx('teleport', e.pos, { scale: 0.8 });
    a.deathAt = 0;
    enterTown(e, { timer: sr(10, 40) });
    setActivity(e, 'Recovering in ' + townName(e.townId));
  }

  // ---- the tick (leaders & solo players)
  function farTick(e, dt, t) {
    counters.farTicks++;
    const a = e.ai;
    e.playTime += dt;
    if (e.fellowshipRole === 'member') { memberTick(e, dt, t); return; }
    switch (a.state) {
      case 'dead':
        a.timer -= dt;
        if (a.timer <= 0) respawn(e);
        break;
      case 'idle':
        a.timer -= dt;
        if (a.timer <= 0) chooseNext(e);
        break;
      case 'town': {
        if (a.phase === 'walk') { if (advancePath(e, dt)) { a.phase = 'idle'; if (a.spotKind === 'campfire' || a.inInn) a.sit = schance(a.inInn ? 0.7 : 0.8); } }
        a.timer -= dt;
        if (a.timer <= 0) { a.sit = false; chooseNext(e); }
        break;
      }
      case 'questing': {
        if (a.phase === 'walk') {
          if (advancePath(e, dt)) {
            a.phase = 'fight'; a.timer = sr(FIGHT_TIME[0], FIGHT_TIME[1]) * (a.grind ? 1.6 : 1) * (1 + e.level / 100); a.killT = sr(2, 5); a.fightUntil = t + a.timer; a.wander = 0; a.noTargetT = 0;
            setMounted(e, false);
            const mt = a.spawn ? monsterType(a.spawn.type) : null;
            setActivity(e, (a.grind ? 'Grinding ' : 'Fighting ') + (mt ? mt.name + 's' : 'monsters') + ' at ' + spawnName(a.spawn));
          }
        } else if (a.phase === 'fight') {
          a.timer -= dt;
          const mobL = spawnLevelFor(e, a.spawn);
          const real = e._near && (a.fightTarget || a.noTargetT < 8);   // real combat happening (or still looking) nearby
          if (!real) {
            a.killT -= dt;
            if (a.killT <= 0) { a.killT = sr(3.5, 6.5) * (1 + e.level / 80); abstractKill(e, mobL); }
            const risk = 0.0008 * (1 + Math.max(0, mobL - e.level) * 0.5) * (fellowshipOf(e) ? 0.5 : 1) * dt;
            if (S() < risk) { die(e, null, true); break; }
            // shuffle around the camp so distant dots move plausibly
            a.wander -= dt;
            if (a.wander <= 0 && !e._near) { a.wander = sr(4, 9); const p = landPointNear(a.goal.x, a.goal.z, 7); const dx = p.x - e.pos.x, dz = p.z - e.pos.z; const d = Math.sqrt(dx * dx + dz * dz) || 1; const s = Math.min(d, sr(2, 6)); e.pos.x += dx / d * s; e.pos.z += dz / d * s; e.yaw = _yawTo(dx, dz); if (G.Spatial && hasFn(G.Spatial, 'update')) G.Spatial.update(e); }
            if (e.morale < e.stats.maxMorale) e.morale = Math.min(e.stats.maxMorale, e.morale + e.stats.maxMorale * 0.05 * dt);
          }
          if (a.timer <= 0 && !a.fightTarget) { if (a.grind && schance(0.5)) { a.timer = sr(20, 50); } else returnToTown(e, !a.grind); }
        } else if (a.phase === 'return') {
          if (advancePath(e, dt)) {
            if (a.turnin && schance(0.6)) { e.questsDone = Math.min(150, e.questsDone + 1); counters.quests++; addXP(e, questXP(e.level, schance(0.3) ? 'story' : 'side') * 0.6); forEachMember(e, (m) => { if (m.fellowshipRole === 'member') { m.questsDone = Math.min(150, m.questsDone + 1); addXP(m, questXP(m.level, 'side') * 0.5); } }); }
            enterTown(e, { turnin: a.turnin });
          }
        }
        break;
      }
      case 'travelling': {
        if (advancePath(e, dt)) arriveTown(e, a.arrive);
        else if (e.sailing && e.activity.indexOf('Sailing') !== 0) setActivity(e, 'Sailing to ' + townName(a.arrive));
        break;
      }
      case 'fishing': {
        if (a.phase === 'walk') {
          if (advancePath(e, dt)) { a.phase = 'fish'; a.timer = sr(FISH_TIME[0], FISH_TIME[1]); a.fishT = sr(12, 25); setMounted(e, false); faceWater(e); setActivity(e, 'Fishing at ' + ((a.fishSpot && a.fishSpot.name) || 'the water')); }
        } else if (a.phase === 'fish') {
          a.timer -= dt; a.fishT -= dt;
          if (a.fishT <= 0) { a.fishT = sr(12, 28); if (schance(0.6)) { e.fish++; counters.fish++; if (e.rig && hasFn(e.rig, 'setAnim')) { e.rig.setAnim('fish_reel', true); a.fishCastT = t + 1.2; } } }
          if (a.timer <= 0) returnToTown(e, false);
        } else if (a.phase === 'return') { if (advancePath(e, dt)) enterTown(e, {}); }
        break;
      }
      case 'exploring': {
        if (a.phase === 'walk') { if (advancePath(e, dt)) { a.phase = 'look'; a.timer = sr(20, 60); setMounted(e, false); setActivity(e, fill(spick(EXPLORE_ACTIVITIES), e, { poi: a.explore ? a.explore.name : 'the wilds' })); } }
        else { a.timer -= dt; if (a.timer <= 0) { a.explore = null; chooseNext(e); } }
        break;
      }
      default: a.state = 'town'; a.timer = 5;
    }
  }
  function faceWater(e) {
    for (let k = 0; k < 8; k++) { const ang = k / 8 * TAU; const px = e.pos.x + Math.sin(ang) * 4, pz = e.pos.z + Math.cos(ang) * 4; if (isWaterAt(px, pz)) { e.yaw = _yawTo(Math.sin(ang), Math.cos(ang)); return; } }
  }
  const FORMATION = [[0, 0], [-1.6, 1.6], [1.6, 1.6], [0, 3.2], [-3.2, 3.4], [3.2, 3.4]];
  function memberTarget(e, leader, out) {
    const f = FORMATION[Math.min(FORMATION.length - 1, e.formation)] || FORMATION[1];
    const cy = Math.cos(leader.yaw), sy = Math.sin(leader.yaw);
    // leader faces −Z at yaw 0; "behind" is +Z in local space
    out.x = leader.pos.x + f[0] * cy + f[1] * sy;
    out.z = leader.pos.z - f[0] * sy + f[1] * cy;
    return out;
  }
  function memberTick(e, dt, t) {
    const a = e.ai; const leader = leaderOf(e);
    if (!leader) { e.fellowshipRole = 'leader'; farTick(e, dt, t); return; }
    if (a.state === 'dead') { a.timer -= dt; if (a.timer <= 0) respawn(e); return; }
    e.zone = leader.zone; e.townId = leader.townId;
    const la = leader.ai;
    const lstate = la.state === 'dead' ? 'idle' : la.state;
    if (a.state !== lstate) { a.state = lstate; a.phase = la.phase; a.spawn = la.spawn; a.grind = la.grind; a.fishSpot = la.fishSpot; a.explore = la.explore; a.spotKind = la.spotKind; a.inInn = la.inInn; a.sit = la.sit && schance(0.8); }
    else { a.phase = la.phase; if (la.state === 'town' && la.phase === 'idle' && !a.sit && la.sit) a.sit = schance(0.6); if (!la.sit) a.sit = false; }
    e.activity = leader.activity;
    if (!e.sailing && leader.sailing) { if (e.rig) disposeRig(e); }
    e.sailing = leader.sailing;
    if (e.sailing) { e.pos.x = leader.pos.x + sr(-2, 2); e.pos.z = leader.pos.z + sr(-2, 2); e.pos.y = num(C.SEA_LEVEL, 0); if (G.Spatial && hasFn(G.Spatial, 'update')) G.Spatial.update(e); return; }
    if (leader.mounted !== e.mounted && !a.fightTarget && !a.sit) setMounted(e, leader.mounted);
    memberTarget(e, leader, _spot);
    a.goal.x = _spot.x; a.goal.z = _spot.z;
    const d2 = _dist2sq(e.pos.x, e.pos.z, _spot.x, _spot.z);
    if (d2 > 450 * 450 && !e._near && !nearHero(_spot.x, _spot.z, 80)) { placeAt(e, _spot.x, _spot.z, leader.yaw); return; }   // lost far away: catch up off-screen
    if (e._near) { a.followX = _spot.x; a.followZ = _spot.z; a.follow = d2 > 6; if (a.follow) a.followT = t; }
    else if (d2 > 1.5) {
      const d = Math.sqrt(d2); const step = Math.min(d, speedOf(e) * (d > 40 ? 1.6 : 1.15) * dt);
      const dx = (_spot.x - e.pos.x) / d, dz = (_spot.z - e.pos.z) / d;
      e.pos.x += dx * step; e.pos.z += dz * step; e.yaw = _yawTo(dx, dz);
      e.pos.y = coarseY(e.pos.x, e.pos.z);
      if (G.Spatial && hasFn(G.Spatial, 'update')) G.Spatial.update(e);
    } else if (!e._near) e.yaw = alerp(e.yaw, leader.yaw, 0.5);
    // abstract fights: members recover morale; real ones are handled by the near sim; small death risk when the leader fights
    if (la.state === 'questing' && la.phase === 'fight' && !e._near) {
      if (e.morale < e.stats.maxMorale) e.morale = Math.min(e.stats.maxMorale, e.morale + e.stats.maxMorale * 0.05 * dt);
      if (S() < 0.0003 * dt) die(e, null, true);
    }
  }

  // ------------------------------------------------------------------------------------------------ near simulation: rigs
  function ensureScene() {
    if (!root) return null;
    if (scene && root.parent === scene) return scene;
    const sc = scene || (G.Game && G.Game.scene) || (G.Buildings && G.Buildings.scene) || null;
    if (sc && sc.isScene) { scene = sc; if (root.parent !== sc) sc.add(root); return sc; }
    return null;
  }
  function cameraOf() { const P = G.Player; return (P && P.camera && P.camera.isCamera) ? P.camera : null; }
  function lookFor(e) {
    if (e.look) return e.look;
    const r = hasFn(G, 'rng') ? G.rng('ai-look:' + e.id) : S;
    const rd = raceOf(e.race);
    const skins = (rd && rd.skinTones && rd.skinTones.length) ? rd.skinTones : null, hairs = (rd && rd.hairColors && rd.hairColors.length) ? rd.hairColors : null;
    e.look = { skin: skins ? skins[Math.floor(r() * skins.length) % skins.length] : undefined, hairColor: hairs ? hairs[Math.floor(r() * hairs.length) % hairs.length] : undefined, hairStyle: Math.floor(r() * 5) };
    if (e.gender === 'male' && (e.race === 'dwarf' || e.race === 'stoutaxe' || r() < 0.35)) e.look.beard = 1 + Math.floor(r() * 2);
    return e.look;
  }
  function plateSub(e) { return 'Level ' + e.level + ' ' + className(e.cls); }
  function buildRig(e) {
    if (e.rig || !G.Chars || !hasFn(G.Chars, 'buildHumanoid') || !root) return false;
    const look = lookFor(e);
    const spec = { race: e.race, gender: e.gender, cls: e.cls, name: e.name, level: e.level, title: plateSub(e), nameplate: true, nameColor: NAME_COLOR,
      skin: look.skin, hairColor: look.hairColor, hairStyle: look.hairStyle, beard: look.beard, equipment: e.equipment, armourType: armourTypeOf(e.cls) };
    let rig = null;
    try { rig = G.Chars.buildHumanoid(spec); } catch (err) { report(err, 'buildHumanoid'); rig = null; }
    if (!rig || !rig.group) return false;
    e.rig = rig; e.mesh = rig.group;
    if (rig.height > 0) e.height = rig.height;
    rig.group.name = 'ai_' + e.id;
    root.add(rig.group);
    e.pos.y = e.sailing ? num(C.SEA_LEVEL, 0) : terrainY(e.pos.x, e.pos.z);
    e.onGround = true;
    syncRig(e);
    if (e.dead) { if (hasFn(rig, 'setAnim')) rig.setAnim('death', true); }
    else if (e.ai.sit && hasFn(rig, 'setAnim')) rig.setAnim(e.ai.dance ? 'emote_dance' : 'sit', true);
    if (e.mounted) syncMountRig(e);
    rigList.push(e); rigCount++; counters.rigsBuilt++;
    ensureScene();
    return true;
  }
  function refreshNameplate(e) {
    const rig = e.rig; if (!rig || !G.Chars || !hasFn(G.Chars, 'nameplate')) return;
    try {
      if (rig.nameplate) { if (hasFn(G.Chars, 'releaseNameplate')) G.Chars.releaseNameplate(rig.nameplate); else if (rig.nameplate.parent) rig.nameplate.parent.remove(rig.nameplate); }
      const np = G.Chars.nameplate(e.name, NAME_COLOR, { sub: plateSub(e) });
      if (np) { np.position.y = (rig.height || e.height) + 0.12; rig.group.add(np); rig.nameplate = np; }
    } catch (err) { report(err, 'nameplate'); }
  }
  function disposeRig(e) {
    const rig = e.rig; if (!rig) return;
    detachFromMount(e);
    try { if (hasFn(rig, 'dispose')) rig.dispose(); } catch (err) { report(err, 'rig.dispose'); }
    if (rig.group && rig.group.parent) rig.group.parent.remove(rig.group);
    if (e.mountRig) { const h = e.mountRig; try { if (h.group && h.group.parent) h.group.parent.remove(h.group); if (hasFn(h, 'dispose')) h.dispose(); } catch (err) { report(err, 'horse.dispose'); } e.mountRig = null; }
    e.rig = null; e.mesh = null;
    const i = rigList.indexOf(e); if (i >= 0) rigList.splice(i, 1);
    rigCount--; counters.rigsDisposed++;
  }
  function ensureHorse(e) {
    if (e.mountRig) return e.mountRig;
    if (!G.Chars || !hasFn(G.Chars, 'buildHorse')) return null;
    let h = null;
    try { h = G.Chars.buildHorse(HORSE_COLORS[(e.seed >>> 0) % HORSE_COLORS.length]); } catch (err) { h = null; }
    if (!h || !h.group) return null;
    h.group.name = 'ai_horse_' + e.id;
    e.mountRig = h;
    return h;
  }
  function detachFromMount(e) {
    const rig = e.rig, h = e.mountRig;
    if (rig && rig.group && rig.group.parent && rig.group.parent !== root) { rig.group.parent.remove(rig.group); if (root) root.add(rig.group); rig.group.position.set(e.pos.x, e.pos.y, e.pos.z); rig.group.rotation.set(0, e.yaw, 0); rig.group.scale.set(1, 1, 1); }
    if (rig && hasFn(rig, 'setMounted')) rig.setMounted(false);
    if (h && h.group && h.group.parent) h.group.parent.remove(h.group);
  }
  function syncMountRig(e) {
    const rig = e.rig; if (!rig) return;
    if (e.mounted) {
      const h = ensureHorse(e); if (!h) return;
      const seat = (h.parts && h.parts.saddle) ? h.parts.saddle : h.group;
      if (rig.group.parent !== seat) { if (rig.group.parent) rig.group.parent.remove(rig.group); seat.add(rig.group); rig.group.position.set(0, 0, 0); rig.group.rotation.set(0, 0, 0); rig.group.scale.set(1, 1, 1); }
      if (hasFn(rig, 'setMounted')) rig.setMounted(true);
      if (hasFn(rig, 'setAnim')) rig.setAnim('ride', true);
      if (root && h.group.parent !== root) root.add(h.group);
      h.group.position.copy(e.pos); h.group.rotation.y = e.yaw;
      if (hasFn(h, 'setAnim')) h.setAnim('idle', true);
    } else {
      detachFromMount(e);
      if (hasFn(rig, 'setAnim')) rig.setAnim('idle', true);
    }
  }
  function syncRig(e) {
    const rig = e.rig; if (!rig) return;
    if (e.mounted && e.mountRig && rig.group.parent !== root) { const h = e.mountRig; h.group.position.copy(e.pos); h.group.rotation.y = e.yaw; }
    else { rig.group.position.copy(e.pos); rig.group.rotation.y = e.yaw; }
  }
  const _aiFilter = (x) => x.kind === 'aiplayer' && x.online !== false;
  function scanNear(px, pz) {
    for (let i = 0; i < nearList.length; i++) nearList[i]._wasNear = nearList[i]._near;
    nearList.length = 0;
    const SP = G.Spatial; if (!SP || !hasFn(SP, 'query')) return;
    let q; try { q = SP.query(px, pz, RENDER_DROP, _aiFilter, _qbuf); } catch (err) { report(err, 'Spatial.query'); return; }
    for (let i = 0; i < q.length; i++) { const e = q[i]; e._d2 = _dist2sq(px, pz, e.pos.x, e.pos.z); nearList.push(e); }
    nearList.sort((a, b) => a._d2 - b._d2);
    const near2 = NEAR_SIM_DIST * NEAR_SIM_DIST;
    for (let i = 0; i < nearList.length; i++) {
      const e = nearList[i]; e._rank = i;
      const near = !e.sailing && (e._d2 < near2 || !!e.rig);
      if (near && !e._near) { e.pos.y = terrainY(e.pos.x, e.pos.z); e.onGround = true; e.vel.x = 0; e.vel.y = 0; e.vel.z = 0; e.ai.lastX = e.pos.x; e.ai.lastZ = e.pos.z; e.ai.stuckT = 0; }
      e._near = near;
    }
    // entities that fell out of the query are no longer near
    for (let i = 0; i < all.length; i++) { const e = all[i]; if (e._near && e._rank >= nearList.length) e._near = false; if (nearList.indexOf(e) < 0) { e._near = false; e._rank = 999; e._d2 = Infinity; } }
  }
  function rigBudget() {
    if (!root || !ensureScene()) return;
    const drop2 = RENDER_DROP * RENDER_DROP, keep2 = RENDER_DIST * RENDER_DIST;
    for (let i = rigList.length - 1; i >= 0; i--) { const e = rigList[i]; if (e._d2 > drop2 || e._rank >= MAX_RIGS + 4 || e.sailing) disposeRig(e); }
    let built = 0;
    for (let i = 0; i < nearList.length && i < MAX_RIGS && built < RIG_BUILDS_PER_FRAME; i++) {
      const e = nearList[i];
      if (e.rig || e.sailing || e._d2 > keep2 || rigCount >= MAX_RIGS) continue;
      if (buildRig(e)) built++;
    }
  }

  // ------------------------------------------------------------------------------------------------ near simulation: combat
  function releaseTarget(e) {
    const a = e.ai; const m = a.fightTarget;
    if (m && m.engagedBy === e.id) m.engagedBy = null;
    a.fightTarget = null; a.defend = false; e.target = null; e.inCombat = false;
  }
  function sameFellowship(e, id) { if (!id || !e.fellowshipId) return false; const o = byId[id]; return !!(o && o.fellowshipId === e.fellowshipId); }
  let _scanFor = null;
  const _targetFilter = function (m) {
    const e = _scanFor; if (!e || !m || m.dead || m.alive === false || m.despawned || m.leashing || m.invulnerable) return false;
    if (m.boss && e.level < 60) return false;
    const lv = num(m.level, 1); const diff = lv - e.level;
    if (diff > ENGAGE_LEVEL_SLACK || diff < -(ENGAGE_LEVEL_SLACK + 3)) return false;
    if (m.engagedBy && m.engagedBy !== e.id && !sameFellowship(e, m.engagedBy)) return false;
    return true;
  };
  function findTarget(e) {
    const M = G.Monsters; _scanFor = e; let m = null;
    try {
      if (M && hasFn(M, 'nearestHostile')) m = M.nearestHostile(e.pos, COMBAT_SCAN_RANGE, _targetFilter);
      else if (G.Combat && hasFn(G.Combat, 'nearestHostile')) { m = G.Combat.nearestHostile(e, COMBAT_SCAN_RANGE); if (m && !_targetFilter(m)) m = null; }
    } catch (err) { report(err, 'findTarget'); m = null; }
    _scanFor = null;
    return m;
  }
  function engage(e, m, defend) {
    const a = e.ai;
    if (!m || m === a.fightTarget) return;
    if (a.fightTarget) releaseTarget(e);
    a.fightTarget = m; e.target = m; a.defend = !!defend; a.noTargetT = 0; a.sit = false; a.dance = false; a.eatUntil = 0; e.inCombat = true;
    if (!m.engagedBy) m.engagedBy = e.id;
    setMounted(e, false);
    if (e.rig && hasFn(e.rig, 'setAnim') && e.rig.state) e.rig.setAnim('idle', true);
    counters.fights++;
    // open with a buff/stance now and then
    const rot = e.rotation; const CB = G.Combat;
    if (rot && rot.buff.length && CB && hasFn(CB, 'useAbility') && schance(0.5)) { try { if (CB.useAbility(e, spick(rot.buff), e)) counters.abilities++; } catch (err) { report(err, 'buff'); } }
    // fellowship members nearby join in
    forEachMember(e, (o) => { if (o._near && alive(o) && !o.ai.fightTarget && _dist2sq(o.pos.x, o.pos.z, m.pos.x, m.pos.z) < 40 * 40) { o.ai.fightTarget = m; o.target = m; o.ai.defend = true; o.inCombat = true; setMounted(o, false); } });
  }
  function tryHeal(e, t) {
    const rot = e.rotation; const CB = G.Combat; if (!rot || !CB || !hasFn(CB, 'useAbility')) return false;
    if (!rot.heal.length && !rot.selfHeal.length) return false;
    const maxM = num(e.stats.maxMorale, 1);
    let target = null;
    if (e.morale < maxM * 0.55) target = e;
    if (!target) {
      let worst = 0.6;
      forEachMember(e, (o) => { if (alive(o) && o.stats && _dist2sq(e.pos.x, e.pos.z, o.pos.x, o.pos.z) < 30 * 30) { const f = o.morale / Math.max(1, o.stats.maxMorale); if (f < worst) { worst = f; target = o; } } });
      const p = player();
      if (!target && p && alive(p) && p.stats && e.persona.friendly >= 0.5 && _dist2sq(e.pos.x, e.pos.z, p.pos.x, p.pos.z) < 25 * 25 && p.morale / Math.max(1, p.stats.maxMorale) < 0.5) target = p;
    }
    if (!target) return false;
    const list = (target === e && rot.selfHeal.length) ? rot.selfHeal : rot.heal.length ? rot.heal : rot.selfHeal;
    for (let i = 0; i < list.length; i++) {
      let ok = false; try { ok = CB.useAbility(e, list[i], target); } catch (err) { report(err, 'heal'); }
      if (ok) { counters.heals++; return true; }
    }
    return false;
  }
  function tryAttack(e, m) {
    const rot = e.rotation; const CB = G.Combat; if (!CB) return false;
    const a = e.ai;
    if (rot && rot.attack.length && hasFn(CB, 'useAbility')) {
      const n = rot.attack.length;
      for (let k = 0; k < n; k++) {
        const id = rot.attack[(a.rot + k) % n];
        let ok = false; try { ok = CB.useAbility(e, id, m); } catch (err) { report(err, 'useAbility'); ok = false; }
        if (ok) { a.rot = (a.rot + k + 1) % n; counters.abilities++; return true; }
      }
    }
    if (hasFn(CB, 'basicAttack')) { let ok = false; try { ok = CB.basicAttack(e, m); } catch (err) { report(err, 'basicAttack'); } if (ok) counters.attacks++; return ok; }
    return false;
  }
  function combatStep(e, dt, t) {
    const a = e.ai;
    if (e.dead || !G.Combat) return;
    if (a.eatUntil > t) { e.morale = Math.min(e.stats.maxMorale, e.morale + e.stats.maxMorale * 0.14 * dt); e.power = Math.min(e.stats.maxPower, e.power + e.stats.maxPower * 0.1 * dt); return; }
    if (a.eating) { a.eating = false; a.sit = false; if (e.rig && hasFn(e.rig, 'setAnim')) e.rig.setAnim('idle', true); setActivity(e, a.state === 'questing' ? 'Fighting at ' + spawnName(a.spawn) : e.activity); }
    if (a.retreatUntil > t) return;
    let m = a.fightTarget;
    if (m && (!alive(m) || m.despawned || m.leashing || _dist2sq(e.pos.x, e.pos.z, m.pos.x, m.pos.z) > 70 * 70)) { releaseTarget(e); m = null; }
    if (!m) {
      const wants = (a.state === 'questing' && a.phase === 'fight') || (a.state === 'idle' && a.defend);
      if (wants && t >= a.nextScan) { a.nextScan = t + 0.5; m = findTarget(e); if (m) engage(e, m, false); else a.noTargetT += 0.5; }
      if (!m) return;
    }
    if (e.morale < e.stats.maxMorale * RETREAT_PCT && t - a.lastRetreat > 25) {
      a.lastRetreat = t; a.retreatUntil = t + 2.5; a.threatX = m.pos.x; a.threatZ = m.pos.z; a.eatAfter = true;
      releaseTarget(e); setActivity(e, 'Retreating from ' + (m.name || 'a foe'));
      if (e.persona.chatty > 0.5 && nearHero(e.pos.x, e.pos.z, SAY_RANGE) && schance(0.4) && chatEnabled()) schedule(e, pickLine(e, 'say_fight', null), 'say', sr(0.2, 1));
      return;
    }
    if (t < a.nextCast) return;
    a.nextCast = t + 0.35;
    if (tryHeal(e, t)) return;
    const range = RANGED_CLASSES[e.cls] ? 20 : 2.4;
    const d = Math.sqrt(_dist2sq(e.pos.x, e.pos.z, m.pos.x, m.pos.z)) - num(m.radius, 0.5) - e.radius;
    if (d > range + 0.3) return;
    tryAttack(e, m);
  }
  function onDamaged(dst, src, amount) {
    if (!dst || dst.kind !== 'aiplayer' || dst.dead) return;
    const a = dst.ai;
    if (!src || src === dst || !alive(src) || src.kind !== 'monster') return;
    a.sit = false; a.dance = false; a.eatUntil = 0; a.eating = false;
    if (dst.rig && hasFn(dst.rig, 'setAnim') && dst.rig.state && dst.rig.state !== 'ride') dst.rig.setAnim('idle', true);
    if (!a.fightTarget) engage(dst, src, true);
  }
  function onEntityKilled(ev) {
    if (!ev || !ev.victim) return;
    const v = ev.victim, k = ev.killer;
    if (v.kind === 'aiplayer' && byId[v.id] === v) { die(v, k || null, false); return; }
    if (v.kind === 'monster') {
      // whoever was fighting it lets go; the killer (or the AI that had it engaged) gets the credit
      let credit = (k && k.kind === 'aiplayer' && byId[k.id]) ? k : ((v.engagedBy && byId[v.engagedBy]) || null);
      for (let i = 0; i < nearList.length; i++) { const e = nearList[i]; if (e.ai.fightTarget === v) { e.ai.killsThisFight++; releaseTarget(e); e.ai.nextScan = now() + sr(0.6, 1.6); } }
      if (credit && !credit.dead) {
        credit.kills++; counters.kills++;
        addXP(credit, killXP(num(v.level, credit.level), credit.level, num(v.xpMult, 1)));
        forEachMember(credit, (o) => { if (alive(o) && _dist2sq(o.pos.x, o.pos.z, v.pos.x, v.pos.z) < 60 * 60) { o.kills++; addXP(o, killXP(num(v.level, o.level), o.level, num(v.xpMult, 1)) * 0.7); } });
        if (credit.persona.chatty > 0.6 && nearHero(credit.pos.x, credit.pos.z, SAY_RANGE) && schance(0.12) && chatEnabled()) schedule(credit, pickLine(credit, 'say_fight', null), 'say', sr(0.5, 2));
      }
      if (v.engagedBy && byId[v.engagedBy]) v.engagedBy = null;
    }
  }

  // ------------------------------------------------------------------------------------------------ near simulation: movement & animation
  function probeBlocked(e, x, z) {
    const P = G.Physics;
    if (P && hasFn(P, 'isFree')) { try { if (!P.isFree(x, z, 0.45)) return true; } catch (err) { /* ignore */ } }
    else if (isWaterAt(x, z)) return true;
    const V = G.Veg;
    if (V && hasFn(V, 'treesNear')) { try { const tr = V.treesNear(x, z, 0.9); if (tr.length) return true; } catch (err) { /* ignore */ } }
    const p = player();
    if (p && p.pos && _dist2sq(p.pos.x, p.pos.z, x, z) < 1.4 * 1.4) return true;
    return false;
  }
  function steer(e, dx, dz, t, out) {
    const a = e.ai;
    if (a.avoidUntil > t) { const c = Math.cos(a.avoidAng), s = Math.sin(a.avoidAng); out.x = dx * c - dz * s; out.z = dx * s + dz * c; return out; }
    out.x = dx; out.z = dz;
    if (t < a.probeT) return out;
    a.probeT = t + 0.15;
    const px = e.pos.x + dx * 2.2, pz = e.pos.z + dz * 2.2;
    if (!probeBlocked(e, px, pz)) return out;
    const angs = [a.avoidSide * 0.95, -a.avoidSide * 0.95, a.avoidSide * 1.9, -a.avoidSide * 1.9];
    for (let i = 0; i < angs.length; i++) {
      const c = Math.cos(angs[i]), s = Math.sin(angs[i]); const rx = dx * c - dz * s, rz = dx * s + dz * c;
      if (!probeBlocked(e, e.pos.x + rx * 2.2, e.pos.z + rz * 2.2)) { a.avoidAng = angs[i]; a.avoidUntil = t + 0.7; out.x = rx; out.z = rz; return out; }
    }
    a.avoidSide = -a.avoidSide;
    return out;
  }
  function nudge(e, dx, dz) {
    const P = G.Physics; let nx = e.pos.x + dx * 4, nz = e.pos.z + dz * 4;
    if (P && hasFn(P, 'nearestFree')) { try { const f = P.nearestFree(nx, nz, 0.4); if (f) { nx = f.x; nz = f.z; } } catch (err) { /* ignore */ } }
    placeAt(e, nx, nz, e.yaw);
    e.pos.y = terrainY(nx, nz);
    e.ai.nudges++;
  }
  function nearMove(e, dt, t) {
    const a = e.ai;
    let tx = 0, tz = 0, speed = 0, want = false;
    const p = player();
    if (e.dead) { want = false; }
    else if (a.retreatUntil > t) {
      const dx = e.pos.x - num(a.threatX, e.pos.x), dz = e.pos.z - num(a.threatZ, e.pos.z); const d = Math.sqrt(dx * dx + dz * dz) || 1;
      tx = e.pos.x + dx / d * 12; tz = e.pos.z + dz / d * 12; speed = RUN_SPEED; want = true;
      if (a.retreatUntil - t < dt * 1.5 && a.eatAfter) { a.eatAfter = false; a.eatUntil = t + EAT_TIME; a.eating = true; a.sit = true; a.dance = false; setActivity(e, 'Catching breath after a fight'); if (e.rig && hasFn(e.rig, 'setAnim')) e.rig.setAnim('sit', true); }
    }
    else if (a.eatUntil > t || (a.sit && !a.fightTarget) || a.emoteUntil > t) { want = false; }
    else if (a.fightTarget) {
      const m = a.fightTarget; const range = RANGED_CLASSES[e.cls] ? 18 : 2.2;
      const d = Math.sqrt(_dist2sq(e.pos.x, e.pos.z, m.pos.x, m.pos.z)) - num(m.radius, 0.5) - e.radius;
      if (d > range) { tx = m.pos.x; tz = m.pos.z; speed = RUN_SPEED; want = true; }
    }
    else if (a.follow) {
      const d = Math.sqrt(_dist2sq(e.pos.x, e.pos.z, a.followX, a.followZ));
      if (d > 2) { tx = a.followX; tz = a.followZ; speed = (e.mounted ? MOUNT_SPEED : RUN_SPEED) * (d > 12 ? 1.25 : 1); want = true; } else a.follow = false;
    }
    else if (a.path && a.pathIdx < a.path.length) {
      const wp = a.path[a.pathIdx];
      if (!wp.boat) {
        const d = Math.sqrt(_dist2sq(e.pos.x, e.pos.z, wp.x, wp.z));
        if (d <= a.arriveDist) { a.pathIdx++; if (a.pathIdx >= a.path.length) { a.path = null; updateMount(e); } }
        else { tx = wp.x; tz = wp.z; speed = speedOf(e); want = true; }
      }
    }
    // steering
    let dx = 0, dz = 0;
    if (want) {
      dx = tx - e.pos.x; dz = tz - e.pos.z; const d = Math.sqrt(dx * dx + dz * dz) || 1; dx /= d; dz /= d;
      if (d < 3 && speed > RUN_SPEED) speed = RUN_SPEED;
      steer(e, dx, dz, t, _spot); dx = _spot.x; dz = _spot.z;
      _v.set(dx * speed, 0, dz * speed);
    } else _v.set(0, 0, 0);
    const P = G.Physics;
    const ox = e.pos.x, oz = e.pos.z;
    if (P && hasFn(P, 'moveEntity')) { try { P.moveEntity(e, _v, dt); } catch (err) { report(err, 'moveEntity'); } }
    else { e.pos.x += _v.x * dt; e.pos.z += _v.z * dt; e.vel.x = _v.x; e.vel.z = _v.z; e.pos.y = terrainY(e.pos.x, e.pos.z); if (G.Spatial && hasFn(G.Spatial, 'update')) G.Spatial.update(e); }
    if (e.mounted && e.swimming) setMounted(e, false);
    // facing
    if (want && speed > 0) e.yaw = alerp(e.yaw, _yawTo(dx, dz), Math.min(1, dt * 8));
    else if (a.fightTarget) e.yaw = alerp(e.yaw, _yawTo(a.fightTarget.pos.x - e.pos.x, a.fightTarget.pos.z - e.pos.z), Math.min(1, dt * 6));
    else if (a.emoteUntil > t && p && p.pos) e.yaw = alerp(e.yaw, _yawTo(p.pos.x - e.pos.x, p.pos.z - e.pos.z), Math.min(1, dt * 6));
    // stuck handling
    if (want && speed > 0) {
      const moved = Math.sqrt(_dist2sq(ox, oz, e.pos.x, e.pos.z));
      if (moved < speed * dt * 0.35) a.stuckT += dt; else a.stuckT = Math.max(0, a.stuckT - dt * 2);
      if (a.stuckT > 2.5 && a.stuckT < 2.5 + dt * 1.01) { if (e.onGround) e.vel.y = JUMP_VEL; a.avoidSide = -a.avoidSide; a.avoidAng = a.avoidSide * 1.2; a.avoidUntil = t + 0.8; }
      else if (a.stuckT > 6) { a.stuckT = 0; a.nudges++; if (a.nudges >= 3) { a.nudges = 0; if (a.path && a.pathIdx < a.path.length && !nearHero(a.path[a.pathIdx].x, a.path[a.pathIdx].z, 30)) { const wp = a.path[a.pathIdx]; placeAt(e, wp.x, wp.z, e.yaw); } else if (a.fightTarget) releaseTarget(e); else if (a.path) { a.pathIdx++; if (a.pathIdx >= a.path.length) a.path = null; } else a.follow = false; } else nudge(e, dx, dz); }
    } else a.stuckT = 0;
  }
  function emoteStep(e, dt, t) {
    const a = e.ai; const p = player();
    if (!p || !p.pos || e.dead || a.fightTarget || e.mounted || !e.rig || !hasFn(e.rig, 'setAnim')) return;
    if (a.emoteUntil > t) return;
    const d2 = e._d2;
    if (d2 < WAVE_RANGE * WAVE_RANGE && e.persona.friendly >= 0.5 && t - e.lastWave > 300 && !a.sit) {
      e.lastWave = t; a.emoteUntil = t + 2.1; e.rig.setAnim('emote_wave', true); counters.emotes++;
      if (schance(0.4) && chatEnabled()) schedule(e, pickLine(e, 'say_wave', null), 'say', sr(0.3, 1.2));
      return;
    }
    if (d2 < 36 && num(p.level, 1) >= e.level + 20 && t - e.lastBow > 600 && !a.sit) {
      e.lastBow = t; a.emoteUntil = t + 2.1; e.rig.setAnim('emote_bow', true); counters.emotes++;
      if (schance(0.5) && chatEnabled()) schedule(e, pickLine(e, 'say_bow', null), 'say', sr(0.5, 1.5));
    }
  }
  function animStep(e, dt, t) {
    const rig = e.rig; if (!rig || !hasFn(rig, 'setAnim')) return;
    const a = e.ai;
    if (e.dead) return;
    if (a.state === 'fishing' && a.phase === 'fish' && !a.fightTarget) {
      if (a.fishSeq !== 'wait' && a.fishSeq !== 'cast' && a.fishSeq !== 'reel') { rig.setAnim('fish_cast', true); a.fishSeq = 'cast'; a.fishCastT = t + 1.2; }
      else if (a.fishSeq === 'cast' && t >= a.fishCastT) { rig.setAnim('fish_wait'); a.fishSeq = 'wait'; }
      else if (a.fishSeq === 'wait' && rig.anim === 'fish_reel') { a.fishSeq = 'reel'; a.fishCastT = t + 1.2; }
      else if (a.fishSeq === 'reel' && t >= a.fishCastT) { rig.setAnim('fish_cast', true); a.fishSeq = 'cast'; a.fishCastT = t + 1.2; }
      return;
    }
    if (a.fishSeq) { a.fishSeq = null; rig.setAnim('idle', true); }
    const sitting = a.sit && !a.fightTarget && a.retreatUntil <= t && (a.eatUntil > t || (a.state === 'town' && a.phase === 'idle'));
    if (sitting) {
      if (a.dance === undefined || a.dance === null) a.dance = a.spotKind === 'campfire' && schance(0.2);
      const wantAnim = a.dance && a.eatUntil <= t ? 'emote_dance' : 'sit';
      if (rig.state !== wantAnim && !rig.oneShot) rig.setAnim(wantAnim, true);
    } else if (rig.state === 'sit' || rig.state === 'emote_dance') { rig.setAnim('idle', true); a.dance = null; }
  }
  function nearStep(e, dt, t) {
    counters.nearTicks++;
    if (e.sailing) return;
    const a = e.ai;
    if (!e.dead) {
      combatStep(e, dt, t);
      if (a.retreatUntil <= t && a.eatUntil <= t && !a.fightTarget && a.defend) a.defend = false;
      emoteStep(e, dt, t);
    }
    nearMove(e, dt, t);
    animStep(e, dt, t);
    const rig = e.rig;
    if (rig) {
      syncRig(e);
      if (e.mounted && e.mountRig) { const h = e.mountRig; if (hasFn(h, 'play')) { try { h.play(dt, e); } catch (err) { report(err, 'horse.play'); } } }
      if (hasFn(rig, 'play')) { try { rig.play(dt, e); } catch (err) { report(err, 'rig.play'); } }
      const np = rig.nameplate;
      if (np) { const vis = e._d2 < NAMEPLATE_DIST * NAMEPLATE_DIST; np.visible = vis; const cam = vis ? cameraOf() : null; if (cam && G.Chars && hasFn(G.Chars, 'updateNameplate')) { try { G.Chars.updateNameplate(np, cam); } catch (err) { /* ignore */ } } }
    }
  }

  // ------------------------------------------------------------------------------------------------ chat: templates
  function chatRate() { const s = G.state && G.state.settings; const v = s && typeof s.aiChat === 'number' ? s.aiChat : 1; return isFinite(v) && v > 0 ? v : 0; }
  function chatEnabled() { return chatRate() > 0; }
  let _fishNames = null;
  function fishName() {
    if (!_fishNames) { _fishNames = []; const items = G.Data && G.Data.items; if (items) for (const k in items) { const t = items[k]; if (t && t.type === 'fish' && t.name) _fishNames.push(t.name); } if (!_fishNames.length) _fishNames.push('trout', 'salmon', 'pike'); }
    return spick(_fishNames);
  }
  let _itemCounter = 0;
  function itemName(e) {
    const I = G.Items; if (I && hasFn(I, 'generate')) { try { const inst = I.generate({ level: e.level, cls: schance(0.5) ? e.cls : undefined, seed: 'chat:' + e.id + ':' + (_itemCounter++) }); if (inst && inst.name) return inst.name; } catch (err) { /* ignore */ } }
    return spick(['Bright Blade', 'Sturdy Cloak', 'Ring of Vigour', 'Hunter\'s Bow', 'Shield of the Watch']);
  }
  function otherName(e) {
    const f = fellowshipOf(e);
    if (f && schance(0.6)) { const id = spick(f.members); const o = byId[id]; if (o && o !== e) return o.name; }
    for (let k = 0; k < 4; k++) { const o = spick(all); if (o && o !== e) return o.name; }
    return 'someone';
  }
  function otherTown(e) {
    const n = graph.nodes[e.townId];
    if (n && n.adj.length) { const ed = graph.edges[spick(n.adj)]; const id = ed.a === e.townId ? ed.b : ed.a; const t = townData(id); if (t) return t.name; }
    const ts = (world() && world().towns) || []; for (let k = 0; k < 4; k++) { const t = spick(ts); if (t && t.id !== e.townId) return t.name; }
    return 'Bree';
  }
  function otherZone(e) {
    const zs = (world() && world().zones) || []; const cand = [];
    for (let i = 0; i < zs.length; i++) { const z = zs[i]; if (z.id === e.zone) continue; const lv = z.level || [1, 80]; if (lv[0] <= e.level + 18 && lv[1] >= e.level - 5) cand.push(z); }
    const z = cand.length ? spick(cand) : spick(zs);
    return z ? z.name : 'Bree-land';
  }
  function zoneMonster(e) {
    const W = world(); let list = null;
    if (W && hasFn(W, 'typesInZone')) { try { list = W.typesInZone(e.zone); } catch (err) { list = null; } }
    if (!list || !list.length) { const sp = spawnsInZone(e.zone); list = []; for (let i = 0; i < sp.length; i++) { const mt = monsterType(sp[i].type); if (mt) list.push(mt); } }
    const mt = spick(list); return mt ? mt.name : 'wolf';
  }
  function zoneBoss() { const W = world(); const bs = (W && W.bosses) || []; const b = spick(bs); const mt = b ? monsterType(b.type) : null; return (b && b.name) || (mt && mt.name) || 'the Gaunt-lord'; }
  function zonePoi(e) { const ps = poisIn(e.zone); const p = spick(ps); return p ? p.name : (townName(e.townId) + ' hill'); }
  function heroTown() { const p = player(); const W = world(); if (!p || !p.pos || !W) return 'Bree'; if (hasFn(W, 'nearestTown')) { try { const t = W.nearestTown(p.pos.x, p.pos.z); if (t) return t.name; } catch (err) { /* ignore */ } } return 'Bree'; }
  function token(k, e, ctx) {
    if (ctx && ctx[k] != null) return String(ctx[k]);
    const p = player();
    switch (k) {
      case 'zone': return zoneName(e.zone);
      case 'town': return townName(e.townId);
      case 'class': return className(e.cls);
      case 'level': return String(e.level);
      case 'race': return raceName(e.race);
      case 'name': return otherName(e);
      case 'item': return '[' + itemName(e) + ']';
      case 'gold': return _fmtGold(e.level * e.level * 60 + e.level * 300 + si(0, 900));
      case 'kills': return String(e.kills);
      case 'pzone': return zoneName((G.state && G.state.zone) || e.zone);
      case 'ptown': return heroTown();
      case 'pclass': return p ? className(p.cls) : 'adventurer';
      case 'plevel': return p ? String(num(p.level, 1)) : '1';
      case 'pname': return (p && p.name) ? String(p.name) : 'friend';
      case 'monster': return zoneMonster(e);
      case 'spawn': return spawnName(e.ai.spawn) || spawnName(spick(spawnsInZone(e.zone))) || 'the wilds';
      case 'poi': return zonePoi(e);
      case 'boss': return zoneBoss();
      case 'dungeon': return spick(DUNGEONS);
      case 'inn': return innName(townData(e.townId));
      case 'othertown': return otherTown(e);
      case 'otherzone': return otherZone(e);
      case 'hour': return HOUR_WORD();
      case 'fish': return fishName();
      default: return '';
    }
  }
  function fill(tpl, e, ctx) { if (!tpl) return ''; return String(tpl).replace(/\{(\w+)\}/g, (m, k) => token(k, e, ctx)); }
  function pickLine(e, cat, ctx) {
    const list = BANK[cat]; if (!list || !list.length) return '';
    let line = '';
    for (let k = 0; k < 6; k++) {
      line = fill(spick(list), e, ctx);
      if (line && line !== e.lastLine && line !== lastWorldLine) break;
    }
    return line;
  }
  function sendLine(e, text, channel, to) {
    if (!text || !e) return false;
    const t = now();
    if (text === e.lastLine && channel !== 'whisper') return false;
    e.lastLine = text; e.lastChatAt = t;
    if (channel === 'world') { lastWorldLine = text; lastWorldFrom = e; lastWorldAt = t; }
    const U = G.UI;
    if (U && hasFn(U, 'chat')) { try { U.chat(text, channel, e.name); } catch (err) { report(err, 'UI.chat'); } }
    chatLog.push({ from: e.name, channel: channel, text: text, at: t, to: to || null });
    if (chatLog.length > 60) chatLog.shift();
    counters.chats++;
    emit('aiChat', { ent: e, text: text, channel: channel });
    return true;
  }
  function schedule(e, text, channel, delay, to) {
    if (!e || !text) return;
    pending.push({ at: now() + Math.max(0, num(delay, 1)), e: e, text: text, channel: channel || 'world', to: to || null });
  }
  function processPending(t) {
    for (let i = pending.length - 1; i >= 0; i--) {
      const q = pending[i]; if (q.at > t) continue;
      pending.splice(i, 1);
      const e = q.e;
      if (q.channel === 'say' && (e.dead || !nearHero(e.pos.x, e.pos.z, SAY_RANGE + 5))) continue;
      if (q.channel !== 'whisper' && !chatEnabled()) continue;
      sendLine(e, q.text, q.channel, q.to);
      if (q.channel === 'say' && e.rig && hasFn(e.rig, 'setAnim') && !e.ai.fightTarget && !e.ai.sit && schance(0.25) && !e.rig.oneShot) { /* a little gesture while talking */ e.rig.setAnim(schance(0.5) ? 'emote_wave' : 'emote_cheer', false); }
    }
  }
  function chatWeight(e, t) { if (!e || e.dead || e.online === false) return 0; if (t - e.lastChatAt < 45) return 0; return e.persona.chatty * (e.persona.style === 'quiet' ? 0.25 : 1) + 0.02; }
  function pickChatter(t, exclude, preferStyle) {
    let best = null, total = 0;
    for (let i = 0; i < all.length; i++) { const e = all[i]; if (e === exclude) continue; let w = chatWeight(e, t); if (!w) continue; if (preferStyle && e.persona.style === preferStyle) w *= 3; total += w; if (S() * total < w) best = e; }
    return best;
  }
  function followUp(cat, src, delay, count) {
    for (let i = 0; i < count; i++) {
      const o = pickChatter(now(), src, cat === 'q_reply' ? 'helper' : null);
      if (!o) return;
      const line = pickLine(o, cat, { name: src.name, level: src.level, class: className(src.cls) });
      if (line) { schedule(o, line, 'world', delay + i * sr(1.5, 4)); o.lastChatAt = now(); counters.replies++; }
    }
  }
  const STYLE_CATS = {
    casual: [['casual', 34], ['question', 20], ['lfg', 12], ['joke', 8], ['tip', 5], ['wts', 8], ['wtb', 4], ['rp', 3], ['gz', 2], ['death', 4]],
    trader: [['wts', 45], ['wtb', 25], ['casual', 10], ['question', 10], ['joke', 5], ['tip', 5]],
    helper: [['tip', 38], ['question', 14], ['casual', 22], ['lfg', 12], ['rp', 6], ['wtb', 4], ['gz', 4]],
    jokester: [['joke', 52], ['casual', 22], ['question', 8], ['lfg', 6], ['gz', 4], ['wts', 4], ['death', 4]],
    roleplay: [['rp', 58], ['question', 10], ['casual', 10], ['lfg', 10], ['tip', 8], ['death', 4]],
    quiet: [['casual', 40], ['question', 30], ['lfg', 20], ['tip', 10]],
  };
  function contextCategory(e, t) {
    const a = e.ai;
    if (a.fightTarget) return 'say_fight';
    if (a.state === 'fishing' && a.phase === 'fish') return 'say_fish';
    if (a.state === 'town' && a.inInn) return 'say_inn';
    if (a.state === 'town' && a.spotKind === 'campfire') return 'say_camp';
    const r = S();
    const w = (G.state && G.state.weather) || 'clear';
    if (r < 0.3) { if (w === 'rain') return 'say_rain'; if (w === 'snow') return 'say_snow'; if (w === 'storm') return 'say_storm'; if (w === 'cloudy') return 'say_cloudy'; return 'say_clear'; }
    if (r < 0.5) { const h = dayTime(); if (h >= NIGHT_START || h < NIGHT_END) return 'say_night'; if (h < 7) return 'say_dawn'; if (h >= 18 && h < 20) return 'say_dusk'; return 'say_day'; }
    if (r < 0.7 && !e.saidClass) { e.saidClass = true; return 'say_class'; }
    if (r < 0.78 && t - heroLastSeen > 120) return 'say_greet';
    return 'say_zone';
  }
  function worldChatOnce(t) {
    // near the hero: someone comments on the surroundings
    const p = player();
    if (p && p.pos && schance(0.45)) {
      let best = null, total = 0;
      for (let i = 0; i < nearList.length; i++) { const e = nearList[i]; if (e._d2 > SAY_RANGE * SAY_RANGE) break; const w = chatWeight(e, t); if (!w) continue; total += w; if (S() * total < w) best = e; }
      if (best) { const cat = contextCategory(best, t); const line = pickLine(best, cat, null); if (line) { schedule(best, line, 'say', sr(0.2, 1.5)); best.lastChatAt = t; heroLastSeen = t; return; } }
    }
    const e = pickChatter(t, null, null); if (!e) return;
    const a = e.ai;
    let cat;
    if (a.state === 'dead' && schance(0.6)) cat = 'death';
    else {
      const cats = STYLE_CATS[e.persona.style] || STYLE_CATS.casual;
      for (let k = 0; k < 3; k++) { cat = (G.weightedPick(cats, (c) => c[1], S) || cats[0])[0]; if (cat !== lastWorldCat || schance(0.3)) break; }
      if (cat === 'death' && a.state !== 'dead' && t - a.deathAt > 120) cat = 'casual';
      if (cat === 'lfg' && e.level < 8) cat = 'question';
    }
    const line = pickLine(e, cat, null); if (!line) return;
    schedule(e, line, 'world', sr(0.1, 1)); e.lastChatAt = t; lastWorldCat = cat;
    if (cat === 'question' && schance(0.6)) followUp('q_reply', e, sr(5, 14), 1);
    else if (cat === 'lfg' && schance(0.35)) followUp('lfg_reply', e, sr(4, 10), 1);
    else if (cat === 'joke' && schance(0.3)) followUp('r_lol', e, sr(3, 8), 1);
    else if (cat === 'rp' && schance(0.25)) followUp('rp', e, sr(6, 15), 1);
    else if (cat === 'death' && schance(0.25)) followUp('r_default', e, sr(4, 9), 1);
  }

  // ------------------------------------------------------------------------------------------------ chat: replies to the hero
  const KEYWORDS = [
    ['r_bye', /\b(bye|cya|see ya|good ?night|gn|afk|later|farewell)\b/i],
    ['r_thanks', /\b(thanks|thank you|thx|ty|tyvm|cheers)\b/i],
    ['r_gg', /\b(gg|gz|grats|gratz|congrats|congratulations|wp)\b/i],
    ['r_lfg', /\b(lfg|lfm|lf\d?m|group|fellowship|party|inv|invite|need (a )?(healer|tank|dps))\b/i],
    ['r_where', /\b(where|which way|how (do|can) i (get|go|find)|direction|lost)\b/i],
    ['r_quest', /\b(quest|objective|turn ?in|book \d|chapter)\b/i],
    ['r_sell', /\b(sell|buy|wts|wtb|trade|gold|price|vendor|auction|cheap)\b/i],
    ['r_lol', /\b(lol|haha|hehe|rofl|lmao|xd)\b|:d|:\)/i],
    ['r_help', /\b(help|tip|tips|how do|how to|advice|stuck|noob|new here|newbie)\b/i],
    ['r_hi', /^\s*(hi|hello|hey|yo|hiya|greetings|hail|well met|good (morning|evening|day)|o\/|ola|sup|howdy)\b/i],
  ];
  function classify(text) {
    const s = String(text || '').trim();
    for (let i = 0; i < KEYWORDS.length; i++) if (KEYWORDS[i][1].test(s)) return KEYWORDS[i][0];
    if (/\?\s*$/.test(s)) return 'r_where';
    return null;
  }
  function nearChatters(t, r, exclude) {
    _tmp.length = 0;
    for (let i = 0; i < nearList.length; i++) { const e = nearList[i]; if (e._d2 > r * r) break; if (e === exclude || e.dead || e.persona.chatty < 0.08) continue; _tmp.push(e); }
    return _tmp;
  }
  function replyToHero(ev) {
    const t = now();
    const text = String(ev.text || '');
    if (!text.trim()) return;
    let cat = classify(text);
    if (ev.channel === 'emote') { cat = schance(0.5) ? 'say_greet' : 'emote_line'; }
    if (!cat) { if (!schance(0.45)) return; cat = 'r_default'; }
    let count = cat === 'r_lfg' ? si(1, 3) : (cat === 'r_hi' || cat === 'r_gg') ? si(1, 2) : 1;
    let channel = 'say';
    const cands = [];
    if (ev.channel === 'say' || ev.channel === 'emote') {
      const near = nearChatters(t, SAY_RANGE, null);
      for (let i = 0; i < near.length; i++) cands.push(near[i]);
      if (!cands.length) return;                          // nobody heard it
    } else if (ev.channel === 'world') {
      channel = 'world';
      for (let k = 0; k < count + 3 && cands.length < count; k++) { const e = pickChatter(t, null, cat === 'r_help' || cat === 'r_where' || cat === 'r_quest' ? 'helper' : null); if (e && cands.indexOf(e) < 0) cands.push(e); }
      if (!cands.length) return;
    } else return;
    if (cands.length > count) { for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(S() * (i + 1)); const x = cands[i]; cands[i] = cands[j]; cands[j] = x; } cands.length = count; }
    for (let i = 0; i < cands.length; i++) {
      const e = cands[i];
      const line = pickLine(e, cat, null); if (!line) continue;
      schedule(e, line, channel, sr(2, 6) + i * sr(0.5, 2)); e.lastChatAt = t; counters.replies++;
      if (channel === 'say' && cat === 'r_hi' && e.rig && hasFn(e.rig, 'setAnim') && e._d2 < 14 * 14 && !e.ai.fightTarget && !e.ai.sit) { e.ai.emoteUntil = t + 2.5; e.rig.setAnim('emote_wave', true); }
    }
  }
  function whisper(name, text) {
    const e = byName(name);
    const U = G.UI;
    if (!e) { if (U && hasFn(U, 'chat')) U.chat('There is no player named "' + String(name || '') + '" online.', 'system'); return false; }
    const t = now();
    let cat = classify(text);
    if (cat === 'r_lfg') cat = 'r_whisper_lfg'; else if (cat === 'r_where' || cat === 'r_quest') cat = 'r_whisper_where'; else if (cat === 'r_thanks') cat = 'r_whisper_thanks'; else if (cat === 'r_bye') cat = 'r_whisper_bye';
    else if (cat === 'r_hi' || !cat) cat = 'r_whisper';
    const line = pickLine(e, cat, null);
    if (line) schedule(e, line, 'whisper', sr(2, 5), 'You');
    e.whispered = true; e.lastChatAt = t; counters.replies++;
    return true;
  }
  function onChat(ev) {
    if (!ev || ev.from !== 'You') return;
    if (ev.channel === 'whisper') { if (ev.to) whisper(ev.to, ev.text); return; }
    if (!chatEnabled() || !inited) return;
    try { replyToHero(ev); } catch (err) { report(err, 'replyToHero'); }
  }
  function onPlayerLevelUp(level) {
    if (!chatEnabled() || !inited) return;
    const t = now(); const n = si(1, 3); const p = player();
    const L = typeof level === 'number' ? level : (p ? num(p.level, 1) : 1);
    const used = [];
    for (let i = 0; i < n; i++) {
      const e = pickChatter(t, null, null); if (!e || used.indexOf(e) >= 0) continue; used.push(e);
      const near = e._near && e._d2 < SAY_RANGE * SAY_RANGE;
      const line = pickLine(e, 'gz', { level: String(L), name: (p && p.name) || 'friend' });
      if (line) { schedule(e, line, near ? 'say' : 'world', sr(2, 5) + i * sr(0.5, 1.5)); e.lastChatAt = t; }
      if (near && e.rig && hasFn(e.rig, 'setAnim') && !e.ai.fightTarget) { e.ai.emoteUntil = t + 2; e.rig.setAnim('emote_cheer', true); }
    }
  }

  // ------------------------------------------------------------------------------------------------ update
  function update(dt) {
    if (!inited || !all.length) return;
    dt = num(dt, 0); if (dt <= 0) return; if (dt > 0.25) dt = 0.25;
    frame++;
    const t = now();
    // far LOD: round-robin so every AI ticks about every FAR_TICK seconds
    const n = Math.min(all.length, Math.max(1, Math.ceil(all.length * dt / FAR_TICK)));
    for (let i = 0; i < n; i++) {
      const e = all[cursor]; cursor = (cursor + 1) % all.length;
      const edt = clamp(t - e._lastTick, 0, 2.5);
      if (edt < 0.05) continue;
      e._lastTick = t;
      try { farTick(e, edt, t); } catch (err) { report(err, 'farTick'); }
    }
    // near LOD
    const p = player();
    if (p && p.pos) {
      scanT -= dt;
      if (scanT <= 0) { scanT = 0.5; scanNear(p.pos.x, p.pos.z); rigBudget(); }
      for (let i = 0; i < nearList.length; i++) {
        const e = nearList[i]; if (!e._near) continue;
        e._d2 = _dist2sq(p.pos.x, p.pos.z, e.pos.x, e.pos.z);
        try { nearStep(e, dt, t); } catch (err) { report(err, 'nearStep'); }
      }
    }
    // chat
    processPending(t);
    if (chatEnabled() && t >= nextWorldChat) {
      nextWorldChat = t + CHAT_INTERVAL / chatRate() * sr(0.45, 1.6);
      try { worldChatOnce(t); } catch (err) { report(err, 'chat'); }
    }
  }

  // ------------------------------------------------------------------------------------------------ init & events
  let hooked = false;
  function hookEvents() {
    if (hooked || !hasFn(G, 'on')) return;
    hooked = true;
    G.on('chat', onChat);
    G.on('playerLevelUp', onPlayerLevelUp);
    G.on('entityKilled', onEntityKilled);
    G.on('gameStart', function () { ensureScene(); nextWorldChat = now() + sr(8, 20); });
  }
  function init(sc) {
    if (sc && sc.isScene) scene = sc;
    if (inited) { ensureScene(); return AI; }
    const W = world();
    if (!W || !G.Data || !Array.isArray(G.Data.races) || !Array.isArray(G.Data.classes)) { warn('G.Data.world / races / classes missing — no simulated players'); inited = true; hookEvents(); return AI; }
    try { buildGraph(W); } catch (err) { report(err, 'buildGraph'); }
    try { buildPopulation(W); } catch (err) { report(err, 'buildPopulation'); }
    hookEvents();
    inited = true;
    nextWorldChat = now() + sr(6, 20);
    ensureScene();
    if (hasFn(G, 'log')) G.log('[AIPlayers] ' + all.length + ' simulated players, ' + fellowships.length + ' fellowships, ' + graph.list.length + ' graph nodes / ' + graph.edges.length + ' edges');
    return AI;
  }

  // ------------------------------------------------------------------------------------------------ public API
  function stateLabel(e) {
    const a = e.ai;
    if (e.dead || a.state === 'dead') return 'dead';
    if (e.sailing) return 'sailing';
    if (a.fightTarget) return 'fighting';
    if (a.state === 'questing') return a.phase === 'fight' ? 'fighting' : a.grind ? 'grinding' : 'questing';
    return a.state;
  }
  function record(e) {
    return { id: e.id, name: e.name, fullName: e.fullName, race: e.race, cls: e.cls, gender: e.gender, level: e.level, zone: e.zone, zoneName: zoneName(e.zone), town: e.townId,
      state: stateLabel(e), activity: e.activity, pos: { x: Math.round(e.pos.x), z: Math.round(e.pos.z) }, fellowshipId: e.fellowshipId, mounted: !!e.mounted, online: e.online !== false };
  }
  function list() { const out = new Array(all.length); for (let i = 0; i < all.length; i++) out[i] = record(all[i]); return out; }
  function get(id) { if (!id) return null; if (typeof id === 'object') return byId[id.id] || null; return byId[id] || byNameLower[String(id).toLowerCase()] || null; }
  function byName(name) {
    if (!name) return null;
    const key = String(name).trim().toLowerCase(); if (!key) return null;
    if (byNameLower[key]) return byNameLower[key];
    for (let i = 0; i < all.length; i++) { const n = all[i].name.toLowerCase(); if (n.indexOf(key) === 0 || all[i].fullName.toLowerCase() === key) return all[i]; }
    return null;
  }
  function inspect(id) {
    const e = get(id); if (!e) return null;
    const r = record(e);
    const f = fellowshipOf(e);
    const eq = {}; for (let i = 0; i < EQUIP_SLOTS.length; i++) eq[EQUIP_SLOTS[i]] = (e.equipment && e.equipment[EQUIP_SLOTS[i]]) || null;
    const stats = {}; for (const k in e.stats) stats[k] = e.stats[k];
    const next = e.level >= LEVEL_CAP ? e.xp : xpForLevel(e.level + 1);
    const base = xpForLevel(e.level);
    r.stats = stats; r.equipment = eq; r.xp = Math.round(e.xp); r.xpNext = Math.round(next); r.xpPct = next > base ? clamp((e.xp - base) / (next - base) * 100, 0, 100) : 100;
    r.kills = e.kills; r.questsDone = e.questsDone; r.deaths = e.deaths; r.fish = e.fish; r.playTime = Math.round(e.playTime);
    r.fellowship = f ? f.members.map((m) => (byId[m] ? byId[m].name : m)).filter((n) => n !== e.name) : [];
    r.fellowshipName = f ? f.name : ''; r.fellowshipRole = e.fellowshipRole || '';
    r.title = e.title || ''; r.persona = { chatty: e.persona.chatty, friendly: e.persona.friendly, style: e.persona.style, playstyle: e.persona.playstyle };
    r.morale = Math.round(e.morale); r.power = Math.round(e.power); r.alive = alive(e); r.abilities = e.abilities ? Array.from(e.abilities) : [];
    r.entity = e;
    return r;
  }
  function teleportTo(id) {
    const e = get(id); const P = G.Player; const p = player();
    if (!e || !P || !hasFn(P, 'teleport')) return false;
    const pt = landPointNear(e.pos.x, e.pos.z, 3);
    const yaw = _yawTo(e.pos.x - pt.x, e.pos.z - pt.z);
    let ok = false;
    try { ok = !!P.teleport(pt.x, pt.z, yaw); } catch (err) { report(err, 'Player.teleport'); ok = false; }
    if (ok && p && G.state) { const z = zoneAtPos(pt.x, pt.z); if (z && z !== G.state.zone) { G.state.zone = z; emit('zoneChanged', z); } }
    return ok;
  }
  function summon(id, pos) {
    const e = get(id); if (!e) return false;
    const p = player();
    const at = pos && typeof pos.x === 'number' ? pos : (p && p.pos) || null;
    if (!at) return false;
    const a = e.ai;
    if (e.pos && nearHero(e.pos.x, e.pos.z, 80)) fx('teleport', e.pos, { out: true, scale: 0.7 });
    releaseTarget(e);
    e.sailing = false; setMounted(e, false);
    if (e.dead) respawn(e);
    let nx = at.x + sr(-3, 3), nz = at.z + sr(-3, 3);
    const P = G.Physics; if (P && hasFn(P, 'nearestFree')) { try { const f = P.nearestFree(nx, nz, 0.4); if (f) { nx = f.x; nz = f.z; } } catch (err) { /* ignore */ } }
    placeAt(e, nx, nz, _yawTo(at.x - nx, at.z - nz));
    e.pos.y = terrainY(nx, nz);
    const z = zoneAtPos(nx, nz); const zd = z ? zoneData(z) : null;
    if (zd && zd.level && e.level >= num(zd.level[0], 1) - 3 && e.level <= num(zd.level[1], 80) + 5) { e.zone = z; const W = world(); if (W && hasFn(W, 'nearestTown')) { try { const tn = W.nearestTown(nx, nz); if (tn) e.townId = tn.id; } catch (err) { /* ignore */ } } }
    else { a.travelTo = e.townId; }
    a.state = 'idle'; a.phase = ''; a.timer = sr(15, 40); a.path = null; a.sit = false; a.follow = false;
    setActivity(e, 'Summoned by ' + ((p && p.name) || 'the admin'));
    fx('teleport', e.pos, { scale: 0.8 });
    if (e.fellowshipRole === 'member') e.fellowshipRole = 'solo';
    return true;
  }
  function spawnNear(pos) {
    const p = player(); const at = (pos && typeof pos.x === 'number') ? pos : (p && p.pos) || null;
    if (!at || !all.length) return null;
    let e = null;
    for (let k = 0; k < 12; k++) { const c = spick(all); if (c && !c._near && !c.dead) { e = c; break; } }
    if (!e) e = spick(all);
    return summon(e.id, at) ? e : null;
  }
  function setChatRate(mult) {
    const v = Math.max(0, num(mult, 1));
    if (G.state) { if (!G.state.settings) G.state.settings = {}; G.state.settings.aiChat = v; }
    if (v > 0) nextWorldChat = Math.min(nextWorldChat, now() + CHAT_INTERVAL / v);
    return v;
  }
  function levelAll(n) {
    n = Math.round(num(n, 1)); if (!n) return 0;
    let changed = 0;
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      if (n > 0) { for (let k = 0; k < n && e.level < LEVEL_CAP; k++) { e.xp = xpForLevel(e.level + 1); levelUp(e, true); changed++; } }
      else { const L = clamp(e.level + n, 1, LEVEL_CAP); if (L !== e.level) { e.level = L; e.xp = xpForLevel(L); e.abilities = abilitiesForLevel(e.cls, L); buildRotation(e); refreshGear(e); fullHeal(e); e.title = titleFor(e); if (e.rig) refreshNameplate(e); changed++; } }
      promoteZone(e);
    }
    return changed;
  }
  function serialize() {
    const out = new Array(all.length);
    for (let i = 0; i < all.length; i++) {
      const e = all[i];
      out[i] = { id: e.id, level: e.level, xp: Math.round(e.xp), zone: e.zone, town: e.townId, x: Math.round(e.pos.x), z: Math.round(e.pos.z), state: stateLabel(e),
        kills: e.kills, deaths: e.deaths, questsDone: e.questsDone, fish: e.fish, playTime: Math.round(e.playTime) };
    }
    return out;
  }
  function restore(data) {
    if (!inited) init();
    if (!Array.isArray(data)) return 0;
    let n = 0;
    for (let i = 0; i < data.length; i++) {
      const rec = data[i]; if (!rec || !rec.id) continue;
      const e = byId[rec.id]; if (!e) continue;
      if (e.rig) disposeRig(e);
      releaseTarget(e);
      const L = clamp(Math.round(num(rec.level, e.level)), 1, LEVEL_CAP);
      const changed = L !== e.level;
      e.level = L;
      e.xp = Math.max(xpForLevel(L), num(rec.xp, xpForLevel(L)));
      if (L < LEVEL_CAP && e.xp >= xpForLevel(L + 1)) e.xp = xpForLevel(L + 1) - 1;
      if (changed) { e.abilities = abilitiesForLevel(e.cls, L); buildRotation(e); refreshGear(e); e.title = titleFor(e); }
      fullHeal(e);
      if (rec.zone && zoneData(rec.zone)) e.zone = rec.zone;
      if (rec.town && townData(rec.town)) e.townId = rec.town;
      else if (!townData(e.townId) || townData(e.townId).zone !== e.zone) { const tn = pickTown(e.zone, S); if (tn) e.townId = tn.id; }
      e.kills = Math.round(num(rec.kills, e.kills)); e.deaths = Math.round(num(rec.deaths, e.deaths)); e.questsDone = Math.round(num(rec.questsDone, e.questsDone)); e.fish = Math.round(num(rec.fish, e.fish)); e.playTime = num(rec.playTime, e.playTime);
      e.alive = true; e.dead = false; e.sailing = false; e.mounted = false;
      e.ai = newAiState();
      const x = num(rec.x, e.pos.x), z = num(rec.z, e.pos.z);
      placeAt(e, isWaterAt(x, z) ? rallyOf(townData(e.townId)).x : x, isWaterAt(x, z) ? rallyOf(townData(e.townId)).z : z, e.yaw);
      e.ai.state = 'idle'; e.ai.timer = sr(2, 25);
      setActivity(e, 'Idling in ' + zoneName(e.zone));
      n++;
    }
    // fellowship members may have been saved apart from their leader; they catch up on their own
    return n;
  }
  function stats() {
    const byState = {}; let rigs = 0, near = 0, mounted = 0, sailing = 0, dead = 0, lvSum = 0, maxL = 0;
    for (let i = 0; i < all.length; i++) { const e = all[i]; const s = stateLabel(e); byState[s] = (byState[s] || 0) + 1; if (e.rig) rigs++; if (e._near) near++; if (e.mounted) mounted++; if (e.sailing) sailing++; if (e.dead) dead++; lvSum += e.level; if (e.level > maxL) maxL = e.level; }
    return Object.assign({ count: all.length, fellowships: fellowships.length, byState: byState, rigs: rigs, near: near, mounted: mounted, sailing: sailing, dead: dead, avgLevel: all.length ? Math.round(lvSum / all.length * 10) / 10 : 0, maxLevel: maxL, pendingChat: pending.length, graphNodes: graph.list.length, graphEdges: graph.edges.length }, counters);
  }
  function nearPlayer(r) {
    const p = player(); const out = [];
    if (!p || !p.pos || !G.Spatial || !hasFn(G.Spatial, 'query')) return out;
    const q = G.Spatial.query(p.pos.x, p.pos.z, num(r, 30), _aiFilter, _qbuf);
    for (let i = 0; i < q.length; i++) out.push(q[i]);
    out.sort((a, b) => _dist2sq(p.pos.x, p.pos.z, a.pos.x, a.pos.z) - _dist2sq(p.pos.x, p.pos.z, b.pos.x, b.pos.z));
    return out;
  }
  function say(id, text, channel) {
    const e = get(id); if (!e || !text) return false;
    return sendLine(e, fill(String(text), e, null), channel || 'say');
  }
  function setScene(sc) { if (sc && sc.isScene) { scene = sc; ensureScene(); } }

  // ------------------------------------------------------------------------------------------------ export
  AI.init = init;
  AI.update = update;
  AI.list = list;
  AI.get = get;
  AI.byName = byName;
  AI.inspect = inspect;
  AI.teleportTo = teleportTo;
  AI.summon = summon;
  AI.spawnNear = spawnNear;
  AI.setChatRate = setChatRate;
  AI.levelAll = levelAll;
  AI.serialize = serialize;
  AI.restore = restore;
  AI.stats = stats;
  AI.nearPlayer = nearPlayer;
  AI.whisper = whisper;
  AI.say = say;
  AI.onDamaged = onDamaged;
  AI.setScene = setScene;
  AI.all = all;
  AI.fellowships = fellowships;
  AI.chatLog = chatLog;
  AI.FELLOWSHIP_NAMES = FELLOWSHIP_NAMES;
  AI.BANK = BANK;
  Object.defineProperty(AI, 'count', { get: function () { return all.length; }, enumerable: true });
  Object.defineProperty(AI, 'root', { get: function () { return root; }, enumerable: true });
  Object.defineProperty(AI, 'inited', { get: function () { return inited; }, enumerable: true });
})();
