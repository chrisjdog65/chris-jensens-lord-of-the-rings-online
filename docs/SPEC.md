# ARCHITECTURE SPEC — Chris Jensen's Lord of the Rings Online (single-file build)

This document is the CONTRACT between every module. Read ALL of it before writing a module.
If you need something another module owns, call the API documented here — do not re-implement it,
and do not invent new globals. If you must add a helper other modules could use, put it on your
own namespace (e.g. `G.Terrain.foo`) and document it in a comment block at the top of your file.

## 0. Hard constraints

* Final product is ONE self-contained HTML file (`node build.js` → `dist/Chris-Jensens-LOTRO.html`).
  It must run from `file://` with NO network: no `fetch`, no `import`, no external images/audio/fonts
  (the Google Fonts `@import` in the CSS is the only allowed external reference; it fails gracefully).
* Three.js **r160 UMD** is inlined and available as the global `THREE`. There is NO `examples/jsm` —
  no OrbitControls, no EffectComposer, no BufferGeometryUtils, no GLTFLoader. Write what you need
  (core exposes `G.mergeGeometries`). r160 notes: `renderer.outputColorSpace` defaults to sRGB;
  lights are physically based (PointLight intensity ≈ 20–200 with `decay=2`, DirectionalLight 1–4,
  Ambient/Hemisphere 0.3–1.5); `Color.setHex` interprets hex as sRGB.
* Plain ES2020 browser JavaScript. Each module file is wrapped: `(function(){ 'use strict'; ... })();`
  Modules are concatenated in ALPHABETICAL FILE ORDER as separate `<script>` tags (see §1).
  A module may reference namespaces of LATER modules only inside functions that run after
  `G.emit('init')` (never at top level). Data modules (02_–06_) are pure data + pure functions.
* Everything lives under the single global `window.G`. Nothing else pollutes `window` except
  `THREE` and the test hook `window.__T` (owned by 99_main).
* Performance target: 60 FPS on a mid-range GPU at 1080p. Budget: ≤ 600 draw calls, ≤ 1.5M
  triangles in view, ≤ 4 ms of JS per frame. Pool objects; never allocate Vector3s in hot loops
  (use module-level temp vectors). Never use `Date.now()` for game time — use `G.time.now` (seconds).
* No `alert/prompt/confirm`. No console spam: `G.log()` (debug-gated) for diagnostics, `console.warn`
  only for genuine misconfiguration, never `console.error` in normal operation (the smoke test fails on it).
* All user-facing text in English, Middle-earth flavoured. The game is called
  **"Chris Jensen's Lord of the Rings Online"**.

## 1. Modules, load order, ownership

| file | namespace | owns |
|---|---|---|
| `00_core.js` | `G` root, `G.C`, `G.Input`, `G.Spatial`, `G.time`, utils | event bus, RNG, math, noise, geometry merge, input, spatial hash, error capture |
| `01_audio.js` | `G.Audio` | Web Audio synth: SFX library + procedural music themes |
| `02_data_races_classes.js` | `G.Data.races`, `G.Data.classes`, `G.Data.stats`, `G.Data.xp` | 10 races, 10 classes, stat formulas, XP table (cap 80), name generator |
| `03_data_items.js` | `G.Data.items`, `G.Data.sets`, `G.Items` | item templates, gear sets, item generation, loot tables, vendors' stock |
| `04_data_abilities.js` | `G.Data.abilities` | every class's abilities (13 each, unlock levels, gold cost, effects) |
| `05_data_world.js` | `G.Data.world` | zones, towns, roads, NPC registry, monster types, spawn areas, buildings, docks/boat routes, fishing spots, POIs |
| `06_data_quests.js` | `G.Data.quests` | 100 story quests + 50 side quests (data only) |
| `10_terrain.js` | `G.Terrain` | heightmap function, chunked terrain meshes, water, textures, zone lookup |
| `11_sky.js` | `G.Sky` | sky dome, sun/moon, day-night, clouds, weather (rain/snow), fog, lighting rig |
| `12_vegetation.js` | `G.Veg` | instanced grass/trees/rocks/flowers/mushrooms with wind, LOD, tree colliders |
| `13_buildings.js` | `G.Buildings` | procedural buildings with real interiors, doors, furniture, props, camp/ruins/docks/bridges, colliders |
| `14_characters.js` | `G.Chars` | procedural humanoid rigs (10 races × 2 genders), gear visuals, monsters, horses, boats, animation |
| `15_physics.js` | `G.Physics` | colliders, gravity, ground/water/slope, capsule collision, camera occlusion raycast |
| `16_fx.js` | `G.FX` | pooled particles, slash arcs, beams, projectile trails, level-up, weather-independent VFX |
| `17_postfx.js` | `G.PostFX` | render-target pipeline: bloom + ACES tonemap + FXAA + vignette + colour grade; quality presets |
| `20_player.js` | `G.Player` | third-person controller & camera, WASD, jump, dodge roll, mount, swim, interact, targeting |
| `21_combat.js` | `G.Combat`, `G.Progress` | damage/heal/effects/buffs/dots, ability execution, projectiles, death/respawn, XP/levels/loot |
| `22_monsters.js` | `G.Monsters` | spawn areas, monster AI (wander/aggro/chase/attack/leash), bosses, respawn |
| `23_npcs.js` | `G.NPCs` | NPC entities, quest markers, dialogue, vendors, trainers, stable-masters, boat-masters, innkeepers |
| `24_quests.js` | `G.Quests`, `G.AutoQuest` | quest state machine, tracker data, objective markers, **auto-quest bot (B)** |
| `25_aiplayers.js` | `G.AIPlayers` | 150 simulated players (LOD sim), chat, emotes, live progression, P-panel data |
| `26_fishing_boats.js` | `G.Fishing`, `G.Boats` | fishing minigame (F), boats & sailing & docks fast travel |
| `30_ui_hud.js` | `G.UI` (root) + HUD | panel manager, tooltip, notifications, floating text, hotbar, frames, buffs, castbar, chat, quest tracker, minimap, interact prompt, death screen |
| `31_ui_panels.js` | `G.UI.Inventory/Character/Abilities/Journal/Map/Players/Dialogue/Vendor/Travel/Settings/Loot` | all windowed panels |
| `32_ui_admin.js` | `G.UI.Admin` | admin panel (type `chris`) |
| `33_ui_charcreate.js` | `G.UI.Menu`, `G.UI.CharCreate` | loading screen, main menu, character creation with 3D preview |
| `34_save.js` | `G.Save` | localStorage save/load/export/import, autosave |
| `99_main.js` | `G.Game`, `window.__T` | renderer, scene, boot, main loop order, quality auto-tuning, test hooks |

Ownership rule: only the owner writes into its namespace. Everyone may READ `G.state`.
Mutations of `G.state.player` go through `G.Player`/`G.Combat`/`G.Progress`/`G.Items` APIs.

## 2. Core (`00_core.js`)

```js
G = window.G = {
  VERSION: '1.0.0',
  C: { /* constants, see below */ },
  state: { /* runtime state, see §3 */ },
  time: { now: 0, dt: 0, frame: 0, dayTime: 8.0 /* hours 0-24 */, dayLengthMinutes: 24, scale: 1, paused: false },
  errors: [],                          // captured error strings (window.onerror + unhandledrejection)
  debug: false,
  log(...args) {},                     // console.log when G.debug
  on(evt, fn), off(evt, fn), emit(evt, ...args), once(evt, fn),
  // math
  clamp(v,a,b), lerp(a,b,t), smoothstep(a,b,x), mod(a,n), rad(deg), deg(rad),
  angleLerp(a,b,t), wrapAngle(a),      // radians, shortest path
  dist2(x1,z1,x2,z2), dist3(v1,v2), dist2v(v1,v2) /* xz only */,
  // random
  seed(n),                             // reseed G.rand (mulberry32), default seed 1337
  rand(), randInt(a,b), randRange(a,b), pick(arr), shuffle(arr), chance(p), rng(seed) /* returns new fn */,
  hash2(x,z) /* deterministic 0..1 */, hashStr(s) /* 32-bit int */,
  // noise (simplex 2D, deterministic, no allocation)
  noise2(x,z) /* -1..1 */, fbm(x,z,octaves=4,lacunarity=2,gain=0.5) /* -1..1 */, ridged(x,z,octaves),
  // three helpers
  mergeGeometries(geoms /* BufferGeometry[] with position/normal/uv, optional color; index optional */),
  colorHex(h) /* cached THREE.Color */, tmpV3(i) /* 8 pooled Vector3s, index 0-7 */,
  canvasTexture(w,h,drawFn(ctx,w,h), opts={repeat:[1,1],wrap:true,nearest:false}) /* returns THREE.Texture */,
  uid() /* 'u' + counter */, fmtNum(n) /* 1,234 */, fmtMoney(copper) /* '12g 34s 56c' → see G.C.MONEY */,
  fmtTime(sec) /* 'm:ss' */, titleCase(s), lerpColor(hexA,hexB,t) /* returns hex int */,
  el(tag, attrs={}, children=[]) /* DOM builder: attrs {class,id,text,html,style,onclick,...}, children: nodes|strings */,
  $(sel), $$(sel),
  Input: { /* see below */ },
  Spatial: { /* see below */ },
};
```

