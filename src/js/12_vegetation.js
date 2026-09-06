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
