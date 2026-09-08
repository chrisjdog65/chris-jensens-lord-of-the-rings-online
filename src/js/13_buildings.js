/* ==== 13_buildings.js — Procedural buildings with REAL walk-in interiors: hobbit holes, timber houses, inns,
   shops, elf & dwarf halls, lossoth huts, tents, towers, ruins, barrows, docks, bridges, town walls & gates, fences,
   wells, campfires, market stalls, stables, shrines and props (lamp, sign, crate, barrel, hay, cart, statue).
   Every enterable recipe has hollow walls with a door opening (plinth, sill rail and colliders all stop at the door),
   a floor collider, an interior CEILING that is never hidden (flat beamed boards, or the pitched roof underside with
   rafters/purlins for halls and the inn's upper storey) plus a thin ceiling collider that clamps the chase camera and
   stops jumps; the exterior roof shell is only dropped once player AND camera are inside. Upper storeys (inn) have
   real stepped stairs (per-tread floor colliders, cut into rotation-safe cells), a landing, newels, balusters and a
   gallery railing with a collider. Vertex-coloured merged furniture (few draw calls), a hearth with G.FX fire + pooled
   flickering PointLights, and windows that glow at night. Doors are entities (kind:'door') with an E interaction; they
   also swing open by themselves when the player comes within 2 m and close again a few seconds after everyone left.
   Public API (G.Buildings): init(scene), build(scene?) (everything from G.Data.world), place(spec) → Building,
   buildTown(town), buildPOI(poi), buildDocks(docks), update(playerPos, dt), isInside(pos) → building|null,
   nearest(pos, filterFn?), all, byId, root (THREE.Group), setLightsEnabled(bool), lightsEnabled, playerInside,
   spotFor(npcId), openDoor/closeDoor/toggleDoor(doorEnt), remove(building), registerColliders(), recipes, RECIPES,
   materials, stats(). Events emitted: 'enterBuilding'(building), 'leaveBuilding'(building), 'doorToggled'(doorEnt).
   Private fallbacks (only used when core helpers are absent, e.g. stand-alone harness): _hash2, _hashStr, _rng,
   _mergeGeometries, _canvasTexture. ==== */
