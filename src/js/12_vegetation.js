/* ==== 12_vegetation.js — G.Veg: instanced, deterministic, wind-animated vegetation (trees, bushes, rocks,
   grass, flowers, ferns, mushrooms, reeds, stumps, logs). Placement is derived per 64 m cell from G.hash2 and the
   zone at the cell centre; grass/flowers/ferns/mushrooms live in ring buffers around the player. One InstancedMesh
   per (type, LOD); wind sway is injected into the MeshStandardMaterial vertex shader via onBeforeCompile.
   Public API (SPEC §5.3 + extras):
     G.Veg.build(scene)                 create geometry/materials/meshes (call after G.Terrain.build)
     G.Veg.update(playerPos, dt)        stream cells, rebuild instance buffers, refresh rings, animate wind
     G.Veg.setDensity(mult)             quality multiplier (0.25..1.5) — regenerates everything
     G.Veg.setWind(strength)            0 = still, 1 = breeze (default), 3 = storm; eases over ~2 s
     G.Veg.stats()                      { cells, trees, instances, triangles, drawCalls, grass, colliders, wind, density,
                                          pending, rebuilding, genMsAvg, genMsMax, byType: {type: n | [near, mid, far]} }
     G.Veg.treesNear(x, z, r)           → [{x,z,r}] tree trunks (and boulders) within r — reused buffer, copy if you keep it
     G.Veg.group                        THREE.Group holding every vegetation mesh (meshes named veg_<type>_L<lod> / veg_<ring>)
     G.Veg.wind / G.Veg.density         current eased wind strength / density multiplier
     G.Veg.geometryInfo()               triangle counts per type & LOD;  G.Veg.cellAt(x,z) → loaded cell record or null
     G.Veg.CELL (64), G.Veg.TYPES       cell size and the type table (read-only)
   Behaviour notes: cells stream within 640 m (far LOD ≥ 220 m keeps 45 % of trees); colliders are registered only for
   cells within 150 m of the player (tag 'veg:<cx>,<cz>', cleared when the cell leaves that ring or unloads); a
   teleport/first spawn spends one ~30-40 ms frame filling the local cell + rings, otherwise ≤ ~3 ms/frame.
   Private helpers (rule 2): _mergeGeoms (merge that keeps custom attributes; G.mergeGeometries is used for the
   plain position/normal/uv/color sub-merges), _tube/_blob/_plane2 low-poly geometry builders.
   Assumptions: G.Terrain.height/slope/zoneAt/groundType/onRoad/isWater exist (all guarded); G.Terrain.groundColor
   is optional (falls back to zone.groundColor); G.Physics.addCylinder/clearTag optional; G.Data.world.zones/towns
   optional (a default "wild" profile is used when a position is outside every zone). ==== */
