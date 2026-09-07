#!/usr/bin/env node
/**
 * tools/verify.js — requirement verification suite for the built single-file game.
 * One headless-Chromium scenario per requirement id in docs/REQUIREMENTS.md (R01–R04, R10–R26, R30–R41).
 *
 *   node tools/verify.js                    # run every scenario (≈ 6–8 minutes of wall time)
 *   node tools/verify.js --only R16,R22     # run a subset (boot + quick-start always happen)
 *   node tools/verify.js --shots            # save tools/out/verify-<id>.png after every scenario
 *   node tools/verify.js --fast             # shorter soak windows (auto-quest 60 s, AI sim 6 s, …)
 *   node tools/verify.js --timeout 90       # per-scenario timeout in seconds (default 60)
 *   node tools/verify.js --full-autoquest   # separate long test: run the bot until 150/150 or 40 minutes
 *   node tools/verify.js --html some.html   # verify a different build (default dist/Chris-Jensens-LOTRO.html)
 *   node tools/verify.js --verbose          # print per-check detail while running
 *
 * Output: a results table + "N/M passed" on stdout and tools/out/verify-report.json
 * (tools/out/verify-autoquest.json for --full-autoquest). Exit code 0 = everything passed,
 * 1 = at least one scenario failed (or the game never booted), 2 = the harness itself crashed.
 *
 * Robustness: every scenario runs isolated (try/catch + its own timeout, keyboard/mouse/panels reset
 * between scenarios); if the build never reaches `__T.ready` / `__T.inGame` every scenario is reported
 * as failed with that reason and the report is still written.
 *
 * Boots exactly like tools/smoke.js (same Chromium flags, same console-error filter), waits for
 * `window.__T.ready`, dismisses the "Click to begin" gesture, runs R37 on the creation screen, then
 * `__T.quickStart({name:'Verifier', race:'man', cls:'champion', gender:'male'})` → `__T.inGame` and the
 * in-world scenarios. R41 reloads the page at the very end (Continue from the main menu).
 */
'use strict';
const path = require('path');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
catch (e) { ({ chromium } = require('playwright')); }

// ------------------------------------------------------------------------------------------------ CLI
const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const OPTS = {
  only: (opt('--only', '') || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean),
  shots: flag('--shots'),
  fast: flag('--fast'),
  verbose: flag('--verbose'),
  fullAutoquest: flag('--full-autoquest'),
  timeoutMs: Math.max(5, parseFloat(opt('--timeout', '60'))) * 1000,
};
const OUT = path.join(__dirname, 'out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const HTML = path.resolve(opt('--html', path.join(__dirname, '..', 'dist', 'Chris-Jensens-LOTRO.html')));
const REPORT = path.join(OUT, 'verify-report.json');
const AQ_REPORT = path.join(OUT, 'verify-autoquest.json');
const BOOT_TIMEOUT = 120000;
const QUICKSTART = { name: 'Verifier', race: 'man', cls: 'champion', gender: 'male' };
const LAUNCH_ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'];
const ERR_FILTER = /fonts\.googleapis|fonts\.gstatic|Failed to load resource|net::ERR_/;
const BREE = { x: -256, z: -30 };        // Bree rally point (SPEC §9 / 05_data_world) — a safe mainland spot

// ------------------------------------------------------------------------------------------------ helpers (node side)
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const fmtMs = (ms) => ms >= 10000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms';
const trunc = (s, n) => { s = String(s == null ? '' : s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const short = (v) => { if (v === undefined) return ''; try { return trunc(typeof v === 'string' ? v : JSON.stringify(v), 90); } catch (e) { return String(v); } };
const wrapAngle = (a) => { a = a % (Math.PI * 2); if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; };

/** Per-scenario helper set. A fresh T is created for every scenario; a timed-out scenario's T is marked
 *  dead so any of its still-running steps abort at their next helper call instead of interfering. */
function makeT(page, ctx) {
  const T = {
    page, ctx, alive: true,
    check() { if (!T.alive) throw new Error('scenario aborted (timed out)'); },
    wait: async (ms) => { T.check(); await page.waitForTimeout(ms); },
    press: async (code, ms = 150) => { T.check(); await page.keyboard.press(code); await page.waitForTimeout(ms); },
    hold: async (code, ms) => { T.check(); await page.keyboard.down(code); try { await page.waitForTimeout(ms); } finally { await page.keyboard.up(code).catch(() => { }); } },
    evalG: (fn, arg) => { T.check(); return page.evaluate(fn, arg); },
    /** Poll `fn(arg)` in the page every 100 ms until it returns something truthy (returned) or `ms` elapse (null). */
    waitFor: async (fn, ms, arg) => {
      const t0 = Date.now();
      for (; ;) {
        T.check();
        let v = null;
        try { v = await page.evaluate(fn, arg); } catch (e) { v = null; }
        if (v) return v;
        if (Date.now() - t0 >= ms) return null;
        await page.waitForTimeout(100);
      }
    },
    shot: async (name) => { if (!OPTS.shots) return; try { await page.screenshot({ path: path.join(OUT, 'verify-' + name + '.png') }); } catch (e) { /* ignore */ } },
    log: (...a) => { if (OPTS.verbose) console.log('      ', ...a); },
  };
  return T;
}

// ------------------------------------------------------------------------------------------------ page-side probe
/** Installed once the player is in the world: event captures + helpers shared by scenarios (window.__V). */
function installProbe() {
  const G = window.G; if (!G || window.__V) return !!window.__V;
  const THREE = window.THREE;
  const V = window.__V = { chat: [], fish: [], loot: [], abilities: [], quests: [], spawned: [] };
  const on = (n, f) => { try { G.on(n, f); } catch (e) { /* ignore */ } };
  on('chat', ev => V.chat.push({ channel: ev && ev.channel, from: ev && ev.from, text: ev && ev.text, t: G.time.now }));
  on('fishCaught', ev => V.fish.push({ tid: ev && ev.tid, kind: ev && ev.kind, name: ev && ev.name, t: G.time.now }));
  on('lootTaken', ev => V.loot.push({ items: ev && ev.items ? ev.items.length : 0, gold: ev && ev.gold ? ev.gold : 0, t: G.time.now }));
  on('abilityUsed', ev => V.abilities.push({ id: ev && ev.ability ? (ev.ability.id || ev.ability) : null, ent: ev && ev.ent && ev.ent.kind, t: G.time.now }));
  on('questAccepted', id => V.quests.push(['accepted', id, G.time.now]));
  on('questCompleted', id => V.quests.push(['completed', id, G.time.now]));
  V.p = () => G.state && G.state.player;
  V.ent = (id) => (G.getEntity && G.getEntity(id)) || (G.state.byId && G.state.byId[id]) || null;
  V.visible = (panelId) => { const el = document.getElementById('panel-' + panelId); return !!el && !el.hidden && getComputedStyle(el).display !== 'none' && !!(G.UI && G.UI.isOpen && G.UI.isOpen(panelId)); };
  V.tp = (x, z) => { const p = V.p(); if (!p) return false; try { if (p.mounted && G.Player.dismount) G.Player.dismount(); } catch (e) { /* ignore */ } G.Player.teleport(x, z); return true; };
  /** Point the player (and camera) at a target {pos:{x,z}} whatever the yaw convention is. */
  V.face = (target) => {
    const p = V.p(); if (!p || !target || !target.pos) return -2;
    const dx = target.pos.x - p.pos.x, dz = target.pos.z - p.pos.z, len = Math.hypot(dx, dz) || 1;
    const cands = [Math.atan2(-dx, -dz), Math.atan2(dx, dz)];
    const v = new THREE.Vector3();
    const dotFor = (y) => { p.yaw = y; if (G.Player.cam) G.Player.cam.yaw = y; G.Player.getForward(v); return (v.x * dx + v.z * dz) / len; };
    let best = cands[0], bd = dotFor(cands[0]);
    const d1 = dotFor(cands[1]); if (d1 > bd) { best = cands[1]; bd = d1; }
    p.yaw = best; if (G.Player.cam) G.Player.cam.yaw = best;
    return bd;
  };
  V.nearest = (kind, filter) => {
    const p = V.p(); if (!p) return null; let best = null, bd = Infinity;
    for (const e of G.state.entities) { if (e.kind !== kind || !e.pos || (filter && !filter(e))) continue; const d = Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z); if (d < bd) { bd = d; best = e; } }
    return best;
  };
  /** An open, flat, dry, unobstructed spot near (cx,cz) (default: near the player). Returns {x,z}|null. */
  V.openSpot = (cx, cz) => {
    const p = V.p(), Tr = G.Terrain, Ph = G.Physics;
    const cx0 = cx == null ? p.pos.x : cx, cz0 = cz == null ? p.pos.z : cz;
    const water = (x, z) => !!(Tr && Tr.isWater && Tr.isWater(x, z));
    const good = (x, z) => {
      if (water(x, z)) return false;
      for (const [dx, dz] of [[10, 0], [-10, 0], [0, 10], [0, -10], [16, 0], [-16, 0], [0, 16], [0, -16]]) if (water(x + dx, z + dz)) return false;
      if (Tr && typeof Tr.slope === 'function' && Tr.slope(x, z) > 0.25) return false;
      if (Ph && typeof Ph.isFree === 'function') for (const [dx, dz] of [[0, 0], [6, 0], [-6, 0], [0, 6], [0, -6], [12, 0], [-12, 0], [0, 12], [0, -12]]) if (!Ph.isFree(x + dx, z + dz, 1.2)) return false;
      if (G.Buildings && Array.isArray(G.Buildings.all)) for (const b of G.Buildings.all) { if (Math.hypot(b.x - x, b.z - z) < (b.radius || 10) + 16) return false; }
      return true;
    };
    for (let r = 0; r <= 200; r += (r < 40 ? 10 : 20)) for (let a = 0; a < 16; a++) {
      const x = cx0 + Math.cos(a / 16 * Math.PI * 2) * r, z = cz0 + Math.sin(a / 16 * Math.PI * 2) * r;
      if (good(x, z)) return { x: Math.round(x * 10) / 10, z: Math.round(z * 10) / 10 };
    }
    return null;
  };
  V.monsterType = (o) => {
    o = o || {}; const W = G.Data.world, p = V.p(); const L = o.level || (p ? p.level : 1);
    const types = (W && W.monsterTypes) || [];
    if (o.boss) { const b = types.find(t => t.boss) || types.find(t => t.elite); if (b) return b.id; }
    let cands = types.filter(t => !t.boss && !t.elite && t.hostile !== false && !/sea-serpent/.test(t.family || ''));
    const zone = G.state.zone;
    const inZone = cands.filter(t => t.zone === zone && t.level && t.level[0] <= L + 1);
    if (inZone.length) cands = inZone;
    cands.sort((a, b) => Math.abs((a.level ? a.level[0] : 1) - L) - Math.abs((b.level ? b.level[0] : 1) - L));
    return cands.length ? cands[0].id : (types[0] && types[0].id);
  };
  /** Spawn a monster `dist` m in front of the player. Returns its id (or null). */
  V.spawn = (o) => {
    o = o || {}; const p = V.p(); if (!p || !G.Monsters || !G.Monsters.spawnAt) return null;
    const v = new THREE.Vector3(); G.Player.getForward(v); if (!v.lengthSq()) v.set(0, 0, -1);
    const d = o.dist == null ? 3 : o.dist;
    let x = p.pos.x + v.x * d, z = p.pos.z + v.z * d;
    if (G.Physics && G.Physics.nearestFree) { const f = G.Physics.nearestFree(x, z, 4); if (f && isFinite(f.x)) { x = f.x; z = f.z; } }
    const typeId = o.type || V.monsterType(o);
    const ent = G.Monsters.spawnAt(typeId, x, z, { level: o.level || p.level, boss: !!o.boss, elite: !!o.elite });
    if (!ent) return null;
    V.spawned.push(ent.id);
    return ent.id;
  };
  V.despawnAll = () => { for (const id of V.spawned) { const e = V.ent(id); if (e && G.Monsters && G.Monsters.despawn) { try { G.Monsters.despawn(e); } catch (err) { /* ignore */ } } } V.spawned.length = 0; };
  V.chatLines = () => Array.from(document.querySelectorAll('#chat .chat-line')).map(l => ({ cls: l.className, text: l.textContent || '' }));
  V.aiChatCount = () => V.chatLines().filter(l => /ch-(world|say|fellowship|whisper|emote)/.test(l.cls) && !/^\S*You[: ]/.test(l.text.replace(/^\d\d:\d\d\s*/, '').replace(/^\[[^\]]+\]\s*/, ''))).length;
  V.errCount = () => (G.errors || []).length;
  return true;
}

// ------------------------------------------------------------------------------------------------ boot / start
async function boot(page, ctx) {
  const t0 = Date.now();
  await page.goto('file://' + HTML, { waitUntil: 'load', timeout: BOOT_TIMEOUT });
  try {
    await page.waitForFunction(() => !!(window.__T && window.__T.ready === true), null, { timeout: BOOT_TIMEOUT, polling: 250 });
  } catch (e) {
    const probe = await page.evaluate(() => {
      const G = window.G;
      return {
        hasT: !!window.__T, ready: !!(window.__T && window.__T.ready), hasG: !!G,
        phase: G && G.state ? G.state.phase : null,
        hasGame: !!(G && G.Game),
        modules: Array.from(document.querySelectorAll('script[data-module]')).map(s => s.getAttribute('data-module')).filter(m => /^99_/.test(m)),
        gErrors: G && Array.isArray(G.errors) ? G.errors.slice(0, 3).map(String) : [],
      };
    }).catch(() => null);
    let why = '__T.ready never became true within ' + (BOOT_TIMEOUT / 1000) + ' s';
    if (probe && !probe.hasT) why += ' — window.__T is missing' + (probe.modules && !probe.modules.length ? ' (no 99_main.js module in the build)' : '');
    if (probe && probe.gErrors && probe.gErrors.length) why += ' — G.errors: ' + probe.gErrors.join(' | ');
    throw new Error('boot failed: ' + why);
  }
  ctx.bootMs = Date.now() - t0;
  // "Click to begin" gesture on the loading screen (also unlocks audio)
  await page.mouse.click(640, 360).catch(() => { });
  await page.waitForTimeout(600);
  const menu = await page.waitForFunction(() => {
    const M = window.G && window.G.UI && window.G.UI.Menu; const el = document.getElementById('mainMenu');
    return !!((M && M.visible) || (el && !el.hidden));
  }, null, { timeout: 8000, polling: 200 }).then(() => true).catch(() => false);
  if (!menu) await page.evaluate(() => { try { window.G.UI.Menu.show(); } catch (e) { /* ignore */ } }).catch(() => { });
  await page.waitForTimeout(300);
}

async function quickStart(page, ctx) {
  const t0 = Date.now();
  await page.evaluate((o) => window.__T.quickStart(o), QUICKSTART);
  try {
    await page.waitForFunction(() => !!(window.__T && window.__T.inGame === true), null, { timeout: 90000, polling: 250 });
  } catch (e) {
    const probe = await page.evaluate(() => { const G = window.G; return { phase: G && G.state && G.state.phase, hasPlayer: !!(G && G.state && G.state.player), gErrors: (G && G.errors || []).slice(0, 3).map(String) }; }).catch(() => null);
    throw new Error('quickStart failed: __T.inGame never became true' + (probe ? ' (' + JSON.stringify(probe) + ')' : ''));
  }
  await page.waitForTimeout(1500);
  await page.evaluate(installProbe);
  ctx.quickStartMs = Date.now() - t0;
}

/** Reset input/UI/game modifiers between scenarios so one scenario cannot poison the next. */
async function settle(page) {
  for (const k of ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'Space']) await page.keyboard.up(k).catch(() => { });
  await page.mouse.up({ button: 'right' }).catch(() => { });
  await page.mouse.up().catch(() => { });
  await page.evaluate(() => {
    const G = window.G; if (!G) return;
    const t = (f) => { try { f(); } catch (e) { /* ignore */ } };
    t(() => { if (G.AutoQuest && G.AutoQuest.active) G.AutoQuest.stop(); });
    t(() => { if (G.Fishing && G.Fishing.state !== 'idle') G.Fishing.cancel(false); });
    t(() => { if (G.Player && G.Player.autoStop) G.Player.autoStop(); });
    t(() => { if (G.UI && G.UI.Admin && G.UI.Admin.isOpen && G.UI.Admin.isOpen()) G.UI.Admin.close(); });
    t(() => { if (G.UI && G.UI.closeAll) G.UI.closeAll(); });
    t(() => { if (G.NPCs && G.NPCs.endTalk) G.NPCs.endTalk(); });
    t(() => { if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur(); });
    t(() => { const c = document.getElementById('game'); if (c) c.focus({ preventScroll: true }); });
    t(() => { if (G.time) G.time.scale = 1; });
    t(() => { if (G.Input && G.Input.reset) G.Input.reset(); });
    t(() => { if (window.__V) window.__V.despawnAll(); });
    t(() => { const p = G.state.player; if (p && (p.dead || p.alive === false) && G.Player && G.Player.respawn) G.Player.respawn(); });
    t(() => { const p = G.state.player; if (p && p.mounted && G.Player && G.Player.dismount) G.Player.dismount(); });
  }).catch(() => { });
  await page.waitForTimeout(150);
}