### Constants `G.C`
```js
G.C = {
  WORLD_SIZE: 4096,           // terrain spans x,z ∈ [-2048, 2048]
  SEA_LEVEL: 0,               // y of water surface (terrain below 0 is under water)
  LEVEL_CAP: 80,
  INVENTORY_SLOTS: 200,
  HOTBAR_KEYS: ['1','2','3','4','5','6','7','8','9','0','G','T','V','X','Y','Z','L','N','O','U'],  // 20 slots
  RUN_SPEED: 6.5, WALK_SPEED: 2.5, MOUNT_SPEED: 15, SWIM_SPEED: 3, ROLL_SPEED: 10, ROLL_TIME: 0.55, ROLL_CD: 3,
  JUMP_VEL: 6.5, GRAVITY: -20,
  PLAYER_RADIUS: 0.4,
  INTERACT_RANGE: 4, MELEE_RANGE: 3.2, RANGED_RANGE: 30, AGGRO_RANGE: 14,
  ENTITY_RENDER_DIST: 220, MONSTER_SPAWN_DIST: 260, NPC_RENDER_DIST: 200, AIPLAYER_RENDER_DIST: 180, MAX_RENDERED_CHARS: 40,
  MONEY: { SILVER: 100, GOLD: 100000 },  // copper per silver / per gold  (100c = 1s, 1000s = 1g)
  RARITY: ['common','uncommon','rare','incomparable','legendary'],
  RARITY_COLOR: { common:'#d9d9d9', uncommon:'#ffe86b', rare:'#c48bff', incomparable:'#52b7ff', legendary:'#ff9c3a' },
  EQUIP_SLOTS: ['head','shoulder','back','chest','hands','legs','feet','mainhand','offhand','ranged','neck','ear1','ear2','wrist1','wrist2','ring1','ring2','pocket'],
  ADMIN_CODE: 'chris',
  SAVE_KEY: 'cj_lotro_save_v1',
};
```

### Input `G.Input`
* `G.Input.init(canvas)`; `G.Input.keys` = `Set` of `KeyboardEvent.code` currently down;
  `G.Input.down(code)`, `G.Input.pressed(code)` (true for the frame the key went down),
  `G.Input.consume(code)`; `G.Input.mouse = {x, y, dx, dy, wheel, buttons, locked}` — `dx/dy/wheel` are
  per-frame deltas and reset by `G.Input.endFrame()` (called by main loop AFTER all updates).
* Key events are ignored (not tracked) while `G.Input.typing` is true (focus in an input/textarea) —
  set/unset automatically via focus listeners on `document`.
* Pointer lock: `G.Input.requestLock()`, `G.Input.exitLock()`; `G.Input.mouse.locked`. Main game
  logic: clicking the canvas requests lock; opening any panel exits lock (§8). When not locked, RMB-drag
  still rotates the camera (`G.Input.mouse.dx` is computed from movement while `buttons & 2`).
* Sequence detector: `G.Input.onSequence('chris', fn)` — fires when the last typed letters equal the
  sequence (letters only, within 3 s), regardless of pointer lock.
* `G.Input.keyName(code)` → display label ('W', '1', 'Space', 'Tab').
* Keyboard events must `preventDefault()` for Tab, Space, and all bound keys so the browser doesn't scroll/focus.

### Spatial hash `G.Spatial`
Cell size 32. `G.Spatial.insert(ent)`, `remove(ent)`, `update(ent)` (call when moved across cells; cheap),
`query(x, z, radius, filterFn?)` → array (reused buffer — copy if you keep it), `nearest(x, z, radius, filterFn?)`.
Entities must have `pos` (Vector3) and `id`.

### Event names (emit/on)
`init` (all modules constructed, before scene build) · `sceneReady` · `gameStart` (player entered world) ·
`update` (dt) — fired by main loop after fixed systems, for anything not in the explicit order ·
`playerLevelUp` (level) · `playerDeath` · `playerRespawn` · `entityKilled` ({victim, killer}) ·
`itemGained` ({item, count}) · `questAccepted` (id) · `questProgress` (id) · `questCompleted` (id) ·
`zoneChanged` (zoneId) · `panelOpened` (id) · `panelClosed` (id) · `chat` ({channel, from, text}) ·
`dayPhase` ('dawn'|'day'|'dusk'|'night') · `weatherChanged` (kind) · `save` · `load` ·
`abilityTrained` (id) · `equipChanged` · `inventoryChanged` · `goldChanged` · `mounted` (bool) · `combatStart` · `combatEnd`.

## 3. Runtime state `G.state`

```js
G.state = {
  phase: 'loading' | 'menu' | 'create' | 'playing',
  player: Entity /* see below; created by G.Player.create(charSpec) */,
  entities: [],  byId: {},          // ALL live entities (player, npcs, monsters, aiplayers, doors, props with interaction)
  zone: 'shire',                    // current zone id of the player
  inCombat: false,
  quality: 'high',                  // 'ultra'|'high'|'medium'|'low' (G.PostFX.setQuality applies it)
  settings: { music: 0.6, sfx: 0.8, mouseSens: 1.0, invertY: false, showFps: false, cameraDist: 7, shadows: true },
  weather: 'clear',
  fishingSkill: 1,                  // 1..100
  stats: { kills: 0, quests: 0, fish: 0, deaths: 0, playTime: 0 },
};
```

### Entity (shared shape, plain object)
```js
{
  id: 'u12', kind: 'player'|'npc'|'monster'|'aiplayer'|'door'|'chest'|'node'|'boat'|'fishspot'|'mount',
  name, title?, level, race?, cls?, gender?, typeId? /* monster/npc type id */,
  pos: THREE.Vector3, yaw: 0 /* radians, 0 = facing -Z */, vel: THREE.Vector3, radius: 0.4, height: 1.8,
  onGround: true, inWater: false, swimming: false,
  stats: { might, agility, vitality, will, fate, maxMorale, maxPower, armour, physMastery, tactMastery, crit, finesse, block, parry, evade, resist, moraleRegen, powerRegen, speed },
  morale, power, alive: true, dead: false, deathTime,
  effects: [ { id, name, kind:'buff'|'debuff'|'dot'|'hot'|'stun'|'root'|'slow', stat?, amount?, tick?, remaining, total, icon, src } ],
  cooldowns: { [abilityId]: readyAtTime },
  target: Entity|null, threat: Map|Object, hostile: bool, faction: 'free'|'enemy'|'neutral',
  mesh: THREE.Group|null /* built lazily by owner when within render distance */, rig: CharRig|null,
  anim: 'idle', animTime: 0,
  ai: { state, ... } /* owner-specific */,
  interact?: { label: 'Talk', range: 4, fn(ent) } /* for E key */,
  // player-only:
  xp, gold /* copper */, inventory: Array(200), equipment: {slot: ItemInstance|null}, abilities: Set<abilityId>, hotbar: Array(20) of abilityId|null,
  mounted: false, mountId, mounts: [tid...], titles: [], activeTitle,
}
```

## 4. Data schemas

