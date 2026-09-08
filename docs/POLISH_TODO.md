# Polish backlog (observations from screenshots; addressed in the polish phase)

- [ ] Characters (14): heads are smooth blobs with weak faces from behind; add more silhouette detail (hair volume, collars, belts, boots, shoulder shapes), better face features, cloth folds via vertex colour bands, subtle outline/rim. Ensure hobbits/dwarves read distinctly.
- [x] Terrain (10): close-range detail — DONE in the beauty pass (3-scale detail map + macro hue drift + bumped normal within 42 m; dry ground-cover tufts on packed earth from 12). Small-lake banks were already softened in polish pass 1.
- [x] Verify PostFX + Sky + Terrain + Veg together at several times of day (the ACES + bloom look), tune exposure/saturation — DONE; see "Beauty pass" in INTEGRATION_NOTES (before/after sets `tools/out/base-*` vs `tools/out/r3-*`, grade sweep `tools/out/a2-*`).
- [ ] Town walls (13): Bree walls look plain and very tall relative to buildings — check scale in-game.
- [ ] BALANCE: monsters (22) must use `G.Combat.suggestMonsterStats(level,{elite,boss})` for morale/dmg/armour — registry numbers are far too low (see INTEGRATION_NOTES 21).
- [ ] Towns feel empty: Bree square is plain grass — town interiors of the ring should have packed-earth streets (terrain 'dirt' colouring inside town radius along roads/around buildings), more props (barrels, carts, lamp posts, market stalls, fences, hedges), and NPC density near squares.
- [ ] AI players sailing have no boat mesh (invisible at sea) — give sailing AIs a rowboat rig when near the player.
