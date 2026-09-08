/* ==== 10_terrain.js — G.Terrain: the ground of Middle-earth. A fully analytic, deterministic height field
   (zone-blended fbm + ridged mountains + downs/plateaus/ice ridges, sea with beaches & islands, lakes, carved rivers
   with fords, flattened roads (causeways across water), flattened towns, the sheltered Rivendell valley with its
   stream), streamed 128 m LOD chunk meshes (48/24/12 segments, skirts, vertex colours + tiling detail map, pooled
   buffers, ≤ 2 builds per frame), a static 6 km horizon mesh so the world never ends, animated water (gerstner-ish
   waves, fresnel, sun specular, shore foam from a baked height texture, shimmer, fog), the painted world map and
   every ground query the other modules need.

   Public API (SPEC §5.1):
     init(), build(scene), update(playerPos, dt)
     height(x,z), normal(x,z,out), slope(x,z) [= sin(angle), 0 flat .. 1 vertical], isWater(x,z), waterDepth(x,z)
     zoneAt(x,z), biomeAt(x,z), groundType(x,z), onRoad(x,z) 0..1, nearestRoadPoint(x,z,out?) → {x,z,dist}
     mapCanvas(size, opts?) → cached HTMLCanvasElement of the whole world; opts.labels (default true) — the label-free base
     and the labelled variant are cached separately and share one raster
   Extras (documented, on G.Terrain):
     groundColor(x,z,out) → linear {r,g,b}      water (near water Mesh), waterFar (far ring), group (chunk Group),
     horizon (Mesh), material (terrain MeshStandardMaterial), waterMaterial, detailTexture, heightTexture (DataTexture,
     world height, sqrt-encoded around sea level in .r; .g = road weight, .b = sand weight), CHUNK (128), VIEW_RADIUS (960)
     setSun(dir, color, intensity?)  setSkyColor(hexOrColor)   — fed by G.Sky
     coarseHeight(x,z) (8 m grid, bilinear, cheap)  zoneWeight(zoneId,x,z) 0..1  townAt(x,z) → town|null
     worldToMap(x,z,size,out) / mapToWorld(px,py,size,out)   warmup(x,z,radius?) (synchronous chunk build)
     stats() → {chunks, queued, builds, avgBuildMs, maxBuildMs, lastBuildMs, triangles, pooled}   ready (bool)
   Towns whose data has hasDock (or that own an entry in G.Data.world.docks) are flattened at the water line (~5.5 m);
   roads crossing lakes/sea become narrow causeways; roads crossing rivers become shallow fords (bed −0.9 m).
   Data read: G.C.WORLD_SIZE/SEA_LEVEL, G.Data.world.zones/towns/roads and G.Data.world.water
   (seaWestX, seaNorthZ, lakes, rivers, bays, landmasses, islands) — §9 defaults are used for anything missing.
   Private helpers (rule 2): _ss/_clamp/_lerp (inlined math), everything else is internal. ==== */
