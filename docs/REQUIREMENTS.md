# Requirements checklist (from the user's brief) — every line must be verified in the built HTML

## Delivery
- [ ] R01 Single self-contained HTML file, downloadable, playable directly from file:// with no network.
- [ ] R02 "AAA / play-ready / bug-free": no console errors, no uncaught exceptions during a 5-minute scripted session; every panel opens/closes cleanly.
- [ ] R03 60 FPS target: adaptive quality; ≤ 600 draw calls at high; no per-frame allocations in hot paths; smooth camera/movement (no jitter).
- [ ] R04 Beautiful graphics: post-processing (bloom, ACES, FXAA, sharpen), shadows, day/night, weather, water, vegetation with wind, fog.

## Controls
- [ ] R10 W forward, S backward, A strafe left, D strafe right (relative to camera).
- [ ] R11 Mouse left/right turns the view (pointer lock; RMB-drag fallback); mouse wheel zooms in/out.
- [ ] R12 Third-person camera with collision.
- [ ] R13 Q = dodge roll (i-frames, cooldown, dust FX, sfx).
- [ ] R14 R = ranged weapon attack (projectile, damage, uses equipped ranged weapon).
- [ ] R15 E = interact: open doors, talk to NPCs, gather nodes, loot, docks, fishing spots.
- [ ] R16 I = inventory with EXACTLY 200 slots.
- [ ] R17 F = fishing at water (minigame, catches fish items, skill).
- [ ] R18 H = mount/dismount horse (rideable, faster).
- [ ] R19 J = journal: current quests in detail + remaining quests.
- [ ] R20 K = abilities tab: unlock at levels, train for gold.
- [ ] R21 C = character tab: player model, stats, equipped items, full gear set detail (LOTRO-style paper doll with 18 slots, set bonuses).
- [ ] R22 B = auto-quest: completes ALL quests to 100%, ends with best gear in the game, never deadlocks.
- [ ] R23 M = map: shows exact player position, next quest objective, quest tracker (HUD) + minimap.
- [ ] R24 Typing `chris` (lowercase) opens the admin panel: edit money, gear sets, map places, stats, quests, everything.
- [ ] R25 Unused letters/numbers bound to hotbar abilities (1-0, G T V X Y Z L N O U).
- [ ] R26 Space jump, Tab target, Esc close, Enter chat, F1 help.

## Content
- [ ] R30 100 story quests + 50 side quests (data), all completable.
- [ ] R31 Level cap 80; XP curve reaches 80 by the end of the story.
- [ ] R32 Very large map (4 km × 4 km) with 15 zones, 25 towns, ≥ 220 NPCs, ≥ 70 monster types, lots of content.
- [ ] R33 Boats: sail to different islands (docks + free sailing + fast travel).
- [ ] R34 Enterable buildings with real interiors (furniture, NPCs, fireplaces).
- [ ] R35 150 AI players that act like humans: move, fight, level up, chat, group, react to the player.
- [ ] R36 P = players panel: every player, where they are, select to see level/stats/gear; live progression.
- [ ] R37 Character creation: male/female, 10 races, 10 classes, appearance, 3D preview.
- [ ] R38 Sound effects + music (procedural, no files), zone themes, combat music, ambient.
- [ ] R39 Good movement/combat/gameplay mechanics: abilities, cooldowns, buffs/debuffs, crits, loot, XP, death/respawn, vendors, trainers.
- [ ] R40 Good UI/UI mechanics: tooltips, drag&drop, panels draggable, chat, notifications, floating combat text.
- [ ] R41 Save/load (localStorage), continue from main menu.
- [ ] R42 Journal (J) also lists EVERY quest still left to do (including locked ones with their unlock requirement), with remaining counts.
- [ ] R43 Full auto-quest run (B) from a fresh level-1 character ends at 150/150 quests, level 80, wearing the complete Armour of the Lost Kingdom set, with zero errors (tools/verify.js --full-autoquest).
- [ ] R44 Mouse look works without holding a button once the canvas is clicked (pointer lock), and RMB-drag look works without pointer lock.
- [ ] R45 Music is audible after the first click (zone theme playing, `G.Audio.currentTheme` set) and changes with zone/combat; SFX fire on actions (swing, hit, footsteps, UI).
