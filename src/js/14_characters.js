/* ==== 14_characters.js — G.Chars: every procedural character, creature, mount, boat and world-prop mesh
   plus their animation. No model files: everything is built from Three.js primitives (capsules, spheres,
   lathes, extrusions) merged into a handful of smooth-shaded meshes per rig.
   Public API (SPEC §5.5):
     G.Chars.buildHumanoid(spec) → Rig  { group, parts, height, anim, setAnim(name, force), play(dt, ent),
                                          setEquipment(map), setMounted(bool), setProp(kind|null), dispose(), oneShotRemaining }
     G.Chars.buildMonster(typeData) → Rig (same interface; anims idle/walk/run/attack/hit/death; attack_* aliases accepted)
     G.Chars.buildHorse(color) → Rig (idle/walk/gallop; rig.parts.saddle is the rider attach point)
     G.Chars.buildBoat(kind) → { group, seat, mast, oars, animate(t) }
     G.Chars.buildProp(kind) → { group, kind, open(), close(), update(dt), isOpen }
     G.Chars.nameplate(text, color, {sub, subColor}) → THREE.Sprite (pooled; release with G.Chars.releaseNameplate)
     G.Chars.updateNameplate(sprite, camera) — keeps the plate a constant on-screen size
     G.Chars.buildWeapon(shape, color, glow, opts) → THREE.Group (blade along +Y, grip at origin)
     G.Chars.update(dt) — advances shared shader time & animated props (also hooked to G 'update')
     G.Chars.stats() → { rigs, humanoids, monsters, horses, geometries, materials, nameplates }
     G.Chars.material(hex, opts), G.Chars.ANIMS (list), G.Chars.WEAPON_SHAPES (list)
   Private helpers (owned here): _merge (a local geometry merge with vertex-colour support — used instead of
   G.mergeGeometries so painted vertex colours are guaranteed to survive), _paint.
   Assumptions about other modules: G.Items.get(inst) → merged item view with .visual/.armourType/.rarity/.subtype
   (falls back to G.Data.items[inst.tid] or the instance itself); G.Data.races for race height/build.
   ==== */