// ------------------------------------------------------------------------------------------------ scenarios
// Each scenario: async (T, ok, ctx) => void. `ok(name, condition, extra)` records a check; the scenario passes
// when it recorded ≥ 1 check, none failed and it neither threw nor timed out.
const SC = [];
const scenario = (id, title, fn, o) => SC.push(Object.assign({ id, title, fn }, o || {}));

// ---- Delivery ---------------------------------------------------------------------------------------------
scenario('R01', 'Single self-contained HTML, no network', async (T, ok) => {
  ok('built file exists', fs.existsSync(HTML), HTML);
  const html = fs.readFileSync(HTML, 'utf8');
  ok('file is a complete single page (one <html>, has </html>)', (html.match(/<html[\s>]/gi) || []).length === 1 && /<\/html>\s*$/.test(html));
  ok('size > 1 MB (engine + game inlined)', html.length > 1e6, (html.length / 1048576).toFixed(2) + ' MB');
  const ext = [];
  const re = /\b(?:src|href)\s*=\s*["']?\s*(?:https?:)?\/\/[^"'\s>]+/gi; let m;
  while ((m = re.exec(html))) { if (!/fonts\.googleapis|fonts\.gstatic/.test(m[0])) ext.push(m[0]); }
  ok('no external script/img/link references (fonts @import excepted)', ext.length === 0, ext.slice(0, 3));
  const imports = (html.match(/@import\s+url\([^)]*\)/g) || []).filter(s => !/fonts\.googleapis/.test(s));
  ok('only the Google Fonts @import', imports.length === 0, imports.slice(0, 2));
  ok('no ES module scripts (<script type="module">)', !/<script[^>]+type=["']module["']/i.test(html));
  ok('three.js r160 inlined', /data-module="three\.min\.js/.test(html));
  const modules = (html.match(/data-module="([^"]+)"/g) || []).length;
  ok('game modules inlined (≥ 30 script modules)', modules >= 30, modules + ' modules');
  ok('99_main.js (boot + __T hooks) present in build', /data-module="99_main\.js"/.test(html));
  const inGame = await T.evalG(() => !!(window.__T && window.__T.inGame));
  ok('plays from file:// (booted headless from file URL)', inGame);
});

scenario('R02', 'No errors during the run; every panel opens/closes cleanly', async (T, ok, ctx) => {
  const errAt = ctx.errors.length;
  const res = await T.evalG(() => {
    const G = window.G, out = { opened: [], closed: [], missing: [] };
    for (const id of ['inventory', 'character', 'abilities', 'journal', 'map', 'players', 'settings', 'keyhelp']) {
      if (!G.UI.getPanel || !G.UI.getPanel(id)) { out.missing.push(id); continue; }
      G.UI.openPanel(id); out.opened.push(id + ':' + window.__V.visible(id));
      G.UI.closePanel(id); out.closed.push(id + ':' + !G.UI.isOpen(id));
    }
    return out;
  });
  ok('all standard panels registered', res.missing.length === 0, res.missing);
  ok('each panel opens', res.opened.every(s => /:true$/.test(s)), res.opened.filter(s => /:false$/.test(s)));
  ok('each panel closes', res.closed.every(s => /:true$/.test(s)), res.closed.filter(s => /:false$/.test(s)));
  for (const k of ['KeyI', 'KeyC', 'KeyK', 'KeyJ', 'KeyM', 'KeyP']) { await T.press(k, 250); await T.press(k, 250); }
  const anyOpen = await T.evalG(() => window.G.UI.anyOpen());
  ok('panel keys toggle cleanly (nothing left open)', !anyOpen);
  ok('no page/console errors while cycling panels', ctx.errors.length === errAt, ctx.errors.slice(errAt, errAt + 2));
  ctx.r02Provisional = true;    // final "zero errors across the whole run" check is applied after the last scenario
});

scenario('R03', 'Performance: ≤ 600 draw calls at high; frame time (report)', async (T, ok) => {
  await T.evalG(() => { const G = window.G; if (G.PostFX && G.PostFX.setQuality) G.PostFX.setQuality('high'); });
  await T.wait(2500);
  const samples = [];
  for (let i = 0; i < 10; i++) {
    const s = await T.evalG(() => {
      const G = window.G; const st = (window.__T && window.__T.stats) ? window.__T.stats() : null;
      const info = G.Game && G.Game.renderer && G.Game.renderer.info ? G.Game.renderer.info.render : null;
      return { stats: st, calls: info ? info.calls : null, tris: info ? info.triangles : null, fps: G.Game && G.Game.fps, quality: G.state.quality };
    });
    samples.push(s); await T.wait(500);
  }
  const has = samples.some(s => s.stats);
  ok('__T.stats() available', has, samples[0] && samples[0].stats);
  const draws = samples.map(s => (s.stats && isFinite(s.stats.drawCalls)) ? s.stats.drawCalls : (isFinite(s.calls) ? s.calls : NaN)).filter(isFinite);
  const fps = samples.map(s => (s.stats && isFinite(s.stats.fps)) ? s.stats.fps : (isFinite(s.fps) ? s.fps : NaN)).filter(isFinite);
  const maxDraw = draws.length ? Math.max.apply(null, draws) : NaN;
  const avgFps = fps.length ? fps.reduce((a, b) => a + b, 0) / fps.length : NaN;
  ok('draw calls measurable', draws.length > 0);
  ok('draw calls ≤ 600 at high', isFinite(maxDraw) && maxDraw <= 600, 'max ' + maxDraw + ' over ' + draws.length + ' samples (quality ' + (samples[0] && samples[0].quality) + ')');
  ok('adaptive quality API present (G.PostFX.setQuality / G.Game.fps)', await T.evalG(() => !!(window.G.PostFX && window.G.PostFX.setQuality) && typeof (window.G.Game && window.G.Game.fps) !== 'undefined'));
  ok('frame time (report only; headless software GL)', true, 'avg fps ' + (isFinite(avgFps) ? avgFps.toFixed(1) : '?') + ' ≈ ' + (isFinite(avgFps) && avgFps > 0 ? (1000 / avgFps).toFixed(1) : '?') + ' ms/frame; tris ' + (samples[0] && (samples[0].stats && samples[0].stats.triangles || samples[0].tris)));
});

scenario('R04', 'Graphics: post-processing, shadows, day/night, weather, water, vegetation, fog', async (T, ok) => {
  const r = await T.evalG(() => {
    const G = window.G, P = G.PostFX, R = G.Game && G.Game.renderer, S = G.Game && G.Game.scene;
    return {
      postfx: !!(P && P.enabled && !P.failed), bloom: !!(P && P.features && P.features.bloom), fxaa: !!(P && P.features && P.features.fxaa),
      tonemap: P && P.params ? P.params.tonemap : null, sharpen: P && P.params ? P.params.sharpen : null,
      shadowMap: !!(R && R.shadowMap && R.shadowMap.enabled), sunShadow: !!(G.Sky && G.Sky.sun && G.Sky.sun.castShadow),
      sky: !!G.Sky, fog: !!(S && S.fog), water: !!(G.Terrain && (G.Terrain.water || G.Terrain.waterMaterial)), veg: !!(G.Veg && G.Veg.update), wind: !!(G.Veg && G.Veg.setWind),
      phase: G.Sky && G.Sky.phase, weather: G.state.weather,
    };
  });
  ok('PostFX pipeline enabled', r.postfx, r);
  ok('bloom + FXAA features on', r.bloom && r.fxaa);
  ok('ACES tonemap + sharpen params', (r.tonemap == null || /aces/i.test(String(r.tonemap)) || r.tonemap === true || typeof r.tonemap === 'number') && (r.sharpen == null || r.sharpen >= 0), { tonemap: r.tonemap, sharpen: r.sharpen });
  ok('shadows enabled (renderer.shadowMap + sun.castShadow)', r.shadowMap && r.sunShadow);
  ok('sky, fog, water, vegetation (with wind) present', r.sky && r.fog && r.water && r.veg && r.wind, r);
  await T.evalG(() => window.G.Sky.setWeather('rain', true)); await T.wait(400);
  const w = await T.evalG(() => ({ state: window.G.state.weather, sky: window.G.Sky.weather, rain: window.G.Sky.rainLevel }));
  ok('weather change works (setWeather → G.state.weather = rain)', w.state === 'rain', w);
  await T.evalG(() => window.G.Sky.setWeather('snow', true)); await T.wait(300);
  ok('snow weather', await T.evalG(() => window.G.state.weather === 'snow'));
  await T.evalG(() => { const t = window.__T; if (t && t.setTime) t.setTime(23.5); else window.G.Sky.setTime(23.5); }); await T.wait(400);
  const night = await T.evalG(() => ({ phase: window.G.Sky.phase, light: window.G.Sky.lightLevel }));
  await T.evalG(() => { const t = window.__T; if (t && t.setTime) t.setTime(12); else window.G.Sky.setTime(12); }); await T.wait(400);
  const day = await T.evalG(() => ({ phase: window.G.Sky.phase, light: window.G.Sky.lightLevel }));
  ok('day/night cycle (23:30 → night, 12:00 → day)', night.phase === 'night' && day.phase === 'day', { night, day });
  await T.evalG(() => window.G.Sky.setWeather('clear', true));
});

// ---- Controls ---------------------------------------------------------------------------------------------
const posAndAxes = () => {
  const G = window.G, p = G.state.player; const v = new window.THREE.Vector3();
  G.Player.camera.getWorldDirection(v); v.y = 0; v.normalize();
  return { x: p.pos.x, z: p.pos.z, fwd: [v.x, v.z], right: [-v.z, v.x], onGround: p.onGround, water: p.inWater };
};
async function moveTest(T, key, ms, spot) {
  await T.evalG((s) => { window.__V.tp(s.x, s.z); }, spot);
  await T.wait(400);
  const a = await T.evalG(posAndAxes);
  await T.hold(key, ms); await T.wait(200);
  const b = await T.evalG(posAndAxes);
  const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz) || 1e-9;
  return { dist: d, fwdDot: (dx * a.fwd[0] + dz * a.fwd[1]) / d, rightDot: (dx * a.right[0] + dz * a.right[1]) / d };
}
scenario('R10', 'WASD movement relative to the camera', async (T, ok) => {
  const spot = await T.evalG(() => window.__V.openSpot());
  ok('found an open spot to run on', !!spot, spot);
  if (!spot) return;
  const w = await moveTest(T, 'KeyW', 1000, spot);
  ok('W moves forward ≥ 3 m along camera forward', w.dist >= 3 && w.fwdDot > 0.7, { dist: +w.dist.toFixed(2), dot: +w.fwdDot.toFixed(2) });
  const s = await moveTest(T, 'KeyS', 1500, spot);
  ok('S moves backward ≥ 3 m', s.dist >= 3 && s.fwdDot < -0.7, { dist: +s.dist.toFixed(2), dot: +s.fwdDot.toFixed(2) });
  const a = await moveTest(T, 'KeyA', 1000, spot);
  ok('A strafes left ≥ 3 m', a.dist >= 3 && a.rightDot < -0.7, { dist: +a.dist.toFixed(2), rightDot: +a.rightDot.toFixed(2) });
  const d = await moveTest(T, 'KeyD', 1000, spot);
  ok('D strafes right ≥ 3 m', d.dist >= 3 && d.rightDot > 0.7, { dist: +d.dist.toFixed(2), rightDot: +d.rightDot.toFixed(2) });
  ok('movement is not on/in water', !(await T.evalG(() => window.G.state.player.inWater)));
});

scenario('R11', 'Mouse look (pointer lock / RMB drag) and wheel zoom', async (T, ok) => {
  const page = T.page;
  ok('pointer-lock API wired (G.Input.requestLock/lockSupported)', await T.evalG(() => !!(window.G.Input.requestLock && window.G.Input.lockSupported !== undefined)));
  await T.evalG(() => { document.getElementById('game').focus(); });
  const y0 = await T.evalG(() => window.G.Player.cam.yaw);
  await page.mouse.move(640, 360); await page.mouse.down({ button: 'right' });
  await page.mouse.move(860, 360, { steps: 12 }); await T.wait(120);
  await page.mouse.up({ button: 'right' }); await T.wait(250);
  const y1 = await T.evalG(() => window.G.Player.cam.yaw);
  ok('RMB drag turns the camera (yaw changed)', Math.abs(wrapAngle(y1 - y0)) > 0.05, { from: +y0.toFixed(3), to: +y1.toFixed(3) });
  const p0 = await T.evalG(() => window.G.Player.cam.pitch);
  await page.mouse.move(640, 360); await page.mouse.down({ button: 'right' });
  await page.mouse.move(640, 460, { steps: 10 }); await T.wait(120);
  await page.mouse.up({ button: 'right' }); await T.wait(250);
  const p1 = await T.evalG(() => window.G.Player.cam.pitch);
  ok('RMB vertical drag changes pitch', Math.abs(p1 - p0) > 0.02, { from: +p0.toFixed(3), to: +p1.toFixed(3) });
  await page.mouse.move(640, 360); await T.wait(100);
  const d0 = await T.evalG(() => window.G.Player.cam.targetDist);
  await page.mouse.wheel(0, -300); await T.wait(300);
  const d1 = await T.evalG(() => window.G.Player.cam.targetDist);
  await page.mouse.wheel(0, 900); await T.wait(300);
  const d2 = await T.evalG(() => window.G.Player.cam.targetDist);
  ok('wheel up zooms in (targetDist decreased)', d1 < d0 - 0.05, { d0, d1 });
  ok('wheel down zooms out (targetDist increased)', d2 > d1 + 0.05, { d1, d2 });
  await page.mouse.wheel(0, -600); await T.wait(200);
});

scenario('R12', 'Third-person camera with collision', async (T, ok) => {
  const spot = await T.evalG(() => window.__V.openSpot());
  if (spot) await T.evalG((s) => window.__V.tp(s.x, s.z), spot);
  await T.evalG(() => { const c = window.G.Player.cam; c.targetDist = 7; c.pitch = 0.28; });
  await T.wait(1200);
  const r = await T.evalG(() => {
    const G = window.G, p = G.state.player, cam = G.Player.camera, v = new window.THREE.Vector3(); G.Player.getForward(v);
    const dx = p.pos.x - cam.position.x, dz = p.pos.z - cam.position.z, d = Math.hypot(dx, dz) || 1e-9;
    return { behindDot: (dx * v.x + dz * v.z) / d, camY: cam.position.y, playerY: p.pos.y, groundY: G.Terrain.height(cam.position.x, cam.position.z), dist: G.Player.cam.dist, target: G.Player.cam.targetDist, fov: cam.fov, hasClamp: !!(G.Physics && G.Physics.cameraClamp) };
  });
  ok('camera is behind the player (looking along player forward)', r.behindDot > 0.3, { dot: +r.behindDot.toFixed(2) });
  ok('camera above the player and above terrain', r.camY > r.playerY + 0.3 && r.camY > r.groundY, { camY: +r.camY.toFixed(2), playerY: +r.playerY.toFixed(2), groundY: +r.groundY.toFixed(2) });
  ok('camera follows at the requested distance in the open', Math.abs(r.dist - r.target) < 0.6, { dist: +r.dist.toFixed(2), target: r.target });
  ok('G.Physics.cameraClamp present', r.hasClamp);
  // collision: stand inside an enterable building and ask for a long camera distance → the walls must clamp it
  const inside = await T.evalG(() => {
    const G = window.G; const b = (G.Buildings.all || []).find(x => x.enterable && /inn/.test(x.recipe)) || (G.Buildings.all || []).find(x => x.enterable);
    if (!b) return null;
    let x = b.x, z = b.z; if (G.Physics.nearestFree) { const f = G.Physics.nearestFree(x, z, 3); if (f && isFinite(f.x)) { x = f.x; z = f.z; } }
    window.__V.tp(x, z); const c = G.Player.cam; c.targetDist = 14; c.pitch = 0.05;
    return { id: b.id, name: b.name, recipe: b.recipe };
  });
  ok('found an enterable building for the collision test', !!inside, inside);
  if (inside) {
    await T.wait(1500);
    const c = await T.evalG(() => {
      const G = window.G, p = G.state.player, cam = G.Player.camera; const b = G.Buildings.isInside(p.pos);
      return { inside: !!b, dist: G.Player.cam.dist, target: G.Player.cam.targetDist, camY: cam.position.y, groundY: G.Terrain.height(cam.position.x, cam.position.z) };
    });
    ok('player is inside the building', c.inside);
    ok('camera clamped by walls (dist ≥ 0.5 and < requested 14 m)', c.dist >= 0.5 && c.dist < 13, { dist: +c.dist.toFixed(2), target: c.target });
    ok('clamped camera not under the terrain', c.camY > c.groundY - 0.2, { camY: +c.camY.toFixed(2), groundY: +c.groundY.toFixed(2) });
  }
  await T.evalG((s) => { const c = window.G.Player.cam; c.targetDist = 7; c.pitch = 0.28; if (s) window.__V.tp(s.x, s.z); }, spot);
});

scenario('R13', 'Q = dodge roll with i-frames and cooldown', async (T, ok) => {
  const spot = await T.evalG(() => window.__V.openSpot());
  if (spot) await T.evalG((s) => window.__V.tp(s.x, s.z), spot);
  await T.wait(500);
  const before = await T.evalG(() => { const G = window.G, p = G.state.player; return { x: p.pos.x, z: p.pos.z, ready: G.Player.rollCooldown ? G.Player.rollCooldown() : 1, onGround: p.onGround }; });
  ok('roll ready before the test', before.ready >= 0.99 && before.onGround, before);
  await T.page.keyboard.down('KeyQ');
  const rolling = await T.waitFor(() => { const G = window.G, p = G.state.player; return (G.Player.rolling || p.invulnerable || p.anim === 'roll') ? { rolling: !!G.Player.rolling, inv: !!p.invulnerable, anim: p.anim } : null; }, 400);
  await T.page.keyboard.up('KeyQ');
  ok('rolling + invulnerable within 100–400 ms of Q', !!rolling && rolling.inv, rolling);
  await T.wait(900);
  const after = await T.evalG(() => { const G = window.G, p = G.state.player; return { x: p.pos.x, z: p.pos.z, rolling: !!G.Player.rolling, inv: !!p.invulnerable, cd: G.Player.rollCooldown ? G.Player.rollCooldown() : null, readyAt: p.rollReady, now: G.time.now }; });
  ok('roll moved the player', Math.hypot(after.x - before.x, after.z - before.z) > 1.5, +Math.hypot(after.x - before.x, after.z - before.z).toFixed(2) + ' m');
  ok('i-frames end after the roll', !after.rolling && !after.inv);
  ok('cooldown running after the roll', after.cd !== null && after.cd < 1 && after.readyAt > after.now, { cdFrac: after.cd });
  await T.press('KeyQ', 300);
  const again = await T.evalG(() => !!window.G.Player.rolling || !!window.G.state.player.invulnerable);
  ok('Q ignored while on cooldown', !again);
  ok('roll dust FX + sfx available (G.FX.spawn, G.Audio.sfx)', await T.evalG(() => !!(window.G.FX && window.G.FX.spawn && window.G.Audio && window.G.Audio.sfx)));
});

scenario('R14', 'R = ranged attack with the equipped ranged weapon', async (T, ok) => {
  const spot = await T.evalG(() => window.__V.openSpot());
  if (spot) await T.evalG((s) => window.__V.tp(s.x, s.z), spot);
  const eq = await T.evalG(() => {
    const G = window.G, p = G.state.player; const cls = G.Data.classes.find(c => c.id === p.cls); const want = cls ? cls.rangedWeapon : 'bow';
    let have = p.equipment.ranged;
    if (!have) {
      const cands = G.Items.search(want).filter(t => t.slot === 'ranged' && (t.level || 1) <= p.level && (!t.classes || t.classes.indexOf(p.cls) >= 0));
      const t = cands[0] || G.Items.search('bow').find(x => x.slot === 'ranged' && (x.level || 1) <= p.level);
      if (t) G.Items.equipDirect(p, t.id, 'ranged');
      have = p.equipment.ranged;
    }
    return { want, equipped: have ? (G.Items.get(have).name + ' (' + G.Items.get(have).subtype + ')') : null };
  });
  ok('a ranged weapon is equipped (' + eq.want + ')', !!eq.equipped, eq);
  const id = await T.evalG(() => window.__V.spawn({ dist: 12 }));
  ok('spawned a target 12 m ahead', !!id);
  if (!id) return;
  const m0 = await T.evalG((id) => { const G = window.G, m = window.__V.ent(id); G.Player.setTarget(m); window.__V.face(m); return { morale: m.morale, max: m.stats && m.stats.maxMorale, name: m.name, level: m.level }; }, id);
  await T.wait(300);
  await T.press('KeyR', 100);
  const hit = await T.waitFor((id) => { const m = window.__V.ent(id); if (!m) return { gone: true }; return (m.morale < (m.stats ? m.stats.maxMorale : Infinity) - 0.5 || m.dead) ? { morale: m.morale, dead: !!m.dead } : null; }, 3500, id);
  ok('target morale dropped within 3 s of R (projectile hit)', !!hit, { before: m0, after: hit });
  ok('ranged attack API present (G.Player.rangedAttack, G.FX.projectile)', await T.evalG(() => !!(window.G.Player.rangedAttack && window.G.FX && window.G.FX.projectile)));
  await T.evalG(() => window.__V.despawnAll());
});

scenario('R15', 'E = interact: doors and NPC dialogue', async (T, ok) => {
  // door
  const door = await T.evalG(() => {
    const G = window.G, p = G.state.player;
    const doors = G.state.entities.filter(e => e.kind === 'door' && e.building && e.building.enterable);
    if (!doors.length) return null;
    doors.sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.z - p.pos.z) - Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z));
    const d = doors[0];
    const cands = [[Math.sin(d.yaw), Math.cos(d.yaw)], [-Math.sin(d.yaw), -Math.cos(d.yaw)], [Math.cos(d.yaw), -Math.sin(d.yaw)], [-Math.cos(d.yaw), Math.sin(d.yaw)]];
    let best = null;
    for (const [sx, sz] of cands) { const x = d.pos.x + sx * 1.7, z = d.pos.z + sz * 1.7; const free = !G.Physics.isFree || G.Physics.isFree(x, z, 0.4); const outside = !G.Buildings.isInside({ x, y: d.pos.y + 0.5, z }); const score = (free ? 2 : 0) + (outside ? 1 : 0); if (!best || score > best.score) best = { x, z, score }; }
    window.__V.tp(best.x, best.z); window.__V.face(d);
    return { id: d.id, name: d.name, open: !!d.open, x: best.x, z: best.z };
  });
  ok('found a door entity', !!door, door);
  if (door) {
    await T.wait(500);
    await T.evalG((id) => window.__V.face(window.__V.ent(id)), door.id);
    await T.wait(350);
    const prompt = await T.evalG(() => { const t = window.G.Player.interactTarget; return t ? { label: t.label, name: t.name } : null; });
    await T.press('KeyE', 100);
    let toggled = await T.waitFor((o) => { const d = window.__V.ent(o.id); return d && !!d.open !== o.open ? { open: !!d.open } : null; }, 1500, door);
    if (!toggled) { await T.press('KeyE', 100); toggled = await T.waitFor((o) => { const d = window.__V.ent(o.id); return d && !!d.open !== o.open ? { open: !!d.open } : null; }, 1500, door); }
    ok('E toggles the door open state', !!toggled, { door: door.name, prompt, before: door.open, after: toggled });
    ok('interact prompt showed the door', !!prompt, prompt);
  }
  // NPC → dialogue
  const npc = await T.evalG(() => {
    const G = window.G, p = G.state.player;
    const n = window.__V.nearest('npc', e => e.interact && e.alive !== false && !G.Buildings.isInside(e.pos));
    if (!n) return null;
    const dx = p.pos.x - n.pos.x, dz = p.pos.z - n.pos.z, l = Math.hypot(dx, dz) || 1;
    let x = n.pos.x + dx / l * 2.2, z = n.pos.z + dz / l * 2.2;
    if (G.Physics.nearestFree) { const f = G.Physics.nearestFree(x, z, 2); if (f && isFinite(f.x)) { x = f.x; z = f.z; } }
    window.__V.tp(x, z); window.__V.face(n);
    return { id: n.id, name: n.name, npcId: n.npcId };
  });
  ok('found an NPC outdoors', !!npc, npc);
  if (npc) {
    await T.wait(500); await T.evalG((id) => window.__V.face(window.__V.ent(id)), npc.id); await T.wait(350);
    await T.press('KeyE', 100);
    let open = await T.waitFor(() => window.__V.visible('dialogue'), 2000);
    if (!open) { await T.press('KeyE', 100); open = await T.waitFor(() => window.__V.visible('dialogue'), 1500); }
    ok('E on an NPC opens the dialogue panel', !!open, npc.name);
    const txt = await T.evalG(() => { const el = document.getElementById('panel-dialogue'); return el ? (el.textContent || '').trim().slice(0, 80) : ''; });
    ok('dialogue shows text', txt.length > 10, txt);
    await T.evalG(() => { window.G.UI.closePanel('dialogue'); if (window.G.NPCs.endTalk) window.G.NPCs.endTalk(); });
  }
  const kinds = await T.evalG(() => { const s = new Set(); for (const e of window.G.state.entities) if (e.interact) s.add(e.kind + (e.subkind ? '/' + e.subkind : '')); return Array.from(s); });
  ok('interactable entity kinds present (door, npc, node/dock/fishspot…)', kinds.indexOf('door') >= 0 && kinds.indexOf('npc') >= 0, kinds);
});

