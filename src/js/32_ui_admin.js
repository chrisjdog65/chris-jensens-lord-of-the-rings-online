/* ==== 32_ui_admin.js — G.UI.Admin: the admin panel for Chris Jensen's Lord of the Rings Online. Opens when the
   letters `chris` are typed (G.Input.onSequence, registered at init) or via the chat command `/chris` (the chat
   module calls G.UI.Admin.open()). One panel `admin` (880 × 640, centred) with a vertical tab strip on the left
   and a scrollable content area; every control applies immediately and shows a toast through G.UI.notify().
   Tabs: Player · Items · Teleport · Quests · World · AI Players · Map · Settings/Debug · Save (SPEC §7.3).
   A golden "ADMIN" chip is shown in the HUD while any gameplay override is active.

   Public API (G.UI.Admin):
     init()                 register panel + CSS + `chris` sequence + HUD chip (idempotent; also runs on G 'init')
     open() → bool          closes every other panel (G.UI.closeAll), opens the admin panel, sfx 'admin_open'
     close(), isOpen(), refresh() (re-draws the current tab), showTab(id), tab (current tab id), TABS (ids)
     overridesActive() → bool   god mode / damage × / speed × / no cooldowns / noclip / free-fly / time scale ≠ 1
     update(dt)             live refresh (hooked to the 'update' bus event; safe to call manually)
     Helpers usable from other modules / the console: setLevel(L), giveItem(tid, n), spawnMonster(typeId, opts),
     addPlace(name, x, z, icon), removePlace(id), teleportTo(x, z, label), teleportToNpc(npcId)
   State it OWNS on G.state (all read by other modules, all persisted by 34_save):
     godMode (bool)      damageMult (number, 1 = normal)    speedMult (number; ALSO mirrored onto player.speedMult,
     which is what 20_player reads)    noCooldowns (bool)    noclip (bool)    flyCam (bool)    freeTraining (bool,
     true only while "Learn all abilities" runs)    customPlaces ([{id, name, x, z, icon}] — the M map / minimap
     draw them)    clockPaused (bool — implemented by stretching G.time.dayLengthMinutes, restored on resume)
     wireframe (bool)    topDown (bool)
   Events emitted: customPlacesChanged (array), townRenamed ({id, name}), adminOverride ({key, value}).
   Assumptions about other modules (every call is guarded; a missing API yields a "… is not available" toast):
     G.UI registerPanel/openPanel/closePanel/closeAll/notify/confirm/addCSS/setWaypoint/minimap.redraw/Map.pickOnce,
     G.Player.teleport/cam, G.Progress.setLevel/addXP/addGold/trainAbility/setHotbar/awardTitle/ensurePlayerShape,
     G.Items.*, G.Data.stats.compute / xp.forLevel / titles / abilitiesFor, G.Data.world.*, G.Quests.* (§6.5 +
     forceComplete/reset), G.Monsters.spawnAt/killAllNear/respawnAll/despawn/all/stats, G.NPCs.get,
     G.AIPlayers.list/get/teleportTo/setLevel/setActive/chatEnabled/spawnNear, G.Sky.setTime/setWeather/WEATHER_KINDS/
     autoWeather/rollWeather/lightning, G.PostFX.setQuality/params/stats/enabled, G.Physics.debugMesh/debugVisible,
     G.Game.scene/renderer/fps, G.Terrain.reload (optional), G.Veg.setDensity, G.Save.exportJSON/importJSON/save/clear/hasSave.
   Private helpers are file-local (prefixed with nothing but scoped to this closure). ==== */
