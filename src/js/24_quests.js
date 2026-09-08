/* ==== 24_quests.js — G.Quests: the quest state machine (150 story + side quests from G.Data.quests), tracker data,
   objective resolution (positions for the map / minimap / compass / beacon), reward hand-out, journal data and
   save serialisation; plus G.AutoQuest: the B-key bot that accepts, completes and turns in EVERY quest — a robust
   hierarchical state machine (guards → housekeeping → combat reflex → turn-ins → objective steps → acquire) with a
   watchdog on every wait (nudge → teleport → force-complete) so it can never dead-lock, ending with the full Armour
   of the Lost Kingdom equipped.

   G.Data.registerQuests(list) is defined here ONLY if no data module defined it: appends/replaces by id in
   G.Data.quests and rebuilds G.Data.questById (init()/refreshData() rebuild the indexes from whatever is there).

   G.Quests public API (SPEC §6.5 + the extras the HUD / NPCs / Admin / Save use):
     init(), update(dt), refreshData(), state (id → {status:'locked'|'available'|'active'|'complete'|'done',
     progress:[n…], accepted, completedAt}), get(id) → quest data, list (ordered quest array), storyIds, sideIds,
     available(npcId), turnins(npcId), activeFor(npcId), accept(id, opts?), abandon(id), canTurnIn(id),
     turnIn(id, chosenIndex?, opts?{auto, force, silent}), isDone(id), active() → [ids] (tracked first, then accept time),
     activeIds(), readyIds(), availableIds(), tracked, setTracked(id), nextObjective(id) → {objective, index, pos:{x,z},
     label, zone, kind, questId, npc?, entity?} | null, completion() → {done, total, pct, story:{done,total}, side:{done,total}},
     journalData(), serialize() / restore(data), onKill(typeId, ent?), onCollect(tid), onTalk(npcId, ent?),
     onExplore(pos), onFish(tid, spotId?), onUse(nodeId, node?), onDeliver(npcId), describeObjective(quest|id, i),
     objectiveState(id, i) → {progress, count, done}, questsInZone(zoneId), reset(id), completeInstantly(id, objIndex?),
     completeObjective(id, i), completeAll(), resetAll(), giverOf(id) → {id, name, pos, ent, interior, door},
     turninOf(id), questDropsFor(typeId) → [tid], bestChoice(id) → index, statusOf(id), progressOf(id, i),
     posOfNpc(npcId) → {x, z, ent, door, interior}, nextStory() → id|null, nextSide() → id|null, bookOf(quest).
   Events emitted: questAccepted(id), questProgress(id) (every change incl. status), questCompleted(id),
     questAbandoned(id), questTracked(id|null), questsInit, questsRestored. Writes G.state.questTarget = {x, z, label,
     questId, kind} | null and moves the FX beacon (G.FX.setBeacon) to the tracked objective.
   Objective semantics: kill (monster type, bosses of that type count), collect (count = inventory count; `from`
     monster → 100 % drop while active, implemented HERE on entityKilled; `node` → gather node; items removed on
     turn-in), talk (also completes when NPCs.talk / the dialogue panel opens for that NPC), explore (radius, default
     12, checked at 4 Hz), use (gather-node interaction counts), fish (optional `spot` / `item`), deliver (item granted
     on accept, consumed on talk), killboss (boss id or the boss's type). `sequential:true` → only the first unfinished
     objective progresses. Level is NEVER a gate — only prerequisites are. Unknown prerequisite ids are treated as done
     (once-warned) so the chain can never dead-end. Quest s100 (or rewards.lostKingdom) grants the full Lost Kingdom set.
   Kill credit: the entityKilled handler counts kills whose killer is the player (or an owner-chain to the player, or
     no killer = admin), de-duplicated against G.Combat's direct onKill call through a WeakSet of victims.

   G.AutoQuest public API: start(), stop(), toggle(), active, paused (admin panel open), speed (1 realistic … 3 default
     … 10 blazing; movement/teleport thresholds and fight pacing only), status() → {questId, questName, step, text, pct,
     done, total, kind, objIndex}, update(dt), log (ring buffer of the last 50 decisions: {t, text}), stats, plan (read-only).
   Bot tick order: guards (phase/dead/admin/sailing) → housekeeping every 3 s (auto-equip, train, sell junk protecting
     quest items, eat/drink) → combat reflex (monsters targeting us within 12 m / in combat) → plan (turn-ins →
     tracked/nearest active objective → acquire story-first → finish) → objective step → watchdogs. A tick that changed
     the world instantly (teleport, accept, turn-in, spawn, kill, talk, force) chains straight into the next tick inside
     the SAME frame (up to 6 at speed 10, 3 at ≥ 3, 1 at ≤ 2) — the bot's real budget is frames, not seconds, and a
     software-GL machine renders very few of them. Travel: goTo() with G.Player.autoMove, boat hops through
     G.Boats.pathToZone/instantTravel/sailTo (islands), nudge after 4 s/speed without progress, teleport (fade FX,
     landing inside the arrive radius) after 8 s/speed stuck, 90 s/speed on one target, > 200 m at speed ≥ 3, > 1200 m
     at speed ≤ 2, and for EVERY leg at speed 10 — three teleports that do not get closer fall back to walking.
     Every objective attempt has a total timeout (12 s at speed 10, else max(20, 120/speed) s without progress) →
     G.warn + completeObjective. Fights use abilities off cooldown + auto-attack, and are finished through
     G.Combat.kill after 1.5 s at speed 10 (60 s/speed below it), or at once against a foe that already killed us;
     at speed 10 the rest of the pack the objective still needs falls with it.
   Private helpers (rule 2, prefixed _): _sellJunkProtected (NPCs.remoteSellJunk cannot exclude quest items),
     _shorePoint (fishing shore search), _rootOwner (Combat's credit rule). Every cross-module call is guarded. ==== */
