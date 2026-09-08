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
- Input edge queue (verification fix): a key that went down AND up between two frames still reports `pressed(code)` for exactly one frame; a second tap of the same key — and every tap after it, to keep arrival order — is queued and exposed on the following frames (`pendingEdges()` counts them, cap 32). `pressedCodes(out)` lists this frame's edges in arrival order (fill a reused array). `consume(code)` also removes a still-queued edge (for DOM handlers reacting to the same keydown). Focusing a text field clears held keys but keeps pending edges; the HUD replays them (Escape/Enter into the chat, other keys dropped). Handle edges per code, never with an early `return` after the first one.
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
- Interiors: every enterable has a CEILING in the `int`/`upper` group that is never hidden (flat boards+joists, or the roof underside with rafters/purlins for halls and the inn's upper storey) plus a non-floor ceiling collider (`Physics.cameraClamp` keeps the chase camera under it, jumps bump it). Only the exterior `roof` group hides, and only once the player AND the camera are inside (`bld.inside` / `bld.camInside`) — so a camera above still sees the shell.
- Doors auto-open within 3.4 m of the player and re-close 8 s after everyone leaves; a door shut by hand (E) sets `holdClosed` and stays shut until the player steps away. A closed door is a wall collider, which `Player.autoMove` steers around — that is why the radius is larger than the interaction range.

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

## 05_data_world.js
- Lookups: `zoneById/townById/npcById/monsterById/dockById/spotById/nodeById/poiById/bossById/spawnById/roadById`; helpers `isWater(x,z)`, `landInfo`, `zoneAt`, `townAt`, `nearestTown`, `typesInZone`, `spawnsInZone`, `npcsInTown`, `questGivers`, `travelRoutesFrom`, `startTowns`. 25th town is `chetwoodcamp`. Docks: 7 incl. `dock_duillond`. Bosses carry `poi`, `aquatic` (sea-serpent stands in the sea). NPCs: `hub:true`, `dock`. Missing item ids `mat_mushroom`, `misc_treasure_cache` were ADDED to 03 by the orchestrator.

## 12_vegetation.js
- `setWind(strength)` auto-driven by `weatherChanged`; `treesNear(x,z,r)` reused buffer; `stats()`, `cellAt`, `setDensity` regenerates everything (heavy frame — call only from settings). Assumes `groundType` 'grass' for meadows, 'dirt' in towns.

## 14_characters.js
- Humanoid spec extras: `name/title/level/nameColor` (auto nameplate), `eyes`, `beard`, `look`, `faceOpts`, `hover`, `weaponScale`. Rig extras: `setProp('rod'|'chest'|null)`, `onOneShotEnd`, `oneShotRemaining`, `meshes`, `meshCount`. The `attack` anim alias picks slash/thrust/cast/shoot from the main-hand shape. Non-forced `idle/walk/run` clear any state anim including death — so owners must NOT call setAnim('idle') on dead entities.
- Monster `size` is relative to the family's natural size (troll/giant/etc. treat size > 1.6 as absolute human-height multiples). Sea-serpent needs to be placed at the water surface by its owner.
- Extras: `buildWeapon(shape,color,glow)`, `updateNameplate(sprite, camera)`, `releaseNameplate`, `material(hex, opts)`, `update(dt)` self-hooked on `update`, `stats()`, `trimCache(max)`, boat `animate(t)`, prop `open()/close()/update(dt)`.

## 22_monsters.js
- `init(scene?)` (else `G.Game.scene`), camera from `G.Player.camera`/`G.Game.camera`. Combat must call `G.Monsters.onDamaged(ent, src)` and `onTaunt(ent, src)`; Monsters listens to `entityKilled`. Monsters honour `ent.invulnerable`/`leashing` by healing (Combat may also skip damage on `invulnerable`).
- Entity extras: `dmg, armour, speed, aggroRange, abilities, lootTable, xpMult, attackInterval, home, group, bossRec, leashing, invulnerable, immune{stun,knockback}, engagedBy, plate`. Registry boss/elite types are already pre-scaled by 05 (Monsters does not double-scale).
- API: `hostilesNear(pos,r)` (reused buffer), `nearestHostile(pos,r,filter)`, `spawnAt(typeId,x,z,opts)`, `spawnForQuest(typeId,pos,count)`, `nearestSpawnOf(typeId,pos)` → `{x,z,dist}|null`, `killAllNear`, `respawnAll`, `all()`, `get(id)`, `inTown(pos)`, `setTarget/dropTarget`, `stats()`.

## 34_save.js
- API: `G.Save.save(opts?)` → snapshot|null (`{silent, reason}`; writes `localStorage[G.C.SAVE_KEY]`, emits `save(snapshot)`, notifies "Game saved" unless silent); `load()` → validated + migrated snapshot|null (null for absent / corrupt / newer-version saves, reason in `G.Save.lastError`); `hasSave()`; `clear()` (emits `saveCleared`); `exportJSON()` (pretty; the LIVE game when a player exists, else the stored save); `importJSON(str)` → `{ok, error?, data?, summary?, persisted}` — validates and STORES only, call `G.Game.startFromSave()` afterwards; `summary(data?)` → `{name, race, raceName, cls, className, gender, level, zone, zoneName, playTime, playTimeText, savedAt (G.time.now), savedWall (ms epoch), savedAgoText, gold, questsDone, version}` for the Continue card. Extras: `snapshot()` (build without writing), `validate(data)` → `{ok, data|error}`, `autosave(reason)`, `flushAutosave(reason)`, `autosaveEnabled` (bool), `fmtPlayTime(sec)`, `storageAvailable()`, diagnostics `last / lastSavedAt / lastError / lastSize / lastReason / persisted / saves`.
- **`G.Game.startFromSave()` order**: `const data = G.Save.load(); if (!data) → stay in menu; G.Player.create(data.charSpec)` (charSpec = race/cls/gender/name + skin/hair/hairColor/hairStyle/eyes/height/build, plus `level, x, z, yaw` so the player is created at the right level and place) `→ G.Quests.init() → G.Save.apply(data) → … → emit gameStart`. `apply()` never throws (each stage isolated, failures → `G.reportError`), places the player with `G.Player.spawnAt` (no teleport FX), emits `load(snapshot)` (Player snaps the camera, Combat re-shapes the player on it). If `Quests.init()` runs AFTER `apply()` and wipes the state, Save re-restores once on `gameStart` with a warning — do not rely on it.
- **Quests contract**: `G.Quests.serialize()` → JSON-safe object (any shape), `G.Quests.restore(obj)` re-applies it (must work after `init()`). Fallback when absent: Save snapshots `{state: G.Quests.state (object or Map), tracked}` and restores by clearing / re-filling `G.Quests.state` in place (ids unknown to `G.Data.questById` dropped, entries normalised to `{status, progress[], accepted, …}`), then `setTracked(id)` if present else `tracked =`.
- **AI players contract**: `G.AIPlayers.serialize()` → JSON-safe compact object (level / zone / pos / xp per player), `G.AIPlayers.restore(obj)`; no fallback (they rebuild deterministically). On a storage quota error the save is retried without `aiplayers` (`data.slim = true`).
- Snapshot v1: `{version, game, gameVersion, savedAt, savedWall, playTime, charSpec, player:{pos{x,y,z}, yaw, level, xp, gold, morale, power, inventory (plain instances, trailing empties trimmed), equipment (slot → inst|null), abilities[], hotbar[20], mounts[], activeMount, titles[], activeTitle, statBonus, statOverride}, stats, fishingSkill, zone, time:{dayTime, dayIndex, dayLengthMinutes}, weather, quests, aiplayers, autoQuest:{speed}, settings, quality, customPlaces[], waypoint{x,z,label}|null, adminFlags:{godMode, damageMult, noCooldowns, speedMult}, uidCounter}` (≈3–6 KB early; bags dominate later). Only JSON-safe values survive: Set → array, Map → object, THREE/DOM/class objects dropped, keys starting with `_` dropped — keep item-instance / quest / AI data plain.
- `apply()` writes: the player fields above (inventory / hotbar / abilities mutated in place; item instances restored as-is, unknown templates dropped with a notice, unknown ability / title / mount ids dropped, level clamped to the cap and xp to the level's band, non-equippable items moved to bags, effects / cooldowns cleared, morale / power clamped after `G.Player.computeStats()`, `rig.setEquipment(equipment)`), emits `equipChanged, inventoryChanged, hotbarChanged(-1), goldChanged`; `G.state.stats / fishingSkill / customPlaces / settings / godMode / damageMult / noCooldowns / speedMult` + `player.speedMult`; `G.state.zone` only when no terrain (`spawnAt → checkZone` wins); `G.Sky.setTime / setWeather(kind, true) / dayIndex`; `G.Audio.setVolumes(music, sfx)`; `G.PostFX.setQuality(q)` (else `G.state.quality`); `G.Player.setCameraDistance`; `G.AutoQuest.speed`; `G.UI.waypoint` by assignment (so `setWaypoint`'s notice does not fire on load); `G.uidBump(uidCounter)` FIRST, before quest / AI restores create entities.
- Admin panel: admin flags live on `G.state.godMode / damageMult / noCooldowns / speedMult` (Player reads `player.speedMult` — set both); custom map places are `G.state.customPlaces = [{name, x, z, …}]` (extra plain fields persist, ≤ 200). Save tab: `exportJSON()` into the textarea, `importJSON(text)` then `G.Game.startFromSave()`, `clear()` for reset.
- Autosave: `G.timers.every(60)` game-seconds (re-armed on `gameStart`) while `G.state.phase === 'playing'`, the player is alive and `!G.Boats.sailing`; `questCompleted / playerLevelUp / panelClosed` debounced 5 s (wall clock); `beforeunload / pagehide / visibilitychange → hidden` flush immediately. Silent saves show a "Saved" chip via `G.UI.notify(…, 'info')` at most once per game minute. Settings: `G.Save.autosaveEnabled = false` disables all of it; "Save Now" = `G.Save.save()`.
- Storage: when `localStorage` is blocked or full the save is kept in memory for the session (`persisted = false`, `lastError` set, quota errors notify the player); `load()` still works from that copy.

## 23_npcs.js
- Needs a scene: `sceneReady` event or `G.Game.scene` (or `setScene`). Dialogue: `G.UI.Dialogue.open(npc, greeting, options)`; options have `kind` ('quest'|'turnin'|'progress'|'trade'|'train'|'travel'|'sail'|'rest'|'talk') and non-quest ones carry `action()` — the panel should call `G.NPCs.choose(npc, opt)`; `G.NPCs.endTalk()` on close. Travel: `G.UI.Travel.openStable(npc)` / `openDock(dock, npc)`. Vendor: `G.UI.Vendor.open(npc, stock)` where stock instances carry `.price`; `buy(npc, tid, count)`, `sell(npc, slot)`, `sellJunk`, `buyback/rebuy`.
- Gather nodes write `player.casting` `{x,z,end(far future),elapsed,duration,name}` for the HUD cast bar; `G.NPCs.channel`, `cancelChannel()`. `npc.questMark` ('!'|'?'|'?grey') for minimap. Events: `npcTalk`, `npcTalkEnd`, `vendorOpened`, `gatherStart`, `gathered`, `rested`.
- BUG for 13_buildings: line ~2407 passes colour names ('chestnut') to `G.Chars.buildHorse` (expects hex) → "Unknown color" warning. FIX in polish.
- Data note: `map_home` vendor value 0.

## 30_ui_hud.js
- `registerPanel(id, def)` extras: `footer(el,panel)`, `buttons[]`, `remember`, `sound`, `rebuildOnOpen`, `minWidth`; `openPanel(id, arg)` forwards arg to `onOpen`. Panel objects: `addButton/setTitle/refresh/close`. Key-help panel id is `keyhelp`.
- HUD consumes Esc, Enter, F1, B and registered panel keys; hotbar keys are executed by Player (`useHotbar`), HUD only flashes. `G.Player.interactTarget` preferred for the prompt. `player.casting` shape `{name|id, elapsed|start|end, duration|total}`.
- Extras: `notifyBig(text, sub)`, `showLoot(items, gold)/hideLoot`, `setWaypoint(x,z)/clearWaypoint/waypoint`, `DeathScreen{show,hide,visible}`, `minimap{zoom,setZoom,redraw,worldAt}`, `tracker{refresh}`, `hotbarRefresh()`, `showZone(zoneId)`, `getPanel/topPanel/anyModal/openPanels`, `fade(seconds)`, `fps`, `hudVisible`, `chatCommand`, `chatSend`.

## 21_combat.js
- Entity fields: `gcdReady/gcdReadyAt`, `nextSwing`, `lastCombat`, `casting {ability,id,name,start,castTime,end,target}`, `threat{}`. Events: `abilityUsed`, `entityDamaged`, `entityHealed`, `effectsChanged`, `castStart/castEnd`, `lootDropped/lootTaken`, `xpGained`, `hotbarChanged`, `titleEarned`.
- Extras: `canUse/abilityReady/cooldownLeft/cooldownFrac`, `cancelCast/interrupt/isCasting/castProgress`, `hostilesNear/friendliesNear/nearestHostile`, `addThreat/topThreat/taunt`, `lootBags/tryAutoLoot/autoLootEnabled`, `revive(ent, frac)`, `suggestMonsterStats(level,{elite,boss})`, `heroDPSEstimate`; Progress `setLevel`, `canTrain`, `untrainedAvailable`, `hotbarSlotOf/firstFreeHotbar`, `ensurePlayerShape`, `awardTitle`.
- Loot bag mesh needs `G.Game.scene`. Combat/boss music with zone restore via `G.Game.zoneMusic?.()`.
- Low-FPS hardening (fix wave C): the GCD counts as ready when it expires within the current frame (`G.time.dt`, capped 0.25 s) so a tap is never dropped until the next frame; `damage/kill/creditFor` accept entity ids as well as objects; `canSee` is always true at touching distance (both inside melee reach, |dy| ≤ 3.5) so a prop cylinder / terrain bump between adjacent fighters cannot veto swings; an ability projectile whose intended target is still alive, hostile and inside range+3 m lands even if the physics sweep clipped something first (`Miss` only when the target died / left range). Kill credit needs `killer` to be the player entity (or an owner chain ending at it) — `entityKilled {victim, killer}` carries the raw killer.
- **BALANCE ACTION (integration phase):** 05's monsterTypes are ~0.25× morale and ~0.04× dmg of the hero curve → 22_monsters should derive `maxMorale`/`dmg`/`armour` from `G.Combat.suggestMonsterStats(level, {elite, boss})` (or 05 scales morale ×4, dmg ×25, armour ×2.5). Target TTK 4–8 s 1v1; a same-level duel should cost ~25% morale.

## 32_ui_admin.js
- Opens on typed `chris` and `G.UI.Admin.open()`; panel id `admin`. Owns on `G.state`: `godMode, damageMult, speedMult (mirrored to player.speedMult), noCooldowns, noclip, flyCam, freeTraining, customPlaces, clockPaused, wireframe, topDown`. Events: `customPlacesChanged`, `townRenamed`, `adminOverride`. Uses `G.UI.Map.pickOnce` if panels provide it. Town renames not persisted by save (TODO polish).

## 26_fishing_boats.js
- Fishing reads `KeyF` itself (`G.Fishing.handlesKey = true`) — Player must NOT also toggle fishing. `G.Fishing.autoFish()` for the bot; events `fishingStart/fishCaught/fishingEnd`.
- Boats: main must call `G.Boats.init(scene?)` AFTER Buildings, and `G.Fishing.update/G.Boats.update` after `G.Player.update`. `sailTo(dockId, fromDock, opts)` charges the fare itself (opts.paid/free to skip) — Travel panel must not charge again. Camera during sailing/cinematic is driven through `G.Player.cam`. Owns a `#boatFade` overlay (uses `G.UI.fade` if present). `pathToZone`, `routesFrom`, `nearestDock`, `dockForZone`, `instantTravel`, `travelCost`. Events: `boarded/disembarked/sailDepart/sailArrived`.
- Dock positions in 05 were moved to the shoreline by the orchestrator (all 7 now at terrain height ≈1.5 m with water within 14 m).

## 33_ui_charcreate.js
- Auto-initialises on DOM ready (loading screen visible before main). Main: forward `G.Game.progress(pct,text)` → `G.UI.Menu.progress`; call `G.UI.Menu.show()` when ready; call `G.UI.Menu.update(dt)` each frame during menu/create and render with `G.UI.Menu.getCamera()` (= `G.Player.camera`). `G.UI.Menu.driveWorld` (default true) streams Terrain/Veg/Buildings/Sky around the menu camera — set false if main drives them. Spec includes `eyeColor`. Events: `menuShown/menuHidden/createShown/createHidden/createConfirmed(spec)/loadingDone`. Calls `G.Game.startNew(spec)` / `G.Game.startFromSave()`.

## 24_quests.js
- `G.Quests.init()` at game start (before Save.apply). Collect-from drops are implemented by Quests in the `entityKilled` handler (Monsters/Combat need not drop quest items). `questDropsFor(typeId)`. Reward `choose` via `G.UI.Choose.open({quest, items, onPick(index)})`. s100 grants the Lost Kingdom set. `serialize/restore` in `{state, tracked}` shape. Extras: `get/list/storyIds/sideIds/activeIds/readyIds/availableIds/statusOf/progressOf/completeObjective(id,i)/bestChoice/posOfNpc/nextStory/bookOf/resolveObjective/grantLostKingdom`. Events: `questAbandoned, questTracked, questsInit, questsRestored, autoQuestStart/Stop/Finished`.
- `G.AutoQuest`: `start/stop/toggle/active/paused/speed/status()/stats/plan/goTo/teleportNear/log`. Uses `G.Boats.pathToZone/instantTravel/sailTo`, `G.Fishing.autoFish`, `G.Player.autoMove`. Quest XP alone reaches ~L65; kills fill the rest (finish bumps to cap with a warn if short).

## 25_aiplayers.js
- `init(scene?)`, `update(dt)`; hooks: Combat should call `G.AIPlayers.onDamaged(ent, src, amount)` for aiplayer victims (optional). HUD `/w Name text` must emit `chat {channel:'whisper', to:'Name', text}`. `setChatRate` stores `G.state.settings.aiChat`. Emits `aiLevelUp`, `aiDeath`, `aiChat`. Extras: `spawnNear(pos)`, `whisper(name,text)`, `say(id,text)`, `fellowships`, `chatLog`, `all`.

## 31_ui_panels.js
- Extras: `G.UI.Map.pickOnce(cb)/cancelPick/focus/centerOn/centerOnPlayer/setZoom/prewarm()`, `Inventory.highlight/setFilter/sort/splitStack`, `Character.rebuildPreview`, `Journal.select(id)/open(id)/setTab('active'|'available'|'remaining'|'completed')` (Remaining = every quest not done incl. locked, by Book / zone, status chip + level/zone/giver/prerequisite, header "Remaining: N of 150 (Story a/100 · Side b/50)"; locked quests open in full detail), `Players.select/search`, `Dialogue.showQuest`, `Choose.open(items, onPick(index, inst))` (cancel → −1), `G.UI.contextMenu(items,x,y)`, fallback `G.UI.fade`. Map paints its own label-free base (Terrain `mapCanvas` bakes labels — a `{labels:false}` option would be cleaner; the minimap also shows giant baked letters → polish). Writes `player.title` display name.

## INTEGRATION FINDINGS (first full smoke run)
- SMOKE OK with 30 modules. Stats at high quality: drawCalls 985 (budget ≤ 600), triangles 1.47M, entities 953, NPC rigs 27, monster rigs 14, AI rigs 5, veg 23 calls, chunks ~50–125. → PERF: reduce per-rig draw calls (merge static parts / share materials), cap rendered NPC rigs ~16 & monsters ~24 & AI ~12 by distance, no shadows on far rigs.
- Warnings: `[Buildings] unknown recipe banner`, `unknown recipe anvil` (used as town props in 05) → add prop recipes or alias.

## 99_main.js
- `G.Game`: `boot, startNew, startFromSave, toMenu, toCharCreate, restart, zoneMusic(), togglePause, readyPromise, fps, frameMs, autoQuality, scene, renderer, camera, canvas, timings`. `renderer.info.autoReset=false` with a manual reset so drawCalls in `__T.stats()` include shadow + PostFX passes (main pass ≈ 581 in Archet at 'high'; 992 incl. passes).
- `__T`: `ready, inGame, errors, G, quickStart(opts), stats(), press(code), teleport(x,z), setTime(h), screenshotReady(), waitFrames(n), timings`. Scripted tests must space repeated same-key presses by ≥ 1 frame (use `__T.waitFrames`) under software GL.
- Boot ≈ 6.6 s on a quiet machine (swiftshader). Auto-quality steps down when fps < 50.

## Polish pass 1 (terrain/buildings/minimap)
- `G.Terrain.mapCanvas(size, {labels:false})` cached label-free base; minimap draws its own small labels. Town cores: packed earth + pale road paths (`town.groundFill` override; hobbit towns stay grass). Small lakes depth ≤ 4 m with gentle banks; coast slope halved within ±14 m of the waterline. Recipes `banner` (wind-swayed cloth, heraldry by town style) and `anvil` added — smoke warnings gone.
- Caveat: Hobbiton/Bywater/Ost Guruth town base heights dropped ~1.5–2.5 m due to pond hollows (buildings re-sample terrain so fine).
