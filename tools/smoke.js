#!/usr/bin/env node
/**
 * tools/smoke.js — headless integration test for the built single-file game.
 *
 *   node tools/smoke.js                 # boot, quick-start a character, run a scripted play session
 *   node tools/smoke.js --shots         # also save screenshots to tools/out/
 *   node tools/smoke.js --script my.js  # run a custom scenario (module exporting async (page, T) => {})
 *   node tools/smoke.js --seconds 30    # how long to let the game run (default 20)
 *
 * Exit code 1 if any page error / console error occurred or the game never became ready.
 * Uses the globally installed playwright at /opt/node22/lib/node_modules/playwright.
 */
const path = require('path');
const fs = require('fs');
let chromium;
try { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }
catch (e) { ({ chromium } = require('playwright')); }

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const OUT = path.join(__dirname, 'out');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
const HTML = path.resolve(__dirname, '..', 'dist', 'Chris-Jensens-LOTRO.html');
const SECONDS = parseFloat(opt('--seconds', '20'));

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  const warnings = [];
  page.on('console', m => {
    const t = m.type();
    if (t === 'error') errors.push('[console.error] ' + m.text());
    else if (t === 'warning') warnings.push(m.text());
  });
  page.on('pageerror', e => errors.push('[pageerror] ' + e.message + '\n' + (e.stack || '')));
  page.on('crash', () => errors.push('[crash] page crashed'));

  const T = {
    page, errors, warnings,
    shot: async (name) => { if (flag('--shots')) await page.screenshot({ path: path.join(OUT, name + '.png') }); },
    press: async (key, ms = 150) => { await page.keyboard.press(key); await page.waitForTimeout(ms); },
    hold: async (key, ms) => { await page.keyboard.down(key); await page.waitForTimeout(ms); await page.keyboard.up(key); },
    evalT: (fn, ...a) => page.evaluate(fn, ...a),
    wait: (ms) => page.waitForTimeout(ms),
    log: (...a) => console.log('  ', ...a),
  };

  const t0 = Date.now();
  await page.goto('file://' + HTML);
  try {
    await page.waitForFunction(() => window.__T && window.__T.ready, { timeout: 60000 });
  } catch (e) {
    errors.push('[timeout] window.__T.ready never became true');
  }
  console.log('boot ms:', Date.now() - t0);
  await T.shot('00_menu');

  const scriptPath = opt('--script', null);
  if (scriptPath) {
    const scenario = require(path.resolve(scriptPath));
    await scenario(page, T);
  } else {
    // Default scenario: quick-start and exercise every keybinding.
    await page.evaluate(() => window.__T.quickStart({ name: 'Smoketest', race: 'man', cls: 'champion', gender: 'male' }));
    await page.waitForFunction(() => window.__T.inGame, { timeout: 60000 }).catch(() => errors.push('[timeout] __T.inGame never true'));
    await page.waitForTimeout(1500);
    await T.shot('01_ingame');
    const keys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'KeyQ', 'KeyR', 'KeyE', 'KeyI', 'KeyI', 'KeyJ', 'KeyJ', 'KeyK', 'KeyK', 'KeyC', 'KeyC', 'KeyM', 'KeyM', 'KeyP', 'KeyP', 'KeyH', 'KeyH', 'KeyF', 'KeyF', 'KeyB', 'KeyB', 'Tab', 'Digit1', 'Digit2', 'Escape'];
    for (const k of keys) { await T.hold(k, 120); await page.waitForTimeout(80); }
    await page.mouse.move(640, 360); await page.mouse.wheel(0, -300); await page.mouse.wheel(0, 600);
    await T.shot('02_after_keys');
    const stats = await page.evaluate(() => window.__T.stats ? window.__T.stats() : null);
    console.log('stats:', JSON.stringify(stats));
    const remaining = Math.max(0, SECONDS * 1000 - (Date.now() - t0));
    await page.waitForTimeout(remaining);
    await T.shot('03_end');
  }

  const gameErrors = await page.evaluate(() => (window.__T && window.__T.errors) ? window.__T.errors.slice(0, 50) : []).catch(() => []);
  await browser.close();
  const all = errors.concat(gameErrors.map(e => '[G.errors] ' + e));
  if (warnings.length) console.log('warnings (' + warnings.length + '):', warnings.slice(0, 10).join('\n'));
  if (all.length) {
    console.log('ERRORS (' + all.length + '):');
    const seen = new Set();
    for (const e of all) { const k = e.slice(0, 200); if (seen.has(k)) continue; seen.add(k); console.log('---\n' + e); }
    process.exit(1);
  }
  console.log('SMOKE OK');
})().catch(e => { console.error('HARNESS FAILURE', e); process.exit(2); });
