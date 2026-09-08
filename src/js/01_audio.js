/* ==== 01_audio.js — G.Audio: complete Web Audio engine with NO external files. Everything (66 SFX, 6 ambient
   beds, 19 composed multi-track music themes) is synthesized from oscillators, filtered noise, FM, Karplus-Strong
   plucked strings rendered to buffers, and a convolution reverb from a generated impulse.
   Public API (SPEC §5.9): init(), ready, sfx(name, {pos, vol, pitch, loop}) → handle|null, stopLoop(name),
   music(themeId), stopMusic(), currentTheme, duck(bool), setVolumes(music, sfx), ambient(biome, phase),
   setAmbientRain(bool). Extras (documented here, harmless if unused): footstep(groundType, opts),
   update(dt) (positional loop refresh; also self-driven), stats {nodes, voices, notes, suppressed},
   names (SFX list), themes (theme id list), has(name), hasTheme(id), isLooping(name), musicStats() (hook:
   {id, gain, players[], generators}), suspend()/resume(), stopAll(), and the live bus nodes
   ctx/master/comp/musicGain/sfxGain/ambientGain for metering. Self-initialises on the first
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
  let verbRoom, verbHall, verbHallS, roomSend, hallSend, hallSendS;   // convolvers + their input send gains
                                                // (hallSend = music hall, returns INTO the music bus so the music
                                                //  slider and ducking apply to the tail; hallSendS = SFX hall,
                                                //  returns into the SFX bus for the same reason)
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
  A.stats = { nodes: 0, voices: 0, notes: 0, suppressed: 0 };
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
    A.musicGain = musicGain; A.sfxGain = sfxGain; A.ambientGain = ambientGain; A.ctx = ctx; A.master = master; A.comp = comp;
    // reverbs: short room for SFX, long hall for music/ambience
    verbRoom = mk(ctx.createConvolver()); verbRoom.buffer = impulseBuf(1.1, 3.2, 0.5);
    verbHall = mk(ctx.createConvolver()); verbHall.buffer = impulseBuf(2.8, 2.6, 0.35);
    verbHallS = mk(ctx.createConvolver()); verbHallS.buffer = impulseBuf(1.8, 2.4, 0.4);
    roomSend = gainN(1); hallSend = gainN(1); hallSendS = gainN(1);
    const roomOut = gainN(0.55), hallOut = gainN(0.75), hallOutS = gainN(0.8);
    roomSend.connect(verbRoom); verbRoom.connect(roomOut); roomOut.connect(sfxGain);
    hallSend.connect(verbHall); verbHall.connect(hallOut); hallOut.connect(duckGain);      // music tails follow the music fader + duck
    hallSendS.connect(verbHallS); verbHallS.connect(hallOutS); hallOutS.connect(sfxGain);  // sfx tails follow the sfx fader
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
      if (!running) { if (!g.paused) { g.paused = true; g.pausedAt = now; } continue; }
      if (g.paused) { g.paused = false; if (g.resync) g.resync(now - g.pausedAt); }
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
    verb: function (amount, hall) { const g = this.track(gainN(amount)); this.out.connect(g); g.connect(hall ? hallSendS : roomSend); return g; },
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
  const SFX = {};          // name → { pv: pitchVariance, verb, hall, gap, fn(v, t, p, o) }
  function def(name, fn, opts) { SFX[name] = Object.assign({ fn: fn, pv: 0.06 }, opts || {}); }
  // Minimum re-trigger gap per SFX name (seconds). Stops a caller that fires the same cue many times in one
  // frame (e.g. 60 level-ups from one addXP, a cleave hitting five targets) from stacking identical voices —
  // phase-identical copies only sum into a click and evict everything else through the voice cap.
  const DEFAULT_GAP = 0.045;
  const GAP = {
    level_up: 1.6, achievement: 0.9, quest_complete: 0.9, quest_accept: 0.45, quest_progress: 0.3,
    coin: 0.14, loot: 0.12, equip: 0.1, ui_open: 0.12, ui_close: 0.12, ui_error: 0.25, chat_ping: 0.3,
    death: 0.35, hurt: 0.2, thunder: 0.6, horse_neigh: 0.5, horse_mount: 0.35, boat_bell: 0.5,
    fish_cast: 0.3, fish_bite: 0.3, fish_catch: 0.4, fish_fail: 0.4, admin_open: 0.4, door_open: 0.2, door_close: 0.2,
    wolf_howl: 0.35, bear_roar: 0.35, troll_roar: 0.35, boar_grunt: 0.3, spider_hiss: 0.3, orc_growl: 0.3, wight_moan: 0.4,
  };
  const lastStart = new Map();

  A.sfx = function (name, o) {
    if (!ctx || !A.ready || !name) return null;
    const d = SFX[name]; if (!d) return null;
    o = o || {};
    if (ctx.state !== 'running') { if (!o.loop && !d.loop) return null; }
    spatial(o.pos, _sp);
    if (_sp.gain <= 0.005) return null;
    const isLoop = !!(o.loop || d.loop);
    if (isLoop && loops.has(name)) { const ex = loops.get(name); if (ex && !ex.dead) { if (o.pos) ex.pos = o.pos; return ex; } }
    if (!isLoop) {                                   // anti machine-gun: collapse identical cues fired together
      const tn = nowT(), gap = d.gap == null ? (GAP[name] == null ? DEFAULT_GAP : GAP[name]) : d.gap;
      if (gap > 0) { const prev = lastStart.get(name); if (prev != null && tn - prev < gap) { A.stats.suppressed++; return null; } lastStart.set(name, tn); }
    }
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
    try { d.fn(v, t, pitch, o); } catch (e) { v.kill(); if (G.reportError) G.reportError(e, 'Audio.sfx(' + name + ')'); return null; }
    voices.push(v); A.stats.voices = voices.length;
    if (isLoop) { v.loopName = name; loops.set(name, v); }
    return v;
  };
  A.stopLoop = function (name, fade) { const v = loops.get(name); if (v) v.stop(fade); };
  A.isLooping = function (name) { const v = loops.get(name); return !!(v && !v.dead && v.loop); };
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
    const sh = v.shaper(o.drive || 3), sg = v.gain(0.3), lp = v.filter('lowpass', o.lp || 800, 1.2), bp = v.filter('bandpass', o.form || 400, 2), mix = v.gain(1);
    sh.connect(sg); sg.connect(lp); lp.connect(mix); bp.connect(mix); mix.connect(v.out);
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
  def('troll_roar', function (v, t, p) { growl(v, t, p, { f: 62, fenv: [[0.3, 78], [1.0, 60], [1.4, 42]], dur: 1.2, a: 0.1, r: 0.45, vol: 0.32, lp: 700, form: 300, drive: 7, sub: true, vibRate: 9, vibCents: 45 }); v.noise({ t: t, kind: 'brown', filter: { type: 'lowpass', f: 200 }, dur: 1.2, a: 0.1, r: 0.4, vol: 0.22 }); }, { pv: 0.06, verb: 0.45, hall: true });
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
    const g = v.noise({ t: t + 0.05, kind: 'brown', filter: { type: 'lowpass', f: 140 * p, q: 1.5, fenv: [[0.4, 90], [3.5, 45]] }, dur: 1.2, a: 0.08, r: 2.6, vol: 0.5 });
    v.lfo({ t: t, type: 'sine', rate: 3.3, depth: 0.25, param: g.gain, stop: t + 4.5 });
    v.noise({ t: t + 0.6, kind: 'brown', filter: { type: 'lowpass', f: 220, q: 1 }, dur: 0.6, a: 0.3, r: 1.5, vol: 0.3 });
  }, { pv: 0.1, vol: 0.9, verb: 0.35, hall: true });

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
    const bp = v.filter('bandpass', f, 22), am = v.gain(0.5), burst = v.gain(0.5), pn = v.track(panN(pan)) || v.gain(1), sc = v.gain(0.2);
    src.connect(bp); bp.connect(am); am.connect(burst); burst.connect(pn); pn.connect(sc); sc.connect(v.out);
    v.lfo({ t: t, type: 'square', rate: rate, depth: 0.5, param: am.gain });
    v.lfo({ t: t, type: 'square', rate: burstRate, depth: 0.5, param: burst.gain });
    src.start(t, _rand());
  }
  function bedCrickets(v, t) {
    cricket(v, t, 4300, 24, 0.71, -0.5); cricket(v, t, 5200, 31, 0.43, 0.55); cricket(v, t, 3700, 19, 0.29, 0.1);
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

  // ================================================================================================
  // MUSIC ENGINE — notation, instruments, look-ahead scheduler, crossfading players
  // ================================================================================================
  const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function midi(s) { const m = /^([A-G])([#b]?)(-?\d)$/.exec(s); if (!m) return null; return 12 * (+m[3] + 1) + NOTE_BASE[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0); }
  function hz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  // seq("E4/1.5 F#4/.5 G4 _/1 [ A4 B4 ]x2 C4+E4+G4/2@.6") → [{t, n:[midi...], d, v}] (beats)
  function seq(str, o) {
    o = o || {}; const out = []; let t = o.start || 0; const vel = o.vel == null ? 0.8 : o.vel; const tr = o.tr || 0;
    const toks = str.replace(/\|/g, ' ').trim().split(/\s+/); const stack = [];
    for (let i = 0; i < toks.length; i++) {
      const tk = toks[i]; if (!tk) continue;
      if (tk === '[') { stack.push({ idx: out.length, t0: t }); continue; }
      const gm = /^\]x(\d+)$/.exec(tk);
      if (gm || tk === ']') {
        const g = stack.pop(); if (!g) continue; const reps = gm ? +gm[1] : 1; const evs = out.slice(g.idx); const len = t - g.t0;
        for (let r = 1; r < reps; r++) for (const e of evs) out.push({ t: e.t + len * r, n: e.n, d: e.d, v: e.v });
        t = g.t0 + len * reps; continue;
      }
      const m = /^([^\/@]+)(?:\/([\d.]+))?(?:@([\d.]+))?$/.exec(tk); if (!m) continue;
      const d = m[2] != null ? parseFloat(m[2]) : 1, v = m[3] != null ? parseFloat(m[3]) : vel;
      if (m[1] !== '_' && m[1] !== 'R') { const ns = m[1].split('+').map(midi).filter(function (x) { return x != null; }).map(function (x) { return x + tr; }); if (ns.length) out.push({ t: t, n: ns, d: d, v: v }); }
      t += d;
    }
    out.len = t; return out;
  }
  const CHORD = { '': [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], maj7: [0, 4, 7, 11], sus4: [0, 5, 7], sus2: [0, 2, 7], dim: [0, 3, 6], '5': [0, 7, 12], add9: [0, 4, 7, 14], madd9: [0, 3, 7, 14], m9: [0, 3, 7, 10, 14], '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], aug: [0, 4, 8], mM7: [0, 3, 7, 11], '9': [0, 4, 7, 10, 14], m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9] };
  function chordName(name, oct) { const m = /^([A-G][#b]?)(.*)$/.exec(name); if (!m) return name; const root = midi(m[1] + oct); const iv = CHORD[m[2]] || CHORD['']; return iv.map(function (i) { return noteName(root + i); }).join('+'); }
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function noteName(m) { return NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
  // chords("Am/4 F/4 C/2 G/2", {oct:3}) — chord symbols in the same grammar as seq
  function chords(str, o) {
    o = o || {}; const oct = o.oct == null ? 3 : o.oct;
    const conv = str.replace(/(^|\s)([A-G][#b]?(?:maj7|m7b5|dim7|madd9|add9|sus4|sus2|dim|aug|mM7|m7|m9|m6|m|7|9|6|5)?)(?=[\/@\s]|$)/g, function (_, pre, name) { return pre + chordName(name, oct); });
    return seq(conv, o);
  }
  // drums("x...o...X...o.o.", step) — x=hit, X=accent, o=soft
  function drums(str, step, o) {
    step = step || 0.5; const out = []; let t = o && o.start || 0; const clean = str.replace(/[|\s]/g, '');
    for (let i = 0; i < clean.length; i++) { const c = clean[i]; if (c === 'x') out.push({ t: t, n: [0], d: step, v: 0.85 }); else if (c === 'X') out.push({ t: t, n: [0], d: step, v: 1 }); else if (c === 'o') out.push({ t: t, n: [0], d: step, v: 0.45 }); t += step; }
    out.len = t; return out;
  }
  // arp(chordEvents, [0,1,2,1], stepBeats) → single notes cycling through chord tones (index ≥ len → octave up)
  function arp(chEvs, pattern, step, o) {
    o = o || {}; const out = []; const gate = o.gate || step * 1.9; const vel = o.vel == null ? 0.7 : o.vel;
    for (const c of chEvs) { let k = 0; for (let t = c.t; t < c.t + c.d - 1e-6; t += step, k++) { const idx = pattern[k % pattern.length]; if (idx < 0) continue; const len = c.n.length; const n = c.n[idx % len] + 12 * Math.floor(idx / len) + (o.tr || 0); out.push({ t: t, n: [n], d: gate, v: vel * (k % pattern.length === 0 ? 1 : 0.85) }); } }
    return out;
  }
  function shift(evs, beats) { return evs.map(function (e) { return { t: e.t + beats, n: e.n, d: e.d, v: e.v }; }); }
  function concat() { let out = [], t = 0; for (let i = 0; i < arguments.length; i++) { const a = arguments[i]; out = out.concat(shift(a, t)); t += a.len || 0; } out.len = t; return out; }
  function transpose(evs, semis) { const o = evs.map(function (e) { return { t: e.t, n: e.n.map(function (n) { return n + semis; }), d: e.d, v: e.v }; }); o.len = evs.len; return o; }

  // ---- note voice (lightweight Voice routed straight into a track gain) ----
  function NVoice(dest) { this.name = 'n'; this.nodes = []; this.endAt = 0; this.dead = false; this.out = gainN(1); this.out.connect(dest); this.nodes.push(this.out); }
  NVoice.prototype = Object.create(Voice.prototype);
  NVoice.prototype.refreshSpatial = function () {};
  function note(dest, e, build) {
    const v = new NVoice(dest);
    try { build(v, e); } catch (err) { v.kill(); return; }
    A.stats.notes++;
    const life = Math.max(0.2, v.endAt - nowT()) + 0.4;
    setTimeout(function () { v.kill(); }, life * 1000);
  }

  // ---- instruments: fn(v, e) with e = {t, f, d (sec gate), v (0..1), m (midi)} ----
  const INST = {};
  INST.pad = function (v, e) {
    const fl = v.lpOut(500 + 1400 * e.v, 0.8); fl.frequency.setValueAtTime(400, e.t); fl.frequency.linearRampToValueAtTime(700 + 1500 * e.v, e.t + Math.min(1.2, e.d * 0.6)); fl.frequency.setTargetAtTime(500, e.t + e.d, 0.5);
    const vol = 0.09 * e.v;
    v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: -8, dur: e.d, a: Math.min(0.7, e.d * 0.4), r: 1.2, vol: vol, dest: fl });
    v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: 8, dur: e.d, a: Math.min(0.7, e.d * 0.4), r: 1.2, vol: vol, dest: fl });
    v.osc({ t: e.t, type: 'triangle', f: e.f * 0.5, dur: e.d, a: Math.min(0.9, e.d * 0.5), r: 1.2, vol: vol * 0.9, dest: fl });
  };
  INST.choir = function (v, e) {
    const f1 = v.filter('bandpass', 720, 3), f2 = v.filter('bandpass', 1180, 4), lp = v.lpOut(2600, 0.5); f1.connect(lp); f2.connect(lp);
    const vol = 0.11 * e.v, a = Math.min(0.9, e.d * 0.45);
    v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: -6, dur: e.d, a: a, r: 1.4, vol: vol, dest: f1, vib: { rate: 4.5, cents: 7, delay: 0.6 } });
    v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: 7, dur: e.d, a: a, r: 1.4, vol: vol, dest: f2, vib: { rate: 5.2, cents: 6, delay: 0.8 } });
    v.osc({ t: e.t, type: 'sine', f: e.f, dur: e.d, a: a, r: 1.4, vol: vol * 1.1, dest: lp, vib: { rate: 4.8, cents: 6, delay: 0.7 } });
    v.noise({ t: e.t, kind: 'pink', filter: { type: 'bandpass', f: 1500, q: 1 }, dur: e.d, a: a, r: 1.2, vol: vol * 0.25, dest: lp });
  };
  INST.flute = function (v, e) {
    const vol = 0.22 * e.v;
    v.osc({ t: e.t, type: 'sine', f: e.f, dur: e.d, a: 0.06, d: 0.1, s: 0.85, r: 0.18, vol: vol, vib: { rate: 5.3, cents: 9, delay: 0.25 } });
    v.osc({ t: e.t, type: 'triangle', f: e.f, dur: e.d, a: 0.07, d: 0.1, s: 0.7, r: 0.18, vol: vol * 0.35, vib: { rate: 5.3, cents: 9, delay: 0.25 }, dest: v.lpOut(2800, 0.5) });
    v.noise({ t: e.t, kind: 'pink', filter: { type: 'bandpass', f: e.f * 2, q: 2.5 }, dur: 0.08, a: 0.02, r: 0.08, vol: vol * 0.35 });
    v.noise({ t: e.t, kind: 'pink', filter: { type: 'bandpass', f: e.f, q: 6 }, dur: e.d, a: 0.1, r: 0.15, vol: vol * 0.12 });
  };
  INST.lute = function (v, e) { v.pluck({ t: e.t, f: e.f, dur: Math.min(1.6, Math.max(0.5, e.d + 0.5)), bright: 0.55 + 0.4 * e.v, decay: 0.9, vol: 0.45 * e.v, kind: 'lute' }); };
  INST.harp = function (v, e) { v.pluck({ t: e.t, f: e.f, dur: Math.min(3, Math.max(1.2, e.d + 1.2)), bright: 0.3 + 0.3 * e.v, decay: 2.2, vol: 0.42 * e.v, kind: 'harp' }); };
  INST.horn = function (v, e) {
    const lp = v.lpOut(1800 + 1500 * e.v, 0.7);
    v.fm({ t: e.t, f: e.f, ratio: 1, idx: 0.3, idxEnd: 1.2 + e.v, idxHold: 0.03, idxDecay: 0.25, dur: e.d, a: 0.07, d: 0.15, s: 0.85, r: 0.3, vol: 0.26 * e.v, dest: lp });
    v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: 4, dur: e.d, a: 0.09, d: 0.15, s: 0.8, r: 0.3, vol: 0.06 * e.v, dest: lp, vib: { rate: 4.5, cents: 5, delay: 0.4 } });
  };
  INST.brass = function (v, e) {
    const lp = v.lpOut(2500 + 2000 * e.v, 1); const sh = v.shaper(1.6); sh.connect(lp);
    v.fm({ t: e.t, f: e.f, ratio: 1, idx: 0.5, idxEnd: 2.2, idxHold: 0.02, idxDecay: 0.12, type: 'sawtooth', dur: e.d, a: 0.03, d: 0.1, s: 0.8, r: 0.15, vol: 0.2 * e.v, dest: sh });
    v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: -6, dur: e.d, a: 0.03, d: 0.1, s: 0.8, r: 0.15, vol: 0.1 * e.v, dest: sh });
    v.osc({ t: e.t, type: 'sawtooth', f: e.f * 2, detune: 5, dur: e.d, a: 0.03, d: 0.1, s: 0.7, r: 0.15, vol: 0.04 * e.v, dest: sh });
  };
  INST.strings = function (v, e) {
    const lp = v.lpOut(900 + 1600 * e.v, 0.6); const vol = 0.09 * e.v, a = Math.min(0.35, e.d * 0.3);
    for (let i = 0; i < 3; i++) v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: [-9, 0, 8][i], dur: e.d, a: a, d: 0.3, s: 0.9, r: 0.5, vol: vol, dest: lp, vib: { rate: 4.6 + i * 0.4, cents: 6, delay: 0.3 } });
  };
  INST.lowstrings = function (v, e) {
    const lp = v.lpOut(500 + 900 * e.v, 0.8); const vol = 0.13 * e.v, a = Math.min(0.25, e.d * 0.3);
    v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: -7, dur: e.d, a: a, d: 0.2, s: 0.9, r: 0.4, vol: vol, dest: lp, vib: { rate: 4.2, cents: 5, delay: 0.3 } });
    v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: 7, dur: e.d, a: a, d: 0.2, s: 0.9, r: 0.4, vol: vol, dest: lp });
    v.osc({ t: e.t, type: 'sine', f: e.f * 0.5, dur: e.d, a: a, r: 0.4, vol: vol * 0.8 });
  };
  INST.pizz = function (v, e) { v.pluck({ t: e.t, f: e.f, dur: 0.7, bright: 0.35, decay: 0.35, vol: 0.55 * e.v, kind: 'pizz' }); v.osc({ t: e.t, type: 'sine', f: e.f, dur: 0.05, a: 0.003, r: 0.15, vol: 0.2 * e.v }); };
  INST.bass = function (v, e) {
    const lp = v.lpOut(300 + 500 * e.v, 1);
    v.osc({ t: e.t, type: 'triangle', f: e.f, dur: e.d, a: 0.01, d: 0.25, s: 0.6, r: 0.12, vol: 0.4 * e.v, dest: lp });
    v.osc({ t: e.t, type: 'sine', f: e.f, dur: e.d, a: 0.01, d: 0.3, s: 0.7, r: 0.12, vol: 0.3 * e.v });
  };
  INST.bells = function (v, e) {
    v.fm({ t: e.t, f: e.f, ratio: 3.5, idx: 1.4 * e.v, idxDecay: 0.5, dur: 0.1, a: 0.003, r: Math.max(1.2, e.d + 0.8), vol: 0.18 * e.v });
    v.osc({ t: e.t, type: 'sine', f: e.f * 2, dur: 0.05, a: 0.003, r: 0.6, vol: 0.05 * e.v });
  };
  INST.glass = function (v, e) {
    v.fm({ t: e.t, f: e.f, ratio: 2.0, idx: 0.8 * e.v, idxDecay: 0.8, dur: 0.15, a: 0.01, r: Math.max(1.8, e.d + 1.2), vol: 0.16 * e.v });
    v.osc({ t: e.t, type: 'sine', f: e.f * 3.01, dur: 0.05, a: 0.005, r: 1.0, vol: 0.03 * e.v });
    v.osc({ t: e.t, type: 'sine', f: e.f, dur: e.d, a: 0.3, r: 1.2, vol: 0.06 * e.v, vib: { rate: 3, cents: 4, delay: 0.5 } });
  };
  INST.anvil = function (v, e) {
    v.fm({ t: e.t, f: e.f, ratio: 2.76, idx: 3, idxDecay: 0.1, dur: 0.03, a: 0.002, r: 0.5, vol: 0.2 * e.v });
    v.fm({ t: e.t, f: e.f * 1.6, ratio: 1.41, idx: 2, idxDecay: 0.06, dur: 0.02, r: 0.25, vol: 0.1 * e.v });
    v.noise({ t: e.t, filter: { type: 'highpass', f: 3000 }, dur: 0.01, r: 0.03, vol: 0.25 * e.v });
  };
  INST.drone = function (v, e) {
    const lp = v.lpOut(240, 1); const a = Math.min(2, e.d * 0.4);
    v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: -5, dur: e.d, a: a, r: 2, vol: 0.12 * e.v, dest: lp });
    v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: 6, dur: e.d, a: a, r: 2, vol: 0.12 * e.v, dest: lp });
    v.osc({ t: e.t, type: 'sine', f: e.f, dur: e.d, a: a, r: 2, vol: 0.28 * e.v });
    v.osc({ t: e.t, type: 'sine', f: e.f * 0.5, dur: e.d, a: a, r: 2, vol: 0.18 * e.v });
  };
  INST.accordion = function (v, e) {
    const bp = v.filter('bandpass', 1100, 0.9), lp = v.lpOut(3200, 0.6); bp.connect(lp); const vol = 0.07 * e.v;
    v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: -10, dur: e.d, a: 0.04, r: 0.1, vol: vol, dest: bp, vib: { rate: 6.5, cents: 4, delay: 0.1 } });
    v.osc({ t: e.t, type: 'sawtooth', f: e.f, detune: 10, dur: e.d, a: 0.04, r: 0.1, vol: vol, dest: bp });
    v.osc({ t: e.t, type: 'square', f: e.f, dur: e.d, a: 0.04, r: 0.1, vol: vol * 0.6, dest: lp });
  };
  INST.windpad = function (v, e) {
    const src = v.track(bufN(noiseBuf('pink'), 1, true)); const bp = v.filter('bandpass', e.f * 2, 8), g = v.gain(0);
    src.connect(bp); bp.connect(g); g.connect(v.out);
    adsr(g.gain, e.t, Math.min(2, e.d * 0.4), 0, 1, 2, e.d, 0.25 * e.v);
    v.lfo({ t: e.t, rate: 0.13, depth: e.f * 0.5, param: bp.frequency, stop: e.t + e.d + 2.5 });
    src.start(e.t); src.stop(e.t + e.d + 2.5); v.end(e.t + e.d + 2.5);
  };
  // ---- percussion (pitch ignored) ----
  INST.kick = function (v, e) { v.osc({ t: e.t, type: 'sine', f: 150, fenv: [[0.09, 42, 'e']], dur: 0.05, a: 0.002, r: 0.28, vol: 0.9 * e.v }); v.noise({ t: e.t, filter: { type: 'lowpass', f: 800 }, dur: 0.01, r: 0.04, vol: 0.3 * e.v }); };
  INST.taiko = function (v, e) { v.osc({ t: e.t, type: 'sine', f: 95, fenv: [[0.15, 48, 'e']], dur: 0.12, a: 0.003, r: 0.55, vol: 1.0 * e.v }); v.noise({ t: e.t, kind: 'pink', filter: { type: 'lowpass', f: 600 }, dur: 0.04, r: 0.15, vol: 0.5 * e.v }); v.noise({ t: e.t, filter: { type: 'bandpass', f: 2500, q: 1 }, dur: 0.008, r: 0.03, vol: 0.15 * e.v }); };
  INST.timpani = function (v, e) { v.osc({ t: e.t, type: 'sine', f: e.f || 82, fenv: [[0.5, (e.f || 82) * 0.9, 'e']], dur: 0.2, a: 0.004, r: 0.9, vol: 0.8 * e.v }); v.noise({ t: e.t, kind: 'pink', filter: { type: 'lowpass', f: 500 }, dur: 0.03, r: 0.12, vol: 0.4 * e.v }); };
  INST.snare = function (v, e) { v.noise({ t: e.t, filter: { type: 'bandpass', f: 1900, q: 0.8 }, dur: 0.03, r: 0.14, vol: 0.55 * e.v }); v.noise({ t: e.t, filter: { type: 'highpass', f: 5000 }, dur: 0.02, r: 0.1, vol: 0.25 * e.v }); v.osc({ t: e.t, type: 'triangle', f: 190, fenv: [[0.05, 120, 'e']], dur: 0.02, r: 0.08, vol: 0.35 * e.v }); };
  INST.tom = function (v, e) { v.osc({ t: e.t, type: 'sine', f: 130, fenv: [[0.2, 75, 'e']], dur: 0.05, a: 0.003, r: 0.3, vol: 0.7 * e.v }); v.noise({ t: e.t, kind: 'pink', filter: { type: 'lowpass', f: 900 }, dur: 0.02, r: 0.08, vol: 0.3 * e.v }); };
  INST.hat = function (v, e) { v.noise({ t: e.t, filter: { type: 'highpass', f: 7500 }, dur: 0.01, r: 0.04 + 0.05 * e.v, vol: 0.28 * e.v }); };
  INST.shaker = function (v, e) { v.noise({ t: e.t, filter: { type: 'bandpass', f: 6500, q: 1.2 }, dur: 0.03, a: 0.015, r: 0.07, vol: 0.22 * e.v }); };
  INST.tamb = function (v, e) { v.noise({ t: e.t, filter: { type: 'highpass', f: 5500 }, dur: 0.03, r: 0.15, vol: 0.25 * e.v }); v.fm({ t: e.t, f: 4200, ratio: 1.7, idx: 1, idxDecay: 0.08, dur: 0.02, r: 0.14, vol: 0.06 * e.v }); };
  INST.handdrum = function (v, e) { v.osc({ t: e.t, type: 'sine', f: 180, fenv: [[0.08, 90, 'e']], dur: 0.03, a: 0.002, r: 0.18, vol: 0.55 * e.v }); v.noise({ t: e.t, kind: 'pink', filter: { type: 'bandpass', f: 1200, q: 1 }, dur: 0.015, r: 0.05, vol: 0.25 * e.v }); };
  INST.cymbal = function (v, e) { v.noise({ t: e.t, filter: { type: 'highpass', f: 4000, q: 0.5 }, dur: 0.05, a: 0.005, r: 1.4 * e.v + 0.3, vol: 0.3 * e.v }); v.fm({ t: e.t, f: 3500, ratio: 1.48, idx: 2, idxDecay: 0.3, dur: 0.05, r: 1.0, vol: 0.05 * e.v }); };

  // ---- Player: schedules one theme with look-ahead on the audio clock ----
  const livePlayers = new Set();
  function Player(id, th) {
    this.id = id; this.th = th; this.dead = false; this.done = false;
    livePlayers.add(this);
    this.gain = gainN(0); this.gain.connect(duckGain);
    this.tracks = th.tracks.map(function (tr) {
      const g = gainN(tr.vol == null ? 0.6 : tr.vol), pn = panN(tr.pan || 0), send = gainN(tr.send == null ? 0.25 : tr.send);
      if (pn) { g.connect(pn); pn.connect(this.gain); } else g.connect(this.gain);
      g.connect(send); send.connect(hallSend);
      return { def: tr, g: g, pn: pn, send: send, i: 0, nodes: [g, pn, send] };
    }, this);
    this.spb = 60 / th.tempo; this.loopBeats = th.bars * th.bpb; this.start = nowT() + 0.12; this.loop = 0;
    const self = this;
    this.gen = { next: this.start, tick: function (now, until) { self.schedule(now, until); }, resync: function (gap) { self.start += gap; } };
    generators.add(this.gen);
  }
  Player.prototype = {
    schedule: function (now, until) {
      if (this.dead) return;
      // a finished one-shot (victory/death) still has to be retired: its tail must run out, then finish() clears
      // currentTheme and emits musicEnded so main can bring the zone theme back.
      if (this.done) { if (this.endAt != null && nowT() > this.endAt) this.finish(); return; }
      const th = this.th, spb = this.spb, lb = this.loopBeats; let guard = 0;
      while (guard++ < 64) {
        let allDone = true;
        for (const tr of this.tracks) {
          const ev = tr.def.ev;
          while (tr.i < ev.length) {
            const e = ev[tr.i]; const at = this.start + (this.loop * lb + e.t) * spb;
            if (at >= until) break;
            tr.i++;
            if (at > now - 0.03) this.play(tr, e, at);
          }
          if (tr.i < ev.length) allDone = false;
        }
        const loopEnd = this.start + (this.loop + 1) * lb * spb;
        if (!allDone || loopEnd >= until) { this.gen.next = Math.max(now, Math.min(until, loopEnd)) - 0.01; break; }
        if (th.loop === false) { this.done = true; this.endAt = loopEnd + 4; this.gen.next = this.endAt; break; }
        this.loop++; for (const tr of this.tracks) tr.i = 0;
      }
      this.gen.next = now;   // always re-evaluated on next tick
      if (this.done && nowT() > this.endAt) this.finish();
    },
    play: function (tr, e, at) {
      const inst = INST[tr.def.inst]; if (!inst) return;
      const d = Math.max(0.05, e.d * this.spb * (tr.def.gate == null ? 0.95 : tr.def.gate));
      for (const m of e.n) note(tr.g, { t: at, f: hz(m + (tr.def.tr || 0)), d: d, v: _clamp(e.v * (tr.def.vel == null ? 1 : tr.def.vel), 0.05, 1.2), m: m }, inst);
    },
    fadeIn: function (sec) { const t = nowT(); this.gain.gain.setValueAtTime(0, t); this.gain.gain.linearRampToValueAtTime(this.th.gain == null ? 1 : this.th.gain, t + sec); },
    fadeOut: function (sec) {
      const t = nowT(); this.gain.gain.cancelScheduledValues(t); this.gain.gain.setValueAtTime(this.gain.gain.value, t); this.gain.gain.linearRampToValueAtTime(0, t + sec);
      this.done = true; generators.delete(this.gen); const self = this; setTimeout(function () { self.kill(); }, (sec + 0.3) * 1000);
    },
    finish: function () { const self = this; this.kill(); if (current === self) { current = null; A.currentTheme = null; if (G.emit) G.emit('musicEnded', self.id); } },
    kill: function () {
      if (this.dead) return; this.dead = true; generators.delete(this.gen); livePlayers.delete(this);
      for (const tr of this.tracks) for (const n of tr.nodes) { try { if (n) n.disconnect(); } catch (e) {} }
      try { this.gain.disconnect(); } catch (e) {}
    },
  };
  let current = null;
  const THEMES = {};             // id → builder fn → {tempo, bpb, bars, loop, tracks:[{inst, vol, pan, send, gate, ev}]}
  const compiled = {};
  function compileTheme(id) {
    if (compiled[id]) return compiled[id];
    const th = THEMES[id](); const lb = th.bars * th.bpb;
    th.tracks = th.tracks.filter(function (tr) { return tr && tr.ev; });
    for (const tr of th.tracks) { tr.ev = tr.ev.filter(function (e) { return e.t < lb - 1e-6; }).sort(function (a, b) { return a.t - b.t; }); }
    compiled[id] = th; return th;
  }
  A.music = function (id) {
    if (id == null) { A.stopMusic(); return; }
    wantTheme = id;
    if (!ctx || !THEMES[id]) return;
    if (current && current.id === id && !current.done) return;
    if (current) { current.fadeOut(2); current = null; }
    let th; try { th = compileTheme(id); } catch (e) { if (G.reportError) G.reportError(e, 'Audio.music(' + id + ')'); return; }
    current = new Player(id, th); current.fadeIn(current.th.fadeIn == null ? 2 : current.th.fadeIn);
    A.currentTheme = id;
  };
  A.stopMusic = function (fade) { wantTheme = null; if (current) current.fadeOut(fade == null ? 2 : fade); current = null; A.currentTheme = null; };
  A.duck = function (on) { A.ducked = !!on; if (!ctx) return; duckGain.gain.setTargetAtTime(on ? 0.3 : 1, nowT(), 0.35); };
  A.themes = [];
  // debug/verification hook: what the music engine is actually running right now
  A.musicStats = function () {
    const out = { id: current ? current.id : null, done: current ? !!current.done : false, gain: current ? +current.gain.gain.value.toFixed(4) : 0, players: [], generators: generators.size };
    livePlayers.forEach(function (p) { out.players.push({ id: p.id, dead: !!p.dead, done: !!p.done, gain: +p.gain.gain.value.toFixed(4), cur: p === current }); });
    return out;
  };
  function theme(id, fn) { THEMES[id] = fn; A.themes.push(id); }

  // ================================================================================================
  // THEMES — composed, multi-track, looping (except victory/death). Beat unit = quarter (4/4, 3/4) or
  // eighth (6/8 themes, bpb 6). Helpers: roots() bass from chords, pick() rhythmic chord tones, strum().
  // ================================================================================================
  function roots(ch, oct, o) { const r = ch.map(function (c) { return { t: c.t, n: [c.n[0] + 12 * (oct || 0)], d: c.d, v: o && o.vel || c.v }; }); r.len = ch.len; return r; }
  function pick(ch, offs, idxs, oct, dur, vel) {
    const out = [];
    for (const c of ch) for (let k = 0; k < offs.length; k++) { if (offs[k] >= c.d) continue; const idx = idxs[k % idxs.length]; const n = c.n[idx % c.n.length] + 12 * Math.floor(idx / c.n.length) + 12 * (oct || 0); out.push({ t: c.t + offs[k], n: [n], d: dur || 1, v: vel == null ? 0.8 : vel }); }
    out.len = ch.len; return out;
  }
  function strum(ch, offs, dur, vel, oct) {
    const out = [];
    for (const c of ch) for (const off of offs) { if (off >= c.d) continue; out.push({ t: c.t + off, n: c.n.map(function (n) { return n + 12 * (oct || 0); }), d: dur || 1, v: vel == null ? 0.7 : vel }); }
    out.len = ch.len; return out;
  }
  function rep(evs, times) { const parts = []; for (let i = 0; i < times; i++) parts.push(evs); return concat.apply(null, parts); }
  function T(inst, ev, o) { o = o || {}; return { inst: inst, ev: ev, vol: o.vol, pan: o.pan, send: o.send, gate: o.gate, tr: o.tr, vel: o.vel }; }

  // ---- MENU: the main theme. D major, slow build: pad+harp → strings melody → horn & drums → full ----
  theme('menu', function () {
    const A8 = 'D/4 Bm/4 G/4 A/4 D/4 Bm/4 G/4 A/4', B8 = 'Bm/4 G/4 D/4 A/4 Bm/4 G/4 Em/4 A/4';
    const ch = chords(A8 + ' ' + A8 + ' ' + B8 + ' ' + A8, { oct: 3, vel: 0.7 });
    const M1 = 'D4/1.5 E4/.5 F#4 A4 | B4/2 A4 F#4 | G4/1.5 A4/.5 B4 D5 | A4/3 _ | D4/1.5 E4/.5 F#4 A4 | B4/1.5 C#5/.5 D5/2 | E5 D5 B4 A4 | F#4/3 _';
    const M2 = 'F#5/1.5 E5/.5 D5 B4 | A4/2 B4 D5 | E5/1.5 F#5/.5 E5 D5 | B4/3 _ | G4 A4 B4 D5 | E5/1.5 F#5/.5 E5 D5 | A4/1.5 B4/.5 A4 F#4 | A4/2 G4 A4';
    const mel = concat(seq('_/32'), seq(M1, { vel: 0.6 }), seq(M2, { vel: 0.75 }), seq(M1, { vel: 0.95, tr: 12 }));
    const horn = concat(seq('_/64'), seq(M2, { vel: 0.7, tr: -12 }), seq(M1, { vel: 1.0 }));
    const harp = arp(ch, [0, 1, 2, 3, 2, 1, 3, 2], 0.5, { vel: 0.5 });
    const perc = concat(seq('_/64'), rep(drums('X...x..o', 0.5), 16));
    const cym = seq('_/96 C4/1@.7 _/31');
    return { gain: 1.0, tempo: 76, bpb: 4, bars: 32, loop: true, tracks: [
      T('pad', ch, { vol: 0.5, send: 0.5 }),
      T('harp', harp, { vol: 0.45, pan: -0.3, send: 0.35 }),
      T('strings', concat(seq('_/32'), ch.filter(function (c) { return c.t >= 32; }).map(function (c) { return { t: c.t - 32, n: c.n.map(function (n) { return n + 12; }), d: c.d, v: 0.6 }; })), { vol: 0.35, pan: 0.2, send: 0.5 }),
      T('strings', mel, { vol: 0.75, send: 0.45 }),
      T('horn', horn, { vol: 0.7, pan: 0.15, send: 0.4 }),
      T('lowstrings', roots(ch, -1, { vel: 0.7 }), { vol: 0.55, send: 0.3 }),
      T('taiko', perc, { vol: 0.5, send: 0.35 }),
      T('cymbal', cym, { vol: 0.35, send: 0.5 }),
    ] };
  });

  // ---- SHIRE: pastoral 6/8, G major, flute & lute ----
  theme('shire', function () {
    const ch = chords('G/6 C/6 G/6 D/6 G/6 C/6 D/6 G/6 Em/6 C/6 G/6 D/6 G/6 C/6 D/6 G/6', { oct: 3, vel: 0.6 });
    const mel = seq('D4 G4 A4 B4/2 A4 | G4 A4 B4 D5/3 | E5 D5 B4 A4/2 G4 | A4/3 F#4/3 | D4 G4 A4 B4/2 A4 | G4 A4 B4 D5/2 E5 | F#5 E5 D5 A4/2 C5 | B4/3 G4/3 | ' +
      'B4 G4 B4 E5/2 D5 | C5 E5 G5 E5/2 C5 | B4 D5 G5 D5/2 B4 | A4/3 F#4/2 A4 | G4 B4 D5 G5/2 F#5 | E5 C5 E5 G5/3 | F#5 D5 A4 C5/2 A4 | G4/6', { vel: 0.8 });
    const lute = arp(ch, [0, 2, 1, 3, 2, 1], 1, { vel: 0.6, gate: 1.5 });
    const bass = pick(ch, [0, 3], [0, 2], -1, 2.5, 0.7);
    const harm = concat(seq('_/48'), seq('G4 E4 G4 C5/2 B4 | A4 C5 E5 C5/2 A4 | G4 B4 D5 B4/2 G4 | F#4/3 D4/2 F#4 | D5 G4 B4 D5/2 D5 | C5 A4 C5 E5/3 | D5 A4 F#4 A4/2 F#4 | G4/6', { vel: 0.45 }));
    return { gain: 1.5, tempo: 264, bpb: 6, bars: 16, loop: true, tracks: [
      T('flute', mel, { vol: 0.7, pan: 0.1, send: 0.35 }),
      T('lute', lute, { vol: 0.5, pan: -0.35, send: 0.25 }),
      T('flute', harm, { vol: 0.4, pan: 0.35, send: 0.4 }),
      T('pizz', bass, { vol: 0.55, send: 0.2 }),
      T('pad', ch, { vol: 0.28, send: 0.5 }),
      T('shaker', rep(drums('x.ox.o', 1), 16), { vol: 0.3, pan: 0.4 }),
    ] };
  });

  // ---- BREELAND: warm folk, D major, lute melody, flute counter, hand drum ----
  theme('breeland', function () {
    const ch = chords('D/4 G/4 D/4 A/4 D/4 G/4 A/4 D/4 Bm/4 G/4 D/4 A/4 G/4 D/4 A/4 D/4', { oct: 3, vel: 0.6 });
    const mel = seq('D4/.5 E4/.5 F#4 A4 F#4 | G4 B4 A4/2 | F#4/.5 G4/.5 A4 D5 A4 | E4/3 _ | D4/.5 E4/.5 F#4 A4 B4 | D5 B4 A4/2 | C#5 B4 A4 E4 | D4/4 | ' +
      'F#5 D5 B4/2 | G4 B4 D5/2 | A4/.5 B4/.5 D5 F#5 D5 | E5/.5 D5/.5 C#5/3 | B4 D5 G5 D5 | F#5/.5 E5/.5 D5/3 | E5 C#5 A4 B4 | D5/4', { vel: 0.85 });
    const counter = seq('_/32 F#5/2 D5/2 | G5/2 B4/2 | F#5/4 | E5/4 | G5/2 B5/2 | F#5/4 | E5/2 C#5/2 | D5/4', { vel: 0.5 });
    const strumEv = strum(ch, [1.5, 3.5], 0.5, 0.45, 1);
    return { gain: 1.5, tempo: 96, bpb: 4, bars: 16, loop: true, tracks: [
      T('lute', mel, { vol: 0.75, pan: -0.15, send: 0.3 }),
      T('flute', counter, { vol: 0.45, pan: 0.3, send: 0.45 }),
      T('lute', strumEv, { vol: 0.35, pan: 0.35, send: 0.25 }),
      T('pizz', pick(ch, [0, 2], [0, 2], -1, 1.5, 0.75), { vol: 0.55 }),
      T('strings', ch, { vol: 0.25, send: 0.5 }),
      T('handdrum', rep(drums('x.o.x.oo', 0.5), 16), { vol: 0.4, pan: 0.1 }),
    ] };
  });

  // ---- FOREST: mysterious E minor pads, harp, sparse flute, distant bells ----
  theme('forest', function () {
    const ch = chords('Em/4 Cmaj7/4 Am/4 Bm/4 Em/4 G/4 Am/4 B7/4 Em/4 Cmaj7/4 D/4 Bm/4 Em/4 Am/4 Cmaj7/4 Em/4', { oct: 3, vel: 0.6 });
    const harp = arp(ch, [0, 1, 2, 3, 4, 3, 2, 1], 0.5, { vel: 0.5, gate: 1.5 });
    const fl = seq('_/2 B4 E5 | G5/2 F#5 E5 | _ E5 D5 C5 | B4/4 | _/4 | _/2 G4 A4 | B4/2 C5 B4 | A4/3 _ | _/2 E5 G5 | B5/2 A5 G5 | F#5/2 E5 D5 | F#5/4 | _/4 | E5 D5 C5 B4 | G4/2 A4 B4 | E4/4', { vel: 0.55 });
    const bells = seq('_/14 E6/2@.4 _/14 B5/2@.35 _/14 G6/2@.35 _/14 E6/2@.4');
    return { gain: 1.5, tempo: 66, bpb: 4, bars: 16, loop: true, tracks: [
      T('pad', ch, { vol: 0.55, send: 0.6 }),
      T('harp', harp, { vol: 0.5, pan: -0.25, send: 0.5 }),
      T('flute', fl, { vol: 0.55, pan: 0.2, send: 0.6 }),
      T('lowstrings', roots(ch, -1, { vel: 0.5 }), { vol: 0.4, send: 0.4 }),
      T('bells', bells, { vol: 0.4, pan: 0.4, send: 0.7 }),
    ] };
  });

  // ---- BARREN: sparse lonely horn over a drone, wind ----
  theme('barren', function () {
    const horn = seq('_/4 | D4/3 F4 | A4/4 | G4/2 F4/2 | E4/6 | _/2 | D4/2 F4/2 | A4/2 C5/2 | D5/6 | _/2 | C5/2 A4/2 | G4/2 F4 E4 | D4/8 | _/8', { vel: 0.6 });
    const low = chords('Dm/8 Dm/8 Bb/8 Gm/4 A/4 Dm/8 F/8 Bb/8 A/8', { oct: 2, vel: 0.4 });
    return { gain: 1.6, tempo: 60, bpb: 4, bars: 16, loop: true, tracks: [
      T('drone', seq('D2/64@.7'), { vol: 0.5, send: 0.4 }),
      T('windpad', seq('D3/64@.8'), { vol: 0.35, send: 0.5 }),
      T('horn', horn, { vol: 0.6, pan: 0.15, send: 0.7 }),
      T('lowstrings', low, { vol: 0.35, send: 0.5 }),
      T('bells', seq('_/30 A5/2@.3 _/30 D5/2@.3'), { vol: 0.3, pan: -0.4, send: 0.8 }),
    ] };
  });

  // ---- DOWNS: solemn strings in 3/4, A minor ----
  theme('downs', function () {
    const ch = chords('Am/3 F/3 C/3 G/3 Am/3 F/3 Dm/3 E/3 Am/3 C/3 F/3 G/3 Am/3 Dm/3 E/3 Am/3', { oct: 3, vel: 0.65 });
    const mel = seq('E5/2 C5 | D5/2 A4 | C5/2 E5 | D5/3 | E5/2 C5 | A4/2 C5 | D5/2 F5 | E5/3 | A5/2 G5 | E5/2 C5 | F5/2 E5 | D5/2 B4 | C5/2 A4 | F5/2 D5 | B4/2 G#4 | A4/3', { vel: 0.75 });
    return { gain: 1.5, tempo: 72, bpb: 3, bars: 16, loop: true, tracks: [
      T('strings', mel, { vol: 0.7, pan: 0.1, send: 0.55 }),
      T('strings', ch, { vol: 0.45, pan: -0.2, send: 0.55 }),
      T('lowstrings', roots(ch, -1, { vel: 0.6 }), { vol: 0.5, send: 0.4 }),
      T('choir', ch.filter(function (c) { return c.t >= 24; }), { vol: 0.3, send: 0.7 }),
      T('timpani', seq('_/24 A2/1@.5 _/11 D2/1@.45 _/5 E2/1@.55 _/5'), { vol: 0.5, send: 0.5 }),
    ] };
  });

  // ---- LAKE: tranquil harp arpeggios, C major sevenths ----
  theme('lake', function () {
    const ch = chords('Cmaj7/4 Am7/4 Fmaj7/4 G/4 Em7/4 Am7/4 Dm7/4 G/4 Cmaj7/4 Em7/4 Fmaj7/4 G/4 Am7/4 Fmaj7/4 Dm7/4 G/4', { oct: 3, vel: 0.55 });
    const harp = arp(ch, [0, 1, 2, 3, 4, 3, 2, 1], 0.5, { vel: 0.55, gate: 2 });
    const fl = seq('_/4 | E5/2 G5/2 | A5/3 G5 | E5/2 D5/2 | C5/4 | _/2 E5 G5 | B5/2 A5 G5 | E5/3 D5 | E5/4 | G5/2 E5/2 | C5/2 D5/2 | E5/4 | C5/2 A4/2 | F5/2 E5/2 | D5/3 B4 | C5/4', { vel: 0.5 });
    return { gain: 1.5, tempo: 80, bpb: 4, bars: 16, loop: true, tracks: [
      T('harp', harp, { vol: 0.6, pan: -0.2, send: 0.5 }),
      T('pad', ch, { vol: 0.4, send: 0.6 }),
      T('flute', fl, { vol: 0.45, pan: 0.25, send: 0.6 }),
      T('pizz', roots(ch, -1, { vel: 0.55 }), { vol: 0.45, send: 0.3 }),
      T('bells', seq('_/30 G6/2@.3 _/30 E6/2@.3'), { vol: 0.3, pan: 0.4, send: 0.8 }),
    ] };
  });

  // ---- ELVEN: ethereal choir pads with high bells and slow harp, E major ----
  theme('elven', function () {
    const ch = chords('E/4 C#m/4 A/4 B/4 E/4 G#m/4 A/4 Bsus4/4 C#m/4 A/4 E/4 B/4 A/4 E/4 Bsus4/4 E/4', { oct: 3, vel: 0.6 });
    const bells = seq('_/2 B5 G#5 | _/4 | E5/2 F#5 G#5 | B5/4 | _/4 | G#5/2 B5 C#6 | E6/4 | D#6/2 B5/2 | C#6/2 E6 D#6 | B5/4 | _/4 | G#5 F#5 E5 F#5 | E5/4 | _/4 | F#5/2 G#5/2 | E5/4', { vel: 0.55 });
    const harp = arp(ch, [0, 2, 1, 3], 1, { vel: 0.4, gate: 3 });
    const fl = seq('_/32 E5/4 | G#5/2 F#5/2 | E5/4 | _/4 | C#5/2 E5/2 | F#5/4 | G#5/2 F#5/2 | E5/4', { vel: 0.4 });
    return { gain: 1.5, tempo: 58, bpb: 4, bars: 16, loop: true, tracks: [
      T('choir', ch, { vol: 0.6, send: 0.75 }),
      T('bells', bells, { vol: 0.45, pan: 0.3, send: 0.8 }),
      T('harp', harp, { vol: 0.4, pan: -0.35, send: 0.6 }),
      T('flute', fl, { vol: 0.35, pan: 0.1, send: 0.7 }),
      T('lowstrings', roots(ch, -1, { vel: 0.45 }), { vol: 0.35, send: 0.5 }),
    ] };
  });

  // ---- DWARVEN: low brass & drums, C minor pentatonic riff, anvils ----
  theme('dwarven', function () {
    const riff = 'C4/.5 C4/.5 Eb4 F4 G4 | Bb4/1.5 G4/.5 F4/2 | Eb4/.5 Eb4/.5 F4 G4 Bb4 | C5/2 G4/2 | C4/.5 C4/.5 Eb4 F4 G4 | Bb4/1.5 C5/.5 Bb4/2 | G4/.5 F4/.5 Eb4 F4 G4 | C4/4 | ' +
      'G4 G4 Bb4 C5 | Eb5/2 C5/2 | Bb4 G4 F4 G4 | Eb4/4 | F4/.5 F4/.5 G4 Bb4 C5 | Eb5/1.5 C5/.5 Bb4/2 | G4 F4 Eb4 F4 | C4/4';
    const ch = chords('C5/4 C5/4 Eb5/4 Bb5/4 C5/4 C5/4 Ab5/4 G5/4 C5/4 Eb5/4 Bb5/4 Ab5/4 F5/4 Eb5/4 G5/4 C5/4', { oct: 2, vel: 0.6 });
    const horn = seq(riff, { vel: 0.85 });
    return { gain: 0.9, tempo: 100, bpb: 4, bars: 16, loop: true, tracks: [
      T('horn', horn, { vol: 0.7, pan: 0.1, send: 0.35 }),
      T('brass', concat(seq('_/32'), seq(riff.split(' | ').slice(8).join(' | '), { vel: 0.6, tr: -12 })), { vol: 0.45, pan: -0.2, send: 0.3 }),
      T('lowstrings', seq(riff, { vel: 0.7, tr: -24 }), { vol: 0.55, gate: 0.8, send: 0.2 }),
      T('lowstrings', ch, { vol: 0.3, send: 0.4 }),
      T('taiko', rep(drums('X...x.x.', 0.5), 16), { vol: 0.75, send: 0.35 }),
      T('kick', rep(drums('x...x...', 0.5), 16), { vol: 0.5 }),
      T('snare', rep(drums('..x...x.', 0.5), 16), { vol: 0.35, pan: 0.2 }),
      T('anvil', seq('_/14 G5/.5@.8 G5/.5@.6 _/1 _/14 G5/.5@.8 G5/.5@.6 _/1 _/14 C6/.5@.8 C6/.5@.6 _/1 _/13 G5/.5@.9 G5/.5@.7 G5/.5@.6 G5/.5@.8 _/1'), { vol: 0.5, pan: 0.45, send: 0.5 }),
    ] };
  });

  // ---- MOUNTAIN: wide cold pads, long horn tones, wind ----
  theme('mountain', function () {
    const ch = chords('Bm/8 G/8 D/8 A/8 Bm/8 Em/8 G/4 A/4 Bm/8', { oct: 3, vel: 0.6 });
    const horn = seq('_/8 | B4/6 D5/2 | F#5/8 | E5/4 D5/4 | B4/8 | _/4 F#4/4 | G4/4 A4/4 | B4/8', { vel: 0.65 });
    return { gain: 1.2, tempo: 56, bpb: 4, bars: 16, loop: true, tracks: [
      T('pad', ch, { vol: 0.6, send: 0.7 }),
      T('pad', ch.map(function (c) { return { t: c.t, n: c.n.map(function (n) { return n + 12; }), d: c.d, v: 0.4 }; }), { vol: 0.35, pan: 0.3, send: 0.8 }),
      T('horn', horn, { vol: 0.6, pan: -0.15, send: 0.7 }),
      T('windpad', seq('B3/64@.9'), { vol: 0.35, send: 0.6 }),
      T('lowstrings', roots(ch, -1, { vel: 0.55 }), { vol: 0.45, send: 0.5 }),
      T('bells', seq('_/6 F#6/2@.35 _/22 D6/2@.3 _/30 B5/2@.35'), { vol: 0.35, pan: 0.4, send: 0.8 }),
      T('taiko', seq('_/24 B1/1@.45 _/7 _/24 B1/1@.5 _/3 B1/1@.35 _/3'), { vol: 0.45, send: 0.6 }),
    ] };
  });

  // ---- DARK: dissonant drones, low pulses, semitone clusters ----
  theme('dark', function () {
    return { gain: 1.2, tempo: 50, bpb: 4, bars: 16, loop: true, tracks: [
      T('drone', seq('C#2/64@.8'), { vol: 0.6, send: 0.5 }),
      T('drone', seq('_/12 G2/12@.5 _/8 C2/16@.5 _/8 D2/8@.5'), { vol: 0.4, pan: 0.3, send: 0.6 }),
      T('kick', rep(drums('X.......o.......', 0.25), 16), { vol: 0.7, send: 0.4 }),
      T('taiko', seq('_/30 C2/1@.6 _/1 _/30 C2/1@.6 C2/1@.4'), { vol: 0.5, send: 0.5 }),
      T('strings', seq('C#4+D4/8@.5 _/8 G4+G#4/8@.45 _/8 C#4+D4+G4/8@.5 _/8 F4+F#4/8@.45 _/8'), { vol: 0.35, pan: -0.25, send: 0.75 }),
      T('choir', seq('C#3+G3/16@.45 _/16 C#3+G#3/16@.45 _/16'), { vol: 0.4, send: 0.8 }),
      T('bells', seq('_/14 F#5/2@.4 _/30 C6/2@.35 _/14 G5/2@.4'), { vol: 0.35, pan: 0.4, send: 0.85 }),
      T('windpad', seq('C#3/64@.6'), { vol: 0.25, send: 0.5 }),
    ] };
  });

  // ---- ARCTIC: glassy bells, thin pads, wind ----
  theme('arctic', function () {
    const ch = chords('Am/8 Fmaj7/8 Dm/8 Em/8 Am/8 C/8 Fmaj7/8 Em/8', { oct: 3, vel: 0.5 });
    const glass = seq('E5/2 A5/2 | C6/3 B5 | E5/2 G5/2 | A5/4 | _/4 | D6/2 C6/2 | B5/2 E5/2 | A5/4 | _/2 E6/2 | D6/2 B5/2 | C6/3 A5 | E5/4 | _/4 | F5/2 E5/2 | D5/2 B4/2 | A4/4', { vel: 0.6 });
    return { gain: 1.5, tempo: 62, bpb: 4, bars: 16, loop: true, tracks: [
      T('glass', glass, { vol: 0.6, pan: 0.2, send: 0.8 }),
      T('pad', ch, { vol: 0.4, send: 0.7 }),
      T('windpad', seq('A3/64@.9'), { vol: 0.4, send: 0.5 }),
      T('harp', arp(ch, [0, 2, 1, 3], 1, { vel: 0.35, gate: 2.5 }), { vol: 0.35, pan: -0.35, send: 0.7 }),
      T('lowstrings', roots(ch, -1, { vel: 0.4 }), { vol: 0.3, send: 0.5 }),
      T('glass', seq('_/28 E7/1@.25 _/3 _/28 A6/1@.25 _/3'), { vol: 0.3, pan: -0.4, send: 0.9 }),
    ] };
  });

  // ---- ISLAND: gentle lilting 6/8, F major, rolling harp ----
  theme('island', function () {
    const ch = chords('F/6 Bb/6 F/6 C/6 Dm/6 Bb/6 C/6 F/6 F/6 Am/6 Bb/6 C/6 Dm/6 Bb/6 C7/6 F/6', { oct: 3, vel: 0.55 });
    const mel = seq('A4/2 C5 F5/3 | D5/2 C5 A4/3 | C5 D5 C5 A4/2 G4 | G4/6 | F4/2 A4 D5/3 | C5/2 D5 F5/3 | E5 D5 C5 G4/3 | F4/6 | ' +
      'A4 C5 F5 A5/3 | G5/2 E5 C5/3 | D5 F5 D5 C5/2 Bb4 | G4/6 | A4/2 D5 F5/3 | D5/2 C5 Bb4/3 | G4 A4 Bb4 C5/3 | F4/6', { vel: 0.6 });
    return { gain: 1.5, tempo: 192, bpb: 6, bars: 16, loop: true, tracks: [
      T('harp', arp(ch, [0, 1, 2, 3, 2, 1], 1, { vel: 0.5, gate: 2 }), { vol: 0.55, pan: -0.25, send: 0.5 }),
      T('flute', mel, { vol: 0.55, pan: 0.2, send: 0.5 }),
      T('pad', ch, { vol: 0.35, send: 0.6 }),
      T('pizz', pick(ch, [0, 3], [0, 2], -1, 2.5, 0.6), { vol: 0.45, send: 0.3 }),
      T('shaker', rep(drums('x..o..', 1), 16), { vol: 0.25, pan: 0.4 }),
      T('lute', concat(seq('_/48'), strum(ch.filter(function (c) { return c.t >= 48; }).map(function (c) { return { t: c.t - 48, n: c.n, d: c.d, v: c.v }; }), [0, 3], 2, 0.35, 1)), { vol: 0.35, pan: 0.35, send: 0.4 }),
    ] };
  });

  // ---- COMBAT: driving percussion, E minor riff, 140 bpm ----
  theme('combat', function () {
    const R1 = 'E2/.5 E2/.5 G2/.5 E2/.5 Bb2/.5 A2/.5 G2/.5 E2/.5 | E2/.5 E2/.5 G2/.5 E2/.5 D3/.5 C3/.5 B2/.5 G2/.5';
    const R2 = 'E2/.5 E2/.5 G2/.5 E2/.5 Bb2/.5 A2/.5 G2/.5 E2/.5 | C3/.5 C3/.5 B2/.5 B2/.5 A2/.5 A2/.5 G2/.5 F#2/.5';
    const R3 = 'E2/.5 E2/.5 G2/.5 A2/.5 Bb2/.5 B2/.5 D3/.5 E3/.5 | E3 D3 B2 G2';
    const riffA = seq(R1 + ' | ' + R2 + ' | ' + R1 + ' | ' + R2, { vel: 0.85 });
    const riff = concat(riffA, transpose(seq(R1 + ' | ' + R2, { vel: 0.9 }), 5), seq(R1 + ' | ' + R3, { vel: 0.95 }));
    const ch = chords('Em/16 Em/8 C/4 D/4 Am/16 Em/8 C/2 D/2 Em/4', { oct: 3, vel: 0.5 });
    const stabs = seq('_/12 _/3 E4+B4/.5 E4+B4/.5 | _/12 _/2 G4+D5/.5 _/.5 E4+B4/1 | _/12 _/3 A4+E5/.5 A4+E5/.5 | _/12 E4+B4/.5 _/.5 E4+B4/.5 _/.5 E4+B4/2', { vel: 0.9 });
    const horn = seq('_/32 E4/2 G4 A4 | B4/3 A4 | G4/2 E4 G4 | A4/4 | E5/2 D5 B4 | C5/2 B4 A4 | G4 A4 B4 D5 | E5/4', { vel: 0.8 });
    return { gain: 0.85, tempo: 140, bpb: 4, bars: 16, loop: true, fadeIn: 0.8, tracks: [
      T('lowstrings', riff, { vol: 0.65, gate: 0.7, send: 0.15 }),
      T('bass', transpose(riff, -12), { vol: 0.5, gate: 0.6 }),
      T('strings', ch, { vol: 0.3, send: 0.4 }),
      T('brass', stabs, { vol: 0.55, pan: 0.15, send: 0.3 }),
      T('horn', horn, { vol: 0.55, pan: -0.15, send: 0.35 }),
      T('kick', concat(rep(drums('x..x..x.', 0.5), 8), rep(drums('x.x...x.', 0.5), 4), rep(drums('x..x..x.', 0.5), 3), drums('x.x.x.xx', 0.5)), { vol: 0.75 }),
      T('snare', concat(rep(drums('..x...x.', 0.5), 15), drums('..x...xx', 0.5)), { vol: 0.5, pan: 0.15 }),
      T('hat', rep(drums('xoxoxoxo', 0.5), 16), { vol: 0.3, pan: 0.3 }),
      T('taiko', seq('C2/1 _/15 C2/1 _/15 C2/1 _/15 C2/1 _/7 C2/.5 C2/.5 _/7'), { vol: 0.6, send: 0.3 }),
    ] };
  });

  // ---- BOSS: intense, brass hits, D minor with Neapolitan, 150 bpm ----
  theme('boss', function () {
    const R1 = 'D2/.5 D2/.5 D2/.5 F2/.5 D2/.5 Eb2/.5 D2/.5 C2/.5', R2 = 'D2/.5 D2/.5 D2/.5 A2/.5 Ab2/.5 G2/.5 F2/.5 Eb2/.5';
    const riff = seq([R1, R2, R1, R2, R1, R2, R1, 'D2/.5 D2/.5 F2/.5 G2/.5 Ab2/.5 A2/.5 C3/.5 D3/.5'].join(' | ') + ' | ' + [R1, R2, R1, R2, R1, R2, R1, 'Eb2/.5 Eb2/.5 D2/.5 D2/.5 A2/.5 A2/.5 D2/1'].join(' | '), { vel: 0.9 });
    const ch = chords('Dm/8 Eb/8 Dm/8 Bb/4 A/4 Dm/8 Gm/8 Eb/4 A/4 Dm/8', { oct: 3, vel: 0.55 });
    const hits = seq('_/4 | _/2 D4+F4+A4/.5 _/.5 D4+F4+A4/1 | _/4 | Eb4+G4+Bb4/1 _/1 D4+F4+A4/2 | _/4 | _/2 D4+F4+A4/.5 _/.5 D4+F4+A4/1 | _/4 | C4+Eb4+G4/.5 _/.5 D4+F4+A4/.5 _/.5 A3+D4+F4/2 | ' +
      '_/4 | _/2 F4+A4+D5/.5 _/.5 F4+A4+D5/1 | _/4 | G4+Bb4+D5/1 _/1 F4+A4+D5/2 | _/4 | Eb4+G4+Bb4/.5 _/.5 Eb4+G4+Bb4/.5 _/.5 D4+F4+A4/2 | _/4 | A3+C#4+E4/.5 _/.5 A3+C#4+E4/.5 _/.5 D4+F4+A4/2', { vel: 1 });
    const horn = seq('_/32 A4/2 F4 D4 | Eb5/3 D5 | C5/2 A4 F4 | A4/4 | D5/2 C5 Bb4 | A4/2 G4 F4 | E4/2 F4/2 | D4/4', { vel: 0.85 });
    return { gain: 0.7, tempo: 150, bpb: 4, bars: 16, loop: true, fadeIn: 0.6, tracks: [
      T('lowstrings', riff, { vol: 0.65, gate: 0.7, send: 0.15 }),
      T('bass', transpose(riff, -12), { vol: 0.5, gate: 0.6 }),
      T('choir', ch, { vol: 0.45, send: 0.6 }),
      T('brass', hits, { vol: 0.65, pan: 0.1, send: 0.35 }),
      T('horn', horn, { vol: 0.55, pan: -0.2, send: 0.4 }),
      T('taiko', rep(drums('X.x.X.x.', 0.5), 16), { vol: 0.8, send: 0.3 }),
      T('kick', rep(drums('x.x.x.x.', 0.5), 16), { vol: 0.55 }),
      T('snare', concat(rep(drums('..X...X.', 0.5), 15), drums('..X.XXXX', 0.5)), { vol: 0.55, pan: 0.15 }),
      T('cymbal', seq('C4/1@.8 _/31 C4/1@.8 _/31'), { vol: 0.4, send: 0.5 }),
      T('bells', seq('_/30 Ab5/1@.5 D6/1@.5 _/30 Eb6/1@.5 D6/1@.5'), { vol: 0.35, pan: 0.4, send: 0.7 }),
    ] };
  });

  // ---- VICTORY: 8-bar fanfare (no loop) ----
  theme('victory', function () {
    const fan = 'G4/.5 G4/.5 G4/.5 C5/2.5 | E5/.5 D5/.5 C5/.5 G4/2.5 | A4/.5 B4/.5 C5/.5 D5/1.5 E5 | G5/4 | E5/.5 F5/.5 G5/.5 E5/1.5 C5 | D5/.5 E5/.5 F5/.5 D5/1.5 B4 | C5/2 G4/2 | C5/4';
    const ch = chords('C/4 C/4 F/2 G/2 C/4 Am/4 F/2 G/2 C/2 G/2 C/4', { oct: 3, vel: 0.7 });
    return { gain: 0.7, tempo: 120, bpb: 4, bars: 8, loop: false, fadeIn: 0.05, tracks: [
      T('horn', seq(fan, { vel: 0.95 }), { vol: 0.75, pan: 0.1, send: 0.45 }),
      T('brass', seq('_/12 C5+E5+G5/4@.8 _/8 E4+G4+C5/2@.7 G4+B4+D5/2@.7 C5+E5+G5/4@1'), { vol: 0.5, pan: -0.15, send: 0.4 }),
      T('strings', ch, { vol: 0.45, send: 0.5 }),
      T('strings', seq(fan, { vel: 0.5, tr: 12 }), { vol: 0.3, pan: 0.3, send: 0.5 }),
      T('lowstrings', roots(ch, -1, { vel: 0.7 }), { vol: 0.5, send: 0.3 }),
      T('timpani', seq('C2/1@.9 _/1 G2/.5@.6 G2/.5@.6 C2/1@.9 _/1 G2/.5@.6 G2/.5@.6 F2/1@.8 _/1 G2/1@.8 _/1 C2/1@1 _/3 C2/1@.9 _/1 G2/.5@.6 G2/.5@.6 A2/1@.8 _/1 A2/.5@.6 A2/.5@.6 F2/1@.8 _/1 G2/1@.8 _/1 C2/.5@.6 C2/.5@.7 C2/.5@.8 C2/.5@.9 C2/2@1'), { vol: 0.6, send: 0.4 }),
      T('snare', concat(rep(drums('x.x.x.x.', 0.5), 7), drums('xxxxXXXX', 0.5)), { vol: 0.4, pan: 0.2 }),
      T('cymbal', seq('C4/1@.8 _/11 C4/1@.9 _/15 C4/1@1 _/3'), { vol: 0.45, send: 0.5 }),
    ] };
  });

  // ---- DEATH: short sad lament (no loop) ----
  theme('death', function () {
    const ch = chords('Dm/4 Dm/4 Bb/4 Gm/4 Dm/4 A/4 Dm/4 Dm/4', { oct: 3, vel: 0.5 });
    return { gain: 0.9, tempo: 60, bpb: 4, bars: 8, loop: false, fadeIn: 0.5, tracks: [
      T('flute', seq('A4/2 F4 E4 | D4/3 _ | F4/2 G4 A4 | A4/2 G4/2 | F4/2 E4 D4 | C4/2 D4 E4 | D4/4 | D4/4', { vel: 0.6 }), { vol: 0.6, pan: 0.1, send: 0.7 }),
      T('strings', ch, { vol: 0.45, send: 0.7 }),
      T('lowstrings', roots(ch, -1, { vel: 0.5 }), { vol: 0.4, send: 0.5 }),
      T('choir', seq('_/16 D3+F3+A3/8@.4 D3+F3+A3/8@.35'), { vol: 0.35, send: 0.8 }),
      T('bells', seq('_/28 D5/2@.3 _/2'), { vol: 0.3, pan: -0.3, send: 0.9 }),
    ] };
  });

  // ---- SAILING: rolling 3/4 accordion waltz, C major ----
  theme('sailing', function () {
    const ch = chords('C/3 C/3 F/3 C/3 Am/3 F/3 G/3 C/3 C/3 Am/3 G/3 G/3 C/3 F/3 G/3 C/3', { oct: 3, vel: 0.6 });
    const mel = seq('E4 G4 C5 | E5/2 D5 | C5 D5 E5 | G4/3 | A4 C5 E5 | D5/2 C5 | B4 A4 B4 | C5/3 | E5 G5 E5 | C5/2 E5 | D5 F5 D5 | B4/3 | C5 E5 G5 | A5/2 G5 | F5 E5 D5 | C5/3', { vel: 0.8 });
    return { gain: 1.1, tempo: 120, bpb: 3, bars: 16, loop: true, tracks: [
      T('accordion', mel, { vol: 0.7, pan: 0.1, send: 0.35 }),
      T('accordion', strum(ch, [1, 2], 0.8, 0.5, 0), { vol: 0.4, pan: -0.25, send: 0.3 }),
      T('pizz', roots(ch, -1, { vel: 0.8 }), { vol: 0.55, send: 0.2 }),
      T('flute', seq('_/24 E5/3 C5/3 D5/3 G5/3 E5/3 A5/3 G5/3 E5/3', { vel: 0.45 }), { vol: 0.4, pan: 0.35, send: 0.5 }),
      T('pad', ch, { vol: 0.28, send: 0.6 }),
      T('tamb', rep(drums('x..', 1), 16), { vol: 0.25, pan: 0.4 }),
    ] };
  });

  // ---- TAVERN: jaunty lute jig in 6/8, D major ----
  theme('tavern', function () {
    const ch = chords('D/6 G/6 A/6 D/6 D/6 G/6 A/6 D/6 D/6 G/6 A/6 D/6 G/6 D/6 A/6 D/6', { oct: 3, vel: 0.6 });
    const jig = 'D4 F#4 A4 D5 A4 F#4 | G4 B4 D5 G5 D5 B4 | A4 C#5 E5 A5 E5 C#5 | D5/2 A4 F#4/2 D4 | D4 F#4 A4 D5 A4 F#4 | G4 B4 D5 G5 D5 B4 | E5 D5 C#5 B4 A4 G4 | F#4/3 D4/3 | ' +
      'A5 F#5 D5 A5 F#5 D5 | B5 G5 D5 B5 G5 D5 | A5 E5 C#5 A5 E5 C#5 | D5/2 E5 F#5/2 D5 | G5 F#5 E5 D5 C#5 B4 | A4 B4 C#5 D5 E5 F#5 | E5 C#5 A4 G4 F#4 E4 | D4/6';
    return { gain: 1.4, tempo: 280, bpb: 6, bars: 16, loop: true, tracks: [
      T('lute', seq(jig, { vel: 0.9 }), { vol: 0.75, pan: -0.1, send: 0.25 }),
      T('flute', concat(seq('_/48'), seq(jig.split(' | ').slice(8).join(' | '), { vel: 0.55 })), { vol: 0.4, pan: 0.3, send: 0.35 }),
      T('lute', strum(ch, [0, 3], 2, 0.4, 0), { vol: 0.35, pan: 0.35, send: 0.25 }),
      T('pizz', pick(ch, [0, 3], [0, 2], -1, 2.5, 0.8), { vol: 0.55 }),
      T('tamb', rep(drums('x..x..', 1), 16), { vol: 0.3, pan: 0.45 }),
      T('handdrum', rep(drums('x.ox.o', 1), 16), { vol: 0.45, pan: -0.3 }),
    ] };
  });

  // ================================================================================================
  // Event hooks & exports
  // ================================================================================================
  A.names = Object.keys(SFX);
  A.instruments = Object.keys(INST);
  A.hasTheme = function (id) { return !!THEMES[id]; };
  if (typeof G.on === 'function') {
    G.on('weatherChanged', function (kind) { A.setAmbientRain(kind === 'rain' || kind === 'storm'); });
    G.on('dayPhase', function (phase) { if (amb.biome) A.ambient(amb.biome, phase); });
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', function () { if (ctx && document.visibilityState === 'visible' && ctx.state === 'suspended') ctx.resume().catch(function () {}); });
  }
})();
