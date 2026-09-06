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