### 4.1 Races (`G.Data.races`) — array of 10, in this order & with these ids
`man` (Man), `elf` (Elf), `dwarf` (Dwarf), `hobbit` (Hobbit), `highelf` (High Elf), `beorning` (Beorning),
`stoutaxe` (Stout-axe Dwarf), `riverhobbit` (River Hobbit), `dunedain` (Dúnadan), `rohirrim` (Rohirrim).
```js
{ id, name, plural, desc (2-3 sentences), homeZone: zoneId, startTown: townId, startPos: {x,z},
  statBonus: {might, agility, vitality, will, fate} /* +/- */, height: 1.0 /* scale, hobbit .75, dwarf .85, elf 1.05 */,
  build: 'slim'|'normal'|'stocky', skinTones: [hex...], hairColors: [hex...], hairStyles: 5 /* count */,
  racialTrait: { name, desc }, namesM: [syllable lists], namesF: [...], surnames: [...] }
```
`G.Data.randomName(raceId, gender)` → string.

### 4.2 Classes (`G.Data.classes`) — array of 10, ids:
`guardian`, `champion`, `captain`, `hunter`, `burglar`, `minstrel`, `loremaster`, `runekeeper`, `warden`, `brawler`.
```js
{ id, name, desc, role: 'tank'|'dps'|'support'|'healer', mainStat: 'might'|'agility'|'will',
  armourType: 'heavy'|'medium'|'light', weaponTypes: ['sword','axe','mace','dagger','spear','bow','crossbow','staff','runestone','gauntlets','shield','halberd','javelin','instrument'],
  baseStats: {might, agility, vitality, will, fate}, perLevel: {might, agility, vitality, will, fate},
  moralePerLevel, powerPerLevel, baseMorale, basePower, rangedWeapon: 'bow'|'crossbow'|'javelin'|'throwing'|'runestone'|'staff' /* used by R */,
  color: hex /* class colour for UI */, icon: '⚔' }
```

### 4.3 Stats (`G.Data.stats`)
`G.Data.stats.compute(entity)` recomputes `entity.stats` from race+class+level+equipment+effects and returns it.
Derived formulas (LOTRO-like, tune for fun): maxMorale = baseMorale + moralePerLevel*L + vitality*3 + gear; maxPower = basePower + powerPerLevel*L + will*2;
physMastery = might*2 + agility*1 (+gear) ; tactMastery = will*2 (+gear); crit = fate*1.5 (+gear) → critChance% = crit/(crit+ 40*L+200)*100 capped 25;
armour from gear → mitigation% = armour/(armour + 30*L + 100) capped 60; block/parry/evade%: rating/(rating+40*L+300) cap 20 each (block needs shield).
`G.Data.stats.STAT_NAMES` = display names map. `G.Data.xp.forLevel(L)` → total XP needed to reach L (L=1 → 0); cap 80; curve such that
completing all 150 quests (+ their kills) lands at ~80. `G.Data.xp.killXP(monsterLevel, playerLevel)`.

### 4.4 Items (`G.Data.items` = map id → template, `G.Items` = functions)
```js
Template: { id, name, type: 'weapon'|'armour'|'jewellery'|'consumable'|'material'|'quest'|'fish'|'misc'|'mount'|'bait',
  slot: (one of G.C.EQUIP_SLOTS or null), subtype: 'sword'|...|'shield'|'cloak'|'food'|'potion'|'scroll'|null,
  armourType: 'light'|'medium'|'heavy'|null, level: minLevel, ilvl, rarity, classes: null|[clsIds],
  stats: { might, agility, vitality, will, fate, maxMorale, maxPower, armour, physMastery, tactMastery, crit, finesse, block, parry, evade } (any subset),
  dmg: { min, max, type:'common'|'beleriand'|'westernesse'|'ancientDwarf'|'fire'|'light'|'lightning'|'frost' } | null, speed: 1.0..3.0 (weapon swing s),
  set: setId|null, value: copper, maxStack: 1|20|100, icon: '🗡' (emoji or single unicode glyph), iconBg: hex (icon tile colour),
  desc, flavor?, use?: { kind:'heal'|'power'|'buff'|'teleport'|'learnMount'|'summon', amount, stat, duration, cd },
  visual?: { weaponShape:'sword'|'axe'|'mace'|'dagger'|'spear'|'bow'|'crossbow'|'staff'|'shield'|'runestone'|'gauntlets'|'halberd'|'javelin'|'lute', color: hex, glow?: hex } }
Instance: { uid, tid, count, ilvl?, rarity?, stats? /* rolled overrides for generated gear */, name? }
```
`G.Items.create(tid, count=1)` → instance; `G.Items.get(inst)` → merged view (template + overrides, `.stats` final);
`G.Items.generate({level, slot?, rarity?, cls?, seed?})` → instance of procedurally named/rolled gear;
`G.Items.bestInSlot(level, cls, slot)` → instance (legendary, ilvl = level*10+); `G.Items.bestSet(level, cls)` → array covering all 18 slots;
`G.Items.addToInventory(player, inst)` → bool (stacks; false if full; emits `itemGained`, `inventoryChanged`); `G.Items.removeFromInventory(player, tid, count)`;
`G.Items.countInInventory(player, tid)`; `G.Items.equip(player, slotIndex)`; `G.Items.unequip(player, slot)`; `G.Items.canEquip(player, inst)` → {ok, reason};
`G.Items.use(player, slotIndex)`; `G.Items.sellValue(inst)`; `G.Items.tooltipHTML(inst, player)`; `G.Items.compare(inst, equipped)`.
`G.Items.lootFor(monsterType, level)` → [instances] + `gold` via `G.Items.rollGold(level)`; `G.Items.vendorStock(vendorKind, level)` → [tid].
Gear sets `G.Data.sets`: map setId → `{ id, name, pieces:[tids], bonuses: { 2:{stats}, 4:{stats}, 6:{stats} }, desc }`.
Required sets (per armour type × tiers): starter (L1), Wanderer's (L10), Bree-land Militia (L20), Ranger's (L30), Annúminas (L40),
Rivendell (L50), Moria-forged (L60), Angmar-bane (L70), **Armour of the Lost Kingdom** (L80 legendary; 2 pcs per class-armour-type + weapons + jewellery = complete 18-slot best-in-game set;
awarded by the final story quest). Also ~150 stand-alone named items across levels, consumables (food/potions/scrolls), 12 fish, materials, 8 mounts.

### 4.5 Abilities (`G.Data.abilities` = map id → ability; `G.Data.abilitiesFor(clsId)` → sorted array)
```js
{ id: 'champion_blade_storm', cls, name, icon, level (unlock: the 13 unlock levels are 1,1,4,8,12,16,20,26,32,40,50,60,70), cost (copper to train; L1 ones are free),
  power (power cost), cooldown (s), castTime (0 = instant), range (m; 3.2 melee, 30 ranged), gcd: true,
  kind: 'melee'|'ranged'|'tactical'|'heal'|'buff'|'debuff'|'aoe'|'taunt'|'summon'|'stance',
  effects: [ {type:'damage', mult, dtype:'common'|'fire'|'light'|'frost'|'lightning'|'beleriand', aoe?: radius},
             {type:'heal', mult|amount, target:'self'|'target'|'party'}, {type:'buff'|'debuff', stat, amount|pct, duration, target},
             {type:'dot'|'hot', mult, duration, tick}, {type:'stun'|'root'|'slow', duration, pct?}, {type:'knockback', force}, {type:'pet'?}],
  anim: 'slash'|'thrust'|'spin'|'cast'|'shoot'|'shout'|'block', vfx: fxKind (§5.7), sfx: sfxName (§5.9),
  desc (with numbers derived), tooltip?: fn(ent) → html }
```
Damage of a `damage` effect = `mult * (kind melee/ranged ? physMastery : tactMastery)/4 + weaponAvg` with variance ±15%, crit ×1.6.