(function () {
  'use strict';
  const G = window.G;
  const PI = Math.PI, TAU = Math.PI * 2;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const wrapA = (a) => { a = a % TAU; if (a > PI) a -= TAU; else if (a < -PI) a += TAU; return a; };
  const alerp = (a, b, t) => a + wrapA(b - a) * t;
  const ease = (t) => t < 0 ? 0 : t > 1 ? 1 : t * t * (3 - 2 * t);
  const easeOut = (t) => { t = clamp(t, 0, 1); return 1 - (1 - t) * (1 - t); };
  const easeIn = (t) => { t = clamp(t, 0, 1); return t * t; };
  const sin = Math.sin, cos = Math.cos;
  const nowTime = () => (G && G.time && typeof G.time.now === 'number') ? G.time.now : 0;

  // ------------------------------------------------------------------ colour helpers
  const _colTmp = new THREE.Color();
  function hexLerp(a, b, t) {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return ((ar + (br - ar) * t) << 16) | ((ag + (bg - ag) * t) << 8) | (ab + (bb - ab) * t);
  }
  function hexMul(h, m) {
    const r = clamp(Math.round(((h >> 16) & 255) * m), 0, 255), g = clamp(Math.round(((h >> 8) & 255) * m), 0, 255), b = clamp(Math.round((h & 255) * m), 0, 255);
    return (r << 16) | (g << 8) | b;
  }
  function toHex(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const s = v.trim(); if (s[0] === '#') return parseInt(s.slice(1), 16) || 0; if (/^0x/i.test(s)) return parseInt(s, 16) || 0; _colTmp.set(s); return _colTmp.getHex(); }
    return 0x808080;
  }

  // ------------------------------------------------------------------ material cache
  const _mats = new Map();
  let _matCount = 0;
  const _shaderTime = { value: 0 };
  function material(hex, o) {
    hex = toHex(hex == null ? 0x808080 : hex);
    o = o || {};
    const rough = o.rough != null ? o.rough : 0.75, metal = o.metal != null ? o.metal : 0.0;
    const em = o.emissive != null ? toHex(o.emissive) : 0, emi = o.emissiveIntensity != null ? o.emissiveIntensity : (em ? 0.6 : 0);
    const vc = !!o.vertexColors, dbl = !!o.double, tr = o.opacity != null && o.opacity < 1, cape = !!o.cape, flat = !!o.flat;
    const key = hex + '|' + rough + '|' + metal + '|' + em + '|' + emi + '|' + (vc ? 1 : 0) + (dbl ? 1 : 0) + (tr ? o.opacity : 1) + (cape ? 'c' : '') + (flat ? 'f' : '');
    let m = _mats.get(key);
    if (m) return m;
    m = new THREE.MeshStandardMaterial({ color: hex, roughness: rough, metalness: metal, vertexColors: vc, side: dbl ? THREE.DoubleSide : THREE.FrontSide, flatShading: flat });
    if (em) { m.emissive.setHex(em); m.emissiveIntensity = emi; }
    if (tr) { m.transparent = true; m.opacity = o.opacity; m.depthWrite = false; }
    if (cape) {
      m.onBeforeCompile = (sh) => {
        sh.uniforms.uTime = _shaderTime;
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uTime;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n{ float w = clamp(-uv.y + 1.0, 0.0, 1.0); w = w * w; float ph = uTime * 4.0 + uv.x * 5.0 + uv.y * 3.0; transformed.z += (sin(ph) * 0.05 + sin(ph * 1.7 + 1.3) * 0.02) * w; transformed.x += cos(ph * 0.8) * 0.02 * w; }');
      };
      m.customProgramCacheKey = () => 'chars_cape';
    }
    _mats.set(key, m); _matCount++;
    return m;
  }
  const MAT_FACE = () => material(0xffffff, { vertexColors: true, rough: 0.45 });
  const MAT_VC = (rough, metal) => material(0xffffff, { vertexColors: true, rough: rough == null ? 0.7 : rough, metal: metal || 0 });

  // ------------------------------------------------------------------ geometry cache & merge
  const _geos = new Map();
  let _geoCount = 0;
  function cached(key, make) {
    let g = _geos.get(key);
    if (!g) { g = make(); g.userData.key = key; _geos.set(key, g); _geoCount++; }
    return g;
  }
  function _merge(list) {
    const out = new THREE.BufferGeometry();
    let n = 0, hasUv = true, hasCol = false;
    const parts = [];
    for (let i = 0; i < list.length; i++) {
      let g = list[i]; if (!g) continue;
      if (g.index) g = g.toNonIndexed();
      const p = g.getAttribute('position'); if (!p) continue;
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      if (!g.getAttribute('uv')) hasUv = false;
      if (g.getAttribute('color')) hasCol = true;
      parts.push(g); n += p.count;
    }
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = hasUv ? new Float32Array(n * 2) : null, col = hasCol ? new Float32Array(n * 3) : null;
    let o = 0;
    for (const g of parts) {
      const p = g.getAttribute('position'), c = p.count;
      pos.set(p.array.subarray(0, c * 3), o * 3);
      nor.set(g.getAttribute('normal').array.subarray(0, c * 3), o * 3);
      if (uv) uv.set(g.getAttribute('uv').array.subarray(0, c * 2), o * 2);
      if (col) { const ca = g.getAttribute('color'); if (ca) col.set(ca.array.subarray(0, c * 3), o * 3); else col.fill(1, o * 3, (o + c) * 3); }
      o += c;
    }
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (uv) out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (col) out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    out.computeBoundingSphere();
    return out;
  }
  // paint a geometry with a single (sRGB hex) colour → linear vertex colours
  function _paint(g, hex) {
    _colTmp.setHex(toHex(hex));
    const n = g.getAttribute('position').count, a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = _colTmp.r; a[i * 3 + 1] = _colTmp.g; a[i * 3 + 2] = _colTmp.b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  }
  // transform helper: returns g after translate/rotate/scale (applied in order: scale, rotate, translate)
  function T(g, x, y, z, rx, ry, rz, sx, sy, sz) {
    if (sx != null) g.scale(sx, sy == null ? sx : sy, sz == null ? sx : sz);
    if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); if (rz) g.rotateZ(rz);
    if (x || y || z) g.translate(x || 0, y || 0, z || 0);
    return g;
  }
  const sphere = (r, ws, hs, ps, pl, ts, tl) => new THREE.SphereGeometry(r, ws || 14, hs || 10, ps || 0, pl == null ? TAU : pl, ts || 0, tl == null ? PI : tl);
  const capsule = (r, len, cs, rs) => new THREE.CapsuleGeometry(r, len, cs || 4, rs || 12);
  const cyl = (rt, rb, h, rs) => new THREE.CylinderGeometry(rt, rb, h, rs || 12);
  const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
  const cone = (r, h, rs) => new THREE.ConeGeometry(r, h, rs || 10);
  // limb capsule hanging from the joint at the origin, length = joint-to-joint distance
  function limb(r, len, rTop, rBot) {
    if (rTop != null) {
      return new THREE.LatheGeometry([new THREE.Vector2(0.0001, rTop * 0.55), new THREE.Vector2(rTop * 0.75, rTop * 0.45), new THREE.Vector2(rTop, 0), new THREE.Vector2(lerp(rTop, rBot, 0.5), -len * 0.5), new THREE.Vector2(rBot, -len), new THREE.Vector2(rBot * 0.7, -len - rBot * 0.5), new THREE.Vector2(0.0001, -len - rBot * 0.7)], 12);
    }
    const g = capsule(r, len, 4, 12); g.translate(0, -len * 0.5, 0);
    return g;
  }
  // lathe body from profile [[r, y], ...] (bottom to top)
  function lathe(profile, segs) {
    const pts = profile.map(p => new THREE.Vector2(Math.max(p[0], 0.0001), p[1]));
    return new THREE.LatheGeometry(pts, segs || 16);
  }
  function rounded2D(w, h, r) { // THREE.Shape of a rounded rectangle centred at origin
    const s = new THREE.Shape(); const x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r); s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }
  function extrude(shape, depth, bevel) {
    const g = new THREE.ExtrudeGeometry(shape, { depth: depth, bevelEnabled: !!bevel, bevelThickness: bevel || 0, bevelSize: bevel || 0, bevelSegments: 1, curveSegments: 6 });
    g.translate(0, 0, -depth / 2);
    return g;
  }
  function shapeFrom(points) { const s = new THREE.Shape(); s.moveTo(points[0][0], points[0][1]); for (let i = 1; i < points.length; i++) s.lineTo(points[i][0], points[i][1]); s.closePath(); return s; }
  function tube(points, r, segs) {
    const curve = new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(p[0], p[1], p[2])));
    return new THREE.TubeGeometry(curve, segs || 12, r, 8, false);
  }
  function mesh(geo, mat, shadow) { const m = new THREE.Mesh(geo, mat); m.castShadow = !!shadow; m.receiveShadow = false; m.matrixAutoUpdate = true; return m; }
  function grp(x, y, z, parent) { const g = new THREE.Group(); g.position.set(x || 0, y || 0, z || 0); if (parent) parent.add(g); return g; }
  function disposeTree(root) {
    root.traverse(o => { if (o.isSprite && o.material && o.material.map && !o.material.map.userData.shared) { o.material.map.dispose(); o.material.dispose(); } });
    if (root.parent) root.parent.remove(root);
  }

  // ================================================================== HUMANOID DIMENSIONS
  const RACE_DEF = {
    man:         { h: 1.00, head: 1.00, leg: 0.50, w: 1.00, ears: 'round', beard: 0, hair: [0, 1], nose: 1.0 },
    elf:         { h: 1.05, head: 0.95, leg: 0.53, w: 0.92, ears: 'point', beard: 0, hair: [1, 1], nose: 0.9 },
    dwarf:       { h: 0.85, head: 1.12, leg: 0.42, w: 1.36, ears: 'round', beard: 2, hair: [1, 2], nose: 1.3 },
    hobbit:      { h: 0.75, head: 1.15, leg: 0.46, w: 1.02, ears: 'pointsmall', beard: 0, hair: [0, 1], nose: 1.05, feet: 1.55 },
    highelf:     { h: 1.06, head: 0.93, leg: 0.54, w: 0.90, ears: 'point', beard: 0, hair: [1, 1], nose: 0.9 },
    beorning:    { h: 1.15, head: 0.92, leg: 0.49, w: 1.28, ears: 'round', beard: 1, hair: [4, 1], nose: 1.1 },
    stoutaxe:    { h: 0.87, head: 1.12, leg: 0.42, w: 1.42, ears: 'round', beard: 2, hair: [3, 2], nose: 1.3 },
    riverhobbit: { h: 0.76, head: 1.15, leg: 0.46, w: 1.00, ears: 'pointsmall', beard: 0, hair: [0, 2], nose: 1.05, feet: 1.55 },
    dunedain:    { h: 1.04, head: 0.97, leg: 0.52, w: 1.02, ears: 'round', beard: 1, hair: [1, 1], nose: 1.0 },
    rohirrim:    { h: 1.02, head: 1.00, leg: 0.50, w: 1.06, ears: 'round', beard: 1, hair: [1, 1], nose: 1.0 },
    // monster presets (used through buildMonster)
    goblin:      { h: 0.78, head: 1.25, leg: 0.44, w: 0.95, ears: 'pointbig', beard: 0, hair: [5, 5], nose: 1.5, hunch: 0.35, armLen: 1.15 },
    orc:         { h: 1.05, head: 1.05, leg: 0.46, w: 1.35, ears: 'pointbig', beard: 0, hair: [5, 5], nose: 1.2, hunch: 0.25, armLen: 1.1 },
    uruk:        { h: 1.22, head: 0.98, leg: 0.48, w: 1.45, ears: 'pointbig', beard: 0, hair: [5, 5], nose: 1.1, hunch: 0.15, armLen: 1.08 },
    brigand:     { h: 1.00, head: 1.00, leg: 0.50, w: 1.02, ears: 'round', beard: 0, hair: [0, 1], nose: 1.0 },
    sorcerer:    { h: 1.04, head: 0.97, leg: 0.52, w: 0.92, ears: 'round', beard: 1, hair: [5, 1], nose: 1.0 },
    troll:       { h: 2.20, head: 0.80, leg: 0.44, w: 1.55, ears: 'pointsmall', beard: 0, hair: [5, 5], nose: 1.6, hunch: 0.35, armLen: 1.25, belly: 1 },
    giant:       { h: 3.00, head: 0.78, leg: 0.48, w: 1.45, ears: 'round', beard: 1, hair: [4, 4], nose: 1.3, hunch: 0.15, armLen: 1.15 },
    wight:       { h: 1.05, head: 0.95, leg: 0.52, w: 0.80, ears: 'pointsmall', beard: 0, hair: [5, 5], nose: 0.8, hunch: 0.2, armLen: 1.1 },
  };
  const DEFAULT_CLOTHES = {
    man: [0x5f7040, 0x4a3a2a], elf: [0x7f9c96, 0x38495a], dwarf: [0x7a3b2a, 0x3b3b3f], hobbit: [0x6c8e3b, 0x5a4020], highelf: [0xd9d2bb, 0x4a5a72],
    beorning: [0x6a5a48, 0x3a2f24], stoutaxe: [0x7a5a2a, 0x3a3a3a], riverhobbit: [0x4a7d8c, 0x5a4020], dunedain: [0x3f4d3a, 0x2f2a25], rohirrim: [0x8c6a35, 0x4a3a2a],
    goblin: [0x5a4a2a, 0x3a2f1c], orc: [0x3a3634, 0x2a2624], uruk: [0x2a2626, 0x1e1a1a], brigand: [0x5a4632, 0x3a2f24], sorcerer: [0x2c1f3a, 0x1c1426],
    troll: [0x5a5048, 0x4a4038], giant: [0x6a6258, 0x4a4238], wight: [0x3a3c40, 0x2a2c30],
  };
  const BUILD_W = { slim: 0.9, normal: 1.0, stocky: 1.18 };
  function raceData(id) {
    let rd = null;
    try { if (G.Data && G.Data.races) rd = G.Data.races.find(r => r.id === id) || null; } catch (e) { rd = null; }
    return rd;
  }
  function computeDims(spec) {
    const race = spec.race || 'man';
    const R = RACE_DEF[race] || RACE_DEF.man;
    const rd = raceData(race);
    const female = spec.gender === 'female' || spec.gender === 'f';
    const raceH = (rd && rd.height) || R.h;
    const build = spec.build || (rd && rd.build) || 'normal';
    const bw = (BUILD_W[build] || 1) * (spec.buildScale || 1);
    const H = 1.8 * raceH * (spec.height || 1) * (female ? 0.95 : 1) * (spec.sizeMul || 1);
    const s = H / 1.8;
    const w = R.w * bw * (female ? 0.9 : 1);
    const d = {
      race, female, build, H, s, w, R,
      headR: 0.135 * s * R.head * (female ? 0.96 : 1),
      neckLen: 0.05 * s,
      hipY: H * R.leg,
      shoulderHalf: 0.19 * s * w * (female ? 0.92 : 1),
      armR: 0.058 * s * Math.sqrt(w), foreR: 0.05 * s * Math.sqrt(w),
      upperArm: 0.28 * s * (R.armLen || 1), foreArm: 0.25 * s * (R.armLen || 1), handLen: 0.115 * s,
      hipR: 0.15 * s * (female ? 1.1 : 1) * Math.sqrt(w) * (R.belly ? 1.25 : 1),
      legX: 0.09 * s * Math.sqrt(w) * (female ? 1.06 : 1),
      thighR: 0.078 * s * Math.sqrt(w), shinR: 0.058 * s * Math.sqrt(w),
      footLen: 0.25 * s * (R.feet || 1), footW: 0.095 * s * (R.feet || 1), footH: 0.065 * s,
      waistR: 0.13 * s * w * (female ? 0.86 : 1) * (R.belly ? 1.3 : 1), chestR: 0.17 * s * w * (female ? 0.95 : 1),
      hunch: R.hunch || 0, nose: R.nose || 1, ears: R.ears, feetMul: R.feet || 1,
    };
    d.thigh = d.hipY * 0.52; d.shin = d.hipY - d.thigh - d.footH;
    d.shoulderY = H - d.headR * 2.15 - d.neckLen - d.hipY; // relative to hips
    d.torsoLen = d.shoulderY;
    d.key = race + '|' + (female ? 'f' : 'm') + '|' + build + '|' + H.toFixed(2) + '|' + (spec.buildScale || 1);
    return d;
  }

  // ================================================================== HUMANOID PART GEOMETRIES
  function headGeo(d, skin) {
    const key = 'head|' + d.key + '|' + skin;
    return cached(key, () => {
      const r = d.headR, list = [];
      const skull = sphere(r, 18, 14); skull.scale(1, 1.1, 0.98);
      list.push(_paint(skull, skin));
      // jaw / chin
      const jaw = sphere(r * 0.86, 14, 10); jaw.scale(0.95, 0.75, 0.9); jaw.translate(0, -r * 0.42, -r * 0.05);
      list.push(_paint(jaw, skin));
      // nose
      const nose = sphere(r * 0.16 * d.nose, 8, 6); nose.scale(0.85, 1.0, 1.3); nose.translate(0, -r * 0.08, -r * 0.98);
      list.push(_paint(nose, hexMul(skin, 0.95)));
      // ears
      const et = d.ears;
      for (const sd of [-1, 1]) {
        let e;
        if (et === 'round') { e = sphere(r * 0.24, 8, 6); e.scale(0.45, 1, 0.8); e.translate(sd * r * 0.98, -r * 0.02, r * 0.05); }
        else if (et === 'point') { e = cone(r * 0.2, r * 0.75, 6); e.scale(0.6, 1, 1); e.rotateX(-0.35); e.rotateZ(sd * -1.35); e.translate(sd * r * 1.08, r * 0.12, r * 0.12); }
        else if (et === 'pointbig') { e = cone(r * 0.3, r * 1.1, 6); e.scale(0.55, 1, 1); e.rotateX(-0.4); e.rotateZ(sd * -1.45); e.translate(sd * r * 1.2, r * 0.15, r * 0.15); }
        else { e = cone(r * 0.2, r * 0.45, 6); e.scale(0.6, 1, 1); e.rotateX(-0.35); e.rotateZ(sd * -1.3); e.translate(sd * r * 1.0, r * 0.06, r * 0.1); }
        list.push(_paint(e, skin));
      }
      return _merge(list);
    });
  }
  function faceGeo(d, opts) {
    opts = opts || {};
    const eye = opts.eye || 0x3a5a7a, brow = opts.brow || 0x3a2a1a, mouth = opts.mouth || 0x8a4a48, white = opts.white || 0xf4f2ee;
    const key = 'face|' + d.key + '|' + eye + '|' + brow + '|' + mouth + '|' + white + '|' + (opts.tusks ? 't' : '') + (opts.mask ? 'k' + opts.mask : '') + (opts.angry ? 'a' : '') + (opts.eyeScale || 1);
    return cached(key, () => {
      const r = d.headR, list = [];
      const es = (opts.eyeScale || 1) * (d.female ? 1.08 : 1);
      const ey = r * 0.14, ez = -r * 0.86, ex = r * 0.37;
      for (const sd of [-1, 1]) {
        const w = sphere(r * 0.215 * es, 10, 8); w.scale(1, 1.05, 0.6); w.translate(sd * ex, ey, ez);
        list.push(_paint(w, white));
        const p = sphere(r * 0.115 * es, 8, 6); p.scale(1, 1.1, 0.5); p.translate(sd * ex, ey, ez - r * 0.13);
        list.push(_paint(p, eye));
        const pu = sphere(r * 0.055 * es, 6, 4); pu.scale(1, 1, 0.5); pu.translate(sd * ex, ey, ez - r * 0.175);
        list.push(_paint(pu, 0x111111));
        const hi = sphere(r * 0.03 * es, 5, 4); hi.translate(sd * ex - sd * r * 0.045, ey + r * 0.05, ez - r * 0.2);
        list.push(_paint(hi, 0xffffff));
        // brow
        const b = box(r * 0.38, r * 0.085, r * 0.1); b.rotateZ(sd * (opts.angry ? -0.38 : 0.1)); b.rotateY(sd * -0.45); b.translate(sd * ex, ey + r * 0.3 + (opts.angry ? -r * 0.04 : 0), ez - r * 0.02);
        list.push(_paint(b, brow));
        if (opts.tusks) { const t = cone(r * 0.07, r * 0.28, 6); t.translate(sd * r * 0.22, -r * 0.35, -r * 0.92); list.push(_paint(t, 0xe8e0cc)); }
      }
      const m = box(r * 0.36, r * 0.06, r * 0.08); m.translate(0, -r * 0.43, -r * 0.95);
      list.push(_paint(m, mouth));
      if (opts.mask) { const k = sphere(r * 1.03, 14, 10, 0, TAU, PI * 0.5, PI * 0.5); k.scale(1, 0.78, 0.98); k.translate(0, -r * 0.02, 0); list.push(_paint(k, opts.mask)); }
      return _merge(list);
    });
  }
  // hair styles: 0 short crop, 1 long, 2 ponytail, 3 bun/braids, 4 wild, 5 none ; beard: 0 none, 1 short, 2 long
  function hairGeo(d, style, beard, hairHex) {
    const key = 'hair|' + d.key + '|' + style + '|' + beard + '|' + hairHex;
    return cached(key, () => {
      const r = d.headR, list = [];
      const cap = (th, sc, tilt, zoff) => { const c = sphere(r * 1.09, 18, 12, 0, TAU, 0, th); c.scale(sc, 1, sc * 1.02); c.rotateX(tilt || 0); c.translate(0, r * 0.06, zoff || 0); return c; };
      const CT = 0.4, CTH = PI * 0.47;
      if (style === 0) list.push(cap(CTH, 1, CT, r * 0.04));
      else if (style === 1) {
        list.push(cap(PI * 0.5, 1.02, CT, r * 0.04));
        const back = capsule(r * 0.72, r * 0.9, 4, 12); back.scale(1.15, 1, 0.55); back.translate(0, -r * 0.55, r * 0.7); list.push(back);
        for (const sd of [-1, 1]) { const st = capsule(r * 0.22, r * 1.1, 3, 8); st.translate(sd * r * 0.9, -r * 0.5, r * 0.15); list.push(st); }
      } else if (style === 2) {
        list.push(cap(CTH, 1, CT, r * 0.04));
        const tail = capsule(r * 0.2, r * 1.3, 3, 8); tail.rotateX(-0.45); tail.translate(0, -r * 0.55, r * 1.05); list.push(tail);
        const knot = sphere(r * 0.3, 8, 6); knot.translate(0, r * 0.2, r * 0.95); list.push(knot);
      } else if (style === 3) {
        list.push(cap(CTH, 1, CT, r * 0.04));
        const bun = sphere(r * 0.42, 10, 8); bun.translate(0, r * 0.35, r * 0.9); list.push(bun);
        for (const sd of [-1, 1]) { const br = capsule(r * 0.16, r * 1.4, 3, 8); br.rotateX(0.25); br.translate(sd * r * 0.75, -r * 0.7, r * 0.35); list.push(br); }
      } else if (style === 4) {
        list.push(cap(PI * 0.5, 1.1, 0.35, r * 0.06));
        for (const a of [-1.9, -1.0, 0, 1.0, 1.9]) { const lump = sphere(r * 0.4, 8, 6); lump.scale(1, 0.75, 1); lump.translate(sin(a) * r * 0.85, r * 0.42 + 0.12 * r * cos(a * 2), cos(a) * r * 0.85 + r * 0.08); list.push(lump); }
        const mane = capsule(r * 0.6, r * 0.8, 3, 10); mane.scale(1.15, 1, 0.5); mane.translate(0, -r * 0.4, r * 0.8); list.push(mane);
      }
      if (beard === 1) { const b = sphere(r * 0.88, 14, 10, 0, TAU, PI * 0.5, PI * 0.45); b.scale(1.02, 0.9, 1.0); b.translate(0, -r * 0.3, -r * 0.08); list.push(b); }
      else if (beard === 2) {
        const b = sphere(r * 0.9, 14, 10, 0, TAU, PI * 0.5, PI * 0.5); b.scale(1.02, 0.85, 1.0); b.translate(0, -r * 0.3, -r * 0.1); list.push(b);
        const long = capsule(r * 0.5, r * 1.5, 4, 10); long.scale(1.2, 1, 0.6); long.translate(0, -r * 1.55, -r * 0.55); list.push(long);
        const braid = capsule(r * 0.18, r * 0.6, 3, 8); braid.translate(0, -r * 2.55, -r * 0.6); list.push(braid);
        for (const sd of [-1, 1]) { const st = capsule(r * 0.28, r * 0.5, 3, 8); st.translate(sd * r * 0.9, -r * 0.55, -r * 0.2); list.push(st); }
      }
      if (!list.length) { const e = new THREE.BufferGeometry(); e.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3)); return e; }
      const g = _merge(list.map(x => _paint(x, hairHex)));
      return g;
    });
  }
  // torso: waist at y=0 (hips origin) up to shoulders. variant: cloth|leather|plate|robe|fur|bare
  function torsoGeo(d, variant, col, col2, skin) {
    const key = 'torso|' + d.key + '|' + variant + '|' + col + '|' + col2 + '|' + skin;
    return cached(key, () => {
      const L = d.torsoLen, wR = d.waistR, cR = d.chestR, list = [];
      const female = d.female;
      const prof = [[wR * 0.92, -0.02], [wR, L * 0.08], [wR * 0.97, L * 0.25], [lerp(wR, cR, 0.7), L * 0.5], [cR, L * 0.7], [cR * 1.03, L * 0.86], [cR * 1.0, L * 0.96], [cR * 0.72, L * 1.03], [0.0001, L * 1.05]];
      if (d.hunch) { prof[6][0] *= 1.05; }
      const body = lathe(prof, 18); body.scale(1, 1, female ? 0.76 : 0.8);
      list.push(_paint(body, col));
      if (female) { const b = sphere(cR * 0.8, 12, 9); b.scale(1.3, 0.55, 0.62); b.translate(0, L * 0.7, -cR * 0.42); list.push(_paint(b, col)); }
      // neck (skin)
      const neck = cyl(d.headR * 0.42, d.headR * 0.5, d.neckLen + d.headR * 0.6, 10); neck.translate(0, L + d.neckLen * 0.5 + d.headR * 0.1, 0);
      list.push(_paint(neck, skin));
      // belt
      if (variant !== 'bare') { const belt = cyl(wR * 1.04, wR * 1.06, L * 0.1, 18); belt.scale(1, 1, female ? 0.8 : 0.84); belt.translate(0, L * 0.05, 0); list.push(_paint(belt, col2)); const buckle = box(wR * 0.3, L * 0.09, wR * 0.12); buckle.translate(0, L * 0.05, -wR * 0.8); list.push(_paint(buckle, 0xc9a24a)); }
      if (variant === 'leather' || variant === 'fur') { // shoulder strap across the chest
        const strap = box(cR * 0.22, L * 0.95, cR * 0.1); strap.rotateZ(0.55); strap.translate(-cR * 0.0, L * 0.55, -cR * 0.72); list.push(_paint(strap, col2));
        if (variant === 'fur') { const ruff = cyl(cR * 1.2, cR * 1.05, L * 0.22, 14); ruff.scale(1, 1, 0.8); ruff.translate(0, L * 0.93, 0); list.push(_paint(ruff, col2)); }
      }
      if (variant === 'plate') { // breastplate + collar
        const bp = sphere(cR * 1.0, 16, 12, 0, TAU, PI * 0.15, PI * 0.5); bp.scale(1.02, L * 0.62 / cR, 0.86); bp.translate(0, L * 0.4, -cR * 0.06); list.push(_paint(bp, col));
        const collar = cyl(cR * 0.62, cR * 0.7, L * 0.12, 12); collar.scale(1, 1, 0.8); collar.translate(0, L * 1.02, 0); list.push(_paint(collar, col2));
        const ridge = box(cR * 0.12, L * 0.55, cR * 0.15); ridge.translate(0, L * 0.55, -cR * 0.82); list.push(_paint(ridge, col2));
      }
      if (variant === 'robe') { const trim = cyl(cR * 0.5, cR * 0.9, L * 0.9, 12, 1, true); trim.scale(1, 1, 0.75); trim.translate(0, L * 0.5, -cR * 0.05); list.push(_paint(trim, col2)); }
      return _merge(list);
    });
  }
  // hips/pelvis at y=0 downwards; variant: trousers|robe|tassets|kilt|ragged
  function hipsGeo(d, variant, col, col2) {
    const key = 'hips|' + d.key + '|' + variant + '|' + col + '|' + col2;
    return cached(key, () => {
      const hR = d.hipR, s = d.s, list = [];
      const pelvis = lathe([[hR * 0.55, -s * 0.2], [hR * 0.95, -s * 0.12], [hR, -s * 0.02], [hR * 0.96, s * 0.03], [0.0001, s * 0.04]], 16); pelvis.scale(1, 1, 0.78);
      list.push(_paint(pelvis, col));
      if (variant === 'robe' || variant === 'ragged') {
        const len = d.hipY * (variant === 'robe' ? 0.95 : 0.75);
        const skirt = cyl(hR * 1.02, hR * 1.55, len, 16, 1, true); skirt.scale(1, 1, 0.82); skirt.translate(0, -len * 0.5 + s * 0.02, 0);
        if (variant === 'ragged') { const p = skirt.getAttribute('position'); for (let i = 0; i < p.count; i++) { if (p.getY(i) < -len * 0.4) { const a = Math.atan2(p.getZ(i), p.getX(i)); p.setY(i, p.getY(i) + Math.abs(sin(a * 5.3)) * len * 0.28); } } skirt.computeVertexNormals(); }
        list.push(_paint(skirt, col));
        if (variant === 'robe') { const hem = cyl(hR * 1.52, hR * 1.58, len * 0.08, 16, 1, true); hem.scale(1, 1, 0.82); hem.translate(0, -len + s * 0.05, 0); list.push(_paint(hem, col2)); }
      } else if (variant === 'tassets') {
        for (const sd of [-1, 1]) { const t = box(hR * 0.7, d.hipY * 0.32, hR * 0.5); t.rotateZ(sd * -0.12); t.translate(sd * hR * 0.75, -s * 0.24, 0); list.push(_paint(t, col2)); }
        const front = box(hR * 0.5, d.hipY * 0.3, hR * 0.15); front.translate(0, -s * 0.24, -hR * 0.68); list.push(_paint(front, col));
      } else if (variant === 'kilt') {
        const len = d.hipY * 0.5; const k = cyl(hR * 1.02, hR * 1.3, len, 14, 1, true); k.scale(1, 1, 0.82); k.translate(0, -len * 0.5 + s * 0.02, 0); list.push(_paint(k, col));
      }
      return _merge(list);
    });
  }
  function upperArmGeo(d, col, skin, sleeve) { // sleeve: 'full'|'short'|'none'|'plate'
    return cached('uarm|' + d.key + '|' + col + '|' + skin + '|' + sleeve, () => {
      const list = [];
      const base = limb(d.armR, d.upperArm, d.armR * 1.15, d.armR * 0.85);
      list.push(_paint(base, sleeve === 'none' ? skin : col));
      if (sleeve === 'short') { const cuff = cyl(d.armR * 1.2, d.armR * 1.15, d.upperArm * 0.5, 10); cuff.translate(0, -d.upperArm * 0.22, 0); list.push(_paint(cuff, col)); }
      if (sleeve === 'plate') { const v = cyl(d.armR * 1.25, d.armR * 1.05, d.upperArm * 0.55, 10); v.translate(0, -d.upperArm * 0.62, 0); list.push(_paint(v, col)); }
      return _merge(list);
    });
  }
  function forearmGeo(d, col, skin, sleeve) {
    return cached('farm|' + d.key + '|' + col + '|' + skin + '|' + sleeve, () => {
      const list = [];
      const base = limb(d.foreR, d.foreArm, d.foreR * 1.1, d.foreR * 0.8);
      list.push(_paint(base, sleeve === 'none' || sleeve === 'short' ? skin : col));
      if (sleeve === 'plate' || sleeve === 'bracer') { const b = cyl(d.foreR * 1.15, d.foreR * 1.05, d.foreArm * 0.55, 10); b.translate(0, -d.foreArm * 0.62, 0); list.push(_paint(b, col)); }
      return _merge(list);
    });
  }
  // hand: origin at wrist, fingers pointing -Y; palm faces +X for the left hand? we mirror in placement
  function handGeo(d, col, kind, side) { // kind: bare|glove|gauntlet
    return cached('hand|' + d.key + '|' + col + '|' + kind + '|' + side, () => {
      const L = d.handLen * (kind === 'gauntlet' ? 1.35 : kind === 'glove' ? 1.1 : 1), r = d.foreR * (kind === 'gauntlet' ? 1.4 : kind === 'glove' ? 1.2 : 1.1), list = [];
      const palm = sphere(r, 10, 8); palm.scale(0.85, L / r * 0.62, 0.6); palm.translate(0, -L * 0.5, 0); list.push(_paint(palm, col));
      const th = capsule(r * 0.32, L * 0.35, 3, 6); th.rotateZ(side * 0.7); th.translate(side * r * 0.55, -L * 0.3, -r * 0.2); list.push(_paint(th, col));
      if (kind === 'gauntlet') { const cuff = cyl(r * 1.05, r * 0.95, L * 0.45, 10); cuff.translate(0, L * 0.1, 0); list.push(_paint(cuff, col)); for (let i = 0; i < 3; i++) { const k = sphere(r * 0.25, 6, 5); k.translate(-r * 0.3 + i * r * 0.3, -L * 0.62, -r * 0.35); list.push(_paint(k, hexMul(col, 0.8))); } }
      if (kind === 'glove') { const cuff = cyl(r * 1.02, r * 0.95, L * 0.3, 10); cuff.translate(0, L * 0.05, 0); list.push(_paint(cuff, hexMul(col, 0.85))); }
      return _merge(list);
    });
  }
  function thighGeo(d, col) { return cached('thigh|' + d.key + '|' + col, () => _paint(limb(d.thighR, d.thigh, d.thighR * 1.12, d.thighR * 0.78), col)); }
  function shinGeo(d, col, boot, bootCol) {
    return cached('shin|' + d.key + '|' + col + '|' + boot + '|' + bootCol, () => {
      const list = [_paint(limb(d.shinR, d.shin, d.shinR * 1.05, d.shinR * 0.72), col)];
      if (boot === 'tall') { const b = cyl(d.shinR * 1.05, d.shinR * 1.0, d.shin * 0.6, 10); b.translate(0, -d.shin * 0.7, 0); list.push(_paint(b, bootCol)); }
      else if (boot === 'plate') { const b = cyl(d.shinR * 1.12, d.shinR * 1.0, d.shin * 0.75, 10); b.translate(0, -d.shin * 0.6, 0); list.push(_paint(b, bootCol)); }
      return _merge(list);
    });
  }
  // foot: origin at ankle; toes toward -Z
  function footGeo(d, col, kind) { // bare|boot|plate
    return cached('foot|' + d.key + '|' + col + '|' + kind, () => {
      const L = d.footLen, W = d.footW, Hh = d.footH, list = [];
      if (kind === 'bare') {
        const f = sphere(W * 0.55, 10, 8); f.scale(1, Hh / (W * 0.55) * 0.9, L / (W * 0.55) * 0.55); f.translate(0, -Hh * 0.45, -L * 0.28); list.push(_paint(f, col));
        const heel = sphere(W * 0.42, 8, 6); heel.scale(1, 0.85, 1); heel.translate(0, -Hh * 0.35, L * 0.1); list.push(_paint(heel, col));
        for (let i = 0; i < 3; i++) { const t = sphere(W * (0.2 - i * 0.03), 6, 5); t.translate((i - 1) * W * 0.3, -Hh * 0.55, -L * 0.6 - (i === 1 ? W * 0.05 : 0)); list.push(_paint(t, col)); }
      } else {
        const f = capsule(W * 0.5, L * 0.55, 3, 10); f.rotateX(PI / 2); f.scale(1, Hh / (W * 0.5) * 1.05, 1); f.translate(0, -Hh * 0.45, -L * 0.28); list.push(_paint(f, col));
        const ankle = cyl(W * 0.56, W * 0.6, Hh * 1.4, 10); ankle.translate(0, 0, W * 0.05); list.push(_paint(ankle, col));
        if (kind === 'plate') { const cap = box(W * 1.05, Hh * 0.5, L * 0.35); cap.translate(0, -Hh * 0.1, -L * 0.5); list.push(_paint(cap, hexMul(col, 1.1))); }
      }
      return _merge(list);
    });
  }
  function pauldronGeo(d, type, col, col2) { // pair, positioned at shoulder joints (torso-local)
    return cached('pauld|' + d.key + '|' + type + '|' + col + '|' + col2, () => {
      const list = [], r = d.armR;
      for (const sd of [-1, 1]) {
        const x = sd * d.shoulderHalf, y = d.torsoLen * 0.95;
        if (type === 'light') { const p = sphere(r * 1.55, 12, 8, 0, TAU, 0, PI * 0.5); p.scale(1, 0.7, 1); p.translate(x, y + r * 0.2, 0); list.push(_paint(p, col)); }
        else if (type === 'medium') { const p = sphere(r * 1.75, 12, 8, 0, TAU, 0, PI * 0.55); p.scale(1, 0.85, 1); p.translate(x, y + r * 0.25, 0); list.push(_paint(p, col)); const st = cyl(r * 1.8, r * 1.8, r * 0.3, 12); st.translate(x, y - r * 0.4, 0); list.push(_paint(st, col2)); }
        else { const p = sphere(r * 2.15, 14, 10, 0, TAU, 0, PI * 0.58); p.scale(1, 0.9, 1); p.translate(x + sd * r * 0.2, y + r * 0.35, 0); list.push(_paint(p, col)); const rim = cyl(r * 2.2, r * 2.3, r * 0.35, 14); rim.translate(x + sd * r * 0.2, y - r * 0.55, 0); list.push(_paint(rim, col2)); const spike = cone(r * 0.35, r * 1.2, 6); spike.rotateZ(sd * -0.5); spike.translate(x + sd * r * 1.2, y + r * 1.4, 0); list.push(_paint(spike, col2)); }
      }
      return _merge(list);
    });
  }
  // helmet types: cap (light), hood (light), lcap (medium leather cap), helm (heavy full), crown, bandana, hornhelm
  function helmetGeo(d, type, col, col2) {
    return cached('helm|' + d.key + '|' + type + '|' + col + '|' + col2, () => {
      const r = d.headR, list = [];
      if (type === 'cap') { const c = sphere(r * 1.12, 16, 10, 0, TAU, 0, PI * 0.5); c.scale(1, 0.85, 1); c.translate(0, r * 0.12, 0); list.push(_paint(c, col)); const brim = cyl(r * 1.25, r * 1.25, r * 0.08, 16); brim.translate(0, r * 0.12, 0); list.push(_paint(brim, col2)); }
      else if (type === 'hood') { const h = sphere(r * 1.2, 16, 12, 0, TAU, 0, PI * 0.62); h.scale(1, 1.05, 1.08); h.translate(0, r * 0.12, r * 0.08); list.push(_paint(h, col)); const dr = cyl(r * 1.12, r * 1.45, r * 1.2, 14, 1, true); dr.translate(0, -r * 0.7, r * 0.15); list.push(_paint(dr, col)); const pk = cone(r * 0.35, r * 0.7, 8); pk.rotateX(0.7); pk.translate(0, r * 1.05, r * 0.55); list.push(_paint(pk, col)); }
      else if (type === 'lcap') { const c = sphere(r * 1.12, 16, 10, 0, TAU, 0, PI * 0.55); c.translate(0, r * 0.1, 0); list.push(_paint(c, col)); const band = cyl(r * 1.15, r * 1.15, r * 0.2, 16); band.translate(0, -r * 0.05, 0); list.push(_paint(band, col2)); for (const sd of [-1, 1]) { const f = box(r * 0.3, r * 0.6, r * 0.5); f.translate(sd * r * 1.05, -r * 0.35, r * 0.1); list.push(_paint(f, col)); } }
      else if (type === 'helm' || type === 'hornhelm') {
        const c = sphere(r * 1.14, 16, 12, 0, TAU, 0, PI * 0.6); c.scale(1, 1.02, 1.02); c.translate(0, r * 0.08, 0); list.push(_paint(c, col));
        const band = cyl(r * 1.17, r * 1.17, r * 0.22, 16); band.translate(0, -r * 0.02, 0); list.push(_paint(band, col2));
        const nose = box(r * 0.16, r * 0.75, r * 0.12); nose.translate(0, -r * 0.3, -r * 1.05); list.push(_paint(nose, col2));
        for (const sd of [-1, 1]) { const ch = box(r * 0.22, r * 0.75, r * 0.9); ch.translate(sd * r * 1.05, -r * 0.42, r * 0.05); list.push(_paint(ch, col)); }
        if (type === 'hornhelm') { for (const sd of [-1, 1]) { const h = cone(r * 0.18, r * 0.9, 8); h.rotateZ(sd * -1.0); h.translate(sd * r * 1.35, r * 0.6, 0); list.push(_paint(h, 0xe8dcc0)); } }
        else { const crest = box(r * 0.12, r * 0.35, r * 1.4); crest.translate(0, r * 1.15, 0); list.push(_paint(crest, col2)); }
      } else if (type === 'crown') { const c = cyl(r * 1.05, r * 1.0, r * 0.35, 12, 1, true); c.translate(0, r * 0.75, 0); list.push(_paint(c, col2)); for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; const p = cone(r * 0.12, r * 0.35, 4); p.translate(sin(a) * r * 1.02, r * 1.05, cos(a) * r * 1.02); list.push(_paint(p, col2)); } }
      else if (type === 'bandana') { const b = sphere(r * 1.1, 16, 10, 0, TAU, 0, PI * 0.45); b.translate(0, r * 0.12, 0); list.push(_paint(b, col)); const kn = capsule(r * 0.12, r * 0.5, 3, 6); kn.rotateX(0.6); kn.translate(0, -r * 0.1, r * 1.05); list.push(_paint(kn, col)); }
      else if (type === 'circlet') { const c = new THREE.TorusGeometry(r * 1.05, r * 0.05, 6, 20); c.rotateX(PI / 2); c.translate(0, r * 0.4, 0); list.push(_paint(c, col2)); const gem = sphere(r * 0.12, 6, 5); gem.translate(0, r * 0.4, -r * 1.05); list.push(_paint(gem, col)); }
      return _merge(list);
    });
  }
  function capeGeo(d, col, col2, len) {
    return cached('cape|' + d.key + '|' + col + '|' + col2 + '|' + len.toFixed(2), () => {
      const w = d.shoulderHalf * 2.2;
      const g = new THREE.PlaneGeometry(w, len, 6, 10);
      const p = g.getAttribute('position');
      for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); const t = (y + len / 2) / len; // 1 at top
        p.setX(i, x * lerp(1.25, 0.85, t)); p.setZ(i, (1 - t) * (1 - t) * len * 0.15 + (1 - Math.abs(x / (w / 2))) * 0.02 * (1 - t)); }
      g.translate(0, -len / 2, 0); g.computeVertexNormals();
      const c = _paint(g, col);
      const ca = c.getAttribute('color'); _colTmp.setHex(toHex(col2));
      for (let i = 0; i < p.count; i++) { if (p.getY(i) > -len * 0.12) { ca.setXYZ(i, _colTmp.r, _colTmp.g, _colTmp.b); } }
      return c;
    });
  }

  // ================================================================== WEAPONS
  const STEEL = 0xb9bec8, DSTEEL = 0x6c717c, WOOD = 0x6b4a2a, DWOOD = 0x3d2a17, LEATHER = 0x3a2a1c, GOLD = 0xc9a24a, BRONZE = 0x9a7440;
  const WEAPON_SHAPES = ['sword', 'axe', 'mace', 'dagger', 'spear', 'bow', 'crossbow', 'staff', 'shield', 'runestone', 'gauntlets', 'halberd', 'javelin', 'lute', 'club', 'rod', 'greatsword', 'hammer'];
  function bladeShape(w, L, tipAt) { return shapeFrom([[-w / 2, 0], [w / 2, 0], [w / 2, L * (tipAt || 0.8)], [0, L], [-w / 2, L * (tipAt || 0.8)]]); }
  function weaponGeo(shape, color, opts) {
    opts = opts || {};
    const race = opts.race || 'man';
    const key = 'weapon|' + shape + '|' + color + '|' + race + '|' + (opts.variant || 0);
    return cached(key, () => {
      const list = [];
      const bladeCol = (color && color !== STEEL) ? hexLerp(STEEL, color, 0.55) : STEEL;
      const accent = color || GOLD;
      const P = (g, c) => list.push(_paint(g, c));
      switch (shape) {
        case 'dagger': case 'sword': case 'greatsword': {
          const L = shape === 'dagger' ? 0.32 : shape === 'greatsword' ? 1.15 : 0.82, w = shape === 'dagger' ? 0.035 : shape === 'greatsword' ? 0.075 : 0.055;
          const b = extrude(bladeShape(w, L, 0.82), 0.008, 0.004); b.translate(0, 0.06, 0); P(b, bladeCol);
          const fuller = box(w * 0.2, L * 0.7, 0.012); fuller.translate(0, 0.06 + L * 0.4, 0); P(fuller, hexMul(bladeCol, 0.8));
          const guard = box(shape === 'dagger' ? 0.09 : 0.16, 0.022, 0.03); guard.translate(0, 0.05, 0); P(guard, accent);
          const grip = cyl(0.014, 0.017, shape === 'greatsword' ? 0.26 : 0.14, 8); grip.translate(0, shape === 'greatsword' ? -0.1 : -0.04, 0); P(grip, LEATHER);
          const pom = sphere(0.024, 8, 6); pom.translate(0, shape === 'greatsword' ? -0.24 : -0.12, 0); P(pom, accent);
          break;
        }
        case 'axe': {
          const haft = cyl(0.014, 0.018, 0.8, 8); haft.translate(0, 0.25, 0); P(haft, WOOD);
          const head = extrude(shapeFrom([[0, 0.02], [0.04, 0.1], [0.14, 0.14], [0.19, 0.02], [0.19, -0.16], [0.14, -0.26], [0.04, -0.2], [0, -0.1]]), 0.02, 0.005); head.translate(0.0, 0.55, 0); P(head, bladeCol);
          const back = box(0.06, 0.08, 0.035); back.translate(-0.03, 0.5, 0); P(back, DSTEEL);
          const wrap = cyl(0.02, 0.02, 0.12, 8); wrap.translate(0, 0.5, 0); P(wrap, LEATHER);
          const cap = cyl(0.02, 0.016, 0.03, 8); cap.translate(0, -0.15, 0); P(cap, DSTEEL);
          break;
        }
        case 'mace': case 'hammer': {
          const haft = cyl(0.014, 0.018, 0.7, 8); haft.translate(0, 0.2, 0); P(haft, DWOOD);
          if (shape === 'hammer') { const h = box(0.16, 0.12, 0.2); h.translate(0, 0.52, 0); P(h, bladeCol); const sp = cone(0.03, 0.08, 6); sp.rotateZ(-PI / 2); sp.translate(0.12, 0.52, 0); P(sp, DSTEEL); }
          else { const core = sphere(0.055, 10, 8); core.translate(0, 0.52, 0); P(core, bladeCol); for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; const f = box(0.02, 0.13, 0.06); f.rotateY(a); f.translate(sin(a) * 0.06, 0.52, cos(a) * 0.06); P(f, DSTEEL); } const tip = cone(0.02, 0.05, 6); tip.translate(0, 0.6, 0); P(tip, DSTEEL); }
          const grip = cyl(0.018, 0.018, 0.16, 8); grip.translate(0, -0.03, 0); P(grip, LEATHER);
          break;
        }
        case 'spear': case 'javelin': case 'halberd': {
          const L = shape === 'javelin' ? 1.3 : 1.85; const haft = cyl(0.012, 0.016, L, 8); haft.translate(0, L * 0.5 - 0.45, 0); P(haft, WOOD);
          if (shape === 'halberd') { const b = extrude(bladeShape(0.06, 0.34, 0.75), 0.008, 0.003); b.translate(0, L - 0.45, 0); P(b, bladeCol); const ax = extrude(shapeFrom([[0, 0.1], [0.14, 0.14], [0.17, 0], [0.14, -0.14], [0, -0.1]]), 0.012, 0.004); ax.translate(0.0, L - 0.62, 0); P(ax, bladeCol); const hook = extrude(shapeFrom([[0, 0.05], [-0.09, 0.02], [-0.11, -0.05], [0, -0.05]]), 0.012, 0.003); hook.translate(0, L - 0.6, 0); P(hook, DSTEEL); }
          else { const b = extrude(bladeShape(shape === 'javelin' ? 0.035 : 0.05, shape === 'javelin' ? 0.16 : 0.28, 0.5), 0.008, 0.003); b.translate(0, L - 0.45, 0); P(b, bladeCol); }
          const wrap = cyl(0.018, 0.018, 0.18, 8); wrap.translate(0, 0, 0); P(wrap, LEATHER);
          const butt = cyl(0.018, 0.012, 0.05, 8); butt.translate(0, -0.45, 0); P(butt, DSTEEL);
          break;
        }
        case 'club': {
          const c = lathe([[0.03, -0.25], [0.035, 0], [0.06, 0.35], [0.11, 0.6], [0.12, 0.7], [0.09, 0.78], [0.0001, 0.8]], 10); P(c, hexLerp(DWOOD, color || DWOOD, 0.3));
          for (let i = 0; i < 5; i++) { const a = i / 5 * TAU; const k = sphere(0.03, 6, 5); k.translate(sin(a) * 0.1, 0.55 + (i % 2) * 0.1, cos(a) * 0.1); P(k, 0x8a7a68); }
          break;
        }
        case 'bow': {
          const pts = []; for (let i = 0; i <= 12; i++) { const t = i / 12 - 0.5; pts.push([0, t * 1.3, -0.24 * (1 - (t * 2) * (t * 2)) - 0.02]); }
          const limbG = tube(pts, 0.014, 16); P(limbG, hexLerp(WOOD, color || WOOD, 0.3));
          const grip = cyl(0.02, 0.02, 0.14, 8); grip.translate(0, 0, -0.26); P(grip, LEATHER);
          const str = cyl(0.004, 0.004, 1.28, 4); str.translate(0, 0, 0.0); P(str, 0xe8e2d0);
          for (const sd of [-1, 1]) { const tip = cone(0.02, 0.05, 6); tip.rotateX(sd > 0 ? 0 : PI); tip.translate(0, sd * 0.66, -0.02); P(tip, DSTEEL); }
          break;
        }
        case 'crossbow': {
          const stock = box(0.05, 0.6, 0.06); stock.translate(0, 0.15, 0.0); P(stock, DWOOD);
          const pts = []; for (let i = 0; i <= 10; i++) { const t = i / 10 - 0.5; pts.push([t * 0.7, 0.36, 0.12 * (1 - (t * 2) * (t * 2)) - 0.02]); }
          P(tube(pts, 0.012, 12), DSTEEL);
          const str = cyl(0.004, 0.004, 0.7, 4); str.rotateZ(PI / 2); str.translate(0, 0.36, 0.09); P(str, 0xe8e2d0);
          const trig = box(0.02, 0.06, 0.02); trig.translate(0, -0.05, 0.05); P(trig, DSTEEL);
          const bolt = cyl(0.006, 0.006, 0.45, 4); bolt.translate(0, 0.2, -0.045); P(bolt, 0xd8cfb8);
          break;
        }
        case 'staff': {
          const st = cyl(0.016, 0.024, 1.75, 8); st.translate(0, 0.5, 0); P(st, hexLerp(WOOD, color || WOOD, 0.35));
          const ring = new THREE.TorusGeometry(0.05, 0.012, 6, 12); ring.translate(0, 1.32, 0); P(ring, accent);
          for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; const cg = cyl(0.008, 0.008, 0.2, 5); cg.rotateX(0.35); cg.rotateY(a); cg.translate(sin(a) * 0.05, 1.42, cos(a) * 0.05); P(cg, accent); }
          const wrap = cyl(0.026, 0.026, 0.25, 8); wrap.translate(0, 0.02, 0); P(wrap, LEATHER);
          break;
        }
        case 'shield': {
          const kite = race === 'elf' || race === 'highelf' || race === 'dunedain' || race === 'man' || race === 'rohirrim';
          const small = race === 'hobbit' || race === 'riverhobbit';
          if (kite && !small) {
            const sh = extrude(shapeFrom([[-0.22, 0.22], [0, 0.3], [0.22, 0.22], [0.2, -0.05], [0, -0.42], [-0.2, -0.05]]), 0.025, 0.01); P(sh, color || 0x3a5f8a);
            const rim = extrude(shapeFrom([[-0.24, 0.24], [0, 0.32], [0.24, 0.24], [0.22, -0.05], [0, -0.45], [-0.22, -0.05]]), 0.012, 0.004); rim.translate(0, 0, 0.012); P(rim, DSTEEL);
            const emblem = cyl(0.07, 0.07, 0.02, 12); emblem.rotateX(PI / 2); emblem.translate(0, 0.02, -0.02); P(emblem, accent === color ? GOLD : accent);
          } else {
            const r = small ? 0.22 : 0.3; const sh = cyl(r, r * 0.92, 0.03, 20); sh.rotateX(PI / 2); P(sh, color || 0x6b4a2a);
            const rim = new THREE.TorusGeometry(r, 0.018, 6, 20); P(rim, DSTEEL);
            const boss = sphere(r * 0.3, 10, 8); boss.scale(1, 1, 0.6); boss.translate(0, 0, -0.02); P(boss, DSTEEL);
            for (let i = 0; i < 4; i++) { const a = i / 4 * TAU; const riv = sphere(0.015, 5, 4); riv.translate(sin(a) * r * 0.65, cos(a) * r * 0.65, -0.02); P(riv, GOLD); }
          }
          break;
        }
        case 'runestone': {
          const gem = new THREE.OctahedronGeometry(0.07, 0); gem.scale(0.8, 1.3, 0.8); P(gem, color || 0x66ccff);
          const ring = new THREE.TorusGeometry(0.11, 0.008, 6, 16); ring.rotateX(PI / 2); P(ring, GOLD);
          break;
        }
        case 'gauntlets': { const g = sphere(0.01, 4, 3); P(g, DSTEEL); break; }
        case 'lute': {
          const body = lathe([[0.0001, -0.02], [0.13, 0.0], [0.16, 0.12], [0.11, 0.26], [0.0001, 0.3]], 14); body.rotateX(PI / 2); body.scale(1, 1, 0.35); body.translate(0, 0, 0); P(body, hexLerp(WOOD, color || WOOD, 0.3));
          const top = cyl(0.15, 0.15, 0.01, 14); top.rotateX(PI / 2); top.scale(0.95, 0.95, 1); top.translate(0, 0.13, -0.055); P(top, 0xc9a36a);
          const hole = cyl(0.035, 0.035, 0.01, 10); hole.rotateX(PI / 2); hole.translate(0, 0.16, -0.063); P(hole, 0x201810);
          const neck = box(0.05, 0.45, 0.03); neck.translate(0, 0.5, -0.03); P(neck, DWOOD);
          const head = box(0.06, 0.1, 0.035); head.rotateX(-0.4); head.translate(0, 0.76, -0.01); P(head, DWOOD);
          for (let i = 0; i < 4; i++) { const s = cyl(0.002, 0.002, 0.64, 3); s.translate(-0.015 + i * 0.01, 0.42, -0.07); P(s, 0xf0e8d0); }
          break;
        }
        case 'rod': {
          const st = cyl(0.008, 0.016, 1.6, 6); st.translate(0, 0.55, 0); P(st, hexLerp(WOOD, 0x8a6a3a, 0.5));
          const grip = cyl(0.02, 0.02, 0.22, 8); grip.translate(0, -0.05, 0); P(grip, LEATHER);
          const reel = cyl(0.03, 0.03, 0.02, 10); reel.rotateZ(PI / 2); reel.translate(-0.03, 0.12, 0); P(reel, DSTEEL);
          break;
        }
        default: { const b = extrude(bladeShape(0.05, 0.8, 0.82), 0.008, 0.004); b.translate(0, 0.06, 0); P(b, bladeCol); const grip = cyl(0.014, 0.017, 0.14, 8); grip.translate(0, -0.04, 0); P(grip, LEATHER); }
      }
      return _merge(list);
    });
  }
  // glowing parts (separate emissive mesh)
  function weaponGlowGeo(shape) {
    return cached('wglow|' + shape, () => {
      if (shape === 'staff') { const g = new THREE.OctahedronGeometry(0.06, 0); g.scale(0.75, 1.25, 0.75); g.translate(0, 1.42, 0); return g; }
      if (shape === 'runestone') { const g = new THREE.OctahedronGeometry(0.075, 0); g.scale(0.8, 1.3, 0.8); return g; }
      if (shape === 'sword' || shape === 'greatsword' || shape === 'dagger') { const L = shape === 'dagger' ? 0.32 : shape === 'greatsword' ? 1.15 : 0.82; const g = extrude(bladeShape(shape === 'dagger' ? 0.045 : 0.07, L * 1.02, 0.82), 0.004, 0.002); g.translate(0, 0.06, 0); return g; }
      if (shape === 'axe' || shape === 'halberd' || shape === 'spear' || shape === 'javelin' || shape === 'mace' || shape === 'hammer') { const g = sphere(0.09, 8, 6); g.translate(0, shape === 'axe' || shape === 'mace' || shape === 'hammer' ? 0.52 : 1.3, 0); return g; }
      const g = new THREE.OctahedronGeometry(0.05, 0); g.translate(0, 0.3, 0); return g;
    });
  }
  function buildWeapon(shape, color, glow, opts) {
    opts = opts || {};
    shape = WEAPON_SHAPES.indexOf(shape) >= 0 ? shape : 'sword';
    color = color != null ? toHex(color) : null;
    const g = new THREE.Group(); g.name = 'weapon_' + shape;
    const metalish = shape !== 'bow' && shape !== 'staff' && shape !== 'lute' && shape !== 'club' && shape !== 'rod';
    const m = mesh(weaponGeo(shape, color, opts), MAT_VC(metalish ? 0.42 : 0.7, metalish ? 0.55 : 0.05), true);
    g.add(m);
    if (glow || shape === 'staff' || shape === 'runestone') {
      const gc = glow != null ? toHex(glow) : (shape === 'staff' ? 0x66ccff : (color || 0x66ccff));
      const gm = mesh(weaponGlowGeo(shape), material(gc, { emissive: gc, emissiveIntensity: shape === 'staff' || shape === 'runestone' ? 1.6 : 0.9, rough: 0.3, opacity: (shape === 'sword' || shape === 'greatsword' || shape === 'dagger') ? 0.35 : 1 }), false);
      g.add(gm); g.userData.glow = gm;
    }
    g.userData.shape = shape;
    const sc = opts.scale || 1; g.scale.setScalar(sc);
    return g;
  }

  // ================================================================== EQUIPMENT LOOK DERIVATION
  const LIGHT_PAL = [0x6c7fa8, 0x8a6a9a, 0x7a8a5a, 0xb08a5a, 0xa05a5a, 0xe0d8c0, 0x4a6a7a, 0x9a7a4a];
  const MED_PAL = [0x6b4a2a, 0x7a5a3a, 0x4a3a2a, 0x5a4a30, 0x8a6a4a, 0x5a3a2a];
  const HEAVY_PAL = [0x9a9ea8, 0x7a7e88, 0xb0a890, 0x6a6e78, 0x8a8a94];
  const RARITY_HEX = { common: 0xd9d9d9, uncommon: 0xffe86b, rare: 0xc48bff, incomparable: 0x52b7ff, legendary: 0xff9c3a };
  const RARITY_MIX = { common: 0, uncommon: 0.1, rare: 0.2, incomparable: 0.22, legendary: 0.28 };
  function hashStr(s) { let h = 2166136261 >>> 0; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
  function itemView(inst) {
    if (!inst) return null;
    try {
      if (G.Items && typeof G.Items.get === 'function') { const v = G.Items.get(inst); if (v) return v; }
      if (G.Data && G.Data.items && inst.tid && G.Data.items[inst.tid]) return Object.assign({}, G.Data.items[inst.tid], inst);
    } catch (e) { /* fall through */ }
    return inst;
  }
  const SUBTYPE_SHAPE = { sword: 'sword', axe: 'axe', mace: 'mace', dagger: 'dagger', spear: 'spear', bow: 'bow', crossbow: 'crossbow', staff: 'staff', shield: 'shield', runestone: 'runestone', gauntlets: 'gauntlets', halberd: 'halberd', javelin: 'javelin', instrument: 'lute', lute: 'lute', hammer: 'hammer', club: 'club', throwing: 'dagger', greatsword: 'greatsword' };
  function armourLook(inst, fallbackType) {
    const v = itemView(inst); if (!v) return null;
    const type = v.armourType || fallbackType || 'light';
    const rarity = v.rarity || 'common';
    const seed = hashStr(v.tid || v.id || v.name || 'x');
    let color = (v.visual && v.visual.color != null) ? toHex(v.visual.color) : (type === 'heavy' ? HEAVY_PAL[seed % HEAVY_PAL.length] : type === 'medium' ? MED_PAL[seed % MED_PAL.length] : LIGHT_PAL[seed % LIGHT_PAL.length]);
    const mix = RARITY_MIX[rarity] || 0;
    if (mix) color = hexLerp(color, RARITY_HEX[rarity] || 0xffffff, mix);
    return { type, color, rarity, legendary: rarity === 'legendary', glow: v.visual && v.visual.glow != null ? toHex(v.visual.glow) : null, subtype: v.subtype || null };
  }
  function weaponLook(inst) {
    const v = itemView(inst); if (!v) return null;
    let shape = (v.visual && v.visual.weaponShape) || SUBTYPE_SHAPE[v.subtype] || (v.slot === 'offhand' ? 'shield' : 'sword');
    if (v.subtype === 'cloak' || v.slot === 'back') return null;
    const rarity = v.rarity || 'common';
    let color = (v.visual && v.visual.color != null) ? toHex(v.visual.color) : null;
    if (color != null && RARITY_MIX[rarity]) color = hexLerp(color, RARITY_HEX[rarity] || 0xffffff, RARITY_MIX[rarity] * 0.5);
    const glow = (v.visual && v.visual.glow != null) ? toHex(v.visual.glow) : (rarity === 'legendary' ? 0xff9c3a : rarity === 'incomparable' ? 0x52b7ff : null);
    return { shape, color, glow, rarity };
  }
  function deriveLook(spec, map) {
    map = map || {};
    const at = spec.armourType || 'light';
    const L = {
      chest: armourLook(map.chest, at), legs: armourLook(map.legs, at), hands: armourLook(map.hands, at), feet: armourLook(map.feet, at),
      shoulder: armourLook(map.shoulder, at), head: armourLook(map.head, at), back: armourLook(map.back, 'light'),
      mainhand: weaponLook(map.mainhand), offhand: weaponLook(map.offhand), ranged: weaponLook(map.ranged),
    };
    if (spec.look) for (const k in spec.look) L[k] = spec.look[k];
    return L;
  }
  const lookKey = (o) => o ? (o.type || '') + '|' + (o.shape || '') + '|' + o.color + '|' + (o.glow || '') + '|' + (o.rarity || '') + '|' + (o.style || '') + '|' + (o.legendary ? 1 : 0) : '-';
  function bodyMat(type, legendary) {
    if (legendary) return material(0xffffff, { vertexColors: true, rough: type === 'heavy' ? 0.35 : 0.7, metal: type === 'heavy' ? 0.75 : 0.05, emissive: 0xff9c3a, emissiveIntensity: 0.14 });
    if (type === 'heavy') return MAT_VC(0.35, 0.75);
    if (type === 'medium') return MAT_VC(0.62, 0.06);
    if (type === 'skin') return MAT_VC(0.6, 0);
    if (type === 'hair') return MAT_VC(0.82, 0);
    if (type === 'stone') return MAT_VC(0.95, 0);
    return MAT_VC(0.88, 0);
  }

  // ================================================================== POSE CHANNELS
  const J = { hips: 0, torso: 1, head: 2, armL: 3, armR: 4, foreL: 5, foreR: 6, handL: 7, handR: 8, legL: 9, legR: 10, shinL: 11, shinR: 12, footL: 13, footR: 14, cape: 15 };
  const NJ = 16, BPOS = NJ * 3, BROT = BPOS + 3, HPOS = BROT + 3, NCH = HPOS + 3;
  function S(P, j, x, y, z) { P[j * 3] = x; P[j * 3 + 1] = y; P[j * 3 + 2] = z; }
  function A(P, j, x, y, z) { P[j * 3] += x; P[j * 3 + 1] += y; P[j * 3 + 2] += z; }
  function restPose(P) {
    P.fill(0);
    S(P, J.armL, 0.05, 0, -0.2); S(P, J.armR, 0.05, 0, 0.2);
    S(P, J.foreL, 0.18, 0, 0.02); S(P, J.foreR, 0.18, 0, -0.02);
    S(P, J.handL, -0.3, 0, 0); S(P, J.handR, -0.45, 0, 0);
    S(P, J.legL, 0, 0, -0.03); S(P, J.legR, 0, 0, 0.03);
    S(P, J.shinL, -0.04, 0, 0); S(P, J.shinR, -0.04, 0, 0);
  }

  // ================================================================== HUMANOID RIG
  const ONE_SHOT = { attack_slash: 0.6, attack_thrust: 0.5, attack_spin: 0.8, attack_shoot: 0.9, cast: 1.0, hit: 0.35, roll: 0.55, jump: 0.3, fish_cast: 1.2, emote_wave: 2.0, emote_bow: 2.0, emote_cheer: 1.8, attack: 0.6, shoot: 0.9 };
  const STATE_ANIM = { death: 1, sit: 1, fish_wait: 1, fish_reel: 1, ride: 1, swim: 1, emote_dance: 1, cast_loop: 1 };
  const LOCO = { idle: 1, walk: 1, run: 1, fall: 1 };
  const ANIM_ALIAS = { attack: 'attack_slash', slash: 'attack_slash', thrust: 'attack_thrust', spin: 'attack_spin', shoot: 'attack_shoot', shout: 'emote_cheer', block: 'hit', wave: 'emote_wave', dance: 'emote_dance', bow: 'emote_bow', cheer: 'emote_cheer', dodge: 'roll', stand: 'idle', gallop: 'run' };
  const BLEND_TIME = 0.15;
  const DEFAULT_SKIN = { man: 0xe3b48f, elf: 0xf1dcc4, dwarf: 0xd9a97a, hobbit: 0xeac39c, highelf: 0xf4e2cc, beorning: 0xd8a882, stoutaxe: 0xd2a070, riverhobbit: 0xdfb58a, dunedain: 0xd9ab84, rohirrim: 0xe6bd95, goblin: 0x6f8a3a, orc: 0x5a6a4a, uruk: 0x3a3a34, brigand: 0xd0a078, sorcerer: 0xd8c0a8, troll: 0x7a7468, giant: 0x9a9080, wight: 0xa7b0b8 };
  const DEFAULT_HAIR = { man: 0x4a2f1a, elf: 0xe8d8a8, dwarf: 0x8a3a1a, hobbit: 0x6a3a1a, highelf: 0xf0e4c0, beorning: 0x3a2a1a, stoutaxe: 0x2a1a10, riverhobbit: 0x3a2a1a, dunedain: 0x2a1a12, rohirrim: 0xd8b060 };
  let _rigCount = 0, _humanoidCount = 0, _monsterCount = 0, _horseCount = 0;
  const _tmpV = new THREE.Vector3(), _tmpV2 = new THREE.Vector3();

  function HumanoidRig(spec) {
    spec = spec || {};
    this.spec = spec;
    this.kind = 'humanoid';
    const d = this.d = computeDims(spec);
    this.height = d.H;
    this.group = new THREE.Group(); this.group.name = 'rig_' + (spec.race || 'man');
    this.body = grp(0, 0, 0, this.group);
    const rd = raceData(spec.race);
    this.skin = toHex(spec.skin != null ? spec.skin : (rd && rd.skinTones && rd.skinTones[0]) || DEFAULT_SKIN[spec.race] || 0xe3b48f);
    const hairIsStyle = typeof spec.hair === 'number' && spec.hair >= 0 && spec.hair < 8;
    this.hairColor = toHex(spec.hairColor != null ? spec.hairColor : (!hairIsStyle && spec.hair != null) ? spec.hair : (rd && rd.hairColors && rd.hairColors[0]) || DEFAULT_HAIR[spec.race] || 0x4a2f1a);
    this.hairStyle = spec.hairStyle != null ? spec.hairStyle : hairIsStyle ? spec.hair : (d.R.hair ? d.R.hair[d.female ? 1 : 0] : 0);
    if (rd && rd.hairStyles && this.hairStyle !== 5) this.hairStyle = this.hairStyle % Math.max(1, Math.min(5, rd.hairStyles));
    this.beard = spec.beard != null ? spec.beard : (d.female ? 0 : d.R.beard || 0);
    this.eyeColor = toHex(spec.eyes != null ? spec.eyes : spec.eyeColor != null ? spec.eyeColor : (spec.race === 'elf' || spec.race === 'highelf' ? 0x5a8ab0 : spec.race === 'dwarf' || spec.race === 'stoutaxe' ? 0x4a3020 : 0x3a5a7a));
    this.faceOpts = Object.assign({ eye: this.eyeColor, brow: hexMul(this.hairColor, 0.8) }, spec.faceOpts || {});
    this.meshes = {}; this.parts = {};
    // hierarchy
    const hips = this.parts.hips = grp(0, d.hipY, 0, this.body);
    const torso = this.parts.torso = grp(0, 0, 0, hips);
    const head = this.parts.head = grp(0, d.torsoLen + d.neckLen + d.headR * 0.85, 0, torso);
    this.headRest = head.position.y;
    const sy = d.torsoLen * 0.93;
    this.parts.armL = grp(-d.shoulderHalf, sy, 0, torso); this.parts.armR = grp(d.shoulderHalf, sy, 0, torso);
    this.parts.forearmL = grp(0, -d.upperArm, 0, this.parts.armL); this.parts.forearmR = grp(0, -d.upperArm, 0, this.parts.armR);
    this.parts.handL = grp(0, -d.foreArm, 0, this.parts.forearmL); this.parts.handR = grp(0, -d.foreArm, 0, this.parts.forearmR);
    this.parts.legL = grp(-d.legX, -d.s * 0.02, 0, hips); this.parts.legR = grp(d.legX, -d.s * 0.02, 0, hips);
    this.parts.shinL = grp(0, -d.thigh, 0, this.parts.legL); this.parts.shinR = grp(0, -d.thigh, 0, this.parts.legR);
    this.parts.footL = grp(0, -d.shin, 0, this.parts.shinL); this.parts.footR = grp(0, -d.shin, 0, this.parts.shinR);
    this.parts.capeGroup = grp(0, d.torsoLen * 0.98, d.chestR * 0.62, torso);
    this.parts.weaponMain = grp(0, -d.handLen * 0.55, 0, this.parts.handR); this.parts.weaponMain.rotation.set(-PI / 2, PI / 2, 0);
    this.parts.weaponOff = grp(0, -d.handLen * 0.55, 0, this.parts.handL); this.parts.weaponOff.rotation.set(-PI / 2, -PI / 2, 0);
    this.parts.weaponRanged = grp(0, 0, 0, torso);
    this.parts.propGroup = grp(0, -d.handLen * 0.55, 0, this.parts.handR); this.parts.propGroup.rotation.set(-PI / 2, PI / 2, 0);
    this.parts.attachHead = grp(0, d.headR * 1.4, 0, head);
    this.jointList = [hips, torso, head, this.parts.armL, this.parts.armR, this.parts.forearmL, this.parts.forearmR, this.parts.handL, this.parts.handR, this.parts.legL, this.parts.legR, this.parts.shinL, this.parts.shinR, this.parts.footL, this.parts.footR, this.parts.capeGroup];
    this.hipsRest = d.hipY;
    // pose state
    this.P = new Float32Array(NCH); this.cur = new Float32Array(NCH); this.prev = new Float32Array(NCH);
    restPose(this.P); this.cur.set(this.P); this.prev.set(this.P);
    this.blendT = 1; this.anim = 'idle'; this.lastAnim = null; this.animT = 0; this.time = 0; this.cycle = 0; this.speed = 0;
    this.oneShot = null; this.oneShotT = 0; this.oneShotDur = 0; this.oneShotRemaining = 0; this.state = null; this.mounted = false; this.lookY = 0; this.lookX = 0;
    this.idleSeed = (hashStr(spec.name || spec.race || 'x') % 1000) / 1000 * 10;
    this.weaponScale = d.s * (spec.weaponScale || 1);
    this.lookKeys = {}; this.look = null; this.prop = null; this.propKind = null;
    this.rangedInHands = false;
    this.setEquipment(spec.equipment || {}, true);
    if (spec.nameplate && spec.name) { this.nameplate = nameplate(spec.name, spec.nameColor || '#ffffff', { sub: spec.title || (spec.level ? 'Level ' + spec.level : '') }); this.nameplate.position.y = d.H + 0.12; this.group.add(this.nameplate); }
    _rigCount++; _humanoidCount++;
    this.applyPose(this.cur);
  }
  const HP = HumanoidRig.prototype;
  HP.setMesh = function (name, parent, geo, mat, shadow, x, y, z) {
    let m = this.meshes[name];
    if (m && m.geometry === geo && m.material === mat) return m;
    if (m) { if (m.geometry && m.geometry.userData.refs) m.geometry.userData.refs--; m.parent.remove(m); }
    if (!geo) { delete this.meshes[name]; return null; }
    m = mesh(geo, mat, shadow); m.position.set(x || 0, y || 0, z || 0); m.name = name;
    geo.userData.refs = (geo.userData.refs || 0) + 1;
    parent.add(m); this.meshes[name] = m;
    return m;
  };
  HP.setEquipment = function (map, initial) {
    const spec = this.spec, d = this.d, skin = this.skin;
    if (map) spec.equipment = map;
    const look = this.look = deriveLook(spec, spec.equipment || {});
    const K = {}; for (const k in look) K[k] = lookKey(look[k]);
    const changed = (slots) => initial || slots.some(s => K[s] !== this.lookKeys[s]);
    const def = DEFAULT_CLOTHES[spec.race] || DEFAULT_CLOTHES.man;
    const isMon = !!spec.monster;
    const chest = look.chest || { type: spec.armourType === 'heavy' && !isMon ? 'light' : 'light', color: def[0], rarity: 'common', none: true };
    const legs = look.legs || { type: 'light', color: def[1], rarity: 'common', none: true };
    const hands = look.hands, feet = look.feet;
    const shape = look.mainhand ? look.mainhand.shape : null;
    // --- head / face / hair
    if (changed(['head'])) {
      const hm = this.setMesh('head', this.parts.head, headGeo(d, skin), bodyMat('skin'), true);
      this.setMesh('face', this.parts.head, faceGeo(d, this.faceOpts), MAT_FACE(), false);
      const hl = look.head;
      let hideHair = false, helmType = null, hc = 0, hc2 = 0;
      if (hl) {
        helmType = hl.style || (hl.type === 'heavy' ? (spec.race === 'rohirrim' || spec.race === 'dwarf' || spec.race === 'stoutaxe' ? 'hornhelm' : 'helm') : hl.type === 'medium' ? 'lcap' : (spec.race === 'elf' || spec.race === 'highelf' ? 'circlet' : (hashStr(String(hl.color)) & 1) ? 'hood' : 'cap'));
        hc = hl.color; hc2 = hl.type === 'heavy' ? hexMul(hl.color, 0.7) : hexMul(hl.color, 0.75);
        hideHair = helmType === 'helm' || helmType === 'hornhelm' || helmType === 'hood';
        this.setMesh('helmet', this.parts.head, helmetGeo(d, helmType, hc, hc2), bodyMat(hl.type, hl.legendary), false);
      } else this.setMesh('helmet', this.parts.head, null);
      this.parts.helmet = this.meshes.helmet || null;
      const style = hideHair ? (this.beard ? 5 : 5) : this.hairStyle;
      const hg = hairGeo(d, style, hideHair && helmType !== 'hood' ? this.beard : this.beard, this.hairColor);
      this.setMesh('hair', this.parts.head, hg.getAttribute('position').count ? hg : null, bodyMat('hair'), true);
      this.parts.hair = this.meshes.hair || null;
      if (this.faceOpts.glowEyes) { const eg = cached('eyeglow|' + d.key, () => { const r = d.headR, l = []; for (const sd of [-1, 1]) { const e = sphere(r * 0.13, 8, 6); e.scale(1, 1, 0.6); e.translate(sd * r * 0.36, r * 0.12, -r * 0.92); l.push(e); } return _merge(l); }); this.setMesh('eyeglow', this.parts.head, eg, material(this.faceOpts.glowEyes, { emissive: this.faceOpts.glowEyes, emissiveIntensity: 2.2 }), false); }
    }
    // --- torso & arms
    if (changed(['chest', 'hands', 'legs'])) {
      const v = chest.style || (isMon && chest.type === 'stone' ? 'bare' : chest.type === 'heavy' ? 'plate' : chest.type === 'medium' ? (spec.race === 'beorning' ? 'fur' : 'leather') : (spec.cls === 'loremaster' || spec.cls === 'runekeeper' || spec.cls === 'minstrel' || spec.robe) ? 'robe' : 'cloth');
      const c2 = chest.type === 'heavy' ? hexMul(chest.color, 0.65) : hexLerp(chest.color, 0x3a2a1c, 0.6);
      this.setMesh('torso', this.parts.torso, torsoGeo(d, v, chest.color, c2, skin), bodyMat(chest.type, chest.legendary), true);
      const sleeve = chest.none ? (d.R.hunch ? 'none' : 'full') : chest.type === 'heavy' ? 'plate' : chest.type === 'medium' ? 'short' : 'full';
      const armMat = bodyMat(sleeve === 'none' ? 'skin' : chest.type, chest.legendary);
      this.setMesh('armL', this.parts.armL, upperArmGeo(d, chest.color, skin, sleeve), armMat, true);
      this.setMesh('armR', this.parts.armR, upperArmGeo(d, chest.color, skin, sleeve), armMat, true);
      const fs = hands ? (hands.type === 'heavy' ? 'plate' : hands.type === 'medium' ? 'bracer' : 'full') : (sleeve === 'short' || sleeve === 'none' ? 'none' : 'full');
      const fcol = hands && fs !== 'full' ? hands.color : chest.color;
      const fmat = bodyMat(fs === 'none' ? 'skin' : (hands && fs !== 'full' ? hands.type : chest.type), hands ? hands.legendary : chest.legendary);
      this.setMesh('forearmL', this.parts.forearmL, forearmGeo(d, fcol, skin, fs), fmat, false);
      this.setMesh('forearmR', this.parts.forearmR, forearmGeo(d, fcol, skin, fs), fmat, false);
    }
    if (changed(['hands', 'mainhand'])) {
      const gaunt = shape === 'gauntlets';
      const kind = gaunt ? 'gauntlet' : hands ? 'glove' : 'bare';
      const col = gaunt ? (look.mainhand.color || 0x9a9ea8) : hands ? hands.color : skin;
      const hm = gaunt ? bodyMat('heavy', look.mainhand.rarity === 'legendary') : hands ? bodyMat(hands.type, hands.legendary) : bodyMat('skin');
      this.setMesh('handL', this.parts.handL, handGeo(d, col, kind, -1), hm, false);
      this.setMesh('handR', this.parts.handR, handGeo(d, col, kind, 1), hm, false);
    }
    // --- legs & feet
    if (changed(['legs', 'feet'])) {
      const hv = legs.style || (legs.type === 'heavy' ? 'tassets' : (spec.cls === 'loremaster' || spec.cls === 'runekeeper' || spec.robe) && legs.type === 'light' ? 'robe' : isMon && spec.race === 'wight' ? 'ragged' : spec.race === 'dwarf' && legs.none ? 'kilt' : 'trousers');
      const lc2 = hexMul(legs.color, 0.75);
      this.setMesh('hips', this.parts.hips, hipsGeo(d, hv, legs.color, lc2), bodyMat(legs.type, legs.legendary), true);
      const lm = bodyMat(legs.type, legs.legendary);
      this.setMesh('legL', this.parts.legL, thighGeo(d, legs.color), lm, true);
      this.setMesh('legR', this.parts.legR, thighGeo(d, legs.color), lm, true);
      const bare = !feet && (d.feetMul > 1 || isMon && (spec.race === 'troll' || spec.race === 'giant' || spec.race === 'goblin' || spec.race === 'wight'));
      const boot = feet ? (feet.type === 'heavy' ? 'plate' : 'tall') : 'none';
      const bc = feet ? feet.color : hexMul(def[1], 0.7);
      this.setMesh('shinL', this.parts.shinL, shinGeo(d, legs.color, boot, bc), lm, true);
      this.setMesh('shinR', this.parts.shinR, shinGeo(d, legs.color, boot, bc), lm, true);
      const fk = bare ? 'bare' : feet && feet.type === 'heavy' ? 'plate' : 'boot';
      const fcol = bare ? skin : feet ? feet.color : hexMul(def[1], 0.6);
      const fm = bare ? bodyMat('skin') : bodyMat(feet ? feet.type : 'medium', feet && feet.legendary);
      this.setMesh('footL', this.parts.footL, footGeo(d, fcol, fk), fm, false);
      this.setMesh('footR', this.parts.footR, footGeo(d, fcol, fk), fm, false);
    }
    // --- shoulders, cape
    if (changed(['shoulder'])) {
      const sl = look.shoulder;
      if (sl) this.setMesh('shoulders', this.parts.torso, pauldronGeo(d, sl.type, sl.color, sl.type === 'heavy' ? hexMul(sl.color, 0.65) : hexMul(sl.color, 0.7)), bodyMat(sl.type, sl.legendary), false);
      else this.setMesh('shoulders', this.parts.torso, null);
      this.parts.shoulders = this.meshes.shoulders || null;
    }
    if (changed(['back'])) {
      const bl = look.back;
      if (bl) { const len = d.hipY * 0.85 + d.torsoLen * 0.9; this.setMesh('cape', this.parts.capeGroup, capeGeo(d, bl.color, hexMul(bl.color, 0.7), len), material(0xffffff, { vertexColors: true, rough: 0.9, double: true, cape: true, emissive: bl.legendary ? 0xff9c3a : 0, emissiveIntensity: bl.legendary ? 0.12 : 0 }), true); }
      else this.setMesh('cape', this.parts.capeGroup, null);
      this.parts.cape = this.meshes.cape || null;
    }
    // --- weapons
    if (changed(['mainhand'])) this.setWeapon('weaponMain', look.mainhand && look.mainhand.shape !== 'gauntlets' ? look.mainhand : null, this.parts.weaponMain);
    if (changed(['offhand'])) {
      const ol = look.offhand;
      this.setWeapon('weaponOff', ol, this.parts.weaponOff);
      if (ol && ol.shape === 'shield') { this.parts.weaponOff.position.set(-d.foreR * 1.35, -d.foreArm * 0.5, 0); this.parts.weaponOff.rotation.set(0, 0, 0); this.parts.forearmL.add(this.parts.weaponOff); }
      else { this.parts.weaponOff.position.set(0, -d.handLen * 0.55, 0); this.parts.weaponOff.rotation.set(-PI / 2, -PI / 2, 0); this.parts.handL.add(this.parts.weaponOff); }
    }
    if (changed(['ranged'])) { this.setWeapon('weaponRanged', look.ranged, this.parts.weaponRanged); this.placeRanged(false); }
    this.lookKeys = K;
    this.meshCount = 0; this.group.traverse(o => { if (o.isMesh) this.meshCount++; });
  };
  HP.setWeapon = function (name, wl, parent) {
    const old = this.meshes[name];
    if (old) { parent.remove(old); }
    if (!wl) { delete this.meshes[name]; this.parts[name + 'Mesh'] = null; return; }
    const w = buildWeapon(wl.shape, wl.color, wl.glow, { race: this.spec.race, scale: this.weaponScale });
    parent.add(w); this.meshes[name] = w; this.parts[name + 'Mesh'] = w;
    if (wl.shape === 'runestone') { w.position.set(0, -0.05, -0.12 * this.weaponScale); w.userData.float = true; }
  };
  HP.placeRanged = function (inHands) {
    const w = this.meshes.weaponRanged, d = this.d, g = this.parts.weaponRanged;
    this.rangedInHands = !!inHands;
    if (!w) return;
    const shape = w.userData.shape;
    if (inHands) {
      this.parts.handL.add(g); g.position.set(0, -d.handLen * 0.55, 0);
      if (shape === 'bow' || shape === 'crossbow') g.rotation.set(-PI / 2, 0, 0); else g.rotation.set(-PI / 2, -PI / 2, 0);
      if (shape === 'runestone') g.position.set(0, -0.05, -0.12 * this.weaponScale);
    } else {
      this.parts.torso.add(g);
      if (shape === 'runestone') { g.position.set(d.shoulderHalf * 0.6, d.torsoLen * 0.3, d.chestR * 0.9); g.rotation.set(0, 0, 0); }
      else if (shape === 'crossbow') { g.position.set(0, d.torsoLen * 0.55, d.chestR * 0.95); g.rotation.set(0.1, PI, 0.6); }
      else if (shape === 'dagger') { g.position.set(d.waistR * 0.9, d.torsoLen * 0.05, 0); g.rotation.set(0, 0, PI * 0.9); }
      else { g.position.set(0, d.torsoLen * 0.55, d.chestR * 0.9); g.rotation.set(0.05, PI, 0.55); }
    }
  };
  HP.setProp = function (kind) {
    if (this.prop) { this.parts.propGroup.remove(this.prop); this.prop = null; }
    this.propKind = kind || null;
    if (kind) {
      const shape = kind === 'rod' ? 'rod' : kind === 'torch' ? 'club' : kind === 'lute' ? 'lute' : kind;
      this.prop = buildWeapon(WEAPON_SHAPES.indexOf(shape) >= 0 ? shape : 'rod', null, kind === 'torch' ? 0xffa030 : null, { scale: this.weaponScale });
      this.parts.propGroup.add(this.prop);
    }
    if (this.meshes.weaponMain) this.meshes.weaponMain.visible = !kind;
    if (this.meshes.weaponOff) this.meshes.weaponOff.visible = !kind;
  };
  HP.setMounted = function (b) { this.mounted = !!b; if (!b && this.state === 'ride') this.state = null; };
  HP.dispose = function () {
    for (const k in this.meshes) { const m = this.meshes[k]; if (m && m.geometry && m.geometry.userData.refs) m.geometry.userData.refs--; }
    if (this.nameplate) { releaseNameplate(this.nameplate); this.nameplate = null; }
    disposeTree(this.group);
    this.meshes = {}; this.disposed = true;
    _rigCount--; if (this.kind === 'humanoid') _humanoidCount--; else _monsterCount--;
  };

  // ================================================================== HUMANOID ANIMATIONS
  // Conventions: group faces -Z. Up-pointing joints (hips/torso/head): negative X = lean forward.
  // Hanging limbs (arms/legs): positive X = swing forward; right arm out = +Z, left arm out = -Z.
  // Hand X: 0 = weapon perpendicular (pointing forward when arm hangs), -PI/2 = weapon continues the arm line.
  const HANIM = {};
  HANIM.idle = function (P, t, c) {
    const b = sin(t * 1.7);
    A(P, J.torso, -0.015 + b * 0.012, 0, 0); P[BPOS + 1] = b * 0.004;
    A(P, J.armL, 0, 0, -b * 0.02); A(P, J.armR, 0, 0, b * 0.02); A(P, J.foreL, b * 0.02, 0, 0); A(P, J.foreR, b * 0.02, 0, 0);
    const w = sin(t * 0.37); A(P, J.hips, 0, 0, w * 0.02); A(P, J.torso, 0, 0, -w * 0.025);
    const look = sin(t * 0.5) * Math.max(0, sin(t * 0.13)); A(P, J.head, 0.03 * sin(t * 0.9), look * 0.45, 0);
    if (c.combat) { A(P, J.armR, 0.55, 0, 0.12); A(P, J.foreR, 0.85, 0, 0); S(P, J.handR, -0.9, 0, 0); A(P, J.armL, 0.45, 0, -0.12); A(P, J.foreL, 0.95, 0, 0); A(P, J.legL, 0.12, 0, -0.1); A(P, J.legR, -0.15, 0, 0.1); A(P, J.shinL, -0.18, 0, 0); A(P, J.shinR, -0.1, 0, 0); A(P, J.hips, -0.06, 0, 0); A(P, J.torso, 0, -0.1, 0); }
  };
  HANIM.walk = function (P, t, c) {
    const f = c.cycle, sp = clamp(c.speed / 2.5, 0.35, 1.25), amp = 0.5 * sp, sL = sin(f), sR = -sL, cL = cos(f), cR = -cL;
    S(P, J.legL, amp * sL, 0, -0.03); S(P, J.legR, amp * sR, 0, 0.03);
    S(P, J.shinL, -0.08 - 0.95 * sp * Math.max(0, cL), 0, 0); S(P, J.shinR, -0.08 - 0.95 * sp * Math.max(0, cR), 0, 0);
    S(P, J.footL, 0.2 * Math.max(0, cL) - 0.3 * Math.max(0, -sL) * sp, 0, 0); S(P, J.footR, 0.2 * Math.max(0, cR) - 0.3 * Math.max(0, -sR) * sp, 0, 0);
    S(P, J.armL, 0.05 - 0.42 * sp * sL, 0, -0.16); S(P, J.armR, 0.05 - 0.42 * sp * sR, 0, 0.16);
    S(P, J.foreL, 0.2 + 0.3 * Math.max(0, -sL), 0, 0.02); S(P, J.foreR, 0.2 + 0.3 * Math.max(0, -sR), 0, -0.02);
    P[BPOS + 1] = 0.018 * sp * cos(2 * f);
    S(P, J.hips, -0.03, -0.07 * sL, 0.035 * sL); S(P, J.torso, -0.01, 0.1 * sL, -0.03 * sL); A(P, J.head, 0.02, -0.03 * sL, 0);
  };
  HANIM.run = function (P, t, c) {
    const f = c.cycle, sp = clamp(c.speed / 6.5, 0.6, 1.3), amp = 0.95 * sp, sL = sin(f), sR = -sL, cL = cos(f), cR = -cL;
    S(P, J.legL, amp * sL + 0.1, 0, -0.03); S(P, J.legR, amp * sR + 0.1, 0, 0.03);
    S(P, J.shinL, -0.15 - 1.55 * sp * Math.max(0, cL) - 0.3 * Math.max(0, sL), 0, 0); S(P, J.shinR, -0.15 - 1.55 * sp * Math.max(0, cR) - 0.3 * Math.max(0, sR), 0, 0);
    S(P, J.footL, 0.25 * Math.max(0, cL) - 0.45 * Math.max(0, -sL), 0, 0); S(P, J.footR, 0.25 * Math.max(0, cR) - 0.45 * Math.max(0, -sR), 0, 0);
    S(P, J.armL, 0.25 - 0.7 * sp * sL, 0, -0.1); S(P, J.armR, 0.25 - 0.7 * sp * sR, 0, 0.1);
    S(P, J.foreL, 1.45 + 0.25 * Math.max(0, -sL), 0, 0.05); S(P, J.foreR, 1.45 + 0.25 * Math.max(0, -sR), 0, -0.05);
    S(P, J.handL, -0.5, 0, 0); S(P, J.handR, -0.6, 0, 0);
    P[BPOS + 1] = 0.04 * sp * cos(2 * f) + 0.01;
    S(P, J.hips, -0.22, -0.1 * sL, 0.04 * sL); S(P, J.torso, -0.06, 0.16 * sL, -0.04 * sL); S(P, J.head, 0.22, -0.05 * sL, 0);
    S(P, J.cape, -0.2, 0, 0);
  };
  HANIM.jump = function (P, t, c) {
    S(P, J.legL, 0.65, 0, -0.08); S(P, J.legR, 0.35, 0, 0.08); S(P, J.shinL, -1.15, 0, 0); S(P, J.shinR, -0.8, 0, 0); S(P, J.footL, -0.3, 0, 0); S(P, J.footR, -0.35, 0, 0);
    S(P, J.armL, -0.45, 0, -0.5); S(P, J.armR, -0.45, 0, 0.5); S(P, J.foreL, 0.35, 0, 0); S(P, J.foreR, 0.35, 0, 0);
    S(P, J.hips, -0.1, 0, 0); S(P, J.torso, -0.05, 0, 0); S(P, J.head, 0.1, 0, 0); S(P, J.cape, 0.35, 0, 0);
  };
  HANIM.fall = function (P, t, c) {
    S(P, J.legL, 0.3, 0, -0.22); S(P, J.legR, 0.25, 0, 0.22); S(P, J.shinL, -0.55, 0, 0); S(P, J.shinR, -0.45, 0, 0);
    S(P, J.armL, 0.25, 0, -1.7); S(P, J.armR, 0.25, 0, 1.7); S(P, J.foreL, 0.25, 0, -0.3); S(P, J.foreR, 0.25, 0, 0.3);
    A(P, J.armL, 0, 0, 0.1 * sin(t * 6)); A(P, J.armR, 0, 0, 0.1 * sin(t * 6 + 1));
    S(P, J.hips, 0.08, 0, 0); S(P, J.torso, 0.02, 0, 0); S(P, J.head, -0.2, 0, 0); S(P, J.cape, 0.9, 0, 0);
  };
  HANIM.roll = function (P, t, c) {
    const p = c.phase, d = c.d, pivot = d.hipY * 0.55;
    P[BPOS + 1] = pivot; P[HPOS + 1] = -pivot; P[BROT] = -TAU * (p < 0.12 ? p * 0.5 : (p - 0.12) / 0.88 * 0.94 + 0.06);
    S(P, J.hips, -0.35, 0, 0); S(P, J.torso, -0.55, 0, 0); S(P, J.head, -0.3, 0, 0);
    S(P, J.legL, 1.7, 0, -0.12); S(P, J.legR, 1.6, 0, 0.12); S(P, J.shinL, -2.3, 0, 0); S(P, J.shinR, -2.2, 0, 0); S(P, J.footL, 0.4, 0, 0); S(P, J.footR, 0.4, 0, 0);
    S(P, J.armL, 1.5, 0, -0.35); S(P, J.armR, 1.5, 0, 0.35); S(P, J.foreL, 1.9, 0, 0); S(P, J.foreR, 1.9, 0, 0); S(P, J.handL, -0.4, 0, 0); S(P, J.handR, -0.4, 0, 0);
    S(P, J.cape, 0.6, 0, 0);
  };
  function guardL(P) { S(P, J.armL, 0.5, 0, -0.3); S(P, J.foreL, 1.05, 0, 0.1); S(P, J.handL, -0.3, 0, 0); }
  HANIM.attack_slash = function (P, t, c) {
    const p = c.phase; let ax, az, hx, ty, hipx, fx;
    if (p < 0.3) { const k = easeOut(p / 0.3); ax = lerp(0.2, 2.45, k); az = lerp(0.2, 0.75, k); fx = lerp(0.2, 0.55, k); hx = lerp(-0.45, -1.25, k); ty = lerp(0, -0.42, k); hipx = lerp(0, 0.06, k); }
    else if (p < 0.55) { const k = ease((p - 0.3) / 0.25); ax = lerp(2.45, 0.55, k); az = lerp(0.75, -0.55, k); fx = lerp(0.55, 0.2, k); hx = lerp(-1.25, -0.15, k); ty = lerp(-0.42, 0.5, k); hipx = lerp(0.06, -0.22, k); }
    else { const k = ease((p - 0.55) / 0.45); ax = lerp(0.55, 0.2, k); az = lerp(-0.55, 0.2, k); fx = lerp(0.2, 0.2, k); hx = lerp(-0.15, -0.45, k); ty = lerp(0.5, 0, k); hipx = lerp(-0.22, 0, k); }
    S(P, J.armR, ax, 0, az); S(P, J.foreR, fx, 0, -0.05); S(P, J.handR, hx, 0, 0); S(P, J.torso, 0, ty, 0); S(P, J.hips, hipx, -ty * 0.3, 0);
    guardL(P);
    const st = Math.max(0, -hipx) * 2; S(P, J.legL, 0.45 * st, 0, -0.08); S(P, J.legR, -0.35 * st, 0, 0.08); S(P, J.shinL, -0.5 * st, 0, 0); S(P, J.shinR, -0.1, 0, 0);
  };
  HANIM.attack_thrust = function (P, t, c) {
    const p = c.phase; let ax, fx, ty, hipx, lunge;
    if (p < 0.35) { const k = ease(p / 0.35); ax = lerp(0.2, 0.4, k); fx = lerp(0.2, 1.75, k); ty = lerp(0, -0.35, k); hipx = lerp(0, 0.05, k); lunge = 0; }
    else if (p < 0.6) { const k = ease((p - 0.35) / 0.25); ax = lerp(0.4, 1.55, k); fx = lerp(1.75, 0.05, k); ty = lerp(-0.35, 0.38, k); hipx = lerp(0.05, -0.28, k); lunge = k; }
    else { const k = ease((p - 0.6) / 0.4); ax = lerp(1.55, 0.2, k); fx = lerp(0.05, 0.2, k); ty = lerp(0.38, 0, k); hipx = lerp(-0.28, 0, k); lunge = 1 - k; }
    S(P, J.armR, ax, 0, 0.3); S(P, J.foreR, fx, 0, -0.1); S(P, J.handR, -PI / 2, 0, 0); S(P, J.torso, 0, ty, 0); S(P, J.hips, hipx, -ty * 0.4, 0);
    guardL(P); P[BPOS + 2] = -0.12 * lunge;
    S(P, J.legL, 0.55 * lunge, 0, -0.08); S(P, J.legR, -0.45 * lunge, 0, 0.08); S(P, J.shinL, -0.65 * lunge, 0, 0); S(P, J.shinR, -0.08, 0, 0); S(P, J.footR, -0.35 * lunge, 0, 0);
  };
  HANIM.attack_spin = function (P, t, c) {
    const p = c.phase, k = sin(p * PI);
    P[BROT + 1] = -TAU * ease(p); P[BPOS + 1] = -0.1 * k;
    S(P, J.legL, 0.3 * k, 0, -0.4 * k - 0.03); S(P, J.legR, 0.3 * k, 0, 0.4 * k + 0.03); S(P, J.shinL, -0.7 * k, 0, 0); S(P, J.shinR, -0.7 * k, 0, 0);
    S(P, J.armR, 0.35 * k, 0, lerp(0.2, 1.55, k)); S(P, J.foreR, 0.1, 0, 0); S(P, J.handR, lerp(-0.45, -PI / 2, k), 0, 0);
    S(P, J.armL, 0.35 * k, 0, lerp(-0.2, -1.55, k)); S(P, J.foreL, 0.1, 0, 0); S(P, J.handL, lerp(-0.3, -PI / 2, k), 0, 0);
    S(P, J.torso, -0.15 * k, 0, 0); S(P, J.head, 0.1 * k, 0, 0); S(P, J.cape, 0.5 * k, 0, 0);
  };
  HANIM.attack_shoot = function (P, t, c) {
    const p = c.phase; const raise = p < 0.12 ? easeOut(p / 0.12) : p > 0.82 ? 1 - ease((p - 0.82) / 0.18) : 1;
    S(P, J.armL, lerp(0.05, 1.5, raise), 0, lerp(-0.2, -0.12, raise)); S(P, J.foreL, lerp(0.18, 0.06, raise), 0, 0); S(P, J.handL, lerp(-0.3, 0, raise), 0, 0);
    let fx, ax, az;
    if (p < 0.15) { const k = easeOut(p / 0.15); ax = lerp(0.05, 1.45, k); fx = lerp(0.18, 0.35, k); az = lerp(0.2, 0.2, k); }
    else if (p < 0.5) { const k = ease((p - 0.15) / 0.35); ax = lerp(1.45, 1.35, k); fx = lerp(0.35, 2.35, k); az = lerp(0.2, 0.6, k); }
    else if (p < 0.62) { ax = 1.35; fx = 2.35 + 0.03 * sin(t * 30); az = 0.6; }
    else if (p < 0.7) { const k = easeOut((p - 0.62) / 0.08); ax = lerp(1.35, 1.2, k); fx = lerp(2.35, 1.5, k); az = lerp(0.6, 0.45, k); }
    else { const k = ease((p - 0.7) / 0.3); ax = lerp(1.2, 0.05, k); fx = lerp(1.5, 0.18, k); az = lerp(0.45, 0.2, k); }
    S(P, J.armR, ax, 0, az); S(P, J.foreR, fx, 0, -0.1); S(P, J.handR, -0.2, 0, 0);
    S(P, J.torso, -0.03 * raise, -0.28 * raise, 0); S(P, J.hips, 0, 0.1 * raise, 0); S(P, J.head, 0.02, 0.2 * raise, -0.1 * raise);
    S(P, J.legL, 0.05, 0, -0.16 * raise - 0.03); S(P, J.legR, -0.05, 0, 0.16 * raise + 0.03); S(P, J.shinL, -0.12, 0, 0); S(P, J.shinR, -0.12, 0, 0);
  };
  HANIM.cast = function (P, t, c) {
    const p = c.phase; const r = ease(Math.min(1, p / 0.25)) * (p > 0.8 ? 1 - ease((p - 0.8) / 0.2) : 1);
    S(P, J.armL, lerp(0.05, 1.4, r), 0, lerp(-0.2, -0.5, r)); S(P, J.foreL, lerp(0.18, 0.85, r), 0, 0.1 * r); S(P, J.handL, -0.25 + 0.05 * sin(t * 25) * r, 0, 0);
    S(P, J.armR, lerp(0.05, 1.35, r), 0, lerp(0.2, 0.5, r)); S(P, J.foreR, lerp(0.18, 0.85, r), 0, -0.1 * r); S(P, J.handR, lerp(-0.45, 0.7, r) + 0.05 * sin(t * 23) * r, 0, 0);
    S(P, J.torso, -0.1 * r, 0, 0); S(P, J.hips, 0.03 * r, 0, 0); S(P, J.head, 0.2 * r, 0, 0);
    S(P, J.legL, 0.05, 0, -0.15 * r - 0.03); S(P, J.legR, 0.05, 0, 0.15 * r + 0.03); S(P, J.shinL, -0.15 * r, 0, 0); S(P, J.shinR, -0.15 * r, 0, 0);
    S(P, J.cape, 0.25 * r, 0, 0);
  };
  HANIM.cast_loop = function (P, t, c) { c.phase = 0.5; HANIM.cast(P, t, c); };
  HANIM.hit = function (P, t, c) {
    const k = sin(c.phase * PI);
    S(P, J.hips, 0.2 * k, 0, 0); S(P, J.torso, 0.14 * k, 0, 0.08 * k); S(P, J.head, 0.3 * k, 0.1 * k, 0); P[BPOS + 2] = 0.07 * k;
    S(P, J.armL, 0.6 * k, 0, -0.2 - 0.4 * k); S(P, J.armR, 0.5 * k, 0, 0.2 + 0.5 * k); S(P, J.foreL, 0.18 + 0.7 * k, 0, 0); S(P, J.foreR, 0.18 + 0.5 * k, 0, 0);
    S(P, J.legR, -0.35 * k, 0, 0.05); S(P, J.shinR, -0.35 * k, 0, 0); S(P, J.legL, 0.1 * k, 0, -0.05);
  };
  HANIM.death = function (P, t, c) {
    const p = Math.min(1, c.t / 0.85), k = p * p * (3 - 2 * p), s = clamp((c.t - 0.85) / 0.6, 0, 1), d = c.d;
    P[BROT] = 1.5 * k + 0.05 * sin(s * PI) * (1 - s); P[BPOS + 1] = 0.13 * d.s * k; P[BPOS + 2] = 0.04 * k;
    S(P, J.armL, 0.3 * k, 0, -0.2 - 0.9 * k); S(P, J.armR, 0.3 * k, 0, 0.2 + 1.0 * k); S(P, J.foreL, 0.18 + 0.3 * k, 0, 0); S(P, J.foreR, 0.18 + 0.2 * k, 0, 0); S(P, J.handL, -0.2, 0, 0); S(P, J.handR, -0.2, 0, 0);
    S(P, J.head, 0.25 * k, 0.4 * k, 0.1 * k); S(P, J.torso, 0.08 * k, 0.05 * k, 0); S(P, J.hips, 0.02 * k, 0, 0);
    S(P, J.legL, 0.15 * k, 0, -0.18 * k - 0.03); S(P, J.legR, 0.05 * k, 0, 0.1 * k + 0.03); S(P, J.shinL, -0.3 * k, 0, 0); S(P, J.shinR, -0.12 * k, 0, 0);
    S(P, J.footL, -0.4 * k, 0, 0); S(P, J.footR, -0.45 * k, 0, 0); S(P, J.cape, 0.3 * k, 0, 0);
  };
  HANIM.sit = function (P, t, c) {
    const d = c.d, b = sin(t * 1.5);
    P[HPOS + 1] = -d.hipY + d.s * 0.17;
    S(P, J.legL, 1.45, 0.25, -0.85); S(P, J.legR, 1.45, -0.25, 0.85); S(P, J.shinL, -2.35, 0, 0.35); S(P, J.shinR, -2.35, 0, -0.35); S(P, J.footL, 0.5, 0.3, 0); S(P, J.footR, 0.5, -0.3, 0);
    S(P, J.torso, -0.14 + 0.012 * b, 0, 0); S(P, J.head, 0.1 + 0.02 * sin(t * 0.8), 0.3 * sin(t * 0.4) * Math.max(0, sin(t * 0.17)), 0);
    S(P, J.armL, 0.6, 0, -0.35); S(P, J.armR, 0.6, 0, 0.35); S(P, J.foreL, 0.45 + 0.02 * b, 0, 0.1); S(P, J.foreR, 0.45 + 0.02 * b, 0, -0.1); S(P, J.handL, -0.3, 0, 0); S(P, J.handR, -0.3, 0, 0);
  };
  HANIM.fish_cast = function (P, t, c) {
    const p = c.phase; let ax, az, fx, hx, ty, tx, la, lf;
    if (p < 0.35) { const k = ease(p / 0.35); ax = lerp(0.3, 2.3, k); az = lerp(0.2, 0.5, k); fx = lerp(0.3, 0.9, k); hx = lerp(-0.4, -1.3, k); ty = lerp(0, -0.3, k); tx = 0.08 * k; la = 0.05; lf = 0.18; }
    else if (p < 0.55) { const k = ease((p - 0.35) / 0.2); ax = lerp(2.3, 1.1, k); az = lerp(0.5, 0.25, k); fx = lerp(0.9, 0.2, k); hx = lerp(-1.3, -0.55, k); ty = lerp(-0.3, 0.2, k); tx = lerp(0.08, -0.15, k); la = 0.05; lf = 0.18; }
    else { const k = ease((p - 0.55) / 0.45); ax = lerp(1.1, 0.95, k); az = lerp(0.25, 0.15, k); fx = lerp(0.2, 0.45, k); hx = lerp(-0.55, -0.85, k); ty = lerp(0.2, 0.1, k); tx = lerp(-0.15, -0.03, k); la = lerp(0.05, 0.6, k); lf = lerp(0.18, 1.25, k); }
    S(P, J.armR, ax, 0, az); S(P, J.foreR, fx, 0, -0.05); S(P, J.handR, hx, 0, 0); S(P, J.torso, tx, ty, 0); S(P, J.hips, 0, -ty * 0.3, 0);
    S(P, J.armL, la, 0, -0.2); S(P, J.foreL, lf, 0, 0.15); S(P, J.handL, -0.2, 0, 0);
    S(P, J.legL, 0.1, 0, -0.1); S(P, J.legR, -0.1, 0, 0.1); S(P, J.shinL, -0.12, 0, 0); S(P, J.shinR, -0.05, 0, 0);
  };
  HANIM.fish_wait = function (P, t, c) {
    const b = sin(t * 1.5);
    S(P, J.armR, 0.95 + 0.02 * b, 0, 0.15); S(P, J.foreR, 0.45, 0, -0.05); S(P, J.handR, -0.85 + 0.03 * sin(t * 2.1), 0, 0);
    S(P, J.armL, 0.6, 0, -0.2); S(P, J.foreL, 1.25 + 0.02 * b, 0, 0.15); S(P, J.handL, -0.2, 0, 0);
    S(P, J.torso, -0.03 + 0.012 * b, 0.1, 0); S(P, J.hips, 0, -0.03, 0); S(P, J.head, 0.05 + 0.02 * sin(t * 0.7), -0.1 + 0.15 * sin(t * 0.3), 0.04 * sin(t * 0.5));
    S(P, J.legL, 0.1, 0, -0.1); S(P, J.legR, -0.1, 0, 0.1); S(P, J.shinL, -0.12, 0, 0); S(P, J.shinR, -0.05, 0, 0);
  };
  HANIM.fish_reel = function (P, t, c) {
    const j = sin(t * 11), b = sin(t * 3.1);
    S(P, J.armR, 1.15 + 0.04 * b, 0, 0.2); S(P, J.foreR, 0.55 + 0.03 * j, 0, -0.05); S(P, J.handR, -1.0 + 0.04 * j, 0, 0);
    S(P, J.armL, 0.55, 0, -0.25); S(P, J.foreL, 1.3 + 0.35 * j, 0, 0.15 * cos(t * 11)); S(P, J.handL, -0.3, 0, 0);
    S(P, J.torso, 0.1 + 0.03 * b, 0.12, 0); S(P, J.hips, -0.06, -0.04, 0); S(P, J.head, -0.05, -0.1, 0); P[BPOS + 1] = 0.006 * j;
    S(P, J.legL, 0.15, 0, -0.22); S(P, J.legR, -0.15, 0, 0.22); S(P, J.shinL, -0.25, 0, 0); S(P, J.shinR, -0.2, 0, 0);
  };
  HANIM.ride = function (P, t, c) {
    const d = c.d, sp = Math.min(1, c.speed / 5), bob = sin(c.cycle * 2) * 0.02 * sp;
    P[HPOS + 1] = -d.hipY + d.s * 0.06 + bob;
    S(P, J.legL, 1.05, 0, -0.5); S(P, J.legR, 1.05, 0, 0.5); S(P, J.shinL, -1.35, 0, 0.15); S(P, J.shinR, -1.35, 0, -0.15); S(P, J.footL, 0.3, 0, 0); S(P, J.footR, 0.3, 0, 0);
    S(P, J.armL, 0.7 + 0.03 * sin(c.cycle * 2), 0, -0.15); S(P, J.armR, 0.7 + 0.03 * sin(c.cycle * 2), 0, 0.15); S(P, J.foreL, 0.7, 0, 0.05); S(P, J.foreR, 0.7, 0, -0.05); S(P, J.handL, -0.4, 0, 0); S(P, J.handR, -0.4, 0, 0);
    S(P, J.torso, -0.06 - 0.12 * sp + 0.012 * sin(t * 1.6), 0, 0); S(P, J.head, 0.08 + 0.12 * sp, 0.25 * sin(t * 0.4) * Math.max(0, sin(t * 0.15)) * (1 - sp), 0); S(P, J.cape, -0.3 * sp, 0, 0);
  };
  HANIM.swim = function (P, t, c) {
    const d = c.d;
    P[BROT] = -1.35; P[BPOS + 1] = 0.95; P[BPOS + 2] = d.hipY * 0.75;
    S(P, J.armR, wrapA(t * 3.2), 0, 0.35); S(P, J.armL, wrapA(t * 3.2 + PI), 0, -0.35); S(P, J.foreR, 0.35, 0, -0.1); S(P, J.foreL, 0.35, 0, 0.1); S(P, J.handR, -0.2, 0, 0); S(P, J.handL, -0.2, 0, 0);
    S(P, J.legL, 0.2 + 0.3 * sin(t * 7), 0, -0.05); S(P, J.legR, 0.2 - 0.3 * sin(t * 7), 0, 0.05); S(P, J.shinL, -0.25, 0, 0); S(P, J.shinR, -0.25, 0, 0); S(P, J.footL, -0.5, 0, 0); S(P, J.footR, -0.5, 0, 0);
    S(P, J.head, 0.75, 0.25 * sin(t * 1.6), 0); S(P, J.torso, -0.08, 0, 0); S(P, J.cape, 0.9, 0, 0);
  };
  HANIM.emote_wave = function (P, t, c) {
    const p = c.phase, k = p < 0.2 ? ease(p / 0.2) : p > 0.85 ? 1 - ease((p - 0.85) / 0.15) : 1;
    S(P, J.armR, 0.35 * k + 0.05, 0, lerp(0.2, 2.6, k)); S(P, J.foreR, 0.15, 0, 0.4 * sin(t * 9) * k); S(P, J.handR, -0.15 * k, 0, 0);
    S(P, J.head, 0, 0.15 * k, 0.05 * k); S(P, J.torso, 0, 0, -0.04 * k);
    HANIM.idle(P, t, c); S(P, J.armR, 0.35 * k + 0.05, 0, lerp(0.2, 2.6, k)); S(P, J.foreR, 0.15, 0, 0.4 * sin(t * 9) * k);
  };
  HANIM.emote_dance = function (P, t, c) {
    const b = sin(t * 4.2), ab = Math.abs(b);
    P[BPOS + 1] = ab * 0.05; S(P, J.hips, 0, 0, 0.12 * b); S(P, J.torso, -0.05, 0.15 * sin(t * 2.1), -0.08 * b);
    S(P, J.armL, 0.4, 0, -0.9 - 0.7 * Math.max(0, b)); S(P, J.foreL, 1.2 + 0.4 * b, 0, 0.1); S(P, J.armR, 0.4, 0, 0.9 + 0.7 * Math.max(0, -b)); S(P, J.foreR, 1.2 - 0.4 * b, 0, -0.1); S(P, J.handL, -0.3, 0, 0); S(P, J.handR, -0.3, 0, 0);
    S(P, J.legL, 0.2 * Math.max(0, b), 0, -0.15 - 0.1 * b); S(P, J.legR, 0.2 * Math.max(0, -b), 0, 0.15 - 0.1 * b); S(P, J.shinL, -0.3 - 0.3 * Math.max(0, b), 0, 0); S(P, J.shinR, -0.3 - 0.3 * Math.max(0, -b), 0, 0);
    S(P, J.head, 0.05 * b, 0.25 * sin(t * 2.1), -0.05 * b);
  };
  HANIM.emote_bow = function (P, t, c) {
    const p = c.phase, k = p < 0.3 ? ease(p / 0.3) : p < 0.7 ? 1 : 1 - ease((p - 0.7) / 0.3);
    S(P, J.torso, -0.95 * k, 0, 0); S(P, J.head, -0.15 * k, 0, 0); S(P, J.hips, 0.12 * k, 0, 0);
    S(P, J.armR, 0.9 * k + 0.05, 0, 0.3 * k + 0.2); S(P, J.foreR, 1.35 * k + 0.18, 0, -0.3 * k); S(P, J.handR, -0.3, 0, 0);
    S(P, J.armL, -0.6 * k + 0.05, 0, -0.5 * k - 0.2); S(P, J.foreL, 0.3, 0, 0); S(P, J.handL, -0.3, 0, 0);
    S(P, J.legL, 0.2 * k, 0, -0.03); S(P, J.legR, -0.35 * k, 0, 0.03); S(P, J.shinR, -0.35 * k, 0, 0); S(P, J.shinL, -0.05, 0, 0);
  };
  HANIM.emote_cheer = function (P, t, c) {
    const p = c.phase, k = p < 0.2 ? ease(p / 0.2) : p > 0.8 ? 1 - ease((p - 0.8) / 0.2) : 1;
    const hop = Math.max(0, sin(p * PI * 3)) * 0.09 * k;
    S(P, J.armL, 0.3 * k + 0.05, 0, -2.5 * k - 0.2); S(P, J.armR, 0.3 * k + 0.05, 0, 2.5 * k + 0.2); S(P, J.foreL, 0.2, 0, -0.3 * sin(t * 10) * k); S(P, J.foreR, 0.2, 0, 0.3 * sin(t * 10) * k); S(P, J.handL, -0.2, 0, 0); S(P, J.handR, -0.2, 0, 0);
    S(P, J.head, 0.25 * k, 0, 0); S(P, J.torso, 0.05 * k, 0, 0); P[BPOS + 1] = hop;
    const land = (1 - hop / 0.09) * k; S(P, J.shinL, -0.3 * land, 0, 0); S(P, J.shinR, -0.3 * land, 0, 0); S(P, J.legL, 0.15 * land, 0, -0.05); S(P, J.legR, 0.15 * land, 0, 0.05);
  };
  const ANIM_NAMES = ['idle', 'walk', 'run', 'jump', 'fall', 'roll', 'attack_slash', 'attack_thrust', 'attack_spin', 'attack_shoot', 'cast', 'hit', 'death', 'sit', 'fish_cast', 'fish_wait', 'fish_reel', 'ride', 'swim', 'emote_wave', 'emote_dance', 'emote_bow', 'emote_cheer'];

  // ================================================================== HUMANOID RIG: ANIMATION DRIVER
  HP.attackFor = function () {
    const s = this.look && this.look.mainhand ? this.look.mainhand.shape : null;
    if (s === 'spear' || s === 'javelin' || s === 'halberd' || s === 'dagger') return 'attack_thrust';
    if (s === 'staff' || s === 'runestone') return 'cast';
    if (s === 'bow' || s === 'crossbow') return 'attack_shoot';
    return 'attack_slash';
  };
  HP.setAnim = function (name, force) {
    if (!name || this.disposed) return;
    name = ANIM_ALIAS[name] || name;
    if (name === 'attack_slash' && this.spec.monster && this.look && this.look.mainhand && (this.look.mainhand.shape === 'staff' || this.look.mainhand.shape === 'runestone')) name = 'cast';
    if (ONE_SHOT[name] != null) {
      if (this.oneShot === name && !force) return;
      if (this.oneShot) this.endOneShot(true);
      this.oneShot = name; this.oneShotT = 0;
      this.oneShotDur = name === 'roll' ? ((G.C && G.C.ROLL_TIME) || 0.55) : ONE_SHOT[name];
      this.oneShotRemaining = this.oneShotDur;
      if (name === 'attack_shoot' && this.meshes.weaponRanged) this.placeRanged(true);
      if (name === 'fish_cast' && this.propKind !== 'rod') this.setProp('rod');
      return;
    }
    if (STATE_ANIM[name]) { if (this.oneShot) this.endOneShot(true); if (name === 'ride') this.mounted = true; this.state = name; return; }
    // locomotion (idle/walk/run/jump/fall): clears any state, keeps a running one-shot unless forced
    if (this.state) this.state = null;
    if (force && this.oneShot) this.endOneShot(true);
    if (name === 'idle' && this.propKind === 'rod' && force) this.setProp(null);
  };
  HP.endOneShot = function (interrupted) {
    const n = this.oneShot; this.oneShot = null; this.oneShotRemaining = 0; this.oneShotT = 0;
    if (n === 'attack_shoot' && this.rangedInHands) this.placeRanged(false);
    if (typeof this.onOneShotEnd === 'function') { try { this.onOneShotEnd(n, !!interrupted); } catch (e) { /* owner error */ } }
  };
  HP.locomotion = function (speed, vy, onGround, swimming, mounted) {
    if (mounted) return 'ride';
    if (swimming) return 'swim';
    if (!onGround && this.airTime > 0.12) return vy > 0.4 ? 'jump' : 'fall';
    const runAt = (G.C && G.C.WALK_SPEED ? G.C.WALK_SPEED : 2.5) * 1.5;
    return speed > runAt ? 'run' : speed > 0.25 ? 'walk' : 'idle';
  };
  HP.play = function (dt, ent) {
    if (this.disposed) return;
    dt = dt > 0.1 ? 0.1 : dt < 0 ? 0 : dt || 0;
    const c = this.ctx || (this.ctx = { rig: this, d: this.d, speed: 0, cycle: 0, phase: 0, t: 0, vy: 0, combat: false, ent: null, dt: 0, anim: 'idle', oneShot: null });
    let speed = 0, vy = 0, onGround = true, swimming = false, mounted = this.mounted;
    c.ent = ent || null; c.dt = dt;
    if (ent) {
      const v = ent.vel; if (v) { speed = Math.sqrt(v.x * v.x + v.z * v.z) || 0; vy = v.y || 0; }
      if (ent.onGround === false) onGround = false;
      swimming = !!ent.swimming; if (ent.mounted && ent.kind !== 'mount') mounted = mounted || !!ent.mounted;
      const tg = ent.target;
      c.combat = !!(tg && tg.alive !== false && !tg.dead && (ent.inCombat || ent.kind === 'monster' || ent.kind === 'aiplayer' || (G.state && G.state.inCombat)));
    } else c.combat = false;
    this.airTime = onGround ? 0 : (this.airTime || 0) + dt;
    this.speed += (speed - this.speed) * Math.min(1, dt * 10);
    this.time += dt;
    if (this.oneShot) { this.oneShotT += dt; this.oneShotRemaining = Math.max(0, this.oneShotDur - this.oneShotT); if (this.oneShotT >= this.oneShotDur) this.endOneShot(false); }
    let eff = this.oneShot;
    if (!eff && this.state) { eff = this.state; if ((eff === 'sit' || eff === 'fish_wait' || eff === 'fish_reel' || eff === 'emote_dance' || eff === 'cast_loop') && speed > 0.6) { this.state = null; eff = null; } }
    if (!eff) eff = this.locomotion(this.speed, vy, onGround, swimming, mounted);
    if (eff !== this.lastAnim) { this.prev.set(this.cur); this.blendT = 0; this.animT = 0; this.lastAnim = eff; }
    this.anim = eff; this.animT += dt; c.anim = eff; c.oneShot = this.oneShot;
    const legScale = Math.max(0.45, this.d.hipY / 0.9);
    if (eff === 'walk' || eff === 'run' || eff === 'ride') this.cycle += dt * TAU * ((0.85 + 0.27 * this.speed) / legScale) * (eff === 'ride' ? 0.9 : 1);
    c.speed = this.speed; c.cycle = this.cycle; c.vy = vy; c.t = this.animT;
    c.phase = this.oneShot ? clamp(this.oneShotT / this.oneShotDur, 0, 1) : 0;
    const P = this.P; restPose(P);
    (HANIM[eff] || HANIM.idle)(P, this.time + this.idleSeed, c);
    const cur = this.cur;
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / BLEND_TIME); const k = ease(this.blendT), prev = this.prev;
      for (let i = 0; i < NCH; i++) cur[i] = (i < BPOS || (i >= BROT && i < HPOS)) ? alerp(prev[i], P[i], k) : lerp(prev[i], P[i], k);
    } else cur.set(P);
    this.applyPose(cur);
    this.postPose(dt, ent, c);
  };
  HP.applyPose = function (cur) {
    const jl = this.jointList;
    for (let j = 0; j < NJ; j++) jl[j].rotation.set(cur[j * 3], cur[j * 3 + 1], cur[j * 3 + 2]);
    this.body.position.set(cur[BPOS], cur[BPOS + 1], cur[BPOS + 2]); this.body.rotation.set(cur[BROT], cur[BROT + 1], cur[BROT + 2]);
    this.parts.hips.position.set(cur[HPOS], this.hipsRest + cur[HPOS + 1], cur[HPOS + 2]);
    if (this.d.hunch) { this.parts.torso.rotation.x -= this.d.hunch; this.parts.head.rotation.x += this.d.hunch * 0.85; }
  };
  HP.postPose = function (dt, ent, c) {
    // head tracks the target while in combat
    let desired = 0;
    if (ent && c.combat && ent.target && ent.target.pos && ent.pos && this.anim !== 'death') {
      const dx = ent.target.pos.x - ent.pos.x, dz = ent.target.pos.z - ent.pos.z;
      if (dx * dx + dz * dz < 900) desired = clamp(wrapA(Math.atan2(-dx, -dz) - (ent.yaw || 0)), -0.85, 0.85) * 0.8;
    }
    this.lookY += (desired - this.lookY) * Math.min(1, dt * 6);
    this.parts.head.rotation.y += this.lookY;
    // cape lift with speed
    const cg = this.parts.capeGroup;
    cg.rotation.x += -(0.1 + Math.min(1.1, this.speed * 0.11)) + sin(this.time * 3.1) * 0.02;
    // floating runestones & glow pulse
    const wm = this.meshes.weaponMain, wr = this.meshes.weaponRanged;
    if (wm && wm.userData.float) { wm.position.y = -0.05 + sin(this.time * 2.5) * 0.025; wm.rotation.y += dt * 1.6; }
    if (wr && wr.userData.float) { wr.position.y = (this.rangedInHands ? -0.05 : this.d.torsoLen * 0.3) + sin(this.time * 2.1 + 1) * 0.025; wr.rotation.y += dt * 1.3; }
    const pulse = this.anim === 'cast' || this.anim === 'cast_loop' ? 1 + 0.45 * (0.5 + 0.5 * sin(this.time * 12)) : 1 + 0.06 * sin(this.time * 2.3);
    if (wm && wm.userData.glow) wm.userData.glow.scale.setScalar(pulse);
    if (wr && wr.userData.glow) wr.userData.glow.scale.setScalar(pulse);
    if (this.prop && this.prop.userData.glow) this.prop.userData.glow.scale.setScalar(1 + 0.2 * sin(this.time * 9));
  };

  // ================================================================== GENERIC CREATURE RIG (non-humanoid)
  // A creature is a list of named joint groups; pose = 3 rotation channels per joint + body pos/rot (6).
  const CREATURE_ONE_SHOT = { attack: 0.7, hit: 0.35, attack_slash: 0.7, attack_thrust: 0.7, attack_spin: 0.7, attack_shoot: 0.7, cast: 0.7, emote_wave: 0.7, emote_bow: 0.7, emote_cheer: 0.7, roll: 0.5 };
  function CreatureRig(family, build) {
    this.kind = 'monster'; this.family = family;
    this.group = new THREE.Group(); this.group.name = 'rig_' + family;
    this.body = grp(0, 0, 0, this.group);
    this.joints = []; this.J = {}; this.rest = []; this.parts = {}; this.meshes = {}; this.anims = {}; this.height = 1; this.meshCount = 0;
    this.time = 0; this.animT = 0; this.cycle = 0; this.speed = 0; this.anim = 'idle'; this.lastAnim = null; this.state = null; this.oneShot = null; this.oneShotT = 0; this.oneShotDur = 0; this.oneShotRemaining = 0; this.blendT = 1;
    this.idleSeed = (hashStr(family + _rigCount) % 1000) / 100;
    this.mounted = false; this.flying = false; this.hover = 0;
    build(this);
    this.N = this.joints.length * 3 + 6; this.BP = this.joints.length * 3; this.BR = this.BP + 3;
    this.P = new Float32Array(this.N); this.cur = new Float32Array(this.N); this.prev = new Float32Array(this.N);
    this.restPose(this.P); this.cur.set(this.P); this.prev.set(this.P);
    this.ctx = { rig: this, speed: 0, cycle: 0, phase: 0, t: 0, dt: 0, ent: null, anim: 'idle' };
    this.group.traverse(o => { if (o.isMesh) this.meshCount++; });
    _rigCount++; _monsterCount++;
    this.applyPose(this.cur);
  }
  const CP = CreatureRig.prototype;
  CP.joint = function (name, x, y, z, parent, rx, ry, rz) { const g = grp(x, y, z, parent || this.body); g.name = name; this.J[name] = this.joints.length; this.joints.push(g); this.rest.push(rx || 0, ry || 0, rz || 0); this.parts[name] = g; return g; };
  CP.add = function (name, parent, geo, mat, shadow) { const m = mesh(geo, mat, shadow); m.name = name; parent.add(m); this.meshes[name] = m; return m; };
  CP.restPose = function (P) { P.fill(0); for (let i = 0; i < this.rest.length; i++) P[i] = this.rest[i]; };
  CP.S = function (P, name, x, y, z) { const j = this.J[name]; if (j == null) return; P[j * 3] = x; P[j * 3 + 1] = y; P[j * 3 + 2] = z; };
  CP.A = function (P, name, x, y, z) { const j = this.J[name]; if (j == null) return; P[j * 3] += x; P[j * 3 + 1] += y; P[j * 3 + 2] += z; };
  CP.setEquipment = function () { };
  CP.setMounted = function (b) { this.mounted = !!b; };
  CP.setProp = function () { };
  CP.setAnim = function (name, force) {
    if (!name || this.disposed) return;
    name = ANIM_ALIAS[name] || name;
    if (name === 'gallop') name = 'run';
    if (CREATURE_ONE_SHOT[name] != null) {
      const n = name === 'hit' ? 'hit' : name === 'roll' ? 'hit' : 'attack';
      if (this.oneShot === n && !force) return;
      this.oneShot = n; this.oneShotT = 0; this.oneShotDur = n === 'hit' ? 0.35 : (this.attackDur || 0.7); this.oneShotRemaining = this.oneShotDur; return;
    }
    if (name === 'death') { this.oneShot = null; this.state = 'death'; return; }
    if (name === 'sit' || name === 'emote_dance' || name === 'fish_wait' || name === 'fish_reel' || name === 'swim' || name === 'ride') { this.state = null; return; }
    if (this.state) this.state = null;
    if (force && this.oneShot) { this.oneShot = null; this.oneShotRemaining = 0; }
  };
  CP.play = function (dt, ent) {
    if (this.disposed) return;
    dt = dt > 0.1 ? 0.1 : dt < 0 ? 0 : dt || 0;
    const c = this.ctx; c.ent = ent || null; c.dt = dt;
    let speed = 0;
    if (ent && ent.vel) speed = Math.sqrt(ent.vel.x * ent.vel.x + ent.vel.z * ent.vel.z) || 0;
    this.speed += (speed - this.speed) * Math.min(1, dt * 10);
    this.time += dt;
    if (this.oneShot) { this.oneShotT += dt; this.oneShotRemaining = Math.max(0, this.oneShotDur - this.oneShotT); if (this.oneShotT >= this.oneShotDur) { this.oneShot = null; this.oneShotRemaining = 0; } }
    let eff = this.oneShot || this.state;
    if (!eff) eff = this.speed > (this.runAt || 3.2) ? 'run' : this.speed > 0.2 ? 'walk' : 'idle';
    if (eff !== this.lastAnim) { this.prev.set(this.cur); this.blendT = 0; this.animT = 0; this.lastAnim = eff; }
    this.anim = eff; this.animT += dt; c.anim = eff;
    if (eff === 'walk' || eff === 'run') this.cycle += dt * TAU * (this.cycleFreq ? this.cycleFreq(this.speed, eff) : (0.9 + 0.3 * this.speed));
    c.speed = this.speed; c.cycle = this.cycle; c.t = this.animT; c.phase = this.oneShot ? clamp(this.oneShotT / this.oneShotDur, 0, 1) : 0;
    const P = this.P; this.restPose(P);
    (this.anims[eff] || this.anims.idle)(P, this.time + this.idleSeed, c);
    const cur = this.cur, BP = this.BP, BR = this.BR;
    if (this.blendT < 1) {
      this.blendT = Math.min(1, this.blendT + dt / BLEND_TIME); const k = ease(this.blendT), prev = this.prev;
      for (let i = 0; i < this.N; i++) cur[i] = (i < BP || i >= BR) ? alerp(prev[i], P[i], k) : lerp(prev[i], P[i], k);
    } else cur.set(P);
    this.applyPose(cur);
    if (this.post) this.post(dt, ent, c);
  };
  CP.applyPose = function (cur) {
    const jl = this.joints;
    for (let j = 0; j < jl.length; j++) jl[j].rotation.set(cur[j * 3], cur[j * 3 + 1], cur[j * 3 + 2]);
    const BP = this.BP;
    this.body.position.set(cur[BP], cur[BP + 1], cur[BP + 2]); this.body.rotation.set(cur[BP + 3], cur[BP + 4], cur[BP + 5]);
  };
  CP.dispose = function () { if (this.nameplate) { releaseNameplate(this.nameplate); this.nameplate = null; } disposeTree(this.group); this.disposed = true; _rigCount--; _monsterCount--; };

  // face for creatures: eyes (vertex coloured) ; returns geometry
  function creatureEyes(r, x, y, z, col, count, spread) {
    const list = [];
    const n = count || 2;
    for (let i = 0; i < n; i++) {
      const sd = i % 2 === 0 ? -1 : 1, row = Math.floor(i / 2);
      const e = sphere(r * (1 - row * 0.25), 8, 6); e.translate(sd * (x + row * (spread || 0)), y - row * r * 1.6, z - row * r * 0.4); list.push(_paint(e, col));
      const p = sphere(r * 0.5 * (1 - row * 0.25), 6, 5); p.translate(sd * (x + row * (spread || 0)), y - row * r * 1.6, z - row * r * 0.4 - r * 0.6); list.push(_paint(p, 0x0a0a0a));
    }
    return _merge(list);
  }
  function monsterMats(td, col) {
    const elite = !!(td.elite || td.boss);
    const em = td.boss ? 0.28 : td.elite ? 0.12 : 0;
    return {
      body: elite ? material(0xffffff, { vertexColors: true, rough: 0.8, emissive: col, emissiveIntensity: em }) : MAT_VC(0.8, 0),
      shiny: elite ? material(0xffffff, { vertexColors: true, rough: 0.35, emissive: col, emissiveIntensity: em }) : MAT_VC(0.35, 0.05),
      face: MAT_FACE(),
      glow: (c) => material(c, { emissive: c, emissiveIntensity: 2.0 }),
    };
  }

  // ------------------------------------------------------------------ QUADRUPEDS
  const QUAD = {
    wolf: { len: 0.95, r: 0.2, leg: 0.52, head: 0.15, snout: 0.22, ears: 'point', tail: 'bushy', chest: 1.15, belly: 0x9a9a9a, fangs: 1, mane: 0, height: 1.0 },
    warg: { len: 1.25, r: 0.28, leg: 0.62, head: 0.2, snout: 0.26, ears: 'point', tail: 'bushy', chest: 1.25, belly: 0x5a5250, fangs: 1.4, mane: 1, height: 1.25, redEyes: 1 },
    lynx: { len: 0.72, r: 0.17, leg: 0.44, head: 0.14, snout: 0.09, ears: 'tuft', tail: 'stub', chest: 1.05, belly: 0xe8dcc8, fangs: 0.7, mane: 0, height: 0.8 },
    boar: { len: 0.9, r: 0.3, leg: 0.36, head: 0.2, snout: 0.24, ears: 'round', tail: 'curl', chest: 1.2, belly: 0x6a5a4a, fangs: 0, tusks: 1, mane: 1, height: 0.9 },
    bear: { len: 1.35, r: 0.42, leg: 0.62, head: 0.24, snout: 0.16, ears: 'round', tail: 'stub', chest: 1.15, belly: 0x5a4a3a, fangs: 0.8, mane: 0, height: 1.5, hump: 1 },
    'lossoth-bear': { len: 1.45, r: 0.45, leg: 0.66, head: 0.25, snout: 0.18, ears: 'round', tail: 'stub', chest: 1.15, belly: 0xe8eef4, fangs: 0.9, mane: 0, height: 1.6, hump: 1 },
  };
  function buildQuadruped(fam, td) {
    const Q = QUAD[fam] || QUAD.wolf, col = toHex(td.color != null ? td.color : (fam === 'wolf' ? 0x7a7a80 : fam === 'boar' ? 0x5a4634 : fam === 'bear' ? 0x5a3e2a : 0x8a8a8a));
    const dark = hexMul(col, 0.7), light = hexLerp(col, Q.belly, 0.6);
    const M = monsterMats(td, col);
    const rig = new CreatureRig(fam, (R) => {
      const spineY = Q.leg + Q.r * 0.85;
      const body = R.joint('body', 0, spineY, 0);
      // body: main capsule along Z + chest sphere + hump
      const bl = [];
      const trunk = capsule(Q.r, Q.len - Q.r * 2 * 0.6, 4, 14); trunk.rotateX(PI / 2); trunk.scale(1, 0.95, 1); bl.push(_paint(trunk, col));
      const chest = sphere(Q.r * Q.chest, 14, 10); chest.scale(1, 1.05, 1.1); chest.translate(0, -Q.r * 0.05, -Q.len * 0.32); bl.push(_paint(chest, col));
      const belly = capsule(Q.r * 0.75, Q.len * 0.5, 3, 10); belly.rotateX(PI / 2); belly.translate(0, -Q.r * 0.4, Q.len * 0.05); bl.push(_paint(belly, light));
      if (Q.hump) { const h = sphere(Q.r * 0.8, 10, 8); h.translate(0, Q.r * 0.45, -Q.len * 0.22); bl.push(_paint(h, col)); }
      if (Q.mane) { for (let i = 0; i < 5; i++) { const s = cone(Q.r * 0.18, Q.r * 0.5, 5); s.rotateX(-0.6); s.translate(0, Q.r * 0.85, -Q.len * 0.35 + i * Q.len * 0.12); bl.push(_paint(s, dark)); } }
      R.add('body', body, _merge(bl), M.body, true);
      // neck & head
      const neck = R.joint('neck', 0, Q.r * 0.35, -Q.len * 0.45, body, -0.5);
      const nk = capsule(Q.r * 0.55, Q.head * 1.4, 3, 10); nk.translate(0, Q.head * 0.5, 0); R.add('neck', neck, _paint(nk, col), M.body, true);
      const head = R.joint('head', 0, Q.head * 1.3, 0, neck, 0.5);
      const hl = [];
      const skull = sphere(Q.head, 14, 10); skull.scale(1, 0.95, 1.05); hl.push(_paint(skull, col));
      const snout = capsule(Q.head * 0.55, Q.snout, 3, 10); snout.rotateX(PI / 2); snout.scale(1, 0.85, 1); snout.translate(0, -Q.head * 0.2, -Q.head * 0.6 - Q.snout * 0.4); hl.push(_paint(snout, fam === 'lynx' ? light : col));
      const nose = sphere(Q.head * 0.22, 8, 6); nose.translate(0, -Q.head * 0.08, -Q.head * 0.7 - Q.snout * 0.85); hl.push(_paint(nose, 0x1a1412));
      if (Q.tusks) { for (const sd of [-1, 1]) { const t = cone(Q.head * 0.1, Q.head * 0.55, 6); t.rotateX(-0.9); t.rotateZ(sd * 0.5); t.translate(sd * Q.head * 0.4, -Q.head * 0.35, -Q.head * 0.75 - Q.snout * 0.5); hl.push(_paint(t, 0xe8e0cc)); } const disc = cyl(Q.head * 0.3, Q.head * 0.3, Q.head * 0.1, 10); disc.rotateX(PI / 2); disc.translate(0, -Q.head * 0.1, -Q.head * 0.7 - Q.snout * 0.95); hl.push(_paint(disc, 0x9a7a70)); }
      for (const sd of [-1, 1]) {
        let e;
        if (Q.ears === 'point') { e = cone(Q.head * 0.28, Q.head * 0.6, 6); e.scale(0.7, 1, 1); e.rotateZ(sd * -0.35); e.rotateX(-0.2); e.translate(sd * Q.head * 0.55, Q.head * 0.95, Q.head * 0.1); }
        else if (Q.ears === 'tuft') { e = cone(Q.head * 0.22, Q.head * 0.55, 6); e.scale(0.7, 1, 1); e.rotateZ(sd * -0.3); e.translate(sd * Q.head * 0.55, Q.head * 0.95, Q.head * 0.05); const tuft = cone(Q.head * 0.06, Q.head * 0.25, 4); tuft.rotateZ(sd * -0.3); tuft.translate(sd * Q.head * 0.62, Q.head * 1.3, Q.head * 0.05); hl.push(_paint(tuft, 0x1a1412)); }
        else { e = sphere(Q.head * 0.28, 8, 6); e.scale(1, 1, 0.5); e.translate(sd * Q.head * 0.65, Q.head * 0.8, Q.head * 0.1); }
        hl.push(_paint(e, col));
        const inner = sphere(Q.head * 0.12, 6, 5); inner.scale(1, 1, 0.4); inner.translate(sd * Q.head * 0.55, Q.head * 0.9, Q.head * 0.0); hl.push(_paint(inner, 0xc08a80));
      }
      if (Q.fangs) { for (const sd of [-1, 1]) { const f = cone(Q.head * 0.06 * Q.fangs, Q.head * 0.22 * Q.fangs, 5); f.rotateX(PI); f.translate(sd * Q.head * 0.28, -Q.head * 0.5, -Q.head * 0.55 - Q.snout * 0.6); hl.push(_paint(f, 0xf0ece0)); } }
      R.add('head', head, _merge(hl), M.body, true);
      const eyeCol = Q.redEyes ? 0xff3020 : (fam === 'bear' || fam === 'boar' || fam === 'lossoth-bear') ? 0x2a1a10 : 0xe8c040;
      R.add('face', head, creatureEyes(Q.head * 0.16, Q.head * 0.42, Q.head * 0.22, -Q.head * 0.78, eyeCol, 2, 0), Q.redEyes || td.boss ? M.glow(eyeCol) : M.face, false);
      const jaw = R.joint('jaw', 0, -Q.head * 0.45, -Q.head * 0.4, head);
      const jg = capsule(Q.head * 0.35, Q.snout * 0.8, 3, 8); jg.rotateX(PI / 2); jg.scale(1, 0.5, 1); jg.translate(0, 0, -Q.snout * 0.45); R.add('jaw', jaw, _paint(jg, fam === 'lynx' ? light : col), M.body, false);
      // legs
      const legs = [['FL', -1, -1], ['FR', 1, -1], ['BL', -1, 1], ['BR', 1, 1]];
      const upR = Q.r * 0.42, loR = Q.r * 0.3, upL = Q.leg * 0.55, loL = Q.leg * 0.45;
      for (const [nm, sx, sz] of legs) {
        const hip = R.joint('leg' + nm, sx * Q.r * 0.62, -Q.r * 0.25, sz * Q.len * 0.36, body);
        const ug = limb(upR, upL, upR * 1.25, upR * 0.75); if (sz > 0) { const th = sphere(upR * 1.5, 10, 8); th.scale(1, 1.3, 1.2); th.translate(0, -upL * 0.2, 0); R.add('thigh' + nm, hip, _paint(th, col), M.body, true); }
        R.add('leg' + nm, hip, _paint(ug, col), M.body, true);
        const knee = R.joint('low' + nm, 0, -upL, 0, hip);
        const ll = [_paint(limb(loR, loL, loR * 1.1, loR * 0.8), fam === 'lynx' ? col : dark)];
        const paw = sphere(loR * 1.3, 8, 6); paw.scale(1, 0.6, 1.3); paw.translate(0, -loL - loR * 0.2, -loR * 0.3); ll.push(_paint(paw, dark));
        R.add('low' + nm, knee, _merge(ll), M.body, false);
      }
      // tail
      const tail = R.joint('tail', 0, Q.r * 0.55, Q.len * 0.5, body, 0.6);
      let tg;
      if (Q.tail === 'bushy') { tg = capsule(Q.r * 0.32, Q.len * 0.45, 4, 8); tg.translate(0, 0, Q.len * 0.28); tg.rotateX(PI / 2); tg.translate(0, 0, 0); tg = T(capsule(Q.r * 0.3, Q.len * 0.42, 4, 8), 0, 0, Q.len * 0.3, PI / 2); }
      else if (Q.tail === 'curl') { tg = tube([[0, 0, 0], [0, 0.08, 0.08], [0.04, 0.12, 0.14], [0, 0.06, 0.18]], Q.r * 0.08, 8); }
      else { tg = sphere(Q.r * 0.3, 8, 6); tg.scale(1, 0.8, 1.2); tg.translate(0, 0, Q.r * 0.15); }
      R.add('tail', tail, _paint(tg, col), M.body, false);
      R.height = (spineY + Q.r + Q.head * 1.2) * 1.05; R.spineY = spineY; R.Q = Q;
      R.runAt = 3.0; R.attackDur = 0.75;
      R.cycleFreq = (sp, eff) => (eff === 'run' ? 1.2 + sp * 0.18 : 0.8 + sp * 0.4) / Math.max(0.5, Q.leg / 0.5);
      R.anims = QUAD_ANIMS;
      R.post = function (dt, ent, c) { const y = this.body.position.y; if (this.anim === 'death') { /* keep */ } };
    });
    return rig;
  }
  const QUAD_ANIMS = {
    idle(P, t, c) {
      const R = c.rig, b = sin(t * 1.4);
      P[R.BP + 1] = b * 0.008; R.A(P, 'body', b * 0.01, 0, 0);
      R.A(P, 'head', 0.06 * sin(t * 0.7) - 0.06, 0.35 * sin(t * 0.45) * Math.max(0, sin(t * 0.17)), 0.04 * sin(t * 0.9));
      R.A(P, 'neck', 0.15 * Math.max(0, sin(t * 0.23 + 1)) * Math.max(0, sin(t * 0.61)), 0, 0);
      R.A(P, 'tail', 0.05 * sin(t * 1.4), 0, 0.35 * sin(t * 2.6) * (0.5 + 0.5 * sin(t * 0.31)));
      R.A(P, 'jaw', -0.05 - 0.04 * b, 0, 0);
      const ear = Math.max(0, sin(t * 0.9)) > 0.97 ? 0.3 : 0; R.A(P, 'head', 0, 0, ear * 0.1);
    },
    walk(P, t, c) {
      const R = c.rig, f = c.cycle, sp = clamp(c.speed / 2.5, 0.4, 1.2), a = 0.45 * sp;
      const ph = { FL: 0, BR: 0.15, FR: PI, BL: PI + 0.15 };
      for (const k in ph) { const s = sin(f + ph[k]), cs = cos(f + ph[k]); R.S(P, 'leg' + k, a * s, 0, 0); R.S(P, 'low' + k, -0.15 - 0.9 * sp * Math.max(0, cs), 0, 0); }
      P[R.BP + 1] = 0.012 * sp * cos(2 * f); R.A(P, 'body', 0.02 * sin(2 * f), 0.03 * sin(f), 0.03 * sin(f));
      R.A(P, 'head', -0.05 + 0.04 * cos(2 * f), 0.05 * sin(f), 0); R.A(P, 'neck', 0.05, 0, 0);
      R.A(P, 'tail', 0.1, 0, 0.25 * sin(f));
    },
    run(P, t, c) {
      const R = c.rig, f = c.cycle, sp = clamp(c.speed / 7, 0.6, 1.3), a = 0.85 * sp;
      const front = sin(f), back = sin(f + PI * 0.85);
      R.S(P, 'legFL', a * front + 0.15, 0, 0); R.S(P, 'legFR', a * sin(f - 0.35) + 0.15, 0, 0);
      R.S(P, 'legBL', a * back - 0.05, 0, 0); R.S(P, 'legBR', a * sin(f + PI * 0.85 - 0.35) - 0.05, 0, 0);
      R.S(P, 'lowFL', -0.25 - 1.2 * sp * Math.max(0, cos(f)), 0, 0); R.S(P, 'lowFR', -0.25 - 1.2 * sp * Math.max(0, cos(f - 0.35)), 0, 0);
      R.S(P, 'lowBL', -0.2 - 1.1 * sp * Math.max(0, cos(f + PI * 0.85)), 0, 0); R.S(P, 'lowBR', -0.2 - 1.1 * sp * Math.max(0, cos(f + PI * 0.85 - 0.35)), 0, 0);
      P[R.BP + 1] = 0.05 * sp * Math.max(0, sin(f + 0.5)); R.A(P, 'body', 0.14 * sp * sin(f + 0.3), 0, 0);
      R.A(P, 'head', -0.1 - 0.1 * sp * sin(f + 0.3), 0, 0); R.A(P, 'neck', 0.12, 0, 0);
      R.A(P, 'tail', -0.35, 0, 0.1 * sin(f)); R.A(P, 'jaw', -0.25, 0, 0);
    },
    attack(P, t, c) {
      const R = c.rig, p = c.phase;
      const rear = p < 0.3 ? easeOut(p / 0.3) : p < 0.5 ? 1 - ease((p - 0.3) / 0.2) : 0;
      const lunge = p < 0.3 ? 0 : p < 0.5 ? ease((p - 0.3) / 0.2) : 1 - ease((p - 0.5) / 0.5);
      R.A(P, 'body', 0.35 * rear - 0.2 * lunge, 0, 0); P[R.BP + 2] = 0.12 * rear - 0.35 * lunge; P[R.BP + 1] = 0.15 * rear + 0.04 * lunge;
      R.S(P, 'legFL', 0.9 * rear + 0.7 * lunge, 0, -0.15 * rear); R.S(P, 'legFR', 0.8 * rear + 0.5 * lunge, 0, 0.15 * rear);
      R.S(P, 'lowFL', -0.9 * rear - 0.4 * lunge, 0, 0); R.S(P, 'lowFR', -0.8 * rear - 0.6 * lunge, 0, 0);
      R.S(P, 'legBL', -0.4 * rear, 0, 0); R.S(P, 'legBR', -0.4 * rear, 0, 0); R.S(P, 'lowBL', -0.5 * rear - 0.3 * lunge, 0, 0); R.S(P, 'lowBR', -0.5 * rear - 0.3 * lunge, 0, 0);
      R.A(P, 'neck', -0.3 * rear + 0.2 * lunge, 0, 0); R.A(P, 'head', 0.3 * rear - 0.55 * lunge, 0, 0);
      R.S(P, 'jaw', -0.35 * rear - 0.75 * lunge, 0, 0); R.A(P, 'tail', 0.3 * rear, 0, 0);
    },
    hit(P, t, c) {
      const R = c.rig, k = sin(c.phase * PI);
      P[R.BP + 2] = 0.12 * k; R.A(P, 'body', -0.1 * k, 0, 0.08 * k); R.A(P, 'head', 0.4 * k, 0.3 * k, 0); R.A(P, 'neck', 0.2 * k, 0, 0);
      R.S(P, 'legFL', -0.3 * k, 0, 0); R.S(P, 'legFR', 0.2 * k, 0, 0); R.S(P, 'jaw', -0.4 * k, 0, 0);
    },
    death(P, t, c) {
      const R = c.rig, p = Math.min(1, c.t / 0.8), k = p * p * (3 - 2 * p), s = clamp((c.t - 0.8) / 0.6, 0, 1);
      R.S(P, 'body', 0.05 * k, 0, 1.45 * k + 0.05 * sin(s * PI) * (1 - s)); P[R.BP + 1] = -(R.spineY - R.Q.r * 0.95) * k;
      R.A(P, 'head', -0.3 * k, 0.5 * k, 0); R.A(P, 'neck', -0.2 * k, 0, 0); R.S(P, 'jaw', -0.35 * k, 0, 0);
      for (const nm of ['FL', 'FR', 'BL', 'BR']) { R.S(P, 'leg' + nm, (nm[0] === 'F' ? 0.5 : -0.2) * k, 0, 0); R.S(P, 'low' + nm, -0.6 * k, 0, 0); }
      R.A(P, 'tail', -0.4 * k, 0, 0);
    },
  };

  // ------------------------------------------------------------------ SPIDERS & CRAWLERS
  function buildSpider(fam, td) {
    const crawler = fam === 'crawler';
    const col = toHex(td.color != null ? td.color : (crawler ? 0x5a6a3a : 0x2a2428)), dark = hexMul(col, 0.65), light = hexLerp(col, 0xffffff, 0.15);
    const M = monsterMats(td, col);
    const rig = new CreatureRig(fam, (R) => {
      const bodyY = crawler ? 0.3 : 0.4, br = crawler ? 0.2 : 0.24;
      const body = R.joint('body', 0, bodyY, 0);
      const bl = [];
      const ceph = sphere(br, 14, 10); ceph.scale(1.1, 0.8, 1.15); bl.push(_paint(ceph, col));
      const hd = sphere(br * 0.6, 10, 8); hd.scale(1, 0.8, 1); hd.translate(0, -br * 0.05, -br * 1.0); bl.push(_paint(hd, dark));
      for (const sd of [-1, 1]) { const fang = cone(br * 0.12, br * 0.5, 6); fang.rotateX(PI - 0.5); fang.translate(sd * br * 0.22, -br * 0.4, -br * 1.35); bl.push(_paint(fang, 0xe8e0d0)); const pal = capsule(br * 0.08, br * 0.4, 2, 6); pal.rotateX(1.2); pal.translate(sd * br * 0.45, -br * 0.2, -br * 1.35); bl.push(_paint(pal, dark)); }
      if (crawler) { for (const sd of [-1, 1]) { const md = tube([[sd * br * 0.4, -br * 0.1, -br * 1.3], [sd * br * 0.6, -br * 0.1, -br * 1.7], [sd * br * 0.2, -br * 0.15, -br * 2.0]], br * 0.06, 6); bl.push(_paint(md, 0x3a3020)); } }
      R.add('body', body, _merge(bl), M.shiny, true);
      const eyeN = crawler ? 2 : 6;
      R.add('face', body, creatureEyes(br * (crawler ? 0.16 : 0.11), br * (crawler ? 0.3 : 0.2), br * (crawler ? 0.15 : 0.2), -br * 1.5, crawler ? 0x90e040 : 0xff3030, eyeN, br * 0.18), M.glow(crawler ? 0x90e040 : 0xff3030), false);
      const abd = R.joint('abdomen', 0, br * 0.3, br * 1.1, body, -0.2);
      const ab = [];
      const a1 = sphere(br * (crawler ? 1.1 : 1.4), 14, 10); a1.scale(1, crawler ? 0.8 : 0.95, crawler ? 2.0 : 1.3); a1.translate(0, 0, br * (crawler ? 1.6 : 1.1)); ab.push(_paint(a1, col));
      if (!crawler) { const mark = sphere(br * 0.5, 8, 6); mark.scale(1.2, 0.4, 1.5); mark.translate(0, br * 1.0, br * 1.0); ab.push(_paint(mark, light)); for (let i = 0; i < 6; i++) { const h = cone(br * 0.06, br * 0.35, 4); h.rotateX(-0.5 + i * 0.1); h.rotateZ((i % 2 ? 1 : -1) * 0.6); h.translate((i % 2 ? 1 : -1) * br * 0.7, br * 1.05, br * 0.6 + i * br * 0.2); ab.push(_paint(h, dark)); } }
      else { for (let i = 0; i < 5; i++) { const ring = new THREE.TorusGeometry(br * (1.05 - i * 0.08), br * 0.07, 6, 14); ring.translate(0, 0, br * (0.6 + i * 0.6)); ab.push(_paint(ring, dark)); } const sting = cone(br * 0.15, br * 0.7, 6); sting.rotateX(-PI / 2 - 0.2); sting.translate(0, br * 0.1, br * 3.7); ab.push(_paint(sting, 0x2a2018)); }
      R.add('abdomen', abd, _merge(ab), M.shiny, true);
      // legs: 4 per side
      const ang = [-0.95, -0.4, 0.25, 0.8], upL = br * (crawler ? 1.6 : 2.0), loL = br * (crawler ? 1.5 : 2.2), lr = br * 0.12;
      for (let i = 0; i < 4; i++) for (const sd of [-1, 1]) {
        const nm = (sd < 0 ? 'L' : 'R') + i;
        const root = R.joint('leg' + nm, sd * br * 0.8, 0, -br * 0.5 + i * br * 0.35, body, 0, sd * -ang[i] + (sd < 0 ? PI : 0), 0);
        // upper: from origin along +X tilted up
        const up = capsule(lr, upL, 3, 7); up.rotateZ(-PI / 2); up.translate(upL * 0.5, 0, 0); up.rotateZ(0.65);
        R.add('leg' + nm, root, _paint(up, col), M.shiny, i === 1);
        const kx = cos(0.65) * upL, ky = sin(0.65) * upL;
        const knee = R.joint('knee' + nm, kx, ky, 0, root, 0, 0, -1.9);
        const lo = capsule(lr * 0.8, loL, 3, 7); lo.rotateZ(-PI / 2); lo.translate(loL * 0.5, 0, 0);
        const tip = cone(lr * 0.8, lr * 2, 5); tip.rotateZ(-PI / 2); tip.translate(loL + lr * 0.5, 0, 0);
        R.add('knee' + nm, knee, _merge([_paint(lo, dark), _paint(tip, 0x1a1410)]), M.shiny, false);
      }
      R.height = bodyY + br * 1.6; R.br = br; R.bodyY = bodyY;
      R.runAt = 2.8; R.attackDur = 0.7;
      R.cycleFreq = (sp, eff) => 1.2 + sp * 0.45;
      R.anims = SPIDER_ANIMS;
    });
    return rig;
  }
  const SPIDER_ANIMS = {
    idle(P, t, c) {
      const R = c.rig, b = sin(t * 2.2);
      P[R.BP + 1] = b * 0.01; R.A(P, 'abdomen', 0.05 * b, 0, 0); R.A(P, 'body', 0.02 * sin(t * 0.8), 0.06 * sin(t * 0.5), 0);
      for (let i = 0; i < 4; i++) for (const sd of ['L', 'R']) { const nm = sd + i; R.A(P, 'leg' + nm, 0, 0.03 * sin(t * 1.3 + i), 0.04 * sin(t * 1.7 + i * 1.3)); }
    },
    walk(P, t, c) { SPIDER_ANIMS.scuttle(P, t, c, clamp(c.speed / 2.5, 0.4, 1)); },
    run(P, t, c) { SPIDER_ANIMS.scuttle(P, t, c, 1.3); },
    scuttle(P, t, c, sp) {
      const R = c.rig, f = c.cycle;
      for (let i = 0; i < 4; i++) for (const sd of [-1, 1]) {
        const nm = (sd < 0 ? 'L' : 'R') + i, grpA = ((i + (sd < 0 ? 0 : 1)) % 2) === 0, ph = f + (grpA ? 0 : PI);
        const lift = Math.max(0, sin(ph)), swing = cos(ph);
        R.A(P, 'leg' + nm, 0, sd * 0.35 * sp * swing * (i < 2 ? 1 : -1) * (sd < 0 ? -1 : 1), 0.5 * sp * lift);
        R.A(P, 'knee' + nm, 0, 0, -0.4 * sp * lift);
      }
      P[R.BP + 1] = 0.01 * sp * sin(2 * f); R.A(P, 'body', 0.03 * sin(2 * f), 0, 0); R.A(P, 'abdomen', 0.05 * sin(2 * f), 0.05 * sin(f), 0);
    },
    attack(P, t, c) {
      const R = c.rig, p = c.phase, rear = p < 0.35 ? easeOut(p / 0.35) : p < 0.55 ? 1 - ease((p - 0.35) / 0.2) : 0, strike = p < 0.35 ? 0 : p < 0.55 ? ease((p - 0.35) / 0.2) : 1 - ease((p - 0.55) / 0.45);
      R.A(P, 'body', 0.75 * rear - 0.25 * strike, 0, 0); P[R.BP + 1] = 0.25 * rear; P[R.BP + 2] = -0.2 * strike;
      for (let i = 0; i < 2; i++) for (const sd of [-1, 1]) { const nm = (sd < 0 ? 'L' : 'R') + i; R.A(P, 'leg' + nm, 0, 0, 0.9 * rear + 0.3 * strike); R.A(P, 'knee' + nm, 0, 0, -0.9 * rear); }
      R.A(P, 'abdomen', -0.2 * rear + 0.2 * strike, 0, 0);
    },
    hit(P, t, c) { const R = c.rig, k = sin(c.phase * PI); P[R.BP + 2] = 0.15 * k; P[R.BP + 1] = -0.05 * k; R.A(P, 'body', -0.15 * k, 0, 0); R.A(P, 'abdomen', 0.2 * k, 0, 0); for (let i = 0; i < 4; i++) { R.A(P, 'legL' + i, 0, 0, 0.2 * k); R.A(P, 'legR' + i, 0, 0, 0.2 * k); } },
    death(P, t, c) {
      const R = c.rig, p = Math.min(1, c.t / 0.9), k = p * p * (3 - 2 * p);
      R.S(P, 'body', 0, 0, 2.9 * k); P[R.BP + 1] = (-R.bodyY + R.br * 1.6) * k + 0.6 * k * (1 - k);
      for (let i = 0; i < 4; i++) for (const sd of ['L', 'R']) { const nm = sd + i; R.A(P, 'leg' + nm, 0, 0, 0.9 * k); R.A(P, 'knee' + nm, 0, 0, 1.4 * k); }
      R.A(P, 'abdomen', 0.4 * k, 0, 0);
    },
  };

  // ------------------------------------------------------------------ WINGS (bat / drake)
  function wingGeo(span, chord, col, memCol, fingers) {
    // wing extends along +X from the shoulder; membrane in the XZ plane (flat), slightly drooping
    const list = [];
    const pts = [[0, 0]]; const n = fingers || 3;
    for (let i = 0; i <= n; i++) { const t = i / n; const x = span * (0.35 + 0.65 * t), z = chord * (0.25 + 0.75 * (1 - Math.abs(t - 0.45))); pts.push([x, z]); if (i < n) pts.push([x * 0.92 + span * 0.05, chord * (0.15 + 0.5 * (1 - t))]); }
    pts.push([span * 0.25, chord * 0.55]); pts.push([0, chord * 0.5]);
    const sh = shapeFrom(pts); const mem = extrude(sh, 0.012, 0); mem.rotateX(PI / 2); // shape xy → xz (z toward +Z = backward)
    list.push(_paint(mem, memCol));
    const arm = capsule(span * 0.035, span * 0.4, 3, 6); arm.rotateZ(-PI / 2); arm.translate(span * 0.2, 0, 0.005); list.push(_paint(arm, col));
    for (let i = 0; i <= n; i++) { const t = i / n; const x = span * (0.35 + 0.65 * t), z = chord * (0.25 + 0.75 * (1 - Math.abs(t - 0.45))); const L = Math.sqrt((x - span * 0.38) ** 2 + z * z); const f = capsule(span * 0.02, L, 2, 5); f.rotateZ(-PI / 2); f.translate(L * 0.5, 0, 0); f.rotateY(-Math.atan2(z, x - span * 0.38)); f.translate(span * 0.38, 0, 0.005); list.push(_paint(f, col)); }
    return _merge(list);
  }
  // ------------------------------------------------------------------ BAT
  function buildBat(fam, td) {
    const col = toHex(td.color != null ? td.color : 0x3a2f3a), dark = hexMul(col, 0.7), mem = hexLerp(col, 0x1a1418, 0.5);
    const M = monsterMats(td, col);
    const rig = new CreatureRig(fam, (R) => {
      const hoverY = 1.7;
      const body = R.joint('body', 0, hoverY, 0);
      const bl = []; const bd = capsule(0.11, 0.14, 4, 10); bd.scale(1, 1, 1.1); bl.push(_paint(bd, col));
      const belly = sphere(0.09, 8, 6); belly.scale(1, 1.2, 0.8); belly.translate(0, -0.03, -0.05); bl.push(_paint(belly, hexLerp(col, 0x8a7a7a, 0.3)));
      for (const sd of [-1, 1]) { const leg = capsule(0.015, 0.1, 2, 5); leg.rotateX(0.5); leg.translate(sd * 0.04, -0.18, 0.02); bl.push(_paint(leg, dark)); }
      R.add('body', body, _merge(bl), M.body, true);
      const head = R.joint('head', 0, 0.17, -0.02, body);
      const hl = []; const sk = sphere(0.1, 12, 9); sk.scale(1, 0.95, 1); hl.push(_paint(sk, col));
      const sn = sphere(0.05, 8, 6); sn.scale(1, 0.8, 1.2); sn.translate(0, -0.03, -0.09); hl.push(_paint(sn, dark));
      const nose = sphere(0.02, 6, 5); nose.translate(0, -0.02, -0.14); hl.push(_paint(nose, 0x1a1012));
      for (const sd of [-1, 1]) { const e = cone(0.045, 0.16, 6); e.scale(0.6, 1, 1); e.rotateZ(sd * -0.4); e.translate(sd * 0.07, 0.15, 0); hl.push(_paint(e, col)); const f = cone(0.012, 0.05, 4); f.rotateX(PI); f.translate(sd * 0.03, -0.09, -0.08); hl.push(_paint(f, 0xf0ece0)); }
      R.add('head', head, _merge(hl), M.body, false);
      R.add('face', head, creatureEyes(0.028, 0.045, 0.01, -0.085, 0xff3030, 2, 0), M.glow(0xff3030), false);
      for (const sd of [-1, 1]) {
        const nm = sd < 0 ? 'L' : 'R';
        const w = R.joint('wing' + nm, sd * 0.09, 0.05, 0, body, 0, sd < 0 ? PI : 0, 0);
        R.add('wing' + nm, w, wingGeo(0.55, 0.32, dark, mem, 3), material(0xffffff, { vertexColors: true, rough: 0.7, double: true }), true);
      }
      R.height = hoverY + 0.35; R.hoverY = hoverY; R.flying = true;
      R.runAt = 2.5; R.attackDur = 0.6;
      R.cycleFreq = (sp) => 4;
      R.anims = BAT_ANIMS;
    });
    return rig;
  }
  const BAT_ANIMS = {
    flap(P, t, c, rate, amp, base) { const R = c.rig, f = sin(t * rate) * amp + base; R.S(P, 'wingL', 0, PI, -f); R.S(P, 'wingR', 0, 0, f); },
    idle(P, t, c) { const R = c.rig; BAT_ANIMS.flap(P, t, c, 11, 0.6, 0.15); P[R.BP + 1] = sin(t * 2.3) * 0.08 + sin(t * 11) * 0.015; R.A(P, 'body', -0.1 + 0.05 * sin(t * 0.9), 0.15 * sin(t * 0.6), 0.1 * sin(t * 0.7)); R.A(P, 'head', 0.1, 0.3 * sin(t * 0.8), 0); },
    walk(P, t, c) { const R = c.rig; BAT_ANIMS.flap(P, t, c, 13, 0.7, 0.1); P[R.BP + 1] = sin(t * 13) * 0.03; R.A(P, 'body', -0.35, 0, 0.08 * sin(t * 1.5)); R.A(P, 'head', 0.3, 0, 0); },
    run(P, t, c) { const R = c.rig; BAT_ANIMS.flap(P, t, c, 15, 0.75, 0.05); P[R.BP + 1] = sin(t * 15) * 0.03; R.A(P, 'body', -0.55, 0, 0.1 * sin(t * 1.5)); R.A(P, 'head', 0.45, 0, 0); },
    attack(P, t, c) { const R = c.rig, p = c.phase, k = sin(p * PI); BAT_ANIMS.flap(P, t, c, 18, 0.8, 0); P[R.BP + 2] = -0.45 * k; P[R.BP + 1] = -0.35 * k; R.A(P, 'body', -0.6 * k, 0, 0); R.A(P, 'head', 0.5 * k, 0, 0); },
    hit(P, t, c) { const R = c.rig, k = sin(c.phase * PI); BAT_ANIMS.flap(P, t, c, 20, 0.9, 0.3); P[R.BP + 2] = 0.25 * k; P[R.BP + 1] = 0.15 * k; R.A(P, 'body', 0.4 * k, 0, 0.3 * k); },
    death(P, t, c) { const R = c.rig, p = Math.min(1, c.t / 0.9), k = p * p; R.S(P, 'wingL', 0, PI, -0.9 * k + 0.4 * (1 - k) * sin(t * 25)); R.S(P, 'wingR', 0, 0, 0.9 * k + 0.4 * (1 - k) * sin(t * 25)); P[R.BP + 1] = -(R.hoverY - 0.12) * k; R.S(P, 'body', 0.3 * k, 0.6 * k, 2.6 * k); },
  };
  // ------------------------------------------------------------------ DRAKE
  function buildDrake(fam, td) {
    const col = toHex(td.color != null ? td.color : 0x6a3a2a), dark = hexMul(col, 0.65), belly = hexLerp(col, 0xd8c090, 0.45), horn = 0xd8ccb0;
    const M = monsterMats(td, col);
    const rig = new CreatureRig(fam, (R) => {
      const leg = 0.6, r = 0.36, len = 1.3, spineY = leg + r * 0.8;
      const body = R.joint('body', 0, spineY, 0);
      const bl = []; const trunk = capsule(r, len * 0.55, 4, 14); trunk.rotateX(PI / 2); bl.push(_paint(trunk, col));
      const chest = sphere(r * 1.1, 14, 10); chest.scale(1, 1, 1.15); chest.translate(0, 0, -len * 0.3); bl.push(_paint(chest, col));
      const bel = capsule(r * 0.8, len * 0.6, 3, 12); bel.rotateX(PI / 2); bel.translate(0, -r * 0.35, 0); bl.push(_paint(bel, belly));
      for (let i = 0; i < 6; i++) { const sp = cone(r * 0.18, r * 0.5, 5); sp.rotateX(-0.4); sp.translate(0, r * 0.92, -len * 0.4 + i * len * 0.17); bl.push(_paint(sp, dark)); }
      R.add('body', body, _merge(bl), M.body, true);
      // neck (2 segs) + head + jaw
      const n1 = R.joint('neck1', 0, r * 0.4, -len * 0.45, body, -0.9);
      const nk1 = limb(r * 0.5, r * 1.1, r * 0.55, r * 0.42); nk1.rotateX(PI); R.add('neck1', n1, _paint(nk1, col), M.body, true);
      const n2 = R.joint('neck2', 0, r * 1.1, 0, n1, 0.35);
      const nk2 = limb(r * 0.42, r * 1.0, r * 0.45, r * 0.36); nk2.rotateX(PI); R.add('neck2', n2, _paint(nk2, col), M.body, true);
      const head = R.joint('head', 0, r * 1.0, 0, n2, 0.55);
      const hl = []; const sk = sphere(r * 0.5, 14, 10); sk.scale(1, 0.85, 1.2); hl.push(_paint(sk, col));
      const sn = capsule(r * 0.3, r * 0.5, 3, 10); sn.rotateX(PI / 2); sn.scale(1, 0.7, 1); sn.translate(0, -r * 0.1, -r * 0.75); hl.push(_paint(sn, col));
      for (const sd of [-1, 1]) { const h = cone(r * 0.1, r * 0.7, 6); h.rotateX(-0.9); h.rotateZ(sd * 0.35); h.translate(sd * r * 0.3, r * 0.3, r * 0.2); hl.push(_paint(h, horn)); const brow = box(r * 0.3, r * 0.08, r * 0.2); brow.rotateZ(sd * -0.3); brow.translate(sd * r * 0.25, r * 0.28, -r * 0.35); hl.push(_paint(brow, dark)); for (let k = 0; k < 3; k++) { const th = cone(r * 0.04, r * 0.14, 4); th.rotateX(PI); th.translate(sd * r * 0.2, -r * 0.3, -r * 0.6 - k * r * 0.22); hl.push(_paint(th, 0xf0ece0)); } }
      R.add('head', head, _merge(hl), M.body, true);
      R.add('face', head, creatureEyes(r * 0.09, r * 0.28, r * 0.08, -r * 0.42, 0xffb020, 2, 0), M.glow(0xffb020), false);
      const jaw = R.joint('jaw', 0, -r * 0.25, -r * 0.35, head, -0.15);
      const jg = capsule(r * 0.24, r * 0.55, 3, 8); jg.rotateX(PI / 2); jg.scale(1, 0.45, 1); jg.translate(0, 0, -r * 0.45);
      R.add('jaw', jaw, _paint(jg, col), M.body, false);
      const fire = sphere(r * 0.2, 8, 6); fire.scale(1, 0.6, 1.6); fire.translate(0, -r * 0.05, -r * 0.6);
      R.add('fire', head, fire, material(0xff7020, { emissive: 0xff5010, emissiveIntensity: 2.5 }), false); R.meshes.fire.scale.setScalar(0.35);
      // wings
      for (const sd of [-1, 1]) {
        const nm = sd < 0 ? 'L' : 'R';
        const w = R.joint('wing' + nm, sd * r * 0.7, r * 0.55, -len * 0.15, body, 0, sd < 0 ? PI : 0, 0);
        R.add('wing' + nm, w, wingGeo(1.9, 1.0, dark, hexLerp(col, 0x201010, 0.35), 4), material(0xffffff, { vertexColors: true, rough: 0.7, double: true }), true);
      }
      // legs
      const legs = [['FL', -1, -1], ['FR', 1, -1], ['BL', -1, 1], ['BR', 1, 1]];
      const upR = r * 0.4, loR = r * 0.28, upL = leg * 0.55, loL = leg * 0.45;
      for (const [nm, sx, sz] of legs) {
        const hip = R.joint('leg' + nm, sx * r * 0.7, -r * 0.2, sz * len * 0.35, body, 0, 0, sx * 0.25);
        const th = sphere(upR * 1.5, 10, 8); th.scale(1, 1.3, 1.1); th.translate(0, -upL * 0.2, 0);
        R.add('leg' + nm, hip, _merge([_paint(limb(upR, upL, upR * 1.2, upR * 0.8), col), _paint(th, col)]), M.body, true);
        const knee = R.joint('low' + nm, 0, -upL, 0, hip, 0, 0, -sx * 0.25);
        const ll = [_paint(limb(loR, loL, loR * 1.1, loR * 0.8), col)];
        for (let k = 0; k < 3; k++) { const cl = cone(loR * 0.3, loR * 0.9, 4); cl.rotateX(-PI / 2 + 0.2); cl.translate((k - 1) * loR * 0.6, -loL - loR * 0.3, -loR * 1.1); ll.push(_paint(cl, horn)); }
        const paw = sphere(loR * 1.3, 8, 6); paw.scale(1.1, 0.6, 1.2); paw.translate(0, -loL - loR * 0.2, -loR * 0.2); ll.push(_paint(paw, dark));
        R.add('low' + nm, knee, _merge(ll), M.body, false);
      }
      // tail 3 segments
      let par = body, pz = len * 0.42, py = r * 0.3;
      for (let i = 0; i < 3; i++) {
        const tj = R.joint('tail' + i, 0, py, pz, par, i === 0 ? 0.25 : 0.1);
        const tr = r * (0.55 - i * 0.14), tl = len * 0.45;
        const tg = limb(tr, tl, tr * 1.05, tr * 0.6); tg.rotateX(-PI / 2);
        const parts = [_paint(tg, col)];
        if (i === 2) { const tip = cone(tr * 1.2, tr * 3, 4); tip.rotateX(-PI / 2); tip.translate(0, 0, tl + tr * 1.2); parts.push(_paint(tip, dark)); }
        R.add('tail' + i, tj, _merge(parts), M.body, i === 0);
        par = tj; pz = tl; py = 0;
      }
      R.height = spineY + r * 3.2; R.spineY = spineY; R.Q = { r, leg };
      R.runAt = 3.2; R.attackDur = 0.9;
      R.cycleFreq = (sp, eff) => (eff === 'run' ? 1.0 + sp * 0.15 : 0.7 + sp * 0.35);
      R.anims = DRAKE_ANIMS;
      R.post = function (dt, ent, c) { const f = this.meshes.fire; if (f) { const a = this.anim === 'attack' ? 0.35 + 1.4 * Math.max(0, sin(c.phase * PI)) : 0.35 + 0.1 * sin(this.time * 7); f.scale.setScalar(a); } };
    });
    return rig;
  }
  const DRAKE_ANIMS = {
    tailWave(P, t, c, amp, rate) { const R = c.rig; for (let i = 0; i < 3; i++) R.A(P, 'tail' + i, 0.05 * sin(t * rate * 0.7 + i), amp * sin(t * rate - i * 0.9), 0); },
    wings(P, c, fold, flap) { const R = c.rig; R.S(P, 'wingL', 0.15 * fold, PI - 1.35 * fold, -0.35 * fold - flap); R.S(P, 'wingR', 0.15 * fold, 1.35 * fold, 0.35 * fold + flap); },
    idle(P, t, c) {
      const R = c.rig, b = sin(t * 1.2);
      P[R.BP + 1] = b * 0.01; R.A(P, 'body', b * 0.01, 0, 0);
      R.A(P, 'neck1', 0.06 * sin(t * 0.5), 0.1 * sin(t * 0.37), 0); R.A(P, 'neck2', 0.05 * sin(t * 0.5 + 1), 0.1 * sin(t * 0.37), 0);
      R.A(P, 'head', -0.05 + 0.05 * sin(t * 0.8), 0.25 * sin(t * 0.45) * Math.max(0, sin(t * 0.19)), 0);
      R.A(P, 'jaw', -0.05 - 0.05 * b, 0, 0);
      DRAKE_ANIMS.tailWave(P, t, c, 0.18, 1.6); DRAKE_ANIMS.wings(P, c, 1, 0.03 * b);
    },
    walk(P, t, c) {
      const R = c.rig, f = c.cycle, sp = clamp(c.speed / 2.5, 0.4, 1.2), a = 0.4 * sp;
      const ph = { FL: 0, BR: 0.15, FR: PI, BL: PI + 0.15 };
      for (const k in ph) { const s = sin(f + ph[k]), cs = cos(f + ph[k]); R.A(P, 'leg' + k, a * s, 0, 0); R.A(P, 'low' + k, -0.15 - 0.8 * sp * Math.max(0, cs), 0, 0); }
      P[R.BP + 1] = 0.012 * sp * cos(2 * f); R.A(P, 'body', 0.02 * sin(2 * f), 0.04 * sin(f), 0.03 * sin(f));
      R.A(P, 'neck1', 0.05 * cos(2 * f), 0.05 * sin(f), 0); R.A(P, 'head', -0.05, 0.05 * sin(f), 0);
      DRAKE_ANIMS.tailWave(P, t, c, 0.3, 3.0); DRAKE_ANIMS.wings(P, c, 1, 0.02 * sin(2 * f));
    },
    run(P, t, c) {
      const R = c.rig, f = c.cycle, sp = clamp(c.speed / 7, 0.6, 1.3), a = 0.8 * sp;
      R.A(P, 'legFL', a * sin(f) + 0.15, 0, 0); R.A(P, 'legFR', a * sin(f - 0.35) + 0.15, 0, 0); R.A(P, 'legBL', a * sin(f + PI * 0.85) - 0.05, 0, 0); R.A(P, 'legBR', a * sin(f + PI * 0.5) - 0.05, 0, 0);
      R.A(P, 'lowFL', -0.25 - 1.1 * sp * Math.max(0, cos(f)), 0, 0); R.A(P, 'lowFR', -0.25 - 1.1 * sp * Math.max(0, cos(f - 0.35)), 0, 0); R.A(P, 'lowBL', -0.2 - 1.0 * sp * Math.max(0, cos(f + PI * 0.85)), 0, 0); R.A(P, 'lowBR', -0.2 - 1.0 * sp * Math.max(0, cos(f + PI * 0.5)), 0, 0);
      P[R.BP + 1] = 0.05 * sp * Math.max(0, sin(f + 0.5)); R.A(P, 'body', 0.12 * sp * sin(f + 0.3), 0, 0);
      R.A(P, 'neck1', 0.3, 0, 0); R.A(P, 'neck2', -0.1, 0, 0); R.A(P, 'head', -0.25 - 0.05 * sin(f), 0, 0); R.A(P, 'jaw', -0.3, 0, 0);
      DRAKE_ANIMS.tailWave(P, t, c, 0.25, 5.0); DRAKE_ANIMS.wings(P, c, 0.35, 0.35 * sin(f) - 0.1);
    },
    attack(P, t, c) {
      const R = c.rig, p = c.phase, rear = p < 0.35 ? easeOut(p / 0.35) : p < 0.55 ? 1 - ease((p - 0.35) / 0.2) : 0, strike = p < 0.35 ? 0 : p < 0.55 ? ease((p - 0.35) / 0.2) : 1 - ease((p - 0.55) / 0.45);
      R.A(P, 'neck1', 0.6 * rear - 0.5 * strike, 0, 0); R.A(P, 'neck2', 0.4 * rear - 0.45 * strike, 0, 0); R.A(P, 'head', -0.2 * rear - 0.35 * strike, 0, 0);
      R.S(P, 'jaw', -0.4 * rear - 0.9 * strike - 0.15, 0, 0);
      R.A(P, 'body', 0.12 * rear - 0.08 * strike, 0, 0); P[R.BP + 2] = 0.1 * rear - 0.3 * strike; P[R.BP + 1] = 0.08 * rear;
      R.A(P, 'legFL', 0.5 * rear + 0.2 * strike, 0, 0); R.A(P, 'legFR', 0.4 * rear + 0.3 * strike, 0, 0); R.A(P, 'lowFL', -0.6 * rear, 0, 0); R.A(P, 'lowFR', -0.5 * rear, 0, 0);
      DRAKE_ANIMS.wings(P, c, 1 - 0.8 * Math.max(rear, strike), 0.25 * sin(t * 12) * Math.max(rear, strike)); DRAKE_ANIMS.tailWave(P, t, c, 0.35, 4);
    },
    hit(P, t, c) { const R = c.rig, k = sin(c.phase * PI); P[R.BP + 2] = 0.12 * k; R.A(P, 'body', -0.06 * k, 0, 0.05 * k); R.A(P, 'neck1', 0.3 * k, 0.2 * k, 0); R.A(P, 'head', 0.3 * k, 0, 0); R.S(P, 'jaw', -0.4 * k - 0.15, 0, 0); DRAKE_ANIMS.wings(P, c, 1 - 0.4 * k, 0.3 * k); },
    death(P, t, c) {
      const R = c.rig, p = Math.min(1, c.t / 1.0), k = p * p * (3 - 2 * p);
      R.S(P, 'body', 0.05 * k, 0, 1.4 * k); P[R.BP + 1] = -(R.spineY - R.Q.r * 0.95) * k;
      R.A(P, 'neck1', -0.5 * k, 0.3 * k, 0); R.A(P, 'neck2', -0.4 * k, 0, 0); R.A(P, 'head', -0.3 * k, 0.4 * k, 0); R.S(P, 'jaw', -0.4 * k - 0.15, 0, 0);
      for (const nm of ['FL', 'FR', 'BL', 'BR']) { R.A(P, 'leg' + nm, (nm[0] === 'F' ? 0.5 : -0.2) * k, 0, 0); R.A(P, 'low' + nm, -0.6 * k, 0, 0); }
      DRAKE_ANIMS.wings(P, c, 0.5, 0.4 * k); for (let i = 0; i < 3; i++) R.A(P, 'tail' + i, 0, 0.3 * k, 0);
    },
  };
  // ------------------------------------------------------------------ SLUG
  function buildSlug(fam, td) {
    const col = toHex(td.color != null ? td.color : 0x7a8a3a), dark = hexMul(col, 0.7), light = hexLerp(col, 0xffffdd, 0.3);
    const M = monsterMats(td, col);
    const rig = new CreatureRig(fam, (R) => {
      const radii = [0.3, 0.32, 0.29, 0.25, 0.19, 0.13];
      let par = R.body, z = 0;
      for (let i = 0; i < radii.length; i++) {
        const r = radii[i];
        const j = R.joint('seg' + i, 0, i === 0 ? r * 0.95 : 0, z, par);
        const g = sphere(r, 14, 10); g.scale(1, 0.9, 1.15);
        const under = sphere(r * 0.9, 10, 8); under.scale(1.05, 0.5, 1.2); under.translate(0, -r * 0.45, 0);
        const parts = [_paint(g, i === 0 ? col : hexLerp(col, dark, i / 6)), _paint(under, light)];
        if (i > 0 && i < 4) { for (let k = 0; k < 3; k++) { const sp = sphere(r * 0.18, 6, 5); sp.scale(1, 0.5, 1); sp.translate((k - 1) * r * 0.45, r * 0.85, 0); parts.push(_paint(sp, dark)); } }
        R.add('seg' + i, j, _merge(parts), M.shiny, i < 3);
        par = j; z = r * 1.0 + (radii[i + 1] || 0) * 0.9;
      }
      const head = R.parts.seg0;
      for (const sd of [-1, 1]) {
        const st = R.joint('stalk' + (sd < 0 ? 'L' : 'R'), sd * 0.12, 0.22, -0.12, head, -0.5, 0, sd * -0.35);
        const s = capsule(0.025, 0.28, 3, 6); s.translate(0, 0.14, 0);
        const eye = sphere(0.05, 8, 6); eye.translate(0, 0.3, 0);
        R.add('stalk' + (sd < 0 ? 'L' : 'R'), st, _merge([_paint(s, col), _paint(eye, col)]), M.shiny, false);
        const pupil = sphere(0.028, 6, 5); pupil.translate(0, 0.3, -0.035);
        R.add('eye' + (sd < 0 ? 'L' : 'R'), st, _paint(pupil, 0x101010), M.face, false);
      }
      const mouth = sphere(0.08, 8, 6); mouth.scale(1.3, 0.5, 0.6); mouth.translate(0, -0.1, -0.3);
      R.add('mouth', head, _paint(mouth, 0x3a2a30), M.face, false);
      R.height = 0.75; R.runAt = 1.8; R.attackDur = 0.8;
      R.cycleFreq = (sp) => 1.0 + sp * 0.6;
      R.anims = SLUG_ANIMS;
      R.post = function (dt, ent, c) {
        const t = this.time, dead = this.anim === 'death' ? Math.min(1, c.t / 1.0) : 0;
        const rate = this.anim === 'walk' || this.anim === 'run' ? 5 : 2.2;
        for (let i = 0; i < 6; i++) { const s = this.parts['seg' + i]; const w = 1 + 0.07 * sin(t * rate - i * 0.9); s.scale.set(1 / Math.sqrt(w), w * (1 - 0.55 * dead), 1 / Math.sqrt(w) * (1 + 0.2 * dead)); }
      };
    });
    return rig;
  }
  const SLUG_ANIMS = {
    idle(P, t, c) { const R = c.rig; R.A(P, 'seg0', 0.05 * sin(t * 1.1), 0.08 * sin(t * 0.6), 0); for (let i = 1; i < 6; i++) R.A(P, 'seg' + i, 0, 0.05 * sin(t * 0.8 - i * 0.7), 0); R.A(P, 'stalkL', 0.1 * sin(t * 1.3), 0, 0.1 * sin(t * 0.9)); R.A(P, 'stalkR', 0.1 * sin(t * 1.2 + 1), 0, -0.1 * sin(t * 0.8)); },
    walk(P, t, c) { const R = c.rig, f = c.cycle; R.A(P, 'seg0', 0.1 * sin(f), 0, 0); for (let i = 1; i < 6; i++) R.A(P, 'seg' + i, 0.06 * sin(f - i * 0.9), 0.08 * sin(f * 0.5 - i * 0.6), 0); P[R.BP + 1] = 0.01 * sin(2 * f); R.A(P, 'stalkL', 0.15 * sin(f), 0, 0); R.A(P, 'stalkR', 0.15 * sin(f + 1), 0, 0); },
    run(P, t, c) { SLUG_ANIMS.walk(P, t, c); },
    attack(P, t, c) { const R = c.rig, p = c.phase, rear = p < 0.4 ? easeOut(p / 0.4) : p < 0.6 ? 1 - ease((p - 0.4) / 0.2) : 0, slam = p < 0.4 ? 0 : p < 0.6 ? ease((p - 0.4) / 0.2) : 1 - ease((p - 0.6) / 0.4); R.A(P, 'seg0', 0.9 * rear - 0.35 * slam, 0, 0); R.A(P, 'seg1', 0.3 * rear, 0, 0); P[R.BP + 1] = 0.12 * rear; P[R.BP + 2] = -0.2 * slam; R.A(P, 'stalkL', 0.5 * rear, 0, 0); R.A(P, 'stalkR', 0.5 * rear, 0, 0); },
    hit(P, t, c) { const R = c.rig, k = sin(c.phase * PI); P[R.BP + 2] = 0.1 * k; R.A(P, 'seg0', 0.25 * k, 0, 0); R.A(P, 'stalkL', -0.8 * k, 0, 0.3 * k); R.A(P, 'stalkR', -0.8 * k, 0, -0.3 * k); },
    death(P, t, c) { const R = c.rig, p = Math.min(1, c.t / 1.0), k = p * p * (3 - 2 * p); R.A(P, 'seg0', -0.1 * k, 0, 0.15 * k); R.A(P, 'stalkL', -1.2 * k, 0, 0.8 * k); R.A(P, 'stalkR', -1.2 * k, 0, -0.8 * k); P[R.BP + 1] = -0.12 * k; },
  };
  // ------------------------------------------------------------------ SEA SERPENT
  function buildSerpent(fam, td) {
    const col = toHex(td.color != null ? td.color : 0x2a7a7a), dark = hexMul(col, 0.6), belly = hexLerp(col, 0xe0e8d0, 0.5), fin = hexLerp(col, 0x103040, 0.4);
    const M = monsterMats(td, col);
    const rig = new CreatureRig(fam, (R) => {
      const n = 9, r0 = 0.5;
      // head first
      const head = R.joint('head', 0, 1.5, 0);
      const hl = []; const sk = sphere(r0 * 1.1, 14, 10); sk.scale(1, 0.85, 1.4); hl.push(_paint(sk, col));
      const sn = capsule(r0 * 0.6, r0 * 0.9, 3, 10); sn.rotateX(PI / 2); sn.scale(1, 0.7, 1); sn.translate(0, -r0 * 0.15, -r0 * 1.4); hl.push(_paint(sn, col));
      const crest = extrude(shapeFrom([[0, 0], [0.3, 0.9], [0.6, 0.7], [0.9, 1.1], [1.2, 0.5], [1.6, 0.4], [1.6, 0]]), 0.03, 0); crest.rotateY(-PI / 2); crest.scale(1, r0 * 0.9, 1); crest.translate(0, r0 * 0.6, r0 * 0.9); hl.push(_paint(crest, fin));
      for (const sd of [-1, 1]) { const f = extrude(shapeFrom([[0, 0], [0.8, 0.5], [1.4, 0.2], [1.0, -0.3]]), 0.03, 0); f.scale(r0 * 0.8, r0 * 0.8, 1); f.rotateY(sd < 0 ? PI * 0.35 : -PI * 0.35); f.rotateZ(sd * -0.3); f.translate(sd * r0 * 0.9, -r0 * 0.1, r0 * 0.3); hl.push(_paint(f, fin)); for (let k = 0; k < 4; k++) { const th = cone(r0 * 0.05, r0 * 0.2, 4); th.rotateX(PI); th.translate(sd * r0 * 0.35, -r0 * 0.5, -r0 * 0.9 - k * r0 * 0.3); hl.push(_paint(th, 0xf0ece0)); } }
      R.add('head', head, _merge(hl), M.shiny, true);
      R.add('face', head, creatureEyes(r0 * 0.14, r0 * 0.5, r0 * 0.25, -r0 * 0.8, 0xc0f040, 2, 0), M.glow(0xc0f040), false);
      const jaw = R.joint('jaw', 0, -r0 * 0.35, -r0 * 0.6, head, -0.1);
      const jg = capsule(r0 * 0.45, r0 * 0.9, 3, 8); jg.rotateX(PI / 2); jg.scale(1, 0.4, 1); jg.translate(0, 0, -r0 * 0.7); R.add('jaw', jaw, _paint(jg, belly), M.shiny, false);
      let par = head, z = r0 * 1.5;
      for (let i = 0; i < n; i++) {
        const r = r0 * (1 - i / n * 0.75) * (i === 0 ? 0.9 : 1);
        const j = R.joint('seg' + i, 0, 0, z, par);
        const g = sphere(r, 12, 9); g.scale(1, 1, 1.3);
        const un = sphere(r * 0.9, 10, 8); un.scale(0.9, 0.6, 1.3); un.translate(0, -r * 0.4, 0);
        const parts = [_paint(g, hexLerp(col, dark, i / n)), _paint(un, belly)];
        const fn = extrude(shapeFrom([[-0.5, 0], [-0.2, 1], [0.35, 0.8], [0.6, 0]]), 0.03, 0); fn.rotateY(-PI / 2); fn.scale(1, r * 0.9, r * 1.1); fn.translate(0, r * 0.85, 0); parts.push(_paint(fn, fin));
        if (i === n - 1) { const fl = extrude(shapeFrom([[0, 0], [0.8, 0.9], [1.6, 0.3], [1.6, -0.3], [0.8, -0.9]]), 0.03, 0); fl.rotateY(-PI / 2); fl.scale(1, r * 1.5, r * 1.5); fl.translate(0, 0, r * 1.2); parts.push(_paint(fl, fin)); }
        R.add('seg' + i, j, _merge(parts), M.shiny, i < 4);
        par = j; z = (r + r0 * (1 - (i + 1) / n * 0.75)) * 0.95;
      }
      R.height = 2.6; R.n = n; R.runAt = 2.5; R.attackDur = 1.0;
      R.cycleFreq = (sp) => 0.5 + sp * 0.25;
      R.anims = SERPENT_ANIMS;
    });
    return rig;
  }
  const SERPENT_ANIMS = {
    wave(P, t, c, amp, rate, k) {
      const R = c.rig, n = R.n;
      // vertical undulation: cumulative rotation.x along the chain; head kept level
      let sum = 0;
      for (let i = 0; i < n; i++) { const a = amp * sin(t * rate - i * k) * (i < 2 ? 0.5 : 1); R.A(P, 'seg' + i, a, 0.15 * amp * sin(t * rate * 0.5 - i * k), 0); sum += a; }
      R.A(P, 'head', -0.35 + 0.3 * sin(t * rate), 0, 0);
    },
    idle(P, t, c) { const R = c.rig; SERPENT_ANIMS.wave(P, t, c, 0.3, 1.3, 0.8); P[R.BP + 1] = 0.12 * sin(t * 1.3); R.A(P, 'head', 0.05 * sin(t * 0.7), 0.3 * sin(t * 0.4), 0.06 * sin(t * 0.9)); R.A(P, 'jaw', -0.05 - 0.05 * sin(t * 1.3), 0, 0); },
    walk(P, t, c) { const R = c.rig; SERPENT_ANIMS.wave(P, t, c, 0.3, 3.0, 0.8); P[R.BP + 1] = 0.15 * sin(t * 3.0); R.A(P, 'head', -0.05, 0.1 * sin(t * 1.5), 0); },
    run(P, t, c) { const R = c.rig; SERPENT_ANIMS.wave(P, t, c, 0.35, 4.5, 0.85); P[R.BP + 1] = 0.18 * sin(t * 4.5); R.A(P, 'head', -0.15, 0, 0); R.A(P, 'jaw', -0.3, 0, 0); },
    attack(P, t, c) { const R = c.rig, p = c.phase, rear = p < 0.4 ? easeOut(p / 0.4) : p < 0.6 ? 1 - ease((p - 0.4) / 0.2) : 0, strike = p < 0.4 ? 0 : p < 0.6 ? ease((p - 0.4) / 0.2) : 1 - ease((p - 0.6) / 0.4); SERPENT_ANIMS.wave(P, t, c, 0.2, 2.0, 0.75); R.A(P, 'head', 0.9 * rear - 0.8 * strike, 0, 0); R.A(P, 'seg0', 0.4 * rear - 0.3 * strike, 0, 0); R.A(P, 'seg1', 0.3 * rear, 0, 0); P[R.BP + 1] = 0.7 * rear + 0.1 * strike; P[R.BP + 2] = 0.2 * rear - 0.6 * strike; R.S(P, 'jaw', -0.5 * rear - 0.9 * strike - 0.1, 0, 0); },
    hit(P, t, c) { const R = c.rig, k = sin(c.phase * PI); SERPENT_ANIMS.wave(P, t, c, 0.25, 2, 0.75); R.A(P, 'head', 0.5 * k, 0.3 * k, 0.2 * k); P[R.BP + 2] = 0.2 * k; R.S(P, 'jaw', -0.5 * k - 0.1, 0, 0); },
    death(P, t, c) { const R = c.rig, p = Math.min(1, c.t / 2.0), k = p * p; SERPENT_ANIMS.wave(P, t, c, 0.2 * (1 - k), 1.5, 0.75); R.A(P, 'head', -0.6 * k, 0.4 * k, 0.6 * k); P[R.BP + 1] = -2.2 * k; R.S(P, 'jaw', -0.4 * k - 0.1, 0, 0); },
  };

  // ------------------------------------------------------------------ buildMonster
  const HUMANOID_FAMILIES = { goblin: 1, orc: 1, uruk: 1, brigand: 1, sorcerer: 1, troll: 1, giant: 1, wight: 1 };
  const NATURAL_H = { troll: 2.2, giant: 3.0, uruk: 1.22, drake: 2.0, 'sea-serpent': 2.5, bear: 1.5, 'lossoth-bear': 1.6, warg: 1.25 };
  function monsterScale(fam, td) {
    let size = td.size != null ? +td.size : 1; if (!(size > 0)) size = 1;
    const nat = NATURAL_H[fam];
    let sc = (nat && size > 1.6) ? size / nat : size;
    if (td.boss) sc *= 1.3; else if (td.elite) sc *= 1.12;
    return clamp(sc, 0.3, 4);
  }
  function humanoidMonsterSpec(fam, td) {
    const col = toHex(td.color != null ? td.color : 0x808080);
    const dark = hexMul(col, 0.55), seed = hashStr(td.id || td.name || fam);
    const pick = (arr) => arr[seed % arr.length];
    const spec = { race: fam, gender: 'male', monster: true, name: td.name, skin: hexLerp(DEFAULT_SKIN[fam] || 0x888888, col, 0.5), hairStyle: 5, beard: 0, faceOpts: {}, look: {}, equipment: {}, buildScale: 1 };
    const L = spec.look;
    switch (fam) {
      case 'goblin': spec.faceOpts = { eye: 0xe0c020, angry: true, eyeScale: 1.25, brow: 0x2a2a1a }; L.chest = { type: 'medium', color: hexLerp(0x5a4a2a, col, 0.3), style: 'leather' }; L.legs = { type: 'light', color: 0x3a2f1c }; L.mainhand = { shape: pick(['dagger', 'sword', 'axe']), color: 0x7a6a50 }; if (seed % 3 === 0) L.offhand = { shape: 'shield', color: 0x5a4a30 }; if (seed % 4 === 1) L.head = { type: 'light', color: 0x3a2f1c, style: 'bandana' }; break;
      case 'orc': spec.faceOpts = { eye: 0xd03020, angry: true, tusks: true, brow: 0x1a1a1a }; L.chest = { type: 'heavy', color: hexLerp(0x4a4642, col, 0.25) }; L.legs = { type: 'medium', color: 0x2a2624 }; L.shoulder = { type: 'heavy', color: 0x3a3634 }; L.mainhand = { shape: pick(['axe', 'sword', 'mace']), color: 0x6a6660 }; if (seed % 2) L.head = { type: 'heavy', color: 0x3a3634, style: 'helm' }; if (seed % 3 === 0) L.offhand = { shape: 'shield', color: 0x3a3634 }; L.feet = { type: 'heavy', color: 0x2a2624 }; break;
      case 'uruk': spec.faceOpts = { eye: 0xe0d040, angry: true, tusks: true, brow: 0x0a0a0a }; L.chest = { type: 'heavy', color: 0x26242a }; L.legs = { type: 'heavy', color: 0x1e1c20 }; L.shoulder = { type: 'heavy', color: 0x1e1c20 }; L.head = { type: 'heavy', color: 0x26242a, style: 'helm' }; L.hands = { type: 'heavy', color: 0x1e1c20 }; L.feet = { type: 'heavy', color: 0x1e1c20 }; L.mainhand = { shape: pick(['greatsword', 'axe', 'halberd']), color: 0x5a5a60 }; if (seed % 2) L.offhand = { shape: 'shield', color: 0x1e1c20 }; break;
      case 'brigand': spec.skin = DEFAULT_SKIN.brigand; spec.hairStyle = seed % 2 ? 0 : 5; spec.faceOpts = { eye: 0x3a3a3a, angry: true, mask: 0x2a2020 }; L.chest = { type: 'medium', color: hexLerp(0x5a4632, col, 0.4) }; L.legs = { type: 'light', color: 0x3a2f24 }; L.head = { type: 'light', color: hexLerp(0x3a3028, col, 0.3), style: seed % 2 ? 'hood' : 'bandana' }; L.mainhand = { shape: pick(['dagger', 'sword', 'mace']), color: null }; if (seed % 2) L.ranged = { shape: 'bow', color: null }; L.feet = { type: 'medium', color: 0x2a2018 }; break;
      case 'sorcerer': spec.skin = 0xd8c8b8; spec.beard = 1; spec.hairStyle = 5; spec.robe = true; spec.faceOpts = { eye: 0x9a40ff, angry: true, glowEyes: 0x9a40ff }; L.chest = { type: 'light', color: hexLerp(0x2c1f3a, col, 0.4), style: 'robe' }; L.legs = { type: 'light', color: hexLerp(0x1c1426, col, 0.3), style: 'robe' }; L.head = { type: 'light', color: hexLerp(0x2c1f3a, col, 0.4), style: 'hood' }; L.mainhand = { shape: 'staff', color: 0x3a2a4a, glow: 0x9a40ff }; L.back = { type: 'light', color: hexLerp(0x1c1426, col, 0.3) }; break;
      case 'troll': spec.faceOpts = { eye: 0xe0b040, angry: true, eyeScale: 0.8, brow: 0x3a3a30, mouth: 0x3a2a28 }; spec.skin = hexLerp(0x7a7468, col, 0.5); L.chest = { type: 'stone', color: spec.skin, style: 'bare' }; L.legs = { type: 'medium', color: 0x5a4a38, style: 'kilt' }; L.mainhand = { shape: 'club', color: 0x4a3a28 }; spec.weaponScale = 1.5; break;
      case 'giant': spec.beard = 1; spec.hairStyle = 4; spec.faceOpts = { eye: 0x80c0e0, angry: true, eyeScale: 0.9, brow: 0xd8d8d8 }; spec.hairColor = 0xd8d8d0; spec.skin = hexLerp(0x9a9080, col, 0.5); L.chest = { type: 'medium', color: hexLerp(0x6a6258, col, 0.3), style: 'fur' }; L.legs = { type: 'medium', color: 0x4a4238, style: 'kilt' }; L.mainhand = { shape: pick(['club', 'hammer']), color: 0x5a5048 }; spec.weaponScale = 1.5; break;
      case 'wight': spec.faceOpts = { eye: 0x60d0ff, glowEyes: 0x60d0ff, brow: 0x3a4048, mouth: 0x2a3038, white: 0x9aa0a8 }; spec.skin = hexLerp(0xa7b0b8, col, 0.4); spec.robe = true; spec.hover = true; L.chest = { type: 'light', color: hexLerp(0x2a3038, col, 0.3), style: 'robe' }; L.legs = { type: 'light', color: hexLerp(0x1e2428, col, 0.3), style: 'ragged' }; L.head = { type: 'light', color: 0x8a7a40, style: 'crown' }; L.mainhand = { shape: 'sword', color: 0x6a5a4a, glow: 0x40a0d0 }; L.back = { type: 'light', color: hexLerp(0x1e2428, col, 0.2) }; break;
    }
    if (td.boss) { spec.faceOpts.glowEyes = spec.faceOpts.glowEyes || 0xff4020; if (L.mainhand) L.mainhand.glow = L.mainhand.glow || 0xff4020; }
    else if (td.elite && L.mainhand) L.mainhand.glow = L.mainhand.glow || hexLerp(col, 0xffffff, 0.3);
    return spec;
  }
  function buildMonster(td) {
    td = td || {};
    const fam = td.family || 'wolf';
    let rig;
    try {
      if (HUMANOID_FAMILIES[fam]) {
        rig = new HumanoidRig(humanoidMonsterSpec(fam, td));
        rig.kind = 'monster'; _humanoidCount--; _monsterCount++;
      } else if (QUAD[fam]) rig = buildQuadruped(fam, td);
      else if (fam === 'spider' || fam === 'crawler') rig = buildSpider(fam, td);
      else if (fam === 'bat') rig = buildBat(fam, td);
      else if (fam === 'drake') rig = buildDrake(fam, td);
      else if (fam === 'slug') rig = buildSlug(fam, td);
      else if (fam === 'sea-serpent' || fam === 'serpent') rig = buildSerpent(fam, td);
      else rig = buildQuadruped('wolf', td);
    } catch (e) { if (G.reportError) G.reportError(e, 'buildMonster ' + fam); rig = buildQuadruped('wolf', td); }
    const sc = monsterScale(fam, td);
    rig.group.scale.setScalar(sc); rig.height *= sc; rig.scale = sc; rig.typeData = td; rig.family = fam;
    if (td.name && td.nameplate) { rig.nameplate = nameplate(td.name, td.boss ? '#ff9c3a' : td.elite ? '#c48bff' : '#ff6a6a', { sub: td.level ? 'Level ' + (Array.isArray(td.level) ? td.level[0] : td.level) : '' }); rig.nameplate.position.y = rig.height / sc + 0.15; rig.group.add(rig.nameplate); }
    return rig;
  }

  // ================================================================== HORSE
  function buildHorse(color) {
    const col = toHex(color != null ? color : 0x6b4a2e), dark = hexMul(col, 0.55), mane = hexLerp(dark, 0x1a1210, 0.5), hoof = 0x2a2420;
    const seed = hashStr('horse' + col);
    const blaze = (seed % 3) !== 0, socks = (seed % 2) === 0;
    const rig = new CreatureRig('horse', (R) => {
      const leg = 0.98, r = 0.34, len = 1.15, spineY = leg + r * 0.72;
      const body = R.joint('body', 0, spineY, 0);
      const bl = [];
      const trunk = capsule(r, len * 0.55, 4, 16); trunk.rotateX(PI / 2); trunk.scale(1, 1.02, 1); bl.push(_paint(trunk, col));
      const chest = sphere(r * 1.08, 14, 10); chest.scale(1, 1.1, 1.15); chest.translate(0, -r * 0.05, -len * 0.3); bl.push(_paint(chest, col));
      const rump = sphere(r * 1.05, 14, 10); rump.scale(1.02, 1.05, 1.2); rump.translate(0, r * 0.05, len * 0.3); bl.push(_paint(rump, col));
      const withers = sphere(r * 0.7, 10, 8); withers.scale(0.9, 0.8, 1.2); withers.translate(0, r * 0.55, -len * 0.3); bl.push(_paint(withers, col));
      R.add('body', body, _merge(bl), MAT_VC(0.7, 0.02), true);
      // neck
      const neck = R.joint('neck', 0, r * 0.45, -len * 0.42, body, -0.95);
      const nl = []; const nk = limb(r * 0.5, r * 2.0, r * 0.72, r * 0.42); nk.rotateX(PI); nl.push(_paint(nk, col));
      for (let i = 0; i < 7; i++) { const m = sphere(r * 0.2, 8, 6); m.scale(0.55, 1, 1.1); m.translate(0, r * 0.35 + i * r * 0.27, r * 0.28 - i * r * 0.03); nl.push(_paint(m, mane)); }
      R.add('neck', neck, _merge(nl), MAT_VC(0.7, 0.02), true);
      // head
      const head = R.joint('head', 0, r * 2.05, 0, neck, 1.05);
      const hl = []; const sk = sphere(r * 0.5, 14, 10); sk.scale(0.9, 1, 1.1); hl.push(_paint(sk, col));
      const mz = capsule(r * 0.33, r * 0.6, 3, 10); mz.rotateX(PI / 2 - 0.35); mz.scale(0.95, 0.9, 1); mz.translate(0, -r * 0.35, -r * 0.65); hl.push(_paint(mz, col));
      const nose = sphere(r * 0.31, 10, 8); nose.scale(1, 0.8, 0.8); nose.translate(0, -r * 0.5, -r * 1.05); hl.push(_paint(nose, hexMul(col, 0.8)));
      if (blaze) { const b = box(r * 0.14, r * 1.1, r * 0.1); b.rotateX(-0.35); b.translate(0, -r * 0.05, -r * 0.62); hl.push(_paint(b, 0xf0ece4)); }
      for (const sd of [-1, 1]) { const e = cone(r * 0.11, r * 0.42, 6); e.scale(0.7, 1, 1); e.rotateZ(sd * -0.3); e.rotateX(-0.2); e.translate(sd * r * 0.22, r * 0.58, r * 0.05); hl.push(_paint(e, col)); const nos = sphere(r * 0.07, 6, 5); nos.translate(sd * r * 0.14, -r * 0.45, -r * 1.3); hl.push(_paint(nos, 0x2a2020)); }
      const fl = sphere(r * 0.22, 8, 6); fl.scale(0.7, 0.6, 1); fl.translate(0, r * 0.4, -r * 0.2); hl.push(_paint(fl, mane));
      // bridle
      const br1 = new THREE.TorusGeometry(r * 0.42, r * 0.02, 5, 16); br1.rotateX(PI / 2 - 0.3); br1.translate(0, -r * 0.35, -r * 0.55); hl.push(_paint(br1, 0x3a2a1a));
      const br2 = new THREE.TorusGeometry(r * 0.46, r * 0.02, 5, 16); br2.rotateX(PI / 2); br2.translate(0, r * 0.05, r * 0.02); hl.push(_paint(br2, 0x3a2a1a));
      R.add('head', head, _merge(hl), MAT_VC(0.7, 0.02), true);
      R.add('face', head, creatureEyes(r * 0.09, r * 0.34, r * 0.12, -r * 0.3, 0x201810, 2, 0), MAT_FACE(), false);
      // tail
      const tail = R.joint('tail', 0, r * 0.55, len * 0.55, body, -0.55);
      const tg = limb(r * 0.16, r * 2.2, r * 0.2, r * 0.08); const tg2 = capsule(r * 0.14, r * 1.4, 3, 8); tg2.translate(0, -r * 1.2, r * 0.05);
      R.add('tail', tail, _merge([_paint(tg, mane), _paint(tg2, mane)]), MAT_VC(0.8, 0), false);
      // legs
      const legs = [['FL', -1, -1], ['FR', 1, -1], ['BL', -1, 1], ['BR', 1, 1]];
      const upL = leg * 0.5, loL = leg * 0.42, hoofH = leg * 0.08;
      for (const [nm, sx, sz] of legs) {
        const hind = sz > 0;
        const hip = R.joint('leg' + nm, sx * r * 0.5, -r * 0.35, sz * len * 0.38, body, hind ? 0.18 : 0.02);
        const ul = [_paint(limb(r * 0.24, upL, r * 0.3, r * 0.17), col)];
        if (hind) { const th = sphere(r * 0.42, 10, 8); th.scale(0.8, 1.2, 1.1); th.translate(0, -upL * 0.1, r * 0.05); ul.push(_paint(th, col)); }
        R.add('leg' + nm, hip, _merge(ul), MAT_VC(0.7, 0.02), true);
        const knee = R.joint('low' + nm, 0, -upL, 0, hip, hind ? -0.36 : -0.04);
        const ll = [_paint(limb(r * 0.15, loL, r * 0.17, r * 0.12), socks && hind ? 0xe8e4dc : col)];
        const hf = cyl(r * 0.16, r * 0.19, hoofH, 10); hf.translate(0, -loL - hoofH * 0.4, -r * 0.02); ll.push(_paint(hf, hoof));
        R.add('low' + nm, knee, _merge(ll), MAT_VC(0.6, 0.05), false);
      }
      // saddle
      const saddle = R.joint('saddle', 0, r * 0.98, -len * 0.02, body);
      const sl = [];
      const blanket = box(r * 2.3, r * 0.12, r * 1.7); blanket.translate(0, -r * 0.25, 0); sl.push(_paint(blanket, hexLerp(0x8a2a2a, col, 0.15)));
      const seat = sphere(r * 0.75, 14, 10, 0, TAU, 0, PI * 0.5); seat.scale(1.0, 0.35, 1.4); seat.translate(0, -r * 0.2, 0); sl.push(_paint(seat, 0x5a3a22));
      const pommel = sphere(r * 0.2, 8, 6); pommel.translate(0, r * 0.05, -r * 0.85); sl.push(_paint(pommel, 0x4a2e1a));
      const cantle = sphere(r * 0.3, 8, 6); cantle.scale(1.3, 0.8, 0.6); cantle.translate(0, r * 0.02, r * 0.8); sl.push(_paint(cantle, 0x4a2e1a));
      for (const sd of [-1, 1]) { const flap = box(r * 0.08, r * 0.9, r * 1.0); flap.translate(sd * r * 1.02, -r * 0.6, 0); sl.push(_paint(flap, 0x5a3a22)); const strap = box(r * 0.03, r * 1.2, r * 0.12); strap.translate(sd * r * 1.06, -r * 1.05, -r * 0.1); sl.push(_paint(strap, 0x3a2a1a)); const st = new THREE.TorusGeometry(r * 0.16, r * 0.03, 5, 12); st.rotateY(PI / 2); st.translate(sd * r * 1.08, -r * 1.7, -r * 0.1); sl.push(_paint(st, 0x8a8a90)); }
      const girth = cyl(r * 1.06, r * 1.06, r * 0.18, 16, 1, true); girth.translate(0, -r * 0.7, 0); sl.push(_paint(girth, 0x3a2a1a));
      R.add('saddle', saddle, _merge(sl), MAT_VC(0.65, 0.05), false);
      R.parts.saddle = saddle;
      R.height = spineY + r * 2.5; R.spineY = spineY; R.Q = { r, leg };
      R.runAt = 5.0; R.attackDur = 0.6;
      R.cycleFreq = (sp, eff) => eff === 'run' ? 1.1 + sp * 0.09 : 0.6 + sp * 0.35;
      R.anims = HORSE_ANIMS;
    });
    rig.kind = 'horse'; _monsterCount--; _horseCount++;
    rig.dispose = function () { CP.dispose.call(this); _monsterCount++; _horseCount--; };
    return rig;
  }
  const HORSE_ANIMS = {
    idle(P, t, c) {
      const R = c.rig, b = sin(t * 1.1);
      P[R.BP + 1] = b * 0.006; R.A(P, 'body', b * 0.006, 0, 0);
      R.A(P, 'neck', 0.08 * sin(t * 0.4) * Math.max(0, sin(t * 0.17)), 0.12 * sin(t * 0.3), 0);
      R.A(P, 'head', 0.06 * sin(t * 0.7), 0.25 * sin(t * 0.45) * Math.max(0, sin(t * 0.21)), 0.03 * sin(t * 0.9));
      R.A(P, 'tail', 0.05 * sin(t * 0.8), 0, 0.3 * sin(t * 2.2) * (0.5 + 0.5 * sin(t * 0.37)));
      const paw = Math.max(0, sin(t * 0.29)) > 0.985 ? 1 : 0; R.A(P, 'legFL', 0.4 * paw, 0, 0); R.A(P, 'lowFL', -0.7 * paw, 0, 0);
    },
    walk(P, t, c) {
      const R = c.rig, f = c.cycle, sp = clamp(c.speed / 2.5, 0.4, 1.3), a = 0.38 * sp;
      const ph = { BL: 0, FL: PI * 0.5, BR: PI, FR: PI * 1.5 };
      for (const k in ph) { const s = sin(f + ph[k]), cs = cos(f + ph[k]); R.A(P, 'leg' + k, a * s, 0, 0); R.A(P, 'low' + k, -0.1 - 0.75 * sp * Math.max(0, cs), 0, 0); }
      P[R.BP + 1] = 0.012 * sp * cos(2 * f); R.A(P, 'body', 0.015 * sin(2 * f), 0.02 * sin(f), 0.025 * sin(f));
      R.A(P, 'neck', 0.06 * cos(2 * f) + 0.05, 0, 0); R.A(P, 'head', -0.06 * cos(2 * f), 0.03 * sin(f), 0);
      R.A(P, 'tail', 0.1, 0, 0.15 * sin(f));
    },
    run(P, t, c) {
      const R = c.rig, f = c.cycle, sp = clamp(c.speed / 15, 0.55, 1.2), a = 0.75 * sp;
      R.A(P, 'legFL', a * sin(f) + 0.2, 0, 0); R.A(P, 'legFR', a * sin(f - 0.45) + 0.2, 0, 0);
      R.A(P, 'legBL', a * sin(f + PI * 0.9) - 0.1, 0, 0); R.A(P, 'legBR', a * sin(f + PI * 0.9 - 0.45) - 0.1, 0, 0);
      R.A(P, 'lowFL', -0.2 - 1.2 * sp * Math.max(0, cos(f)), 0, 0); R.A(P, 'lowFR', -0.2 - 1.2 * sp * Math.max(0, cos(f - 0.45)), 0, 0);
      R.A(P, 'lowBL', -0.1 - 1.0 * sp * Math.max(0, cos(f + PI * 0.9)), 0, 0); R.A(P, 'lowBR', -0.1 - 1.0 * sp * Math.max(0, cos(f + PI * 0.9 - 0.45)), 0, 0);
      P[R.BP + 1] = 0.07 * sp * Math.max(0, sin(f + 0.4)) - 0.01; R.A(P, 'body', 0.11 * sp * sin(f + 0.2), 0, 0);
      R.A(P, 'neck', 0.35 * sp - 0.08 * sin(f + 0.2), 0, 0); R.A(P, 'head', -0.1 * sp - 0.06 * sin(f), 0, 0);
      R.A(P, 'tail', -0.55 * sp, 0, 0.1 * sin(f));
    },
    attack(P, t, c) { const R = c.rig, p = c.phase, k = sin(p * PI); R.A(P, 'body', 0.6 * k, 0, 0); P[R.BP + 1] = 0.25 * k; R.A(P, 'legFL', 1.1 * k, 0, 0); R.A(P, 'legFR', 0.9 * k, 0, 0); R.A(P, 'lowFL', -1.2 * k, 0, 0); R.A(P, 'lowFR', -1.0 * k, 0, 0); R.A(P, 'legBL', -0.5 * k, 0, 0); R.A(P, 'legBR', -0.5 * k, 0, 0); R.A(P, 'lowBL', -0.6 * k, 0, 0); R.A(P, 'lowBR', -0.6 * k, 0, 0); R.A(P, 'neck', -0.3 * k, 0, 0); R.A(P, 'head', 0.3 * k, 0, 0); },
    hit(P, t, c) { const R = c.rig, k = sin(c.phase * PI); P[R.BP + 2] = 0.1 * k; R.A(P, 'neck', 0.3 * k, 0.2 * k, 0); R.A(P, 'head', 0.2 * k, 0, 0); },
    death(P, t, c) { const R = c.rig, p = Math.min(1, c.t / 1.0), k = p * p * (3 - 2 * p); R.S(P, 'body', 0.05 * k, 0, 1.45 * k); P[R.BP + 1] = -(R.spineY - R.Q.r * 0.95) * k; R.A(P, 'neck', -0.5 * k, 0.3 * k, 0); R.A(P, 'head', 0.2 * k, 0.4 * k, 0); for (const nm of ['FL', 'FR', 'BL', 'BR']) { R.A(P, 'leg' + nm, (nm[0] === 'F' ? 0.5 : -0.2) * k, 0, 0); R.A(P, 'low' + nm, -0.6 * k, 0, 0); } },
  };

  // ================================================================== BOATS
  function flipGeo(g) {
    g = g.index ? g.toNonIndexed() : g;
    const p = g.getAttribute('position'), n = g.getAttribute('normal');
    for (let i = 0; i < p.count; i += 3) { const ax = p.getX(i), ay = p.getY(i), az = p.getZ(i); p.setXYZ(i, p.getX(i + 2), p.getY(i + 2), p.getZ(i + 2)); p.setXYZ(i + 2, ax, ay, az); if (n) { const nx = n.getX(i), ny = n.getY(i), nz = n.getZ(i); n.setXYZ(i, n.getX(i + 2), n.getY(i + 2), n.getZ(i + 2)); n.setXYZ(i + 2, nx, ny, nz); } }
    if (n) for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
    return g;
  }
  function plankColor(g, base, axis, period) { // alternating plank stripes
    _paint(g, base); const p = g.getAttribute('position'), c = g.getAttribute('color');
    const a = new THREE.Color(base), b = new THREE.Color(hexMul(base, 0.82));
    for (let i = 0; i < p.count; i++) { const v = axis === 'y' ? p.getY(i) : axis === 'x' ? p.getX(i) : p.getZ(i); const k = Math.floor(v / period) & 1; const cc = k ? b : a; c.setXYZ(i, cc.r, cc.g, cc.b); }
    return g;
  }
  function hullGeo(sx, sy, sz, col, inner) {
    const outer = sphere(1, 24, 12, 0, TAU, PI * 0.5, PI * 0.5); outer.scale(sx, sy, sz);
    const list = [plankColor(outer, col, 'y', 0.12)];
    if (inner) { const inn = sphere(1, 24, 12, 0, TAU, PI * 0.5, PI * 0.5); inn.scale(sx * 0.9, sy * 0.88, sz * 0.94); inn.translate(0, 0.02, 0); list.push(plankColor(flipGeo(inn), hexMul(col, 0.85), 'z', 0.25)); }
    const gun = new THREE.TorusGeometry(1, 0.05, 6, 32); gun.rotateX(PI / 2); gun.scale(sx * 0.97, 1, sz * 0.97); gun.translate(0, 0.02, 0); list.push(_paint(gun, hexMul(col, 0.7)));
    const g = _merge(list); g.translate(0, sy * 0.72, 0); return g;
  }
  function buildBoat(kind) {
    kind = kind || 'rowboat';
    const g = new THREE.Group(); g.name = 'boat_' + kind;
    const wood = MAT_VC(0.75, 0.02);
    let seat, mast = null, oars = [];
    const parts = {};
    if (kind === 'elfship') {
      const col = 0xe6e2d6, hull = mesh(cached('boat|elf', () => {
        const list = [hullGeo(0.95, 0.75, 3.4, col, true)];
        const keel = box(0.08, 0.2, 6.2); keel.translate(0, -0.12, 0); list.push(_paint(keel, 0x9a9488));
        const deckF = box(1.5, 0.06, 1.4); deckF.translate(0, 0.5, -2.5); list.push(plankColor(deckF, 0xd8d0c0, 'x', 0.18));
        const deckB = box(1.5, 0.06, 1.2); deckB.translate(0, 0.5, 2.6); list.push(plankColor(deckB, 0xd8d0c0, 'x', 0.18));
        const bench = box(1.5, 0.08, 0.3); bench.translate(0, 0.72, 1.4); list.push(_paint(bench, 0xc8bca8));
        // swan prow
        const neck = tube([[0, 0.45, -3.3], [0, 1.0, -3.7], [0, 1.8, -3.9], [0, 2.45, -3.75], [0, 2.75, -3.45]], 0.12, 16); list.push(_paint(neck, col));
        const hd = sphere(0.2, 12, 9); hd.scale(1, 0.9, 1.3); hd.translate(0, 2.8, -3.35); list.push(_paint(hd, col));
        const beak = cone(0.07, 0.3, 6); beak.rotateX(-PI / 2); beak.translate(0, 2.75, -3.05); list.push(_paint(beak, 0xd8a040));
        const stern = tube([[0, 0.45, 3.3], [0, 0.95, 3.6], [0, 1.5, 3.55]], 0.1, 8); list.push(_paint(stern, col));
        for (const sd of [-1, 1]) { const wing = extrude(shapeFrom([[0, 0], [0.9, 0.35], [1.5, 0.15], [1.3, -0.05], [0.4, -0.12]]), 0.03, 0); wing.rotateY(sd < 0 ? PI * 0.5 : -PI * 0.5); wing.translate(sd * 0.95, 0.6, -1.6); list.push(_paint(wing, hexMul(col, 0.9))); for (let i = 0; i < 7; i++) { const post = cyl(0.025, 0.025, 0.45, 6); post.translate(sd * 0.9 * (1 - Math.abs(i - 3) * 0.05), 0.75, -1.8 + i * 0.6); list.push(_paint(post, 0xc8bca8)); } const rail = tube([[sd * 0.78, 0.98, -2.0], [sd * 0.9, 0.98, -0.9], [sd * 0.92, 0.98, 0.3], [sd * 0.88, 0.98, 1.4], [sd * 0.75, 0.98, 2.2]], 0.03, 12); list.push(_paint(rail, 0xc8bca8)); }
        return _merge(list);
      }), wood, true);
      g.add(hull); parts.hull = hull;
      mast = grp(0, 0.5, -0.3, g);
      const mm = mesh(cached('boat|elfmast', () => { const list = []; const m = cyl(0.05, 0.07, 4.6, 8); m.translate(0, 2.3, 0); list.push(_paint(m, 0xd8d0c0)); const yard = cyl(0.03, 0.03, 2.6, 8); yard.rotateZ(PI / 2); yard.translate(0, 4.2, 0); list.push(_paint(yard, 0xd8d0c0)); const top = sphere(0.09, 8, 6); top.translate(0, 4.62, 0); list.push(_paint(top, 0xd8a040)); return _merge(list); }), wood, true);
      mast.add(mm);
      const sail = mesh(cached('boat|elfsail', () => { const s = new THREE.PlaneGeometry(2.4, 3.2, 8, 8); const p = s.getAttribute('position'); for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i); p.setZ(i, (1 - (x / 1.2) * (x / 1.2)) * 0.45 * (0.5 + 0.5 * (1 - (y + 1.6) / 3.2)) + 0.05); } s.computeVertexNormals(); s.translate(0, 2.5, 0); return _paint(s, 0xf4f0e6); }), material(0xffffff, { vertexColors: true, rough: 0.9, double: true }), true);
      mast.add(sail); parts.sail = sail;
      seat = grp(0, 0.78, 1.4, g);
    } else if (kind === 'ferry') {
      const col = 0x7a5a38;
      const hull = mesh(cached('boat|ferry', () => {
        const list = [];
        const base = box(3.2, 0.6, 6.0); base.translate(0, 0.1, 0); list.push(plankColor(base, hexMul(col, 0.8), 'y', 0.14));
        const deck = box(3.0, 0.08, 5.8); deck.translate(0, 0.42, 0); list.push(plankColor(deck, col, 'x', 0.24));
        for (const sd of [-1, 1]) { for (let i = 0; i < 7; i++) { const post = cyl(0.04, 0.05, 0.9, 6); post.translate(sd * 1.45, 0.88, -2.7 + i * 0.9); list.push(_paint(post, 0x5a4028)); } const rail = box(0.06, 0.06, 5.5); rail.translate(sd * 1.45, 1.3, 0); list.push(_paint(rail, 0x5a4028)); const rail2 = box(0.05, 0.05, 5.5); rail2.translate(sd * 1.45, 0.88, 0); list.push(_paint(rail2, 0x5a4028)); }
        for (const sz of [-1, 1]) { const ramp = box(2.6, 0.08, 0.9); ramp.rotateX(sz * -0.35); ramp.translate(0, 0.3, sz * 3.35); list.push(plankColor(ramp, hexMul(col, 0.9), 'x', 0.24)); }
        for (let i = 0; i < 3; i++) { const bar = cyl(0.12, 0.14, 0.5, 8); bar.translate(-1.0 + i * 0.5, 0.7, 2.2); list.push(_paint(bar, 0x4a3420)); }
        const crate = box(0.6, 0.6, 0.6); crate.translate(1.0, 0.76, -2.2); list.push(plankColor(crate, 0x8a6a40, 'y', 0.15));
        return _merge(list);
      }), wood, true);
      g.add(hull); parts.hull = hull;
      mast = grp(0, 0.46, -0.8, g);
      const pole = mesh(cached('boat|ferrypole', () => { const list = []; const m = cyl(0.04, 0.05, 3.0, 8); m.translate(0, 1.5, 0); list.push(_paint(m, 0x5a4028)); const lamp = box(0.22, 0.28, 0.22); lamp.translate(0, 2.9, 0); list.push(_paint(lamp, 0x3a3230)); const flag = extrude(shapeFrom([[0, 0], [0.8, 0.15], [0, 0.4]]), 0.02, 0); flag.translate(0, 2.4, 0); list.push(_paint(flag, 0x8a2a2a)); return _merge(list); }), wood, true);
      mast.add(pole);
      const lampGlow = mesh(cached('boat|lamp', () => { const s = sphere(0.07, 8, 6); s.translate(0, 2.9, 0); return s; }), material(0xffc060, { emissive: 0xffa030, emissiveIntensity: 2 }), false);
      mast.add(lampGlow); parts.lamp = lampGlow;
      seat = grp(0, 0.46, 0.4, g);
    } else {
      const col = 0x8a6a42;
      const hull = mesh(cached('boat|row', () => {
        const list = [hullGeo(0.72, 0.5, 1.8, col, true)];
        const keel = box(0.06, 0.1, 3.4); keel.translate(0, -0.1, 0); list.push(_paint(keel, hexMul(col, 0.6)));
        for (const z of [-0.75, 0.1, 0.85]) { const b = box(1.2 * (1 - Math.abs(z) * 0.15), 0.06, 0.26); b.translate(0, 0.3, z); list.push(_paint(b, hexMul(col, 0.85))); }
        const bowCap = box(0.5, 0.06, 0.45); bowCap.translate(0, 0.36, -1.5); list.push(plankColor(bowCap, hexMul(col, 0.9), 'x', 0.12));
        for (const sd of [-1, 1]) { const lock = cyl(0.03, 0.03, 0.14, 6); lock.translate(sd * 0.68, 0.42, -0.15); list.push(_paint(lock, 0x5a5a60)); }
        return _merge(list);
      }), wood, true);
      g.add(hull); parts.hull = hull;
      for (const sd of [-1, 1]) {
        const oar = grp(sd * 0.7, 0.46, -0.15, g);
        const om = mesh(cached('boat|oar', () => { const list = []; const shaft = cyl(0.02, 0.025, 2.2, 8); shaft.rotateZ(PI / 2); shaft.translate(0.5, 0, 0); list.push(_paint(shaft, 0x9a7a4a)); const blade = box(0.5, 0.03, 0.16); blade.translate(1.5, 0, 0); list.push(_paint(blade, 0x8a6a3a)); return _merge(list); }), wood, false);
        if (sd < 0) om.rotation.y = PI;
        oar.add(om); oar.rotation.z = sd * -0.35; oar.userData.side = sd; oars.push(oar);
      }
      seat = grp(0, 0.33, 0.1, g);
    }
    const boat = { group: g, seat, mast, oars, parts, kind, time: 0,
      animate(t) { this.time = t; for (const o of oars) { const sd = o.userData.side; o.rotation.z = sd * (-0.35 + 0.25 * sin(t * 2.2)); o.rotation.y = sd * 0.45 * cos(t * 2.2); } if (parts.sail) parts.sail.rotation.y = 0.06 * sin(t * 0.7); },
      dispose() { disposeTree(g); } };
    return boat;
  }

  // ================================================================== PROPS
  const _animProps = new Set();
  function buildProp(kind) {
    kind = kind || 'crate';
    const g = new THREE.Group(); g.name = 'prop_' + kind;
    const prop = { group: g, kind, isOpen: false, open() { }, close() { }, update() { }, dispose() { _animProps.delete(prop); disposeTree(g); } };
    const wood = MAT_VC(0.8, 0.02), stone = MAT_VC(0.95, 0), plant = material(0xffffff, { vertexColors: true, rough: 0.85, double: true });
    if (kind === 'chest') {
      const body = mesh(cached('prop|chestbody', () => { const list = []; const b = box(0.72, 0.42, 0.46); b.translate(0, 0.21, 0); list.push(plankColor(b, 0x6a4526, 'y', 0.1)); for (const x of [-0.26, 0.26]) { const band = box(0.06, 0.44, 0.48); band.translate(x, 0.21, 0); list.push(_paint(band, 0x3a3a40)); } const lock = box(0.1, 0.12, 0.04); lock.translate(0, 0.3, -0.24); list.push(_paint(lock, 0xc9a24a)); for (const x of [-0.34, 0.34]) { const ft = box(0.06, 0.05, 0.48); ft.translate(x, 0.02, 0); list.push(_paint(ft, 0x3a3a40)); } return _merge(list); }), wood, true);
      g.add(body);
      const lid = grp(0, 0.42, 0.23, g);
      const lm = mesh(cached('prop|chestlid', () => { const list = []; const c = cyl(0.23, 0.23, 0.72, 12, 1, false, 0, PI); c.rotateZ(PI / 2); c.rotateY(PI / 2); c.translate(0, 0, -0.23); list.push(plankColor(c, 0x6a4526, 'x', 0.1)); for (const x of [-0.26, 0.26]) { const band = new THREE.TorusGeometry(0.235, 0.03, 5, 12, PI); band.rotateY(PI / 2); band.rotateX(0); band.translate(x, 0, -0.23); list.push(_paint(band, 0x3a3a40)); } return _merge(list); }), wood, true);
      lm.rotation.x = 0; lid.add(lm);
      const gold = mesh(cached('prop|chestgold', () => { const list = []; for (let i = 0; i < 9; i++) { const c = cyl(0.05, 0.05, 0.015, 8); c.translate(-0.22 + (i % 5) * 0.11, 0.36 + Math.floor(i / 5) * 0.02, -0.1 + Math.floor(i / 5) * 0.14); list.push(c); } const gem = new THREE.OctahedronGeometry(0.05, 0); gem.translate(0.1, 0.4, 0.08); list.push(gem); return _merge(list); }), material(0xffd25a, { emissive: 0xffa020, emissiveIntensity: 0.5, rough: 0.3, metal: 0.8 }), false);
      gold.visible = false; g.add(gold);
      prop.lid = lid; prop.target = 0; prop.angle = 0;
      prop.open = function () { prop.isOpen = true; prop.target = -1.9; gold.visible = true; _animProps.add(prop); };
      prop.close = function () { prop.isOpen = false; prop.target = 0; _animProps.add(prop); };
      prop.update = function (dt) { const d = prop.target - prop.angle; if (Math.abs(d) < 0.005) { prop.angle = prop.target; lid.rotation.x = prop.angle; if (!prop.isOpen) gold.visible = false; _animProps.delete(prop); return; } prop.angle += d * Math.min(1, dt * 7); lid.rotation.x = prop.angle; };
    } else if (kind === 'bundle') {
      g.add(mesh(cached('prop|bundle', () => { const list = []; const s = sphere(0.3, 14, 10); s.scale(1, 0.75, 0.9); s.translate(0, 0.22, 0); list.push(_paint(s, 0x9a8a6a)); const top = sphere(0.12, 8, 6); top.translate(0, 0.5, 0); list.push(_paint(top, 0x8a7a5a)); const rope = new THREE.TorusGeometry(0.2, 0.025, 6, 16); rope.rotateX(PI / 2); rope.translate(0, 0.42, 0); list.push(_paint(rope, 0x5a4a30)); const rope2 = new THREE.TorusGeometry(0.31, 0.02, 6, 16); rope2.rotateX(PI / 2); rope2.rotateZ(0.4); rope2.translate(0, 0.22, 0); list.push(_paint(rope2, 0x5a4a30)); return _merge(list); }), MAT_VC(0.9, 0), true));
    } else if (kind === 'herb') {
      g.add(mesh(cached('prop|herb', () => { const list = []; for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + 0.4; const st = cyl(0.01, 0.015, 0.35, 5); st.rotateX(0.35); st.rotateY(a); st.translate(sin(a) * 0.04, 0.17, cos(a) * 0.04); list.push(_paint(st, 0x3f7a2a)); for (let k = 0; k < 3; k++) { const lf = sphere(0.06, 6, 4); lf.scale(0.5, 0.15, 1); lf.rotateY(a + k * 1.6); lf.translate(sin(a) * (0.05 + k * 0.04), 0.12 + k * 0.08, cos(a) * (0.05 + k * 0.04)); list.push(_paint(lf, k % 2 ? 0x4f9a3a : 0x3f7a2a)); } } for (let i = 0; i < 5; i++) { const a = i / 5 * TAU; const pt = sphere(0.035, 6, 4); pt.scale(1, 0.4, 1.4); pt.rotateY(a); pt.translate(sin(a) * 0.05, 0.4, cos(a) * 0.05); list.push(_paint(pt, 0xe86aa0)); } const cen = sphere(0.03, 6, 4); cen.translate(0, 0.41, 0); list.push(_paint(cen, 0xffd040)); const bud = sphere(0.02, 5, 4); bud.translate(0.1, 0.32, -0.06); list.push(_paint(bud, 0xe86aa0)); return _merge(list); }), plant, false));
    } else if (kind === 'ore') {
      g.add(mesh(cached('prop|ore', () => { const list = []; const rock = new THREE.DodecahedronGeometry(0.32, 0); rock.scale(1.1, 0.8, 1); rock.translate(0, 0.25, 0); list.push(_paint(rock, 0x6a6a68)); const r2 = new THREE.DodecahedronGeometry(0.2, 0); r2.translate(0.25, 0.14, 0.15); list.push(_paint(r2, 0x5a5a58)); return _merge(list); }), material(0xffffff, { vertexColors: true, rough: 0.9, flat: true }), true));
      g.add(mesh(cached('prop|orevein', () => { const list = []; for (let i = 0; i < 7; i++) { const a = i * 2.4; const v = sphere(0.06, 6, 4); v.scale(1, 0.5, 1.4); v.rotateY(a); v.translate(sin(a) * 0.3, 0.2 + 0.1 * cos(i * 1.7), cos(a) * 0.3); list.push(v); } return _merge(list); }), material(0xd8a040, { emissive: 0xa06010, emissiveIntensity: 0.35, rough: 0.35, metal: 0.85 }), false));
    } else if (kind === 'mushroom') {
      g.add(mesh(cached('prop|mushroom', () => { const list = []; const specs = [[0, 0, 0.22, 0xb04030], [0.18, 0.1, 0.15, 0xc85a40], [-0.16, 0.12, 0.13, 0xb04030], [0.06, -0.2, 0.1, 0xd8a060]]; for (const [x, z, s, col] of specs) { const st = cyl(0.04 * s / 0.2, 0.05 * s / 0.2, s * 0.9, 8); st.translate(x, s * 0.45, z); list.push(_paint(st, 0xe8dcc0)); const cap = sphere(s * 0.8, 12, 8, 0, TAU, 0, PI * 0.5); cap.scale(1, 0.7, 1); cap.translate(x, s * 0.85, z); list.push(_paint(cap, col)); for (let k = 0; k < 4; k++) { const a = k * 1.9 + x; const dot = sphere(s * 0.13, 5, 4); dot.scale(1, 0.4, 1); dot.translate(x + sin(a) * s * 0.45, s * 0.85 + s * 0.5, z + cos(a) * s * 0.45); list.push(_paint(dot, 0xf4f0e8)); } } return _merge(list); }), MAT_VC(0.7, 0), true));
    } else if (kind === 'relic') {
      g.add(mesh(cached('prop|relic', () => { const list = []; const base = new THREE.DodecahedronGeometry(0.3, 0); base.scale(1.3, 0.5, 1); base.translate(0, 0.1, 0); list.push(_paint(base, 0x5a5a5a)); const tab = box(0.5, 0.72, 0.12); tab.rotateX(-0.2); tab.translate(0, 0.5, 0.02); list.push(_paint(tab, 0x8a8478)); return _merge(list); }), material(0xffffff, { vertexColors: true, rough: 0.95, flat: true }), true));
      const runes = mesh(cached('prop|runes', () => { const list = []; const rows = [[-0.15, 0.7], [0.05, 0.7], [-0.1, 0.55], [0.12, 0.55], [-0.15, 0.4], [0.02, 0.4], [0.14, 0.42]]; for (const [x, y] of rows) { const b = box(0.06, 0.09, 0.02); b.rotateZ(x * 2); b.rotateX(-0.2); b.translate(x, y, -0.05 + (0.5 - y) * 0.2); list.push(b); } return _merge(list); }), material(0x60c0ff, { emissive: 0x3090ff, emissiveIntensity: 1.5 }), false);
      g.add(runes); prop.glow = runes; _animProps.add(prop);
      prop.update = function (dt) { prop.t = (prop.t || 0) + dt; runes.material.emissiveIntensity; runes.scale.setScalar(1 + 0.04 * sin(prop.t * 2.5)); };
    } else if (kind === 'beacon') {
      g.add(mesh(cached('prop|beacon', () => { const list = []; for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; const lg = cyl(0.03, 0.035, 1.1, 6); lg.rotateX(0.22); lg.rotateY(a); lg.translate(sin(a) * 0.2, 0.55, cos(a) * 0.2); list.push(_paint(lg, 0x3a3a40)); } const bowl = lathe([[0.05, 0.9], [0.3, 0.95], [0.38, 1.1], [0.36, 1.2], [0.3, 1.18], [0.24, 1.05], [0.0001, 1.02]], 14); list.push(_paint(bowl, 0x4a4a50)); const ring = new THREE.TorusGeometry(0.38, 0.03, 6, 16); ring.rotateX(PI / 2); ring.translate(0, 1.2, 0); list.push(_paint(ring, 0x3a3a40)); for (let i = 0; i < 6; i++) { const a = i * 1.1; const coal = sphere(0.07, 6, 5); coal.translate(sin(a) * 0.15, 1.12, cos(a) * 0.15); list.push(_paint(coal, 0x2a1a14)); } return _merge(list); }), MAT_VC(0.6, 0.5), true));
      const flame = mesh(cached('prop|flame', () => { const list = []; const f = cone(0.22, 0.55, 8); f.translate(0, 1.4, 0); list.push(f); const f2 = cone(0.12, 0.4, 6); f2.translate(0.08, 1.6, 0.05); list.push(f2); return _merge(list); }), material(0xffa030, { emissive: 0xff6010, emissiveIntensity: 2.2, opacity: 0.85 }), false);
      g.add(flame); prop.flame = flame; prop.lit = true; _animProps.add(prop);
      prop.update = function (dt) { prop.t = (prop.t || 0) + dt; if (!prop.lit) { flame.visible = false; return; } flame.visible = true; flame.scale.set(1 + 0.12 * sin(prop.t * 13), 1 + 0.2 * sin(prop.t * 9 + 1), 1 + 0.12 * cos(prop.t * 11)); flame.rotation.y += dt * 2; };
      prop.open = function () { prop.lit = true; prop.isOpen = true; }; prop.close = function () { prop.lit = false; prop.isOpen = false; };
    } else {
      g.add(mesh(cached('prop|crate', () => { const list = []; const b = box(0.7, 0.7, 0.7); b.translate(0, 0.35, 0); list.push(plankColor(b, 0x8a6a40, 'y', 0.14)); for (const y of [0.05, 0.65]) for (const s of [[0.72, 0.06, 0.06, 0, y, 0.34], [0.72, 0.06, 0.06, 0, y, -0.34], [0.06, 0.06, 0.72, 0.34, y, 0], [0.06, 0.06, 0.72, -0.34, y, 0]]) { const br = box(s[0], s[1], s[2]); br.translate(s[3], s[4], s[5]); list.push(_paint(br, 0x5a4028)); } for (const [x, z] of [[0.35, 0.35], [-0.35, 0.35], [0.35, -0.35], [-0.35, -0.35]]) { const p = box(0.07, 0.72, 0.07); p.translate(x, 0.35, z); list.push(_paint(p, 0x5a4028)); } return _merge(list); }), wood, true));
    }
    return prop;
  }

  // ================================================================== NAMEPLATES
  const _npTex = new Map(), _npMat = new Map(), _npPool = [];
  let _npLive = 0;
  function nameplateTexture(text, color, sub, subColor) {
    const key = text + '|' + color + '|' + (sub || '') + '|' + (subColor || '');
    let tex = _npTex.get(key);
    if (tex) return tex;
    const W = 512, H = 128, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, W, H); ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 42px "Trebuchet MS", "Segoe UI", Arial, sans-serif';
    ctx.lineWidth = 8; ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineJoin = 'round';
    const nameY = sub ? 46 : 70;
    ctx.strokeText(text, W / 2, nameY); ctx.fillStyle = color || '#ffffff'; ctx.fillText(text, W / 2, nameY);
    if (sub) { ctx.font = '600 27px "Trebuchet MS", "Segoe UI", Arial, sans-serif'; ctx.lineWidth = 6; ctx.strokeText(sub, W / 2, 98); ctx.fillStyle = subColor || 'rgba(235,225,200,0.95)'; ctx.fillText(sub, W / 2, 98); }
    tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false; tex.userData.shared = true;
    _npTex.set(key, tex);
    return tex;
  }
  function nameplate(text, color, opts) {
    opts = opts || {}; text = String(text == null ? '' : text); color = color || '#ffffff';
    if (typeof color === 'number') color = '#' + ('000000' + color.toString(16)).slice(-6);
    const tex = nameplateTexture(text, color, opts.sub, opts.subColor);
    const key = tex.userData.key || (tex.userData.key = text + '|' + color + '|' + (opts.sub || ''));
    let mat = _npMat.get(key);
    if (!mat) { mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: !opts.overlay, depthWrite: false, sizeAttenuation: true }); _npMat.set(key, mat); }
    let sp = _npPool.pop();
    if (!sp) sp = new THREE.Sprite(mat); else sp.material = mat;
    sp.visible = true; sp.center.set(0.5, 0); sp.renderOrder = 10;
    sp.userData.np = { key, base: opts.scale || 1 };
    sp.scale.set(2.4, 0.6, 1);
    _npLive++;
    return sp;
  }
  function releaseNameplate(sp) { if (!sp || !sp.isSprite) return; if (sp.parent) sp.parent.remove(sp); sp.visible = false; if (_npPool.length < 200) _npPool.push(sp); _npLive = Math.max(0, _npLive - 1); }
  function updateNameplate(sp, camera) {
    if (!sp || !camera) return;
    sp.getWorldPosition(_tmpV);
    const d = _tmpV.distanceTo(camera.position);
    const base = (sp.userData.np && sp.userData.np.base) || 1;
    const s = clamp(d * 0.05, 0.25, 5) * base;
    // undo parent scale so the plate stays constant regardless of rig scale
    let ps = 1; if (sp.parent) { sp.parent.getWorldScale(_tmpV2); ps = _tmpV2.y || 1; }
    sp.scale.set(s * 4 / ps, s / ps, 1);
  }

  // ================================================================== PUBLIC API
  function buildHumanoid(spec) {
    spec = spec || {};
    try { return new HumanoidRig(spec); }
    catch (e) { if (G.reportError) G.reportError(e, 'buildHumanoid'); try { return new HumanoidRig({ race: 'man', gender: 'male' }); } catch (e2) { return null; } }
  }
  function buildHorseSafe(color) { try { return buildHorse(color); } catch (e) { if (G.reportError) G.reportError(e, 'buildHorse'); return null; } }
  function buildBoatSafe(kind) { try { return buildBoat(kind); } catch (e) { if (G.reportError) G.reportError(e, 'buildBoat'); return { group: new THREE.Group(), seat: new THREE.Group(), mast: null, oars: [], animate() { }, dispose() { } }; } }
  function buildPropSafe(kind) { try { return buildProp(kind); } catch (e) { if (G.reportError) G.reportError(e, 'buildProp'); const g = new THREE.Group(); return { group: g, kind, open() { }, close() { }, update() { }, dispose() { }, isOpen: false }; } }
  let _updHooked = false;
  function update(dt) {
    dt = dt > 0.1 ? 0.1 : dt < 0 ? 0 : dt || 0;
    _shaderTime.value += dt;
    if (_animProps.size) for (const p of _animProps) { try { p.update(dt); } catch (e) { _animProps.delete(p); } }
  }
  function stats() {
    return { rigs: _rigCount, humanoids: _humanoidCount, monsters: _monsterCount, horses: _horseCount, geometries: _geoCount, materials: _matCount, nameplates: _npLive, nameplateTextures: _npTex.size, animatedProps: _animProps.size };
  }
  // trim the geometry cache when it grows large (only entries no live mesh references)
  function trimCache(max) {
    max = max || 900;
    if (_geos.size <= max) return 0;
    let n = 0;
    for (const [k, g] of _geos) { if (!(g.userData.refs > 0) && (k.startsWith('torso|') || k.startsWith('hips|') || k.startsWith('uarm|') || k.startsWith('farm|') || k.startsWith('hand|') || k.startsWith('thigh|') || k.startsWith('shin|') || k.startsWith('foot|') || k.startsWith('weapon|') || k.startsWith('helm|') || k.startsWith('pauld|') || k.startsWith('cape|') || k.startsWith('head|') || k.startsWith('face|') || k.startsWith('hair|'))) { g.dispose(); _geos.delete(k); _geoCount--; n++; if (_geos.size <= max * 0.7) break; } }
    return n;
  }
  G.Chars = {
    buildHumanoid, buildMonster, buildHorse: buildHorseSafe, buildBoat: buildBoatSafe, buildProp: buildPropSafe, buildWeapon,
    nameplate, releaseNameplate, updateNameplate, material, update, stats, trimCache,
    computeDims, ANIMS: ANIM_NAMES, WEAPON_SHAPES, RACE_DEF, FAMILIES: ['wolf', 'warg', 'lynx', 'boar', 'bear', 'lossoth-bear', 'spider', 'crawler', 'goblin', 'orc', 'uruk', 'brigand', 'sorcerer', 'troll', 'giant', 'wight', 'bat', 'drake', 'slug', 'sea-serpent'],
    _HumanoidRig: HumanoidRig, _CreatureRig: CreatureRig,
  };
  if (typeof G.on === 'function' && !_updHooked) { _updHooked = true; G.on('update', function (dt) { update(typeof dt === 'number' ? dt : (G.time ? G.time.dt : 0.016)); }); }
})();
