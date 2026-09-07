/* ==== 33_ui_charcreate.js — Loading screen, main menu and character creation (SPEC §7.4) for
   Chris Jensen's Lord of the Rings Online. The first thing the player sees: a title composition (ring + misty
   mountains, all CSS/SVG), a progress bar with rotating lore/control tips and a "Click to begin" gesture that
   initialises audio; a main menu drawn over the live 3D world (a camera drifting over the Shire at dawn) with
   Continue / New Character / Settings / Controls / Credits; and a full-screen character creator with race/class
   cards, appearance editing, live stat preview and a real-time 3D preview rendered by its own small WebGLRenderer.

   Public API (SPEC §7.4 + extras):
     G.UI.Menu.init()                 idempotent; builds DOM + CSS (auto-runs on DOM ready so the loading screen shows early)
     G.UI.Menu.showLoading()          show the loading screen (resets progress)
     G.UI.Menu.progress(pct, text)    drive the loading bar (G.Game.progress forwards here); 100 → "Click to begin"
     G.UI.Menu.setLoading(pct, text)  alias of progress
     G.UI.Menu.show()                 show the main menu (if the loading screen is still up and the player has not clicked
                                      yet, the reveal is deferred until the click gesture); emits 'menuShown'
     G.UI.Menu.hide()                 hide the menu
     G.UI.Menu.update(dt)             per-frame while the menu/creator is visible: drifts the menu camera over Hobbiton
                                      and (when G.UI.Menu.driveWorld, default true) streams Terrain/Veg/Buildings/Sky
                                      around it so main does not have to
     G.UI.Menu.getCamera()            camera to render during the menu phase (G.Player.camera when it exists, else an own camera)
     G.UI.Menu.camera                 the own fallback camera (THREE.PerspectiveCamera)
     G.UI.Menu.driveWorld             bool (see update); set false if main drives the world systems itself during the menu
     G.UI.Menu.visible / loadingVisible / loadDone
     G.UI.Menu.openControls() / openCredits() / openSettings() / closeModal() / refresh()
     G.UI.CharCreate.init(), show(), hide(), getSpec() → {name, gender, race, cls, skin, hairColor, hairStyle, eyeColor,
                                      height, build, beard}, randomise(), setSpec(partial), confirm() (validate + start),
                                      validateName(name) → {ok, reason}, visible
   Events emitted: 'menuShown', 'menuHidden', 'createShown', 'createHidden', 'createConfirmed' (spec), 'loadingDone'.
   Assumptions about other modules (all guarded): G.Game.startNew(spec) / startFromSave() (99_main), G.Save.hasSave()
   and an optional G.Save.summary() → {name, level, cls, race, zone} (34_save), G.Audio.init/music/sfx (01), G.Sky.setTime,
   G.Terrain.height/ready/warmup/update, G.Veg.update, G.Buildings.update, G.Chars.buildHumanoid/update (14),
   G.Items.starterGear/get (03), G.Data races/classes/abilitiesFor/randomName/stats.preview/startPosFor (02/04),
   G.UI.addCSS/getPanel/openPanel/bindTooltip (30 — falls back to own <style>/modals when absent), G.Player.camera (20).
   Private helpers are prefixed with _ (module-local). ==== */
