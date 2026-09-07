/* ==== 31_ui_panels.js — every windowed panel of Chris Jensen's Lord of the Rings Online, built on the G.UI panel
   manager from 30_ui_hud.js: Inventory (I), Character sheet with a live 3D paper-doll preview (C), Abilities &
   training (K), Quest Journal (J), World Map (M), Players of Middle-earth (P), NPC Dialogue with quest sub-views,
   Vendor (buy / sell / buy-back), Travel (stable-master swift travel + dock sailing), Settings (Esc) and the
   quest-reward Choose window. Every panel is registered with G.UI.registerPanel (keys via def.key) and refreshes
   itself on the relevant bus events (inventoryChanged, equipChanged, goldChanged, abilityTrained, hotbarChanged,
   playerLevelUp, questAccepted / questProgress / questCompleted, load, gameStart, titleEarned, qualityChanged).

   Public API (SPEC §7.2) — each object below has open(...), close(), refresh(), isOpen(), mark() (lazy refresh) and
   `panel` (the G.UI panel record once built):
     G.UI.Inventory   open(), highlight(tid), setFilter(id), sort(), filters, filter, splitStack(index, count)
     G.UI.Character   open(tab?), setTab('stats'|'sets'|'titles'), rebuildPreview(), preview (renderer state)
     G.UI.Abilities   open(id?), select(id)
     G.UI.Journal     open(questId?), select(questId), setTab('active'|'available'|'completed'), selected
     G.UI.Map         open(), centerOn(x, z), focus(x, z, zoom?), setZoom(z), zoom, setWaypointMode(bool),
                      showAI (bool), showLegend (bool), worldAt(clientX, clientY)
     G.UI.Players     open(id?), select(id), search(text), sortBy(column)
     G.UI.Dialogue    open(npc, greeting, options), showQuest(quest, mode), back(), npc, setText(text)
     G.UI.Vendor      open(npc, stock), npc, stock
     G.UI.Travel      openStable(npc), openDock(dock, npc?), fade(on|seconds, seconds?, onBlack?)
     G.UI.Settings    open(), apply() (pushes G.state.settings into Audio/PostFX/Player/Sky/Veg), get()
     G.UI.Choose      open(items, onPick(index, inst|null), opts{title, text, take, cancel}), close()
   Shared helpers exposed for other UI modules: G.UI.contextMenu(items, x, y) (items: [{label, icon?, cls?,
   disabled?, onClick}] or null separators), G.UI.closeContextMenu(). If no module defines G.UI.fade, a fallback
   `G.UI.fade(bool | seconds)` is installed here (20_player and 26_fishing_boats probe for it).
   Waypoints: the map/players panels call G.UI.setWaypoint (HUD compass + minimap) AND mirror it to
   G.state.waypoint = {x, z, label} for modules that read state only.
   Private helpers (prefixed _ or module-local): _splitStack (inventory stack split — 03 has no split API, so it
   uses G.Items.create + a direct slot write and emits inventoryChanged), _fade overlay, _menu, the 3D preview.
   Assumptions about other modules (every call guarded): G.Items (03), G.Data.* (02/04/05/06), G.Progress /
   G.Combat (21), G.NPCs.dialogueOptions/choose/endTalk/buy/sell/sellJunk/buyback/rebuy/activeVendor (23),
   G.Quests.* + G.AutoQuest (24), G.AIPlayers.list/inspect/teleportTo (25), G.Boats.routesFrom/board/sailTo (26),
   G.Chars.buildHumanoid (14), G.Terrain.mapCanvas/worldToMap/mapToWorld/zoneAt (10), G.Player.camera/cam/teleport
   (20), G.Audio.setVolumes (01), G.PostFX.setQuality (17), G.Sky.setShadowQuality (11), G.Veg.setDensity (12),
   G.Save.save (34), G.Game.toMenu/toCharCreate/renderer (99). ==== */