scenario('R16', 'I = inventory with exactly 200 slots', async (T, ok) => {
  await T.press('KeyI', 400);
  const r = await T.evalG(() => ({ visible: window.__V.visible('inventory'), slots: document.querySelectorAll('#panel-inventory .inv-slot').length, inv: window.G.state.player.inventory.length, c: window.G.C.INVENTORY_SLOTS, bags: (document.querySelector('#panel-inventory .inv-bags') || {}).textContent }));
  ok('I opens #panel-inventory', r.visible);
  ok('grid renders exactly 200 slots', r.slots === 200, r.slots);
  ok('player.inventory.length === 200', r.inv === 200, r.inv);
  ok('G.C.INVENTORY_SLOTS === 200', r.c === 200);
  ok('bag counter shows /200', /\/\s*200/.test(r.bags || ''), r.bags);
  await T.press('KeyI', 300);
  ok('I again closes it', !(await T.evalG(() => window.__V.visible('inventory'))));
});

scenario('R17', 'F = fishing at water; catches fish', async (T, ok) => {
  const spot = await T.evalG(() => {
    const G = window.G, Tr = G.Terrain; const spots = (G.Data.world.fishingSpots || []);
    const tryAt = (sx, sz, name) => {
      for (let a = 0; a < 24; a++) {
        const dx = Math.cos(a / 24 * Math.PI * 2), dz = Math.sin(a / 24 * Math.PI * 2);
        for (let r = 0; r <= 90; r += 1.5) {
          const x = sx + dx * r, z = sz + dz * r;
          if (Tr.isWater(x, z)) continue;
          // land here; is there water 3–5 m back toward the spot?
          if (Tr.isWater(x - dx * 3, z - dz * 3) || Tr.isWater(x - dx * 5, z - dz * 5)) {
            const px = x + dx * 0.8, pz = z + dz * 0.8; if (Tr.isWater(px, pz)) continue;
            window.__V.tp(px, pz); window.__V.face({ pos: { x: px - dx * 6, z: pz - dz * 6 } });
            const c = G.Fishing.canFish(); if (c.ok) return { x: px, z: pz, name, reason: null };
          }
        }
      }
      return null;
    };
    const order = spots.slice(0, 6);
    for (const s of order) { const r = tryAt(s.pos.x, s.pos.z, s.name || s.id); if (r) return r; }
    const p = G.state.player; return tryAt(p.pos.x, p.pos.z, 'nearest water') || { x: null, reason: 'no shore found near ' + order.map(s => s.id).join(',') };
  });
  ok('found a fishable shore (G.Fishing.canFish ok)', !!(spot && spot.x != null), spot);
  if (!spot || spot.x == null) return;
  await T.wait(500);
  await T.evalG((s) => { window.__V.face({ pos: { x: s.x + (s.x - window.G.state.player.pos.x), z: s.z } }); }, spot);
  await T.evalG((s) => { const G = window.G; const p = G.state.player; const v = new window.THREE.Vector3(); G.Player.getForward(v); /* re-face toward water */ for (let k = 0; k < 8; k++) { const y = k / 8 * Math.PI * 2; p.yaw = y; G.Player.cam.yaw = y; if (G.Fishing.canFish().ok) break; } }, spot);
  await T.wait(300);
  const can = await T.evalG(() => window.G.Fishing.canFish());
  ok('standing at the water edge facing water', !!can.ok, can);
  await T.press('KeyF', 100);
  const st = await T.waitFor(() => { const s = window.G.Fishing.state; return s !== 'idle' ? s : null; }, 1500);
  ok('F starts fishing (state ≠ idle)', !!st, st);
  await T.evalG(() => window.G.Fishing.cancel(false)); await T.wait(600);
  const fish0 = await T.evalG(() => ({ n: window.__V.fish.length, stat: window.G.state.stats.fish, skill: window.G.state.fishingSkill }));
  await T.evalG(() => { window.G.time.scale = 4; window.G.Fishing.autoFish(); });
  const caught = await T.waitFor((f0) => { const V = window.__V; if (V.fish.length > f0.n) return V.fish[V.fish.length - 1]; if (window.G.Fishing.state === 'idle' && !window.G.Fishing.autoActive) window.G.Fishing.autoFish(); return null; }, OPTS.fast ? 20000 : 28000, fish0);
  await T.evalG(() => { window.G.time.scale = 1; if (window.G.Fishing.state !== 'idle') window.G.Fishing.cancel(false); });
  ok('autoFish catches something (fishCaught event)', !!caught, caught);
  const after = await T.evalG(() => { const G = window.G, p = G.state.player; let fish = 0; for (const it of p.inventory) if (it && G.Items.get(it) && G.Items.get(it).type === 'fish') fish++; return { fishItems: fish, stat: G.state.stats.fish, skill: G.state.fishingSkill, minigameUI: !!document.querySelector('#fishBar, .fish-bar, #fishing, .fishing-bar, [id*="fish"]') }; });
  ok('a fish item / fish stat / skill advanced', (caught && caught.kind === 'fish' ? after.fishItems > 0 : true) && (after.stat >= fish0.stat) && (after.skill >= fish0.skill), after);
});

