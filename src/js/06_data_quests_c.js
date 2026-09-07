/* ==== 06_data_quests_c.js — Side quests q001–q050 for Chris Jensen's Lord of the Rings Online (data only).
   Fifty self-contained local stories given by town flavour / vendor / fisher / guard NPCs (never the ★ hub story-givers),
   spread over all 15 zones (≈ 3–4 per mainland zone, 2–3 per island) at levels 2–78 (level = G.Data.xp.sideLevel(i),
   ascending by id). Schema per SPEC §4.7; every npc / monster / boss / node / spot / poi id is a 05_data_world id, every
   reward item id is a 03_data_items id. Ten quest-specific items (ids `qc_*`) are registered here with G.Data.addItem
   before the quests. At most ten quests carry a story prerequisite (a lower-level story quest) — the Sundered-Isles side
   quests wait for s089, a few others for the first quest of their Book.
   Public API: pushes onto G.Data.quests; calls G.Data.registerQuests(list) when 24_quests / another data module defines it.
   Objective-type census (checked by tools/scratch/quests_c_check.js): kill 33 · collect-from 14 · collect-node 14 · use 4 ·
   talk 11 · explore 21 · deliver 5 · fish 8 · killboss 3 (halgar, ugruk, ardaric — never the final boss). ==== */
