/* ==== 05_data_world.js — World registry for Chris Jensen's Lord of the Rings Online. Pure data + pure functions:
   15 zones, 25 towns (full building/prop layouts), roads & scenic paths, 220+ NPCs, 110+ monster types, 12 bosses,
   170+ spawn areas, 7 docks with boat routes, fishing spots, gather nodes, POIs and stable-master travel routes.
   Public API (all on G.Data.world, schema per SPEC §4.6):
     zones, towns, roads, npcs, monsterTypes, spawns, bosses, docks, fishingSpots, pois, gatherNodes, travelRoutes,
     (boss/elite `abilities` reference ids owned by 04_data_abilities: G.Data.monsterAbilities),
     zoneById, townById, npcById, monsterById, dockById, spotById, nodeById, poiById, bossById, spawnById, roadById (built at load),
     water   — the §9 water model as data (sea lines, lakes, rivers, bays, islands & land exceptions),
     isWater(x, z) → bool   (pure, deterministic; terrain may reuse it so land/water agree with this registry),
     landInfo(x, z) → {water:bool, kind:'sea'|'lake'|'river'|'bay'|'land', island?:id},
     zoneAt(x, z) → zone id (nearest zone by centre distance / radius; 'wild' fallback = nearest),
     townAt(x, z) → town|null,
     helpers: yawTo(fx, fz), distToRoad(x, z), nearestTown(x, z).
   Item ids (loot, fish, gather nodes) are 03_data_items ids; W.itemIdsReferenced lists them, W.itemIdsMissingIn03 the two not yet defined.
   CONVENTIONS (read by 13_buildings / 23_npcs / 10_terrain):
     * yaw is radians, 0 faces −Z (north); forward = (−sin yaw, 0, −cos yaw). A building's door faces forward.
     * Bree/Archet/Aughaire/the Chetwood camp carry walls:true (+wallRadius, wallStyle:'palisade', gates:[{x,z}]) — 13_buildings
       builds the wall ring and its gates from those; the data lists no wall_segment pieces of its own.
     * Linear recipes (wall_segment, fence, ruin_wall) are centred on (x,z) with their LENGTH along local X (perpendicular
       to forward); `len` metres (defaults: wall_segment 16, fence 8, ruin_wall 12). `gate` opening spans local X, forward = outward,
       `width` default 12. `bridge` spans along forward (`len` default 30, centred). `dock` pier extends forward 14 m from (x,z).
     * props: {kind, x, z, yaw, text?, len?}; kinds: well, fence, campfire, market_stall, lamp, sign, crate, barrel, banner, hay, cart, statue, anvil.
     * Interior NPCs carry interior:{town, index} (index into that town's buildings) and are listed in the building's npcInside.
       Their pos is the building's pos; 23_npcs places them at building.interiorSpots. Boat-masters carry `dock` and stand at the dock.
     * Land model: sea is x < −1500 or z < −1650 EXCEPT the three islands (land within `water.islands[].radius`), the Forochel landmass
       (circle r 300 at 600,−1850 with an ice-bay water circle r 130 at 450,−1980) and the isle of Tinnudir (r 90 at −200,−1050) inside
       lake Nenuial. Roads flatten terrain, so the road Trestlebridge→Tinnudir forms a causeway across the lake. ==== */
