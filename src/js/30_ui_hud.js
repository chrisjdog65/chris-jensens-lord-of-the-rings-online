/* ==== 30_ui_hud.js — G.UI root + the entire in-game HUD for Chris Jensen's Lord of the Rings Online.
   Panel manager (draggable, z-ordered, modal, remembered positions, key toggles), tooltip, notifications,
   floating combat text, chat with tabs & slash commands, player/target frames, hotbar with cooldown sweeps and
   drag & drop, buffs, cast bar, XP bar, compass, interact prompt, auto-quest strip, FPS counter, death screen,
   loot window, zone banner, quest tracker, minimap and the F1 key-help panel.

   Public API (SPEC §7.1) — all on G.UI:
     init(), update(dt), showHUD(bool), addCSS(cssText) → <style>, hudVisible
     registerPanel(id, def) → panel        def = { title, build(bodyEl, panel), onOpen(panel), onClose(panel), width, height,
                                            pos:'center'|'left'|'right'|'bottom'|{x,y}, modal, key:'KeyI', noEsc, footer(footerEl, panel),
                                            buttons:[{label, cls, onClick}], remember (default true), sound (default true) }
                                            panel = { id, el, body, footer, titleEl, def, open, built, z, isOpen(), close(), refresh(), setTitle(t) }
     openPanel(id), closePanel(id), togglePanel(id), isOpen(id), closeAll(), anyOpen(), refresh(id), bringToFront(id),
     getPanel(id), topPanel(), anyModal()        emits panelOpened(id) / panelClosed(id)
     tooltip.show(html, x, y), tooltip.hide(), tooltip.visible, bindTooltip(el, htmlOrFn, opts?)
     notify(text, kind='info'|'quest'|'level'|'warning'|'loot'|'gold'|'system'), notifyBig(text, sub?)
     floatText(worldPos, text, color, {crit, size, offsetY, dx})
     chat(text, channel='world', from?), chatInput(), chatSend(text), chatCommand(line), chatChannels
     showLoot(items, gold), hideLoot()
     confirm(text, onYes, onNo, opts?{title, yes, no}), setCursor(kind), formatMoney(copper) → html, iconFor(x) → html
     setWaypoint(x, z, label?), clearWaypoint(), waypoint  (custom map waypoint shown on compass + minimap)
     DeathScreen { show(), hide(), visible }, minimap { zoom, setZoom(z), redraw() }, tracker { collapsed, refresh() }
     fps (smoothed number), hotbarRefresh(), keyName(code)
   Keys handled here (in update, via G.Input.pressed, never while typing): every registered panel's def.key, F1 (keyhelp),
   Shift+/ (keyhelp), B (auto-quest toggle), Enter (chat), Esc (close topmost panel, else settings panel when registered).
   Hotbar keys are NOT executed here (20_player/21_combat own that) — the HUD only flashes the slot.
   Assumptions about other modules (all optional, everything degrades gracefully when absent):
     G.Player.camera (THREE camera), G.Player.cam.yaw (0 = looking toward −Z, positive = turning left), G.Player.interactTarget,
     G.Player.respawn(); G.Combat.useAbility(ent, id), G.Combat.removeEffect(ent, id); G.Progress.setHotbar(slot, id), xpToNext();
     G.Quests.active()/tracked/setTracked/nextObjective/state/completion/available/turnins; G.AutoQuest.active/start/stop/status();
     G.Terrain.mapCanvas(1024) (north = top, x → right), G.Terrain.zoneAt; G.Data.world.zones/towns/npcs, G.Data.questById;
     player.casting = { ability|id|name, elapsed|t|start, duration|total|castTime }; ent.questMark ('!'|'?'|'?grey') on NPCs.
   Private helpers are prefixed with _ (module-local). ==== */
