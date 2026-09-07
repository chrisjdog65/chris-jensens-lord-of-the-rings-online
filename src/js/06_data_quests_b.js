/* ==== 06_data_quests_b.js — Story quests s051–s100 (Books 5–8) for Chris Jensen's Lord of the Rings Online.
   Book 5: The Drowned Crown (Evendim & the Trollshaws, s051–s062, L38–50) · Book 6: The Council of Imladris (Rivendell &
   the Misty Mountains, s063–s075, L48–58) · Book 7: Frost and Iron (Angmar & Forochel, s076–s088, L56–70) ·
   Book 8: The Sundered Isles (Tol Morwen, Tol Fuin, Himling, s089–s100, L68–80; s100 slays Draugmar the Gaunt-lord).
   Pure data (SPEC §4.7): pushes onto G.Data.quests, mirrors into G.Data.questById, registers its quest-only items
   (ids `qb_*`) through G.Data.addItem before any quest references them. Every npc/monster/boss/node/spot/poi id is a
   05_data_world id (docs/WORLD_IDS.md); levels follow G.Data.xp.storyLevel; rewards use questXP/goldReward.
   Conventions: chapter-ending quests award the Book title from G.Data.titles by display name; every third quest offers a
   `choose` of one light/medium/heavy set piece (Rivendell L50 → Moria-forged L60 → Angmar-bane L70, six slots each so
   whole sets can be assembled; the sixth Angmar-bane piece rides on s088). s100 sets title + Lost Kingdom mount only —
   the runtime grants the full Armour of the Lost Kingdom on its turn-in. Book 8 references island content and dock
   boat-masters only (s089 is offered by the Ice-pilot at the Forochel dock). ==== */
