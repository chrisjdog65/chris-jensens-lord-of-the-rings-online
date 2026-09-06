/* ==== 01_audio.js — G.Audio: complete Web Audio engine with NO external files. Everything (66 SFX, 6 ambient
   beds, 19 composed multi-track music themes) is synthesized from oscillators, filtered noise, FM, Karplus-Strong
   plucked strings rendered to buffers, and a convolution reverb from a generated impulse.
   Public API (SPEC §5.9): init(), ready, sfx(name, {pos, vol, pitch, loop}) → handle|null, stopLoop(name),
   music(themeId), stopMusic(), currentTheme, duck(bool), setVolumes(music, sfx), ambient(biome, phase),
   setAmbientRain(bool). Extras (documented here, harmless if unused): footstep(groundType, opts),
   update(dt) (positional loop refresh; also self-driven), stats {nodes, voices}, names (SFX list),
   themes (theme id list), has(name), suspend()/resume(), stopAll(). Self-initialises on the first
   pointerdown/keydown. Silent-safe: every call returns immediately while the context does not exist
   (the last requested theme/ambient mix is remembered and applied once audio becomes ready).
   Private helpers prefixed `_` are copies of nothing owned by other modules; only `G.state`, `G.on`,
   `G.emit`, `G.rng`, `G.clamp` are touched, all defensively. ==== */
