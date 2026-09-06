/* ==== 11_sky.js — Sky dome, sun & moon, day/night cycle, clouds, weather (rain/snow/storm + lightning), fog and the
   scene lighting rig (sun/moon/hemisphere/ambient + cascaded-free texel-snapped shadow camera) for a stylised Middle-earth.

   Public API (SPEC §5.2):
     G.Sky.init(scene, renderer)            builds dome/lights/fog/particle systems and adds them to the scene
     G.Sky.update(dt, playerPos)            advances G.time.dayTime, weather, lights, fog, shadows, precipitation
     G.Sky.setTime(hours)                   jump the clock (0..24)
     G.Sky.setWeather(kind, immediate?)     'clear'|'cloudy'|'rain'|'snow'|'storm'; 4 s cross-fade (immediate=true snaps)
     G.Sky.setShadowQuality(size)           shadow map size (0 disables shadows); used by G.PostFX.setQuality
     G.Sky.getSkyColor(out?)                horizon colour (linear THREE.Color) used by fog/water
     G.Sky.sun / .moon (DirectionalLight)   .hemi (HemisphereLight)  .ambient (AmbientLight)  .fog (scene.fog)
     G.Sky.phase ('dawn'|'day'|'dusk'|'night')   G.Sky.lightLevel (0..1)
   Extras exposed on G.Sky (beyond the spec, all read-only unless stated):
     weather (current kind), targetWeather, cloudiness (0..1 smoothed), rainLevel (0..1), snowLevel (0..1),
     sunDir / moonDir (unit Vector3, +y up), getSunDir(out), sunElevation (-1..1), moonPhase (0..1, 0.5 = full),
     lightning() (trigger a flash now), rollWeather() (force an automatic weather roll), autoWeather (bool, settable),
     dome (the sky Mesh), WEATHER_KINDS, sunTheta(hour) (pure helper), dayIndex.
   Events emitted: 'dayPhase' (phase) on phase transitions, 'weatherChanged' (kind) when the weather kind changes.
   Assumed hooks in other modules (all optional; called only when present):
     G.Terrain.setSkyColor(THREE.Color)                  — horizon colour for water/terrain tinting (linear)
     G.Terrain.setSun(dir:Vector3, color:THREE.Color, intensity:number) — dominant directional light (moon at night)
     G.Audio.sfx('thunder', {vol, pitch}), G.Audio.setAmbientRain(level 0..1)
     G.Buildings.isInside(pos) (precipitation hidden while indoors), G.Player.camera (dome + particle box follow it)
     G.Data.world.zoneById[id] or G.Data.world.zones[] with { biome, fogColor, weatherWeights }
   Private helpers (only used if core lacks them): _canvasTexture, _rng.
   ==== */