(function () {
  'use strict';
  const G = window.G; G.Data = G.Data || {}; G.Data.quests = G.Data.quests || [];
  const X = G.Data.xp; // X.questXP(level,'story'), X.goldReward(level,'story'), X.storyLevel(i)

  // ------------------------------------------------------------------ quest-only items (registered before the quests)
  function QI(id, name, icon, desc, flavor) {
    if (!G.Data.addItem) return id;
    G.Data.addItem({ id, name, type: 'quest', slot: null, subtype: 'quest', level: 1, rarity: 'common', stats: {}, dmg: null,
      value: 0, maxStack: 20, icon, desc, flavor: flavor || '', use: null });
    return id;
  }
  QI('qb_robbers_writ', 'Writ of the Pale Hand', '📜', 'A writ promising gold for "the bright stone of the drowned city", sealed with a white hand-print.', 'The tomb-robbers of Annúminas each carry one.');
  QI('qb_arnor_coin', 'Coin of Old Arnor', '🪙', 'A silver coin of the North-kingdom, minted at Annúminas before the Witch-king came. Someone is paying trolls with it.');
  QI('qb_athelas_draught', 'Draught of Athelas', '🧪', 'Kingsfoil steeped in clean water by the Rangers of Thorenhad. Meant for a wounded man, not for you.');
  QI('qb_council_letter', 'Letter of the Council', '✉', "Sealed with the device of Elrond's house. Addressed to Glóin son of Gróin at the High Crag.");
  QI('qb_goblin_tally', 'Goblin Tally-stick', '🪵', 'A notched stick on which a goblin kept count of stolen goats, stolen dwarves and one stolen shard.');
  QI('qb_giant_rune', 'Rune-carved Giant-stone', '🪨', 'A stone the size of a loaf, cut with giant-runes that map the tunnels beneath the Front Porch.');
  QI('qb_goblin_key', 'Goblin Gate-key', '🗝', 'A crude iron key hung on a thong of stolen dwarf-beard. It opens one of the inner gates of Goblin-town.');
  QI('qb_orc_wartoken', 'Orc War-token', '⚙', "A black iron token stamped with the sign of Carn Dûm. Each Orc of Angmar carries one as his master's leave to raid.");
  QI('qb_himbar_banner', 'Banner of Himbar', '🚩', 'A torn Uruk banner from the ruins of Himbar. The Pale Hand’s white print is painted over the Eye of Angmar.');
  QI('qb_gaunt_fetter', 'Gaunt-fetter', '⛓', 'A rusted grave-fetter, still cold. The Gaunt-wights of the approach wear them as the badge of their binding.');
  QI('qb_breanna_ward', "Bréanna's Ward", '🧿', 'A charm of rowan and red thread, made by the wise-woman of Aughaire against the sorcery of Carn Dûm.');
  QI('qb_gauredain_totem', 'Gauredain Totem', '🗿', 'A wolf-skull totem of the Gauredain. Beneath the fur it is marked with a pale hand-print.');
  QI('qb_frost_heart', 'Frost-drake Heart', '❄', 'The heart of a frost-drake, hard and cold as a river-stone. The seers of the Lossoth burn them on the Ice-altar.');
  QI('qb_drowned_ring', "Drowned Sailor's Ring", '💍', 'A ring of sea-silver taken from a drowned wight of Tol Morwen. The elven letters on the inside spell a name.');
  QI('qb_hulda_letter', "Hulda's Confession", '✉', 'A letter from the elder of Morwen Village to the Lord of Ost Fuin. It is heavy for a single sheet of paper.');
  QI('qb_raider_orders', "Raider-captain's Orders", '📃', 'Orders in the Black Speech, with a pale hand-print for a seal, naming the ships that gather at Himling.');
  QI('qb_siege_plan', 'Siege-plans of the Gaunt-lord', '📃', 'A charcoal plan of the Free Peoples’ camp at Ras Himling, drawn by a hand that was not living.');
  QI('qb_sapper_charges', "Ormar's Blasting-charges", '🧨', 'Three clay pots of dwarven fire-powder, corked with wax. Do not run with them.');
  QI('qb_gaunt_phylactery', "Gaunt-cultist's Phylactery", '⚱', 'A small iron box hung about a cultist’s neck. Inside, a scrap of grave-cloth and a splinter of white bone.');

  // ------------------------------------------------------------------ helpers
  const pad = (n) => 's' + String(n).padStart(3, '0');
  const L = (n) => Math.round(X.storyLevel(n));
  const kill = (target, count, label) => ({ type: 'kill', target, count, label });
  const collectFrom = (item, count, from, label) => ({ type: 'collect', item, count, from, label });
  const collectNode = (item, count, node, label) => ({ type: 'collect', item, count, from: null, node, label });
  const talk = (npc, label) => ({ type: 'talk', npc, label });
  const explore = (x, z, radius, label) => ({ type: 'explore', pos: { x, z }, radius, label });
  const use = (node, count, label) => ({ type: 'use', node, count, label });
  const fish = (count, spot, label) => ({ type: 'fish', count, spot, label });
  const deliver = (item, npc, label) => ({ type: 'deliver', item, npc, label });
  const killboss = (boss, label) => ({ type: 'killboss', boss, label });
  const setPick = (family, slot) => ['light', 'medium', 'heavy'].map((at) => 's_' + family + '_' + at + '_' + slot);
  const B5 = 'Book 5: The Drowned Crown';
  const B6 = 'Book 6: The Council of Imladris';
  const B7 = 'Book 7: Frost and Iron';
  const B8 = 'Book 8: The Sundered Isles';

  function rewards(level, o) {
    o = o || {};
    const r = { xp: X.questXP(level, 'story'), gold: X.goldReward(level, 'story'), items: (o.items || []).slice() };
    if (o.choose) r.choose = o.choose.slice();
    if (o.title) r.title = o.title;
    if (o.mount) r.mount = o.mount;
    return r;
  }
  function quest(n, book, o) {
    const level = L(n);
    const q = {
      id: pad(n), name: o.name, type: 'story', book, level, zone: o.zone, giver: o.giver, turnin: o.turnin,
      prereq: [pad(n - 1)], objectives: o.objectives, rewards: rewards(level, o.rewards),
      text: { intro: o.intro, accept: o.accept, progress: o.progress, complete: o.complete, summary: o.summary, hint: o.hint },
      summary: o.summary, hint: o.hint,
    };
    if (o.sequential) q.sequential = true;
    if (n < 100) q.next = pad(n + 1);
    return q;
  }

  const Q = [
    // ================================================================ BOOK 5: THE DROWNED CROWN (Evendim & the Trollshaws)
    quest(51, B5, {
      name: 'The Lakeside Way', zone: 'evendim', giver: 'npc_esteldin_halbarad', turnin: 'npc_tinnudir_captain',
      objectives: [
        explore(-40, -1000, 22, 'Reach the Causeway of Tinnudir on Lake Evendim'),
        kill('evendim_crawler', 6, 'Slay Lake-crawlers on the east shore of Nenuial'),
        talk('npc_tinnudir_guard', 'Report to Dorlas, the sentry at the gate of Tinnudir'),
      ],
      rewards: { choose: setPick('rivendell', 'chest'), items: ['pot_heal_elixir'] },
      intro: "Bûrzghâsh is dead and Fornost is quiet, but the Pale Hand was not among the fallen. My scouts followed his riders north-west along the old causeway to Lake Evendim — to Annúminas, the drowned capital of the kings, where the crown of Arnor was last worn. Tarondor holds the isle of Tinnudir with a handful of Rangers and he will need a sword like yours. Ride to Trestlebridge and take the causeway road north; the lake-crawlers have made the east shore a death-trap for our couriers, so clear them as you go. When you reach the gate of Tinnudir, give my name to Dorlas.",
      accept: 'I will ride for Evendim at once.',
      progress: 'The causeway runs north from Trestlebridge across the lake. Tarondor waits in the Keep of Tinnudir.',
      complete: "Halbarad sends you? Then the North Downs are safe and I may sleep an hour tonight. Welcome to Tinnudir, friend — the lake is wide, the ruins are wider, and the robbers who dig in them have found a paymaster with very deep pockets. This mail was sent up from Imladris for whoever Halbarad chose; it seems he chose well.",
      summary: 'Ride the causeway to Tinnudir, clearing the lake-crawlers of the east shore, and report to Tarondor.',
      hint: 'Take the road north from Trestlebridge; it becomes the causeway to the isle of Tinnudir.',
    }),
    quest(52, B5, {
      name: 'Robbers in the Ruins', zone: 'evendim', giver: 'npc_tinnudir_captain', turnin: 'npc_tinnudir_captain',
      objectives: [
        explore(-540, -900, 25, 'Explore the ruins of Annúminas on the west shore'),
        kill('tomb_robber', 8, 'Slay Tomb-robbers in Annúminas'),
        collectFrom('qb_robbers_writ', 4, 'tomb_robber', 'Take Writs of the Pale Hand from the Tomb-robbers'),
      ],
      rewards: { items: ['pot_power_elixir', 'pot_heal_elixir'] },
      intro: "Annúminas was the city of Elendil, and for a thousand years the lake has been drinking it. Tomb-robbers have come up from the south to pick its bones, and they dig with more purpose than greed alone would give them — they are looking for something, and they are paid to find it. Follow the Lakeside Way around the north shore to the drowned city and thin their numbers. Any papers they carry, bring to me; I want the name of the one who pays.",
      accept: 'I will see what the robbers are digging for.',
      progress: 'The ruins of Annúminas lie on the west shore of the lake, at the end of the Lakeside Way.',
      complete: "A white hand-print for a seal, and gold promised for 'the bright stone of the drowned city'. So the Pale Hand has read the same histories as Ninias: a shard of the crown of Arnor went into the lake with the last king's treasury. He means to have it, and he has hired half the cut-throats of Eriador to dig for it.",
      summary: 'Scout the ruins of Annúminas, slay the Tomb-robbers and recover the writs they carry.',
      hint: 'Follow the Lakeside Way west from Tinnudir around the north shore to Annúminas.',
    }),
    quest(53, B5, {
      name: 'The Reliquaries of Annúminas', zone: 'evendim', giver: 'npc_tinnudir_ninias', turnin: 'npc_tinnudir_ninias',
      objectives: [
        use('gn_evendim_1', 3, 'Search the reliquaries of Annúminas'),
        kill('evendim_wight', 6, 'Lay the Wights of Tyl Ruinen to rest'),
      ],
      rewards: { items: ['pot_heal_elixir', 'scroll_fortitude_10'] },
      intro: "Tarondor showed me the writ. I have spent twenty years among the stones of Annúminas and I can tell you where a shard of the crown would have been kept: in the reliquaries beneath the Hall of Kings, on the terrace nearest the water. The robbers have not found them yet because the wights of Tyl Ruinen walk the shore between, and even a paid man will not dig with a wight at his back. Lay the wights to rest, search the reliquaries, and tell me what you find — even if it is nothing.",
      accept: 'I will search the reliquaries before the robbers do.',
      progress: 'The reliquaries are on the lowest terrace of Annúminas; the wights haunt the Tyl Ruinen shore just north of them.',
      complete: "Empty. Every one of them opened, and not from outside — the bronze was cut from within, long ago. Someone took the shard out of the reliquary before the lake rose, and I think I know who: the tomb-robbers' own chief, Ardaric, boasts of a 'lucky stone' he wears about his neck. He has had it for years and not known what it was.",
      summary: 'Lay the Wights of Tyl Ruinen to rest and search the reliquaries of Annúminas for the shard of the crown.',
      hint: 'The reliquaries are on the lake-side terrace of Annúminas; the wights walk the shore of Tyl Ruinen just north.',
    }),
    quest(54, B5, {
      name: 'Silver of the Kings', zone: 'evendim', giver: 'npc_tinnudir_ninias', turnin: 'npc_tinnudir_ninias',
      objectives: [
        explore(-540, -1100, 18, 'Find the Caves of Emyn Uial'),
        kill('giant_evendim', 5, 'Slay Hill-giants of Emyn Uial'),
        collectNode('mat_silver_ore', 4, 'gn_evendim_2', "Gather king's-mark silver from the giants' diggings"),
      ],
      rewards: { choose: setPick('rivendell', 'legs'), items: ['pot_power_elixir'] },
      intro: "Before we go after Ardaric, I need something from the hills. The hill-giants of Emyn Uial have broken into the old silver-vaults of the kings and cast the ore about their caves like gravel. That silver bears the king's mark, and a smith who knows the old craft can make of it a setting that will hold a shard of the crown safe from any sorcery. Go up into the caves north-west of Annúminas, drive off the giants, and bring me four good pieces of ore.",
      accept: 'I will bring you the silver of the kings.',
      progress: 'The Caves of Emyn Uial are in the hills north-west of Annúminas; the silver lies in the giants’ spoil-heaps.',
      complete: "Yes — see the star stamped in the seam? This was mined for Elendil's own treasury. Angbor will make a setting of it tonight, and then we shall see about taking the shard from a man who does not know what he wears. You have earned a rest, but I doubt you will take one.",
      summary: 'Drive the Hill-giants from the Caves of Emyn Uial and gather silver ore bearing the king’s mark.',
      hint: 'The Caves of Emyn Uial are north-west of Annúminas; the silver seam is at the giants’ diggings.',
    }),
    quest(55, B5, {
      name: 'What the Lake Keeps', zone: 'evendim', giver: 'npc_tinnudir_nengel', turnin: 'npc_tinnudir_nengel',
      objectives: [
        fish(3, 'fs_annuminas_quay', 'Fish the Drowned Quays of Annúminas'),
        kill('tomb_robber_lieutenant', 3, "Slay Tomb-robber Lieutenants at the robbers' camp"),
      ],
      rewards: { items: ['bait_minnow', 'pot_heal_elixir'] },
      intro: "You are the one who has been stirring up the robbers? Good; then you will want to know this. Ardaric's lieutenants have been dumping what they cannot sell off the drowned quays — old bronze, broken statues, the bones of kings — and the fish have grown fat and strange on it. Take a line down to the quays and see what comes up; there is a rumour among my nets that one of the lieutenants dropped a ring-key into the water that opens the chief's strong-box. And while you are there, the lieutenants themselves have a camp on the shore. I would not weep for them.",
      accept: 'I will cast a line at the drowned quays.',
      progress: 'The Drowned Quays are on the west shore below Annúminas; the robbers’ camp is just north of them.',
      complete: "A pike, a sturgeon, and — well, look at that. The lieutenant's ring-key, in the belly of a pike. I have fished this lake forty years and it still surprises me. Take it to Tarondor; he will know what to do with a key to Ardaric's strong-box.",
      summary: 'Fish the Drowned Quays of Annúminas and slay the Tomb-robber Lieutenants camped above them.',
      hint: 'The quays are at the foot of Annúminas on the west shore; the lieutenants camp on the rise to the north.',
    }),
    quest(56, B5, {
      name: "Ardaric's Prize", zone: 'evendim', giver: 'npc_tinnudir_captain', turnin: 'npc_tinnudir_captain',
      objectives: [
        killboss('boss_ardaric', 'Defeat Ardaric the Tomb-robber in Annúminas'),
        talk('npc_tinnudir_ninias', 'Bring the Shard of the Lost Crown to Ninias'),
      ],
      rewards: { items: ['pot_heal_elixir', 'pot_power_elixir'] },
      intro: "Ninias is certain, Nengel has found the key, and Angbor has finished the setting — there is nothing left but the man himself. Ardaric holds the Hall of Kings in Annúminas with the best of his robbers around him, and he wears the shard on a cord about his neck as a lucky-piece. He will not give it up while he lives, and I would not trust him to give it up dead. Go into the Hall, end him, and bring the shard straight to Ninias before the Pale Hand's men learn what has happened.",
      accept: 'Ardaric will not wear the crown of Arnor as a trinket for long.',
      progress: 'Ardaric holds the Hall of Kings in the heart of Annúminas. Bring the shard to Ninias in Tinnudir.',
      complete: "The shard is in its setting, and Ninias says the cold has gone out of it already. The Pale Hand has lost a prize he thought was his for the digging, and he will not take that quietly. My riders say his agents fled east across the Hoarwell into the Trollshaws — and that they went with gold enough to hire trolls.",
      summary: 'Slay Ardaric the Tomb-robber and bring the Shard of the Lost Crown to Ninias.',
      hint: 'Ardaric is in the Hall of Kings at the centre of Annúminas.',
    }),
    quest(57, B5, {
      name: 'The Last Bridge', zone: 'trollshaws', giver: 'npc_tinnudir_captain', turnin: 'npc_thorenhad_captain',
      objectives: [
        explore(1029, -50, 20, 'Reach the Last Bridge over the Hoarwell'),
        kill('hillman_brigand', 6, "Slay Rhudaur Hillmen at the hillman camp"),
      ],
      rewards: { choose: setPick('rivendell', 'head'), items: ['pot_heal_greater'] },
      intro: "The Pale Hand's agents crossed the Hoarwell at the Last Bridge, and the Rangers of Thorenhad have sent word that hillmen of Rhudaur are gathering on the far bank — the old enemies of Arnor, bought again with old coin. Berenon commands the camp at Thorenhad; he is a good man with too few swords. Ride east through the North Downs and the Lone-lands to Ost Guruth, and follow the Great East Road to the Bridge. Clear the hillman camp south of the road on your way, and give Berenon my greeting.",
      accept: 'I will ride for the Last Bridge.',
      progress: 'The Last Bridge lies east of Ost Guruth on the Great East Road; the hillmen camp south of the road.',
      complete: "Tarondor's greeting, and a cleared hillman camp to go with it — you are welcome twice over. The Trollshaws have gone bad this season: hillmen on the roads, trolls walking by daylight, and a pale rider seen at the Ford of Bruinen that no arrow seems to reach. Rest here; the elves of Imladris sent this helm for whoever came to our aid.",
      summary: 'Cross to the Trollshaws by the Last Bridge, clearing the hillman camp, and report to Berenon at Thorenhad.',
      hint: 'Follow the Great East Road east from Ost Guruth; the hillman camp is south of the road before the Bridge.',
    }),
    quest(58, B5, {
      name: 'Paid in Old Coin', zone: 'trollshaws', giver: 'npc_thorenhad_captain', turnin: 'npc_thorenhad_captain',
      objectives: [
        kill('hill_troll', 5, 'Slay Hill-trolls south of Thorenhad'),
        collectFrom('qb_arnor_coin', 4, 'hill_troll', 'Recover Coins of Old Arnor from the trolls'),
      ],
      rewards: { items: ['n_ear_troll', 'pot_heal_greater'] },
      intro: "Hathlaf brought a dead troll's purse back from the woods yesterday, and there was silver in it — silver with the star of Elendil on it. Trolls do not carry money; trolls are given it by someone who wants them somewhere. The hill-trolls south of the camp have been paid to hold the woods between us and the Bruinen, which means the Pale Hand does not want us watching the river. Kill them, take back what coin they carry, and we will see how much of Arnor's treasury he has left to spend.",
      accept: 'Trolls with purses. I will lighten them.',
      progress: 'The hill-trolls range the woods south of Thorenhad, towards the Troll-cave.',
      complete: "Four coins, and each one struck at Annúminas. He is spending the treasury of the kings to buy the kings' enemies, and he has not run short yet. But trolls are only a wall; what is he hiding behind it? Hathlaf has a thought about that.",
      summary: 'Slay the Hill-trolls south of Thorenhad and recover the coins of Old Arnor they were paid with.',
      hint: 'Hill-trolls range the woods south of Thorenhad camp.',
    }),
    quest(59, B5, {
      name: "The Stone-trolls' Clearing", zone: 'trollshaws', giver: 'npc_thorenhad_hathlaf', turnin: 'npc_thorenhad_hathlaf',
      objectives: [
        explore(1230, -110, 18, "Find the Stone-trolls' Clearing"),
        kill('stone_troll', 5, 'Slay Stone-trolls in the clearing'),
        use('gn_trollshaws_5', 1, "Search the trolls' hoard"),
      ],
      rewards: { items: ['pot_power_greater', 'food_cram'] },
      intro: "There is a clearing north of the road where three trolls stood turned to stone in old Bilbo's day, and the living trolls have made it their meeting-place ever since — they seem to think the stone ones are their elders. Something has been carried there at night; I have seen the torches from the ridge. If the Pale Hand is paying trolls, he is paying them to guard something, and a troll guards a thing by sitting on it. Go to the clearing, kill what sits there, and dig out their hoard.",
      accept: 'I will see what the trolls are sitting on.',
      progress: "The Stone-trolls' Clearing is north of the road to Rivendell, east of Thorenhad; the hoard is in the trees at its edge.",
      complete: "Letters, in the hoard? Then the Pale Hand has begun writing to trolls, and trolls cannot read — which means the letters were for someone who can. The one he calls 'Thrúgash' is the troll-chief of these woods, and the letter promises him a crown of his own if he holds the Bruinen. Berenon must see this.",
      summary: "Clear the Stone-trolls' Clearing and search the trolls' hoard for the Pale Hand's letters.",
      hint: "The clearing is north of the road between Thorenhad and Rivendell; the hoard lies at its edge.",
    }),
    quest(60, B5, {
      name: 'Athelas for Aradan', zone: 'trollshaws', giver: 'npc_thorenhad_captain', turnin: 'npc_thorenhad_captain',
      objectives: [
        deliver('qb_athelas_draught', 'npc_thorenhad_wounded', 'Bring the Draught of Athelas to Aradan, the wounded Ranger'),
        collectNode('mat_athelas', 4, 'gn_trollshaws_1', 'Gather fresh athelas from the meadows south of the road'),
        kill('trollshaws_spider', 6, 'Slay Rhudaur Spiders that infest the athelas meadows'),
      ],
      rewards: { choose: setPick('rivendell', 'shoulder'), items: ['pot_heal_greater'] },
      intro: "Before we go troll-hunting I have a smaller task, and it will not wait. Aradan took a spider's bite at the Ford three nights ago and the poison is in him; I have one draught of athelas left, and he must drink it now. Take it to him — he lies by the horse-lines — and then go south of the road where the kingsfoil grows and gather more, for he will need it again by morning. The spiders that bit him are still in the meadows. I would take that personally, in your place.",
      accept: 'Aradan will have his draught, and the spiders will have my sword.',
      progress: 'Aradan lies by the horse-lines in Thorenhad; the athelas meadows are south of the road, where the spiders nest.',
      complete: "He is sleeping, and the black has gone out of the bite. Thank you. Now — Hathlaf's letter names Thrúgash and the Bruinen, and the troll-cave in the south is where his kin go to ground. That is where we go next.",
      summary: 'Deliver the Draught of Athelas to Aradan, gather fresh athelas and clear the spiders from the meadows.',
      hint: 'Aradan lies by the horse-lines in Thorenhad. The athelas meadows are south of the road, east of the camp.',
    }),
    quest(61, B5, {
      name: 'The Troll-cave', zone: 'trollshaws', giver: 'npc_thorenhad_captain', turnin: 'npc_thorenhad_captain',
      objectives: [
        explore(1180, 180, 16, 'Find the Troll-cave in the southern woods'),
        kill('cave_troll', 3, 'Slay the Cave-trolls that guard the cave'),
        collectNode('q_troll_keystone', 3, 'gn_trollshaws_4', 'Recover the Troll-hoard Keystones from the Ford of Bruinen'),
      ],
      rewards: { items: ['pot_heal_greater', 'pot_power_greater'] },
      intro: "Thrúgash has gone to ground somewhere in the hills north of the road, and no Ranger has found the way in. But the cave-trolls in the southern woods are his kin, and they carry the marks of the door — carved keystones, one for each of the great troll-holes of the Shaws, and the one for his hole was left at the Ford of Bruinen where his messengers cross. Clear the troll-cave in the south so we have no enemy at our back, then search the Ford for the keystones. With them we can read where the chief's hole lies.",
      accept: 'I will find the keystones and the way to Thrúgash.',
      progress: 'The Troll-cave is in the woods south-east of Thorenhad; the keystones lie at the Ford of Bruinen, east along the road.',
      complete: "Three keystones, and the third bears a hill with a hole in it that any Ranger of the Shaws would know: the Troll-chief's Hole, in the crags north of the road to Rivendell. Now we know where he sleeps. Get what rest you can; tomorrow you go in.",
      summary: 'Clear the Troll-cave and recover the keystones at the Ford of Bruinen that reveal Thrúgash’s hole.',
      hint: 'The Troll-cave lies south-east of Thorenhad; the Ford of Bruinen is east along the road to Rivendell.',
    }),
    quest(62, B5, {
      name: 'Thrúgash the Troll-chief', zone: 'trollshaws', giver: 'npc_thorenhad_captain', turnin: 'npc_rivendell_elrond',
      objectives: [
        killboss('boss_thrugash', "Slay Thrúgash the Troll-chief in his hole"),
        talk('npc_rivendell_elrohir', 'Meet Elrohir at the gates of Rivendell'),
      ],
      rewards: { title: 'Warden of Annúminas', items: ['n_cloak_elven_imladris', 'drink_miruvor'] },
      intro: "The Troll-chief's Hole is in the crags north of the Rivendell road, and Thrúgash is in it — the largest troll these woods have bred in a hundred years, with the Pale Hand's promise of a crown in his thick skull. While he lives, no messenger of ours reaches Imladris alive. Go up and end him. When it is done, do not come back here: take the road east to the Ford of Bruinen and beyond, to Rivendell. Elrond must hear of the shard and of the Pale Hand's letters from someone who has seen both, and that someone is you.",
      accept: 'Thrúgash will have his crown of stone.',
      progress: "The Troll-chief's Hole is in the crags north of the road to Rivendell. Afterwards, ride east to the valley of Imladris.",
      complete: "Welcome to Rivendell, Warden of Annúminas — for so Tarondor names you in his letter, and the title is well earned. Elrohir tells me the troll-chief is dead and the road is open again; Ninias tells me a shard of the crown of Arnor is safe in a setting of king's silver. You have done in a season what the Dúnedain could not do in a century. Sit, eat, and sleep in the Last Homely House; tomorrow we hold council, and there is much to say about the one who calls himself the Pale Hand.",
      summary: 'Slay Thrúgash the Troll-chief in his hole, then ride east to Rivendell and the house of Elrond.',
      hint: "Thrúgash's hole is in the crags north of the road east of Thorenhad; Rivendell lies at the road's end.",
    }),

    // ================================================================ BOOK 6: THE COUNCIL OF IMLADRIS (Rivendell & the Misty Mountains)
    quest(63, B6, {
      name: 'The Council of Elrond', zone: 'trollshaws', giver: 'npc_rivendell_elrond', turnin: 'npc_rivendell_elrond',
      objectives: [
        talk('npc_rivendell_gandalf', 'Speak with Gandalf in the Hall of Fire'),
        talk('npc_rivendell_glorfindel', 'Speak with Glorfindel'),
        talk('npc_rivendell_counsellor', 'Speak with Idhrenion, Counsellor of Elrond'),
      ],
      rewards: { choose: setPick('rivendell', 'hands'), items: ['drink_miruvor', 'scroll_warding_50'] },
      intro: "The crown of Arnor was broken at Fornost when Arvedui fled north, and its shards were scattered so that no enemy could make a king of himself with it. That is the history; here is what the history does not say. The Witch-king's servants have always sought the shards, and the one who calls himself the Pale Hand is the latest and the cleverest, for he does not seek to crown himself — he seeks to crown a dead thing. Before I say more I would have you hear three voices: Gandalf, who has walked further than any of us; Glorfindel, who has fought the Witch-king's shadow before; and my counsellor Idhrenion, who keeps the records of the shards. Speak with each and return to me.",
      accept: 'I will hear the council.',
      progress: 'Gandalf sits in the Hall of Fire; Glorfindel and Idhrenion are in the courts of the Last Homely House.',
      complete: "So now you know what we know. The Pale Hand serves a Gaunt-lord of Angmar — Draugmar, whom Glorfindel names, and whom the Witch-king bound beneath the fortress of Himring on the Sundered Isles long ago — and he means to raise him with the crown of Arnor on his brow. He holds shards already; we hold one, and Idhrenion has found where another lies. The giants of the Misty Mountains kept a shard in their hoard for an age, and the goblins of Goblin-town have lately robbed them of it.",
      summary: 'Hear the council of Gandalf, Glorfindel and Idhrenion in Rivendell.',
      hint: 'All three are in Rivendell: Gandalf in the Hall of Fire, Glorfindel and Idhrenion in the courts.',
    }),
    quest(64, B6, {
      name: 'The Mountain Stair', zone: 'misty', giver: 'npc_rivendell_counsellor', turnin: 'npc_highcrag_gloin',
      objectives: [
        deliver('qb_council_letter', 'npc_highcrag_gloin', 'Bring the Letter of the Council to Glóin at the High Crag'),
        kill('misty_bat', 6, 'Slay Ice-bats along the Mountain Stair'),
      ],
      rewards: { items: ['pot_heal_greater', 'pot_power_greater'] },
      intro: "Glóin son of Gróin holds the dwarf-camp at the High Crag above the Mountain Stair, and no one alive knows the goblin-tunnels of the Misty Mountains better than a dwarf who walked them with Thorin. This letter carries Elrond's word and the council's; it will open Glóin's door and his memory. The Stair climbs north-east from Rivendell into the snow — and the ice-bats that roost along it have grown bold since the goblins began moving. Go carefully, and go now.",
      accept: 'I will carry the letter up the Mountain Stair.',
      progress: 'The Mountain Stair climbs north-east from Rivendell to the High Crag. Ice-bats roost along the way.',
      complete: "Elrond's seal, and Idhrenion's hand — I know both. So it is the crown of Arnor the goblins carried out of the giants' hoard, and not just another bag of my cousins' gold. Sit by the fire; you have climbed far. The goblins of the Front Porch will answer for it, and I know the way to their door.",
      summary: 'Carry the Letter of the Council up the Mountain Stair to Glóin at the High Crag, clearing the ice-bats.',
      hint: 'The Mountain Stair leaves Rivendell to the north-east and climbs to the High Crag.',
    }),
    quest(65, B6, {
      name: 'Goblins of the Front Porch', zone: 'misty', giver: 'npc_highcrag_gloin', turnin: 'npc_highcrag_gloin',
      objectives: [
        kill('snow_goblin', 8, 'Slay Snow-goblins below the Front Porch'),
        collectFrom('qb_goblin_tally', 4, 'snow_goblin', 'Take Goblin Tally-sticks from the Snow-goblins'),
      ],
      rewards: { items: ['scroll_battle_50', 'pot_power_greater'] },
      intro: "The Front Porch is the great gate of Goblin-town, north of here past the Frozen Falls, and the snow-goblins camp on the slopes below it like lice on a dog. They keep tally-sticks of what they steal — goats, ponies, dwarves, and now a shard of a crown — and every stick is notched with which tunnel the plunder went down. Kill enough of them and take the sticks. I can read goblin-tally; it is the only thing they write worth reading.",
      accept: 'I will bring you their tally-sticks.',
      progress: 'The Snow-goblins camp on the slopes below the Front Porch, north of the High Crag.',
      complete: "Aye, here — 'bright stone, to the Great One's hall' — and the Great One is Grishkhâl, the Great Goblin, whose grandfather my company killed and who has not forgiven us. The shard is in his hall under the mountain. That will take more than one sword, but we will begin with one.",
      summary: 'Slay the Snow-goblins below the Front Porch and gather their tally-sticks for Glóin to read.',
      hint: 'The goblins camp north of the High Crag on the slopes below the Front Porch of Goblin-town.',
    }),
    quest(66, B6, {
      name: 'The Frozen Falls', zone: 'misty', giver: 'npc_highcrag_nimwen', turnin: 'npc_highcrag_nimwen',
      objectives: [
        explore(1560, -620, 18, 'Scout the Frozen Falls'),
        kill('snow_warg', 6, 'Slay Snow-wargs that hunt along the falls'),
        collectNode('mat_snow_lichen', 4, 'gn_misty_2', 'Gather snow-lichen from the rocks below the falls'),
      ],
      rewards: { choose: setPick('rivendell', 'feet'), items: ['pot_heal_greater'] },
      intro: "Glóin will tell you of the goblins, but the wargs are my concern, and they are the goblins' eyes. A pack has moved down from the High Pass to hunt along the Frozen Falls west of the goblin-gate, and while they run, nothing moves on the mountain unseen. Scout the falls, kill what you find, and gather the grey lichen from the rocks below the ice — the dwarf-smith brews it into a salve for frost-bite, and I fear we will need a great deal of salve before this is over.",
      accept: 'The wargs will not see me coming.',
      progress: 'The Frozen Falls are north-west of the High Crag; the lichen grows on the rocks below the ice.',
      complete: "Six fewer eyes on the mountain, and lichen enough for a winter. Hannar sends his thanks and a jar of the salve. Now that the wargs are scattered we can move on the Porch itself, and Glóin has been waiting for that a long time.",
      summary: 'Scout the Frozen Falls, kill the Snow-wargs that hunt there, and gather snow-lichen for the salve.',
      hint: 'The Frozen Falls lie north-west of the High Crag camp.',
    }),
    quest(67, B6, {
      name: 'Archers on the Porch', zone: 'misty', giver: 'npc_highcrag_gloin', turnin: 'npc_highcrag_gloin',
      objectives: [
        kill('goblin_archer_misty', 6, 'Slay Goblin-town Archers on the Front Porch'),
        explore(1800, -560, 22, 'Look upon the gate of Goblin-town'),
      ],
      rewards: { items: ['scroll_tactics_50', 'pot_heal_greater'] },
      intro: "Grishkhâl keeps archers on the ledges above the Front Porch, and their arrows are tipped with something that turns a wound black in an hour. Nothing gets to his door under those bows; not dwarves, not you. Go up past the goblin-camps and clear the ledges, and while you are there, get a good look at the gate itself. I want to know how many guards stand at it, and whether the great doors still hang as they did when Gandalf broke them.",
      accept: 'I will clear the ledges and look on the gate.',
      progress: 'The archers hold the ledges above the Front Porch, north-east of the High Crag.',
      complete: "The doors stand, but they are barred from within — so it will not be the way we came out last time. There is another way, and it wants a key, and a key wants mithril. I shall explain when I have thought it through; for now, the ledges are yours, and that is more than I had this morning.",
      summary: 'Clear the Goblin-town Archers from the ledges of the Front Porch and scout the gate.',
      hint: 'The Front Porch of Goblin-town lies north-east of the High Crag, beyond the goblin camps.',
    }),
    quest(68, B6, {
      name: 'The Mithril Seam', zone: 'misty', giver: 'npc_highcrag_gloin', turnin: 'npc_highcrag_gloin',
      objectives: [
        collectNode('mat_mithril_flake', 3, 'gn_misty_1', 'Gather mithril flakes from the seam above the camp'),
        talk('npc_highcrag_smith', 'Bring the mithril to Hannar the dwarf-smith'),
      ],
      rewards: { items: ['n_pocket_waybread', 'pot_heal_greater'] },
      intro: "There is a seam of true-silver in the crag above this camp — a poor one, a few flakes to the ton, but the only mithril this side of Moria. The old key to the goblins' back-door was mithril, and it was lost when the mountain shook; Hannar can forge another if he has enough of the metal to work. Go up to the seam and gather what you can find, then take it to Hannar at the forge. He will complain about the quality. Ignore him.",
      accept: 'I will bring Hannar his mithril.',
      progress: 'The mithril seam is in the crag just east of the High Crag camp; Hannar works at the forge in the camp.',
      complete: "Three flakes — Hannar says it is enough, if only just, and if I stop asking him questions while he works. He will need something else before the key is done, something the giants have and will not give. But first there is the matter of the giants themselves.",
      summary: 'Gather mithril flakes from the seam above the High Crag and bring them to Hannar the smith.',
      hint: 'The mithril seam is in the crag east of the camp; Hannar is at the forge.',
    }),
    quest(69, B6, {
      name: "The Giant's Stair", zone: 'misty', giver: 'npc_highcrag_gloin', turnin: 'npc_highcrag_gloin',
      objectives: [
        explore(1750, -300, 20, "Climb the Giant's Stair"),
        kill('stone_giant', 5, "Slay Stone-giants on the Giant's Stair"),
      ],
      rewards: { choose: setPick('moria', 'chest'), items: ['pot_power_greater'] },
      intro: "The stone-giants have taken the theft of their shard badly, and since they cannot reach the goblins in their holes they have taken to throwing rocks at everything else — at my goats, at Nimwen's scouts, at the road. The Giant's Stair is their high road, south-east of the camp; it climbs to the council-place of their elders. Go up and teach the young ones that a dwarf's camp is not a target. I do not ask you to kill the elders. Not yet.",
      accept: 'I will climb the Stair.',
      progress: "The Giant's Stair climbs south-east of the High Crag; the stone-giants gather along it.",
      complete: "They have stopped throwing rocks at the goats, which is something. This plate came up from Moria with Bofri's last caravan — the Iron Garrison sends it to whoever fights beside the dwarves, and you have. Wear it; the mountain gets colder from here.",
      summary: "Climb the Giant's Stair and drive back the Stone-giants that have been stoning the High Crag.",
      hint: "The Giant's Stair is south-east of the High Crag camp.",
    }),
    quest(70, B6, {
      name: 'The Drake Roost', zone: 'misty', giver: 'npc_highcrag_nimwen', turnin: 'npc_highcrag_nimwen',
      objectives: [
        explore(1900, -440, 18, 'Find the Drake Roost above the High Pass'),
        kill('cold_drake', 5, 'Slay Cold-drakes at the roost'),
        use('gn_misty_4', 1, "Search the drakes' hoard"),
      ],
      rewards: { items: ['pot_heal_greater', 'scroll_warding_50'] },
      intro: "One of my scouts came down from the High Pass last night with half a cloak and a story: cold-drakes, a dozen of them, roosting in the crags east of the Front Porch, and something bright glittering in the hoard beneath them. Drakes love bright things; so do goblins; and goblins have been going in and out of that roost like ants. If Grishkhâl has hidden the shard with the drakes to keep it from the giants, we must know. Go up, kill what you must, and search the hoard.",
      accept: 'I will search the drakes’ hoard.',
      progress: 'The Drake Roost is in the crags east of the Front Porch, below the High Pass.',
      complete: "Not there — only goblin-gold and a great many bones. So the shard is still in Grishkhâl's hall, and the goblins were paying the drakes in gold to guard the pass against the giants. That, at least, they will no longer be able to do.",
      summary: 'Find the Drake Roost, slay the Cold-drakes and search their hoard for the shard.',
      hint: 'The roost is in the crags east of the Front Porch, on the way up to the High Pass.',
    }),
    quest(71, B6, {
      name: "The Giants' Council", zone: 'misty', giver: 'npc_highcrag_gloin', turnin: 'npc_highcrag_gloin',
      objectives: [
        talk('npc_highcrag_brok', 'Ask Brók the skald for the giants’ tongue'),
        kill('giant_elder', 3, "Break the Giant Elders' council"),
        explore(1950, -500, 20, 'Reach the High Pass'),
      ],
      rewards: { items: ['food_waybread', 'pot_heal_greater'] },
      intro: "Hannar needs one more thing for the key: a rune-stone of the giants, for the back-door of Goblin-town was giant-work before ever a goblin squatted in it. The elders hold council at the top of the Giant's Stair, and they hold the stones. Brók has a few words of their tongue — ask him for them before you go — but I will tell you plainly that the elders have never yet answered words. If they will not parley, break their council, and then go on to the High Pass to see that the way east is not held against us.",
      accept: 'I will try words first, and steel second.',
      progress: "Brók is in the camp; the Giant Elders hold council at the top of the Giant's Stair; the High Pass lies beyond.",
      complete: "They threw rocks at the parley, did they? Then they have only themselves to thank. The Pass is clear, the elders are humbled, and Hannar says the younger giants will surrender a rune-stone now that their elders cannot forbid it. We are close, my friend.",
      summary: "Learn the giants' tongue from Brók, break the Giant Elders' council and scout the High Pass.",
      hint: "Brók is in the High Crag camp; the elders' council is at the top of the Giant's Stair, east of the camp.",
    }),
    quest(72, B6, {
      name: 'Orders from Goblin-town', zone: 'misty', giver: 'npc_highcrag_nimwen', turnin: 'npc_highcrag_nimwen',
      objectives: [
        collectNode('q_goblin_orders', 4, 'gn_misty_3', 'Recover Goblin Orders from the posts at the gate'),
        collectFrom('mat_drake_scale', 4, 'cold_drake', 'Take Drake Scales from the Cold-drakes'),
      ],
      rewards: { choose: setPick('moria', 'legs'), items: ['n_pocket_giant'] },
      intro: "The goblins nail their orders to posts at the gate, for the ones that can read to tell the ones that cannot — and the orders come down from Grishkhâl's hall, written in a hand that is not a goblin's. I want them. And I want drake-scale: four good scales from the cold-drakes, for the goblins throw fire in their tunnels and a scale-shield is the only thing that turns it. Gather both, and we will know what the Great Goblin has been told to do, and be ready to walk through his fire to stop him.",
      accept: 'I will take their orders and the drakes’ scales.',
      progress: 'The orders are posted at the Front Porch; the cold-drakes roost in the crags east of it.',
      complete: "Look at this hand — long and white and even, like an elf's, and not one goblin-word in it. 'Hold the stone until the ship comes.' The Pale Hand means to carry the shard away by sea. Whatever we do, we must do before that ship sails.",
      summary: 'Recover the Goblin Orders posted at the Front Porch and gather drake-scale for shields against goblin-fire.',
      hint: 'The orders are posted at the Front Porch gate; the drakes roost in the crags east of it.',
    }),
    quest(73, B6, {
      name: 'The Key of Mithril', zone: 'misty', giver: 'npc_highcrag_gloin', turnin: 'npc_highcrag_gloin',
      objectives: [
        talk('npc_highcrag_smith', 'Ask Hannar what the key still lacks'),
        kill('stone_giant', 5, "Slay Stone-giants that guard the rune-stones"),
        collectFrom('qb_giant_rune', 3, 'stone_giant', 'Take Rune-carved Giant-stones from the Stone-giants'),
      ],
      rewards: { items: ['pot_heal_greater', 'pot_power_greater'] },
      intro: "Hannar has the mithril, and the young giants promised a rune-stone — and then did not bring it, because giants promise as easily as they forget. Ask Hannar what the key still wants; I believe it is the rune-stones themselves, carved with the shape of the back-door's lock, and the giants who guard the Stair carry them. Take what the giants will not give. I am past patience with giants.",
      accept: 'I will bring Hannar the giants’ rune-stones.',
      progress: "Hannar is at the forge in the camp; the Stone-giants with rune-stones are on the Giant's Stair.",
      complete: "It is done: a key of mithril with the giants' runes cut into the bit. Hannar says it will open the back-door of Goblin-town or he will eat his beard. Now — the gate-keys. The archers on the Porch carry them, and we shall need one for the inner doors as well.",
      summary: 'Take the rune-carved giant-stones that Hannar needs and see the Key of Mithril finished.',
      hint: "Hannar is at the High Crag forge; the Stone-giants are on the Giant's Stair south-east of the camp.",
    }),
    quest(74, B6, {
      name: 'Beneath the Front Porch', zone: 'misty', giver: 'npc_highcrag_gloin', turnin: 'npc_highcrag_gloin',
      objectives: [
        kill('goblin_archer_misty', 6, "Slay the Great Goblin's archers at the gate"),
        collectFrom('qb_goblin_key', 3, 'goblin_archer_misty', 'Take Goblin Gate-keys from the archers'),
      ],
      rewards: { items: ['scroll_fortune_50', 'pot_heal_greater'] },
      intro: "The key of mithril opens the back-door, but Goblin-town is a warren of doors, and the inner ones are locked with plain iron. Grishkhâl's archers carry the gate-keys on their belts — the ones at the gate itself, his own guard, not the rabble on the ledges. Kill them and take every key you can. Three should see us through to the Great Goblin's hall. And then, my friend, you and I will settle a very old debt.",
      accept: 'I will take the keys from the guard.',
      progress: "The Great Goblin's archers guard the Front Porch gate, north-east of the High Crag.",
      complete: "Three keys, and the Porch is quiet for the first time in a year. There is nothing left between us and Grishkhâl but Grishkhâl. Sleep now; we go in at dawn, and I would not have you yawning when you meet the Great Goblin.",
      summary: "Slay the Great Goblin's archers at the gate and take their gate-keys for the inner doors.",
      hint: 'The archers of the guard stand at the Front Porch gate, north-east of the High Crag.',
    }),
    quest(75, B6, {
      name: 'The Great Goblin', zone: 'misty', giver: 'npc_highcrag_gloin', turnin: 'npc_rivendell_elrond',
      objectives: [
        killboss('boss_grishkhal', 'Slay the Great Goblin Grishkhâl beneath the Front Porch'),
        talk('npc_rivendell_gandalf', 'Bring word of the shard to Gandalf in Rivendell'),
      ],
      rewards: { choose: setPick('moria', 'head'), title: 'Elf-friend', mount: 'mount_elven', items: ['drink_miruvor', 'scroll_swiftfoot_50'] },
      intro: "Grishkhâl sits in his grandfather's hall under the Front Porch with the shard of Arnor on the arm of his throne, waiting for a ship that will never come if you and I have anything to say about it. Take the keys and go in; I am too old to run through tunnels, but I will hold the door. When you have the shard, do not linger in the mountain — ride down the Stair to Rivendell and put it in Gandalf's hands before the Pale Hand learns his goblin is dead. Go with the blessing of the Longbeards.",
      accept: 'The Great Goblin has sat on that throne long enough.',
      progress: "Grishkhâl's hall is beneath the Front Porch of Goblin-town. Afterwards, ride to Rivendell and find Gandalf.",
      complete: "Two shards, then, in Rivendell, and the Great Goblin dead — Glóin will dine on that tale for a year. Gandalf has told me what the orders said: a ship, and the sea. The Pale Hand has gone north to Angmar to gather what he needs for the crossing, and Carn Dûm has a sorcerer who has kept a shard for the Witch-king since Arvedui's day. You are an Elf-friend now, and the horses of Imladris are yours to ride. Ride north, for we are running out of time.",
      summary: 'Slay the Great Goblin Grishkhâl, recover the shard and bring word of it to Gandalf in Rivendell.',
      hint: "Grishkhâl's hall lies beneath the Front Porch of Goblin-town; Gandalf is in the Hall of Fire in Rivendell.",
    }),

    // ================================================================ BOOK 7: FROST AND IRON (Angmar & Forochel)
    quest(76, B7, {
      name: 'The Gate of Angmar', zone: 'angmar', giver: 'npc_rivendell_elrond', turnin: 'npc_aughaire_crannog',
      objectives: [
        explore(735, -1035, 22, 'Pass the gate of Rammas Deluon'),
        kill('angmar_warg', 6, 'Slay Wargs of Angmar on the road to Aughaire'),
        talk('npc_aughaire_guard', 'Present yourself to Tadhg at the gate of Aughaire'),
      ],
      rewards: { items: ['pot_heal_greater', 'food_waybread'] },
      intro: "Angmar is a dead land ruled from a dead city, but not all who live there serve it. The hillmen of the Trév Gállorg at Aughaire have turned against Carn Dûm, and their chieftain Crannog has asked the Dúnedain for aid; Halbarad's Rangers ride north from Esteldín to the gate of Rammas Deluon, and beyond it the road is yours alone. Ride north through the North Downs to Esteldín and take the road to Angmar. The wargs of Carn Dûm hunt that road; kill what hunts you, and give your name to the guard at Aughaire's gate.",
      accept: 'I will ride north to Aughaire.',
      progress: 'The road to Angmar runs north-east from Esteldín through Rammas Deluon to the hillman camp of Aughaire.',
      complete: "Tadhg says a rider from Rivendell came through the gate with warg-blood to the elbow, and I said, good, that is the one Elrond promised. I am Crannog, chieftain of the Trév Gállorg, and you are welcome among the hillmen who have chosen the harder road. The Pale Hand passed through Rammas Deluon eight days ago with an escort of Orcs, bound for Carn Dûm. We will follow him, but not before we have cut the legs from under the Orcs he left behind.",
      summary: 'Ride north from Rivendell through Rammas Deluon to Aughaire, clearing the wargs, and meet Crannog.',
      hint: 'From Esteldín the road to Angmar runs north-east through the gate of Rammas Deluon to Aughaire.',
    }),
    quest(77, B7, {
      name: 'Orcs of the Trév Gállorg', zone: 'angmar', giver: 'npc_aughaire_crannog', turnin: 'npc_aughaire_crannog',
      objectives: [
        kill('angmar_orc', 8, 'Slay Orcs of Angmar east of Aughaire'),
        collectFrom('qb_orc_wartoken', 4, 'angmar_orc', 'Take Orc War-tokens from the Orcs'),
      ],
      rewards: { items: ['pot_power_greater', 'pot_heal_greater'] },
      intro: "When my people broke with Carn Dûm, the Orcs came and burned three villages of the Trév Gállorg, and they camp now on the ashes east of this wall, waiting for the order to come for the fourth. Every Orc of Angmar carries a war-token — his master's leave to raid, stamped with the sign of the city. Take the tokens; without them the Orcs are deserters in their own master's eyes and the Uruks will hang them for us. Kill what you must to get them. I will not pretend I want you to spare any.",
      accept: 'The Orcs will pay for the villages.',
      progress: 'The Orcs of Angmar camp on the burned ground east of Aughaire.',
      complete: "Four tokens, and eight Orcs fewer to trouble my people. Bréanna, our wise-woman, has been reading the tokens' runes while you were out, and she does not like what she reads. Speak to her; she has work for you that I cannot do with a sword.",
      summary: 'Slay the Orcs of Angmar camped east of Aughaire and take their war-tokens.',
      hint: 'The Orc camp is on the burned ground east of Aughaire.',
    }),
    quest(78, B7, {
      name: "Bréanna's Warding", zone: 'angmar', giver: 'npc_aughaire_breanna', turnin: 'npc_aughaire_breanna',
      objectives: [
        collectNode('mat_nightshade', 4, 'gn_angmar_2', 'Gather nightshade from the hollows west of the camp'),
        kill('angmar_bat', 6, 'Slay Gaunt-bats about Barad Gúlaran'),
        explore(1150, -1050, 20, 'Look upon the tower of Barad Gúlaran'),
      ],
      rewards: { choose: setPick('moria', 'shoulder'), items: ['pot_heal_greater'] },
      intro: "The tokens are marked with a binding-rune, and a binding-rune means a sorcerer, and the sorcerer of Carn Dûm is Gûlmaethor, who has not left his tower in a hundred years — until now. I can make a ward against his craft, but I need nightshade from the hollows west of the camp, and the wings of the gaunt-bats that roost about Barad Gúlaran, the black tower in the east, for the bats carry his sight. Gather the one and kill the other, and look on the tower while you are there so that you will know it again. You will see it in your dreams, I fear.",
      accept: 'I will gather what your warding needs.',
      progress: 'Nightshade grows in the hollows west of Aughaire; the gaunt-bats roost about Barad Gúlaran, east along the river.',
      complete: "Good — the nightshade is fresh and the bats are dead, and Gûlmaethor is blind in this valley for a while. The ward will take a night to make. Duald, our scout, has been watching the bogs of Malenhad, and he says the sorcerer's acolytes are there in numbers, doing something to the river.",
      summary: 'Gather nightshade, slay the gaunt-bats of Barad Gúlaran and look upon the tower for Bréanna’s warding.',
      hint: 'The nightshade hollows are west of Aughaire; Barad Gúlaran stands east of the camp beyond the river.',
    }),
    quest(79, B7, {
      name: 'The Bogs of Malenhad', zone: 'angmar', giver: 'npc_aughaire_duald', turnin: 'npc_aughaire_duald',
      objectives: [
        explore(1000, -1400, 22, 'Scout the Bogs of Malenhad'),
        kill('angmar_acolyte', 6, 'Slay Acolytes of Carn Dûm on the approach'),
        fish(3, 'fs_hoarwell_angmar', 'Fish the Hoarwell headwaters to test the water'),
      ],
      rewards: { items: ['pot_heal_athelas', 'bait_shrimp'] },
      intro: "Malenhad is a bog north of the camp where nothing grows and the mist has a smell to it, and the sorcerer's acolytes have been wading in it to their waists, chanting. Whatever they are doing, it runs downstream: the Hoarwell rises just east of there, and the fish in the headwaters have begun to come up dead. Scout the bog, kill the acolytes you find on the approach to Carn Dûm, and cast a line in the headwaters. If what comes up is fit to eat, the river is clean; if it is not, the whole Trollshaws will drink poison by winter.",
      accept: 'I will see what the acolytes have done to the river.',
      progress: 'The bogs of Malenhad are north of Aughaire; the acolytes camp on the approach to Carn Dûm; the Hoarwell rises east of the bog.',
      complete: "Live fish, clean-gilled — the river is not poisoned, then; the acolytes were not fouling the water but calling something up out of it. Bréanna says that is worse. Whatever they woke, it has gone north with the Pale Hand, and the Uruks of Himbar have moved to cover his road.",
      summary: 'Scout the bogs of Malenhad, slay the acolytes on the approach to Carn Dûm and test the Hoarwell headwaters.',
      hint: 'Malenhad lies north of Aughaire; the Hoarwell headwaters are east of the bog.',
    }),
    quest(80, B7, {
      name: 'The Ruins of Himbar', zone: 'angmar', giver: 'npc_aughaire_crannog', turnin: 'npc_aughaire_crannog',
      objectives: [
        kill('angmar_uruk', 6, 'Slay Uruks of Carn Dûm at Himbar'),
        explore(890, -1430, 20, 'Explore the ruins of Himbar'),
        collectFrom('qb_himbar_banner', 3, 'angmar_uruk', 'Tear down the Banners of Himbar'),
      ],
      rewards: { items: ['pot_power_celebrant', 'pot_heal_athelas'] },
      intro: "Himbar was a fortress of the hillmen once, before the Witch-king, and the Uruks of Carn Dûm have raised their banners on its walls to hold the road north. It galls me more than I can say. Go to the ruins north of Malenhad, cut down the Uruks who hold them, and bring me their banners; my people will burn them in the standing-stone circle and remember that we were free once. And look at the banners before you burn them. Duald says the Pale Hand has painted his mark over the Eye of Angmar, as though he outranks it.",
      accept: 'Himbar will fly no Uruk banners tonight.',
      progress: 'Himbar lies north of Aughaire, beyond the bogs of Malenhad; the Uruks hold its walls.',
      complete: "He has, too — a white hand over the Eye. Bréanna says that is not arrogance; it is a claim. The Pale Hand no longer serves Angmar; he means Angmar to serve his Gaunt-lord. With Himbar clear the road to Carn Dûm is open, and only the wights of the approach stand between us and its gate.",
      summary: 'Drive the Uruks of Carn Dûm from the ruins of Himbar and tear down their banners.',
      hint: 'Himbar is north of Aughaire, past the bogs of Malenhad.',
    }),
    quest(81, B7, {
      name: 'Gaunt-wights of the Approach', zone: 'angmar', giver: 'npc_aughaire_breanna', turnin: 'npc_aughaire_breanna',
      objectives: [
        kill('angmar_wight', 6, 'Lay the Gaunt-wights of the approach to rest'),
        collectFrom('qb_gaunt_fetter', 4, 'angmar_wight', 'Take Gaunt-fetters from the wights'),
        deliver('qb_breanna_ward', 'npc_aughaire_muirne', "Give Bréanna's Ward to Muirne the war-leader"),
      ],
      rewards: { choose: setPick('moria', 'hands'), items: ['pot_heal_athelas'] },
      intro: "The ward is made — two of them, in truth; one for you, which I have already sewn into your cloak, and one for Muirne, who leads our spears and will not wait for you to open the gate of Carn Dûm. Give her the ward before she marches. Then go up the approach to the city, where the gaunt-wights walk in their fetters, and put them down; every fetter you bring back is a binding broken, and Gûlmaethor grows weaker with each. You will feel it when he does. So will he.",
      accept: 'I will carry the ward to Muirne and break the wights’ fetters.',
      progress: 'Muirne is in Aughaire by the training-ground; the gaunt-wights walk the approach to Carn Dûm, north-east of Himbar.',
      complete: "Four fetters — I can feel his bindings fraying from here. Muirne has the ward, and she says the spears of the Trév Gállorg will hold the outer gate while you go in. Crannog is waiting for you at the fire; he has the last of it planned.",
      summary: "Give Bréanna's Ward to Muirne, lay the Gaunt-wights of the approach to rest and bring back their fetters.",
      hint: 'Muirne is in Aughaire; the wights walk the approach to Carn Dûm north-east of Himbar.',
    }),
    quest(82, B7, {
      name: 'The Outer Gate of Carn Dûm', zone: 'angmar', giver: 'npc_aughaire_crannog', turnin: 'npc_aughaire_crannog',
      objectives: [
        kill('angmar_uruk_captain', 3, 'Slay the Uruk Captains at the outer gate'),
        collectNode('q_angmar_dispatch', 4, 'gn_angmar_3', 'Recover Angmarim Dispatches from the gatehouse'),
        explore(1250, -1500, 25, 'Stand before the walls of Carn Dûm'),
      ],
      rewards: { items: ['n_ring_moria', 'pot_heal_athelas'] },
      intro: "Carn Dûm. My grandfather's grandfather was born a slave there, and I have never seen its walls but in nightmare. Muirne's spears will draw the garrison to the west; you go to the outer gate, where three Uruk captains hold the gatehouse, and kill them. The dispatches of the city pass through that gatehouse, and I want every one you can find — the Pale Hand has written to Gûlmaethor, and the sorcerer keeps his letters. Then stand before the walls and look at them, so that when you go in tomorrow you will not be afraid.",
      accept: 'I will take the outer gate.',
      progress: 'The outer gate of Carn Dûm is north-east of Himbar at the end of the approach; the dispatches are kept in the gatehouse.',
      complete: "You have stood before Carn Dûm and come back. That is more than any of my line has done. The dispatches say the Pale Hand has taken the sorcerer's shard and gone north across the ice to Forochel, and left Gûlmaethor to hold the city and 'hold the hero' — that is you — at any cost. He will be waiting for you in his vault. Do not keep him waiting.",
      summary: 'Slay the Uruk Captains at the outer gate of Carn Dûm and recover the dispatches from the gatehouse.',
      hint: 'The outer gate of Carn Dûm is at the end of the approach, north-east of Himbar.',
    }),
    quest(83, B7, {
      name: 'Gûlmaethor', zone: 'angmar', giver: 'npc_aughaire_crannog', turnin: 'npc_aughaire_crannog',
      objectives: [
        killboss('boss_gulmaethor', 'Defeat Gûlmaethor, Sorcerer of Carn Dûm'),
        use('gn_angmar_4', 1, "Open the sorcerer's vault"),
      ],
      rewards: { items: ['pot_heal_athelas', 'pot_power_celebrant', 'scroll_fortitude_50'] },
      intro: "Gûlmaethor waits in the heart of Carn Dûm with the key of his vault about his neck, and what the Pale Hand did not take is still in that vault — the letters, the maps, the plan of the crossing. He has been the Witch-king's sorcerer since before the fall of Fornost, and Bréanna's ward will turn his craft for a while, but not for long. Go in, kill him, take the key and open the vault. When you come out, the Trév Gállorg will be a free people for the first time in a thousand years, and it will be your doing.",
      accept: 'The sorcerer has kept his vault long enough.',
      progress: "Gûlmaethor is in the citadel of Carn Dûm; his vault lies just beyond his chamber and opens with the key he carries.",
      complete: "Gûlmaethor is dead and Carn Dûm is empty of everything but Uruks, who will not last the winter without him. The vault held what we hoped: the Pale Hand's charts. He crossed the ice to Forochel to find a ship — an old ship, the dispatches say, 'the Lost King's ship' — and the Lossoth of Sûri-kylä have been his guides, though I doubt they know what they guide. The road north from here runs to Sûri-kylä, and Elder Yrjö of the Lossoth is a friend to the hillmen. Go to him.",
      summary: "Slay Gûlmaethor, Sorcerer of Carn Dûm, and open his vault to learn where the Pale Hand has gone.",
      hint: "Gûlmaethor's citadel is in the heart of Carn Dûm; the vault lies beyond his chamber.",
    }),
    quest(84, B7, {
      name: 'North to Sûri-kylä', zone: 'forochel', giver: 'npc_aughaire_crannog', turnin: 'npc_surikyla_yrjo',
      objectives: [
        kill('snow_wolf', 6, 'Slay Snow-wolves on the road to Forochel'),
        talk('npc_surikyla_tuula', 'Speak with Tuula, the wise-woman of the Lossoth'),
      ],
      rewards: { choose: setPick('moria', 'feet'), items: ['food_fish_stew'] },
      intro: "The road from Aughaire runs north over the tundra to Sûri-kylä on the Ice-bay, where the Lossoth live who have never bowed to Angmar. Yrjö is their elder and a shrewd man; Tuula is their wise-woman, and she sees further than Bréanna, which Bréanna does not like to hear. Snow-wolves hunt the road in packs this late in the year, so ride with a bare blade. Tell Tuula what the Pale Hand is, and then tell Yrjö. The Lossoth will not have known whom they guided; they will want to make it right.",
      accept: 'I will ride north to the Lossoth.',
      progress: 'The road north from Aughaire crosses the tundra to Sûri-kylä on the Ice-bay. Tuula is at the Ice-altar.',
      complete: "Tuula has told me what you told her, and the Lossoth are ashamed. We showed the pale stranger the way to the wreck on the shore of the bay and took his silver for it, and he thanked us with a curse: the ice-bears have gone mad since he passed, and the Gauredain raid our herds under his mark. You have come to make an end of him. We will help you make it.",
      summary: 'Ride north from Aughaire to Sûri-kylä, clearing the snow-wolves, and bring word of the Pale Hand to the Lossoth.',
      hint: 'Follow the road north from Aughaire across the tundra to Sûri-kylä; Tuula is at the Ice-altar in the village.',
    }),
    quest(85, B7, {
      name: 'The Gauredain', zone: 'forochel', giver: 'npc_surikyla_vaino', turnin: 'npc_surikyla_vaino',
      objectives: [
        kill('gauredain', 6, 'Slay Gauredain Raiders at Hylje-leiri'),
        explore(720, -1950, 20, 'Scout the raider camp of Hylje-leiri'),
        collectFrom('qb_gauredain_totem', 3, 'gauredain', 'Take Gauredain Totems from the raiders'),
      ],
      rewards: { items: ['n_wrist_angmar', 'pot_heal_athelas'] },
      intro: "The Gauredain are wolf-men of the far north who sell their spears to anyone, and the pale stranger bought them all. They have made a camp at Hylje-leiri on the shore east of the village, and from it they raid our reindeer and our fishing-huts by night. Go and break them. Bring me their totems; the pale one gave them, and I would see whether he marked them as he marked everything else. I would go myself, but the elder says a hunter with one arm is worth more alive than a hero with two dead.",
      accept: 'The Gauredain will raid no more.',
      progress: 'Hylje-leiri is on the shore of the bay east of Sûri-kylä.',
      complete: "His mark, under the fur of every totem. The Gauredain will scatter now that their paymaster's camp is broken, and the herds will come back to the pens. Tuula says you should come to her; she has found something about the wreck the stranger asked us to show him.",
      summary: 'Break the Gauredain raiders at Hylje-leiri and take their totems for Väinö.',
      hint: 'Hylje-leiri lies on the shore of the Ice-bay east of Sûri-kylä.',
    }),
    quest(86, B7, {
      name: "The Wreck of the Lost King's Ship", zone: 'forochel', giver: 'npc_surikyla_tuula', turnin: 'npc_surikyla_tuula',
      objectives: [
        explore(700, -1980, 18, "Find the Wreck of the Lost King's Ship"),
        use('gn_forochel_3', 3, 'Search the wreck'),
        kill('forochel_giant', 5, 'Slay Snow-giants that prowl the wreck-shore'),
        fish(3, 'fs_forochel_bay', 'Fish the Ice-bay for what the wreck lost'),
      ],
      rewards: { items: ['drink_lossoth_tea', 'pot_power_celebrant'] },
      intro: "Long ago a king of the Dúnedain fled to this bay with his people's treasure, and the elves sent a ship for him, and the ice took the ship and the king together — so the Lossoth tell it, and so it was. The pale stranger asked to be shown the wreck on the shore, and we showed him, and he went into it alone and came out with his face shining. Go to the wreck south of Hylje-leiri and search it; I must know what he found there, and what he did not. The snow-giants have taken to prowling the shore since he came, and the bay itself may hold what the wreck spilled — cast a line where the ice is thin.",
      accept: 'I will search the Lost King’s ship.',
      progress: "The wreck lies on the shore of the bay south of Hylje-leiri; the giants prowl the shore, and the Ice-bay landing is west of the village.",
      complete: "A Lossoth charm, and a king's ring from the bay, and the shape of a hollow in the ship's strong-room where something the size of a fist was pried loose. He found the shard of Arvedui's crown there, and left three days ago on the ice towards the bear-dens. Kelvarhjar, the White Matriarch, has not let a man cross that ice in twenty years — and I think that is why he went that way.",
      summary: "Search the Wreck of the Lost King's Ship, drive off the Snow-giants and fish the Ice-bay for what the wreck lost.",
      hint: 'The wreck is on the southern shore of the bay, south of Hylje-leiri; the Ice-bay landing is west of Sûri-kylä.',
    }),
    quest(87, B7, {
      name: 'Frost-drakes of the Bay', zone: 'forochel', giver: 'npc_surikyla_vaino', turnin: 'npc_surikyla_vaino',
      objectives: [
        kill('forochel_drake', 5, 'Slay Frost-drakes on the shore of the Ice-bay'),
        collectFrom('qb_frost_heart', 3, 'forochel_drake', 'Cut out Frost-drake Hearts for the Ice-altar'),
      ],
      rewards: { choose: setPick('angmarbane', 'chest'), items: ['pot_heal_athelas'] },
      intro: "If you are to cross the bear-ice you will need the blessing of the Ice-altar, and the altar takes drake-hearts, for nothing else burns cold enough. Frost-drakes have come down to the shore south of the village since the stranger passed — he seems to draw such things after him like a sledge draws dogs. Kill them and cut out three hearts. Tuula will do the rest, and the smiths of Angmar have sent up armour for you by the road; the hillmen say it is warded against sorcery, and you will want that where you are going.",
      accept: 'I will bring three hearts to the altar.',
      progress: 'The frost-drakes roost on the shore south-west of Sûri-kylä.',
      complete: "Three hearts, still frosted — the altar will burn tonight and Tuula will sing the ice open for you. Yrjö has called the hunters together. He will not say it, but he means to send you after the White Matriarch, and he does not expect you to come back.",
      summary: 'Slay the Frost-drakes on the shore of the Ice-bay and cut out their hearts for the Ice-altar.',
      hint: 'The frost-drakes roost on the shore south-west of Sûri-kylä.',
    }),
    quest(88, B7, {
      name: 'The White Matriarch', zone: 'forochel', giver: 'npc_surikyla_yrjo', turnin: 'npc_surikyla_yrjo',
      objectives: [
        kill('elder_ice_bear', 3, 'Slay the Elder Ice-bears of the old den'),
        killboss('boss_kelvarhjar', 'Slay Kelvarhjar, the White Matriarch'),
      ],
      rewards: { choose: setPick('angmarbane', 'legs'), title: 'Bane of Angmar', items: ['n_cloak_lossoth', 'pot_heal_athelas'] },
      intro: "Kelvarhjar, the White Matriarch, has ruled the ice-bears of this bay since my father's day, and we have lived beside her by never crossing her den. The pale stranger crossed it, and he left a sickness in her — she has killed four hunters this month, and her elders kill what she does not. He has made her his gatekeeper. Kill the elders at the old den west of the village, then go to her den on the eastern shore and end her; I would not ask it if there were any other way to the ice. When she is dead the way north-west is open, and whatever the stranger left on the far side of the ice, you will find it.",
      accept: 'I am sorry for the Matriarch. It will be quick.',
      progress: 'The old den of the elders is west of Sûri-kylä; Kelvarhjar’s den is on the eastern shore of the bay.',
      complete: "The hunters brought her body back on three sledges, and the village will mourn her as they would an elder of our own, for she was one, in her way. Angmar is broken, the bear-ice is open, and Tuula has looked into the fire: the Pale Hand is gone by sea, to the Sundered Isles in the west, and the shards go with him. Sampo the Ice-pilot can take you as far as the lake of Evendim. From there you must find a ship at Celondim, in the Blue Mountains, for the isles — and you must go quickly, Bane of Angmar. The fire says the rite has already begun.",
      summary: 'Slay the Elder Ice-bears of the old den and Kelvarhjar, the White Matriarch, to open the way across the ice.',
      hint: "The old den is west of Sûri-kylä; the Matriarch's den is on the eastern shore of the Ice-bay.",
    }),

    // ================================================================ BOOK 8: THE SUNDERED ISLES (Tol Morwen, Tol Fuin, Himling)
    quest(89, B8, {
      name: "The Ice-pilot's Charts", zone: 'tolmorwen', giver: 'npc_surikyla_boat', turnin: 'npc_morwenvillage_elder',
      objectives: [
        explore(-1760, 760, 20, 'Find the Wreck of the Grey Gull on Tol Morwen'),
        collectFrom('qb_drowned_ring', 4, 'morwen_wight', "Take Drowned Sailors' Rings from the Drowned Wights"),
        talk('npc_morwenvillage_hakon', 'Ask Hakon the old sailor about the Grey Gull'),
      ],
      rewards: { items: ['pot_power_celebrant', 'food_fish_stew'] },
      intro: "I am Sampo, and I know every current from this bay to the lake of Evendim, and I will tell you what I told Tuula: the pale one did not sail from here. He crossed the ice to the west and took ship at the mouth of the Lune, and my cousins among the fishers of Celondim say his ship was seen off Tol Morwen, the little isle in the south, where a fine elven vessel called the Grey Gull went down on the rocks that same week. I will take you across the water to Tinnudir; ride from there to Celondim in the Blue Mountains and take the boat for Morwen Harbour. Find the wreck of the Grey Gull, and the drowned who walk the shore near it — the sea gives back what it takes, if you ask it hard enough. Hulda Stonewick is the elder of Morwen Village; she will tell you the rest, or she will not.",
      accept: 'Take me across the water, Ice-pilot.',
      progress: 'Sail from the Ice-bay to Tinnudir, ride to Celondim and take ship for Morwen Harbour. The wreck of the Grey Gull lies on the eastern shore of Tol Morwen.',
      complete: "Hakon has told you about the Grey Gull, has he? Then you know more than I meant you to know, and I see from your face that you have been on the shore where the drowned walk. Those rings belonged to elves of Ost Fuin who died on our rocks, and I have carried the weight of it since the night it happened. Sit down. There is more, and it is worse.",
      summary: 'Sail west to Tol Morwen, find the wreck of the Grey Gull and take the drowned sailors’ rings from the wights.',
      hint: 'Sail from the Forochel dock to Tinnudir, ride to Celondim and take ship to Morwen Harbour; the wreck is on the east shore of the isle.',
    }),
    quest(90, B8, {
      name: "The Wreckers' Beacon", zone: 'tolmorwen', giver: 'npc_morwenvillage_elder', turnin: 'npc_morwenvillage_ashild',
      objectives: [
        talk('npc_morwenvillage_sigwald', 'Hear Old Sigwald’s account of the night the Gull went down'),
        kill('morwen_wrecker_chief', 3, "Slay the Wrecker Chiefs at the Wreckers' Beacon"),
        explore(-1840, 830, 18, "Put out the Wreckers' Beacon"),
        collectNode('q_elven_missive', 3, 'gn_tolmorwen_3', 'Recover the Elven Missives hidden at the Stone of the Hapless'),
      ],
      rewards: { choose: setPick('angmarbane', 'head'), items: ['n_ring_hapless'] },
      intro: "The pale stranger came to this village a month ago and paid the Wreckers of the southern cliffs to light a false beacon, and the Grey Gull steered for it in the fog and broke on the rocks. She carried a letter from the Lord of Ost Fuin to the elves of Celondim, warning of a fleet gathering at Himling, and the stranger wanted that letter drowned. Old Sigwald saw it all from his boat and saved what he could; Widow Ashild hid the letters at the Stone of the Hapless, and the Wreckers have been hunting her for it since. Go to the cliffs, kill their chiefs, put out that cursed beacon, and bring the letters up from the Stone. Ashild keeps it; she will know you by the rings.",
      accept: 'The beacon will go dark tonight.',
      progress: "Sigwald is by the harbour; the Wreckers' Beacon is on the southern cliffs; the Stone of the Hapless stands on the western headland.",
      complete: "The letters — all three, and dry. Read them if you can bear to: Lord Anardil warns Celondim that the Pale Hand's ships are gathering at Himling to raise a dead lord of Angmar, and that the sea-serpent of the Sundered Shore has been roused to close the strait. The elves of Ost Fuin never learned whether their letter arrived. Take it to them, and take this ring; it was found beside the Stone, and it has been waiting a long time for a hand that deserves it.",
      summary: "Hear Sigwald, slay the Wrecker Chiefs, darken the Wreckers' Beacon and recover the elven missives from the Stone of the Hapless.",
      hint: "Sigwald stands by Morwen Harbour; the beacon is on the southern cliffs; the Stone of the Hapless is on the west headland.",
    }),
    quest(91, B8, {
      name: 'The Haven of Ost Fuin', zone: 'tolfuin', giver: 'npc_morwenvillage_ashild', turnin: 'npc_ostfuin_lord',
      objectives: [
        deliver('qb_hulda_letter', 'npc_ostfuin_eirien', "Bring Hulda's Confession to Eirien, Sea-warden of Ost Fuin"),
        kill('serpent_spawn', 6, "Slay Serpent-spawn at the Serpent's Cove"),
      ],
      rewards: { items: ['pot_heal_athelas', 'scroll_battle_50'] },
      intro: "Hulda has written it all down — the beacon, the Wreckers, the stranger's silver — and signed it, and she asks that you carry it to Ost Fuin on Tol Fuin, the elven haven in the north, so that the elves may judge us as they will. Ingolf at the harbour will find you passage; the boats go by way of Ras Himling or Celondim. Give the confession to Eirien the Sea-warden, who keeps the quay. And take care on the shore — the letters say the serpent has been roused, and its spawn come up out of the Serpent's Cove south of the haven to feed on whatever lands.",
      accept: 'I will carry the confession to the elves.',
      progress: "Take ship from Morwen Harbour to Ost Fuin; Eirien keeps the quay, and the Serpent's Cove is on the south shore of Tol Fuin.",
      complete: "Eirien has brought me the letter, and the Grey Gull's rings, and word of six serpent-spawn dead on the strand. I am Anardil, Lord of Ost Fuin, and I have mourned the Gull's crew for a month without knowing how they died. The village will be judged with mercy; it was the Pale Hand's silver that lit the beacon. As for the Pale Hand — he has raised Orc-raiders on the western shore of my island to hold it against us while his fleet works at Himling. We have work to do, you and I.",
      summary: "Carry Hulda's Confession to Eirien at Ost Fuin and slay the Serpent-spawn of the Serpent's Cove.",
      hint: "Ost Fuin is reached by boat from Morwen Harbour via Ras Himling or Celondim; the Serpent's Cove is on Tol Fuin's south shore.",
    }),
    quest(92, B8, {
      name: "Raiders' Landing", zone: 'tolfuin', giver: 'npc_ostfuin_eirien', turnin: 'npc_ostfuin_eirien',
      objectives: [
        kill('fuin_orc_raider', 6, "Slay Orc-raiders at Raiders' Landing"),
        explore(-1880, -1620, 20, "Scout Raiders' Landing"),
        use('gn_tolfuin_4', 1, "Search the raiders' plunder"),
      ],
      rewards: { items: ['pot_heal_athelas', 'pot_power_celebrant'] },
      intro: "The Orcs came in three black ships a fortnight ago and put ashore on the south-western strand, which my people now call Raiders' Landing. They have burned the fisher-huts and thrown up a camp, and every night more of them come down from it to try the walls of the haven. Go to the landing and kill them where they camp; then search the plunder they have piled on the strand. They took the chandler's whole store, and among it were the sea-charts of the haven — charts that show the way through the reefs to Himling.",
      accept: 'I will clear the landing and find the charts.',
      progress: "Raiders' Landing is on the south-western strand of Tol Fuin, west of the haven.",
      complete: "The charts were not in the plunder — so the raiders have already sent them on, or their captains keep them. Still, the landing is broken and the haven will sleep tonight. Their captains are in a camp above the strand, and I want a word with them before they die.",
      summary: "Break the Orc-raiders at Raiders' Landing and search their plunder for the sea-charts of the haven.",
      hint: "Raiders' Landing is on the south-western strand of Tol Fuin.",
    }),
    quest(93, B8, {
      name: 'The Raider Captains', zone: 'tolfuin', giver: 'npc_ostfuin_eirien', turnin: 'npc_ostfuin_eirien',
      objectives: [
        kill('fuin_orc_captain', 3, 'Slay the Raider Captains in their camp'),
        collectFrom('qb_raider_orders', 3, 'fuin_orc_captain', "Take the Raider-captains' Orders"),
      ],
      rewards: { choose: setPick('angmarbane', 'shoulder'), items: ['pot_heal_athelas'] },
      intro: "Three captains command the raiders from a camp on the cliff above the landing, and captains carry orders — the Pale Hand writes to everyone, it seems, and everyone keeps his letters. Kill them and take their orders. If the charts of the haven have gone to Himling, the orders will say so, and they will say what else has gone with them. Anardil has had the armoury send up a set of the warded plate the hillmen of Angmar sent us; the Sea-warden of Ost Fuin does not send a friend to Himling in leather.",
      accept: 'The captains will answer for the Grey Gull.',
      progress: "The raider captains camp on the cliff above Raiders' Landing, west of the haven.",
      complete: "Here — 'the charts are with the fleet; hold the island until the lord is crowned.' Crowned. Then the Pale Hand has reached Himling with every shard he holds and has begun the rite. Anardil must see this, and so must Ercassë, the lore-master, for she knows what the crowning of a Gaunt-lord means.",
      summary: "Slay the Raider Captains above the landing and take their orders.",
      hint: "The captains' camp is on the cliff above Raiders' Landing, south-west of Ost Fuin.",
    }),
    quest(94, B8, {
      name: 'The Stone of Beleriand', zone: 'tolfuin', giver: 'npc_ostfuin_ercasse', turnin: 'npc_ostfuin_ercasse',
      objectives: [
        explore(-1700, -1400, 15, 'Go to the Stone of Beleriand'),
        collectNode('q_elf_lantern', 4, 'gn_tolfuin_1', 'Recover the Lanterns of Ost Fuin from the western ruins'),
        fish(3, 'fs_tolfuin_cove', "Fish the shallows of the Serpent's Cove for the serpent's taint"),
      ],
      rewards: { items: ['scroll_angler_50', 'bait_shrimp', 'pot_heal_athelas'] },
      intro: "These islands were hills of Beleriand once, before the sea drowned it, and Himring was the fortress of Maedhros that stood ever-cold against the North; the Stone of Beleriand on the eastern hill remembers all of it, if one knows how to ask. Go and stand before it. Then go to the western ruins, where the old haven stood, and bring back the silver lanterns that burn without oil; we will need their light on Himling, for the Gaunt-lord's dark is not the dark of night. And cast a line in the Serpent's Cove — Lómëcar the serpent has been fed on sorcery, and the fish will show me how deep the taint has gone.",
      accept: 'I will go to the Stone, and then to the ruins and the cove.',
      progress: "The Stone of Beleriand stands on the eastern hill of Tol Fuin; the western ruins lie beyond the mallorn grove; the cove is on the south shore.",
      complete: "The lanterns are whole, the Stone has spoken to you — I can see it in your face — and the fish of the cove are black to the bone. Lómëcar has been made a gatekeeper as the White Matriarch was, and while she lives no boat of ours reaches Himling. Anardil is at the quay, and he has already guessed what I am going to tell him.",
      summary: "Visit the Stone of Beleriand, recover the Lanterns of Ost Fuin from the western ruins and fish the Serpent's Cove.",
      hint: 'The Stone is on the east hill of Tol Fuin; the western ruins are past the mallorn grove; the cove is on the south shore.',
    }),
    quest(95, B8, {
      name: 'Lómëcar of the Sundered Shore', zone: 'tolfuin', giver: 'npc_ostfuin_lord', turnin: 'npc_ostfuin_lord',
      objectives: [
        explore(-1760, -1650, 20, "Go down to the Serpent's Cove"),
        killboss('boss_lomecar', 'Slay Lómëcar, the Serpent of the Sundered Shore'),
      ],
      rewards: { items: ['n_ring_serpent', 'pot_heal_lostkingdom'] },
      intro: "Lómëcar has lived in the Serpent's Cove since before my grandmother's grandmother came to this isle, and we have kept a truce with her by keeping to our side of the strand. The Pale Hand has broken it: he fed her the same sickness he fed the bears of Forochel, and now she closes the strait to Himling and takes every boat that tries it. She must die, and I am sorry for it. Go down to the cove at low water, when she comes up onto the rocks to hunt, and end her. When it is done, Eärion the Mariner will take you across to Ras Himling, where Elendur holds the camp of the Free Peoples.",
      accept: 'I will meet the serpent at low water.',
      progress: "The Serpent's Cove is on the south shore of Tol Fuin; Lómëcar hunts from the rocks at the mouth of the cove.",
      complete: "The strait is open. The sea-wardens saw her fall from the cliffs and have already lit the beacon for Ras Himling. I have had the smiths set one of her scales in sea-silver for you — wear it, and remember that she was not our enemy until he made her one. Now go to Himling, and finish this.",
      summary: "Slay Lómëcar, the Serpent of the Sundered Shore, and open the strait to Himling.",
      hint: "The Serpent's Cove is on the south shore of Tol Fuin; Lómëcar waits in the sea off the rocks.",
    }),
    quest(96, B8, {
      name: 'Ras Himling', zone: 'himling', giver: 'npc_ostfuin_lord', turnin: 'npc_rashimling_captain',
      objectives: [
        talk('npc_rashimling_wounded', 'Hear what Osbeorn the wounded soldier saw at the fortress'),
        kill('himling_warg', 6, 'Slay Wargs of Himling about the landing'),
        explore(-1720, -560, 18, 'Reach the Old Watchtower'),
      ],
      rewards: { choose: setPick('angmarbane', 'hands'), items: ['pot_heal_lostkingdom', 'food_isles_feast'] },
      intro: "Elendur, Captain of the Free Peoples, holds a camp at Ras Himling on the eastern shore of the isle with what men, elves and dwarves could be spared from every haven in the west — and it is not many. Eärion will take you across. When you land, seek out Osbeorn, a soldier who came back from the fortress and should not have; hear what he saw before his wound takes him. The wargs of Himling harry the landing at night, and the old watchtower south of the camp is the only place from which the fortress can be seen. Take it, and look on Himring. Then report to Elendur.",
      accept: 'I will cross to Himling.',
      progress: 'Take ship from Ost Fuin to Ras Himling. Osbeorn lies in the camp; the wargs hunt about the landing; the Old Watchtower stands south of the camp.',
      complete: "Osbeorn is dead this hour, but he told you what I could not have: the Pale Hand stands at the Gaunt-altar with the shards he holds, and the rite is three parts done. The fortress of Himring is between us and him, and it is held by Uruks, cultists and worse. I have a dwarf-sapper, a seer, and now you. It will have to be enough. The Angmar-bane plate came across with you; wear it into the fortress.",
      summary: 'Cross to Ras Himling, hear Osbeorn, clear the wargs from the landing and take the Old Watchtower.',
      hint: 'Sail from Ost Fuin to Ras Himling; the Old Watchtower is south of the camp.',
    }),
    quest(97, B8, {
      name: 'The Uruk Lines', zone: 'himling', giver: 'npc_rashimling_ormar', turnin: 'npc_rashimling_ormar',
      objectives: [
        deliver('qb_sapper_charges', 'npc_rashimling_guard', "Carry Ormar's Blasting-charges to Hereward at the sentry-post"),
        kill('himling_uruk', 8, 'Slay Uruks of the Gaunt-lord in the siege-lines'),
        collectFrom('qb_siege_plan', 4, 'himling_uruk', 'Take the Siege-plans of the Gaunt-lord from the Uruks'),
      ],
      rewards: { items: ['pot_power_lostkingdom', 'pot_heal_lostkingdom'] },
      intro: "Ormar Stonefist, dwarf-sapper of the Iron Garrison, and I have a fortress to open. The Uruks of the Gaunt-lord have dug siege-lines between the camp and the gate of Himring, and I cannot get my charges to the wall while the lines are held. First, carry these three pots to Hereward at the sentry-post — carefully, for they are dwarf-fire and they do not care whose beard they burn. Then go into the lines and kill Uruks until the rest run. They carry plans of our camp drawn by a dead hand; bring me those, and I will know where the Gaunt-lord means to strike.",
      accept: 'I will carry the charges and break the lines.',
      progress: 'Hereward keeps the sentry-post at the edge of the camp; the Uruk siege-lines lie west of the camp, before the gate of Himring.',
      complete: "Hereward has the charges, the lines are broken, and these plans — look, they mark the camp's every tent, and the hand that drew them was Draugmar's own; he sees through the eyes of his cultists. Meldis the seer says she can blind him for a while. Go to her.",
      summary: "Carry Ormar's charges to Hereward, break the Uruk siege-lines and take the Gaunt-lord's siege-plans.",
      hint: 'Hereward stands at the sentry-post in the camp; the Uruk lines are west of Ras Himling, before the fortress.',
    }),
    quest(98, B8, {
      name: 'The Gaunt-altar', zone: 'himling', giver: 'npc_rashimling_meldis', turnin: 'npc_rashimling_meldis',
      objectives: [
        kill('himling_sorcerer', 6, 'Slay Gaunt-cultists at the Gaunt-altar'),
        explore(-1850, -450, 18, 'Reach the Gaunt-altar'),
        collectFrom('qb_gaunt_phylactery', 3, 'himling_sorcerer', "Take the Gaunt-cultists' Phylacteries"),
      ],
      rewards: { items: ['n_neck_himring', 'pot_heal_lostkingdom'] },
      intro: "I have seen the altar in the fire every night since we landed: a slab of black stone on the western hill, the Pale Hand before it with the shards laid out in the shape of a crown, and cultists in a ring about him feeding the rite with their own blood. Each of them wears a phylactery on a chain — a little iron box with a piece of Draugmar's grave-cloth inside — and through those boxes the Gaunt-lord sees. Go to the altar, kill the cultists, and bring me three of the boxes. Blind him, and I can hide the camp from him until the gate is open.",
      accept: 'I will blind the Gaunt-lord.',
      progress: 'The Gaunt-altar stands on the western hill of Himling, beyond the Uruk lines.',
      complete: "You found him, then. The Pale Hand — dead before his own altar, his face like a mask of salt, his shards taken up into the rite and his life with them. Draugmar has no more use for a servant once the servant has served; that is the way of the Gaunt-lords. But the rite is not finished, for he does not have the shards we hold, and he is bound half-in and half-out of the world beneath the fortress. That is where you will meet him — but the gate of Himring is still shut, and the seals that open it are lost in the barrows.",
      summary: 'Slay the Gaunt-cultists at the Gaunt-altar and take their phylacteries to blind the Gaunt-lord.',
      hint: 'The Gaunt-altar is on the western hill of Himling, past the Uruk lines.',
    }),
    quest(99, B8, {
      name: 'The Barrows of Himling', zone: 'himling', giver: 'npc_rashimling_captain', turnin: 'npc_rashimling_captain',
      objectives: [
        kill('himling_wight', 6, 'Lay the Gaunt-wights of the barrows to rest'),
        collectNode('q_himring_seal', 3, 'gn_himling_1', 'Recover the Seals of Himring from the fortress approach'),
        kill('himling_gaunt_champion', 3, 'Slay the Gaunt-champions at the Gate of Himring'),
      ],
      rewards: { choose: setPick('angmarbane', 'feet'), items: ['n_cloak_himring', 'pot_heal_lostkingdom'] },
      intro: "Ormar's charges will crack the wall, but the gate of Himring was made by elves of the First Age and it will not crack; it opens only to the seals of the lords of Himring, and those seals lie scattered on the approach where the last defenders fell. The barrows beside the approach are full of gaunt-wights, and the gate itself is held by Draugmar's champions — dead knights of Angmar in the armour they died in. Clear the barrows, gather the seals, and break the champions at the gate. Then come back to me, and we will go in together at dawn.",
      accept: 'I will bring you the seals of Himring.',
      progress: 'The Barrows of Himling lie east of the fortress; the seals are on the approach below the gate, where the champions stand.',
      complete: "Three seals of Himring, and the gate will know them. The champions are broken and the barrows are quiet; Meldis says the Gaunt-lord is blind and raging beneath the fortress, and Ormar has his charges laid. This cloak was taken from the vaults of Himring long ago and kept by my house against the day a lord of Himring should come again. Wear it tomorrow. Get what sleep you can.",
      summary: 'Lay the Gaunt-wights of the barrows to rest, recover the Seals of Himring and slay the champions at the gate.',
      hint: 'The barrows are east of the fortress of Himring; the seals and the champions are on the approach below its gate.',
    }),
    quest(100, B8, {
      name: 'The Gaunt-lord', zone: 'himling', giver: 'npc_rashimling_captain', turnin: 'npc_rashimling_captain',
      objectives: [
        kill('himling_troll', 4, 'Slay the Himling Trolls that hold the breach'),
        killboss('boss_draugmar', 'Destroy Draugmar the Gaunt-lord beneath Himring'),
      ],
      rewards: { title: 'Lord of the Lost Kingdom', mount: (G.Data.lostKingdom && G.Data.lostKingdom.mount) || 'mount_lostkingdom', items: ['pot_heal_lostkingdom', 'pot_power_lostkingdom'] },
      intro: "The seals are set, Ormar's charges have cracked the wall, and the trolls of Himling have come up out of the deeps to hold the breach — the Gaunt-lord's last living servants, if trolls count as living. Beyond them, in the vault beneath the fortress, Draugmar waits with the Pale Hand's shards on his brow and a crown that will never be whole, for the rest of it is with us. Break the trolls, go down, and destroy him. The elves of Ost Fuin, the dwarves of the Iron Garrison, the hillmen of Aughaire and the Lossoth of the ice are all here today in what they sent with you; the Rangers and the Free Peoples stand at the breach. Whatever you are when you come up out of that vault, you will not be the same as you went down.",
      accept: 'For Arnor, and for all of them.',
      progress: 'The breach is in the western wall of Himring; the vault of the Gaunt-lord lies beneath the fortress.',
      complete: "It is over. Draugmar the Gaunt-lord is unmade, the Pale Hand's shards lie cold on the floor of the vault, and Meldis says the last shadow of Angmar has gone out of the world like a candle. Elrond's messengers have already ridden, and by summer there will not be a hall from the Shire to Sûri-kylä that does not know your name. The shards are gathered at last — seven, whole, in a setting of king's silver — and there is no one left in the North with a better claim to what they mean. Kneel, then. Rise, Lord of the Lost Kingdom: the armour of Arnor is yours, and the white steed of its kings, and the gratitude of every free people of Eriador. The Shire is quiet tonight, and Bree, and the lake of Evendim; and somewhere over the water a hobbit is writing all of this down, and getting your name wrong.",
      summary: 'Break the trolls at the breach and destroy Draugmar the Gaunt-lord beneath the fortress of Himring.',
      hint: 'The breach is in the western wall of Himring; Draugmar waits in the vault beneath the fortress.',
    }),
  ];

  G.Data.quests.push(...Q);
  G.Data.questById = G.Data.questById || {};
  for (let i = 0; i < Q.length; i++) G.Data.questById[Q[i].id] = Q[i];
  if (G.Data.registerQuests) G.Data.registerQuests(Q);
})();
