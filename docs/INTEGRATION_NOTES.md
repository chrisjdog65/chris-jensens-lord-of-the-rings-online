# Integration notes (collected from module authors' reports — read before writing modules that consume these)

## 04_data_abilities.js
- Monster abilities live in `G.Data.abilities` too (`cls:'monster'`, `monster:true`); `G.Data.abilitiesFor(cls)` excludes them. `G.Data.abilityById(id)` is a FUNCTION.
- `ability.desc` is a TEMPLATE with `{dmg}` etc. UI must render `G.Data.abilityDesc(a, ent)` or `G.Data.abilityTooltipHTML(a, ent)`; `a.descPlain` is a pre-filled fallback.
- Combat semantics: dot/hot `mult` is per tick (no weapon component); heal = mult × mastery/4; mastery = phys for kind melee/ranged, tact otherwise (`ability.mastery` may override). Physical AoEs are kind melee/ranged with `effect.aoe` radius. Stances are 1800 s buffs. `target` hint: 'enemy'|'self'|'ally'|'party'. `threat` hint on tank skills.
- Helpers: `G.Data.abilityDamage(a, ent)` → {min,max,avg,dtype}, `abilityHeal`, `abilityDot`, `monsterAbilitiesFor(family)`, `trainCost(a)` (uses `G.Data.xp.abilityCost`).

## 00_core.js
- Entities: use `G.addEntity(ent)` / `G.removeEntity(ent)` / `G.getEntity(id)` — they keep `G.state.entities`, `G.state.byId` and `G.Spatial` consistent. `G.uidBump(id)` after load.
- Errors: `G.reportError(err, where)`, `G.warn(msg)` (deduped console.warn).
- Input extras: `released(code)`, `anyPressed()`, `mouseDown/mousePressed/mouseReleased(button)`, `mouse.nx/ny/overCanvas`, `bind(code)/unbind`, `codeOf(label)`, `reset()`, `lockSupported`; bus event `pointerLock(bool)`; `onSequence` returns an unsubscribe fn and is NOT fed while typing in inputs (so `/chris` in chat must be handled by the chat module). Wheel ≈ 100 per notch.
- Main loop must call: `G.Input.beginFrame()`, `G.tweenUpdate(dt)`, `G.timersUpdate(dt)`, advance `G.time.now/dt/frame`, `G.Input.endFrame()`.
- Extras: `G.ease.{linear,in,out,inOut,cubic*,sine*,back*,elastic*,bounce*}`, `G.tween(obj, props, dur, ease, onDone)`, `G.timers.after/every/cancel/clear`, `G.throttle`, `G.debounce`, `G.escapeHTML`, `G.fmtMoneyHTML`, `G.fmtCompact`, `G.plural`, `G.pad2`, `G.hexStr`, `G.damp`, `G.remap`, `G.saturate`, `G.noiseSeeded(seed)`, `G.rng(seed)` returns fn with `.int/.range/.pick/.chance/.shuffle`. `G.ridged` returns 0..1. `G.tmpV3(0..15)`.
- `G.el(tag, attrs, children)` supports `class` arrays, `style` objects, `data:{}`, `on:{}`, `onClick`-style handlers, `text`, `html`.

## 02_data_races_classes.js
- Racial/class trait effects land on `ent.stats` as keys other modules must honour: `stealth` (0..1, reduces monster aggro range), `fishingLuck`, `healOnKillPct`, `mountSpeedMult`, `swimSpeedMult`, `fallDamageMult`, `knockbackResist`, `lightDamageMult`. `stats.compute` also writes `mitigation/critChance/blockChance/parryChance/evadeChance/resistChance` percentages, `moraleRegenCombat/powerRegenCombat`, `stunned/rooted`, `speed` (multiplier).
- `ent.statBonus` (admin overrides, additive) and `ent.statOverride` (absolute) are honoured by `compute`.
- Effects on `ent.effects`: `stat` + `amount` (additive) or `pct` (≤1 fraction, >1 percent); debuffs (`kind:'debuff'`) are applied as reductions regardless of sign.
- `G.Data.randomName(race, gender)` → single word 3–16 letters; `randomFullName(race, gender)` adds surname (man/hobbit only). `G.Data.titles` (50), `titleName(id, gender)`.
- `G.Data.startPosFor(raceId)` → {x,z,town,zone}. `G.Data.difficultyColor(entLevel, playerLevel)` → hex; `conLabel`.
- `G.Data.xp`: `forLevel(L)`, `needFor(L)`, `levelForXP(xp)`, `progress(xp)`, `questXP(level, type)`, `killXP(mobLevel, playerLevel, mult?)`, `goldReward(level, type)`, `abilityCost(level)`, `storyLevel(i)` (recommended level of story quest i), `sideLevel(i)`. Quest authors MUST use `questXP`/`goldReward` for rewards. total80 = 1,813,050 XP.
- `G.Data.classTraits[cls]` 8 traits (L10..80); `G.Data.traitsFor(cls, L)`, `nextTrait`, `describeBonus`. `G.Data.stats.preview(cls, race, level)` for char-create.
- Minstrel `rangedWeapon` is 'staff'.