(function () {
  'use strict';
  const G = window.G; G.Data = G.Data || {}; G.Data.quests = G.Data.quests || [];
  const X = G.Data.xp; // X.questXP(level,'side'), X.goldReward(level,'side'), X.sideLevel(i)
  const L = (i) => X.sideLevel(i);
  const R = (level, items, extra) => {
    const r = { xp: X.questXP(level, 'side'), gold: X.goldReward(level, 'side'), items: items || [] };
    if (extra) for (const k in extra) r[k] = extra[k];
    return r;
  };

  // ---------------------------------------------------------------- quest-specific items (deliver / collect-from props)
  const QI = [
    ['qc_sally_tincture', "Sally's Athelas Tincture", '🧴', 'A stoppered green bottle. It smells of kingsfoil and something sharper. For Widow Oakheart of Staddle.'],
    ['qc_forsaken_cask', 'Cask of Forsaken Ale', '🛢', 'A small oak cask stamped with the sign of the Forsaken Inn. The goblins had not yet worked out the bung.'],
    ['qc_sam_parcel', "Sam Twofoot's Parcel", '📦', 'A parcel wrapped in oilcloth and tied with a great deal of string. Addressed, in careful capitals, to HAGAR, OST GURUTH.'],
    ['qc_pedlar_wares', 'Stolen Pedlar-wares', '🧺', 'Buttons, needles, ribbons, a tin whistle and a pot of salve — everything a pedlar carries, everything a bandit does not need.'],
    ['qc_bear_haunch', 'Haunch of Downs Bear', '🍖', 'A heavy haunch of bear-meat, wrapped in leaves. Mirwen will know what to do with it.'],
    ['qc_ranger_rations', "Ranger's Ration-bag", '🎒', 'Hard bread, dried apple, smoked meat and a twist of salt, packed tight by Mirwen for the eastern sentry.'],
    ['qc_annuminas_tablet', 'Inscribed Tablet of Annúminas', '🪨', 'A palm-sized slab of pale stone, cut with the letters of the North-kingdom. The tomb-robbers meant to sell it in Bree.'],
    ['qc_aoife_charm', "Aoife's Bone Charm", '🧿', 'A little charm of bone and red thread, made by a hillman child for her brother. It wants a blessing.'],
    ['qc_salt_sack', 'Sack of Hillman Salt', '🧂', 'Grey salt from the pans of the Trév Gállorg, scattered a little by orc-handling but still good.'],
    ['qc_trade_ledger', "Pekka's Trade-ledger", '📒', 'A sealskin-bound ledger of everything Sûri-kylä owes and is owed. The ice-pilot needs it before the bay freezes.'],
  ];
  if (typeof G.Data.addItem === 'function') {
    for (const q of QI) if (!G.Data.items || !G.Data.items[q[0]]) G.Data.addItem({ id: q[0], name: q[1], type: 'quest', subtype: 'quest', slot: null, level: 1, rarity: 'common', stats: {}, dmg: null, value: 0, maxStack: 20, icon: q[2], iconBg: 0x4a3a2a, desc: q[3] });
  }

  // ---------------------------------------------------------------- the quests
  const Q = [
    // ---- q001 L2 · The Shire · Holman Greenhand, gardener of Hobbiton
    { id: 'q001', name: 'Slugs in the Cabbages', type: 'side', level: L(1), zone: 'shire', giver: 'npc_hobbiton_holman', turnin: 'npc_hobbiton_holman', prereq: [],
      objectives: [
        { type: 'kill', target: 'garden_slug', count: 6, label: 'Squash the garden slugs in the fields below Hobbiton' },
        { type: 'collect', item: 'mat_mushroom', count: 3, from: null, node: 'gn_shire_2', label: 'Gather wild mushrooms from the patch east of the Water' },
      ],
      rewards: R(L(1), ['n_gloves_hobbiton', 'food_seedcake']),
      summary: "Holman Greenhand's cabbages are being eaten by slugs the size of a hobbit's fist. Clear the fields, and bring him a few mushrooms for his trouble.",
      hint: 'The slugs crawl in the low fields south-west of Hobbiton and along the Bywater road; the mushroom patch is east of the Water, past the spider hedges.',
      text: {
        intro: "Slugs! I have gardened these forty years and never seen the like — fat as my thumb and twice as greedy. Half the cabbages in the lower field are lace by morning, and old Mr. Bilbo's roses are next, you mark me. If you have a stout pair of boots and no great love for slugs, I would count it a kindness. And while you are out that way, the mushrooms by the Water are coming up something lovely.",
        accept: 'Mind the salt in your pocket, and mind you do not tread on the seedlings.',
        progress: 'Still chewing, are they? The lower field is where they gather thickest, down towards Bywater.',
        complete: "Now that is what I call a morning's work. There is not a slug left between here and the Hill, and the cabbages may yet see a pot. Take these gloves — they were my father's, and they have never once failed a potato.",
      } },

    // ---- q002 L4 · Ered Luin · Faelas, harper of the Haven's Rest
    { id: 'q002', name: 'Three Flowers for a Song', type: 'side', level: L(2), zone: 'eredluin', giver: 'npc_celondim_faelas', turnin: 'npc_celondim_faelas', prereq: [],
      objectives: [
        { type: 'collect', item: 'mat_moonflower', count: 3, from: null, node: 'gn_eredluin_5', label: 'Gather moonflowers from the cliff-meadow above Celondim' },
        { type: 'kill', target: 'grey_wolf_eredluin', count: 4, label: 'Drive off the Blue Mountain wolves that haunt the meadow' },
      ],
      rewards: R(L(2), ['pot_heal_salve', 'pot_power_tonic']),
      summary: 'The harper Faelas cannot finish his song without three moonflowers from the meadow above the haven — and the wolves there have grown bold.',
      hint: 'The moonflower patch is on the slope north-west of the haven, towards the falls; the wolves den a little east of it, above the road to Duillond.',
      text: {
        intro: "Forgive me — I was searching for a word, and it fled when you came in. I am composing a lay of the Falls of Falathlorn, and it wants three moonflowers laid on the harp while I play, for that is the old fashion and the song will not come otherwise. They open on the cliff-meadow above the haven, but the grey wolves have come down from the heights this spring and I am a harper, not a huntsman. Would you go? Three flowers, no more, and a little peace on the meadow.",
        accept: 'Take the path above the haven; you will smell the flowers before you see them.',
        progress: 'The flowers close at dawn — pick them while they are open, and let the wolves worry about themselves.',
        complete: "Ah — there it is. Do you hear it? No, of course you do not, it is only in my head yet, but it is there. Three moonflowers, and the wolves gone quiet: the lay of Falathlorn will have a verse for you, friend, whether you like it or not.",
      } },

    // ---- q003 L5 · The Shire · Daisy Boffin, cook at the Green Dragon
    { id: 'q003', name: 'The Bywater Pie Contest', type: 'side', level: L(3), zone: 'shire', giver: 'npc_bywater_food', turnin: 'npc_bywater_food', prereq: [],
      objectives: [
        { type: 'fish', count: 5, spot: 'fs_bywater_pool', label: 'Catch five fish from the Bywater Pool for the pie' },
        { type: 'talk', npc: 'npc_bywater_innkeeper', label: 'Tell Ivo Goodchild the contest is on' },
      ],
      rewards: R(L(3), ['food_mushroom_pie', 'bait_bread'], { title: 'Pie-master of Bywater' }),
      summary: "Daisy Boffin means to win the Bywater pie contest with a fish pie, and she needs five fish from the Pool and an innkeeper's blessing to do it.",
      hint: 'The Bywater Pool is just west of the Green Dragon; cast from the reeds on its eastern bank. Ivo is behind the bar.',
      text: {
        intro: "The pie contest is Highday, and Lobelia Sackville-Baggins has entered — again — with that seed-cake she calls a pie, and this year I mean to beat her. Fish pie, that is the answer: perch and trout from the Pool, with a crust you could set a clock by. Only I cannot leave the kitchen and Hal has gone off to Hobbiton with his rod, the wretch. Bring me five good fish from the Bywater Pool, and tell Ivo behind the bar to put it about that the contest is on. He will grumble, but he will do it.",
        accept: "Perch, trout, carp — I am not particular, so long as they are fresh and there are five of them.",
        progress: 'Five fish, mind. Four is a pasty. And have you spoken to Ivo yet?',
        complete: "Look at them! Fat as butter, every one. Lobelia may keep her seed-cake and her opinions both — this pie will be talked of at the Green Dragon for a twelvemonth. Here, take the first slice, and the name that goes with it: I shall tell everyone it was your fish that won.",
      } },

    // ---- q004 L7 · Ered Luin · Gwaerion, net-mender of Celondim
    { id: 'q004', name: 'The Kheledûl Catch', type: 'side', level: L(4), zone: 'eredluin', giver: 'npc_celondim_fishing', turnin: 'npc_celondim_fishing', prereq: [],
      objectives: [
        { type: 'fish', count: 4, spot: 'fs_kheledul', label: 'Fish the Kheledûl shore north of the haven' },
        { type: 'explore', pos: { x: -1480, z: -560 }, radius: 16, label: 'Look over the ruined quays of Kheledûl' },
      ],
      rewards: R(L(4), ['bait_bread', 'fish_lune_herring', 'pot_heal_salve']),
      summary: 'Gwaerion wants to know whether the fish have come back to the drowned quays of Kheledûl, and whether the ruins are as empty as they look.',
      hint: 'Follow the shore north from the Celondim quay; the ruins stand where the cliffs fall to the water. Cast from the old quay-stones.',
      text: {
        intro: "You have the look of someone who does not mind wet feet. Good. The dwarves' old harbour at Kheledûl, north along the shore, was the best herring-water on this coast before it fell into the sea, and I have heard the fish are coming back to the drowned stones. I would go myself, but there is a season's worth of net on this bench. Take a rod up there, cast off the old quay, and tell me what bites — and what else is stirring in those ruins, for the bears have been seen.",
        accept: 'North along the water, past the falls. You cannot miss the ruins; the sea is wearing them.',
        progress: 'Four fish will tell me all I need to know. And keep your eyes open among the stones.',
        complete: "Herring, and sea-bass, and ice-cod that has no business this far south — the water is alive again. That is the best news I have had since the spring tides. Take some of my bait, and a fish for your supper; you have earned a dry evening by the fire.",
      } },

    // ---- q005 L8 · Bree-land · Gamel Ironside, smith of Combe
    { id: 'q005', name: 'Six Hides for the Smithy', type: 'side', level: L(5), zone: 'breeland', giver: 'npc_combe_gamel', turnin: 'npc_combe_gamel', prereq: [],
      objectives: [
        { type: 'collect', item: 'mat_boar_hide', count: 6, from: 'bree_boar', label: 'Take boar hides from the Bree-land boars' },
      ],
      rewards: R(L(5), ['pot_heal_salve', 'food_bree_bread', 'scroll_warding_10']),
      summary: 'Gamel Ironside has a stack of orders for leather-backed shields and not a hide in the shop. The boars west of Bree have plenty.',
      hint: 'Bree-land boars root in the fields west of Bree along the Greenway and south of the Greenway waystone; every one carries a hide while this quest is active.',
      text: {
        intro: "Every farmer from here to Staddle wants a shield with a boar-hide back, and every one of them wants it yesterday, and do I have a single hide in the place? I do not. The tanner has gone to Bree, the boars are getting fat on Thornley's turnips, and I am stood here with a hammer and nothing to hit. Bring me six good hides from the Bree-land boars and I shall see you right.",
        accept: 'Six hides. Whole ones, mind — I am not making purses.',
        progress: 'How many is that? The boars are thickest west of the town, along the Greenway.',
        complete: "Now those are hides. Thick as a door and twice as ugly, which is exactly what I want. Here, take this for your trouble, and if anyone in Staddle asks, their shields will be done by Highday — probably.",
      } },

    // ---- q006 L10 · The Shire · Nob Bracegirdle, stable-master of Hobbiton
    { id: 'q006', name: 'The Runaway Pony', type: 'side', level: L(6), zone: 'shire', giver: 'npc_hobbiton_nob', turnin: 'npc_hobbiton_nob', prereq: [],
      objectives: [
        { type: 'explore', pos: { x: -1180, z: 120 }, radius: 18, label: 'Search the ruffian camp at Waymeet for Buttercup' },
        { type: 'kill', target: 'bandit_ruffian', count: 6, label: 'Deal with the ruffians who took her' },
      ],
      rewards: R(L(6), ['food_seedcake', 'pot_heal_salve'], { mount: 'mount_shire' }),
      summary: "Buttercup, the best pony in Nob Bracegirdle's stable, was led off in the night — and the hoof-prints run south towards the ruffians at Waymeet.",
      hint: 'Waymeet lies south-west of Hobbiton across the fields. The ruffians camp in the old barns; scatter them and the pony will follow you home.',
      text: {
        intro: "Buttercup is gone. Best pony I ever had — dappled, sweet as a plum, fond of apples — and some ruffian led her off in the night with the gate wide open behind him. The prints run south across Hamson's fields towards Waymeet, where those Big Folk have been camping and calling themselves a 'company'. I would go after her myself, but a stable-master with a cudgel is not much of a threat. Find her, and give those ruffians something to think about.",
        accept: 'South across the fields. She will come to a whistle, if she is not too frightened.',
        progress: 'Any sign of her? Waymeet is the old barns south-west of here, where the road forks.',
        complete: "Buttercup! Oh, look at her — not a scratch, and she has eaten half your cloak by the look of it. I said I would see you right, and I meant it: she is yours. No, no argument. She has chosen you, and I know better than to argue with a pony.",
      } },

    // ---- q007 L11 · Ered Luin · Sigrún Ore-sifter, miner of Thorin's Hall
    { id: 'q007', name: 'The Missing Ore-cart', type: 'side', level: L(7), zone: 'eredluin', giver: 'npc_thorinshall_sigrun', turnin: 'npc_thorinshall_sigrun', prereq: [],
      objectives: [
        { type: 'explore', pos: { x: -1450, z: -1150 }, radius: 16, label: 'Find the ore-cart at the mouth of Sarnûr' },
        { type: 'kill', target: 'cave_crawler', count: 6, label: 'Clear the cave-crawlers from the Sarnûr seam' },
        { type: 'collect', item: 'mat_dwarf_iron', count: 4, from: null, node: 'gn_eredluin_2', label: 'Recover dwarf-iron ore from the seam' },
      ],
      rewards: R(L(7), ['n_axe_thorin', 'pot_heal_salve']),
      summary: "Sigrún's ore-cart never came back from the Sarnûr seam west of Thorin's Hall. The crawlers have the tunnels, and the ore is still down there.",
      hint: 'Sarnûr is the cave-mouth west-south-west of the Hall. The crawlers nest at its mouth; the iron seam is just south of it, along the cliff.',
      text: {
        intro: "Three days ago I sent the cart down to the Sarnûr seam with two ponies and my cousin Frithi, and three days ago it did not come back. Frithi turned up yesterday with a bitten leg and a story about crawlers 'as big as the cart', which I do not believe, and no ore, which I do. That seam is the best dwarf-iron this side of the mountains and I will not lose it to a nest of shell-backed vermin. Find the cart, clear the tunnel, and bring me what ore you can carry.",
        accept: 'West of the Hall, past the watch-tower. Follow the cart-ruts; they stop where the trouble starts.',
        progress: 'Frithi says the crawlers come out of the rock itself. Frithi says a great many things.',
        complete: "Four lumps of dwarf-iron and the cart found — and the crawlers, by the sound of it, rather smaller than they were. Náin will forge that ore into something worth having. This axe came off the same anvil; it is yours, and I will hear no more about crawlers as big as carts.",
      } },

    // ---- q008 L13 · Bree-land · Sally Thistlewood, herbalist of Bree
    { id: 'q008', name: 'Kingsfoil for the Widow', type: 'side', level: L(8), zone: 'breeland', giver: 'npc_bree_sally', turnin: 'npc_bree_sally', prereq: [],
      objectives: [
        { type: 'collect', item: 'mat_athelas', count: 5, from: null, node: 'gn_breeland_1', label: 'Gather athelas from the Bree-hill hedgerows' },
        { type: 'deliver', item: 'qc_sally_tincture', npc: 'npc_staddle_oakheart', label: "Carry Sally's tincture to Widow Oakheart in Staddle" },
      ],
      rewards: R(L(8), ['scroll_fortitude_10', 'pot_heal_salve', 'food_bree_bread']),
      summary: "Sally Thistlewood's stock of kingsfoil is gone and Widow Oakheart's chest is bad again. Gather athelas from the hedgerows and carry the tincture south to Staddle.",
      hint: 'Athelas grows in the hedgerows on the hill west of Bree, above the Greenway. Widow Oakheart cooks at the south end of Staddle, down the road from the south gate.',
      text: {
        intro: "Widow Oakheart's chest is bad again — every winter it is the same — and I have used the last of my kingsfoil on that fool of a Ferny and his dog-bite. There is athelas in the hedgerows on the hill west of town, if you know a leaf from a nettle, and I will need five good sprigs of it. Meanwhile, take this tincture to her in Staddle; it is the last of the old batch and it will hold her until I can brew more. Be gentle with her. She is prouder than she is well.",
        accept: 'Five sprigs of kingsfoil — long leaves, sweet smell. And do not let the tincture freeze.',
        progress: 'Has the widow had her tincture? And mind the spiders on the hill; they like the hedgerows as much as the athelas does.',
        complete: "That is kingsfoil, and good kingsfoil too — the true leaf, with the sweetness in it. She took the tincture? And was rude to you? Good, then she is mending. Here is a scroll I have no use for and a loaf I have too many of, and my thanks, which are worth more than either.",
      } },

    // ---- q009 L14 · Ered Luin · Hafgrim Ponymaster, stable-master of Thorin's Hall
    { id: 'q009', name: 'A Pony for the Mountain Road', type: 'side', level: L(9), zone: 'eredluin', giver: 'npc_thorinshall_hafgrim', turnin: 'npc_thorinshall_hafgrim', prereq: [],
      objectives: [
        { type: 'collect', item: 'mat_bear_pelt', count: 4, from: 'black_bear_eredluin', label: 'Take pelts from the black bears of the lower vales' },
        { type: 'explore', pos: { x: -1250, z: -1200 }, radius: 18, label: 'Walk the Vale of Thráin to test the pony-road' },
      ],
      rewards: R(L(9), ['pot_heal_draught', 'food_roast_boar'], { mount: 'mount_dwarf' }),
      summary: 'Hafgrim needs bear-pelts for winter saddle-blankets and a rider to prove the road through the Vale of Thráin is fit for ponies again.',
      hint: 'Black bears den in the vales south of the Hall along the Duillond road. The Vale of Thráin is north-west of the Hall, beyond the Sarnûr cliffs.',
      text: {
        intro: "You look like you can sit a saddle, which is more than I can say for most who come through that door. I have a black pony in the end stall — mountain-bred, strong enough to carry a dwarf in full mail — and no rider fit for him. Two things and he is yours. First, four bear-pelts from the vales south of here, for I will not send a pony into the snows without a proper blanket. Second, ride the Vale of Thráin and tell me whether the road is clear; nobody has been up it since the thaw.",
        accept: 'The bears are south, on the Duillond road. The Vale is north-west. Do not confuse them.',
        progress: 'Four pelts, and the Vale walked end to end. A pony is not given for less.',
        complete: "Four pelts, and the Vale clear to the high cairn — you have done in a day what my lads would have taken a week over. The black pony is yours, then, as I said. Treat him well; he is worth more than you are, and he knows it.",
      } },

    // ---- q010 L16 · The Old Forest · Goldberry, the River-daughter
    { id: 'q010', name: 'Wood for the Bonfire Glade', type: 'side', level: L(10), zone: 'oldforest', giver: 'npc_tomshouse_goldberry', turnin: 'npc_tomshouse_goldberry', prereq: [],
      objectives: [
        { type: 'collect', item: 'mat_ash_branch', count: 4, from: null, node: 'gn_oldforest_3', label: 'Gather ash branches in the Bonfire Glade' },
        { type: 'kill', target: 'old_forest_spider', count: 5, label: 'Clear the spiders that have webbed the glade' },
      ],
      rewards: R(L(10), ['n_boots_wanderer', 'food_mushroom_pie']),
      summary: 'Goldberry would have a fire lit in the Bonfire Glade as in the old days, but the spiders have made the glade their own and the wood will not gather itself.',
      hint: 'The Bonfire Glade lies south-west of the house, a clearing of dead ash among the trees. The spiders come from the east, along the Withywindle.',
      text: {
        intro: "Do you hear the trees? They are muttering; they always mutter when the year turns. In the old days Tom would light a fire in the Bonfire Glade to remind them who is master here, and they would be quiet for a season. But the spiders have webbed the glade from bough to bough and I would not have Tom walk into that, for all his songs. Gather four good branches of ash from the glade and send the spiders back into the dark, and we shall have our fire.",
        accept: 'The glade is south and west, where the ash-trees died. Take no wood that is still alive.',
        progress: 'Ash, not willow — willow will not burn, and it would not thank you for trying.',
        complete: "You smell of smoke and web already; the glade is yours, then. Tom will sing the fire tonight and the trees will remember their manners. These boots came down the river on a raft, a long while ago, and never found their feet. Perhaps they have found them now.",
      } },

    // ---- q011 L18 · Chetwood & Midgewater · Old Meg, herbalist of the hunters' camp
    { id: 'q011', name: 'Marsh-water Remedy', type: 'side', level: L(11), zone: 'souththicket', giver: 'npc_chetwoodcamp_meg', turnin: 'npc_chetwoodcamp_meg', prereq: [],
      objectives: [
        { type: 'collect', item: 'junk_slug_slime', count: 4, from: 'marsh_slug', label: 'Collect slime from the bog-slugs of the Midgewater' },
        { type: 'collect', item: 'mat_athelas', count: 3, from: null, node: 'gn_souththicket_1', label: 'Gather athelas from the marsh-edge' },
      ],
      rewards: R(L(11), ['pot_heal_draught', 'bait_cricket', 'mat_athelas']),
      summary: "Old Meg's remedy for marsh-fever wants bog-slug slime and kingsfoil, and she is too old to go wading for either.",
      hint: 'The bog-slugs wallow in the eastern marsh north of the Midgewater; the athelas grows on the drier ground just west of them.',
      text: {
        intro: "Half the camp has the marsh-fever and the other half will have it by the new moon, and Hugo Blackthorn thinks a hot toddy will cure it. It will not. Slug-slime and kingsfoil, boiled together and drunk holding your nose — that cures it, and I have neither. The bog-slugs are out east where the marsh is deepest, and the athelas grows on the hummocks just this side of them. Bring me four good scrapings of slime and three sprigs of the leaf, and try not to fall in.",
        accept: 'Slime from the slugs, leaf from the hummocks. Do not mix them up; you would know if you did.',
        progress: 'Four slimes and three sprigs. And wipe your boots before you come in.',
        complete: "Ugh — yes, that is the stuff, and fresh. The pot will be on by nightfall and the fever gone by the week's end, and not one of those hunters will thank me for it. You may have a draught of the last batch, and some crickets I was keeping for no good reason.",
      } },

    // ---- q012 L19 · Bree-land · Watchman Hob of the east gate
    { id: 'q012', name: "The Enforcer's Toll", type: 'side', level: L(12), zone: 'breeland', giver: 'npc_bree_guard_e', turnin: 'npc_bree_guard_e', prereq: [],
      objectives: [
        { type: 'kill', target: 'blackwold_enforcer', count: 3, label: 'Break the Blackwold enforcers at their lookout east of Bree' },
        { type: 'use', node: 'gn_breeland_4', count: 1, label: 'Search the Blackwold stash for the stolen toll-box' },
      ],
      rewards: R(L(12), ['pot_heal_draught', 'scroll_warding_10']),
      summary: "Blackwold enforcers have set up a lookout on the East Road and are charging their own 'toll' — with Bree's own toll-box, stolen from the gatehouse.",
      hint: 'The lookout is on the rise east of the gate, north of the road; the stash is a little further east, by the ruins of Skirmish Hill.',
      text: {
        intro: "See that rise east of the gate? Three Blackwolds have sat on it for a week stopping carts and calling it a toll, and yesterday one of them held up my own toll-box — the brass one, with the pony on the lid — and laughed at me. The Constable says wait for the Mayor, and the Mayor says wait for the Constable. I say a person with a good sword and no patience could settle it before supper. Break their lookout and find where they have stashed the box.",
        accept: 'They are big, but they are three, and they are not expecting anybody to argue.',
        progress: 'The box has a pony on the lid. If you find a box without a pony on the lid, it is not the box.',
        complete: "The box — and the pony on the lid, and eleven silver still in it, which is nine more than I expected. I shall tell the Constable it was found by the Watch, if that is all the same to you, and you may have the thanks of the Watch and this from under my own bunk.",
      } },

    // ---- q013 L21 · Chetwood & Midgewater · Whistler Pip, hobbit fiddler
    { id: 'q013', name: "The Hunters' Song", type: 'side', level: L(13), zone: 'souththicket', giver: 'npc_chetwoodcamp_pip', turnin: 'npc_chetwoodcamp_pip', prereq: [],
      objectives: [
        { type: 'talk', npc: 'npc_chetwoodcamp_hugo', label: 'Hear the tale of Hugo Blackthorn the trapper' },
        { type: 'talk', npc: 'npc_chetwoodcamp_dodd', label: 'Hear the tale of Sentry Dodd' },
        { type: 'talk', npc: 'npc_chetwoodcamp_meg', label: 'Hear the tale of Old Meg' },
      ],
      rewards: R(L(13), ['n_pocket_map', 'food_roast_boar']),
      summary: 'Whistler Pip is writing a song about the Chetwood camp and needs three tales from three hunters who will not talk to a hobbit with a fiddle.',
      hint: 'Hugo is by the traps on the east side of camp, Dodd stands the west palisade, and Old Meg keeps her herb-tent at the south end.',
      text: {
        intro: "I am composing a song — the Hunters of the Chetwood, with a chorus you can stamp to — and the trouble is that I need it to be true, or at least true enough, and not one of these great grim hunters will tell a hobbit anything but 'go away, Pip'. You, though. You have a listening sort of face. Go and get a tale out of Hugo, one out of Dodd, and one out of Old Meg, and come back and tell me what they said. I will do the rhyming.",
        accept: 'Hugo will talk about traps, Dodd about wolves, and Meg about anything at all if you sit still long enough.',
        progress: 'Three tales! Did Dodd really say that? Well, I shall put it in anyway.',
        complete: "Wolves, and traps, and a fever that nearly took the whole camp in the Year of the Long Rain — oh, this is a song, this is a real song. It shall have your name in the fourth verse, in the bit that scans. Take this map; I found it in the lodge, and I cannot read it, and you look as though you could.",
      } },

    // ---- q014 L22 · Chetwood & Midgewater · Sentry Dodd
    { id: 'q014', name: 'Bounty: Halgar the Blackwold', type: 'side', level: L(14), zone: 'souththicket', giver: 'npc_chetwoodcamp_dodd', turnin: 'npc_chetwoodcamp_dodd', prereq: [],
      objectives: [
        { type: 'kill', target: 'chetwood_archer', count: 3, label: "Clear the Blackwold archers from their blind on the marsh-edge" },
        { type: 'killboss', boss: 'boss_halgar', label: 'Bring down Halgar the Blackwold at his camp' },
      ],
      rewards: R(L(14), ['scroll_battle_10', 'pot_heal_draught'], { title: 'Brigand-breaker of the Chetwood' }),
      summary: "Bree has put a price on Halgar the Blackwold's head. Sentry Dodd would rather it were collected by someone who is not him — and the archers' blind must go first.",
      hint: 'The archers hide in a blind at the eastern edge of the marsh, north of the Midgewater. Halgar holds the Blackwold camp south of the hunters’ camp, in the deep wood.',
      text: {
        intro: "The Mayor of Bree has posted a bounty on Halgar the Blackwold — thirty silver and no questions — and I have stood on this palisade every night since it went up, thinking about thirty silver. Then I think about Halgar. He has a camp south of here in the deep wood, and a blind of archers out on the marsh-edge that puts an arrow in anything that goes near him. Clear the blind first, then take him, and the bounty is yours. I will settle for having slept.",
        accept: 'Archers first. Halgar second. Any other order and there will be no third.',
        progress: 'Is he down? You would know if he were; the wood goes quiet.',
        complete: "Halgar the Blackwold, dead in his own camp, and the blind burned out. I have not heard an arrow all night. The Mayor's silver is yours and so is the name — they are already calling you the brigand-breaker down at the fire, and I did not start it. Well. I did not start all of it.",
      } },

    // ---- q015 L24 · The Old Forest · Tobold Boffin, lost hobbit
    { id: 'q015', name: "Tobold's Mushroom Foraging", type: 'side', level: L(15), zone: 'oldforest', giver: 'npc_tomshouse_lost', turnin: 'npc_tomshouse_lost', prereq: [],
      objectives: [
        { type: 'collect', item: 'mat_mushroom', count: 5, from: null, node: 'gn_oldforest_1', label: 'Gather mushrooms from the hollow east of the house' },
        { type: 'kill', target: 'old_forest_wolf', count: 5, label: 'Drive the Old Forest wolves from the mushroom-hollow' },
      ],
      rewards: R(L(15), ['food_mushroom_pie', 'pot_heal_draught', 'bait_cricket']),
      summary: 'Tobold Boffin came into the Old Forest after mushrooms and has not dared leave Tom’s garden since. The mushrooms are still out there, and so are the wolves.',
      hint: 'The mushroom-hollow is east of the house across the Withywindle, under the old oaks. The wolves den just north of it.',
      text: {
        intro: "I only came in for mushrooms. That is the whole of it — there is a hollow east of here, over the river, where they come up as big as plates, and my aunt makes a pie with them that would make you weep. Then the trees moved, and the wolves came, and I ran, and Master Tom found me up a willow. I have been in this garden eleven days. If you could — I mean, if you were going that way anyway — five of them would do. And perhaps the wolves could be discouraged.",
        accept: 'Big ones, with brown caps. The white ones are for people you do not like.',
        progress: 'Five mushrooms and no wolves. Eleven days, you know. Twelve tomorrow.',
        complete: "Those are the ones! Look at the size — my aunt will not believe it. I feel quite brave now, actually; I may walk home tomorrow. Well, the day after. Here, have a pie, it is only a small one, and the crickets are Master Tom's, but he says the fish do not mind who they came from.",
      } },

    // ---- q016 L25 · The Old Forest · Goldberry (requires Book 3 to have begun)
    { id: 'q016', name: 'The Haunted Hollow', type: 'side', level: L(16), zone: 'oldforest', giver: 'npc_tomshouse_goldberry', turnin: 'npc_tomshouse_goldberry', prereq: ['s026'],
      objectives: [
        { type: 'explore', pos: { x: -600, z: 850 }, radius: 18, label: 'Enter the Haunted Hollow south of the house' },
        { type: 'kill', target: 'wight_barrow', count: 6, label: 'Lay the barrow-wights of the Hollow to rest' },
        { type: 'collect', item: 'junk_barrow_relic', count: 3, from: null, node: 'gn_oldforest_4', label: 'Recover relics of Cardolan from the Barrow' },
      ],
      rewards: R(L(16), ['n_neck_wight', 'pot_heal_draught']),
      summary: 'Something has woken in the Haunted Hollow south of Tom’s house. Goldberry would have the dead laid down again and the relics that draw them carried out of the barrow.',
      hint: 'The Hollow is south-west of the house, past the river. The wights walk the barrows to the east of it; the relics lie in the Barrow of Cardolan, further east still.',
      text: {
        intro: "The water tastes of iron this morning; it comes down from the Hollow, and something has been walking there that should be lying still. Tom laughs and says the dead are only cold, but I have seen the lights in the Hollow after dark, and the wights on the barrows beyond it, and I do not laugh. Someone has been digging in the Barrow of Cardolan and the relics there call to what sleeps. Go into the Hollow, put down what walks, and bring the relics out into the sun where they cannot be heard.",
        accept: 'Go by daylight if you can. If you cannot, sing; they dislike it.',
        progress: 'The water still tastes of iron. Are they lying down yet?',
        complete: "The water is sweet again. Do you feel it? The whole wood is breathing out. You have done a hard thing gently, and that is rare. This amulet was left at my door long ago by one who did not want it near him; it turns cold when the dead are close, and it will be quiet now for a while.",
      } },

    // ---- q017 L27 · The Lone-lands · Anlaf the Forlorn, keeper of the Forsaken Inn
    { id: 'q017', name: 'The Lost Kegs of the Forsaken Inn', type: 'side', level: L(17), zone: 'lonelands', giver: 'npc_forsakeninn_anlaf', turnin: 'npc_forsakeninn_anlaf', prereq: [],
      objectives: [
        { type: 'collect', item: 'qc_forsaken_cask', count: 4, from: 'lonelands_goblin', label: 'Recover the casks from the goblins of Minas Eriol' },
      ],
      rewards: R(L(17), ['n_lute_forsaken', 'drink_pony_ale']),
      summary: "The autumn brewing of the Forsaken Inn — four casks of it — went east on a cart and came back as a goblin raid. The goblins of Minas Eriol have the ale, and Anlaf has nothing to pour.",
      hint: 'Minas Eriol is the ruined hill-fort north of the inn; the goblins camp in its shadow and carry the casks between them.',
      text: {
        intro: "Do you know what an inn is without ale? A room with a roof. The whole autumn brewing went out on Gilby's cart — four casks, the best I have made in years — and the goblins came down off Minas Eriol and took the lot, cart and all. They cannot drink it; they have not the wit to open a bung. They are carrying it about like a trophy. Bring me back my casks and I will pour you the first cup from the first one, and that is a promise I do not make twice.",
        accept: 'North of the inn, on the ruined hill. The casks are oak, with my mark on the head.',
        progress: 'Four casks. If one is broached, bring the other three and the name of the goblin that did it.',
        complete: "All four! And not a bung pulled — I told you they had not the wit. The first cup is yours, as promised, and — well. A fiddler left this behind years ago and never came back for it, and it has been gathering dust and sorrow behind the bar ever since. Take it away; it wants a road.",
      } },

    // ---- q018 L28 · The Lone-lands · Sam Twofoot, pedlar at the Forsaken Inn
    { id: 'q018', name: "The Pedlar's Parcel", type: 'side', level: L(18), zone: 'lonelands', giver: 'npc_forsakeninn_sam', turnin: 'npc_forsakeninn_sam', prereq: [],
      objectives: [
        { type: 'deliver', item: 'qc_sam_parcel', npc: 'npc_ostguruth_general', label: "Deliver Sam's parcel to Hagar the pedlar at Ost Guruth" },
        { type: 'collect', item: 'qc_pedlar_wares', count: 5, from: 'red_hill_bandit', label: 'Recover the stolen wares from the Red-hill bandits' },
      ],
      rewards: R(L(18), ['scroll_swiftfoot_10', 'food_honey_cake']),
      summary: 'Sam Twofoot has a parcel that must reach Hagar at Ost Guruth and a pack of wares that must be got back from the Red-hill bandits, and only one pair of short legs.',
      hint: 'Ost Guruth is at the far east end of the Great East Road. The bandits who robbed Sam lurk on the hills west of the inn, north of the road towards Bree.',
      text: {
        intro: "I was robbed. Robbed! On the King's own road, by Red-hill bandits with red hair and no manners, and every button, needle and tin whistle I own went into their sacks. And now Hagar at Ost Guruth is waiting on this parcel — it is a matter of business, very private, do not shake it — and I cannot go east with the bandits still west, or west with Hagar waiting east. You see my difficulty. Take the parcel to Hagar, get my wares back from the bandits, and I shall not forget it.",
        accept: 'Hagar is the one with the wagon and the frown. The bandits are the ones with my buttons.',
        progress: 'Do not shake the parcel! And count the wares — there should be five bundles, all told.',
        complete: "Hagar had it, and did not shake it? Good. And my wares — my needles! My whistle! You are a wonder, and I shall tell every inn from here to Bree so, which is the best advertisement a person can have. Here: a cake from the Beornings, and a scroll for fast feet, which you seem to have already.",
      } },

    // ---- q019 L30 · The Lone-lands · Candaith, ranger of Weathertop
    { id: 'q019', name: "The Ranger's Map of Ruins", type: 'side', level: L(19), zone: 'lonelands', giver: 'npc_ostguruth_candaith', turnin: 'npc_ostguruth_candaith', prereq: [],
      objectives: [
        { type: 'explore', pos: { x: 330, z: -60 }, radius: 18, label: 'Survey the ruins of Minas Eriol' },
        { type: 'explore', pos: { x: 420, z: -280 }, radius: 18, label: 'Survey the Red Pass' },
        { type: 'explore', pos: { x: 760, z: -110 }, radius: 18, label: 'Survey the ruins of Agamaur' },
      ],
      rewards: R(L(19), ['n_ring_ranger', 'pot_heal_elixir']),
      summary: "Candaith is mapping the ruins of Rhudaur for the Rangers and cannot be in three places at once. Walk Minas Eriol, the Red Pass and Agamaur, and mark what stands.",
      hint: 'Minas Eriol is the hill-fort north of the Forsaken Inn; the Red Pass cuts the hills north-west of Weathertop; Agamaur is the ruin north of Ost Guruth beside the marsh.',
      text: {
        intro: "The Rangers keep a map of every ruin between the Brandywine and the Misty Mountains, and every year it is a little more wrong. Walls fall. Roads drown. Orcs move in. I have three places to mark this season and I cannot leave Weathertop — Minas Eriol in the west, the Red Pass in the north, and Agamaur by the marsh — and I would trust a stranger's eyes before I trusted no eyes at all. Walk each one, look at what stands, and come back and tell me.",
        accept: 'Look, do not linger. A map is not improved by the death of the map-maker.',
        progress: 'What stands at Minas Eriol? At the Pass? At Agamaur? Tell me when you have seen all three.',
        complete: "Minas Eriol half-fallen, the Pass open, Agamaur — yes, that is what I feared. You have done the Rangers a service that will not appear on any map, which is how we prefer it. This ring is the one we know each other by. Wear it, and if a grey-cloaked stranger nods to you on the road, nod back.",
      } },

    // ---- q020 L31 · The Lone-lands · Dunstan, Eglain watchman
    { id: 'q020', name: 'Bounty: Ugrûk of the Weather Hills', type: 'side', level: L(20), zone: 'lonelands', giver: 'npc_ostguruth_guard1', turnin: 'npc_ostguruth_guard1', prereq: [],
      objectives: [
        { type: 'kill', target: 'orc_lonelands', count: 5, label: 'Thin the orc-camp under Weathertop' },
        { type: 'killboss', boss: 'boss_ugruk', label: 'Slay Ugrûk, orc-captain of the Weather Hills, on the summit' },
      ],
      rewards: R(L(20), ['scroll_battle_10', 'pot_heal_elixir'], { title: 'Watcher of Weathertop' }),
      summary: 'The Eglain have lost three hunters to the orcs on Weathertop, and Dunstan has stopped waiting for the Rangers. He wants Ugrûk dead and the summit empty.',
      hint: 'The orc-camp is on the west flank of Weathertop; Ugrûk keeps the ruined tower on the summit. Come at the hill from the road.',
      text: {
        intro: "Three of ours this month. Three hunters who went up towards the Weather Hills and did not come down, and every one of them wearing the marks of that orc-captain's cleaver — Ugrûk, he calls himself, and he has made the old tower on Amon Sûl his own. The Rangers say they are 'watching him'. I say we have watched enough. Thin out his camp on the west slope, then go up and finish him, and the Eglain will not forget who did it.",
        accept: 'Go by the road, come at the hill from the south. The camp first, or the camp will come at your back.',
        progress: 'Is the summit still his? I can see the tower from the wall, and I can see the fires.',
        complete: "The fires are out. I saw it from the wall last night — the summit dark for the first time since the snow. Ugrûk dead, and his camp scattered, and the Weather Hills ours again for a season. The Eglain call you the Watcher of Weathertop now; it is not a title we give, it is one we say, which is better.",
      } },

    // ---- q021 L33 · The North Downs · Goodman Wyatt, farmer of Trestlebridge
    { id: 'q021', name: 'Wargs at the Trestlespan', type: 'side', level: L(21), zone: 'northdowns', giver: 'npc_trestlebridge_farmer', turnin: 'npc_trestlebridge_farmer', prereq: [],
      objectives: [
        { type: 'kill', target: 'northdowns_warg', count: 6, label: 'Hunt the Downs wargs that come down to the farms at night' },
        { type: 'collect', item: 'mat_warg_hide', count: 4, from: 'northdowns_warg', label: 'Bring Wyatt warg-hides to nail to the barn' },
      ],
      rewards: R(L(21), ['food_ranger_stew', 'pot_heal_elixir']),
      summary: 'Wargs come down off the Downs every night to Goodman Wyatt’s sheep-fold, and he has decided that a few hides nailed to the barn door might make the rest think twice.',
      hint: 'The wargs den on the downs south-west of Trestlebridge, below the bridge; they range along the road at dusk.',
      text: {
        intro: "Nine ewes this month. Nine! I have sat up with a lantern and a pitchfork every night since the moon was new, and every morning there is another one gone and the tracks run straight back up onto the Downs. Wargs, the Bridge-captain says, as if I did not know a warg from a wet dog. Go up there and thin them out — and bring me a few of their hides while you are at it. I mean to nail them to the barn door where the rest can see them. It may not work. It will make me feel better.",
        accept: 'South-west, below the bridge, where the downs fold. You will hear them before you see them.',
        progress: 'Six of them, and four hides. And do not tell my wife about the barn door.',
        complete: "Look at those! Great ugly things, the pair of them. I shall have them up on the barn by nightfall and we shall see what the rest of the pack makes of that. Here — my wife's stew, which is the one thing on this farm the wargs have not had, and something for your hurts.",
      } },

    // ---- q022 L35 · The North Downs · Nella Bridgewater, innkeeper of Trestlebridge
    { id: 'q022', name: "Old Wyatt's Treasure Map", type: 'side', level: L(22), zone: 'northdowns', giver: 'npc_trestlebridge_innkeeper', turnin: 'npc_trestlebridge_innkeeper', prereq: [],
      objectives: [
        { type: 'explore', pos: { x: 80, z: -780 }, radius: 18, label: 'Find the first mark: the standing stones of Nan Amlug' },
        { type: 'explore', pos: { x: 480, z: -500 }, radius: 18, label: 'Find the second mark: the orc-camp at Dol Dínen' },
        { type: 'use', node: 'gn_northdowns_5', count: 1, label: 'Open the cache in the Fornost treasury' },
      ],
      rewards: R(L(22), ['scroll_fortune_10', 'pot_heal_elixir', 'misc_treasure_cache']),
      summary: 'A tinker paid for his room at the Trestlebridge Inn with a treasure map. Nella cannot read it, but you can: two landmarks, then a cache in the ruins of Fornost.',
      hint: 'Nan Amlug is the stone-ringed hollow west of Esteldín; Dol Dínen is the orc-camp east of the road; the treasury is deep in the ruins of Fornost to the north, under the King’s Court.',
      text: {
        intro: "A tinker slept here a week ago, ate like three men, and paid with this — a map, he said, to something his grandfather buried in Fornost before the fall. I told him a map is not a room, and he said if I could read it I would not think so, and then he left before dawn. I cannot read it. There are two marks — a ring of stones and a camp — and then a cross in the old city. I am too old and too busy to go treasure-hunting, but I am not too proud to go halves.",
        accept: 'Stones first, then the camp, then the cross. That is what the tinker said, and he ate three suppers on it.',
        progress: 'Have you found the stones? The camp? The cross? Do not tell me what it is until you are holding it.',
        complete: "You found it! What — what is it? A box? Well, a box is more than I expected, and it is heavier than a tinker's promise. Halves, I said, and halves it is: you keep the box, I keep the story, and I shall dine out on it for a year.",
      } },

    // ---- q023 L36 · The North Downs · Mirwen, cook of Esteldín
    { id: 'q023', name: 'Bear-meat for the Rangers', type: 'side', level: L(23), zone: 'northdowns', giver: 'npc_esteldin_food', turnin: 'npc_esteldin_food', prereq: [],
      objectives: [
        { type: 'collect', item: 'qc_bear_haunch', count: 5, from: 'northdowns_bear', label: 'Bring haunches from the Downs bears north of the refuge' },
        { type: 'deliver', item: 'qc_ranger_rations', npc: 'npc_esteldin_guard2', label: 'Carry a ration-bag to Tadion at the eastern watch' },
      ],
      rewards: R(L(23), ['food_ranger_stew', 'pot_power_elixir']),
      summary: 'Mirwen has forty Rangers to feed and an empty larder. Five bear-haunches from the Downs would fill it — and Tadion on the east watch has not eaten since yesterday.',
      hint: 'Downs bears forage north of Esteldín towards Fornost and on the hills south of the refuge. Tadion stands the eastern watch, outside the walls to the east.',
      text: {
        intro: "Forty Rangers, one cook, and a larder with a mouse in it — that is Esteldín this week. Halbarad sends patrols out and they come back hungry, and every one of them looks at me as if I could make stew from stones. Bear, that is what I need: five good haunches from the Downs bears north of here, and I can feed the refuge for a fortnight. And take this ration-bag out to Tadion on the east watch before you go. He will not leave his post to eat, and he will not admit he is hungry, so do not ask him.",
        accept: 'Five haunches, and the bag to Tadion. Do not eat the bag.',
        progress: 'Has Tadion eaten? And the bear — how much bear? Five haunches, I said, not five bears.',
        complete: "Five haunches — oh, that is enough for a proper stew, with the marrow and everything. And Tadion ate? He did not say thank you, I suppose. He never does. Here is the last of the old pot and something to keep you on your feet; you have earned a bowl of the new one when it is done.",
      } },

    // ---- q024 L38 · The North Downs · Aldan, Ranger recruit (requires Book 4 to have begun)
    { id: 'q024', name: "Aldan's First Patrol", type: 'side', level: L(24), zone: 'northdowns', giver: 'npc_esteldin_recruit', turnin: 'npc_esteldin_recruit', prereq: ['s038'],
      objectives: [
        { type: 'kill', target: 'uruk_fornost', count: 5, label: 'Slay Uruks of the Fornost garrison' },
        { type: 'explore', pos: { x: 250, z: -960 }, radius: 20, label: 'Walk the ruined streets of Fornost Erain' },
      ],
      rewards: R(L(24), ['n_shield_fornost', 'pot_heal_elixir']),
      summary: 'Aldan has been told he is not ready for Fornost. He means to prove otherwise — through you, since Halbarad will not let him go himself.',
      hint: 'Fornost lies at the north end of the Downs, up the road from Esteldín. The Uruk garrison holds the south quarter of the ruins.',
      text: {
        intro: "Halbarad says I am not ready for Fornost. He says it kindly, which is worse. I have trained a year and I can put an arrow through a ring at fifty paces and still it is 'not yet, Aldan, not yet'. So here is what I propose: you go. You slay five of the Uruks in the south quarter and you walk the old streets to the King's Court, and you come back and tell me exactly what it is like, and then when he asks I shall know. It is not the same. I know it is not the same. But it is something.",
        accept: 'Five Uruks and the streets walked. And — tell me everything. Even the bad parts.',
        progress: 'Is it very terrible? The Uruks, I mean, and the ruins? Do not spare me.',
        complete: "The streets grown through with birch, and the Uruks — five of them — and the King's Court open to the sky. I can see it. I can almost see it. Thank you. This shield was dug out of those ruins by a Ranger who is not coming back; Halbarad gave it to me to keep. I think he would rather it were carried.",
      } },

    // ---- q025 L39 · Evendim · Old Rúmil, fisherman of Tinnudir
    { id: 'q025', name: "Rúmil's Lost Lines", type: 'side', level: L(25), zone: 'evendim', giver: 'npc_tinnudir_rumil', turnin: 'npc_tinnudir_rumil', prereq: [],
      objectives: [
        { type: 'fish', count: 5, spot: 'fs_evendim_north', label: 'Fish the north shore of Nenuial where Rúmil set his lines' },
        { type: 'kill', target: 'evendim_crawler', count: 5, label: 'Kill the lake-crawlers that have been cutting the lines' },
      ],
      rewards: R(L(25), ['bait_minnow', 'fish_evendim_salmon', 'food_ranger_stew']),
      summary: 'Old Rúmil set his long-lines off the north shore of the lake and something with claws has been cutting them. He wants his fish, and the crawlers gone.',
      hint: 'Follow the causeway north-west off the isle to the north shore; cast from the shingle. The crawlers come up out of the shallows just west of it.',
      text: {
        intro: "Sixty years I have fished this lake and I have never had a line cut. Cut! Not bitten through — cut, clean as a knife, four nights running, off the north shore where the perch run in autumn. Lake-crawlers, the young ones say, come up out of the deeps with the cold. Well, my knees do not go up to the north shore any more, but yours look as though they might. Fish my water there and see what is biting, and if it is crawlers, do to them what they did to my lines.",
        accept: 'North shore, off the causeway. Perch and pike, if the crawlers have left any.',
        progress: 'Five fish and the crawlers cut down to size. My lines will be waiting.',
        complete: "Perch! And a pike, and — is that a salmon? Off the north shore? Sixty years, I tell you. The crawlers are done for, then; I shall set my lines again tomorrow and sit here with my pipe and think about my knees. Take a lure, and a fish, and a bowl of Elwen's stew; you have earned all three.",
      } },

    // ---- q026 L41 · Evendim · Pell, scholar's apprentice of Tinnudir
    { id: 'q026', name: 'Stones of the Lost City', type: 'side', level: L(26), zone: 'evendim', giver: 'npc_tinnudir_apprentice', turnin: 'npc_tinnudir_apprentice', prereq: [],
      objectives: [
        { type: 'kill', target: 'tomb_robber', count: 6, label: 'Drive the tomb-robbers from the ruins of Annúminas' },
        { type: 'collect', item: 'qc_annuminas_tablet', count: 4, from: 'tomb_robber', label: 'Recover the inscribed tablets they have prised loose' },
        { type: 'explore', pos: { x: -540, z: -900 }, radius: 20, label: 'Study the great square of Annúminas' },
      ],
      rewards: R(L(26), ['scroll_tactics_10', 'pot_heal_elixir']),
      summary: 'Tomb-robbers are prising the inscribed stones out of the walls of Annúminas to sell in Bree. Pell would have them back before the last of the old letters is lost.',
      hint: 'Annúminas is the ruined city on the west shore, reached by the Lakeside Way. The robbers camp among the buildings on its southern edge.',
      text: {
        intro: "Do you know what they are doing over there? The tomb-robbers — they are prising the inscriptions out of the walls of Annúminas with crowbars and selling them in Bree as doorstops. Doorstops! Some of those stones bear the only record we have of the last kings of Arnor. Master Ninias says the Rangers will deal with it 'in time', and time is exactly what those stones do not have. Drive the robbers off, get back whatever tablets you can, and — look at the square while you are there. Just look. It was the fairest city in the North, once.",
        accept: 'The tablets will be in their packs. Please do not let them drop them.',
        progress: 'Four tablets, and the square seen with your own eyes. How is it? Is the fountain still standing?',
        complete: "Four! And this one — look, the name of Eärendur, I would swear to it. Master Ninias will pretend not to be excited and fail. The square, you saw it? The seven stars on the paving? Then you understand. Here — a scroll from the library, and something for the road. I owe you far more, and so does the North.",
      } },

    // ---- q027 L42 · Evendim · Nengel, lake-fisher of Tinnudir
    { id: 'q027', name: 'The Pike of Tinnudir', type: 'side', level: L(27), zone: 'evendim', giver: 'npc_tinnudir_nengel', turnin: 'npc_tinnudir_nengel', prereq: [],
      objectives: [
        { type: 'talk', npc: 'npc_tinnudir_rumil', label: 'Ask Old Rúmil where the great pike lies' },
        { type: 'fish', count: 6, spot: 'fs_tinnudir_shore', label: 'Fish the Tinnudir shallows until the great pike takes the hook' },
      ],
      rewards: R(L(27), ['misc_fishing_rod_elven', 'bait_minnow'], { title: 'Pike-wrestler of Nenuial' }),
      summary: 'There is a pike in the Tinnudir shallows as long as a boat, and Nengel has lost three rods to it. Ask Old Rúmil where it lies, then go and lose a fourth — or land it.',
      hint: 'Rúmil sits at the north end of the isle by the boats. The shallows are on the south side of Tinnudir, below the keep.',
      text: {
        intro: "There is a pike in the shallows below the keep that has taken three of my rods and, I am fairly sure, one of my boots. As long as a boat, with a jaw like a bear-trap, and it laughs at me — I am certain it laughs. Old Rúmil claims he has known it for forty years and knows where it lies, but he will not tell me because I once called him old. Go and ask him; he likes new faces. Then take a rod down to the shallows and fish until it comes, and bring it up, or bring me back the rod.",
        accept: 'Rúmil first. He will make you listen to a story. Listen; the pike is at the end of it.',
        progress: 'Six casts at the least, Rúmil says — it will not come for less. Has it taken the rod yet?',
        complete: "You — you landed it? The pike? Or at least you fished the shallows and came back with the rod, which is more than I have managed. Then the rod is yours by right — this one, the elven one, the one I was saving for the day the pike was gone. Pike-wrestler, Rúmil says they should call you. He is old. He is also right.",
      } },

    // ---- q028 L44 · Evendim · Dorlas, Ranger sentry of Tinnudir (requires Book 5 to have begun)
    { id: 'q028', name: 'Bounty: Ardaric the Tomb-robber', type: 'side', level: L(28), zone: 'evendim', giver: 'npc_tinnudir_guard', turnin: 'npc_tinnudir_guard', prereq: ['s051'],
      objectives: [
        { type: 'kill', target: 'tomb_robber_lieutenant', count: 3, label: "Break Ardaric's lieutenants at the robbers' camp" },
        { type: 'killboss', boss: 'boss_ardaric', label: 'Slay Ardaric the Tomb-robber in the ruins of Annúminas' },
      ],
      rewards: R(L(28), ['n_spear_warden', 'pot_heal_greater'], { title: 'Warden of Annúminas' }),
      summary: 'Ardaric the Tomb-robber has plundered the tombs of the kings for a year and killed two Rangers who went after him. Dorlas has the captain’s leave to post a bounty, and he is posting it on you.',
      hint: 'The robbers’ camp is on the shore north of Annúminas; Ardaric himself holds the drowned quays at the city’s heart.',
      text: {
        intro: "Ardaric. You will have heard the name if you have been on the west shore — the tomb-robber who dug out the crypt of Eärendur and sold the bones, and who killed Meneldor and Rhavan when they went to bring him in. Captain Tarondor has given me leave to post a bounty, and I have decided that you are the bounty. His lieutenants hold the camp on the shore north of the city; break them first, or they will hold the city against you. Then find Ardaric among the drowned quays, and finish what Meneldor started.",
        accept: 'The lieutenants first. Then the quays. Do not go into the water; he has friends there too.',
        progress: 'Is it done? I will know — the whole shore will know.',
        complete: "Ardaric dead among the tombs he emptied. There is a justice in that which I did not expect to feel. Meneldor carried this spear; it came back to us without him, and I have not been able to look at it since. Carry it on the lake-shore in his place, Warden — for that is what the captain will call you, whether you want it or not.",
      } },

    // ---- q029 L45 · The Trollshaws · Aradan, wounded Ranger of Thorenhad
    { id: 'q029', name: "Aradan's Reckoning", type: 'side', level: L(29), zone: 'trollshaws', giver: 'npc_thorenhad_wounded', turnin: 'npc_thorenhad_wounded', prereq: [],
      objectives: [
        { type: 'kill', target: 'hillman_brigand', count: 6, label: 'Punish the hillmen of the western camp who ambushed Aradan' },
        { type: 'collect', item: 'mat_athelas', count: 3, from: null, node: 'gn_trollshaws_1', label: 'Gather athelas for his wound from the glade east of the ford' },
      ],
      rewards: R(L(29), ['pot_heal_greater', 'food_cram']),
      summary: 'Aradan took a hillman spear in the thigh on the west road and is not healing. He wants kingsfoil from the eastern glade — and the hillmen taught a lesson.',
      hint: 'The hillman camp is west of Thorenhad on the Ost Guruth road, south of the river. The athelas glade lies east across the Last Bridge, south of the Rivendell road.',
      text: {
        intro: "Do not look at the leg; it is worse than it looks and it looks bad enough. Hillmen, on the west road — six of them out of the heather, and I took a spear before I had my sword out. Berenon will not spare a man to go after them and Hathlaf says the wound wants athelas, which grows in the glade past the bridge where I cannot walk. So. Two things, if you would. The kingsfoil, three sprigs, from the eastern glade. And the hillmen — all six — because I am not the first they have taken on that road and I will not be the last unless someone goes.",
        accept: 'The camp is west along the road. The glade is east over the bridge. Bring the leaf back green.',
        progress: 'The leaf — is it green still? And the hillmen. Tell me about the hillmen.',
        complete: "Six. Good. And the leaf — ah, that is the true smell, I feel it already. Hathlaf can boil it and I can stop being a burden by the week's end. This is a poor return for a good deed: a draught the quartermaster does not know I have and a lump of dwarf-bread that will outlast us both. Take them, and my thanks, which will outlast the bread.",
      } },

    // ---- q030 L47 · The Trollshaws · Bofri, dwarf-envoy at Rivendell
    { id: 'q030', name: 'The Troll-hoard', type: 'side', level: L(30), zone: 'trollshaws', giver: 'npc_rivendell_bofri', turnin: 'npc_rivendell_bofri', prereq: [],
      objectives: [
        { type: 'explore', pos: { x: 1230, z: -110 }, radius: 18, label: "Find the three stone-trolls of Mr. Baggins' tale" },
        { type: 'kill', target: 'stone_troll', count: 4, label: 'Slay the living trolls that have gathered in the clearing' },
        { type: 'use', node: 'gn_trollshaws_5', count: 1, label: "Open the trolls' hoard" },
      ],
      rewards: R(L(30), ['n_gauntlets_troll', 'pot_heal_greater']),
      summary: 'Bofri has heard Bilbo tell the tale of the three trolls a dozen times, and every time it ends with a hoard in a cave. He means to have a look — through you.',
      hint: 'The stone-trolls stand in a clearing north-west of Rivendell, up the Thorenhad road and north into the wood. The hoard-cave is a few paces east of them.',
      text: {
        intro: "Every night in the Hall of Fire, Mr. Baggins tells of the three trolls that Gandalf turned to stone, and every night it ends with a cave and a hoard, and every night I think: a dwarf could do something with a hoard. The stones are real — I have seen them from the road. What I have not seen is what has moved into the clearing since: living trolls, the elves say, and more than three. Find the clearing, deal with whatever is walking about in it, and open the hoard. Halves to Thorin's Hall, and halves to you, and I shall write it all down for Mr. Baggins.",
        accept: 'North-west, off the Thorenhad road. Stone trolls stand still; the other kind do not.',
        progress: 'Have you found the stones? The cave is beyond them, so the story goes. So the story goes.',
        complete: "You opened it! And? Swords, the story said, and — well, no matter what it said; you have brought back enough to make the envoy of Thorin's Hall a happy dwarf. Mr. Baggins will want every detail. These gauntlets are troll-bone, from a troll who was rather less stone than he should have been; they are yours, and welcome.",
      } },

    // ---- q031 L49 · The Trollshaws · Bilbo Baggins, poet of Rivendell
    { id: 'q031', name: "Bilbo's Book of Tales", type: 'side', level: L(31), zone: 'trollshaws', giver: 'npc_rivendell_bilbo', turnin: 'npc_rivendell_bilbo', prereq: [],
      objectives: [
        { type: 'talk', npc: 'npc_rivendell_bofri', label: "Collect Bofri's tale of the Blue Mountains" },
        { type: 'talk', npc: 'npc_rivendell_elrohir', label: "Collect Elrohir's tale of the hunt in the Trollshaws" },
        { type: 'talk', npc: 'npc_rivendell_lindir', label: "Collect Lindir's tale of the Hall of Fire" },
      ],
      rewards: R(L(31), ['drink_miruvor', 'scroll_tactics_50'], { title: 'Chronicler of Rivendell' }),
      summary: 'Bilbo is at the chapter about Rivendell and has run out of Rivendell. Three tales — from a dwarf, a son of Elrond and a singer — would fill it nicely.',
      hint: 'Bofri stands by the guest-house steps, Elrohir walks the terraces west of the Last Homely House, and Lindir sings in the Hall of Fire.',
      text: {
        intro: "Come in, come in, mind the papers. I am at the chapter about Rivendell, you see — 'the Last Homely House east of the Sea' — and I find I have written everything I know about it and it is only two pages. Two! A book cannot have a two-page Rivendell. Would you be a dear and collect me some tales? Bofri has one about the Blue Mountains he tells when he has had wine; Elrohir hunted a troll here last winter and will not talk about it unless asked; and Lindir knows every song that was ever sung in the Hall, which is rather the point of him. Three tales, and I shall have a chapter.",
        accept: 'Ask nicely, listen closely, and if Elrohir says it was nothing, it was not nothing.',
        progress: 'Three tales — what has Bofri said? And Elrohir? And has Lindir stopped singing long enough to speak?',
        complete: "A troll on the Bruinen ford, and a mine that sang, and the night Lindir made Elrond laugh — oh, this is a chapter. This is two chapters. You shall go in the acknowledgements, which nobody reads, and in the fourth chapter, which everybody will. Take a drop of miruvor for the road, and a scroll I have never had the least use for.",
      } },

    // ---- q032 L50 · The Misty Mountains · Brók, skald of the High Crag
    { id: 'q032', name: 'The Cairn of the Lost Climbers', type: 'side', level: L(32), zone: 'misty', giver: 'npc_highcrag_brok', turnin: 'npc_highcrag_brok', prereq: [],
      objectives: [
        { type: 'explore', pos: { x: 1560, z: -620 }, radius: 18, label: 'Climb to the Frozen Falls where the climbers were lost' },
        { type: 'kill', target: 'misty_bat', count: 6, label: 'Clear the ice-bats from the falls' },
        { type: 'collect', item: 'mat_snow_lichen', count: 4, from: null, node: 'gn_misty_2', label: 'Gather snow-lichen from below the falls for the cairn-wreath' },
      ],
      rewards: R(L(32), ['food_cram', 'scroll_fortitude_50']),
      summary: 'Brók is composing a lament for the dwarves lost on the Frozen Falls and wants the place seen, the bats that took them driven off, and lichen for a wreath on their cairn.',
      hint: 'The Frozen Falls are north-west of the High Crag, up the ravine. The lichen grows on the rocks at the foot of the falls; the bats roost in the ice above.',
      text: {
        intro: "Seven dwarves went up to the Frozen Falls in the autumn to cut ice for the forge and came down as three. The bats took them — ice-bats, the size of eagles, that come out of the frozen curtain at dusk. There is a cairn for them here at the camp with no names on it yet, for I have not finished the lament, and I cannot finish it without seeing the place. Go up there for me. Drive off the bats, gather lichen from below the falls for the wreath, and tell me how the ice looks at that hour. I am a skald, not a climber; my songs must go where I cannot.",
        accept: 'Up the ravine to the north-west. Go in daylight, come back before the bats do.',
        progress: 'How does the ice look? Grey-green, they said, like old glass. And the lichen — four handfuls, for the wreath.',
        complete: "Grey-green, like old glass, and the bats gone from it. Now I can hear the song: it starts with the ice and ends with the cairn, and the names go in the middle where they belong. The wreath will be laid tonight. Take bread for the road and a scroll for the heart; the mountain asks a great deal of both.",
      } },

    // ---- q033 L52 · The Misty Mountains · Ketil, goat-master of the High Crag
    { id: 'q033', name: 'The Goat That Went Up', type: 'side', level: L(33), zone: 'misty', giver: 'npc_highcrag_stable', turnin: 'npc_highcrag_stable', prereq: [],
      objectives: [
        { type: 'explore', pos: { x: 1750, z: -300 }, radius: 20, label: "Search the Giant's Stair for Grettir the goat" },
        { type: 'kill', target: 'snow_warg', count: 6, label: 'Hunt the snow-wargs that chased him up there' },
      ],
      rewards: R(L(33), ['pot_power_greater', 'food_cram']),
      summary: 'Grettir, the best pack-goat on the High Crag, bolted up the Giant’s Stair with a pack of snow-wargs behind him. Ketil wants the goat back and the wargs fewer.',
      hint: 'The Giant’s Stair is the great staircase of rock east of the camp, above the Rivendell path. The wargs hunt the slopes south of the camp and along the Stair.',
      text: {
        intro: "Grettir. Best goat I ever had — carries more than a pony, eats less, and has never once fallen off anything, which on this mountain is a talent. Last night the snow-wargs came down on the goat-lines and he went up the Giant's Stair like a thing possessed with six of them after him, and I have not seen him since. Goats go up when they are frightened; he will be somewhere on the Stair, if the wargs have not got him. Find him. And find the wargs.",
        accept: 'The Stair is east, above the Rivendell path. Whistle twice and he will come, if he can.',
        progress: 'Any sign of him? Look on the ledges — he likes ledges. And the wargs, how many?',
        complete: "He was on a ledge! Of course he was on a ledge. Look at him — not a scratch, and eaten somebody's rope by the look of it. Six wargs fewer, you say? Then the goat-lines may sleep tonight, and so may I. Bread and a draught — it is all a goat-master has, but you are welcome to both.",
      } },

    // ---- q034 L53 · The Misty Mountains · Hannar, dwarf-smith of the High Crag
    { id: 'q034', name: 'Drake-scale for the Forge', type: 'side', level: L(34), zone: 'misty', giver: 'npc_highcrag_smith', turnin: 'npc_highcrag_smith', prereq: [],
      objectives: [
        { type: 'collect', item: 'mat_drake_scale', count: 5, from: 'cold_drake', label: 'Take scales from the cold-drakes of the eastern roost' },
        { type: 'collect', item: 'mat_mithril_flake', count: 2, from: null, node: 'gn_misty_1', label: 'Pick mithril flakes from the seam above the camp' },
      ],
      rewards: R(L(34), ['pot_heal_greater', 'scroll_battle_50']),
      summary: 'Hannar has a commission from Glóin himself and needs drake-scale and mithril to fill it. Both are on the mountain; neither wants to be taken.',
      hint: 'The drake-roost is far to the east of the camp, under the High Pass. The mithril seam is on the cliff a short way east of the camp, above the goat-lines.',
      text: {
        intro: "Glóin has asked me for a hauberk. Glóin, son of Gróin, who sat at Erebor with Thorin — he wants a mail-shirt of my making, and I will not make it of iron. Drake-scale for the plates, and mithril for the rings that bind them: five scales from the cold-drakes at the eastern roost and two flakes of true-silver from the seam above the camp. The drakes will not give up their scales and the seam is in a cold wind on a bad cliff, and I am too old for either. You are not.",
        accept: 'Scales from the roost, flakes from the seam. Mind the wind on the cliff; it has a sense of humour.',
        progress: 'Five scales and two flakes. Do not bend the scales; they do not forgive it.',
        complete: "Ah. Ah, look at that — the blue in the scale, and the light in the flake. Glóin shall have his hauberk and it will turn a troll's club. I cannot pay you what this is worth, but a draught and a scroll from the war-chest are yours, and if Glóin ever hears my name spoken with respect, he will hear yours with it.",
      } },

    // ---- q035 L55 · The Misty Mountains · Vigdis, sentry of the High Crag (requires Book 6 to have begun)
    { id: 'q035', name: "The Giants' Council", type: 'side', level: L(35), zone: 'misty', giver: 'npc_highcrag_guard', turnin: 'npc_highcrag_guard', prereq: ['s063'],
      objectives: [
        { type: 'kill', target: 'stone_giant', count: 4, label: 'Drive the stone-giants back from the Stair' },
        { type: 'explore', pos: { x: 1950, z: -500 }, radius: 22, label: 'Scout the High Pass for the giants’ gathering' },
      ],
      rewards: R(L(35), ['n_pocket_giant', 'pot_heal_greater']),
      summary: 'The stone-giants have been hurling rocks at the Stair for a week and gathering at the High Pass by night. Vigdis wants them pushed back and the Pass looked at.',
      hint: 'The stone-giants haunt the Giant’s Stair east of the camp; the High Pass is beyond it, at the far eastern edge of the mountains.',
      text: {
        intro: "You hear that? That crash? That is a stone-giant throwing a rock the size of a wagon at the Stair, and it has been happening every hour for a week. They are gathering at the High Pass by night — I have seen their fires — and when giants gather, something is going to be thrown at something. Glóin says it is 'their business'. It becomes mine the day one of those rocks lands on the camp. Push them back from the Stair, and then go up to the Pass and see how many are there, and tell me true.",
        accept: 'Four of them off the Stair. Then the Pass, and count the fires.',
        progress: 'How many at the Pass? And are they still throwing?',
        complete: "Eleven fires at the Pass and four fewer giants on the Stair. That is worse than I feared and better than I expected, which is the mountain all over. Take this — a giant dropped it on the Stair the first night, and I have carried it ever since for luck. It is heavier than luck should be. You have earned it, and a draught besides.",
      } },

    // ---- q036 L56 · Angmar · Aoife, hillman child of Aughaire
    { id: 'q036', name: "Aoife's Charm", type: 'side', level: L(36), zone: 'angmar', giver: 'npc_aughaire_child', turnin: 'npc_aughaire_child', prereq: [],
      objectives: [
        { type: 'deliver', item: 'qc_aoife_charm', npc: 'npc_aughaire_breanna', label: 'Take the charm to Bréanna the wise-woman for a blessing' },
        { type: 'fish', count: 4, spot: 'fs_hoarwell_angmar', label: 'Catch fish from the Hoarwell headwaters for the family pot' },
        { type: 'kill', target: 'angmar_warg', count: 5, label: 'Chase the wargs from the western pastures' },
      ],
      rewards: R(L(36), ['food_waybread', 'pot_heal_greater']),
      summary: 'Aoife has made a charm for her brother on the wall and needs a grown-up to get it blessed, a fish for the pot, and the wargs kept away from the goats. She has thought about it very carefully.',
      hint: 'Bréanna keeps her tent at the north end of Aughaire. The Hoarwell headwaters are east of the camp, past Barad Gúlaran; the wargs range the pastures west of the walls.',
      text: {
        intro: "Are you a hero? You look like one. Good, because I have a lot of things and Mam says I am too small for all of them. This is a charm for my brother Cathal, who is on the wall, and it has to be blessed by Bréanna or it does not work, and she says I am too small to ask. And Mam wants fish from the river for the pot, and I am too small for the river. And the wargs keep eating the goats and I am too small for wargs. So. Charm, fish, wargs. I will wait here.",
        accept: 'The charm first, please. Cathal is on the wall tonight.',
        progress: 'Did Bréanna bless it? Did she say the words? And the fish — Mam wants four.',
        complete: "She blessed it! And the fish, and the wargs, and — you did all of it. Cathal will be safe now. Here — Mam said to give you the elf-bread that the Ranger left, because it is too good for us, and this bottle I found. Do not tell her about the bottle.",
      } },

    // ---- q037 L58 · Angmar · Brónach, trader of Aughaire
    { id: 'q037', name: 'Salt and Nightshade', type: 'side', level: L(37), zone: 'angmar', giver: 'npc_aughaire_bronach', turnin: 'npc_aughaire_bronach', prereq: [],
      objectives: [
        { type: 'collect', item: 'mat_nightshade', count: 5, from: null, node: 'gn_angmar_2', label: 'Gather nightshade from the western scree for the wise-woman' },
        { type: 'collect', item: 'qc_salt_sack', count: 4, from: 'angmar_orc', label: 'Recover the salt-sacks from the orcs east of the camp' },
      ],
      rewards: R(L(37), ['scroll_warding_50', 'pot_power_celebrant']),
      summary: 'The orcs took Brónach’s salt on the road from the pans, and Bréanna has run out of nightshade for her ointments. Both are outside the walls, where Brónach does not go.',
      hint: 'Nightshade grows on the scree west of Aughaire, past the warg-pastures. The orcs who took the salt camp east of the walls, along the road to Barad Gúlaran.',
      text: {
        intro: "Two things a hillman camp cannot do without: salt, and Bréanna in a good temper. I have lost the first to the orcs — four sacks, taken off the cart east of the gate, and the carter with them — and the second to the first, because Bréanna's ointments want nightshade and her nightshade wants gathering and I am a trader, not a gatherer. The nightshade is on the scree to the west. The orcs are on the road to the east. Bring me the one and the other and I shall be the most grateful trader in Angmar, which is a small field but a real one.",
        accept: 'Nightshade west, salt east. Do not eat the nightshade. Do not eat the salt either, come to that.',
        progress: 'Five sprigs and four sacks. The orcs will have the sacks on their backs; they are too stupid to hide them.',
        complete: "Salt! And the nightshade, and not a leaf bruised. Bréanna will be civil for a month and the whole camp will eat this winter. This scroll came in a trade I have never understood, and the bottle came from Rivendell by three hands; both are yours, and better in yours than in a crate.",
      } },

    // ---- q038 L59 · Angmar · Tadhg, hillman guard of Aughaire
    { id: 'q038', name: 'The Acolytes of Malenhad', type: 'side', level: L(38), zone: 'angmar', giver: 'npc_aughaire_guard', turnin: 'npc_aughaire_guard', prereq: [],
      objectives: [
        { type: 'kill', target: 'angmar_acolyte', count: 5, label: 'Slay the acolytes of Carn Dûm on the road to the bogs' },
        { type: 'collect', item: 'junk_dark_tome_scrap', count: 3, from: 'angmar_acolyte', label: 'Take pages of their dark tome for Bréanna to burn' },
        { type: 'explore', pos: { x: 1000, z: -1400 }, radius: 22, label: 'Look upon the Bogs of Malenhad' },
      ],
      rewards: R(L(38), ['scroll_tactics_50', 'pot_heal_athelas']),
      summary: 'Acolytes of Carn Dûm have been seen at the Bogs of Malenhad, chanting at something in the water. Tadhg wants them dead, their pages taken, and the bogs looked at by someone who will come back.',
      hint: 'The acolytes walk the road north-east of Aughaire towards Carn Dûm and gather at the bogs north of it. Malenhad is the sunken marsh between Himbar and the citadel road.',
      text: {
        intro: "There are acolytes at Malenhad. Grey robes, black staves, chanting at the bog-water in the dead of night as if it could hear them — and perhaps it can. Two of our scouts went to look and one came back, and he has not spoken since. I am a guard of the Trév Gállorg and I do not fear orcs, but I fear that. Go and kill them. Take whatever pages they carry, for Bréanna wants to burn them properly, and look at the bog yourself, and come back, and speak.",
        accept: 'North-east, past the tower. Kill them at their chanting; they are slow to turn.',
        progress: 'Five of them, and three pages, and the bog seen. Have you seen it? What is in the water?',
        complete: "You came back, and you are speaking. That is more than the last man managed. Five acolytes dead and their pages for the fire — Bréanna will burn them tonight with the right words, and perhaps the bog will go quiet. As for what is in the water — no. Keep it. I do not want to know. Take this, and this, and go and stand in the sun a while.",
      } },

    // ---- q039 L61 · Angmar · Lorcan, horse-thane of Aughaire
    { id: 'q039', name: 'Horses of the Hillmen', type: 'side', level: L(39), zone: 'angmar', giver: 'npc_aughaire_stable', turnin: 'npc_aughaire_stable', prereq: [],
      objectives: [
        { type: 'kill', target: 'angmar_uruk', count: 6, label: 'Slay the Uruks of Carn Dûm who raided the horse-pens' },
        { type: 'explore', pos: { x: 1150, z: -1050 }, radius: 22, label: 'Search Barad Gúlaran for the stolen horses' },
      ],
      rewards: R(L(39), ['scroll_swiftfoot_50', 'pot_heal_athelas']),
      summary: 'Uruks of Carn Dûm broke the horse-pens at Aughaire and drove off six horses towards the tower of Barad Gúlaran. Lorcan wants the Uruks answered and the horses found.',
      hint: 'The Uruks who raided the pens hold the ground east of Aughaire below Barad Gúlaran; the tower itself stands further east, above the road.',
      text: {
        intro: "Uruks. In the horse-pens, in the middle of the night, with torches — they broke the rails and drove off six of the best horses in Angmar towards that cursed tower, and speared the lad who tried to stop them. Hillmen do not lose horses; we are known for it. Go east, find the Uruks who did it, and answer them. Then search the tower-ground for the horses. If they are alive, they will come to a hillman's whistle; if they are not, I want to know.",
        accept: 'East, below the tower. They will still have the smell of the pens on them.',
        progress: 'Six Uruks, and the tower searched. Have you found the horses? Alive?',
        complete: "Four alive, and back at the pens by your whistle — and the Uruks paid for the other two, six times over. That is a hillman's arithmetic and I am content with it. Take this scroll, for a rider needs fast feet as well as a fast horse, and a draught from the wise-woman's stores, and my thanks, which is a horse-thane's word and worth more than coin in this country.",
      } },

    // ---- q040 L62 · Tol Morwen · Old Sigwald, fisherman of Morwen Village
    { id: 'q040', name: "The Grey Gull's Nets", type: 'side', level: L(40), zone: 'tolmorwen', giver: 'npc_morwenvillage_sigwald', turnin: 'npc_morwenvillage_sigwald', prereq: [],
      objectives: [
        { type: 'fish', count: 5, spot: 'fs_morwen_harbour', label: 'Fish the harbour to see what the wreck has stirred up' },
        { type: 'explore', pos: { x: -1760, z: 760 }, radius: 18, label: 'Look over the wreck of the Grey Gull on the eastern shore' },
        { type: 'kill', target: 'morwen_crawler', count: 5, label: 'Kill the tide-crawlers that have nested in the wreck' },
      ],
      rewards: R(L(40), ['bait_shrimp', 'pot_heal_athelas']),
      summary: 'The Grey Gull went onto the rocks east of the village with Sigwald’s nets aboard, and the tide-crawlers have moved in. He wants to know what the sea has done to his fishing.',
      hint: 'The harbour fishing-spot is off the pier east of the village. The wreck lies on the eastern shore south of the harbour; the crawlers nest in and around it.',
      text: {
        intro: "The Grey Gull was my boat, and my father's before me, and now she is a heap of ribs on the eastern rocks with my nets still in her. The wreckers' beacon led her onto the shore — you will hear about the wreckers, if you stay — and now the tide-crawlers have moved into her hull like it was built for them. I am too old to fight crawlers. I am not too old to want to know what the sea is doing. Fish the harbour and tell me what bites; go and look at the wreck; and kill what you find living in her.",
        accept: 'The harbour first, then the wreck. The crawlers come out at the turn of the tide.',
        progress: 'What bit? Herring? Bass? And is she — is there anything left of her?',
        complete: "Herring and bass, and the crawlers gone from her ribs. Then the sea has not forgotten us, whatever the wreckers have done. Take my last shrimp, for there is no boat to use it on, and a draught the elves left with Hulda. And when you go up to the beacon — you will — think of the Gull.",
      } },

    // ---- q041 L64 · Tol Morwen · Widow Ashild, keeper of the Stone
    { id: 'q041', name: "The Widow's Wolves", type: 'side', level: L(41), zone: 'tolmorwen', giver: 'npc_morwenvillage_ashild', turnin: 'npc_morwenvillage_ashild', prereq: [],
      objectives: [
        { type: 'kill', target: 'morwen_wolf', count: 6, label: 'Hunt the island wolves that howl about the Stone at night' },
        { type: 'collect', item: 'mat_moonflower', count: 3, from: null, node: 'gn_tolmorwen_1', label: 'Gather moonflowers from the western headland to lay at the Stone' },
      ],
      rewards: R(L(41), ['n_ring_hapless', 'pot_heal_athelas']),
      summary: 'Wolves have come down to the Stone of the Hapless every night since Ashild’s husband was laid there, and she will not have them howling over him. She would have flowers laid instead.',
      hint: 'The wolves range the ground north of the village and west of the Stone. Moonflowers grow on the western headland beyond the Stone, above the cliffs.',
      text: {
        intro: "My husband is under the Stone of the Hapless with the old dead, since the wreck took him in the spring, and every night since the wolves have come down to howl over him. I keep the Stone. I keep it clean and I keep the lamp lit and I will not keep it for wolves. Hunt them — six at the least, for that is the size of the pack — and then go up onto the headland where the moonflowers grow and bring me three, for I would lay flowers where the wolves have been and I cannot climb the headland any more.",
        accept: 'The wolves at dusk, the flowers at dawn. It is not far. Nothing on this island is far.',
        progress: 'Are they quiet? I listen every night. And the flowers — three, white, from the headland.',
        complete: "It was quiet last night. The first quiet night since the spring. And the flowers — oh, they are the ones, he used to bring them. This ring was found by the Stone the day after the wreck; I have never known whose it was, and I have never been able to wear it. Perhaps it was waiting. Take it, and my thanks, which are all I have that is not sorrow.",
      } },

    // ---- q042 L66 · Forochel · Onni, net-maker of Sûri-kylä
    { id: 'q042', name: 'Ice-cod for the Long-house', type: 'side', level: L(42), zone: 'forochel', giver: 'npc_surikyla_onni', turnin: 'npc_surikyla_onni', prereq: [],
      objectives: [
        { type: 'fish', count: 5, spot: 'fs_forochel_bay', label: 'Fish the Ice-bay through the shore-ice' },
        { type: 'kill', target: 'forochel_lynx', count: 5, label: 'Kill the snow-lynxes that raid the drying-racks' },
      ],
      rewards: R(L(42), ['bait_shrimp', 'food_fish_stew']),
      summary: 'Onni’s fishers are out on the ice and the racks at Sûri-kylä are empty. Five ice-cod from the bay and fewer lynxes about the racks would see the long-house through the dark days.',
      hint: 'The Ice-bay fishing-spot is on the shore below the dock, west of the village; cast from the ice-edge. The lynxes hunt the glacier-foot west of the village.',
      text: {
        intro: "The long-house eats what the racks hold and the racks hold nothing, because the fishers are three days out on the ice and the snow-lynxes have been at what little was drying. Ice-cod, that is the food of the Lossoth — five fat ones from the bay would feed the house tonight and shame the fishers when they come home. And the lynxes: five of them at least, coming down off the glacier at dusk with their ears flat. You have a rod, I see, and a blade. Use the one, then the other.",
        accept: 'Cast from the ice-edge below the dock. If the ice cracks, do not argue with it.',
        progress: 'Five cod, and the lynxes taught manners. The racks are waiting.',
        complete: "Ice-cod! Five of them, and fat — the fishers will hear of this and be sour for a week, which is good for them. And the lynxes gone from the racks. Here is stew from the pot you have filled, and shrimp from the south that I keep for the great fish. You are Lossoth tonight, whatever you were this morning.",
      } },

    // ---- q043 L67 · Forochel · Pekka, trader of Sûri-kylä
    { id: 'q043', name: "The Wreck of the Lost King's Ship", type: 'side', level: L(43), zone: 'forochel', giver: 'npc_surikyla_pekka', turnin: 'npc_surikyla_pekka', prereq: [],
      objectives: [
        { type: 'deliver', item: 'qc_trade_ledger', npc: 'npc_surikyla_boat', label: "Bring Pekka's ledger to Sampo the ice-pilot at the landing" },
        { type: 'explore', pos: { x: 700, z: -1980 }, radius: 20, label: "Find the wreck of the Lost King's ship on the southern ice" },
        { type: 'kill', target: 'gauredain', count: 6, label: 'Drive the Gauredain raiders from Hylje-leiri, beside the wreck' },
      ],
      rewards: R(L(43), ['pot_power_celebrant', 'scroll_battle_50']),
      summary: 'Pekka’s ledger must reach the ice-pilot before the bay freezes, and the Gauredain have camped beside the wreck of the Lost King’s ship and are stripping it for firewood.',
      hint: 'Sampo stands at the Ice-bay landing west of the village. The wreck lies on the southern ice, south-east of the village beyond the Gauredain camp at Hylje-leiri.',
      text: {
        intro: "Two matters, and a trader knows to put the dull one first. My ledger — every debt of Sûri-kylä, owed and owing — must be in Sampo's hands at the landing before the bay freezes, for he sails south with it to settle the year, and I do not leave the trading-hut. Now the other. The Gauredain have camped at Hylje-leiri, on the southern ice, and they are burning the wreck of the Lost King's ship for firewood — the King of the Dúnedain who died here a thousand years gone, and whose ship the Lossoth have kept as a holy thing since. Drive them off. And look at the wreck, and tell me what is left of her.",
        accept: 'Sampo first, the ice second. Do not let the ledger get wet; the ink is not what it was.',
        progress: 'Has Sampo the ledger? And the wreck — how much of her is burnt?',
        complete: "The ledger sailed, and the Gauredain fled, and the ship — half her ribs, you say, and the stem still standing. Then the Lossoth will keep her another thousand years. You have done a trader a favour and a people a service, and I can only pay for the first: a bottle from the elves and a scroll from the south. The second is paid in another coin, and you will find it spent on your behalf in every hut in the village.",
      } },

    // ---- q044 L69 · Forochel · Väinö, hunter of Sûri-kylä (requires Book 7 to have begun)
    { id: 'q044', name: 'The Ice-hunt', type: 'side', level: L(44), zone: 'forochel', giver: 'npc_surikyla_vaino', turnin: 'npc_surikyla_vaino', prereq: ['s076'],
      objectives: [
        { type: 'kill', target: 'elder_ice_bear', count: 3, label: 'Slay the elder ice-bears of the old den on the western glacier' },
        { type: 'collect', item: 'mat_white_bear_pelt', count: 3, from: 'elder_ice_bear', label: 'Bring their white pelts to Väinö' },
      ],
      rewards: R(L(44), ['n_cloak_lossoth', 'pot_heal_athelas'], { title: 'Ice-hunter of the Lossoth' }),
      summary: 'Every winter the Lossoth hunt the old den on the western glacier, and every winter fewer come back. Väinö would have a stranger prove the hunt can still be done — and bring back the pelts to show it.',
      hint: 'The old den lies far to the west of Sûri-kylä on the glacier-edge, beyond the lynx-grounds of Jä-rannoc. The elder bears do not leave it; go to them.',
      text: {
        intro: "Among the Lossoth, a hunter is not a hunter until he has gone to the old den on the western glacier and come back with a white pelt. Last winter four went and two came back, and this winter the young ones look at the glacier and look away. If a stranger does it — a stranger who is not Lossoth, who has no reason to go — then the young ones will have no excuse, and I will have three pelts for the cloaks the long-house needs. Three elder bears. Three pelts. Come back.",
        accept: 'West, past Jä-rannoc, to the glacier-edge. The bears are old and they are not slow.',
        progress: 'Three bears, three pelts. The young ones are watching the glacier for you.',
        complete: "Three pelts. White as the bay-ice, and every one from an elder. The young ones saw you come down off the glacier; there will be four of them at the den by the next moon, and they will come back, because they will be ashamed not to. This cloak is sealskin, the Lossoth make, and it is yours, Ice-hunter — that is the name, and it is not given twice.",
      } },

    // ---- q045 L70 · Forochel · Kalevi, rune-singer of the long-house
    { id: 'q045', name: 'Songs of the Long Dark', type: 'side', level: L(45), zone: 'forochel', giver: 'npc_surikyla_kalevi', turnin: 'npc_surikyla_kalevi', prereq: [],
      objectives: [
        { type: 'talk', npc: 'npc_surikyla_lauri', label: 'Hear the reindeer-herder’s tale of the long dark' },
        { type: 'talk', npc: 'npc_surikyla_eero', label: 'Hear the spearman’s tale of the long dark' },
        { type: 'talk', npc: 'npc_surikyla_aila', label: 'Hear the child’s tale of the long dark' },
      ],
      rewards: R(L(45), ['drink_lossoth_tea', 'scroll_fortune_50']),
      summary: 'The rune-singer of Sûri-kylä is making the song for the winter that has not yet come, and wants three tales of the last one: from a herder, a spearman and a child.',
      hint: 'Lauri keeps the reindeer-pens south of the long-house, Eero stands watch on the north side of the village, and Aila plays by the long-house door.',
      text: {
        intro: "Every year before the long dark, the rune-singer makes the song that will carry the village through it — and the song is made of the last dark, of what people remember. Lauri remembers the reindeer. Eero remembers the wolves. Aila remembers — I do not know what a child remembers; that is why I need her. They will not speak of it to me, for the rune-singer is a thing you do not talk to in daylight. But you are a stranger, and a stranger is a thing you do talk to. Bring me their three tales, and I will make the song.",
        accept: 'The herder, the spearman, the child. Let each finish; the ending is the part they hide.',
        progress: 'Three tales. What did Aila say? A child says the true thing by accident.',
        complete: "The reindeer that walked into the sea. The wolf at the door with a man's eyes. And the child — the child said the dark was warm, because everyone was inside it together. That is the song. That is the whole song; the rest is only tune. Drink this, for the cold you have walked through, and take this scroll, for the luck you have brought us.",
      } },

    // ---- q046 L72 · Tol Fuin · Berion, shipwrecked mariner of Ost Fuin (Book 8 must have sailed)
    { id: 'q046', name: 'Lanterns of the Western Ruins', type: 'side', level: L(46), zone: 'tolfuin', giver: 'npc_ostfuin_berion', turnin: 'npc_ostfuin_berion', prereq: ['s089'],
      objectives: [
        { type: 'use', node: 'gn_tolfuin_1', count: 3, label: 'Relight the elven lanterns among the western ruins' },
        { type: 'kill', target: 'fuin_spider', count: 5, label: 'Clear the Fuin spiders that have darkened the ruins' },
      ],
      rewards: R(L(46), ['pot_heal_athelas', 'scroll_warding_50']),
      summary: 'Berion was wrecked on the western cliffs and would have died there but for a light in the ruins that has since gone out. He wants the lanterns lit again for the next poor sailor — and the spiders that put them out dealt with.',
      hint: 'The western ruins lie on the far side of the island from the haven, west-north-west across the mallorn grove. The lanterns stand among the fallen walls; the spiders nest just south of them.',
      text: {
        intro: "I came ashore on the western cliffs in a storm that broke my ship like an egg, and I would have died on the rocks but for a light — a silver light among the old ruins, that showed me the path up. The elves say those lanterns have burned since Beleriand drowned. They are dark now. The spiders have come into the ruins and webbed them over, and the next sailor the sea throws onto those rocks will find no light at all. Relight them. Three of them, and kill the spiders that put them out. I owe the ruins a life; let me pay a little of it through you.",
        accept: 'West across the island, past the mallorns. The lanterns will take a flame if you ask them right.',
        progress: 'Three lanterns lit and the spiders gone. I stand on the sea-watch every night now, looking for the light.',
        complete: "I saw it! Last night, from the sea-watch — three silver lights on the western cliffs, where there had been only dark. Some sailor will see that one day and live, as I lived. The elves gave me these when they found me; I have kept them for the day I could give something back. This is that day.",
      } },

    // ---- q047 L73 · Tol Fuin · Sírwen, net-mender of Ost Fuin (Book 8 must have sailed)
    { id: 'q047', name: "The Serpent's Cove", type: 'side', level: L(47), zone: 'tolfuin', giver: 'npc_ostfuin_fishing', turnin: 'npc_ostfuin_fishing', prereq: ['s089'],
      objectives: [
        { type: 'fish', count: 5, spot: 'fs_tolfuin_cove', label: 'Fish the shallows of the Serpent’s Cove' },
        { type: 'kill', target: 'fuin_orc_raider', count: 5, label: 'Drive the orc-raiders from the landing above the cove' },
        { type: 'collect', item: 'mat_serpent_scale', count: 3, from: 'fuin_orc_raider', label: 'Take back the serpent-scales the raiders have gathered from the shingle' },
      ],
      rewards: R(L(47), ['n_ring_serpent', 'bait_shrimp'], { title: 'Serpent-fisher of Tol Fuin' }),
      summary: 'The best sea-bass on Tol Fuin run in the Serpent’s Cove, and the orc-raiders camped above it have been stealing the catch — and the serpent-scales that wash up on the shingle. Sírwen wants the bass, the raiders gone, and three scales to weight her nets.',
      hint: 'The Serpent’s Cove is on the south coast of the island, south of the haven. The raiders camp at their landing on the western cliffs above the cove; the cove itself is fished from the shingle. Stay out of the surf — the serpent’s brood lies in it.',
      text: {
        intro: "There are sea-bass in the Serpent's Cove as long as your arm, and no elf of Ost Fuin has cast a line there in a season, because the orc-raiders have made their landing on the cliffs above it and take whatever comes out of the water — fish, nets, and the serpent-scales that wash up on the shingle after a storm. I do not ask you to go into the surf; the serpent's brood lies there, and the great serpent herself beyond. I ask you to fish the shallows from the shingle — five bass, if the cove will give them — to drive the raiders from their landing, and to take back three of the scales they have gathered, for a net weighted with serpent-scale sinks true and never fouls.",
        accept: 'South along the coast to the cove; the raiders are on the cliffs to the west of it. Stay on the shingle. Do not go into the surf.',
        progress: 'Five bass and three scales. And do not look out to sea for too long; she looks back.',
        complete: "Bass — and look at the size of them — and three scales that shine like the sea at evening, back from the raiders' sacks. The nets I weight with these will fish for my grandchildren. This ring was made from the first scale ever taken in that cove, long ago, by one who did not come back for it. It is fitting that a fisher of the cove should wear it. Serpent-fisher, the haven will call you; the name is older than you think.",
      } },

    // ---- q048 L75 · Himling · Osbeorn, wounded soldier of Ras Himling (Book 8 must have sailed)
    { id: 'q048', name: "Osbeorn's Debt", type: 'side', level: L(48), zone: 'himling', giver: 'npc_rashimling_wounded', turnin: 'npc_rashimling_wounded', prereq: ['s089'],
      objectives: [
        { type: 'kill', target: 'himling_uruk', count: 6, label: 'Slay the Uruks of the Gaunt-lord who hold the southern lines' },
        { type: 'explore', pos: { x: -1720, z: -560 }, radius: 20, label: 'Reach the Old Watchtower where Osbeorn’s company fell' },
      ],
      rewards: R(L(48), ['pot_heal_lostkingdom', 'food_isles_feast']),
      summary: 'Osbeorn’s company held the Old Watchtower against the Uruks until only he came back. He cannot go back up; he would have someone go for him, and make the Uruks pay the difference.',
      hint: 'The Uruk lines lie south-west of the camp across the heath. The Old Watchtower stands on the southern headland beyond them.',
      text: {
        intro: "Twelve of us went up to the Old Watchtower to hold it until the captain could bring the rest of the company, and the Uruks came up the headland in the dark, and I came back. Only I. I have a leg that will not carry me and a debt I cannot pay lying, and the captain will not hear of a wounded man on the lines. So I ask you. Go up to the tower — go all the way, to the top, where we held — and on the way, kill six of the Uruks who took it. One for every two of mine. I will settle the rest myself, when the leg is mended.",
        accept: 'South-west across the heath, then up the headland. They hold the lines below the tower; you will have to go through.',
        progress: 'Six of them, and the tower reached. Is the standard still there? Ours was blue.',
        complete: "The standard was still there. Blue. Then they did not take it down, and the tower is still ours in the only way that matters. Six of them — one for two — and the rest are mine. Take these; the quartermaster gave them to me for the leg and I would rather they went to someone who used them on the headland. And thank you. I can sleep now.",
      } },

    // ---- q049 L76 · Himling · Hallam, quartermaster of Ras Himling (Book 8 must have sailed)
    { id: 'q049', name: 'Driftwood for the Palisade', type: 'side', level: L(49), zone: 'himling', giver: 'npc_rashimling_quartermaster', turnin: 'npc_rashimling_quartermaster', prereq: ['s089'],
      objectives: [
        { type: 'collect', item: 'mat_yew_bough', count: 4, from: null, node: 'gn_himling_5', label: 'Gather yew driftwood from the southern strand' },
        { type: 'kill', target: 'himling_warg', count: 5, label: 'Kill the wargs of Himling that hunt the strand' },
      ],
      rewards: R(L(49), ['pot_power_lostkingdom', 'food_isles_feast']),
      summary: 'The palisade of Ras Himling is rotting and there is not a living tree on the island. The only timber is driftwood on the southern strand, and the wargs hunt there.',
      hint: 'The driftwood lies on the strand south of the camp, below the Old Watchtower headland. The wargs come down onto it from the heath to the east.',
      text: {
        intro: "Do you see the palisade? Do you see the gap in the palisade? That gap was a wall last week, and next week the gap will be the whole south side, because the timber the ships brought was green and the sea-wind has rotted it. There is not a tree on Himling; there has not been since the Elder Days. But the strand south of the camp is full of yew driftwood — old, hard, salt-cured, better than anything we brought — and the wargs hunt it at dusk. Four good boughs and five dead wargs, and the wall stands.",
        accept: 'South to the strand, below the headland. Yew, not pine — pine floats; yew is the stuff that does not.',
        progress: 'Four boughs. Yew. And the wargs — five, or they will be at the gap before the wood is.',
        complete: "Yew — and old, look at the grain; that came off a ship that sank before Bree was built. The gap will be closed by nightfall and the wargs will find nothing on the strand but their dead. This is the last of the good wine and the last of the feast the elves sent from Tol Fuin; the captain does not know I have them, and now neither do I.",
      } },

    // ---- q050 L78 · Himling · Brokk, field-smith of Ras Himling (Book 8 must have sailed)
    { id: 'q050', name: 'Black Drake-scale', type: 'side', level: L(50), zone: 'himling', giver: 'npc_rashimling_smith', turnin: 'npc_rashimling_smith', prereq: ['s089'],
      objectives: [
        { type: 'collect', item: 'mat_drake_scale', count: 4, from: 'himling_drake', label: 'Take scales from the black drakes of the fallen towers' },
        { type: 'kill', target: 'himling_sorcerer', count: 5, label: 'Slay the Gaunt-cultists who tend the drakes' },
      ],
      rewards: R(L(50), ['n_cloak_himring', 'pot_heal_lostkingdom'], { title: 'Drake-slayer of Himling' }),
      summary: 'Brokk can forge armour that will turn the Gaunt-lord’s sorcery — but only from the scales of the black drakes the cultists breed among the fallen towers. Four scales, and the cultists dead.',
      hint: 'The fallen towers are on the eastern side of the island, south-east of the fortress; the drakes roost among them, and the Gaunt-cultists gather on the headland north-east of the towers.',
      text: {
        intro: "The Gaunt-lord's sorcery goes through iron like it was linen; I have seen it. I have seen it go through mithril. But it does not go through drake-scale — black drake-scale, from the beasts the cultists breed in the fallen towers on the east of the island — and if I had four scales I could make the captain a shirt that would let him stand in front of Draugmar and not die at once. Four scales. And the cultists who tend the drakes: five of them dead, so there are no more drakes after these. Then we go up to the fortress with something better than hope.",
        accept: 'East, past the barrows, to the fallen towers. The cultists are on the headland above; the drakes below. Take the cultists first, or the drakes will be fed.',
        progress: 'Four scales, unbent, and five cultists. It is the whole island’s hope you are carrying; carry it carefully.',
        complete: "Black as night and hard as the Gaunt-lord's heart, and four of them. The shirt will be done by dawn, and the captain will wear it to the gate. This cloak came out of the fortress with the last of the Himring guard, a thousand years ago, and I have carried it from forge to forge waiting for a back it fit. Drake-slayer — it fits. Wear it up the hill.",
      } },
  ];

  G.Data.quests.push(...Q);
  G.Data.questById = G.Data.questById || {};                     // mirror our ids (24_quests rebuilds the map at init)
  for (const q of Q) G.Data.questById[q.id] = q;
  if (typeof G.Data.registerQuests === 'function') G.Data.registerQuests(Q);
})();