(function () {
  'use strict';
  const G = window.G;

  /* ------------------------------------------------------------------------------------------------
   * Constants
   * ---------------------------------------------------------------------------------------------- */
  const CELL = 64;                    // placement cell size (m)
  const VIS_FAR = 640;                // farthest tree distance (far LOD)
  const LOD_NEAR = 80;                // < near: full LOD (cast shadows)
  const LOD_MID = 220;                // near..mid: mid LOD; >= mid: far LOD (thinned)
  const KEEP_MARGIN = CELL * 1.5;     // cells stay loaded a little beyond VIS_FAR
  const PHYS_RADIUS = 150;            // colliders registered for cells within this distance
  const FAR_KEEP = 0.45;              // fraction of trees kept in the far LOD
  const MAX_TREES_CELL = (CELL * CELL) / 25;  // 1 tree / 25 m² at treeDensity 1
  const SEA = (G.C && typeof G.C.SEA_LEVEL === 'number') ? G.C.SEA_LEVEL : 0;
  const SNOW_COL = [0.93, 0.95, 1.0];

  // Tree / prop type table. lodDist: distance thresholds between LODs; maxDist: not drawn beyond.
  // r/h: collider radius & height (× instance scale) for trees/boulders. cap: instances per LOD.
  const TYPES = {
    oak:      { kind: 'tree', lodDist: [LOD_NEAR, LOD_MID], maxDist: VIS_FAR, r: 0.42, h: 7,  cap: [2500, 7000, 12000], shadow: true },
    pine:     { kind: 'tree', lodDist: [LOD_NEAR, LOD_MID], maxDist: VIS_FAR, r: 0.32, h: 11, cap: [2500, 7000, 12000], shadow: true },
    birch:    { kind: 'tree', lodDist: [LOD_NEAR, LOD_MID], maxDist: VIS_FAR, r: 0.26, h: 8,  cap: [2500, 7000, 12000], shadow: true },
    willow:   { kind: 'tree', lodDist: [LOD_NEAR, LOD_MID], maxDist: VIS_FAR, r: 0.45, h: 7,  cap: [1200, 3000, 5000],  shadow: true },
    dead:     { kind: 'tree', lodDist: [LOD_NEAR, LOD_MID], maxDist: VIS_FAR, r: 0.30, h: 6,  cap: [1500, 4000, 7000],  shadow: true },
    snowpine: { kind: 'tree', lodDist: [LOD_NEAR, LOD_MID], maxDist: VIS_FAR, r: 0.32, h: 10, cap: [2000, 6000, 10000], shadow: true },
    mallorn:  { kind: 'tree', lodDist: [LOD_NEAR, LOD_MID], maxDist: VIS_FAR, r: 0.85, h: 16, cap: [800, 2500, 4000],   shadow: true },
    bush:     { kind: 'prop', lodDist: [], maxDist: 170, cap: [4000], shadow: false },
    shrub:    { kind: 'prop', lodDist: [], maxDist: 170, cap: [4000], shadow: false },
    rock1:    { kind: 'rock', lodDist: [], maxDist: 320, cap: [3500], shadow: false },
    rock2:    { kind: 'rock', lodDist: [], maxDist: 320, cap: [3500], shadow: false },
    rock3:    { kind: 'rock', lodDist: [], maxDist: 320, cap: [3500], shadow: false },
    boulder:  { kind: 'rock', lodDist: [], maxDist: VIS_FAR, r: 1.6, h: 2.4, cap: [2500], shadow: true },
    stump:    { kind: 'prop', lodDist: [], maxDist: 120, cap: [800], shadow: false },
    log:      { kind: 'prop', lodDist: [], maxDist: 140, cap: [800], shadow: false },
    reed:     { kind: 'prop', lodDist: [], maxDist: 220, cap: [5000], shadow: false },
  };
  const TREE_TYPES = ['oak', 'pine', 'birch', 'willow', 'dead', 'snowpine', 'mallorn'];

  /* ------------------------------------------------------------------------------------------------
   * Small utilities
   * ---------------------------------------------------------------------------------------------- */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const hash2 = (x, z) => G.hash2 ? G.hash2(x, z) : (Math.abs(Math.sin(x * 127.1 + z * 311.7) * 43758.5453) % 1);
  const noise2 = (x, z) => G.noise2 ? G.noise2(x, z) : (hash2(Math.floor(x), Math.floor(z)) * 2 - 1);
  const fbm = (x, z, o) => G.fbm ? G.fbm(x, z, o || 3) : noise2(x, z);
  function makeRng(seed) {
    if (G.rng) return G.rng(seed);
    let s = (seed >>> 0) || 1;                     // mulberry32 fallback
    return function () { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const cellSeed = (cx, cz, salt) => Math.floor(hash2(cx * 3.1 + salt * 17.3, cz * 2.7 - salt * 5.1) * 4294967295) >>> 0;
  const log = (...a) => { if (G.log) G.log('[Veg]', ...a); };

  const _c = new THREE.Color();
  const _c2 = new THREE.Color();
  // Convert hex / '#rrggbb' / {r,g,b} / THREE.Color into linear components in out[3]
  function toRGB(v, out, fallback) {
    if (v == null) v = fallback;
    if (typeof v === 'number') _c.setHex(v);
    else if (typeof v === 'string') _c.set(v);
    else if (v && v.isColor) _c.copy(v);
    else if (v && typeof v.r === 'number') { _c.r = v.r; _c.g = v.g; _c.b = v.b; }
    else _c.setHex(fallback != null ? fallback : 0x80a040);
    out[0] = _c.r; out[1] = _c.g; out[2] = _c.b;
    return out;
  }
  const hexRGB = (hex) => { _c2.setHex(hex); return [_c2.r, _c2.g, _c2.b]; };

  /* ------------------------------------------------------------------------------------------------
   * Geometry helpers — every builder returns an indexed BufferGeometry with position/normal/uv/color.
   * ---------------------------------------------------------------------------------------------- */
  // Merge geometries keeping EVERY attribute that all inputs share (used for the final trunk+canopy merge which
  // carries the custom aVeg attribute). Handles indexed and non-indexed inputs.
  function _mergeGeoms(geoms) {
    geoms = geoms.filter(g => g && g.attributes.position);
    if (!geoms.length) return new THREE.BufferGeometry();
    const names = Object.keys(geoms[0].attributes).filter(n => geoms.every(g => g.attributes[n]));
    const out = new THREE.BufferGeometry();
    let vCount = 0, iCount = 0;
    for (const g of geoms) { const n = g.attributes.position.count; vCount += n; iCount += g.index ? g.index.count : n; }
    for (const name of names) {
      const size = geoms[0].attributes[name].itemSize;
      const arr = new Float32Array(vCount * size);
      let off = 0;
      for (const g of geoms) { const a = g.attributes[name]; arr.set(a.array.subarray(0, a.count * size), off); off += a.count * size; }
      out.setAttribute(name, new THREE.BufferAttribute(arr, size));
    }
    const idx = new Uint32Array(iCount);
    let io = 0, vo = 0;
    for (const g of geoms) {
      const n = g.attributes.position.count;
      if (g.index) { const ia = g.index.array; for (let i = 0; i < g.index.count; i++) idx[io++] = ia[i] + vo; }
      else for (let i = 0; i < n; i++) idx[io++] = i + vo;
      vo += n;
    }
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    return out;
  }
  const mergePlain = (geoms) => (G.mergeGeometries ? G.mergeGeometries(geoms) : _mergeGeoms(geoms));

  // Paint a whole geometry with a colour (optionally lerped by height y0..y1 to colTop) + per-vertex noise
  function paint(geom, col, colTop, y0, y1, jitter, seed) {
    const pos = geom.attributes.position; const n = pos.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      let t = colTop ? clamp((pos.getY(i) - y0) / Math.max(1e-4, (y1 - y0)), 0, 1) : 0;
      const j = jitter ? (hash2(i * 0.731 + seed, seed * 1.37 + i * 0.113) - 0.5) * jitter : 0;
      const c0 = col, c1 = colTop || col;
      arr[i * 3] = clamp(lerp(c0[0], c1[0], t) + j, 0, 1);
      arr[i * 3 + 1] = clamp(lerp(c0[1], c1[1], t) + j, 0, 1);
      arr[i * 3 + 2] = clamp(lerp(c0[2], c1[2], t) + j * 0.7, 0, 1);
    }
    geom.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geom;
  }
  function ensureUV(geom) {
    if (!geom.attributes.uv) geom.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geom.attributes.position.count * 2), 2));
    return geom;
  }

  // Tube along a polyline of {x,y,z,r}; open bottom, optional top cap fan; radius wobble for gnarled bark.
  function _tube(pts, radial, opts) {
    opts = opts || {};
    const gn = opts.gnarl || 0, seed = opts.seed || 1, capTop = opts.capTop !== false, capBottom = !!opts.capBottom;
    const wave = opts.wave || 0, waveN = opts.waveN || 5;
    const P = [], N = [], U = [], I = [];
    const up = new THREE.Vector3(), dir = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), tmp = new THREE.Vector3();
    for (let s = 0; s < pts.length; s++) {
      const p = pts[s];
      const a = pts[Math.max(0, s - 1)], b = pts[Math.min(pts.length - 1, s + 1)];
      dir.set(b.x - a.x, b.y - a.y, b.z - a.z);
      const segLen = dir.length() || 1;
      if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0); dir.normalize();
      // normal tilt along the axis from the radius gradient (a cone narrowing upward gets upward-tilted normals)
      const rk = -(b.r - a.r) / segLen;
      up.set(0, 1, 0); if (Math.abs(dir.y) > 0.98) up.set(1, 0, 0);
      t1.crossVectors(up, dir).normalize(); t2.crossVectors(dir, t1).normalize();
      for (let k = 0; k <= radial; k++) {
        const th = (k / radial) * Math.PI * 2;
        const kk = k === radial ? 0 : k;
        let r = p.r;
        if (gn) r *= 1 + (hash2(kk * 1.7 + seed, s * 2.3 + seed * 0.7) - 0.5) * gn * 2;
        if (wave) r *= 1 + Math.sin(th * waveN + s * 1.3) * wave;
        const cs = Math.cos(th), sn = Math.sin(th);
        tmp.set(t1.x * cs + t2.x * sn, t1.y * cs + t2.y * sn, t1.z * cs + t2.z * sn);
        P.push(p.x + tmp.x * r, p.y + tmp.y * r, p.z + tmp.z * r);
        tmp.x += dir.x * rk; tmp.y += dir.y * rk; tmp.z += dir.z * rk; tmp.normalize();
        N.push(tmp.x, tmp.y, tmp.z);
        U.push(k / radial, s / (pts.length - 1));
      }
    }
    const ringN = radial + 1;
    for (let s = 0; s < pts.length - 1; s++) for (let k = 0; k < radial; k++) {
      const a = s * ringN + k, b = a + 1, c = a + ringN, d = c + 1;
      I.push(a, c, b, b, c, d);
    }
    if (capTop) {
      const p = pts[pts.length - 1]; const ci = P.length / 3;
      P.push(p.x, p.y, p.z); N.push(0, 1, 0); U.push(0.5, 1);
      const base = (pts.length - 1) * ringN;
      for (let k = 0; k < radial; k++) I.push(base + k, base + k + 1, ci);
    }
    if (capBottom) {
      const p = pts[0]; const ci = P.length / 3;
      P.push(p.x, p.y, p.z); N.push(0, -1, 0); U.push(0.5, 0);
      for (let k = 0; k < radial; k++) I.push(k + 1, k, ci);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(U), 2));
    g.setIndex(I);
    return g;
  }
  // Straight trunk/branch helper: from (x,y,z) along direction (dx,dy,dz) length L, radius r0→r1, bend
  function branchPts(x, y, z, dx, dy, dz, L, r0, r1, segs, bend, seed) {
    const pts = [];
    const bx = (hash2(seed, 1.3) - 0.5) * 2, bz = (hash2(1.7, seed) - 0.5) * 2;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs, s = t * t * bend * L;
      pts.push({ x: x + dx * L * t + bx * s, y: y + dy * L * t, z: z + dz * L * t + bz * s, r: lerp(r0, r1, t) });
    }
    return pts;
  }
  // Leafy blob: displaced icosphere with height-graded colour and painterly per-vertex variation
  function _blob(r, detail, col, colTop, opts) {
    opts = opts || {};
    const g = new THREE.IcosahedronGeometry(r, detail);
    const pos = g.attributes.position; const seed = opts.seed || 1; const amp = opts.noise == null ? 0.18 : opts.noise;
    const sy = opts.squash == null ? 0.82 : opts.squash;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const n = 1 + (noise2(x * 1.7 + seed, z * 1.7 + y * 1.1 - seed) * 0.6 + noise2(x * 4 + y * 3, z * 4 + seed) * 0.4) * amp;
      pos.setXYZ(i, x * n + (opts.ox || 0), y * n * sy + (opts.oy || 0), z * n + (opts.oz || 0));
    }
    g.computeVertexNormals();
    // smooth shading with a soft bias upward so canopies read as lit from above
    const nrm = g.attributes.normal;
    for (let i = 0; i < nrm.count; i++) { nrm.setXYZ(i, nrm.getX(i), nrm.getY(i) + 0.35, nrm.getZ(i)); }
    nrm.needsUpdate = true;
    const ymin = (opts.oy || 0) - r * sy, ymax = (opts.oy || 0) + r * sy;
    paint(g, col, colTop, ymin, ymax, opts.jitter == null ? 0.06 : opts.jitter, seed);
    return g;
  }
  // Double-faced plane (w × h, base at y=0, facing ±z), vertical segments for bending; normals flipped on the back
  function _plane2(w, h, segs, col, colTop, opts) {
    opts = opts || {};
    const P = [], N = [], U = [], I = [];
    const tilt = opts.tilt || 0;   // lean back along z per unit height
    const taper = opts.taper == null ? 1 : opts.taper;  // top width factor
    for (let s = 0; s <= segs; s++) {
      const t = s / segs; const ww = w * lerp(1, taper, t) * 0.5; const y = h * t; const z = (opts.z || 0) + tilt * y * y / h;
      P.push(-ww, y, z, ww, y, z); N.push(0, 0, 1, 0, 0, 1); U.push(0, t, 1, t);
    }
    for (let s = 0; s < segs; s++) { const a = s * 2; I.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    if (!opts.single) { // back face (for opaque materials); alpha-tested materials use side:DoubleSide instead
      const nv = P.length / 3;
      for (let i = 0; i < nv; i++) { P.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); N.push(0, 0, -1); U.push(U[i * 2], U[i * 2 + 1]); }
      for (let s = 0; s < segs; s++) { const a = nv + s * 2; I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(U), 2));
    g.setIndex(I);
    if (col) paint(g, col, colTop, 0, h, 0, 1);
    return g;
  }
  function xform(g, x, y, z, yaw, pitch, scale) {
    const m = new THREE.Matrix4();
    const e = new THREE.Euler(pitch || 0, yaw || 0, 0, 'YXZ');
    m.compose(new THREE.Vector3(x || 0, y || 0, z || 0), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(scale || 1, scale || 1, scale || 1));
    g.applyMatrix4(m);
    return g;
  }
  // aVeg = (swayWeight, canopyFlag) per vertex; sway grows with height^1.6 over [0, H]
  function finish(geom, H, isCanopy, swayMul, floor) {
    const pos = geom.attributes.position; const n = pos.count; const a = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const t = clamp(pos.getY(i) / Math.max(0.01, H), 0, 1);
      a[i * 2] = (Math.pow(t, 1.6) * (swayMul == null ? 1 : swayMul)) + (floor || 0);
      a[i * 2 + 1] = isCanopy ? 1 : 0;
    }
    geom.setAttribute('aVeg', new THREE.BufferAttribute(a, 2));
    return geom;
  }
  function triCount(g) { return g.index ? g.index.count / 3 : g.attributes.position.count / 3; }

  /* ------------------------------------------------------------------------------------------------
   * Type geometry — each builder returns { lods: [BufferGeometry...], H } (H = height used for sway weights).
   * Vertex colours carry trunk/canopy colour so every mesh needs ONE material.
   * ---------------------------------------------------------------------------------------------- */
  const COL = {
    oakBark: hexRGB(0x584431), oakBarkTop: hexRGB(0x6e5a40), oakLeaf: hexRGB(0x36702a), oakLeafTop: hexRGB(0x86bb3e),
    pineBark: hexRGB(0x4b3626), pineNeedle: hexRGB(0x2c5c32), pineNeedleTop: hexRGB(0x6cab4c), pineUnder: hexRGB(0x1e3a24),
    birchBark: hexRGB(0xe9e5da), birchMark: hexRGB(0x2f2a26), birchLeaf: hexRGB(0x5f9c34), birchLeafTop: hexRGB(0xbfe063),
    willowBark: hexRGB(0x6a5738), willowLeaf: hexRGB(0x5f8f30), willowLeafTop: hexRGB(0xaac54f),
    deadBark: hexRGB(0x46403a), deadBarkTop: hexRGB(0x736a5f),
    snowBark: hexRGB(0x3b2e25), snowNeedle: hexRGB(0x31593c), snowNeedleTop: hexRGB(0x5f8f5a),
    malBark: hexRGB(0x9b9b96), malBarkTop: hexRGB(0xbdbbb1), malLeaf: hexRGB(0xc59a2e), malLeafTop: hexRGB(0xf5d867),
    // bushes/hedges sit low, so their visible faces get almost no sun — the base colours are lifted a step so a
    // hedgerow reads as dark green foliage rather than a black scribble along the field edge
    bush: hexRGB(0x4a8434), bushTop: hexRGB(0x8cc24a), shrub: hexRGB(0x7a8850), shrubTop: hexRGB(0xafb473),
    rock: hexRGB(0x75736c), rockTop: hexRGB(0x9d9b93), moss: hexRGB(0x5b7a37),
    cut: hexRGB(0xc8ab7a), reed: hexRGB(0x5e7f33), reedTop: hexRGB(0xc3c66d), stem: hexRGB(0x3f7a2a),
    white: [1, 1, 1], cream: hexRGB(0xe8dcc3), capUnder: hexRGB(0xd9cbb0),
  };
  const GEOMS = {};      // type → { lods:[], H, tris:[] }
  const DETAIL_GEOMS = {}; // grass/flower/fern/mushroom → geometry

  function birchMarks(g, seed) {
    const c = g.attributes.color, p = g.attributes.position;
    for (let i = 0; i < c.count; i++) {
      const h = hash2(Math.round(p.getY(i) * 7) * 0.37 + seed, Math.round(Math.atan2(p.getZ(i), p.getX(i)) * 3) * 1.1);
      if (h < 0.22) c.setXYZ(i, COL.birchMark[0], COL.birchMark[1], COL.birchMark[2]);
    }
  }
  // whiten upward-facing vertices (snow on canopies/rocks baked into vertex colour)
  function snowPaint(g, amount) {
    const c = g.attributes.color, n = g.attributes.normal;
    for (let i = 0; i < c.count; i++) {
      const t = clamp((n.getY(i) - 0.15) * 1.6, 0, 1) * amount;
      c.setXYZ(i, lerp(c.getX(i), SNOW_COL[0], t), lerp(c.getY(i), SNOW_COL[1], t), lerp(c.getZ(i), SNOW_COL[2], t));
    }
  }
  function trunk(r0, r1, y0, y1, radial, segs, bend, gnarl, seed, col, colTop) {
    const pts = branchPts(0, y0, 0, 0, 1, 0, y1 - y0, r0, r1, segs, bend, seed);
    return paint(_tube(pts, radial, { gnarl, seed, capTop: true }), col, colTop, y0, y1, 0.03, seed);
  }
  function branch(x, y, z, ang, up, L, r0, r1, radial, segs, bend, seed, col) {
    const dx = Math.cos(ang) * Math.cos(up), dz = Math.sin(ang) * Math.cos(up), dy = Math.sin(up);
    return paint(_tube(branchPts(x, y, z, dx, dy, dz, L, r0, r1, segs, bend, seed), radial, { seed, capTop: true, gnarl: 0.08 }), col, null, 0, 1, 0.03, seed);
  }
  function cone(y0, y1, r0, r1, radial, col, colTop, under, wave, seed) {
    const pts = [{ x: 0, y: y0, z: 0, r: r0 }, { x: 0, y: y1, z: 0, r: r1 }];
    const g = _tube(pts, radial, { capTop: true, capBottom: !!under, wave: wave || 0, waveN: 5, seed: seed || 1 });
    paint(g, col, colTop, y0, y1, 0.04, seed || 1);
    if (under) { // darken the bottom cap centre vertex
      const c = g.attributes.color; const i = c.count - 1; c.setXYZ(i, under[0], under[1], under[2]);
    }
    return g;
  }
  function farTrunk(r, y1, col) { // 4-sided open prism, cheapest possible trunk
    return paint(_tube([{ x: 0, y: -0.3, z: 0, r }, { x: 0, y: y1, z: 0, r: r * 0.6 }], 4, { capTop: false }), col, null, 0, 1, 0, 1);
  }
  function tree(trunkGeoms, canopyGeoms, H, canopySway, trunkSway) {
    const t = trunkGeoms.length ? finish(mergePlain(trunkGeoms), H, false, trunkSway == null ? 0.55 : trunkSway) : null;
    const c = canopyGeoms.length ? finish(mergePlain(canopyGeoms), H, true, canopySway == null ? 1 : canopySway, 0.05) : null;
    const g = _mergeGeoms([t, c].filter(Boolean));
    if (t) t.dispose(); if (c) c.dispose();
    return g;
  }

  function buildOak() {
    const H = 7.5;
    const l0 = tree(
      [trunk(0.48, 0.2, -0.3, 3.7, 7, 3, 0.1, 0.14, 11, COL.oakBark, COL.oakBarkTop),
       branch(0, 2.4, 0, 0.4, 0.75, 2.4, 0.16, 0.05, 5, 2, 0.15, 12, COL.oakBark),
       branch(0, 2.9, 0, 2.3, 0.7, 2.2, 0.15, 0.05, 5, 2, 0.15, 13, COL.oakBark),
       branch(0, 3.2, 0, 4.1, 0.8, 2.0, 0.13, 0.05, 5, 2, 0.15, 14, COL.oakBark),
       branch(0, 2.7, 0, 5.4, 0.65, 2.3, 0.14, 0.05, 5, 2, 0.15, 15, COL.oakBark)],
      [_blob(2.3, 1, COL.oakLeaf, COL.oakLeafTop, { oy: 4.9, seed: 21, squash: 0.8 }),
       _blob(1.7, 1, COL.oakLeaf, COL.oakLeafTop, { ox: 1.5, oy: 4.3, oz: 0.4, seed: 22, squash: 0.8 }),
       _blob(1.6, 1, COL.oakLeaf, COL.oakLeafTop, { ox: -1.4, oy: 4.5, oz: -0.6, seed: 23, squash: 0.85 }),
       _blob(1.5, 0, COL.oakLeaf, COL.oakLeafTop, { ox: 0.2, oy: 4.6, oz: 1.6, seed: 24, squash: 0.8, noise: 0.14 }),
       _blob(1.5, 0, COL.oakLeaf, COL.oakLeafTop, { ox: -0.3, oy: 4.4, oz: -1.7, seed: 25, squash: 0.8, noise: 0.14 })], H);
    const l1 = tree([trunk(0.48, 0.2, -0.3, 3.7, 5, 1, 0, 0, 11, COL.oakBark, COL.oakBarkTop)],
      [_blob(2.5, 0, COL.oakLeaf, COL.oakLeafTop, { oy: 4.9, seed: 21, squash: 0.8, noise: 0.16 }),
       _blob(1.7, 0, COL.oakLeaf, COL.oakLeafTop, { ox: 1.6, oy: 4.2, oz: 0.5, seed: 26, squash: 0.85, noise: 0.16 }),
       _blob(1.6, 0, COL.oakLeaf, COL.oakLeafTop, { ox: -1.4, oy: 4.4, oz: -0.9, seed: 27, squash: 0.85, noise: 0.16 })], H);
    const l2 = tree([farTrunk(0.4, 3.7, COL.oakBark)], [_blob(2.8, 0, COL.oakLeaf, COL.oakLeafTop, { oy: 4.8, seed: 21, squash: 0.78, noise: 0.12 })], H);
    return { lods: [l0, l1, l2], H };
  }
  function buildPine(snow) {
    const H = 9.4;
    const bark = snow ? COL.snowBark : COL.pineBark, nd = snow ? COL.snowNeedle : COL.pineNeedle, ndT = snow ? COL.snowNeedleTop : COL.pineNeedleTop;
    const layers = (radial, under, wave, sd) => [
      cone(2.1, 4.6, 2.5, 0.12, radial, nd, ndT, under && COL.pineUnder, wave, sd + 1),
      cone(3.9, 6.2, 2.0, 0.1, radial, nd, ndT, under && COL.pineUnder, wave, sd + 2),
      cone(5.5, 7.6, 1.5, 0.08, radial, nd, ndT, under && COL.pineUnder, wave, sd + 3),
      cone(6.9, 9.4, 1.0, 0.04, radial, nd, ndT, under && COL.pineUnder, wave, sd + 4)];
    const l0 = tree([trunk(0.34, 0.08, -0.3, 8.6, 6, 3, 0.03, 0.1, 31, bark, bark)], layers(9, true, 0.13, 31), H, 0.7, 0.4);
    const l1 = tree([trunk(0.34, 0.08, -0.3, 8.6, 4, 1, 0, 0, 31, bark, bark)],
      [cone(2.1, 5.6, 2.5, 0.1, 6, nd, ndT, null, 0, 32), cone(5.0, 9.4, 1.7, 0.04, 6, nd, ndT, null, 0, 34)], H, 0.7, 0.4);
    const l2 = tree([farTrunk(0.3, 3, bark)], [cone(2.0, 9.4, 2.4, 0.05, 5, nd, ndT, null, 0, 35)], H, 0.7, 0.4);
    if (snow) [l0, l1, l2].forEach(g => snowPaint(g, 0.85));
    return { lods: [l0, l1, l2], H };
  }
  function buildBirch() {
    const H = 8;
    const tr = trunk(0.24, 0.07, -0.3, 7.2, 6, 4, 0.12, 0.05, 41, COL.birchBark, COL.birchBark); birchMarks(tr, 41);
    const l0 = tree([tr,
      branch(0, 4.2, 0, 0.9, 0.9, 1.7, 0.07, 0.03, 4, 2, 0.1, 42, COL.birchBark),
      branch(0, 4.9, 0, 3.0, 0.95, 1.6, 0.07, 0.03, 4, 2, 0.1, 43, COL.birchBark),
      branch(0, 5.5, 0, 5.1, 0.9, 1.4, 0.06, 0.03, 4, 2, 0.1, 44, COL.birchBark)],
      [_blob(1.5, 1, COL.birchLeaf, COL.birchLeafTop, { oy: 6.4, seed: 45, squash: 1.15, noise: 0.32, jitter: 0.08 }),
       _blob(1.25, 1, COL.birchLeaf, COL.birchLeafTop, { ox: 1.1, oy: 5.5, oz: 0.5, seed: 46, squash: 1.1, noise: 0.32, jitter: 0.08 }),
       _blob(1.2, 1, COL.birchLeaf, COL.birchLeafTop, { ox: -1.0, oy: 5.8, oz: -0.6, seed: 47, squash: 1.1, noise: 0.32, jitter: 0.08 }),
       _blob(1.1, 1, COL.birchLeaf, COL.birchLeafTop, { ox: 0.1, oy: 6.9, oz: -1.0, seed: 48, squash: 1.2, noise: 0.32, jitter: 0.08 })], H, 1.2);
    const tr1 = trunk(0.24, 0.07, -0.3, 7.2, 5, 2, 0.12, 0, 41, COL.birchBark, COL.birchBark); birchMarks(tr1, 41);
    const l1 = tree([tr1], [_blob(1.6, 0, COL.birchLeaf, COL.birchLeafTop, { oy: 6.3, seed: 45, squash: 1.2, noise: 0.2 }),
      _blob(1.3, 0, COL.birchLeaf, COL.birchLeafTop, { ox: 1.0, oy: 5.5, oz: 0.6, seed: 46, squash: 1.1, noise: 0.2 })], H, 1.2);
    const l2 = tree([farTrunk(0.22, 5, COL.birchBark)], [_blob(2.0, 0, COL.birchLeaf, COL.birchLeafTop, { oy: 6.1, seed: 45, squash: 1.2, noise: 0.15 })], H, 1.2);
    return { lods: [l0, l1, l2], H };
  }
  function buildWillow() {
    const H = 6.8;
    const strands = [];
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + hash2(i, 51) * 0.3, rr = 2.3 + hash2(51, i) * 0.5, len = 2.6 + hash2(i * 3, 52) * 1.2;
      const s = _plane2(0.55, len, 2, COL.willowLeafTop, COL.willowLeaf, { taper: 0.5 });
      xform(s, Math.cos(a) * rr, 4.5 - len, Math.sin(a) * rr, -a + Math.PI / 2, 0, 1);
      // strands sway most at their free (lower) end
      strands.push(s);
    }
    const strandGeom = finish(mergePlain(strands), 1, true, 0, 0);
    { const p = strandGeom.attributes.position, a = strandGeom.attributes.aVeg; for (let i = 0; i < p.count; i++) a.setX(i, 0.35 + clamp((4.5 - p.getY(i)) / 3.8, 0, 1) * 1.1); }
    const trunkC = finish(mergePlain([trunk(0.55, 0.3, -0.3, 3.6, 7, 3, 0.16, 0.16, 53, COL.willowBark, COL.willowBark)]), H, false, 0.5);
    const canopy = finish(mergePlain([
      paint(_tube([{ x: 0, y: 3.1, z: 0, r: 0.35 }, { x: 0, y: 4.1, z: 0, r: 2.8 }, { x: 0, y: 5.4, z: 0, r: 2.3 }, { x: 0, y: 6.6, z: 0, r: 0.8 }], 10, { capTop: true, wave: 0.08, waveN: 6, seed: 54 }), COL.willowLeaf, COL.willowLeafTop, 3.1, 6.8, 0.05, 54),
      _blob(2.2, 1, COL.willowLeaf, COL.willowLeafTop, { oy: 5.0, seed: 55, squash: 0.62, noise: 0.2 })]), H, true, 1, 0.05);
    const l0 = _mergeGeoms([trunkC, canopy, strandGeom]);
    const l1 = tree([trunk(0.55, 0.3, -0.3, 3.6, 5, 2, 0.1, 0, 53, COL.willowBark, COL.willowBark)],
      [paint(_tube([{ x: 0, y: 3.1, z: 0, r: 0.3 }, { x: 0, y: 4.2, z: 0, r: 2.9 }, { x: 0, y: 6.6, z: 0, r: 0.7 }], 7, { capTop: true }), COL.willowLeaf, COL.willowLeafTop, 3.1, 6.8, 0.04, 54),
       _blob(2.2, 0, COL.willowLeaf, COL.willowLeafTop, { oy: 3.6, seed: 56, squash: 0.5 })], H);
    const l2 = tree([farTrunk(0.45, 3.5, COL.willowBark)], [cone(2.6, 6.6, 3.0, 0.4, 5, COL.willowLeaf, COL.willowLeafTop, null, 0, 57)], H);
    return { lods: [l0, l1, l2], H };
  }
  function buildDead() {
    const H = 5.8;
    const l0 = tree([trunk(0.34, 0.1, -0.3, 5.4, 6, 3, 0.22, 0.2, 61, COL.deadBark, COL.deadBarkTop),
      branch(0, 2.6, 0, 0.3, 0.9, 2.3, 0.12, 0.03, 4, 2, 0.25, 62, COL.deadBarkTop),
      branch(0, 3.3, 0, 2.4, 0.8, 2.0, 0.11, 0.03, 4, 2, 0.3, 63, COL.deadBarkTop),
      branch(0, 4.0, 0, 4.0, 1.0, 1.8, 0.1, 0.03, 4, 2, 0.25, 64, COL.deadBarkTop),
      branch(0, 4.6, 0, 1.5, 1.1, 1.4, 0.08, 0.02, 4, 2, 0.2, 65, COL.deadBarkTop),
      branch(0, 3.7, 0, 5.3, 0.6, 1.5, 0.08, 0.02, 4, 2, 0.3, 66, COL.deadBarkTop),
      branch(0, 2.2, 0, 3.6, 0.5, 1.2, 0.08, 0.02, 4, 2, 0.3, 67, COL.deadBarkTop),
      branch(1.2, 4.2, 0.4, 0.1, 1.3, 1.0, 0.04, 0.01, 3, 1, 0, 68, COL.deadBarkTop),
      branch(-0.9, 4.6, -1.2, 2.6, 1.2, 0.9, 0.04, 0.01, 3, 1, 0, 69, COL.deadBarkTop)], [], H, 0, 0.35);
    const l1 = tree([trunk(0.34, 0.1, -0.3, 5.4, 5, 2, 0.2, 0, 61, COL.deadBark, COL.deadBarkTop),
      branch(0, 2.6, 0, 0.3, 0.9, 2.3, 0.12, 0.03, 3, 1, 0, 62, COL.deadBarkTop),
      branch(0, 3.3, 0, 2.4, 0.8, 2.0, 0.11, 0.03, 3, 1, 0, 63, COL.deadBarkTop),
      branch(0, 4.0, 0, 4.0, 1.0, 1.8, 0.1, 0.03, 3, 1, 0, 64, COL.deadBarkTop)], [], H, 0, 0.35);
    const l2 = tree([farTrunk(0.3, 5.0, COL.deadBark),
      branch(0, 2.6, 0, 0.3, 0.9, 2.3, 0.12, 0.03, 3, 1, 0, 62, COL.deadBarkTop),
      branch(0, 3.5, 0, 3.4, 0.9, 2.0, 0.11, 0.03, 3, 1, 0, 63, COL.deadBarkTop)], [], H, 0, 0.35);
    return { lods: [l0, l1, l2], H };
  }
  function buildMallorn() {
    const H = 16.5;
    const branches = [];
    for (let i = 0; i < 5; i++) branches.push(branch(0, 7.6 + i * 0.7, 0, i * 1.26 + 0.4, 0.55 + hash2(i, 71) * 0.3, 3.8 + hash2(71, i), 0.38, 0.12, 6, 3, 0.06, 72 + i, COL.malBark));
    const l0 = tree([paint(_tube([{ x: 0, y: -0.5, z: 0, r: 1.35 }, { x: 0.05, y: 1.5, z: 0, r: 1.0 }, { x: 0.1, y: 5, z: 0.1, r: 0.85 }, { x: 0.05, y: 8.5, z: 0.15, r: 0.7 }, { x: 0, y: 11.5, z: 0.1, r: 0.45 }], 9, { gnarl: 0.08, seed: 73, capTop: true }), COL.malBark, COL.malBarkTop, -0.5, 11.5, 0.03, 73)].concat(branches),
      [_blob(4.2, 1, COL.malLeaf, COL.malLeafTop, { oy: 13.2, seed: 81, squash: 0.75, noise: 0.16 }),
       _blob(3.0, 1, COL.malLeaf, COL.malLeafTop, { ox: 3.0, oy: 11.8, oz: 1.2, seed: 82, squash: 0.8 }),
       _blob(2.9, 1, COL.malLeaf, COL.malLeafTop, { ox: -2.8, oy: 12.2, oz: -1.6, seed: 83, squash: 0.8 }),
       _blob(2.8, 1, COL.malLeaf, COL.malLeafTop, { ox: 0.6, oy: 12.0, oz: 3.2, seed: 84, squash: 0.8 }),
       _blob(2.7, 1, COL.malLeaf, COL.malLeafTop, { ox: -0.9, oy: 11.6, oz: -3.3, seed: 85, squash: 0.8 }),
       _blob(2.4, 1, COL.malLeaf, COL.malLeafTop, { ox: 2.4, oy: 14.6, oz: -1.4, seed: 86, squash: 0.8 })], H, 0.8, 0.3);
    const l1 = tree([trunk(1.2, 0.5, -0.5, 11.5, 6, 1, 0, 0, 73, COL.malBark, COL.malBarkTop)],
      [_blob(5.0, 0, COL.malLeaf, COL.malLeafTop, { oy: 12.9, seed: 81, squash: 0.75, noise: 0.16 }),
       _blob(3.2, 0, COL.malLeaf, COL.malLeafTop, { ox: 3.4, oy: 11.6, oz: 2.0, seed: 82, squash: 0.8, noise: 0.16 }),
       _blob(3.0, 0, COL.malLeaf, COL.malLeafTop, { ox: -3.0, oy: 11.9, oz: -2.2, seed: 83, squash: 0.8, noise: 0.16 })], H, 0.8, 0.3);
    const l2 = tree([farTrunk(1.1, 11, COL.malBark)], [_blob(5.6, 0, COL.malLeaf, COL.malLeafTop, { oy: 12.8, seed: 81, squash: 0.75, noise: 0.12 })], H, 0.8, 0.3);
    return { lods: [l0, l1, l2], H };
  }
  function buildBush() {
    const g = finish(mergePlain([
      _blob(0.95, 1, COL.bush, COL.bushTop, { oy: 0.72, seed: 91, squash: 0.8, noise: 0.28 }),
      _blob(0.62, 0, COL.bush, COL.bushTop, { ox: 0.65, oy: 0.5, oz: 0.25, seed: 92, squash: 0.85, noise: 0.3 }),
      _blob(0.58, 0, COL.bush, COL.bushTop, { ox: -0.55, oy: 0.52, oz: -0.35, seed: 93, squash: 0.85, noise: 0.3 })]), 1.6, true, 0.6);
    return { lods: [g], H: 1.6 };
  }
  function buildShrub() {
    const g = finish(mergePlain([
      _blob(0.55, 0, COL.shrub, COL.shrubTop, { oy: 0.42, seed: 94, squash: 0.75, noise: 0.35 }),
      _blob(0.42, 0, COL.shrub, COL.shrubTop, { ox: 0.45, oy: 0.34, oz: -0.2, seed: 95, squash: 0.8, noise: 0.35 })]), 1.0, true, 0.5);
    return { lods: [g], H: 1.0 };
  }
  function rockPaint(g, mossAmt, seed) {
    const c = g.attributes.color, n = g.attributes.normal, p = g.attributes.position;
    for (let i = 0; i < c.count; i++) {
      const m = clamp((n.getY(i) - 0.35) * 1.5, 0, 1) * mossAmt * (0.5 + 0.5 * noise2(p.getX(i) * 2.1 + seed, p.getZ(i) * 2.1));
      c.setXYZ(i, lerp(c.getX(i), COL.moss[0], m), lerp(c.getY(i), COL.moss[1], m), lerp(c.getZ(i), COL.moss[2], m));
    }
  }
  function buildRock(seed, squash, noise, mossAmt) {
    const g = _blob(1, 1, COL.rock, COL.rockTop, { oy: 0.55 * squash, seed, squash, noise, jitter: 0.05 });
    rockPaint(g, mossAmt, seed);
    return { lods: [finish(g, 1, true, 0)], H: 1 };  // canopyFlag=1 so rocks get tint/snow, no sway
  }
  function buildStump() {
    const bark = paint(_tube([{ x: 0, y: -0.25, z: 0, r: 0.46 }, { x: 0, y: 0.15, z: 0, r: 0.4 }, { x: 0, y: 0.5, z: 0, r: 0.38 }], 7, { gnarl: 0.1, seed: 101, capTop: false }), COL.oakBark, COL.oakBarkTop, -0.25, 0.5, 0.03, 101);
    const top = paint(xform(new THREE.CircleGeometry(0.38, 7), 0, 0.5, 0, 0, -Math.PI / 2, 1), COL.cut, null, 0, 1, 0.04, 102);
    const roots = [];
    for (let i = 0; i < 3; i++) roots.push(branch(0, -0.05, 0, i * 2.1 + 0.5, -0.25, 0.7, 0.16, 0.05, 4, 1, 0, 103 + i, COL.oakBark));
    return { lods: [finish(mergePlain([bark, top].concat(roots)), 1, false, 0)], H: 1 };
  }
  function buildLog() {
    const pts = [{ x: -1.3, y: 0.3, z: 0, r: 0.3 }, { x: 0, y: 0.3, z: 0.05, r: 0.33 }, { x: 1.3, y: 0.3, z: 0, r: 0.27 }];
    const body = paint(_tube(pts, 7, { gnarl: 0.08, seed: 111, capTop: true, capBottom: true }), COL.oakBark, COL.oakBarkTop, 0, 0.6, 0.03, 111);
    const c = body.attributes.color; // lighter cut ends (cap centre vertices are the last two)
    for (let i = c.count - 2; i < c.count; i++) c.setXYZ(i, COL.cut[0], COL.cut[1], COL.cut[2]);
    const stub = branch(0.4, 0.45, 0.1, 1.3, 0.9, 0.5, 0.08, 0.03, 4, 1, 0, 112, COL.oakBark);
    return { lods: [finish(mergePlain([body, stub]), 1, false, 0)], H: 1 };
  }
  function buildReed() {
    const blades = [];
    for (let i = 0; i < 7; i++) {
      const h = 1.5 + hash2(i, 121) * 0.9, a = hash2(121, i) * Math.PI * 2, r = hash2(i * 7, 122) * 0.22;
      blades.push(xform(_plane2(0.09, h, 2, COL.reed, COL.reedTop, { taper: 0.25, tilt: 0.12 }), Math.cos(a) * r, 0, Math.sin(a) * r, a, 0, 1));
    }
    const g = finish(mergePlain(blades), 2.0, true, 1.3);
    return { lods: [g], H: 2 };
  }
  function buildFlower() {
    const stem = paint(_tube([{ x: 0, y: 0, z: 0, r: 0.022 }, { x: 0.02, y: 0.34, z: 0, r: 0.016 }], 3, { capTop: false }), COL.stem, COL.stem, 0, 1, 0, 1);
    const leaf = xform(_plane2(0.12, 0.2, 1, COL.stem, COL.stem, { taper: 0.1 }), 0.02, 0.05, 0, 0.8, -0.9, 1);
    const head = _blob(0.095, 0, COL.white, COL.white, { oy: 0.36, ox: 0.02, squash: 0.55, noise: 0.25, jitter: 0, seed: 131 });
    return finish(_mergeGeoms([finish(mergePlain([stem, leaf]), 0.4, false, 0.8), finish(head, 0.4, true, 0.8)]), 0.4, true, 0);
  }
  function buildMushroom() {
    const stem = paint(_tube([{ x: 0, y: 0, z: 0, r: 0.065 }, { x: 0, y: 0.22, z: 0, r: 0.05 }], 5, { capTop: true }), COL.cream, COL.cream, 0, 1, 0.02, 141);
    const cap = new THREE.SphereGeometry(0.17, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.scale(1, 0.62, 1); cap.translate(0, 0.2, 0);
    paint(cap, COL.white, COL.white, 0, 1, 0.03, 142);
    const under = paint(xform(new THREE.CircleGeometry(0.165, 7), 0, 0.2, 0, 0, Math.PI / 2, 1), COL.capUnder, null, 0, 1, 0, 1);
    return _mergeGeoms([finish(mergePlain([stem, under]), 0.35, false, 0), finish(cap, 0.35, true, 0)]);
  }
  function buildFern() {
    const fronds = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + hash2(i, 151) * 0.4, len = 0.8 + hash2(151, i) * 0.4;
      const f = _plane2(0.42, len, 3, COL.white, COL.white, { taper: 0.3, single: true });
      // frond grows outward and droops: rotate to lie at ~35° above ground, pointing along its yaw
      xform(f, 0, 0.05, 0, 0, 0, 1); f.rotateX(-1.05); f.rotateY(-a); fronds.push(f);
    }
    return finish(mergePlain(fronds), 0.9, true, 1.2, 0.1);
  }
  function buildGrass() {
    const a = _plane2(0.8, 0.55, 2, COL.white, COL.white, { single: true });
    const b = _plane2(0.8, 0.55, 2, COL.white, COL.white, { single: true }); b.rotateY(Math.PI / 2);
    // blades bend a lot: sway weight ~ t^1.6 * 1.6 (plus tiny base wobble)
    return finish(mergePlain([a, b]), 0.55, true, 1.6, 0.02);
  }
  function buildAllGeometry() {
    GEOMS.oak = buildOak(); GEOMS.pine = buildPine(false); GEOMS.snowpine = buildPine(true); GEOMS.birch = buildBirch();
    GEOMS.willow = buildWillow(); GEOMS.dead = buildDead(); GEOMS.mallorn = buildMallorn();
    GEOMS.bush = buildBush(); GEOMS.shrub = buildShrub();
    GEOMS.rock1 = buildRock(161, 0.55, 0.32, 0.55); GEOMS.rock2 = buildRock(162, 1.05, 0.38, 0.35); GEOMS.rock3 = buildRock(163, 0.8, 0.45, 0.45);
    GEOMS.boulder = buildRock(164, 0.78, 0.3, 0.3);
    GEOMS.stump = buildStump(); GEOMS.log = buildLog(); GEOMS.reed = buildReed();
    for (const k in GEOMS) GEOMS[k].tris = GEOMS[k].lods.map(triCount);
    DETAIL_GEOMS.grass = buildGrass(); DETAIL_GEOMS.flower = buildFlower(); DETAIL_GEOMS.fern = buildFern(); DETAIL_GEOMS.mushroom = buildMushroom();
  }

  /* ------------------------------------------------------------------------------------------------
   * Materials & wind shader injection
   * aVeg  (per vertex, vec2): x = sway weight, y = canopy flag (tint + snow apply where 1)
   * aInst (per instance, vec4): rgb = canopy tint multiplier, w = snow amount
   * ---------------------------------------------------------------------------------------------- */
  const uniforms = {
    uTime: { value: 0 }, uWind: { value: 1 }, uPlayer: { value: new THREE.Vector3() },
    uSunV: { value: new THREE.Vector3(0, 1, 0) },       // view-space direction TOWARD the sun (fed by update())
    uSunCol: { value: new THREE.Color(0, 0, 0) },       // sun colour × normalised intensity
  };
  const WIND_PERIOD = Math.PI * 4 * 25;   // all wind frequencies are multiples of 0.5 → seamless wrap
  function injectWind(shader, uFade, uTrans) {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWind = uniforms.uWind;
    shader.uniforms.uPlayer = uniforms.uPlayer;
    shader.uniforms.uSunV = uniforms.uSunV;
    shader.uniforms.uSunCol = uniforms.uSunCol;
    shader.uniforms.uFade = uFade;
    shader.uniforms.uTrans = uTrans;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', [
        'attribute vec2 aVeg;', 'attribute vec4 aInst;', 'uniform float uTime;', 'uniform float uWind;', 'uniform vec3 uPlayer;', 'uniform vec2 uFade;',
        'varying float vLeaf;',
        '#include <common>'].join('\n'))
      .replace('#include <color_vertex>', [
        '#include <color_vertex>',
        '  vLeaf = aVeg.y;',
        '#ifdef USE_COLOR',
        '  vColor.rgb *= mix(vec3(1.0), aInst.rgb, aVeg.y);',
        '  vColor.rgb = mix(vColor.rgb, vec3(0.93, 0.95, 1.0), aInst.w * clamp((normal.y - 0.1) * 1.5, 0.0, 1.0) * aVeg.y);',
        '#endif'].join('\n'))
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        '#ifdef USE_INSTANCING',
        '{',
        '  float sw = aVeg.x;',
        '  vec4 wp = modelMatrix * instanceMatrix * vec4(position, 1.0);',
        '  if (uFade.x < 1.0e5) transformed *= 1.0 - smoothstep(uFade.x, uFade.y, distance(wp.xz, uPlayer.xz));',
        '  if (sw > 0.001) {',
        '    float ph = wp.x * 0.1 + wp.z * 0.06;',
        '    float t = uTime;',
        '    float g = sin(t * 1.0 + ph) * 0.5 + sin(t * 2.5 + ph * 1.9 + 1.7) * 0.3 + sin(t * 4.0 + ph * 3.1 + 0.6) * 0.2;',
        '    float h = sin(t * 1.5 + ph * 1.3 + 2.1) * 0.6 + sin(t * 3.5 + ph * 2.7) * 0.4;',
        '    float amp = uWind * sw * 0.22;',
        '    vec3 wo = vec3(0.94, 0.0, 0.34) * (g * amp + uWind * uWind * sw * 0.05) + vec3(-0.34, 0.0, 0.94) * (h * amp * 0.45);',
        '    mat3 im = mat3(instanceMatrix);',
        '    vec3 oo = vec3(dot(im[0], wo), dot(im[1], wo), dot(im[2], wo)) / max(dot(im[0], im[0]), 1e-6);',
        '    transformed += oo;',
        '    transformed.y -= length(oo) * 0.35 * sw;',
        '  }',
        '}',
        '#endif'].join('\n'));
    // Leaf translucency: foliage lit from behind glows. Cheap wrap-around term driven by how much the camera is
    // looking INTO the sun through the leaf; only canopy/blade vertices (aVeg.y = 1) take it, and uTrans is 0 on rock.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', 'varying float vLeaf;\nuniform vec3 uSunV;\nuniform vec3 uSunCol;\nuniform float uTrans;\n#include <common>')
      .replace('#include <opaque_fragment>', [
        'if (uTrans > 0.0 && vLeaf > 0.01) {',
        '  float bl = max(dot(-uSunV, normalize(vViewPosition)), 0.0);',
        '  bl = bl * bl * bl;',
        '  outgoingLight += diffuseColor.rgb * uSunCol * (uTrans * vLeaf * bl);',
        '}',
        '#include <opaque_fragment>'].join('\n'));
  }
  const MATS = {};
  function makeMaterial(opts, fadeNear, fadeFar, trans) {
    const m = new THREE.MeshStandardMaterial(Object.assign({ vertexColors: true, roughness: 0.92, metalness: 0.0 }, opts));
    const uFade = { value: new THREE.Vector2(fadeNear == null ? 1e6 : fadeNear, fadeFar == null ? 1e6 + 1 : fadeFar) };
    const uTrans = { value: trans == null ? 0 : trans };
    m.userData.uFade = uFade; m.userData.uTrans = uTrans;
    m.onBeforeCompile = (shader) => injectWind(shader, uFade, uTrans);
    m.customProgramCacheKey = () => 'veg_wind2_' + (opts.map ? 'a' : 'o') + (opts.flatShading ? 'f' : 's') + (fadeNear == null ? '' : 'd');
    return m;
  }
  function paintGrassTexture(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    const rng = makeRng(777);
    for (let i = 0; i < 11; i++) {
      const x0 = w * (0.08 + 0.84 * (i / 10)) + (rng() - 0.5) * w * 0.06;
      const bw = w * (0.045 + rng() * 0.035), bh = h * (0.55 + rng() * 0.45), lean = (rng() - 0.5) * w * 0.35;
      const grad = ctx.createLinearGradient(0, h, 0, h - bh);
      const v = 0.42 + rng() * 0.12;
      grad.addColorStop(0, `rgb(${Math.round(255 * v * 0.55)},${Math.round(255 * v * 0.62)},${Math.round(255 * v * 0.35)})`);
      grad.addColorStop(0.6, `rgb(${Math.round(255 * (v + 0.25))},${Math.round(255 * (v + 0.3))},${Math.round(255 * (v + 0.05))})`);
      grad.addColorStop(1, `rgb(${Math.round(255 * 0.98)},${Math.round(255 * 0.99)},${Math.round(255 * 0.72)})`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x0 - bw, h);
      ctx.quadraticCurveTo(x0 - bw * 0.4 + lean * 0.5, h - bh * 0.55, x0 + lean, h - bh);
      ctx.quadraticCurveTo(x0 + bw * 0.4 + lean * 0.5, h - bh * 0.55, x0 + bw, h);
      ctx.closePath(); ctx.fill();
    }
  }
  function paintFernTexture(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = 'rgb(150,170,90)'; ctx.lineWidth = w * 0.035; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(w * 0.5, h); ctx.lineTo(w * 0.5, h * 0.04); ctx.stroke();
    const n = 13;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1), y = h * (0.97 - t * 0.9), len = w * 0.46 * Math.sin(Math.PI * (0.15 + 0.85 * (1 - t)) * 0.75 + 0.2) * (1 - t * 0.55);
      const lw = h * 0.05 * (1 - t * 0.5);
      const v = 0.55 + t * 0.4;
      ctx.fillStyle = `rgb(${Math.round(255 * v * 0.85)},${Math.round(255 * v)},${Math.round(255 * v * 0.5)})`;
      for (const s of [-1, 1]) {
        ctx.beginPath(); ctx.moveTo(w * 0.5, y);
        ctx.quadraticCurveTo(w * 0.5 + s * len * 0.5, y - lw * 1.6, w * 0.5 + s * len, y - lw * 0.6);
        ctx.quadraticCurveTo(w * 0.5 + s * len * 0.5, y + lw * 0.9, w * 0.5, y + lw * 0.6);
        ctx.closePath(); ctx.fill();
      }
    }
  }
  function makeTexture(w, h, fn) {
    let tex;
    if (G.canvasTexture) tex = G.canvasTexture(w, h, fn, { repeat: [1, 1], wrap: false, nearest: false });
    if (!tex) {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h; fn(cv.getContext('2d'), w, h);
      tex = new THREE.CanvasTexture(cv);
    }
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
    if ('colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4; tex.needsUpdate = true;
    return tex;
  }
  function buildMaterials() {
    MATS.tree = makeMaterial({ side: THREE.FrontSide }, null, null, 0.55);
    MATS.rock = makeMaterial({ flatShading: true, roughness: 0.95 }, null, null, 0);
    MATS.grass = makeMaterial({ map: makeTexture(128, 128, paintGrassTexture), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85 }, 38, 50, 0.7);
    MATS.fern = makeMaterial({ map: makeTexture(128, 128, paintFernTexture), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 0.85 }, 47, 62, 0.7);
    MATS.detail = makeMaterial({ side: THREE.FrontSide }, 38, 52, 0.4);
  }

  /* ------------------------------------------------------------------------------------------------
   * Instanced mesh registry
   * meshes[type][lod] = { mesh, cap, cursor, mats(Float32Array view), inst(Float32Array view), attr }
   * ---------------------------------------------------------------------------------------------- */
  const MESHES = {};
  const RING_MESHES = {};
  let group = null;
  let densityMult = 1;

  function makeInstanced(geom, mat, cap, shadow, name) {
    const mesh = new THREE.InstancedMesh(geom, mat, cap);
    mesh.count = 0;
    mesh.frustumCulled = false;         // meshes always surround the player; culling would never reject them
    mesh.castShadow = !!shadow; mesh.receiveShadow = true;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const inst = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    inst.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < cap; i++) { inst.array[i * 4] = 1; inst.array[i * 4 + 1] = 1; inst.array[i * 4 + 2] = 1; }
    // geometry is shared per type; per-mesh instanced attribute must live on a per-mesh geometry clone (cheap: shares buffers)
    const g = geom.clone ? cloneShared(geom) : geom;
    g.setAttribute('aInst', inst);
    mesh.geometry = g;
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    return { mesh, cap, cursor: 0, mats: mesh.instanceMatrix.array, inst: inst.array, attr: inst, tris: triCount(geom) };
  }
  function cloneShared(geom) { // new BufferGeometry sharing the attribute objects (no vertex data copy)
    const g = new THREE.BufferGeometry();
    for (const k in geom.attributes) g.setAttribute(k, geom.attributes[k]);
    if (geom.index) g.setIndex(geom.index);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 1e6);
    return g;
  }
  function buildMeshes(scene) {
    group = new THREE.Group(); group.name = 'vegetation'; group.matrixAutoUpdate = false;
    for (const type in TYPES) {
      const spec = TYPES[type], gd = GEOMS[type]; if (!gd) continue;
      MESHES[type] = [];
      const mat = spec.kind === 'rock' ? MATS.rock : MATS.tree;
      for (let l = 0; l < gd.lods.length; l++) {
        const capBase = spec.cap[l] || spec.cap[0];
        const cap = Math.max(64, Math.round(capBase * 1.25));   // fixed at build: setDensity() may raise density later
        const rec = makeInstanced(gd.lods[l], mat, cap, spec.shadow && l === 0, 'veg_' + type + '_L' + l);
        MESHES[type].push(rec); group.add(rec.mesh);
      }
    }
    scene.add(group);
  }

  /* ------------------------------------------------------------------------------------------------
   * World lookups (zones, towns) & biome placement profiles
   * ---------------------------------------------------------------------------------------------- */
  const DEFAULT_ZONE = { id: 'wild', biome: 'wild', treeDensity: 0.18, treeTypes: ['oak', 'pine', 'birch'], grassColor: 0x6f9a3a, groundColor: 0x5c7d34 };
  const DEFAULT_DENSITY = { shire: 0.16, breeland: 0.25, forest: 0.9, downs: 0.12, barren: 0.06, lake: 0.22, elven: 0.35, mountain: 0.3, dark: 0.1, arctic: 0.12, island: 0.3, wild: 0.18 };
  // per-cell mean counts (scaled by density multiplier); type weights; ring densities 0..1; grass height/tint
  const PROFILES = {
    shire:    { types: { oak: 5, birch: 2, willow: 1 }, bush: 9, shrub: 0, rock: 1.5, boulder: 0, stump: 0.4, log: 0.2, hedge: true, orchard: true, flower: 1.0, fern: 0.15, mushroom: 0.25, grassH: 1.0 },
    breeland: { types: { oak: 4, birch: 2, pine: 1 }, bush: 7, shrub: 1, rock: 2.5, boulder: 0.2, stump: 1, log: 0.6, hedge: true, flower: 0.6, fern: 0.3, mushroom: 0.4, grassH: 1.0 },
    forest:   { types: { oak: 4, pine: 3, birch: 2 }, bush: 10, shrub: 1, rock: 2.5, boulder: 0.3, stump: 2, log: 2, flower: 0.15, fern: 1.0, mushroom: 1.0, grassH: 0.9, grassTint: [0.9, 1, 0.85] },
    downs:    { types: { oak: 2, birch: 1, dead: 1 }, bush: 2, shrub: 7, rock: 6, boulder: 1.0, stump: 0.3, log: 0.2, flower: 0.5, fern: 0.05, mushroom: 0.1, grassH: 0.85 },
    barren:   { types: { dead: 5, pine: 1 }, bush: 0, shrub: 9, rock: 8, boulder: 1.5, stump: 0.3, log: 0.3, flower: 0.08, fern: 0, mushroom: 0.1, grassH: 0.6, grassTint: [1.15, 1.0, 0.6], darkTint: [1, 0.95, 0.85] },
    lake:     { types: { willow: 3, birch: 2, oak: 2 }, bush: 5, shrub: 1, rock: 2, boulder: 0.3, stump: 0.3, log: 0.4, flower: 0.8, fern: 0.4, mushroom: 0.3, grassH: 1.0 },
    elven:    { types: { mallorn: 3, birch: 3, oak: 1 }, bush: 4, shrub: 0, rock: 1.5, boulder: 0.2, stump: 0, log: 0.2, flower: 1.2, fern: 0.5, mushroom: 0.4, grassH: 1.0 },
    mountain: { types: { pine: 6, snowpine: 1, dead: 0.5 }, bush: 0.5, shrub: 4, rock: 7, boulder: 1.2, stump: 0.3, log: 0.3, flower: 0.2, fern: 0.1, mushroom: 0.1, grassH: 0.75, snow: true },
    dark:     { types: { dead: 5, pine: 2 }, bush: 0, shrub: 6, rock: 9, boulder: 2, stump: 0.5, log: 0.5, flower: 0, fern: 0.1, mushroom: 0.5, grassH: 0.6, grassTint: [0.8, 0.85, 0.7], darkTint: [0.55, 0.6, 0.55], paleMushroom: true },
    arctic:   { types: { snowpine: 6, dead: 1 }, treeMul: 0.6, bush: 0, shrub: 2, rock: 6, boulder: 2, stump: 0.1, log: 0.2, flower: 0, fern: 0, mushroom: 0, grassH: 0.6, grassTint: [1.0, 1.0, 0.8], snow: true, snowAll: true },
    island:   { types: { pine: 2, oak: 2, birch: 2, willow: 1 }, bush: 6, shrub: 2, rock: 6, boulder: 1, stump: 0.3, log: 0.5, flower: 0.6, fern: 0.3, mushroom: 0.2, grassH: 0.95 },
    wild:     { types: { oak: 3, pine: 2, birch: 2 }, bush: 4, shrub: 2, rock: 3, boulder: 0.5, stump: 0.5, log: 0.5, flower: 0.4, fern: 0.3, mushroom: 0.3, grassH: 1.0 },
  };
  const FLOWER_COLS = [0xfff4f0, 0xffd83a, 0xe8437a, 0x6a6cf0, 0xff8c2a].map(hexRGB);
  const MUSHROOM_COLS = [0xc93a2a, 0x8c5a2b, 0xd9b26a].map(hexRGB);
  const PALE_MUSHROOM = hexRGB(0xd8d2c0);

  const WORLD = { zones: null, byId: null, towns: null };
  function resolveWorld() {
    if (WORLD.zones) return;
    const w = (G.Data && G.Data.world) || {};
    WORLD.zones = Array.isArray(w.zones) ? w.zones : [];
    WORLD.byId = {}; for (const z of WORLD.zones) WORLD.byId[z.id] = z;
    WORLD.towns = (Array.isArray(w.towns) ? w.towns : []).map(t => ({ id: t.id, x: t.pos ? t.pos.x : 0, z: t.pos ? t.pos.z : 0, r: t.radius || 60, zone: t.zone, style: t.style }));
  }
  function zoneAtPos(x, z) {
    resolveWorld();
    const T = G.Terrain;
    if (T && T.zoneAt) { const id = T.zoneAt(x, z); const zn = id && WORLD.byId[id]; if (zn) return zn; }
    let best = null, bd = Infinity;
    for (const zn of WORLD.zones) {
      const c = zn.center || { x: 0, z: 0 }; const d = Math.hypot(x - c.x, z - c.z) / (zn.radius || 300);
      if (d < 1 && d < bd) { bd = d; best = zn; }
    }
    return best || DEFAULT_ZONE;
  }
  function profileFor(zone) {
    const b = (zone && zone.biome) || 'wild';
    return PROFILES[b] || PROFILES[(b.split('/')[0])] || PROFILES.wild;
  }
  function zoneTreeDensity(zone) {
    if (zone && typeof zone.treeDensity === 'number') return zone.treeDensity;
    return DEFAULT_DENSITY[(zone && zone.biome) || 'wild'] || 0.18;
  }
  // towns whose (radius + margin) reaches the cell — usually 0..2 of them
  function townsNear(xc, zc, margin) {
    resolveWorld();
    const out = [];
    for (const t of WORLD.towns) if (Math.hypot(t.x - xc, t.z - zc) < t.r + margin) out.push(t);
    return out;
  }
  // 0 = blocked (town core), 1 = free, 0.15 = decorative outskirts (radius*0.8..1.0)
  function townFactor(x, z, towns) {
    for (let i = 0; i < towns.length; i++) {
      const t = towns[i]; const d = Math.hypot(x - t.x, z - t.z);
      if (d < t.r * 0.8) return 0;
      if (d < t.r) return 0.15;
    }
    return 1;
  }

  /* ------------------------------------------------------------------------------------------------
   * Cell generation — deterministic content of one 64 m cell
   * cell.groups[type] = [ { q, n, nFar, mats: Float32Array(n*16), inst: Float32Array(n*4) } ] — one entry per 32 m
   * quadrant q (0..3) that has items; far-kept items come first so the far LOD copies a prefix.
   * ---------------------------------------------------------------------------------------------- */
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
  const _rgb = [0, 0, 0];
  const _rp = { x: 0, z: 0, dist: 0 };
  const _hedgeSeen = new Set();
  function emit(cell, type, x, y, z, yaw, sx, sy, sz, tr, tg, tb, snow, tiltX, tiltZ, keepFar) {
    let qs = cell.tmp[type]; if (!qs) qs = cell.tmp[type] = [null, null, null, null];
    const q = (x >= cell.x0 + CELL / 2 ? 1 : 0) + (z >= cell.z0 + CELL / 2 ? 2 : 0);
    let grp = qs[q]; if (!grp) grp = qs[q] = { near: [], far: [] };
    _e.set(tiltX || 0, yaw || 0, tiltZ || 0, 'YXZ'); _q.setFromEuler(_e); _p.set(x, y, z); _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s);
    const a = keepFar ? grp.far : grp.near, el = _m.elements;
    for (let i = 0; i < 16; i++) a.push(el[i]);
    a.push(tr, tg, tb, snow);
  }
  function packCell(cell) {
    for (const type in cell.tmp) {
      const subs = [];
      for (let q = 0; q < 4; q++) {
        const g = cell.tmp[type][q]; if (!g) continue;
        const nFar = g.far.length / 20, n = nFar + g.near.length / 20;
        const mats = new Float32Array(n * 16), inst = new Float32Array(n * 4);
        let k = 0;
        const take = (arr) => { for (let i = 0; i < arr.length; i += 20) { for (let j = 0; j < 16; j++) mats[k * 16 + j] = arr[i + j]; for (let j = 0; j < 4; j++) inst[k * 4 + j] = arr[i + 16 + j]; k++; } };
        take(g.far); take(g.near);
        subs.push({ q, n, nFar, mats, inst });
        cell.n += n;
      }
      cell.groups[type] = subs;
    }
    cell.tmp = null;
  }
  function nearWater(T, x, z, d) {
    return T.height(x + d, z) < SEA || T.height(x - d, z) < SEA || T.height(x, z + d) < SEA || T.height(x, z - d) < SEA;
  }
  // place check: returns 0 = no, 1 = ok, 2 = too steep (rock instead)
  function placeOK(T, x, z, towns, allowOutskirts, rng) {
    const y = T.height(x, z);
    if (y < SEA + 0.25) return 0;
    if (T.onRoad && T.onRoad(x, z) > 0.2) return 0;
    const tf = townFactor(x, z, towns);
    if (tf === 0) return 0;
    if (tf < 1 && (!allowOutskirts || rng() > tf)) return 0;
    if (T.slope && T.slope(x, z) > 0.6) return 2;
    return 1;
  }
  function pickType(weights, r) {
    let tot = 0; for (let i = 0; i < weights.length; i++) tot += weights[i][1];
    let v = r * tot;
    for (let i = 0; i < weights.length; i++) { v -= weights[i][1]; if (v <= 0) return weights[i][0]; }
    return weights[weights.length - 1][0];
  }
  function treeWeights(zone, prof) {
    const list = (zone && Array.isArray(zone.treeTypes) && zone.treeTypes.length) ? zone.treeTypes.filter(t => TYPES[t]) : Object.keys(prof.types);
    const out = [];
    for (const t of list) out.push([t, prof.types[t] || 0.6]);
    return out.length ? out : [['oak', 1]];
  }
  function addRock(cell, T, x, z, rng, prof, snowy, scaleMul) {
    const y = T.height(x, z);
    const type = ['rock1', 'rock2', 'rock3'][Math.floor(rng() * 3)];
    const s = (0.45 + rng() * 1.1) * (scaleMul || 1);
    const g = 0.85 + rng() * 0.3, warm = (rng() - 0.5) * 0.08;
    emit(cell, type, x, y - 0.12 * s, z, rng() * Math.PI * 2, s * (0.8 + rng() * 0.5), s, s * (0.8 + rng() * 0.5), g + warm, g, g - warm, snowy ? 1 : 0, (rng() - 0.5) * 0.3, (rng() - 0.5) * 0.3, true);
  }
  function snowAt(T, prof, x, z) {
    if (prof.snowAll) return 1;
    if (!prof.snow) return 0;
    return (T.groundType && T.groundType(x, z) === 'snow') ? 1 : 0;
  }
  function genCell(cx, cz) {
    const T = G.Terrain;
    const x0 = cx * CELL, z0 = cz * CELL, xc = x0 + CELL / 2, zc = z0 + CELL / 2;
    const key = cx + ',' + cz;
    const cell = { key, cx, cz, x0, z0, groups: {}, tmp: {}, tx: [], tz: [], tr: [], th: [], n: 0, phys: false, zone: null, prof: null };
    if (!T || !T.height) { cell.tmp = null; return cell; }
    const zone = zoneAtPos(xc, zc), prof = profileFor(zone);
    cell.zone = zone; cell.prof = prof;
    const rng = makeRng(cellSeed(cx, cz, 1));
    const towns = townsNear(xc, zc, CELL);
    const dark = prof.darkTint || null;
    // grove-scale colour drift (≈ 200–300 m features): neighbouring stands of trees read as different stands
    // instead of one continuous sheet of the same green. Mean-neutral, deterministic (fbm, not rng).
    const gvA = clamp(fbm(xc * 0.0034 + 21.7, zc * 0.0034 - 11.3, 2) * 0.5 + 0.5, 0, 1);
    const gvB = clamp(fbm(xc * 0.0071 - 5.1, zc * 0.0071 + 9.4, 2) * 0.5 + 0.5, 0, 1);
    const grove = [0.925 + 0.15 * gvA, 0.955 + 0.09 * gvB, 0.86 + 0.28 * (1 - gvA)];
    const spawnTree = (type, x, z, y, s, keepFar, tintMul) => {
      const spec = TYPES[type];
      const jr = (0.85 + rng() * 0.30) * grove[0], jg = (0.88 + rng() * 0.24) * grove[1], jb = (0.78 + rng() * 0.30) * grove[2];
      let tr = jr, tg = jg, tb = jb;
      if (dark) { tr *= dark[0]; tg *= dark[1]; tb *= dark[2]; }
      if (tintMul) { tr *= tintMul[0]; tg *= tintMul[1]; tb *= tintMul[2]; }
      const snow = snowAt(T, prof, x, z);
      const sy = s * (0.92 + rng() * 0.16);
      emit(cell, type, x, y - 0.12 * s, z, rng() * Math.PI * 2, s, sy, s, tr, tg, tb, snow, (rng() - 0.5) * 0.06, (rng() - 0.5) * 0.06, keepFar);
      cell.tx.push(x); cell.tz.push(z); cell.tr.push(spec.r * s); cell.th.push(spec.h * sy);
    };

    // ---- trees -------------------------------------------------------------------------------
    const clump = 0.5 + 0.8 * clamp(fbm(xc * 0.0045 + 7.3, zc * 0.0045 - 3.1, 3) * 0.5 + 0.5, 0, 1);
    const nTrees = Math.round(MAX_TREES_CELL * zoneTreeDensity(zone) * (prof.treeMul || 1) * clump * densityMult);
    const weights = treeWeights(zone, prof);
    for (let i = 0; i < nTrees; i++) {
      const x = x0 + rng() * CELL, z = z0 + rng() * CELL;
      const ok = placeOK(T, x, z, towns, true, rng);
      if (ok === 0) continue;
      if (ok === 2) { if (rng() < 0.5) addRock(cell, T, x, z, rng, prof, snowAt(T, prof, x, z), 1); continue; }
      let type = pickType(weights, rng());
      const gt = T.groundType ? T.groundType(x, z) : 'grass';
      if (gt === 'snow') { if (prof.snowAll) type = 'snowpine'; else continue; }   // pines stop at the snow line
      if (gt === 'sand' && rng() < 0.8) continue;
      if (type === 'willow' && !nearWater(T, x, z, 12)) type = (rng() < 0.5 && weights.some(w => w[0] === 'birch')) ? 'birch' : 'oak';
      if (type === 'mallorn' && rng() < 0.5) type = 'birch';                        // mallorn are rare giants
      const s = 0.8 + rng() * 0.6;
      spawnTree(type, x, z, T.height(x, z), type === 'mallorn' ? s * 0.9 : s, rng() < FAR_KEEP);
    }
    // ---- hedgerows along roads (shire / bree-land): one bush per ~2.5 m of road, 6.5 m off the centre line ----
    if (prof.hedge && (T.nearestRoadPoint || T.onRoad)) {
      let nearRoad = true;
      if (T.nearestRoadPoint) { const rp = T.nearestRoadPoint(xc, zc, _rp); nearRoad = rp && rp.dist < CELL; }
      if (nearRoad) {
        const step = 2.5, HEDGE_D = 6.5;
        _hedgeSeen.clear();
        for (let gx = 0; gx < CELL; gx += step) for (let gz = 0; gz < CELL; gz += step) {
          const x = x0 + gx + step * 0.5, z = z0 + gz + step * 0.5;
          let rx, rz, dist;
          if (T.nearestRoadPoint) { const rp = T.nearestRoadPoint(x, z, _rp); if (!rp) continue; rx = rp.x; rz = rp.z; dist = rp.dist; }
          else { // fallback: estimate the road direction from the onRoad gradient
            const r = T.onRoad(x, z); if (r < 0.01 || r > 0.5) continue;
            const gxr = T.onRoad(x + 1, z) - T.onRoad(x - 1, z), gzr = T.onRoad(x, z + 1) - T.onRoad(x, z - 1);
            const gl = Math.hypot(gxr, gzr); if (gl < 1e-4) continue;
            dist = 4.5; rx = x + (gxr / gl) * dist; rz = z + (gzr / gl) * dist;
          }
          if (!(dist >= 3.5 && dist <= 10.5)) continue;
          const dx = (x - rx) / dist, dz = (z - rz) / dist;
          const hx = rx + dx * HEDGE_D, hz = rz + dz * HEDGE_D;
          if (hx < x0 || hx >= x0 + CELL || hz < z0 || hz >= z0 + CELL) continue;
          // one bush per 2.5 m of road on each side; 20 m sections gated by hash so hedges have gaps and gates
          const side = (dx * 0.3 - dz * 0.95) > 0 ? 1 : 0;
          const key = Math.round(rx / 2.5) * 73856093 ^ Math.round(rz / 2.5) * 19349663 ^ side * 83492791;
          if (_hedgeSeen.has(key)) continue; _hedgeSeen.add(key);
          if (hash2(Math.floor(rx / 20) * 1.3 + side * 7.7, Math.floor(rz / 20) * 0.7) > 0.62) continue;
          if (T.height(hx, hz) < SEA + 0.2 || townFactor(hx, hz, towns) === 0) continue;
          if (T.onRoad && T.onRoad(hx, hz) > 0.05) continue;
          const s = 0.85 + hash2(hx * 0.37, hz * 0.91) * 0.4;
          emit(cell, 'bush', hx + (rng() - 0.5) * 0.6, T.height(hx, hz) - 0.12, hz + (rng() - 0.5) * 0.6, rng() * Math.PI * 2, s * 1.25, s * 0.8, s * 1.25, 0.9 + rng() * 0.2, 0.92 + rng() * 0.16, 0.85 + rng() * 0.2, 0, 0, 0, true);
        }
      }
    }
    // ---- orchards outside shire towns -----------------------------------------------------------
    if (prof.orchard) {
      for (const t of townsNear(xc, zc, CELL * 2)) {
        for (let k = 0; k < 2; k++) {
          const ang = hash2(t.x * 0.01 + k * 3.7, t.z * 0.01 - k) * Math.PI * 2;
          const ox = t.x + Math.cos(ang) * t.r * 1.3, oz = t.z + Math.sin(ang) * t.r * 1.3;
          if (Math.abs(ox - xc) > CELL + 24 || Math.abs(oz - zc) > CELL + 24) continue;
          const ca = Math.cos(ang), sa = Math.sin(ang);
          for (let u = -18; u <= 18; u += 6) for (let v = -12; v <= 12; v += 6) {
            const x = ox + u * ca - v * sa, z = oz + u * sa + v * ca;
            if (x < x0 || x >= x0 + CELL || z < z0 || z >= z0 + CELL) continue;
            if (placeOK(T, x, z, towns, false, rng) !== 1) continue;
            spawnTree('oak', x, z, T.height(x, z), 0.55 + rng() * 0.12, true, [1.05, 1.0, 0.8]);
          }
        }
      }
    }
    // ---- bushes / shrubs / rocks / boulders / stumps / logs -------------------------------------
    const count = (mean) => Math.round(mean * densityMult * (0.5 + rng()));
    const nb = count(prof.bush), ns = count(prof.shrub);
    for (let i = 0; i < nb + ns; i++) {
      const x = x0 + rng() * CELL, z = z0 + rng() * CELL;
      if (placeOK(T, x, z, towns, false, rng) !== 1) continue;
      const gt = T.groundType ? T.groundType(x, z) : 'grass';
      if (gt === 'snow' || gt === 'sand') continue;
      const s = 0.7 + rng() * 0.7; const type = i < nb ? 'bush' : 'shrub';
      let tr = 0.88 + rng() * 0.24, tg = 0.9 + rng() * 0.2, tb = 0.85 + rng() * 0.2;
      if (dark) { tr *= dark[0]; tg *= dark[1]; tb *= dark[2]; }
      emit(cell, type, x, T.height(x, z) - 0.08 * s, z, rng() * Math.PI * 2, s, s * (0.85 + rng() * 0.3), s, tr, tg, tb, snowAt(T, prof, x, z), 0, 0, true);
    }
    const mountainous = clamp((zone && zone.mountain) || 0, 0, 1);
    const nr = count(prof.rock * (1 + mountainous * 1.5));
    for (let i = 0; i < nr; i++) {
      const x = x0 + rng() * CELL, z = z0 + rng() * CELL;
      if (T.height(x, z) < SEA + 0.1 || (T.onRoad && T.onRoad(x, z) > 0.15) || townFactor(x, z, towns) < 1) continue;
      const sl = T.slope ? T.slope(x, z) : 0;
      if (rng() > Math.min(0.8, 0.12 + sl * 1.3 + mountainous * 0.2)) continue;
      addRock(cell, T, x, z, rng, prof, snowAt(T, prof, x, z), 1 + sl * 0.6);
    }
    const nbo = count(prof.boulder * (1 + mountainous));
    for (let i = 0; i < nbo; i++) {
      const x = x0 + rng() * CELL, z = z0 + rng() * CELL;
      if (T.height(x, z) < SEA + 0.1 || (T.onRoad && T.onRoad(x, z) > 0.1) || townFactor(x, z, towns) < 1) continue;
      const s = 1.7 + rng() * 1.8, g = 0.8 + rng() * 0.3, y = T.height(x, z);
      emit(cell, 'boulder', x, y - 0.35 * s, z, rng() * Math.PI * 2, s * (0.85 + rng() * 0.3), s, s * (0.85 + rng() * 0.3), g, g, g + (rng() - 0.5) * 0.06, snowAt(T, prof, x, z), (rng() - 0.5) * 0.25, (rng() - 0.5) * 0.25, true);
      cell.tx.push(x); cell.tz.push(z); cell.tr.push(TYPES.boulder.r * s * 0.6 + 0.2); cell.th.push(TYPES.boulder.h * s * 0.6);
    }
    const nst = count(prof.stump), nlg = count(prof.log);
    for (let i = 0; i < nst + nlg; i++) {
      const x = x0 + rng() * CELL, z = z0 + rng() * CELL;
      if (placeOK(T, x, z, towns, false, rng) !== 1) continue;
      const s = 0.8 + rng() * 0.6, y = T.height(x, z);
      if (i < nst) emit(cell, 'stump', x, y - 0.05, z, rng() * Math.PI * 2, s, s, s, 1, 1, 1, snowAt(T, prof, x, z), 0, 0, true);
      else emit(cell, 'log', x, y - 0.05, z, rng() * Math.PI * 2, s, s, s, 1, 1, 1, snowAt(T, prof, x, z), (rng() - 0.5) * 0.15, (rng() - 0.5) * 0.2, true);
    }
    // ---- reeds on shorelines --------------------------------------------------------------------
    {
      let hmin = Infinity, hmax = -Infinity;
      for (let i = 0; i <= 2; i++) for (let j = 0; j <= 2; j++) { const h = T.height(x0 + i * CELL / 2, z0 + j * CELL / 2); if (h < hmin) hmin = h; if (h > hmax) hmax = h; }
      if (hmin < SEA - 0.3 && hmax > SEA + 0.3 && !prof.snowAll) {
        const step = 2.5;
        for (let gx = 0; gx < CELL; gx += step) for (let gz = 0; gz < CELL; gz += step) {
          const x = x0 + gx + rng() * step, z = z0 + gz + rng() * step;
          const h = T.height(x, z);
          if (h < SEA - 0.5 || h > SEA + 0.5) continue;
          if (rng() < 0.45 || (T.onRoad && T.onRoad(x, z) > 0.1)) continue;
          if (townFactor(x, z, towns) === 0) continue;
          const s = 0.7 + rng() * 0.5;
          emit(cell, 'reed', x, Math.max(h, SEA - 0.3) - 0.05, z, rng() * Math.PI * 2, s, s * (0.8 + rng() * 0.5), s, 0.9 + rng() * 0.2, 0.95 + rng() * 0.1, 0.85 + rng() * 0.2, 0, 0, 0, true);
        }
      }
    }
    packCell(cell);
    return cell;
  }

  /* ------------------------------------------------------------------------------------------------
   * Cell streaming (generate around the player, unload far away) + physics ring
   * ---------------------------------------------------------------------------------------------- */
  const cells = new Map();              // key → cell
  let genQueue = [], genIdx = 0;        // pending cells (nearest first)
  let lastCellX = null, lastCellZ = null;
  let built = false, dirty = false, forceRebuild = false, physDirty = false;
  let lastRebuildTime = -1e9, tAcc = 0;
  let wind = 1, windTarget = 1;
  let colliderCount = 0;
  const prof = { genMs: 0, genMsMax: 0, genCount: 0, genMsTotal: 0 };
  const rebuild = { active: false, list: null, idx: 0, px: 0, pz: 0 };
  const _qd = [0, 0, 0, 0];
  const cellKey = (cx, cz) => cx + ',' + cz;
  function cellDist(x0, z0, px, pz, size) {   // xz distance from a point to a cell square
    size = size || CELL;
    const dx = Math.max(x0 - px, 0, px - (x0 + size)), dz = Math.max(z0 - pz, 0, pz - (z0 + size));
    return Math.sqrt(dx * dx + dz * dz);
  }
  function unloadCell(cell) {
    if (cell.phys) { if (G.Physics && G.Physics.clearTag) G.Physics.clearTag('veg:' + cell.key); colliderCount -= cell.tx.length; cell.phys = false; }
    cells.delete(cell.key);
    dirty = true;
  }
  function scheduleCells(px, pz) {
    const R = VIS_FAR + KEEP_MARGIN, cr = Math.ceil(VIS_FAR / CELL);
    const pcx = Math.floor(px / CELL), pcz = Math.floor(pz / CELL);
    for (const cell of Array.from(cells.values())) if (cellDist(cell.x0, cell.z0, px, pz) > R) unloadCell(cell);
    const cand = [];
    for (let cx = pcx - cr; cx <= pcx + cr; cx++) for (let cz = pcz - cr; cz <= pcz + cr; cz++) {
      const key = cellKey(cx, cz); if (cells.has(key)) continue;
      const d = cellDist(cx * CELL, cz * CELL, px, pz); if (d > VIS_FAR) continue;
      cand.push({ key, cx, cz, d });
    }
    cand.sort((a, b) => a.d - b.d);
    genQueue = cand; genIdx = 0;
  }
  function generateSome(budgetMs) {
    const t0 = performance.now();
    while (genIdx < genQueue.length) {
      const c = genQueue[genIdx++];
      if (!cells.has(c.key)) {
        const t1 = performance.now();
        cells.set(c.key, genCell(c.cx, c.cz)); dirty = true; physDirty = true;
        prof.genMs = performance.now() - t1; prof.genMsTotal += prof.genMs; prof.genCount++; if (prof.genMs > prof.genMsMax) prof.genMsMax = prof.genMs;
      }
      if (performance.now() - t0 > budgetMs) break;
    }
    if (genIdx >= genQueue.length) { genQueue = []; genIdx = 0; }
  }
  function updatePhysics(px, pz) {
    const P = G.Physics; if (!P || !P.addCylinder) return;
    for (const cell of cells.values()) {
      const d = cellDist(cell.x0, cell.z0, px, pz);
      if (!cell.phys && d < PHYS_RADIUS) {
        const tag = 'veg:' + cell.key;
        for (let i = 0; i < cell.tx.length; i++) P.addCylinder(cell.tx[i], cell.tz[i], cell.tr[i], cell.th[i], tag);
        colliderCount += cell.tx.length; cell.phys = true;
      } else if (cell.phys && d > PHYS_RADIUS + CELL) {
        if (P.clearTag) P.clearTag('veg:' + cell.key);
        colliderCount -= cell.tx.length; cell.phys = false;
      }
    }
  }

  /* ------------------------------------------------------------------------------------------------
   * Instance rebuild — copies each loaded cell's packed matrices into the (type, LOD) meshes; spread over frames.
   * Writes go straight into the attribute arrays; the GPU only sees them when commit() flags needsUpdate.
   * ---------------------------------------------------------------------------------------------- */
  function startRebuild(px, pz) {
    const list = [];
    for (const cell of cells.values()) { cell.d = cellDist(cell.x0, cell.z0, px, pz); if (cell.n > 0) list.push(cell); }
    list.sort((a, b) => a.d - b.d);          // nearest first: capacity overflow drops the farthest cells
    for (const type in MESHES) for (const rec of MESHES[type]) rec.cursor = 0;
    rebuild.list = list; rebuild.idx = 0; rebuild.active = true; rebuild.px = px; rebuild.pz = pz;
    dirty = false; forceRebuild = false;
    lastRebuildTime = tAcc;
  }
  function stepRebuild(maxCells) {
    const list = rebuild.list; let n = 0;
    while (rebuild.idx < list.length && n < maxCells) {
      const cell = list[rebuild.idx++]; n++;
      const H = CELL / 2;
      for (let q = 0; q < 4; q++) _qd[q] = cellDist(cell.x0 + (q & 1) * H, cell.z0 + (q >> 1) * H, rebuild.px, rebuild.pz, H);
      for (const type in cell.groups) {
        const spec = TYPES[type], recs = MESHES[type]; if (!spec || !recs) continue;
        if (cell.d > spec.maxDist) continue;
        const subs = cell.groups[type];
        for (let si = 0; si < subs.length; si++) {
          const grp = subs[si], d = _qd[grp.q];
          if (d > spec.maxDist) continue;
          let lod = 0;
          if (spec.lodDist.length) { if (d >= spec.lodDist[1]) lod = 2; else if (d >= spec.lodDist[0]) lod = 1; }
          if (lod >= recs.length) lod = recs.length - 1;
          const rec = recs[lod];
          let cnt = lod === 2 ? grp.nFar : grp.n;
          if (rec.cursor + cnt > rec.cap) cnt = rec.cap - rec.cursor;
          if (cnt <= 0) continue;
          rec.mats.set(grp.mats.subarray(0, cnt * 16), rec.cursor * 16);
          rec.inst.set(grp.inst.subarray(0, cnt * 4), rec.cursor * 4);
          rec.cursor += cnt;
        }
      }
    }
    if (rebuild.idx >= list.length) commitRebuild();
  }
  function flagUpdate(attr, start, count) {
    if (attr.addUpdateRange) { attr.addUpdateRange(start, count); }
    attr.needsUpdate = true;
  }
  function commitRebuild() {
    for (const type in MESHES) for (const rec of MESHES[type]) {
      const prev = rec.mesh.count;
      rec.mesh.count = rec.cursor;
      const n = Math.max(prev, rec.cursor);
      if (n > 0) { flagUpdate(rec.mesh.instanceMatrix, 0, rec.cursor * 16 || 16); flagUpdate(rec.attr, 0, rec.cursor * 4 || 4); }
    }
    rebuild.active = false; rebuild.list = null;
  }

  /* ------------------------------------------------------------------------------------------------
   * Ring buffers — grass, flowers, ferns, mushrooms regenerated patch-wise around the player
   * ---------------------------------------------------------------------------------------------- */
  const RINGS = [];
  const _ringWanted = new Set();
  function makeRing(name, geom, mat, radius, patch, perPatch, fill) {
    const maxPatches = Math.ceil(Math.PI * Math.pow(radius / patch + 1.6, 2)) + 4;
    const rec = makeInstanced(geom, mat, maxPatches * perPatch, false, 'veg_' + name);
    rec.mats.fill(0);                                   // zero matrix = invisible slot
    rec.mesh.count = maxPatches * perPatch;
    flagUpdate(rec.mesh.instanceMatrix, 0, rec.mats.length);
    const ring = { name, rec, radius, patch, perPatch, maxPatches, fill, slots: new Map(), free: [], next: 0, queue: [], qi: 0, lastPx: Infinity, lastPz: Infinity, used: 0 };
    RINGS.push(ring); group.add(rec.mesh);
    RING_MESHES[name] = ring;
    return ring;
  }
  function ringReset(ring) {
    ring.slots.clear(); ring.free.length = 0; ring.next = 0; ring.queue = []; ring.qi = 0; ring.lastPx = Infinity; ring.used = 0;
    ring.rec.mats.fill(0); flagUpdate(ring.rec.mesh.instanceMatrix, 0, ring.rec.mats.length);
  }
  function updateRing(ring, px, pz, budgetMs) {
    const P = ring.patch; const t0 = performance.now();
    if (Math.abs(px - ring.lastPx) > P * 0.5 || Math.abs(pz - ring.lastPz) > P * 0.5) {
      ring.lastPx = px; ring.lastPz = pz;
      const n = Math.ceil(ring.radius / P) + 1, pcx = Math.floor(px / P), pcz = Math.floor(pz / P);
      _ringWanted.clear();
      const cand = [];
      for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
        const cx = pcx + i, cz = pcz + j;
        const d = Math.hypot((cx + 0.5) * P - px, (cz + 0.5) * P - pz);
        if (d > ring.radius + P * 0.5) continue;
        const key = cx + ',' + cz; _ringWanted.add(key);
        if (!ring.slots.has(key)) cand.push({ key, cx, cz, d });
      }
      for (const [key, slot] of ring.slots) {
        if (_ringWanted.has(key)) continue;
        const off = slot * ring.perPatch * 16;
        ring.rec.mats.fill(0, off, off + ring.perPatch * 16);
        flagUpdate(ring.rec.mesh.instanceMatrix, off, ring.perPatch * 16);
        ring.slots.delete(key); ring.free.push(slot); ring.used--;
      }
      cand.sort((a, b) => a.d - b.d);
      ring.queue = cand; ring.qi = 0;
    }
    let filled = 0;
    while (ring.qi < ring.queue.length && (filled === 0 || performance.now() - t0 < budgetMs)) {
      const c = ring.queue[ring.qi++];
      if (ring.slots.has(c.key)) continue;
      let slot;
      if (ring.free.length) slot = ring.free.pop();
      else if (ring.next < ring.maxPatches) slot = ring.next++;
      else break;
      ring.slots.set(c.key, slot); ring.used++;
      const base = slot * ring.perPatch;
      const off = base * 16;
      ring.rec.mats.fill(0, off, off + ring.perPatch * 16);
      ring.fill(c.cx * P, c.cz * P, base, ring);
      flagUpdate(ring.rec.mesh.instanceMatrix, off, ring.perPatch * 16);
      flagUpdate(ring.rec.attr, base * 4, ring.perPatch * 4);
      filled++;
    }
    if (ring.qi >= ring.queue.length && ring.queue.length) { ring.queue = []; ring.qi = 0; }
  }
  // write one instance into a ring slot
  function ringWrite(ring, idx, x, y, z, yaw, sx, sy, sz, tr, tg, tb, snow, tiltX, tiltZ) {
    _e.set(tiltX || 0, yaw || 0, tiltZ || 0, 'YXZ'); _q.setFromEuler(_e); _p.set(x, y, z); _s.set(sx, sy, sz);
    _m.compose(_p, _q, _s);
    ring.rec.mats.set(_m.elements, idx * 16);
    const ia = ring.rec.inst; ia[idx * 4] = tr; ia[idx * 4 + 1] = tg; ia[idx * 4 + 2] = tb; ia[idx * 4 + 3] = snow;
  }
  const _gc = [0, 0, 0], _zc = [0, 0, 0];
  const _gc4 = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
  function groundRGB(T, x, z, zone, out) {
    let v = null;
    if (T.groundColor) v = T.groundColor(x, z);
    return toRGB(v, out, (zone && zone.groundColor) != null ? zone.groundColor : 0x5c7d34);
  }
  function grassOK(T, x, z) {
    const gt = T.groundType ? T.groundType(x, z) : (T.height(x, z) > SEA ? 'grass' : 'water');
    if (gt !== 'grass') return false;
    if (T.onRoad && T.onRoad(x, z) > 0.12) return false;
    return true;
  }
  // 0 = nothing grows, 1 = meadow grass, 2 = packed earth (town squares, worn ground): sparse dry tufts only
  function grassKind(T, x, z) {
    const gt = T.groundType ? T.groundType(x, z) : (T.height(x, z) > SEA ? 'grass' : 'water');
    if (gt !== 'grass' && gt !== 'dirt') return 0;
    if (T.onRoad && T.onRoad(x, z) > 0.12) return 0;
    return gt === 'grass' ? 1 : 2;
  }
  const DRY_TUFT = [1.20, 1.02, 0.60];
  function fillGrass(x0, z0, base, ring) {
    const T = G.Terrain; if (!T || !T.height) return;
    const P = ring.patch, zone = zoneAtPos(x0 + P / 2, z0 + P / 2), prof = profileFor(zone);
    const rng = makeRng(cellSeed(x0, z0, 5));
    toRGB(zone.grassColor, _zc, 0x6f9a3a);
    const gt = prof.grassTint || null;
    const hMul = (prof.grassH || 1) * (0.85 + 0.3 * clamp(fbm(x0 * 0.02, z0 * 0.02, 2) * 0.5 + 0.5, 0, 1));
    const n = Math.round(ring.perPatch * clamp(densityMult, 0.15, 1));
    // ground colour sampled at the patch quarter points and bilinearly blended per blade (groundColor is not cheap)
    groundRGB(T, x0 + P * 0.25, z0 + P * 0.25, zone, _gc4[0]); groundRGB(T, x0 + P * 0.75, z0 + P * 0.25, zone, _gc4[1]);
    groundRGB(T, x0 + P * 0.25, z0 + P * 0.75, zone, _gc4[2]); groundRGB(T, x0 + P * 0.75, z0 + P * 0.75, zone, _gc4[3]);
    // patch-level classification: if the 5 probe points are all plain grass, skip the per-blade ground queries
    let allGrass = 0, anyGrass = false;
    for (let i = 0; i < 5; i++) {
      const sx = x0 + P * (i === 4 ? 0.5 : (i & 1 ? 0.8 : 0.2)), sz = z0 + P * (i === 4 ? 0.5 : (i & 2 ? 0.8 : 0.2));
      const kd = grassKind(T, sx, sz);
      if (kd === 1) { allGrass++; anyGrass = true; } else if (kd === 2) anyGrass = true;
    }
    if (!anyGrass) return;
    const perBlade = allGrass < 5;
    for (let k = 0; k < n; k++) {
      const x = x0 + rng() * P, z = z0 + rng() * P;
      let dry = 0;
      if (perBlade) {
        const kd = grassKind(T, x, z);
        if (kd === 0) continue;
        // packed earth keeps a scatter of dry tufts — enough to stop town squares reading as bare canvas
        if (kd === 2) { if (rng() > 0.28) continue; dry = 1; }
      }
      const y = T.height(x, z);
      if (!perBlade && y < SEA + 0.15) continue;
      const u = clamp((x - x0) / P, 0, 1), v = clamp((z - z0) / P, 0, 1);
      for (let c = 0; c < 3; c++) _gc[c] = lerp(lerp(_gc4[0][c], _gc4[1][c], u), lerp(_gc4[2][c], _gc4[3][c], u), v);
      const j = 0.85 + rng() * 0.3;
      // ground colour × zone grass colour (normalised so mid-green ground stays mid-green), biome tint, jitter
      let r, g, b;
      if (dry) {
        // straw growing out of packed earth: keyed off the GROUND colour (never the zone's green) and lifted a
        // little so the tufts read against the dust instead of turning into dark specks
        r = _gc[0] * DRY_TUFT[0] * j; g = _gc[1] * DRY_TUFT[1] * j; b = _gc[2] * DRY_TUFT[2] * j;
      } else {
        r = _gc[0] * _zc[0] * 2.6 * j; g = _gc[1] * _zc[1] * 2.2 * j; b = _gc[2] * _zc[2] * 2.4 * j;
        if (gt) { r *= gt[0]; g *= gt[1]; b *= gt[2]; }
      }
      const s = (0.75 + rng() * 0.55) * (dry ? 0.85 : 1), sy = s * hMul * (0.8 + rng() * 0.45) * (dry ? 0.78 : 1);
      ringWrite(ring, base + k, x, y - 0.03, z, rng() * Math.PI * 2, s, sy, s, clamp(r, 0, 1.6), clamp(g, 0, 1.6), clamp(b, 0, 1.6), 0, (rng() - 0.5) * 0.25, (rng() - 0.5) * 0.25);
    }
  }
  function fillFlowers(x0, z0, base, ring) {
    const T = G.Terrain; if (!T || !T.height) return;
    const P = ring.patch, zone = zoneAtPos(x0 + P / 2, z0 + P / 2), prof = profileFor(zone);
    if (!prof.flower) return;
    const rng = makeRng(cellSeed(x0, z0, 6));
    const clusters = Math.round(prof.flower * 4 * densityMult * rng());
    let k = 0;
    for (let c = 0; c < clusters && k < ring.perPatch; c++) {
      const cx = x0 + rng() * P, cz = z0 + rng() * P; const col = FLOWER_COLS[Math.floor(rng() * FLOWER_COLS.length)];
      const cnt = 4 + Math.floor(rng() * 6);
      for (let i = 0; i < cnt && k < ring.perPatch; i++) {
        const a = rng() * Math.PI * 2, r = rng() * 1.8; const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r;
        if (!grassOK(T, x, z)) continue;
        const s = 0.8 + rng() * 0.6, j = 0.85 + rng() * 0.3;
        ringWrite(ring, base + k++, x, T.height(x, z) - 0.02, z, rng() * Math.PI * 2, s, s * (0.8 + rng() * 0.5), s, col[0] * j, col[1] * j, col[2] * j, 0, (rng() - 0.5) * 0.3, (rng() - 0.5) * 0.3);
      }
    }
  }
  function fillFerns(x0, z0, base, ring) {
    const T = G.Terrain; if (!T || !T.height) return;
    const P = ring.patch, zone = zoneAtPos(x0 + P / 2, z0 + P / 2), prof = profileFor(zone);
    if (!prof.fern) return;
    const rng = makeRng(cellSeed(x0, z0, 7));
    const n = Math.round(prof.fern * ring.perPatch * densityMult * (0.4 + rng() * 0.8));
    let k = 0;
    for (let i = 0; i < n && k < ring.perPatch; i++) {
      const x = x0 + rng() * P, z = z0 + rng() * P;
      const gt = T.groundType ? T.groundType(x, z) : 'grass';
      if ((gt !== 'grass' && gt !== 'dirt') || (T.onRoad && T.onRoad(x, z) > 0.1)) continue;
      if (T.height(x, z) < SEA + 0.2) continue;
      const s = 0.8 + rng() * 0.8, g = 0.8 + rng() * 0.35;
      ringWrite(ring, base + k++, x, T.height(x, z) - 0.02, z, rng() * Math.PI * 2, s, s * (0.85 + rng() * 0.3), s, g * 0.85, g, g * 0.7, 0, 0, 0);
    }
  }
  function fillMushrooms(x0, z0, base, ring) {
    const T = G.Terrain; if (!T || !T.height) return;
    const P = ring.patch, zone = zoneAtPos(x0 + P / 2, z0 + P / 2), prof = profileFor(zone);
    if (!prof.mushroom) return;
    const rng = makeRng(cellSeed(x0, z0, 8));
    const clusters = Math.round(prof.mushroom * 2.2 * densityMult * rng());
    let k = 0;
    for (let c = 0; c < clusters && k < ring.perPatch; c++) {
      const cx = x0 + rng() * P, cz = z0 + rng() * P; const col = prof.paleMushroom ? PALE_MUSHROOM : MUSHROOM_COLS[Math.floor(rng() * MUSHROOM_COLS.length)];
      const cnt = 2 + Math.floor(rng() * 4);
      for (let i = 0; i < cnt && k < ring.perPatch; i++) {
        const x = cx + (rng() - 0.5) * 1.4, z = cz + (rng() - 0.5) * 1.4;
        const gt = T.groundType ? T.groundType(x, z) : 'grass';
        if ((gt !== 'grass' && gt !== 'dirt') || (T.onRoad && T.onRoad(x, z) > 0.1) || T.height(x, z) < SEA + 0.2) continue;
        const s = 0.6 + rng() * 0.9, j = 0.85 + rng() * 0.3;
        ringWrite(ring, base + k++, x, T.height(x, z) - 0.01, z, rng() * Math.PI * 2, s, s * (0.8 + rng() * 0.5), s, col[0] * j, col[1] * j, col[2] * j, 0, (rng() - 0.5) * 0.2, (rng() - 0.5) * 0.2);
      }
    }
  }
  function buildRings() {
    makeRing('grass', DETAIL_GEOMS.grass, MATS.grass, 50, 8, 245, fillGrass);
    makeRing('flower', DETAIL_GEOMS.flower, MATS.detail, 52, 16, 40, fillFlowers);
    makeRing('fern', DETAIL_GEOMS.fern, MATS.fern, 60, 16, 16, fillFerns);
    makeRing('mushroom', DETAIL_GEOMS.mushroom, MATS.detail, 50, 16, 12, fillMushrooms);
  }

  /* ------------------------------------------------------------------------------------------------
   * Public API
   * ---------------------------------------------------------------------------------------------- */
  const WEATHER_WIND = { clear: 0.8, cloudy: 1.15, rain: 1.7, snow: 1.3, storm: 2.8 };
  function build(scene) {
    if (built || !scene) return;
    buildAllGeometry();
    buildMaterials();
    buildMeshes(scene);
    buildRings();
    built = true;
    if (G.state && G.state.weather && WEATHER_WIND[G.state.weather] != null) { wind = windTarget = WEATHER_WIND[G.state.weather]; }
    if (typeof G.on === 'function') G.on('weatherChanged', (kind) => { if (WEATHER_WIND[kind] != null) setWind(WEATHER_WIND[kind]); });
    log('built', Object.keys(MESHES).length, 'types');
  }
  // Feed the leaf-translucency uniforms: sun direction in VIEW space + its colour scaled by how strong it is.
  // Guarded end to end — if there is no Sky or camera yet the term simply stays black.
  const _sunW = new THREE.Vector3();
  function updateSunUniforms() {
    const S = G.Sky;
    const cam = (G.Player && G.Player.camera) || (G.Game && G.Game.camera) || null;
    const col = uniforms.uSunCol.value;
    if (!S || !cam || !S.sun) { col.setRGB(0, 0, 0); return; }
    const dir = S.sunDir || (S.getSunDir ? S.getSunDir(_sunW) : null);
    if (!dir) { col.setRGB(0, 0, 0); return; }
    const up = dir.y;
    if (up <= 0.01) { col.setRGB(0, 0, 0); return; }
    _sunW.set(dir.x, dir.y, dir.z);
    if (cam.matrixWorldInverse) _sunW.transformDirection(cam.matrixWorldInverse);
    uniforms.uSunV.value.copy(_sunW).normalize();
    const k = clamp((S.sun.intensity || 0) / 3, 0, 1.1) * clamp(up * 4, 0, 1);
    col.copy(S.sun.color).multiplyScalar(k);
  }
  function update(playerPos, dt) {
    if (!built || !playerPos) return;
    const px = playerPos.x, pz = playerPos.z;
    if (!(px === px) || !(pz === pz)) return;
    dt = (dt > 0 && dt < 1) ? dt : 1 / 60;
    tAcc += dt;
    wind += (windTarget - wind) * Math.min(1, dt * 1.2);
    uniforms.uWind.value = wind;
    uniforms.uTime.value = ((G.time && typeof G.time.now === 'number') ? G.time.now : tAcc) % WIND_PERIOD;
    updateSunUniforms();

    const pcx = Math.floor(px / CELL), pcz = Math.floor(pz / CELL);
    if (pcx !== lastCellX || pcz !== lastCellZ) {
      lastCellX = pcx; lastCellZ = pcz;
      scheduleCells(px, pz);
      dirty = true; forceRebuild = true; physDirty = true;
    }
    const localMissing = !cells.has(cellKey(pcx, pcz));     // first frame / teleport: spend more time now
    if (genIdx < genQueue.length) generateSome(localMissing ? 24 : 1.0);
    if (physDirty && !localMissing) { updatePhysics(px, pz); physDirty = false; }
    if (rebuild.active) stepRebuild(localMissing ? 1e9 : 160);
    else if (dirty && (forceRebuild || tAcc - lastRebuildTime > 0.35)) { startRebuild(px, pz); stepRebuild(localMissing ? 1e9 : 160); }

    uniforms.uPlayer.value.set(px, playerPos.y || 0, pz);
    for (let i = 0; i < RINGS.length; i++) updateRing(RINGS[i], px, pz, localMissing ? (i === 0 ? 10 : 3) : (i === 0 ? 1.2 : 0.35));
  }
  function setDensity(mult) {
    mult = +mult; if (!(mult === mult)) return;
    mult = clamp(mult, 0.15, 1.5);
    if (Math.abs(mult - densityMult) < 1e-3) return;
    densityMult = mult;
    if (!built) return;
    for (const cell of Array.from(cells.values())) unloadCell(cell);
    for (const type in MESHES) for (const rec of MESHES[type]) { rec.cursor = 0; rec.mesh.count = 0; }
    for (const ring of RINGS) ringReset(ring);
    genQueue = []; genIdx = 0; lastCellX = lastCellZ = null; rebuild.active = false; rebuild.list = null;
    dirty = true; forceRebuild = true;
  }
  function setWind(strength) {
    strength = +strength; if (!(strength === strength)) return;
    windTarget = clamp(strength, 0, 4);
  }
  const _statsByType = {};
  function stats() {
    let instances = 0, tris = 0, drawCalls = 0, trees = 0, cellCount = 0;
    for (const type in MESHES) {
      let n = 0; const lods = [];
      for (const rec of MESHES[type]) { n += rec.mesh.count; lods.push(rec.mesh.count); if (rec.mesh.count > 0) { drawCalls++; tris += rec.mesh.count * rec.tris; } }
      _statsByType[type] = lods.length > 1 ? lods : n; instances += n;
    }
    let grass = 0;
    for (const ring of RINGS) { const n = ring.used * ring.perPatch; _statsByType[ring.name] = n; if (ring.used) { drawCalls++; tris += n * ring.rec.tris; } if (ring.name === 'grass') grass = n; }
    for (const cell of cells.values()) { cellCount++; trees += cell.tx.length; }
    return { cells: cellCount, trees, instances, triangles: tris, drawCalls, grass, colliders: colliderCount, wind, density: densityMult, pending: Math.max(0, genQueue.length - genIdx), rebuilding: rebuild.active,
      genMsAvg: prof.genCount ? Math.round(prof.genMsTotal / prof.genCount * 100) / 100 : 0, genMsMax: Math.round(prof.genMsMax * 100) / 100, byType: _statsByType };
  }
  const _nearBuf = [], _nearPool = [];
  function treesNear(x, z, r) {
    _nearBuf.length = 0;
    if (!(x === x) || !(z === z) || !(r > 0)) return _nearBuf;
    const cx0 = Math.floor((x - r) / CELL), cx1 = Math.floor((x + r) / CELL), cz0 = Math.floor((z - r) / CELL), cz1 = Math.floor((z + r) / CELL);
    let k = 0;
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const cell = cells.get(cellKey(cx, cz)); if (!cell) continue;
      for (let i = 0; i < cell.tx.length; i++) {
        const dx = cell.tx[i] - x, dz = cell.tz[i] - z, rr = r + cell.tr[i];
        if (dx * dx + dz * dz > rr * rr) continue;
        let o = _nearPool[k]; if (!o) o = _nearPool[k] = { x: 0, z: 0, r: 0 };
        o.x = cell.tx[i]; o.z = cell.tz[i]; o.r = cell.tr[i]; _nearBuf.push(o); k++;
      }
    }
    return _nearBuf;
  }

  G.Veg = {
    build, update, setDensity, setWind, stats, treesNear,
    get group() { return group; },
    get wind() { return wind; },
    get density() { return densityMult; },
    CELL, TYPES,
    geometryInfo() { const o = {}; for (const k in GEOMS) o[k] = GEOMS[k].tris; for (const k in DETAIL_GEOMS) o[k] = [triCount(DETAIL_GEOMS[k])]; return o; },
    cellAt(x, z) { return cells.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL))) || null; },
  };
})();
