/* ==== 23_npcs.js — G.NPCs: every registry NPC as a living entity plus the world's interactive props.
   NPC entities (kind:'npc') are created from G.Data.world.npcs; interior NPCs are placed on their building's
   `interiorSpots` (picked by role: counter/keeper for vendors & innkeepers, lord/table/fire/idle for the rest).
   Rigs are built lazily (≤ ~50 nearest within G.C.NPC_RENDER_DIST, ≤ 2 builds per frame, disposed when far) from a
   deterministic per-NPC look (race skin/hair tables + G.Items.generate gear seeded by the npc id, role-specific
   outfits: guards in armour with spear & shield, vendors in light tunics, innkeepers in aprons, bards with lutes,
   elves in silver & green), with role-coloured nameplates (quest-givers gold, vendors light blue, trainers green,
   others parchment) and bobbing quest markers (yellow ! available, grey ? in progress, yellow ? ready) plus a
   questmark_glow for turn-in-ready NPCs. Ambient behaviour: guards patrol their gate, townsfolk stroll the streets
   (preferring road/dirt), children run between two spots, bards play and dance, fishermen wait at the water,
   some folk sit at campfires, everyone faces the player when spoken to and returns to their home facing; between
   22:00 and 05:00 non-essential outdoor flavour NPCs walk to the nearest door (the inn if there is one) and go
   inside (quest-givers / vendors / trainers / guards never hide). Dialogue builds the option list (quests with !/?,
   Trade, Train, Travel, Sail, Rest & Save, small talk) and hands it to G.UI.Dialogue; vendors buy/sell/sell-junk
   with buy-back; gather nodes (kind:'node') are placed deterministically on land around each registry entry, built
   lazily as props, gathered with a 1.5 s channel (HUD cast bar via player.casting), deplete and respawn after 60 s.

   Public API (SPEC §6.4): init(), update(dt), get(npcId), talk(npc) → bool.
   Extras (documented here):
     all (array of npc entities), byRole(role) ('vendor' matches every vendor:*), nearestByRole(pos, role),
     inTown(townId), setPos(npcOrId, x, z, yaw?) (admin), markerState(npc) → 'available'|'turnin'|'active'|null,
     refreshMarkers(), dialogueOptions(npc) → [{kind, icon, label, quest?, questId?, text?, action?()}],
     choose(npc, option) (runs option.action for non-quest options), greeting(npc), nextLine(npc), endTalk(npc?),
     vendorKind(npc) → 'general'|'armour'|'weapons'|'food'|'fishing'|null, openVendor(npc) → stock, stockFor(npc),
     buy(npc, tid, count=1) → bool, sell(npc, slotIndex) → copper, sellJunk(npc) → {count, gold},
     remoteSellJunk() → {count, gold} (50 % value, no vendor), buyback(npc) → [inst], rebuy(npc, index) → bool,
     activeVendor (npc|null), rest(npc), openTravel(npc), openDock(npc),
     nodes (array), nearestNode(nodeIdOrItemTid, pos) → entity|null, nodesFor(itemTid) → [entity],
     nodesOf(nodeId) → [entity], gather(node) → bool (starts the channel), cancelChannel(), channel (current|null),
     hidden (count), rendered (array), root (THREE.Group), setScene(scene), stats().
   Writes on entities: npc.questMark ('!'|'?'|'?grey'|null, read by the HUD minimap), npc.talkingTo,
   player.casting = {name, kind:'channel', start, elapsed, duration, total, castTime, node} while gathering and
   player.yaw (faces the node when the channel starts).
   Events emitted: npcTalk(npc), npcTalkEnd(npc), vendorOpened(npc), vendorBuy({npc, item, price}),
   vendorSell({npc, item, gold}), gatherStart(node), gathered({node, item}), nodeRespawn(node), rested(npc).
   Assumptions: G.Quests.available/turnins/active/state/onTalk/onUse, G.UI.Dialogue.open(npc, greeting, options),
   G.UI.Vendor.open(npc, stock), G.UI.Travel.openStable(npc)/openDock(dock), G.UI.openPanel/isOpen/notify/chat,
   G.Progress.addGold/spendGold, G.Combat.heal, G.Save.save, G.Player.camera — every call is guarded and the
   module degrades gracefully without them (private gold fallbacks `_addGold/_spendGold` touch player.gold only
   when G.Progress is absent; `_ensureNodeItem` registers a plain template via G.Data.addItem only for gather items
   that no data module defines). Registry conventions honoured: interior:{town,index} + building.npcInside,
   boat-masters' `dock`, gatherNodes' `name`. ==== */
