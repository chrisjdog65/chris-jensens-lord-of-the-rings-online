# Requirements checklist (from the user's brief) — every line must be verified in the built HTML

## Delivery
- [x] R01 Single self-contained HTML file, downloadable, playable directly from file:// with no network.
- [x] R02 "AAA / play-ready / bug-free": no console errors, no uncaught exceptions during a 5-minute scripted session; every panel opens/closes cleanly.
- [x] R03 60 FPS target: adaptive quality; ≤ 600 draw calls at high; no per-frame allocations in hot paths; smooth camera/movement (no jitter).
- [x] R04 Beautiful graphics: post-processing (bloom, ACES, FXAA, sharpen), shadows, day/night, weather, water, vegetation with wind, fog.

## Controls
- [x] R10 W forward, S backward, A strafe left, D strafe right (relative to camera).
- [x] R11 Mouse left/right turns the view (pointer lock; RMB-drag fallback); mouse wheel zooms in/out.
- [x] R12 Third-person camera with collision.
- [x] R13 Q = dodge roll (i-frames, cooldown, dust FX, sfx).
- [x] R14 R = ranged weapon attack (projectile, damage, uses equipped ranged weapon).
- [x] R15 E = interact: open doors, talk to NPCs, gather nodes, loot, docks, fishing spots.
- [x] R16 I = inventory with EXACTLY 200 slots.
- [x] R17 F = fishing at water (minigame, catches fish items, skill).
- [x] R18 H = mount/dismount horse (rideable, faster).
- [x] R19 J = journal: current quests in detail + remaining quests.
- [x] R20 K = abilities tab: unlock at levels, train for gold.
- [x] R21 C = character tab: player model, stats, equipped items, full gear set detail (LOTRO-style paper doll with 18 slots, set bonuses).
- [x] R22 B = auto-quest: completes ALL quests to 100%, ends with best gear in the game, never deadlocks.
- [x] R23 M = map: shows exact player position, next quest objective, quest tracker (HUD) + minimap.
- [x] R24 Typing `chris` (lowercase) opens the admin panel: edit money, gear sets, map places, stats, quests, everything.
- [x] R25 Unused letters/numbers bound to hotbar abilities (1-0, G T V X Y Z L N O U).
- [x] R26 Space jump, Tab target, Esc close, Enter chat, F1 help.

## Content
- [x] R30 100 story quests + 50 side quests (data), all completable.
- [x] R31 Level cap 80; XP curve reaches 80 by the end of the story.
- [x] R32 Very large map (4 km × 4 km) with 15 zones, 25 towns, ≥ 220 NPCs, ≥ 70 monster types, lots of content.
- [x] R33 Boats: sail to different islands (docks + free sailing + fast travel).
- [x] R34 Enterable buildings with real interiors (furniture, NPCs, fireplaces).
- [x] R35 150 AI players that act like humans: move, fight, level up, chat, group, react to the player.
- [x] R36 P = players panel: every player, where they are, select to see level/stats/gear; live progression.
- [x] R37 Character creation: male/female, 10 races, 10 classes, appearance, 3D preview.
- [x] R38 Sound effects + music (procedural, no files), zone themes, combat music, ambient. (fishing cues verified: cast/bite/catch/fail, auto and manual)
- [x] R39 Good movement/combat/gameplay mechanics: abilities, cooldowns, buffs/debuffs, crits, loot, XP, death/respawn, vendors, trainers.
- [x] R40 Good UI/UI mechanics: tooltips, drag&drop, panels draggable, chat, notifications, floating combat text.
- [x] R41 Save/load (localStorage), continue from main menu.
- [x] R42 Journal (J) also lists EVERY quest still left to do (including locked ones with their unlock requirement), with remaining counts.
- [x] R43 Full auto-quest run (B) from a fresh level-1 character ends at 150/150 quests, level 80, wearing the complete Armour of the Lost Kingdom set, with zero errors (tools/verify.js --full-autoquest).
- [x] R44 Mouse look works without holding a button once the canvas is clicked (pointer lock), and RMB-drag look works without pointer lock.
- [x] R45 Music is audible after the first click (zone theme playing, `G.Audio.currentTheme` set) and changes with zone/combat; SFX fire on actions (swing, hit, footsteps, UI).
