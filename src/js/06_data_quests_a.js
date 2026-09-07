/* ==== 06_data_quests_a.js — Story quests s001–s050 (Books 1–4) for Chris Jensen's Lord of the Rings Online.
   Pure data. Book 1 "The Shadow in the Shire" (s001–s012, L1–10), Book 2 "Roads to Bree and the Blue Mountains"
   (s013–s025, L8–20), Book 3 "The Old Forest and the Barrow-downs" (s026–s037, L15–28), Book 4 "The Lone-lands and
   the North Downs" (s038–s050, L26–40). Schema per SPEC §4.7; every quest additionally carries `summary` (one line
   for the tracker/journal) and `hint` (where to go). Levels come from G.Data.xp.storyLevel(i), rewards from
   G.Data.xp.questXP/goldReward. Quest-specific items (letters, tokens, relics) are registered with G.Data.addItem
   under the `qa_` prefix before the quests. Appends to G.Data.quests and fills G.Data.questById for its own ids
   (24_quests may rebuild the map; 23_npcs/30_ui_hud/34_save read it). ==== */
(function () {
  'use strict';
  const G = window.G;
  G.Data = G.Data || {};
  G.Data.quests = G.Data.quests || [];
  const X = G.Data.xp;
  const addItem = G.Data.addItem;

  // ------------------------------------------------------------------ quest items (qa_*)
  const QBG = 0x5a5a2a;
  const QA = [
    ['qa_pale_coin', 'Pale-stamped Coin', '🪙', 'A silver coin of no mint known in the Shire. A white hand is stamped where a king\'s face should be.'],
    ['qa_silver_spoons', 'The Silver Spoons of Bag End', '🥄', 'A dozen silver spoons in a velvet roll, each engraved with a B. Lobelia Sackville-Baggins wants them back, very badly.'],
    ['qa_pale_hand_orders', 'Orders of the Pale Hand', '📃', 'A letter in a cramped, hurried hand: "Find the casket. The hobbits will not know what they keep. Bring it to the Greenway." It is signed only with a pale hand-print.'],
    ['qa_cardolan_relic', 'Iron-bound Casket of Cardolan', '⚱', 'A small, heavy casket bound in green bronze, cold to the touch even by the fire. Something inside it seems to be listening.'],
    ['qa_letter_whitfoot', 'Letter from Mayor Whitfoot', '✉', 'A letter sealed with the seal of Michel Delving, addressed to Mr. Butterbur of the Prancing Pony, Bree.'],
    ['qa_pale_hand_letter', 'Letter Sealed with a Pale Hand', '✉', 'Orders to the Blackwolds: "The dwarves of Thorin\'s Hall keep the old lore of Cardolan. Silence any who go to ask them."'],
    ['qa_letter_strider', 'Strider\'s Letter to Dwalin', '✉', 'A letter in a Ranger\'s neat script, sealed with a six-rayed star, for Dwalin, Lord of Thorin\'s Hall.'],
    ['qa_letter_dwalin', 'Dwalin\'s Letter to Elorion', '✉', 'A short letter in dwarf-runes, grudgingly polite, for Elorion, Master of the Haven of Celondim.'],
    ['qa_letter_elorion', 'Elorion\'s Missive to Strider', '📜', 'A flowing elven missive. It names the thing in the casket, and it names the hand that reaches for it.'],
    ['qa_enforcer_badge', 'Blackwold Enforcer\'s Badge', '🔘', 'An iron badge stamped with a wolf\'s head, worn by the toughest of the Blackwold brigands.'],
    ['qa_poacher_snare', 'Poacher\'s Snare', '🪤', 'A cruel wire snare of the kind the Blackwold poachers set across the deer-paths of the Chetwood.'],
    ['qa_wight_seal', 'Wight\'s Grave-seal', '🏺', 'A disc of green bronze stamped with a crowned skull. The wights of Cardolan are bound to it, and by it.'],
    ['qa_wightlord_seal', 'Seal of the Wight-lord', '💠', 'The great seal of Sambrog, broken in two by Tom Bombadil. Its halves must be carried far apart, and quickly.'],
    ['qa_letter_osric', 'Osric\'s Letter to Candaith', '✉', 'A hastily written letter for Candaith, Ranger of Weathertop, describing the orcs seen upon the Weather Hills.'],
    ['qa_letter_hunwald', 'Hunwald\'s Warning', '✉', 'A warning from the Elder of the Eglain to Trestlebridge: orcs of Angmar march north under a pale banner.'],
    ['qa_orc_warplans', 'Orc War-plans', '📃', 'Crude maps of the Trestlespan and the roads to Esteldín, marked with the pale hand-print.'],
  ];
  if (typeof addItem === 'function') {
    for (let i = 0; i < QA.length; i++) {
      const q = QA[i];
      addItem({ id: q[0], name: q[1], type: 'quest', slot: null, subtype: 'quest', level: 1, rarity: 'common', stats: {}, dmg: null,
        value: 0, maxStack: 20, icon: q[2], iconBg: QBG, desc: q[3], flavor: '', use: null });
    }
  }

  // ------------------------------------------------------------------ helpers (pure)
  const BOOK = {
    1: 'Book 1: The Shadow in the Shire',
    2: 'Book 2: Roads to Bree and the Blue Mountains',
    3: 'Book 3: The Old Forest and the Barrow-downs',
    4: 'Book 4: The Lone-lands and the North Downs',
  };
  function qid(n) { return 's' + (n < 10 ? '00' : n < 100 ? '0' : '') + n; }
  function bookOf(n) { return n <= 12 ? BOOK[1] : n <= 25 ? BOOK[2] : n <= 37 ? BOOK[3] : BOOK[4]; }
  function gear(tier, slot) { return ['s_' + tier + '_light_' + slot, 's_' + tier + '_medium_' + slot, 's_' + tier + '_heavy_' + slot]; }
  function kill(target, count, label) { return { type: 'kill', target: target, count: count, label: label }; }
  function collectFrom(item, count, from, label) { return { type: 'collect', item: item, count: count, from: from, label: label }; }
  function collectNode(item, count, node, label) { return { type: 'collect', item: item, count: count, from: null, node: node, label: label }; }
  function talk(npc, label) { return { type: 'talk', npc: npc, label: label }; }
  function explore(x, z, radius, label) { return { type: 'explore', pos: { x: x, z: z }, radius: radius, label: label }; }
  function use(node, count, label) { return { type: 'use', node: node, count: count, label: label }; }
  function fish(count, spot, label) { return { type: 'fish', count: count, spot: spot, label: label }; }
  function deliver(item, npc, label) { return { type: 'deliver', item: item, npc: npc, label: label }; }
  function killboss(boss, label) { return { type: 'killboss', boss: boss, label: label }; }
  /** Build one story quest: id/type/book/level/prereq/next and the xp/gold rewards are derived from the index. */
  function S(n, o) {
    const level = Math.round(X.storyLevel(n));
    const rw = o.rewards || {};
    const rewards = { xp: X.questXP(level, 'story'), gold: X.goldReward(level, 'story'), items: rw.items || [] };
    if (rw.choose) rewards.choose = rw.choose;
    if (rw.title) rewards.title = rw.title;
    if (rw.mount) rewards.mount = rw.mount;
    return {
      id: qid(n), name: o.name, type: 'story', book: bookOf(n), level: level, zone: o.zone,
      giver: o.giver, turnin: o.turnin, prereq: n === 1 ? [] : [qid(n - 1)], next: qid(n + 1),
      objectives: o.objectives, rewards: rewards,
      text: { intro: o.intro, accept: o.accept, progress: o.progress, complete: o.complete },
      summary: o.summary, hint: o.hint,
    };
  }

  const Q = [
    // ================================================================ BOOK 1 — The Shadow in the Shire (L1–10)
    S(1, {
      name: 'A Garden Gone to Ruin', zone: 'shire', giver: 'npc_hobbiton_holman', turnin: 'npc_hobbiton_gaffer',
      objectives: [
        kill('garden_slug', 6, 'Clear the garden slugs from the gardens below the Hill'),
        explore(-1000, -220, 15, 'Explore the Party Tree'),
        talk('npc_hobbiton_gaffer', 'Tell the Gaffer that the gardens are clear'),
      ],
      rewards: { items: ['food_seedcake', 'pot_heal_salve'] },
      intro: "Look at it! Look at my cabbages! Slugs, great fat grey ones, all over the gardens below the Hill, and in a week they've eaten what took me a season to grow. It isn't natural, I tell you: something has soured the ground this spring, and the Gaffer says he's never seen the like in sixty years. You look like a body who isn't afraid of a bit of slime. Go down past the Party Tree and stamp out as many of the beasts as you can find, then tell old Hamfast Gamgee up on Bagshot Row that Holman Greenhand sent you.",
      accept: "Good lad. Mind the marrows.",
      progress: "The slugs are in the gardens south of the Party Tree, below the Hill. Squash them and then have a word with the Gaffer on Bagshot Row.",
      complete: "Holman sent you, did he? Well, slugs is slugs, but I've never seen them come up like this, not in a wet year nor a dry one. Something's stirring under the Shire, mark my words, and it isn't only in the gardens. There's been wolves howling in Bindbole Wood and boars in Twofoot's barley too. You'd best make yourself useful, since you're able.",
      summary: "Clear Holman's gardens of slugs and report to the Gaffer on Bagshot Row.",
      hint: "The gardens lie just south of the Party Tree, below the Hill in Hobbiton.",
    }),
    S(2, {
      name: 'Boars in the Barley', zone: 'shire', giver: 'npc_hobbiton_gaffer', turnin: 'npc_hobbiton_hamson',
      objectives: [
        kill('wild_boar', 6, 'Drive the wild boars out of the barley'),
        collectFrom('mat_boar_hide', 4, 'wild_boar', 'Collect boar hides for Hamson Twofoot'),
      ],
      rewards: { items: ['food_seedcake', 'n_gloves_hobbiton'] },
      intro: "Now then, since you're handy with a stick. Hamson Twofoot's barley over on the west side has been trampled flat by wild boars this week, and boars that bold aren't right neither. He's an old fellow and can't be chasing pigs about at his age, so I told him I'd send someone. Go west of the Hill to his fields, deal with the beasts, and save the hides while you're at it; Hamson can sell them to Milo Burrowes and get something back for his ruined crop. He'll be out in the fields, fretting.",
      accept: "I'll see to the boars, Gaffer.",
      progress: "The boars are rooting in the fields west of Hobbiton. Bring the hides to Hamson Twofoot.",
      complete: "Six of them, you say, and the hides too? Bless you. That's a season's ale-money back at least, and I'll sleep without hearing them grunting under my window. The Gaffer's right, though: boars don't come this close to the holes unless something's driving them out of the woods. There've been wolves, they say, up in Bindbole.",
      summary: "Drive the boars out of Hamson Twofoot's barley and bring him their hides.",
      hint: "Hamson's fields lie west of Hobbiton, along the road towards Michel Delving.",
    }),
    S(3, {
      name: 'Wolves of Bindbole Wood', zone: 'shire', giver: 'npc_hobbiton_fastred', turnin: 'npc_hobbiton_perry',
      objectives: [
        explore(-1000, -380, 25, 'Explore the eaves of Bindbole Wood'),
        kill('shire_wolf', 6, 'Slay the wolves of Bindbole Wood'),
      ],
      rewards: { choose: gear('wanderer', 'chest'), items: ['pot_heal_salve'] },
      intro: "Fastred Bolger, Bounder, at your service. I've been walking the bounds up past Overhill and there are wolves in Bindbole Wood, lean grey ones, and more of them every night. Wolves haven't come south of the Northfarthing hills since the Fell Winter, and I don't like it one bit. The Bounders are stretched thin this year, so I'd take it kindly if you went up to the wood, had a look about, and put a few of the beasts down. Report to old Peregrin Took at the Bounders' post in Hobbiton when it's done; he'll want to hear it himself.",
      accept: "Wolves in the Shire. I'll go and see.",
      progress: "Bindbole Wood lies north of Hobbiton, beyond Overhill. Thin out the wolves and report to Peregrin Took the Elder.",
      complete: "Wolves in Bindbole, in spring. Fastred wasn't exaggerating, then. I've been Master of the Bounders forty years and I've seen strange things come over the borders, but never so many all at once: wolves, boars, and now Big Folk on the roads asking questions. Take this; a Bounder who can't dress warmly is no use to anyone. I have a feeling I'll be calling on you again.",
      summary: "Scout Bindbole Wood and slay the wolves gathering there, then report to the Master of the Bounders.",
      hint: "Bindbole Wood is north of Hobbiton; follow the lane past Overhill.",
    }),
    S(4, {
      name: 'Spiders by the Water', zone: 'shire', giver: 'npc_hobbiton_hob', turnin: 'npc_bywater_tolman',
      objectives: [
        kill('field_spider', 6, 'Kill the field spiders along the Water'),
        collectFrom('mat_spider_silk', 4, 'field_spider', 'Gather spider silk for new fishing-lines'),
        fish(3, 'fs_hobbiton_water', 'Catch three fish from the Water at Hobbiton'),
      ],
      rewards: { items: ['bait_worms', 'food_mushroom_pie', 'n_wrist_shire'] },
      intro: "Spiders, that's what. Big ones, down in the reeds along the Water, where I've fished every morning since I was a lad. My lines are all torn to bits with their webbing and I daren't put a foot in the reeds. If you clear them out I'd be grateful, and bring me some of that silk of theirs; it's stronger than any hemp and Wilcome Brockhouse in Bywater will twist it into lines for me. And while you're down there, have a cast yourself; there's nothing wrong with the fish, just the company. Then take word to Farmer Cotton in Bywater, he's been asking after everything queer that's happening.",
      accept: "Spiders and fishing. I've had worse mornings.",
      progress: "The spiders nest along the Water east of Hobbiton. Kill them, gather their silk, catch three fish and then see Farmer Cotton in Bywater.",
      complete: "Hob's spiders are dealt with? Good. I'll take that silk to Wilcome for him. Sit a moment, though, for I've a thing to tell you that's more worrying than spiders. There's been Big Folk crossing the Brandywine Bridge at night, a dozen or more, and they aren't coming to buy pipe-weed.",
      summary: "Clear the spiders from the Water, gather their silk, catch three fish and report to Farmer Cotton.",
      hint: "The spiders are in the reeds east of Hobbiton along the Water; Bywater lies further east along the road.",
    }),
    S(5, {
      name: 'Strangers on the East Road', zone: 'shire', giver: 'npc_bywater_tolman', turnin: 'npc_bywater_nick',
      objectives: [
        explore(-628, -50, 20, 'Explore the west end of the Brandywine Bridge'),
        kill('shire_bat', 5, 'Drive off the bats roosting along the East Road'),
        talk('npc_bywater_nick', 'Tell Shirriff Nick Cotton what you saw'),
      ],
      rewards: { items: ['n_pocket_pipe', 'pot_heal_salve'] },
      intro: "Rowan saw them first, coming back late from Frogmorton: a line of Men in dark cloaks on the East Road, and one at their head in pale gloves who never spoke. They crossed the Brandywine Bridge before dawn and went off south towards Waymeet, bold as you like. I want someone to go down to the Bridge and look at the ground, see how many there were and which way they went. Mind the bats in the old willows along the road; they've grown fierce this year and they come at travellers' faces. Then find my son Nick, he's Shirriff here, and tell him everything.",
      accept: "I'll go and look at the Bridge.",
      progress: "Follow the East Road to the Brandywine Bridge and look about, deal with the bats on the way, then report to Shirriff Nick Cotton in Bywater.",
      complete: "Big Folk, boot-prints in the mud, heading south-west, and one with a stride longer than the rest. That fits with what Dad said. I'll tell you plainly: the Shirriffs have found three farms robbed on the Bywater road this month, and every time there's talk of a man in pale gloves paying ruffians in silver. Somebody is buying trouble in the Shire, and I mean to know who.",
      summary: "Scout the Brandywine Bridge for the strangers seen on the East Road and report to Shirriff Nick Cotton.",
      hint: "Follow the East Road east from Bywater until it meets the Brandywine.",
    }),
    S(6, {
      name: 'Coin of a Pale Hand', zone: 'shire', giver: 'npc_bywater_nick', turnin: 'npc_hobbiton_robin',
      objectives: [
        kill('bandit_ruffian', 6, 'Deal with the ruffians waylaying travellers on the East Road'),
        collectFrom('qa_pale_coin', 4, 'bandit_ruffian', 'Take the strange coins the ruffians carry'),
      ],
      rewards: { choose: gear('wanderer', 'legs'), items: ['pot_heal_salve'] },
      intro: "The ruffians have stopped hiding. They've set up on the East Road past Frogmorton, and yesterday they turned out the pockets of a tinker and beat him for the trouble. Shirriffs aren't fighters, whatever they say in the Ivy Bush, but you are. Go out along the road and teach them that the Shire isn't a soft place, and bring back whatever silver you find on them. I want to see with my own eyes what coin this pale-gloved fellow pays in. Robin Smallburrow in Hobbiton is Chief Shirriff for the Westfarthing; take the coins to him.",
      accept: "I'll clear the road.",
      progress: "The ruffians hold the East Road between Bywater and the Brandywine. Bring the coins they carry to Robin Smallburrow in Hobbiton.",
      complete: "Well, that's no coin of Bree, nor of Dale, nor anywhere I ever heard of. No king's head on it; only a pale hand, stamped like a brand. I'll be honest with you, this is beyond a Shirriff's ken. But there's more to it: Lobelia Sackville-Baggins has been shrieking all morning that Bag End was broken into last night. Go and see her, if your ears can stand it.",
      summary: "Break up the ruffians on the East Road and bring their strange coins to Shirriff Robin Smallburrow.",
      hint: "The ruffians lurk on the East Road east of Bywater. Robin Smallburrow keeps the Shirriff-post in Hobbiton.",
    }),
    S(7, {
      name: 'The Silver Spoons of Bag End', zone: 'shire', giver: 'npc_hobbiton_lobelia', turnin: 'npc_hobbiton_lobelia',
      objectives: [
        explore(-1058, -206, 15, 'Search the grounds of Bag End for signs of the thieves'),
        kill('bandit_ruffian', 6, 'Punish the ruffians camped at Waymeet'),
        collectFrom('qa_silver_spoons', 1, 'bandit_ruffian', 'Recover the silver spoons of Bag End'),
      ],
      rewards: { items: ['drink_pony_ale', 'n_bounders_cloak'] },
      intro: "Robbed! Bag End, robbed, and the Shirriffs standing about like posts. They came in the night, Big Folk with muddy boots, and turned the whole smial upside down, and do you know what they took? The spoons! The Baggins silver, a dozen of them, that should have come to me by rights years ago. What did they want with Bilbo's old rubbish anyway, rummaging through his mathoms and his maps? Never mind that. Go up and look at the Hill, find their tracks, and then go to Waymeet where those ruffians camp and get my spoons back.",
      accept: "I'll fetch your spoons, Mistress Sackville-Baggins.",
      progress: "Look about Bag End for the thieves' tracks, then go south-west to the ruffian camp at Waymeet and take back the silver spoons.",
      complete: "All twelve. Well. I suppose you'll want thanking. It's very odd, though, now that I've calmed down: they went through every drawer of Bilbo's old things and took only the spoons and one ugly iron box he brought back from his travels, the one he was always going to give to the Mathom-house. Spoons I understand. But who would want that?",
      summary: "Search Bag End for the thieves' tracks and recover Lobelia's silver spoons from the ruffians at Waymeet.",
      hint: "Bag End is at the top of the Hill above Hobbiton; the ruffian camp is at Waymeet, south-west along the Michel Delving road.",
    }),
    S(8, {
      name: 'Orders from the Pale Hand', zone: 'shire', giver: 'npc_hobbiton_robin', turnin: 'npc_micheldelving_mayor',
      objectives: [
        kill('brigand_ringleader', 3, 'Defeat the ruffian ringleaders at Waymeet'),
        collectFrom('qa_pale_hand_orders', 1, 'brigand_ringleader', 'Seize the ringleaders\' written orders'),
        talk('npc_micheldelving_mayor', 'Bring the orders to Mayor Whitfoot in Michel Delving'),
      ],
      rewards: { items: ['n_cap_bounder', 'pot_heal_salve'] },
      intro: "Spoons and an iron box. Coins with a pale hand on them. Big Folk at the Bridge. I've been a Shirriff for twenty years and I've never had a case with more bits that didn't fit. But here's one that does: the ruffians at Waymeet answer to three ringleaders, big brutes in leather, and ruffians that size don't stir for silver spoons. Somebody is giving them orders, and men like that write things down because they can't remember them. Go back to Waymeet, put the ringleaders down, and take whatever papers they carry to the Mayor at Michel Delving. Will Whitfoot has the Town Hole and the sense to use it.",
      accept: "I'll bring the Mayor their orders.",
      progress: "The ringleaders hold the ruffian camp at Waymeet. Take their orders to Mayor Will Whitfoot in Michel Delving.",
      complete: "\"Find the casket. The hobbits will not know what they keep.\" And signed with a hand-print, like a child would do it. Well, I am Mayor of the Shire and I'll not have foreign brigands going through our smials for caskets, whatever they are. It's the box Bilbo gave to the Mathom-house, of course; Fosco Boffin has been fretting about it for a week. Go and see him. Tell him the Mayor says it's time he showed someone what's in it.",
      summary: "Defeat the ringleaders at Waymeet, seize their written orders and carry them to the Mayor of Michel Delving.",
      hint: "Waymeet lies south-west of Hobbiton; Michel Delving is further west along the main road.",
    }),
    S(9, {
      name: 'The Mathom-house Robbery', zone: 'shire', giver: 'npc_micheldelving_mathom', turnin: 'npc_micheldelving_mathom',
      objectives: [
        explore(-1180, 120, 20, 'Search the ruffian camp at Waymeet for the casket'),
        kill('brigand_ringleader', 3, 'Clear the last ringleaders from Waymeet'),
        use('gn_shire_4', 1, 'Search Old Tobold\'s cache in the Greenfields'),
      ],
      rewards: { choose: gear('wanderer', 'head'), items: ['pot_power_tonic'] },
      intro: "It's gone, the casket, the very night after Bag End was robbed. I keep the Mathom-house locked, I do, but they came through the roof like weasels. Mr. Bilbo brought it back from beyond the Old Forest sixty years ago and said only that it should never be opened, and I never did, and now the whole Westfarthing is turned upside down for it. The Bounders tracked the thieves to Waymeet, but the ringleaders there had already sent it on to a hiding-place, and the Mayor wrung out of one of them that it's in an old cache in the Greenfields that smugglers used in Old Tobold's day. Go and see, I beg you, and if the ringleaders at Waymeet are still about, so much the worse for them.",
      accept: "I'll find your casket, Master Boffin.",
      progress: "Search Waymeet and finish the ringleaders, then find Old Tobold's cache in the Greenfields north of Michel Delving.",
      complete: "That's it. That's the casket, the very one, cold as a winter morning even now. I thank you with all my heart, but I'll confess I don't want it back in the Mathom-house. Not after this. Look at the runes on the band: I can't read them, but Isengar Took can, he went adventuring with Mr. Bilbo's friends in his day. He lives here in Michel Delving. Take it to him before I lose my nerve.",
      summary: "Track the stolen casket from the ruffian camp at Waymeet to Old Tobold's cache in the Greenfields.",
      hint: "Waymeet is south-east of Michel Delving; the Greenfields lie to the north, past the quarries.",
    }),
    S(10, {
      name: 'A Relic of Cardolan', zone: 'shire', giver: 'npc_micheldelving_mathom', turnin: 'npc_micheldelving_trainer',
      objectives: [
        deliver('qa_cardolan_relic', 'npc_micheldelving_trainer', 'Take the iron-bound casket to Isengar Took'),
        kill('shire_bat', 6, 'Drive the bats out of the Delving quarries'),
      ],
      rewards: { items: ['scroll_warding_10', 'pot_heal_salve'] },
      intro: "Here, take it; wrap it in your cloak, I can't bear to look at it. Isengar Took is the one you want. He walked to Bree and beyond in his youth, and he's the only hobbit I know who can read the old runes of the Big Folk. He'll be near the Bird and Baby, most likely; he doesn't stray far from it these days. One thing more: the bats in the Delving quarries have gone mad since the casket was hidden near them, swarming out by day and biting the quarrymen. If you'd thin them on your way, the whole town would thank you.",
      accept: "To Isengar Took, then.",
      progress: "Bring the casket to Isengar Took by the Bird and Baby in Michel Delving, and clear the bats from the quarries north of the town.",
      complete: "Well, well. Cardolan work, this: see the crowned skull on the band? That's the mark of the wights that sleep under the Barrow-downs, south of Bree. This is a grave-seal, and whatever is bound to it is not something I'd want loose in the Shire. Bilbo did right to lock it away. There's a Ranger who lodges at the Prancing Pony in Bree, tall fellow, calls himself Strider; if anyone knows what to do with it, it's him. The Mayor should write you a letter of introduction, for Butterbur is suspicious of strangers.",
      summary: "Deliver the iron-bound casket to Isengar Took, the retired adventurer, and clear the bats from the Delving quarries.",
      hint: "Isengar Took stands near the Bird and Baby inn in Michel Delving; the quarries are north of the town.",
    }),
    S(11, {
      name: 'The Bounders\' Muster', zone: 'shire', giver: 'npc_micheldelving_mayor', turnin: 'npc_hobbiton_perry',
      objectives: [
        talk('npc_micheldelving_shirriff', 'Muster Hob Hayward, Shirriff of the Westfarthing'),
        talk('npc_hobbiton_fastred', 'Muster Fastred Bolger of the Bounders'),
        talk('npc_bywater_nick', 'Muster Shirriff Nick Cotton in Bywater'),
        kill('bandit_ruffian', 8, 'Sweep the ruffians from the roads of the Westfarthing'),
      ],
      rewards: { items: ['n_throwing_bounder', 'food_mushroom_pie', 'pot_heal_salve'] },
      intro: "Isengar has told me what the casket is, and I have not slept since. A grave-seal of the wights, in Bilbo's cupboard for sixty years! Well, it's going to Bree, and so are you, but first I want the Shire buttoned up behind you. I'm calling a muster of the Shirriffs and Bounders, the first since the Fell Winter, and I want you to carry the word: Hob Hayward here in Michel Delving, Fastred Bolger in Hobbiton, and Nick Cotton at Bywater. While you go, sweep any ruffians you meet off the roads. Then report to Peregrin Took at the Bounders' post; he'll command the muster.",
      accept: "I'll carry the Mayor's word.",
      progress: "Speak to Hob Hayward, Fastred Bolger and Nick Cotton, clear the ruffians from the roads, and report to Peregrin Took the Elder in Hobbiton.",
      complete: "All three answered? Good. That's thirty Bounders on the bounds by tomorrow and every Shirriff with his feather on straight. I've not seen the like since I was a lad. You've done more for the Shire in a fortnight than most do in a lifetime, and I'd make you a Bounder on the spot if you were the right size. Now the Mayor's letter is ready, and the road to Bree is waiting.",
      summary: "Carry the Mayor's call to muster to the Shirriffs and Bounders, clearing the ruffians from the roads as you go.",
      hint: "Hob Hayward is in Michel Delving, Fastred Bolger in Hobbiton and Nick Cotton in Bywater; the Bounders' post is in Hobbiton.",
    }),
    S(12, {
      name: 'The Road to Bree', zone: 'shire', giver: 'npc_hobbiton_perry', turnin: 'npc_bree_barliman',
      objectives: [
        kill('brigand_ringleader', 4, 'Break the last of the Pale Hand\'s ringleaders in the Shire'),
        deliver('qa_letter_whitfoot', 'npc_bree_barliman', 'Deliver the Mayor\'s letter to Barliman Butterbur at the Prancing Pony'),
        explore(-360, -20, 20, 'Pass through the West-gate of Bree'),
      ],
      rewards: { choose: gear('wanderer', 'shoulder'), items: ['food_bree_bread', 'pot_heal_salve'], title: 'Defender of the Shire' },
      intro: "Here is the Mayor's letter for Butterbur, with the seal of Michel Delving on it, and here is the last thing I'll ask of you in the Shire. The ringleaders who fled Waymeet are trying to gather the ruffians again south of the road; if you break them now, the Bounders can hold the borders alone. Then go east: over the Brandywine Bridge, along the East Road, forty miles to Bree. You'll know the town by the wall and the West-gate, and the Prancing Pony is the inn just inside it. Give the letter to Barliman Butterbur, and mind: he's a good man but he forgets things.",
      accept: "East to Bree, then. Keep the Shire safe, Master Took.",
      progress: "Finish the ringleaders at Waymeet, then follow the East Road across the Brandywine to Bree and hand the letter to Butterbur at the Prancing Pony.",
      complete: "A letter from the Mayor of the Shire, for me? Well, bless my soul. Nob! Nob, fetch a mug for our guest. Let's see: hobbits robbed, ruffians, a casket, and a man in pale gloves. I know that fellow; he took the best room a month back and never once took his gloves off, not even to eat. Gave me the shivers. You'll want Strider, then, the Ranger in the corner. Everyone wants Strider these days.",
      summary: "Break the last ringleaders in the Shire, then carry the Mayor's letter east along the Great East Road to the Prancing Pony in Bree.",
      hint: "Head east along the Great East Road, cross the Brandywine Bridge and enter Bree by the West-gate; the Prancing Pony stands just inside.",
    }),

    // ================================================================ BOOK 2 — Roads to Bree and the Blue Mountains (L8–20)
    S(13, {
      name: 'A Ranger at the Pony', zone: 'breeland', giver: 'npc_bree_barliman', turnin: 'npc_bree_strider',
      objectives: [
        talk('npc_bree_strider', 'Speak with Strider in the common room of the Prancing Pony'),
        explore(-300, -300, 15, 'Scout the Greenway Waystone north of Bree'),
        kill('breeland_wolf', 6, 'Slay the Greenway wolves that follow the strangers'),
      ],
      rewards: { items: ['drink_pony_ale', 'pot_heal_salve', 'n_neck_bree'] },
      intro: "That's him, in the corner with his hood up and his boots on the bench. Strider, they call him, one of the Rangers, wandering folk from the North. Half of Bree says he's a rogue and the other half won't say anything at all, but he's been here every night this month watching the door, and when the pale-gloved gentleman was here, Strider never took his eyes off him. Go and talk to him, and tell him Barliman sent you. And don't let him drink on my account.",
      accept: "I'll speak with the Ranger.",
      progress: "Speak with Strider in the Prancing Pony, then do as he asks: scout the Greenway Waystone north of Bree and deal with the wolves there.",
      complete: "So. The ruffians in the Shire, the coins, the casket, and now the Greenway: the tracks by the waystone are the same boots that crossed the Brandywine. And wolves at their heels, which is no accident; wolves do not follow Men unless something has taught them to. Sit down. You have carried a wight's seal across the Shire and lived, and that makes you either lucky or useful. I intend to find out which.",
      summary: "Meet Strider at the Prancing Pony, scout the Greenway Waystone and slay the wolves shadowing the strangers.",
      hint: "Strider sits in the common room of the Prancing Pony; the Greenway Waystone stands north of Bree along the old road.",
    }),
    S(14, {
      name: 'Blackwolds on the Greenway', zone: 'breeland', giver: 'npc_bree_strider', turnin: 'npc_bree_hollis',
      objectives: [
        kill('brigand_blackwold', 6, 'Defeat the Blackwold brigands raiding Thornley\'s fields'),
        collectFrom('q_stolen_goods', 4, 'brigand_blackwold', 'Recover the goods stolen from the Bree-land farms'),
        explore(-420, 220, 20, 'Explore Thornley\'s Farm'),
      ],
      rewards: { items: ['pot_heal_salve', 'food_bree_bread', 'n_sword_bree'] },
      intro: "The men who came through the Shire call themselves Blackwolds, a brigand band that has grown fat in the Bree-land while the Watch looked the other way. They have been paid to grow bolder, and the paymaster is the one you have been chasing. They hold the fields south-west of the town around Thornley's farm, which they burned out a week ago. Go there, put as many down as you can, and bring back what they have stolen from the farms; the Constable of the Watch, Hollis Thornbury, will want to see it with his own eyes before he admits there is a problem.",
      accept: "I'll see what the Blackwolds have taken.",
      progress: "The Blackwolds are camped around Thornley's Farm south-west of Bree. Bring the stolen goods to Constable Hollis Thornbury.",
      complete: "Four sacks, all from farms on the Greenway, and Thornley's own mark on one of them. Very well, I'll say it: the Blackwolds are more than a nuisance now. I've had reports from Combe and Archet too, men in the woods at night, and the Reeve of Combe has been writing to me twice a week. It seems you'll be taking my answer to him in person.",
      summary: "Drive the Blackwold brigands from Thornley's Farm and bring the stolen goods to the Constable of Bree.",
      hint: "Thornley's Farm lies south-west of Bree along the Greenway; Constable Hollis stands by the south road inside the walls.",
    }),
    S(15, {
      name: 'Skirmish Hill', zone: 'breeland', giver: 'npc_bree_hollis', turnin: 'npc_combe_reeve',
      objectives: [
        talk('npc_combe_reeve', 'Bring the Constable\'s answer to Tancred Applewhite, Reeve of Combe'),
        kill('brigand_blackwold', 6, 'Drive the Blackwolds from the ruins of Skirmish Hill'),
        explore(50, -90, 20, 'Explore the ruins of Skirmish Hill'),
      ],
      rewards: { choose: gear('wanderer', 'hands'), items: ['pot_heal_salve'] },
      intro: "Tancred Applewhite is Reeve of Combe, and a sensible man, though he'll tell you I'm not. He says the Blackwolds have taken the old ruins on Skirmish Hill, east of the road between Bree and Combe, and are using them to watch the traffic. Tell him the Watch will send men when it can, which is my honest answer, and then go and do what the Watch cannot: drive them off the hill. Have a good look at the place, too. I want to know whether they're holding it for themselves or for someone else.",
      accept: "I'll carry your answer to Combe.",
      progress: "Speak with the Reeve of Combe, then clear the Blackwolds from the ruins of Skirmish Hill between Bree and Combe.",
      complete: "So Hollis will send men when he can, will he? That's what I thought. Still, the hill is clear, and that's more than the Watch has managed in a year. Did you see the lookout on the tower? Facing north-east, towards Archet, not down at the road. They aren't watching the traffic at all. They're waiting for something to come out of the Chetwood.",
      summary: "Carry the Constable's answer to the Reeve of Combe and clear the Blackwolds from the ruins of Skirmish Hill.",
      hint: "Combe lies east of Bree; Skirmish Hill is the ruined rise east of the Bree–Combe road.",
    }),
    S(16, {
      name: 'The Archet Watch', zone: 'breeland', giver: 'npc_combe_reeve', turnin: 'npc_archet_captain',
      objectives: [
        talk('npc_archet_captain', 'Warn Captain Aldric Brackenwood of Archet'),
        kill('bree_spider', 6, 'Clear the spiders from the woods below Archet'),
        collectFrom('mat_spider_silk', 4, 'bree_spider', 'Gather spider silk for the Archet bowyer'),
      ],
      rewards: { items: ['n_shield_bree', 'pot_heal_salve', 'food_bree_bread'] },
      intro: "Archet is the last village before the Chetwood, and if the Blackwolds are waiting for something to come out of those trees, Archet will meet it first. Aldric Brackenwood commands the Watch there; he's a stubborn man, but he keeps a palisade and a bell, which is more than we have. Go and warn him. The woods between here and Archet are thick with spiders this year, great grey ones, so go carefully. If you can bring Caldwell the bowyer some of their silk, he'll string bows for the Watch with it; they'll be needed.",
      accept: "I'll warn Archet.",
      progress: "Follow the road north-east to Archet and speak with Captain Brackenwood; clear the spiders in the woods on the way and gather their silk.",
      complete: "Skirmish Hill, watching the Chetwood? Then it's as I feared. My hunters have seen fires in the wood at night, and two of them haven't come back. Caldwell will be glad of the silk; we'll have bows strung by morning. There's more, though: the Blackwolds keep a stash somewhere between here and the hill, and one of my hunters saw a hooded man with pale gloves come out of it at dusk. I want it opened.",
      summary: "Warn the Captain of Archet, clear the spiders from the woods and gather silk for the Archet bowyer.",
      hint: "Archet lies north-east of Combe along the road; the spiders nest in the woods south of the village.",
    }),
    S(17, {
      name: 'The Blackwold Stash', zone: 'breeland', giver: 'npc_archet_captain', turnin: 'npc_bree_strider',
      objectives: [
        kill('brigand_blackwold', 8, 'Cut down the Blackwolds guarding Skirmish Hill'),
        use('gn_breeland_4', 1, 'Break open the Blackwold stash below the hill'),
        collectFrom('qa_pale_hand_letter', 1, 'brigand_blackwold', 'Find the letter sealed with a pale hand'),
      ],
      rewards: { items: ['pot_heal_salve', 'drink_pony_ale', 'food_bree_bread', 'n_helm_bree_watch'] },
      intro: "My hunter followed the pale-gloved man to a hollow below Skirmish Hill, where the Blackwolds keep a stash under a fallen oak; they hide it well and guard it better. I don't care about their plunder. I care about what a man like that leaves behind when he thinks nobody is watching. Fight your way down there, break open the stash and search every brigand who tries to stop you. Whatever letters you find, take them to that Ranger in Bree. He seems to be the only man who understands any of this.",
      accept: "I'll open their stash.",
      progress: "The stash lies in the hollow east of Skirmish Hill. Kill the guards, break it open and bring any letter you find to Strider in Bree.",
      complete: "\"The dwarves of Thorin's Hall keep the old lore of Cardolan. Silence any who go to ask them.\" So he fears the dwarves, and he fears what they remember. That tells me two things: the casket is more than a grave-seal, and our enemy does not know precisely what it is either. Isengar Took read the band aright as far as it went, but the runes are dwarf-work, and there is one lore-master under the Blue Mountains who will read all of it.",
      summary: "Fight through the Blackwolds below Skirmish Hill, break open their stash and take the Pale Hand's letter to Strider.",
      hint: "The stash is under a fallen oak in the hollow east of Skirmish Hill; Strider waits at the Prancing Pony in Bree.",
    }),
    S(18, {
      name: 'To the Blue Mountains', zone: 'eredluin', giver: 'npc_bree_strider', turnin: 'npc_thorinshall_dwalin',
      objectives: [
        deliver('qa_letter_strider', 'npc_thorinshall_dwalin', 'Carry Strider\'s letter to Dwalin, Lord of Thorin\'s Hall'),
        explore(-1250, -1200, 25, 'Explore the Vale of Thráin'),
        kill('cave_crawler', 6, 'Clear the cave-crawlers from the road at Sarnûr'),
      ],
      rewards: { choose: gear('wanderer', 'feet'), items: ['pot_heal_draught', 'food_roast_boar'] },
      intro: "Thorin's Hall lies in the Blue Mountains, far to the west beyond the Shire, and the road there runs north from Hobbiton through the hills. Dwalin is lord there now, and he is old enough to remember when Cardolan had kings. Give him this letter; it bears my mark, and he will know it. Look about the Vale of Thráin below the Hall while you are there, for I have heard that goblins are stirring in Rath Teraig, and I would know whether our enemy's hand reaches that far. And beware the crawlers at Sarnûr; they have grown bold enough to take ponies from the road.",
      accept: "West, then, to the Blue Mountains.",
      progress: "Follow the road north from Hobbiton into the Blue Mountains. Give Strider's letter to Dwalin in Thorin's Hall, explore the Vale of Thráin and clear the crawlers at Sarnûr.",
      complete: "A Ranger's letter, carried by one of the Small Folk's friends, all the way to my door. The Dúnadan asks after Cardolan, does he? Hmph. We dwarves are not in the habit of sharing our lore with every stranger who knocks, but Strider's name buys a hearing, and you have cleared the road of crawlers, which buys more. Skorri Runereader keeps our old books. He will not like it. Go and see him.",
      summary: "Carry Strider's letter west to Dwalin in Thorin's Hall, scouting the Vale of Thráin and clearing the crawlers at Sarnûr.",
      hint: "Take the road north from Hobbiton into the Blue Mountains; Thorin's Hall sits in the mountains beyond the Vale of Thráin.",
    }),
    S(19, {
      name: 'The Runes of Rath Teraig', zone: 'eredluin', giver: 'npc_thorinshall_skorri', turnin: 'npc_thorinshall_skorri',
      objectives: [
        collectNode('q_dwarf_deed', 4, 'gn_eredluin_3', 'Copy the rune-stones of Rath Teraig'),
        kill('goblin_warlord_rath', 4, 'Slay the goblin warlords who hold the rune-stones'),
      ],
      rewards: { items: ['n_gauntlets_thorin', 'pot_heal_draught', 'scroll_battle_10'] },
      intro: "So you carry a grave-seal of Cardolan and want to know what it binds. Hmm. The band is dwarf-work, yes, but not of this Hall; it was cut in the old days for the Men of Cardolan, when they paid us in silver to seal their dead against the Witch-king's necromancy. The records of those seals were carved on rune-stones in Rath Teraig, east of here, and the goblins have made a warren of the place. Go and copy the runes for me, all four stones, and kill the warlords that squat on them. Then I will tell you what your casket is.",
      accept: "I'll bring you the runes.",
      progress: "The rune-stones stand in Rath Teraig, east of Thorin's Hall, in the goblins' war-camp. Copy them and slay the warlords.",
      complete: "Let me see. Yes. Yes, that is the seal I feared: the third seal of the Great Barrow, laid on the tomb of a lord of Cardolan whose name we did not carve, because the Men asked us not to. The wights that walk the Downs are bound under three seals, and you carry one of them. Whoever holds all three may wake what lies beneath, or bind it forever. I would not have you carry it far without a stronger arm beside you. Speak to Dwalin.",
      summary: "Copy the four rune-stones of Rath Teraig and slay the goblin warlords who hold them, so Skorri can read the seal.",
      hint: "Rath Teraig is the goblin-haunted pass east of Thorin's Hall, below the Vale of Thráin.",
    }),
    S(20, {
      name: 'Gorkil, Goblin-chief', zone: 'eredluin', giver: 'npc_thorinshall_dwalin', turnin: 'npc_thorinshall_dwalin',
      objectives: [
        explore(-1160, -1020, 20, 'Enter the goblin-warren of Rath Teraig'),
        kill('goblin_warlord_rath', 3, 'Cut down Gorkil\'s warlords'),
        killboss('boss_gorkil', 'Slay Gorkil, Goblin-chief of Rath Teraig'),
      ],
      rewards: { items: ['n_axe_thorin', 'pot_heal_draught', 'pot_power_draught', 'food_roast_boar'] },
      intro: "Skorri has told me. The third seal of the Great Barrow, in a hobbit's cupboard for sixty years, and now half of Eriador's brigands hunting it. That is a matter for Rangers and elves, but this is a matter for dwarves: the goblins in Rath Teraig have a new chief, Gorkil, and he has been sending riders east along the mountain road. Pale-gloved riders. The enemy is paying goblins now, and I will not have that on my doorstep. Go into the warren, kill his warlords and bring me his head. Then we will talk about your casket, and about the elves.",
      accept: "Gorkil will not send riders again.",
      progress: "Enter Rath Teraig east of Thorin's Hall, cut down the goblin warlords and slay Gorkil in his warren.",
      complete: "Gorkil is dead? Ha! That is the best news these halls have heard since the Battle of Five Armies. You have the thanks of the Longbeards, and here is an axe of the Hall, honestly made. Now: Skorri says the seals were laid by dwarves but the words on them are elvish, for the Men of Cardolan had elves among their counsellors. The elves of Celondim on the coast will read the words, if anyone will. I have written to Elorion. Take it and go south.",
      summary: "Enter the warren of Rath Teraig, slay the goblin warlords and defeat Gorkil the Goblin-chief.",
      hint: "Rath Teraig lies east of Thorin's Hall; Gorkil holds the cave at the head of the pass.",
    }),
    S(21, {
      name: 'The Haven of Celondim', zone: 'eredluin', giver: 'npc_thorinshall_skorri', turnin: 'npc_celondim_master',
      objectives: [
        deliver('qa_letter_dwalin', 'npc_celondim_master', 'Bring Dwalin\'s letter to Elorion, Master of the Haven'),
        explore(-1390, -640, 20, 'Explore the Falls of Falathlorn'),
        kill('black_bear_eredluin', 5, 'Clear the black bears from the road above Celondim'),
      ],
      rewards: { choose: gear('militia', 'chest'), items: ['pot_heal_draught'] },
      intro: "Here is Dwalin's letter. He would sooner have swallowed his beard than write to an elf, so you may judge how seriously he takes this. Celondim lies on the coast south of here: take the road south past Duillond and down to the sea. The elves keep a haven there under the Falls of Falathlorn, and Elorion is master of it. Do not expect him to hurry. The bears along the mountain road have been bold since the goblins stirred; you will want to deal with them, unless you enjoy being chased.",
      accept: "I'll carry the letter south to Celondim.",
      progress: "Take the road south from Thorin's Hall past Duillond to Celondim. Give Dwalin's letter to Elorion, explore the Falls of Falathlorn and clear the bears from the road.",
      complete: "A letter from Dwalin son of Fundin, courteous in every word; the world is stranger than I knew. So the third seal of the Great Barrow has come to light, and the Enemy's servants are hunting it. We remember Cardolan, friend; we remember its fall, and the Witch-king's coming, and the sealing of the barrows. The words on the seal can be read, but not by lamplight. It must be done under the stars, with moonflower, and the singing of the sea.",
      summary: "Carry Dwalin's letter south to Elorion at the elven haven of Celondim, exploring the Falls of Falathlorn on the way.",
      hint: "Follow the road south from Thorin's Hall through Duillond to Celondim on the coast.",
    }),
    S(22, {
      name: 'Moonflower and Memory', zone: 'eredluin', giver: 'npc_celondim_tathar', turnin: 'npc_celondim_master',
      objectives: [
        collectNode('mat_moonflower', 4, 'gn_eredluin_5', 'Gather moonflower from the meadows south of Celondim'),
        fish(3, 'fs_celondim_quay', 'Catch three fish from the quay of Celondim for the rite'),
        explore(-1480, -560, 20, 'Explore the ruined haven of Kheledûl'),
      ],
      rewards: { items: ['n_mantle_lune', 'bait_bread', 'scroll_fortune_10'] },
      intro: "Elorion has asked me to prepare the rite of reading, and it needs three things that I cannot gather alone. Moonflower grows in the meadows south of the haven, but it opens only at night and must be picked fresh. The rite also asks for a gift of the sea: fish taken from the quay by your own hand, for the words were sealed with the sea's help. And lastly go north to Kheledûl, the old haven that the dwarves and elves once shared, and stand among its stones; the seal was made there, and the place remembers. I will tell Elorion when you return.",
      accept: "Moonflower, fish and old stones. I'll gather them.",
      progress: "Gather moonflower south of Celondim, catch three fish from the quay, and explore the ruins of Kheledûl to the north. Then return to Elorion.",
      complete: "It is done, and the words are read. The seal binds Sambrog, a lord of Cardolan who was buried alive in the Great Barrow when the Witch-king's shadow took him, and became the wight-lord of the Downs. Two seals still lie in his tomb. The one you carry was stolen by a hobbit's friend long ago, and that theft has kept him half-bound and dreaming. The Pale Hand means to bring it back and wake him. Strider must know at once.",
      summary: "Gather moonflower, fish from the quay and visit the ruins of Kheledûl so the elves can read the words of the seal.",
      hint: "The moonflower meadows lie south of Celondim; the quay is on the shore, and Kheledûl is the ruin on the coast to the north.",
    }),
    S(23, {
      name: 'Return to Bree', zone: 'breeland', giver: 'npc_celondim_master', turnin: 'npc_bree_strider',
      objectives: [
        deliver('qa_letter_elorion', 'npc_bree_strider', 'Bring Elorion\'s missive to Strider in Bree'),
        kill('blackwold_enforcer', 4, 'Break the Blackwold enforcers at the lookout east of Bree'),
        kill('neekerbreeker', 6, 'Clear the neekerbreekers from the bog south of the East Road'),
      ],
      rewards: { items: ['n_ear_dwarf', 'pot_heal_draught', 'food_roast_boar'] },
      intro: "Take this to Strider. It names the wight-lord and it names the seals, and it warns him of what the Pale Hand intends. Go swiftly: the road east is long, back through the Shire and over the Brandywine. I have had word from the Rangers that the Blackwolds have set enforcers, their hardest men, at a lookout east of Bree to watch the road for you. And the marsh south of the East Road has bred neekerbreekers thick enough to bring down a horse; if you clear them, the road will be safer for those who come after.",
      accept: "I'll bring it to Strider.",
      progress: "Return east to Bree. Deal with the Blackwold enforcers at their lookout and the neekerbreekers in the marsh, then give Elorion's missive to Strider at the Prancing Pony.",
      complete: "Sambrog. I feared it, and now I know it. The Great Barrow has been quiet for a hundred years because a hobbit's kinsman had the wit to run off with a seal he did not understand, and now the Witch-king's agent means to undo it. Well. The Blackwolds are the Pale Hand's arm in Bree-land, and while they stand, he can move as he pleases. Grimbold at the gate has been waiting for a reason to break them. Give him one.",
      summary: "Carry the elves' missive back east to Strider in Bree, breaking the Blackwold enforcers and the neekerbreekers on the way.",
      hint: "Go east through the Shire and over the Brandywine to Bree; the enforcers' lookout is east of the town and the bog lies south of the East Road.",
    }),
    S(24, {
      name: 'The Enforcers', zone: 'breeland', giver: 'npc_bree_grimbold', turnin: 'npc_bree_mayor',
      objectives: [
        kill('blackwold_enforcer', 5, 'Destroy the Blackwold enforcers'),
        collectFrom('qa_enforcer_badge', 3, 'blackwold_enforcer', 'Take the enforcers\' iron badges as proof'),
      ],
      rewards: { choose: gear('militia', 'legs'), items: ['pot_heal_draught', 'n_ring_bree'] },
      intro: "I have stood at this gate for eleven years and watched the Blackwolds walk in and out of Bree like they owned the road. The Mayor says the Watch has no proof and no men. Well, you're a man, or near enough, and you can bring the proof: the enforcers wear iron badges with a wolf's head, and there isn't a Blackwold alive who'll stay in Bree-land once his enforcers are dead and their badges are nailed to the Town Hall door. Go and get me three. Then take them to Hardwin Appledore and see if he still says there is no problem.",
      accept: "Three badges for the Town Hall door.",
      progress: "The Blackwold enforcers hold the lookout east of Bree. Kill them, take their badges and bring them to Mayor Appledore.",
      complete: "Three wolf's-head badges, on my desk, with the blood still on them. Very well, Grimbold has made his point and so have you. I'll say this plainly before the whole Council: the Blackwolds are broken in Bree-land, and it was not the Watch that broke them. There'll be a proper thanks for that, the sort Bree does not give lightly. Come back tomorrow, when I've sobered the Council up.",
      summary: "Destroy the Blackwold enforcers east of Bree and bring their iron badges to the Mayor as proof.",
      hint: "The enforcers' lookout lies east of Bree, beyond the East-gate; the Mayor stands before the Town Hall.",
    }),
    S(25, {
      name: 'Sword of Bree', zone: 'breeland', giver: 'npc_bree_mayor', turnin: 'npc_bree_mayor',
      objectives: [
        kill('blackwold_enforcer', 6, 'Scatter the last Blackwold enforcers from the Bree-land'),
        talk('npc_bree_barliman', 'Accept Barliman Butterbur\'s hospitality at the Prancing Pony'),
        explore(-310, -44, 12, 'Attend the feast at the Prancing Pony'),
      ],
      rewards: { choose: gear('militia', 'feet'), items: ['pot_heal_draught', 'drink_pony_ale', 'food_roast_boar'], title: 'Sword of Bree', mount: 'mount_bree' },
      intro: "The Council has spoken, which happens about once a decade, and it has spoken well. There is one thing left: the last of the enforcers have gathered at the lookout for a final stand, and I want them gone before the feast, so that no Blackwold can say he was still standing when Bree celebrated. Do that, and then present yourself at the Prancing Pony; Barliman has been roasting a pig since dawn and Bob Ostler has something in the stables that the Council bought with its own purse. Bree does not forget its friends.",
      accept: "I'll finish the Blackwolds and come to the feast.",
      progress: "Scatter the last enforcers east of Bree, then go to the Prancing Pony and speak with Barliman before returning to the Mayor.",
      complete: "There. Hardwin Appledore, Mayor of Bree, names you Sword of Bree, and the horse in the stable is yours, and the Blackwolds are done. Strider says their chief, Halgar, fled south into the Chetwood with the Pale Hand's gold, and that the hunters' camp there needs help. But that is tomorrow's trouble. Tonight, drink. Barliman's ale is the best in Bree-land, which is not saying much, but it is saying something.",
      summary: "Finish the Blackwold enforcers, then join the feast at the Prancing Pony and be honoured by the Mayor of Bree.",
      hint: "The last enforcers are at their lookout east of Bree; the Prancing Pony stands inside the West-gate.",
    }),

    // ================================================================ BOOK 3 — The Old Forest and the Barrow-downs (L15–28)
    S(26, {
      name: 'Hunters of the Chetwood', zone: 'souththicket', giver: 'npc_bree_strider', turnin: 'npc_chetwoodcamp_huntmaster',
      objectives: [
        talk('npc_chetwoodcamp_huntmaster', 'Find Bramwell Ashdown at the Chetwood Hunters\' Camp'),
        kill('chetwood_wolf', 6, 'Slay the Chetwood wolves preying on the hunters'),
      ],
      rewards: { items: ['pot_heal_draught', 'food_roast_boar', 'n_boots_wanderer'] },
      intro: "Halgar the Blackwold has gone to ground in the Chetwood, south-east of Bree, with the remnant of his band and the Pale Hand's gold. The hunters who live there have a camp on the edge of the Midgewater, and their huntmaster, Bramwell Ashdown, has sent to me twice for help. Follow the path south from Staddle into the wood and find him. The wolves of the Chetwood are worse than any in Bree-land, and the Blackwolds have been feeding them; deal with the packs near the camp before they deal with the hunters.",
      accept: "To the Chetwood, then.",
      progress: "Follow the Midgewater Path south from Staddle into the Chetwood. Speak with Bramwell Ashdown at the Hunters' Camp and thin the wolves around it.",
      complete: "Strider sent you? Then you are welcome, and doubly so with the wolves off our backs; I have lost two hunters and a dog to them this month. You should know what you have walked into. The Blackwolds are camped in the deep wood south of here, poaching our deer and stringing snares across every path, and their archers have made the old lodge a fortress. Halgar himself has not been seen. But someone in a pale hood comes and goes at night.",
      summary: "Find the Chetwood Hunters' Camp south-east of Bree and thin the wolves preying on the hunters.",
      hint: "Take the Midgewater Path south from Staddle into the Chetwood; the Hunters' Camp lies at the edge of the marsh.",
    }),
    S(27, {
      name: 'Poachers of the Blackwold', zone: 'souththicket', giver: 'npc_chetwoodcamp_huntmaster', turnin: 'npc_chetwoodcamp_saeradan',
      objectives: [
        kill('chetwood_brigand', 8, 'Hunt the Blackwold poachers in the western wood'),
        collectFrom('qa_poacher_snare', 4, 'chetwood_brigand', 'Take the poachers\' snares'),
      ],
      rewards: { choose: gear('militia', 'head'), items: ['pot_heal_draught', 'n_dagger_midge'] },
      intro: "The poachers work the western wood, between here and Staddle, and they are not shy about it: they've cut the throats of three of my deer this week and left them to rot, just to spite us. They set wire snares across the deer-paths, and my dogs have been crippled by them. Hunt the poachers and take every snare you find on them; I want the wood clean. Saeradan, the Ranger who camps with us, will want to see the snares, for he says they're made of wire that no Bree smith draws.",
      accept: "The poachers won't cut another throat.",
      progress: "The Blackwold poachers work the wood west of the camp. Kill them, take their snares and show them to Saeradan the Ranger.",
      complete: "Angmar wire. I have seen its like on the North Downs, on the snares the orcs set for our horses; nobody south of Fornost draws wire so fine. So the Pale Hand supplies the Blackwolds from the north, and that means a road, and a road means camps. Bramwell's marsh-guide, Nell, has seen lights in the Midgewater that are not marsh-fire. Go with her.",
      summary: "Hunt the Blackwold poachers in the western Chetwood and bring their snares to Saeradan the Ranger.",
      hint: "The poachers lurk in the wood west of the Hunters' Camp; Saeradan stands at the camp's north edge.",
    }),
    S(28, {
      name: 'Into the Midgewater', zone: 'souththicket', giver: 'npc_chetwoodcamp_nell', turnin: 'npc_chetwoodcamp_nell',
      objectives: [
        explore(180, 470, 25, 'Explore the Midgewater Marshes'),
        kill('midgewater_spider', 6, 'Kill the Midgewater spiders along the causeway'),
        kill('marsh_crawler', 5, 'Kill the marsh-crawlers in the pools'),
        collectNode('mat_athelas', 4, 'gn_souththicket_1', 'Gather athelas for the wounded hunters'),
      ],
      rewards: { items: ['pot_heal_draught', 'pot_power_draught', 'food_roast_boar', 'n_pocket_map'] },
      intro: "Nobody knows the Midgewater like me, and I'm telling you it's gone wrong. There's lights out on the hummocks at night, and voices, and the spiders have come down from the Chetwood eaves to nest along the old causeway where nothing ever nested before. Crawlers in the pools, too, big as ponies. I'll show you the safe way in, but you'll do the fighting. And keep an eye out for athelas; it grows on the dry ground at the marsh edge, and we've wounded hunters back at the camp who need it more than they'll admit.",
      accept: "Show me the way in, Nell.",
      progress: "Follow Nell's causeway into the Midgewater east of the camp. Kill the spiders and crawlers, look about the marsh, and gather athelas from the dry ground at its edge.",
      complete: "Athelas! Bless you; Old Meg will have the hunters on their feet by morning. And you saw the lights? Then I'm not mad. That's the Blackwolds' road through the marsh, hummock to hummock, and it leads north-east to the old Chetwood lodge where the archers are. If Halgar's anywhere, he's beyond that lodge. Saeradan will want to know.",
      summary: "Scout the Midgewater Marshes with Nell, clear the spiders and crawlers, and gather athelas for the wounded hunters.",
      hint: "The Midgewater lies east of the Hunters' Camp; the athelas grows on the dry ground at the marsh edge.",
    }),
    S(29, {
      name: 'The Archers\' Blind', zone: 'souththicket', giver: 'npc_chetwoodcamp_saeradan', turnin: 'npc_chetwoodcamp_saeradan',
      objectives: [
        kill('chetwood_archer', 4, 'Silence the Blackwold archers at their blind'),
        collectNode('q_sealed_letter', 3, 'gn_souththicket_4', 'Search the old Chetwood lodge for sealed letters'),
        explore(250, 320, 20, 'Explore the old Chetwood lodge'),
      ],
      rewards: { items: ['pot_heal_draught', 'n_cloak_withywindle', 'scroll_fortitude_10'] },
      intro: "The Blackwold archers have made a blind at the old lodge north-east of the marsh, and from it they command every path to Halgar's camp. They are the best of what is left to him, and they will not miss twice. Go around by the spider hollow and take them from the flank, and when the lodge is yours, search it. Men who receive letters from the Pale Hand keep them, for fear of being asked to prove their orders. I want every sealed letter you can find.",
      accept: "I'll take the lodge.",
      progress: "The archers' blind is at the old lodge north-east of the Midgewater. Silence the archers, explore the lodge and gather the sealed letters there.",
      complete: "Three letters, all under the pale hand-print, and this last one is the prize: \"Halgar. Hold the Chetwood until the seal is brought south. Then the Barrow.\" He does not have the seal, so he waits, and while he waits we can reach him. Halgar's camp is in the deep wood south of the marsh. Bramwell wants his head, and so do I.",
      summary: "Silence the Blackwold archers at the old Chetwood lodge and gather the sealed letters hidden there.",
      hint: "The old lodge stands north-east of the Midgewater, beyond the spider hollow.",
    }),
    S(30, {
      name: 'Halgar the Blackwold', zone: 'souththicket', giver: 'npc_chetwoodcamp_huntmaster', turnin: 'npc_bree_strider',
      objectives: [
        killboss('boss_halgar', 'Slay Halgar the Blackwold in his camp'),
        use('gn_souththicket_5', 1, 'Break open the Blackwold plunder'),
        deliver('q_brigand_map', 'npc_bree_strider', 'Bring Halgar\'s map to Strider in Bree'),
      ],
      rewards: { choose: gear('militia', 'shoulder'), items: ['pot_heal_draught', 'pot_power_draught', 'n_neck_wight'] },
      intro: "Halgar's camp is in the deep wood south of the marsh, palisaded and full of everything he stole from Bree-land. He's a big man with a bigger axe and he's killed better hunters than me. But you've done what none of us could, and Saeradan says the letters show he's only waiting. So don't let him wait. Go in, kill him, and break open his plunder; whatever the Pale Hand gave him is ours now. Saeradan thinks he carries a map of the road north. If he does, Strider in Bree must have it before the day is out.",
      accept: "Halgar's waiting is over.",
      progress: "Halgar's camp lies in the deep Chetwood south of the Midgewater. Slay him, break open the plunder and carry his map to Strider in Bree.",
      complete: "Halgar dead, and this map in his pack: the Chetwood, the Midgewater, and a road marked south around the Old Forest to the Barrow-downs, ending at the Great Barrow. So he knows where the tomb is, and he has men on the road. We must reach the Barrow before he does, and there is only one way through the Old Forest that does not end in the Withywindle: past the house of Tom Bombadil.",
      summary: "Slay Halgar the Blackwold in his Chetwood camp, break open his plunder and carry his map to Strider.",
      hint: "Halgar's palisaded camp lies in the deep wood south of the Midgewater; Strider waits at the Prancing Pony in Bree.",
    }),
    S(31, {
      name: 'Under the Hedge', zone: 'oldforest', giver: 'npc_bree_strider', turnin: 'npc_tomshouse_tom',
      objectives: [
        talk('npc_tomshouse_tom', 'Seek the house of Tom Bombadil in the Old Forest'),
        kill('old_forest_wolf', 6, 'Slay the wolves that hunt the path to Tom\'s house'),
        explore(-530, 640, 20, 'Explore the Bonfire Glade'),
      ],
      rewards: { items: ['pot_heal_draught', 'food_honey_cake', 'n_tunic_withywindle'] },
      intro: "The Old Forest lies south of Bree, beyond Staddle and the hobbits' Hedge, and it is not a forest that likes visitors. The trees move. The paths turn. Do not follow the Withywindle, whatever it seems to promise. Follow the road south and west from Bree instead until it comes to a house with a yellow roof, and there you will find Tom Bombadil, who is older than the Forest and afraid of nothing in it. Ask his help; the seal is a thing of the Downs, and he is master there. Wolves will find you before you find him. Kill them, and look at the Bonfire Glade on the way: the hobbits burned the trees there once, and the Forest has not forgotten.",
      accept: "To the house with the yellow roof.",
      progress: "Follow the road south from Bree into the Old Forest. Deal with the wolves, look at the Bonfire Glade, and find Tom Bombadil at his house.",
      complete: "Hey dol! Merry dol! A visitor, and a weary one, with a cold thing in a cloak. Tom knows what you carry; Tom has known it since it left the Downs in a hobbit's pocket, sixty summers gone. Come in, come in! Goldberry has the table laid, and the wolves will not follow you here. Sit by the fire, and Tom will tell you of Cardolan, and of the one who lies under the Great Barrow and dreams of waking.",
      summary: "Enter the Old Forest south of Bree, slay the wolves on the path and find the house of Tom Bombadil.",
      hint: "Follow the road south and west from Bree through the Old Forest; Tom's house has a yellow roof and stands above the Withywindle.",
    }),
    S(32, {
      name: 'Old Man Willow', zone: 'oldforest', giver: 'npc_tomshouse_tom', turnin: 'npc_tomshouse_goldberry',
      objectives: [
        kill('old_forest_spider', 6, 'Kill the spiders spinning under the eaves of the Old Forest'),
        collectNode('mat_nightshade', 4, 'gn_oldforest_2', 'Gather nightshade for Goldberry from the north wood'),
        explore(-470, 730, 15, 'Visit Old Man Willow by the Withywindle'),
        fish(3, 'fs_withywindle', 'Catch three fish from the Withywindle for Goldberry\'s table'),
      ],
      rewards: { items: ['pot_heal_draught', 'bait_cricket', 'scroll_angler_10', 'n_barrow_blade'] },
      intro: "Before Tom takes you to the Downs, the Forest must know your face, or it will eat you when Tom's back is turned. Go down to the Withywindle and stand under Old Man Willow; Tom has sung to him and he will let you by, though he'll grumble. Kill the spiders under the eaves, for they've grown hungry with the Blackwolds' feeding. Goldberry wants nightshade from the north wood for her cordial, and fish from the river for her table, so bring both. And then, my friend, we go down into the Barrow-downs together, and not before.",
      accept: "I'll go and meet Old Man Willow.",
      progress: "Kill the spiders under the eaves, gather nightshade in the north wood, stand under Old Man Willow by the Withywindle and catch three fish there for Goldberry.",
      complete: "The nightshade, and the fish, and Old Man Willow let you pass? Then the Forest has looked at you and let you be, and that is rarer than you know. Sit and eat. Tom sings of the Downs tonight, and of Sambrog who was a lord of Men before the Witch-king came, and of the day the seals were laid. You will want to sleep well, for tomorrow the road goes down among the barrows.",
      summary: "Win the Old Forest's trust: kill the spiders, gather nightshade, visit Old Man Willow and fish the Withywindle.",
      hint: "The spiders and nightshade are in the wood north of Tom's house; Old Man Willow stands on the Withywindle to the south-east.",
    }),
    S(33, {
      name: 'The Downs of Cardolan', zone: 'oldforest', giver: 'npc_tomshouse_goldberry', turnin: 'npc_tomshouse_tom',
      objectives: [
        kill('barrow_bat', 6, 'Drive off the barrow-bats that haunt the Downs'),
        kill('forest_bear', 4, 'Slay the bears on the path to the Downs'),
        explore(-380, 820, 20, 'Explore the Barrow of Cardolan'),
      ],
      rewards: { choose: gear('militia', 'hands'), items: ['pot_heal_draught', 'pot_power_draught'] },
      intro: "Tom has gone ahead to sing the barrows quiet, and he asks that you follow at a little distance, for even Tom's song cannot quiet a bear. The path runs south-east from the Withywindle past the great bears' dens and up onto the Downs, where the barrow-bats fly by day now that the dead are restless. Go to the Barrow of Cardolan first; it is the lesser tomb, and it will tell us how far the waking has gone. Tom will meet you there. Take my cordial, and do not sleep on the Downs.",
      accept: "I'll follow Tom to the Downs.",
      progress: "Take the path south-east from the Withywindle past the bears and up onto the Barrow-downs. Drive off the bats and look about the Barrow of Cardolan, where Tom will meet you.",
      complete: "Here you are, and here is Tom, and here are the Downs, and see, see how the stones have turned! The barrow-mouths stand open that Tom shut a hundred years ago, and the wights walk in the daylight. Sambrog stirs under the Great Barrow, and his servants dig for the two seals that still lie with him. Tom cannot be everywhere. You must go into the barrows, and Tom will sing you out again.",
      summary: "Follow Tom onto the Barrow-downs, drive off the bats and bears, and explore the Barrow of Cardolan.",
      hint: "The Barrow-downs lie south-east of Tom's house, beyond the Withywindle and the bears' dens.",
    }),
    S(34, {
      name: 'Wights of the Barrow', zone: 'oldforest', giver: 'npc_tomshouse_tom', turnin: 'npc_tomshouse_tom',
      objectives: [
        kill('wight_barrow', 8, 'Lay the barrow-wights of Cardolan to rest'),
        collectFrom('qa_wight_seal', 3, 'wight_barrow', 'Take the grave-seals the wights carry'),
        collectNode('junk_barrow_relic', 4, 'gn_oldforest_4', 'Recover the relics of Cardolan from the barrow'),
      ],
      rewards: { items: ['pot_heal_draught', 'pot_power_draught', 'food_honey_cake', 'n_cloak_barrow'] },
      intro: "Wights are dead men that the Witch-king filled with a cold will, and they cannot be killed, only put back to sleep; but sleep is enough, if it is long. Go into the Barrow of Cardolan and lay them down. Each of the greater wights carries a small grave-seal, a copy of the great ones, and Tom wants those, for with them Tom can shut the doors again. And bring out the old relics of the Men of Cardolan that lie in the barrow; the wights draw strength from them, and the Mathom-house would treasure them, and either is a good reason.",
      accept: "I'll go down among the wights.",
      progress: "Enter the Barrow of Cardolan on the Downs. Lay the wights to rest, take their grave-seals and recover the relics of Cardolan from the tomb.",
      complete: "Three seals, and the old relics, and the wights asleep for a while. Tom sings and the barrow-doors close, one, two, three, and the Downs are quieter tonight. But not quiet. The Great Barrow is guarded by the wight-guardians, the strongest of Sambrog's servants, and Tom's song does not reach past them. They must be broken by hand.",
      summary: "Enter the Barrow of Cardolan, lay the wights to rest, take their grave-seals and recover the relics of Cardolan.",
      hint: "The Barrow of Cardolan is on the western Downs, south-east of Tom's house; the relics lie inside the tomb.",
    }),
    S(35, {
      name: 'The Wight-guardians', zone: 'oldforest', giver: 'npc_tomshouse_goldberry', turnin: 'npc_tomshouse_tom',
      objectives: [
        kill('wight_guardian', 4, 'Break the wight-guardians of Cardolan at the Great Barrow'),
        kill('barrow_crawler', 6, 'Kill the barrow-crawlers that swarm from the tombs'),
        explore(-330, 900, 20, 'Explore the mouth of the Great Barrow'),
      ],
      rewards: { items: ['pot_heal_draught', 'pot_power_draught', 'n_lute_forsaken', 'scroll_swiftfoot_10'] },
      intro: "Tom is out on the Downs singing the doors shut, and he sent me to tell you where the last of them stands: the Great Barrow, at the south end of the Downs, where the wight-guardians keep watch. They were the king's guard of Cardolan, and the Witch-king took them first and bound them deepest. Break them, and the way to Sambrog is open. The crawlers that swarm out of the tombs will try to stop you; they are only beasts, but there are many of them. Look at the mouth of the Great Barrow when you are done, and tell Tom what stands there.",
      accept: "The guardians will fall.",
      progress: "Go to the Great Barrow at the south end of the Downs. Break the wight-guardians, kill the crawlers and look at the barrow-mouth, then find Tom.",
      complete: "Broken, the guardians, and the crawlers scattered, and the Great Barrow's mouth stands open with no one before it. Tom saw it from the hill. Now Tom will tell you a hard thing. The seal you carry must go back into the Barrow, into Sambrog's own hand, and there be broken; for a seal that binds can also be used to wake, and while it is whole the Pale Hand will never stop hunting it. Tom will go with you. Tom is not afraid.",
      summary: "Break the wight-guardians at the Great Barrow, clear the crawlers and scout the open barrow-mouth for Tom.",
      hint: "The Great Barrow stands at the south end of the Barrow-downs, beyond the Barrow of Cardolan.",
    }),
    S(36, {
      name: 'Sambrog, the Wight-lord', zone: 'oldforest', giver: 'npc_tomshouse_tom', turnin: 'npc_tomshouse_tom',
      objectives: [
        killboss('boss_sambrog', 'Lay Sambrog, the Wight-lord, to rest in the Great Barrow'),
        use('gn_oldforest_5', 1, 'Break the seal upon the hoard of the Great Barrow'),
      ],
      rewards: { choose: gear('ranger', 'chest'), items: ['pot_heal_draught', 'pot_power_draught', 'food_honey_cake'] },
      intro: "Down we go, then, into the dark, with Tom singing before and you walking after. Sambrog lies in the last chamber under the hill, on a bed of gold, with two seals on his breast and a cold light in his eyes. He will rise when you come, for he has been dreaming of the third seal for sixty years and he will know it near. Fight him. Tom's song will keep his servants from you, but the wight-lord is yours. When he lies still, break the seal upon his hoard; it is the great seal, and the three are one, and when it breaks the others break with it.",
      accept: "Into the Great Barrow.",
      progress: "Descend into the Great Barrow with Tom. Defeat Sambrog the Wight-lord and break the seal upon his hoard.",
      complete: "Broken! All three, in one crack like winter ice, and Sambrog is asleep as he was not asleep since Cardolan fell. The Downs are quiet, truly quiet, and the barrow-doors are shut and will stay shut. Tom is glad, and Goldberry will be gladder. Take the halves of the great seal; they must be carried far apart, one to Strider and one Tom will keep. And know this: the Pale Hand wanted Sambrog waked to lead the dead of Cardolan north. North, to Fornost, where the Witch-king is gathering his old army.",
      summary: "Descend into the Great Barrow with Tom Bombadil, defeat Sambrog the Wight-lord and break the seal upon his hoard.",
      hint: "The Great Barrow is at the south end of the Barrow-downs; Sambrog waits in the last chamber.",
    }),
    S(37, {
      name: 'Barrow-breaker', zone: 'oldforest', giver: 'npc_tomshouse_tom', turnin: 'npc_bree_strider',
      objectives: [
        kill('wight_guardian', 3, 'Put down the last wight-guardians straying from the Downs'),
        deliver('qa_wightlord_seal', 'npc_bree_strider', 'Carry half of the broken seal to Strider in Bree'),
      ],
      rewards: { items: ['pot_heal_draught', 'pot_power_draught', 'food_honey_cake', 'n_ring_ranger'], title: 'Barrow-breaker' },
      intro: "Here is your half of the seal, cold and dead now, and Tom's half goes under the roots of the oldest tree in the Forest, where no pale hand will dig. A few of the guardians strayed from the Downs before the doors shut; put them down on your way, so that no farmer in Bree-land meets one on the road. Then go to Strider, and tell him what Tom told you: the Pale Hand serves the Witch-king, and the Witch-king's eye is on Fornost. Tom's country ends at the Downs. Yours does not. Go well, Barrow-breaker.",
      accept: "Farewell, Tom. Thank you.",
      progress: "Put down the last wight-guardians straying from the Downs, then return north to Bree and give the half-seal to Strider.",
      complete: "Half of the great seal of Cardolan, broken by Tom Bombadil's hand. I would not have believed it of anyone else. Sambrog sleeps, the Blackwolds are finished, and the Pale Hand has lost every piece he played in the south. He will go north now, to the Lone-lands and the Weather Hills, where the Witch-king's orcs are already gathering. So must we. I have friends on that road: Osric at the Forsaken Inn, and Candaith of Weathertop. It is time you met them.",
      summary: "Put down the last straying wight-guardians and carry half of Sambrog's broken seal north to Strider in Bree.",
      hint: "The straying guardians are on the Downs south of Tom's house; then follow the road north to Bree.",
    }),

    // ================================================================ BOOK 4 — The Lone-lands and the North Downs (L26–40)
    S(38, {
      name: 'The Forsaken Inn', zone: 'lonelands', giver: 'npc_bree_strider', turnin: 'npc_forsakeninn_osric',
      objectives: [
        talk('npc_forsakeninn_osric', 'Find Osric Duskwood at the Forsaken Inn'),
        kill('red_hill_bandit', 6, 'Drive the Red-hill bandits off the East Road'),
        explore(330, -60, 20, 'Explore the ruins of Minas Eriol'),
      ],
      rewards: { items: ['pot_heal_draught', 'pot_power_draught', 'food_honey_cake'] },
      intro: "The Great East Road runs east from Bree into the Lone-lands, an empty country of heather and broken hills where nothing lives but bandits and the Eglain, who are poor folk but honest. The Forsaken Inn stands a day's ride out, the last roof between Bree and the mountains, and Osric Duskwood watches it for me. Find him. The Red-hill bandits have been thick on the road this year, thick enough to make me think someone pays them; clear them as you go. And look at Minas Eriol, the old tower north of the inn. The Eglain say goblins have taken it.",
      accept: "East along the Road, then.",
      progress: "Follow the Great East Road east from Bree to the Forsaken Inn and speak with Osric Duskwood; clear the bandits from the Road and look at the ruins of Minas Eriol.",
      complete: "Strider's friend, and Barrow-breaker to boot? Sit down, sit down; Anlaf's ale is bad but it's cold. So the Pale Hand is coming east. I have seen his riders already, going by the inn at night towards the Weather Hills without stopping, and no one rides past the Forsaken Inn without stopping unless he's afraid of being seen. And Minas Eriol, aye: the goblins have it, and they hang a pale banner from the tower.",
      summary: "Follow the East Road to the Forsaken Inn, clear the bandits and explore the goblin-held ruins of Minas Eriol.",
      hint: "Take the Great East Road east from Bree; the Forsaken Inn stands beside it and Minas Eriol rises to the north.",
    }),
    S(39, {
      name: 'Goblins of Minas Eriol', zone: 'lonelands', giver: 'npc_forsakeninn_wyn', turnin: 'npc_forsakeninn_osric',
      objectives: [
        kill('lonelands_goblin', 8, 'Slay the goblins that hold Minas Eriol'),
        collectFrom('junk_goblin_ear', 4, 'lonelands_goblin', 'Bring goblin-ears as proof for the Eglain'),
      ],
      rewards: { choose: gear('ranger', 'legs'), items: ['pot_heal_draught', 'pot_power_draught'] },
      intro: "The goblins came to Minas Eriol at the turn of the year, more than a hundred of them, and my people have not dared the north road since. We Eglain are not warriors; we scrape a living from the ruins and the road, and we cannot afford to lose a single hunter. But if you kill enough of the beasts, the rest will slink back to the hills. Bring me their ears. It is an ugly custom, I know, but my folk will not believe the tower is clear unless they see them.",
      accept: "The goblins will leave Minas Eriol.",
      progress: "Minas Eriol lies north of the Forsaken Inn. Slay the goblins there and bring their ears to Osric at the inn.",
      complete: "Wyn's counting the ears on the bar, and the Eglain are already talking about going back to the tower for the copper in its walls. That's what victory looks like out here. You saw the banner? White hand on black. That's the Witch-king's mark, or the mark of one who serves him. The goblins were his, and so were the bandits. Everything east of Bree is being bought up by Angmar, and the Weather Hills are next.",
      summary: "Slay the goblins holding Minas Eriol and bring their ears to the Eglain as proof.",
      hint: "Minas Eriol is the ruined tower north of the Forsaken Inn.",
    }),
    S(40, {
      name: 'The Weather Hills', zone: 'lonelands', giver: 'npc_forsakeninn_osric', turnin: 'npc_forsakeninn_wyn',
      objectives: [
        kill('lonelands_warg', 6, 'Hunt the wargs of the Weather Hills'),
        explore(420, -280, 20, 'Explore the Red Pass'),
        collectNode('mat_rowan_wood', 4, 'gn_lonelands_4', 'Cut rowan wood for the Eglain\'s beacon-fires'),
      ],
      rewards: { items: ['pot_heal_draught', 'pot_power_draught', 'food_honey_cake', 'n_hood_ranger'] },
      intro: "North of the inn the Weather Hills rise in a line to Weathertop, and the Red Pass cuts through them; it is the only way for an army to come down from the North Downs to the Road, and I want to know whether one is coming. Go up to the pass and look. There are wargs on the hills, big grey wolves that Angmar breeds and rides, and they will smell you before you see them; kill what you can. And the Eglain want rowan for their beacons, the rowan that grows in the hollows below the pass. If Angmar comes, we will need to light them.",
      accept: "I'll scout the Red Pass.",
      progress: "Go north from the Forsaken Inn into the Weather Hills. Hunt the wargs, explore the Red Pass and cut rowan wood in the hollows below it. Report to Wyn.",
      complete: "Rowan for four beacons; good. And wargs dead in the pass; better. But you saw no army? Then it isn't coming down the pass. It's already here. Osric says the riders go to Weathertop, and the Eglain hunters say the orcs have a camp under the hill, on the western side, where the old road climbs. Candaith the Ranger watches Weathertop from Ost Guruth. He'll know.",
      summary: "Scout the Red Pass in the Weather Hills, hunt the wargs there and cut rowan for the Eglain's beacon-fires.",
      hint: "The Weather Hills rise north of the Forsaken Inn; the Red Pass is the notch at their northern end, with rowan in the hollows below it.",
    }),
    S(41, {
      name: 'Candaith of Weathertop', zone: 'lonelands', giver: 'npc_forsakeninn_osric', turnin: 'npc_ostguruth_candaith',
      objectives: [
        deliver('qa_letter_osric', 'npc_ostguruth_candaith', 'Bring Osric\'s letter to Candaith at Ost Guruth'),
        kill('orc_lonelands', 6, 'Strike at the orc-camp under Weathertop'),
        kill('weather_hills_spider', 5, 'Kill the spiders on the western slopes of Weathertop'),
      ],
      rewards: { items: ['pot_heal_elixir', 'pot_power_elixir', 'food_ranger_stew'] },
      intro: "Take this to Candaith. He is a Ranger of Strider's company and he has watched Weathertop for two years from the Eglain's stronghold at Ost Guruth, east along the Road; the letter tells him what we have learned about the pale banner. On your way, strike at the orc-camp under the western side of Weathertop, for the orcs there are Angmar's, not the Lone-lands' usual rabble, and they are digging. The slopes above the camp are thick with spiders that the orcs have let grow; clear them if you can.",
      accept: "To Ost Guruth and Candaith.",
      progress: "Strike at the orc-camp under the western slopes of Weathertop and clear the spiders above it, then follow the Road east to Ost Guruth and give Osric's letter to Candaith.",
      complete: "Osric writes well, and you fight better, by the look of the orc-blood on your boots. Angmar has a captain on Weathertop now, an orc called Ugrûk, and he has been digging into the old foundations of Amon Sûl for a month. I could not think why, until Osric's letter. They are hunting for what the Dúnedain hid there when the tower fell: the shards of the palantír's crown. The Pale Hand wants relics of Arnor, all of them, and Weathertop is the richest of its ruins.",
      summary: "Carry Osric's letter east to Candaith at Ost Guruth, striking at the orc-camp and the spiders on Weathertop's slopes.",
      hint: "The orc-camp is on the western side of Weathertop; Ost Guruth lies further east along the Great East Road.",
    }),
    S(42, {
      name: 'Amon Sûl', zone: 'lonelands', giver: 'npc_ostguruth_candaith', turnin: 'npc_ostguruth_candaith',
      objectives: [
        explore(500, 30, 20, 'Climb to the summit of Weathertop'),
        collectNode('q_shard_of_arnor', 3, 'gn_lonelands_3', 'Recover the shards of the lost crown from the ruins of Amon Sûl'),
        killboss('boss_ugruk', 'Slay Ugrûk, Orc-captain of the Weather Hills'),
      ],
      rewards: { choose: gear('ranger', 'head'), items: ['pot_heal_elixir', 'pot_power_elixir', 'n_throwing_ranger'] },
      intro: "There is a way up Weathertop from the south that the orcs do not watch, and I will show it to you. At the summit stand the ruins of Amon Sûl, the watch-tower of the kings; among the fallen stones the shards of the old crown of Arnor still lie, cold and bright, and Ugrûk's diggers have nearly found them. Climb, take the shards before he does, and then take Ugrûk. He is the Witch-king's captain in the Lone-lands, and while he lives no road east of Bree is safe. I will hold the path below you.",
      accept: "I'll take the summit.",
      progress: "Climb Weathertop by the southern path. Gather the shards of the crown from the ruins of Amon Sûl and slay Ugrûk the Orc-captain.",
      complete: "Three shards, and Ugrûk dead on the summit of Amon Sûl. The Rangers have not held that hill since Arvedui's day, and tonight we hold it. Look at this, from Ugrûk's belt: a cracked shield-boss, and scratched inside it, orders under the pale hand-print. \"Take the shards north to Fornost. Hwaldan commands.\" Hwaldan. So the Pale Hand has a name at last, and it is an Angmarim name.",
      summary: "Climb Weathertop, recover the shards of the crown of Arnor from Amon Sûl and slay Ugrûk the Orc-captain.",
      hint: "Weathertop is the great hill north of the Road between the Forsaken Inn and Ost Guruth; climb it from the south.",
    }),
    S(43, {
      name: 'The Ruins of Agamaur', zone: 'lonelands', giver: 'npc_ostguruth_hunwald', turnin: 'npc_ostguruth_grimwynn',
      objectives: [
        kill('warg_alpha_lonelands', 4, 'Slay the warg pack-leaders of the eastern hills'),
        use('gn_lonelands_5', 1, 'Search the Angmarim cache in the ruins of Agamaur'),
        explore(760, -110, 20, 'Explore the ruins of Agamaur'),
        fish(3, 'fs_lonelands_tarn', 'Catch three fish from the Weather Hills Tarn for the Eglain'),
      ],
      rewards: { items: ['pot_heal_elixir', 'bait_minnow', 'food_ranger_stew', 'scroll_tactics_10'] },
      intro: "I am Hunwald, Elder of the Eglain, and Ost Guruth is the last roof my people have. Candaith has told me of Hwaldan, and I can tell you where he has been: Agamaur, the old ruin north of here, where his riders kept a cache before they went north. Search it. The wargs of the eastern hills answer to pack-leaders that Angmar bred, and they have been taking our ponies; kill the leaders and the packs will scatter. And if you would earn the Eglain's friendship and not only their thanks, bring Grimwynn fish from the tarn. My people are hungry.",
      accept: "I'll search Agamaur and feed the Eglain.",
      progress: "Slay the warg pack-leaders in the eastern hills, search the cache in the ruins of Agamaur to the north, and catch three fish from the Weather Hills Tarn for Grimwynn.",
      complete: "Fish! Real fish, from the tarn, and the wargs' leaders dead. You have fed my people twice over. The cache at Agamaur: empty, but for a map, aye? Hunwald guessed as much. Everything Hwaldan gathered has gone north across the hills, to the North Downs, and the map shows where: Trestlebridge, the bridge-town, and beyond it the ruins of Fornost. The Eglain cannot follow. But we can send a warning.",
      summary: "Slay the warg pack-leaders, search the Angmarim cache in the ruins of Agamaur and bring fish from the tarn to the Eglain.",
      hint: "Agamaur is the ruin north of Ost Guruth; the tarn lies south of the fortress and the warg dens are in the hills to the south-east.",
    }),
    S(44, {
      name: 'North to Trestlebridge', zone: 'northdowns', giver: 'npc_ostguruth_hunwald', turnin: 'npc_trestlebridge_reeve',
      objectives: [
        deliver('qa_letter_hunwald', 'npc_trestlebridge_reeve', 'Bring Hunwald\'s warning to Odo Trestlewood, Reeve of Trestlebridge'),
        kill('northdowns_orc', 6, 'Cut down the orcs of Dol Dínen on the road north'),
        explore(150, -480, 15, 'Explore the Trestlespan'),
      ],
      rewards: { items: ['pot_heal_elixir', 'pot_power_elixir', 'food_ranger_stew', 'n_cloak_grey_company'] },
      intro: "Trestlebridge is the town at the great bridge over the gorge of the Nen Harn, north of Bree, and the only road into the North Downs runs across it. If Hwaldan gathers his army at Fornost, the Trestlespan is the first thing it will come to. Carry my warning to Odo Trestlewood, the Reeve there; go back along the Road to Bree and take the Greenway north. The orcs of Dol Dínen are already on that road, and the Reeve will not believe the warning unless you bring him a few of their heads. Look at the bridge when you come to it; it is a wonder, and it may not stand long.",
      accept: "North to Trestlebridge, then.",
      progress: "Return west to Bree and follow the Greenway north to Trestlebridge. Cut down the orcs on the road, look at the Trestlespan, and give Hunwald's warning to the Reeve.",
      complete: "Orcs of Angmar, marching under a pale banner, and the Eglain elder sends me word of it by a stranger. Well, the stranger has orc-blood on his boots and a Ranger's cloak on his back, so I'll believe him. We have seen them: they come out of Dol Dínen east of the bridge every night now and test the watch. Wilfrid, my bridge-captain, has been begging me for a fighter. It seems the wind has blown one in.",
      summary: "Carry Hunwald's warning north to the Reeve of Trestlebridge, cutting down the orcs on the Greenway and scouting the Trestlespan.",
      hint: "Go west to Bree, then north along the Greenway to Trestlebridge at the gorge; the orcs hold the road east of the bridge.",
    }),
    S(45, {
      name: 'Trestlebridge Besieged', zone: 'northdowns', giver: 'npc_trestlebridge_captain', turnin: 'npc_trestlebridge_captain',
      objectives: [
        kill('northdowns_orc', 8, 'Break the orcs of Dol Dínen assaulting the bridge'),
        kill('northdowns_warg', 5, 'Slay the wargs that harry the bridge-watch'),
        collectNode('mat_iron_ore', 4, 'gn_northdowns_1', 'Mine iron ore for the Bridge Smithy'),
      ],
      rewards: { choose: gear('ranger', 'shoulder'), items: ['pot_heal_elixir', 'pot_power_elixir'] },
      intro: "They came last night with ladders, forty of them, and we held the bridge with eleven men and a boy. I am not a soldier, I am a bridge-captain, and I am telling you plainly that Trestlebridge falls the next time they come in force. The orcs gather at Dol Dínen east of here; if you strike at them there, they will not come tonight. The wargs harry my watchmen on the walls, and Gunnar the smith has no iron for arrow-heads; there is ore in the hills east of the bridge, if someone can hold the ground long enough to dig it.",
      accept: "The bridge will hold.",
      progress: "Strike at the orcs gathering at Dol Dínen east of Trestlebridge, slay the wargs harrying the walls and mine iron ore in the hills for the smithy.",
      complete: "They did not come tonight. For the first time in a fortnight I have slept, and the men are sharpening arrow-heads out of your ore as we speak. Reeve Trestlewood says the Rangers of Esteldín should know what is happening here, and I say the Rangers should have been here a month ago; but we are both right. Dol Dínen is where the orcs get their orders. If you can find those orders, Halbarad at Esteldín will read them.",
      summary: "Strike at the orcs of Dol Dínen and the wargs harrying Trestlebridge, and mine iron ore for the Bridge Smithy.",
      hint: "Dol Dínen and the ore-hills lie east of Trestlebridge; the wargs run in the downs to the south-east of the bridge.",
    }),
    S(46, {
      name: 'Dol Dínen', zone: 'northdowns', giver: 'npc_trestlebridge_captain', turnin: 'npc_esteldin_halbarad',
      objectives: [
        explore(480, -500, 20, 'Enter the orc-camp of Dol Dínen'),
        collectFrom('qa_orc_warplans', 3, 'northdowns_orc', 'Seize the orcs\' war-plans'),
        kill('northdowns_bear', 5, 'Kill the bears the orcs have driven towards the bridge'),
      ],
      rewards: { items: ['pot_heal_elixir', 'pot_power_elixir', 'food_ranger_stew', 'n_javelin_esteldin'] },
      intro: "Dol Dínen was a Dúnedain watch-post once; now it is an orc-camp with a stockade and a chieftain who takes his orders from Fornost. Go in, take whatever plans and maps their captains carry, and get out again. The orcs have been driving the downs-bears west towards the bridge to wear down my hunters; deal with the beasts as you find them. When you have the plans, take them east along the road to Esteldín, the Rangers' hidden refuge in the hills. Halbarad commands there. Tell him Trestlebridge sent you, and tell him it is late.",
      accept: "I'll bring Halbarad the orcs' plans.",
      progress: "Enter Dol Dínen east of Trestlebridge, seize the orcs' war-plans and kill the bears driven towards the bridge. Then follow the road east to Halbarad at Esteldín.",
      complete: "Wilfrid is right, and it is late; I have had too few Rangers and too many miles. These plans are Angmar's, drawn at Carn Dûm and marked with a pale hand: Trestlebridge, then the Greenway, then Bree. Hwaldan does not want the North Downs, he wants a road south, and he wants the dead of Fornost to march on it. You have carried a wight's seal, broken a barrow and taken Weathertop. I could use such a one, Barrow-breaker, and so could the North.",
      summary: "Enter Dol Dínen, seize the orcs' war-plans and kill the bears driven towards the bridge, then carry the plans to Halbarad at Esteldín.",
      hint: "Dol Dínen is the orc-camp east of Trestlebridge; Esteldín lies further east along the road into the hills.",
    }),
    S(47, {
      name: 'The Hidden Gate', zone: 'northdowns', giver: 'npc_esteldin_halbarad', turnin: 'npc_esteldin_meneldir',
      objectives: [
        talk('npc_esteldin_berethor', 'Consult Berethor, Lore-warden of Esteldín'),
        kill('downs_spider', 6, 'Clear the spiders from the hills below Esteldín'),
        collectNode('mat_athelas', 4, 'gn_northdowns_2', 'Gather athelas from the vale of Nan Amlug'),
        explore(350, -680, 15, 'Explore the Hidden Gate of Esteldín'),
      ],
      rewards: { items: ['pot_heal_elixir', 'pot_power_elixir', 'food_ranger_stew', 'n_gloves_archer'] },
      intro: "Before we strike at Fornost, you must know what we face, and Berethor our lore-warden knows more of the dead city than any man living; speak with him. Esteldín's safety is its secrecy: the Hidden Gate below the refuge is the only way in, and the spiders that have crept up from the hills have begun to web it, which will draw eyes. Clear them. Meneldir is gathering supplies for the march and asks for athelas from Nan Amlug, the vale west of here, where it grows better than anywhere in the North. Bring what you can to him.",
      accept: "I'll make ready for Fornost.",
      progress: "Speak with Berethor, clear the spiders from the hills below Esteldín, gather athelas in Nan Amlug to the west and look at the Hidden Gate. Report to Meneldir.",
      complete: "Athelas from Nan Amlug, and the gate clear of webs. You work quickly. Berethor told you of Fornost, then: the city of the last kings, sacked by the Witch-king and left to the dead. The wights there are the old army of Arthedain, and they are what Hwaldan means to wake, as he meant to wake Sambrog. But the wights are stirring already, and they are gathering in Nan Amlug at night. I want to know why.",
      summary: "Consult the lore-warden, clear the Hidden Gate of spiders and gather athelas in Nan Amlug for the march on Fornost.",
      hint: "Berethor stands in Esteldín; the Hidden Gate is below the refuge to the south-west, and Nan Amlug is the vale to the west.",
    }),
    S(48, {
      name: 'Nan Amlug', zone: 'northdowns', giver: 'npc_esteldin_meneldir', turnin: 'npc_esteldin_berethor',
      objectives: [
        kill('fornost_wight', 6, 'Lay the wights of Fornost to rest in Nan Amlug'),
        collectFrom('junk_barrow_relic', 4, 'fornost_wight', 'Take the relics of the kings the wights are carrying'),
        explore(80, -780, 20, 'Explore the vale of Nan Amlug'),
      ],
      rewards: { choose: gear('annuminas', 'chest'), items: ['pot_heal_elixir', 'pot_power_elixir'] },
      intro: "The wights come down out of Fornost by night and walk the vale of Nan Amlug, and they carry things: relics from the tombs of the kings, crowns and rings and broken swords. They are bringing them somewhere. Go into the vale west of here, lay to rest what wights you find, and take from them what they carry; Berethor will know what the relics are and why Hwaldan wants them gathered. And look about the vale. If they have a meeting-place there, I want to know it.",
      accept: "I'll go into Nan Amlug.",
      progress: "Go west into the vale of Nan Amlug. Lay the wights of Fornost to rest, take the relics they carry and explore the vale. Bring the relics to Berethor.",
      complete: "Relics of Arthedain, every one: the signet of Arveleg, a shard of Araphant's shield. Hwaldan is gathering the regalia of the North-kingdom, and the wights carry it because living men cannot bear to. I understand now. He means to crown a king of the dead in Fornost, and the shards you took from Weathertop were to be its crown. Without them he is not finished. But he will not stop, and Halbarad will not wait.",
      summary: "Lay the wights of Fornost to rest in Nan Amlug and take from them the relics of the kings they carry.",
      hint: "Nan Amlug is the vale west of Esteldín; the wights walk there by night.",
    }),
    S(49, {
      name: 'The Dead City', zone: 'northdowns', giver: 'npc_esteldin_halbarad', turnin: 'npc_esteldin_halbarad',
      objectives: [
        kill('uruk_fornost', 8, 'Break the Uruk garrison at the gates of Fornost'),
        kill('uruk_champion_fornost', 3, 'Cut down the Uruk champions in the King\'s Court'),
        collectNode('q_ancient_tome', 3, 'gn_northdowns_3', 'Recover the ancient tomes from the library of Fornost'),
        explore(250, -960, 25, 'Explore the ruins of Fornost Erain'),
      ],
      rewards: { items: ['pot_heal_elixir', 'pot_power_elixir', 'food_ranger_stew', 'n_helm_fornost'] },
      intro: "Fornost Erain, the North-kingdom's last city, lies north of Esteldín beyond the downs. Hwaldan holds it with Uruks out of Carn Dûm, the Witch-king's own soldiers, and his war-chief Bûrzghâsh commands them from the King's Court. We will go together, the Grey Company and you, but we are too few to storm the city; you must break the garrison at the gate while we hold the road. Then go into the ruins. The old library of the kings still stands, and the tomes in it are what Hwaldan reads by night; take them, and we take his lore from him.",
      accept: "To Fornost, with the Grey Company.",
      progress: "Go north from Esteldín to Fornost Erain. Break the Uruk garrison at the gates, cut down the champions in the King's Court, recover the tomes from the library and explore the ruins.",
      complete: "The gate is ours and the Grey Company stands in Fornost for the first time in a thousand years. These tomes: the rites of the Witch-king's necromancers, copied in Hwaldan's own hand, with a date scratched in the margin. Tomorrow. He means to work the crowning tomorrow, shards or no shards, and Bûrzghâsh guards him in the King's Court. There is no more time for scouting.",
      summary: "March on Fornost with the Grey Company: break the Uruk garrison, cut down the champions and recover the necromancers' tomes.",
      hint: "Fornost Erain lies north of Esteldín beyond the downs; the library and the King's Court are in the heart of the ruins.",
    }),
    S(50, {
      name: 'The Pale Hand Revealed', zone: 'northdowns', giver: 'npc_esteldin_halbarad', turnin: 'npc_esteldin_halbarad',
      objectives: [
        killboss('boss_burzghash', 'Slay Bûrzghâsh, War-chief of Fornost, in the King\'s Court'),
        use('gn_northdowns_5', 1, 'Break open Hwaldan\'s treasury in the King\'s Court'),
      ],
      rewards: { choose: gear('annuminas', 'legs'), items: ['pot_heal_elixir', 'pot_power_elixir', 'food_ranger_stew', 'n_pocket_ranger'], title: 'Watcher of Weathertop' },
      intro: "This is the hour. Bûrzghâsh holds the King's Court with the last of the Uruks, and Hwaldan works his rite behind him; if the war-chief falls, the Pale Hand has no shield. I will hold the stair with the Grey Company. You go in. Kill Bûrzghâsh, break open the treasury where Hwaldan keeps the regalia of Arthedain, and whatever you find there, bring it out into the light. The dead of Fornost have waited a thousand years for the North-kingdom to come back for them. Let us not keep them waiting longer.",
      accept: "For the North-kingdom.",
      progress: "Enter the King's Court in the heart of Fornost. Slay Bûrzghâsh the War-chief and break open Hwaldan's treasury.",
      complete: "Bûrzghâsh dead, the regalia of Arthedain recovered, and Hwaldan fled north in the night like the coward he is; his rite is broken and the dead of Fornost sleep. But look at what the treasury held: letters from Carn Dûm, and a map of Evendim, of Annúminas, the first capital of Arnor, where the tomb-robbers dig for the Witch-king even now. The Pale Hand is one servant among many, and his master's eye has turned to the lake. Rest tonight, Watcher of Weathertop. Tomorrow the road goes west to Tinnudir.",
      summary: "Storm the King's Court of Fornost with the Grey Company, slay Bûrzghâsh the War-chief and break open the Pale Hand's treasury.",
      hint: "The King's Court lies in the heart of the ruins of Fornost Erain, north of Esteldín; Hwaldan's treasury is beside it.",
    }),
  ];

  G.Data.quests.push.apply(G.Data.quests, Q);
  G.Data.questById = G.Data.questById || {};
  for (let i = 0; i < Q.length; i++) G.Data.questById[Q[i].id] = Q[i];
  if (typeof G.Data.registerQuests === 'function') G.Data.registerQuests(Q);
})();