(function () {
  'use strict';
  const G = window.G;
  const THREE = window.THREE;
  if (!G || !THREE) return;

  // ------------------------------------------------------------------------------------------------ helpers
  const PI = Math.PI, TAU = Math.PI * 2;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const wrapA = (a) => { a = a % TAU; if (a > PI) a -= TAU; else if (a < -PI) a += TAU; return a; };
  const alerp = (a, b, t) => a + wrapA(b - a) * t;
  const now = () => (G.time && typeof G.time.now === 'number') ? G.time.now : 0;
  const dayTime = () => (G.time && typeof G.time.dayTime === 'number') ? G.time.dayTime : 12;
  const log = function () { if (typeof G.log === 'function') G.log.apply(null, arguments); };
  const warn = (m) => { if (typeof G.warn === 'function') G.warn(m); };
  const report = (e, where) => { if (typeof G.reportError === 'function') G.reportError(e, where); else warn('[NPCs] ' + where + ': ' + (e && e.message)); };
  const emit = (evt, a, b) => { if (typeof G.emit === 'function') G.emit(evt, a, b); };
  const rngOf = (seed) => (typeof G.rng === 'function') ? G.rng(seed) : (function () { let s = 1; return function () { s = (s * 16807) % 2147483647; return s / 2147483647; }; })();
  const rand = () => (typeof G.rand === 'function') ? G.rand() : Math.random();
  const titleCase = (s) => (typeof G.titleCase === 'function') ? G.titleCase(String(s || '').replace(/[_-]+/g, ' ')) : String(s || '');
  const fmtMoney = (c) => (typeof G.fmtMoney === 'function') ? G.fmtMoney(c) : (c + 'c');
  const player = () => (G.state && G.state.player) || null;
  const hasFn = (o, k) => !!(o && typeof o[k] === 'function');
  function sfx(name, o) { try { if (hasFn(G.Audio, 'sfx')) G.Audio.sfx(name, o); } catch (e) { /* audio is optional */ } }
  function notify(text, kind) { if (hasFn(G.UI, 'notify')) { try { G.UI.notify(text, kind || 'info'); } catch (e) { report(e, 'notify'); } } else log('[notify]', text); }
  function chat(text, channel, from) { if (hasFn(G.UI, 'chat')) { try { G.UI.chat(text, channel || 'say', from); } catch (e) { report(e, 'chat'); } } }
  function fx(kind, pos, opts) { if (hasFn(G.FX, 'spawn')) { try { return G.FX.spawn(kind, pos, opts); } catch (e) { report(e, 'fx'); } } return null; }
  function panelOpen(id) { return hasFn(G.UI, 'isOpen') ? !!G.UI.isOpen(id) : false; }
  function questData(id) { if (!id) return null; if (typeof id === 'object') return id; const D = G.Data; if (D && D.questById && D.questById[id]) return D.questById[id]; if (D && Array.isArray(D.quests)) { for (let i = 0; i < D.quests.length; i++) if (D.quests[i] && D.quests[i].id === id) return D.quests[i]; } return null; }
  function questId(q) { return typeof q === 'string' ? q : (q && q.id) || null; }

  // ------------------------------------------------------------------------------------------------ constants
  const C = G.C || {};
  const RENDER_DIST = C.NPC_RENDER_DIST || 200, RENDER_HYST = 30;
  const MAX_RIGS = Math.max(24, Math.min(50, (C.MAX_RENDERED_CHARS || 40) + 10));
  const BUILDS_PER_FRAME = 2;
  const NODE_DIST = 200, NODE_HYST = 40, NODE_RESPAWN = 60, CHANNEL_TIME = 1.5, NODE_RANGE = 3, NODE_SPARKLE_DIST = 22, MAX_NODE_SPARKLES = 8;
  const NAMEPLATE_DIST = 45, MARKER_DIST = 130, GLOW_DIST = 40, GLOW_DROP = 48;
  const FACE_DIST = 3, TALK_DROP = 8;
  const WALK = C.WALK_SPEED || 2.5, RUN = C.RUN_SPEED || 6.5;
  const NIGHT_START = 22, NIGHT_END = 5;
  const ROLE_COLOR = { questgiver: '#ffd24a', vendor: '#8fd3ff', trainer: '#86e28c', other: '#e9dcc0' };
  const ROLE_PRIORITY = ['questgiver', 'vendor', 'innkeeper', 'trainer', 'stablemaster', 'boatmaster', 'guard', 'bard', 'flavor'];
  const ROLE_LABEL = { 'vendor:general': 'Provisioner', 'vendor:armour': 'Armourer', 'vendor:weapons': 'Weaponsmith', 'vendor:food': 'Cook', 'vendor:fishing': 'Fishing Supplier', vendor: 'Merchant', trainer: 'Trainer', stablemaster: 'Stable-master', boatmaster: 'Boat-master', innkeeper: 'Innkeeper', guard: 'Guard', bard: 'Minstrel', questgiver: '' };
  const RACE_LABEL = { man: 'Man', elf: 'Elf', dwarf: 'Dwarf', hobbit: 'Hobbit', highelf: 'High Elf', beorning: 'Beorning', stoutaxe: 'Stout-axe', riverhobbit: 'River Hobbit', dunedain: 'Dúnadan', rohirrim: 'Rohirrim' };
  const RACE_IDS = ['man', 'elf', 'dwarf', 'hobbit', 'highelf', 'beorning', 'stoutaxe', 'riverhobbit', 'dunedain', 'rohirrim'];
  const PROP_KIND = { herb: 'herb', ore: 'ore', wood: 'bundle', chest: 'chest', relic: 'relic', mushroom: 'mushroom', beacon: 'beacon', bundle: 'bundle', crate: 'crate', supplies: 'crate' };
  const GATHER_ANIM = { herb: 'emote_bow', mushroom: 'emote_bow', ore: 'attack_slash', wood: 'emote_bow', bundle: 'emote_bow', relic: 'cast', chest: 'emote_bow', crate: 'emote_bow', beacon: 'cast' };
  const MARK_DEF = { available: { glyph: '!', color: '#ffd24a', hud: '!' }, turnin: { glyph: '?', color: '#ffd24a', hud: '?' }, active: { glyph: '?', color: '#b6b6b6', hud: '?grey' } };
  const SPOT_PREF = {
    vendor: ['keeper', 'vendor', 'lord', 'table', 'idle', 'fire', 'sit', 'watch'],
    innkeeper: ['keeper', 'vendor', 'table', 'idle', 'fire', 'lord', 'sit'],
    boatmaster: ['boatmaster', 'keeper', 'idle', 'table', 'fire'],
    trainer: ['lord', 'keeper', 'table', 'fire', 'idle', 'sit', 'watch'],
    questgiver: ['lord', 'table', 'keeper', 'fire', 'idle', 'sit', 'watch', 'pray'],
    other: ['idle', 'table', 'fire', 'sit', 'watch', 'pray', 'lord', 'keeper'],
  };
  const GREET = {
    vendor: ['Have a look at my wares, friend — the finest this side of the Brandywine.', 'Coin for goods and goods for coin. What will it be?', 'Welcome! Everything on the table is for sale, and most of it is even useful.'],
    innkeeper: ['Welcome, traveller! A warm fire, a soft bed and a full tankard await.', 'Come in out of the weather. There is always room by the hearth.', 'You look road-weary. Rest a while — the road will still be there in the morning.'],
    trainer: ['Every blade must be honed, every song rehearsed. Shall we see what you have learned?', 'There is always more to master. Shall we train?', 'Skill is won in practice, not in tales. Come, let us begin.'],
    stablemaster: ['Need a swift horse? My ponies know every road from here to Bree.', 'The roads are long, but a good mount makes them short.', 'Where are you headed? I can have you there before the kettle boils.'],
    boatmaster: ['The tide is right and the boat is ready. Where do you sail?', 'Mind the gulls, mind the swell, and we will see you safe across the water.', 'Nothing like open water under a clear sky, friend. Care for a crossing?'],
    guard: ['Move along, citizen. All is quiet.', 'Keep to the road after dark. There have been wolves about.', 'Nothing gets past this gate without my say-so.', 'Halt! ...Ah, it is only you. Carry on.'],
    bard: ['A song for the road? I know a hundred, and only half of them are about pies.', 'Sit a while and listen — this next one is a favourite in the Green Dragon.', 'Music is the best medicine, they say. Second only to ale.'],
    questgiver: ['Well met. There is work here for someone of your mettle.', 'Ah, a traveller! Perhaps you can help me with a small matter.', 'Good day to you. I could use a capable pair of hands.'],
    flavor: ['Fine weather for it, is it not?', 'Good day to you, stranger.', 'Have you seen the state of the roads lately? Terrible.', 'Mind how you go. Strange folk about these days.'],
    child: ['Are you an adventurer? Have you fought a dragon?', 'Race you to the well! ...You are too slow!', 'Mum says I am not to talk to strangers. But you seem all right.'],
  };
  const GREET_RACE = { elf: 'Mae govannen, friend. The stars shine upon the hour of our meeting.', highelf: 'Mae govannen. Few of the Eldar remain on these shores; you are welcome among us.', dwarf: 'Well met! The halls of my fathers bid you welcome — mind your head on the lintel.', stoutaxe: 'A stranger from the West! Sit, drink, and tell me of your road.', hobbit: 'Good morning! Or is it afternoon already? Time for second breakfast either way.', riverhobbit: 'The river is kind today. Have you eaten? You look like you have not eaten.', beorning: 'The bees are restless. Speak plainly and we shall get along.', dunedain: 'The Rangers keep watch, even where none thank them. Well met.', rohirrim: 'Westu hál! A rider of the Mark greets you.', man: 'Well met, traveller. Bree-land is quieter than the tales say — mostly.' };
  const VENDOR_TUNICS = [0x8a6a3a, 0x6a7a3a, 0x4a5a8a, 0x8a4a3a, 0x7a5a6a, 0x5a7a7a, 0x9a8a4a, 0x6a4a7a];
  const HOBBIT_TUNICS = [0x9a8a2a, 0x2a6a3a, 0x8a2a2a, 0x3a5a8a, 0xc08a3a, 0x6a3a6a, 0x4a8a5a, 0xb05a2a];
  const MAN_TUNICS = [0x6a5a4a, 0x5a6a5a, 0x4a4a5a, 0x7a5a3a, 0x5a4a3a, 0x6a6a4a, 0x8a5a4a];
  const DWARF_TUNICS = [0x7a2a2a, 0x2a3a6a, 0x5a4a2a, 0x3a5a3a, 0x6a3a1a];
  const ELF_TUNICS = [0xc8d0dc, 0x4a7a5a, 0x3a5a8a, 0x8a9ab0, 0x6a8a6a, 0xb8c8b0, 0x5a6a9a];
  const TROUSERS = [0x3a2a1c, 0x4a3a2a, 0x2a2a34, 0x4a4238, 0x3a3a2a, 0x5a4a3a];

  // ------------------------------------------------------------------------------------------------ module state
  const root = new THREE.Group(); root.name = 'npcs';
  let scene = null, inited = false;
  const npcs = [], byNpcId = Object.create(null), rendered = [], pendingBuild = [];
  const nodes = [], nodesById = Object.create(null), nodesByItem = Object.create(null);
  let townById = Object.create(null), questRefs = null;
  const cand = [];                       // reused candidate buffer for the render set
  let tickAcc = 0, markerAcc = 0, markersDirty = true, nodeAcc = 0, lastBuildingCount = -1;
  let talking = null, activeVendor = null, ducked = false, duckWatchT = 0, channel = null, hiddenCount = 0;
  const stockCache = Object.create(null);
  const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

  // ------------------------------------------------------------------------------------------------ roles
  function roles(e) { return (e && Array.isArray(e.roles)) ? e.roles : []; }
  function hasRole(e, r) { const R = roles(e); for (let i = 0; i < R.length; i++) if (R[i] === r) return true; return false; }
  function vendorKind(e) {
    const R = roles(e);
    for (let i = 0; i < R.length; i++) { const r = String(R[i]); if (r === 'vendor') return 'general'; if (r.indexOf('vendor:') === 0) return r.slice(7) || 'general'; }
    return null;
  }
  function isQuestGiver(e) { return hasRole(e, 'questgiver') || !!(questRefs && e && questRefs[e.npcId]); }
  function primaryRole(e) {
    if (isQuestGiver(e)) return 'questgiver';
    if (vendorKind(e)) return 'vendor';
    for (let i = 2; i < ROLE_PRIORITY.length; i++) if (hasRole(e, ROLE_PRIORITY[i])) return ROLE_PRIORITY[i];
    return 'flavor';
  }
  function roleLabel(e) {
    const R = roles(e);
    for (let i = 0; i < ROLE_PRIORITY.length; i++) {
      const pr = ROLE_PRIORITY[i];
      for (let k = 0; k < R.length; k++) { const r = String(R[k]); if (r === pr || (pr === 'vendor' && r.indexOf('vendor') === 0)) { const l = ROLE_LABEL[r] !== undefined ? ROLE_LABEL[r] : ROLE_LABEL[pr]; if (l) return l; } }
    }
    return RACE_LABEL[e.race] || '';
  }
  function nameColor(e) {
    if (isQuestGiver(e)) return ROLE_COLOR.questgiver;
    if (vendorKind(e) || hasRole(e, 'innkeeper') || hasRole(e, 'stablemaster') || hasRole(e, 'boatmaster')) return ROLE_COLOR.vendor;
    if (hasRole(e, 'trainer')) return ROLE_COLOR.trainer;
    return ROLE_COLOR.other;
  }
  function isEssential(e) { return isQuestGiver(e) || !!vendorKind(e) || hasRole(e, 'trainer') || hasRole(e, 'innkeeper') || hasRole(e, 'stablemaster') || hasRole(e, 'boatmaster') || hasRole(e, 'guard'); }
  function isChild(rec) { if (!rec) return false; if (rec.child === true) return true; const t = String(rec.title || '') + ' ' + (Array.isArray(rec.roles) ? rec.roles.join(' ') : ''); return /\b(child|lad|lass|boy|girl|youngster|urchin)\b/i.test(t); }
  function isFisher(rec) { if (!rec) return false; const t = String(rec.title || '') + ' ' + (Array.isArray(rec.roles) ? rec.roles.join(' ') : ''); return /\b(fisher|fisherman|fisherwoman|angler)\b/i.test(t) && !/vendor/i.test(t); }
  function collectQuestRefs() {
    const D = G.Data; const list = D && Array.isArray(D.quests) ? D.quests : null;
    if (!list) return null;
    const refs = Object.create(null);
    for (let i = 0; i < list.length; i++) { const q = list[i]; if (!q) continue; if (q.giver) refs[q.giver] = true; if (q.turnin) refs[q.turnin] = true; }
    return refs;
  }

  // ------------------------------------------------------------------------------------------------ ground / placement helpers
  function groundAt(x, z) {
    if (hasFn(G.Physics, 'groundY')) return G.Physics.groundY(x, z);
    if (hasFn(G.Terrain, 'height')) return G.Terrain.height(x, z);
    return 0;
  }
  function landOk(x, z) {
    const T = G.Terrain; if (!T) return true;
    if (hasFn(T, 'isWater') && T.isWater(x, z)) return false;
    if (hasFn(T, 'slope') && T.slope(x, z) > 0.6) return false;
    return true;
  }
  function freeAt(x, z, r) { if (hasFn(G.Physics, 'isFree')) return G.Physics.isFree(x, z, r || 0.4); return landOk(x, z); }
  function onRoad(x, z) { return hasFn(G.Terrain, 'onRoad') ? G.Terrain.onRoad(x, z) : 0; }
  function groundType(x, z) { return hasFn(G.Terrain, 'groundType') ? G.Terrain.groundType(x, z) : 'grass'; }
  function zoneLevel(zoneId) { const W = G.Data && G.Data.world; if (!W || !W.zones) return 1; for (let i = 0; i < W.zones.length; i++) { const z = W.zones[i]; if (z && z.id === zoneId) return Array.isArray(z.level) ? z.level[0] : (z.level || 1); } return 1; }
  function settle(ent, x, z) {
    let px = x, pz = z;
    if (!freeAt(px, pz, 0.4) && hasFn(G.Physics, 'nearestFree')) { const p = G.Physics.nearestFree(px, pz, 0.4); if (p && Math.abs(p.x - px) + Math.abs(p.z - pz) < 40) { px = p.x; pz = p.z; } }
    ent.pos.set(px, groundAt(px, pz), pz);
  }
  function yawTo(fromX, fromZ, toX, toZ) { return Math.atan2(-(toX - fromX), -(toZ - fromZ)); }

  // ------------------------------------------------------------------------------------------------ interior binding
  function spotPref(e) {
    if (vendorKind(e)) return SPOT_PREF.vendor;
    if (hasRole(e, 'innkeeper')) return SPOT_PREF.innkeeper;
    if (hasRole(e, 'boatmaster')) return SPOT_PREF.boatmaster;
    if (hasRole(e, 'trainer')) return SPOT_PREF.trainer;
    if (isQuestGiver(e)) return SPOT_PREF.questgiver;
    return SPOT_PREF.other;
  }
  function pickSpot(bld, e) {
    const spots = bld && bld.interiorSpots; if (!spots || !spots.length) return null;
    const pref = spotPref(e);
    for (let p = 0; p < pref.length; p++) for (let i = 0; i < spots.length; i++) { const s = spots[i]; if (s.role === pref[p] && !s.npc) return s; }
    for (let i = 0; i < spots.length; i++) { const s = spots[i]; if (!s.npc && s.role !== 'bed' && s.role !== 'boat') return s; }
    for (let p = 0; p < pref.length; p++) for (let i = 0; i < spots.length; i++) { const s = spots[i]; if (s.role === pref[p]) return s; }
    return spots[0];
  }
  function wantedRecipe(e) {
    if (hasRole(e, 'innkeeper')) return ['inn'];
    if (vendorKind(e)) return ['shop', 'market_stall', 'inn'];
    if (hasRole(e, 'stablemaster')) return ['stable'];
    if (hasRole(e, 'boatmaster')) return ['dock'];
    if (hasRole(e, 'trainer')) return ['elf_hall', 'dwarf_hall', 'inn', 'shop'];
    return null;
  }
  function findBuildingFor(e) {
    const B = G.Buildings; const all = B && Array.isArray(B.all) ? B.all : null;
    if (!all || !all.length) return null;
    for (let i = 0; i < all.length; i++) { const b = all[i]; if (b && b.npcInside && b.npcInside.indexOf(e.npcId) >= 0) return b; }
    const ref = e.data ? e.data.interior : null;
    if (ref == null || ref === false) return null;
    const town = e.town ? townById[e.town] : null;
    const list = (town && Array.isArray(town.buildingsPlaced) && town.buildingsPlaced.length) ? town.buildingsPlaced : all;
    const near = (filter) => { let best = null, bd = Infinity; for (let i = 0; i < list.length; i++) { const b = list[i]; if (!b || !b.enterable || !filter(b)) continue; const dx = b.x - e.home.x, dz = b.z - e.home.z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = b; } } return best; };
    if (typeof ref === 'number') { const b = list[ref | 0]; return (b && b.enterable) ? b : null; }
    if (ref === true || ref === 'auto') {
      const want = wantedRecipe(e);
      if (want) for (let w = 0; w < want.length; w++) { const b = near((bb) => bb.recipe === want[w]); if (b) return b; }
      return near(() => true);
    }
    if (typeof ref === 'string') {
      const s = ref.toLowerCase();
      const b = near((bb) => bb.id === ref || bb.recipe === s || (bb.name && bb.name.toLowerCase() === s) || (bb.spec && ((bb.spec.name && String(bb.spec.name).toLowerCase() === s) || bb.spec.id === ref)));
      return b;
    }
    if (typeof ref === 'object') {
      if (ref.building && ref.building.interiorSpots) return ref.building;
      if (typeof ref.index === 'number') {                       // registry convention: interior:{town, index}
        const tn = (ref.town && townById[ref.town]) || town;
        const placed = tn && Array.isArray(tn.buildingsPlaced) ? tn.buildingsPlaced : null;
        if (placed) {
          const spec = tn.buildings && tn.buildings[ref.index | 0];
          if (spec) for (let i = 0; i < placed.length; i++) { const b = placed[i]; if (b && b.spec && (b.spec === spec || (b.spec.recipe === spec.recipe && Math.abs(b.spec.x - spec.x) < 0.01 && Math.abs(b.spec.z - spec.z) < 0.01))) return b.enterable ? b : null; }
          const b = placed[ref.index | 0]; if (b && b.enterable) return b;
        }
        return near(() => true);
      }
      const s = ref.name ? String(ref.name).toLowerCase() : null, rec = ref.recipe ? String(ref.recipe) : null;
      const hx = typeof ref.x === 'number' ? ref.x : e.home.x, hz = typeof ref.z === 'number' ? ref.z : e.home.z;
      let best = null, bd = Infinity;
      for (let i = 0; i < list.length; i++) { const b = list[i]; if (!b || !b.enterable) continue; if (rec && b.recipe !== rec) continue; if (s && !(b.name && b.name.toLowerCase() === s)) continue; const dx = b.x - hx, dz = b.z - hz, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = b; } }
      return best;
    }
    return null;
  }
  function bindInterior(e) {
    if (e.interior) return true;
    const bld = findBuildingFor(e); if (!bld) return false;
    const spot = pickSpot(bld, e);
    if (spot) {
      spot.npc = e.npcId;
      let ox = 0, oz = 0;
      let shared = 0; for (let i = 0; i < bld.interiorSpots.length; i++) if (bld.interiorSpots[i] !== spot && bld.interiorSpots[i].npc && bld.interiorSpots[i].x === spot.x && bld.interiorSpots[i].z === spot.z) shared++;
      if (shared) { ox = Math.cos(spot.yaw) * 0.7 * shared; oz = -Math.sin(spot.yaw) * 0.7 * shared; }
      e.pos.set(spot.x + ox, spot.y, spot.z + oz); e.yaw = spot.yaw; e.spot = spot;
    } else { e.pos.set(bld.x, bld.y, bld.z); e.yaw = bld.yaw; }
    e.interior = bld; e.home.x = e.pos.x; e.home.y = e.pos.y; e.home.z = e.pos.z; e.home.yaw = e.yaw;
    const k = e.ai.kind;
    if (k !== 'bard' && k !== 'fisher' && k !== 'sitter') e.ai.kind = 'stationary';   // movers stand still indoors; performers keep performing
    e.ai.stationary = true; e.ai.curfew = false; e.ai.points = null; e.ai.hasTarget = false;
    if (G.Spatial && hasFn(G.Spatial, 'update')) G.Spatial.update(e);
    if (e.rig) { e.rig.group.position.copy(e.pos); e.rig.group.rotation.y = e.yaw; }
    return true;
  }
  function retryInteriors() {
    const B = G.Buildings; const n = B && Array.isArray(B.all) ? B.all.length : 0;
    if (n === lastBuildingCount) return;
    lastBuildingCount = n;
    for (let i = 0; i < npcs.length; i++) { const e = npcs[i]; if (!e.interior && e.wantsInterior) bindInterior(e); }
  }

  // ------------------------------------------------------------------------------------------------ NPC creation
  function makeNpc(rec) {
    if (!rec || !rec.id) { warn('[NPCs] registry entry without id skipped'); return null; }
    if (byNpcId[rec.id]) { warn('[NPCs] duplicate npc id ' + rec.id); return null; }
    const race = RACE_IDS.indexOf(rec.race) >= 0 ? rec.race : 'man';
    const gender = (rec.gender === 'female' || rec.gender === 'f') ? 'female' : 'male';
    const rd = (G.Data && G.Data.raceById && G.Data.raceById[race]) || null;
    const child = isChild(rec);
    const height = 1.8 * ((rd && rd.height) || 1) * (gender === 'female' ? 0.95 : 1) * (child ? 0.62 : 1);
    const px = rec.pos ? (+rec.pos.x || 0) : 0, pz = rec.pos ? (+rec.pos.z || 0) : 0;
    const level = clamp((+rec.level || zoneLevel(rec.zone)) | 0, 1, C.LEVEL_CAP || 80);
    const ent = {
      id: 'npc_' + rec.id, kind: 'npc', npcId: rec.id, typeId: rec.id,
      name: String(rec.name || titleCase(rec.id)), title: rec.title ? String(rec.title) : '', level,
      race, gender, cls: rec.cls || null, roles: Array.isArray(rec.roles) && rec.roles.length ? rec.roles.slice() : ['flavor'],
      zone: rec.zone || null, town: rec.town || null, faction: 'free', hostile: false, alive: true, dead: false,
      pos: new THREE.Vector3(px, 0, pz), yaw: +rec.yaw || 0, vel: new THREE.Vector3(), radius: 0.4, height,
      onGround: true, inWater: false, swimming: false,
      stats: { maxMorale: 100 + level * 20, maxPower: 100, speed: 1 }, morale: 100 + level * 20, power: 100, effects: [], cooldowns: {}, target: null, threat: {},
      mesh: null, rig: null, anim: 'idle', animTime: 0,
      dialogue: Array.isArray(rec.dialogue) ? rec.dialogue.filter(s => typeof s === 'string' && s) : [],
      interior: null, spot: null, wantsInterior: !!(rec.interior) || (Array.isArray(rec.roles) && rec.roles.indexOf('innkeeper') >= 0), child, data: rec, home: { x: px, y: 0, z: pz, yaw: +rec.yaw || 0 },
      ai: { kind: 'stationary', stationary: true, curfew: false, wait: 0, idx: 0, hasTarget: false, tx: 0, tz: 0, stuck: 0, mode: 'out', nextWave: 0, nextEmote: 0, homeT: 0, door: null, points: null, faceYaw: 0, outYaw: 0 },
      questMark: null, talkingTo: null, hidden: false, _line: 0, _phase: 0, _d2: Infinity, _keep: false, _lodAcc: 0, _lodN: 0, _markState: null, _marker: null, _glow: null, _spec: null,
      interact: null,
    };
    ent._phase = rngOf('phase:' + rec.id)() * TAU;
    ent._line = rngOf('line:' + rec.id).int(0, 3);
    ent.interact = { label: 'Talk to ' + ent.name, range: C.INTERACT_RANGE || 4, fn: function (e) { return talk(e && e.kind === 'npc' ? e : ent); } };
    settle(ent, px, pz); ent.home.y = ent.pos.y;
    assignBehaviour(ent);
    G.addEntity(ent);
    npcs.push(ent); byNpcId[rec.id] = ent;
    bindInterior(ent);
    return ent;
  }
  function assignBehaviour(e) {
    const ai = e.ai, rec = e.data || {};
    const role = primaryRole(e);
    const r = rngOf('ai:' + e.npcId);
    ai.stationary = true; ai.curfew = false; ai.kind = 'stationary';
    if (role === 'guard') { ai.kind = 'guard'; ai.stationary = false; }
    else if (role === 'bard') { ai.kind = 'bard'; ai.curfew = true; }
    else if (role === 'flavor') {
      if (e.child) { ai.kind = 'child'; ai.stationary = false; ai.curfew = true; }
      else if (isFisher(rec)) { ai.kind = 'fisher'; }
      else if (rec.sit === true || (rec.sit !== false && r() < 0.25 && claimSeat(e))) { ai.kind = 'sitter'; }
      else if (rec.wander === false) { ai.kind = 'stationary'; ai.curfew = true; }
      else { ai.kind = 'wander'; ai.stationary = false; ai.curfew = true; }
    }
    ai.nextWave = now() + 5 + r() * 20;
    ai.nextEmote = now() + 10 + r() * 20;
  }
  function claimSeat(e) {
    const B = G.Buildings; const all = B && Array.isArray(B.all) ? B.all : null;
    if (!all) return false;
    let best = null, bd = 30 * 30;
    for (let i = 0; i < all.length; i++) {
      const b = all[i]; if (!b || !b.interiorSpots || !b.interiorSpots.length || b.enterable) continue;
      const dx = b.x - e.home.x, dz = b.z - e.home.z, d = dx * dx + dz * dz; if (d > bd) continue;
      for (let k = 0; k < b.interiorSpots.length; k++) { const s = b.interiorSpots[k]; if (s.role === 'sit' && !s.npc) { best = s; bd = d; break; } }
    }
    if (!best) return false;
    best.npc = e.npcId; e.spot = best;
    e.pos.set(best.x, best.y, best.z); e.yaw = best.yaw; e.home.x = best.x; e.home.y = best.y; e.home.z = best.z; e.home.yaw = best.yaw;
    if (G.Spatial && hasFn(G.Spatial, 'update')) G.Spatial.update(e);
    return true;
  }

  // ------------------------------------------------------------------------------------------------ look / rig
  function pickFrom(arr, r) { return arr[Math.floor(r() * arr.length) % arr.length]; }
  function classForRace(race, r) {
    const pools = { man: ['captain', 'champion', 'hunter', 'minstrel'], dunedain: ['hunter', 'captain', 'loremaster'], rohirrim: ['captain', 'champion', 'warden'], elf: ['hunter', 'loremaster', 'minstrel', 'warden'], highelf: ['loremaster', 'runekeeper', 'hunter'], dwarf: ['guardian', 'champion', 'runekeeper'], stoutaxe: ['guardian', 'champion'], hobbit: ['burglar', 'minstrel', 'hunter', 'warden'], riverhobbit: ['burglar', 'hunter'], beorning: ['beorning' in (G.Data && G.Data.classById || {}) ? 'beorning' : 'brawler', 'champion'] };
    return pickFrom(pools[race] || pools.man, r);
  }
  function classArmour(cls) { const cd = G.Data && G.Data.classById && G.Data.classById[cls]; return (cd && cd.armourType) || 'medium'; }
  function tunicsFor(race) { return (race === 'hobbit' || race === 'riverhobbit') ? HOBBIT_TUNICS : (race === 'dwarf' || race === 'stoutaxe') ? DWARF_TUNICS : (race === 'elf' || race === 'highelf') ? ELF_TUNICS : MAN_TUNICS; }
  function specFor(e) {
    if (e._spec) return e._spec;
    const rec = e.data || {}; const r = rngOf('npc:' + e.npcId);
    const rd = (G.Data && G.Data.raceById && G.Data.raceById[e.race]) || null;
    const skin = rd && rd.skinTones && rd.skinTones.length ? rd.skinTones[r.int(0, rd.skinTones.length - 1)] : undefined;
    const hairColor = rd && rd.hairColors && rd.hairColors.length ? rd.hairColors[r.int(0, rd.hairColors.length - 1)] : undefined;
    const hairStyle = r.int(0, 4);
    const role = primaryRole(e), L = e.level || 1;
    const isElf = e.race === 'elf' || e.race === 'highelf', isDwarf = e.race === 'dwarf' || e.race === 'stoutaxe', isHobbit = e.race === 'hobbit' || e.race === 'riverhobbit';
    const spec = { race: e.race, gender: e.gender, name: e.name, title: e.title || roleLabel(e), level: L, nameColor: nameColor(e), nameplate: true, skin, hairColor, hairStyle, equipment: {}, look: {}, armourType: 'light' };
    if (e.child) spec.height = 0.62;
    if (rec.skin != null) spec.skin = rec.skin; if (rec.hairColor != null) spec.hairColor = rec.hairColor; if (rec.hairStyle != null) spec.hairStyle = rec.hairStyle; if (rec.beard != null) spec.beard = rec.beard;
    const gen = (slot, o) => { if (!hasFn(G.Items, 'generate')) return null; try { return G.Items.generate(Object.assign({ level: L, slot, seed: 'npc:' + e.npcId + ':' + slot }, o || {})); } catch (err) { report(err, 'npc gear'); return null; } };
    const tunic = (colors, legs) => { spec.look.chest = { type: 'light', color: pickFrom(colors, r), rarity: 'common' }; spec.look.legs = { type: 'light', color: legs || pickFrom(TROUSERS, r), rarity: 'common' }; };
    const boots = (type) => { spec.equipment.feet = gen('feet', { armourType: type || 'medium', rarity: 'common' }); };
    switch (role) {
      case 'guard': {
        const at = (isElf || isHobbit) ? 'medium' : 'heavy';
        spec.cls = at === 'heavy' ? 'guardian' : 'warden'; spec.armourType = at;
        const slots = ['chest', 'legs', 'feet', 'hands', 'head']; if (at === 'heavy') slots.push('shoulder');
        for (let i = 0; i < slots.length; i++) spec.equipment[slots[i]] = gen(slots[i], { armourType: at, rarity: 'uncommon', cls: spec.cls });
        spec.equipment.mainhand = gen('mainhand', { subtype: 'spear', rarity: 'uncommon', cls: 'warden' });
        spec.equipment.offhand = gen('offhand', { subtype: 'shield', rarity: 'uncommon', cls: 'guardian' });
        spec.equipment.back = gen('back', { armourType: 'light', rarity: 'common' });
        break;
      }
      case 'vendor': { tunic(isElf ? ELF_TUNICS : VENDOR_TUNICS); boots('light'); if (r() < 0.5) spec.equipment.head = gen('head', { armourType: 'light', rarity: 'common' }); break; }
      case 'innkeeper': { spec.look.chest = { type: 'light', color: 0xeadfc8, rarity: 'common' }; spec.look.legs = { type: 'light', color: 0x4a3a2a, rarity: 'common' }; boots('light'); break; }
      case 'trainer': {
        spec.cls = rec.cls || classForRace(e.race, r); spec.armourType = classArmour(spec.cls);
        const slots = ['chest', 'legs', 'feet', 'hands', 'shoulder', 'back'];
        for (let i = 0; i < slots.length; i++) spec.equipment[slots[i]] = gen(slots[i], { armourType: slots[i] === 'back' ? 'light' : spec.armourType, rarity: i < 2 ? 'rare' : 'uncommon', cls: spec.cls });
        spec.equipment.mainhand = gen('mainhand', { rarity: 'rare', cls: spec.cls, noTwoHanded: true });
        if (r() < 0.6) spec.equipment.ranged = gen('ranged', { rarity: 'uncommon', cls: spec.cls });
        break;
      }
      case 'bard': { spec.cls = 'minstrel'; tunic([0xc08a3a, 0x8a2a5a, 0x2a6a8a, 0x9a4a2a, 0x6a2a8a]); boots('light'); spec.look.mainhand = { shape: 'lute', color: 0x8a5a2a, rarity: 'common' }; if (r() < 0.5) spec.equipment.head = gen('head', { armourType: 'light', rarity: 'uncommon' }); break; }
      case 'questgiver': {
        spec.cls = rec.cls || classForRace(e.race, r); spec.armourType = (isElf || isHobbit) ? 'light' : classArmour(spec.cls);
        if (isHobbit) {                                           // Shire folk: bright waistcoats, not armour
          tunic(HOBBIT_TUNICS); boots('light');
          if (r() < 0.4) spec.equipment.head = gen('head', { armourType: 'light', rarity: 'uncommon' });
        } else {
          spec.equipment.chest = gen('chest', { armourType: spec.armourType, rarity: 'uncommon', cls: spec.cls });
          spec.equipment.legs = gen('legs', { armourType: spec.armourType, rarity: 'uncommon', cls: spec.cls });
          spec.equipment.feet = gen('feet', { armourType: spec.armourType, rarity: 'common', cls: spec.cls });
          if (r() < 0.55) spec.equipment.mainhand = gen('mainhand', { rarity: 'uncommon', cls: spec.cls, noTwoHanded: true });
          if (isElf) spec.look.chest = { type: 'light', color: pickFrom(ELF_TUNICS, r), rarity: 'uncommon' };
        }
        spec.equipment.back = gen('back', { armourType: 'light', rarity: 'uncommon' });
        break;
      }
      case 'stablemaster': { spec.armourType = 'medium'; spec.equipment.chest = gen('chest', { armourType: 'medium', rarity: 'common' }); spec.look.legs = { type: 'light', color: 0x4a3a2a, rarity: 'common' }; boots('medium'); break; }
      case 'boatmaster': { tunic([0x3a5a7a, 0x4a6a8a, 0x5a6a6a, 0x2a4a6a]); boots('medium'); spec.equipment.head = gen('head', { armourType: 'light', rarity: 'common' }); break; }
      default: {
        tunic(tunicsFor(e.race));
        if (isDwarf) boots('heavy'); else if (r() < 0.7 || isElf) boots('light');
        if (isElf && r() < 0.5) spec.equipment.back = gen('back', { armourType: 'light', rarity: 'common' });
        if (!isHobbit && r() < 0.3) spec.equipment.head = gen('head', { armourType: 'light', rarity: 'common' });
      }
    }
    if (e.gender === 'female' && !spec.cls && r() < 0.5 && role !== 'guard') spec.robe = false;
    e._spec = spec;
    return spec;
  }
  function tryAttachScene() {
    if (!scene) { const sc = (G.Game && G.Game.scene) || (G.Buildings && G.Buildings.scene) || null; if (sc && sc.isScene) scene = sc; }
    if (scene && root.parent !== scene) scene.add(root);
  }
  function setScene(sc) { if (sc && sc.isScene) { scene = sc; tryAttachScene(); } }
  function buildRig(e) {
    if (e.rig || !hasFn(G.Chars, 'buildHumanoid')) return false;
    let rig = null;
    try { rig = G.Chars.buildHumanoid(specFor(e)); } catch (err) { report(err, 'NPC rig ' + e.npcId); }
    if (!rig || !rig.group) return false;
    rig.group.position.copy(e.pos); rig.group.rotation.y = e.yaw; rig.group.name = 'npc:' + e.npcId;
    tryAttachScene(); root.add(rig.group);
    e.rig = rig; e.mesh = rig.group; e._lodAcc = 0; e._lodN = 0;
    const k = e.ai.kind;
    try {
      if (k === 'fisher') { if (hasFn(rig, 'setProp')) rig.setProp('rod'); rig.setAnim('fish_wait'); }
      else if (k === 'sitter') rig.setAnim('sit');
      else if (k === 'bard') rig.setAnim('emote_dance');
    } catch (err) { report(err, 'NPC anim'); }
    rendered.push(e);
    applyMarker(e, e._markState);
    if (e.hidden) rig.group.visible = false;
    return true;
  }
  function disposeRig(e) {
    releaseMarker(e); stopGlow(e);
    const rig = e.rig; if (!rig) return;
    if (rig.group && rig.group.parent) rig.group.parent.remove(rig.group);
    try { rig.dispose(); } catch (err) { report(err, 'NPC dispose'); }
    e.rig = null; e.mesh = null;
    const i = rendered.indexOf(e); if (i >= 0) rendered.splice(i, 1);
  }
  function refreshRenderSet(fx, fz) {
    const R2 = RENDER_DIST * RENDER_DIST, RH2 = (RENDER_DIST + RENDER_HYST) * (RENDER_DIST + RENDER_HYST);
    cand.length = 0;
    for (let i = 0; i < npcs.length; i++) {
      const e = npcs[i]; const dx = e.pos.x - fx, dz = e.pos.z - fz; e._d2 = dx * dx + dz * dz;
      if (e._d2 < R2 || (e.rig && e._d2 < RH2)) cand.push(e);
    }
    cand.sort(byD2);
    for (let i = 0; i < cand.length; i++) cand[i]._keep = i < MAX_RIGS;
    for (let i = rendered.length - 1; i >= 0; i--) { const e = rendered[i]; if (!e._keep || e._d2 > RH2) disposeRig(e); }
    pendingBuild.length = 0;
    for (let i = 0; i < cand.length; i++) { const e = cand[i]; if (e._keep && !e.rig && !e.hidden) pendingBuild.push(e); e._keep = false; }
    cand.length = 0;
    refreshNodeSet(fx, fz);
  }
  function byD2(a, b) { return a._d2 - b._d2; }
  function drainBuilds() {
    let n = 0;
    while (pendingBuild.length && n < BUILDS_PER_FRAME) { const e = pendingBuild.shift(); if (e.rig || e.hidden) continue; if (buildRig(e)) n++; }
  }

  // ------------------------------------------------------------------------------------------------ quest markers
  const markMat = Object.create(null), markPool = [];
  function markerMaterial(state) {
    let mat = markMat[state]; if (mat) return mat;
    const d = MARK_DEF[state] || MARK_DEF.available;
    const tex = G.canvasTexture(96, 96, function (ctx, w, h) {
      ctx.clearRect(0, 0, w, h);
      ctx.font = 'bold 82px "Trebuchet MS", "Segoe UI", Arial, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.lineJoin = 'round';
      ctx.lineWidth = 14; ctx.strokeStyle = 'rgba(0,0,0,0.9)'; ctx.strokeText(d.glyph, w / 2, h / 2 + 4);
      ctx.fillStyle = d.color; ctx.fillText(d.glyph, w / 2, h / 2 + 4);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.strokeText(d.glyph, w / 2, h / 2 + 4);
    }, { wrap: false, mipmaps: false });
    tex.userData.shared = true;
    mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: false });
    mat.name = 'npc_marker_' + state;
    markMat[state] = mat;
    return mat;
  }
  function applyMarker(e, state) {
    if (!e.rig) { e._markState = state; return; }
    if (e._marker && e._markState === state) return;
    releaseMarker(e);
    e._markState = state;
    if (!state) return;
    let sp = markPool.pop();
    const mat = markerMaterial(state);
    if (!sp) sp = new THREE.Sprite(mat); else sp.material = mat;
    sp.visible = true; sp.center.set(0.5, 0); sp.renderOrder = 11; sp.scale.set(0.6, 0.6, 1); sp.position.set(0, e.rig.height + 0.9, 0);
    e.rig.group.add(sp); e._marker = sp;
  }
  function releaseMarker(e) {
    const sp = e._marker; if (!sp) return;
    if (sp.parent) sp.parent.remove(sp);
    sp.visible = false; if (markPool.length < 64) markPool.push(sp);
    e._marker = null;
  }
  function activeCountFor(e) {
    const Q = G.Quests; if (!Q || !hasFn(Q, 'active')) return 0;
    let list = null; try { list = Q.active(); } catch (err) { return 0; }
    if (!list || !list.length) return 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const id = questId(list[i]); const qd = questData(list[i]); if (!qd) continue;
      const tin = qd.turnin || qd.giver; if (tin !== e.npcId) continue;
      const st = Q.state && id ? Q.state[id] : null;
      if (!st || st.status === 'active') n++;
    }
    return n;
  }
  function markerState(e) {
    const Q = G.Quests; if (!Q || !e) return null;
    try {
      if (hasFn(Q, 'turnins')) { const t = Q.turnins(e.npcId); if (t && t.length) return 'turnin'; }
      if (hasFn(Q, 'available')) { const a = Q.available(e.npcId); if (a && a.length) return 'available'; }
      if (activeCountFor(e) > 0) return 'active';
    } catch (err) { report(err, 'markerState'); }
    return null;
  }
  function refreshMarkers() {
    for (let i = 0; i < npcs.length; i++) {
      const e = npcs[i]; const st = markerState(e);
      e.questMark = st ? MARK_DEF[st].hud : null;
      if (e.rig) applyMarker(e, st); else e._markState = st;
    }
  }
  function updateMarker(e, d2, t, camera) {
    const sp = e._marker; if (!sp) return;
    if (d2 > MARKER_DIST * MARKER_DIST || e.hidden) { sp.visible = false; return; }
    sp.visible = true;
    // constant on-screen size like the nameplates: scale by CAMERA distance (the player may stand right next to the NPC)
    let d;
    if (camera && camera.position) { const dx = e.pos.x - camera.position.x, dy = e.pos.y + e.height - camera.position.y, dz = e.pos.z - camera.position.z; d = Math.sqrt(dx * dx + dy * dy + dz * dz); }
    else d = Math.sqrt(d2);
    const s = clamp(d * 0.062, 0.3, 6) * 0.85;
    sp.scale.set(s, s, 1);
    const plate = e.rig.nameplate; const plateH = plate && plate.visible ? plate.scale.y : 0;
    const y = e.rig.height + 0.15 + plateH + 0.1 + Math.sin(t * 2.4 + e._phase) * 0.06 * (1 + s);
    sp.position.y = y;
    e._markerY = y + s * 0.45;                                  // world-space centre of the glyph (glow anchor)
  }
  function stopGlow(e) { if (e._glow) { try { if (e._glow.alive && hasFn(e._glow, 'stop')) e._glow.stop(); else if (hasFn(G.FX, 'stop')) G.FX.stop(e._glow); } catch (err) { /* handle may already be dead */ } e._glow = null; } }
  function updateGlow(e, d2) {
    if (e._markState === 'turnin' && !e.hidden && d2 < GLOW_DIST * GLOW_DIST) {
      const y = e.pos.y + (e._markerY || e.height + 0.9);
      if (!e._glow || !e._glow.alive) { e._glow = null; if (hasFn(G.FX, 'spawn')) { _v2.set(e.pos.x, y, e.pos.z); e._glow = fx('questmark_glow', _v2, { loop: true, color: 0xffd44a, scale: 0.7 }); } }
      else if (e._glow.pos) e._glow.pos.set(e.pos.x, y, e.pos.z);   // the glow rides on the bobbing marker
    } else if (e._glow) stopGlow(e);
  }

  // ------------------------------------------------------------------------------------------------ movement & behaviour
  function moveToward(e, tx, tz, speed, dt) {          // → 0 moving, 1 arrived, 2 stuck
    const dx = tx - e.pos.x, dz = tz - e.pos.z, d = Math.sqrt(dx * dx + dz * dz);
    if (d < 0.4) { e.vel.x = 0; e.vel.z = 0; e.ai.stuck = 0; return 1; }
    const vx = dx / d * speed, vz = dz / d * speed;
    const ox = e.pos.x, oz = e.pos.z;
    _v.set(vx, 0, vz);
    if (hasFn(G.Physics, 'moveEntity')) G.Physics.moveEntity(e, _v, dt);
    else { e.pos.x += vx * dt; e.pos.z += vz * dt; e.pos.y = groundAt(e.pos.x, e.pos.z); e.vel.set(vx, 0, vz); if (G.Spatial && hasFn(G.Spatial, 'update')) G.Spatial.update(e); }
    const mx = e.pos.x - ox, mz = e.pos.z - oz, moved = Math.sqrt(mx * mx + mz * mz);
    if (moved < speed * dt * 0.25) { e.ai.stuck += dt; if (e.ai.stuck > 1.2) { e.ai.stuck = 0; e.vel.x = 0; e.vel.z = 0; return 2; } } else e.ai.stuck = 0;
    e.yaw = alerp(e.yaw, Math.atan2(-vx, -vz), Math.min(1, dt * 8));
    return 0;
  }
  function standStill(e, dt, faceYaw) {
    e.vel.x = 0; e.vel.z = 0;
    if (typeof faceYaw === 'number') e.yaw = alerp(e.yaw, faceYaw, Math.min(1, dt * 3));
    if (!e.ai.stationary && hasFn(G.Physics, 'moveEntity')) { _v.set(0, 0, 0); G.Physics.moveEntity(e, _v, dt); }
  }
  function townOf(e) { return e.town ? townById[e.town] : null; }
  function buildPatrol(e) {
    const ai = e.ai, t = townOf(e), hx = e.home.x, hz = e.home.z;
    let ox = 0, oz = -1;
    if (t && t.pos) { ox = hx - t.pos.x; oz = hz - t.pos.z; const l = Math.sqrt(ox * ox + oz * oz) || 1; ox /= l; oz /= l; }
    else { ox = -Math.sin(e.home.yaw); oz = -Math.cos(e.home.yaw); }
    const tx = -oz, tz = ox;
    const r = rngOf('patrol:' + e.npcId);
    const pts = [];
    const tryAdd = (x, z) => { if (pts.length >= 3) return; if (!landOk(x, z)) return; if (!freeAt(x, z, 0.4)) { if (hasFn(G.Physics, 'nearestFree')) { const p = G.Physics.nearestFree(x, z, 0.4); if (!p || Math.abs(p.x - x) + Math.abs(p.z - z) > 6) return; x = p.x; z = p.z; } else return; } pts.push({ x, z }); };
    const span = 6 + r() * 4;
    tryAdd(hx + tx * span, hz + tz * span); tryAdd(hx - tx * span, hz - tz * span);
    if (r() < 0.6) tryAdd(hx + ox * (4 + r() * 3), hz + oz * (4 + r() * 3));
    if (pts.length < 2) { pts.length = 0; pts.push({ x: hx, z: hz }, { x: hx + tx * 3, z: hz + tz * 3 }); }
    ai.points = pts; ai.idx = 0; ai.outYaw = Math.atan2(-ox, -oz); ai.faceYaw = ai.outYaw; ai.wait = 2 + r() * 3;
  }
  function pickWanderTarget(e) {
    const ai = e.ai, t = townOf(e);
    const cx = t && t.pos ? t.pos.x : e.home.x, cz = t && t.pos ? t.pos.z : e.home.z;
    const R = t ? Math.min(t.radius || 40, 45) : 25;
    let bestX = e.home.x, bestZ = e.home.z, bestS = -Infinity;
    for (let i = 0; i < 8; i++) {
      const a = rand() * TAU, rr = 5 + rand() * (R - 5);
      const x = cx + Math.sin(a) * rr, z = cz + Math.cos(a) * rr;
      if (!landOk(x, z) || !freeAt(x, z, 0.4)) continue;
      const hdx = x - e.home.x, hdz = z - e.home.z; if (hdx * hdx + hdz * hdz > 55 * 55) continue;
      const gt = groundType(x, z);
      let s = onRoad(x, z) * 2 + (gt === 'dirt' ? 1 : gt === 'road' ? 2 : gt === 'wood' ? 0.5 : 0) + rand() * 0.6;
      const ddx = x - e.pos.x, ddz = z - e.pos.z; s -= Math.sqrt(ddx * ddx + ddz * ddz) * 0.02;
      if (s > bestS) { bestS = s; bestX = x; bestZ = z; }
    }
    ai.tx = bestX; ai.tz = bestZ; ai.hasTarget = true;
  }
  function pickChildTarget(e) {
    const ai = e.ai;
    if (!ai.points) {
      const r = rngOf('child:' + e.npcId), pts = [];
      for (let i = 0; i < 2; i++) { for (let a = 0; a < 6; a++) { const ang = r() * TAU, rr = 6 + r() * 7; const x = e.home.x + Math.sin(ang) * rr, z = e.home.z + Math.cos(ang) * rr; if (landOk(x, z) && freeAt(x, z, 0.4)) { pts.push({ x, z }); break; } } }
      if (pts.length < 2) pts.push({ x: e.home.x, z: e.home.z });
      if (pts.length < 2) pts.push({ x: e.home.x + 4, z: e.home.z });
      ai.points = pts; ai.idx = 0;
    }
    ai.idx = (ai.idx + 1) % ai.points.length;
    ai.tx = ai.points[ai.idx].x; ai.tz = ai.points[ai.idx].z; ai.hasTarget = true;
  }
  function isNight() { const h = dayTime(); return h >= NIGHT_START || h < NIGHT_END; }
  function findDoor(e) {
    const B = G.Buildings; const all = B && Array.isArray(B.all) ? B.all : null; if (!all) return null;
    let best = null, bd = 60 * 60, inn = null, innD = 90 * 90;
    for (let i = 0; i < all.length; i++) {
      const b = all[i]; if (!b || !b.enterable || !b.door || !b.door.pos) continue;
      if (b.town && e.town && b.town !== e.town) continue;
      const dx = b.door.pos.x - e.pos.x, dz = b.door.pos.z - e.pos.z, d = dx * dx + dz * dz;
      if (b.recipe === 'inn' && d < innD) { innD = d; inn = b; }
      if (d < bd) { bd = d; best = b; }
    }
    const b = inn || best; if (!b) return null;
    const fwd = 1.2; return { x: b.door.pos.x - Math.sin(b.door.yaw) * fwd, z: b.door.pos.z - Math.cos(b.door.yaw) * fwd, bld: b };
  }
  function hide(e) {
    if (e.hidden) return;
    e.hidden = true; hiddenCount++;
    e.vel.set(0, 0, 0);
    if (e.interact) { e._interact = e.interact; e.interact = null; }
    if (e.rig) e.rig.group.visible = false;
    if (e._marker) e._marker.visible = false;
    stopGlow(e);
  }
  function unhide(e, atDoor) {
    if (!e.hidden) return;
    e.hidden = false; hiddenCount = Math.max(0, hiddenCount - 1);
    if (e._interact) { e.interact = e._interact; e._interact = null; }
    const d = atDoor && e.ai.door; if (d) settle(e, d.x, d.z); else settle(e, e.home.x, e.home.z);
    if (G.Spatial && hasFn(G.Spatial, 'update')) G.Spatial.update(e);
    e.ai.hasTarget = false; e.ai.wait = 0.5; e.ai.mode = 'out';
    if (e.rig) { e.rig.group.visible = true; e.rig.group.position.copy(e.pos); }
  }
  function curfew(e, dt, dp2) {
    const ai = e.ai; const night = isNight();
    if (night) {
      if (e.hidden) return true;
      if (ai.mode !== 'home') { ai.mode = 'home'; ai.door = findDoor(e); ai.homeT = 0; ai.hasTarget = false; if (e.rig && (ai.kind === 'bard')) e.rig.setAnim('idle', true); }
      ai.homeT += dt;
      if (ai.door) {
        const res = moveToward(e, ai.door.x, ai.door.z, WALK, dt);
        if (res !== 0 || ai.homeT > 14) hide(e);
      } else {
        standStill(e, dt, e.home.yaw);
        if (dp2 > 30 * 30 || ai.homeT > 14) hide(e);
      }
      return true;
    }
    if (e.hidden) { unhide(e, true); if (e.rig && ai.kind === 'bard') e.rig.setAnim('emote_dance'); return true; }
    if (ai.mode === 'home') { ai.mode = 'out'; ai.hasTarget = false; ai.wait = 0; if (e.rig && ai.kind === 'bard') e.rig.setAnim('emote_dance'); }
    return false;
  }
  function nightTick() {
    const night = isNight();
    for (let i = 0; i < npcs.length; i++) {
      const e = npcs[i];
      if (!e.ai.curfew || e.interior) continue;
      if (night) { if (!e.hidden && !e.rig) hide(e); }
      else if (e.hidden && !e.rig) unhide(e, false);
    }
  }
  function behave(e, dt, px, pz, dp2) {
    const ai = e.ai, t = now();
    if (e.talkingTo && dp2 > TALK_DROP * TALK_DROP) endTalk(e);
    if (ai.curfew && !e.interior && curfew(e, dt, dp2)) return;
    const dxp = px - e.pos.x, dzp = pz - e.pos.z;
    if (e.talkingTo || (ai.stationary && dp2 < FACE_DIST * FACE_DIST && ai.kind !== 'sitter' && ai.kind !== 'fisher')) {
      standStill(e, dt, Math.atan2(-dxp, -dzp));
      if (!e.talkingTo && ai.kind !== 'bard' && e.rig && t > ai.nextWave && dp2 < 9) { e.rig.setAnim('emote_wave'); ai.nextWave = t + 25 + rand() * 30; }
      return;
    }
    switch (ai.kind) {
      case 'guard': {
        if (!ai.points) buildPatrol(e);
        if (ai.wait > 0) { ai.wait -= dt; standStill(e, dt, ai.faceYaw); return; }
        const p = ai.points[ai.idx];
        const res = moveToward(e, p.x, p.z, WALK, dt);
        if (res !== 0) { ai.idx = (ai.idx + 1) % ai.points.length; ai.wait = 3 + rand() * 5; ai.faceYaw = (ai.idx === 0) ? ai.outYaw : e.yaw; }
        return;
      }
      case 'wander': {
        if (ai.wait > 0) { ai.wait -= dt; standStill(e, dt); if (ai.wait <= 0) pickWanderTarget(e); return; }
        if (!ai.hasTarget) pickWanderTarget(e);
        const res = moveToward(e, ai.tx, ai.tz, WALK, dt);
        if (res !== 0) { ai.hasTarget = false; ai.wait = 4 + rand() * 9; if (e.rig && rand() < 0.35) e.rig.setAnim(dp2 < 49 ? 'emote_wave' : 'emote_bow'); }
        return;
      }
      case 'child': {
        if (ai.wait > 0) { ai.wait -= dt; standStill(e, dt); if (ai.wait <= 0) pickChildTarget(e); return; }
        if (!ai.hasTarget) pickChildTarget(e);
        const res = moveToward(e, ai.tx, ai.tz, RUN * 0.72, dt);
        if (res !== 0) { ai.hasTarget = false; ai.wait = 0.6 + rand() * 2.2; if (e.rig && rand() < 0.4) e.rig.setAnim('emote_cheer'); }
        return;
      }
      case 'bard': {
        standStill(e, dt, e.home.yaw);
        if (!e.rig) return;
        if (t > ai.nextEmote) { if (ai.resting) { ai.resting = false; e.rig.setAnim('emote_dance'); ai.nextEmote = t + 18 + rand() * 20; } else { ai.resting = true; e.rig.setAnim('idle', true); if (dp2 < 64) e.rig.setAnim('emote_bow'); ai.nextEmote = t + 4 + rand() * 4; } }
        return;
      }
      case 'fisher': {
        standStill(e, dt, e.home.yaw);
        if (!e.rig) return;
        if (t > ai.nextEmote) { if (ai.reeling) { ai.reeling = false; e.rig.setAnim('fish_wait'); ai.nextEmote = t + 18 + rand() * 20; } else { ai.reeling = true; e.rig.setAnim('fish_reel'); ai.nextEmote = t + 1.6; } }
        return;
      }
      case 'sitter': { standStill(e, dt, e.home.yaw); if (e.rig && e.rig.anim !== 'sit' && !e.rig.oneShot && e.rig.state !== 'sit') e.rig.setAnim('sit'); return; }
      default: {
        standStill(e, dt, e.home.yaw);
        if (e.rig && !e.interior && t > ai.nextEmote && dp2 < 36 * 36) { ai.nextEmote = t + 25 + rand() * 40; if (rand() < 0.5) e.rig.setAnim('emote_wave'); }
      }
    }
  }
  function interiorVisible(b) { return !b || !b.int || b.int.visible || b.inside; }
  function updateNpc(e, dt, px, pz, camera, t) {
    const rig = e.rig; if (!rig) return;
    const dx = e.pos.x - px, dz = e.pos.z - pz, d2 = dx * dx + dz * dz; e._d2 = d2;
    behave(e, dt, px, pz, d2);
    if (e.hidden) { rig.group.visible = false; return; }
    const g = rig.group;
    g.position.copy(e.pos); g.rotation.y = e.yaw;
    g.visible = !e.interior || interiorVisible(e.interior);
    if (!g.visible) return;
    const lod = d2 > 6400 ? 3 : d2 > 1600 ? 2 : 1;
    e._lodAcc += dt; e._lodN++;
    if (e._lodN % lod === 0) { try { rig.play(e._lodAcc, e); } catch (err) { report(err, 'NPC play'); } e._lodAcc = 0; }
    const np = rig.nameplate;
    if (np) { const vis = d2 < NAMEPLATE_DIST * NAMEPLATE_DIST; np.visible = vis; if (vis && camera && hasFn(G.Chars, 'updateNameplate')) G.Chars.updateNameplate(np, camera); }
    updateMarker(e, d2, t, camera);
    updateGlow(e, d2);
  }

  // ------------------------------------------------------------------------------------------------ dialogue
  function greetingLines(e) {
    if (e.dialogue && e.dialogue.length) return e.dialogue;
    const role = e.child ? 'child' : primaryRole(e);
    const base = GREET[role] || GREET.flavor;
    const race = GREET_RACE[e.race];
    if (!e._greet) { e._greet = race ? base.concat([race]) : base.slice(); }
    return e._greet;
  }
  function greeting(e) { if (!e) return ''; const lines = greetingLines(e); if (!lines.length) return 'Well met.'; return lines[((e._line | 0) % lines.length + lines.length) % lines.length]; }
  function nextLine(e) { if (!e) return ''; e._line = (e._line | 0) + 1; return greeting(e); }
  function routesFrom(townId) { const W = G.Data && G.Data.world; const out = []; if (!W || !Array.isArray(W.travelRoutes) || !townId) return out; for (let i = 0; i < W.travelRoutes.length; i++) { const r = W.travelRoutes[i]; if (r && r.from === townId) out.push(r); } return out; }
  function dockFor(e) {
    const W = G.Data && G.Data.world; if (!W || !Array.isArray(W.docks)) return null;
    const ref = e.data && e.data.dock;
    if (ref) { if (W.dockById && W.dockById[ref]) return W.dockById[ref]; for (let i = 0; i < W.docks.length; i++) if (W.docks[i] && W.docks[i].id === ref) return W.docks[i]; }
    let best = null, bd = Infinity; for (let i = 0; i < W.docks.length; i++) { const d = W.docks[i]; if (!d) continue; if (e.town && d.town === e.town) return d; if (d.pos) { const dx = d.pos.x - e.pos.x, dz = d.pos.z - e.pos.z, dd = dx * dx + dz * dz; if (dd < bd) { bd = dd; best = d; } } } return bd < 200 * 200 ? best : null; }
  function tradeLabel(kind) { return kind === 'armour' ? 'Trade — armour' : kind === 'weapons' ? 'Trade — weapons' : kind === 'food' ? 'Trade — food & drink' : kind === 'fishing' ? 'Trade — fishing supplies' : 'Trade'; }
  function dialogueOptions(e) {
    const out = [];
    if (!e) return out;
    const Q = G.Quests;
    if (Q) {
      try {
        if (hasFn(Q, 'available')) { const av = Q.available(e.npcId) || []; for (let i = 0; i < av.length; i++) { const q = questData(av[i]), id = questId(av[i]); out.push({ kind: 'quest', icon: '!', questId: id, quest: q, label: (q && q.name) || String(id), level: q && q.level, type: q && q.type, status: 'available' }); } }
        if (hasFn(Q, 'turnins')) { const tu = Q.turnins(e.npcId) || []; for (let i = 0; i < tu.length; i++) { const q = questData(tu[i]), id = questId(tu[i]); out.push({ kind: 'turnin', icon: '?', questId: id, quest: q, label: (q && q.name) || String(id), level: q && q.level, type: q && q.type, status: 'complete' }); } }
        if (hasFn(Q, 'active')) {
          const list = Q.active() || [];
          for (let i = 0; i < list.length; i++) {
            const id = questId(list[i]), q = questData(list[i]); if (!q) continue;
            if ((q.turnin || q.giver) !== e.npcId) continue;
            const st = Q.state && id ? Q.state[id] : null; if (st && st.status !== 'active') continue;
            let dup = false; for (let k = 0; k < out.length; k++) if (out[k].questId === id) { dup = true; break; }
            if (dup) continue;
            out.push({ kind: 'progress', icon: '?', questId: id, quest: q, label: q.name || String(id), text: (q.text && q.text.progress) || 'You have not yet finished what I asked of you.', status: 'active' });
          }
        }
      } catch (err) { report(err, 'dialogueOptions'); }
    }
    const vk = vendorKind(e);
    if (vk) out.push({ kind: 'trade', icon: '⚖', label: tradeLabel(vk), vendorKind: vk, action: function () { return openVendor(e); } });
    if (hasRole(e, 'trainer')) out.push({ kind: 'train', icon: '📜', label: 'Train abilities', action: function () { if (hasFn(G.UI, 'openPanel')) G.UI.openPanel('abilities'); return true; } });
    if (hasRole(e, 'stablemaster')) out.push({ kind: 'travel', icon: '🐎', label: 'Swift travel', routes: routesFrom(e.town), action: function () { return openTravel(e); } });
    if (hasRole(e, 'boatmaster')) { const dock = dockFor(e); out.push({ kind: 'sail', icon: '⛵', label: 'Sail', dock, action: function () { return openDock(e); } }); }
    if (hasRole(e, 'innkeeper')) out.push({ kind: 'rest', icon: '🔥', label: 'Rest & Save', action: function () { return rest(e); } });
    const lines = greetingLines(e);
    if (lines.length > 1) out.push({ kind: 'talk', icon: '💬', label: hasRole(e, 'guard') ? 'Any news?' : hasRole(e, 'bard') ? 'Play me a song' : 'Tell me more', action: function () { return nextLine(e); } });
    return out;
  }
  function choose(e, opt) {
    if (!opt) return null;
    if (typeof opt.action === 'function') { try { return opt.action(e); } catch (err) { report(err, 'dialogue option ' + opt.kind); return null; } }
    return opt.quest || null;
  }
  function duck(on) {
    if (on === ducked) return;
    ducked = on;
    if (hasFn(G.Audio, 'duck')) { try { G.Audio.duck(on); } catch (err) { /* optional */ } }
  }
  function maybeUnduck() {
    if (!ducked) return;
    if (panelOpen('dialogue') || panelOpen('vendor') || panelOpen('travel')) return;
    duck(false);
  }
  function talk(e) {
    if (!e || e.kind !== 'npc' || e.hidden) return false;
    const p = player();
    if (talking && talking !== e) endTalk(talking);
    e.talkingTo = p || true; talking = e;
    if (p && p.pos) { e.yaw = yawTo(e.pos.x, e.pos.z, p.pos.x, p.pos.z); if (e.rig) e.rig.group.rotation.y = e.yaw; }
    e.vel.set(0, 0, 0);
    sfx('ui_open'); duck(true); duckWatchT = 0;
    if (hasFn(G.Quests, 'onTalk')) { try { G.Quests.onTalk(e.npcId, e); } catch (err) { report(err, 'Quests.onTalk'); } }
    const text = greeting(e); e._line = (e._line | 0) + 1;
    const options = dialogueOptions(e);
    let opened = false;
    if (G.UI && G.UI.Dialogue && hasFn(G.UI.Dialogue, 'open')) { try { G.UI.Dialogue.open(e, text, options); opened = true; } catch (err) { report(err, 'Dialogue.open'); } }
    if (!opened) { chat(text, 'say', e.name); duckWatchT = 2.5; }
    markersDirty = true;
    emit('npcTalk', e, options);
    return true;
  }
  function endTalk(e) {
    e = e || talking; if (!e) return;
    e.talkingTo = null;
    if (talking === e) talking = null;
    maybeUnduck();
    emit('npcTalkEnd', e);
  }
  function rest(e) {
    const p = player(); if (!p) return false;
    let healed = false;
    if (hasFn(G.Combat, 'heal')) { try { G.Combat.heal(e || p, p, 1e9); healed = true; } catch (err) { report(err, 'rest heal'); } }
    if (p.stats) { if (typeof p.stats.maxMorale === 'number' && (!healed || p.morale < p.stats.maxMorale)) p.morale = p.stats.maxMorale; if (typeof p.stats.maxPower === 'number') p.power = p.stats.maxPower; }
    if (Array.isArray(p.effects)) { for (let i = p.effects.length - 1; i >= 0; i--) { const ef = p.effects[i]; if (ef && (ef.kind === 'debuff' || ef.kind === 'dot' || ef.kind === 'slow')) { if (hasFn(G.Combat, 'removeEffect')) { try { G.Combat.removeEffect(p, ef.id); } catch (err) { /* ignore */ } } else p.effects.splice(i, 1); } } }
    let saved = false;
    if (hasFn(G.Save, 'save')) { try { saved = G.Save.save() !== false; } catch (err) { report(err, 'rest save'); } }
    sfx('heal'); if (p.pos) fx('heal', p.pos, { target: p, yOff: 0.2 });
    notify(saved ? 'You rest by the fire. Game saved.' : 'You rest by the fire.', 'system');
    emit('rested', e);
    return { close: true, text: 'Sleep well, friend. The fire will keep till morning.' };
  }
  function openTravel(e) {
    if (G.UI && G.UI.Travel && hasFn(G.UI.Travel, 'openStable')) { try { G.UI.Travel.openStable(e); return true; } catch (err) { report(err, 'Travel.openStable'); } }
    notify('The stable-master has no routes ready.', 'warning');
    return false;
  }
  function openDock(e) {
    const dock = dockFor(e);
    if (!dock) { notify('There is no dock nearby.', 'warning'); return false; }
    if (G.UI && G.UI.Travel && hasFn(G.UI.Travel, 'openDock')) { try { G.UI.Travel.openDock(dock, e); return true; } catch (err) { report(err, 'Travel.openDock'); } }
    return false;
  }

  // ------------------------------------------------------------------------------------------------ vendors
  function _addGold(n) {
    n = Math.max(0, Math.round(+n || 0)); if (!n) return true;
    if (hasFn(G.Progress, 'addGold')) { try { G.Progress.addGold(n); return true; } catch (err) { report(err, 'addGold'); } }
    const p = player(); if (!p) return false;
    p.gold = (p.gold || 0) + n; emit('goldChanged', p.gold); return true;
  }
  function _spendGold(n) {
    n = Math.max(0, Math.round(+n || 0)); if (!n) return true;
    const p = player(); if (!p) return false;
    if ((p.gold || 0) < n) return false;
    if (hasFn(G.Progress, 'spendGold')) { try { return !!G.Progress.spendGold(n); } catch (err) { report(err, 'spendGold'); return false; } }
    p.gold -= n; emit('goldChanged', p.gold); return true;
  }
  function stockLevel(e) { const p = player(); const pl = p && typeof p.level === 'number' ? p.level : 1; return clamp(Math.max(e.level || 1, pl - 3) | 0, 1, C.LEVEL_CAP || 80); }
  function stockFor(e) {
    if (!e || !hasFn(G.Items, 'vendorStock') || !hasFn(G.Items, 'create')) return [];
    const kind = vendorKind(e) || 'general', L = stockLevel(e), bracket = Math.floor((L - 1) / 5);
    const key = e.npcId + ':' + kind + ':' + bracket;
    let s = stockCache[key];
    if (!s) {
      s = [];
      let tids = []; try { tids = G.Items.vendorStock(kind, L) || []; } catch (err) { report(err, 'vendorStock'); }
      for (let i = 0; i < tids.length; i++) { const inst = G.Items.create(tids[i], 1); if (!inst) continue; inst.price = hasFn(G.Items, 'buyValue') ? G.Items.buyValue(inst) : 0; inst.vendor = e.npcId; s.push(inst); }
      stockCache[key] = s;
    }
    return s;
  }
  function openVendor(e) {
    if (!e) return null;
    const stock = stockFor(e);
    activeVendor = e;
    if (G.UI && G.UI.Vendor && hasFn(G.UI.Vendor, 'open')) { try { G.UI.Vendor.open(e, stock); } catch (err) { report(err, 'Vendor.open'); } }
    else chat(e.name + ' has ' + stock.length + ' items for sale.', 'system');
    sfx('ui_open'); duck(true);
    emit('vendorOpened', e);
    return stock;
  }
  function buy(e, tid, count) {
    const p = player(); if (!p || !tid || !hasFn(G.Items, 'create')) return false;
    count = Math.max(1, (count | 0) || 1);
    let listed = null;
    if (e) { const stock = stockFor(e); for (let i = 0; i < stock.length; i++) if (stock[i].tid === tid) { listed = stock[i]; break; } }
    if (!listed && e && !(G.state && G.state.admin)) { notify(e.name + ' does not sell that.', 'warning'); sfx('ui_error'); return false; }
    const inst = G.Items.create(tid, count); if (!inst) return false;
    const unit = hasFn(G.Items, 'buyValue') ? G.Items.buyValue(inst) : 0, price = unit * count;
    if ((p.gold || 0) < price) { notify('You cannot afford that.', 'warning'); sfx('ui_error'); return false; }
    if (!G.Items.addToInventory(p, inst)) return false;
    if (!_spendGold(price)) { if (hasFn(G.Items, 'removeFromInventory')) G.Items.removeFromInventory(p, tid, count); notify('You cannot afford that.', 'warning'); sfx('ui_error'); return false; }
    const v = hasFn(G.Items, 'get') ? G.Items.get(inst) : null;
    sfx('coin');
    notify('Bought ' + ((v && v.name) || tid) + (count > 1 ? ' ×' + count : '') + ' for ' + fmtMoney(price), 'gold');
    emit('vendorBuy', { npc: e, item: inst, price, count });
    return true;
  }
  function sellSlot(e, slotIndex, mult, quiet) {
    const p = player(); if (!p || !Array.isArray(p.inventory)) return 0;
    const inst = p.inventory[slotIndex]; if (!inst) return 0;
    const value = hasFn(G.Items, 'sellValue') ? G.Items.sellValue(inst) : 0;
    if (value <= 0) { if (!quiet) { notify('That cannot be sold.', 'warning'); sfx('ui_error'); } return 0; }
    const gold = Math.max(1, Math.floor(value * (mult || 1)));
    if (hasFn(G.Items, 'destroy')) G.Items.destroy(p, slotIndex); else { p.inventory[slotIndex] = null; emit('inventoryChanged', p); }
    _addGold(gold);
    if (e) { if (!e._buyback) e._buyback = []; e._buyback.push({ inst, price: gold }); if (e._buyback.length > 12) e._buyback.shift(); }
    const v = hasFn(G.Items, 'get') ? G.Items.get(inst) : null;
    if (!quiet) { sfx('coin'); notify('Sold ' + ((v && v.name) || inst.tid) + ((inst.count || 1) > 1 ? ' ×' + inst.count : '') + ' for ' + fmtMoney(gold), 'gold'); }
    emit('vendorSell', { npc: e, item: inst, gold });
    return gold;
  }
  function sell(e, slotIndex) { return sellSlot(e, slotIndex | 0, 1, false); }
  function sellJunk(e, mult, remote) {
    const p = player(); const out = { count: 0, gold: 0 };
    if (!p || !Array.isArray(p.inventory) || !hasFn(G.Items, 'isJunk')) return out;
    for (let i = 0; i < p.inventory.length; i++) { const inst = p.inventory[i]; if (!inst) continue; let junk = false; try { junk = G.Items.isJunk(inst, p); } catch (err) { junk = false; } if (!junk) continue; const g = sellSlot(remote ? null : e, i, mult || 1, true); if (g > 0) { out.count++; out.gold += g; } }
    if (out.count) { sfx('coin'); notify('Sold ' + out.count + ' ' + (out.count === 1 ? 'item' : 'items') + ' for ' + fmtMoney(out.gold) + (remote ? ' (remote, half value)' : ''), 'gold'); }
    else if (!remote) notify('You have nothing to sell.', 'info');
    return out;
  }
  function remoteSellJunk() { return sellJunk(null, 0.5, true); }
  function buyback(e) { return (e && e._buyback) ? e._buyback.map(b => b.inst) : []; }
  function rebuy(e, index) {
    const p = player(); if (!p || !e || !e._buyback || !e._buyback[index]) return false;
    const b = e._buyback[index];
    if ((p.gold || 0) < b.price) { notify('You cannot afford that.', 'warning'); sfx('ui_error'); return false; }
    if (!G.Items.addToInventory(p, b.inst)) return false;
    if (!_spendGold(b.price)) { G.Items.removeFromInventory(p, b.inst.tid, b.inst.count || 1); return false; }
    e._buyback.splice(index, 1); sfx('coin');
    const v = hasFn(G.Items, 'get') ? G.Items.get(b.inst) : null;
    notify('Bought back ' + ((v && v.name) || b.inst.tid), 'gold');
    return true;
  }

  // ------------------------------------------------------------------------------------------------ gather nodes & quest objects
  function itemName(tid) { if (!tid) return 'item'; const t = hasFn(G.Items, 'template') ? G.Items.template(tid) : (G.Data && G.Data.items ? G.Data.items[tid] : null); return (t && t.name) || titleCase(tid); }
  function nodeLabel(kind, name) {
    switch (kind) {
      case 'chest': return 'Search chest';
      case 'crate': case 'supplies': return 'Search ' + (name || 'crate');
      case 'beacon': return 'Light beacon';
      case 'relic': return 'Examine ' + (name || 'relic');
      case 'bundle': return 'Pick up ' + (name || 'bundle');
      default: return 'Gather ' + (name || 'herbs');
    }
  }
  // The registry may reference gather items that no data module defines (e.g. before the quest file lands). To keep
  // gathering functional, register a plain material/quest template for each missing id (never overrides a real one).
  const NODE_ICON = { herb: ['🌿', 0x3d6b2f], mushroom: ['🍄', 0x6b3d2f], ore: ['⛏', 0x55575c], wood: ['🪵', 0x6b4a2a], relic: ['📜', 0x4a4a6b], chest: ['💰', 0x6b5a2a], bundle: ['🎒', 0x6b5a3a], crate: ['📦', 0x6b5a3a] };
  function _ensureNodeItem(gn) {
    const tid = gn && gn.itemTid; if (!tid || !hasFn(G.Data, 'addItem')) return;
    if (G.Data.items && G.Data.items[tid]) return;
    const kind = gn.kind || 'herb', ic = NODE_ICON[kind] || NODE_ICON.crate;
    const name = titleCase(tid.replace(/^(herb|mushroom|ore|wood|relic|chest|bundle|crate)_/, '').replace(/_/g, ' '));
    const questy = kind === 'relic' || kind === 'chest' || /^(relic|quest|treasure)/.test(tid);
    warn('[NPCs] gather item "' + tid + '" is not defined by any data module — registering a plain ' + (questy ? 'quest' : 'material') + ' template');
    try {
      G.Data.addItem({ id: tid, name, type: questy ? 'quest' : 'material', subtype: kind, level: clamp((+gn.level || zoneLevel(gn.zone)) | 0, 1, 80), rarity: 'common', icon: ic[0], iconBg: ic[1], value: questy ? 0 : 8 + zoneLevel(gn.zone) * 2, maxStack: questy ? 20 : 100, desc: questy ? 'Something someone in Middle-earth is looking for.' : 'Gathered in the wild. Useful to cooks, smiths and healers.' });
    } catch (err) { report(err, 'node item ' + tid); }
  }
  function makeNodes(gn) {
    if (!gn || !gn.id || !gn.pos) return;
    _ensureNodeItem(gn);
    const count = clamp((gn.count | 0) || 1, 1, 24), radius = Math.max(0, +gn.radius || 0);
    const r = rngOf('node:' + gn.id);
    const kind = gn.kind || 'herb', propKind = PROP_KIND[kind] || 'crate';
    const name = itemName(gn.itemTid);
    const label = gn.label || nodeLabel(kind, kind === 'chest' ? null : name);
    const level = clamp((+gn.level || zoneLevel(gn.zone)) | 0, 1, C.LEVEL_CAP || 80);
    const cx = +gn.pos.x || 0, cz = +gn.pos.z || 0;
    for (let i = 0; i < count; i++) {
      let x = cx, z = cz, ok = false;
      for (let a = 0; a < 16 && !ok; a++) {
        if (radius > 0.5) { const ang = r() * TAU, rad = radius * Math.sqrt(r()); x = cx + Math.sin(ang) * rad; z = cz + Math.cos(ang) * rad; }
        else if (a > 0) { x = cx + (r() - 0.5) * 3; z = cz + (r() - 0.5) * 3; }
        ok = landOk(x, z) && freeAt(x, z, 0.5) && !((kind === 'herb' || kind === 'mushroom') && onRoad(x, z) > 0.5);
        if (ok && i > 0) { const prev = nodesById[gn.id]; for (let k = 0; k < prev.length; k++) { const dx = prev[k].pos.x - x, dz = prev[k].pos.z - z; if (dx * dx + dz * dz < 2.5 * 2.5) { ok = false; break; } } }
      }
      if (!ok) { x = cx + (i ? Math.sin(i * 2.1) * 2 : 0); z = cz + (i ? Math.cos(i * 2.1) * 2 : 0); }
      const ent = {
        id: 'node_' + gn.id + '_' + i, kind: 'node', nodeId: gn.id, itemTid: gn.itemTid || null, nodeKind: kind, propKind, name: gn.name || name, itemName: name, label, level, zone: gn.zone || null, index: i,
        pos: new THREE.Vector3(x, groundAt(x, z), z), yaw: r() * TAU, vel: new THREE.Vector3(), radius: 0.4, height: 1,
        alive: true, dead: false, hostile: false, faction: 'neutral', effects: [], cooldowns: {}, target: null, mesh: null, rig: null, prop: null, anim: 'idle', animTime: 0,
        depleted: false, respawnAt: 0, _interact: null, _sparkle: null, _d2: Infinity, data: gn, interact: null,
      };
      ent.interact = { label, range: NODE_RANGE, fn: function (n) { return startGather(n && n.kind === 'node' ? n : ent); } };
      G.addEntity(ent);
      nodes.push(ent);
      if (!nodesById[gn.id]) nodesById[gn.id] = []; nodesById[gn.id].push(ent);
      if (gn.itemTid) { if (!nodesByItem[gn.itemTid]) nodesByItem[gn.itemTid] = []; nodesByItem[gn.itemTid].push(ent); }
    }
  }
  function buildProp(n) {
    if (n.prop || !hasFn(G.Chars, 'buildProp')) return false;
    let prop = null; try { prop = G.Chars.buildProp(n.propKind); } catch (err) { report(err, 'node prop'); }
    if (!prop || !prop.group) return false;
    prop.group.position.copy(n.pos); prop.group.rotation.y = n.yaw; prop.group.name = 'node:' + n.id;
    tryAttachScene(); root.add(prop.group);
    n.prop = prop; n.mesh = prop.group;
    if (n.nodeKind === 'beacon') { if (n.depleted) prop.open(); else prop.close(); }
    else if (n.nodeKind === 'chest') { if (n.depleted) prop.open(); }
    else if (n.depleted) prop.group.visible = false;
    return true;
  }
  function disposeProp(n) {
    stopSparkle(n);
    const p = n.prop; if (!p) return;
    if (p.group && p.group.parent) p.group.parent.remove(p.group);
    try { p.dispose(); } catch (err) { report(err, 'node dispose'); }
    n.prop = null; n.mesh = null;
  }
  function stopSparkle(n) { if (n._sparkle) { try { if (n._sparkle.alive && hasFn(n._sparkle, 'stop')) n._sparkle.stop(); } catch (err) { /* ignore */ } n._sparkle = null; } }
  let sparkleCount = 0;
  function refreshNodeSet(fx_, fz) {
    const R2 = NODE_DIST * NODE_DIST, RH2 = (NODE_DIST + NODE_HYST) * (NODE_DIST + NODE_HYST), S2 = NODE_SPARKLE_DIST * NODE_SPARKLE_DIST;
    sparkleCount = 0;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]; const dx = n.pos.x - fx_, dz = n.pos.z - fz; n._d2 = dx * dx + dz * dz;
      if (n.prop) { if (n._d2 > RH2) disposeProp(n); }
      else if (n._d2 < R2) buildProp(n);
      if (n._sparkle && (n._sparkle.alive === false || n.depleted || n._d2 > S2 * 1.4)) stopSparkle(n);
      if (n._sparkle) sparkleCount++;
    }
    for (let i = 0; i < nodes.length && sparkleCount < MAX_NODE_SPARKLES; i++) {
      const n = nodes[i];
      if (n._sparkle || n.depleted || n._d2 > S2 || !n.prop || n.nodeKind === 'beacon') continue;
      _v2.set(n.pos.x, n.pos.y + 0.45, n.pos.z);
      n._sparkle = fx('sparkle', _v2, { loop: true, scale: 0.55, color: n.nodeKind === 'ore' ? 0xffd070 : n.nodeKind === 'relic' ? 0x80c8ff : 0xdfffb0, radius: 0.45 });
      if (n._sparkle) sparkleCount++;
    }
  }
  function updateNodes(dt) {
    nodeAcc += dt; if (nodeAcc < 1) return; nodeAcc = 0;
    const t = now();
    for (let i = 0; i < nodes.length; i++) { const n = nodes[i]; if (n.depleted && t >= n.respawnAt) respawnNode(n); }
  }
  function deplete(n) {
    n.depleted = true; n.respawnAt = now() + NODE_RESPAWN;
    if (n.interact) { n._interact = n.interact; n.interact = null; }
    stopSparkle(n);
    if (n.prop) { if (n.nodeKind === 'chest' || n.nodeKind === 'beacon') n.prop.open(); else n.prop.group.visible = false; }
  }
  function respawnNode(n) {
    n.depleted = false; n.respawnAt = 0;
    if (n._interact) { n.interact = n._interact; n._interact = null; }
    if (n.prop) { n.prop.group.visible = true; if (n.nodeKind === 'chest' || n.nodeKind === 'beacon') n.prop.close(); }
    emit('nodeRespawn', n);
  }
  function startGather(n) {
    if (!n || n.kind !== 'node') return false;
    const p = player(); if (!p || !p.pos) return false;
    if (n.depleted) { notify('There is nothing more to gather here.', 'warning'); return false; }
    if (p.dead || p.alive === false) return false;
    if (p.casting && p.casting.kind !== 'channel') { notify('You are busy.', 'warning'); sfx('ui_error'); return false; }
    if (p.mounted) { notify('You cannot do that while mounted.', 'warning'); sfx('ui_error'); return false; }
    if (p.swimming) { notify('Not while swimming.', 'warning'); return false; }
    const dx = n.pos.x - p.pos.x, dz = n.pos.z - p.pos.z;
    if (dx * dx + dz * dz > (NODE_RANGE + 1.2) * (NODE_RANGE + 1.2)) { notify('You are too far away.', 'warning'); return false; }
    if (n.itemTid && n.nodeKind !== 'beacon' && hasFn(G.Items, 'freeSlots') && G.Items.freeSlots(p) <= 0 && !(hasFn(G.Items, 'countInInventory') && G.Items.countInInventory(p, n.itemTid) > 0)) { notify('Your inventory is full.', 'warning'); sfx('ui_error'); return false; }
    if (channel) cancelChannel(false);
    const t = now();
    channel = { node: n, player: p, start: t, end: t + CHANNEL_TIME, x: p.pos.x, z: p.pos.z, morale: typeof p.morale === 'number' ? p.morale : 0 };
    // Shape shared with G.Combat's cast bookkeeping: x/z let Combat interrupt on movement, the far-future `end` keeps
    // Combat from ever "finishing" it (this module completes the channel), elapsed/duration feed the HUD cast bar.
    p.casting = { id: 'gather', kind: 'channel', name: n.label, icon: n.nodeKind === 'chest' ? '💰' : n.nodeKind === 'beacon' ? '🔥' : n.nodeKind === 'ore' ? '⛏' : n.nodeKind === 'relic' ? '📜' : '🌿', start: t, end: t + 1e6, elapsed: 0, duration: CHANNEL_TIME, total: CHANNEL_TIME, castTime: CHANNEL_TIME, x: p.pos.x, z: p.pos.z, node: n, ability: null, target: null, fx: null };
    p.yaw = yawTo(p.pos.x, p.pos.z, n.pos.x, n.pos.z);
    if (p.rig && hasFn(p.rig, 'setAnim')) { try { p.rig.setAnim(GATHER_ANIM[n.nodeKind] || 'emote_bow', true); } catch (err) { /* cosmetic */ } }
    sfx('ui_click');
    emit('gatherStart', n);
    return true;
  }
  function cancelChannel(notifyUser) {
    if (!channel) return;
    const p = channel.player;
    if (p.casting && p.casting.kind === 'channel') p.casting = null;
    if (notifyUser) { notify('Interrupted.', 'warning'); sfx('ui_error'); }
    if (p.rig && hasFn(p.rig, 'setAnim')) { try { p.rig.setAnim('idle', true); } catch (err) { /* cosmetic */ } }
    channel = null;
  }
  function updateChannel() {
    if (!channel) return;
    const p = channel.player, cur = player();
    if (!cur || cur !== p || p.dead || p.alive === false) { cancelChannel(false); return; }
    if (!p.casting || p.casting.kind !== 'channel') { channel = null; return; }     // Combat interrupted it (and said so)
    const dx = p.pos.x - channel.x, dz = p.pos.z - channel.z;
    if (dx * dx + dz * dz > 0.6 * 0.6 || (typeof p.morale === 'number' && p.morale < channel.morale - 1)) { cancelChannel(true); return; }
    const t = now();
    if (p.casting && p.casting.kind === 'channel') p.casting.elapsed = t - channel.start;
    if (t >= channel.end) finishGather();
  }
  function chestLoot(n, p) {
    const L = n.level || p.level || 1;
    const gold = (hasFn(G.Items, 'rollGold') ? G.Items.rollGold(L) : 10 + L * 3) * 2;
    _addGold(gold); sfx('coin'); notify('Found ' + fmtMoney(gold), 'gold');
    if (hasFn(G.Items, 'generate')) { const it = G.Items.generate({ level: L }); if (it && G.Items.addToInventory(p, it, true)) { const v = G.Items.get(it); notify('Found: ' + ((v && v.name) || 'an item'), 'loot'); } }
    if (n.itemTid && hasFn(G.Items, 'template') && G.Items.template(n.itemTid)) { const q = G.Items.create(n.itemTid, 1); if (q) G.Items.addToInventory(p, q); }
  }
  function finishGather() {
    const ch = channel; channel = null; if (!ch) return;
    const p = ch.player, n = ch.node;
    if (p.casting && p.casting.kind === 'channel') p.casting = null;
    if (p.rig && hasFn(p.rig, 'setAnim')) { try { p.rig.setAnim('idle', true); } catch (err) { /* cosmetic */ } }
    let inst = null;
    if (n.nodeKind === 'chest') chestLoot(n, p);
    else if (n.nodeKind === 'beacon') { notify('You light the beacon.', 'quest'); _v2.set(n.pos.x, n.pos.y + 1.4, n.pos.z); fx('fire', _v2, { scale: 1.2 }); }
    else if (n.itemTid && hasFn(G.Items, 'create')) {
      inst = G.Items.create(n.itemTid, 1);
      if (inst) { if (!G.Items.addToInventory(p, inst)) return; const v = hasFn(G.Items, 'get') ? G.Items.get(inst) : null; notify('Gathered: ' + ((v && v.name) || n.name), 'loot'); }
    }
    if (hasFn(G.Quests, 'onUse')) { try { G.Quests.onUse(n.nodeId, n); } catch (err) { report(err, 'Quests.onUse'); } }
    sfx('loot', { pos: n.pos });
    _v2.set(n.pos.x, n.pos.y + 0.5, n.pos.z); fx('sparkle', _v2, { scale: 1.2, color: 0xfff3b0 });
    deplete(n);
    emit('gathered', { node: n, item: inst });
  }
  function nearestNode(key, pos) {
    if (!key || !pos) return null;
    const list = nodesById[key] || nodesByItem[key]; if (!list) return null;
    let best = null, bd = Infinity;
    for (let i = 0; i < list.length; i++) { const n = list[i]; if (n.depleted) continue; const dx = n.pos.x - pos.x, dz = n.pos.z - pos.z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = n; } }
    return best;
  }
  function nodesFor(tid) { return (nodesByItem[tid] || []).slice(); }
  function nodesOf(nodeId) { return (nodesById[nodeId] || []).slice(); }

  // ------------------------------------------------------------------------------------------------ queries / admin
  function get(id) { if (!id) return null; if (typeof id === 'object') return id.kind === 'npc' ? id : null; return byNpcId[id] || (G.state && G.state.byId && G.state.byId[id] && G.state.byId[id].kind === 'npc' ? G.state.byId[id] : null) || null; }
  function byRole(role) {
    const out = []; if (!role) return out;
    const vendorAny = role === 'vendor';
    for (let i = 0; i < npcs.length; i++) { const e = npcs[i]; if (role === 'questgiver' ? isQuestGiver(e) : vendorAny ? !!vendorKind(e) : hasRole(e, role)) out.push(e); }
    return out;
  }
  function nearestByRole(pos, role) {
    if (!pos) return null;
    let best = null, bd = Infinity;
    for (let i = 0; i < npcs.length; i++) {
      const e = npcs[i];
      const ok = role === 'questgiver' ? isQuestGiver(e) : role === 'vendor' ? !!vendorKind(e) : role ? hasRole(e, role) : true;
      if (!ok || e.hidden) continue;
      const dx = e.pos.x - pos.x, dz = e.pos.z - pos.z, d = dx * dx + dz * dz; if (d < bd) { bd = d; best = e; }
    }
    return best;
  }
  function inTown(townId) { const out = []; for (let i = 0; i < npcs.length; i++) if (npcs[i].town === townId) out.push(npcs[i]); return out; }
  function setPos(npcOrId, x, z, yaw) {
    const e = get(npcOrId); if (!e || typeof x !== 'number' || typeof z !== 'number') return false;
    if (e.spot) { e.spot.npc = null; e.spot = null; }
    e.interior = null; e.wantsInterior = false;
    settle(e, x, z);
    if (typeof yaw === 'number') e.yaw = yaw;
    e.home.x = e.pos.x; e.home.y = e.pos.y; e.home.z = e.pos.z; e.home.yaw = e.yaw;
    e.ai.points = null; e.ai.hasTarget = false; e.ai.wait = 0;
    if (G.Spatial && hasFn(G.Spatial, 'update')) G.Spatial.update(e);
    if (e.rig) { e.rig.group.position.copy(e.pos); e.rig.group.rotation.y = e.yaw; }
    return true;
  }
  function stats() {
    let depleted = 0, props = 0, markers = 0, glows = 0;
    for (let i = 0; i < nodes.length; i++) { if (nodes[i].depleted) depleted++; if (nodes[i].prop) props++; }
    for (let i = 0; i < rendered.length; i++) { if (rendered[i]._marker) markers++; if (rendered[i]._glow) glows++; }
    return { npcs: npcs.length, rendered: rendered.length, pending: pendingBuild.length, hidden: hiddenCount, nodes: nodes.length, nodesDepleted: depleted, nodeProps: props, markers, glows, sparkles: sparkleCount, channel: !!channel, talking: talking ? talking.npcId : null, vendor: activeVendor ? activeVendor.npcId : null };
  }

  // ------------------------------------------------------------------------------------------------ init / update
  function focus() {
    const p = player(); if (p && p.pos && typeof p.pos.x === 'number') return p.pos;
    const cam = G.Player && G.Player.camera; if (cam && cam.position) return cam.position;
    return null;
  }
  function init() {
    if (inited) return;
    inited = true;
    questRefs = collectQuestRefs();
    const W = G.Data && G.Data.world;
    townById = Object.create(null);
    if (!W) { warn('[NPCs] no world registry (G.Data.world) — nothing to create'); return; }
    if (Array.isArray(W.towns)) for (let i = 0; i < W.towns.length; i++) if (W.towns[i] && W.towns[i].id) townById[W.towns[i].id] = W.towns[i];
    if (Array.isArray(W.npcs)) for (let i = 0; i < W.npcs.length; i++) { try { makeNpc(W.npcs[i]); } catch (err) { report(err, 'NPC ' + (W.npcs[i] && W.npcs[i].id)); } }
    if (Array.isArray(W.gatherNodes)) for (let i = 0; i < W.gatherNodes.length; i++) { try { makeNodes(W.gatherNodes[i]); } catch (err) { report(err, 'node ' + (W.gatherNodes[i] && W.gatherNodes[i].id)); } }
    lastBuildingCount = (G.Buildings && Array.isArray(G.Buildings.all)) ? G.Buildings.all.length : -1;
    tryAttachScene();
    markersDirty = true;
    log('[NPCs] init:', npcs.length, 'npcs,', nodes.length, 'nodes');
  }
  function update(dt) {
    if (!inited) return;
    dt = (dt > 0) ? (dt > 0.1 ? 0.1 : dt) : 0;
    const f = focus(); if (!f) return;
    const px = f.x, pz = f.z, camera = (G.Player && G.Player.camera) || null, t = now();
    tickAcc += dt;
    if (tickAcc >= 0.5) { tickAcc = 0; retryInteriors(); refreshRenderSet(px, pz); nightTick(); }
    drainBuilds();
    markerAcc += dt;
    if (markersDirty || markerAcc >= 2) { markerAcc = 0; markersDirty = false; refreshMarkers(); }
    for (let i = 0; i < rendered.length; i++) updateNpc(rendered[i], dt, px, pz, camera, t);
    updateNodes(dt);
    updateChannel();
    if (ducked) { duckWatchT += dt; if (duckWatchT > 0.5) { duckWatchT = 0; if (!hasFn(G.UI, 'isOpen') && !talking && !activeVendor) duck(false); else maybeUnduck(); } }
    if (talking && hasFn(G.UI, 'isOpen') && !panelOpen('dialogue') && !panelOpen('vendor') && !panelOpen('travel')) endTalk(talking);
  }

  // ------------------------------------------------------------------------------------------------ events
  if (typeof G.on === 'function') {
    const dirty = function () { markersDirty = true; };
    G.on('questAccepted', dirty); G.on('questProgress', dirty); G.on('questCompleted', dirty); G.on('playerLevelUp', dirty); G.on('gameStart', dirty); G.on('load', dirty);
    G.on('sceneReady', function (sc) { setScene(sc); });
    G.on('panelClosed', function (id) {
      if (id === 'dialogue') { if (talking) endTalk(talking); }
      if (id === 'vendor') { activeVendor = null; }
      maybeUnduck();
    });
    G.on('panelOpened', function (id) { if (id === 'dialogue' || id === 'vendor') duck(true); });
    G.on('playerDeath', function () { if (channel) cancelChannel(false); if (talking) endTalk(talking); });
  }

  G.NPCs = {
    init, update, get, talk, endTalk,
    all: npcs, rendered, nodes, root, setScene,
    byRole, nearestByRole, inTown, setPos, stats,
    markerState, refreshMarkers,
    dialogueOptions, choose, greeting, nextLine, vendorKind,
    openVendor, stockFor, buy, sell, sellJunk, remoteSellJunk, buyback, rebuy, rest, openTravel, openDock,
    nearestNode, nodesFor, nodesOf, gather: startGather, cancelChannel,
    get activeVendor() { return activeVendor; },
    get talking() { return talking; },
    get channel() { return channel; },
    get hidden() { return hiddenCount; },
    get scene() { return scene; },
  };
})();