(function () {
  'use strict';
  const G = window.G;
  if (!G) return;
  const UI = G.UI = G.UI || {};
  const Admin = {};
  UI.Admin = Admin;

  // ------------------------------------------------------------------------------------------------ tiny utils
  const el = G.el || function (tag, attrs, children) {
    const e = document.createElement(tag || 'div');
    if (attrs) for (const k in attrs) { if (k === 'text') e.textContent = attrs[k]; else if (k === 'html') e.innerHTML = attrs[k]; else if (k === 'class') e.className = attrs[k]; else if (typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]); else e.setAttribute(k, attrs[k]); }
    if (children) (Array.isArray(children) ? children : [children]).forEach(function (c) { if (c == null) return; e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  };
  const esc = G.escapeHTML || function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  const PI = Math.PI, TAU = Math.PI * 2;
  function num(v, d) { v = +v; return (v === v && isFinite(v)) ? v : (d || 0); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function str(v) { return v == null ? '' : String(v); }
  function has(o, k) { return !!(o && typeof o[k] === 'function'); }
  function player() { return (G.state && G.state.player) || null; }
  function world() { return (G.Data && G.Data.world) || null; }
  function C() { return G.C || {}; }
  function levelCap() { return num(C().LEVEL_CAP, 80) || 80; }
  function emit(evt, a) { if (typeof G.emit === 'function') G.emit(evt, a); }
  function report(err, where) { if (typeof G.reportError === 'function') G.reportError(err, where); else if (typeof G.warn === 'function') G.warn(where + ': ' + (err && err.message)); }
  function sfx(name, opts) { try { if (G.Audio && typeof G.Audio.sfx === 'function') G.Audio.sfx(name, opts); } catch (_) { /* audio is optional */ } }
  function toast(text, kind) { if (has(UI, 'notify')) UI.notify(text, kind || 'info'); else if (typeof G.log === 'function') G.log('[admin] ' + text); }
  function warn(text) { toast(text, 'warning'); return false; }
  function na(what) { return warn(what + ' is not available.'); }
  function confirmThen(text, fn) { if (has(UI, 'confirm')) UI.confirm(text, fn, null, { title: 'Admin', yes: 'Do it', no: 'Cancel' }); else fn(); }
  function fmtMoney(c) { return typeof G.fmtMoney === 'function' ? G.fmtMoney(c) : Math.round(num(c)) + 'c'; }
  function fmtNum(n) { return typeof G.fmtNum === 'function' ? G.fmtNum(n) : String(Math.round(num(n))); }
  function clock(h) { h = ((num(h, 8) % 24) + 24) % 24; const hh = Math.floor(h), mm = Math.floor((h - hh) * 60); return (hh < 10 ? '0' : '') + hh + ':' + (mm < 10 ? '0' : '') + mm; }
  function computeStats(p) { try { if (G.Data && G.Data.stats && typeof G.Data.stats.compute === 'function') G.Data.stats.compute(p); } catch (err) { report(err, 'admin stats.compute'); } }
  function className(id) { const c = G.Data && G.Data.classById && G.Data.classById[id]; return c ? c.name : (typeof G.titleCase === 'function' ? G.titleCase(str(id)) : str(id)); }
  function raceName(id) { const r = G.Data && G.Data.raceById && G.Data.raceById[id]; return r ? r.name : (typeof G.titleCase === 'function' ? G.titleCase(str(id)) : str(id)); }
  function zoneName(id) { const w = world(); const z = w && w.zoneById && w.zoneById[id]; return z ? z.name : (id ? (typeof G.titleCase === 'function' ? G.titleCase(str(id)) : str(id)) : ''); }
  function npcData(id) { const w = world(); if (!w || !id) return null; if (w.npcById && w.npcById[id]) return w.npcById[id]; if (Array.isArray(w.npcs)) for (let i = 0; i < w.npcs.length; i++) if (w.npcs[i].id === id) return w.npcs[i]; return null; }
  function questData(id) { const D = G.Data; if (!D || !id) return null; if (D.questById && D.questById[id]) return D.questById[id]; if (Array.isArray(D.quests)) for (let i = 0; i < D.quests.length; i++) if (D.quests[i].id === id) return D.quests[i]; return null; }
  function rarityColor(r) { return (C().RARITY_COLOR && C().RARITY_COLOR[r]) || '#d9d9d9'; }
  function rand() { return typeof G.rand === 'function' ? G.rand() : Math.random(); }
  function ensureShape(p) {
    if (!p) return p;
    if (G.Progress && has(G.Progress, 'ensurePlayerShape')) { try { G.Progress.ensurePlayerShape(p); } catch (_) { /* fall through */ } }
    if (!(p.abilities instanceof Set)) p.abilities = new Set(Array.isArray(p.abilities) ? p.abilities : []);
    if (!Array.isArray(p.hotbar)) p.hotbar = new Array(20).fill(null);
    if (!p.cooldowns || typeof p.cooldowns !== 'object') p.cooldowns = {};
    if (!Array.isArray(p.titles)) p.titles = [];
    if (!Array.isArray(p.mounts)) p.mounts = [];
    if (!p.statBonus || typeof p.statBonus !== 'object') p.statBonus = {};
    if (typeof p.gold !== 'number' || !isFinite(p.gold)) p.gold = 0;
    if (typeof p.xp !== 'number' || !isFinite(p.xp)) p.xp = 0;
    if (!p.equipment || typeof p.equipment !== 'object') p.equipment = {};
    if (!Array.isArray(p.inventory)) p.inventory = new Array(num(C().INVENTORY_SLOTS, 200) || 200).fill(null);
    return p;
  }
  function ensureState() {
    const st = G.state || (G.state = {});
    if (!Array.isArray(st.customPlaces)) st.customPlaces = [];
    if (typeof st.damageMult !== 'number' || !isFinite(st.damageMult)) st.damageMult = 1;
    if (typeof st.speedMult !== 'number' || !isFinite(st.speedMult)) st.speedMult = 1;
    if (typeof st.godMode !== 'boolean') st.godMode = !!st.godMode;
    if (typeof st.noCooldowns !== 'boolean') st.noCooldowns = !!st.noCooldowns;
    if (typeof st.noclip !== 'boolean') st.noclip = !!st.noclip;
    if (typeof st.flyCam !== 'boolean') st.flyCam = !!st.flyCam;
    if (!st.settings || typeof st.settings !== 'object') st.settings = {};
    if (!G.time) G.time = { now: 0, dt: 0, frame: 0, dayTime: 8, dayLengthMinutes: 24, scale: 1, paused: false };
    return st;
  }
  function setOverride(key, value) {
    const st = ensureState();
    st[key] = value;
    if (key === 'speedMult') { const p = player(); if (p) p.speedMult = value; }
    emit('adminOverride', { key: key, value: value });
    updateChip();
  }

  // ------------------------------------------------------------------------------------------------ DOM builders
  function btn(label, onClick, cls, title) {
    const b = el('button', { class: 'btn' + (cls ? ' ' + cls : ''), title: title || null, html: label });
    b.addEventListener('click', function (e) {
      e.preventDefault();
      try { onClick(e, b); } catch (err) { report(err, 'admin:' + b.textContent); warn('That did not work: ' + (err && err.message ? err.message : err)); }
    });
    return b;
  }
  function numIn(value, min, max, step, width, placeholder) {
    const i = el('input', { type: 'number', min: min == null ? null : min, max: max == null ? null : max, step: step == null ? 1 : step, placeholder: placeholder || null, style: { width: (width || 72) + 'px' } });
    if (value != null && value !== '') i.value = String(value);
    return i;
  }
  function textIn(value, placeholder, width) { const i = el('input', { type: 'text', placeholder: placeholder || null, style: { width: (width || 180) + 'px' } }); i.value = str(value); return i; }
  function selectIn(options, value, width) {
    const s = el('select', { style: width ? { width: width + 'px' } : null });
    for (let i = 0; i < options.length; i++) { const o = options[i]; s.appendChild(el('option', { value: str(o.value), text: str(o.label) })); }
    if (value != null) s.value = str(value);
    return s;
  }
  function row(children, cls) { return el('div', { class: 'adm-row' + (cls ? ' ' + cls : '') }, children); }
  function section(title, children, right) {
    const head = el('div', { class: 'section-title adm-sec-title' }, [el('span', { text: title }), right || null]);
    return el('div', { class: 'adm-sec' }, [head].concat(children || []));
  }
  function lbl(text, width) { return el('span', { class: 'adm-lbl', text: text, style: width ? { minWidth: width + 'px' } : null }); }
  function hint(text) { return el('div', { class: 'adm-hint', text: text }); }
  function muted(text) { return el('div', { class: 'muted adm-muted', text: text }); }
  function grid(children, cls) { return el('div', { class: 'adm-grid' + (cls ? ' ' + cls : '') }, children); }
  function pill(text, cls) { return el('span', { class: 'chip ' + (cls || ''), text: text }); }
  function toggle(label, get, set, title) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!get();
    const w = el('label', { class: 'adm-toggle' + (cb.checked ? ' on' : ''), title: title || null }, [cb, el('span', { class: 'adm-track' }), el('span', { class: 'adm-tlabel', text: label })]);
    cb.addEventListener('change', function () {
      try { set(cb.checked); } catch (err) { report(err, 'admin toggle ' + label); warn('That did not work: ' + (err && err.message)); }
      w.classList.toggle('on', !!get());
      cb.checked = !!get();
    });
    w.refresh = function () { const v = !!get(); if (cb.checked !== v) cb.checked = v; w.classList.toggle('on', v); };
    return w;
  }
  function slider(label, min, max, step, get, set, fmt) {
    const r = el('input', { type: 'range', min: min, max: max, step: step });
    r.value = String(num(get(), min));
    const val = el('span', { class: 'val', text: (fmt || String)(num(get(), min)) });
    const w = el('div', { class: 'adm-slider' }, [lbl(label), r, val]);
    r.addEventListener('input', function () {
      const v = num(r.value, min);
      try { set(v); } catch (err) { report(err, 'admin slider ' + label); }
      val.textContent = (fmt || String)(v);
    });
    w.refresh = function () { if (document.activeElement === r) return; const v = num(get(), min); if (num(r.value, min) !== v) r.value = String(v); val.textContent = (fmt || String)(v); };
    return w;
  }
  function kv(pairs) {
    const box = el('div', { class: 'adm-kv' });
    const cells = [];
    for (let i = 0; i < pairs.length; i++) { const v = el('span'); cells.push(v); box.appendChild(el('div', {}, [el('b', { text: pairs[i][0] }), v])); }
    box.set = function (i, text) { if (cells[i]) cells[i].textContent = str(text); };
    return box;
  }
  function bar(cls) { const fill = el('div', { class: 'fill ' + cls }); const text = el('div', { class: 'text' }); const b = el('div', { class: 'bar' }, [fill, text]); b.fill = fill; b.txt = text; b.set = function (v, m, label) { const f = m > 0 ? clamp(v / m, 0, 1) : 0; fill.style.width = (f * 100).toFixed(1) + '%'; text.textContent = label != null ? label : (fmtNum(v) + ' / ' + fmtNum(m)); }; return b; }
  function iconHTML(t) { try { if (G.Items && has(G.Items, 'iconHTML')) return G.Items.iconHTML(t, 'sm'); } catch (_) { /* fallback below */ } return '<div class="icon sm">' + esc((t && t.icon) || '▪') + '</div>'; }
  function iconEl(t) { return el('span', { class: 'adm-ico', html: iconHTML(t) }); }

  // ------------------------------------------------------------------------------------------------ live refresh
  let liveFns = [];
  function live(fn) { liveFns.push(fn); try { fn(); } catch (err) { report(err, 'admin live'); } return fn; }

  // ------------------------------------------------------------------------------------------------ CSS
  const CSS = `
#panel-admin .panel-body { padding: 0; display: flex; overflow: hidden; }
#panel-admin .panel-title { background: linear-gradient(180deg, rgba(150,110,40,.6), rgba(50,34,12,.65)); }
.adm-body { display: flex; }
.adm-tabs { width: 160px; flex: 0 0 160px; display: flex; flex-direction: column; background: rgba(0,0,0,.35); border-right: 1px solid var(--border); padding: 6px 0; }
.adm-tab { display: flex; align-items: center; gap: 9px; padding: 8px 12px; cursor: pointer; font-family: var(--font-head); font-size: 12px; letter-spacing: .06em; color: var(--parch-dim); border-left: 3px solid transparent; user-select: none; }
.adm-tab:hover { color: var(--gold-bright); background: rgba(212,175,90,.08); }
.adm-tab.active { color: var(--gold-bright); background: var(--panel-3); border-left-color: var(--gold); }
.adm-tab-ico { width: 18px; text-align: center; font-size: 15px; line-height: 1; }
.adm-tabs-foot { margin-top: auto; padding: 8px 12px; font-size: 11px; color: var(--parch-dim); line-height: 1.45; font-family: var(--font-ui); }
.adm-tabs-foot b { color: var(--gold); }
.adm-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.adm-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 14px; border-bottom: 1px solid var(--border); background: rgba(0,0,0,.25); }
.adm-head h3 { font-size: 16px; white-space: nowrap; }
.adm-status { font-size: 12px; color: var(--parch-dim); font-family: var(--font-ui); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.adm-content { flex: 1; min-height: 0; overflow: auto; padding: 8px 14px 16px; }
.adm-sec { margin-bottom: 10px; }
.adm-sec-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
.adm-sec-title .btn, .adm-sec-title .adm-toggle { text-transform: none; letter-spacing: .03em; }
.adm-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 5px 0; }
.adm-row .sep { width: 1px; height: 20px; background: var(--border); margin: 0 4px; }
.adm-lbl { min-width: 74px; color: var(--gold); font-family: var(--font-head); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
.adm-unit { color: var(--parch-dim); font-size: 12px; margin-left: -4px; }
.adm-hint { font-size: 12px; color: var(--parch-dim); font-style: italic; margin: 2px 0 4px; }
.adm-muted { padding: 12px 4px; font-style: italic; }
.adm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); gap: 4px; }
.adm-grid.wide { grid-template-columns: repeat(auto-fill, minmax(215px, 1fr)); }
.adm-grid .btn { justify-content: flex-start; font-size: 11px; padding: 4px 8px; overflow: hidden; letter-spacing: .02em; min-width: 0; }
.adm-grid .btn .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.adm-grid .btn .sub { margin-left: auto; padding-left: 6px; color: var(--parch-dim); font-family: var(--font-ui); font-size: 10px; flex: 0 0 auto; }
.adm-card { display: flex; gap: 14px; align-items: center; background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; padding: 8px 12px; margin-bottom: 8px; }
.adm-card .who { min-width: 190px; }
.adm-card .who .nm { font-family: var(--font-head); font-size: 17px; color: var(--gold-bright); }
.adm-card .who .sub { font-size: 12px; color: var(--parch-dim); font-family: var(--font-ui); }
.adm-card .bars { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 200px; }
.adm-card .bar { height: 13px; }
.adm-card .gold { font-family: var(--font-ui); font-size: 14px; white-space: nowrap; }
.adm-toggle { display: inline-flex; align-items: center; gap: 7px; cursor: pointer; font-size: 13px; padding: 3px 8px 3px 4px; border: 1px solid transparent; border-radius: 4px; user-select: none; }
.adm-toggle:hover { border-color: var(--border); }
.adm-toggle input { display: none; }
.adm-track { width: 30px; height: 15px; border-radius: 8px; background: rgba(0,0,0,.6); border: 1px solid var(--border); position: relative; transition: background .15s; flex: 0 0 auto; }
.adm-track::after { content: ''; position: absolute; left: 2px; top: 2px; width: 9px; height: 9px; border-radius: 50%; background: var(--parch-dim); transition: left .15s, background .15s; }
.adm-toggle input:checked + .adm-track { background: rgba(212,175,90,.45); border-color: var(--gold); }
.adm-toggle input:checked + .adm-track::after { left: 17px; background: var(--gold-bright); }
.adm-toggle.on .adm-tlabel { color: var(--gold-bright); }
.adm-slider { display: flex; align-items: center; gap: 8px; margin: 4px 0; }
.adm-slider input[type=range] { flex: 1; min-width: 120px; }
.adm-slider .val { min-width: 52px; text-align: right; font-family: var(--font-ui); font-size: 12px; color: var(--gold-bright); }
.adm-list { display: flex; flex-direction: column; gap: 1px; max-height: 292px; overflow: auto; border: 1px solid var(--border); border-radius: 4px; background: rgba(0,0,0,.3); }
.adm-item { display: flex; align-items: center; gap: 8px; padding: 2px 6px; font-size: 13px; min-height: 30px; }
.adm-item:hover { background: rgba(212,175,90,.10); }
.adm-item .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.adm-item .meta { color: var(--parch-dim); font-size: 11px; font-family: var(--font-ui); white-space: nowrap; }
.adm-item .btn.small { padding: 2px 7px; }
.adm-ico .icon.sm { width: 24px; height: 24px; font-size: 14px; }
.adm-count { font-size: 12px; color: var(--parch-dim); margin: 4px 0; font-family: var(--font-ui); }
.adm-kv { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 3px 16px; font-family: var(--font-ui); font-size: 13px; }
.adm-kv div { display: flex; justify-content: space-between; gap: 8px; border-bottom: 1px dotted rgba(255,255,255,.1); padding: 1px 0; }
.adm-kv b { color: var(--gold); font-weight: 600; }
.adm-stats { display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px; margin: 4px 0; }
.adm-stat { background: rgba(0,0,0,.35); border: 1px solid var(--border); border-radius: 4px; padding: 6px; text-align: center; }
.adm-stat .k { font-family: var(--font-head); font-size: 11px; color: var(--gold); letter-spacing: .06em; }
.adm-stat .v { font-size: 18px; color: #fff; line-height: 1.2; }
.adm-stat .v small { font-size: 11px; color: var(--parch-dim); }
.adm-stat input { width: 100%; margin-top: 4px; text-align: center; }
.adm-eq { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 10px; }
.adm-eq .adm-item { cursor: pointer; border: 1px solid transparent; border-radius: 3px; }
.adm-eq .adm-item.selected { border-color: var(--gold); background: rgba(212,175,90,.15); }
.adm-eq .slot { width: 70px; flex: 0 0 70px; color: var(--parch-dim); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; font-family: var(--font-ui); }
.adm-editor { margin-top: 8px; background: var(--panel-2); border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; }
.adm-editor .sgrid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px 10px; margin: 6px 0; }
.adm-editor .sgrid label { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12px; font-family: var(--font-ui); }
.adm-editor .sgrid input { width: 72px; }
table.data.adm-table td { vertical-align: middle; }
table.data.adm-table .acts { white-space: nowrap; text-align: right; }
table.data.adm-table .acts .btn { margin-left: 2px; padding: 2px 6px; font-size: 10px; }
table.data.adm-table .qn { max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.adm-st { display: inline-block; font-size: 10px; padding: 0 6px; border-radius: 3px; border: 1px solid var(--border); background: rgba(0,0,0,.5); text-transform: uppercase; letter-spacing: .06em; font-family: var(--font-ui); }
.adm-st.available { color: var(--parch-dim); } .adm-st.active { color: #8fd0ff; border-color: #3a6a8a; }
.adm-st.complete { color: var(--gold-bright); border-color: var(--gold-dim); } .adm-st.done { color: #7fd47a; border-color: #2f6a2c; }
textarea.adm-ta { width: 100%; height: 150px; font-family: Consolas, Menlo, monospace; font-size: 11px; resize: vertical; line-height: 1.3; }
.adm-place { display: flex; align-items: center; gap: 8px; padding: 3px 6px; border-bottom: 1px solid rgba(255,255,255,.06); }
.adm-place .glyph { width: 24px; text-align: center; font-size: 16px; color: var(--gold-bright); }
.adm-place .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.adm-place .meta { color: var(--parch-dim); font-size: 11px; font-family: var(--font-ui); }
.adm-bar-wrap { display: flex; align-items: center; gap: 10px; margin: 4px 0 6px; }
.adm-bar-wrap .bar { flex: 1; height: 14px; }
.adm-errs { max-height: 120px; overflow: auto; font-family: Consolas, Menlo, monospace; font-size: 11px; color: #ffb3a7; background: rgba(0,0,0,.4); border: 1px solid var(--border); border-radius: 4px; padding: 4px 6px; white-space: pre-wrap; }
.adm-note { font-size: 12px; color: #c9b98a; margin: 4px 0; font-family: var(--font-ui); }
#adminChip { position: absolute; left: 50%; top: 48px; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 2px 10px 2px 8px; border-radius: 12px; background: linear-gradient(180deg, rgba(96,70,22,.92), rgba(40,28,8,.92)); border: 1px solid var(--gold); color: var(--gold-bright); font-family: var(--font-head); font-size: 11px; letter-spacing: .18em; text-shadow: 0 1px 2px #000; box-shadow: 0 0 10px rgba(255,224,138,.35); cursor: pointer; white-space: nowrap; z-index: 5; }
#adminChip .crown { letter-spacing: 0; font-size: 12px; }
#adminChip .det { letter-spacing: .02em; font-family: var(--font-ui); color: var(--parch); font-size: 11px; }
`;

  // ------------------------------------------------------------------------------------------------ panel shell
  const TABS = [
    { id: 'player', label: 'Player', icon: '☺' },
    { id: 'items', label: 'Items', icon: '⚔' },
    { id: 'teleport', label: 'Teleport', icon: '➶' },
    { id: 'quests', label: 'Quests', icon: '❖' },
    { id: 'world', label: 'World', icon: '☀' },
    { id: 'ai', label: 'AI Players', icon: '♟' },
    { id: 'map', label: 'Map', icon: '✦' },
    { id: 'debug', label: 'Settings / Debug', icon: '⚙' },
    { id: 'save', label: 'Save', icon: '✎' },
  ];
  const BUILDERS = {};
  const S = {
    inited: false, tab: 'player', panel: null, body: null, tabsEl: null, headEl: null, contentEl: null,
    chip: null, chipDet: null, tickT: 0, chipT: 0, unsub: null,
    giveCount: 1, wire: null, camSaved: null, dayLenBeforePause: 24, pfxDefaults: null, townOrig: {}, lastSelSlot: null,
  };

  function buildPanel(body, panel) {
    S.body = body; S.panel = panel;
    body.classList.add('adm-body');
    S.tabsEl = el('div', { class: 'adm-tabs' });
    for (let i = 0; i < TABS.length; i++) {
      const t = TABS[i];
      const b = el('div', { class: 'adm-tab', data: { tab: t.id } }, [el('span', { class: 'adm-tab-ico', text: t.icon }), el('span', { class: 'adm-tab-lbl', text: t.label })]);
      b.addEventListener('click', function () { Admin.showTab(t.id); });
      S.tabsEl.appendChild(b);
    }
    S.tabsEl.appendChild(el('div', { class: 'adm-tabs-foot', html: 'Type <b>chris</b> or <b>/chris</b><br>to open · v' + esc(G.VERSION || '1.0.0') }));
    S.headEl = el('div', { class: 'adm-head' });
    S.contentEl = el('div', { class: 'adm-content' });
    body.appendChild(S.tabsEl);
    body.appendChild(el('div', { class: 'adm-main' }, [S.headEl, S.contentEl]));
    renderTab();
  }
  function statusStrip() {
    const s = el('div', { class: 'adm-status' });
    live(function () {
      const p = player();
      if (!p) { s.textContent = 'No character in the world yet — most controls need one.'; return; }
      const parts = [p.name || '?', 'L' + num(p.level, 1) + ' ' + raceName(p.race) + ' ' + className(p.cls), zoneName(G.state.zone),
        p.pos ? '(' + Math.round(p.pos.x) + ', ' + Math.round(p.pos.z) + ')' : '', clock(G.time && G.time.dayTime)];
      s.textContent = parts.filter(Boolean).join(' · ');
    });
    return s;
  }
  function renderTab() {
    if (!S.contentEl) return;
    let t = null;
    for (let i = 0; i < TABS.length; i++) if (TABS[i].id === S.tab) t = TABS[i];
    if (!t) { t = TABS[0]; S.tab = t.id; }
    liveFns = [];
    const kids = S.tabsEl.children;
    for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('active', kids[i].dataset && kids[i].dataset.tab === t.id);
    while (S.contentEl.firstChild) S.contentEl.removeChild(S.contentEl.firstChild);
    while (S.headEl.firstChild) S.headEl.removeChild(S.headEl.firstChild);
    S.contentEl.scrollTop = 0;
    S.headEl.appendChild(el('h3', { text: t.label }));
    S.headEl.appendChild(statusStrip());
    try { BUILDERS[t.id](S.contentEl); }
    catch (err) { report(err, 'admin tab ' + t.id); S.contentEl.appendChild(muted('This tab could not be drawn: ' + (err && err.message))); }
  }
  function noPlayer(root) { root.appendChild(muted('There is no player character yet. Enter the world first (or use G.__T.quickStart()).')); }

  // ================================================================================================ PLAYER
  const PRIMARY = ['might', 'agility', 'vitality', 'will', 'fate'];
  function statName(k) { const N = G.Data && G.Data.stats && G.Data.stats.STAT_NAMES; return (N && N[k]) || (typeof G.titleCase === 'function' ? G.titleCase(k) : k); }

  function setLevel(L) {
    const p = player(); if (!p) return na('Player');
    ensureShape(p);
    L = Math.round(clamp(num(L, 1), 1, levelCap()));
    if (G.Progress && has(G.Progress, 'setLevel')) G.Progress.setLevel(L);
    else {
      p.level = L;
      if (G.Data && G.Data.xp && has(G.Data.xp, 'forLevel')) p.xp = G.Data.xp.forLevel(L);
      computeStats(p);
      if (p.stats) { p.morale = num(p.stats.maxMorale, p.morale); p.power = num(p.stats.maxPower, p.power); }
      emit('playerLevelUp', L);
    }
    toast('Level set to ' + L);
    return true;
  }
  function addXP(n) {
    const p = player(); if (!p) return na('Player');
    ensureShape(p);
    n = Math.round(num(n, 0)); if (n <= 0) return warn('Enter a positive XP amount');
    if (G.Progress && has(G.Progress, 'addXP')) G.Progress.addXP(n);
    else {
      const X = G.Data && G.Data.xp; const cap = levelCap();
      p.xp += n;
      if (X && has(X, 'forLevel')) { let guard = 0; while (p.level < cap && p.xp >= X.forLevel(p.level + 1) && guard++ < cap) { p.level++; emit('playerLevelUp', p.level); } }
      computeStats(p);
    }
    toast('+' + fmtNum(n) + ' XP');
    return true;
  }
  function setGold(copper) {
    const p = player(); if (!p) return na('Player');
    ensureShape(p);
    p.gold = Math.max(0, Math.round(num(copper, 0)));
    emit('goldChanged', p.gold);
    toast('Purse set to ' + fmtMoney(p.gold), 'gold');
    return true;
  }
  function addGold(copper) {
    const p = player(); if (!p) return na('Player');
    ensureShape(p);
    copper = Math.round(num(copper, 0)); if (!copper) return warn('Enter an amount');
    if (G.Progress && has(G.Progress, 'addGold')) G.Progress.addGold(copper, { silent: true });
    else { p.gold = Math.max(0, p.gold + copper); emit('goldChanged', p.gold); }
    toast((copper > 0 ? 'Received ' : 'Removed ') + fmtMoney(Math.abs(copper)) + ' — purse: ' + fmtMoney(p.gold), 'gold');
    return true;
  }
  function fullHeal() {
    const p = player(); if (!p) return na('Player');
    computeStats(p);
    if (p.dead || p.alive === false) {
      if (G.Combat && has(G.Combat, 'revive')) G.Combat.revive(p, 1);
      else { p.alive = true; p.dead = false; }
    }
    if (p.stats) { p.morale = num(p.stats.maxMorale, p.morale); p.power = num(p.stats.maxPower, p.power); }
    if (Array.isArray(p.effects)) { for (let i = p.effects.length - 1; i >= 0; i--) { const e = p.effects[i]; if (e && (e.kind === 'debuff' || e.kind === 'dot' || e.kind === 'stun' || e.kind === 'root' || e.kind === 'slow')) { if (G.Combat && has(G.Combat, 'removeEffect')) G.Combat.removeEffect(p, e.id); else p.effects.splice(i, 1); } } }
    toast('Morale and power restored', 'level');
    return true;
  }
  function resetCooldowns() {
    const p = player(); if (!p) return na('Player');
    p.cooldowns = {}; p.gcdReady = 0; p.nextSwing = 0;
    if (p.rollCooldownUntil != null) p.rollCooldownUntil = 0;
    toast('Cooldowns reset');
    return true;
  }
  function applyStatBonus(k, v) {
    const p = player(); if (!p) return na('Player');
    ensureShape(p);
    v = Math.round(num(v, 0));
    if (v) p.statBonus[k] = v; else delete p.statBonus[k];
    computeStats(p);
    emit('equipChanged', p);
    return true;
  }
  function resetStatOverrides() {
    const p = player(); if (!p) return na('Player');
    ensureShape(p);
    p.statBonus = {}; p.statOverride = null;
    computeStats(p);
    emit('equipChanged', p);
    toast('Stat overrides cleared');
    return true;
  }
  function grantTitle(id, makeActive) {
    const p = player(); if (!p || !id) return na('Player');
    ensureShape(p);
    let name = id;
    if (G.Data && has(G.Data, 'titleName')) name = G.Data.titleName(id, p.gender) || id;
    if (p.titles.indexOf(id) < 0) {
      if (G.Progress && has(G.Progress, 'awardTitle')) G.Progress.awardTitle(id);
      else { p.titles.push(id); emit('titleEarned', id); }
    }
    if (makeActive) { p.activeTitle = id; emit('titleChanged', id); }
    toast((makeActive ? 'Now titled ' : 'Title granted: ') + name, 'level');
    return true;
  }
  function setActiveTitle(id) {
    const p = player(); if (!p) return na('Player');
    ensureShape(p);
    p.activeTitle = id || null;
    emit('titleChanged', p.activeTitle);
    toast(id ? 'Title: ' + ((G.Data && has(G.Data, 'titleName')) ? G.Data.titleName(id, p.gender) : id) : 'Title removed');
    return true;
  }
  function allMountTids() {
    const out = [];
    if (G.Items && has(G.Items, 'all')) { const all = G.Items.all(); for (let i = 0; i < all.length; i++) if (all[i].type === 'mount') out.push(all[i].id); }
    else if (G.Data && G.Data.items) for (const id in G.Data.items) if (G.Data.items[id] && G.Data.items[id].type === 'mount') out.push(id);
    const lk = G.Data && G.Data.lostKingdom && G.Data.lostKingdom.mount;
    if (lk && out.indexOf(lk) < 0) out.push(lk);
    return out;
  }
  function unlockAllMounts() {
    const p = player(); if (!p) return na('Player');
    ensureShape(p);
    const all = allMountTids(); if (!all.length) return na('Mount data');
    let n = 0;
    for (let i = 0; i < all.length; i++) if (p.mounts.indexOf(all[i]) < 0) { p.mounts.push(all[i]); n++; }
    if (!p.mountId && p.mounts.length) p.mountId = p.mounts[0];
    emit('mountsChanged', p.mounts);
    toast(n ? 'Unlocked ' + n + ' mounts (' + p.mounts.length + ' total)' : 'All ' + p.mounts.length + ' mounts already known');
    return true;
  }
  function learnAllAbilities() {
    const p = player(); if (!p) return na('Player');
    ensureShape(p);
    const list = (G.Data && has(G.Data, 'abilitiesFor')) ? G.Data.abilitiesFor(p.cls) : null;
    if (!list || !list.length) return na('Ability data');
    const st = ensureState();
    const goldBefore = p.gold;
    st.freeTraining = true;
    let learned = 0;
    try {
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a || p.abilities.has(a.id)) continue;
        let ok = false;
        if (G.Progress && has(G.Progress, 'trainAbility') && num(a.level, 1) <= num(p.level, 1)) {
          p.gold = Math.max(goldBefore, 1e9);                          // training is refunded below — free
          try { const r = G.Progress.trainAbility(a.id); ok = !!(r && r.ok); } catch (err) { report(err, 'admin trainAbility'); ok = false; }
        }
        if (!ok) {
          p.abilities.add(a.id);
          let slot = -1;
          if (G.Progress && has(G.Progress, 'hotbarSlotOf') && has(G.Progress, 'firstFreeHotbar') && has(G.Progress, 'setHotbar')) {
            if (G.Progress.hotbarSlotOf(a.id) < 0) { slot = G.Progress.firstFreeHotbar(); if (slot >= 0) G.Progress.setHotbar(slot, a.id); }
          } else if (p.hotbar.indexOf(a.id) < 0) { slot = p.hotbar.indexOf(null); if (slot >= 0) p.hotbar[slot] = a.id; }
          emit('abilityTrained', a.id);
        }
        learned++;
      }
    } finally { p.gold = goldBefore; st.freeTraining = false; }
    emit('goldChanged', p.gold);
    if (has(UI, 'hotbarRefresh')) UI.hotbarRefresh();
    toast(learned ? 'Learned ' + learned + ' abilities for free' : 'Every ability is already known', 'level');
    return true;
  }
  function rename(name) {
    const p = player(); if (!p) return na('Player');
    name = str(name).trim().replace(/[^A-Za-z' \-]/g, '').slice(0, 16);
    if (name.length < 2) return warn('Names need 2–16 letters');
    p.name = name;
    if (p.rig && has(p.rig, 'setName')) { try { p.rig.setName(name); } catch (_) { /* optional */ } }
    emit('playerRenamed', name);
    toast('You are now known as ' + name);
    return true;
  }

  BUILDERS.player = function (root) {
    const p = player();
    if (!p) return noPlayer(root);
    ensureShape(p);
    ensureState();
    // ---- vitals card
    const nm = el('div', { class: 'nm' }), sub = el('div', { class: 'sub' });
    const mor = bar('morale'), pow = bar('power'), xpb = bar('xp');
    const gold = el('div', { class: 'gold' });
    root.appendChild(el('div', { class: 'adm-card' }, [el('div', { class: 'who' }, [nm, sub]), el('div', { class: 'bars' }, [mor, pow, xpb]), gold]));
    live(function () {
      const st = p.stats || {};
      nm.textContent = (p.name || '?') + (p.activeTitle ? ', ' + ((G.Data && has(G.Data, 'titleName')) ? G.Data.titleName(p.activeTitle, p.gender) : p.activeTitle) : '');
      sub.textContent = 'Level ' + num(p.level, 1) + ' ' + raceName(p.race) + ' ' + className(p.cls) + (p.dead || p.alive === false ? ' · DEFEATED' : '');
      mor.set(num(p.morale), num(st.maxMorale, 1), 'Morale ' + fmtNum(p.morale) + ' / ' + fmtNum(st.maxMorale));
      pow.set(num(p.power), num(st.maxPower, 1), 'Power ' + fmtNum(p.power) + ' / ' + fmtNum(st.maxPower));
      const X = G.Data && G.Data.xp; let a = 0, b = 1;
      if (X && has(X, 'forLevel')) { a = X.forLevel(p.level); b = p.level >= levelCap() ? a : X.forLevel(p.level + 1); }
      xpb.set(num(p.xp) - a, Math.max(1, b - a), 'XP ' + fmtNum(p.xp) + (b > a ? ' / ' + fmtNum(b) : ' (cap)'));
      gold.innerHTML = typeof G.fmtMoneyHTML === 'function' ? G.fmtMoneyHTML(p.gold) : esc(fmtMoney(p.gold));
    });

    // ---- identity & progression
    const nameIn = textIn(p.name, 'Character name', 170);
    const lvlIn = numIn(p.level, 1, levelCap(), 1, 64);
    const xpIn = numIn(1000, 1, 10000000, 100, 90);
    root.appendChild(section('Identity & progression', [
      row([lbl('Name'), nameIn, btn('Rename', function () { rename(nameIn.value); })]),
      row([lbl('Level'), lvlIn, btn('Set level', function () { setLevel(lvlIn.value); Admin.refresh(); }, 'primary'),
        btn('−1', function () { setLevel(num(p.level, 1) - 1); Admin.refresh(); }), btn('+1', function () { setLevel(num(p.level, 1) + 1); Admin.refresh(); }),
        btn('Max (' + levelCap() + ')', function () { setLevel(levelCap()); Admin.refresh(); })]),
      row([lbl('Add XP'), xpIn, btn('Add XP', function () { addXP(xpIn.value); }),
        btn('XP to next level', function () { const X = G.Data && G.Data.xp; if (!X || !has(X, 'forLevel')) return na('XP table'); if (p.level >= levelCap()) return warn('Already at the level cap'); addXP(X.forLevel(p.level + 1) - num(p.xp)); Admin.refresh(); })]),
    ]));

    // ---- gold
    const parts = typeof G.fmtMoneyParts === 'function' ? G.fmtMoneyParts(p.gold) : { g: 0, s: 0, c: 0 };
    const gIn = numIn(parts.g, 0, 9999999, 1, 84), sIn = numIn(parts.s, 0, 999, 1, 64), cIn = numIn(parts.c, 0, 99, 1, 56);
    const M = C().MONEY || { SILVER: 100, GOLD: 100000 };
    const copperOf = function () { return num(gIn.value) * M.GOLD + num(sIn.value) * M.SILVER + num(cIn.value); };
    root.appendChild(section('Purse', [
      row([lbl('Gold'), gIn, el('span', { class: 'adm-unit', text: 'g' }), sIn, el('span', { class: 'adm-unit', text: 's' }), cIn, el('span', { class: 'adm-unit', text: 'c' }),
        btn('Set', function () { setGold(copperOf()); }, 'primary'), btn('Add', function () { addGold(copperOf()); }), btn('Take', function () { addGold(-copperOf()); }),
        el('span', { class: 'sep' }), btn('+100g', function () { addGold(100 * M.GOLD); }), btn('+1,000g', function () { addGold(1000 * M.GOLD); }), btn('Empty purse', function () { setGold(0); }, 'danger')]),
    ]));

    // ---- primary stats
    const statBox = el('div', { class: 'adm-stats' });
    const statInputs = {};
    for (let i = 0; i < PRIMARY.length; i++) {
      (function (k) {
        const v = el('div', { class: 'v', text: '0' });
        const inp = numIn(num(p.statBonus[k], 0), -9999, 99999, 1, 60);
        inp.title = 'Additive bonus applied on top of race, class, gear and traits';
        inp.addEventListener('change', function () { applyStatBonus(k, inp.value); toast(statName(k) + ' bonus ' + (num(inp.value) >= 0 ? '+' : '') + Math.round(num(inp.value))); });
        statInputs[k] = { inp: inp, v: v };
        statBox.appendChild(el('div', { class: 'adm-stat' }, [el('div', { class: 'k', text: statName(k) }), v, inp]));
      })(PRIMARY[i]);
    }
    live(function () { for (const k in statInputs) { const st = p.stats || {}; const bonus = num(p.statBonus && p.statBonus[k], 0); statInputs[k].v.innerHTML = fmtNum(st[k]) + (bonus ? ' <small>(' + (bonus > 0 ? '+' : '') + bonus + ')</small>' : ''); } });
    const derived = kv([['Morale', ''], ['Power', ''], ['Armour', ''], ['Phys. mastery', ''], ['Tact. mastery', ''], ['Crit', ''], ['Mitigation', ''], ['Speed', '']]);
    live(function () { const st = p.stats || {}; derived.set(0, fmtNum(st.maxMorale)); derived.set(1, fmtNum(st.maxPower)); derived.set(2, fmtNum(st.armour)); derived.set(3, fmtNum(st.physMastery)); derived.set(4, fmtNum(st.tactMastery)); derived.set(5, fmtNum(st.crit) + (st.critChance != null ? ' (' + num(st.critChance).toFixed(1) + '%)' : '')); derived.set(6, st.mitigation != null ? num(st.mitigation).toFixed(1) + '%' : '—'); derived.set(7, '×' + (num(st.speed, 1) * num(G.state.speedMult, 1)).toFixed(2)); });
    root.appendChild(section('Primary stats', [
      hint('Type a bonus under each stat — it is added on top of everything else and recomputed at once.'),
      statBox, derived,
      row([btn('Reset overrides', function () { resetStatOverrides(); Admin.refresh(); }), btn('+50 to all', function () { for (let i = 0; i < PRIMARY.length; i++) applyStatBonus(PRIMARY[i], num(p.statBonus[PRIMARY[i]], 0) + 50); toast('+50 to every primary stat'); Admin.refresh(); }),
        btn('Recompute stats', function () { computeStats(p); emit('equipChanged', p); toast('Stats recomputed'); })]),
    ]));

    // ---- vitals & overrides
    const st = G.state;
    const dmgIn = numIn(num(st.damageMult, 1), 0, 1000, 0.1, 70), spdIn = numIn(num(st.speedMult, 1), 0.1, 20, 0.1, 70), fishIn = numIn(num(st.fishingSkill, 1), 1, 100, 1, 64);
    root.appendChild(section('Vitals & overrides', [
      row([btn('Full morale & power', fullHeal, 'primary'), btn('Reset cooldowns', resetCooldowns), btn('Set morale to 10%', function () { computeStats(p); p.morale = Math.max(1, Math.round(num(p.stats && p.stats.maxMorale, 100) * 0.1)); toast('Morale set to 10%'); })]),
      row([
        toggle('God mode', function () { return !!st.godMode; }, function (v) { setOverride('godMode', v); toast('God mode ' + (v ? 'ON' : 'off')); }, 'Immune to all damage (G.state.godMode)'),
        toggle('No cooldowns', function () { return !!st.noCooldowns; }, function (v) { setOverride('noCooldowns', v); if (v) resetCooldowns(); toast('Cooldowns ' + (v ? 'disabled' : 'enabled')); }, 'G.state.noCooldowns'),
        el('span', { class: 'sep' }),
        lbl('Damage ×', 66), dmgIn, btn('Apply', function () { const v = clamp(num(dmgIn.value, 1), 0, 1000); dmgIn.value = v; setOverride('damageMult', v); toast('Damage multiplier ×' + v); }),
        lbl('Speed ×', 58), spdIn, btn('Apply', function () { const v = clamp(num(spdIn.value, 1), 0.1, 20); spdIn.value = v; setOverride('speedMult', v); toast('Speed multiplier ×' + v); }),
      ]),
      row([lbl('Fishing skill'), fishIn, btn('Set', function () { st.fishingSkill = Math.round(clamp(num(fishIn.value, 1), 1, 100)); fishIn.value = st.fishingSkill; toast('Fishing skill ' + st.fishingSkill); }), btn('Max (100)', function () { st.fishingSkill = 100; fishIn.value = 100; toast('Fishing skill 100'); })]),
      hint('Speed × is stored as G.state.speedMult and mirrored onto player.speedMult (which the controller reads). Damage × scales the damage you deal.'),
    ]));

    // ---- titles
    const titles = (G.Data && Array.isArray(G.Data.titles)) ? G.Data.titles : [];
    if (titles.length) {
      const opts = titles.map(function (t) { return { value: t.id, label: ((G.Data && has(G.Data, 'titleName')) ? G.Data.titleName(t.id, p.gender) : t.name) + (p.titles.indexOf(t.id) >= 0 ? ' ✓' : '') + (t.desc ? ' — ' + t.desc : '') }; });
      const tSel = selectIn(opts, p.activeTitle || opts[0].value, 360);
      const ownOpts = [{ value: '', label: '(no title)' }].concat(p.titles.map(function (id) { return { value: id, label: (G.Data && has(G.Data, 'titleName')) ? G.Data.titleName(id, p.gender) : id }; }));
      const aSel = selectIn(ownOpts, p.activeTitle || '', 220);
      root.appendChild(section('Titles', [
        row([lbl('All titles'), tSel, btn('Grant', function () { grantTitle(tSel.value, false); Admin.refresh(); }), btn('Grant & wear', function () { grantTitle(tSel.value, true); Admin.refresh(); }, 'primary'),
          btn('Grant all', function () { for (let i = 0; i < titles.length; i++) if (p.titles.indexOf(titles[i].id) < 0) { if (G.Progress && has(G.Progress, 'awardTitle')) G.Progress.awardTitle(titles[i].id); else p.titles.push(titles[i].id); } toast('All ' + titles.length + ' titles granted', 'level'); Admin.refresh(); })]),
        row([lbl('Wearing'), aSel, btn('Set active', function () { setActiveTitle(aSel.value); Admin.refresh(); })]),
      ]));
    }

    // ---- mounts
    const mountTids = allMountTids();
    const mOpts = [{ value: '', label: '(none)' }].concat(p.mounts.map(function (id) { const t = (G.Items && has(G.Items, 'template')) ? G.Items.template(id) : (G.Data && G.Data.items && G.Data.items[id]); return { value: id, label: t ? t.name : id }; }));
    const mSel = selectIn(mOpts, p.mountId || '', 240);
    root.appendChild(section('Mounts', [
      row([lbl('Known'), el('span', { text: p.mounts.length + ' of ' + mountTids.length }), btn('Unlock all ' + mountTids.length + ' mounts', function () { unlockAllMounts(); Admin.refresh(); }, 'primary'),
        el('span', { class: 'sep' }), lbl('Ride', 40), mSel, btn('Select', function () { p.mountId = mSel.value || null; emit('mountsChanged', p.mounts); toast(p.mountId ? 'Mount selected' : 'No mount selected'); })]),
    ]));

    // ---- abilities
    const abil = (G.Data && has(G.Data, 'abilitiesFor')) ? G.Data.abilitiesFor(p.cls) : [];
    const known = abil.filter(function (a) { return p.abilities.has(a.id); }).length;
    root.appendChild(section('Abilities', [
      row([el('span', { text: known + ' of ' + abil.length + ' class abilities known' }), btn('Learn all abilities (free)', function () { learnAllAbilities(); Admin.refresh(); }, 'primary'),
        btn('Forget all but level 1', function () { confirmThen('Forget every trained ability except the level-1 ones?', function () { let n = 0; for (let i = 0; i < abil.length; i++) if (abil[i].level > 1 && p.abilities.delete(abil[i].id)) { n++; const s = p.hotbar.indexOf(abil[i].id); if (s >= 0) p.hotbar[s] = null; } if (has(UI, 'hotbarRefresh')) UI.hotbarRefresh(); emit('hotbarChanged', -1); toast('Forgot ' + n + ' abilities'); Admin.refresh(); }); }, 'danger'),
        btn('Reset cooldowns', resetCooldowns)]),
    ]));
  };

  // ================================================================================================ ITEMS
  function itemTemplate(tid) { if (G.Items && has(G.Items, 'template')) return G.Items.template(tid); return (G.Data && G.Data.items && G.Data.items[tid]) || null; }
  function giveItem(tid, count) {
    const p = player(); if (!p) return na('Player');
    if (!G.Items || !has(G.Items, 'create') || !has(G.Items, 'addToInventory')) return na('Inventory');
    ensureShape(p);
    const t = itemTemplate(tid); if (!t) return warn('Unknown item: ' + tid);
    count = Math.max(1, Math.round(num(count, 1)));
    let given = 0;
    const max = num(t.maxStack, 1) || 1;
    if (max > 1) { const inst = G.Items.create(tid, count); if (inst && G.Items.addToInventory(p, inst)) given = count; }
    else { for (let i = 0; i < count; i++) { const inst = G.Items.create(tid, 1); if (!inst || !G.Items.addToInventory(p, inst, i > 0)) break; given++; } }
    if (given) toast('Received ' + t.name + (given > 1 ? ' ×' + given : ''), 'loot'); else warn('Could not add ' + t.name + ' — is the inventory full?');
    return given > 0;
  }
  function afterEquip(p) {
    computeStats(p);
    if (p.rig && has(p.rig, 'setEquipment')) { try { p.rig.setEquipment(p.equipment); } catch (_) { /* rig optional */ } }
    emit('equipChanged', p); emit('inventoryChanged', p);
  }
  // force-equip a list of instances in G.C.EQUIP_SLOTS order (ignores level / class requirements — admin)
  function equipSetByIndex(list) {
    const p = player(); if (!p) return 0;
    ensureShape(p);
    const slots = C().EQUIP_SLOTS || Object.keys(p.equipment);
    let n = 0, dropped = 0;
    for (let i = 0; i < list.length && i < slots.length; i++) {
      const inst = list[i]; if (!inst) continue;
      const slot = slots[i];
      const prev = p.equipment[slot];
      if (prev) { if (!(G.Items && has(G.Items, 'addToInventory') && G.Items.addToInventory(p, prev, true))) dropped++; }
      p.equipment[slot] = inst; n++;
    }
    afterEquip(p);
    if (dropped) warn(dropped + ' replaced items were lost (inventory full)');
    return n;
  }
  function addAll(list) {
    const p = player(); if (!p || !G.Items || !has(G.Items, 'addToInventory')) return 0;
    let n = 0;
    for (let i = 0; i < list.length; i++) if (list[i] && G.Items.addToInventory(p, list[i], true)) n++;
    return n;
  }
  function giveBestSet(equip) {
    const p = player(); if (!p) return na('Player');
    if (!G.Items || !has(G.Items, 'bestSet')) return na('Item generation');
    const list = G.Items.bestSet(num(p.level, 1), p.cls) || [];
    if (!list.length) return warn('No gear could be generated');
    if (equip) { const n = equipSetByIndex(list); toast('Equipped a best-in-slot set for level ' + p.level + ' (' + n + ' pieces)', 'loot'); }
    else { const n = addAll(list); toast('Added ' + n + ' best-in-slot pieces to your bags', 'loot'); }
    return true;
  }
  function giveLostKingdom(equip) {
    const p = player(); if (!p) return na('Player');
    if (!G.Items || !has(G.Items, 'lostKingdomSet')) return na('Lost Kingdom set');
    const list = G.Items.lostKingdomSet(p.cls) || [];
    if (!list.length) return warn('The Lost Kingdom set could not be built');
    if (equip) { const n = equipSetByIndex(list); toast('The Armour of the Lost Kingdom is yours — ' + n + ' pieces equipped', 'loot'); }
    else { const n = addAll(list); toast('Added ' + n + ' Lost Kingdom pieces to your bags', 'loot'); }
    const mount = G.Data && G.Data.lostKingdom && G.Data.lostKingdom.mount;
    if (mount) { ensureShape(p); if (p.mounts.indexOf(mount) < 0) p.mounts.push(mount); }
    return true;
  }
  function randomLoot(n) {
    const p = player(); if (!p) return na('Player');
    if (!G.Items || !has(G.Items, 'generate') || !has(G.Items, 'addToInventory')) return na('Item generation');
    let made = 0;
    for (let i = 0; i < n; i++) { const inst = G.Items.generate({ level: num(p.level, 1), cls: p.cls }); if (inst && G.Items.addToInventory(p, inst, true)) made++; }
    toast('Rolled ' + made + ' random pieces of loot', 'loot');
    return made > 0;
  }
  function clearInventory() {
    const p = player(); if (!p) return na('Player');
    ensureShape(p);
    let n = 0;
    for (let i = 0; i < p.inventory.length; i++) if (p.inventory[i]) { p.inventory[i] = null; n++; }
    emit('inventoryChanged', p);
    toast('Destroyed ' + n + ' inventory stacks', 'warning');
    return true;
  }
  function removeJunk() {
    const p = player(); if (!p) return na('Player');
    ensureShape(p);
    if (!G.Items || !has(G.Items, 'isJunk')) return na('Junk detection');
    let n = 0;
    for (let i = 0; i < p.inventory.length; i++) { const s = p.inventory[i]; if (s && G.Items.isJunk(s, p)) { p.inventory[i] = null; n++; } }
    emit('inventoryChanged', p);
    toast(n ? 'Removed ' + n + ' junk stacks' : 'No junk found');
    return true;
  }
  function itemStatKeys() { return (G.Items && Array.isArray(G.Items.STAT_KEYS)) ? G.Items.STAT_KEYS : ((G.Data && G.Data.stats && G.Data.stats.STAT_KEYS) || ['might', 'agility', 'vitality', 'will', 'fate', 'maxMorale', 'maxPower', 'armour', 'physMastery', 'tactMastery', 'crit', 'finesse', 'block', 'parry', 'evade', 'resist']); }

  BUILDERS.items = function (root) {
    const p = player();
    const Items = G.Items;
    if (!Items || !has(Items, 'all')) { root.appendChild(muted('Item data (G.Items) is not available.')); return; }
    if (p) ensureShape(p);
    // ---- quick actions
    let autoEquip = true;
    const invCount = el('span', { class: 'adm-count' });
    live(function () { if (!p) { invCount.textContent = 'no player'; return; } let used = 0; for (let i = 0; i < p.inventory.length; i++) if (p.inventory[i]) used++; invCount.textContent = 'Bags: ' + used + ' / ' + p.inventory.length + ' slots used'; });
    root.appendChild(section('Quick actions', [
      row([btn('Best-in-slot set for my level', function () { giveBestSet(autoEquip); Admin.refresh(); }, 'primary'), btn('Armour of the Lost Kingdom (full)', function () { giveLostKingdom(autoEquip); Admin.refresh(); }, 'primary'),
        toggle('Auto-equip sets', function () { return autoEquip; }, function (v) { autoEquip = v; toast(v ? 'Sets will be equipped' : 'Sets go to your bags'); }),
        btn('Random loot ×10', function () { randomLoot(10); })]),
      row([btn('Sort bags', function () { if (has(Items, 'sort') && p) { Items.sort(p); toast('Bags sorted'); } else na('Sorting'); }), btn('Remove junk', removeJunk),
        btn('Clear inventory', function () { confirmThen('Destroy EVERYTHING in your bags?', function () { clearInventory(); }); }, 'danger'), invCount]),
    ], null));

    // ---- browser
    const all = Items.all();
    const types = []; const slots = []; const rarities = (C().RARITY || ['common', 'uncommon', 'rare', 'incomparable', 'legendary']);
    for (let i = 0; i < all.length; i++) { const t = all[i]; if (t.type && types.indexOf(t.type) < 0) types.push(t.type); if (t.slot && slots.indexOf(t.slot) < 0) slots.push(t.slot); }
    types.sort(); slots.sort(function (a, b) { return (C().EQUIP_SLOTS || []).indexOf(a) - (C().EQUIP_SLOTS || []).indexOf(b); });
    const search = textIn('', 'Search name / id / subtype…', 220);
    const typeSel = selectIn([{ value: '', label: 'All types' }].concat(types.map(function (t) { return { value: t, label: typeof G.titleCase === 'function' ? G.titleCase(t) : t }; })), '', 118);
    const slotSel = selectIn([{ value: '', label: 'Any slot' }].concat(slots.map(function (s) { return { value: s, label: has(Items, 'slotLabel') ? Items.slotLabel(s) : s }; })), '', 110);
    const rarSel = selectIn([{ value: '', label: 'Any rarity' }].concat(rarities.map(function (r) { return { value: r, label: typeof G.titleCase === 'function' ? G.titleCase(r) : r }; })), '', 118);
    const countIn = numIn(S.giveCount, 1, 200, 1, 58);
    countIn.addEventListener('change', function () { S.giveCount = Math.max(1, Math.round(num(countIn.value, 1))); countIn.value = S.giveCount; });
    let myLevel = false;
    const lvlTog = toggle('≤ my level', function () { return myLevel; }, function (v) { myLevel = v; render(); });
    const listEl = el('div', { class: 'adm-list' });
    const countEl = el('div', { class: 'adm-count' });
    const MAX_ROWS = 200;
    function matches(t, q) {
      if (typeSel.value && t.type !== typeSel.value) return false;
      if (slotSel.value && t.slot !== slotSel.value) return false;
      if (rarSel.value && t.rarity !== rarSel.value) return false;
      if (myLevel && p && num(t.level, 1) > num(p.level, 1)) return false;
      if (!q) return true;
      return (t.name && t.name.toLowerCase().indexOf(q) >= 0) || t.id.indexOf(q) >= 0 || (t.subtype && String(t.subtype).indexOf(q) >= 0) || (t.type && t.type.indexOf(q) >= 0);
    }
    function render() {
      const q = search.value.trim().toLowerCase();
      const res = [];
      for (let i = 0; i < all.length; i++) if (!all[i].hidden && matches(all[i], q)) res.push(all[i]);
      res.sort(function (a, b) { return num(a.level, 1) - num(b.level, 1) || String(a.name).localeCompare(String(b.name)); });
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      const frag = document.createDocumentFragment();
      const n = Math.min(res.length, MAX_ROWS);
      for (let i = 0; i < n; i++) {
        (function (t) {
          const meta = 'L' + num(t.level, 1) + (t.ilvl ? ' · il' + t.ilvl : '') + ' · ' + (has(Items, 'typeLabel') ? Items.typeLabel(t) : (t.type || '')) + (t.slot ? ' · ' + (has(Items, 'slotLabel') ? Items.slotLabel(t.slot) : t.slot) : '');
          const rowEl = el('div', { class: 'adm-item', data: { tid: t.id } }, [
            iconEl(t),
            el('span', { class: 'nm', text: t.name, style: { color: rarityColor(t.rarity) }, title: t.id + (t.desc ? '\n' + t.desc : '') }),
            el('span', { class: 'meta', text: meta }),
            btn('Give ×<span class="gc">' + S.giveCount + '</span>', function () { giveItem(t.id, S.giveCount); }, 'small'),
            t.slot ? btn('Equip', function () { if (!p) return na('Player'); const inst = has(Items, 'create') ? Items.create(t.id, 1) : null; if (!inst) return warn('Could not create ' + t.name); const idx = (C().EQUIP_SLOTS || []).indexOf(has(Items, 'baseSlot') ? Items.baseSlot(t.slot) : t.slot); const list = new Array(idx + 1).fill(null); list[idx] = inst; if (idx < 0) return warn('Unknown slot'); equipSetByIndex(list); toast('Equipped ' + t.name, 'loot'); renderEq(); }, 'small') : null,
          ]);
          if (has(UI, 'bindTooltip') && has(Items, 'tooltipHTML')) UI.bindTooltip(rowEl.children[1], function () { return Items.tooltipHTML(t.id, p); });
          frag.appendChild(rowEl);
        })(res[i]);
      }
      listEl.appendChild(frag);
      countEl.textContent = res.length > MAX_ROWS ? 'Showing the first ' + MAX_ROWS + ' of ' + res.length + ' items — refine the search to see the rest' : res.length + ' item' + (res.length === 1 ? '' : 's');
    }
    const debounced = typeof G.debounce === 'function' ? G.debounce(render, 120) : render;
    search.addEventListener('input', debounced);
    [typeSel, slotSel, rarSel].forEach(function (s) { s.addEventListener('change', render); });
    countIn.addEventListener('change', function () { const gcs = listEl.querySelectorAll('.gc'); for (let i = 0; i < gcs.length; i++) gcs[i].textContent = S.giveCount; });
    root.appendChild(section('Item browser (' + all.length + ' templates)', [
      row([search, typeSel, slotSel, rarSel, lvlTog, el('span', { class: 'sep' }), lbl('Give count', 80), countIn]),
      countEl, listEl,
    ]));
    render();

    // ---- equipped editor
    if (!p) return;
    const eqBox = el('div', { class: 'adm-eq' });
    const editor = el('div', { class: 'adm-editor', hidden: true });
    const slotsAll = C().EQUIP_SLOTS || Object.keys(p.equipment);
    function renderEq() {
      while (eqBox.firstChild) eqBox.removeChild(eqBox.firstChild);
      for (let i = 0; i < slotsAll.length; i++) {
        (function (slot) {
          const inst = p.equipment[slot];
          const v = inst && has(Items, 'get') ? Items.get(inst) : null;
          const r = el('div', { class: 'adm-item' + (S.lastSelSlot === slot ? ' selected' : '') }, [
            el('span', { class: 'slot', text: has(Items, 'slotLabel') ? Items.slotLabel(slot) : slot }),
            v ? iconEl(v) : el('span', { class: 'adm-ico', html: '<div class="icon sm" style="opacity:.35">·</div>' }),
            el('span', { class: 'nm', text: v ? v.name : '— empty —', style: { color: v ? rarityColor(v.rarity) : 'var(--parch-dim)' } }),
            v ? el('span', { class: 'meta', text: 'il' + num(v.ilvl, 0) }) : null,
            v ? btn('✕', function (e) { e.stopPropagation(); if (has(Items, 'unequip')) Items.unequip(p, slot); else { if (has(Items, 'addToInventory')) Items.addToInventory(p, inst, true); p.equipment[slot] = null; afterEquip(p); } toast('Unequipped ' + v.name); renderEq(); renderEditor(); }, 'small', 'Unequip') : null,
          ]);
          r.addEventListener('click', function () { S.lastSelSlot = slot; renderEq(); renderEditor(); });
          if (v && has(UI, 'bindTooltip') && has(Items, 'tooltipHTML')) UI.bindTooltip(r.children[2], function () { return Items.tooltipHTML(inst, p); });
          eqBox.appendChild(r);
        })(slotsAll[i]);
      }
    }
    function renderEditor() {
      while (editor.firstChild) editor.removeChild(editor.firstChild);
      const slot = S.lastSelSlot;
      const inst = slot ? p.equipment[slot] : null;
      if (!slot || !inst) { editor.hidden = true; return; }
      editor.hidden = false;
      const v = has(Items, 'get') ? Items.get(inst) : inst;
      const nameIn = textIn(v.name, 'Item name', 260);
      const keys = itemStatKeys();
      const inputs = {};
      const sg = el('div', { class: 'sgrid' });
      for (let i = 0; i < keys.length; i++) { const k = keys[i]; const inp = numIn(num(v.stats && v.stats[k], 0), -99999, 999999, 1, 72); inputs[k] = inp; sg.appendChild(el('label', {}, [el('span', { text: statName(k) }), inp])); }
      let dmgMin = null, dmgMax = null;
      if (v.dmg) { dmgMin = numIn(num(v.dmg.min, 1), 1, 99999, 1, 72); dmgMax = numIn(num(v.dmg.max, 2), 1, 99999, 1, 72); }
      const apply = function () {
        const stats = {};
        for (const k in inputs) { const val = Math.round(num(inputs[k].value, 0)); if (val) stats[k] = val; }
        inst.stats = stats;
        const nm = nameIn.value.trim();
        if (nm && nm !== (v.tmpl ? v.tmpl.name : v.name)) inst.name = nm; else if (nm && v.tmpl && nm === v.tmpl.name) delete inst.name;
        if (dmgMin && dmgMax) { const mn = Math.max(1, Math.round(num(dmgMin.value, 1))), mx = Math.max(mn, Math.round(num(dmgMax.value, mn))); inst.dmg = Object.assign({}, v.dmg, { min: mn, max: mx }); }
        afterEquip(p);
        toast('Updated ' + (inst.name || v.name));
        renderEq(); renderEditor();
      };
      editor.appendChild(row([el('span', { html: iconHTML(v) }), el('b', { text: 'Editing ' + (has(Items, 'slotLabel') ? Items.slotLabel(slot) : slot) + ':' }), nameIn, el('span', { class: 'meta', text: 'il' + num(v.ilvl, 0) + ' · ' + str(v.rarity) + (inst.gen ? ' · generated' : '') })]));
      if (dmgMin) editor.appendChild(row([lbl('Damage'), dmgMin, el('span', { class: 'adm-unit', text: '–' }), dmgMax, el('span', { class: 'meta', text: str(v.dmg.type) + ' · ' + num(v.speed, 2).toFixed(1) + ' s' })]));
      editor.appendChild(sg);
      editor.appendChild(row([btn('Apply changes', apply, 'primary'),
        btn('×2 all stats', function () { for (const k in inputs) inputs[k].value = Math.round(num(inputs[k].value, 0) * 2); apply(); }),
        btn('Reset to template', function () { if (inst.gen) return warn('Generated gear has no template to reset to'); delete inst.stats; delete inst.name; delete inst.dmg; afterEquip(p); toast('Reset to template values'); renderEq(); renderEditor(); }),
        btn('Close', function () { S.lastSelSlot = null; renderEq(); renderEditor(); })]));
    }
    root.appendChild(section('Equipped items — click one to edit its stats', [eqBox, editor]));
    renderEq(); renderEditor();
  };

  // ================================================================================================ TELEPORT
  function teleportTo(x, z, label, yaw) {
    if (!G.Player || !has(G.Player, 'teleport')) return na('Teleport (G.Player)');
    if (!player()) return na('Player');
    x = num(x); z = num(z);
    const half = num(C().WORLD_SIZE, 4096) / 2;
    x = clamp(x, -half + 5, half - 5); z = clamp(z, -half + 5, half - 5);
    const ok = G.Player.teleport(x, z, typeof yaw === 'number' ? yaw : undefined);
    if (ok !== false) toast('Teleported to ' + (label || (Math.round(x) + ', ' + Math.round(z))));
    else warn('Teleport failed');
    return ok !== false;
  }
  function npcPos(id) {
    const d = npcData(id);
    let ent = null;
    if (G.NPCs && has(G.NPCs, 'get')) { try { ent = G.NPCs.get(id); } catch (_) { ent = null; } }
    const pos = (ent && ent.pos && typeof ent.pos.x === 'number') ? ent.pos : (d && d.pos);
    if (!pos) return null;
    return { x: pos.x, z: pos.z, yaw: num(ent ? ent.yaw : (d && d.yaw), 0), name: (ent && ent.name) || (d && d.name) || id, inside: !!(d && d.interior) };
  }
  function teleportToNpc(id) {
    const n = npcPos(id); if (!n) return warn('Unknown NPC: ' + id);
    // stand 2 m in front of the NPC, facing them (yaw 0 = facing −Z, forward = (−sin, −cos))
    const fx = -Math.sin(n.yaw), fz = -Math.cos(n.yaw);
    const yaw = n.yaw + PI;
    return teleportTo(n.x + fx * 2, n.z + fz * 2, n.name, yaw);
  }
  function homeTown() {
    const p = player(); const w = world();
    if (!p) return null;
    let sp = null;
    if (G.Data && has(G.Data, 'startPosFor')) sp = G.Data.startPosFor(p.race);
    if (sp && w && w.townById && w.townById[sp.town]) { const t = w.townById[sp.town]; const rp = t.rallyPoint || t.pos; return { x: rp.x, z: rp.z, name: t.name }; }
    if (sp) return { x: sp.x, z: sp.z, name: 'home' };
    return null;
  }
  function gridButtons(list, labelFn, subFn, onClick) {
    return grid(list.map(function (o) { return btn('<span class="nm">' + esc(labelFn(o)) + '</span>' + (subFn ? '<span class="sub">' + esc(subFn(o)) + '</span>' : ''), function () { onClick(o); }); }));
  }

  BUILDERS.teleport = function (root) {
    const w = world();
    const p = player();
    const pos = el('span', { class: 'adm-count', style: { margin: 0 } });
    live(function () { pos.textContent = p && p.pos ? 'You are at (' + Math.round(p.pos.x) + ', ' + Math.round(p.pos.z) + ') y ' + num(p.pos.y).toFixed(1) + ' in ' + zoneName(G.state.zone) : 'No player'; });
    const xIn = numIn(p && p.pos ? Math.round(p.pos.x) : 0, -2048, 2048, 1, 80), zIn = numIn(p && p.pos ? Math.round(p.pos.z) : 0, -2048, 2048, 1, 80);
    root.appendChild(section('Coordinates', [
      row([pos]),
      row([lbl('X / Z'), xIn, zIn, btn('Go', function () { teleportTo(xIn.value, zIn.value); }, 'primary'), el('span', { class: 'sep' }),
        btn('Home town', function () { const h = homeTown(); if (!h) return na('Home town'); teleportTo(h.x, h.z, h.name); }),
        btn('Tracked quest objective', function () { if (!G.Quests || !has(G.Quests, 'nextObjective')) return na('Quests'); const id = G.Quests.tracked; if (!id) return warn('No quest is tracked'); const o = G.Quests.nextObjective(id); const pt = o && (o.pos || o); if (!pt || typeof pt.x !== 'number') return warn('The tracked quest has no objective position'); teleportTo(pt.x, pt.z, o.label || 'quest objective'); }),
        btn('Pick on the map', function () { if (!UI.Map || !has(UI.Map, 'pickOnce')) return na('Map picking (G.UI.Map.pickOnce)'); Admin.close(); if (has(UI, 'openPanel')) UI.openPanel('map'); toast('Click a spot on the map to teleport there'); UI.Map.pickOnce(function (pt) { if (pt && typeof pt.x === 'number') teleportTo(pt.x, pt.z, 'map click'); }); })]),
    ]));
    if (!w) { root.appendChild(muted('World registry (G.Data.world) is not available — only coordinates work.')); return; }
    const zones = Array.isArray(w.zones) ? w.zones : [];
    root.appendChild(section('Zones (' + zones.length + ')', [gridButtons(zones, function (z) { return z.name; }, function (z) { return Array.isArray(z.level) ? 'L' + z.level[0] + '–' + z.level[1] : ''; }, function (z) { const c = z.center || z.pos || { x: 0, z: 0 }; teleportTo(c.x, c.z, z.name); })]));
    const towns = Array.isArray(w.towns) ? w.towns : [];
    root.appendChild(section('Towns (' + towns.length + ') — rally points', [gridButtons(towns, function (t) { return t.name; }, function (t) { return zoneName(t.zone).replace(/^The /, ''); }, function (t) { const rp = t.rallyPoint || t.pos; teleportTo(rp.x, rp.z, t.name); })]));
    const pois = Array.isArray(w.pois) ? w.pois : [];
    if (pois.length) {
      const f = textIn('', 'Filter places…', 200);
      const box = el('div');
      const renderPois = function () { const q = f.value.trim().toLowerCase(); const list = pois.filter(function (o) { return !q || o.name.toLowerCase().indexOf(q) >= 0 || (o.kind && o.kind.indexOf(q) >= 0) || zoneName(o.zone).toLowerCase().indexOf(q) >= 0; }); while (box.firstChild) box.removeChild(box.firstChild); box.appendChild(gridButtons(list, function (o) { return o.name; }, function (o) { return str(o.kind); }, function (o) { teleportTo(o.pos.x, o.pos.z, o.name); })); };
      f.addEventListener('input', renderPois);
      root.appendChild(section('Points of interest (' + pois.length + ')', [row([f]), box]));
      renderPois();
    }
    const docks = Array.isArray(w.docks) ? w.docks : [];
    if (docks.length) root.appendChild(section('Docks (' + docks.length + ')', [gridButtons(docks, function (d) { return d.name; }, function (d) { return (w.townById && w.townById[d.town]) ? w.townById[d.town].name : str(d.town); }, function (d) { teleportTo(d.pos.x, d.pos.z, d.name); })]));
    const spots = Array.isArray(w.fishingSpots) ? w.fishingSpots : [];
    if (spots.length) root.appendChild(section('Fishing spots (' + spots.length + ')', [gridButtons(spots, function (s) { return s.name; }, function (s) { return zoneName(s.zone).replace(/^The /, ''); }, function (s) { teleportTo(s.pos.x, s.pos.z, s.name); })]));
    const npcs = Array.isArray(w.npcs) ? w.npcs : [];
    if (npcs.length) {
      const f = textIn('', 'Search NPCs by name, title, town or role…', 260);
      const sel = el('select', { style: { width: '340px' } });
      const fill = function () {
        const q = f.value.trim().toLowerCase();
        while (sel.firstChild) sel.removeChild(sel.firstChild);
        let n = 0;
        for (let i = 0; i < npcs.length && n < 400; i++) {
          const o = npcs[i];
          const hay = (o.name + ' ' + str(o.title) + ' ' + str(o.town) + ' ' + (o.roles || []).join(' ') + ' ' + o.id).toLowerCase();
          if (q && hay.indexOf(q) < 0) continue;
          sel.appendChild(el('option', { value: o.id, text: o.name + (o.title ? ', ' + o.title : '') + ' — ' + ((w.townById && w.townById[o.town]) ? w.townById[o.town].name : str(o.town)) + (o.roles && o.roles.length ? ' (' + o.roles[0] + ')' : '') }));
          n++;
        }
        if (!n) sel.appendChild(el('option', { value: '', text: '(no NPC matches)' }));
      };
      f.addEventListener('input', fill);
      fill();
      root.appendChild(section('NPCs (' + npcs.length + ')', [row([f, sel, btn('Teleport to NPC', function () { if (!sel.value) return warn('Pick an NPC'); teleportToNpc(sel.value); }, 'primary')]),
        hint('You arrive two metres in front of the NPC, facing them. Interior NPCs are inside their building — use the door.')]));
    }
  };

  // ================================================================================================ QUESTS
  function qStatus(id) { const st = G.Quests && G.Quests.state; const s = st && st[id]; if (!s) return 'available'; return s.status || (s.done ? 'done' : 'active'); }
  function qName(id) { const q = questData(id); return q ? q.name : id; }
  function qAccept(id) {
    if (!G.Quests || !has(G.Quests, 'accept')) return na('Quests');
    const r = G.Quests.accept(id);
    if (r === false) return warn('Could not accept ' + qName(id));
    toast('Accepted: ' + qName(id), 'quest'); return true;
  }
  function qComplete(id, quiet) {
    const Q = G.Quests; if (!Q) return na('Quests');
    let ok = false;
    if (has(Q, 'forceComplete')) ok = Q.forceComplete(id) !== false;
    else if (has(Q, 'turnIn')) { if (qStatus(id) === 'available' && has(Q, 'accept')) Q.accept(id); ok = Q.turnIn(id) !== false; }
    else return na('Quest completion');
    if (!quiet) { if (ok) toast('Completed: ' + qName(id), 'quest'); else warn('Could not complete ' + qName(id)); }
    return ok;
  }
  function qReset(id, quiet) {
    const Q = G.Quests; if (!Q) return na('Quests');
    if (has(Q, 'reset')) Q.reset(id);
    else if (has(Q, 'abandon') && qStatus(id) === 'active') Q.abandon(id);
    else if (Q.state && typeof Q.state === 'object') delete Q.state[id];
    else return na('Quest reset');
    if (!quiet) toast('Reset: ' + qName(id));
    return true;
  }
  function qTrack(id) { if (!G.Quests || !has(G.Quests, 'setTracked')) return na('Quest tracking'); G.Quests.setTracked(id); toast('Tracking: ' + qName(id), 'quest'); return true; }
  function qGoto(id) { const q = questData(id); if (!q) return warn('Unknown quest'); const npc = qStatus(id) === 'complete' ? (q.turnin || q.giver) : q.giver; if (!npc) return warn('This quest has no giver'); return teleportToNpc(npc); }
  function questList() { const D = G.Data; if (!D || !Array.isArray(D.quests)) return []; return D.quests.slice().sort(function (a, b) { return (a.type === b.type ? 0 : a.type === 'story' ? -1 : 1) || String(a.id).localeCompare(String(b.id)); }); }
  function prereqsDone(q) { const pr = q.prereq; if (!pr) return true; const list = Array.isArray(pr) ? pr : [pr]; for (let i = 0; i < list.length; i++) if (qStatus(list[i]) !== 'done') return false; return true; }
  function acceptNext() {
    const list = questList(); if (!list.length) return na('Quest data');
    for (let i = 0; i < list.length; i++) { const q = list[i]; if (qStatus(q.id) === 'available' && prereqsDone(q)) return qAccept(q.id); }
    return warn('No quest is available to accept right now');
  }
  function completion() {
    if (G.Quests && has(G.Quests, 'completion')) { try { const c = G.Quests.completion(); if (c && typeof c.done === 'number') return c; } catch (_) { /* fall through */ } }
    const list = questList(); let done = 0;
    for (let i = 0; i < list.length; i++) if (qStatus(list[i].id) === 'done') done++;
    return { done: done, total: list.length, pct: list.length ? done / list.length * 100 : 0 };
  }

  BUILDERS.quests = function (root) {
    const list = questList();
    if (!list.length) { root.appendChild(muted('Quest data (G.Data.quests) is not available yet.')); return; }
    if (!G.Quests) root.appendChild(hint('G.Quests is not loaded — statuses show as available and actions will report "not available".'));
    const bar_ = bar('xp'); const bt = el('span', { class: 'adm-count', style: { margin: 0, minWidth: '190px' } });
    live(function () { const c = completion(); bar_.set(c.done, Math.max(1, c.total), c.done + ' / ' + c.total); bt.textContent = 'Completion ' + num(c.pct).toFixed(1) + '%'; });
    root.appendChild(el('div', { class: 'adm-bar-wrap' }, [bt, bar_]));
    const search = textIn('', 'Search quests…', 200);
    const filt = selectIn([{ value: '', label: 'All' }, { value: 'story', label: 'Story' }, { value: 'side', label: 'Side' }, { value: 'available', label: 'Available' }, { value: 'active', label: 'Active' }, { value: 'complete', label: 'Ready to turn in' }, { value: 'done', label: 'Done' }], '', 140);
    const tbl = el('table', { class: 'data adm-table' });
    const countEl = el('div', { class: 'adm-count' });
    function render() {
      const q = search.value.trim().toLowerCase(); const f = filt.value;
      while (tbl.firstChild) tbl.removeChild(tbl.firstChild);
      tbl.appendChild(el('thead', {}, [el('tr', {}, [el('th', { text: 'Id' }), el('th', { text: 'Type' }), el('th', { text: 'Lvl' }), el('th', { text: 'Name' }), el('th', { text: 'Zone' }), el('th', { text: 'Status' }), el('th', { text: '' })])]));
      const tb = el('tbody');
      let n = 0;
      for (let i = 0; i < list.length; i++) {
        const d = list[i]; const st = qStatus(d.id);
        if (f === 'story' || f === 'side') { if (d.type !== f) continue; } else if (f && st !== f) continue;
        if (q && (d.name + ' ' + d.id + ' ' + str(d.book) + ' ' + zoneName(d.zone)).toLowerCase().indexOf(q) < 0) continue;
        if (++n > 200) break;
        (function (d, st) {
          const acts = el('td', { class: 'acts' }, [
            st === 'available' ? btn('Accept', function () { qAccept(d.id); render(); }, 'small') : null,
            st !== 'done' ? btn('Complete', function () { qComplete(d.id); render(); }, 'small primary') : null,
            st !== 'available' ? btn('Reset', function () { qReset(d.id); render(); }, 'small') : null,
            btn('Giver', function () { qGoto(d.id); }, 'small', 'Teleport to the quest giver'),
            (st === 'active' || st === 'complete') ? btn('Track', function () { qTrack(d.id); }, 'small') : null,
          ]);
          tb.appendChild(el('tr', {}, [el('td', { text: d.id, class: 'muted' }), el('td', {}, [pill(d.type === 'story' ? 'Story' : 'Side', d.type)]), el('td', { text: num(d.level, 1) }),
            el('td', { class: 'qn', text: d.name, title: (d.book ? d.book + '\n' : '') + (d.text && d.text.intro ? d.text.intro : '') }), el('td', { text: zoneName(d.zone).replace(/^The /, ''), class: 'muted' }),
            el('td', {}, [el('span', { class: 'adm-st ' + st, text: st })]), acts]));
        })(d, st);
      }
      tbl.appendChild(tb);
      countEl.textContent = (n > 200 ? 'Showing 200 of more' : n + ' quest' + (n === 1 ? '' : 's')) + (G.Quests && G.Quests.tracked ? ' · tracking ' + qName(G.Quests.tracked) : '');
    }
    search.addEventListener('input', typeof G.debounce === 'function' ? G.debounce(render, 120) : render);
    filt.addEventListener('change', render);
    root.appendChild(section('Bulk', [row([
      btn('Accept next available', function () { acceptNext(); render(); }, 'primary'),
      btn('Complete all story', function () { confirmThen('Force-complete every story quest?', function () { let n = 0; for (let i = 0; i < list.length; i++) if (list[i].type === 'story' && qStatus(list[i].id) !== 'done' && qComplete(list[i].id, true)) n++; toast('Completed ' + n + ' story quests', 'quest'); render(); }); }),
      btn('Complete all', function () { confirmThen('Force-complete ALL ' + list.length + ' quests?', function () { let n = 0; for (let i = 0; i < list.length; i++) if (qStatus(list[i].id) !== 'done' && qComplete(list[i].id, true)) n++; toast('Completed ' + n + ' quests', 'quest'); render(); }); }),
      btn('Reset all', function () { confirmThen('Reset every quest to "available"?', function () { let n = 0; for (let i = list.length - 1; i >= 0; i--) if (qStatus(list[i].id) !== 'available' && qReset(list[i].id, true)) n++; toast('Reset ' + n + ' quests'); render(); }); }, 'danger'),
    ])]));
    root.appendChild(section('All quests (' + list.length + ')', [row([search, filt, countEl]), tbl]));
    render();
  };

  // ================================================================================================ WORLD
  function setTime(h) {
    h = ((num(h, 8) % 24) + 24) % 24;
    ensureState();
    G.time.dayTime = h;
    if (G.Sky && has(G.Sky, 'setTime')) G.Sky.setTime(h);
    return h;
  }
  function setWeather(kind) {
    if (!kind) return false;
    if (G.Sky && has(G.Sky, 'setWeather')) G.Sky.setWeather(kind, true);
    else { ensureState(); G.state.weather = kind; emit('weatherChanged', kind); }
    toast('Weather: ' + kind);
    return true;
  }
  function setClockPaused(v) {
    const st = ensureState();
    if (v && !st.clockPaused) { S.dayLenBeforePause = num(G.time.dayLengthMinutes, 24) || 24; G.time.dayLengthMinutes = 1e9; }
    else if (!v && st.clockPaused) { G.time.dayLengthMinutes = S.dayLenBeforePause > 0 && S.dayLenBeforePause < 1e8 ? S.dayLenBeforePause : 24; }
    st.clockPaused = !!v;
  }
  function spawnMonster(typeId, opts) {
    if (!G.Monsters || !has(G.Monsters, 'spawnAt')) return na('Monsters');
    const p = player(); if (!p || !p.pos) return na('Player');
    opts = opts || {};
    const count = Math.max(1, Math.min(50, Math.round(num(opts.count, 1))));
    let made = 0;
    for (let i = 0; i < count; i++) {
      const a = rand() * TAU, r = 3 + rand() * 3;
      const x = p.pos.x + Math.cos(a) * r, z = p.pos.z + Math.sin(a) * r;
      const o = { extra: true, yaw: Math.atan2(-(p.pos.x - x), -(p.pos.z - z)) };
      if (opts.level > 0) o.level = Math.round(opts.level);
      if (opts.elite) o.elite = true;
      if (opts.boss) o.boss = true;
      const e = G.Monsters.spawnAt(typeId, x, z, o);
      if (e) made++;
    }
    const t = (world() && world().monsterById && world().monsterById[typeId]) || null;
    if (made) toast('Spawned ' + made + ' × ' + (t ? t.name : typeId) + (opts.boss ? ' (boss)' : opts.elite ? ' (elite)' : ''), 'warning'); else warn('Nothing was spawned');
    return made;
  }
  function clearCorpses() {
    if (!G.Monsters || !has(G.Monsters, 'all')) return na('Monsters');
    const live_ = G.Monsters.all() || []; const dead = [];
    for (let i = 0; i < live_.length; i++) if (live_[i] && live_[i].dead) dead.push(live_[i]);
    for (let i = 0; i < dead.length; i++) { if (has(G.Monsters, 'despawn')) G.Monsters.despawn(dead[i]); else if (typeof G.removeEntity === 'function') G.removeEntity(dead[i]); }
    toast('Cleared ' + dead.length + ' corpses');
    return dead.length;
  }
  function spawnAINear() {
    const A = G.AIPlayers; const p = player();
    if (!A) return na('AI players');
    if (!p || !p.pos) return na('Player');
    const a = rand() * TAU, r = 3 + rand() * 3;
    const x = p.pos.x + Math.cos(a) * r, z = p.pos.z + Math.sin(a) * r;
    let ent = null;
    if (has(A, 'spawnNear')) ent = A.spawnNear(x, z);
    else if (has(A, 'spawnAt')) ent = A.spawnAt(x, z);
    else if (has(A, 'summon')) ent = A.summon(x, z);
    else if (has(A, 'list')) {
      const list = A.list() || []; if (!list.length) return warn('There are no AI players to bring here');
      const pick = list[Math.floor(rand() * list.length)];
      if (has(A, 'moveTo')) A.moveTo(pick.id, x, z);
      else if (has(A, 'setPos')) A.setPos(pick.id, x, z);
      else if (pick.pos && typeof pick.pos.x === 'number') { pick.pos.x = x; pick.pos.z = z; pick.zone = G.state.zone; }
      else return na('AI player placement');
      ent = pick;
    } else return na('AI player spawning');
    toast(ent && ent.name ? ent.name + ' appears beside you' : 'An AI player appears beside you');
    return true;
  }

  BUILDERS.world = function (root) {
    const st = ensureState();
    // ---- time
    const tSl = slider('Time of day', 0, 24, 0.05, function () { return num(G.time.dayTime, 8); }, function (v) { setTime(v); }, function (v) { return clock(v); });
    const presets = [['Dawn', 5.5], ['Morning', 8], ['Noon', 12], ['Afternoon', 15], ['Dusk', 18.8], ['Night', 21], ['Midnight', 0]];
    const dayLen = numIn(num(st.clockPaused ? S.dayLenBeforePause : G.time.dayLengthMinutes, 24), 1, 1440, 1, 70);
    root.appendChild(section('Time', [
      tSl,
      row([lbl('Presets')].concat(presets.map(function (pr) { return btn(pr[0], function () { setTime(pr[1]); tSl.refresh(); toast(pr[0] + ' — ' + clock(pr[1])); }); }))),
      row([lbl('Day length'), dayLen, el('span', { class: 'adm-unit', text: 'min' }), btn('Set', function () { const v = clamp(num(dayLen.value, 24), 1, 1440); dayLen.value = v; if (st.clockPaused) S.dayLenBeforePause = v; else G.time.dayLengthMinutes = v; toast('A day now lasts ' + v + ' minutes'); }),
        el('span', { class: 'sep' }), toggle('Pause the clock', function () { return !!st.clockPaused; }, function (v) { setClockPaused(v); toast(v ? 'The sun stands still' : 'Time flows again'); })]),
    ]));
    // ---- weather
    const kinds = (G.Sky && Array.isArray(G.Sky.WEATHER_KINDS) && G.Sky.WEATHER_KINDS.length) ? G.Sky.WEATHER_KINDS : ['clear', 'cloudy', 'rain', 'snow', 'storm'];
    const wSel = selectIn(kinds.map(function (k) { return { value: k, label: typeof G.titleCase === 'function' ? G.titleCase(k) : k }; }), (G.Sky && G.Sky.weather) || st.weather || 'clear', 120);
    wSel.addEventListener('change', function () { setWeather(wSel.value); });
    const autoTog = toggle('Auto weather', function () { return G.Sky ? G.Sky.autoWeather !== false : false; }, function (v) { if (!G.Sky || !('autoWeather' in G.Sky)) { na('Sky'); return; } G.Sky.autoWeather = v; toast('Automatic weather ' + (v ? 'on' : 'off')); });
    root.appendChild(section('Weather', [
      row([lbl('Weather'), wSel].concat(kinds.map(function (k) { return btn(typeof G.titleCase === 'function' ? G.titleCase(k) : k, function () { wSel.value = k; setWeather(k); }, 'small'); })).concat([el('span', { class: 'sep' }), autoTog])),
      row([btn('Roll random weather', function () { if (!G.Sky || !has(G.Sky, 'rollWeather')) return na('Sky'); const k = G.Sky.rollWeather(); wSel.value = k || wSel.value; toast('The weather turns ' + (k || '')); }), btn('Lightning strike', function () { if (!G.Sky || !has(G.Sky, 'lightning')) return na('Sky'); G.Sky.lightning(); toast('Thunder rolls'); })]),
    ]));
    // ---- monsters
    const w = world();
    const types = (w && Array.isArray(w.monsterTypes)) ? w.monsterTypes.slice().sort(function (a, b) { return num(a.level && a.level[0], 1) - num(b.level && b.level[0], 1) || String(a.name).localeCompare(String(b.name)); }) : [];
    const mf = textIn('', 'Filter by name, family or zone…', 220);
    const mSel = el('select', { style: { width: '330px' } });
    const fillM = function () {
      const q = mf.value.trim().toLowerCase();
      while (mSel.firstChild) mSel.removeChild(mSel.firstChild);
      let n = 0;
      for (let i = 0; i < types.length; i++) {
        const t = types[i]; const hay = (t.name + ' ' + str(t.family) + ' ' + str(t.zone) + ' ' + zoneName(t.zone) + ' ' + t.id).toLowerCase();
        if (q && hay.indexOf(q) < 0) continue;
        mSel.appendChild(el('option', { value: t.id, text: t.name + ' — ' + str(t.family) + ', L' + (Array.isArray(t.level) ? t.level[0] + '–' + t.level[1] : num(t.level, 1)) + ', ' + zoneName(t.zone).replace(/^The /, '') + (t.boss ? ' [BOSS]' : t.elite ? ' [elite]' : '') }));
        n++;
      }
      if (!n) mSel.appendChild(el('option', { value: '', text: '(no monster type matches)' }));
    };
    mf.addEventListener('input', fillM); fillM();
    const lvlIn = numIn('', 1, 120, 1, 66, 'auto'), cntIn = numIn(1, 1, 50, 1, 58);
    let elite = false, boss = false;
    const mstat = el('span', { class: 'adm-count', style: { margin: 0 } });
    live(function () { if (G.Monsters && has(G.Monsters, 'stats')) { const s = G.Monsters.stats() || {}; mstat.textContent = num(s.alive) + ' alive · ' + num(s.corpses) + ' corpses · ' + num(s.rigs) + ' rigs'; } else if (G.Monsters && has(G.Monsters, 'all')) { const l = G.Monsters.all() || []; let a = 0; for (let i = 0; i < l.length; i++) if (!l[i].dead) a++; mstat.textContent = a + ' alive · ' + (l.length - a) + ' corpses'; } else mstat.textContent = 'monsters not loaded'; });
    root.appendChild(section('Spawn monsters (' + types.length + ' types)', [
      row([mf, mSel]),
      row([lbl('Level'), lvlIn, lbl('Count', 44), cntIn, toggle('Elite', function () { return elite; }, function (v) { elite = v; }), toggle('Boss', function () { return boss; }, function (v) { boss = v; }),
        btn('Spawn near me', function () { if (!mSel.value) return warn('Pick a monster type'); spawnMonster(mSel.value, { level: num(lvlIn.value, 0), count: num(cntIn.value, 1), elite: elite, boss: boss }); }, 'primary')]),
      row([btn('Kill all within 60 m', function () { if (!G.Monsters || !has(G.Monsters, 'killAllNear')) return na('Monsters'); const p = player(); if (!p) return na('Player'); const n = G.Monsters.killAllNear(p.pos, 60); toast('Slew ' + num(n) + ' monsters', 'warning'); }, 'danger'),
        btn('Respawn all', function () { if (!G.Monsters || !has(G.Monsters, 'respawnAll')) return na('Monsters'); G.Monsters.respawnAll(); toast('Every spawn group re-populated'); }),
        btn('Clear corpses', clearCorpses), mstat]),
    ]));
    root.appendChild(section('AI players', [row([btn('Spawn an AI player near me', spawnAINear, 'primary'), hint('Uses G.AIPlayers.spawnNear when the module offers it, else brings a random AI player to your side.')])]));
  };

  // ================================================================================================ AI PLAYERS
  BUILDERS.ai = function (root) {
    const A = G.AIPlayers;
    if (!A || !has(A, 'list')) { root.appendChild(muted('AI players (G.AIPlayers) are not loaded.')); return; }
    const search = textIn('', 'Search name / class / zone…', 220);
    const popIn = numIn(num(A.active != null ? A.active : (A.list() || []).length), 0, 500, 1, 70);
    const nIn = numIn(5, -79, 79, 1, 60), allIn = numIn(80, 1, levelCap(), 1, 60);
    const aiLevel = function (a, L) { L = Math.round(clamp(num(L, 1), 1, levelCap())); if (has(A, 'setLevel')) A.setLevel(a.id != null ? a.id : a, L); else a.level = L; };
    root.appendChild(section('Population & behaviour', [
      row([lbl('Population'), popIn, btn('Set', function () { if (!has(A, 'setActive')) return na('Population control'); const n = Math.round(clamp(num(popIn.value, 0), 0, 500)); A.setActive(n); toast('Active AI players: ' + n); render(); }),
        el('span', { class: 'sep' }), toggle('Chat spam', function () { return A.chatEnabled !== false; }, function (v) { A.chatEnabled = v; toast('AI chat ' + (v ? 'enabled' : 'silenced')); })]),
      row([lbl('Level all'), nIn, btn('Apply +N', function () { const list = A.list() || []; const d = Math.round(num(nIn.value, 0)); for (let i = 0; i < list.length; i++) aiLevel(list[i], num(list[i].level, 1) + d); toast('Every AI player levelled ' + (d >= 0 ? '+' : '') + d); render(); }),
        el('span', { class: 'sep' }), lbl('Set all to', 66), allIn, btn('Apply', function () { const list = A.list() || []; for (let i = 0; i < list.length; i++) aiLevel(list[i], allIn.value); toast('Every AI player is now level ' + Math.round(num(allIn.value, 1))); render(); })]),
    ]));
    const tbl = el('table', { class: 'data adm-table' });
    const countEl = el('div', { class: 'adm-count' });
    function render() {
      const q = search.value.trim().toLowerCase();
      const list = (A.list() || []).slice().sort(function (a, b) { return num(b.level) - num(a.level) || String(a.name).localeCompare(String(b.name)); });
      while (tbl.firstChild) tbl.removeChild(tbl.firstChild);
      tbl.appendChild(el('thead', {}, [el('tr', {}, [el('th', { text: 'Name' }), el('th', { text: 'Race / class' }), el('th', { text: 'Lvl' }), el('th', { text: 'Zone' }), el('th', { text: 'State' }), el('th', { text: '' })])]));
      const tb = el('tbody'); let n = 0;
      for (let i = 0; i < list.length; i++) {
        const a = list[i]; if (!a) continue;
        if (q && (str(a.name) + ' ' + raceName(a.race) + ' ' + className(a.cls) + ' ' + zoneName(a.zone) + ' ' + str(a.state)).toLowerCase().indexOf(q) < 0) continue;
        if (++n > 200) break;
        (function (a) {
          const li = numIn(num(a.level, 1), 1, levelCap(), 1, 58);
          tb.appendChild(el('tr', {}, [el('td', { text: str(a.name), class: 'gold-text' }), el('td', { text: raceName(a.race) + ' ' + className(a.cls) }), el('td', { text: num(a.level, 1) }), el('td', { text: zoneName(a.zone).replace(/^The /, ''), class: 'muted' }), el('td', { text: str(a.state || (a.ai && a.ai.state) || ''), class: 'muted' }),
            el('td', { class: 'acts' }, [btn('Teleport to', function () { if (!has(A, 'teleportTo')) return na('AI teleport'); A.teleportTo(a.id != null ? a.id : a); toast('Teleported to ' + a.name); }, 'small primary'), li, btn('Set level', function () { aiLevel(a, li.value); toast(a.name + ' is now level ' + Math.round(num(li.value, 1))); render(); }, 'small')])]));
        })(a);
      }
      tbl.appendChild(tb);
      countEl.textContent = (n > 200 ? 'Showing 200 of ' + list.length : n + ' of ' + list.length + ' AI players');
    }
    search.addEventListener('input', typeof G.debounce === 'function' ? G.debounce(render, 120) : render);
    root.appendChild(section('Players', [row([search, countEl]), tbl]));
    render();
    live(function () { /* keep levels/zones fresh every few seconds without stealing focus */ if (document.activeElement && S.contentEl && S.contentEl.contains(document.activeElement)) return; S.aiT = (S.aiT || 0) + 1; if (S.aiT % 12 === 0) render(); });
  };

  // ================================================================================================ MAP
  function places() { return ensureState().customPlaces; }
  function placesChanged() {
    emit('customPlacesChanged', places());
    if (UI.minimap && has(UI.minimap, 'redraw')) { try { UI.minimap.redraw(); } catch (_) { /* optional */ } }
  }
  function addPlace(name, x, z, icon) {
    name = str(name).trim().slice(0, 32) || 'Place ' + (places().length + 1);
    if (!isFinite(+x) || !isFinite(+z)) return warn('Bad coordinates');
    const id = 'cp_' + (typeof G.hashStr === 'function' ? (G.hashStr(name + ':' + Math.round(x) + ':' + Math.round(z)) >>> 0).toString(36) : Math.round(Math.abs(x) * 7 + Math.abs(z)).toString(36)) + '_' + places().length;
    const pl = { id: id, name: name, x: Math.round(+x), z: Math.round(+z), icon: str(icon).trim().slice(0, 2) || '◆' };
    places().push(pl);
    placesChanged();
    toast('Added map place "' + name + '" at ' + pl.x + ', ' + pl.z);
    return pl;
  }
  function removePlace(id) {
    const list = places();
    for (let i = 0; i < list.length; i++) if (list[i].id === id) { const nm = list[i].name; list.splice(i, 1); placesChanged(); toast('Removed "' + nm + '"'); return true; }
    return false;
  }
  function renameTown(id, name) {
    const w = world(); const t = w && w.townById && w.townById[id];
    if (!t) return warn('Unknown town');
    name = str(name).trim().slice(0, 40); if (!name) return warn('Enter a name');
    if (S.townOrig[id] == null) S.townOrig[id] = t.name;
    t.name = name;
    emit('townRenamed', { id: id, name: name });
    placesChanged();
    toast('Town renamed to ' + name + ' (maps update on their next redraw)');
    return true;
  }

  BUILDERS.map = function (root) {
    const p = player();
    const nameIn = textIn('', 'Place name', 170), iconIn = textIn('◆', 'Icon', 44);
    const xIn = numIn(p && p.pos ? Math.round(p.pos.x) : 0, -2048, 2048, 1, 80), zIn = numIn(p && p.pos ? Math.round(p.pos.z) : 0, -2048, 2048, 1, 80);
    const listEl = el('div');
    function renderList() {
      while (listEl.firstChild) listEl.removeChild(listEl.firstChild);
      const list = places();
      if (!list.length) { listEl.appendChild(hint('No custom places yet. They show on the M map and the minimap and are saved with the game.')); return; }
      for (let i = 0; i < list.length; i++) {
        (function (pl) {
          listEl.appendChild(el('div', { class: 'adm-place' }, [el('span', { class: 'glyph', text: pl.icon || '◆' }), el('span', { class: 'nm', text: pl.name }), el('span', { class: 'meta', text: pl.x + ', ' + pl.z + ' · ' + zoneName(world() && has(world(), 'zoneAt') ? world().zoneAt(pl.x, pl.z) : '') }),
            btn('Teleport', function () { teleportTo(pl.x, pl.z, pl.name); }, 'small'),
            btn('Waypoint', function () { if (!has(UI, 'setWaypoint')) return na('Waypoints'); UI.setWaypoint(pl.x, pl.z, pl.name); }, 'small'),
            btn('Remove', function () { removePlace(pl.id); renderList(); }, 'small danger')]));
        })(list[i]);
      }
    }
    root.appendChild(section('Custom map places', [
      row([lbl('Name'), nameIn, lbl('Icon', 36), iconIn, btn('Add at my position', function () { if (!p || !p.pos) return na('Player'); addPlace(nameIn.value, p.pos.x, p.pos.z, iconIn.value); nameIn.value = ''; renderList(); }, 'primary')]),
      row([lbl('X / Z'), xIn, zIn, btn('Add at X, Z', function () { addPlace(nameIn.value, xIn.value, zIn.value, iconIn.value); nameIn.value = ''; renderList(); }), el('span', { class: 'sep' }),
        btn('Clear all', function () { const list = places(); if (!list.length) return warn('Nothing to clear'); confirmThen('Remove all ' + list.length + ' custom places?', function () { list.length = 0; placesChanged(); toast('Custom places cleared'); renderList(); }); }, 'danger')]),
      listEl,
    ]));
    renderList();
    const w = world();
    const towns = (w && Array.isArray(w.towns)) ? w.towns : [];
    if (towns.length) {
      const tSel = selectIn(towns.map(function (t) { return { value: t.id, label: t.name + ' (' + zoneName(t.zone).replace(/^The /, '') + ')' }; }), towns[0].id, 260);
      const tName = textIn(towns[0].name, 'New town name', 200);
      tSel.addEventListener('change', function () { const t = w.townById ? w.townById[tSel.value] : null; tName.value = t ? t.name : ''; });
      root.appendChild(section('Rename towns', [
        row([tSel, tName, btn('Rename', function () { if (renameTown(tSel.value, tName.value)) Admin.refresh(); }, 'primary'), btn('Restore original', function () { const o = S.townOrig[tSel.value]; if (o == null) return warn('This town has not been renamed'); renameTown(tSel.value, o); delete S.townOrig[tSel.value]; Admin.refresh(); })]),
        hint('Town names are used by the map, minimap, quest text and travel lists; renamed towns keep their id. Names are not saved — rename again after a reload.'),
      ]));
    }
  };

  // ================================================================================================ SETTINGS / DEBUG
  function setWireframe(on) {
    const scene = G.Game && G.Game.scene;
    if (!scene || !has(scene, 'traverse')) return na('Scene');
    if (on) {
      S.wire = [];
      scene.traverse(function (o) { const m = o.material; if (!m) return; const arr = Array.isArray(m) ? m : [m]; for (let i = 0; i < arr.length; i++) { const mat = arr[i]; if (mat && 'wireframe' in mat && !mat.wireframe) { mat.wireframe = true; S.wire.push(mat); } } });
    } else { const list = S.wire || []; for (let i = 0; i < list.length; i++) list[i].wireframe = false; S.wire = null; }
    ensureState().wireframe = !!on;
    toast('Wireframe ' + (on ? 'on (' + (S.wire ? S.wire.length : 0) + ' materials)' : 'off'));
    return true;
  }
  function setTopDown(on) {
    const cam = G.Player && G.Player.cam;
    if (!cam) return na('Player camera');
    if (on) { S.camSaved = { pitch: num(cam.pitch, -0.3), dist: num(cam.dist, 7), targetDist: num(cam.targetDist, cam.dist) }; cam.pitch = -80 * PI / 180; cam.dist = 28; if ('targetDist' in cam) cam.targetDist = 28; }
    else if (S.camSaved) { cam.pitch = S.camSaved.pitch; cam.dist = S.camSaved.dist; if ('targetDist' in cam) cam.targetDist = S.camSaved.targetDist; S.camSaved = null; }
    ensureState().topDown = !!on;
    toast('Top-down view ' + (on ? 'on' : 'off'));
    return true;
  }
  function reloadChunks() {
    const T = G.Terrain; const did = [];
    const names = ['reload', 'rebuild', 'rebuildChunks', 'clearChunks', 'invalidate'];
    for (let i = 0; i < names.length; i++) if (T && has(T, names[i])) { T[names[i]](); did.push('terrain'); break; }
    if (G.Veg && has(G.Veg, 'setDensity')) { const pr = G.PostFX && G.PostFX.PRESETS && G.PostFX.PRESETS[G.state.quality]; G.Veg.setDensity(num(pr && pr.density, 1) || 1); did.push('vegetation'); }
    if (G.Terrain && has(G.Terrain, 'update') && player() && player().pos) { try { G.Terrain.update(player().pos, 1); did.push('chunk stream'); } catch (_) { /* optional */ } }
    if (UI.minimap && has(UI.minimap, 'redraw')) { UI.minimap.redraw(); did.push('minimap'); }
    if (!did.length) return na('World reload');
    toast('Reloaded: ' + did.join(', '));
    return true;
  }

  BUILDERS.debug = function (root) {
    const st = ensureState();
    const FX = G.PostFX;
    if (FX && FX.params && !S.pfxDefaults) S.pfxDefaults = Object.assign({}, FX.params);
    const qSel = selectIn([{ value: 'auto', label: 'Auto' }, { value: 'ultra', label: 'Ultra' }, { value: 'high', label: 'High' }, { value: 'medium', label: 'Medium' }, { value: 'low', label: 'Low' }], st.quality || 'high', 110);
    qSel.addEventListener('change', function () { if (!FX || !has(FX, 'setQuality')) { st.quality = qSel.value; return na('PostFX'); } const q = FX.setQuality(qSel.value); toast('Graphics quality: ' + q); });
    root.appendChild(section('Graphics', [
      row([lbl('Quality'), qSel,
        toggle('Post-processing', function () { return !!(FX && FX.enabled !== false); }, function (v) { if (!FX) { na('PostFX'); return; } FX.enabled = v; toast('Post-processing ' + (v ? 'on' : 'off')); }),
        toggle('Show FPS', function () { return !!(st.settings && st.settings.showFps); }, function (v) { st.settings.showFps = v; toast('FPS counter ' + (v ? 'shown' : 'hidden')); }),
        toggle('Wireframe', function () { return !!st.wireframe; }, function (v) { setWireframe(v); }),
        toggle('Show colliders', function () { return !!(G.Physics && G.Physics.debugVisible); }, function () { if (!G.Physics || !has(G.Physics, 'debugMesh')) { na('Physics debug'); return; } const scene = G.Game && G.Game.scene; G.Physics.debugMesh(scene || null); toast('Collider view ' + (G.Physics.debugVisible ? 'on' : 'off')); })]),
    ]));
    if (FX && FX.params) {
      const P = FX.params;
      const defs = [['bloom', 'Bloom', 0, 2, 0.01], ['exposure', 'Exposure', 0.2, 3, 0.01], ['vignette', 'Vignette', 0, 1, 0.01], ['saturation', 'Saturation', 0, 2, 0.01], ['contrast', 'Contrast', 0.5, 1.5, 0.01], ['sharpen', 'Sharpen', 0, 1, 0.01], ['grain', 'Film grain', 0, 0.2, 0.005], ['bloomThreshold', 'Bloom threshold', 0, 2, 0.01]];
      const sliders = defs.map(function (d) { return slider(d[1], d[2], d[3], d[4], function () { return num(P[d[0]], d[2]); }, function (v) { P[d[0]] = v; }, function (v) { return v.toFixed(2); }); });
      root.appendChild(section('Post-processing parameters', sliders.concat([row([btn('Reset to defaults', function () { if (S.pfxDefaults) for (const k in S.pfxDefaults) P[k] = S.pfxDefaults[k]; sliders.forEach(function (s) { s.refresh(); }); toast('PostFX parameters restored'); }),
        toggle('ACES tonemap', function () { return P.tonemap !== false; }, function (v) { P.tonemap = v; toast('Tonemap ' + (v ? 'on' : 'off')); })])])));
    } else root.appendChild(section('Post-processing parameters', [muted('G.PostFX is not loaded.')]));
    // ---- movement / time
    root.appendChild(section('Movement & time', [
      row([toggle('Free-fly camera', function () { return !!st.flyCam; }, function (v) { setOverride('flyCam', v); toast('Free-fly ' + (v ? 'on — Space/Shift to rise/sink' : 'off')); }),
        toggle('Noclip', function () { return !!st.noclip; }, function (v) { setOverride('noclip', v); toast('Noclip ' + (v ? 'on' : 'off')); }),
        toggle('Top-down view', function () { return !!st.topDown; }, function (v) { setTopDown(v); }),
        toggle('Pause game', function () { return !!G.time.paused; }, function (v) { G.time.paused = v; toast(v ? 'Game paused (UI still runs)' : 'Game resumed'); })]),
      slider('Time scale', 0, 5, 0.05, function () { return num(G.time.scale, 1); }, function (v) { G.time.scale = v; updateChip(); }, function (v) { return '×' + v.toFixed(2); }),
      row([btn('Normal speed', function () { G.time.scale = 1; updateChip(); Admin.refresh(); toast('Time scale ×1'); }), btn('Slow motion ×0.25', function () { G.time.scale = 0.25; updateChip(); Admin.refresh(); toast('Time scale ×0.25'); }), btn('Fast ×3', function () { G.time.scale = 3; updateChip(); Admin.refresh(); toast('Time scale ×3'); }),
        el('span', { class: 'sep' }), btn('Reload world chunks', reloadChunks)]),
    ]));
    // ---- counters
    const counters = kv([['FPS', ''], ['Frame', ''], ['Draw calls', ''], ['Triangles', ''], ['Entities', ''], ['Monsters alive', ''], ['NPCs rendered', ''], ['Colliders', ''], ['PostFX', ''], ['Quality', ''], ['Game time', ''], ['Errors', '']]);
    live(function () {
      const fps = (G.Game && num(G.Game.fps) > 0) ? G.Game.fps : num(UI.fps, 0);
      counters.set(0, fps ? Math.round(fps) : '—'); counters.set(1, fps ? (1000 / fps).toFixed(1) + ' ms' : '—');
      const info = G.Game && G.Game.renderer && G.Game.renderer.info && G.Game.renderer.info.render;
      counters.set(2, info ? fmtNum(info.calls) : '—'); counters.set(3, info ? fmtNum(info.triangles) : '—');
      counters.set(4, G.state.entities ? fmtNum(G.state.entities.length) : '—');
      let ma = '—'; if (G.Monsters && has(G.Monsters, 'stats')) { const s = G.Monsters.stats() || {}; ma = num(s.alive) + ' (+' + num(s.corpses) + ' corpses)'; } else if (G.Monsters && has(G.Monsters, 'countAlive')) ma = G.Monsters.countAlive();
      counters.set(5, ma);
      counters.set(6, G.NPCs && Array.isArray(G.NPCs.rendered) ? G.NPCs.rendered.length : '—');
      counters.set(7, G.Physics && has(G.Physics, 'colliderCount') ? fmtNum(G.Physics.colliderCount()) : '—');
      counters.set(8, FX && FX.stats ? num(FX.stats.ms).toFixed(2) + ' ms · ' + num(FX.stats.passes) + ' passes · ' + num(FX.stats.width) + '×' + num(FX.stats.height) : '—');
      counters.set(9, str(st.quality) + (G.PostFX && G.PostFX.renderScale && G.PostFX.renderScale !== 1 ? ' @' + G.PostFX.renderScale : ''));
      counters.set(10, (typeof G.fmtTime === 'function' ? G.fmtTime(num(G.time.now)) : Math.round(num(G.time.now)) + ' s') + ' · frame ' + num(G.time.frame) + (G.time.paused ? ' · PAUSED' : ''));
      counters.set(11, Array.isArray(G.errors) ? G.errors.length : 0);
    });
    const errBox = el('div', { class: 'adm-errs', hidden: true });
    root.appendChild(section('Live counters', [counters, row([btn('Show captured errors', function () { errBox.hidden = !errBox.hidden; const list = Array.isArray(G.errors) ? G.errors : []; errBox.textContent = list.length ? list.slice(-30).map(function (e) { return typeof e === 'string' ? e : (e && (e.message || e.msg)) || JSON.stringify(e); }).join('\n') : 'No errors captured.'; }),
      btn('Clear errors', function () { if (Array.isArray(G.errors)) G.errors.length = 0; errBox.textContent = 'No errors captured.'; toast('Error log cleared'); }),
      btn('Toggle G.debug logging', function () { G.debug = !G.debug; toast('Debug logging ' + (G.debug ? 'on' : 'off')); })]), errBox]));
  };

  // ================================================================================================ SAVE
  BUILDERS.save = function (root) {
    const Sv = G.Save;
    const exportTa = el('textarea', { class: 'adm-ta', placeholder: 'Press "Export" to dump the current game as JSON…', spellcheck: 'false' });
    const importTa = el('textarea', { class: 'adm-ta', placeholder: 'Paste an exported save here and press "Import"…', spellcheck: 'false' });
    const info = el('span', { class: 'adm-count', style: { margin: 0 } });
    live(function () { if (!Sv) { info.textContent = 'G.Save is not loaded'; return; } let s = ''; if (has(Sv, 'hasSave')) s += (Sv.hasSave() ? 'A save exists' : 'No stored save'); if (Sv.lastSavedAt != null && num(Sv.lastSavedAt) > 0) s += ' · last saved at ' + (typeof G.fmtTime === 'function' ? G.fmtTime(num(Sv.lastSavedAt)) : Math.round(num(Sv.lastSavedAt)) + ' s'); if (Sv.lastSize) s += ' · ' + fmtNum(Sv.lastSize) + ' bytes'; info.textContent = s; });
    function copyText(text) {
      const done = function () { toast('Copied to the clipboard'); };
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text).then(done, function () { fallback(); }); return; }
      fallback();
      function fallback() { try { exportTa.focus(); exportTa.select(); document.execCommand('copy'); done(); } catch (_) { warn('Select the text and copy it manually'); } }
    }
    root.appendChild(section('Save state', [row([
      btn('Save now', function () { if (!Sv || !has(Sv, 'save')) return na('Save'); const r = Sv.save({ reason: 'admin' }); toast(r ? 'Game saved' : 'Save failed' + (Sv.lastError ? ': ' + Sv.lastError : ''), r ? 'info' : 'warning'); }, 'primary'),
      btn('Reset save', function () { confirmThen('Delete the stored save? The running game keeps going until you reload.', function () { if (!Sv || !has(Sv, 'clear')) return na('Save'); Sv.clear(); toast('Stored save deleted', 'warning'); }); }, 'danger'),
      btn('Reset character position', function () { const h = homeTown(); if (!h) return na('Home town'); teleportTo(h.x, h.z, h.name + ' (home)'); }),
      info])]));
    root.appendChild(section('Export', [row([btn('Export JSON', function () { if (!Sv || !has(Sv, 'exportJSON')) return na('Export'); const s = Sv.exportJSON(); exportTa.value = str(s); toast('Exported ' + fmtNum(str(s).length) + ' characters'); }, 'primary'), btn('Copy', function () { if (!exportTa.value) return warn('Nothing to copy — export first'); copyText(exportTa.value); }), btn('Clear', function () { exportTa.value = ''; })]), exportTa]));
    root.appendChild(section('Import', [row([btn('Import JSON', function () {
      if (!Sv || !has(Sv, 'importJSON')) return na('Import');
      const txt = importTa.value.trim(); if (!txt) return warn('Paste a save first');
      const r = Sv.importJSON(txt);
      const ok = r === true || (r && r.ok !== false && r !== false);
      if (ok) { toast('Save imported' + (r && r.summary && r.summary.name ? ': ' + r.summary.name + ' L' + r.summary.level : '') + (has(G.Game, 'startFromSave') ? ' — use "Load imported save" to enter it' : ''), 'quest'); }
      else warn('Import failed' + (r && r.error ? ': ' + r.error : ''));
    }, 'primary'), btn('Load imported save', function () { if (!G.Game || !has(G.Game, 'startFromSave')) return na('G.Game.startFromSave'); Admin.close(); G.Game.startFromSave(); }), btn('Clear', function () { importTa.value = ''; })]), importTa,
    hint('Import validates and stores the save; the world is rebuilt from it when you load it (or continue from the main menu).')]));
  };

  // ------------------------------------------------------------------------------------------------ HUD chip
  function ensureChip() {
    if (S.chip && S.chip.isConnected) return S.chip;
    let hud = document.getElementById('hud');
    if (!hud) { const ui = document.getElementById('ui') || document.body; hud = el('div', { id: 'hud' }); ui.appendChild(hud); }
    S.chipDet = el('span', { class: 'det' });
    S.chip = el('div', { id: 'adminChip', title: 'Admin overrides are active — click to open the admin panel', hidden: true }, [el('span', { class: 'crown', text: '♛' }), el('span', { text: 'ADMIN' }), S.chipDet]);
    S.chip.addEventListener('click', function () { Admin.open(); });
    hud.appendChild(S.chip);
    return S.chip;
  }
  function overrideList() {
    const st = G.state || {}; const out = [];
    if (st.godMode) out.push('god');
    if (typeof st.damageMult === 'number' && st.damageMult !== 1) out.push('dmg ×' + st.damageMult);
    if (typeof st.speedMult === 'number' && st.speedMult !== 1) out.push('speed ×' + st.speedMult);
    if (st.noCooldowns) out.push('no cd');
    if (st.noclip) out.push('noclip');
    if (st.flyCam) out.push('fly');
    if (G.time && typeof G.time.scale === 'number' && G.time.scale !== 1) out.push('time ×' + G.time.scale);
    return out;
  }
  function updateChip() {
    if (!S.chip) { if (!S.inited) return; ensureChip(); }
    const list = overrideList();
    const on = list.length > 0;
    if (S.chip.hidden === on) S.chip.hidden = !on;
    const txt = list.join(' · ');
    if (S.chipDet.textContent !== txt) S.chipDet.textContent = txt;
  }

  // ------------------------------------------------------------------------------------------------ public API
  Admin.TABS = TABS.map(function (t) { return t.id; });
  Object.defineProperty(Admin, 'tab', { get: function () { return S.tab; }, set: function (v) { Admin.showTab(v); } });
  Admin.init = function () {
    if (S.inited) return Admin;
    S.inited = true;
    ensureState();
    if (has(UI, 'addCSS')) UI.addCSS(CSS);
    else { const s = document.createElement('style'); s.setAttribute('data-ui', 'admin'); s.textContent = CSS; (document.head || document.documentElement).appendChild(s); }
    if (has(UI, 'registerPanel')) {
      UI.registerPanel('admin', {
        title: '♛ Admin Panel', width: 880, height: 640, pos: 'center', sound: false, remember: false,
        build: buildPanel,
        onOpen: function () { renderTab(); updateChip(); },
        onClose: function () { liveFns = []; sfx('ui_close'); },
      });
    }
    ensureChip();
    if (G.Input && has(G.Input, 'onSequence')) S.unsub = G.Input.onSequence(C().ADMIN_CODE || 'chris', function () { Admin.open(); });
    if (typeof G.on === 'function') {
      G.on('update', Admin.update);
      G.on('load', function () { updateChip(); if (Admin.isOpen()) renderTab(); });
      G.on('gameStart', function () { updateChip(); const p = player(); if (p && typeof G.state.speedMult === 'number') p.speedMult = G.state.speedMult; });
    }
    return Admin;
  };
  Admin.open = function () {
    if (!S.inited) Admin.init();
    if (!has(UI, 'openPanel')) { if (G.warn) G.warn('Admin: the panel manager (G.UI.openPanel) is missing'); return false; }
    if (!has(UI, 'getPanel') || !UI.getPanel('admin')) { if (!has(UI, 'registerPanel')) return false; UI.registerPanel('admin', { title: '♛ Admin Panel', width: 880, height: 640, pos: 'center', sound: false, remember: false, build: buildPanel, onOpen: function () { renderTab(); updateChip(); }, onClose: function () { liveFns = []; } }); }
    if (has(UI, 'closeAll')) UI.closeAll();
    const ok = UI.openPanel('admin');
    if (ok !== false) sfx('admin_open');
    return ok !== false;
  };
  Admin.close = function () { if (has(UI, 'closePanel')) return UI.closePanel('admin'); return false; };
  Admin.isOpen = function () { return !!(has(UI, 'isOpen') && UI.isOpen('admin')); };
  Admin.refresh = function () { if (!S.contentEl) return false; const top = S.contentEl.scrollTop; renderTab(); S.contentEl.scrollTop = top; return true; };
  Admin.showTab = function (id) {
    let ok = false;
    for (let i = 0; i < TABS.length; i++) if (TABS[i].id === id) ok = true;
    if (!ok) return false;
    S.tab = id;
    if (S.contentEl) renderTab();
    return true;
  };
  Admin.overridesActive = function () { return overrideList().length > 0; };
  Admin.update = function (dt) {
    dt = num(dt, 0.016);
    S.chipT += dt;
    if (S.chipT >= 0.5) { S.chipT = 0; updateChip(); }
    if (!Admin.isOpen()) return;
    S.tickT += dt;
    if (S.tickT < 0.25) return;
    S.tickT = 0;
    for (let i = 0; i < liveFns.length; i++) { try { liveFns[i](); } catch (err) { report(err, 'admin live'); } }
  };
  Admin.setLevel = setLevel;
  Admin.giveItem = giveItem;
  Admin.spawnMonster = spawnMonster;
  Admin.addPlace = addPlace;
  Admin.removePlace = removePlace;
  Admin.teleportTo = teleportTo;
  Admin.teleportToNpc = teleportToNpc;
  Admin.setTime = setTime;
  Admin.setWeather = setWeather;
  Admin.learnAllAbilities = learnAllAbilities;
  Admin.overrideList = overrideList;

  if (typeof G.on === 'function') G.on('init', function () { Admin.init(); });
  if (typeof G.log === 'function') G.log('32_ui_admin ready');
})();