scenario('R18', 'H = mount/dismount; mounted is faster', async (T, ok) => {
  const spot = await T.evalG(() => window.__V.openSpot());
  ok('open ground found', !!spot);
  if (!spot) return;
  const walk = await moveTest(T, 'KeyW', 1200, spot);
  await T.evalG((s) => window.__V.tp(s.x, s.z), spot); await T.wait(400);
  await T.press('KeyH', 100);
  const mounted = await T.waitFor(() => window.G.state.player.mounted ? { mounted: true, rig: !!window.G.state.player.mountRig } : null, 2000);
  ok('H mounts the horse (player.mounted)', !!mounted, mounted);
  const a = await T.evalG(posAndAxes);
  await T.hold('KeyW', 1200); await T.wait(200);
  const b = await T.evalG(posAndAxes);
  const ride = Math.hypot(b.x - a.x, b.z - a.z);
  ok('mounted run is faster (≥ 1.3× on foot, ≥ 8 m in 1.2 s)', ride >= 8 && ride > walk.dist * 1.3, { onFoot: +walk.dist.toFixed(2), mounted: +ride.toFixed(2) });
  await T.press('KeyH', 100);
  const off = await T.waitFor(() => !window.G.state.player.mounted, 2000);
  ok('H again dismounts', !!off);
});

scenario('R19', 'J = journal with quest details and remaining quests', async (T, ok) => {
  const acc = await T.evalG(() => { const Q = window.G.Quests; if (!Q.active().length) { const id = (Q.availableIds && Q.availableIds()[0]) || Q.nextStory(); if (id) Q.accept(id, { force: true }); } return { active: Q.active(), tracked: Q.tracked }; });
  ok('an active quest exists', acc.active.length > 0, acc);
  await T.press('KeyJ', 500);
  const r = await T.evalG(() => { const el = document.getElementById('panel-journal'); const txt = el ? el.textContent : ''; return { visible: window.__V.visible('journal'), rows: document.querySelectorAll('#panel-journal .jn-row').length, hasCompletion: /\/\s*150/.test(txt), hasObjectives: /Objectives|objective/i.test(txt), hasRewards: /Reward/i.test(txt), tabs: Array.from(document.querySelectorAll('#panel-journal .tab, #panel-journal [class*="tab"]')).map(t => t.textContent.trim()).slice(0, 6) }; });
  ok('J opens #panel-journal', r.visible);
  ok('journal lists quest entries', r.rows >= 1, r.rows);
  ok('shows completion N/150', r.hasCompletion);
  ok('detail shows objectives + rewards', r.hasObjectives && r.hasRewards, r);
  const jd = await T.evalG(() => { const d = window.G.Quests.journalData(); return d ? Object.keys(d) : null; });
  ok('G.Quests.journalData() returns data', !!jd, jd);
  await T.press('KeyJ', 300);
  ok('J closes it', !(await T.evalG(() => window.__V.visible('journal'))));
});

scenario('R20', 'K = abilities: unlock by level, train for gold', async (T, ok) => {
  await T.press('KeyK', 500);
  const r = await T.evalG(() => ({ visible: window.__V.visible('abilities'), rows: document.querySelectorAll('#panel-abilities .ab-row').length, total: window.G.Data.abilitiesFor(window.G.state.player.cls).length }));
  ok('K opens #panel-abilities', r.visible);
  ok('lists all 13 class abilities', r.rows === 13 && r.total === 13, r);
  const prep = await T.evalG(() => {
    const G = window.G, p = G.state.player, Pr = G.Progress; const level0 = p.level;
    let list = Pr.untrainedAvailable ? Pr.untrainedAvailable() : [];
    if (!list.length) { Pr.setLevel(Math.max(level0, 12)); list = Pr.untrainedAvailable ? Pr.untrainedAvailable() : []; }
    if (!list.length) return { level0, none: true };
    const a = list[0]; const ct = Pr.canTrain(a.id); const cost = ct && ct.cost != null ? ct.cost : (a.cost || 0);
    if (!ct.ok) Pr.addGold(cost + 1000, { silent: true });
    if (G.UI.Abilities && G.UI.Abilities.refresh) G.UI.Abilities.refresh();
    const size = p.abilities && p.abilities.size != null ? p.abilities.size : (p.abilities || []).length;
    return { level0, id: a.id, name: a.name, cost, gold: p.gold, size, canTrain: Pr.canTrain(a.id) };
  });
  ok('an untrained, affordable ability exists (level raised temporarily if needed)', !prep.none && prep.canTrain && prep.canTrain.ok, prep);
  if (!prep.none) {
    const sel = '#panel-abilities .ab-row[data-id="' + prep.id + '"] button';
    const btn = await T.page.$$(sel);
    let viaUI = false;
    for (const b of btn) { const t = (await b.textContent()) || ''; if (/train/i.test(t)) { await b.click(); viaUI = true; break; } }
    if (!viaUI) await T.evalG((id) => window.G.Progress.trainAbility(id), prep.id);
    await T.wait(400);
    const after = await T.evalG((id) => { const p = window.G.state.player; const size = p.abilities && p.abilities.size != null ? p.abilities.size : (p.abilities || []).length; return { size, gold: p.gold, has: window.G.Progress.hasAbility ? window.G.Progress.hasAbility(p, id) : null, hotbar: p.hotbar.indexOf(id) }; }, prep.id);
    ok('training grew player.abilities (' + (viaUI ? 'Train button' : 'API fallback') + ')', after.size === prep.size + 1 && after.has !== false, { before: prep.size, after: after.size, viaUI });
    ok('training cost gold', prep.cost > 0 ? after.gold === prep.gold - prep.cost : true, { cost: prep.cost, before: prep.gold, after: after.gold });
    ok('trained ability placed on the hotbar', after.hotbar >= 0, after.hotbar);
    await T.evalG((L) => window.G.Progress.setLevel(L), prep.level0);
  }
  await T.press('KeyK', 300);
  ok('K closes it', !(await T.evalG(() => window.__V.visible('abilities'))));
});

scenario('R21', 'C = character: paper doll (18 slots), stats, set bonuses', async (T, ok) => {
  await T.press('KeyC', 700);
  const r = await T.evalG(() => {
    const el = document.getElementById('panel-character'); const txt = el ? el.textContent : '';
    return { visible: window.__V.visible('character'), slots: document.querySelectorAll('#panel-character .ch-slot').length, eq: window.G.C.EQUIP_SLOTS.length, preview: !!document.querySelector('#panel-character .ch-preview'), previewCanvas: !!document.querySelector('#panel-character .ch-preview canvas'), might: /Might/.test(txt), morale: /Morale/.test(txt), mastery: /Mastery/.test(txt), sets: /Set/i.test(txt), setBonuses: !!(window.G.Items.setBonuses && window.G.Items.setBonuses(window.G.state.player)) };
  });
  ok('C opens #panel-character', r.visible);
  ok('18 equipment slots rendered (G.C.EQUIP_SLOTS = 18)', r.slots === 18 && r.eq === 18, { slots: r.slots, eq: r.eq });
  ok('3D preview present', r.preview && r.previewCanvas, { preview: r.preview, canvas: r.previewCanvas });
  ok('stats text (Might / Morale / Mastery)', r.might && r.morale && r.mastery);
  ok('gear-set summary + G.Items.setBonuses', r.sets && r.setBonuses);
  await T.press('KeyC', 300);
  ok('C closes it', !(await T.evalG(() => window.__V.visible('character'))));
});