### 4.6 World registry (`G.Data.world`) — see §9 for the layout; schema:
```js
G.Data.world = {
  zones: [{ id, name, level:[min,max], center:{x,z}, radius, biome:'shire'|'breeland'|'forest'|'barren'|'downs'|'lake'|'elven'|'mountain'|'dark'|'arctic'|'island', 
            baseHeight, roughness, mountain (0..1), treeDensity, treeTypes:['oak','pine','birch','willow','dead','snowpine','mallorn'], grassColor, groundColor, fogColor, music: themeId, weatherWeights: {clear, cloudy, rain, snow, storm}, desc }],
  towns: [{ id, name, zone, pos:{x,z}, radius, style:'hobbit'|'man'|'elf'|'dwarf'|'ruin'|'camp'|'lossoth', hasStable, hasDock, hasInn, rallyPoint:{x,z} /* respawn */, buildings:[{recipe, x, z, yaw, name?, npcInside?:[npcIds]}], props:[...] }],
  roads: [{ from: townId, to: townId, points:[{x,z},...] /* includes endpoints */, width: 6 }],
  npcs: [{ id, name, title, race, gender, zone, town, pos:{x,z}, yaw, roles:['questgiver','vendor:general'|'vendor:armour'|'vendor:weapons'|'vendor:food'|'vendor:fishing'|'trainer'|'stablemaster'|'boatmaster'|'innkeeper'|'flavor'|'guard'|'bard'],
           dialogue:[strings], interior?: buildingRef, level }],
  monsterTypes: [{ id, name, family:'wolf'|'boar'|'bear'|'spider'|'goblin'|'orc'|'brigand'|'troll'|'wight'|'bat'|'warg'|'crawler'|'lynx'|'drake'|'giant'|'slug'|'uruk'|'sorcerer'|'lossoth-bear'|'sea-serpent', level:[min,max], zone, hostile:true, aggroRange, morale, dmg, armour, speed, size, color, elite?:bool, boss?:bool, loot:[{tid, chance}], abilities?:[...], desc }],
  spawns: [{ id, type: monsterTypeId, center:{x,z}, radius, count, respawn: 45 }],
  bosses: [{ id, type, pos:{x,z}, respawn: 120 }],
  docks: [{ id, name, town, pos:{x,z}, yaw, routes:[dockId...] }],
  fishingSpots: [{ id, name, zone, pos:{x,z}, radius, fish:[{tid, weight}] }],
  pois: [{ id, name, zone, pos:{x,z}, kind:'ruin'|'landmark'|'cave'|'camp'|'bridge'|'tower'|'grave'|'lake'|'waterfall'|'shrine'|'dungeon', desc, buildings?:[...] }],
  gatherNodes: [{ id, itemTid, zone, pos:{x,z}, radius, count, kind:'herb'|'ore'|'wood'|'chest'|'relic'|'mushroom' }],
  travelRoutes: [{ from: townId, to: townId, cost: copper, requires?: questId }],  // stable-master swift travel
}
```
Every NPC and monster type referenced by a quest MUST exist here. Every town must have a rally point & at least one quest-giver.

### 4.7 Quests (`G.Data.quests` = array; `G.Data.questById`)
```js
{ id: 's001'..'s100' | 'q001'..'q050', name, type:'story'|'side', book: 'Book 1: The Shadow in the Shire' (story chapters; 8 books of 12-13 quests), level, zone,
  giver: npcId, turnin: npcId, prereq: [questIds] /* story: previous story quest; side: none or a story quest */, 
  objectives: [
    { type:'kill', target: monsterTypeId, count, label },
    { type:'collect', item: itemTid, count, from: monsterTypeId|null, node?: gatherNodeId, label },   // if from: drops from that monster while quest active (100% chance); if node: gather node (E)
    { type:'talk', npc: npcId, label },
    { type:'explore', pos:{x,z}, radius: 12, label },
    { type:'use', node: gatherNodeId, count, label },   // interact with world objects (E), e.g. light beacons, search chests
    { type:'fish', count, spot?: fishingSpotId, label },
    { type:'deliver', item: itemTid, npc: npcId, label },   // item is granted on accept; consumed on delivery
    { type:'killboss', boss: bossId, label },
  ],
  rewards: { xp, gold, items:[tid], choose?: [tid, tid, tid] /* player picks one */, title?: string, mount?: tid, abilityPoints? },
  text: { intro (giver's speech ≥ 3 sentences), accept (1 line), progress (1-2 lines), complete (≥ 2 sentences) },
  next?: questId }
```
Objectives complete in ANY order except when `sequential: true` on the quest. Story ids are strictly ordered s001→s100 (each `prereq` = previous).
Auto-quest must be able to complete EVERY objective type mechanically, so every objective position must be reachable on land (or via boat dock route for islands) —
objectives on islands are allowed only in zones that have a dock route.

## 5. Engine APIs

### 5.1 Terrain `G.Terrain`
* `G.Terrain.init()` (sync; computes lookup tables), `G.Terrain.build(scene)` (creates chunk manager + water), `G.Terrain.update(playerPos, dt)`.
* `G.Terrain.height(x, z)` → world y (analytic: zone-blended fbm + mountains + roads flattening + town flattening + rivers/lakes/sea; MUST be deterministic and match the rendered mesh). Under water areas return < `G.C.SEA_LEVEL`.
* `G.Terrain.normal(x, z, out)`; `G.Terrain.slope(x, z)` (0..1); `G.Terrain.isWater(x, z)` (height < sea level); `G.Terrain.waterDepth(x,z)`.
* `G.Terrain.zoneAt(x, z)` → zone id; `G.Terrain.biomeAt(x,z)`; `G.Terrain.groundType(x,z)` → 'grass'|'dirt'|'stone'|'sand'|'snow'|'road'|'wood'|'water' (for footstep sounds/dust).
* `G.Terrain.onRoad(x, z)` → 0..1; `G.Terrain.nearestRoadPoint(x,z)`.
* `G.Terrain.mapCanvas(size)` → HTMLCanvasElement of the whole world painted (biome colours, water, roads, town dots) — cached; used by M panel & minimap.
* Chunks: 128×128 units, 48 segments/side near, LOD 24/12 far; visible radius 900; vertex colours + detail texture; `receiveShadow`. Water: single large plane per visible area with custom shader (waves, fresnel, foam near shore via depth from height func baked to vertex attr).

### 5.2 Sky `G.Sky`
`init(scene, renderer)`, `update(dt, playerPos)`, `setTime(hours)`, `setWeather(kind)`, `G.Sky.sun` (DirectionalLight, shadow camera follows player, 2048 map, bounds ±70),
`G.Sky.hemi`, `G.Sky.ambient`, `G.Sky.moon`, `G.Sky.fog` (scene.fog, colour tracks sky/zone), `G.Sky.phase` ('dawn'|'day'|'dusk'|'night'), `G.Sky.lightLevel` 0..1.
Sky dome shader with gradient, sun disc + glow, stars at night, moving cloud layer; rain/snow particle systems that follow the camera; lightning flashes in storms.

### 5.3 Vegetation `G.Veg`
`build(scene)`, `update(playerPos, dt)`. Deterministic placement from `G.hash2` per chunk; trees add cylinder colliders via `G.Physics.addCylinder`.
Wind sway in vertex shader (`onBeforeCompile`) for grass/leaves. Density scaled by `G.state.quality`. `G.Veg.setDensity(mult)`.

### 5.4 Buildings `G.Buildings`
Recipes: `hobbit_hole, man_house, man_house_2, inn, shop, elf_hall, elf_house, dwarf_hall, dwarf_house, lossoth_hut, tent, tower, ruin_wall, ruin_tower, barrow, dock, bridge, wall_segment, gate, fence, well, campfire, market_stall, stable, shrine`.
`G.Buildings.place({recipe, x, z, yaw, name, town, npcInside})` → `Building {id, group, door(s), interiorBounds, roof, colliders, lights}`; every enterable recipe has a REAL interior
(floor, walls, ceiling, furniture, fireplace with flickering PointLight + G.FX fire, shelves, beds, chests) and a door entity (`kind:'door'`, `interact` opens/closes with animation and sound).
`G.Buildings.update(playerPos, dt)`: roof/ceiling hidden (or faded) when player is inside; door animation; nearby-only lights on.
`G.Buildings.isInside(pos)` → building|null. `G.Buildings.buildTown(townData)` places all town buildings/props and registers interior NPCs' positions (`G.NPCs` reads `building.interiorSpots`).

### 5.5 Characters `G.Chars`
* `G.Chars.buildHumanoid(spec)` → `Rig` where spec = `{ race, gender, cls, skin, hair, hairColor, hairStyle, height, build, equipment (map slot→ItemInstance|null), armourType, nameplate?: bool }`.
  `Rig = { group: THREE.Group (feet at y=0, faces -Z), parts: {head, torso, hips, armL, armR, forearmL, forearmR, legL, legR, shinL, shinR, handL, handR, footL, footR, hair, weaponMain, weaponOff, weaponRanged, cape, helmet, shoulders}, 
          height, setAnim(name, force?), anim, play(dt, ent) /* advances procedural animation using ent.vel/onGround/etc */, setEquipment(map), setMounted(bool), dispose() }`.
  Anims: `idle, walk, run, jump, fall, roll, attack_slash, attack_thrust, attack_spin, attack_shoot, cast, hit, death, sit, fish_cast, fish_wait, fish_reel, ride, swim, emote_wave, emote_dance, emote_bow, emote_cheer`.
  Look: real proportions per race (hobbit/dwarf short, elf tall & slim, beorning big), faces with eyes/brows/mouth, hair styles, gear colours by armourType/rarity, weapon meshes by `visual.weaponShape`. Smooth-shaded low-poly, `MeshStandardMaterial`, cast shadows, ≤ 24 draw calls per rig, share materials.
