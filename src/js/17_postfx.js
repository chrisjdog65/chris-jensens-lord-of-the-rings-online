/* ==== 17_postfx.js — Post-processing pipeline (G.PostFX). Self-written (no EffectComposer): the scene is
 * rendered into a linear HalfFloat render target, a soft-knee bright pass (half res) feeds a 2-iteration
 * separable 9-tap gaussian blur (quarter res, ping-pong), then a tonemap pass (bloom add → exposure → linear
 * filmic contrast around 18 % grey → ACES filmic → saturation/split-tone/vignette → sRGB encode, luma in
 * alpha) writes an 8-bit LDR target and a
 * final pass applies FXAA 3.11 (quality preset 12), CAS-style edge-aware sharpening and film grain straight
 * to the screen. Quality presets drive pixel ratio / render scale, bloom resolution, shadow map size
 * (G.Sky.setShadowQuality) and vegetation density (G.Veg.setDensity).
 *
 * Public API (spec §5.8 + extras):
 *   G.PostFX.init(renderer, scene, camera)   G.PostFX.render(scene?, camera?)   G.PostFX.resize(w?, h?)
 *   G.PostFX.setQuality('ultra'|'high'|'medium'|'low'|'auto')   → applied name; stores G.state.quality
 *   G.PostFX.enabled (bool)   G.PostFX.params { bloom, exposure, vignette, saturation, contrast,
 *        bloomThreshold, bloomRadius, grain, sharpen, tint, aberration, tonemap }
 *   G.PostFX.features { bloom, fxaa }  (set by presets, user-overridable)   G.PostFX.quality   G.PostFX.PRESETS
 *   G.PostFX.renderPass(material, target)   G.PostFX.fullscreenTriangle   G.PostFX.sceneTarget
 *   G.PostFX.bloomTexture   G.PostFX.getSize(out?)   G.PostFX.stats { ms, width, height, hdr, passes }
 *   G.PostFX.warmup()   G.PostFX.dispose()   G.PostFX.ready / failed
 * Emits 'qualityChanged' (q) after a preset is applied.
 * Private helpers: _shadowFallback (sets sun shadow map size directly when G.Sky.setShadowQuality is absent).
 * ==== */
