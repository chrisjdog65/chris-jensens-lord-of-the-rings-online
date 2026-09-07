/* ==== 06_data_quests_c.js — Side quests q001–q050 for Chris Jensen's Lord of the Rings Online (data only).
   Fifty self-contained local stories given by town flavour / vendor / fisher / guard NPCs (never the ★ hub story-givers),
   spread over all 15 zones (≈ 3–4 per mainland zone, 2–3 per island) at levels 2–78 (level = G.Data.xp.sideLevel(i),
   ascending by id). Schema per SPEC §4.7; every npc / monster / boss / node / spot / poi id is a 05_data_world id, every
   reward item id is a 03_data_items id. Ten quest-specific items (ids `qc_*`) are registered here with G.Data.addItem
   before the quests. At most ten quests carry a story prerequisite (a lower-level story quest) — the Sundered-Isles side
   quests wait for s089, a few others for the first quest of their Book.
   Public API: pushes onto G.Data.quests; calls G.Data.registerQuests(list) when 24_quests / another data module defines it.
   Objective-type census (checked by tools/scratch/quests_c_check.js): kill 32 · collect-from 14 · collect-node/use 21 ·
   talk 10 · explore 19 · deliver 5 · fish 8 · killboss 3. ==== */
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