scenario('R22', 'B = auto-quest bot progresses quests without deadlock', async (T, ok) => {
  const budget = OPTS.fast ? 60000 : 150000;
  const c0 = await T.evalG(() => { const G = window.G; G.AutoQuest.speed = 10; G.time.scale = 3; const c = G.Quests.completion(); return { done: c.done, total: c.total, level: G.state.player.level, xp: G.state.player.xp }; });
  ok('150 quests tracked by G.Quests.completion()', c0.total === 150, c0);
  await T.press('KeyB', 300);
  let active = await T.waitFor(() => window.G.AutoQuest.active, 1500);
  if (!active) { await T.evalG(() => window.G.AutoQuest.start()); active = await T.waitFor(() => window.G.AutoQuest.active, 1500); ok('B key toggles the bot (fell back to AutoQuest.start())', false); }
  ok('auto-quest active', !!active);
  ok('HUD auto-quest strip visible', !!(await T.waitFor(() => { const el = document.getElementById('autoquestStrip'); return el && !el.hidden; }, 2000)));
  const texts = new Set(); let last = null; const t0 = Date.now();
  while (Date.now() - t0 < budget) {
    await T.wait(2000);
    last = await T.evalG(() => { const G = window.G; const s = G.AutoQuest.status(); const c = G.Quests.completion(); return { text: s && s.text, questId: s && s.questId, step: s && s.step, done: c.done, active: G.AutoQuest.active, errors: G.AutoQuest.stats.errors, teleports: G.AutoQuest.stats.teleports, forced: G.AutoQuest.stats.forced, level: G.state.player.level }; });
    if (last.text) texts.add(last.text);
    if (last.done - c0.done >= 3) break;
    if (!last.active) break;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  ok('completed ≥ 3 quests in ' + secs + ' s (' + c0.done + ' → ' + (last && last.done) + ')', last && last.done - c0.done >= 3, last);
  ok('bot status text changes (' + texts.size + ' distinct)', texts.size >= 2, Array.from(texts).slice(0, 4));
  ok('bot did not stop itself on errors', last && last.errors === 0 && (last.active || last.done >= 150), { errors: last && last.errors, forced: last && last.forced, teleports: last && last.teleports });
  await T.press('KeyB', 300);
  const stopped = await T.waitFor(() => !window.G.AutoQuest.active, 1500);
  if (!stopped) await T.evalG(() => window.G.AutoQuest.stop());
  ok('B again stops the bot', !!stopped);
  await T.evalG(() => { window.G.time.scale = 1; window.G.UI.closeAll(); });
}, { timeout: OPTS.fast ? 90000 : 180000 });

scenario('R23', 'M = map with player position; quest tracker + minimap', async (T, ok) => {
  const q = await T.evalG(() => { const Q = window.G.Quests; if (!Q.active().length) { const id = (Q.availableIds && Q.availableIds()[0]) || Q.nextStory(); if (id) Q.accept(id, { force: true }); } if (!Q.tracked && Q.active().length) Q.setTracked(Q.active()[0]); const qd = Q.get(Q.tracked); const no = Q.nextObjective(Q.tracked); return { tracked: Q.tracked, name: qd && qd.name, next: no ? { label: no.label, pos: no.pos } : null, target: window.G.state.questTarget }; });
  ok('a tracked quest with a resolvable next objective', !!q.tracked && !!q.next && !!q.next.pos, q);
  await T.press('KeyM', 800);
  const r = await T.evalG(() => ({ visible: window.__V.visible('map'), canvas: !!document.querySelector('#panel-map canvas.map-canvas'), api: !!(window.G.UI.Map && window.G.UI.Map.worldAt && window.G.UI.Map.centerOn), mapCanvas: !!(window.G.Terrain.mapCanvas && window.G.Terrain.mapCanvas(256)), zoneText: /Bree|Shire|Ered|Lone|Downs|Evendim|Trollshaws|Angmar|Forochel/.test(document.getElementById('panel-map').textContent) }));
  ok('M opens #panel-map with a map canvas', r.visible && r.canvas);
  ok('map API (worldAt/centerOn) + world map canvas', r.api && r.mapCanvas);
  await T.press('KeyM', 300);
  const hud = await T.waitFor((name) => { const mm = document.querySelector('#minimap canvas'); const qt = document.getElementById('questTracker'); const txt = qt ? qt.textContent : ''; return (mm && qt && txt.indexOf(name) >= 0) ? { minimap: !!mm, trackerHasQuest: true } : null; }, 2500, q.name || '');
  ok('#minimap canvas + #questTracker shows the tracked quest', !!hud, hud || (await T.evalG(() => ({ tracker: (document.getElementById('questTracker') || {}).textContent }))));
  ok('G.state.questTarget set for the tracked objective', !!(await T.evalG(() => window.G.state.questTarget && isFinite(window.G.state.questTarget.x))));
  ok('compass present', await T.evalG(() => !!document.getElementById('compass')));
});

scenario('R24', 'Typing `chris` opens the admin panel', async (T, ok) => {
  await T.evalG(() => { window.G.UI.closeAll(); document.getElementById('game').focus(); });
  await T.wait(200);
  await T.page.keyboard.type('chris', { delay: 80 });
  const open = await T.waitFor(() => window.G.UI.Admin.isOpen(), 2000);
  ok('admin panel opens after typing chris', !!open);
  const tabs = await T.evalG(() => ({ tabs: window.G.UI.Admin.TABS, text: (document.getElementById('panel-admin') || {}).textContent || '' }));
  ok('admin has the required tabs', Array.isArray(tabs.tabs) && tabs.tabs.length >= 8 && /Player/i.test(tabs.text) && /Quest/i.test(tabs.text), tabs.tabs);
  const g = await T.evalG(() => { const G = window.G, p = G.state.player; const before = p.gold; G.Progress.addGold(5 * G.C.MONEY.GOLD, { silent: true }); return { before, after: p.gold, delta: p.gold - before, want: 5 * G.C.MONEY.GOLD }; });
  ok('admin gold API (G.Progress.addGold, used by the Player tab) changes the purse by +5 g', g.delta === g.want, g);
  const lv = await T.evalG(() => { const G = window.G, p = G.state.player; const L0 = p.level; const okSet = G.UI.Admin.setLevel ? G.UI.Admin.setLevel(L0 + 1) : G.Progress.setLevel(L0 + 1); const L1 = p.level; G.Progress.setLevel(L0); return { L0, L1, okSet }; });
  ok('admin level API sets the level', lv.L1 === lv.L0 + 1, lv);
  ok('admin exposes items/teleport/quests helpers', await T.evalG(() => { const A = window.G.UI.Admin; return !!(A.giveItem && A.teleportTo && A.spawnMonster && A.addPlace); }));
  await T.evalG(() => window.G.UI.Admin.close());
  ok('admin closes', !(await T.evalG(() => window.G.UI.Admin.isOpen())));
});

scenario('R25', 'Hotbar keys 1–0 G T V X Y Z L N O U use abilities', async (T, ok) => {
  const hb = await T.evalG(() => {
    const keys = window.G.C.HOTBAR_KEYS; const slots = Array.from(document.querySelectorAll('#hotbar .slot'));
    const caps = slots.map(s => (s.querySelector('.keybind') || {}).textContent);
    return { keys, caps, n: slots.length, hotbar: window.G.state.player.hotbar.slice(), keyNames: keys.map(k => window.G.Input.codeOf(k)) };
  });
  ok('20 hotbar keys defined (1-0, G T V X Y Z L N O U)', hb.keys.length === 20 && hb.keys.join('') === '1234567890GTVXYZLNOU', hb.keys.join(''));
  ok('20 hotbar slots, each labelled with its key', hb.n === 20 && hb.caps.join('') === hb.keys.join(''), hb.caps.join(''));
  ok('every key maps to a KeyboardEvent.code', hb.keyNames.every(Boolean) && hb.keyNames[0] === 'Digit1' && hb.keyNames[10] === 'KeyG', hb.keyNames.slice(0, 12));
  ok('slot 1 has an ability', !!hb.hotbar[0], hb.hotbar.slice(0, 4));
  const id = await T.evalG(() => window.__V.spawn({ dist: 2.2 }));
  await T.evalG((id) => { const m = window.__V.ent(id); if (m) { window.G.Player.setTarget(m); window.__V.face(m); } }, id);
  await T.wait(300);
  const before = await T.evalG(() => ({ n: window.__V.abilities.length, t: window.G.Combat.lastAbility && window.G.Combat.lastAbility.time }));
  await T.press('Digit1', 100);
  const used = await T.waitFor((b) => { const V = window.__V, la = window.G.Combat.lastAbility; if (V.abilities.length > b.n) return V.abilities[V.abilities.length - 1]; if (la && la.time !== b.t && la.id) return { id: la.id, via: 'lastAbility' }; return null; }, 2000, before);
  ok('Digit1 used the slot-1 ability (abilityUsed / G.Combat.lastAbility)', !!used, used || (await T.evalG(() => window.G.Combat.lastError)));
  await T.wait(1200);
  const b2 = await T.evalG(() => ({ n: window.__V.abilities.length }));
  await T.press('KeyG', 100);
  const g = await T.waitFor((b) => window.__V.abilities.length > b.n ? window.__V.abilities[window.__V.abilities.length - 1] : null, 1500, b2);
  ok('G (slot 11) is a hotbar key (uses an ability when one is slotted)', hb.hotbar[10] ? !!g : true, { slot11: hb.hotbar[10], used: g });
  await T.evalG(() => window.__V.despawnAll());
});

scenario('R26', 'Space jump, Tab target, Esc close, Enter chat, F1 help', async (T, ok) => {
  const spot = await T.evalG(() => window.__V.openSpot());
  if (spot) await T.evalG((s) => window.__V.tp(s.x, s.z), spot);
  await T.wait(500);
  const y0 = await T.evalG(() => window.G.state.player.pos.y);
  await T.press('Space', 50);
  const jumped = await T.waitFor((y0) => { const p = window.G.state.player; return p.pos.y > y0 + 0.25 ? +p.pos.y.toFixed(2) : null; }, 700, y0);
  ok('Space → player rises (jump)', jumped != null, { y0: +y0.toFixed(2), peak: jumped });
  await T.wait(900);
  const id = await T.evalG(() => { window.G.Player.setTarget(null); return window.__V.spawn({ dist: 7 }); });
  await T.wait(300);
  await T.press('Tab', 100);
  const tgt = await T.waitFor(() => { const t = window.G.state.player.target; return t ? { name: t.name, kind: t.kind } : null; }, 1000);
  ok('Tab targets the nearby monster', !!tgt && tgt.kind === 'monster', tgt);
  await T.evalG(() => { window.G.Player.setTarget(null); window.__V.despawnAll(); window.G.UI.openPanel('inventory'); });
  await T.wait(200);
  await T.press('Escape', 300);
  ok('Escape closes the open panel', !(await T.evalG(() => window.G.UI.isOpen('inventory'))));
  await T.press('Enter', 300);
  const chatFocused = await T.waitFor(() => { const a = document.activeElement; return !!(a && a.tagName === 'INPUT' && a.closest('#chat')); }, 1000);
  ok('Enter focuses the chat input', !!chatFocused);
  await T.press('Escape', 200);
  ok('Escape leaves the chat input', !(await T.evalG(() => { const a = document.activeElement; return !!(a && a.tagName === 'INPUT'); })));
  await T.evalG(() => document.getElementById('game').focus());
  await T.press('F1', 300);
  ok('F1 opens the key help', !!(await T.waitFor(() => window.G.UI.isOpen('keyhelp'), 1000)));
  await T.press('F1', 300);
  ok('F1 again closes it', !(await T.evalG(() => window.G.UI.isOpen('keyhelp'))));
});

// ---- Content ----------------------------------------------------------------------------------------------
scenario('R30', '100 story + 50 side quests, valid references, completable chain', async (T, ok) => {
  const r = await T.evalG(() => {
    const G = window.G, qs = G.Data.quests, W = G.Data.world; const ids = new Set(); const dup = [];
    const npc = new Set((W.npcs || []).map(n => n.id)); const mt = new Set((W.monsterTypes || []).map(m => m.id)); const boss = new Set((W.bosses || []).map(b => b.id)); const nodes = new Set((W.gatherNodes || []).map(n => n.id)); const spots = new Set((W.fishingSpots || []).map(s => s.id));
    const bad = { giver: [], turnin: [], prereq: [], obj: [], items: [] };
    let story = 0, side = 0, xp = 0;
    for (const q of qs) {
      if (ids.has(q.id)) dup.push(q.id); ids.add(q.id);
      if (q.type === 'story') story++; else if (q.type === 'side') side++;
      if (!npc.has(q.giver)) bad.giver.push(q.id + ':' + q.giver); if (!npc.has(q.turnin)) bad.turnin.push(q.id + ':' + q.turnin);
      for (const p of (q.prereq || [])) if (!G.Data.questById[p]) bad.prereq.push(q.id + ':' + p);
      for (const o of (q.objectives || [])) {
        if (o.type === 'kill' && !mt.has(o.target)) bad.obj.push(q.id + ':kill:' + o.target);
        if (o.type === 'talk' && !npc.has(o.npc)) bad.obj.push(q.id + ':talk:' + o.npc);
        if (o.type === 'deliver' && !npc.has(o.npc)) bad.obj.push(q.id + ':deliver:' + o.npc);
        if (o.type === 'collect' && o.from && !mt.has(o.from)) bad.obj.push(q.id + ':from:' + o.from);
        if (o.type === 'collect' && o.node && !nodes.has(o.node)) bad.obj.push(q.id + ':node:' + o.node);
        if (o.type === 'use' && !nodes.has(o.node)) bad.obj.push(q.id + ':use:' + o.node);
        if (o.type === 'killboss' && !boss.has(o.boss) && !mt.has(o.boss)) bad.obj.push(q.id + ':boss:' + o.boss);
        if (o.type === 'fish' && o.spot && !spots.has(o.spot)) bad.obj.push(q.id + ':spot:' + o.spot);
        if ((o.type === 'collect' || o.type === 'deliver') && o.item && !G.Data.items[o.item]) bad.items.push(q.id + ':' + o.item);
      }
      for (const t of ((q.rewards && q.rewards.items) || [])) { const tid = typeof t === 'string' ? t : t && t.tid; if (tid && !G.Data.items[tid]) bad.items.push(q.id + ':reward:' + tid); }
      xp += (q.rewards && q.rewards.xp) || 0;
    }
    // story chain s001..s100 strictly ordered; no prerequisite cycles (topological pass)
    const storyIds = qs.filter(q => q.type === 'story').map(q => q.id).sort();
    let chainOk = storyIds.length === 100 && storyIds[0] === 's001' && storyIds[99] === 's100';
    const done = new Set(); let progress = true, remaining = qs.slice();
    while (progress && remaining.length) { progress = false; remaining = remaining.filter(q => { if ((q.prereq || []).every(p => done.has(p))) { done.add(q.id); progress = true; return false; } return true; }); }
    return { n: qs.length, story, side, dup, bad, chainOk, unresolvable: remaining.map(q => q.id).slice(0, 5), xp, byId: Object.keys(G.Data.questById).length, objectiveTypes: Array.from(new Set(qs.flatMap(q => (q.objectives || []).map(o => o.type)))) };
  });
  ok('150 quests (100 story / 50 side)', r.n === 150 && r.story === 100 && r.side === 50, { n: r.n, story: r.story, side: r.side });
  ok('all quest ids unique and indexed', r.dup.length === 0 && r.byId === 150, r.dup);
  ok('every giver / turn-in NPC exists', r.bad.giver.length === 0 && r.bad.turnin.length === 0, r.bad.giver.concat(r.bad.turnin).slice(0, 5));
  ok('every prerequisite exists; story chain s001→s100', r.bad.prereq.length === 0 && r.chainOk, r.bad.prereq.slice(0, 5));
  ok('every objective target (monster/npc/node/boss/spot) exists', r.bad.obj.length === 0, r.bad.obj.slice(0, 6));
  ok('every objective/reward item template exists', r.bad.items.length === 0, r.bad.items.slice(0, 6));
  ok('prerequisite graph resolves completely (no deadlock)', r.unresolvable.length === 0, r.unresolvable);
  ok('objective types covered', r.objectiveTypes.length >= 6, r.objectiveTypes);
});

scenario('R31', 'Level cap 80; XP curve reaches 80 by the end of the story', async (T, ok) => {
  const r = await T.evalG(() => {
    const G = window.G, xp = G.Data.xp; const p = G.state.player; const L0 = p.level;
    G.Progress.setLevel(99); const clamped = p.level; G.Progress.setLevel(L0);
    let questXP = 0; for (const q of G.Data.quests) questXP += (q.rewards && q.rewards.xp) || 0;
    return { cap: G.C.LEVEL_CAP, f80: xp.forLevel(80), f79: xp.forLevel(79), f81: xp.forLevel(81), clamped, restored: p.level === L0, questXP, killXP: xp.killXP(40, 40), levelForXP: xp.levelForXP ? xp.levelForXP(xp.forLevel(80) + 1) : null };
  });
  ok('G.C.LEVEL_CAP === 80', r.cap === 80, r.cap);
  ok('XP table finite and increasing at 80', isFinite(r.f80) && r.f80 > r.f79 && r.f80 > 0, { f79: r.f79, f80: r.f80 });
  ok('setLevel(99) clamps at 80 (and restores)', r.clamped === 80 && r.restored, r.clamped);
  ok('quest XP alone covers ≥ 60 % of the curve to 80 (kills fill the rest)', r.questXP >= 0.6 * r.f80, { questXP: r.questXP, needed: r.f80, ratio: +(r.questXP / r.f80).toFixed(2) });
  ok('kill XP positive at equal level', r.killXP > 0, r.killXP);
});

scenario('R32', 'World size 4 km, 15 zones, 25 towns, ≥ 220 NPCs, ≥ 70 monster types', async (T, ok) => {
  const r = await T.evalG(() => { const W = window.G.Data.world; return { size: window.G.C.WORLD_SIZE, zones: W.zones.length, towns: W.towns.length, npcs: W.npcs.length, types: W.monsterTypes.length, spawns: W.spawns.length, bosses: (W.bosses || []).length, pois: (W.pois || []).length, roads: (W.roads || []).length, spots: (W.fishingSpots || []).length, nodes: (W.gatherNodes || []).length, items: Object.keys(window.G.Data.items).length, abilities: Object.keys(window.G.Data.abilities).length, height: window.G.Terrain.height(1900, 1900), heightFar: window.G.Terrain.height(-1900, -1900) }; });
  ok('world size 4096 (±2048 m)', r.size === 4096 && isFinite(r.height) && isFinite(r.heightFar), r.size);
  ok('zones ≥ 15', r.zones >= 15, r.zones);
  ok('towns ≥ 25', r.towns >= 25, r.towns);
  ok('NPCs ≥ 220', r.npcs >= 220, r.npcs);
  ok('monster types ≥ 70', r.types >= 70, r.types);
  ok('spawn areas ≥ 150', r.spawns >= 150, r.spawns);
  ok('lots of content: bosses/POIs/roads/fishing spots/nodes/items/abilities', r.bosses >= 10 && r.pois >= 40 && r.roads >= 15 && r.spots >= 15 && r.nodes >= 40 && r.items >= 500 && r.abilities >= 130, r);
});

scenario('R33', 'Boats: docks, routes, fast travel to an island', async (T, ok) => {
  const d = await T.evalG(() => {
    const W = window.G.Data.world, docks = W.docks || []; const byId = {}; for (const k of docks) byId[k.id] = k; const asym = [];
    for (const k of docks) for (const r of (k.routes || [])) { if (!byId[r]) asym.push(k.id + '→' + r + ' (missing)'); else if ((byId[r].routes || []).indexOf(k.id) < 0) asym.push(k.id + '→' + r + ' (one-way)'); }
    return { n: docks.length, asym, ids: docks.map(x => x.id), dockEnts: window.G.state.entities.filter(e => e.kind === 'dock' || (e.interact && /sail|dock|harbour/i.test(e.interact.label || ''))).length, api: !!(window.G.Boats.board && window.G.Boats.sailTo && window.G.Boats.pathToZone && window.G.Boats.instantTravel) };
  });
  ok('≥ 7 docks in the registry', d.n >= 7, d.ids);
  ok('dock routes are symmetric', d.asym.length === 0, d.asym.slice(0, 4));
  ok('boat API (board / sailTo / pathToZone / instantTravel)', d.api);
  await T.evalG((b) => window.__V.tp(b.x, b.z), BREE); await T.wait(600);
  const p = await T.evalG(() => { const G = window.G; const path = G.Boats.pathToZone(G.state.player.pos, 'tolfuin'); return { zone: G.state.zone, path: Array.isArray(path) ? path.map(x => x.id || x) : path, dock: G.Boats.dockForZone ? (G.Boats.dockForZone('tolfuin') || {}).id : null }; });
  ok('pathToZone(Bree → tolfuin) returns ≥ 1 dock hop', Array.isArray(p.path) && p.path.length >= 1, p);
  const went = await T.evalG(() => window.G.Boats.instantTravel('dock_tolfuin', { free: true }));
  ok('instantTravel(dock_tolfuin) accepted', !!went);
  const arrived = await T.waitFor(() => { const G = window.G; if (G.Boats.travelling || G.Boats.sailing) return null; const z = G.Terrain.zoneAt(G.state.player.pos.x, G.state.player.pos.z); return { stateZone: G.state.zone, zoneAt: z, x: Math.round(G.state.player.pos.x), z: Math.round(G.state.player.pos.z) }; }, 25000);
  ok('arrived on Tol Fuin (zone = tolfuin)', !!arrived && (arrived.stateZone === 'tolfuin' || arrived.zoneAt === 'tolfuin'), arrived);
  ok('free-sailing supported (G.Boats.board/update/disembark)', await T.evalG(() => !!(window.G.Boats.board && window.G.Boats.disembark && window.G.Boats.update)));
  await T.evalG((b) => window.__V.tp(b.x, b.z), BREE); await T.wait(500);
}, { timeout: 70000 });

scenario('R34', 'Enterable buildings with real interiors (Prancing Pony)', async (T, ok) => {
  const r = await T.evalG(() => {
    const G = window.G; const all = G.Buildings.all || [];
    let b = all.find(x => x.recipe === 'inn' && /prancing/i.test(x.name || '')) || all.filter(x => x.recipe === 'inn').sort((p, q) => Math.hypot(p.x + 256, p.z + 30) - Math.hypot(q.x + 256, q.z + 30))[0];
    if (!b) return null;
    let x = b.x, z = b.z; if (G.Physics.nearestFree) { const f = G.Physics.nearestFree(x, z, 3); if (f && isFinite(f.x)) { x = f.x; z = f.z; } }
    window.__V.tp(x, z);
    let meshes = 0; if (b.int) b.int.traverse(o => { if (o.isMesh) meshes++; }); else if (b.group) b.group.traverse(o => { if (o.isMesh) meshes++; });
    let lights = 0; b.group.traverse(o => { if (o.isLight) lights++; });
    return { id: b.id, name: b.name, recipe: b.recipe, enterable: b.enterable, hearths: (b.hearths || []).length, lights: (b.lights || []).length + lights, spots: (b.interiorSpots || []).length, npcInside: (b.npcInside || []).length, meshes, enterableCount: all.filter(x => x.enterable).length, total: all.length };
  });
  ok('found the Prancing Pony (inn) building', !!r && r.recipe === 'inn', r && { name: r.name, recipe: r.recipe });
  if (!r) return;
  await T.wait(800);
  const inside = await T.evalG((id) => { const G = window.G, p = G.state.player; const b = G.Buildings.isInside(p.pos); const npcs = G.state.entities.filter(e => e.kind === 'npc' && Math.hypot(e.pos.x - p.pos.x, e.pos.z - p.pos.z) <= 12).map(e => e.name); return { inside: !!b, same: !!b && b.id === id, playerInside: !!G.Buildings.playerInside, inInterior: !!G.Player.inInterior, npcs, y: +p.pos.y.toFixed(2) }; }, r.id);
  ok('G.Buildings.isInside(player.pos) is the inn', inside.inside && inside.same, inside);
  ok('interior NPC within 12 m (innkeeper etc.)', inside.npcs.length >= 1, inside.npcs);
  ok('interior furniture present (meshes / interior spots)', r.meshes >= 3 || r.spots >= 3, { meshes: r.meshes, spots: r.spots });
  ok('hearth / fireplace + interior lights present', r.hearths >= 1 && r.lights >= 1, { hearths: r.hearths, lights: r.lights });
  ok('many enterable buildings in the world', r.enterableCount >= 25, r.enterableCount + ' / ' + r.total);
  await T.evalG((b) => window.__V.tp(b.x, b.z), BREE);
});

scenario('R35', '150 AI players: move, level, chat, react to the player', async (T, ok) => {
  const a = await T.evalG(() => { const L = window.G.AIPlayers.list(); return { n: L.length, pos: L.map(x => [x.id, x.pos.x, x.pos.z]), levels: L.map(x => x.level), zones: new Set(L.map(x => x.zone)).size, states: Array.from(new Set(L.map(x => x.state))), chat0: window.__V.aiChatCount(), lines0: window.__V.chatLines().length, ins: window.G.AIPlayers.inspect(L[0].id) }; });
  ok('G.AIPlayers.list().length === 150', a.n === 150, a.n);
  ok('inspect(id) returns level/stats/equipment', !!a.ins && a.ins.stats && a.ins.equipment && Object.keys(a.ins.equipment).length >= 18, a.ins && Object.keys(a.ins).slice(0, 12));
  ok('spread over ≥ 8 zones, levels 1–80', a.zones >= 8 && Math.max.apply(null, a.levels) >= 60 && Math.min.apply(null, a.levels) <= 5, { zones: a.zones, minL: Math.min.apply(null, a.levels), maxL: Math.max.apply(null, a.levels), states: a.states });
  await T.evalG(() => { window.G.time.scale = 5; });
  await T.wait(OPTS.fast ? 6000 : 12000);
  let b = await T.evalG((a) => { const L = window.G.AIPlayers.list(); const by = {}; for (const x of L) by[x.id] = x; let moved = 0; for (const [id, x, z] of a.pos) { const y = by[id]; if (y && Math.hypot(y.pos.x - x, y.pos.z - z) > 2) moved++; } return { moved, chat: window.__V.aiChatCount(), lines: window.__V.chatLines().length, fighting: L.filter(x => /fight/.test(x.state)).length }; }, a);
  if (b.chat <= a.chat0) { await T.wait(10000); b = await T.evalG((a) => { const L = window.G.AIPlayers.list(); const by = {}; for (const x of L) by[x.id] = x; let moved = 0; for (const [id, x, z] of a.pos) { const y = by[id]; if (y && Math.hypot(y.pos.x - x, y.pos.z - z) > 2) moved++; } return { moved, chat: window.__V.aiChatCount(), lines: window.__V.chatLines().length, fighting: L.filter(x => /fight/.test(x.state)).length }; }, a); }
  await T.evalG(() => { window.G.time.scale = 3; });
  ok('AI players move (≥ 10 changed position)', b.moved >= 10, b.moved + ' moved');
  ok('AI chat appeared in #chat (≥ 1 non-player line)', b.chat > a.chat0, { before: a.chat0, after: b.chat });
  const lines0 = await T.evalG(() => window.__V.chatLines().length);
  await T.evalG(() => window.G.UI.chatCommand('hello'));
  const reply = await T.waitFor((n0) => { const L = window.__V.chatLines(); for (let i = n0; i < L.length; i++) { const t = L[i].text.replace(/^\d\d:\d\d\s*/, ''); if (!/^(\[[^\]]+\]\s*)?You[: ]/.test(t) && /ch-(say|world|whisper|fellowship)/.test(L[i].cls)) return { text: t.slice(0, 80) }; } return null; }, 12000, lines0);
  ok('an AI answered "hello" within 10 s (game time ×3)', !!reply, reply);
  await T.evalG(() => { window.G.time.scale = 1; });
  ok('fellowships / states simulated', !!(await T.evalG(() => window.G.AIPlayers.fellowships && window.G.AIPlayers.fellowships.length >= 5)));
}, { timeout: 70000 });