(function () {
  'use strict';
  const G = window.G;

  // ------------------------------------------------------------------------------------------------
  // Quality presets
  // ------------------------------------------------------------------------------------------------
  const PRESETS = {
    ultra:  { dprCap: 2.0, renderScale: 1.0,  bloom: true,  bloomScale: [0.5, 0.25],   fxaa: true, shadow: 4096, shadows: true,  density: 1.2 },
    high:   { dprCap: 1.5, renderScale: 1.0,  bloom: true,  bloomScale: [0.5, 0.25],   fxaa: true, shadow: 2048, shadows: true,  density: 1.0 },
    medium: { dprCap: 1.0, renderScale: 1.0,  bloom: true,  bloomScale: [0.25, 0.125], fxaa: true, shadow: 1024, shadows: true,  density: 0.6 },
    low:    { dprCap: 1.0, renderScale: 0.85, bloom: false, bloomScale: [0.25, 0.125], fxaa: true, shadow: 1024, shadows: false, density: 0.35 },
  };
  const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

  // ------------------------------------------------------------------------------------------------
  // Shaders
  // ------------------------------------------------------------------------------------------------
  const VERT = [
    'varying vec2 vUv;',
    'void main() {',
    '  vUv = position.xy * 0.5 + 0.5;',
    '  gl_Position = vec4(position.xy, 0.0, 1.0);',
    '}',
  ].join('\n');

  // Bright pass: 4-tap (4x4 texel) box downsample + soft-knee threshold + firefly clamp.
  const FRAG_BRIGHT = [
    'uniform sampler2D tSrc;',
    'uniform vec2 uTexel;',        // 1 / destination size
    'uniform float uThreshold;',
    'uniform float uKnee;',
    'uniform float uClamp;',
    'varying vec2 vUv;',
    'void main() {',
    '  vec2 o = uTexel * 0.5;',
    '  vec3 c = texture2D(tSrc, vUv + vec2(-o.x, -o.y)).rgb;',
    '  c += texture2D(tSrc, vUv + vec2( o.x, -o.y)).rgb;',
    '  c += texture2D(tSrc, vUv + vec2(-o.x,  o.y)).rgb;',
    '  c += texture2D(tSrc, vUv + vec2( o.x,  o.y)).rgb;',
    '  c = min(max(c * 0.25, 0.0), vec3(uClamp));',
    '  float br = max(c.r, max(c.g, c.b));',
    '  float knee = uThreshold * uKnee;',
    '  float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);',
    '  soft = soft * soft / (4.0 * knee + 0.0001);',
    '  float contrib = max(soft, br - uThreshold) / max(br, 0.0001);',
    '  gl_FragColor = vec4(c * contrib, 1.0);',
    '}',
  ].join('\n');

  // Separable 9-tap gaussian using 5 bilinear fetches.
  const FRAG_BLUR = [
    'uniform sampler2D tSrc;',
    'uniform vec2 uDir;',          // texel step (already scaled) along the blur axis
    'varying vec2 vUv;',
    'void main() {',
    '  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;',
    '  vec2 o1 = uDir * 1.3846153846;',
    '  vec2 o2 = uDir * 3.2307692308;',
    '  c += (texture2D(tSrc, vUv + o1).rgb + texture2D(tSrc, vUv - o1).rgb) * 0.3162162162;',
    '  c += (texture2D(tSrc, vUv + o2).rgb + texture2D(tSrc, vUv - o2).rgb) * 0.0702702703;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}',
  ].join('\n');

  // Tonemap / grade pass. Input: linear HDR scene + bloom. Output: sRGB-encoded colour, luma in alpha
  // (or alpha = 1 when writing to the screen directly).
  const FRAG_TONEMAP = [
    'uniform sampler2D tScene;',
    'uniform sampler2D tBloom;',
    'uniform float uBloom;',
    'uniform float uExposure;',
    'uniform float uSaturation;',
    'uniform float uContrast;',
    'uniform float uTint;',
    'uniform float uVignette;',
    'uniform float uAberration;',
    'uniform float uTonemap;',
    'uniform float uOutAlpha;',
    'uniform float uAspect;',
    'varying vec2 vUv;',
    'vec3 RRTAndODTFit(vec3 v) {',
    '  vec3 a = v * (v + 0.0245786) - 0.000090537;',
    '  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;',
    '  return a / b;',
    '}',
    'vec3 acesFilmic(vec3 color) {',
    '  const mat3 ACESInputMat = mat3(',
    '    vec3(0.59719, 0.07600, 0.02840),',
    '    vec3(0.35458, 0.90834, 0.13383),',
    '    vec3(0.04823, 0.01566, 0.83777));',
    '  const mat3 ACESOutputMat = mat3(',
    '    vec3( 1.60475, -0.10208, -0.00327),',
    '    vec3(-0.53108,  1.10813, -0.07276),',
    '    vec3(-0.07367, -0.00605,  1.07602));',
    '  color = color / 0.6;',
    '  color = ACESInputMat * color;',
    '  color = RRTAndODTFit(color);',
    '  color = ACESOutputMat * color;',
    '  return clamp(color, 0.0, 1.0);',
    '}',
    'float lumaLin(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }',
    'vec3 toSRGB(vec3 c) {',
    '  vec3 lo = c * 12.92;',
    '  vec3 hi = 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055;',
    '  return mix(lo, hi, step(vec3(0.0031308), c));',
    '}',
    'void main() {',
    '  vec3 col;',
    '  if (uAberration > 0.0) {',
    '    vec2 d = vUv - 0.5;',
    '    vec2 off = d * (uAberration * 0.012 * dot(d, d) * 4.0);',
    '    col.r = texture2D(tScene, vUv + off).r;',
    '    col.g = texture2D(tScene, vUv).g;',
    '    col.b = texture2D(tScene, vUv - off).b;',
    '  } else {',
    '    col = texture2D(tScene, vUv).rgb;',
    '  }',
    '  if (uBloom > 0.0) col += texture2D(tBloom, vUv).rgb * uBloom;',
    '  col = max(col * uExposure, vec3(0.0));',
    // Contrast is applied in LINEAR light around a 0.30 pivot (roughly a sunlit scene's average), BEFORE the
    // tonemap: the filmic shoulder rolls the lifted highlights off instead of clipping them, and shadows deepen
    // without the flat crush a post-sRGB stretch gives. The pivot keeps overall brightness where it was. The
    // strength eases back to 1.0 in the deepest lows so night scenes and forest floors keep their shadow detail
    // instead of going to solid black.
    '  if (uContrast != 1.0) {',
    '    float cw = smoothstep(0.004, 0.055, lumaLin(col));',
    '    float ce = mix(1.0, uContrast, cw);',
    '    col = pow(max(col, vec3(1e-5)) * 3.3333333, vec3(ce)) * 0.30;',
    '  }',
    '  if (uTonemap > 0.5) col = acesFilmic(col); else col = min(col, vec3(1.0));',
    '  float l = lumaLin(col);',
    '  col = mix(vec3(l), col, uSaturation);',
    // Split tone: warm shadows / cool highlights, with a touch of extra saturation left in the midtones.
    '  if (uTint > 0.0) {',
    '    float w = smoothstep(0.02, 0.62, l);',
    '    vec3 tc = mix(vec3(1.075, 0.995, 0.905), vec3(0.958, 0.992, 1.058), w);',
    '    col *= mix(vec3(1.0), tc, uTint);',
    '    col += uTint * (1.0 - w) * vec3(0.014, 0.008, 0.004);',
    '  }',
    '  if (uVignette > 0.0) {',
    '    vec2 q = (vUv - 0.5) * 2.0;',
    '    q.x *= uAspect;',
    '    float dv = length(q) / length(vec2(uAspect, 1.0));',
    '    col *= mix(1.0, smoothstep(1.25, 0.32, dv), uVignette);',
    '  }',
    '  col = clamp(col, 0.0, 1.0);',
    '  vec3 s = toSRGB(col);',
    '  float ls = dot(s, vec3(0.299, 0.587, 0.114));',
    '  gl_FragColor = vec4(s, mix(ls, 1.0, uOutAlpha));',
    '}',
  ].join('\n');

  // Final pass: FXAA 3.11 (PC quality preset 12) on the LDR image (luma in alpha), CAS-style sharpen, grain.
  const FRAG_FINAL = [
    'uniform sampler2D tLDR;',
    'uniform vec2 uTexel;',        // 1 / LDR size
    'uniform float uFxaa;',
    'uniform float uSharpen;',
    'uniform float uGrain;',
    'uniform float uTime;',
    'varying vec2 vUv;',
    '#define FXAA_SUBPIX 0.75',
    '#define FXAA_EDGE 0.166',
    '#define FXAA_EDGE_MIN 0.0833',
    'float lumaAt(vec2 p) { return texture2D(tLDR, p).a; }',
    'vec3 fxaa(vec2 pos, vec4 rgbyM, float lumaN, float lumaS, float lumaE, float lumaW, vec2 rcp) {',
    '  float lumaM = rgbyM.a;',
    '  float maxSM = max(lumaS, lumaM);',
    '  float minSM = min(lumaS, lumaM);',
    '  float maxESM = max(lumaE, maxSM);',
    '  float minESM = min(lumaE, minSM);',
    '  float maxWN = max(lumaN, lumaW);',
    '  float minWN = min(lumaN, lumaW);',
    '  float rangeMax = max(maxWN, maxESM);',
    '  float rangeMin = min(minWN, minESM);',
    '  float rangeMaxScaled = rangeMax * FXAA_EDGE;',
    '  float range = rangeMax - rangeMin;',
    '  float rangeMaxClamped = max(FXAA_EDGE_MIN, rangeMaxScaled);',
    '  if (range < rangeMaxClamped) return rgbyM.rgb;',
    '  float lumaNW = lumaAt(pos + vec2(-rcp.x, -rcp.y));',
    '  float lumaSE = lumaAt(pos + vec2( rcp.x,  rcp.y));',
    '  float lumaNE = lumaAt(pos + vec2( rcp.x, -rcp.y));',
    '  float lumaSW = lumaAt(pos + vec2(-rcp.x,  rcp.y));',
    '  float lumaNS = lumaN + lumaS;',
    '  float lumaWE = lumaW + lumaE;',
    '  float subpixRcpRange = 1.0 / range;',
    '  float subpixNSWE = lumaNS + lumaWE;',
    '  float edgeHorz1 = (-2.0 * lumaM) + lumaNS;',
    '  float edgeVert1 = (-2.0 * lumaM) + lumaWE;',
    '  float lumaNESE = lumaNE + lumaSE;',
    '  float lumaNWNE = lumaNW + lumaNE;',
    '  float edgeHorz2 = (-2.0 * lumaE) + lumaNESE;',
    '  float edgeVert2 = (-2.0 * lumaN) + lumaNWNE;',
    '  float lumaNWSW = lumaNW + lumaSW;',
    '  float lumaSWSE = lumaSW + lumaSE;',
    '  float edgeHorz4 = (abs(edgeHorz1) * 2.0) + abs(edgeHorz2);',
    '  float edgeVert4 = (abs(edgeVert1) * 2.0) + abs(edgeVert2);',
    '  float edgeHorz3 = (-2.0 * lumaW) + lumaNWSW;',
    '  float edgeVert3 = (-2.0 * lumaS) + lumaSWSE;',
    '  float edgeHorz = abs(edgeHorz3) + edgeHorz4;',
    '  float edgeVert = abs(edgeVert3) + edgeVert4;',
    '  float subpixNWSWNESE = lumaNWSW + lumaNESE;',
    '  float lengthSign = rcp.x;',
    '  bool horzSpan = edgeHorz >= edgeVert;',
    '  float subpixA = subpixNSWE * 2.0 + subpixNWSWNESE;',
    '  if (!horzSpan) lumaN = lumaW;',
    '  if (!horzSpan) lumaS = lumaE;',
    '  if (horzSpan) lengthSign = rcp.y;',
    '  float subpixB = (subpixA * (1.0 / 12.0)) - lumaM;',
    '  float gradientN = lumaN - lumaM;',
    '  float gradientS = lumaS - lumaM;',
    '  float lumaNN = lumaN + lumaM;',
    '  float lumaSS = lumaS + lumaM;',
    '  bool pairN = abs(gradientN) >= abs(gradientS);',
    '  float gradient = max(abs(gradientN), abs(gradientS));',
    '  if (pairN) lengthSign = -lengthSign;',
    '  float subpixC = clamp(abs(subpixB) * subpixRcpRange, 0.0, 1.0);',
    '  vec2 posB = pos;',
    '  vec2 offNP;',
    '  offNP.x = (!horzSpan) ? 0.0 : rcp.x;',
    '  offNP.y = ( horzSpan) ? 0.0 : rcp.y;',
    '  if (!horzSpan) posB.x += lengthSign * 0.5;',
    '  if ( horzSpan) posB.y += lengthSign * 0.5;',
    '  vec2 posN = posB - offNP * 1.0;',
    '  vec2 posP = posB + offNP * 1.0;',
    '  float subpixD = ((-2.0) * subpixC) + 3.0;',
    '  float lumaEndN = lumaAt(posN);',
    '  float subpixE = subpixC * subpixC;',
    '  float lumaEndP = lumaAt(posP);',
    '  if (!pairN) lumaNN = lumaSS;',
    '  float gradientScaled = gradient * 0.25;',
    '  float lumaMM = lumaM - lumaNN * 0.5;',
    '  float subpixF = subpixD * subpixE;',
    '  bool lumaMLTZero = lumaMM < 0.0;',
    '  lumaEndN -= lumaNN * 0.5;',
    '  lumaEndP -= lumaNN * 0.5;',
    '  bool doneN = abs(lumaEndN) >= gradientScaled;',
    '  bool doneP = abs(lumaEndP) >= gradientScaled;',
    '  if (!doneN) posN -= offNP * 1.5;',
    '  bool doneNP = (!doneN) || (!doneP);',
    '  if (!doneP) posP += offNP * 1.5;',
    '  for (int i = 0; i < 3; i++) {',            // preset 12: P2 = 2.0, P3 = 4.0, P4 = 12.0
    '    if (!doneNP) break;',
    '    float stepLen = (i == 0) ? 2.0 : ((i == 1) ? 4.0 : 12.0);',
    '    if (!doneN) lumaEndN = lumaAt(posN);',
    '    if (!doneP) lumaEndP = lumaAt(posP);',
    '    if (!doneN) lumaEndN = lumaEndN - lumaNN * 0.5;',
    '    if (!doneP) lumaEndP = lumaEndP - lumaNN * 0.5;',
    '    doneN = abs(lumaEndN) >= gradientScaled;',
    '    doneP = abs(lumaEndP) >= gradientScaled;',
    '    if (!doneN) posN -= offNP * stepLen;',
    '    doneNP = (!doneN) || (!doneP);',
    '    if (!doneP) posP += offNP * stepLen;',
    '  }',
    '  float dstN = pos.x - posN.x;',
    '  float dstP = posP.x - pos.x;',
    '  if (!horzSpan) dstN = pos.y - posN.y;',
    '  if (!horzSpan) dstP = posP.y - pos.y;',
    '  bool goodSpanN = (lumaEndN < 0.0) != lumaMLTZero;',
    '  float spanLength = (dstP + dstN);',
    '  bool goodSpanP = (lumaEndP < 0.0) != lumaMLTZero;',
    '  float spanLengthRcp = 1.0 / spanLength;',
    '  bool directionN = dstN < dstP;',
    '  float dst = min(dstN, dstP);',
    '  bool goodSpan = directionN ? goodSpanN : goodSpanP;',
    '  float subpixG = subpixF * subpixF;',
    '  float pixelOffset = (dst * (-spanLengthRcp)) + 0.5;',
    '  float subpixH = subpixG * FXAA_SUBPIX;',
    '  float pixelOffsetGood = goodSpan ? pixelOffset : 0.0;',
    '  float pixelOffsetSubpix = max(pixelOffsetGood, subpixH);',
    '  vec2 posF = pos;',
    '  if (!horzSpan) posF.x += pixelOffsetSubpix * lengthSign;',
    '  if ( horzSpan) posF.y += pixelOffsetSubpix * lengthSign;',
    '  return texture2D(tLDR, posF).rgb;',
    '}',
    'float grainNoise(vec2 p) {',                 // white-noise hash (no sin → stable on all GPUs), time-shifted per frame
    '  p += vec2(uTime * 37.0, uTime * 91.0);',
    '  vec3 p3 = fract(vec3(p.x, p.y, p.x) * 0.1031);',
    '  p3 += dot(p3, p3.yzx + 33.33);',
    '  return fract((p3.x + p3.y) * p3.z);',
    '}',
    'void main() {',
    '  vec4 M = texture2D(tLDR, vUv);',
    '  vec4 N = texture2D(tLDR, vUv + vec2(0.0, -uTexel.y));',
    '  vec4 S = texture2D(tLDR, vUv + vec2(0.0,  uTexel.y));',
    '  vec4 E = texture2D(tLDR, vUv + vec2( uTexel.x, 0.0));',
    '  vec4 W = texture2D(tLDR, vUv + vec2(-uTexel.x, 0.0));',
    '  vec3 c = M.rgb;',
    '  if (uFxaa > 0.5) c = fxaa(vUv, M, N.a, S.a, E.a, W.a, uTexel);',
    '  if (uSharpen > 0.0) {',
    '    vec3 mn = min(min(min(N.rgb, S.rgb), min(E.rgb, W.rgb)), c);',
    '    vec3 mx = max(max(max(N.rgb, S.rgb), max(E.rgb, W.rgb)), c);',
    '    vec3 amp = clamp(min(mn, 2.0 - mx) / max(mx, vec3(0.0001)), 0.0, 1.0);',
    '    vec3 w = -sqrt(amp) * (uSharpen * 0.2);',
    '    c = clamp((c + (N.rgb + S.rgb + E.rgb + W.rgb) * w) / (1.0 + 4.0 * w), 0.0, 1.0);',
    '  }',
    '  if (uGrain > 0.0) {',
    '    float n = grainNoise(floor(gl_FragCoord.xy)) - 0.5;',
    '    float lm = dot(c, vec3(0.299, 0.587, 0.114));',
    '    c = clamp(c + n * uGrain * (1.0 - 0.6 * lm), 0.0, 1.0);',
    '  }',
    '  gl_FragColor = vec4(c, 1.0);',
    '}',
  ].join('\n');

  // ------------------------------------------------------------------------------------------------
  // Internal state
  // ------------------------------------------------------------------------------------------------
  const P = {
    renderer: null, scene: null, camera: null,
    rtScene: null, rtLDR: null, rtBright: null, rtBlurA: null, rtBlurB: null,
    passScene: null, passCamera: null, passMesh: null, triGeo: null,
    matBright: null, matBlur: null, matTone: null, matFinal: null, blackTex: null,
    hdrType: null, hdr: false,
    dbW: 0, dbH: 0,            // drawing-buffer size the targets were built for
    rsW: 0, rsH: 0,            // scene / LDR target size (drawing buffer × renderScale)
    renderScale: 1, bloomScale: [0.5, 0.25],
    useBloom: true, useFXAA: true,
    frame: 0, warnedFail: false, warnedQuality: false, pendingQuality: null, glChecked: false,
    emptyScene: null, disposed: false,
  };
  const _vp = new THREE.Vector4();
  const _sc = new THREE.Vector4();
  const _v2 = new THREE.Vector2();
  const _v2b = new THREE.Vector2();

  function log() { if (G && typeof G.log === 'function') G.log.apply(G, arguments); }
  function emit(name, arg) { if (G && typeof G.emit === 'function') { try { G.emit(name, arg); } catch (e) { /* listeners' problem */ } } }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  // ------------------------------------------------------------------------------------------------
  // Render-target helpers
  // ------------------------------------------------------------------------------------------------
  function makeTarget(w, h, type, depth) {
    return new THREE.WebGLRenderTarget(Math.max(1, w | 0), Math.max(1, h | 0), {
      type: type,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
      depthBuffer: !!depth,
      stencilBuffer: false,
      samples: 0,
      generateMipmaps: false,
      colorSpace: THREE.LinearSRGBColorSpace,
    });
  }

  function disposeTargets() {
    const list = ['rtScene', 'rtLDR', 'rtBright', 'rtBlurA', 'rtBlurB'];
    for (let i = 0; i < list.length; i++) {
      const rt = P[list[i]];
      if (rt) { try { rt.dispose(); } catch (e) { /* ignore */ } P[list[i]] = null; }
    }
  }

  // Decide whether HalfFloat colour targets are usable (extension + a real framebuffer probe).
  function pickHdrType(renderer) {
    const ext = renderer.extensions, caps = renderer.capabilities;
    let ok = false;
    try {
      if (caps.isWebGL2) ok = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
      else ok = ext.has('OES_texture_half_float') && ext.has('EXT_color_buffer_half_float') && ext.has('OES_texture_half_float_linear');
    } catch (e) { ok = false; }
    if (!ok) return THREE.UnsignedByteType;
    let probe = null;
    try {
      const gl = renderer.getContext();
      probe = makeTarget(4, 4, THREE.HalfFloatType, true);
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(probe);
      renderer.clear(true, true, false);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      const err = gl.getError();
      renderer.setRenderTarget(prev);
      probe.dispose();
      if (status !== gl.FRAMEBUFFER_COMPLETE || err !== gl.NO_ERROR) return THREE.UnsignedByteType;
      return THREE.HalfFloatType;
    } catch (e) {
      if (probe) { try { probe.dispose(); } catch (e2) { /* ignore */ } }
      return THREE.UnsignedByteType;
    }
  }

  function allocTargets() {
    const r = P.renderer;
    disposeTargets();
    r.getDrawingBufferSize(_v2);
    P.dbW = Math.max(1, _v2.x | 0);
    P.dbH = Math.max(1, _v2.y | 0);
    const rs = Math.min(1, Math.max(0.25, num(P.renderScale, 1)));
    P.rsW = Math.max(1, Math.round(P.dbW * rs));
    P.rsH = Math.max(1, Math.round(P.dbH * rs));
    P.rtScene = makeTarget(P.rsW, P.rsH, P.hdrType, true);
    P.rtLDR = makeTarget(P.rsW, P.rsH, THREE.UnsignedByteType, false);
    const bs0 = P.bloomScale[0], bs1 = P.bloomScale[1];
    const bw = Math.max(2, Math.round(P.rsW * bs0)), bh = Math.max(2, Math.round(P.rsH * bs0));
    const qw = Math.max(2, Math.round(P.rsW * bs1)), qh = Math.max(2, Math.round(P.rsH * bs1));
    P.rtBright = makeTarget(bw, bh, P.hdrType, false);
    P.rtBlurA = makeTarget(qw, qh, P.hdrType, false);
    P.rtBlurB = makeTarget(qw, qh, P.hdrType, false);
    // static uniforms that depend on sizes
    P.matBright.uniforms.uTexel.value.set(1 / bw, 1 / bh);
    P.matFinal.uniforms.uTexel.value.set(1 / P.rsW, 1 / P.rsH);
    P.matTone.uniforms.uAspect.value = P.rsW / P.rsH;
    FX.stats.width = P.rsW; FX.stats.height = P.rsH;
    FX.stats.bloomWidth = qw; FX.stats.bloomHeight = qh;
    log('[PostFX] targets', P.rsW + 'x' + P.rsH, 'bloom', bw + 'x' + bh, '/', qw + 'x' + qh, P.hdr ? 'half-float' : '8-bit');
  }

  // Recreate targets when the drawing buffer or render scale changed.
  function ensureSize(force) {
    const r = P.renderer;
    if (!r) return;
    r.getDrawingBufferSize(_v2b);
    const rs = Math.min(1, Math.max(0.25, num(P.renderScale, 1)));
    const wantW = Math.max(1, Math.round(_v2b.x * rs)), wantH = Math.max(1, Math.round(_v2b.y * rs));
    if (force || !P.rtScene || wantW !== P.rsW || wantH !== P.rsH || (_v2b.x | 0) !== P.dbW || (_v2b.y | 0) !== P.dbH) allocTargets();
  }

  // ------------------------------------------------------------------------------------------------
  // Materials / full-screen triangle
  // ------------------------------------------------------------------------------------------------
  function makeMaterial(frag, uniforms) {
    return new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: VERT,
      fragmentShader: frag,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
      transparent: false,
      toneMapped: false,
      fog: false,
      lights: false,
    });
  }

  function buildPipeline() {
    P.triGeo = new THREE.BufferGeometry();
    P.triGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    P.passScene = new THREE.Scene();
    P.passCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    P.blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
    P.blackTex.needsUpdate = true;

    P.matBright = makeMaterial(FRAG_BRIGHT, {
      tSrc: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 640, 1 / 360) },
      uThreshold: { value: 0.85 },
      uKnee: { value: 0.5 },
      uClamp: { value: 12.0 },
    });
    P.matBlur = makeMaterial(FRAG_BLUR, {
      tSrc: { value: null },
      uDir: { value: new THREE.Vector2(1 / 320, 0) },
    });
    P.matTone = makeMaterial(FRAG_TONEMAP, {
      tScene: { value: null },
      tBloom: { value: P.blackTex },
      uBloom: { value: 0.35 },
      uExposure: { value: 1.05 },
      uSaturation: { value: 1.08 },
      uContrast: { value: 1.05 },
      uTint: { value: 0.15 },
      uVignette: { value: 0.35 },
      uAberration: { value: 0 },
      uTonemap: { value: 1 },
      uOutAlpha: { value: 0 },
      uAspect: { value: 16 / 9 },
    });
    P.matFinal = makeMaterial(FRAG_FINAL, {
      tLDR: { value: null },
      uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
      uFxaa: { value: 1 },
      uSharpen: { value: 0.25 },
      uGrain: { value: 0.03 },
      uTime: { value: 0 },
    });

    P.passMesh = new THREE.Mesh(P.triGeo, P.matTone);
    P.passMesh.frustumCulled = false;
    P.passMesh.matrixAutoUpdate = false;
    P.passScene.add(P.passMesh);
    P.emptyScene = new THREE.Scene();
  }

  // Draw a full-screen triangle with `material` into `target` (null = screen). Leaves the render target set.
  function renderPass(material, target) {
    const r = P.renderer;
    if (!r || !P.passMesh || !material) return;
    P.passMesh.material = material;
    r.setRenderTarget(target || null);
    if (!target) {
      r.getSize(_v2);
      r.setViewport(0, 0, _v2.x, _v2.y);
      r.setScissorTest(false);
    }
    r.render(P.passScene, P.passCamera);
  }

  // ------------------------------------------------------------------------------------------------
  // Per-frame pipeline
  // ------------------------------------------------------------------------------------------------
  function syncUniforms() {
    const p = FX.params;
    const ub = P.matBright.uniforms;
    ub.uThreshold.value = Math.max(0, num(p.bloomThreshold, 0.85));
    const ut = P.matTone.uniforms;
    ut.uBloom.value = Math.max(0, num(p.bloom, 0.35));
    ut.uExposure.value = Math.max(0, num(p.exposure, 1.05));
    ut.uSaturation.value = Math.max(0, num(p.saturation, 1.08));
    ut.uContrast.value = Math.max(0, num(p.contrast, 1.05));
    ut.uTint.value = clamp01(num(p.tint, 0.15));
    ut.uVignette.value = clamp01(num(p.vignette, 0.35));
    ut.uAberration.value = clamp01(num(p.aberration, 0));
    ut.uTonemap.value = (p.tonemap === false) ? 0 : 1;
    const uf = P.matFinal.uniforms;
    uf.uFxaa.value = (P.useFXAA && FX.features.fxaa !== false) ? 1 : 0;
    uf.uSharpen.value = clamp01(num(p.sharpen, 0.25));
    uf.uGrain.value = clamp01(num(p.grain, 0.03));
    uf.uTime.value = (P.frame % 1000) * 0.618;
  }

  function fail(e) {
    FX.enabled = false;
    FX.failed = true;
    if (!P.warnedFail) {
      P.warnedFail = true;
      console.warn('[PostFX] disabled after an error; falling back to direct rendering:', e && e.message ? e.message : e);
    }
    try { if (P.renderer) { P.renderer.setRenderTarget(null); P.renderer.setScissorTest(false); } } catch (e2) { /* ignore */ }
  }

  function checkGL() {
    const r = P.renderer;
    if (!r) return;
    const gl = r.getContext();
    if (!gl || (gl.isContextLost && gl.isContextLost())) return;
    const err = gl.getError();
    if (err !== gl.NO_ERROR) throw new Error('WebGL error 0x' + err.toString(16) + ' during post-processing');
  }

  function render(sceneArg, cameraArg) {
    const r = P.renderer;
    const scene = sceneArg || FX.scene || P.scene;
    const camera = cameraArg || FX.camera || P.camera;
    if (!r || !scene || !camera) return;
    if (!FX.enabled || !FX.ready || P.disposed) { r.render(scene, camera); return; }
    const t0 = performance.now();
    let prevRT = null, prevST = false, prevAC = true, saved = false;
    try {
      P.frame++;
      ensureSize(false);
      syncUniforms();
      prevRT = r.getRenderTarget();
      r.getViewport(_vp);
      r.getScissor(_sc);
      prevST = r.getScissorTest();
      prevAC = r.autoClear;
      saved = true;

      // 1. scene → linear HDR target (renderer writes linear values into render targets; no tonemapping)
      r.setRenderTarget(P.rtScene);
      r.render(scene, camera);
      r.autoClear = false;

      // 2. bloom chain
      const p = FX.params;
      const bloomOn = P.useBloom && FX.features.bloom !== false && num(p.bloom, 0.35) > 0;
      let passes = 2;
      if (bloomOn) {
        P.matBright.uniforms.tSrc.value = P.rtScene.texture;
        renderPass(P.matBright, P.rtBright);
        const radius = Math.max(0.25, num(p.bloomRadius, 1));
        const qw = P.rtBlurA.width, qh = P.rtBlurA.height;
        const ub = P.matBlur.uniforms;
        // iteration 1 (step 1), iteration 2 (step 2: wider, softer halo)
        ub.tSrc.value = P.rtBright.texture; ub.uDir.value.set(radius / qw, 0); renderPass(P.matBlur, P.rtBlurA);
        ub.tSrc.value = P.rtBlurA.texture; ub.uDir.value.set(0, radius / qh); renderPass(P.matBlur, P.rtBlurB);
        ub.tSrc.value = P.rtBlurB.texture; ub.uDir.value.set(2 * radius / qw, 0); renderPass(P.matBlur, P.rtBlurA);
        ub.tSrc.value = P.rtBlurA.texture; ub.uDir.value.set(0, 2 * radius / qh); renderPass(P.matBlur, P.rtBlurB);
        P.matTone.uniforms.tBloom.value = P.rtBlurB.texture;
        passes += 5;
      } else {
        P.matTone.uniforms.tBloom.value = P.blackTex;
        P.matTone.uniforms.uBloom.value = 0;
      }

      // 3. tonemap / grade → LDR (or straight to screen when the final pass has nothing to do)
      const uf = P.matFinal.uniforms;
      const needFinal = uf.uFxaa.value > 0.5 || uf.uSharpen.value > 0 || uf.uGrain.value > 0 || P.rsW !== P.dbW || P.rsH !== P.dbH;
      P.matTone.uniforms.tScene.value = P.rtScene.texture;
      P.matTone.uniforms.uOutAlpha.value = needFinal ? 0 : 1;
      if (needFinal) {
        renderPass(P.matTone, P.rtLDR);
        // 4. FXAA + sharpen + grain → screen
        uf.tLDR.value = P.rtLDR.texture;
        renderPass(P.matFinal, null);
        passes += 1;
      } else {
        renderPass(P.matTone, null);
      }

      // restore renderer state
      r.autoClear = prevAC;
      r.setRenderTarget(prevRT);
      r.setViewport(_vp);
      r.setScissor(_sc);
      r.setScissorTest(prevST);
      FX.stats.passes = passes;
      if (!P.glChecked) { P.glChecked = true; checkGL(); }
      FX.failed = false;
    } catch (e) {
      if (saved) {
        try { r.autoClear = prevAC; r.setRenderTarget(null); r.setViewport(_vp); r.setScissor(_sc); r.setScissorTest(prevST); } catch (e2) { /* ignore */ }
      }
      fail(e);
      r.render(scene, camera);
    }
    const ms = performance.now() - t0;
    FX.stats.ms = FX.stats.ms ? FX.stats.ms * 0.9 + ms * 0.1 : ms;
  }

  // ------------------------------------------------------------------------------------------------
  // Init / resize / quality
  // ------------------------------------------------------------------------------------------------
  function init(renderer, scene, camera) {
    if (!renderer || typeof renderer.render !== 'function') {
      console.warn('[PostFX] init called without a renderer; post-processing disabled');
      FX.enabled = false;
      return FX;
    }
    if (FX.ready) dispose();
    P.disposed = false;
    P.renderer = renderer;
    P.scene = scene || null;
    P.camera = camera || null;
    FX.renderer = renderer; FX.scene = scene || null; FX.camera = camera || null;
    FX.failed = false; P.warnedFail = false; P.glChecked = false; P.frame = 0;
    try {
      P.hdrType = pickHdrType(renderer);
      P.hdr = (P.hdrType === THREE.HalfFloatType);
      FX.stats.hdr = P.hdr;
      buildPipeline();
      const q = P.pendingQuality || (G && G.state && G.state.quality) || 'high';
      P.pendingQuality = null;
      setQuality(q);           // also allocates targets via ensureSize(true)
      if (!P.rtScene) allocTargets();
      FX.ready = true;
      FX.enabled = FX.enabled !== false;
      warmup();
      log('[PostFX] ready; hdr =', P.hdr, 'quality =', FX.quality);
    } catch (e) {
      FX.ready = false;
      fail(e);
    }
    return FX;
  }

  // Compile every program variant up-front (avoids a first-frame hitch and surfaces shader errors at boot).
  function warmup() {
    if (!P.renderer || !FX.ready || !P.emptyScene) return;
    const wasEnabled = FX.enabled;
    FX.enabled = true;
    const saveGrain = FX.params.grain, saveSharp = FX.params.sharpen;
    try {
      render(P.emptyScene, P.passCamera);           // LDR path (tonemap → LDR → final)
      FX.params.grain = 0; FX.params.sharpen = 0;
      const saveFx = FX.features.fxaa; FX.features.fxaa = false;
      if (P.rsW === P.dbW && P.rsH === P.dbH) render(P.emptyScene, P.passCamera);   // direct-to-screen variant
      FX.features.fxaa = saveFx;
    } catch (e) { /* render() already handled the failure */ }
    FX.params.grain = saveGrain; FX.params.sharpen = saveSharp;
    if (!FX.failed) FX.enabled = wasEnabled;
  }

  function resize(w, h) {
    const r = P.renderer;
    if (!r) return;
    try {
      if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
        r.getSize(_v2);
        if (Math.abs(_v2.x - w) > 0.5 || Math.abs(_v2.y - h) > 0.5) r.setSize(w, h, false);
      }
      if (FX.ready) ensureSize(true);
    } catch (e) { fail(e); }
  }

  function normaliseQuality(q) {
    if (typeof q === 'string') {
      q = q.toLowerCase();
      if (PRESETS[q]) return q;
      if (q === 'auto') return 'high';
    }
    if (typeof q === 'number') return QUALITY_ORDER[Math.max(0, Math.min(3, Math.round(q)))];
    if (!P.warnedQuality) { P.warnedQuality = true; console.warn('[PostFX] unknown quality "' + q + '", using high'); }
    return 'high';
  }

  function _shadowFallback(sky, size) {
    const sun = sky.sun;
    if (!sun || !sun.shadow || !sun.shadow.mapSize) return;
    if (sun.shadow.mapSize.x === size && sun.shadow.mapSize.y === size) return;
    sun.shadow.mapSize.set(size, size);
    if (sun.shadow.map) { try { sun.shadow.map.dispose(); } catch (e) { /* ignore */ } sun.shadow.map = null; }
  }

  function setQuality(q) {
    const name = normaliseQuality(q);
    const preset = PRESETS[name];
    FX.quality = name;
    if (G && G.state) G.state.quality = name;
    P.useBloom = preset.bloom;
    P.useFXAA = preset.fxaa;
    P.bloomScale = preset.bloomScale;
    P.renderScale = preset.renderScale;
    FX.features.bloom = preset.bloom;
    FX.features.fxaa = preset.fxaa;
    FX.renderScale = preset.renderScale;
    const r = P.renderer;
    if (!r) { P.pendingQuality = name; return name; }
    try {
      const dpr = Math.min(window.devicePixelRatio || 1, preset.dprCap);
      if (Math.abs(r.getPixelRatio() - dpr) > 1e-3) r.setPixelRatio(dpr);
      if (P.matBright) ensureSize(true);
    } catch (e) { fail(e); }
    // shadows
    if (G && G.state && G.state.settings) G.state.settings.shadows = preset.shadows;
    const Sky = G && G.Sky;
    if (Sky) {
      try {
        if (typeof Sky.setShadowQuality === 'function') Sky.setShadowQuality(preset.shadow);
        else _shadowFallback(Sky, preset.shadow);
        if (Sky.sun) Sky.sun.castShadow = preset.shadows;
      } catch (e) { console.warn('[PostFX] shadow quality update failed:', e && e.message); }
    }
    if (r.shadowMap) r.shadowMap.needsUpdate = true;
    // vegetation density
    const Veg = G && G.Veg;
    if (Veg && typeof Veg.setDensity === 'function') {
      try { Veg.setDensity(preset.density); } catch (e) { console.warn('[PostFX] vegetation density update failed:', e && e.message); }
    }
    emit('qualityChanged', name);
    return name;
  }

  function getSize(out) {
    out = out || new THREE.Vector2();
    out.set(P.rsW, P.rsH);
    return out;
  }

  function dispose() {
    disposeTargets();
    const mats = ['matBright', 'matBlur', 'matTone', 'matFinal'];
    for (let i = 0; i < mats.length; i++) { if (P[mats[i]]) { try { P[mats[i]].dispose(); } catch (e) { /* ignore */ } P[mats[i]] = null; } }
    if (P.triGeo) { try { P.triGeo.dispose(); } catch (e) { /* ignore */ } P.triGeo = null; }
    if (P.blackTex) { try { P.blackTex.dispose(); } catch (e) { /* ignore */ } P.blackTex = null; }
    P.passScene = null; P.passMesh = null; P.emptyScene = null;
    P.disposed = true;
    FX.ready = false;
  }

  // ------------------------------------------------------------------------------------------------
  // Public namespace
  // ------------------------------------------------------------------------------------------------
  const FX = {
    enabled: true,
    ready: false,
    failed: false,
    quality: (G && G.state && G.state.quality) || 'high',
    renderScale: 1,
    params: {
      bloom: 0.42,            // bloom intensity (0 = off)
      exposure: 1.06,         // pre-tonemap exposure
      vignette: 0.38,         // 0..1
      saturation: 1.12,
      contrast: 1.22,         // filmic contrast in LINEAR light around a 0.30 pivot (applied before the tonemap)
      bloomThreshold: 0.80,   // soft-knee threshold in linear HDR
      bloomRadius: 1.0,       // blur step multiplier
      grain: 0.03,            // film grain amplitude (0 = off)
      sharpen: 0.45,          // 0..1 CAS-style sharpening (0 = off)
      tint: 0.28,             // warm shadows / cool highlights split-tone strength (0 = off)
      aberration: 0,          // chromatic aberration (0 = off)
      tonemap: true,          // ACES filmic on/off (off = clamp; useful for calibration)
    },
    features: { bloom: true, fxaa: true },
    stats: { ms: 0, passes: 0, width: 0, height: 0, bloomWidth: 0, bloomHeight: 0, hdr: false },
    PRESETS: PRESETS,
    renderer: null, scene: null, camera: null,
    init: init,
    render: render,
    resize: resize,
    setQuality: setQuality,
    renderPass: renderPass,
    warmup: warmup,
    getSize: getSize,
    dispose: dispose,
  };
  Object.defineProperty(FX, 'sceneTarget', { get: function () { return P.rtScene; } });
  Object.defineProperty(FX, 'bloomTexture', { get: function () { return P.rtBlurB ? P.rtBlurB.texture : null; } });
  Object.defineProperty(FX, 'fullscreenTriangle', { get: function () { return P.triGeo; } });
  Object.defineProperty(FX, 'hdr', { get: function () { return P.hdr; } });

  G.PostFX = FX;
})();
