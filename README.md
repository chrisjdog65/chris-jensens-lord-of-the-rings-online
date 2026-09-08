# Chris Jensen's Lord of the Rings Online

A single-file, third-person Middle-earth RPG. Download `Chris-Jensens-LOTRO.html`, open it in
Chrome or Edge, and play. No installer, no server, no internet connection required — the entire
game (engine, world, quests, art, music) is inside that one file.

## Running it

Double-click the file, or drag it into a browser window. Click once to begin (browsers require a
click before audio may start). Your progress saves automatically to the browser and appears as
**Continue** on the main menu.

Best experience: a desktop browser at 1080p or higher. The game measures its own frame rate and
lowers graphics quality automatically if needed; you can pin a quality level in Settings.

## Controls

| Key | Action |
|---|---|
| W A S D | Move (relative to the camera) |
| Mouse | Look around; click the world once for free mouse-look, or hold right-drag |
| Mouse wheel | Zoom the camera in and out |
| Left click | Attack |
| Right click (hold) | Block — reduces incoming damage |
| Space | Jump |
| Q | Dodge roll (brief invulnerability) |
| R | Ranged attack with your equipped ranged weapon |
| E | Interact — doors, people, chests, gathering, docks, fishing spots |
| Tab | Target the next enemy |
| 1–9, 0, G T V X Y Z L N O U | Ability hotbar (20 slots) |
| I | Inventory (200 slots) |
| C | Character sheet — 18 equipment slots, stats, gear sets, 3D preview |
| K | Abilities — unlock at level, train with gold |
| J | Journal — active quests in detail, and every quest remaining |
| M | Map — full world map, quest markers, waypoints |
| P | Players — all 150 other adventurers, their level, location and gear |
| H | Mount or dismount your horse |
| F | Fishing (stand at the water's edge) |
| B | Auto-quest — plays the game for you, start to finish |
| Enter | Chat |
| Esc | Close a window, or open Settings |
| F1 | Key bindings |

Typing `chris` opens the admin panel, where you can change anything: level, gold, gear, stats,
quests, the time of day, weather, where you stand, and more.

## The world

Eriador, four kilometres across, from the Shire to the Sundered Isles. Fifteen regions, twenty-five
towns and camps, roads between them, and a coastline with islands you reach by boat.

- **150 quests** — 100 story quests across eight books, plus 50 side quests. The story runs from a
  shadow falling on the Shire to the Gaunt-lord on the Isle of Himring.
- **Level cap 80**, ten playable races and ten classes, each with thirteen abilities you train for gold.
- **296 named characters** to talk to, 113 kinds of creature, twelve bosses.
- **Buildings you can walk into** — inns, shops, halls, hobbit-holes — with furniture, hearths,
  upper floors and people inside.
- **150 other players** who quest, fight, level up, form fellowships, sail, and talk in chat. Say
  hello and they will answer.
- **Fishing** at rivers, ponds and coasts, with a catch worth chasing.
- **Boats** to Tol Fuin, Tol Morwen and Himring.
- **Music and sound** composed and synthesized in the browser: a theme for every region, combat
  music, taverns, weather, and hundreds of effects.

Press **B** at any time and the game will play itself: it completes all 150 quests, reaches level
80, and equips the best armour in the game.

## Building from source

The playable file is committed at the repository root. To rebuild it from `src/`:

```
node build.js          # writes dist/Chris-Jensens-LOTRO.html and the copy at the root
node tools/smoke.js    # boots the game headless and checks for errors
node tools/verify.js   # runs the requirement suite
```

Source layout: `src/js/` holds the modules in load order (core, data, engine, gameplay, UI),
`src/css/` the interface theme, `vendor/` the Three.js runtime. `docs/SPEC.md` is the architecture
contract every module follows.

---

A fan tribute. Not affiliated with the rights holders of *The Lord of the Rings*.