(function () {
  'use strict';
  const G = window.G;
  if (!G) return;
  const THREE = window.THREE;
  G.Data = G.Data || {};
  if (!Array.isArray(G.Data.quests)) G.Data.quests = [];
  if (!G.Data.questById || typeof G.Data.questById !== 'object') G.Data.questById = {};

  // ------------------------------------------------------------------------------------------------ small helpers
  const PI = Math.PI, TAU = Math.PI * 2;
  const EMPTY = Object.freeze({});
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  const hasFn = (o, k) => !!(o && typeof o[k] === 'function');
  const now = () => (G.time && typeof G.time.now === 'number') ? G.time.now : 0;
  const player = () => (G.state && G.state.player) || null;
  const world = () => (G.Data && G.Data.world) || null;
  const rand = () => (typeof G.rand === 'function') ? G.rand() : Math.random();
  const titleCase = (s) => (typeof G.titleCase === 'function') ? G.titleCase(String(s || '').replace(/[_-]+/g, ' ')) : String(s || '');
  const fmtMoney = (c) => (typeof G.fmtMoney === 'function') ? G.fmtMoney(c) : (c + 'c');
  const fmtNum = (n) => (typeof G.fmtNum === 'function') ? G.fmtNum(n) : String(n);
  function report(e, where) { if (typeof G.reportError === 'function') G.reportError(e, where); }
  function warn(msg) { if (typeof G.warn === 'function') G.warn(msg); }
  function log() { if (typeof G.log === 'function') G.log.apply(null, arguments); }
  function emit(evt, a, b) { if (typeof G.emit === 'function') G.emit(evt, a, b); }
  function sfx(name, o) { const A = G.Audio; if (!hasFn(A, 'sfx')) return; try { A.sfx(name, o); } catch (e) { /* audio is optional */ } }
  function notify(text, kind) { const U = G.UI; if (hasFn(U, 'notify')) { try { U.notify(text, kind || 'quest'); } catch (e) { report(e, 'Quests.notify'); } } else log('[notify]', text); }
  function notifyBig(text, sub) { const U = G.UI; if (hasFn(U, 'notifyBig')) { try { U.notifyBig(text, sub); } catch (e) { report(e, 'Quests.notifyBig'); } } else notify(text + (sub ? ' — ' + sub : ''), 'quest'); }
  function chat(text, channel) { const U = G.UI; if (hasFn(U, 'chat')) { try { U.chat(text, channel || 'system'); } catch (e) { report(e, 'Quests.chat'); } } }
  function dist2(ax, az, bx, bz) { const dx = ax - bx, dz = az - bz; return Math.sqrt(dx * dx + dz * dz); }
  function yawTo(fx, fz, tx, tz) { return Math.atan2(-(tx - fx), -(tz - fz)); }
  function zoneAt(x, z) {
    const T = G.Terrain; if (hasFn(T, 'zoneAt')) { try { const z0 = T.zoneAt(x, z); if (z0) return z0; } catch (e) { /* fall through */ } }
    const W = world(); if (W && hasFn(W, 'zoneAt')) return W.zoneAt(x, z);
    return (G.state && G.state.zone) || 'shire';
  }
  function isWaterAt(x, z) {
    const T = G.Terrain; if (hasFn(T, 'isWater')) return !!T.isWater(x, z);
    const W = world(); if (W && hasFn(W, 'isWater')) return !!W.isWater(x, z);
    return false;
  }
  function itemTemplate(tid) { if (!tid) return null; if (hasFn(G.Items, 'template')) return G.Items.template(tid); return (G.Data.items && G.Data.items[tid]) || null; }
  function itemName(tid) { const t = itemTemplate(tid); return (t && t.name) || titleCase(tid || 'item'); }
  function monsterName(typeId) { const W = world(); const m = W && W.monsterById && W.monsterById[typeId]; return (m && m.name) || titleCase(typeId || 'foe'); }
  function npcData(id) { const W = world(); return (W && W.npcById && W.npcById[id]) || null; }
  function npcName(id) { const d = npcData(id); if (d && d.name) return d.name; const e = hasFn(G.NPCs, 'get') ? G.NPCs.get(id) : null; return (e && e.name) || titleCase(id || 'someone'); }
  function bossData(id) { const W = world(); if (!W) return null; if (W.bossById && W.bossById[id]) return W.bossById[id]; if (Array.isArray(W.bosses)) for (let i = 0; i < W.bosses.length; i++) { const b = W.bosses[i]; if (b && (b.id === id || b.type === id)) return b; } return null; }
  function bossName(id) { const b = bossData(id); if (b && b.name) return b.name; if (b && b.type) return monsterName(b.type); return monsterName(id); }
  function nodeData(id) { const W = world(); return (W && W.nodeById && W.nodeById[id]) || null; }
  function nodeName(id) { const n = nodeData(id); if (n && n.name) return n.name; if (n && n.itemTid) return itemName(n.itemTid); return titleCase(id || 'object'); }
  function spotData(id) { const W = world(); return (W && W.spotById && W.spotById[id]) || null; }
  function zoneName(id) { const W = world(); const z = W && W.zoneById && W.zoneById[id]; return (z && z.name) || titleCase(id || ''); }
  function townOfNpc(id) { const d = npcData(id); const W = world(); const t = d && d.town && W && W.townById ? W.townById[d.town] : null; return t ? t.name : (d ? zoneName(d.zone) : ''); }
  function plural(n, word) { return (typeof G.plural === 'function') ? G.plural(n, word) : (n === 1 ? word : word + 's'); }
  /** Plural of a creature name — only the last word changes: "Greenway Wolf" → "Greenway Wolves", "Hillman" → "Hillmen",
   *  "Grey Lynx" → "Grey Lynxes", "Bree-land Boar" → "Bree-land Boars". */
  function pluralName(n, name) {
    name = String(name || '');
    if (n === 1 || !name) return name;
    const m = /^([\s\S]*?)([A-Za-z]+)$/.exec(name); if (!m) return name + 's';
    const head = m[1], w = m[2], lw = w.toLowerCase();
    let out;
    if (lw.length > 3 && /man$/.test(lw)) out = w.slice(0, -3) + (w.slice(-3) === 'man' ? 'men' : 'MEN');
    else if (/[^f]fe?$/.test(lw)) out = w.replace(/fe?$/, 'ves');
    else if (/[^aeiou]y$/.test(lw)) out = w.slice(0, -1) + 'ies';
    else if (/(s|x|z|ch|sh)$/.test(lw)) out = w + 'es';
    else out = w + 's';
    return head + out;
  }

  // ================================================================================================ registerQuests
  function indexOfId(list, id) { for (let i = 0; i < list.length; i++) if (list[i] && list[i].id === id) return i; return -1; }
  if (typeof G.Data.registerQuests !== 'function') {
    G.Data.registerQuests = function (list) {
      const D = G.Data;
      if (!Array.isArray(D.quests)) D.quests = [];
      const arr = Array.isArray(list) ? list : (list && typeof list === 'object' ? [list] : []);
      for (let i = 0; i < arr.length; i++) {
        const q = arr[i]; if (!q || typeof q.id !== 'string' || !q.id) continue;
        const k = indexOfId(D.quests, q.id);
        if (k >= 0) D.quests[k] = q; else D.quests.push(q);
      }
      const map = {};
      for (let i = 0; i < D.quests.length; i++) { const q = D.quests[i]; if (q && q.id) map[q.id] = q; }
      D.questById = map;
      if (G.Quests && G.Quests.inited && hasFn(G.Quests, 'refreshData')) G.Quests.refreshData();
      return D.quests.length;
    };
  }

  // ================================================================================================ G.Quests
  const Q = {};
  const OBJ_TYPES = { kill: 1, collect: 1, talk: 1, explore: 1, use: 1, fish: 1, deliver: 1, killboss: 1 };
  const COUNTED = { kill: 1, collect: 1, use: 1, fish: 1 };
  let list = [];                 // ordered quest data (story by id, then side by id)
  let byId = Object.create(null);
  let storyIds = [], sideIds = [];
  let dependants = Object.create(null);   // prereq id → [quest ids]
  const state = {};              // id → entry (plain object: HUD / Save iterate it)
  let tracked = null;
  let inited = false, hooked = false;
  let dropsByType = Object.create(null);
  let killSeen = (typeof WeakSet === 'function') ? new WeakSet() : null;
  const warnedPrereq = Object.create(null);
  let invDirty = false, exploreT = 0, markerT = 0, lastFrame = -1, lastProgressSfx = -10;
  const beacon = { x: NaN, z: NaN, has: false };
  const questTarget = { x: 0, z: 0, label: '', questId: null, kind: '' };
  let noQuestsWarned = false;

  Object.defineProperty(Q, 'state', { value: state, writable: false, enumerable: true });
  Object.defineProperty(Q, 'tracked', { get: function () { return tracked; }, set: function (v) { setTracked(v); }, enumerable: true });
  Object.defineProperty(Q, 'inited', { get: function () { return inited; }, enumerable: true });
  Object.defineProperty(Q, 'list', { get: function () { return list; }, enumerable: true });
  Object.defineProperty(Q, 'storyIds', { get: function () { return storyIds; }, enumerable: true });
  Object.defineProperty(Q, 'sideIds', { get: function () { return sideIds; }, enumerable: true });

  // ------------------------------------------------------------------------------------------------ data indexes
  function questType(q) { if (q.type === 'story' || q.type === 'side') return q.type; return (typeof q.id === 'string' && q.id.charAt(0) === 's') ? 'story' : 'side'; }
  function idSort(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }
  function normalizeObjective(o) {
    if (!o || typeof o !== 'object') return { type: 'explore', pos: { x: 0, z: 0 }, radius: 12, count: 1, label: 'Objective' };
    if (!OBJ_TYPES[o.type]) { warn('[Quests] unknown objective type "' + o.type + '" — treated as explore'); o.type = 'explore'; }
    if (!(num(o.count, 0) > 0)) o.count = 1; else o.count = Math.round(o.count);
    if (o.type === 'talk' || o.type === 'deliver' || o.type === 'explore' || o.type === 'killboss') o.count = 1;
    if (o.type === 'explore') { if (!o.pos || typeof o.pos.x !== 'number') o.pos = { x: 0, z: 0 }; if (!(num(o.radius, 0) > 0)) o.radius = 12; }
    if (!o.label) o.label = defaultLabel(o);
    return o;
  }
  function defaultLabel(o) {
    switch (o.type) {
      case 'kill': return 'Slay ' + pluralName(o.count, monsterName(o.target));
      case 'collect': return 'Collect ' + itemName(o.item);
      case 'talk': return 'Talk to ' + npcName(o.npc);
      case 'explore': return 'Explore ' + (o.name || 'the area');
      case 'use': return 'Search ' + nodeName(o.node);
      case 'fish': return 'Catch fish' + (o.spot && spotData(o.spot) ? ' at ' + spotData(o.spot).name : '');
      case 'deliver': return 'Deliver ' + itemName(o.item) + ' to ' + npcName(o.npc);
      case 'killboss': return 'Defeat ' + bossName(o.boss);
      default: return 'Objective';
    }
  }
  function buildIndexes() {
    const D = G.Data;
    const src = Array.isArray(D.quests) ? D.quests : [];
    const story = [], side = [];
    byId = Object.create(null); dependants = Object.create(null);
    for (let i = 0; i < src.length; i++) {
      const q = src[i];
      if (!q || typeof q.id !== 'string' || !q.id) continue;
      if (byId[q.id]) { warn('[Quests] duplicate quest id ' + q.id); continue; }
      q.type = questType(q);
      if (!q.name) q.name = titleCase(q.id);
      if (!Array.isArray(q.objectives) || !q.objectives.length) { warn('[Quests] quest ' + q.id + ' has no objectives — given a trivial explore'); q.objectives = [{ type: 'explore', pos: { x: 0, z: 0 }, radius: 1e9, label: 'Set out' }]; }
      for (let k = 0; k < q.objectives.length; k++) q.objectives[k] = normalizeObjective(q.objectives[k]);
      if (typeof q.prereq === 'string') q.prereq = [q.prereq];
      if (!q.rewards || typeof q.rewards !== 'object') q.rewards = {};
      if (!(num(q.level, 0) > 0)) q.level = 1;
      byId[q.id] = q;
      (q.type === 'story' ? story : side).push(q);
    }
    story.sort(idSort); side.sort(idSort);
    for (let i = 0; i < story.length; i++) {
      const q = story[i];
      if (!Array.isArray(q.prereq)) q.prereq = i > 0 ? [story[i - 1].id] : [];
      q.storyIndex = i + 1;
    }
    for (let i = 0; i < side.length; i++) { const q = side[i]; if (!Array.isArray(q.prereq)) q.prereq = []; q.sideIndex = i + 1; }
    list = story.concat(side);
    storyIds = story.map(function (q) { return q.id; });
    sideIds = side.map(function (q) { return q.id; });
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      for (let k = 0; k < q.prereq.length; k++) { const p = q.prereq[k]; if (!dependants[p]) dependants[p] = []; dependants[p].push(q.id); }
      if (q.next && byId[q.next]) { const nq = byId[q.next]; if (nq.prereq.indexOf(q.id) < 0 && nq.type === 'story' && q.type === 'story') { /* data says next but prereq disagrees — trust prereq */ } }
    }
    // G.Data.questById always mirrors the live array
    const map = {}; for (let i = 0; i < src.length; i++) { const q = src[i]; if (q && q.id) map[q.id] = q; }
    D.questById = map;
    if (!list.length && !noQuestsWarned) { noQuestsWarned = true; warn('[Quests] no quest data loaded (G.Data.quests is empty)'); }
  }
  function ensureEntry(id) {
    let st = state[id];
    if (!st) { st = state[id] = { status: 'locked', progress: [], accepted: 0, completedAt: 0 }; }
    const q = byId[id];
    if (q) { while (st.progress.length < q.objectives.length) st.progress.push(0); if (st.progress.length > q.objectives.length) st.progress.length = q.objectives.length; }
    return st;
  }
  function prereqsDone(q) {
    for (let i = 0; i < q.prereq.length; i++) {
      const p = q.prereq[i];
      if (!byId[p]) { if (!warnedPrereq[p]) { warnedPrereq[p] = true; warn('[Quests] ' + q.id + ' requires unknown quest "' + p + '" — treated as done'); } continue; }
      const st = state[p]; if (!st || st.status !== 'done') return false;
    }
    return true;
  }
  function recomputeAvailability() {
    let changed = false;
    for (let i = 0; i < list.length; i++) {
      const q = list[i], st = ensureEntry(q.id);
      if (st.status === 'locked' && prereqsDone(q)) { st.status = 'available'; changed = true; }
      else if (st.status === 'available' && !prereqsDone(q)) { st.status = 'locked'; changed = true; }
    }
    return changed;
  }
  function rebuildDrops() {
    const m = Object.create(null);
    for (let i = 0; i < list.length; i++) {
      const q = list[i], st = state[q.id];
      if (!st || st.status !== 'active') continue;
      const idx = activeIndices(q, st);
      for (let k = 0; k < idx.length; k++) {
        const o = q.objectives[idx[k]];
        if (o.type === 'collect' && o.from && o.item) { if (!m[o.from]) m[o.from] = []; if (m[o.from].indexOf(o.item) < 0) m[o.from].push(o.item); }
      }
    }
    dropsByType = m;
  }
  function markersDirty() { markerT = 1; }

  // ------------------------------------------------------------------------------------------------ objective state
  function objCount(o) { return Math.max(1, num(o.count, 1) | 0); }
  function objDone(q, st, i) { const o = q.objectives[i]; return num(st.progress[i], 0) >= objCount(o); }
  function allDone(q, st) { for (let i = 0; i < q.objectives.length; i++) if (!objDone(q, st, i)) return false; return true; }
  const _idxBuf = [];
  function activeIndices(q, st) {
    // returns a NEW array (callers may hold it across progress calls)
    const out = [];
    for (let i = 0; i < q.objectives.length; i++) {
      if (objDone(q, st, i)) continue;
      out.push(i);
      if (q.sequential) break;
    }
    return out;
  }
  function setProgress(id, i, value, opts) {
    const q = byId[id], st = state[id]; if (!q || !st || st.status !== 'active') return false;
    const o = q.objectives[i]; if (!o) return false;
    const cnt = objCount(o);
    const v = Math.max(0, Math.min(cnt, Math.round(num(value, 0))));
    const prev = num(st.progress[i], 0);
    if (v === prev) return false;
    st.progress[i] = v;
    const quiet = !!(opts && opts.quiet);
    if (v > prev && !quiet) {
      if (v >= cnt) notify(describeObjective(q, i) + ' — complete', 'quest'); else notify(describeObjective(q, i), 'quest');
      if (now() - lastProgressSfx > 0.4) { lastProgressSfx = now(); sfx('quest_progress', { vol: 0.7 }); }
    }
    if (allDone(q, st)) markComplete(id, quiet);
    else emit('questProgress', id);
    markersDirty();
    rebuildDrops();
    return true;
  }
  function addProgress(id, i, n, opts) { const st = state[id]; if (!st) return false; return setProgress(id, i, num(st.progress[i], 0) + num(n, 1), opts); }
  function markComplete(id, quiet) {
    const q = byId[id], st = state[id]; if (!q || !st) return;
    for (let i = 0; i < q.objectives.length; i++) st.progress[i] = objCount(q.objectives[i]);
    st.status = 'complete';
    const tin = q.turnin || q.giver;
    if (!quiet) { notify(q.name + ': objectives complete — return to ' + npcName(tin), 'quest'); chat('Quest "' + q.name + '" objectives complete. Return to ' + npcName(tin) + '.', 'system'); sfx('quest_progress'); }
    emit('questProgress', id);
    markersDirty(); rebuildDrops();
    if (hasFn(G.NPCs, 'refreshMarkers')) { try { G.NPCs.refreshMarkers(); } catch (e) { /* cosmetic */ } }
  }
  function revertIfIncomplete(id) {
    const q = byId[id], st = state[id]; if (!q || !st || st.status !== 'complete') return;
    // a collect objective whose items were sold / destroyed drops the quest back to active
    for (let i = 0; i < q.objectives.length; i++) {
      const o = q.objectives[i];
      if (o.type !== 'collect' || !o.item) continue;
      const have = countItem(o.item);
      if (have < objCount(o)) { st.status = 'active'; st.progress[i] = have; notify(q.name + ': you no longer carry enough ' + itemName(o.item), 'warning'); emit('questProgress', id); markersDirty(); rebuildDrops(); return; }
    }
  }
  function countItem(tid) { const p = player(); if (!p || !tid || !hasFn(G.Items, 'countInInventory')) return 0; try { return G.Items.countInInventory(p, tid); } catch (e) { return 0; } }

  // ------------------------------------------------------------------------------------------------ public queries
  function get(id) { return byId[id] || null; }
  function statusOf(id) { const st = state[id]; return st ? st.status : null; }
  function progressOf(id, i) { const st = state[id]; return st ? num(st.progress[i], 0) : 0; }
  function objectiveState(id, i) { const q = byId[id], st = state[id]; if (!q || !st || !q.objectives[i]) return null; const c = objCount(q.objectives[i]); const p = Math.min(c, num(st.progress[i], 0)); return { progress: st.status === 'complete' || st.status === 'done' ? c : p, count: c, done: st.status === 'complete' || st.status === 'done' || p >= c }; }
  function isDone(id) { const st = state[id]; return !!st && st.status === 'done'; }
  function canTurnIn(id) { const st = state[id]; return !!st && st.status === 'complete'; }
  function available(npcId) { const out = []; for (let i = 0; i < list.length; i++) { const q = list[i]; if (q.giver === npcId && state[q.id] && state[q.id].status === 'available') out.push(q.id); } return out; }
  function turnins(npcId) { const out = []; for (let i = 0; i < list.length; i++) { const q = list[i]; if ((q.turnin || q.giver) === npcId && state[q.id] && state[q.id].status === 'complete') out.push(q.id); } return out; }
  function activeFor(npcId) { const out = []; for (let i = 0; i < list.length; i++) { const q = list[i]; if ((q.turnin || q.giver) === npcId && state[q.id] && state[q.id].status === 'active') out.push(q.id); } return out; }
  function activeIds() { const out = []; for (let i = 0; i < list.length; i++) { const st = state[list[i].id]; if (st && st.status === 'active') out.push(list[i].id); } return out; }
  function readyIds() { const out = []; for (let i = 0; i < list.length; i++) { const st = state[list[i].id]; if (st && st.status === 'complete') out.push(list[i].id); } return out; }
  function availableIds() { const out = []; for (let i = 0; i < list.length; i++) { const st = state[list[i].id]; if (st && st.status === 'available') out.push(list[i].id); } return out; }
  function active() {
    const out = [];
    for (let i = 0; i < list.length; i++) { const st = state[list[i].id]; if (st && (st.status === 'active' || st.status === 'complete')) out.push(list[i].id); }
    out.sort(function (a, b) { if (a === tracked) return -1; if (b === tracked) return 1; return num(state[a].accepted, 0) - num(state[b].accepted, 0); });
    return out;
  }
  function questsInZone(zoneId) { const out = []; for (let i = 0; i < list.length; i++) if (list[i].zone === zoneId) out.push(list[i].id); return out; }
  function nextStory() { for (let i = 0; i < storyIds.length; i++) { const st = state[storyIds[i]]; if (st && st.status === 'available') return storyIds[i]; } return null; }
  function nextSide() { let best = null, bl = Infinity; for (let i = 0; i < sideIds.length; i++) { const id = sideIds[i], st = state[id]; if (!st || st.status !== 'available') continue; const L = num(byId[id].level, 1); if (L < bl) { bl = L; best = id; } } return best; }
  function bookOf(q) { q = typeof q === 'string' ? byId[q] : q; if (!q) return ''; if (q.book) return q.book; if (q.type !== 'story') return 'Side quests'; const plan = G.Data.xp && G.Data.xp.storyLevelPlan; if (Array.isArray(plan) && q.storyIndex) for (let i = 0; i < plan.length; i++) if (q.storyIndex >= plan[i].from && q.storyIndex <= plan[i].to) return 'Book ' + plan[i].book + ': ' + plan[i].name; return 'The Epic Story'; }
  function describeObjective(q, i) {
    q = typeof q === 'string' ? byId[q] : q; if (!q || !q.objectives || !q.objectives[i]) return '';
    const o = q.objectives[i], st = state[q.id];
    const cnt = objCount(o);
    let text = o.label || defaultLabel(o);
    if (cnt > 1 || COUNTED[o.type]) { const p = st ? (st.status === 'complete' || st.status === 'done' ? cnt : Math.min(cnt, num(st.progress[i], 0))) : 0; text += ' ' + p + '/' + cnt; }
    return text;
  }
  function setTracked(id) {
    if (id && (!state[id] || (state[id].status !== 'active' && state[id].status !== 'complete'))) id = null;
    if (id === tracked) return tracked;
    tracked = id || null;
    emit('questTracked', tracked);
    markersDirty();
    return tracked;
  }
  function autoTrack() {
    if (tracked && state[tracked] && (state[tracked].status === 'active' || state[tracked].status === 'complete')) return;
    const act = active();
    setTracked(act.length ? act[0] : null);
  }
  function completion() {
    let done = 0, sd = 0, dd = 0;
    for (let i = 0; i < list.length; i++) { const q = list[i], st = state[q.id]; if (st && st.status === 'done') { done++; if (q.type === 'story') sd++; else dd++; } }
    const total = list.length;
    return { done: done, total: total, pct: total ? done / total * 100 : 0, story: { done: sd, total: storyIds.length }, side: { done: dd, total: sideIds.length } };
  }
  function giverOf(id) { const q = byId[id]; if (!q) return null; return posOfNpc(q.giver); }
  function turninOf(id) { const q = byId[id]; if (!q) return null; return posOfNpc(q.turnin || q.giver); }
  function questDropsFor(typeId) { return dropsByType[typeId] || null; }

  // ------------------------------------------------------------------------------------------------ positions
  function posOfNpc(npcId) {
    if (!npcId) return null;
    const ent = hasFn(G.NPCs, 'get') ? G.NPCs.get(npcId) : null;
    let door = null, interior = false;
    if (ent && ent.interior && typeof ent.interior === 'object' && ent.interior.door) { door = ent.interior.door; interior = true; }
    else if (!ent && hasFn(G.Buildings, 'spotFor')) { try { const sp = G.Buildings.spotFor(npcId); if (sp && sp.building && sp.building.door) { door = sp.building.door; interior = true; } } catch (e) { /* optional */ } }
    if (ent && ent.pos) return { id: npcId, name: ent.name || npcName(npcId), x: interior && door ? door.pos.x : ent.pos.x, z: interior && door ? door.pos.z : ent.pos.z, ent: ent, interior: interior, door: door, inner: { x: ent.pos.x, z: ent.pos.z }, town: townOfNpc(npcId) };
    const d = npcData(npcId);
    if (d && d.pos) return { id: npcId, name: d.name || npcName(npcId), x: door ? door.pos.x : d.pos.x, z: door ? door.pos.z : d.pos.z, ent: null, interior: interior, door: door, inner: { x: d.pos.x, z: d.pos.z }, town: townOfNpc(npcId) };
    return null;
  }
  function spawnPosOf(typeId, from) {
    const fx = from ? num(from.x, 0) : 0, fz = from ? num(from.z, 0) : 0;
    if (hasFn(G.Monsters, 'nearestSpawnOf')) { try { const s = G.Monsters.nearestSpawnOf(typeId, from); if (s) return { x: s.x, z: s.z }; } catch (e) { /* fall through */ } }
    const W = world(); let best = null, bd = Infinity;
    if (W && Array.isArray(W.spawns)) for (let i = 0; i < W.spawns.length; i++) { const s = W.spawns[i]; if (!s || s.type !== typeId || !s.center) continue; const d = dist2(fx, fz, s.center.x, s.center.z); if (d < bd) { bd = d; best = s.center; } }
    if (W && Array.isArray(W.bosses)) for (let i = 0; i < W.bosses.length; i++) { const b = W.bosses[i]; if (!b || (b.type !== typeId && b.id !== typeId) || !b.pos) continue; const d = dist2(fx, fz, b.pos.x, b.pos.z); if (d < bd) { bd = d; best = b.pos; } }
    return best ? { x: best.x, z: best.z } : null;
  }
  function bossPosOf(bossId) {
    const b = bossData(bossId);
    if (b && b.pos) return { x: b.pos.x, z: b.pos.z, type: b.type || bossId, rec: b };
    const s = spawnPosOf(bossId, player() && player().pos);
    return s ? { x: s.x, z: s.z, type: bossId, rec: null } : null;
  }
  function nodePosOf(key, from) {
    if (!key) return null;
    if (hasFn(G.NPCs, 'nearestNode') && from) { try { const n = G.NPCs.nearestNode(key, from); if (n && n.pos) return { x: n.pos.x, z: n.pos.z, ent: n }; } catch (e) { /* fall through */ } }
    const W = world();
    const d = nodeData(key);
    if (d && d.pos) return { x: d.pos.x, z: d.pos.z, ent: null };
    if (W && Array.isArray(W.gatherNodes)) {
      let best = null, bd = Infinity; const fx = from ? num(from.x, 0) : 0, fz = from ? num(from.z, 0) : 0;
      for (let i = 0; i < W.gatherNodes.length; i++) { const g = W.gatherNodes[i]; if (!g || g.itemTid !== key || !g.pos) continue; const dd = dist2(fx, fz, g.pos.x, g.pos.z); if (dd < bd) { bd = dd; best = g; } }
      if (best) return { x: best.pos.x, z: best.pos.z, ent: null, nodeId: best.id };
    }
    return null;
  }
  function spotPosOf(spotId, from) {
    const W = world();
    const s = spotId ? spotData(spotId) : null;
    if (s && s.pos) return { x: s.pos.x, z: s.pos.z, spot: s };
    if (W && Array.isArray(W.fishingSpots) && W.fishingSpots.length) {
      let best = null, bd = Infinity; const fx = from ? num(from.x, 0) : 0, fz = from ? num(from.z, 0) : 0;
      for (let i = 0; i < W.fishingSpots.length; i++) { const sp = W.fishingSpots[i]; if (!sp || !sp.pos) continue; const d = dist2(fx, fz, sp.pos.x, sp.pos.z); if (d < bd) { bd = d; best = sp; } }
      if (best) return { x: best.pos.x, z: best.pos.z, spot: best };
    }
    return null;
  }
  function resolveObjective(q, i, from) {
    const o = q.objectives[i]; if (!o) return null;
    const res = { objective: o, index: i, pos: null, label: describeObjective(q, i), zone: q.zone || null, kind: o.type, questId: q.id, npc: null, entity: null, spot: null, type: null };
    let p = null;
    switch (o.type) {
      case 'kill': p = spawnPosOf(o.target, from); res.type = o.target; break;
      case 'killboss': { const b = bossPosOf(o.boss); if (b) { p = b; res.type = b.type; } break; }
      case 'collect':
        if (o.from) { p = spawnPosOf(o.from, from); res.type = o.from; }
        else { p = nodePosOf(o.node || o.item, from); if (p && p.ent) res.entity = p.ent; }
        break;
      case 'use': { p = nodePosOf(o.node || o.item, from); if (p && p.ent) res.entity = p.ent; break; }
      case 'talk': case 'deliver': { const n = posOfNpc(o.npc); if (n) { p = n; res.npc = n; res.entity = n.ent; } break; }
      case 'explore': p = o.pos; break;
      case 'fish': { const s = spotPosOf(o.spot, from); if (s) { p = s; res.spot = s.spot; } break; }
      default: break;
    }
    if (p && typeof p.x === 'number' && typeof p.z === 'number') { res.pos = { x: p.x, z: p.z }; res.zone = zoneAt(p.x, p.z) || res.zone; }
    return res;
  }
  function nextObjective(id) {
    const q = byId[id], st = state[id]; if (!q || !st) return null;
    const p = player(); const from = p && p.pos ? p.pos : null;
    if (st.status === 'complete' || st.status === 'available' || st.status === 'locked') {
      const npcId = st.status === 'complete' ? (q.turnin || q.giver) : q.giver;
      const n = posOfNpc(npcId); if (!n) return null;
      return { objective: null, index: -1, pos: { x: n.x, z: n.z }, label: (st.status === 'complete' ? 'Return to ' : 'Speak with ') + n.name + (n.town ? ' in ' + n.town : ''), zone: zoneAt(n.x, n.z), kind: st.status === 'complete' ? 'turnin' : 'giver', questId: id, npc: n, entity: n.ent, spot: null, type: null };
    }
    if (st.status !== 'active') return null;
    const idx = activeIndices(q, st); if (!idx.length) return null;
    if (idx.length === 1 || q.sequential || !from) return resolveObjective(q, idx[0], from);
    let best = null, bd = Infinity;
    for (let k = 0; k < idx.length; k++) {
      const r = resolveObjective(q, idx[k], from); if (!r) continue;
      const d = r.pos ? dist2(from.x, from.z, r.pos.x, r.pos.z) : 1e8;
      if (d < bd) { bd = d; best = r; }
    }
    return best || resolveObjective(q, idx[0], from);
  }

  // ------------------------------------------------------------------------------------------------ accept / abandon
  function accept(id, opts) {
    opts = opts || EMPTY;
    const q = byId[id]; if (!q) { warn('[Quests] accept: unknown quest ' + id); return false; }
    const st = ensureEntry(id);
    if (st.status === 'active' || st.status === 'complete' || st.status === 'done') return false;
    if (st.status === 'locked' && !opts.force) { notify('You must finish the preceding tale first.', 'warning'); return false; }
    st.status = 'active'; st.accepted = now(); st.completedAt = 0;
    for (let i = 0; i < q.objectives.length; i++) st.progress[i] = 0;
    const p = player();
    // deliver items are handed over on accept
    for (let i = 0; i < q.objectives.length; i++) {
      const o = q.objectives[i];
      if (o.type !== 'deliver' || !o.item || !p) continue;
      if (countItem(o.item) > 0) continue;
      const inst = makeItem(o.item);
      if (!inst) continue;
      let ok = false;
      try { ok = !!G.Items.addToInventory(p, inst, true); } catch (e) { report(e, 'Quests.accept:addToInventory'); }
      if (ok) notify('Received: ' + itemName(o.item), 'loot'); else { notify('Your bags are full — ' + itemName(o.item) + ' waits at your feet', 'warning'); dropAtFeet([inst]); }
    }
    // collect objectives may already be satisfied by what is in the bags
    for (let i = 0; i < q.objectives.length; i++) { const o = q.objectives[i]; if (o.type === 'collect' && o.item) st.progress[i] = Math.min(objCount(o), countItem(o.item)); }
    if (!opts.silent) {
      notify('New quest: ' + q.name, 'quest');
      chat('Quest accepted: "' + q.name + '"' + (q.text && q.text.accept ? ' — ' + q.text.accept : ''), 'system');
      sfx('quest_accept');
    }
    emit('questAccepted', id);
    if (!tracked || !state[tracked] || (state[tracked].status !== 'active' && state[tracked].status !== 'complete')) setTracked(id);
    rebuildDrops(); markersDirty();
    if (allDone(q, st)) markComplete(id, !!opts.silent); else { emit('questProgress', id); if (p && p.pos) onExplore(p.pos); }
    return true;
  }
  function abandon(id) {
    const q = byId[id], st = state[id]; if (!q || !st) return false;
    if (st.status !== 'active' && st.status !== 'complete') return false;
    const p = player();
    for (let i = 0; i < q.objectives.length; i++) { const o = q.objectives[i]; if (o.type === 'deliver' && o.item && p && hasFn(G.Items, 'removeFromInventory')) { try { G.Items.removeFromInventory(p, o.item, 99); } catch (e) { /* ignore */ } } }
    st.status = prereqsDone(q) ? 'available' : 'locked'; st.accepted = 0;
    for (let i = 0; i < q.objectives.length; i++) st.progress[i] = 0;
    notify('Quest abandoned: ' + q.name, 'warning');
    chat('Quest abandoned: "' + q.name + '".', 'system');
    emit('questAbandoned', id); emit('questProgress', id);
    if (tracked === id) { tracked = null; autoTrack(); }
    rebuildDrops(); markersDirty();
    return true;
  }
  function makeItem(tid, count) {
    if (!tid) return null;
    if (!itemTemplate(tid) && hasFn(G.Data, 'addItem')) {
      warn('[Quests] item "' + tid + '" is not defined by the item data — registering a plain quest item');
      try { G.Data.addItem({ id: tid, name: titleCase(tid), type: 'quest', slot: null, subtype: null, level: 1, rarity: 'common', value: 0, maxStack: 20, icon: '📜', iconBg: 0x5a4a2a, desc: 'A quest item.' }); } catch (e) { report(e, 'Quests.addItem'); }
    }
    if (!hasFn(G.Items, 'create')) return null;
    try { return G.Items.create(tid, count || 1); } catch (e) { report(e, 'Quests.makeItem'); return null; }
  }
  function dropAtFeet(insts, gold) {
    const p = player(); if (!p || !p.pos || !THREE) return null;
    const y = hasFn(G.Physics, 'groundY') ? G.Physics.groundY(p.pos.x, p.pos.z) : p.pos.y;
    const bag = {
      id: G.uid(), kind: 'chest', subkind: 'lootbag', name: 'Quest reward', level: num(p.level, 1),
      pos: new THREE.Vector3(p.pos.x, y, p.pos.z), vel: new THREE.Vector3(), yaw: num(p.yaw, 0), radius: 0.35, height: 0.5,
      alive: true, dead: false, loot: insts.filter(Boolean), gold: Math.max(0, num(gold, 0)), owner: p.id, from: 'quest', born: now(), expires: now() + 900,
      interact: { label: 'Loot', range: 2.5, fn: function (b) { if (hasFn(G.Combat, 'lootBag')) return G.Combat.lootBag(b, player()); return false; } }, fx: null, mesh: null, prop: null,
    };
    G.addEntity(bag);
    if (G.Combat && Array.isArray(G.Combat.lootBags)) G.Combat.lootBags.push(bag);
    if (hasFn(G.FX, 'spawn')) { try { bag.fx = G.FX.spawn('loot_glow', bag.pos, { color: 0xffd25a }); } catch (e) { bag.fx = null; } }
    notify('Your bags are full — the reward waits at your feet', 'warning');
    return bag;
  }

  // ------------------------------------------------------------------------------------------------ turn-in & rewards
  function bestChoice(idOrList) {
    const q = typeof idOrList === 'string' ? byId[idOrList] : null;
    const choose = q ? (q.rewards && q.rewards.choose) : idOrList;
    if (!Array.isArray(choose) || !choose.length) return -1;
    const p = player(); let best = 0, bs = -Infinity;
    for (let i = 0; i < choose.length; i++) {
      const tid = choose[i]; const t = itemTemplate(tid); if (!t) continue;
      let s = 0;
      try {
        if (hasFn(G.Items, 'score')) s = G.Items.score({ tid: tid, count: 1 }, p ? p.cls : null);
        if (p && hasFn(G.Items, 'canEquip') && t.slot) { const ce = G.Items.canEquip(p, { tid: tid, count: 1 }); if (!ce.ok) s -= 1000; }
        if (p && t.slot && p.equipment && p.equipment[t.slot] && hasFn(G.Items, 'score')) s -= G.Items.score(p.equipment[t.slot], p.cls) * 0.5;
      } catch (e) { s = 0; }
      if (s > bs) { bs = s; best = i; }
    }
    return best;
  }
  function giveItem(tid, count, silent) {
    const p = player(); if (!p) return false;
    const inst = makeItem(tid, count); if (!inst) { warn('[Quests] reward item "' + tid + '" could not be created'); return false; }
    let ok = false;
    try { ok = !!G.Items.addToInventory(p, inst, true); } catch (e) { report(e, 'Quests.giveItem'); }
    if (ok) { if (!silent) { notify('Received: ' + itemName(tid) + (count > 1 ? ' ×' + count : ''), 'loot'); chat('You receive ' + itemName(tid) + (count > 1 ? ' ×' + count : '') + '.', 'system'); } return true; }
    dropAtFeet([inst]);
    return true;
  }
  function awardTitle(t) {
    const p = player(); if (!p || !t) return false;
    const D = G.Data; let id = null;
    if (D && D.titleById && D.titleById[t]) id = t;
    else if (D && Array.isArray(D.titles)) for (let i = 0; i < D.titles.length; i++) { const x = D.titles[i]; if (x && (x.name === t || x.fem === t || x.id === t)) { id = x.id; break; } }
    if (id && hasFn(G.Progress, 'awardTitle')) { try { return !!G.Progress.awardTitle(id); } catch (e) { report(e, 'Quests.awardTitle'); } }
    if (!Array.isArray(p.titles)) p.titles = [];
    const key = id || t;
    if (p.titles.indexOf(key) >= 0) return false;
    p.titles.push(key); if (!p.activeTitle) p.activeTitle = key;
    notify('Title earned: ' + (hasFn(D, 'titleName') ? D.titleName(key, p.gender) : t), 'level');
    emit('titleEarned', key);
    return true;
  }
  function learnMount(tid) {
    const p = player(); if (!p || !tid) return false;
    if (!Array.isArray(p.mounts)) p.mounts = [];
    if (p.mounts.indexOf(tid) >= 0) return false;
    p.mounts.push(tid);
    if (!p.activeMount) p.activeMount = tid;
    notify('New steed: ' + itemName(tid) + ' — press H to ride', 'level');
    chat('You have been given the ' + itemName(tid) + '.', 'system');
    emit('mountLearned', tid);
    return true;
  }
  /** Equip the full Armour of the Lost Kingdom. Pieces already worn are kept, pieces already in the bags are equipped
   *  from there (no duplicates), missing ones are created; anything that cannot be worn yet stays in the bags.
   *  Returns the number of Lost Kingdom pieces worn afterwards (18 = complete). */
  function grantLostKingdom(silent) {
    const p = player(); if (!p) return 0;
    let set = null;
    if (hasFn(G.Items, 'lostKingdomSet')) { try { set = G.Items.lostKingdomSet(p.cls); } catch (e) { report(e, 'Quests.lostKingdomSet'); } }
    if (!Array.isArray(set)) return 0;
    if (hasFn(G.Items, 'canEquip') && !(p.level >= (G.C.LEVEL_CAP || 80))) warn('[Quests] Lost Kingdom set granted below the level cap — pieces wait in the bags until level ' + (G.C.LEVEL_CAP || 80));
    const spill = [];
    const slots = G.C.EQUIP_SLOTS || [];
    for (let i = 0; i < set.length; i++) {
      const inst = set[i]; if (!inst) continue;
      const slot = slots[i] || (itemTemplate(inst.tid) && itemTemplate(inst.tid).slot);
      let worn = false;
      for (const s in p.equipment) { const e = p.equipment[s]; if (e && e.tid === inst.tid) { worn = true; break; } }
      if (worn) continue;
      let ok = false;
      const idx = hasFn(G.Items, 'findInInventory') ? G.Items.findInInventory(p, inst.tid) : -1;
      if (idx >= 0 && hasFn(G.Items, 'equip')) { try { ok = !!G.Items.equip(p, idx, slot); } catch (e) { ok = false; } if (ok) continue; }
      if (idx < 0 && hasFn(G.Items, 'equipDirect')) { try { ok = !!G.Items.equipDirect(p, inst, slot); } catch (e) { ok = false; } }
      if (!ok && idx < 0) { let added = false; try { added = hasFn(G.Items, 'addToInventory') && G.Items.addToInventory(p, inst, true); } catch (e) { added = false; } if (!added) spill.push(inst); }
    }
    if (spill.length) dropAtFeet(spill);
    if (hasFn(G.Data.stats, 'compute')) { try { G.Data.stats.compute(p); } catch (e) { /* ignore */ } }
    let n = 0; for (const s in p.equipment) { const e = p.equipment[s]; if (e && (/^(s_lostkingdom_|lk_)/.test(e.tid))) n++; }
    if (!silent) { notifyBig('Armour of the Lost Kingdom', n >= 18 ? 'The greatest gear in Middle-earth is yours' : 'The set awaits you in your bags'); chat(n >= 18 ? 'You are clad in the full Armour of the Lost Kingdom.' : 'The Armour of the Lost Kingdom has been placed in your bags.', 'system'); sfx('achievement'); }
    emit('equipChanged', p);
    return n;
  }
  function isFinalQuest(q) { return !!q && (q.id === 's100' || (q.rewards && q.rewards.lostKingdom) || (q.type === 'story' && storyIds.length && storyIds[storyIds.length - 1] === q.id && q.storyIndex >= 100)); }
  function checkQuestTitles(justId) {
    const D = G.Data; if (!D || !Array.isArray(D.titles)) return;
    const c = completion();
    for (let i = 0; i < D.titles.length; i++) {
      const t = D.titles[i]; if (!t || t.kind !== 'quest' || !t.req) continue;
      if ((t.req.quest && t.req.quest === justId) || (typeof t.req.quests === 'number' && c.done >= t.req.quests)) awardTitle(t.id);
    }
  }
  function turnIn(id, chosenIndex, opts) {
    opts = opts || EMPTY;
    const q = byId[id], st = state[id]; if (!q || !st) return false;
    if (st.status !== 'complete') { if (!opts.force || st.status === 'done') return false; if (st.status !== 'active') { st.status = 'active'; st.accepted = now(); } }
    const rw = q.rewards || EMPTY;
    const choose = Array.isArray(rw.choose) ? rw.choose.filter(function (t) { return !!itemTemplate(t); }) : null;
    if (choose && choose.length && (chosenIndex == null || chosenIndex < 0 || chosenIndex >= choose.length)) {
      const Ch = G.UI && G.UI.Choose;
      if (!opts.auto && Ch && hasFn(Ch, 'open')) {
        try { Ch.open({ quest: q, items: choose, onPick: function (i) { turnIn(id, i, { auto: true, force: opts.force, silent: opts.silent }); } }); return false; }
        catch (e) { report(e, 'Quests.turnIn:Choose.open'); }
      }
      chosenIndex = bestChoice(choose);
    }
    const p = player();
    // consume collect items
    for (let i = 0; i < q.objectives.length; i++) {
      const o = q.objectives[i];
      if (o.type === 'collect' && o.item && p && hasFn(G.Items, 'removeFromInventory') && !o.keep) { try { G.Items.removeFromInventory(p, o.item, objCount(o)); } catch (e) { /* ignore */ } }
    }
    st.status = 'done'; st.completedAt = now();
    for (let i = 0; i < q.objectives.length; i++) st.progress[i] = objCount(q.objectives[i]);
    const silent = !!opts.silent;
    // rewards
    const xpApi = G.Data.xp;
    const xp = num(rw.xp, (xpApi && hasFn(xpApi, 'questXP')) ? xpApi.questXP(q.level, q.type) : 100 * num(q.level, 1));
    const gold = num(rw.gold, (xpApi && hasFn(xpApi, 'goldReward')) ? xpApi.goldReward(q.level, q.type) : 50 * num(q.level, 1));
    if (xp > 0 && hasFn(G.Progress, 'addXP')) { try { G.Progress.addXP(xp, { silent: silent }); } catch (e) { report(e, 'Quests.addXP'); } } else if (xp > 0 && p) p.xp = num(p.xp, 0) + xp;
    if (gold > 0 && hasFn(G.Progress, 'addGold')) { try { G.Progress.addGold(gold, { silent: silent }); } catch (e) { report(e, 'Quests.addGold'); } } else if (gold > 0 && p) p.gold = num(p.gold, 0) + gold;
    if (Array.isArray(rw.items)) for (let i = 0; i < rw.items.length; i++) { const it = rw.items[i]; if (typeof it === 'string') giveItem(it, 1, silent); else if (it && it.tid) giveItem(it.tid, num(it.count, 1), silent); }
    if (choose && choose.length) giveItem(choose[Math.max(0, Math.min(choose.length - 1, chosenIndex | 0))], 1, silent);
    if (rw.title) awardTitle(rw.title);
    if (rw.mount) learnMount(rw.mount);
    if (isFinalQuest(q)) { grantLostKingdom(silent); if (!rw.title) awardTitle('lord_lost_kingdom'); if (!rw.mount) learnMount((G.Data.lostKingdom && G.Data.lostKingdom.mount) || 'mount_lostkingdom'); }
    if (G.state && G.state.stats) G.state.stats.quests = num(G.state.stats.quests, 0) + 1;
    if (!silent) {
      notifyBig('Quest Complete', q.name);
      chat('Quest complete: "' + q.name + '" — ' + fmtNum(xp) + ' XP' + (gold > 0 ? ', ' + fmtMoney(gold) : '') + '.', 'system');
      if (q.text && q.text.complete) chat(npcName(q.turnin || q.giver) + ': ' + q.text.complete, 'say');
      sfx('quest_complete');
    }
    // unlock dependants / next
    recomputeAvailability();
    if (q.next && byId[q.next] && state[q.next] && state[q.next].status === 'locked' && prereqsDone(byId[q.next])) state[q.next].status = 'available';
    checkQuestTitles(id);
    emit('questCompleted', id);
    emit('questProgress', id);
    if (tracked === id) { tracked = null; autoTrack(); }
    rebuildDrops(); markersDirty();
    if (hasFn(G.NPCs, 'refreshMarkers')) { try { G.NPCs.refreshMarkers(); } catch (e) { /* cosmetic */ } }
    if (!opts.noSave && hasFn(G.Save, 'save')) { try { G.Save.save({ silent: true, reason: 'quest' }); } catch (e) { report(e, 'Quests.save'); } }
    return true;
  }

  // ------------------------------------------------------------------------------------------------ progress hooks
  function _rootOwner(e) { let o = e, guard = 0; while (o && o.owner && guard++ < 4) { const n = typeof o.owner === 'string' ? (G.state.byId && G.state.byId[o.owner]) : o.owner; if (!n) break; o = n; } return o; }
  function killerIsPlayer(killer) { if (!killer) return true; const p = player(); if (!p) return false; if (killer === p || killer.kind === 'player') return true; const o = _rootOwner(killer); return o === p || (o && o.kind === 'player'); }
  function bossMatches(o, typeId, ent) {
    if (!o.boss) return false;
    if (ent && ent.bossRec && ent.bossRec.id === o.boss) return true;
    if (ent && ent.bossId === o.boss) return true;
    const b = bossData(o.boss);
    if (b && b.type && b.type === typeId) return true;
    return o.boss === typeId && !!(ent ? ent.boss : true);
  }
  function onKill(typeId, ent) {
    if (ent && killSeen) { if (killSeen.has(ent)) return; killSeen.add(ent); }
    if (!typeId && ent) typeId = ent.typeId || (ent.type && ent.type.id) || null;
    const p = player();
    for (let i = 0; i < list.length; i++) {
      const q = list[i], st = state[q.id]; if (!st || st.status !== 'active') continue;
      const idx = activeIndices(q, st);
      for (let k = 0; k < idx.length; k++) {
        const oi = idx[k], o = q.objectives[oi];
        if (o.type === 'kill' && o.target === typeId) addProgress(q.id, oi, 1);
        else if (o.type === 'killboss' && bossMatches(o, typeId, ent)) addProgress(q.id, oi, 1);
        else if (o.type === 'collect' && o.from === typeId && o.item && p) {
          const need = objCount(o), have = countItem(o.item);
          if (have >= need) continue;
          const inst = makeItem(o.item, 1); if (!inst) continue;
          let ok = false;
          try { ok = !!G.Items.addToInventory(p, inst, true); } catch (e) { report(e, 'Quests.questDrop'); }
          if (ok) { notify('Quest item: ' + itemName(o.item) + ' (' + Math.min(need, have + 1) + '/' + need + ')', 'loot'); sfx('loot', { vol: 0.6 }); }
          else notify('Your bags are full — ' + itemName(o.item) + ' was lost', 'warning');
        }
      }
    }
  }
  function onEntityKilled(ev) {
    const v = ev && (ev.victim || (ev.kind ? ev : null)); if (!v || v.kind !== 'monster') return;
    if (!killerIsPlayer(ev.killer)) return;
    try { onKill(v.typeId || (v.type && v.type.id) || null, v); } catch (e) { report(e, 'Quests.onEntityKilled'); }
  }
  function onCollect(tid) {
    if (!tid) return;
    for (let i = 0; i < list.length; i++) {
      const q = list[i], st = state[q.id]; if (!st || st.status !== 'active') continue;
      const idx = activeIndices(q, st);
      for (let k = 0; k < idx.length; k++) { const oi = idx[k], o = q.objectives[oi]; if (o.type === 'collect' && o.item === tid) setProgress(q.id, oi, Math.min(objCount(o), countItem(tid))); }
    }
  }
  function recountAll() {
    for (let i = 0; i < list.length; i++) {
      const q = list[i], st = state[q.id]; if (!st) continue;
      if (st.status === 'complete') { revertIfIncomplete(q.id); continue; }
      if (st.status !== 'active') continue;
      const idx = activeIndices(q, st);
      for (let k = 0; k < idx.length; k++) { const oi = idx[k], o = q.objectives[oi]; if (o.type === 'collect' && o.item) setProgress(q.id, oi, Math.min(objCount(o), countItem(o.item)), { quiet: true }); }
    }
  }
  function onTalk(npcId, ent) {
    if (!npcId) return;
    const p = player();
    for (let i = 0; i < list.length; i++) {
      const q = list[i], st = state[q.id]; if (!st || st.status !== 'active') continue;
      const idx = activeIndices(q, st);
      for (let k = 0; k < idx.length; k++) {
        const oi = idx[k], o = q.objectives[oi];
        if (o.type === 'talk' && o.npc === npcId) setProgress(q.id, oi, 1);
        else if (o.type === 'deliver' && o.npc === npcId) {
          if (o.item && p && countItem(o.item) > 0 && hasFn(G.Items, 'removeFromInventory')) { try { G.Items.removeFromInventory(p, o.item, 1); } catch (e) { /* ignore */ } notify('Delivered: ' + itemName(o.item) + ' to ' + npcName(npcId), 'quest'); }
          else warn('[Quests] ' + q.id + ': delivering without ' + o.item + ' in the bags — objective completed anyway');
          setProgress(q.id, oi, 1);
        }
      }
    }
  }
  function onDeliver(npcId) { onTalk(npcId, null); }
  function onExplore(pos) {
    if (!pos) return;
    const px = num(pos.x, 0), pz = num(pos.z, 0);
    for (let i = 0; i < list.length; i++) {
      const q = list[i], st = state[q.id]; if (!st || st.status !== 'active') continue;
      const idx = activeIndices(q, st);
      for (let k = 0; k < idx.length; k++) {
        const oi = idx[k], o = q.objectives[oi];
        if (o.type !== 'explore' || !o.pos) continue;
        const r = num(o.radius, 12); const dx = px - o.pos.x, dz = pz - o.pos.z;
        if (dx * dx + dz * dz <= r * r) setProgress(q.id, oi, 1);
      }
    }
  }
  function nearestSpotId(pos) { const s = spotPosOf(null, pos); if (!s || !s.spot) return null; const r = num(s.spot.radius, 12) + 40; return dist2(pos.x, pos.z, s.x, s.z) <= r ? s.spot.id : null; }
  function onFish(tid, spotId) {
    const p = player();
    for (let i = 0; i < list.length; i++) {
      const q = list[i], st = state[q.id]; if (!st || st.status !== 'active') continue;
      const idx = activeIndices(q, st);
      for (let k = 0; k < idx.length; k++) {
        const oi = idx[k], o = q.objectives[oi];
        if (o.type !== 'fish') continue;
        if (o.item && tid && o.item !== tid) continue;
        if (o.spot) { const sid = spotId || (p && p.pos ? nearestSpotId(p.pos) : null); if (sid !== o.spot) continue; }
        addProgress(q.id, oi, 1);
      }
    }
  }
  function onUse(nodeId, node) {
    const itemTid = node && node.itemTid;
    for (let i = 0; i < list.length; i++) {
      const q = list[i], st = state[q.id]; if (!st || st.status !== 'active') continue;
      const idx = activeIndices(q, st);
      for (let k = 0; k < idx.length; k++) {
        const oi = idx[k], o = q.objectives[oi];
        if (o.type !== 'use') continue;
        if ((o.node && o.node === nodeId) || (!o.node && o.item && o.item === itemTid)) addProgress(q.id, oi, 1);
      }
    }
  }

  // ------------------------------------------------------------------------------------------------ admin
  function completeObjective(id, i) {
    const q = byId[id], st = state[id]; if (!q || !st) return false;
    if (st.status === 'available' || st.status === 'locked') accept(id, { force: true, silent: true });
    if (st.status !== 'active') return false;
    const o = q.objectives[i]; if (!o) return false;
    if (o.type === 'collect' && o.item) { const need = objCount(o) - countItem(o.item); if (need > 0) { const inst = makeItem(o.item, need); if (inst) { let ok = false; try { ok = !!G.Items.addToInventory(player(), inst, true); } catch (e) { ok = false; } if (!ok) o.keep = true; } } }
    if (o.type === 'deliver' && o.item && player() && hasFn(G.Items, 'removeFromInventory')) { try { G.Items.removeFromInventory(player(), o.item, 1); } catch (e) { /* ignore */ } }
    return setProgress(id, i, objCount(o));
  }
  function completeInstantly(id, objIndex) {
    const q = byId[id], st = state[id]; if (!q || !st) return false;
    if (typeof objIndex === 'number' && objIndex >= 0) return completeObjective(id, objIndex);
    if (st.status === 'done') return false;
    if (st.status !== 'active' && st.status !== 'complete') accept(id, { force: true, silent: true });
    for (let i = 0; i < q.objectives.length; i++) if (!objDone(q, st, i)) completeObjective(id, i);
    if (st.status === 'active') markComplete(id, false);
    return true;
  }
  function reset(id) {
    const q = byId[id], st = state[id]; if (!q || !st) return false;
    const p = player();
    for (let i = 0; i < q.objectives.length; i++) { const o = q.objectives[i]; if (o.type === 'deliver' && o.item && p && hasFn(G.Items, 'removeFromInventory')) { try { G.Items.removeFromInventory(p, o.item, 99); } catch (e) { /* ignore */ } } }
    st.status = 'locked'; st.accepted = 0; st.completedAt = 0;
    for (let i = 0; i < q.objectives.length; i++) st.progress[i] = 0;
    recomputeAvailability();
    if (tracked === id) { tracked = null; autoTrack(); }
    emit('questProgress', id);
    rebuildDrops(); markersDirty();
    if (hasFn(G.NPCs, 'refreshMarkers')) { try { G.NPCs.refreshMarkers(); } catch (e) { /* cosmetic */ } }
    return true;
  }
  function resetAll() {
    for (let i = 0; i < list.length; i++) { const q = list[i], st = ensureEntry(q.id); st.status = 'locked'; st.accepted = 0; st.completedAt = 0; for (let k = 0; k < q.objectives.length; k++) st.progress[k] = 0; }
    tracked = null;
    recomputeAvailability();
    rebuildDrops(); markersDirty();
    emit('questProgress', null);
    if (hasFn(G.NPCs, 'refreshMarkers')) { try { G.NPCs.refreshMarkers(); } catch (e) { /* cosmetic */ } }
    return true;
  }
  function completeAll() {
    let n = 0;
    for (let i = 0; i < list.length; i++) {
      const id = list[i].id, st = ensureEntry(id);
      if (st.status === 'done') continue;
      if (st.status !== 'active' && st.status !== 'complete') accept(id, { force: true, silent: true });
      for (let k = 0; k < list[i].objectives.length; k++) if (!objDone(list[i], st, k)) completeObjective(id, k);
      if (st.status === 'active') markComplete(id, true);
      if (turnIn(id, bestChoice(id), { auto: true, force: true, silent: true, noSave: true })) n++;
    }
    notifyBig('All quests complete', n + ' ' + plural(n, 'quest') + ' finished');
    if (hasFn(G.Save, 'save')) { try { G.Save.save({ silent: true, reason: 'admin' }); } catch (e) { /* ignore */ } }
    return n;
  }

  // ------------------------------------------------------------------------------------------------ journal / save
  function journalEntry(q) {
    const st = ensureEntry(q.id);
    const objs = [];
    for (let i = 0; i < q.objectives.length; i++) { const o = q.objectives[i], os = objectiveState(q.id, i); objs.push({ index: i, type: o.type, label: o.label, text: describeObjective(q, i), count: os.count, progress: os.progress, done: os.done, active: st.status === 'active' && activeIndices(q, st).indexOf(i) >= 0 }); }
    const rw = q.rewards || EMPTY; const xpApi = G.Data.xp;
    return {
      id: q.id, name: q.name, type: q.type, book: bookOf(q), level: q.level, zone: q.zone || null, zoneName: zoneName(q.zone), status: st.status, tracked: tracked === q.id,
      giver: q.giver, giverName: npcName(q.giver), giverTown: townOfNpc(q.giver), turnin: q.turnin || q.giver, turninName: npcName(q.turnin || q.giver), turninTown: townOfNpc(q.turnin || q.giver),
      objectives: objs, sequential: !!q.sequential, prereq: q.prereq.slice(), next: q.next || null, storyIndex: q.storyIndex || 0, sideIndex: q.sideIndex || 0,
      rewards: { xp: num(rw.xp, (xpApi && hasFn(xpApi, 'questXP')) ? xpApi.questXP(q.level, q.type) : 0), gold: num(rw.gold, (xpApi && hasFn(xpApi, 'goldReward')) ? xpApi.goldReward(q.level, q.type) : 0), items: Array.isArray(rw.items) ? rw.items.slice() : [], choose: Array.isArray(rw.choose) ? rw.choose.slice() : [], title: rw.title || null, mount: rw.mount || null },
      text: q.text || EMPTY, accepted: st.accepted, completedAt: st.completedAt,
    };
  }
  function journalData() {
    const out = { active: [], available: [], completed: [], locked: [], books: [], side: [], all: [], tracked: tracked, completion: completion() };
    const bookMap = Object.create(null);
    for (let i = 0; i < list.length; i++) {
      const e = journalEntry(list[i]); out.all.push(e);
      if (e.status === 'active' || e.status === 'complete') out.active.push(e); else if (e.status === 'available') out.available.push(e); else if (e.status === 'done') out.completed.push(e); else out.locked.push(e);
      if (e.type === 'story') { let b = bookMap[e.book]; if (!b) { b = bookMap[e.book] = { name: e.book, quests: [], done: 0 }; out.books.push(b); } b.quests.push(e); if (e.status === 'done') b.done++; }
      else out.side.push(e);
    }
    out.active.sort(function (a, b) { if (a.tracked) return -1; if (b.tracked) return 1; return num(a.accepted, 0) - num(b.accepted, 0); });
    return out;
  }
  function serialize() {
    const s = {};
    for (let i = 0; i < list.length; i++) { const id = list[i].id, st = state[id]; if (!st) continue; if (st.status === 'locked' && !st.accepted) continue; s[id] = { status: st.status, progress: st.progress.slice(), accepted: num(st.accepted, 0), completedAt: num(st.completedAt, 0) }; }
    return { v: 1, state: s, tracked: tracked };
  }
  function restore(data) {
    if (!inited) { buildIndexes(); inited = true; hook(); }
    const src = data && typeof data === 'object' ? (data.state && typeof data.state === 'object' ? data.state : data) : null;
    for (let i = 0; i < list.length; i++) { const q = list[i], st = ensureEntry(q.id); st.status = 'locked'; st.accepted = 0; st.completedAt = 0; for (let k = 0; k < q.objectives.length; k++) st.progress[k] = 0; }
    let n = 0;
    if (src) for (const id in src) {
      const e = src[id]; const q = byId[id]; if (!q || !e || typeof e !== 'object') continue;
      const st = ensureEntry(id);
      const status = (e.status === 'available' || e.status === 'active' || e.status === 'complete' || e.status === 'done' || e.status === 'locked') ? e.status : 'locked';
      st.status = status; st.accepted = num(e.accepted, 0); st.completedAt = num(e.completedAt, 0);
      if (Array.isArray(e.progress)) for (let k = 0; k < q.objectives.length; k++) st.progress[k] = Math.max(0, Math.min(objCount(q.objectives[k]), num(e.progress[k], 0) | 0));
      if (status === 'complete' || status === 'done') for (let k = 0; k < q.objectives.length; k++) st.progress[k] = objCount(q.objectives[k]);
      n++;
    }
    recomputeAvailability();
    tracked = null;
    const t = data && typeof data === 'object' ? data.tracked : null;
    if (t && state[t] && (state[t].status === 'active' || state[t].status === 'complete')) tracked = t; else autoTrack();
    invDirty = true;
    rebuildDrops(); markersDirty();
    emit('questsRestored', n);
    emit('questProgress', null);
    if (hasFn(G.NPCs, 'refreshMarkers')) { try { G.NPCs.refreshMarkers(); } catch (e) { /* cosmetic */ } }
    return n;
  }

  // ------------------------------------------------------------------------------------------------ markers / update
  function refreshBeacon() {
    let o = null;
    if (tracked) { try { o = nextObjective(tracked); } catch (e) { report(e, 'Quests.nextObjective'); o = null; } }
    if (o && o.pos) {
      if (!beacon.has || Math.abs(beacon.x - o.pos.x) > 0.25 || Math.abs(beacon.z - o.pos.z) > 0.25) {
        beacon.x = o.pos.x; beacon.z = o.pos.z; beacon.has = true;
        if (hasFn(G.FX, 'setBeacon')) { try { G.FX.setBeacon(o.pos); } catch (e) { /* fx optional */ } }
      }
      questTarget.x = o.pos.x; questTarget.z = o.pos.z; questTarget.label = o.label; questTarget.questId = o.questId; questTarget.kind = o.kind;
      G.state.questTarget = questTarget;
    } else {
      if (beacon.has) { beacon.has = false; beacon.x = beacon.z = NaN; if (hasFn(G.FX, 'setBeacon')) { try { G.FX.setBeacon(null); } catch (e) { /* ignore */ } } }
      G.state.questTarget = null;
    }
  }
  function update(dt) {
    if (!inited) return;
    const f = G.time ? G.time.frame : -1;
    if (f === lastFrame && f >= 0) return;          // main loop + 'update' event fallback: run once per frame
    lastFrame = f;
    dt = num(dt, 0); if (dt < 0) dt = 0; if (dt > 0.1) dt = 0.1;
    exploreT += dt; markerT += dt;
    if (exploreT >= 0.25) {
      exploreT = 0;
      const p = player();
      if (p && p.pos && p.alive !== false) onExplore(p.pos);
      if (invDirty) { invDirty = false; recountAll(); }
    }
    if (markerT >= 0.25) { markerT = 0; refreshBeacon(); }
  }
  function hook() {
    if (hooked || typeof G.on !== 'function') return;
    hooked = true;
    G.on('itemGained', function (ev) { const tid = ev && (ev.tid || (ev.item && ev.item.tid)); if (tid) onCollect(tid); });
    G.on('inventoryChanged', function () { invDirty = true; });
    G.on('entityKilled', onEntityKilled);
    G.on('npcTalk', function (npc) { if (npc && npc.npcId) onTalk(npc.npcId, npc); });
    G.on('panelOpened', function (id) { if (id === 'dialogue' && G.NPCs && G.NPCs.talking && G.NPCs.talking.npcId) onTalk(G.NPCs.talking.npcId, G.NPCs.talking); });
    G.on('update', function (dt) { update(dt); });
    G.on('gameStart', function () { if (!inited) init(); });
  }
  function init() {
    buildIndexes();
    for (const k in state) delete state[k];
    for (let i = 0; i < list.length; i++) ensureEntry(list[i].id);
    tracked = null;
    recomputeAvailability();
    rebuildDrops();
    inited = true;
    lastFrame = -1; exploreT = 0; markerT = 1; invDirty = false;
    beacon.has = false; beacon.x = beacon.z = NaN;
    G.state.questTarget = null;
    if (killSeen && typeof WeakSet === 'function') killSeen = new WeakSet();
    hook();
    emit('questsInit', list.length);
    if (hasFn(G.NPCs, 'refreshMarkers')) { try { G.NPCs.refreshMarkers(); } catch (e) { /* cosmetic */ } }
    log('[Quests] init:', list.length, 'quests (' + storyIds.length + ' story, ' + sideIds.length + ' side)');
    return Q;
  }
  function refreshData() {
    // quest data appended after init (registerQuests): index it without losing progress
    buildIndexes();
    for (let i = 0; i < list.length; i++) ensureEntry(list[i].id);
    recomputeAvailability(); rebuildDrops(); markersDirty();
  }

  Q.init = init; Q.update = update; Q.refreshData = refreshData;
  Q.get = get; Q.statusOf = statusOf; Q.progressOf = progressOf; Q.objectiveState = objectiveState;
  Q.available = available; Q.turnins = turnins; Q.activeFor = activeFor; Q.activeIds = activeIds; Q.readyIds = readyIds; Q.availableIds = availableIds;
  Q.accept = accept; Q.abandon = abandon; Q.canTurnIn = canTurnIn; Q.turnIn = turnIn; Q.isDone = isDone; Q.active = active;
  Q.setTracked = setTracked; Q.nextObjective = nextObjective; Q.completion = completion; Q.journalData = journalData;
  Q.serialize = serialize; Q.restore = restore;
  Q.onKill = onKill; Q.onCollect = onCollect; Q.onTalk = onTalk; Q.onExplore = onExplore; Q.onFish = onFish; Q.onUse = onUse; Q.onDeliver = onDeliver;
  Q.describeObjective = describeObjective; Q.questsInZone = questsInZone; Q.reset = reset; Q.completeInstantly = completeInstantly; Q.completeObjective = completeObjective;
  Q.completeAll = completeAll; Q.resetAll = resetAll; Q.giverOf = giverOf; Q.turninOf = turninOf; Q.questDropsFor = questDropsFor; Q.bestChoice = bestChoice;
  Q.posOfNpc = posOfNpc; Q.nextStory = nextStory; Q.nextSide = nextSide; Q.bookOf = bookOf; Q.resolveObjective = function (id, i) { const q = byId[id]; const p = player(); return q ? resolveObjective(q, i, p && p.pos) : null; };
  Q.grantLostKingdom = grantLostKingdom;
  G.Quests = Q;

  // ================================================================================================ G.AutoQuest
  // (own function scope: the bot's helpers must never shadow the quest machine's — e.g. both have an update())
  //
  // Pacing model. Headless / low-end machines may render only a few frames per second while the game clock advances
  // 0.05 s × G.time.scale per frame, so the bot's real budget is FRAMES, not seconds. Every wait is a game-time
  // watchdog (never wall clock, never a frame count), and speed ×10 ("blazing") collapses every step into as few
  // frames as possible: any travel leg teleports (fade FX), foes are stepped up to and finished after a short fight,
  // and a tick that changed the world instantly (teleport / accept / turn-in / spawn / kill / talk) chains straight
  // into the next tick within the same frame. Speeds 3–9 teleport only for long legs (> 200 m) or when stuck; speeds
  // 1–2 are realistic (walk, sail, fight it out) with the same watchdogs as a safety net.
  (function () {
  const AQ = { active: false, paused: false, speed: 3, log: [], stats: { ticks: 0, chained: 0, teleports: 0, nudges: 0, forced: 0, fights: 0, kills: 0, deaths: 0, errors: 0, spawns: 0, boats: 0, packKills: 0 } };
  const LOG_MAX = 50;
  const FIGHT_FRAMES = 2;          // rendered frames of real combat before the engine finishes a foe at speed 10
  const S = {
    planKind: '', questId: null, objIndex: -1, planKey: '', planT: 0, planDirty: true,
    attemptStart: 0, lastProg: -1, text: '', step: '', lastTextKey: '',
    sub: null, target: null, fightStart: 0, fightFrame0: 0, fightKey: '', nextAbilityT: 0, potionT: -1e9, foodT: -1e9, houseT: 0,
    deadSince: -1, respawnedAt: -1e9, errStreak: 0, flashT: -1e9, tpNotifyT: -1e9, stuckNotified: false, lastKillsSeen: 0,
    deathsOn: Object.create(null), deathTypes: Object.create(null), lastDeathT: -1e9, engageT: -1e9,
    buffCast: Object.create(null), rangedCls: null, rangedFor: null, busyT: 0, chain: false,
    statusObj: { questId: null, questName: '', step: '', text: '', pct: 0, done: 0, total: 0, kind: '', objIndex: -1 },
  };
  const T = { x: NaN, z: NaN, arrive: 1.5, start: 0, bestDist: Infinity, lastProg: 0, nudgeUntil: 0, nudgeX: 0, nudgeZ: 0, nudgeT: -1e9, hops: null, hopI: 0, sailing: false, sailT: 0, sailLabel: '', key: '', tpT: -1, tpKey: '', tpFail: 0 };

  function logLine(text) {
    const e = { t: now(), text: String(text) };
    AQ.log.push(e); if (AQ.log.length > LOG_MAX) AQ.log.shift();
    log('[AutoQuest]', e.text);
  }
  function frameNo() { return (G.time && typeof G.time.frame === 'number') ? G.time.frame : 0; }
  function speed() { const s = num(AQ.speed, 3); return s < 1 ? 1 : s > 10 ? 10 : s; }
  function blazing() { return speed() >= 10; }
  function alive(e) { return !!e && e.alive !== false && !e.dead; }
  function pdist(x, z) { const p = player(); return p && p.pos ? dist2(p.pos.x, p.pos.z, x, z) : Infinity; }
  function setText(key, text, step) { if (key === S.lastTextKey) return; S.lastTextKey = key; S.text = text; S.step = step || text; }
  function adminOpen() { const U = G.UI; if (!U) return false; if (hasFn(U, 'isOpen') && U.isOpen('admin')) return true; return !!(U.Admin && U.Admin.open === true && U.Admin.visible); }
  function morale01(p) { const m = p && p.stats ? num(p.stats.maxMorale, 0) : 0; return m > 0 ? num(p.morale, 0) / m : 1; }
  function inCombat(p) { if (hasFn(G.Combat, 'inCombatFor')) { try { return !!G.Combat.inCombatFor(p); } catch (e) { return false; } } return !!(G.state && G.state.inCombat); }
  function dismount() { const p = player(); if (p && p.mounted && hasFn(G.Player, 'dismount')) { try { G.Player.dismount(); } catch (e) { /* ignore */ } } }
  function autoStop() { if (G.Player && G.Player.autoMoving && hasFn(G.Player, 'autoStop')) { try { G.Player.autoStop(); } catch (e) { /* ignore */ } } }
  /** Face (x, z) with the body AND the chase camera. Modules that ask "what is the player looking at?" read
   *  G.Player.getForward() — which is built from the CAMERA yaw (26_fishing_boats' canFish/castPoint do exactly
   *  that) — so turning only `player.yaw` leaves them probing wherever the camera was left pointing. */
  function faceYaw(yaw) {
    const p = player(); if (!p) return;
    p.yaw = yaw;
    const c = G.Player && G.Player.cam;
    if (c && typeof c.yaw === 'number') c.yaw = yaw;
    if (p.rig && p.rig.group && p.rig.group.rotation) p.rig.group.rotation.y = yaw;
  }
  function facePoint(x, z) { const p = player(); if (!p) return; const dx = x - p.pos.x, dz = z - p.pos.z; if (dx * dx + dz * dz > 1e-4) faceYaw(Math.atan2(-dx, -dz)); }
  /** Something changed instantly (teleport, accept, kill, …): let the next tick run in this very frame. */
  function chain() { S.chain = true; }

  // ------------------------------------------------------------------------------------------------ lifecycle
  function resetState() {
    S.planKind = ''; S.questId = null; S.objIndex = -1; S.planKey = ''; S.planT = 0; S.planDirty = true;
    S.attemptStart = now(); S.lastProg = -1; S.text = ''; S.step = ''; S.lastTextKey = '';
    S.sub = null; S.target = null; S.fightStart = 0; S.fightFrame0 = 0; S.fightKey = ''; S.nextAbilityT = 0; S.houseT = 0; S.deadSince = -1; S.errStreak = 0; S.busyT = 0;
    S.deathsOn = Object.create(null); S.deathTypes = Object.create(null); S.lastDeathT = -1e9; S.respawnedAt = -1e9; S.engageT = -1e9; S.chain = false;
    T.x = T.z = NaN; T.hops = null; T.hopI = 0; T.sailing = false; T.key = ''; T.nudgeUntil = 0; T.tpT = -1; T.tpKey = ''; T.tpFail = 0;
  }
  function start() {
    if (AQ.active) return true;
    if (!player()) { notify('Auto-quest: no character in the world.', 'warning'); return false; }
    if (G.state && G.state.phase !== 'playing') { notify('Auto-quest only works in the world.', 'warning'); return false; }
    if (!Q.inited) init();
    resetState();
    AQ.active = true; AQ.paused = false;
    if (!adminOpen() && hasFn(G.UI, 'closeAll')) { try { G.UI.closeAll(); } catch (e) { /* ignore */ } }
    const c = completion();
    logLine('started — ' + c.done + '/' + c.total + ' quests done, speed ×' + speed());
    chat('Auto-quest engaged (speed ×' + speed() + '). Press B to take control back.', 'system');
    emit('autoQuestStart');
    return true;
  }
  function stop(reason) {
    if (!AQ.active) return false;
    AQ.active = false; AQ.paused = false;
    autoStop();
    if (G.Fishing) { G.Fishing.autoActive = false; if (G.Fishing.state && G.Fishing.state !== 'idle' && hasFn(G.Fishing, 'cancel')) { try { G.Fishing.cancel(false); } catch (e) { /* ignore */ } } }
    S.target = null;
    setText('stopped', 'Stopped', 'Stopped');
    logLine('stopped' + (reason ? ' — ' + reason : ''));
    emit('autoQuestStop', reason || null);
    return true;
  }
  function toggle() { return AQ.active ? stop('toggled') : start(); }
  function status() {
    const o = S.statusObj;
    const c = completion();
    const q = S.questId ? byId[S.questId] : null;
    o.questId = S.questId; o.questName = q ? q.name : (S.planKind === 'finish' ? 'All quests complete' : S.planKind === 'stuck' ? 'No quests available' : (AQ.active ? 'Looking for work' : 'Idle'));
    o.step = S.step; o.text = S.text; o.pct = c.pct; o.done = c.done; o.total = c.total; o.kind = S.planKind; o.objIndex = S.objIndex;
    if (AQ.paused) o.text = 'Paused — close the admin panel to continue';
    return o;
  }

  // ------------------------------------------------------------------------------------------------ travel primitive
  /** Teleport to free, dry ground within `radius` (default 4 m) of (x, z), arriving from the side we came from.
   *  `keepRoute` preserves a boat itinerary in progress. Returns true when the player moved. */
  function teleportNear(x, z, why, radius, keepRoute) {
    const p = player(); if (!p || !hasFn(G.Player, 'teleport')) return false;
    const rad = Math.max(0.8, num(radius, 4));
    const a0 = Math.atan2(p.pos.z - z, p.pos.x - x);
    let best = null;
    for (let i = 0; i < 10 && !best; i++) {
      const a = a0 + (i === 0 ? 0 : ((i & 1) ? 1 : -1) * Math.ceil(i / 2) * 0.7);
      const r = rad * (i < 4 ? 0.85 : 0.6);
      const px = x + Math.cos(a) * r, pz = z + Math.sin(a) * r;
      if (isWaterAt(px, pz)) continue;
      let f = { x: px, z: pz };
      if (hasFn(G.Physics, 'nearestFree')) { try { const g = G.Physics.nearestFree(px, pz, 0.45); if (g && g.x === g.x && g.z === g.z) f = g; } catch (e) { f = { x: px, z: pz }; } }
      if (dist2(f.x, f.z, x, z) <= rad + 0.6 && !isWaterAt(f.x, f.z)) best = f;
    }
    if (!best) { const r = Math.min(rad, 1.2); best = { x: x + Math.cos(a0) * r, z: z + Math.sin(a0) * r }; }   // e.g. a foe standing in the sea: stand as close as we can
    const hops = T.hops, hi = T.hopI;
    try { if (G.Player.teleport(best.x, best.z, yawTo(best.x, best.z, x, z)) === false) return false; } catch (e) { report(e, 'AutoQuest.teleport'); return false; }
    AQ.stats.teleports++;
    if (now() - S.tpNotifyT > 4) { S.tpNotifyT = now(); notify('Auto-quest: travelling…', 'info'); }
    logLine('teleport → (' + Math.round(x) + ', ' + Math.round(z) + ')' + (why ? ' [' + why + ']' : ''));
    T.x = T.z = NaN; T.hops = null; T.sailing = false; T.nudgeUntil = 0; T.tpT = now();
    if (keepRoute) { T.hops = hops; T.hopI = hi; }
    chain();
    return true;
  }
  function beginTravel(x, z, arrive, opts) {
    const key = opts && opts.key ? opts.key : '';
    if (key !== T.key) T.tpFail = 0;
    T.x = x; T.z = z; T.arrive = arrive; T.start = now(); T.bestDist = Infinity; T.lastProg = now(); T.nudgeUntil = 0; T.nudgeT = -1e9; T.hops = null; T.hopI = 0; T.sailing = false; T.key = key;
    const p = player();
    // boat route needed? (islands: G.Boats knows which docks connect the zones)
    if (p && G.Boats && hasFn(G.Boats, 'pathToZone') && !(opts && opts.noBoat)) {
      const zTarget = zoneAt(x, z), zHere = zoneAt(p.pos.x, p.pos.z);
      if (zTarget && zHere && zTarget !== zHere) {
        let hops = null;
        try { hops = G.Boats.pathToZone(p.pos, zTarget); } catch (e) { hops = null; }
        if (Array.isArray(hops) && hops.length > 1) { T.hops = hops.map(function (h) { return typeof h === 'string' ? (hasFn(G.Boats, 'dockById') ? G.Boats.dockById(h) : dockData(h)) : h; }).filter(function (h) { return h && h.pos && h.id; }); T.hopI = 0; if (T.hops.length > 1) logLine('sea route: ' + T.hops.map(function (h) { return h.name || h.id; }).join(' → ')); else T.hops = null; }
      }
    }
    if (!T.hops) issueMove(x, z, arrive);
  }
  function dockData(id) { const W = world(); return (W && W.dockById && W.dockById[id]) || null; }
  function issueMove(x, z, arrive) {
    if (!hasFn(G.Player, 'autoMove')) return false;
    const d = pdist(x, z);
    try { return !!G.Player.autoMove({ x: x, z: z }, { arrive: arrive, mount: d > 40 }); } catch (e) { report(e, 'AutoQuest.autoMove'); return false; }
  }
  /** One boat itinerary step: reach the departure dock, then sail (instantly at speed ≥ 3). Returns a goTo result, or
   *  null when the sea legs are finished and the land leg should take over. */
  function seaLeg(x, z, arrive, sp) {
    const B = G.Boats; if (!B) { T.hops = null; return null; }
    if (B.travelling || B.sailing) { T.sailing = true; T.lastProg = now(); return 'sailing'; }
    if (T.sailing) { T.sailing = false; T.hopI++; T.lastProg = now(); T.start = now(); }
    if (!T.hops || T.hopI >= T.hops.length - 1) { T.hops = null; issueMove(x, z, arrive); return null; }
    const dock = T.hops[T.hopI], next = T.hops[T.hopI + 1];
    if (!dock || !dock.pos || !next || !next.id) { T.hops = null; return null; }
    const dd = pdist(dock.pos.x, dock.pos.z);
    if (dd > 6) {
      const far = sp >= 10 || (sp >= 3 && dd > 200) || dd > 1200 || now() - T.lastProg > 8 / sp || now() - T.start > 90 / sp;
      if (far) { teleportNear(dock.pos.x, dock.pos.z, 'to dock', 4, true); T.start = now(); T.lastProg = now(); }
      else if (!G.Player.autoMoving) issueMove(dock.pos.x, dock.pos.z, 4);
      if (pdist(dock.pos.x, dock.pos.z) > 6) return 'moving';
    }
    autoStop();
    let ok = false;
    try {
      if (sp >= 3 && hasFn(B, 'instantTravel')) ok = B.instantTravel(next.id, { free: true, silent: true, from: dock.id }) !== false;
      else if (hasFn(B, 'sailTo')) ok = B.sailTo(next.id, dock.id, { free: true }) !== false;
      else if (hasFn(B, 'instantTravel')) ok = B.instantTravel(next.id, { free: true }) !== false;
    } catch (e) { report(e, 'AutoQuest.sail'); ok = false; }
    AQ.stats.boats++;
    T.sailLabel = 'Sailing to ' + (next.name || (next.town ? titleCase(next.town) : next.id));
    logLine((sp >= 3 ? 'boat → ' : 'sailing → ') + (next.name || next.id) + (ok ? '' : ' (unavailable — teleporting across)'));
    if (!ok) teleportNear(next.pos ? next.pos.x : x, next.pos ? next.pos.z : z, 'boat unavailable', 4, true);
    if (B.travelling || B.sailing) { T.sailing = true; return 'sailing'; }
    T.hopI++; T.start = now(); T.lastProg = now();
    if (T.hopI >= T.hops.length - 1) T.hops = null;
    chain();
    return 'moving';
  }
  /** goTo(x, z, arrive, opts) → 'arrived' | 'moving' | 'sailing'.
   *  opts: {key, noBoat, noTeleport, moving (target moves), tpRadius (how close a teleport should land)} */
  function goTo(x, z, arrive, opts) {
    const p = player(); if (!p) return 'moving';
    arrive = Math.max(0.6, num(arrive, 1.5));
    const sp = speed();
    let d = pdist(x, z);
    if (d <= arrive) { if (G.Player.autoMoving && T.x === T.x) autoStop(); T.x = T.z = NaN; T.hops = null; T.tpFail = 0; return 'arrived'; }
    const key = opts && opts.key ? opts.key : '';
    const newTarget = !(T.x === T.x) || Math.abs(T.x - x) > 1.5 || Math.abs(T.z - z) > 1.5 || T.key !== key;
    if (newTarget) {
      if (T.x === T.x && T.key === key && opts && opts.moving) { T.x = x; T.z = z; if (!T.hops) issueMove(x, z, arrive); }   // chasing something that moved: keep the timers
      else beginTravel(x, z, arrive, opts);
    }
    // ---- sea legs
    if (T.hops && T.hops.length) { const r = seaLeg(x, z, arrive, sp); if (r) return r; }
    // ---- land leg
    // A teleport is one frame and lands inside the arrive radius, so blazing speed uses it for every leg (walking a
    // single metre costs a whole frame, and a loaded machine renders very few of them). `tpFail` gives up on a target
    // no teleport can reach (inside a rock, over water) after three tries and walks the rest instead.
    const noTp = !!(opts && opts.noTeleport);
    if (!noTp && T.tpFail < 3 && !(T.tpT === now() && T.tpKey === key)) {       // at most one teleport per frame per leg
      const far = sp >= 10 ? d > arrive + 1.5 : sp >= 3 ? d > 200 : d > 1200;
      if (far) {
        const rad = (opts && opts.tpRadius > 0) ? opts.tpRadius : Math.max(0.8, arrive - 0.4);
        const d0 = d;
        if (teleportNear(x, z, sp >= 10 ? 'blazing' : 'far', rad)) {
          T.tpKey = key;
          d = pdist(x, z);
          if (d <= arrive) { T.tpFail = 0; T.x = T.z = NaN; return 'arrived'; }
          if (d > d0 - 1) { T.tpFail++; if (T.tpFail >= 3) logLine('teleport cannot reach (' + Math.round(x) + ', ' + Math.round(z) + ') — walking in'); }
          else T.tpFail = 0;
          beginTravel(x, z, arrive, opts); return 'moving';
        }
      }
    }
    if (p.casting && p.casting.kind !== 'channel' && G.Player.autoMoving) { autoStop(); return 'moving'; }   // never interrupt our own casts
    if (now() < T.nudgeUntil) { if (!G.Player.autoMoving) issueMove(T.nudgeX, T.nudgeZ, 0.8); return 'moving'; }
    if (!G.Player.autoMoving) issueMove(x, z, arrive);
    if (d < T.bestDist - 0.3) { T.bestDist = d; T.lastProg = now(); }
    const stuckFor = now() - T.lastProg;
    const stuck = (G.Player.autoStuck && stuckFor > 2 / sp) || stuckFor > 4 / sp;
    if (!noTp && (stuckFor > 8 / sp || now() - T.start > 90 / sp)) { teleportNear(x, z, stuckFor > 8 / sp ? 'stuck' : 'too long', (opts && opts.tpRadius > 0) ? opts.tpRadius : Math.max(0.8, arrive - 0.4)); T.tpKey = key; return 'moving'; }
    if (stuck && now() - T.nudgeT > 1.5 / sp) {
      T.nudgeT = now(); AQ.stats.nudges++;
      const dx = x - p.pos.x, dz = z - p.pos.z, l = Math.max(1e-3, Math.sqrt(dx * dx + dz * dz));
      const side = (AQ.stats.nudges & 1) ? 1 : -1;
      T.nudgeX = p.pos.x + (-dz / l) * 3.5 * side + dx / l * 1.5; T.nudgeZ = p.pos.z + (dx / l) * 3.5 * side + dz / l * 1.5;
      T.nudgeUntil = now() + 0.9;
      if (hasFn(G.Player, 'jump')) { try { G.Player.jump(); } catch (e) { /* ignore */ } }
      autoStop(); issueMove(T.nudgeX, T.nudgeZ, 0.8);
      logLine('nudge (stuck ' + stuckFor.toFixed(1) + ' s) toward (' + Math.round(x) + ', ' + Math.round(z) + ')');
    }
    return 'moving';
  }

  // ------------------------------------------------------------------------------------------------ housekeeping
  function protectedTids() {
    const set = Object.create(null);
    for (let i = 0; i < list.length; i++) {
      const q = list[i], st = state[q.id]; if (!st || (st.status !== 'active' && st.status !== 'complete')) continue;
      for (let k = 0; k < q.objectives.length; k++) { const o = q.objectives[k]; if ((o.type === 'collect' || o.type === 'deliver') && o.item) set[o.item] = true; }
    }
    return set;
  }
  function _sellJunkProtected(prot) {
    const p = player(); if (!p || !Array.isArray(p.inventory) || !hasFn(G.Items, 'isJunk')) return 0;
    let anyProtectedJunk = false;
    for (let i = 0; i < p.inventory.length; i++) { const it = p.inventory[i]; if (it && prot[it.tid]) { let j = false; try { j = G.Items.isJunk(it, p); } catch (e) { j = false; } if (j) { anyProtectedJunk = true; break; } } }
    if (!anyProtectedJunk && hasFn(G.NPCs, 'remoteSellJunk')) { try { const r = G.NPCs.remoteSellJunk(); return r ? num(r.count, 0) : 0; } catch (e) { report(e, 'AutoQuest.remoteSellJunk'); return 0; } }
    let n = 0, gold = 0;
    for (let i = 0; i < p.inventory.length; i++) {
      const it = p.inventory[i]; if (!it || prot[it.tid]) continue;
      let junk = false; try { junk = G.Items.isJunk(it, p); } catch (e) { junk = false; }
      if (!junk) continue;
      const v = hasFn(G.Items, 'sellValue') ? Math.floor(num(G.Items.sellValue(it), 0) * 0.5) : 0;
      p.inventory[i] = null; n++; gold += v;
    }
    if (n) { if (gold > 0 && hasFn(G.Progress, 'addGold')) G.Progress.addGold(gold, { silent: true }); emit('inventoryChanged', p); notify('Sold ' + n + ' ' + plural(n, 'item') + ' for ' + fmtMoney(gold) + ' (remote, half value)', 'gold'); }
    return n;
  }
  function makeRoom(prot, want) {
    const p = player(); if (!p || !Array.isArray(p.inventory)) return 0;
    const cands = [];
    for (let i = 0; i < p.inventory.length; i++) {
      const it = p.inventory[i]; if (!it || prot[it.tid]) continue;
      const v = hasFn(G.Items, 'get') ? G.Items.get(it) : itemTemplate(it.tid); if (!v) continue;
      if (v.type === 'quest' || v.type === 'mount' || v.type === 'bait' || v.type === 'consumable') continue;
      if (/^lk_/.test(it.tid)) continue;                                       // never discard the Lost Kingdom set
      if (v.slot && hasFn(G.Items, 'score') && hasFn(G.Items, 'canEquip')) {
        let ce = null; try { ce = G.Items.canEquip(p, it); } catch (e) { ce = null; }
        if (ce && ce.ok) { const cur = p.equipment && p.equipment[v.slot]; if (!cur || G.Items.score(it, p.cls) > G.Items.score(cur, p.cls)) continue; }   // keep upgrades (auto-equip will take them)
      }
      cands.push({ i: i, v: hasFn(G.Items, 'sellValue') ? num(G.Items.sellValue(it), 0) : num(v.value, 0) });
    }
    cands.sort(function (a, b) { return a.v - b.v; });
    let n = 0;
    for (let k = 0; k < cands.length && n < want; k++) { p.inventory[cands[k].i] = null; n++; }
    if (n) { emit('inventoryChanged', p); notify('Auto-quest discarded ' + n + ' low-value ' + plural(n, 'item') + ' to make room', 'warning'); }
    return n;
  }
  function usePotion(kind) {
    const p = player(); if (!p || !Array.isArray(p.inventory) || !hasFn(G.Items, 'use')) return false;
    let best = -1, ba = -1;
    for (let i = 0; i < p.inventory.length; i++) {
      const it = p.inventory[i]; if (!it) continue;
      const v = hasFn(G.Items, 'get') ? G.Items.get(it) : itemTemplate(it.tid);
      if (!v || !v.use || v.use.kind !== kind || num(v.level, 1) > num(p.level, 1)) continue;
      const key = 'item_' + (v.use.group || v.tid); if (p.cooldowns && num(p.cooldowns[key], 0) > now()) continue;
      const a = num(v.use.amount, 0); if (a > ba) { ba = a; best = i; }
    }
    if (best < 0) return false;
    let ok = false; try { ok = !!G.Items.use(p, best); } catch (e) { ok = false; }
    if (ok) logLine('used ' + (kind === 'heal' ? 'a healing draught' : kind === 'buff' ? 'food' : 'a potion'));
    return ok;
  }
  function housekeeping() {
    const p = player(); if (!p) return;
    if (hasFn(G.Items, 'autoEquipBetter')) { try { const n = G.Items.autoEquipBetter(p); if (n) logLine('equipped ' + n + ' better ' + plural(n, 'item')); } catch (e) { report(e, 'AutoQuest.autoEquip'); } }
    if (hasFn(G.Progress, 'untrainedAvailable') && hasFn(G.Progress, 'trainAbility')) {
      try {
        const av = G.Progress.untrainedAvailable();
        for (let i = 0; i < av.length; i++) { const a = av[i]; const c = hasFn(G.Progress, 'canTrain') ? G.Progress.canTrain(a.id) : { ok: true }; if (!c.ok) continue; const r = G.Progress.trainAbility(a.id); if (r && r.ok) logLine('trained ' + a.name); }
      } catch (e) { report(e, 'AutoQuest.train'); }
    }
    if (hasFn(G.Items, 'freeSlots')) {
      let free = G.Items.freeSlots(p);
      if (free < 15) { const prot = protectedTids(); _sellJunkProtected(prot); free = G.Items.freeSlots(p); if (free < 15) makeRoom(prot, 30 - free); }
    }
    if (!inCombat(p) && morale01(p) < 0.5) { if (now() - S.potionT > 10) { S.potionT = now(); if (!usePotion('heal') && now() - S.foodT > 120) { S.foodT = now(); usePotion('buff'); } } }
  }

  // ------------------------------------------------------------------------------------------------ combat
  function classIsRanged(p) {
    if (S.rangedFor === p.cls && S.rangedCls !== null) return S.rangedCls;
    let ranged = 0, melee = 0;
    const D = G.Data;
    const abil = (hasFn(D, 'abilitiesFor') && p.cls) ? D.abilitiesFor(p.cls) : [];
    for (let i = 0; i < abil.length; i++) { const a = abil[i]; if (!a || !Array.isArray(a.effects) || a.target !== 'enemy') continue; let dmg = false; for (let k = 0; k < a.effects.length; k++) if (a.effects[k].type === 'damage') dmg = true; if (!dmg) continue; if (num(a.range, 3.2) >= 20) ranged++; else melee++; }
    S.rangedCls = ranged > melee; S.rangedFor = p.cls;
    return S.rangedCls;
  }
  function abilityOf(id) { const D = G.Data; if (hasFn(D, 'abilityById')) return D.abilityById(id); return (D.abilities && D.abilities[id]) || null; }
  function hasEffectOf(p, a) { if (!Array.isArray(p.effects)) return false; for (let i = 0; i < p.effects.length; i++) { const e = p.effects[i]; if (e && (e.ability === a.id || e.id === a.id || (typeof e.id === 'string' && e.id.indexOf(a.id + '#') === 0))) return true; } return false; }
  function pickAbility(p, t, d) {
    if (!p.abilities || !hasFn(G.Combat, 'canUse')) return null;
    if (num(p.gcdReady, 0) > now()) return null;
    const m = morale01(p);
    let best = null, bs = -Infinity;
    const iter = p.abilities instanceof Set ? Array.from(p.abilities) : (Array.isArray(p.abilities) ? p.abilities : Object.keys(p.abilities || {}));
    for (let i = 0; i < iter.length; i++) {
      const a = abilityOf(iter[i]); if (!a || !Array.isArray(a.effects)) continue;
      let dmg = 0, heal = 0, isBuff = false, aoe = 0, hasCC = false;
      for (let k = 0; k < a.effects.length; k++) { const e = a.effects[k]; if (e.type === 'damage') { dmg += num(e.mult, 0); if (e.aoe) aoe = Math.max(aoe, e.aoe); } else if (e.type === 'dot') dmg += num(e.mult, 0) * 2; else if (e.type === 'heal' || e.type === 'hot') heal += num(e.mult, 0) + num(e.amount, 0) / 100; else if (e.type === 'buff') isBuff = true; else if (e.type === 'stun' || e.type === 'root' || e.type === 'debuff') hasCC = true; }
      let score = 0;
      if (heal > 0 && m < 0.45) score = 100 + heal * 10;
      else if (isBuff && (a.kind === 'stance' || a.kind === 'buff') && a.target !== 'enemy') { if (hasEffectOf(p, a) || now() - num(S.buffCast[a.id], -1e9) < 60) continue; score = 40; }
      else if (dmg > 0) { score = dmg * 10 + (hasCC ? 3 : 0) + (a.kind === 'aoe' ? 2 : 0) + num(a.cooldown, 0) * 0.15; if (heal > 0) score += 4; }
      else if (hasCC && a.target === 'enemy') score = 6;
      else continue;
      if (a.target === 'self' && dmg > 0) { if (!t || d > (aoe || num(a.range, 3.2)) + 0.5) continue; }   // self-centred AoE: foe must be in reach
      let chk = null; try { chk = G.Combat.canUse(p, a, a.target === 'enemy' ? t : undefined); } catch (e) { chk = null; }
      if (!chk || !chk.ok) continue;
      if (score > bs) { bs = score; best = a; }
    }
    return best;
  }
  function matchesHunt(m, hunt) {
    if (!m || !hunt) return false;
    if (hunt.typeId && m.typeId === hunt.typeId) return true;
    if (hunt.bossId) return (m.bossRec && m.bossRec.id === hunt.bossId) || m.bossId === hunt.bossId || (!!m.boss && m.typeId === hunt.bossId);
    return false;
  }
  /** The engine ends a fight the pacing rules say has gone on long enough (or that already cost us a death). Blazing
   *  speed also fells the rest of the pack that joined in — only foes the current objective still needs. */
  function finishFoe(t, p, hunt, why) {
    const nm = t.name || t.typeId;
    warn('[AutoQuest] fight against ' + nm + ' ' + why + ' — finishing it');
    logLine('fight → finishing ' + nm + ' (' + why + ')');
    let n = 0;
    try { if (G.Combat.kill(t, p)) n++; } catch (e) { report(e, 'AutoQuest.kill'); }
    if (hunt && speed() >= 10 && num(hunt.needed, 1) > 1 && hasFn(G.Monsters, 'hostilesNear')) {
      const l = G.Monsters.hostilesNear(p.pos, 24); const pack = [];   // (reused buffer — copy before killing)
      for (let i = 0; i < l.length; i++) { const m = l[i]; if (m === t || !alive(m) || m.leashing || m.invulnerable) continue; if (matchesHunt(m, hunt)) pack.push(m); }
      pack.sort(function (a, b) { return dist2(p.pos.x, p.pos.z, a.pos.x, a.pos.z) - dist2(p.pos.x, p.pos.z, b.pos.x, b.pos.z); });
      let k = 0;
      for (let i = 0; i < pack.length && n < hunt.needed; i++) { try { if (G.Combat.kill(pack[i], p)) { n++; k++; } } catch (e) { report(e, 'AutoQuest.kill'); } }
      if (k) { AQ.stats.packKills += k; logLine('the pack falls with it — ' + k + ' more ' + pluralName(k, monsterName(hunt.typeId))); }
    }
    S.fightKey = ''; S.target = null; S.engageT = -1e9;
    chain();
    return n;
  }
  /** Fight `t`. `hunt` = {typeId, bossId, needed} when a quest objective wants it dead. Returns 'fighting' | 'done' | 'lost'. */
  function fight(t, dt, hunt) {
    const p = player(); if (!p || !alive(t)) { if (S.target === t) S.target = null; return 'done'; }
    if (t.leashing || t.invulnerable) { if (S.target === t) S.target = null; return 'lost'; }
    const sp = speed(), blaze = sp >= 10;
    const key = t.id;
    if (S.fightKey !== key) { S.fightKey = key; S.fightStart = now(); S.fightFrame0 = frameNo(); S.engageT = -1e9; AQ.stats.fights++; logLine('fighting ' + (t.name || t.typeId) + ' (L' + num(t.level, 1) + ')'); }
    if (p.target !== t && hasFn(G.Player, 'setTarget')) { try { G.Player.setTarget(t); } catch (e) { /* ignore */ } }
    p.autoAttack = true;
    if (p.mounted) dismount();
    let d = dist2(p.pos.x, p.pos.z, t.pos.x, t.pos.z) - num(t.radius, 0.4);
    const ranged = classIsRanged(p);
    const m = morale01(p);
    const tm = t.stats && t.stats.maxMorale > 0 ? num(t.morale, 0) / t.stats.maxMorale : 1;
    // boss telegraph / cast → roll (i-frames); desperate → roll + potion
    const casting = !!((t.ai && t.ai.telegraphId) || (hasFn(G.Combat, 'isCasting') && G.Combat.isCasting(t)));
    if ((casting && (t.boss || t.elite)) || (m < 0.2 && tm > 0.4)) { if (hasFn(G.Player, 'dodgeRoll') && !p.casting) { try { if (G.Player.dodgeRoll()) logLine('dodge roll'); } catch (e) { /* ignore */ } } }
    if (m < 0.35 && now() - S.potionT > 3) { S.potionT = now(); usePotion('heal'); }
    // pacing safety: blazing speed / hopeless fights are finished by the engine (the fight clock and the per-foe defeat
    // count survive our own deaths, so a foe far above our level can never trap the bot in a die → retreat → die loop)
    // At blazing speed the budget is RENDERED FRAMES, not game seconds: a software-GL machine may draw one frame
    // per several wall seconds, so 150 quests are only reachable if each foe costs a bounded handful of frames
    // (FIGHT_FRAMES of real swinging — long enough for a couple of abilities — then the engine finishes it).
    const limit = blaze ? 1.5 : 60 / sp;
    const frames = frameNo() - S.fightFrame0;
    const deathLimit = blaze ? 1 : sp >= 3 ? 2 : 3;
    const diedTo = num(S.deathsOn[t.id], 0) >= deathLimit || (blaze && num(S.deathTypes[t.typeId], 0) >= 1);
    const spent = blaze ? (frames >= FIGHT_FRAMES || now() - S.fightStart > limit) : now() - S.fightStart > limit;
    if ((spent || diedTo) && hasFn(G.Combat, 'kill')) { finishFoe(t, p, hunt, diedTo ? 'already defeated us' : blaze ? 'ran ' + frames + ' frames' : 'exceeded ' + limit.toFixed(1) + ' s'); return 'done'; }
    if (p.casting && p.casting.kind !== 'channel') { autoStop(); facePoint(t.pos.x, t.pos.z); return 'fighting'; }
    const want = ranged ? 18 : 2.2;
    let closeEnough = ranged ? d <= 25 : d <= want + 0.4;
    if (!closeEnough && blaze && now() - S.engageT > 0.5) {          // blazing: step straight up to the foe
      S.engageT = now();
      if (teleportNear(t.pos.x, t.pos.z, 'engage', ranged ? 10 : 1.6)) { d = dist2(p.pos.x, p.pos.z, t.pos.x, t.pos.z) - num(t.radius, 0.4); closeEnough = ranged ? d <= 25 : d <= want + 0.4; }
    }
    if (!closeEnough) { goTo(t.pos.x, t.pos.z, want, { key: 'fight', moving: true, noTeleport: d < 60, tpRadius: ranged ? 10 : 1.6 }); if (!(ranged && d <= 30)) return 'fighting'; }
    else if (G.Player.autoMoving) autoStop();
    if (!G.Player.autoMoving) facePoint(t.pos.x, t.pos.z);
    if (now() >= S.nextAbilityT) {
      S.nextAbilityT = now() + 0.2;
      const a = pickAbility(p, t, d);
      if (a && hasFn(G.Combat, 'useAbility')) { try { G.Combat.useAbility(p, a.id, a.target === 'enemy' ? t : undefined, { face: true }); } catch (e) { report(e, 'AutoQuest.useAbility'); } }
    }
    if (d <= 3.4 && hasFn(G.Combat, 'basicAttack')) { try { G.Combat.basicAttack(p, t); } catch (e) { /* ignore */ } }
    else if (ranged && d <= 30 && hasFn(G.Player, 'rangedAttack') && p.equipment && p.equipment.ranged) { try { G.Player.rangedAttack(); } catch (e) { /* ignore */ } }
    return 'fighting';
  }
  /** A monster that is fighting us. Sticky: the foe we are already fighting is kept while it lives and stays near, so a
   *  pack never makes the bot flip targets every tick; a fresher attacker only takes over when ours is far away. */
  function findThreat(p) {
    const M = G.Monsters; if (!M || !hasFn(M, 'hostilesNear') || !p.pos) return null;
    const cur = S.target;
    const curD = (cur && alive(cur) && !cur.leashing && !cur.invulnerable) ? dist2(p.pos.x, p.pos.z, cur.pos.x, cur.pos.z) : Infinity;
    const curFighting = curD < 30 && (cur.target === p || inCombat(p));
    let best = null, bd = Infinity;
    let l = M.hostilesNear(p.pos, 12);
    for (let i = 0; i < l.length; i++) { const m = l[i]; if (m.target !== p || !alive(m) || m.leashing) continue; const d = dist2(p.pos.x, p.pos.z, m.pos.x, m.pos.z); if (d < bd) { bd = d; best = m; } }
    if (!best && inCombat(p) && morale01(p) < 1) {
      l = M.hostilesNear(p.pos, 30);
      for (let i = 0; i < l.length; i++) { const m = l[i]; if (m.target !== p || !alive(m) || m.leashing) continue; const d = dist2(p.pos.x, p.pos.z, m.pos.x, m.pos.z); if (d < bd) { bd = d; best = m; } }
    }
    if (curFighting && (!best || best === cur || curD <= 12 || bd > curD - 6)) return cur.target === p || best ? cur : null;
    return best;
  }
  function findTarget(p, typeId, bossId, radius) {
    const M = G.Monsters; if (!M || !hasFn(M, 'hostilesNear') || !p.pos) return null;
    const l = M.hostilesNear(p.pos, radius);
    let best = null, bd = Infinity;
    for (let i = 0; i < l.length; i++) {
      const m = l[i]; if (!alive(m) || m.leashing || m.invulnerable) continue;
      let ok = m.typeId === typeId;
      if (!ok && bossId) ok = (m.bossRec && m.bossRec.id === bossId) || m.bossId === bossId || (m.boss && m.typeId === bossId);
      if (!ok) continue;
      const d = dist2(p.pos.x, p.pos.z, m.pos.x, m.pos.z); if (d < bd) { bd = d; best = m; }
    }
    return best;
  }

  // ------------------------------------------------------------------------------------------------ objective steps
  function sub() { if (!S.sub) S.sub = { arrivedT: -1, lastSpawnT: -1e9, missSince: -1, inside: false, tries: 0, shore: null, shoreTried: null, shoreBad: 0, lastTry: -1e9, spawned: 0, castT: -1, castF: -1, hunt: null, warned: false }; return S.sub; }
  function flashDialogue(ent, text) {
    const D = G.UI && G.UI.Dialogue; if (!D || !hasFn(D, 'open') || !ent || now() - S.flashT < 0.7) return;
    S.flashT = now();
    try { D.open(ent, text || '', []); } catch (e) { return; }
    if (G.timers && hasFn(G.timers, 'after')) G.timers.after(0.6, function () { try { if (hasFn(G.UI, 'isOpen') && G.UI.isOpen('dialogue') && hasFn(G.UI, 'closePanel')) G.UI.closePanel('dialogue'); else if (hasFn(D, 'close')) D.close(); } catch (e) { /* ignore */ } });
  }
  function huntText(o, t, typeId, bossId, prog, cnt) {
    const nm = (t && t.name) || (bossId ? bossName(bossId) : monsterName(typeId));
    if (o.type === 'killboss') return 'Defeating ' + nm;
    if (o.type === 'collect') return 'Collecting ' + itemName(o.item) + ' ' + prog + '/' + cnt + ' from ' + pluralName(2, monsterName(typeId));
    return 'Slaying ' + pluralName(cnt, monsterName(typeId)) + ' ' + prog + '/' + cnt;
  }
  function huntInfoFor(o, q) {
    if (!o) return null;
    if (o.type === 'kill') return { typeId: o.target, bossId: null, needed: objCount(o) - progressOf(q.id, S.objIndex) };
    if (o.type === 'collect' && o.from) return { typeId: o.from, bossId: null, needed: objCount(o) - countItem(o.item) };
    if (o.type === 'killboss') { const b = bossData(o.boss); return { typeId: (b && b.type) || o.boss, bossId: o.boss, needed: 1 }; }
    return null;
  }
  function stepHunt(o, q, typeId, bossId, needed) {
    const p = player(); const u = sub(); const sp = speed(), blaze = sp >= 10;
    const hunt = u.hunt || (u.hunt = { typeId: typeId, bossId: bossId, needed: needed }); hunt.needed = Math.max(1, needed);
    let t = S.target;
    if (t && (!alive(t) || !matchesHunt(t, hunt) || t.leashing || t.invulnerable)) t = S.target = null;
    if (!t) t = S.target = findTarget(p, typeId, bossId, 60);
    if (t) {
      const cnt = objCount(o), prog = o.type === 'collect' ? Math.min(cnt, countItem(o.item)) : progressOf(q.id, S.objIndex);
      setText('hunt:' + q.id + ':' + o.type + ':' + prog, huntText(o, t, typeId, bossId, prog, cnt), describeObjective(q, S.objIndex));
      u.arrivedT = -1;
      fight(t, 0, hunt); return;
    }
    // nobody around: go to where they live (their nearest spawn group / the boss lair), then let the group fill — or,
    // when it stays empty (all dead, respawning, or the type has no group at all), call the foes up ourselves
    let pos = null;
    if (bossId) { const b = bossPosOf(bossId); if (b) pos = b; }
    if (!pos) pos = spawnPosOf(typeId, p.pos);
    const here = !pos;
    if (here) pos = { x: p.pos.x, z: p.pos.z };
    setText('hunt:' + q.id + ':' + typeId + ':travel:' + progressOf(q.id, S.objIndex), 'Travelling to the ' + (bossId ? bossName(bossId) : monsterName(typeId)) + ' grounds in ' + zoneName(zoneAt(pos.x, pos.z)), describeObjective(q, S.objIndex));
    const r = here ? 'arrived' : goTo(pos.x, pos.z, 8, { key: 'hunt', tpRadius: 6 });
    if (!(r === 'arrived' || pdist(pos.x, pos.z) < 30)) { u.arrivedT = -1; return; }
    if (u.arrivedT < 0) u.arrivedT = now();
    const patience = blaze ? 0 : Math.max(1.5, 6 / sp);
    const cap = hunt.needed * 2 + 2;
    if (now() - u.arrivedT >= patience && now() - u.lastSpawnT >= Math.max(0.5, patience) && u.spawned < cap && hasFn(G.Monsters, 'spawnForQuest')) {
      u.lastSpawnT = now();
      const n = Math.max(1, Math.min(6, hunt.needed));
      let sp2 = null; try { sp2 = G.Monsters.spawnForQuest(bossId ? (bossData(bossId) && bossData(bossId).type) || typeId : typeId, pos, bossId ? 1 : n); } catch (e) { report(e, 'AutoQuest.spawnForQuest'); }
      if (sp2 && sp2.length) { AQ.stats.spawns += sp2.length; u.spawned += sp2.length; logLine('no ' + monsterName(typeId) + ' about — ' + sp2.length + ' came out'); if (bossId) for (let i = 0; i < sp2.length; i++) { sp2[i].boss = true; sp2[i].bossId = bossId; } chain(); }
      else logLine('spawnForQuest returned nothing for ' + typeId);
    }
  }
  function stepGather(o, q, key, needed) {
    const p = player(); const u = sub(); const sp = speed(), blaze = sp >= 10;
    let node = null;
    if (hasFn(G.NPCs, 'nearestNode')) { try { node = G.NPCs.nearestNode(key, p.pos); } catch (e) { node = null; } }
    const what = o.type === 'collect' ? itemName(o.item) : nodeName(o.node || key);
    if (!node) {
      const pos = nodePosOf(key, p.pos);
      setText('gather:' + q.id + ':none:' + (u.missSince >= 0 ? Math.floor(now() - u.missSince) : 0), 'Searching for ' + what, describeObjective(q, S.objIndex));
      if (pos) { const r = goTo(pos.x, pos.z, 6, { key: 'gather' }); if (r === 'arrived' || pdist(pos.x, pos.z) < 80) { if (u.missSince < 0) u.missSince = now(); } else u.missSince = -1; }
      else if (u.missSince < 0) u.missSince = now() - 4;                       // nowhere to even look
      const missed = u.missSince >= 0 ? now() - u.missSince : 0;
      if (missed > Math.max(2, 6 / sp) && !u.warned) { u.warned = true; notify('Auto-quest: nothing to gather here yet — waiting for it to grow back', 'warning'); }
      if (missed > (blaze ? 3 : Math.max(6, 30 / sp))) { u.missSince = -1; forceObjective(q.id, S.objIndex, 'no ' + what + ' node could be found', 1); }
      return;
    }
    u.missSince = -1;
    const ch = G.NPCs && G.NPCs.channel;
    const have = o.type === 'collect' ? Math.min(objCount(o), countItem(o.item)) : progressOf(q.id, S.objIndex);
    if (ch && ch.node === node) {
      setText('gather:' + q.id + ':chan:' + have, 'Gathering ' + what + ' ' + have + '/' + objCount(o), describeObjective(q, S.objIndex));
      if (G.Player.autoMoving) autoStop();
      if (blaze && typeof ch.end === 'number' && ch.end > now() + 0.05) ch.end = now() + 0.05;   // blazing: the channel completes next frame
      if (now() - num(ch.start, now()) > 6 && hasFn(G.NPCs, 'cancelChannel')) { try { G.NPCs.cancelChannel(false); } catch (e) { /* ignore */ } }   // a channel that never ends
      return;
    }
    setText('gather:' + q.id + ':go:' + have, 'Travelling to ' + what + ' (' + have + '/' + objCount(o) + ')', describeObjective(q, S.objIndex));
    const r = goTo(node.pos.x, node.pos.z, 2.4, { key: 'node:' + node.id, tpRadius: 1.8 });
    if (r !== 'arrived') return;
    if (p.mounted) { dismount(); chain(); return; }
    if (p.casting && p.casting.kind !== 'channel') return;
    if (now() - u.lastTry < (blaze ? 0.3 : 1.0)) return;
    u.lastTry = now(); u.tries++;
    facePoint(node.pos.x, node.pos.z);
    let ok = false;
    try { ok = hasFn(G.NPCs, 'gather') ? !!G.NPCs.gather(node) : (node.interact && typeof node.interact.fn === 'function' ? node.interact.fn(node, p) !== false : false); } catch (e) { report(e, 'AutoQuest.gather'); ok = false; }
    if (!(G.NPCs && G.NPCs.channel)) ok = false;
    if (ok) { u.tries = 0; if (blaze) { const c2 = G.NPCs.channel; if (c2 && typeof c2.end === 'number') c2.end = now() + 0.05; } }
    else if (u.tries >= 4) { u.tries = 0; teleportNear(node.pos.x, node.pos.z, 'gather retry', 1.6); }
  }
  /** Stand at an NPC (blazing: teleport straight to it; otherwise walk, opening its building's door first). */
  function reachNpc(n, key) {
    const p = player(); const u = sub(); const sp = speed();
    const tx = n.inner ? n.inner.x : n.x, tz = n.inner ? n.inner.z : n.z;
    if (sp < 10 && n.interior && n.door && n.door.pos && !u.inside) {
      const r = goTo(n.door.pos.x, n.door.pos.z, 2.2, { key: 'door:' + key });
      if (r !== 'arrived') return false;
      if (!n.door.open && n.door.interact && typeof n.door.interact.fn === 'function') { try { n.door.interact.fn(n.door, p); } catch (e) { /* ignore */ } logLine('opened ' + (n.door.name || 'a door')); }
      u.inside = true; chain(); return false;
    }
    const r = goTo(tx, tz, 3.6, { key: 'npc:' + key, tpRadius: 2.2 });
    if (r !== 'arrived' && pdist(tx, tz) > 5) return false;
    if (G.Player.autoMoving) autoStop();
    if (p.mounted) dismount();
    facePoint(tx, tz);
    return true;
  }
  function stepTalk(o, q, npcId, verb) {
    const n = posOfNpc(npcId);
    if (!n) { forceObjective(q.id, S.objIndex, 'NPC ' + npcId + ' does not exist', 1); return; }
    setText('talk:' + q.id + ':' + npcId + ':' + (sub().inside ? 'in' : 'out'), 'Travelling to ' + n.name + (n.town ? ' in ' + n.town : ''), describeObjective(q, S.objIndex));
    if (!reachNpc(n, npcId)) return;
    logLine(verb + ' ' + n.name);
    flashDialogue(n.ent, q.text && q.text.progress ? q.text.progress : '');
    onTalk(npcId, n.ent);
    if (!objDone(q, state[q.id], S.objIndex)) forceObjective(q.id, S.objIndex, 'talking to ' + n.name + ' did not register', 1);
    S.planDirty = true; chain();
  }
  function stepExplore(o, q) {
    const r = num(o.radius, 12);
    setText('explore:' + q.id + ':' + S.objIndex, 'Exploring: ' + (o.label || 'the area') + ' in ' + zoneName(zoneAt(o.pos.x, o.pos.z)), describeObjective(q, S.objIndex));
    const res = goTo(o.pos.x, o.pos.z, Math.max(1.5, r * 0.6), { key: 'explore', tpRadius: Math.max(1, r * 0.4) });
    if (res === 'arrived' || pdist(o.pos.x, o.pos.z) <= r) { onExplore(player().pos); if (!objDone(q, state[q.id], S.objIndex)) forceObjective(q.id, S.objIndex, 'explore radius reached', 1); chain(); }
  }
  /** A dry, walkable point on the bank with open water 2-6 m in front of it (the probe Fishing itself uses).
   *  `avoid` lists bank points already tried and rejected, so a retry never returns the same one. */
  function _shorePoint(spot, from, avoid) {
    const cx = spot.x, cz = spot.z; const r0 = Math.max(4, num(spot.spot && spot.spot.radius, 12));
    let best = null, bd = Infinity;
    for (let rr = r0 + 1; rr <= r0 + 16; rr += 1.5) {
      for (let a = 0; a < 24; a++) {
        const ang = a * (TAU / 24) + rr * 0.1;
        const x = cx + Math.cos(ang) * rr, z = cz + Math.sin(ang) * rr;
        if (isWaterAt(x, z)) continue;
        const dx = cx - x, dz = cz - z, l = Math.max(1e-3, Math.sqrt(dx * dx + dz * dz));
        let water = false; for (let d = 2; d <= 6 && !water; d += 2) if (isWaterAt(x + dx / l * d, z + dz / l * d)) water = true;
        if (!water) continue;
        if (hasFn(G.Physics, 'isFree') && !G.Physics.isFree(x, z, 0.4)) continue;
        if (avoid && avoid.length) { let near = false; for (let i = 0; i < avoid.length && !near; i++) if (dist2(x, z, avoid[i].x, avoid[i].z) < 4) near = true; if (near) continue; }
        const d = from ? dist2(from.x, from.z, x, z) : rr;
        if (d < bd) { bd = d; best = { x: x, z: z, fx: cx, fz: cz }; }
      }
      if (best && rr > r0 + 4) break;
    }
    return best;
  }
  function stepFish(o, q) {
    const p = player(); const u = sub(); const sp = speed(), blaze = sp >= 10;
    const spot = spotPosOf(o.spot, p.pos);
    const name = spot && spot.spot ? spot.spot.name : 'the water';
    if (!spot) { forceObjective(q.id, S.objIndex, 'no fishing spot exists', 1); return; }
    if (!u.shore) { if (!u.shoreTried) u.shoreTried = []; u.shore = _shorePoint(spot, p.pos, u.shoreTried); if (!u.shore) { u.shore = { x: spot.x, z: spot.z, fx: spot.x, fz: spot.z, fallback: true }; logLine('no shore point found near ' + name + ' — using the spot itself'); } }
    setText('fish:' + q.id + ':' + progressOf(q.id, S.objIndex), 'Fishing at ' + name + ' ' + progressOf(q.id, S.objIndex) + '/' + objCount(o), describeObjective(q, S.objIndex));
    const F = G.Fishing;
    if (F && F.state && F.state !== 'idle') {
      if (G.Player.autoMoving) autoStop();
      if (u.castT < 0) { u.castT = now(); u.castF = frameNo(); }
      // A cast is ≈ 6 game-s for the auto angler; blazing speed budgets it in FRAMES so one stubborn fish cannot
      // swallow the run (the catch is then credited by the watchdog and the line recast).
      const over = blaze ? (frameNo() - u.castF > 10) : (now() - u.castT > Math.max(12, 40 / sp));
      if (over) { u.castT = -1; if (hasFn(F, 'cancel')) { try { F.cancel(false); } catch (e) { /* ignore */ } } F.autoActive = false; forceObjective(q.id, S.objIndex, 'the fish would not bite at ' + name, 1); }
      return;
    }
    u.castT = -1; u.castF = -1;
    const r = goTo(u.shore.x, u.shore.z, 1.2, { key: 'shore', tpRadius: 0.8 });
    if (r !== 'arrived') return;
    if (G.Player.autoMoving) autoStop();
    if (p.mounted) { dismount(); chain(); return; }
    facePoint(u.shore.fx, u.shore.fz);
    if (now() - u.lastTry < 0.6) return;
    u.lastTry = now();
    if (!F || !hasFn(F, 'autoFish')) { forceObjective(q.id, S.objIndex, 'fishing is not available', 1); return; }
    // Fishing decides from where we LOOK, not where the shore point said the water was: sweep the facing until it
    // agrees before blaming the spot (costs no frames — canFish is a pure query).
    if (hasFn(F, 'canFish')) {
      let c = null; try { c = F.canFish(); } catch (e) { c = null; }
      if (c && !c.ok) {
        const p0 = p.yaw; let turned = false;
        for (let i = 1; i <= 16 && !turned; i++) {
          faceYaw(p0 + i * (TAU / 16));
          try { c = F.canFish(); } catch (e) { c = null; }
          if (c && c.ok) turned = true;
        }
        if (!turned) { faceYaw(p0); u.tries = 3; u.shoreBad++; if (u.shore && !u.shore.fallback) (u.shoreTried = u.shoreTried || []).push({ x: u.shore.x, z: u.shore.z }); u.shore = null; logLine('no water in reach of ' + name + ' from here (' + ((c && c.reason) || 'unknown') + ') — trying another shore'); if (u.shoreBad >= 6) { u.shoreBad = 0; forceObjective(q.id, S.objIndex, 'no usable shore at ' + name, 1); } return; }
      }
    }
    let ok = false;
    try { ok = !!F.autoFish(); } catch (e) { report(e, 'AutoQuest.autoFish'); ok = false; }
    if (ok) { u.tries = 0; u.castT = now(); u.castF = frameNo(); return; }
    u.tries++;
    if (u.tries >= 3) { u.tries = 0; u.shoreBad++; if (u.shore && !u.shore.fallback) (u.shoreTried = u.shoreTried || []).push({ x: u.shore.x, z: u.shore.z }); u.shore = null; logLine('cannot fish from here — trying another spot on the shore'); if (u.shoreBad >= 4) { u.shoreBad = 0; forceObjective(q.id, S.objIndex, 'no usable shore at ' + name, 1); } }
  }
  function forceObjective(id, i, why, n) {
    const q = byId[id], st = state[id]; if (!q || !st || st.status !== 'active') return;
    AQ.stats.forced++;
    warn('[AutoQuest] ' + id + ' objective ' + (i + 1) + ' (' + describeObjective(q, i) + ') forced: ' + why);
    logLine('FORCED ' + id + '#' + (i + 1) + ' — ' + why);
    notify('Auto-quest: skipped an objective (' + why + ')', 'warning');
    if (n && n < objCount(q.objectives[i]) - num(st.progress[i], 0)) addProgress(id, i, n, { quiet: true }); else completeObjective(id, i);
    S.attemptStart = now(); S.lastProg = -1; S.planDirty = true;
    chain();
  }

  // ------------------------------------------------------------------------------------------------ planning
  function pickObjectiveIndex(q, st) {
    if (S.questId === q.id && S.planKind === 'objective' && S.objIndex >= 0 && !objDone(q, st, S.objIndex) && activeIndices(q, st).indexOf(S.objIndex) >= 0) return S.objIndex;
    const o = nextObjective(q.id);
    return o && o.index >= 0 ? o.index : (activeIndices(q, st)[0] | 0);
  }
  function makePlan() {
    const c = completion();
    if (c.total > 0 && c.done >= c.total) return { kind: 'finish', questId: null, objIndex: -1 };
    // 1. turn-ins (nearest turn-in NPC)
    const ready = readyIds();
    if (ready.length) {
      let best = ready[0], bd = Infinity;
      for (let i = 0; i < ready.length; i++) { const n = turninOf(ready[i]); const d = n ? pdist(n.x, n.z) : 1e9; if (ready[i] === tracked) { best = ready[i]; break; } if (d < bd) { bd = d; best = ready[i]; } }
      return { kind: 'turnin', questId: best, objIndex: -1 };
    }
    // 2. active quests: tracked first, else the nearest objective
    const act = activeIds();
    if (act.length) {
      let id = (tracked && act.indexOf(tracked) >= 0) ? tracked : null;
      if (!id) { let bd = Infinity; for (let i = 0; i < act.length; i++) { const o = nextObjective(act[i]); const d = o && o.pos ? pdist(o.pos.x, o.pos.z) : 1e8; if (d < bd) { bd = d; id = act[i]; } } if (!id) id = act[0]; }
      const q = byId[id], st = state[id];
      return { kind: 'objective', questId: id, objIndex: pickObjectiveIndex(q, st) };
    }
    // 3. acquire: story first, then side by level
    let next = nextStory() || nextSide();
    if (!next) {
      // tolerate inconsistent data: a locked quest whose prerequisites can never complete
      for (let i = 0; i < list.length && !next; i++) { const q = list[i], st = state[q.id]; if (!st || st.status !== 'locked') continue; let blockedByDone = true; for (let k = 0; k < q.prereq.length; k++) { const ps = state[q.prereq[k]]; if (ps && ps.status !== 'done') { blockedByDone = false; break; } } if (blockedByDone) { st.status = 'available'; next = q.id; warn('[AutoQuest] ' + q.id + ' unlocked despite an unmet prerequisite chain'); } }
      if (!next && c.done < c.total) { for (let i = 0; i < list.length; i++) { const st = state[list[i].id]; if (st && st.status === 'locked') { st.status = 'available'; next = list[i].id; warn('[AutoQuest] forced ' + next + ' available (prerequisite cycle)'); break; } } }
    }
    if (next) return { kind: 'acquire', questId: next, objIndex: -1 };
    return { kind: c.total ? 'stuck' : 'nodata', questId: null, objIndex: -1 };
  }
  function applyPlan(pl) {
    const key = pl.kind + ':' + (pl.questId || '') + ':' + pl.objIndex;
    if (key === S.planKey) return;
    S.planKey = key; S.planKind = pl.kind; S.questId = pl.questId; S.objIndex = pl.objIndex;
    S.sub = null; S.target = null; S.attemptStart = now(); S.lastProg = -1; S.fightKey = ''; S.engageT = -1e9;
    T.x = T.z = NaN; T.hops = null;
    if (Q.tracked !== pl.questId && pl.questId && (state[pl.questId].status === 'active' || state[pl.questId].status === 'complete')) setTracked(pl.questId);
    const q = pl.questId ? byId[pl.questId] : null;
    logLine('plan: ' + pl.kind + (q ? ' "' + q.name + '"' : '') + (pl.objIndex >= 0 && q ? ' → ' + describeObjective(q, pl.objIndex) : ''));
  }
  /** While we are standing at an NPC, do ALL of its business: hand in everything it is waiting for and take
   *  everything it is offering. Costs no extra frames and is what a player does at a quest hub — and the overlapping
   *  objectives (same foes, same zone) then progress together, because Quests credits every active quest on a kill. */
  function hubBusiness(npcId, why) {
    if (!npcId) return 0;
    let n = 0;
    const ready = turnins(npcId);
    for (let i = 0; i < ready.length; i++) { const id = ready[i]; if (turnIn(id, bestChoice(id), { auto: true })) { n++; logLine('…and turned in "' + byId[id].name + '" while here'); } }
    const offer = available(npcId);
    for (let i = 0; i < offer.length; i++) { const id = offer[i]; if (accept(id, { silent: true })) { n++; logLine('…and took "' + byId[id].name + '" while here'); } }
    if (n) { S.planDirty = true; chain(); }
    return n;
  }
  function stepTurnIn(q) {
    const npcId = q.turnin || q.giver;
    const n = posOfNpc(npcId);
    if (!n) { warn('[AutoQuest] turn-in NPC ' + npcId + ' missing — turning in remotely'); turnIn(q.id, bestChoice(q.id), { auto: true }); S.planDirty = true; chain(); return; }
    setText('turnin:' + q.id + (sub().inside ? ':in' : ''), 'Travelling to ' + n.name + (n.town ? ' in ' + n.town : ''), 'Turning in "' + q.name + '"');
    if (!reachNpc(n, npcId)) return;
    flashDialogue(n.ent, q.text && q.text.complete ? q.text.complete : '');
    const ok = turnIn(q.id, bestChoice(q.id), { auto: true });
    logLine((ok ? 'turned in "' : 'turn-in FAILED "') + q.name + '" at ' + n.name);
    if (!ok && state[q.id] && state[q.id].status === 'complete') turnIn(q.id, bestChoice(q.id), { auto: true, force: true });
    hubBusiness(npcId, 'turnin');
    S.planDirty = true; chain();
  }
  function stepAcquire(q) {
    const n = posOfNpc(q.giver);
    if (!n) { warn('[AutoQuest] quest giver ' + q.giver + ' missing — accepting remotely'); accept(q.id); S.planDirty = true; chain(); return; }
    setText('acquire:' + q.id + (sub().inside ? ':in' : ''), 'Travelling to ' + n.name + (n.town ? ' in ' + n.town : ''), 'Accepting "' + q.name + '"');
    if (!reachNpc(n, q.giver)) return;
    flashDialogue(n.ent, q.text && q.text.intro ? q.text.intro : '');
    const ok = accept(q.id);
    logLine((ok ? 'accepted "' : 'accept FAILED "') + q.name + '" from ' + n.name);
    if (!ok) accept(q.id, { force: true });
    hubBusiness(q.giver, 'acquire');
    S.planDirty = true; chain();
  }
  function finish() {
    const c = completion();
    const p = player();
    const cap = G.C.LEVEL_CAP || 80;
    if (p && num(p.level, 1) < cap && hasFn(G.Progress, 'setLevel')) {
      // the story ends at the cap by design (§4.3); if the XP budget fell short the Free Peoples make up the difference
      warn('[AutoQuest] all quests done at level ' + p.level + ' — raising to the cap so the Lost Kingdom set can be worn');
      logLine('level ' + p.level + ' at 100 % — raised to ' + cap);
      try { G.Progress.setLevel(cap); } catch (e) { report(e, 'AutoQuest.setLevel'); }
    }
    const n = grantLostKingdom(true);
    notifyBig('100% — All ' + c.total + ' quests complete!', 'Chris Jensen\'s Lord of the Rings Online');
    chat('Every quest in Middle-earth is complete — 100%. ' + (n >= 18 ? 'You wear the full Armour of the Lost Kingdom.' : 'The Armour of the Lost Kingdom is in your bags.'), 'system');
    if (hasFn(G.Audio, 'music')) { try { G.Audio.music('victory'); } catch (e) { /* ignore */ } }
    sfx('achievement');
    logLine('ALL ' + c.total + ' QUESTS COMPLETE — Lost Kingdom set equipped (' + n + ' pieces)');
    emit('autoQuestFinished', c);
    stop('complete');
  }

  // ------------------------------------------------------------------------------------------------ main tick
  function tick(dt) {
    const p = player();
    if (!p) { stop('no player'); return; }
    if (G.state && G.state.phase !== 'playing') { stop('left the world'); return; }
    if (adminOpen()) { if (!AQ.paused) { AQ.paused = true; autoStop(); logLine('paused (admin panel)'); } return; }
    if (AQ.paused) { AQ.paused = false; logLine('resumed'); }
    const sp = speed(), blaze = sp >= 10;
    // dead → wait for the retreat
    if (!alive(p)) {
      if (S.deadSince < 0) { S.deadSince = now(); logLine('defeated — waiting to retreat'); S.target = null; T.x = T.z = NaN; }
      setText('dead', 'Defeated — retreating to the rally point…', 'Defeated');
      if (now() - S.deadSince > Math.max(1.5, 8 / sp) && hasFn(G.Player, 'respawn')) { try { G.Player.respawn(); } catch (e) { report(e, 'AutoQuest.respawn'); } S.deadSince = -1; S.respawnedAt = now(); }
      return;
    }
    S.deadSince = -1;
    if (G.Boats && (G.Boats.sailing || G.Boats.travelling)) { setText('sailing:' + (T.sailLabel || ''), T.sailLabel || 'Sailing…', 'Sailing'); return; }
    if (G.Fishing && G.Fishing.state && G.Fishing.state !== 'idle' && !(S.planKind === 'objective' && S.questId && byId[S.questId] && byId[S.questId].objectives[S.objIndex] && byId[S.questId].objectives[S.objIndex].type === 'fish')) { if (hasFn(G.Fishing, 'cancel')) { try { G.Fishing.cancel(false); } catch (e) { /* ignore */ } } G.Fishing.autoActive = false; }
    // housekeeping
    S.houseT += dt;
    if (S.houseT >= 3) { S.houseT = 0; housekeeping(); }
    // combat reflex
    const threat = findThreat(p);
    if (threat) {
      S.target = threat;
      const qh = S.planKind === 'objective' && S.questId ? byId[S.questId] : null;
      const oh = qh ? qh.objectives[S.objIndex] : null;
      const hunt = oh ? huntInfoFor(oh, qh) : null;
      const huntsIt = !!(hunt && matchesHunt(threat, hunt));
      if (huntsIt) { const cnt = objCount(oh), prog = oh.type === 'collect' ? Math.min(cnt, countItem(oh.item)) : progressOf(qh.id, S.objIndex); setText('hunt:' + qh.id + ':' + oh.type + ':' + prog, huntText(oh, threat, threat.typeId, oh.boss || null, prog, cnt), describeObjective(qh, S.objIndex)); }
      else setText('threat:' + threat.id, 'Fighting ' + (threat.name || 'a foe'), qh ? describeObjective(qh, S.objIndex) : 'Fighting');
      fight(threat, dt, huntsIt ? hunt : null);
      return;
    }
    if (S.fightKey && (!S.target || !alive(S.target))) S.fightKey = '';
    // recover after a defeat before wading into the next fight (potion first, then let morale come back; nothing is
    // attacking us here or the reflex above would have fired — the stale in-combat flag must not skip this)
    if (morale01(p) < 0.6 && now() - S.respawnedAt < (blaze ? 2 : 40 / sp)) {
      autoStop(); setText('recover', 'Recovering…', 'Recovering');
      if (now() - S.potionT > 2) { S.potionT = now(); usePotion('heal'); }
      return;
    }
    // plan
    S.planT += dt;
    if (S.planDirty || S.planT > 1) { S.planT = 0; S.planDirty = false; applyPlan(makePlan()); }
    const q = S.questId ? byId[S.questId] : null; const st = q ? state[q.id] : null;
    switch (S.planKind) {
      case 'finish': finish(); return;
      case 'stuck': notify('Auto-quest: no quests available', 'warning'); logLine('no quest available and ' + completion().done + '/' + completion().total + ' done — data inconsistent'); stop('no quests available'); return;
      case 'nodata': notify('Auto-quest: no quest data loaded', 'warning'); stop('no quest data'); return;
      case 'turnin': if (!q || st.status !== 'complete') { S.planDirty = true; chain(); return; } stepTurnIn(q); break;
      case 'acquire': if (!q || st.status !== 'available') { S.planDirty = true; chain(); return; } stepAcquire(q); break;
      case 'objective': {
        if (!q || st.status !== 'active') { S.planDirty = true; chain(); return; }
        const o = q.objectives[S.objIndex];
        if (!o || objDone(q, st, S.objIndex)) { S.planDirty = true; chain(); return; }
        switch (o.type) {
          case 'kill': stepHunt(o, q, o.target, null, objCount(o) - num(st.progress[S.objIndex], 0)); break;
          case 'killboss': { const b = bossData(o.boss); stepHunt(o, q, (b && b.type) || o.boss, o.boss, 1); break; }
          case 'collect':
            if (o.from) stepHunt(o, q, o.from, null, objCount(o) - countItem(o.item));
            else if (o.node || (hasFn(G.NPCs, 'nodesFor') && G.NPCs.nodesFor(o.item).length) || nodePosOf(o.item, p.pos)) stepGather(o, q, o.node || o.item, objCount(o) - countItem(o.item));
            else { const u = sub(); if (u.missSince < 0) u.missSince = now(); setText('collect:' + q.id + ':nosrc', 'Searching for ' + itemName(o.item), describeObjective(q, S.objIndex)); if (now() - u.missSince > (blaze ? 1 : Math.max(2, 6 / sp))) forceObjective(q.id, S.objIndex, 'no source for ' + itemName(o.item)); }
            break;
          case 'use': stepGather(o, q, o.node || o.item, objCount(o) - num(st.progress[S.objIndex], 0)); break;
          case 'talk': stepTalk(o, q, o.npc, 'talking to'); break;
          case 'deliver': stepTalk(o, q, o.npc, 'delivering ' + itemName(o.item) + ' to'); break;
          case 'explore': stepExplore(o, q); break;
          case 'fish': stepFish(o, q); break;
          default: forceObjective(q.id, S.objIndex, 'unknown objective type ' + o.type); break;
        }
        break;
      }
      default: S.planDirty = true; chain(); break;
    }
    // objective / step timeout watchdog (game time, no progress at all)
    if (q && st) {
      const prog = S.objIndex >= 0 ? num(st.progress[S.objIndex], 0) : (st.status === 'done' ? 1 : 0);
      if (prog !== S.lastProg) { S.lastProg = prog; S.attemptStart = now(); }
      const limit = blaze ? 12 : Math.max(20, 120 / sp);
      if (now() - S.attemptStart > limit) {
        if (S.planKind === 'objective' && S.objIndex >= 0) forceObjective(q.id, S.objIndex, 'no progress for ' + limit.toFixed(0) + ' s');
        else if (S.planKind === 'turnin') { warn('[AutoQuest] turn-in of ' + q.id + ' timed out — completing remotely'); logLine('FORCED remote turn-in of ' + q.id); turnIn(q.id, bestChoice(q.id), { auto: true, force: true }); S.attemptStart = now(); S.planDirty = true; chain(); }
        else if (S.planKind === 'acquire') { warn('[AutoQuest] accepting ' + q.id + ' timed out — accepting remotely'); logLine('FORCED remote accept of ' + q.id); accept(q.id, { force: true }); S.attemptStart = now(); S.planDirty = true; chain(); }
        else S.attemptStart = now();
      }
    }
  }
  function update(dt) {
    if (!AQ.active) return;
    dt = num(dt, 0); if (dt < 0) dt = 0; if (dt > 0.5) dt = 0.5;      // main caps dt at 0.05 × time scale (≤ ×10)
    AQ.stats.ticks++;
    const depth = speed() >= 10 ? 6 : speed() >= 3 ? 3 : 1;
    let n = 0;
    try {
      do { S.chain = false; tick(n === 0 ? dt : 0); n++; if (n > 1) AQ.stats.chained++; }
      while (S.chain && AQ.active && n < depth);
      S.chain = false; S.errStreak = 0;
    } catch (e) {
      AQ.stats.errors++; S.errStreak++; S.chain = false;
      report(e, 'AutoQuest.update');
      if (S.errStreak === 1) logLine('error: ' + (e && e.message ? e.message : e));
      if (S.errStreak > 300) { notify('Auto-quest stopped: repeated errors (see console)', 'warning'); stop('errors'); }
      else if (S.errStreak % 60 === 0) { S.planDirty = true; S.target = null; T.x = T.z = NaN; S.sub = null; }
    }
  }
  function onQuestEvent() { S.planDirty = true; }
  if (typeof G.on === 'function') {
    G.on('questCompleted', onQuestEvent); G.on('questAccepted', onQuestEvent); G.on('questAbandoned', onQuestEvent);
    G.on('questProgress', function (id) { if (S.questId && id === S.questId) { const st = state[id]; if (st && st.status !== 'active') S.planDirty = true; } });
    G.on('playerDeath', function () {
      const t = S.target;
      if (t && t.id) { S.deathsOn[t.id] = num(S.deathsOn[t.id], 0) + 1; if (t.typeId) S.deathTypes[t.typeId] = num(S.deathTypes[t.typeId], 0) + 1; if (AQ.active) logLine('defeated by ' + (t.name || t.typeId) + ' (' + S.deathsOn[t.id] + '×)'); }
      S.lastDeathT = now();
      S.target = null; T.x = T.z = NaN;              // the fight clock (S.fightKey / fightStart) deliberately survives
      if (AQ.active) AQ.stats.deaths++;
    });
    G.on('entityKilled', function (ev) { if (!AQ.active || !ev || !ev.victim || ev.victim.kind !== 'monster') return; const k = ev.killer, p = player(); if (k && p && (k === p || k.kind === 'player')) AQ.stats.kills++; });
    G.on('gameStart', function () { if (AQ.active) stop('new game'); });
  }

  AQ.start = start; AQ.stop = stop; AQ.toggle = toggle; AQ.status = status; AQ.update = update;
  AQ.goTo = goTo; AQ.teleportNear = teleportNear;
  Object.defineProperty(AQ, 'plan', { get: function () { return { kind: S.planKind, questId: S.questId, objIndex: S.objIndex, text: S.text, step: S.step, attemptAge: now() - S.attemptStart }; }, enumerable: true });
  G.AutoQuest = AQ;
  })();

  log('[Quests] module ready');
})();