(function () {
  'use strict';
  const G = window.G;

  // ------------------------------------------------------------------ constants
  const TWO_PI = Math.PI * 2;
  const DOME_RADIUS = 3000;
  const SUNRISE_H = 5.0, SUNSET_H = 19.0;           // sun on the horizon at these hours
  const SUN_TILT = 0.42, MOON_TILT = 0.30;          // path leans toward the south (+z)
  const COS_T = Math.cos(SUN_TILT), SIN_T = Math.sin(SUN_TILT);
  const COS_M = Math.cos(MOON_TILT), SIN_M = Math.sin(MOON_TILT);
  const SYNODIC_DAYS = 29.53, MOON_PHASE0 = 0.5;    // full moon on the first night
  const SHADOW_BOUNDS = 70, SHADOW_DIST = 200, SHADOW_SIZE_DEFAULT = 2048;
  const WEATHER_TRANSITION = 4.0;
  const FOG_NEAR = 120, FOG_FAR = 900, FOG_FAR_DENSE = 500;
  const RAIN_COUNT = 8000, SNOW_COUNT = 5000, PRECIP_BOX = 40;
  const RAIN_FALL = 24, SNOW_FALL = 1.3;
  const SWAY_PERIOD = TWO_PI / 0.1;                 // both sway frequencies (0.5, 0.7) complete whole cycles here
  const WEATHER_KINDS = ['clear', 'cloudy', 'rain', 'snow', 'storm'];

  // per-kind targets (every field is cross-faded over WEATHER_TRANSITION seconds)
  const WEATHER = {
    clear:  { cloud: 0.30, grey: 0.00, darken: 0.00, rain: 0.0, snow: 0.0, sunMul: 1.00, wind: 1.0, fogFar: FOG_FAR, hazeMul: 1.0, storm: 0.0 },
    cloudy: { cloud: 0.74, grey: 0.35, darken: 0.10, rain: 0.0, snow: 0.0, sunMul: 0.62, wind: 1.7, fogFar: 760,     hazeMul: 1.1, storm: 0.0 },
    rain:   { cloud: 0.93, grey: 0.75, darken: 0.27, rain: 1.0, snow: 0.0, sunMul: 0.38, wind: 2.3, fogFar: 500,     hazeMul: 1.25, storm: 0.0 },
    snow:   { cloud: 0.88, grey: 0.60, darken: 0.16, rain: 0.0, snow: 1.0, sunMul: 0.50, wind: 1.2, fogFar: 460,     hazeMul: 1.45, storm: 0.0 },
    storm:  { cloud: 1.00, grey: 1.00, darken: 0.50, rain: 1.6, snow: 0.0, sunMul: 0.22, wind: 3.6, fogFar: 380,     hazeMul: 1.25, storm: 1.0 },
  };
  const WPARAMS = Object.keys(WEATHER.clear);
  const DEFAULT_WEIGHTS = { clear: 0.55, cloudy: 0.25, rain: 0.15, snow: 0.0, storm: 0.05 };
  const BIOME_WEIGHTS = {
    arctic:   { clear: 0.25, cloudy: 0.25, rain: 0.0, snow: 0.45, storm: 0.05 },
    mountain: { clear: 0.40, cloudy: 0.25, rain: 0.1, snow: 0.20, storm: 0.05 },
    dark:     { clear: 0.15, cloudy: 0.45, rain: 0.15, snow: 0.0, storm: 0.25 },
    forest:   { clear: 0.40, cloudy: 0.30, rain: 0.22, snow: 0.0, storm: 0.08 },
    downs:    { clear: 0.45, cloudy: 0.30, rain: 0.18, snow: 0.0, storm: 0.07 },
    island:   { clear: 0.50, cloudy: 0.25, rain: 0.15, snow: 0.0, storm: 0.10 },
    lake:     { clear: 0.50, cloudy: 0.28, rain: 0.17, snow: 0.0, storm: 0.05 },
  };
  const DARK_BIOMES = { dark: 1, forest: 1 };

  // 24-hour palette: hour, zenith, horizon, haze/sun-glow tint, cloud lit, cloud shade (sRGB hex; converted to linear)
  const KEY_TABLE = [
    [0.0,  0x070b22, 0x1a1e44, 0x272c54, 0x2c3456, 0x141a34],
    [3.4,  0x070b24, 0x1b1f46, 0x2a2f58, 0x2e365a, 0x151b36],
    [4.3,  0x0c1238, 0x322c56, 0x5a4468, 0x4e4268, 0x201f3e],
    [5.0,  0x1e3068, 0xe48c6a, 0xffba8e, 0xffcba2, 0x70597a],
    [5.6,  0x3054a2, 0xf7af86, 0xffd8ae, 0xffe2c4, 0x8f7f98],
    [6.8,  0x3b72c2, 0xc8d8ec, 0xfff0da, 0xffffff, 0x95a9c6],
    [9.0,  0x3070d2, 0xb9d7f3, 0xf4f8ff, 0xffffff, 0x8fa8ca],
    [12.0, 0x2a68d2, 0xb5d8f5, 0xf6faff, 0xffffff, 0x90a9cb],
    [15.0, 0x2f6dca, 0xbdd7ef, 0xfbf3e4, 0xffffff, 0x93a7c5],
    [17.2, 0x3b66b0, 0xd5c4b6, 0xffe4ba, 0xfff2da, 0x9b97ad],
    [18.3, 0x3d5c9e, 0xf2a86e, 0xffc78e, 0xffdaaa, 0x8c7492],
    [19.0, 0x2d327c, 0xff7c48, 0xffad6a, 0xffb27c, 0x6e4c72],
    [19.7, 0x1d1e58, 0xb24e6e, 0xd26280, 0xda8ca2, 0x482e5a],
    [20.6, 0x0e1238, 0x3c2c5a, 0x523c6a, 0x4e3c68, 0x221e3c],
    [22.0, 0x070b24, 0x1b1f46, 0x2a2f58, 0x2e365a, 0x151b36],
    [24.0, 0x070b22, 0x1a1e44, 0x272c54, 0x2c3456, 0x141a34],
  ];
  const KEYS = KEY_TABLE.map(k => ({
    h: k[0], zen: new THREE.Color(k[1]), hor: new THREE.Color(k[2]), haze: new THREE.Color(k[3]),
    lit: new THREE.Color(k[4]), shade: new THREE.Color(k[5]),
  }));
  // sun colours by elevation (sunDir.y)
  const SUN_LIGHT_RAMP = mkRamp([[-0.10, 0xff5a1e], [0.0, 0xff8c3c], [0.06, 0xffb266], [0.18, 0xffdcb0], [0.40, 0xfff4e6], [1.0, 0xfffaf4]]);
  const SUN_DISC_RAMP  = mkRamp([[-0.10, 0xff4a14], [0.0, 0xff8a3a], [0.08, 0xffc070], [0.25, 0xfff0d0], [1.0, 0xffffff]]);
  function mkRamp(a) { return a.map(p => ({ e: p[0], c: new THREE.Color(p[1]) })); }

  const MOON_LIGHT_COLOR = new THREE.Color(0x9fb3ff);
  const MOON_DISC_COLOR = new THREE.Color(0xeef1f8);
  const HEMI_GROUND_DAY = new THREE.Color(0x7a6848);
  const HEMI_GROUND_NIGHT = new THREE.Color(0x1c2238);
  const AMBIENT_DAY = new THREE.Color(0xc4d4ec);
  const AMBIENT_NIGHT = new THREE.Color(0x2a3660);
  const FLASH_COLOR = new THREE.Color(0xdfe8ff);
  const NOON_HORIZON_LUM = lum(KEYS[7].hor);

  // ------------------------------------------------------------------ small helpers (allocation-free)
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  function smooth(a, b, x) { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); }
  function mod(a, n) { return ((a % n) + n) % n; }
  function lum(c) { return c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722; }
  function rand() { return (G && typeof G.rand === 'function') ? G.rand() : Math.random(); }
  function _rng(seed) { // mulberry32 (private fallback when core is absent)
    let a = seed >>> 0;
    return function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function _canvasTexture(w, h, draw) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
  }
  function makeTexture(w, h, draw) {
    const t = (G && typeof G.canvasTexture === 'function') ? G.canvasTexture(w, h, draw, { wrap: false }) : _canvasTexture(w, h, draw);
    if (t) { t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; }
    return t;
  }
  function samplePalette(h, out) {
    let i = 0; const n = KEYS.length;
    while (i < n - 2 && KEYS[i + 1].h <= h) i++;
    const a = KEYS[i], b = KEYS[i + 1];
    let t = clamp((h - a.h) / (b.h - a.h), 0, 1); t = t * t * (3 - 2 * t);
    out.zen.lerpColors(a.zen, b.zen, t); out.hor.lerpColors(a.hor, b.hor, t); out.haze.lerpColors(a.haze, b.haze, t);
    out.lit.lerpColors(a.lit, b.lit, t); out.shade.lerpColors(a.shade, b.shade, t);
  }
  function ramp(R, e, out) {
    if (e <= R[0].e) return out.copy(R[0].c);
    for (let i = 1; i < R.length; i++) {
      if (e <= R[i].e) { const a = R[i - 1], b = R[i]; return out.lerpColors(a.c, b.c, (e - a.e) / (b.e - a.e)); }
    }
    return out.copy(R[R.length - 1].c);
  }
  // desaturate toward luminance by grey*satMul, darken by (1 - dark*darkMul) * (1 - extra)
  function weatherTint(src, out, grey, dark, satMul, darkMul, extra) {
    const l = lum(src), s = grey * satMul, m = (1 - dark * darkMul) * (1 - extra);
    out.r = (src.r + (l - src.r) * s) * m; out.g = (src.g + (l - src.g) * s) * m; out.b = (src.b + (l - src.b) * s) * m;
    return out;
  }
  function setColorFrom(out, v, fallback) {
    if (typeof v === 'number') out.setHex(v);
    else if (typeof v === 'string') out.set(v);
    else if (v && v.isColor) out.copy(v);
    else out.copy(fallback);
    return out;
  }
  function sunTheta(h) { // 0 at sunrise, π at sunset, 2π at the next sunrise
    const dayLen = SUNSET_H - SUNRISE_H, nightLen = 24 - dayLen;
    let t = mod(h - SUNRISE_H, 24);
    return t < dayLen ? Math.PI * t / dayLen : Math.PI + Math.PI * (t - dayLen) / nightLen;
  }

  // ------------------------------------------------------------------ shaders
  const SKY_VERT = `
    varying vec3 vWorldDir;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vWorldDir = wp.xyz - cameraPosition;
      vec4 cp = projectionMatrix * viewMatrix * wp;
      cp.z = cp.w;                       // pin the dome to the far plane
      gl_Position = cp;
    }`;

  const SKY_FRAG = `
    precision highp float;
    uniform vec3 uZenith, uHorizon, uHaze, uGround;
    uniform vec3 uSunDir, uMoonDir, uSunColor, uMoonColor;
    uniform float uSunVis, uGlow, uHazeAmt, uMoonVis, uMoonBright;
    uniform float uStars, uTime, uCloud, uFlash;
    uniform vec2 uCloudOff;
    uniform vec3 uCloudLit, uCloudShade;
    uniform mat3 uStarMat;
    varying vec3 vWorldDir;

    float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    float vnoise(vec2 p) {
      vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
    }
    float fbm5(vec2 p) {
      float v = 0.0; float a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
      for (int i = 0; i < 5; i++) { v += a * vnoise(p); p = m * p; a *= 0.5; }
      return v;
    }
    float fbm3(vec2 p) {
      float v = 0.0; float a = 0.5; mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
      for (int i = 0; i < 3; i++) { v += a * vnoise(p); p = m * p; a *= 0.5; }
      return v;
    }
    vec3 starLayer(vec2 p, float density, float rMin, float rMax, float twSpeed) {
      vec2 i = floor(p); vec2 f = fract(p);
      float h = hash12(i);
      float present = step(h, density);
      vec2 c = vec2(hash12(i + 17.1), hash12(i + 31.7)) * 0.6 + 0.2;
      float d = length(f - c);
      float r = mix(rMin, rMax, hash12(i + 5.3));
      float s = smoothstep(r, r * 0.15, d);
      float tw = 0.72 + 0.28 * sin(uTime * (1.2 + twSpeed * hash12(i + 2.2)) + h * 60.0);
      vec3 tint = mix(vec3(0.72, 0.84, 1.0), vec3(1.0, 0.9, 0.74), hash12(i + 3.3));
      return tint * (present * s * tw);
    }

    void main() {
      vec3 dir = normalize(vWorldDir);
      float y = dir.y;
      float mu = dot(dir, uSunDir);
      float muP = max(mu, 0.0);

      // ---- gradient + haze + scattering toward the sun
      float up = clamp(y, 0.0, 1.0);
      vec3 col = mix(uHorizon, uZenith, pow(up, 0.55));
      float below = clamp(-y * 6.0, 0.0, 1.0);
      col = mix(col, uGround, below);
      float hazeBand = exp(-max(y, 0.0) * 5.0) * (1.0 - below);
      float sunSide = 0.35 + 0.65 * pow(muP, 2.0);
      col += uHaze * hazeBand * uHazeAmt * sunSide * 0.5;
      col += uSunColor * (pow(muP, 6.0) * 0.12 + pow(muP, 24.0) * 0.20) * uGlow * uSunVis * (0.6 + 0.8 * hazeBand);

      // ---- stars + milky way (night)
      if (uStars > 0.001 && y > -0.05) {
        vec3 sd = uStarMat * dir;
        vec3 a = abs(sd); vec2 uv; float face;
        if (a.x >= a.y && a.x >= a.z) { uv = sd.yz / a.x; face = 1.0 + step(0.0, sd.x); }
        else if (a.y >= a.z) { uv = sd.xz / a.y; face = 3.0 + step(0.0, sd.y); }
        else { uv = sd.xy / a.z; face = 5.0 + step(0.0, sd.z); }
        uv = uv * 0.5 + 0.5 + face * vec2(3.17, 5.31);
        vec3 st = starLayer(uv * 110.0, 0.30, 0.05, 0.11, 3.0) * 0.8
                + starLayer(uv * 46.0 + 7.7, 0.11, 0.07, 0.15, 2.0) * 1.4;
        float band = exp(-pow(dot(sd, normalize(vec3(0.35, 0.55, 0.76))), 2.0) * 22.0);
        float mw = band * (0.3 + 0.7 * fbm3(uv * 9.0));
        st += vec3(0.55, 0.62, 0.85) * mw * 0.16;
        col += st * uStars * smoothstep(-0.02, 0.18, y);
      }

      // ---- moon (phase from real geometry: lit where the sphere normal faces the sun)
      float mm = dot(dir, uMoonDir);
      if (uMoonVis > 0.001 && mm > 0.995) {
        vec3 mr = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDir));
        vec3 mup = cross(uMoonDir, mr);
        vec2 q = vec2(dot(dir, mr), dot(dir, mup)) / 0.026;
        float rr = dot(q, q);
        float inDisc = 1.0 - smoothstep(0.86, 1.0, rr);
        float nz = sqrt(max(0.0, 1.0 - min(rr, 1.0)));
        vec3 nW = mr * q.x + mup * q.y + uMoonDir * nz;
        float litM = smoothstep(-0.06, 0.22, dot(nW, uSunDir));
        float mar = 0.80 + 0.20 * vnoise(q * 2.6 + 11.0);
        vec3 moonCol = uMoonColor * mar * (0.035 + 0.965 * litM);
        col = mix(col, moonCol, inDisc * uMoonVis);
      }
      col += uMoonColor * pow(max(mm, 0.0), 260.0) * 0.32 * uMoonVis * uMoonBright;

      // ---- sun disc
      float disc = smoothstep(0.99955, 0.99985, mu);
      col += uSunColor * disc * 2.5 * uSunVis;

      // ---- clouds: fbm on a projected plane, lit from the sun side
      float cl = 0.0;
      if (y > -0.02 && uCloud > 0.001) {
        float hy = max(y, 0.0);
        vec2 cuv = dir.xz / (hy + 0.15) * 0.75 + uCloudOff;
        float n = fbm5(cuv);
        float cover = mix(0.72, 0.36, uCloud);
        float dens = smoothstep(cover, cover + 0.30, n);
        vec2 toSun = normalize(uSunDir.xz + vec2(0.0005, 0.0003));
        float n2 = fbm5(cuv + toSun * 0.09);
        float lit = clamp(0.5 + (n - n2) * 7.0, 0.0, 1.0);
        vec3 ccol = mix(uCloudShade, uCloudLit, lit) * (1.0 - dens * 0.22);
        ccol += uSunColor * pow(muP, 40.0) * 0.6 * (1.0 - dens) * uSunVis;
        cl = dens * smoothstep(0.0, 0.11, y);
        col = mix(col, ccol, cl);
      }

      // ---- glow that survives thin clouds, lightning
      col += uSunColor * (pow(muP, 120.0) * 0.55 + pow(muP, 400.0) * 0.8) * uSunVis * (1.0 - cl * 0.85);
      col += uFlash * vec3(0.72, 0.78, 1.0) * (0.35 + cl * 1.4);

      gl_FragColor = vec4(col, 1.0);
      #include <tonemapping_fragment>
      #include <colorspace_fragment>
    }`;

  const PRECIP_VERT = `
    attribute vec3 aSeed;
    attribute float aSize;
    uniform vec3 uCam;
    uniform vec2 uWindAcc;
    uniform float uFallAcc, uTime, uBox, uMode, uScale, uSizeMul;
    varying float vFade;
    void main() {
      float box = uBox;
      float sm = 0.8 + 0.1 * floor(aSeed.x * 4.999);
      vec3 p = aSeed * box;
      p.y -= uFallAcc * sm;
      p.xz += uWindAcc;
      if (uMode > 0.5) {
        p.x += sin(uTime * 0.5 + aSeed.y * 6.2831853) * 1.6;
        p.z += cos(uTime * 0.7 + aSeed.z * 6.2831853) * 1.6;
      }
      vec3 rel = p - uCam;
      rel -= box * floor(rel / box + 0.5);
      vec3 world = uCam + rel;
      vec4 mv = viewMatrix * vec4(world, 1.0);
      gl_Position = projectionMatrix * mv;
      float dist = max(-mv.z, 0.05);
      gl_PointSize = aSize * uSizeMul * uScale / dist;
      float edge = 1.0 - smoothstep(box * 0.32, box * 0.5, length(rel));
      vFade = smoothstep(0.4, 2.2, dist) * edge;
    }`;
  const PRECIP_FRAG = `
    precision mediump float;
    uniform sampler2D uTex;
    uniform vec3 uColor;
    uniform float uOpacity;
    varying float vFade;
    void main() {
      float a = texture2D(uTex, gl_PointCoord).a;
      gl_FragColor = vec4(uColor, a * uOpacity * vFade);
    }`;

  // ------------------------------------------------------------------ state
  let _scene = null, _renderer = null, _inited = false;
  let dome = null, domeMat = null, U = null;          // U = dome uniforms
  let sun = null, moon = null, hemi = null, ambient = null, fog = null;
  let rain = null, rainMat = null, snow = null, snowMat = null, bolt = null, boltPos = null, boltMat = null;
  let _t = 0;                                         // private clock (seconds of gameplay)
  let _dayIndex = 0, _lastHour = -1;
  let _phase = 'day', _phaseSet = false;
  let _lightLevel = 1;
  let _shadowSize = SHADOW_SIZE_DEFAULT;
  let _weather = 'clear', _targetWeather = 'clear', _autoWeather = true, _nextRoll = 0;
  const _wc = {}, _wf = {}; let _wt = 1;              // current / from snapshot / transition progress
  let _zoneId = null, _zone = null, _zoneDark = false, _zoneWeight = 0.4;
  const _zoneFog = new THREE.Color(0xc9d6e6);
  let _flash = 0, _flash2At = -1, _nextBolt = 0, _thunderAt = -1, _thunderVol = 1, _boltUntil = 0;
  let _fallAcc = 0, _windX = 0, _windZ = 0, _cloudOffX = 0, _cloudOffY = 0;
  let _insideMul = 1, _insideCheckAt = 0, _lastRainAudio = -1, _lastShadowWant = null;
  let _moonPhase = MOON_PHASE0, _sunElev = 0;

  // pooled temporaries
  const _sunDir = new THREE.Vector3(1, 0, 0), _moonDir = new THREE.Vector3(-1, 0, 0), _moonLightDir = new THREE.Vector3(0, 1, 0);
  const _lastPos = new THREE.Vector3(), _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
  const _xAxis = new THREE.Vector3(), _yAxis = new THREE.Vector3(), _zAxis = new THREE.Vector3(), _upV = new THREE.Vector3(0, 1, 0);
  const _zero = new THREE.Vector3(0, 0, 0), _altUp = new THREE.Vector3(0, 0, 1), _sunDirOut = new THREE.Vector3();
  let _insideTarget = 1, _snowFall = 0;
  const _m4 = new THREE.Matrix4(), _size = new THREE.Vector2();
  const _pal = { zen: new THREE.Color(), hor: new THREE.Color(), haze: new THREE.Color(), lit: new THREE.Color(), shade: new THREE.Color() };
  const _zen = new THREE.Color(), _hor = new THREE.Color(), _haze = new THREE.Color(), _ground = new THREE.Color();
  const _lit = new THREE.Color(), _shade = new THREE.Color();
  const _sunLight = new THREE.Color(), _sunDisc = new THREE.Color(), _skyHor = new THREE.Color(), _fogTarget = new THREE.Color();
  const _zoneFogAdj = new THREE.Color(), _c1 = new THREE.Color(), _c2 = new THREE.Color(), _skyOut = new THREE.Color();

  for (const p of WPARAMS) { _wc[p] = WEATHER.clear[p]; _wf[p] = WEATHER.clear[p]; }

  // ------------------------------------------------------------------ init
  function init(scene, renderer) {
    if (_inited || !scene) return;
    _scene = scene; _renderer = renderer || null;
    const T = G.time || (G.time = {});
    if (typeof T.dayTime !== 'number') T.dayTime = 8.0;
    if (!(T.dayLengthMinutes > 0)) T.dayLengthMinutes = 24;
    if (renderer && renderer.shadowMap && !renderer.shadowMap.enabled) {
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    }

    // --- sky dome
    U = {
      uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uHaze: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uSunColor: { value: new THREE.Color() }, uMoonColor: { value: MOON_DISC_COLOR.clone() },
      uSunVis: { value: 1 }, uGlow: { value: 1 }, uHazeAmt: { value: 1 }, uMoonVis: { value: 0 }, uMoonBright: { value: 1 },
      uStars: { value: 0 }, uTime: { value: 0 }, uCloud: { value: 0.3 }, uFlash: { value: 0 },
      uCloudOff: { value: new THREE.Vector2() }, uCloudLit: { value: new THREE.Color() }, uCloudShade: { value: new THREE.Color() },
      uStarMat: { value: new THREE.Matrix3() },
    };
    domeMat = new THREE.ShaderMaterial({
      uniforms: U, vertexShader: SKY_VERT, fragmentShader: SKY_FRAG,
      side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false, lights: false,
    });
    dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 48, 24), domeMat);
    dome.name = 'skyDome'; dome.renderOrder = -1000; dome.frustumCulled = false;
    dome.matrixAutoUpdate = true; dome.castShadow = false; dome.receiveShadow = false;
    scene.add(dome);

    // --- lights
    sun = new THREE.DirectionalLight(0xfff4e6, 3.0);
    sun.name = 'sun';
    sun.position.set(100, 200, 50);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_SIZE_DEFAULT, SHADOW_SIZE_DEFAULT);
    const sc = sun.shadow.camera;
    sc.left = -SHADOW_BOUNDS; sc.right = SHADOW_BOUNDS; sc.top = SHADOW_BOUNDS; sc.bottom = -SHADOW_BOUNDS;
    sc.near = 5; sc.far = 460; sc.updateProjectionMatrix();
    sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.02;
    scene.add(sun); scene.add(sun.target);

    moon = new THREE.DirectionalLight(MOON_LIGHT_COLOR.getHex(), 0);
    moon.name = 'moon'; moon.castShadow = false;
    moon.position.set(-100, 200, -50);
    scene.add(moon); scene.add(moon.target);

    hemi = new THREE.HemisphereLight(0x9ec4f0, 0x7a6848, 0.6); hemi.name = 'hemi';
    scene.add(hemi);
    ambient = new THREE.AmbientLight(0xc4d4ec, 0.25); ambient.name = 'ambient';
    scene.add(ambient);

    // --- fog
    fog = new THREE.Fog(0xc9d6e6, FOG_NEAR, FOG_FAR);
    scene.fog = fog;

    // --- precipitation
    const rng = (typeof G.rng === 'function') ? G.rng(4242) : _rng(4242);
    const rainTex = makeTexture(16, 64, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
      g.addColorStop(0.75, 'rgba(255,255,255,0.9)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(w * 0.5 - 1.5, 0, 3, h);
      ctx.globalAlpha = 0.35; ctx.fillRect(w * 0.5 - 3, 0, 6, h);
    });
    const snowTex = makeTexture(32, 32, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,255,255,0.85)');
      g.addColorStop(0.7, 'rgba(255,255,255,0.25)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    });
    function makePrecip(count, tex, mode, color, opacity, blending, sizeMin, sizeMax) {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(count * 3), seed = new Float32Array(count * 3), size = new Float32Array(count);
      for (let i = 0; i < count; i++) {
        seed[i * 3] = rng(); seed[i * 3 + 1] = rng(); seed[i * 3 + 2] = rng();
        size[i] = sizeMin + (sizeMax - sizeMin) * rng();
      }
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
      geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTex: { value: tex }, uColor: { value: new THREE.Color(color) }, uOpacity: { value: opacity },
          uCam: { value: new THREE.Vector3() }, uWindAcc: { value: new THREE.Vector2() },
          uFallAcc: { value: 0 }, uTime: { value: 0 }, uBox: { value: PRECIP_BOX }, uMode: { value: mode },
          uScale: { value: 600 }, uSizeMul: { value: 1 },
        },
        vertexShader: PRECIP_VERT, fragmentShader: PRECIP_FRAG,
        transparent: true, depthWrite: false, depthTest: true, blending, fog: false, lights: false,
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false; pts.renderOrder = 900; pts.visible = false; pts.matrixAutoUpdate = false;
      return pts;
    }
    rain = makePrecip(RAIN_COUNT, rainTex, 0, 0xcfe0ff, 0.5, THREE.AdditiveBlending, 0.34, 0.62); rain.name = 'rain';
    snow = makePrecip(SNOW_COUNT, snowTex, 1, 0xffffff, 0.85, THREE.NormalBlending, 0.10, 0.22); snow.name = 'snow';
    rainMat = rain.material; snowMat = snow.material;
    scene.add(rain); scene.add(snow);

    // --- lightning bolt
    const boltGeo = new THREE.BufferGeometry();
    boltPos = new Float32Array(2 * 40 * 3);
    boltGeo.setAttribute('position', new THREE.BufferAttribute(boltPos, 3));
    boltGeo.setDrawRange(0, 0);
    boltGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    boltMat = new THREE.LineBasicMaterial({ color: 0xdfe8ff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false });
    bolt = new THREE.LineSegments(boltGeo, boltMat);
    bolt.frustumCulled = false; bolt.visible = false; bolt.renderOrder = 890; bolt.matrixAutoUpdate = false;
    scene.add(bolt);

    // --- initial state
    _weather = _targetWeather = (G.state && WEATHER[G.state.weather]) ? G.state.weather : 'clear';
    for (const p of WPARAMS) { _wc[p] = WEATHER[_weather][p]; _wf[p] = _wc[p]; }
    _wt = 1;
    if (G.state) G.state.weather = _weather;
    _nextRoll = 120 + rand() * 180;
    _nextBolt = 2 + rand() * 4;
    if (typeof G.on === 'function') {
      G.on('zoneChanged', onZoneChanged);
    }
    _inited = true;
    _lastPos.set(0, 0, 0);
    update(0, _lastPos);
    _phaseSet = true;
    publish();
  }

  function onZoneChanged() {
    // re-roll soon if the current weather is impossible in the new zone (e.g. snow in the Shire)
    refreshZone(true);
    const w = zoneWeights();
    if (!(w[_targetWeather] > 0)) _nextRoll = Math.min(_nextRoll, _t + 12 + rand() * 18);
  }

  // ------------------------------------------------------------------ zone
  function refreshZone(force) {
    const zid = (G.state && G.state.zone) || null;
    if (!force && zid === _zoneId) return;
    _zoneId = zid; _zone = null;
    const w = G.Data && G.Data.world;
    if (w && zid) {
      if (w.zoneById && w.zoneById[zid]) _zone = w.zoneById[zid];
      else if (Array.isArray(w.zones)) { for (let i = 0; i < w.zones.length; i++) if (w.zones[i].id === zid) { _zone = w.zones[i]; break; } }
    }
    const biome = _zone && _zone.biome ? String(_zone.biome) : '';
    _zoneDark = !!DARK_BIOMES[biome.split('/')[0]];
    _zoneWeight = _zoneDark ? 0.55 : 0.4;
    setColorFrom(_zoneFog, _zone ? _zone.fogColor : null, KEYS[7].hor);
  }
  function zoneWeights() {
    if (_zone && _zone.weatherWeights) return _zone.weatherWeights;
    const biome = _zone && _zone.biome ? String(_zone.biome).split('/')[0] : '';
    return BIOME_WEIGHTS[biome] || DEFAULT_WEIGHTS;
  }
  function rollWeather() {
    refreshZone(false);
    const w = zoneWeights();
    let total = 0;
    for (let i = 0; i < WEATHER_KINDS.length; i++) total += Math.max(0, +w[WEATHER_KINDS[i]] || 0);
    let kind = 'clear';
    if (total > 0) {
      let r = rand() * total;
      for (let i = 0; i < WEATHER_KINDS.length; i++) {
        const k = WEATHER_KINDS[i], wk = Math.max(0, +w[k] || 0);
        if (r < wk) { kind = k; break; }
        r -= wk;
      }
    }
    _nextRoll = _t + 240 + rand() * 300;
    setWeather(kind);
    return kind;
  }

  // ------------------------------------------------------------------ weather
  function setWeather(kind, immediate) {
    if (!WEATHER[kind]) return;
    const changed = kind !== _weather;
    if (kind !== _targetWeather || immediate) {
      _targetWeather = kind;
      if (immediate) { for (const p of WPARAMS) { _wc[p] = WEATHER[kind][p]; _wf[p] = _wc[p]; } _wt = 1; }
      else { for (const p of WPARAMS) _wf[p] = _wc[p]; _wt = 0; }
    }
    _weather = kind;
    if (G.state) G.state.weather = kind;
    if (changed && typeof G.emit === 'function') G.emit('weatherChanged', kind);
  }

  function lightning() {
    _flash = 1.0; _flash2At = _t + 0.11 + rand() * 0.08;
    _thunderAt = _t + 1 + rand() * 2;
    // bolt geometry: jagged line from the cloud base to the ground, 140-360 m away
    const ang = rand() * TWO_PI, distB = 140 + rand() * 220;
    const bx = _lastPos.x + Math.cos(ang) * distB, bz = _lastPos.z + Math.sin(ang) * distB;
    let gy = 0;
    if (G.Terrain && typeof G.Terrain.height === 'function') { const h = G.Terrain.height(bx, bz); if (typeof h === 'number' && h === h) gy = Math.max(h, (G.C && G.C.SEA_LEVEL) || 0); }
    const top = gy + 170 + rand() * 60, segs = 16;
    let n = 0, x = bx, y = top, z = bz;
    const step = (top - gy) / segs;
    let px = x, py = y, pz = z;
    for (let i = 1; i <= segs && n < 78; i++) {
      x = bx + (rand() - 0.5) * 14 * (i / segs + 0.3); z = bz + (rand() - 0.5) * 14 * (i / segs + 0.3); y = top - step * i;
      if (i === segs) { x = px + (rand() - 0.5) * 4; z = pz + (rand() - 0.5) * 4; y = gy; }
      boltPos[n * 3] = px; boltPos[n * 3 + 1] = py; boltPos[n * 3 + 2] = pz; n++;
      boltPos[n * 3] = x; boltPos[n * 3 + 1] = y; boltPos[n * 3 + 2] = z; n++;
      if (i === 5 || i === 9) { // side branch
        const ex = x + (rand() - 0.5) * 40, ez = z + (rand() - 0.5) * 40, ey = y - 25 - rand() * 30;
        boltPos[n * 3] = x; boltPos[n * 3 + 1] = y; boltPos[n * 3 + 2] = z; n++;
        boltPos[n * 3] = ex; boltPos[n * 3 + 1] = ey; boltPos[n * 3 + 2] = ez; n++;
      }
      px = x; py = y; pz = z;
    }
    bolt.geometry.setDrawRange(0, n);
    bolt.geometry.attributes.position.needsUpdate = true;
    bolt.visible = true; _boltUntil = _t + 0.14 + rand() * 0.1;
    _thunderVol = clamp(1.15 - distB / 500, 0.35, 1);
  }

  // ------------------------------------------------------------------ update
  function update(dt, playerPos) {
    if (!_inited) return;
    if (typeof dt !== 'number' || dt !== dt || dt < 0) dt = 0;
    if (dt > 0.1) dt = 0.1;
    _t += dt;
    if (playerPos && typeof playerPos.x === 'number') _lastPos.copy(playerPos);
    const pos = _lastPos;
    const T = G.time || (G.time = {});

    // ---- clock
    if (!T.paused && dt > 0) {
      const dayLen = (T.dayLengthMinutes > 0 ? T.dayLengthMinutes : 24) * 60;
      let h = (typeof T.dayTime === 'number' ? T.dayTime : 8) + dt * 24 / dayLen;
      if (h >= 24) { h -= 24; if (h >= 24) h = mod(h, 24); _dayIndex++; }
      T.dayTime = h;
    }
    const hour = mod(typeof T.dayTime === 'number' ? T.dayTime : 8, 24);
    if (_lastHour >= 0 && hour < _lastHour - 12) _dayIndex++;   // wrapped via setTime/paused math
    _lastHour = hour;

    // ---- celestial geometry
    const th = sunTheta(hour);
    _sunDir.set(Math.cos(th), Math.sin(th) * COS_T, Math.sin(th) * SIN_T);
    const e = _sunElev = _sunDir.y;
    _moonPhase = mod(MOON_PHASE0 + (_dayIndex + hour / 24) / SYNODIC_DAYS, 1);
    const thm = th + _moonPhase * TWO_PI;
    _moonDir.set(Math.cos(thm), Math.sin(thm) * COS_M, Math.sin(thm) * SIN_M);
    const em = _moonDir.y;
    const moonLit = 0.5 - 0.5 * Math.cos(_moonPhase * TWO_PI);   // 1 = full
    const night = 1 - smooth(-0.12, 0.12, e);
    const dawnGlow = 1 - smooth(0, 0.18, Math.abs(e));

    // ---- weather transition + automatic weather + lightning
    if (_wt < 1) {
      _wt = Math.min(1, _wt + (dt > 0 ? dt / WEATHER_TRANSITION : 1));
      const s = _wt * _wt * (3 - 2 * _wt);
      const tw = WEATHER[_targetWeather];
      for (let i = 0; i < WPARAMS.length; i++) { const p = WPARAMS[i]; _wc[p] = _wf[p] + (tw[p] - _wf[p]) * s; }
    }
    refreshZone(false);
    if (_autoWeather && _t >= _nextRoll) rollWeather();
    const grey = _wc.grey, dark = _wc.darken, storminess = _wc.storm;
    if (storminess > 0.5 && _t >= _nextBolt) { lightning(); _nextBolt = _t + 4 + rand() * 11; }
    if (_flash2At > 0 && _t >= _flash2At) { _flash = Math.max(_flash, 0.6); _flash2At = -1; }
    if (_flash > 0) { _flash *= Math.exp(-dt * 13); if (_flash < 0.003) _flash = 0; }
    if (bolt.visible && _t >= _boltUntil) bolt.visible = false;
    if (_thunderAt > 0 && _t >= _thunderAt) {
      _thunderAt = -1;
      if (G.Audio && typeof G.Audio.sfx === 'function') G.Audio.sfx('thunder', { vol: _thunderVol * (0.7 + rand() * 0.3), pitch: 0.85 + rand() * 0.3 });
    }
    const flash = _flash * (0.6 + 0.4 * storminess);

    // ---- palette (time of day → weather adjusted)
    samplePalette(hour, _pal);
    weatherTint(_pal.zen, _zen, grey, dark, 0.55, 0.9, 0);
    weatherTint(_pal.hor, _hor, grey, dark, 0.45, 0.8, 0);
    weatherTint(_pal.haze, _haze, grey, dark, 0.7, 0.8, 0);
    weatherTint(_pal.lit, _lit, grey, dark, 0.8, 0.55, grey * 0.35);
    weatherTint(_pal.shade, _shade, grey, dark, 0.8, 0.75, grey * 0.45);
    _ground.copy(_hor).multiplyScalar(0.5);
    ramp(SUN_LIGHT_RAMP, e, _sunLight);
    ramp(SUN_DISC_RAMP, e, _sunDisc);
    const sunVis = smooth(-0.06, 0.01, e);
    const hazeAmt = _wc.hazeMul * (0.85 + 1.1 * dawnGlow);

    // ---- dome uniforms
    U.uZenith.value.copy(_zen); U.uHorizon.value.copy(_hor); U.uHaze.value.copy(_haze); U.uGround.value.copy(_ground);
    U.uSunDir.value.copy(_sunDir); U.uMoonDir.value.copy(_moonDir);
    U.uSunColor.value.copy(_sunDisc);
    U.uSunVis.value = sunVis;
    U.uGlow.value = (0.9 + 1.8 * (1 - smooth(0, 0.35, e))) * (1 - grey * 0.5);
    U.uHazeAmt.value = hazeAmt;
    U.uMoonVis.value = smooth(-0.03, 0.04, em) * (0.28 + 0.72 * (1 - smooth(-0.12, 0.05, e))) * (1 - grey * 0.3);
    U.uMoonBright.value = 0.15 + 0.85 * moonLit;
    U.uStars.value = (1 - smooth(-0.16, 0.0, e)) * (1 - grey * 0.5);
    U.uTime.value = _t % 600;
    U.uCloud.value = _wc.cloud;
    U.uFlash.value = flash;
    _cloudOffX += dt * 0.0045 * _wc.wind; _cloudOffY += dt * 0.0018 * _wc.wind;
    if (_cloudOffX > 1000) _cloudOffX -= 1000; if (_cloudOffY > 1000) _cloudOffY -= 1000;
    U.uCloudOff.value.set(_cloudOffX, _cloudOffY);
    U.uCloudLit.value.copy(_lit); U.uCloudShade.value.copy(_shade);
    _v1.set(0, -SIN_T, COS_T);                          // sun's rotation axis → the stars wheel around it
    _m4.makeRotationAxis(_v1, -th * 0.98 + 0.4);
    U.uStarMat.value.setFromMatrix4(_m4);

    // dome follows the camera (or the player when no camera exists yet)
    const cam = G.Player && G.Player.camera;
    const cpos = (cam && cam.position) ? cam.position : pos;
    dome.position.copy(cpos);

    // ---- lights
    const sunI = 3.0 * Math.pow(clamp((e + 0.05) / 0.4, 0, 1), 0.7) * _wc.sunMul;
    sun.color.copy(_sunLight).lerp(FLASH_COLOR, flash * 0.8);
    sun.intensity = sunI + flash * 2.4;
    const wantShadow = _shadowSize > 0 && !(G.state && G.state.settings && G.state.settings.shadows === false);
    if (wantShadow !== _lastShadowWant) { sun.castShadow = wantShadow; _lastShadowWant = wantShadow; }
    // shadow direction: use the sun while it's up; keep the frustum sane at night (light from above)
    _v2.copy(_sunDir);
    if (e < 0.08) { _v2.lerp(_upV, 1 - smooth(-0.02, 0.08, e)); _v2.normalize(); }
    placeLight(sun, _v2, pos, wantShadow);

    const moonUp = smooth(-0.05, 0.15, em);
    const moonI = 0.35 * (0.3 + 0.7 * moonLit) * moonUp * night * (1 - grey * 0.6);
    const starlight = 0.10 * night * (1 - grey * 0.4);
    moon.color.copy(MOON_LIGHT_COLOR);
    moon.intensity = Math.max(moonI, starlight);
    _moonLightDir.copy(_moonDir).lerp(_upV, 1 - smooth(0, 0.15, em)).normalize();
    placeLight(moon, _moonLightDir, pos, false);

    // hemisphere: sky colour from the palette (desaturated at twilight), warm ground by day / cool by night
    _c1.copy(_zen).lerp(_hor, 0.45);
    const hl = lum(_c1); _c2.setRGB(hl, hl, hl);
    _c1.lerp(_c2, dawnGlow * 0.45);
    hemi.color.copy(_c1).lerp(FLASH_COLOR, flash * 0.5);
    hemi.groundColor.copy(HEMI_GROUND_DAY).lerp(_sunLight, 0.25).lerp(HEMI_GROUND_NIGHT, night);
    hemi.intensity = lerp(0.6, 0.22, night) * (1 - grey * 0.2) + flash * 0.6;

    _lightLevel = clamp(smooth(-0.08, 0.28, e) * (1 - dark * 0.55) + night * (0.05 + 0.15 * moonLit * moonUp), 0, 1);
    ambient.color.copy(AMBIENT_DAY).lerp(AMBIENT_NIGHT, night);
    ambient.intensity = 0.25 * (0.55 + 0.45 * _lightLevel) + flash * 0.3;

    // ---- fog: sky horizon (incl. average haze glow) blended with the zone's fog colour, denser when dark/wet
    const hk = 0.5 * hazeAmt * 0.5;
    _skyHor.setRGB(_hor.r + _haze.r * hk, _hor.g + _haze.g * hk, _hor.b + _haze.b * hk);
    const lumScale = clamp(lum(_skyHor) / NOON_HORIZON_LUM, 0, 1.2);
    _zoneFogAdj.copy(_zoneFog).multiplyScalar(lumScale);
    _fogTarget.copy(_skyHor).lerp(_zoneFogAdj, _zoneWeight);
    let far = _wc.fogFar;
    far = lerp(far, Math.min(far, FOG_FAR_DENSE), night);
    if (_zoneDark) far = Math.min(far, FOG_FAR_DENSE);
    const near = clamp(far * (FOG_NEAR / FOG_FAR), 40, FOG_NEAR);
    const k = dt > 0 ? 1 - Math.exp(-dt * 1.2) : 1;
    fog.color.lerp(_fogTarget, k);
    fog.near += (near - fog.near) * k;
    fog.far += (far - fog.far) * k;

    // ---- terrain hooks
    const Tr = G.Terrain;
    if (Tr) {
      if (typeof Tr.setSkyColor === 'function') Tr.setSkyColor(_skyHor);
      if (typeof Tr.setSun === 'function') {
        if (sunI >= moon.intensity) Tr.setSun(_sunDir, sun.color, sun.intensity);
        else Tr.setSun(_moonLightDir, moon.color, moon.intensity);
      }
    }

    // ---- precipitation
    if (_t >= _insideCheckAt) {
      _insideCheckAt = _t + 0.25;
      let inside = false;
      if (G.Buildings && typeof G.Buildings.isInside === 'function') { try { inside = !!G.Buildings.isInside(pos); } catch (err) { inside = false; } }
      _insideTarget = inside ? 0 : 1;
    }
    _insideMul += (_insideTarget - _insideMul) * (dt > 0 ? Math.min(1, dt * 4) : 1);
    const rainLevel = clamp(_wc.rain, 0, 1.6), snowLevel = clamp(_wc.snow, 0, 1);
    let scale = 600;
    if (_renderer && typeof _renderer.getDrawingBufferSize === 'function') {
      _renderer.getDrawingBufferSize(_size);
      const fov = (cam && cam.isPerspectiveCamera) ? cam.fov : 60;
      scale = _size.y * 0.5 / Math.tan(fov * Math.PI / 360);
    }
    const windSpeed = 2.5 * _wc.wind;
    _windX = mod(_windX + windSpeed * 0.7 * dt, PRECIP_BOX); _windZ = mod(_windZ + windSpeed * 0.3 * dt, PRECIP_BOX);
    const rainVis = rainLevel * _insideMul, snowVis = snowLevel * _insideMul;
    if (rainVis > 0.01) {
      _fallAcc = mod(_fallAcc + RAIN_FALL * dt, PRECIP_BOX * 10);
      const u = rainMat.uniforms;
      u.uCam.value.copy(cpos); u.uFallAcc.value = _fallAcc; u.uWindAcc.value.set(_windX, _windZ);
      u.uScale.value = scale; u.uOpacity.value = 0.55 * Math.min(1, rainVis); u.uSizeMul.value = 0.9 + 0.25 * Math.min(1, rainLevel / 1.6);
      u.uTime.value = _t % SWAY_PERIOD;
      rain.visible = true;
    } else rain.visible = false;
    if (snowVis > 0.01) {
      _snowFall = mod(_snowFall + SNOW_FALL * dt, PRECIP_BOX * 10);
      const u = snowMat.uniforms;
      u.uCam.value.copy(cpos); u.uFallAcc.value = _snowFall; u.uWindAcc.value.set(_windX * 0.5, _windZ * 0.5);
      u.uScale.value = scale; u.uOpacity.value = 0.9 * Math.min(1, snowVis); u.uTime.value = _t % SWAY_PERIOD;
      snow.visible = true;
    } else snow.visible = false;
    const rainAudio = clamp(rainLevel / 1.6, 0, 1) * (0.4 + 0.6 * _insideMul);
    if (Math.abs(rainAudio - _lastRainAudio) > 0.02 || (rainAudio === 0 && _lastRainAudio !== 0)) {
      _lastRainAudio = rainAudio;
      if (G.Audio && typeof G.Audio.setAmbientRain === 'function') G.Audio.setAmbientRain(rainAudio);
    }

    // ---- phase
    let phase;
    if (e >= 0.22) phase = 'day';
    else if (e < -0.12) phase = 'night';
    else phase = (hour < 12) ? 'dawn' : 'dusk';
    if (phase !== _phase) {
      _phase = phase;
      if (_phaseSet && typeof G.emit === 'function') G.emit('dayPhase', phase);
    }
    publish();
  }

  // position a directional light at target + dir*SHADOW_DIST; snap the shadow frustum to its texel grid
  function placeLight(light, dir, target, snap) {
    _v3.copy(target);
    if (snap) {
      const texel = (SHADOW_BOUNDS * 2) / (light.shadow.mapSize.x || SHADOW_SIZE_DEFAULT);
      _m4.lookAt(dir, _zero, Math.abs(dir.y) > 0.99 ? _altUp : _upV);
      _m4.extractBasis(_xAxis, _yAxis, _zAxis);
      const lx = _v3.dot(_xAxis), ly = _v3.dot(_yAxis);
      const sx = Math.round(lx / texel) * texel - lx, sy = Math.round(ly / texel) * texel - ly;
      _v3.addScaledVector(_xAxis, sx).addScaledVector(_yAxis, sy);
    }
    light.target.position.copy(_v3);
    light.position.copy(_v3).addScaledVector(dir, SHADOW_DIST);
    light.target.updateMatrixWorld();
  }

  function publish() {
    const S = G.Sky;
    S.phase = _phase; S.lightLevel = _lightLevel; S.weather = _weather; S.targetWeather = _targetWeather;
    S.cloudiness = _wc.cloud; S.rainLevel = clamp(_wc.rain / 1.6, 0, 1); S.snowLevel = clamp(_wc.snow, 0, 1);
    S.sunElevation = _sunElev; S.moonPhase = _moonPhase; S.dayIndex = _dayIndex;
    S.sun = sun; S.moon = moon; S.hemi = hemi; S.ambient = ambient; S.fog = fog; S.dome = dome;
  }

  // ------------------------------------------------------------------ public setters
  function setTime(hours) {
    if (typeof hours !== 'number' || hours !== hours) return;
    const T = G.time || (G.time = {});
    T.dayTime = mod(hours, 24);
    if (_inited) { const p = T.paused; T.paused = true; update(0, _lastPos); T.paused = p; }
  }
  function setShadowQuality(size) {
    size = size | 0;
    if (!sun) { _shadowSize = size; return; }
    if (size <= 0) { _shadowSize = 0; return; }
    size = clamp(size, 256, 4096);
    _shadowSize = size;
    if (sun.shadow.mapSize.x !== size) {
      sun.shadow.mapSize.set(size, size);
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      if (sun.shadow.mapPass) { sun.shadow.mapPass.dispose(); sun.shadow.mapPass = null; }
    }
  }
  function getSkyColor(out) { return (out && out.isColor ? out : _skyOut).copy(_skyHor); }
  function getSunDir(out) { return (out && out.isVector3 ? out : _sunDirOut).copy(_sunDir); }

  G.Sky = {
    init, update, setTime, setWeather, setShadowQuality, getSkyColor, getSunDir, rollWeather, lightning, sunTheta,
    sun: null, moon: null, hemi: null, ambient: null, fog: null, dome: null,
    phase: _phase, lightLevel: 1, weather: 'clear', targetWeather: 'clear', cloudiness: 0.3, rainLevel: 0, snowLevel: 0,
    sunDir: _sunDir, moonDir: _moonDir, sunElevation: 0, moonPhase: MOON_PHASE0, dayIndex: 0,
    WEATHER_KINDS: WEATHER_KINDS.slice(),
    get autoWeather() { return _autoWeather; },
    set autoWeather(v) { _autoWeather = !!v; if (_autoWeather) _nextRoll = Math.max(_nextRoll, _t + 30); },
  };
})();
