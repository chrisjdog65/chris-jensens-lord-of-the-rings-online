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