(function () {
  'use strict';
  const G = window.G;
  G.Data = G.Data || {};
  const W = {};
  const R = Math.PI / 180;
  const round1 = (v) => Math.round(v * 10) / 10;

  // ---------------------------------------------------------------- water model (§9) ------------------------------------------
  const WATER = {
    seaWestX: -1500, seaNorthZ: -1650,
    lakes: [
      { id: 'nenuial', name: 'Lake Evendim (Nenuial)', center: { x: -250, z: -900 }, radius: 260 },
      { id: 'bywater_pool', name: 'The Bywater Pool', center: { x: -1000, z: -120 }, radius: 40 },
      { id: 'lonelands_tarn', name: 'The Weather Hills Tarn', center: { x: 700, z: 120 }, radius: 45 },
    ],
    rivers: [
      { id: 'brandywine', name: 'The Brandywine', width: 12, points: [{ x: -700, z: -1500 }, { x: -650, z: -600 }, { x: -600, z: 0 }, { x: -560, z: 600 }, { x: -520, z: 1400 }] },
      { id: 'hoarwell', name: 'The Hoarwell', width: 12, points: [{ x: 1100, z: -1300 }, { x: 1050, z: -300 }, { x: 1000, z: 300 }] },
    ],
    bays: [{ id: 'forochel_icebay', name: 'The Ice-bay of Forochel', center: { x: 450, z: -1980 }, radius: 130 }],
    landmasses: [{ id: 'forochel', center: { x: 600, z: -1850 }, radius: 300 }],
    islands: [
      { id: 'tolfuin', zone: 'tolfuin', center: { x: -1800, z: -1500 }, radius: 187 },
      { id: 'himling', zone: 'himling', center: { x: -1750, z: -400 }, radius: 204 },
      { id: 'tolmorwen', zone: 'tolmorwen', center: { x: -1850, z: 700 }, radius: 153 },
      { id: 'tinnudir', zone: 'evendim', center: { x: -200, z: -1050 }, radius: 90 },
    ],
  };
  function d2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return Math.sqrt(dx * dx + dz * dz); }
  function distToSeg(px, pz, ax, az, bx, bz) {
    const vx = bx - ax, vz = bz - az; const L2 = vx * vx + vz * vz;
    let t = L2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / L2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
    return d2(px, pz, ax + vx * t, az + vz * t);
  }
  function distToPolyline(px, pz, pts) {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) { const d = distToSeg(px, pz, pts[i].x, pts[i].z, pts[i + 1].x, pts[i + 1].z); if (d < best) best = d; }
    return best;
  }
  function landInfo(x, z) {
    for (const isl of WATER.islands) if (d2(x, z, isl.center.x, isl.center.z) < isl.radius) return { water: false, kind: 'land', island: isl.id };
    for (const rv of WATER.rivers) if (distToPolyline(x, z, rv.points) < rv.width * 0.5) return { water: true, kind: 'river', id: rv.id };
    for (const lk of WATER.lakes) if (d2(x, z, lk.center.x, lk.center.z) < lk.radius) return { water: true, kind: 'lake', id: lk.id };
    for (const by of WATER.bays) if (d2(x, z, by.center.x, by.center.z) < by.radius) return { water: true, kind: 'bay', id: by.id };
    for (const lm of WATER.landmasses) if (d2(x, z, lm.center.x, lm.center.z) < lm.radius) return { water: false, kind: 'land', landmass: lm.id };
    if (x < WATER.seaWestX || z < WATER.seaNorthZ) return { water: true, kind: 'sea' };
    return { water: false, kind: 'land' };
  }
  function isWater(x, z) { return landInfo(x, z).water; }
  /** yaw (radians) such that forward = (fx, fz) in the xz plane. */
  function yawTo(fx, fz) { return Math.atan2(-fx, -fz); }

  // ---------------------------------------------------------------- zones (§9) -----------------------------------------------
  W.zones = [];
  function Z(o) { W.zones.push(o); return o; }
  Z({ id: 'shire', name: 'The Shire', level: [1, 10], center: { x: -1000, z: -100 }, radius: 420, biome: 'shire',
    baseHeight: 9, roughness: 0.22, mountain: 0, treeDensity: 0.38, treeTypes: ['oak', 'birch', 'willow'],
    grassColor: 0x6fae4a, groundColor: 0x8b7a4c, fogColor: 0xd2e6f4, music: 'shire',
    weatherWeights: { clear: 55, cloudy: 25, rain: 17, snow: 0, storm: 3 },
    desc: 'Rolling green hills, hedged lanes and round doors set into the turf: the peaceful homeland of the hobbits. Yet strangers on the roads and wolves in the Bindbole Wood have the Bounders worried.' });
  Z({ id: 'eredluin', name: 'Ered Luin', level: [1, 15], center: { x: -1350, z: -900 }, radius: 380, biome: 'mountain',
    baseHeight: 26, roughness: 0.55, mountain: 0.55, treeDensity: 0.3, treeTypes: ['pine', 'birch', 'oak'],
    grassColor: 0x6a9a58, groundColor: 0x7d7a6a, fogColor: 0xc9d8e6, music: 'dwarven',
    weatherWeights: { clear: 45, cloudy: 30, rain: 15, snow: 6, storm: 4 },
    desc: 'The Blue Mountains rise from the western sea, their northern passes ringing with dwarf-hammers from Thorin\'s Hall while the elves of Falathlorn keep their green havens on the southern shore. Goblins of Rath Teraig stir in the high passes between.' });
  Z({ id: 'breeland', name: 'Bree-land', level: [5, 20], center: { x: -250, z: 0 }, radius: 420, biome: 'breeland',
    baseHeight: 12, roughness: 0.3, mountain: 0, treeDensity: 0.32, treeTypes: ['oak', 'birch', 'pine'],
    grassColor: 0x7aa64a, groundColor: 0x8a7650, fogColor: 0xd5dfe8, music: 'breeland',
    weatherWeights: { clear: 45, cloudy: 30, rain: 20, snow: 0, storm: 5 },
    desc: 'Farmland and homely villages gather around the walled town of Bree at the crossing of the Greenway and the Great East Road. Blackwold brigands and stranger things haunt the lonelier hedgerows.' });
  Z({ id: 'oldforest', name: 'The Old Forest & Barrow-downs', level: [15, 25], center: { x: -450, z: 650 }, radius: 320, biome: 'forest',
    baseHeight: 14, roughness: 0.4, mountain: 0.05, treeDensity: 0.85, treeTypes: ['oak', 'willow', 'dead'],
    grassColor: 0x4f7a3a, groundColor: 0x5e5238, fogColor: 0x9db095, music: 'forest',
    weatherWeights: { clear: 25, cloudy: 45, rain: 22, snow: 0, storm: 8 },
    desc: 'Ancient trees lean close and whisper along the Withywindle, and beyond them the bare green Downs are crowned with standing stones and cold barrows. Only Tom Bombadil walks here unafraid.' });
  Z({ id: 'souththicket', name: 'Chetwood & Midgewater', level: [12, 22], center: { x: 150, z: 400 }, radius: 260, biome: 'forest',
    baseHeight: 8, roughness: 0.28, mountain: 0, treeDensity: 0.7, treeTypes: ['oak', 'willow', 'dead'],
    grassColor: 0x6a944a, groundColor: 0x5f5a3a, fogColor: 0xbfcbb8, music: 'forest',
    weatherWeights: { clear: 30, cloudy: 40, rain: 25, snow: 0, storm: 5 },
    desc: 'The tangled Chetwood gives way to the reed-choked Midgewater Marshes, where the midges bite and the neeker-breekers never stop. The Blackwolds keep their hidden camps here.' });
  Z({ id: 'lonelands', name: 'The Lone-lands', level: [20, 32], center: { x: 500, z: 100 }, radius: 420, biome: 'barren',
    baseHeight: 16, roughness: 0.45, mountain: 0.15, treeDensity: 0.1, treeTypes: ['dead', 'pine'],
    grassColor: 0x9a9a5c, groundColor: 0x8c7d5a, fogColor: 0xd8d2c0, music: 'barren',
    weatherWeights: { clear: 45, cloudy: 35, rain: 12, snow: 0, storm: 8 },
    desc: 'Windswept heath and broken hills stretch east of Bree along the Great Road, watched over by the ruined tower of Weathertop. The Eglain scrape a living among the ruins while wargs and orcs of Angmar press in.' });
  Z({ id: 'northdowns', name: 'The North Downs', level: [28, 40], center: { x: 250, z: -650 }, radius: 380, biome: 'downs',
    baseHeight: 20, roughness: 0.42, mountain: 0.2, treeDensity: 0.28, treeTypes: ['oak', 'pine', 'birch'],
    grassColor: 0x7c9c50, groundColor: 0x847c60, fogColor: 0xcfd6dc, music: 'downs',
    weatherWeights: { clear: 40, cloudy: 35, rain: 18, snow: 0, storm: 7 },
    desc: 'Grassy downs and old fields roll north from Trestlebridge to the haunted ruins of Fornost, once the seat of the kings of Arnor. The Rangers hold the hidden refuge of Esteldín against the war-bands of Angmar.' });
  Z({ id: 'evendim', name: 'Evendim', level: [35, 45], center: { x: -250, z: -1000 }, radius: 380, biome: 'lake',
    baseHeight: 14, roughness: 0.35, mountain: 0.25, treeDensity: 0.3, treeTypes: ['birch', 'oak', 'pine'],
    grassColor: 0x6fa05a, groundColor: 0x7d7a62, fogColor: 0xd6e4ee, music: 'lake',
    weatherWeights: { clear: 50, cloudy: 30, rain: 15, snow: 0, storm: 5 },
    desc: 'The great lake Nenuial lies silver under the hills of Emyn Uial, and on its western shore the drowned ruins of Annúminas remember the glory of Elendil. Tomb-robbers and worse now pick over the old city.' });
  Z({ id: 'trollshaws', name: 'The Trollshaws', level: [40, 50], center: { x: 1150, z: 0 }, radius: 380, biome: 'forest',
    baseHeight: 22, roughness: 0.5, mountain: 0.3, treeDensity: 0.65, treeTypes: ['pine', 'oak', 'dead'],
    grassColor: 0x5f8a45, groundColor: 0x6e6448, fogColor: 0xc4cfc4, music: 'forest',
    weatherWeights: { clear: 40, cloudy: 35, rain: 18, snow: 2, storm: 5 },
    desc: 'Steep wooded valleys east of the Hoarwell where trolls come down from their holes at night. Hidden in a deep cleft at the feet of the mountains lies Rivendell, the Last Homely House of Elrond.' });
  Z({ id: 'misty', name: 'The Misty Mountains', level: [48, 58], center: { x: 1650, z: -450 }, radius: 340, biome: 'mountain',
    baseHeight: 60, roughness: 0.8, mountain: 1.0, treeDensity: 0.15, treeTypes: ['snowpine', 'pine'],
    grassColor: 0x8f9a8a, groundColor: 0x8a8d90, fogColor: 0xe4ecf4, music: 'mountain',
    weatherWeights: { clear: 30, cloudy: 30, rain: 5, snow: 28, storm: 7 },
    desc: 'Snow and stone above the tree-line, where giants hurl boulders across the gorges and drakes nest in the crags. Beneath it all yawns the Front Porch of Goblin-town.' });
  Z({ id: 'angmar', name: 'Angmar', level: [55, 65], center: { x: 1000, z: -1250 }, radius: 400, biome: 'dark',
    baseHeight: 24, roughness: 0.55, mountain: 0.45, treeDensity: 0.12, treeTypes: ['dead'],
    grassColor: 0x6e6a58, groundColor: 0x4e4642, fogColor: 0x7a6c70, music: 'dark',
    weatherWeights: { clear: 15, cloudy: 45, rain: 20, snow: 5, storm: 15 },
    desc: 'A blasted land of ash and black stone under a bruised sky, ruled once by the Witch-king from the citadel of Carn Dûm. The hillmen of Aughaire alone still defy the shadow at the Rammas Deluon.' });
  Z({ id: 'forochel', name: 'Forochel', level: [60, 70], center: { x: 600, z: -1850 }, radius: 340, biome: 'arctic',
    baseHeight: 18, roughness: 0.45, mountain: 0.35, treeDensity: 0.18, treeTypes: ['snowpine'],
    grassColor: 0xdde6ea, groundColor: 0xc8d2d8, fogColor: 0xe8eef4, music: 'arctic',
    weatherWeights: { clear: 30, cloudy: 25, rain: 0, snow: 40, storm: 5 },
    desc: 'The frozen northern coast where the Lossoth hunt seal on the ice-bay and the aurora burns green over the snow. Ice-bears, snow-giants and cold-drakes make the white wastes deadly to the unwary.' });
  Z({ id: 'tolfuin', name: 'Tol Fuin', level: [65, 72], center: { x: -1800, z: -1500 }, radius: 220, biome: 'island', island: true, landRadius: 187,
    baseHeight: 16, roughness: 0.4, mountain: 0.3, treeDensity: 0.45, treeTypes: ['mallorn', 'birch', 'pine'],
    grassColor: 0x74a860, groundColor: 0x8a8060, fogColor: 0xd8e6ec, music: 'island',
    weatherWeights: { clear: 45, cloudy: 30, rain: 15, snow: 0, storm: 10 },
    desc: 'A drowned remnant of Beleriand rising from the western sea, crowned by the elven haven of Ost Fuin and littered with ruins older than the Sun. A great serpent hunts the surf along its northern shore.' });
  Z({ id: 'himling', name: 'The Isle of Himling', level: [72, 80], center: { x: -1750, z: -400 }, radius: 240, biome: 'island', island: true, landRadius: 204,
    baseHeight: 22, roughness: 0.55, mountain: 0.5, treeDensity: 0.2, treeTypes: ['dead', 'pine'],
    grassColor: 0x6e7a5a, groundColor: 0x5e5a50, fogColor: 0x9aa0aa, music: 'dark',
    weatherWeights: { clear: 20, cloudy: 40, rain: 20, snow: 0, storm: 20 },
    desc: 'The hill of Himring, once the fortress of Maedhros, stands alone above the grey sea with its walls cast down. Here Draugmar the Gaunt-lord gathers the dead of ages to his banner.' });
  Z({ id: 'tolmorwen', name: 'Tol Morwen', level: [60, 68], center: { x: -1850, z: 700 }, radius: 180, biome: 'island', island: true, landRadius: 153,
    baseHeight: 12, roughness: 0.3, mountain: 0.1, treeDensity: 0.35, treeTypes: ['birch', 'oak'],
    grassColor: 0x7aae62, groundColor: 0x8c8262, fogColor: 0xd4e2ea, music: 'island',
    weatherWeights: { clear: 50, cloudy: 30, rain: 15, snow: 0, storm: 5 },
    desc: 'A small green isle in the sea west of the Shire, where the Stone of the Hapless still marks the grave of Túrin and Morwen. A hardy fishing village clings to its eastern harbour.' });

  // ---------------------------------------------------------------- towns ----------------------------------------------------
  // Layout helpers: offsets are RELATIVE to the town centre; yaw in degrees, null = face the town centre.
  W.towns = [];
  let T = null;
  function town(o) {
    o.buildings = []; o.props = [];
    o.rallyPoint = o.rallyPoint || { x: o.pos.x, z: o.pos.z };
    W.towns.push(o); T = o; return o;
  }
  function at(id) { T = W.towns.find((t) => t.id === id); return T; }
  function B(recipe, dx, dz, yawDeg, extra) {
    const b = { recipe, x: T.pos.x + dx, z: T.pos.z + dz, yaw: yawDeg == null ? Math.atan2(dx, dz) : yawDeg * R };
    if (extra) Object.assign(b, extra);
    T.buildings.push(b); return T.buildings.length - 1;
  }
  function P(kind, dx, dz, yawDeg, extra) {
    const p = { kind, x: T.pos.x + dx, z: T.pos.z + dz, yaw: yawDeg == null ? Math.atan2(dx, dz) : yawDeg * R };
    if (extra) Object.assign(p, extra);
    T.props.push(p); return p;
  }
  /** straight run of wall_segment pieces from a to b (relative coords), outward-facing yaw in degrees. */
  function wallRun(ax, az, bx, bz, yawDeg, maxLen) {
    const L = d2(ax, az, bx, bz); const n = Math.max(1, Math.ceil(L / (maxLen || 40))); const seg = L / n;
    for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; B('wall_segment', ax + (bx - ax) * t, az + (bz - az) * t, yawDeg, { len: round1(seg) }); }
  }
  function rel(dx, dz) { return { x: T.pos.x + dx, z: T.pos.z + dz }; }

  // ---- The Shire -----------------------------------------------------------------------------------------------------------
  town({ id: 'hobbiton', name: 'Hobbiton', zone: 'shire', pos: { x: -1050, z: -140 }, radius: 90, style: 'hobbit', hasStable: true, hasDock: false, hasInn: true,
    rallyPoint: { x: -1068, z: -146 }, desc: 'Hobbit-holes climb the Hill above the Water, with Bag End at the top and the Ivy Bush below.' });
  B('hobbit_hole', -8, -66, 180, { name: 'Bag End' });
  B('hobbit_hole', -46, -46, null, { name: 'Bagshot Row No. 3' });
  B('hobbit_hole', -62, -26, null, { name: 'Bagshot Row No. 2' });
  B('hobbit_hole', -76, -12, null, { name: 'Bagshot Row No. 1' });
  B('inn', -34, 20, 0, { name: 'The Ivy Bush' });
  B('shop', -60, 18, 0, { name: 'Hobbiton Provisions' });
  B('shop', 2, 34, 0, { name: 'Grubb & Burrowes, Smiths' });
  B('hobbit_hole', -34, 54, null);
  B('hobbit_hole', -64, 46, null);
  B('stable', -42, -22, 180, { name: 'Hobbiton Stables' });
  B('hobbit_hole', 30, -66, null);
  B('man_house', 12, 56, 0, { name: "Sandyman's Mill" });
  B('hobbit_hole', -84, 24, null);
  B('hobbit_hole', 56, -60, null);
  P('well', -12, 12, 0); P('lamp', -30, -6, 0); P('lamp', 20, -4, 0); P('lamp', -9, -42, 0);
  P('sign', -52, -6, 0, { text: 'Hobbiton — Bywater E · Michel Delving W · Thorin\'s Hall N' });
  P('market_stall', -20, 10, 0); P('market_stall', -2, 14, 0); P('fence', -20, -58, 180, { len: 12 }); P('fence', 26, 50, 90, { len: 10 });
  P('crate', -52, 26, 0); P('hay', -30, -34, 0); P('cart', -66, 4, 20);

  town({ id: 'micheldelving', name: 'Michel Delving', zone: 'shire', pos: { x: -1250, z: -60 }, radius: 80, style: 'hobbit', hasStable: true, hasDock: false, hasInn: true,
    rallyPoint: { x: -1246, z: -50 }, desc: 'Chief township of the Shire on the White Downs: the Mayor\'s Town Hole, the Mathom-house and the Bird and Baby inn.' });
  B('hobbit_hole', -30, -30, null, { name: 'The Town Hole' });
  B('inn', -28, 24, null, { name: 'The Bird and Baby' });
  B('man_house', 26, 26, null, { name: 'The Mathom-house' });
  B('shop', 0, -32, null, { name: 'Delving Goods' });
  B('shop', 12, -52, null, { name: 'Bracegirdle Armoury' });
  B('hobbit_hole', 0, 36, null);
  B('hobbit_hole', -36, -4, null);
  B('hobbit_hole', -56, -32, null);
  B('hobbit_hole', -62, 10, null);
  B('hobbit_hole', -44, 48, null);
  B('stable', 10, 58, null, { name: 'Delving Stables' });
  B('hobbit_hole', 52, 10, null);
  B('hobbit_hole', 44, -56, null);
  P('well', -8, 6, 0); P('lamp', 10, -16, 0); P('lamp', -14, -10, 0); P('sign', 34, -14, 0, { text: 'Michel Delving — Hobbiton & Bywater E' });
  P('market_stall', 8, 16, 0); P('market_stall', -4, 20, 0); P('crate', 36, 16, 0); P('fence', -30, -16, 0, { len: 12 }); P('hay', 20, 52, 0); P('banner', -20, -22, 0);

  town({ id: 'bywater', name: 'Bywater', zone: 'shire', pos: { x: -950, z: -80 }, radius: 60, style: 'hobbit', hasStable: false, hasDock: false, hasInn: true,
    rallyPoint: { x: -944, z: -70 }, desc: 'A village on the Bywater Pool, famous for the Green Dragon and the best fishing in the Westfarthing.' });
  B('inn', -14, 10, -90, { name: 'The Green Dragon' });
  B('shop', 18, -26, null, { name: 'Bywater Stores' });
  B('hobbit_hole', -30, 30, null);
  B('hobbit_hole', 6, 34, null);
  B('hobbit_hole', 36, 22, null);
  B('hobbit_hole', 44, -34, null);
  B('hobbit_hole', 20, -56, null, { name: "Cotton's Farm" });
  B('shop', -50, 12, null, { name: "The Fisher's Hut" });
  P('well', 12, 10, 0); P('lamp', -8, -16, 0); P('lamp', 30, -18, 0); P('sign', 8, -6, 0, { text: 'Bywater — Hobbiton W · Bree E' });
  P('market_stall', -4, 20, 0); P('fence', -40, -6, 45, { len: 10 }); P('crate', 26, -18, 0); P('hay', 30, -50, 0);

  // ---- Ered Luin -----------------------------------------------------------------------------------------------------------
  town({ id: 'thorinshall', name: "Thorin's Hall", zone: 'eredluin', pos: { x: -1300, z: -1100 }, radius: 90, style: 'dwarf', hasStable: true, hasDock: false, hasInn: true,
    rallyPoint: { x: -1290, z: -1090 }, music: 'dwarven', desc: 'The great hall of the Longbeards delved into the Blue Mountains, ringing with forges and dwarf-song.' });
  B('dwarf_hall', 0, -44, 180, { name: "Thorin's Hall" });
  B('dwarf_house', -40, -20, null);
  B('dwarf_house', 40, -20, null);
  B('inn', -44, 20, null, { name: 'The Anvil and Ale' });
  B('shop', 44, 20, null, { name: 'The Forge-hall' });
  B('shop', -62, -2, null, { name: 'Longbeard Provisioner' });
  B('shop', 62, -2, null, { name: 'Armoury of the Longbeards' });
  B('stable', 60, 44, null, { name: 'Pony-stables' });
  B('dwarf_house', -66, 44, null);
  B('dwarf_house', -24, -64, null);
  B('dwarf_house', 24, -64, null);
  B('tower', 0, -84, 180, { name: 'Watch-tower of Thráin' });
  B('shrine', -24, -36, null, { name: 'Shrine of Durin' });
  B('dwarf_house', 0, 56, null);
  P('well', 14, 4, 0); P('lamp', -14, -8, 0); P('lamp', 16, -26, 0); P('sign', -2, 26, 0, { text: "Thorin's Hall — Hobbiton SE · Duillond SW" });
  P('crate', 50, 10, 0); P('anvil', 38, 30, 0); P('banner', -10, -30, 0); P('banner', 10, -30, 0); P('campfire', -50, -30, 0); P('hay', 48, 52, 0);

  town({ id: 'celondim', name: 'Celondim', zone: 'eredluin', pos: { x: -1420, z: -700 }, radius: 70, style: 'elf', hasStable: true, hasDock: true, hasInn: true,
    rallyPoint: { x: -1410, z: -690 }, music: 'elven', desc: 'A white elven haven on the western shore where the grey ships put out to sea.' });
  B('elf_hall', 0, -40, 180, { name: 'Hall of the Haven' });
  B('inn', -40, -8, null, { name: "The Haven's Rest" });
  B('elf_house', 40, -6, null);
  B('elf_house', -30, 32, null);
  B('elf_house', 26, 34, null);
  B('shop', -56, -30, null, { name: 'Elven Outfitters' });
  B('shop', -8, 44, null, { name: "The Fletcher's Bower" });
  B('stable', 50, 30, null, { name: 'Stables of Celondim' });
  B('shrine', -20, -52, null, { name: 'Shrine of Elbereth' });
  B('elf_house', 60, -14, null);
  P('statue', 0, -8, 0); P('lamp', -16, 4, 0); P('lamp', 16, 6, 0); P('market_stall', -14, 18, 0); P('market_stall', 12, 18, 0);
  P('sign', 10, -22, 0, { text: 'Celondim — Duillond NE · the Quay W' }); P('crate', -50, 8, 0); P('banner', -10, -30, 0); P('banner', 10, -30, 0); P('lamp', -60, 2, 0);

  town({ id: 'duillond', name: 'Duillond', zone: 'eredluin', pos: { x: -1320, z: -760 }, radius: 60, style: 'elf', hasStable: false, hasDock: true, hasInn: false,
    rallyPoint: { x: -1310, z: -752 }, music: 'elven', desc: 'A quiet elven refuge of terraced halls among the birches of Falathlorn.' });
  B('elf_hall', 24, -30, null, { name: 'Hall of Duillond' });
  B('elf_house', -8, 36, null);
  B('elf_house', 34, 14, null);
  B('elf_house', -40, 30, null);
  B('shop', 36, -4, null, { name: 'Duillond Craft-hall' });
  B('shrine', -46, -20, null, { name: 'Shrine of the Stars' });
  B('elf_house', 12, -56, null);
  B('shop', 6, 18, null, { name: 'The Greenward Larder' });
  P('statue', 14, 2, 0); P('lamp', -10, 14, 0); P('lamp', -6, -24, 0); P('market_stall', 16, -14, 0); P('crate', 28, 26, 0);
  P('sign', -16, -10, 0, { text: "Duillond — Thorin's Hall N · Celondim SW · the Quay W" }); P('banner', 20, -18, 0);

  // ---- Bree-land -----------------------------------------------------------------------------------------------------------
  town({ id: 'bree', name: 'Bree', zone: 'breeland', pos: { x: -250, z: -20 }, radius: 160, style: 'man', hasStable: true, hasDock: false, hasInn: true,
    rallyPoint: { x: -256, z: -30 }, walls: true, wallRadius: 122, gates: [{ x: -360, z: -20 }, { x: -250, z: 90 }, { x: -140, z: -20 }], desc: 'The chief town of Bree-land, walled and gated, where the Greenway meets the Great East Road at the door of the Prancing Pony.' });
  B('inn', -60, -24, 180, { name: 'The Prancing Pony' });                       // 0
  B('shop', -24, 22, 0, { name: 'Bree Armoury' });                              // 1
  B('shop', 24, 22, 0, { name: 'The Bree Smithy' });                            // 2
  B('shop', -26, -26, 180, { name: 'Bree Provisions' });                        // 3
  B('shop', 26, -26, 180, { name: "Tobin's Fletchery" });                       // 4
  B('man_house_2', 60, -32, 180, { name: 'Bree Town Hall' });                   // 5
  B('man_house', 56, 26, 0);                                                    // 6
  B('man_house_2', -60, 26, 0);                                                 // 7
  B('stable', -86, 24, 0, { name: 'Bree Stables' });                            // 8
  B('man_house', -84, -30, 180);                                                // 9
  B('man_house_2', 88, -26, 180);                                               // 10
  B('man_house', 84, 28, 0);                                                    // 11
  B('man_house', -30, 64, -90);                                                 // 12
  B('man_house_2', 30, 62, 90);                                                 // 13
  B('man_house', -70, 70, null);                                                // 14
  B('man_house', 70, 66, null);                                                 // 15
  B('man_house', 0, -64, 180);                                                  // 16
  B('man_house_2', 40, -68, 180);                                               // 17
  B('man_house', -84, -74, null);                                               // 18
  B('man_house', 86, -72, null);                                                // 19
  B('man_house', -30, 96, -90);                                                 // 20
  B('man_house', 32, 94, 90);                                                   // 21
  P('well', 0, -16, 0); P('market_stall', -12, 10, 0); P('market_stall', 12, 10, 0); P('market_stall', -14, -8, 0);
  P('lamp', -30, -8, 0); P('lamp', 30, -8, 0); P('lamp', -8, 30, 0); P('lamp', 8, 60, 0); P('lamp', -100, -8, 0); P('lamp', 96, 8, 0); P('lamp', -8, 96, 0);
  P('sign', -96, 8, 0, { text: 'West-gate — Bywater & the Shire' }); P('sign', 8, 100, 0, { text: 'South-gate — Staddle · the Old Forest' });
  P('sign', 98, -8, 0, { text: 'East-gate — Combe · Archet · the Forsaken Inn' });
  P('crate', -44, -12, 0); P('hay', -86, 40, 0); P('fence', -70, 52, 0, { len: 12 }); P('fence', 70, 48, 0, { len: 12 }); P('cart', 66, -8, 0);
  P('banner', -104, -14, 0); P('banner', -104, 14, 0); P('barrel', -50, -14, 0);

  town({ id: 'combe', name: 'Combe', zone: 'breeland', pos: { x: -120, z: -140 }, radius: 60, style: 'man', hasStable: false, hasDock: false, hasInn: true,
    rallyPoint: { x: -114, z: -134 }, desc: 'A farming village in a wooded dell north-east of Bree, known for the Comb and Wattle Inn.' });
  B('inn', -30, -10, -90, { name: 'The Comb and Wattle' });
  B('shop', 28, 8, 90, { name: 'Combe Provisions' });
  B('man_house', -30, 30, -90);
  B('man_house_2', 32, -28, 90);
  B('man_house', -34, -42, null);
  B('man_house_2', 30, 40, null);
  B('shop', -24, -52, null, { name: 'Combe Smithy' });
  B('man_house', 30, -50, null);
  P('well', 12, 14, 0); P('lamp', 12, -18, 0); P('lamp', -8, 24, 0); P('sign', 6, 4, 0, { text: 'Combe — Bree S · Archet N' });
  P('fence', -40, 8, 90, { len: 12 }); P('crate', 22, -6, 0); P('hay', -20, 40, 0); P('barrel', -22, -20, 0);

  town({ id: 'archet', name: 'Archet', zone: 'breeland', pos: { x: -60, z: -260 }, radius: 75, style: 'man', hasStable: true, hasDock: false, hasInn: true,
    rallyPoint: { x: -60, z: -246 }, walls: true, wallStyle: 'palisade', wallRadius: 72, desc: 'A palisaded hunters\' village at the edge of the Chetwood, rebuilt after the Blackwold raids.' });
  B('inn', 28, -24, null, { name: 'The Badger and Bow' });
  B('man_house_2', -30, -30, null, { name: 'Archet Hall' });
  B('shop', 34, 10, null, { name: 'Archet Provisions' });
  B('shop', -36, 14, null, { name: 'The Hunting Lodge' });
  B('stable', 22, 44, null, { name: 'Archet Stables' });
  B('man_house', -6, -50, null);
  B('man_house_2', 36, -48, null);
  B('man_house', -52, -10, null);
  B('man_house', -14, 52, null);
  B('tower', 4, -62, null, { name: 'Archet Watch' });
  P('well', -8, -10, 0); P('lamp', 12, -6, 0); P('lamp', -12, 28, 0); P('sign', -6, 22, 0, { text: 'Archet — Combe & Bree S' });
  P('market_stall', 14, 12, 0); P('market_stall', 20, -4, 0); P('crate', 28, 22, 0); P('fence', -46, 26, 0, { len: 10 }); P('hay', 34, 36, 0); P('campfire', -26, 34, 0);

  town({ id: 'staddle', name: 'Staddle', zone: 'breeland', pos: { x: -200, z: 150 }, radius: 65, style: 'man', hasStable: false, hasDock: false, hasInn: false,
    rallyPoint: { x: -194, z: 158 }, desc: 'A village of hobbits and Men on the southern slopes of Bree-hill, famous for its pigs and pipe-weed.' });
  B('hobbit_hole', 30, -30, null);
  B('hobbit_hole', -10, -38, null);
  B('man_house', -40, 16, null);
  B('man_house_2', 10, 36, null, { name: 'Staddle Hall' });
  B('shop', 34, 8, null, { name: 'Staddle Goods' });
  B('hobbit_hole', -30, 44, null);
  B('hobbit_hole', 52, -12, null);
  B('man_house', -58, -8, null);
  B('hobbit_hole', 40, 50, null);
  P('well', 0, 14, 0); P('lamp', -8, -12, 0); P('lamp', 14, 18, 0); P('sign', -6, 6, 0, { text: 'Staddle — Bree NW · the Midgewater path E' });
  P('fence', 18, -22, 0, { len: 10 }); P('hay', -24, 26, 0); P('crate', 28, 18, 0); P('cart', -46, 30, 0);

  // ---- Chetwood & Midgewater (25th town: the spec's town list names 24) ---------------------------------------------
  town({ id: 'chetwoodcamp', name: "Chetwood Hunters' Camp", zone: 'souththicket', pos: { x: 20, z: 340 }, radius: 55, style: 'camp', hasStable: false, hasDock: false, hasInn: false,
    rallyPoint: { x: 26, z: 348 }, walls: true, wallStyle: 'palisade', wallRadius: 50, gates: [{ x: 40, z: 292 }], desc: 'A palisaded camp of Bree-land hunters and a lone Ranger on the Midgewater path, the only friendly fire between Staddle and the Forsaken Inn.' });
  B('man_house_2', 0, 20, 0, { name: "Hunters' Lodge" });
  B('tent', -24, -4, null);
  B('tent', 26, -6, null);
  B('tent', -30, 30, null);
  B('tent', 30, 34, null);
  B('ruin_wall', 0, -24, 0, { len: 16 });
  B('tower', -8, -40, null, { name: 'Chetwood Watch' });
  P('campfire', 0, -4, 0); P('crate', 14, 14, 0); P('barrel', -14, 14, 0); P('fence', -40, 10, 90, { len: 12 }); P('banner', -6, 6, 0);
  P('sign', 10, -16, 0, { text: "Chetwood Hunters' Camp — Staddle W · the Forsaken Inn E" }); P('hay', 38, 26, 0);

  // ---- Old Forest ----------------------------------------------------------------------------------------------------------
  town({ id: 'tomshouse', name: "Tom Bombadil's House", zone: 'oldforest', pos: { x: -520, z: 560 }, radius: 40, style: 'man', hasStable: false, hasDock: false, hasInn: false,
    rallyPoint: { x: -514, z: 572 }, desc: 'A homestead of stone and thatch under the eaves of the Old Forest, where Tom and Goldberry keep the only safe hearth for miles.' });
  B('man_house_2', -14, -14, null, { name: 'The House of Tom Bombadil' });
  B('man_house', 16, 14, null, { name: "Fatty Lumpkin's Stable" });
  B('shrine', -20, 20, null, { name: "Goldberry's Pool" });
  P('well', 6, -6, 0); P('fence', -4, 26, 180, { len: 14 }); P('fence', -28, 2, 90, { len: 14 }); P('lamp', -2, 10, 0); P('campfire', 12, -18, 0); P('hay', 24, 22, 0);

  // ---- Lone-lands ----------------------------------------------------------------------------------------------------------
  town({ id: 'forsakeninn', name: 'The Forsaken Inn', zone: 'lonelands', pos: { x: 300, z: 120 }, radius: 50, style: 'man', hasStable: true, hasDock: false, hasInn: true,
    rallyPoint: { x: 304, z: 130 }, desc: 'The last inn on the Great East Road before the wild, a ramshackle refuge for travellers and the Eglain.' });
  B('inn', 0, -22, 180, { name: 'The Forsaken Inn' });
  B('stable', -34, 20, null, { name: 'Forsaken Stables' });
  B('man_house', 34, 22, null);
  B('shop', -36, -18, null, { name: 'Forsaken Sundries' });
  B('man_house_2', 36, -24, null);
  B('tower', -6, -48, null, { name: 'The Old Watch' });
  B('man_house', 12, 44, null);
  P('well', -14, 12, 0); P('campfire', 44, 4, 0); P('lamp', -20, -8, 0); P('lamp', 20, -8, 0); P('sign', 10, 8, 0, { text: 'The Forsaken Inn — Bree W · Ost Guruth E' });
  P('crate', -24, -26, 0); P('hay', -40, 32, 0); P('fence', 26, 34, 180, { len: 10 }); P('barrel', 8, -12, 0);

  town({ id: 'ostguruth', name: 'Ost Guruth', zone: 'lonelands', pos: { x: 720, z: 60 }, radius: 65, style: 'ruin', hasStable: true, hasDock: false, hasInn: false,
    rallyPoint: { x: 716, z: 48 }, desc: 'An old Arnorian fort on a hill above the tarn, patched with timber by the Eglain who shelter within its broken walls.' });
  B('ruin_tower', -40, -40, null);
  B('ruin_tower', 44, -44, null);
  B('ruin_wall', 0, -58, 0, { len: 24 });
  B('ruin_wall', -50, -16, 90, { len: 20 });
  B('ruin_wall', 54, -20, -90, { len: 20 });
  B('tent', -16, -24, null);
  B('tent', 14, -26, null);
  B('tent', -30, -12, null);
  B('tent', 30, -14, null);
  B('stable', 24, 14, null, { name: 'Eglain Pony-lines' });
  B('ruin_wall', 24, 32, 180, { len: 16 });
  B('man_house_2', 0, -38, 180, { name: 'Hall of the Eglain' });
  P('campfire', 0, -10, 0); P('crate', -34, -26, 0); P('banner', -8, -52, 0); P('banner', 8, -52, 0); P('hay', 36, 22, 0);
  P('sign', -46, 6, 0, { text: 'Ost Guruth — the Forsaken Inn W · the Last Bridge E' }); P('well', 16, 4, 0); P('barrel', -22, -30, 0);

  // ---- North Downs ---------------------------------------------------------------------------------------------------------
  town({ id: 'trestlebridge', name: 'Trestlebridge', zone: 'northdowns', pos: { x: 120, z: -450 }, radius: 60, style: 'man', hasStable: true, hasDock: false, hasInn: true,
    rallyPoint: { x: 132, z: -438 }, desc: 'A stout little town guarding the great trestle-bridge over the gorge on the road north to the Downs.' });
  B('inn', 36, 10, null, { name: 'The Trestlebridge Inn' });
  B('stable', 44, -14, null, { name: 'Bridge Stables' });
  B('shop', -40, -12, null, { name: 'Trestlebridge Provisions' });
  B('man_house', -44, 16, null);
  B('man_house_2', 10, 40, null);
  B('man_house', 48, 36, null);
  B('shop', -10, -46, null, { name: 'The Bridge Smithy' });
  B('tower', 18, -54, null, { name: 'Bridge-watch' });
  B('bridge', 30, -30, -45, { name: 'The Trestlespan', len: 30 });
  B('man_house', -8, 50, null);
  P('well', 12, 12, 0); P('lamp', -10, -16, 0); P('lamp', 22, 26, 0); P('sign', 0, 20, 0, { text: 'Trestlebridge — Bree SW · Esteldín NE · Tinnudir NW' });
  P('crate', 26, -22, 0); P('hay', 54, -2, 0); P('fence', -30, 30, 0, { len: 10 }); P('barrel', 30, 20, 0); P('cart', -30, -30, 0);

  town({ id: 'esteldin', name: 'Esteldín', zone: 'northdowns', pos: { x: 400, z: -720 }, radius: 70, style: 'ruin', hasStable: true, hasDock: false, hasInn: false,
    rallyPoint: { x: 410, z: -712 }, desc: 'The hidden refuge of the Rangers of the North, built into the ruins of an old fortress in a secret valley.' });
  B('man_house_2', -20, -40, null, { name: 'Hall of Esteldín' });
  B('ruin_tower', 40, 30, null);
  B('ruin_tower', -46, -48, null);
  B('ruin_wall', 10, -56, 0, { len: 24 });
  B('ruin_wall', -56, -10, 90, { len: 20 });
  B('tent', 14, -34, null);
  B('tent', -30, -8, null);
  B('tent', -8, 28, null);
  B('tent', 24, 10, null);
  B('stable', 30, 48, null, { name: 'Horse-lines of the Rangers' });
  B('shrine', -30, 40, null, { name: 'Stone of Arvedui' });
  B('tent', 44, -10, null);
  B('ruin_wall', 0, 60, 180, { len: 20 });
  P('campfire', 6, -14, 0); P('banner', -10, -30, 0); P('banner', -30, -30, 0); P('crate', -20, -20, 0); P('hay', 40, 52, 0);
  P('sign', -30, 14, 0, { text: 'Esteldín — Trestlebridge SW · Aughaire NE' }); P('barrel', 34, -6, 0); P('campfire', -46, 20, 0);

  // ---- Evendim -------------------------------------------------------------------------------------------------------------
  town({ id: 'tinnudir', name: 'Tinnudir', zone: 'evendim', pos: { x: -200, z: -1050 }, radius: 80, style: 'ruin', hasStable: true, hasDock: true, hasInn: false,
    rallyPoint: { x: -196, z: -1040 }, isle: true, desc: 'A ruined keep on an island in Lake Evendim, reached by a long causeway; the Rangers keep a camp beneath its walls.' });
  B('ruin_tower', 0, -40, null, { name: 'Keep of Tinnudir' });
  B('ruin_wall', -24, -40, 0, { len: 20 });
  B('ruin_wall', 24, -40, 0, { len: 20 });
  B('ruin_wall', -44, -20, 90, { len: 24 });
  B('ruin_wall', 44, -20, -90, { len: 24 });
  B('tent', -20, -14, null);
  B('tent', 20, -14, null);
  B('tent', -16, 24, null);
  B('stable', 30, 30, null, { name: 'Ranger Horse-lines' });
  B('man_house_2', -40, 10, null, { name: 'Ranger Lodge' });
  B('ruin_tower', 52, -54, null);
  B('shrine', -56, -40, null, { name: 'Shrine of the Kings' });
  B('tent', -46, 44, null);
  P('campfire', 0, 6, 0); P('crate', -30, -30, 0); P('banner', -10, -30, 0); P('banner', 10, -30, 0); P('hay', 40, 40, 0);
  P('sign', 10, 12, 0, { text: 'Tinnudir — the Causeway E · the Quay W' }); P('campfire', 36, -6, 0); P('barrel', -26, 32, 0);

  // ---- Trollshaws ----------------------------------------------------------------------------------------------------------
  town({ id: 'rivendell', name: 'Rivendell', zone: 'trollshaws', pos: { x: 1400, z: 40 }, radius: 110, style: 'elf', hasStable: true, hasDock: false, hasInn: true,
    rallyPoint: { x: 1392, z: 52 }, music: 'elven', desc: 'Imladris, the Last Homely House east of the Sea, hidden in a deep valley of waterfalls at the feet of the Misty Mountains.' });
  B('elf_hall', 40, -10, 90, { name: 'The Last Homely House' });
  B('elf_hall', 10, -60, null, { name: 'The Hall of Fire' });
  B('inn', -30, 40, null, { name: 'The Guest-house of Imladris' });
  B('elf_house', 30, 50, null);
  B('elf_house', -50, -40, null);
  B('elf_house', 66, 36, null);
  B('shop', -70, 10, null, { name: 'Armoury of Imladris' });
  B('shop', -52, -68, null, { name: 'The Elven Smithy' });
  B('stable', -56, 60, null, { name: 'Stables of Rivendell' });
  B('shrine', 58, -50, null, { name: 'The Shards of Narsil' });
  B('elf_house', -10, 80, null);
  B('elf_house', 80, -40, null);
  B('elf_house', 44, 86, null);
  B('elf_house', -90, -40, null, { name: 'The Library of Elrond' });
  B('elf_hall', -10, -96, null, { name: 'Hall of Council' });
  P('statue', 8, 4, 0); P('lamp', -20, -20, 0); P('lamp', 20, 20, 0); P('lamp', -40, 20, 0); P('lamp', 30, -30, 0); P('lamp', -20, 50, 0);
  P('banner', 26, -20, 0); P('banner', 26, 0, 0); P('market_stall', -14, 20, 0); P('market_stall', 14, 26, 0);
  P('sign', -30, 6, 0, { text: 'Rivendell — the Last Bridge W · the High Crag N' }); P('crate', -64, 4, 0); P('hay', -44, 66, 0); P('lamp', 60, 10, 0);

  town({ id: 'thorenhad', name: 'Thorenhad', zone: 'trollshaws', pos: { x: 1050, z: -60 }, radius: 45, style: 'camp', hasStable: true, hasDock: false, hasInn: false,
    rallyPoint: { x: 1058, z: -50 }, desc: 'A Ranger camp on the east bank of the Hoarwell beside the Last Bridge, the only safe fire in the Trollshaws.' });
  B('tent', 10, -30, null);
  B('tent', -2, 26, null);
  B('tent', 26, 20, null);
  B('tent', -4, -16, null);
  B('stable', 16, 40, null, { name: 'Ranger Horse-lines' });
  B('tower', 28, -34, null, { name: 'Watch of Thorenhad' });
  B('tent', -2, -38, null);
  B('ruin_wall', -2, 42, 180, { len: 14 });
  P('campfire', 8, 6, 0); P('crate', 18, -20, 0); P('banner', 4, -6, 0); P('hay', 26, 34, 0);
  P('sign', 12, -2, 0, { text: 'Thorenhad — the Last Bridge W · Rivendell E · the High Crag NE' }); P('barrel', 16, 14, 0);

  // ---- Misty Mountains -----------------------------------------------------------------------------------------------------
  town({ id: 'highcrag', name: 'The High Crag', zone: 'misty', pos: { x: 1600, z: -400 }, radius: 45, style: 'camp', hasStable: true, hasDock: false, hasInn: false,
    rallyPoint: { x: 1606, z: -410 }, desc: 'A windswept camp of elves and dwarves on a shelf of the mountains, the last shelter below Goblin-town.' });
  B('tent', 20, -20, null);
  B('tent', -20, -24, null);
  B('tent', 34, 4, null);
  B('tent', -8, -40, null);
  B('stable', 26, -32, null, { name: 'Goat-lines' });
  B('tower', -26, -34, null, { name: 'Crag-watch' });
  B('shrine', 6, 34, null, { name: 'Cairn of the Lost Climbers' });
  P('campfire', 0, -8, 0); P('crate', 10, -30, 0); P('hay', 36, -26, 0); P('sign', -2, 14, 0, { text: 'The High Crag — Thorenhad SW · Rivendell S · Goblin-town E' });
  P('banner', 12, -10, 0); P('barrel', -14, -8, 0);

  // ---- Angmar --------------------------------------------------------------------------------------------------------------
  town({ id: 'aughaire', name: 'Aughaire', zone: 'angmar', pos: { x: 900, z: -1150 }, radius: 70, style: 'camp', hasStable: true, hasDock: false, hasInn: false,
    rallyPoint: { x: 910, z: -1146 }, walls: true, wallStyle: 'palisade', wallRadius: 64, desc: 'The palisaded camp of the Trév Gállorg hillmen, the last free folk on the borders of Angmar.' });
  B('man_house_2', 20, -36, null, { name: 'Hall of the Trév Gállorg' });
  B('tent', -30, -30, null);
  B('tent', 30, -4, null);
  B('tent', -20, 34, null);
  B('tent', 16, 34, null);
  B('stable', 44, 30, null, { name: 'Hillmen Horse-pens' });
  B('ruin_tower', -40, -38, null);
  B('tent', 48, -30, null);
  B('shrine', 0, 50, null, { name: 'Standing Stone of the Hillmen' });
  P('campfire', 10, 4, 0); P('banner', 10, -22, 0); P('banner', 30, -22, 0); P('crate', -14, -12, 0);
  P('fence', -52, 0, 90, { len: 16 }); P('fence', 52, 8, -90, { len: 16 }); P('fence', -6, -58, 0, { len: 16 }); P('hay', 54, 40, 0);
  P('sign', -10, 10, 0, { text: 'Aughaire — Esteldín SW · Sûri-kylä N · Carn Dûm NE' }); P('barrel', 22, 20, 0);

  // ---- Forochel ------------------------------------------------------------------------------------------------------------
  town({ id: 'surikyla', name: 'Sûri-kylä', zone: 'forochel', pos: { x: 600, z: -1800 }, radius: 70, style: 'lossoth', hasStable: true, hasDock: true, hasInn: true,
    rallyPoint: { x: 606, z: -1790 }, desc: 'The chief settlement of the Lossoth on the Ice-bay: snow-huts, fish-racks and the long-house where the Lossoth tell their tales.' });
  B('inn', 0, -36, 180, { name: 'The Long-house of Sûri-kylä' });
  B('lossoth_hut', -34, -20, null);
  B('lossoth_hut', 34, -20, null);
  B('lossoth_hut', -52, 8, null);
  B('lossoth_hut', 52, 10, null);
  B('lossoth_hut', -16, 36, null);
  B('lossoth_hut', 8, 50, null);
  B('lossoth_hut', -54, -40, null);
  B('lossoth_hut', 50, -42, null);
  B('stable', -30, -60, null, { name: 'Reindeer-pens' });
  B('shrine', 30, -58, null, { name: 'The Ice-altar' });
  B('shop', -10, -10, 180, { name: 'Trading-hut' });
  P('campfire', 14, -14, 0); P('crate', -40, 4, 0); P('hay', -38, -52, 0); P('banner', -8, -26, 0); P('banner', 8, -26, 0);
  P('sign', -6, 26, 0, { text: 'Sûri-kylä — Aughaire SE · Tinnudir SW · the Ice-bay NW' }); P('campfire', 30, 26, 0); P('barrel', 22, -4, 0);

  // ---- The Sundered Isles --------------------------------------------------------------------------------------------------
  town({ id: 'ostfuin', name: 'Ost Fuin', zone: 'tolfuin', pos: { x: -1800, z: -1500 }, radius: 80, style: 'elf', hasStable: false, hasDock: true, hasInn: true,
    rallyPoint: { x: -1792, z: -1490 }, music: 'elven', desc: 'An elven haven raised on the ruins of drowned Beleriand, its white towers looking east across the sea to the mainland.' });
  B('elf_hall', 0, -40, 180, { name: 'Hall of Ost Fuin' });
  B('inn', -40, 10, null, { name: 'House of the Sea-wanderers' });
  B('elf_house', 40, 12, null);
  B('elf_house', -24, 48, null);
  B('elf_house', 26, 48, null);
  B('shop', -52, -30, null, { name: 'Fuin Provisioner' });
  B('shop', 52, -30, null, { name: 'Armoury of the Haven' });
  B('shrine', 0, 64, null, { name: 'Stone of Beleriand' });
  B('ruin_tower', -64, 40, null);
  B('ruin_wall', 64, 44, -135, { len: 14 });
  B('elf_house', -10, -72, null);
  B('tower', 52, -56, null, { name: 'The Sea-watch' });
  P('statue', 0, -6, 0); P('lamp', -20, -16, 0); P('lamp', 20, -16, 0); P('lamp', -20, 26, 0); P('lamp', 20, 26, 0);
  P('market_stall', -12, 20, 0); P('market_stall', 12, 20, 0); P('sign', 14, 0, 0, { text: 'Ost Fuin — the Quay E · the Serpent Cove N' });
  P('banner', -10, -30, 0); P('banner', 10, -30, 0); P('crate', -44, -14, 0);

  town({ id: 'rashimling', name: 'Ras Himling', zone: 'himling', pos: { x: -1720, z: -450 }, radius: 50, style: 'camp', hasStable: false, hasDock: true, hasInn: false,
    rallyPoint: { x: -1712, z: -442 }, desc: 'A beach-head camp of the Free Peoples on the Isle of Himling, in the shadow of the fallen fortress of Himring.' });
  B('tent', -20, -20, null);
  B('tent', 20, -22, null);
  B('tent', -26, 14, null);
  B('tent', 24, 16, null);
  B('ruin_wall', 0, -40, 0, { len: 20 });
  B('ruin_tower', -36, -32, null);
  B('man_house_2', 0, 36, null, { name: "Captain's Lodge" });
  B('ruin_wall', 40, -14, -90, { len: 16 });
  B('tent', -4, -18, null);
  P('campfire', 0, 4, 0); P('crate', 30, -30, 0); P('banner', -8, -34, 0); P('banner', 8, -34, 0); P('barrel', -30, 30, 0);
  P('sign', 12, -4, 0, { text: 'Ras Himling — the Quay E · Himring N' });

  town({ id: 'morwenvillage', name: 'Morwen Village', zone: 'tolmorwen', pos: { x: -1840, z: 720 }, radius: 60, style: 'man', hasStable: false, hasDock: true, hasInn: true,
    rallyPoint: { x: -1834, z: 730 }, desc: 'A weather-beaten fishing village on the eastern harbour of Tol Morwen, whose folk still lay flowers at the Stone of the Hapless.' });
  B('inn', -24, -24, null, { name: 'The Drowned Bell' });
  B('shop', 28, -16, null, { name: 'Net & Hook' });
  B('man_house', -34, 16, null);
  B('man_house_2', 30, 22, null);
  B('man_house', 0, -44, null);
  B('shop', 0, 40, null, { name: 'Morwen Chandlery' });
  B('man_house', 42, -38, null);
  B('shrine', -42, -36, null, { name: 'Cairn of Húrin' });
  B('man_house', -20, 52, null);
  B('tower', 50, 10, null, { name: 'Harbour-watch' });
  P('well', 6, 6, 0); P('lamp', -14, -10, 0); P('lamp', 14, -8, 0); P('sign', 16, 2, 0, { text: 'Morwen Village — the Harbour E · the Stone of the Hapless W' });
  P('crate', 16, -30, 0); P('barrel', -14, -40, 0); P('fence', -38, 34, 0, { len: 10 }); P('hay', 34, 44, 0); P('market_stall', -10, 24, 0); P('campfire', 36, 0, 0);

  // ---------------------------------------------------------------- roads (§9) + scenic paths ---------------------------------
  W.roads = [];
  function road(from, to, pts, extra) {
    const r = { id: 'road_' + from + '_' + to, from, to, width: 6, points: pts.map((p) => ({ x: p[0], z: p[1] })) };
    if (extra) Object.assign(r, extra);
    W.roads.push(r); return r;
  }
  road('micheldelving', 'hobbiton', [[-1250, -60], [-1215, -82], [-1180, -104], [-1140, -128], [-1100, -140], [-1050, -140]]);
  road('hobbiton', 'bywater', [[-1050, -140], [-1020, -165], [-990, -170], [-955, -145], [-950, -110], [-950, -80]]);
  road('bywater', 'bree', [[-950, -80], [-880, -90], [-800, -95], [-720, -80], [-650, -60], [-604, -50], [-560, -45], [-480, -40], [-400, -30], [-360, -20], [-250, -20]]);
  road('bree', 'combe', [[-250, -20], [-140, -20], [-118, -40], [-118, -90], [-120, -140]]);
  road('combe', 'archet', [[-120, -140], [-108, -180], [-90, -220], [-72, -245], [-60, -260]]);
  road('bree', 'staddle', [[-250, -20], [-250, 90], [-240, 120], [-222, 140], [-200, 150]]);
  road('bree', 'forsakeninn', [[-250, -20], [-140, -20], [-80, 0], [0, 40], [100, 80], [200, 110], [300, 120]]);
  road('forsakeninn', 'ostguruth', [[300, 120], [380, 120], [460, 110], [540, 95], [620, 75], [680, 60], [720, 60]]);
  road('bree', 'trestlebridge', [[-250, -20], [-140, -20], [-96, -56], [-56, -136], [-16, -226], [30, -320], [80, -400], [120, -450]]);
  road('trestlebridge', 'esteldin', [[120, -450], [170, -500], [230, -560], [290, -620], [350, -680], [400, -720]]);
  road('hobbiton', 'thorinshall', [[-1050, -140], [-1080, -220], [-1120, -320], [-1150, -430], [-1170, -550], [-1190, -680], [-1220, -800], [-1250, -920], [-1280, -1020], [-1300, -1100]]);
  road('thorinshall', 'duillond', [[-1300, -1100], [-1330, -1020], [-1360, -940], [-1370, -860], [-1345, -800], [-1320, -760]]);
  road('duillond', 'celondim', [[-1320, -760], [-1360, -745], [-1395, -725], [-1420, -700]]);
  road('trestlebridge', 'tinnudir', [[120, -450], [80, -520], [40, -600], [10, -690], [-10, -780], [20, -870], [10, -960], [-40, -1000], [-120, -1040], [-200, -1050]], { causeway: true });
  road('ostguruth', 'thorenhad', [[720, 60], [790, 50], [860, 30], [930, 0], [985, -25], [1029, -50], [1050, -60]]);
  road('thorenhad', 'rivendell', [[1050, -60], [1110, -50], [1180, -30], [1250, -5], [1320, 20], [1400, 40]]);
  road('thorenhad', 'highcrag', [[1050, -60], [1110, -90], [1200, -140], [1300, -200], [1400, -270], [1500, -340], [1600, -400]]);
  road('esteldin', 'aughaire', [[400, -720], [470, -780], [550, -850], [630, -920], [700, -1000], [760, -1060], [830, -1110], [900, -1150]]);
  road('aughaire', 'surikyla', [[900, -1150], [860, -1250], [820, -1350], [780, -1450], [740, -1550], [700, -1650], [650, -1730], [600, -1800]]);
  road('tinnudir', 'surikyla', [[-200, -1050], [-120, -1040], [-40, -1000], [10, -960], [60, -1060], [110, -1180], [180, -1320], [280, -1460], [400, -1600], [500, -1720], [600, -1800]], { causeway: true });
  road('bree', 'tomshouse', [[-250, -20], [-250, 90], [-280, 160], [-330, 260], [-380, 360], [-440, 450], [-500, 520], [-520, 560]]);
  // scenic paths (narrower; `kind:'path'`)
  road('staddle', 'forsakeninn', [[-200, 150], [-130, 200], [-40, 260], [60, 300], [150, 330], [230, 280], [280, 200], [300, 120]], { kind: 'path', width: 4, name: 'The Midgewater Path' });
  road('rivendell', 'highcrag', [[1400, 40], [1440, -40], [1470, -130], [1500, -220], [1540, -300], [1600, -400]], { kind: 'path', width: 4, name: 'The Mountain Stair' });
  road('tinnudir', 'poi_annuminas', [[-200, -1050], [-120, -1040], [-40, -1000], [10, -960], [-50, -1120], [-150, -1190], [-250, -1200], [-360, -1170], [-450, -1100], [-520, -1000], [-540, -900]], { kind: 'path', width: 4, name: 'The Lakeside Way', causeway: true });

  // ---------------------------------------------------------------- docks & boat routes (§9) ---------------------------------
  W.docks = [
    { id: 'dock_celondim', name: 'The Quay of Celondim', town: 'celondim', pos: { x: -1524, z: -674 }, yaw: 4.3197, routes: ['dock_tolfuin', 'dock_morwen', 'dock_duillond'] },
    { id: 'dock_duillond', name: 'Duillond Landing', town: 'duillond', pos: { x: -1512, z: -796 }, yaw: 3.5343, routes: ['dock_celondim', 'dock_tolfuin'] },
    { id: 'dock_tinnudir', name: 'Tinnudir Quay', town: 'tinnudir', pos: { x: -256, z: -1020 }, yaw: 0.0000, routes: ['dock_forochel'] },
    { id: 'dock_forochel', name: 'Ice-bay Landing', town: 'surikyla', pos: { x: 514, z: -1899 }, yaw: 3.1416, routes: ['dock_tinnudir'] },
    { id: 'dock_tolfuin', name: 'The Quay of Ost Fuin', town: 'ostfuin', pos: { x: -1620, z: -1494 }, yaw: 0.7854, routes: ['dock_celondim', 'dock_himling', 'dock_duillond'] },
    { id: 'dock_himling', name: 'Ras Himling Landing', town: 'rashimling', pos: { x: -1554, z: -444 }, yaw: 0.7854, routes: ['dock_tolfuin', 'dock_morwen'] },
    { id: 'dock_morwen', name: 'Morwen Harbour', town: 'morwenvillage', pos: { x: -1718, z: 702 }, yaw: 0.7854, routes: ['dock_himling', 'dock_celondim'] },
  ];

  // ---------------------------------------------------------------- stable-master swift travel ------------------------------
  W.travelRoutes = [];
  (function buildTravel() {
    const st = W.towns.filter((t) => t.hasStable);
    for (let i = 0; i < st.length; i++) for (let j = 0; j < st.length; j++) {
      if (i === j) continue;
      const a = st[i], b = st[j]; const dist = d2(a.pos.x, a.pos.z, b.pos.x, b.pos.z);
      W.travelRoutes.push({ from: a.id, to: b.id, cost: 150 + Math.round(dist * 1.1), dist: Math.round(dist) });
    }
  })();

  // ---------------------------------------------------------------- NPC registry -----------------------------------------------
  // N(short, name, title, race, gender, roles, level, dx, dz, dialogue[], opts{inside, dock, yaw, hub})
  W.npcs = [];
  function N(short, name, title, race, gender, roles, level, dx, dz, dialogue, opts) {
    const t = T;
    const n = { id: 'npc_' + t.id + '_' + short, name, title, race, gender, zone: t.zone, town: t.id,
      pos: { x: t.pos.x + dx, z: t.pos.z + dz }, yaw: Math.atan2(dx, dz), roles, dialogue, level };
    if (opts) {
      if (opts.inside != null) {
        const b = t.buildings[opts.inside];
        n.interior = { town: t.id, index: opts.inside };
        n.pos = { x: b.x, z: b.z }; n.yaw = b.yaw;
        (b.npcInside = b.npcInside || []).push(n.id);
      }
      if (opts.dock) {
        const d = W.docks.find((k) => k.id === opts.dock);
        n.dock = opts.dock;
        n.pos = { x: round1(d.pos.x + Math.sin(d.yaw) * 4), z: round1(d.pos.z + Math.cos(d.yaw) * 4) };
        n.yaw = d.yaw + Math.PI;
      }
      if (opts.yaw != null) n.yaw = opts.yaw * R;
      if (opts.hub) n.hub = true;
    }
    W.npcs.push(n); return n;
  }

  // ---- Hobbiton --------------------------------------------------------------------------------------------------------------
  at('hobbiton');
  N('gaffer', 'Hamfast Gamgee', 'The Gaffer', 'hobbit', 'male', ['questgiver'], 5, -24, -30,
    ['Taters. Boil \'em, mash \'em — but first somebody has to dig \'em, and my back is not what it was.', 'Wolves in the Bindbole Wood, they say. In MY day the worst we had was Lobelia.', 'Mind the Hill, young master. Mr. Bilbo does not care for folk trampling his marigolds.'], { hub: true });
  N('holman', 'Holman Greenhand', 'Master Gardener', 'hobbit', 'male', ['questgiver'], 4, -6, -50,
    ['The whole Hill is going to seed and I have but two hands.', 'Someone has been at the Party Field with a spade. Ruffians, or worse — Sackville-Bagginses.', 'A garden is a promise you keep every single day.']);
  N('lobelia', 'Lobelia Sackville-Baggins', 'of Sackville', 'hobbit', 'female', ['questgiver'], 6, -50, -60,
    ['Well? Have you come to gawp, or are you useful?', 'Somebody has stolen my second-best umbrella and I want it BACK.', 'Bag End should have been mine. Everyone knows it.']);
  N('daisy', 'Daisy Proudfoot', 'Innkeeper of the Ivy Bush', 'hobbit', 'female', ['innkeeper'], 6, 0, 0,
    ['Welcome to the Ivy Bush! A room is a silver, a pint is a copper, and the gossip is free.', 'Rest here as long as you like, dear. I\'ll keep your things safe.'], { inside: 4 });
  N('rosie', 'Rosie Cotton', 'Barmaid', 'hobbit', 'female', ['vendor:food'], 4, 0, 0,
    ['Seed-cake, mushroom pie, and a cheese that walked here from Michel Delving on its own.', 'Sam Gamgee said he\'d dance with me at the Free Fair. We shall see.'], { inside: 4 });
  N('marigold', 'Marigold Chubb', 'Minstrel', 'hobbit', 'female', ['bard'], 5, 0, 0,
    ['~ Ho! Ho! Ho! To the bottle I go, to heal my heart and drown my woe ~', 'Every song in the Shire is about food, ale, or somebody\'s relations. Mine are about all three.'], { inside: 4 });
  N('bodo', 'Bodo Proudfoot', 'Shopkeeper', 'hobbit', 'male', ['vendor:general'], 5, -50, 6,
    ['Rope, lanterns, pipe-weed, and a very fine line in pocket-handkerchiefs.', 'PROUDFEET, if you please. Mind the step.']);
  N('milo', 'Milo Burrowes', 'Leather-worker', 'hobbit', 'male', ['vendor:armour'], 6, -38, 36,
    ['Jerkins, boots for the big folk, and hardened leather for anyone silly enough to fight wolves.', 'A good coat outlasts a good idea.']);
  N('tobias', 'Tobias Grubb', 'Smith', 'hobbit', 'male', ['vendor:weapons'], 7, 0, 22,
    ['Hobbits don\'t need swords. Hobbits need pans that can double as swords. I make both.', 'Sharpened, balanced, and guaranteed against ruffians of the plain sort.']);
  N('perry', 'Peregrin Took the Elder', 'Master of the Bounders', 'hobbit', 'male', ['trainer'], 10, -56, -36,
    ['Every Bounder starts by learning to throw a stone. Then a knife. Then a party.', 'Come to me when you have coin and courage, and I will teach you the tricks of your trade.']);
  N('nob', 'Nob Bracegirdle', 'Stable-master', 'hobbit', 'male', ['stablemaster'], 5, -42, -8,
    ['Ponies to Michel Delving, Bree and beyond — swift as you like, for a few coppers.', 'Don\'t feed the grey one. He bites when he\'s happy.']);
  N('robin', 'Robin Smallburrow', 'Shirriff', 'hobbit', 'male', ['guard'], 8, -70, 14,
    ['Nothing to see here. Move along. Well — one thing to see, but it ran off.', 'Keep to the roads after dark. The wolves aren\'t polite this year.']);
  N('fastred', 'Fastred Bolger', 'Bounder', 'hobbit', 'male', ['guard'], 8, 36, -40,
    ['Bounder Bolger, at your service. I count anyone who comes over the Hill, and I count them twice.', 'Strangers on the East Road again. Big folk with bad manners.']);
  N('ted', 'Ted Sandyman', 'Miller', 'hobbit', 'male', ['flavor'], 5, 0, 48,
    ['The Mill grinds what it\'s given. Same as me.', 'If Mr. Baggins wants his corn ground he can wait his turn like everybody else.', 'Queer folk on the roads. I say let \'em come, so long as they pay.']);
  N('pansy', 'Pansy Boffin', 'Hobbit-lass', 'hobbit', 'female', ['flavor'], 1, -14, 30,
    ['Are you an adventurer? Real ones have muddy boots. Yours are only a bit muddy.', 'I can whistle louder than any lad in Hobbiton. Listen!']);
  N('hamson', 'Hamson Twofoot', 'Farmer', 'hobbit', 'male', ['flavor'], 4, -80, 40,
    ['Something is eating my turnips, and it isn\'t rabbits. Rabbits don\'t leave boot-prints.', 'You look like you could carry a sack or two. No? Pity.']);
  N('hob', 'Hob Goodbody', 'Angler', 'hobbit', 'male', ['flavor'], 3, 40, -36,
    ['Trout in the Water, perch by the Mill, and a pike under the bridge that has been laughing at me for eleven years.', 'Cast gentle. The fish can hear you thinking.']);

  // ---- Michel Delving --------------------------------------------------------------------------------------------------------
  at('micheldelving');
  N('mayor', 'Will Whitfoot', 'Mayor of Michel Delving', 'hobbit', 'male', ['questgiver'], 8, -14, -14,
    ['The Mayor\'s chief duties are to preside at banquets — and, apparently, to deal with ruffians.', 'The Free Fair is coming and half the Westfarthing is in an uproar. I need a capable pair of hands.', 'Flourdumpling, they call me. I take it as a compliment.'], { hub: true });
  N('mathom', 'Fosco Boffin', 'Keeper of the Mathom-house', 'hobbit', 'male', ['questgiver'], 7, 18, 14,
    ['A mathom is anything a hobbit has no use for but cannot bear to throw away. We have three rooms of them.', 'Somebody has walked off with a mithril-coat replica. Well — it might have been the real one.']);
  N('postmaster', 'Adelard Hornblower', 'Postmaster', 'hobbit', 'male', ['questgiver'], 5, -20, 12,
    ['The Quick Post is neither quick nor, this week, post. My carriers have gone missing.', 'Letters to Bree take three days. Letters from Bree take four and smell of pipe-smoke.']);
  N('innkeeper', 'Bell Goodchild', 'Innkeeper of the Bird and Baby', 'hobbit', 'female', ['innkeeper'], 6, 0, 0,
    ['The Bird and Baby — best beds on the White Downs. Sleep well, and I\'ll mind your affairs.', 'Rest and save your strength, dearie. The Downs will still be there tomorrow.'], { inside: 1 });
  N('bard', 'Andwise Brockhouse', 'Fiddler', 'hobbit', 'male', ['bard'], 6, 0, 0,
    ['~ There is an inn, a merry old inn, beneath an old grey hill ~', 'Requests taken. Payment in ale accepted and, indeed, preferred.'], { inside: 1 });
  N('general', 'Olo Bracegirdle', 'Shopkeeper', 'hobbit', 'male', ['vendor:general'], 6, -8, -24,
    ['Everything a hobbit needs and a fair bit a hobbit doesn\'t.', 'We stock lantern-oil by the barrel. Ask me why. Go on.']);
  N('armour', 'Hilda Bracegirdle', 'Armourer', 'hobbit', 'female', ['vendor:armour'], 8, 6, -44,
    ['Bracegirdle mail: fitted for the shorter warrior. Big folk sizes on request.', 'A dented helm is a story. An un-dented one is a plan.']);
  N('weapons', 'Ponto Hayward', 'Cutler', 'hobbit', 'male', ['vendor:weapons'], 8, -4, 26,
    ['Knives, hatchets, walking-sticks with a bit of iron in them. Bounder-approved.', 'The blade doesn\'t make the hero. But it helps.']);
  N('trainer', 'Isengar Took', 'Adventurer (retired)', 'hobbit', 'male', ['trainer'], 12, -36, 30,
    ['I went to sea once. Nobody believes me, so I teach instead.', 'Learn the trade properly and you may live long enough to be disbelieved too.']);
  N('stable', 'Sancho Proudfoot', 'Stable-master', 'hobbit', 'male', ['stablemaster'], 5, 10, 44,
    ['Ponies for hire to every stable in Eriador. The far ones cost more; the far ones bite more.', 'Hold the reins loose and the pony does the thinking.']);
  N('shirriff', 'Hob Hayward', 'Shirriff of the Westfarthing', 'hobbit', 'male', ['guard'], 9, 30, -38,
    ['Shirriff Hayward. One feather in my cap and one eye on you.', 'Ruffians have been seen on the road to Waymeet. If you see a big man with a scarred face, don\'t be brave, be quick.']);
  N('farmer', 'Rufus Burrows', 'Farmer', 'hobbit', 'male', ['flavor'], 4, -58, 30,
    ['Best mushrooms on the White Downs, and I\'ll thank you not to ask where.', 'It\'ll rain by supper. My knee says so, and my knee is never wrong. Often, but never.']);
  N('child', 'Nibs Chubb', 'Hobbit-lad', 'hobbit', 'male', ['flavor'], 1, 0, -8,
    ['The Mathom-house has a real dragon\'s tooth! Fosco says so. Fosco says lots of things.', 'Race you to the well! No? Then I win.']);

  // ---- Bywater ---------------------------------------------------------------------------------------------------------------
  at('bywater');
  N('tolman', 'Tolman Cotton', 'Farmer Cotton', 'hobbit', 'male', ['questgiver'], 6, 8, -44,
    ['There\'s a wolf been at the lambs and a queer light down by the Pool at night. I don\'t like either.', 'Give me a hand and you\'ll never go hungry in Bywater, that I promise.', 'My Rosie is up at the Ivy Bush. Don\'t you go giving her ideas.'], { hub: true });
  N('nick', 'Nick Cotton', 'Shirriff', 'hobbit', 'male', ['questgiver'], 7, -8, -14,
    ['Shirriff business! Somebody\'s been dumping rubbish in the Pool and it is NOT the fish.', 'A Bounder\'s work is never done. Mostly because nobody starts it.']);
  N('innkeeper', 'Ivo Goodchild', 'Innkeeper of the Green Dragon', 'hobbit', 'male', ['innkeeper'], 6, 0, 0,
    ['The Green Dragon! Best beer in the Eastfarthing — well, the Westfarthing — well, THIS farthing.', 'Sit by the fire and rest. Your gear\'s safe under my roof.'], { inside: 0 });
  N('bard', 'Peony Brandybuck', 'Songstress', 'hobbit', 'female', ['bard'], 5, 0, 0,
    ['~ Sing hey! for the bath at close of day that washes the weary mud away ~', 'The Green Dragon crowd want the same six songs every night. I give them seven, to be difficult.'], { inside: 0 });
  N('food', 'Daisy Boffin', 'Cook', 'hobbit', 'female', ['vendor:food'], 5, 0, 0,
    ['Hot pies, cold pies, and something the Gaffer calls a stew.', 'Eat first. Adventure after. That\'s the Shire way.'], { inside: 0 });
  N('general', 'Fredegar Chubb', 'Shopkeeper', 'hobbit', 'male', ['vendor:general'], 5, 28, -14,
    ['Bywater Stores — if it isn\'t here, you don\'t need it.', 'We\'ve had a run on lanterns. Everyone\'s afraid of the dark this spring.']);
  N('fishing', 'Wilcome Brockhouse', 'Bait & Tackle', 'hobbit', 'male', ['vendor:fishing'], 5, -40, 18,
    ['Hooks, lines, worms and the finest willow rods this side of the Brandywine.', 'The pike under the old bridge? Aye. He\'s a legend. Legends don\'t fit in a pan.']);
  N('fisher', 'Hal Boffin', 'Angler', 'hobbit', 'male', ['flavor'], 3, -14, -12,
    ['Shh. The perch are listening.', 'Caught a boot last week. A GOOD boot, mind.']);
  N('child', 'Merry Grubb', 'Hobbit-lass', 'hobbit', 'female', ['flavor'], 1, 14, 20,
    ['The Green Dragon has a REAL dragon on the sign. Da says the real ones are bigger.', 'I\'m not allowed near the Pool. So I only go when nobody\'s looking.']);
  N('farmer', 'Rowan Cotton', 'Farmer', 'hobbit', 'female', ['flavor'], 4, -14, 34,
    ['If you\'re going to Bree, mind the Big Folk. And their prices.', 'Eleven sacks of taters and one pony. Something\'s got to give.']);

  // ---- Thorin's Hall ---------------------------------------------------------------------------------------------------------
  at('thorinshall');
  N('dwalin', 'Dwalin', "Lord of Thorin's Hall", 'dwarf', 'male', ['questgiver'], 15, 0, -24,
    ['Dwalin, at your service. And I mean that in the old way: I have work, and you look like work.', 'The Dourhands stir in the deeps and goblins hold Rath Teraig. I will not have it.', 'Thorin\'s Hall stands. It will stand long after the Shadow is a bad dream.'], { hub: true });
  N('skorri', 'Skorri Runereader', 'Loremaster of the Longbeards', 'dwarf', 'male', ['questgiver'], 12, -36, -48,
    ['Runes do not lie. Dwarves who read them badly, however, lie constantly.', 'Old tunnels have been opened beneath the Hall. Something has been reading what was written there.']);
  N('broin', 'Bróin Deepdelver', 'Master Prospector', 'dwarf', 'male', ['questgiver'], 10, 30, 50,
    ['Copper in the north face, iron in the south, and something under the east that hums.', 'A prospector needs three things: a good pick, a bad memory for pain, and a sturdy friend. Interested?']);
  N('nain', 'Náin Stonebrow', 'Master of the Forge', 'dwarf', 'male', ['vendor:weapons'], 12, 36, 12,
    ['Axes, hammers, and blades that will not fail you. Dwarf-forged, dwarf-priced.', 'Steel remembers who made it. Mine remembers well.']);
  N('bori', 'Bori Ironbelt', 'Armourer', 'dwarf', 'male', ['vendor:armour'], 12, 54, -12,
    ['Mail that fits like a second beard. Try the hauberk.', 'A dwarf without armour is just a very short target.']);
  N('frar', 'Frár Coppersmith', 'Provisioner', 'dwarf', 'male', ['vendor:general'], 8, -54, -14,
    ['Lamps, rope, pitons, salt-pork and pipe-weed. Everything a delver needs.', 'Prices are fair. Complaints are free. Refunds are legend.']);
  N('hild', 'Hild Alewife', 'Keeper of the Anvil and Ale', 'dwarf', 'female', ['innkeeper'], 10, 0, 0,
    ['Welcome to the Anvil and Ale. The ale is strong and the beds are stone — you\'ll sleep like one.', 'Rest here. Nobody troubles my guests twice.'], { inside: 3 });
  N('rurik', 'Rúrik Fiddlebeard', 'Skald', 'dwarf', 'male', ['bard'], 9, 0, 0,
    ['~ Far over the misty mountains cold, to dungeons deep and caverns old ~', 'A song about gold, a song about grief, and one about a very bad goat. Choose.'], { inside: 3 });
  N('thekka', 'Thekka Stewpot', 'Cook', 'dwarf', 'female', ['vendor:food'], 8, -20, 10,
    ['Stew that stands up on its own. Bread you could hammer nails with. Eat!', 'Salt-beef, cram, and honey-cakes for the sweet-toothed.']);
  N('grimr', 'Grimr Battle-brow', 'Weapon-master', 'dwarf', 'male', ['trainer'], 18, 20, -40,
    ['Feet apart, shield up, chin down. Again. AGAIN.', 'I train anyone with coin and grit. Elves included, if they promise not to sing.']);
  N('hafgrim', 'Hafgrim Ponymaster', 'Stable-master', 'dwarf', 'male', ['stablemaster'], 8, 46, 32,
    ['Sturdy ponies for the mountain roads, and swift ones for the Shire lanes.', 'Hobbiton, Duillond, Bree — name it and the pony knows the way.']);
  N('guard1', 'Nali', 'Guard of the Hall', 'dwarf', 'male', ['guard'], 16, -14, -30,
    ['Halt — no, carry on. You don\'t look like a Dourhand.', 'The Hall is watched. Always.']);
  N('guard2', 'Thorek', 'Guard of the Hall', 'dwarf', 'male', ['guard'], 16, 14, -30,
    ['Watch your head on the lintel. Big folk always forget.', 'Goblins in the pass again. Good — I was getting bored.']);
  N('gimbur', 'Gimbur', 'Apprentice Smith', 'dwarf', 'male', ['flavor'], 5, -30, 32,
    ['Master Náin says I\'ll be a proper smith in forty years. I\'m counting.', 'Have you SEEN the forge-fire? It\'s like the sun, but useful.']);
  N('sigrun', 'Sigrún Ore-sifter', 'Miner', 'dwarf', 'female', ['flavor'], 7, -8, -70,
    ['Silver in the north shaft, and songs in the rock if you know how to listen.', 'The deep places are quiet this month. Too quiet.']);

  // ---- Celondim --------------------------------------------------------------------------------------------------------------
  at('celondim');
  N('master', 'Elorion', 'Master of the Haven', 'elf', 'male', ['questgiver'], 15, -6, -24,
    ['Welcome to Celondim, where the last ships wait for those who would sail West.', 'The sea has grown restless, and things have crawled from the caves of Kheledûl that should not walk under the sun.', 'We linger here still. There is work left in Middle-earth, and I am not too proud to ask for help.'], { hub: true });
  N('ninglor', 'Ninglor', 'Shipwright', 'elf', 'female', ['questgiver'], 12, -58, 10,
    ['A ship is a song in wood. This one has a wrong note somewhere in the keel.', 'I need heartwood from the old grove and I cannot leave the slipway. Would you go?']);
  N('tathar', 'Tathar', 'Warden of the Wood', 'elf', 'male', ['questgiver'], 13, 20, -40,
    ['The woods of Falathlorn remember every step. Lately they remember goblins.', 'Walk with me a while and I will show you how to read a trail.']);
  N('lothwen', 'Lothwen', "Keeper of the Haven's Rest", 'elf', 'female', ['innkeeper'], 12, 0, 0,
    ['Rest beneath the birches. The Haven keeps no locks; it has never needed them.', 'Sleep, and I will watch. It is what we do.'], { inside: 1 });
  N('faelas', 'Faelas', 'Harper', 'elf', 'male', ['bard'], 12, 0, 0,
    ['~ A Elbereth Gilthoniel, silivren penna míriel ~', 'Every song is a memory. I have a great many memories.'], { inside: 1 });
  N('general', 'Celebrin', 'Provisioner', 'elf', 'female', ['vendor:general'], 10, -42, 20,
    ['Lembas we do not sell. Everything else, gladly.', 'Rope of hithlain, lanterns of crystal, and salt that has seen the sea.']);
  N('armour', 'Aerandir', 'Armourer', 'elf', 'male', ['vendor:armour'], 12, -46, -40,
    ['Light mail, elf-wrought. You will forget you wear it until it saves your life.', 'Heavy plate for the dwarves\' friends. We do not judge.']);
  N('weapons', 'Belegor', 'Fletcher', 'elf', 'male', ['vendor:weapons'], 12, -8, 32,
    ['Bows of yew and blades of Lindon steel.', 'An arrow well made flies half by craft and half by will.']);
  N('food', 'Míriel', 'Keeper of the Larder', 'elf', 'female', ['vendor:food'], 8, 12, 26,
    ['Honey, waybread, cordial. Travel light and eat well.', 'The apples are from Duillond. The wine is older than Bree.']);
  N('fishing', 'Gwaerion', 'Net-mender', 'elf', 'male', ['vendor:fishing'], 8, -60, -8,
    ['Lines, lures and floats. The cod run close to the quay at dusk.', 'The Sea speaks to those who fish it. Mostly it says: patience.']);
  N('trainer', 'Elhador', 'Weapon-master', 'elf', 'male', ['trainer'], 20, 30, 10,
    ['Three thousand years I have practised the blade. You have a week. We will manage.', 'Come with gold and humility, and leave with skill.']);
  N('stable', 'Hithlas', 'Stable-master', 'elf', 'male', ['stablemaster'], 10, 38, 20,
    ['Our horses know the roads to Duillond, Thorin\'s Hall and the Shire.', 'Ride gently; they carry you as a favour, not a duty.']);
  N('boat', 'Eärlan', 'Mariner', 'elf', 'male', ['boatmaster'], 15, 0, 0,
    ['The Quay of Celondim. From here: Tol Fuin, Tol Morwen, and Duillond along the coast.', 'The sea is wide and the serpent hunts off Tol Fuin. We sail anyway.'], { dock: 'dock_celondim' });
  N('guard', 'Calen', 'Haven-warden', 'elf', 'male', ['guard'], 16, -2, -16,
    ['Peace, traveller. The Haven is open to all who come in friendship.', 'Goblins were seen on the ridge at dawn. They will not be seen at dusk.']);
  N('gilmith', 'Gilmith', 'Young Elf', 'elf', 'female', ['flavor'], 3, 14, 40,
    ['Have you seen the ships? I have counted every one. Forty-one this age.', 'Mother says I may not sail West until I have seen an oliphaunt. I think she is teasing.']);
  N('hendor', 'Hendor', 'Sailor', 'elf', 'male', ['flavor'], 9, -64, 20,
    ['Tar, salt and sail-cloth. Best smell in Middle-earth.', 'The Sundered Isles are older than the Shire and stranger than the Downs. Mind yourself there.']);

  // ---- Duillond --------------------------------------------------------------------------------------------------------------
  at('duillond');
  N('keeper', 'Iavas', 'Keeper of Duillond', 'elf', 'female', ['questgiver'], 14, 10, -20,
    ['Duillond is quiet, and I would keep it so. Lately the quiet has cracks in it.', 'Lynxes have come down from the hills and the Dourhands have been seen at Kheledûl.', 'Help us, and the birches of Duillond will remember your name.'], { hub: true });
  N('forester', 'Lainedhel', 'Forester', 'elf', 'male', ['questgiver'], 12, -22, 20,
    ['The trees speak of axes. Dwarf-axes, in a place dwarves were promised not to go.', 'I need a keen eye and a light step in the wood below the falls.']);
  N('general', 'Elemmir', 'Provisioner', 'elf', 'male', ['vendor:general'], 10, 22, 6,
    ['Travelling-goods, lamps, and the cordial of Duillond.', 'What we have is yours for silver. What we lack, the sea will bring.']);
  N('food', 'Nestadis', 'Keeper of the Larder', 'elf', 'female', ['vendor:food'], 8, -2, 26,
    ['Bread, honey, and pears from the terraces.', 'Eat slowly. The view is part of the meal.']);
  N('trainer', 'Talagan', 'Sword-master', 'elf', 'male', ['trainer'], 18, 24, -46,
    ['Balance before strength; patience before balance.', 'Bring gold, and I will bring three thousand years of practice.']);
  N('guard', 'Merethir', 'Warden', 'elf', 'male', ['guard'], 16, -30, -6,
    ['Pass freely, friend of the Havens.', 'We keep watch on the coast road. Dourhands have long memories and short tempers.']);
  N('boat', 'Falathar', 'Boat-master', 'elf', 'male', ['boatmaster'], 14, 0, 0,
    ['Duillond Landing. A short sail to Celondim, or the long road west to Tol Fuin.', 'Mind the swell past the headland.'], { dock: 'dock_duillond' });
  N('stars', 'Ithilwen', 'Star-gazer', 'elf', 'female', ['bard', 'flavor'], 11, -36, -38,
    ['~ The stars are the same as when we crossed the ice. Only we have changed ~', 'Eärendil rises early tonight. That is either good luck or a warning; I forget which.']);

  // ---- Bree ------------------------------------------------------------------------------------------------------------------
  at('bree');
  N('mayor', 'Hardwin Appledore', 'Mayor of Bree', 'man', 'male', ['questgiver'], 15, 0, -30,
    ['Bree has stood since before the Kings, and it will stand after the brigands. With a little help.', 'The Blackwolds grow bold, strangers ride the Greenway by night, and the Watch is thin. You see my difficulty.', 'Do this for Bree and Bree will remember it. We are slow to trust and slower to forget.'], { hub: true });
  N('hollis', 'Hollis Thornbury', 'Constable of the Watch', 'man', 'male', ['questgiver'], 14, -20, 42,
    ['Constable Thornbury. I keep the peace, or I keep trying.', 'There is a fence in the town selling Blackwold plunder. I want names, not rumours.']);
  N('sally', 'Sally Thistlewood', 'Herbalist', 'man', 'female', ['questgiver'], 12, 44, 44,
    ['Old Sally, they call me, as if there were a young one. Come for a poultice or a task?', 'Kingsfoil grows in the Bree-hill hedgerows, if the boars have left any.']);
  N('grimbold', 'Grimbold Tallgrass', 'Captain of the Gate', 'man', 'male', ['questgiver'], 18, -92, -10,
    ['The West-gate is mine. Nothing gets in that I don\'t like the look of, and I don\'t like the look of much.', 'Wolves on the Greenway, brigands in the Chetwood. Pick one; I\'ll pay for either.']);
  N('barliman', 'Barliman Butterbur', 'Proprietor of the Prancing Pony', 'man', 'male', ['innkeeper'], 12, 0, 0,
    ['Welcome, welcome! The Prancing Pony — best beds east of the Brandywine, and I\'d say west of it too.', 'One thing drives out another, as they say, and I\'ve a mort of things to remember. Rest here; your goods are safe.', 'Nob! Where is that woolly-footed slowcoach?'], { inside: 0 });
  N('nob', 'Nob', 'Serving-hobbit', 'hobbit', 'male', ['flavor'], 6, 0, 0,
    ['Coming, Mr. Butterbur! Coming!', 'The Ranger in the corner has been here three days and eaten nothing but bread. Queer folk.'], { inside: 0 });
  N('hedgerose', 'Hedgerose Bramblewick', 'Minstrel', 'man', 'female', ['bard'], 10, 0, 0,
    ['~ The Man in the Moon came down too soon ~ — they always want that one.', 'Songs for coin, songs for ale, songs for a rainy night. Pick your price.'], { inside: 0 });
  N('strider', 'Strider', 'A Ranger of the North', 'dunedain', 'male', ['questgiver'], 25, 0, 0,
    ['Not all those who wander are lost. Some of them are looking for you.', 'There are things abroad that Bree does not name. I do. Are you willing to walk in dark places?', 'Keep your sword close and your trust closer.'], { inside: 0 });
  N('aldous', 'Aldous Larkspur', 'Shopkeeper', 'man', 'male', ['vendor:general'], 10, -30, -10,
    ['Larkspur\'s General Goods — rope, lamps, bait, boots, and Southfarthing leaf at Bree prices.', 'No credit. Not since the last Ranger.']);
  N('bertram', 'Bertram Buckle', 'Armourer', 'man', 'male', ['vendor:armour'], 14, -22, 10,
    ['Leather, mail, and plate for those who can carry it.', 'The Blackwolds wear whatever they steal. Wear something they\'ll want.']);
  N('ealdric', 'Ealdric Hammerhand', 'Smith', 'man', 'male', ['vendor:weapons'], 14, 30, 10,
    ['Swords, axes, maces. Sharpened while you wait, if you don\'t mind the sparks.', 'Hammerhand steel. My grandfather forged for the Rangers; I forge for anyone.']);
  N('hurlow', 'Mother Hurlow', 'Pie-wife', 'man', 'female', ['vendor:food'], 8, -12, 16,
    ['Hot pies! Pork, apple, and one I call Surprise.', 'Eat up. A fed adventurer is a live adventurer.']);
  N('tobin', 'Tobin Fletcher', 'Fletcher', 'man', 'male', ['vendor:weapons'], 12, 30, -12,
    ['Bows, crossbows, and arrows by the score.', 'The Chetwood is full of things that die better at thirty paces.']);
  N('cuthbert', 'Cuthbert Longstride', 'Master-at-arms', 'man', 'male', ['trainer'], 22, -50, 52,
    ['I have taught every class of fighter that ever came through the West-gate. Some of them even listened.', 'Coin for lessons. Bruises are free.']);
  N('bob', 'Bob Ostler', 'Stable-master', 'man', 'male', ['stablemaster'], 10, -72, 8,
    ['Horses to the Shire, the Lone-lands, the North Downs — anywhere with a stable.', 'Bill Ferny\'s been round asking about the ponies again. I don\'t like it.']);
  N('guard_w', 'Watchman Tam', 'Bree Watch', 'man', 'male', ['guard'], 16, -104, 10,
    ['West-gate\'s open sunrise to sundown. After that, knock loud and be polite.', 'Move along, now.']);
  N('guard_s', 'Watchman Rudd', 'Bree Watch', 'man', 'male', ['guard'], 16, -8, 102,
    ['South road\'s for Staddle and the Downs. Nobody goes to the Downs. Nobody sensible.', 'Seen any riders in black? No? Good.']);
  N('guard_e', 'Watchman Hob', 'Bree Watch', 'man', 'male', ['guard'], 16, 102, -8,
    ['East-gate. Combe and Archet up the lane, the Forsaken Inn a long day east.', 'Keep your purse inside your coat. This is Bree.']);
  N('harry', 'Harry Goatleaf', 'Gatekeeper', 'man', 'male', ['flavor'], 8, -100, -10,
    ['What\'s your business in Bree? — all right, all right, don\'t take on.', 'Queer customers on the road these days. Queer customers indeed.']);
  N('ferny', 'Bill Ferny', 'Ne\'er-do-well', 'man', 'male', ['flavor'], 9, 60, -10,
    ['What are you looking at?', 'I know things. Things cost money.', 'That pony? Never seen it before in my life.']);
  N('tommy', 'Tommy Appledore', 'Boy', 'man', 'male', ['flavor'], 1, 8, 40,
    ['Are you a Ranger? Rangers have swords. You have a sword. So you\'re a Ranger.', 'Nob says there\'s a hobbit at the Pony who can vanish. I\'ve been watching for hours.']);
  N('mugwort', 'Old Mugwort', 'Farmer', 'man', 'male', ['flavor'], 6, 56, 84,
    ['Boars in the barley and wolves in the lambs. Same as every year, only more.', 'Butterbur waters his ale. Tell him I said so.']);
  N('wat', 'Wat Hammerhand', 'Smith\'s Apprentice', 'man', 'male', ['flavor'], 5, 44, 26,
    ['Six months on the bellows before I touch a hammer. Six months!', 'Ealdric says a blade is a promise. I say it\'s a blade.']);
  N('bramble', 'Mistress Bramble', 'Gossip', 'man', 'female', ['flavor'], 7, -40, -50,
    ['Have you heard? Three ponies gone from Ferny\'s field and he never lost a wink.', 'The Rangers know more than they say. So do I, come to that.']);

  // ---- Combe -----------------------------------------------------------------------------------------------------------------
  at('combe');
  N('reeve', 'Tancred Applewhite', 'Reeve of Combe', 'man', 'male', ['questgiver'], 12, -14, 6,
    ['Combe is a quiet dell, and I intend it to stay quiet. The Blackwolds have other plans.', 'Somebody in this village is passing word to the brigands. I mean to find out who.', 'Do right by Combe and Combe will do right by you.'], { hub: true });
  N('ellie', 'Ellie Cutleaf', 'Brewster', 'man', 'female', ['questgiver'], 10, -16, -26,
    ['My best barrels went missing off the cart on the Archet road. Brigands, or thirsty ones.', 'Hops from the dell, water from the well, and a secret I\'ll take to my grave.']);
  N('innkeeper', 'Osric Tanner', 'Keeper of the Comb and Wattle', 'man', 'male', ['innkeeper'], 10, 0, 0,
    ['The Comb and Wattle. Dry beds, wet ale, and nobody asks where you\'ve been.', 'Rest a while. I\'ll see your things come to no harm.'], { inside: 0 });
  N('wren', 'Wren Fiddler', 'Fiddler', 'man', 'female', ['bard'], 8, 0, 0,
    ['~ Over the hill and under the hill, the road goes on and on ~', 'A tune for a copper. A sad tune for two; they take longer.'], { inside: 0 });
  N('general', 'Peg Thornwood', 'Shopkeeper', 'man', 'female', ['vendor:general'], 9, 18, 18,
    ['Provisions, rope, oil and boots. Combe-made or Bree-bought.', 'Prices went up when the road got dangerous. Blame the Blackwolds.']);
  N('gamel', 'Gamel Ironside', 'Smith', 'man', 'male', ['vendor:weapons'], 12, -14, -46,
    ['Blades, axes, and the odd ploughshare.', 'Sharpen it yourself and you\'ll learn something. Bring it to me and you\'ll learn faster.']);
  N('food', 'Hob Bramblewick', 'Baker', 'man', 'male', ['vendor:food'], 6, 12, 26,
    ['Bread, cheese, apples, and honey from the dell.', 'Combe bread travels well. Ask any brigand who\'s stolen it.']);
  N('rolf', 'Rolf Brackenbury', 'Huntsman', 'man', 'male', ['trainer'], 18, 22, -42,
    ['I\'ll teach you to track, to strike and to stand. The rest is up to you.', 'Every class has a trick. I know most of them.']);
  N('guard', 'Watchman Alder', 'Combe Watch', 'man', 'male', ['guard'], 14, -12, 46,
    ['Bree road\'s that way. Archet\'s the other. Blackwolds, everywhere else.', 'Keep moving; don\'t give them a target.']);
  N('child', 'Nell Applewhite', 'Girl', 'man', 'female', ['flavor'], 1, 24, 26,
    ['Papa says the brigands are cowards. I saw one once. He was big for a coward.', 'Do you want to see my frog?']);
  N('farmer', 'Gaffer Broadbeam', 'Farmer', 'man', 'male', ['flavor'], 6, -46, 20,
    ['Boars in the turnips. Every year worse.', 'If you\'re going up to Archet, tell them the cider\'s ready.']);

  // ---- Archet ----------------------------------------------------------------------------------------------------------------
  at('archet');
  N('captain', 'Aldric Brackenwood', 'Captain of Archet', 'man', 'male', ['questgiver'], 12, 0, -22,
    ['Archet burned once. I rebuilt the palisade with my own hands, and I will not see it burn again.', 'The Blackwolds still hide in the Chetwood and the wolves come closer every night. You look able. Are you willing?', 'Every hand counts here. Even a new one.'], { hub: true });
  N('rowena', 'Rowena Blackbriar', 'Huntress', 'man', 'female', ['questgiver'], 10, -40, 40,
    ['The wood used to be mine to walk. Now the brigands walk it, and the spiders after them.', 'Bring me pelts and I\'ll show you where the good hunting is.']);
  N('osgar', 'Osgar Frostwick', 'Elder', 'man', 'male', ['questgiver'], 8, 16, -40,
    ['I remember when the Greenway had traffic. Now it has wolves.', 'My son went to Bree three days ago. Three days.']);
  N('innkeeper', 'Hetty Hedgerow', 'Keeper of the Badger and Bow', 'man', 'female', ['innkeeper'], 8, 0, 0,
    ['The Badger and Bow. Hunters\' inn — muddy boots welcome.', 'Rest your head. I\'ll keep your kit under the bar.'], { inside: 0 });
  N('tam', 'Tam Fiddleback', 'Minstrel', 'man', 'male', ['bard'], 8, 0, 0,
    ['~ When winter first begins to bite and stones crack in the frosty night ~', 'Half these hunters can\'t carry a tune. Fortunately, I can.'], { inside: 0 });
  N('general', 'Dora Pennyworth', 'Shopkeeper', 'man', 'female', ['vendor:general'], 6, 26, 24,
    ['Provisions for the road and the wood. Lanterns, rope, bait, and a very good rope.', 'New in Archet? Everyone is, since the fire.']);
  N('ida', 'Ida Mailwright', 'Armourer', 'man', 'female', ['vendor:armour'], 10, -46, 4,
    ['Hunting leathers, chain, and a helm or two.', 'The wood doesn\'t care how brave you are. Wear the mail.']);
  N('caldwell', 'Caldwell Bowyer', 'Bowyer', 'man', 'male', ['vendor:weapons'], 10, -22, -4,
    ['Bows of Chetwood yew. Also knives, for when the bow runs out.', 'A straight arrow and a steady hand. I supply one of them.']);
  N('mabel', 'Mabel Sprigley', 'Cook', 'man', 'female', ['vendor:food'], 6, 12, 18,
    ['Stew, bread, and cider from the Sprigley orchard.', 'Eat something. You look like the wolves have been at you.']);
  N('torvan', 'Ranger Torvan', 'Ranger of the North', 'dunedain', 'male', ['trainer'], 20, -16, -40,
    ['I will teach what I can, to whoever will learn. The North needs every blade.', 'Gold for the lesson. It goes to the Rangers\' fund; we have few enough friends.']);
  N('stable', 'Ned Chubb', 'Stable-master', 'hobbit', 'male', ['stablemaster'], 6, 10, 40,
    ['Horses and ponies for hire. Combe, Bree, and points beyond.', 'She\'s a good horse. Don\'t let her near the cider.']);
  N('guard1', 'Watchman Alwin', 'Archet Watch', 'man', 'male', ['guard'], 14, 8, -4,
    ['The palisade holds. So do we.', 'Blackwolds keep to the deep wood. Don\'t go there alone.']);
  N('guard2', 'Watchman Cob', 'Archet Watch', 'man', 'male', ['guard'], 14, -44, 46,
    ['Watch the Combe road at dusk — that\'s when they come.', 'You\'re new. Try not to die in the first week; it\'s bad for morale.']);
  N('wat', 'Wat Blackbriar', 'Boy', 'man', 'male', ['flavor'], 1, -20, 14,
    ['Mum hunts wolves. I\'m going to hunt bears.', 'Have you ever seen a spider as big as a dog? I have. Twice.']);
  N('cal', 'Cal Sprigley', 'Farmer', 'man', 'male', ['flavor'], 5, -8, -62,
    ['The orchard came through the fire. The barn didn\'t.', 'Brigands took my plough-horse. A plough-horse! What do brigands want with a plough?']);
  N('jon', 'Jon Brackenbrook', 'Hunter', 'man', 'male', ['flavor'], 9, 46, -30,
    ['Tracks by the river: boots, not paws. Big boots.', 'A bow, a knife and a good dog. That\'s all a man needs. I\'m short the dog.']);

  // ---- Staddle ---------------------------------------------------------------------------------------------------------------
  at('staddle');
  N('elder', 'Fern Puddifoot', 'Elder of Staddle', 'hobbit', 'female', ['questgiver'], 10, -8, 24,
    ['Staddle! Best pipe-weed in Bree-land and the finest pigs, and lately the most trouble.', 'The Midgewater path is crawling with brigands and the spiders have taken the old lodge.', 'Big folk and little folk, we look after each other here. So look after us.'], { hub: true });
  N('nat', 'Nat Pickthorn', 'Pig-farmer', 'man', 'male', ['questgiver'], 8, 24, -14,
    ['My prize sow has wandered off into the Chetwood and she is worth more than this village.', 'Pigs are cleverer than people think. That\'s the trouble.']);
  N('general', 'Milo Sandheaver', 'Shopkeeper', 'hobbit', 'male', ['vendor:general'], 6, 20, 24,
    ['Staddle Goods — leaf, lamps, rope and pig-feed.', 'The Bree folk pay more for our leaf than they\'ll admit.']);
  N('oakheart', 'Widow Oakheart', 'Cook', 'man', 'female', ['vendor:food'], 6, -18, -26,
    ['Bacon, bread, and apples. Everything here comes from a pig or a tree.', 'Sit down and eat before you fall down.']);
  N('piers', 'Watchman Piers', 'Staddle Watch', 'man', 'male', ['guard'], 12, -26, 4,
    ['Bree\'s up the hill. The marsh is down the path. Choose wisely.', 'Brigands came by last month. They left faster.']);
  N('tansy', 'Tansy Puddifoot', 'Hobbit-lass', 'hobbit', 'female', ['flavor'], 1, -14, 40,
    ['Gran says I can\'t go to the marsh because of the neekerbreekers. What\'s a neekerbreeker?', 'I named all the pigs. The big one is Bilbo.']);
  N('tom', 'Tom Pickthorn', 'Farmer', 'man', 'male', ['flavor'], 5, 56, 20,
    ['Weed\'s in, pigs are fat, and the roof leaks. Two out of three.', 'If you see a sow with a blue ribbon, she\'s ours.']);
  N('chalk', 'Chalk', 'Fiddler', 'hobbit', 'male', ['bard', 'flavor'], 6, 2, -16,
    ['~ Hey dol! merry dol! ring a dong dillo ~ — I got that one off a fellow in a blue coat.', 'A song for the road? It\'s a long one; so is the road.']);

  // ---- Chetwood Hunters' Camp ------------------------------------------------------------------------------------------------
  at('chetwoodcamp');
  N('huntmaster', 'Bramwell Ashdown', 'Huntmaster', 'man', 'male', ['questgiver'], 18, -8, -12,
    ['The Chetwood used to be good hunting. Now the Blackwolds hunt us, and the spiders hunt everything.', 'Halgar the Blackwold has a camp in the marsh. Burn it and Bree-land sleeps easier.', 'Every pelt you bring me feeds the camp. Every brigand you drop feeds the crows.'], { hub: true });
  N('saeradan', 'Saeradan', 'Ranger of the Chetwood', 'dunedain', 'male', ['questgiver'], 22, 14, -32,
    ['The Blackwolds take orders from someone in the Lone-lands. I want the letters they carry.', 'Tread lightly in the marsh. The neekerbreekers sing louder when something big is moving.']);
  N('nell', 'Nell Tanner', 'Marsh-guide', 'man', 'female', ['questgiver'], 16, 12, 4,
    ['I know every dry path through the Midgewater. Most of them are under a foot of water.', 'Bog-slugs have eaten the marker-stakes again. Someone has to replace them, and someone is you.']);
  N('amos', 'Amos Tuck', 'Pedlar', 'man', 'male', ['vendor:general', 'vendor:food'], 15, -16, 26,
    ['Salt-pork, rope, torches and midge-salve. You will want the salve.', 'Bree prices plus the cost of getting it here alive.']);
  N('hugo', 'Hugo Blackthorn', 'Trapper', 'man', 'male', ['trainer'], 24, 36, 14,
    ['Every class can learn something from a trapper: patience, and where to put the sharp bit.', 'Coin for lessons. I have snares to buy.']);
  N('dodd', 'Sentry Dodd', 'Camp Sentry', 'man', 'male', ['guard'], 20, -30, -24,
    ['Staddle is west, the Inn is east, and the marsh is everywhere else.', 'If you hear a horn at night, that\'s me. If you hear two, run.']);
  N('meg', 'Old Meg', 'Herbalist', 'man', 'female', ['flavor'], 14, -4, 40,
    ['Kingsfoil grows in the marsh if you know the smell. Most folk only know the smell of the marsh.', 'A poultice for a copper. A cure for two. A miracle, I leave to the elves.']);
  N('pip', 'Whistler Pip', 'Hobbit Fiddler', 'hobbit', 'male', ['bard', 'flavor'], 12, 22, 26,
    ['~ Neeker-breeker, neeker-breeker, all the marshy night ~ — it\'s the only tune out here.', 'Came out to trade pipe-weed with the hunters. Stayed because the ale is free if you play.']);

  // ---- Tom Bombadil's House --------------------------------------------------------------------------------------------------
  at('tomshouse');
  N('tom', 'Tom Bombadil', 'Master of Wood, Water and Hill', 'man', 'male', ['questgiver'], 25, -6, 10,
    ['Hey dol! merry dol! ring a dong dillo! Old Tom Bombadil is a merry fellow!', 'Old Man Willow is grumbling and the Barrow-wights are singing cold songs on the Downs. Tom would like them quiet again.', 'Fear nothing! Tom is master here. Bring Goldberry a lily and she will tell you the rest.'], { hub: true });
  N('goldberry', 'Goldberry', 'The River-daughter', 'man', 'female', ['questgiver'], 25, -18, 12,
    ['Come, dear folk. Laugh and be merry — the wood is dark but the house is bright.', 'The Withywindle runs troubled. Something has stirred its sleep. Will you go and see?']);
  N('lost', 'Tobold Boffin', 'Lost Hobbit', 'hobbit', 'male', ['flavor'], 12, 26, -10,
    ['I only went in for mushrooms. The trees... moved.', 'Master Tom pulled me out of a willow. A WILLOW. I\'m not going back in.']);

  // ---- The Forsaken Inn ------------------------------------------------------------------------------------------------------
  at('forsakeninn');
  N('osric', 'Osric Duskwood', 'Wayfarer', 'man', 'male', ['questgiver'], 24, 8, 10,
    ['The Lone-lands are exactly what they sound like. That\'s why I like them.', 'Wargs on the road and orcs at Weathertop. Somebody should do something. Somebody with a sword.', 'Anlaf pays in ale; I pay in silver. Choose your employer.'], { hub: true });
  N('wyn', 'Wyn', 'Eglain Scout', 'man', 'female', ['questgiver'], 22, 30, 12,
    ['The Eglain hold Ost Guruth and little else. The little else is what I scout.', 'Goblins have taken the ruins north of the road. Care to take them back?']);
  N('anlaf', 'Anlaf the Forlorn', 'Keeper of the Forsaken Inn', 'man', 'male', ['innkeeper'], 20, 0, 0,
    ['The Forsaken Inn. Beds are damp, ale is flat, roof mostly holds. Welcome.', 'Rest here. Nobody\'s died in that bed for weeks.'], { inside: 0 });
  N('rusty', 'Rusty Yarrow', 'Fiddler', 'man', 'male', ['bard'], 18, 0, 0,
    ['~ The road goes ever on and on, down from the door where it began ~', 'Songs about home for people who haven\'t got one. It\'s a living.'], { inside: 0 });
  N('hilda', 'Hilda', 'Cook', 'man', 'female', ['vendor:food'], 18, 0, 0,
    ['Rabbit stew. It was rabbit yesterday, and it\'ll be rabbit tomorrow.', 'Eat. You\'ll need it out there.'], { inside: 0 });
  N('general', 'Gilby Tanner', 'Pedlar', 'man', 'male', ['vendor:general'], 20, -28, -8,
    ['Rope, lamp-oil, salt and bandages. Everything sells out here.', 'Prices are high. So is the chance you\'ll need it.']);
  N('stable', 'Aelfric Ostler', 'Stable-master', 'man', 'male', ['stablemaster'], 20, -22, 26,
    ['Bree to the west, Ost Guruth to the east. The horses know the way better than I do.', 'Ride at dawn; the wargs sleep late.']);
  N('oswin', 'Oswin', 'Eglain Guard', 'man', 'male', ['guard'], 26, 18, -10,
    ['Keep to the road and you\'ll probably live.', 'Weathertop is that way. So are the orcs.']);
  N('sam', 'Sam Twofoot', 'Pedlar', 'hobbit', 'male', ['flavor'], 15, 6, 30,
    ['A hobbit in the Lone-lands? Somebody\'s got to sell the pipe-weed.', 'The Eglain drive a hard bargain. I drive a harder pony.']);

  // ---- Ost Guruth ------------------------------------------------------------------------------------------------------------
  at('ostguruth');
  N('hunwald', 'Hunwald', 'Elder of the Eglain', 'man', 'male', ['questgiver'], 30, -8, -10,
    ['The Eglain ask nothing of the world and the world gives it gladly. Now the world sends orcs.', 'Ost Guruth is all we have. Help us keep it and you will have friends in the Lone-lands for life.', 'The Red Pass, the tarn, the ruins to the north — all of it crawling. Where will you start?'], { hub: true });
  N('candaith', 'Candaith', 'Ranger of Weathertop', 'dunedain', 'male', ['questgiver'], 32, 10, -14,
    ['I watch the Weather Hills for the Rangers. Lately there is more to watch than one man can manage.', 'Orcs of Angmar have set a camp beneath Amon Sûl. I would see it burned.']);
  N('grimwynn', 'Grimwynn', 'Eglain Huntress', 'man', 'female', ['questgiver'], 28, -40, -12,
    ['The wargs have an alpha, and the alpha has a taste for our goats.', 'Bring me its fang and the Eglain will call you kin.']);
  N('general', 'Hagar', 'Pedlar', 'man', 'male', ['vendor:general'], 26, -22, -38,
    ['Rope, torches, salt-meat, and whatever the last adventurer didn\'t come back for.', 'Ost Guruth prices. You\'re paying for the walls.']);
  N('armour', 'Ulfa', 'Leather-worker', 'man', 'female', ['vendor:armour'], 28, 22, -40,
    ['Boiled leather and patched mail. Nothing pretty, everything sturdy.', 'Warg-hide makes a good jerkin. Bring me some.']);
  N('wulfstan', 'Wulfstan', 'Smith', 'man', 'male', ['vendor:weapons'], 28, 40, -26,
    ['Iron from the old fort, reforged. Waste not.', 'Blades for the Lone-lands: heavy, ugly, effective.']);
  N('fenna', 'Fenna', 'Cook', 'man', 'female', ['vendor:food'], 24, -12, 8,
    ['Goat, goat, and more goat. The tarn gives perch on a good day.', 'Eat. The Lone-lands take more than they give.']);
  N('ordulf', 'Ordulf', 'Weapon-master', 'man', 'male', ['trainer'], 34, 30, -54,
    ['Fought at Fornost with the Rangers. Teach now. Cheaper than fighting.', 'Coin first. Then I show you how to hit things so they stay hit.']);
  N('stable', 'Osbert Horse-thane', 'Stable-master', 'man', 'male', ['stablemaster'], 26, 18, 22,
    ['Ponies west to the Inn, horses east to the Bridge. Nothing goes south into the tarn.', 'They\'re skittish. Wargs will do that.']);
  N('guard1', 'Dunstan', 'Eglain Watchman', 'man', 'male', ['guard'], 32, -46, 10,
    ['West wall\'s mine. Nothing gets past it but weather.', 'Don\'t drink from the tarn. Something lives in it.']);
  N('guard2', 'Leof', 'Eglain Watchman', 'man', 'male', ['guard'], 32, 56, 4,
    ['East road to the Last Bridge. Trolls past that. Real ones.', 'Eyes open, traveller.']);
  N('child', 'Wyn the Younger', 'Eglain Child', 'man', 'female', ['flavor'], 1, -30, 8,
    ['I found an arrowhead in the wall. It\'s older than Grandfather!', 'When I\'m big I\'m going to ride a warg. Grandfather says no. Grandfather says no to everything.']);
  N('orgrim', 'Orgrim', 'Skald', 'man', 'male', ['bard', 'flavor'], 27, 10, -40,
    ['~ Arnor is fallen, Arnor is fallen, and the stones remember her ~', 'Old songs for old walls. They keep each other standing.']);

  // ---- Trestlebridge ---------------------------------------------------------------------------------------------------------
  at('trestlebridge');
  N('reeve', 'Odo Trestlewood', 'Reeve of Trestlebridge', 'man', 'male', ['questgiver'], 30, 6, -16,
    ['The bridge is the town and the town is the bridge. Lose one and you lose both.', 'Orcs from Fornost have been testing the north bank. I need the Trestlespan held and the Downs scouted.', 'Do this and you\'ll drink free in Trestlebridge until you die. Try not to make that soon.'], { hub: true });
  N('captain', 'Wilfrid', 'Bridge-captain', 'man', 'male', ['questgiver'], 32, -26, -24,
    ['I have eight men and a bridge the enemy wants. The arithmetic is not in my favour.', 'Wargs at the gorge, orcs on the road, and a war-chief at Fornost who thinks he is a king.']);
  N('innkeeper', 'Nella Bridgewater', 'Keeper of the Trestlebridge Inn', 'man', 'female', ['innkeeper'], 28, 0, 0,
    ['The Trestlebridge Inn. We\'ve beds, ale, and a cellar deep enough to hide in.', 'Rest here. Your gear\'s safe with me, and so are you.'], { inside: 0 });
  N('bard', 'Ansel', 'Piper', 'man', 'male', ['bard'], 26, 0, 0,
    ['~ The Downs are green and the Downs are cold, and under them the kings lie old ~', 'Nobody dances any more. I play anyway.'], { inside: 0 });
  N('general', 'Cedric Hobble', 'Shopkeeper', 'man', 'male', ['vendor:general'], 26, -28, 0,
    ['Provisions for the Downs: rope, torches, salt, and a great deal of bandage.', 'The north road eats supplies. Stock up.']);
  N('smith', 'Gunnar Bridgeforge', 'Smith', 'man', 'male', ['vendor:weapons', 'vendor:armour'], 30, 2, -36,
    ['Blades and mail, forged by the gorge. The wind keeps the coals hot.', 'Orc-iron is rubbish. Mine isn\'t.']);
  N('food', 'Ada Oakenshaw', 'Cook', 'man', 'female', ['vendor:food'], 24, 12, 20,
    ['Mutton pies, hard bread, and Downs cheese that bites back.', 'Eat well; the Rangers say the North eats the hungry first.']);
  N('stable', 'Osric Reinhold', 'Stable-master', 'man', 'male', ['stablemaster'], 26, 34, -6,
    ['Bree to the south, Esteldín to the north-east, and the causeway west to Tinnudir.', 'The horses hate the bridge. Can\'t blame them.']);
  N('guard', 'Watchman Eadric', 'Bridge Watch', 'man', 'male', ['guard'], 34, 14, -32,
    ['Trestlespan\'s open. Mind the gaps — the last orc raid took planks with it.', 'Nothing crosses at night without my say.']);
  N('child', 'Pip Boskins', 'Boy', 'man', 'male', ['flavor'], 1, 0, 30,
    ['I dropped a stone off the bridge and counted to nine before it hit. Nine!', 'When I\'m big I\'m going to be a Ranger. Or a bridge.']);
  N('farmer', 'Goodman Wyatt', 'Farmer', 'man', 'male', ['flavor'], 22, -14, 40,
    ['Fields to the south, wolves to the north. Every year the wolves get closer.', 'If you\'re heading for the Downs, take a friend. Take three.']);

  // ---- Esteldín --------------------------------------------------------------------------------------------------------------
  at('esteldin');
  N('halbarad', 'Halbarad', 'Captain of the Rangers', 'dunedain', 'male', ['questgiver'], 40, -4, -30,
    ['Esteldín is hidden. It must stay hidden. Everyone who finds it either joins us or does not leave.', 'Angmar sends war-bands down from Fornost and wights walk the old fields. We hold what we can.', 'You have come far. Come a little farther, for the North.'], { hub: true });
  N('meneldir', 'Meneldir', 'Ranger', 'dunedain', 'male', ['questgiver'], 36, -40, 20,
    ['The orcs of Dol Dínen have a new captain and old grudges.', 'I need eyes on the Nan Amlug fields. Yours will do.']);
  N('berethor', 'Berethor', 'Lore-warden', 'dunedain', 'male', ['questgiver'], 34, -36, -24,
    ['The ruins of Fornost hold records of the last kings. Also wights, which hold grudges.', 'Bring me what the tomb-robbers leave behind. They only take the gold.']);
  N('general', 'Rhael', 'Quartermaster', 'dunedain', 'female', ['vendor:general'], 32, 10, 26,
    ['Supplies for the Rangers, and for their friends. You count as a friend, for now.', 'Rope, oil, salt, and arrows by the bundle.']);
  N('armour', 'Ellinor', 'Leather-wright', 'man', 'female', ['vendor:armour'], 32, 10, 4,
    ['Ranger-grey leathers, mail that doesn\'t rattle, cloaks that don\'t catch the eye.', 'Fit matters more than weight. Try it on.']);
  N('weapons', 'Doron', 'Smith', 'dunedain', 'male', ['vendor:weapons'], 34, -6, -48,
    ['Blades in the old Númenórean pattern. Long, straight, and unforgiving.', 'I sharpen for Rangers. I sell to those they trust.']);
  N('food', 'Mirwen', 'Cook', 'dunedain', 'female', ['vendor:food'], 28, -16, -24,
    ['Venison stew and Downs bread. Eat, then sleep, then fight.', 'The pot never empties. It is the only magic Esteldín has.']);
  N('trainer', 'Dagoreth', 'Weapon-master', 'dunedain', 'male', ['trainer'], 42, -50, 10,
    ['We train every class here. The North does not care how you kill an orc, only that you do.', 'Gold to the Rangers\' chest; skill to your hands.']);
  N('stable', 'Faelon', 'Horse-master', 'dunedain', 'male', ['stablemaster'], 30, 16, 44,
    ['Swift horses to Trestlebridge, Aughaire and beyond. The Rangers ride light.', 'Speak softly near the lines. They spook at orc-scent.']);
  N('guard1', 'Bregol', 'Ranger Sentry', 'dunedain', 'male', ['guard'], 38, -52, 30,
    ['You found the valley. Good. Now forget where it is.', 'The south path is watched by three of us. You saw one.']);
  N('guard2', 'Tadion', 'Ranger Sentry', 'dunedain', 'male', ['guard'], 38, 54, -36,
    ['The north path leads to Aughaire and Angmar. Only one of those is worth visiting.', 'Move quietly. The Downs carry sound.']);
  N('recruit', 'Aldan', 'Ranger Recruit', 'man', 'male', ['flavor'], 20, -2, 44,
    ['Three months a Ranger and I still can\'t light a fire in the rain.', 'Halbarad says a Ranger is patience with a sword. I\'m mostly the sword part so far.']);

  // ---- Tinnudir --------------------------------------------------------------------------------------------------------------
  at('tinnudir');
  N('captain', 'Tarondor', 'Ranger-captain of Tinnudir', 'dunedain', 'male', ['questgiver'], 42, 0, -24,
    ['Annúminas was the city of Elendil. Now it is a quarry for tomb-robbers and a den for worse.', 'From this isle we watch the lake. What we see, we do not like.', 'The kings are gone, but their honour is not. Help me keep it.'], { hub: true });
  N('ninias', 'Ninias', 'Lore-master', 'elf', 'male', ['questgiver'], 40, -28, 0,
    ['The lake hides more than fish. There are stones on the bottom that were once thrones.', 'The tomb-robbers work for someone. Someone who reads the old tongue.']);
  N('nengel', 'Nengel', 'Lake-fisher', 'man', 'female', ['questgiver'], 36, -56, 30,
    ['Nenuial gives golden perch to the patient and lake-crawlers to the careless.', 'Something big is under the causeway. Bigger than a pike.']);
  N('general', 'Gwathol', 'Quartermaster', 'dunedain', 'male', ['vendor:general'], 38, 26, -8,
    ['Supplies come over the causeway once a week. Buy what you need before they run out.', 'Lamp-oil, rope, and Ranger-bread that keeps for a month.']);
  N('armour', 'Hirion', 'Armourer', 'dunedain', 'male', ['vendor:armour'], 40, -8, -30,
    ['Mail salvaged from the ruins and reforged. The old smiths knew their work.', 'Annúminas-pattern steel, if you can afford it.']);
  N('weapons', 'Angbor', 'Smith', 'man', 'male', ['vendor:weapons'], 40, 12, -30,
    ['Blades, spears, and bows for the lake-shore.', 'Bring me ancient iron from the ruins and I\'ll make something worth carrying.']);
  N('food', 'Elwen', 'Cook', 'dunedain', 'female', ['vendor:food'], 34, -10, 14,
    ['Perch, pike, and whatever the hunters bring in from Emyn Uial.', 'Sit by the fire. The lake wind gets into the bones.']);
  N('trainer', 'Baranor', 'Weapon-master', 'dunedain', 'male', ['trainer'], 46, 34, -34,
    ['I trained under the Chieftain himself. Now I train you. Life is a river.', 'Coin for craft. Every class, every weapon.']);
  N('stable', 'Idhren', 'Horse-master', 'dunedain', 'female', ['stablemaster'], 36, 18, 34,
    ['Horses across the causeway to Trestlebridge, and north to Sûri-kylä if you\'re mad enough.', 'Don\'t gallop the causeway. It\'s narrower than it looks.']);
  N('boat', 'Haldan', 'Boat-master', 'man', 'male', ['boatmaster'], 38, 0, 0,
    ['Tinnudir Quay. Down the lake, up the river, and out into the northern bay to Forochel. Long trip, cold end.', 'Ice-bay Landing\'s the other side. Wear something warm.'], { dock: 'dock_tinnudir' });
  N('guard', 'Dorlas', 'Ranger Sentry', 'dunedain', 'male', ['guard'], 42, 56, -16,
    ['Causeway\'s clear. For now.', 'Tomb-robbers tried the isle by boat last month. They\'re still in the lake.']);
  N('apprentice', 'Pell', 'Scholar\'s Apprentice', 'man', 'male', ['flavor'], 30, -24, 44,
    ['Master Ninias has me copying inscriptions. Six hundred years of inscriptions.', 'Did you know the kings had their own alphabet? I do. Now.']);
  N('rumil', 'Old Rúmil', 'Fisherman', 'man', 'male', ['flavor'], 33, 10, 60,
    ['Forty years fishing this lake. Never caught the golden perch. Never will. Don\'t care.', 'The lake\'s deeper than the Downs are high. Think on that.']);

  // ---- Rivendell -------------------------------------------------------------------------------------------------------------
  at('rivendell');
  N('elrond', 'Elrond', 'Master of Rivendell', 'highelf', 'male', ['questgiver'], 60, 20, -8,
    ['Welcome to the Last Homely House east of the Sea. Here you may rest — for a while.', 'The Shadow lengthens in Angmar and the goblins of the mountains grow bold. I have counsel, and tasks, for those who will hear them.', 'Hope is not a plan. But it is where every plan begins.'], { hub: true });
  N('gandalf', 'Gandalf', 'The Grey Pilgrim', 'man', 'male', ['questgiver'], 60, 0, 0,
    ['A wizard is never late, nor is he early. He arrives precisely when he means to — and I mean to speak with you.', 'There is a sorcerer in Carn Dûm who thinks the Witch-king left him a kingdom. He is mistaken, and I would have him told.', 'Do not be too eager to deal out death in judgement. Be quite eager to deal it to trolls, though.'], { inside: 1 });
  N('bilbo', 'Bilbo Baggins', 'Poet', 'hobbit', 'male', ['bard', 'flavor'], 60, 0, 0,
    ['~ The Road goes ever on and on ~ — I wrote that, you know. Well, I wrote it down.', 'I am writing a book. It\'s about me, mostly. Everyone says it will never sell.'], { inside: 1 });
  N('glorfindel', 'Glorfindel', 'Lord of the House of the Golden Flower', 'highelf', 'male', ['questgiver'], 60, -20, -40,
    ['The trolls of the Shaws have a chief now, and a chief makes them dangerous.', 'Ride with me to the Ford and I will show you how a Balrog-slayer fights. Mostly from a distance, these days.']);
  N('counsellor', 'Idhrenion', 'Counsellor of Elrond', 'elf', 'male', ['questgiver'], 55, -20, -80,
    ['The Council has questions about Himling. The dead do not gather without a reason.', 'Bring me what you find on the Sundered Isles and I will tell you what it means.']);
  N('innkeeper', 'Meluiel', 'Keeper of the Guest-house', 'elf', 'female', ['innkeeper'], 50, 0, 0,
    ['The Guest-house of Imladris. Rest as long as you need; time runs differently here.', 'Sleep. Your gear will be where you left it, and probably cleaner.'], { inside: 2 });
  N('lindir', 'Lindir', 'Singer of the Hall of Fire', 'elf', 'male', ['bard'], 50, 0, 0,
    ['~ Eärendil was a mariner that tarried in Arvernien ~', 'Mortals\' songs go by so quickly. Like sheep. All alike.'], { inside: 2 });
  N('general', 'Caladwen', 'Provisioner', 'elf', 'female', ['vendor:general'], 48, -60, 22,
    ['Travelling-goods for the mountain roads. Lanterns, rope, miruvor for those who can pay.', 'Buy warm. The High Pass does not forgive.']);
  N('armour', 'Dúrion', 'Armourer', 'elf', 'male', ['vendor:armour'], 50, -76, -4,
    ['Elven mail, light as a thought and twice as hard to catch.', 'The Armoury of Imladris has outfitted three Ages of heroes. Four, if you count yourself.']);
  N('weapons', 'Nardol', 'Smith', 'elf', 'male', ['vendor:weapons'], 50, -40, -58,
    ['Blades of Eregion pattern, bows of Lórien yew.', 'I reforged a broken sword once. Ask me nothing more.']);
  N('food', 'Silivren', 'Keeper of the Larder', 'elf', 'female', ['vendor:food'], 45, -14, 28,
    ['Bread, honey, fruit of the valley, and a wine older than Bree.', 'Eat in the garden. The waterfalls are good company.']);
  N('trainer', 'Tirion', 'Weapon-master', 'highelf', 'male', ['trainer'], 62, 60, -72,
    ['I fought at the Last Alliance. You may learn from me, if you are quick.', 'Every class, every art. Gold to the House; the House feeds many.']);
  N('stable', 'Rochon', 'Horse-master', 'elf', 'male', ['stablemaster'], 48, -40, 62,
    ['Horses west to the Last Bridge and north to the High Crag. Elf-horses need no reins; try not to insult them.', 'Asfaloth is not for hire. Do not ask.']);
  N('guard1', 'Elemmírë', 'Warden of the Valley', 'elf', 'female', ['guard'], 55, -6, -20,
    ['Peace, friend. The valley is warded; nothing evil enters here.', 'The Ford of Bruinen is Elrond\'s to command. You would do well to remember it.']);
  N('guard2', 'Gilrin', 'Warden of the Valley', 'elf', 'male', ['guard'], 55, 24, 64,
    ['The gardens are open to guests. The library is open to the quiet.', 'Trolls at the valley\'s mouth again. They never learn; that is what makes them trolls.']);
  N('arwen', 'Arwen', 'Undómiel', 'highelf', 'female', ['flavor'], 60, 50, 20,
    ['The evening-star rises over the valley. It always has.', 'My father worries. It is what fathers do. I sew, and wait, and worry in my own fashion.']);
  N('bofri', 'Bofri', 'Dwarf-envoy of Thorin\'s Hall', 'dwarf', 'male', ['flavor'], 45, 36, 30,
    ['Elves! Elves everywhere. And the beds are too long.', 'Dwalin sends greetings and a bill. Mostly a bill.']);
  N('elrohir', 'Elrohir', 'Son of Elrond', 'highelf', 'male', ['flavor'], 60, -30, -14,
    ['My brother and I ride against the orcs of the mountains. Care to come? We ride at dawn — every dawn.', 'Glorfindel says trolls are slow. Glorfindel is faster than anything; his opinion is not useful.']);

  // ---- Thorenhad -------------------------------------------------------------------------------------------------------------
  at('thorenhad');
  N('captain', 'Berenon', 'Ranger-captain of Thorenhad', 'dunedain', 'male', ['questgiver'], 45, -2, 8,
    ['The Last Bridge is the only road into the Shaws, and I hold it with a dozen men and a fire.', 'Trolls by night, hill-men by day, and something in the caves that is neither.', 'Help us keep the road open and Rivendell will hear your name.'], { hub: true });
  N('hathlaf', 'Hathlaf', 'Ranger', 'dunedain', 'male', ['questgiver'], 44, 4, -26,
    ['Three stone trolls stand in a clearing north of here. The live ones are the problem.', 'The hill-men of Rhudaur have been raiding the bridge-road. Find their camp.']);
  N('general', 'Hallas', 'Quartermaster', 'dunedain', 'male', ['vendor:general'], 42, 14, 26,
    ['Provisions come over the bridge from Ost Guruth — when the road is open.', 'Torches. Buy torches. Trolls hate them.']);
  N('stable', 'Belec', 'Horse-master', 'dunedain', 'male', ['stablemaster'], 42, 6, 34,
    ['West over the bridge, east to Rivendell, north-east to the High Crag.', 'They know the troll-holes better than the Rangers do.']);
  N('guard', 'Tarcil', 'Ranger Sentry', 'dunedain', 'male', ['guard'], 46, 30, -6,
    ['Stay near the fire after dark. Trolls are afraid of it. Also of Glorfindel, but he is not here.', 'Nothing crosses the Last Bridge at night. Nothing we can see, anyway.']);
  N('wounded', 'Aradan', 'Wounded Ranger', 'dunedain', 'male', ['flavor'], 40, -2, -28,
    ['Troll-club. I got the better of the exchange: I am still here, the troll is a rock.', 'Tell Berenon the caves by the river go deeper than we thought.']);

  // ---- The High Crag ---------------------------------------------------------------------------------------------------------
  at('highcrag');
  N('gloin', 'Glóin', 'Son of Gróin', 'dwarf', 'male', ['questgiver'], 55, 4, -20,
    ['Glóin, at your service. Aye, THAT Glóin. The dragon was a long time ago and I\'ve a goblin-town to worry about now.', 'Goblins in the deeps, giants on the heights, and drakes in between. A dwarf could not ask for better sport.', 'Do this for the Longbeards and the Longbeards will do right by you.'], { hub: true });
  N('nimwen', 'Nimwen', 'Elf-scout', 'elf', 'female', ['questgiver'], 52, -30, -8,
    ['The Front Porch of Goblin-town is east of here. They have a king again.', 'I have counted the drakes on the Giant\'s Stair. There is one too many.']);
  N('general', 'Hafdis', 'Trader', 'dwarf', 'female', ['vendor:general'], 50, 18, 12,
    ['Rope, pitons, lamp-oil, and cold-weather gear. Mountain prices.', 'Everything up here was carried up here. Remember that when you see the bill.']);
  N('smith', 'Hannar', 'Dwarf-smith', 'dwarf', 'male', ['vendor:weapons', 'vendor:armour'], 54, -12, -30,
    ['Weapons and mail, hammered in the cold. The steel likes it.', 'Goblin-town iron is rubbish. Giant-hide, on the other hand...']);
  N('stable', 'Ketil', 'Goat-master', 'dwarf', 'male', ['stablemaster'], 48, 16, -40,
    ['Goats to Thorenhad and Rivendell. They do not like the word horse; do not use it.', 'Sure-footed, foul-tempered, faster than they look.']);
  N('guard', 'Vigdis', 'Sentry', 'dwarf', 'female', ['guard'], 56, -30, 28,
    ['The path from Rivendell is watched. The one from Goblin-town is watched harder.', 'Giants throw rocks at dawn. Stay under the ledge.']);
  N('brok', 'Brók', 'Skald', 'dwarf', 'male', ['bard', 'flavor'], 50, 30, -8,
    ['~ The wind was on the withered heath, but in the forest stirred no leaf ~', 'Songs keep the fingers warm. Mostly.']);

  // ---- Aughaire --------------------------------------------------------------------------------------------------------------
  at('aughaire');
  N('crannog', 'Crannog', 'Chieftain of the Trév Gállorg', 'man', 'male', ['questgiver'], 60, 0, -22,
    ['The hillmen of Aughaire bent the knee to Angmar once. Never again.', 'Carn Dûm sends orcs, wargs, and worse to remind us who we served. We remind them who we are.', 'Fight beside us and you are Trév Gállorg. Betray us and the bogs are wide.'], { hub: true });
  N('breanna', 'Bréanna', 'Wise-woman', 'man', 'female', ['questgiver'], 58, -8, 42,
    ['The standing stone speaks when the moon is dark. Lately it screams.', 'Bring me the ashes of a gaunt-wight and I will read them.']);
  N('duald', 'Duald', 'Hillman Scout', 'man', 'male', ['questgiver'], 57, 38, 12,
    ['I have crawled to the walls of Carn Dûm and back. Twice. I will not go a third time alone.', 'The uruks camp at Himbar. Their captain wears a helm of our make.']);
  N('bronach', 'Brónach', 'Trader', 'man', 'female', ['vendor:general', 'vendor:food'], 55, -24, 4,
    ['Meat, bread, rope, oil. What the bogs allow.', 'Coin, hides, or teeth. I take all three.']);
  N('fergal', 'Fergal', 'Smith', 'man', 'male', ['vendor:weapons', 'vendor:armour'], 58, 36, -16,
    ['Hillman iron — heavy, plain, and it has killed more orcs than any elf-blade.', 'Bring me uruk-helms. I re-forge them into something honest.']);
  N('muirne', 'Muirne', 'War-leader', 'man', 'female', ['trainer'], 63, -26, -14,
    ['I teach the hillman way: strike first, strike hard, and leave nothing standing.', 'Any class, any weapon. Gold for the war-chest.']);
  N('stable', 'Lorcan', 'Horse-thane', 'man', 'male', ['stablemaster'], 55, 40, 44,
    ['Ponies south to Esteldín and north to the ice. Nothing goes east. Nothing comes back from east.', 'Talk soft. They can smell Angmar.']);
  N('guard', 'Tadhg', 'Hillman Guard', 'man', 'male', ['guard'], 62, -38, 14,
    ['The palisade held last winter. It will hold this one.', 'Rammas Deluon is south. Beyond it, you\'re on your own.']);
  N('child', 'Aoife', 'Hillman Child', 'man', 'female', ['flavor'], 1, 4, 20,
    ['Grandmother says the stone talks. I put my ear on it. It\'s cold.', 'Are you going to Carn Dûm? Bring me back a crown.']);

  // ---- Sûri-kylä -------------------------------------------------------------------------------------------------------------
  at('surikyla');
  N('yrjo', 'Yrjö', 'Elder of Sûri-kylä', 'man', 'male', ['questgiver'], 66, 0, -20,
    ['The Lossoth remember the Witch-king. We remember the king who fled him, too. We remember everything; the ice forgets nothing.', 'The white bears have a matriarch this year, and she has learned to hunt Men.', 'Help the Lossoth and the Lossoth will give you a name. Fail, and the ice will give you another.'], { hub: true });
  N('vaino', 'Väinö', 'Hunter', 'man', 'male', ['questgiver'], 64, -22, -32,
    ['Seal on the ice, snow-lynx in the pines, and drakes on the glacier. Only one of those is dinner.', 'The Gauredain raid the eastern camps. Bring me their spears.']);
  N('tuula', 'Tuula', 'Wise-woman', 'man', 'female', ['questgiver'], 65, 24, -40,
    ['The Ice-altar has been waking. Something under the bay answers it.', 'Old stories say a ship of the Dúnedain lies under the ice. Old stories are usually true, here.']);
  N('aino', 'Aino', 'Keeper of the Long-house', 'man', 'female', ['innkeeper'], 62, 0, 0,
    ['The Long-house of Sûri-kylä. Fire, furs and fish-stew — the only warm room for two hundred miles.', 'Sleep by the fire. The Lossoth keep their guests.'], { inside: 0 });
  N('kalevi', 'Kalevi', 'Rune-singer', 'man', 'male', ['bard'], 60, 0, 0,
    ['~ Over the ice the moon is white and the bear walks alone ~', 'Every song of the Lossoth is about ice. Some of them are also about bears.'], { inside: 0 });
  N('pekka', 'Pekka', 'Trader', 'man', 'male', ['vendor:general'], 60, -24, -4,
    ['Furs, rope, oil, seal-fat. Everything that keeps a body alive up here.', 'The mainland pays gold for white fur. We pay in warmth.']);
  N('marja', 'Marja', 'Fish-wife', 'man', 'female', ['vendor:food'], 58, -4, 42,
    ['Char, cod, and stew that\'ll put ice in your beard and fire in your belly.', 'Eat. The cold takes the thin ones first.']);
  N('onni', 'Onni', 'Net-maker', 'man', 'male', ['vendor:fishing'], 58, -44, -16,
    ['Ice-hooks, bone lures, sinew lines. The char run under the bay-ice.', 'Fish the Ice-bay at dawn. Anything later and the bears fish you.']);
  N('ukko', 'Ukko', 'Spear-master', 'man', 'male', ['trainer'], 68, 40, -6,
    ['The Lossoth fight with spear and patience. I will teach you both — and whatever else you carry.', 'Gold for the village; skill for you.']);
  N('lauri', 'Lauri', 'Reindeer-herder', 'man', 'male', ['stablemaster'], 60, -16, -52,
    ['Reindeer south to Aughaire, and the long cold road to Tinnudir.', 'They are steadier than horses on the ice and ruder about it.']);
  N('boat', 'Sampo', 'Ice-pilot', 'man', 'male', ['boatmaster'], 62, 0, 0,
    ['Ice-bay Landing. One route: out past the floes, down the bay and the river, into Lake Evendim to Tinnudir Quay.', 'Wear your furs. The bay does not care that you are a hero.'], { dock: 'dock_forochel' });
  N('eero', 'Eero', 'Lossoth Spearman', 'man', 'male', ['guard'], 66, 36, 34,
    ['Nothing comes up the Aughaire road that we do not see.', 'Ice-bears at the pines. Do not go alone.']);
  N('aila', 'Aila', 'Lossoth Child', 'man', 'female', ['flavor'], 1, 14, -28,
    ['I saw the lights in the sky last night. Grandmother says they are the dead dancing. They looked happy.', 'Have you ever eaten seal? It\'s better than it sounds. A little.']);

  // ---- Ost Fuin --------------------------------------------------------------------------------------------------------------
  at('ostfuin');
  N('lord', 'Anardil', 'Lord of Ost Fuin', 'highelf', 'male', ['questgiver'], 70, 0, -24,
    ['Welcome to Ost Fuin, all that remains above the sea of the land of Beleriand. Tread softly; you walk on graves older than Númenor.', 'The serpent hunts our fishers, orc-raiders hold the northern ruins, and something on Himling is calling to the dead.', 'The Sundered Isles are the last chapter of a long story. Help us write its ending.'], { hub: true });
  N('eirien', 'Eirien', 'Sea-warden', 'elf', 'female', ['questgiver'], 68, 36, -14,
    ['I have watched the serpent for a hundred years. It has grown. So has my patience.', 'The raiders came from the east on black ships. Someone is paying them.']);
  N('ercasse', 'Ercassë', 'Lore-master', 'highelf', 'female', ['questgiver'], 67, -30, -50,
    ['The stones of the western ruins bear the script of Gondolin. I would read them before the sea takes them.', 'Bring me what the orcs have dug up. They know not what they hold.']);
  N('innkeeper', 'Aerlinn', 'Keeper of the House of the Sea-wanderers', 'elf', 'female', ['innkeeper'], 65, 0, 0,
    ['Rest here, traveller. The House of the Sea-wanderers has sheltered mariners since the Drowning.', 'Sleep. The sea sings all night; you will grow used to it.'], { inside: 1 });
  N('harper', 'Sailathiel', 'Harper', 'elf', 'female', ['bard'], 64, 0, 0,
    ['~ Beleriand is drowned, drowned, and the stars look down on water ~', 'Every song here is a lament. It is that kind of island.'], { inside: 1 });
  N('general', 'Faron', 'Provisioner', 'elf', 'male', ['vendor:general'], 64, -36, -20,
    ['Rope, lamps, cordial, and salt from the drowned marshes.', 'Supplies come with the ships from Celondim. So do the rumours.']);
  N('armour', 'Lachon', 'Armourer', 'elf', 'male', ['vendor:armour'], 68, 46, -44,
    ['Mail of the Havens, wrought for the last wars of the Isles.', 'The serpent\'s scales turn any blade. They also make excellent shields.']);
  N('weapons', 'Thalion', 'Smith', 'elf', 'male', ['vendor:weapons'], 68, 26, -52,
    ['Blades in the fashion of Gondolin. Long memories, long swords.', 'Bring me serpent-scale and I will show you what I can really do.']);
  N('food', 'Rîn', 'Larder-keeper', 'elf', 'female', ['vendor:food'], 62, 12, 30,
    ['Sea-bread, shellfish, and honey from the mallorn-groves.', 'Eat what the sea gives. It gives grudgingly, here.']);
  N('fishing', 'Sírwen', 'Net-mender', 'elf', 'female', ['vendor:fishing'], 62, -52, 26,
    ['Lines and lures for the western coves. The mackerel run thick at the Serpent\'s Cove — if you dare.', 'Fish the south beach. It\'s the only shore the serpent does not patrol.']);
  N('trainer', 'Herudir', 'Blade-master', 'highelf', 'male', ['trainer'], 72, -20, -56,
    ['I learned the sword in Gondolin. You will learn it here, faster and with fewer Balrogs.', 'Any class, any weapon. Gold to the Haven.']);
  N('boat', 'Eärion', 'Mariner', 'elf', 'male', ['boatmaster'], 66, 0, 0,
    ['The Quay of Ost Fuin. East to Celondim or Duillond; south to Ras Himling on the Isle of the Dead.', 'The serpent has never taken a ship of ours. There is always a first time.'], { dock: 'dock_tolfuin' });
  N('guard', 'Tuilin', 'Warden of the Haven', 'elf', 'male', ['guard'], 70, 0, 44,
    ['The haven is warded. The ruins are not. Choose your walks accordingly.', 'Orc-raiders to the north. They do not come within sight of the towers.']);
  N('berion', 'Berion', 'Shipwrecked Mariner', 'man', 'male', ['flavor'], 60, -12, 60,
    ['My ship went down off Himling. I saw lights on the shore that were not fires.', 'The elves are kind. But they look at me like I am already a memory.']);
  N('lotiel', 'Lótiel', 'Young Elf', 'elf', 'female', ['flavor'], 5, 30, 30,
    ['I was born here, on the last of Beleriand. I have never seen a forest that was not an island.', 'The mariners say the mainland is enormous. I don\'t believe them.']);

  // ---- Ras Himling -----------------------------------------------------------------------------------------------------------
  at('rashimling');
  N('captain', 'Elendur', 'Captain of the Free Peoples', 'dunedain', 'male', ['questgiver'], 78, 0, 20,
    ['This is the last camp before the end. Himring stands on the hill above us, and Draugmar the Gaunt-lord sits in its ruin.', 'He is raising the dead of three Ages. We have a few hundred of the living. I like our odds; I have to.', 'Everything you have done in Eriador has led you to this beach. Finish it.'], { hub: true });
  N('ormar', 'Ormar', 'Dwarf-sapper', 'stoutaxe', 'male', ['questgiver'], 76, -12, -30,
    ['The fortress walls have a weakness. I know it; I need someone to survive reaching it.', 'Gaunt-wights in the barrows east of here. They guard something.']);
  N('meldis', 'Meldis', 'Seer', 'highelf', 'female', ['questgiver'], 77, 12, -32,
    ['I see the Gaunt-lord in every dream. He sees me too. We are not friends.', 'The altar south of the camp feeds him. Break it.']);
  N('quartermaster', 'Hallam', 'Quartermaster', 'man', 'male', ['vendor:general', 'vendor:food'], 74, -14, 4,
    ['Everything comes by ship from Ost Fuin. When the serpent lets it.', 'Rations, rope, oil, bandages. Eat, then fight, then eat again.']);
  N('smith', 'Brokk', 'Field-smith', 'stoutaxe', 'male', ['vendor:weapons', 'vendor:armour'], 76, 34, 2,
    ['I repair what Himring breaks. It breaks a great deal.', 'Uruk-helms, drake-scale, gaunt-bone — bring me materials and I will forge you the end of the world.']);
  N('trainer', 'Ulfhild', 'Battle-master', 'rohirrim', 'female', ['trainer'], 80, -30, -4,
    ['I rode from the Mark to fight the dead. Learn from me and you might ride home.', 'Every class, every art, no mercy. Gold to the camp.']);
  N('boat', 'Halvard', 'Boat-master', 'man', 'male', ['boatmaster'], 74, 0, 0,
    ['Ras Himling Landing. North to Ost Fuin, south to Morwen Harbour. Nobody sails east; there is no east here.', 'If the fortress falls, we sail home. If we fall, sail anyway.'], { dock: 'dock_himling' });
  N('guard', 'Hereward', 'Sentry', 'rohirrim', 'male', ['guard'], 78, 18, -6,
    ['Wargs come down from the hill at dusk. Uruks at midnight. The dead whenever they like.', 'Stay inside the walls. Such as they are.']);
  N('wounded', 'Osbeorn', 'Wounded Soldier', 'man', 'male', ['flavor'], 72, -8, 26,
    ['A wight touched me. Just touched. I have not been warm since.', 'Tell the captain the north barrows are open. All of them.']);

  // ---- Morwen Village --------------------------------------------------------------------------------------------------------
  at('morwenvillage');
  N('elder', 'Hulda Stonewick', 'Elder of Morwen Village', 'man', 'female', ['questgiver'], 64, 0, -16,
    ['We are fisher-folk. We came here when the mainland got too crowded with kings and wars, and we found the graves of older kings waiting.', 'Wreckers on the south shore, drowned things in the north barrows, and boars in the barley. Pick one.', 'Do right by the village and there\'ll always be a bed at the Drowned Bell.'], { hub: true });
  N('sigwald', 'Old Sigwald', 'Fisherman', 'man', 'male', ['questgiver'], 62, 36, -26,
    ['The wreckers light false fires on the headland. Three boats lost this year.', 'Bring me their captain\'s lantern and I\'ll teach you where the sturgeon lie.']);
  N('ashild', 'Widow Ashild', 'Keeper of the Stone', 'man', 'female', ['questgiver'], 61, -24, 30,
    ['I lay flowers at the Stone of the Hapless every morning. Lately something has been taking them.', 'Túrin and Morwen sleep under that stone. Let them sleep.']);
  N('innkeeper', 'Brand Wavecrest', 'Keeper of the Drowned Bell', 'man', 'male', ['innkeeper'], 60, 0, 0,
    ['The Drowned Bell — the bell\'s at the bottom of the harbour and the ale\'s on the bar.', 'Rest here. Nobody\'s sunk in these beds yet.'], { inside: 0 });
  N('ylva', 'Ylva', 'Singer', 'man', 'female', ['bard'], 58, 0, 0,
    ['~ The children of Húrin sleep beneath the stone, and the sea keeps their names ~', 'Drinking-songs downstairs, laments upstairs. Choose your floor.'], { inside: 0 });
  N('askel', 'Askel', 'Net & Hook', 'man', 'male', ['vendor:fishing'], 60, 20, -4,
    ['Hooks, lines, lures, and a rod that survived the wreck of the Grey Gull.', 'Fish the harbour at dusk. The sturgeon come in with the tide.']);
  N('runa', 'Runa', 'Chandler', 'man', 'female', ['vendor:general'], 58, -8, 32,
    ['Rope, tar, lamps and lamp-oil. Everything a boat needs and a few things a hero does.', 'The mainland ships come twice a month. Everything else we make.']);
  N('gerd', 'Gerd', 'Cook', 'man', 'female', ['vendor:food'], 56, 14, 30,
    ['Fish stew, fish pie, fish bread. We are a fishing village.', 'Boar sausage, when the hunters get lucky.']);
  N('boat', 'Ingolf', 'Harbour-master', 'man', 'male', ['boatmaster'], 60, 0, 0,
    ['Morwen Harbour. North to Ras Himling, east across the sea to Celondim.', 'Fair winds, mostly. Foul ones off Himling.'], { dock: 'dock_morwen' });
  N('guard', 'Einar', 'Harbour-watch', 'man', 'male', ['guard'], 64, 44, -4,
    ['Wreckers keep to the south cliffs. The north barrows keep to themselves — mostly.', 'Mind the boars on the barley road.']);
  N('inga', 'Inga', 'Fisher-lass', 'man', 'female', ['flavor'], 1, 10, 14,
    ['I caught a crab as big as my head! Then it caught me.', 'Grandpa says there\'s a serpent off Tol Fuin. I want to see it. From far away.']);
  N('hakon', 'Hakon', 'Old Sailor', 'man', 'male', ['flavor'], 58, -30, -6,
    ['Sailed to Himling once. Came back once. That\'s the trick.', 'The wreckers weren\'t always wreckers. Hard winters make hard men.']);

  // ---------------------------------------------------------------- monster types --------------------------------------------
  // Per-family base multipliers; M(level, family) → base numbers, MT() applies elite/boss scaling and overrides.
  const FAM = {
    wolf:           { hp: 0.85, dmg: 1.00, arm: 0.6, speed: 7.5, size: 1.0, color: 0x8a8378, aggro: 14, loot: 'mat_wolf_pelt', ability: null },
    boar:           { hp: 1.00, dmg: 0.90, arm: 0.8, speed: 6.5, size: 0.9, color: 0x5e4a36, aggro: 10, loot: 'mat_boar_hide', ability: 'boar_charge' },
    bear:           { hp: 1.50, dmg: 1.25, arm: 0.9, speed: 6.0, size: 1.5, color: 0x4a3626, aggro: 12, loot: 'mat_bear_pelt', ability: 'bear_maul' },
    spider:         { hp: 0.80, dmg: 1.05, arm: 0.5, speed: 7.0, size: 1.0, color: 0x3a3a3a, aggro: 12, loot: 'mat_spider_silk', ability: 'spider_venom' },
    goblin:         { hp: 0.80, dmg: 0.95, arm: 0.7, speed: 6.5, size: 0.8, color: 0x6a7a3a, aggro: 15, loot: 'junk_goblin_ear', ability: 'goblin_poison_arrow' },
    orc:            { hp: 1.10, dmg: 1.10, arm: 1.0, speed: 6.0, size: 1.05, color: 0x4f5a3a, aggro: 15, loot: 'junk_orc_tooth', ability: 'orc_cleave' },
    brigand:        { hp: 1.00, dmg: 1.00, arm: 0.9, speed: 6.2, size: 1.0, color: 0x6b5a48, aggro: 14, loot: 'junk_bent_coin', ability: 'brigand_throw' },
    troll:          { hp: 2.40, dmg: 1.60, arm: 1.2, speed: 5.5, size: 2.2, color: 0x6e6a5a, aggro: 13, loot: 'mat_troll_hide', ability: 'troll_smash' },
    wight:          { hp: 1.20, dmg: 1.15, arm: 0.8, speed: 5.5, size: 1.05, color: 0x9aa8a0, aggro: 13, loot: 'junk_barrow_relic', ability: 'wight_drain' },
    bat:            { hp: 0.60, dmg: 0.80, arm: 0.3, speed: 8.5, size: 0.6, color: 0x3a2e3a, aggro: 12, loot: 'junk_bat_wing', ability: null },
    warg:           { hp: 1.05, dmg: 1.15, arm: 0.7, speed: 8.0, size: 1.25, color: 0x5a4f46, aggro: 16, loot: 'mat_warg_hide', ability: 'warg_bite' },
    crawler:        { hp: 0.90, dmg: 0.85, arm: 1.1, speed: 5.0, size: 0.8, color: 0x5a6a4a, aggro: 10, loot: 'junk_crawler_shell', ability: null },
    lynx:           { hp: 0.80, dmg: 1.10, arm: 0.5, speed: 8.0, size: 0.9, color: 0xb59a70, aggro: 13, loot: 'mat_lynx_fur', ability: null },
    drake:          { hp: 1.80, dmg: 1.40, arm: 1.2, speed: 6.5, size: 1.8, color: 0x8a3a2a, aggro: 16, loot: 'mat_drake_scale', ability: 'drake_breath' },
    giant:          { hp: 2.80, dmg: 1.70, arm: 1.1, speed: 5.5, size: 2.8, color: 0x8a8a90, aggro: 14, loot: 'junk_giant_tooth', ability: 'giant_stomp' },
    slug:           { hp: 1.00, dmg: 0.70, arm: 0.5, speed: 3.0, size: 0.9, color: 0x8aa04a, aggro: 8, loot: 'junk_slug_slime', ability: null },
    uruk:           { hp: 1.30, dmg: 1.20, arm: 1.2, speed: 6.2, size: 1.15, color: 0x3a3a38, aggro: 16, loot: 'junk_uruk_iron', ability: 'uruk_warcry' },
    sorcerer:       { hp: 0.90, dmg: 1.30, arm: 0.6, speed: 5.8, size: 1.0, color: 0x3a2a4a, aggro: 18, loot: 'junk_dark_tome_scrap', ability: 'sorcerer_shadow_bolt' },
    'lossoth-bear': { hp: 1.70, dmg: 1.30, arm: 1.0, speed: 6.5, size: 1.7, color: 0xe8ecf0, aggro: 13, loot: 'mat_white_bear_pelt', ability: 'bear_maul' },
    'sea-serpent':  { hp: 2.20, dmg: 1.40, arm: 1.1, speed: 6.0, size: 2.4, color: 0x2e6a70, aggro: 15, loot: 'mat_serpent_scale', ability: 'serpent_spray' },
  };
  /** Base combat numbers for a monster of `level` in `family` (before elite/boss scaling). */
  function M(level, family) {
    const f = FAM[family] || FAM.wolf;
    return {
      morale: Math.round((40 + level * 24 + level * level * 0.6) * f.hp),
      dmg: Math.round((4 + level * 1.7) * f.dmg),
      armour: Math.round(level * 7 * f.arm),
      speed: f.speed, size: f.size, color: f.color, aggroRange: f.aggro,
    };
  }
  W.monsterTypes = [];
  const FAMILY_LIST = Object.keys(FAM);
  // MT(id, name, family, zone, lmin, lmax, desc, opts{elite, boss, loot:[[tid,chance]...], abilities, color, size, speed, aggroRange, morale, dmg, armour})
  function MT(id, name, family, zone, lmin, lmax, desc, opts) {
    opts = opts || {};
    const f = FAM[family];
    const mid = Math.round((lmin + lmax) / 2);
    const base = M(mid, family);
    const t = { id, name, family, level: [lmin, lmax], zone, hostile: true, aggroRange: base.aggroRange, morale: base.morale, dmg: base.dmg, armour: base.armour,
      speed: base.speed, size: base.size, color: base.color, desc, loot: [] };
    if (opts.elite) { t.elite = true; t.morale = Math.round(t.morale * 2.5); t.dmg = Math.round(t.dmg * 1.45); t.armour = Math.round(t.armour * 1.3); t.size = round1(t.size * 1.15); t.aggroRange += 2; }
    if (opts.boss) { t.boss = true; t.elite = true; t.morale = Math.round(base.morale * 8); t.dmg = Math.round(base.dmg * 2.0); t.armour = Math.round(base.armour * 1.6); t.size = round1(base.size * 1.4); t.aggroRange = base.aggroRange + 4; }
    const pelt = opts.boss ? 1.0 : opts.elite ? 0.6 : 0.35;
    t.loot.push({ tid: f.loot, chance: pelt });
    if (opts.loot) for (const l of opts.loot) t.loot.push({ tid: l[0], chance: l[1] });
    if (opts.abilities) t.abilities = opts.abilities.slice();
    else if ((opts.elite || opts.boss) && f.ability) t.abilities = [f.ability];
    for (const k of ['color', 'size', 'speed', 'aggroRange', 'morale', 'dmg', 'armour', 'title']) if (opts[k] != null) t[k] = opts[k];
    W.monsterTypes.push(t); return t;
  }

  // ---- The Shire (1–10)
  MT('shire_wolf', 'Shire Wolf', 'wolf', 'shire', 2, 5, 'Lean grey wolves driven down from the Bindbole Wood by a hard winter.');
  MT('wild_boar', 'Wild Boar', 'boar', 'shire', 1, 4, 'A bristly boar with a temper as short as its legs.');
  MT('field_spider', 'Field Spider', 'spider', 'shire', 3, 6, 'Dog-sized spiders that spin between the hedgerows after dark.', { color: 0x4a4a3a });
  MT('bandit_ruffian', 'Ruffian', 'brigand', 'shire', 5, 8, 'A squint-eyed Southerner with a cudgel and a grudge against hobbits.');
  MT('shire_bat', 'Delving Bat', 'bat', 'shire', 4, 7, 'Fat black bats that roost in the old quarries of the White Downs.');
  MT('garden_slug', 'Garden Slug', 'slug', 'shire', 1, 3, 'An enormous slug, glistening and slow, with an appetite for prize marrows.');
  MT('brigand_ringleader', 'Ruffian Ringleader', 'brigand', 'shire', 8, 10, 'The scar-faced leader of the ruffians camped at Waymeet.', { elite: true, color: 0x5a3a2a });

  // ---- Ered Luin (1–15)
  MT('grey_wolf_eredluin', 'Blue Mountain Wolf', 'wolf', 'eredluin', 2, 6, 'Thick-pelted wolves of the high valleys.', { color: 0x7a8088 });
  MT('mountain_lynx', 'Mountain Lynx', 'lynx', 'eredluin', 3, 8, 'A tufted hunter of the pine slopes, quick and quiet.');
  MT('bluemountain_goblin', 'Goblin of Rath Teraig', 'goblin', 'eredluin', 4, 9, 'Small, vicious goblins spilling from the pass of Rath Teraig.');
  MT('cave_crawler', 'Cave Crawler', 'crawler', 'eredluin', 6, 11, 'A many-legged thing from the deeps of Sarnûr with a shell like slate.');
  MT('black_bear_eredluin', 'Black Bear', 'bear', 'eredluin', 8, 13, 'A black bear of the Blue Mountain foothills, best admired from afar.', { color: 0x2a2220 });
  MT('goblin_warlord_rath', 'Goblin Warlord', 'goblin', 'eredluin', 13, 15, 'A big goblin in stolen dwarf-mail who commands the raiders of the pass.', { elite: true, color: 0x5a6a2a });

  // ---- Bree-land (5–20)
  MT('bree_boar', 'Bree-land Boar', 'boar', 'breeland', 5, 9, 'Boars that root through the barley-fields of Bree-land.');
  MT('breeland_wolf', 'Greenway Wolf', 'wolf', 'breeland', 6, 11, 'Wolves that hunt along the old Greenway by night.');
  MT('brigand_blackwold', 'Blackwold Brigand', 'brigand', 'breeland', 8, 14, 'A cut-throat of the Blackwold gang that terrorises the Bree-land roads.');
  MT('bree_spider', 'Bree-land Spider', 'spider', 'breeland', 10, 15, 'Pale spiders nesting in the hollow oaks south of Bree-hill.', { color: 0x6a6a5a });
  MT('bree_bear', 'Brown Bear', 'bear', 'breeland', 12, 17, 'A hulking brown bear of the western woods.');
  MT('neekerbreeker', 'Neekerbreeker', 'crawler', 'breeland', 14, 19, 'A chittering cricket-thing the size of a dog, from the edge of the Midgewater.', { color: 0x7a8a3a });
  MT('blackwold_enforcer', 'Blackwold Enforcer', 'brigand', 'breeland', 17, 20, 'A hardened Blackwold lieutenant in looted mail.', { elite: true });

  // ---- Chetwood & Midgewater (12–22)
  MT('chetwood_wolf', 'Chetwood Wolf', 'wolf', 'souththicket', 12, 16, 'Dark-coated wolves of the deep Chetwood.', { color: 0x4a4540 });
  MT('chetwood_brigand', 'Blackwold Poacher', 'brigand', 'souththicket', 12, 17, 'Blackwolds who hide in the Chetwood and rob the Bree-folk.');
  MT('midgewater_spider', 'Midgewater Spider', 'spider', 'souththicket', 13, 18, 'Marsh-spiders with a venom that brings fever.', { color: 0x3a4a2a });
  MT('marsh_crawler', 'Marsh-crawler', 'crawler', 'souththicket', 14, 19, 'An armoured crawler that lurks under the reeds of the Midgewater.');
  MT('marsh_slug', 'Bog-slug', 'slug', 'souththicket', 15, 20, 'A vast slug oozing acid across the marsh-paths.', { color: 0x6a7a2a });
  MT('chetwood_archer', 'Blackwold Archer', 'brigand', 'souththicket', 19, 22, 'The best bowmen of the Blackwolds, loyal to their captain Halgar.', { elite: true, aggroRange: 20 });

  // ---- Old Forest & Barrow-downs (15–25)
  MT('old_forest_wolf', 'Old Forest Wolf', 'wolf', 'oldforest', 16, 21, 'Wolves grown strange and silent under the eaves of the Old Forest.', { color: 0x3a3a34 });
  MT('old_forest_spider', 'Old Forest Spider', 'spider', 'oldforest', 15, 20, 'Ancient spiders that weave between the twisted trees.', { color: 0x2a2a2a, size: 1.2 });
  MT('forest_bear', 'Old Forest Bear', 'bear', 'oldforest', 18, 23, 'A shaggy bear that has learned to fear nothing in the wood.');
  MT('barrow_bat', 'Barrow-bat', 'bat', 'oldforest', 17, 22, 'Bats that pour from the barrows at dusk.');
  MT('wight_barrow', 'Barrow-wight', 'wight', 'oldforest', 19, 24, 'A cold thing in rusted mail that sings in the dark under the Downs.');
  MT('barrow_crawler', 'Barrow-crawler', 'crawler', 'oldforest', 20, 25, 'A pale crawler that feeds on what the wights leave.', { color: 0x9a9a8a });
  MT('wight_guardian', 'Wight-guardian of Cardolan', 'wight', 'oldforest', 23, 25, 'A wight of the old kings\' guard, still keeping watch over a dead prince.', { elite: true, color: 0x6a8a90 });

  // ---- The Lone-lands (20–32)
  MT('lone_boar', 'Weather Hills Boar', 'boar', 'lonelands', 20, 24, 'Scrawny boars of the heath, quick to charge.');
  MT('lonelands_goblin', 'Goblin of the Lone-lands', 'goblin', 'lonelands', 20, 26, 'Goblins of Angmar that have crept into the ruins of the Lone-lands.');
  MT('red_hill_bandit', 'Red-hill Bandit', 'brigand', 'lonelands', 21, 26, 'Outlaws who prey on the Eglain from the red hills.');
  MT('lonelands_warg', 'Lone-lands Warg', 'warg', 'lonelands', 22, 27, 'Wargs, wolf-like and cunning, that hunt in packs across the heath.');
  MT('weather_hills_spider', 'Weather Hills Spider', 'spider', 'lonelands', 24, 29, 'Spiders as big as ponies nesting in the Weather Hills.', { size: 1.2 });
  MT('orc_lonelands', 'Orc of Angmar', 'orc', 'lonelands', 26, 31, 'Orcs sent south from Angmar to watch the old tower of Amon Sûl.');
  MT('warg_alpha_lonelands', 'Warg Pack-leader', 'warg', 'lonelands', 29, 32, 'The grizzled alpha of the Lone-lands wargs.', { elite: true, color: 0x3a3230 });

  // ---- The North Downs (28–40)
  MT('northdowns_bear', 'Downs Bear', 'bear', 'northdowns', 28, 33, 'A great bear of the Nan Amlug fields.');
  MT('northdowns_orc', 'Orc of Dol Dínen', 'orc', 'northdowns', 28, 34, 'Orcs of the war-camp at Dol Dínen.');
  MT('northdowns_warg', 'Downs Warg', 'warg', 'northdowns', 29, 35, 'Wargs ridden by orc-scouts across the North Downs.');
  MT('downs_spider', 'Downs Spider', 'spider', 'northdowns', 30, 36, 'Spiders that nest in the ruined farmsteads of Nan Amlug.');
  MT('fornost_wight', 'Wight of Fornost', 'wight', 'northdowns', 33, 39, 'The dead of Fornost Erain, roused by the sorcery of Angmar.');
  MT('uruk_fornost', 'Uruk of Fornost', 'uruk', 'northdowns', 35, 40, 'Great black uruks garrisoning the ruined city of the kings.');
  MT('uruk_champion_fornost', 'Uruk Champion', 'uruk', 'northdowns', 38, 40, 'A champion of the Fornost garrison, wielding a two-handed cleaver.', { elite: true });

  // ---- Evendim (35–45)
  MT('tomb_robber', 'Tomb-robber', 'brigand', 'evendim', 35, 41, 'Grave-robbers picking over the ruins of Annúminas for gold.');
  MT('evendim_lynx', 'Evendim Lynx', 'lynx', 'evendim', 35, 40, 'A silver lynx of the hills of Emyn Uial.', { color: 0xc8c0a8 });
  MT('evendim_crawler', 'Lake-crawler', 'crawler', 'evendim', 36, 42, 'An armoured crawler that comes up from the lake-bed at night.', { color: 0x4a6a6a });
  MT('evendim_bear', 'Emyn Uial Bear', 'bear', 'evendim', 37, 43, 'Bears of the northern hills, big as ponies.');
  MT('evendim_wight', 'Wight of Tyl Ruinen', 'wight', 'evendim', 39, 44, 'The drowned dead of Annúminas, walking the shore in rusted crowns.', { color: 0x7a9aa0 });
  MT('giant_evendim', 'Hill-giant of Emyn Uial', 'giant', 'evendim', 40, 45, 'A grey hill-giant that hurls boulders down on the lake road.');
  MT('tomb_robber_lieutenant', 'Tomb-robber Lieutenant', 'brigand', 'evendim', 43, 45, 'One of Ardaric\'s trusted men, armed from the tombs of kings.', { elite: true });

  // ---- The Trollshaws (40–50)
  MT('trollshaws_wolf', 'Trollshaws Wolf', 'wolf', 'trollshaws', 40, 44, 'Wolves that follow the trolls to feed on what they leave.');
  MT('hillman_brigand', 'Rhudaur Hillman', 'brigand', 'trollshaws', 41, 46, 'Hillmen of Rhudaur who have taken Angmar\'s coin.', { color: 0x5a4a3a });
  MT('trollshaws_bear', 'Trollshaws Bear', 'bear', 'trollshaws', 40, 45, 'A vast bear of the eastern woods.');
  MT('hill_troll', 'Hill-troll', 'troll', 'trollshaws', 42, 47, 'A hill-troll, all fists and hunger, wandering by night.');
  MT('trollshaws_spider', 'Rhudaur Spider', 'spider', 'trollshaws', 43, 48, 'Black spiders of the Trollshaws, fat on troll-leavings.', { size: 1.3 });
  MT('stone_troll', 'Stone-troll', 'troll', 'trollshaws', 44, 49, 'A stone-troll of the Shaws; sunlight turns it to rock, if you can last till dawn.', { color: 0x7a7870 });
  MT('cave_troll', 'Cave-troll', 'troll', 'trollshaws', 48, 50, 'A cave-troll from the deep holes under the Trollshaws.', { elite: true, color: 0x5a6a5a });

  // ---- The Misty Mountains (48–58)
  MT('misty_bat', 'Ice-bat', 'bat', 'misty', 48, 52, 'White bats that swarm from the frozen caves.', { color: 0xd8dce0 });
  MT('snow_goblin', 'Snow-goblin', 'goblin', 'misty', 48, 53, 'Goblins of Goblin-town, wrapped in stolen furs.', { color: 0x8a9a8a });
  MT('snow_warg', 'Snow-warg', 'warg', 'misty', 49, 54, 'White wargs of the high passes.', { color: 0xd0d4d8 });
  MT('goblin_archer_misty', 'Goblin-town Archer', 'goblin', 'misty', 50, 55, 'Goblin archers with poisoned arrows watching the Front Porch.', { abilities: ['goblin_poison_arrow'], aggroRange: 22 });
  MT('stone_giant', 'Stone-giant', 'giant', 'misty', 52, 57, 'Giants that play at hurling rocks across the gorges — and at travellers.');
  MT('cold_drake', 'Cold-drake', 'drake', 'misty', 53, 58, 'A wingless drake of the mountains, breathing frost.', { color: 0x5a7a9a });
  MT('giant_elder', 'Giant Elder', 'giant', 'misty', 56, 58, 'The eldest of the stone-giants, tall as a tower.', { elite: true, size: 3.4 });

  // ---- Angmar (55–65)
  MT('angmar_warg', 'Warg of Angmar', 'warg', 'angmar', 55, 60, 'Black wargs bred in the kennels of Carn Dûm.', { color: 0x2a2624 });
  MT('angmar_orc', 'Orc of Angmar', 'orc', 'angmar', 55, 60, 'Orcs of the Iron Crown, bearing the mark of the Witch-king.', { color: 0x3a3a2a });
  MT('angmar_bat', 'Gaunt-bat', 'bat', 'angmar', 56, 60, 'Bats bloated on carrion from the bogs of Malenhad.');
  MT('angmar_acolyte', 'Acolyte of Carn Dûm', 'sorcerer', 'angmar', 57, 62, 'A robed sorcerer-in-training hurling shadow from behind the orc-lines.', { abilities: ['sorcerer_shadow_bolt'] });
  MT('angmar_uruk', 'Uruk of Carn Dûm', 'uruk', 'angmar', 58, 63, 'Uruks of the citadel guard, armoured head to foot.');
  MT('angmar_wight', 'Gaunt-wight', 'wight', 'angmar', 60, 65, 'A wight raised by the gaunt-lords, cold and hungry.', { color: 0x6a7a80 });
  MT('angmar_uruk_captain', 'Uruk Captain', 'uruk', 'angmar', 63, 65, 'A captain of the Carn Dûm garrison, veteran of a hundred raids.', { elite: true });

  // ---- Forochel (60–70)
  MT('snow_wolf', 'Snow-wolf', 'wolf', 'forochel', 60, 65, 'White wolves that run over the ice by night.', { color: 0xe8ecf0 });
  MT('ice_bear', 'Ice-bear', 'lossoth-bear', 'forochel', 60, 66, 'The great white bears of Forochel, lords of the ice.');
  MT('forochel_lynx', 'Snow-lynx', 'lynx', 'forochel', 61, 66, 'A ghost-pale lynx of the snow-pines.', { color: 0xe0e0e0 });
  MT('gauredain', 'Gauredain Raider', 'brigand', 'forochel', 62, 67, 'Wolf-men of the eastern snows who raid the Lossoth camps.', { color: 0x8a7a6a });
  MT('forochel_giant', 'Snow-giant', 'giant', 'forochel', 63, 68, 'A giant of the glaciers, white-bearded with rime.', { color: 0xc8d0d8 });
  MT('forochel_drake', 'Frost-drake', 'drake', 'forochel', 64, 69, 'A drake whose breath freezes the blood.', { color: 0x8ab0c8 });
  MT('elder_ice_bear', 'Elder Ice-bear', 'lossoth-bear', 'forochel', 68, 70, 'An old, scarred bear that has killed more hunters than it has fingers to count.', { elite: true });

  // ---- Tol Fuin (65–72)
  MT('fuin_crawler', 'Shore-crawler', 'crawler', 'tolfuin', 65, 69, 'Crab-like crawlers that scuttle from the tide-pools.', { color: 0x8a5a4a });
  MT('fuin_bat', 'Cliff-bat', 'bat', 'tolfuin', 65, 69, 'Bats of the sea-cliffs of Tol Fuin.');
  MT('serpent_spawn', 'Serpent-spawn', 'sea-serpent', 'tolfuin', 65, 70, 'The young of the great serpent, hunting in the surf.', { size: 1.3 });
  MT('fuin_spider', 'Fuin Spider', 'spider', 'tolfuin', 66, 71, 'Spiders of the drowned ruins, spinning in the mallorn groves.', { color: 0x3a4a5a });
  MT('fuin_orc_raider', 'Orc-raider', 'orc', 'tolfuin', 67, 72, 'Orcs come by black ship to plunder the ruins of Beleriand.');
  MT('fuin_orc_captain', 'Raider Captain', 'orc', 'tolfuin', 70, 72, 'The captain of the orc-raiders, wearing a stolen elven helm.', { elite: true });

  // ---- Tol Morwen (60–68)
  MT('morwen_boar', 'Tol Morwen Boar', 'boar', 'tolmorwen', 60, 63, 'Island boars, fat on the villagers\' barley.');
  MT('morwen_wolf', 'Island Wolf', 'wolf', 'tolmorwen', 60, 64, 'Wolves that swam to the isle in a hard winter and never left.');
  MT('morwen_crawler', 'Tide-crawler', 'crawler', 'tolmorwen', 61, 66, 'Armoured crawlers of the tide-line.');
  MT('morwen_brigand', 'Wrecker', 'brigand', 'tolmorwen', 62, 67, 'Wreckers who lure ships onto the rocks with false fires.', { color: 0x4a5a6a });
  MT('morwen_wight', 'Drowned Wight', 'wight', 'tolmorwen', 64, 68, 'The drowned of a thousand wrecks, walking up out of the sea.', { color: 0x5a8a8a });
  MT('morwen_wrecker_chief', 'Wrecker Chief', 'brigand', 'tolmorwen', 66, 68, 'The one-eyed chief of the wreckers.', { elite: true });

  // ---- The Isle of Himling (72–80)
  MT('himling_warg', 'Warg of Himling', 'warg', 'himling', 72, 76, 'Wargs brought to the isle by the Gaunt-lord\'s servants.', { color: 0x3a3436 });
  MT('himling_uruk', 'Uruk of the Gaunt-lord', 'uruk', 'himling', 72, 77, 'Uruks sworn to Draugmar, bearing his bone-white sigil.', { color: 0x4a4a50 });
  MT('himling_sorcerer', 'Gaunt-cultist', 'sorcerer', 'himling', 73, 78, 'Cultists who feed the dead to the Gaunt-lord\'s altar.', { abilities: ['sorcerer_shadow_bolt'] });
  MT('himling_wight', 'Gaunt-wight', 'wight', 'himling', 74, 79, 'The dead of Himring, raised in ranks by Draugmar.', { color: 0x8a9aa8 });
  MT('himling_troll', 'Himling Troll', 'troll', 'himling', 75, 80, 'Armoured trolls guarding the approaches to the fortress.', { color: 0x3a3a3a });
  MT('himling_drake', 'Black Drake', 'drake', 'himling', 76, 80, 'A black drake nesting in the fallen towers of Himring.', { color: 0x2a2a30 });
  MT('himling_gaunt_champion', 'Gaunt-champion', 'wight', 'himling', 78, 80, 'A wight-lord in ancient plate, Draugmar\'s right hand.', { elite: true, color: 0x6a7a90, size: 1.3 });

  // ---- Bosses (12) — boss:true, elite, abilities from G.Data.monsterAbilities ids
  MT('gorkil', 'Gorkil, Goblin-chief of Rath Teraig', 'goblin', 'eredluin', 15, 15, 'The goblin-chief who holds the pass of Rath Teraig against the dwarves.', { boss: true, abilities: ['goblin_poison_arrow'], loot: [['junk_goblin_totem', 1.0]], color: 0x4a5a2a });
  MT('halgar', 'Halgar the Blackwold', 'brigand', 'souththicket', 22, 22, 'Captain of the Blackwolds, who sold Bree-land to Angmar for a bag of silver.', { boss: true, abilities: ['brigand_throw'], loot: [['junk_tattered_banner', 1.0], ['q_brigand_map', 1.0]], color: 0x3a2a1a });
  MT('sambrog', 'Sambrog, the Wight-lord', 'wight', 'oldforest', 25, 25, 'The wight-lord of the Great Barrow, whose cold song wakes the Downs.', { boss: true, abilities: ['wight_drain'], loot: [['junk_wight_shroud', 1.0], ['key_barrow', 1.0]], color: 0x4a7a80, size: 1.3 });
  MT('ugruk', 'Ugrûk, Orc-captain of the Weather Hills', 'orc', 'lonelands', 32, 32, 'The orc-captain besieging Weathertop for his masters in Angmar.', { boss: true, abilities: ['orc_cleave'], loot: [['junk_cracked_shield_boss', 1.0]], size: 1.3 });
  MT('burzghash', 'Bûrzghâsh, War-chief of Fornost', 'uruk', 'northdowns', 40, 40, 'The uruk war-chief who rules the ruins of Fornost as if it were his throne.', { boss: true, abilities: ['uruk_warcry', 'orc_cleave'], loot: [['junk_uruk_iron', 1.0], ['q_ancient_tome', 1.0]], size: 1.4 });
  MT('ardaric', 'Ardaric the Tomb-robber', 'brigand', 'evendim', 45, 45, 'A tomb-robber of Dúnedain blood who has sold the crowns of Annúminas to Angmar.', { boss: true, abilities: ['brigand_throw'], loot: [['q_shard_of_arnor', 1.0], ['junk_bent_coin', 1.0]], color: 0x8a7a5a });
  MT('thrugash', 'Thrúgash the Troll-chief', 'troll', 'trollshaws', 50, 50, 'A monstrous cave-troll who has made himself chief of all the trolls of the Shaws.', { boss: true, abilities: ['troll_smash'], loot: [['junk_troll_toenail', 1.0], ['q_troll_keystone', 1.0]], size: 3.0 });
  MT('grishkhal', 'The Great Goblin Grishkhâl', 'goblin', 'misty', 58, 58, 'The new Great Goblin, king of Goblin-town, bloated and cunning.', { boss: true, abilities: ['goblin_poison_arrow'], loot: [['junk_goblin_totem', 1.0], ['q_goblin_orders', 1.0]], size: 1.6, color: 0x5a6a3a });
  MT('gulmaethor', 'Gûlmaethor, Sorcerer of Carn Dûm', 'sorcerer', 'angmar', 65, 65, 'The Black Númenórean sorcerer who keeps the Witch-king\'s seat warm in Carn Dûm.', { boss: true, abilities: ['sorcerer_shadow_bolt', 'wight_drain'], loot: [['junk_angmarim_sigil', 1.0], ['key_carndum', 1.0]], color: 0x2a1a3a, size: 1.2 });
  MT('kelvarhjar', 'Kelvarhjar, the White Matriarch', 'lossoth-bear', 'forochel', 70, 70, 'The matriarch of the ice-bears, old as the glacier and twice as cold.', { boss: true, abilities: ['bear_maul'], loot: [['junk_white_bear_claw', 1.0]], size: 2.4 });
  MT('lomecar', 'Lómëcar, the Serpent of the Sundered Shore', 'sea-serpent', 'tolfuin', 72, 72, 'A sea-serpent from the days of the Drowning, coiled in the cove north of Ost Fuin.', { boss: true, abilities: ['serpent_spray', 'drake_breath'], loot: [['junk_serpent_fang', 1.0]], size: 3.2 });
  MT('draugmar', 'Draugmar the Gaunt-lord', 'wight', 'himling', 80, 80, 'The Gaunt-lord of Himling, who would raise all the dead of Beleriand and march them east.', { boss: true, abilities: ['wight_drain', 'sorcerer_shadow_bolt', 'giant_stomp'], size: 1.8, color: 0x3a4a60, loot: [['junk_wight_shroud', 1.0], ['key_himring', 1.0], ['mat_mithril_flake', 0.5]], morale: 60000, dmg: 260, armour: 1400 });

  W.bosses = [
    { id: 'boss_gorkil', type: 'gorkil', pos: { x: -1150, z: -1050 }, respawn: 120, poi: 'poi_rath_teraig' },
    { id: 'boss_halgar', type: 'halgar', pos: { x: 50, z: 560 }, respawn: 120, poi: 'poi_blackwold_camp' },
    { id: 'boss_sambrog', type: 'sambrog', pos: { x: -320, z: 920 }, respawn: 120, poi: 'poi_great_barrow' },
    { id: 'boss_ugruk', type: 'ugruk', pos: { x: 510, z: 10 }, respawn: 120, poi: 'poi_weathertop' },
    { id: 'boss_burzghash', type: 'burzghash', pos: { x: 250, z: -975 }, respawn: 120, poi: 'poi_fornost' },
    { id: 'boss_ardaric', type: 'ardaric', pos: { x: -560, z: -920 }, respawn: 120, poi: 'poi_annuminas' },
    { id: 'boss_thrugash', type: 'thrugash', pos: { x: 1245, z: -275 }, respawn: 120, poi: 'poi_troll_hole' },
    { id: 'boss_grishkhal', type: 'grishkhal', pos: { x: 1810, z: -575 }, respawn: 120, poi: 'poi_goblin_town_gate' },
    { id: 'boss_gulmaethor', type: 'gulmaethor', pos: { x: 1260, z: -1515 }, respawn: 120, poi: 'poi_carn_dum' },
    { id: 'boss_kelvarhjar', type: 'kelvarhjar', pos: { x: 770, z: -1740 }, respawn: 120, poi: 'poi_ice_bear_den' },
    { id: 'boss_lomecar', type: 'lomecar', pos: { x: -1757, z: -1706 }, respawn: 120, poi: 'poi_serpent_cove', aquatic: true },
    { id: 'boss_draugmar', type: 'draugmar', pos: { x: -1810, z: -310 }, respawn: 180, poi: 'poi_himring_fortress' },
  ];

  // ---------------------------------------------------------------- spawn areas ----------------------------------------------
  W.spawns = [];
  const _spawnCount = {};
  function S(zone, type, x, z, radius, count, name) {
    const n = (_spawnCount[zone] = (_spawnCount[zone] || 0) + 1);
    const s = { id: 'sp_' + zone + '_' + n, type, zone, center: { x, z }, radius, count, respawn: 45 };
    if (name) s.name = name;
    W.spawns.push(s); return s;
  }
  // Shire
  S('shire', 'shire_wolf', -1000, -380, 40, 5, 'Bindbole Wood');
  S('shire', 'wild_boar', -1130, -250, 35, 5);
  S('shire', 'field_spider', -870, -220, 35, 5);
  S('shire', 'bandit_ruffian', -1150, 50, 40, 5, 'Waymeet');
  S('shire', 'shire_bat', -1330, -200, 30, 4, 'Delving quarries');
  S('shire', 'garden_slug', -850, 80, 30, 5);
  S('shire', 'brigand_ringleader', -1180, 120, 25, 3, 'Ruffian camp');
  S('shire', 'shire_wolf', -800, -300, 40, 6);
  S('shire', 'wild_boar', -980, 220, 40, 6, 'Southfarthing fields');
  S('shire', 'field_spider', -1300, -330, 35, 5);
  S('shire', 'bandit_ruffian', -700, -140, 35, 5, 'East Road');
  S('shire', 'garden_slug', -1100, -30, 25, 4);
  S('shire', 'shire_bat', -760, 60, 30, 4);
  // Ered Luin
  S('eredluin', 'grey_wolf_eredluin', -1420, -820, 30, 5);
  S('eredluin', 'mountain_lynx', -1200, -860, 35, 4);
  S('eredluin', 'bluemountain_goblin', -1180, -1000, 40, 6, 'Rath Teraig');
  S('eredluin', 'cave_crawler', -1440, -1160, 30, 5, 'Sarnûr');
  S('eredluin', 'black_bear_eredluin', -1240, -700, 35, 4);
  S('eredluin', 'goblin_warlord_rath', -1130, -1040, 25, 3, 'Goblin war-camp');
  S('eredluin', 'grey_wolf_eredluin', -1380, -1220, 35, 5);
  S('eredluin', 'bluemountain_goblin', -1450, -980, 28, 5);
  S('eredluin', 'mountain_lynx', -1130, -780, 30, 4);
  S('eredluin', 'cave_crawler', -1230, -1200, 30, 5);
  S('eredluin', 'black_bear_eredluin', -1465, -600, 25, 3);
  S('eredluin', 'bluemountain_goblin', -1310, -1235, 30, 5, 'Northern pass');
  // Bree-land
  S('breeland', 'bree_boar', -420, -120, 35, 6);
  S('breeland', 'breeland_wolf', -380, -300, 40, 5);
  S('breeland', 'brigand_blackwold', 10, -120, 35, 6, 'Skirmish Hill');
  S('breeland', 'bree_spider', -150, -360, 35, 5);
  S('breeland', 'bree_bear', -500, -280, 35, 4);
  S('breeland', 'neekerbreeker', -80, 120, 35, 5);
  S('breeland', 'blackwold_enforcer', -30, -40, 25, 3, 'Blackwold lookout');
  S('breeland', 'breeland_wolf', -460, 180, 40, 5);
  S('breeland', 'bree_boar', -300, -260, 30, 5);
  S('breeland', 'brigand_blackwold', -400, 80, 35, 5, "Thornley's fields");
  S('breeland', 'bree_spider', -540, 20, 30, 4);
  S('breeland', 'bree_bear', -330, -380, 28, 4);
  // Chetwood & Midgewater
  S('souththicket', 'chetwood_wolf', 40, 420, 35, 5);
  S('souththicket', 'midgewater_spider', 250, 470, 35, 6);
  S('souththicket', 'marsh_crawler', 160, 520, 35, 6);
  S('souththicket', 'chetwood_brigand', 80, 540, 35, 6, 'Blackwold camp');
  S('souththicket', 'marsh_slug', 300, 380, 30, 5);
  S('souththicket', 'chetwood_archer', 270, 360, 25, 3, 'Archers\' blind');
  S('souththicket', 'chetwood_brigand', -60, 420, 35, 5);
  S('souththicket', 'chetwood_wolf', 220, 600, 30, 5);
  S('souththicket', 'midgewater_spider', 330, 480, 30, 5);
  S('souththicket', 'marsh_crawler', 100, 240, 30, 5);
  S('souththicket', 'midgewater_spider', 300, 300, 25, 4, 'Spider hollow');
  // Old Forest & Barrow-downs
  S('oldforest', 'old_forest_wolf', -440, 520, 35, 5);
  S('oldforest', 'old_forest_spider', -380, 640, 40, 6);
  S('oldforest', 'forest_bear', -500, 720, 35, 4);
  S('oldforest', 'barrow_bat', -300, 760, 35, 5);
  S('oldforest', 'wight_barrow', -370, 830, 40, 6, 'Barrow of Cardolan');
  S('oldforest', 'barrow_crawler', -290, 860, 35, 5);
  S('oldforest', 'wight_guardian', -330, 900, 25, 3, 'The Great Barrow');
  S('oldforest', 'wight_barrow', -440, 880, 35, 5);
  S('oldforest', 'old_forest_wolf', -300, 560, 35, 5);
  S('oldforest', 'old_forest_spider', -470, 800, 30, 5);
  S('oldforest', 'barrow_bat', -380, 720, 30, 5);
  S('oldforest', 'forest_bear', -250, 700, 30, 4);
  // Lone-lands
  S('lonelands', 'lone_boar', 380, 220, 35, 5);
  S('lonelands', 'lonelands_goblin', 330, -80, 40, 6, 'Minas Eriol');
  S('lonelands', 'weather_hills_spider', 560, -120, 35, 5);
  S('lonelands', 'red_hill_bandit', 450, 300, 35, 5);
  S('lonelands', 'lonelands_warg', 640, 220, 40, 6);
  S('lonelands', 'orc_lonelands', 520, -20, 30, 5, 'Orc-camp under Weathertop');
  S('lonelands', 'warg_alpha_lonelands', 780, 260, 25, 3, 'Warg den');
  S('lonelands', 'lonelands_goblin', 760, -120, 35, 6, 'Agamaur');
  S('lonelands', 'red_hill_bandit', 220, -40, 30, 5);
  S('lonelands', 'lonelands_warg', 400, -260, 35, 5);
  S('lonelands', 'lone_boar', 640, 380, 35, 5);
  S('lonelands', 'weather_hills_spider', 840, -40, 30, 4);
  S('lonelands', 'orc_lonelands', 560, -280, 25, 5);
  // North Downs
  S('northdowns', 'northdowns_bear', 260, -480, 35, 5);
  S('northdowns', 'northdowns_warg', 120, -620, 35, 6);
  S('northdowns', 'northdowns_orc', 480, -520, 40, 6, 'Dol Dínen');
  S('northdowns', 'downs_spider', 60, -780, 35, 5, 'Nan Amlug');
  S('northdowns', 'fornost_wight', 200, -900, 40, 6, 'Fornost');
  S('northdowns', 'uruk_fornost', 310, -940, 40, 6, 'Fornost garrison');
  S('northdowns', 'uruk_champion_fornost', 260, -1000, 25, 3, 'The King\'s Court');
  S('northdowns', 'northdowns_bear', 400, -880, 35, 4);
  S('northdowns', 'northdowns_warg', 540, -660, 35, 5);
  S('northdowns', 'northdowns_orc', -40, -560, 35, 5);
  S('northdowns', 'downs_spider', 380, -380, 30, 4);
  S('northdowns', 'fornost_wight', 100, -920, 30, 5);
  // Evendim
  S('evendim', 'tomb_robber', -540, -960, 30, 6, 'Annúminas');
  S('evendim', 'evendim_wight', -545, -820, 25, 5, 'Tyl Ruinen shore');
  S('evendim', 'evendim_lynx', -380, -1180, 35, 5);
  S('evendim', 'evendim_bear', -100, -1230, 35, 4);
  S('evendim', 'giant_evendim', -560, -1120, 35, 4, 'Emyn Uial caves');
  S('evendim', 'evendim_crawler', 30, -830, 25, 5, 'East shore');
  S('evendim', 'tomb_robber_lieutenant', -580, -880, 25, 3, 'Robbers\' camp');
  S('evendim', 'tomb_robber', -470, -1160, 30, 5);
  S('evendim', 'evendim_lynx', -250, -1270, 30, 4);
  S('evendim', 'evendim_wight', -20, -1180, 30, 5);
  S('evendim', 'evendim_bear', -600, -1000, 25, 4);
  S('evendim', 'evendim_crawler', -330, -1200, 30, 5, 'North shore');
  // Trollshaws
  S('trollshaws', 'trollshaws_wolf', 1160, 60, 35, 5);
  S('trollshaws', 'stone_troll', 1240, -100, 30, 4, 'The Stone-trolls\' clearing');
  S('trollshaws', 'hill_troll', 1100, 200, 40, 4);
  S('trollshaws', 'trollshaws_bear', 1300, 180, 35, 4);
  S('trollshaws', 'trollshaws_spider', 1250, -320, 35, 5);
  S('trollshaws', 'hillman_brigand', 900, 100, 35, 5, 'Hillman camp');
  S('trollshaws', 'cave_troll', 1180, 180, 25, 3, 'Troll-cave');
  S('trollshaws', 'trollshaws_wolf', 1380, -180, 35, 5);
  S('trollshaws', 'stone_troll', 1120, -260, 30, 4);
  S('trollshaws', 'trollshaws_bear', 960, -200, 30, 4);
  S('trollshaws', 'hillman_brigand', 1320, 280, 30, 5);
  S('trollshaws', 'trollshaws_spider', 1250, 320, 30, 5);
  // Misty Mountains
  S('misty', 'snow_goblin', 1760, -560, 40, 6, 'The Front Porch');
  S('misty', 'goblin_archer_misty', 1820, -470, 35, 5);
  S('misty', 'snow_warg', 1500, -560, 35, 5);
  S('misty', 'cold_drake', 1900, -440, 35, 4, 'Drake roost');
  S('misty', 'stone_giant', 1750, -300, 40, 4, 'The Giant\'s Stair');
  S('misty', 'misty_bat', 1620, -640, 35, 5, 'Frozen falls');
  S('misty', 'giant_elder', 1800, -200, 25, 3, 'Giants\' council');
  S('misty', 'snow_goblin', 1700, -720, 35, 6);
  S('misty', 'snow_warg', 1600, -250, 30, 5);
  S('misty', 'cold_drake', 1900, -620, 30, 3);
  S('misty', 'stone_giant', 1880, -330, 30, 4);
  S('misty', 'misty_bat', 1450, -450, 30, 5);
  // Angmar
  S('angmar', 'angmar_warg', 760, -1200, 35, 6);
  S('angmar', 'angmar_orc', 1000, -1080, 40, 6);
  S('angmar', 'angmar_uruk', 900, -1420, 40, 6, 'Himbar');
  S('angmar', 'angmar_acolyte', 1180, -1420, 35, 5, 'Approach to Carn Dûm');
  S('angmar', 'angmar_wight', 1080, -1520, 35, 5);
  S('angmar', 'angmar_bat', 1200, -1180, 35, 5, 'Barad Gúlaran');
  S('angmar', 'angmar_uruk', 1300, -1300, 35, 4, 'Eastern war-camp');
  S('angmar', 'angmar_uruk_captain', 1200, -1540, 25, 3, 'Outer gate of Carn Dûm');
  S('angmar', 'angmar_orc', 1160, -1340, 35, 6);
  S('angmar', 'angmar_warg', 700, -1350, 35, 5);
  S('angmar', 'angmar_wight', 1320, -1420, 30, 5);
  S('angmar', 'angmar_uruk', 1160, -1000, 30, 5);
  S('angmar', 'angmar_bat', 960, -1580, 30, 5, 'Malenhad');
  // Forochel
  S('forochel', 'snow_wolf', 480, -1800, 30, 5);
  S('forochel', 'ice_bear', 760, -1720, 35, 5, 'Ice-bear den');
  S('forochel', 'forochel_lynx', 400, -1760, 35, 5, 'Jä-rannoc');
  S('forochel', 'gauredain', 720, -1950, 35, 6, 'Hylje-leiri');
  S('forochel', 'forochel_giant', 820, -1850, 35, 4);
  S('forochel', 'forochel_drake', 640, -1960, 30, 4);
  S('forochel', 'elder_ice_bear', 330, -1820, 22, 3, 'The old den');
  S('forochel', 'snow_wolf', 640, -1560, 30, 5);
  S('forochel', 'forochel_lynx', 830, -1760, 30, 4);
  S('forochel', 'gauredain', 480, -1560, 25, 5);
  S('forochel', 'forochel_giant', 840, -1940, 25, 3);
  // Tol Fuin
  S('tolfuin', 'fuin_orc_raider', -1880, -1620, 30, 6, 'Raiders\' landing');
  S('tolfuin', 'fuin_spider', -1930, -1450, 30, 5, 'Western ruins');
  S('tolfuin', 'fuin_crawler', -1710, -1390, 30, 5);
  S('tolfuin', 'fuin_bat', -1860, -1360, 28, 5);
  S('tolfuin', 'serpent_spawn', -1745, -1680, 30, 4, 'The Serpent\'s Cove');
  S('tolfuin', 'fuin_orc_captain', -1940, -1580, 22, 3, 'Raider camp');
  S('tolfuin', 'fuin_spider', -1690, -1440, 25, 4);
  S('tolfuin', 'fuin_crawler', -1680, -1560, 25, 4);
  S('tolfuin', 'fuin_bat', -1960, -1500, 25, 4);
  // Himling
  S('himling', 'himling_warg', -1620, -480, 30, 5);
  S('himling', 'himling_uruk', -1800, -560, 30, 6, 'Uruk lines');
  S('himling', 'himling_wight', -1660, -330, 35, 6, 'The Barrows of Himling');
  S('himling', 'himling_sorcerer', -1850, -450, 30, 5, 'The Gaunt-altar');
  S('himling', 'himling_troll', -1880, -300, 35, 4);
  S('himling', 'himling_drake', -1740, -240, 35, 4, 'Fallen towers');
  S('himling', 'himling_gaunt_champion', -1790, -370, 25, 3, 'Gate of Himring');
  S('himling', 'himling_wight', -1600, -380, 30, 5);
  S('himling', 'himling_warg', -1680, -540, 30, 5);
  S('himling', 'himling_uruk', -1910, -420, 30, 5);
  S('himling', 'himling_sorcerer', -1650, -260, 25, 4);
  // Tol Morwen
  S('tolmorwen', 'morwen_boar', -1900, 600, 25, 5);
  S('tolmorwen', 'morwen_wolf', -1780, 610, 25, 5);
  S('tolmorwen', 'morwen_brigand', -1900, 810, 28, 6, 'Wreckers\' cliffs');
  S('tolmorwen', 'morwen_crawler', -1760, 770, 25, 5);
  S('tolmorwen', 'morwen_wight', -1950, 720, 25, 4, 'Drowned barrows');
  S('tolmorwen', 'morwen_wrecker_chief', -1840, 830, 22, 3, 'Wreckers\' beacon');
  S('tolmorwen', 'morwen_wolf', -1960, 640, 25, 4);
  S('tolmorwen', 'morwen_boar', -1820, 580, 25, 4);

  // ---------------------------------------------------------------- fishing spots ------------------------------------------
  W.fishingSpots = [];
  function FS(id, name, zone, x, z, radius, fish) {
    const s = { id, name, zone, pos: { x, z }, radius, fish: fish.map((f) => ({ tid: 'fish_' + f[0], weight: f[1] })) };
    W.fishingSpots.push(s); return s;
  }
  FS('fs_bywater_pool', 'The Bywater Pool', 'shire', -966, -92, 14, [['brandywine_trout', 5], ['bywater_perch', 4], ['golden_carp', 3], ['nenuial_pike', 1]]);
  FS('fs_hobbiton_water', 'The Water at Hobbiton', 'shire', -1000, -165, 12, [['brandywine_trout', 5], ['bywater_perch', 3], ['golden_carp', 2]]);
  FS('fs_brandywine_bridge', 'The Brandywine under the Bridge', 'shire', -620, -70, 12, [['evendim_salmon', 3], ['nenuial_pike', 3], ['midgewater_eel', 2], ['brandywine_trout', 2]]);
  FS('fs_brandywine_south', 'Brandywine Reach', 'shire', -626, -170, 12, [['brandywine_trout', 3], ['evendim_salmon', 2], ['golden_carp', 2], ['midgewater_eel', 2]]);
  FS('fs_brandywine_marches', 'The Brandywine at the Bree-land Marches', 'breeland', -598, -150, 12, [['nenuial_pike', 3], ['bywater_perch', 3], ['brandywine_trout', 2], ['midgewater_eel', 2]]);
  FS('fs_brandywine_hedge', 'The Brandywine at the Hedge', 'oldforest', -562, 380, 12, [['nenuial_pike', 3], ['evendim_salmon', 2], ['bywater_perch', 2], ['midgewater_eel', 2]]);
  FS('fs_withywindle', 'The Withywindle', 'oldforest', -540, 700, 12, [['midgewater_eel', 3], ['nenuial_pike', 3], ['bywater_perch', 2], ['golden_carp', 2]]);
  FS('fs_lonelands_tarn', 'The Weather Hills Tarn', 'lonelands', 700, 172, 14, [['bywater_perch', 4], ['nenuial_pike', 3], ['golden_carp', 2], ['brandywine_trout', 1]]);
  FS('fs_hoarwell_bridge', 'The Hoarwell below the Last Bridge', 'trollshaws', 1045, -80, 12, [['evendim_salmon', 4], ['brandywine_trout', 3], ['nenuial_pike', 2], ['hoarwell_grayling', 1]]);
  FS('fs_hoarwell_ford', 'The Hoarwell Ford', 'trollshaws', 1020, 200, 12, [['evendim_salmon', 3], ['brandywine_trout', 3], ['midgewater_eel', 2], ['himling_sturgeon', 1]]);
  FS('fs_hoarwell_angmar', 'The Hoarwell Headwaters', 'angmar', 1105, -1200, 12, [['brandywine_trout', 3], ['hoarwell_grayling', 3], ['evendim_salmon', 2], ['himling_sturgeon', 1]]);
  FS('fs_tinnudir_shore', 'The Tinnudir Shallows', 'evendim', -215, -1130, 14, [['bywater_perch', 4], ['nenuial_pike', 3], ['silver_trout', 1], ['himling_sturgeon', 1]]);
  FS('fs_evendim_east', 'The East Shore of Nenuial', 'evendim', 20, -900, 14, [['bywater_perch', 4], ['nenuial_pike', 2], ['golden_carp', 2], ['himling_sturgeon', 1], ['silver_trout', 1]]);
  FS('fs_annuminas_quay', 'The Drowned Quays of Annúminas', 'evendim', -512, -840, 14, [['himling_sturgeon', 3], ['nenuial_pike', 3], ['silver_trout', 2], ['bywater_perch', 2]]);
  FS('fs_evendim_north', 'The North Shore of Nenuial', 'evendim', -250, -1172, 14, [['bywater_perch', 3], ['hoarwell_grayling', 2], ['nenuial_pike', 2], ['silver_trout', 1]]);
  FS('fs_celondim_quay', 'The Quay of Celondim', 'eredluin', -1485, -720, 14, [['forochel_icecod', 4], ['lune_herring', 4], ['tolfuin_seabass', 3]]);
  FS('fs_kheledul', 'The Kheledûl Shore', 'eredluin', -1486, -560, 14, [['forochel_icecod', 3], ['lune_herring', 3], ['tolfuin_seabass', 3], ['midgewater_eel', 1]]);
  FS('fs_forochel_bay', 'The Ice-bay', 'forochel', 550, -1885, 14, [['hoarwell_grayling', 5], ['forochel_icecod', 3], ['lune_herring', 2]]);
  FS('fs_tolfuin_cove', "The Serpent's Cove Shallows", 'tolfuin', -1780, -1678, 14, [['tolfuin_seabass', 4], ['forochel_icecod', 3], ['lune_herring', 2], ['himling_sturgeon', 1]]);
  FS('fs_himling_shore', 'The Ras Himling Strand', 'himling', -1553, -380, 14, [['forochel_icecod', 4], ['lune_herring', 3], ['tolfuin_seabass', 2]]);
  FS('fs_morwen_harbour', 'Morwen Harbour', 'tolmorwen', -1705, 690, 14, [['lune_herring', 4], ['tolfuin_seabass', 3], ['forochel_icecod', 2], ['himling_sturgeon', 2]]);

  // ---------------------------------------------------------------- gather nodes ---------------------------------------------
  W.gatherNodes = [];
  const _nodeCount = {};
  function GN(zone, kind, itemTid, x, z, radius, count, name) {
    const n = (_nodeCount[zone] = (_nodeCount[zone] || 0) + 1);
    const g = { id: 'gn_' + zone + '_' + n, itemTid, zone, pos: { x, z }, radius, count, kind };
    if (name) g.name = name;
    W.gatherNodes.push(g); return g;
  }
  GN('shire', 'herb', 'mat_pipeweed', -1120, -40, 18, 5, 'Pipe-weed patch'); GN('shire', 'mushroom', 'mat_mushroom', -920, -260, 16, 5); GN('shire', 'wood', 'mat_ash_branch', -1050, -300, 18, 5);
  GN('shire', 'chest', 'misc_treasure_cache', -1180, -330, 8, 1, "Old Tobold's cache"); GN('shire', 'ore', 'mat_copper_ore', -1350, -150, 16, 4, 'Delving quarry');
  GN('eredluin', 'ore', 'mat_copper_ore', -1230, -1000, 16, 5); GN('eredluin', 'ore', 'mat_dwarf_iron', -1400, -1180, 16, 5, 'Sarnûr seam'); GN('eredluin', 'relic', 'q_dwarf_deed', -1160, -960, 14, 4, 'Rath Teraig rune-stones');
  GN('eredluin', 'wood', 'mat_rowan_wood', -1260, -820, 18, 5); GN('eredluin', 'herb', 'mat_moonflower', -1470, -640, 14, 4);
  GN('breeland', 'herb', 'mat_athelas', -330, -200, 16, 5, 'Bree-hill hedgerows'); GN('breeland', 'mushroom', 'mat_mushroom', -400, 240, 16, 5); GN('breeland', 'wood', 'mat_ash_branch', -60, -340, 18, 5);
  GN('breeland', 'chest', 'misc_treasure_cache', 30, -90, 8, 1, 'Blackwold stash'); GN('breeland', 'ore', 'mat_copper_ore', -440, -330, 16, 4);
  GN('souththicket', 'herb', 'mat_athelas', 200, 420, 16, 5); GN('souththicket', 'mushroom', 'mat_mushroom', 120, 480, 16, 5); GN('souththicket', 'wood', 'mat_yew_bough', 0, 300, 18, 5);
  GN('souththicket', 'relic', 'q_sealed_letter', 250, 310, 12, 4, 'Chetwood lodge'); GN('souththicket', 'chest', 'misc_treasure_cache', 60, 560, 8, 1, 'Blackwold plunder');
  GN('oldforest', 'mushroom', 'mat_mushroom', -420, 700, 16, 5); GN('oldforest', 'herb', 'mat_nightshade', -350, 580, 16, 5); GN('oldforest', 'wood', 'mat_ash_branch', -480, 640, 16, 5, 'Bonfire Glade');
  GN('oldforest', 'relic', 'junk_barrow_relic', -380, 840, 14, 4, 'Barrow of Cardolan'); GN('oldforest', 'chest', 'misc_treasure_cache', -330, 880, 8, 1, 'Great Barrow hoard');
  GN('lonelands', 'herb', 'mat_moonflower', 420, 180, 16, 5); GN('lonelands', 'ore', 'mat_iron_ore', 560, -160, 16, 5, 'Weather Hills'); GN('lonelands', 'relic', 'q_shard_of_arnor', 500, 40, 12, 4, 'Weathertop');
  GN('lonelands', 'wood', 'mat_rowan_wood', 320, -160, 18, 5); GN('lonelands', 'chest', 'misc_treasure_cache', 760, -100, 8, 1, 'Agamaur'); GN('lonelands', 'mushroom', 'mat_mushroom', 660, 300, 16, 4);
  GN('northdowns', 'ore', 'mat_iron_ore', 300, -560, 16, 5); GN('northdowns', 'herb', 'mat_athelas', 150, -720, 16, 5); GN('northdowns', 'relic', 'q_ancient_tome', 250, -940, 14, 5, 'Fornost');
  GN('northdowns', 'wood', 'mat_yew_bough', 420, -440, 18, 5); GN('northdowns', 'chest', 'misc_treasure_cache', 270, -1000, 8, 1, 'Fornost treasury');
  GN('evendim', 'relic', 'q_shard_of_arnor', -530, -930, 14, 5, 'Annúminas'); GN('evendim', 'ore', 'mat_silver_ore', -560, -1140, 16, 4); GN('evendim', 'herb', 'mat_athelas', -380, -1200, 16, 5);
  GN('evendim', 'wood', 'mat_yew_bough', -120, -1240, 18, 5); GN('evendim', 'chest', 'misc_treasure_cache', -590, -860, 8, 1, "Robbers' loot");
  GN('trollshaws', 'herb', 'mat_athelas', 1200, 120, 16, 5); GN('trollshaws', 'ore', 'mat_iron_ore', 1130, -240, 16, 5); GN('trollshaws', 'wood', 'mat_rowan_wood', 1350, 200, 18, 5);
  GN('trollshaws', 'relic', 'q_troll_keystone', 1280, -20, 12, 4, 'Ford of Bruinen'); GN('trollshaws', 'chest', 'misc_treasure_cache', 1240, -95, 8, 1, "Trolls' hoard");
  GN('misty', 'ore', 'mat_mithril_flake', 1700, -380, 16, 3, 'Mithril seam'); GN('misty', 'herb', 'mat_snow_lichen', 1560, -540, 16, 5); GN('misty', 'relic', 'q_goblin_orders', 1780, -580, 12, 4, 'Goblin-town gate');
  GN('misty', 'chest', 'misc_treasure_cache', 1890, -460, 8, 1, 'Drake hoard'); GN('misty', 'wood', 'mat_rowan_wood', 1480, -300, 16, 4);
  GN('angmar', 'ore', 'mat_iron_ore', 1050, -1400, 16, 5); GN('angmar', 'herb', 'mat_nightshade', 760, -1300, 16, 5); GN('angmar', 'relic', 'q_angmar_dispatch', 1180, -1480, 14, 5, 'Carn Dûm');
  GN('angmar', 'chest', 'misc_treasure_cache', 1235, -1540, 8, 1, "Sorcerer's vault"); GN('angmar', 'mushroom', 'mat_mushroom', 1000, -1400, 16, 5, 'Malenhad');
  GN('forochel', 'herb', 'mat_snow_lichen', 640, -1900, 16, 5); GN('forochel', 'ore', 'mat_silver_ore', 820, -1800, 16, 5); GN('forochel', 'relic', 'q_lossoth_charm', 700, -1980, 12, 4, "Wreck of the Lost King's ship");
  GN('forochel', 'chest', 'misc_treasure_cache', 760, -1700, 8, 1, 'Bear-den cache'); GN('forochel', 'wood', 'mat_rowan_wood', 420, -1700, 16, 5);
  GN('tolfuin', 'relic', 'q_elf_lantern', -1920, -1430, 14, 5, 'Western ruins'); GN('tolfuin', 'herb', 'mat_athelas', -1720, -1400, 16, 5); GN('tolfuin', 'wood', 'mat_mallorn_wood', -1860, -1360, 16, 5, 'Mallorn grove');
  GN('tolfuin', 'chest', 'misc_treasure_cache', -1900, -1600, 8, 1, "Raiders' plunder"); GN('tolfuin', 'ore', 'mat_silver_ore', -1680, -1560, 14, 4);
  GN('himling', 'relic', 'q_himring_seal', -1800, -330, 14, 5, 'Himring'); GN('himling', 'ore', 'mat_iron_ore', -1880, -320, 14, 4); GN('himling', 'chest', 'misc_treasure_cache', -1660, -340, 8, 1, 'Barrow hoard');
  GN('himling', 'herb', 'mat_snow_lichen', -1740, -250, 14, 4); GN('himling', 'wood', 'mat_yew_bough', -1700, -560, 14, 4, 'Driftwood');
  GN('tolmorwen', 'herb', 'mat_moonflower', -1900, 620, 14, 5); GN('tolmorwen', 'mushroom', 'mat_mushroom', -1790, 600, 14, 5); GN('tolmorwen', 'relic', 'q_elven_missive', -1890, 650, 10, 3, 'Stone of the Hapless');
  GN('tolmorwen', 'chest', 'misc_treasure_cache', -1900, 820, 8, 1, "Wreckers' hoard"); GN('tolmorwen', 'wood', 'mat_ash_branch', -1950, 700, 14, 4);

  // ---------------------------------------------------------------- points of interest ---------------------------------------
  W.pois = [];
  let PO = null;
  function poi(id, name, zone, x, z, kind, desc) { PO = { id, name, zone, pos: { x, z }, kind, desc }; W.pois.push(PO); return PO; }
  function PB(recipe, dx, dz, yawDeg, extra) {
    const b = { recipe, x: PO.pos.x + dx, z: PO.pos.z + dz, yaw: yawDeg == null ? Math.atan2(dx, dz) : yawDeg * R };
    if (extra) Object.assign(b, extra);
    (PO.buildings = PO.buildings || []).push(b); return b;
  }
  // Shire
  poi('poi_bag_end', 'Bag End', 'shire', -1058, -206, 'landmark', 'The finest hobbit-hole in the Shire, dug into the top of the Hill above Hobbiton. Its round green door has seen a dwarf or two.');
  poi('poi_party_tree', 'The Party Tree', 'shire', -1000, -220, 'landmark', 'The great tree in the Party Field where Bilbo held his famous eleventy-first birthday party.');
  poi('poi_brandywine_bridge', 'The Brandywine Bridge', 'shire', -604, -50, 'bridge', 'The stone bridge that carries the East Road over the Brandywine — the eastern gate of the Shire.');
  poi('poi_bywater_pool', 'The Bywater Pool', 'shire', -1000, -120, 'lake', 'The wide, willow-fringed pool of the Water beside Bywater, beloved of hobbit anglers.');
  poi('poi_greenfields', 'The Greenfields', 'shire', -1150, -330, 'landmark', 'The field where Bandobras Took knocked the goblin-king Golfimbul\'s head into a rabbit-hole and invented golf.');
  PB('shrine', 0, 0, 180, { name: 'Bullroarer\'s Stone' });
  poi('poi_waymeet', 'Waymeet Ruffian Camp', 'shire', -1180, 120, 'camp', 'A rough camp of Southron ruffians squatting at the crossroads of Waymeet.');
  PB('tent', -12, -6, 60); PB('tent', 10, 8, -120); PB('fence', 0, -16, 0, { len: 10 });
  // Ered Luin
  poi('poi_rath_teraig', 'Rath Teraig', 'eredluin', -1160, -1020, 'cave', 'The narrow goblin-haunted pass through the Blue Mountains east of Thorin\'s Hall.');
  PB('ruin_wall', -14, 10, 60, { len: 12 }); PB('ruin_wall', 14, -8, -120, { len: 12 });
  poi('poi_sarnur', 'Sarnûr', 'eredluin', -1450, -1150, 'cave', 'An ancient dwarf-delving under the western peaks, now infested with crawlers and worse.');
  poi('poi_kheledul', 'Kheledûl', 'eredluin', -1480, -560, 'ruin', 'A ruined harbour of the Dourhand dwarves on the Lune, its docks rotting into the sea.');
  PB('ruin_tower', 2, -10, null); PB('ruin_wall', 10, 10, 90, { len: 14 }); PB('dock', -10, 0, yawTo(-1, 0) / R, { name: 'Dourhand quay' });
  poi('poi_falathlorn_falls', 'The Falls of Falathlorn', 'eredluin', -1390, -640, 'waterfall', 'White water tumbling from the hills of Falathlorn towards the elven havens.');
  poi('poi_thrain_vale', 'The Vale of Thráin', 'eredluin', -1250, -1200, 'landmark', 'A high cold valley north of Thorin\'s Hall where the dwarves once mined silver.');
  // Bree-land
  poi('poi_bree_westgate', 'The West-gate of Bree', 'breeland', -360, -20, 'landmark', 'The great western gate of Bree on the East Road, watched by Harry Goatleaf.');
  poi('poi_prancing_pony', 'The Prancing Pony', 'breeland', -310, -44, 'landmark', 'Barliman Butterbur\'s famous inn, where hobbits and Big Folk drink together and strange Rangers sit in corners.');
  poi('poi_skirmish_hill', 'Ruins of Skirmish Hill', 'breeland', 50, -90, 'ruin', 'A tumbled watch-tower of old Cardolan, now a Blackwold lookout.');
  PB('ruin_tower', 0, -6, null); PB('ruin_wall', -12, 8, 90, { len: 12 }); PB('ruin_wall', 12, 8, -90, { len: 12 });
  poi('poi_thornley_farm', "Thornley's Farm", 'breeland', -420, 220, 'camp', 'A hard-pressed farmstead west of Staddle, plagued by wolves and brigands.');
  PB('man_house', 0, -10, 180); PB('fence', -14, 8, 90, { len: 16 }); PB('fence', 14, 8, -90, { len: 16 }); PB('well', 0, 10, 0);
  poi('poi_greenway_waystone', 'The Greenway Waystone', 'breeland', -300, -300, 'landmark', 'A leaning waystone of Arnor on the old Greenway north of Bree.');
  PB('shrine', 0, 0, 0, { name: 'Waystone' });
  // Chetwood & Midgewater
  poi('poi_midgewater', 'The Midgewater Marshes', 'souththicket', 180, 470, 'landmark', 'A miserable expanse of reeds, pools and biting midges between the Chetwood and the Weather Hills.');
  poi('poi_blackwold_camp', 'Blackwold Camp', 'souththicket', 60, 540, 'camp', 'The hidden camp of the Blackwold brigands and their captain Halgar.');
  PB('tent', -14, -8, 70); PB('tent', 12, -10, -70); PB('tent', 0, 14, 180); PB('ruin_wall', -20, 12, 90, { len: 14 }); PB('campfire', 0, 0, 0);
  poi('poi_chetwood_lodge', 'The Old Chetwood Lodge', 'souththicket', 250, 320, 'ruin', 'A hunting lodge of the kings of Cardolan, long since roofless and overgrown.');
  PB('ruin_wall', -10, 0, 90, { len: 16 }); PB('ruin_wall', 0, -10, 0, { len: 16 }); PB('ruin_tower', 12, 10, null);
  poi('poi_spider_hollow', 'Spider Hollow', 'souththicket', 310, 300, 'cave', 'A web-choked dell at the edge of the marsh.');
  // Old Forest & Barrow-downs
  poi('poi_old_man_willow', 'Old Man Willow', 'oldforest', -470, 730, 'landmark', 'The great grey willow on the Withywindle whose heart is rotten and whose song is sleep.');
  poi('poi_bonfire_glade', 'The Bonfire Glade', 'oldforest', -530, 640, 'landmark', 'A bare glade where the hobbits of Buckland once burned back the forest.');
  PB('campfire', 0, 0, 0);
  poi('poi_barrow_of_cardolan', 'The Barrow of Cardolan', 'oldforest', -380, 820, 'grave', 'The barrow of the last prince of Cardolan, where a wight sings in the dark.');
  PB('barrow', 0, 0, 180); PB('barrow', -22, 14, 150); PB('barrow', 22, 14, -150);
  poi('poi_great_barrow', 'The Great Barrow', 'oldforest', -330, 900, 'dungeon', 'The largest barrow of the Downs and the seat of Sambrog the Wight-lord.');
  PB('barrow', 0, 0, 180, { name: 'The Great Barrow' }); PB('ruin_wall', -16, 12, 90, { len: 14 }); PB('ruin_wall', 16, 12, -90, { len: 14 });
  poi('poi_haunted_hollow', 'The Haunted Hollow', 'oldforest', -600, 850, 'grave', 'A lonely barrow west of the Brandywine that even the Bucklanders avoid.');
  PB('barrow', 0, 0, 180);
  // Lone-lands
  poi('poi_weathertop', 'Weathertop (Amon Sûl)', 'lonelands', 500, 30, 'tower', 'The ruined watch-tower of Amon Sûl, where the palantír once stood and where the Witch-king\'s orcs now keep camp.');
  PB('ruin_tower', 0, 0, null, { name: 'Amon Sûl' }); PB('ruin_wall', -16, 8, 90, { len: 16 }); PB('ruin_wall', 16, 8, -90, { len: 16 });
  poi('poi_minas_eriol', 'Minas Eriol', 'lonelands', 330, -60, 'ruin', 'A shattered tower of Arnor north of the Great Road, taken by goblins.');
  PB('ruin_tower', 0, 0, null); PB('ruin_wall', 0, 14, 180, { len: 14 });
  poi('poi_agamaur', 'Ruins of Agamaur', 'lonelands', 760, -110, 'ruin', 'Marsh-ruins of an old Arnorian fort, crawling with goblins and haunted by the drowned.');
  PB('ruin_wall', -12, -8, 45, { len: 14 }); PB('ruin_wall', 12, 8, -135, { len: 14 }); PB('ruin_tower', 14, -12, null);
  poi('poi_lonelands_tarn', 'The Weather Hills Tarn', 'lonelands', 700, 120, 'lake', 'A cold dark tarn below Ost Guruth where the Eglain fish for perch.');
  poi('poi_red_pass', 'The Red Pass', 'lonelands', 420, -280, 'landmark', 'A pass of rust-red stone where the wargs of the Lone-lands den.');
  // North Downs
  poi('poi_fornost', 'Fornost Erain', 'northdowns', 250, -960, 'ruin', 'Norbury of the Kings, the last capital of Arnor, now a haunted ruin held by the uruks of Angmar.');
  PB('ruin_tower', -24, -20, null); PB('ruin_tower', 24, -20, null); PB('ruin_wall', 0, -28, 0, { len: 30 }); PB('ruin_wall', -30, 6, 90, { len: 24 }); PB('ruin_wall', 30, 6, -90, { len: 24 }); PB('gate', 0, 20, 180, { width: 14, name: 'Gate of Fornost' });
  poi('poi_trestlespan', 'The Trestlespan', 'northdowns', 150, -480, 'bridge', 'The great wooden trestle-bridge that gives Trestlebridge its name.');
  poi('poi_dol_dinen', 'Dol Dínen', 'northdowns', 480, -500, 'camp', 'A war-camp of the orcs of Angmar in the eastern Downs.');
  PB('tent', -12, -6, 60); PB('tent', 12, 6, -120); PB('ruin_wall', 0, -18, 0, { len: 16 }); PB('campfire', 0, 0, 0);
  poi('poi_nan_amlug', 'Nan Amlug', 'northdowns', 80, -780, 'landmark', 'The wide fields west of Fornost, once the granary of Arnor, now grazed by wargs.');
  poi('poi_esteldin_gate', 'The Hidden Gate of Esteldín', 'northdowns', 350, -680, 'landmark', 'A cleft in the hills that opens, for those who know it, on the refuge of the Rangers.');
  // Evendim
  poi('poi_annuminas', 'Annúminas', 'evendim', -540, -900, 'ruin', 'The drowned first capital of Arnor on the western shore of Nenuial, its towers standing knee-deep in the lake.');
  PB('ruin_tower', -20, -16, null); PB('ruin_tower', 22, -14, null); PB('ruin_wall', 0, -26, 0, { len: 28 }); PB('ruin_wall', -30, 4, 90, { len: 20 }); PB('ruin_wall', 30, 4, -90, { len: 20 }); PB('shrine', 0, 12, 180, { name: 'Throne of Elendil' });
  poi('poi_tyl_ruinen', 'Tyl Ruinen', 'evendim', -250, -1220, 'grave', 'A grave-isle of the kings on the north shore, where the dead of Annúminas do not rest.');
  PB('barrow', 0, 0, 180);
  poi('poi_emyn_uial_caves', 'The Caves of Emyn Uial', 'evendim', -540, -1100, 'cave', 'Deep caves in the Hills of Evendim where the hill-giants sleep.');
  poi('poi_tinnudir_causeway', 'The Causeway of Tinnudir', 'evendim', -40, -1000, 'bridge', 'A long stone causeway across the shallows of Nenuial to the isle of Tinnudir.');
  poi('poi_rushingdale', 'Rushingdale Shore', 'evendim', -20, -720, 'landmark', 'A reedy inlet on the south-eastern shore of the lake.');
  // Trollshaws
  poi('poi_last_bridge', 'The Last Bridge', 'trollshaws', 1029, -50, 'bridge', 'The Last Bridge over the Hoarwell, where the Great East Road enters the Trollshaws.');
  poi('poi_stone_trolls', "The Stone-trolls' Clearing", 'trollshaws', 1230, -110, 'landmark', 'Three trolls turned to stone by the sunrise, still arguing about how to cook a dwarf.');
  poi('poi_ford_of_bruinen', 'The Ford of Bruinen', 'trollshaws', 1270, -20, 'landmark', 'The ford at the border of Rivendell, guarded by the power of Elrond.');
  poi('poi_trollshaws_cave', 'The Troll-cave', 'trollshaws', 1180, 180, 'cave', 'A dank hole in the hills where the cave-trolls sleep out the day.');
  poi('poi_troll_hole', "The Troll-chief's Hole", 'trollshaws', 1240, -270, 'cave', 'The reeking lair of Thrúgash, chief of all the trolls of the Shaws.');
  // Misty Mountains
  poi('poi_goblin_town_gate', 'The Front Porch of Goblin-town', 'misty', 1800, -560, 'cave', 'The cave-mouth on the High Pass that leads down into Goblin-town.');
  PB('ruin_wall', -14, 6, 90, { len: 12 }); PB('ruin_wall', 14, 6, -90, { len: 12 }); PB('campfire', 0, 10, 0);
  poi('poi_giants_stair', "The Giant's Stair", 'misty', 1750, -300, 'landmark', 'A stair of boulders climbing the mountain, each step higher than a house.');
  poi('poi_frozen_falls', 'The Frozen Falls', 'misty', 1560, -620, 'waterfall', 'A waterfall frozen mid-plunge into a curtain of blue ice.');
  poi('poi_drake_roost', 'Drake Roost', 'misty', 1900, -440, 'cave', 'A cliff-nest of cold-drakes above the eastern gorges.');
  poi('poi_high_pass', 'The High Pass', 'misty', 1950, -500, 'landmark', 'The pass over the Misty Mountains, closed by snow for half the year and by goblins for the rest.');
  // Angmar
  poi('poi_carn_dum', 'Carn Dûm', 'angmar', 1250, -1500, 'dungeon', 'The black citadel of the Witch-king, where the sorcerer Gûlmaethor now rules.');
  PB('tower', -26, -20, null); PB('tower', 26, -20, null); PB('wall_segment', 0, -30, 0, { len: 40 }); PB('wall_segment', -34, 4, 90, { len: 30 }); PB('wall_segment', 34, 4, -90, { len: 30 }); PB('gate', 0, 20, 180, { width: 16, name: 'Gate of Carn Dûm' });
  poi('poi_rammas_deluon', 'Rammas Deluon', 'angmar', 735, -1035, 'landmark', 'The gate of the Watching-stones on the road into Angmar. Their eyes follow travellers.');
  PB('ruin_tower', 8.5, 8.5, null, { name: 'Watching-stone' }); PB('ruin_tower', -8.5, -8.5, null, { name: 'Watching-stone' });
  poi('poi_barad_gularan', 'Barad Gúlaran', 'angmar', 1150, -1050, 'tower', 'A tower of black sorcery on the Hoarwell where the acolytes are trained.');
  PB('ruin_tower', 0, 0, null, { name: 'Barad Gúlaran' });
  poi('poi_himbar', 'Ruins of Himbar', 'angmar', 890, -1430, 'ruin', 'A ruined hillman fort, now an uruk camp.');
  PB('ruin_wall', -12, -6, 45, { len: 14 }); PB('ruin_wall', 12, 8, -135, { len: 14 }); PB('campfire', 0, 0, 0);
  poi('poi_malenhad', 'The Bogs of Malenhad', 'angmar', 1000, -1400, 'landmark', 'Sulphurous bogs east of Aughaire, where the dead do not stay down.');
  // Forochel
  poi('poi_ice_bay', 'The Ice-bay of Forochel', 'forochel', 450, -1980, 'lake', 'The frozen bay where the Lossoth hunt seal and where King Arvedui was lost.');
  poi('poi_hylje_leiri', 'Hylje-leiri', 'forochel', 720, -1950, 'camp', 'An abandoned Lossoth seal-hunters\' camp, overrun by Gauredain raiders.');
  PB('lossoth_hut', -10, -4, 90); PB('lossoth_hut', 10, 6, -90); PB('campfire', 0, 0, 0);
  poi('poi_ja_rannoc', 'Jä-rannoc Glacier', 'forochel', 400, -1760, 'landmark', 'A tongue of blue glacier grinding down toward the bay.');
  poi('poi_ice_bear_den', 'The Ice-bear Den', 'forochel', 760, -1720, 'cave', 'The den of the white matriarch and her brood.');
  poi('poi_dunedain_wreck', "Wreck of the Lost King's Ship", 'forochel', 700, -1980, 'landmark', 'The ribs of an ancient ship, said to be that which bore King Arvedui to his doom.');
  // Tol Fuin
  poi('poi_serpent_cove', "The Serpent's Cove", 'tolfuin', -1760, -1650, 'landmark', 'A black-sand cove on the north shore of Tol Fuin where the serpent Lómëcar coils.');
  poi('poi_fuin_ruins', 'Ruins of Western Beleriand', 'tolfuin', -1920, -1430, 'ruin', 'Broken walls of the First Age, carved with the script of Gondolin.');
  PB('ruin_tower', 0, -10, null); PB('ruin_wall', -14, 6, 90, { len: 16 }); PB('ruin_wall', 14, 6, -90, { len: 16 });
  poi('poi_beleriand_stone', 'The Stone of Beleriand', 'tolfuin', -1700, -1400, 'shrine', 'A standing stone raised by the elves in memory of the drowned land.');
  PB('shrine', 0, 0, 180);
  poi('poi_raiders_landing', "Raiders' Landing", 'tolfuin', -1880, -1620, 'camp', 'Where the orc-raiders beach their black ships.');
  PB('tent', -10, 4, 90); PB('tent', 10, -4, -90); PB('campfire', 0, 0, 0);
  // Himling
  poi('poi_himring_fortress', 'Himring', 'himling', -1800, -320, 'dungeon', 'The Ever-cold, fortress of Maedhros in the Elder Days, its walls cast down and its halls taken by the Gaunt-lord.');
  PB('ruin_tower', -26, -18, null); PB('ruin_tower', 26, -18, null); PB('ruin_tower', 0, -34, null, { name: 'Keep of Himring' }); PB('ruin_wall', -30, 6, 90, { len: 24 }); PB('ruin_wall', 30, 6, -90, { len: 24 }); PB('ruin_wall', -14, -30, 0, { len: 14 }); PB('ruin_wall', 14, -30, 0, { len: 14 }); PB('gate', 0, 22, 180, { width: 16, name: 'Gate of Himring' });
  poi('poi_himling_barrows', 'The Barrows of Himling', 'himling', -1660, -330, 'grave', 'Barrows of the warriors who fell defending Himring, opened one by one by the Gaunt-lord.');
  PB('barrow', 0, 0, 180); PB('barrow', -20, 14, 150); PB('barrow', 20, 14, -150);
  poi('poi_gaunt_altar', 'The Gaunt-altar', 'himling', -1850, -450, 'shrine', 'A black altar where the cultists feed the dead to their master.');
  PB('shrine', 0, 0, 180, { name: 'The Gaunt-altar' });
  poi('poi_himling_watchtower', 'The Old Watchtower', 'himling', -1720, -560, 'tower', 'A broken elven watchtower on the southern cliffs.');
  PB('ruin_tower', 0, 0, null);
  // Tol Morwen
  poi('poi_stone_of_hapless', 'The Stone of the Hapless', 'tolmorwen', -1890, 650, 'shrine', 'The standing stone that marks the grave of Túrin Turambar and Nienor, and beside it that of Morwen.');
  PB('shrine', 0, 0, 180, { name: 'Stone of the Hapless' });
  poi('poi_morwen_wreck', 'Wreck of the Grey Gull', 'tolmorwen', -1760, 760, 'landmark', 'A fishing-boat broken on the eastern rocks by the wreckers\' false fires.');
  poi('poi_hurin_cairn', 'Cairn of Húrin', 'tolmorwen', -1900, 780, 'grave', 'A cairn the islanders raised for Húrin Thalion, though none know where he truly lies.');
  PB('barrow', 0, 0, 180);
  poi('poi_wreckers_beacon', "The Wreckers' Beacon", 'tolmorwen', -1840, 830, 'tower', 'A ruined tower on the southern cliffs where the wreckers light their false fires.');
  PB('ruin_tower', 0, 0, null);

  // ---------------------------------------------------------------- lookup maps, helpers, export ------------------------------
  function indexBy(list) { const m = {}; for (const e of list) m[e.id] = e; return m; }
  W.zoneById = indexBy(W.zones);
  W.townById = indexBy(W.towns);
  W.npcById = indexBy(W.npcs);
  W.monsterById = indexBy(W.monsterTypes);
  W.dockById = indexBy(W.docks);
  W.spotById = indexBy(W.fishingSpots);
  W.nodeById = indexBy(W.gatherNodes);
  W.poiById = indexBy(W.pois);
  W.bossById = indexBy(W.bosses);
  W.spawnById = indexBy(W.spawns);
  W.roadById = indexBy(W.roads);
  W.monsterFamilies = FAMILY_LIST;
  W.familyBase = FAM;
  W.M = M;
  W.water = WATER;
  W.isWater = isWater;
  W.landInfo = landInfo;
  W.yawTo = yawTo;
  W.distToPolyline = distToPolyline;
  /** Zone containing (x,z): the zone whose centre is nearest in units of its radius; falls back to the nearest zone. */
  W.zoneAt = function (x, z) {
    let best = null, bd = Infinity;
    for (const zn of W.zones) { const d = d2(x, z, zn.center.x, zn.center.z) / zn.radius; if (d < bd) { bd = d; best = zn; } }
    return best ? best.id : 'shire';
  };
  W.townAt = function (x, z) {
    for (const t of W.towns) if (d2(x, z, t.pos.x, t.pos.z) <= t.radius) return t;
    return null;
  };
  W.nearestTown = function (x, z) {
    let best = null, bd = Infinity;
    for (const t of W.towns) { const d = d2(x, z, t.pos.x, t.pos.z); if (d < bd) { bd = d; best = t; } }
    return best;
  };
  /** Distance from (x,z) to the nearest road centreline (metres) and that road. */
  W.distToRoad = function (x, z) {
    let best = Infinity, road = null;
    for (const r of W.roads) { const d = distToPolyline(x, z, r.points); if (d < best) { best = d; road = r; } }
    return { dist: best, road };
  };
  W.travelRoutesFrom = function (townId) { return W.travelRoutes.filter((r) => r.from === townId); };
  W.npcsInTown = function (townId) { return W.npcs.filter((n) => n.town === townId); };
  W.questGivers = function () { return W.npcs.filter((n) => n.roles.indexOf('questgiver') >= 0); };
  W.typesInZone = function (zoneId) { return W.monsterTypes.filter((m) => m.zone === zoneId); };
  W.spawnsInZone = function (zoneId) { return W.spawns.filter((s) => s.zone === zoneId); };
  W.startTowns = { hobbit: 'hobbiton', riverhobbit: 'hobbiton', man: 'archet', dunedain: 'archet', rohirrim: 'archet', beorning: 'archet', elf: 'celondim', highelf: 'celondim', dwarf: 'thorinshall', stoutaxe: 'thorinshall' };
  // Item ids referenced by this registry (owned by 03_data_items). Everything is defined there except the two in `missing`.
  W.itemIdsReferenced = (function () {
    const set = new Set();
    for (const m of W.monsterTypes) for (const l of m.loot) set.add(l.tid);
    for (const s of W.fishingSpots) for (const f of s.fish) set.add(f.tid);
    for (const g of W.gatherNodes) set.add(g.itemTid);
    return Array.from(set).sort();
  })();
  W.itemIdsMissingIn03 = ['mat_mushroom', 'misc_treasure_cache'];
  W.assumedItemIds = { loot: W.monsterTypes.reduce((a, m) => { for (const l of m.loot) if (a.indexOf(l.tid) < 0) a.push(l.tid); return a; }, []),
    fish: ['fish_brandywine_trout', 'fish_bywater_perch', 'fish_midgewater_eel', 'fish_lune_herring', 'fish_hoarwell_grayling', 'fish_nenuial_pike', 'fish_evendim_salmon', 'fish_golden_carp', 'fish_forochel_icecod', 'fish_tolfuin_seabass', 'fish_himling_sturgeon', 'fish_silver_trout'],
    nodes: W.gatherNodes.reduce((a, g) => { if (a.indexOf(g.itemTid) < 0) a.push(g.itemTid); return a; }, []) };
  G.Data.world = W;
})();