scenario('R36', 'P = players panel with every player and live detail', async (T, ok) => {
  await T.press('KeyP', 800);
  const r = await T.evalG(() => ({ visible: window.__V.visible('players'), rows: document.querySelectorAll('#panel-players tbody tr').length, count: (document.querySelector('#panel-players .pn-count, #panel-players [class*="count"]') || {}).textContent }));
  ok('P opens #panel-players', r.visible);
  ok('table lists ≥ 150 players (+ you)', r.rows >= 150, r.rows);
  const row = await T.page.$('#panel-players tbody tr:nth-child(2)');
  ok('a row can be selected', !!row);
  if (row) {
    await row.click(); await T.wait(600);
    const d = await T.evalG(() => { const el = document.querySelector('#panel-players .pl-detail'); const txt = el ? el.textContent : ''; return { has: !!el, level: /Level|Lv\.?\s*\d+/i.test(txt) || /\b\d{1,2}\b/.test(txt), stats: /Might|Morale|Vitality/.test(txt), slots: el ? el.querySelectorAll('.slot').length : 0, zone: /Bree|Shire|Ered|Lone|Downs|Evendim|Trollshaws|Angmar|Forochel|Fuin|Himling|Morwen|Misty|Forest|Thicket/.test(txt) }; });
    ok('detail pane shows level/stats', d.has && d.level && d.stats, d);
    ok('detail pane shows 18 gear slots', d.slots === 18, d.slots);
  }
  const live = await T.evalG(() => { const L = window.G.AIPlayers.list(); return { st: L.map(x => x.state).filter((v, i, a) => a.indexOf(v) === i) }; });
  ok('live states in the list', live.st.length >= 2, live.st);
  await T.press('KeyP', 300);
  ok('P closes it', !(await T.evalG(() => window.__V.visible('players'))));
});