(function () {
  'use strict';
  const G = window.G;
  const T = {};
  G.Terrain = T;

  // ---------------------------------------------------------------- tunables
  const CHUNK = 128;
  const LOD_SEGS = [48, 24, 12];
  const LOD_DIST = [300, 600, 960];          // finest LOD within these distances (chunk nearest-point distance)
  const VIEW_RADIUS = 960;
  const DISPOSE_DIST = 1400;
  const MAX_BUILDS_PER_FRAME = 2;
  const BUILD_BUDGET_MS = 3.5;
  const HORIZON_SIZE = 6144, HORIZON_SEGS = 128, HORIZON_DROP = 2.5;
  const WATER_SIZE = 2400, WATER_SEGS = 96, WATER_FAR_SIZE = 9000, WATER_SNAP = 100;
  const GRID_N = 512;                         // coarse world height grid (8 m)
  const CELL = 64;                            // spatial bucket size
  const DETAIL_TILE = 6;                      // metres per detail-map repeat
  const SKIRT = [5, 8, 12];
  const FALLBACK_W = 0.12;                    // weight of the global fallback biome
  const SUPPORT = 1.35;                       // zone influence radius = radius * SUPPORT
  const LAKE_RIM = 2.4, LAKE_RIM_SMALL = 1.6, SMALL_LAKE_R = 60, SMALL_LAKE_DEPTH = 4;   // big lakes keep a low grassy rim; ponds/tarns meet the water gently
  const RIVER_BANK = 1.4, RIVER_BED = -3.2, FORD_BED = -0.9, SEA_FLOOR = -25, CAUSEWAY_H = 1.4;
  const BEACH_H = 14, BEACH_FLAT = 0.55;                 // sea profile is compressed within ±14 m of the water line (slope ≈ × 0.5 through the shore)
  const SAND_SEA = 2.2, SAND_LAKE = 1.4, SAND_POND = 0.5, SAND_RIVER = 1.3;   // height above the water line where sand gives way to grass
  const TOWN_MIN_H = 2.5, VALLEY_FLOOR = 5;
  // packed-earth fill of the settlement core per town style (0 = grass with worn paths only)
  const TOWN_EARTH = { man: 1, dwarf: 1, ruin: 0.8, camp: 0.7, lossoth: 0.7, elf: 0.5, hobbit: 0 };

  let HALF = 2048, WORLD_SIZE = 4096, SEA = 0;
  let GC = 64, INV_CELL = 1 / CELL;
  let COAST_X = -1500, COAST_Z = -1650;

  // ---------------------------------------------------------------- tiny math (hot paths; no property lookups)
  function ss(a, b, x) { let t = (x - a) / (b - a); t = t < 0 ? 0 : t > 1 ? 1 : t; return t * t * (3 - 2 * t); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function num(v, d) { return (typeof v === 'number' && v === v) ? v : d; }
  function hexOf(v, d) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const s = v.replace('#', ''); const n = parseInt(s, 16); return n === n ? n : d; }
    if (v && typeof v.getHex === 'function') return v.getHex();
    return d;
  }

  // ---------------------------------------------------------------- biome height/colour profiles
  // base: fallback base height; macro/meso/micro: noise amplitudes (600 m / 120 m / 18 m); ridge: ridged-peak
  // amplitude (overridden by zone.mountain * 120); crag: small rocky outcrops; downs: long anisotropic hills;
  // plateau: terraced macro relief; ice: ice ridges + full snow cover; forest: darker mossy floor; marsh: wet flats.
  const BIOME = {
    shire:    { base: 18, macro: 12, hill: 7,   meso: 2.4, micro: 0.35, ridge: 0,   crag: 0 },
    breeland: { base: 15, macro: 10, hill: 6,   meso: 2.6, micro: 0.4,  ridge: 0,   crag: 0 },
    forest:   { base: 22, macro: 10, hill: 5,   meso: 3.2, micro: 0.5,  ridge: 0,   crag: 1.5, forest: 1 },
    marsh:    { base: 8,  macro: 4,  hill: 1.5, meso: 1.4, micro: 0.3,  ridge: 0,   crag: 0,   marsh: 1 },
    barren:   { base: 25, macro: 13, hill: 6,   meso: 4.0, micro: 0.6,  ridge: 14,  crag: 4 },
    downs:    { base: 30, macro: 11, hill: 5,   meso: 3.0, micro: 0.4,  ridge: 0,   crag: 1,   downs: 1 },
    lake:     { base: 16, macro: 9,  hill: 5,   meso: 2.5, micro: 0.4,  ridge: 0,   crag: 0.5 },
    elven:    { base: 30, macro: 10, hill: 5,   meso: 3.0, micro: 0.4,  ridge: 10,  crag: 1 },
    mountain: { base: 80, macro: 26, hill: 4,   meso: 6.0, micro: 0.8,  ridge: 120, crag: 6 },
    dark:     { base: 40, macro: 13, hill: 5,   meso: 3.5, micro: 0.6,  ridge: 45,  crag: 5,   plateau: 1 },
    arctic:   { base: 20, macro: 9,  hill: 4,   meso: 2.5, micro: 0.4,  ridge: 18,  crag: 2,   ice: 1 },
    island:   { base: 14, macro: 10, hill: 5,   meso: 3.0, micro: 0.5,  ridge: 12,  crag: 3 },
    wild:     { base: 15, macro: 9,  hill: 5,   meso: 2.5, micro: 0.4,  ridge: 0,   crag: 0 },
  };
  const FALLBACK_BIOME = 'breeland';

  // zone table (flat Float64Array, stride ZS) — filled in init()
  const ZS = 27;
  const Z_CX = 0, Z_CZ = 1, Z_R = 2, Z_S2 = 3, Z_INVS2 = 4, Z_BASE = 5, Z_MAC = 6, Z_MES = 7, Z_MIC = 8, Z_RID = 9, Z_DWN = 10,
    Z_PLA = 11, Z_ICE = 12, Z_CRG = 13, Z_SNOW = 14, Z_MTN = 15, Z_GR = 16, Z_GG = 17, Z_GB = 18, Z_DR = 19, Z_DG = 20, Z_DB = 21,
    Z_FOR = 22, Z_MARSH = 23, Z_ROCK = 24, Z_LEVEL = 25, Z_HILL = 26;
  let ZT = new Float64Array(0), NZ = 0;
  let ZONES = [], ZONE_IDS = [], ZONE_BY_ID = {};
  let FB = null;                                            // fallback biome params

  // blended height params (module scratch; filled by blendH)
  const B = new Float64Array(12);
  // blended colour params (filled by blendC): 0-2 grass rgb, 3-5 ground rgb, 6 snow, 7 ice, 8 forest, 9 marsh, 10 rock tint
  const C = new Float64Array(12);

  // spatial buckets (CSR) for roads / rivers / towns
  let RSEG = new Float64Array(0), RC_START = new Uint32Array(1), RC_ITEMS = new Uint32Array(0), NRS = 0;    // roads
  let VSEG = new Float64Array(0), VC_START = new Uint32Array(1), VC_ITEMS = new Uint32Array(0), NVS = 0;    // rivers
  let TWN = new Float64Array(0), TC_START = new Uint32Array(1), TC_ITEMS = new Uint32Array(0), NTW = 0;     // towns
  let TOWNS = [];
  const RS = 8, VS = 10, TS = 5;
  // lakes/bays (stride 4: cx, cz, R, depth), sea islands/landmasses (stride 3), lake isles (stride 4: cx, cz, R, h)
  let LAK = new Float64Array(0), LAK_N = 0, ISL = new Float64Array(0), ISL_N = 0, LISL = new Float64Array(0), LISL_N = 0;
  let RIVERS = [], LAKES = [];
  // Rivendell valley
  let VAL_X = 1400, VAL_Z = 40, VAL_R = 235, VAL_R2 = VAL_R * VAL_R;

  // side products of the last height() call (read by colour/ground-type code, never by other modules)
  let L_macro = 0, L_meso = 0, L_micro = 0, L_sea = 0, L_lake = 0, L_shoreBase = 0, L_sandH = SAND_SEA, L_valley = 0, L_ridge = 0;
  // L_shore = final sand weight (shore proximity × height band), L_earth = packed-earth settlement weight, L_settle = town core (style-free)
  let L_road = 0, L_roadCore = 0, L_town = 0, L_shore = 0, L_water = 0, L_earth = 0, L_settle = 0;

  // ---------------------------------------------------------------- zone blending
  function blendH(x, z) {
    let sw = FALLBACK_W;
    let base = FB.base * sw, mac = FB.macro * sw, mes = FB.meso * sw, mic = FB.micro * sw, hil = FB.hill * sw;
    let rid = 0, dwn = 0, pla = 0, ice = 0, crg = 0, mtn = 0;
    for (let o = 0; o < NZ; o += ZS) {
      const dx = x - ZT[o], dz = z - ZT[o + 1];
      const d2 = dx * dx + dz * dz;
      if (d2 >= ZT[o + Z_S2]) continue;
      const t = 1 - d2 * ZT[o + Z_INVS2];
      const w = t * t;
      sw += w;
      base += w * ZT[o + Z_BASE]; mac += w * ZT[o + Z_MAC]; mes += w * ZT[o + Z_MES]; mic += w * ZT[o + Z_MIC];
      rid += w * ZT[o + Z_RID]; dwn += w * ZT[o + Z_DWN]; pla += w * ZT[o + Z_PLA]; ice += w * ZT[o + Z_ICE];
      crg += w * ZT[o + Z_CRG]; mtn += w * ZT[o + Z_MTN]; hil += w * ZT[o + Z_HILL];
    }
    const inv = 1 / sw;
    B[0] = base * inv; B[1] = mac * inv; B[2] = mes * inv; B[3] = mic * inv; B[4] = rid * inv; B[5] = dwn * inv;
    B[6] = pla * inv; B[7] = ice * inv; B[8] = crg * inv; B[9] = mtn * inv; B[10] = hil * inv;
  }

  function blendC(x, z, h) {
    let sw = FALLBACK_W;
    let gr = FB.gr * sw, gg = FB.gg * sw, gb = FB.gb * sw, dr = FB.dr * sw, dg = FB.dg * sw, db = FB.db * sw;
    let snow = 0, ice = 0, forest = 0, marsh = 0, rock = 0;
    for (let o = 0; o < NZ; o += ZS) {
      const dx = x - ZT[o], dz = z - ZT[o + 1];
      const d2 = dx * dx + dz * dz;
      if (d2 >= ZT[o + Z_S2]) continue;
      const t = 1 - d2 * ZT[o + Z_INVS2];
      const w = t * t;
      sw += w;
      gr += w * ZT[o + Z_GR]; gg += w * ZT[o + Z_GG]; gb += w * ZT[o + Z_GB];
      dr += w * ZT[o + Z_DR]; dg += w * ZT[o + Z_DG]; db += w * ZT[o + Z_DB];
      const sl = ZT[o + Z_SNOW];
      if (sl < 1e8) snow += w * ss(sl - 14, sl + 10, h);
      ice += w * ZT[o + Z_ICE]; forest += w * ZT[o + Z_FOR]; marsh += w * ZT[o + Z_MARSH]; rock += w * ZT[o + Z_ROCK];
    }
    const inv = 1 / sw;
    C[0] = gr * inv; C[1] = gg * inv; C[2] = gb * inv; C[3] = dr * inv; C[4] = dg * inv; C[5] = db * inv;
    C[6] = snow * inv; C[7] = ice * inv; C[8] = forest * inv; C[9] = marsh * inv; C[10] = rock * inv;
  }

  // ---------------------------------------------------------------- land relief (zones + noise)
  function landH(x, z, low) {
    blendH(x, z);
    const base = B[0], macA = B[1], mesA = B[2], micA = B[3], ridA = B[4], dwn = B[5], pla = B[6], ice = B[7], crg = B[8], mtn = B[9], hilA = B[10];
    let macro = G.fbm(x * 0.0016667, z * 0.0016667, low ? 2 : 4, 2, 0.5);
    let ridge = 0;
    if (pla > 0.01) {                                      // terraced plateaus (Angmar)
      const f = (macro + 1) * 2;
      const i = Math.floor(f);
      const terr = (i + ss(0.3, 0.7, f - i)) * 0.5 - 1;
      macro += (terr - macro) * pla * 0.85;
    }
    let h = base + macA * macro;
    if (hilA > 0.05) {                                     // billowy hills (rounded tops, soft creases)
      const n1 = G.noise2(x * 0.0038 + 17, z * 0.0038 - 9), n2 = G.noise2(x * 0.0077 - 4, z * 0.0077 + 13);
      h += hilA * ((n1 < 0 ? -n1 : n1) * 1.4 + (n2 < 0 ? -n2 : n2) * 0.6 - 0.62);
    }
    if (ridA > 0.3) {                                      // ridged mountain peaks, confined to the zone core
      const r = G.ridged(x * 0.00286 + 3.1, z * 0.00286 - 1.7, low ? 2 : 4, 2, 0.5);
      const core = ss(0.12, 0.8, mtn);
      h += ridA * (0.12 + 0.88 * core) * r;
      ridge = (1 - r) * core * (ridA > 60 ? 1 : ridA / 60);
    }
    if (dwn > 0.01) {                                      // long rolling downs (anisotropic)
      const u = x * 0.866 - z * 0.5, v = x * 0.5 + z * 0.866;
      h += dwn * 14 * (0.7 * G.noise2(u * 0.00111 + 5, v * 0.00435) + 0.3 * G.noise2(u * 0.00222 - 2, v * 0.0087));
    }
    if (ice > 0.01) h += ice * 9 * G.ridged(x * 0.00476 + 9, z * 0.00476 + 4, low ? 1 : 2, 2, 0.5);
    let meso = 0, micro = 0;
    if (!low) {
      meso = G.fbm(x * 0.008333 + 11, z * 0.008333 - 7, 3, 2, 0.5);
      micro = G.fbm(x * 0.05556 - 3, z * 0.05556 + 21, 2, 2, 0.5);
      h += mesA * meso + micA * micro;
      if (crg > 0.3) h += crg * (G.ridged(x * 0.0161 + 1, z * 0.0161 - 5, 2, 2, 0.5) - 0.35);
    }
    // soft floor: land never dips below ~1.5 m on its own (valley bottoms become marshy flats); water features carve later
    if (h < 16) h = 1.5 + 2.5 * Math.log(1 + Math.exp((h - 1.5) * 0.4));
    L_macro = macro; L_meso = meso; L_micro = micro; L_ridge = ridge;
    return h;
  }

  // ---------------------------------------------------------------- land + sea + islands + lakes + valley
  function baseH(x, z, low) {
    let h = landH(x, z, low);
    const macro = L_macro, meso = L_meso, micro = L_micro;
    let sea = 0, lake = 0, shore = 0, sandH = SAND_SEA, valley = 0;
    // --- sea (west of COAST_X / north of COAST_Z) with a wobbly coast, beaches and islands rising from it
    let cd = COAST_X - x;
    const cdz = COAST_Z - z;
    if (cdz > cd) cd = cdz;
    if (cd > -420) {
      cd += 25 * G.fbm(x * 0.0021 + 4, z * 0.0021 + 9, 2, 2, 0.5) + 6 * G.noise2(x * 0.017, z * 0.017);
      let s = ss(-100, 100, cd);
      shore = ss(-170, 20, cd);
      if (s > 0) {
        for (let o = 0; o < ISL_N; o += 3) {
          const dx = x - ISL[o], dz = z - ISL[o + 1];
          const R = ISL[o + 2], lim = R + 60;
          const d2 = dx * dx + dz * dz;
          if (d2 >= lim * lim) continue;
          const d = Math.sqrt(d2) + R * 0.06 * G.noise2(x * 0.012 + 2, z * 0.012 + 7);
          s *= 1 - ss(R + 45, R - 45, d);
        }
        const floor = SEA_FLOOR + 5 * macro + 2 * meso;
        h += (floor - h) * s;
        // gentle beaches: compress the profile around the water line (which stays exactly where it is) so the slope
        // through the shore drops to ~45 % — wide sand and foam bands instead of a hard step into the sea
        const a = h < 0 ? -h : h;
        if (a < BEACH_H) h *= 1 - BEACH_FLAT * (1 - ss(0, BEACH_H, a)) * ss(0.02, 0.25, s);
        sea = s;
      }
    }
    // --- lakes & bays. Ponds/tarns (R < 60): a wide, mild hollow, then one gentle bowl from 1.45 R down to at most
    //     4 m (the water line sits near 0.8 R, the grassy bank above it is ~0.5 R wide). Big lakes: a low rim, a gentle
    //     beach and a smooth deep bowl.
    for (let o = 0; o < LAK_N; o += 4) {
      const dx = x - LAK[o], dz = z - LAK[o + 1];
      const R = LAK[o + 2], small = R < SMALL_LAKE_R, lim = small ? R * 3.1 : R + 135;
      const d2 = dx * dx + dz * dz;
      if (d2 >= lim * lim) continue;
      const d = Math.sqrt(d2) + R * (small ? 0.07 : 0.12) * (G.noise2(x * 1.4 / R + 1, z * 1.4 / R + 3) + 0.5 * G.noise2(x * 3.1 / R - 2, z * 3.1 / R + 5));
      let bowl, rs;
      if (small) {
        const hol = ss(R * 3, R * 1.4, d);
        if (hol > 0) h += (LAKE_RIM_SMALL + (h - LAKE_RIM_SMALL) * 0.16 - h) * hol;
        bowl = ss(R * 1.45, R * 0.3, d);
        if (bowl > 0) h += (-LAK[o + 3] + 0.5 * meso + 0.2 * micro - h) * bowl;
        rs = ss(R * 1.5, R * 0.9, d);
      } else {
        const rim = ss(R + 130, R + 12, d);
        if (rim > 0) h += (LAKE_RIM + (h - LAKE_RIM) * 0.25 - h) * rim;
        const bank = ss(R + 12, R - 10, d);
        if (bank > 0) h += (-0.4 + 0.3 * meso + 0.2 * micro - h) * bank;
        rs = ss(R + 40, R + 4, d);
        bowl = ss(R - 8, R * 0.5, d);
        if (bowl > 0) h += (-LAK[o + 3] + 2 * macro + 0.5 * meso - h) * bowl;
        if (bank > bowl) bowl = bank;
      }
      if (rs > shore) { shore = rs; sandH = small ? SAND_POND : SAND_LAKE; }
      // towns/roads hand over to the lake as soon as the bank starts (their level ground reaches the top of the bank)
      const lw = ss(0, 0.2, bowl);
      if (lw > lake) lake = lw;
    }
    // --- isles inside lakes (Tinnudir)
    for (let o = 0; o < LISL_N; o += 4) {
      const dx = x - LISL[o], dz = z - LISL[o + 1];
      const R = LISL[o + 2];
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R) continue;
      const isl = ss(R, R * 0.55, Math.sqrt(d2) + R * 0.07 * G.noise2(x * 0.03 + 4, z * 0.03 - 6));
      h += (LISL[o + 3] + 1.5 * meso + micro - h) * isl;
      lake *= 1 - isl;
    }
    // --- the sheltered valley of Rivendell
    {
      const dx = x - VAL_X, dz = z - VAL_Z;
      const d2 = dx * dx + dz * dz;
      if (d2 < VAL_R2) {
        valley = ss(VAL_R, VAL_R * 0.53, Math.sqrt(d2) + 12 * G.noise2(x * 0.02 + 1, z * 0.02 + 9));
        h += (VALLEY_FLOOR + (h - VALLEY_FLOOR) * 0.25 - h) * valley;
      }
    }
    L_sea = sea; L_lake = lake; L_shoreBase = shore; L_sandH = sandH; L_valley = valley;
    return h;
  }

  // ---------------------------------------------------------------- the height field (roads, towns, rivers on top)
  function height(x, z) {
    if (x !== x || z !== z) return SEA;
    let h = baseH(x, z, false);
    const micro = L_micro, lake = L_lake, valley = L_valley;
    let water = L_sea > lake ? L_sea : lake;
    let shore = L_shoreBase, sandH = L_sandH;
    let cx = ((x + HALF) * INV_CELL) | 0; if (cx < 0) cx = 0; else if (cx >= GC) cx = GC - 1;
    let cz = ((z + HALF) * INV_CELL) | 0; if (cz < 0) cz = 0; else if (cz >= GC) cz = GC - 1;
    const cell = cx * GC + cz;
    // --- settlement core: full inside 0.55 R, fading to the open country by R (noisy edge); earth = core × style fill
    let settle = 0, earth = 0;
    let k0 = TC_START[cell], k1 = TC_START[cell + 1];
    for (let k = k0; k < k1; k++) {
      const o = TC_ITEMS[k] * TS;
      const dx = x - TWN[o], dz = z - TWN[o + 1];
      const R = TWN[o + 2];
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R * 1.35) continue;
      const core = ss(R, R * 0.55, Math.sqrt(d2) + R * 0.1 * micro);
      if (core > settle) settle = core;
      const e = core * TWN[o + 4];
      if (e > earth) earth = e;
    }
    // --- roads: flatten to a smoothed road elevation (macro relief only), blend over a band that widens with the cut;
    //     inside settlements the worn surface spreads wider (paths across the square)
    let roadW = 0, roadCore = 0;
    k0 = RC_START[cell]; k1 = RC_START[cell + 1];
    if (k1 > k0) {
      let bd2 = 1e18, bt = 0, bs = -1;
      for (let k = k0; k < k1; k++) {
        const o = RC_ITEMS[k] * RS;
        const ax = RSEG[o], az = RSEG[o + 1], dx = RSEG[o + 4], dz = RSEG[o + 5];
        let t = ((x - ax) * dx + (z - az) * dz) * RSEG[o + 6];
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - x, qz = az + dz * t - z;
        const d2 = qx * qx + qz * qz;
        if (d2 < bd2) { bd2 = d2; bt = t; bs = o; }
      }
      const hw = RSEG[bs + 7];
      const d = Math.sqrt(bd2);
      if (d < hw + 50) {
        const px = RSEG[bs] + RSEG[bs + 4] * bt, pz = RSEG[bs + 1] + RSEG[bs + 5] * bt;
        let hr = baseH(px, pz, true);
        let overWater = 0;
        if (L_lake > 0.02 || L_sea > 0.02) {               // causeway across water
          const cw = CAUSEWAY_H + 0.15 * G.noise2(px * 0.05, pz * 0.05);
          if (hr < cw) { overWater = L_lake > L_sea ? L_lake : L_sea; hr = cw; }
        }
        const diff = hr - h;
        let band = (diff < 0 ? -diff : diff) * 1.5;
        if (band > 42) band = 42;
        band = 6 + band * (1 - overWater) + 2 * overWater;
        const w = ss(hw + band, hw, d);
        h += diff * w;
        roadCore = ss(hw + 4, hw, d);
        roadW = ss(hw + 2.5 + 4 * settle, hw - 1, d + 1.2 * G.noise2(x * 0.23 + 5, z * 0.23));
        water *= 1 - roadCore;
      }
    }
    // --- towns: flatten toward the height at the town centre (outer 30% blends); lakes and their banks are never filled in
    let townW = 0;
    k0 = TC_START[cell]; k1 = TC_START[cell + 1];
    for (let k = k0; k < k1; k++) {
      const o = TC_ITEMS[k] * TS;
      const dx = x - TWN[o], dz = z - TWN[o + 1];
      const R = TWN[o + 2];
      const d2 = dx * dx + dz * dz;
      if (d2 >= (R + 92) * (R + 92)) continue;
      const th = TWN[o + 3] + 0.3 * micro;
      let band = (th > h ? th - h : h - th) * 1.5;
      if (band > 90) band = 90;
      const w = ss(R + band, R * 0.7, Math.sqrt(d2));
      if (w <= 0) continue;
      // inside a lake's bowl a town may only lower the ground, never raise it: the bank keeps its gentle profile
      const tgt = (lake > 0 && th > h) ? h + (th - h) * (1 - lake) : th;
      h += (tgt - h) * w;
      if (w > townW) townW = w;
      water *= 1 - w * (1 - lake);
    }
    // --- rivers: soft banks, then a carved bed (shallow fords where roads cross); the Rivendell stream only inside the valley
    k0 = VC_START[cell]; k1 = VC_START[cell + 1];
    if (k1 > k0) {
      const wx = x + 7 * G.fbm(x * 0.0083 + 31, z * 0.0083 + 17, 2, 2, 0.5);
      const wz = z + 7 * G.fbm(x * 0.0083 - 13, z * 0.0083 + 43, 2, 2, 0.5);
      let bd2 = 1e18, bs = -1;
      for (let k = k0; k < k1; k++) {
        const o = VC_ITEMS[k] * VS;
        const ax = VSEG[o], az = VSEG[o + 1], dx = VSEG[o + 4], dz = VSEG[o + 5];
        let t = ((wx - ax) * dx + (wz - az) * dz) * VSEG[o + 6];
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - wx, qz = az + dz * t - wz;
        const d2 = qx * qx + qz * qz;
        if (d2 < bd2) { bd2 = d2; bs = o; }
      }
      const hw = VSEG[bs + 7];
      const d = Math.sqrt(bd2);
      if (d < hw + 60) {
        const kf = VSEG[bs + 9] > 0 ? ss(0.3, 0.7, valley) : 1;
        if (kf > 0) {
          const bb = hw * 6 + 10 > 60 ? 60 : hw * 6 + 10;
          const bank = ss(hw + bb, hw + 9, d) * kf;
          const bh = RIVER_BANK + 0.5 * micro;
          h += (bh - h) * (0.55 + 0.45 * ss(hw + bb * 0.45, hw + 6, d)) * bank;
          const carve = ss(hw + 6, hw - 3, d) * kf;
          const bed = VSEG[bs + 8] + (FORD_BED - VSEG[bs + 8]) * roadCore + 0.35 * micro;
          h += (bed - h) * carve;
          const sb = bank * bank * bank * bank * bank;
          if (sb > shore) { shore = sb; sandH = SAND_RIVER; }
          if (carve > water) water = carve;
        }
      }
    }
    if (h < -40) h = -40; else if (h > 400) h = 400;
    // sand only in a narrow band above the water line (width set by the shore kind: sea beach > lake beach > pond rim)
    L_road = roadW; L_roadCore = roadCore; L_town = townW; L_water = water;
    L_shore = shore > 0 ? shore * ss(sandH, sandH * 0.3, h) : 0;
    L_settle = settle; L_earth = earth * (1 - lake);
    return h;
  }

  // ---------------------------------------------------------------- derived queries
  const _n = { x: 0, y: 1, z: 0 };
  function normal(x, z, out) {
    const e = 0.4;
    const hl = height(x - e, z), hr = height(x + e, z), hu = height(x, z - e), hd = height(x, z + e);
    let nx = hl - hr, nz = hu - hd;
    const l = 1 / Math.sqrt(nx * nx + 4 * e * e + nz * nz);
    if (!out) out = _n;
    out.x = nx * l; out.y = 2 * e * l; out.z = nz * l;
    return out;
  }
  function slope(x, z) {
    normal(x, z, _n);
    const ny = _n.y;
    const s = 1 - ny * ny;
    return s <= 0 ? 0 : Math.sqrt(s);
  }
  function isWater(x, z) { return height(x, z) < SEA; }
  function waterDepth(x, z) { const d = SEA - height(x, z); return d > 0 ? d : 0; }

  function zoneIndexAt(x, z) {
    let best = -1, bw = 0;
    for (let i = 0; i < ZONES.length; i++) {
      const o = i * ZS;
      const dx = x - ZT[o], dz = z - ZT[o + 1];
      const d2 = dx * dx + dz * dz;
      if (d2 >= ZT[o + Z_S2]) continue;
      const t = 1 - d2 * ZT[o + Z_INVS2];
      const w = t * t;
      if (w > bw) { bw = w; best = i; }
    }
    if (best >= 0 && bw >= FALLBACK_W) return best;
    // open sea / gaps between zones
    if (x < COAST_X || z < COAST_Z || best < 0) {
      let nb = -1, nd = 1e18;
      for (let i = 0; i < ZONES.length; i++) {
        const o = i * ZS;
        const dx = x - ZT[o], dz = z - ZT[o + 1];
        const r = ZT[o + Z_R] || 1;
        const d = (dx * dx + dz * dz) / (r * r);
        if (d < nd) { nd = d; nb = i; }
      }
      if (x < COAST_X || z < COAST_Z) return nb;
    }
    const fb = ZONE_BY_ID[FALLBACK_BIOME];
    return fb ? fb._index : best;
  }
  function zoneAt(x, z) {
    if (!ZONES.length) return FALLBACK_BIOME;
    const i = zoneIndexAt(x, z);
    return i >= 0 ? ZONE_IDS[i] : FALLBACK_BIOME;
  }
  function biomeAt(x, z) {
    const zn = ZONE_BY_ID[zoneAt(x, z)];
    return zn ? (zn.biome || FALLBACK_BIOME) : FALLBACK_BIOME;
  }
  function zoneWeight(id, x, z) {
    const zn = ZONE_BY_ID[id];
    if (!zn) return 0;
    const o = zn._index * ZS;
    const dx = x - ZT[o], dz = z - ZT[o + 1];
    const d2 = dx * dx + dz * dz;
    if (d2 >= ZT[o + Z_S2]) return 0;
    const t = 1 - d2 * ZT[o + Z_INVS2];
    return t * t;
  }

  function roadDistance(x, z) {                  // → distance to nearest road centre line & sets _rdHalf/_rdX/_rdZ
    let cx = ((x + HALF) * INV_CELL) | 0; if (cx < 0) cx = 0; else if (cx >= GC) cx = GC - 1;
    let cz = ((z + HALF) * INV_CELL) | 0; if (cz < 0) cz = 0; else if (cz >= GC) cz = GC - 1;
    const cell = cx * GC + cz;
    let k0 = RC_START[cell], k1 = RC_START[cell + 1];
    let bd2 = 1e18, bt = 0, bs = -1;
    if (k1 > k0) {
      for (let k = k0; k < k1; k++) {
        const o = RC_ITEMS[k] * RS;
        const ax = RSEG[o], az = RSEG[o + 1], dx = RSEG[o + 4], dz = RSEG[o + 5];
        let t = ((x - ax) * dx + (z - az) * dz) * RSEG[o + 6];
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - x, qz = az + dz * t - z;
        const d2 = qx * qx + qz * qz;
        if (d2 < bd2) { bd2 = d2; bt = t; bs = o; }
      }
    } else {                                     // nothing bucketed here: brute force (rare, non-hot)
      for (let o = 0; o < NRS * RS; o += RS) {
        const ax = RSEG[o], az = RSEG[o + 1], dx = RSEG[o + 4], dz = RSEG[o + 5];
        let t = ((x - ax) * dx + (z - az) * dz) * RSEG[o + 6];
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + dx * t - x, qz = az + dz * t - z;
        const d2 = qx * qx + qz * qz;
        if (d2 < bd2) { bd2 = d2; bt = t; bs = o; }
      }
    }
    if (bs < 0) { _rdHalf = 3; _rdX = x; _rdZ = z; return 1e9; }
    _rdHalf = RSEG[bs + 7]; _rdX = RSEG[bs] + RSEG[bs + 4] * bt; _rdZ = RSEG[bs + 1] + RSEG[bs + 5] * bt;
    return Math.sqrt(bd2);
  }
  let _rdHalf = 3, _rdX = 0, _rdZ = 0;
  function onRoad(x, z) {
    if (!NRS) return 0;
    const d = roadDistance(x, z);
    if (d > _rdHalf + 4) return 0;
    return ss(_rdHalf + 2.5, _rdHalf - 1, d + 1.2 * G.noise2(x * 0.23 + 5, z * 0.23));
  }
  function nearestRoadPoint(x, z, out) {
    out = out || { x: 0, z: 0, dist: 0 };
    if (!NRS) { out.x = x; out.z = z; out.dist = Infinity; return out; }
    const d = roadDistance(x, z);
    out.x = _rdX; out.z = _rdZ; out.dist = d;
    return out;
  }
  function townAt(x, z) {
    for (let i = 0; i < TOWNS.length; i++) {
      const t = TOWNS[i], o = i * TS;
      const dx = x - TWN[o], dz = z - TWN[o + 1];
      if (dx * dx + dz * dz < TWN[o + 2] * TWN[o + 2]) return t;
    }
    return null;
  }

  function groundType(x, z) {
    const h = height(x, z);
    if (h < SEA - 0.3) return 'water';
    const road = L_road, sand = L_shore, earth = L_earth;
    if (road > 0.5) return 'road';
    blendC(x, z, h);
    const sl = slope(x, z);
    if (C[7] > 0.5 && sl < 0.8) return 'snow';
    if (C[6] * (1 - ss(0.55, 0.85, sl)) > 0.5) return 'snow';
    if (sl > 0.55 || C[10] * ss(0.35, 0.6, sl) > 0.5) return 'stone';
    if (sand > 0.35) return 'sand';
    if (earth > 0.5 || road > 0.2) return 'dirt';       // settlement squares & worn paths (hobbit villages stay grass between the paths)
    return 'grass';
  }

  // ---------------------------------------------------------------- data ingestion (init)
  function defaultWater() {
    return {
      seaWestX: -1500, seaNorthZ: -1650,
      lakes: [
        { id: 'nenuial', center: { x: -250, z: -900 }, radius: 260 },
        { id: 'bywater_pool', center: { x: -1000, z: -120 }, radius: 40 },
        { id: 'lonelands_tarn', center: { x: 700, z: 120 }, radius: 45 },
      ],
      rivers: [
        { id: 'brandywine', width: 12, points: [{ x: -700, z: -1500 }, { x: -650, z: -600 }, { x: -600, z: 0 }, { x: -560, z: 600 }, { x: -520, z: 1400 }] },
        { id: 'hoarwell', width: 12, points: [{ x: 1100, z: -1300 }, { x: 1050, z: -300 }, { x: 1000, z: 300 }] },
      ],
      bays: [{ id: 'forochel_icebay', center: { x: 450, z: -1980 }, radius: 130 }],
      landmasses: [{ id: 'forochel', center: { x: 600, z: -1850 }, radius: 300 }],
      islands: [
        { id: 'tolfuin', center: { x: -1800, z: -1500 }, radius: 187 },
        { id: 'himling', center: { x: -1750, z: -400 }, radius: 204 },
        { id: 'tolmorwen', center: { x: -1850, z: 700 }, radius: 153 },
        { id: 'tinnudir', center: { x: -200, z: -1050 }, radius: 90 },
      ],
    };
  }

  function linearRGB(hex, out, o) {
    const c = (G.colorHex && typeof THREE !== 'undefined') ? G.colorHex(hex) : null;
    if (c) { out[o] = c.r; out[o + 1] = c.g; out[o + 2] = c.b; return; }
    // manual sRGB → linear
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    out[o] = f(hex >> 16 & 255); out[o + 1] = f(hex >> 8 & 255); out[o + 2] = f(hex & 255);
  }

  function buildZoneTable(zones) {
    ZONES = []; ZONE_IDS = []; ZONE_BY_ID = {};
    for (let i = 0; i < zones.length; i++) {
      const zn = zones[i];
      if (!zn || !zn.id || !zn.center) continue;
      ZONES.push(zn);
    }
    NZ = ZONES.length * ZS;
    ZT = new Float64Array(NZ);
    const tmp = new Float64Array(3);
    for (let i = 0; i < ZONES.length; i++) {
      const zn = ZONES[i], o = i * ZS;
      zn._index = i;
      ZONE_IDS.push(zn.id); ZONE_BY_ID[zn.id] = zn;
      const bkey = String(zn.biome || 'wild').split('/')[0].trim();
      const bp = BIOME[bkey] || BIOME.wild;
      const R = Math.max(40, num(zn.radius, 300));
      const S = R * SUPPORT;
      const rough = clamp(num(zn.roughness, 0.5), 0.05, 1.5);
      const rf = rough / 0.5;
      const mtn = clamp(num(zn.mountain, bp.ridge / 120), 0, 1.5);
      const base = num(zn.baseHeight, bp.base);
      const ridge = 120 * mtn;
      ZT[o + Z_CX] = zn.center.x; ZT[o + Z_CZ] = zn.center.z; ZT[o + Z_R] = R;
      ZT[o + Z_S2] = S * S; ZT[o + Z_INVS2] = 1 / (S * S);
      ZT[o + Z_BASE] = base;
      ZT[o + Z_MAC] = bp.macro * (0.75 + 0.25 * rf);
      ZT[o + Z_MES] = bp.meso * (0.5 + 0.5 * rf);
      ZT[o + Z_MIC] = bp.micro * (0.5 + 0.5 * rf);
      ZT[o + Z_RID] = ridge;
      ZT[o + Z_DWN] = bp.downs || 0;
      ZT[o + Z_PLA] = bp.plateau || 0;
      ZT[o + Z_ICE] = bp.ice || 0;
      ZT[o + Z_CRG] = (bp.crag || 0) * (0.5 + rf * 0.5) + mtn * 3;
      ZT[o + Z_SNOW] = ridge >= 36 ? base + ridge * 0.5 + 12 : 1e9;
      ZT[o + Z_MTN] = ss(0.15, 0.5, mtn);
      linearRGB(hexOf(zn.grassColor, 0x6f9a3a), tmp, 0);
      ZT[o + Z_GR] = tmp[0]; ZT[o + Z_GG] = tmp[1]; ZT[o + Z_GB] = tmp[2];
      linearRGB(hexOf(zn.groundColor, 0x7d6c48), tmp, 0);
      ZT[o + Z_DR] = tmp[0]; ZT[o + Z_DG] = tmp[1]; ZT[o + Z_DB] = tmp[2];
      ZT[o + Z_FOR] = bp.forest || 0;
      ZT[o + Z_MARSH] = bp.marsh || 0;
      ZT[o + Z_ROCK] = clamp(mtn * 1.2 + (bkey === 'barren' ? 0.35 : 0), 0, 1);
      ZT[o + Z_LEVEL] = Array.isArray(zn.level) ? num(zn.level[0], 1) : 1;
      ZT[o + Z_HILL] = (bp.hill || 0) * (0.7 + 0.3 * rf);
    }
    const fbz = ZONE_BY_ID[FALLBACK_BIOME];
    const bp = BIOME[FALLBACK_BIOME];
    FB = { base: fbz ? num(fbz.baseHeight, bp.base) : bp.base, macro: bp.macro, meso: bp.meso, micro: bp.micro, hill: bp.hill || 0 };
    linearRGB(fbz ? hexOf(fbz.grassColor, 0x6b9744) : 0x6b9744, tmp, 0); FB.gr = tmp[0]; FB.gg = tmp[1]; FB.gb = tmp[2];
    linearRGB(fbz ? hexOf(fbz.groundColor, 0x7d6c48) : 0x7d6c48, tmp, 0); FB.dr = tmp[0]; FB.dg = tmp[1]; FB.db = tmp[2];
  }

  // CSR bucket builder: items = [{minX,maxX,minZ,maxZ}] → [start Uint32Array(GC*GC+1), items Uint32Array]
  function buildBuckets(boxes) {
    const n = GC * GC;
    const counts = new Uint32Array(n + 1);
    const ranges = new Int32Array(boxes.length * 4);
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      const x0 = clamp(Math.floor((b.minX + HALF) * INV_CELL), 0, GC - 1), x1 = clamp(Math.floor((b.maxX + HALF) * INV_CELL), 0, GC - 1);
      const z0 = clamp(Math.floor((b.minZ + HALF) * INV_CELL), 0, GC - 1), z1 = clamp(Math.floor((b.maxZ + HALF) * INV_CELL), 0, GC - 1);
      ranges[i * 4] = x0; ranges[i * 4 + 1] = x1; ranges[i * 4 + 2] = z0; ranges[i * 4 + 3] = z1;
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) counts[cx * GC + cz + 1]++;
    }
    for (let c = 0; c < n; c++) counts[c + 1] += counts[c];
    const items = new Uint32Array(counts[n]);
    const fill = new Uint32Array(n);
    for (let i = 0; i < boxes.length; i++) {
      for (let cx = ranges[i * 4]; cx <= ranges[i * 4 + 1]; cx++) for (let cz = ranges[i * 4 + 2]; cz <= ranges[i * 4 + 3]; cz++) {
        const c = cx * GC + cz;
        items[counts[c] + fill[c]++] = i;
      }
    }
    return [counts, items];
  }

  function ingestWorld() {
    const world = (G.Data && G.Data.world) ? G.Data.world : null;
    if (!world) G.warn ? G.warn('G.Terrain: G.Data.world missing — building a bare fallback world') : 0;
    const zones = (world && Array.isArray(world.zones)) ? world.zones : [];
    buildZoneTable(zones);
    const water = (world && world.water) ? world.water : defaultWater();
    const dw = defaultWater();
    COAST_X = num(water.seaWestX, dw.seaWestX);
    COAST_Z = num(water.seaNorthZ, dw.seaNorthZ);

    // --- lakes & bays
    LAKES = [];
    const lakeList = Array.isArray(water.lakes) ? water.lakes : dw.lakes;
    const bayList = Array.isArray(water.bays) ? water.bays : dw.bays;
    const lakeArr = [];
    for (const lk of lakeList.concat(bayList)) {
      if (!lk || !lk.center) continue;
      const R = Math.max(15, num(lk.radius, 40));
      let depth = num(lk.depth, clamp(R * 0.055, 4, 14));
      if (R < SMALL_LAKE_R && depth > SMALL_LAKE_DEPTH) depth = SMALL_LAKE_DEPTH;      // ponds and tarns stay shallow
      lakeArr.push(lk.center.x, lk.center.z, R, depth);
      LAKES.push({ id: lk.id, x: lk.center.x, z: lk.center.z, r: R, depth: depth, name: lk.name || lk.id });
    }
    LAK = new Float64Array(lakeArr); LAK_N = lakeArr.length;

    // --- islands (sea) vs isles inside lakes; landmasses behave like islands
    const islArr = [], lislArr = [];
    const islList = (Array.isArray(water.islands) ? water.islands : dw.islands).concat(Array.isArray(water.landmasses) ? water.landmasses : dw.landmasses);
    for (const isl of islList) {
      if (!isl || !isl.center) continue;
      const R = Math.max(20, num(isl.radius, 150));
      let inLake = false;
      for (let o = 0; o < LAK_N; o += 4) {
        const dx = isl.center.x - LAK[o], dz = isl.center.z - LAK[o + 1];
        if (dx * dx + dz * dz < LAK[o + 2] * LAK[o + 2]) { inLake = true; break; }
      }
      if (inLake) lislArr.push(isl.center.x, isl.center.z, R, num(isl.height, 6));
      else islArr.push(isl.center.x, isl.center.z, R);
    }
    ISL = new Float64Array(islArr); ISL_N = islArr.length;
    LISL = new Float64Array(lislArr); LISL_N = lislArr.length;

    // --- Rivendell valley (town position if known)
    const towns = (world && Array.isArray(world.towns)) ? world.towns : [];
    const riv = towns.find((t) => t && t.id === 'rivendell' && t.pos);
    if (riv) { VAL_X = riv.pos.x; VAL_Z = riv.pos.z; VAL_R = Math.max(200, num(riv.radius, 110) * 2.1); }
    VAL_R2 = VAL_R * VAL_R;

    // --- rivers (+ the Rivendell stream, valley-only)
    RIVERS = [];
    const riverList = (Array.isArray(water.rivers) ? water.rivers : dw.rivers).slice();
    riverList.push({ id: 'bruinen_stream', name: 'The Bruinen', width: 8, bed: -1.8, valleyOnly: true,
      points: [{ x: VAL_X + 95, z: VAL_Z - 205 }, { x: VAL_X + 130, z: VAL_Z - 95 }, { x: VAL_X + 136, z: VAL_Z + 25 }, { x: VAL_X + 104, z: VAL_Z + 140 }, { x: VAL_X + 45, z: VAL_Z + 215 }] });
    const vseg = [], vbox = [];
    for (const rv of riverList) {
      if (!rv || !Array.isArray(rv.points) || rv.points.length < 2) continue;
      const hw = Math.max(1.5, num(rv.width, 12) * 0.5);
      const bed = num(rv.bed, RIVER_BED);
      const vo = rv.valleyOnly ? 1 : 0;
      RIVERS.push({ id: rv.id, name: rv.name || rv.id, width: hw * 2, points: rv.points });
      for (let i = 0; i + 1 < rv.points.length; i++) {
        const a = rv.points[i], b = rv.points[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1e-6) continue;
        vseg.push(a.x, a.z, b.x, b.z, dx, dz, 1 / l2, hw, bed, vo);
        const m = hw + 60 + 16;
        vbox.push({ minX: Math.min(a.x, b.x) - m, maxX: Math.max(a.x, b.x) + m, minZ: Math.min(a.z, b.z) - m, maxZ: Math.max(a.z, b.z) + m });
      }
    }
    VSEG = new Float64Array(vseg); NVS = vbox.length;
    [VC_START, VC_ITEMS] = buildBuckets(vbox);

    // --- roads
    const roads = (world && Array.isArray(world.roads)) ? world.roads : [];
    const rseg = [], rbox = [];
    for (const rd of roads) {
      if (!rd || !Array.isArray(rd.points) || rd.points.length < 2) continue;
      const hw = Math.max(1, num(rd.width, 6) * 0.5);
      for (let i = 0; i + 1 < rd.points.length; i++) {
        const a = rd.points[i], b = rd.points[i + 1];
        const dx = b.x - a.x, dz = b.z - a.z;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1e-6) continue;
        rseg.push(a.x, a.z, b.x, b.z, dx, dz, 1 / l2, hw);
        const m = hw + 52;
        rbox.push({ minX: Math.min(a.x, b.x) - m, maxX: Math.max(a.x, b.x) + m, minZ: Math.min(a.z, b.z) - m, maxZ: Math.max(a.z, b.z) + m });
      }
    }
    RSEG = new Float64Array(rseg); NRS = rbox.length;
    [RC_START, RC_ITEMS] = buildBuckets(rbox);

    // --- towns (centre heights computed from the base field, never below the water)
    TOWNS = [];
    const tarr = [], tbox = [];
    const docks = (world && Array.isArray(world.docks)) ? world.docks : [];
    for (const tw of towns) {
      if (!tw || !tw.pos) continue;
      const R = Math.max(12, num(tw.radius, 60));
      TOWNS.push(tw);
      let th = baseH(tw.pos.x, tw.pos.z, false);
      const coastal = L_shoreBase;
      let hasDock = !!tw.hasDock;
      for (let i = 0; i < docks.length && !hasDock; i++) if (docks[i] && docks[i].town === tw.id) hasDock = true;
      if (hasDock && coastal > 0.02 && th > 5.5) th = 5.5;                                                // harbour towns sit at the water line
      else if (coastal > 0.15 && th > 5) th = th + (5 + 4 * (1 - coastal) - th) * ss(0.15, 0.6, coastal);  // other shore towns hug it
      th = Math.max(TOWN_MIN_H, th);
      const fill = num(tw.groundFill, num(TOWN_EARTH[String(tw.style || '').toLowerCase()], 0.8));
      tarr.push(tw.pos.x, tw.pos.z, R, th, clamp(fill, 0, 1));
      tbox.push({ minX: tw.pos.x - R - 94, maxX: tw.pos.x + R + 94, minZ: tw.pos.z - R - 94, maxZ: tw.pos.z + R + 94 });
    }
    TWN = new Float64Array(tarr); NTW = tbox.length;
    [TC_START, TC_ITEMS] = buildBuckets(tbox);
  }

  // ---------------------------------------------------------------- coarse world grid (8 m) + baked height texture data
  let GRID = null, GRID_CELL = 8, HTEX_DATA = null;
  function buildGrid() {
    GRID_CELL = WORLD_SIZE / GRID_N;
    GRID = new Float32Array(GRID_N * GRID_N);
    HTEX_DATA = new Uint8Array(GRID_N * GRID_N * 4);
    for (let j = 0; j < GRID_N; j++) {
      const z = -HALF + (j + 0.5) * GRID_CELL;
      for (let i = 0; i < GRID_N; i++) {
        const x = -HALF + (i + 0.5) * GRID_CELL;
        const h = height(x, z);
        const k = j * GRID_N + i;
        GRID[k] = h;
        const rel = h - SEA;
        const a = rel < 0 ? -rel : rel;
        let e = Math.sqrt(a > 40 ? 1 : a / 40);
        if (rel < 0) e = -e;
        HTEX_DATA[k * 4] = Math.round((0.5 + 0.5 * e) * 255);
        HTEX_DATA[k * 4 + 1] = Math.round(L_road * 255);
        HTEX_DATA[k * 4 + 2] = Math.round(L_shore * 255);
        HTEX_DATA[k * 4 + 3] = 255;
      }
    }
  }
  function coarseHeight(x, z) {
    if (!GRID) return height(x, z);
    const fx = (x + HALF) / GRID_CELL - 0.5, fz = (z + HALF) / GRID_CELL - 0.5;
    if (!(fx >= 0 && fz >= 0 && fx < GRID_N - 1 && fz < GRID_N - 1)) return height(x, z);
    const i = fx | 0, j = fz | 0;
    const tx = fx - i, tz = fz - j;
    const k = j * GRID_N + i;
    const h0 = GRID[k] + (GRID[k + 1] - GRID[k]) * tx;
    const h1 = GRID[k + GRID_N] + (GRID[k + GRID_N + 1] - GRID[k + GRID_N]) * tx;
    return h0 + (h1 - h0) * tz;
  }

  // ---------------------------------------------------------------- palette (linear) & vertex colour function
  const PAL = new Float64Array(3 * 16);
  const P_ROCK = 0, P_ROCK_DARK = 3, P_SNOW = 6, P_SNOW_SHADE = 9, P_ROAD = 12, P_ROAD2 = 15, P_SAND = 18, P_SAND_WET = 21,
    P_MUD = 24, P_DEEP = 27, P_MOSS = 30, P_MARSH = 33, P_SCREE = 36, P_ICE = 39, P_PATH = 42;
  function preparePalette() {
    linearRGB(0x7d7770, PAL, P_ROCK); linearRGB(0x4a4643, PAL, P_ROCK_DARK); linearRGB(0xf5f8fb, PAL, P_SNOW);
    linearRGB(0xc2d1e3, PAL, P_SNOW_SHADE); linearRGB(0x7c6647, PAL, P_ROAD); linearRGB(0x98805e, PAL, P_ROAD2);
    linearRGB(0xdccb9c, PAL, P_SAND); linearRGB(0x9a8b66, PAL, P_SAND_WET); linearRGB(0x56603f, PAL, P_MUD);
    linearRGB(0x26363a, PAL, P_DEEP); linearRGB(0x3c6a2c, PAL, P_MOSS); linearRGB(0x5f6d3a, PAL, P_MARSH);
    linearRGB(0x8f8a80, PAL, P_SCREE); linearRGB(0xd8e8f4, PAL, P_ICE); linearRGB(0xb3a07c, PAL, P_PATH);
  }
  const _col = { r: 0, g: 0, b: 0 };
  // sand = sand weight (shore × height band, from height()), earth = packed-earth settlement weight (0..1)
  function colorAt(x, z, h, sl, roadW, sand, earth, ridge, out) {
    blendC(x, z, h);
    const v1 = G.fbm(x * 0.022 + 3, z * 0.022 - 8, 2, 2, 0.5);
    const v2 = G.noise2(x * 0.00625 + 7, z * 0.00625 - 3);
    const v3 = G.noise2(x * 0.3 + 1, z * 0.3 + 2);
    let r = C[0], g = C[1], b = C[2];
    // hue drift: sunnier / cooler patches of grass
    const y = v2 * 0.16;
    r *= 1 + y; g *= 1 + y * 0.35; b *= 1 - y * 0.8;
    // forest floors are darker & mossier, marshes wet-green in the low ground
    const forest = C[8], marsh = C[9];
    if (forest > 0.01) {
      const f = forest * (0.3 + 0.35 * ss(0.2, -0.5, v1));
      r += (PAL[P_MOSS] - r) * f; g += (PAL[P_MOSS + 1] - g) * f; b += (PAL[P_MOSS + 2] - b) * f;
    }
    if (marsh > 0.01) {
      const f = marsh * (0.35 + 0.35 * ss(0.1, -0.5, v1)) * ss(6, 1.5, h);
      r += (PAL[P_MARSH] - r) * f; g += (PAL[P_MARSH + 1] - g) * f; b += (PAL[P_MARSH + 2] - b) * f;
    }
    // bare ground on moderate slopes and in noise pockets
    let dirtF = ss(0.18, 0.5, sl) * 0.65 + ss(0.5, 0.9, -v1) * 0.3;
    if (dirtF > 1) dirtF = 1;
    r += (C[3] - r) * dirtF; g += (C[4] - g) * dirtF; b += (C[5] - b) * dirtF;
    // settlement squares: trodden packed earth (the zone's ground colour, a touch darker and warmer), solid in the core,
    // breaking into grass patches toward the edge of the town
    if (earth > 0) {
      // grass survives in pockets (v1 patches × v3 tufts), so even the core is not one flat sheet of dust
      const ef = ss(0.06, 0.6, earth + 0.22 * v1 + 0.08 * v3) * (1 - 0.35 * ss(0.25, 0.6, v1) * ss(0.05, 0.5, v3));
      if (ef > 0) {
        const k = 0.72 + 0.12 * v3;
        r += (C[3] * k - r) * ef; g += (C[4] * k * 0.95 - g) * ef; b += (C[5] * k * 0.88 - b) * ef;
      }
    }
    // scree mottling in rocky zones
    const rockZ = C[10];
    if (rockZ > 0.05) {
      const f = rockZ * 0.4 * ss(0.0, 0.6, v1 + 0.3 * v3);
      r += (PAL[P_SCREE] - r) * f; g += (PAL[P_SCREE + 1] - g) * f; b += (PAL[P_SCREE + 2] - b) * f;
    }
    // rock on steep ground (sooner in rocky zones), darker on cliffs
    const rockF = ss(0.5 - 0.15 * rockZ, 0.78 - 0.15 * rockZ, sl);
    if (rockF > 0) {
      const dk = ss(0.7, 0.96, sl), hi = ss(40, 150, h);
      let rr = PAL[P_ROCK] + (PAL[P_SCREE] - PAL[P_ROCK]) * hi, rg = PAL[P_ROCK + 1] + (PAL[P_SCREE + 1] - PAL[P_ROCK + 1]) * hi, rb = PAL[P_ROCK + 2] + (PAL[P_SCREE + 2] - PAL[P_ROCK + 2]) * hi;
      rr = (rr + (PAL[P_ROCK_DARK] - rr) * dk) * 0.7 + C[3] * 0.3;
      rg = (rg + (PAL[P_ROCK_DARK + 1] - rg) * dk) * 0.7 + C[4] * 0.3;
      rb = (rb + (PAL[P_ROCK_DARK + 2] - rb) * dk) * 0.7 + C[5] * 0.3;
      r += (rr - r) * rockF; g += (rg - g) * rockF; b += (rb - b) * rockF;
    }
    // valley shading between the ridges (cheap ambient occlusion from the ridge field)
    if (ridge > 0.02) { const ao = 1 - 0.34 * ridge; r *= ao; g *= ao; b *= ao; }
    // snow: above the snow line in mountain zones, everywhere in the arctic (not on cliffs)
    let snowF = C[6] * (1 - ss(0.55, 0.85, sl)) + C[7] * (1 - ss(0.5, 0.8, sl)) * ss(-0.5, 0.8, h);
    if (snowF > 1) snowF = 1;
    if (snowF > 0) {
      const sh = ss(0.15, 0.6, sl) * 0.8 + 0.2 * ss(0.3, -0.4, v1);
      const sr = PAL[P_SNOW] + (PAL[P_SNOW_SHADE] - PAL[P_SNOW]) * sh;
      const sg = PAL[P_SNOW + 1] + (PAL[P_SNOW_SHADE + 1] - PAL[P_SNOW + 1]) * sh;
      const sb = PAL[P_SNOW + 2] + (PAL[P_SNOW_SHADE + 2] - PAL[P_SNOW + 2]) * sh;
      r += (sr - r) * snowF; g += (sg - g) * snowF; b += (sb - b) * snowF;
    }
    // beaches & banks near the water line (wet and darker right at it); the band width was decided in height()
    const sandF = sand * (1 - earth * 0.6) * (1 - snowF * 0.7);
    if (sandF > 0) {
      const wet = ss(0.6, -0.4, h);
      const sr = PAL[P_SAND] + (PAL[P_SAND_WET] - PAL[P_SAND]) * wet;
      const sg = PAL[P_SAND + 1] + (PAL[P_SAND_WET + 1] - PAL[P_SAND + 1]) * wet;
      const sb = PAL[P_SAND + 2] + (PAL[P_SAND_WET + 2] - PAL[P_SAND + 2]) * wet;
      r += (sr - r) * sandF; g += (sg - g) * sandF; b += (sb - b) * sandF;
    }
    // under the water: mud, then the deep floor
    const wetF = ss(0.2, -1.2, h);
    if (wetF > 0) {
      const f = wetF * 0.75;
      r += (PAL[P_MUD] - r) * f; g += (PAL[P_MUD + 1] - g) * f; b += (PAL[P_MUD + 2] - b) * f;
      const deep = ss(-1.5, -9, h) * 0.85;
      r += (PAL[P_DEEP] - r) * deep; g += (PAL[P_DEEP + 1] - g) * deep; b += (PAL[P_DEEP + 2] - b) * deep;
    }
    // packed-earth roads; inside settlements they become paler, dust-worn paths across the square
    if (roadW > 0) {
      const f = roadW * (1 - wetF);
      const t = 0.5 + 0.5 * v1;
      let rr = PAL[P_ROAD] + (PAL[P_ROAD2] - PAL[P_ROAD]) * t, rg = PAL[P_ROAD + 1] + (PAL[P_ROAD2 + 1] - PAL[P_ROAD + 1]) * t, rb = PAL[P_ROAD + 2] + (PAL[P_ROAD2 + 2] - PAL[P_ROAD + 2]) * t;
      if (earth > 0) {
        const w = earth * (0.55 + 0.2 * v3);
        rr += (PAL[P_PATH] - rr) * w; rg += (PAL[P_PATH + 1] - rg) * w; rb += (PAL[P_PATH + 2] - rb) * w;
      }
      r += (rr - r) * f; g += (rg - g) * f; b += (rb - b) * f;
    }
    // brightness variation
    const lum = 1 + 0.09 * v1 + 0.05 * v3;
    r *= lum; g *= lum; b *= lum;
    out.r = r < 0 ? 0 : r > 1 ? 1 : r;
    out.g = g < 0 ? 0 : g > 1 ? 1 : g;
    out.b = b < 0 ? 0 : b > 1 ? 1 : b;
    return out;
  }
  function groundColor(x, z, out) {
    out = out || { r: 0, g: 0, b: 0 };
    const sl = slope(x, z);
    const h = height(x, z);
    return colorAt(x, z, h, sl, L_road, L_shore, L_earth, L_ridge, out);
  }

  // ---------------------------------------------------------------- procedural textures (tileable)
  function tileNoise(u, v, freq, off) {
    const x = u * freq + off, y = v * freq + off * 0.7;
    const a = G.noise2(x, y), b = G.noise2(x - freq, y), c = G.noise2(x - freq, y - freq), d = G.noise2(x, y - freq);
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * u * v + d * (1 - u) * v;
  }
  // Three independent tileable noises packed per channel (see the terrain material's onBeforeCompile):
  //   .r mid-scale luminance mottling   .g slow field for macro hue/brightness drift   .b fine grain / grit
  function makeDetailTexture() {
    const N = 256;
    const tex = G.canvasTexture(N, N, function (ctx, w, h) {
      const img = ctx.createImageData(w, h);
      const d = img.data;
      const inv = 1 / w;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const u = px * inv, v = py * inv;
          const n = tileNoise(u, v, 5, 0) * 0.5 + tileNoise(u, v, 13, 11) * 0.3 + tileNoise(u, v, 41, 23) * 0.2;
          let val = 0.5 + n * 0.30;
          const hs = G.hash2(px, py);
          if (hs > 0.988) val += 0.18; else if (hs < 0.012) val -= 0.17;
          val = val < 0.20 ? 0.20 : val > 0.84 ? 0.84 : val;
          // .g — two slow octaves only (used at a ~57 m tile, so it must stay smooth)
          let gv = 0.5 + (tileNoise(u, v, 2, 51) * 0.68 + tileNoise(u, v, 5, 67) * 0.32) * 0.42;
          gv = gv < 0.14 ? 0.14 : gv > 0.86 ? 0.86 : gv;
          // .b — fine grit, sampled at a ~1.3 m tile for close-range texture
          let bvv = 0.5 + (tileNoise(u, v, 23, 89) * 0.5 + tileNoise(u, v, 53, 103) * 0.32) * 0.5;
          const gs = G.hash2(px + 977, py + 313);
          if (gs > 0.975) bvv += 0.14; else if (gs < 0.025) bvv -= 0.13;
          bvv = bvv < 0.22 ? 0.22 : bvv > 0.82 ? 0.82 : bvv;
          const k = (py * w + px) * 4;
          d[k] = Math.round(val * 255); d[k + 1] = Math.round(gv * 255); d[k + 2] = Math.round(bvv * 255); d[k + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }, { linear: true, anisotropy: 8 });
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  }
  function makeWaterNormalTexture() {
    const N = 256;
    const tex = G.canvasTexture(N, N, function (ctx, w, h) {
      const hf = new Float32Array(w * h);
      const inv = 1 / w;
      for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
        const u = px * inv, v = py * inv;
        hf[py * w + px] = tileNoise(u, v, 4, 3) * 0.55 + tileNoise(u, v, 9, 17) * 0.3 + tileNoise(u, v, 21, 29) * 0.15;
      }
      const img = ctx.createImageData(w, h);
      const d = img.data;
      const k = 2.2;
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const l = hf[py * w + ((px + w - 1) % w)], r = hf[py * w + ((px + 1) % w)];
          const up = hf[((py + h - 1) % h) * w + px], dn = hf[((py + 1) % h) * w + px];
          let nx = (l - r) * k, ny = (up - dn) * k;
          const nl = 1 / Math.sqrt(nx * nx + ny * ny + 1);
          nx *= nl; ny *= nl;
          const i = (py * w + px) * 4;
          d[i] = Math.round((nx * 0.5 + 0.5) * 255);
          d[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
          d[i + 2] = Math.round((0.5 + 0.5 * tileNoise(px * inv, py * inv, 7, 41)) * 255);
          d[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    }, { linear: true, anisotropy: 4 });
    tex.colorSpace = THREE.NoColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.needsUpdate = true;
    return tex;
  }

  // ---------------------------------------------------------------- chunk geometry (grid + skirts, pooled buffers)
  const INDEX = [null, null, null];
  function chunkIndex(lod) {
    if (INDEX[lod]) return INDEX[lod];
    const N = LOD_SEGS[lod], W = N + 1;
    const idx = new Uint16Array((N * N * 2 + 4 * N * 2) * 3);
    let p = 0;
    for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
      const a = iz * W + ix, b = (iz + 1) * W + ix, c = (iz + 1) * W + ix + 1, d = iz * W + ix + 1;
      idx[p++] = a; idx[p++] = b; idx[p++] = d;
      idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    const base = W * W;
    for (let ix = 0; ix < N; ix++) {            // north edge (z = z0), outward -z
      const t = ix, t1 = ix + 1, s = base + ix, s1 = s + 1;
      idx[p++] = t; idx[p++] = t1; idx[p++] = s; idx[p++] = t1; idx[p++] = s1; idx[p++] = s;
    }
    for (let ix = 0; ix < N; ix++) {            // south edge (z = z0 + CHUNK), outward +z
      const t = N * W + ix, t1 = t + 1, s = base + W + ix, s1 = s + 1;
      idx[p++] = t; idx[p++] = s; idx[p++] = t1; idx[p++] = t1; idx[p++] = s; idx[p++] = s1;
    }
    for (let iz = 0; iz < N; iz++) {            // west edge (x = x0), outward -x
      const t = iz * W, t1 = t + W, s = base + 2 * W + iz, s1 = s + 1;
      idx[p++] = t; idx[p++] = s; idx[p++] = t1; idx[p++] = t1; idx[p++] = s; idx[p++] = s1;
    }
    for (let iz = 0; iz < N; iz++) {            // east edge (x = x0 + CHUNK), outward +x
      const t = iz * W + N, t1 = t + W, s = base + 3 * W + iz, s1 = s + 1;
      idx[p++] = t; idx[p++] = t1; idx[p++] = s; idx[p++] = t1; idx[p++] = s1; idx[p++] = s;
    }
    INDEX[lod] = idx;
    return idx;
  }
  const HS = new Float32Array(52 * 52), RW = new Float32Array(52 * 52), SH = new Float32Array(52 * 52), TW = new Float32Array(52 * 52), RV = new Float32Array(52 * 52);
  const pool = [[], [], []];
  function allocArrays(lod) {
    const p = pool[lod];
    if (p.length) return p.pop();
    const W = LOD_SEGS[lod] + 1, VS = W * W + 4 * W;
    return { pos: new Float32Array(VS * 3), nrm: new Float32Array(VS * 3), col: new Float32Array(VS * 3), uv: new Float32Array(VS * 2) };
  }
  function recycle(lod, arrs) { if (arrs && lod >= 0 && pool[lod].length < 24) pool[lod].push(arrs); }

  function buildChunk(ci, cj, lod) {
    const N = LOD_SEGS[lod], W = N + 1, M = N + 3, step = CHUNK / N;
    const x0 = ci * CHUNK, z0 = cj * CHUNK;
    for (let gz = 0; gz < M; gz++) {
      const z = z0 + (gz - 1) * step;
      let i = gz * M;
      for (let gx = 0; gx < M; gx++, i++) {
        HS[i] = height(x0 + (gx - 1) * step, z);
        RW[i] = L_road; SH[i] = L_shore; TW[i] = L_earth; RV[i] = L_ridge;
      }
    }
    const arrs = allocArrays(lod);
    const pos = arrs.pos, nrm = arrs.nrm, col = arrs.col, uv = arrs.uv;
    const inv2s = 1 / (2 * step), invTile = 1 / DETAIL_TILE;
    let vi = 0, minY = 1e9, maxY = -1e9;
    for (let iz = 0; iz <= N; iz++) {
      const z = z0 + iz * step;
      let gi = (iz + 1) * M + 1;
      for (let ix = 0; ix <= N; ix++, gi++, vi++) {
        const x = x0 + ix * step;
        const h = HS[gi];
        let nx = (HS[gi - 1] - HS[gi + 1]) * inv2s, nz = (HS[gi - M] - HS[gi + M]) * inv2s;
        const l = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        nx *= l; nz *= l;
        const ny = l;
        const v3 = vi * 3;
        pos[v3] = x; pos[v3 + 1] = h; pos[v3 + 2] = z;
        nrm[v3] = nx; nrm[v3 + 1] = ny; nrm[v3 + 2] = nz;
        const s2 = 1 - ny * ny;
        colorAt(x, z, h, s2 <= 0 ? 0 : Math.sqrt(s2), RW[gi], SH[gi], TW[gi], RV[gi], _col);
        col[v3] = _col.r; col[v3 + 1] = _col.g; col[v3 + 2] = _col.b;
        uv[vi * 2] = x * invTile; uv[vi * 2 + 1] = z * invTile;
        if (h < minY) minY = h;
        if (h > maxY) maxY = h;
      }
    }
    // skirts: copies of the edge vertices dropped by SKIRT[lod]
    const drop = SKIRT[lod];
    const base = W * W;
    function skirt(dst, src) {
      const d3 = dst * 3, s3 = src * 3;
      pos[d3] = pos[s3]; pos[d3 + 1] = pos[s3 + 1] - drop; pos[d3 + 2] = pos[s3 + 2];
      nrm[d3] = nrm[s3]; nrm[d3 + 1] = nrm[s3 + 1]; nrm[d3 + 2] = nrm[s3 + 2];
      col[d3] = col[s3]; col[d3 + 1] = col[s3 + 1]; col[d3 + 2] = col[s3 + 2];
      uv[dst * 2] = uv[src * 2]; uv[dst * 2 + 1] = uv[src * 2 + 1];
    }
    for (let ix = 0; ix < W; ix++) { skirt(base + ix, ix); skirt(base + W + ix, N * W + ix); }
    for (let iz = 0; iz < W; iz++) { skirt(base + 2 * W + iz, iz * W); skirt(base + 3 * W + iz, iz * W + N); }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.setIndex(new THREE.BufferAttribute(chunkIndex(lod), 1));
    const cy = (minY + maxY) * 0.5, hy = (maxY - minY) * 0.5 + drop;
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(x0 + CHUNK * 0.5, cy, z0 + CHUNK * 0.5), Math.sqrt(CHUNK * CHUNK * 0.5 + hy * hy) + 1);
    geom.boundingBox = new THREE.Box3(new THREE.Vector3(x0, minY - drop, z0), new THREE.Vector3(x0 + CHUNK, maxY, z0 + CHUNK));
    return { geom: geom, arrs: arrs };
  }

  // ---------------------------------------------------------------- chunk manager
  const chunks = new Map();
  let queue = [];
  let group = null, material = null, horizon = null, horizonMat = null, detailTex = null;
  let built = false;
  let scanX = 1e9, scanZ = 1e9, scanTimer = 0;
  const stats = { builds: 0, buildMs: 0, maxBuildMs: 0, lastBuildMs: 0 };
  const lodCost = [3, 0.9, 0.3];              // running average build cost per LOD (ms), used to predict frame cost

  function ckey(ci, cj) { return (ci + 128) * 256 + (cj + 128); }
  function desiredLod(d, cur) {
    let lod = d < LOD_DIST[0] ? 0 : d < LOD_DIST[1] ? 1 : 2;
    if (cur >= 0 && lod > cur && d < LOD_DIST[cur] * 1.12) lod = cur;      // hysteresis against flip-flopping
    return lod;
  }
  function disposeChunk(rec) {
    if (rec.mesh) {
      group.remove(rec.mesh);
      rec.mesh.geometry.dispose();
      recycle(rec.lod, rec.arrs);
      rec.mesh = null; rec.arrs = null;
    }
    rec.lod = -1; rec.want = -1;
  }
  function scan(px, pz) {
    scanX = px; scanZ = pz; scanTimer = 0;
    const range = Math.ceil((VIEW_RADIUS + 91) / CHUNK);
    const pi = Math.floor(px / CHUNK), pj = Math.floor(pz / CHUNK);
    const minC = -HALF / CHUNK, maxC = HALF / CHUNK - 1;
    let changed = false;
    for (let i = pi - range; i <= pi + range; i++) {
      if (i < minC || i > maxC) continue;
      for (let j = pj - range; j <= pj + range; j++) {
        if (j < minC || j > maxC) continue;
        const dx = i * CHUNK + CHUNK * 0.5 - px, dz = j * CHUNK + CHUNK * 0.5 - pz;
        const d = Math.sqrt(dx * dx + dz * dz) - 90.6;
        if (d > VIEW_RADIUS) continue;
        const k = ckey(i, j);
        let rec = chunks.get(k);
        if (!rec) { rec = { ci: i, cj: j, lod: -1, want: -1, mesh: null, arrs: null, d: d, queued: false }; chunks.set(k, rec); }
        rec.d = d;
        const want = desiredLod(d, rec.lod);
        if (want !== rec.lod) {
          rec.want = want;
          if (!rec.queued) { rec.queued = true; queue.push(rec); }
          changed = true;
        } else rec.want = rec.lod;
      }
    }
    for (const [k, rec] of chunks) {
      const dx = rec.ci * CHUNK + CHUNK * 0.5 - px, dz = rec.cj * CHUNK + CHUNK * 0.5 - pz;
      const d = Math.sqrt(dx * dx + dz * dz) - 90.6;
      rec.d = d;
      if (d > DISPOSE_DIST) { disposeChunk(rec); chunks.delete(k); }
    }
    if (changed) queue.sort(function (a, b) { return b.d - a.d; });   // nearest last → pop()
  }
  function buildInto(rec, lod) {
    const t0 = performance.now();
    const res = buildChunk(rec.ci, rec.cj, lod);
    if (rec.mesh) {
      group.remove(rec.mesh);
      rec.mesh.geometry.dispose();
      recycle(rec.lod, rec.arrs);
    }
    const mesh = new THREE.Mesh(res.geom, material);
    mesh.receiveShadow = true;
    mesh.castShadow = lod === 0;
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;
    mesh.name = 'terrain_' + rec.ci + '_' + rec.cj;
    mesh.userData.chunk = rec;
    group.add(mesh);
    rec.mesh = mesh; rec.arrs = res.arrs; rec.lod = lod;
    const ms = performance.now() - t0;
    stats.builds++; stats.buildMs += ms; stats.lastBuildMs = ms;
    if (ms > stats.maxBuildMs) stats.maxBuildMs = ms;
    lodCost[lod] += (ms - lodCost[lod]) * 0.15;
  }
  function processQueue(maxBuilds, budgetMs) {
    const t0 = performance.now();
    let n = 0;
    while (queue.length && n < maxBuilds) {
      const rec = queue[queue.length - 1];
      if (rec.want >= 0 && rec.want !== rec.lod && n > 0 && performance.now() - t0 + lodCost[rec.want] > budgetMs) break;   // would not fit this frame
      queue.pop();
      rec.queued = false;
      if (rec.want < 0 || rec.want === rec.lod) continue;
      if (chunks.get(ckey(rec.ci, rec.cj)) !== rec) continue;
      buildInto(rec, rec.want);
      n++;
    }
    return n;
  }

  // ---------------------------------------------------------------- horizon mesh (static, 6 km, min-filtered, no shadows)
  function buildHorizon() {
    const N = HORIZON_SEGS, W = N + 1, step = HORIZON_SIZE / N, o0 = -HORIZON_SIZE * 0.5;
    const hs = new Float32Array(W * W);
    for (let iz = 0; iz < W; iz++) for (let ix = 0; ix < W; ix++) {
      const x = o0 + ix * step, z = o0 + iz * step;
      let m = 1e9;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        const h = coarseHeight(x + a * step * 0.34, z + b * step * 0.34);
        if (h < m) m = h;
      }
      hs[iz * W + ix] = m;
    }
    const pos = new Float32Array(W * W * 3), nrm = new Float32Array(W * W * 3), col = new Float32Array(W * W * 3);
    const inv2s = 1 / (2 * step);
    for (let iz = 0; iz < W; iz++) for (let ix = 0; ix < W; ix++) {
      const i = iz * W + ix, x = o0 + ix * step, z = o0 + iz * step;
      const h = hs[i];
      const hl = hs[iz * W + (ix > 0 ? ix - 1 : ix)], hr = hs[iz * W + (ix < N ? ix + 1 : ix)];
      const hu = hs[(iz > 0 ? iz - 1 : iz) * W + ix], hd = hs[(iz < N ? iz + 1 : iz) * W + ix];
      let nx = (hl - hr) * inv2s, nz = (hu - hd) * inv2s;
      const l = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
      nx *= l; nz *= l;
      pos[i * 3] = x; pos[i * 3 + 1] = h - HORIZON_DROP; pos[i * 3 + 2] = z;
      nrm[i * 3] = nx; nrm[i * 3 + 1] = l; nrm[i * 3 + 2] = nz;
      const s2 = 1 - l * l;
      colorAt(x, z, h, s2 <= 0 ? 0 : Math.sqrt(s2), 0, ss(2.4, 0.4, h), 0, 0, _col);
      col[i * 3] = _col.r; col[i * 3 + 1] = _col.g; col[i * 3 + 2] = _col.b;
    }
    const idx = new Uint32Array(N * N * 6);
    let p = 0;
    for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
      const a = iz * W + ix, b = (iz + 1) * W + ix, c = (iz + 1) * W + ix + 1, d = iz * W + ix + 1;
      idx[p++] = a; idx[p++] = b; idx[p++] = d; idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    geom.computeBoundingSphere();
    horizonMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    const mesh = new THREE.Mesh(geom, horizonMat);
    mesh.receiveShadow = false; mesh.castShadow = false; mesh.frustumCulled = false;
    mesh.renderOrder = -2; mesh.matrixAutoUpdate = false; mesh.name = 'terrain_horizon';
    return mesh;
  }

  // ---------------------------------------------------------------- water
  let water = null, waterFar = null, waterMat = null, waterNormalTex = null, heightTex = null;
  let waveT = 0;
  const _sunDir = { x: 0.42, y: 0.72, z: 0.31 };
  const WATER_VERT = /* glsl */`
    uniform float uTime;
    uniform float uWaveAmp;
    attribute float shore;
    varying vec3 vWorld;
    varying float vShore;
    varying vec3 vNormalW;
    #include <fog_pars_vertex>
    void main() {
      vec3 p = (modelMatrix * vec4(position, 1.0)).xyz;
      float damp = clamp(shore * 0.5, 0.12, 1.0);
      float amp = uWaveAmp * damp;
      float hgt = 0.0;
      vec2 dh = vec2(0.0);
      // three layered gerstner-ish sines
      vec2 d1 = normalize(vec2(0.82, 0.57)); float k1 = 6.2832 / 23.0; float ph1 = dot(d1, p.xz) * k1 + uTime * 1.05;
      hgt += 0.28 * sin(ph1); dh += d1 * k1 * 0.28 * cos(ph1);
      vec2 d2 = normalize(vec2(-0.35, 0.94)); float k2 = 6.2832 / 11.0; float ph2 = dot(d2, p.xz) * k2 + uTime * 1.55;
      hgt += 0.13 * sin(ph2); dh += d2 * k2 * 0.13 * cos(ph2);
      vec2 d3 = normalize(vec2(0.6, -0.8)); float k3 = 6.2832 / 5.5; float ph3 = dot(d3, p.xz) * k3 + uTime * 2.3;
      hgt += 0.05 * sin(ph3); dh += d3 * k3 * 0.05 * cos(ph3);
      p.y += hgt * amp;
      p.xz += -dh * 0.35 * amp;
      vNormalW = normalize(vec3(-dh.x * amp, 1.0, -dh.y * amp));
      vWorld = p;
      vShore = shore;
      vec4 mvPosition = viewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`;
  const WATER_FRAG = /* glsl */`
    uniform vec3 uSunDir;
    uniform vec3 uSunColor;
    uniform vec3 uSkyColor;
    uniform vec3 uDeepColor;
    uniform vec3 uShallowColor;
    uniform sampler2D uNormalMap;
    uniform sampler2D uHeightMap;
    uniform float uTime;
    uniform float uSea;
    uniform float uHalfWorld;
    uniform float uLight;
    varying vec3 vWorld;
    varying float vShore;
    varying vec3 vNormalW;
    #include <fog_pars_fragment>
    float decodeH(float e) { float t = (e - 0.5) * 2.0; return sign(t) * t * t * 40.0; }
    void main() {
      vec3 V = normalize(cameraPosition - vWorld);
      float dist = length(cameraPosition - vWorld);
      // animated normal perturbation (two scrolling layers), fading with distance to avoid sparkle aliasing
      vec2 uv1 = vWorld.xz * 0.045 + vec2(uTime * 0.021, uTime * 0.014);
      vec2 uv2 = vWorld.xz * 0.115 - vec2(uTime * 0.018, -uTime * 0.026);
      vec3 s1 = texture2D(uNormalMap, uv1).xyz * 2.0 - 1.0;
      vec3 s2 = texture2D(uNormalMap, uv2).xyz * 2.0 - 1.0;
      float nf = 0.42 * (1.0 - smoothstep(150.0, 900.0, dist));
      vec3 N = normalize(vNormalW + vec3(s1.x + s2.x * 0.5, 0.0, s1.y + s2.y * 0.5) * nf);
      // depth from the baked world height texture
      vec2 huv = (vWorld.xz + uHalfWorld) / (2.0 * uHalfWorld);
      float ground = decodeH(texture2D(uHeightMap, clamp(huv, 0.0, 1.0)).r);
      float depth = uSea - ground + 0.5;    // slight bias: the terrain mesh depth-tests the true shoreline exactly
      // colour: shallow → deep, fresnel toward the sky, sun highlight
      float NdotV = max(dot(N, V), 0.0);
      float F = 0.035 + 0.965 * pow(1.0 - NdotV, 5.0);
      vec3 body = mix(uShallowColor, uDeepColor, smoothstep(0.0, 7.0, depth));
      body *= 0.35 + 0.65 * uLight;
      vec3 R = reflect(-V, N);
      float rs = max(dot(R, uSunDir), 0.0);
      float spec = pow(rs, 260.0) * 1.6 + pow(rs, 28.0) * 0.14;
      vec3 col = mix(body, uSkyColor, F * 0.9) + uSunColor * spec * (0.35 + 0.65 * F) * uLight;
      // shore foam: animated bands in the first two metres of depth, broken up by noise
      float foamN = texture2D(uNormalMap, vWorld.xz * 0.07 + vec2(uTime * 0.03, -uTime * 0.02)).z;
      float foamN2 = texture2D(uNormalMap, vWorld.xz * 0.21 - vec2(uTime * 0.05, uTime * 0.03)).z;
      float shoreF = 1.0 - smoothstep(0.0, 2.2, depth);
      float bands = 0.5 + 0.5 * sin(depth * 5.5 - uTime * 1.7 + foamN * 4.0);
      float foam = shoreF * smoothstep(0.45, 0.85, bands * (0.55 + 0.7 * foamN2));
      foam += (1.0 - smoothstep(0.0, 0.45, depth)) * (0.35 + 0.4 * foamN2);
      foam = clamp(foam, 0.0, 1.0) * (0.55 + 0.45 * uLight);
      col = mix(col, vec3(0.93, 0.96, 0.98) * (0.4 + 0.6 * uLight), foam * 0.85);
      // subtle shimmer
      float sh = texture2D(uNormalMap, vWorld.xz * 0.55 + vec2(uTime * 0.06, -uTime * 0.045)).z;
      sh = pow(sh, 9.0) * max(uSunDir.y, 0.0) * uLight * (1.0 - smoothstep(60.0, 300.0, dist));
      col += uSunColor * sh * 0.45;
      // alpha: more opaque at grazing angles and in deep water, fading out at the water line
      float alpha = mix(0.74, 0.97, F);
      alpha = mix(alpha, 1.0, foam * 0.5);
      alpha *= smoothstep(-0.2, 0.7, depth);
      gl_FragColor = vec4(col, alpha);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
      #include <fog_fragment>
    }`;

  function buildWaterGeometry(size, segs) {
    const W = segs + 1;
    const pos = new Float32Array(W * W * 3), shore = new Float32Array(W * W), uv = new Float32Array(W * W * 2);
    const step = size / segs, o0 = -size * 0.5;
    for (let iz = 0; iz < W; iz++) for (let ix = 0; ix < W; ix++) {
      const i = iz * W + ix;
      pos[i * 3] = o0 + ix * step; pos[i * 3 + 1] = 0; pos[i * 3 + 2] = o0 + iz * step;
      shore[i] = 30;
      uv[i * 2] = ix / segs; uv[i * 2 + 1] = iz / segs;
    }
    const idx = new (W * W > 65535 ? Uint32Array : Uint16Array)(segs * segs * 6);
    let p = 0;
    for (let iz = 0; iz < segs; iz++) for (let ix = 0; ix < segs; ix++) {
      const a = iz * W + ix, b = (iz + 1) * W + ix, c = (iz + 1) * W + ix + 1, d = iz * W + ix + 1;
      idx[p++] = a; idx[p++] = b; idx[p++] = d; idx[p++] = b; idx[p++] = c; idx[p++] = d;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('shore', new THREE.BufferAttribute(shore, 1));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.setIndex(new THREE.BufferAttribute(idx, 1));
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), size * 0.75);
    return geom;
  }
  function buildWaterRing(inner, outer) {
    // 8 quads around a square hole (the near plane sits in the hole)
    const xs = [-outer * 0.5, -inner * 0.5, inner * 0.5, outer * 0.5];
    const pos = [], shore = [], idx = [];
    let vi = 0;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) {
      if (r === 1 && c === 1) continue;
      const x0 = xs[c], x1 = xs[c + 1], z0 = xs[r], z1 = xs[r + 1];
      pos.push(x0, 0, z0, x1, 0, z0, x0, 0, z1, x1, 0, z1);
      shore.push(0, 0, 0, 0);
      idx.push(vi, vi + 2, vi + 1, vi + 1, vi + 2, vi + 3);
      vi += 4;
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geom.setAttribute('shore', new THREE.BufferAttribute(new Float32Array(shore), 1));
    geom.setIndex(idx);
    geom.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), outer);
    return geom;
  }
  function refreshShore() {
    const attr = water.geometry.getAttribute('shore'), posA = water.geometry.getAttribute('position');
    const a = attr.array, p = posA.array, ox = water.position.x, oz = water.position.z;
    const edge0 = WATER_SIZE * 0.5 - 220, edge1 = WATER_SIZE * 0.5 - 20;
    for (let i = 0; i < a.length; i++) {
      const lx = p[i * 3], lz = p[i * 3 + 2];
      const d = SEA - coarseHeight(lx + ox, lz + oz);
      const m = lx < 0 ? (lz < 0 ? (-lx > -lz ? -lx : -lz) : (-lx > lz ? -lx : lz)) : (lz < 0 ? (lx > -lz ? lx : -lz) : (lx > lz ? lx : lz));
      a[i] = (d < 0 ? 0 : d) * ss(edge1, edge0, m);
    }
    attr.needsUpdate = true;
  }
  function makeWater() {
    waterNormalTex = makeWaterNormalTexture();
    heightTex = new THREE.DataTexture(HTEX_DATA, GRID_N, GRID_N, THREE.RGBAFormat, THREE.UnsignedByteType);
    heightTex.magFilter = THREE.LinearFilter; heightTex.minFilter = THREE.LinearFilter;
    heightTex.generateMipmaps = false; heightTex.flipY = false;
    heightTex.wrapS = heightTex.wrapT = THREE.ClampToEdgeWrapping;
    heightTex.colorSpace = THREE.NoColorSpace;
    heightTex.needsUpdate = true;
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uWaveAmp: { value: 1 },
      uSunDir: { value: new THREE.Vector3(_sunDir.x, _sunDir.y, _sunDir.z) },
      uSunColor: { value: new THREE.Color(0xfff1d6) },
      uSkyColor: { value: new THREE.Color(0x9fc5ec) },
      uDeepColor: { value: new THREE.Color(0x0f3a4a) },
      uShallowColor: { value: new THREE.Color(0x3d9aa6) },
      uNormalMap: { value: null },
      uHeightMap: { value: null },
      uSea: { value: SEA },
      uHalfWorld: { value: HALF },
      uLight: { value: 1 },
    }]);
    uniforms.uNormalMap.value = waterNormalTex;
    uniforms.uHeightMap.value = heightTex;
    waterMat = new THREE.ShaderMaterial({
      uniforms: uniforms, vertexShader: WATER_VERT, fragmentShader: WATER_FRAG,
      transparent: true, depthWrite: false, fog: true, side: THREE.DoubleSide,
    });
    waterMat.name = 'terrain_water';
    water = new THREE.Mesh(buildWaterGeometry(WATER_SIZE, WATER_SEGS), waterMat);
    water.position.set(0, SEA, 0);
    water.renderOrder = 5; water.frustumCulled = false; water.name = 'terrain_water';
    water.receiveShadow = false; water.castShadow = false;
    waterFar = new THREE.Mesh(buildWaterRing(WATER_SIZE, WATER_FAR_SIZE), waterMat);
    waterFar.position.set(0, SEA - 0.05, 0);
    waterFar.renderOrder = 4; waterFar.frustumCulled = false; waterFar.name = 'terrain_water_far';
    refreshShore();
  }
  function followWater(px, pz) {
    const wx = Math.round(px / WATER_SNAP) * WATER_SNAP, wz = Math.round(pz / WATER_SNAP) * WATER_SNAP;
    if (wx !== water.position.x || wz !== water.position.z) {
      water.position.x = wx; water.position.z = wz;
      waterFar.position.x = wx; waterFar.position.z = wz;
      refreshShore();
    }
  }
  function setSun(dir, color, intensity) {
    if (!dir) return;
    let x = num(dir.x, 0), y = num(dir.y, 1), z = num(dir.z, 0);
    const l = Math.sqrt(x * x + y * y + z * z) || 1;
    x /= l; y /= l; z /= l;
    _sunDir.x = x; _sunDir.y = y; _sunDir.z = z;
    if (waterMat) {
      waterMat.uniforms.uSunDir.value.set(x, y, z);
      if (color !== undefined && color !== null) {
        const c = waterMat.uniforms.uSunColor.value;
        if (typeof color === 'number') c.setHex(color); else if (color && typeof color.r === 'number') c.copy(color);
      }
      const it = num(intensity, 3);
      const sky = (G.Sky && typeof G.Sky.lightLevel === 'number') ? G.Sky.lightLevel : 1;
      waterMat.uniforms.uLight.value = clamp(Math.max(it / 3, 0.12) * 0.7 + sky * 0.3, 0.08, 1.2);
    }
  }
  function setSkyColor(color) {
    if (!waterMat || color === undefined || color === null) return;
    const c = waterMat.uniforms.uSkyColor.value;
    if (typeof color === 'number') c.setHex(color);
    else if (typeof color === 'string') c.set(color);
    else if (typeof color.r === 'number') c.copy(color);
  }

  // ---------------------------------------------------------------- the painted world map
  const mapCache = {};
  const MAP_SEA = [0x1c, 0x3b, 0x66], MAP_SHALLOW = [0x4a, 0x8c, 0xbc], MAP_SAND = [0xdc, 0xcb, 0x9a], MAP_SNOW = [0xf1, 0xf4, 0xf7],
    MAP_ROCK = [0x80, 0x7a, 0x72], MAP_ROAD = '#d3b57a', MAP_RIVER = '#3f7fbd';
  function srgbByte(v) { v = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055; return Math.round(clamp(v, 0, 1) * 255); }
  function worldToMap(x, z, size, out) {
    out = out || { x: 0, y: 0 };
    out.x = (x + HALF) / WORLD_SIZE * size;
    out.y = (z + HALF) / WORLD_SIZE * size;
    return out;
  }
  function mapToWorld(px, py, size, out) {
    out = out || { x: 0, z: 0 };
    out.x = px / size * WORLD_SIZE - HALF;
    out.z = py / size * WORLD_SIZE - HALF;
    return out;
  }
  // settlement earth weight for the painted map (height() side products are not available there)
  function townEarthAt(x, z) {
    let best = 0;
    for (let i = 0; i < TOWNS.length; i++) {
      const o = i * TS, fill = TWN[o + 4];
      if (fill <= 0) continue;
      const dx = x - TWN[o], dz = z - TWN[o + 1], R = TWN[o + 2];
      const d2 = dx * dx + dz * dz;
      if (d2 >= R * R * 1.35) continue;
      const e = ss(R, R * 0.55, Math.sqrt(d2) + R * 0.1 * G.fbm(x * 0.05556 - 3, z * 0.05556 + 21, 2, 2, 0.5)) * fill;
      if (e > best) best = e;
    }
    return best;
  }
  // mapCanvas(size, opts?) — opts.labels (default true). The label-free base is rasterised once per size and cached;
  // the labelled variant is a copy of it with zone/town names, cached separately (both share the expensive raster).
  function mapCanvas(size, opts) {
    size = Math.max(64, Math.min(4096, (size | 0) || 512));
    const labels = !(opts && opts.labels === false);
    const key = size + (labels ? ':l' : ':n');
    if (mapCache[key]) return mapCache[key];
    let base = mapCache[size + ':n'];
    if (!base) { base = paintMapBase(size); mapCache[size + ':n'] = base; }
    if (!labels) return base;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    mapCache[key] = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    ctx.drawImage(base, 0, 0);
    paintMapLabels(ctx, size);
    return canvas;
  }
  function paintMapBase(size) {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const cellW = WORLD_SIZE / size;
    const lx = -0.62, ly = 0.5, lz = -0.6;                 // hillshade light from the north-west, above
    const tmp = { r: 0, g: 0, b: 0 };
    for (let py = 0; py < size; py++) {
      const z = -HALF + (py + 0.5) * cellW;
      for (let px = 0; px < size; px++) {
        const x = -HALF + (px + 0.5) * cellW;
        const h = coarseHeight(x, z);
        const hl = coarseHeight(x - cellW, z), hr = coarseHeight(x + cellW, z), hu = coarseHeight(x, z - cellW), hd = coarseHeight(x, z + cellW);
        let nx = (hl - hr) / (2 * cellW), nz = (hu - hd) / (2 * cellW);
        const nl = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
        nx *= nl; nz *= nl;
        const ny = nl;
        const sl = Math.sqrt(Math.max(0, 1 - ny * ny));
        const shade = 0.55 + 0.75 * Math.max(0, nx * lx + ny * ly + nz * lz) - 0.1 * sl;
        let r, g, b;
        if (h < SEA - 0.15) {
          const t = ss(-14, -0.15, h);
          r = MAP_SEA[0] + (MAP_SHALLOW[0] - MAP_SEA[0]) * t; g = MAP_SEA[1] + (MAP_SHALLOW[1] - MAP_SEA[1]) * t; b = MAP_SEA[2] + (MAP_SHALLOW[2] - MAP_SEA[2]) * t;
        } else {
          colorAt(x, z, h, sl, 0, 0, townEarthAt(x, z), 0, tmp);
          r = srgbByte(tmp.r); g = srgbByte(tmp.g); b = srgbByte(tmp.b);
          const sand = ss(2.0, 0.4, h);
          if (sand > 0) { r += (MAP_SAND[0] - r) * sand; g += (MAP_SAND[1] - g) * sand; b += (MAP_SAND[2] - b) * sand; }
          const snow = C[6] * (1 - ss(0.6, 0.9, sl)) + C[7];
          if (snow > 0) { const t = clamp(snow, 0, 1) * 0.9; r += (MAP_SNOW[0] - r) * t; g += (MAP_SNOW[1] - g) * t; b += (MAP_SNOW[2] - b) * t; }
          const rock = ss(0.55, 0.8, sl) * 0.6;
          if (rock > 0) { r += (MAP_ROCK[0] - r) * rock; g += (MAP_ROCK[1] - g) * rock; b += (MAP_ROCK[2] - b) * rock; }
          r *= shade; g *= shade; b *= shade;
        }
        const k = (py * size + px) * 4;
        d[k] = r < 0 ? 0 : r > 255 ? 255 : r; d[k + 1] = g < 0 ? 0 : g > 255 ? 255 : g; d[k + 2] = b < 0 ? 0 : b > 255 ? 255 : b; d[k + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    const sc = size / WORLD_SIZE;
    const P = function (x, z) { return [(x + HALF) * sc, (z + HALF) * sc]; };
    // rivers (approximate warp compensation so the line sits in the carved bed)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = MAP_RIVER;
    for (const rv of RIVERS) {
      if (rv.id === 'bruinen_stream') continue;
      ctx.lineWidth = Math.max(1, rv.width * sc * 1.2);
      ctx.beginPath();
      let first = true;
      for (let i = 0; i + 1 < rv.points.length; i++) {
        const a = rv.points[i], b = rv.points[i + 1];
        const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / 10));
        for (let s = 0; s <= n; s++) {
          const t = s / n;
          const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          const wx = x - 7 * G.fbm(x * 0.0083 + 31, z * 0.0083 + 17, 2, 2, 0.5), wz = z - 7 * G.fbm(x * 0.0083 - 13, z * 0.0083 + 43, 2, 2, 0.5);
          const q = P(wx, wz);
          if (first) { ctx.moveTo(q[0], q[1]); first = false; } else ctx.lineTo(q[0], q[1]);
        }
      }
      ctx.stroke();
    }
    // roads
    const roads = (G.Data && G.Data.world && Array.isArray(G.Data.world.roads)) ? G.Data.world.roads : [];
    ctx.strokeStyle = 'rgba(60,40,20,0.55)';
    ctx.lineWidth = Math.max(1.2, size / 512 * 2.6);
    for (const rd of roads) {
      if (!rd || !Array.isArray(rd.points) || rd.points.length < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < rd.points.length; i++) { const q = P(rd.points[i].x, rd.points[i].z); if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]); }
      ctx.stroke();
    }
    ctx.strokeStyle = MAP_ROAD;
    ctx.lineWidth = Math.max(1, size / 512 * 1.5);
    for (const rd of roads) {
      if (!rd || !Array.isArray(rd.points) || rd.points.length < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < rd.points.length; i++) { const q = P(rd.points[i].x, rd.points[i].z); if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]); }
      ctx.stroke();
    }
    return canvas;
  }
  function paintMapLabels(ctx, size) {
    const sc = size / WORLD_SIZE;
    const P = function (x, z) { return [(x + HALF) * sc, (z + HALF) * sc]; };
    // zone names (large, translucent) with level ranges
    const zf = Math.max(8, size / 512 * 12.5);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (const zn of ZONES) {
      const q = P(zn.center.x, zn.center.z);
      const lines = String(zn.name || zn.id).toUpperCase().split(' & ');
      ctx.font = '600 ' + zf + 'px Cinzel, "Times New Roman", Georgia, serif';
      if ('letterSpacing' in ctx) ctx.letterSpacing = (zf * 0.14).toFixed(1) + 'px';
      let tw = 0;
      for (const ln of lines) tw = Math.max(tw, ctx.measureText(ln).width);
      q[0] = clamp(q[0], tw * 0.5 + 4, size - tw * 0.5 - 4);
      q[1] = clamp(q[1], zf * 1.2, size - zf * (lines.length + 1.2));
      let y = q[1] - (lines.length - 1) * zf * 0.6;
      for (const ln of lines) {
        ctx.lineWidth = Math.max(2, zf * 0.26); ctx.strokeStyle = 'rgba(245,235,210,0.42)'; ctx.strokeText(ln, q[0], y);
        ctx.fillStyle = 'rgba(28,20,10,0.55)'; ctx.fillText(ln, q[0], y);
        y += zf * 1.2;
      }
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      if (Array.isArray(zn.level)) {
        ctx.font = 'italic ' + Math.max(7, zf * 0.7) + 'px "Crimson Pro", Georgia, serif';
        ctx.lineWidth = Math.max(1.5, zf * 0.18); ctx.strokeText('Levels ' + zn.level[0] + ' – ' + zn.level[1], q[0], y - zf * 0.25);
        ctx.fillStyle = 'rgba(28,20,10,0.6)'; ctx.fillText('Levels ' + zn.level[0] + ' – ' + zn.level[1], q[0], y - zf * 0.25);
      }
    }
    // towns: markers + names
    const tf = Math.max(7, size / 512 * 10.5), tr = Math.max(2, size / 512 * 3.2);
    ctx.font = '600 ' + tf + 'px "Crimson Pro", Georgia, "Times New Roman", serif';
    for (const tw of TOWNS) {
      const q = P(tw.pos.x, tw.pos.z);
      const name = tw.name || tw.id;
      const nw = ctx.measureText(name).width;
      const lx = clamp(q[0], nw * 0.5 + 3, size - nw * 0.5 - 3);
      ctx.beginPath(); ctx.arc(q[0], q[1], tr, 0, Math.PI * 2);
      ctx.fillStyle = '#f6ead0'; ctx.fill();
      ctx.lineWidth = Math.max(1, tr * 0.4); ctx.strokeStyle = '#4a3416'; ctx.stroke();
      ctx.lineWidth = Math.max(2, tf * 0.3); ctx.strokeStyle = 'rgba(250,242,222,0.85)'; ctx.strokeText(name, lx, q[1] - tr - tf * 0.65);
      ctx.fillStyle = '#2a1c0c'; ctx.fillText(name, lx, q[1] - tr - tf * 0.65);
    }
  }

  // ---------------------------------------------------------------- lifecycle
  let inited = false;
  function init() {
    if (inited) return;
    inited = true;
    const Cst = G.C || {};
    WORLD_SIZE = num(Cst.WORLD_SIZE, 4096);
    HALF = WORLD_SIZE * 0.5;
    SEA = num(Cst.SEA_LEVEL, 0);
    GC = Math.max(8, Math.round(WORLD_SIZE / CELL));
    INV_CELL = 1 / CELL;
    preparePalette();
    ingestWorld();
    const t0 = performance.now();
    buildGrid();
    if (G.log) G.log('Terrain.init: zones', ZONES.length, 'towns', TOWNS.length, 'road segs', NRS, 'river segs', NVS, 'grid ms', (performance.now() - t0).toFixed(0));
  }
  function build(scene) {
    if (!inited) init();
    if (built) { if (scene && group.parent !== scene) { scene.add(group); scene.add(horizon); scene.add(water); scene.add(waterFar); } return; }
    detailTex = makeDetailTexture();
    material = new THREE.MeshStandardMaterial({ vertexColors: true, map: detailTex, roughness: 0.95, metalness: 0, dithering: true });
    material.name = 'terrain';
    // Multi-scale ground detail. The detail map packs three independent noises: .r mid-scale luminance (mean 0.5),
    // .g a slow field used for macro hue/brightness drift, .b a fine grain. Sampling it at three UV scales gives
    // close-range grain, mid-range mottling and a macro break-up that never fades out — so large flat areas of one
    // colour (town squares, meadows) stop reading as painted cardboard without a single extra draw call.
    material.onBeforeCompile = function (shader) {
      // chunk meshes are translation-only children of an identity group, so the object normal IS the world normal
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', 'varying vec3 vWorldN;\n#include <common>')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n  vWorldN = objectNormal;');
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', 'varying vec3 vWorldN;\n#define vUpN vWorldN.y\n#include <common>');
      // Micro-relief: the fine detail channel doubles as a height field, so close ground gets a real bumped normal
      // (grit catching the light, cross-lit ridges at dawn/dusk) rather than a flat plane with a pattern painted on.
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', [
        '#include <normal_fragment_maps>',
        '#ifdef USE_MAP',
        '  {',
        '    float bumpFade = ( 1.0 - smoothstep( 14.0, 42.0, dDist ) ) * dUp;',
        '    if ( bumpFade > 0.003 ) {',
        '      vec2 buv = vMapUv * 4.7 + vec2( 0.37, 0.61 );',
        '      float hx = texture2D( map, buv + vec2( 0.0045, 0.0 ) ).b;',
        '      float hz = texture2D( map, buv + vec2( 0.0, 0.0045 ) ).b;',
        '      vec3 wn = normalize( vWorldN );',
        '      wn.x -= ( hx - dFine.b ) * 5.0 * bumpFade;',
        '      wn.z -= ( hz - dFine.b ) * 5.0 * bumpFade;',
        '      normal = normalize( ( viewMatrix * vec4( normalize( wn ), 0.0 ) ).xyz );',
        '    }',
        '  }',
        '#endif',
      ].join('\n'));
      shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', [
        '#ifdef USE_MAP',
        '  float dDist = length( vViewPosition );',
        // the detail map is planar (world XZ), so it smears on steep faces — fade it back there
        '  float dUp = mix( 0.42, 1.0, smoothstep( 0.22, 0.72, abs( vUpN ) ) );',
        '  vec3 dtl  = texture2D( map, vMapUv ).rgb;',                                    // ~6 m tile
        '  vec3 dFine = texture2D( map, vMapUv * 4.7 + vec2( 0.37, 0.61 ) ).rgb;',        // ~1.3 m tile
        '  vec3 dMac  = texture2D( map, vMapUv * 0.105 + vec2( 0.13, 0.83 ) ).rgb;',      // ~57 m tile
        '  float fMid  = ( 1.0 - smoothstep( 60.0, 150.0, dDist ) ) * dUp;',
        '  float fFine = ( 1.0 - smoothstep( 9.0, 32.0, dDist ) ) * dUp;',
        '  float g = mix( 1.0, dtl.r * 2.0, fMid );',
        '  g *= mix( 1.0, 0.5 + dFine.b, fFine * 0.9 );',
        '  g *= 0.80 + 0.40 * dMac.g;',
        '  diffuseColor.rgb *= g;',
        // macro hue drift: dry ochre patches against cooler ones, plus a mid-scale chroma break-up up close
        '  float hMac = ( dMac.g - 0.5 ) * 2.0 + ( dtl.g - 0.5 ) * fMid;',
        '  diffuseColor.rgb *= vec3( 1.0 + hMac * 0.085, 1.0 + hMac * 0.018, 1.0 - hMac * 0.075 );',
        '#endif',
      ].join('\n'));
    };
    material.customProgramCacheKey = function () { return 'terrain_detail_v3'; };
    group = new THREE.Group();
    group.name = 'terrain';
    group.matrixAutoUpdate = false;
    horizon = buildHorizon();
    makeWater();
    if (scene) { scene.add(group); scene.add(horizon); scene.add(water); scene.add(waterFar); }
    built = true;
    T.group = group; T.horizon = horizon; T.material = material; T.water = water; T.waterFar = waterFar;
    T.waterMaterial = waterMat; T.heightTexture = heightTex; T.detailTexture = detailTex; T.ready = true;
  }
  const ORIGIN = { x: 0, y: 0, z: 0 };
  function update(playerPos, dt) {
    if (!built) return;
    const p = playerPos || ORIGIN;
    const px = num(p.x, 0), pz = num(p.z, 0);
    const step = (dt > 0 && dt < 0.5) ? dt : 0.016;
    waveT += step;
    scanTimer += step;
    const dx = px - scanX, dz = pz - scanZ;
    if (dx * dx + dz * dz > 20 * 20 || scanTimer > 0.6) scan(px, pz);
    if (queue.length) processQueue(MAX_BUILDS_PER_FRAME, BUILD_BUDGET_MS);
    followWater(px, pz);
    waterMat.uniforms.uTime.value = waveT;
    waterMat.uniforms.uSea.value = SEA;
  }
  function warmup(x, z, radius) {
    if (!built) return 0;
    x = num(x, 0); z = num(z, 0); radius = num(radius, VIEW_RADIUS);
    scan(x, z);
    let n = 0;
    while (queue.length) {
      const rec = queue[queue.length - 1];
      if (rec.d > radius) break;
      n += processQueue(1, 1e9);
    }
    followWater(x, z);
    return n;
  }
  function statsFn() {
    let tris = 0, live = 0;
    for (const rec of chunks.values()) if (rec.mesh) { live++; tris += rec.mesh.geometry.index.count / 3; }
    return { chunks: live, queued: queue.length, builds: stats.builds, avgBuildMs: stats.builds ? stats.buildMs / stats.builds : 0,
      maxBuildMs: stats.maxBuildMs, lastBuildMs: stats.lastBuildMs, triangles: tris, pooled: pool[0].length + pool[1].length + pool[2].length };
  }

  // ---------------------------------------------------------------- public API
  T.init = init;
  T.build = build;
  T.update = update;
  T.height = height;
  T.normal = normal;
  T.slope = slope;
  T.isWater = isWater;
  T.waterDepth = waterDepth;
  T.zoneAt = zoneAt;
  T.biomeAt = biomeAt;
  T.groundType = groundType;
  T.onRoad = onRoad;
  T.nearestRoadPoint = nearestRoadPoint;
  T.mapCanvas = mapCanvas;
  T.groundColor = groundColor;
  T.setSun = setSun;
  T.setSkyColor = setSkyColor;
  T.coarseHeight = coarseHeight;
  T.zoneWeight = zoneWeight;
  T.townAt = townAt;
  T.worldToMap = worldToMap;
  T.mapToWorld = mapToWorld;
  T.warmup = warmup;
  T.stats = statsFn;
  T.ready = false;
  T.CHUNK = CHUNK;
  T.VIEW_RADIUS = VIEW_RADIUS;
  T.water = null; T.waterFar = null; T.group = null; T.horizon = null; T.material = null; T.waterMaterial = null; T.heightTexture = null;
})();