* `G.Chars.buildMonster(typeData)` → `Rig` (families in §4.6) with anims `idle, walk, run, attack, hit, death`, sized by `size`, colour variants.
* `G.Chars.buildHorse(color)` → `Rig` (anims idle/walk/gallop, saddle; player rig attaches at `rig.parts.saddle`).
* `G.Chars.buildBoat(kind:'rowboat'|'elfship'|'ferry')` → `{group, seat, mast}`; `G.Chars.nameplate(text, color)` → sprite (canvas), pooled.
* `G.Chars.buildProp(kind)` for quest items in world: `chest, bundle, herb, ore, mushroom, relic, beacon, crate`.

### 5.6 Physics `G.Physics`
`init()`, `addBox(minX,minY,minZ,maxX,maxY,maxZ, tag?)`, `addCylinder(x,z,radius,height,tag?)`, `addWall(x1,z1,x2,z2,height,thickness)`, `remove(id)`, `clearTag(tag)`;
`moveEntity(ent, desiredVelXZ /* Vector3 */, dt, opts={fly:false, noclip:false})` — integrates gravity (`G.C.GRAVITY`), resolves collisions with colliders (capsule vs box/cylinder/wall, slide), terrain (walkable slope ≤ 50°, else slide), water (ent.inWater/swimming when terrain height < sea-1.2; swimming clamps y to surface−1.0), sets `ent.onGround`, updates `ent.pos`, `G.Spatial.update(ent)`. Also `G.Physics.groundY(x,z)` (max of terrain and collider tops like bridges/floors/docks), `G.Physics.raycast(origin, dir, maxDist)` → `{dist, point, normal}|null` (colliders + terrain), `G.Physics.cameraClamp(target, desiredCamPos)` → Vector3 (pulls camera in front of walls/terrain), `G.Physics.lineOfSight(a,b)`.
Buildings/veg register colliders; floors of interiors are boxes with a `floor:true` flag so `groundY` returns them.

### 5.7 FX `G.FX`
`init(scene)`, `update(dt, camera)`, `spawn(kind, pos, opts={dir, color, scale, target, duration})`. Kinds: `hit, crit, slash, thrust, spin, arrow, bolt, fire, frost, light, lightning, heal, buff, levelup, dust, splash, bubbles, smoke, fire_static (campfire), torch, sparkle, blood(no gore → 'impact' motes), quest_beacon (tall soft light pillar at objective), footstep, questmark_glow, death_puff, water_ring, snow_puff`.
`G.FX.projectile({from, to|target, speed, kind, onHit})` (arrow/bolt/stone with arc & trail; calls onHit when arrived or hit ground). `G.FX.text3d`? no — floating text is DOM (`G.UI.floatText`). Pooled sprites/points; ≤ 12 draw calls total.

### 5.8 PostFX `G.PostFX`
`init(renderer, scene, camera)`, `render()`, `resize(w,h)`, `setQuality(q)` (ultra/high/medium/low: pixel ratio, shadow map size via `G.Sky.setShadowQuality`, bloom on/off, FXAA, veg density), `G.PostFX.enabled`, `G.PostFX.params {bloom:0.35, exposure:1.05, vignette:0.35, saturation:1.08, contrast:1.05}`. Implements: scene→HalfFloat RT, bright-pass + 2-pass separable blur (half res), composite with ACES tonemap + FXAA + vignette + grade. Falls back to direct render on failure.

### 5.9 Audio `G.Audio`
`init()` (lazy on first gesture — call from any click/keydown; safe to call repeatedly), `sfx(name, {pos?, vol?, pitch?})` (positional attenuation vs player if pos), `music(themeId)` (crossfade 2 s), `stopMusic()`, `setVolumes(music, sfx)`, `ambient(zoneBiome, phase)` (wind/birds/crickets/waves loops), `G.Audio.ready`.
SFX names (all must exist): `ui_click, ui_open, ui_close, ui_error, sword_swing, sword_hit, axe_hit, blunt_hit, bow_shoot, arrow_hit, spell_cast, spell_hit, fire_hit, frost_hit, light_hit, heal, buff, footstep_grass, footstep_stone, footstep_wood, footstep_water, footstep_snow, jump, land, roll, hurt, death, level_up, quest_accept, quest_progress, quest_complete, coin, loot, equip, door_open, door_close, horse_mount, horse_gallop, horse_neigh, fish_cast, fish_bite, fish_catch, fish_fail, boat_creak, boat_bell, wolf_howl, boar_grunt, bear_roar, spider_hiss, orc_growl, troll_roar, wight_moan, thunder, rain_loop, wind_loop, birds_loop, crickets_loop, waves_loop, fire_loop, splash, swim, eat, drink, chat_ping, admin_open, achievement`.
Music themes: `menu, shire, breeland, forest, barren, downs, lake, elven, dwarven, mountain, dark, arctic, island, combat, boss, victory, death, sailing, tavern`. Composed multi-track (melody+harmony+bass+percussion where fitting) with a warm synth (detuned saws/triangles through lowpass, ADSR, feedback delay + convolver reverb from generated impulse). Loops seamlessly; distinct moods.

## 6. Gameplay APIs

### 6.1 Player `G.Player`
`create(charSpec)` → player entity (adds to state, builds rig, starter gear/abilities/hotbar/mount), `spawnAt(x,z)`, `update(dt)`, `camera` (THREE.PerspectiveCamera, fov 60), `cam = {yaw, pitch, dist (G.state.settings.cameraDist), target offset}`,
`getForward(out)`, `interact()` (E: nearest entity with `interact` within range & ±90° → calls its fn; doors, NPCs, nodes, docks, fishing spots, chests), `dodgeRoll()` (Q), `jump()`, `toggleMount()` (H; not in water/inside building; dismount on damage taken? no — dismount when using an ability), `rangedAttack()` (R: needs equipped ranged weapon, target or nearest hostile in front within 30 m; projectile), `setTarget(ent)`, `tabTarget()` (Tab), `clickSelect(x,y)` (LMB raycast entities), `teleport(x,z, yaw?)`, `respawn()`, `isBusy()`, `inInterior`.
Controls: W/S forward/back relative to camera yaw; A/D strafe; character yaw smoothly follows camera yaw (mouse steer); mouse wheel = camera distance 1.5–28; pitch clamp −80°..+80°; camera collision via `G.Physics.cameraClamp`; head-bob-free, smooth follow; while mounted horse rig is the visible body and the player rig sits on it.
Movement feel: acceleration 40 m/s², deceleration 50, air control 0.4, coyote time 0.12 s, roll has i-frames and a dust FX + sfx, jump sfx + landing dust, footstep sfx by `G.Terrain.groundType` and speed. Swim when in water. Auto-run (Num Lock or `KeyR`? no — `NumLock`).
`G.Player.autoMove(targetPos, opts)` / `G.Player.autoStop()` — steering used by AutoQuest (moves like a player; obstacle avoidance by probing left/right; auto-jump small ledges; auto mount when far).

### 6.2 Combat & Progress `G.Combat`, `G.Progress`
`G.Combat.useAbility(ent, abilityId, target?)` → bool (checks range/power/cd/gcd/cast; plays anim/vfx/sfx; applies effects; for player triggers face-target), `G.Combat.basicAttack(ent, target)`, `G.Combat.damage(src, dst, amount, dtype, {crit, ability})`, `G.Combat.heal(src, dst, amount)`, `G.Combat.addEffect(dst, effect)`, `G.Combat.removeEffect(dst, id)`, `G.Combat.kill(ent, killer)`, `G.Combat.update(dt)` (effects tick, cast bars, projectiles, regen out of combat, combat state timers → `combatStart/combatEnd`), `G.Combat.isHostile(a,b)`, `G.Combat.canSee`.
Player death: screen fade, "You have been defeated" → `G.UI.DeathScreen` with "Retreat" (respawn at zone rally point, 10% morale) ; auto after 8 s. Dying = `G.state.stats.deaths++`.
`G.Progress.addXP(n)`, `levelUp()` (stats recompute, full heal, FX+sfx+notify, chat congrats from AI players via emit), `G.Progress.addGold(copper)`, `G.Progress.spendGold(copper)` → bool, `G.Progress.trainAbility(id)` → {ok, reason} (needs level & gold; assigns to first free hotbar slot; emits `abilityTrained`), `G.Progress.setHotbar(slot, abilityId)`, `G.Progress.xpToNext()`.