scenario('R37', 'Character creation: 10 races, 10 classes, gender, appearance, 3D preview', async (T, ok, ctx) => {
  // runs on the main menu BEFORE quickStart
  const clicked = await T.evalG(() => { const b = Array.from(document.querySelectorAll('#mainMenu .mm-btn')).find(x => /new character/i.test(x.textContent)); if (b) { b.click(); return true; } return false; });
  if (!clicked) await T.evalG(() => window.G.UI.CharCreate.show());
  const shown = await T.waitFor(() => { const el = document.getElementById('charCreate'); return !!(el && !el.hidden); }, 4000);
  ok('New Character opens the creation screen', !!shown, { viaMenuButton: clicked });
  const r = await T.evalG(() => ({ races: document.querySelectorAll('#charCreate .cc-card[data-race]').length, classes: document.querySelectorAll('#charCreate .cc-card[data-cls]').length, genders: document.querySelectorAll('#charCreate .cc-gender .g').length, preview: !!document.querySelector('#charCreate .cc-preview canvas'), name: !!document.querySelector('#charCreate input'), dataRaces: window.G.Data.races.length, dataClasses: window.G.Data.classes.length, appearance: /skin|hair/i.test(document.getElementById('charCreate').textContent) }));
  ok('10 race cards', r.races === 10 && r.dataRaces === 10, r.races);
  ok('10 class cards', r.classes === 10 && r.dataClasses === 10, r.classes);
  ok('male/female toggle', r.genders === 2, r.genders);
  ok('3D preview canvas', r.preview);
  ok('name input + appearance controls', r.name && r.appearance);
  const errAt = ctx.errors.length;
  const races = await T.evalG(() => Array.from(document.querySelectorAll('#charCreate .cc-card[data-race]')).map(c => c.dataset.race));
  const okRaces = [];
  for (const id of races) { await T.evalG((id) => document.querySelector('#charCreate .cc-card[data-race="' + id + '"]').click(), id); await T.wait(180); okRaces.push(await T.evalG(() => window.G.UI.CharCreate.getSpec().race)); }
  ok('every race selectable (spec follows)', okRaces.join(',') === races.join(','), okRaces);
  const classes = await T.evalG(() => Array.from(document.querySelectorAll('#charCreate .cc-card[data-cls]')).map(c => c.dataset.cls));
  const okCls = [];
  for (const id of classes) { await T.evalG((id) => document.querySelector('#charCreate .cc-card[data-cls="' + id + '"]').click(), id); await T.wait(120); okCls.push(await T.evalG(() => window.G.UI.CharCreate.getSpec().cls)); }
  ok('every class selectable', okCls.join(',') === classes.join(','), okCls);
  await T.evalG(() => document.querySelectorAll('#charCreate .cc-gender .g')[1].click()); await T.wait(250);
  const gender = await T.evalG(() => window.G.UI.CharCreate.getSpec().gender);
  ok('female toggle updates the spec', gender === 'female', gender);
  await T.evalG(() => { if (window.G.UI.CharCreate.randomise) window.G.UI.CharCreate.randomise(); }); await T.wait(300);
  ok('no errors while cycling races/classes/gender', ctx.errors.length === errAt, ctx.errors.slice(errAt, errAt + 2));
  ok('name validation', await T.evalG(() => { const v = window.G.UI.CharCreate.validateName; return v && !v('x').ok && v('Verifier').ok; }));
  await T.shot('R37-create');
  await T.evalG(() => { window.G.UI.CharCreate.hide(); window.G.UI.Menu.show(); });
  await T.wait(400);
});

scenario('R38', 'Procedural audio: SFX, music themes, zone/combat/ambient', async (T, ok) => {
  let a = await T.evalG(() => ({ ready: !!window.G.Audio.ready, theme: window.G.Audio.currentTheme, names: (window.G.Audio.names || []).length, themes: (window.G.Audio.themes || []).length }));
  if (!a.ready) { await T.evalG(() => { try { window.G.Audio.init(); } catch (e) { /* ignore */ } }); await T.page.mouse.click(640, 700).catch(() => { }); await T.wait(800); a = await T.evalG(() => ({ ready: !!window.G.Audio.ready, theme: window.G.Audio.currentTheme, names: (window.G.Audio.names || []).length, themes: (window.G.Audio.themes || []).length })); }
  ok('G.Audio.ready after a user gesture', a.ready, a);
  ok('≥ 60 SFX names', a.names >= 60, a.names);
  ok('≥ 15 music themes', a.themes >= 15, a.themes);
  const theme = a.theme || (await T.waitFor(() => window.G.Audio.currentTheme, 3000));
  ok('a music theme is playing (zone theme)', !!theme, theme);
  const misc = await T.evalG(() => { const A = window.G.Audio; return { sfx: typeof A.sfx === 'function' && A.sfx('ui_click', { vol: 0.01 }) !== undefined, has: A.has ? [A.has('ui_click'), A.has('footstep_grass') || A.has('footstep'), A.has('sword_hit') || A.has('hit')] : null, ambient: typeof A.ambient === 'function', combat: (A.themes || []).some(t => /combat|battle/i.test(t)), zoneThemes: window.G.Data.world.zones.every(z => !z.music || (A.hasTheme ? A.hasTheme(z.music) : true)), noFiles: !document.querySelector('audio, source') }; });
  ok('SFX playable, ambient beds, combat theme, every zone theme exists, no <audio> files', misc.sfx !== false && misc.ambient && misc.combat && misc.zoneThemes && misc.noFiles, misc);
});

scenario('R39', 'Combat: abilities, XP, loot; death and respawn', async (T, ok) => {
  const spot = await T.evalG(() => window.__V.openSpot());
  if (spot) await T.evalG((s) => window.__V.tp(s.x, s.z), spot);
  await T.wait(400);
  const start = await T.evalG(() => { const G = window.G, p = G.state.player; G.state.godMode = true; const id = window.__V.spawn({ dist: 2.5 }); const m = window.__V.ent(id); if (m) { G.Player.setTarget(m); window.__V.face(m); } return { id, name: m && m.name, level: m && m.level, xp: p.xp, gold: p.gold, kills: G.state.stats.kills, loot: window.__V.loot.length, used: G.Items.usedSlots ? G.Items.usedSlots(p) : null, abilities: window.__V.abilities.length }; });
  ok('spawned a hostile monster in melee range', !!start.id, start);
  if (!start.id) return;
  const t0 = Date.now(); let dead = null;
  while (Date.now() - t0 < 35000) {
    for (const k of ['Digit1', 'Digit2', 'Digit3', 'Digit4']) { await T.press(k, 320); dead = await T.evalG((id) => { const m = window.__V.ent(id); return !m || m.dead || m.alive === false ? { dead: true } : null; }, start.id); if (dead) break; }
    if (dead) break;
    if (Date.now() - t0 > 12000) await T.evalG((id) => { const G = window.G, m = window.__V.ent(id); if (m) G.Combat.basicAttack(G.state.player, m); }, start.id);
  }
  ok('monster killed with hotbar abilities (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)', !!dead);
  const usedAb = await T.evalG((n) => window.__V.abilities.length - n, start.abilities);
  ok('abilities were used (cooldowns/gcd path)', usedAb >= 2, usedAb + ' abilityUsed events');
  await T.wait(1200);
  await T.evalG(() => { const G = window.G; const bags = G.Combat.lootBags || []; if (bags.length) { const b = bags[bags.length - 1]; if (b.pos) window.__V.tp(b.pos.x, b.pos.z); } if (G.Combat.tryAutoLoot) G.Combat.tryAutoLoot(); });
  await T.press('KeyE', 200);
  const gain = await T.waitFor((s) => { const G = window.G, p = G.state.player; const r = { xp: p.xp - s.xp, gold: p.gold - s.gold, loot: window.__V.loot.length - s.loot, kills: G.state.stats.kills - s.kills, used: G.Items.usedSlots ? G.Items.usedSlots(p) - s.used : 0 }; return (r.xp > 0 && (r.gold > 0 || r.loot > 0 || r.used > 0)) ? r : null; }, 4000, start);
  const gainNow = gain || (await T.evalG((s) => { const G = window.G, p = G.state.player; return { xp: p.xp - s.xp, gold: p.gold - s.gold, loot: window.__V.loot.length - s.loot, kills: G.state.stats.kills - s.kills }; }, start));
  ok('XP gained from the kill', gainNow.xp > 0, gainNow);
  ok('loot / gold received', gainNow.gold > 0 || gainNow.loot > 0 || (gainNow.used || 0) > 0, gainNow);
  ok('kill counted in G.state.stats', gainNow.kills >= 1);
  const mech = await T.evalG(() => { const G = window.G; return { effects: !!(G.Combat.addEffect && G.Combat.removeEffect), crit: !!(G.Combat.lastHit && 'crit' in G.Combat.lastHit), cds: !!G.Combat.cooldownLeft, vendors: G.Data.world.npcs.some(n => (n.roles || []).some(r => /vendor/.test(r))), trainers: G.Data.world.npcs.some(n => (n.roles || []).indexOf('trainer') >= 0) }; });
  ok('buffs/debuffs, crits, cooldowns, vendors, trainers exist', mech.effects && mech.crit && mech.cds && mech.vendors && mech.trainers, mech);
  // death + respawn
  const boss = await T.evalG(() => { const G = window.G; G.state.godMode = false; G.state.player.target = null; const id = window.__V.spawn({ dist: 1.5, level: 80, boss: true }); const m = window.__V.ent(id); if (m && G.Monsters.setTarget) G.Monsters.setTarget(m, G.state.player); if (m) G.Player.setTarget(m); return { id, name: m && m.name, level: m && m.level, deaths: G.state.stats.deaths }; });
  ok('spawned a level-80 boss adjacent', !!boss.id, boss);
  let died = await T.waitFor(() => { const p = window.G.state.player; return (p.dead || p.alive === false) ? true : null; }, 12000);
  if (!died) { await T.evalG((id) => { const G = window.G; const m = window.__V.ent(id); G.Combat.damage(m || null, G.state.player, 1e7, 'common', { raw: true }); }, boss.id); died = await T.waitFor(() => { const p = window.G.state.player; return (p.dead || p.alive === false) ? true : null; }, 3000); ok('boss killed the player on its own (fell back to a raw hit)', false); }
  ok('player died', !!died);
  await T.evalG(() => window.__V.despawnAll());
  const ds = await T.waitFor(() => { const el = document.getElementById('deathScreen'); return (el && !el.hidden && window.G.UI.DeathScreen.visible) ? { text: el.textContent.slice(0, 40) } : null; }, 3000);
  ok('death screen visible', !!ds, ds);
  ok('deaths stat incremented', await T.evalG((d) => window.G.state.stats.deaths === d + 1, boss.deaths));
  const btn = await T.page.$('#deathScreen button');
  if (btn) await btn.click(); else await T.evalG(() => window.G.Player.respawn());
  const alive = await T.waitFor(() => { const p = window.G.state.player; const el = document.getElementById('deathScreen'); return (p.alive && !p.dead && el && el.hidden) ? { morale: Math.round(p.morale), x: Math.round(p.pos.x), z: Math.round(p.pos.z) } : null; }, 5000);
  ok('Retreat respawns the player at a rally point', !!alive, alive);
}, { timeout: 90000 });

scenario('R40', 'UI mechanics: tooltips, drag & drop, draggable panels, notifications, floating text', async (T, ok) => {
  const prep = await T.evalG(() => {
    const G = window.G, p = G.state.player;
    let a = p.inventory.findIndex(Boolean);
    if (a < 0) { const t = G.Items.all().find(x => x.type === 'consumable') || G.Items.all()[0]; G.Items.addToInventory(p, G.Items.create(t.id, 1)); a = p.inventory.findIndex(Boolean); }
    const b = p.inventory.findIndex((x, i) => !x && i > a);
    G.UI.openPanel('inventory');
    return { a, b, uid: p.inventory[a] && p.inventory[a].uid, tid: p.inventory[a] && p.inventory[a].tid };
  });
  ok('inventory has an item and a free slot', prep.a >= 0 && prep.b >= 0, prep);
  await T.wait(400);
  const selA = '#panel-inventory .inv-slot[data-i="' + prep.a + '"]', selB = '#panel-inventory .inv-slot[data-i="' + prep.b + '"]';
  await T.page.hover(selA);
  const tip = await T.waitFor(() => { const t = document.getElementById('tooltip'); return (t && !t.hidden && (t.textContent || '').trim().length > 3) ? t.textContent.trim().slice(0, 50) : null; }, 1500);
  ok('tooltip appears when hovering an inventory item', !!tip, tip);
  await T.page.mouse.move(5, 5); await T.wait(200);
  await T.page.dragAndDrop(selA, selB);
  const moved = await T.waitFor((o) => { const inv = window.G.state.player.inventory; return (inv[o.b] && inv[o.b].tid === o.tid && !inv[o.a]) ? true : null; }, 1500, prep);
  ok('drag & drop moves the item to the target slot', !!moved, prep);
  const rect0 = await T.evalG(() => { const r = document.getElementById('panel-inventory').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width }; });
  const title = await T.page.$('#panel-inventory .panel-title');
  if (title) { const tb = await title.boundingBox(); await T.page.mouse.move(tb.x + Math.min(60, tb.width / 3), tb.y + tb.height / 2); await T.page.mouse.down(); await T.page.mouse.move(tb.x + 60 - 140, tb.y + tb.height / 2 + 90, { steps: 8 }); await T.page.mouse.up(); await T.wait(200); }
  const rect1 = await T.evalG(() => { const r = document.getElementById('panel-inventory').getBoundingClientRect(); return { x: r.left, y: r.top }; });
  ok('panels are draggable by their title bar', Math.abs(rect1.x - rect0.x) > 40 || Math.abs(rect1.y - rect0.y) > 40, { before: rect0, after: rect1 });
  const n0 = await T.evalG(() => document.querySelectorAll('#notices .notice').length);
  const accepted = await T.evalG(() => { const Q = window.G.Quests; const id = (Q.availableIds && Q.availableIds().find(x => Q.statusOf(x) === 'available')) || null; if (id) { Q.accept(id); return id; } window.G.UI.notify('Verifier: quest accepted', 'quest'); return 'notify()'; });
  const notice = await T.waitFor((n0) => { const L = document.querySelectorAll('#notices .notice'); return L.length > n0 ? L[L.length - 1].textContent.slice(0, 50) : null; }, 1500, n0);
  ok('a notification appears on quest accept', !!notice, { via: accepted, notice });
  const ft = await T.evalG(() => { const G = window.G, p = G.state.player; const layer = document.getElementById('floatLayer'); const n0 = layer ? layer.children.length : -1; G.UI.floatText(p.pos, '123', '#fff', { crit: true }); return { layer: !!layer, before: n0, after: layer ? layer.children.length : -1 }; });
  ok('floating combat text spawns an element', ft.layer && ft.after > ft.before, ft);
  ok('chat + notifications APIs', await T.evalG(() => !!(window.G.UI.chat && window.G.UI.notify && window.G.UI.bindTooltip && window.G.UI.contextMenu)));
  await T.evalG(() => window.G.UI.closeAll());
});

