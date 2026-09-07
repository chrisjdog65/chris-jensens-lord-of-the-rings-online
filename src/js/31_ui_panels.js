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
.pn-fade { position: absolute; inset: 0; background: #000; opacity: 0; pointer-events: none; transition: opacity .35s ease; z-index: 90; }
.pn-fade.on { opacity: 1; pointer-events: auto; }
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
.inv-top .tab { padding: 4px 8px; font-size: 11px; }
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
.ch-weapons { display: flex; gap: 14px; padding-bottom: 14px; }
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
  document.addEventListener('keydown', function (ev) { if (_menuEl && ev.key === 'Escape') _menuClose(); }, true);
  window.addEventListener('blur', _menuClose);
  UI.contextMenu = _menu;
  UI.closeContextMenu = _menuClose;

  // ================================================================================================ fade overlay
  let _fadeEl = null, _fadeTimer = 0;
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