### 6.3 Monsters `G.Monsters`
`init()`, `update(dt)` (spawn/despawn by distance, AI in LOD tiers: <60 m every frame, <260 m every 4th frame; AI: wander in radius, aggro on hostile within aggroRange (reduced by level difference), chase, attack with `dmg` every `1.8 s`, use abilities if defined, leash after 60 m, regen when out of combat, respawn timers, bosses with bigger scale/nameplate/health), `spawnAt(typeId, x, z, opts)` → entity (also used by admin & quests), `killAllNear(pos, r)`, `typesInZone(zoneId)`, `nearestHostile(pos, r)`.
Monster death: death anim, loot drop (a shimmering loot bag entity `kind:'chest'` interactable, auto-looted by E, or auto-loot when walked over within 1.5 m — configurable, default auto-loot), XP via `G.Progress`, quest hook `G.Quests.onKill`.

### 6.4 NPCs `G.NPCs`
`init()` (creates all registry NPCs as entities; interior NPCs placed via `G.Buildings`), `update(dt)` (idle animation, small ambient movements for flavour NPCs, facing player when talking; guards patrol; bards play), `get(id)`, `talk(npc)` (opens `G.UI.Dialogue.open(npc, options)`: greeting text, quest options with `!`/`?` icons, `Trade`, `Train`, `Travel`, `Sail`, `Rest & Save`), quest marker sprites above heads (`!` yellow available / `?` grey in progress / `?` yellow ready) updated on quest events, name plates with colour by role.

### 6.5 Quests `G.Quests`
`init()`, `state` (map id → `{status:'available'|'active'|'complete'(ready to turn in)|'done', progress:[n...], accepted: time}`), `available(npcId)`, `turnins(npcId)`, `accept(id)`, `abandon(id)`, `canTurnIn(id)`, `turnIn(id, chosenIndex?)`, `isDone(id)`, `active()` → sorted array, `tracked` (id, default most recent), `setTracked(id)`, `nextObjective(id)` → `{objective, pos:{x,z}, label, zone}` (for map/minimap/tracker/beacon), `onKill(typeId, ent)`, `onCollect(tid)`, `onTalk(npcId)`, `onExplore(pos)` (called by update), `onFish(tid)`, `onUse(nodeId)`, `onDeliver`, `completion()` → `{done, total, pct}` (150 total), `journalData()`.
Objective beacons: `G.FX.spawn('quest_beacon')` at the tracked objective; markers on minimap & map; tracker on HUD. Gather nodes for `collect/use` spawned as `kind:'node'` entities with props.

**Auto-quest `G.AutoQuest`** (B toggles): `start()`, `stop()`, `active`, `status` → `{questId, step, text, pct}`, `update(dt)`.
Bot behaviour, in order each tick: (1) if dead → wait for respawn; (2) equip any better gear in inventory, train affordable abilities, sell junk if inventory > 180 slots used at a vendor (or auto-sell remotely at 50% value); (3) if a completed quest is ready → go to turn-in NPC (walk with `G.Player.autoMove`, auto-mount if > 40 m; if stuck > 4 s or > 2 km away → fade-out teleport to within 6 m); (4) else if active quests → progress the first unfinished objective (kill: find/spawn target type nearest, fight with abilities & basic attacks; collect from monster: same; node: walk & E; talk/deliver: walk & auto-talk; explore: walk; fish: walk to spot & auto-fish; killboss: go & fight; island objectives: use dock fast travel); (5) else accept the next available quest: story first (lowest id whose prereq done), then side quests by level; if none available at current level... all quests are always gated only by prereq, so this cannot dead-end; (6) when `completion().done == 150` → equip the Lost Kingdom set fully, notify "All 150 quests complete — 100%!", play `victory`, stop.
Bot speed setting `G.AutoQuest.speed` (1 = realistic, 3 = default fast, 10 = blazing; affects only movement/teleport thresholds & auto-fight pacing, not the game clock). Must never deadlock: every wait has a timeout with a fallback (teleport, force-complete objective after 60 s of failing with a console.warn). HUD shows a progress strip (owned by HUD, reads `status`).

