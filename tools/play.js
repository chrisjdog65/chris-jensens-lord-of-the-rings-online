#!/usr/bin/env node
/**
 * tools/play.js — drive the built game with a scenario and take screenshots at any point.
 *   node tools/play.js "await T.quick(); await T.press('KeyI'); await T.shot('inv');"
 * Exposes T.quick(opts), T.press, T.hold, T.shot(name), T.eval(fn), T.wait(ms), T.page.
 * Screenshots go to tools/out/<name>.png. Prints page errors at the end.
 */
const path = require('path');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
catch (e) { ({ chromium } = require('playwright')); }
const OUT = path.join(__dirname, 'out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const HTML = path.resolve(__dirname, '..', 'dist', 'Chris-Jensens-LOTRO.html');
const code = process.argv[2] || "await T.quick(); await T.wait(1000); await T.shot('play');";
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') { const txt = m.text(); if (!/fonts\.googleapis|fonts\.gstatic|Failed to load resource|net::ERR_/.test(txt)) errors.push('[console.error] ' + txt); } });
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message + '\n' + (e.stack || '')));
  await page.goto('file://' + HTML);
  await page.waitForFunction(() => window.__T && window.__T.ready, { timeout: 60000 });
  const T = {
    page,
    quick: async (opts) => { await page.evaluate((o) => window.__T.quickStart(o || {}), opts || null); await page.waitForFunction(() => window.__T.inGame, { timeout: 60000 }); await page.waitForTimeout(1000); },
    press: async (key, ms = 150) => { await page.keyboard.press(key); await page.waitForTimeout(ms); },
    hold: async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); },
    shot: async (name) => { const p = path.join(OUT, name + '.png'); await page.screenshot({ path: p }); console.log('shot:', p); },
    eval: (fn, ...a) => page.evaluate(fn, ...a),
    wait: (ms) => page.waitForTimeout(ms),
    log: (...a) => console.log(...a),
  };
  try { await (new (Object.getPrototypeOf(async function () { }).constructor)('T', 'page', code))(T, page); }
  catch (e) { console.error('SCENARIO ERROR', e); }
  const gameErrors = await page.evaluate(() => (window.__T && window.__T.errors) ? window.__T.errors.slice(0, 30) : []).catch(() => []);
  await browser.close();
  const all = errors.concat(gameErrors.map(e => '[G.errors] ' + e));
  if (all.length) { console.log('ERRORS (' + all.length + '):'); const seen = new Set(); for (const e of all) { const k = e.slice(0, 200); if (!seen.has(k)) { seen.add(k); console.log('---\n' + e); } } process.exit(1); }
  console.log('PLAY OK');
})().catch(e => { console.error('HARNESS FAILURE', e); process.exit(2); });