## 17_postfx.js
- `G.PostFX.init(renderer, scene, camera)` should be called AFTER Sky/Veg exist (init applies `G.state.quality`). Main must call `G.PostFX.resize(w,h)` on window resize (it calls `renderer.setSize(w,h,false)` itself). `render(scene?, camera?)`.
- `setQuality('auto'|'ultra'|'high'|'medium'|'low')` returns applied name, emits `qualityChanged(q)`. Params: `bloom, exposure, vignette, saturation, contrast, bloomThreshold, bloomRadius, grain, sharpen, tint, aberration, tonemap`. `stats {ms,...}`, `enabled`, `failed`, `warmup()`.
- Character-panel / char-create previews must use their OWN small WebGLRenderer (PostFX does not render previews).

## 11_sky.js
- Assumes `G.Terrain.setSkyColor(THREE.Color)` and `G.Terrain.setSun(dirVector3, THREE.Color, intensity)`; `G.Audio.setAmbientRain(level 0..1)`; `G.Buildings.isInside(pos)`; `G.Player.camera` (dome follows it).
- Extras: `G.Sky.setShadowQuality(size)` (0 disables), `getSkyColor(out)`, `getSunDir(out)`, `sunDir`, `moonDir`, `sunElevation`, `moonPhase`, `dayIndex`, `weather`, `cloudiness`, `rainLevel`, `snowLevel`, `lightning()`, `rollWeather()`, `autoWeather` (settable), `dome`.
- Sunrise 05:00 / sunset 19:00. Emits `dayPhase`, `weatherChanged`. Precipitation fades inside buildings.

## 15_physics.js
- `moveEntity(ent, desiredVelXZ, dt, opts)`: caller sets `ent.vel.y` for jumps; `ent.knockback` (Vector3) impulse is applied & decayed; sets `ent.onGround`, `ent.justLanded` (fall speed), `ent.justSplashed`, `ent.inWater`, `ent.swimming`, `ent.sliding`, `ent.waterDepth`, `ent.groundCollider`. `ent.pos.y` is FEET height. Swimming y = SEA − height·0.55.
- Floors: `addBox(minX,minY,minZ,maxX,maxY,maxZ, {tag, floor:true})` — buildings/docks/bridges MUST pass `floor:true` for walkable surfaces. `groundY(x,z,feetY?)`, `terrainY`, `raycast(origin, dir, maxDist, opts{skipCylinders,skipTerrain,tag})` (reused result object), `cameraClamp(target, desired)` ignores cylinders (trees) by default, `sweep(from,to,radius)`, `overlapCircle(x,z,r)`, `isFree`, `nearestFree(x,z,r)`, `debugMesh(scene)`, `debugVisible`.
- `G.Terrain.slope(x,z)` is compared raw against 0.85 — Terrain should return 1 − normal.y style value (0 flat .. 1 vertical).

## 01_audio.js
- Listener = `G.state.player.pos`; panning uses `G.Player.cam.yaw`. Audio self-subscribes to `weatherChanged` and `dayPhase` for rain/ambient mixes; main must still call `G.Audio.music(zone.music)` on zone change and `G.Audio.ambient(biome, phase)`.
- Extras: `footstep(groundType, opts)` (handles all G.Terrain.groundType values), `stopLoop(name, fade)`, `setAmbientRain(bool)`, `stopAmbient()`, `duck(bool)`, `has(name)`, `hasTheme(id)`, `stats`, `stopAll()`, `suspend/resume`. Emits `audioReady`, `musicEnded(id)`. `victory`/`death` themes are one-shots (currentTheme clears when done — main should restore the zone theme on `musicEnded`).