### 6.6 AI players `G.AIPlayers`
`init()` creates 150 records (`kind:'aiplayer'`, unique names per race, race/class/gender mix, levels distributed 1–80 (many low, some 80), gear by `G.Items.generate` at their level, zone matching level, `persona` {chatty 0..1, friendly 0..1, style}`), `update(dt)`:
* Sim LOD: entities within `AIPLAYER_RENDER_DIST` have rigs, walk real paths (to nearby monster / town / road waypoints), fight real monsters using `G.Combat`, cast VFX, emote, mount horses when travelling far, sit at campfires, fish at spots. Far ones are abstract: move along zone/road graph at speed, gain XP over time (level-ups broadcast to chat by some), swap gear at level milestones, "die" occasionally & return to rally, form fellowships (2–5 travelling together), go to inns at night.
* Chat: world/OOC/zone-style messages every ~20–60 s across the population (LFG, trade WTS/WTB, jokes, congrats on player level-ups (`playerLevelUp` → 1-3 "gz!" within 5 s), replies to the player's own chat by keyword (hi/hello/help/lfg/where/quest/sell), emote lines. Use `G.UI.chat`.
* `G.AIPlayers.list()` → array for P panel; `G.AIPlayers.get(id)`; `G.AIPlayers.inspect(id)` → `{name, race, cls, gender, level, zone, pos, state, stats, equipment (18 slots), xp, kills, fellowship}`; `G.AIPlayers.teleportTo(id)`.
* They must never block the player physically (no collision with the player; they path around).

### 6.7 Fishing & Boats `G.Fishing`, `G.Boats`
`G.Fishing.canFish(player)` (within 6 m of water & facing it, not mounted/swimming), `start()` (F), `update(dt)`, `state` ('idle'|'casting'|'waiting'|'bite'|'reeling'|'caught'), `cancel()`; bobber mesh + splash FX + ring ripples; bite window 1.6 s; catch table by nearest fishing spot else zone default; fishing skill increases (`G.state.fishingSkill`), rare catches (treasure chest → gold, "Ring of Barahir"? no: "Silver Trout Charm" trinket) ; quest hook.
`G.Boats.init()` (dock entities with `interact` → `G.UI.Travel.openDock(dock)`), `board(dock)` (spawn rowboat, player rig sits, state `sailing`), `sailTo(dockId)` (fast travel: cinematic camera follows a boat along a straight/curved sea route over ~10 s with `sailing` music, fade at arrival), `update(dt)` (free sailing: W/S throttle, A/D turn, only where `G.Terrain.isWater` with depth > 1; E near shore (≤ 8 m of land with depth < 1.5) to disembark; boat bobbing & wake FX), `disembark()`, `sailing` bool.

## 7. UI (§ DOM ids & classes are a contract)

### 7.1 Root (`30_ui_hud.js`) — `G.UI`
`init()`, `addCSS(text)`, `registerPanel(id, {title, build(bodyEl) → void, onOpen?, onClose?, width, height, pos:'center'|'left'|'right', modal?: bool, key?: 'KeyI'})` — creates `<div class="panel" id="panel-<id>">` with `.panel-title` (drag to move) + `.panel-body`; `openPanel(id)`, `closePanel(id)`, `togglePanel(id)`, `isOpen(id)`, `closeAll()`, `anyOpen()` (true when a panel is open → player input for camera/movement disabled and pointer unlocked; Esc closes the topmost), `refresh(id)` (re-calls build), `tooltip.show(html, x, y)`, `tooltip.hide()`, `bindTooltip(el, htmlOrFn)`, `notify(text, kind='info'|'quest'|'level'|'warning'|'loot'|'gold')` (centre-top stacked notices, fade), `floatText(worldPos, text, color, {crit, size})` (DOM floating combat text projected each frame), `chat(text, channel='world'|'say'|'system'|'combat'|'fellowship', from?)`, `chatInput()` focus (Enter), `setCursor()`, `confirm(text, onYes)` (small modal), `prompt`? no.
HUD elements: `#playerFrame` (portrait glyph, name, level, morale/power bars), `#targetFrame` (name, level, difficulty colour, hp bar, cast bar, effects), `#hotbar` (20 slots, keybind caps, cooldown sweeps, drag-drop from K panel), `#buffs`, `#castbar`, `#xpbar` (bottom thin), `#questTracker` (right; tracked quest + up to 5 active with objectives, click to track), `#minimap` (top-right 200 px canvas: terrain from `G.Terrain.mapCanvas` cropped, player arrow, NPC/quest/monster/AI-player dots, N indicator, zone name, clock, coordinates, zoom +/−), `#chat` (bottom-left, tabs: All/Say/World/Combat, input on Enter, `/say /w /emote` commands, `/help`), `#interactPrompt` ("[E] Open door"), `#compass` (top centre bearing strip with quest direction marker), `#notices`, `#autoquestStrip`, `#fps`, `#deathScreen`, `#keyHelp` (toggle with F1 / `?`), `#lootWindow`.
Panel keybindings (handled by HUD from `G.Input.pressed` in `G.UI.update(dt)` — ALWAYS active, even when a panel is open; each key toggles): I inventory, C character, K abilities, J journal, M map, P players, B auto-quest (toggle, not a panel; shows strip), Esc close top panel / open settings when none, F1 key help, Enter chat.

### 7.2 Panels (`31_ui_panels.js`)
* **Inventory (I)** `inventory`: 200 slots grid (10 × 20, scroll) with icons/rarity borders/stack counts, gold display, sort button, filter tabs (All/Weapons/Armour/Jewellery/Consumables/Quest/Materials/Fish), tooltips with comparison vs equipped, click: equip/use; right-click: context (Equip/Use/Sell (when vendor open)/Destroy); drag & drop to reorder & to equipment slots; item count/200.
* **Character (C)** `character`: LOTRO-style paper doll: 18 equipment slots arranged around a large live 3D preview (render the player rig into a small secondary canvas via a second scene/camera — `G.Chars` rig clone) — left column head/shoulder/back/chest/hands/legs/feet; right column neck/ear1/ear2/wrist1/wrist2/ring1/ring2/pocket; bottom mainhand/offhand/ranged; stats panel (primary, morale/power, offence, defence, percentages) with tooltips explaining each; titles dropdown; gear-set summary ("Wanderer's Set 3/6 — bonuses"); race/class/level header; kills/quests/fish/playtime.
* **Abilities (K)** `abilities`: list all 13 class abilities: icon, name, unlock level, gold cost, description, status (Trained / Train for X / Requires level N); Train button (via `G.Progress.trainAbility`); "Set to hotbar slot" select; also a Traits section (racial trait, class trait passives per 10 levels).
* **Journal (J)** `journal`: left list: Active / Available nearby / Completed (tabs); story quests grouped by Book; each with level + zone chip; right detail: full intro text, objectives with progress, rewards preview, giver/turn-in names, Track / Abandon buttons; bottom completion bar "Quests: 37/150 (24.7%) — Story 30/100 · Side 7/50".
* **Map (M)** `map`: full-screen-ish world map (`G.Terrain.mapCanvas(1024)`) with pan/zoom (wheel/drag), zone names & level ranges, towns, roads, POIs, docks, fishing spots, player arrow, AI players (small dots, toggle), tracked quest objective (pulsing marker + dotted line from player), all active quest markers, hover tooltips, legend, "Click to set custom waypoint" (shows on compass/minimap); coordinates under cursor.
* **Players (P)** `players`: table of ALL 150 AI players + you: name, race, class, level, zone, state, sortable, search; click → detail pane: stats, equipment 18 slots with tooltips, fellowship; "Live" — refreshed every 1 s while open; buttons: Whisper (chat), Locate (map marker), (admin only) Teleport to.
* **Dialogue** `dialogue`: NPC name/title, text, option buttons (quests `!`/`?`, Trade, Travel, Sail, Train, Rest & Save, Goodbye); quest detail sub-view (intro text, objectives, rewards with choose-one) with Accept/Decline/Complete.
* **Vendor** `vendor`: two columns buy (stock with prices, level requirements) / sell (your inventory, click to sell; "Sell all junk").
* **Travel** `travel`: stable-master routes (cost; press → fade, teleport, fade in with sfx `horse_gallop`) and dock routes (calls `G.Boats.sailTo`) + "Take a boat" (free sailing).
* **Settings** `settings` (Esc): music/sfx sliders, mouse sensitivity, invert Y, graphics quality (Ultra/High/Medium/Low/Auto), show FPS, camera distance, key help, Save Now / Return to Main Menu / New Character (with confirm).
* **Loot choose** `choose` for quest reward choice.

### 7.3 Admin (`32_ui_admin.js`) — opens when the letters `chris` are typed (via `G.Input.onSequence`) or `/chris` in chat.
Tabs: **Player** (name, level (set → recompute), XP, gold (g/s/c), all 5 primary stats override + reset, morale/power full, god mode, damage ×, speed ×, no cooldowns, fishing skill, titles, mounts unlock), **Items** (search box over all templates with filters; give N; "Best-in-slot set for level"; "Random loot"; clear inventory; edit equipped item stats), **Teleport** (every zone/town/POI/NPC/dock as buttons; x/z inputs; "Teleport to tracked quest objective"), **Quests** (all 150 rows with status; Accept/Complete/Reset per row; Complete all; Reset all; jump to quest giver), **World** (time slider 0–24, day length, weather select, spawn monster type near player (level/count), kill all near, respawn all, spawn AI player near me), **AI Players** (list, set all levels, teleport to, level all +N, chat spam on/off), **Map** (add/remove custom named map places at player position or coordinates; edit town names; these appear on the M map & minimap; persisted in save), **Settings/Debug** (quality, show colliders, wireframe, show FPS/draw calls, pause time, free-fly camera, noclip, God-view (top-down)), **Save** (export JSON to textarea, import, reset save). Every change applies immediately.

### 7.4 Menu & character creation (`33_ui_charcreate.js`)
* `#loading`: title art (CSS/SVG ring & mountains), progress bar driven by `G.Game.progress(pct, text)`, "Click to begin".
* `#mainMenu`: animated 3D background (camera slowly drifting over the Shire at dawn), buttons: Continue (if save), New Character, Settings, Controls, Credits; music `menu`.
* `#charCreate`: steps/columns: Name (+ Random), Gender (Male/Female), Race (10 cards with desc & stat bonuses & racial trait), Class (10 cards: role, main stat, armour, ranged weapon, short desc), Appearance (skin tone swatches, hair style, hair colour, eye colour, height slider, build), live 3D preview (rotating rig with lighting, updates instantly, drag to rotate), stat preview; "Enter Middle-earth". Validation: name 2–16 letters. On confirm → `G.Game.startNew(spec)`.

### 7.5 Save (`34_save.js`)
`save()` (serialises player (pos, level, xp, gold, stats overrides, inventory, equipment, abilities, hotbar, mounts, titles, fishingSkill, playtime), quests state, tracked, time of day, weather, AI players' compact state (level/zone/pos/xp), settings, admin custom places, stats), `load()` → spec or null, `hasSave()`, `clear()`, `exportJSON()`, `importJSON(str)`; autosave every 60 s and on `questCompleted`, `playerLevelUp`, `panelClosed`; `G.Game.startFromSave()`.

## 8. Main (`99_main.js`) — boot & loop order
```
boot: create renderer (antialias, high-performance, pixelRatio ≤ 2, shadowMap PCFSoft, NoToneMapping (PostFX does ACES)), scene, G.Player.camera,
      G.Input.init(canvas) → G.emit('init') → progressive build with G.Game.progress(): Terrain.init/build, Sky, Veg, Buildings (towns/pois/docks), Physics, FX, PostFX, NPCs, Monsters, Boats, AIPlayers, UI.init → __T.ready = true → show main menu.
startNew(spec)/startFromSave(): G.Player.create(...), spawn, G.Quests.init, camera snap, HUD show, music zone theme, emit gameStart → __T.inGame = true.
frame: dt = min(clock, 0.05) * G.time.scale; if paused → only UI.update.
  G.Input.beginFrame → G.Player.update → G.Physics (inside player/monster updates) → G.Combat.update → G.Monsters.update → G.NPCs.update → G.AIPlayers.update →
  G.Fishing.update → G.Boats.update → G.Quests.update → G.AutoQuest.update → G.Terrain.update → G.Veg.update → G.Buildings.update → G.Sky.update → G.FX.update →
  G.emit('update', dt) → G.UI.update(dt) → G.PostFX.render() → G.Input.endFrame.
quality auto-tune: measure FPS over 3 s windows; if < 50 step quality down (ultra→high→medium→low), if > 58 for 10 s step up (once). `G.Game.fps`.
```
`window.__T = { ready, inGame, errors: G.errors, quickStart(opts) /* skips menus: creates char with defaults merged from opts and enters world */, stats() → {fps, drawCalls, triangles, entities, chunks}, G }`.
`window.onerror`/`unhandledrejection` push into `G.errors` (00_core).

## 9. World layout (authoritative coordinates; x east, z south; units ≈ metres; world ±2048)

Sea: everything with x < −1500 (west coast) and z < −1650 (northern bay) is ocean; islands sit in it. Lakes: Evendim (centre −250,−900, r 260), Shire pond (−1000,−120, r 40), Lone-lands tarn (700,120,r 45).
Rivers (carved, ≈ 12 m wide, below sea level): Brandywine from (−700,−1500) → (−650,−600) → (−600,0) → (−560,600) → (−520,1400) (south to the sea? ends in Old Forest marsh at (−520,1400)); Hoarwell from (1100,−1300) → (1050,−300) → (1000,300).

| zone id | name | level | centre (x,z) | radius | biome | notes |
|---|---|---|---|---|---|---|
| `shire` | The Shire | 1–10 | (−1000, −100) | 420 | shire | rolling green, hobbit holes, Hobbiton, Michel Delving, Bywater pond |
| `eredluin` | Ered Luin | 1–15 | (−1350, −900) | 380 | mountain/elven | Thorin's Hall (dwarf, north), Celondim & Duillond (elf, south coast, dock) |
| `breeland` | Bree-land | 5–20 | (−250, 0) | 420 | breeland | Bree (walled town, inn Prancing Pony), Combe, Archet, Staddle |
| `oldforest` | Old Forest & Barrow-downs | 15–25 | (−450, 650) | 320 | forest/downs | dark forest, Tom's house, barrows with wights |
| `lonelands` | The Lone-lands | 20–32 | (500, 100) | 420 | barren | Forsaken Inn (west), Weathertop (centre), Ost Guruth (east) |
| `northdowns` | North Downs | 28–40 | (250, −650) | 380 | downs | Trestlebridge, Esteldín (ranger refuge), Fornost ruins (north) |
| `evendim` | Evendim | 35–45 | (−250, −1000) | 380 | lake | great lake Nenuial, Tinnudir isle-town, Annúminas ruins (west shore), dock |
| `trollshaws` | The Trollshaws | 40–50 | (1150, 0) | 380 | forest | trolls, Rivendell (east, valley), Thorenhad camp |
| `misty` | Misty Mountains | 48–58 | (1650, −450) | 340 | mountain | snow, giants, drakes, High Crag camp, Goblin-town entrance |
| `angmar` | Angmar | 55–65 | (1000, −1250) | 400 | dark | Aughaire (hillmen camp), Carn Dûm citadel (north-east, dungeon), Rammas Deluon gate |
| `forochel` | Forochel | 60–70 | (600, −1850) | 340 | arctic | Sûri-kylä (lossoth), ice bay (dock), Forochel is on the northern coast, reached by road from Angmar/Evendim AND by boat |
| `tolfuin` | Tol Fuin | 65–72 | (−1800, −1500) | 220 | island/elven | island: elven haven Ost Fuin (dock), sea-serpent coast, ancient ruins |
| `himling` | Isle of Himling | 72–80 | (−1750, −400) | 240 | island | island: ruined fortress of Himring, final boss "the Gaunt-lord Draugmar"; dock camp Ras Himling |
| `tolmorwen` | Tol Morwen | 60–68 | (−1850, 700) | 180 | island | small isle with the Stone of the Hapless, fishing village, dock |
| `souththicket` | Chetwood & Midgewater | 12–22 | (150, 400) | 260 | forest/marsh | between Bree and Lone-lands: marsh, brigand camps, spiders |

Towns (id, zone, pos, style): `hobbiton` shire (−1050,−140) hobbit · `micheldelving` shire (−1250,−60) hobbit · `bywater` shire (−950,−80) hobbit · `thorinshall` eredluin (−1300,−1100) dwarf · `celondim` eredluin (−1420,−700) elf (dock `dock_celondim`) · `duillond` eredluin (−1320,−760) elf · `bree` breeland (−250,−20) man (walls, gates W/S, Prancing Pony inn) · `combe` breeland (−120,−140) man · `archet` breeland (−60,−260) man · `staddle` breeland (−200,150) man/hobbit · `tomshouse` oldforest (−520,560) man · `forsakeninn` lonelands (300,120) man · `ostguruth` lonelands (720,60) ruin/camp · `trestlebridge` northdowns (120,−450) man · `esteldin` northdowns (400,−720) ruin/camp (rangers) · `tinnudir` evendim (−200,−1050) ruin/camp (dock `dock_tinnudir`) · `rivendell` trollshaws (1400,40) elf · `thorenhad` trollshaws (1050,−60) camp · `highcrag` misty (1600,−400) camp · `aughaire` angmar (900,−1150) camp (hillmen) · `surikyla` forochel (600,−1800) lossoth (dock `dock_forochel`) · `ostfuin` tolfuin (−1800,−1500) elf (dock `dock_tolfuin`) · `rashimling` himling (−1720,−450) camp (dock `dock_himling`) · `morwenvillage` tolmorwen (−1840,720) man (dock `dock_morwen`).
Dock routes: celondim ↔ tolfuin ↔ himling ↔ morwen ↔ celondim; tinnudir ↔ forochel (lake→river→bay, treat as sea route); tinnudir ↔ celondim? no (inland). Every dock must link so that every island is reachable from the mainland.
Roads connect: micheldelving–hobbiton–bywater–bree; bree–combe–archet; bree–staddle; bree–forsakeninn–ostguruth; bree–trestlebridge–esteldin; hobbiton–thorinshall; thorinshall–duillond–celondim; trestlebridge–tinnudir; ostguruth–thorenhad–rivendell; thorenhad–highcrag; esteldin–aughaire; aughaire–surikyla; tinnudir–surikyla; bree–tomshouse (south).
Start positions: hobbit/riverhobbit → hobbiton (−1040,−120); man/dunedain/rohirrim → archet (−60,−250); elf/highelf → celondim (−1410,−690); dwarf/stoutaxe → thorinshall (−1290,−1090); beorning → archet.

Level flow for story (Books): B1 Shire (1–10, s001–s012) · B2 Bree-land & Ered Luin (8–20, s013–s025) · B3 Old Forest/Barrow-downs/Chetwood (15–28, s026–s037) · B4 Lone-lands & North Downs (26–40, s038–s050) · B5 Evendim & Trollshaws (38–50, s051–s062) · B6 Misty Mountains & Rivendell (48–58, s063–s075) · B7 Angmar & Forochel (56–70, s076–s088) · B8 The Sundered Isles (Tol Fuin/Tol Morwen/Himling, 68–80, s089–s100; s100 = kill Draugmar, reward: full Armour of the Lost Kingdom + title "Lord/Lady of the Lost Kingdom" + mount "Steed of the Lost Kingdom").
Side quests q001–q050 spread across all zones (≈ 4 per zone), levels 2–78, from town flavour NPCs.

## 10. Key bindings (final)
W/A/S/D move · mouse look (pointer lock or RMB drag) · wheel zoom · Space jump · Q dodge roll · R ranged attack · E interact · Tab target next enemy · LMB select/attack ·
1–9,0,G,T,V,X,Y,Z,L,N,O,U hotbar 1–20 · I inventory · C character · K abilities · J journal · M map · P players · H mount · F fish · B auto-quest · Enter chat · Esc close/settings · F1 key help · NumLock auto-run · typed `chris` → admin panel.