(function () {
  'use strict';
  const G = window.G;
  const UI = G.UI = G.UI || {};
  const el = G.el;
  const esc = G.escapeHTML || function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  const clamp = G.clamp || function (v, a, b) { return v < a ? a : v > b ? b : v; };
  const PI = Math.PI;

  // ------------------------------------------------------------------------------------------------ small utils
  function _has(o, fn) { return !!(o && typeof o[fn] === 'function'); }
  function _sfx(name, opts) { try { if (_has(G.Audio, 'sfx')) G.Audio.sfx(name, opts); } catch (_) { /* silent */ } }
  function _hex(c) { if (typeof c === 'number') return G.hexStr ? G.hexStr(c) : '#' + ('000000' + (c >>> 0).toString(16)).slice(-6); return c == null ? '#ffffff' : String(c); }
  function _num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function _cap(s) { s = String(s == null ? '' : s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
  function _now() { return performance.now() / 1000; }
  function _report(e, where) { if (_has(G, 'reportError')) G.reportError(e, where); else if (G.warn) G.warn(where + ': ' + (e && e.message ? e.message : e)); }
  function _uiRng() {
    if (_has(G, 'rng')) return G.rng((performance.now() * 1000 + 17) | 0);
    let a = (performance.now() * 1000) | 0 || 1;
    const f = function () { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    f.int = function (lo, hi) { return lo + Math.floor(f() * (hi - lo + 1)); };
    f.pick = function (arr) { return arr[Math.floor(f() * arr.length) % arr.length]; };
    f.chance = function (p) { return f() < p; };
    return f;
  }
  const _rng = _uiRng();
  function _pick(arr) { return arr[Math.floor(_rng() * arr.length) % arr.length]; }
  function _debounce(fn, ms) {
    if (_has(G, 'debounce')) return G.debounce(fn, ms);
    let h = 0; const w = function () { const a = arguments; if (h) clearTimeout(h); h = setTimeout(function () { h = 0; fn.apply(null, a); }, ms); };
    w.cancel = function () { if (h) clearTimeout(h); h = 0; }; w.flush = function () { }; return w;
  }
  let _cssDone = false;
  function _injectCSS(text) {
    if (_cssDone) return;
    _cssDone = true;
    if (_has(UI, 'addCSS')) { UI.addCSS(text); return; }
    const s = document.createElement('style'); s.setAttribute('data-ui', 'charcreate'); s.textContent = text;
    (document.head || document.documentElement).appendChild(s);
  }
  function _fadeIn(elm, ms) {
    if (!elm) return;
    elm.classList.remove('cj-leave');
    elm.hidden = false;
    elm.classList.add('cj-enter');
    setTimeout(function () { elm.classList.remove('cj-enter'); }, ms || 700);
  }
  function _fadeOut(elm, ms, cb) {
    if (!elm || elm.hidden) { if (cb) cb(); return; }
    elm.classList.remove('cj-enter');
    elm.classList.add('cj-leave');
    setTimeout(function () { elm.hidden = true; elm.classList.remove('cj-leave'); if (cb) cb(); }, ms || 450);
  }
  function _svg(tag, attrs, children) { attrs = attrs || {}; attrs.ns = 'svg'; return el(tag, attrs, children); }
  function _races() { return (G.Data && Array.isArray(G.Data.races) && G.Data.races.length) ? G.Data.races : []; }
  function _classes() { return (G.Data && Array.isArray(G.Data.classes) && G.Data.classes.length) ? G.Data.classes : []; }
  function _raceById(id) { const list = _races(); for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return list[0] || null; }
  function _classById(id) { const list = _classes(); for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return list[0] || null; }
  function _tooltip(elm, htmlOrFn) { if (_has(UI, 'bindTooltip')) { try { UI.bindTooltip(elm, htmlOrFn); } catch (_) { /* ignore */ } } else if (typeof htmlOrFn === 'string') elm.title = htmlOrFn.replace(/<[^>]+>/g, ''); }

  // ------------------------------------------------------------------------------------------------ static content
  const TITLE = "Chris Jensen's Lord of the Rings Online";
  const TIPS = [
    'The Shire lies west of Bree, between the Brandywine and the Far Downs. Hobbits like it that way.',
    'Press F beside any river, pond or shore to cast a line. Fish sell well, and some quests want them.',
    'Hold the right mouse button and drag to look around when the pointer is not locked.',
    'Press H to whistle for your horse. Mounts cannot enter buildings or swim.',
    'Q performs a dodge roll: you cannot be hit while rolling, but it has a short cooldown.',
    'Tab cycles through nearby enemies. R fires your ranged weapon at the current target.',
    'Every class has 13 abilities. Visit a trainer, or open K, to learn new ones as you level.',
    'The Prancing Pony in Bree is the best inn in Eriador. Rest there to save your progress.',
    'B toggles the auto-quest companion, who will complete every quest in the game for you.',
    'Weathertop, called Amon Sûl of old, still bears the scars of the Witch-king\'s siege.',
    'Rangers of the North guard the borders of the Shire, unseen and unthanked.',
    'Open the map with M. Your tracked quest objective is marked with a pulsing beacon.',
    'The Barrow-downs are older than the Shire, and the wights within remember Angmar.',
    'Set bonuses stack: wear two, four or six pieces of a set for extra strength. See C for details.',
    'Boats from Celondim sail to the Sundered Isles. Speak to a boat-master at any dock.',
    'Fate raises your critical strike chance. Might, Agility or Will feeds your mastery, by class.',
    'Elves take half damage from falls. Hobbits are hard for monsters to notice. Dwarves are stubborn.',
    'Press E to open doors, speak to folk, gather herbs and loot chests.',
    'Ered Luin, the Blue Mountains, hold both Thorin\'s Hall and the elven havens of the coast.',
    'The Lone-lands are lonely for a reason. Bring friends, or a good shield.',
    'Talk to a stable-master for swift travel between towns you have visited.',
    'Forochel is bitterly cold. The Lossoth trade with those who show them respect.',
    'Legend says the Gaunt-lord Draugmar sleeps beneath the ruined fortress of Himring.',
    'F1 shows every key binding. Enter opens the chat. Esc opens the settings.',
    'Complete all 100 story quests and 50 side quests to earn the Armour of the Lost Kingdom.',
  ];
  const CONTROLS = [
    ['W / A / S / D', 'Move (relative to the camera)'], ['Mouse', 'Look around (pointer lock, or hold right button)'], ['Mouse wheel', 'Zoom the camera in and out'],
    ['Space', 'Jump'], ['Q', 'Dodge roll'], ['R', 'Ranged attack'], ['E', 'Interact — doors, folk, nodes, chests, docks, fishing spots'],
    ['Tab', 'Target next enemy'], ['Left click', 'Select / attack'], ['1 – 9, 0, G, T, V, X, Y, Z, L, N, O, U', 'Hotbar abilities 1 – 20'],
    ['I', 'Inventory'], ['C', 'Character'], ['K', 'Abilities'], ['J', 'Quest journal'], ['M', 'World map'], ['P', 'Players'],
    ['H', 'Mount / dismount'], ['F', 'Fish'], ['B', 'Auto-quest companion'], ['Enter', 'Chat'], ['Esc', 'Close window / settings'], ['F1', 'Key help'], ['Num Lock', 'Auto-run'],
  ];
  const CREDITS = [
    ['title', TITLE], ['sub', 'A fan tribute to the world of J.R.R. Tolkien'], ['gap'],
    ['head', 'Created by'], ['line', 'Chris Jensen'], ['gap'],
    ['head', 'Built with'], ['line', 'Three.js r160'], ['line', 'Web Audio API — every sound and every song is synthesised at runtime'], ['line', 'A single HTML file, no downloads, no servers'], ['gap'],
    ['head', 'World'], ['line', 'Procedural terrain, sky, weather, vegetation and buildings'], ['line', 'Fifteen regions of Eriador from the Shire to the Sundered Isles'], ['line', 'One hundred and fifty quests, twenty-five towns, a hundred and fifty fellow travellers'], ['gap'],
    ['head', 'Characters'], ['line', 'Ten races and ten classes of the Free Peoples'], ['line', 'Every hero, horse, boat and beast built from simple shapes'], ['gap'],
    ['head', 'With gratitude to'], ['line', 'J.R.R. Tolkien, for Middle-earth'], ['line', 'The makers of the original Lord of the Rings Online, for the inspiration'], ['line', 'The Three.js contributors'], ['gap'],
    ['line', 'This is a non-commercial fan work. All Middle-earth names and places belong to their respective rights holders.'], ['gap'], ['gap'],
    ['sub', '"The Road goes ever on and on, down from the door where it began."'],
  ];
  const RESERVED = ['frodo', 'bilbo', 'sam', 'samwise', 'gandalf', 'aragorn', 'legolas', 'gimli', 'boromir', 'faramir', 'sauron', 'saruman', 'gollum', 'smeagol',
    'elrond', 'galadriel', 'arwen', 'eowyn', 'eomer', 'theoden', 'merry', 'pippin', 'peregrin', 'meriadoc', 'tom', 'bombadil', 'radagast', 'thorin', 'balin', 'gloin',
    'denethor', 'isildur', 'elendil', 'sméagol', 'shelob', 'treebeard', 'celeborn', 'glorfindel', 'strider', 'butterbur', 'morgoth', 'melkor'];
  const EYE_COLORS = [0x3a5a7a, 0x5a8ab0, 0x4a7a3a, 0x6b4a2a, 0x4a3020, 0x8a8a70, 0xb08a40, 0x2a2a30];
  const EYE_NAMES = ['Blue-grey', 'Blue', 'Green', 'Brown', 'Dark', 'Grey', 'Amber', 'Black'];
  const HAIR_NAMES = ['Short', 'Long', 'Ponytail', 'Braids', 'Wild', 'None'];
  const BUILDS = ['slim', 'normal', 'stocky'];
  const BEARD_RACES = { man: 1, dwarf: 1, beorning: 1, stoutaxe: 1, dunedain: 1, rohirrim: 1 };
  const ROLE_LABEL = { tank: 'Tank', dps: 'Damage', support: 'Support', healer: 'Healer' };
  const STAT_LABEL = { might: 'Might', agility: 'Agility', vitality: 'Vitality', will: 'Will', fate: 'Fate', maxMorale: 'Morale', maxPower: 'Power', armour: 'Armour' };
  const TOWN_NAMES = { hobbiton: 'Hobbiton', archet: 'Archet', celondim: 'Celondim', thorinshall: "Thorin's Hall", bree: 'Bree', micheldelving: 'Michel Delving', bywater: 'Bywater', duillond: 'Duillond', combe: 'Combe' };
  const ZONE_NAMES = { shire: 'The Shire', breeland: 'Bree-land', eredluin: 'Ered Luin', oldforest: 'Old Forest', lonelands: 'The Lone-lands' };
  // tiny SVG glyphs per race (viewBox 0 0 32 32)
  const RACE_META = {
    man: { tag: 'Stout-hearted folk of Bree-land', glyph: 'M16 2l2.4 3.2V19h-4.8V5.2zM9 19h14v3H9zm5.4 3h3.2v8h-3.2z' },
    elf: { tag: 'Swift and ageless Firstborn', glyph: 'M16 2C7 7 4 18 16 30 28 18 25 7 16 2zm-.9 6.5l1.8-.1-.1 18h-1.6z' },
    dwarf: { tag: "Durin's folk, masters of the forge", glyph: 'M14.5 10h3v20h-3zM16 3c-5 0-8 3-9 8 3-1 6-1 9-1s6 0 9 1c-1-5-4-8-9-8z' },
    hobbit: { tag: 'Quiet, clever halflings of the Shire', glyph: 'M16 3a13 13 0 100 26 13 13 0 000-26zm0 3.2a9.8 9.8 0 110 19.6 9.8 9.8 0 010-19.6zM19 15a1.8 1.8 0 100 3.6 1.8 1.8 0 000-3.6z' },
    highelf: { tag: 'Noble Eldar who beheld the Light', glyph: 'M16 2l2.6 9.4L28 8l-6.4 8 6.4 8-9.4-3.4L16 30l-2.6-9.4L4 24l6.4-8L4 8l9.4 3.4z' },
    beorning: { tag: 'Skin-changers of the Vales of Anduin', glyph: 'M16 14c-4.5 0-8 4-8 8.5 0 3.5 2.5 6 5 6 1.5 0 2-.5 3-.5s1.5.5 3 .5c2.5 0 5-2.5 5-6 0-4.5-3.5-8.5-8-8.5zM8 8a3 3 0 100 6 3 3 0 000-6zm16 0a3 3 0 100 6 3 3 0 000-6zM12.5 3a3 3 0 100 6 3 3 0 000-6zm7 0a3 3 0 100 6 3 3 0 000-6z' },
    stoutaxe: { tag: 'Exiled dwarves of the far East', glyph: 'M14.6 12h2.8v18h-2.8zM4 11c3-5 8-8 12-8s9 3 12 8c-3-1-7-1.5-12-1.5S7 10 4 11z' },
    riverhobbit: { tag: 'Boat-loving hobbits of the Brandywine', glyph: 'M4 16c4-7 10-9 16-9l6-5-1.5 7.5L29 17l-4.5 7.5L26 30l-6-5c-6 0-12-2-16-9zm9-2a1.6 1.6 0 100 3.2 1.6 1.6 0 000-3.2z' },
    dunedain: { tag: 'Rangers of the North, heirs of Arnor', glyph: 'M16 2l3.1 8.6 8.9-1.6-5.2 7.4 6.4 6.4-9-.3 1.4 9-5.6-7-5.6 7 1.4-9-9 .3 6.4-6.4L4 9l8.9 1.6z' },
    rohirrim: { tag: 'Horse-lords of the Riddermark', glyph: 'M7 30V19c0-7 5-12 12-12l4-5 1 7 3 4-5 1c-3 0-5 3-5 6v10h-3v-8c-1-1-2-1-3-1v9z' },
  };
  const ROLE_COLOR = { tank: '#5aa0ff', dps: '#ff6a5a', support: '#ffd54a', healer: '#7fd47a' };

  // ------------------------------------------------------------------------------------------------ CSS
  const CSS = `
/* ===== 33_ui_charcreate: shared ===== */
#loading, #mainMenu, #charCreate { position: absolute; inset: 0; overflow: hidden; font-family: var(--font-body); color: var(--parch); }
#loading { z-index: 15; background: #06050b; cursor: default; }
#mainMenu { z-index: 12; background: transparent; }
#charCreate { z-index: 13; background: radial-gradient(120% 90% at 50% 0%, #1c150c 0%, #0b0907 55%, #050403 100%); }
.cj-enter { animation: cjFadeIn .7s ease-out both; }
.cj-leave { animation: cjFadeOut .45s ease-in both; pointer-events: none; }
@keyframes cjFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes cjFadeOut { from { opacity: 1; } to { opacity: 0; } }
.cj-gold-text { background: linear-gradient(180deg, #fff3c4 0%, #f2cf7a 38%, #b98a34 62%, #f7dc93 100%); -webkit-background-clip: text; background-clip: text; color: transparent; }
.cj-rule { height: 1px; background: linear-gradient(90deg, transparent, rgba(212,175,90,.75), transparent); }
.cj-btn-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }

/* ===== title art (loading + menu) ===== */
.ld-sky { position: absolute; inset: 0; background: linear-gradient(180deg, #05060f 0%, #0c1024 30%, #2a2140 52%, #6a3f3a 66%, #c97e4c 74%, #e9b07a 78%, #6b5a5a 79%, #201a1a 100%); }
.ld-stars { position: absolute; inset: 0 0 25% 0; opacity: .9; background-image:
  radial-gradient(1px 1px at 12% 18%, #fff 60%, transparent 61%), radial-gradient(1.5px 1.5px at 28% 8%, #fff 60%, transparent 61%),
  radial-gradient(1px 1px at 44% 26%, #ffe 60%, transparent 61%), radial-gradient(1px 1px at 61% 14%, #fff 60%, transparent 61%),
  radial-gradient(1.5px 1.5px at 73% 31%, #fff 60%, transparent 61%), radial-gradient(1px 1px at 86% 9%, #fff 60%, transparent 61%),
  radial-gradient(1px 1px at 93% 22%, #fff 60%, transparent 61%), radial-gradient(1px 1px at 6% 40%, #fff 60%, transparent 61%),
  radial-gradient(1px 1px at 36% 44%, #fff 60%, transparent 61%), radial-gradient(1.5px 1.5px at 52% 5%, #fff 60%, transparent 61%),
  radial-gradient(1px 1px at 67% 48%, #fff 60%, transparent 61%), radial-gradient(1px 1px at 80% 40%, #fff 60%, transparent 61%),
  radial-gradient(1px 1px at 19% 33%, #fff 60%, transparent 61%), radial-gradient(1px 1px at 58% 36%, #fff 60%, transparent 61%),
  radial-gradient(1px 1px at 97% 46%, #fff 60%, transparent 61%), radial-gradient(1px 1px at 41% 12%, #fff 60%, transparent 61%);
  animation: ldTwinkle 6s ease-in-out infinite; }
@keyframes ldTwinkle { 0%, 100% { opacity: .9; } 50% { opacity: .55; } }
.ld-sun { position: absolute; left: 50%; top: 66%; width: 70vw; height: 40vh; transform: translate(-50%, -30%); background: radial-gradient(ellipse at center, rgba(255,214,150,.55) 0%, rgba(255,160,90,.28) 30%, rgba(255,120,70,0) 70%); pointer-events: none; }
.ld-mtn { position: absolute; left: -15%; width: 130%; bottom: 0; height: 46%; }
.ld-mtn path { fill: #0e0c14; }
.ld-mtn-far { height: 44%; opacity: .95; animation: ldDrift 90s ease-in-out infinite alternate; }
.ld-mtn-far path { fill: #2b2340; }
.ld-mtn-mid { height: 36%; animation: ldDrift 60s ease-in-out infinite alternate-reverse; }
.ld-mtn-mid path { fill: #17132a; }
.ld-mtn-near { height: 26%; animation: ldDrift 40s ease-in-out infinite alternate; }
.ld-mtn-near path { fill: #0a0810; }
@keyframes ldDrift { from { transform: translateX(-2.5%); } to { transform: translateX(2.5%); } }
.ld-mist { position: absolute; left: 0; right: 0; bottom: 0; height: 34%; background: linear-gradient(180deg, rgba(120,110,140,0) 0%, rgba(120,110,140,.16) 45%, rgba(40,34,50,.6) 100%); animation: ldMist 14s ease-in-out infinite; pointer-events: none; }
@keyframes ldMist { 0%, 100% { opacity: .8; } 50% { opacity: 1; } }
.ld-vignette { position: absolute; inset: 0; background: radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,.55) 100%); pointer-events: none; }
.ld-center { position: absolute; left: 0; right: 0; top: 7%; display: flex; flex-direction: column; align-items: center; text-align: center; pointer-events: none; }
.ld-ring { position: relative; width: 210px; height: 210px; margin-bottom: 14px; }
.ld-ring-band { position: absolute; inset: 0; border-radius: 50%; background: conic-gradient(from 20deg, #f6dd95, #b9862f 18%, #ffefb8 30%, #8a5f1c 46%, #f0c96e 60%, #c99a3b 74%, #fff1c0 86%, #f6dd95);
  -webkit-mask: radial-gradient(circle at center, transparent 62%, #000 63.5%, #000 99%, transparent 100%); mask: radial-gradient(circle at center, transparent 62%, #000 63.5%, #000 99%, transparent 100%);
  animation: ldRingSpin 48s linear infinite; box-shadow: 0 0 0 1px rgba(255,220,140,.15); }
.ld-ring-shade { position: absolute; inset: 0; border-radius: 50%; background: radial-gradient(circle at 35% 30%, rgba(255,255,255,.35) 0%, rgba(255,255,255,0) 30%, rgba(0,0,0,0) 60%, rgba(0,0,0,.45) 100%);
  -webkit-mask: radial-gradient(circle at center, transparent 62%, #000 63.5%, #000 99%, transparent 100%); mask: radial-gradient(circle at center, transparent 62%, #000 63.5%, #000 99%, transparent 100%); }
.ld-ring-glow { position: absolute; inset: -30px; border-radius: 50%; background: radial-gradient(circle, rgba(255,190,90,.30) 30%, rgba(255,150,60,.12) 50%, rgba(255,120,40,0) 70%); animation: ldGlow 4s ease-in-out infinite; }
@keyframes ldGlow { 0%, 100% { opacity: .75; transform: scale(1); } 50% { opacity: 1; transform: scale(1.06); } }
@keyframes ldRingSpin { to { transform: rotate(360deg); } }
.ld-inscr { position: absolute; inset: 0; width: 100%; height: 100%; animation: ldRingSpin 48s linear infinite; }
.ld-inscr text { font-family: var(--font-head); font-size: 9.2px; letter-spacing: 1.6px; font-weight: 700; fill: #4a2c08; }
.ld-inscr-fire text { fill: #ff8a2a; opacity: .55; animation: ldFire 3s ease-in-out infinite; }
@keyframes ldFire { 0%, 100% { opacity: .35; } 50% { opacity: .8; } }
.ld-ring-core { position: absolute; left: 50%; top: 50%; width: 118px; height: 118px; transform: translate(-50%, -50%); border-radius: 50%; background: radial-gradient(circle, rgba(255,200,120,.12), rgba(0,0,0,0) 70%); }
.ld-t1 { font-family: var(--font-head); font-size: 15px; letter-spacing: .42em; text-transform: uppercase; color: var(--gold-dim); text-shadow: 0 1px 2px #000; margin-left: .42em; }
.ld-t2 { font-family: var(--font-head); font-weight: 700; font-size: 56px; line-height: 1.05; letter-spacing: .08em; text-transform: uppercase; margin: 6px 0 2px; filter: drop-shadow(0 2px 3px rgba(0,0,0,.9)) drop-shadow(0 0 18px rgba(255,200,90,.28)); }
.ld-t3 { font-family: var(--font-head); font-size: 22px; letter-spacing: .62em; text-transform: uppercase; color: var(--gold-bright); text-shadow: 0 0 12px rgba(255,220,140,.45), 0 1px 2px #000; margin-left: .62em; }
.ld-tag { margin-top: 12px; font-style: italic; color: var(--parch-dim); font-size: 15px; letter-spacing: .04em; text-shadow: 0 1px 2px #000; }
.ld-bottom { position: absolute; left: 50%; bottom: 7%; transform: translateX(-50%); width: 560px; max-width: 92vw; display: flex; flex-direction: column; align-items: center; gap: 8px; }
.ld-status { width: 100%; display: flex; justify-content: space-between; font-family: var(--font-head); font-size: 12px; letter-spacing: .12em; text-transform: uppercase; color: var(--parch-dim); text-shadow: 0 1px 2px #000; }
.ld-status .ld-pct { color: var(--gold-bright); }
.ld-bar { position: relative; width: 100%; height: 12px; border: 1px solid var(--border-hi); border-radius: 3px; background: rgba(0,0,0,.65); box-shadow: 0 0 0 3px rgba(0,0,0,.35), inset 0 1px 3px #000; overflow: hidden; }
.ld-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0%; background: linear-gradient(180deg, #ffe9a8, #d4a848 45%, #9a6e22); transition: width .35s ease-out; box-shadow: 0 0 10px rgba(255,214,120,.55); }
.ld-shine { position: absolute; top: 0; bottom: 0; width: 60px; left: -80px; background: linear-gradient(90deg, rgba(255,255,255,0), rgba(255,255,255,.45), rgba(255,255,255,0)); animation: ldShine 2.4s linear infinite; }
@keyframes ldShine { to { left: 110%; } }
.ld-tip { min-height: 40px; font-size: 15px; font-style: italic; color: var(--parch); text-align: center; text-shadow: 0 1px 3px #000, 0 0 8px rgba(0,0,0,.8); opacity: 1; transition: opacity .4s; padding: 0 12px; }
.ld-tip.swap { opacity: 0; }
.ld-tip b { color: var(--gold-bright); font-style: normal; font-family: var(--font-head); font-size: 12px; letter-spacing: .14em; text-transform: uppercase; margin-right: 8px; }
.ld-begin { margin-top: 4px; font-family: var(--font-head); font-size: 20px; letter-spacing: .3em; text-transform: uppercase; color: #fff; text-shadow: 0 0 16px rgba(255,220,140,.8), 0 2px 3px #000; animation: pulse 1.6s ease-in-out infinite; cursor: pointer; }
#loading.ld-ready { cursor: pointer; }
#loading.ld-ready .ld-bar, #loading.ld-ready .ld-status { opacity: .45; }
.ld-corner { position: absolute; bottom: 12px; font-size: 11px; color: rgba(232,220,192,.45); letter-spacing: .06em; font-family: var(--font-head); }
.ld-corner.l { left: 16px; } .ld-corner.r { right: 16px; }
@media (max-height: 760px) { .ld-ring { width: 170px; height: 170px; margin-bottom: 8px; } .ld-t2 { font-size: 46px; } .ld-center { top: 5%; } .ld-bottom { bottom: 5%; } }

/* ===== main menu ===== */
.mm-fallback { position: absolute; inset: 0; }
.mm-shade { position: absolute; inset: 0; background: linear-gradient(90deg, rgba(4,3,2,.92) 0%, rgba(4,3,2,.82) 26%, rgba(4,3,2,.35) 46%, rgba(4,3,2,0) 66%), linear-gradient(180deg, rgba(0,0,0,.35), rgba(0,0,0,0) 30%, rgba(0,0,0,0) 70%, rgba(0,0,0,.55)); pointer-events: none; }
.mm-column { position: absolute; left: 6vw; top: 0; bottom: 0; width: 440px; max-width: 46vw; display: flex; flex-direction: column; justify-content: center; gap: 22px; }
.mm-title { display: flex; flex-direction: column; align-items: flex-start; }
.mm-title .ld-t1 { font-size: 13px; }
.mm-title .ld-t2 { font-size: 44px; margin: 4px 0 0; }
.mm-title .ld-t3 { font-size: 17px; margin: 2px 0 0; }
.mm-title-row { display: flex; align-items: center; gap: 16px; }
.mm-ring { position: relative; width: 84px; height: 84px; flex: none; }
.mm-ring .ld-ring-glow { inset: -14px; }
.mm-ring .ld-inscr text { font-size: 9.6px; letter-spacing: .8px; }
.mm-buttons { display: flex; flex-direction: column; gap: 6px; width: 100%; }
.mm-btn { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 10px 18px 10px 26px; cursor: pointer; border: 1px solid transparent; border-radius: 4px;
  font-family: var(--font-head); font-size: 20px; letter-spacing: .12em; text-transform: uppercase; color: var(--parch); text-shadow: 0 2px 3px #000; transition: background .15s, color .15s, padding-left .15s, border-color .15s; user-select: none; }
.mm-btn::before { content: ''; position: absolute; left: 10px; top: 50%; width: 6px; height: 6px; transform: translateY(-50%) rotate(45deg); background: var(--gold); opacity: 0; transition: opacity .15s, transform .15s; box-shadow: 0 0 8px rgba(255,220,140,.8); }
.mm-btn:hover, .mm-btn.focus { color: #fff; background: linear-gradient(90deg, rgba(212,175,90,.22), rgba(212,175,90,0)); border-color: rgba(212,175,90,.35); padding-left: 32px; }
.mm-btn:hover::before, .mm-btn.focus::before { opacity: 1; transform: translateY(-50%) rotate(45deg) scale(1.15); }
.mm-btn.primary { color: var(--gold-bright); }
.mm-btn .mm-sub { font-family: var(--font-body); font-size: 13px; letter-spacing: .02em; text-transform: none; color: var(--parch-dim); }
.mm-btn.disabled { opacity: .4; pointer-events: none; }
.mm-footer { position: absolute; left: 0; right: 0; bottom: 14px; display: flex; justify-content: space-between; padding: 0 18px; font-size: 12px; color: rgba(232,220,192,.55); letter-spacing: .06em; font-family: var(--font-head); pointer-events: none; }
.mm-hint { position: absolute; right: 24px; top: 18px; font-size: 12px; color: rgba(232,220,192,.5); font-family: var(--font-head); letter-spacing: .1em; text-transform: uppercase; }
.mm-modal-backdrop { position: absolute; inset: 0; background: rgba(0,0,0,.55); backdrop-filter: blur(3px); display: flex; align-items: center; justify-content: center; z-index: 5; animation: cjFadeIn .25s ease-out; }
.mm-modal { position: relative; width: 640px; max-width: 92vw; max-height: 86vh; display: flex; flex-direction: column; background: var(--panel); border: 2px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow); animation: fadeIn .25s ease-out; }
.mm-modal::before { content: ''; position: absolute; inset: 3px; border: 1px solid rgba(212,175,90,.35); border-radius: 4px; pointer-events: none; }
.mm-modal .panel-title { border-radius: 4px 4px 0 0; }
.mm-modal .panel-body { padding: 14px 18px; }
.mm-modal .panel-footer { justify-content: flex-end; }
.mm-controls { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; align-items: center; font-size: 14px; }
.mm-controls .keycap { font-size: 12px; line-height: 20px; padding: 0 7px; }
.mm-credits { position: relative; height: 56vh; overflow: hidden; text-align: center; -webkit-mask: linear-gradient(180deg, transparent 0, #000 12%, #000 88%, transparent 100%); mask: linear-gradient(180deg, transparent 0, #000 12%, #000 88%, transparent 100%); }
.mm-credits-roll { position: absolute; left: 0; right: 0; top: 100%; animation: mmRoll 46s linear infinite; }
@keyframes mmRoll { to { transform: translateY(calc(-100% - 60vh)); } }
.mm-credits .c-title { font-family: var(--font-head); font-size: 26px; color: var(--gold-bright); margin-bottom: 4px; }
.mm-credits .c-sub { font-style: italic; color: var(--parch-dim); font-size: 16px; }
.mm-credits .c-head { font-family: var(--font-head); font-size: 13px; letter-spacing: .18em; text-transform: uppercase; color: var(--gold); margin-top: 26px; margin-bottom: 6px; }
.mm-credits .c-line { font-size: 16px; color: var(--parch); line-height: 1.5; }
.mm-credits .c-gap { height: 22px; }
.mm-settings { display: flex; flex-direction: column; gap: 10px; }
.mm-settings label.row { font-size: 15px; }
.mm-settings input[type=range] { width: 240px; }
.mm-settings .val { display: inline-block; min-width: 44px; text-align: right; color: var(--gold-bright); font-family: var(--font-ui); font-size: 13px; }

/* ===== character creation ===== */
#charCreate { display: flex; flex-direction: column; }
.cc-top { flex: none; display: flex; align-items: center; gap: 18px; padding: 10px 22px; border-bottom: 1px solid var(--border); background: linear-gradient(180deg, rgba(120,90,40,.28), rgba(20,14,7,.5)); }
.cc-top .cc-ring { width: 40px; height: 40px; position: relative; flex: none; }
.cc-top h1 { font-size: 24px; letter-spacing: .12em; text-transform: uppercase; }
.cc-top .cc-sub { font-style: italic; color: var(--parch-dim); font-size: 14px; }
.cc-top .grow { flex: 1; }
.cc-body { flex: 1; min-height: 0; display: flex; gap: 16px; padding: 12px 22px 14px; }
.cc-left { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding-right: 6px; display: grid; grid-template-columns: 1fr; gap: 10px; align-content: start; }
@media (min-width: 1560px) { .cc-left { grid-template-columns: 1.15fr .85fr; } .cc-left .cc-col { display: flex; flex-direction: column; gap: 10px; min-width: 0; } }
@media (max-width: 1559px) { .cc-left .cc-col { display: contents; } }
.cc-section { background: rgba(20, 15, 9, .78); border: 1px solid var(--border); border-radius: 5px; padding: 8px 12px 10px; box-shadow: inset 0 0 0 1px rgba(255,220,140,.05), 0 4px 14px rgba(0,0,0,.35); }
.cc-section .section-title { margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
.cc-section .section-title .n { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border-radius: 50%; border: 1px solid var(--gold); color: var(--gold-bright); font-size: 10px; }
.cc-name-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.cc-name-row input[type=text] { flex: 1; min-width: 180px; font-family: var(--font-head); font-size: 17px; letter-spacing: .06em; padding: 7px 10px; }
.cc-name-row input.bad { border-color: var(--red); box-shadow: 0 0 8px rgba(224,75,58,.5); animation: ccShake .35s; }
@keyframes ccShake { 0%, 100% { transform: none; } 25% { transform: translateX(-4px); } 75% { transform: translateX(4px); } }
.cc-name-err { font-size: 12.5px; color: var(--red); min-height: 16px; margin-top: 4px; }
.cc-gender { display: inline-flex; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; }
.cc-gender .g { padding: 6px 14px; cursor: pointer; font-family: var(--font-head); font-size: 13px; letter-spacing: .05em; color: var(--parch-dim); background: rgba(0,0,0,.4); display: flex; align-items: center; gap: 6px; }
.cc-gender .g + .g { border-left: 1px solid var(--border); }
.cc-gender .g:hover { color: #fff; }
.cc-gender .g.active { color: #fff; background: linear-gradient(180deg, #8a6a2c, #4d3814); }
.cc-gender .g svg { width: 14px; height: 14px; fill: currentColor; }
.cc-grid { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }
.cc-card { position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 7px 4px 6px; border: 1px solid var(--border); border-radius: 4px; background: linear-gradient(180deg, rgba(60,45,22,.35), rgba(0,0,0,.45)); cursor: pointer; text-align: center; transition: border-color .12s, background .12s, transform .12s; min-width: 0; }
.cc-card:hover { border-color: var(--border-hi); background: linear-gradient(180deg, rgba(90,68,30,.45), rgba(0,0,0,.5)); transform: translateY(-1px); }
.cc-card.selected { border-color: var(--gold-bright); background: linear-gradient(180deg, rgba(140,105,45,.55), rgba(40,28,10,.7)); box-shadow: 0 0 12px rgba(255,224,138,.35), inset 0 0 8px rgba(255,224,138,.12); }
.cc-card.selected::after { content: ''; position: absolute; right: 4px; top: 4px; width: 7px; height: 7px; transform: rotate(45deg); background: var(--gold-bright); box-shadow: 0 0 6px rgba(255,224,138,.9); }
.cc-card .glyph { width: 26px; height: 26px; fill: var(--gold); filter: drop-shadow(0 1px 1px #000); }
.cc-card.selected .glyph { fill: var(--gold-bright); }
.cc-card .cicon { width: 30px; height: 30px; border-radius: 5px; display: flex; align-items: center; justify-content: center; font-size: 18px; line-height: 1; box-shadow: inset 0 0 0 1px rgba(0,0,0,.6), 0 1px 3px #000; text-shadow: 0 1px 2px #000; }
.cc-card .nm { font-family: var(--font-head); font-size: 12px; letter-spacing: .04em; color: var(--parch); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.cc-card.selected .nm { color: var(--gold-bright); }
.cc-card .tg { font-size: 10.5px; color: var(--parch-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; line-height: 1.2; }
.cc-card .role { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; padding: 0 6px; border-radius: 8px; border: 1px solid currentColor; line-height: 14px; }
.cc-detail { margin-top: 8px; padding: 8px 10px; border: 1px solid rgba(111,83,34,.7); border-radius: 4px; background: rgba(0,0,0,.35); display: flex; flex-direction: column; gap: 6px; }
.cc-detail .hd { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.cc-detail .hd h3 { font-size: 17px; }
.cc-detail .hd .muted { font-size: 12.5px; }
.cc-desc { font-size: 13px; line-height: 1.38; color: #d9ccb0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.cc-desc.open { display: block; -webkit-line-clamp: unset; }
.cc-more { font-size: 11.5px; color: var(--gold); cursor: pointer; letter-spacing: .06em; text-transform: uppercase; font-family: var(--font-head); align-self: flex-start; }
.cc-more:hover { color: var(--gold-bright); }
.cc-chips { display: flex; gap: 5px; flex-wrap: wrap; }
.cc-chip { font-size: 11.5px; padding: 1px 7px; border-radius: 3px; border: 1px solid var(--border); background: rgba(0,0,0,.45); color: var(--parch); font-family: var(--font-ui); }
.cc-chip.pos { color: #8fe08a; border-color: rgba(95,191,90,.5); }
.cc-chip.neg { color: #ff8a7a; border-color: rgba(224,75,58,.5); }
.cc-chip.info { color: var(--gold-bright); }
.cc-chip b { color: var(--gold); font-weight: 600; margin-right: 3px; }
.cc-trait { font-size: 12.5px; color: var(--parch); line-height: 1.35; }
.cc-trait b { color: var(--gold-bright); font-family: var(--font-head); font-size: 12px; letter-spacing: .04em; }
.cc-abils { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.cc-abil { display: flex; align-items: center; gap: 7px; padding: 4px 6px; border: 1px solid rgba(111,83,34,.6); border-radius: 4px; background: rgba(0,0,0,.35); min-width: 0; cursor: help; }
.cc-abil .icon { width: 30px; height: 30px; font-size: 18px; border-radius: 4px; background: radial-gradient(circle at 40% 35%, #4a3a1c, #120d06); border: 1px solid var(--border); flex: none; }
.cc-abil .an { font-family: var(--font-head); font-size: 12px; color: var(--parch); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cc-abil .al { font-size: 10.5px; color: var(--parch-dim); }
.cc-abil .txt { min-width: 0; display: flex; flex-direction: column; }
.cc-app { display: grid; grid-template-columns: max-content 1fr; gap: 8px 12px; align-items: center; }
.cc-app .lbl { font-family: var(--font-head); font-size: 11.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--gold); }
.cc-swatches { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
.cc-swatch { width: 22px; height: 22px; border-radius: 50%; border: 2px solid rgba(0,0,0,.7); box-shadow: 0 0 0 1px var(--border), inset 0 -3px 5px rgba(0,0,0,.35), inset 0 2px 3px rgba(255,255,255,.25); cursor: pointer; transition: transform .1s; }
.cc-swatch:hover { transform: scale(1.12); }
.cc-swatch.selected { box-shadow: 0 0 0 2px var(--gold-bright), 0 0 8px rgba(255,224,138,.6), inset 0 -3px 5px rgba(0,0,0,.35); }
.cc-seg { display: inline-flex; border: 1px solid var(--border); border-radius: 4px; overflow: hidden; flex-wrap: wrap; }
.cc-seg .s { padding: 4px 10px; cursor: pointer; font-family: var(--font-head); font-size: 11.5px; letter-spacing: .04em; color: var(--parch-dim); background: rgba(0,0,0,.4); border-right: 1px solid var(--border); }
.cc-seg .s:last-child { border-right: none; }
.cc-seg .s:hover { color: #fff; }
.cc-seg .s.active { color: #fff; background: linear-gradient(180deg, #8a6a2c, #4d3814); }
.cc-range { display: flex; align-items: center; gap: 10px; }
.cc-range input[type=range] { width: 200px; max-width: 100%; }
.cc-range .val { font-family: var(--font-ui); font-size: 13px; color: var(--gold-bright); min-width: 54px; }
.cc-stats { display: grid; grid-template-columns: repeat(2, 1fr); gap: 3px 18px; }
.cc-stat { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; padding: 2px 4px; border-bottom: 1px solid rgba(255,255,255,.05); font-size: 13.5px; }
.cc-stat .k { color: var(--parch-dim); }
.cc-stat .v { font-family: var(--font-ui); color: #fff; font-weight: 600; }
.cc-stat .b { font-size: 11px; margin-left: 5px; font-weight: 400; }
.cc-stat .b.pos { color: #8fe08a; } .cc-stat .b.neg { color: #ff8a7a; }
.cc-stat.main .k { color: var(--gold-bright); }
.cc-stat-note { font-size: 11.5px; color: var(--parch-dim); margin-top: 6px; font-style: italic; }
.cc-right { flex: none; width: 460px; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
@media (max-width: 1500px) { .cc-right { width: 400px; } }
.cc-preview-wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.cc-preview { position: relative; border: 1px solid var(--border-hi); border-radius: 6px; overflow: hidden; background: radial-gradient(90% 70% at 50% 20%, #3a2f22 0%, #1a140d 45%, #070503 100%); box-shadow: 0 10px 40px rgba(0,0,0,.7), inset 0 0 0 1px rgba(255,220,140,.08); cursor: grab; }
.cc-preview.dragging { cursor: grabbing; }
.cc-preview canvas { position: absolute; inset: 0; width: 100% !important; height: 100% !important; display: block; }
.cc-preview .vig { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 40%, rgba(0,0,0,.55) 100%); pointer-events: none; }
.cc-preview .rays { position: absolute; left: 50%; top: -10%; width: 160%; height: 90%; transform: translateX(-50%); background: radial-gradient(ellipse at 50% 0%, rgba(255,214,150,.22), rgba(255,214,150,0) 60%); pointer-events: none; }
.cc-preview .pv-name { position: absolute; left: 0; right: 0; top: 12px; text-align: center; pointer-events: none; }
.cc-preview .pv-name .n { font-family: var(--font-head); font-size: 22px; letter-spacing: .1em; color: var(--gold-bright); text-shadow: 0 2px 4px #000, 0 0 12px rgba(255,200,90,.35); min-height: 26px; }
.cc-preview .pv-name .s { font-size: 13px; color: var(--parch-dim); font-style: italic; text-shadow: 0 1px 2px #000; }
.cc-preview .pv-hint { position: absolute; left: 0; right: 0; bottom: 8px; text-align: center; font-size: 11px; color: rgba(232,220,192,.5); letter-spacing: .1em; text-transform: uppercase; font-family: var(--font-head); pointer-events: none; }
.cc-preview .pv-home { position: absolute; left: 10px; bottom: 26px; font-size: 12px; color: var(--parch-dim); text-shadow: 0 1px 2px #000; pointer-events: none; }
.cc-preview .pv-home b { color: var(--gold); font-weight: 600; }
.cc-enter { flex: none; display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
.cc-enter .btn.big { font-size: 18px; letter-spacing: .14em; padding: 13px 20px; text-transform: uppercase; box-shadow: 0 0 18px rgba(212,175,90,.25), inset 0 1px 0 rgba(255,220,140,.25); }
.cc-enter .btn.big:hover { box-shadow: 0 0 26px rgba(255,224,138,.45), inset 0 1px 0 rgba(255,220,140,.35); }
.cc-enter .note { text-align: center; font-size: 12px; color: var(--parch-dim); font-style: italic; }
#charCreate .btn { font-size: 12.5px; }
`;

  // ------------------------------------------------------------------------------------------------ title art builders
  function _ridgePath(seed, base, amp, n, w, h) {
    // deterministic jagged ridge line for the SVG mountain layers
    const pts = [];
    let s = seed | 0;
    const rnd = function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const hasNoise = _has(G, 'fbm');
    for (let i = 0; i <= n; i++) {
      const x = (i / n) * w;
      let y;
      if (hasNoise) y = base - Math.abs(G.fbm(i * 0.35 + seed * 0.13, seed * 0.7, 4)) * amp - Math.max(0, G.noise2(i * 0.11 + seed, 3.3)) * amp * 0.6;
      else y = base - (0.3 + 0.7 * rnd()) * amp * (0.6 + 0.4 * Math.sin(i * 0.7 + seed));
      y += (rnd() - 0.5) * amp * 0.12;
      pts.push(x.toFixed(1) + ',' + clamp(y, 4, h - 2).toFixed(1));
    }
    return 'M0,' + h + ' L' + pts.join(' L') + ' L' + w + ',' + h + ' Z';
  }
  function _mountainLayer(cls, seed, base, amp) {
    const W = 1600, H = 300;
    return _svg('svg', { class: 'ld-mtn ' + cls, viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none' }, [_svg('path', { d: _ridgePath(seed, base, amp, 64, W, H) })]);
  }
  const INSCRIPTION = 'ASH NAZG DURBATULÛK · ASH NAZG GIMBATUL · ASH NAZG THRAKATULÛK · AGH BURZUM-ISHI KRIMPATUL · ';
  let _ringSeq = 0;
  function _ringArt(size, small) {
    const id = 'cjRingPath' + (++_ringSeq);
    const r = small ? 78 : 80;
    const path = 'M100,100 m-' + r + ',0 a' + r + ',' + r + ' 0 1,1 ' + (r * 2) + ',0 a' + r + ',' + r + ' 0 1,1 -' + (r * 2) + ',0';
    const inscr = function (cls) {
      return _svg('svg', { class: 'ld-inscr ' + (cls || ''), viewBox: '0 0 200 200' }, [
        _svg('defs', {}, [_svg('path', { id: id + (cls ? 'b' : 'a'), d: path })]),
        _svg('text', {}, [_svg('textPath', { href: '#' + id + (cls ? 'b' : 'a'), startOffset: '0' }, [INSCRIPTION])]),
      ]);
    };
    const ring = el('div', { class: 'ld-ring', style: size ? { width: size + 'px', height: size + 'px' } : null }, [
      el('div', { class: 'ld-ring-glow' }), el('div', { class: 'ld-ring-band' }), el('div', { class: 'ld-ring-shade' }), inscr('ld-inscr-fire'), inscr(''), el('div', { class: 'ld-ring-core' }),
    ]);
    return ring;
  }
  function _titleArtLayers() {
    return [
      el('div', { class: 'ld-sky' }), el('div', { class: 'ld-stars' }), el('div', { class: 'ld-sun' }),
      _mountainLayer('ld-mtn-far', 11, 250, 200), _mountainLayer('ld-mtn-mid', 23, 275, 150), _mountainLayer('ld-mtn-near', 37, 288, 90),
      el('div', { class: 'ld-mist' }), el('div', { class: 'ld-vignette' }),
    ];
  }
  function _titleBlock(compact) {
    return [
      el('div', { class: 'ld-t1', text: "Chris Jensen's" }),
      el('div', { class: 'ld-t2 cj-gold-text', text: 'Lord of the Rings' }),
      el('div', { class: 'ld-t3', text: 'Online' }),
      compact ? null : el('div', { class: 'ld-tag', text: 'A fan-made journey through Eriador — from the Shire to the Sundered Isles' }),
    ];
  }

  // ================================================================================================ MENU
  const M = {
    inited: false, root: null, loadEl: null, menuEl: null, visible: false, loadingVisible: true, loadDone: false, clicked: false, pendingShow: false,
    pct: 0, tipIdx: -1, tipTimer: 0, buttons: [], focusIdx: -1, modal: null, camera: null, t: 0, camInit: false, driveWorld: true,
    els: {},
  };
  const _camPos = new THREE.Vector3(), _camTarget = new THREE.Vector3(), _camWant = new THREE.Vector3(), _camLook = new THREE.Vector3(), _camUp = new THREE.Vector3(0, 1, 0);
  const CAM_CENTER = { x: -1085, z: -120 };            // west of Hobbiton, looking east across the village at the sunrise
  const CAM_FOCUS = { x: -905, z: -105 };

  function _groundY(x, z) {
    try { if (G.Terrain && G.Terrain.ready && _has(G.Terrain, 'height')) return G.Terrain.height(x, z); } catch (_) { /* ignore */ }
    return 0;
  }
  function _ensureRoot(id) {
    let r = document.getElementById(id);
    if (!r) { r = el('div', { id: id, hidden: true }); (document.getElementById('ui') || document.body).appendChild(r); }
    return r;
  }

  function _buildLoading() {
    const L = M.loadEl = _ensureRoot('loading');
    while (L.firstChild) L.removeChild(L.firstChild);
    const e = M.els;
    e.status = el('span', { class: 'ld-status-text', text: 'Preparing the journey…' });
    e.pct = el('span', { class: 'ld-pct', text: '0%' });
    e.fill = el('div', { class: 'ld-fill' });
    e.tip = el('div', { class: 'ld-tip' });
    e.begin = el('div', { class: 'ld-begin', text: 'Click to begin', hidden: true });
    const center = el('div', { class: 'ld-center' }, [_ringArt(0, false)].concat(_titleBlock(false)));
    const bottom = el('div', { class: 'ld-bottom' }, [
      el('div', { class: 'ld-status' }, [e.status, e.pct]),
      el('div', { class: 'ld-bar' }, [e.fill, el('div', { class: 'ld-shine' })]),
      e.tip, e.begin,
    ]);
    L.append.apply(L, _titleArtLayers());
    L.appendChild(center); L.appendChild(bottom);
    L.appendChild(el('div', { class: 'ld-corner l', text: 'v' + (G.VERSION || '1.0.0') }));
    L.appendChild(el('div', { class: 'ld-corner r', text: 'A fan tribute · not affiliated with any rights holder' }));
    L.addEventListener('click', function () { if (M.loadDone) _beginClicked(); });
    _nextTip(true);
    if (M.tipTimer) clearInterval(M.tipTimer);
    M.tipTimer = setInterval(function () { if (!M.loadEl.hidden) _nextTip(false); }, 4000);
  }
  function _nextTip(immediate) {
    const e = M.els; if (!e.tip) return;
    const show = function () {
      M.tipIdx = (M.tipIdx + 1) % TIPS.length;
      e.tip.innerHTML = '<b>Tip</b>' + esc(TIPS[M.tipIdx]);
      e.tip.classList.remove('swap');
    };
    if (immediate) { M.tipIdx = Math.floor(_rng() * TIPS.length) - 1; show(); return; }
    e.tip.classList.add('swap');
    setTimeout(show, 420);
  }
  function _beginClicked() {
    if (M.clicked) return;
    M.clicked = true;
    try { if (_has(G.Audio, 'init')) G.Audio.init(); } catch (err) { _report(err, 'Menu.begin'); }
    _sfx('ui_click');
    _revealMenu();
  }
  function _revealMenu() {
    if (!M.loadEl.hidden) _fadeOut(M.loadEl, 700, function () { M.loadingVisible = false; });
    M.loadingVisible = false;
    M.pendingShow = false;
    _showMenuNow();
  }

  function _buildMenu() {
    const R = M.menuEl = _ensureRoot('mainMenu');
    while (R.firstChild) R.removeChild(R.firstChild);
    const e = M.els;
    e.fallback = el('div', { class: 'mm-fallback' }, _titleArtLayers());
    e.buttons = el('div', { class: 'mm-buttons' });
    e.modalHost = el('div');
    const title = el('div', { class: 'mm-title' }, [
      el('div', { class: 'mm-title-row' }, [_ringArt(84, true), el('div', {}, _titleBlock(true))]),
    ]);
    const col = el('div', { class: 'mm-column' }, [title, el('div', { class: 'cj-rule' }), e.buttons]);
    R.appendChild(e.fallback);
    R.appendChild(el('div', { class: 'mm-shade' }));
    R.appendChild(col);
    R.appendChild(el('div', { class: 'mm-hint', text: '↑ ↓ to choose · Enter to select' }));
    R.appendChild(el('div', { class: 'mm-footer' }, [el('span', { text: 'v' + (G.VERSION || '1.0.0') + ' · single-file build' }), el('span', { text: TITLE + ' — a fan tribute, built with Three.js' })]));
    R.appendChild(e.modalHost);
    _buildButtons();
  }
  function _menuBtn(label, sub, onClick, cls) {
    const b = el('div', { class: 'mm-btn ' + (cls || ''), tabIndex: 0 }, [el('span', { text: label }), sub ? el('span', { class: 'mm-sub', text: sub }) : null]);
    b.addEventListener('mouseenter', function () { _sfx('ui_click', { vol: 0.35, pitch: 1.2 }); _setFocus(M.buttons.indexOf(b)); });
    b.addEventListener('click', function () { if (b.classList.contains('disabled')) return; _sfx('ui_click'); onClick(); });
    return b;
  }
  function _saveSummary() {
    const S = G.Save; if (!S) return null;
    const fns = ['summary', 'peek', 'info'];
    for (let i = 0; i < fns.length; i++) if (_has(S, fns[i])) { try { const r = S[fns[i]](); if (r && typeof r === 'object') return r; } catch (_) { /* ignore */ } }
    try {
      const key = (G.C && G.C.SAVE_KEY) || 'cj_lotro_save_v1';
      const raw = window.localStorage ? window.localStorage.getItem(key) : null;
      if (!raw) return null;
      const j = JSON.parse(raw); const p = (j && (j.player || j.char || j.hero)) || j;
      if (!p || typeof p !== 'object') return null;
      return { name: p.name, level: p.level, cls: p.cls, race: p.race, zone: j.zone || p.zone, playTime: (j.stats && j.stats.playTime) || p.playTime };
    } catch (_) { return null; }
  }
  function _hasSave() { try { return !!(G.Save && _has(G.Save, 'hasSave') && G.Save.hasSave()); } catch (_) { return false; } }
  function _zoneName(id) {
    if (!id) return '';
    const w = G.Data && G.Data.world;
    if (w) { const z = (w.zoneById && w.zoneById[id]) || (Array.isArray(w.zones) && w.zones.find(function (x) { return x.id === id; })); if (z && z.name) return z.name; }
    return ZONE_NAMES[id] || _cap(id);
  }
  function _townName(id) {
    if (!id) return '';
    const w = G.Data && G.Data.world;
    if (w && Array.isArray(w.towns)) { const t = w.towns.find(function (x) { return x.id === id; }); if (t && t.name) return t.name; }
    return TOWN_NAMES[id] || _cap(id);
  }
  function _buildButtons() {
    const host = M.els.buttons; while (host.firstChild) host.removeChild(host.firstChild);
    M.buttons = [];
    if (_hasSave()) {
      const s = _saveSummary();
      let sub = 'Return to your adventure';
      if (s && s.name) {
        const c = _classById(s.cls); const parts = [];
        if (s.level) parts.push('Level ' + s.level);
        if (c && c.id === s.cls) parts.push(c.name);
        const z = _zoneName(s.zone); if (z) parts.push(z);
        sub = s.name + (parts.length ? ' · ' + parts.join(' · ') : '');
      }
      M.buttons.push(_menuBtn('Continue', sub, function () { _startFromSave(); }, 'primary'));
    }
    M.buttons.push(_menuBtn('New Character', 'Begin a new journey in Middle-earth', function () { _toCreate(); }, _hasSave() ? '' : 'primary'));
    M.buttons.push(_menuBtn('Settings', null, function () { Menu.openSettings(); }));
    M.buttons.push(_menuBtn('Controls', null, function () { Menu.openControls(); }));
    M.buttons.push(_menuBtn('Credits', null, function () { Menu.openCredits(); }));
    for (let i = 0; i < M.buttons.length; i++) host.appendChild(M.buttons[i]);
    _setFocus(0);
  }
  function _setFocus(i) {
    if (!M.buttons.length) return;
    M.focusIdx = ((i % M.buttons.length) + M.buttons.length) % M.buttons.length;
    for (let k = 0; k < M.buttons.length; k++) M.buttons[k].classList.toggle('focus', k === M.focusIdx);
  }
  function _startFromSave() {
    if (!_has(G.Game, 'startFromSave')) { if (G.warn) G.warn('Menu: G.Game.startFromSave is not available'); return; }
    Menu.closeModal();
    _fadeOut(M.menuEl, 500, function () {
      M.visible = false; G.emit('menuHidden');
      try { G.Game.startFromSave(); } catch (err) { _report(err, 'Menu.startFromSave'); _showMenuNow(); }
    });
  }
  function _toCreate() {
    Menu.closeModal();
    _fadeOut(M.menuEl, 400, function () { M.visible = false; G.emit('menuHidden'); CharCreate.show(); });
  }
  function _showMenuNow() {
    if (!M.inited) Menu.init();
    if (CC.visible) CharCreate.hide();
    _buildButtons();
    M.els.fallback.hidden = !!(G.Game && G.Game.renderer && G.Game.scene);
    _fadeIn(M.menuEl, 700);
    M.visible = true;
    _setupMenuCamera();
    try { if (_has(G.Sky, 'setTime')) G.Sky.setTime(6.5); if (_has(G.Sky, 'setWeather')) G.Sky.setWeather('clear', true); } catch (err) { _report(err, 'Menu.sky'); }
    try { if (_has(G.Audio, 'music')) G.Audio.music('menu'); } catch (err) { _report(err, 'Menu.music'); }
    G.emit('menuShown');
  }
  function _setupMenuCamera() {
    const cam = Menu.getCamera();
    M.t = 0;
    _camPos.set(CAM_CENTER.x - 70, 0, CAM_CENTER.z + 40);
    _camPos.y = Math.max(_groundY(_camPos.x, _camPos.z), _groundY(CAM_CENTER.x, CAM_CENTER.z)) + 16;
    _camLook.set(CAM_FOCUS.x, _groundY(CAM_FOCUS.x, CAM_FOCUS.z) + 4, CAM_FOCUS.z);
    cam.position.copy(_camPos); cam.up.copy(_camUp); cam.lookAt(_camLook);
    M.camInit = true;
    try { if (G.Terrain && G.Terrain.ready && _has(G.Terrain, 'warmup')) G.Terrain.warmup(_camPos.x, _camPos.z, 260); } catch (err) { _report(err, 'Menu.warmup'); }
  }
  function _menuKey(ev) {
    if (!M.inited) return;
    if (G.Input && G.Input.typing) return;
    const t = ev.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
    if (M.loadingVisible && !M.loadEl.hidden) {
      if (M.loadDone && (ev.code === 'Enter' || ev.code === 'Space' || ev.code === 'NumpadEnter')) { ev.preventDefault(); _beginClicked(); }
      return;
    }
    if (!M.visible) return;
    if (M.modal) { if (ev.code === 'Escape') { ev.preventDefault(); Menu.closeModal(); } return; }
    if (ev.code === 'ArrowDown' || ev.code === 'KeyS' || ev.code === 'Tab' && !ev.shiftKey) { ev.preventDefault(); _sfx('ui_click', { vol: 0.35, pitch: 1.2 }); _setFocus(M.focusIdx + 1); }
    else if (ev.code === 'ArrowUp' || ev.code === 'KeyW' || ev.code === 'Tab' && ev.shiftKey) { ev.preventDefault(); _sfx('ui_click', { vol: 0.35, pitch: 1.2 }); _setFocus(M.focusIdx - 1); }
    else if (ev.code === 'Enter' || ev.code === 'NumpadEnter' || ev.code === 'Space') { ev.preventDefault(); const b = M.buttons[M.focusIdx]; if (b) b.click(); }
  }
  function _modal(title, bodyBuilder, buttons, width) {
    Menu.closeModal();
    const body = el('div', { class: 'panel-body' });
    bodyBuilder(body);
    const footer = el('div', { class: 'panel-footer' });
    (buttons || [{ label: 'Close', cls: 'primary', onClick: function () { Menu.closeModal(); } }]).forEach(function (b) {
      footer.appendChild(el('button', { class: 'btn ' + (b.cls || ''), text: b.label, onclick: function () { _sfx('ui_click'); b.onClick(); } }));
    });
    const box = el('div', { class: 'mm-modal', style: width ? { width: width + 'px' } : null }, [
      el('div', { class: 'panel-title' }, [el('span', { class: 'ptitle', text: title }), el('span', { class: 'close', text: '✕', onclick: function () { _sfx('ui_close'); Menu.closeModal(); } })]),
      body, footer,
    ]);
    const bd = el('div', { class: 'mm-modal-backdrop' }, [box]);
    bd.addEventListener('click', function (ev) { if (ev.target === bd) Menu.closeModal(); });
    M.els.modalHost.appendChild(bd);
    M.modal = bd;
    _sfx('ui_open');
    return box;
  }

  const Menu = UI.Menu = {
    get visible() { return M.visible; },
    get loadingVisible() { return M.loadingVisible && !!M.loadEl && !M.loadEl.hidden; },
    get loadDone() { return M.loadDone; },
    get driveWorld() { return M.driveWorld; },
    set driveWorld(v) { M.driveWorld = !!v; },
    camera: null,
    init: function () {
      if (M.inited) return Menu;
      M.inited = true;
      _injectCSS(CSS);
      M.camera = Menu.camera = new THREE.PerspectiveCamera(55, (window.innerWidth || 1280) / (window.innerHeight || 720), 0.5, 4000);
      M.camera.name = 'menuCamera';
      _buildLoading();
      _buildMenu();
      M.menuEl.hidden = true;
      M.loadEl.hidden = false;
      M.loadingVisible = true;
      window.addEventListener('keydown', _menuKey, true);
      window.addEventListener('resize', function () {
        const c = M.camera; if (c) { c.aspect = (window.innerWidth || 1280) / (window.innerHeight || 720); c.updateProjectionMatrix(); }
        if (CC.visible) _sizePreview();
      });
      CharCreate.init();
      return Menu;
    },
    showLoading: function () {
      if (!M.inited) Menu.init();
      M.loadDone = false; M.clicked = false; M.pendingShow = false; M.pct = 0;
      M.loadEl.classList.remove('ld-ready');
      M.els.begin.hidden = true;
      M.els.fill.style.width = '0%'; M.els.pct.textContent = '0%'; M.els.status.textContent = 'Preparing the journey…';
      if (M.visible) { M.menuEl.hidden = true; M.visible = false; }
      if (CC.visible) CharCreate.hide();
      _fadeIn(M.loadEl, 400);
      M.loadingVisible = true;
    },
    progress: function (pct, text) {
      if (!M.inited) Menu.init();
      const e = M.els;
      pct = clamp(_num(pct, M.pct), 0, 100);
      if (pct >= M.pct || pct === 0) M.pct = pct;
      e.fill.style.width = M.pct.toFixed(1) + '%';
      e.pct.textContent = Math.round(M.pct) + '%';
      if (text != null && text !== '') e.status.textContent = String(text);
      if (M.pct >= 100 && !M.loadDone) {
        M.loadDone = true;
        e.status.textContent = text != null && text !== '' ? String(text) : 'Middle-earth awaits';
        e.begin.hidden = false;
        M.loadEl.classList.add('ld-ready');
        G.emit('loadingDone');
      }
      return M.pct;
    },
    setLoading: function (pct, text) { return Menu.progress(pct, text); },
    show: function () {
      if (!M.inited) Menu.init();
      if (M.loadingVisible && !M.loadEl.hidden) {
        if (!M.loadDone) Menu.progress(100, 'Middle-earth awaits');
        if (!M.clicked) { M.pendingShow = true; return; }   // wait for the player's click gesture
        _revealMenu(); return;
      }
      _showMenuNow();
    },
    hide: function () {
      if (!M.inited || !M.visible) return;
      Menu.closeModal();
      M.visible = false;
      M.menuEl.hidden = true; M.menuEl.classList.remove('cj-enter', 'cj-leave');
      G.emit('menuHidden');
    },
    refresh: function () { if (M.inited) _buildButtons(); },
    getCamera: function () {
      if (G.Player && G.Player.camera && G.Player.camera.isCamera) return G.Player.camera;
      if (!M.camera) { M.camera = Menu.camera = new THREE.PerspectiveCamera(55, (window.innerWidth || 1280) / (window.innerHeight || 720), 0.5, 4000); }
      return M.camera;
    },
    update: function (dt) {
      if (!M.inited || !(M.visible || CC.visible)) return;
      dt = clamp(_num(dt, 0.016), 0, 0.1);
      M.t += dt;
      const cam = Menu.getCamera();
      if (!M.camInit) _setupMenuCamera();
      const t = M.t;
      // slow figure-of-eight drift west of Hobbiton, looking east toward the sunrise
      const a = t * 0.028;
      _camWant.set(CAM_CENTER.x + Math.cos(a) * 70, 0, CAM_CENTER.z + Math.sin(a * 2) * 45);
      const gy = Math.max(_groundY(_camWant.x, _camWant.z), _groundY(_camWant.x + 25, _camWant.z), _groundY(_camWant.x + 50, _camWant.z - 10), _groundY(_camWant.x, _camWant.z + 25));
      _camWant.y = gy + 15 + Math.sin(t * 0.21) * 1.6;
      const k = 1 - Math.exp(-dt * 0.9);
      _camPos.lerp(_camWant, k);
      const fx = CAM_FOCUS.x + Math.sin(t * 0.05) * 30, fz = CAM_FOCUS.z + Math.cos(t * 0.037) * 40;
      _camTarget.set(fx, _groundY(fx, fz) + 5 + Math.sin(t * 0.17) * 0.8, fz);
      _camLook.lerp(_camTarget, k);
      cam.position.copy(_camPos);
      cam.up.copy(_camUp);
      cam.lookAt(_camLook);
      cam.rotateZ(Math.sin(t * 0.13) * 0.006);
      if (cam === M.camera) { const asp = (window.innerWidth || 1280) / (window.innerHeight || 720); if (Math.abs(cam.aspect - asp) > 1e-3) { cam.aspect = asp; cam.updateProjectionMatrix(); } }
      if (M.driveWorld && G.state.phase !== 'playing') {
        try { if (G.Terrain && G.Terrain.ready && _has(G.Terrain, 'update')) G.Terrain.update(_camPos, dt); } catch (err) { _report(err, 'Menu.update.terrain'); M.driveWorld = false; }
        try { if (G.Veg && _has(G.Veg, 'update')) G.Veg.update(_camPos, dt); } catch (err) { _report(err, 'Menu.update.veg'); M.driveWorld = false; }
        try { if (G.Buildings && _has(G.Buildings, 'update')) G.Buildings.update(_camPos, dt); } catch (err) { _report(err, 'Menu.update.buildings'); M.driveWorld = false; }
        try { if (G.Sky && G.Sky.sun && _has(G.Sky, 'update')) G.Sky.update(dt, _camPos); } catch (err) { _report(err, 'Menu.update.sky'); M.driveWorld = false; }
      }
    },
    closeModal: function () {
      if (!M.modal) return;
      const m = M.modal; M.modal = null;
      if (m.parentNode) m.parentNode.removeChild(m);
    },
    openControls: function () {
      _modal('Controls', function (body) {
        const grid = el('div', { class: 'mm-controls' });
        CONTROLS.forEach(function (row) {
          const keys = el('div');
          row[0].split(' / ').forEach(function (k, i) { if (i) keys.appendChild(document.createTextNode(' ')); keys.appendChild(el('span', { class: 'keycap', text: k })); });
          grid.appendChild(keys); grid.appendChild(el('div', { text: row[1] }));
        });
        body.appendChild(grid);
        body.appendChild(el('div', { class: 'muted small', style: 'margin-top:12px', text: 'Typing the word "chris" anywhere opens the admin panel.' }));
      }, null, 680);
    },
    openCredits: function () {
      _modal('Credits', function (body) {
        const roll = el('div', { class: 'mm-credits-roll' });
        CREDITS.forEach(function (c) {
          if (c[0] === 'gap') roll.appendChild(el('div', { class: 'c-gap' }));
          else roll.appendChild(el('div', { class: 'c-' + c[0], text: c[1] }));
        });
        body.appendChild(el('div', { class: 'mm-credits' }, [roll]));
      }, null, 620);
    },
    openSettings: function () {
      if (_has(UI, 'getPanel') && UI.getPanel('settings') && _has(UI, 'openPanel')) { UI.openPanel('settings'); return; }
      const S = G.state.settings || (G.state.settings = { music: 0.6, sfx: 0.8, mouseSens: 1, invertY: false, showFps: false, cameraDist: 7, shadows: true });
      _modal('Settings', function (body) {
        const wrap = el('div', { class: 'mm-settings' });
        const slider = function (label, key, min, max, step, fmt, onChange) {
          const val = el('span', { class: 'val', text: fmt(S[key]) });
          const inp = el('input', { type: 'range', min: min, max: max, step: step, value: S[key] });
          inp.addEventListener('input', function () { S[key] = parseFloat(inp.value); val.textContent = fmt(S[key]); if (onChange) onChange(S[key]); });
          wrap.appendChild(el('label', { class: 'row' }, [el('span', { text: label }), el('span', {}, [inp, val])]));
        };
        const applyVol = function () { try { if (_has(G.Audio, 'setVolumes')) G.Audio.setVolumes(S.music, S.sfx); } catch (_) { /* ignore */ } };
        slider('Music volume', 'music', 0, 1, 0.01, function (v) { return Math.round(v * 100) + '%'; }, applyVol);
        slider('Effects volume', 'sfx', 0, 1, 0.01, function (v) { return Math.round(v * 100) + '%'; }, applyVol);
        slider('Mouse sensitivity', 'mouseSens', 0.2, 3, 0.05, function (v) { return v.toFixed(2) + '×'; });
        const q = el('select', {}, ['auto', 'ultra', 'high', 'medium', 'low'].map(function (o) { return el('option', { value: o, text: _cap(o), selected: (G.state.quality || 'high') === o }); }));
        q.addEventListener('change', function () { try { if (_has(G.PostFX, 'setQuality')) G.PostFX.setQuality(q.value); else G.state.quality = q.value; } catch (_) { G.state.quality = q.value; } });
        wrap.appendChild(el('label', { class: 'row' }, [el('span', { text: 'Graphics quality' }), q]));
        const cb = function (label, key) { const c = el('input', { type: 'checkbox', checked: !!S[key] }); c.addEventListener('change', function () { S[key] = !!c.checked; }); wrap.appendChild(el('label', { class: 'row' }, [el('span', { text: label }), c])); };
        cb('Invert mouse Y', 'invertY'); cb('Show FPS counter', 'showFps'); cb('Shadows', 'shadows');
        body.appendChild(wrap);
      }, [{ label: 'Done', cls: 'primary', onClick: function () { Menu.closeModal(); G.emit('settingsChanged'); } }], 480);
    },
  };

  // ================================================================================================ CHARACTER CREATION
  const CC = {
    inited: false, visible: false, root: null, els: {}, spec: null, raceCards: {}, classCards: {}, raf: 0, lastT: 0,
    renderer: null, scene: null, camera: null, rig: null, rigGroup: null, pedestal: null, rotY: PI, autoRot: true, dragging: false, dragX: 0, dragVel: 0, resumeAt: 0,
    fakeEnt: null, rebuild: null, descOpen: { race: false, cls: false }, keyLight: null, fillLight: null, rimLight: null, fxT: 0,
  };
  function _defaultSpec() {
    const r = _raceById('man') || {}; const c = _classById('guardian') || {};
    return {
      name: '', gender: 'male', race: r.id || 'man', cls: c.id || 'guardian',
      skin: (r.skinTones && r.skinTones[1]) || 0xe3b48f, hairColor: (r.hairColors && r.hairColors[1]) || 0x4a2f1a, hairStyle: 0,
      eyeColor: EYE_COLORS[0], height: 1, build: r.build || 'normal', beard: 0,
    };
  }
  function _applyRaceDefaults(spec, keepLook) {
    const r = _raceById(spec.race); if (!r) return;
    const st = r.skinTones || [], hc = r.hairColors || [];
    if (!keepLook || st.indexOf(spec.skin) < 0) spec.skin = st[Math.min(1, st.length - 1)] != null ? st[Math.min(1, st.length - 1)] : spec.skin;
    if (!keepLook || hc.indexOf(spec.hairColor) < 0) spec.hairColor = hc[Math.min(1, hc.length - 1)] != null ? hc[Math.min(1, hc.length - 1)] : spec.hairColor;
    const maxStyle = Math.max(1, Math.min(5, r.hairStyles || 5));
    if (spec.hairStyle !== 5 && spec.hairStyle >= maxStyle) spec.hairStyle = 0;
    if (!keepLook) spec.build = r.build || 'normal';
    if (!BEARD_RACES[r.id] || spec.gender === 'female') spec.beard = 0;
  }
  function _heightMetres(spec) {
    const r = _raceById(spec.race);
    return 1.8 * ((r && r.height) || 1) * _num(spec.height, 1) * (spec.gender === 'female' ? 0.95 : 1);
  }

  function _buildCreate() {
    const R = CC.root = _ensureRoot('charCreate');
    while (R.firstChild) R.removeChild(R.firstChild);
    const e = CC.els;
    // ---- top bar
    const top = el('div', { class: 'cc-top' }, [
      el('div', { class: 'cc-ring' }, [_ringArt(40, true)]),
      el('div', {}, [el('h1', { text: 'Create your hero' }), el('div', { class: 'cc-sub', text: 'Choose a people, a calling and a face — then step into Middle-earth.' })]),
      el('div', { class: 'grow' }),
      el('button', { class: 'btn', text: '✧ Surprise me', onclick: function () { _sfx('ui_click'); CharCreate.randomise(); } }),
      el('button', { class: 'btn', text: '◂ Back to menu', onclick: function () { _sfx('ui_close'); CharCreate.hide(); Menu.show(); } }),
    ]);
    // ---- name + gender
    e.name = el('input', { type: 'text', maxLength: 16, placeholder: 'Your name…', spellcheck: false, autocomplete: 'off' });
    e.name.addEventListener('input', function () { CC.spec.name = e.name.value; e.name.classList.remove('bad'); e.nameErr.textContent = ''; _refreshPreviewLabels(); });
    e.name.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); e.name.blur(); } ev.stopPropagation(); });
    e.nameErr = el('div', { class: 'cc-name-err' });
    const rndBtn = el('button', { class: 'btn', text: '⚄ Random', onclick: function () { _sfx('ui_click'); _randomName(); } });
    const gIcon = function (male) {
      return _svg('svg', { viewBox: '0 0 16 16' }, [male
        ? _svg('path', { d: 'M9 1h6v6l-2-2-2.6 2.6A4.5 4.5 0 116 6.1l2.6-2.6L9 3zM6 8a2.5 2.5 0 100 5 2.5 2.5 0 000-5z' })
        : _svg('path', { d: 'M8 1a4 4 0 011 7.87V11h2v2H9v2H7v-2H5v-2h2V8.87A4 4 0 018 1zm0 2a2 2 0 100 4 2 2 0 000-4z' })]);
    };
    e.gM = el('div', { class: 'g active' }, [gIcon(true), 'Male']); e.gF = el('div', { class: 'g' }, [gIcon(false), 'Female']);
    e.gM.addEventListener('click', function () { _setGender('male'); }); e.gF.addEventListener('click', function () { _setGender('female'); });
    const secName = el('div', { class: 'cc-section' }, [
      el('div', { class: 'section-title' }, [el('span', { class: 'n', text: '1' }), 'Name & Gender']),
      el('div', { class: 'cc-name-row' }, [e.name, rndBtn, el('div', { class: 'cc-gender' }, [e.gM, e.gF])]),
      e.nameErr,
    ]);
    // ---- race
    e.raceGrid = el('div', { class: 'cc-grid' });
    _races().forEach(function (r) {
      const meta = RACE_META[r.id] || { tag: r.plural || '', glyph: RACE_META.man.glyph };
      const card = el('div', { class: 'cc-card', data: { race: r.id } }, [
        _svg('svg', { class: 'glyph', viewBox: '0 0 32 32' }, [_svg('path', { d: meta.glyph })]),
        el('div', { class: 'nm', text: r.name }), el('div', { class: 'tg', text: meta.tag }),
      ]);
      card.addEventListener('click', function () { _setRace(r.id); });
      card.addEventListener('mouseenter', function () { _sfx('ui_click', { vol: 0.25, pitch: 1.3 }); });
      CC.raceCards[r.id] = card; e.raceGrid.appendChild(card);
    });
    e.raceDetail = el('div', { class: 'cc-detail' });
    const secRace = el('div', { class: 'cc-section' }, [el('div', { class: 'section-title' }, [el('span', { class: 'n', text: '2' }), 'Race']), e.raceGrid, e.raceDetail]);
    // ---- class
    e.classGrid = el('div', { class: 'cc-grid' });
    _classes().forEach(function (c) {
      const card = el('div', { class: 'cc-card', data: { cls: c.id } }, [
        el('div', { class: 'cicon', style: { background: 'radial-gradient(circle at 40% 35%, ' + _hex(c.color) + ', ' + _hex(G.lerpColor ? G.lerpColor(c.color, 0x000000, 0.6) : c.color) + ')' }, text: c.icon || '✦' }),
        el('div', { class: 'nm', text: c.name }),
        el('div', { class: 'role', style: { color: ROLE_COLOR[c.role] || '#fff' }, text: ROLE_LABEL[c.role] || c.role }),
      ]);
      card.addEventListener('click', function () { _setClass(c.id); });
      card.addEventListener('mouseenter', function () { _sfx('ui_click', { vol: 0.25, pitch: 1.3 }); });
      CC.classCards[c.id] = card; e.classGrid.appendChild(card);
    });
    e.classDetail = el('div', { class: 'cc-detail' });
    const secClass = el('div', { class: 'cc-section' }, [el('div', { class: 'section-title' }, [el('span', { class: 'n', text: '3' }), 'Class']), e.classGrid, e.classDetail]);
    // ---- appearance
    e.skin = el('div', { class: 'cc-swatches' }); e.hairStyle = el('div', { class: 'cc-seg' }); e.hairColor = el('div', { class: 'cc-swatches' }); e.eyes = el('div', { class: 'cc-swatches' });
    e.beardRow = []; e.beard = el('div', { class: 'cc-seg' });
    e.height = el('input', { type: 'range', min: 0.9, max: 1.1, step: 0.005, value: 1 });
    e.heightVal = el('span', { class: 'val' });
    e.height.addEventListener('input', function () { CC.spec.height = parseFloat(e.height.value); e.heightVal.textContent = _heightMetres(CC.spec).toFixed(2) + ' m'; _scheduleRebuild(); });
    e.build = el('div', { class: 'cc-seg' });
    BUILDS.forEach(function (b) { const s = el('div', { class: 's', text: _cap(b), data: { build: b } }); s.addEventListener('click', function () { CC.spec.build = b; _refreshAppearance(); _scheduleRebuild(); _sfx('ui_click'); }); e.build.appendChild(s); });
    const app = el('div', { class: 'cc-app' });
    const row = function (label, ctrl) { const l = el('div', { class: 'lbl', text: label }); app.appendChild(l); app.appendChild(ctrl); return [l, ctrl]; };
    row('Skin', e.skin); row('Hair', e.hairStyle); row('Hair colour', e.hairColor); row('Eyes', e.eyes); e.beardRow = row('Beard', e.beard);
    row('Height', el('div', { class: 'cc-range' }, [e.height, e.heightVal])); row('Build', e.build);
    const secApp = el('div', { class: 'cc-section' }, [el('div', { class: 'section-title' }, [el('span', { class: 'n', text: '4' }), 'Appearance']), app]);
    // ---- stats
    e.stats = el('div', { class: 'cc-stats' });
    e.statNote = el('div', { class: 'cc-stat-note' });
    const secStats = el('div', { class: 'cc-section' }, [el('div', { class: 'section-title' }, [el('span', { class: 'n', text: '5' }), 'Starting attributes — level 1']), e.stats, e.statNote]);
    // ---- left column layout
    const left = el('div', { class: 'cc-left' }, [el('div', { class: 'cc-col' }, [secName, secRace, secClass]), el('div', { class: 'cc-col' }, [secApp, secStats])]);
    // ---- right column: preview + enter
    e.pvName = el('div', { class: 'n' }); e.pvSub = el('div', { class: 's' }); e.pvHome = el('div', { class: 'pv-home' });
    e.preview = el('div', { class: 'cc-preview' }, [el('div', { class: 'rays' }), el('div', { class: 'vig' }), el('div', { class: 'pv-name' }, [e.pvName, e.pvSub]), e.pvHome, el('div', { class: 'pv-hint', text: 'Drag to rotate' })]);
    e.previewWrap = el('div', { class: 'cc-preview-wrap' }, [e.preview]);
    e.enterBtn = el('button', { class: 'btn primary big', text: 'Enter Middle-earth', onclick: function () { CharCreate.confirm(); } });
    const right = el('div', { class: 'cc-right' }, [e.previewWrap, el('div', { class: 'cc-enter' }, [e.enterBtn, el('div', { class: 'note', text: 'You can change your appearance later at any barber in Bree — but never your name.' })])]);
    R.appendChild(top);
    R.appendChild(el('div', { class: 'cc-body' }, [left, right]));
    // preview drag
    e.preview.addEventListener('mousedown', function (ev) { if (ev.button !== 0) return; CC.dragging = true; CC.dragX = ev.clientX; CC.dragVel = 0; e.preview.classList.add('dragging'); ev.preventDefault(); });
    window.addEventListener('mousemove', function (ev) { if (!CC.dragging) return; const dx = ev.clientX - CC.dragX; CC.dragX = ev.clientX; CC.rotY += dx * 0.012; CC.dragVel = dx * 0.012; });
    window.addEventListener('mouseup', function () { if (!CC.dragging) return; CC.dragging = false; e.preview.classList.remove('dragging'); CC.resumeAt = _now() + 2.5; });
    e.preview.addEventListener('touchstart', function (ev) { if (ev.touches.length) { CC.dragging = true; CC.dragX = ev.touches[0].clientX; } }, { passive: true });
    e.preview.addEventListener('touchmove', function (ev) { if (CC.dragging && ev.touches.length) { const dx = ev.touches[0].clientX - CC.dragX; CC.dragX = ev.touches[0].clientX; CC.rotY += dx * 0.012; } }, { passive: true });
    e.preview.addEventListener('touchend', function () { CC.dragging = false; CC.resumeAt = _now() + 2.5; });
    window.addEventListener('keydown', function (ev) {
      if (!CC.visible) return;
      const t = ev.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
      if (ev.code === 'Escape') { ev.preventDefault(); _sfx('ui_close'); CharCreate.hide(); Menu.show(); }
    }, true);
    CC.rebuild = _debounce(_rebuildRig, 80);
  }

  // ---- selection handlers
  function _setGender(g) {
    if (CC.spec.gender === g) return;
    CC.spec.gender = g; _sfx('ui_click');
    _applyRaceDefaults(CC.spec, true);
    _refreshAll();
  }
  function _setRace(id) {
    if (CC.spec.race === id) return;
    CC.spec.race = id; _sfx('ui_click');
    CC.descOpen.race = false;
    _applyRaceDefaults(CC.spec, false);
    _refreshAll();
  }
  function _setClass(id) {
    if (CC.spec.cls === id) return;
    CC.spec.cls = id; _sfx('ui_click');
    CC.descOpen.cls = false;
    _refreshAll();
  }
  function _randomName() {
    const s = CC.spec;
    let n = '';
    try { if (G.Data && _has(G.Data, 'randomName')) n = G.Data.randomName(s.race, s.gender, _rng); } catch (err) { _report(err, 'CharCreate.randomName'); }
    if (!n) n = _pick(['Halbert', 'Rowan', 'Tilda', 'Berin', 'Elwen', 'Dorin']);
    n = _cap(String(n).replace(/[^A-Za-zÀ-ÿ]/g, '').slice(0, 16));
    s.name = n; CC.els.name.value = n; CC.els.name.classList.remove('bad'); CC.els.nameErr.textContent = '';
    _refreshPreviewLabels();
  }
  function _refreshAll() { _refreshCards(); _refreshRaceDetail(); _refreshClassDetail(); _refreshAppearance(); _refreshStats(); _refreshPreviewLabels(); _scheduleRebuild(); }
  function _refreshCards() {
    const s = CC.spec;
    for (const id in CC.raceCards) CC.raceCards[id].classList.toggle('selected', id === s.race);
    for (const id in CC.classCards) CC.classCards[id].classList.toggle('selected', id === s.cls);
    CC.els.gM.classList.toggle('active', s.gender !== 'female'); CC.els.gF.classList.toggle('active', s.gender === 'female');
  }
  function _descBlock(text, key) {
    const d = el('div', { class: 'cc-desc' + (CC.descOpen[key] ? ' open' : ''), text: text || '' });
    const more = el('div', { class: 'cc-more', text: CC.descOpen[key] ? 'Show less' : 'Read more' });
    more.addEventListener('click', function () { CC.descOpen[key] = !CC.descOpen[key]; d.classList.toggle('open', CC.descOpen[key]); more.textContent = CC.descOpen[key] ? 'Show less' : 'Read more'; });
    return [d, more];
  }
  function _refreshRaceDetail() {
    const box = CC.els.raceDetail; while (box.firstChild) box.removeChild(box.firstChild);
    const r = _raceById(CC.spec.race); if (!r) return;
    const chips = el('div', { class: 'cc-chips' });
    const sb = r.statBonus || {};
    ['might', 'agility', 'vitality', 'will', 'fate'].forEach(function (k) { const v = _num(sb[k], 0); if (!v) return; chips.appendChild(el('span', { class: 'cc-chip ' + (v > 0 ? 'pos' : 'neg'), text: (v > 0 ? '+' : '−') + Math.abs(v) + ' ' + STAT_LABEL[k] })); });
    let home = null;
    try { const sp = _has(G.Data, 'startPosFor') ? G.Data.startPosFor(r.id) : null; home = sp ? { town: sp.town, zone: sp.zone } : { town: r.startTown, zone: r.homeZone }; } catch (_) { home = { town: r.startTown, zone: r.homeZone }; }
    chips.appendChild(el('span', { class: 'cc-chip info', html: '<b>Home</b>' + esc(_townName(home.town)) + ', ' + esc(_zoneName(home.zone)) }));
    chips.appendChild(el('span', { class: 'cc-chip', html: '<b>Height</b>' + esc(_heightMetres({ race: r.id, gender: CC.spec.gender, height: 1 }).toFixed(2)) + ' m' }));
    const trait = r.racialTrait || {};
    let traitFx = '';
    try { if (_has(G.Data, 'describeBonus')) traitFx = G.Data.describeBonus(trait, 1); } catch (_) { traitFx = ''; }
    box.appendChild(el('div', { class: 'hd' }, [el('h3', { text: r.name }), el('span', { class: 'muted', text: (RACE_META[r.id] || {}).tag || r.plural || '' })]));
    box.append.apply(box, _descBlock(r.desc, 'race'));
    box.appendChild(chips);
    if (trait.name) box.appendChild(el('div', { class: 'cc-trait', html: '<b>' + esc(trait.name) + '</b> — ' + esc(trait.desc || '') + (traitFx ? ' <span class="muted">(' + esc(traitFx) + ')</span>' : '') }));
  }
  function _refreshClassDetail() {
    const box = CC.els.classDetail; while (box.firstChild) box.removeChild(box.firstChild);
    const c = _classById(CC.spec.cls); if (!c) return;
    const chips = el('div', { class: 'cc-chips' }, [
      el('span', { class: 'cc-chip', style: { color: ROLE_COLOR[c.role] || '#fff' }, html: '<b>Role</b>' + esc(ROLE_LABEL[c.role] || c.role) }),
      el('span', { class: 'cc-chip', html: '<b>Main stat</b>' + esc(STAT_LABEL[c.mainStat] || _cap(c.mainStat)) }),
      el('span', { class: 'cc-chip', html: '<b>Armour</b>' + esc(_cap(c.armourType)) }),
      el('span', { class: 'cc-chip', html: '<b>Ranged</b>' + esc(_cap(c.rangedWeapon)) }),
      el('span', { class: 'cc-chip', html: '<b>Weapons</b>' + esc((c.weaponTypes || []).map(_cap).join(', ')) }),
    ]);
    box.appendChild(el('div', { class: 'hd' }, [el('h3', { text: c.name, style: { color: _hex(c.color) } }), el('span', { class: 'muted', text: 'Signature abilities at levels 1, 1 and 4' })]));
    box.append.apply(box, _descBlock(c.desc, 'cls'));
    box.appendChild(chips);
    let abils = [];
    try { if (_has(G.Data, 'abilitiesFor')) abils = G.Data.abilitiesFor(c.id).slice(0, 3); } catch (_) { abils = []; }
    if (abils.length) {
      const grid = el('div', { class: 'cc-abils' });
      abils.forEach(function (a) {
        const item = el('div', { class: 'cc-abil' }, [el('div', { class: 'icon', text: a.icon || '✦' }), el('div', { class: 'txt' }, [el('div', { class: 'an', text: a.name }), el('div', { class: 'al', text: 'Level ' + a.level + ' · ' + _cap(a.kind || '') })])]);
        _tooltip(item, function () { try { return _has(G.Data, 'abilityTooltipHTML') ? G.Data.abilityTooltipHTML(a) : '<div class="tt-name">' + esc(a.name) + '</div><div class="tt-desc">' + esc(a.descPlain || a.desc || '') + '</div>'; } catch (_) { return esc(a.name); } });
        grid.appendChild(item);
      });
      box.appendChild(grid);
    }
  }
  function _swatch(hex, selected, title, onClick) {
    const s = el('div', { class: 'cc-swatch' + (selected ? ' selected' : ''), style: { background: 'radial-gradient(circle at 35% 30%, ' + _hex(G.lerpColor ? G.lerpColor(hex, 0xffffff, 0.25) : hex) + ', ' + _hex(hex) + ' 55%, ' + _hex(G.lerpColor ? G.lerpColor(hex, 0x000000, 0.35) : hex) + ')' }, title: title || '' });
    s.addEventListener('click', function () { onClick(); _sfx('ui_click'); });
    return s;
  }
  function _refreshAppearance() {
    const e = CC.els, s = CC.spec, r = _raceById(s.race) || {};
    const fill = function (host) { while (host.firstChild) host.removeChild(host.firstChild); };
    fill(e.skin); (r.skinTones || []).forEach(function (h) { e.skin.appendChild(_swatch(h, h === s.skin, 'Skin tone', function () { s.skin = h; _refreshAppearance(); _scheduleRebuild(); })); });
    fill(e.hairColor); (r.hairColors || []).forEach(function (h) { e.hairColor.appendChild(_swatch(h, h === s.hairColor, 'Hair colour', function () { s.hairColor = h; _refreshAppearance(); _scheduleRebuild(); })); });
    fill(e.eyes); EYE_COLORS.forEach(function (h, i) { e.eyes.appendChild(_swatch(h, h === s.eyeColor, EYE_NAMES[i], function () { s.eyeColor = h; _refreshAppearance(); _scheduleRebuild(); })); });
    fill(e.hairStyle);
    const n = Math.max(1, Math.min(5, r.hairStyles || 5));
    for (let i = 0; i <= n; i++) {
      const style = i === n ? 5 : i;
      const b = el('div', { class: 's' + (s.hairStyle === style ? ' active' : ''), text: HAIR_NAMES[style] || ('Style ' + (i + 1)) });
      b.addEventListener('click', function () { s.hairStyle = style; _refreshAppearance(); _scheduleRebuild(); _sfx('ui_click'); });
      e.hairStyle.appendChild(b);
    }
    const beardOk = !!BEARD_RACES[s.race] && s.gender !== 'female';
    e.beardRow[0].hidden = !beardOk; e.beardRow[1].hidden = !beardOk;
    fill(e.beard);
    if (beardOk) ['None', 'Short', 'Long'].forEach(function (lbl, i) { const b = el('div', { class: 's' + (s.beard === i ? ' active' : ''), text: lbl }); b.addEventListener('click', function () { s.beard = i; _refreshAppearance(); _scheduleRebuild(); _sfx('ui_click'); }); e.beard.appendChild(b); });
    e.height.value = s.height; e.heightVal.textContent = _heightMetres(s).toFixed(2) + ' m';
    Array.prototype.forEach.call(e.build.children, function (c) { c.classList.toggle('active', c.dataset.build === s.build); });
  }
  function _refreshStats() {
    const host = CC.els.stats; while (host.firstChild) host.removeChild(host.firstChild);
    const s = CC.spec, c = _classById(s.cls), r = _raceById(s.race);
    let st = null;
    try { if (G.Data && G.Data.stats && _has(G.Data.stats, 'preview')) st = G.Data.stats.preview(s.cls, s.race, 1, s.gender); } catch (err) { _report(err, 'CharCreate.statsPreview'); st = null; }
    if (!st && c) { st = Object.assign({}, c.baseStats || {}); st.maxMorale = _num(c.baseMorale, 0) + _num(c.moralePerLevel, 0); st.maxPower = _num(c.basePower, 0) + _num(c.powerPerLevel, 0); }
    if (!st) return;
    const sb = (r && r.statBonus) || {};
    ['might', 'agility', 'vitality', 'will', 'fate', 'maxMorale', 'maxPower', 'armour'].forEach(function (k) {
      if (st[k] == null) return;
      const bonus = _num(sb[k], 0);
      const row = el('div', { class: 'cc-stat' + (c && c.mainStat === k ? ' main' : '') }, [
        el('span', { class: 'k', text: STAT_LABEL[k] || _cap(k) }),
        el('span', { class: 'v', text: String(Math.round(st[k])) }, bonus ? [el('span', { class: 'b ' + (bonus > 0 ? 'pos' : 'neg'), text: (bonus > 0 ? '+' : '−') + Math.abs(bonus) })] : null),
      ]);
      host.appendChild(row);
    });
    const pct = [];
    if (st.critChance != null) pct.push('Crit ' + _num(st.critChance).toFixed(1) + '%');
    if (st.mitigation != null) pct.push('Mitigation ' + _num(st.mitigation).toFixed(1) + '%');
    if (st.evadeChance != null) pct.push('Evade ' + _num(st.evadeChance).toFixed(1) + '%');
    CC.els.statNote.textContent = (c ? _cap(c.mainStat) + ' is the ' + c.name + '\'s main stat. ' : '') + (pct.length ? pct.join(' · ') + '. ' : '') + 'Race bonuses shown in colour.';
  }
  function _refreshPreviewLabels() {
    const e = CC.els, s = CC.spec, r = _raceById(s.race), c = _classById(s.cls);
    e.pvName.textContent = s.name ? _cap(s.name.trim()) : 'Nameless hero';
    e.pvSub.textContent = (s.gender === 'female' ? 'Female ' : 'Male ') + (r ? r.name : '') + ' ' + (c ? c.name : '');
    let home = null;
    try { home = r && _has(G.Data, 'startPosFor') ? G.Data.startPosFor(r.id) : (r ? { town: r.startTown, zone: r.homeZone } : null); } catch (_) { home = null; }
    e.pvHome.innerHTML = home ? '<b>Starts in</b> ' + esc(_townName(home.town)) + ', ' + esc(_zoneName(home.zone)) : '';
  }

  // ---- 3D preview
  const PV_W = 420, PV_H = 560;
  function _initPreview() {
    if (CC.renderer) return true;
    try {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(PV_W, PV_H, false);
      renderer.setClearColor(0x000000, 0);
      renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(30, PV_W / PV_H, 0.1, 60);
      // three-point rig: warm key (casts the shadow), cool rim, soft fill, plus a faint hemisphere
      const key = new THREE.DirectionalLight(0xffd9b0, 3.2); key.position.set(2.6, 4.4, 3.2); key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024); key.shadow.camera.left = -2.2; key.shadow.camera.right = 2.2; key.shadow.camera.top = 3.4; key.shadow.camera.bottom = -1; key.shadow.camera.near = 0.5; key.shadow.camera.far = 14; key.shadow.bias = -0.0006; key.shadow.normalBias = 0.02;
      const rim = new THREE.DirectionalLight(0x86b4ff, 2.4); rim.position.set(-2.4, 3.2, -3.4);
      const fill = new THREE.DirectionalLight(0xc8b8a8, 0.9); fill.position.set(-3, 1.6, 2.6);
      const hemi = new THREE.HemisphereLight(0x6f7fa8, 0x2a2018, 0.55);
      const amb = new THREE.AmbientLight(0x3a3028, 0.5);
      scene.add(key, rim, fill, hemi, amb);
      // pedestal
      const ped = new THREE.Group();
      const stoneTex = _has(G, 'canvasTexture') ? G.canvasTexture(256, 256, function (ctx, w, h) {
        ctx.fillStyle = '#6a625a'; ctx.fillRect(0, 0, w, h);
        let sd = 7;
        const rnd = function () { sd = (sd * 1103515245 + 12345) & 0x7fffffff; return sd / 0x7fffffff; };
        for (let i = 0; i < 2600; i++) { const g = 80 + Math.floor(rnd() * 60); ctx.fillStyle = 'rgba(' + g + ',' + (g - 6) + ',' + (g - 12) + ',' + (0.25 + rnd() * 0.5) + ')'; ctx.fillRect(rnd() * w, rnd() * h, 1 + rnd() * 3, 1 + rnd() * 3); }
        ctx.strokeStyle = 'rgba(30,26,22,.55)'; ctx.lineWidth = 2;
        for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.moveTo(rnd() * w, rnd() * h); ctx.lineTo(rnd() * w, rnd() * h); ctx.stroke(); }
      }, { repeat: [2, 1], wrap: true }) : null;
      const stone = new THREE.MeshStandardMaterial({ color: 0x8a8078, roughness: 0.88, metalness: 0.02, map: stoneTex || null });
      const top = new THREE.Mesh(new THREE.CylinderGeometry(1.02, 1.08, 0.16, 56), stone); top.position.y = -0.08; top.receiveShadow = true; top.castShadow = false;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.14, 1.22, 0.2, 56), stone); base.position.y = -0.26; base.receiveShadow = true;
      const ringMat = new THREE.MeshStandardMaterial({ color: 0xd4af5a, roughness: 0.35, metalness: 0.85, emissive: 0x4a3410, emissiveIntensity: 0.25 });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.02, 0.022, 10, 80), ringMat); ring.rotation.x = PI / 2; ring.position.y = 0.002;
      const ring2 = new THREE.Mesh(new THREE.TorusGeometry(0.82, 0.012, 8, 72), ringMat); ring2.rotation.x = PI / 2; ring2.position.y = 0.003;
      const glowTex = _has(G, 'canvasTexture') ? G.canvasTexture(128, 128, function (ctx, w, h) { const g = ctx.createRadialGradient(w / 2, h / 2, 2, w / 2, h / 2, w / 2); g.addColorStop(0, 'rgba(255,214,140,0.55)'); g.addColorStop(0.5, 'rgba(255,190,110,0.18)'); g.addColorStop(1, 'rgba(255,170,90,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, w, h); }, { wrap: false }) : null;
      if (glowTex) { const glow = new THREE.Mesh(new THREE.PlaneGeometry(4.4, 4.4), new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false })); glow.rotation.x = -PI / 2; glow.position.y = -0.35; ped.add(glow); }
      ped.add(top, base, ring, ring2);
      scene.add(ped);
      // faint dust motes
      const N = 90, pos = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) { pos[i * 3] = (_rng() - 0.5) * 3.2; pos[i * 3 + 1] = _rng() * 2.6; pos[i * 3 + 2] = (_rng() - 0.5) * 3.2; }
      const dustGeo = new THREE.BufferGeometry(); dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: 0xffe0a8, size: 0.018, transparent: true, opacity: 0.55, depthWrite: false }));
      scene.add(dust);
      CC.renderer = renderer; CC.scene = scene; CC.camera = camera; CC.pedestal = ped; CC.dust = dust; CC.keyLight = key; CC.rimLight = rim; CC.fillLight = fill;
      CC.fakeEnt = { id: 'preview', kind: 'player', name: 'preview', pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, onGround: true, alive: true, anim: 'idle', target: null, level: 1 };
      CC.els.preview.insertBefore(renderer.domElement, CC.els.preview.firstChild);
      return true;
    } catch (err) {
      _report(err, 'CharCreate.initPreview');
      CC.renderer = null;
      return false;
    }
  }
  function _starterEquipment(clsId) {
    const map = {};
    try {
      if (!G.Items || !_has(G.Items, 'starterGear')) return map;
      const list = G.Items.starterGear(clsId) || [];
      for (let i = 0; i < list.length; i++) {
        const inst = list[i]; if (!inst) continue;
        const v = _has(G.Items, 'get') ? G.Items.get(inst) : (G.Data.items && G.Data.items[inst.tid]);
        const slot = v && v.slot; if (!slot) continue;
        if (!map[slot]) map[slot] = inst;
        else if (slot === 'ear1' && !map.ear2) map.ear2 = inst; else if (slot === 'wrist1' && !map.wrist2) map.wrist2 = inst; else if (slot === 'ring1' && !map.ring2) map.ring2 = inst;
      }
    } catch (err) { _report(err, 'CharCreate.starterGear'); }
    return map;
  }
  function _scheduleRebuild() { if (CC.visible && CC.rebuild) CC.rebuild(); }
  function _disposeRig() {
    if (CC.rig) { try { if (CC.rig.group && CC.rig.group.parent) CC.rig.group.parent.remove(CC.rig.group); CC.rig.dispose(); } catch (_) { /* ignore */ } }
    CC.rig = null;
  }
  function _rebuildRig() {
    if (!CC.visible || !CC.renderer) return;
    if (!G.Chars || !_has(G.Chars, 'buildHumanoid')) return;
    const s = CC.spec, c = _classById(s.cls);
    _disposeRig();
    try {
      const rig = G.Chars.buildHumanoid({
        race: s.race, gender: s.gender, cls: s.cls, name: s.name || 'hero', skin: s.skin, hairColor: s.hairColor, hairStyle: s.hairStyle, eyeColor: s.eyeColor,
        height: s.height, build: s.build, beard: s.beard, armourType: c ? c.armourType : 'light', equipment: _starterEquipment(s.cls),
      });
      if (!rig || !rig.group) return;
      rig.group.traverse(function (o) { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      rig.group.rotation.y = CC.rotY;
      CC.scene.add(rig.group);
      CC.rig = rig;
      if (_has(rig, 'setAnim')) rig.setAnim('idle', true);
      // pre-roll a little so the pose has settled before the first frame
      for (let i = 0; i < 6; i++) rig.play(1 / 30, CC.fakeEnt);
      _frameCamera(rig.height || 1.8);
    } catch (err) { _report(err, 'CharCreate.buildRig'); }
  }
  function _frameCamera(H) {
    const cam = CC.camera; if (!cam) return;
    const dist = 2.45 * H + 0.55;
    cam.position.set(0.02, H * 0.52, dist);
    cam.lookAt(0, H * 0.5 - 0.02, 0);
    cam.updateProjectionMatrix();
    if (CC.keyLight) { CC.keyLight.shadow.camera.top = H * 1.4; CC.keyLight.shadow.camera.updateProjectionMatrix(); }
  }
  function _sizePreview() {
    const e = CC.els; if (!e.previewWrap) return;
    const wrapW = e.previewWrap.clientWidth || 420, wrapH = e.previewWrap.clientHeight || 560;
    let h = Math.min(wrapH - 4, 640), w = h * (PV_W / PV_H);
    if (w > wrapW) { w = wrapW; h = w * (PV_H / PV_W); }
    e.preview.style.width = Math.floor(w) + 'px'; e.preview.style.height = Math.floor(h) + 'px';
  }
  function _previewFrame() {
    CC.raf = 0;
    if (!CC.visible || !CC.renderer) return;
    const now = _now();
    let dt = now - (CC.lastT || now); CC.lastT = now;
    dt = clamp(dt, 0, 0.05);
    if (!CC.dragging) {
      if (now >= CC.resumeAt) CC.rotY += dt * 0.28;
      else { CC.rotY += CC.dragVel; CC.dragVel *= 0.9; }
    }
    try {
      if (CC.rig) { CC.rig.group.rotation.y = CC.rotY; CC.rig.play(dt, CC.fakeEnt); }
      if (_has(G.Chars, 'update')) G.Chars.update(dt);
      CC.fxT += dt;
      if (CC.dust) { CC.dust.rotation.y = CC.fxT * 0.05; CC.dust.position.y = Math.sin(CC.fxT * 0.4) * 0.05; }
      if (CC.rimLight) CC.rimLight.intensity = 2.4 + Math.sin(CC.fxT * 1.3) * 0.3;
      CC.renderer.render(CC.scene, CC.camera);
    } catch (err) { _report(err, 'CharCreate.render'); }
    CC.raf = requestAnimationFrame(_previewFrame);
  }

  // ---- validation / confirm
  function _validateName(name) {
    name = String(name == null ? '' : name).trim();
    if (name.length < 2) return { ok: false, reason: 'Your name must be at least 2 letters long.' };
    if (name.length > 16) return { ok: false, reason: 'Your name may be at most 16 letters long.' };
    if (!/^[A-Za-zÀ-ÖØ-öø-ÿ]+$/.test(name)) return { ok: false, reason: 'Use letters only — no spaces, numbers or symbols.' };
    if (RESERVED.indexOf(name.toLowerCase()) >= 0) return { ok: false, reason: 'That name belongs to a hero of legend. Choose your own.' };
    try {
      if (G.AIPlayers && _has(G.AIPlayers, 'list')) {
        const list = G.AIPlayers.list() || [];
        for (let i = 0; i < list.length; i++) if (list[i] && String(list[i].name || '').toLowerCase() === name.toLowerCase()) return { ok: false, reason: 'Another traveller already bears that name.' };
      }
    } catch (_) { /* ignore */ }
    return { ok: true, name: _cap(name.toLowerCase()) };
  }

  const CharCreate = UI.CharCreate = {
    get visible() { return CC.visible; },
    init: function () {
      if (CC.inited) return CharCreate;
      CC.inited = true;
      _injectCSS(CSS);
      CC.spec = _defaultSpec();
      _applyRaceDefaults(CC.spec, false);
      _buildCreate();
      CC.root.hidden = true;
      return CharCreate;
    },
    show: function () {
      if (!CC.inited) CharCreate.init();
      if (M.visible) Menu.hide();
      if (!CC.spec.name) { try { CC.spec.name = _has(G.Data, 'randomName') ? _cap(String(G.Data.randomName(CC.spec.race, CC.spec.gender, _rng) || '').replace(/[^A-Za-zÀ-ÿ]/g, '').slice(0, 16)) : ''; } catch (_) { CC.spec.name = ''; } }
      CC.els.name.value = CC.spec.name || '';
      CC.els.name.classList.remove('bad'); CC.els.nameErr.textContent = '';
      _fadeIn(CC.root, 600);
      CC.visible = true;
      CC.rotY = PI; CC.resumeAt = _now() + 3.5; CC.lastT = _now();
      _sizePreview();
      _initPreview();
      _refreshAll();
      if (CC.rebuild) { CC.rebuild.cancel(); }
      _rebuildRig();
      if (!CC.raf) CC.raf = requestAnimationFrame(_previewFrame);
      try { if (_has(G.Audio, 'music')) G.Audio.music('menu'); } catch (_) { /* ignore */ }
      G.emit('createShown');
      return CharCreate;
    },
    hide: function () {
      if (!CC.inited || !CC.visible) return;
      CC.visible = false;
      if (CC.raf) { cancelAnimationFrame(CC.raf); CC.raf = 0; }
      if (CC.rebuild) CC.rebuild.cancel();
      _disposeRig();
      CC.root.hidden = true; CC.root.classList.remove('cj-enter', 'cj-leave');
      G.emit('createHidden');
    },
    getSpec: function () {
      const s = CC.spec || _defaultSpec();
      return { name: _cap(String(s.name || '').trim()), gender: s.gender, race: s.race, cls: s.cls, skin: s.skin, hairColor: s.hairColor, hairStyle: s.hairStyle, eyeColor: s.eyeColor, height: s.height, build: s.build, beard: s.beard };
    },
    setSpec: function (partial) {
      if (!CC.inited) CharCreate.init();
      if (!partial || typeof partial !== 'object') return CharCreate.getSpec();
      const s = CC.spec;
      if (partial.race && _raceById(partial.race) && _raceById(partial.race).id === partial.race) s.race = partial.race;
      if (partial.cls && _classById(partial.cls) && _classById(partial.cls).id === partial.cls) s.cls = partial.cls;
      if (partial.gender === 'male' || partial.gender === 'female') s.gender = partial.gender;
      if (typeof partial.name === 'string') s.name = partial.name.slice(0, 16);
      ['skin', 'hairColor', 'eyeColor', 'hairStyle', 'beard'].forEach(function (k) { if (typeof partial[k] === 'number') s[k] = partial[k]; });
      if (typeof partial.height === 'number') s.height = clamp(partial.height, 0.9, 1.1);
      if (BUILDS.indexOf(partial.build) >= 0) s.build = partial.build;
      _applyRaceDefaults(s, true);
      if (CC.els.name) CC.els.name.value = s.name || '';
      if (CC.visible) _refreshAll(); else { _refreshCards(); _refreshRaceDetail(); _refreshClassDetail(); _refreshAppearance(); _refreshStats(); _refreshPreviewLabels(); }
      return CharCreate.getSpec();
    },
    randomise: function () {
      if (!CC.inited) CharCreate.init();
      const s = CC.spec, races = _races(), classes = _classes();
      if (races.length) s.race = _pick(races).id;
      if (classes.length) s.cls = _pick(classes).id;
      s.gender = _rng() < 0.5 ? 'male' : 'female';
      const r = _raceById(s.race) || {};
      s.skin = (r.skinTones && r.skinTones.length) ? _pick(r.skinTones) : s.skin;
      s.hairColor = (r.hairColors && r.hairColors.length) ? _pick(r.hairColors) : s.hairColor;
      s.hairStyle = _rng() < 0.08 ? 5 : Math.floor(_rng() * Math.max(1, Math.min(5, r.hairStyles || 5)));
      s.eyeColor = _pick(EYE_COLORS);
      s.height = Math.round((0.92 + _rng() * 0.16) * 100) / 100;
      s.build = _rng() < 0.6 ? (r.build || 'normal') : _pick(BUILDS);
      s.beard = (BEARD_RACES[s.race] && s.gender !== 'female') ? Math.floor(_rng() * 3) : 0;
      CC.descOpen.race = false; CC.descOpen.cls = false;
      _randomName();
      _refreshAll();
      return CharCreate.getSpec();
    },
    validateName: _validateName,
    confirm: function () {
      if (!CC.inited || !CC.visible) return false;
      const e = CC.els;
      const v = _validateName(e.name.value);
      if (!v.ok) {
        e.name.classList.remove('bad'); void e.name.offsetWidth; e.name.classList.add('bad');
        e.nameErr.textContent = v.reason; e.name.focus();
        _sfx('ui_error');
        return false;
      }
      CC.spec.name = v.name; e.name.value = v.name;
      const spec = CharCreate.getSpec();
      e.enterBtn.disabled = true;
      _sfx('quest_accept');
      G.emit('createConfirmed', spec);
      _fadeOut(CC.root, 600, function () {
        CC.visible = false;
        if (CC.raf) { cancelAnimationFrame(CC.raf); CC.raf = 0; }
        _disposeRig();
        e.enterBtn.disabled = false;
        G.emit('createHidden');
        if (_has(G.Game, 'startNew')) { try { G.Game.startNew(spec); } catch (err) { _report(err, 'CharCreate.startNew'); CharCreate.show(); } }
        else { if (G.warn) G.warn('CharCreate: G.Game.startNew is not available'); }
      });
      return true;
    },
  };

  // ------------------------------------------------------------------------------------------------ auto-init: the loading screen must be visible as early as possible
  function _autoInit() { try { Menu.init(); } catch (err) { _report(err, 'Menu.autoInit'); } }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _autoInit); else _autoInit();
  G.on('init', function () { if (!M.inited) _autoInit(); });
})();