(function () {
  'use strict';
  const G = window.G;
  const T = THREE;
  const PI = Math.PI, TAU = Math.PI * 2, HPI = Math.PI / 2;

  /* ------------------------------------------------------------------------------------------------ */
  /* helpers & fallbacks                                                                                */
  /* ------------------------------------------------------------------------------------------------ */
  function _hash2(x, z) {
    let h = Math.imul((Math.floor(x * 7.31) | 0) ^ 0x27d4eb2d, 0x9E3779B1) ^ Math.imul((Math.floor(z * 5.17) | 0) + 0x165667B1, 0x85EBCA6B);
    h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D); h ^= h >>> 12; h = Math.imul(h, 0x297A2D39); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  }
  function _hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  function _rng(seed) {
    let a = (seed >>> 0) || 1;
    return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  const hash2 = (x, z) => (G.hash2 ? G.hash2(x, z) : _hash2(x, z));
  const hashStr = (s) => (G.hashStr ? G.hashStr(s) : _hashStr(s));
  const rngOf = (seed) => (G.rng ? G.rng(seed) : _rng(seed));
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const log = (...a) => { if (G.log) G.log(...a); };
  let _uidc = 0;
  const uid = () => (G.uid ? G.uid() : 'bld' + (++_uidc));

  function _mergeGeometries(geoms) {
    let n = 0, hasN = true, hasUV = true, hasC = true;
    for (const g of geoms) { n += g.attributes.position.count; if (!g.attributes.normal) hasN = false; if (!g.attributes.uv) hasUV = false; if (!g.attributes.color) hasC = false; }
    const pos = new Float32Array(n * 3), nor = hasN ? new Float32Array(n * 3) : null, uv = hasUV ? new Float32Array(n * 2) : null, col = hasC ? new Float32Array(n * 3) : null;
    let o = 0;
    for (const g of geoms) {
      const c = g.attributes.position.count;
      pos.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
      if (nor) nor.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
      if (uv) uv.set(g.attributes.uv.array.subarray(0, c * 2), o * 2);
      if (col) col.set(g.attributes.color.array.subarray(0, c * 3), o * 3);
      o += c;
    }
    const out = new T.BufferGeometry();
    out.setAttribute('position', new T.BufferAttribute(pos, 3));
    if (nor) out.setAttribute('normal', new T.BufferAttribute(nor, 3));
    if (uv) out.setAttribute('uv', new T.BufferAttribute(uv, 2));
    if (col) out.setAttribute('color', new T.BufferAttribute(col, 3));
    return out;
  }
  function mergeGeos(geoms) {
    if (!geoms.length) return null;
    const list = geoms.map(g => (g.index ? g.toNonIndexed() : g));
    const out = (typeof G.mergeGeometries === 'function') ? G.mergeGeometries(list) : _mergeGeometries(list);
    if (out) { out.computeBoundingSphere(); out.computeBoundingBox(); }
    return out;
  }
  function _canvasTexture(w, h, fn) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    fn(c.getContext('2d'), w, h);
    const t = new T.CanvasTexture(c);
    return t;
  }
  function makeTex(w, h, fn, repeat) {
    let t = null;
    try { t = (typeof G.canvasTexture === 'function') ? G.canvasTexture(w, h, fn, { repeat: [1, 1], wrap: !!repeat, nearest: false }) : null; } catch (e) { t = null; }
    if (!t) t = _canvasTexture(w, h, fn);
    t.colorSpace = T.SRGBColorSpace;
    t.wrapS = t.wrapT = repeat ? T.RepeatWrapping : T.ClampToEdgeWrapping;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  }

  /* ------------------------------------------------------------------------------------------------ */
  /* canvas textures (mostly greyscale detail; vertex colours carry the hue)                            */
  /* ------------------------------------------------------------------------------------------------ */
  function hsl(h, s, l) { return 'hsl(' + h + ',' + s + '%,' + l + '%)'; }
  function wrapRect(ctx, x, y, w, h, W) { ctx.fillRect(x, y, w, h); if (x + w > W) ctx.fillRect(x - W, y, w, h); if (x < 0) ctx.fillRect(x + W, y, w, h); }
  function speckle(ctx, w, h, n, r, hue, sat, lmin, lmax, alpha) {
    for (let i = 0; i < n; i++) { ctx.fillStyle = hsl(hue, sat, lmin + r() * (lmax - lmin)); ctx.globalAlpha = alpha; ctx.fillRect(r() * w, r() * h, 1 + r() * 2, 1 + r() * 2); }
    ctx.globalAlpha = 1;
  }
  function texStone(ctx, w, h) {
    const r = rngOf(101);
    ctx.fillStyle = hsl(35, 8, 52); ctx.fillRect(0, 0, w, h);
    const rows = 8, rh = h / rows;
    for (let j = 0; j < rows; j++) {
      let x = (j % 2) ? -rh * 0.9 : 0;
      while (x < w) {
        const bw = rh * (1.1 + r() * 1.3);
        ctx.fillStyle = hsl(30 + r() * 15, 6 + r() * 8, 60 + r() * 18);
        wrapRect(ctx, x + 1.5, j * rh + 1.5, bw - 3, rh - 3, w);
        ctx.fillStyle = 'rgba(255,255,255,0.18)'; wrapRect(ctx, x + 1.5, j * rh + 1.5, bw - 3, 2, w);
        ctx.fillStyle = 'rgba(0,0,0,0.16)'; wrapRect(ctx, x + 1.5, j * rh + rh - 4.5, bw - 3, 3, w);
        x += bw;
      }
    }
    speckle(ctx, w, h, 1400, r, 35, 8, 35, 85, 0.35);
  }
  function texBrick(ctx, w, h) {
    const r = rngOf(102);
    ctx.fillStyle = hsl(30, 14, 66); ctx.fillRect(0, 0, w, h);
    const rh = 16, bw = 34;
    for (let j = 0; j < h / rh; j++) {
      for (let x = (j % 2) ? -bw / 2 : 0; x < w; x += bw) {
        ctx.fillStyle = hsl(12 + r() * 14, 26 + r() * 14, 58 + r() * 16);
        wrapRect(ctx, x + 1, j * rh + 1, bw - 2, rh - 2, w);
      }
    }
    speckle(ctx, w, h, 900, r, 20, 20, 40, 80, 0.3);
  }
  function texWood(ctx, w, h) {
    const r = rngOf(103);
    ctx.fillStyle = hsl(28, 32, 60); ctx.fillRect(0, 0, w, h);
    const pw = 64;
    for (let p = 0; p < w / pw; p++) {
      const base = 56 + r() * 12;
      ctx.fillStyle = hsl(26 + r() * 8, 30 + r() * 12, base); ctx.fillRect(p * pw, 0, pw, h);
      for (let k = 0; k < 26; k++) {
        ctx.strokeStyle = hsl(24 + r() * 8, 34, base - 12 - r() * 16); ctx.lineWidth = 0.6 + r() * 1.2; ctx.globalAlpha = 0.35 + r() * 0.4;
        ctx.beginPath(); const x0 = p * pw + 3 + r() * (pw - 6);
        ctx.moveTo(x0, -4);
        for (let y = 0; y <= h + 8; y += 16) ctx.lineTo(x0 + Math.sin(y * 0.05 + k) * 2.2 + (r() - 0.5) * 1.5, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (r() < 0.6) { const ky = r() * h, kx = p * pw + 12 + r() * 40; ctx.fillStyle = hsl(24, 36, base - 22); ctx.beginPath(); ctx.ellipse(kx, ky, 3 + r() * 3, 5 + r() * 4, 0, 0, TAU); ctx.fill(); ctx.fillStyle = hsl(24, 30, base - 6); ctx.beginPath(); ctx.ellipse(kx, ky, 1.5, 2.5, 0, 0, TAU); ctx.fill(); }
      ctx.fillStyle = 'rgba(40,20,5,0.55)'; ctx.fillRect(p * pw, 0, 2, h);
      ctx.fillStyle = 'rgba(255,230,190,0.25)'; ctx.fillRect(p * pw + 2, 0, 1, h);
    }
  }
  function texThatch(ctx, w, h) {
    const r = rngOf(104);
    ctx.fillStyle = hsl(38, 42, 58); ctx.fillRect(0, 0, w, h);
    const rh = 32;
    for (let j = 0; j < h / rh; j++) {
      const y0 = j * rh;
      for (let k = 0; k < 520; k++) {
        const x = r() * w, len = 18 + r() * 26, ang = (r() - 0.5) * 0.35;
        ctx.strokeStyle = hsl(34 + r() * 14, 40 + r() * 20, 38 + r() * 40); ctx.lineWidth = 1 + r() * 1.4; ctx.globalAlpha = 0.6;
        ctx.beginPath(); ctx.moveTo(x, y0 - 6); ctx.lineTo(x + Math.sin(ang) * len, y0 - 6 + Math.cos(ang) * len); ctx.stroke();
        if (x + 8 > w) { ctx.beginPath(); ctx.moveTo(x - w, y0 - 6); ctx.lineTo(x - w + Math.sin(ang) * len, y0 - 6 + Math.cos(ang) * len); ctx.stroke(); }
      }
      ctx.globalAlpha = 1;
      const gr = ctx.createLinearGradient(0, y0 + rh - 12, 0, y0 + rh);
      gr.addColorStop(0, 'rgba(60,35,10,0)'); gr.addColorStop(1, 'rgba(50,28,8,0.7)');
      ctx.fillStyle = gr; ctx.fillRect(0, y0 + rh - 14, w, 14);
      ctx.fillStyle = 'rgba(255,235,190,0.22)'; ctx.fillRect(0, y0, w, 3);
    }
  }
  function texPlaster(ctx, w, h) {
    const r = rngOf(105);
    ctx.fillStyle = hsl(38, 22, 86); ctx.fillRect(0, 0, w, h);
    speckle(ctx, w, h, 2600, r, 38, 18, 70, 96, 0.5);
    ctx.strokeStyle = 'rgba(90,70,40,0.22)'; ctx.lineWidth = 1;
    for (let k = 0; k < 7; k++) { ctx.beginPath(); let x = r() * w, y = r() * h; ctx.moveTo(x, y); for (let s = 0; s < 6; s++) { x += (r() - 0.5) * 30; y += (r() - 0.5) * 30; ctx.lineTo(x, y); } ctx.stroke(); }
  }
  function texTile(ctx, w, h) {
    const r = rngOf(106);
    ctx.fillStyle = hsl(15, 10, 40); ctx.fillRect(0, 0, w, h);
    const tw = 32, th = 32;
    for (let j = 0; j < h / th; j++) {
      const y0 = j * th;
      for (let x = ((j % 2) ? -tw / 2 : 0) - tw; x <= w; x += tw) {
        ctx.fillStyle = hsl(12 + r() * 12, 8 + r() * 10, 56 + r() * 20);
        ctx.beginPath(); ctx.moveTo(x, y0 - 8); ctx.lineTo(x + tw, y0 - 8); ctx.lineTo(x + tw, y0 + th - 16); ctx.arc(x + tw / 2, y0 + th - 16, tw / 2, 0, PI, false); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(30,10,5,0.5)'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.fillStyle = 'rgba(255,240,220,0.14)'; ctx.fillRect(x + 2, y0 - 6, tw - 4, 3);
      }
    }
  }
  function texGrass(ctx, w, h) {
    const r = rngOf(107);
    ctx.fillStyle = hsl(96, 38, 52); ctx.fillRect(0, 0, w, h);
    for (let k = 0; k < 3200; k++) {
      const x = r() * w, y = r() * h, len = 4 + r() * 9, ang = (r() - 0.5) * 0.8;
      ctx.strokeStyle = hsl(88 + r() * 24, 40 + r() * 25, 36 + r() * 36); ctx.lineWidth = 1; ctx.globalAlpha = 0.7;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.sin(ang) * len, y - Math.cos(ang) * len); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  function texHide(ctx, w, h) {
    const r = rngOf(108);
    ctx.fillStyle = hsl(30, 30, 62); ctx.fillRect(0, 0, w, h);
    for (let k = 0; k < 3000; k++) {
      const x = r() * w, y = r() * h, len = 3 + r() * 6, ang = r() * TAU;
      ctx.strokeStyle = hsl(26 + r() * 12, 25 + r() * 20, 40 + r() * 40); ctx.lineWidth = 1; ctx.globalAlpha = 0.6;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(ang) * len, y + Math.sin(ang) * len); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(50,30,15,0.7)'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
    for (let x = 0; x < w; x += 128) { ctx.beginPath(); ctx.moveTo(x + 64, 0); ctx.lineTo(x + 64, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 128) { ctx.beginPath(); ctx.moveTo(0, y + 64); ctx.lineTo(w, y + 64); ctx.stroke(); }
    ctx.setLineDash([]);
  }
  function texRug(kind) {
    return function (ctx, w, h) {
      const A = kind === 'elf' ? '#3c5c8c' : kind === 'dwarf' ? '#4a3a2a' : '#8c2e2a';
      const B = kind === 'elf' ? '#dfe4ee' : kind === 'dwarf' ? '#c89a4a' : '#dcb45c';
      ctx.fillStyle = A; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = B; ctx.lineWidth = 10; ctx.strokeRect(14, 14, w - 28, h - 28);
      ctx.lineWidth = 3; ctx.strokeRect(34, 34, w - 68, h - 68);
      ctx.fillStyle = B; ctx.beginPath(); ctx.moveTo(w / 2, 60); ctx.lineTo(w - 70, h / 2); ctx.lineTo(w / 2, h - 60); ctx.lineTo(70, h / 2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = A; ctx.beginPath(); ctx.moveTo(w / 2, 90); ctx.lineTo(w - 100, h / 2); ctx.lineTo(w / 2, h - 90); ctx.lineTo(100, h / 2); ctx.closePath(); ctx.fill();
      ctx.fillStyle = B; ctx.beginPath(); ctx.arc(w / 2, h / 2, 14, 0, TAU); ctx.fill();
      for (let i = 0; i < 4; i++) { const cx = i < 2 ? 46 : w - 46, cy = (i % 2) ? h - 46 : 46; ctx.beginPath(); ctx.arc(cx, cy, 8, 0, TAU); ctx.fill(); }
      ctx.strokeStyle = B; ctx.lineWidth = 2;
      for (let x = 4; x < w; x += 8) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 8); ctx.moveTo(x, h); ctx.lineTo(x, h - 8); ctx.stroke(); }
    };
  }
  function texAwning(ctx, w, h) {
    for (let i = 0; i < 8; i++) { ctx.fillStyle = (i % 2) ? '#f0e6d2' : '#b8352c'; ctx.fillRect(i * w / 8, 0, w / 8, h); }
    const r = rngOf(109); speckle(ctx, w, h, 600, r, 30, 20, 40, 90, 0.25);
  }
  function texPlanks(ctx, w, h) {
    const r = rngOf(110);
    ctx.fillStyle = hsl(28, 30, 50); ctx.fillRect(0, 0, w, h);
    const ph = 32;
    for (let p = 0; p < h / ph; p++) {
      const base = 46 + r() * 14; const off = r() * w;
      ctx.fillStyle = hsl(26 + r() * 8, 28 + r() * 12, base); ctx.fillRect(0, p * ph, w, ph);
      for (let k = 0; k < 18; k++) {
        ctx.strokeStyle = hsl(24, 30, base - 10 - r() * 14); ctx.lineWidth = 0.8 + r(); ctx.globalAlpha = 0.5;
        const y0 = p * ph + 2 + r() * (ph - 4); ctx.beginPath(); ctx.moveTo(-4, y0);
        for (let x = 0; x <= w + 8; x += 24) ctx.lineTo(x, y0 + Math.sin(x * 0.04 + k) * 1.5);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(30,15,5,0.6)'; ctx.fillRect(0, p * ph, w, 2);
      ctx.fillStyle = 'rgba(30,15,5,0.5)'; wrapRect(ctx, off, p * ph, 2, ph, w);
    }
  }
  const _signTexCache = new Map();
  function signTexture(text) {
    if (_signTexCache.has(text)) return _signTexCache.get(text);
    const tex = makeTex(512, 160, (ctx, w, h) => {
      const gr = ctx.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#9a6a3c'); gr.addColorStop(1, '#6e4626');
      ctx.fillStyle = gr; ctx.fillRect(0, 0, w, h);
      const r = rngOf(hashStr(text) || 7);
      ctx.strokeStyle = 'rgba(40,20,5,0.35)'; ctx.lineWidth = 1;
      for (let k = 0; k < 40; k++) { const y = r() * h; ctx.beginPath(); ctx.moveTo(0, y); ctx.bezierCurveTo(w * 0.3, y + (r() - 0.5) * 10, w * 0.7, y + (r() - 0.5) * 10, w, y); ctx.stroke(); }
      ctx.strokeStyle = '#3a2210'; ctx.lineWidth = 6; ctx.strokeRect(8, 8, w - 16, h - 16);
      ctx.fillStyle = '#2a170a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      let size = 64; ctx.font = 'bold ' + size + 'px Georgia, "Times New Roman", serif';
      while (ctx.measureText(text).width > w - 50 && size > 22) { size -= 4; ctx.font = 'bold ' + size + 'px Georgia, "Times New Roman", serif'; }
      ctx.fillText(text, w / 2 + 2, h / 2 + 3);
      ctx.fillStyle = '#f2dca6'; ctx.fillText(text, w / 2, h / 2);
    }, false);
    _signTexCache.set(text, tex);
    return tex;
  }

  /* ------------------------------------------------------------------------------------------------ */
  /* materials — one shared MeshStandardMaterial per surface class (vertex colours carry variation)     */
  /* ------------------------------------------------------------------------------------------------ */
  const MAT = {};
  const BANNER_U = { time: { value: 0 }, wind: { value: 1 } };           // shared by every banner cloth (see getMat('banner'))
  const BANNER_WIND = { clear: 1, cloudy: 1.7, rain: 2.3, snow: 1.2, storm: 3.6 };
  let _bannerWindTarget = 1;
  const UV_SCALE = { stone: 2.0, brick: 1.3, wood: 1.6, planks: 1.8, thatch: 1.5, plaster: 3.0, tile: 1.6, grass: 3.2, hide: 1.6, rock: 2.6 };
  const TEX_FN = { stone: texStone, brick: texBrick, wood: texWood, planks: texPlanks, thatch: texThatch, plaster: texPlaster, tile: texTile, grass: texGrass, hide: texHide, rock: texStone };
  const _texCache = {};
  function tex(name) { if (!_texCache[name]) _texCache[name] = makeTex(256, 256, TEX_FN[name], true); return _texCache[name]; }
  function getMat(key) {
    if (MAT[key]) return MAT[key];
    let m;
    switch (key) {
      case 'stone': m = new T.MeshStandardMaterial({ map: tex('stone'), vertexColors: true, roughness: 0.95, metalness: 0 }); break;
      case 'rock': m = new T.MeshStandardMaterial({ map: tex('rock'), vertexColors: true, roughness: 1, metalness: 0 }); break;
      case 'brick': m = new T.MeshStandardMaterial({ map: tex('brick'), vertexColors: true, roughness: 0.92 }); break;
      case 'wood': m = new T.MeshStandardMaterial({ map: tex('wood'), vertexColors: true, roughness: 0.82 }); break;
      case 'planks': m = new T.MeshStandardMaterial({ map: tex('planks'), vertexColors: true, roughness: 0.85 }); break;
      case 'thatch': m = new T.MeshStandardMaterial({ map: tex('thatch'), vertexColors: true, roughness: 1 }); break;
      case 'plaster': m = new T.MeshStandardMaterial({ map: tex('plaster'), vertexColors: true, roughness: 0.9 }); break;
      case 'tile': m = new T.MeshStandardMaterial({ map: tex('tile'), vertexColors: true, roughness: 0.75 }); break;
      case 'grass': m = new T.MeshStandardMaterial({ map: tex('grass'), vertexColors: true, roughness: 1 }); break;
      case 'hide': m = new T.MeshStandardMaterial({ map: tex('hide'), vertexColors: true, roughness: 1 }); break;
      case 'flat': m = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0 }); break;
      case 'metal': m = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.75 }); break;
      case 'cloth': m = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: T.DoubleSide }); break;
      case 'banner':   // hanging cloth that sways in the wind (vertex shader; uv.y = 1 at the crossbar, 0 at the hem)
        m = new T.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, side: T.DoubleSide });
        m.onBeforeCompile = function (shader) {
          shader.uniforms.uBTime = BANNER_U.time; shader.uniforms.uBWind = BANNER_U.wind;
          shader.vertexShader = 'uniform float uBTime;\nuniform float uBWind;\n' + shader.vertexShader.replace('#include <begin_vertex>', [
            'vec3 transformed = vec3( position );',
            '{',
            '  float hang = 1.0 - uv.y;',
            '  vec3 wp = ( modelMatrix * vec4( position, 1.0 ) ).xyz;',
            '  float ph = uBTime * 1.7 + wp.x * 0.35 + wp.z * 0.27;',
            '  float amp = ( 0.05 + 0.035 * uBWind ) * hang * hang;',
            '  transformed.x += sin( ph ) * amp + sin( ph * 2.3 + wp.y ) * amp * 0.35;',
            '  transformed.z += cos( ph * 0.8 + 1.3 ) * amp * 0.8;',
            '  transformed.y += ( 1.0 - cos( ph ) ) * amp * 0.25;',
            '}',
          ].join('\n'));
        };
        m.customProgramCacheKey = function () { return 'bld_banner_wind_v1'; };
        break;
      case 'awning': m = new T.MeshStandardMaterial({ map: makeTex(256, 64, texAwning, true), roughness: 1, side: T.DoubleSide }); break;
      case 'rug': m = new T.MeshStandardMaterial({ map: makeTex(256, 256, texRug('man'), false), roughness: 1 }); break;
      case 'rug_elf': m = new T.MeshStandardMaterial({ map: makeTex(256, 256, texRug('elf'), false), roughness: 1 }); break;
      case 'rug_dwarf': m = new T.MeshStandardMaterial({ map: makeTex(256, 256, texRug('dwarf'), false), roughness: 1 }); break;
      case 'water': m = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.35, transparent: true, opacity: 0.85 }); break;
      case 'glass': m = new T.MeshStandardMaterial({ color: 0x5a6a7a, emissive: 0xffb050, emissiveIntensity: 0.08, roughness: 0.25, metalness: 0.4 }); break;
      case 'ember': m = new T.MeshStandardMaterial({ vertexColors: true, color: 0xffffff, emissive: 0xff5a10, emissiveIntensity: 1.6, roughness: 0.9 }); break;
      case 'lampglow': m = new T.MeshStandardMaterial({ color: 0xfff1c8, emissive: 0xffc070, emissiveIntensity: 0.15, roughness: 0.6 }); break;
      case 'elfglow': m = new T.MeshStandardMaterial({ color: 0xe8f2ff, emissive: 0x9ec8ff, emissiveIntensity: 0.5, roughness: 0.5 }); break;
      default: m = new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    }
    m.name = 'bld_' + key;
    MAT[key] = m;
    return m;
  }
  const TEXTURED = { stone: 1, rock: 1, brick: 1, wood: 1, planks: 1, thatch: 1, plaster: 1, tile: 1, grass: 1, hide: 1 };
  const NO_VCOL = { glass: 1, lampglow: 1, elfglow: 1, rug: 1, rug_elf: 1, rug_dwarf: 1, awning: 1 };

  /* ------------------------------------------------------------------------------------------------ */
  /* geometry utilities                                                                                 */
  /* ------------------------------------------------------------------------------------------------ */
  const _col = new T.Color();
  function tintGeo(geo, hex, jit, rng, faceJit) {
    const n = geo.attributes.position.count;
    const a = new Float32Array(n * 3);
    _col.setHex(hex);
    const r = _col.r, g = _col.g, b = _col.b;
    let f = 1;
    for (let i = 0; i < n; i++) {
      if (jit && (!faceJit || i % 6 === 0)) f = 1 + (rng() - 0.5) * 2 * jit;
      a[i * 3] = Math.min(1, r * f); a[i * 3 + 1] = Math.min(1, g * f); a[i * 3 + 2] = Math.min(1, b * f);
    }
    geo.setAttribute('color', new T.BufferAttribute(a, 3));
  }
  function boxUV(geo, scale) {
    const p = geo.attributes.position, nrm = geo.attributes.normal;
    let uv = geo.attributes.uv;
    if (!uv || uv.count !== p.count) { uv = new T.BufferAttribute(new Float32Array(p.count * 2), 2); geo.setAttribute('uv', uv); }
    const inv = 1 / scale;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const ax = Math.abs(nrm.getX(i)), ay = Math.abs(nrm.getY(i)), az = Math.abs(nrm.getZ(i));
      if (ay >= ax && ay >= az) uv.setXY(i, x * inv, z * inv);
      else if (ax >= az) uv.setXY(i, z * inv, y * inv);
      else uv.setXY(i, x * inv, y * inv);
    }
    uv.needsUpdate = true;
  }
  function invertGeo(geo) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
    for (let i = 0; i < p.count; i += 3) {
      // swap vertices 1 and 2 of each triangle
      for (const at of [p, n, uv]) {
        if (!at) continue;
        const k = at.itemSize;
        for (let c = 0; c < k; c++) { const t1 = at.array[(i + 1) * k + c]; at.array[(i + 1) * k + c] = at.array[(i + 2) * k + c]; at.array[(i + 2) * k + c] = t1; }
      }
    }
    if (n) for (let i = 0; i < n.count; i++) n.setXYZ(i, -n.getX(i), -n.getY(i), -n.getZ(i));
    return g;
  }
  function wallGeo(L, H, t, holes, gable, skirt) {
    const sh = new T.Shape();
    sh.moveTo(-L / 2, -skirt); sh.lineTo(L / 2, -skirt); sh.lineTo(L / 2, H);
    if (gable) sh.lineTo(0, gable);
    sh.lineTo(-L / 2, H); sh.closePath();
    for (const h of holes) {
      const p = new T.Path();
      if (h.r) p.absarc(h.s, h.y, h.r, 0, TAU, false);
      else if (h.arch) { const w2 = h.w / 2; p.moveTo(h.s - w2, h.y); p.lineTo(h.s + w2, h.y); p.lineTo(h.s + w2, h.y + h.h - w2); p.absarc(h.s, h.y + h.h - w2, w2, 0, PI, false); p.lineTo(h.s - w2, h.y); }
      else { const w2 = h.w / 2; p.moveTo(h.s - w2, h.y); p.lineTo(h.s + w2, h.y); p.lineTo(h.s + w2, h.y + h.h); p.lineTo(h.s - w2, h.y + h.h); p.closePath(); }
      sh.holes.push(p);
    }
    const g = new T.ExtrudeGeometry(sh, { depth: t, bevelEnabled: false, curveSegments: 10 });
    g.translate(0, 0, -t / 2);
    return g;
  }
  function chevronRoofGeo(span, y0, y1, th, len, curved) {
    // cross-section in (a, y): a across the ridge, extruded along z by len (centred)
    const sh = new T.Shape();
    sh.moveTo(-span / 2, y0);
    if (curved) { sh.quadraticCurveTo(-span * 0.22, y0 + (y1 - y0) * 0.25, 0, y1); sh.quadraticCurveTo(span * 0.22, y0 + (y1 - y0) * 0.25, span / 2, y0); }
    else { sh.lineTo(0, y1); sh.lineTo(span / 2, y0); }
    sh.lineTo(span / 2, y0 - th);
    if (curved) { sh.quadraticCurveTo(span * 0.22, y0 - th + (y1 - y0) * 0.25, 0, y1 - th); sh.quadraticCurveTo(-span * 0.22, y0 - th + (y1 - y0) * 0.25, -span / 2, y0 - th); }
    else { sh.lineTo(0, y1 - th); sh.lineTo(-span / 2, y0 - th); }
    sh.closePath();
    const g = new T.ExtrudeGeometry(sh, { depth: len, bevelEnabled: false, curveSegments: 8 });
    g.translate(0, 0, -len / 2);
    return g;
  }
  function latheGeo(points, seg) { return new T.LatheGeometry(points.map(p => new T.Vector2(p[0], p[1])), seg || 12); }
  function domeGeo(r, wseg, hseg) { return new T.SphereGeometry(r, wseg || 24, hseg || 12, 0, TAU, 0, HPI); }

  /* ------------------------------------------------------------------------------------------------ */
  /* Builder — accumulates vertex-coloured pieces into (group × material) buckets + placement metadata  */
  /* Local frame: building centre at origin on the ground (y=0), FRONT/door side = -z (yaw 0 = facing -Z). */
  /* ------------------------------------------------------------------------------------------------ */
  const _q = new T.Quaternion(), _up = new T.Vector3(0, 1, 0), _dir = new T.Vector3();
  class Builder {
    constructor(key, seed) {
      this.key = key; this.rng = rngOf(seed); this.buckets = {}; this.cur = null; this.stack = [];
      this.meta = { walls: [], boxes: [], cyls: [], doors: [], lights: [], hearths: [], smokes: [], spots: [], signs: [], horses: [], interior: null, ceilings: [], radius: 0, minY: 0, maxY: 0 };
      this._min = new T.Vector3(Infinity, Infinity, Infinity); this._max = new T.Vector3(-Infinity, -Infinity, -Infinity);
    }
    at(x, z, ry, y) {
      this.stack.push(this.cur);
      const p = this.xf(x || 0, y || 0, z || 0);
      const r = this.yaw(ry || 0);
      this.cur = { x: p.x, y: p.y, z: p.z, ry: r, c: Math.cos(r), s: Math.sin(r) };
      return this;
    }
    end() { this.cur = this.stack.length ? this.stack.pop() : null; }
    xf(x, y, z) { const c = this.cur; if (!c) return { x, y, z }; return { x: x * c.c + z * c.s + c.x, y: y + c.y, z: -x * c.s + z * c.c + c.z }; }
    yaw(ry) { return this.cur ? ry + this.cur.ry : ry; }
    _expand(geo) {
      geo.computeBoundingBox(); const bb = geo.boundingBox;
      this._min.min(bb.min); this._max.max(bb.max);
    }
    piece(grp, mat, geo, x, y, z, hex, o) {
      o = o || {};
      if (o.sx !== undefined || o.sy !== undefined || o.sz !== undefined) geo.scale(o.sx === undefined ? 1 : o.sx, o.sy === undefined ? 1 : o.sy, o.sz === undefined ? 1 : o.sz);
      if (o.rx) geo.rotateX(o.rx);
      if (o.rz) geo.rotateZ(o.rz);
      if (o.ry) geo.rotateY(o.ry);
      geo.translate(x, y, z);
      const c = this.cur;
      if (c) { if (c.ry) geo.rotateY(c.ry); geo.translate(c.x, c.y, c.z); }
      if (geo.index) geo = geo.toNonIndexed();
      if (!geo.attributes.normal) geo.computeVertexNormals();
      tintGeo(geo, hex === undefined ? 0xffffff : hex, o.jit === undefined ? 0.05 : o.jit, this.rng, o.faceJit !== false);
      if (TEXTURED[mat]) boxUV(geo, (o.uv || 1) * UV_SCALE[mat]);
      this._expand(geo);
      const bk = this.buckets[grp] || (this.buckets[grp] = {});
      (bk[mat] || (bk[mat] = [])).push(geo);
      return geo;
    }
    box(grp, mat, w, h, d, x, y, z, hex, o) { return this.piece(grp, mat, new T.BoxGeometry(w, h, d), x, y, z, hex, o); }
    cyl(grp, mat, rt, rb, h, seg, x, y, z, hex, o) { o = o || {}; return this.piece(grp, mat, new T.CylinderGeometry(rt, rb, h, seg || 12, 1, !!o.open, o.ts || 0, o.tl === undefined ? TAU : o.tl), x, y, z, hex, o); }
    sph(grp, mat, r, x, y, z, hex, o) { return this.piece(grp, mat, new T.SphereGeometry(r, 10, 7), x, y, z, hex, o); }
    cone(grp, mat, r, h, seg, x, y, z, hex, o) { o = o || {}; return this.piece(grp, mat, new T.ConeGeometry(r, h, seg || 12, 1, !!o.open, o.ts || 0, o.tl === undefined ? TAU : o.tl), x, y, z, hex, o); }
    torus(grp, mat, R, r, x, y, z, hex, o) { return this.piece(grp, mat, new T.TorusGeometry(R, r, 7, 22), x, y, z, hex, o); }
    plane(grp, mat, w, h, x, y, z, hex, o) { return this.piece(grp, mat, new T.PlaneGeometry(w, h), x, y, z, hex, o); }
    lathe(grp, mat, pts, seg, x, y, z, hex, o) { return this.piece(grp, mat, latheGeo(pts, seg), x, y, z, hex, o); }
    rod(grp, mat, x0, y0, z0, x1, y1, z1, r, hex, o) {   // cylinder from point A to point B (cursor frame)
      const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0, len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
      const g = new T.CylinderGeometry(r, r, len, 5);
      _q.setFromUnitVectors(_up, _dir.set(dx / len, dy / len, dz / len)); g.applyQuaternion(_q);
      return this.piece(grp, mat, g, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, hex, Object.assign({ jit: 0 }, o || {}));
    }
    // metadata (all transformed through the cursor)
    wallCol(x1, z1, x2, z2, h, t) { const a = this.xf(x1, 0, z1), b = this.xf(x2, 0, z2); this.meta.walls.push({ x1: a.x, z1: a.z, x2: b.x, z2: b.z, h: h || 3, t: t || 0.3 }); }
    // Box collider in the cursor frame. With `cell` the box is cut into ≤ cell-sized pieces whose ORIENTED corners are
    // kept, so a rotated building (or a rotated cursor: stairs, spiral steps) gets a tight world AABB per piece instead
    // of one big axis-aligned blob — a blob three treads ahead is exactly what used to block the way up rotated stairs.
    boxCol(minx, miny, minz, maxx, maxy, maxz, floor, cell) {
      const cy = this.cur ? this.cur.y : 0;
      const nx = cell ? Math.max(1, Math.ceil((maxx - minx) / cell)) : 1, nz = cell ? Math.max(1, Math.ceil((maxz - minz) / cell)) : 1;
      for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
        const x0 = minx + (maxx - minx) * i / nx, x1 = minx + (maxx - minx) * (i + 1) / nx, z0 = minz + (maxz - minz) * j / nz, z1 = minz + (maxz - minz) * (j + 1) / nz;
        const p1 = this.xf(x0, 0, z0), p2 = this.xf(x1, 0, z1), p3 = this.xf(x0, 0, z1), p4 = this.xf(x1, 0, z0);
        this.meta.boxes.push({ minx: Math.min(p1.x, p2.x, p3.x, p4.x), maxx: Math.max(p1.x, p2.x, p3.x, p4.x), minz: Math.min(p1.z, p2.z, p3.z, p4.z), maxz: Math.max(p1.z, p2.z, p3.z, p4.z), miny: miny + cy, maxy: maxy + cy, floor: !!floor, corners: cell ? [p1.x, p1.z, p4.x, p4.z, p2.x, p2.z, p3.x, p3.z] : null });
      }
    }
    cylCol(x, z, r, h) { const p = this.xf(x, 0, z); this.meta.cyls.push({ x: p.x, z: p.z, r, h, y: p.y }); }
    ringCol(x, z, r, h, n, gapAngle, gapWidth) {   // polygonal ring of wall colliders, optional gap centred at gapAngle (0 = -z)
      n = n || 12;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * TAU, a1 = ((i + 1) / n) * TAU, am = (a0 + a1) / 2;
        if (gapWidth) { let d = Math.atan2(Math.sin(am - gapAngle), Math.cos(am - gapAngle)); if (Math.abs(d) * r < gapWidth / 2 + 0.3) continue; }
        this.wallCol(x - Math.sin(a0) * r, z - Math.cos(a0) * r, x - Math.sin(a1) * r, z - Math.cos(a1) * r, h, 0.3);
      }
    }
    floor(minx, minz, maxx, maxz, y, mat, hex, grp, th) {
      th = th || 0.12;
      this.box(grp || 'int', mat || 'planks', maxx - minx, th, maxz - minz, (minx + maxx) / 2, y - th / 2, (minz + maxz) / 2, hex === undefined ? 0x9a6f48 : hex, { jit: 0.04 });
      this.boxCol(minx, y - th, minz, maxx, y, maxz, true);
    }
    door(d) { const p = this.xf(d.x, d.y || 0, d.z); this.meta.doors.push(Object.assign({}, d, { x: p.x, y: p.y, z: p.z, ry: this.yaw(d.ry || 0) })); }
    light(x, y, z, o) {
      o = o || {}; const p = this.xf(x, y, z);
      this.meta.lights.push({ x: p.x, y: p.y, z: p.z, color: o.color || 0xffa040, intensity: o.intensity || 40, dist: o.dist || 12, kind: o.kind || 'fire', flicker: o.flicker === undefined ? (o.kind === 'fire' || !o.kind) : o.flicker, interior: !!o.interior });
    }
    hearth(x, y, z, scale, kind) { const p = this.xf(x, y, z); this.meta.hearths.push({ x: p.x, y: p.y, z: p.z, scale: scale || 1, kind: kind || 'fire_static' }); }
    smoke(x, y, z) { this.meta.smokes.push(this.xf(x, y, z)); }
    spot(x, z, ry, role, y) { const p = this.xf(x, y || 0, z); this.meta.spots.push({ x: p.x, y: p.y, z: p.z, yaw: this.yaw(ry || 0), role: role || 'idle' }); }
    interior(minx, miny, minz, maxx, maxy, maxz) { this.meta.interior = { minx, miny, minz, maxx, maxy, maxz }; }
    ceiling(grp, y) { this.meta.ceilings.push({ grp, y }); }
    sign(x, y, z, ry, w, h) { const p = this.xf(x, y, z); this.meta.signs.push({ x: p.x, y: p.y, z: p.z, ry: this.yaw(ry || 0), w: w || 1.4, h: h || 0.45 }); }
    horse(x, z, ry) { const p = this.xf(x, 0, z); this.meta.horses.push({ x: p.x, z: p.z, yaw: this.yaw(ry || 0) }); }
    build() {
      const groups = {};
      for (const grp in this.buckets) {
        const list = [];
        for (const mat in this.buckets[grp]) { const geo = mergeGeos(this.buckets[grp][mat]); if (geo) list.push({ mat, geo }); }
        groups[grp] = list;
      }
      const m = this.meta;
      if (this._min.x < Infinity) {
        m.radius = Math.max(Math.abs(this._min.x), Math.abs(this._max.x), Math.abs(this._min.z), Math.abs(this._max.z)) * 1.05 + 0.5;
        m.minY = this._min.y; m.maxY = this._max.y;
      }
      this.buckets = null;
      return { groups, meta: m };
    }
  }

  /* ------------------------------------------------------------------------------------------------ */
  /* House shell: 4 walls with door/window holes (+gables), plinth, timber framing, roof, chimney       */
  /* holes: { side:'f'|'b'|'l'|'r', u (along wall), y (bottom), w, h | r (round), arch, door, kind, hinge, leaves } */
  /* ------------------------------------------------------------------------------------------------ */
  const SIDE = {
    f: (W, D) => ({ x: 0, z: -D / 2, ry: 0, mir: 1 }),
    b: (W, D) => ({ x: 0, z: D / 2, ry: PI, mir: -1 }),
    l: (W, D) => ({ x: -W / 2, z: 0, ry: HPI, mir: -1 }),
    r: (W, D) => ({ x: W / 2, z: 0, ry: -HPI, mir: 1 }),
  };
  function sideMap(side, W, D, u) {
    switch (side) { case 'f': return { x: u, z: -D / 2 }; case 'b': return { x: u, z: D / 2 }; case 'l': return { x: -W / 2, z: u }; default: return { x: W / 2, z: u }; }
  }
  // [lo,hi] minus the sorted door cuts {a,b} → the runs of wall a continuous strip (plinth, sill rail) may cover
  function openSpans(lo, hi, cuts) {
    const out = []; let x0 = lo;
    for (const c of cuts) { if (c.a > x0 + 0.05) out.push([x0, Math.min(c.a, hi)]); if (c.b > x0) x0 = c.b; }
    if (hi > x0 + 0.05) out.push([x0, hi]);
    return out;
  }
  function shell(b, o) {
    const W = o.W, D = o.D, H = o.h, t = o.t || 0.35, skirt = o.skirt === undefined ? 1.0 : o.skirt;
    const wallMat = o.wallMat || 'plaster', wallHex = o.wallHex === undefined ? 0xe6dcc4 : o.wallHex;
    const woodHex = o.woodHex === undefined ? 0x5a3c25 : o.woodHex;
    const ridgeX = o.ridge !== 'z';
    const bySide = { f: [], b: [], l: [], r: [] };
    for (const h of (o.holes || [])) bySide[h.side].push(h);
    for (const side of ['f', 'b', 'l', 'r']) {
      const c = SIDE[side](W, D);
      const L = (side === 'f' || side === 'b') ? W : D;
      const list = bySide[side];
      const gable = (o.peak && ((ridgeX && (side === 'l' || side === 'r')) || (!ridgeX && (side === 'f' || side === 'b')))) ? o.peak : 0;
      const holes = list.map(h => Object.assign({}, h, { s: c.mir * h.u }));
      const g = wallGeo(L, H, t, holes, gable, skirt);
      b.piece('ext', wallMat, g, c.x, 0, c.z, wallHex, { ry: c.ry, jit: o.wallJit === undefined ? 0.02 : o.wallJit, faceJit: false });
      const doors = list.filter(h => h.door).sort((p, q) => p.u - q.u);
      // door openings in wall-local s (mirrored like the holes): the plinth and the timber sill rail stop at them
      const cuts = doors.map(d => { const hw = (d.r ? d.r : d.w / 2) + 0.18; return { a: c.mir * d.u - hw, b: c.mir * d.u + hw }; }).sort((p, q) => p.a - q.a);
      // Wall colliders, one run between doorways. Physics.addWall extends a wall by half its THICKNESS at each end
      // (so adjoining walls close at corners), which used to eat t/2 off both sides of every doorway: a 1.1 m door in
      // a 0.35 m wall left a 0.75 m gap — narrower than the player's own diameter, the invisible barrier in the
      // doorway. Ends that meet a door are therefore pulled back by t/2 so the gap matches the opening you can see.
      const wt = Math.max(0.3, t), back = wt / 2;
      const segCol = (ua, ub, trimA, trimB) => {
        const a = ua + (trimA ? back : 0), c2 = ub - (trimB ? back : 0);
        if (c2 - a < 0.05) return;
        const p = sideMap(side, W, D, a), q = sideMap(side, W, D, c2);
        b.wallCol(p.x, p.z, q.x, q.z, gable || H, wt);
      };
      let u0 = -L / 2, trimA = false;
      for (const d of doors) { const hw = (d.r ? d.r : d.w / 2); segCol(u0, d.u - hw, trimA, true); u0 = d.u + hw; trimA = true; }
      segCol(u0, L / 2, trimA, false);
      b.at(c.x, c.z, c.ry);
      for (const h of list) {
        const s = c.mir * h.u;
        if (h.door) {
          const fw = 0.14;
          if (h.r) {
            b.torus('ext', h.frameMat || 'brick', h.r + 0.1, 0.13, s, h.y, -t / 2 + 0.02, h.frameHex || 0xa8694a, { jit: 0.08 });
          } else {
            b.box('ext', 'wood', fw, h.h + 0.1, t + 0.16, s - h.w / 2 - fw / 2 + 0.02, (h.h + 0.1) / 2, 0, woodHex);
            b.box('ext', 'wood', fw, h.h + 0.1, t + 0.16, s + h.w / 2 + fw / 2 - 0.02, (h.h + 0.1) / 2, 0, woodHex);
            if (h.arch) b.torus('ext', 'wood', h.w / 2 + 0.05, 0.08, s, h.y + h.h - h.w / 2, 0, woodHex, { sz: (t + 0.16) / 0.16 });
            else b.box('ext', 'wood', h.w + fw * 2, fw + 0.04, t + 0.16, s, h.h + 0.06, 0, woodHex);
          }
          // Doorstep. The slab is only decoration, so the walk-in also gets floor colliders in 0.25 m tiers marching
          // down and out from the threshold: on flat ground the lower tiers are buried and ignored, and on a slope
          // (where the interior floor can sit ~1 m above the grade outside, far beyond the 0.6 m step-up) they turn
          // an unclimbable lip into a short flight. Without them a plinthed house is simply not enterable downhill.
          const dw = (h.r ? h.r * 2 : h.w) + 0.4;
          b.box('ext', 'stone', dw + 0.1, 0.12, 0.9, s, -0.02, -t / 2 - 0.4, 0x8d8579, { jit: 0.06 });
          for (let k = 0; k < 5; k++) {
            const yTop = 0.05 - k * 0.25, z1 = -t / 2 - 0.1 - k * 0.42, z0 = z1 - (k === 0 ? 0.5 : 0.44);
            b.boxCol(s - dw / 2, yTop - 0.45, z0, s + dw / 2, yTop, k === 0 ? t / 2 : z1, true, 1.2);
          }
          const dp = sideMap(side, W, D, h.u);
          b.end();
          b.door({ x: dp.x, z: dp.z, ry: c.ry, w: h.r ? h.r * 2 : h.w, h: h.r ? h.r * 2 : h.h, kind: h.kind || (h.r ? 'round' : h.arch ? 'arch' : 'plain'), hinge: h.hinge || -1, leaves: h.leaves || 1, hex: h.doorHex, y: h.r ? h.y - h.r : 0, t });
          b.at(c.x, c.z, c.ry);
        } else if (h.r) {
          b.cyl('ext', 'glass', h.r - 0.02, h.r - 0.02, 0.05, 16, s, h.y, 0, 0xffffff, { rx: HPI });
          b.torus('ext', h.frameMat || 'brick', h.r + 0.08, 0.1, s, h.y, -t / 2 - 0.01, h.frameHex || 0xa8694a, { jit: 0.08 });
          b.box('ext', 'wood', 0.05, h.r * 2 - 0.04, 0.08, s, h.y, 0, woodHex); b.box('ext', 'wood', h.r * 2 - 0.04, 0.05, 0.08, s, h.y, 0, woodHex);
        } else {
          const cy = h.y + h.h / 2;
          b.box('ext', 'glass', h.w - 0.02, h.h - 0.02, 0.05, s, cy, 0, 0xffffff);
          const fh = h.arch ? h.h - h.w / 2 : h.h;
          b.box('ext', 'wood', 0.08, fh, t + 0.1, s - h.w / 2 - 0.03, h.y + fh / 2, 0, woodHex);
          b.box('ext', 'wood', 0.08, fh, t + 0.1, s + h.w / 2 + 0.03, h.y + fh / 2, 0, woodHex);
          if (h.arch) b.torus('ext', 'wood', h.w / 2 + 0.03, 0.05, s, h.y + fh, 0, woodHex, { sz: (t + 0.1) / 0.1 });
          else b.box('ext', 'wood', h.w + 0.14, 0.08, t + 0.1, s, h.y + h.h + 0.03, 0, woodHex);
          b.box('ext', 'wood', 0.06, h.h - 0.04, 0.08, s, cy, 0, woodHex);
          b.box('ext', 'wood', h.w - 0.04, 0.06, 0.08, s, cy, 0, woodHex);
          b.box('ext', o.sillMat || 'stone', h.w + 0.3, 0.1, t + 0.3, s, h.y - 0.04, 0, o.sillHex || 0x9a9285, { jit: 0.05 });
          if (o.shutters) {
            b.box('ext', 'wood', 0.32, h.h - 0.05, 0.05, s - h.w / 2 - 0.25, cy, -t / 2 - 0.04, o.shutterHex || 0x6b4a2a);
            b.box('ext', 'wood', 0.32, h.h - 0.05, 0.05, s + h.w / 2 + 0.25, cy, -t / 2 - 0.04, o.shutterHex || 0x6b4a2a);
          }
        }
      }
      if (o.timber) {
        const zo = -(t / 2 + 0.055), bw = 0.13, y0 = (o.baseH || 0) + 0.05;
        const hexT = o.timberHex || 0x4a3220;
        for (const sp of openSpans(-L / 2 - 0.05, L / 2 + 0.05, cuts)) b.box('ext', 'wood', sp[1] - sp[0], bw, 0.11, (sp[0] + sp[1]) / 2, y0 + bw / 2, zo, hexT);   // sill rail, not across doors
        b.box('ext', 'wood', L + 0.1, bw, 0.11, 0, H - bw / 2, zo, hexT);
        const n = Math.max(2, Math.round(L / 1.5));
        for (let i = 0; i <= n; i++) {
          const s = clamp(-L / 2 + (L / n) * i, -L / 2 + bw / 2, L / 2 - bw / 2);
          const clash = list.some(h => Math.abs(c.mir * h.u - s) < (h.r ? h.r : h.w / 2) + 0.2);
          if (clash) continue;
          b.box('ext', 'wood', bw, H - y0, 0.11, s, y0 + (H - y0) / 2, zo, hexT);
        }
        const bl = Math.min(1.5, (H - y0) * 0.55);
        for (const sg of [-1, 1]) {
          const s = sg * (L / 2 - 0.5);
          const clash = list.some(h => Math.abs(c.mir * h.u - s) < (h.r ? h.r : h.w / 2) + 0.6);
          if (!clash) b.box('ext', 'wood', bw * 0.9, bl, 0.1, s, y0 + bl * 0.5 + 0.1, zo, hexT, { rz: sg * 0.7 });
        }
        if (gable) {
          const gh = gable - H;
          for (const s of [-L / 4, 0, L / 4]) { const hh = gh * (1 - Math.abs(s) / (L / 2)) - 0.08; if (hh > 0.3) b.box('ext', 'wood', bw, hh, 0.11, s, H + hh / 2, zo, hexT); }
        }
      }
      if (o.baseH) {   // stone plinth, in runs that STOP at every doorway (it used to run straight across the door, reading as a knee-high wall)
        const e = 0.12, bh = o.baseH + skirt, cy = (o.baseH - skirt) / 2, hexS = o.baseHex || 0x8f887c;
        const ext = (side === 'f' || side === 'b') ? e + t / 2 : t / 2;
        for (const sp of openSpans(-L / 2 - ext, L / 2 + ext, cuts)) b.box('ext', 'stone', sp[1] - sp[0], bh, e + t / 2, (sp[0] + sp[1]) / 2, cy, -(e / 2 + t / 4), hexS, { jit: 0.08 });
      }
      b.end();
    }
    if (o.floor !== false) b.floor(-W / 2 - t / 2, -D / 2 - t / 2, W / 2 + t / 2, D / 2 + t / 2, 0.05, o.floorMat || 'planks', o.floorHex === undefined ? 0x9a6f48 : o.floorHex);
    b.interior(-W / 2 + t / 2, -0.5, -D / 2 + t / 2, W / 2 - t / 2, (o.peak || H) + 0.5, D / 2 - t / 2);
    const ceil = shellCeiling(b, o, W, D, H, t, ridgeX);
    if (o.roof !== false && o.peak) {
      const ov = o.overhang === undefined ? 0.5 : o.overhang, th = o.roofTh || 0.3;
      const across = ridgeX ? D : W, along = ridgeX ? W : D;
      const span = across + 2 * ov, len = along + 2 * ov;
      const k = (o.peak - H) / (across / 2);
      const ye = H - k * ov;
      const g = chevronRoofGeo(span, ye, o.peak, th, len, !!o.curvedRoof);
      b.piece('roof', o.roofMat || 'thatch', g, 0, 0, 0, o.roofHex === undefined ? 0x9c7f47 : o.roofHex, { ry: ridgeX ? -HPI : 0, jit: 0.04, faceJit: false });
      const capHex = o.capHex === undefined ? 0x6e5430 : o.capHex;
      b.cyl('roof', o.roofMat || 'thatch', 0.2, 0.2, len + 0.1, 8, 0, o.peak - 0.02, 0, capHex, ridgeX ? { rz: HPI } : { rx: HPI });
    }
    for (const ch of (o.chimneys || (o.chimney ? [o.chimney] : []))) {
      const cs = sideMap(ch.side, W, D, ch.u);
      const out = { f: [0, -1], b: [0, 1], l: [-1, 0], r: [1, 0] }[ch.side];
      const cx = cs.x + out[0] * 0.3, cz = cs.z + out[1] * 0.3, top = (o.peak || H) + 0.9;
      b.box('ext', 'stone', 1.0, top + 1, 1.0, cx, top / 2 - 0.5, cz, o.chimneyHex || 0x8b8377, { jit: 0.08 });
      b.box('ext', 'stone', 1.25, 0.25, 1.25, cx, top + 0.1, cz, 0x7d766b, { jit: 0.05 });
      b.box('ext', 'stone', 0.5, 0.06, 0.5, cx, top + 0.25, cz, 0x151210, { jit: 0 });
      b.smoke(cx, top + 0.35, cz);
    }
    return { W, D, H, t, ceilY: ceil.y0, vaultY1: ceil.y1, vault: ceil.vault };
  }

  /* Interior ceiling of a shell building — part of the 'int' group, so it is NEVER hidden while the player is inside
     (the sky used to show through the hidden roof). o.ceiling: 'flat' (default: boards + joists + summer beam, just
     under the roof's inner edge) | 'vault' (the pitched roof underside itself: inner shell, rafters, purlins, ridge
     beam, optional tie beams — halls and the inn's upper storey) | false. Also adds the thin ceiling collider that
     clamps the chase camera under it and stops jumps (cut into 4 m cells so rotated buildings stay tight). */
  function shellCeiling(b, o, W, D, H, t, ridgeX) {
    const mode = o.ceiling === undefined ? 'flat' : o.ceiling;
    const rth = o.roofTh || 0.3;
    const y0 = o.ceilY !== undefined ? o.ceilY : H - rth - 0.02;
    const y1 = (o.peak || H) - rth - 0.02;
    const across = ridgeX ? D : W, along = ridgeX ? W : D;
    if (!mode) return { y0, y1, vault: false };
    const beamHex = o.beamHex || o.rafterHex || o.timberHex || 0x4a3220;
    if (mode === 'vault' && o.peak) {
      const vHex = o.vaultHex === undefined ? 0xa88a62 : o.vaultHex, vMat = o.vaultMat || 'planks';
      b.piece('int', vMat, chevronRoofGeo(across + t, y0, y1, 0.08, along + t, !!o.curvedRoof), 0, 0, 0, vHex, { ry: ridgeX ? -HPI : 0, jit: 0.03, faceJit: false });
      b.at(0, 0, ridgeX ? -HPI : 0);          // cursor frame: ridge along local z, slopes along local ±x
      const half = across / 2 + t / 2, rise = y1 - y0, sl = Math.sqrt(half * half + rise * rise), ang = Math.atan2(rise, half);
      const nr = Math.max(2, Math.round(along / 1.4));
      for (let i = 0; i <= nr; i++) {
        const z = -along / 2 + t / 2 + 0.1 + (along - t - 0.2) * i / nr;
        for (const s of [-1, 1]) b.box('int', 'wood', sl - 0.15, 0.14, 0.12, s * half / 2, y0 + rise / 2 - 0.16, z, beamHex, { rz: -s * ang, jit: 0.02 });   // rafters
      }
      for (const f of [0.34, 0.68]) for (const s of [-1, 1]) b.box('int', 'wood', 0.14, 0.14, along + t - 0.1, s * half * (1 - f), y0 + rise * f - 0.3, 0, beamHex, { jit: 0.02 });   // purlins
      b.box('int', 'wood', 0.2, 0.2, along + t - 0.1, 0, y1 - 0.3, 0, beamHex, { jit: 0.02 });                                                                  // ridge beam
      if (o.ties !== false) { const nt = Math.max(1, Math.round(along / 2.6)); for (let i = 1; i < nt; i++) b.box('int', 'wood', across - t + 0.02, 0.22, 0.2, 0, y0 - 0.19, -along / 2 + (along / nt) * i, beamHex, { jit: 0.02 }); }   // tie beams
      b.end();
      b.boxCol(-W / 2 + t / 2, y0, -D / 2 + t / 2, W / 2 - t / 2, y0 + 0.1, D / 2 - t / 2, false, 4);
      return { y0, y1, vault: true };
    }
    // flat: ceiling boards (both faces — casts a real shadow into the room) + joists across the short span + a summer beam
    const cHex = o.ceilHex === undefined ? 0xd9c7a2 : o.ceilHex;
    b.box('int', o.ceilMat || 'planks', W + t, 0.1, D + t, 0, y0 + 0.05, 0, cHex, { jit: 0.03 });
    const alongX = W >= D, span = alongX ? W : D;
    const n = Math.max(2, Math.round(span / 1.5));
    for (let i = 1; i < n; i++) {
      const s = -span / 2 + (span / n) * i;
      if (alongX) b.box('int', 'wood', 0.16, 0.2, D - t + 0.02, s, y0 - 0.1, 0, beamHex, { jit: 0.03 });
      else b.box('int', 'wood', W - t + 0.02, 0.2, 0.16, 0, y0 - 0.1, s, beamHex, { jit: 0.03 });
    }
    if (alongX) b.box('int', 'wood', W - t + 0.02, 0.22, 0.24, 0, y0 - 0.31, 0, beamHex, { jit: 0.03 }); else b.box('int', 'wood', 0.24, 0.22, D - t + 0.02, 0, y0 - 0.31, 0, beamHex, { jit: 0.03 });
    b.boxCol(-W / 2 + t / 2, y0, -D / 2 + t / 2, W / 2 - t / 2, y0 + 0.1, D / 2 - t / 2, false, 4);
    return { y0, y1, vault: false };
  }

  /* ------------------------------------------------------------------------------------------------ */
  /* Furniture library (built in the current cursor frame; origin on the floor, front = -z)             */
  /* ------------------------------------------------------------------------------------------------ */
  const WOOD_F = 0x7d5433, WOOD_D = 0x4f3420, WOOD_L = 0xa87a4e, STONE_I = 0x8a8378, CREAM = 0xe9dfc8;
  const BLANKETS = [0x8c3a32, 0x3e6a44, 0x3a5a8c, 0x8a6a2a, 0x6a3a6a];
  const F = {
    table(b, g, w, d, hex) {
      hex = hex || WOOD_F;
      b.box(g, 'wood', w, 0.07, d, 0, 0.77, 0, hex);
      b.box(g, 'wood', w - 0.3, 0.1, d - 0.3, 0, 0.68, 0, hex);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(g, 'wood', 0.09, 0.72, 0.09, sx * (w / 2 - 0.14), 0.36, sz * (d / 2 - 0.14), WOOD_D);
    },
    bench(b, g, len, hex) {
      hex = hex || WOOD_F;
      b.box(g, 'wood', len, 0.06, 0.34, 0, 0.46, 0, hex);
      for (const s of [-1, 1]) b.box(g, 'wood', 0.08, 0.44, 0.3, s * (len / 2 - 0.2), 0.22, 0, WOOD_D);
    },
    stool(b, g) {
      b.cyl(g, 'wood', 0.19, 0.17, 0.05, 10, 0, 0.45, 0, WOOD_F);
      for (let i = 0; i < 3; i++) { const a = i * TAU / 3; b.cyl(g, 'wood', 0.025, 0.03, 0.44, 5, Math.sin(a) * 0.12, 0.22, Math.cos(a) * 0.12, WOOD_D, { rz: Math.cos(a) * 0.12, rx: -Math.sin(a) * 0.12 }); }
    },
    chair(b, g, hex) {
      hex = hex || WOOD_F;
      b.box(g, 'wood', 0.46, 0.05, 0.46, 0, 0.46, 0, hex);
      b.box(g, 'wood', 0.46, 0.5, 0.05, 0, 0.75, 0.2, hex);
      b.box(g, 'wood', 0.36, 0.08, 0.04, 0, 0.88, 0.2, WOOD_D);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(g, 'wood', 0.05, 0.46, 0.05, sx * 0.19, 0.23, sz * 0.19, WOOD_D);
    },
    bed(b, g, w, len, bl) {
      w = w || 1.1; len = len || 2.1; bl = bl === undefined ? BLANKETS[0] : bl;
      b.box(g, 'wood', w, 0.3, len, 0, 0.25, 0, WOOD_F);
      b.box(g, 'wood', w, 0.95, 0.07, 0, 0.6, len / 2 - 0.03, WOOD_F);
      b.box(g, 'wood', w, 0.55, 0.07, 0, 0.4, -len / 2 + 0.03, WOOD_F);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(g, 'wood', 0.09, 0.4, 0.09, sx * (w / 2 - 0.05), 0.2, sz * (len / 2 - 0.05), WOOD_D);
      b.box(g, 'flat', w - 0.1, 0.16, len - 0.14, 0, 0.48, 0, CREAM, { jit: 0.02 });
      b.box(g, 'flat', w - 0.06, 0.08, len * 0.62, 0, 0.6, -len * 0.14, bl, { jit: 0.04 });
      b.box(g, 'flat', w * 0.62, 0.13, 0.36, 0, 0.62, len / 2 - 0.35, 0xf3ecdc, { jit: 0.02 });
    },
    shelf(b, g, w, kind, h) {
      h = h || 2.0;
      const n = Math.max(2, Math.round(h / 0.5));
      for (const s of [-1, 1]) b.box(g, 'wood', 0.06, h, 0.32, s * (w / 2 - 0.03), h / 2, 0, WOOD_F);
      b.box(g, 'wood', w, h, 0.03, 0, h / 2, 0.15, WOOD_D, { jit: 0.03 });
      for (let i = 0; i < n; i++) {
        const y = 0.3 + i * ((h - 0.4) / (n - 1));
        b.box(g, 'wood', w - 0.1, 0.04, 0.32, 0, y, 0, WOOD_F);
        F.shelfItems(b, g, w - 0.2, y + 0.02, kind, i);
      }
    },
    shelfItems(b, g, w, y, kind, row) {
      const r = b.rng;
      if (kind === 'books') {
        let x = -w / 2 + 0.05;
        while (x < w / 2 - 0.08) { const bw = 0.04 + r() * 0.05, bh = 0.18 + r() * 0.1; b.box(g, 'flat', bw, bh, 0.16 + r() * 0.06, x + bw / 2, y + bh / 2, 0, [0x7a2a2a, 0x2a4a7a, 0x4a6a2a, 0x8a6a2a, 0x5a3a6a, 0xd8c8a8][Math.floor(r() * 6)], { jit: 0.06 }); x += bw + 0.012; if (r() < 0.15) x += 0.12; }
      } else if (kind === 'bottles') {
        for (let x = -w / 2 + 0.1; x < w / 2 - 0.05; x += 0.13) { if (r() < 0.2) continue; const hx = [0x2f6a3a, 0x6a3a1a, 0x3a5a7a, 0x7a7a5a][Math.floor(r() * 4)]; b.cyl(g, 'flat', 0.04, 0.045, 0.24, 7, x, y + 0.12, 0, hx, { jit: 0.04 }); b.cyl(g, 'flat', 0.016, 0.02, 0.09, 6, x, y + 0.28, 0, hx, { jit: 0.04 }); }
      } else if (kind === 'goods') {
        for (let x = -w / 2 + 0.15; x < w / 2 - 0.1; x += 0.3) {
          const k = Math.floor(r() * 4);
          if (k === 0) b.cyl(g, 'flat', 0.08, 0.07, 0.2, 8, x, y + 0.1, 0, 0xc8b48a, { jit: 0.05 });
          else if (k === 1) b.sph(g, 'flat', 0.11, x, y + 0.09, 0, 0xb9a070, { sy: 0.8, jit: 0.05 });
          else if (k === 2) b.cyl(g, 'flat', 0.07, 0.07, 0.26, 8, x, y + 0.07, 0, [0x8a2a2a, 0x2a4a8a, 0x5a7a2a, 0xe8dcc8][Math.floor(r() * 4)], { rz: HPI, jit: 0.04 });
          else b.box(g, 'wood', 0.22, 0.14, 0.18, x, y + 0.07, 0, WOOD_L, { jit: 0.05 });
        }
      } else { // crockery
        for (let x = -w / 2 + 0.12; x < w / 2 - 0.08; x += 0.24) {
          const k = (row + Math.floor(r() * 3)) % 4;
          if (k === 0) { b.cyl(g, 'flat', 0.11, 0.11, 0.015, 12, x, y + 0.11, 0.04, 0xece4d2, { rx: HPI - 0.2, jit: 0.02 }); }
          else if (k === 1) { b.cyl(g, 'flat', 0.045, 0.04, 0.11, 8, x, y + 0.055, 0, 0x9ca3a8, { jit: 0.04 }); }
          else if (k === 2) { b.lathe(g, 'flat', [[0.02, 0], [0.07, 0.02], [0.08, 0.1], [0.05, 0.18], [0.05, 0.22], [0.06, 0.24]], 10, x, y, 0, 0xb8865a, { jit: 0.04 }); }
          else { b.lathe(g, 'flat', [[0.02, 0], [0.09, 0.02], [0.11, 0.07], [0.1, 0.08]], 10, x, y, 0, 0xd9c9a8, { jit: 0.04 }); }
        }
      }
    },
    cupboard(b, g, w, h) {
      w = w || 1.1; h = h || 1.9;
      b.box(g, 'wood', w, h, 0.5, 0, h / 2, 0, WOOD_F);
      b.box(g, 'wood', w + 0.08, 0.06, 0.56, 0, h + 0.03, 0, WOOD_D);
      for (const s of [-1, 1]) { b.box(g, 'wood', w / 2 - 0.08, h - 0.16, 0.03, s * (w / 4), h / 2, -0.26, WOOD_L, { jit: 0.03 }); b.sph(g, 'metal', 0.025, s * 0.06, h / 2, -0.29, 0xc8a850); }
    },
    chest(b, g, hex) {
      hex = hex || WOOD_F;
      b.box(g, 'wood', 0.9, 0.48, 0.52, 0, 0.24, 0, hex);
      b.box(g, 'wood', 0.94, 0.16, 0.56, 0, 0.56, 0, hex);
      b.cyl(g, 'wood', 0.28, 0.28, 0.94, 10, 0, 0.5, 0, hex, { rz: HPI, ts: 0, tl: PI, open: true });
      for (const s of [-1, 1]) b.box(g, 'metal', 0.05, 0.66, 0.58, s * 0.28, 0.33, 0, 0x4a4a52);
      b.box(g, 'metal', 0.1, 0.12, 0.04, 0, 0.45, -0.28, 0x6a6a72);
    },
    barrel(b, g, r, h, hex) {
      r = r || 0.32; h = h || 0.85; hex = hex || 0x8a5f3a;
      b.lathe(g, 'wood', [[r * 0.82, 0], [r * 0.98, h * 0.2], [r * 1.04, h * 0.5], [r * 0.98, h * 0.8], [r * 0.82, h], [0, h]], 14, 0, 0, 0, hex, { jit: 0.05 });
      for (const y of [h * 0.18, h * 0.82]) b.torus(g, 'wood', r * 0.98, 0.028, 0, y, 0, 0x3a3a3c, { rx: HPI, jit: 0 });
    },
    keg(b, g) {
      b.lathe(g, 'wood', [[0.3, 0], [0.34, 0.2], [0.36, 0.45], [0.34, 0.7], [0.3, 0.9], [0, 0.9]], 14, 0, 0.36, -0.45, 0x7a5232, { rx: HPI, jit: 0.05 });
      b.cyl(g, 'wood', 0.3, 0.3, 0.02, 14, 0, 0.36, -0.45, 0x8a6a45, { rx: HPI });
      for (const z of [-0.65, -0.25]) b.torus(g, 'wood', 0.345, 0.025, 0, 0.36, z, 0x3a3a3c, { jit: 0 });
      for (const s of [-1, 1]) b.box(g, 'wood', 0.7, 0.1, 0.12, 0, 0.05, s * 0.3 - 0.45, WOOD_D);
      b.cyl(g, 'metal', 0.03, 0.03, 0.12, 6, 0, 0.2, -0.95, 0x8a7a50, { rx: HPI });
    },
    rug(b, g, w, d, kind) { b.plane(g, kind === 'elf' ? 'rug_elf' : kind === 'dwarf' ? 'rug_dwarf' : 'rug', w, d, 0, 0.075, 0, 0xffffff, { rx: -HPI, jit: 0 }); },
    hearth(b, g, w, o) {
      o = o || {}; w = w || 1.8;
      const hs = o.hex || STONE_I, H = o.h || 2.6;
      b.box(g, 'stone', w, 1.9, 0.3, 0, 0.95, 0.4, hs, { jit: 0.08 });                     // back
      for (const s of [-1, 1]) b.box(g, 'stone', 0.34, 1.65, 0.62, s * (w / 2 - 0.17), 0.82, 0.12, hs, { jit: 0.08 });
      b.box(g, 'stone', w + 0.2, 0.28, 0.75, 0, 1.78, 0.1, hs, { jit: 0.06 });               // lintel
      b.box(g, 'wood', w + 0.36, 0.07, 0.85, 0, 1.95, 0.05, WOOD_D);                        // mantel
      b.box(g, 'stone', w, H - 1.9, 0.62, 0, 1.9 + (H - 1.9) / 2, 0.15, hs, { jit: 0.06 });   // chimney breast
      b.box(g, 'stone', w + 0.3, 0.06, 1.1, 0, 0.03, -0.2, 0x5f5a54, { jit: 0.05 });          // hearth stone
      b.box(g, 'flat', w - 0.7, 1.5, 0.06, 0, 0.8, 0.22, 0x1a1512, { jit: 0.05 });            // sooty back
      for (const s of [-1, 1]) b.box(g, 'flat', 0.06, 1.5, 0.5, s * (w / 2 - 0.37), 0.8, 0.0, 0x1a1512, { jit: 0.05 });
      b.cyl(g, 'wood', 0.09, 0.1, 0.62, 7, -0.05, 0.12, -0.02, 0x3d2a18, { rz: HPI, ry: 0.4, jit: 0.06 });
      b.cyl(g, 'wood', 0.08, 0.09, 0.6, 7, 0.06, 0.2, 0.04, 0x4a3320, { rz: HPI, ry: -0.5, jit: 0.06 });
      b.cyl(g, 'wood', 0.07, 0.08, 0.5, 7, 0.0, 0.3, 0.0, 0x33241a, { rz: HPI, ry: 1.2, jit: 0.06 });
      for (let i = 0; i < 6; i++) b.sph(g, 'ember', 0.07 + b.rng() * 0.05, (b.rng() - 0.5) * 0.7, 0.06, (b.rng() - 0.5) * 0.35, 0xff7a20, { sy: 0.5, jit: 0.2 });
      b.cyl(g, 'flat', 0.016, 0.016, 0.9, 5, 0, 1.3, 0.1, 0x2a2a2e);                         // hook chain
      b.lathe(g, 'flat', [[0.05, 0], [0.19, 0.04], [0.21, 0.24], [0.17, 0.3]], 10, 0, 0.55, 0.1, 0x2b2b2f, { jit: 0.05 });
      F.candle(b, g, -w / 2 + 0.3, 1.99, 0.05); F.candle(b, g, w / 2 - 0.3, 1.99, 0.05);
      b.lathe(g, 'flat', [[0.03, 0], [0.09, 0.02], [0.1, 0.12], [0.06, 0.22], [0.07, 0.26]], 10, 0, 1.99, 0.0, 0x7b8a97, { jit: 0.04 });
      b.light(0, 0.9, -0.35, { kind: 'fire', color: 0xffa040, intensity: 40, dist: 12, interior: g === 'int' || g === 'upper' });
      b.hearth(0, 0.22, -0.02, o.fxScale || 0.9);
    },
    candle(b, g, x, y, z) {
      b.cyl(g, 'flat', 0.024, 0.026, 0.15, 7, x, y + 0.075, z, 0xf0e8d0, { jit: 0.02 });
      b.cone(g, 'ember', 0.02, 0.07, 6, x, y + 0.18, z, 0xffcc60, { jit: 0.1 });
      b.cyl(g, 'flat', 0.05, 0.05, 0.015, 8, x, y + 0.007, z, 0xb59a4a);
    },
    counter(b, g, len, hex) {
      hex = hex || WOOD_F;
      b.box(g, 'wood', len, 1.0, 0.08, 0, 0.5, -0.38, hex);
      b.box(g, 'wood', len + 0.1, 0.08, 0.86, 0, 1.03, 0, WOOD_D);
      for (const s of [-1, 1]) b.box(g, 'wood', 0.08, 1.0, 0.8, s * (len / 2 - 0.04), 0.5, 0, hex);
      b.box(g, 'wood', len - 0.2, 0.05, 0.6, 0, 0.5, 0.1, WOOD_L);
      const n = Math.max(1, Math.round(len / 0.55));
      for (let i = 0; i <= n; i++) b.box(g, 'wood', 0.06, 0.9, 0.04, -len / 2 + (len / n) * i, 0.5, -0.4, WOOD_D);
    },
    stairs(b, g, n, rise, run, w, o) {
      // a real flight: treads with a nosing + riser boards, two closed stringers, a kick board, newel posts with
      // finials, balusters and a handrail on each open side (o.rails: [-1] left | [1] right | [-1, 1]); one floor
      // collider per tread, cut into ≤ 0.34 m cells so the flight stays walkable at any building yaw
      o = o || {};
      const L = n * run, H = n * rise, hexT = o.hex || WOOD_F, hexR = o.riserHex || 0x5e4128;
      const rails = o.rails || (o.rail ? [o.rail] : [-1]);
      for (let i = 0; i < n; i++) {
        const top = (i + 1) * rise, z0 = i * run;
        b.box(g, 'wood', w, 0.06, run + 0.05, 0, top - 0.03, z0 + run / 2 - 0.025, hexT, { jit: 0.03 });                     // tread (nosing over the riser)
        b.box(g, 'wood', w - 0.04, rise - 0.05, 0.04, 0, top - 0.06 - (rise - 0.05) / 2, z0 + 0.02, hexR, { jit: 0.03 }); // riser board
        b.boxCol(-w / 2, top - Math.min(top, rise * 2.2), z0, w / 2, top, z0 + run, true, 0.34);
      }
      const ang = Math.atan2(H, L), sl = Math.sqrt(L * L + H * H);
      for (const s of [-1, 1]) b.box(g, 'wood', 0.07, 0.42, sl + 0.15, s * (w / 2 + 0.035), H / 2 - 0.12, L / 2, WOOD_D, { rx: -ang, jit: 0.03 });   // closed stringers
      b.box(g, 'wood', w + 0.14, 0.12, 0.08, 0, 0.06, -0.02, WOOD_D, { jit: 0 });                                                              // kick board at the foot
      for (const s of rails) {
        const x = s * (w / 2 + 0.09);
        b.box(g, 'wood', 0.13, 1.08, 0.13, x, 0.54, -0.04, WOOD_D, { jit: 0 }); b.sph(g, 'wood', 0.1, x, 1.14, -0.04, hexT, { jit: 0 });                          // bottom newel + finial
        b.box(g, 'wood', 0.13, H + 1.08, 0.13, x, (H + 1.08) / 2, L + 0.04, WOOD_D, { jit: 0 }); b.sph(g, 'wood', 0.1, x, H + 1.14, L + 0.04, hexT, { jit: 0 });   // top newel + finial
        for (let i = 0; i < n; i++) { const z = (i + 0.5) * run, y = (i + 1) * rise, bh = 0.9 + rise * 0.5; b.box(g, 'wood', 0.04, bh, 0.04, x, y + bh / 2, z, WOOD_D, { jit: 0 }); }   // balusters
        b.box(g, 'wood', 0.08, 0.07, sl + 0.05, x, H / 2 + rise + 0.9, L / 2, hexT, { rx: -ang, jit: 0 });                                        // handrail
      }
    },
    railing(b, g, len, hex, o) {
      // gallery / balcony railing: posts, close-set balusters, handrail + bottom rail and (unless o.col === false)
      // a thin collider so nobody walks off the edge (0.5 m cells keep it tight at any yaw)
      o = o || {}; hex = hex || WOOD_F; const h = o.h || 1.0;
      const np = Math.max(1, Math.round(len / 1.6));
      for (let i = 0; i <= np; i++) b.box(g, 'wood', 0.1, h, 0.1, -len / 2 + (len / np) * i, h / 2, 0, WOOD_D, { jit: 0 });
      const nb = Math.max(1, Math.round(len / 0.22));
      for (let i = 1; i < nb; i++) b.box(g, 'wood', 0.035, h - 0.2, 0.035, -len / 2 + (len / nb) * i, (h - 0.2) / 2 + 0.06, 0, WOOD_D, { jit: 0 });
      b.box(g, 'wood', len + 0.1, 0.07, 0.11, 0, h + 0.035, 0, hex, { jit: 0.02 });
      b.box(g, 'wood', len, 0.05, 0.06, 0, 0.06, 0, hex, { jit: 0.02 });
      if (o.col !== false) b.boxCol(-len / 2 - 0.05, 0, -0.06, len / 2 + 0.05, h + 0.07, 0.06, false, 0.5);
    },
    pillar(b, g, style, h, hex) {
      if (style === 'elf') {
        hex = hex || 0xf2f3f6;
        b.cyl(g, 'plaster', 0.3, 0.36, h - 0.6, 12, 0, (h - 0.6) / 2 + 0.3, 0, hex, { jit: 0.02, faceJit: false });
        b.cyl(g, 'plaster', 0.44, 0.34, 0.3, 12, 0, 0.15, 0, hex, { jit: 0.02 });
        b.cyl(g, 'plaster', 0.5, 0.3, 0.32, 12, 0, h - 0.16, 0, hex, { jit: 0.02 });
        b.torus(g, 'metal', 0.36, 0.035, 0, h - 0.34, 0, 0xd8c070, { rx: HPI, jit: 0 });
      } else if (style === 'dwarf') {
        hex = hex || 0x5e5a5e;
        b.box(g, 'stone', 1.0, h - 1.2, 1.0, 0, (h - 1.2) / 2 + 0.6, 0, hex, { jit: 0.05 });
        b.box(g, 'stone', 1.3, 0.6, 1.3, 0, 0.3, 0, hex, { jit: 0.05 });
        b.box(g, 'stone', 1.4, 0.35, 1.4, 0, h - 0.17, 0, hex, { jit: 0.05 });
        b.box(g, 'stone', 1.2, 0.3, 1.2, 0, h - 0.5, 0, hex, { jit: 0.05 });
        b.box(g, 'metal', 0.6, 0.6, 0.06, 0, h * 0.55, -0.52, 0xb08040, { ry: 0, rz: PI / 4, jit: 0.05 });
      } else {
        hex = hex || WOOD_F;
        b.box(g, 'wood', 0.28, h, 0.28, 0, h / 2, 0, hex, { jit: 0.04 });
        b.box(g, 'wood', 0.5, 0.2, 0.5, 0, h - 0.1, 0, WOOD_D);
      }
    },
    brazier(b, g, scale) {
      scale = scale || 1;
      b.lathe(g, 'metal', [[0.1, 0], [0.4, 0.06], [0.44, 0.35], [0.36, 0.5], [0.3, 0.52]], 12, 0, 0.55 * scale, 0, 0x3a3a40, { sx: scale, sy: scale, sz: scale, jit: 0.05 });
      for (let i = 0; i < 3; i++) { const a = i * TAU / 3; b.cyl(g, 'metal', 0.03, 0.04, 0.6 * scale, 6, Math.sin(a) * 0.22 * scale, 0.3 * scale, Math.cos(a) * 0.22 * scale, 0x3a3a40, { rz: Math.cos(a) * 0.18, rx: -Math.sin(a) * 0.18 }); }
      for (let i = 0; i < 5; i++) b.sph(g, 'ember', 0.09 * scale, (b.rng() - 0.5) * 0.4 * scale, 0.95 * scale, (b.rng() - 0.5) * 0.4 * scale, 0xff7a20, { sy: 0.6, jit: 0.2 });
      b.light(0, 1.4 * scale, 0, { kind: 'fire', color: 0xffa040, intensity: 30 * scale, dist: 10 * scale, interior: g === 'int' });
      b.hearth(0, 0.95 * scale, 0, 0.55 * scale);
    },
    lantern(b, g, x, y, z, o) {
      o = o || {};
      const glow = o.elf ? 'elfglow' : 'lampglow', hexF = o.elf ? 0xd8dce6 : 0x26262a, fm = o.elf ? 'metal' : 'wood';
      const s = o.scale || 1;
      b.box(g, fm, 0.26 * s, 0.05, 0.26 * s, x, y + 0.02, z, hexF, { jit: 0 });
      b.box(g, fm, 0.24 * s, 0.05, 0.24 * s, x, y + 0.36 * s, z, hexF, { jit: 0 });
      b.cone(g, fm, 0.18 * s, 0.12 * s, 4, x, y + 0.44 * s, z, hexF, { ry: PI / 4, jit: 0 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(g, fm, 0.025, 0.34 * s, 0.025, x + sx * 0.11 * s, y + 0.19 * s, z + sz * 0.11 * s, hexF, { jit: 0 });
      b.box(g, glow, 0.17 * s, 0.28 * s, 0.17 * s, x, y + 0.19 * s, z, 0xffffff, { jit: 0 });
      if (o.chain) b.cyl(g, fm, 0.015, 0.015, o.chain, 5, x, y + 0.5 * s + o.chain / 2, z, hexF, { jit: 0 });
      if (o.hook) b.torus(g, fm, 0.05, 0.012, x, y + 0.53 * s, z, hexF, { jit: 0 });
      b.light(x, y + 0.2 * s, z, { kind: o.elf ? 'elf' : 'lamp', color: o.elf ? 0xbfd8ff : 0xffc070, intensity: o.intensity || 22, dist: o.dist || 11, flicker: !o.elf, interior: g === 'int' || g === 'upper' });
    },
    anvil(b, g) {
      b.cyl(g, 'wood', 0.3, 0.34, 0.55, 9, 0, 0.27, 0, 0x4a3420, { jit: 0.05 });
      b.box(g, 'metal', 0.36, 0.14, 0.26, 0, 0.62, 0, 0x4a4b52);
      b.box(g, 'metal', 0.44, 0.16, 0.3, 0, 0.77, 0, 0x55565e);
      b.cone(g, 'metal', 0.13, 0.4, 8, 0.4, 0.78, 0, 0x55565e, { rz: -HPI });
      b.box(g, 'metal', 0.16, 0.12, 0.22, -0.3, 0.77, 0, 0x55565e);
    },
    forge(b, g) {
      b.box(g, 'stone', 2.2, 1.0, 1.4, 0, 0.5, 0.2, 0x5c5658, { jit: 0.07 });
      b.box(g, 'stone', 2.4, 0.12, 1.6, 0, 1.06, 0.2, 0x4a4648, { jit: 0.05 });
      b.box(g, 'flat', 1.4, 0.1, 0.9, 0, 1.12, 0.05, 0x1a1210, { jit: 0.1 });
      for (let i = 0; i < 9; i++) b.sph(g, 'ember', 0.1 + b.rng() * 0.05, (b.rng() - 0.5) * 1.1, 1.18, (b.rng() - 0.5) * 0.6, 0xff8020, { sy: 0.6, jit: 0.2 });
      b.box(g, 'stone', 2.2, 0.5, 1.4, 0, 2.4, 0.2, 0x5c5658, { jit: 0.06 });
      for (const s of [-1, 1]) b.box(g, 'stone', 0.3, 1.3, 1.3, s * 0.95, 1.75, 0.25, 0x5c5658, { jit: 0.06 });
      b.box(g, 'stone', 2.2, 1.3, 0.3, 0, 1.75, 0.85, 0x5c5658, { jit: 0.06 });
      b.box(g, 'stone', 1.2, 4.0, 1.2, 0, 4.6, 0.3, 0x55505a, { jit: 0.06 });
      b.box(g, 'wood', 0.5, 0.2, 0.9, 1.5, 1.05, 0.3, WOOD_F, { ry: 0.3 });
      b.box(g, 'flat', 0.44, 0.1, 0.6, 1.5, 1.18, 0.3, 0x5a3a2a, { ry: 0.3 });
      b.light(0, 1.6, -0.3, { kind: 'fire', color: 0xffa040, intensity: 45, dist: 13, interior: g === 'int' });
      b.hearth(0, 1.2, 0.05, 0.75);
    },
    fountain(b, g, r) {
      r = r || 1.8;
      b.lathe(g, 'stone', [[r * 0.75, 0], [r * 1.02, 0.02], [r * 1.05, 0.5], [r * 0.98, 0.62], [r * 0.88, 0.62], [r * 0.9, 0.16], [r * 0.4, 0.14], [0.2, 0.14]], 20, 0, 0, 0, 0xe4e6ea, { jit: 0.02 });
      b.cyl(g, 'water', r * 0.89, r * 0.89, 0.02, 20, 0, 0.5, 0, 0x4d8cc0, { jit: 0.02 });
      b.lathe(g, 'stone', [[0.16, 0.1], [0.14, 1.0], [0.22, 1.1], [0.55, 1.15], [0.6, 1.28], [0.5, 1.3], [0.12, 1.32], [0.1, 1.34], [0.08, 1.7], [0.14, 1.72], [0.16, 1.9], [0.1, 1.98], [0, 2.0]], 14, 0, 0, 0, 0xe4e6ea, { jit: 0.02 });
      b.cyl(g, 'water', 0.49, 0.49, 0.02, 14, 0, 1.24, 0, 0x5b9bd0, { jit: 0.02 });
      b.light(0, 2.2, 0, { kind: 'elf', color: 0xbfd8ff, intensity: 18, dist: 12, flicker: false, interior: g === 'int' });
    },
    bedroll(b, g, hex) {
      hex = hex || 0x6a5a4a;
      b.box(g, 'cloth', 0.8, 0.14, 1.9, 0, 0.07, 0, hex, { jit: 0.05 });
      b.cyl(g, 'cloth', 0.13, 0.13, 0.7, 8, 0, 0.16, 0.75, 0xa89880, { rz: HPI, jit: 0.04 });
      b.box(g, 'cloth', 0.6, 0.06, 1.0, 0, 0.16, -0.2, [0x8c3a32, 0x3e6a44, 0x3a5a8c][Math.floor(b.rng() * 3)], { jit: 0.05 });
    },
    coffin(b, g) {
      b.box(g, 'stone', 1.5, 0.5, 2.8, 0, 0.25, 0, 0x6f6a64, { jit: 0.06 });
      b.box(g, 'stone', 1.0, 0.7, 2.3, 0, 0.85, 0, 0x7e7871, { jit: 0.05 });
      b.box(g, 'stone', 1.08, 0.14, 2.4, 0, 1.27, 0, 0x8a847c, { jit: 0.05 });
      b.box(g, 'stone', 0.14, 0.06, 1.5, 0, 1.37, 0.1, 0x9a948c);
      b.box(g, 'stone', 0.5, 0.06, 0.14, 0, 1.37, 0.6, 0x9a948c);
    },
    crate(b, g, s, hex) {
      s = s || 0.8; hex = hex || 0x9a7048;
      b.box(g, 'wood', s, s, s, 0, s / 2, 0, hex, { jit: 0.05 });
      for (const k of [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        if (k[1]) continue;
        const cx = k[0] * s / 2, cz = k[2] * s / 2;
        b.box(g, 'wood', k[0] ? 0.04 : s + 0.02, 0.09, k[2] ? 0.04 : s + 0.02, cx, s * 0.5, cz, WOOD_D);
        b.box(g, 'wood', k[0] ? 0.04 : 0.09, s, k[2] ? 0.04 : 0.09, cx + (k[2] ? s * 0.42 : 0), s / 2, cz + (k[0] ? s * 0.42 : 0), WOOD_D);
        b.box(g, 'wood', k[0] ? 0.04 : 0.09, s, k[2] ? 0.04 : 0.09, cx - (k[2] ? s * 0.42 : 0), s / 2, cz - (k[0] ? s * 0.42 : 0), WOOD_D);
      }
    },
    sack(b, g, hex) { hex = hex || 0xc4ac7c; b.sph(g, 'cloth', 0.36, 0, 0.3, 0, hex, { sy: 0.85, jit: 0.05 }); b.cyl(g, 'cloth', 0.12, 0.2, 0.2, 8, 0, 0.62, 0, hex, { jit: 0.05 }); },
    hayBale(b, g) { b.box(g, 'thatch', 1.1, 0.6, 0.65, 0, 0.3, 0, 0xc9a85a, { jit: 0.05 }); for (const x of [-0.3, 0.3]) b.box(g, 'wood', 0.03, 0.63, 0.68, x, 0.3, 0, 0x6a5030); },
    hayPile(b, g, r) { r = r || 1.2; b.sph(g, 'thatch', r, 0, 0, 0, 0xcdaa5c, { sy: 0.45, jit: 0.06 }); },
    trough(b, g) { b.box(g, 'wood', 1.6, 0.45, 0.55, 0, 0.22, 0, WOOD_F); b.box(g, 'water', 1.5, 0.05, 0.45, 0, 0.4, 0, 0x4a7a9a, { jit: 0.03 }); },
    banner(b, g, w, h, hex, hex2) {
      b.plane(g, 'cloth', w, h, 0, -h / 2, 0, hex, { jit: 0.03 });
      b.plane(g, 'cloth', w * 0.6, h * 0.5, 0, -h * 0.45, 0.005, hex2 || 0xd8c060, { jit: 0.02 });
      b.cyl(g, 'wood', 0.03, 0.03, w + 0.2, 6, 0, 0, 0, WOOD_D, { rz: HPI });
    },
  };

  /* ------------------------------------------------------------------------------------------------ */
  /* small shared builders used by several recipes                                                     */
  /* ------------------------------------------------------------------------------------------------ */
  function figure(b, g, s, hex, pose) {
    // stylised standing figure (statue), feet at y=0, facing -z; s = scale (1 ≈ 1.9 m tall)
    hex = hex || 0x9a968e; pose = pose || 'warrior';
    const m = 'stone';
    for (const sx of [-1, 1]) b.cyl(g, m, 0.11 * s, 0.13 * s, 0.9 * s, 8, sx * 0.14 * s, 0.45 * s, 0, hex, { jit: 0.03 });
    b.box(g, m, 0.5 * s, 0.3 * s, 0.32 * s, 0, 1.0 * s, 0, hex, { jit: 0.03 });
    b.box(g, m, 0.56 * s, 0.6 * s, 0.34 * s, 0, 1.42 * s, 0, hex, { jit: 0.03 });
    b.box(g, m, 0.7 * s, 0.14 * s, 0.36 * s, 0, 1.72 * s, 0, hex, { jit: 0.03 });
    b.sph(g, m, 0.17 * s, 0, 1.95 * s, 0, hex, { jit: 0.03 });
    if (pose === 'warrior') {
      b.cyl(g, m, 0.08 * s, 0.09 * s, 0.7 * s, 7, -0.4 * s, 1.35 * s, 0, hex, { jit: 0.03 });
      b.cyl(g, m, 0.08 * s, 0.09 * s, 0.7 * s, 7, 0.4 * s, 1.25 * s, -0.25 * s, hex, { rx: -0.9, jit: 0.03 });
      b.box(g, m, 0.07 * s, 1.3 * s, 0.03 * s, 0.4 * s, 1.15 * s, -0.52 * s, 0xaaa6a0, { jit: 0.02 });
      b.box(g, m, 0.3 * s, 0.05 * s, 0.05 * s, 0.4 * s, 1.55 * s, -0.52 * s, 0xaaa6a0);
      b.box(g, m, 0.5 * s, 0.7 * s, 0.05 * s, -0.4 * s, 1.1 * s, 0.05 * s, hex, { jit: 0.03 });
      b.cyl(g, m, 0.19 * s, 0.2 * s, 0.14 * s, 8, 0, 2.0 * s, 0, hex, { jit: 0.03 });
    } else if (pose === 'robed') {
      b.cone(g, m, 0.45 * s, 1.2 * s, 10, 0, 0.6 * s, 0, hex, { jit: 0.03 });
      b.cyl(g, m, 0.08 * s, 0.09 * s, 0.7 * s, 7, -0.38 * s, 1.35 * s, 0, hex, { jit: 0.03 });
      b.cyl(g, m, 0.08 * s, 0.09 * s, 0.7 * s, 7, 0.42 * s, 1.4 * s, -0.1 * s, hex, { rx: -0.5, jit: 0.03 });
      b.cyl(g, m, 0.035 * s, 0.035 * s, 2.2 * s, 6, 0.46 * s, 1.1 * s, -0.3 * s, hex, { jit: 0.02 });
      b.sph(g, m, 0.12 * s, 0.46 * s, 2.25 * s, -0.3 * s, 0xc8ccd8, { jit: 0.02 });
      b.sph(g, m, 0.2 * s, 0, 2.02 * s, 0.05 * s, hex, { sy: 0.8, jit: 0.03 });
    }
    b.box(g, m, 0.62 * s, 1.5 * s, 0.1 * s, 0, 1.05 * s, 0.22 * s, hex, { jit: 0.03 });   // cloak
  }
  function menhir(b, g, h, hex) {
    hex = hex || 0x7d7873;
    b.lathe(g, 'rock', [[0, 0], [0.6, 0], [0.62, h * 0.3], [0.5, h * 0.7], [0.32, h * 0.95], [0.15, h]], 7, 0, -0.3, 0, hex, { jit: 0.08, faceJit: true });
  }
  function stoneBench(b, g, len, hex) {
    hex = hex || 0xd9dbe0;
    b.box(g, 'stone', len, 0.1, 0.5, 0, 0.45, 0, hex, { jit: 0.02 });
    for (const s of [-1, 1]) b.box(g, 'stone', 0.22, 0.4, 0.42, s * (len / 2 - 0.25), 0.2, 0, hex, { jit: 0.02 });
  }
  function woodLog(b, g, len, r, hex, o) { b.cyl(g, 'wood', r, r * 1.05, len, 9, 0, r, 0, hex || 0x5e4128, Object.assign({ rz: HPI, jit: 0.06 }, o || {})); }

  /* ------------------------------------------------------------------------------------------------ */
  /* RECIPES                                                                                             */
  /* ------------------------------------------------------------------------------------------------ */
  const RECIPES = {};
  function def(name, r) { RECIPES[name] = Object.assign({ name, variants: 3, enterable: false, static: false }, r); }

  const PLASTERS = [0xe8dcc2, 0xdac8a2, 0xf1ece2];
  const THATCHES = [0x9c7f47, 0x8f7640, 0xa98c50];
  const TILES = [0x9a5a44, 0x66707e, 0xa06a4e];

  /* ---------------- hobbit_hole ---------------- */
  def('hobbit_hole', {
    variants: 4, enterable: true,
    build(b, v) {
      const doorHex = [0x3f7a3a, 0xc9a53a, 0x3b5c9a, 0x9a3b30][v];
      const zf = -2.4, RX = 7.6, RY = 4.7, RZ = 6.6, MZ = 1.0, MY = -0.35;
      // mound (front flattened into the facade plane)
      const mg = domeGeo(1, 44, 22); mg.scale(RX, RY, RZ);
      const mp = mg.attributes.position, mn = mg.attributes.normal, zc = zf - MZ + 0.12;
      const flat = new Uint8Array(mp.count);
      for (let i = 0; i < mp.count; i++) if (mp.getZ(i) < zc) { mp.setZ(i, zc); mn.setXYZ(i, 0, 0, -1); flat[i] = (Math.abs(mp.getX(i)) < 1.45 && mp.getY(i) < 2.95) ? 2 : 1; }
      const idx = mg.index.array, keep = [];   // drop flat-face triangles behind the door so the passage is open
      for (let i = 0; i < idx.length; i += 3) { const a = idx[i], b2 = idx[i + 1], c = idx[i + 2]; if (flat[a] && flat[b2] && flat[c] && (flat[a] === 2 || flat[b2] === 2 || flat[c] === 2)) continue; keep.push(a, b2, c); }
      mg.setIndex(keep);
      b.piece('roof', 'grass', mg, 0, MY, MZ, 0x6f9a48, { jit: 0.06, faceJit: false });
      b.cyl('roof', 'grass', RX * 1.03, RX * 1.06, 1.2, 32, 0, -0.68, MZ, 0x6b9446, { sz: RZ / RX, jit: 0.05 });  // skirt hides slope gaps; its top stays BELOW the interior floor (0.05) or it z-fights through it whenever the mound is still drawn
      // facade: half-ellipse brick wall with round door & windows
      const a = 5.0, by = 3.9;
      const sh = new T.Shape(); sh.moveTo(-a, -1); sh.lineTo(a, -1); sh.lineTo(a, MY + 0.01); sh.absellipse(0, MY, a, by, 0, PI, false); sh.lineTo(-a, -1);
      const dr = 0.95;
      const hole = new T.Path(); hole.absarc(0, dr + 0.05, dr, 0, TAU, false); sh.holes.push(hole);
      for (const sx of [-1, 1]) { const p = new T.Path(); p.absarc(sx * 2.75, 1.55, 0.5, 0, TAU, false); sh.holes.push(p); }
      const fg = new T.ExtrudeGeometry(sh, { depth: 0.5, bevelEnabled: false, curveSegments: 14 }); fg.translate(0, 0, -0.25);
      b.piece('ext', 'brick', fg, 0, 0, zf, 0xb87a5a, { jit: 0.03, faceJit: false });
      b.torus('ext', 'brick', dr + 0.12, 0.14, 0, dr + 0.05, zf - 0.28, 0xa8694a, { jit: 0.08 });
      for (const sx of [-1, 1]) {
        b.torus('ext', 'brick', 0.6, 0.1, sx * 2.75, 1.55, zf - 0.27, 0xa8694a, { jit: 0.08 });
        b.cyl('ext', 'glass', 0.48, 0.48, 0.06, 16, sx * 2.75, 1.55, zf, 0xffffff, { rx: HPI });
        b.box('ext', 'wood', 0.05, 0.96, 0.1, sx * 2.75, 1.55, zf - 0.05, 0x4a3220); b.box('ext', 'wood', 0.96, 0.05, 0.1, sx * 2.75, 1.55, zf - 0.05, 0x4a3220);
        b.box('ext', 'brick', 1.3, 0.12, 0.5, sx * 2.75, 0.95, zf - 0.2, 0x9a6a4c, { jit: 0.05 });   // window box / sill
        b.box('ext', 'brick', 1.1, 0.16, 0.36, sx * 2.75, 1.06, zf - 0.22, [0x5a8a3a, 0x7a9a44][v % 2], { jit: 0.1 });
        for (let i = 0; i < 5; i++) b.sph('ext', 'brick', 0.07, sx * 2.75 - 0.45 + i * 0.22, 1.18, zf - 0.22 + (i % 2) * 0.08, [0xe25a5a, 0xf0d040, 0xf39ac0, 0xffffff][i % 4], { jit: 0.1 });
      }
      b.box('ext', 'stone', 2.4, 0.12, 1.2, 0, 0.0, zf - 0.75, 0x8d8579, { jit: 0.06 });
      for (let i = 0; i < 5; i++) b.cyl('ext', 'stone', 0.34, 0.34, 0.06, 7, (i % 2 ? 0.25 : -0.2), 0.03, zf - 1.7 - i * 0.62, 0x8a847a, { jit: 0.08 });
      // bench + lantern outside
      b.at(3.9, zf - 0.85, 0); F.bench(b, 'ext', 1.4); b.end();
      b.cyl('ext', 'wood', 0.06, 0.07, 2.2, 6, -1.7, 1.1, zf - 0.9, 0x4a3220);
      F.lantern(b, 'ext', -1.7, 2.05, zf - 0.9, { scale: 0.8, intensity: 16 });
      b.at(-3.9, zf - 0.6, 0); F.barrel(b, 'ext', 0.28, 0.7); b.end();
      // chimney pot on the mound
      b.cyl('ext', 'brick', 0.34, 0.4, 1.5, 10, 2.4, 4.2, MZ + 0.6, 0xa06a4c, { jit: 0.06 });
      b.cyl('ext', 'stone', 0.44, 0.44, 0.16, 10, 2.4, 4.98, MZ + 0.6, 0x7d766b);
      b.cyl('ext', 'stone', 0.24, 0.24, 0.06, 10, 2.4, 5.05, MZ + 0.6, 0x151210, { jit: 0 });
      b.smoke(2.4, 5.15, MZ + 0.6);
      // door
      b.door({ x: 0, z: zf, ry: 0, w: dr * 2, h: dr * 2, kind: 'round', hinge: -1, hex: doorHex, y: 0.05, t: 0.5, name: 'Round door' });
      // ---- interior: round hall
      const CZ = 1.8, R = 3.6, H = 2.5, gap = Math.asin(1.0 / R);
      b.cyl('int', 'planks', R + 0.1, R + 0.1, 0.12, 28, 0, -0.01, CZ, 0x9a6f48, { jit: 0.04 });
      b.boxCol(-R, -0.13, CZ - R, R, 0.05, CZ + R, true);
      b.box('int', 'planks', 1.9, 0.12, 1.4, 0, -0.01, zf + 0.45, 0x9a6f48, { jit: 0.04 }); b.boxCol(-0.95, -0.13, zf - 0.3, 0.95, 0.05, zf + 1.2, true);
      const wall = invertGeo(new T.CylinderGeometry(R, R, H, 28, 1, true, PI + gap, TAU - 2 * gap));
      b.piece('int', 'wood', wall, 0, H / 2, CZ, 0xb08a58, { jit: 0.03, faceJit: false });
      b.torus('int', 'wood', R - 0.03, 0.045, 0, 1.0, CZ, 0x5a3c25, { rx: HPI, jit: 0 });
      b.torus('int', 'wood', R - 0.03, 0.05, 0, 0.12, CZ, 0x5a3c25, { rx: HPI, jit: 0 });
      // passage
      for (const sx of [-1, 1]) b.box('int', 'brick', 0.24, H, 1.4, sx * 1.07, H / 2, zf + 0.45, 0xb87a5a, { jit: 0.04 });
      b.box('int', 'brick', 2.4, 0.3, 1.4, 0, H + 0.1, zf + 0.45, 0xb87a5a, { jit: 0.04 });
      for (const sx of [-1, 1]) b.wallCol(sx * 0.95, zf - 0.3, sx * 0.95, zf + 1.3, H, 0.24);
      // dome ceiling + beam ring: interior, never hidden (the grass mound above is the 'roof' group) + ceiling colliders
      const ceil = invertGeo(domeGeo(R + 0.05, 28, 10)); ceil.scale(1, 0.38, 1);
      b.piece('int', 'wood', ceil, 0, H - 0.02, CZ, 0xe2cfa8, { jit: 0.02, faceJit: false });
      b.torus('int', 'wood', R - 0.05, 0.09, 0, H - 0.05, CZ, 0x5a3c25, { rx: HPI, jit: 0 });
      for (let i = 0; i < 6; i++) { const an = i * PI / 6; b.box('int', 'wood', R * 1.9, 0.1, 0.12, 0, H + 0.02, CZ, 0x5a3c25, { ry: an }); }
      b.boxCol(-R, H, CZ - R, R, H + 0.1, CZ + R, false, 4);
      b.boxCol(-1.0, H - 0.05, zf - 0.3, 1.0, H + 0.2, zf + 1.3, false, 2);
      // furniture
      b.at(-R + 0.55, CZ - 0.3, -HPI); F.hearth(b, 'int', 1.5, { h: H, fxScale: 0.7 }); b.end();
      b.at(0.9, CZ - 0.1, 0.35); F.table(b, 'int', 1.3, 0.9); b.at(0, -0.75, 0); F.chair(b, 'int'); b.end(); b.at(0.2, 0.75, PI); F.chair(b, 'int'); b.end(); b.end();
      F.candle(b, 'int', 0.9, 0.81, CZ - 0.1);
      b.lathe('int', 'flat', [[0.02, 0], [0.07, 0.02], [0.08, 0.1], [0.05, 0.18], [0.05, 0.22], [0.06, 0.24]], 10, 0.6, 0.81, CZ + 0.2, 0xb8865a, { jit: 0.04 });
      b.cyl('int', 'flat', 0.12, 0.12, 0.015, 12, 1.25, 0.81, CZ - 0.3, 0xece4d2, { jit: 0.02 });
      b.sph('int', 'flat', 0.1, 1.25, 0.88, CZ - 0.3, 0xc89a5a, { sy: 0.6, sz: 1.5, jit: 0.05 });
      b.at(0.5, CZ + 2.5, 0); F.bed(b, 'int', 1.0, 1.9, BLANKETS[v]); b.end();
      b.at(-1.0, CZ + 2.9, 0); F.chest(b, 'int'); b.end();
      b.at(R - 0.45, CZ - 0.9, HPI); F.shelf(b, 'int', 1.6, 'crockery', 1.9); b.end();
      b.at(2.55, CZ + 1.7, 2.2); F.cupboard(b, 'int', 1.0, 1.7); b.end();
      b.at(-2.4, CZ + 1.7, 0); F.barrel(b, 'int', 0.3, 0.8); b.end();
      b.at(-1.75, CZ + 2.3, 0); F.barrel(b, 'int', 0.26, 0.7); b.end();
      b.at(-2.6, CZ + 0.9, 0); F.sack(b, 'int'); b.end();
      b.at(-1.4, CZ + 2.9, 0); F.sack(b, 'int', 0xb8a070); b.end();
      b.at(-1.9, CZ - 0.9, 0); F.stool(b, 'int'); b.end();
      b.at(0.3, CZ - 0.2, 0); F.rug(b, 'int', 2.4, 1.7, 'man'); b.end();
      for (let i = 0; i < 3; i++) b.cyl('int', 'flat', 0.06, 0.06, 0.5, 6, -1.4 + i * 0.25, H - 0.35, CZ + 3.1, 0x6a7a3a, { rx: 0.2, jit: 0.1 });   // hanging herbs
      b.light(0.9, 1.8, CZ, { kind: 'lamp', color: 0xffc070, intensity: 10, dist: 8, flicker: true, interior: true });
      b.spot(-1.6, CZ - 0.3, HPI, 'fire'); b.spot(0.9, CZ - 0.95, PI, 'table'); b.spot(0.5, CZ + 1.3, PI, 'bed');
      b.interior(-R, -0.5, zf - 0.4, R, H + 1.0, CZ + R);
      b.ringCol(0, CZ, R, H, 16, 0, 2.0);
      for (let i = 0; i < 18; i++) {   // mound perimeter (skips the facade side)
        const a0 = i / 18 * TAU, a1 = (i + 1) / 18 * TAU;
        const p0 = { x: Math.sin(a0) * RX * 0.97, z: MZ + Math.cos(a0) * RZ * 0.97 }, p1 = { x: Math.sin(a1) * RX * 0.97, z: MZ + Math.cos(a1) * RZ * 0.97 };
        if (p0.z < zf + 0.3 || p1.z < zf + 0.3) continue;
        b.wallCol(p0.x, p0.z, p1.x, p1.z, 2.5, 0.4);
      }
      b.wallCol(-a, zf, -1.0, zf, 3.5, 0.5); b.wallCol(1.0, zf, a, zf, 3.5, 0.5);
    },
  });

  /* ---------------- man_house (thatch cottage) ---------------- */
  def('man_house', {
    enterable: true,
    build(b, v) {
      const W = 7.2, D = 5.6, H = 3.1, peak = 5.5;
      shell(b, {
        W, D, h: H, peak, t: 0.35, wallMat: 'plaster', wallHex: PLASTERS[v], timber: true, baseH: 0.85,
        roofMat: 'thatch', roofHex: THATCHES[v], capHex: 0x8a6a36, overhang: 0.6, roofTh: 0.45, shutters: v === 1,
        chimney: { side: 'r', u: 0.4 },
        holes: [
          { side: 'f', u: -1.7, y: 0, w: 1.35, h: 2.2, door: true, hinge: -1 },   // ≥ 1.3 m: Player.autoMove probes a 0.55 m radius, so a 1.1 m door was too narrow to thread
          { side: 'f', u: 1.5, y: 1.1, w: 1.0, h: 1.0 },
          { side: 'b', u: -1.4, y: 1.1, w: 0.9, h: 0.9 }, { side: 'b', u: 1.6, y: 1.1, w: 0.9, h: 0.9 },
          { side: 'l', u: 0.8, y: 1.1, w: 0.9, h: 0.9 },
        ],
      });
      // interior
      b.at(W / 2 - 0.175 - 0.45, 0.4, -HPI); F.hearth(b, 'int', 1.7, { h: H }); b.end();
      b.at(-0.5, 0.6, 0); F.table(b, 'int', 1.8, 0.9); b.end();
      b.at(-0.5, -0.05, 0); F.bench(b, 'int', 1.6); b.end();
      b.at(-0.5, 1.25, PI); F.bench(b, 'int', 1.6); b.end();
      F.candle(b, 'int', -0.9, 0.81, 0.6);
      b.cyl('int', 'flat', 0.13, 0.13, 0.015, 12, 0.0, 0.81, 0.5, 0xece4d2, { jit: 0.02 });
      b.sph('int', 'flat', 0.11, 0.0, 0.88, 0.5, 0xc89a5a, { sy: 0.6, sz: 1.5, jit: 0.05 });
      b.lathe('int', 'flat', [[0.02, 0], [0.07, 0.02], [0.08, 0.1], [0.05, 0.18], [0.05, 0.22], [0.06, 0.24]], 10, 0.1, 0.81, 0.85, 0xb8865a, { jit: 0.04 });
      b.at(-W / 2 + 0.75, 1.5, 0); F.bed(b, 'int', 1.05, 2.0, BLANKETS[v]); b.end();
      b.at(-W / 2 + 0.75, 0.05, 0); F.chest(b, 'int'); b.end();
      b.at(1.6, D / 2 - 0.5, 0); F.cupboard(b, 'int', 1.1, 1.85); b.end();
      b.at(-0.6, D / 2 - 0.4, 0); F.shelf(b, 'int', 1.6, 'crockery', 1.9); b.end();
      b.at(1.9, -0.9, 0); F.stool(b, 'int'); b.end();
      b.at(-0.5, 0.2, 0); F.rug(b, 'int', 2.6, 2.0, 'man'); b.end();
      b.at(2.6, -D / 2 + 0.6, 0); F.barrel(b, 'int', 0.28, 0.75); b.end();
      b.at(W / 2 - 0.7, D / 2 - 0.7, 0); F.sack(b, 'int'); b.end();
      F.lantern(b, 'int', -2.9, 1.8, -D / 2 + 0.3, { scale: 0.8, intensity: 12, hook: true });
      b.spot(1.3, 0.4, -HPI, 'fire'); b.spot(-0.5, -0.5, PI, 'table'); b.spot(-W / 2 + 1.6, 1.5, HPI, 'bed');
    },
  });

  /* ---------------- man_house_2 (tiled, gable to the street, porch) ---------------- */
  def('man_house_2', {
    enterable: true,
    build(b, v) {
      const W = 6.4, D = 7.6, H = 3.5, peak = 6.2;
      shell(b, {
        W, D, h: H, peak, ridge: 'z', t: 0.35, wallMat: 'plaster', wallHex: [0xf1ece2, 0xe4d2ae, 0xdcd4c4][v], timber: true, baseH: 1.0,
        roofMat: 'tile', roofHex: TILES[v], capHex: 0x4a3a34, overhang: 0.5, roofTh: 0.3, shutters: v !== 1,
        chimney: { side: 'l', u: 1.2 },
        holes: [
          { side: 'f', u: 1.1, y: 0, w: 1.35, h: 2.3, door: true, hinge: 1, arch: true },
          { side: 'f', u: -1.5, y: 1.1, w: 1.1, h: 1.1 },
          { side: 'f', u: 0, y: 4.0, w: 0.8, h: 0.9 },
          { side: 'r', u: -2.0, y: 1.1, w: 0.9, h: 1.0 }, { side: 'r', u: 1.8, y: 1.1, w: 0.9, h: 1.0 },
          { side: 'b', u: 1.2, y: 1.1, w: 0.9, h: 1.0 },
        ],
      });
      // porch canopy over the door
      b.at(1.1, -D / 2, 0);
      for (const sx of [-1, 1]) b.box('ext', 'wood', 0.16, 2.6, 0.16, sx * 1.0, 1.3, -1.3, 0x4a3220);
      b.piece('ext', 'tile', chevronRoofGeo(2.6, 2.6, 3.3, 0.16, 1.7), 0, 0, -0.85, TILES[v], { jit: 0.04, faceJit: false });
      b.box('ext', 'wood', 2.3, 0.12, 0.12, 0, 2.55, -1.3, 0x4a3220);
      b.end();
      // interior
      b.at(-W / 2 + 0.175 + 0.45, 1.2, HPI); F.hearth(b, 'int', 1.6, { h: H }); b.end();
      b.at(0.6, 0.2, 0); F.table(b, 'int', 1.5, 0.9); b.end();
      b.at(0.6, -0.55, 0); F.chair(b, 'int'); b.end(); b.at(0.6, 0.95, PI); F.chair(b, 'int'); b.end();
      F.candle(b, 'int', 0.3, 0.81, 0.2);
      b.at(W / 2 - 0.75, D / 2 - 1.3, 0); F.bed(b, 'int', 1.1, 2.1, BLANKETS[(v + 2) % 5]); b.end();
      b.at(W / 2 - 0.75, D / 2 - 2.95, 0); F.chest(b, 'int'); b.end();
      b.at(-1.3, D / 2 - 0.42, 0); F.shelf(b, 'int', 1.5, 'books', 2.0); b.end();
      b.at(0.9, D / 2 - 0.45, 0); F.cupboard(b, 'int', 1.0, 1.8); b.end();
      // spinning wheel (charm)
      b.at(-2.0, -1.8, 0.6);
      b.torus('int', 'wood', 0.42, 0.03, 0, 0.75, 0, WOOD_D, { jit: 0 });
      for (let i = 0; i < 6; i++) b.box('int', 'wood', 0.02, 0.8, 0.02, 0, 0.75, 0, WOOD_D, { rz: i * PI / 6 });
      b.box('int', 'wood', 0.9, 0.06, 0.35, 0, 0.36, 0.15, WOOD_F); b.box('int', 'wood', 0.06, 0.4, 0.06, 0, 0.55, 0.02, WOOD_F);
      for (const sx of [-1, 1]) b.box('int', 'wood', 0.06, 0.36, 0.06, sx * 0.3, 0.18, 0.15, WOOD_D, { rz: sx * 0.2 });
      b.end();
      b.at(0.5, 0.4, 0); F.rug(b, 'int', 2.4, 2.2, 'man'); b.end();
      b.at(-2.4, D / 2 - 0.7, 0); F.barrel(b, 'int', 0.28, 0.7); b.end();
      F.lantern(b, 'int', 2.4, 1.9, -D / 2 + 0.3, { scale: 0.8, intensity: 12, hook: true });
      b.spot(-1.2, 1.2, HPI, 'fire'); b.spot(0.6, -1.0, PI, 'table'); b.spot(W / 2 - 1.6, D / 2 - 1.3, -HPI, 'bed');
    },
  });

  /* ---------------- inn (two storeys, sign, gallery) ---------------- */
  def('inn', {
    enterable: true,
    build(b, v, spec) {
      const W = 14, D = 10, H = 6.6, peak = 9.8, t = 0.4, FL = 3.3;
      const tile = v === 1;
      const sh = shell(b, {
        W, D, h: H, peak, t, wallMat: 'plaster', wallHex: [0xe9dfc8, 0xf2ede4, 0xdccbaa][v], timber: true, baseH: 1.0,
        roofMat: tile ? 'tile' : 'thatch', roofHex: tile ? TILES[1] : THATCHES[v], capHex: tile ? 0x4a3a34 : 0x8a6a36, overhang: 0.7, roofTh: tile ? 0.3 : 0.5,
        ceiling: 'vault', vaultHex: 0x8c6e4a, rafterHex: 0x3e2a18,      // the upper storey is open to the rafters
        chimneys: [{ side: 'l', u: -1.0 }, { side: 'r', u: 2.0 }],
        holes: [
          { side: 'f', u: -2.0, y: 0, w: 1.5, h: 2.4, door: true, hinge: -1, arch: true },
          { side: 'f', u: 1.2, y: 1.1, w: 1.2, h: 1.2 }, { side: 'f', u: 4.0, y: 1.1, w: 1.2, h: 1.2 }, { side: 'f', u: -5.0, y: 1.1, w: 1.2, h: 1.2 },
          { side: 'f', u: -4.5, y: 4.2, w: 1.0, h: 1.1 }, { side: 'f', u: -1.5, y: 4.2, w: 1.0, h: 1.1 }, { side: 'f', u: 1.5, y: 4.2, w: 1.0, h: 1.1 }, { side: 'f', u: 4.5, y: 4.2, w: 1.0, h: 1.1 },
          { side: 'b', u: -4, y: 1.1, w: 1.0, h: 1.1 }, { side: 'b', u: 4, y: 1.1, w: 1.0, h: 1.1 },
          { side: 'b', u: -4.5, y: 4.2, w: 1.0, h: 1.1 }, { side: 'b', u: -1.5, y: 4.2, w: 1.0, h: 1.1 }, { side: 'b', u: 1.5, y: 4.2, w: 1.0, h: 1.1 }, { side: 'b', u: 4.5, y: 4.2, w: 1.0, h: 1.1 },
          { side: 'l', u: 2.5, y: 1.1, w: 1.0, h: 1.1 }, { side: 'l', u: -3.2, y: 4.2, w: 0.9, h: 1.0 }, { side: 'l', u: 2.5, y: 4.2, w: 0.9, h: 1.0 },
          { side: 'r', u: -2.0, y: 1.1, w: 1.0, h: 1.1 }, { side: 'r', u: -2.0, y: 4.2, w: 0.9, h: 1.0 }, { side: 'r', u: 3.5, y: 4.2, w: 0.9, h: 1.0 },
        ],
      });
      // sign bracket + lanterns by the door
      b.at(0, -D / 2, 0);
      b.box('ext', 'wood', 0.06, 0.06, 1.3, 0.1, 3.9, -0.75, 0x26262a, { jit: 0 }); b.box('ext', 'wood', 0.06, 0.9, 0.06, 0.1, 3.45, -0.2, 0x26262a, { jit: 0 }); b.box('ext', 'wood', 0.05, 0.05, 0.9, 0.1, 3.55, -0.5, 0x26262a, { rx: -0.6, jit: 0 });
      b.cyl('ext', 'wood', 0.015, 0.015, 0.3, 4, -0.5, 3.75, -1.2, 0x26262a, { jit: 0 }); b.cyl('ext', 'wood', 0.015, 0.015, 0.3, 4, 0.7, 3.75, -1.2, 0x26262a, { jit: 0 });
      b.box('ext', 'wood', 1.5, 0.55, 0.05, 0.1, 3.3, -1.2, 0x6e4626);
      b.sign(0.1, 3.3, -1.2, 0, 1.5, 0.55);
      F.lantern(b, 'ext', -3.2, 2.6, -0.35, { scale: 0.9, intensity: 24 }); F.lantern(b, 'ext', -0.7, 2.6, -0.35, { scale: 0.9, intensity: 24 });
      b.box('ext', 'wood', 0.05, 0.05, 0.4, -3.2, 3.05, -0.2, 0x26262a, { jit: 0 }); b.box('ext', 'wood', 0.05, 0.05, 0.4, -0.7, 3.05, -0.2, 0x26262a, { jit: 0 });
      b.end();
      // ---- ground floor
      b.at(-W / 2 + t / 2 + 0.45, -1.0, HPI); F.hearth(b, 'int', 2.4, { h: FL, fxScale: 1.1 }); b.end();
      b.at(1.5, D / 2 - t / 2 - 1.5, 0); F.counter(b, 'int', 6.2); b.end();
      b.at(0.5, D / 2 - 0.42, 0); F.shelf(b, 'int', 2.4, 'bottles', 2.2); b.end();
      b.at(3.2, D / 2 - 0.42, 0); F.shelf(b, 'int', 2.0, 'crockery', 2.2); b.end();
      b.at(5.3, D / 2 - 0.9, 0); F.keg(b, 'int'); b.end(); b.at(5.3, D / 2 - 0.9, 0); b.at(0, 0, 0, 0.75); F.keg(b, 'int'); b.end(); b.end();
      b.at(-1.4, D / 2 - 0.8, 0); F.barrel(b, 'int', 0.32, 0.85); b.end(); b.at(-2.2, D / 2 - 0.7, 0); F.barrel(b, 'int', 0.28, 0.7); b.end();
      b.lathe('int', 'flat', [[0.03, 0], [0.05, 0.02], [0.06, 0.12], [0.04, 0.16], [0.045, 0.18]], 8, 0.0, 1.1, D / 2 - 1.55, 0xb08a58); b.lathe('int', 'flat', [[0.03, 0], [0.05, 0.02], [0.06, 0.12], [0.04, 0.16], [0.045, 0.18]], 8, 0.4, 1.1, D / 2 - 1.4, 0xb08a58);
      b.cyl('int', 'flat', 0.13, 0.13, 0.015, 12, 2.6, 1.08, D / 2 - 1.5, 0xece4d2); b.sph('int', 'flat', 0.1, 2.6, 1.15, D / 2 - 1.5, 0xc89a5a, { sy: 0.6, sz: 1.5 });
      F.candle(b, 'int', 3.8, 1.08, D / 2 - 1.5);
      const tables = [[-3.8, 1.4, 0.2], [-0.3, 1.2, -0.3], [3.4, -2.6, 0.4], [-4.6, -3.3, 0.1], [0.5, -3.0, -0.2]];
      for (const [tx, tz, tr] of tables) {
        b.at(tx, tz, tr); F.table(b, 'int', 1.5, 1.0);
        b.at(-0.5, -0.8, 0); F.stool(b, 'int'); b.end(); b.at(0.5, -0.8, 0); F.stool(b, 'int'); b.end(); b.at(-0.5, 0.8, 0); F.stool(b, 'int'); b.end(); b.at(0.5, 0.8, 0); F.stool(b, 'int'); b.end();
        F.candle(b, 'int', 0.3, 0.81, 0.1);
        b.lathe('int', 'flat', [[0.03, 0], [0.05, 0.02], [0.06, 0.12], [0.04, 0.16], [0.045, 0.18]], 8, -0.35, 0.81, -0.2, 0xb08a58);
        b.end();
        b.spot(tx, tz - 1.0, PI, 'table');
      }
      // stairs: 12 treads × 0.275 m rise (run 0.33) up the right-hand wall, open side (balusters + handrail) to the hall
      const SW = 1.3, SX = W / 2 - t / 2 - 0.05 - SW / 2, SZ0 = -4.3, NST = 12, RUN = 0.33, SZ1 = SZ0 + NST * RUN;   // SZ1: top nosing → landing
      b.at(SX, SZ0, 0); F.stairs(b, 'int', NST, FL / NST, RUN, SW, { rails: [-1] }); b.end();
      b.at(-1.5, -0.8, 0); F.rug(b, 'int', 3.2, 2.6, 'man'); b.end();
      F.lantern(b, 'int', -2.0, 2.45, 0.5, { scale: 0.9, intensity: 16, chain: 0.6 }); F.lantern(b, 'int', 3.0, 2.45, -1.5, { scale: 0.9, intensity: 16, chain: 0.6 });
      // upper floor slab with the stair well cut out — it IS the ground floor's ceiling (boards + joists from below), never hidden
      const sx0 = SX - SW / 2 - 0.02;                                   // gallery edge along the well
      b.floor(-W / 2 - t / 2, -D / 2 - t / 2, sx0, D / 2 + t / 2, FL, 'planks', 0x8a6242, 'upper', 0.2);
      b.floor(sx0, SZ1, W / 2 + t / 2, D / 2 + t / 2, FL, 'planks', 0x8a6242, 'upper', 0.2);       // landing + far end of the well column
      b.box('upper', 'wood', W / 2 + t / 2 - sx0, 0.05, 0.12, (sx0 + W / 2 + t / 2) / 2, FL + 0.02, SZ1 + 0.06, 0x6a4a2c, { jit: 0.02 });   // landing lip board
      for (let i = 0; i < 7; i++) {   // joists (the one over the well only spans the landing side)
        const bx = -W / 2 + 1.0 + i * 2.0;
        if (bx > sx0 - 0.25) b.box('upper', 'wood', 0.22, 0.28, D / 2 - t / 2 - SZ1, bx, FL - 0.32, (SZ1 + D / 2 - t / 2) / 2, 0x4a3220, { jit: 0.03 });
        else b.box('upper', 'wood', 0.22, 0.28, D - t, bx, FL - 0.32, 0, 0x4a3220, { jit: 0.03 });
      }
      b.box('upper', 'wood', W - t, 0.28, 0.24, 0, FL - 0.32, 0, 0x4a3220, { jit: 0.03 });
      b.ceiling('upper', FL);
      // gallery railing along the well (with its collider); the flight's handrail meets its last post at the landing
      const rz0 = -D / 2 + t / 2 + 0.05, rz1 = SZ1 - 0.2;
      b.at(sx0 - 0.07, (rz0 + rz1) / 2, HPI, FL); F.railing(b, 'upper', rz1 - rz0); b.end();
      const rooms = [-4.6, -0.2, 4.2];
      for (let i = 0; i < 3; i++) {
        const rx = rooms[i];
        b.at(rx, D / 2 - 1.35, 0, FL); F.bed(b, 'upper', 1.1, 2.1, BLANKETS[(i + v) % 5]); b.end();
        b.at(rx + 1.2, D / 2 - 0.7, 0, FL); F.chest(b, 'upper'); b.end();
        b.at(rx - 1.2, D / 2 - 0.55, 0, FL); F.stool(b, 'upper'); b.end();
        F.candle(b, 'upper', rx - 1.2, FL + 0.48, D / 2 - 0.55);
        b.at(rx, D / 2 - 3.0, 0, FL); F.rug(b, 'upper', 1.8, 1.2, 'man'); b.end();
        if (i < 2) {   // room partition whose top follows the roof underside (the upper storey is open to the rafters)
          const px = (rooms[i] + rooms[i + 1]) / 2, z0 = D / 2 - 4.6, z1 = D / 2 - t / 2;
          const yv = (z) => sh.ceilY + (sh.vaultY1 - sh.ceilY) * (1 - Math.abs(z) / (D / 2 + t / 2));
          const ps = new T.Shape(); ps.moveTo(z0, FL); ps.lineTo(z1, FL); ps.lineTo(z1, yv(z1) + 0.04); ps.lineTo(z0, yv(z0) + 0.04); ps.closePath();
          b.piece('upper', 'planks', new T.ExtrudeGeometry(ps, { depth: 0.12, bevelEnabled: false }), px + 0.06, 0, 0, 0xb08a5a, { ry: -HPI, jit: 0.03, faceJit: false });
          b.boxCol(px - 0.06, FL, z0, px + 0.06, sh.vaultY1, z1, false, 0.5);
        }
        b.spot(rx, D / 2 - 2.9, PI, 'bed', FL);
      }
      b.at(-4.0, -3.4, 0, FL); F.table(b, 'upper', 1.2, 0.8); b.end(); F.candle(b, 'upper', -4.0, FL + 0.81, -3.4);
      b.at(-4.0, -2.6, PI, FL); F.chair(b, 'upper'); b.end();
      b.at(2.0, -3.5, 0, FL); F.shelf(b, 'upper', 1.4, 'books', 1.6); b.end();
      F.lantern(b, 'upper', 0, FL + 2.2, -1.5, { scale: 0.8, intensity: 14, chain: 0.5 });
      b.spot(1.5, D / 2 - t / 2 - 0.85, 0, 'keeper'); b.spot(-4.3, -1.0, HPI, 'fire'); b.spot(-2.6, -2.8, 0, 'idle');
    },
    defaultName(spec) { return spec.name || 'The Inn'; },
  });

  /* ---------------- shop ---------------- */
  def('shop', {
    enterable: true,
    build(b, v) {
      const W = 7, D = 6.4, H = 3.4, peak = 5.8, t = 0.35;
      shell(b, {
        W, D, h: H, peak, ridge: 'z', t, wallMat: 'plaster', wallHex: [0xe3d6b8, 0xf0ebe0, 0xd8cfc0][v], timber: true, baseH: 0.9,
        roofMat: v === 2 ? 'tile' : 'thatch', roofHex: v === 2 ? TILES[0] : THATCHES[(v + 1) % 3], capHex: v === 2 ? 0x4a3a34 : 0x8a6a36, overhang: 0.5, roofTh: v === 2 ? 0.3 : 0.42,
        holes: [
          { side: 'f', u: 1.7, y: 0, w: 1.35, h: 2.2, door: true, hinge: 1 },
          { side: 'f', u: -1.3, y: 0.95, w: 1.9, h: 1.3 },
          { side: 'f', u: 0.1, y: 4.0, w: 0.7, h: 0.8 },
          { side: 'l', u: 1.0, y: 1.1, w: 0.9, h: 1.0 }, { side: 'r', u: -1.0, y: 1.1, w: 0.9, h: 1.0 }, { side: 'b', u: 0, y: 1.1, w: 0.9, h: 1.0 },
        ],
      });
      // awning + display table outside the window, sign
      b.at(-1.3, -D / 2, 0);
      b.plane('ext', 'awning', 2.6, 1.5, 0, 2.95, -0.75, 0xffffff, { rx: -1.15, jit: 0 });
      for (const sx of [-1, 1]) b.box('ext', 'wood', 0.08, 2.3, 0.08, sx * 1.25, 1.15, -1.4, 0x4a3220);
      b.box('ext', 'wood', 2.6, 0.08, 0.08, 0, 2.3, -1.4, 0x4a3220);
      b.at(0, -0.85, 0); F.table(b, 'ext', 1.8, 0.8); b.end();
      for (let i = 0; i < 4; i++) b.sph('ext', 'wood', 0.11, -0.6 + i * 0.4, 0.9, -0.85, [0xc83a2a, 0x8ab040, 0xe0a030, 0xb88a40][i], { jit: 0.05 });
      b.cyl('ext', 'wood', 0.1, 0.1, 0.5, 8, 0.5, 0.86, -1.0, 0x3a5a8a, { rz: HPI, jit: 0.04 });
      b.end();
      b.at(1.6, -D / 2, 0);
      b.box('ext', 'wood', 0.06, 0.06, 1.0, 0.9, 3.0, -0.6, 0x26262a, { jit: 0 }); b.box('ext', 'wood', 0.05, 0.05, 0.9, 0.9, 2.65, -0.45, 0x26262a, { rx: -0.75, jit: 0 });
      b.box('ext', 'wood', 1.2, 0.45, 0.05, 0.9, 2.55, -0.95, 0x6e4626); b.sign(0.9, 2.55, -0.95, 0, 1.2, 0.45);
      F.lantern(b, 'ext', -0.85, 2.3, -0.32, { scale: 0.8, intensity: 18 });
      b.end();
      // interior
      b.at(0.2, 0.7, 0); F.counter(b, 'int', 4.6); b.end();
      b.at(-1.5, D / 2 - 0.42, 0); F.shelf(b, 'int', 2.2, 'goods', 2.2); b.end();
      b.at(1.2, D / 2 - 0.42, 0); F.shelf(b, 'int', 2.2, 'goods', 2.2); b.end();
      b.at(W / 2 - 0.45, 0.3, HPI); F.shelf(b, 'int', 2.0, 'crockery', 2.0); b.end();
      b.at(W / 2 - 0.8, D / 2 - 0.7, 0); F.chest(b, 'int'); b.end(); b.at(W / 2 - 0.8, D / 2 - 1.4, 0); F.chest(b, 'int', 0x6a4a2a); b.end();
      b.at(-W / 2 + 0.7, D / 2 - 0.7, 0); F.barrel(b, 'int'); b.end(); b.at(-W / 2 + 0.7, D / 2 - 1.5, 0); F.barrel(b, 'int', 0.28, 0.7); b.end();
      b.at(-W / 2 + 0.7, -0.5, 0); F.crate(b, 'int', 0.7); b.end(); b.at(-W / 2 + 0.7, -0.5, 0, 0.7); F.crate(b, 'int', 0.55); b.end();
      b.at(-2.4, -2.2, 0); F.sack(b, 'int'); b.end(); b.at(-1.8, -2.4, 0); F.sack(b, 'int', 0xb8a070); b.end();
      // scales + ledger on the counter
      b.cyl('int', 'metal', 0.03, 0.05, 0.4, 6, 1.2, 1.28, 0.7, 0xb59a4a); b.box('int', 'metal', 0.6, 0.02, 0.02, 1.2, 1.48, 0.7, 0xb59a4a);
      for (const sx of [-1, 1]) { b.cyl('int', 'metal', 0.1, 0.08, 0.02, 10, 1.2 + sx * 0.28, 1.3, 0.7, 0xb59a4a); b.cyl('int', 'metal', 0.004, 0.004, 0.18, 3, 1.2 + sx * 0.28, 1.39, 0.7, 0xb59a4a); }
      b.box('int', 'flat', 0.35, 0.05, 0.28, -0.6, 1.1, 0.6, 0x5a3a2a); F.candle(b, 'int', -1.4, 1.07, 0.75);
      b.at(0.2, -1.2, 0); F.rug(b, 'int', 2.8, 1.6, 'man'); b.end();
      F.lantern(b, 'int', 0.2, 2.4, -0.6, { scale: 0.8, intensity: 14, chain: 0.5 });
      b.spot(0.2, 1.5, 0, 'keeper'); b.spot(-1.5, -1.5, 0, 'idle');
    },
    defaultName(spec) { return spec.name || 'Shop'; },
  });

  /* ---------------- elf_house ---------------- */
  def('elf_house', {
    enterable: true,
    build(b, v) {
      const W = 6.6, D = 8, H = 5.2, peak = 7.8, t = 0.35;
      shell(b, {
        W, D, h: H, peak, ridge: 'z', t, wallMat: 'plaster', wallHex: [0xeef0f4, 0xe8ecf2, 0xf2f0ea][v], wallJit: 0.01, baseH: 0.6, baseHex: 0xc4c8d0,
        roofMat: 'tile', roofHex: [0x8fa3bf, 0x7f9bb8, 0xa4b0c4][v], capHex: 0xd8c070, curvedRoof: true, overhang: 0.8, roofTh: 0.25, woodHex: 0xb8b4a8, sillHex: 0xd0d4dc,
        ceiling: 'vault', vaultMat: 'plaster', vaultHex: 0xf2f0ea, rafterHex: 0xd8c070, ties: false,
        holes: [
          { side: 'f', u: 0, y: 0, w: 1.4, h: 2.8, door: true, hinge: -1, arch: true, kind: 'elf' },
          { side: 'f', u: -2.1, y: 1.3, w: 0.8, h: 2.0, arch: true }, { side: 'f', u: 2.1, y: 1.3, w: 0.8, h: 2.0, arch: true },
          { side: 'l', u: -2.2, y: 1.3, w: 0.8, h: 2.0, arch: true }, { side: 'l', u: 2.2, y: 1.3, w: 0.8, h: 2.0, arch: true },
          { side: 'r', u: 0, y: 1.3, w: 0.8, h: 2.0, arch: true }, { side: 'b', u: 0, y: 1.6, w: 1.0, h: 2.2, arch: true },
        ],
      });
      // gold trim band, slender corner pillars, lanterns
      b.box('ext', 'metal', W + 0.5, 0.1, 0.06, 0, H - 0.25, -D / 2 - t / 2, 0xd8b862); b.box('ext', 'metal', W + 0.5, 0.1, 0.06, 0, H - 0.25, D / 2 + t / 2, 0xd8b862);
      b.box('ext', 'metal', 0.06, 0.1, D + 0.5, -W / 2 - t / 2, H - 0.25, 0, 0xd8b862); b.box('ext', 'metal', 0.06, 0.1, D + 0.5, W / 2 + t / 2, H - 0.25, 0, 0xd8b862);
      for (const sx of [-1, 1]) { b.at(sx * (W / 2 - 0.1), -D / 2 - 0.7, 0); F.pillar(b, 'ext', 'elf', H + 0.1); b.end(); b.cylCol(sx * (W / 2 - 0.1), -D / 2 - 0.7, 0.4, H); }
      b.box('roof', 'tile', W + 0.6, 0.25, 1.4, 0, H + 0.05, -D / 2 - 0.5, [0x8fa3bf, 0x7f9bb8, 0xa4b0c4][v], { jit: 0.01 });
      F.lantern(b, 'ext', -1.1, 2.6, -D / 2 - 0.35, { elf: true, scale: 0.8, intensity: 16 }); F.lantern(b, 'ext', 1.1, 2.6, -D / 2 - 0.35, { elf: true, scale: 0.8, intensity: 16 });
      // interior
      b.at(-W / 2 + 0.85, D / 2 - 1.4, 0); F.bed(b, 'int', 1.15, 2.2, 0x3a5a8c); b.end();
      b.at(W / 2 - 0.9, 0.5, 0); F.table(b, 'int', 1.3, 0.8); b.end(); b.at(W / 2 - 0.9, -0.3, PI); F.chair(b, 'int', 0xc8c0b0); b.end();
      F.candle(b, 'int', W / 2 - 1.2, 0.81, 0.5);
      b.box('int', 'flat', 0.3, 0.04, 0.22, W / 2 - 0.7, 0.83, 0.6, 0xe8e0d0); b.box('int', 'flat', 0.06, 0.2, 0.06, W / 2 - 0.5, 0.9, 0.3, 0x2a4a7a);
      b.at(W / 2 - 0.45, D / 2 - 1.5, HPI); F.shelf(b, 'int', 2.0, 'books', 2.4); b.end();
      b.at(-W / 2 + 0.45, -1.5, -HPI); F.shelf(b, 'int', 1.6, 'books', 2.0); b.end();
      // harp
      b.at(-1.2, -2.4, 0.6);
      b.torus('int', 'wood', 0.55, 0.05, 0, 0.8, 0, 0xc8a850, { ts: 0, tl: PI, jit: 0 });
      b.box('int', 'wood', 0.08, 1.2, 0.1, -0.5, 0.6, 0, 0xc8a850); b.box('int', 'wood', 1.1, 0.1, 0.12, 0, 0.1, 0, 0xc8a850);
      for (let i = 0; i < 9; i++) b.box('int', 'metal', 0.006, 0.6 + i * 0.05, 0.006, -0.42 + i * 0.1, 0.4 + (0.6 + i * 0.05) / 2, 0, 0xe8e0c0);
      b.end();
      b.at(0.2, 0.4, 0); F.rug(b, 'int', 3.0, 3.6, 'elf'); b.end();
      F.lantern(b, 'int', 0, 3.6, 0, { elf: true, scale: 0.9, intensity: 18, chain: 0.9 });
      b.spot(W / 2 - 0.9, -1.1, PI, 'table'); b.spot(-1.0, 1.5, 0, 'idle');
    },
  });

  /* ---------------- elf_hall ---------------- */
  def('elf_hall', {
    enterable: true,
    build(b, v) {
      const W = 12, D = 18, H = 7, peak = 10.6, t = 0.5;
      shell(b, {
        W, D, h: H, peak, ridge: 'z', t, wallMat: 'plaster', wallHex: [0xeef0f4, 0xf2f0ea, 0xe8ecf2][v], wallJit: 0.01, baseH: 0.8, baseHex: 0xc4c8d0,
        roofMat: 'tile', roofHex: [0x8fa3bf, 0x7f9bb8, 0xa4b0c4][v], capHex: 0xd8c070, curvedRoof: true, overhang: 1.0, roofTh: 0.3, woodHex: 0xb8b4a8, sillHex: 0xd0d4dc,
        floorMat: 'stone', floorHex: 0xdfe2e8,
        ceiling: 'vault', vaultMat: 'plaster', vaultHex: 0xeef0f4, rafterHex: 0xd8c070, ties: false,
        holes: [
          { side: 'f', u: 0, y: 0, w: 2.6, h: 4.4, door: true, hinge: -1, leaves: 2, arch: true, kind: 'elf' },
          { side: 'f', u: -3.8, y: 1.6, w: 1.0, h: 3.0, arch: true }, { side: 'f', u: 3.8, y: 1.6, w: 1.0, h: 3.0, arch: true },
          { side: 'l', u: -6, y: 1.6, w: 1.0, h: 3.4, arch: true }, { side: 'l', u: -2, y: 1.6, w: 1.0, h: 3.4, arch: true }, { side: 'l', u: 2, y: 1.6, w: 1.0, h: 3.4, arch: true }, { side: 'l', u: 6, y: 1.6, w: 1.0, h: 3.4, arch: true },
          { side: 'r', u: -6, y: 1.6, w: 1.0, h: 3.4, arch: true }, { side: 'r', u: -2, y: 1.6, w: 1.0, h: 3.4, arch: true }, { side: 'r', u: 2, y: 1.6, w: 1.0, h: 3.4, arch: true }, { side: 'r', u: 6, y: 1.6, w: 1.0, h: 3.4, arch: true },
          { side: 'b', u: -3, y: 2.0, w: 1.0, h: 3.0, arch: true }, { side: 'b', u: 3, y: 2.0, w: 1.0, h: 3.0, arch: true }, { side: 'b', u: 0, y: 5.0, w: 1.2, h: 2.4, arch: true },
        ],
      });
      // colonnade porch
      for (const px of [-4.8, -2.0, 2.0, 4.8]) { b.at(px, -D / 2 - 1.8, 0); F.pillar(b, 'ext', 'elf', H); b.end(); b.cylCol(px, -D / 2 - 1.8, 0.4, H); }
      b.box('roof', 'tile', W + 1.2, 0.3, 3.0, 0, H + 0.05, -D / 2 - 1.2, [0x8fa3bf, 0x7f9bb8, 0xa4b0c4][v], { jit: 0.01 });
      b.box('ext', 'metal', W + 0.6, 0.12, 0.06, 0, H - 0.3, -D / 2 - t / 2, 0xd8b862); b.box('ext', 'metal', W + 0.6, 0.12, 0.06, 0, H - 0.3, D / 2 + t / 2, 0xd8b862);
      b.box('ext', 'metal', 0.06, 0.12, D + 0.6, -W / 2 - t / 2, H - 0.3, 0, 0xd8b862); b.box('ext', 'metal', 0.06, 0.12, D + 0.6, W / 2 + t / 2, H - 0.3, 0, 0xd8b862);
      b.box('ext', 'stone', 6, 0.16, 3.2, 0, 0.0, -D / 2 - 1.5, 0xd8dbe2, { jit: 0.02 });
      F.lantern(b, 'ext', -2.0, 4.0, -D / 2 - 1.4, { elf: true, scale: 1.0, intensity: 22 }); F.lantern(b, 'ext', 2.0, 4.0, -D / 2 - 1.4, { elf: true, scale: 1.0, intensity: 22 });
      // interior: pillars, fountain, benches, dais + seat, banners, lanterns
      for (const sx of [-1, 1]) for (const pz of [-4.5, 0.5, 5.5]) { b.at(sx * 3.6, pz, 0); F.pillar(b, 'int', 'elf', H - 0.05); b.end(); b.cylCol(sx * 3.6, pz, 0.4, H); b.at(sx * 3.6, pz, sx > 0 ? HPI : -HPI, H - 1.2); b.box('int', 'metal', 0.9, 0.05, 0.05, 0, 0, -0.45, 0xd8b862); F.banner(b, 'int', 0.7, 2.4, [0x3c5c8c, 0x5a7a9c, 0x2e4a6c][v], 0xe8e6d8); b.end(); }
      b.at(0, -2.2, 0); F.fountain(b, 'int', 1.8); b.end(); b.cylCol(0, -2.2, 1.9, 0.7);
      for (const sx of [-1, 1]) { b.at(sx * 2.0, 2.6, sx > 0 ? -HPI : HPI); stoneBench(b, 'int', 2.2); b.end(); b.at(sx * 2.0, -2.2, sx > 0 ? -HPI : HPI); stoneBench(b, 'int', 2.0); b.end(); b.at(sx * 4.9, -6.5, sx > 0 ? -HPI : HPI); stoneBench(b, 'int', 2.0); b.end(); }
      b.box('int', 'stone', 7, 0.4, 3.2, 0, 0.25, D / 2 - 1.85, 0xd9dbe0, { jit: 0.02 }); b.box('int', 'stone', 8, 0.2, 4.2, 0, 0.15, D / 2 - 2.35, 0xd9dbe0, { jit: 0.02 });
      b.boxCol(-4, 0, D / 2 - 4.45, 4, 0.25, D / 2 - 0.25, true); b.boxCol(-3.5, 0, D / 2 - 3.45, 3.5, 0.45, D / 2 - 0.25, true);
      b.at(0, D / 2 - 1.3, 0, 0.45);
      b.box('int', 'stone', 1.1, 0.12, 0.9, 0, 0.5, 0, 0xe4e6ea); b.box('int', 'stone', 1.1, 1.6, 0.14, 0, 1.0, 0.4, 0xe4e6ea, { jit: 0.02 });
      for (const sx of [-1, 1]) b.box('int', 'stone', 0.14, 0.7, 0.9, sx * 0.55, 0.65, 0, 0xe4e6ea); b.box('int', 'flat', 0.9, 0.08, 0.7, 0, 0.6, 0, 0x3c5c8c);
      b.torus('int', 'metal', 0.4, 0.04, 0, 1.75, 0.4, 0xd8b862, { ts: 0, tl: PI, jit: 0 });
      b.end();
      b.at(0, 1.5, 0); F.rug(b, 'int', 2.6, 8.0, 'elf'); b.end();
      F.lantern(b, 'int', -3.6, 4.4, -2.0, { elf: true, scale: 1.1, intensity: 22, chain: 1.6 }); F.lantern(b, 'int', 3.6, 4.4, 3.0, { elf: true, scale: 1.1, intensity: 22, chain: 1.6 }); F.lantern(b, 'int', 0, 5.2, 5.5, { elf: true, scale: 1.1, intensity: 22, chain: 1.4 });
      b.spot(0, D / 2 - 2.0, 0, 'lord', 0.45); b.spot(-2.4, -2.2, -HPI, 'idle'); b.spot(2.4, -2.2, HPI, 'idle'); b.spot(-2.0, 3.4, 0, 'table'); b.spot(2.0, 3.4, 0, 'table');
    },
  });

  /* ---------------- dwarf_house ---------------- */
  def('dwarf_house', {
    enterable: true,
    build(b, v) {
      const W = 8, D = 7, H = 3.6, peak = 5.2, t = 0.6;
      shell(b, {
        W, D, h: H, peak, t, wallMat: 'stone', wallHex: [0x7a7478, 0x6e6a70, 0x807a74][v], wallJit: 0.05, baseH: 0.8, baseHex: 0x555157,
        roofMat: 'stone', roofHex: 0x5f5c62, capHex: 0x4a474c, overhang: 0.45, roofTh: 0.5, woodHex: 0x3e2e22, sillHex: 0x555157,
        floorMat: 'stone', floorHex: 0x6a6660,
        ceilMat: 'stone', ceilHex: 0x6e6a70, beamHex: 0x3e2e22,
        holes: [
          { side: 'f', u: -1.9, y: 0, w: 1.45, h: 2.4, door: true, hinge: -1, kind: 'dwarf' },
          { side: 'f', u: 1.8, y: 1.3, w: 0.9, h: 0.8 }, { side: 'l', u: -1.0, y: 1.3, w: 0.8, h: 0.8 }, { side: 'b', u: 0, y: 1.3, w: 0.8, h: 0.8 },
        ],
        chimney: { side: 'r', u: 0.6 }, chimneyHex: 0x5c5658,
      });
      // angular buttresses + bronze rune plaque
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('ext', 'stone', 0.7, 2.4, 0.7, sx * (W / 2 + 0.2), 0.7, sz * (D / 2 + 0.2), 0x66626a, { jit: 0.05, ry: PI / 4 });
      b.box('ext', 'metal', 1.5, 0.5, 0.08, -1.9, 2.75, -D / 2 - t / 2 - 0.02, 0xb08040);
      for (let i = 0; i < 3; i++) b.box('ext', 'metal', 0.22, 0.22, 0.05, -2.3 + i * 0.4, 2.75, -D / 2 - t / 2 - 0.08, 0x5a3a20, { rz: PI / 4 });
      // interior
      b.at(W / 2 - t / 2 - 0.45, 0.6, -HPI); F.hearth(b, 'int', 1.7, { h: H, hex: 0x5c5658 }); b.end();
      b.at(-W / 2 + 1.0, D / 2 - 1.25, 0); F.bed(b, 'int', 1.3, 1.9, 0x6a5a48); b.end();
      b.at(-W / 2 + 1.0, D / 2 - 2.75, 0); F.chest(b, 'int', 0x5a4030); b.end(); b.at(-W / 2 + 2.1, D / 2 - 0.6, 0); F.chest(b, 'int', 0x5a4030); b.end();
      b.at(0.4, 0.2, 0); F.table(b, 'int', 1.6, 1.0, 0x5e4230); b.end();
      b.at(0.0, -0.7, 0); F.stool(b, 'int'); b.end(); b.at(0.8, 1.1, 0); F.stool(b, 'int'); b.end();
      b.cyl('int', 'flat', 0.06, 0.05, 0.14, 8, 0.2, 0.86, 0.3, 0x9ca3a8); b.cyl('int', 'flat', 0.06, 0.05, 0.14, 8, 0.6, 0.86, -0.1, 0x9ca3a8); F.candle(b, 'int', -0.2, 0.81, 0.0);
      b.at(1.6, D / 2 - 0.42, 0); F.shelf(b, 'int', 1.8, 'crockery', 2.0); b.end();
      b.at(-1.0, D / 2 - 0.42, 0);   // weapon rack
      b.box('int', 'wood', 1.4, 0.08, 0.2, 0, 1.5, 0.1, 0x3e2e22); b.box('int', 'wood', 1.4, 0.08, 0.2, 0, 0.6, 0.1, 0x3e2e22);
      for (const x of [-0.4, 0.1, 0.5]) { b.cyl('int', 'wood', 0.025, 0.03, 1.4, 6, x, 1.0, 0, 0x4a3220); b.box('int', 'metal', 0.3, 0.22, 0.04, x + 0.1, 1.55, 0, 0x8a8c94); }
      b.end();
      b.at(-2.2, -1.6, 0); F.barrel(b, 'int', 0.34, 0.9, 0x6a4a30); b.end();
      b.at(0.4, 0.0, 0); F.rug(b, 'int', 2.8, 2.4, 'dwarf'); b.end();
      b.at(-W / 2 + 0.6, -D / 2 + 0.7, 0); F.brazier(b, 'int', 0.7); b.end();
      b.spot(1.4, 0.6, -HPI, 'fire'); b.spot(0.4, -1.1, PI, 'table');
    },
  });

  /* ---------------- dwarf_hall ---------------- */
  def('dwarf_hall', {
    enterable: true,
    build(b, v) {
      const W = 16, D = 22, H = 8, peak = 11, t = 0.8;
      shell(b, {
        W, D, h: H, peak, ridge: 'z', t, wallMat: 'stone', wallHex: [0x76727a, 0x6c6872, 0x7a7674][v], wallJit: 0.05, baseH: 1.2, baseHex: 0x55525a,
        roofMat: 'stone', roofHex: 0x57545b, capHex: 0x3f3c42, overhang: 0.6, roofTh: 0.6, woodHex: 0x3e2e22, sillHex: 0x4a474e,
        floorMat: 'stone', floorHex: 0x615d62,
        ceiling: 'vault', vaultMat: 'stone', vaultHex: 0x5a565c, rafterHex: 0x3f3c42, ties: false,
        holes: [
          { side: 'f', u: 0, y: 0, w: 3.2, h: 4.8, door: true, hinge: -1, leaves: 2, kind: 'dwarf' },
          { side: 'f', u: -5.2, y: 3.6, w: 0.9, h: 2.0 }, { side: 'f', u: 5.2, y: 3.6, w: 0.9, h: 2.0 },
          { side: 'l', u: -7, y: 3.2, w: 0.8, h: 2.4 }, { side: 'l', u: -2.5, y: 3.2, w: 0.8, h: 2.4 }, { side: 'l', u: 2, y: 3.2, w: 0.8, h: 2.4 }, { side: 'l', u: 6.5, y: 3.2, w: 0.8, h: 2.4 },
          { side: 'r', u: -7, y: 3.2, w: 0.8, h: 2.4 }, { side: 'r', u: -2.5, y: 3.2, w: 0.8, h: 2.4 }, { side: 'r', u: 2, y: 3.2, w: 0.8, h: 2.4 }, { side: 'r', u: 6.5, y: 3.2, w: 0.8, h: 2.4 },
        ],
      });
      // stepped portal + pillars + entablature + braziers + rune band
      b.at(0, -D / 2 - t / 2, 0);
      for (let i = 0; i < 3; i++) {
        const w = 3.4 + i * 1.3, h = 5.0 + i * 0.9, d = 0.5, z = -(i * d) - d / 2, hx = [0x55515a, 0x4e4a52, 0x46434a][i];
        for (const sx of [-1, 1]) b.box('ext', 'stone', 0.65, h, d, sx * (w / 2 + 0.3), h / 2, z, hx, { jit: 0.05 });
        b.box('ext', 'stone', w + 1.9, 0.75, d, 0, h + 0.37, z, hx, { jit: 0.05 });
      }
      for (const px of [-3.6, 3.6]) b.box('ext', 'metal', 0.6, 0.6, 0.05, px, 4.0, -1.55, 0xb08040, { rz: PI / 4 });
      for (let i = 0; i < 9; i++) b.box('ext', 'metal', 0.32, 0.32, 0.06, -6.4 + i * 1.6, 7.2, -0.06, 0xb08040, { rz: PI / 4 });
      b.end();
      for (const px of [-6.6, -3.6, 3.6, 6.6]) { b.at(px, -D / 2 - 2.4, 0); F.pillar(b, 'ext', 'dwarf', 8.4); b.end(); b.boxCol(px - 0.65, 0, -D / 2 - 3.05, px + 0.65, 8, -D / 2 - 1.75); }
      b.box('roof', 'stone', W + 1.6, 1.0, 3.4, 0, H + 0.6, -D / 2 - 1.5, 0x4e4a52, { jit: 0.04 });
      b.box('ext', 'stone', 10, 0.3, 4.2, 0, 0.1, -D / 2 - 2.0, 0x4a474e, { jit: 0.04 }); b.box('ext', 'stone', 11, 0.16, 5.0, 0, -0.05, -D / 2 - 2.4, 0x4a474e, { jit: 0.04 });
      for (const sx of [-1, 1]) { b.box('ext', 'stone', 1.0, 1.0, 1.0, sx * 2.9, 0.75, -D / 2 - 1.6, 0x4e4a52, { jit: 0.05 }); b.at(sx * 2.9, -D / 2 - 1.6, 0, 1.25); F.brazier(b, 'ext', 1.1); b.end(); b.cylCol(sx * 2.9, -D / 2 - 1.6, 0.6, 2); }
      // interior
      for (const sx of [-1, 1]) for (const pz of [-7, -2.5, 2, 6.5]) { b.at(sx * 4.6, pz, 0); F.pillar(b, 'int', 'dwarf', H - 0.1, 0x5e5a5e); b.end(); b.boxCol(sx * 4.6 - 0.65, 0, pz - 0.65, sx * 4.6 + 0.65, H, pz + 0.65); }
      b.at(-5.4, D / 2 - t / 2 - 1.0, 0); F.forge(b, 'int'); b.end(); b.boxCol(-6.6, 0, D / 2 - 2.9, -4.2, 2.4, D / 2 - 0.3);
      b.at(-5.4, D / 2 - 4.0, 0); F.anvil(b, 'int'); b.end(); b.cylCol(-5.4, D / 2 - 4.0, 0.35, 1);
      b.at(-3.0, D / 2 - 2.0, HPI); F.trough(b, 'int'); b.end();
      b.at(-W / 2 + 0.6, 2.0, -HPI); b.box('int', 'wood', 3.0, 0.08, 0.2, 0, 1.6, 0.1, 0x3e2e22); b.box('int', 'wood', 3.0, 0.08, 0.2, 0, 0.7, 0.1, 0x3e2e22); for (let i = 0; i < 6; i++) { const x = -1.3 + i * 0.5; b.cyl('int', 'wood', 0.03, 0.035, 1.6, 6, x, 1.1, 0, 0x4a3220); b.box('int', 'metal', 0.34, 0.26, 0.05, x + 0.12, 1.72, 0, 0x8a8c94); } b.end();
      b.at(0, -1.0, 0); F.table(b, 'int', 6.0, 1.3, 0x5e4230); b.end();
      b.at(0, -2.0, 0); F.bench(b, 'int', 5.6, 0x5e4230); b.end(); b.at(0, 0.0, PI); F.bench(b, 'int', 5.6, 0x5e4230); b.end();
      for (let i = 0; i < 5; i++) { const x = -2.4 + i * 1.2; b.cyl('int', 'flat', 0.06, 0.05, 0.14, 8, x, 0.86, -1.3 + (i % 2) * 0.5, 0x9ca3a8); if (i % 2 === 0) F.candle(b, 'int', x + 0.3, 0.81, -0.8); else b.cyl('int', 'flat', 0.14, 0.14, 0.015, 12, x - 0.3, 0.81, -1.0, 0xece4d2); }
      b.box('int', 'stone', 7, 0.5, 3.4, 0, 0.3, D / 2 - 2.2, 0x55515a, { jit: 0.04 }); b.box('int', 'stone', 8.4, 0.25, 4.6, 0, 0.17, D / 2 - 2.8, 0x55515a, { jit: 0.04 });
      b.boxCol(-4.2, 0, D / 2 - 5.1, 4.2, 0.3, D / 2 - 0.5, true); b.boxCol(-3.5, 0, D / 2 - 3.9, 3.5, 0.55, D / 2 - 0.5, true);
      b.at(0, D / 2 - 1.6, 0, 0.55);
      b.box('int', 'stone', 1.5, 0.7, 1.1, 0, 0.35, 0, 0x4a474e, { jit: 0.04 }); b.box('int', 'stone', 1.5, 2.2, 0.3, 0, 1.4, 0.45, 0x4a474e, { jit: 0.04 });
      for (const sx of [-1, 1]) b.box('int', 'stone', 0.3, 1.1, 1.1, sx * 0.75, 0.9, 0, 0x4a474e, { jit: 0.04 });
      b.box('int', 'flat', 1.0, 0.1, 0.8, 0, 0.75, -0.05, 0x6a2a2a); b.box('int', 'metal', 0.6, 0.6, 0.06, 0, 1.9, 0.28, 0xb08040, { rz: PI / 4 });
      b.end();
      for (const sx of [-1, 1]) { b.at(sx * 3.0, 5.0, 0); F.brazier(b, 'int', 1.0); b.end(); b.cylCol(sx * 3.0, 5.0, 0.5, 1.5); }
      for (let i = 0; i < 4; i++) { b.at(W / 2 - 1.0 - (i % 2) * 0.9, D / 2 - 1.0 - Math.floor(i / 2) * 0.9, 0); F.barrel(b, 'int', 0.36, 1.0, 0x6a4a30); b.end(); }
      b.at(W / 2 - 1.2, 3.0, 0); F.crate(b, 'int', 0.9, 0x7a5a3a); b.end(); b.at(W / 2 - 1.2, 3.0, 0, 0.9); F.crate(b, 'int', 0.7, 0x7a5a3a); b.end();
      b.at(0, -4.0, 0); F.rug(b, 'int', 3.2, 12, 'dwarf'); b.end();
      b.spot(0, D / 2 - 2.6, 0, 'lord', 0.55); b.spot(-5.4, D / 2 - 5.2, PI, 'forge'); b.spot(-1.5, -2.6, PI, 'table'); b.spot(1.5, -2.6, PI, 'table'); b.spot(-1.5, 0.6, 0, 'table'); b.spot(1.5, 0.6, 0, 'table'); b.spot(4.2, 5.0, HPI, 'fire');
    },
  });

  /* ---------------- lossoth_hut ---------------- */
  def('lossoth_hut', {
    variants: 2, enterable: true, styleVariant(style, v) { return v; },
    build(b, v) {
      const R = 3.5, snow = v === 1, mat = snow ? 'flat' : 'hide', hex = snow ? 0xeef2f8 : 0xb09068, inner = snow ? 0xd8dfe8 : 0x9a7a58;
      const outer = domeGeo(R, 28, 12); b.piece('roof', mat, outer, 0, 0, 0, hex, { jit: snow ? 0.02 : 0.05, faceJit: false });
      b.cyl('roof', mat, R * 1.02, R * 1.05, 1.0, 28, 0, -0.5, 0, hex, { jit: 0.03 });
      if (!snow) for (const y of [0.9, 2.0, 2.8]) { const rr = Math.sqrt(R * R - y * y) + 0.02; b.torus('roof', 'flat', rr, 0.035, 0, y, 0, 0x4a3a28, { rx: HPI, jit: 0 }); }
      else for (let i = 0; i < 6; i++) { const a = i * PI / 6; b.torus('roof', 'flat', R + 0.02, 0.05, 0, 0, 0, 0xd8dfe8, { ry: a, ts: 0, tl: PI, jit: 0 }); }
      b.cyl('ext', 'flat', 0.45, 0.45, 0.08, 12, 0, R - 0.02, 0, 0x151210, { jit: 0 }); b.smoke(0, R + 0.1, 0);
      const cap = invertGeo(new T.SphereGeometry(R - 0.08, 28, 8, 0, TAU, 0, 0.95)); b.piece('int', mat, cap, 0, 0, 0, inner, { jit: 0.04, faceJit: false });   // inner dome: never hidden
      b.boxCol(-2.3, 2.5, -2.3, 2.3, 2.6, 2.3, false, 2);
      const band = invertGeo(new T.SphereGeometry(R - 0.08, 28, 6, 0, TAU, 0.95, HPI - 0.95 + 0.05)); b.piece('int', mat, band, 0, 0, 0, inner, { jit: 0.04, faceJit: false });
      // entrance tunnel + hide flap door
      b.box('ext', mat, 1.9, 2.0, 1.4, 0, 1.0, -R + 0.1, hex, { jit: 0.04 }); b.box('int', 'flat', 1.5, 1.75, 1.5, 0, 0.87, -R + 0.1, 0x2a2018, { jit: 0.04 });
      for (const sx of [-1, 1]) b.wallCol(sx * 0.75, -R - 0.7, sx * 0.75, -R + 0.8, 2.0, 0.2);
      b.box('ext', 'wood', 0.1, 1.85, 0.1, -0.8, 0.92, -R - 0.55, 0x4a3a28); b.box('ext', 'wood', 0.1, 1.85, 0.1, 0.8, 0.92, -R - 0.55, 0x4a3a28); b.box('ext', 'wood', 1.7, 0.1, 0.12, 0, 1.9, -R - 0.55, 0x4a3a28);
      b.door({ x: 0, z: -R - 0.55, ry: 0, w: 1.5, h: 1.8, kind: 'flap', hinge: -1, y: 0.05, t: 0.2, name: 'Hide flap' });
      b.ringCol(0, 0, R - 0.15, 3.2, 16, 0, 1.8);
      // interior: fire pit, furs, bedrolls, fish rack, chest
      b.cyl('int', 'flat', R - 0.05, R - 0.05, 0.1, 28, 0, 0.0, 0, 0x8a7a66, { jit: 0.05 }); b.boxCol(-R, -0.1, -R, R, 0.05, R, true);
      b.box('int', 'planks', 1.5, 0.1, 1.5, 0, 0.0, -R + 0.1, 0x7a5a3a, { jit: 0.04 });
      for (let i = 0; i < 9; i++) { const a = i / 9 * TAU; b.sph('int', 'rock', 0.2, Math.sin(a) * 0.75, 0.12, Math.cos(a) * 0.75, 0x6f6a64, { sy: 0.7, jit: 0.1 }); }
      for (let i = 0; i < 3; i++) b.cyl('int', 'wood', 0.07, 0.08, 0.9, 7, 0, 0.16, 0, 0x3d2a18, { rz: HPI, ry: i * PI / 3, jit: 0.06 });
      b.sph('int', 'ember', 0.32, 0, 0.12, 0, 0xff7a20, { sy: 0.4, jit: 0.2 });
      b.light(0, 1.0, 0, { kind: 'fire', color: 0xffa040, intensity: 35, dist: 11, interior: true }); b.hearth(0, 0.3, 0, 1.0);
      for (let i = 0; i < 3; i++) { const a = 0.9 + i * 1.5; b.at(Math.sin(a) * 2.1, Math.cos(a) * 2.1, a + PI); F.bedroll(b, 'int', [0x8a7a66, 0xa89880, 0x6a5a4a][i]); b.end(); }
      b.sph('int', 'flat', 1.1, 1.3, 0.05, -1.4, 0xb09070, { sy: 0.06, jit: 0.08 }); b.sph('int', 'flat', 0.9, -1.6, 0.05, -0.9, 0xc8b090, { sy: 0.06, jit: 0.08 });
      b.at(-2.2, 1.6, 0.7); F.chest(b, 'int', 0x6a5040); b.end();
      b.at(2.0, 1.2, -0.6); b.box('int', 'wood', 0.08, 1.7, 0.08, -0.6, 0.85, 0, 0x4a3a28); b.box('int', 'wood', 0.08, 1.7, 0.08, 0.6, 0.85, 0, 0x4a3a28); b.box('int', 'wood', 1.3, 0.06, 0.06, 0, 1.7, 0, 0x4a3a28);
      for (let i = 0; i < 4; i++) b.sph('int', 'flat', 0.1, -0.45 + i * 0.3, 1.45, 0, 0x8a9aa0, { sy: 2.2, sz: 0.5, jit: 0.06 }); b.end();
      for (let i = 0; i < 5; i++) b.cyl('int', 'wood', 0.08, 0.09, 0.7, 7, -2.4 + (i % 3) * 0.2, 0.1 + Math.floor(i / 3) * 0.17, 2.6, 0x4a3320, { rz: HPI, jit: 0.06 });
      b.spot(-1.3, -0.4, -HPI + 0.3, 'fire'); b.spot(1.3, 0.6, HPI - 0.4, 'fire');
      b.interior(-R, -0.5, -R - 0.8, R, R + 0.5, R);
    },
  });

  /* ---------------- tent ---------------- */
  def('tent', {
    enterable: true,
    build(b, v) {
      const R = 2.6, Hh = 3.0, hex = [0xd9c9a3, 0x5c6a4a, 0x9a4a3a][v];
      const gap = 0.42;
      b.cone('int', 'cloth', R, Hh, 14, 0, Hh / 2, 0, hex, { open: true, ts: PI + gap, tl: TAU - 2 * gap, jit: 0.04, faceJit: false });   // the canvas is the ceiling: never hidden
      b.cyl('int', 'wood', 0.06, 0.07, Hh, 7, 0, Hh / 2, 0, 0x5a3c25);
      b.sph('ext', 'wood', 0.1, 0, Hh + 0.05, 0, 0x5a3c25);
      for (let i = 0; i < 4; i++) {
        const a = PI / 4 + i * HPI, px = Math.sin(a) * (R + 0.9), pz = Math.cos(a) * (R + 0.9);
        b.box('ext', 'wood', 0.08, 0.35, 0.08, px, 0.12, pz, 0x4a3220, { rx: 0.3 * Math.cos(a), rz: -0.3 * Math.sin(a) });
        const ry = 1.3, rr = R * (1 - ry / Hh) + 0.02;
        b.rod('ext', 'flat', Math.sin(a) * rr, ry, Math.cos(a) * rr, px, 0.25, pz, 0.012, 0xc8b890);
      }
      b.cyl('int', 'cloth', R - 0.25, R - 0.25, 0.04, 14, 0, 0.02, 0, 0xbca987, { jit: 0.04 });
      b.at(0.7, 0.5, 0.3); F.bedroll(b, 'int'); b.end();
      b.at(-1.1, 0.7, -0.5); F.chest(b, 'int'); b.end();
      b.at(-1.0, -0.9, 0); F.sack(b, 'int'); b.end();
      F.lantern(b, 'int', 1.3, 0.02, -0.9, { scale: 0.7, intensity: 10, dist: 7 });
      b.ringCol(0, 0, R - 0.1, 2.2, 14, 0, 2.0);
      b.interior(-R, -0.5, -R, R, Hh + 0.3, R);
      b.spot(0, -0.6, PI, 'bed');
    },
  });

  /* ---------------- tower ---------------- */
  def('tower', {
    enterable: true,
    build(b, v) {
      const R = 3.4, Ri = 2.8, H = 9.6, hex = [0x8a857b, 0x7c7872, 0x8f8578][v];
      const gap = Math.asin(0.72 / R);
      b.cyl('ext', 'stone', R, R + 0.15, H + 1, 28, 0, H / 2 - 0.5, 0, hex, { open: true, ts: PI + gap, tl: TAU - 2 * gap, jit: 0.05 });
      const inner = invertGeo(new T.CylinderGeometry(Ri, Ri, H, 28, 1, true, PI + gap, TAU - 2 * gap)); b.piece('int', 'stone', inner, 0, H / 2, 0, 0x8d887e, { jit: 0.05 });
      for (const sx of [-1, 1]) b.box('ext', 'stone', 0.5, 2.6, R - Ri + 0.1, sx * (0.72 + 0.25), 1.3, -(R + Ri) / 2, hex, { jit: 0.05 });
      b.box('ext', 'stone', 2.4, 0.5, R - Ri + 0.1, 0, 2.85, -(R + Ri) / 2, hex, { jit: 0.05 });
      b.box('ext', 'wood', 0.14, 2.5, 0.7, -0.72, 1.25, -R + 0.3, 0x4a3220); b.box('ext', 'wood', 0.14, 2.5, 0.7, 0.72, 1.25, -R + 0.3, 0x4a3220); b.box('ext', 'wood', 1.6, 0.14, 0.7, 0, 2.55, -R + 0.3, 0x4a3220);
      b.box('ext', 'stone', 2.0, 0.12, 1.0, 0, 0.0, -R - 0.5, 0x8d8579, { jit: 0.06 });
      b.door({ x: 0, z: -R + 0.3, ry: 0, w: 1.3, h: 2.4, kind: 'banded', hinge: -1, y: 0.05, t: 0.6 });
      for (let i = 0; i < 4; i++) { const a = PI / 2 + i * 0.9 + 0.3, y = 3.2 + i * 1.6; b.box('ext', 'flat', 0.18, 0.9, 0.1, Math.sin(a) * R, y, Math.cos(a) * R, 0x0e0c0a, { ry: a, jit: 0 }); b.box('ext', 'stone', 0.5, 1.2, 0.12, Math.sin(a) * (R + 0.02), y, Math.cos(a) * (R + 0.02), 0x77726a, { ry: a, jit: 0.04 }); }
      // parapet + merlons (exterior, stays visible) — platform (roof group, hidden when inside)
      const rg = new T.RingGeometry(Ri - 0.1, R + 0.35, 28); rg.rotateX(-HPI); b.piece('ext', 'stone', rg, 0, H + 0.02, 0, hex, { jit: 0.04 });
      b.cyl('ext', 'stone', R + 0.35, R + 0.35, 1.2, 28, 0, H + 0.6, 0, hex, { open: true, jit: 0.05 });
      b.piece('ext', 'stone', invertGeo(new T.CylinderGeometry(R - 0.1, R - 0.1, 1.2, 28, 1, true)), 0, H + 0.6, 0, 0x77726a, { jit: 0.05 });
      const rg2 = new T.RingGeometry(R - 0.1, R + 0.35, 28); rg2.rotateX(-HPI); b.piece('ext', 'stone', rg2, 0, H + 1.2, 0, hex, { jit: 0.04 });
      for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; b.box('ext', 'stone', 0.8, 0.8, 0.5, Math.sin(a) * (R + 0.1), H + 1.6, Math.cos(a) * (R + 0.1), hex, { ry: a, jit: 0.05 }); }
      // platform slab (with the stair opening) = the interior's ceiling: never hidden; radial joists under it clear of the opening
      // the opening spans PI-1.4 … PI+0.2: head-room over the last treads (which climb towards PI) and solid floor right after the top one
      b.piece('int', 'stone', new T.CylinderGeometry(Ri + 0.02, Ri + 0.02, 0.3, 28, 1, false, PI + 0.2, TAU - 1.6), 0, H - 0.15, 0, 0x7d786f, { jit: 0.04 });
      for (const ja of [0, 0.7, -0.7, 1.4, 2.1, -2.3]) b.box('int', 'wood', 0.14, 0.16, Ri - 0.7, Math.sin(ja) * (Ri / 2 + 0.3), H - 0.38, Math.cos(ja) * (Ri / 2 + 0.3), 0x4a3220, { ry: ja, jit: 0.03 });
      for (let i = 0; i < 16; i++) { const a0 = (i / 16) * TAU, a1 = ((i + 1) / 16) * TAU, am = (a0 + a1) / 2; const d = Math.atan2(Math.sin(am - PI), Math.cos(am - PI)); if (d > -1.4 && d < 0.2) continue; b.at(0, 0, am); b.boxCol(-0.6, H - 0.3, 0.55, 0.6, H, Ri + 0.1, true, 0.6); b.end(); }
      b.boxCol(-0.9, H - 0.3, -0.9, 0.9, H, 0.9, true);
      b.cyl('ext', 'wood', 0.05, 0.06, 3.2, 6, 0, H + 1.6, 0, 0x4a3220); b.at(0.55, 0, 0, H + 3.0); b.plane('ext', 'cloth', 1.1, 0.7, 0, -0.35, 0, [0x8c2e2a, 0x3c5c8c, 0x3e6a44][v], { ry: HPI, jit: 0.03 }); b.end();
      F.lantern(b, 'ext', 0, H + 1.25, R - 0.4, { scale: 0.8, intensity: 16 });
      // interior floor + spiral stair around a central column
      b.cyl('int', 'stone', Ri + 0.05, Ri + 0.05, 0.12, 28, 0, -0.01, 0, 0x6a655e, { jit: 0.05 }); b.boxCol(-Ri, -0.13, -Ri, Ri, 0.05, Ri, true);
      b.cyl('int', 'stone', 0.55, 0.6, H, 12, 0, H / 2, 0, 0x6e6a64, { jit: 0.05 }); b.cylCol(0, 0, 0.6, H);
      // spiral stair: 32 treads × 0.29 m rise; each tread's collider is a row of 0.3 m oriented cells (tight at any
      // angle) — two treads ahead is still within the step-up height, so the flight is walkable all the way round
      const N = 32, rise = (H - 0.3) / N, a0 = PI + 0.75, sweep = TAU * 0.92, rc = (Ri + 0.6) / 2 - 0.05, rw = Ri - 0.6 - 0.05;
      for (let i = 0; i < N; i++) {
        const a = a0 + (i / N) * sweep, y = (i + 1) * rise, sx = Math.sin(a) * rc, sz = Math.cos(a) * rc;
        b.box('int', 'stone', rw, 0.18, 0.62, sx, y - 0.09, sz, 0x8a857b, { ry: a + HPI, jit: 0.05 });
        b.at(sx, sz, a + HPI, y); b.boxCol(-rw / 2, -0.18, -0.15, rw / 2, 0, 0.15, true, 0.3); b.end();
      }
      b.at(1.5, 0.6, 0); F.crate(b, 'int', 0.7); b.end(); b.at(-1.2, 1.4, 0); F.barrel(b, 'int', 0.3, 0.8); b.end();
      F.lantern(b, 'int', -1.6, 2.2, -1.2, { scale: 0.8, intensity: 14, hook: true });
      b.ringCol(0, 0, (R + Ri) / 2, H, 16, 0, 1.5);
      b.interior(-Ri, -0.5, -R, Ri, H - 0.35, Ri);
      b.spot(0, 1.4, 0, 'idle'); b.spot(0.8, -1.2, 0, 'watch', H);
    },
  });

  /* ---------------- ruin_wall ---------------- */
  def('ruin_wall', {
    static: true,
    key(spec, v) { return 'ruin_wall:' + v + ':' + Math.round((spec.len || 7) * 2); },
    build(b, v, spec) {
      const L = spec.len || 7, hMax = 2.2 + v * 0.6, r = b.rng, hex = 0x8a8878;
      b.box('ext', 'stone', L, 2.0, 0.85, 0, 0.0, 0, 0x7f8a6e, { jit: 0.07 });
      let x = -L / 2;
      while (x < L / 2) {
        const w = Math.min(0.55 + r() * 0.7, L / 2 - x);
        const h = r() < 0.15 ? 0.2 + r() * 0.3 : 0.6 + r() * (hMax - 0.6);
        b.box('ext', 'stone', w, h, 0.8, x + w / 2, 1.0 + h / 2, 0, hex, { jit: 0.08 });
        x += w;
      }
      for (let i = 0; i < 6; i++) b.box('ext', 'rock', 0.3 + r() * 0.4, 0.2 + r() * 0.3, 0.3 + r() * 0.3, (r() - 0.5) * L, 0.1, (r() < 0.5 ? -1 : 1) * (0.6 + r() * 0.6), 0x7d7873, { ry: r() * PI, jit: 0.08 });
      b.wallCol(-L / 2, 0, L / 2, 0, hMax, 0.85);
    },
  });

  /* ---------------- ruin_tower ---------------- */
  def('ruin_tower', {
    build(b, v) {
      const R = 3.0, N = 12, r = b.rng, hex = 0x85827a, gapStart = 2 + v, gapLen = 2 + (v % 2);
      for (let i = 0; i < N; i++) {
        if (i >= gapStart && i < gapStart + gapLen) continue;
        const a = (i + 0.5) / N * TAU, h = (i === 0 || i === N - 1) ? 2.4 : 2.5 + r() * 5.0, chord = 2 * R * Math.sin(PI / N) + 0.08;
        b.box('ext', 'stone', chord, h + 1, 0.8, Math.sin(a) * R, h / 2 - 0.5, Math.cos(a) * R, hex, { ry: a, jit: 0.07 });
        b.box('ext', 'stone', chord, 0.5, 0.86, Math.sin(a) * R, 0.25, Math.cos(a) * R, 0x7a8468, { ry: a, jit: 0.06 });
        b.wallCol(Math.sin(a - PI / N) * R, Math.cos(a - PI / N) * R, Math.sin(a + PI / N) * R, Math.cos(a + PI / N) * R, h, 0.8);
      }
      b.cyl('ext', 'stone', R - 0.3, R - 0.3, 0.14, 16, 0, 0.02, 0, 0x74706a, { jit: 0.06 });
      for (let i = 0; i < 10; i++) b.box('ext', 'rock', 0.4 + r() * 0.6, 0.3 + r() * 0.4, 0.4 + r() * 0.5, (r() - 0.5) * 9, 0.15, (r() - 0.5) * 9, 0x7d7873, { ry: r() * PI, rx: (r() - 0.5) * 0.3, jit: 0.08 });
      const a = (gapStart + gapLen / 2) / N * TAU;
      b.box('ext', 'stone', 1.6, 0.9, 0.9, Math.sin(a) * (R + 0.6), 0.45, Math.cos(a) * (R + 0.6), hex, { ry: a + 0.4, rx: 0.2, jit: 0.07 });
      b.box('ext', 'rock', 1.0, 0.6, 0.9, Math.sin(a) * (R - 0.8), 0.3, Math.cos(a) * (R - 0.8), 0x7d7873, { ry: a - 0.3, jit: 0.07 });
      b.spot(0, 0, 0, 'idle');
    },
  });

  /* ---------------- barrow ---------------- */
  def('barrow', {
    enterable: true, variants: 2,
    build(b, v) {
      const RX = 8.6, RY = 4.4, RZ = 8.2, MZ = 1.4, zf = -3.4, cave = v === 1;
      const mg = domeGeo(1, 36, 18); mg.scale(RX, RY, RZ);
      const mp = mg.attributes.position, mn = mg.attributes.normal, zc = zf - MZ + 0.2;
      const flat = new Uint8Array(mp.count);
      for (let i = 0; i < mp.count; i++) if (mp.getZ(i) < zc) { mp.setZ(i, zc); mn.setXYZ(i, 0, 0, -1); flat[i] = (Math.abs(mp.getX(i)) < 1.8 && mp.getY(i) < 3.3) ? 2 : 1; }
      const idx = mg.index.array, keep = [];
      for (let i = 0; i < idx.length; i += 3) { const a = idx[i], b2 = idx[i + 1], c = idx[i + 2]; if (flat[a] && flat[b2] && flat[c] && (flat[a] === 2 || flat[b2] === 2 || flat[c] === 2)) continue; keep.push(a, b2, c); }
      mg.setIndex(keep);
      b.piece('roof', cave ? 'rock' : 'grass', mg, 0, -0.3, MZ, cave ? 0x6f6a64 : 0x62884a, { jit: 0.06, faceJit: false });
      b.cyl('roof', cave ? 'rock' : 'grass', RX * 1.02, RX * 1.05, 1.0, 28, 0, -0.55, MZ, cave ? 0x6f6a64 : 0x5f8447, { sz: RZ / RX, jit: 0.05 });
      // portal: standing stones + lintel, dark passage, crypt
      for (const sx of [-1, 1]) b.box('ext', 'rock', 0.9, 3.0, 1.0, sx * 1.5, 1.2, zf - 0.3, 0x6a665f, { jit: 0.08, rz: sx * 0.03 });
      b.box('ext', 'rock', 4.2, 0.7, 1.2, 0, 2.95, zf - 0.3, 0x6a665f, { jit: 0.08 });
      b.box('int', 'stone', 0.3, 2.5, 3.6, -1.1, 1.25, zf + 1.7, 0x2a2725, { jit: 0.05 }); b.box('int', 'stone', 0.3, 2.5, 3.6, 1.1, 1.25, zf + 1.7, 0x2a2725, { jit: 0.05 });
      b.box('int', 'stone', 2.5, 0.3, 3.6, 0, 2.6, zf + 1.7, 0x2a2725, { jit: 0.05 }); b.boxCol(-1.25, 2.45, zf - 0.1, 1.25, 2.75, zf + 3.5, false, 2);   // passage ceiling
      b.box('int', 'stone', 2.2, 0.12, 3.6, 0, -0.01, zf + 1.7, 0x4e4a46, { jit: 0.06 });
      for (const sx of [-1, 1]) b.wallCol(sx * 0.95, zf - 0.6, sx * 0.95, zf + 3.5, 2.5, 0.3);
      const CX = 3.0, CZ0 = zf + 3.5, CZ1 = CZ0 + 5.2, CH = 2.6;
      b.box('int', 'stone', 0.4, CH, CZ1 - CZ0, -CX, CH / 2, (CZ0 + CZ1) / 2, 0x4a4744, { jit: 0.07 }); b.box('int', 'stone', 0.4, CH, CZ1 - CZ0, CX, CH / 2, (CZ0 + CZ1) / 2, 0x4a4744, { jit: 0.07 });
      b.box('int', 'stone', 2 * CX + 0.4, CH, 0.4, 0, CH / 2, CZ1, 0x4a4744, { jit: 0.07 });
      for (const sx of [-1, 1]) b.box('int', 'stone', CX - 1.1 + 0.2, CH, 0.4, sx * (1.1 + (CX - 1.1) / 2), CH / 2, CZ0, 0x4a4744, { jit: 0.07 });
      b.box('int', 'stone', 2 * CX + 0.4, 0.4, CZ1 - CZ0 + 0.4, 0, CH + 0.2, (CZ0 + CZ1) / 2, 0x3e3b38, { jit: 0.06 }); b.boxCol(-CX, CH, CZ0, CX, CH + 0.4, CZ1, false, 3);   // crypt ceiling
      b.floor(-CX, CZ0, CX, CZ1, 0.05, 'stone', 0x55514c);
      b.wallCol(-CX, CZ0, -CX, CZ1, CH, 0.4); b.wallCol(CX, CZ0, CX, CZ1, CH, 0.4); b.wallCol(-CX, CZ1, CX, CZ1, CH, 0.4); b.wallCol(-CX, CZ0, -1.1, CZ0, CH, 0.4); b.wallCol(1.1, CZ0, CX, CZ0, CH, 0.4);
      b.at(0, (CZ0 + CZ1) / 2 + 0.4, 0); F.coffin(b, 'int'); b.end(); b.boxCol(-0.75, 0, (CZ0 + CZ1) / 2 - 1.0, 0.75, 1.3, (CZ0 + CZ1) / 2 + 1.8);
      for (const sx of [-1, 1]) { b.lathe('int', 'flat', [[0.1, 0], [0.25, 0.05], [0.3, 0.4], [0.2, 0.6], [0.22, 0.7]], 10, sx * 2.4, 0.05, CZ1 - 0.6, 0x6a5a4a, { jit: 0.05 }); b.box('int', 'rock', 0.6, 0.5, 0.6, sx * 2.4, 0.3, CZ0 + 1.0, 0x5a5650, { jit: 0.07 }); F.candle(b, 'int', sx * 2.4, 0.56, CZ0 + 1.0); }
      b.at(CX - 0.7, CZ1 - 0.9, HPI); F.chest(b, 'int', 0x4a3a2a); b.end();
      b.at(-CX + 0.5, CZ0 + 3.5, -HPI); stoneBench(b, 'int', 1.6, 0x5a5650); b.end();
      for (let i = 0; i < 4; i++) b.box('int', 'flat', 0.7, 0.06, 0.6, (b.rng() - 0.5) * 4, 0.08, CZ0 + 1 + b.rng() * 3.5, 0x2a2622, { ry: b.rng() * PI, jit: 0.1 });
      b.light(0, 1.8, (CZ0 + CZ1) / 2, { kind: 'elf', color: 0x86a0c8, intensity: 12, dist: 10, flicker: true, interior: true });
      for (let i = 0; i < 5; i++) { const a = 0.6 + i * 1.05, rr = 10.5 + (i % 2) * 1.4; b.at(Math.sin(a) * rr, MZ + Math.cos(a) * rr, a); menhir(b, 'ext', 2.2 + (i % 3) * 0.5, 0x746f68); b.end(); b.cylCol(Math.sin(a) * rr, MZ + Math.cos(a) * rr, 0.6, 2.5); }
      for (let i = 0; i < 18; i++) { const a0 = i / 18 * TAU, a1 = (i + 1) / 18 * TAU; const p0 = { x: Math.sin(a0) * RX * 0.96, z: MZ + Math.cos(a0) * RZ * 0.96 }, p1 = { x: Math.sin(a1) * RX * 0.96, z: MZ + Math.cos(a1) * RZ * 0.96 }; if (p0.z < zf + 0.6 || p1.z < zf + 0.6) continue; b.wallCol(p0.x, p0.z, p1.x, p1.z, 2.4, 0.4); }
      b.wallCol(-RX, zf, -1.1, zf, 3, 0.5); b.wallCol(1.1, zf, RX, zf, 3, 0.5);
      b.interior(-CX, -0.5, zf - 0.5, CX, CH + 0.5, CZ1);
      b.spot(0, CZ0 + 1.2, PI, 'idle');
    },
  });

  /* ---------------- dock ---------------- */
  def('dock', {
    key(spec, v) { return 'dock:' + v + ':' + Math.round((spec.len || 14) / 2) + ':' + Math.round((spec.deckLocal === undefined ? 0.6 : spec.deckLocal) * 4); },
    build(b, v, spec) {
      const L = spec.len || 14, W = 3.2, dy = spec.deckLocal === undefined ? 0.6 : spec.deckLocal, hex = [0x7a5a3a, 0x6e5238, 0x86643f][v];
      b.box('ext', 'planks', W, 0.12, L + 1.0, 0, dy - 0.06, -L / 2 + 0.5, hex, { jit: 0.05 });
      b.boxCol(-W / 2, dy - 0.3, -L, W / 2, dy, 1.0, true);
      for (const sx of [-1, 1]) b.box('ext', 'wood', 0.18, 0.22, L + 1.0, sx * (W / 2 - 0.09), dy - 0.22, -L / 2 + 0.5, 0x4a3320, { jit: 0.05 });
      const np = Math.max(2, Math.round(L / 2.6));
      for (let i = 0; i <= np; i++) {
        const z = -L + (L / np) * i + 0.2;
        for (const sx of [-1, 1]) { const tall = (i === 0 || i % 2 === 0); b.cyl('ext', 'wood', 0.15, 0.17, 4.2 + (tall ? 1.0 : 0), 8, sx * (W / 2 + 0.05), dy - 2.1 + (tall ? 0.5 : 0), z, 0x4e3a28, { jit: 0.06 }); if (tall) b.cyl('ext', 'wood', 0.19, 0.16, 0.1, 8, sx * (W / 2 + 0.05), dy + 1.05, z, 0x3e2e20); }
        b.box('ext', 'wood', W + 0.3, 0.18, 0.18, 0, dy - 0.28, z, 0x4a3320, { jit: 0.05 });
      }
      for (const sx of [-1, 1]) { b.cyl('ext', 'wood', 0.16, 0.16, 0.9, 8, sx * (W / 2 - 0.35), dy + 0.45, -L + 0.6, 0x3e2e20, { jit: 0.05 }); b.cyl('ext', 'wood', 0.2, 0.2, 0.12, 8, sx * (W / 2 - 0.35), dy + 0.92, -L + 0.6, 0x3e2e20); }
      b.torus('ext', 'flat', 0.28, 0.06, 0.55, dy + 0.06, -L + 1.6, 0xb8a888, { rx: HPI, jit: 0.04 }); b.torus('ext', 'flat', 0.2, 0.05, 0.55, dy + 0.16, -L + 1.6, 0xb8a888, { rx: HPI, jit: 0.04 });
      b.at(-0.9, -L + 2.4, 0.4, dy); F.crate(b, 'ext', 0.75); b.end(); b.at(-0.9, -L + 2.4, 0.4, dy + 0.75); F.crate(b, 'ext', 0.6); b.end();
      b.at(0.9, -L + 3.6, 0, dy); F.barrel(b, 'ext', 0.3, 0.8); b.end();
      b.cyl('ext', 'wood', 0.08, 0.1, 3.3, 7, W / 2 - 0.2, dy + 1.6, -L + 0.2, 0x4a3320); b.box('ext', 'wood', 0.6, 0.06, 0.06, W / 2 - 0.45, dy + 3.15, -L + 0.2, 0x4a3320);
      F.lantern(b, 'ext', W / 2 - 0.75, dy + 2.6, -L + 0.2, { scale: 0.9, intensity: 24, hook: true, chain: 0.1 });
      for (const sx of [-1, 1]) b.box('ext', 'wood', 0.06, 2.4, 0.06, W / 2 + 0.15, dy - 0.9, -L + 1.0 + sx * 0.2, 0x4a3320); for (let i = 0; i < 5; i++) b.box('ext', 'wood', 0.06, 0.05, 0.46, W / 2 + 0.15, dy - 0.05 - i * 0.45, -L + 1.0, 0x4a3320);
      b.box('ext', 'planks', W + 1.4, 0.12, 1.6, 0, dy * 0.5 - 0.06, 1.4, hex, { rx: Math.atan2(dy, 1.6), jit: 0.05 }); b.boxCol(-W / 2 - 0.7, dy * 0.5 - 0.35, 0.6, W / 2 + 0.7, dy * 0.5 + 0.05, 2.2, true);
      b.spot(0, -L + 2.2, PI, 'boatmaster', dy); b.spot(0, -L - 2.5, 0, 'boat', dy);
    },
  });

  /* ---------------- bridge ---------------- */
  def('bridge', {
    key(spec, v) { return 'bridge:' + v + ':' + Math.round((spec.len || 24) / 2); },
    build(b, v, spec) {
      const L = spec.len || 24, W = 5.2, rise = Math.min(1.5, L * 0.06), N = 16, hex = [0x8f8a82, 0x7f7b76, 0x968f84][v];
      const arc = z => 0.25 + rise * (1 - Math.pow(2 * z / L, 2));
      const sh = new T.Shape(); sh.moveTo(-L / 2, -3.5); sh.lineTo(L / 2, -3.5); sh.lineTo(L / 2, arc(L / 2));
      for (let i = N; i >= 0; i--) { const z = -L / 2 + (L / N) * i; sh.lineTo(z, arc(z)); }
      sh.closePath();
      const hole = new T.Path(); hole.absellipse(0, -0.9, L * 0.33, Math.min(2.2, L * 0.1), 0, TAU, false); sh.holes.push(hole);
      const g = new T.ExtrudeGeometry(sh, { depth: W, bevelEnabled: false, curveSegments: 12 }); g.translate(0, 0, -W / 2); g.rotateY(HPI);
      b.piece('ext', 'stone', g, 0, 0, 0, hex, { jit: 0.04, faceJit: false });
      for (const sx of [-1, 1]) {
        const ps = new T.Shape(); ps.moveTo(-L / 2 - 0.3, arc(L / 2) - 0.4);
        for (let i = 0; i <= N; i++) { const z = -L / 2 + (L / N) * i; ps.lineTo(z, arc(z) + 1.05); }
        ps.lineTo(L / 2 + 0.3, arc(L / 2) - 0.4); ps.closePath();
        const pg = new T.ExtrudeGeometry(ps, { depth: 0.42, bevelEnabled: false }); pg.translate(0, 0, -0.21); pg.rotateY(HPI);
        b.piece('ext', 'stone', pg, sx * (W / 2 - 0.21), 0, 0, 0x847f77, { jit: 0.05, faceJit: false });
        b.box('ext', 'stone', 0.9, 1.6, 0.9, sx * (W / 2 - 0.2), arc(L / 2) + 0.55, -L / 2 - 0.1, 0x7a756e, { jit: 0.05 }); b.box('ext', 'stone', 0.9, 1.6, 0.9, sx * (W / 2 - 0.2), arc(L / 2) + 0.55, L / 2 + 0.1, 0x7a756e, { jit: 0.05 });
        if (v === 1) { F.lantern(b, 'ext', sx * (W / 2 - 0.2), arc(L / 2) + 1.4, -L / 2 - 0.1, { scale: 0.8, intensity: 16 }); F.lantern(b, 'ext', sx * (W / 2 - 0.2), arc(L / 2) + 1.4, L / 2 + 0.1, { scale: 0.8, intensity: 16 }); }
      }
      for (let i = 0; i < N; i++) {
        const z0 = -L / 2 + (L / N) * i, z1 = z0 + L / N, zm = (z0 + z1) / 2, y = arc(zm);
        b.box('ext', 'stone', W - 0.9, 0.1, L / N + 0.05, 0, y + 0.02, zm, 0x7c776f, { rx: -Math.atan2(arc(z1) - arc(z0), L / N), jit: 0.05 });
        b.boxCol(-W / 2 + 0.45, y - 1.5, z0, W / 2 - 0.45, y + 0.05, z1, true);
        for (const sx of [-1, 1]) b.boxCol(sx * (W / 2 - 0.42) - 0.21, y - 0.5, z0, sx * (W / 2 - 0.42) + 0.21, y + 1.1, z1);
      }
      for (const sz of [-1, 1]) b.box('ext', 'stone', W + 0.3, 3.0, 1.6, 0, -1.6, sz * (L * 0.33 + 0.9), 0x6f6a64, { jit: 0.05 });
    },
  });

  /* ---------------- wall_segment ---------------- */
  def('wall_segment', {
    static: true, variants: 2, styleVariant(style, v) { return style === 'camp' ? 1 : 0; },
    key(spec, v) { return 'wall_segment:' + v + ':' + Math.round((spec.len || 12) * 2); },
    build(b, v, spec) {
      const L = spec.len || 12;
      if (v === 1) {
        const n = Math.round(L / 0.38);
        for (let i = 0; i <= n; i++) { const x = -L / 2 + (L / n) * i, h = 3.8 + (b.rng() - 0.5) * 0.4; b.cyl('ext', 'wood', 0.19, 0.2, h + 0.6, 7, x, h / 2 - 0.3, 0, 0x5e4128, { jit: 0.08 }); b.cone('ext', 'wood', 0.19, 0.45, 7, x, h + 0.22, 0, 0x4a3220, { jit: 0.06 }); }
        b.box('ext', 'wood', L + 0.2, 0.18, 0.12, 0, 1.3, 0.24, 0x4a3220); b.box('ext', 'wood', L + 0.2, 0.18, 0.12, 0, 3.0, 0.24, 0x4a3220);
        b.wallCol(-L / 2, 0, L / 2, 0, 4.0, 0.4);
      } else {
        b.box('ext', 'stone', L + 0.15, 5.6, 1.2, 0, 1.8, 0, 0x8a857b, { jit: 0.06 });
        b.box('ext', 'stone', L + 0.3, 1.2, 1.4, 0, -0.2, 0, 0x7a756d, { jit: 0.06 });
        b.box('ext', 'stone', L + 0.15, 0.25, 1.35, 0, 4.7, 0, 0x7d786f, { jit: 0.05 });
        const n = Math.max(1, Math.round(L / 1.5));
        for (let i = 0; i <= n; i++) { const x = -L / 2 + (L / n) * i; if (Math.abs(x) > L / 2 - 0.3) continue; b.box('ext', 'stone', 0.7, 0.85, 0.5, x, 5.2, -0.35, 0x8a857b, { jit: 0.06 }); }
        b.box('ext', 'planks', L, 0.1, 0.6, 0, 4.82, 0.3, 0x7a5a3a, { jit: 0.05 });
        b.wallCol(-L / 2, 0, L / 2, 0, 5.4, 1.2);
      }
    },
  });

  /* ---------------- gate ---------------- */
  def('gate', {
    variants: 2,
    build(b, v) {
      const OP = 6.4, TW = 3.2, TH = 9.0, hex = 0x8a857b;
      const g = wallGeo(OP + TW * 2 + 0.2, 7.6, 1.5, [{ s: 0, y: 0, w: OP, h: 7.0, arch: true }], 0, 1.0);
      b.piece('ext', 'stone', g, 0, 0, 0, hex, { jit: 0.04, faceJit: false });
      for (const sx of [-1, 1]) {
        const tx = sx * (OP / 2 + TW / 2);
        b.box('ext', 'stone', TW, TH + 1, TW, tx, TH / 2 - 0.5, 0, hex, { jit: 0.06 });
        b.box('ext', 'stone', TW + 0.5, 0.35, TW + 0.5, tx, TH + 0.1, 0, 0x7d786f, { jit: 0.05 });
        for (let i = 0; i < 4; i++) { const a = i * HPI; b.box('ext', 'stone', 0.7, 0.8, 0.5, tx + Math.sin(a) * (TW / 2 + 0.05), TH + 0.65, Math.cos(a) * (TW / 2 + 0.05), hex, { ry: a, jit: 0.05 }); b.box('ext', 'stone', 0.7, 0.8, 0.5, tx + Math.sin(a + PI / 4) * (TW / 2 + 0.25), TH + 0.65, Math.cos(a + PI / 4) * (TW / 2 + 0.25), hex, { ry: a + PI / 4, jit: 0.05 }); }
        if (v === 1) b.cone('roof', 'tile', TW * 0.85, 2.6, 4, tx, TH + 1.6, 0, TILES[1], { ry: PI / 4, jit: 0.04 });
        b.at(tx, -TW / 2 - 0.05, 0, 5.0); F.banner(b, 'ext', 1.2, 2.6, [0x8c2e2a, 0x3c5c8c][v], 0xd8c060); b.end();
        F.lantern(b, 'ext', sx * (OP / 2 + 0.2), 4.2, -TW / 2 - 0.3, { scale: 0.9, intensity: 22 }); b.box('ext', 'metal', 0.05, 0.05, 0.5, sx * (OP / 2 + 0.2), 4.65, -TW / 2 - 0.1, 0x2c2c30);
        b.wallCol(tx - TW / 2, -TW / 2, tx + TW / 2, -TW / 2, TH, 0.3); b.wallCol(tx - TW / 2, TW / 2, tx + TW / 2, TW / 2, TH, 0.3); b.wallCol(tx - sx * TW / 2, -TW / 2, tx - sx * TW / 2, TW / 2, TH, 0.3); b.wallCol(tx + sx * TW / 2, -TW / 2, tx + sx * TW / 2, TW / 2, TH, 0.3);
        // open gate leaf against the inner tower face
        b.at(sx * (OP / 2 - 0.1), 0.75, sx * 1.75);
        b.box('ext', 'wood', 0.12, 5.6, OP / 2 - 0.2, 0, 2.85, (OP / 2 - 0.2) / 2, 0x4a3220, { jit: 0.05 });
        for (const y of [1.0, 2.9, 4.8]) b.box('ext', 'metal', 0.16, 0.14, OP / 2 - 0.1, 0, y, (OP / 2 - 0.2) / 2, 0x2c2c30);
        b.end();
      }
      for (let i = 0; i < 8; i++) b.box('ext', 'metal', 0.09, 1.6, 0.09, -OP / 2 + 0.55 + i * (OP - 1.1) / 7, 6.2, -0.5, 0x2c2c30);
      b.box('ext', 'metal', OP - 0.9, 0.09, 0.09, 0, 5.6, -0.5, 0x2c2c30); b.box('ext', 'metal', OP - 0.9, 0.09, 0.09, 0, 6.5, -0.5, 0x2c2c30);
      b.box('ext', 'stone', OP + 1, 0.16, 5, 0, -0.02, 0, 0x7a756d, { jit: 0.05 });
    },
  });

  /* ---------------- fence ---------------- */
  def('fence', {
    static: true, styleVariant(style, v) { return style === 'hobbit' ? 1 : (style === 'dwarf' || style === 'ruin' || style === 'lossoth') ? 2 : v === 1 ? 0 : v; },
    key(spec, v) { return 'fence:' + v + ':' + Math.round((spec.len || 6) * 2); },
    build(b, v, spec) {
      const L = spec.len || 6;
      if (v === 2) { b.box('ext', 'rock', L, 1.3, 0.55, 0, 0.35, 0, 0x8a857b, { jit: 0.09 }); b.box('ext', 'rock', L + 0.1, 0.16, 0.65, 0, 1.03, 0, 0x7d786f, { jit: 0.07 }); b.wallCol(-L / 2, 0, L / 2, 0, 1.1, 0.55); return; }
      const n = Math.max(1, Math.round(L / 2));
      for (let i = 0; i <= n; i++) b.box('ext', 'wood', 0.13, 1.5, 0.13, -L / 2 + (L / n) * i, 0.35, 0, 0x6b4a2a, { jit: 0.06 });
      if (v === 1) { const m = Math.round(L / 0.22); for (let i = 0; i <= m; i++) { const x = -L / 2 + (L / m) * i; b.box('ext', 'wood', 0.09, 1.0, 0.03, x, 0.55, -0.08, 0xd8d0c0, { jit: 0.05 }); b.cone('ext', 'wood', 0.065, 0.1, 4, x, 1.09, -0.08, 0xd8d0c0, { ry: PI / 4 }); } b.box('ext', 'wood', L, 0.06, 0.04, 0, 0.35, -0.05, 0xd8d0c0); b.box('ext', 'wood', L, 0.06, 0.04, 0, 0.85, -0.05, 0xd8d0c0); }
      else { b.box('ext', 'wood', L, 0.09, 0.05, 0, 0.5, 0, 0x7d5a35, { jit: 0.05 }); b.box('ext', 'wood', L, 0.09, 0.05, 0, 0.95, 0, 0x7d5a35, { jit: 0.05 }); }
      b.wallCol(-L / 2, 0, L / 2, 0, 1.0, 0.2);
    },
  });

  /* ---------------- well ---------------- */
  def('well', {
    static: true,
    build(b, v) {
      const hex = [0x8d8579, 0x7f7a72, 0x968f84][v];
      b.cyl('ext', 'stone', 1.05, 1.1, 1.0, 16, 0, 0.5, 0, hex, { jit: 0.07 });
      b.piece('ext', 'stone', invertGeo(new T.CylinderGeometry(0.85, 0.85, 1.4, 16, 1, true)), 0, 0.3, 0, 0x3a3835, { jit: 0.05 });
      b.cyl('ext', 'water', 0.85, 0.85, 0.02, 16, 0, 0.3, 0, 0x2c4c62, { jit: 0.02 });
      b.torus('ext', 'stone', 0.95, 0.1, 0, 1.0, 0, 0x7d786f, { rx: HPI, jit: 0.05 });
      for (const sx of [-1, 1]) b.box('ext', 'wood', 0.14, 2.4, 0.14, sx * 1.0, 1.2, 0, 0x5a3c25, { jit: 0.05 });
      b.cyl('ext', 'wood', 0.07, 0.07, 2.3, 8, 0, 1.95, 0, 0x4a3220, { rz: HPI });
      b.box('ext', 'wood', 0.06, 0.4, 0.06, 1.2, 2.1, 0, 0x4a3220); b.box('ext', 'wood', 0.06, 0.06, 0.3, 1.2, 2.28, 0.15, 0x4a3220);
      b.cyl('ext', 'flat', 0.015, 0.015, 1.1, 4, 0, 1.4, 0, 0xb8a888); b.lathe('ext', 'wood', [[0.09, 0], [0.13, 0.02], [0.15, 0.22], [0.14, 0.24]], 10, 0, 0.75, 0, 0x5a3c25, { jit: 0.05 }); b.torus('ext', 'metal', 0.14, 0.012, 0, 0.98, 0, 0x3a3a40, { ry: HPI });
      b.piece('ext', v === 1 ? 'tile' : 'thatch', chevronRoofGeo(2.2, 2.5, 3.05, 0.12, 1.9), 0, 0, 0, v === 1 ? TILES[0] : THATCHES[0], { ry: -HPI, jit: 0.04, faceJit: false });
      b.box('ext', 'wood', 2.3, 0.1, 0.1, 0, 2.45, 0, 0x4a3220);
      b.cylCol(0, 0, 1.15, 1.0);
    },
  });

  /* ---------------- campfire ---------------- */
  def('campfire', {
    static: true,
    build(b, v) {
      for (let i = 0; i < 9; i++) { const a = i / 9 * TAU + (b.rng() - 0.5) * 0.3; b.sph('ext', 'rock', 0.2 + b.rng() * 0.08, Math.sin(a) * 0.75, 0.1, Math.cos(a) * 0.75, 0x7d7873, { sy: 0.65, jit: 0.1 }); }
      for (let i = 0; i < 4; i++) { const a = i * HPI + 0.4; b.cyl('ext', 'wood', 0.08, 0.1, 1.0, 7, Math.sin(a) * 0.25, 0.28, Math.cos(a) * 0.25, 0x4a3320, { rz: 0.45, ry: a + HPI, jit: 0.08 }); }
      b.sph('ext', 'ember', 0.32, 0, 0.12, 0, 0xff7a20, { sy: 0.4, jit: 0.25 });
      b.light(0, 0.9, 0, { kind: 'fire', color: 0xffa040, intensity: 36, dist: 12 }); b.hearth(0, 0.3, 0, 1.1);
      for (let i = 0; i < 3; i++) { const a = 0.5 + i * 2.1; b.at(Math.sin(a) * 1.8, Math.cos(a) * 1.8, a); woodLog(b, 'ext', 1.5, 0.2, 0x5e4128); b.end(); b.spot(Math.sin(a) * 1.35, Math.cos(a) * 1.35, a + PI, 'sit'); }
      if (v === 1) { for (let i = 0; i < 3; i++) { const a = i * TAU / 3; b.cyl('ext', 'wood', 0.03, 0.035, 1.8, 5, Math.sin(a) * 0.45, 0.85, Math.cos(a) * 0.45, 0x4a3320, { rz: Math.cos(a) * 0.5, rx: -Math.sin(a) * 0.5 }); } b.cyl('ext', 'metal', 0.012, 0.012, 0.5, 4, 0, 1.4, 0, 0x2a2a2e); b.lathe('ext', 'metal', [[0.05, 0], [0.19, 0.04], [0.21, 0.24], [0.17, 0.3]], 10, 0, 0.9, 0, 0x2b2b2f); }
      if (v === 2) { b.at(1.5, -1.3, 0.3); F.crate(b, 'ext', 0.6); b.end(); b.at(-1.4, -1.5, 0); F.sack(b, 'ext'); b.end(); }
      b.cylCol(0, 0, 0.6, 0.5);
    },
  });

  /* ---------------- market_stall ---------------- */
  def('market_stall', {
    static: true,
    build(b, v) {
      b.box('ext', 'wood', 2.6, 0.08, 1.1, 0, 0.96, 0, WOOD_F, { jit: 0.04 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('ext', 'wood', 0.1, 0.92, 0.1, sx * 1.2, 0.46, sz * 0.45, WOOD_D);
      b.plane('ext', 'awning', 2.5, 0.85, 0, 0.5, -0.56, 0xffffff, { jit: 0 }); b.plane('ext', 'awning', 1.0, 0.85, -1.3, 0.5, 0, 0xffffff, { ry: -HPI, jit: 0 }); b.plane('ext', 'awning', 1.0, 0.85, 1.3, 0.5, 0, 0xffffff, { ry: HPI, jit: 0 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box('ext', 'wood', 0.08, 2.5 + (sz < 0 ? 0.3 : 0), 0.08, sx * 1.3, 1.25 + (sz < 0 ? 0.15 : 0), sz * 0.65, 0x4a3220);
      b.plane('ext', 'awning', 3.0, 1.7, 0, 2.55, -0.05, 0xffffff, { rx: -HPI + 0.28, jit: 0 });
      b.box('ext', 'wood', 2.9, 0.08, 0.08, 0, 2.78, -0.7, 0x4a3220); b.box('ext', 'wood', 2.9, 0.08, 0.08, 0, 2.35, 0.75, 0x4a3220);
      if (v === 0) { for (let i = 0; i < 2; i++) { b.at(-0.7 + i * 1.4, 0, 0, 1.0); b.box('ext', 'wood', 0.9, 0.25, 0.6, 0, 0.12, 0, 0x9a7048); for (let k = 0; k < 8; k++) b.sph('ext', 'flat', 0.08, -0.32 + (k % 4) * 0.21, 0.28, -0.14 + Math.floor(k / 4) * 0.28, i ? [0x8ab040, 0x6a9a30][k % 2] : [0xc83a2a, 0xe05a30][k % 2], { jit: 0.06 }); b.end(); } b.sph('ext', 'flat', 0.22, 0, 1.2, 0.1, 0xe08a30, { sy: 0.7, jit: 0.05 }); }
      else if (v === 1) { for (let i = 0; i < 5; i++) b.cyl('ext', 'flat', 0.1, 0.1, 0.9, 8, -0.9 + i * 0.45, 1.1, 0.05 + (i % 2) * 0.1, [0x8a2a2a, 0x2a4a8a, 0x5a7a2a, 0xe8dcc8, 0x6a3a7a][i], { rz: HPI, jit: 0.04 }); b.box('ext', 'flat', 0.5, 0.5, 0.5, 0.9, 1.25, -0.1, 0xd8c8a0, { jit: 0.04 }); }
      else { for (let i = 0; i < 5; i++) b.lathe('ext', 'flat', [[0.02, 0], [0.09, 0.02], [0.11, 0.14], [0.07, 0.24], [0.08, 0.28]], 10, -0.9 + i * 0.45, 1.0, 0.1 - (i % 2) * 0.3, [0xb8865a, 0xd9c9a8, 0x8a7a6a][i % 3], { jit: 0.04 }); b.cyl('ext', 'flat', 0.16, 0.16, 0.02, 12, 0.6, 1.0, -0.3, 0xece4d2); }
      b.at(1.9, 0.3, 0); F.barrel(b, 'ext', 0.3, 0.8); b.end(); b.at(-1.9, 0.2, 0); F.sack(b, 'ext'); b.end();
      b.boxCol(-1.3, 0, -0.6, 1.3, 1.0, 0.6);
      b.spot(0, 1.1, 0, 'vendor');
    },
  });

  /* ---------------- stable ---------------- */
  def('stable', {
    enterable: true,
    build(b, v) {
      const W = 8.4, D = 6.4, H = 3.2, peak = 4.9;
      for (const sx of [-1, 1]) for (const pz of [-D / 2 + 0.2, 0, D / 2 - 0.2]) { b.box('ext', 'wood', 0.3, H + 0.6, 0.3, sx * (W / 2 - 0.15), H / 2 - 0.3, pz, 0x5a3c25, { jit: 0.05 }); b.cylCol(sx * (W / 2 - 0.15), pz, 0.22, H); }
      b.box('ext', 'planks', W, H + 0.8, 0.16, 0, H / 2 - 0.4, D / 2 - 0.08, 0x8a6a45, { jit: 0.05 }); b.wallCol(-W / 2, D / 2 - 0.08, W / 2, D / 2 - 0.08, H, 0.16);
      for (const sx of [-1, 1]) { b.box('ext', 'planks', 0.16, 1.5 + 0.8, D - 0.3, sx * (W / 2 - 0.08), 0.75 - 0.4, 0, 0x8a6a45, { jit: 0.05 }); b.wallCol(sx * (W / 2 - 0.08), -D / 2, sx * (W / 2 - 0.08), D / 2, 1.5, 0.16); b.box('ext', 'wood', 0.2, 0.12, D, sx * (W / 2 - 0.08), 1.56, 0, 0x5a3c25); }
      b.box('ext', 'wood', W + 0.2, 0.22, 0.24, 0, H + 0.1, -D / 2 + 0.05, 0x5a3c25); b.box('ext', 'wood', W + 0.2, 0.22, 0.24, 0, H + 0.1, D / 2 - 0.05, 0x5a3c25);
      // open barn: the thatch underside + rafters are the ceiling, so they live in 'int' (never hidden) with a ceiling collider
      const g = chevronRoofGeo(D + 1.6, H - 0.1, peak, 0.42, W + 1.2); b.piece('int', 'thatch', g, 0, 0, 0, THATCHES[v], { ry: -HPI, jit: 0.04, faceJit: false });
      b.cyl('int', 'thatch', 0.2, 0.2, W + 1.3, 8, 0, peak - 0.02, 0, 0x8a6a36, { rz: HPI });
      for (let i = 0; i < 5; i++) { const x = -W / 2 + 0.5 + i * (W - 1) / 4; b.box('int', 'wood', 0.14, 0.18, D + 0.4, x, H + 0.22, 0, 0x4a3220, { jit: 0.03 }); b.box('int', 'wood', 0.14, 0.14, D / 2 + 0.6, x, H + (peak - H) / 2 + 0.05, -D / 4 - 0.1, 0x4a3220, { rx: -Math.atan2(peak - H, D / 2), jit: 0.03 }); b.box('int', 'wood', 0.14, 0.14, D / 2 + 0.6, x, H + (peak - H) / 2 + 0.05, D / 4 + 0.1, 0x4a3220, { rx: Math.atan2(peak - H, D / 2), jit: 0.03 }); }
      b.boxCol(-W / 2, H - 0.15, -D / 2, W / 2, H - 0.05, D / 2, false, 4);
      b.box('int', 'stone', W, 0.1, D, 0, 0.0, 0, 0x7a6a52, { jit: 0.06 }); b.boxCol(-W / 2, -0.12, -D / 2, W / 2, 0.05, D / 2, true);
      for (const dx of [-1.4, 1.4]) { b.box('int', 'planks', 0.12, 1.5, 3.2, dx, 0.75, D / 2 - 1.7, 0x8a6a45, { jit: 0.04 }); b.wallCol(dx, D / 2 - 3.3, dx, D / 2, 1.5, 0.12); }
      for (const tx of [-2.7, 0, 2.7]) { b.at(tx, D / 2 - 0.45, 0); F.trough(b, 'int'); b.end(); b.sph('int', 'thatch', 0.9, tx, 0.0, D / 2 - 1.6, 0xcdaa5c, { sy: 0.18, jit: 0.06 }); }
      b.at(-W / 2 + 0.9, -D / 2 + 1.0, 0.2); F.hayBale(b, 'int'); b.end(); b.at(-W / 2 + 0.9, -D / 2 + 1.0, 0.2, 0.6); F.hayBale(b, 'int'); b.end(); b.at(-W / 2 + 0.9, -D / 2 + 1.75, -0.3); F.hayBale(b, 'int'); b.end();
      b.at(-W / 2 + 0.7, 0.4, 0); F.barrel(b, 'int', 0.3, 0.8); b.end(); b.at(-W / 2 + 0.75, 1.2, 0); F.sack(b, 'int'); b.end();
      b.box('int', 'wood', 0.08, 1.6, 0.08, W / 2 - 0.5, 0.8, -D / 2 + 0.6, 0x4a3220); b.box('int', 'wood', 0.6, 0.06, 0.06, W / 2 - 0.8, 1.55, -D / 2 + 0.6, 0x4a3220);
      for (let i = 0; i < 3; i++) { b.box('int', 'metal', 0.05, 0.05, 0.3, W / 2 - 0.5, 1.2 - i * 0.35, -D / 2 + 0.6, 0x4a4a52); b.torus('int', 'flat', 0.12, 0.03, W / 2 - 0.5, 1.15 - i * 0.35, -D / 2 + 0.4, 0x5a3a2a, { rx: 0.3, jit: 0.04 }); }
      F.lantern(b, 'int', W / 2 - 0.55, 2.3, 0.2, { scale: 0.85, intensity: 16, hook: true });
      b.box('ext', 'wood', 0.14, 1.1, 0.14, -2.5, 0.55, -D / 2 - 1.4, 0x5a3c25); b.box('ext', 'wood', 0.14, 1.1, 0.14, -0.5, 0.55, -D / 2 - 1.4, 0x5a3c25); b.box('ext', 'wood', 2.2, 0.1, 0.1, -1.5, 1.05, -D / 2 - 1.4, 0x5a3c25); b.wallCol(-2.5, -D / 2 - 1.4, -0.5, -D / 2 - 1.4, 1.1, 0.14);
      b.horse(2.7, D / 2 - 1.9, 0); b.horse(-2.7, D / 2 - 1.9, 0.2);
      b.interior(-W / 2, -0.5, -D / 2, W / 2, peak + 0.5, D / 2);
      b.spot(-1.5, -D / 2 - 0.7, PI, 'keeper'); b.spot(0.4, -1.6, 0, 'idle');
    },
  });

  /* ---------------- shrine ---------------- */
  def('shrine', {
    enterable: true, styleVariant(style, v) { return style === 'elf' ? 0 : (style === 'man' || style === 'hobbit') ? 1 : v; },
    build(b, v) {
      const elf = v === 0, hex = elf ? 0xe4e6ea : 0xa8a49c;
      b.box('ext', 'stone', 3.8, 0.34, 3.8, 0, 0.17, 0, hex, { jit: 0.03 }); b.box('ext', 'stone', 4.6, 0.17, 4.6, 0, 0.085, 0, hex, { jit: 0.03 });
      b.boxCol(-2.3, 0, -2.3, 2.3, 0.17, 2.3, true); b.boxCol(-1.9, 0, -1.9, 1.9, 0.34, 1.9, true);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) { b.at(sx * 1.45, sz * 1.45, 0, 0.34); F.pillar(b, 'ext', elf ? 'elf' : 'wood', 2.9, elf ? undefined : 0x8a8478); b.end(); b.cylCol(sx * 1.45, sz * 1.45, 0.3, 3.2); }
      b.box('int', 'stone', 3.9, 0.22, 3.9, 0, 3.35, 0, hex, { jit: 0.03 }); b.boxCol(-1.95, 3.24, -1.95, 1.95, 3.46, 1.95, false, 4);   // canopy slab = ceiling, never hidden
      b.cone('roof', elf ? 'tile' : 'thatch', 2.9, 1.5, 4, 0, 4.2, 0, elf ? 0x8fa3bf : THATCHES[1], { ry: PI / 4, jit: 0.04 });
      b.sph('roof', 'metal', 0.14, 0, 4.98, 0, 0xd8b862);
      b.box('ext', 'stone', 1.4, 0.95, 0.7, 0, 0.34 + 0.475, 0.9, hex, { jit: 0.03 }); b.boxCol(-0.7, 0.34, 0.55, 0.7, 1.3, 1.25);
      b.at(0, 0.9, PI, 0.34 + 0.95); figure(b, 'ext', 0.55, elf ? 0xe4e6ea : 0x9a968e, elf ? 'robed' : 'warrior'); b.end();
      for (const x of [-0.5, -0.3, 0.3, 0.5]) F.candle(b, 'ext', x, 0.34 + 0.95, 0.62);
      b.lathe('ext', 'flat', [[0.02, 0], [0.12, 0.02], [0.15, 0.09], [0.13, 0.11]], 10, 0, 0.34 + 0.95, 0.62, 0xb59a4a); for (let i = 0; i < 4; i++) b.sph('ext', 'flat', 0.045, (i - 1.5) * 0.05, 0.34 + 1.08, 0.62, [0xc83a2a, 0x8ab040, 0xe0a030][i % 3]);
      for (const sx of [-1, 1]) { b.at(sx * 1.1, -2.9, 0); stoneBench(b, 'ext', 1.4, hex); b.end(); }
      b.light(0, 1.9, 0.5, { kind: elf ? 'elf' : 'lamp', color: elf ? 0xbfd8ff : 0xffc070, intensity: 14, dist: 9, flicker: !elf });
      b.interior(-1.9, -0.5, -1.9, 1.9, 3.3, 1.9);
      b.spot(0, -0.6, PI, 'pray', 0.34);
    },
  });

  /* ---------------- props ---------------- */
  def('lamp', {
    static: true,
    key(spec, v) { return 'lamp:' + (spec.style === 'elf' ? 'elf' : spec.style === 'dwarf' ? 'dwarf' : 'man') + ':' + v; },
    build(b, v, spec) {
      if (spec.style === 'elf') {
        b.cyl('ext', 'stone', 0.07, 0.11, 3.4, 8, 0, 1.7, 0, 0xe4e6ea, { jit: 0.02 }); b.cyl('ext', 'stone', 0.28, 0.32, 0.16, 8, 0, 0.08, 0, 0xd0d4dc, { jit: 0.02 });
        b.torus('ext', 'metal', 0.16, 0.025, 0, 3.3, 0, 0xd8b862, { rx: HPI }); F.lantern(b, 'ext', 0, 3.42, 0, { elf: true, scale: 0.9, intensity: 20 });
      } else if (spec.style === 'dwarf') {
        b.box('ext', 'metal', 0.16, 3.2, 0.16, 0, 1.6, 0, 0x3a3a40, { jit: 0.03 }); b.box('ext', 'stone', 0.6, 0.35, 0.6, 0, 0.17, 0, 0x5c5658, { jit: 0.05 });
        b.box('ext', 'metal', 0.5, 0.5, 0.05, 0, 2.5, 0, 0xb08040, { rz: PI / 4 }); F.lantern(b, 'ext', 0, 3.2, 0, { scale: 1.0, intensity: 24 });
      } else {
        b.box('ext', 'wood', 0.16, 3.4, 0.16, 0, 1.5, 0, 0x4e3a28, { jit: 0.05 }); b.box('ext', 'stone', 0.5, 0.3, 0.5, 0, 0.15, 0, 0x8d8579, { jit: 0.06 });
        b.box('ext', 'wood', 0.7, 0.1, 0.1, 0.3, 3.15, 0, 0x4e3a28); b.box('ext', 'wood', 0.1, 0.1, 0.55, 0.3, 2.9, 0, 0x4e3a28, { rz: 0.8 });
        F.lantern(b, 'ext', 0.6, 2.55, 0, { scale: 0.9, intensity: 22, chain: 0.15, hook: true });
      }
      b.cylCol(0, 0, 0.14, 2.5);
    },
  });
  def('sign', {
    static: true, variants: 2,
    build(b, v) {
      b.cyl('ext', 'wood', 0.07, 0.09, 2.4, 7, 0, 1.2, 0, 0x4e3a28, { jit: 0.05 }); b.cyl('ext', 'stone', 0.25, 0.3, 0.14, 8, 0, 0.07, 0, 0x8d8579, { jit: 0.06 });
      b.box('ext', 'wood', 1.4, 0.44, 0.06, 0.05, 1.9, -0.13, 0x7a5a3a, { jit: 0.04 });
      if (v === 1) b.cone('ext', 'wood', 0.22, 0.3, 4, 0.9, 1.9, -0.13, 0x7a5a3a, { rz: -HPI, ry: PI / 4 });
      b.sign(0.05, 1.9, -0.13, 0, 1.4, 0.44);
      b.cylCol(0, 0, 0.1, 2.0);
    },
  });
  def('crate', { static: true, build(b, v) { if (v === 0) { F.crate(b, 'ext', 0.8); } else if (v === 1) { F.crate(b, 'ext', 0.9); b.at(0.1, 0.05, 0.4, 0.9); F.crate(b, 'ext', 0.6); b.end(); } else { F.crate(b, 'ext', 0.7); b.at(0.85, 0.1, 0.2); F.crate(b, 'ext', 0.6); b.end(); } b.boxCol(-0.5, 0, -0.5, 0.5, 0.9, 0.5); } });
  def('barrel', { static: true, build(b, v) { if (v === 0) F.barrel(b, 'ext'); else if (v === 1) { F.barrel(b, 'ext'); b.at(0.72, 0.1, 0); F.barrel(b, 'ext', 0.28, 0.72); b.end(); } else { b.at(0, 0, 0); F.keg(b, 'ext'); b.end(); } b.cylCol(0, 0, v === 1 ? 0.7 : 0.4, 0.9); } });
  def('hay', { static: true, build(b, v) { if (v === 0) { F.hayBale(b, 'ext'); b.at(0.1, 0.05, 0.15, 0.6); F.hayBale(b, 'ext'); b.end(); b.at(1.1, 0.2, -0.4); F.hayBale(b, 'ext'); b.end(); } else if (v === 1) F.hayPile(b, 'ext', 1.3); else { F.hayPile(b, 'ext', 0.9); b.cyl('ext', 'wood', 0.03, 0.04, 2.2, 5, 0.3, 0.9, 0.2, 0x5a3c25, { rz: 0.5 }); } b.cylCol(0, 0, 0.8, 0.6); } });
  def('cart', {
    static: true,
    build(b, v) {
      b.box('ext', 'wood', 2.3, 0.14, 1.3, 0, 0.78, 0, 0x7a5a3a, { jit: 0.05 });
      for (const sx of [-1, 1]) b.box('ext', 'wood', 2.3, 0.55, 0.06, sx * 0.62, 1.1, 0, 0x8a6a45, { jit: 0.05 }); for (const sz of [-1, 1]) b.box('ext', 'wood', 0.06, 0.55, 1.2, 0, 1.1, sz * 1.12, 0x8a6a45, { jit: 0.05 });
      b.cyl('ext', 'wood', 0.05, 0.05, 1.7, 7, 0, 0.55, 0.2, 0x4a3220, { rz: HPI });
      for (const sx of [-1, 1]) { b.torus('ext', 'wood', 0.5, 0.07, sx * 0.8, 0.55, 0.2, 0x5a3c25, { ry: HPI, jit: 0.04 }); b.cyl('ext', 'wood', 0.1, 0.1, 0.14, 8, sx * 0.8, 0.55, 0.2, 0x4a3220, { rz: HPI }); for (let i = 0; i < 6; i++) b.box('ext', 'wood', 0.05, 0.95, 0.04, sx * 0.8, 0.55, 0.2, 0x6a4a2a, { rx: i * PI / 6 }); }
      for (const sx of [-1, 1]) b.box('ext', 'wood', 0.08, 0.08, 2.2, sx * 0.45, 0.62, -2.1, 0x5a3c25, { rx: 0.14 });
      if (v === 0) b.sph('ext', 'thatch', 1.0, 0, 0.85, 0, 0xcdaa5c, { sy: 0.55, sz: 0.65, jit: 0.06 });
      else if (v === 1) { for (let i = 0; i < 3; i++) { b.at(-0.7 + i * 0.7, 0, 0.5, 0.85); F.sack(b, 'ext', [0xc4ac7c, 0xb8a070, 0xd0b888][i]); b.end(); } }
      else { for (let i = 0; i < 2; i++) { b.at(-0.55 + i * 1.1, 0, 0, 0.85); F.barrel(b, 'ext', 0.28, 0.7); b.end(); } }
      b.boxCol(-1.2, 0, -0.7, 1.2, 1.4, 0.7);
    },
  });
  def('statue', {
    static: true,
    build(b, v) {
      if (v === 2) { menhir(b, 'ext', 3.6, 0x7d7873); for (let i = 0; i < 3; i++) b.box('ext', 'flat', 0.14, 0.14, 0.05, 0.05, 1.0 + i * 0.5, -0.5, 0x2a2622, { rz: PI / 4, jit: 0 }); b.cylCol(0, 0, 0.65, 3.4); return; }
      const hex = v === 1 ? 0xd8dbe2 : 0x9a968e;
      b.box('ext', 'stone', 1.5, 0.25, 1.5, 0, 0.125, 0, hex, { jit: 0.03 }); b.box('ext', 'stone', 1.1, 1.0, 1.1, 0, 0.75, 0, hex, { jit: 0.03 }); b.box('ext', 'stone', 1.3, 0.12, 1.3, 0, 1.3, 0, hex, { jit: 0.03 });
      b.at(0, 0, 0, 1.36); figure(b, 'ext', 1.25, hex, v === 1 ? 'robed' : 'warrior'); b.end();
      b.boxCol(-0.75, 0, -0.75, 0.75, 1.4, 0.75);
    },
  });
  /* ---------------- banner: pole on a stone footing + hanging cloth with heraldic bands and a device; the cloth sways ---------------- */
  const HERALDRY = {
    man:     { cloth: 0x8a2a2a, band: 0xd8b24a, device: 0xf0e2b8 },
    hobbit:  { cloth: 0x3e6a44, band: 0xe8d8a0, device: 0xd8b24a },
    dwarf:   { cloth: 0x2a4a8a, band: 0xc8ccd8, device: 0xd8b24a },
    elf:     { cloth: 0x4a6a8a, band: 0xd8dce8, device: 0xeef2f8 },
    ruin:    { cloth: 0x6a4a3a, band: 0xa89870, device: 0x9a8a70 },
    camp:    { cloth: 0x7a3a2a, band: 0xc8a860, device: 0xe0d0a0 },
    lossoth: { cloth: 0x6a7e96, band: 0xe8eef4, device: 0xc8d8e8 },
  };
  def('banner', {
    static: true, variants: 2,
    key(spec, v) { return 'banner:' + (HERALDRY[spec.style] ? spec.style : 'man') + ':' + v; },
    build(b, v, spec) {
      const H = HERALDRY[spec.style] || HERALDRY.man;
      const ph = 4.0 + v * 0.5, W = 0.9, L = 2.3 + v * 0.2;
      b.cyl('ext', 'stone', 0.3, 0.36, 0.24, 8, 0, 0.12, 0, 0x8d8579, { jit: 0.06 });
      b.cyl('ext', 'wood', 0.055, 0.08, ph, 7, 0, ph / 2, 0, 0x4e3a28, { jit: 0.05 });
      b.cone('ext', 'metal', 0.06, 0.24, 6, 0, ph + 0.11, 0, 0xb08a40);
      b.cyl('ext', 'wood', 0.03, 0.03, W + 0.3, 6, 0, ph - 0.14, -0.1, WOOD_D, { rz: HPI });
      for (const sx of [-1, 1]) b.torus('ext', 'metal', 0.035, 0.008, sx * (W / 2 - 0.05), ph - 0.14, -0.1, 0x3a3a40, { ry: HPI });
      const geo = b.piece('ext', 'banner', new T.PlaneGeometry(W, L, 4, 12), 0, ph - 0.16 - L / 2, -0.1, H.cloth, { jit: 0.025 });
      const col = geo.attributes.color, uv = geo.attributes.uv, pos = geo.attributes.position;
      const cb = new T.Color(H.band), cd = new T.Color(H.device);
      for (let i = 0; i < col.count; i++) {
        const u = uv.getX(i), t = uv.getY(i);
        const band = (t > 0.3 && t < 0.43) || (t > 0.13 && t < 0.2);
        const dev = Math.abs(u - 0.5) * 1.1 + Math.abs(t - 0.7) * 0.55 < 0.17;
        if (dev) col.setXYZ(i, cd.r, cd.g, cd.b); else if (band) col.setXYZ(i, cb.r, cb.g, cb.b);
        if (t < 0.001) pos.setY(i, pos.getY(i) + Math.abs(u - 0.5) * (v === 0 ? 0.5 : 0.2));   // swallow-tailed hem
      }
      b.cylCol(0, 0, 0.16, 2.6);
    },
  });
  /* ---------------- anvil: on an oak stump (v0) or a stone block (v1), with hammer, tongs, quench bucket, horseshoes ---------------- */
  def('anvil', {
    static: true, variants: 2,
    build(b, v) {
      if (v === 0) F.anvil(b, 'ext');
      else {
        b.box('ext', 'stone', 0.72, 0.56, 0.62, 0, 0.28, 0, 0x6f6a64, { jit: 0.06 });
        b.box('ext', 'metal', 0.36, 0.14, 0.26, 0, 0.63, 0, 0x4a4b52); b.box('ext', 'metal', 0.44, 0.16, 0.3, 0, 0.78, 0, 0x55565e);
        b.cone('ext', 'metal', 0.13, 0.4, 8, 0.4, 0.79, 0, 0x55565e, { rz: -HPI }); b.box('ext', 'metal', 0.16, 0.12, 0.22, -0.3, 0.78, 0, 0x55565e);
      }
      const top = v === 0 ? 0.85 : 0.86;
      b.cyl('ext', 'wood', 0.02, 0.025, 0.42, 6, 0.02, top + 0.035, -0.02, 0x6a4a2a, { rz: HPI, ry: 0.35, jit: 0.04 });          // hammer
      b.box('ext', 'metal', 0.1, 0.07, 0.07, -0.18, top + 0.04, -0.09, 0x3a3a40);
      b.rod('ext', 'metal', 0.36, 0.0, 0.34, 0.2, 0.62, 0.16, 0.012, 0x3a3a40); b.rod('ext', 'metal', 0.42, 0.0, 0.3, 0.22, 0.62, 0.16, 0.012, 0x3a3a40);   // tongs leaning on the base
      b.at(-0.62, 0.34, 0); F.barrel(b, 'ext', 0.17, 0.4); b.end();                                                                       // quench bucket
      b.cyl('ext', 'water', 0.15, 0.15, 0.02, 10, -0.62, 0.38, 0.34, 0x33505c, { jit: 0.02 });
      for (let i = 0; i < 3; i++) b.torus('ext', 'metal', 0.07, 0.014, 0.5 + (i % 2) * 0.16, 0.015, -0.32 + i * 0.14, 0x45454c, { rx: HPI, ry: i * 0.9 });   // horseshoes
      b.cylCol(0, 0, 0.5, 0.95);
      b.spot(0, -0.85, 0, 'forge');
    },
  });

  /* ------------------------------------------------------------------------------------------------ */
  /* Runtime: instancing, doors, colliders, lights, update loop, world builders                        */
  /* ------------------------------------------------------------------------------------------------ */
  const root = new T.Group(); root.name = 'buildings';
  const all = [], byId = {}, enterables = [], batches = [];
  const CACHE = new Map(), DOOR_CACHE = new Map(), SIGN_MAT = new Map();
  let scene = null, playerInside = null, lightsEnabled = true, _time = 0, _lightTimer = 0, _doorTimer = 0, horsesBroken = false;
  const NEAR_DIST = 60, INT_DIST = 320, FAR_DIST = 900, LIGHT_DIST = 60, FX_DIST = 70, FX_DROP = 95;
  const POOL_SIZE = 6;
  const pool = [];
  const _v = new T.Vector3();

  function terrainH(x, z) { const Tr = G.Terrain; return (Tr && typeof Tr.height === 'function') ? (+Tr.height(x, z) || 0) : 0; }
  function isWaterAt(x, z) { const Tr = G.Terrain; if (Tr && typeof Tr.isWater === 'function') return !!Tr.isWater(x, z); return terrainH(x, z) < (G.C ? G.C.SEA_LEVEL : 0); }
  function seaLevel() { return (G.C && typeof G.C.SEA_LEVEL === 'number') ? G.C.SEA_LEVEL : 0; }
  function l2w(bld, lx, lz, out) { out = out || {}; out.x = bld.x + lx * bld.cos + lz * bld.sin; out.z = bld.z - lx * bld.sin + lz * bld.cos; return out; }
  function titleize(s) { return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }

  function getCached(recipe, variant, spec) {
    const key = recipe.key ? recipe.key(spec, variant) : recipe.name + ':' + variant;
    let c = CACHE.get(key);
    if (!c) {
      const b = new Builder(key, hashStr(key));
      recipe.build(b, variant, spec, b.rng);
      c = b.build(); c.key = key; c.uses = 0;
      CACHE.set(key, c);
    }
    c.uses++;
    return c;
  }

  /* ---- door leaves ---- */
  function doorLeafGeo(d) {
    const key = [d.kind, d.w.toFixed(2), d.h.toFixed(2), d.hex || 0, d.hinge].join(':');
    let g = DOOR_CACHE.get(key);
    if (g) return g;
    const b = new Builder('door:' + key, hashStr(key));
    const dir = -d.hinge, w = d.w, h = d.h, th = 0.08, cx = dir * w / 2;
    const hex = d.hex || (d.kind === 'elf' ? 0xe8e6de : d.kind === 'flap' ? 0x9a7a58 : d.kind === 'dwarf' ? 0x4e3a28 : 0x6b4a2a);
    const dark = d.kind === 'elf' ? 0xc8c4b8 : 0x2e2016, iron = d.kind === 'elf' ? 0xd8b862 : 0x3a3a40;
    if (d.kind === 'round') {
      const r = w / 2;
      b.cyl('d', 'wood', r - 0.02, r - 0.02, th, 26, cx, r, 0, hex, { rx: HPI, jit: 0.03 });
      for (let i = -3; i <= 3; i++) { const off = i * (r * 0.28); const chord = 2 * Math.sqrt(Math.max(0, r * r - off * off)) - 0.1; if (chord > 0.1) b.box('d', 'wood', 0.02, chord, th + 0.012, cx + off, r, 0, dark, { jit: 0 }); }
      b.torus('d', 'wood', r - 0.06, 0.025, cx, r, -th / 2, dark, { jit: 0 });
      b.sph('d', 'wood', 0.07, cx, r, -th / 2 - 0.04, 0xd8b040, { jit: 0 });
    } else {
      const arch = d.kind === 'arch' || d.kind === 'elf';
      const bh = arch ? h - w / 2 : h;
      b.box('d', 'wood', w - 0.04, bh - 0.02, th, cx, bh / 2, 0, hex, { jit: 0.03 });
      if (arch) b.cyl('d', 'wood', w / 2 - 0.02, w / 2 - 0.02, th, 16, cx, bh - 0.01, 0, hex, { rx: HPI, ts: HPI, tl: PI, jit: 0.03 });
      const n = Math.max(2, Math.round(w / 0.28));
      for (let i = 1; i < n; i++) { const x = cx - w / 2 + (w / n) * i; const hh = arch ? bh + Math.sqrt(Math.max(0, (w / 2) * (w / 2) - (x - cx) * (x - cx))) - 0.05 : h - 0.05; b.box('d', 'wood', 0.018, hh, th + 0.012, x, hh / 2, 0, dark, { jit: 0 }); }
      if (d.kind === 'banded' || d.kind === 'dwarf' || d.kind === 'plain') {
        const rows = d.kind === 'plain' ? [0.35, h - 0.4] : [0.3, h / 2, h - 0.35];
        for (const y of rows) { b.box('d', 'wood', w - 0.08, 0.1, th + 0.03, cx, y, 0, iron, { jit: 0 }); for (let i = 0; i < 4; i++) b.sph('d', 'wood', 0.02, cx - w / 2 + 0.12 + i * (w - 0.24) / 3, y, -th / 2 - 0.02, 0x8a8a92, { jit: 0 }); }
      }
      if (d.kind === 'elf') { b.box('d', 'wood', 0.05, h * 0.55, th + 0.03, cx, h * 0.5, 0, iron, { jit: 0 }); for (let i = 0; i < 3; i++) b.box('d', 'wood', 0.16, 0.16, th + 0.03, cx, h * 0.3 + i * h * 0.2, 0, iron, { rz: PI / 4, jit: 0 }); }
      if (d.kind === 'flap') { for (let i = 0; i < 2; i++) b.box('d', 'wood', w - 0.1, 0.03, th + 0.02, cx, 0.5 + i * 0.6, 0, 0x4a3a28, { jit: 0 }); }
      b.torus('d', 'wood', 0.05, 0.014, cx + dir * (w / 2 - 0.16), h * 0.5, -th / 2 - 0.02, 0x8a8a92, { jit: 0 });
    }
    const built = b.build();
    g = built.groups.d[0].geo;
    DOOR_CACHE.set(key, g);
    return g;
  }

  function makeDoor(bld, d) {
    const leaves = d.leaves === 2 ? [{ hinge: -1, w: d.w / 2 }, { hinge: 1, w: d.w / 2 }] : [{ hinge: d.hinge || -1, w: d.w }];
    const c = Math.cos(d.ry), s = Math.sin(d.ry);
    const pivots = [];
    for (const lf of leaves) {
      const geo = doorLeafGeo({ kind: d.kind || 'plain', w: lf.w, h: d.h, hex: d.hex, hinge: lf.hinge });
      const pivot = new T.Group();
      pivot.position.set(d.x + lf.hinge * (d.w / 2) * c, d.y || 0, d.z - lf.hinge * (d.w / 2) * s);
      pivot.rotation.y = d.ry;
      const mesh = new T.Mesh(geo, getMat('wood')); mesh.castShadow = true; mesh.receiveShadow = true;
      pivot.add(mesh);
      bld.group.add(pivot);
      pivots.push({ group: pivot, hinge: lf.hinge, base: d.ry, open: lf.hinge * (100 * PI / 180) });
    }
    const wp = l2w(bld, d.x, d.z);
    const ex = l2w(bld, d.x + (d.w / 2) * c, d.z - (d.w / 2) * s), ex2 = l2w(bld, d.x - (d.w / 2) * c, d.z + (d.w / 2) * s);
    const ent = {
      id: uid(), kind: 'door', name: (d.name || (d.leaves === 2 ? 'Doors' : 'Door')) + (bld.name ? ' of ' + bld.name : ''),
      level: 1, pos: new T.Vector3(wp.x, bld.y + (d.y || 0), wp.z), yaw: bld.yaw + d.ry, vel: new T.Vector3(), radius: 0.5, height: d.h,
      alive: true, dead: false, hostile: false, faction: 'neutral', effects: [], cooldowns: {}, target: null, anim: 'idle', animTime: 0, mesh: pivots[0].group, rig: null, ai: null,
      building: bld, open: false, t: 0, tApplied: -1, pivots, openedAt: 0, colId: null,
      col: { x1: ex.x, z1: ex.z, x2: ex2.x, z2: ex2.z, h: d.h + 0.4, t: Math.max(0.3, d.t || 0.3) },
      holdClosed: false,   // set when the player shuts it by hand: no auto-reopen until they have stepped away
      interact: { label: 'Open door', range: 3, fn: function (e) { const en = (e && e.kind === 'door') ? e : ent; if (en.open) en.holdClosed = true; toggleDoor(en); } },
    };
    if (typeof G.addEntity === 'function') G.addEntity(ent);
    else { G.state.entities.push(ent); G.state.byId[ent.id] = ent; if (G.Spatial && G.Spatial.insert) G.Spatial.insert(ent); }
    return ent;
  }
  function doorColliderOn(ent, on) {
    const P = G.Physics; if (!P) return;
    if (on && ent.colId === null && typeof P.addWall === 'function') ent.colId = P.addWall(ent.col.x1, ent.col.z1, ent.col.x2, ent.col.z2, ent.col.h, ent.col.t, 'bld:' + ent.building.id);
    else if (!on && ent.colId !== null && typeof P.remove === 'function') { P.remove(ent.colId); ent.colId = null; }
  }
  function applyDoorPose(ent) {
    const k = ent.t;
    const e = k <= 0 ? 0 : k >= 1 ? 1 : (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
    for (const p of ent.pivots) p.group.rotation.y = p.base + p.open * e;
    ent.tApplied = k;
  }
  function setDoor(ent, open) {
    if (!ent || ent.kind !== 'door' || ent.open === open) return;
    ent.open = open;
    ent.interact.label = open ? 'Close door' : 'Open door';
    ent.openedAt = _time;
    const target = open ? 1 : 0;
    if (typeof G.tween === 'function' && typeof G.tweenUpdate === 'function') G.tween(ent, { t: target }, 0.5, 'inOut');
    else ent.animTarget = target;
    if (G.Audio && typeof G.Audio.sfx === 'function') { try { G.Audio.sfx(open ? 'door_open' : 'door_close', { pos: ent.pos }); } catch (e) { /* audio not ready */ } }
    doorColliderOn(ent, !open);
    if (typeof G.emit === 'function') G.emit('doorToggled', ent);
  }
  function toggleDoor(ent) { setDoor(ent, !ent.open); }

  /* ---- colliders ---- */
  function addBoxLocal(bld, bx, ids, tag) {
    const P = G.Physics;
    const fl = bx.floor ? { tag, floor: true } : tag;
    const y0 = bld.y + bx.miny, y1 = bld.y + bx.maxy;
    const p = {};
    if (bx.corners) {   // oriented cell from Builder.boxCol(…, cell): the world AABB of its four corners, no further splitting
      let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
      for (let k = 0; k < 8; k += 2) { l2w(bld, bx.corners[k], bx.corners[k + 1], p); if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x; if (p.z < mnz) mnz = p.z; if (p.z > mxz) mxz = p.z; }
      ids.push(P.addBox(mnx, y0, mnz, mxx, y1, mxz, fl));
      return;
    }
    const q = Math.abs(bld.yaw / HPI - Math.round(bld.yaw / HPI)) < 0.01;
    const cell = q ? 1e9 : (bx.floor && bx.maxy > 1.0 ? 1.6 : 2.5);
    const nx = Math.max(1, Math.ceil((bx.maxx - bx.minx) / cell)), nz = Math.max(1, Math.ceil((bx.maxz - bx.minz) / cell));
    for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) {
      const x0 = bx.minx + (bx.maxx - bx.minx) * i / nx, x1 = bx.minx + (bx.maxx - bx.minx) * (i + 1) / nx;
      const z0 = bx.minz + (bx.maxz - bx.minz) * j / nz, z1 = bx.minz + (bx.maxz - bx.minz) * (j + 1) / nz;
      let mnx = Infinity, mxx = -Infinity, mnz = Infinity, mxz = -Infinity;
      for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) { l2w(bld, cx, cz, p); if (p.x < mnx) mnx = p.x; if (p.x > mxx) mxx = p.x; if (p.z < mnz) mnz = p.z; if (p.z > mxz) mxz = p.z; }
      ids.push(P.addBox(mnx, y0, mnz, mxx, y1, mxz, fl));
    }
  }
  function registerColliders(bld) {
    const P = G.Physics;
    if (!bld || bld.colRegistered || !P || typeof P.addWall !== 'function') return false;
    const m = bld.cached.meta, tag = 'bld:' + bld.id, ids = bld.colliders, a = {}, b2 = {};
    try {
      for (const w of m.walls) { l2w(bld, w.x1, w.z1, a); l2w(bld, w.x2, w.z2, b2); ids.push(P.addWall(a.x, a.z, b2.x, b2.z, w.h, w.t, tag)); }
      for (const c of m.cyls) { l2w(bld, c.x, c.z, a); ids.push(P.addCylinder(a.x, a.z, c.r, c.h, tag)); }
      for (const bx of m.boxes) addBoxLocal(bld, bx, ids, tag);
      for (const d of bld.doors) if (!d.open) doorColliderOn(d, true);
    } catch (e) { if (G.reportError) G.reportError(e, 'Buildings.registerColliders'); }
    bld.colRegistered = true;
    return true;
  }
  function registerAllColliders() { let n = 0; for (const bld of all) if (registerColliders(bld)) n++; return n; }

  /* ---- signs ---- */
  function signMaterial(text) {
    let m = SIGN_MAT.get(text);
    if (!m) { m = new T.MeshStandardMaterial({ map: signTexture(text), roughness: 0.85 }); SIGN_MAT.set(text, m); }
    return m;
  }
  function makeSign(bld, s, text) {
    const front = new T.PlaneGeometry(s.w, s.h); front.rotateY(PI); front.translate(0, 0, -0.033);
    const back = new T.PlaneGeometry(s.w, s.h); back.translate(0, 0, 0.033);
    const geo = mergeGeos([front, back]);
    const mesh = new T.Mesh(geo, signMaterial(text));
    mesh.position.set(s.x, s.y, s.z); mesh.rotation.y = s.ry; mesh.castShadow = true;
    bld.ext.add(mesh);
    bld.signMeshes.push(mesh);
  }

  /* ---- visibility ---- */
  function refreshVis(bld) {
    if (bld.batched) return;
    const band = bld.band, inside = bld.inside;
    bld.group.visible = band < 3;
    const intVis = band === 0 || inside;
    if (bld.int) bld.int.visible = intVis;
    if (bld.roof) bld.roof.visible = !(inside && bld.camInside);   // the shell drops only once the camera has followed the player in (what you see overhead is the interior ceiling, which never hides)
    for (const c of bld.ceilings) c.group.visible = intVis;         // an upper storey is the floor below's ceiling — never hidden by height
    for (const d of bld.doors) for (const p of d.pivots) p.group.visible = band < 2;
    for (const sm of bld.signMeshes) sm.visible = band < 2;
  }

  /* ---- placement ---- */
  function place(spec) {
    if (!spec || typeof spec !== 'object') return null;
    const recipe = RECIPES[spec.recipe];
    if (!recipe) { if (G.warn) G.warn('[Buildings] unknown recipe ' + spec.recipe); return null; }
    const x = +spec.x || 0, z = +spec.z || 0, yaw = +spec.yaw || 0;
    let variant = (spec.variant !== undefined && spec.variant !== null) ? (Math.abs(spec.variant | 0) % recipe.variants) : Math.floor(hash2(x * 0.173 + 11.3, z * 0.131 + 7.7) * recipe.variants) % recipe.variants;
    if ((spec.variant === undefined || spec.variant === null) && recipe.styleVariant) variant = recipe.styleVariant(spec.style, variant) % recipe.variants;
    const y = (spec.y !== undefined && spec.y !== null) ? +spec.y : terrainH(x, z);
    let cached;
    try { cached = getCached(recipe, variant, spec); }
    catch (e) { if (G.reportError) G.reportError(e, 'Buildings.place ' + spec.recipe); else if (G.warn) G.warn('[Buildings] build failed ' + spec.recipe + ': ' + e.message); return null; }
    const m = cached.meta;
    const name = spec.name || (recipe.defaultName ? recipe.defaultName(spec) : titleize(recipe.name));
    const group = new T.Group();
    group.position.set(x, y, z); group.rotation.y = yaw; group.name = 'bld:' + recipe.name;
    const bld = {
      id: uid(), recipe: recipe.name, name, x, y, z, yaw, cos: Math.cos(yaw), sin: Math.sin(yaw), variant,
      group, ext: null, int: null, roof: null, upper: null, ceilings: [], door: null, doors: [],
      interiorBounds: m.interior, radius: m.radius, radius2: m.radius * m.radius,
      colliders: [], colRegistered: false, lights: [], hearths: [], smokes: [], interiorSpots: [], signMeshes: [], horses: [],
      npcInside: spec.npcInside || [], town: spec.town || null, poi: spec.poi || null, spec, cached,
      enterable: !!(recipe.enterable && m.interior), static: !!recipe.static, batched: null,
      band: -1, inside: false, camInside: false, d2: Infinity,
    };
    for (const grp in cached.groups) {
      const sub = new T.Group(); sub.name = grp;
      for (const part of cached.groups[grp]) {
        const mesh = new T.Mesh(part.geo, getMat(part.mat));
        mesh.castShadow = part.mat !== 'glass' && part.mat !== 'water'; mesh.receiveShadow = true;
        sub.add(mesh);
      }
      group.add(sub);
      if (grp === 'ext') bld.ext = sub; else if (grp === 'int') bld.int = sub; else if (grp === 'roof') bld.roof = sub;
      else { const c = m.ceilings.find(cc => cc.grp === grp); bld.ceilings.push({ group: sub, y: c ? c.y : 0 }); if (grp === 'upper') bld.upper = sub; }
    }
    if (!bld.ext) { bld.ext = new T.Group(); bld.ext.name = 'ext'; group.add(bld.ext); }
    for (const d of m.doors) { const ent = makeDoor(bld, d); bld.doors.push(ent); }
    bld.door = bld.doors[0] || null;
    const p = {};
    for (const s of m.spots) { l2w(bld, s.x, s.z, p); bld.interiorSpots.push({ x: p.x, y: bld.y + s.y, z: p.z, yaw: bld.yaw + s.yaw, role: s.role, building: bld }); }
    for (const l of m.lights) { l2w(bld, l.x, l.z, p); bld.lights.push({ x: p.x, y: bld.y + l.y, z: p.z, color: l.color, base: l.intensity, dist: l.dist, kind: l.kind, flicker: l.flicker, interior: !!l.interior, seed: hash2(p.x, p.z) * 100, on: true, light: null, stamp: 0, d2: 0, bld }); }
    for (const h of m.hearths) { l2w(bld, h.x, h.z, p); bld.hearths.push({ pos: new T.Vector3(p.x, bld.y + h.y, p.z), scale: h.scale, kind: h.kind, opts: { scale: h.scale, loop: true }, fxId: null }); }
    for (const s of m.smokes) { l2w(bld, s.x, s.z, p); const sm = { pos: new T.Vector3(p.x, bld.y + s.y, p.z), scale: 0.8, kind: 'smoke', opts: { scale: 0.8, loop: true, color: 0x9a948c }, fxId: null }; bld.smokes.push(sm); bld.hearths.push(sm); }
    for (const h of m.horses) { l2w(bld, h.x, h.z, p); bld.horses.push({ x: p.x, z: p.z, y: bld.y, yaw: bld.yaw + h.yaw, rig: null, ent: null }); }
    if (m.signs.length) { const text = spec.text || spec.name || name; for (const s of m.signs) makeSign(bld, s, text); }
    if (bld.doors.length === 0 && m.interior === null) bld.enterable = false;
    if (bld.enterable) enterables.push(bld);
    all.push(bld); byId[bld.id] = bld;
    root.add(group);
    registerColliders(bld);
    refreshVis(bld);
    return bld;
  }

  function remove(bld) {
    if (!bld) return false;
    if (typeof bld === 'string') bld = byId[bld];
    if (!bld) return false;
    const P = G.Physics;
    if (P && typeof P.remove === 'function') { for (const id of bld.colliders) P.remove(id); for (const d of bld.doors) if (d.colId !== null) P.remove(d.colId); }
    for (const d of bld.doors) { if (typeof G.removeEntity === 'function') G.removeEntity(d); else { const i = G.state.entities.indexOf(d); if (i >= 0) G.state.entities.splice(i, 1); delete G.state.byId[d.id]; if (G.Spatial && G.Spatial.remove) G.Spatial.remove(d); } }
    for (const h of bld.hearths) stopFX(h);
    for (const h of bld.horses) if (h.rig) { if (h.rig.group && h.rig.group.parent) h.rig.group.parent.remove(h.rig.group); if (h.rig.dispose) h.rig.dispose(); }
    if (bld.group.parent) bld.group.parent.remove(bld.group);
    if (playerInside === bld) playerInside = null;
    let i = all.indexOf(bld); if (i >= 0) all.splice(i, 1);
    i = enterables.indexOf(bld); if (i >= 0) enterables.splice(i, 1);
    delete byId[bld.id];
    return true;
  }

  /* ---- static batching (props merged per town into one mesh per material) ---- */
  function batchStatic(list, label) {
    const buckets = {}; const batched = [];
    for (const bld of list) {
      if (!bld || !bld.static || bld.doors.length || bld.batched || !bld.ext) continue;
      bld.group.updateMatrixWorld(true);
      for (const mesh of bld.ext.children) {
        if (!mesh.isMesh || !mesh.geometry) continue;
        const g = mesh.geometry.clone(); g.applyMatrix4(mesh.matrixWorld);
        const key = mesh.material.name.replace(/^bld_/, '');
        (buckets[key] || (buckets[key] = [])).push(g);
      }
      batched.push(bld);
    }
    if (!batched.length) return null;
    const grp = new T.Group(); grp.name = 'batch:' + (label || '');
    for (const key in buckets) {
      const geo = mergeGeos(buckets[key]); if (!geo) continue;
      const mesh = new T.Mesh(geo, getMat(key)); mesh.castShadow = key !== 'glass' && key !== 'water'; mesh.receiveShadow = true;
      grp.add(mesh);
    }
    root.add(grp);
    for (const bld of batched) { bld.ext.visible = false; bld.batched = grp; }
    batches.push(grp);
    return grp;
  }

  /* ---- world builders ---- */
  function resolvePos(center, radius, o) {
    const ox = +o.x || 0, oz = +o.z || 0;
    if (o.rel) return { x: center.x + ox, z: center.z + oz };
    const lim = (radius || 60) * 1.6 + 30;
    const dAbs = Math.hypot(ox - center.x, oz - center.z), dRel = Math.hypot(ox, oz);
    if (dAbs <= lim) return { x: ox, z: oz };
    if (dRel <= lim) return { x: center.x + ox, z: center.z + oz };
    return { x: ox, z: oz };
  }
  function roadGateAngles(town) {
    const out = [];
    const W = G.Data && G.Data.world;
    if (!W || !W.roads) return out;
    const cx = town.pos.x, cz = town.pos.z, R = town.wallRadius || (town.radius * 1.05 + 6);
    for (const rd of W.roads) {
      if (rd.from !== town.id && rd.to !== town.id) continue;
      const pts = rd.from === town.id ? rd.points : rd.points.slice().reverse();
      let p = null;
      for (const q of pts) { if (Math.hypot(q.x - cx, q.z - cz) > R + 4) { p = q; break; } }
      if (!p) p = pts[pts.length - 1];
      if (!p) continue;
      out.push(Math.atan2(p.x - cx, p.z - cz));
    }
    return out;
  }
  function buildTownWalls(town, placed) {
    const cx = town.pos.x, cz = town.pos.z, R = town.wallRadius || (town.radius * 1.05 + 6);
    let gates = Array.isArray(town.gates) ? town.gates.map(g => (typeof g === 'number' ? g : Math.atan2((g.x || 0) - cx, (g.z || 0) - cz))) : roadGateAngles(town);
    if (!gates.length) gates = [-HPI, 0];   // west, south
    const N = Math.max(8, Math.round(TAU * R / 11)), da = TAU / N;
    const variant = town.wallStyle === 'palisade' || (town.style === 'camp') ? 1 : 0;
    const gateHalf = 7.6 / R;
    for (let i = 0; i < N; i++) {
      const a0 = i * da, a1 = a0 + da, am = a0 + da / 2;
      let skip = false;
      for (const g of gates) { const d = Math.atan2(Math.sin(am - g), Math.cos(am - g)); if (Math.abs(d) < gateHalf + da * 0.5) { skip = true; break; } }
      if (skip) continue;
      const p0x = cx + Math.sin(a0) * R, p0z = cz + Math.cos(a0) * R, p1x = cx + Math.sin(a1) * R, p1z = cz + Math.cos(a1) * R;
      const len = Math.hypot(p1x - p0x, p1z - p0z) + 0.6;
      const bld = place({ recipe: 'wall_segment', x: (p0x + p1x) / 2, z: (p0z + p1z) / 2, yaw: am + PI, len, variant, town: town.id });
      if (bld) placed.push(bld);
    }
    for (const g of gates) { const bld = place({ recipe: 'gate', x: cx + Math.sin(g) * R, z: cz + Math.cos(g) * R, yaw: g + PI, town: town.id, name: town.name + ' Gate' }); if (bld) placed.push(bld); }
  }
  function buildTown(town) {
    if (!town || !town.pos) return [];
    const placed = [];
    const center = town.pos, radius = town.radius || 60;
    for (const bs of (town.buildings || [])) {
      const p = resolvePos(center, radius, bs);
      const bld = place(Object.assign({}, bs, { recipe: bs.recipe || bs.kind, x: p.x, z: p.z, town: town.id, style: bs.style || town.style }));
      if (bld) placed.push(bld);
    }
    for (const ps of (town.props || [])) {
      const p = resolvePos(center, radius, ps);
      const bld = place(Object.assign({}, ps, { recipe: ps.recipe || ps.kind, x: p.x, z: p.z, town: town.id, style: ps.style || town.style }));
      if (bld) placed.push(bld);
    }
    if (town.walls || town.id === 'bree') buildTownWalls(town, placed);
    town.buildingsPlaced = placed;
    batchStatic(placed, town.id);
    return placed;
  }
  function waterDir(x, z, radii) {
    let best = -1, bestScore = 0;
    for (let k = 0; k < 8; k++) {
      const a = k * PI / 4; let score = 0;
      for (const r of radii) if (isWaterAt(x + Math.sin(a) * r, z + Math.cos(a) * r)) score += 1 + 8 / r;
      if (score > bestScore) { bestScore = score; best = a; }
    }
    return best;
  }
  function buildDocks(docks) {
    const placed = [];
    if (!Array.isArray(docks)) return placed;
    for (const d of docks) {
      if (!d || !d.pos) continue;
      const x = +d.pos.x || 0, z = +d.pos.z || 0;
      let a = waterDir(x, z, [5, 9, 14, 20, 28, 36]);
      if (a < 0) a = (typeof d.yaw === 'number') ? d.yaw + PI : 0;
      let len = 14;
      for (let r = 4; r <= 34; r += 2) { const hx = x + Math.sin(a) * r, hz = z + Math.cos(a) * r; if (terrainH(hx, hz) <= seaLevel() - 1.4) { len = r + 8; break; } len = r + 8; }
      len = clamp(len, 10, 38);
      const h0 = terrainH(x, z), deckY = Math.max(seaLevel() + 0.75, h0 + 0.1);
      const bld = place({ recipe: 'dock', x, z, yaw: a + PI, len, deckLocal: deckY - h0, name: d.name || 'Dock', town: d.town || null, dockId: d.id });
      if (!bld) continue;
      const end = bld.interiorSpots.find(s => s.role === 'boat');
      bld.dockEnd = end ? { x: end.x, y: deckY, z: end.z } : { x: x + Math.sin(a) * (len + 2), y: deckY, z: z + Math.cos(a) * (len + 2) };
      bld.dockId = d.id; d.building = bld; d.deckY = deckY;
      placed.push(bld);
    }
    return placed;
  }
  function buildPOI(poi) {
    if (!poi || !poi.pos) return [];
    const placed = [], px = +poi.pos.x || 0, pz = +poi.pos.z || 0, r = rngOf(hashStr('poi:' + (poi.id || (px + ',' + pz))));
    const put = (spec) => { const b = place(Object.assign({ poi: poi.id }, spec)); if (b) placed.push(b); return b; };
    if (Array.isArray(poi.buildings) && poi.buildings.length) {
      for (const bs of poi.buildings) { const p = resolvePos(poi.pos, 60, bs); put(Object.assign({}, bs, { recipe: bs.recipe || bs.kind, x: p.x, z: p.z })); }
    } else {
      switch (poi.kind) {
        case 'ruin': {
          put({ recipe: 'ruin_tower', x: px, z: pz, yaw: r() * TAU });
          const n = 3 + Math.floor(r() * 3);
          for (let i = 0; i < n; i++) { const a = (i / n) * TAU + r() * 0.6, rr = 9 + r() * 7; put({ recipe: 'ruin_wall', x: px + Math.sin(a) * rr, z: pz + Math.cos(a) * rr, yaw: a + HPI + (r() - 0.5) * 0.6, len: 5 + r() * 4 }); }
          if (r() < 0.6) put({ recipe: 'statue', x: px + 6, z: pz - 5, yaw: r() * TAU, variant: 2 });
          break;
        }
        case 'tower': put({ recipe: 'tower', x: px, z: pz, yaw: r() * TAU }); put({ recipe: 'ruin_wall', x: px + 8, z: pz + 3, yaw: 0.4, len: 7 }); put({ recipe: 'ruin_wall', x: px - 7, z: pz - 4, yaw: 2.2, len: 6 }); break;
        case 'bridge': {
          let a = waterDir(px, pz, [6, 10, 16]); if (a < 0) a = typeof poi.yaw === 'number' ? poi.yaw : 0;
          let len = 24;
          for (let d = 4; d <= 40; d += 2) { if (!isWaterAt(px + Math.sin(a) * d, pz + Math.cos(a) * d)) { len = d * 2 + 8; break; } len = d * 2 + 8; }
          put({ recipe: 'bridge', x: px, z: pz, yaw: a + PI, len: clamp(len, 16, 44) });
          break;
        }
        case 'grave': put({ recipe: 'barrow', x: px, z: pz, yaw: r() * TAU, variant: 0 }); break;
        case 'cave': case 'dungeon': put({ recipe: 'barrow', x: px, z: pz, yaw: typeof poi.yaw === 'number' ? poi.yaw : r() * TAU, variant: 1, name: poi.name }); break;
        case 'camp': {
          put({ recipe: 'campfire', x: px, z: pz, yaw: 0 });
          const n = 2 + Math.floor(r() * 2);
          for (let i = 0; i < n; i++) { const a = (i / n) * TAU + 0.5; put({ recipe: 'tent', x: px + Math.sin(a) * 6, z: pz + Math.cos(a) * 6, yaw: a }); }
          put({ recipe: 'crate', x: px + 4, z: pz - 3, yaw: r() }); put({ recipe: 'hay', x: px - 4.5, z: pz + 3, yaw: r() });
          break;
        }
        case 'shrine': put({ recipe: 'shrine', x: px, z: pz, yaw: typeof poi.yaw === 'number' ? poi.yaw : 0 }); put({ recipe: 'lamp', x: px - 3.5, z: pz - 3.5, style: 'elf' }); put({ recipe: 'lamp', x: px + 3.5, z: pz - 3.5, style: 'elf' }); break;
        case 'landmark': put({ recipe: 'statue', x: px, z: pz, yaw: r() * TAU }); break;
        default: break;
      }
      if (poi.kind !== 'camp' && poi.name) put({ recipe: 'sign', x: px + 5, z: pz + 5, yaw: -PI / 4, text: poi.name });
    }
    poi.buildingsPlaced = placed;
    return placed;
  }
  function build(sc) {
    if (sc) init(sc);
    const W = G.Data && G.Data.world;
    if (!W) return 0;
    let n = 0;
    for (const t of (W.towns || [])) n += buildTown(t).length;
    for (const p of (W.pois || [])) n += buildPOI(p).length;
    n += buildDocks(W.docks || []).length;
    log('[Buildings] built', n, 'structures,', all.length, 'total');
    return n;
  }
  function init(sc) {
    if (sc && sc.isScene) { scene = sc; if (root.parent !== sc) sc.add(root); }
    ensurePool();
  }

  /* ---- lights ---- */
  function ensurePool() {
    if (pool.length) return;
    for (let i = 0; i < POOL_SIZE; i++) {
      const L = new T.PointLight(0xffa040, 0, 12, 2); L.castShadow = false; L.name = 'bld_light' + i;
      root.add(L); pool.push({ light: L, virt: null });
    }
  }
  function nightFactor() {
    let ll = 1;
    if (G.Sky && typeof G.Sky.lightLevel === 'number') ll = G.Sky.lightLevel;
    else if (G.time && typeof G.time.dayTime === 'number') { const h = G.time.dayTime; ll = (h > 6.5 && h < 19.5) ? 1 : (h > 5 && h <= 6.5) ? (h - 5) / 1.5 : (h >= 19.5 && h < 21) ? (21 - h) / 1.5 : 0; }
    return clamp((0.5 - ll) / 0.4, 0, 1);
  }
  let _night = 0;
  function updateMaterials() {
    _night = nightFactor();
    if (MAT.glass) MAT.glass.emissiveIntensity = 0.06 + _night * 1.5;
    if (MAT.lampglow) MAT.lampglow.emissiveIntensity = 0.12 + _night * 1.9;
    if (MAT.elfglow) MAT.elfglow.emissiveIntensity = 0.45 + _night * 1.3;
  }
  const cand = []; let candN = 0; let _stamp = 0;
  const near = []; let nearN = 0;
  function virtIntensity(v) { return v.kind === 'lamp' ? v.base * (v.interior ? 0.7 + 0.3 * _night : _night) : v.kind === 'elf' ? v.base * (0.35 + 0.65 * _night) : v.base; }
  function assignLights(px, py, pz) {
    _stamp++; candN = 0;
    for (let i = 0; i < nearN; i++) {
      const bld = near[i];
      for (const v of bld.lights) {
        if (!v.on) continue;
        const dx = v.x - px, dy = v.y - py, dz = v.z - pz, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > LIGHT_DIST * LIGHT_DIST) continue;
        if (v.interior && playerInside !== bld && !nearDoorOf(bld, px, pz)) continue;
        if (virtIntensity(v) <= 0.01) continue;
        // bounded insertion sort by distance
        let k = candN < POOL_SIZE ? candN++ : POOL_SIZE - 1;
        if (k === POOL_SIZE - 1 && cand[k] && cand[k].d2 <= d2) continue;
        v.d2 = d2;
        while (k > 0 && cand[k - 1].d2 > d2) { cand[k] = cand[k - 1]; k--; }
        cand[k] = v;
      }
    }
    for (let i = 0; i < candN; i++) cand[i].stamp = _stamp;
    for (const slot of pool) if (slot.virt && slot.virt.stamp !== _stamp) { slot.virt.light = null; slot.virt = null; slot.light.intensity = 0; }
    for (let i = 0; i < candN; i++) {
      const v = cand[i]; if (v.light) continue;
      for (const slot of pool) if (!slot.virt) { slot.virt = v; v.light = slot.light; slot.light.position.set(v.x, v.y, v.z); slot.light.color.setHex(v.color); slot.light.distance = v.dist; break; }
    }
  }
  function nearDoorOf(bld, px, pz) {
    for (const d of bld.doors) { const dx = d.pos.x - px, dz = d.pos.z - pz; if (dx * dx + dz * dz < 16) return true; }
    return false;
  }
  function flickerLights() {
    for (const slot of pool) {
      const v = slot.virt;
      if (!v || !lightsEnabled) { slot.light.intensity = 0; continue; }
      let it = virtIntensity(v);
      if (v.flicker) it *= 0.84 + 0.16 * (0.5 + 0.5 * Math.sin(_time * 11.3 + v.seed) * Math.sin(_time * 17.1 + v.seed * 1.7)) + 0.05 * Math.sin(_time * 29 + v.seed);
      slot.light.intensity = it;
    }
  }

  /* ---- FX (hearth fires, chimney smoke) ---- */
  function updateFX(dt, px, pz) {
    const FX = G.FX; if (!FX || typeof FX.spawn !== 'function') return;
    let spawnBudget = 4;
    for (let i = 0; i < nearN; i++) {
      const bld = near[i];
      for (const h of bld.hearths) {
        const dx = h.pos.x - px, dz = h.pos.z - pz, d2 = dx * dx + dz * dz;
        if (h.fxId === null && d2 < FX_DIST * FX_DIST) {
          if (spawnBudget-- <= 0) continue;
          try { h.fxId = FX.spawn(h.kind, h.pos, h.opts); if (h.fxId === undefined || h.fxId === null) h.fxId = true; } catch (e) { h.fxId = true; }
        } else if (h.fxId !== null && d2 > FX_DROP * FX_DROP) { stopFX(h); }
      }
    }
  }
  function stopFX(h) {
    const FX = G.FX;
    if (h.fxId !== null && h.fxId !== true && FX) {
      try { if (typeof FX.stop === 'function') FX.stop(h.fxId); else if (typeof FX.remove === 'function') FX.remove(h.fxId); else if (h.fxId && typeof h.fxId.stop === 'function') h.fxId.stop(); } catch (e) { /* ignore */ }
    }
    h.fxId = null;
  }
  function updateHorses(dt) {
    if (horsesBroken || !G.Chars || typeof G.Chars.buildHorse !== 'function') return;
    for (let i = 0; i < nearN; i++) {
      const bld = near[i];
      for (const h of bld.horses) {
        if (!h.rig) {
          try {
            const rig = G.Chars.buildHorse([0x8b4a2b, 0x9a9a9a, 0x6b3f22, 0x2a2420][Math.floor(hash2(h.x, h.z) * 4)]);
            if (!rig || !rig.group) { horsesBroken = true; return; }
            rig.group.position.set(h.x, h.y, h.z); rig.group.rotation.y = h.yaw;
            root.add(rig.group);
            h.rig = rig; h.ent = { pos: rig.group.position, vel: new T.Vector3(), yaw: h.yaw, onGround: true, anim: 'idle', animTime: 0, alive: true, kind: 'mount', mounted: false };
            if (rig.setAnim) rig.setAnim('idle');
          } catch (e) { horsesBroken = true; if (G.reportError) G.reportError(e, 'Buildings.horse'); return; }
        }
        if (h.rig && bld.d2 < 80 * 80 && typeof h.rig.play === 'function') { try { h.rig.play(dt, h.ent); } catch (e) { horsesBroken = true; return; } }
      }
    }
  }

  /* ---- doors update ---- */
  function nearDoorOccupied(ent, px, pz) {
    if ((px - ent.pos.x) * (px - ent.pos.x) + (pz - ent.pos.z) * (pz - ent.pos.z) < 36) return true;
    const S = G.Spatial;
    if (S && typeof S.query === 'function') {
      const res = S.query(ent.pos.x, ent.pos.z, 6, entFilter);
      if (res && res.length) return true;
    }
    return false;
  }
  function entFilter(e) { return e && (e.kind === 'npc' || e.kind === 'aiplayer' || e.kind === 'player' || e.kind === 'monster') && e.alive !== false; }
  // Doors swing open when the player comes within AUTO_OPEN m and shut AUTO_CLOSE s after everyone has left. The radius
  // is generous on purpose: a closed door is a wall collider, and Player.autoMove's probe steers AROUND walls, so the
  // leaf has to be moving well before the player reaches the threshold or click-to-move walks around the house instead.
  const AUTO_OPEN = 3.4, AUTO_CLOSE = 8;
  function updateDoors(dt, px, py, pz) {
    const tweening = typeof G.tween === 'function' && typeof G.tweenUpdate === 'function';
    _doorTimer -= dt;
    const check = _doorTimer <= 0;
    if (check) _doorTimer = 0.5;
    for (let i = 0; i < all.length; i++) {
      const bld = all[i];
      if (!bld.doors.length) continue;
      const nearBld = bld.d2 < 900;
      for (const d of bld.doors) {
        if (!tweening && d.animTarget !== undefined && d.t !== d.animTarget) { d.t = d.animTarget > d.t ? Math.min(d.animTarget, d.t + dt * 2) : Math.max(d.animTarget, d.t - dt * 2); }
        if (d.t !== d.tApplied) applyDoorPose(d);
        if (nearBld) {   // auto-open on approach (every frame — the leaf must be moving before the player reaches it)
          const dx = d.pos.x - px, dz = d.pos.z - pz, d2 = dx * dx + dz * dz;
          if (d.holdClosed && d2 > (AUTO_OPEN + 1.5) * (AUTO_OPEN + 1.5)) d.holdClosed = false;
          if (!d.open && !d.holdClosed && d2 < AUTO_OPEN * AUTO_OPEN && Math.abs(d.pos.y - py) < 2.5) setDoor(d, true);
        }
        if (check && d.open && _time - d.openedAt > AUTO_CLOSE && !nearDoorOccupied(d, px, pz)) setDoor(d, false);
      }
    }
  }

  /* ---- inside detection ---- */
  /** The enterable building whose interior footprint contains (x,z), ignoring height — for callers that need to
   *  find the building BEFORE they know which storey they are on (teleport / spawn placement lands on `bld.y`,
   *  the ground floor, instead of the roof or an upper slab). Returns null in the open. */
  function footprintAt(x, z) {
    if (typeof x !== 'number' || typeof z !== 'number' || x !== x || z !== z) return null;
    for (let i = 0; i < enterables.length; i++) {
      const bld = enterables[i];
      const dx = x - bld.x, dz = z - bld.z;
      if (dx * dx + dz * dz > bld.radius2) continue;
      const ib = bld.interiorBounds; if (!ib) continue;
      const lx = dx * bld.cos - dz * bld.sin, lz = dx * bld.sin + dz * bld.cos;
      if (lx >= ib.minx - 0.3 && lx <= ib.maxx + 0.3 && lz >= ib.minz - 0.3 && lz <= ib.maxz + 0.3) return bld;
    }
    return null;
  }
  function inInterior(bld, x, y, z) {
    const dx = x - bld.x, dz = z - bld.z;
    if (dx * dx + dz * dz > bld.radius2) return false;
    const ib = bld.interiorBounds; if (!ib) return false;
    const lx = dx * bld.cos - dz * bld.sin, lz = dx * bld.sin + dz * bld.cos, ly = y - bld.y;
    return lx >= ib.minx - 0.3 && lx <= ib.maxx + 0.3 && lz >= ib.minz - 0.3 && lz <= ib.maxz + 0.3 && ly >= ib.miny && ly <= ib.maxy;
  }
  function isInside(pos) {
    if (!pos) return null;
    for (let i = 0; i < enterables.length; i++) {
      const bld = enterables[i];
      const dx = pos.x - bld.x, dz = pos.z - bld.z;
      if (dx * dx + dz * dz > bld.radius2) continue;
      if (inInterior(bld, pos.x, pos.y, pos.z)) return bld;
      for (const d of bld.doors) { if (!d.open) continue; const ddx = pos.x - d.pos.x, ddz = pos.z - d.pos.z; if (ddx * ddx + ddz * ddz < 1.44) return bld; }
    }
    return null;
  }
  // the chase camera (G.Player.camera / G.Game.camera) is inside the building's interior volume
  function cameraInside(bld) {
    const P = G.Player, Gm = G.Game;
    const cam = (P && P.camera && P.camera.position) ? P.camera : (Gm && Gm.camera && Gm.camera.position) ? Gm.camera : null;
    return !!(cam && inInterior(bld, cam.position.x, cam.position.y, cam.position.z));
  }
  function nearest(pos, filter) {
    if (!pos) return null;
    let best = null, bd = Infinity;
    for (const bld of all) { if (filter && !filter(bld)) continue; const dx = pos.x - bld.x, dz = pos.z - bld.z, d2 = dx * dx + dz * dz; if (d2 < bd) { bd = d2; best = bld; } }
    return best;
  }
  function spotFor(npcId) {
    if (!npcId) return null;
    for (const bld of all) {
      const list = bld.npcInside; if (!list || !list.length) continue;
      const idx = list.indexOf(npcId); if (idx < 0) continue;
      const spots = bld.interiorSpots; if (!spots.length) return { x: bld.x, y: bld.y, z: bld.z, yaw: bld.yaw, role: 'idle', building: bld };
      const pref = ['keeper', 'vendor', 'boatmaster', 'lord', 'forge', 'fire', 'table', 'idle'];
      const sorted = spots.slice().sort((a, b) => pref.indexOf(a.role) - pref.indexOf(b.role));
      return sorted[idx % sorted.length];
    }
    return null;
  }

  /* ---- main update ---- */
  function update(playerPos, dt) {
    dt = (typeof dt === 'number' && dt === dt) ? dt : 0;
    _time += dt;
    if (!pool.length) ensurePool();
    updateMaterials();
    BANNER_U.time.value = _time;
    BANNER_U.wind.value += (_bannerWindTarget - BANNER_U.wind.value) * Math.min(1, dt * 0.6);
    if (!playerPos || typeof playerPos.x !== 'number') playerPos = (G.state && G.state.player && G.state.player.pos) || null;
    if (!playerPos) { updateDoors(dt, 1e9, 0, 1e9); flickerLights(); return; }
    const px = playerPos.x, py = playerPos.y, pz = playerPos.z;
    nearN = 0;
    for (let i = 0; i < all.length; i++) {
      const bld = all[i];
      const dx = px - bld.x, dz = pz - bld.z, d2 = dx * dx + dz * dz;
      bld.d2 = d2;
      const band = d2 < NEAR_DIST * NEAR_DIST ? 0 : d2 < INT_DIST * INT_DIST ? 1 : d2 < FAR_DIST * FAR_DIST ? 2 : 3;
      if (band !== bld.band) { bld.band = band; refreshVis(bld); }
      if (d2 < 150 * 150) { if (nearN < near.length) near[nearN] = bld; else near.push(bld); nearN++; }
    }
    const ins = isInside(playerPos);
    if (ins !== playerInside) {
      if (playerInside) { playerInside.inside = false; playerInside.camInside = false; refreshVis(playerInside); if (typeof G.emit === 'function') G.emit('leaveBuilding', playerInside); }
      playerInside = ins;
      if (ins) { ins.inside = true; ins.camInside = cameraInside(ins); refreshVis(ins); if (typeof G.emit === 'function') G.emit('enterBuilding', ins); }
    }
    if (ins) { const ci = cameraInside(ins); if (ci !== ins.camInside) { ins.camInside = ci; refreshVis(ins); } }
    updateDoors(dt, px, py, pz);
    _lightTimer -= dt;
    if (_lightTimer <= 0) { _lightTimer = 0.2; assignLights(px, py + 1, pz); }
    flickerLights();
    updateFX(dt, px, pz);
    updateHorses(dt);
  }
  function setLightsEnabled(on) { lightsEnabled = !!on; if (!lightsEnabled) for (const slot of pool) slot.light.intensity = 0; }
  function stats() {
    let ext = 0, inter = 0, doors = 0, lights = 0;
    for (const bld of all) { if (!bld.batched && bld.ext) ext += bld.ext.children.length + (bld.roof ? bld.roof.children.length : 0); if (bld.int) inter += bld.int.children.length; doors += bld.doors.length; lights += bld.lights.length; }
    return { buildings: all.length, enterable: enterables.length, doors, virtualLights: lights, pooledLights: pool.length, batches: batches.length, exteriorMeshes: ext, interiorMeshes: inter, cachedRecipes: CACHE.size };
  }

  if (typeof G.on === 'function') G.on('sceneReady', function (sc) { if (sc && sc.isScene) init(sc); });
  if (typeof G.on === 'function') G.on('weatherChanged', function (kind) { if (BANNER_WIND[kind] != null) _bannerWindTarget = BANNER_WIND[kind]; });

  G.Buildings = {
    init, build, place, remove, buildTown, buildPOI, buildDocks, buildTownWalls, batchStatic,
    update, isInside, footprintAt, nearest, spotFor, setLightsEnabled, registerColliders: registerAllColliders,
    openDoor: function (d) { setDoor(d, true); }, closeDoor: function (d) { setDoor(d, false); }, toggleDoor,
    all, byId, root, batches, recipes: RECIPES, RECIPES: Object.keys(RECIPES), materials: MAT, getMaterial: getMat, stats,
    get playerInside() { return playerInside; },
    get lightsEnabled() { return lightsEnabled; },
    get scene() { return scene; },
    get night() { return _night; },
  };
})();
