/* ==== 13_buildings.js — Procedural buildings with REAL walk-in interiors: hobbit holes, timber houses, inns,
   shops, elf & dwarf halls, lossoth huts, tents, towers, ruins, barrows, docks, bridges, town walls & gates, fences,
   wells, campfires, market stalls, stables, shrines and props (lamp, sign, crate, barrel, hay, cart, statue).
   Every enterable recipe has hollow walls with a door opening, a floor collider, a roof/ceiling group that is hidden
   while the player is inside, vertex-coloured merged furniture (few draw calls), a hearth with G.FX fire + pooled
   flickering PointLights, and windows that glow at night. Doors are entities (kind:'door') with an E interaction.
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
      gr.addColorStop(0, 'rgba(60,35,10,0)'); gr.addColorStop(1, 'rgba(60,35,10,0.55)');
      ctx.fillStyle = gr; ctx.fillRect(0, y0 + rh - 12, w, 12);
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
    ctx.fillStyle = hsl(15, 30, 40); ctx.fillRect(0, 0, w, h);
    const tw = 32, th = 32;
    for (let j = 0; j < h / th; j++) {
      const y0 = j * th;
      for (let x = ((j % 2) ? -tw / 2 : 0) - tw; x <= w; x += tw) {
        ctx.fillStyle = hsl(12 + r() * 12, 30 + r() * 16, 52 + r() * 18);
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
