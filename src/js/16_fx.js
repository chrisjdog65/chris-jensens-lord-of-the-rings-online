/* ==== 16_fx.js — G.FX: pooled, cheap, vivid visual effects. Two CPU-simulated THREE.Points particle systems
   (additive ≤ 6000, normal ≤ 3000) sharing an 8-tile sprite atlas (glow, star, puff, ember, crystal, flame, bubble,
   streak) with per-particle attributes (position, velocity, birth/life/alpha, size, two colours, tile, spin, streak
   stretch); one InstancedMesh each for weapon arcs + expanding rings (mode-switched shader), jittering beams and
   soft light pillars; instanced projectiles (arrow / bolt / stone / fire) with ballistic arcs, gentle homing,
   Physics sweep/raycast + terrain hits, trails and impact effects; a single pooled flash PointLight; and the full
   effect catalogue of SPEC §5.7 (hit, crit, slash, thrust, spin, arrow, bolt, fire, frost, light, lightning, heal,
   buff, levelup, dust, splash, bubbles, smoke, fire_static, torch, sparkle, impact, blood→impact, quest_beacon,
   footstep, questmark_glow, death_puff, water_ring, snow_puff, loot_glow, teleport, mount_dust) plus extras
   `beam`, `flash`, `ring`.
   Public API: G.FX.init(scene), update(dt, camera), spawn(kind, pos, opts) → handle|null, stop(handle), count(),
   projectile(opts) → handle|null, setBeacon(pos|null), stats(), kinds, setViewportHeight(px), flashLight.
   Handles: { kind, pos: Vector3 (move it to move the effect), alive, target, stop(), setPos(x,y,z|Vector3) }.
   Private helpers (prefixed _): _col (hex → linear rgb cache), _mergeGeoms (fallback when G.mergeGeometries is
   absent), _canvasTex (fallback when G.canvasTexture is absent), _rnd (private RNG so VFX never consume G.rand). ==== */