(function () {
  'use strict';
  const G = window.G;
  const UI = G.UI = G.UI || {};
  const el = G.el;
  const esc = G.escapeHTML;
  const clamp = G.clamp;

  // ------------------------------------------------------------------------------------------------ small utils
  function _num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : (d || 0); }
  function _str(v) { return v == null ? '' : String(v); }
  function _player() { return G.state && G.state.player; }
  function _now() { return (G.time && typeof G.time.now === 'number') ? G.time.now : 0; }
  function _sfx(name) { try { if (G.Audio && typeof G.Audio.sfx === 'function' && G.Audio.ready !== false) G.Audio.sfx(name); } catch (_) { /* ignore */ } }
  function _has(obj, fn) { return !!(obj && typeof obj[fn] === 'function'); }
  function _vw() { return window.innerWidth || document.documentElement.clientWidth || 1280; }
  function _vh() { return window.innerHeight || document.documentElement.clientHeight || 720; }
  function _hex(c) { if (typeof c === 'number') return G.hexStr ? G.hexStr(c) : '#' + ('000000' + (c >>> 0).toString(16)).slice(-6); return _str(c) || '#ffffff'; }
  function _clock(dayTime) {
    let h = _num(dayTime, 8); h = ((h % 24) + 24) % 24;
    const hh = Math.floor(h), mm = Math.floor((h - hh) * 60);
    return G.pad2(hh) + ':' + G.pad2(mm);
  }
  function _abilityOf(id) {
    if (!id) return null;
    if (typeof id === 'object') return id;
    if (G.Data && typeof G.Data.abilityById === 'function') return G.Data.abilityById(id);
    return (G.Data && G.Data.abilities && G.Data.abilities[id]) || null;
  }
  function _classOf(ent) { return (ent && ent.cls && G.Data && G.Data.classById && G.Data.classById[ent.cls]) || null; }
  function _questData(id) { return (id && G.Data && G.Data.questById && G.Data.questById[id]) || null; }
  function _zoneData(id) {
    const w = G.Data && G.Data.world;
    if (!w || !id) return null;
    if (w.zoneById && w.zoneById[id]) return w.zoneById[id];
    if (Array.isArray(w.zones)) for (let i = 0; i < w.zones.length; i++) if (w.zones[i].id === id) return w.zones[i];
    return null;
  }
  function _npcName(id) {
    if (!id) return '';
    const w = G.Data && G.Data.world;
    if (w && w.npcById && w.npcById[id]) return w.npcById[id].name || id;
    if (w && Array.isArray(w.npcs)) for (let i = 0; i < w.npcs.length; i++) if (w.npcs[i].id === id) return w.npcs[i].name || id;
    if (_has(G.NPCs, 'get')) { const n = G.NPCs.get(id); if (n && n.name) return n.name; }
    return G.titleCase(id);
  }
  // tiny local LCG for cosmetic jitter (never touches G.rand so gameplay RNG stays untouched)
  let _jit = 1234567;
  function _jitter() { _jit = (_jit * 1103515245 + 12345) & 0x7fffffff; return _jit / 0x7fffffff; }

  // ------------------------------------------------------------------------------------------------ CSS
  UI.addCSS = function (text) {
    const s = document.createElement('style');
    s.setAttribute('data-ui', 'true');
    s.textContent = String(text || '');
    (document.head || document.documentElement).appendChild(s);
    return s;
  };

  const HUD_CSS = `
/* ---- layers ---- */
#hud, #panels, #overlays { position: absolute; inset: 0; pointer-events: none; }
#hud > *, #panels > *, #overlays > * { pointer-events: auto; }
#hud { z-index: 10; } #panels { z-index: 20; } #overlays { z-index: 30; }
#hud .passthru, #notices, #floatLayer, #bigNotice, #zoneBanner, #castbar, #interactPrompt, #compass { pointer-events: none !important; }
.money-g { color: #ffd54a; } .money-s { color: #d6dae3; } .money-c { color: #d08a4a; }
.money-g::after, .money-s::after, .money-c::after { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin: 0 3px 0 2px; vertical-align: 0; box-shadow: inset 0 0 0 1px rgba(0,0,0,.6); }
.money-g::after { background: radial-gradient(circle at 35% 35%, #fff2a8, #d4a017); }
.money-s::after { background: radial-gradient(circle at 35% 35%, #ffffff, #8f96a3); }
.money-c::after { background: radial-gradient(circle at 35% 35%, #f2b482, #8a4a1c); }
.ui-hidden { display: none !important; }

/* ---- panels ---- */
.panel { min-height: 80px; }
.panel .panel-title { cursor: move; user-select: none; }
.panel .panel-title .ptitle { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.panel.dragging { opacity: .92; }
.panel.ui-open { animation: panelIn .18s ease-out; }
@keyframes panelIn { from { opacity: 0; transform: scale(.97); } to { opacity: 1; transform: none; } }
#modalBackdrop { position: absolute; inset: 0; background: rgba(0,0,0,.55); backdrop-filter: blur(2px); }
.panel-body p { margin: 0 0 8px; }
.panel-body p:last-child { margin-bottom: 0; }
.confirm-text { font-size: 15px; line-height: 1.4; min-width: 240px; max-width: 420px; padding: 4px 2px; }

/* ---- tooltip ---- */
#tooltip .tt-sub { color: var(--parch-dim); font-size: 12px; }
#tooltip .tt-key { color: var(--gold-bright); }
#tooltip .tt-warn { color: var(--red); }

/* ---- notices ---- */
#notices { position: absolute; left: 50%; top: 37%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 5px; width: 640px; max-width: 90vw; }
#notices .notice { position: static; transform: none; font-size: 17px; letter-spacing: .04em; padding: 2px 10px; animation: noticeIn .25s ease-out; display: flex; align-items: center; gap: 8px; text-shadow: 0 2px 6px #000, 0 0 12px rgba(0,0,0,.6); transition: opacity .4s ease, transform .4s ease; }
#notices .notice .n-ico { font-size: 15px; opacity: .9; }
#notices .notice.out { opacity: 0; transform: translateY(-8px); }
#notices .n-info { color: var(--parch); } #notices .n-system { color: #9fd0ff; }
#notices .n-quest { color: var(--gold-bright); text-shadow: 0 2px 6px #000, 0 0 14px rgba(255,200,80,.55); }
#notices .n-level { color: #fff7d6; text-shadow: 0 2px 6px #000, 0 0 16px rgba(255,220,120,.8); font-size: 20px; }
#notices .n-warning { color: #ff7a66; } #notices .n-loot { color: #a6e39f; } #notices .n-gold { color: #ffd54a; }
@keyframes noticeIn { from { opacity: 0; transform: translateY(-14px) scale(.96); } to { opacity: 1; transform: none; } }
#bigNotice { position: absolute; left: 50%; top: 27%; transform: translate(-50%, -50%); text-align: center; opacity: 0; }
#bigNotice.show { animation: bigIn 3s ease-out forwards; }
#bigNotice .big-title { font-family: var(--font-head); font-weight: 700; font-size: 46px; letter-spacing: .12em; color: #fff3c4; text-shadow: 0 0 18px rgba(255,205,90,.9), 0 0 42px rgba(255,180,60,.55), 0 3px 8px #000; white-space: nowrap; }
#bigNotice .big-sub { font-family: var(--font-head); font-size: 20px; color: var(--gold-bright); letter-spacing: .08em; margin-top: 6px; text-shadow: 0 2px 6px #000, 0 0 10px rgba(255,200,80,.5); }
#bigNotice .big-rule { width: 320px; height: 2px; margin: 8px auto 0; background: linear-gradient(90deg, transparent, var(--gold-bright), transparent); }
@keyframes bigIn { 0% { opacity: 0; transform: translate(-50%, -50%) scale(.8); } 12% { opacity: 1; transform: translate(-50%, -50%) scale(1.04); } 20% { transform: translate(-50%, -50%) scale(1); } 80% { opacity: 1; } 100% { opacity: 0; transform: translate(-50%, -56%) scale(1); } }
#zoneBanner { position: absolute; left: 50%; top: 19%; transform: translate(-50%, -50%); text-align: center; opacity: 0; }
#zoneBanner.show { animation: zoneIn 4.2s ease-out forwards; }
#zoneBanner .zb-name { font-family: var(--font-head); font-size: 40px; font-weight: 700; letter-spacing: .18em; color: #f3e6c2; text-shadow: 0 3px 10px #000, 0 0 24px rgba(255,220,140,.45); white-space: nowrap; }
#zoneBanner .zb-sub { font-family: var(--font-head); font-size: 15px; letter-spacing: .3em; color: var(--gold); text-transform: uppercase; margin-top: 4px; text-shadow: 0 2px 6px #000; }
#zoneBanner .zb-rule { width: 380px; height: 1px; margin: 6px auto 0; background: linear-gradient(90deg, transparent, var(--gold), transparent); }
@keyframes zoneIn { 0% { opacity: 0; letter-spacing: .3em; } 15% { opacity: 1; } 78% { opacity: 1; } 100% { opacity: 0; } }

/* ---- floating combat text ---- */
#floatLayer { position: absolute; inset: 0; overflow: hidden; }
.ftxt { position: absolute; left: 0; top: 0; font-family: var(--font-head); font-weight: 700; font-size: 18px; color: #fff; white-space: nowrap; text-shadow: 0 1px 2px #000, 0 0 4px #000, 0 0 8px rgba(0,0,0,.6); will-change: transform, opacity; }
.ftxt.crit { font-size: 27px; letter-spacing: .04em; text-shadow: 0 0 6px rgba(255,180,60,.9), 0 1px 2px #000, 0 0 12px rgba(255,120,30,.5); }

/* ---- player frame ---- */
#playerFrame { left: 12px; top: 12px; width: 252px; display: flex; gap: 8px; align-items: center; padding: 6px 8px 6px 6px; }
.pf-portrait { position: relative; width: 54px; height: 54px; flex: 0 0 54px; border-radius: 50%; border: 2px solid var(--gold-dim); display: flex; align-items: center; justify-content: center; font-size: 27px; line-height: 1; background: radial-gradient(circle at 50% 35%, #3a2b14, #0b0906 75%); box-shadow: 0 0 10px rgba(0,0,0,.7), inset 0 0 10px rgba(0,0,0,.8); text-shadow: 0 1px 2px #000; }
.pf-portrait .pf-level { position: absolute; right: -8px; bottom: -6px; min-width: 22px; height: 20px; line-height: 18px; padding: 0 5px; text-align: center; font-family: var(--font-head); font-size: 12px; font-weight: 700; color: #fff; background: linear-gradient(180deg, #8a6a2c, #4d3814); border: 1px solid var(--gold); border-radius: 10px; text-shadow: 0 1px 1px #000; }
.pf-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.pf-name { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; font-family: var(--font-head); font-size: 14px; color: var(--gold-bright); text-shadow: 0 1px 2px #000; }
.pf-name .pf-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pf-name .pf-cls { font-size: 10px; letter-spacing: .08em; color: var(--parch-dim); text-transform: uppercase; white-space: nowrap; }
#playerFrame .bar.morale-bar { height: 15px; } #playerFrame .bar.power-bar { height: 11px; } #playerFrame .bar.power-bar .text { font-size: 10px; }
#playerFrame .bar.xp-mini { height: 4px; border-color: rgba(111,83,34,.7); }
#playerFrame .bar .fill { transition: width .12s linear; }
#playerFrame.in-combat { border-color: #8a3a2a; box-shadow: 0 4px 14px rgba(0,0,0,.5), 0 0 10px rgba(200,52,42,.35); }
#playerFrame.dead .pf-portrait { filter: grayscale(1) brightness(.6); }

/* ---- target frame ---- */
#targetFrame { left: 272px; top: 12px; width: 222px; display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; }
.tf-head { display: flex; align-items: baseline; gap: 6px; font-family: var(--font-head); font-size: 13px; }
.tf-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--parch); text-shadow: 0 1px 2px #000; }
.tf-level { font-size: 12px; font-weight: 700; white-space: nowrap; text-shadow: 0 1px 2px #000; }
.tf-con { font-size: 9px; letter-spacing: .1em; text-transform: uppercase; opacity: .85; }
#targetFrame .bar.hp-bar { height: 14px; }
#targetFrame .bar.cast-bar { height: 8px; }
#targetFrame .bar.cast-bar .text { font-size: 9px; }
.tf-effects { display: flex; gap: 3px; flex-wrap: wrap; min-height: 0; }
.tf-effects:empty { display: none; }
.tf-effects .fx { width: 18px; height: 18px; border: 1px solid var(--border); border-radius: 3px; background: rgba(0,0,0,.6); font-size: 12px; line-height: 16px; text-align: center; }
.tf-effects .fx.debuff { border-color: #a33; }
.tf-effects .fx.buff { border-color: #4a7a3a; }
#targetFrame.friendly .tf-name { color: #bfe8b8; }

/* ---- buffs ---- */
#buffs { position: absolute; left: 12px; top: 100px; display: flex; flex-wrap: wrap; gap: 4px; width: 300px; }
#buffs:empty { display: none; }
.buff { position: relative; width: 30px; height: 30px; border: 1px solid #4a7a3a; border-radius: 4px; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; font-size: 17px; line-height: 1; cursor: pointer; box-shadow: 0 2px 6px rgba(0,0,0,.6); text-shadow: 0 1px 2px #000; }
.buff.debuff { border-color: #a33; } .buff.dot { border-color: #a33; } .buff.stun, .buff.root, .buff.slow { border-color: #c48bff; } .buff.hot { border-color: #5fbf5a; }
.buff .b-time { position: absolute; left: 0; right: 0; bottom: -13px; text-align: center; font-size: 10px; color: var(--parch); text-shadow: 0 1px 2px #000, 0 0 3px #000; font-family: var(--font-ui); }
.buff .b-bar { position: absolute; left: 1px; right: 1px; bottom: 1px; height: 2px; background: var(--gold); transform-origin: left; }
.buff:hover { border-color: var(--gold-bright); }
#buffs { padding-bottom: 14px; }

/* ---- hotbar ---- */
#hotbar { left: 50%; bottom: 14px; transform: translateX(-50%); display: grid; grid-template-columns: repeat(10, 44px); gap: 4px; padding: 6px; background: linear-gradient(180deg, rgba(20,15,9,.78), rgba(8,6,3,.85)); }
#hotbar .slot { overflow: visible; }
#hotbar .slot .ab-icon { font-size: 24px; line-height: 1; filter: drop-shadow(0 1px 1px #000); pointer-events: none; }
#hotbar .slot.empty .ab-icon { display: none; }
#hotbar .slot.empty { background: rgba(0,0,0,.35); opacity: .55; }
#hotbar .slot .keybind { z-index: 2; }
#hotbar .slot .cd { --p: 0%; background: conic-gradient(rgba(0,0,0,.82) var(--p), rgba(0,0,0,.28) 0); flex-direction: column; font-family: var(--font-ui); font-weight: 600; font-size: 14px; text-shadow: 0 0 3px #000, 0 1px 2px #000; z-index: 1; }
#hotbar .slot .cd.gcd { background: rgba(0,0,0,.35); font-size: 0; }
#hotbar .slot.nopower .ab-icon { filter: grayscale(.6) brightness(.55) drop-shadow(0 0 3px #2f6fd6); }
#hotbar .slot.norange .keybind { color: #ff7a66; }
#hotbar .slot.norange .ab-icon { filter: brightness(.7) drop-shadow(0 1px 1px #000); }
#hotbar .slot.press { border-color: var(--gold-bright); box-shadow: 0 0 12px rgba(255,224,138,.7), inset 0 0 10px rgba(255,224,138,.35); transform: scale(.94); }
#hotbar .slot.dragover { border-color: var(--gold-bright); box-shadow: 0 0 12px rgba(255,224,138,.7); background: rgba(212,175,90,.2); }
#hotbar .slot.dragging { opacity: .4; }
#hotbar .slot.active-stance { border-color: #d4af5a; box-shadow: inset 0 0 8px rgba(212,175,90,.45), 0 0 6px rgba(212,175,90,.35); }

/* ---- cast bar / interact / xp ---- */
#castbar { left: 50%; bottom: 128px; transform: translateX(-50%); width: 300px; padding: 3px 4px; }
#castbar .bar { height: 18px; }
#castbar .cb-name { position: absolute; inset: 0; display: flex; align-items: center; justify-content: space-between; padding: 0 8px; font-family: var(--font-head); font-size: 12px; color: #fff; text-shadow: 0 1px 2px #000, 0 0 3px #000; }
#interactPrompt { left: 50%; bottom: 156px; transform: translateX(-50%); padding: 5px 12px; font-size: 14px; display: flex; align-items: center; gap: 8px; white-space: nowrap; background: rgba(8,6,3,.7); animation: fadeIn .2s ease-out; }
#interactPrompt .keycap { font-size: 12px; line-height: 18px; min-width: 22px; }
#interactPrompt .ip-verb { color: var(--parch); } #interactPrompt .ip-name { color: var(--gold-bright); font-family: var(--font-head); font-size: 13px; }
#xpbar { position: absolute; left: 0; right: 0; bottom: 0; height: 8px; background: rgba(0,0,0,.75); border-top: 1px solid rgba(111,83,34,.8); cursor: help; }
#xpbar .xp-fill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: linear-gradient(180deg, #d5b3ff, #6f45c9); box-shadow: 0 0 8px rgba(185,140,255,.7); transition: width .25s ease-out; }
#xpbar .xp-ticks { position: absolute; inset: 0; background: repeating-linear-gradient(90deg, transparent 0, transparent calc(10% - 1px), rgba(0,0,0,.55) calc(10% - 1px), rgba(0,0,0,.55) 10%); pointer-events: none; }
#xpbar .xp-rest { position: absolute; left: 0; top: 0; bottom: 0; background: rgba(120,90,200,.25); }

/* ---- compass ---- */
#compass { position: absolute; left: 50%; top: 10px; transform: translateX(-50%); width: min(360px, calc(100vw - 1000px)); min-width: 260px; height: 32px; }
#compass canvas { width: 100%; height: 100%; display: block; }

/* ---- auto-quest strip ---- */
#autoquestStrip { left: 50%; top: 100px; transform: translateX(-50%); width: min(620px, calc(100vw - 690px)); min-width: 420px; display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 10px; background: linear-gradient(90deg, rgba(60,44,18,.85), rgba(12,9,5,.85)); border-color: var(--gold-dim); }
#autoquestStrip .aq-label { font-family: var(--font-head); font-size: 12px; letter-spacing: .08em; color: var(--gold-bright); white-space: nowrap; }
#autoquestStrip .aq-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
#autoquestStrip .aq-text b { color: var(--gold-bright); font-weight: 600; }
#autoquestStrip .aq-count { font-size: 12px; color: var(--parch-dim); white-space: nowrap; }
#autoquestStrip .bar { width: 96px; height: 9px; flex: 0 0 96px; }
#autoquestStrip .aq-dot { width: 8px; height: 8px; border-radius: 50%; background: #5fbf5a; box-shadow: 0 0 6px #5fbf5a; animation: pulse 1.2s ease-in-out infinite; flex: 0 0 8px; }

/* ---- fps ---- */
#fps { right: 244px; top: 12px; padding: 3px 7px; font-family: var(--font-ui); font-size: 12px; color: #bfe8b8; background: rgba(0,0,0,.55); white-space: nowrap; }
#fps.low { color: #ff9a6a; }

/* ---- minimap ---- */
#minimap { right: 12px; top: 12px; width: 224px; display: flex; flex-direction: column; align-items: center; background: none; border: none; box-shadow: none; padding: 0; }
.mm-ring { position: relative; width: 204px; height: 204px; }
.mm-ring canvas { position: absolute; left: 2px; top: 2px; width: 200px; height: 200px; border-radius: 50%; display: block; cursor: crosshair; }
.mm-frame { position: absolute; inset: 0; border-radius: 50%; border: 3px solid #a67c2e; box-shadow: 0 0 0 1px #2a1e0c, 0 4px 14px rgba(0,0,0,.7), inset 0 0 14px rgba(0,0,0,.75); pointer-events: none; background: transparent; }
.mm-frame::after { content: ''; position: absolute; inset: 2px; border-radius: 50%; border: 1px solid rgba(255,224,138,.35); }
.mm-n { position: absolute; top: -9px; left: 50%; transform: translateX(-50%); width: 20px; height: 20px; line-height: 18px; text-align: center; font-family: var(--font-head); font-weight: 700; font-size: 11px; color: var(--gold-bright); background: #1a130a; border: 1px solid var(--gold); border-radius: 50%; box-shadow: 0 2px 6px #000; }
.mm-zoom { position: absolute; right: -2px; bottom: 6px; display: flex; flex-direction: column; gap: 3px; }
.mm-zoom .btn { width: 22px; height: 22px; padding: 0; font-size: 14px; line-height: 1; border-radius: 50%; }
.mm-info { margin-top: 8px; text-align: center; text-shadow: 0 1px 2px #000, 0 0 4px #000; line-height: 1.2; }
.mm-zone { font-family: var(--font-head); font-size: 13px; color: var(--gold-bright); letter-spacing: .04em; white-space: nowrap; }
.mm-sub { font-size: 12px; color: var(--parch-dim); display: flex; gap: 10px; justify-content: center; font-family: var(--font-ui); }
.mm-sub span { white-space: nowrap; }

/* ---- quest tracker ---- */
#questTracker { position: absolute; right: 12px; top: 286px; width: 252px; max-height: min(46vh, calc(100vh - 470px)); display: flex; flex-direction: column; text-shadow: 0 1px 2px #000, 0 0 4px #000; }
.qt-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 3px; border-bottom: 1px solid rgba(212,175,90,.4); font-family: var(--font-head); font-size: 12px; letter-spacing: .1em; color: var(--gold); text-transform: uppercase; cursor: pointer; }
.qt-head .qt-toggle { font-size: 11px; color: var(--parch-dim); }
.qt-list { overflow-y: auto; min-height: 0; padding: 4px 2px 2px 4px; }
#questTracker.collapsed .qt-list { display: none; }
.qt-quest { margin-bottom: 7px; }
.qt-name { display: flex; align-items: baseline; gap: 4px; cursor: pointer; line-height: 1.25; }
.qt-name .quest-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qt-name:hover .quest-name { color: #fff; }
.qt-star { color: var(--gold-bright); font-size: 12px; flex: 0 0 auto; }
.qt-quest.tracked .quest-name { color: #fff3c4; }
.qt-quest .quest-obj { padding-left: 14px; cursor: pointer; line-height: 1.25; position: relative; }
.qt-quest .quest-obj::before { content: '•'; position: absolute; left: 4px; color: var(--parch-dim); }
.qt-quest .quest-obj.done::before { content: '✓'; color: #7fd47a; }
.qt-quest .quest-obj:hover { color: #fff; }
.qt-quest .quest-obj .qo-count { color: var(--gold-bright); }
.qt-quest .quest-obj.done .qo-count { color: #7fd47a; }
.qt-ready { padding-left: 14px; font-size: 12px; color: #7fd47a; font-style: italic; }
.qt-empty { font-size: 12px; color: var(--parch-dim); padding: 4px; font-style: italic; }
.qt-more { font-size: 11px; color: var(--parch-dim); padding-left: 4px; }

/* ---- chat ---- */
#chat { position: absolute; left: 12px; bottom: 14px; width: 360px; height: 206px; display: flex; flex-direction: column; background: rgba(8,6,3,.5); border: 1px solid rgba(111,83,34,.75); border-radius: 6px; backdrop-filter: blur(3px); transition: opacity .25s; }
#chat:not(:hover):not(.focused) { opacity: .82; }
#chat.collapsed { height: auto; }
#chat.collapsed .chat-log, #chat.collapsed .chat-input { display: none; }
.chat-tabs { display: flex; align-items: center; gap: 2px; padding: 3px 4px 0; border-bottom: 1px solid rgba(111,83,34,.55); }
.chat-tab { position: relative; font-family: var(--font-head); font-size: 11px; letter-spacing: .05em; padding: 2px 8px 3px; color: var(--parch-dim); cursor: pointer; border-radius: 3px 3px 0 0; border: 1px solid transparent; border-bottom: none; }
.chat-tab:hover { color: var(--gold-bright); }
.chat-tab.active { color: var(--gold-bright); background: rgba(212,175,90,.14); border-color: rgba(111,83,34,.6); }
.chat-tab.unread::after { content: ''; position: absolute; right: 2px; top: 3px; width: 5px; height: 5px; border-radius: 50%; background: var(--gold-bright); box-shadow: 0 0 4px var(--gold-bright); }
.chat-tabs .chat-collapse { margin-left: auto; cursor: pointer; color: var(--parch-dim); font-size: 12px; padding: 0 6px; }
.chat-tabs .chat-collapse:hover { color: var(--gold-bright); }
.chat-log { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 8px; font-size: 13px; line-height: 1.28; font-family: var(--font-ui); overscroll-behavior: contain; }
.chat-line { word-wrap: break-word; overflow-wrap: anywhere; text-shadow: 0 1px 1px #000; }
.chat-time { color: rgba(184,173,148,.55); font-size: 11px; margin-right: 4px; }
.chat-from { font-weight: 600; }
.chat-line.ch-say { color: #ece4cf; } .chat-line.ch-world { color: #f0b45c; } .chat-line.ch-system { color: #9fd0ff; }
.chat-line.ch-combat { color: #d9a06a; } .chat-line.ch-fellowship { color: #8fd48a; } .chat-line.ch-emote { color: #c8a0ff; font-style: italic; }
.chat-line.ch-whisper { color: #ff8ce8; } .chat-line.ch-loot { color: #ffe86b; } .chat-line.ch-admin { color: #ff6a5a; } .chat-line.ch-quest { color: var(--gold-bright); }
.chat-input { display: flex; gap: 4px; padding: 4px 6px; border-top: 1px solid rgba(111,83,34,.55); align-items: center; }
.chat-input .chat-ch { font-family: var(--font-head); font-size: 10px; letter-spacing: .05em; color: var(--parch-dim); min-width: 30px; text-align: right; }
.chat-input input { flex: 1; min-width: 0; font-size: 13px; padding: 3px 8px; background: rgba(0,0,0,.45); border-color: rgba(111,83,34,.7); }
.chat-input input::placeholder { color: rgba(184,173,148,.5); font-style: italic; }

/* ---- loot window ---- */
#lootWindow { right: 12px; bottom: 14px; width: 240px; max-height: 150px; overflow: hidden; display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; transition: opacity .5s ease; animation: fadeIn .2s ease-out; }
#lootWindow.out { opacity: 0; }
#lootWindow .lw-title { font-family: var(--font-head); font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: var(--gold); border-bottom: 1px solid rgba(111,83,34,.6); padding-bottom: 2px; margin-bottom: 2px; }
#lootWindow .lw-row { display: flex; align-items: center; gap: 6px; font-size: 13px; line-height: 1.2; }
#lootWindow .lw-row .icon { flex: 0 0 auto; }
#lootWindow .lw-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#lootWindow .lw-count { color: var(--parch-dim); font-size: 12px; }
#lootWindow .lw-gold { font-size: 13px; padding-left: 2px; }

/* ---- death screen ---- */
#deathScreen { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; background: radial-gradient(ellipse at center, rgba(40,0,0,.35) 0%, rgba(20,0,0,.72) 60%, rgba(0,0,0,.92) 100%); animation: deathIn 1.2s ease-out; }
@keyframes deathIn { from { opacity: 0; } to { opacity: 1; } }
#deathScreen .ds-title { font-family: var(--font-head); font-size: 52px; font-weight: 700; letter-spacing: .16em; color: #e8c8b0; text-shadow: 0 0 22px rgba(255,80,50,.55), 0 3px 10px #000; }
#deathScreen .ds-sub { font-family: var(--font-body); font-style: italic; font-size: 18px; color: var(--parch-dim); text-shadow: 0 2px 6px #000; }
#deathScreen .ds-count { font-family: var(--font-ui); font-size: 14px; color: var(--parch-dim); margin-top: 6px; }
#deathScreen .btn { margin-top: 10px; }

/* ---- key help ---- */
.kh-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 22px; }
.kh-group h4 { margin: 4px 0 4px; }
.kh-row { display: flex; align-items: center; gap: 8px; padding: 2px 0; font-size: 13px; }
.kh-row .kh-keys { display: flex; gap: 3px; flex: 0 0 118px; flex-wrap: wrap; }
.kh-row .kh-desc { color: var(--parch); }
.kh-note { margin-top: 8px; font-size: 12px; color: var(--parch-dim); font-style: italic; }
@media (max-width: 1400px) { #compass { width: 280px; } }
`;

  // ------------------------------------------------------------------------------------------------ panel manager
  const panels = {};
  const _zBase = 100;
  let _zTop = _zBase;
  let _panelsRoot = null, _backdrop = null;
  let _relockArmed = false;
  let _posStore = null;
  const POS_KEY = 'cj_ui_pos';

  function _loadPos() {
    if (_posStore) return _posStore;
    _posStore = {};
    try { const raw = window.localStorage && window.localStorage.getItem(POS_KEY); if (raw) { const o = JSON.parse(raw); if (o && typeof o === 'object') _posStore = o; } } catch (_) { /* ignore */ }
    return _posStore;
  }
  function _savePos(id, x, y) {
    const st = _loadPos();
    st[id] = { x: Math.round(x), y: Math.round(y), w: _vw(), h: _vh() };
    try { if (window.localStorage) window.localStorage.setItem(POS_KEY, JSON.stringify(st)); } catch (_) { /* ignore */ }
  }
  function _forgetPos(id) {
    const st = _loadPos();
    delete st[id];
    try { if (window.localStorage) window.localStorage.setItem(POS_KEY, JSON.stringify(st)); } catch (_) { /* ignore */ }
  }
  function _clampPanel(p, x, y) {
    const w = p.el.offsetWidth || 300, h = p.el.offsetHeight || 200;
    const vw = _vw(), vh = _vh();
    x = clamp(x, Math.min(0, vw - w), Math.max(0, vw - w));
    y = clamp(y, 0, Math.max(0, vh - Math.min(h, 48)));
    if (y + h > vh) y = Math.max(0, vh - h);
    p.el.style.left = Math.round(x) + 'px';
    p.el.style.top = Math.round(y) + 'px';
    p.x = x; p.y = y;
  }
  function _placePanel(p) {
    const def = p.def;
    const w = p.el.offsetWidth || 300, h = p.el.offsetHeight || 200;
    const vw = _vw(), vh = _vh();
    const saved = def.remember !== false ? _loadPos()[p.id] : null;
    if (saved && typeof saved.x === 'number' && typeof saved.y === 'number') {
      // scale remembered position if the viewport changed
      const sx = saved.w ? vw / saved.w : 1, sy = saved.h ? vh / saved.h : 1;
      _clampPanel(p, saved.x * sx, saved.y * sy);
      return;
    }
    const pos = def.pos || 'center';
    let x, y;
    if (pos && typeof pos === 'object') { x = _num(pos.x, 0); y = _num(pos.y, 0); }
    else if (pos === 'left') { x = 24; y = Math.max(20, (vh - h) * 0.45); }
    else if (pos === 'right') { x = vw - w - 24; y = Math.max(20, (vh - h) * 0.45); }
    else if (pos === 'bottom') { x = (vw - w) / 2; y = vh - h - 130; }
    else if (pos === 'top') { x = (vw - w) / 2; y = 60; }
    else { x = (vw - w) / 2; y = (vh - h) / 2; }
    _clampPanel(p, x, y);
  }
  function _applySize(p) {
    const d = p.def;
    if (d.width != null) p.el.style.width = typeof d.width === 'number' ? d.width + 'px' : String(d.width);
    if (d.height != null) p.el.style.height = typeof d.height === 'number' ? d.height + 'px' : String(d.height);
    if (d.minWidth != null) p.el.style.minWidth = typeof d.minWidth === 'number' ? d.minWidth + 'px' : String(d.minWidth);
  }
  function _openList() {
    const out = [];
    for (const id in panels) if (panels[id].open) out.push(panels[id]);
    out.sort(function (a, b) { return a.z - b.z; });
    return out;
  }
  function _updateBackdrop() {
    if (!_backdrop) return;
    let top = null;
    for (const id in panels) { const p = panels[id]; if (p.open && p.def.modal && (!top || p.z > top.z)) top = p; }
    if (top) { _backdrop.hidden = false; _backdrop.style.zIndex = String(top.z - 1); }
    else _backdrop.hidden = true;
  }
  function _startDrag(p, e) {
    if (e.button !== 0) return;
    if (e.target && e.target.closest && e.target.closest('.close, .btn, input, select, button')) return;
    e.preventDefault();
    UI.bringToFront(p.id);
    const startX = e.clientX, startY = e.clientY;
    const ox = p.el.offsetLeft, oy = p.el.offsetTop;
    let moved = false;
    p.el.classList.add('dragging');
    UI.tooltip.hide();
    const onMove = function (ev) {
      const nx = ox + (ev.clientX - startX), ny = oy + (ev.clientY - startY);
      moved = true;
      _clampPanel(p, nx, ny);
    };
    const onUp = function () {
      document.removeEventListener('pointermove', onMove, true);
      document.removeEventListener('pointerup', onUp, true);
      p.el.classList.remove('dragging');
      if (moved && p.def.remember !== false) _savePos(p.id, p.el.offsetLeft, p.el.offsetTop);
    };
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('pointerup', onUp, true);
  }
  function _buildPanel(p) {
    const body = p.body;
    while (body.firstChild) body.removeChild(body.firstChild);
    p.built = true;
    if (typeof p.def.build === 'function') {
      try { p.def.build(body, p); } catch (err) { G.reportError ? G.reportError(err, 'panel:' + p.id) : G.warn('panel build failed: ' + p.id); body.appendChild(el('div', { class: 'muted', text: 'This window could not be drawn.' })); }
    }
    if (p.footer && typeof p.def.footer === 'function') {
      while (p.footer.firstChild) p.footer.removeChild(p.footer.firstChild);
      try { p.def.footer(p.footer, p); } catch (err) { if (G.reportError) G.reportError(err, 'panel-footer:' + p.id); }
    }
  }

  UI.registerPanel = function (id, def) {
    if (!id) return null;
    def = def || {};
    _ensureRoots();
    if (panels[id]) {                       // re-registration replaces the definition and rebuilds on next open
      const old = panels[id];
      old.def = def; old.built = false;
      old.setTitle(def.title || old.def.title || id);
      _applySize(old);
      return old;
    }
    const titleText = el('span', { class: 'ptitle', text: def.title || G.titleCase(id) });
    const closeBtn = el('span', { class: 'close', text: '×', title: 'Close (Esc)' });
    const titleEl = el('div', { class: 'panel-title' }, [titleText, closeBtn]);
    const body = el('div', { class: 'panel-body' });
    const root = el('div', { class: 'panel', id: 'panel-' + id, hidden: true }, [titleEl, body]);
    let footer = null;
    if (typeof def.footer === 'function' || (Array.isArray(def.buttons) && def.buttons.length)) {
      footer = el('div', { class: 'panel-footer' });
      root.appendChild(footer);
    }
    const p = {
      id: id, el: root, body: body, footer: footer, titleEl: titleEl, def: def, open: false, built: false, z: _zBase, x: 0, y: 0,
      isOpen: function () { return this.open; },
      close: function () { UI.closePanel(id); },
      refresh: function () { UI.refresh(id); },
      setTitle: function (t) { titleText.textContent = _str(t); },
      addButton: function (label, onClick, cls) {
        if (!this.footer) { this.footer = el('div', { class: 'panel-footer' }); this.el.appendChild(this.footer); }
        const b = el('button', { class: 'btn' + (cls ? ' ' + cls : ''), text: label, onclick: function (e) { if (typeof onClick === 'function') onClick(e, p); } });
        this.footer.appendChild(b);
        return b;
      },
    };
    if (Array.isArray(def.buttons)) def.buttons.forEach(function (b) { if (b && b.label) p.addButton(b.label, b.onClick, b.cls); });
    closeBtn.addEventListener('click', function (e) { e.stopPropagation(); UI.closePanel(id); });
    titleEl.addEventListener('pointerdown', function (e) { _startDrag(p, e); });
    titleEl.addEventListener('dblclick', function (e) { if (!e.target.closest('.close')) { _forgetPos(id); p.def.remember !== false && _placePanel(p); } });
    root.addEventListener('pointerdown', function () { if (p.open && p.z < _zTop) UI.bringToFront(id); }, true);
    _applySize(p);
    panels[id] = p;
    _panelsRoot.appendChild(root);
    return p;
  };
  UI.getPanel = function (id) { return panels[id] || null; };
  UI.isOpen = function (id) { const p = panels[id]; return !!(p && p.open); };
  UI.anyOpen = function () { for (const id in panels) if (panels[id].open) return true; return false; };
  UI.anyModal = function () { for (const id in panels) if (panels[id].open && panels[id].def.modal) return true; return false; };
  UI.topPanel = function () { const l = _openList(); return l.length ? l[l.length - 1] : null; };
  UI.openPanels = function () { return _openList().map(function (p) { return p.id; }); };
  UI.bringToFront = function (id) {
    const p = panels[id];
    if (!p) return;
    p.z = ++_zTop;
    p.el.style.zIndex = String(p.z);
    _updateBackdrop();
  };
  UI.openPanel = function (id, arg) {
    const p = panels[id];
    if (!p) { G.warn('UI.openPanel: unknown panel "' + id + '"'); return false; }
    if (p.open) { UI.bringToFront(id); return true; }
    if (!p.built || p.def.rebuildOnOpen) _buildPanel(p);
    p.open = true;
    p.el.hidden = false;
    p.el.classList.add('ui-open');
    UI.bringToFront(id);
    _placePanel(p);
    _relockArmed = false;
    if (G.Input && typeof G.Input.exitLock === 'function') G.Input.exitLock();
    if (p.def.sound !== false) _sfx('ui_open');
    if (typeof p.def.onOpen === 'function') { try { p.def.onOpen(p, arg); } catch (err) { if (G.reportError) G.reportError(err, 'panel-open:' + id); } }
    G.emit('panelOpened', id);
    return true;
  };
  UI.closePanel = function (id) {
    const p = panels[id];
    if (!p || !p.open) return false;
    p.open = false;
    p.el.hidden = true;
    p.el.classList.remove('ui-open');
    UI.tooltip.hide();
    _updateBackdrop();
    if (p.def.sound !== false) _sfx('ui_close');
    if (typeof p.def.onClose === 'function') { try { p.def.onClose(p); } catch (err) { if (G.reportError) G.reportError(err, 'panel-close:' + id); } }
    G.emit('panelClosed', id);
    if (!UI.anyOpen() && G.state.phase === 'playing') _relockArmed = true;
    return true;
  };
  UI.togglePanel = function (id, arg) { return UI.isOpen(id) ? UI.closePanel(id) : UI.openPanel(id, arg); };
  UI.closeAll = function () { _openList().reverse().forEach(function (p) { UI.closePanel(p.id); }); };
  UI.refresh = function (id) {
    const p = panels[id];
    if (!p) return false;
    if (p.open || p.built) _buildPanel(p);
    return true;
  };
  UI.destroyPanel = function (id) {
    const p = panels[id];
    if (!p) return;
    UI.closePanel(id);
    if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
    delete panels[id];
  };
  function _closeTop() {
    const l = _openList();
    for (let i = l.length - 1; i >= 0; i--) {
      if (l[i].def.noEsc) continue;
      UI.closePanel(l[i].id);
      return true;
    }
    return false;
  }
  function _ensureRoots() {
    if (_panelsRoot) return;
    _panelsRoot = document.getElementById('panels');
    if (!_panelsRoot) { _panelsRoot = el('div', { id: 'panels' }); (document.getElementById('ui') || document.body).appendChild(_panelsRoot); }
    _backdrop = el('div', { id: 'modalBackdrop', hidden: true });
    _backdrop.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    _panelsRoot.appendChild(_backdrop);
  }

  // ------------------------------------------------------------------------------------------------ tooltip
  let _ttEl = null, _ttOwner = null;
  const tooltip = UI.tooltip = {
    visible: false,
    show: function (html, x, y) {
      if (!_ttEl) _ttEl = document.getElementById('tooltip');
      if (!_ttEl) return;
      if (html == null || html === '') { tooltip.hide(); return; }
      if (html && html.nodeType) { _ttEl.innerHTML = ''; _ttEl.appendChild(html); }
      else _ttEl.innerHTML = String(html);
      _ttEl.hidden = false;
      tooltip.visible = true;
      tooltip.move(x, y);
    },
    move: function (x, y) {
      if (!_ttEl || _ttEl.hidden) return;
      x = _num(x, 0); y = _num(y, 0);
      const w = _ttEl.offsetWidth, h = _ttEl.offsetHeight, vw = _vw(), vh = _vh();
      let left = x + 16, top = y + 18;
      if (left + w > vw - 6) left = Math.max(6, x - w - 12);
      if (top + h > vh - 6) top = Math.max(6, y - h - 12);
      _ttEl.style.left = Math.round(left) + 'px';
      _ttEl.style.top = Math.round(top) + 'px';
    },
    hide: function () {
      if (_ttEl && !_ttEl.hidden) _ttEl.hidden = true;
      tooltip.visible = false;
      _ttOwner = null;
    },
  };
  UI.bindTooltip = function (node, htmlOrFn, opts) {
    if (!node || !node.addEventListener) return node;
    opts = opts || {};
    const get = function (e) { try { return typeof htmlOrFn === 'function' ? htmlOrFn(node, e) : htmlOrFn; } catch (err) { if (G.reportError) G.reportError(err, 'tooltip'); return ''; } };
    node.addEventListener('mouseenter', function (e) { _ttOwner = node; tooltip.show(get(e), e.clientX, e.clientY); });
    node.addEventListener('mousemove', function (e) { if (_ttOwner === node && tooltip.visible) { if (opts.live) tooltip.show(get(e), e.clientX, e.clientY); else tooltip.move(e.clientX, e.clientY); } });
    node.addEventListener('mouseleave', function () { if (_ttOwner === node) tooltip.hide(); });
    node.addEventListener('mousedown', function () { if (!opts.keepOnClick) tooltip.hide(); });
    node._ttGet = get;
    return node;
  };

  // ------------------------------------------------------------------------------------------------ notifications
  const NOTICE_ICON = { info: '✦', quest: '❖', level: '★', warning: '⚠', loot: '✧', gold: '●', system: '✦' };
  const _notices = [];       // { el, t, hold }
  let _noticesEl = null, _bigEl = null, _bigTitle = null, _bigSub = null, _bigT = -1;
  const NOTICE_MAX = 5;

  UI.notify = function (text, kind) {
    if (!_noticesEl) return;
    kind = NOTICE_ICON[kind] ? kind : 'info';
    text = _str(text);
    if (!text) return;
    const n = el('div', { class: 'notice n-' + kind }, [el('span', { class: 'n-ico', text: NOTICE_ICON[kind] }), el('span', { class: 'n-text', text: text })]);
    _noticesEl.appendChild(n);
    _notices.push({ el: n, t: 0, hold: 3 + Math.min(3, text.length / 40), out: false });
    while (_notices.length > NOTICE_MAX) { const old = _notices.shift(); if (old.el.parentNode) old.el.parentNode.removeChild(old.el); }
    return n;
  };
  UI.notifyBig = function (text, sub) {
    if (!_bigEl) return;
    _bigTitle.textContent = _str(text);
    _bigSub.textContent = _str(sub);
    _bigSub.hidden = !sub;
    _bigEl.classList.remove('show');
    void _bigEl.offsetWidth;         // restart the CSS animation
    _bigEl.classList.add('show');
    _bigT = 0;
  };
  function _updateNotices(dt) {
    for (let i = _notices.length - 1; i >= 0; i--) {
      const n = _notices[i];
      n.t += dt;
      if (!n.out && n.t >= n.hold) { n.out = true; n.el.classList.add('out'); }
      if (n.t >= n.hold + 0.45) { if (n.el.parentNode) n.el.parentNode.removeChild(n.el); _notices.splice(i, 1); }
    }
    if (_bigT >= 0) { _bigT += dt; if (_bigT > 3.2) { _bigEl.classList.remove('show'); _bigT = -1; } }
  }

  // ------------------------------------------------------------------------------------------------ floating combat text
  const FT_MAX = 40, FT_DUR = 1.1;
  const _ft = [];            // pool entries: { el, active, t, x, y, z, dx, size, crit, seq }
  let _ftLayer = null, _ftSeq = 0;
  const _v3 = { x: 0, y: 0, z: 0 };
  let _projV = null;         // THREE.Vector3 created lazily

  UI.floatText = function (worldPos, text, color, opts) {
    if (!_ftLayer || !worldPos) return null;
    opts = opts || {};
    let slot = null;
    for (let i = 0; i < _ft.length; i++) if (!_ft[i].active) { slot = _ft[i]; break; }
    if (!slot) {
      if (_ft.length < FT_MAX) {
        slot = { el: el('span', { class: 'ftxt' }), active: false, t: 0, x: 0, y: 0, z: 0, dx: 0, size: 1, crit: false, seq: 0 };
        _ftLayer.appendChild(slot.el);
        _ft.push(slot);
      } else {
        slot = _ft[0];
        for (let i = 1; i < _ft.length; i++) if (_ft[i].seq < slot.seq) slot = _ft[i];   // recycle the oldest
      }
    }
    slot.active = true; slot.t = 0; slot.seq = ++_ftSeq;
    slot.x = _num(worldPos.x); slot.y = _num(worldPos.y) + _num(opts.offsetY, 1.9); slot.z = _num(worldPos.z);
    slot.dx = opts.dx != null ? _num(opts.dx) : (_jitter() - 0.5) * 44;
    slot.crit = !!opts.crit;
    slot.size = _num(opts.size, 1) * (slot.crit ? 1.15 : 1);
    const e = slot.el;
    e.textContent = _str(text);
    e.style.color = _hex(color || '#ffffff');
    e.className = 'ftxt' + (slot.crit ? ' crit' : '');
    e.style.opacity = '0';
    e.style.display = '';
    return slot;
  };
  function _updateFloatText(dt) {
    if (!_ft.length) return;
    const cam = G.Player && G.Player.camera;
    if (!_projV && window.THREE) _projV = new THREE.Vector3();
    const vw = _vw(), vh = _vh();
    for (let i = 0; i < _ft.length; i++) {
      const f = _ft[i];
      if (!f.active) continue;
      f.t += dt;
      if (f.t >= FT_DUR || !cam || !_projV) { f.active = false; f.el.style.display = 'none'; continue; }
      _projV.set(f.x, f.y, f.z).project(cam);
      if (_projV.z > 1 || _projV.z < -1) { f.el.style.opacity = '0'; continue; }
      const k = f.t / FT_DUR;
      const rise = (1 - (1 - k) * (1 - k)) * 70;                     // ease-out rise (px)
      let sx = (_projV.x + 1) * 0.5 * vw + f.dx * k;
      let sy = (1 - _projV.y) * 0.5 * vh - rise;
      let scale = f.size * (f.crit ? (k < 0.12 ? 1.6 - k * 5 : 1) : (k < 0.1 ? 0.8 + k * 2 : 1));
      if (f.crit && k < 0.35) { sx += (_jitter() - 0.5) * 6 * (1 - k / 0.35); sy += (_jitter() - 0.5) * 4 * (1 - k / 0.35); }
      const alpha = k < 0.6 ? 1 : 1 - (k - 0.6) / 0.4;
      f.el.style.opacity = alpha.toFixed(2);
      f.el.style.transform = 'translate3d(' + sx.toFixed(1) + 'px,' + sy.toFixed(1) + 'px,0) translate(-50%,-50%) scale(' + scale.toFixed(3) + ')';
    }
  }

  // ------------------------------------------------------------------------------------------------ chat
  const CHAT_MAX = 300;
  const CHAT_TABS = [
    { id: 'all', label: 'All', channels: null },
    { id: 'say', label: 'Say', channels: ['say', 'emote', 'whisper', 'system'] },
    { id: 'world', label: 'World', channels: ['world', 'system', 'admin'] },
    { id: 'combat', label: 'Combat', channels: ['combat', 'loot'] },
    { id: 'fellowship', label: 'Fellowship', channels: ['fellowship', 'system'] },
  ];
  const CHANNEL_LABEL = { say: 'Say', world: 'World', system: 'System', combat: 'Combat', fellowship: 'Fellowship', emote: '', whisper: 'Whisper', loot: 'Loot', admin: 'Admin', quest: 'Quest' };
  UI.chatChannels = Object.keys(CHANNEL_LABEL);
  const chat = { el: null, log: null, input: null, tabsEl: null, tabEls: {}, chEl: null, lines: [], tab: 'all', collapsed: false, history: [], histIdx: -1, unread: {} };
  UI.chatState = chat;

  function _tabShows(tabId, channel) {
    const t = CHAT_TABS.find(function (x) { return x.id === tabId; });
    if (!t || !t.channels) return true;
    return t.channels.indexOf(channel) >= 0;
  }
  function _chatAppend(text, channel, from, opts) {
    if (!chat.log) return null;
    channel = CHANNEL_LABEL[channel] !== undefined ? channel : 'world';
    opts = opts || {};
    const time = _clock(G.time && G.time.dayTime);
    const line = el('div', { class: 'chat-line ch-' + channel });
    line.appendChild(el('span', { class: 'chat-time', text: time }));
    const label = CHANNEL_LABEL[channel];
    if (channel === 'emote') {
      line.appendChild(el('span', { class: 'chat-from', text: (from || 'You') + ' ' }));
      line.appendChild(document.createTextNode(_str(text)));
    } else {
      let head = '';
      if (label && channel !== 'say') head += '[' + label + '] ';
      if (from) head += (opts.to ? 'To ' + opts.to : (channel === 'whisper' && from !== 'You' ? from + ' whispers' : from)) + ': ';
      if (head) line.appendChild(el('span', { class: 'chat-from', text: head }));
      line.appendChild(document.createTextNode(_str(text)));
    }
    const rec = { el: line, channel: channel, from: from || '', text: _str(text), time: time };
    chat.lines.push(rec);
    if (chat.lines.length > CHAT_MAX) { const old = chat.lines.shift(); if (old.el.parentNode) old.el.parentNode.removeChild(old.el); }
    line.hidden = !_tabShows(chat.tab, channel);
    const atBottom = chat.log.scrollTop + chat.log.clientHeight >= chat.log.scrollHeight - 24;
    chat.log.appendChild(line);
    if (atBottom || from === 'You') chat.log.scrollTop = chat.log.scrollHeight;
    if (line.hidden) {
      for (let i = 0; i < CHAT_TABS.length; i++) { const t = CHAT_TABS[i]; if (t.id !== chat.tab && _tabShows(t.id, channel) && chat.tabEls[t.id]) chat.tabEls[t.id].classList.add('unread'); }
    }
    if (chat.collapsed && chat.el) chat.el.classList.add('unread');
    return rec;
  }
  UI.chat = function (text, channel, from) {
    const rec = _chatAppend(text, channel || 'world', from);
    if (channel === 'whisper' && from && from !== 'You') _sfx('chat_ping');
    return rec;
  };
  UI.chatInput = function () {
    if (!chat.input) return;
    if (chat.collapsed) _chatCollapse(false);
    try { chat.input.focus(); } catch (_) { /* ignore */ }
  };
  function _chatBlur() {
    if (chat.input) chat.input.blur();
    const c = G.Input && G.Input.canvas;
    if (c && typeof c.focus === 'function') { try { c.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
  }
  function _chatSetTab(id) {
    chat.tab = id;
    for (const k in chat.tabEls) chat.tabEls[k].classList.toggle('active', k === id);
    if (chat.tabEls[id]) chat.tabEls[id].classList.remove('unread');
    for (let i = 0; i < chat.lines.length; i++) chat.lines[i].el.hidden = !_tabShows(id, chat.lines[i].channel);
    if (chat.log) chat.log.scrollTop = chat.log.scrollHeight;
    _chatUpdateChannelLabel();
  }
  function _chatCollapse(v) {
    chat.collapsed = !!v;
    if (!chat.el) return;
    chat.el.classList.toggle('collapsed', chat.collapsed);
    if (!chat.collapsed) { chat.el.classList.remove('unread'); if (chat.log) chat.log.scrollTop = chat.log.scrollHeight; }
    const b = chat.el.querySelector('.chat-collapse');
    if (b) { b.textContent = chat.collapsed ? '▴' : '▾'; b.title = chat.collapsed ? 'Expand chat' : 'Collapse chat'; }
  }
  function _chatDefaultChannel() {
    return chat.tab === 'world' ? 'world' : chat.tab === 'fellowship' ? 'fellowship' : 'say';
  }
  function _chatUpdateChannelLabel() { if (chat.chEl) chat.chEl.textContent = CHANNEL_LABEL[_chatDefaultChannel()]; }
  function _sysLine(text) { _chatAppend(text, 'system', ''); }
  function _playerSay(channel, text, extra) {
    if (!text) return;
    const from = 'You';
    _chatAppend(text, channel, from, extra);
    const ev = { channel: channel, from: from, text: text };
    if (extra && extra.to) ev.to = extra.to;
    G.emit('chat', ev);
  }
  const CHAT_HELP = [
    '/say <text> (/s) — speak to those nearby', '/world <text> (/wo) — world channel', '/f <text> — fellowship channel',
    '/w <name> <text> — whisper a player', '/emote <text> (/me) — emote', '/who — who is around', '/time <hh> — set the hour of day',
    '/fps — toggle the frame-rate counter', '/quest — toggle auto-quest (B)', '/clear — clear the chat log', '/help — this list',
  ];
  UI.chatCommand = function (line) {
    line = _str(line).trim();
    if (!line) return false;
    if (line.charAt(0) !== '/') { _playerSay(_chatDefaultChannel(), line); return true; }
    const sp = line.indexOf(' ');
    const cmd = (sp < 0 ? line : line.slice(0, sp)).slice(1).toLowerCase();
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    switch (cmd) {
      case 'say': case 's': _playerSay('say', rest); return true;
      case 'world': case 'wo': case 'ooc': _playerSay('world', rest); return true;
      case 'f': case 'fellowship': case 'p': _playerSay('fellowship', rest); return true;
      case 'w': case 'whisper': case 'tell': case 't': {
        const i = rest.indexOf(' ');
        if (i < 0) { _sysLine('Usage: /w <name> <message>'); return true; }
        _playerSay('whisper', rest.slice(i + 1).trim(), { to: rest.slice(0, i) });
        return true;
      }
      case 'emote': case 'me': case 'e': _playerSay('emote', rest); return true;
      case 'help': case '?': CHAT_HELP.forEach(_sysLine); _sysLine('Press F1 for the full key-binding list.'); return true;
      case 'chris': case 'admin':
        if (G.UI.Admin && typeof G.UI.Admin.open === 'function') { G.UI.Admin.open(); _sysLine('The admin panel opens…'); }
        else _sysLine('Nothing happens. (The admin panel is not available.)');
        return true;
      case 'fps': G.state.settings.showFps = !G.state.settings.showFps; _sysLine('FPS counter ' + (G.state.settings.showFps ? 'shown' : 'hidden') + '.'); return true;
      case 'time': {
        const h = parseFloat(rest);
        if (!isFinite(h)) { _sysLine('It is ' + _clock(G.time.dayTime) + '. Usage: /time <hour 0-24>'); return true; }
        const hh = ((h % 24) + 24) % 24;
        G.time.dayTime = hh;
        if (_has(G.Sky, 'setTime')) G.Sky.setTime(hh);
        _sysLine('The hour is now ' + _clock(hh) + '.');
        return true;
      }
      case 'who': {
        const p = _player();
        let list = _has(G.AIPlayers, 'list') ? (G.AIPlayers.list() || []) : [];
        const zone = G.state.zone;
        const here = list.filter(function (a) { return a && (a.zone === zone); });
        const zn = _zoneData(zone);
        if (!list.length) _sysLine('You are alone in ' + (zn ? zn.name : 'this land') + '… for now.');
        else {
          _sysLine(list.length + ' players are in Middle-earth; ' + here.length + ' in ' + (zn ? zn.name : G.titleCase(zone)) + (here.length ? ':' : '.'));
          here.slice(0, 12).forEach(function (a) { _sysLine('  ' + a.name + ' — level ' + _num(a.level, 1) + ' ' + G.titleCase(a.cls || '') + (a.state ? ' (' + a.state + ')' : '')); });
          if (here.length > 12) _sysLine('  …and ' + (here.length - 12) + ' more.');
        }
        if (p) _sysLine('You: level ' + _num(p.level, 1) + ' at ' + Math.round(_num(p.pos && p.pos.x)) + ', ' + Math.round(_num(p.pos && p.pos.z)) + '.');
        return true;
      }
      case 'quest': case 'autoquest': case 'bot': _toggleAutoQuest(); return true;
      case 'clear': chat.lines.forEach(function (l) { if (l.el.parentNode) l.el.parentNode.removeChild(l.el); }); chat.lines.length = 0; return true;
      case 'loc': case 'where': {
        const p = _player();
        if (p && p.pos) _sysLine('You are at ' + Math.round(p.pos.x) + ', ' + Math.round(p.pos.z) + ' in ' + (_zoneData(G.state.zone) || {}).name + '.');
        return true;
      }
      default: _sysLine('Unknown command "/' + cmd + '". Type /help for a list.'); return true;
    }
  };
  UI.chatSend = function (text) { return UI.chatCommand(text); };

  function _buildChat(hud) {
    const tabsEl = el('div', { class: 'chat-tabs' });
    CHAT_TABS.forEach(function (t) {
      const b = el('span', { class: 'chat-tab' + (t.id === 'all' ? ' active' : ''), text: t.label, onclick: function () { _chatSetTab(t.id); } });
      chat.tabEls[t.id] = b;
      tabsEl.appendChild(b);
    });
    tabsEl.appendChild(el('span', { class: 'chat-collapse', text: '▾', title: 'Collapse chat', onclick: function () { _chatCollapse(!chat.collapsed); } }));
    const log = el('div', { class: 'chat-log' });
    const chLabel = el('span', { class: 'chat-ch', text: 'Say' });
    const input = el('input', { type: 'text', maxlength: 240, placeholder: 'Press Enter to chat…  /help for commands', autocomplete: 'off', spellcheck: false });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        const v = input.value;
        input.value = '';
        if (v.trim()) { chat.history.push(v); if (chat.history.length > 50) chat.history.shift(); chat.histIdx = chat.history.length; UI.chatCommand(v); }
        _chatBlur();
      } else if (e.key === 'Escape') { e.preventDefault(); input.value = ''; _chatBlur(); }
      else if (e.key === 'ArrowUp') { if (chat.history.length) { chat.histIdx = Math.max(0, chat.histIdx - 1); input.value = chat.history[chat.histIdx] || ''; e.preventDefault(); } }
      else if (e.key === 'ArrowDown') { if (chat.history.length) { chat.histIdx = Math.min(chat.history.length, chat.histIdx + 1); input.value = chat.history[chat.histIdx] || ''; e.preventDefault(); } }
      else if (e.key === 'Tab') { e.preventDefault(); }
      e.stopPropagation();
    });
    input.addEventListener('focus', function () { chat.el.classList.add('focused'); });
    input.addEventListener('blur', function () { chat.el.classList.remove('focused'); });
    const inputRow = el('div', { class: 'chat-input' }, [chLabel, input]);
    const root = el('div', { id: 'chat' }, [tabsEl, log, inputRow]);
    root.addEventListener('wheel', function (e) { e.stopPropagation(); }, { passive: true });
    chat.el = root; chat.log = log; chat.input = input; chat.tabsEl = tabsEl; chat.chEl = chLabel;
    hud.appendChild(root);
  }

  // ------------------------------------------------------------------------------------------------ loot window
  let _lootEl = null, _lootList = null, _lootGold = null, _lootT = -1;
  UI.showLoot = function (items, gold) {
    if (!_lootEl) return;
    if (_lootT < 0 || _lootEl.classList.contains('out')) { while (_lootList.firstChild) _lootList.removeChild(_lootList.firstChild); _lootGold.hidden = true; _lootGold._sum = 0; }
    _lootEl.classList.remove('out');
    _lootEl.hidden = false;
    _lootT = 0;
    const arr = Array.isArray(items) ? items : (items ? [items] : []);
    arr.forEach(function (inst) {
      if (!inst) return;
      let v = inst;
      if (G.Items && typeof G.Items.get === 'function') { try { v = G.Items.get(typeof inst === 'string' ? { tid: inst, count: 1 } : inst) || inst; } catch (_) { v = inst; } }
      const name = v.name || inst.name || G.titleCase(inst.tid || inst);
      const rarity = v.rarity || inst.rarity || 'common';
      const count = _num(inst.count, 1);
      const row = el('div', { class: 'lw-row' });
      row.innerHTML = UI.iconFor(inst, 'sm');
      row.appendChild(el('span', { class: 'lw-name rarity-' + rarity, text: name }));
      if (count > 1) row.appendChild(el('span', { class: 'lw-count', text: '×' + count }));
      _lootList.appendChild(row);
      while (_lootList.children.length > 6) _lootList.removeChild(_lootList.firstChild);
    });
    const g = _num(gold, 0) + (typeof arr.gold === 'number' ? arr.gold : 0);
    if (g > 0) { _lootGold._sum = (_lootGold._sum || 0) + g; _lootGold.innerHTML = UI.formatMoney(_lootGold._sum); _lootGold.hidden = false; }
  };
  UI.hideLoot = function () { if (_lootEl) { _lootEl.hidden = true; _lootT = -1; } };
  function _updateLoot(dt) {
    if (_lootT < 0 || !_lootEl) return;
    _lootT += dt;
    if (_lootT > 4 && !_lootEl.classList.contains('out')) _lootEl.classList.add('out');
    if (_lootT > 4.6) { _lootEl.hidden = true; _lootEl.classList.remove('out'); _lootT = -1; }
  }

  // ------------------------------------------------------------------------------------------------ confirm / cursor / money / icons
  let _confirmState = null;
  UI.confirm = function (text, onYes, onNo, opts) {
    opts = opts || {};
    _confirmState = { text: _str(text), onYes: onYes, onNo: onNo, yes: opts.yes || 'Yes', no: opts.no || 'No', title: opts.title || 'Confirm', answered: false };
    if (!panels.confirm) {
      UI.registerPanel('confirm', {
        title: 'Confirm', modal: true, pos: 'center', remember: false, width: 360,
        build: function (body, p) {
          const s = _confirmState || {};
          p.setTitle(s.title || 'Confirm');
          body.appendChild(el('div', { class: 'confirm-text', text: s.text || '' }));
          if (p.footer) while (p.footer.firstChild) p.footer.removeChild(p.footer.firstChild);
          const answer = function (yes) { if (s.answered) return; s.answered = true; UI.closePanel('confirm'); const cb = yes ? s.onYes : s.onNo; if (typeof cb === 'function') cb(); };
          p.addButton(s.no || 'No', function () { answer(false); });
          p.addButton(s.yes || 'Yes', function () { answer(true); }, 'primary');
        },
        onClose: function () { const s = _confirmState; _confirmState = null; if (s && !s.answered) { s.answered = true; if (typeof s.onNo === 'function') s.onNo(); } },   // Esc / × count as "No"
      });
    }
    UI.refresh('confirm');
    UI.openPanel('confirm');
  };
  const CURSORS = { default: '', pointer: 'pointer', attack: 'crosshair', talk: 'pointer', loot: 'grab', move: 'move', text: 'text', wait: 'progress', grab: 'grabbing', help: 'help', none: 'none' };
  let _cursor = 'default';
  UI.setCursor = function (kind) {
    kind = CURSORS[kind] !== undefined ? kind : 'default';
    if (kind === _cursor) return;
    _cursor = kind;
    const c = CURSORS[kind];
    document.body.style.cursor = c;
    const canvas = G.Input && G.Input.canvas;
    if (canvas) canvas.style.cursor = c;
  };
  UI.formatMoney = function (copper) {
    const p = G.fmtMoneyParts(copper);
    let out = '<span class="money">' + (p.neg ? '−' : '');
    if (p.g) out += '<span class="money-g">' + G.fmtNum(p.g) + '</span>';
    if (p.g || p.s) out += '<span class="money-s">' + p.s + '</span>';
    out += '<span class="money-c">' + p.c + '</span></span>';
    return out;
  };
  const FAMILY_ICON = { wolf: '🐺', boar: '🐗', bear: '🐻', spider: '🕷', goblin: '👺', orc: '👹', brigand: '🗡', troll: '🧌', wight: '💀', bat: '🦇', warg: '🐺', crawler: '🐛', lynx: '🐈', drake: '🐉', giant: '🗿', slug: '🐌', uruk: '👹', sorcerer: '🔮', 'lossoth-bear': '🐻‍❄️', 'sea-serpent': '🐍' };
  const KIND_ICON = { player: '🧝', npc: '🧙', monster: '👹', aiplayer: '🧑', door: '🚪', chest: '📦', node: '🌿', boat: '⛵', fishspot: '🎣', mount: '🐴', dock: '⚓', quest: '❖', gold: '●', warning: '⚠', level: '★', loot: '✧', info: '✦', waypoint: '⚑', fellowship: '👥', map: '🗺' };
  UI.iconFor = function (x, size) {
    const cls = 'icon' + (size === 'sm' ? ' sm' : size === 'lg' ? ' lg' : '');
    if (x == null) return '<div class="' + cls + '"></div>';
    if (typeof x === 'string') {
      const a = _abilityOf(x);
      if (a) return '<div class="' + cls + ' ab-ico">' + esc(a.icon || '✨') + '</div>';
      if (G.Data && G.Data.items && G.Data.items[x] && G.Items && typeof G.Items.iconHTML === 'function') return G.Items.iconHTML({ tid: x, count: 1 }, size);
      if (KIND_ICON[x]) return '<div class="' + cls + '">' + KIND_ICON[x] + '</div>';
      if (FAMILY_ICON[x]) return '<div class="' + cls + '">' + FAMILY_ICON[x] + '</div>';
      return '<div class="' + cls + '">' + esc(x.length <= 2 ? x : NOTICE_ICON.info) + '</div>';
    }
    if (typeof x === 'object') {
      if (x.tid && G.Items && typeof G.Items.iconHTML === 'function') { try { return G.Items.iconHTML(x, size); } catch (_) { /* fall through */ } }
      if (x.effects && x.id && x.kind && x.icon) return '<div class="' + cls + ' ab-ico">' + esc(x.icon) + '</div>';   // ability object
      if (x.kind === 'player' || x.kind === 'aiplayer') { const c = _classOf(x); return '<div class="' + cls + '" style="color:' + (c ? _hex(c.color) : '#fff') + '">' + esc((c && c.icon) || KIND_ICON.player) + '</div>'; }
      if (x.kind === 'monster') return '<div class="' + cls + '">' + (FAMILY_ICON[x.family] || KIND_ICON.monster) + '</div>';
      if (x.kind && KIND_ICON[x.kind]) return '<div class="' + cls + '">' + KIND_ICON[x.kind] + '</div>';
      if (x.icon) return '<div class="' + cls + '">' + esc(x.icon) + '</div>';
    }
    return '<div class="' + cls + '"></div>';
  };
  UI.keyName = function (code) { return G.Input && typeof G.Input.keyName === 'function' ? G.Input.keyName(code) : _str(code); };

  // ------------------------------------------------------------------------------------------------ waypoint
  UI.waypoint = null;
  UI.setWaypoint = function (x, z, label) {
    if (typeof x === 'object' && x) { label = z; z = x.z; x = x.x; }
    if (!isFinite(x) || !isFinite(z)) return null;
    UI.waypoint = { x: +x, z: +z, label: _str(label) || 'Waypoint' };
    UI.notify('Waypoint set: ' + UI.waypoint.label + ' (' + Math.round(x) + ', ' + Math.round(z) + ')', 'info');
    return UI.waypoint;
  };
  UI.clearWaypoint = function () { UI.waypoint = null; };

  // ------------------------------------------------------------------------------------------------ shared entity helpers
  function _maxMorale(e) { return Math.max(1, _num(e.stats && e.stats.maxMorale, 0) || _num(e.maxMorale, 0) || 1); }
  function _maxPower(e) { return Math.max(1, _num(e.stats && e.stats.maxPower, 0) || _num(e.maxPower, 0) || 1); }
  function _castInfo(ent) {
    const c = ent && ent.casting;
    if (!c) return null;
    const a = _abilityOf(typeof c === 'string' ? c : (c.ability || c.abilityId || c.id));
    const name = (typeof c === 'object' && c.name) || (a && a.name) || 'Casting';
    let total = typeof c === 'object' ? (_num(c.duration, 0) || _num(c.total, 0) || _num(c.castTime, 0)) : 0;
    if (!total) total = (a && _num(a.castTime, 0)) || 1;
    let elapsed = 0;
    if (typeof c === 'object') {
      if (typeof c.elapsed === 'number') elapsed = c.elapsed;
      else if (typeof c.t === 'number') elapsed = c.t;
      else if (typeof c.progress === 'number') elapsed = c.progress * total;
      else if (typeof c.start === 'number') elapsed = _now() - c.start;
      else if (typeof c.end === 'number') elapsed = total - (c.end - _now());
      else if (typeof c.readyAt === 'number') elapsed = total - (c.readyAt - _now());
    }
    return { name: name, frac: clamp(elapsed / total, 0, 1), remaining: Math.max(0, total - elapsed), icon: (a && a.icon) || '' };
  }
  function _xpInfo(p) {
    const L = Math.max(1, _num(p.level, 1) | 0), cap = (G.C && G.C.LEVEL_CAP) || 80;
    const xp = G.Data && G.Data.xp;
    let cur = _num(p.xp, 0), need = 1, base = 0;
    if (xp && typeof xp.forLevel === 'function') { base = _num(xp.forLevel(L), 0); need = Math.max(1, _num(xp.forLevel(Math.min(cap, L + 1)), base + 1) - base); cur = cur - base; }
    else if (typeof xp === 'object' && xp && typeof xp.needFor === 'function') { need = Math.max(1, _num(xp.needFor(L), 1)); }
    if (L >= cap) return { level: L, cur: need, need: need, frac: 1, capped: true };
    return { level: L, cur: clamp(cur, 0, need), need: need, frac: clamp(cur / need, 0, 1), capped: false };
  }
  function _fmtSecs(s) { s = Math.max(0, s); if (s >= 3600) return Math.floor(s / 3600) + 'h'; if (s >= 60) return Math.floor(s / 60) + 'm'; if (s >= 10) return Math.round(s) + 's'; return (Math.ceil(s * 10) / 10).toFixed(s < 1 ? 1 : 0) + 's'; }
  function _setW(fillEl, frac, store, key) {
    const pct = Math.round(clamp(frac, 0, 1) * 1000) / 10;
    if (store[key] !== pct) { store[key] = pct; fillEl.style.width = pct + '%'; }
  }
  function _setText(node, text, store, key) { if (store[key] !== text) { store[key] = text; node.textContent = text; } }

  // ------------------------------------------------------------------------------------------------ player frame
  const pf = { el: null, portrait: null, glyph: null, level: null, name: null, cls: null, mFill: null, mText: null, pFill: null, pText: null, xFill: null, last: {} };
  function _buildPlayerFrame(hud) {
    pf.glyph = el('span', { class: 'pf-glyph', text: '⚔' });
    pf.level = el('span', { class: 'pf-level', text: '1' });
    pf.portrait = el('div', { class: 'pf-portrait' }, [pf.glyph, pf.level]);
    pf.name = el('span', { class: 'pf-nm', text: '' });
    pf.cls = el('span', { class: 'pf-cls', text: '' });
    pf.mFill = el('div', { class: 'fill morale' }); pf.mText = el('div', { class: 'text' });
    pf.pFill = el('div', { class: 'fill power' }); pf.pText = el('div', { class: 'text' });
    pf.xFill = el('div', { class: 'fill xp' });
    const main = el('div', { class: 'pf-main' }, [
      el('div', { class: 'pf-name' }, [pf.name, pf.cls]),
      el('div', { class: 'bar morale-bar' }, [pf.mFill, pf.mText]),
      el('div', { class: 'bar power-bar' }, [pf.pFill, pf.pText]),
      el('div', { class: 'bar xp-mini' }, [pf.xFill]),
    ]);
    pf.el = el('div', { id: 'playerFrame', class: 'hud-frame' }, [pf.portrait, main]);
    UI.bindTooltip(pf.portrait, function () {
      const p = _player(); if (!p) return '';
      const c = _classOf(p); const r = p.race && G.Data && G.Data.raceById && G.Data.raceById[p.race];
      let h = '<div class="tt-name">' + esc(p.name || 'You') + '</div>';
      if (p.activeTitle || p.title) h += '<div class="tt-sub">' + esc(_str(p.activeTitle || p.title)) + '</div>';
      h += '<div class="tt-line">Level ' + _num(p.level, 1) + ' ' + esc((r && r.name) || G.titleCase(p.race || '')) + ' ' + esc((c && c.name) || G.titleCase(p.cls || '')) + '</div>';
      const s = p.stats || {};
      h += '<div class="tt-stat">Morale ' + G.fmtNum(Math.round(_num(p.morale))) + ' / ' + G.fmtNum(Math.round(_maxMorale(p))) + ' · Power ' + G.fmtNum(Math.round(_num(p.power))) + ' / ' + G.fmtNum(Math.round(_maxPower(p))) + '</div>';
      if (s.might != null) h += '<div class="tt-line">Might ' + Math.round(s.might) + ' · Agility ' + Math.round(_num(s.agility)) + ' · Vitality ' + Math.round(_num(s.vitality)) + ' · Will ' + Math.round(_num(s.will)) + ' · Fate ' + Math.round(_num(s.fate)) + '</div>';
      h += '<div class="tt-desc">Press C for your character sheet.</div>';
      return h;
    });
    pf.portrait.addEventListener('click', function () { if (panels.character) UI.togglePanel('character'); });
    UI.bindTooltip(pf.mText.parentNode, function () { const p = _player(); if (!p) return ''; const s = p.stats || {}; return '<div class="tt-name">Morale</div><div class="tt-line">' + G.fmtNum(Math.round(_num(p.morale))) + ' / ' + G.fmtNum(Math.round(_maxMorale(p))) + '</div>' + (s.moraleRegen != null ? '<div class="tt-sub">Regen ' + (+s.moraleRegen).toFixed(1) + '/s out of combat</div>' : '') + '<div class="tt-desc">When your morale reaches zero you are defeated and must retreat.</div>'; });
    UI.bindTooltip(pf.pText.parentNode, function () { const p = _player(); if (!p) return ''; const s = p.stats || {}; return '<div class="tt-name">Power</div><div class="tt-line">' + G.fmtNum(Math.round(_num(p.power))) + ' / ' + G.fmtNum(Math.round(_maxPower(p))) + '</div>' + (s.powerRegen != null ? '<div class="tt-sub">Regen ' + (+s.powerRegen).toFixed(1) + '/s</div>' : '') + '<div class="tt-desc">Abilities cost power.</div>'; });
    hud.appendChild(pf.el);
  }
  function _updatePlayerFrame() {
    const p = _player();
    if (!p) { if (!pf.el.hidden) pf.el.hidden = true; return; }
    if (pf.el.hidden) pf.el.hidden = false;
    const L = pf.last;
    const c = _classOf(p);
    const glyph = (c && c.icon) || '⚔', color = c ? _hex(c.color) : '#d4af5a';
    _setText(pf.glyph, glyph, L, 'glyph');
    if (L.color !== color) { L.color = color; pf.portrait.style.borderColor = color; pf.portrait.style.boxShadow = '0 0 10px rgba(0,0,0,.7), inset 0 0 10px rgba(0,0,0,.8), 0 0 8px ' + color + '55'; }
    _setText(pf.level, String(_num(p.level, 1) | 0), L, 'level');
    _setText(pf.name, _str(p.name || 'Adventurer'), L, 'name');
    _setText(pf.cls, ((c && c.name) || G.titleCase(p.cls || '')).toUpperCase(), L, 'cls');
    const mm = _maxMorale(p), mp = _maxPower(p);
    const mor = clamp(_num(p.morale, 0), 0, mm), pow = clamp(_num(p.power, 0), 0, mp);
    _setW(pf.mFill, mor / mm, L, 'mw'); _setText(pf.mText, G.fmtNum(Math.round(mor)) + ' / ' + G.fmtNum(Math.round(mm)), L, 'mt');
    _setW(pf.pFill, pow / mp, L, 'pw'); _setText(pf.pText, G.fmtNum(Math.round(pow)) + ' / ' + G.fmtNum(Math.round(mp)), L, 'pt');
    const xi = _xpInfo(p);
    _setW(pf.xFill, xi.frac, L, 'xw');
    const combat = !!G.state.inCombat, dead = !!(p.dead || p.alive === false);
    if (L.combat !== combat) { L.combat = combat; pf.el.classList.toggle('in-combat', combat); }
    if (L.dead !== dead) { L.dead = dead; pf.el.classList.toggle('dead', dead); }
  }

  // ------------------------------------------------------------------------------------------------ target frame
  const tf = { el: null, name: null, level: null, con: null, hpFill: null, hpText: null, castRow: null, castFill: null, castText: null, fx: null, last: {} };
  function _buildTargetFrame(hud) {
    tf.name = el('span', { class: 'tf-name' });
    tf.level = el('span', { class: 'tf-level' });
    tf.con = el('span', { class: 'tf-con' });
    tf.hpFill = el('div', { class: 'fill enemy' }); tf.hpText = el('div', { class: 'text' });
    tf.castFill = el('div', { class: 'fill cast' }); tf.castText = el('div', { class: 'text' });
    tf.castRow = el('div', { class: 'bar cast-bar', hidden: true }, [tf.castFill, tf.castText]);
    tf.fx = el('div', { class: 'tf-effects' });
    tf.el = el('div', { id: 'targetFrame', class: 'hud-frame', hidden: true }, [
      el('div', { class: 'tf-head' }, [tf.name, tf.level, tf.con]),
      el('div', { class: 'bar hp-bar' }, [tf.hpFill, tf.hpText]),
      tf.castRow, tf.fx,
    ]);
    UI.bindTooltip(tf.el, function () {
      const p = _player(); const t = p && p.target; if (!t) return '';
      let h = '<div class="tt-name">' + esc(t.name || 'Target') + '</div>';
      if (t.title) h += '<div class="tt-sub">' + esc(t.title) + '</div>';
      const lvl = _num(t.level, 1);
      h += '<div class="tt-line">Level ' + lvl + (t.kind === 'monster' ? ' ' + (t.elite ? 'Elite ' : '') + (t.boss ? 'Boss ' : '') + G.titleCase(t.family || t.typeId || 'creature') : t.kind === 'aiplayer' ? ' ' + G.titleCase(t.cls || 'adventurer') : t.kind === 'npc' ? ' ' + esc(_str(t.role || 'citizen')) : '') + '</div>';
      if (G.Data && typeof G.Data.conLabel === 'function' && p) h += '<div class="tt-line" style="color:' + G.Data.difficultyColor(lvl, p.level) + '">' + esc(G.Data.conLabel(lvl, p.level)) + '</div>';
      h += '<div class="tt-stat">Morale ' + G.fmtNum(Math.round(_num(t.morale))) + ' / ' + G.fmtNum(Math.round(_maxMorale(t))) + '</div>';
      if (p && p.pos && t.pos) h += '<div class="tt-sub">' + Math.round(G.dist2v ? G.dist2v(p.pos, t.pos) : 0) + ' m away</div>';
      return h;
    });
    tf.el.addEventListener('click', function () { const p = _player(); if (p && p.target && _has(G.Player, 'setTarget')) G.Player.setTarget(p.target); });
    tf.el.addEventListener('contextmenu', function (e) { e.preventDefault(); if (_has(G.Player, 'setTarget')) G.Player.setTarget(null); });
    hud.appendChild(tf.el);
  }
  function _updateTargetFrame() {
    const p = _player();
    const t = p && p.target && p.target !== p ? p.target : null;
    if (!t) { if (!tf.el.hidden) { tf.el.hidden = true; tf.last = {}; } return; }
    if (tf.el.hidden) tf.el.hidden = false;
    const L = tf.last;
    _setText(tf.name, _str(t.name || 'Target'), L, 'name');
    const lvl = _num(t.level, 1) | 0;
    const col = (G.Data && typeof G.Data.difficultyColor === 'function') ? G.Data.difficultyColor(lvl, _num(p.level, 1)) : '#f2e34a';
    _setText(tf.level, String(lvl), L, 'level');
    if (L.col !== col) { L.col = col; tf.level.style.color = col; tf.con.style.color = col; }
    _setText(tf.con, (G.Data && typeof G.Data.conLabel === 'function') ? G.Data.conLabel(lvl, _num(p.level, 1)) : '', L, 'con');
    const hostile = !!(t.hostile || t.faction === 'enemy' || (G.Combat && typeof G.Combat.isHostile === 'function' && G.Combat.isHostile(p, t)));
    if (L.hostile !== hostile) { L.hostile = hostile; tf.hpFill.className = 'fill ' + (hostile ? 'enemy' : 'green'); tf.el.classList.toggle('friendly', !hostile); }
    const mm = _maxMorale(t), mor = clamp(_num(t.morale, 0), 0, mm);
    _setW(tf.hpFill, mor / mm, L, 'hw');
    _setText(tf.hpText, (t.dead || t.alive === false) ? 'Defeated' : G.fmtNum(Math.round(mor)) + ' / ' + G.fmtNum(Math.round(mm)) + '  (' + Math.round(mor / mm * 100) + '%)', L, 'ht');
    const ci = _castInfo(t);
    if (ci) { if (tf.castRow.hidden) tf.castRow.hidden = false; _setW(tf.castFill, ci.frac, L, 'cw'); _setText(tf.castText, ci.name, L, 'ct'); }
    else if (!tf.castRow.hidden) tf.castRow.hidden = true;
    const fx = Array.isArray(t.effects) ? t.effects : null;
    let sig = '';
    if (fx) for (let i = 0; i < fx.length && i < 10; i++) sig += (fx[i].id || fx[i].name) + '|';
    if (L.fxSig !== sig) {
      L.fxSig = sig;
      while (tf.fx.firstChild) tf.fx.removeChild(tf.fx.firstChild);
      if (fx) for (let i = 0; i < fx.length && i < 10; i++) {
        const e = fx[i];
        const kind = e.kind === 'debuff' || e.kind === 'dot' || e.kind === 'stun' || e.kind === 'root' || e.kind === 'slow' ? 'debuff' : 'buff';
        const d = el('div', { class: 'fx ' + kind, text: e.icon || (kind === 'debuff' ? '↓' : '↑') });
        UI.bindTooltip(d, function () { return '<div class="tt-name">' + esc(e.name || e.id) + '</div><div class="tt-line">' + esc(G.titleCase(e.kind || '')) + (e.remaining != null ? ' · ' + _fmtSecs(e.remaining) + ' left' : '') + '</div>'; });
        tf.fx.appendChild(d);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ buffs
  const bf = { el: null, sig: '', items: [], t: 0 };
  function _effectKindClass(e) { return e.kind === 'stance' ? 'buff' : (e.kind || 'buff'); }
  function _cancelEffect(p, e) {
    if (!p || !e) return;
    if (_has(G.Combat, 'removeEffect')) G.Combat.removeEffect(p, e.id);
    else if (Array.isArray(p.effects)) { const i = p.effects.indexOf(e); if (i >= 0) p.effects.splice(i, 1); }
  }
  function _updateBuffs(dt) {
    const p = _player();
    const fx = p && Array.isArray(p.effects) ? p.effects : null;
    let sig = '';
    if (fx) for (let i = 0; i < fx.length; i++) sig += (fx[i].id || fx[i].name || i) + ':' + (fx[i].kind || '') + '|';
    if (sig !== bf.sig) {
      bf.sig = sig;
      while (bf.el.firstChild) bf.el.removeChild(bf.el.firstChild);
      bf.items.length = 0;
      if (fx) for (let i = 0; i < fx.length && i < 16; i++) {
        const e = fx[i];
        const kind = _effectKindClass(e);
        const time = el('span', { class: 'b-time' });
        const bar = el('span', { class: 'b-bar' });
        const d = el('div', { class: 'buff ' + kind, text: e.icon || (kind === 'buff' ? '↑' : '↓') }, [time, bar]);
        UI.bindTooltip(d, function () {
          let h = '<div class="tt-name">' + esc(e.name || G.titleCase(e.id || 'Effect')) + '</div>';
          h += '<div class="tt-line">' + esc(G.titleCase(e.kind || 'buff')) + (e.src ? ' · from ' + esc(G.titleCase(_str(e.src).replace(/^.*_/, ''))) : '') + '</div>';
          if (e.stat) { const nm = (G.Data && G.Data.stats && G.Data.stats.STAT_NAMES && G.Data.stats.STAT_NAMES[e.stat]) || G.titleCase(e.stat); const v = e.pct != null ? (Math.abs(e.pct) <= 1 ? Math.round(e.pct * 100) : Math.round(e.pct)) + '%' : (e.amount > 0 ? '+' : '') + Math.round(_num(e.amount)); h += '<div class="tt-stat">' + esc(nm) + ' ' + esc(v) + '</div>'; }
          if (e.tick && e.amount) h += '<div class="tt-stat">' + Math.round(e.amount) + ' every ' + e.tick + ' s</div>';
          if (e.remaining != null) h += '<div class="tt-line">' + (e.total >= 1000 ? 'Until cancelled' : _fmtSecs(e.remaining) + ' remaining') + '</div>';
          if (kind === 'buff' || kind === 'hot') h += '<div class="tt-sub">Right-click to cancel</div>';
          return h;
        }, { live: true });
        d.addEventListener('contextmenu', function (ev) { ev.preventDefault(); if (kind === 'buff' || kind === 'hot') { _cancelEffect(_player(), e); UI.tooltip.hide(); } });
        bf.el.appendChild(d);
        bf.items.push({ e: e, time: time, bar: bar, lastT: '', lastS: -1 });
      }
      bf.t = 1;
    }
    bf.t += dt;
    if (bf.t < 0.1) return;
    bf.t = 0;
    for (let i = 0; i < bf.items.length; i++) {
      const it = bf.items[i], e = it.e;
      const rem = _num(e.remaining, 0), tot = Math.max(rem, _num(e.total, rem || 1));
      const txt = tot >= 1000 ? '' : _fmtSecs(rem);
      if (txt !== it.lastT) { it.lastT = txt; it.time.textContent = txt; }
      const s = tot >= 1000 ? 1 : clamp(rem / tot, 0, 1);
      const sr = Math.round(s * 50) / 50;
      if (sr !== it.lastS) { it.lastS = sr; it.bar.style.transform = 'scaleX(' + sr + ')'; }
    }
  }

  // ------------------------------------------------------------------------------------------------ hotbar
  const hb = { el: null, slots: [], sig: null, dragFrom: -1 };
  function _hotbarIds(p) { return (p && Array.isArray(p.hotbar)) ? p.hotbar : null; }
  function _setHotbar(i, id) {
    const p = _player();
    if (!p) return;
    if (_has(G.Progress, 'setHotbar')) G.Progress.setHotbar(i, id || null);
    else { if (!Array.isArray(p.hotbar)) p.hotbar = new Array(20).fill(null); p.hotbar[i] = id || null; }
    UI.hotbarRefresh();
  }
  function _useSlot(i) {
    const p = _player();
    const id = p && _hotbarIds(p) && p.hotbar[i];
    if (!id) return false;
    if (p.dead || p.alive === false) return false;
    if (_has(G.Combat, 'useAbility')) return !!G.Combat.useAbility(p, id, p.target || undefined);
    UI.notify('Combat is not available yet.', 'warning');
    return false;
  }
  function _buildHotbar(hud) {
    const keys = (G.C && G.C.HOTBAR_KEYS) || [];
    hb.el = el('div', { id: 'hotbar', class: 'hud-frame' });
    for (let i = 0; i < 20; i++) {
      const key = keys[i] || '';
      const code = key && G.Input && typeof G.Input.codeOf === 'function' ? G.Input.codeOf(key) : '';
      const icon = el('span', { class: 'ab-icon' });
      const cdText = el('span', { class: 'cd-text' });
      const cd = el('div', { class: 'cd', hidden: true }, [cdText]);
      const slot = el('div', { class: 'slot empty', data: { slot: i }, draggable: false }, [el('span', { class: 'keybind', text: key }), icon, cd]);
      const S = { el: slot, icon: icon, cd: cd, cdText: cdText, key: key, code: code, id: null, a: null, lastP: -1, lastT: '', cdShown: false, gcd: false, cls: '', press: 0 };
      hb.slots.push(S);
      (function (i, S) {
        slot.addEventListener('click', function () { _useSlot(i); });
        slot.addEventListener('contextmenu', function (e) { e.preventDefault(); });
        slot.addEventListener('dragstart', function (e) {
          if (!S.id) { e.preventDefault(); return; }
          try { e.dataTransfer.setData('text/ability', S.id); e.dataTransfer.setData('text/hotbar-slot', String(i)); e.dataTransfer.effectAllowed = 'move'; } catch (_) { /* ignore */ }
          hb.dragFrom = i;
          slot.classList.add('dragging');
          UI.tooltip.hide();
        });
        slot.addEventListener('dragend', function (e) {
          slot.classList.remove('dragging');
          hb.slots.forEach(function (s) { s.el.classList.remove('dragover'); });
          if (hb.dragFrom === i && e.dataTransfer && e.dataTransfer.dropEffect === 'none') _setHotbar(i, null);   // dragged off the bar → remove
          hb.dragFrom = -1;
        });
        slot.addEventListener('dragover', function (e) {
          const types = e.dataTransfer && e.dataTransfer.types;
          const ok = types && (types.indexOf ? types.indexOf('text/ability') >= 0 : types.contains && types.contains('text/ability'));
          if (ok || hb.dragFrom >= 0) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; slot.classList.add('dragover'); }
        });
        slot.addEventListener('dragleave', function () { slot.classList.remove('dragover'); });
        slot.addEventListener('drop', function (e) {
          e.preventDefault();
          slot.classList.remove('dragover');
          let id = '', from = '';
          try { id = e.dataTransfer.getData('text/ability'); from = e.dataTransfer.getData('text/hotbar-slot'); } catch (_) { /* ignore */ }
          if (!id && hb.dragFrom >= 0) { id = hb.slots[hb.dragFrom].id; from = String(hb.dragFrom); }
          if (!id) return;
          const fi = from !== '' ? parseInt(from, 10) : -1;
          if (fi >= 0 && fi !== i) { const prev = S.id; _setHotbar(fi, prev); }
          _setHotbar(i, id);
          hb.dragFrom = -1;
        });
        UI.bindTooltip(slot, function () {
          const p = _player();
          if (!S.a) return '<div class="tt-name">Empty slot</div><div class="tt-line">Key ' + esc(S.key) + '</div><div class="tt-desc">Drag an ability here from the Abilities window (K).</div>';
          let h = (G.Data && typeof G.Data.abilityTooltipHTML === 'function') ? G.Data.abilityTooltipHTML(S.a, p) : '<div class="tt-name">' + esc(S.a.name) + '</div>';
          h += '<div class="tt-sub">Key <span class="tt-key">' + esc(S.key) + '</span> · drag to move, drag off the bar to remove</div>';
          return h;
        });
      })(i, S);
      hb.el.appendChild(slot);
    }
    hud.appendChild(hb.el);
  }
  UI.hotbarRefresh = function () {
    const p = _player();
    const ids = _hotbarIds(p);
    for (let i = 0; i < hb.slots.length; i++) {
      const S = hb.slots[i];
      const id = ids ? (ids[i] || null) : null;
      const a = id ? _abilityOf(id) : null;
      S.id = a ? id : null; S.a = a;
      S.icon.textContent = a ? (a.icon || '✨') : '';
      S.el.classList.toggle('empty', !a);
      S.el.draggable = !!a;
      if (!a) { S.cd.hidden = true; S.cdShown = false; S.lastP = -1; S.lastT = ''; S.el.classList.remove('nopower', 'norange', 'active-stance'); }
    }
    hb.sig = ids ? ids.join(',') : '';
  };
  const _pressCodes = {};
  function _updateHotbar(dt) {
    const p = _player();
    if (!p) { if (!hb.el.hidden) hb.el.hidden = true; return; }
    if (hb.el.hidden) hb.el.hidden = false;
    const ids = _hotbarIds(p);
    const sig = ids ? ids.join(',') : '';
    if (sig !== hb.sig) UI.hotbarRefresh();
    const now = _now();
    const cds = p.cooldowns || {};
    const gcdReady = _num(p.gcdReadyAt, 0) || _num(p.gcdUntil, 0) || (p.gcd && typeof p.gcd === 'object' ? _num(p.gcd.readyAt, 0) : 0);
    const typing = G.Input && G.Input.typing;
    const tgt = p.target;
    const pos = p.pos;
    let dist = -1;
    if (tgt && tgt.pos && pos && G.dist2v) dist = G.dist2v(pos, tgt.pos);
    for (let i = 0; i < hb.slots.length; i++) {
      const S = hb.slots[i];
      if (S.press > 0) { S.press -= dt; if (S.press <= 0) S.el.classList.remove('press'); }
      if (!typing && S.code && G.Input && G.Input.pressed(S.code)) { S.el.classList.add('press'); S.press = 0.16; }
      const a = S.a;
      if (!a) continue;
      const ready = _num(cds[S.id], 0);
      let rem = ready - now;
      let gcd = false;
      if (rem <= 0 && gcdReady > now && a.gcd !== false) { rem = gcdReady - now; gcd = true; }
      if (rem > 0) {
        const total = gcd ? Math.max(rem, 1) : Math.max(_num(a.cooldown, 0), rem, 0.01);
        const pct = Math.round(clamp(rem / total, 0, 1) * 100);
        if (!S.cdShown) { S.cdShown = true; S.cd.hidden = false; }
        if (S.gcd !== gcd) { S.gcd = gcd; S.cd.classList.toggle('gcd', gcd); }
        if (pct !== S.lastP) { S.lastP = pct; S.cd.style.setProperty('--p', pct + '%'); }
        const txt = gcd ? '' : (rem >= 10 ? String(Math.ceil(rem)) : rem >= 1 ? String(Math.ceil(rem)) : rem.toFixed(1));
        if (txt !== S.lastT) { S.lastT = txt; S.cdText.textContent = txt; }
      } else if (S.cdShown) { S.cdShown = false; S.cd.hidden = true; S.lastP = -1; S.lastT = ''; }
      const nopower = _num(p.power, 0) < _num(a.power, 0);
      const norange = !!(tgt && dist >= 0 && a.target === 'enemy' && _num(a.range, 0) > 0 && dist > _num(a.range, 0) + 0.6);
      let stance = false;
      if (a.kind === 'stance' && Array.isArray(p.effects)) for (let k = 0; k < p.effects.length; k++) { const e = p.effects[k]; if (e && (e.id === a.id || e.src === a.id || e.ability === a.id)) { stance = true; break; } }
      const cls = (nopower ? 'p' : '') + (norange ? 'r' : '') + (stance ? 's' : '');
      if (cls !== S.cls) { S.cls = cls; S.el.classList.toggle('nopower', nopower); S.el.classList.toggle('norange', norange); S.el.classList.toggle('active-stance', stance); }
    }
  }

  // ------------------------------------------------------------------------------------------------ cast bar, xp bar, interact prompt
  const cb = { el: null, fill: null, name: null, time: null, last: {} };
  function _buildCastbar(hud) {
    cb.fill = el('div', { class: 'fill cast' });
    cb.name = el('span', { class: 'cb-n' }); cb.time = el('span', { class: 'cb-t' });
    cb.el = el('div', { id: 'castbar', class: 'hud-frame', hidden: true }, [el('div', { class: 'bar' }, [cb.fill, el('div', { class: 'cb-name' }, [cb.name, cb.time])])]);
    hud.appendChild(cb.el);
  }
  function _updateCastbar() {
    const p = _player();
    const ci = p ? _castInfo(p) : null;
    if (!ci) { if (!cb.el.hidden) cb.el.hidden = true; return; }
    if (cb.el.hidden) cb.el.hidden = false;
    _setW(cb.fill, ci.frac, cb.last, 'w');
    _setText(cb.name, (ci.icon ? ci.icon + ' ' : '') + ci.name, cb.last, 'n');
    _setText(cb.time, ci.remaining.toFixed(1) + ' s', cb.last, 't');
  }
  const xb = { el: null, fill: null, last: {} };
  function _buildXpbar(hud) {
    xb.fill = el('div', { class: 'xp-fill' });
    xb.el = el('div', { id: 'xpbar' }, [xb.fill, el('div', { class: 'xp-ticks' })]);
    UI.bindTooltip(xb.el, function () {
      const p = _player(); if (!p) return '';
      const xi = _xpInfo(p);
      if (xi.capped) return '<div class="tt-name">Level ' + xi.level + '</div><div class="tt-stat">You have reached the level cap.</div>';
      return '<div class="tt-name">Experience</div><div class="tt-line">Level ' + xi.level + ' — ' + G.fmtNum(Math.round(xi.cur)) + ' / ' + G.fmtNum(Math.round(xi.need)) + ' XP (' + (xi.frac * 100).toFixed(1) + '%)</div><div class="tt-stat">' + G.fmtNum(Math.round(xi.need - xi.cur)) + ' XP to level ' + (xi.level + 1) + '</div>';
    }, { live: true });
    hud.appendChild(xb.el);
  }
  function _updateXpbar() {
    const p = _player();
    if (!p) return;
    _setW(xb.fill, _xpInfo(p).frac, xb.last, 'w');
  }
  const ip = { el: null, verb: null, name: null, t: 0, lastKey: '' };
  function _buildInteract(hud) {
    ip.verb = el('span', { class: 'ip-verb' }); ip.name = el('span', { class: 'ip-name' });
    ip.el = el('div', { id: 'interactPrompt', class: 'hud-frame', hidden: true }, [el('span', { class: 'keycap', text: 'E' }), ip.verb, ip.name]);
    hud.appendChild(ip.el);
  }
  function _interactCandidate(p) {
    if (G.Player && 'interactTarget' in G.Player) return G.Player.interactTarget || null;
    if (!p || !p.pos || !G.Spatial || typeof G.Spatial.nearest !== 'function') return null;
    const r = (G.C && G.C.INTERACT_RANGE) || 4;
    return G.Spatial.nearest(p.pos.x, p.pos.z, r + 2, function (e) {
      if (e === p || !e.interact || e.dead) return false;
      const range = _num(e.interact.range, r);
      return G.dist2(p.pos.x, p.pos.z, e.pos.x, e.pos.z) <= range;
    });
  }
  function _updateInteract(dt) {
    ip.t += dt;
    if (ip.t < 0.12) return;
    ip.t = 0;
    const p = _player();
    const e = (p && !(p.dead || p.alive === false) && !UI.anyOpen()) ? _interactCandidate(p) : null;
    if (!e || !e.interact) { if (!ip.el.hidden) { ip.el.hidden = true; ip.lastKey = ''; } return; }
    let verb = _str(e.interact.label || 'Use');
    const name = _str(e.interact.name || e.name || '');
    if (/^talk$/i.test(verb)) verb = 'Talk to';
    const key = verb + '|' + name;
    if (key !== ip.lastKey) { ip.lastKey = key; ip.verb.textContent = verb; ip.name.textContent = name; }
    if (ip.el.hidden) ip.el.hidden = false;
  }

  // ------------------------------------------------------------------------------------------------ compass
  const cp = { el: null, canvas: null, ctx: null, w: 360, h: 32, dpr: 1, t: 0, lastYaw: 1e9, lastSig: '' };
  function _buildCompass(hud) {
    cp.canvas = el('canvas', { width: 360, height: 32 });
    cp.el = el('div', { id: 'compass' }, [cp.canvas]);
    hud.appendChild(cp.el);
    cp.ctx = cp.canvas.getContext('2d');
  }
  function _bearingTo(px, pz, x, z) { return Math.atan2(x - px, -(z - pz)); }         // 0 = north (−Z), +east
  function _camYaw() {
    if (G.Player && G.Player.cam && typeof G.Player.cam.yaw === 'number') return G.Player.cam.yaw;
    const p = _player(); return p ? _num(p.yaw, 0) : 0;
  }
  const _cpMarkers = [];   // reused: { rel, kind, dist, color }
  function _updateCompass(dt) {
    cp.t += dt;
    if (cp.t < 1 / 30) return;
    cp.t = 0;
    const p = _player();
    if (!p || !cp.ctx) return;
    const yaw = _camYaw();
    const heading = -yaw;                                                             // compass heading (rad, clockwise from north)
    _cpMarkers.length = 0;
    const px = p.pos ? p.pos.x : 0, pz = p.pos ? p.pos.z : 0;
    let sig = '';
    if (G.Quests && typeof G.Quests.nextObjective === 'function' && G.Quests.tracked) {
      let o = null; try { o = G.Quests.nextObjective(G.Quests.tracked); } catch (_) { o = null; }
      if (o && o.pos) { const d = G.dist2(px, pz, o.pos.x, o.pos.z); _cpMarkers.push({ rel: G.wrapAngle(_bearingTo(px, pz, o.pos.x, o.pos.z) - heading), kind: 'quest', dist: d, color: '#ffd54a' }); sig += 'q' + Math.round(d); }
    }
    if (UI.waypoint) { const w = UI.waypoint; const d = G.dist2(px, pz, w.x, w.z); _cpMarkers.push({ rel: G.wrapAngle(_bearingTo(px, pz, w.x, w.z) - heading), kind: 'wp', dist: d, color: '#5fe0ff' }); sig += 'w' + Math.round(d); }
    if (p.target && p.target.pos && p.target !== p) { const t = p.target; const d = G.dist2(px, pz, t.pos.x, t.pos.z); _cpMarkers.push({ rel: G.wrapAngle(_bearingTo(px, pz, t.pos.x, t.pos.z) - heading), kind: 'target', dist: d, color: t.hostile ? '#ff5a4a' : '#8fd48a' }); sig += 't' + Math.round(d); }
    const cw = cp.el.clientWidth || 360, ch = cp.el.clientHeight || 32;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cp.w !== cw || cp.h !== ch || cp.dpr !== dpr) { cp.w = cw; cp.h = ch; cp.dpr = dpr; cp.canvas.width = Math.round(cw * dpr); cp.canvas.height = Math.round(ch * dpr); cp.lastYaw = 1e9; }
    if (Math.abs(yaw - cp.lastYaw) < 0.002 && sig === cp.lastSig) return;
    cp.lastYaw = yaw; cp.lastSig = sig;
    const ctx = cp.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    // background strip with faded ends
    const bg = ctx.createLinearGradient(0, 0, cw, 0);
    bg.addColorStop(0, 'rgba(8,6,3,0)'); bg.addColorStop(0.12, 'rgba(8,6,3,.72)'); bg.addColorStop(0.88, 'rgba(8,6,3,.72)'); bg.addColorStop(1, 'rgba(8,6,3,0)');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, cw, ch);
    const line = ctx.createLinearGradient(0, 0, cw, 0);
    line.addColorStop(0, 'rgba(212,175,90,0)'); line.addColorStop(0.15, 'rgba(212,175,90,.7)'); line.addColorStop(0.85, 'rgba(212,175,90,.7)'); line.addColorStop(1, 'rgba(212,175,90,0)');
    ctx.fillStyle = line; ctx.fillRect(0, ch - 1.5, cw, 1.5); ctx.fillRect(0, 0, cw, 1);
    const cx = cw / 2, span = 180, ppd = cw / span;                                   // 180° visible
    const hdeg = G.deg(heading);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const labels = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    const startDeg = Math.floor((hdeg - span / 2) / 5) * 5;
    for (let d = startDeg; d <= hdeg + span / 2 + 5; d += 5) {
      const x = cx + (d - hdeg) * ppd;
      if (x < 0 || x > cw) continue;
      const edge = 1 - Math.pow(Math.abs(x - cx) / cx, 3);                             // fade near the ends
      const norm = ((d % 360) + 360) % 360;
      const major = norm % 45 === 0, mid = norm % 15 === 0;
      ctx.globalAlpha = Math.max(0, edge);
      if (major) {
        const lab = labels[norm];
        ctx.font = (norm % 90 === 0 ? 'bold 13px ' : 'bold 10px ') + 'Cinzel, Georgia, serif';
        ctx.fillStyle = norm === 0 ? '#ffe08a' : norm % 90 === 0 ? '#f3e6c2' : '#b8ad94';
        ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
        ctx.fillText(lab, x, ch / 2 - 1);
        ctx.shadowBlur = 0;
        ctx.fillStyle = 'rgba(212,175,90,.9)'; ctx.fillRect(x - 0.5, ch - 8, 1, 6);
      } else {
        ctx.fillStyle = mid ? 'rgba(232,220,192,.8)' : 'rgba(232,220,192,.4)';
        ctx.fillRect(x - 0.5, ch - (mid ? 8 : 5), 1, mid ? 6 : 3);
      }
    }
    ctx.globalAlpha = 1;
    // markers
    let lastLabelX = -1e9;
    for (let i = 0; i < _cpMarkers.length; i++) {
      const m = _cpMarkers[i];
      let rd = G.deg(m.rel);
      const off = Math.abs(rd) > span / 2 - 4;
      if (off) rd = clamp(rd, -(span / 2 - 4), span / 2 - 4);
      const x = cx + rd * ppd;
      ctx.globalAlpha = off ? 0.55 : 1;
      ctx.fillStyle = m.color;
      ctx.shadowColor = m.color; ctx.shadowBlur = 6;
      ctx.beginPath();
      if (m.kind === 'quest') { ctx.moveTo(x, 4); ctx.lineTo(x + 5, 10); ctx.lineTo(x, 16); ctx.lineTo(x - 5, 10); ctx.closePath(); }
      else if (m.kind === 'wp') { ctx.moveTo(x - 5, 4); ctx.lineTo(x + 5, 4); ctx.lineTo(x, 12); ctx.closePath(); }
      else { ctx.arc(x, 9, 3.5, 0, Math.PI * 2); }
      ctx.fill();
      ctx.shadowBlur = 0;
      if (off) { ctx.beginPath(); const dir = rd < 0 ? -1 : 1; ctx.moveTo(x + dir * 8, 9); ctx.lineTo(x + dir * 4, 5); ctx.lineTo(x + dir * 4, 13); ctx.closePath(); ctx.fill(); }
      if ((m.kind !== 'target' || m.dist > 8) && Math.abs(x - lastLabelX) > 30) {
        lastLabelX = x;
        ctx.font = '9px "Crimson Pro", Georgia, serif'; ctx.fillStyle = '#e8dcc0'; ctx.shadowColor = '#000'; ctx.shadowBlur = 2;
        ctx.fillText(m.dist >= 1000 ? (m.dist / 1000).toFixed(1) + 'km' : Math.round(m.dist) + 'm', x, ch - 9);
        ctx.shadowBlur = 0;
      }
    }
    ctx.globalAlpha = 1;
    // centre notch + heading
    ctx.fillStyle = '#ffe08a'; ctx.beginPath(); ctx.moveTo(cx, 1); ctx.lineTo(cx - 4, -4); ctx.lineTo(cx + 4, -4); ctx.closePath(); ctx.fill();
    ctx.fillRect(cx - 0.5, 1, 1, 6);
    ctx.font = '9px "Crimson Pro", Georgia, serif'; ctx.fillStyle = 'rgba(232,220,192,.7)'; ctx.textAlign = 'left';
    ctx.fillText(Math.round(((hdeg % 360) + 360) % 360) + '°', cx + 5, 6);
  }

  // ------------------------------------------------------------------------------------------------ auto-quest strip
  const aq = { el: null, text: null, count: null, fill: null, t: 0, last: {} };
  function _toggleAutoQuest() {
    if (!G.AutoQuest || (typeof G.AutoQuest.start !== 'function' && typeof G.AutoQuest.stop !== 'function')) { UI.notify('Auto-quest is not available.', 'warning'); return; }
    if (G.AutoQuest.active) { if (_has(G.AutoQuest, 'stop')) G.AutoQuest.stop(); UI.notify('Auto-quest stopped.', 'info'); }
    else { if (_has(G.AutoQuest, 'start')) G.AutoQuest.start(); UI.notify('Auto-quest started — press B to stop.', 'quest'); }
  }
  function _buildAutoquest(hud) {
    aq.text = el('span', { class: 'aq-text' });
    aq.count = el('span', { class: 'aq-count' });
    aq.fill = el('div', { class: 'fill green' });
    const stop = el('button', { class: 'btn small', text: 'Stop', onclick: function () { if (_has(G.AutoQuest, 'stop')) G.AutoQuest.stop(); } });
    aq.el = el('div', { id: 'autoquestStrip', class: 'hud-frame', hidden: true }, [el('span', { class: 'aq-dot' }), el('span', { class: 'aq-label', text: 'Auto-quest ▸' }), aq.text, aq.count, el('div', { class: 'bar' }, [aq.fill]), stop]);
    UI.bindTooltip(aq.el, function () { const s = (G.AutoQuest && typeof G.AutoQuest.status === 'function') ? G.AutoQuest.status() : null; return '<div class="tt-name">Auto-quest</div><div class="tt-line">' + esc(s && s.text ? s.text : 'Working…') + '</div><div class="tt-desc">The bot accepts, completes and turns in every quest. Press B or click Stop to take control back.' + (G.AutoQuest && G.AutoQuest.speed ? ' Speed ×' + G.AutoQuest.speed : '') + '</div>'; }, { live: true });
    hud.appendChild(aq.el);
  }
  function _updateAutoquest(dt) {
    aq.t += dt;
    const active = !!(G.AutoQuest && G.AutoQuest.active);
    if (!active) { if (!aq.el.hidden) { aq.el.hidden = true; _hudRoot.classList.remove('aq-on'); } return; }
    if (aq.el.hidden) { aq.el.hidden = false; _hudRoot.classList.add('aq-on'); aq.t = 1; }
    if (aq.t < 0.25) return;
    aq.t = 0;
    let s = null;
    try { s = typeof G.AutoQuest.status === 'function' ? G.AutoQuest.status() : G.AutoQuest.status; } catch (_) { s = null; }
    s = s || {};
    const qd = _questData(s.questId);
    const qname = (qd && qd.name) || s.questName || s.quest || (s.questId ? G.titleCase(s.questId) : 'Looking for work');
    const step = _str(s.text || s.step || '');
    const html = '<b>' + esc(qname) + '</b>' + (step ? ' — ' + esc(step) : '');
    if (aq.last.html !== html) { aq.last.html = html; aq.text.innerHTML = html; }
    let done = 0, total = 150, pct = _num(s.pct, 0);
    if (G.Quests && typeof G.Quests.completion === 'function') { try { const c = G.Quests.completion(); if (c) { done = _num(c.done, 0); total = _num(c.total, 150); pct = _num(c.pct, done / Math.max(1, total) * 100); } } catch (_) { /* ignore */ } }
    const cnt = done + '/' + total + ' (' + pct.toFixed(1) + '%)';
    _setText(aq.count, cnt, aq.last, 'cnt');
    _setW(aq.fill, pct / 100, aq.last, 'w');
  }

  // ------------------------------------------------------------------------------------------------ fps
  const fp = { el: null, ema: 0, t: 0, last: '' };
  UI.fps = 0;
  function _updateFps(dt) {
    if (dt > 0) { const f = 1 / dt; fp.ema = fp.ema ? fp.ema + (f - fp.ema) * 0.08 : f; }
    UI.fps = fp.ema;
    const show = !!(G.state.settings && G.state.settings.showFps);
    if (!show) { if (!fp.el.hidden) fp.el.hidden = true; return; }
    if (fp.el.hidden) fp.el.hidden = false;
    fp.t += dt;
    if (fp.t < 0.25) return;
    fp.t = 0;
    const fps = (G.Game && typeof G.Game.fps === 'number' && G.Game.fps > 0) ? G.Game.fps : fp.ema;
    let txt = Math.round(fps) + ' fps · ' + (fps > 0 ? (1000 / fps).toFixed(1) : '–') + ' ms';
    if (G.Game && typeof G.Game.drawCalls === 'number') txt += ' · ' + G.Game.drawCalls + ' dc';
    if (txt !== fp.last) { fp.last = txt; fp.el.textContent = txt; fp.el.classList.toggle('low', fps < 30); }
  }

  // ------------------------------------------------------------------------------------------------ death screen
  const ds = { el: null, count: null, t: -1, btn: null, lastTxt: '' };
  const DEATH_AUTO = 8;
  UI.DeathScreen = {
    visible: false,
    show: function () { if (!ds.el) return; ds.el.hidden = false; UI.DeathScreen.visible = true; ds.t = DEATH_AUTO; ds.lastTxt = ''; UI.tooltip.hide(); if (G.Input && typeof G.Input.exitLock === 'function') G.Input.exitLock(); },
    hide: function () { if (!ds.el) return; ds.el.hidden = true; UI.DeathScreen.visible = false; ds.t = -1; },
  };
  function _retreat() { UI.DeathScreen.hide(); if (_has(G.Player, 'respawn')) G.Player.respawn(); }
  function _buildDeath(overlays) {
    ds.count = el('div', { class: 'ds-count' });
    ds.btn = el('button', { class: 'btn big primary', text: 'Retreat', onclick: _retreat });
    ds.el = el('div', { id: 'deathScreen', hidden: true }, [
      el('div', { class: 'ds-title', text: 'You have been defeated' }),
      el('div', { class: 'ds-sub', text: 'Your spirit lingers at the edge of shadow. Retreat to the nearest rally point and take up the fight again.' }),
      ds.btn, ds.count,
    ]);
    overlays.appendChild(ds.el);
  }
  function _updateDeath(dt) {
    const p = _player();
    if (!p) return;
    const dead = !!(p.dead || p.alive === false);
    if (dead && !UI.DeathScreen.visible) UI.DeathScreen.show();
    if (!dead && UI.DeathScreen.visible) UI.DeathScreen.hide();
    if (!UI.DeathScreen.visible) return;
    ds.t -= dt;
    const s = Math.max(0, Math.ceil(ds.t));
    const txt = s > 0 ? 'Retreating automatically in ' + s + ' s' : 'Retreating…';
    if (txt !== ds.lastTxt) { ds.lastTxt = txt; ds.count.textContent = txt; }
    if (ds.t < -1.5 && dead) { ds.t = 5; _retreat(); }                                   // combat normally respawns at 8 s; this is a safety net
  }

  // ------------------------------------------------------------------------------------------------ zone banner
  const zb = { el: null, name: null, sub: null, t: -1 };
  function _buildZone(hud) {
    zb.name = el('div', { class: 'zb-name' }); zb.sub = el('div', { class: 'zb-sub' });
    zb.el = el('div', { id: 'zoneBanner' }, [zb.name, el('div', { class: 'zb-rule' }), zb.sub]);
    hud.appendChild(zb.el);
  }
  UI.showZone = function (zoneId) {
    const z = _zoneData(zoneId);
    if (!zb.el) return;
    zb.name.textContent = (z && z.name) || G.titleCase(zoneId || '');
    zb.sub.textContent = z && Array.isArray(z.level) ? 'Levels ' + z.level[0] + ' – ' + z.level[1] : '';
    zb.el.classList.remove('show'); void zb.el.offsetWidth; zb.el.classList.add('show');
    zb.t = 0;
    if (mm.zone) { mm.zone.textContent = zb.name.textContent; mm.last.zone = zb.name.textContent; }
  };
  function _updateZone(dt) { if (zb.t >= 0) { zb.t += dt; if (zb.t > 4.4) { zb.el.classList.remove('show'); zb.t = -1; } } }

  // ------------------------------------------------------------------------------------------------ quest tracker
  const qt = { el: null, list: null, count: null, toggle: null, collapsed: false, t: 0, sig: '' };
  UI.tracker = { get collapsed() { return qt.collapsed; }, set collapsed(v) { _trackerCollapse(v); }, refresh: function () { qt.sig = ''; qt.t = 1; } };
  function _trackerCollapse(v) {
    qt.collapsed = !!v;
    if (!qt.el) return;
    qt.el.classList.toggle('collapsed', qt.collapsed);
    qt.toggle.textContent = qt.collapsed ? '▸' : '▾';
  }
  function _questEntries() {
    const Q = G.Quests;
    if (!Q || typeof Q.active !== 'function') return [];
    let arr = null;
    try { arr = Q.active() || []; } catch (_) { return []; }
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const q = arr[i];
      const id = typeof q === 'string' ? q : (q && q.id);
      if (!id) continue;
      const data = _questData(id) || (q && typeof q === 'object' && Array.isArray(q.objectives) ? q : null);
      const st = (Q.state && Q.state[id]) || (q && typeof q === 'object' && q.status ? q : null) || { status: 'active', progress: [] };
      out.push({ id: id, data: data, st: st });
    }
    const tracked = Q.tracked;
    if (tracked) out.sort(function (a, b) { return (b.id === tracked) - (a.id === tracked); });
    return out;
  }
  function _objState(obj, st, i) {
    const count = Math.max(1, _num(obj.count, 1) | 0);
    const p = clamp(_num(st.progress && st.progress[i], 0) | 0, 0, count);
    const done = st.status === 'complete' || st.status === 'done' || p >= count;
    return { count: count, p: done ? count : p, done: done };
  }
  function _buildTracker(hud) {
    qt.count = el('span', { class: 'qt-count', text: 'Quests' });
    qt.toggle = el('span', { class: 'qt-toggle', text: '▾' });
    const head = el('div', { class: 'qt-head', onclick: function () { _trackerCollapse(!qt.collapsed); } }, [qt.count, qt.toggle]);
    UI.bindTooltip(head, '<div class="tt-name">Quest tracker</div><div class="tt-line">Click a quest name to track it; click an objective to open the journal (J).</div>');
    qt.list = el('div', { class: 'qt-list' });
    qt.el = el('div', { id: 'questTracker' }, [head, qt.list]);
    qt.el.addEventListener('wheel', function (e) { e.stopPropagation(); }, { passive: true });
    hud.appendChild(qt.el);
  }
  function _updateTracker(dt) {
    qt.t += dt;
    if (qt.t < 0.25) return;
    qt.t = 0;
    const entries = _questEntries();
    const tracked = G.Quests && G.Quests.tracked;
    let sig = (tracked || '') + '#';
    for (let i = 0; i < entries.length; i++) { const e = entries[i]; sig += e.id + ':' + (e.st.status || '') + ':' + (Array.isArray(e.st.progress) ? e.st.progress.join('.') : '') + '|'; }
    if (sig === qt.sig) return;
    qt.sig = sig;
    while (qt.list.firstChild) qt.list.removeChild(qt.list.firstChild);
    qt.count.textContent = 'Quests' + (entries.length ? ' (' + entries.length + ')' : '');
    if (!entries.length) { qt.list.appendChild(el('div', { class: 'qt-empty', text: 'No active quests. Look for ! above the heads of the folk in town.' })); return; }
    const MAX = 6;
    for (let i = 0; i < entries.length && i < MAX; i++) {
      const e = entries[i], d = e.data, st = e.st;
      const isTracked = e.id === tracked;
      const type = (d && d.type) || (e.id.charAt(0) === 's' ? 'story' : 'side');
      const name = (d && d.name) || G.titleCase(e.id);
      const nameRow = el('div', { class: 'qt-name', title: 'Click to track' }, [
        isTracked ? el('span', { class: 'qt-star', text: '★' }) : null,
        el('span', { class: 'chip ' + type, text: type === 'story' ? 'Story' : 'Side' }),
        el('span', { class: 'quest-name', text: name + (d && d.level ? ' (' + d.level + ')' : '') }),
      ]);
      (function (id) { nameRow.addEventListener('click', function () { if (_has(G.Quests, 'setTracked')) G.Quests.setTracked(id); qt.sig = ''; qt.t = 1; }); })(e.id);
      const box = el('div', { class: 'qt-quest' + (isTracked ? ' tracked' : '') }, [nameRow]);
      const objs = d && Array.isArray(d.objectives) ? d.objectives : [];
      const allDone = st.status === 'complete' || st.status === 'done';
      if (!allDone) for (let k = 0; k < objs.length; k++) {
        const o = objs[k], os = _objState(o, st, k);
        const showCount = os.count > 1 || o.type === 'kill' || o.type === 'collect' || o.type === 'use' || o.type === 'fish';
        const row = el('div', { class: 'quest-obj' + (os.done ? ' done' : '') }, [
          document.createTextNode(_str(o.label || G.titleCase(o.type || 'objective')) + (showCount ? ' ' : '')),
          showCount ? el('span', { class: 'qo-count', text: os.p + '/' + os.count }) : null,
        ]);
        (function (id) { row.addEventListener('click', function () { if (panels.journal) UI.openPanel('journal', id); if (G.UI.Journal && typeof G.UI.Journal.select === 'function') G.UI.Journal.select(id); }); })(e.id);
        box.appendChild(row);
      }
      if (allDone) box.appendChild(el('div', { class: 'qt-ready', text: 'Ready to turn in — talk to ' + _npcName((d && (d.turnin || d.giver)) || '') }));
      qt.list.appendChild(box);
    }
    if (entries.length > MAX) qt.list.appendChild(el('div', { class: 'qt-more', text: '+' + (entries.length - MAX) + ' more in your journal (J)' }));
  }

  // ------------------------------------------------------------------------------------------------ minimap
  const MM_SIZE = 200, MM_ZOOMS = [0.5, 1, 2];
  const mm = { el: null, canvas: null, ctx: null, zone: null, clock: null, coords: null, zoom: 1, t: 0, pulse: 0, dpr: 1, npcMarks: new Map(), last: {} };
  UI.minimap = {
    get zoom() { return mm.zoom; },
    set zoom(z) { UI.minimap.setZoom(z); },
    setZoom: function (z) { z = _num(z, 1); let best = MM_ZOOMS[0]; for (let i = 0; i < MM_ZOOMS.length; i++) if (Math.abs(MM_ZOOMS[i] - z) < Math.abs(best - z)) best = MM_ZOOMS[i]; mm.zoom = best; mm.t = 1; },
    zoomStep: function (dir) { const i = MM_ZOOMS.indexOf(mm.zoom); UI.minimap.setZoom(MM_ZOOMS[clamp(i + dir, 0, MM_ZOOMS.length - 1)]); },
    redraw: function () { mm.t = 1; },
    worldAt: function (sx, sy) { const p = _player(); if (!p || !p.pos) return null; return { x: p.pos.x + (sx - MM_SIZE / 2) / mm.zoom, z: p.pos.z + (sy - MM_SIZE / 2) / mm.zoom }; },
  };
  function _buildMinimap(hud) {
    mm.canvas = el('canvas', { width: MM_SIZE, height: MM_SIZE });
    mm.ctx = mm.canvas.getContext('2d');
    const zoomBox = el('div', { class: 'mm-zoom' }, [
      el('button', { class: 'btn', text: '+', title: 'Zoom in', onclick: function () { UI.minimap.zoomStep(1); } }),
      el('button', { class: 'btn', text: '−', title: 'Zoom out', onclick: function () { UI.minimap.zoomStep(-1); } }),
    ]);
    const ring = el('div', { class: 'mm-ring' }, [mm.canvas, el('div', { class: 'mm-frame' }), el('div', { class: 'mm-n', text: 'N' }), zoomBox]);
    mm.zone = el('div', { class: 'mm-zone', text: '' });
    mm.clock = el('span', { class: 'mm-clock', text: '08:00' });
    mm.coords = el('span', { class: 'mm-coords', text: '0, 0' });
    const info = el('div', { class: 'mm-info' }, [mm.zone, el('div', { class: 'mm-sub' }, [el('span', { text: '🕓 ' }), mm.clock, el('span', { text: '⌖ ' }), mm.coords])]);
    mm.el = el('div', { id: 'minimap', class: 'hud-frame' }, [ring, info]);
    mm.canvas.addEventListener('wheel', function (e) { e.preventDefault(); e.stopPropagation(); UI.minimap.zoomStep(e.deltaY < 0 ? 1 : -1); }, { passive: false });
    mm.canvas.addEventListener('click', function (e) {
      const r = mm.canvas.getBoundingClientRect();
      const w = UI.minimap.worldAt((e.clientX - r.left) / r.width * MM_SIZE, (e.clientY - r.top) / r.height * MM_SIZE);
      if (w) UI.setWaypoint(w.x, w.z, 'Minimap waypoint');
    });
    mm.canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); if (UI.waypoint) { UI.clearWaypoint(); UI.notify('Waypoint cleared.', 'info'); } });
    UI.bindTooltip(mm.canvas, function (node, e) {
      const r = mm.canvas.getBoundingClientRect();
      const w = UI.minimap.worldAt((e.clientX - r.left) / r.width * MM_SIZE, (e.clientY - r.top) / r.height * MM_SIZE);
      return '<div class="tt-name">Minimap</div><div class="tt-line">' + (w ? Math.round(w.x) + ', ' + Math.round(w.z) : '') + ' · zoom ×' + mm.zoom + '</div><div class="tt-sub">Click to set a waypoint · right-click clears · wheel zooms · M opens the map</div>';
    }, { live: true });
    hud.appendChild(mm.el);
  }
  function _npcMark(e) {
    if (e.questMark !== undefined && e.questMark !== null) return e.questMark ? _str(e.questMark) : '';
    const Q = G.Quests;
    if (!Q) return '';
    const key = e.typeId || e.npcId || e.id;
    const now = _now();
    let c = mm.npcMarks.get(key);
    if (c && now - c.t < 1) return c.mark;
    let mark = '';
    try {
      if (typeof Q.turnins === 'function' && (Q.turnins(key) || []).length) mark = '?';
      else if (typeof Q.available === 'function' && (Q.available(key) || []).length) mark = '!';
      else if (Q.state) { for (const id in Q.state) { const s = Q.state[id]; if (s && s.status === 'active') { const d = _questData(id); if (d && d.turnin === key) { mark = '?grey'; break; } } } }
    } catch (_) { mark = ''; }
    if (!c) { c = { mark: mark, t: now }; mm.npcMarks.set(key, c); } else { c.mark = mark; c.t = now; }
    return mark;
  }
  function _drawEdgeMarker(ctx, dx, dy, color, kind, pulse) {
    const R = MM_SIZE / 2, d = Math.sqrt(dx * dx + dy * dy);
    const inside = d < R - 10;
    let x = R + dx, y = R + dy;
    if (!inside) { const k = (R - 9) / d; x = R + dx * k; y = R + dy * k; }
    ctx.save();
    ctx.shadowColor = color; ctx.shadowBlur = 8;
    ctx.fillStyle = color;
    if (kind === 'quest') {
      const s = inside ? 5 + pulse * 2.5 : 5;
      ctx.globalAlpha = inside ? 0.75 + pulse * 0.25 : 0.9;
      ctx.beginPath(); ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath(); ctx.fill();
      if (inside) { ctx.globalAlpha = 0.35 * (1 - pulse); ctx.beginPath(); ctx.arc(x, y, 6 + pulse * 10, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke(); }
    } else {
      ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y - 5); ctx.lineTo(x, y + 4); ctx.closePath(); ctx.fill();
    }
    if (!inside) {                                                                       // direction arrow on the ring
      const a = Math.atan2(dy, dx);
      ctx.translate(x, y); ctx.rotate(a);
      ctx.globalAlpha = 1; ctx.beginPath(); ctx.moveTo(8, 0); ctx.lineTo(2, -4); ctx.lineTo(2, 4); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }
  function _drawMinimap() {
    const p = _player();
    const ctx = mm.ctx;
    if (!p || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (mm.dpr !== dpr) { mm.dpr = dpr; mm.canvas.width = Math.round(MM_SIZE * dpr); mm.canvas.height = Math.round(MM_SIZE * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const R = MM_SIZE / 2, zoom = mm.zoom, px = p.pos ? p.pos.x : 0, pz = p.pos ? p.pos.z : 0;
    const visM = MM_SIZE / zoom;
    ctx.clearRect(0, 0, MM_SIZE, MM_SIZE);
    ctx.save();
    ctx.beginPath(); ctx.arc(R, R, R, 0, Math.PI * 2); ctx.clip();
    let map = null;
    try { map = (G.Terrain && typeof G.Terrain.mapCanvas === 'function') ? G.Terrain.mapCanvas(1024) : null; } catch (_) { map = null; }
    if (map && map.width) {
      const world = (G.C && G.C.WORLD_SIZE) || 4096, half = world / 2;
      const mpp = map.width / world;                                                     // map pixels per metre
      const sw = visM * mpp, sh = visM * (map.height / world);
      const sx = (px + half) * mpp - sw / 2, sy = (pz + half) * (map.height / world) - sh / 2;
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.fillStyle = '#132a3a'; ctx.fillRect(0, 0, MM_SIZE, MM_SIZE);
      ctx.drawImage(map, sx, sy, sw, sh, 0, 0, MM_SIZE, MM_SIZE);
    } else { ctx.fillStyle = '#26361a'; ctx.fillRect(0, 0, MM_SIZE, MM_SIZE); }
    // subtle grid every 50 m (only at zoom ≥ 1)
    if (zoom >= 1) {
      ctx.strokeStyle = 'rgba(0,0,0,.10)'; ctx.lineWidth = 1;
      const step = 50 * zoom, ox = R - ((px % 50) + 50) % 50 * zoom, oy = R - ((pz % 50) + 50) % 50 * zoom;
      ctx.beginPath();
      for (let x = ox - Math.ceil(R / step) * step; x <= MM_SIZE; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, MM_SIZE); }
      for (let y = oy - Math.ceil(R / step) * step; y <= MM_SIZE; y += step) { ctx.moveTo(0, y); ctx.lineTo(MM_SIZE, y); }
      ctx.stroke();
    }
    // town / place labels
    const w = G.Data && G.Data.world;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const labelSets = [w && w.towns, w && w.pois, G.state.customPlaces, UI.customPlaces];
    for (let s = 0; s < labelSets.length; s++) {
      const arr = labelSets[s];
      if (!Array.isArray(arr)) continue;
      for (let i = 0; i < arr.length; i++) {
        const t = arr[i]; const tp = t && (t.pos || t);
        if (!tp || typeof tp.x !== 'number') continue;
        const dx = (tp.x - px) * zoom, dy = (tp.z - pz) * zoom;
        if (dx * dx + dy * dy > R * R * 1.1) continue;
        if (s === 1 && zoom < 1) continue;
        ctx.font = (s === 0 ? 'bold 10px ' : '9px ') + 'Cinzel, Georgia, serif';
        ctx.fillStyle = s === 0 ? '#fff3c4' : '#dfd2b0';
        ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
        ctx.fillText(_str(t.name), R + dx, R + dy - 6);
        ctx.shadowBlur = 0;
        ctx.fillStyle = s === 0 ? '#ffd54a' : '#c9b98a'; ctx.beginPath(); ctx.arc(R + dx, R + dy, 2, 0, Math.PI * 2); ctx.fill();
      }
    }
    // entities
    if (G.Spatial && typeof G.Spatial.query === 'function') {
      const list = G.Spatial.query(px, pz, visM * 0.72);
      const npcs = [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        if (!e || e === p || !e.pos || e.dead) continue;
        const dx = (e.pos.x - px) * zoom, dy = (e.pos.z - pz) * zoom;
        if (dx * dx + dy * dy > (R - 3) * (R - 3)) continue;
        const x = R + dx, y = R + dy;
        let color = null, r = 2.5;
        switch (e.kind) {
          case 'monster': color = e.hostile === false ? '#d9a06a' : '#ff4a3a'; r = e.boss ? 4.5 : e.elite ? 3.5 : 2.5; break;
          case 'npc': npcs.push(e); continue;
          case 'aiplayer': color = '#5aa0ff'; break;
          case 'node': color = '#5fbf5a'; break;
          case 'chest': color = '#ffd54a'; break;
          case 'boat': case 'dock': case 'fishspot': color = '#5fe0ff'; r = 3; break;
          default: continue;
        }
        ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1; ctx.stroke();
      }
      for (let i = 0; i < npcs.length; i++) {
        const e = npcs[i], x = R + (e.pos.x - px) * zoom, y = R + (e.pos.z - pz) * zoom;
        const mark = _npcMark(e);
        ctx.fillStyle = '#ffe86b'; ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,.6)'; ctx.lineWidth = 1; ctx.stroke();
        if (mark) {
          ctx.font = 'bold 12px Cinzel, Georgia, serif'; ctx.fillStyle = mark === '?grey' ? '#b8b8b8' : '#ffe86b';
          ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.fillText(mark.charAt(0), x, y - 8); ctx.shadowBlur = 0;
        }
      }
    }
    // tracked objective + waypoint
    if (G.Quests && typeof G.Quests.nextObjective === 'function' && G.Quests.tracked) {
      let o = null; try { o = G.Quests.nextObjective(G.Quests.tracked); } catch (_) { o = null; }
      if (o && o.pos) _drawEdgeMarker(ctx, (o.pos.x - px) * zoom, (o.pos.z - pz) * zoom, '#ffd54a', 'quest', mm.pulse);
    }
    if (UI.waypoint) _drawEdgeMarker(ctx, (UI.waypoint.x - px) * zoom, (UI.waypoint.z - pz) * zoom, '#5fe0ff', 'wp', mm.pulse);
    // player arrow
    ctx.save();
    ctx.translate(R, R); ctx.rotate(-_num(p.yaw, 0));
    ctx.shadowColor = '#000'; ctx.shadowBlur = 4;
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(6, 6); ctx.lineTo(0, 3); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#3a2b14'; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
    // view cone of the camera (light)
    ctx.save();
    ctx.translate(R, R); ctx.rotate(-_camYaw());
    const cone = ctx.createRadialGradient(0, 0, 4, 0, 0, 70);
    cone.addColorStop(0, 'rgba(255,240,200,.28)'); cone.addColorStop(1, 'rgba(255,240,200,0)');
    ctx.fillStyle = cone; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 70, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.5); ctx.closePath(); ctx.fill();
    ctx.restore();
    // inner vignette
    const vg = ctx.createRadialGradient(R, R, R * 0.7, R, R, R);
    vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,.55)');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, MM_SIZE, MM_SIZE);
    ctx.restore();
  }
  function _updateMinimap(dt) {
    mm.t += dt;
    mm.pulse = (Math.sin(_now() * 4) + 1) * 0.5;
    if (mm.t < 0.05) return;
    mm.t = 0;
    const p = _player();
    if (!p) return;
    _drawMinimap();
    const zid = G.state.zone || (G.Terrain && typeof G.Terrain.zoneAt === 'function' && p.pos ? G.Terrain.zoneAt(p.pos.x, p.pos.z) : '');
    const zd = _zoneData(zid);
    _setText(mm.zone, (zd && zd.name) || G.titleCase(zid || 'Middle-earth'), mm.last, 'zone');
    _setText(mm.clock, _clock(G.time && G.time.dayTime), mm.last, 'clock');
    _setText(mm.coords, (p.pos ? Math.round(p.pos.x) + ', ' + Math.round(p.pos.z) : '0, 0'), mm.last, 'coords');
  }

  // ------------------------------------------------------------------------------------------------ key help (F1)
  const KEY_GROUPS = [
    { title: 'Movement', rows: [
      [['W', 'A', 'S', 'D'], 'Move, relative to the camera'], [['Mouse'], 'Look around (pointer lock, or hold the right button and drag)'],
      [['Wheel'], 'Zoom the camera in and out'], [['Space'], 'Jump'], [['Q'], 'Dodge roll — a brief moment of invulnerability'],
      [['H'], 'Mount or dismount your horse'], [['NumLock'], 'Auto-run'] ] },
    { title: 'Combat', rows: [
      [['1', '2', '…', '9', '0'], 'Hotbar slots 1–10'], [['G', 'T', 'V', 'X', 'Y', 'Z', 'L', 'N', 'O', 'U'], 'Hotbar slots 11–20'],
      [['Tab'], 'Target the next enemy'], [['LMB'], 'Select a target / attack'], [['R'], 'Ranged attack with your equipped bow, javelin, staff…'] ] },
    { title: 'The World', rows: [
      [['E'], 'Interact: talk, open doors, gather, loot, board boats, fish spots'], [['F'], 'Fish — stand at the water\'s edge'],
      [['B'], 'Auto-quest: let the bot play through every quest'] ] },
    { title: 'Windows', rows: [
      [['I'], 'Inventory (200 slots)'], [['C'], 'Character sheet & equipment'], [['K'], 'Abilities & training'], [['J'], 'Quest journal'],
      [['M'], 'World map'], [['P'], 'Players of Middle-earth'], [['Esc'], 'Close the top window, or open Settings'], [['F1'], 'This key list'] ] },
    { title: 'Chat', rows: [
      [['Enter'], 'Type in chat — Enter sends, Esc cancels'], [['/say', '/w', '/me'], 'Speak, whisper, emote'], [['/who', '/time', '/fps', '/help'], 'Handy commands'] ] },
  ];
  function _buildKeyHelp(body) {
    const grid = el('div', { class: 'kh-grid' });
    KEY_GROUPS.forEach(function (g) {
      const box = el('div', { class: 'kh-group' }, [el('h4', { text: g.title })]);
      g.rows.forEach(function (r) {
        box.appendChild(el('div', { class: 'kh-row' }, [
          el('div', { class: 'kh-keys' }, r[0].map(function (k) { return k === '…' ? el('span', { text: '…', class: 'muted' }) : el('span', { class: 'keycap', text: k }); })),
          el('div', { class: 'kh-desc', text: r[1] }),
        ]));
      });
      grid.appendChild(box);
    });
    body.appendChild(grid);
    body.appendChild(el('div', { class: 'kh-note', text: 'Type the letters c-h-r-i-s at any time to open the admin panel. Windows can be dragged by their title bar; double-click a title to reset its position.' }));
  }

  // ------------------------------------------------------------------------------------------------ keys
  function _handleKeys() {
    const I = G.Input;
    if (!I || I.typing || typeof I.pressed !== 'function') return;
    const playing = G.state.phase === 'playing';
    if (I.pressed('Escape')) {
      I.consume('Escape');
      if (!_closeTop() && playing && panels.settings && !UI.DeathScreen.visible) UI.togglePanel('settings');
      return;
    }
    if (!playing) return;
    const modal = UI.anyModal();
    if (!modal && (I.pressed('Enter') || I.pressed('NumpadEnter'))) { I.consume('Enter'); I.consume('NumpadEnter'); UI.chatInput(); return; }
    if (I.pressed('F1') || (I.pressed('Slash') && (I.down('ShiftLeft') || I.down('ShiftRight')))) { I.consume('F1'); UI.togglePanel('keyhelp'); return; }
    if (I.pressed('KeyB')) { I.consume('KeyB'); _toggleAutoQuest(); return; }
    if (modal) return;
    for (const id in panels) {
      const k = panels[id].def.key;
      if (k && I.pressed(k)) { I.consume(k); UI.togglePanel(id); return; }
    }
  }

  // ------------------------------------------------------------------------------------------------ init / update / showHUD
  let _hudRoot = null, _inited = false, _errShown = false;
  UI.hudVisible = false;
  UI.init = function () {
    if (_inited) return UI;
    _inited = true;
    UI.addCSS(HUD_CSS);
    _ensureRoots();
    const uiRoot = document.getElementById('ui') || document.body;
    _hudRoot = document.getElementById('hud');
    if (!_hudRoot) { _hudRoot = el('div', { id: 'hud', hidden: true }); uiRoot.appendChild(_hudRoot); }
    let overlays = document.getElementById('overlays');
    if (!overlays) { overlays = el('div', { id: 'overlays' }); uiRoot.appendChild(overlays); }
    const hud = _hudRoot;
    _buildCompass(hud);
    _buildPlayerFrame(hud);
    _buildTargetFrame(hud);
    bf.el = el('div', { id: 'buffs' }); hud.appendChild(bf.el);
    _buildAutoquest(hud);
    fp.el = el('div', { id: 'fps', class: 'hud-frame', hidden: true }); hud.appendChild(fp.el);
    _buildMinimap(hud);
    _buildTracker(hud);
    _noticesEl = el('div', { id: 'notices' }); hud.appendChild(_noticesEl);
    _bigTitle = el('div', { class: 'big-title' }); _bigSub = el('div', { class: 'big-sub' });
    _bigEl = el('div', { id: 'bigNotice' }, [_bigTitle, el('div', { class: 'big-rule' }), _bigSub]); hud.appendChild(_bigEl);
    _buildZone(hud);
    _ftLayer = el('div', { id: 'floatLayer' }); hud.appendChild(_ftLayer);
    _buildHotbar(hud);
    _buildCastbar(hud);
    _buildInteract(hud);
    _buildXpbar(hud);
    _buildChat(hud);
    _lootList = el('div', { class: 'lw-list' }); _lootGold = el('div', { class: 'lw-gold', hidden: true });
    _lootEl = el('div', { id: 'lootWindow', class: 'hud-frame', hidden: true }, [el('div', { class: 'lw-title', text: 'Loot' }), _lootList, _lootGold]); hud.appendChild(_lootEl);
    _buildDeath(overlays);
    UI.registerPanel('keyhelp', { title: 'Key Bindings', key: 'F1', width: 720, pos: 'center', build: _buildKeyHelp });

    // ---- wiring
    G.on('gameStart', function () {
      UI.showHUD(true);
      UI.hotbarRefresh();
      UI.tracker.refresh();
      mm.npcMarks.clear();
      const p = _player();
      _sysLine('Welcome to Middle-earth' + (p && p.name ? ', ' + p.name : '') + '. Press F1 for the key bindings, Enter to chat, /help for commands.');
      if (G.state.zone) UI.showZone(G.state.zone);
    });
    G.on('playerDeath', function () { UI.DeathScreen.show(); _chatAppend('You have been defeated.', 'combat', ''); });
    G.on('playerRespawn', function () { UI.DeathScreen.hide(); });
    G.on('playerLevelUp', function (level) { UI.notifyBig('Level ' + _num(level, (_player() || {}).level || 1), 'You have grown in strength and renown'); _chatAppend('You have reached level ' + _num(level, 1) + '!', 'system', ''); });
    G.on('questAccepted', function () { UI.tracker.refresh(); });
    G.on('questProgress', function () { UI.tracker.refresh(); });
    G.on('questCompleted', function (id) { const d = _questData(id); UI.notifyBig('Quest Complete', d ? d.name : ''); UI.tracker.refresh(); mm.npcMarks.clear(); });
    G.on('zoneChanged', function (id) { UI.showZone(id); });
    G.on('abilityTrained', function () { UI.hotbarRefresh(); });
    G.on('load', function () { UI.hotbarRefresh(); UI.tracker.refresh(); mm.npcMarks.clear(); });
    G.on('pointerLock', function (locked) { if (locked) UI.tooltip.hide(); });
    document.addEventListener('mousedown', function (e) {
      const c = G.Input && G.Input.canvas;
      if (_relockArmed && c && e.target === c && e.button === 0) {
        _relockArmed = false;
        if (!UI.anyOpen() && G.state.phase === 'playing' && typeof G.Input.requestLock === 'function') G.Input.requestLock();
      }
    }, true);
    window.addEventListener('resize', function () {
      for (const id in panels) { const p = panels[id]; if (p.open) _clampPanel(p, p.el.offsetLeft, p.el.offsetTop); }
      cp.lastYaw = 1e9; mm.t = 1;
    });
    return UI;
  };

  UI.showHUD = function (visible) {
    if (!_inited) UI.init();
    UI.hudVisible = visible !== false;
    _hudRoot.hidden = !UI.hudVisible;
    if (UI.hudVisible) { UI.hotbarRefresh(); qt.sig = ''; qt.t = 1; mm.t = 1; cp.lastYaw = 1e9; }
    else { UI.tooltip.hide(); }
  };

  UI.update = function (dt) {
    if (!_inited) return;
    dt = clamp(_num(dt, 0), 0, 0.1);
    try {
      _handleKeys();
      _updateNotices(dt);
      if (tooltip.visible && _ttOwner && !_ttOwner.isConnected) tooltip.hide();
      if (!UI.hudVisible) return;
      _updatePlayerFrame();
      _updateTargetFrame();
      _updateBuffs(dt);
      _updateHotbar(dt);
      _updateCastbar();
      _updateXpbar();
      _updateInteract(dt);
      _updateCompass(dt);
      _updateAutoquest(dt);
      _updateFps(dt);
      _updateDeath(dt);
      _updateZone(dt);
      _updateLoot(dt);
      _updateFloatText(dt);
      _updateTracker(dt);
      _updateMinimap(dt);
    } catch (err) {
      if (!_errShown) { _errShown = true; if (G.reportError) G.reportError(err, 'UI.update'); G.warn('UI.update: ' + (err && err.message)); }
    }
  };

  G.log('30_ui_hud ready');
})();