(function () {
  'use strict';
  const G = window.G;
  const A = {};
  G.Audio = A;

  // ------------------------------------------------------------------------------------------------
  // Private deterministic RNG (mulberry32) — pitch/timing variation must not disturb gameplay streams.
  // ------------------------------------------------------------------------------------------------
  let _seed = 0xA0D10 >>> 0;
  function _rand() {
    _seed = (_seed + 0x6D2B79F5) >>> 0;
    let t = _seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function _rr(a, b) { return a + (b - a) * _rand(); }
  function _clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // ------------------------------------------------------------------------------------------------
  // Engine state
  // ------------------------------------------------------------------------------------------------
  let ctx = null;           // AudioContext (lazy)
  let master, comp, musicGain, duckGain, sfxGain, ambientGain;
  let verbRoom, verbHall, roomSend, hallSend;   // convolvers + their input send gains
  const bufCache = new Map();                   // generated buffers (noise, KS strings, hit patterns, impulses)
  const shaperCache = new Map();
  const voices = [];                            // active SFX voices (concurrency cap)
  const loops = new Map();                      // name → voice (named loops started via sfx)
  const MAX_VOICES = 24;
  const LOOKAHEAD = 1.6;                        // seconds scheduled ahead (robust to background tab throttling)
  const TICK_MS = 120;
  let tickTimer = null;
  let lastTickAt = 0;
  const generators = new Set();                 // {next, tick(now)} — event generators (birds, crackles, music)

  A.ready = false;
  A.currentTheme = null;
  A.stats = { nodes: 0, voices: 0, notes: 0 };
  A.volumes = { music: 0.6, sfx: 0.8 };
  A.ducked = false;

  function mk(node) { A.stats.nodes++; return node; }
  function nowT() { return ctx ? ctx.currentTime : 0; }
  function oscN(type, f, t) { const o = mk(ctx.createOscillator()); o.type = type; o.frequency.setValueAtTime(Math.max(1, f), t == null ? nowT() : t); return o; }
  function gainN(v) { const g = mk(ctx.createGain()); g.gain.value = v == null ? 1 : v; return g; }
  function filtN(type, f, q, gainDb) { const fl = mk(ctx.createBiquadFilter()); fl.type = type; fl.frequency.value = f; if (q != null) fl.Q.value = q; if (gainDb != null) fl.gain.value = gainDb; return fl; }
  function bufN(buffer, rate, loop) { const s = mk(ctx.createBufferSource()); s.buffer = buffer; if (rate != null) s.playbackRate.value = rate; if (loop) s.loop = true; return s; }
  function panN(p) { if (!ctx.createStereoPanner) return null; const pn = mk(ctx.createStereoPanner()); pn.pan.value = _clamp(p || 0, -1, 1); return pn; }
  function delayN(t) { const d = mk(ctx.createDelay(Math.max(1, t + 0.1))); d.delayTime.value = t; return d; }
  function shaperN(amount) {
    let curve = shaperCache.get(amount);
    if (!curve) {
      const n = 2048; curve = new Float32Array(n); const k = Math.tanh(amount);
      for (let i = 0; i < n; i++) { const x = (i * 2) / n - 1; curve[i] = Math.tanh(x * amount) / k; }
      shaperCache.set(amount, curve);
    }
    const s = mk(ctx.createWaveShaper()); s.curve = curve; s.oversample = '2x'; return s;
  }
  // Envelope helper: points [[dt, value, mode?]] relative to t0; mode 'e' = exponential-ish (setTarget), default linear.
  function env(param, t0, start, pts) {
    param.cancelScheduledValues(t0);
    param.setValueAtTime(Math.max(start, 0), t0);
    let t = t0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]; t = t0 + p[0];
      if (p[2] === 'e') param.setTargetAtTime(Math.max(p[1], 0.0001), t, Math.max(0.005, p[3] || 0.05));
      else param.linearRampToValueAtTime(Math.max(p[1], 0), t);
    }
    return t;
  }
  function adsr(param, t0, a, d, s, r, dur, peak) {
    peak = peak == null ? 1 : peak;
    param.cancelScheduledValues(t0);
    param.setValueAtTime(0, t0);
    param.linearRampToValueAtTime(peak, t0 + a);
    const tEnd = t0 + Math.max(dur, a + 0.01);
    if (d > 0) param.setTargetAtTime(peak * s, t0 + a, d / 3);
    param.setTargetAtTime(0, tEnd, Math.max(r, 0.01) / 3);
    return tEnd + r + 0.08;
  }

  // ------------------------------------------------------------------------------------------------
  // Generated buffers: noise (white/pink/brown), impulse responses, Karplus-Strong strings, hit patterns
  // ------------------------------------------------------------------------------------------------
  function noiseBuf(kind) {
    const key = 'noise:' + kind;
    let b = bufCache.get(key); if (b) return b;
    const sr = ctx.sampleRate, n = Math.floor(sr * 2.5);
    b = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
      for (let i = 0; i < n; i++) {
        const w = _rand() * 2 - 1;
        if (kind === 'white') d[i] = w;
        else if (kind === 'pink') {
          b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.96900 * b2 + w * 0.1538520;
          b3 = 0.86650 * b3 + w * 0.3104856; b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
          d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
        } else { br = (br + 0.02 * w) / 1.02; d[i] = br * 3.5; }
      }
    }
    bufCache.set(key, b); return b;
  }
  function impulseBuf(dur, decay, damp) {
    const key = 'ir:' + dur + ':' + decay;
    let b = bufCache.get(key); if (b) return b;
    const sr = ctx.sampleRate, n = Math.floor(sr * dur);
    b = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch); let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n; const e = Math.pow(1 - t, decay);
        const w = _rand() * 2 - 1; const k = damp - damp * 0.8 * t;   // highs die faster
        lp += (w - lp) * k; d[i] = lp * e * (i < sr * 0.01 ? i / (sr * 0.01) : 1);
      }
    }
    bufCache.set(key, b); return b;
  }
  // Karplus-Strong plucked string rendered offline (any pitch; no render-quantum delay limit).
  function ksBuf(freq, dur, bright, decayT, kind) {
    const key = 'ks:' + (kind || '') + ':' + Math.round(freq * 4) + ':' + dur + ':' + bright + ':' + decayT;
    let b = bufCache.get(key); if (b) return b;
    if (bufCache.size > 260) { for (const k of bufCache.keys()) if (k.startsWith('ks:')) bufCache.delete(k); }
    const sr = ctx.sampleRate, N = Math.max(2, Math.round(sr / freq)), total = Math.floor(sr * dur);
    b = ctx.createBuffer(1, total, sr);
    const d = b.getChannelData(0);
    let lp = 0; const bk = 0.15 + 0.85 * bright;
    for (let i = 0; i < N && i < total; i++) { const w = _rand() * 2 - 1; lp += (w - lp) * bk; d[i] = lp; }
    const periods = Math.max(1, decayT * freq), loss = Math.pow(0.001, 1 / periods);
    const damp = 0.5;
    for (let i = N + 1; i < total; i++) d[i] = loss * ((1 - damp) * d[i - N] + damp * d[i - N - 1]);
    const fadeStart = Math.max(0, total - Math.floor(sr * 0.08));
    let peak = 0; for (let i = 0; i < total; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
    const norm = peak > 0 ? 0.85 / peak : 1;
    for (let i = 0; i < total; i++) { let v = d[i] * norm; if (i > fadeStart) v *= (total - i) / (total - fadeStart); d[i] = v; }
    bufCache.set(key, b); return b;
  }
  // Rendered percussive patterns (used for seamless loops such as horse_gallop): hits {t, len, f0, f1, tone, noise, lp}
  function hitsBuf(key, dur, hits) {
    let b = bufCache.get('hits:' + key); if (b) return b;
    const sr = ctx.sampleRate, total = Math.floor(sr * dur);
    b = ctx.createBuffer(1, total, sr); const d = b.getChannelData(0);
    for (const h of hits) {
      const s0 = Math.floor(h.t * sr), len = Math.floor(h.len * sr); let ph = 0, lp = 0;
      for (let i = 0; i < len; i++) {
        const idx = (s0 + i) % total; const tt = i / len;
        const e = Math.exp(-tt * (h.k || 6)) * (i < 20 ? i / 20 : 1);
        const f = h.f0 * Math.pow(h.f1 / h.f0, tt); ph += (2 * Math.PI * f) / sr;
        const w = _rand() * 2 - 1; lp += (w - lp) * (h.lp || 0.1);
        d[idx] += e * (Math.sin(ph) * (h.tone || 0) + lp * (h.noise || 0) * 3) * (h.vol || 1);
      }
    }
    let peak = 0; for (let i = 0; i < total; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; }
    if (peak > 0) for (let i = 0; i < total; i++) d[i] *= 0.9 / peak;
    bufCache.set('hits:' + key, b); return b;
  }

  // ------------------------------------------------------------------------------------------------
  // Context creation, buses, volumes, scheduler
  // ------------------------------------------------------------------------------------------------
  function volCurve(v) { v = _clamp(+v || 0, 0, 1); return Math.pow(v, 1.6); }
  function settings() { return (G.state && G.state.settings) || null; }

  A.init = function () {
    if (ctx) { if (ctx.state === 'suspended') ctx.resume().catch(function () {}); return true; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { ctx = null; return false; } }
    master = gainN(0.9);
    comp = mk(ctx.createDynamicsCompressor());
    comp.threshold.value = -14; comp.knee.value = 18; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.22;
    master.connect(comp); comp.connect(ctx.destination);
    musicGain = gainN(0.4); duckGain = gainN(1); sfxGain = gainN(0.7); ambientGain = gainN(0.5);
    duckGain.connect(musicGain); musicGain.connect(master); sfxGain.connect(master); ambientGain.connect(master);
    A.musicGain = musicGain; A.sfxGain = sfxGain; A.ambientGain = ambientGain; A.ctx = ctx;
    // reverbs: short room for SFX, long hall for music/ambience
    verbRoom = mk(ctx.createConvolver()); verbRoom.buffer = impulseBuf(1.1, 3.2, 0.5);
    verbHall = mk(ctx.createConvolver()); verbHall.buffer = impulseBuf(2.8, 2.6, 0.35);
    roomSend = gainN(1); hallSend = gainN(1);
    const roomOut = gainN(0.55), hallOut = gainN(0.6);
    roomSend.connect(verbRoom); verbRoom.connect(roomOut); roomOut.connect(sfxGain);
    hallSend.connect(verbHall); verbHall.connect(hallOut); hallOut.connect(master);
    noiseBuf('white'); noiseBuf('pink'); noiseBuf('brown');
    A.ready = true;
    const s = settings();
    A.setVolumes(s ? s.music : A.volumes.music, s ? s.sfx : A.volumes.sfx);
    if (ctx.state === 'suspended') ctx.resume().catch(function () {});
    startTicker();
    if (G.emit) G.emit('audioReady');
    // apply what the game asked for before audio existed
    if (wantTheme) { const t = wantTheme; wantTheme = null; A.music(t); }
    if (wantAmbient) A.ambient(wantAmbient.biome, wantAmbient.phase);
    if (wantRain) A.setAmbientRain(true);
    return true;
  };

  A.setVolumes = function (music, sfx) {
    if (music != null && !isNaN(+music)) A.volumes.music = _clamp(+music, 0, 1);
    if (sfx != null && !isNaN(+sfx)) A.volumes.sfx = _clamp(+sfx, 0, 1);
    if (!ctx) return;
    const t = nowT();
    musicGain.gain.setTargetAtTime(volCurve(A.volumes.music) * 0.75, t, 0.05);
    sfxGain.gain.setTargetAtTime(volCurve(A.volumes.sfx) * 0.9, t, 0.05);
    ambientGain.gain.setTargetAtTime(volCurve(A.volumes.sfx) * 0.7, t, 0.05);
  };
  A.suspend = function () { if (ctx && ctx.state === 'running') ctx.suspend().catch(function () {}); };
  A.resume = function () { if (ctx && ctx.state !== 'running') ctx.resume().catch(function () {}); };

  // self-initialise on first user gesture (context creation must happen inside a gesture handler)
  function onGesture() {
    A.init();
    if (ctx && ctx.state === 'running') {
      document.removeEventListener('pointerdown', onGesture, true);
      document.removeEventListener('keydown', onGesture, true);
      document.removeEventListener('touchstart', onGesture, true);
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('keydown', onGesture, true);
    document.addEventListener('touchstart', onGesture, true);
  }

  // Scheduler: one timer drives music players, ambient generators and positional loop refresh.
  function startTicker() {
    if (tickTimer) return;
    lastTickAt = nowT();
    tickTimer = setInterval(tick, TICK_MS);
  }
  function tick() {
    if (!ctx) return;
    const now = ctx.currentTime;
    const running = ctx.state === 'running';
    const gap = now - lastTickAt;                 // large gap => tab was throttled/suspended
    for (const g of generators) {
      if (!running) { g.paused = true; continue; }
      if (g.paused) { g.paused = false; if (g.resync) g.resync(now); }
      if (g.next < now - 0.5) g.next = now + 0.02;   // starved: skip ahead instead of bursting
      try { g.tick(now, now + LOOKAHEAD, gap); } catch (e) { generators.delete(g); }
    }
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i];
      if (v.pos && v.loop) v.refreshSpatial();
      if (!v.loop && v.endAt && now > v.endAt + 0.2) v.kill();
    }
    lastTickAt = now;
    A.stats.voices = voices.length;
  }
  A.update = function () { /* positional loops are refreshed by the internal ticker; kept for API symmetry */ };

  // ------------------------------------------------------------------------------------------------
  // Positional maths: attenuation over 40 m, inaudible at 60 m; pan by listener-relative x.
  // ------------------------------------------------------------------------------------------------
  function listener() { return G.state && G.state.player && G.state.player.pos ? G.state.player.pos : null; }
  function spatial(pos, out) {
    out.gain = 1; out.pan = 0;
    const L = listener(); if (!pos || !L) return out;
    const dx = (pos.x || 0) - L.x, dy = (pos.y || 0) - (L.y || 0), dz = (pos.z || 0) - L.z;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > 60) { out.gain = 0; return out; }
    out.gain = d < 3 ? 1 : Math.pow(1 - _clamp((d - 3) / 57, 0, 1), 1.7);
    let px = dx / Math.max(d, 1);
    const cam = G.Player && G.Player.cam;
    if (cam && typeof cam.yaw === 'number') { const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw); px = (dx * cy - dz * sy) / Math.max(d, 1); }
    out.pan = _clamp(px * 0.8, -0.8, 0.8);
    return out;
  }
  const _sp = { gain: 1, pan: 0 };

  // ------------------------------------------------------------------------------------------------
  // Voice: a small synthesis toolkit; every SFX is a function (v, t, p, o) building nodes into v.out.
  // ------------------------------------------------------------------------------------------------
  function Voice(name, dest) {
    this.name = name; this.nodes = []; this.endAt = 0; this.loop = false; this.pos = null; this.dead = false;
    this.out = gainN(1); this.dist = gainN(1); this.pan = panN(0);
    this.out.connect(this.dist);
    if (this.pan) { this.dist.connect(this.pan); this.pan.connect(dest); } else this.dist.connect(dest);
    this.nodes.push(this.out, this.dist); if (this.pan) this.nodes.push(this.pan);
  }
  Voice.prototype = {
    track: function (n) { this.nodes.push(n); return n; },
    end: function (t) { if (t > this.endAt) this.endAt = t; return t; },
    // oscillator with ADSR + optional frequency envelope [[dt, f]], detune cents, destination
    osc: function (o) {
      const t0 = o.t, type = o.type || 'sine', f = o.f;
      const s = this.track(oscN(type, f, t0));
      if (o.detune) s.detune.value = o.detune;
      if (o.fenv) { let tt = t0; for (const p of o.fenv) { tt = t0 + p[0]; if (p[2] === 'e') s.frequency.exponentialRampToValueAtTime(Math.max(1, p[1]), tt); else s.frequency.linearRampToValueAtTime(Math.max(1, p[1]), tt); } }
      const g = this.track(gainN(0));
      const tEnd = adsr(g.gain, t0, o.a == null ? 0.005 : o.a, o.d || 0, o.s == null ? 1 : o.s, o.r == null ? 0.05 : o.r, o.dur, o.vol == null ? 0.5 : o.vol);
      s.connect(g); g.connect(o.dest || this.out);
      s.start(t0); s.stop(tEnd); this.end(tEnd);
      if (o.vib) { const l = this.track(oscN('sine', o.vib.rate || 5.5, t0)); const lg = this.track(gainN(0)); lg.gain.setValueAtTime(0, t0); lg.gain.linearRampToValueAtTime(o.vib.cents || 8, t0 + (o.vib.delay || 0.15)); l.connect(lg); lg.connect(s.detune); l.start(t0); l.stop(tEnd); }
      return s;
    },
    // filtered noise burst with ADSR; filter {type, f, q, fenv:[[dt,f]]}
    noise: function (o) {
      const t0 = o.t, kind = o.kind || 'white';
      const s = this.track(bufN(noiseBuf(kind), o.rate || 1, true));
      s.loopStart = 0; s.loopEnd = 2.4;
      let head = s;
      if (o.filter) {
        const fl = this.track(filtN(o.filter.type || 'bandpass', o.filter.f || 1000, o.filter.q == null ? 1 : o.filter.q));
        if (o.filter.fenv) { let tt = t0; fl.frequency.setValueAtTime(o.filter.f || 1000, t0); for (const p of o.filter.fenv) { tt = t0 + p[0]; fl.frequency.exponentialRampToValueAtTime(Math.max(10, p[1]), tt); } }
        head.connect(fl); head = fl;
      }
      if (o.filter2) { const fl2 = this.track(filtN(o.filter2.type, o.filter2.f, o.filter2.q)); head.connect(fl2); head = fl2; }
      const g = this.track(gainN(0));
      const tEnd = adsr(g.gain, t0, o.a == null ? 0.005 : o.a, o.d || 0, o.s == null ? 1 : o.s, o.r == null ? 0.05 : o.r, o.dur, o.vol == null ? 0.5 : o.vol);
      head.connect(g); g.connect(o.dest || this.out);
      s.start(t0, _rand() * 1.5); s.stop(tEnd); this.end(tEnd);
      return g;
    },
    // FM pair: carrier (type) with modulator ratio & index envelope (index in Hz of deviation = idx * f)
    fm: function (o) {
      const t0 = o.t, f = o.f;
      const car = this.track(oscN(o.type || 'sine', f, t0));
      const mod = this.track(oscN(o.mtype || 'sine', f * (o.ratio || 2), t0));
      const mg = this.track(gainN(0));
      const idx = (o.idx == null ? 2 : o.idx) * f;
      mg.gain.setValueAtTime(idx, t0);
      mg.gain.setTargetAtTime(idx * (o.idxEnd == null ? 0.05 : o.idxEnd), t0 + (o.idxHold || 0), (o.idxDecay || 0.15) / 3);
      mod.connect(mg); mg.connect(car.frequency);
      if (o.fenv) { let tt = t0; for (const p of o.fenv) { tt = t0 + p[0]; car.frequency.exponentialRampToValueAtTime(Math.max(1, p[1]), tt); mod.frequency.exponentialRampToValueAtTime(Math.max(1, p[1] * (o.ratio || 2)), tt); } }
      const g = this.track(gainN(0));
      const tEnd = adsr(g.gain, t0, o.a == null ? 0.003 : o.a, o.d || 0, o.s == null ? 1 : o.s, o.r == null ? 0.1 : o.r, o.dur, o.vol == null ? 0.5 : o.vol);
      car.connect(g); g.connect(o.dest || this.out);
      car.start(t0); mod.start(t0); car.stop(tEnd); mod.stop(tEnd); this.end(tEnd);
      return car;
    },
    // Karplus-Strong pluck (rendered buffer)
    pluck: function (o) {
      const t0 = o.t, dur = o.dur || 1.2;
      const s = this.track(bufN(ksBuf(o.f, dur, o.bright == null ? 0.7 : o.bright, o.decay || dur * 0.8, o.kind), o.rate || 1, false));
      const g = this.track(gainN(o.vol == null ? 0.5 : o.vol));
      let head = s;
      if (o.lp) { const fl = this.track(filtN('lowpass', o.lp, 0.5)); head.connect(fl); head = fl; }
      head.connect(g); g.connect(o.dest || this.out);
      const tEnd = t0 + dur / (o.rate || 1) + 0.05;
      if (o.cut) { g.gain.setValueAtTime(o.vol == null ? 0.5 : o.vol, t0 + o.cut); g.gain.setTargetAtTime(0, t0 + o.cut, 0.03); }
      s.start(t0); s.stop(tEnd); this.end(tEnd);
      return s;
    },
    // play any buffer (loops, rendered patterns)
    buf: function (o) {
      const t0 = o.t; const s = this.track(bufN(o.buffer, o.rate || 1, !!o.loop));
      const g = this.track(gainN(0));
      let head = s;
      if (o.filter) { const fl = this.track(filtN(o.filter.type, o.filter.f, o.filter.q)); head.connect(fl); head = fl; }
      head.connect(g); g.connect(o.dest || this.out);
      const vol = o.vol == null ? 0.5 : o.vol;
      g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + (o.a || 0.01));
      s.start(t0);
      if (!o.loop) { const tEnd = t0 + o.buffer.duration / (o.rate || 1) + 0.05; s.stop(tEnd); this.end(tEnd); }
      else this.loopSrc = s;
      return { src: s, gain: g };
    },
    filter: function (type, f, q, gainDb) { return this.track(filtN(type, f, q, gainDb)); },
    lpOut: function (f, q) { const fl = this.track(filtN('lowpass', f, q)); fl.connect(this.out); return fl; },
    gain: function (v) { return this.track(gainN(v)); },
    shaper: function (amt) { return this.track(shaperN(amt)); },
    lfo: function (o) { const l = this.track(oscN(o.type || 'sine', o.rate, o.t)); const g = this.track(gainN(o.depth)); l.connect(g); g.connect(o.param); l.start(o.t); if (o.stop) l.stop(o.stop); return l; },
    // reverb send: amount 0..1, room (sfx) or hall
    verb: function (amount, hall) { const g = this.track(gainN(amount)); this.out.connect(g); g.connect(hall ? hallSend : roomSend); return g; },
    refreshSpatial: function () {
      if (!ctx || !this.pos) return;
      spatial(this.pos, _sp);
      const t = nowT();
      this.dist.gain.setTargetAtTime(_sp.gain, t, 0.12);
      if (this.pan) this.pan.pan.setTargetAtTime(_sp.pan, t, 0.12);
    },
    stop: function (fade) {
      if (this.dead) return;
      const t = nowT(); const f = fade == null ? 0.25 : fade;
      this.out.gain.cancelScheduledValues(t);
      this.out.gain.setValueAtTime(this.out.gain.value, t);
      this.out.gain.linearRampToValueAtTime(0, t + f);
      this.loop = false; this.endAt = t + f;
      const self = this; setTimeout(function () { self.kill(); }, (f + 0.15) * 1000);
    },
    kill: function () {
      if (this.dead) return; this.dead = true;
      for (const n of this.nodes) { try { if (typeof n.stop === 'function') n.stop(); } catch (e) {} try { n.disconnect(); } catch (e) {} }
      this.nodes.length = 0;
      const i = voices.indexOf(this); if (i >= 0) voices.splice(i, 1);
      if (this.loopName && loops.get(this.loopName) === this) loops.delete(this.loopName);
      A.stats.voices = voices.length;
    },
  };

  // ------------------------------------------------------------------------------------------------
  // SFX dispatch
  // ------------------------------------------------------------------------------------------------
  const SFX = {};          // name → { pv: pitchVariance, verb, hall, fn(v, t, p, o) }
  function def(name, fn, opts) { SFX[name] = Object.assign({ fn: fn, pv: 0.06 }, opts || {}); }

  A.sfx = function (name, o) {
    if (!ctx || !A.ready || !name) return null;
    const d = SFX[name]; if (!d) return null;
    o = o || {};
    if (ctx.state !== 'running') { if (!o.loop && !d.loop) return null; }
    spatial(o.pos, _sp);
    if (_sp.gain <= 0.005) return null;
    const isLoop = !!(o.loop || d.loop);
    if (isLoop && loops.has(name)) { const ex = loops.get(name); if (ex && !ex.dead) { if (o.pos) ex.pos = o.pos; return ex; } }
    // concurrency cap: drop the oldest non-loop voice
    while (voices.length >= MAX_VOICES) {
      let idx = -1; for (let i = 0; i < voices.length; i++) if (!voices[i].loop) { idx = i; break; }
      if (idx < 0) idx = 0;
      voices[idx].kill();
    }
    const v = new Voice(name, sfxGain);
    v.loop = isLoop; v.pos = o.pos || null;
    v.dist.gain.value = _sp.gain; if (v.pan) v.pan.pan.value = _sp.pan;
    const vol = (o.vol == null ? 1 : o.vol) * (d.vol == null ? 1 : d.vol);
    v.out.gain.value = vol;
    const pitch = (o.pitch || 1) * (1 + (_rand() * 2 - 1) * (o.pv == null ? d.pv : o.pv));
    const t = nowT() + 0.005;
    if (d.verb) v.verb(d.verb, !!d.hall);
    try { d.fn(v, t, pitch, o); } catch (e) { v.kill(); return null; }
    voices.push(v); A.stats.voices = voices.length;
    if (isLoop) { v.loopName = name; loops.set(name, v); }
    return v;
  };
  A.stopLoop = function (name, fade) { const v = loops.get(name); if (v) v.stop(fade); };
  A.stopAll = function () { for (let i = voices.length - 1; i >= 0; i--) voices[i].kill(); };
  A.has = function (name) { return !!SFX[name]; };
  A.footstep = function (ground, o) {
    const map = { grass: 'footstep_grass', dirt: 'footstep_dirt', stone: 'footstep_stone', road: 'footstep_road', sand: 'footstep_sand', snow: 'footstep_snow', wood: 'footstep_wood', water: 'footstep_water' };
    return A.sfx(map[ground] || 'footstep_grass', o);
  };
  let wantTheme = null, wantAmbient = null, wantRain = false;

  // ================================================================================================
  // SFX LIBRARY — every name from SPEC §5.9 (+ footstep_dirt/sand/road variants)
  // ================================================================================================
  // ---- UI ----
  def('ui_click', function (v, t, p) {
    v.osc({ t: t, type: 'sine', f: 1300 * p, fenv: [[0.04, 820 * p, 'e']], dur: 0.03, r: 0.03, vol: 0.35 });
    v.noise({ t: t, filter: { type: 'highpass', f: 3000 }, dur: 0.012, r: 0.01, vol: 0.12 });
  }, { pv: 0.03 });
  def('ui_open', function (v, t, p) {
    v.osc({ t: t, type: 'sine', f: 660 * p, dur: 0.09, a: 0.01, r: 0.12, vol: 0.28 });
    v.osc({ t: t + 0.09, type: 'sine', f: 990 * p, dur: 0.12, a: 0.01, r: 0.2, vol: 0.26 });
    v.noise({ t: t, kind: 'pink', filter: { type: 'bandpass', f: 1800, q: 0.8, fenv: [[0.18, 3500]] }, dur: 0.15, a: 0.03, r: 0.08, vol: 0.06 });
  }, { pv: 0.02, verb: 0.15 });
  def('ui_close', function (v, t, p) {
    v.osc({ t: t, type: 'sine', f: 880 * p, dur: 0.08, a: 0.01, r: 0.1, vol: 0.24 });
    v.osc({ t: t + 0.08, type: 'sine', f: 590 * p, dur: 0.12, a: 0.01, r: 0.18, vol: 0.2 });
    v.noise({ t: t, kind: 'pink', filter: { type: 'bandpass', f: 3200, q: 0.8, fenv: [[0.16, 1200]] }, dur: 0.14, a: 0.02, r: 0.06, vol: 0.05 });
  }, { pv: 0.02, verb: 0.1 });
  def('ui_error', function (v, t, p) {
    const fl = v.lpOut(1200, 1);
    for (let i = 0; i < 2; i++) v.osc({ t: t + i * 0.13, type: 'square', f: 175 * p, dur: 0.08, a: 0.005, r: 0.04, vol: 0.12, dest: fl });
  }, { pv: 0.01 });
  def('chat_ping', function (v, t, p) {
    v.osc({ t: t, type: 'sine', f: 880 * p, dur: 0.05, a: 0.005, r: 0.08, vol: 0.2 });
    v.osc({ t: t + 0.07, type: 'sine', f: 1175 * p, dur: 0.06, a: 0.005, r: 0.12, vol: 0.18 });
  }, { pv: 0.01 });

  // ---- weapons ----
  function whoosh(v, t, p, f0, f1, f2, dur, vol, q) {
    v.noise({ t: t, kind: 'white', filter: { type: 'bandpass', f: f0 * p, q: q || 1.2, fenv: [[dur * 0.45, f1 * p], [dur, f2 * p]] }, dur: dur * 0.6, a: dur * 0.3, r: dur * 0.4, vol: vol });
  }
  def('sword_swing', function (v, t, p) { whoosh(v, t, p, 500, 2600, 700, 0.24, 0.5); whoosh(v, t + 0.02, p, 900, 4000, 1500, 0.2, 0.15, 2); }, { pv: 0.1 });
  def('sword_hit', function (v, t, p) {
    v.fm({ t: t, f: 920 * p, ratio: 2.76, idx: 3.5, idxDecay: 0.08, dur: 0.05, r: 0.28, vol: 0.32 });
    v.fm({ t: t, f: 1480 * p, ratio: 1.41, idx: 2, idxDecay: 0.05, dur: 0.03, r: 0.18, vol: 0.16 });
    v.noise({ t: t, filter: { type: 'bandpass', f: 3200, q: 0.6 }, dur: 0.02, r: 0.07, vol: 0.45 });
    v.osc({ t: t, type: 'sine', f: 140 * p, fenv: [[0.08, 55 * p, 'e']], dur: 0.04, r: 0.1, vol: 0.4 });
  }, { pv: 0.08, verb: 0.25 });
  def('axe_hit', function (v, t, p) {
    v.osc({ t: t, type: 'sine', f: 120 * p, fenv: [[0.1, 45 * p, 'e']], dur: 0.06, r: 0.14, vol: 0.55 });
    v.noise({ t: t, filter: { type: 'lowpass', f: 900, q: 1 }, dur: 0.05, r: 0.12, vol: 0.5 });
    v.fm({ t: t, f: 620 * p, ratio: 2.4, idx: 2.5, idxDecay: 0.06, dur: 0.03, r: 0.16, vol: 0.18 });
    v.noise({ t: t + 0.01, filter: { type: 'bandpass', f: 2200, q: 2 }, dur: 0.015, r: 0.05, vol: 0.25 });
  }, { pv: 0.08, verb: 0.2 });
  def('blunt_hit', function (v, t, p) {
    v.osc({ t: t, type: 'sine', f: 95 * p, fenv: [[0.12, 38 * p, 'e']], dur: 0.08, r: 0.2, vol: 0.7 });
    v.noise({ t: t, kind: 'brown', filter: { type: 'lowpass', f: 500 }, dur: 0.07, r: 0.15, vol: 0.6 });
    v.noise({ t: t, filter: { type: 'bandpass', f: 1500, q: 1 }, dur: 0.012, r: 0.04, vol: 0.2 });
  }, { pv: 0.08, verb: 0.15 });
  def('bow_shoot', function (v, t, p) {
    v.pluck({ t: t, f: 105 * p, dur: 0.6, bright: 1, decay: 0.35, vol: 0.5 });
    v.pluck({ t: t + 0.004, f: 158 * p, dur: 0.4, bright: 0.9, decay: 0.2, vol: 0.25 });
    whoosh(v, t + 0.015, p, 700, 3200, 5000, 0.28, 0.32, 1.5);
    v.noise({ t: t, filter: { type: 'bandpass', f: 4000, q: 1 }, dur: 0.01, r: 0.03, vol: 0.2 });
  }, { pv: 0.06 });
  def('arrow_hit', function (v, t, p) {
    v.noise({ t: t, filter: { type: 'bandpass', f: 1700 * p, q: 2.5 }, dur: 0.015, r: 0.05, vol: 0.6 });
    v.osc({ t: t, type: 'sine', f: 420 * p, fenv: [[0.06, 150 * p, 'e']], dur: 0.03, r: 0.07, vol: 0.35 });
    v.pluck({ t: t + 0.005, f: 760 * p, dur: 0.3, bright: 0.9, decay: 0.12, vol: 0.2 });
  }, { pv: 0.1, verb: 0.15 });

  // ---- magic ----
  def('spell_cast', function (v, t, p) {
    const lp = v.filter('lowpass', 900, 2); lp.frequency.setValueAtTime(600, t); lp.frequency.exponentialRampToValueAtTime(5000, t + 0.5); lp.connect(v.out);
    for (let i = 0; i < 3; i++) v.osc({ t: t, type: i === 1 ? 'triangle' : 'sine', f: [300, 450, 600][i] * p, fenv: [[0.5, [1200, 1800, 2400][i] * p, 'e']], dur: 0.35, a: 0.05, r: 0.3, vol: 0.12, vib: { rate: 7, cents: 25, delay: 0.1 }, dest: lp });
    v.noise({ t: t, kind: 'pink', filter: { type: 'bandpass', f: 1500, q: 1, fenv: [[0.5, 6000]] }, dur: 0.35, a: 0.15, r: 0.25, vol: 0.14 });
  }, { pv: 0.04, verb: 0.35 });
  def('spell_hit', function (v, t, p) {
    v.fm({ t: t, f: 520 * p, ratio: 1.5, idx: 4, idxDecay: 0.12, dur: 0.05, r: 0.35, vol: 0.32 });
    v.noise({ t: t, filter: { type: 'bandpass', f: 2200, q: 0.7, fenv: [[0.25, 500]] }, dur: 0.04, r: 0.22, vol: 0.4 });
    v.osc({ t: t, type: 'sine', f: 110 * p, fenv: [[0.15, 40 * p, 'e']], dur: 0.06, r: 0.15, vol: 0.45 });
  }, { pv: 0.06, verb: 0.3 });
  def('fire_hit', function (v, t, p) {
    v.noise({ t: t, kind: 'pink', filter: { type: 'lowpass', f: 300, q: 1, fenv: [[0.12, 2600], [0.5, 500]] }, dur: 0.25, a: 0.03, r: 0.3, vol: 0.55 });
    v.osc({ t: t, type: 'sawtooth', f: 70 * p, fenv: [[0.4, 40 * p, 'e']], dur: 0.2, a: 0.02, r: 0.25, vol: 0.18, dest: v.lpOut(250, 1) });
    for (let i = 0; i < 5; i++) v.noise({ t: t + 0.04 + _rand() * 0.35, filter: { type: 'highpass', f: 2500 + _rand() * 2000, q: 1 }, dur: 0.006, r: 0.015, vol: 0.28 });
  }, { pv: 0.05, verb: 0.2 });
  def('frost_hit', function (v, t, p) {
    const fs = [2400, 3150, 4700, 5900];
    for (let i = 0; i < fs.length; i++) v.osc({ t: t + i * 0.035, type: 'sine', f: fs[i] * p, dur: 0.04, a: 0.002, r: 0.3 + i * 0.05, vol: 0.14 });
    v.noise({ t: t, filter: { type: 'highpass', f: 5500, q: 0.5 }, dur: 0.05, a: 0.005, r: 0.4, vol: 0.22 });
    for (let i = 0; i < 6; i++) v.fm({ t: t + 0.08 + i * 0.045, f: (3000 + _rand() * 3000) * p, ratio: 3.7, idx: 1.5, idxDecay: 0.03, dur: 0.01, r: 0.12, vol: 0.08 });
    v.osc({ t: t, type: 'triangle', f: 220 * p, fenv: [[0.2, 90 * p, 'e']], dur: 0.05, r: 0.2, vol: 0.2 });
  }, { pv: 0.05, verb: 0.4 });
  def('light_hit', function (v, t, p) {
    for (let i = 0; i < 4; i++) v.osc({ t: t, type: i < 2 ? 'sine' : 'triangle', f: [660, 990, 1320, 1980][i] * p, dur: 0.12, a: 0.008, r: 0.35, vol: 0.12 - i * 0.02 });
    v.noise({ t: t, kind: 'white', filter: { type: 'highpass', f: 4000 }, dur: 0.1, a: 0.01, r: 0.3, vol: 0.18 });
    v.osc({ t: t, type: 'sine', f: 165 * p, dur: 0.15, a: 0.01, r: 0.3, vol: 0.2 });
  }, { pv: 0.03, verb: 0.35 });
  def('heal', function (v, t, p) {
    const ns = [523, 659, 784, 1047];
    for (let i = 0; i < ns.length; i++) v.osc({ t: t + i * 0.09, type: 'sine', f: ns[i] * p, dur: 0.25, a: 0.02, r: 0.4, vol: 0.16, vib: { rate: 5, cents: 6, delay: 0.1 } });
    v.osc({ t: t, type: 'triangle', f: 262 * p, dur: 0.5, a: 0.2, r: 0.5, vol: 0.08, dest: v.lpOut(900, 0.7) });
    v.noise({ t: t + 0.1, kind: 'pink', filter: { type: 'highpass', f: 5000 }, dur: 0.3, a: 0.2, r: 0.3, vol: 0.05 });
  }, { pv: 0.02, verb: 0.4, hall: true });
  def('buff', function (v, t, p) {
    const ns = [587, 740, 880];
    for (let i = 0; i < 3; i++) v.fm({ t: t + i * 0.07, f: ns[i] * p, ratio: 2, idx: 1.2, idxDecay: 0.1, dur: 0.08, r: 0.35, vol: 0.18 });
    v.noise({ t: t + 0.05, filter: { type: 'highpass', f: 6000 }, dur: 0.15, a: 0.1, r: 0.2, vol: 0.06 });
  }, { pv: 0.02, verb: 0.3 });

  // ---- footsteps & body ----
  function step(v, t, p, o) {
    v.noise({ t: t, kind: o.kind || 'white', filter: { type: 'lowpass', f: o.lp * p, q: o.q || 0.8 }, dur: o.dur, a: 0.004, r: o.r, vol: o.vol });
    if (o.thud) v.osc({ t: t, type: 'sine', f: o.thud * p, fenv: [[0.05, o.thud * 0.5 * p, 'e']], dur: 0.02, r: 0.05, vol: o.thudVol || 0.25 });
  }
  def('footstep_grass', function (v, t, p) {
    step(v, t, p, { kind: 'pink', lp: 600, dur: 0.05, r: 0.06, vol: 0.4, thud: 90, thudVol: 0.18 });
    v.noise({ t: t + 0.01, filter: { type: 'bandpass', f: 3200, q: 1.5 }, dur: 0.03, a: 0.01, r: 0.05, vol: 0.09 });
  }, { pv: 0.15, vol: 0.8 });
  def('footstep_dirt', function (v, t, p) {
    step(v, t, p, { kind: 'pink', lp: 900, dur: 0.045, r: 0.05, vol: 0.4, thud: 100, thudVol: 0.16 });
    v.noise({ t: t + 0.008, filter: { type: 'bandpass', f: 2000, q: 1 }, dur: 0.02, r: 0.03, vol: 0.1 });
  }, { pv: 0.15, vol: 0.8 });
  def('footstep_sand', function (v, t, p) {
    step(v, t, p, { kind: 'pink', lp: 1400, dur: 0.07, r: 0.08, vol: 0.32 });
    v.noise({ t: t + 0.02, kind: 'white', filter: { type: 'bandpass', f: 2600, q: 0.8 }, dur: 0.05, a: 0.02, r: 0.05, vol: 0.1 });
  }, { pv: 0.15, vol: 0.8 });
  def('footstep_stone', function (v, t, p) {
    v.noise({ t: t, filter: { type: 'bandpass', f: 2400 * p, q: 2 }, dur: 0.008, r: 0.03, vol: 0.5 });
    step(v, t + 0.002, p, { lp: 700, dur: 0.02, r: 0.04, vol: 0.28, thud: 140, thudVol: 0.12 });
  }, { pv: 0.12, vol: 0.85, verb: 0.15 });
  def('footstep_road', function (v, t, p) {
    v.noise({ t: t, filter: { type: 'bandpass', f: 1900 * p, q: 1.5 }, dur: 0.01, r: 0.03, vol: 0.35 });
    step(v, t + 0.002, p, { kind: 'pink', lp: 800, dur: 0.03, r: 0.045, vol: 0.3, thud: 110, thudVol: 0.14 });
  }, { pv: 0.12, vol: 0.85 });
  def('footstep_wood', function (v, t, p) {
    v.osc({ t: t, type: 'sine', f: 230 * p, fenv: [[0.05, 115 * p, 'e']], dur: 0.02, r: 0.07, vol: 0.4 });
    step(v, t, p, { lp: 1300, dur: 0.02, r: 0.03, vol: 0.3 });
    v.pluck({ t: t, f: 180 * p, dur: 0.15, bright: 0.4, decay: 0.06, vol: 0.15 });
  }, { pv: 0.12, vol: 0.85, verb: 0.1 });
  def('footstep_water', function (v, t, p) {
    v.noise({ t: t, filter: { type: 'bandpass', f: 1100 * p, q: 1, fenv: [[0.12, 3200 * p]] }, dur: 0.08, a: 0.01, r: 0.1, vol: 0.4 });
    v.osc({ t: t + 0.02, type: 'sine', f: 450 * p, fenv: [[0.08, 180 * p, 'e']], dur: 0.04, r: 0.06, vol: 0.12 });
    v.noise({ t: t + 0.06, kind: 'pink', filter: { type: 'highpass', f: 3000 }, dur: 0.06, a: 0.02, r: 0.08, vol: 0.1 });
  }, { pv: 0.12, vol: 0.85 });
  def('footstep_snow', function (v, t, p) {
    for (let i = 0; i < 4; i++) v.noise({ t: t + i * 0.022 + _rand() * 0.01, kind: 'white', filter: { type: 'lowpass', f: (1500 - i * 200) * p, q: 0.7 }, dur: 0.012, r: 0.02, vol: 0.3 - i * 0.04 });
    step(v, t, p, { kind: 'pink', lp: 500, dur: 0.06, r: 0.05, vol: 0.25, thud: 80, thudVol: 0.12 });
  }, { pv: 0.12, vol: 0.85 });
  def('jump', function (v, t, p) {
    whoosh(v, t, p, 350, 1600, 2200, 0.16, 0.22, 1);
    v.osc({ t: t, type: 'triangle', f: 170 * p, fenv: [[0.07, 240 * p]], dur: 0.05, a: 0.01, r: 0.04, vol: 0.08, dest: v.lpOut(800, 1) });
  }, { pv: 0.08 });
  def('land', function (v, t, p) {
    v.osc({ t: t, type: 'sine', f: 85 * p, fenv: [[0.09, 38 * p, 'e']], dur: 0.05, r: 0.12, vol: 0.5 });
    v.noise({ t: t, kind: 'pink', filter: { type: 'lowpass', f: 700 }, dur: 0.04, r: 0.08, vol: 0.4 });
    v.noise({ t: t + 0.01, filter: { type: 'bandpass', f: 2400, q: 1 }, dur: 0.02, r: 0.03, vol: 0.08 });
  }, { pv: 0.1 });
  def('roll', function (v, t, p) {
    for (let i = 0; i < 2; i++) v.osc({ t: t + i * 0.16, type: 'sine', f: 90 * p, fenv: [[0.08, 45 * p, 'e']], dur: 0.04, r: 0.1, vol: 0.3 });
    v.noise({ t: t, kind: 'pink', filter: { type: 'lowpass', f: 800, q: 0.8, fenv: [[0.35, 300]] }, dur: 0.28, a: 0.02, r: 0.12, vol: 0.35 });
    v.noise({ t: t + 0.03, filter: { type: 'bandpass', f: 2000, q: 0.8 }, dur: 0.25, a: 0.05, r: 0.1, vol: 0.08 });
  }, { pv: 0.08 });
  function voiceSaw(v, t, p, f0, f1, dur, vol, lp, form) {
    const fl = v.filter('lowpass', lp, 1.5); const bp = v.filter('bandpass', form, 2.5); const mix = v.gain(1);
    fl.connect(mix); bp.connect(mix); mix.connect(v.out);
    v.osc({ t: t, type: 'sawtooth', f: f0 * p, fenv: [[dur, f1 * p, 'e']], dur: dur * 0.7, a: 0.02, r: dur * 0.3, vol: vol, dest: fl, vib: { rate: 6, cents: 20, delay: 0.05 } });
    v.osc({ t: t, type: 'sawtooth', f: f0 * p * 1.005, fenv: [[dur, f1 * p, 'e']], dur: dur * 0.7, a: 0.02, r: dur * 0.3, vol: vol * 0.6, dest: bp });
    v.noise({ t: t, kind: 'pink', filter: { type: 'bandpass', f: form, q: 1 }, dur: dur * 0.6, a: 0.03, r: dur * 0.3, vol: vol * 0.35 });
  }
  def('hurt', function (v, t, p) { voiceSaw(v, t, p, 175, 120, 0.18, 0.2, 1000, 800); }, { pv: 0.12 });
  def('death', function (v, t, p) {
    voiceSaw(v, t, p, 150, 70, 0.75, 0.2, 800, 650);
    v.osc({ t: t + 0.55, type: 'sine', f: 80 * p, fenv: [[0.1, 35 * p, 'e']], dur: 0.06, r: 0.15, vol: 0.4 });
    v.noise({ t: t + 0.55, kind: 'pink', filter: { type: 'lowpass', f: 600 }, dur: 0.05, r: 0.1, vol: 0.35 });
  }, { pv: 0.08, verb: 0.2 });

  // ---- progression / rewards ----
  function bell(v, t, f, dur, vol, ratio, idx) { return v.fm({ t: t, f: f, ratio: ratio || 3.5, idx: idx == null ? 1.6 : idx, idxDecay: dur * 0.5, dur: dur * 0.25, a: 0.003, r: dur, vol: vol }); }
  function padChord(v, t, fs, dur, vol, a, r, lp) {
    const fl = v.lpOut(lp || 1500, 0.6);
    for (const f of fs) { v.osc({ t: t, type: 'sawtooth', f: f, detune: -7, dur: dur, a: a, r: r, vol: vol, dest: fl }); v.osc({ t: t, type: 'sawtooth', f: f, detune: 7, dur: dur, a: a, r: r, vol: vol, dest: fl }); }
  }
  def('level_up', function (v, t, p) {
    const ns = [523, 659, 784, 1047, 1319, 1568];
    for (let i = 0; i < ns.length; i++) { v.osc({ t: t + i * 0.085, type: 'triangle', f: ns[i] * p, dur: 0.12, a: 0.01, r: 0.6, vol: 0.14 }); v.osc({ t: t + i * 0.085, type: 'sine', f: ns[i] * 2 * p, dur: 0.1, a: 0.01, r: 0.5, vol: 0.05 }); }
    padChord(v, t + 0.3, [262 * p, 330 * p, 392 * p, 523 * p], 0.9, 0.05, 0.35, 0.9, 1800);
    bell(v, t + 0.55, 2093 * p, 1.4, 0.12);
    v.noise({ t: t + 0.2, kind: 'pink', filter: { type: 'highpass', f: 5000 }, dur: 0.7, a: 0.35, r: 0.6, vol: 0.09 });
  }, { pv: 0.01, verb: 0.45, hall: true });
  def('quest_accept', function (v, t, p) {
    bell(v, t, 784 * p, 0.6, 0.22, 2); bell(v, t + 0.14, 1047 * p, 0.9, 0.22, 2);
    v.noise({ t: t, kind: 'pink', filter: { type: 'bandpass', f: 1200, q: 0.8, fenv: [[0.3, 2600]] }, dur: 0.25, a: 0.05, r: 0.15, vol: 0.07 });
  }, { pv: 0.01, verb: 0.3 });
  def('quest_progress', function (v, t, p) {
    bell(v, t, 1319 * p, 0.5, 0.2, 2);
    v.noise({ t: t, filter: { type: 'highpass', f: 4000 }, dur: 0.01, r: 0.02, vol: 0.08 });
  }, { pv: 0.01, verb: 0.25 });
  function horn(v, t, f, dur, vol, dest) {
    return v.fm({ t: t, f: f, ratio: 1, idx: 0.35, idxEnd: 1.4, idxHold: 0.02, idxDecay: 0.18, type: 'sine', dur: dur, a: 0.06, d: 0.1, s: 0.85, r: 0.25, vol: vol, dest: dest });
  }
  def('quest_complete', function (v, t, p) {
    const fl = v.lpOut(2600, 0.7);
    horn(v, t, 523 * p, 0.16, 0.3, fl); horn(v, t + 0.2, 784 * p, 0.16, 0.3, fl); horn(v, t + 0.4, 1047 * p, 0.75, 0.34, fl);
    horn(v, t + 0.4, 659 * p, 0.75, 0.16, fl);
    padChord(v, t + 0.38, [262 * p, 392 * p, 523 * p, 659 * p], 0.8, 0.045, 0.2, 0.9, 1600);
    v.noise({ t: t + 0.4, kind: 'pink', filter: { type: 'highpass', f: 6000 }, dur: 0.5, a: 0.2, r: 0.5, vol: 0.06 });
  }, { pv: 0.005, verb: 0.45, hall: true });
  def('coin', function (v, t, p) {
    const n = 2 + Math.floor(_rand() * 2);
    for (let i = 0; i < n; i++) bell(v, t + i * 0.065, (2300 + _rand() * 900) * p, 0.35, 0.16, 3.7, 1.2);
    v.noise({ t: t, filter: { type: 'highpass', f: 5000 }, dur: 0.008, r: 0.02, vol: 0.12 });
  }, { pv: 0.04 });
  def('loot', function (v, t, p) {
    const g = v.noise({ t: t, kind: 'pink', filter: { type: 'bandpass', f: 1800 * p, q: 0.9 }, dur: 0.18, a: 0.02, r: 0.08, vol: 0.28 });
    v.lfo({ t: t, rate: 22, depth: 0.15, param: g.gain, stop: t + 0.4 });
    bell(v, t + 0.14, 1568 * p, 0.5, 0.12, 2);
  }, { pv: 0.08 });
  def('equip', function (v, t, p) {
    v.fm({ t: t, f: 760 * p, ratio: 2.9, idx: 2, idxDecay: 0.05, dur: 0.03, r: 0.14, vol: 0.2 });
    v.noise({ t: t, filter: { type: 'bandpass', f: 4000, q: 1 }, dur: 0.01, r: 0.03, vol: 0.2 });
    v.noise({ t: t + 0.06, kind: 'pink', filter: { type: 'bandpass', f: 1500, q: 0.8 }, dur: 0.12, a: 0.03, r: 0.08, vol: 0.14 });
  }, { pv: 0.08 });
  def('achievement', function (v, t, p) {
    const ns = [1047, 1319, 1568, 2093];
    for (let i = 0; i < 4; i++) bell(v, t + i * 0.11, ns[i] * p, 1.1 + i * 0.2, 0.16, 2, 1.4);
    padChord(v, t + 0.2, [262 * p, 392 * p, 659 * p], 0.9, 0.04, 0.3, 0.9, 1400);
    v.noise({ t: t + 0.3, kind: 'pink', filter: { type: 'highpass', f: 6000 }, dur: 0.5, a: 0.25, r: 0.5, vol: 0.07 });
  }, { pv: 0.005, verb: 0.5, hall: true });
  def('admin_open', function (v, t, p) {
    const fl = v.lpOut(500, 3); fl.frequency.setValueAtTime(300, t); fl.frequency.exponentialRampToValueAtTime(3500, t + 0.7);
    for (const f of [110, 165, 220, 311]) { v.osc({ t: t, type: 'sawtooth', f: f * p, detune: -9, dur: 0.6, a: 0.08, r: 0.5, vol: 0.07, dest: fl }); v.osc({ t: t, type: 'sawtooth', f: f * p, detune: 9, dur: 0.6, a: 0.08, r: 0.5, vol: 0.07, dest: fl }); }
    const ns = [440, 523, 622, 880];
    for (let i = 0; i < 4; i++) bell(v, t + 0.25 + i * 0.1, ns[i] * p, 0.9, 0.12, 3.01, 1.6);
  }, { pv: 0.01, verb: 0.5, hall: true });

  // ---- doors, mounts, boats ----
  function creak(v, t, p, f0, dur, vol, bpf, q, walk) {
    const bp = v.filter('bandpass', bpf, q || 3); bp.connect(v.out);
    const fenv = []; let f = f0; const steps = Math.max(4, Math.floor(dur / 0.06));
    for (let i = 1; i <= steps; i++) { f *= 1 + (_rand() * 2 - 1) * (walk || 0.12); f = _clamp(f, f0 * 0.6, f0 * 1.7); fenv.push([(dur * i) / steps, f * p]); }
    v.osc({ t: t, type: 'sawtooth', f: f0 * p, fenv: fenv, dur: dur * 0.8, a: dur * 0.15, r: dur * 0.2, vol: vol, dest: bp });
    v.osc({ t: t, type: 'square', f: f0 * p * 0.5, fenv: fenv.map(function (e) { return [e[0], e[1] * 0.5]; }), dur: dur * 0.8, a: dur * 0.15, r: dur * 0.2, vol: vol * 0.3, dest: bp });
  }
  def('door_open', function (v, t, p) {
    v.noise({ t: t, filter: { type: 'bandpass', f: 2200, q: 1.5 }, dur: 0.012, r: 0.04, vol: 0.3 });
    v.osc({ t: t, type: 'sine', f: 300 * p, fenv: [[0.03, 120 * p, 'e']], dur: 0.02, r: 0.05, vol: 0.15 });
    creak(v, t + 0.06, p, 110, 0.75, 0.16, 650, 3, 0.14);
  }, { pv: 0.1, verb: 0.2 });
  def('door_close', function (v, t, p) {
    creak(v, t, p, 130, 0.3, 0.1, 600, 3, 0.1);
    v.osc({ t: t + 0.3, type: 'sine', f: 110 * p, fenv: [[0.08, 50 * p, 'e']], dur: 0.05, r: 0.15, vol: 0.5 });
    v.noise({ t: t + 0.3, kind: 'pink', filter: { type: 'lowpass', f: 900 }, dur: 0.04, r: 0.1, vol: 0.4 });
    v.noise({ t: t + 0.34, filter: { type: 'bandpass', f: 2600, q: 2 }, dur: 0.01, r: 0.04, vol: 0.25 });
  }, { pv: 0.1, verb: 0.2 });
  def('horse_mount', function (v, t, p) {
    creak(v, t, p, 180, 0.28, 0.08, 1200, 2, 0.1);
    v.osc({ t: t + 0.22, type: 'sine', f: 90 * p, fenv: [[0.08, 45 * p, 'e']], dur: 0.05, r: 0.12, vol: 0.4 });
    v.noise({ t: t + 0.22, kind: 'pink', filter: { type: 'lowpass', f: 600 }, dur: 0.05, r: 0.1, vol: 0.35 });
    for (let i = 0; i < 3; i++) v.noise({ t: t + 0.32 + i * 0.09, kind: 'pink', filter: { type: 'lowpass', f: 500 }, dur: 0.03, r: 0.05, vol: 0.2 });
  }, { pv: 0.08 });
  function gallopBuffer() {
    const hoof = function (t, vol) { return { t: t, len: 0.11, f0: 140, f1: 55, tone: 0.8, noise: 0.5, lp: 0.08, k: 9, vol: vol }; };
    return hitsBuf('gallop', 0.66, [hoof(0, 1), hoof(0.115, 0.8), hoof(0.235, 0.9), hoof(0.4, 1.05), { t: 0.4, len: 0.08, f0: 600, f1: 300, tone: 0, noise: 0.25, lp: 0.3, k: 12, vol: 0.5 }]);
  }
  def('horse_gallop', function (v, t, p, o) {
    v.buf({ t: t, buffer: gallopBuffer(), rate: p, loop: !!(o && o.loop), vol: 0.6, a: 0.05, filter: { type: 'lowpass', f: 1800, q: 0.7 } });
  }, { pv: 0.03 });
  def('horse_neigh', function (v, t, p) {
    const f1 = v.filter('bandpass', 1000, 2), f2 = v.filter('bandpass', 2400, 3), mix = v.gain(1); f1.connect(mix); f2.connect(mix); mix.connect(v.out);
    const fenv = [[0.12, 780], [0.35, 640], [0.5, 720], [0.7, 480], [0.85, 380]];
    v.osc({ t: t, type: 'sawtooth', f: 480 * p, fenv: fenv.map(function (e) { return [e[0], e[1] * p]; }), dur: 0.65, a: 0.04, r: 0.2, vol: 0.2, dest: f1, vib: { rate: 11, cents: 60, delay: 0.05 } });
    v.osc({ t: t, type: 'sawtooth', f: 483 * p, fenv: fenv.map(function (e) { return [e[0], e[1] * p]; }), dur: 0.65, a: 0.04, r: 0.2, vol: 0.14, dest: f2, vib: { rate: 11, cents: 60, delay: 0.05 } });
    v.noise({ t: t, kind: 'pink', filter: { type: 'bandpass', f: 1800, q: 1 }, dur: 0.6, a: 0.05, r: 0.25, vol: 0.09 });
  }, { pv: 0.08, verb: 0.25 });
  def('boat_creak', function (v, t, p) { creak(v, t, p, 70, 1.0, 0.16, 320, 5, 0.09); creak(v, t + 0.5, p * 1.2, 95, 0.6, 0.08, 500, 4, 0.1); }, { pv: 0.1, verb: 0.15 });
  def('boat_bell', function (v, t, p) {
    for (let i = 0; i < 2; i++) { const tt = t + i * 0.55; bell(v, tt, 880 * p, 1.6, 0.22, 2.0, 1.3); bell(v, tt, 880 * p, 1.2, 0.12, 3.01, 1); v.noise({ t: tt, filter: { type: 'highpass', f: 3000 }, dur: 0.006, r: 0.02, vol: 0.15 }); }
  }, { pv: 0.01, verb: 0.5, hall: true });

  // ---- fishing / water ----
  function plop(v, t, p, vol) { v.osc({ t: t, type: 'sine', f: 560 * p, fenv: [[0.05, 160 * p, 'e']], dur: 0.02, r: 0.05, vol: vol }); v.noise({ t: t, filter: { type: 'bandpass', f: 1600, q: 1, fenv: [[0.08, 600]] }, dur: 0.03, r: 0.06, vol: vol * 0.7 }); }
  def('fish_cast', function (v, t, p) {
    whoosh(v, t, p, 400, 2000, 3000, 0.22, 0.25, 1);
    const g = v.noise({ t: t + 0.08, filter: { type: 'bandpass', f: 3000, q: 2 }, dur: 0.35, a: 0.02, r: 0.05, vol: 0.12 });
    v.lfo({ t: t, type: 'square', rate: 34, depth: 0.12, param: g.gain, stop: t + 0.6 });
    plop(v, t + 0.5, p, 0.25);
  }, { pv: 0.06 });
  def('fish_bite', function (v, t, p) { plop(v, t, p, 0.35); plop(v, t + 0.11, p * 1.15, 0.3); v.noise({ t: t + 0.05, kind: 'pink', filter: { type: 'highpass', f: 2500 }, dur: 0.15, a: 0.03, r: 0.1, vol: 0.1 }); }, { pv: 0.1 });
  def('fish_catch', function (v, t, p) {
    v.noise({ t: t, filter: { type: 'bandpass', f: 900 * p, q: 0.8, fenv: [[0.2, 3000 * p]] }, dur: 0.16, a: 0.01, r: 0.2, vol: 0.4 });
    for (let i = 0; i < 4; i++) v.osc({ t: t + 0.05 + i * 0.05, type: 'sine', f: (300 + i * 120) * p, fenv: [[0.06, (600 + i * 200) * p]], dur: 0.03, r: 0.04, vol: 0.08 });
    bell(v, t + 0.3, 1047 * p, 0.5, 0.16, 2); bell(v, t + 0.42, 1319 * p, 0.8, 0.16, 2);
  }, { pv: 0.03, verb: 0.25 });
  def('fish_fail', function (v, t, p) {
    v.osc({ t: t, type: 'triangle', f: 420 * p, fenv: [[0.25, 300 * p]], dur: 0.2, a: 0.01, r: 0.1, vol: 0.18 });
    v.osc({ t: t + 0.28, type: 'triangle', f: 300 * p, fenv: [[0.3, 200 * p]], dur: 0.25, a: 0.01, r: 0.15, vol: 0.16 });
    plop(v, t + 0.1, p, 0.2);
  }, { pv: 0.03 });
  def('splash', function (v, t, p) {
    v.noise({ t: t, filter: { type: 'bandpass', f: 700 * p, q: 0.7, fenv: [[0.25, 2800 * p]] }, dur: 0.22, a: 0.012, r: 0.35, vol: 0.55 });
    v.noise({ t: t + 0.1, kind: 'pink', filter: { type: 'highpass', f: 2000 }, dur: 0.35, a: 0.1, r: 0.3, vol: 0.2 });
    for (let i = 0; i < 6; i++) v.osc({ t: t + 0.12 + _rand() * 0.35, type: 'sine', f: (250 + _rand() * 300) * p, fenv: [[0.06, (700 + _rand() * 600) * p]], dur: 0.03, r: 0.04, vol: 0.07 });
    v.osc({ t: t, type: 'sine', f: 120 * p, fenv: [[0.12, 50 * p, 'e']], dur: 0.06, r: 0.15, vol: 0.25 });
  }, { pv: 0.08, verb: 0.15 });
  def('swim', function (v, t, p) {
    v.noise({ t: t, kind: 'pink', filter: { type: 'bandpass', f: 600 * p, q: 0.9, fenv: [[0.2, 1600 * p], [0.45, 500 * p]] }, dur: 0.3, a: 0.08, r: 0.15, vol: 0.3 });
    for (let i = 0; i < 3; i++) v.osc({ t: t + 0.1 + _rand() * 0.25, type: 'sine', f: (350 + _rand() * 250) * p, fenv: [[0.05, 800 * p]], dur: 0.02, r: 0.03, vol: 0.05 });
  }, { pv: 0.1 });
  def('eat', function (v, t, p) {
    for (let i = 0; i < 3; i++) { const tt = t + i * 0.19; v.noise({ t: tt, kind: 'pink', filter: { type: 'lowpass', f: (1400 - i * 200) * p, q: 1 }, dur: 0.04, r: 0.06, vol: 0.3 }); v.noise({ t: tt + 0.02, filter: { type: 'bandpass', f: 2600, q: 1.5 }, dur: 0.03, r: 0.04, vol: 0.12 }); }
    v.osc({ t: t + 0.62, type: 'sine', f: 240 * p, fenv: [[0.15, 110 * p, 'e']], dur: 0.1, a: 0.02, r: 0.08, vol: 0.14 });
  }, { pv: 0.08 });
  def('drink', function (v, t, p) {
    for (let i = 0; i < 3; i++) { const tt = t + i * 0.2; v.osc({ t: tt, type: 'sine', f: 320 * p, fenv: [[0.12, 150 * p, 'e']], dur: 0.08, a: 0.01, r: 0.06, vol: 0.16 }); v.noise({ t: tt, filter: { type: 'bandpass', f: 1500, q: 1.2 }, dur: 0.06, a: 0.01, r: 0.05, vol: 0.12 }); }
  }, { pv: 0.06 });

  // ---- creatures ----
  function growl(v, t, p, o) {
    const sh = v.shaper(o.drive || 3), lp = v.filter('lowpass', o.lp || 800, 1.2), bp = v.filter('bandpass', o.form || 400, 2), mix = v.gain(1);
    sh.connect(lp); lp.connect(mix); bp.connect(mix); mix.connect(v.out);
    const fenv = o.fenv.map(function (e) { return [e[0], e[1] * p]; });
    v.osc({ t: t, type: 'sawtooth', f: o.f * p, fenv: fenv, dur: o.dur, a: o.a || 0.05, r: o.r || 0.25, vol: o.vol, dest: sh, vib: { rate: o.vibRate || 14, cents: o.vibCents || 30, delay: 0.05 } });
    v.osc({ t: t, type: 'square', f: o.f * 0.5 * p, fenv: fenv.map(function (e) { return [e[0], e[1] * 0.5]; }), dur: o.dur, a: o.a || 0.05, r: o.r || 0.25, vol: o.vol * 0.5, dest: bp });
    v.noise({ t: t, kind: 'pink', filter: { type: 'bandpass', f: o.form || 400, q: 0.8 }, dur: o.dur, a: 0.05, r: o.r || 0.25, vol: o.vol * 0.6 });
    if (o.sub) v.osc({ t: t, type: 'sine', f: o.f * 0.5 * p, dur: o.dur, a: 0.05, r: o.r || 0.25, vol: o.vol * 0.9 });
  }
  def('wolf_howl', function (v, t, p) {
    const f1 = v.filter('bandpass', 700, 2.5), f2 = v.filter('bandpass', 1150, 3), mix = v.gain(1); f1.connect(mix); f2.connect(mix); mix.connect(v.out);
    const fenv = [[0.35, 620], [0.9, 600], [1.3, 560], [1.75, 400]].map(function (e) { return [e[0], e[1] * p]; });
    v.osc({ t: t, type: 'sawtooth', f: 380 * p, fenv: fenv, dur: 1.5, a: 0.25, r: 0.4, vol: 0.14, dest: f1, vib: { rate: 5, cents: 15, delay: 0.5 } });
    v.osc({ t: t, type: 'sine', f: 380 * p, fenv: fenv, dur: 1.5, a: 0.25, r: 0.4, vol: 0.22, vib: { rate: 5, cents: 15, delay: 0.5 } });
    v.osc({ t: t, type: 'triangle', f: 381 * p, fenv: fenv, dur: 1.5, a: 0.3, r: 0.4, vol: 0.1, dest: f2 });
    v.noise({ t: t, kind: 'pink', filter: { type: 'bandpass', f: 900, q: 1 }, dur: 1.4, a: 0.3, r: 0.4, vol: 0.05 });
  }, { pv: 0.06, verb: 0.6, hall: true });
  def('boar_grunt', function (v, t, p) { growl(v, t, p, { f: 95, fenv: [[0.18, 70]], dur: 0.14, r: 0.1, vol: 0.2, lp: 600, form: 350, drive: 2.5 }); growl(v, t + 0.22, p * 1.08, { f: 100, fenv: [[0.16, 65]], dur: 0.12, r: 0.1, vol: 0.18, lp: 600, form: 380, drive: 2.5 }); }, { pv: 0.1 });
  def('bear_roar', function (v, t, p) { growl(v, t, p, { f: 115, fenv: [[0.25, 140], [0.9, 75]], dur: 0.75, a: 0.08, r: 0.35, vol: 0.24, lp: 900, form: 480, drive: 4, sub: true, vibRate: 12, vibCents: 40 }); }, { pv: 0.08, verb: 0.3 });
  def('spider_hiss', function (v, t, p) {
    const g = v.noise({ t: t, filter: { type: 'highpass', f: 4500 * p, q: 0.7 }, dur: 0.45, a: 0.04, r: 0.15, vol: 0.3 });
    v.lfo({ t: t, type: 'sine', rate: 28, depth: 0.14, param: g.gain, stop: t + 0.7 });
    for (let i = 0; i < 6; i++) v.noise({ t: t + _rand() * 0.5, filter: { type: 'bandpass', f: 3000 + _rand() * 3000, q: 4 }, dur: 0.006, r: 0.012, vol: 0.2 });
  }, { pv: 0.08 });
  def('orc_growl', function (v, t, p) { growl(v, t, p, { f: 135, fenv: [[0.2, 150], [0.6, 95]], dur: 0.5, a: 0.04, r: 0.2, vol: 0.22, lp: 1100, form: 520, drive: 5, vibRate: 18, vibCents: 35 }); }, { pv: 0.1, verb: 0.2 });
  def('troll_roar', function (v, t, p) { growl(v, t, p, { f: 62, fenv: [[0.3, 78], [1.0, 60], [1.4, 42]], dur: 1.2, a: 0.1, r: 0.45, vol: 0.32, lp: 700, form: 300, drive: 7, sub: true, vibRate: 9, vibCents: 45 }); v.noise({ t: t, kind: 'brown', filter: { type: 'lowpass', f: 200 }, dur: 1.2, a: 0.1, r: 0.4, vol: 0.4 }); }, { pv: 0.06, verb: 0.45, hall: true });
  def('wight_moan', function (v, t, p) {
    const fenv = [[0.6, 190], [1.3, 215], [2.0, 170]].map(function (e) { return [e[0], e[1] * p]; });
    v.osc({ t: t, type: 'sine', f: 220 * p, fenv: fenv, dur: 1.8, a: 0.5, r: 0.7, vol: 0.2, vib: { rate: 2.5, cents: 40, delay: 0.3 } });
    v.osc({ t: t, type: 'triangle', f: 221 * p, fenv: fenv, dur: 1.8, a: 0.5, r: 0.7, vol: 0.1, vib: { rate: 3.2, cents: 30, delay: 0.3 }, dest: v.lpOut(900, 1) });
    v.osc({ t: t, type: 'sine', f: 110 * p, fenv: fenv.map(function (e) { return [e[0], e[1] * 0.5]; }), dur: 1.8, a: 0.6, r: 0.7, vol: 0.12 });
    v.noise({ t: t, kind: 'pink', filter: { type: 'bandpass', f: 1400, q: 1.5 }, dur: 1.6, a: 0.7, r: 0.6, vol: 0.08 });
  }, { pv: 0.06, verb: 0.7, hall: true });

  // ---- weather ----
  def('thunder', function (v, t, p) {
    v.noise({ t: t, filter: { type: 'bandpass', f: 1200, q: 0.6 }, dur: 0.04, a: 0.005, r: 0.12, vol: 0.45 });
    const g = v.noise({ t: t + 0.05, kind: 'brown', filter: { type: 'lowpass', f: 140 * p, q: 1.5, fenv: [[0.4, 90], [3.5, 45]] }, dur: 1.2, a: 0.08, r: 2.6, vol: 0.9 });
    v.lfo({ t: t, type: 'sine', rate: 3.3, depth: 0.25, param: g.gain, stop: t + 4.5 });
    v.noise({ t: t + 0.6, kind: 'brown', filter: { type: 'lowpass', f: 220, q: 1 }, dur: 0.6, a: 0.3, r: 1.5, vol: 0.5 });
  }, { pv: 0.1, vol: 1.1, verb: 0.35, hall: true });

  // ================================================================================================
  // AMBIENT BEDS — builders take a Voice (routed to ambientGain or to an sfx Voice) and fill it.
  // ================================================================================================
  // short-lived sub voice inside a long-running bed (so per-event nodes get released)
  function sub(parent, life, pan) {
    const s = new Voice(parent.name + ':e', parent.out);
    if (s.pan && pan != null) s.pan.pan.value = pan;
    setTimeout(function () { s.kill(); }, (life + 0.3) * 1000);
    return s;
  }
  function addGen(v, next, fn) {
    const g = { next: next, tick: function (now, until) { while (g.next < until) { if (v.dead) { generators.delete(g); return; } fn(g.next); g.next += g.gap(); } }, gap: function () { return 0.5; } };
    generators.add(g); v.gen = g;
    const oldKill = v.kill; v.kill = function () { generators.delete(g); oldKill.call(this); };
    return g;
  }
  function bedWind(v, t) {
    const src = v.track(bufN(noiseBuf('pink'), 1, true));
    const bp = v.filter('bandpass', 420, 0.7), lp = v.filter('lowpass', 1100, 0.5), g = v.gain(0.5);
    src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(v.out);
    v.lfo({ t: t, rate: 0.071, depth: 240, param: bp.frequency });
    v.lfo({ t: t, rate: 0.113, depth: 0.2, param: g.gain });
    v.lfo({ t: t, rate: 0.037, depth: 300, param: lp.frequency });
    const src2 = v.track(bufN(noiseBuf('white'), 1, true));
    const bp2 = v.filter('bandpass', 1500, 3), g2 = v.gain(0.06);
    src2.connect(bp2); bp2.connect(g2); g2.connect(v.out);
    v.lfo({ t: t, rate: 0.19, depth: 0.05, param: g2.gain });
    v.lfo({ t: t, rate: 0.083, depth: 600, param: bp2.frequency });
    src.start(t, _rand()); src2.start(t, _rand());
  }
  function chirp(v, t) {
    const s = sub(v, 0.8, _rr(-0.75, 0.75));
    const base = _rr(2200, 4200), n = 2 + Math.floor(_rand() * 3), gap = _rr(0.07, 0.16);
    for (let i = 0; i < n; i++) {
      const f0 = base * _rr(0.85, 1.15), up = _rand() < 0.5, dur = _rr(0.04, 0.1);
      s.osc({ t: t + i * gap, type: 'sine', f: f0, fenv: [[dur * 0.5, f0 * (up ? 1.3 : 0.75), 'e'], [dur, f0 * (up ? 1.1 : 0.9), 'e']], dur: dur, a: 0.01, r: 0.03, vol: _rr(0.05, 0.1) });
    }
  }
  function bedBirds(v, t) {
    const g = addGen(v, t + 0.3, function (tt) { chirp(v, tt); if (_rand() < 0.3) chirp(v, tt + _rr(0.2, 0.5)); });
    g.gap = function () { return _rr(0.6, 2.8); };
    // faint distant bird bed so it is never fully silent
    const src = v.track(bufN(noiseBuf('pink'), 1, true)); const bp = v.filter('bandpass', 3800, 6), gg = v.gain(0.012);
    src.connect(bp); bp.connect(gg); gg.connect(v.out); v.lfo({ t: t, rate: 0.3, depth: 0.008, param: gg.gain }); src.start(t, _rand());
  }
  function cricket(v, t, f, rate, burstRate, pan) {
    const src = v.track(bufN(noiseBuf('white'), 1, true));
    const bp = v.filter('bandpass', f, 22), am = v.gain(0.5), burst = v.gain(0.5), pn = v.track(panN(pan)) || v.gain(1);
    src.connect(bp); bp.connect(am); am.connect(burst); burst.connect(pn); pn.connect(v.out);
    v.lfo({ t: t, type: 'square', rate: rate, depth: 0.5, param: am.gain });
    v.lfo({ t: t, type: 'square', rate: burstRate, depth: 0.5, param: burst.gain });
    src.start(t, _rand());
  }
  function bedCrickets(v, t) {
    cricket(v, t, 4300, 24, 0.71, -0.5); cricket(v, t, 5200, 31, 0.43, 0.55); cricket(v, t, 3700, 19, 0.29, 0.1);
    const g = v.gain(0.18); v.out.connect(g); // crickets are quiet; scale whole bed
  }
  function bedWaves(v, t) {
    const src = v.track(bufN(noiseBuf('brown'), 1, true));
    const lp = v.filter('lowpass', 600, 0.7), g = v.gain(0.5);
    src.connect(lp); lp.connect(g); g.connect(v.out);
    v.lfo({ t: t, rate: 0.09, depth: 380, param: lp.frequency });
    v.lfo({ t: t, rate: 0.093, depth: 0.38, param: g.gain });
    const foam = v.track(bufN(noiseBuf('white'), 1, true)); const bp = v.filter('bandpass', 2600, 0.5), fg = v.gain(0.1);
    foam.connect(bp); bp.connect(fg); fg.connect(v.out);
    v.lfo({ t: t, rate: 0.093, depth: 0.09, param: fg.gain });
    v.lfo({ t: t, rate: 0.041, depth: 900, param: bp.frequency });
    src.start(t, _rand()); foam.start(t, _rand());
  }
  function bedFire(v, t) {
    const src = v.track(bufN(noiseBuf('brown'), 1, true)); const lp = v.filter('lowpass', 380, 0.8), g = v.gain(0.45);
    src.connect(lp); lp.connect(g); g.connect(v.out);
    v.lfo({ t: t, rate: 0.6, depth: 0.12, param: g.gain }); v.lfo({ t: t, rate: 2.3, depth: 0.07, param: g.gain });
    const hiss = v.track(bufN(noiseBuf('pink'), 1, true)); const bp = v.filter('bandpass', 1100, 1), hg = v.gain(0.1);
    hiss.connect(bp); bp.connect(hg); hg.connect(v.out); v.lfo({ t: t, rate: 7.1, depth: 0.06, param: hg.gain });
    src.start(t, _rand()); hiss.start(t, _rand());
    const gen = addGen(v, t + 0.1, function (tt) {
      const s = sub(v, 0.3, _rr(-0.3, 0.3));
      s.noise({ t: tt, filter: { type: 'highpass', f: _rr(2000, 5000), q: 1 }, dur: _rr(0.004, 0.014), r: _rr(0.01, 0.03), vol: _rr(0.1, 0.35) });
      if (_rand() < 0.25) s.noise({ t: tt + 0.02, filter: { type: 'bandpass', f: _rr(800, 1600), q: 2 }, dur: 0.01, r: 0.03, vol: 0.2 });
    });
    gen.gap = function () { return _rr(0.04, 0.3); };
  }
  function bedRain(v, t) {
    const src = v.track(bufN(noiseBuf('white'), 1, true)); const bp = v.filter('bandpass', 2400, 0.4), lp = v.filter('lowpass', 6500, 0.5), g = v.gain(0.3);
    src.connect(bp); bp.connect(lp); lp.connect(g); g.connect(v.out);
    v.lfo({ t: t, rate: 0.21, depth: 0.05, param: g.gain });
    const rum = v.track(bufN(noiseBuf('pink'), 1, true)); const lp2 = v.filter('lowpass', 450, 0.7), g2 = v.gain(0.16);
    rum.connect(lp2); lp2.connect(g2); g2.connect(v.out);
    src.start(t, _rand()); rum.start(t, _rand());
    const gen = addGen(v, t + 0.1, function (tt) {
      const s = sub(v, 0.3, _rr(-0.8, 0.8)); const f = _rr(1600, 3400);
      s.osc({ t: tt, type: 'sine', f: f, fenv: [[0.05, f * 0.6, 'e']], dur: 0.015, a: 0.002, r: 0.04, vol: _rr(0.02, 0.05) });
    });
    gen.gap = function () { return _rr(0.06, 0.35); };
  }
  const BEDS = { wind: bedWind, birds: bedBirds, crickets: bedCrickets, waves: bedWaves, fire: bedFire, rain: bedRain };
  for (const k in BEDS) def(k + '_loop', (function (fn) { return function (v, t) { fn(v, t); }; })(BEDS[k]), { loop: true, pv: 0 });

  const amb = { beds: {}, biome: 'shire', phase: 'day', rain: false, levels: {} };
  function setBed(name, level) {
    if (!ctx) return;
    let b = amb.beds[name];
    if (level <= 0.001) {
      if (b) { b.target = 0; b.voice.out.gain.setTargetAtTime(0, nowT(), 0.8); if (!b.retire) b.retire = setTimeout(function () { if (b.target === 0) { b.voice.kill(); delete amb.beds[name]; } }, 5000); }
      return;
    }
    if (!b) {
      const v = new Voice('amb:' + name, ambientGain); v.loop = true; v.out.gain.value = 0;
      try { BEDS[name](v, nowT() + 0.02); } catch (e) { v.kill(); return; }
      b = amb.beds[name] = { voice: v, target: 0, retire: null };
    }
    if (b.retire) { clearTimeout(b.retire); b.retire = null; }
    b.target = level;
    b.voice.out.gain.setTargetAtTime(level, nowT(), 1.2);
  }
  const WIND = { mountain: 0.9, arctic: 1.0, barren: 0.7, downs: 0.55, dark: 0.6, island: 0.6, lake: 0.4, shire: 0.28, breeland: 0.3, forest: 0.24, elven: 0.3 };
  const BIRDS = { shire: 0.8, breeland: 0.7, forest: 0.75, elven: 0.6, lake: 0.5, island: 0.45, downs: 0.3, breelandnight: 0 };
  const CRICKETS = { shire: 0.7, breeland: 0.7, forest: 0.85, lake: 0.7, island: 0.6, downs: 0.5, barren: 0.4, elven: 0.5 };
  const WAVES = { island: 0.85, lake: 0.45 };
  A.ambient = function (biome, phase) {
    biome = biome || amb.biome || 'shire'; phase = phase || amb.phase || 'day';
    amb.biome = biome; amb.phase = phase; wantAmbient = { biome: biome, phase: phase };
    if (!ctx) return;
    const night = phase === 'night', dusk = phase === 'dusk', dawn = phase === 'dawn';
    const L = amb.levels;
    L.wind = (WIND[biome] == null ? 0.35 : WIND[biome]) + (night ? 0.08 : 0);
    L.birds = (BIRDS[biome] || 0) * (night ? 0 : dusk ? 0.3 : dawn ? 1.1 : 1) * (amb.rain ? 0.35 : 1);
    L.crickets = (CRICKETS[biome] || 0) * (night ? 1 : dusk ? 0.55 : 0) * (amb.rain ? 0.4 : 1);
    L.waves = WAVES[biome] || 0;
    L.rain = amb.rain ? 0.9 : 0;
    for (const k in L) setBed(k, L[k]);
  };
  A.setAmbientRain = function (on) { amb.rain = !!on; wantRain = amb.rain; if (ctx) A.ambient(amb.biome, amb.phase); };
  A.stopAmbient = function () { for (const k in amb.beds) setBed(k, 0); };
  A.ambientState = amb;
