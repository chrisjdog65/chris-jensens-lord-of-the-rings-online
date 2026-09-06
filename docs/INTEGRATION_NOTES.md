# Integration notes (collected from module authors' reports — read before writing modules that consume these)

## 04_data_abilities.js
- Monster abilities live in `G.Data.abilities` too (`cls:'monster'`, `monster:true`); `G.Data.abilitiesFor(cls)` excludes them. `G.Data.abilityById(id)` is a FUNCTION.
- `ability.desc` is a TEMPLATE with `{dmg}` etc. UI must render `G.Data.abilityDesc(a, ent)` or `G.Data.abilityTooltipHTML(a, ent)`; `a.descPlain` is a pre-filled fallback.
- Combat semantics: dot/hot `mult` is per tick (no weapon component); heal = mult × mastery/4; mastery = phys for kind melee/ranged, tact otherwise (`ability.mastery` may override). Physical AoEs are kind melee/ranged with `effect.aoe` radius. Stances are 1800 s buffs. `target` hint: 'enemy'|'self'|'ally'|'party'. `threat` hint on tank skills.
- Helpers: `G.Data.abilityDamage(a, ent)` → {min,max,avg,dtype}, `abilityHeal`, `abilityDot`, `monsterAbilitiesFor(family)`, `trainCost(a)` (uses `G.Data.xp.abilityCost`).