(function () {
  'use strict';
  const G = window.G;
  if (!G) return;
  const UI = G.UI = G.UI || {};
  const C = G.C || {};
  const el = G.el;
  const esc = G.escapeHTML;
  const clamp = G.clamp;
  const THREE = window.THREE;

  // ================================================================================================ helpers
  function _num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function _str(v) { return v == null ? '' : String(v); }
  function _has(o, fn) { return !!(o && typeof o[fn] === 'function'); }
  function _player() { return G.state && G.state.player; }
  function _now() { return (G.time && typeof G.time.now === 'number') ? G.time.now : 0; }
  function _sfx(name, opts) { try { if (_has(G.Audio, 'sfx') && G.Audio.ready !== false) G.Audio.sfx(name, opts); } catch (_) { /* ignore */ } }
  function _notify(text, kind) { if (_has(UI, 'notify')) UI.notify(text, kind || 'info'); }
  function _report(err, where) { if (_has(G, 'reportError')) G.reportError(err, where); else if (_has(G, 'warn')) G.warn(where + ': ' + (err && err.message)); }
  function _money(c) { return _has(UI, 'formatMoney') ? UI.formatMoney(c) : (_has(G, 'fmtMoneyHTML') ? G.fmtMoneyHTML(c) : String(c)); }
  function _moneyText(c) { return _has(G, 'fmtMoney') ? G.fmtMoney(c) : String(c); }
  function _fmt(n) { return _has(G, 'fmtNum') ? G.fmtNum(n) : String(n); }
  function _title(s) { return _has(G, 'titleCase') ? G.titleCase(s) : _str(s); }
  function _hex(c) { if (typeof c === 'number') return _has(G, 'hexStr') ? G.hexStr(c) : '#' + ('000000' + (c >>> 0).toString(16)).slice(-6); return _str(c) || '#ffffff'; }
  function _clear(node) { if (node) while (node.firstChild) node.removeChild(node.firstChild); }
  function _vw() { return window.innerWidth || document.documentElement.clientWidth || 1280; }
  function _vh() { return window.innerHeight || document.documentElement.clientHeight || 720; }
  function _isOpen(id) { return _has(UI, 'isOpen') && UI.isOpen(id); }
  function _open(id, arg) { if (_has(UI, 'openPanel')) return UI.openPanel(id, arg); return false; }
  function _close(id) { if (_has(UI, 'closePanel')) return UI.closePanel(id); return false; }
  function _confirm(text, onYes, opts) {
    if (_has(UI, 'confirm')) UI.confirm(text, onYes, null, opts);
    else if (typeof onYes === 'function') onYes();
  }
  function _tip(node, htmlOrFn, opts) { if (_has(UI, 'bindTooltip')) UI.bindTooltip(node, htmlOrFn, opts); return node; }
  function _tipHide() { if (UI.tooltip && _has(UI.tooltip, 'hide')) UI.tooltip.hide(); }
  function _fmtSecs(s) { s = Math.max(0, _num(s)); if (s >= 3600) return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm'; if (s >= 60) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's'; return Math.round(s) + 's'; }
  function _playTime(sec) { sec = Math.max(0, _num(sec)); const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h ? h + 'h ' + m + 'm' : m + 'm ' + Math.floor(sec % 60) + 's'; }
  function _dtHas(e, type) { const t = e && e.dataTransfer && e.dataTransfer.types; if (!t) return false; if (typeof t.indexOf === 'function') return t.indexOf(type) >= 0; if (typeof t.contains === 'function') return t.contains(type); return false; }
  function _dtGet(e, type) { try { return e.dataTransfer.getData(type) || ''; } catch (_) { return ''; } }
  function _dtSet(e, type, v) { try { e.dataTransfer.setData(type, String(v)); } catch (_) { /* ignore */ } }
  function _btn(label, onClick, cls) { return el('button', { class: 'btn' + (cls ? ' ' + cls : ''), text: label, onclick: function (ev) { ev.stopPropagation(); if (typeof onClick === 'function') onClick(ev); } }); }
  function _chip(text, cls) { return el('span', { class: 'chip' + (cls ? ' ' + cls : ''), text: text }); }
  function _bar(frac, cls, text) {
    const fill = el('div', { class: 'fill ' + (cls || 'green'), style: { width: Math.round(clamp(_num(frac), 0, 1) * 100) + '%' } });
    return el('div', { class: 'bar' }, [fill, text != null ? el('div', { class: 'text', text: text }) : null]);
  }

  // ---- data lookups (all defensive)
  function _world() { return (G.Data && G.Data.world) || null; }
  function _zone(id) { const w = _world(); if (!w || !id) return null; if (w.zoneById && w.zoneById[id]) return w.zoneById[id]; if (Array.isArray(w.zones)) for (let i = 0; i < w.zones.length; i++) if (w.zones[i].id === id) return w.zones[i]; return null; }
  function _zoneName(id) { const z = _zone(id); return z ? z.name : (id ? _title(id) : 'Middle-earth'); }
  function _town(id) { const w = _world(); if (!w || !id) return null; if (w.townById && w.townById[id]) return w.townById[id]; if (Array.isArray(w.towns)) for (let i = 0; i < w.towns.length; i++) if (w.towns[i].id === id) return w.towns[i]; return null; }
  function _npcRec(id) { const w = _world(); if (!w || !id) return null; if (w.npcById && w.npcById[id]) return w.npcById[id]; if (Array.isArray(w.npcs)) for (let i = 0; i < w.npcs.length; i++) if (w.npcs[i].id === id) return w.npcs[i]; return null; }
  function _npcName(id) { if (!id) return ''; const r = _npcRec(id); if (r && r.name) return r.name; if (_has(G.NPCs, 'get')) { const n = G.NPCs.get(id); if (n && n.name) return n.name; } return _title(id); }
  function _dock(id) { const w = _world(); if (!w || !id) return null; if (w.dockById && w.dockById[id]) return w.dockById[id]; if (Array.isArray(w.docks)) for (let i = 0; i < w.docks.length; i++) if (w.docks[i].id === id) return w.docks[i]; return null; }
  function _questId(q) { return typeof q === 'string' ? q : (q && q.id) || ''; }
  function _questData(idOrObj) {
    if (!idOrObj) return null;
    if (typeof idOrObj === 'object' && Array.isArray(idOrObj.objectives)) return idOrObj;
    const id = _questId(idOrObj);
    if (G.Data && G.Data.questById && G.Data.questById[id]) return G.Data.questById[id];
    if (G.Data && Array.isArray(G.Data.quests)) for (let i = 0; i < G.Data.quests.length; i++) if (G.Data.quests[i].id === id) return G.Data.quests[i];
    return null;
  }
  function _allQuests() {
    if (G.Data && Array.isArray(G.Data.quests) && G.Data.quests.length) return G.Data.quests;
    if (G.Data && G.Data.questById) { const out = []; for (const k in G.Data.questById) out.push(G.Data.questById[k]); return out; }
    return [];
  }
  function _qstate(id) { const Q = G.Quests; if (!Q || !Q.state || !id) return null; return Q.state[id] || null; }
  function _qstatus(id) { const s = _qstate(id); if (s && s.status) return s.status; if (_has(G.Quests, 'isDone') && G.Quests.isDone(id)) return 'done'; return 'available'; }
  function _qdone(id) { const st = _qstatus(id); return st === 'done'; }
  function _cls(id) { return (id && G.Data && G.Data.classById && G.Data.classById[id]) || null; }
  function _race(id) { return (id && G.Data && G.Data.raceById && G.Data.raceById[id]) || null; }
  function _abil(id) { if (!id) return null; if (typeof id === 'object') return id; if (_has(G.Data, 'abilityById')) return G.Data.abilityById(id); return (G.Data && G.Data.abilities && G.Data.abilities[id]) || null; }
  function _statName(k) { const S = G.Data && G.Data.stats && G.Data.stats.STAT_NAMES; return (S && S[k]) || (G.Items && G.Items.STAT_NAMES && G.Items.STAT_NAMES[k]) || _title(k); }
  function _statDesc(k) { return (G.Data && G.Data.stats && _has(G.Data.stats, 'describe')) ? G.Data.stats.describe(k) : ''; }
  function _view(inst) { if (!inst) return null; if (_has(G.Items, 'get')) { try { return G.Items.get(inst); } catch (_) { return null; } } return (G.Data && G.Data.items && G.Data.items[inst.tid]) || null; }
  function _iconHTML(inst, size) {
    if (!inst) return '<div class="icon"></div>';
    if (_has(G.Items, 'iconHTML')) { try { return G.Items.iconHTML(inst, size); } catch (_) { /* fall through */ } }
    const v = _view(inst); return '<div class="icon">' + esc((v && v.icon) || '▪') + '</div>';
  }
  function _rarityOf(inst) { if (_has(G.Items, 'rarityOf')) { try { return G.Items.rarityOf(inst) || 'common'; } catch (_) { return 'common'; } } const v = _view(inst); return (v && v.rarity) || 'common'; }
  function _itemName(inst) { const v = _view(inst); return (v && v.name) || (inst && inst.name) || _title((inst && inst.tid) || 'item'); }
  function _itemTip(inst, player) { if (_has(G.Items, 'tooltipHTML')) { try { return G.Items.tooltipHTML(inst, player); } catch (err) { _report(err, 'item tooltip'); } } return '<div class="tt-name">' + esc(_itemName(inst)) + '</div>'; }
  function _slotLabel(slot) { return _has(G.Items, 'slotLabel') ? G.Items.slotLabel(slot) : _title(slot); }
  function _xpInfo(p) {
    const L = Math.max(1, _num(p && p.level, 1) | 0), cap = C.LEVEL_CAP || 80, xp = G.Data && G.Data.xp;
    if (L >= cap) return { level: L, cur: 1, need: 1, frac: 1, capped: true, toNext: 0 };
    if (xp && _has(xp, 'forLevel')) { const base = _num(xp.forLevel(L)), need = Math.max(1, _num(xp.forLevel(L + 1)) - base), cur = clamp(_num(p.xp) - base, 0, need); return { level: L, cur: cur, need: need, frac: cur / need, capped: false, toNext: need - cur }; }
    return { level: L, cur: 0, need: 1, frac: 0, capped: false, toNext: 1 };
  }
  function _setWaypoint(x, z, label) {
    if (!isFinite(x) || !isFinite(z)) return null;
    let wp = null;
    if (_has(UI, 'setWaypoint')) wp = UI.setWaypoint(x, z, label);
    if (!wp) wp = { x: +x, z: +z, label: _str(label) || 'Waypoint' };
    if (G.state) G.state.waypoint = { x: wp.x, z: wp.z, label: wp.label };
    return wp;
  }
  function _clearWaypoint() { if (_has(UI, 'clearWaypoint')) UI.clearWaypoint(); if (G.state) G.state.waypoint = null; }
  function _waypoint() { return (UI.waypoint && typeof UI.waypoint.x === 'number') ? UI.waypoint : (G.state && G.state.waypoint && typeof G.state.waypoint.x === 'number' ? G.state.waypoint : null); }
  function _adminMode() { return !!(G.state && (G.state.adminMode || G.state.admin)); }

  // ================================================================================================ panel base
  const _dirty = new Set();
  let _flushQueued = false;
  function _flush() {
    _flushQueued = false;
    if (!_dirty.size) return;
    const list = Array.from(_dirty); _dirty.clear();
    for (let i = 0; i < list.length; i++) { const api = list[i]; if (api.isOpen()) { try { api.render(); } catch (err) { _report(err, 'panel render ' + api.id); } } }
  }
  function _queueFlush() {
    if (_flushQueued) return;
    _flushQueued = true;
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(_flush); else setTimeout(_flush, 0);
  }
  const _apis = [];
  function definePanel(id, api, def) {
    api.id = id; api.body = null; api.panel = null; api._justBuilt = false;
    api.isOpen = function () { return _isOpen(id); };
    api.close = function () { return _close(id); };
    api.refresh = function () { if (api.isOpen()) { try { api.render(); } catch (err) { _report(err, 'panel render ' + id); } } };
    api.mark = function () { if (api.isOpen()) { _dirty.add(api); _queueFlush(); } };
    if (typeof api.open !== 'function') api.open = function (arg) { return _open(id, arg); };
    const reg = Object.assign({}, def);
    reg.build = function (body, p) {
      api.body = body; api.panel = p;
      if (p && p.el) p.el.classList.add('pn', 'pn-' + id);
      api._justBuilt = true;
      api.render();
    };
    reg.onOpen = function (p, arg) {
      if (!api._justBuilt) api.render();
      api._justBuilt = false;
      if (typeof api.onOpen === 'function') api.onOpen(arg, p);
    };
    reg.onClose = function (p) { _dirty.delete(api); _menuClose(); if (typeof api.onClose === 'function') api.onClose(p); };
    api._def = reg;
    _apis.push(api);
    return api;
  }
  function _registerAll() {
    if (!_has(UI, 'registerPanel')) return false;
    for (let i = 0; i < _apis.length; i++) { const a = _apis[i]; if (!a.panel && !_registered[a.id]) { _registered[a.id] = true; UI.registerPanel(a.id, a._def); a.panel = _has(UI, 'getPanel') ? UI.getPanel(a.id) : null; } }
    return true;
  }
  const _registered = {};

  // ================================================================================================ CSS
  const CSS = `
/* ---- shared ---- */
.pn .panel-body { display: flex; flex-direction: column; overflow: hidden; }
.pn .scroll { overflow-y: auto; overflow-x: hidden; min-height: 0; }
.pn-row { display: flex; align-items: center; gap: 8px; }
.pn-grow { flex: 1; min-width: 0; }
.pn-muted { color: var(--parch-dim); }
.pn-gold { color: var(--gold-bright); }
.pn-head-name { font-family: var(--font-head); font-size: 20px; color: var(--gold-bright); letter-spacing: .05em; text-shadow: 0 1px 2px #000; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pn-sub { font-size: 13px; color: var(--parch-dim); }
.pn-empty { padding: 18px 10px; text-align: center; color: var(--parch-dim); font-style: italic; }
.pn select, .pn input[type=text], .pn input[type=number] { font-size: 13px; padding: 3px 6px; }
.pn select { cursor: pointer; }
.pn .tabs { padding: 0 4px; margin-bottom: 6px; }
.pn .tab { padding: 5px 10px; }
.pn .slot .icon { pointer-events: none; }
.pn .slot.dragover { border-color: var(--gold-bright) !important; box-shadow: 0 0 12px rgba(255,224,138,.7), inset 0 0 10px rgba(255,224,138,.3); }
.pn .slot.dragging { opacity: .35; }
.pn .slot .empty-label { font-size: 9px; letter-spacing: .06em; text-transform: uppercase; color: rgba(184,173,148,.55); text-align: center; line-height: 1.1; padding: 0 2px; pointer-events: none; }
.pn .slot.hl { animation: slotHl 1.1s ease-in-out 2; }
@keyframes slotHl { 0%, 100% { box-shadow: inset 0 0 8px rgba(0,0,0,.8); } 50% { box-shadow: 0 0 14px rgba(255,224,138,.9), inset 0 0 10px rgba(255,224,138,.5); border-color: var(--gold-bright); } }
.pn-kv { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; font-size: 13px; }
.pn-kv .k { color: var(--parch); cursor: help; }
.pn-kv .v { color: var(--gold-bright); font-family: var(--font-ui); text-align: right; white-space: nowrap; }
.pn-kv .v .pct { color: var(--parch-dim); font-size: 12px; margin-left: 4px; }
.pn-fade, #overlays > .pn-fade { position: absolute; inset: 0; background: #000; opacity: 0; pointer-events: none !important; transition: opacity .35s ease; z-index: 90; }
.pn-fade.on, #overlays > .pn-fade.on { opacity: 1; pointer-events: auto !important; }
.pn-fade.instant { transition: none; }
/* ---- context menu ---- */
.ctx-menu { position: fixed; z-index: 1200; min-width: 160px; background: rgba(12,9,5,.97); border: 1px solid var(--border-hi); border-radius: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.8); padding: 4px; font-size: 13px; animation: fadeIn .12s ease-out; }
.ctx-menu .ctx-item { display: flex; align-items: center; gap: 8px; padding: 5px 10px; cursor: pointer; border-radius: 3px; color: var(--parch); white-space: nowrap; }
.ctx-menu .ctx-item:hover { background: rgba(212,175,90,.18); color: #fff; }
.ctx-menu .ctx-item.disabled { opacity: .4; cursor: not-allowed; pointer-events: none; }
.ctx-menu .ctx-item.danger { color: #ff8a7a; }
.ctx-menu .ctx-ico { width: 16px; text-align: center; color: var(--gold); }
.ctx-menu .ctx-sep { height: 1px; background: var(--border); margin: 3px 6px; }
.ctx-menu .ctx-title { font-family: var(--font-head); font-size: 11px; letter-spacing: .08em; color: var(--gold); padding: 3px 10px 4px; border-bottom: 1px solid var(--border); margin-bottom: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 240px; }
/* ---- inventory ---- */
.pn-inventory .panel-body { padding: 8px 10px 6px; }
.inv-top { display: flex; align-items: flex-end; gap: 6px; margin-bottom: 6px; }
.inv-top .tabs { flex: 1; margin: 0; border-bottom: 1px solid var(--border); }
.inv-top .tab { padding: 4px 6px; font-size: 10.5px; letter-spacing: .03em; }
.inv-top .btn { margin-bottom: 3px; }
.inv-grid-wrap { overflow-y: auto; overflow-x: hidden; min-height: 0; max-height: calc(92vh - 190px); padding: 2px 4px 2px 2px; }
.inv-grid { display: grid; grid-template-columns: repeat(10, 44px); gap: 4px; }
.inv-slot { width: 44px; height: 44px; }
.inv-slot .icon { width: 38px; height: 38px; font-size: 23px; }
.inv-slot.empty { opacity: .55; background: rgba(0,0,0,.35); }
.inv-slot.empty:hover { opacity: .9; }
.inv-slot.dim { opacity: .18; pointer-events: none; }
.inv-slot .count { font-weight: 600; }
.inv-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); font-size: 13px; }
.inv-foot .inv-bags { color: var(--parch-dim); } .inv-foot .inv-bags b { color: var(--parch); font-weight: 600; }
.inv-foot .inv-bags.full b { color: #ff8a7a; }
.inv-foot .money { font-size: 14px; font-family: var(--font-ui); }
.inv-hint { font-size: 11px; color: rgba(184,173,148,.6); font-style: italic; }
/* ---- character ---- */
.pn-character .panel-body { padding: 8px 12px 6px; gap: 6px; }
.ch-head { display: flex; align-items: center; gap: 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.ch-portrait { width: 46px; height: 46px; flex: 0 0 46px; border-radius: 50%; border: 2px solid var(--gold-dim); display: flex; align-items: center; justify-content: center; font-size: 24px; background: radial-gradient(circle at 50% 35%, #3a2b14, #0b0906 75%); box-shadow: 0 0 10px rgba(0,0,0,.7), inset 0 0 10px rgba(0,0,0,.8); }
.ch-headmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ch-nameline { display: flex; align-items: baseline; gap: 10px; }
.ch-nameline select { max-width: 200px; font-family: var(--font-body); font-style: italic; }
.ch-sub { font-size: 13px; color: var(--parch-dim); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ch-sub b { color: var(--parch); font-weight: 600; }
.ch-xp { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--parch-dim); }
.ch-xp .bar { flex: 1; height: 9px; }
.ch-main { display: flex; gap: 12px; flex: 1; min-height: 0; }
.ch-doll { display: flex; gap: 8px; align-items: flex-start; flex: 0 0 auto; }
.ch-col { display: flex; flex-direction: column; justify-content: space-between; height: 380px; }
.ch-slot { width: 44px; height: 44px; }
.ch-slot .icon { width: 38px; height: 38px; font-size: 23px; }
.ch-slot.empty { background: rgba(0,0,0,.4); border-color: rgba(111,83,34,.7); }
.ch-center { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.ch-preview { position: relative; width: 260px; height: 380px; border: 1px solid var(--border); border-radius: 6px; background: radial-gradient(ellipse at 50% 30%, rgba(90,70,35,.55), rgba(8,6,3,.85) 70%), linear-gradient(180deg, #1a140a, #07050300); box-shadow: inset 0 0 30px rgba(0,0,0,.8); overflow: hidden; cursor: grab; }
.ch-preview:active { cursor: grabbing; }
.ch-preview canvas { display: block; width: 260px; height: 380px; }
.ch-preview .ch-floor { position: absolute; left: 30px; right: 30px; bottom: 26px; height: 22px; border-radius: 50%; background: radial-gradient(ellipse at center, rgba(0,0,0,.55), rgba(0,0,0,0) 70%); pointer-events: none; }
.ch-preview .ch-fallback { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 120px; opacity: .6; text-shadow: 0 4px 12px #000; }
.ch-preview .ch-hint { position: absolute; left: 0; right: 0; bottom: 4px; text-align: center; font-size: 10px; color: rgba(184,173,148,.5); letter-spacing: .06em; pointer-events: none; }
.ch-weapons { display: flex; gap: 14px; padding-bottom: 2px; }
.ch-weapons .ch-slot { position: relative; }
.ch-side { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.ch-side .tabs { margin-bottom: 4px; }
.ch-side-body { overflow-y: auto; min-height: 0; flex: 1; padding-right: 4px; }
.ch-side .section-title { margin: 6px 0 4px; }
.ch-side .section-title:first-child { margin-top: 0; }
.ch-set { padding: 5px 8px; margin-bottom: 5px; border: 1px solid var(--border); border-radius: 4px; background: rgba(0,0,0,.25); }
.ch-set-name { font-family: var(--font-head); font-size: 13px; color: var(--gold-bright); display: flex; justify-content: space-between; }
.ch-set-name .cnt { color: var(--parch-dim); font-family: var(--font-ui); }
.ch-set-bonus { font-size: 12px; color: var(--parch-dim); padding-left: 6px; }
.ch-set-bonus.on { color: #a6e39f; }
.ch-set-bonus .th { display: inline-block; width: 26px; color: var(--gold); }
.ch-set-piece { font-size: 12px; padding-left: 6px; color: rgba(184,173,148,.6); }
.ch-set-piece.on { color: var(--parch); }
.ch-title-row { display: flex; align-items: center; gap: 8px; padding: 4px 6px; border-radius: 3px; cursor: pointer; font-size: 13px; }
.ch-title-row:hover { background: rgba(212,175,90,.1); }
.ch-title-row.active { color: var(--gold-bright); background: rgba(212,175,90,.16); }
.ch-title-row.locked { opacity: .45; cursor: default; }
.ch-title-row .ch-title-desc { color: var(--parch-dim); font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ch-foot { display: flex; justify-content: space-around; gap: 8px; padding-top: 6px; border-top: 1px solid var(--border); font-size: 12px; color: var(--parch-dim); }
.ch-foot span b { color: var(--gold-bright); font-weight: 600; font-family: var(--font-ui); }
/* ---- abilities ---- */
.pn-abilities .panel-body { padding: 8px 10px; }
.ab-list { overflow-y: auto; min-height: 0; flex: 1; padding-right: 4px; }
.ab-row { display: grid; grid-template-columns: 44px 1fr auto; gap: 4px 10px; align-items: center; padding: 6px 8px; margin-bottom: 4px; border: 1px solid var(--border); border-radius: 4px; background: rgba(255,255,255,.02); cursor: grab; }
.ab-row:hover { border-color: var(--border-hi); background: rgba(212,175,90,.07); }
.ab-row.locked { opacity: .6; cursor: default; }
.ab-row.trained { border-color: rgba(95,191,90,.45); }
.ab-row.selected { border-color: var(--gold-bright); box-shadow: 0 0 8px rgba(255,224,138,.35); }
.ab-row .ab-ico { width: 44px; height: 44px; border-radius: 6px; border: 1px solid var(--border-hi); background: radial-gradient(circle at 40% 30%, #4a3a1a, #120d06); display: flex; align-items: center; justify-content: center; font-size: 26px; text-shadow: 0 1px 2px #000; grid-row: span 2; }
.ab-row.locked .ab-ico { filter: grayscale(.8) brightness(.6); }
.ab-name { font-family: var(--font-head); font-size: 14px; color: var(--gold-bright); display: flex; align-items: center; gap: 8px; }
.ab-name .chip { font-family: var(--font-ui); font-size: 10px; }
.ab-desc { font-size: 12px; color: var(--parch-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ab-meta { font-size: 12px; color: var(--parch-dim); white-space: nowrap; display: flex; gap: 8px; align-items: center; }
.ab-act { display: flex; align-items: center; gap: 6px; justify-content: flex-end; }
.ab-act .btn { min-width: 96px; }
.ab-act select { width: 96px; }
.ab-status { font-size: 12px; white-space: nowrap; min-width: 96px; text-align: center; padding: 4px 6px; border: 1px solid transparent; }
.ab-status.trained { color: #7fd47a; border-color: rgba(95,191,90,.4); border-radius: 4px; }
.ab-status.locked { color: #ff9a6a; }
.ab-traits { margin-top: 6px; }
.ab-trait { display: flex; gap: 10px; align-items: flex-start; padding: 5px 8px; border: 1px solid var(--border); border-radius: 4px; margin-bottom: 4px; background: rgba(0,0,0,.25); }
.ab-trait.locked { opacity: .5; }
.ab-trait .ab-trait-lvl { flex: 0 0 44px; text-align: center; font-family: var(--font-head); font-size: 11px; color: var(--gold); border: 1px solid var(--gold-dim); border-radius: 4px; padding: 3px 0; }
.ab-trait-name { font-family: var(--font-head); font-size: 13px; color: var(--gold-bright); }
.ab-trait-bonus { font-size: 12px; color: #a6e39f; }
.ab-trait-desc { font-size: 12px; color: var(--parch-dim); font-style: italic; }
.ab-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; font-size: 13px; }
/* ---- journal ---- */
.pn-journal .panel-body { padding: 8px 10px 6px; }
.jn-cols { display: flex; gap: 10px; flex: 1; min-height: 0; }
.jn-left { flex: 0 0 300px; display: flex; flex-direction: column; min-height: 0; }
.jn-list { overflow-y: auto; min-height: 0; flex: 1; padding-right: 3px; }
.jn-group { font-family: var(--font-head); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--gold); padding: 6px 4px 3px; border-bottom: 1px solid var(--border); margin: 4px 0 3px; }
.jn-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border: 1px solid transparent; border-radius: 3px; cursor: pointer; }
.jn-row:hover { background: rgba(212,175,90,.1); border-color: var(--border); }
.jn-row.selected { background: rgba(212,175,90,.18); border-color: var(--gold); }
.jn-row .jn-ch { flex: 0 0 22px; font-family: var(--font-head); font-size: 11px; color: var(--parch-dim); text-align: right; }
.jn-row .jn-nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; color: var(--parch); }
.jn-row.tracked .jn-nm { color: #fff3c4; }
.jn-row.ready .jn-nm { color: #a6e39f; }
.jn-row .jn-lv { font-size: 11px; color: var(--parch-dim); font-family: var(--font-ui); }
.jn-row .jn-star { color: var(--gold-bright); font-size: 12px; }
.jn-row .jn-giver { font-size: 11px; color: rgba(184,173,148,.7); }
.jn-detail { flex: 1; min-width: 0; overflow-y: auto; padding: 4px 8px 4px 4px; }
.jn-qname { font-family: var(--font-head); font-size: 19px; color: var(--gold-bright); text-shadow: 0 1px 2px #000; }
.jn-chips { display: flex; gap: 4px; flex-wrap: wrap; margin: 4px 0 6px; }
.jn-text { font-size: 14px; line-height: 1.45; color: var(--parch); background: rgba(232,220,192,.06); border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; margin: 6px 0; font-style: italic; }
.jn-obj { display: flex; flex-direction: column; gap: 3px; margin: 4px 0; }
.jn-obj-row { display: grid; grid-template-columns: 1fr 100px; gap: 8px; align-items: center; font-size: 13px; }
.jn-obj-row.done { color: #7fd47a; }
.jn-obj-row.done .jn-obj-lbl::before { content: '✓ '; }
.jn-obj-row .bar { height: 10px; }
.jn-obj-row .bar .text { font-size: 9px; }
.jn-rewards { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 4px 0; }
.jn-reward { display: flex; align-items: center; gap: 6px; padding: 3px 8px 3px 4px; border: 1px solid var(--border); border-radius: 4px; background: rgba(0,0,0,.35); font-size: 13px; }
.jn-reward .icon { width: 28px; height: 28px; font-size: 17px; }
.jn-reward.choice { border-color: var(--gold-dim); }
.jn-actions { display: flex; gap: 8px; margin-top: 8px; }
.jn-bottom { display: flex; align-items: center; gap: 10px; padding-top: 6px; margin-top: 6px; border-top: 1px solid var(--border); font-size: 12px; }
.jn-bottom .bar { flex: 1; height: 14px; }
.jn-bottom .jn-comp { white-space: nowrap; color: var(--parch-dim); }
.jn-bottom .jn-comp b { color: var(--gold-bright); font-weight: 600; }
/* ---- map ---- */
.pn-map { min-width: 480px; }
.pn-map .panel-body { padding: 0; position: relative; background: #0d1a26; }
.map-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; cursor: grab; }
.map-canvas.panning { cursor: grabbing; }
.map-canvas.wp { cursor: crosshair; }
.map-tools { position: absolute; left: 10px; top: 10px; display: flex; flex-direction: column; gap: 4px; z-index: 2; }
.map-tools .btn { justify-content: flex-start; font-size: 12px; padding: 4px 10px; background: rgba(20,15,9,.85); }
.map-tools .btn.on { border-color: var(--gold-bright); color: var(--gold-bright); }
.map-zoom { position: absolute; right: 12px; top: 10px; display: flex; flex-direction: column; gap: 3px; z-index: 2; }
.map-zoom .btn { width: 30px; height: 30px; padding: 0; font-size: 18px; background: rgba(20,15,9,.85); }
.map-coords { position: absolute; left: 10px; bottom: 8px; padding: 4px 9px; font-family: var(--font-ui); font-size: 12px; color: var(--parch); background: rgba(8,6,3,.75); border: 1px solid var(--border); border-radius: 4px; z-index: 2; pointer-events: none; white-space: nowrap; }
.map-coords b { color: var(--gold-bright); font-weight: 600; }
.map-legend { position: absolute; right: 12px; bottom: 8px; padding: 6px 10px; background: rgba(8,6,3,.82); border: 1px solid var(--border); border-radius: 4px; z-index: 2; font-size: 12px; display: grid; grid-template-columns: auto auto; gap: 2px 14px; pointer-events: none; }
.map-legend .lg { display: flex; align-items: center; gap: 6px; color: var(--parch-dim); white-space: nowrap; }
.map-legend .lg i { display: inline-block; width: 12px; height: 12px; font-style: normal; text-align: center; line-height: 12px; font-size: 11px; }
.map-legend .lg-title { grid-column: span 2; font-family: var(--font-head); font-size: 10px; letter-spacing: .1em; color: var(--gold); text-transform: uppercase; border-bottom: 1px solid var(--border); padding-bottom: 2px; margin-bottom: 2px; }
.map-title-zone { position: absolute; left: 50%; top: 8px; transform: translateX(-50%); font-family: var(--font-head); font-size: 14px; letter-spacing: .12em; color: var(--gold-bright); text-shadow: 0 2px 6px #000; pointer-events: none; z-index: 2; white-space: nowrap; }
/* ---- players ---- */
.pn-players .panel-body { padding: 8px 10px 6px; }
.pl-top { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.pl-top input { width: 220px; }
.pl-top .pl-count { font-size: 12px; color: var(--parch-dim); }
.pl-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: #8fd48a; font-family: var(--font-head); letter-spacing: .1em; }
.pl-live i { width: 7px; height: 7px; border-radius: 50%; background: #5fbf5a; box-shadow: 0 0 6px #5fbf5a; animation: pulse 1.4s ease-in-out infinite; }
.pl-cols { display: flex; gap: 10px; flex: 1; min-height: 0; }
.pl-tablewrap { flex: 1; min-width: 0; overflow-y: auto; min-height: 0; border: 1px solid var(--border); border-radius: 4px; background: rgba(0,0,0,.25); }
.pl-table { border-collapse: collapse; width: 100%; font-size: 13px; }
.pl-table th { position: sticky; top: 0; z-index: 1; background: #1c150c; text-align: left; color: var(--gold); font-family: var(--font-head); font-size: 11px; letter-spacing: .08em; border-bottom: 1px solid var(--border); padding: 5px 8px; cursor: pointer; white-space: nowrap; user-select: none; }
.pl-table th:hover { color: var(--gold-bright); }
.pl-table th.sorted { color: var(--gold-bright); }
.pl-table th .arr { font-size: 9px; margin-left: 3px; color: var(--parch-dim); }
.pl-table td { padding: 3px 8px; border-bottom: 1px solid rgba(255,255,255,.05); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
.pl-table tr { cursor: pointer; }
.pl-table tr:hover td { background: rgba(212,175,90,.08); }
.pl-table tr.selected td { background: rgba(212,175,90,.18); }
.pl-table tr.me td { color: #fff3c4; }
.pl-table td.lv { text-align: right; font-family: var(--font-ui); color: var(--gold-bright); }
.pl-table td.st { color: var(--parch-dim); font-size: 12px; }
.pl-detail { flex: 0 0 330px; overflow-y: auto; min-height: 0; border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; background: rgba(0,0,0,.25); }
.pl-dhead { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.pl-glyph { width: 46px; height: 46px; flex: 0 0 46px; border-radius: 50%; border: 2px solid var(--gold-dim); display: flex; align-items: center; justify-content: center; font-size: 24px; background: radial-gradient(circle at 50% 35%, #3a2b14, #0b0906 75%); }
.pl-dname { font-family: var(--font-head); font-size: 17px; color: var(--gold-bright); }
.pl-dsub { font-size: 12px; color: var(--parch-dim); }
.pl-grid { display: grid; grid-template-columns: repeat(6, 44px); gap: 4px; justify-content: center; margin: 4px 0; }
.pl-grid .slot { width: 44px; height: 44px; }
.pl-grid .slot .icon { width: 38px; height: 38px; font-size: 23px; }
.pl-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.pl-actions .btn { flex: 1; }
.pl-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 10px; font-size: 12px; }
.pl-stats span { display: flex; justify-content: space-between; }
.pl-stats span b { color: var(--gold-bright); font-weight: 600; font-family: var(--font-ui); }
.pl-fellow { display: flex; flex-wrap: wrap; gap: 4px; }
/* ---- dialogue ---- */
.pn-dialogue .panel-body { padding: 10px 14px 8px; gap: 8px; }
.dg-head { display: flex; align-items: center; gap: 12px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.dg-portrait { width: 52px; height: 52px; flex: 0 0 52px; border-radius: 50%; border: 2px solid var(--gold-dim); display: flex; align-items: center; justify-content: center; font-size: 28px; background: radial-gradient(circle at 50% 35%, #3a2b14, #0b0906 75%); box-shadow: 0 0 10px rgba(0,0,0,.7); }
.dg-name { font-family: var(--font-head); font-size: 20px; color: var(--gold-bright); text-shadow: 0 1px 2px #000; }
.dg-title { font-size: 13px; color: var(--parch-dim); font-style: italic; }
.dg-text { font-family: var(--font-body); font-size: 16px; line-height: 1.5; color: #f0e6cc; background: linear-gradient(180deg, rgba(232,220,192,.09), rgba(232,220,192,.04)); border: 1px solid var(--border); border-radius: 4px; padding: 12px 14px; min-height: 70px; box-shadow: inset 0 0 20px rgba(0,0,0,.4); }
.dg-options { display: flex; flex-direction: column; gap: 4px; max-height: 300px; overflow-y: auto; }
.dg-opt { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 4px; background: rgba(255,255,255,.03); cursor: pointer; font-size: 14px; color: var(--parch); }
.dg-opt:hover { border-color: var(--border-hi); background: rgba(212,175,90,.12); color: #fff; }
.dg-opt .dg-ico { width: 24px; text-align: center; font-size: 16px; flex: 0 0 24px; }
.dg-opt .dg-ico.q { font-family: var(--font-head); font-weight: 700; font-size: 20px; color: var(--gold-bright); text-shadow: 0 0 8px rgba(255,224,138,.6); }
.dg-opt .dg-ico.q.grey { color: #b8b8b8; text-shadow: none; }
.dg-opt .dg-lbl { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dg-opt .dg-meta { font-size: 11px; color: var(--parch-dim); white-space: nowrap; }
.dg-opt.quest .dg-lbl { font-family: var(--font-head); font-size: 13px; color: var(--gold-bright); }
.dg-foot { display: flex; justify-content: flex-end; gap: 8px; padding-top: 6px; border-top: 1px solid var(--border); }
.dg-quest { display: flex; flex-direction: column; gap: 6px; max-height: calc(92vh - 200px); overflow-y: auto; padding-right: 4px; }
.dg-choose { display: flex; flex-wrap: wrap; gap: 6px; }
.dg-choice { display: flex; align-items: center; gap: 6px; padding: 4px 8px 4px 4px; border: 1px solid var(--border); border-radius: 4px; background: rgba(0,0,0,.35); cursor: pointer; font-size: 13px; }
.dg-choice:hover { border-color: var(--border-hi); }
.dg-choice.on { border-color: var(--gold-bright); box-shadow: 0 0 8px rgba(255,224,138,.4); background: rgba(212,175,90,.15); }
.dg-choice .icon { width: 30px; height: 30px; font-size: 18px; }
/* ---- vendor ---- */
.pn-vendor .panel-body { padding: 8px 10px 6px; }
.vd-top { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
.vd-top .vd-npc { font-family: var(--font-head); font-size: 15px; color: var(--gold-bright); }
.vd-top .vd-kind { font-size: 12px; color: var(--parch-dim); }
.vd-cols { display: flex; gap: 10px; flex: 1; min-height: 0; }
.vd-buy { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.vd-sell { flex: 0 0 470px; display: flex; flex-direction: column; min-height: 0; }
.vd-list { overflow-y: auto; min-height: 0; flex: 1; border: 1px solid var(--border); border-radius: 4px; background: rgba(0,0,0,.25); padding: 3px; }
.vd-row { display: grid; grid-template-columns: 34px 1fr auto; gap: 8px; align-items: center; padding: 3px 6px; border-radius: 3px; cursor: pointer; border: 1px solid transparent; }
.vd-row:hover { background: rgba(212,175,90,.1); border-color: var(--border); }
.vd-row .icon { width: 30px; height: 30px; font-size: 18px; }
.vd-row .vd-nm { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vd-row .vd-sub { font-size: 11px; color: var(--parch-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vd-row .vd-sub .req { color: #ff8a7a; }
.vd-row .vd-price { font-family: var(--font-ui); font-size: 13px; white-space: nowrap; text-align: right; }
.vd-row.cant .vd-price { color: #ff8a7a; }
.vd-row.cant .vd-price .money { opacity: .7; }
.vd-search { display: flex; gap: 6px; margin-bottom: 5px; align-items: center; }
.vd-search input { flex: 1; }
.vd-search .tabs { margin: 0; border: none; padding: 0; }
.vd-search .tab { padding: 3px 7px; font-size: 10px; }
.vd-gridwrap { overflow-y: auto; min-height: 0; flex: 1; border: 1px solid var(--border); border-radius: 4px; background: rgba(0,0,0,.25); padding: 4px; }
.vd-grid { display: grid; grid-template-columns: repeat(10, 40px); gap: 3px; }
.vd-grid .slot { width: 40px; height: 40px; }
.vd-grid .slot .icon { width: 34px; height: 34px; font-size: 20px; }
.vd-grid .slot.empty { opacity: .4; }
.vd-grid .slot.nosell { opacity: .35; }
.vd-sellfoot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 5px; font-size: 12px; }
.vd-buyback { margin-top: 5px; }
.vd-buyback .section-title { margin: 4px 0 3px; }
.vd-bbrow { display: flex; align-items: center; gap: 6px; font-size: 12px; padding: 2px 4px; cursor: pointer; border-radius: 3px; }
.vd-bbrow:hover { background: rgba(212,175,90,.1); }
.vd-bbrow .icon { width: 22px; height: 22px; font-size: 13px; }
.vd-bbrow .nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vd-foot { display: flex; justify-content: space-between; align-items: center; margin-top: 6px; padding-top: 6px; border-top: 1px solid var(--border); font-size: 13px; }
.vd-dropzone.dragover { outline: 2px dashed var(--gold-bright); outline-offset: -4px; }
/* ---- travel ---- */
.pn-travel .panel-body { padding: 10px 12px 8px; gap: 6px; }
.tr-intro { font-size: 13px; color: var(--parch-dim); font-style: italic; }
.tr-list { display: flex; flex-direction: column; gap: 4px; max-height: 60vh; overflow-y: auto; }
.tr-row { display: grid; grid-template-columns: 30px 1fr auto; gap: 10px; align-items: center; padding: 7px 10px; border: 1px solid var(--border); border-radius: 4px; background: rgba(255,255,255,.03); cursor: pointer; }
.tr-row:hover { border-color: var(--border-hi); background: rgba(212,175,90,.12); }
.tr-row.locked { opacity: .55; cursor: not-allowed; }
.tr-row .tr-ico { font-size: 20px; text-align: center; }
.tr-row .tr-nm { font-family: var(--font-head); font-size: 14px; color: var(--gold-bright); }
.tr-row .tr-sub { font-size: 12px; color: var(--parch-dim); }
.tr-row .tr-sub .warn { color: #ff9a6a; }
.tr-row .tr-cost { font-family: var(--font-ui); font-size: 13px; text-align: right; white-space: nowrap; }
.tr-row .tr-cost .free { color: #7fd47a; }
.tr-row.cant .tr-cost { color: #ff8a7a; }
.tr-foot { display: flex; justify-content: space-between; align-items: center; font-size: 13px; padding-top: 6px; border-top: 1px solid var(--border); }
/* ---- settings ---- */
.pn-settings .panel-body { padding: 8px 14px 6px; }
.st-body { overflow-y: auto; min-height: 0; flex: 1; padding-right: 4px; }
.st-row { display: grid; grid-template-columns: 150px 1fr 56px; gap: 10px; align-items: center; padding: 4px 0; font-size: 13px; }
.st-row label { color: var(--parch); }
.st-row input[type=range] { width: 100%; }
.st-row .st-val { text-align: right; font-family: var(--font-ui); color: var(--gold-bright); font-size: 12px; }
.st-row select { width: 100%; }
.st-row.chk { grid-template-columns: 150px 1fr; }
.st-row .st-check { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.st-row .st-check input { accent-color: var(--gold); width: 16px; height: 16px; cursor: pointer; }
.st-buttons { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.st-buttons .btn { flex: 1 1 45%; }
.st-credits { margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--border); font-size: 11px; color: rgba(184,173,148,.6); text-align: center; font-style: italic; line-height: 1.4; }
/* ---- choose ---- */
.pn-choose .panel-body { padding: 10px 14px; gap: 8px; }
.cho-text { font-size: 14px; color: var(--parch); font-style: italic; }
.cho-grid { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; max-height: 50vh; overflow-y: auto; }
.cho-card { width: 150px; padding: 8px 6px; border: 1px solid var(--border); border-radius: 6px; background: rgba(0,0,0,.35); display: flex; flex-direction: column; align-items: center; gap: 4px; cursor: pointer; text-align: center; }
.cho-card:hover { border-color: var(--border-hi); background: rgba(212,175,90,.1); }
.cho-card.on { border-color: var(--gold-bright); box-shadow: 0 0 12px rgba(255,224,138,.45); background: rgba(212,175,90,.16); }
.cho-card .icon { width: 56px; height: 56px; font-size: 34px; }
.cho-card .cho-nm { font-family: var(--font-head); font-size: 12px; line-height: 1.2; }
.cho-card .cho-sub { font-size: 11px; color: var(--parch-dim); }
/* ---- split stack ---- */
.sp-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
.sp-row input[type=range] { flex: 1; }
.sp-row input[type=number] { width: 64px; }
`;

  // ================================================================================================ context menu
  let _menuEl = null;
  function _menuClose() { if (_menuEl && _menuEl.parentNode) _menuEl.parentNode.removeChild(_menuEl); _menuEl = null; }
  function _menu(items, x, y, title) {
    _menuClose();
    if (!Array.isArray(items) || !items.length) return null;
    const m = el('div', { class: 'ctx-menu' });
    if (title) m.appendChild(el('div', { class: 'ctx-title', text: title }));
    items.forEach(function (it) {
      if (!it) { m.appendChild(el('div', { class: 'ctx-sep' })); return; }
      const row = el('div', { class: 'ctx-item' + (it.disabled ? ' disabled' : '') + (it.cls ? ' ' + it.cls : '') }, [el('span', { class: 'ctx-ico', text: it.icon || '' }), el('span', { text: it.label })]);
      row.addEventListener('click', function (ev) { ev.stopPropagation(); _menuClose(); _sfx('ui_click'); if (typeof it.onClick === 'function') it.onClick(ev); });
      m.appendChild(row);
    });
    m.addEventListener('contextmenu', function (ev) { ev.preventDefault(); });
    const host = document.getElementById('overlays') || document.getElementById('ui') || document.body;
    host.appendChild(m);
    const w = m.offsetWidth || 160, h = m.offsetHeight || 100;
    m.style.left = Math.round(clamp(_num(x), 4, _vw() - w - 4)) + 'px';
    m.style.top = Math.round(clamp(_num(y), 4, _vh() - h - 4)) + 'px';
    _menuEl = m;
    return m;
  }
  document.addEventListener('mousedown', function (ev) { if (_menuEl && !(ev.target && ev.target.closest && ev.target.closest('.ctx-menu'))) _menuClose(); }, true);
  document.addEventListener('keydown', function (ev) { if (_menuEl && ev.key === 'Escape') { _menuClose(); ev.stopPropagation(); if (G.Input && _has(G.Input, 'consume')) G.Input.consume('Escape'); } }, true);
  window.addEventListener('blur', _menuClose);
  UI.contextMenu = _menu;
  UI.closeContextMenu = _menuClose;

  // ================================================================================================ fade overlay
  let _fadeEl = null, _fadeTimer = 0, _fadeHold = false;
  function _fadeEnsure() {
    if (_fadeEl) return _fadeEl;
    const host = document.getElementById('overlays') || document.getElementById('ui') || document.body;
    _fadeEl = el('div', { class: 'pn-fade' });
    host.appendChild(_fadeEl);
    return _fadeEl;
  }
  // _fade(true|false) holds black / clears; _fade(seconds, _, onBlack) is a dip: out (35 %) → onBlack → in (65 %).
  function _fade(on, dur, onBlack) {
    const f = _fadeEnsure();
    if (_fadeTimer) { clearTimeout(_fadeTimer); _fadeTimer = 0; }
    if (typeof on === 'number') {
      if (_fadeHold) return;                  // a held fade (swift travel) owns the screen until it releases it
      const total = Math.max(0.2, on);
      f.style.transitionDuration = (total * 0.35).toFixed(2) + 's';
      f.classList.add('on');
      _fadeTimer = setTimeout(function () {
        _fadeTimer = 0;
        if (typeof onBlack === 'function') { try { onBlack(); } catch (err) { _report(err, 'fade callback'); } }
        f.style.transitionDuration = (total * 0.65).toFixed(2) + 's';
        f.classList.remove('on');
      }, total * 350);
      return;
    }
    f.style.transitionDuration = (typeof dur === 'number' ? Math.max(0.05, dur) : 0.35).toFixed(2) + 's';
    _fadeHold = !!on;
    if (on) { f.classList.add('on'); if (typeof onBlack === 'function') { _fadeTimer = setTimeout(function () { _fadeTimer = 0; try { onBlack(); } catch (err) { _report(err, 'fade callback'); } }, f.style.transitionDuration.replace('s', '') * 1000); } }
    else f.classList.remove('on');
  }
  if (typeof UI.fade !== 'function') UI.fade = function (on, dur) { _fade(on, dur); };

  // ================================================================================================ drag & drop state
  const DND = { kind: null, from: -1, slot: null, inst: null };
  function _dndReset() { DND.kind = null; DND.from = -1; DND.slot = null; DND.inst = null; document.querySelectorAll('.pn .dragover, .vd-dropzone.dragover').forEach(function (n) { n.classList.remove('dragover'); }); }
  function _dndInv(e) { if (DND.kind === 'inv') return DND.from; const v = _dtGet(e, 'text/inv-slot'); if (v !== '') { const n = parseInt(v, 10); return isFinite(n) ? n : -1; } return -1; }
  function _dndEquip(e) { if (DND.kind === 'equip') return DND.slot; return _dtGet(e, 'text/equip-slot') || null; }
  function _dndActive(e) { return DND.kind === 'inv' || DND.kind === 'equip' || _dtHas(e, 'text/inv-slot') || _dtHas(e, 'text/equip-slot'); }

  // ================================================================================================ INVENTORY (I)
  const INV_FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'weapon', label: 'Weapons', types: ['weapon'] },
    { id: 'armour', label: 'Armour', types: ['armour'] },
    { id: 'jewellery', label: 'Jewellery', types: ['jewellery'] },
    { id: 'consumable', label: 'Consumables', types: ['consumable', 'bait', 'mount'] },
    { id: 'quest', label: 'Quest', types: ['quest'] },
    { id: 'material', label: 'Materials', types: ['material', 'misc'] },
    { id: 'fish', label: 'Fish', types: ['fish'] },
  ];
  const Inv = { filter: 'all', filters: INV_FILTERS, _hl: {}, _hlTimer: 0, _wrap: null, _scroll: 0 };
  function _invFilter(id) { for (let i = 0; i < INV_FILTERS.length; i++) if (INV_FILTERS[i].id === id) return INV_FILTERS[i].types ? INV_FILTERS[i] : null; return null; }
  function _invMatches(f, inst) { if (!f) return true; const v = _view(inst); return !!(v && f.types.indexOf(v.type) >= 0); }
  function _vendorNpc() { return (_isOpen('vendor') && Vd.npc) ? Vd.npc : null; }
  function _invPrimary(i, ev) {
    const p = _player(); if (!p || !Array.isArray(p.inventory)) return;
    const inst = p.inventory[i]; if (!inst) return;
    const v = _view(inst); if (!v) return;
    const vendor = _vendorNpc();
    if (ev && ev.shiftKey && _num(inst.count, 1) > 1) { _splitPrompt(i); return; }
    if (vendor && ev && (ev.ctrlKey || ev.altKey)) { if (_has(G.NPCs, 'sell')) G.NPCs.sell(vendor, i); return; }
    if (v.use && _has(G.Items, 'use')) { G.Items.use(p, i); return; }
    if (v.slot && _has(G.Items, 'equip')) { if (G.Items.equip(p, i)) _sfx('equip'); return; }
  }
  function _invMenu(i, x, y) {
    const p = _player(); if (!p || !Array.isArray(p.inventory)) return;
    const inst = p.inventory[i]; if (!inst) return;
    const v = _view(inst); if (!v) return;
    const items = [];
    if (v.slot && _has(G.Items, 'equip')) {
      const opts = _has(G.Items, 'slotsFor') ? G.Items.slotsFor(p, inst) : [v.slot];
      if (opts.length > 1) opts.forEach(function (s) { items.push({ label: 'Equip — ' + _slotLabel(s) + (p.equipment && p.equipment[s] ? ' (replace)' : ''), icon: '⚔', onClick: function () { if (G.Items.equip(p, i, s)) _sfx('equip'); } }); });
      else items.push({ label: 'Equip', icon: '⚔', onClick: function () { if (G.Items.equip(p, i)) _sfx('equip'); } });
    }
    if (v.use && _has(G.Items, 'use')) items.push({ label: 'Use', icon: '✦', onClick: function () { G.Items.use(p, i); } });
    const vendor = _vendorNpc();
    if (vendor) {
      const val = _has(G.Items, 'sellValue') ? G.Items.sellValue(inst) : 0;
      items.push({ label: 'Sell' + (val > 0 ? ' for ' + _moneyText(val) : ''), icon: '●', disabled: val <= 0, onClick: function () { if (_has(G.NPCs, 'sell')) G.NPCs.sell(vendor, i); } });
    }
    if (_num(inst.count, 1) > 1) items.push({ label: 'Split stack', icon: '⁝', onClick: function () { _splitPrompt(i); } });
    items.push(null);
    items.push({ label: 'Destroy', icon: '✕', cls: 'danger', disabled: v.type === 'quest', onClick: function () {
      _confirm('Destroy ' + _itemName(inst) + (_num(inst.count, 1) > 1 ? ' ×' + inst.count : '') + '? This cannot be undone.', function () { if (_has(G.Items, 'destroy')) G.Items.destroy(p, i); else { p.inventory[i] = null; G.emit('inventoryChanged', p); } _sfx('ui_click'); }, { title: 'Destroy item', yes: 'Destroy' });
    } });
    _menu(items, x, y, _itemName(inst));
  }
  function _splitStack(p, i, n) {
    if (!p || !Array.isArray(p.inventory)) return false;
    const inst = p.inventory[i]; n = n | 0;
    if (!inst || n < 1 || _num(inst.count, 1) <= n) return false;
    let free = -1;
    for (let k = 0; k < p.inventory.length; k++) if (!p.inventory[k]) { free = k; break; }
    if (free < 0) { _notify('Your inventory is full', 'warning'); _sfx('ui_error'); return false; }
    let uid = null;
    if (_has(G.Items, 'create')) { const c = G.Items.create(inst.tid, 1); uid = c && c.uid; }
    if (!uid) uid = _has(G, 'uid') ? G.uid() : 'u' + Math.floor(_now() * 1000);
    const copy = Object.assign({}, inst, { uid: uid, count: n });
    inst.count = _num(inst.count, 1) - n;
    p.inventory[free] = copy;
    G.emit('inventoryChanged', p);
    return true;
  }
  Inv.splitStack = function (i, n) { return _splitStack(_player(), i, n); };
  let _splitState = null;
  function _splitPrompt(i) {
    const p = _player(); if (!p) return;
    const inst = p.inventory[i]; if (!inst || _num(inst.count, 1) < 2) return;
    _splitState = { i: i, max: _num(inst.count, 1) - 1, n: Math.max(1, Math.floor(_num(inst.count, 1) / 2)), name: _itemName(inst) };
    if (!_registered.split && _has(UI, 'registerPanel')) {
      _registered.split = true;
      UI.registerPanel('split', { title: 'Split stack', modal: true, width: 320, remember: false, rebuildOnOpen: true, build: function (body, panel) {
        const s = _splitState; if (!s) return;
        body.appendChild(el('div', { class: 'pn-sub', text: 'How many ' + s.name + ' do you want to move to a new stack?' }));
        const range = el('input', { type: 'range', min: 1, max: s.max, value: s.n });
        const numIn = el('input', { type: 'number', min: 1, max: s.max, value: s.n });
        range.addEventListener('input', function () { s.n = clamp(parseInt(range.value, 10) || 1, 1, s.max); numIn.value = s.n; });
        numIn.addEventListener('input', function () { s.n = clamp(parseInt(numIn.value, 10) || 1, 1, s.max); range.value = s.n; });
        numIn.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Enter') { ev.preventDefault(); _close('split'); _splitStack(_player(), s.i, s.n); } });
        body.appendChild(el('div', { class: 'sp-row' }, [range, numIn]));
        if (panel.footer) _clear(panel.footer);
        panel.addButton('Cancel', function () { _close('split'); });
        panel.addButton('Split', function () { _close('split'); _splitStack(_player(), s.i, s.n); }, 'primary');
      } });
    }
    _open('split');
  }
  function _invSlot(i, inst, p) {
    const s = el('div', { class: 'slot inv-slot' + (inst ? ' border-' + _rarityOf(inst) : ' empty'), data: { i: i }, draggable: !!inst });
    if (inst) {
      s.innerHTML = _iconHTML(inst, 38);
      const cnt = _num(inst.count, 1);
      if (cnt > 1) s.appendChild(el('span', { class: 'count', text: cnt > 9999 ? '9999+' : String(cnt) }));
      if (Inv._hl[inst.tid]) s.classList.add('hl');
      _tip(s, function () {
        const v = _view(inst);
        let hint = v && v.use ? 'Click to use' : (v && v.slot ? 'Click to equip' : '');
        if (_vendorNpc()) hint += (hint ? ' · ' : '') + 'Ctrl-click to sell';
        if (cnt > 1) hint += (hint ? ' · ' : '') + 'Shift-click to split';
        return _itemTip(inst, p) + '<div class="tt-sub" style="margin-top:4px">' + esc(hint ? hint + ' · right-click for options' : 'Right-click for options') + '</div>';
      });
      s.addEventListener('click', function (ev) { _invPrimary(i, ev); });
      s.addEventListener('contextmenu', function (ev) { ev.preventDefault(); ev.stopPropagation(); _tipHide(); _invMenu(i, ev.clientX, ev.clientY); });
      s.addEventListener('dragstart', function (ev) {
        DND.kind = 'inv'; DND.from = i; DND.inst = inst;
        _dtSet(ev, 'text/inv-slot', i); _dtSet(ev, 'text/plain', 'inv:' + i);
        try { ev.dataTransfer.effectAllowed = 'move'; } catch (_) { /* ignore */ }
        s.classList.add('dragging'); _tipHide();
      });
      s.addEventListener('dragend', function () { s.classList.remove('dragging'); _dndReset(); });
    }
    s.addEventListener('dragover', function (ev) { if (_dndActive(ev)) { ev.preventDefault(); try { ev.dataTransfer.dropEffect = 'move'; } catch (_) { /* ignore */ } s.classList.add('dragover'); } });
    s.addEventListener('dragleave', function () { s.classList.remove('dragover'); });
    s.addEventListener('drop', function (ev) {
      ev.preventDefault(); s.classList.remove('dragover');
      const pl = _player(); if (!pl) return;
      const from = _dndInv(ev), eslot = _dndEquip(ev);
      if (from >= 0) { if (from !== i && _has(G.Items, 'moveSlot')) G.Items.moveSlot(pl, from, i); }
      else if (eslot && pl.equipment && pl.equipment[eslot] && _has(G.Items, 'unequip')) {
        const it = pl.equipment[eslot];
        if (G.Items.unequip(pl, eslot)) { const at = _has(G.Items, 'findInInventory') ? G.Items.findInInventory(pl, it.uid) : -1; if (at >= 0 && at !== i && !pl.inventory[i] && _has(G.Items, 'moveSlot')) G.Items.moveSlot(pl, at, i); _sfx('equip'); }
      }
      _dndReset();
    });
    return s;
  }
  Inv.render = function () {
    const body = Inv.body; if (!body) return;
    if (Inv._wrap) Inv._scroll = Inv._wrap.scrollTop;
    _clear(body);
    const p = _player();
    const tabs = el('div', { class: 'tabs' });
    INV_FILTERS.forEach(function (f) { tabs.appendChild(el('span', { class: 'tab' + (Inv.filter === f.id ? ' active' : ''), text: f.label, onclick: function () { Inv.setFilter(f.id); } })); });
    const sortBtn = _btn('Sort', function () { Inv.sort(); }, 'small');
    _tip(sortBtn, '<div class="tt-name">Sort bags</div><div class="tt-line">Merges stacks and orders everything by type, level and quality.</div>');
    body.appendChild(el('div', { class: 'inv-top' }, [tabs, sortBtn]));
    const wrap = el('div', { class: 'inv-grid-wrap' });
    const grid = el('div', { class: 'inv-grid' });
    Inv._wrap = wrap;
    const n = C.INVENTORY_SLOTS || 200;
    const inv = (p && Array.isArray(p.inventory)) ? p.inventory : [];
    const f = _invFilter(Inv.filter);
    let used = 0, shown = 0;
    for (let i = 0; i < n; i++) {
      const inst = inv[i] || null;
      if (inst) used++;
      if (f && (!inst || !_invMatches(f, inst))) continue;
      grid.appendChild(_invSlot(i, inst, p));
      shown++;
    }
    wrap.appendChild(grid);
    if (f && !shown) wrap.appendChild(el('div', { class: 'pn-empty', text: 'Nothing of that kind in your bags.' }));
    wrap.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
    body.appendChild(wrap);
    const bags = el('span', { class: 'inv-bags' + (used >= n ? ' full' : '') });
    bags.innerHTML = 'Bags: <b>' + used + '/' + n + '</b>' + (f ? ' <span class="pn-muted">· ' + shown + ' shown</span>' : '');
    const hint = el('span', { class: 'inv-hint', text: 'Drag to move · drop on your character to equip' });
    const gold = el('span', { class: 'inv-gold' });
    gold.innerHTML = _money(p ? _num(p.gold) : 0);
    _tip(gold, function () { const g = p ? _num(p.gold) : 0; return '<div class="tt-name">Your purse</div><div class="tt-line">' + esc(_moneyText(g)) + '</div><div class="tt-desc">100 copper = 1 silver · 1,000 silver = 1 gold</div>'; });
    body.appendChild(el('div', { class: 'inv-foot' }, [bags, hint, gold]));
    if (Inv._scroll) wrap.scrollTop = Inv._scroll;
  };
  Inv.setFilter = function (id) { if (!_invFilter(id) && id !== 'all') id = 'all'; Inv.filter = id; Inv._scroll = 0; _sfx('ui_click'); Inv.refresh(); };
  Inv.sort = function () { const p = _player(); if (p && _has(G.Items, 'sort')) { G.Items.sort(p); _sfx('ui_click'); _notify('Bags sorted.', 'info'); } };
  Inv.highlight = function (tid) {
    if (!tid) return;
    Inv._hl[tid] = true;
    Inv.mark();
    if (Inv._hlTimer) clearTimeout(Inv._hlTimer);
    Inv._hlTimer = setTimeout(function () { Inv._hlTimer = 0; Inv._hl = {}; Inv.mark(); }, 2400);
    if (Inv.isOpen()) { const slots = Inv.body ? Inv.body.querySelectorAll('.inv-slot') : []; const p = _player(); for (let i = 0; i < slots.length; i++) { const idx = parseInt(slots[i].dataset.i, 10); const inst = p && p.inventory && p.inventory[idx]; if (inst && inst.tid === tid) slots[i].classList.add('hl'); } }
  };
  definePanel('inventory', Inv, { title: 'Inventory', key: 'KeyI', width: 544, pos: 'right' });

  // ================================================================================================ CHARACTER (C)
  const PV = { renderer: null, scene: null, camera: null, rig: null, canvas: null, group: null, angle: 0.55, dragging: false, idleT: 9, needRebuild: true, failed: false, ent: null, lastEquipSig: '', spinning: true, fallback: null };
  const Ch = { tab: 'stats', preview: PV, _sideBody: null, _sideScroll: 0 };
  const CH_LEFT = ['head', 'shoulder', 'back', 'chest', 'hands', 'legs', 'feet'];
  const CH_RIGHT = ['neck', 'ear1', 'ear2', 'wrist1', 'wrist2', 'ring1', 'ring2', 'pocket'];
  const CH_WEAPONS = ['mainhand', 'offhand', 'ranged'];
  function _pvEnsure() {
    if (PV.renderer || PV.failed || !THREE) return !!PV.renderer;
    try {
      if (!PV.canvas) PV.canvas = el('canvas', { width: 260, height: 380 });
      PV.renderer = new THREE.WebGLRenderer({ canvas: PV.canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
      PV.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
      PV.renderer.setSize(260, 380, false);
      PV.renderer.setClearColor(0x000000, 0);
      if ('outputColorSpace' in PV.renderer && THREE.SRGBColorSpace) PV.renderer.outputColorSpace = THREE.SRGBColorSpace;
      PV.scene = new THREE.Scene();
      PV.camera = new THREE.PerspectiveCamera(30, 260 / 380, 0.05, 60);
      const key = new THREE.DirectionalLight(0xfff1dc, 2.6); key.position.set(2.2, 4, 3.2);
      const fill = new THREE.DirectionalLight(0xbfd4ff, 1.1); fill.position.set(-3, 2, 2.4);
      const rim = new THREE.DirectionalLight(0xffd9a0, 1.9); rim.position.set(0.5, 3, -4);
      const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x4a3a20, 0.85);
      PV.scene.add(key, fill, rim, hemi);
      PV.group = new THREE.Group();
      PV.scene.add(PV.group);
      PV.ent = { id: 'preview', kind: 'player', vel: new THREE.Vector3(0, 0, 0), onGround: true, alive: true, dead: false, swimming: false, mounted: false, target: null, inCombat: false };
      PV.canvas.addEventListener('webglcontextlost', function (ev) { ev.preventDefault(); }, false);
      return true;
    } catch (err) { PV.failed = true; _report(err, 'character preview'); return false; }
  }
  function _equipSig(p) { let s = ''; if (p && p.equipment) for (const k in p.equipment) { const it = p.equipment[k]; s += k + ':' + (it ? (it.uid || it.tid) : '') + '|'; } return s + (p ? (p.race + p.gender + p.cls + p.hairStyle + p.hairColor + p.skin) : ''); }
  function _pvRebuild() {
    const p = _player();
    if (!_pvEnsure() || !p || !_has(G.Chars, 'buildHumanoid')) return;
    if (PV.rig) { try { if (typeof PV.rig.dispose === 'function') PV.rig.dispose(); } catch (_) { /* ignore */ } if (PV.rig.group && PV.rig.group.parent) PV.rig.group.parent.remove(PV.rig.group); PV.rig = null; }
    const cd = _cls(p.cls);
    try {
      PV.rig = G.Chars.buildHumanoid({
        race: p.race, gender: p.gender, cls: p.cls, name: p.name, level: p.level,
        skin: p.skin, hair: p.hair, hairColor: p.hairColor, hairStyle: p.hairStyle, eyes: p.eyes, beard: p.beard,
        height: _num(p.heightScale, 1) || 1, build: p.build, equipment: p.equipment || {}, armourType: cd ? cd.armourType : undefined,
        nameplate: false, player: true,
      });
    } catch (err) { _report(err, 'character preview rig'); PV.rig = null; }
    if (!PV.rig || !PV.rig.group) return;
    PV.group.add(PV.rig.group);
    if (typeof PV.rig.setAnim === 'function') PV.rig.setAnim('idle', true);
    const H = Math.max(0.9, _num(PV.rig.height, 1.8) || 1.8);
    PV.camera.position.set(0, H * 0.56, H * 2.08 + 0.15);
    PV.camera.lookAt(0, H * 0.5, 0);
    PV.camera.updateProjectionMatrix();
    PV.lastEquipSig = _equipSig(p);
    PV.needRebuild = false;
  }
  function _pvRender(dt) {
    if (!Ch.isOpen() || PV.failed) return;
    if (PV.needRebuild) _pvRebuild();
    if (!PV.renderer || !PV.rig) return;
    if (!PV.dragging) { PV.idleT += dt; if (PV.idleT > 2.5) PV.angle += dt * 0.35; }
    PV.group.rotation.y = PV.angle;
    try { if (typeof PV.rig.play === 'function') PV.rig.play(dt, PV.ent); PV.renderer.render(PV.scene, PV.camera); }
    catch (err) { PV.failed = true; _report(err, 'character preview render'); }
  }
  function _pvBox() {
    const box = el('div', { class: 'ch-preview' });
    box.appendChild(el('div', { class: 'ch-floor' }));
    if (_pvEnsure()) {
      box.appendChild(PV.canvas);
      box.appendChild(el('div', { class: 'ch-hint', text: 'drag to turn' }));
      if (!PV._bound) {
        PV._bound = true;
        let lastX = 0;
        PV.canvas.addEventListener('pointerdown', function (ev) { if (ev.button !== 0) return; PV.dragging = true; lastX = ev.clientX; try { PV.canvas.setPointerCapture(ev.pointerId); } catch (_) { /* ignore */ } ev.preventDefault(); });
        PV.canvas.addEventListener('pointermove', function (ev) { if (!PV.dragging) return; PV.angle += (ev.clientX - lastX) * 0.012; lastX = ev.clientX; });
        const up = function () { if (PV.dragging) { PV.dragging = false; PV.idleT = 0; } };
        PV.canvas.addEventListener('pointerup', up); PV.canvas.addEventListener('pointercancel', up); PV.canvas.addEventListener('lostpointercapture', up);
        PV.canvas.addEventListener('dblclick', function () { PV.angle = 0.55; PV.idleT = 0; });
      }
      if (PV.needRebuild) _pvRebuild();
      _pvRender(0);
    } else {
      const p = _player(); const cd = p && _cls(p.cls);
      box.appendChild(el('div', { class: 'ch-fallback', text: (cd && cd.icon) || '⚔' }));
    }
    return box;
  }
  function _chSlot(slot, p) {
    const inst = p && p.equipment ? p.equipment[slot] : null;
    const s = el('div', { class: 'slot ch-slot' + (inst ? ' border-' + _rarityOf(inst) : ' empty'), data: { eslot: slot }, draggable: !!inst });
    if (inst) s.innerHTML = _iconHTML(inst, 38);
    else s.appendChild(el('span', { class: 'empty-label', text: _slotLabel(slot) }));
    _tip(s, function () {
      if (inst) return _itemTip(inst, p) + '<div class="tt-sub" style="margin-top:4px">Click to unequip · drag to your bags</div>';
      return '<div class="tt-name">' + esc(_slotLabel(slot)) + '</div><div class="tt-line">Empty slot</div><div class="tt-desc">Drag an item here from your bags, or click an item in your inventory to equip it.</div>';
    });
    if (inst) {
      s.addEventListener('click', function () { if (_has(G.Items, 'unequip') && G.Items.unequip(p, slot)) _sfx('equip'); });
      s.addEventListener('contextmenu', function (ev) { ev.preventDefault(); ev.stopPropagation(); _tipHide(); _menu([{ label: 'Unequip', icon: '↧', onClick: function () { if (_has(G.Items, 'unequip') && G.Items.unequip(p, slot)) _sfx('equip'); } }], ev.clientX, ev.clientY, _itemName(inst)); });
      s.addEventListener('dragstart', function (ev) { DND.kind = 'equip'; DND.slot = slot; DND.inst = inst; _dtSet(ev, 'text/equip-slot', slot); _dtSet(ev, 'text/plain', 'equip:' + slot); try { ev.dataTransfer.effectAllowed = 'move'; } catch (_) { /* ignore */ } s.classList.add('dragging'); _tipHide(); });
      s.addEventListener('dragend', function () { s.classList.remove('dragging'); _dndReset(); });
    }
    s.addEventListener('dragover', function (ev) { if (_dndActive(ev)) { ev.preventDefault(); try { ev.dataTransfer.dropEffect = 'move'; } catch (_) { /* ignore */ } s.classList.add('dragover'); } });
    s.addEventListener('dragleave', function () { s.classList.remove('dragover'); });
    s.addEventListener('drop', function (ev) {
      ev.preventDefault(); s.classList.remove('dragover');
      const pl = _player(); if (!pl) return;
      const from = _dndInv(ev), fromSlot = _dndEquip(ev);
      if (from >= 0) {
        const it = pl.inventory && pl.inventory[from];
        if (it && _has(G.Items, 'equip')) {
          const ok = _has(G.Items, 'slotsFor') ? G.Items.slotsFor(pl, it).indexOf(slot) >= 0 : true;
          if (!ok) { _notify(_itemName(it) + ' cannot go in the ' + _slotLabel(slot).toLowerCase() + ' slot.', 'warning'); _sfx('ui_error'); }
          else if (G.Items.equip(pl, from, slot)) _sfx('equip');
        }
      } else if (fromSlot && fromSlot !== slot && pl.equipment && pl.equipment[fromSlot] && _has(G.Items, 'unequip') && _has(G.Items, 'equip')) {
        const it = pl.equipment[fromSlot];
        const ok = _has(G.Items, 'slotsFor') ? G.Items.slotsFor(pl, it).indexOf(slot) >= 0 : false;
        if (!ok) { _notify('That does not fit there.', 'warning'); _sfx('ui_error'); }
        else if (G.Items.unequip(pl, fromSlot)) { const at = _has(G.Items, 'findInInventory') ? G.Items.findInInventory(pl, it.uid) : -1; if (at >= 0) G.Items.equip(pl, at, slot); _sfx('equip'); }
      }
      _dndReset();
    });
    return s;
  }
  const ROLE_NAME = { tank: 'Tank', dps: 'Damage', support: 'Support', healer: 'Healer' };
  function _statRow(label, value, statKey, extra) {
    const k = el('span', { class: 'k', text: label });
    const v = el('span', { class: 'v' });
    v.appendChild(document.createTextNode(_str(value)));
    if (extra) v.appendChild(el('span', { class: 'pct', text: extra }));
    const d = statKey ? _statDesc(statKey) : '';
    if (d) _tip(k, '<div class="tt-name">' + esc(_statName(statKey) === label ? label : label) + '</div><div class="tt-desc">' + esc(d) + '</div>');
    return [k, v];
  }
  function _pct(v) { return (Math.round(_num(v) * 10) / 10).toFixed(1) + '%'; }
  function _chStats(p) {
    const s = p.stats || {};
    let pc = { mitigation: s.mitigation, critChance: s.critChance, blockChance: s.blockChance, parryChance: s.parryChance, evadeChance: s.evadeChance, resistChance: s.resistChance };
    if (pc.mitigation == null && G.Data && G.Data.stats && _has(G.Data.stats, 'percentages')) { try { pc = G.Data.stats.percentages(p); } catch (_) { /* ignore */ } }
    const box = el('div');
    const sec = function (title, rows) { box.appendChild(el('div', { class: 'section-title', text: title })); const kv = el('div', { class: 'pn-kv' }); rows.forEach(function (r) { kv.appendChild(r[0]); kv.appendChild(r[1]); }); box.appendChild(kv); };
    sec('Primary', ['might', 'agility', 'vitality', 'will', 'fate'].map(function (k) { return _statRow(_statName(k), _fmt(Math.round(_num(s[k]))), k); }));
    sec('Morale & Power', [
      _statRow('Morale', _fmt(Math.round(_num(p.morale))) + ' / ' + _fmt(Math.round(_num(s.maxMorale))), 'maxMorale'),
      _statRow('Morale regeneration', (_num(s.moraleRegen)).toFixed(1) + ' /s', 'moraleRegen'),
      _statRow('Power', _fmt(Math.round(_num(p.power))) + ' / ' + _fmt(Math.round(_num(s.maxPower))), 'maxPower'),
      _statRow('Power regeneration', (_num(s.powerRegen)).toFixed(1) + ' /s', 'powerRegen'),
    ]);
    sec('Offence', [
      _statRow('Physical Mastery', _fmt(Math.round(_num(s.physMastery))), 'physMastery'),
      _statRow('Tactical Mastery', _fmt(Math.round(_num(s.tactMastery))), 'tactMastery'),
      _statRow('Critical Rating', _fmt(Math.round(_num(s.crit))), 'crit', pc.critChance != null ? _pct(pc.critChance) : ''),
      _statRow('Finesse', _fmt(Math.round(_num(s.finesse))), 'finesse'),
    ]);
    sec('Defence', [
      _statRow('Armour', _fmt(Math.round(_num(s.armour))), 'armour', pc.mitigation != null ? _pct(pc.mitigation) : ''),
      _statRow('Block Rating', _fmt(Math.round(_num(s.block))), 'block', pc.blockChance != null ? _pct(pc.blockChance) : ''),
      _statRow('Parry Rating', _fmt(Math.round(_num(s.parry))), 'parry', pc.parryChance != null ? _pct(pc.parryChance) : ''),
      _statRow('Evade Rating', _fmt(Math.round(_num(s.evade))), 'evade', pc.evadeChance != null ? _pct(pc.evadeChance) : ''),
      _statRow('Resistance', _fmt(Math.round(_num(s.resist))), 'resist', pc.resistChance != null ? _pct(pc.resistChance) : ''),
    ]);
    const other = [];
    if (s.speed != null) other.push(_statRow('Run Speed', '×' + (_num(s.speed, 1)).toFixed(2), 'speed'));
    if (s.stealth) other.push(_statRow('Stealth', '+' + Math.round(_num(s.stealth) * 100) + '%', 'stealth'));
    if (s.fishingLuck) other.push(_statRow('Fishing Luck', '+' + Math.round(_num(s.fishingLuck) * 100) + '%', 'fishingLuck'));
    if (G.state && G.state.fishingSkill != null) other.push(_statRow('Fishing Skill', _num(G.state.fishingSkill, 1) + ' / 100', null));
    if (other.length) sec('Other', other);
    return box;
  }
  function _chSets(p) {
    const box = el('div');
    let sb = null;
    try { sb = _has(G.Items, 'setBonuses') ? G.Items.setBonuses(p) : null; } catch (err) { _report(err, 'setBonuses'); }
    const sets = sb && Array.isArray(sb.sets) ? sb.sets : [];
    box.appendChild(el('div', { class: 'section-title', text: 'Gear sets' }));
    if (!sets.length) { box.appendChild(el('div', { class: 'pn-empty', text: 'No pieces of any gear set are equipped. Sets grant bonuses at 2, 4 and 6 pieces.' })); return box; }
    const eqTids = {}; if (p.equipment) for (const k in p.equipment) if (p.equipment[k]) eqTids[p.equipment[k].tid] = 1;
    sets.forEach(function (st) {
      const def = G.Data && G.Data.sets && G.Data.sets[st.id];
      const card = el('div', { class: 'ch-set' });
      card.appendChild(el('div', { class: 'ch-set-name' }, [el('span', { text: st.name }), el('span', { class: 'cnt', text: st.count + ' / ' + st.total })]));
      if (def && Array.isArray(def.pieces) && def.pieces.length <= 8) def.pieces.forEach(function (tid) { const t = G.Data.items && G.Data.items[tid]; if (t) card.appendChild(el('div', { class: 'ch-set-piece' + (eqTids[tid] ? ' on' : ''), text: (eqTids[tid] ? '● ' : '○ ') + t.name })); });
      const ths = Object.keys(st.bonuses || {}).map(Number).sort(function (a, b) { return a - b; });
      ths.forEach(function (th) {
        const b = st.bonuses[th]; const parts = [];
        for (const k in b) parts.push('+' + b[k] + ' ' + _statName(k));
        const on = st.bonusesActive && st.bonusesActive.indexOf(th) >= 0;
        card.appendChild(el('div', { class: 'ch-set-bonus' + (on ? ' on' : '') }, [el('span', { class: 'th', text: '(' + th + ')' }), document.createTextNode(parts.join(', '))]));
      });
      if (def && def.desc) card.appendChild(el('div', { class: 'ab-trait-desc', text: def.desc }));
      box.appendChild(card);
    });
    if (sb && sb.stats) { const keys = Object.keys(sb.stats).filter(function (k) { return sb.stats[k]; }); if (keys.length) { box.appendChild(el('div', { class: 'section-title', text: 'Active set bonuses' })); const kv = el('div', { class: 'pn-kv' }); keys.forEach(function (k) { const r = _statRow(_statName(k), '+' + sb.stats[k], k); kv.appendChild(r[0]); kv.appendChild(r[1]); }); box.appendChild(kv); } }
    return box;
  }
  function _titleText(id, p) { if (!id) return ''; if (_has(G.Data, 'titleName')) { try { return G.Data.titleName(id, p && p.gender) || id; } catch (_) { return id; } } return id; }
  function _setTitle(p, id) {
    if (!p) return;
    if (_has(G.Progress, 'setTitle')) { try { G.Progress.setTitle(id || null); } catch (_) { /* ignore */ } }
    p.activeTitle = id || null;
    p.title = id ? _titleText(id, p) : '';
    _sfx('ui_click');
    Ch.mark();
  }
  function _chTitles(p) {
    const box = el('div');
    const owned = Array.isArray(p.titles) ? p.titles : [];
    box.appendChild(el('div', { class: 'section-title', text: 'Titles (' + owned.length + ')' }));
    const none = el('div', { class: 'ch-title-row' + (!p.activeTitle ? ' active' : '') }, [el('span', { text: 'No title' }), el('span', { class: 'ch-title-desc', text: 'Go by your name alone.' })]);
    none.addEventListener('click', function () { _setTitle(p, null); });
    box.appendChild(none);
    const all = (G.Data && Array.isArray(G.Data.titles)) ? G.Data.titles : owned.map(function (id) { return { id: id, name: _titleText(id, p) }; });
    all.forEach(function (t) {
      const have = owned.indexOf(t.id) >= 0;
      const row = el('div', { class: 'ch-title-row' + (p.activeTitle === t.id ? ' active' : '') + (have ? '' : ' locked') }, [el('span', { text: _titleText(t.id, p) }), el('span', { class: 'ch-title-desc', text: t.desc || '' })]);
      _tip(row, '<div class="tt-name">' + esc(_titleText(t.id, p)) + '</div><div class="tt-line">' + esc(t.desc || '') + '</div>' + (have ? '<div class="tt-stat">Earned</div>' : '<div class="tt-req">Not yet earned</div>'));
      if (have) row.addEventListener('click', function () { _setTitle(p, t.id); });
      box.appendChild(row);
    });
    return box;
  }
  Ch.render = function () {
    const body = Ch.body; if (!body) return;
    if (Ch._sideBody) Ch._sideScroll = Ch._sideBody.scrollTop;
    _clear(body);
    const p = _player();
    if (!p) { body.appendChild(el('div', { class: 'pn-empty', text: 'No character yet.' })); return; }
    const cd = _cls(p.cls), rd = _race(p.race);
    // ---- header
    const portrait = el('div', { class: 'ch-portrait', text: (cd && cd.icon) || '⚔', style: { borderColor: cd ? _hex(cd.color) : '' } });
    const nameEl = el('span', { class: 'pn-head-name', text: p.name || 'Adventurer' });
    const sel = el('select', { title: 'Title' });
    sel.appendChild(el('option', { value: '', text: '— no title —' }));
    (Array.isArray(p.titles) ? p.titles : []).forEach(function (id) { sel.appendChild(el('option', { value: id, text: _titleText(id, p), selected: p.activeTitle === id })); });
    sel.value = p.activeTitle && (p.titles || []).indexOf(p.activeTitle) >= 0 ? p.activeTitle : '';
    sel.addEventListener('change', function () { _setTitle(p, sel.value || null); });
    sel.addEventListener('keydown', function (ev) { ev.stopPropagation(); });
    _tip(sel, '<div class="tt-name">Title</div><div class="tt-line">Choose which of your earned titles is shown beside your name.</div>');
    const sub = el('div', { class: 'ch-sub' });
    sub.innerHTML = 'Level <b>' + _num(p.level, 1) + '</b> ' + esc((p.gender === 'female' ? 'Female ' : 'Male ') + ((rd && rd.name) || _title(p.race || ''))) + ' <b style="color:' + (cd ? _hex(cd.color) : 'inherit') + '">' + esc((cd && cd.name) || _title(p.cls || '')) + '</b>' + (cd ? ' <span class="chip">' + esc(ROLE_NAME[cd.role] || _title(cd.role || '')) + '</span><span class="chip">' + esc(_title(cd.armourType || '')) + ' armour</span>' : '');
    const xi = _xpInfo(p);
    const xpRow = el('div', { class: 'ch-xp' }, [el('span', { text: 'XP' }), _bar(xi.frac, 'xp', xi.capped ? 'Level cap reached' : _fmt(Math.round(xi.cur)) + ' / ' + _fmt(Math.round(xi.need))), el('span', { text: xi.capped ? '' : _fmt(Math.round(xi.toNext)) + ' to ' + (xi.level + 1) })]);
    body.appendChild(el('div', { class: 'ch-head' }, [portrait, el('div', { class: 'ch-headmain' }, [el('div', { class: 'ch-nameline' }, [nameEl, sel]), sub, xpRow])]));
    // ---- main
    const left = el('div', { class: 'ch-col' }); CH_LEFT.forEach(function (s) { left.appendChild(_chSlot(s, p)); });
    const right = el('div', { class: 'ch-col' }); CH_RIGHT.forEach(function (s) { right.appendChild(_chSlot(s, p)); });
    const weapons = el('div', { class: 'ch-weapons' });
    CH_WEAPONS.forEach(function (s) { weapons.appendChild(_chSlot(s, p)); });
    const center = el('div', { class: 'ch-center' }, [_pvBox(), weapons]);
    const doll = el('div', { class: 'ch-doll' }, [left, center, right]);
    const tabs = el('div', { class: 'tabs' });
    [['stats', 'Stats'], ['sets', 'Gear Sets'], ['titles', 'Titles']].forEach(function (t) { tabs.appendChild(el('span', { class: 'tab' + (Ch.tab === t[0] ? ' active' : ''), text: t[1], onclick: function () { Ch.setTab(t[0]); } })); });
    const sideBody = el('div', { class: 'ch-side-body' });
    sideBody.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
    if (Ch.tab === 'sets') sideBody.appendChild(_chSets(p));
    else if (Ch.tab === 'titles') sideBody.appendChild(_chTitles(p));
    else sideBody.appendChild(_chStats(p));
    Ch._sideBody = sideBody;
    body.appendChild(el('div', { class: 'ch-main' }, [doll, el('div', { class: 'ch-side' }, [tabs, sideBody])]));
    // ---- footer
    const st = (G.state && G.state.stats) || {};
    const foot = el('div', { class: 'ch-foot' });
    [['Kills', _fmt(_num(st.kills))], ['Quests', _fmt(_num(st.quests))], ['Fish', _fmt(_num(st.fish))], ['Deaths', _fmt(_num(st.deaths))], ['Played', _playTime(st.playTime)]].forEach(function (x) { const s = el('span'); s.innerHTML = esc(x[0]) + ' <b>' + esc(x[1]) + '</b>'; foot.appendChild(s); });
    body.appendChild(foot);
    if (Ch._sideScroll) sideBody.scrollTop = Ch._sideScroll;
  };
  Ch.setTab = function (t) { Ch.tab = t === 'sets' || t === 'titles' ? t : 'stats'; Ch._sideScroll = 0; _sfx('ui_click'); Ch.refresh(); };
  Ch.rebuildPreview = function () { PV.needRebuild = true; if (Ch.isOpen()) _pvRebuild(); };
  Ch.onOpen = function (arg) { if (typeof arg === 'string') { Ch.tab = arg; Ch.refresh(); } PV.idleT = 9; const p = _player(); if (p && PV.lastEquipSig !== _equipSig(p)) PV.needRebuild = true; };
  definePanel('character', Ch, { title: 'Character', key: 'KeyC', width: 728, pos: 'left' });

  // ================================================================================================ ABILITIES (K)
  const Ab = { selected: null, _list: null, _scroll: 0 };
  function _hasAbility(p, id) { if (!p || !p.abilities) return false; if (typeof p.abilities.has === 'function') return p.abilities.has(id); if (Array.isArray(p.abilities)) return p.abilities.indexOf(id) >= 0; return !!p.abilities[id]; }
  function _hotbarSlotOf(p, id) { if (!p || !Array.isArray(p.hotbar)) return -1; for (let i = 0; i < p.hotbar.length; i++) if (p.hotbar[i] === id) return i; return -1; }
  function _setHotbar(slot, id) {
    const p = _player(); if (!p) return false;
    if (_has(G.Progress, 'setHotbar')) return G.Progress.setHotbar(slot, id || null);
    if (!Array.isArray(p.hotbar)) p.hotbar = new Array(20).fill(null);
    if (id) for (let i = 0; i < p.hotbar.length; i++) if (p.hotbar[i] === id) p.hotbar[i] = null;
    p.hotbar[slot] = id || null;
    G.emit('hotbarChanged', slot);
    if (_has(UI, 'hotbarRefresh')) UI.hotbarRefresh();
    return true;
  }
  function _trainAbility(a) {
    const p = _player(); if (!p || !a) return;
    if (_has(G.Progress, 'trainAbility')) { const r = G.Progress.trainAbility(a.id); if (r && r.ok) Ab.mark(); return; }
    // fallback when 21_combat is absent (harness / degraded build)
    const cost = _has(G.Data, 'trainCost') ? G.Data.trainCost(a) : _num(a.cost);
    if (_num(p.level, 1) < a.level) { _notify('Requires level ' + a.level, 'warning'); _sfx('ui_error'); return; }
    if (_num(p.gold) < cost) { _notify('Not enough coin', 'warning'); _sfx('ui_error'); return; }
    p.gold = _num(p.gold) - cost;
    if (!p.abilities || typeof p.abilities.add !== 'function') p.abilities = new Set(Array.isArray(p.abilities) ? p.abilities : []);
    p.abilities.add(a.id);
    if (!Array.isArray(p.hotbar)) p.hotbar = new Array(20).fill(null);
    if (_hotbarSlotOf(p, a.id) < 0) { const free = p.hotbar.indexOf(null); if (free >= 0) p.hotbar[free] = a.id; }
    G.emit('goldChanged', p.gold); G.emit('abilityTrained', a.id);
    _notify('You have learned ' + a.name, 'level'); _sfx('achievement');
    Ab.mark();
  }
  function _abRow(a, p, L) {
    const trained = _hasAbility(p, a.id);
    const locked = !trained && L < a.level;
    const cost = _has(G.Data, 'trainCost') ? G.Data.trainCost(a) : _num(a.cost);
    const canAfford = _num(p.gold) >= cost;
    const row = el('div', { class: 'ab-row' + (trained ? ' trained' : locked ? ' locked' : '') + (Ab.selected === a.id ? ' selected' : ''), draggable: trained, data: { id: a.id } });
    row.appendChild(el('div', { class: 'ab-ico', text: a.icon || '✨' }));
    const kindName = _title(a.kind || '');
    row.appendChild(el('div', { class: 'ab-name' }, [el('span', { text: a.name }), _chip(kindName), _chip('Level ' + a.level, L >= a.level ? '' : 'side')]));
    const act = el('div', { class: 'ab-act', style: 'grid-row: span 2; flex-direction: column; align-items: flex-end; gap: 4px;' });
    if (trained) {
      act.appendChild(el('span', { class: 'ab-status trained', text: '✓ Trained' }));
      const sel = el('select', { title: 'Hotbar slot' });
      sel.appendChild(el('option', { value: '', text: '— not on bar —' }));
      const keys = C.HOTBAR_KEYS || [];
      const cur = _hotbarSlotOf(p, a.id);
      for (let i = 0; i < 20; i++) {
        const occ = Array.isArray(p.hotbar) && p.hotbar[i] && p.hotbar[i] !== a.id ? _abil(p.hotbar[i]) : null;
        sel.appendChild(el('option', { value: String(i), text: 'Slot ' + (i + 1) + ' [' + (keys[i] || '') + ']' + (occ ? ' · ' + occ.name : ''), selected: cur === i }));
      }
      sel.value = cur >= 0 ? String(cur) : '';
      sel.addEventListener('change', function () { const v = sel.value; if (v === '') { const c = _hotbarSlotOf(p, a.id); if (c >= 0) _setHotbar(c, null); } else _setHotbar(parseInt(v, 10), a.id); _sfx('ui_click'); Ab.mark(); });
      sel.addEventListener('mousedown', function (ev) { ev.stopPropagation(); });
      sel.addEventListener('keydown', function (ev) { ev.stopPropagation(); });
      _tip(sel, '<div class="tt-name">Set on hotbar</div><div class="tt-line">Choose the slot this ability sits in. You can also drag the row onto the hotbar.</div>');
      act.appendChild(sel);
    } else if (locked) {
      act.appendChild(el('span', { class: 'ab-status locked', text: 'Requires level ' + a.level }));
      const c = el('span', { class: 'pn-muted small' }); c.innerHTML = cost > 0 ? _money(cost) : 'Free'; act.appendChild(c);
    } else {
      const c = el('span', { class: 'small' + (canAfford ? '' : ' pn-muted') }); c.innerHTML = cost > 0 ? _money(cost) : '<span class="pn-gold">Free</span>'; act.appendChild(c);
      const b = _btn('Train', function () { _trainAbility(a); }, 'primary small');
      if (!canAfford) b.classList.add('disabled');
      act.appendChild(b);
    }
    row.appendChild(act);
    let desc = a.descPlain || a.desc || '';
    if (_has(G.Data, 'abilityDesc')) { try { desc = G.Data.abilityDesc(a, p) || desc; } catch (_) { /* ignore */ } }
    row.appendChild(el('div', { class: 'ab-desc', text: desc + '  ·  ' + _num(a.power) + ' power' + (a.cooldown > 0 ? ' · ' + a.cooldown + ' s cooldown' : '') }));
    _tip(row, function () { let h = _has(G.Data, 'abilityTooltipHTML') ? G.Data.abilityTooltipHTML(a, p) : '<div class="tt-name">' + esc(a.name) + '</div>'; if (trained) h += '<div class="tt-sub">Drag onto the hotbar to place it</div>'; return h; });
    row.addEventListener('click', function () { Ab.selected = a.id; row.parentNode && Array.prototype.forEach.call(row.parentNode.querySelectorAll('.ab-row'), function (r) { r.classList.toggle('selected', r === row); }); });
    if (trained) {
      row.addEventListener('dragstart', function (ev) { _dtSet(ev, 'text/ability', a.id); _dtSet(ev, 'text/plain', a.id); try { ev.dataTransfer.effectAllowed = 'copyMove'; } catch (_) { /* ignore */ } _tipHide(); });
    }
    return row;
  }
  function _traitCard(t, L, unlocked, isRace) {
    const bonus = _has(G.Data, 'describeBonus') ? G.Data.describeBonus(t, unlocked ? L : 0) : '';
    return el('div', { class: 'ab-trait' + (unlocked ? '' : ' locked') }, [
      el('div', { class: 'ab-trait-lvl', text: isRace ? 'Race' : 'L' + t.level }),
      el('div', { class: 'pn-grow' }, [
        el('div', { class: 'ab-trait-name', text: t.name + (unlocked ? '' : '  —  unlocks at level ' + t.level) }),
        bonus ? el('div', { class: 'ab-trait-bonus', text: bonus }) : null,
        t.desc ? el('div', { class: 'ab-trait-desc', text: t.desc }) : null,
      ]),
    ]);
  }
  Ab.render = function () {
    const body = Ab.body; if (!body) return;
    if (Ab._list) Ab._scroll = Ab._list.scrollTop;
    _clear(body);
    const p = _player();
    if (!p) { body.appendChild(el('div', { class: 'pn-empty', text: 'No character yet.' })); return; }
    const cd = _cls(p.cls), rd = _race(p.race), L = _num(p.level, 1);
    let list = [];
    try { list = _has(G.Data, 'abilitiesFor') ? (G.Data.abilitiesFor(p.cls) || []) : []; } catch (err) { _report(err, 'abilitiesFor'); }
    list = list.slice().sort(function (a, b) { return a.level - b.level; });
    let trained = 0; list.forEach(function (a) { if (_hasAbility(p, a.id)) trained++; });
    const top = el('div', { class: 'ab-top' });
    const left = el('span'); left.innerHTML = '<span class="pn-head-name" style="font-size:16px">' + esc((cd && cd.name) || _title(p.cls || '')) + ' abilities</span> <span class="pn-muted">' + trained + ' of ' + list.length + ' trained</span>';
    const right = el('span'); right.innerHTML = '<span class="pn-muted">Purse </span>' + _money(_num(p.gold));
    top.appendChild(left); top.appendChild(right);
    body.appendChild(top);
    const wrap = el('div', { class: 'ab-list' });
    wrap.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
    Ab._list = wrap;
    if (!list.length) wrap.appendChild(el('div', { class: 'pn-empty', text: 'No abilities are known for this class.' }));
    list.forEach(function (a) { wrap.appendChild(_abRow(a, p, L)); });
    const traits = el('div', { class: 'ab-traits' });
    traits.appendChild(el('div', { class: 'section-title', text: 'Class traits' }));
    const all = (G.Data && G.Data.classTraits && G.Data.classTraits[p.cls]) || [];
    let shownNext = false;
    if (!all.length) traits.appendChild(el('div', { class: 'pn-empty', text: 'No class traits.' }));
    all.forEach(function (t) { if (L >= t.level) traits.appendChild(_traitCard(t, L, true)); else if (!shownNext) { shownNext = true; traits.appendChild(_traitCard(t, L, false)); } });
    if (rd && rd.racialTrait) { traits.appendChild(el('div', { class: 'section-title', text: 'Racial trait — ' + rd.name })); traits.appendChild(_traitCard(rd.racialTrait, L, true, true)); }
    wrap.appendChild(traits);
    body.appendChild(wrap);
    if (Ab._scroll) wrap.scrollTop = Ab._scroll;
  };
  Ab.select = function (id) { Ab.selected = id; if (Ab.isOpen()) { Ab.refresh(); const r = Ab.body && Ab.body.querySelector('.ab-row.selected'); if (r && typeof r.scrollIntoView === 'function') r.scrollIntoView({ block: 'nearest' }); } };
  Ab.onOpen = function (arg) { if (typeof arg === 'string') Ab.select(arg); };
  definePanel('abilities', Ab, { title: 'Abilities & Training', key: 'KeyK', width: 660, height: Math.min(640, Math.max(420, _vh() - 80)), pos: 'center' });

  // ================================================================================================ JOURNAL (J)
  const Jn = { tab: 'active', selected: null, _list: null, _scroll: 0 };
  function _bookOf(d) { return d && d.book ? String(d.book) : (d && d.type === 'story' ? 'The Epic Story' : ''); }
  function _chapterOf(d) {
    if (!d || d.type !== 'story') return 0;
    if (typeof d.chapter === 'number') return d.chapter;
    const book = _bookOf(d);
    const ids = _allQuests().filter(function (q) { return q.type === 'story' && _bookOf(q) === book; }).map(function (q) { return q.id; }).sort();
    return ids.indexOf(d.id) + 1;
  }
  function _jnEntries(tab) {
    const Q = G.Quests, p = _player(), L = p ? _num(p.level, 1) : 1;
    const out = [];
    if (tab === 'active') {
      let act = []; try { act = (Q && _has(Q, 'active')) ? (Q.active() || []) : []; } catch (err) { _report(err, 'Quests.active'); }
      act.forEach(function (q) { const d = _questData(q); if (d && out.indexOf(d) < 0) out.push(d); });
      if (!act.length && Q && Q.state) for (const id in Q.state) { const s = Q.state[id]; if (s && (s.status === 'active' || s.status === 'complete')) { const d = _questData(id); if (d) out.push(d); } }
    } else if (tab === 'available') {
      let ids = null;
      if (Q && _has(Q, 'availableIds')) { try { ids = Q.availableIds(); } catch (_) { ids = null; } }
      if (Array.isArray(ids)) ids.forEach(function (id) { const d = _questData(id); if (d && _num(d.level, 1) <= L + 5) out.push(d); });
      else _allQuests().forEach(function (d) {
        const st = _qstatus(d.id);
        if (st !== 'available') return;
        if (_num(d.level, 1) > L + 5) return;
        const pre = Array.isArray(d.prereq) ? d.prereq : (d.prereq ? [d.prereq] : []);
        for (let i = 0; i < pre.length; i++) if (!_qdone(pre[i])) return;
        out.push(d);
      });
    } else if (tab === 'remaining') {
      // everything still to do — active, ready, available AND locked — so the player can see the whole road ahead
      _allQuests().forEach(function (d) { if (_qstatus(d.id) !== 'done') out.push(d); });
    } else {
      _allQuests().forEach(function (d) { if (_qstatus(d.id) === 'done') out.push(d); });
    }
    return out;
  }
  /** Names of the prerequisite quests of `d` that are not done yet (unknown ids count as done, like G.Quests). */
  function _jnUnmet(d) {
    const pre = Array.isArray(d.prereq) ? d.prereq : (d.prereq ? [d.prereq] : []);
    const out = [];
    for (let i = 0; i < pre.length; i++) { const q = _questData(pre[i]); if (!q || _qdone(q.id)) continue; out.push(q.name || _title(q.id)); }
    return out;
  }
  /** Remaining-quest counts for the tab header: {left, total, story, storyTot, side, sideTot}. */
  function _jnRemaining() {
    let total = 0, done = 0, sTot = 0, sDone = 0;
    _allQuests().forEach(function (d) { total++; const dn = _qdone(d.id); if (dn) done++; if (d.type === 'story') { sTot++; if (dn) sDone++; } });
    return { left: total - done, total: total, story: sTot - sDone, storyTot: sTot, side: (total - sTot) - (done - sDone), sideTot: total - sTot };
  }
  const JN_STATUS_LABEL = { active: 'Active', complete: 'Ready', available: 'Available', locked: 'Locked', done: 'Done' };
  function _jnRow(d, tracked) {
    const st = _qstatus(d.id);
    const remaining = Jn.tab === 'remaining';
    const row = el('div', { class: 'jn-row' + (remaining ? ' rem' : '') + (Jn.selected === d.id ? ' selected' : '') + (tracked ? ' tracked' : '') + (st === 'complete' ? ' ready' : '') + (st === 'locked' ? ' locked' : ''), data: { id: d.id } });
    const ch = _chapterOf(d);
    row.appendChild(el('span', { class: 'jn-ch', text: ch ? String(ch) + '.' : '•' }));
    const nm = el('span', { class: 'jn-nm', text: d.name || _title(d.id) });
    row.appendChild(nm);
    if (Jn.tab === 'available' && d.giver) row.appendChild(el('span', { class: 'jn-giver', text: _npcName(d.giver) }));
    if (remaining) row.appendChild(el('span', { class: 'jn-st ' + st, text: JN_STATUS_LABEL[st] || _title(st) }));
    row.appendChild(el('span', { class: 'jn-lv', text: String(_num(d.level, 1)) }));
    if (tracked) row.appendChild(el('span', { class: 'jn-star', text: '★' }));
    let unmet = [];
    if (remaining) {
      // second line: zone · giver · what still locks it
      unmet = st === 'locked' ? _jnUnmet(d) : [];
      const meta = _zoneName(d.zone) + (d.giver ? ' · ' + _npcName(d.giver) : '') + (unmet.length ? ' · requires ' + unmet.join(', ') : '');
      row.appendChild(el('span', { class: 'jn-meta' + (unmet.length ? ' locked' : ''), text: meta }));
    }
    row.addEventListener('click', function () { Jn.selected = d.id; _sfx('ui_click'); Jn.refresh(); });
    _tip(row, function () {
      const req = st === 'locked' ? (unmet.length ? unmet : _jnUnmet(d)) : [];
      return '<div class="tt-name">' + esc(d.name || d.id) + '</div><div class="tt-line">' + esc((d.type === 'story' ? 'Story' : 'Side quest') + ' · Level ' + _num(d.level, 1) + ' · ' + _zoneName(d.zone)) + '</div>' +
        (st === 'complete' ? '<div class="tt-stat">Ready to turn in</div>' : st === 'active' ? '<div class="tt-stat">In progress</div>' : st === 'locked' ? '<div class="tt-stat" style="color:#d08a7a">Locked' + (req.length ? ' — requires ' + esc(req.join(', ')) : '') + '</div>' : '') +
        (d.giver ? '<div class="tt-sub">From ' + esc(_npcName(d.giver)) + '</div>' : '');
    });
    return row;
  }
  function _objProgress(d, i) {
    const o = d.objectives[i], st = _qstate(d.id);
    const count = Math.max(1, _num(o.count, 1) | 0);
    let p = st && Array.isArray(st.progress) ? _num(st.progress[i]) | 0 : 0;
    const status = _qstatus(d.id);
    if (status === 'complete' || status === 'done') p = count;
    p = clamp(p, 0, count);
    return { count: count, p: p, done: p >= count, label: o.label || _title(o.type || 'objective') };
  }
  function _rewardChips(d, chosenIdx, onChoose) {
    const r = d.rewards || {};
    const box = el('div', { class: 'jn-rewards' });
    if (r.xp) box.appendChild(el('span', { class: 'jn-reward' }, [el('span', { class: 'icon', text: '★', style: 'color:#cfa8ff' }), el('span', { text: _fmt(r.xp) + ' XP' })]));
    if (r.gold) { const g = el('span', { class: 'jn-reward' }); g.innerHTML = '<span class="icon">●</span>' + _money(r.gold); box.appendChild(g); }
    (Array.isArray(r.items) ? r.items : []).forEach(function (tid) { const inst = { tid: typeof tid === 'string' ? tid : tid.tid, count: (tid && tid.count) || 1 }; const c = el('span', { class: 'jn-reward' }); c.innerHTML = _iconHTML(inst, 28) + '<span class="rarity-' + _rarityOf(inst) + '">' + esc(_itemName(inst)) + (inst.count > 1 ? ' ×' + inst.count : '') + '</span>'; _tip(c, function () { return _itemTip(inst, _player()); }); box.appendChild(c); });
    if (r.title) box.appendChild(el('span', { class: 'jn-reward' }, [el('span', { class: 'icon', text: '❖', style: 'color:var(--gold-bright)' }), el('span', { text: 'Title: ' + _titleText(r.title, _player()) })]));
    if (r.mount) { const inst = { tid: r.mount, count: 1 }; const c = el('span', { class: 'jn-reward' }); c.innerHTML = _iconHTML(inst, 28) + '<span>Mount: ' + esc(_itemName(inst)) + '</span>'; _tip(c, function () { return _itemTip(inst, _player()); }); box.appendChild(c); }
    if (r.abilityPoints) box.appendChild(el('span', { class: 'jn-reward' }, [el('span', { class: 'icon', text: '✦' }), el('span', { text: r.abilityPoints + ' ability point' + (r.abilityPoints > 1 ? 's' : '') })]));
    const out = el('div');
    out.appendChild(box);
    if (Array.isArray(r.choose) && r.choose.length) {
      out.appendChild(el('div', { class: 'pn-sub', text: 'Choose one:' }));
      const ch = el('div', { class: 'dg-choose' });
      r.choose.forEach(function (tid, i) {
        const inst = { tid: typeof tid === 'string' ? tid : tid.tid, count: 1 };
        const c = el('div', { class: 'dg-choice' + (chosenIdx === i ? ' on' : '') });
        c.innerHTML = _iconHTML(inst, 30) + '<span class="rarity-' + _rarityOf(inst) + '">' + esc(_itemName(inst)) + '</span>';
        _tip(c, function () { return _itemTip(inst, _player()); }, { keepOnClick: true });
        if (onChoose) c.addEventListener('click', function () { onChoose(i); Array.prototype.forEach.call(ch.children, function (n, k) { n.classList.toggle('on', k === i); }); _sfx('ui_click'); });
        ch.appendChild(c);
      });
      out.appendChild(ch);
    }
    return out;
  }
  function _questDetail(d, opts) {
    opts = opts || {};
    const box = el('div');
    const st = _qstatus(d.id);
    box.appendChild(el('div', { class: 'jn-qname', text: d.name || _title(d.id) }));
    const chips = el('div', { class: 'jn-chips' }, [
      _chip(d.type === 'story' ? 'Story' : 'Side quest', d.type === 'story' ? 'story' : 'side'),
      _chip('Level ' + _num(d.level, 1)),
      _chip(_zoneName(d.zone)),
      d.type === 'story' && _bookOf(d) ? _chip(_bookOf(d) + (_chapterOf(d) ? ' · Chapter ' + _chapterOf(d) : '')) : null,
      st === 'complete' ? _chip('Ready to turn in', 'story') : st === 'done' ? _chip('Completed') : st === 'active' ? _chip('In progress') : st === 'locked' ? _chip('Locked', 'locked') : st === 'available' ? _chip('Available', 'avail') : null,
    ]);
    box.appendChild(chips);
    const who = el('div', { class: 'pn-sub' });
    who.innerHTML = (d.giver ? 'Given by <b>' + esc(_npcName(d.giver)) + '</b>' : '') + (d.turnin && d.turnin !== d.giver ? ' · Return to <b>' + esc(_npcName(d.turnin)) + '</b>' : (d.turnin ? ' · Return to the same' : ''));
    box.appendChild(who);
    if (st === 'locked') {
      // a locked quest is still readable in full — say what unlocks it
      const req = _jnUnmet(d);
      const line = el('div', { class: 'jn-req' });
      line.innerHTML = '🔒 Locked — ' + (req.length ? 'complete <b>' + req.map(esc).join('</b>, <b>') + '</b> first.' : 'not yet available.');
      box.appendChild(line);
    }
    const T = d.text || {};
    const mode = opts.mode || (st === 'complete' ? 'turnin' : st === 'done' ? 'done' : st === 'active' ? 'progress' : 'available');
    let text = T.intro || d.desc || '';
    if (mode === 'turnin' || mode === 'done') text = T.complete || text;
    else if (mode === 'progress' && !opts.fullIntro) text = (T.intro || '') + (T.progress ? '\n\n' + T.progress : '');
    if (text) { const t = el('div', { class: 'jn-text' }); text.split(/\n\n+/).forEach(function (para, i) { if (i) t.appendChild(el('br')); t.appendChild(document.createTextNode(para)); }); box.appendChild(t); }
    if (Array.isArray(d.objectives) && d.objectives.length) {
      box.appendChild(el('div', { class: 'section-title', text: 'Objectives' + (d.sequential ? ' (in order)' : '') }));
      const ol = el('div', { class: 'jn-obj' });
      d.objectives.forEach(function (o, i) {
        const pr = _objProgress(d, i);
        const showCount = pr.count > 1 || o.type === 'kill' || o.type === 'collect' || o.type === 'use' || o.type === 'fish';
        ol.appendChild(el('div', { class: 'jn-obj-row' + (pr.done ? ' done' : '') }, [el('span', { class: 'jn-obj-lbl', text: pr.label }), _bar(pr.p / pr.count, pr.done ? 'green' : 'cast', showCount ? pr.p + ' / ' + pr.count : (pr.done ? 'Done' : '—'))]));
      });
      box.appendChild(ol);
    }
    if (d.rewards) { box.appendChild(el('div', { class: 'section-title', text: 'Rewards' })); box.appendChild(_rewardChips(d, opts.chosen, opts.onChoose)); }
    return box;
  }
  function _jnDetail(d) {
    const box = _questDetail(d);
    const st = _qstatus(d.id), Q = G.Quests;
    const acts = el('div', { class: 'jn-actions' });
    if (st === 'active' || st === 'complete') {
      const tracked = Q && Q.tracked === d.id;
      acts.appendChild(_btn(tracked ? 'Untrack' : 'Track', function () { if (_has(Q, 'setTracked')) Q.setTracked(tracked ? null : d.id); else if (Q) Q.tracked = tracked ? null : d.id; if (_has(UI, 'tracker') && UI.tracker && _has(UI.tracker, 'refresh')) UI.tracker.refresh(); _sfx('ui_click'); Jn.refresh(); }, tracked ? '' : 'primary'));
      acts.appendChild(_btn('Show on map', function () { let o = null; try { o = _has(Q, 'nextObjective') ? Q.nextObjective(d.id) : null; } catch (_) { o = null; } if (o && o.pos) { _open('map'); Mp.focus(o.pos.x, o.pos.z); } else _notify('No location is known for that objective.', 'info'); }));
      acts.appendChild(_btn('Abandon', function () { _confirm('Abandon "' + (d.name || d.id) + '"? Your progress on it will be lost.', function () { if (_has(Q, 'abandon')) Q.abandon(d.id); _sfx('ui_click'); Jn.selected = null; Jn.refresh(); }, { title: 'Abandon quest', yes: 'Abandon' }); }, 'danger'));
    } else if (st === 'available') {
      const rec = _npcRec(d.giver);
      acts.appendChild(_btn('Show giver on map', function () { if (rec && rec.pos) { _setWaypoint(rec.pos.x, rec.pos.z, rec.name || 'Quest giver'); _open('map'); Mp.focus(rec.pos.x, rec.pos.z); } else _notify('The quest giver cannot be found on the map.', 'info'); }));
      if (rec && rec.town) acts.appendChild(el('span', { class: 'pn-sub', style: 'align-self:center', text: 'Found in ' + ((_town(rec.town) || {}).name || _title(rec.town)) }));
    } else if (st === 'done') {
      acts.appendChild(el('span', { class: 'pn-sub', style: 'align-self:center;color:#7fd47a', text: '✓ You have completed this quest.' }));
    }
    box.appendChild(acts);
    return box;
  }
  Jn.render = function () {
    const body = Jn.body; if (!body) return;
    if (Jn._list) Jn._scroll = Jn._list.scrollTop;
    _clear(body);
    const Q = G.Quests;
    const left = el('div', { class: 'jn-left' + (Jn.tab === 'remaining' ? ' wide' : '') });
    const tabs = el('div', { class: 'tabs' });
    [['active', 'Active'], ['available', 'Available'], ['remaining', 'Remaining'], ['completed', 'Completed']].forEach(function (t) { tabs.appendChild(el('span', { class: 'tab' + (Jn.tab === t[0] ? ' active' : ''), text: t[1], onclick: function () { Jn.setTab(t[0]); } })); });
    left.appendChild(tabs);
    if (Jn.tab === 'remaining') {
      const rc = _jnRemaining();
      const head = el('div', { class: 'jn-remhead' });
      head.innerHTML = 'Remaining: <b>' + rc.left + '</b> of ' + rc.total + ' <span class="jn-remsub">(Story ' + rc.story + '/' + rc.storyTot + ' · Side ' + rc.side + '/' + rc.sideTot + ')</span>';
      _tip(head, '<div class="tt-name">The road ahead</div><div class="tt-desc">Every quest you have not completed yet — active, available and still locked. Locked quests show what you must finish first; click any of them to read the full story, objectives and rewards.</div>');
      left.appendChild(head);
    }
    const list = el('div', { class: 'jn-list' });
    list.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
    Jn._list = list;
    const entries = _jnEntries(Jn.tab);
    const tracked = Q && Q.tracked;
    if (Jn.selected && !entries.some(function (d) { return d.id === Jn.selected; })) { if (entries.length && Jn.tab !== 'available') Jn.selected = entries[0].id; else if (entries.length) Jn.selected = entries[0].id; else Jn.selected = null; }
    if (!Jn.selected && entries.length) Jn.selected = entries[0].id;
    if (!entries.length) list.appendChild(el('div', { class: 'pn-empty', text: Jn.tab === 'active' ? 'No active quests. Look for a golden ! above the folk of Middle-earth.' : Jn.tab === 'available' ? 'No quests are available at your level right now.' : Jn.tab === 'remaining' ? 'Nothing left to do — every quest in Middle-earth is complete!' : 'You have not completed any quests yet.' }));
    else {
      const story = entries.filter(function (d) { return d.type === 'story'; }).sort(function (a, b) { return a.id < b.id ? -1 : 1; });
      const side = entries.filter(function (d) { return d.type !== 'story'; }).sort(function (a, b) { return _num(a.level) - _num(b.level) || (a.id < b.id ? -1 : 1); });
      let lastBook = null;
      story.forEach(function (d) { const b = _bookOf(d); if (b !== lastBook) { lastBook = b; list.appendChild(el('div', { class: 'jn-group', text: b || 'Story' })); } list.appendChild(_jnRow(d, tracked === d.id)); });
      const zones = {}; side.forEach(function (d) { (zones[d.zone || 'wild'] = zones[d.zone || 'wild'] || []).push(d); });
      Object.keys(zones).sort(function (a, b) { const za = _zone(a), zb = _zone(b); return (_num(za && za.level && za.level[0], 99) - _num(zb && zb.level && zb.level[0], 99)); }).forEach(function (z) { list.appendChild(el('div', { class: 'jn-group', text: 'Side quests · ' + _zoneName(z) })); zones[z].forEach(function (d) { list.appendChild(_jnRow(d, tracked === d.id)); }); });
    }
    left.appendChild(list);
    const detail = el('div', { class: 'jn-detail' });
    detail.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
    const sel = Jn.selected ? _questData(Jn.selected) : null;
    if (sel) detail.appendChild(_jnDetail(sel));
    else detail.appendChild(el('div', { class: 'pn-empty', text: 'Select a quest to read its story, objectives and rewards.' }));
    body.appendChild(el('div', { class: 'jn-cols' }, [left, detail]));
    // completion strip
    let comp = { done: 0, total: 150, pct: 0 };
    try { if (_has(Q, 'completion')) comp = Q.completion() || comp; } catch (_) { /* ignore */ }
    let sDone = 0, sTot = 0, qDone = 0, qTot = 0;
    if (comp.story && comp.side) { sDone = _num(comp.story.done); sTot = _num(comp.story.total); qDone = _num(comp.side.done); qTot = _num(comp.side.total); }
    else _allQuests().forEach(function (d) { const done = _qdone(d.id); if (d.type === 'story') { sTot++; if (done) sDone++; } else { qTot++; if (done) qDone++; } });
    if (!sTot && !qTot) { sTot = 100; qTot = 50; }
    const pct = _num(comp.pct, comp.total ? comp.done / comp.total * 100 : 0);
    const compEl = el('span', { class: 'jn-comp' });
    compEl.innerHTML = 'Quests: <b>' + _num(comp.done) + '/' + _num(comp.total, 150) + '</b> (' + pct.toFixed(1) + '%) — Story ' + sDone + '/' + sTot + ' · Side ' + qDone + '/' + qTot;
    const aqActive = !!(G.AutoQuest && G.AutoQuest.active);
    const aqBtn = _btn(aqActive ? 'Stop auto-quest' : 'Start auto-quest', function () {
      if (!G.AutoQuest) { _notify('Auto-quest is not available.', 'warning'); return; }
      if (G.AutoQuest.active) { if (_has(G.AutoQuest, 'stop')) G.AutoQuest.stop(); _notify('Auto-quest stopped.', 'info'); }
      else { if (_has(G.AutoQuest, 'start')) G.AutoQuest.start(); _notify('Auto-quest started — press B to stop.', 'quest'); }
      Jn.refresh();
    }, aqActive ? 'danger small' : 'small');
    _tip(aqBtn, '<div class="tt-name">Auto-quest (B)</div><div class="tt-desc">Lets the bot accept, complete and turn in every quest in Middle-earth, all the way to 100%.</div>');
    body.appendChild(el('div', { class: 'jn-bottom' }, [compEl, _bar(pct / 100, 'green'), aqBtn]));
    if (Jn._scroll) list.scrollTop = Jn._scroll;
  };
  Jn.setTab = function (t) { Jn.tab = (t === 'available' || t === 'completed' || t === 'remaining') ? t : 'active'; Jn._scroll = 0; _sfx('ui_click'); Jn.refresh(); };
  Jn.select = function (id) {
    if (!id) return;
    const st = _qstatus(id);
    if (Jn.tab !== 'remaining' || st === 'done') Jn.tab = (st === 'active' || st === 'complete') ? 'active' : st === 'done' ? 'completed' : st === 'locked' ? 'remaining' : 'available';
    Jn.selected = id;
    Jn.refresh();
    if (Jn.isOpen()) { const r = Jn.body && Jn.body.querySelector('.jn-row.selected'); if (r && typeof r.scrollIntoView === 'function') r.scrollIntoView({ block: 'nearest' }); }
  };
  Jn.onOpen = function (arg) { if (typeof arg === 'string') Jn.select(arg); };
  definePanel('journal', Jn, { title: 'Quest Journal', key: 'KeyJ', width: 860, height: Math.min(600, Math.max(420, _vh() - 80)), pos: 'center' });

  // ================================================================================================ MAP (M)
  const MAP_SZ = 1024, MAP_MIN_ZOOM = 0.5, MAP_MAX_ZOOM = 6;
  const MP = { pick: null, canvas: null, ctx: null, W: 0, H: 0, dpr: 1, cx: MAP_SZ / 2, cy: MAP_SZ / 2, zoom: 2, drag: null, hits: [], hover: null, wpMode: false, showAI: true, showLegend: true, t: 0, pulse: 0, dirty: true, img: null, cursor: { x: 0, z: 0, sx: 0, sy: 0, inside: false }, coordsEl: null, legendEl: null, wpBtn: null, aiBtn: null, lgBtn: null, zoneEl: null, ro: null, aiList: [], aiT: 9, hostBody: null, _bound: false, _tipShown: false };
  const Mp = {};
  const TOWN_COLOR = { hobbit: '#a6e39f', man: '#ffd54a', elf: '#bfe6ff', dwarf: '#f0c080', ruin: '#d8c8a0', camp: '#e0b890', lossoth: '#d0f0ff' };
  const POI_GLYPH = { ruin: '▲', landmark: '◆', cave: '●', camp: '▲', bridge: '═', tower: '♜', grave: '✝', lake: '≈', waterfall: '≈', shrine: '✦', dungeon: '☠' };
  function _world_() { return C.WORLD_SIZE || 4096; }
  function _w2mx(x) { const W = _world_(); return (x + W / 2) / W * MAP_SZ; }
  function _m2wx(mx) { const W = _world_(); return mx / MAP_SZ * W - W / 2; }
  function _mpSX(x) { return (_w2mx(x) - MP.cx) * MP.zoom + MP.W / 2; }
  function _mpSY(z) { return (_w2mx(z) - MP.cy) * MP.zoom + MP.H / 2; }
  function _mpWorldX(sx) { return _m2wx((sx - MP.W / 2) / MP.zoom + MP.cx); }
  function _mpWorldZ(sy) { return _m2wx((sy - MP.H / 2) / MP.zoom + MP.cy); }
  function _mpClampView() {
    MP.zoom = clamp(MP.zoom, MAP_MIN_ZOOM, MAP_MAX_ZOOM);
    const hw = MP.W / 2 / MP.zoom, hh = MP.H / 2 / MP.zoom;
    MP.cx = clamp(MP.cx, Math.min(hw, MAP_SZ / 2), Math.max(MAP_SZ - hw, MAP_SZ / 2));
    MP.cy = clamp(MP.cy, Math.min(hh, MAP_SZ / 2), Math.max(MAP_SZ - hh, MAP_SZ / 2));
  }
  function _mpResize() {
    const host = MP.hostBody; if (!host || !MP.canvas) return;
    const W = Math.max(200, host.clientWidth || 0), H = Math.max(160, host.clientHeight || 0), dpr = Math.min(2, window.devicePixelRatio || 1);
    if (W === MP.W && H === MP.H && dpr === MP.dpr) return;
    MP.W = W; MP.H = H; MP.dpr = dpr;
    MP.canvas.width = Math.round(W * dpr); MP.canvas.height = Math.round(H * dpr);
    MP.dirty = true;
  }
  function _mpZoneAt(x, z) { if (_has(G.Terrain, 'zoneAt')) { try { return G.Terrain.zoneAt(x, z); } catch (_) { /* ignore */ } } const w = _world(); if (w && _has(w, 'zoneAt')) return w.zoneAt(x, z); return ''; }
  function _mpHit(x, y, r, html, extra) { const h = { x: x, y: y, r: r, html: html }; if (extra) Object.assign(h, extra); MP.hits.push(h); return h; }
  function _mpLabel(ctx, text, x, y, font, color, align) {
    ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.lineJoin = 'round';
    ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
  }
  function _mpVisible(sx, sy, m) { m = m || 40; return sx > -m && sy > -m && sx < MP.W + m && sy < MP.H + m; }
  function _mpDrawPin(ctx, x, y, color, n, big) {
    const r = big ? 10 : 8;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.8)'; ctx.shadowBlur = 4;
    ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - r * 0.8, y - r * 1.3); ctx.arc(x, y - r * 1.6, r, Math.PI * 0.75, Math.PI * 0.25, false); ctx.lineTo(x, y); ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0; ctx.strokeStyle = 'rgba(40,25,5,.9)'; ctx.lineWidth = 1.2; ctx.stroke();
    ctx.fillStyle = '#2a1a05'; ctx.font = 'bold ' + (big ? 11 : 10) + 'px Cinzel, Georgia, serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(String(n), x, y - r * 1.6 + 0.5);
    ctx.restore();
  }
  // ---- label-free base map: painted here from G.Terrain.coarseHeight (grid lookups, cheap) + zone colours, a few rows per
  //      frame, because G.Terrain.mapCanvas bakes its own zone/town names which would double up with the panel's overlays.
  const MB = { canvas: null, ctx: null, img: null, row: 0, done: false, failed: false, size: MAP_SZ, zones: null };
  const MB_SEA = [0x1c, 0x3b, 0x66], MB_SHALLOW = [0x4a, 0x8c, 0xbc], MB_SAND = [0xdc, 0xcb, 0x9a], MB_SNOW = [0xf1, 0xf4, 0xf7], MB_ROCK = [0x8c, 0x86, 0x7a];
  function _mbPrep() {
    const w = _world(); const zs = (w && Array.isArray(w.zones)) ? w.zones : [];
    MB.zones = zs.filter(function (z) { return z && z.center; }).map(function (z) {
      const r = Math.max(50, _num(z.radius, 300)) * 1.75;
      const gc = _num(z.grassColor, 0x6fae4a), dc = _num(z.groundColor, 0x8b7a4c);
      return { x: z.center.x, z: z.center.z, r2: r * r, inv: 1 / (r * r), gr: (gc >> 16) & 255, gg: (gc >> 8) & 255, gb: gc & 255, dr: (dc >> 16) & 255, dg: (dc >> 8) & 255, db: dc & 255, mountain: _num(z.mountain), arctic: z.biome === 'arctic' ? 1 : 0, dark: z.biome === 'dark' ? 1 : 0 };
    });
    MB.canvas = document.createElement('canvas'); MB.canvas.width = MB.canvas.height = MB.size;
    MB.ctx = MB.canvas.getContext('2d');
    MB.img = MB.ctx ? MB.ctx.createImageData(MB.size, MB.size) : null;
    if (!MB.img) MB.failed = true;
  }
  function _mbFinish() {
    const ctx = MB.ctx, size = MB.size, w = _world(), sc = size / _world_(), HALF = _world_() / 2;
    ctx.putImageData(MB.img, 0, 0); MB.img = null;
    const P = function (x, z) { return [(x + HALF) * sc, (z + HALF) * sc]; };
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const rivers = (w && w.water && Array.isArray(w.water.rivers)) ? w.water.rivers : [];
    ctx.strokeStyle = '#3f7fb4';
    rivers.forEach(function (rv) {
      if (!Array.isArray(rv.points) || rv.points.length < 2) return;
      ctx.lineWidth = Math.max(1, _num(rv.width, 12) * sc * 1.2); ctx.beginPath(); let first = true;
      for (let i = 0; i + 1 < rv.points.length; i++) {
        const a = rv.points[i], b = rv.points[i + 1]; const L = Math.hypot(b.x - a.x, b.z - a.z), n = Math.max(1, Math.ceil(L / 10));
        for (let k = 0; k <= n; k++) { const t = k / n; const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t; const wx = x - 7 * G.fbm(x * 0.0083 + 31, z * 0.0083 + 17, 2, 2, 0.5), wz = z - 7 * G.fbm(x * 0.0083 - 13, z * 0.0083 + 43, 2, 2, 0.5); const q = P(wx, wz); if (first) { ctx.moveTo(q[0], q[1]); first = false; } else ctx.lineTo(q[0], q[1]); }
      }
      ctx.stroke();
    });
    const roads = (w && Array.isArray(w.roads)) ? w.roads : [];
    const drawRoads = function (style, width) { ctx.strokeStyle = style; ctx.lineWidth = width; roads.forEach(function (rd) { if (!rd || !Array.isArray(rd.points) || rd.points.length < 2) return; ctx.beginPath(); for (let i = 0; i < rd.points.length; i++) { const q = P(rd.points[i].x, rd.points[i].z); if (i === 0) ctx.moveTo(q[0], q[1]); else ctx.lineTo(q[0], q[1]); } ctx.stroke(); }); };
    drawRoads('rgba(60,40,20,0.55)', Math.max(1.2, size / 512 * 2.6));
    drawRoads('#d9c08e', Math.max(1, size / 512 * 1.5));
    MB.done = true; MP.dirty = true;
  }
  function _mpBaseStep(rows) {
    if (MB.done || MB.failed) return;
    const T = G.Terrain;
    if (!T || !_has(T, 'coarseHeight')) { MB.failed = true; return; }
    if (!MB.canvas) { _mbPrep(); if (MB.failed) return; }
    const size = MB.size, WORLD = _world_(), HALF = WORLD / 2, cell = WORLD / size, d = MB.img.data, zs = MB.zones, sea = _num(C.SEA_LEVEL, 0);
    const lx = -0.62, ly = 0.5, lz = -0.6, ss = G.smoothstep, noise = _has(G, 'noise2') ? G.noise2 : null;
    const end = Math.min(size, MB.row + Math.max(1, rows | 0));
    for (let py = MB.row; py < end; py++) {
      const z = -HALF + (py + 0.5) * cell;
      for (let px = 0; px < size; px++) {
        const x = -HALF + (px + 0.5) * cell;
        const h = T.coarseHeight(x, z);
        let r, g, b;
        if (h < sea - 0.15) {
          const t = ss(-14, -0.15, h);
          r = MB_SEA[0] + (MB_SHALLOW[0] - MB_SEA[0]) * t; g = MB_SEA[1] + (MB_SHALLOW[1] - MB_SEA[1]) * t; b = MB_SEA[2] + (MB_SHALLOW[2] - MB_SEA[2]) * t;
        } else {
          const hl = T.coarseHeight(x - cell, z), hr = T.coarseHeight(x + cell, z), hu = T.coarseHeight(x, z - cell), hd = T.coarseHeight(x, z + cell);
          let nx = (hl - hr) / (2 * cell), nz = (hu - hd) / (2 * cell);
          const nl = 1 / Math.sqrt(nx * nx + 1 + nz * nz); nx *= nl; nz *= nl; const ny = nl;
          const sl = Math.sqrt(Math.max(0, 1 - ny * ny));
          const shade = 0.55 + 0.75 * Math.max(0, nx * lx + ny * ly + nz * lz) - 0.1 * sl;
          let wr = 0, wg = 0, wb = 0, ws = 0, mount = 0, arctic = 0, dark = 0;
          const dirt = ss(0.22, 0.6, sl) * 0.75;
          for (let i = 0; i < zs.length; i++) {
            const zn = zs[i]; const dx = x - zn.x, dz = z - zn.z, d2 = dx * dx + dz * dz;
            if (d2 >= zn.r2) continue;
            const t = 1 - d2 * zn.inv, wt = t * t;
            ws += wt; mount += wt * zn.mountain; arctic += wt * zn.arctic; dark += wt * zn.dark;
            wr += (zn.gr + (zn.dr - zn.gr) * dirt) * wt; wg += (zn.gg + (zn.dg - zn.gg) * dirt) * wt; wb += (zn.gb + (zn.db - zn.gb) * dirt) * wt;
          }
          // soft normalisation: a little neutral meadow colour is always mixed in, so zone edges fade instead of cutting
          const kN = 0.18; wr += 0x62 * kN; wg += 0x8e * kN; wb += 0x44 * kN; ws += kN;
          r = wr / ws; g = wg / ws; b = wb / ws; mount /= ws; arctic /= ws; dark /= ws;
          if (noise) { const v = 1 + 0.07 * noise(x * 0.012, z * 0.012) + 0.04 * noise(x * 0.05, z * 0.05); r *= v; g *= v; b *= v; }
          const sand = ss(2.6, 0.6, h);
          if (sand > 0) { r += (MB_SAND[0] - r) * sand; g += (MB_SAND[1] - g) * sand; b += (MB_SAND[2] - b) * sand; }
          const rock = clamp(ss(0.5, 0.8, sl) * 0.65 + ss(70, 150, h) * (0.25 + mount * 0.5) + dark * 0.25, 0, 0.85);
          if (rock > 0) { r += (MB_ROCK[0] - r) * rock; g += (MB_ROCK[1] - g) * rock; b += (MB_ROCK[2] - b) * rock; }
          const snow = clamp((ss(110, 190, h) * (0.5 + mount * 0.8) + arctic * 0.75) * (1 - ss(0.6, 0.9, sl)), 0, 0.92);
          if (snow > 0) { r += (MB_SNOW[0] - r) * snow; g += (MB_SNOW[1] - g) * snow; b += (MB_SNOW[2] - b) * snow; }
          r *= shade; g *= shade; b *= shade;
        }
        const k = (py * size + px) * 4;
        d[k] = r < 0 ? 0 : r > 255 ? 255 : r; d[k + 1] = g < 0 ? 0 : g > 255 ? 255 : g; d[k + 2] = b < 0 ? 0 : b > 255 ? 255 : b; d[k + 3] = 255;
      }
    }
    MB.row = end;
    if (MB.row >= size) _mbFinish();
  }
  function _mpDraw() {
    const ctx = MP.ctx; if (!ctx || !MP.W) return;
    const p = _player(), w = _world(), Q = G.Quests, zoom = MP.zoom, dpr = MP.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MP.W, MP.H);
    ctx.fillStyle = '#0d1a26'; ctx.fillRect(0, 0, MP.W, MP.H);
    const ox = MP.W / 2 - MP.cx * zoom, oy = MP.H / 2 - MP.cy * zoom, size = MAP_SZ * zoom;
    if (!MP.img) { try { MP.img = _has(G.Terrain, 'mapCanvas') ? G.Terrain.mapCanvas(MAP_SZ) : null; } catch (_) { MP.img = null; } }
    const base = MB.done ? MB.canvas : MP.img;
    const baked = !MB.done && !!(base && base.width);            // the terrain's map carries its own labels
    if (base && base.width) { ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = zoom > 2 ? 'low' : 'high'; ctx.drawImage(base, 0, 0, base.width, base.height, ox, oy, size, size); }
    else {
      ctx.fillStyle = '#3d5a2e'; ctx.fillRect(ox, oy, size, size);
      if (w && Array.isArray(w.zones)) w.zones.forEach(function (z) { if (!z.center) return; ctx.fillStyle = 'rgba(120,150,80,.35)'; ctx.beginPath(); ctx.arc(_mpSX(z.center.x), _mpSY(z.center.z), _num(z.radius, 200) / _world_() * size, 0, Math.PI * 2); ctx.fill(); });
    }
    // map edge / vignette
    ctx.strokeStyle = 'rgba(212,175,90,.55)'; ctx.lineWidth = 2; ctx.strokeRect(ox, oy, size, size);
    const vg = ctx.createRadialGradient(MP.W / 2, MP.H / 2, Math.min(MP.W, MP.H) * 0.45, MP.W / 2, MP.H / 2, Math.max(MP.W, MP.H) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.45)'); ctx.fillStyle = vg; ctx.fillRect(0, 0, MP.W, MP.H);
    MP.hits.length = 0;
    // ---- zones
    if (w && Array.isArray(w.zones) && !baked) {
      const a = zoom < 1.6 ? 0.9 : Math.max(0.22, 0.9 - (zoom - 1.6) * 0.3);
      w.zones.forEach(function (z) {
        if (!z.center) return;
        const sx = _mpSX(z.center.x), sy = _mpSY(z.center.z);
        if (!_mpVisible(sx, sy, 120)) return;
        ctx.globalAlpha = a;
        const fs = clamp(9 + 7 * zoom, 13, 30);
        _mpLabel(ctx, (z.name || z.id).toUpperCase(), sx, sy, 'bold ' + fs + 'px Cinzel, Georgia, serif', '#f3e6c2');
        if (Array.isArray(z.level)) _mpLabel(ctx, 'Levels ' + z.level[0] + ' – ' + z.level[1], sx, sy + fs * 0.75, (fs * 0.5 + 4) + 'px "Crimson Pro", Georgia, serif', '#e0d4b0');
        ctx.globalAlpha = 1;
      });
    }
    // ---- POIs
    if (w && Array.isArray(w.pois) && zoom >= 1.1) {
      w.pois.forEach(function (o) {
        if (!o.pos) return;
        const sx = _mpSX(o.pos.x), sy = _mpSY(o.pos.z);
        if (!_mpVisible(sx, sy)) return;
        ctx.fillStyle = '#e8dcc0'; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(sx, sy - 5); ctx.lineTo(sx + 5, sy); ctx.lineTo(sx, sy + 5); ctx.lineTo(sx - 5, sy); ctx.closePath(); ctx.fill(); ctx.stroke();
        if (zoom >= 2.4) _mpLabel(ctx, o.name, sx, sy + 12, '10px "Crimson Pro", Georgia, serif', '#e8dcc0');
        _mpHit(sx, sy, 9, '<div class="tt-name">' + esc(o.name) + '</div><div class="tt-line">' + esc(_title(o.kind || 'landmark') + ' · ' + _zoneName(o.zone)) + '</div>' + (o.desc ? '<div class="tt-desc">' + esc(o.desc) + '</div>' : ''), { kind: 'poi', wx: o.pos.x, wz: o.pos.z, name: o.name });
      });
    }
    // ---- fishing spots
    if (w && Array.isArray(w.fishingSpots) && zoom >= 1.5) {
      w.fishingSpots.forEach(function (s) {
        if (!s.pos) return;
        const sx = _mpSX(s.pos.x), sy = _mpSY(s.pos.z);
        if (!_mpVisible(sx, sy)) return;
        _mpLabel(ctx, '🐟', sx, sy, '11px sans-serif', '#8fd0ff');
        const fish = Array.isArray(s.fish) ? s.fish.map(function (f) { return _itemName({ tid: f.tid, count: 1 }); }).slice(0, 4).join(', ') : '';
        _mpHit(sx, sy, 8, '<div class="tt-name">' + esc(s.name) + '</div><div class="tt-line">Fishing spot · ' + esc(_zoneName(s.zone)) + '</div>' + (fish ? '<div class="tt-desc">' + esc(fish) + '</div>' : ''), { kind: 'fish', wx: s.pos.x, wz: s.pos.z, name: s.name });
      });
    }
    // ---- docks
    if (w && Array.isArray(w.docks)) {
      w.docks.forEach(function (d) {
        if (!d.pos) return;
        const sx = _mpSX(d.pos.x), sy = _mpSY(d.pos.z);
        if (!_mpVisible(sx, sy)) return;
        _mpLabel(ctx, '⚓', sx, sy, 'bold 13px sans-serif', '#7fe0ff');
        const routes = Array.isArray(d.routes) ? d.routes.map(function (id) { const t = _dock(id); return t ? t.name : id; }).join(', ') : '';
        _mpHit(sx, sy, 9, '<div class="tt-name">' + esc(d.name) + '</div><div class="tt-line">Dock · ' + esc((_town(d.town) || {}).name || _title(d.town || '')) + '</div>' + (routes ? '<div class="tt-desc">Sails to: ' + esc(routes) + '</div>' : ''), { kind: 'dock', wx: d.pos.x, wz: d.pos.z, name: d.name });
      });
    }
    // ---- towns
    if (w && Array.isArray(w.towns)) {
      w.towns.forEach(function (t) {
        if (!t.pos) return;
        const sx = _mpSX(t.pos.x), sy = _mpSY(t.pos.z);
        if (!_mpVisible(sx, sy, 80)) return;
        const col = TOWN_COLOR[t.style] || '#ffd54a';
        ctx.fillStyle = col; ctx.strokeStyle = 'rgba(0,0,0,.85)'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(sx, sy, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        ctx.strokeStyle = col; ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.arc(sx, sy, 7.5, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1;
        if (zoom >= 0.75 && !baked) _mpLabel(ctx, t.name, sx, sy - 12, 'bold ' + clamp(9 + zoom * 1.5, 11, 14) + 'px Cinzel, Georgia, serif', '#fff3c4');
        const feats = []; if (t.hasStable) feats.push('stable'); if (t.hasInn) feats.push('inn'); if (t.hasDock) feats.push('dock');
        _mpHit(sx, sy, 11, '<div class="tt-name">' + esc(t.name) + '</div><div class="tt-line">' + esc(_title(t.style || 'town') + ' settlement · ' + _zoneName(t.zone)) + '</div>' + (feats.length ? '<div class="tt-stat">' + esc(feats.join(' · ')) + '</div>' : '') + '<div class="tt-sub">Shift-click to set a waypoint</div>', { kind: 'town', wx: t.pos.x, wz: t.pos.z, name: t.name });
      });
    }
    // ---- custom places (admin)
    const places = (G.state && Array.isArray(G.state.customPlaces)) ? G.state.customPlaces : (Array.isArray(UI.customPlaces) ? UI.customPlaces : null);
    if (places) places.forEach(function (c) {
      const cx = c.x != null ? c.x : (c.pos && c.pos.x), cz = c.z != null ? c.z : (c.pos && c.pos.z);
      if (typeof cx !== 'number') return;
      const sx = _mpSX(cx), sy = _mpSY(cz);
      if (!_mpVisible(sx, sy)) return;
      _mpLabel(ctx, c.icon || '⚑', sx, sy - 6, 'bold 14px sans-serif', '#d08cff');
      _mpLabel(ctx, c.name || 'Place', sx, sy + 9, '10px "Crimson Pro", Georgia, serif', '#e8d0ff');
      _mpHit(sx, sy, 9, '<div class="tt-name">' + esc(c.name || 'Custom place') + '</div><div class="tt-line">' + Math.round(cx) + ', ' + Math.round(cz) + '</div><div class="tt-sub">Added through the admin panel</div>', { kind: 'place', wx: cx, wz: cz, name: c.name });
    });
    // ---- quest-giver NPCs
    if (w && Array.isArray(w.npcs) && zoom >= 2.5) {
      w.npcs.forEach(function (n) {
        if (!n.pos || !Array.isArray(n.roles) || n.roles.indexOf('questgiver') < 0) return;
        const sx = _mpSX(n.pos.x), sy = _mpSY(n.pos.z);
        if (!_mpVisible(sx, sy)) return;
        let mark = '';
        try { if (Q && _has(Q, 'turnins') && (Q.turnins(n.id) || []).length) mark = '?'; else if (Q && _has(Q, 'available') && (Q.available(n.id) || []).length) mark = '!'; } catch (_) { mark = ''; }
        ctx.fillStyle = '#ffe86b'; ctx.strokeStyle = 'rgba(0,0,0,.8)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        if (mark) _mpLabel(ctx, mark, sx, sy - 9, 'bold 14px Cinzel, Georgia, serif', '#ffe86b');
        _mpHit(sx, sy, 7, '<div class="tt-name">' + esc(n.name) + '</div>' + (n.title ? '<div class="tt-sub">' + esc(n.title) + '</div>' : '') + '<div class="tt-line">Quest-giver' + (mark === '!' ? ' · <span class="tt-key">has a quest for you</span>' : mark === '?' ? ' · <span class="tt-key">waiting for your report</span>' : '') + '</div>', { kind: 'npc', wx: n.pos.x, wz: n.pos.z, name: n.name });
      });
    }
    // ---- AI players
    if (MP.showAI && MP.aiList.length) {
      ctx.fillStyle = '#5aa0ff'; ctx.strokeStyle = 'rgba(0,0,0,.7)'; ctx.lineWidth = 0.8;
      MP.aiList.forEach(function (a) {
        const ap = a.pos; if (!ap || typeof ap.x !== 'number') return;
        const sx = _mpSX(ap.x), sy = _mpSY(ap.z);
        if (!_mpVisible(sx, sy, 6)) return;
        ctx.beginPath(); ctx.arc(sx, sy, 2.2, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        if (zoom >= 1.5) _mpHit(sx, sy, 5, '<div class="tt-name">' + esc(a.name || 'Adventurer') + '</div><div class="tt-line">Level ' + _num(a.level, 1) + ' ' + esc(((_race(a.race) || {}).name || _title(a.race || '')) + ' ' + ((_cls(a.cls) || {}).name || _title(a.cls || ''))) + '</div>' + (a.state ? '<div class="tt-sub">' + esc(_title(a.state)) + '</div>' : ''), { kind: 'ai', wx: ap.x, wz: ap.z, name: a.name, id: a.id });
      });
    }
    // ---- quest objectives
    const px = p && p.pos ? p.pos.x : 0, pz = p && p.pos ? p.pos.z : 0, psx = _mpSX(px), psy = _mpSY(pz);
    if (Q && _has(Q, 'nextObjective')) {
      let act = []; try { act = _has(Q, 'active') ? (Q.active() || []) : []; } catch (_) { act = []; }
      const tracked = Q.tracked;
      let n = 0;
      const pins = [];
      act.forEach(function (q) {
        const id = _questId(q); if (!id) return;
        let o = null; try { o = Q.nextObjective(id); } catch (_) { o = null; }
        if (!o || !o.pos) return;
        n++;
        pins.push({ id: id, o: o, n: n, tracked: id === tracked });
      });
      pins.forEach(function (pin) {
        const sx = _mpSX(pin.o.pos.x), sy = _mpSY(pin.o.pos.z);
        const d = _questData(pin.id);
        if (pin.tracked) {
          ctx.save(); ctx.setLineDash([4, 5]); ctx.lineDashOffset = -(_now() * 20) % 9; ctx.strokeStyle = 'rgba(255,213,74,.85)'; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(psx, psy); ctx.lineTo(sx, sy); ctx.stroke(); ctx.restore();
          ctx.save(); ctx.globalAlpha = 0.6 * (1 - MP.pulse); ctx.strokeStyle = '#ffd54a'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx, sy, 8 + MP.pulse * 16, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
        }
        if (!_mpVisible(sx, sy)) return;
        _mpDrawPin(ctx, sx, sy, pin.tracked ? '#ffe08a' : '#d4af5a', pin.n, pin.tracked);
        const dist = Math.round(G.dist2 ? G.dist2(px, pz, pin.o.pos.x, pin.o.pos.z) : 0);
        _mpHit(sx, sy - 12, 12, '<div class="tt-name">' + esc((d && d.name) || _title(pin.id)) + '</div><div class="tt-line">' + esc(pin.o.label || 'Next objective') + '</div><div class="tt-stat">' + (pin.tracked ? 'Tracked · ' : '') + dist + ' m away</div><div class="tt-sub">Click to track this quest</div>', { kind: 'quest', wx: pin.o.pos.x, wz: pin.o.pos.z, name: d && d.name, questId: pin.id });
      });
    }
    // ---- waypoint
    const wp = _waypoint();
    if (wp) {
      const sx = _mpSX(wp.x), sy = _mpSY(wp.z);
      if (_mpVisible(sx, sy)) {
        ctx.save(); ctx.setLineDash([2, 4]); ctx.strokeStyle = 'rgba(95,224,255,.6)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(psx, psy); ctx.lineTo(sx, sy); ctx.stroke(); ctx.restore();
        _mpLabel(ctx, '⚑', sx + 1, sy - 7, 'bold 18px sans-serif', '#5fe0ff');
        ctx.fillStyle = '#5fe0ff'; ctx.beginPath(); ctx.arc(sx, sy, 2.5, 0, Math.PI * 2); ctx.fill();
        _mpHit(sx, sy - 6, 10, '<div class="tt-name">' + esc(wp.label || 'Waypoint') + '</div><div class="tt-line">' + Math.round(wp.x) + ', ' + Math.round(wp.z) + ' · ' + Math.round(G.dist2 ? G.dist2(px, pz, wp.x, wp.z) : 0) + ' m</div><div class="tt-sub">Right-click the map to clear</div>', { kind: 'wp', wx: wp.x, wz: wp.z, name: 'Waypoint' });
      }
    }
    // ---- player arrow
    if (p && p.pos) {
      ctx.save(); ctx.translate(psx, psy); ctx.rotate(-_num(p.yaw, 0));
      ctx.shadowColor = '#000'; ctx.shadowBlur = 5;
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(0, -11); ctx.lineTo(8, 8); ctx.lineTo(0, 4); ctx.lineTo(-8, 8); ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0; ctx.strokeStyle = '#3a2b14'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.restore();
      ctx.save(); ctx.globalAlpha = 0.35 * (1 - MP.pulse) + 0.1; ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(psx, psy, 12 + MP.pulse * 10, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      _mpHit(psx, psy, 12, '<div class="tt-name">' + esc(p.name || 'You') + '</div><div class="tt-line">Level ' + _num(p.level, 1) + ' · ' + esc(_zoneName(G.state && G.state.zone)) + '</div><div class="tt-line">' + Math.round(px) + ', ' + Math.round(pz) + '</div>', { kind: 'me', wx: px, wz: pz, name: 'You' });
    }
    // ---- hover ring
    if (MP.hover) { ctx.save(); ctx.strokeStyle = 'rgba(255,224,138,.9)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(MP.hover.x, MP.hover.y, MP.hover.r + 3, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
    // ---- scale bar
    const metres = zoom >= 4 ? 100 : zoom >= 2 ? 250 : zoom >= 1 ? 500 : 1000;
    const barPx = metres / _world_() * MAP_SZ * zoom;
    const bx = MP.W - 24 - barPx, by = MP.H - ((MP.showLegend && MP.legendEl && !MP.legendEl.hidden) ? MP.legendEl.offsetHeight + 24 : 26);
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(bx - 6, by - 14, barPx + 12, 22);
    ctx.fillStyle = '#e8dcc0'; ctx.fillRect(bx, by, barPx, 3);
    ctx.fillRect(bx, by - 4, 1.5, 7); ctx.fillRect(bx + barPx - 1.5, by - 4, 1.5, 7);
    _mpLabel(ctx, metres >= 1000 ? (metres / 1000) + ' km' : metres + ' m', bx + barPx / 2, by - 7, '10px "Crimson Pro", Georgia, serif', '#e8dcc0');
    MP.dirty = false;
  }
  function _mpFindHit(sx, sy) {
    let best = null, bd = 1e9;
    for (let i = MP.hits.length - 1; i >= 0; i--) { const h = MP.hits[i]; const dx = h.x - sx, dy = h.y - sy, d = dx * dx + dy * dy; if (d <= (h.r + 2) * (h.r + 2) && d < bd) { bd = d; best = h; } }
    return best;
  }
  function _mpUpdateCoords() {
    if (!MP.coordsEl) return;
    const p = _player();
    let x, z, label;
    if (MP.cursor.inside) { x = MP.cursor.x; z = MP.cursor.z; label = 'Cursor'; } else if (p && p.pos) { x = p.pos.x; z = p.pos.z; label = 'You'; } else { x = 0; z = 0; label = ''; }
    const zn = _zoneName(_mpZoneAt(x, z));
    MP.coordsEl.innerHTML = esc(label) + ' <b>' + Math.round(x) + ', ' + Math.round(z) + '</b> · ' + esc(zn) + ' · zoom ×' + MP.zoom.toFixed(1) + (MP.pick ? ' · <span class="pn-gold">click a spot on the map</span>' : MP.wpMode ? ' · <span class="pn-gold">click to place a waypoint</span>' : '');
  }
  function _mpSetWpMode(on) { MP.wpMode = !!on; if (MP.wpBtn) MP.wpBtn.classList.toggle('on', MP.wpMode); if (MP.canvas) MP.canvas.classList.toggle('wp', MP.wpMode); _mpUpdateCoords(); }
  function _mpBind() {
    if (MP._bound || !MP.canvas) return;
    MP._bound = true;
    const cv = MP.canvas;
    const local = function (ev) { const r = cv.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    cv.addEventListener('pointerdown', function (ev) {
      if (ev.button !== 0) return;
      const l = local(ev);
      MP.drag = { sx: l.x, sy: l.y, cx: MP.cx, cy: MP.cy, moved: false, shift: ev.shiftKey };
      try { cv.setPointerCapture(ev.pointerId); } catch (_) { /* ignore */ }
      cv.classList.add('panning');
      ev.preventDefault();
    });
    cv.addEventListener('pointermove', function (ev) {
      const l = local(ev);
      MP.cursor.sx = l.x; MP.cursor.sy = l.y; MP.cursor.x = _mpWorldX(l.x); MP.cursor.z = _mpWorldZ(l.y); MP.cursor.inside = true;
      if (MP.drag) {
        const dx = l.x - MP.drag.sx, dy = l.y - MP.drag.sy;
        if (!MP.drag.moved && dx * dx + dy * dy > 9) MP.drag.moved = true;
        if (MP.drag.moved) { MP.cx = MP.drag.cx - dx / MP.zoom; MP.cy = MP.drag.cy - dy / MP.zoom; _mpClampView(); _tipHide(); MP._tipShown = false; MP.hover = null; }
      } else {
        const h = _mpFindHit(l.x, l.y);
        if (h !== MP.hover) { MP.hover = h; if (h) { if (UI.tooltip) UI.tooltip.show(h.html, ev.clientX, ev.clientY); MP._tipShown = true; } else if (MP._tipShown) { _tipHide(); MP._tipShown = false; } }
        else if (h && UI.tooltip && _has(UI.tooltip, 'move')) UI.tooltip.move(ev.clientX, ev.clientY);
      }
      _mpUpdateCoords();
      MP.dirty = true;
    });
    const up = function (ev) {
      if (!MP.drag) return;
      const d = MP.drag; MP.drag = null; cv.classList.remove('panning');
      if (!d.moved) {
        const l = local(ev);
        const h = _mpFindHit(l.x, l.y);
        if (MP.pick) { const cb = MP.pick; MP.pick = null; if (MP.canvas) MP.canvas.classList.remove('wp'); _mpUpdateCoords(); _sfx('ui_click'); try { cb({ x: _mpWorldX(l.x), z: _mpWorldZ(l.y) }); } catch (err) { _report(err, 'map pick'); } }
        else if (MP.wpMode || ev.shiftKey || d.shift) { const wx = _mpWorldX(l.x), wz = _mpWorldZ(l.y); _setWaypoint(wx, wz, h && h.name && h.kind !== 'me' ? h.name : 'Map waypoint'); _mpSetWpMode(false); _sfx('ui_click'); }
        else if (h && h.kind === 'quest' && h.questId && _has(G.Quests, 'setTracked')) { G.Quests.setTracked(h.questId); if (UI.tracker && _has(UI.tracker, 'refresh')) UI.tracker.refresh(); _sfx('ui_click'); }
        else if (h && h.kind === 'ai' && h.id) { Pl.select(h.id); }
      }
      MP.dirty = true;
    };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', function () { MP.drag = null; cv.classList.remove('panning'); });
    cv.addEventListener('pointerleave', function () { MP.cursor.inside = false; if (!MP.drag) { MP.hover = null; if (MP._tipShown) { _tipHide(); MP._tipShown = false; } } _mpUpdateCoords(); MP.dirty = true; });
    cv.addEventListener('wheel', function (ev) {
      ev.preventDefault(); ev.stopPropagation();
      const l = local(ev);
      Mp.zoomAt(MP.zoom * (ev.deltaY < 0 ? 1.2 : 1 / 1.2), l.x, l.y);
    }, { passive: false });
    cv.addEventListener('dblclick', function (ev) { const l = local(ev); Mp.zoomAt(MP.zoom * 1.6, l.x, l.y); });
    cv.addEventListener('contextmenu', function (ev) { ev.preventDefault(); ev.stopPropagation(); if (_waypoint()) { _clearWaypoint(); _notify('Waypoint cleared.', 'info'); MP.dirty = true; } });
  }
  Mp.zoomAt = function (z, sx, sy) {
    z = clamp(_num(z, MP.zoom), MAP_MIN_ZOOM, MAP_MAX_ZOOM);
    if (sx == null) { sx = MP.W / 2; sy = MP.H / 2; }
    const mx = (sx - MP.W / 2) / MP.zoom + MP.cx, my = (sy - MP.H / 2) / MP.zoom + MP.cy;
    MP.zoom = z;
    MP.cx = mx - (sx - MP.W / 2) / z; MP.cy = my - (sy - MP.H / 2) / z;
    _mpClampView(); MP.dirty = true; _mpUpdateCoords();
  };
  Mp.setZoom = function (z) { Mp.zoomAt(z); };
  Object.defineProperty(Mp, 'zoom', { get: function () { return MP.zoom; }, set: function (z) { Mp.zoomAt(z); } });
  Object.defineProperty(Mp, 'showAI', { get: function () { return MP.showAI; }, set: function (v) { MP.showAI = !!v; if (MP.aiBtn) MP.aiBtn.classList.toggle('on', MP.showAI); MP.dirty = true; } });
  Object.defineProperty(Mp, 'showLegend', { get: function () { return MP.showLegend; }, set: function (v) { MP.showLegend = !!v; if (MP.legendEl) MP.legendEl.hidden = !MP.showLegend; if (MP.lgBtn) MP.lgBtn.classList.toggle('on', MP.showLegend); MP.dirty = true; } });
  Mp.centerOn = function (x, z) { if (!isFinite(x) || !isFinite(z)) return; MP.cx = _w2mx(x); MP.cy = _w2mx(z); _mpClampView(); MP.dirty = true; };
  Mp.focus = function (x, z, zoom) { Mp.centerOn(x, z); if (zoom != null) Mp.zoomAt(zoom); else if (MP.zoom < 2.5) Mp.zoomAt(3); Mp.centerOn(x, z); };
  Mp.centerOnPlayer = function () { const p = _player(); if (p && p.pos) Mp.centerOn(p.pos.x, p.pos.z); };
  Mp.setWaypointMode = function (on) { _mpSetWpMode(on); };
  // pickOnce(cb): the next click on the map calls cb({x, z}) with world coordinates (used by the admin panel's teleport).
  Mp.pickOnce = function (cb) { MP.pick = typeof cb === 'function' ? cb : null; if (MP.canvas) MP.canvas.classList.toggle('wp', !!MP.pick); if (!Mp.isOpen()) _open('map'); _mpUpdateCoords(); return true; };
  Mp.cancelPick = function () { MP.pick = null; if (MP.canvas) MP.canvas.classList.remove('wp'); _mpUpdateCoords(); };
  Mp.worldAt = function (clientX, clientY) { if (!MP.canvas) return null; const r = MP.canvas.getBoundingClientRect(); return { x: _mpWorldX(clientX - r.left), z: _mpWorldZ(clientY - r.top) }; };
  Mp.render = function () {
    const body = Mp.body; if (!body) return;
    _clear(body);
    MP.hostBody = body;
    if (!MP.canvas) { MP.canvas = el('canvas', { class: 'map-canvas' }); MP.ctx = MP.canvas.getContext('2d'); }
    body.appendChild(MP.canvas);
    _mpBind();
    const tools = el('div', { class: 'map-tools' });
    const centre = _btn('⌖ Centre on me', function () { Mp.centerOnPlayer(); _sfx('ui_click'); });
    MP.wpBtn = _btn('⚑ Set waypoint', function () { _mpSetWpMode(!MP.wpMode); _sfx('ui_click'); });
    MP.wpBtn.classList.toggle('on', MP.wpMode);
    _tip(MP.wpBtn, '<div class="tt-name">Custom waypoint</div><div class="tt-line">Click the map to place a marker that shows on your compass and minimap. Shift-click works any time; right-click clears it.</div>');
    MP.aiBtn = _btn('● Players', function () { Mp.showAI = !MP.showAI; _sfx('ui_click'); });
    MP.aiBtn.classList.toggle('on', MP.showAI);
    _tip(MP.aiBtn, '<div class="tt-name">Other adventurers</div><div class="tt-line">Show the blue dots of every player in Middle-earth.</div>');
    MP.lgBtn = _btn('☰ Legend', function () { Mp.showLegend = !MP.showLegend; _sfx('ui_click'); });
    MP.lgBtn.classList.toggle('on', MP.showLegend);
    tools.appendChild(centre); tools.appendChild(MP.wpBtn); tools.appendChild(MP.aiBtn); tools.appendChild(MP.lgBtn);
    body.appendChild(tools);
    body.appendChild(el('div', { class: 'map-zoom' }, [_btn('+', function () { Mp.zoomAt(MP.zoom * 1.4); }), _btn('−', function () { Mp.zoomAt(MP.zoom / 1.4); })]));
    MP.coordsEl = el('div', { class: 'map-coords' }); body.appendChild(MP.coordsEl);
    const lg = el('div', { class: 'map-legend' });
    lg.appendChild(el('div', { class: 'lg-title', text: 'Legend' }));
    [['<i style="color:#fff">▲</i>', 'You'], ['<i style="color:#ffd54a">●</i>', 'Town / village'], ['<i style="color:#e8dcc0">◆</i>', 'Point of interest'], ['<i style="color:#7fe0ff">⚓</i>', 'Dock'], ['<i style="color:#8fd0ff">🐟</i>', 'Fishing spot'],
      ['<i style="color:#ffe08a">❶</i>', 'Quest objective'], ['<i style="color:#ffe86b;font-weight:700">!</i>', 'Quest available'], ['<i style="color:#5fe0ff">⚑</i>', 'Waypoint'], ['<i style="color:#5aa0ff">●</i>', 'Other players'], ['<i style="color:#d08cff">⚑</i>', 'Custom place']].forEach(function (r) { const d = el('div', { class: 'lg' }); d.innerHTML = r[0] + ' ' + esc(r[1]); lg.appendChild(d); });
    lg.hidden = !MP.showLegend;
    MP.legendEl = lg; body.appendChild(lg);
    MP.zoneEl = el('div', { class: 'map-title-zone', text: 'Middle-earth' }); body.appendChild(MP.zoneEl);
    if (!MP.ro && typeof ResizeObserver === 'function') { MP.ro = new ResizeObserver(function () { _mpResize(); }); MP.ro.observe(body); }
    _mpResize();
    _mpUpdateCoords();
    MP.dirty = true;
  };
  Mp.prewarm = function (rows) { let guard = 0; while (!MB.done && !MB.failed && guard++ < 4096) _mpBaseStep(rows || MAP_SZ); return MB.done; };
  Object.defineProperty(Mp, 'baseReady', { get: function () { return MB.done; } });
  Mp.update = function (dt) {
    if (!Mp.isOpen()) return;
    if (!MB.done && !MB.failed) _mpBaseStep(40);
    _mpResize();
    MP.t += dt; MP.aiT += dt;
    MP.pulse = (Math.sin(_now() * 3.2) + 1) * 0.5;
    if (MP.aiT >= 1) { MP.aiT = 0; let l = []; try { l = (MP.showAI && _has(G.AIPlayers, 'list')) ? (G.AIPlayers.list() || []) : []; } catch (_) { l = []; } MP.aiList = l; }
    if (MP.zoneEl) { const p = _player(); const zn = _zoneName((G.state && G.state.zone) || (p && p.pos ? _mpZoneAt(p.pos.x, p.pos.z) : '')); if (MP.zoneEl.textContent !== zn) MP.zoneEl.textContent = zn; }
    if (MP.dirty || MP.t >= 0.08) { MP.t = 0; _mpDraw(); if (!MP.cursor.inside) _mpUpdateCoords(); }
  };
  Mp.onOpen = function () {
    MP.aiT = 9; MP.t = 9;
    setTimeout(function () { _mpResize(); Mp.centerOnPlayer(); MP.dirty = true; if (Mp.isOpen()) _mpDraw(); }, 0);
    _mpResize(); Mp.centerOnPlayer(); _mpDraw();
  };
  Mp.onClose = function () { MP.drag = null; MP.hover = null; MP.pick = null; if (MP._tipShown) { _tipHide(); MP._tipShown = false; } _mpSetWpMode(false); };
  definePanel('map', Mp, { title: 'Map of Middle-earth', key: 'KeyM', width: '90vw', height: '85vh', pos: 'center', remember: false });

  // ================================================================================================ PLAYERS (P)
  const PL = { sort: 'level', dir: -1, query: '', selected: null, rows: new Map(), tbody: null, detailEl: null, countEl: null, searchEl: null, t: 0, list: [], detailSig: '', ths: {} };
  const Pl = {};
  const PL_COLS = [['name', 'Name'], ['race', 'Race'], ['cls', 'Class'], ['level', 'Level'], ['zone', 'Zone'], ['state', 'State']];
  function _plEntries() {
    const out = [], p = _player();
    if (p) out.push({ id: p.id || 'player', name: p.name || 'You', race: p.race, cls: p.cls, gender: p.gender, level: _num(p.level, 1), zone: (G.state && G.state.zone) || '', state: 'you', pos: p.pos, me: true });
    let list = [];
    try { list = _has(G.AIPlayers, 'list') ? (G.AIPlayers.list() || []) : []; } catch (err) { _report(err, 'AIPlayers.list'); }
    for (let i = 0; i < list.length; i++) {
      const a = list[i]; if (!a) continue;
      const st = a.state || a.activity || (a.ai && a.ai.state) || 'idle';
      out.push({ id: a.id || ('ai_' + a.name), name: a.name || 'Adventurer', race: a.race, cls: a.cls, gender: a.gender, level: _num(a.level, 1), zone: a.zone || (a.pos && _mpZoneAt(a.pos.x, a.pos.z)) || '', state: typeof st === 'string' ? st : _str(st), pos: a.pos, me: false, src: a });
    }
    return out;
  }
  function _plCells(e) {
    return { name: e.name, race: (_race(e.race) || {}).name || _title(e.race || ''), cls: (_cls(e.cls) || {}).name || _title(e.cls || ''), level: String(e.level), zone: _zoneName(e.zone), state: e.me ? 'You' : _title(e.state || '') };
  }
  function _plSorted(list) {
    const col = PL.sort, dir = PL.dir;
    const q = PL.query.trim().toLowerCase();
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i]; e.cells = _plCells(e);
      if (q) { const c = e.cells; if ((c.name + ' ' + c.race + ' ' + c.cls + ' ' + c.zone + ' ' + c.state).toLowerCase().indexOf(q) < 0) continue; }
      out.push(e);
    }
    out.sort(function (a, b) {
      let r;
      if (col === 'level') r = a.level - b.level; else r = String(a.cells[col] || '').localeCompare(String(b.cells[col] || ''));
      if (r === 0) r = a.name.localeCompare(b.name);
      return r * dir;
    });
    return out;
  }
  function _plFill() {
    if (!PL.tbody) return;
    PL.list = _plEntries();
    const sorted = _plSorted(PL.list);
    const seen = new Set();
    let frag = document.createDocumentFragment();
    sorted.forEach(function (e) {
      seen.add(e.id);
      let r = PL.rows.get(e.id);
      if (!r) {
        r = { tr: el('tr', { data: { id: e.id } }), tds: {} };
        PL_COLS.forEach(function (c) { const td = el('td', { class: c[0] === 'level' ? 'lv' : c[0] === 'state' ? 'st' : '' }); r.tds[c[0]] = td; r.tr.appendChild(td); });
        if (e.me) r.tr.classList.add('me');
        (function (id) { r.tr.addEventListener('click', function () { Pl.select(id); }); })(e.id);
        PL.rows.set(e.id, r);
      }
      PL_COLS.forEach(function (c) { const v = e.cells[c[0]]; if (r.tds[c[0]].textContent !== v) r.tds[c[0]].textContent = v; });
      r.tr.classList.toggle('selected', PL.selected === e.id);
      frag.appendChild(r.tr);
    });
    PL.rows.forEach(function (r, id) { if (!seen.has(id)) { if (r.tr.parentNode) r.tr.parentNode.removeChild(r.tr); PL.rows.delete(id); } });
    PL.tbody.appendChild(frag);
    if (PL.countEl) PL.countEl.textContent = sorted.length + ' of ' + PL.list.length + ' adventurers';
    for (const k in PL.ths) { const th = PL.ths[k]; th.classList.toggle('sorted', PL.sort === k); const arr = th.querySelector('.arr'); if (arr) arr.textContent = PL.sort === k ? (PL.dir > 0 ? '▲' : '▼') : ''; }
  }
  function _plInspect(id) {
    const e = PL.list.find(function (x) { return x.id === id; }) || null;
    if (e && e.me) {
      const p = _player();
      return { me: true, id: id, name: p.name, race: p.race, cls: p.cls, gender: p.gender, level: p.level, xp: p.xp, zone: G.state.zone, pos: p.pos, state: 'you', stats: p.stats, equipment: p.equipment, fellowship: [], kills: G.state.stats && G.state.stats.kills };
    }
    let d = null;
    if (_has(G.AIPlayers, 'inspect')) { try { d = G.AIPlayers.inspect(id); } catch (err) { _report(err, 'AIPlayers.inspect'); } }
    if (!d && e) d = Object.assign({}, e.src || {}, { name: e.name, race: e.race, cls: e.cls, gender: e.gender, level: e.level, zone: e.zone, pos: e.pos, state: e.state });
    return d;
  }
  function _plDetail(force) {
    const box = PL.detailEl; if (!box) return;
    const id = PL.selected;
    if (!id) { if (PL.detailSig !== 'none') { PL.detailSig = 'none'; _clear(box); box.appendChild(el('div', { class: 'pn-empty', text: 'Select an adventurer to inspect them.' })); } return; }
    const d = _plInspect(id);
    if (!d) { if (PL.detailSig !== 'gone') { PL.detailSig = 'gone'; _clear(box); box.appendChild(el('div', { class: 'pn-empty', text: 'That adventurer has wandered off.' })); } return; }
    let eqSig = ''; if (d.equipment) for (const k in d.equipment) eqSig += d.equipment[k] ? (d.equipment[k].uid || d.equipment[k].tid) : '-';
    const sig = id + '|' + d.level + '|' + d.zone + '|' + d.state + '|' + (d.pos ? Math.round(_num(d.pos.x) / 5) + ',' + Math.round(_num(d.pos.z) / 5) : '') + '|' + Math.round(_num(d.xp) / 50) + '|' + eqSig + '|' + (Array.isArray(d.fellowship) ? d.fellowship.length : 0) + '|' + _adminMode();
    if (!force && sig === PL.detailSig) return;
    PL.detailSig = sig;
    _clear(box);
    const cd = _cls(d.cls), rd = _race(d.race);
    box.appendChild(el('div', { class: 'pl-dhead' }, [
      el('div', { class: 'pl-glyph', text: (cd && cd.icon) || '🧝', style: { borderColor: cd ? _hex(cd.color) : '', color: cd ? _hex(cd.color) : '' } }),
      el('div', { class: 'pn-grow' }, [el('div', { class: 'pl-dname', text: d.name || 'Adventurer' }), el('div', { class: 'pl-dsub', text: 'Level ' + _num(d.level, 1) + ' ' + (d.gender === 'female' ? 'Female ' : d.gender === 'male' ? 'Male ' : '') + ((rd && rd.name) || _title(d.race || '')) + ' ' + ((cd && cd.name) || _title(d.cls || '')) })]),
    ]));
    let prog = null;
    if (d.xp != null && G.Data && G.Data.xp && _has(G.Data.xp, 'progress')) { try { prog = G.Data.xp.progress(d.xp); } catch (_) { prog = null; } }
    if (prog) box.appendChild(el('div', { class: 'ch-xp' }, [el('span', { text: 'XP' }), _bar(prog.capped ? 1 : _num(prog.pct) / 100, 'xp', prog.capped ? 'Level cap' : _fmt(Math.round(prog.into)) + ' / ' + _fmt(Math.round(prog.need)))]));
    const loc = el('div', { class: 'pn-sub', style: 'margin:4px 0' });
    loc.innerHTML = '<b>' + esc(_zoneName(d.zone)) + '</b>' + (d.pos && typeof d.pos.x === 'number' ? ' · ' + Math.round(d.pos.x) + ', ' + Math.round(d.pos.z) : '') + ' · ' + esc(d.me ? 'That is you' : _title(d.state || 'idle'));
    box.appendChild(loc);
    const fel = Array.isArray(d.fellowship) ? d.fellowship : [];
    box.appendChild(el('div', { class: 'section-title', text: 'Fellowship' }));
    if (!fel.length) box.appendChild(el('div', { class: 'pn-sub', text: d.me ? 'You travel alone.' : 'Travelling alone.' }));
    else { const f = el('div', { class: 'pl-fellow' }); fel.forEach(function (m) { let nm = typeof m === 'string' ? m : (m && m.name); if (typeof m === 'string' && _has(G.AIPlayers, 'get')) { const g = G.AIPlayers.get(m); if (g && g.name) nm = g.name; } f.appendChild(_chip(nm || 'Adventurer')); }); box.appendChild(f); }
    const s = d.stats || {};
    box.appendChild(el('div', { class: 'section-title', text: 'Stats' }));
    const sg = el('div', { class: 'pl-stats' });
    [['might', 'Might'], ['agility', 'Agility'], ['vitality', 'Vitality'], ['will', 'Will'], ['fate', 'Fate'], ['maxMorale', 'Morale'], ['maxPower', 'Power'], ['armour', 'Armour'], ['physMastery', 'Phys. Mastery'], ['tactMastery', 'Tact. Mastery'], ['crit', 'Critical'], ['finesse', 'Finesse']].forEach(function (k) { const sp = el('span'); sp.innerHTML = esc(k[1]) + ' <b>' + _fmt(Math.round(_num(s[k[0]]))) + '</b>'; _tip(sp, '<div class="tt-name">' + esc(_statName(k[0])) + '</div><div class="tt-desc">' + esc(_statDesc(k[0])) + '</div>'); sg.appendChild(sp); });
    box.appendChild(sg);
    if (d.kills != null) { const k = el('div', { class: 'pn-sub' }); k.innerHTML = 'Enemies defeated: <b>' + _fmt(_num(d.kills)) + '</b>'; box.appendChild(k); }
    box.appendChild(el('div', { class: 'section-title', text: 'Equipment' }));
    const grid = el('div', { class: 'pl-grid' });
    const slots = C.EQUIP_SLOTS || [];
    slots.forEach(function (slot) {
      const inst = d.equipment ? d.equipment[slot] : null;
      const sl = el('div', { class: 'slot' + (inst ? ' border-' + _rarityOf(inst) : ' empty') });
      if (inst) sl.innerHTML = _iconHTML(inst, 38); else sl.appendChild(el('span', { class: 'empty-label', text: _slotLabel(slot) }));
      _tip(sl, function () { return inst ? _itemTip(inst, null) : '<div class="tt-name">' + esc(_slotLabel(slot)) + '</div><div class="tt-line">Nothing equipped</div>'; });
      grid.appendChild(sl);
    });
    box.appendChild(grid);
    const acts = el('div', { class: 'pl-actions' });
    if (!d.me) {
      acts.appendChild(_btn('Whisper', function () { Pl.whisper(d.name); }));
      acts.appendChild(_btn('Locate', function () { if (d.pos && typeof d.pos.x === 'number') { _setWaypoint(d.pos.x, d.pos.z, d.name); _open('map'); Mp.focus(d.pos.x, d.pos.z); } else _notify('Nobody knows where ' + d.name + ' is right now.', 'info'); }));
      if (_adminMode()) acts.appendChild(_btn('Teleport to', function () { if (_has(G.AIPlayers, 'teleportTo')) G.AIPlayers.teleportTo(id); else if (d.pos && _has(G.Player, 'teleport')) G.Player.teleport(d.pos.x, d.pos.z); _sfx('spell_cast'); }, 'danger'));
    } else {
      acts.appendChild(_btn('Character sheet', function () { _open('character'); }));
      acts.appendChild(_btn('Show on map', function () { _open('map'); Mp.centerOnPlayer(); }));
    }
    box.appendChild(acts);
  }
  Pl.whisper = function (name) {
    if (!name) return;
    if (_has(UI, 'chatInput')) UI.chatInput();
    const input = UI.chatState && UI.chatState.input;
    if (input) { input.value = '/w ' + name + ' '; try { input.focus(); input.setSelectionRange(input.value.length, input.value.length); } catch (_) { /* ignore */ } }
    else _notify('Press Enter and type /w ' + name + ' <message>', 'info');
  };
  Pl.render = function () {
    const body = Pl.body; if (!body) return;
    _clear(body); PL.rows.clear(); PL.detailSig = '';
    const search = el('input', { type: 'text', placeholder: 'Search name, class, zone…', value: PL.query, spellcheck: false });
    search.addEventListener('input', function () { PL.query = search.value; _plFill(); });
    search.addEventListener('keydown', function (ev) { ev.stopPropagation(); if (ev.key === 'Escape') { search.value = ''; PL.query = ''; _plFill(); search.blur(); } });
    PL.searchEl = search;
    PL.countEl = el('span', { class: 'pl-count' });
    const live = el('span', { class: 'pl-live' }, [el('i'), document.createTextNode('LIVE')]);
    _tip(live, '<div class="tt-name">Live roster</div><div class="tt-line">Every adventurer in Middle-earth, refreshed each second as they travel, fight and level.</div>');
    body.appendChild(el('div', { class: 'pl-top' }, [search, PL.countEl, el('span', { class: 'pn-grow' }), live]));
    const table = el('table', { class: 'pl-table' });
    const thead = el('thead'); const trh = el('tr');
    PL.ths = {};
    PL_COLS.forEach(function (c) {
      const th = el('th', {}, [document.createTextNode(c[1]), el('span', { class: 'arr' })]);
      th.addEventListener('click', function () { Pl.sortBy(c[0]); });
      PL.ths[c[0]] = th; trh.appendChild(th);
    });
    thead.appendChild(trh); table.appendChild(thead);
    PL.tbody = el('tbody'); table.appendChild(PL.tbody);
    const wrap = el('div', { class: 'pl-tablewrap' }, [table]);
    wrap.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
    PL.detailEl = el('div', { class: 'pl-detail' });
    PL.detailEl.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
    body.appendChild(el('div', { class: 'pl-cols' }, [wrap, PL.detailEl]));
    _plFill();
    _plDetail(true);
  };
  Pl.sortBy = function (col) { if (PL.sort === col) PL.dir = -PL.dir; else { PL.sort = col; PL.dir = col === 'level' ? -1 : 1; } _sfx('ui_click'); _plFill(); };
  Pl.search = function (q) { PL.query = _str(q); if (PL.searchEl) PL.searchEl.value = PL.query; _plFill(); };
  Pl.select = function (id) { PL.selected = id || null; if (!Pl.isOpen()) { _open('players'); } _plFill(); _plDetail(true); const tr = PL.tbody && PL.tbody.querySelector('tr.selected'); if (tr && typeof tr.scrollIntoView === 'function') tr.scrollIntoView({ block: 'nearest' }); };
  Pl.update = function (dt) { if (!Pl.isOpen()) return; PL.t += dt; if (PL.t < 1) return; PL.t = 0; _plFill(); _plDetail(false); };
  Pl.onOpen = function (arg) { PL.t = 0; if (typeof arg === 'string') Pl.select(arg); };
  definePanel('players', Pl, { title: 'Players of Middle-earth', key: 'KeyP', width: 920, height: Math.min(600, Math.max(420, _vh() - 80)), pos: 'center' });

  // ================================================================================================ DIALOGUE
  const DG = { npc: null, text: '', options: [], view: 'main', quest: null, mode: '', chosen: -1, closeTimer: 0, answered: false };
  const Dg = {};
  const ROLE_ICON = { questgiver: '❖', trainer: '📜', stablemaster: '🐎', boatmaster: '⛵', innkeeper: '🔥', guard: '🛡', bard: '🎵', flavor: '💬' };
  function _npcRoles(npc) { return (npc && Array.isArray(npc.roles)) ? npc.roles : []; }
  function _npcGlyph(npc) {
    const roles = _npcRoles(npc);
    for (let i = 0; i < roles.length; i++) { const r = roles[i]; if (r.indexOf('vendor') === 0) return '⚖'; if (ROLE_ICON[r] && r !== 'flavor') return ROLE_ICON[r]; }
    return npc && npc.race === 'elf' ? '🧝' : npc && (npc.race === 'dwarf' || npc.race === 'stoutaxe') ? '⛏' : '🧙';
  }
  function _refreshOptions() { if (DG.npc && _has(G.NPCs, 'dialogueOptions')) { try { DG.options = G.NPCs.dialogueOptions(DG.npc) || []; } catch (err) { _report(err, 'dialogueOptions'); } } }
  function _dgChoose(opt) {
    if (!opt || !DG.npc) return;
    _sfx('ui_click');
    if (opt.kind === 'quest' || opt.kind === 'turnin' || opt.kind === 'progress') { Dg.showQuest(opt.quest || _questData(opt.questId), opt.kind === 'turnin' ? 'turnin' : opt.kind === 'progress' ? 'progress' : 'available', opt); return; }
    let res = null;
    try { res = _has(G.NPCs, 'choose') ? G.NPCs.choose(DG.npc, opt) : (typeof opt.action === 'function' ? opt.action(DG.npc) : null); } catch (err) { _report(err, 'dialogue option'); }
    if (typeof res === 'string') { DG.text = res; Dg.render(); return; }
    if (res && typeof res === 'object' && !Array.isArray(res)) {
      if (res.text) DG.text = String(res.text);
      Dg.render();
      if (res.close) { if (DG.closeTimer) clearTimeout(DG.closeTimer); DG.closeTimer = setTimeout(function () { DG.closeTimer = 0; Dg.close(); }, 1700); }
      return;
    }
    if (opt.kind === 'trade' || opt.kind === 'travel' || opt.kind === 'sail' || opt.kind === 'train') { if (res !== false) { DG.handoff = true; Dg.close(); } return; }
    if (opt.text) DG.text = String(opt.text);
    Dg.render();
  }
  function _dgOption(opt) {
    const isQ = opt.kind === 'quest' || opt.kind === 'turnin' || opt.kind === 'progress';
    const row = el('div', { class: 'dg-opt' + (isQ ? ' quest' : '') });
    if (isQ) row.appendChild(el('span', { class: 'dg-ico q' + (opt.kind === 'progress' ? ' grey' : ''), text: opt.kind === 'quest' ? '!' : '?' }));
    else row.appendChild(el('span', { class: 'dg-ico', text: opt.icon || '›' }));
    row.appendChild(el('span', { class: 'dg-lbl', text: opt.label || _title(opt.kind || 'option') }));
    const q = opt.quest || (opt.questId ? _questData(opt.questId) : null);
    if (isQ && q) row.appendChild(el('span', { class: 'dg-meta', text: (q.type === 'story' ? 'Story · ' : 'Side · ') + 'Level ' + _num(q.level, 1) + (opt.kind === 'turnin' ? ' · ready' : opt.kind === 'progress' ? ' · in progress' : '') }));
    else if (opt.kind === 'travel' && Array.isArray(opt.routes)) row.appendChild(el('span', { class: 'dg-meta', text: opt.routes.length + ' destinations' }));
    row.addEventListener('click', function () { _dgChoose(opt); });
    if (isQ && q) _tip(row, function () { return '<div class="tt-name">' + esc(q.name) + '</div><div class="tt-line">' + esc(_zoneName(q.zone)) + ' · Level ' + _num(q.level, 1) + '</div>' + (q.rewards && q.rewards.xp ? '<div class="tt-stat">' + _fmt(q.rewards.xp) + ' XP' + (q.rewards.gold ? ' · ' + esc(_moneyText(q.rewards.gold)) : '') + '</div>' : ''); });
    return row;
  }
  function _dgAccept(q) {
    if (!q) return;
    let ok = true;
    if (_has(G.Quests, 'accept')) { try { ok = G.Quests.accept(q.id) !== false; } catch (err) { _report(err, 'Quests.accept'); ok = false; } }
    if (ok) { _sfx('quest_accept'); DG.text = (q.text && q.text.accept) || 'Good luck, and come back safely.'; }
    DG.view = 'main'; DG.quest = null;
    _refreshOptions();
    Dg.render();
  }
  function _dgTurnIn(q) {
    if (!q) return;
    const needChoice = q.rewards && Array.isArray(q.rewards.choose) && q.rewards.choose.length;
    if (needChoice && DG.chosen < 0) { _notify('Choose your reward first.', 'warning'); _sfx('ui_error'); return; }
    let ok = true;
    if (_has(G.Quests, 'turnIn')) { try { ok = G.Quests.turnIn(q.id, needChoice ? DG.chosen : undefined) !== false; } catch (err) { _report(err, 'Quests.turnIn'); ok = false; } }
    if (ok) { let g = ''; if (_has(G.NPCs, 'greeting')) { try { g = G.NPCs.greeting(DG.npc); } catch (_) { g = ''; } } DG.text = g || 'Well done, friend. Middle-earth is a little safer for it.'; }
    DG.view = 'main'; DG.quest = null; DG.chosen = -1;
    _refreshOptions();
    Dg.render();
  }
  Dg.render = function () {
    const body = Dg.body; if (!body) return;
    _clear(body);
    const npc = DG.npc;
    if (!npc) { body.appendChild(el('div', { class: 'pn-empty', text: 'There is nobody to talk to.' })); return; }
    const roles = _npcRoles(npc).filter(function (r) { return r !== 'flavor'; }).map(function (r) { return r.indexOf('vendor:') === 0 ? _title(r.slice(7)) + ' merchant' : r === 'questgiver' ? 'Quest-giver' : _title(r.replace('master', '-master')); });
    body.appendChild(el('div', { class: 'dg-head' }, [
      el('div', { class: 'dg-portrait', text: _npcGlyph(npc) }),
      el('div', { class: 'pn-grow' }, [el('div', { class: 'dg-name', text: npc.name || 'Stranger' }), el('div', { class: 'dg-title', text: (npc.title ? npc.title + ' · ' : '') + ((_race(npc.race) || {}).name || _title(npc.race || '')) + (npc.level ? ' · Level ' + npc.level : '') }), roles.length ? el('div', { class: 'jn-chips', style: 'margin:3px 0 0' }, roles.map(function (r) { return _chip(r); })) : null]),
    ]));
    if (DG.view === 'quest' && DG.quest) {
      const q = DG.quest, mode = DG.mode;
      const qv = el('div', { class: 'dg-quest' });
      qv.appendChild(_questDetail(q, { mode: mode, fullIntro: true, chosen: DG.chosen, onChoose: mode === 'turnin' ? function (i) { DG.chosen = i; } : null }));
      qv.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
      body.appendChild(qv);
      const foot = el('div', { class: 'dg-foot' });
      foot.appendChild(_btn('Back', function () { Dg.back(); }));
      if (mode === 'available') { foot.appendChild(_btn('Decline', function () { Dg.back(); })); foot.appendChild(_btn('Accept quest', function () { _dgAccept(q); }, 'primary')); }
      else if (mode === 'turnin') foot.appendChild(_btn('Complete quest', function () { _dgTurnIn(q); }, 'primary'));
      else if (_has(G.Quests, 'setTracked')) foot.appendChild(_btn(G.Quests.tracked === q.id ? 'Tracked' : 'Track', function () { G.Quests.setTracked(q.id); if (UI.tracker && _has(UI.tracker, 'refresh')) UI.tracker.refresh(); Dg.render(); }));
      body.appendChild(foot);
      return;
    }
    body.appendChild(el('div', { class: 'dg-text', text: DG.text || '…' }));
    const opts = el('div', { class: 'dg-options' });
    opts.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
    const order = { quest: 0, turnin: 0, progress: 1, trade: 2, train: 3, travel: 4, sail: 5, rest: 6, talk: 7 };
    DG.options.slice().sort(function (a, b) { return _num(order[a.kind], 9) - _num(order[b.kind], 9); }).forEach(function (o) { if (o) opts.appendChild(_dgOption(o)); });
    if (!DG.options.length) opts.appendChild(el('div', { class: 'pn-sub', style: 'padding:4px 6px', text: npc.name + ' has nothing more to say.' }));
    body.appendChild(opts);
    body.appendChild(el('div', { class: 'dg-foot' }, [_btn('Goodbye', function () { _sfx('ui_click'); Dg.close(); })]));
  };
  Dg.open = function (npc, greeting, options) {
    if (!npc) return false;
    if (DG.closeTimer) { clearTimeout(DG.closeTimer); DG.closeTimer = 0; }
    DG.npc = npc; DG.text = _str(greeting) || 'Well met.'; DG.options = Array.isArray(options) ? options : []; DG.view = 'main'; DG.quest = null; DG.chosen = -1; DG.handoff = false;
    if (!DG.options.length) _refreshOptions();
    if (Dg.isOpen()) Dg.render(); else _open('dialogue');
    return true;
  };
  Dg.showQuest = function (quest, mode, opt) {
    const q = _questData(quest); if (!q) return false;
    DG.quest = q; DG.mode = mode === 'turnin' || mode === 'progress' ? mode : 'available'; DG.view = 'quest'; DG.chosen = -1;
    if (opt && opt.text && DG.mode === 'progress') DG.text = opt.text;
    if (!DG.npc) { const giver = _npcRec(DG.mode === 'turnin' ? (q.turnin || q.giver) : q.giver); DG.npc = giver ? { name: giver.name, title: giver.title, race: giver.race, roles: giver.roles, npcId: giver.id } : { name: 'Quest', roles: [] }; }
    if (Dg.isOpen()) Dg.render(); else _open('dialogue');
    return true;
  };
  Dg.back = function () { DG.view = 'main'; DG.quest = null; DG.chosen = -1; _sfx('ui_click'); Dg.render(); };
  Dg.setText = function (t) { DG.text = _str(t); Dg.render(); };
  Object.defineProperty(Dg, 'npc', { get: function () { return DG.npc; } });
  Dg.onClose = function () {
    if (DG.closeTimer) { clearTimeout(DG.closeTimer); DG.closeTimer = 0; }
    const npc = DG.npc; DG.npc = null; DG.view = 'main'; DG.quest = null;
    if (npc && _has(G.NPCs, 'endTalk')) { try { G.NPCs.endTalk(npc); } catch (err) { _report(err, 'endTalk'); } }
  };
  definePanel('dialogue', Dg, { title: 'Conversation', width: 580, pos: 'center', modal: true, remember: false });

  // ================================================================================================ VENDOR
  const VD = { npc: null, stock: [], query: '', _list: null, _scroll: 0, _grid: null, _gscroll: 0, _far: 0 };
  const Vd = {};
  function _vendorKindLabel(npc) {
    let k = null; if (_has(G.NPCs, 'vendorKind')) { try { k = G.NPCs.vendorKind(npc); } catch (_) { k = null; } }
    if (!k) { const roles = _npcRoles(npc); for (let i = 0; i < roles.length; i++) if (roles[i].indexOf('vendor:') === 0) k = roles[i].slice(7); }
    return k === 'armour' ? 'Armour merchant' : k === 'weapons' ? 'Weaponsmith' : k === 'food' ? 'Provisioner' : k === 'fishing' ? 'Fishing supplies' : 'General goods';
  }
  function _vdBuyRow(inst, p) {
    const v = _view(inst); if (!v) return null;
    const price = _num(inst.price, _has(G.Items, 'buyValue') ? G.Items.buyValue(inst) : v.value);
    const cant = _num(p && p.gold) < price;
    const req = p && typeof p.level === 'number' && v.level > p.level;
    let ce = { ok: true }; if (v.slot && _has(G.Items, 'canEquip')) { try { ce = G.Items.canEquip(p, inst); } catch (_) { ce = { ok: true }; } }
    const row = el('div', { class: 'vd-row' + (cant ? ' cant' : '') });
    row.innerHTML = _iconHTML(inst, 30);
    const tl = _has(G.Items, 'typeLabel') ? G.Items.typeLabel(v) : _title(v.type);
    row.appendChild(el('div', { class: 'pn-grow' }, [el('div', { class: 'vd-nm rarity-' + (v.rarity || 'common'), text: v.name }), el('div', { class: 'vd-sub', html: esc(tl) + (v.slot ? ' · ' + esc(_slotLabel(v.slot)) : '') + (v.level > 1 ? ' · <span class="' + (req ? 'req' : '') + '">Level ' + v.level + '</span>' : '') + (v.slot && !ce.ok && !req ? ' · <span class="req">' + esc(ce.reason || 'not for your class') + '</span>' : '') })]));
    const pr = el('div', { class: 'vd-price' }); pr.innerHTML = _money(price); row.appendChild(pr);
    _tip(row, function () { return _itemTip(inst, p) + '<div class="tt-line" style="margin-top:4px">Price: ' + esc(_moneyText(price)) + '</div><div class="tt-sub">Click to buy · Shift-click buys 5' + ((v.maxStack || 1) > 1 ? '' : ' (one at a time)') + '</div>'; });
    row.addEventListener('click', function (ev) {
      if (!VD.npc) return;
      const n = ev.shiftKey ? 5 : 1;
      if (_has(G.NPCs, 'buy')) { if (G.NPCs.buy(VD.npc, inst.tid, n)) Vd.mark(); }
      else _notify('Nobody is selling right now.', 'warning');
    });
    return row;
  }
  function _vdSellSlot(i, inst, p) {
    const s = el('div', { class: 'slot' + (inst ? ' border-' + _rarityOf(inst) : ' empty'), data: { i: i } });
    if (!inst) return s;
    const val = _has(G.Items, 'sellValue') ? G.Items.sellValue(inst) : 0;
    s.innerHTML = _iconHTML(inst, 34);
    const cnt = _num(inst.count, 1); if (cnt > 1) s.appendChild(el('span', { class: 'count', text: String(cnt) }));
    if (val <= 0) s.classList.add('nosell');
    let junk = false; if (_has(G.Items, 'isJunk')) { try { junk = G.Items.isJunk(inst, p); } catch (_) { junk = false; } }
    _tip(s, function () { return _itemTip(inst, p) + '<div class="tt-line" style="margin-top:4px">' + (val > 0 ? 'Sells for ' + esc(_moneyText(val)) + (junk ? ' · <span class="tt-key">junk</span>' : '') : '<span class="tt-warn">Cannot be sold</span>') + '</div>' + (val > 0 ? '<div class="tt-sub">Click to sell</div>' : ''); });
    s.addEventListener('click', function () { if (!VD.npc) return; if (val <= 0) { _notify('That cannot be sold.', 'warning'); _sfx('ui_error'); return; } if (_has(G.NPCs, 'sell')) { G.NPCs.sell(VD.npc, i); Vd.mark(); } });
    s.addEventListener('contextmenu', function (ev) { ev.preventDefault(); ev.stopPropagation(); _tipHide(); _invMenu(i, ev.clientX, ev.clientY); });
    return s;
  }
  Vd.render = function () {
    const body = Vd.body; if (!body) return;
    if (VD._list) VD._scroll = VD._list.scrollTop;
    if (VD._grid) VD._gscroll = VD._grid.scrollTop;
    _clear(body);
    const p = _player(), npc = VD.npc;
    if (!npc) { body.appendChild(el('div', { class: 'pn-empty', text: 'No merchant is trading with you.' })); return; }
    const top = el('div', { class: 'vd-top' });
    top.appendChild(el('span', { class: 'vd-npc', text: npc.name || 'Merchant' }));
    top.appendChild(el('span', { class: 'vd-kind', text: _vendorKindLabel(npc) + (npc.town ? ' · ' + ((_town(npc.town) || {}).name || _title(npc.town)) : '') }));
    top.appendChild(el('span', { class: 'pn-grow' }));
    const gold = el('span'); gold.innerHTML = '<span class="pn-muted">Your purse </span>' + _money(_num(p && p.gold)); top.appendChild(gold);
    body.appendChild(top);
    // ---- buy column
    const buy = el('div', { class: 'vd-buy' });
    const search = el('input', { type: 'text', placeholder: 'Search wares…', value: VD.query, spellcheck: false });
    search.addEventListener('input', function () { VD.query = search.value; _vdFillList(); });
    search.addEventListener('keydown', function (ev) { ev.stopPropagation(); });
    buy.appendChild(el('div', { class: 'vd-search' }, [el('span', { class: 'section-title', style: 'margin:0;border:none;padding:0', text: 'Wares' }), search]));
    const list = el('div', { class: 'vd-list' });
    list.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
    VD._list = list;
    const _vdFillList = function () {
      _clear(list);
      const q = VD.query.trim().toLowerCase();
      const stock = (Array.isArray(VD.stock) ? VD.stock : []).slice().sort(function (a, b) { const va = _view(a) || {}, vb = _view(b) || {}; return _num(va.level) - _num(vb.level) || String(va.name || '').localeCompare(String(vb.name || '')); });
      let n = 0;
      stock.forEach(function (inst) { const v = _view(inst); if (!v) return; if (q && (v.name + ' ' + (v.type || '') + ' ' + (v.subtype || '')).toLowerCase().indexOf(q) < 0) return; const r = _vdBuyRow(inst, p); if (r) { list.appendChild(r); n++; } });
      if (!n) list.appendChild(el('div', { class: 'pn-empty', text: stock.length ? 'Nothing matches.' : npc.name + ' has nothing for sale today.' }));
    };
    _vdFillList();
    buy.appendChild(list);
    buy.appendChild(el('div', { class: 'vd-sellfoot' }, [el('span', { class: 'pn-muted', text: 'Click to buy · Shift-click ×5' }), el('span', { class: 'pn-muted', text: (Array.isArray(VD.stock) ? VD.stock.length : 0) + ' wares' })]));
    // ---- sell column
    const sell = el('div', { class: 'vd-sell' });
    const inv = (p && Array.isArray(p.inventory)) ? p.inventory : [];
    let junkCount = 0, junkVal = 0, used = 0;
    inv.forEach(function (inst) { if (!inst) return; used++; let j = false; try { j = _has(G.Items, 'isJunk') && G.Items.isJunk(inst, p); } catch (_) { j = false; } if (j) { junkCount++; junkVal += _has(G.Items, 'sellValue') ? G.Items.sellValue(inst) : 0; } });
    sell.appendChild(el('div', { class: 'vd-search' }, [el('span', { class: 'section-title', style: 'margin:0;border:none;padding:0', text: 'Your bags' }), el('span', { class: 'pn-grow' }), el('span', { class: 'pn-muted small', text: used + '/' + (C.INVENTORY_SLOTS || 200) + ' · click an item to sell it' })]));
    const gwrap = el('div', { class: 'vd-gridwrap vd-dropzone' });
    const grid = el('div', { class: 'vd-grid' });
    for (let i = 0; i < (C.INVENTORY_SLOTS || 200); i++) grid.appendChild(_vdSellSlot(i, inv[i] || null, p));
    gwrap.appendChild(grid);
    gwrap.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
    gwrap.addEventListener('dragover', function (ev) { if (DND.kind === 'inv' || _dtHas(ev, 'text/inv-slot')) { ev.preventDefault(); gwrap.classList.add('dragover'); } });
    gwrap.addEventListener('dragleave', function () { gwrap.classList.remove('dragover'); });
    gwrap.addEventListener('drop', function (ev) { ev.preventDefault(); gwrap.classList.remove('dragover'); const from = _dndInv(ev); if (from >= 0 && VD.npc && _has(G.NPCs, 'sell')) { G.NPCs.sell(VD.npc, from); Vd.mark(); } _dndReset(); });
    VD._grid = gwrap;
    sell.appendChild(gwrap);
    const junkBtn = _btn('Sell all junk' + (junkCount ? ' (' + junkCount + ')' : ''), function () { if (!VD.npc) return; if (_has(G.NPCs, 'sellJunk')) { G.NPCs.sellJunk(VD.npc); Vd.mark(); } }, 'small' + (junkCount ? ' primary' : ' disabled'));
    _tip(junkBtn, '<div class="tt-name">Sell all junk</div><div class="tt-line">Trophies, vendor trash and grey gear far below your level.</div>' + (junkCount ? '<div class="tt-stat">' + junkCount + ' items · ' + esc(_moneyText(junkVal)) + '</div>' : '<div class="tt-sub">Nothing in your bags counts as junk.</div>'));
    sell.appendChild(el('div', { class: 'vd-sellfoot' }, [junkBtn, el('span', { class: 'pn-muted', text: 'Drag items here to sell them' })]));
    let bb = []; if (_has(G.NPCs, 'buyback')) { try { bb = G.NPCs.buyback(npc) || []; } catch (_) { bb = []; } }
    if (bb.length) {
      const box = el('div', { class: 'vd-buyback' });
      box.appendChild(el('div', { class: 'section-title', text: 'Buy back' }));
      bb.slice().reverse().forEach(function (inst, k) {
        const idx = bb.length - 1 - k;
        const price = (npc._buyback && npc._buyback[idx] && npc._buyback[idx].price) || (_has(G.Items, 'sellValue') ? G.Items.sellValue(inst) : 0);
        const row = el('div', { class: 'vd-bbrow' });
        row.innerHTML = _iconHTML(inst, 22) + '<span class="nm rarity-' + _rarityOf(inst) + '">' + esc(_itemName(inst)) + ((inst.count || 1) > 1 ? ' ×' + inst.count : '') + '</span><span>' + _money(price) + '</span>';
        _tip(row, function () { return _itemTip(inst, p) + '<div class="tt-sub">Click to buy it back for ' + esc(_moneyText(price)) + '</div>'; });
        row.addEventListener('click', function () { if (_has(G.NPCs, 'rebuy')) { G.NPCs.rebuy(npc, idx); Vd.mark(); } });
        box.appendChild(row);
      });
      sell.appendChild(box);
    }
    body.appendChild(el('div', { class: 'vd-cols' }, [buy, sell]));
    body.appendChild(el('div', { class: 'vd-foot' }, [el('span', { class: 'pn-muted', text: 'Walk away to end the trade' }), el('span', { class: 'pn-muted', text: 'Right-click a bag item for more options' })]));
    if (VD._scroll) list.scrollTop = VD._scroll;
    if (VD._gscroll) gwrap.scrollTop = VD._gscroll;
  };
  Vd.open = function (npc, stock) {
    if (!npc) return false;
    VD.npc = npc;
    if (Array.isArray(stock)) VD.stock = stock;
    else { VD.stock = []; if (_has(G.NPCs, 'stockFor')) { try { VD.stock = G.NPCs.stockFor(npc) || []; } catch (_) { VD.stock = []; } } }
    VD._far = 0; VD._scroll = 0; VD._gscroll = 0;
    if (Vd.isOpen()) Vd.render(); else _open('vendor');
    return true;
  };
  Object.defineProperty(Vd, 'npc', { get: function () { return VD.npc; } });
  Object.defineProperty(Vd, 'stock', { get: function () { return VD.stock; } });
  Vd.update = function (dt) {
    if (!Vd.isOpen() || !VD.npc) return;
    const p = _player();
    if (!p || !p.pos || !VD.npc.pos || typeof VD.npc.pos.x !== 'number') return;
    const d = G.dist2 ? G.dist2(p.pos.x, p.pos.z, VD.npc.pos.x, VD.npc.pos.z) : 0;
    if (d > 8) { VD._far += dt; if (VD._far > 0.3) { const nm = VD.npc.name || 'the merchant'; Vd.close(); _notify('You walk away from ' + nm + '.', 'info'); } } else VD._far = 0;
  };
  Vd.onClose = function () { const npc = VD.npc; VD.npc = null; if (npc && _has(G.NPCs, 'endTalk')) { try { G.NPCs.endTalk(npc); } catch (_) { /* ignore */ } } };
  definePanel('vendor', Vd, { title: 'Trade', width: 900, height: Math.min(600, Math.max(420, _vh() - 80)), pos: 'center' });

  // ================================================================================================ TRAVEL
  const TR = { mode: 'stable', npc: null, dock: null, routes: [], busy: false };
  const Tr = {};
  function _stableRoutes(townId) {
    const w = _world(); if (!w || !townId) return [];
    if (_has(w, 'travelRoutesFrom')) { try { return w.travelRoutesFrom(townId) || []; } catch (_) { /* fall through */ } }
    return Array.isArray(w.travelRoutes) ? w.travelRoutes.filter(function (r) { return r && r.from === townId; }) : [];
  }
  function _spendGold(n) {
    const p = _player(); if (!p) return false;
    if (_num(p.gold) < n) return false;
    if (_has(G.Progress, 'spendGold')) return !!G.Progress.spendGold(n);
    p.gold = _num(p.gold) - n; G.emit('goldChanged', p.gold); return true;
  }
  function _ride(route, town) {
    const p = _player(); if (!p || TR.busy) return;
    const cost = _num(route.cost);
    if (_num(p.gold) < cost) { _notify('You cannot afford the fare.', 'warning'); _sfx('ui_error'); return; }
    const dest = town.rallyPoint || town.pos; if (!dest) return;
    if (!_spendGold(cost)) { _notify('You cannot afford the fare.', 'warning'); _sfx('ui_error'); return; }
    TR.busy = true;
    Tr.close(); _close('dialogue');
    _sfx('horse_mount');
    _fade(true, 0.5, function () {
      try {
        if (_has(G.Player, 'teleport')) G.Player.teleport(dest.x, dest.z);
        else if (p.pos) { p.pos.x = dest.x; p.pos.z = dest.z; }
      } catch (err) { _report(err, 'travel teleport'); }
      _sfx('horse_gallop');
      setTimeout(function () { _fade(false, 0.9); TR.busy = false; _notify('You ride swiftly to ' + town.name + '.', 'info'); }, 420);
    });
  }
  function _trRow(icon, name, sub, costHTML, onClick, locked) {
    const row = el('div', { class: 'tr-row' + (locked ? ' locked' : '') });
    row.appendChild(el('div', { class: 'tr-ico', text: icon }));
    const mid = el('div', { class: 'pn-grow' }, [el('div', { class: 'tr-nm', text: name })]);
    const s = el('div', { class: 'tr-sub' }); s.innerHTML = sub; mid.appendChild(s);
    row.appendChild(mid);
    const c = el('div', { class: 'tr-cost' }); c.innerHTML = costHTML; row.appendChild(c);
    if (!locked) row.addEventListener('click', onClick);
    return row;
  }
  Tr.render = function () {
    const body = Tr.body; if (!body) return;
    _clear(body);
    const p = _player();
    const gold = _num(p && p.gold);
    if (TR.mode === 'stable') {
      const npc = TR.npc;
      const here = npc && _town(npc.town);
      body.appendChild(el('div', { class: 'tr-intro', text: (npc && npc.name ? npc.name + ': ' : '') + '"Where would you like to ride' + (p && p.name ? ', ' + p.name : '') + '? My ponies are swift and the roads are watched."' }));
      const list = el('div', { class: 'tr-list' });
      const routes = TR.routes.slice().sort(function (a, b) { return _num(a.cost) - _num(b.cost); });
      if (!routes.length) list.appendChild(el('div', { class: 'pn-empty', text: 'No routes lead away from here.' }));
      routes.forEach(function (r) {
        const town = _town(r.to); if (!town) return;
        const z = _zone(town.zone);
        const lvl = z && Array.isArray(z.level) ? z.level : null;
        const danger = lvl && p && lvl[0] > _num(p.level, 1) + 3;
        let locked = false, lockText = '';
        if (r.requires && !_qdone(r.requires)) { locked = true; const qd = _questData(r.requires); lockText = 'Requires: ' + esc((qd && qd.name) || r.requires); }
        const dist = _num(r.dist) || (here && here.pos ? Math.round(G.dist2 ? G.dist2(here.pos.x, here.pos.z, town.pos.x, town.pos.z) : 0) : 0);
        const sub = esc(_zoneName(town.zone)) + (lvl ? ' · <span class="' + (danger ? 'warn' : '') + '">Levels ' + lvl[0] + '–' + lvl[1] + (danger ? ' ⚠' : '') + '</span>' : '') + (dist ? ' · ' + (dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : dist + ' m') : '') + (lockText ? ' · <span class="warn">' + lockText + '</span>' : '');
        const cant = gold < _num(r.cost);
        const row = _trRow('🐎', town.name, sub, _num(r.cost) > 0 ? _money(r.cost) : '<span class="free">Free</span>', function () {
          _sfx('ui_click');
          _confirm('Ride to ' + town.name + ' for ' + _moneyText(r.cost) + '?', function () { _ride(r, town); }, { title: 'Swift travel', yes: 'Ride' });
        }, locked);
        if (cant) row.classList.add('cant');
        _tip(row, '<div class="tt-name">' + esc(town.name) + '</div><div class="tt-line">' + esc(_zoneName(town.zone)) + (z && z.desc ? '</div><div class="tt-desc">' + esc(z.desc) : '') + '</div>' + (danger ? '<div class="tt-req">The creatures there are far above your level.</div>' : ''));
        list.appendChild(row);
      });
      body.appendChild(list);
    } else {
      const dock = TR.dock;
      body.appendChild(el('div', { class: 'tr-intro', text: (TR.npc && TR.npc.name ? TR.npc.name + ': ' : '') + '"The tide is right' + (p && p.name ? ', ' + p.name : '') + '. Where shall we sail from ' + ((dock && dock.name) || 'the quay') + '?"' }));
      const list = el('div', { class: 'tr-list' });
      const routes = TR.routes;
      if (!routes.length) list.appendChild(el('div', { class: 'pn-empty', text: 'No ships sail from this quay.' }));
      routes.forEach(function (r) {
        const id = typeof r === 'string' ? r : (r.id || (r.dock && r.dock.id));
        const d = (r && r.dock) || _dock(id);
        const name = (r && r.name) || (d && d.name) || _title(id || 'a distant shore');
        const town = d && _town(d.town);
        const z = town && _zone(town.zone);
        const lvl = z && Array.isArray(z.level) ? z.level : null;
        const danger = lvl && p && lvl[0] > _num(p.level, 1) + 3;
        const cost = _num(r && r.cost);
        const dist = _num(r && r.dist);
        const sub = esc(town ? town.name + ' · ' + _zoneName(town.zone) : '') + (lvl ? ' · <span class="' + (danger ? 'warn' : '') + '">Levels ' + lvl[0] + '–' + lvl[1] + (danger ? ' ⚠' : '') + '</span>' : '') + (dist ? ' · ' + (dist >= 1000 ? (dist / 1000).toFixed(1) + ' km' : dist + ' m') : '');
        const row = _trRow('⛵', name, sub, cost > 0 ? _money(cost) : '<span class="free">Free passage</span>', function () {
          _sfx('ui_click');
          const go = function () {
            if (!_has(G.Boats, 'sailTo')) { _notify('No ship is ready to sail.', 'warning'); return; }
            Tr.close(); _close('dialogue');
            try { G.Boats.sailTo(id, dock); } catch (err) { _report(err, 'Boats.sailTo'); }
          };
          if (cost > 0) _confirm('Sail to ' + name + ' for ' + _moneyText(cost) + '?', go, { title: 'Set sail', yes: 'Sail' }); else go();
        });
        if (cost > 0 && gold < cost) row.classList.add('cant');
        _tip(row, '<div class="tt-name">' + esc(name) + '</div>' + (z && z.desc ? '<div class="tt-desc">' + esc(z.desc) + '</div>' : '') + (danger ? '<div class="tt-req">The creatures there are far above your level.</div>' : ''));
        list.appendChild(row);
      });
      list.appendChild(_trRow('🚣', 'Take a rowboat', 'Row wherever you please — W/S to row, A/D to steer, E near the shore to land.', '<span class="free">Free</span>', function () {
        _sfx('ui_click');
        if (!_has(G.Boats, 'board')) { _notify('There is no boat free right now.', 'warning'); return; }
        Tr.close(); _close('dialogue');
        try { G.Boats.board(dock); } catch (err) { _report(err, 'Boats.board'); }
      }));
      body.appendChild(list);
    }
    const foot = el('div', { class: 'tr-foot' });
    const g = el('span'); g.innerHTML = '<span class="pn-muted">Your purse </span>' + _money(gold); foot.appendChild(g);
    foot.appendChild(_btn('Close', function () { Tr.close(); }, 'small'));
    body.appendChild(foot);
  };
  Tr.openStable = function (npc) {
    if (!npc) return false;
    TR.mode = 'stable'; TR.npc = npc; TR.dock = null;
    TR.routes = _stableRoutes(npc.town);
    if (Tr.panel && Tr.panel.setTitle) Tr.panel.setTitle('Swift Travel — ' + (((_town(npc.town) || {}).name) || 'Stable'));
    if (Tr.isOpen()) Tr.render(); else _open('travel');
    return true;
  };
  Tr.openDock = function (dock, npc) {
    if (typeof dock === 'string') dock = _dock(dock);
    if (!dock) return false;
    TR.mode = 'dock'; TR.dock = dock; TR.npc = npc || null;
    let routes = null;
    if (_has(G.Boats, 'routesFrom')) { try { routes = G.Boats.routesFrom(dock.id); } catch (err) { _report(err, 'Boats.routesFrom'); routes = null; } }
    if (!Array.isArray(routes)) routes = Array.isArray(dock.routes) ? dock.routes.slice() : [];
    TR.routes = routes;
    if (Tr.panel && Tr.panel.setTitle) Tr.panel.setTitle('Set Sail — ' + (dock.name || 'Dock'));
    if (Tr.isOpen()) Tr.render(); else _open('travel');
    return true;
  };
  Tr.fade = function (on, dur, cb) { _fade(on, dur, cb); };
  Tr.onClose = function () { const npc = TR.npc; TR.npc = null; if (npc && _has(G.NPCs, 'endTalk')) { try { G.NPCs.endTalk(npc); } catch (_) { /* ignore */ } } };
  definePanel('travel', Tr, { title: 'Travel', width: 500, pos: 'center', remember: false });

  // ================================================================================================ SETTINGS (Esc)
  const St = {};
  const ST_DEFAULTS = { music: 0.6, sfx: 0.8, mouseSens: 1.0, invertY: false, showFps: false, cameraDist: 7, shadows: true, quality: 'auto', vegDensity: 1.0 };
  function _settings() {
    if (!G.state) return Object.assign({}, ST_DEFAULTS);
    const s = G.state.settings = G.state.settings || {};
    for (const k in ST_DEFAULTS) if (s[k] === undefined) s[k] = ST_DEFAULTS[k];
    return s;
  }
  St.get = function () { return _settings(); };
  St.apply = function () {
    const s = _settings();
    try { if (_has(G.Audio, 'setVolumes')) G.Audio.setVolumes(s.music, s.sfx); } catch (err) { _report(err, 'settings audio'); }
    try { if (G.Player && G.Player.cam && typeof s.cameraDist === 'number') { if ('targetDist' in G.Player.cam) G.Player.cam.targetDist = s.cameraDist; else G.Player.cam.dist = s.cameraDist; } } catch (err) { _report(err, 'settings camera'); }
    try { if (_has(G.Veg, 'setDensity')) G.Veg.setDensity(_num(s.vegDensity, 1)); } catch (err) { _report(err, 'settings veg'); }
    try {
      if (_has(G.Sky, 'setShadowQuality')) { const q = (G.state && G.state.quality) || 'high'; G.Sky.setShadowQuality(s.shadows ? (q === 'ultra' ? 4096 : q === 'high' ? 2048 : q === 'medium' ? 1024 : 512) : 0); }
      if (G.Game && G.Game.renderer && G.Game.renderer.shadowMap) G.Game.renderer.shadowMap.enabled = !!s.shadows;
    } catch (err) { _report(err, 'settings shadows'); }
    return s;
  };
  function _stSlider(label, key, min, max, step, fmtFn, onChange, tip) {
    const s = _settings();
    const input = el('input', { type: 'range', min: min, max: max, step: step, value: _num(s[key], ST_DEFAULTS[key]) });
    const val = el('span', { class: 'st-val', text: fmtFn(_num(s[key], ST_DEFAULTS[key])) });
    const commit = function () { const v = parseFloat(input.value); s[key] = v; val.textContent = fmtFn(v); if (onChange) onChange(v); };
    input.addEventListener('input', commit);
    input.addEventListener('change', function () { _sfx('ui_click'); });
    // 00_core's key handler prevents the default of arrow keys, so step the range ourselves
    input.addEventListener('keydown', function (ev) {
      ev.stopPropagation();
      const dir = (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') ? -1 : (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') ? 1 : 0;
      if (!dir) return;
      ev.preventDefault();
      input.value = String(clamp(parseFloat(input.value) + dir * step, min, max));
      commit(); _sfx('ui_click');
    });
    const lab = el('label', { text: label });
    if (tip) _tip(lab, tip);
    return el('div', { class: 'st-row' }, [lab, input, val]);
  }
  function _stCheck(label, key, onChange, tip) {
    const s = _settings();
    const input = el('input', { type: 'checkbox', checked: !!s[key] });
    input.addEventListener('change', function () { s[key] = !!input.checked; _sfx('ui_click'); if (onChange) onChange(s[key]); });
    const lab = el('label', { text: label });
    if (tip) _tip(lab, tip);
    return el('div', { class: 'st-row chk' }, [lab, el('label', { class: 'st-check' }, [input, el('span', { class: 'pn-muted', text: s[key] ? 'On' : 'Off' })])]);
  }
  St.render = function () {
    const body = St.body; if (!body) return;
    _clear(body);
    const s = _settings();
    const box = el('div', { class: 'st-body' });
    box.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
    box.appendChild(el('div', { class: 'section-title', text: 'Sound' }));
    box.appendChild(_stSlider('Music volume', 'music', 0, 1, 0.05, function (v) { return Math.round(v * 100) + '%'; }, function () { if (_has(G.Audio, 'setVolumes')) G.Audio.setVolumes(s.music, s.sfx); }));
    box.appendChild(_stSlider('Effects volume', 'sfx', 0, 1, 0.05, function (v) { return Math.round(v * 100) + '%'; }, function () { if (_has(G.Audio, 'setVolumes')) G.Audio.setVolumes(s.music, s.sfx); }));
    box.appendChild(el('div', { class: 'section-title', text: 'Controls & camera' }));
    box.appendChild(_stSlider('Mouse sensitivity', 'mouseSens', 0.2, 3, 0.1, function (v) { return v.toFixed(1) + '×'; }, null, '<div class="tt-name">Mouse sensitivity</div><div class="tt-line">How far the camera turns per inch of mouse travel.</div>'));
    box.appendChild(_stCheck('Invert mouse Y', 'invertY', null, '<div class="tt-name">Invert Y</div><div class="tt-line">Push forward to look down, like a flight stick.</div>'));
    box.appendChild(_stSlider('Camera distance', 'cameraDist', 1.5, 28, 0.5, function (v) { return v.toFixed(1) + ' m'; }, function (v) { if (G.Player && G.Player.cam) { if ('targetDist' in G.Player.cam) G.Player.cam.targetDist = v; else G.Player.cam.dist = v; } }, '<div class="tt-name">Camera distance</div><div class="tt-line">The mouse wheel changes this in-game too. Very close = first person.</div>'));
    box.appendChild(el('div', { class: 'section-title', text: 'Graphics' }));
    const sel = el('select');
    [['auto', 'Auto (adapts to your frame rate)'], ['ultra', 'Ultra'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']].forEach(function (o) { sel.appendChild(el('option', { value: o[0], text: o[1], selected: (s.quality || 'auto') === o[0] })); });
    sel.value = s.quality || 'auto';
    sel.addEventListener('change', function () { s.quality = sel.value; _sfx('ui_click'); let applied = sel.value; if (_has(G.PostFX, 'setQuality')) { try { applied = G.PostFX.setQuality(sel.value) || sel.value; } catch (err) { _report(err, 'setQuality'); } } else if (G.state) G.state.quality = sel.value === 'auto' ? G.state.quality : sel.value; qv.textContent = applied === sel.value ? '' : '→ ' + _title(applied); St.apply(); });
    sel.addEventListener('keydown', function (ev) { ev.stopPropagation(); });
    const qv = el('span', { class: 'st-val', text: (s.quality === 'auto' && G.state && G.state.quality) ? '→ ' + _title(G.state.quality) : '' });
    const ql = el('label', { text: 'Graphics quality' }); _tip(ql, '<div class="tt-name">Graphics quality</div><div class="tt-line">Bloom, anti-aliasing, shadow resolution, vegetation and render scale.</div><div class="tt-sub">Auto steps down when the game runs below 50 fps and back up when it is smooth.</div>');
    box.appendChild(el('div', { class: 'st-row' }, [ql, sel, qv]));
    box.appendChild(_stCheck('Shadows', 'shadows', function () { St.apply(); }));
    box.appendChild(_stSlider('Vegetation density', 'vegDensity', 0.25, 1.5, 0.05, function (v) { return Math.round(v * 100) + '%'; }, function (v) { if (_has(G.Veg, 'setDensity')) G.Veg.setDensity(v); }));
    box.appendChild(_stCheck('Show frame rate', 'showFps'));
    box.appendChild(el('div', { class: 'section-title', text: 'Game' }));
    const btns = el('div', { class: 'st-buttons' });
    btns.appendChild(_btn('Key bindings (F1)', function () { _open('keyhelp'); }));
    btns.appendChild(_btn('Save now', function () { if (_has(G.Save, 'save')) { const r = G.Save.save(); if (r !== false && r !== null) _notify('Game saved.', 'system'); } else _notify('Saving is not available.', 'warning'); }, 'primary'));
    btns.appendChild(_btn('Return to main menu', function () { _confirm('Return to the main menu? Your progress is saved first.', function () { if (_has(G.Save, 'save')) { try { G.Save.save({ silent: true, reason: 'menu' }); } catch (_) { /* ignore */ } } if (_has(G.Game, 'toMenu')) { _close('settings'); G.Game.toMenu(); } else _notify('The main menu is not available.', 'warning'); }, { title: 'Main menu', yes: 'Leave' }); }));
    btns.appendChild(_btn('New character', function () { _confirm('Start a new character? Your current hero stays saved until you overwrite the save from the character creator.', function () { if (_has(G.Game, 'toCharCreate')) { _close('settings'); G.Game.toCharCreate(); } else _notify('Character creation is not available.', 'warning'); }, { title: 'New character', yes: 'Continue' }); }, 'danger'));
    box.appendChild(btns);
    box.appendChild(el('div', { class: 'st-credits', html: '<b>Chris Jensen\'s Lord of the Rings Online</b> — a single-file tribute to Middle-earth.<br>Built with Three.js r160 · procedural world, music and characters · v' + esc(G.VERSION || '1.0.0') + '<br>Esc closes this window · your settings are kept with your save.' }));
    body.appendChild(box);
  };
  definePanel('settings', St, { title: 'Settings', width: 540, height: Math.min(600, Math.max(400, _vh() - 80)), pos: 'center' });

  // ================================================================================================ CHOOSE (quest reward)
  const CO = { items: [], onPick: null, sel: -1, opts: {}, answered: false };
  const Cho = {};
  Cho.render = function () {
    const body = Cho.body; if (!body) return;
    _clear(body);
    const p = _player();
    body.appendChild(el('div', { class: 'cho-text', text: CO.opts.text || 'Choose one of these rewards. Choose wisely — the others will not be offered again.' }));
    const grid = el('div', { class: 'cho-grid' });
    grid.addEventListener('wheel', function (ev) { ev.stopPropagation(); }, { passive: true });
    if (!CO.items.length) grid.appendChild(el('div', { class: 'pn-empty', text: 'There is nothing to choose from.' }));
    CO.items.forEach(function (inst, i) {
      const v = _view(inst) || {};
      const card = el('div', { class: 'cho-card' + (CO.sel === i ? ' on' : '') });
      card.innerHTML = _iconHTML(inst, 56);
      card.appendChild(el('div', { class: 'cho-nm rarity-' + (v.rarity || 'common'), text: (v.name || _itemName(inst)) + ((inst.count || 1) > 1 ? ' ×' + inst.count : '') }));
      card.appendChild(el('div', { class: 'cho-sub', text: (_has(G.Items, 'typeLabel') ? G.Items.typeLabel(v) : _title(v.type || '')) + (v.slot ? ' · ' + _slotLabel(v.slot) : '') + (v.level > 1 ? ' · L' + v.level : '') }));
      _tip(card, function () { return _itemTip(inst, p); }, { keepOnClick: true });
      card.addEventListener('click', function () { CO.sel = i; _sfx('ui_click'); Array.prototype.forEach.call(grid.children, function (n, k) { n.classList.toggle('on', k === i); }); takeBtn.classList.remove('disabled'); });
      card.addEventListener('dblclick', function () { CO.sel = i; Cho.take(); });
      grid.appendChild(card);
    });
    body.appendChild(grid);
    const takeBtn = _btn(CO.opts.take || 'Take reward', function () { Cho.take(); }, 'primary' + (CO.sel < 0 ? ' disabled' : ''));
    const foot = el('div', { class: 'dg-foot' });
    if (CO.opts.cancel !== false) foot.appendChild(_btn(CO.opts.cancel || 'Decide later', function () { Cho.close(); }));
    foot.appendChild(takeBtn);
    body.appendChild(foot);
  };
  Cho.take = function () {
    if (CO.sel < 0) { _notify('Choose a reward first.', 'warning'); _sfx('ui_error'); return; }
    CO.answered = true;
    const cb = CO.onPick, i = CO.sel, inst = CO.items[i];
    Cho.close();
    if (typeof cb === 'function') { try { cb(i, inst); } catch (err) { _report(err, 'choose callback'); } }
  };
  Cho.open = function (items, onPick, opts) {
    CO.items = (Array.isArray(items) ? items : []).map(function (x) { return typeof x === 'string' ? { tid: x, count: 1 } : x; }).filter(Boolean);
    CO.onPick = onPick; CO.sel = -1; CO.opts = opts || {}; CO.answered = false;
    if (Cho.panel && Cho.panel.setTitle) Cho.panel.setTitle(CO.opts.title || 'Choose your reward');
    if (Cho.isOpen()) Cho.render(); else _open('choose');
    return true;
  };
  Cho.onClose = function () { if (!CO.answered) { CO.answered = true; const cb = CO.onPick; CO.onPick = null; if (typeof cb === 'function') { try { cb(-1, null); } catch (err) { _report(err, 'choose cancel'); } } } };
  definePanel('choose', Cho, { title: 'Choose your reward', width: 560, pos: 'center', modal: true, remember: false });

  // ================================================================================================ registration & wiring
  UI.Inventory = Inv; UI.Character = Ch; UI.Abilities = Ab; UI.Journal = Jn; UI.Map = Mp; UI.Players = Pl;
  UI.Dialogue = Dg; UI.Vendor = Vd; UI.Travel = Tr; UI.Settings = St; UI.Choose = Cho;
  if (_has(UI, 'addCSS')) UI.addCSS(CSS); else { const st = document.createElement('style'); st.textContent = CSS; (document.head || document.documentElement).appendChild(st); }
  if (!_registerAll()) G.on('init', _registerAll);
  else G.on('init', _registerAll);          // re-run at init in case the HUD re-created its roots

  function _markAll() { for (let i = 0; i < _apis.length; i++) _apis[i].mark(); }
  G.on('inventoryChanged', function () { Inv.mark(); Vd.mark(); });
  G.on('equipChanged', function () { PV.needRebuild = true; Ch.mark(); Inv.mark(); Vd.mark(); });
  G.on('goldChanged', function () { Inv.mark(); Vd.mark(); Ab.mark(); Tr.mark(); });
  G.on('abilityTrained', function () { Ab.mark(); });
  G.on('hotbarChanged', function () { Ab.mark(); });
  G.on('playerLevelUp', function () { Ch.mark(); Ab.mark(); Jn.mark(); Vd.mark(); });
  G.on('titleEarned', function () { Ch.mark(); });
  G.on('effectsChanged', function () { Ch.mark(); });
  ['questAccepted', 'questProgress', 'questCompleted'].forEach(function (evt) { G.on(evt, function () { Jn.mark(); MP.dirty = true; }); });
  G.on('qualityChanged', function () { St.mark(); });
  G.on('zoneChanged', function () { MP.dirty = true; });
  G.on('customPlacesChanged', function () { MP.dirty = true; });
  G.on('questTracked', function () { Jn.mark(); MP.dirty = true; });
  G.on('questAbandoned', function () { Jn.mark(); MP.dirty = true; });
  G.on('load', function () { PV.needRebuild = true; MP.img = null; _markAll(); St.apply(); });
  G.on('gameStart', function () { PV.needRebuild = true; MP.img = null; _markAll(); });
  G.on('panelClosed', function (id) { if (id === 'vendor' || id === 'dialogue' || id === 'travel') _dndReset(); });
  G.on('update', function (dt) {
    dt = clamp(_num(dt), 0, 0.1);
    if (_dirty.size) _flush();
    try {
      _pvRender(dt);
      Mp.update(dt);
      Pl.update(dt);
      Vd.update(dt);
    } catch (err) { if (!G.__panelsErr) { G.__panelsErr = true; _report(err, 'panels update'); } }
  });
  G.log('31_ui_panels ready');
})();