## 03_data_items.js
- 1,918 templates, 29 sets. `G.Data.lostKingdom = {armour:{light,medium,heavy}, weapons:{subtype:tid}, jewellery:[8 tids], sets:[5 ids], mount:'mount_lostkingdom'}`; `G.Items.lostKingdomSet(cls)` → 18 instances; `G.Items.starterGear(cls)`.
- Ranged-slot subtypes: bow, crossbow, javelin, throwing, staff, runestone, instrument → `R` reads `player.equipment.ranged`. Extra subtypes `throwing`, `talisman` (off-hand focus). Only halberd is two-handed. Dual-wield: one-handed weapons may go in offhand via `equip(player, i, 'offhand')`.
- `lootFor(type, level)` → array with `.gold` (copper). `setBonuses(ent)` → `{stats, sets:[...]}`. `use(player, slotIndex)` calls `G.Combat.heal/addEffect`, `G.Player.teleport` when present.
- Helpers: `template(tid)`, `all()`, `bySlot`, `tierFor`, `typeLabel`, `slotsFor(inst)`, `rarityOf`, `rarityColor`, `isEquippable`, `isUsable`, `isTwoHanded`, `dps`, `classCanWield`, `classOk`, `findInInventory`, `freeSlots`, `usedSlots`, `destroy`, `equipDirect(player, inst|tid, slot?)`, `buyValue`, `sellValue`, `iconHTML(inst, size)`, `tooltipHTML(inst, player)`, `compare`.
- Generated gear instances carry overrides over hidden `gen_*` base templates; save as plain JSON.

## 16_fx.js
- Handles: `{kind, pos (Vector3 — move it to move the effect), alive, target, stop(), setPos()}`. Common opts: `dir|yaw, color, scale, target (entity/Object3D followed each frame), yOff, duration, loop, light, variant, from`. `spawn` returns null for bad pos/kind. `setBeacon(pos|null)` accepts `{x,z}`.
- `projectile({from, to|target, speed, kind:'arrow'|'bolt'|'stone'|'fire', arc, range, hitRadius, maxTime, onHit(point, ent|null)})` — onHit fires exactly once. Extra kinds: `beam` (opts.from), `flash`, `ring`, `teleport` (opts.out).
- Uses `G.Game.renderer.getDrawingBufferSize` if present for point sizing; `setViewportHeight(px)` otherwise. One-shots > 220 m from camera are skipped. Entities are aimed at `pos + height×0.55`.

## 13_buildings.js
- `G.Buildings.init(scene)` then `build()` places everything from `G.Data.world` (towns, POIs, docks). `update(playerPos, dt)`. Events: `enterBuilding`, `leaveBuilding`, `doorToggled`.
- Buildings carry `interiorSpots` `[{x,y,z,yaw,role}]` (roles keeper/vendor/boatmaster/lord/forge/fire/table/bed/sit/pray/watch/idle); `G.Buildings.spotFor(npcId)` returns a spot for an interior NPC. Docks: `dock.building`, `dock.deckY`, building `dockEnd`.
- Town walls for `town.walls` truthy or id 'bree'. POIs without `buildings` get generated ruins by kind. `nearest(pos, filter)`, `isInside(pos)`, `playerInside`, `openDoor/closeDoor/toggleDoor(ent)`, `stats()`.

## 10_terrain.js
- `init()` ≈ 300 ms, `build(scene)`; `update(playerPos, dt)`. Main should call `G.Terrain.warmup(x,z,radius)` around the spawn during loading and pre-warm `mapCanvas(1024)` (≈ 520 ms) to avoid a first M-press hitch.
- Reads optional `G.Data.world.water` (seaWestX/seaNorthZ, lakes, rivers, bays, landmasses, islands) — §9 defaults otherwise. `slope()` = sin(angle). `groundType` never returns 'wood' (Player should treat `G.Buildings.isInside` / floor colliders as wood).
- Extras: `groundColor(x,z,out)`, `townAt(x,z)`, `zoneWeight`, `worldToMap(x,z,size)`/`mapToWorld`, `coarseHeight`, `stats()`, `ready`, `water` mesh, `setSun`, `setSkyColor`.

## 20_player.js
- Scene: reads `G.Game.scene` or `G.Player.setScene(scene)`. Main must call `G.Player.resize(w,h)` on resize (camera aspect). Starter mount tid is `mount_starter`.
- Calls if present: `G.UI.fade(seconds)`, `G.UI.anyOpen/notify/floatText`, `G.Combat.damage/useAbility/isHostile/tryAutoLoot`, `G.Progress.grantStarterAbilities`, `G.Boats.sailing`, `G.Fishing.state`, `player.casting`.
- Esc handling: Player clears target/stops autoMove and consumes Escape only when a target existed and no panel is open; HUD's Esc (settings) runs otherwise.
- Player fields other modules may read: `invulnerable`, `rollReady`, `mountRig`, `speedMult` (admin), `heightScale`, `spec` (creation spec). Events: `targetChanged`, `mounted`, `zoneChanged`, `playerRespawn`, `autoMoveArrived`, `autoMoveStopped`.
- Extras: `getRight`, `mount(tid)`, `canMount()`, `rollCooldown()`, `interactLabel()`, `interactTarget {ent,label,name}`, `headPos/handPos(out)`, `autoMoving/autoStuck`, `snapCamera()`, `computeStats()`, `checkZone()`, `setCameraDistance(d)`, `useHotbar(i)`, `firstPerson`.