(function () {
  'use strict';
  const G = window.G;
  const THREE = window.THREE;
  if (!G || !THREE) return;

  // ------------------------------------------------------------------------------------------------ constants
  const MAX_ADD = 6000, MAX_NRM = 3000;
  const MAX_ARCS = 64, MAX_BEAMS = 16, MAX_PILLARS = 24, MAX_PROJ = 24;
  const TEX = { GLOW: 0, STAR: 1, PUFF: 2, EMBER: 3, CRYSTAL: 4, FLAME: 5, BUBBLE: 6, STREAK: 7 };
  const GRAV = 9.8;
  const PI = Math.PI, TAU = Math.PI * 2;
  const NO_FLOOR = -1e9;

  // ------------------------------------------------------------------------------------------------ helpers
  let _seed = 0x9e3779b9 | 0;
  function _rnd() {                                   // xorshift32 — private VFX randomness (never touches G.rand)
    _seed ^= _seed << 13; _seed ^= _seed >>> 17; _seed ^= _seed << 5;
    return ((_seed >>> 0) % 16777216) / 16777216;
  }
  function rr(a, b) { return a + (b - a) * _rnd(); }
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

  const _colCache = new Map();
  const _tmpColor = new THREE.Color();
  function _col(hex) {                                // hex (sRGB) → cached Float32Array(3) in linear space
    let c = _colCache.get(hex);
    if (!c) {
      _tmpColor.setHex(hex);
      c = new Float32Array([_tmpColor.r, _tmpColor.g, _tmpColor.b]);
      _colCache.set(hex, c);
    }
    return c;
  }
  const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
  const _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3();          // arc/thrust scratch (never alias the caller's dir)
  const _m4 = new THREE.Matrix4(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
  const _scl = new THREE.Vector3();
  const _v2d = new THREE.Vector2();
  const UP = new THREE.Vector3(0, 1, 0);
  const XAXIS = new THREE.Vector3(1, 0, 0);

  function _canvasTex(w, h, draw) {
    if (typeof G.canvasTexture === 'function') {
      const t = G.canvasTexture(w, h, draw, { wrap: false, repeat: [1, 1], nearest: false });
      if (t) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.needsUpdate = true; return t; }
    }
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }

  function _mergeGeoms(geoms) {                       // fallback merge (position/normal/uv/color, non-indexed)
    if (typeof G.mergeGeometries === 'function') { const g = G.mergeGeometries(geoms); if (g) return g; }
    const parts = geoms.map(g => g.index ? g.toNonIndexed() : g);
    const names = ['position', 'normal', 'uv', 'color'];
    const out = new THREE.BufferGeometry();
    for (const name of names) {
      if (!parts.every(p => p.getAttribute(name))) continue;
      const item = parts[0].getAttribute(name).itemSize;
      let total = 0; for (const p of parts) total += p.getAttribute(name).count;
      const arr = new Float32Array(total * item); let off = 0;
      for (const p of parts) { const a = p.getAttribute(name); arr.set(a.array.subarray(0, a.count * item), off); off += a.count * item; }
      out.setAttribute(name, new THREE.BufferAttribute(arr, item));
    }
    out.computeBoundingSphere();
    return out;
  }
  function colorGeom(geom, hex) {                     // paint a geometry with a flat vertex colour (linear)
    const c = _col(hex), n = geom.getAttribute('position').count, arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2]; }
    geom.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    return geom;
  }

  function groundAt(x, z, fallback) {                 // floor height for sparks/dust (Physics → Terrain → fallback)
    const P = G.Physics, T = G.Terrain;
    if (P && typeof P.groundY === 'function') { const y = P.groundY(x, z); if (typeof y === 'number' && y === y) return y; }
    if (T && typeof T.height === 'function') { const y = T.height(x, z); if (typeof y === 'number' && y === y) return y; }
    return fallback;
  }
  function posOf(t, out) {                            // entity {pos} | Object3D {position} | Vector3 | {x,y,z}
    if (!t) return false;
    const p = t.pos || t.position || t;
    if (typeof p.x !== 'number' || typeof p.y !== 'number' || typeof p.z !== 'number') return false;
    if (p.x !== p.x || p.y !== p.y || p.z !== p.z) return false;
    out.set(p.x, p.y, p.z);
    return true;
  }
  function validPos(p) { return !!p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number' && p.x === p.x && p.y === p.y && p.z === p.z; }
  function dirOf(o, out) {                            // horizontal-ish direction from opts.dir or yaw (0 = facing -Z)
    if (o && o.dir && validPos(o.dir) && (o.dir.x || o.dir.y || o.dir.z)) { out.copy(o.dir).normalize(); return true; }
    if (o && typeof o.yaw === 'number') { out.set(-Math.sin(o.yaw), 0, -Math.cos(o.yaw)); return true; }
    out.set(0, 0, -1); return false;
  }

  // ------------------------------------------------------------------------------------------------ sprite atlas
  function drawAtlas(ctx, w, h) {
    const T = w / 4;
    ctx.clearRect(0, 0, w, h);
    const tile = (i, fn) => { ctx.save(); ctx.translate((i % 4) * T, Math.floor(i / 4) * T); ctx.beginPath(); ctx.rect(0, 0, T, T); ctx.clip(); fn(T, T / 2); ctx.restore(); };
    const W = (a) => 'rgba(255,255,255,' + a + ')';
    // 0 soft glow
    tile(TEX.GLOW, (s, c) => { const g = ctx.createRadialGradient(c, c, 0, c, c, c); g.addColorStop(0, W(1)); g.addColorStop(0.2, W(0.8)); g.addColorStop(0.5, W(0.28)); g.addColorStop(0.8, W(0.06)); g.addColorStop(1, W(0)); ctx.fillStyle = g; ctx.fillRect(0, 0, s, s); });
    // 1 sparkle: soft core + 4 long rays + 4 short diagonal rays
    tile(TEX.STAR, (s, c) => {
      const g = ctx.createRadialGradient(c, c, 0, c, c, s * 0.16); g.addColorStop(0, W(1)); g.addColorStop(0.5, W(0.55)); g.addColorStop(1, W(0)); ctx.fillStyle = g; ctx.fillRect(0, 0, s, s);
      ctx.globalCompositeOperation = 'lighter';
      const ray = (rot, len, wid, a) => { ctx.save(); ctx.translate(c, c); ctx.rotate(rot); const gg = ctx.createLinearGradient(-len, 0, len, 0); gg.addColorStop(0, W(0)); gg.addColorStop(0.5, W(a)); gg.addColorStop(1, W(0)); ctx.fillStyle = gg; ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(0, -wid); ctx.lineTo(len, 0); ctx.lineTo(0, wid); ctx.closePath(); ctx.fill(); ctx.restore(); };
      ray(0, c * 0.96, s * 0.045, 1); ray(PI / 2, c * 0.96, s * 0.045, 1); ray(PI / 4, c * 0.5, s * 0.025, 0.7); ray(-PI / 4, c * 0.5, s * 0.025, 0.7);
    });
    // 2 smoke puff: cluster of soft blobs, darker underside baked into rgb
    tile(TEX.PUFF, (s, c) => {
      const blobs = [[0, 0, 0.36], [-0.18, -0.1, 0.26], [0.2, -0.08, 0.27], [0.05, 0.2, 0.25], [-0.12, 0.16, 0.22], [0.16, 0.16, 0.2], [-0.24, 0.04, 0.18], [0.26, 0.08, 0.17], [-0.05, -0.24, 0.2]];
      for (const b of blobs) { const x = c + b[0] * s, y = c + b[1] * s, r = b[2] * s; const g = ctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, W(0.5)); g.addColorStop(0.5, W(0.22)); g.addColorStop(1, W(0)); ctx.fillStyle = g; ctx.fillRect(0, 0, s, s); }
      const sh = ctx.createLinearGradient(0, 0, 0, s); sh.addColorStop(0, 'rgba(0,0,0,0)'); sh.addColorStop(0.45, 'rgba(0,0,0,0.05)'); sh.addColorStop(1, 'rgba(0,0,0,0.45)');
      ctx.globalCompositeOperation = 'source-atop'; ctx.fillStyle = sh; ctx.fillRect(0, 0, s, s);
    });
    // 3 ember: hard bright core + halo
    tile(TEX.EMBER, (s, c) => { const g = ctx.createRadialGradient(c, c, 0, c, c, c); g.addColorStop(0, W(1)); g.addColorStop(0.16, W(1)); g.addColorStop(0.32, W(0.4)); g.addColorStop(0.6, W(0.1)); g.addColorStop(1, W(0)); ctx.fillStyle = g; ctx.fillRect(0, 0, s, s); });
    // 4 ice crystal: hexagonal shard, bright rim + centre line
    tile(TEX.CRYSTAL, (s, c) => {
      ctx.save(); ctx.translate(c, c); ctx.rotate(0.35);
      const pts = [[0, -0.42], [0.2, -0.14], [0.16, 0.36], [0, 0.46], [-0.16, 0.36], [-0.2, -0.14]];
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0] * s, p[1] * s) : ctx.moveTo(p[0] * s, p[1] * s)); ctx.closePath();
      const g = ctx.createLinearGradient(-0.2 * s, -0.4 * s, 0.2 * s, 0.4 * s); g.addColorStop(0, W(0.95)); g.addColorStop(0.5, W(0.4)); g.addColorStop(1, W(0.85)); ctx.fillStyle = g; ctx.fill();
      ctx.lineWidth = s * 0.05; ctx.strokeStyle = W(1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, -0.42 * s); ctx.lineTo(0, 0.46 * s); ctx.lineWidth = s * 0.02; ctx.strokeStyle = W(0.8); ctx.stroke();
      ctx.restore();
    });
    // 5 flame tongue: layered teardrops, brightest core
    tile(TEX.FLAME, (s, c) => {
      ctx.save(); ctx.translate(c, c + s * 0.02);
      for (let k = 3; k >= 0; k--) {
        const wd = (0.36 - k * 0.07) * s, ht = (0.46 - k * 0.06) * s, a = [0.3, 0.5, 0.75, 1][k];
        ctx.beginPath(); ctx.moveTo(0, -ht); ctx.bezierCurveTo(wd * 1.25, -ht * 0.15, wd * 1.1, ht * 0.75, 0, ht); ctx.bezierCurveTo(-wd * 1.1, ht * 0.75, -wd * 1.25, -ht * 0.15, 0, -ht); ctx.closePath();
        const g = ctx.createRadialGradient(0, ht * 0.3, 0, 0, 0, ht); g.addColorStop(0, W(a)); g.addColorStop(0.6, W(a * 0.55)); g.addColorStop(1, W(a * 0.08)); ctx.fillStyle = g; ctx.fill();
      }
      ctx.restore();
    });
    // 6 bubble: hollow ring + highlight
    tile(TEX.BUBBLE, (s, c) => {
      ctx.beginPath(); ctx.arc(c, c, s * 0.36, 0, TAU); ctx.lineWidth = s * 0.055; ctx.strokeStyle = W(0.9); ctx.stroke();
      const g = ctx.createRadialGradient(c, c, s * 0.18, c, c, s * 0.38); g.addColorStop(0, W(0.04)); g.addColorStop(1, W(0.3)); ctx.fillStyle = g; ctx.beginPath(); ctx.arc(c, c, s * 0.36, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.arc(c - s * 0.13, c - s * 0.14, s * 0.07, 0, TAU); ctx.fillStyle = W(0.95); ctx.fill();
    });
    // 7 streak: horizontal soft line with a hot centre (rotated to motion in the shader)
    tile(TEX.STREAK, (s, c) => {
      ctx.save(); ctx.translate(c, c); ctx.scale(1, 0.22);
      let g = ctx.createRadialGradient(0, 0, 0, 0, 0, c); g.addColorStop(0, W(1)); g.addColorStop(0.35, W(0.7)); g.addColorStop(0.75, W(0.2)); g.addColorStop(1, W(0)); ctx.fillStyle = g; ctx.fillRect(-c, -c, s, s * 4);
      ctx.restore(); ctx.save(); ctx.translate(c, c); ctx.scale(1, 0.1);
      g = ctx.createRadialGradient(0, 0, 0, 0, 0, c * 0.9); g.addColorStop(0, W(1)); g.addColorStop(0.5, W(0.6)); g.addColorStop(1, W(0)); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(-c, -c * 4, s, s * 8);
      ctx.restore();
    });
  }

  // ------------------------------------------------------------------------------------------------ particle shaders
  const PART_VERT = /* glsl */`
    uniform float uTime; uniform float uScale;
    attribute vec3 aVel; attribute vec3 aLife; attribute vec2 aSize; attribute vec3 aColor; attribute vec3 aColor2; attribute vec4 aMisc;
    varying vec4 vCol; varying float vRot; varying float vTex; varying float vStretch;
    #include <fog_pars_vertex>
    void main() {
      float age = uTime - aLife.x;
      float t = clamp(age / max(aLife.y, 0.0001), 0.0, 1.0);
      float alive = (age >= 0.0 && age < aLife.y) ? 1.0 : 0.0;
      float a = smoothstep(0.0, 0.07, t) * (1.0 - smoothstep(0.5, 1.0, t)) * alive * aLife.z;
      float size = mix(aSize.x, aSize.y, t);
      vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
      vStretch = 1.0;
      if (aMisc.w > 0.0) {
        vec3 vv = (modelViewMatrix * vec4(aVel, 0.0)).xyz;
        vec2 sd = vec2(mvPosition.x * vv.z - vv.x * mvPosition.z, mvPosition.y * vv.z - vv.y * mvPosition.z);
        float spd = length(aVel);
        vRot = (spd > 0.05) ? atan(-sd.y, sd.x) : 0.0;
        vStretch = clamp(1.0 + spd * aMisc.w, 1.0, 4.5);
      } else {
        vRot = aMisc.z + aMisc.y * max(age, 0.0);
      }
      vCol = vec4(mix(aColor, aColor2, t), a);
      vTex = aMisc.x;
      float ps = size * vStretch * uScale / max(-mvPosition.z, 0.05);
      gl_PointSize = (mvPosition.z < -0.05 && a > 0.001) ? clamp(ps, 0.0, 512.0) : 0.0;
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`;
  const PART_FRAG = (additive) => /* glsl */`
    uniform sampler2D uAtlas;
    varying vec4 vCol; varying float vRot; varying float vTex; varying float vStretch;
    #include <fog_pars_fragment>
    void main() {
      if (vCol.a <= 0.002) discard;
      vec2 p = gl_PointCoord - 0.5;
      float c = cos(vRot), s = sin(vRot);
      vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
      q.y *= vStretch;
      if (abs(q.x) > 0.499 || abs(q.y) > 0.499) discard;
      vec2 uv = q + 0.5;
      float col = mod(vTex, 4.0); float row = floor(vTex / 4.0);
      vec2 tuv = vec2((uv.x + col) * 0.25, (1.0 - uv.y + (1.0 - row)) * 0.5);
      vec4 tex = texture2D(uAtlas, tuv);
      float m = tex.a * vCol.a;
      if (m <= 0.003) discard;
      vec3 rgb = vCol.rgb * tex.r;
      #ifdef USE_FOG
        #ifdef FOG_EXP2
          float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
        #else
          float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
        #endif
        ${additive ? 'rgb *= (1.0 - fogFactor);' : 'rgb = mix(rgb, fogColor, fogFactor);'}
      #endif
      gl_FragColor = vec4(rgb, m);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  // ------------------------------------------------------------------------------------------------ particle system
  const sharedTime = { value: 0 };
  const sharedScale = { value: 600 };

  function PSys(max, additive, atlas) {
    this.max = max; this.n = 0; this.additive = additive; this.dirty = false;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max * 3); this.size = new Float32Array(max * 2);
    this.col = new Float32Array(max * 3); this.col2 = new Float32Array(max * 3);
    this.misc = new Float32Array(max * 4); this.phys = new Float32Array(max * 6);   // grav, drag, turb, seed, floorY, floorMode
    const g = this.geom = new THREE.BufferGeometry();
    const mk = (arr, item) => { const a = new THREE.BufferAttribute(arr, item); a.setUsage(THREE.DynamicDrawUsage); return a; };
    g.setAttribute('position', this.aPos = mk(this.pos, 3));
    g.setAttribute('aVel', this.aVel = mk(this.vel, 3));
    g.setAttribute('aLife', this.aLife = mk(this.life, 3));
    g.setAttribute('aSize', this.aSize = mk(this.size, 2));
    g.setAttribute('aColor', this.aColor = mk(this.col, 3));
    g.setAttribute('aColor2', this.aColor2 = mk(this.col2, 3));
    g.setAttribute('aMisc', this.aMisc = mk(this.misc, 4));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 }, uScale: { value: 600 }, uAtlas: { value: null } }]);
    uniforms.uTime = sharedTime; uniforms.uScale = sharedScale; uniforms.uAtlas.value = atlas;
    this.mat = new THREE.ShaderMaterial({
      uniforms, vertexShader: PART_VERT, fragmentShader: PART_FRAG(additive),
      transparent: true, depthWrite: false, depthTest: true, fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 1001 : 1000;
    this.points.name = additive ? 'FX_particles_add' : 'FX_particles_normal';
    this.points.matrixAutoUpdate = false;
  }
  PSys.prototype.emit = function (x, y, z, vx, vy, vz, birth, life, alpha, s0, s1, c0, c1, tex, spin, rot0, stretch, grav, drag, turb, floorY, floorMode) {
    const i = this.n; if (i >= this.max) return -1;
    const i2 = i * 2, i3 = i * 3, i4 = i * 4, i6 = i * 6;
    const pos = this.pos, vel = this.vel;
    pos[i3] = x; pos[i3 + 1] = y; pos[i3 + 2] = z;
    vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
    this.life[i3] = birth; this.life[i3 + 1] = life; this.life[i3 + 2] = alpha;
    this.size[i2] = s0; this.size[i2 + 1] = s1;
    const a = _col(c0), b = _col(c1);
    this.col[i3] = a[0]; this.col[i3 + 1] = a[1]; this.col[i3 + 2] = a[2];
    this.col2[i3] = b[0]; this.col2[i3 + 1] = b[1]; this.col2[i3 + 2] = b[2];
    this.misc[i4] = tex; this.misc[i4 + 1] = spin; this.misc[i4 + 2] = rot0; this.misc[i4 + 3] = stretch;
    this.phys[i6] = grav; this.phys[i6 + 1] = drag; this.phys[i6 + 2] = turb; this.phys[i6 + 3] = _rnd() * 100;
    this.phys[i6 + 4] = floorY; this.phys[i6 + 5] = floorMode;
    this.n = i + 1; this.dirty = true;
    return i;
  };
  PSys.prototype._copy = function (from, to) {
    const f2 = from * 2, t2 = to * 2, f3 = from * 3, t3 = to * 3, f4 = from * 4, t4 = to * 4, f6 = from * 6, t6 = to * 6;
    for (let k = 0; k < 3; k++) { this.pos[t3 + k] = this.pos[f3 + k]; this.vel[t3 + k] = this.vel[f3 + k]; this.life[t3 + k] = this.life[f3 + k]; this.col[t3 + k] = this.col[f3 + k]; this.col2[t3 + k] = this.col2[f3 + k]; }
    this.size[t2] = this.size[f2]; this.size[t2 + 1] = this.size[f2 + 1];
    for (let k = 0; k < 4; k++) this.misc[t4 + k] = this.misc[f4 + k];
    for (let k = 0; k < 6; k++) this.phys[t6 + k] = this.phys[f6 + k];
  };
  PSys.prototype.update = function (dt, now) {
    let n = this.n, i = 0;
    const pos = this.pos, vel = this.vel, life = this.life, phys = this.phys;
    while (i < n) {
      const i3 = i * 3, age = now - life[i3];
      if (age >= life[i3 + 1]) { n--; if (i !== n) this._copy(n, i); this.dirty = true; continue; }
      if (age < 0) { i++; continue; }
      const i6 = i * 6, grav = phys[i6], drag = phys[i6 + 1], turb = phys[i6 + 2];
      let vx = vel[i3], vy = vel[i3 + 1], vz = vel[i3 + 2];
      if (grav !== 0) vy -= GRAV * grav * dt;
      if (drag !== 0) { const d = 1 - drag * dt; if (d > 0) { vx *= d; vy *= d; vz *= d; } else { vx = vy = vz = 0; } }
      if (turb !== 0) {
        const ph = now * 1.9 + phys[i6 + 3];
        vx += Math.sin(ph + pos[i3 + 1] * 1.7) * turb * dt;
        vz += Math.cos(ph * 1.31 + pos[i3] * 1.3) * turb * dt;
        vy += Math.sin(ph * 0.73) * turb * 0.35 * dt;
      }
      let px = pos[i3] + vx * dt, py = pos[i3 + 1] + vy * dt, pz = pos[i3 + 2] + vz * dt;
      const fl = phys[i6 + 4];
      if (fl > NO_FLOOR && py < fl) {
        if (phys[i6 + 5] > 0.5) { life[i3 + 1] = age; }               // kill on floor (next pass removes it)
        else { py = fl; vy = vy < 0 ? -vy * 0.25 : vy; vx *= 0.6; vz *= 0.6; }
      }
      vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
      pos[i3] = px; pos[i3 + 1] = py; pos[i3 + 2] = pz;
      i++;
    }
    this.n = n;
    this.geom.setDrawRange(0, n);
    this.points.visible = n > 0;
    if (n > 0) {
      upload(this.aPos, n * 3); upload(this.aVel, n * 3);
      if (this.dirty) { upload(this.aLife, n * 3); upload(this.aSize, n * 2); upload(this.aColor, n * 3); upload(this.aColor2, n * 3); upload(this.aMisc, n * 4); }
    }
    this.dirty = false;
  };
  function upload(attr, count) {
    if (typeof attr.clearUpdateRanges === 'function') { attr.clearUpdateRanges(); attr.addUpdateRange(0, count); }
    else if (attr.updateRange) { attr.updateRange.offset = 0; attr.updateRange.count = count; }
    attr.needsUpdate = true;
  }

  // ------------------------------------------------------------------------------------------------ instanced mesh FX
  const INST_VERT = (jitter) => /* glsl */`
    uniform float uTime;
    attribute vec3 iColor; attribute vec4 iParams;
    varying vec2 vUv; varying vec3 vColor; varying vec4 vP; varying float vFres;
    #include <fog_pars_vertex>
    void main() {
      vUv = uv; vColor = iColor; vP = iParams;
      #ifdef USE_INSTANCING
        mat4 im = instanceMatrix;
      #else
        mat4 im = mat4(1.0);
      #endif
      vec4 wp = modelMatrix * im * vec4(position, 1.0);
      ${jitter ? `
      vec3 ax = normalize(im[0].xyz); vec3 az = normalize(im[2].xyz);
      float y = position.y + 0.5;
      float env = sin(y * 3.14159);
      float sd = iParams.z; float tt = floor(uTime * 28.0);
      float j1 = sin(y * 41.0 + sd + tt * 1.7) + 0.6 * sin(y * 97.0 + sd * 2.0 - tt * 2.3) + 0.35 * sin(y * 223.0 + tt * 3.1);
      float j2 = cos(y * 37.0 - sd + tt * 1.3) + 0.6 * cos(y * 89.0 + sd * 3.0 + tt * 2.9) + 0.35 * cos(y * 211.0 - tt * 2.2);
      wp.xyz += (ax * j1 + az * j2) * iParams.w * env;` : ''}
      vec4 mvPosition = viewMatrix * wp;
      vec3 n = normalize(mat3(modelMatrix) * mat3(im) * normal);
      vec3 vn = normalize((viewMatrix * vec4(n, 0.0)).xyz);
      vFres = abs(dot(vn, normalize(-mvPosition.xyz)));
      gl_Position = projectionMatrix * mvPosition;
      #include <fog_vertex>
    }`;
  const FOG_FADE = /* glsl */`
    #ifdef USE_FOG
      #ifdef FOG_EXP2
        float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
      #else
        float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
      #endif
      col *= (1.0 - fogFactor);
    #endif`;
  const ARC_FRAG = /* glsl */`
    uniform float uTime;
    varying vec2 vUv; varying vec3 vColor; varying vec4 vP; varying float vFres;
    #include <fog_pars_fragment>
    void main() {
      float u = vUv.x, v = vUv.y, mode = vP.w, a = 0.0;
      vec3 col = vColor;
      if (mode < 0.5) {                                   // sweeping blade arc: x = arc fraction, y = head, z = alpha
        float trail = vP.x * 0.8; float head = vP.y; float tail = max(head - trail, 0.0);
        if (u > head || u < tail) discard;
        float k = clamp((u - tail) / max(head - tail, 1e-4), 0.0, 1.0);
        float along = pow(k, 1.25);
        float radial = smoothstep(0.0, 0.22, v) * (1.0 - smoothstep(0.9, 1.0, v)) * (0.12 + 0.88 * v * v);
        float rim = smoothstep(0.76, 0.88, v) * (1.0 - smoothstep(0.9, 0.98, v));
        a = (along * radial + rim * along * 0.9) * vP.z;
        col = mix(col, vec3(1.0), along * (rim * 0.9 + radial * 0.3));
      } else if (mode < 1.5) {                            // expanding ring: x = band half-width, z = alpha
        float band = 1.0 - smoothstep(0.0, vP.x, abs(v - 0.74));
        float inner = smoothstep(0.0, 0.5, v) * 0.35 * (1.0 - v);
        a = (band + inner) * vP.z;
        col = mix(col, vec3(1.0), band * 0.35);
      } else {                                            // thrust spike: x = angular half-width, z = alpha
        float du = abs(fract(u + 0.5) - 0.5);
        float ang = 1.0 - smoothstep(0.0, vP.x, du);
        a = ang * pow(v, 0.6) * vP.z;
        col = mix(col, vec3(1.0), pow(ang, 2.0) * v * 0.85);
      }
      if (a <= 0.003) discard;
      ${FOG_FADE}
      gl_FragColor = vec4(col * 1.45, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  const BEAM_FRAG = /* glsl */`
    uniform float uTime;
    varying vec2 vUv; varying vec3 vColor; varying vec4 vP; varying float vFres;
    #include <fog_pars_fragment>
    void main() {
      float age = uTime - vP.x; float t = clamp(age / max(vP.y, 1e-4), 0.0, 1.0);
      if (age < 0.0) discard;
      float fade = smoothstep(0.0, 0.04, t) * (1.0 - smoothstep(0.35, 1.0, t));
      float core = pow(vFres, 1.8);
      float scroll = 0.8 + 0.2 * sin((vUv.y * 7.0 - uTime * 5.0) * 6.2832 + vP.z);
      float flick = 0.82 + 0.18 * sin(uTime * 73.0 + vP.z * 7.0);
      float endFade = smoothstep(0.0, 0.05, vUv.y) * (1.0 - smoothstep(0.95, 1.0, vUv.y));
      float a = core * fade * scroll * flick * endFade;
      if (a <= 0.003) discard;
      vec3 col = mix(vColor, vec3(1.0), pow(vFres, 6.0) * 0.6) * 1.6;
      ${FOG_FADE}
      gl_FragColor = vec4(col, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;
  const PILLAR_FRAG = /* glsl */`
    uniform float uTime;
    varying vec2 vUv; varying vec3 vColor; varying vec4 vP; varying float vFres;
    #include <fog_pars_fragment>
    void main() {
      float age = uTime - vP.x; float life = vP.y;
      if (age < 0.0) discard;
      float t = life > 0.0 ? clamp(age / life, 0.0, 1.0) : 0.0;
      float fade = smoothstep(0.0, 0.15, age) * (life > 0.0 ? (1.0 - smoothstep(0.55, 1.0, t)) : 1.0);
      float vert = pow(1.0 - vUv.y, 1.5) * smoothstep(0.0, 0.05, vUv.y);
      float pulse = 0.86 + 0.14 * sin(uTime * 2.1 + vP.z);
      float bands = 0.88 + 0.12 * sin(vUv.y * 26.0 - uTime * 1.6 + vP.z * 3.0);
      float a = pow(vFres, 2.4) * vert * pulse * bands * fade * vP.w;
      if (a <= 0.003) discard;
      vec3 col = mix(vColor, vec3(1.0), pow(vFres, 7.0) * 0.55) * 1.5;
      ${FOG_FADE}
      gl_FragColor = vec4(col, a);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  function ringGeometry(inner, outer, segs) {          // XY plane, uv.x = angle fraction, uv.y = radial fraction
    const pos = [], nrm = [], uv = [], idx = [];
    for (let i = 0; i <= segs; i++) {
      const a = i / segs * TAU, c = Math.cos(a), s = Math.sin(a);
      pos.push(c * inner, s * inner, 0, c * outer, s * outer, 0);
      nrm.push(0, 0, 1, 0, 0, 1);
      uv.push(i / segs, 0, i / segs, 1);
      if (i < segs) { const b = i * 2; idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }
  function instMaterial(vert, frag, side) {
    const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uTime: { value: 0 } }]);
    uniforms.uTime = sharedTime;
    return new THREE.ShaderMaterial({ uniforms, vertexShader: vert, fragmentShader: frag, transparent: true, depthWrite: false, depthTest: true, fog: true, blending: THREE.AdditiveBlending, side: side || THREE.DoubleSide });
  }
  function newRec() {
    return { on: false, h: null, birth: 0, life: 0, period: 0, pos: new THREE.Vector3(), off: new THREE.Vector3(), quat: new THREE.Quaternion(), scl: new THREE.Vector3(1, 1, 1),
      r: 1, g: 1, b: 1, p0: 0, p1: 0, p2: 1, p3: 0, mode: 0, fn: null, bill: false, a: 0, b2: 0, c: 0, d: 0 };
  }
  function InstSys(geom, mat, cap, name, order) {
    this.cap = cap; this.count = 0;
    const m = this.mesh = new THREE.InstancedMesh(geom, mat, cap);
    m.count = 0; m.frustumCulled = false; m.name = name; m.renderOrder = order; m.visible = false; m.matrixAutoUpdate = false;
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.color = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3); this.color.setUsage(THREE.DynamicDrawUsage);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); this.params.setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('iColor', this.color); geom.setAttribute('iParams', this.params);
    this.recs = []; for (let i = 0; i < cap; i++) this.recs.push(newRec());
  }
  InstSys.prototype.alloc = function (h) {
    for (let i = 0; i < this.cap; i++) { const r = this.recs[i]; if (!r.on) { r.on = true; r.h = h || null; r.off.set(0, 0, 0); r.period = 0; r.bill = false; r.quat.identity(); r.scl.set(1, 1, 1); if (h) h.insts.push(r); return r; } }
    return null;
  };
  InstSys.prototype.update = function (now, cam) {
    let k = 0; const col = this.color.array, par = this.params.array;
    for (let i = 0; i < this.cap; i++) {
      const r = this.recs[i]; if (!r.on) continue;
      if (r.h && !r.h.alive) { r.on = false; r.h = null; continue; }
      const age = now - r.birth;
      if (r.life > 0 && age >= r.life) { r.on = false; if (r.h) { const j = r.h.insts.indexOf(r); if (j >= 0) r.h.insts.splice(j, 1); } r.h = null; continue; }
      if (age < 0) continue;
      if (r.h) r.pos.copy(r.h.pos).add(r.off);
      let t = r.life > 0 ? age / r.life : (r.period > 0 ? (age % r.period) / r.period : age);
      if (r.fn) r.fn(r, t, age, now, cam);
      if (r.bill && cam) r.quat.copy(cam.quaternion);
      _m4.compose(r.pos, r.quat, r.scl);
      this.mesh.setMatrixAt(k, _m4);
      col[k * 3] = r.r; col[k * 3 + 1] = r.g; col[k * 3 + 2] = r.b;
      par[k * 4] = r.p0; par[k * 4 + 1] = r.p1; par[k * 4 + 2] = r.p2; par[k * 4 + 3] = r.p3;
      k++;
    }
    this.count = k; this.mesh.count = k; this.mesh.visible = k > 0;
    if (k > 0) { this.mesh.instanceMatrix.needsUpdate = true; this.color.needsUpdate = true; this.params.needsUpdate = true; }
  };
  InstSys.prototype.countActive = function () { let n = 0; for (let i = 0; i < this.cap; i++) if (this.recs[i].on) n++; return n; };

  const Q_FLAT = new THREE.Quaternion().setFromAxisAngle(XAXIS, -PI / 2);   // XY ring → horizontal (XZ)
  const easeOut = (t) => 1 - (1 - t) * (1 - t);
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // per-frame record animators (no closures; state lives on the record)
  function fnArc(r, t) {                               // a = arc fraction, b2 = radius, c = base alpha
    r.p0 = r.a; r.p1 = r.a * easeOutCubic(t); r.p2 = r.c * (1 - t * t); r.p3 = 0;
    r.scl.set(r.b2, r.b2 * 0.92, r.b2);
  }
  function fnThrust(r, t) {                            // a = angular half width, b2 = length, c = alpha, d = width
    const grow = 0.3 + 0.7 * smooth(0, 0.45, t);
    r.p0 = r.a; r.p1 = 0; r.p2 = r.c * (1 - t * t); r.p3 = 2;
    r.scl.set(r.b2 * grow, r.d, r.d);
  }
  function fnRing(r, t) {                              // a = r0, b2 = r1, c = alpha, d = band width
    const rad = r.a + (r.b2 - r.a) * easeOut(t);
    r.p0 = r.d; r.p1 = 0; r.p2 = r.c * Math.pow(1 - t, 1.4) * smooth(0, 0.08, t); r.p3 = 1;
    r.scl.set(rad, rad, rad);
  }
  function fnRingLoop(r, t) {                          // looping pulse ring (period on record)
    const rad = r.a + (r.b2 - r.a) * easeOut(t);
    r.p0 = r.d; r.p1 = 0; r.p2 = r.c * (1 - t) * smooth(0, 0.1, t); r.p3 = 1;
    r.scl.set(rad, rad, rad);
  }
  function fnPillar(r, t, age) {                       // a = width, b2 = height, c = seed, d = intensity, life on record
    const grow = smooth(0, 0.35, age);
    r.p0 = r.birth; r.p1 = r.life; r.p2 = r.c; r.p3 = r.d;
    r.scl.set(r.a, r.b2 * grow + 0.01, r.a);
  }
  function fnBeam(r) {                                 // static: params written at spawn (birth, life, seed, jitter)
    r.p0 = r.birth; r.p1 = r.life; r.p2 = r.c; r.p3 = r.d;
  }

  // ------------------------------------------------------------------------------------------------ runtime state
  let scene = null, ready = false, now = 0, A = null, N = null, arcs = null, beams = null, pillars = null, atlas = null;
  let flashLight = null, flashPeak = 0, flashDur = 0, flashAge = 1e9;
  let viewportH = 0, lastCam = null;
  const EMPTY = {};
  let slashCounter = 0;

  function hexOf(c, def) {
    if (typeof c === 'number' && c === c) return c;
    if (c && typeof c === 'object' && c.isColor) return c.getHex();
    if (typeof c === 'string' && c[0] === '#' && c.length === 7) { const n = parseInt(c.slice(1), 16); if (n === n) return n; }
    return def;
  }
  function lighten(hex, t) { return typeof G.lerpColor === 'function' ? G.lerpColor(hex, 0xffffff, t) : hex; }

  // ------------------------------------------------------------------------------------------------ handles
  let hid = 0;
  const liveHandles = [];
  function Handle(kind, x, y, z, o) {
    this.id = ++hid; this.kind = kind; this.pos = new THREE.Vector3(x, y, z); this.alive = true; this.age = 0;
    this.target = (o.target && posOf(o.target, _v1)) ? o.target : null;
    this.tOff = typeof o.yOff === 'number' ? o.yOff : 0;
    this.ems = []; this.insts = []; this.light = null; this.lightBase = 0; this.lightAmp = 0; this.persistent = false; this.proj = null;
  }
  Handle.prototype.stop = function () { stopHandle(this); };
  Handle.prototype.setPos = function (x, y, z) {
    if (x && typeof x === 'object') { if (validPos(x)) this.pos.set(x.x, x.y, x.z); }
    else if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') this.pos.set(x, y, z);
    return this;
  };
  function stopHandle(h) {
    if (!h || !h.alive) return;
    h.alive = false;
    for (let i = 0; i < h.ems.length; i++) releaseEmitter(h.ems[i]);
    h.ems.length = 0;
    for (let i = 0; i < h.insts.length; i++) { h.insts[i].on = false; h.insts[i].h = null; }
    h.insts.length = 0;
    if (h.light) { h.light.intensity = h.lightBase; h.light = null; }
    if (h.proj) { h.proj.done = true; h.proj = null; }
    const j = liveHandles.indexOf(h); if (j >= 0) liveHandles.splice(j, 1);
  }

  // ------------------------------------------------------------------------------------------------ emitters
  function Emitter() { this.on = false; this.h = null; this.prog = null; this.rate = 0; this.acc = 0; this.remaining = 0; this.age = 0; this.ox = 0; this.oy = 0; this.oz = 0; this.color = 0xffffff; this.color2 = 0xffffff; this.scale = 1; this.radius = 0.5; this.k = 0; this.dur = 1; this.flag = 0; }
  const emPool = [], liveEms = [];
  function addEmitter(h, prog, rate, duration, ox, oy, oz, color, color2, scale, radius) {
    const em = emPool.pop() || new Emitter();
    em.on = true; em.h = h; em.prog = prog; em.rate = rate; em.acc = 0.999; em.remaining = duration > 0 ? duration : Infinity; em.dur = duration > 0 ? duration : 1;
    em.age = 0; em.ox = ox || 0; em.oy = oy || 0; em.oz = oz || 0; em.color = color; em.color2 = color2; em.scale = scale || 1; em.radius = radius || 0.5; em.k = 0; em.flag = 0;
    liveEms.push(em); h.ems.push(em);
    if (!(duration > 0)) h.persistent = true;
    return em;
  }
  function releaseEmitter(em) {
    if (!em.on) return;
    em.on = false; em.h = null; em.prog = null;
    const j = liveEms.indexOf(em); if (j >= 0) liveEms.splice(j, 1);
    emPool.push(em);
  }

  // ------------------------------------------------------------------------------------------------ primitives
  function glow(x, y, z, s0, s1, c0, c1, life, alpha, delay) {
    A.emit(x, y, z, 0, 0, 0, now + (delay || 0), life, alpha, s0, s1, c0, c1, TEX.GLOW, 0, 0, 0, 0, 0, 0, NO_FLOOR, 0);
  }
  function sparks(n, x, y, z, speed, c0, c1, lifeA, lifeB, size, grav, floor, dx, dy, dz, bias, stretch, tex, delay) {
    for (let i = 0; i < n; i++) {
      let ux = rr(-1, 1), uy = rr(-1, 1), uz = rr(-1, 1);
      const l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1; ux /= l; uy /= l; uz /= l;
      const v = speed * rr(0.35, 1);
      A.emit(x + ux * 0.05, y + uy * 0.05, z + uz * 0.05, ux * v + dx * bias * speed, uy * v + dy * bias * speed, uz * v + dz * bias * speed,
        now + (delay || 0), rr(lifeA, lifeB), 1, size * rr(0.7, 1.3), size * 0.25, c0, c1, tex, 0, 0, stretch, grav, 1.4, 0, floor, 1);
    }
  }
  function puffs(n, x, y, z, c0, c1, s0, s1, lifeA, lifeB, spd, rise, alpha, floor, dx, dz, bias) {
    for (let i = 0; i < n; i++) {
      const a = rr(0, TAU), v = spd * rr(0.3, 1);
      N.emit(x + Math.cos(a) * 0.12, y + rr(0.02, 0.15), z + Math.sin(a) * 0.12, Math.cos(a) * v + dx * bias, rise * rr(0.5, 1.2), Math.sin(a) * v + dz * bias,
        now, rr(lifeA, lifeB), alpha, s0 * rr(0.8, 1.2), s1 * rr(0.8, 1.3), c0, c1, TEX.PUFF, rr(-1.3, 1.3), rr(0, TAU), 0, -0.01, 1.6, 0.25, floor, 0);
    }
  }
  function twinkles(n, x, y, z, radius, c0, c1, lifeA, lifeB, size, rise, delayMax, tex) {
    for (let i = 0; i < n; i++) {
      A.emit(x + rr(-radius, radius), y + rr(-radius, radius) * 0.8, z + rr(-radius, radius), rr(-0.1, 0.1), rise * rr(0.5, 1.2), rr(-0.1, 0.1),
        now + rr(0, delayMax), rr(lifeA, lifeB), 1, size * rr(0.6, 1.4), size * 0.2, c0, c1, tex, rr(-3, 3), rr(0, TAU), 0, -0.02, 0.4, 0.3, NO_FLOOR, 0);
    }
  }
  function motes(n, x, y, z, c0, c1, size, speed, lifeA, lifeB, floor, alpha) {
    for (let i = 0; i < n; i++) {
      let ux = rr(-1, 1), uy = rr(0.2, 1), uz = rr(-1, 1);
      const l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1; const v = speed * rr(0.4, 1);
      N.emit(x, y, z, ux / l * v, uy / l * v, uz / l * v, now, rr(lifeA, lifeB), alpha, size * rr(0.7, 1.3), size * 0.6, c0, c1, TEX.EMBER, 0, 0, 0, 1, 0.5, 0, floor, 1);
    }
  }
  function flash(x, y, z, color, intensity, dur) {
    if (!flashLight) return;
    flashLight.position.set(x, y + 0.6, z); flashLight.color.setHex(color);
    flashPeak = intensity; flashDur = dur; flashAge = 0; flashLight.intensity = intensity;
  }
  // instanced mesh spawners --------------------------------------------------------------------------
  function setCol(r, hex) { const c = _col(hex); r.r = c[0]; r.g = c[1]; r.b = c[2]; }
  function ringFx(h, ox, oy, oz, r0, r1, life, color, alpha, band, bill, delay) {
    const r = arcs.alloc(h); if (!r) return null;
    r.off.set(ox, oy, oz); r.pos.copy(h.pos).add(r.off);
    r.birth = now + (delay || 0); r.life = life; r.a = r0; r.b2 = r1; r.c = alpha; r.d = band || 0.22; r.fn = fnRing; r.mode = 1;
    r.bill = !!bill; if (!bill) r.quat.copy(Q_FLAT);
    setCol(r, color); r.scl.set(r0, r0, r0); fnRing(r, 0);
    return r;
  }
  function ringLoopFx(h, oy, r0, r1, period, color, alpha, band) {
    const r = arcs.alloc(h); if (!r) return null;
    r.off.set(0, oy, 0); r.pos.copy(h.pos).add(r.off);
    r.birth = now; r.life = -1; r.period = period; r.a = r0; r.b2 = r1; r.c = alpha; r.d = band || 0.22; r.fn = fnRingLoop; r.mode = 1;
    r.quat.copy(Q_FLAT); setCol(r, color); fnRingLoop(r, 0);
    return r;
  }
  function arcBasis(dir, normal, arcFrac, out) {          // e1 = start of the arc (centre of arc points along dir)
    _q1.setFromAxisAngle(normal, -arcFrac * PI);
    _v3.copy(dir).applyQuaternion(_q1).normalize();       // e1
    _v4.crossVectors(normal, _v3).normalize();            // e2
    _m4.makeBasis(_v3, _v4, normal);
    out.setFromRotationMatrix(_m4);
  }
  function arcFx(h, dirIn, radius, arcFrac, color, life, variant, alpha) {
    const r = arcs.alloc(h); if (!r) return null;
    const dir = _v5.copy(dirIn), right = _v6;
    right.crossVectors(dir, UP); if (right.lengthSq() < 1e-6) right.set(1, 0, 0); right.normalize();
    const n = _v1;
    switch (variant) {
      case 1: n.copy(UP).multiplyScalar(-1).addScaledVector(right, -0.3); break;            // left → right
      case 2: n.copy(UP).addScaledVector(right, 1.1).addScaledVector(dir, 0.2); break;       // diagonal
      case 3: n.copy(UP).multiplyScalar(-1).addScaledVector(right, 1.1); break;              // diagonal, other way
      case 4: n.crossVectors(UP, dir); break;                                               // overhead chop
      default: n.copy(UP).addScaledVector(right, 0.3); break;                               // right → left
    }
    n.normalize();
    // make dir perpendicular to n for the basis
    _v3.copy(dir).addScaledVector(n, -dir.dot(n)); if (_v3.lengthSq() < 1e-6) _v3.copy(dir); _v3.normalize();
    _v4.copy(_v3);
    arcBasis(_v4, n, arcFrac, r.quat);
    r.off.set(dir.x * 0.35, 1.05, dir.z * 0.35); r.pos.copy(h.pos).add(r.off);
    r.birth = now; r.life = life; r.a = arcFrac; r.b2 = radius; r.c = alpha; r.fn = fnArc; r.mode = 0; r.bill = false;
    setCol(r, color); fnArc(r, 0);
    return r;
  }
  function thrustFx(h, dirIn, length, width, color, life, alpha) {
    const r = arcs.alloc(h); if (!r) return null;
    const dir = _v5.copy(dirIn), side = _v6;
    side.crossVectors(UP, dir); if (side.lengthSq() < 1e-6) side.set(1, 0, 0); side.normalize();
    _v3.copy(dir).normalize(); _v4.copy(UP);
    _m4.makeBasis(_v3, _v4, side); r.quat.setFromRotationMatrix(_m4);
    r.off.set(dir.x * 0.2, 1.1, dir.z * 0.2); r.pos.copy(h.pos).add(r.off);
    r.birth = now; r.life = life; r.a = 0.07; r.b2 = length; r.c = alpha; r.d = width; r.fn = fnThrust; r.mode = 2; r.bill = false;
    setCol(r, color); fnThrust(r, 0);
    return r;
  }
  function pillarFx(h, oy, width, height, color, life, intensity) {
    const r = pillars.alloc(h); if (!r) return null;
    r.off.set(0, oy, 0); r.pos.copy(h.pos).add(r.off);
    r.birth = now; r.life = life; r.a = width; r.b2 = height; r.c = _rnd() * 6.28; r.d = intensity; r.fn = fnPillar;
    r.quat.identity(); setCol(r, color); fnPillar(r, 0, 0);
    return r;
  }
  function beamFx(from, to, color, life, width, jitter, seed, intensity) {
    const r = beams.alloc(null); if (!r) return null;
    _v3.set(to.x - from.x, to.y - from.y, to.z - from.z);
    const len = _v3.length(); if (len < 1e-4) { r.on = false; return null; }
    _v3.multiplyScalar(1 / len);
    r.pos.set((from.x + to.x) * 0.5, (from.y + to.y) * 0.5, (from.z + to.z) * 0.5);
    r.quat.setFromUnitVectors(UP, _v3);
    r.scl.set(width * 0.5, len, width * 0.5);
    r.birth = now; r.life = life; r.c = typeof seed === 'number' ? seed : _rnd() * 6.28; r.d = jitter; r.fn = fnBeam;
    setCol(r, color); const it = intensity > 0 ? intensity : 1; r.r *= it; r.g *= it; r.b *= it; fnBeam(r);
    return r;
  }

  // ------------------------------------------------------------------------------------------------ emitter programs
  const EP = {
    smoke(em, x, y, z) {
      const s = em.scale;
      N.emit(x + rr(-0.15, 0.15) * s, y, z + rr(-0.15, 0.15) * s, 0.25 + rr(-0.15, 0.15), rr(0.8, 1.3) * s, rr(-0.15, 0.15),
        now, rr(3.2, 4.6), 0.5, 0.45 * s, 2.2 * s, em.color, em.color2, TEX.PUFF, rr(-0.5, 0.5), rr(0, TAU), 0, -0.012, 0.15, 0.5, NO_FLOOR, 0);
    },
    flame(em, x, y, z) {
      const s = em.scale;
      A.emit(x + rr(-0.16, 0.16) * s, y + rr(0, 0.12) * s, z + rr(-0.16, 0.16) * s, rr(-0.2, 0.2), rr(1.0, 1.9) * s, rr(-0.2, 0.2),
        now, rr(0.4, 0.75), 1, rr(0.45, 0.7) * s, 0.1 * s, em.color, em.color2, TEX.FLAME, rr(-1, 1), rr(-0.35, 0.35), 0, 0, 0.6, 0.8, NO_FLOOR, 0);
    },
    ember(em, x, y, z) {
      const s = em.scale;
      A.emit(x + rr(-0.2, 0.2) * s, y + 0.2 * s, z + rr(-0.2, 0.2) * s, rr(-0.4, 0.4), rr(0.8, 2.0), rr(-0.4, 0.4),
        now, rr(1.0, 2.2), 1, rr(0.04, 0.09) * s, 0.015, 0xffe0a0, 0xff5a00, TEX.EMBER, 0, 0, 0, -0.15, 0.4, 1.4, NO_FLOOR, 0);
    },
    fireglow(em, x, y, z) {
      const s = em.scale;
      A.emit(x, y + 0.3 * s, z, 0, 0.25, 0, now, 0.6, 0.35, 1.2 * s, 0.8 * s, 0xffa040, 0xff5010, TEX.GLOW, 0, 0, 0, 0, 0, 0, NO_FLOOR, 0);
    },
    firesmoke(em, x, y, z) {
      const s = em.scale;
      N.emit(x, y + 0.7 * s, z, rr(-0.1, 0.1), rr(0.7, 1.1), rr(-0.1, 0.1), now, rr(2.2, 3.2), 0.3, 0.3 * s, 1.5 * s, 0x4a4540, 0x8a857f, TEX.PUFF,
        rr(-0.6, 0.6), rr(0, TAU), 0, -0.012, 0.2, 0.4, NO_FLOOR, 0);
    },
    heal(em, x, y, z) {
      const s = em.scale, a = rr(0, TAU), rad = rr(0.15, 0.75) * s, star = _rnd() < 0.55;
      A.emit(x + Math.cos(a) * rad, y + rr(0.05, 1.6) * s, z + Math.sin(a) * rad, rr(-0.1, 0.1), rr(0.6, 1.2), rr(-0.1, 0.1),
        now, rr(0.7, 1.2), 1, (star ? rr(0.22, 0.4) : rr(0.14, 0.24)) * s, 0.03, em.color, em.color2, star ? TEX.STAR : TEX.GLOW, rr(-2, 2), rr(0, TAU), 0, -0.03, 0.3, 0.4, NO_FLOOR, 0);
    },
    swirl(em, x, y, z) {
      const s = em.scale, k = em.k++ % 3, ang = em.age * 9 + k * TAU / 3, rad = 0.62 * s, hgt = (em.age * 1.8 + k * 0.6) % 1.9;
      const cx = Math.cos(ang), sz = Math.sin(ang);
      A.emit(x + cx * rad, y + hgt, z + sz * rad, -sz * rad * 3, 1.2, cx * rad * 3, now, rr(0.45, 0.65), 1, rr(0.2, 0.34) * s, 0.04, em.color, em.color2,
        _rnd() < 0.3 ? TEX.STAR : TEX.GLOW, 0, 0, 0, 0, 0.8, 0, NO_FLOOR, 0);
    },
    rise(em, x, y, z) {
      const s = em.scale, a = rr(0, TAU), rad = rr(0.2, 1.3) * s;
      A.emit(x + Math.cos(a) * rad, y + rr(0, 0.6), z + Math.sin(a) * rad, 0, rr(1.6, 3.2), 0, now, rr(1.1, 1.8), 1, rr(0.16, 0.36), 0.03, em.color, em.color2,
        _rnd() < 0.5 ? TEX.STAR : TEX.GLOW, rr(-3, 3), rr(0, TAU), 0, -0.05, 0.25, 0.5, NO_FLOOR, 0);
    },
    beaconRise(em, x, y, z) {
      const a = rr(0, TAU), rad = rr(0.1, 0.9) * em.scale;
      A.emit(x + Math.cos(a) * rad, y + rr(0, 1.0), z + Math.sin(a) * rad, 0, rr(0.5, 1.1), 0, now, rr(2.0, 3.2), 1, rr(0.12, 0.26), 0.03, em.color, em.color2,
        _rnd() < 0.6 ? TEX.STAR : TEX.GLOW, rr(-2, 2), rr(0, TAU), 0, -0.01, 0.1, 0.35, NO_FLOOR, 0);
    },
    sparkle(em, x, y, z) {
      const r = em.radius;
      A.emit(x + rr(-r, r), y + rr(-r * 0.6, r), z + rr(-r, r), rr(-0.05, 0.05), rr(0.05, 0.25), rr(-0.05, 0.05), now, rr(0.45, 1.0), 1, rr(0.1, 0.26) * em.scale, 0.03, em.color, em.color2,
        _rnd() < 0.7 ? TEX.STAR : TEX.GLOW, rr(-4, 4), rr(0, TAU), 0, 0, 0, 0.2, NO_FLOOR, 0);
    },
    trailArrow(em, x, y, z) {
      const st = (em.ox || em.oy || em.oz) ? 1.2 : 0;
      A.emit(x, y, z, em.ox * 1.5, em.oy * 1.5, em.oz * 1.5, now, rr(0.2, 0.32), 0.45, 0.16, 0.32, 0xffffff, 0xc8d4dc, st ? TEX.STREAK : TEX.GLOW, 0, 0, st, 0, 7, 0, NO_FLOOR, 0);
    },
    trailBolt(em, x, y, z) {
      const s = em.scale;
      const st = (em.ox || em.oy || em.oz) ? 1.2 : 0;
      A.emit(x, y, z, em.ox * 1.5, em.oy * 1.5, em.oz * 1.5, now, rr(0.25, 0.4), 1, rr(0.3, 0.45) * s, 0.06, em.color, em.color2, st ? TEX.STREAK : TEX.GLOW, 0, 0, st, 0, 7, 0, NO_FLOOR, 0);
      if (_rnd() < 0.5) A.emit(x + rr(-0.06, 0.06), y + rr(-0.06, 0.06), z + rr(-0.06, 0.06), rr(-0.3, 0.3), rr(-0.1, 0.4), rr(-0.3, 0.3), now, rr(0.3, 0.55), 1, rr(0.18, 0.3) * s, 0.04, em.color, em.color2,
        _rnd() < 0.25 ? TEX.STAR : TEX.GLOW, rr(-2, 2), rr(0, TAU), 0, 0, 1.5, 0.3, NO_FLOOR, 0);
    },
    trailFire(em, x, y, z) {
      const s = em.scale;
      A.emit(x + rr(-0.06, 0.06), y + rr(-0.06, 0.06), z + rr(-0.06, 0.06), rr(-0.3, 0.3), rr(0.3, 1.2), rr(-0.3, 0.3), now, rr(0.3, 0.55), 1, rr(0.25, 0.4) * s, 0.05, 0xffd070, 0xff3800,
        _rnd() < 0.5 ? TEX.FLAME : TEX.GLOW, rr(-2, 2), rr(0, TAU), 0, -0.05, 1.2, 0.5, NO_FLOOR, 0);
      if (_rnd() < 0.35) A.emit(x, y, z, rr(-0.8, 0.8), rr(0.2, 1.5), rr(-0.8, 0.8), now, rr(0.6, 1.1), 1, 0.05, 0.01, 0xffe0a0, 0xff5a00, TEX.EMBER, 0, 0, 0, -0.1, 0.5, 1.2, NO_FLOOR, 0);
    },
    bubbles(em, x, y, z) {
      const s = em.scale;
      A.emit(x + rr(-0.25, 0.25) * s, y, z + rr(-0.25, 0.25) * s, 0, rr(0.5, 1.0), 0, now, rr(1.0, 2.0), 0.8, rr(0.05, 0.13) * s, rr(0.1, 0.2) * s, 0xe0f6ff, 0xffffff, TEX.BUBBLE,
        0, 0, 0, 0, 0.2, 0.7, NO_FLOOR, 0);
    },
    spiral(em, x, y, z) {
      const s = em.scale, t = clamp(em.age / em.dur, 0, 1), k = em.k++ % 3, ang = em.age * 11 + k * TAU / 3;
      const rad = (em.flag ? t : 1 - t) * 1.3 * s + 0.05, cx = Math.cos(ang), sz = Math.sin(ang);
      A.emit(x + cx * rad, y + rr(0, 2.2) * s, z + sz * rad, -sz * rad * 4, 1.6, cx * rad * 4, now, rr(0.4, 0.6), 1, rr(0.12, 0.22) * s, 0.03, em.color, em.color2,
        _rnd() < 0.35 ? TEX.STAR : TEX.GLOW, rr(-3, 3), rr(0, TAU), 0, 0, 1.0, 0, NO_FLOOR, 0);
    },
    qglow(em, x, y, z) {
      const s = em.scale;
      A.emit(x, y, z, 0, 0, 0, now, 1.0, 0.45, 0.55 * s, 0.85 * s, em.color, em.color2, TEX.GLOW, 0, 0, 0, 0, 0, 0, NO_FLOOR, 0);
      if (_rnd() < 0.5) A.emit(x + rr(-0.3, 0.3) * s, y + rr(-0.3, 0.3) * s, z + rr(-0.3, 0.3) * s, 0, 0.2, 0, now, rr(0.5, 0.9), 1, rr(0.06, 0.14) * s, 0.02, 0xffffff, em.color, TEX.STAR, rr(-3, 3), rr(0, TAU), 0, 0, 0, 0, NO_FLOOR, 0);
    },
    lootRise(em, x, y, z) {
      const s = em.scale, a = rr(0, TAU), rad = rr(0, 0.35) * s;
      A.emit(x + Math.cos(a) * rad, y + rr(0, 0.3), z + Math.sin(a) * rad, 0, rr(0.3, 0.7), 0, now, rr(1.2, 1.9), 1, rr(0.1, 0.22) * s, 0.03, em.color, em.color2,
        _rnd() < 0.7 ? TEX.STAR : TEX.GLOW, rr(-3, 3), rr(0, TAU), 0, -0.01, 0.1, 0.25, NO_FLOOR, 0);
    },
    frostMist(em, x, y, z) {
      const s = em.scale, a = rr(0, TAU), rad = rr(0, 0.5) * s;
      N.emit(x + Math.cos(a) * rad, y + rr(0, 0.4), z + Math.sin(a) * rad, Math.cos(a) * 0.3, rr(0.1, 0.3), Math.sin(a) * 0.3, now, rr(1.0, 1.6), 0.35, 0.5 * s, 1.3 * s, 0xcfefff, 0xdff6ff, TEX.PUFF,
        rr(-0.6, 0.6), rr(0, TAU), 0, -0.005, 0.8, 0.3, NO_FLOOR, 0);
    },
  };

  // ------------------------------------------------------------------------------------------------ effect catalogue
  const KINDS = {};
  KINDS.hit = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0xffb347), fl = groundAt(x, z, y - 1.2);
    dirOf(o, _v2);
    glow(x, y, z, 1.1 * sc, 0.3 * sc, 0xfff4d6, c, 0.16, 1, 0);
    glow(x, y, z, 0.35 * sc, 0.9 * sc, 0xffffff, c, 0.12, 0.8, 0);
    sparks(18, x, y, z, 5.5 * sc, 0xfff8e0, c, 0.25, 0.5, 0.14 * sc, 1.0, fl, _v2.x, _v2.y, _v2.z, 0.35, 0.09, TEX.STREAK, 0);
    sparks(8, x, y, z, 2.5 * sc, 0xffffff, c, 0.3, 0.6, 0.06 * sc, 0.6, fl, 0, 0, 0, 0, 0, TEX.EMBER, 0);
  };
  KINDS.crit = (h, x, y, z, o) => {
    const sc = (o.scale || 1) * 1.3, c = hexOf(o.color, 0xffc23d), fl = groundAt(x, z, y - 1.2);
    dirOf(o, _v2);
    glow(x, y, z, 2.0 * sc, 0.4 * sc, 0xffffff, c, 0.22, 1, 0);
    glow(x, y, z, 0.5 * sc, 1.6 * sc, 0xfff1b0, c, 0.3, 0.7, 0.02);
    sparks(28, x, y, z, 6.5 * sc, 0xfff6c8, c, 0.35, 0.65, 0.13 * sc, 1.0, fl, _v2.x, _v2.y, _v2.z, 0.25, 0.1, TEX.STREAK, 0);
    twinkles(10, x, y, z, 0.6 * sc, 0xffffff, c, 0.5, 0.9, 0.2 * sc, 0.6, 0.15, TEX.STAR);
    ringFx(h, 0, 0, 0, 0.25 * sc, 1.9 * sc, 0.4, c, 0.9, 0.2, true, 0);
    flash(x, y, z, c, 25 * sc, 0.25);
  };
  KINDS.slash = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0xffb648);
    dirOf(o, _v2);
    const variant = typeof o.variant === 'number' ? o.variant : [0, 1, 2, 4, 1, 3, 0, 2][(slashCounter++) & 7];
    arcFx(h, _v2, 1.6 * sc, 0.42, c, 0.28, variant, 1);
    sparks(6, x + _v2.x * 1.2, y + 1.05, z + _v2.z * 1.2, 2.5 * sc, 0xffffff, c, 0.2, 0.35, 0.06 * sc, 0.5, groundAt(x, z, y), _v2.x, 0, _v2.z, 0.4, 0.06, TEX.STREAK, 0.12);
  };
  KINDS.thrust = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0xffb648);
    dirOf(o, _v2);
    thrustFx(h, _v2, 2.6 * sc, 0.9 * sc, c, 0.26, 1);
    sparks(8, x + _v2.x * 2.1 * sc, y + 1.1, z + _v2.z * 2.1 * sc, 3 * sc, 0xffffff, c, 0.2, 0.35, 0.07 * sc, 0.6, groundAt(x, z, y), _v2.x, 0.2, _v2.z, 0.5, 0.07, TEX.STREAK, 0.1);
    glow(x + _v2.x * 2.1 * sc, y + 1.1, z + _v2.z * 2.1 * sc, 0.5 * sc, 0.15, 0xffffff, c, 0.18, 0.9, 0.1);
  };
  KINDS.spin = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0xffb648);
    dirOf(o, _v2);
    const r = arcs.alloc(h);
    if (r) {
      _v1.copy(UP).addScaledVector(_v2, 0.12).normalize();
      _v3.copy(_v2).addScaledVector(_v1, -_v2.dot(_v1)).normalize();
      arcBasis(_v3, _v1, 1.0, r.quat);
      r.off.set(0, 1.0, 0); r.pos.copy(h.pos).add(r.off);
      r.birth = now; r.life = 0.4; r.a = 1.0; r.b2 = 1.9 * sc; r.c = 1; r.fn = fnArc; r.mode = 0; r.bill = false;
      setCol(r, c); fnArc(r, 0);
    }
    for (let i = 0; i < 14; i++) {
      const a = rr(0, TAU), rad = 1.7 * sc;
      A.emit(x + Math.cos(a) * rad, y + rr(0.8, 1.25), z + Math.sin(a) * rad, -Math.sin(a) * 4 * sc, rr(0, 0.8), Math.cos(a) * 4 * sc, now + rr(0, 0.25), rr(0.25, 0.4), 1, 0.08 * sc, 0.02, 0xffffff, c, TEX.STREAK, 0, 0, 0.08, 0.5, 1.5, 0, NO_FLOOR, 0);
    }
    ringFx(h, 0, 1.0, 0, 0.6 * sc, 2.4 * sc, 0.45, c, 0.6, 0.18, false, 0.05);
  };
  KINDS.fire = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0xff7a1a), fl = groundAt(x, z, y - 1.2);
    glow(x, y, z, 1.8 * sc, 0.5 * sc, 0xffe8a0, c, 0.28, 1, 0);
    for (let i = 0; i < 14; i++) {
      const a = rr(0, TAU), rad = rr(0, 0.35) * sc;
      A.emit(x + Math.cos(a) * rad, y + rr(-0.2, 0.3), z + Math.sin(a) * rad, Math.cos(a) * rr(0.3, 1.2), rr(1.4, 3.0), Math.sin(a) * rr(0.3, 1.2), now + rr(0, 0.12), rr(0.45, 0.75), 1, rr(0.5, 0.8) * sc, 0.1, 0xffe27a, 0xff3000, TEX.FLAME, rr(-1.5, 1.5), rr(-0.4, 0.4), 0, 0, 1.2, 1.0, NO_FLOOR, 0);
    }
    sparks(20, x, y, z, 3.5 * sc, 0xffe0a0, 0xff4a00, 0.7, 1.4, 0.07 * sc, -0.25, fl, 0, 1, 0, 0.2, 0, TEX.EMBER, 0);
    puffs(4, x, y + 0.3, z, 0x3a3230, 0x6a6460, 0.35 * sc, 1.2 * sc, 0.9, 1.4, 0.4, 0.9, 0.35, NO_FLOOR, 0, 0, 0);
    flash(x, y, z, 0xff8a30, 40 * sc, 0.35);
  };
  KINDS.frost = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0x7fdcff), fl = groundAt(x, z, y - 1.2);
    glow(x, y, z, 1.6 * sc, 0.4 * sc, 0xffffff, c, 0.3, 0.9, 0);
    for (let i = 0; i < 16; i++) {
      let ux = rr(-1, 1), uy = rr(-0.4, 1), uz = rr(-1, 1); const l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1; const v = rr(0.6, 2.0) * sc;
      A.emit(x, y, z, ux / l * v, uy / l * v, uz / l * v, now + rr(0, 0.05), rr(0.9, 1.4), 1, rr(0.22, 0.42) * sc, 0.12 * sc, 0xe8ffff, c, TEX.CRYSTAL, rr(-4, 4), rr(0, TAU), 0, 0.12, 1.6, 0, fl, 0);
    }
    twinkles(12, x, y, z, 0.5 * sc, 0xffffff, c, 0.5, 1.0, 0.16 * sc, 0.4, 0.3, TEX.STAR);
    for (let i = 0; i < 8; i++) {
      const a = rr(0, TAU), rad = rr(0.1, 0.5) * sc;
      N.emit(x + Math.cos(a) * rad, y + rr(-0.3, 0.3), z + Math.sin(a) * rad, Math.cos(a) * 0.5, rr(-0.1, 0.25), Math.sin(a) * 0.5, now, rr(1.0, 1.6), 0.4, 0.5 * sc, 1.4 * sc, 0xd8f4ff, 0xeaf8ff, TEX.PUFF, rr(-0.8, 0.8), rr(0, TAU), 0, -0.005, 0.9, 0.3, NO_FLOOR, 0);
    }
    flash(x, y, z, c, 22 * sc, 0.3);
  };
  KINDS.light = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0xffe28a);
    glow(x, y, z, 2.6 * sc, 0.6 * sc, 0xffffff, c, 0.38, 1, 0);
    glow(x, y, z, 0.6 * sc, 3.2 * sc, 0xffffff, c, 0.5, 0.45, 0.04);
    sparks(18, x, y, z, 9 * sc, 0xffffff, c, 0.3, 0.45, 0.35 * sc, 0, NO_FLOOR, 0, 0, 0, 0, 0.35, TEX.STREAK, 0);
    twinkles(16, x, y, z, 0.9 * sc, 0xffffff, c, 0.5, 1.0, 0.22 * sc, 0.7, 0.35, TEX.STAR);
    ringFx(h, 0, 0, 0, 0.2 * sc, 2.6 * sc, 0.45, c, 0.9, 0.25, true, 0);
    flash(x, y, z, 0xfff0c0, 45 * sc, 0.4);
  };
  KINDS.lightning = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0xa8d8ff);
    let fx, fy, fz, tx = x, ty = y, tz = z;
    if (o.target && posOf(o.target, _v1)) {                 // caster at pos → target
      const ht = (typeof o.target.height === 'number' ? o.target.height : 1.8);
      tx = _v1.x; ty = _v1.y + ht * 0.55; tz = _v1.z; fx = x; fy = y + 1.3; fz = z;
    } else if (o.from && validPos(o.from)) { fx = o.from.x; fy = o.from.y; fz = o.from.z; }
    else { fx = x + rr(-2.5, 2.5); fy = y + 9 * sc; fz = z + rr(-2.5, 2.5); }                 // strike from the sky
    _v3.set(fx, fy, fz); _v4.set(tx, ty, tz);
    const seed = _rnd() * 6.28;
    beamFx(_v3, _v4, lighten(c, 0.5), 0.24, 0.12 * sc, 0.36 * sc, seed, 0.6);
    { const len = _v3.distanceTo(_v4); let n = Math.ceil(len / 0.5); if (n > 32) n = 32; if (n < 3) n = 3;
      for (let i = 0; i < n; i++) { const t = (i + 0.5) / n; A.emit(fx + (tx - fx) * t + rr(-0.15, 0.15), fy + (ty - fy) * t, fz + (tz - fz) * t + rr(-0.15, 0.15), 0, 0, 0, now, rr(0.22, 0.3), 0.22, 1.7 * sc, 0.8 * sc, c, c, TEX.GLOW, 0, 0, 0, 0, 0, 0, NO_FLOOR, 0); } }
    beamFx(_v3, _v4, 0xffffff, 0.2, 0.06 * sc, 0.36 * sc, seed, 1.0);
    _v1.set((fx + tx) * 0.5 + rr(-1.5, 1.5), (fy + ty) * 0.5, (fz + tz) * 0.5 + rr(-1.5, 1.5));
    _v2.set(_v1.x + rr(-1.2, 1.2), ty + rr(0.2, 1.2), _v1.z + rr(-1.2, 1.2));
    beamFx(_v1, _v2, lighten(c, 0.4), 0.16, 0.06 * sc, 0.5 * sc, seed + 1.3, 0.7);
    glow(tx, ty, tz, 2.4 * sc, 0.6 * sc, 0xffffff, c, 0.22, 1, 0);
    glow(fx, fy, fz, 1.2 * sc, 0.3 * sc, 0xffffff, c, 0.2, 0.8, 0);
    sparks(22, tx, ty, tz, 6 * sc, 0xffffff, c, 0.25, 0.5, 0.1 * sc, 1.0, groundAt(tx, tz, ty - 1.2), 0, 1, 0, 0.25, 0.1, TEX.STREAK, 0);
    twinkles(8, tx, ty, tz, 0.5 * sc, 0xffffff, c, 0.3, 0.6, 0.18 * sc, 0.3, 0.1, TEX.STAR);
    flash(tx, ty, tz, c, 60 * sc, 0.3);
  };
  KINDS.heal = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0x9dff8c);
    addEmitter(h, EP.heal, 42 * sc, o.duration || 1.1, 0, 0, 0, c, 0xffe98a, sc, 0.7);
    ringFx(h, 0, 0.06, 0, 0.35 * sc, 1.5 * sc, 0.8, c, 0.8, 0.25, false, 0);
    glow(x, y + 1.0, z, 1.6 * sc, 2.2 * sc, c, 0xffe98a, 0.6, 0.45, 0);
    flash(x, y, z, c, 18 * sc, 0.6);
  };
  KINDS.buff = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0x6fb4ff);
    addEmitter(h, EP.swirl, 80, o.duration || 0.9, 0, 0, 0, lighten(c, 0.55), c, sc, 0.6);
    ringFx(h, 0, 0.06, 0, 0.3 * sc, 1.4 * sc, 0.6, c, 0.9, 0.25, false, 0);
    glow(x, y + 1.0, z, 1.4 * sc, 2.0 * sc, lighten(c, 0.5), c, 0.55, 0.6, 0);
  };
  KINDS.levelup = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0xffd76a), dur = o.duration || 2.5;
    pillarFx(h, 0, 1.6 * sc, 14 * sc, c, dur, 1.0);
    ringFx(h, 0, 0.06, 0, 0.2, 3.6 * sc, 1.0, c, 1.0, 0.22, false, 0);
    ringFx(h, 0, 0.06, 0, 0.2, 2.4 * sc, 0.9, 0xffffff, 0.6, 0.18, false, 0.35);
    glow(x, y + 1.0, z, 3.4 * sc, 1.0 * sc, 0xffffff, c, 0.5, 1, 0);
    sparks(44, x, y + 0.9, z, 5 * sc, 0xfff6c8, c, 0.6, 1.1, 0.12 * sc, 0.6, groundAt(x, z, y), 0, 1, 0, 0.4, 0.09, TEX.STREAK, 0);
    addEmitter(h, EP.rise, 70, dur, 0, 0, 0, 0xffffff, c, sc, 1.2);
    flash(x, y, z, c, 50 * sc, 2.0);
  };
  KINDS.dust = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0xa8926c);
    dirOf(o, _v2);
    puffs(6, x, y, z, c, lighten(c, 0.15), 0.28 * sc, 0.75 * sc, 0.5, 0.85, 0.9 * sc, 0.35, 0.55, groundAt(x, z, y - 0.5), -_v2.x, -_v2.z, 0.5);
  };
  KINDS.mount_dust = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0xa8926c);
    dirOf(o, _v2);
    puffs(8, x, y, z, c, lighten(c, 0.12), 0.5 * sc, 1.7 * sc, 0.8, 1.3, 1.6 * sc, 0.5, 0.6, groundAt(x, z, y - 0.5), -_v2.x, -_v2.z, 1.6);
  };
  KINDS.splash = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0xd8efff);
    for (let i = 0; i < 26; i++) {
      const a = rr(0, TAU), v = rr(0.4, 1.6) * sc;
      A.emit(x, y, z, Math.cos(a) * v, rr(2.2, 5.0) * sc, Math.sin(a) * v, now, rr(0.6, 1.0), 0.9, rr(0.05, 0.1) * sc, 0.03, 0xffffff, c, TEX.EMBER, 0, 0, 0.04, 1.0, 0.3, 0, y, 1);
    }
    glow(x, y + 0.1, z, 0.9 * sc, 1.6 * sc, 0xffffff, c, 0.35, 0.6, 0);
    puffs(5, x, y, z, 0xffffff, 0xe8f6ff, 0.3 * sc, 0.9 * sc, 0.4, 0.7, 0.8 * sc, 0.8, 0.55, NO_FLOOR, 0, 0, 0);
    ringFx(h, 0, 0.02, 0, 0.15 * sc, 1.9 * sc, 1.0, c, 0.9, 0.2, false, 0);
    ringFx(h, 0, 0.02, 0, 0.15 * sc, 1.3 * sc, 0.8, 0xffffff, 0.6, 0.16, false, 0.2);
  };
  KINDS.water_ring = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0xd8efff);
    ringFx(h, 0, 0.02, 0, 0.12 * sc, 1.6 * sc, (o.duration || 1.0), c, 0.7, 0.22, false, 0);
  };
  KINDS.bubbles = (h, x, y, z, o) => {
    addEmitter(h, EP.bubbles, 14 * (o.scale || 1), o.loop ? 0 : (o.duration || 1.2), 0, 0, 0, 0xe0f6ff, 0xffffff, o.scale || 1, 0.3);
  };
  KINDS.smoke = (h, x, y, z, o) => {
    const c = hexOf(o.color, 0x8d8d92);
    addEmitter(h, EP.smoke, 5 * (o.scale || 1), o.loop ? 0 : (o.duration || 3), 0, 0, 0, c, lighten(c, 0.35), o.scale || 1, 0.2);
  };
  function fireBase(h, o, sc, flames, embers, smoke, glowRate) {
    const c = hexOf(o.color, 0xffb040);
    const dur = o.loop === false && o.duration ? o.duration : 0;
    addEmitter(h, EP.flame, flames, dur, 0, 0, 0, lighten(c, 0.45), 0xff2a00, sc, 0.2);
    addEmitter(h, EP.ember, embers, dur, 0, 0, 0, 0xffe0a0, 0xff5a00, sc, 0.2);
    if (smoke > 0) addEmitter(h, EP.firesmoke, smoke, dur, 0, 0, 0, 0x4a4540, 0x8a857f, sc, 0.2);
    addEmitter(h, EP.fireglow, glowRate, dur, 0, 0, 0, 0xffa040, 0xff5010, sc, 0.2);
    if (o.light && typeof o.light.intensity === 'number') { h.light = o.light; h.lightBase = o.light.intensity; h.lightAmp = 0.22; }
  }
  KINDS.fire_static = (h, x, y, z, o) => { fireBase(h, o, o.scale || 1, 24 * (o.scale || 1), 5, 2.5, 3); };
  KINDS.torch = (h, x, y, z, o) => { fireBase(h, o, (o.scale || 1) * 0.45, 16, 2, 0, 2.5); };
  KINDS.sparkle = (h, x, y, z, o) => {
    const c = hexOf(o.color, 0xfff3b0);
    addEmitter(h, EP.sparkle, 10 * (o.scale || 1), o.loop ? 0 : (o.duration || 1.5), 0, 0, 0, 0xffffff, c, o.scale || 1, o.radius || 0.5 * (o.scale || 1));
  };
  KINDS.impact = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0x6b4a3a), fl = groundAt(x, z, y - 1.2);
    dirOf(o, _v2);
    motes(12, x, y, z, c, 0x3a2a22, 0.09 * sc, 3 * sc, 0.35, 0.55, fl, 0.9);
    puffs(3, x, y, z, 0x5a4a40, 0x4a3c34, 0.2 * sc, 0.5 * sc, 0.3, 0.5, 0.6, 0.4, 0.4, NO_FLOOR, _v2.x, _v2.z, 0.6);
    glow(x, y, z, 0.5 * sc, 0.15, 0xffe0c0, 0xff9060, 0.1, 0.5, 0);
  };
  KINDS.blood = KINDS.impact;
  KINDS.quest_beacon = (h, x, y, z, o) => {
    const c = hexOf(o.color, 0xffd27a), sc = o.scale || 1;
    pillarFx(h, 0, 1.2 * sc, 40 * sc, c, -1, 0.4);
    ringLoopFx(h, 0.06, 0.2, 1.8 * sc, 2.2, c, 0.55, 0.22);
    addEmitter(h, EP.beaconRise, 7, 0, 0, 0, 0, 0xffffff, c, sc, 0.9);
    h.persistent = true;
  };
  KINDS.footstep = (h, x, y, z, o) => {
    const g = o.ground || 'grass', sc = o.scale || 1;
    dirOf(o, _v2);
    if (g === 'water') {
      for (let i = 0; i < 7; i++) { const a = rr(0, TAU), v = rr(0.3, 1.0) * sc; A.emit(x, y, z, Math.cos(a) * v, rr(1.2, 2.6) * sc, Math.sin(a) * v, now, rr(0.35, 0.6), 0.8, 0.05 * sc, 0.02, 0xffffff, 0xd8efff, TEX.EMBER, 0, 0, 0.03, 1.0, 0.3, 0, y, 1); }
      ringFx(h, 0, 0.02, 0, 0.1, 0.7 * sc, 0.6, 0xd8efff, 0.5, 0.2, false, 0);
      return;
    }
    if (g === 'snow') {
      puffs(3, x, y, z, 0xf4f8ff, 0xffffff, 0.15 * sc, 0.4 * sc, 0.35, 0.55, 0.5, 0.3, 0.55, NO_FLOOR, -_v2.x, -_v2.z, 0.3);
      twinkles(3, x, y + 0.1, z, 0.15, 0xffffff, 0xd8f0ff, 0.3, 0.5, 0.05, 0.3, 0.05, TEX.STAR);
      return;
    }
    const c = g === 'stone' || g === 'road' ? 0x9a9a96 : g === 'sand' ? 0xd6c39a : g === 'wood' ? 0x8b6c48 : g === 'grass' ? 0x8c9a5e : 0xa08a62;
    puffs(g === 'wood' ? 2 : 3, x, y, z, c, lighten(c, 0.2), 0.15 * sc, 0.4 * sc, 0.35, 0.55, 0.5, 0.3, 0.4, NO_FLOOR, -_v2.x, -_v2.z, 0.3);
  };
  KINDS.questmark_glow = (h, x, y, z, o) => {
    const c = hexOf(o.color, 0xffd44a);
    if (!h.target && typeof o.yOff !== 'number') h.tOff = 0;
    addEmitter(h, EP.qglow, 2.5, o.loop === false ? (o.duration || 2) : 0, 0, 0, 0, c, c, o.scale || 1, 0.3);
  };
  KINDS.death_puff = (h, x, y, z, o) => {
    const sc = o.scale || 1;
    puffs(10, x, y + 0.2, z, 0x55504a, 0x33302c, 0.4 * sc, 1.3 * sc, 0.8, 1.3, 1.0 * sc, 0.6, 0.6, NO_FLOOR, 0, 0, 0);
    twinkles(10, x, y + 0.6, z, 0.4 * sc, 0xffffff, 0xb0c8e0, 1.0, 1.8, 0.07 * sc, 0.9, 0.4, TEX.GLOW);
    glow(x, y + 0.6, z, 1.2 * sc, 0.3, 0xdfe8ff, 0x8090b0, 0.5, 0.35, 0);
  };
  KINDS.snow_puff = (h, x, y, z, o) => {
    const sc = o.scale || 1;
    puffs(6, x, y, z, 0xf4f8ff, 0xffffff, 0.25 * sc, 0.7 * sc, 0.5, 0.8, 0.9 * sc, 0.5, 0.6, NO_FLOOR, 0, 0, 0);
    twinkles(8, x, y + 0.2, z, 0.35 * sc, 0xffffff, 0xd8f0ff, 0.4, 0.7, 0.08 * sc, 0.4, 0.1, TEX.STAR);
    for (let i = 0; i < 6; i++) A.emit(x, y + 0.1, z, rr(-1, 1), rr(1, 2.5), rr(-1, 1), now, rr(0.5, 0.8), 0.9, 0.07 * sc, 0.03, 0xffffff, 0xcfe8ff, TEX.CRYSTAL, rr(-5, 5), rr(0, TAU), 0, 0.8, 0.5, 0, groundAt(x, z, y), 1);
  };
  KINDS.loot_glow = (h, x, y, z, o) => {
    const c = hexOf(o.color, 0xffe08a), sc = o.scale || 1;
    pillarFx(h, 0, 0.55 * sc, 2.4 * sc, c, -1, 0.55);
    ringLoopFx(h, 0.05, 0.12, 0.75 * sc, 1.6, c, 0.45, 0.25);
    addEmitter(h, EP.lootRise, 6, 0, 0, 0, 0, 0xffffff, c, sc, 0.3);
    h.persistent = true;
  };
  KINDS.teleport = (h, x, y, z, o) => {
    const sc = o.scale || 1, c = hexOf(o.color, 0x8ec5ff), out = !!(o.out || o.reverse);
    pillarFx(h, 0, 1.0 * sc, 6 * sc, c, 0.85, 1.0);
    const em = addEmitter(h, EP.spiral, 90, 0.7, 0, 0, 0, 0xffffff, c, sc, 1.3); em.flag = out ? 1 : 0;
    ringFx(h, 0, 0.06, 0, out ? 0.2 : 2.0 * sc, out ? 2.0 * sc : 0.2, 0.55, c, 0.8, 0.22, false, 0);
    glow(x, y + 1.0, z, out ? 0.8 * sc : 2.4 * sc, out ? 2.4 * sc : 0.8 * sc, 0xffffff, c, 0.4, 1, out ? 0.3 : 0);
    twinkles(14, x, y + 1.0, z, 0.8 * sc, 0xffffff, c, 0.5, 0.9, 0.16 * sc, 0.6, 0.4, TEX.STAR);
    flash(x, y, z, c, 35 * sc, 0.6);
  };
  KINDS.arrow = (h, x, y, z, o) => {
    if (h.target) addEmitter(h, EP.trailArrow, 60, o.duration || 4, 0, 0, 0, 0xffffff, 0xc8d4dc, o.scale || 1, 0.1);
    else { trailEm.ox = trailEm.oy = trailEm.oz = 0; for (let i = 0; i < 6; i++) EP.trailArrow(trailEm, x, y, z); }
  };
  KINDS.bolt = (h, x, y, z, o) => {
    const c = hexOf(o.color, 0x8ec5ff);
    if (h.target) { const em = addEmitter(h, EP.trailBolt, 60, o.duration || 4, 0, 0, 0, lighten(c, 0.5), c, o.scale || 1, 0.1); em.color2 = c; }
    else { glow(x, y, z, 0.8 * (o.scale || 1), 0.2, 0xffffff, c, 0.2, 1, 0); sparks(10, x, y, z, 3, 0xffffff, c, 0.3, 0.5, 0.08, 0.5, NO_FLOOR, 0, 0, 0, 0, 0.06, TEX.STREAK, 0); }
  };
  KINDS.beam = (h, x, y, z, o) => {
    const c = hexOf(o.color, 0xa8d8ff), sc = o.scale || 1;
    if (!o.from || !validPos(o.from)) return;
    _v3.set(o.from.x, o.from.y, o.from.z); _v4.set(x, y, z);
    const seed = _rnd() * 6.28, w = (o.width || 0.3) * sc, j = (typeof o.jitter === 'number' ? o.jitter : 0.05) * sc;
    beamFx(_v3, _v4, c, o.duration || 0.4, w, j, seed, 0.18);
    beamFx(_v3, _v4, lighten(c, 0.7), o.duration || 0.4, w * 0.3, j, seed, 1.0);
    glow(x, y, z, 1.2 * sc, 0.4 * sc, 0xffffff, c, o.duration || 0.4, 0.8, 0);
  };
  KINDS.flash = (h, x, y, z, o) => {
    const c = hexOf(o.color, 0xffffff), sc = o.scale || 1;
    glow(x, y, z, 1.5 * sc, 0.4 * sc, 0xffffff, c, o.duration || 0.2, 1, 0);
    flash(x, y, z, c, 25 * sc, o.duration || 0.25);
  };
  KINDS.ring = (h, x, y, z, o) => {
    const c = hexOf(o.color, 0xffffff), sc = o.scale || 1;
    ringFx(h, 0, 0.05, 0, 0.2 * sc, 1.8 * sc, o.duration || 0.7, c, 0.8, 0.22, !!o.billboard, 0);
  };

  // ------------------------------------------------------------------------------------------------ projectiles
  const PK = { arrow: 0, bolt: 1, stone: 2, fire: 3 };
  const PERSIST = { quest_beacon: 1, loot_glow: 1, fire_static: 1, torch: 1, smoke: 1, questmark_glow: 1 };
  let arrowMesh = null, boltMesh = null, stoneMesh = null;
  const projs = [];
  const trailEm = new Emitter();
  function newProj() {
    return { on: false, kind: 0, pos: new THREE.Vector3(), prev: new THREE.Vector3(), vel: new THREE.Vector3(), aim: new THREE.Vector3(), spin: new THREE.Vector3(0, 1, 0),
      target: null, speed: 30, arc: true, g: 0, age: 0, life: 4, flightT: 1, onHit: null, done: false, color: 0xffffff, scale: 1, h: null, angle: 0, hitDist: 0.6, hasTo: false, dist: 0 };
  }
  for (let i = 0; i < MAX_PROJ; i++) projs.push(newProj());

  function buildProjectileMeshes() {
    const shaft = colorGeom(new THREE.CylinderGeometry(0.013, 0.017, 0.82, 6, 1), 0x8a6a3c);
    const head = colorGeom(new THREE.ConeGeometry(0.032, 0.13, 6, 1), 0xc0c4c8); head.translate(0, 0.46, 0);
    const nock = colorGeom(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 6, 1), 0xd8d0c0); nock.translate(0, -0.4, 0);
    const fins = [];
    for (let i = 0; i < 3; i++) { const f = colorGeom(new THREE.PlaneGeometry(0.055, 0.17), i === 0 ? 0xf0e8d8 : 0xd8cfbf); f.translate(0.032, -0.28, 0); f.rotateY(i * TAU / 3); fins.push(f); }
    const arrowGeom = _mergeGeoms([shaft, head, nock].concat(fins));
    arrowGeom.computeBoundingSphere();
    const arrowMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.15, side: THREE.DoubleSide });
    arrowMesh = new THREE.InstancedMesh(arrowGeom, arrowMat, MAX_PROJ);
    const boltGeom = new THREE.SphereGeometry(0.17, 12, 8);
    const boltMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    boltMesh = new THREE.InstancedMesh(boltGeom, boltMat, MAX_PROJ);
    for (let i = 0; i < MAX_PROJ; i++) boltMesh.setColorAt(i, _tmpColor.setHex(0xffffff));
    const stoneGeom = new THREE.DodecahedronGeometry(0.15, 0);
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x7a746c, roughness: 1, metalness: 0, flatShading: true });
    stoneMesh = new THREE.InstancedMesh(stoneGeom, stoneMat, MAX_PROJ);
    for (const m of [arrowMesh, boltMesh, stoneMesh]) { m.count = 0; m.frustumCulled = false; m.visible = false; m.castShadow = false; m.receiveShadow = false; m.matrixAutoUpdate = false; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); }
    arrowMesh.name = 'FX_arrows'; boltMesh.name = 'FX_bolts'; stoneMesh.name = 'FX_stones';
    boltMesh.renderOrder = 1001;
  }
  function aimAt(t, out) {
    if (!posOf(t, out)) return false;
    if (t.pos && !t.isObject3D) out.y += (typeof t.height === 'number' && t.height > 0 ? t.height : 1.8) * 0.55;
    return true;
  }
  function solve(p, out) {
    const dx = p.aim.x - p.pos.x, dy = p.aim.y - p.pos.y, dz = p.aim.z - p.pos.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!p.arc || dist < 0.5) { p.g = 0; if (dist < 1e-4) out.set(0, 0, -p.speed); else out.set(dx, dy, dz).multiplyScalar(p.speed / dist); return Math.max(dist / p.speed, 0.02); }
    const T = Math.max(dist / p.speed, 0.04);
    p.g = GRAV * clamp(dist / 28, 0.2, 1) * (p.kind === PK.stone ? 1.4 : 1);
    out.set(dx / T, dy / T + 0.5 * p.g * T, dz / T);
    return T;
  }
  function projectile(opts) {
    if (!ready || !opts || !validPos(opts.from)) return null;
    const kindName = PK[opts.kind] !== undefined ? opts.kind : 'arrow', kind = PK[kindName];
    let p = null, oldest = null;
    for (let i = 0; i < MAX_PROJ; i++) { const q = projs[i]; if (!q.on) { p = q; break; } if (!oldest || q.age > oldest.age) oldest = q; }
    if (!p) { finishProj(oldest, oldest.pos, null); p = oldest; }
    p.on = true; p.done = false; p.kind = kind; p.age = 0; p.dist = 0;
    p.pos.set(opts.from.x, opts.from.y, opts.from.z); p.prev.copy(p.pos);
    p.life = opts.maxTime > 0 ? opts.maxTime : 4;
    p.onHit = typeof opts.onHit === 'function' ? opts.onHit : null;
    p.color = hexOf(opts.color, kind === PK.fire ? 0xff8a30 : kind === PK.bolt ? 0x8ec5ff : 0xffffff);
    p.scale = opts.scale > 0 ? opts.scale : 1;
    p.speed = opts.speed > 0 ? opts.speed : 30;
    p.arc = opts.arc !== false;
    p.hitDist = opts.hitRadius > 0 ? opts.hitRadius : 0.6;
    p.target = (opts.target && aimAt(opts.target, p.aim)) ? opts.target : null;
    if (!p.target) {
      if (validPos(opts.to)) p.aim.set(opts.to.x, opts.to.y, opts.to.z);
      else if (dirOf(opts, _v2)) p.aim.copy(p.pos).addScaledVector(_v2, opts.range > 0 ? opts.range : 30);
      else { p.on = false; return null; }
    }
    p.hasTo = !p.target;
    p.flightT = solve(p, p.vel);
    p.spin.set(rr(-1, 1), rr(-1, 1), rr(-1, 1)).normalize(); p.angle = rr(0, TAU);
    const h = new Handle(kindName, p.pos.x, p.pos.y, p.pos.z, EMPTY);
    h.proj = p; p.h = h; h.persistent = true; liveHandles.push(h);
    if (kind === PK.bolt || kind === PK.fire) glow(p.pos.x, p.pos.y, p.pos.z, 0.9 * p.scale, 0.2, 0xffffff, p.color, 0.18, 0.9, 0);
    return h;
  }
  function finishProj(p, point, ent) {
    if (!p.on) return;
    p.on = false; p.done = true;
    const x = point.x, y = point.y, z = point.z, sc = p.scale;
    if (p.kind === PK.arrow) {
      if (ent) { sparks(6, x, y, z, 2.5, 0xffffff, 0xffd0a0, 0.2, 0.35, 0.06, 0.6, groundAt(x, z, y - 1.2), 0, 0, 0, 0, 0.05, TEX.STREAK, 0); glow(x, y, z, 0.5, 0.15, 0xffffff, 0xffe0c0, 0.12, 0.8, 0); }
      else puffs(3, x, y, z, 0x9a8a70, 0xb0a48c, 0.15, 0.4, 0.3, 0.5, 0.5, 0.3, 0.45, NO_FLOOR, 0, 0, 0);
    } else if (p.kind === PK.bolt) {
      glow(x, y, z, 1.4 * sc, 0.3, 0xffffff, p.color, 0.2, 1, 0);
      sparks(16, x, y, z, 4.5 * sc, 0xffffff, p.color, 0.25, 0.5, 0.09 * sc, 0.7, groundAt(x, z, y - 1.2), 0, 0, 0, 0, 0.08, TEX.STREAK, 0);
      twinkles(6, x, y, z, 0.4 * sc, 0xffffff, p.color, 0.3, 0.6, 0.14 * sc, 0.4, 0.1, TEX.STAR);
      flash(x, y, z, p.color, 22 * sc, 0.25);
    } else if (p.kind === PK.stone) {
      puffs(5, x, y, z, 0xa08a62, 0xb8a888, 0.2, 0.6, 0.4, 0.7, 0.9, 0.4, 0.5, NO_FLOOR, 0, 0, 0);
      motes(6, x, y, z, 0x8a8078, 0x5a544e, 0.06, 2, 0.3, 0.5, groundAt(x, z, y - 1.2), 0.9);
    } else {
      const h = new Handle('fire', x, y, z, EMPTY); liveHandles.push(h);
      KINDS.fire(h, x, y, z, { scale: 0.8 * sc, color: p.color });
    }
    const fn = p.onHit; p.onHit = null; p.target = null;
    const h = p.h; p.h = null;
    if (h) { h.proj = null; h.pos.copy(point); stopHandle(h); }
    if (fn) { try { fn(point, ent || null); } catch (e) { if (typeof G.reportError === 'function') G.reportError(e, 'FX.projectile onHit'); else G.log('FX onHit error', e); } }
  }
  function segClosest(a, b, q, out) {                  // closest point on segment ab to q; returns t
    _v3.subVectors(b, a); const l2 = _v3.lengthSq();
    let t = l2 > 1e-9 ? clamp(_v4.subVectors(q, a).dot(_v3) / l2, 0, 1) : 0;
    out.copy(a).addScaledVector(_v3, t);
    return t;
  }
  function updateProjectiles(dt, cam) {
    let na = 0, nb = 0, ns = 0;
    const P = G.Physics, T = G.Terrain, sea = (G.C && typeof G.C.SEA_LEVEL === 'number') ? G.C.SEA_LEVEL : 0;
    for (let i = 0; i < MAX_PROJ; i++) {
      const p = projs[i]; if (!p.on) continue;
      p.age += dt; p.prev.copy(p.pos);
      if (p.target) {
        const tg = p.target;
        if (tg.alive === false || tg.dead === true || !aimAt(tg, _v1)) { p.hasTo = true; p.target = null; }
        else { p.aim.copy(_v1); solve(p, _v2); p.vel.lerp(_v2, Math.min(1, 6 * dt)); }
      }
      p.vel.y -= p.g * dt;
      p.pos.addScaledVector(p.vel, dt);
      const segLen = p.pos.distanceTo(p.prev); p.dist += segLen;
      // --- hit tests (earliest along the segment wins)
      let hitT = 2, hitEnt = null; const hp = _v1;
      const tAim = segClosest(p.prev, p.pos, p.aim, _v2);
      if (_v2.distanceTo(p.aim) <= p.hitDist) { hitT = tAim; hp.copy(p.target ? _v2 : p.aim); hitEnt = p.target; }
      else if (p.hasTo && p.age >= p.flightT + 0.05 && p.pos.distanceTo(p.aim) < Math.max(1.5, segLen * 2)) { hitT = 1; hp.copy(p.aim); }
      if (P && typeof P.sweep === 'function' && segLen > 1e-4) {
        const hit = P.sweep(p.prev, p.pos, 0.05);
        if (hit && hit.point && typeof hit.dist === 'number') { const t = clamp(hit.dist / segLen, 0, 1); if (t < hitT) { hitT = t; hp.set(hit.point.x, hit.point.y, hit.point.z); hitEnt = null; } }
      } else if (T && typeof T.height === 'function') {
        const gh = T.height(p.pos.x, p.pos.z);
        if (p.pos.y <= gh && 0 < hitT) { hitT = 0.99; hp.set(p.pos.x, gh + 0.02, p.pos.z); hitEnt = null; }
      } else if (p.pos.y <= 0 && hitT > 1) { hitT = 0.99; hp.set(p.pos.x, 0.02, p.pos.z); }
      let splash = false;
      if (hitT > 1 && p.pos.y <= sea && (!T || typeof T.isWater !== 'function' || T.isWater(p.pos.x, p.pos.z))) { hitT = 0.99; hp.set(p.pos.x, sea, p.pos.z); hitEnt = null; splash = true; }
      if (hitT > 1 && p.age >= p.life) { hitT = 1; hp.copy(p.pos); hitEnt = null; }
      // --- trail along the travelled segment
      if (p.kind !== PK.stone && segLen > 1e-4) {
        const spacing = p.kind === PK.arrow ? 0.22 : 0.16;
        let n = Math.ceil(segLen / spacing); if (n > 12) n = 12;
        trailEm.color = lighten(p.color, 0.5); trailEm.color2 = p.color; trailEm.scale = p.scale;
        const il = 1 / Math.max(segLen, 1e-6); trailEm.ox = (p.pos.x - p.prev.x) * il; trailEm.oy = (p.pos.y - p.prev.y) * il; trailEm.oz = (p.pos.z - p.prev.z) * il;
        const prog = p.kind === PK.arrow ? EP.trailArrow : p.kind === PK.fire ? EP.trailFire : EP.trailBolt;
        const end = hitT <= 1 ? hitT : 1;
        for (let k = 0; k < n; k++) { const t = (k + 0.5) / n * end; prog(trailEm, p.prev.x + (p.pos.x - p.prev.x) * t, p.prev.y + (p.pos.y - p.prev.y) * t, p.prev.z + (p.pos.z - p.prev.z) * t); }
        if (p.kind !== PK.arrow) A.emit(p.pos.x, p.pos.y, p.pos.z, 0, 0, 0, now, 0.08, 0.9, 0.9 * p.scale, 0.7 * p.scale, 0xffffff, p.color, TEX.GLOW, 0, 0, 0, 0, 0, 0, NO_FLOOR, 0);
      }
      if (hitT <= 1) {
        if (splash) { const h = new Handle('splash', hp.x, hp.y, hp.z, EMPTY); liveHandles.push(h); KINDS.splash(h, hp.x, hp.y, hp.z, EMPTY); h.persistent = false; }
        finishProj(p, hp, hitEnt);
        continue;
      }
      if (p.h) p.h.pos.copy(p.pos);
      // --- instance matrices
      if (p.kind === PK.arrow) {
        _v3.copy(p.vel); if (_v3.lengthSq() < 1e-6) _v3.set(0, 0, -1); _v3.normalize();
        _q1.setFromUnitVectors(UP, _v3); _scl.set(p.scale, p.scale, p.scale);
        _m4.compose(p.pos, _q1, _scl); arrowMesh.setMatrixAt(na++, _m4);
      } else if (p.kind === PK.stone) {
        p.angle += dt * 9; _q1.setFromAxisAngle(p.spin, p.angle); _scl.set(p.scale, p.scale, p.scale);
        _m4.compose(p.pos, _q1, _scl); stoneMesh.setMatrixAt(ns++, _m4);
      } else {
        const pulse = 1 + 0.15 * Math.sin(now * 25 + i);
        _q1.identity(); _scl.set(p.scale * pulse, p.scale * pulse, p.scale * pulse);
        _m4.compose(p.pos, _q1, _scl); boltMesh.setMatrixAt(nb, _m4);
        boltMesh.setColorAt(nb, _tmpColor.setHex(lighten(p.color, 0.35))); nb++;
      }
    }
    arrowMesh.count = na; arrowMesh.visible = na > 0; if (na) arrowMesh.instanceMatrix.needsUpdate = true;
    stoneMesh.count = ns; stoneMesh.visible = ns > 0; if (ns) stoneMesh.instanceMatrix.needsUpdate = true;
    boltMesh.count = nb; boltMesh.visible = nb > 0; if (nb) { boltMesh.instanceMatrix.needsUpdate = true; if (boltMesh.instanceColor) boltMesh.instanceColor.needsUpdate = true; }
    return na + nb + ns;
  }

  // ------------------------------------------------------------------------------------------------ public API
  const group = new THREE.Group(); group.name = 'FX'; group.matrixAutoUpdate = false;
  let beacon = null, projCount = 0;

  function init(sc) {
    if (ready) { if (sc && sc.isObject3D && group.parent !== sc) sc.add(group); return; }
    scene = (sc && sc.isObject3D) ? sc : null;
    atlas = _canvasTex(512, 256, drawAtlas);
    A = new PSys(MAX_ADD, true, atlas);
    N = new PSys(MAX_NRM, false, atlas);
    arcs = new InstSys(ringGeometry(0.3, 1, 72), instMaterial(INST_VERT(false), ARC_FRAG), MAX_ARCS, 'FX_arcs', 1002);
    beams = new InstSys(new THREE.CylinderGeometry(1, 1, 1, 10, 56, true), instMaterial(INST_VERT(true), BEAM_FRAG), MAX_BEAMS, 'FX_beams', 1003);
    const pg = new THREE.CylinderGeometry(1, 1, 1, 36, 1, true); pg.translate(0, 0.5, 0);
    pillars = new InstSys(pg, instMaterial(INST_VERT(false), PILLAR_FRAG), MAX_PILLARS, 'FX_pillars', 999);
    buildProjectileMeshes();
    flashLight = new THREE.PointLight(0xffffff, 0, 18, 2); flashLight.name = 'FX_flash';
    group.add(pillars.mesh, N.points, A.points, arcs.mesh, beams.mesh, arrowMesh, boltMesh, stoneMesh, flashLight);
    if (scene) scene.add(group);
    ready = true;
    G.log('FX ready: atlas 512x256, particles', MAX_ADD, '+', MAX_NRM);
  }

  function spawn(kind, pos, opts) {
    if (!ready || typeof kind !== 'string') return null;
    if (kind === 'blood') kind = 'impact';
    const fn = KINDS[kind]; if (!fn) { if (typeof G.warn === 'function') G.warn('FX: unknown kind ' + kind); return null; }
    if (!validPos(pos)) return null;
    const o = opts || EMPTY;
    const h = new Handle(kind, pos.x, pos.y, pos.z, o);
    if (h.target) h.pos.y += h.tOff;
    liveHandles.push(h);
    if (lastCam && !o.loop && !PERSIST[kind] && !o.force) {
      const dx = pos.x - lastCam.position.x, dz = pos.z - lastCam.position.z, dy = pos.y - lastCam.position.y;
      if (dx * dx + dy * dy + dz * dz > 220 * 220) return h;        // too far to see: handle finishes next frame
    }
    fn(h, h.pos.x, h.pos.y, h.pos.z, o);
    return h;
  }
  function stop(h) { if (h && typeof h === 'object' && h.alive) stopHandle(h); }
  function count() { return ready ? A.n + N.n : 0; }
  function setBeacon(pos) {
    if (!ready) return null;
    if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number' || pos.x !== pos.x || pos.z !== pos.z) { if (beacon) { stopHandle(beacon); beacon = null; } return null; }
    const y = (typeof pos.y === 'number' && pos.y === pos.y) ? pos.y : groundAt(pos.x, pos.z, 0);
    if (beacon && beacon.alive) { beacon.pos.set(pos.x, y, pos.z); return beacon; }
    _v1.set(pos.x, y, pos.z);
    beacon = spawn('quest_beacon', _v1, EMPTY);
    return beacon;
  }
  function update(dt, camera) {
    if (!ready) return;
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    now += dt; sharedTime.value = now;
    if (camera && camera.isCamera) lastCam = camera;
    const cam = lastCam;
    if (cam) {
      let hpx = viewportH;
      if (!(hpx > 0)) { const R = G.Game && G.Game.renderer; if (R && typeof R.getDrawingBufferSize === 'function') { R.getDrawingBufferSize(_v2d); hpx = _v2d.y; } }
      if (!(hpx > 0)) hpx = (window.innerHeight || 720) * Math.min(window.devicePixelRatio || 1, 2);
      sharedScale.value = hpx * cam.projectionMatrix.elements[5] * 0.5;
    }
    // handles: follow targets, flicker lights, retire finished one-shots
    for (let i = liveHandles.length - 1; i >= 0; i--) {
      const h = liveHandles[i]; h.age += dt;
      if (h.target && posOf(h.target, _v1)) h.pos.set(_v1.x, _v1.y + h.tOff, _v1.z);
      if (h.light) {
        const f = 1 + h.lightAmp * (Math.sin(now * 11.3 + h.id) * 0.5 + Math.sin(now * 27.1 + h.id * 1.7) * 0.3 + Math.sin(now * 4.7 + h.id * 0.3) * 0.2);
        h.light.intensity = h.lightBase * f;
      }
      if (!h.persistent && !h.proj && h.ems.length === 0 && h.insts.length === 0 && h.age > 0.05) { h.alive = false; liveHandles.splice(i, 1); }
    }
    // emitters
    const cx = cam ? cam.position.x : 0, cy = cam ? cam.position.y : 0, cz = cam ? cam.position.z : 0;
    for (let i = liveEms.length - 1; i >= 0; i--) {
      const em = liveEms[i], h = em.h;
      if (!h || !h.alive) { releaseEmitter(em); continue; }
      em.age += dt; em.remaining -= dt;
      if (em.remaining <= 0) { const j = h.ems.indexOf(em); if (j >= 0) h.ems.splice(j, 1); releaseEmitter(em); continue; }
      em.acc += em.rate * dt;
      let n = em.acc | 0; if (n <= 0) continue; em.acc -= n; if (n > 90) n = 90;
      if (cam) { const dx = h.pos.x - cx, dy = h.pos.y - cy, dz = h.pos.z - cz; if (dx * dx + dy * dy + dz * dz > 180 * 180) continue; }
      const x = h.pos.x + em.ox, y = h.pos.y + em.oy, z = h.pos.z + em.oz;
      for (let k = 0; k < n; k++) em.prog(em, x, y, z);
    }
    projCount = updateProjectiles(dt, cam);
    A.update(dt, now); N.update(dt, now);
    arcs.update(now, cam); beams.update(now, cam); pillars.update(now, cam);
    if (flashLight) {
      if (flashAge < flashDur) { flashAge += dt; const k = 1 - flashAge / flashDur; flashLight.intensity = k > 0 ? flashPeak * k * k : 0; }
      else if (flashLight.intensity !== 0) flashLight.intensity = 0;
    }
  }
  function stats() {
    if (!ready) return { particles: 0, additive: 0, normal: 0, emitters: 0, handles: 0, arcs: 0, beams: 0, pillars: 0, projectiles: 0, drawCalls: 0 };
    let dc = 0; for (const m of [A.points, N.points, arcs.mesh, beams.mesh, pillars.mesh, arrowMesh, boltMesh, stoneMesh]) if (m.visible) dc++;
    return { particles: A.n + N.n, additive: A.n, normal: N.n, emitters: liveEms.length, handles: liveHandles.length, arcs: arcs.count, beams: beams.count, pillars: pillars.count, projectiles: projCount, drawCalls: dc };
  }

  G.FX = {
    init, update, spawn, stop, count, projectile, setBeacon, stats,
    setViewportHeight(px) { viewportH = px > 0 ? px : 0; },
    get kinds() { return Object.keys(KINDS); },
    get group() { return group; },
    get flashLight() { return flashLight; },
    get ready() { return ready; },
    get time() { return now; },
    TEX,
  };
})();
