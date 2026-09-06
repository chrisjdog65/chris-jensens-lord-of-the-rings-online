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
