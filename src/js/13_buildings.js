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

  /* ------------------------------------------------------------------------------------------------ */
  /* Builder — accumulates vertex-coloured pieces into (group × material) buckets + placement metadata  */
  /* Local frame: building centre at origin on the ground (y=0), FRONT/door side = -z (yaw 0 = facing -Z). */
  /* ------------------------------------------------------------------------------------------------ */
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
    // metadata (all transformed through the cursor)
    wallCol(x1, z1, x2, z2, h, t) { const a = this.xf(x1, 0, z1), b = this.xf(x2, 0, z2); this.meta.walls.push({ x1: a.x, z1: a.z, x2: b.x, z2: b.z, h: h || 3, t: t || 0.3 }); }
    boxCol(minx, miny, minz, maxx, maxy, maxz, floor) {
      const p1 = this.xf(minx, miny, minz), p2 = this.xf(maxx, miny, maxz), p3 = this.xf(minx, miny, maxz), p4 = this.xf(maxx, miny, minz);
      const cy = this.cur ? this.cur.y : 0;
      this.meta.boxes.push({ minx: Math.min(p1.x, p2.x, p3.x, p4.x), maxx: Math.max(p1.x, p2.x, p3.x, p4.x), minz: Math.min(p1.z, p2.z, p3.z, p4.z), maxz: Math.max(p1.z, p2.z, p3.z, p4.z), miny: miny + cy, maxy: maxy + cy, floor: !!floor });
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
      this.meta.lights.push({ x: p.x, y: p.y, z: p.z, color: o.color || 0xffa040, intensity: o.intensity || 40, dist: o.dist || 12, kind: o.kind || 'fire', flicker: o.flicker === undefined ? (o.kind === 'fire' || !o.kind) : o.flicker });
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
      const segCol = (ua, ub) => { if (ub - ua < 0.05) return; const p = sideMap(side, W, D, ua), q = sideMap(side, W, D, ub); b.wallCol(p.x, p.z, q.x, q.z, gable || H, Math.max(0.3, t)); };
      let u0 = -L / 2;
      for (const d of doors) { segCol(u0, d.u - (d.r ? d.r : d.w / 2)); u0 = d.u + (d.r ? d.r : d.w / 2); }
      segCol(u0, L / 2);
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
          b.box('ext', 'stone', (h.r ? h.r * 2 : h.w) + 0.5, 0.12, 0.9, s, -0.02, -t / 2 - 0.4, 0x8d8579, { jit: 0.06 });
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
        b.box('ext', 'wood', L + 0.1, bw, 0.11, 0, y0 + bw / 2, zo, hexT);
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
      b.end();
    }
    if (o.baseH) {
      const e = 0.12, bh = o.baseH + skirt, cy = (o.baseH - skirt) / 2, hexS = o.baseHex || 0x8f887c;
      b.box('ext', 'stone', W + 2 * e + t, bh, e + t / 2, 0, cy, -(D / 2 + e / 2 + t / 4), hexS, { jit: 0.08 });
      b.box('ext', 'stone', W + 2 * e + t, bh, e + t / 2, 0, cy, (D / 2 + e / 2 + t / 4), hexS, { jit: 0.08 });
      b.box('ext', 'stone', e + t / 2, bh, D + t, -(W / 2 + e / 2 + t / 4), cy, 0, hexS, { jit: 0.08 });
      b.box('ext', 'stone', e + t / 2, bh, D + t, (W / 2 + e / 2 + t / 4), cy, 0, hexS, { jit: 0.08 });
    }
    if (o.floor !== false) b.floor(-W / 2 - t / 2, -D / 2 - t / 2, W / 2 + t / 2, D / 2 + t / 2, 0.05, o.floorMat || 'planks', o.floorHex === undefined ? 0x9a6f48 : o.floorHex);
    b.interior(-W / 2 + t / 2, -0.5, -D / 2 + t / 2, W / 2 - t / 2, (o.peak || H) + 0.5, D / 2 - t / 2);
    if (o.roof !== false && o.peak) {
      const ov = o.overhang === undefined ? 0.5 : o.overhang, th = o.roofTh || 0.3;
      const across = ridgeX ? D : W, along = ridgeX ? W : D;
      const span = across + 2 * ov, len = along + 2 * ov;
      const k = (o.peak - H) / (across / 2);
      const ye = H - k * ov;
      const g = chevronRoofGeo(span, ye, o.peak, th, len, !!o.curvedRoof);
      b.piece('roof', o.roofMat || 'thatch', g, 0, 0, 0, o.roofHex === undefined ? 0xb8944f : o.roofHex, { ry: ridgeX ? -HPI : 0, jit: 0.04, faceJit: false });
      const capHex = o.capHex === undefined ? 0x8a6a36 : o.capHex;
      b.cyl('roof', o.roofMat || 'thatch', 0.2, 0.2, len + 0.1, 8, 0, o.peak - 0.02, 0, capHex, ridgeX ? { rz: HPI } : { rx: HPI });
    }
    if (o.chimney) {
      const ch = o.chimney, cs = sideMap(ch.side, W, D, ch.u);
      const out = { f: [0, -1], b: [0, 1], l: [-1, 0], r: [1, 0] }[ch.side];
      const cx = cs.x + out[0] * 0.3, cz = cs.z + out[1] * 0.3, top = (o.peak || H) + 0.9;
      b.box('ext', 'stone', 1.0, top + 1, 1.0, cx, top / 2 - 0.5, cz, o.chimneyHex || 0x8b8377, { jit: 0.08 });
      b.box('ext', 'stone', 1.25, 0.25, 1.25, cx, top + 0.1, cz, 0x7d766b, { jit: 0.05 });
      b.box('ext', 'flat', 0.5, 0.06, 0.5, cx, top + 0.25, cz, 0x151210, { jit: 0 });
      b.smoke(cx, top + 0.35, cz);
    }
    return { W, D, H, t };
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
      b.cyl(g, 'metal', 0.016, 0.016, 0.9, 5, 0, 1.3, 0.1, 0x2a2a2e);                        // hook chain
      b.lathe(g, 'metal', [[0.05, 0], [0.19, 0.04], [0.21, 0.24], [0.17, 0.3]], 10, 0, 0.55, 0.1, 0x2b2b2f, { jit: 0.05 });
      F.candle(b, g, -w / 2 + 0.3, 1.99, 0.05); F.candle(b, g, w / 2 - 0.3, 1.99, 0.05);
      b.lathe(g, 'flat', [[0.03, 0], [0.09, 0.02], [0.1, 0.12], [0.06, 0.22], [0.07, 0.26]], 10, 0, 1.99, 0.0, 0x7b8a97, { jit: 0.04 });
      b.light(0, 0.9, -0.35, { kind: 'fire', color: 0xffa040, intensity: 40, dist: 12 });
      b.hearth(0, 0.22, -0.02, o.fxScale || 0.9);
    },
    candle(b, g, x, y, z) {
      b.cyl(g, 'flat', 0.024, 0.026, 0.15, 7, x, y + 0.075, z, 0xf0e8d0, { jit: 0.02 });
      b.cone(g, 'ember', 0.02, 0.07, 6, x, y + 0.18, z, 0xffcc60, { jit: 0.1 });
      b.cyl(g, 'metal', 0.05, 0.05, 0.015, 8, x, y + 0.007, z, 0xb59a4a);
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
      o = o || {};
      for (let i = 0; i < n; i++) {
        const top = (i + 1) * rise, z = (i + 0.5) * run;
        b.box(g, 'wood', w, Math.min(top, rise * 2.2), run, 0, top - Math.min(top, rise * 2.2) / 2, z, WOOD_F, { jit: 0.04 });
        b.boxCol(-w / 2, top - rise * 2.2, z - run / 2, w / 2, top, z + run / 2, true);
      }
      const L = n * run, H = n * rise;
      for (const s of (o.stringers || [-1, 1])) b.box(g, 'wood', 0.08, 0.34, L, s * (w / 2 + 0.03), H / 2 - 0.05, L / 2, WOOD_D, { rx: -Math.atan2(H, L) });
      if (o.rail) {
        const s = o.rail;
        for (let i = 0; i <= n; i += 3) { const z = (i + 0.5) * run, y = (i + 1) * rise; b.box(g, 'wood', 0.07, 0.95, 0.07, s * (w / 2 + 0.06), y + 0.45, z, WOOD_D); }
        b.box(g, 'wood', 0.08, 0.08, L + 0.3, s * (w / 2 + 0.06), H / 2 + 0.95, L / 2, WOOD_F, { rx: -Math.atan2(H, L) });
      }
    },
    railing(b, g, len, hex) {
      hex = hex || WOOD_F;
      const n = Math.max(1, Math.round(len / 0.8));
      for (let i = 0; i <= n; i++) b.box(g, 'wood', 0.08, 1.0, 0.08, -len / 2 + (len / n) * i, 0.5, 0, WOOD_D);
      b.box(g, 'wood', len + 0.08, 0.08, 0.1, 0, 1.02, 0, hex);
      b.box(g, 'wood', len, 0.05, 0.05, 0, 0.55, 0, hex);
    },
    pillar(b, g, style, h, hex) {
      if (style === 'elf') {
        hex = hex || 0xeceef2;
        b.cyl(g, 'stone', 0.3, 0.36, h - 0.6, 10, 0, (h - 0.6) / 2 + 0.3, 0, hex, { jit: 0.03, faceJit: false });
        b.cyl(g, 'stone', 0.44, 0.34, 0.3, 10, 0, 0.15, 0, hex, { jit: 0.03 });
        b.cyl(g, 'stone', 0.5, 0.3, 0.32, 10, 0, h - 0.16, 0, hex, { jit: 0.03 });
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
      b.light(0, 1.4 * scale, 0, { kind: 'fire', color: 0xffa040, intensity: 30 * scale, dist: 10 * scale });
      b.hearth(0, 0.95 * scale, 0, 0.55 * scale);
    },
    lantern(b, g, x, y, z, o) {
      o = o || {};
      const glow = o.elf ? 'elfglow' : 'lampglow', hexF = o.elf ? 0xd8dce6 : 0x2c2c30;
      const s = o.scale || 1;
      b.box(g, 'metal', 0.26 * s, 0.05, 0.26 * s, x, y + 0.02, z, hexF);
      b.box(g, 'metal', 0.24 * s, 0.05, 0.24 * s, x, y + 0.36 * s, z, hexF);
      b.cone(g, 'metal', 0.18 * s, 0.12 * s, 4, x, y + 0.44 * s, z, hexF, { ry: PI / 4 });
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.box(g, 'metal', 0.025, 0.34 * s, 0.025, x + sx * 0.11 * s, y + 0.19 * s, z + sz * 0.11 * s, hexF);
      b.box(g, glow, 0.17 * s, 0.28 * s, 0.17 * s, x, y + 0.19 * s, z, 0xffffff, { jit: 0 });
      if (o.chain) b.cyl(g, 'metal', 0.015, 0.015, o.chain, 5, x, y + 0.5 * s + o.chain / 2, z, hexF);
      if (o.hook) b.torus(g, 'metal', 0.05, 0.012, x, y + 0.53 * s, z, hexF);
      b.light(x, y + 0.2 * s, z, { kind: o.elf ? 'elf' : 'lamp', color: o.elf ? 0xbfd8ff : 0xffc070, intensity: o.intensity || 22, dist: o.dist || 11, flicker: !o.elf });
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
      b.light(0, 1.6, -0.3, { kind: 'fire', color: 0xffa040, intensity: 45, dist: 13 });
      b.hearth(0, 1.2, 0.05, 0.75);
    },
    fountain(b, g, r) {
      r = r || 1.8;
      b.lathe(g, 'stone', [[r * 0.75, 0], [r * 1.02, 0.02], [r * 1.05, 0.5], [r * 0.98, 0.62], [r * 0.88, 0.62], [r * 0.9, 0.16], [r * 0.4, 0.14], [0.2, 0.14]], 20, 0, 0, 0, 0xe4e6ea, { jit: 0.02 });
      b.cyl(g, 'water', r * 0.89, r * 0.89, 0.02, 20, 0, 0.5, 0, 0x4d8cc0, { jit: 0.02 });
      b.lathe(g, 'stone', [[0.16, 0.1], [0.14, 1.0], [0.22, 1.1], [0.55, 1.15], [0.6, 1.28], [0.5, 1.3], [0.12, 1.32], [0.1, 1.34], [0.08, 1.7], [0.14, 1.72], [0.16, 1.9], [0.1, 1.98], [0, 2.0]], 14, 0, 0, 0, 0xe4e6ea, { jit: 0.02 });
      b.cyl(g, 'water', 0.49, 0.49, 0.02, 14, 0, 1.24, 0, 0x5b9bd0, { jit: 0.02 });
      b.light(0, 2.2, 0, { kind: 'elf', color: 0xbfd8ff, intensity: 18, dist: 12, flicker: false });
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