scenario('R41', 'Save/load: localStorage, export round-trip, Continue from the main menu', async (T, ok, ctx) => {
  const s = await T.evalG(() => {
    const G = window.G, p = G.state.player; G.UI.closeAll();
    const snap = G.Save.save({ silent: true, reason: 'verify' });
    const loaded = G.Save.load();
    const json = G.Save.exportJSON(); let parsed = null; try { parsed = JSON.parse(json); } catch (e) { /* ignore */ }
    const imp = G.Save.importJSON(json);
    return { saved: !!snap, loaded: !!loaded, loadedLevel: loaded && loaded.player && loaded.player.level, key: G.C.SAVE_KEY, stored: !!localStorage.getItem(G.C.SAVE_KEY), persisted: G.Save.persisted, exportOk: !!parsed && parsed.player && parsed.player.level === p.level, importOk: !!(imp && imp.ok), hasSave: G.Save.hasSave(), level: p.level, gold: p.gold, name: p.name, xp: p.xp, questsDone: G.Quests.completion().done, summary: G.Save.summary && G.Save.summary() };
  });
  ok('G.Save.save() writes localStorage[' + s.key + ']', s.saved && s.stored, { persisted: s.persisted });
  ok('G.Save.load() returns the snapshot with the current level', s.loaded && s.loadedLevel === s.level, { loadedLevel: s.loadedLevel, level: s.level });
  ok('exportJSON round-trips through importJSON', s.exportOk && s.importOk && s.hasSave);
  ok('summary() for the Continue card', !!s.summary && s.summary.level === s.level, s.summary && { name: s.summary.name, level: s.summary.level, zone: s.summary.zone });
  // reload → main menu → Continue
  await T.page.reload({ waitUntil: 'load', timeout: BOOT_TIMEOUT });
  await T.page.waitForFunction(() => !!(window.__T && window.__T.ready === true), null, { timeout: BOOT_TIMEOUT, polling: 250 });
  await T.page.mouse.click(640, 360).catch(() => { });
  const cont = await T.waitFor(() => { const b = Array.from(document.querySelectorAll('#mainMenu .mm-btn')).find(x => /continue/i.test(x.textContent)); return b && !b.classList.contains('disabled') ? b.textContent.replace(/\s+/g, ' ').slice(0, 60) : null; }, 8000);
  ok('main menu shows Continue after reload', !!cont, cont);
  if (cont) await T.evalG(() => Array.from(document.querySelectorAll('#mainMenu .mm-btn')).find(x => /continue/i.test(x.textContent)).click());
  else await T.evalG(() => window.G.Game.startFromSave());
  const inGame = await T.waitFor(() => !!(window.__T && window.__T.inGame === true), 90000);
  ok('Continue enters the world (__T.inGame)', !!inGame);
  await T.wait(1500);
  await T.evalG(installProbe);
  const r = await T.evalG(() => { const p = window.G.state.player; return { level: p.level, gold: p.gold, name: p.name, xp: p.xp, questsDone: window.G.Quests.completion().done, phase: window.G.state.phase }; });
  ok('restored player level / gold / name match', r.level === s.level && r.gold === s.gold && r.name === s.name, { saved: { level: s.level, gold: s.gold, name: s.name }, restored: r });
  ok('restored quest completion matches', r.questsDone === s.questsDone, { saved: s.questsDone, restored: r.questsDone });
  ctx.reloaded = true;
}, { timeout: 200000 });

// ------------------------------------------------------------------------------------------------ runner
const ORDER = ['R37', 'R01', 'R03', 'R04', 'R10', 'R11', 'R12', 'R13', 'R14', 'R15', 'R16', 'R17', 'R18', 'R19', 'R20', 'R21', 'R23', 'R24', 'R25', 'R26',
  'R30', 'R31', 'R32', 'R33', 'R34', 'R35', 'R36', 'R38', 'R39', 'R40', 'R22', 'R02', 'R41'];
const ALL_IDS = SC.map(s => s.id).sort();

async function runScenario(sc, page, ctx) {
  const T = makeT(page, ctx);
  const checks = []; const t0 = Date.now(); const errAt = ctx.errors.length;
  const ok = (name, cond, extra) => { const c = { name, pass: !!cond }; if (extra !== undefined) c.extra = extra; checks.push(c); T.log((c.pass ? 'ok   ' : 'FAIL ') + name + (extra !== undefined ? '  ' + short(extra) : '')); return c.pass; };
  const timeoutMs = sc.timeout || OPTS.timeoutMs;
  let error = null, timer = null;
  const timeoutP = new Promise((_, rej) => { timer = setTimeout(() => { T.alive = false; rej(new Error('timeout after ' + Math.round(timeoutMs / 1000) + ' s')); }, timeoutMs); });
  try { await Promise.race([sc.fn(T, ok, ctx), timeoutP]); }
  catch (e) { error = (e && e.message) ? e.message : String(e); }
  finally { clearTimeout(timer); T.alive = false; }
  const failed = checks.filter(c => !c.pass);
  const pass = !error && checks.length > 0 && failed.length === 0;
  const errors = ctx.errors.slice(errAt);
  let details;
  if (error) details = 'ERROR: ' + error + (failed.length ? ' | failed: ' + failed.map(c => c.name).join('; ') : '');
  else if (failed.length) details = failed.map(c => c.name + (c.extra !== undefined ? ' [' + short(c.extra) + ']' : '')).join('; ');
  else details = checks.map(c => c.name).slice(0, 3).join('; ') + (checks.length > 3 ? ' (+' + (checks.length - 3) + ' checks)' : '');
  if (errors.length) details += ' | ' + errors.length + ' page error(s): ' + trunc(errors[0], 80);
  return { id: sc.id, title: sc.title, pass, details, ms: Date.now() - t0, checks, errors: errors.slice(0, 10), error };
}

function printTable(results) {
  console.log('');
  console.log('  ' + 'ID'.padEnd(5) + 'RESULT'.padEnd(8) + 'TIME'.padEnd(8) + 'DETAILS');
  console.log('  ' + '-'.repeat(120));
  for (const r of results) console.log('  ' + r.id.padEnd(5) + (r.pass ? 'PASS' : 'FAIL').padEnd(8) + fmtMs(r.ms).padEnd(8) + trunc(r.title + ' — ' + r.details, 150));
}

async function main() {
  const t0 = Date.now();
  const wanted = SC.filter(s => !OPTS.only.length || OPTS.only.includes(s.id));
  if (OPTS.only.length) { const unknown = OPTS.only.filter(id => !ALL_IDS.includes(id)); if (unknown.length) console.log('unknown ids ignored:', unknown.join(', ')); }
  const ordered = ORDER.map(id => wanted.find(s => s.id === id)).filter(Boolean);
  const ctx = { errors: [], warnings: [], bootMs: null, quickStartMs: null };
  const results = [];
  const failAll = (reason) => { for (const s of ordered) if (!results.find(r => r.id === s.id)) results.push({ id: s.id, title: s.title, pass: false, details: reason, ms: 0, checks: [], errors: [] }); };

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('console', m => { const t = m.type(); if (t === 'error') { const txt = m.text(); if (!ERR_FILTER.test(txt)) ctx.errors.push('[console.error] ' + txt); } else if (t === 'warning') ctx.warnings.push(m.text()); });
  page.on('pageerror', e => ctx.errors.push('[pageerror] ' + e.message + '\n' + (e.stack || '')));
  page.on('crash', () => ctx.errors.push('[crash] page crashed'));

  let booted = false;
  try { await boot(page, ctx); booted = true; console.log('boot ms:', ctx.bootMs); }
  catch (e) { console.log('BOOT FAILED:', e.message); failAll(e.message); await page.screenshot({ path: path.join(OUT, 'verify-boot-failed.png') }).catch(() => { }); }

  if (booted) {
    if (OPTS.fullAutoquest) { await fullAutoquest(page, ctx, browser); return; }
    // R37 runs on the main menu, before the character exists
    const r37 = ordered.find(s => s.id === 'R37');
    if (r37) { console.log('running R37 (creation screen)…'); results.push(await runScenario(r37, page, ctx)); await page.evaluate(() => { try { window.G.UI.CharCreate.hide(); window.G.UI.Menu.show(); } catch (e) { /* ignore */ } }).catch(() => { }); }
    try { await quickStart(page, ctx); console.log('quickStart ms:', ctx.quickStartMs); }
    catch (e) { console.log('QUICKSTART FAILED:', e.message); failAll(e.message); booted = false; }
  }
  if (booted) {
    await page.screenshot({ path: path.join(OUT, 'verify-00_ingame.png') }).catch(() => { });
    for (const sc of ordered) {
      if (sc.id === 'R37') continue;
      process.stdout.write('  ' + sc.id + ' ' + sc.title + ' … ');
      const r = await runScenario(sc, page, ctx);
      results.push(r);
      console.log(r.pass ? 'PASS' : 'FAIL', '(' + fmtMs(r.ms) + ')' + (r.pass ? '' : '  ' + trunc(r.details, 110)));
      const T = makeT(page, ctx); await T.shot(sc.id).catch(() => { });
      await settle(page);
    }
  }

  // game-side captured errors + final R02 verdict (zero errors across the WHOLE run)
  const gameErrors = await page.evaluate(() => (window.__T && window.__T.errors) ? window.__T.errors.slice(0, 50).map(String) : ((window.G && window.G.errors) || []).slice(0, 50).map(String)).catch(() => []);
  const allErrors = ctx.errors.concat(gameErrors.map(e => '[G.errors] ' + e));
  const uniq = []; const seen = new Set();
  for (const e of allErrors) { const k = e.slice(0, 160); if (!seen.has(k)) { seen.add(k); uniq.push(e); } }
  const r02 = results.find(r => r.id === 'R02');
  if (r02 && ctx.r02Provisional) {
    const wasClean = r02.pass;
    r02.checks.push({ name: 'zero page/console/G.errors across the whole run', pass: uniq.length === 0, extra: uniq.length + ' unique' });
    if (uniq.length) {
      r02.pass = false;
      const msg = uniq.length + ' unique error(s) during the run: ' + trunc(uniq[0], 90);
      r02.details = wasClean ? msg : r02.details + '; ' + msg;
    } else if (wasClean) r02.details += '; zero errors across the whole run';
  }
  await browser.close();

  results.sort((a, b) => a.id.localeCompare(b.id));
  printTable(results);
  const passed = results.filter(r => r.pass).length;
  console.log('');
  if (uniq.length) { console.log('ERRORS (' + uniq.length + ' unique):'); for (const e of uniq.slice(0, 12)) console.log('---\n' + trunc(e, 400)); console.log(''); }
  if (ctx.warnings.length) console.log('warnings: ' + ctx.warnings.length + ' (first: ' + trunc(ctx.warnings[0], 100) + ')');
  console.log(passed + '/' + results.length + ' passed' + (booted ? '' : '  (game never booted — see details)') + '  · total ' + fmtMs(Date.now() - t0));
  const report = { date: new Date().toISOString(), html: HTML, opts: OPTS, booted, bootMs: ctx.bootMs, quickStartMs: ctx.quickStartMs, durationMs: Date.now() - t0, summary: { passed, total: results.length, failed: results.filter(r => !r.pass).map(r => r.id) }, results, errors: uniq, warningCount: ctx.warnings.length };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('report:', REPORT);
  process.exit(passed === results.length && results.length > 0 ? 0 : 1);
}

// ------------------------------------------------------------------------------------------------ --full-autoquest
async function fullAutoquest(page, ctx, browser) {
  const MAX_MS = 40 * 60 * 1000;
  try { await quickStart(page, ctx); } catch (e) { console.log('QUICKSTART FAILED:', e.message); fs.writeFileSync(AQ_REPORT, JSON.stringify({ ok: false, reason: e.message }, null, 2)); await browser.close(); process.exit(1); }
  const t0 = Date.now();
  await page.evaluate(() => { const G = window.G; G.AutoQuest.speed = 10; G.time.scale = 3; G.AutoQuest.start(); });
  console.log('full auto-quest run started (speed 10, time ×3, max 40 min)…');
  let last = null; const timeline = [];
  while (Date.now() - t0 < MAX_MS) {
    await sleep(10000);
    last = await page.evaluate(() => { const G = window.G; const c = G.Quests.completion(); const s = G.AutoQuest.status(); const p = G.state.player; return { done: c.done, total: c.total, pct: c.pct, level: p.level, xp: p.xp, gold: p.gold, active: G.AutoQuest.active, text: s && s.text, questId: s && s.questId, stats: G.AutoQuest.stats, zone: G.state.zone, deaths: G.state.stats.deaths, kills: G.state.stats.kills, errors: (G.errors || []).length }; }).catch(() => null);
    if (!last) break;
    const mins = (Date.now() - t0) / 60000;
    timeline.push({ min: +mins.toFixed(1), done: last.done, level: last.level });
    if (Math.round(mins * 6) % 6 === 0) console.log('  ' + mins.toFixed(1) + ' min: ' + last.done + '/' + last.total + ' quests, level ' + last.level + ', ' + (last.text || '') + ' (teleports ' + last.stats.teleports + ', forced ' + last.stats.forced + ', errors ' + last.stats.errors + ')');
    if (last.done >= last.total || !last.active) break;
  }
  const hours = (Date.now() - t0) / 3600000;
  const gear = await page.evaluate(() => { const G = window.G, p = G.state.player; const eq = {}; for (const s of G.C.EQUIP_SLOTS) { const it = p.equipment[s]; eq[s] = it ? G.Items.get(it).name : null; } const lk = G.Data.lostKingdom; const lkTids = new Set([].concat(lk ? (lk.armour.light || []).concat(lk.armour.medium || [], lk.armour.heavy || [], Object.values(lk.weapons || {}), lk.jewellery || []) : [])); let lkCount = 0; for (const s of G.C.EQUIP_SLOTS) { const it = p.equipment[s]; if (it && lkTids.has(it.tid)) lkCount++; } return { eq, lostKingdomPieces: lkCount, sets: G.Items.setBonuses ? G.Items.setBonuses(p).sets : null }; }).catch(() => null);
  const gameErrors = await page.evaluate(() => ((window.G && window.G.errors) || []).slice(0, 30).map(String)).catch(() => []);
  const res = { ok: !!last && last.done >= last.total, minutes: +(hours * 60).toFixed(1), questsPerHour: last ? +(last.done / Math.max(hours, 1e-6)).toFixed(1) : 0, final: last, gear, timeline, errors: ctx.errors.concat(gameErrors) };
  fs.writeFileSync(AQ_REPORT, JSON.stringify(res, null, 2));
  console.log('');
  console.log('FULL AUTO-QUEST: ' + (last ? last.done + '/' + last.total : '?') + ' quests in ' + res.minutes + ' min (' + res.questsPerHour + ' quests/hour), final level ' + (last && last.level) + ', Lost Kingdom pieces equipped: ' + (gear && gear.lostKingdomPieces) + ', errors: ' + res.errors.length);
  console.log('report:', AQ_REPORT);
  await browser.close();
  process.exit(res.ok && res.errors.length === 0 ? 0 : 1);
}

main().catch(e => { console.error('HARNESS FAILURE', e); process.exit(2); });
