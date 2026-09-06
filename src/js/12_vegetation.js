/* ==== 12_vegetation.js — G.Veg: instanced, deterministic, wind-animated vegetation (trees, bushes, rocks,
   grass, flowers, ferns, mushrooms, reeds, stumps, logs). Placement is derived per 64 m cell from G.hash2 and the
   zone at the cell centre; grass/flowers/ferns/mushrooms live in ring buffers around the player. One InstancedMesh
   per (type, LOD); wind sway is injected into the MeshStandardMaterial vertex shader via onBeforeCompile.
   Public API (SPEC §5.3 + extras):
     G.Veg.build(scene)                 create geometry/materials/meshes (call after G.Terrain.build)
     G.Veg.update(playerPos, dt)        stream cells, rebuild instance buffers, refresh rings, animate wind
     G.Veg.setDensity(mult)             quality multiplier (0.25..1.5) — regenerates everything
     G.Veg.setWind(strength)            0 = still, 1 = breeze (default), 3 = storm; eases over ~2 s
     G.Veg.stats()                      { cells, trees, instances, triangles, drawCalls, grass, colliders, byType }
     G.Veg.treesNear(x, z, r)           → [{x,z,r}] tree trunks within r (reused buffer — copy if you keep it)
     G.Veg.group                        THREE.Group holding every vegetation mesh
     G.Veg.wind                         current eased wind strength
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
  const LOD_NEAR = 90;                // < near: full LOD (cast shadows)
  const LOD_MID = 250;                // near..mid: mid LOD; >= mid: far LOD (thinned)
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
      dir.set(b.x - a.x, b.y - a.y, b.z - a.z); if (dir.lengthSq() < 1e-8) dir.set(0, 1, 0); dir.normalize();
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
    const nv = P.length / 3;
    for (let i = 0; i < nv; i++) { P.push(P[i * 3], P[i * 3 + 1], P[i * 3 + 2]); N.push(0, 0, -1); U.push(U[i * 2], U[i * 2 + 1]); }
    for (let s = 0; s < segs; s++) { const a = nv + s * 2; I.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
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
    pineBark: hexRGB(0x4b3626), pineNeedle: hexRGB(0x22482a), pineNeedleTop: hexRGB(0x4f8d3c), pineUnder: hexRGB(0x1a3320),
    birchBark: hexRGB(0xe9e5da), birchMark: hexRGB(0x2f2a26), birchLeaf: hexRGB(0x5f9c34), birchLeafTop: hexRGB(0xbfe063),
    willowBark: hexRGB(0x6a5738), willowLeaf: hexRGB(0x5f8f30), willowLeafTop: hexRGB(0xaac54f),
    deadBark: hexRGB(0x46403a), deadBarkTop: hexRGB(0x736a5f),
    snowBark: hexRGB(0x3b2e25), snowNeedle: hexRGB(0x2a4f36), snowNeedleTop: hexRGB(0x4d7f4d),
    malBark: hexRGB(0x9b9b96), malBarkTop: hexRGB(0xbdbbb1), malLeaf: hexRGB(0xc59a2e), malLeafTop: hexRGB(0xf5d867),
    bush: hexRGB(0x3a7529), bushTop: hexRGB(0x78b23c), shrub: hexRGB(0x6d7b44), shrubTop: hexRGB(0xa2a866),
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
       _blob(1.5, 1, COL.oakLeaf, COL.oakLeafTop, { ox: 0.2, oy: 4.6, oz: 1.6, seed: 24, squash: 0.8 }),
       _blob(1.5, 1, COL.oakLeaf, COL.oakLeafTop, { ox: -0.3, oy: 4.4, oz: -1.7, seed: 25, squash: 0.8 })], H);
    const l1 = tree([trunk(0.48, 0.2, -0.3, 3.7, 5, 2, 0.1, 0, 11, COL.oakBark, COL.oakBarkTop)],
      [_blob(2.7, 1, COL.oakLeaf, COL.oakLeafTop, { oy: 4.8, seed: 21, squash: 0.78, noise: 0.22 }),
       _blob(1.4, 0, COL.oakLeaf, COL.oakLeafTop, { ox: 1.6, oy: 4.0, oz: -0.8, seed: 26, squash: 0.9 })], H);
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
    const l1 = tree([trunk(0.34, 0.08, -0.3, 8.6, 5, 1, 0, 0, 31, bark, bark)],
      [cone(2.1, 5.0, 2.5, 0.1, 6, nd, ndT, null, 0, 32), cone(4.4, 7.2, 1.8, 0.08, 6, nd, ndT, null, 0, 33), cone(6.6, 9.4, 1.1, 0.04, 6, nd, ndT, null, 0, 34)], H, 0.7, 0.4);
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
    const l1 = tree([tr1], [_blob(1.95, 1, COL.birchLeaf, COL.birchLeafTop, { oy: 6.1, seed: 45, squash: 1.2, noise: 0.25 })], H, 1.2);
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
    const l1 = tree([trunk(1.2, 0.5, -0.5, 11.5, 6, 2, 0.02, 0, 73, COL.malBark, COL.malBarkTop)],
      [_blob(5.4, 1, COL.malLeaf, COL.malLeafTop, { oy: 12.8, seed: 81, squash: 0.75, noise: 0.2 }),
       _blob(2.8, 0, COL.malLeaf, COL.malLeafTop, { ox: 3.4, oy: 11.4, oz: 2.0, seed: 82, squash: 0.8 })], H, 0.8, 0.3);
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
    const a = _plane2(1.0, 0.75, 2, COL.white, COL.white, { single: true });
    const b = _plane2(1.0, 0.75, 2, COL.white, COL.white, { single: true }); b.rotateY(Math.PI / 2);
    // blades bend a lot: sway weight ~ t^2 * 1.6 (plus tiny base wobble)
    return finish(mergePlain([a, b]), 0.75, true, 1.6, 0.02);
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
