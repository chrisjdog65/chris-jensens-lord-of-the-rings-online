/* ==== 20_player.js — G.Player: the third-person controller the player feels every second. Owns the player entity
   (creation, starter gear/abilities/mount, spawn/teleport/respawn), the chase camera (mouse-look with pointer lock or
   RMB drag, exponential wheel zoom, shoulder offset, occlusion clamp via G.Physics.cameraClamp, first-person when
   zoomed in, lag-free smooth follow), movement (camera-relative WASD with acceleration/deceleration/air control,
   backpedal, swimming, mount speed, roots/stuns/slows through stats.speed, auto-run), jump with coyote time + input
   buffer, dodge roll with i-frames and cooldown, landing/fall damage, distance-based footsteps (sfx + FX by ground
   type), mounting (cached horse rigs, rider attached to the saddle, gallop loop + dust), hotbar ability keys,
   ranged attack (R) with projectiles, interaction (E) with a 10 Hz prompt target, targeting (Tab / click raycast /
   Esc), zone-change detection and the auto-move steering used by AutoQuest and Travel (whisker obstacle avoidance,
   water avoidance, auto-jump, auto-mount, stuck reporting).
   Public API (SPEC §6.1): create(charSpec), spawnAt(x,z,yaw?), teleport(x,z,yaw?), update(dt), camera, cam
   {yaw,pitch,dist,targetDist,shoulder,height,offset}, getForward(out), getRight(out), interact(), interactTarget
   {ent,label,name}|null, interactLabel(), dodgeRoll(), jump(), toggleMount(), mount(tid?), dismount(), rangedAttack(),
   setTarget(ent), tabTarget(), clickSelect(x,y), respawn(), isBusy(), inInterior, headPos(out), handPos(out),
   rollCooldown() 0..1, autoMove(targetPos, opts), autoStop(), autoMoving, autoStuck, autoTarget.
   Mouse: LMB = select + attack (G.Combat.basicAttack on the hostile target or the enemy in front; queued when the swing
   timer is running; a visible swing with nothing in reach), RMB held = block (player.blocking → G.Combat.damage takes
   −60 % physical / −30 % tactical, half speed, guard pose, auto-attack paused) while the RMB camera drag keeps working.
   Extras: attack(picked?), setBlocking(bool), event blockingChanged(bool),
   setScene(scene), resize(w,h), snapCamera(), dispose(), player (getter), rig (getter), mountSpeed(tid),
   autoRun (bool), rolling (bool), firstPerson (bool), moveInput {x,z} (last frame's world-space input direction).
   Events emitted: targetChanged(ent|null), mounted(bool), zoneChanged(zoneId), playerRespawn, autoMoveArrived,
   autoMoveStopped, blockingChanged(bool). Private helper owned here (not in the spec): `_rmbRaw` — a document-level
   mousedown/mouseup listener that tracks the right button for the block, because `G.Input.mouse.buttons` is not
   maintained while the pointer is locked. Assumptions about other modules: see the header of each guarded call (every cross-module call
   checks for existence). No per-frame allocations: every vector/array/object used in update() is module-level. ==== */
(function () {
  'use strict';
  const G = window.G;
  const C = G.C;
  const P = {};
  G.Player = P;

  // ------------------------------------------------------------------------------------------------ helpers
  const PI = Math.PI, TAU = Math.PI * 2;
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const damp = (a, b, l, dt) => a + (b - a) * (1 - Math.exp(-l * dt));
  const wrapA = (a) => { a = a % TAU; if (a > PI) a -= TAU; else if (a < -PI) a += TAU; return a; };
  const adamp = (a, b, l, dt) => a + wrapA(b - a) * (1 - Math.exp(-l * dt));
  const yawOf = (dx, dz) => Math.atan2(-dx, -dz);                 // yaw 0 = facing -Z
  const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;
  const now = () => (G.time && typeof G.time.now === 'number') ? G.time.now : 0;
  const EMPTY = {};

  // ------------------------------------------------------------------------------------------------ tunables
  const FP_DIST = 1.8;                    // closer than this → first-person (rig hidden)
  const MIN_DIST = 1.5, MAX_DIST = 28;
  const MOUSE_SENS = 0.0022;              // radians per pixel at mouseSens 1
  const PITCH_MAX = 80 * PI / 180;
  const KEY_TURN = 2.4;                   // rad/s for ArrowLeft/Right
  const ACCEL = 40, DECEL = 50, AIR_CONTROL = 0.4, MOUNT_ACCEL = 24, MOUNT_DECEL = 34;
  const COYOTE = 0.12, JUMP_BUFFER = 0.15;
  const SUB_DT = 0.05, MAX_SUB = 10;      // movement/physics sub-step length and cap (see stepMovement)
  const MAX_DT = 0.5;                     // safety net only; main caps raw dt at 0.05 × time scale (≤ ×5)
  const FALL_DMG_SPEED = 14;
  const STRIDE_RUN = 1.6, STRIDE_WALK = 0.9, STRIDE_HORSE = 2.2;
  const RANGED_CD = 1.2, RANGED_RELEASE = 0.32;
  const INTERACT_PERIOD = 0.1, ZONE_PERIOD = 0.5;
  const TURN_MOVE = 12, TURN_IDLE = 6, TURN_TARGET = 10;
  const AUTO_PROBE = 2.6, AUTO_NEAR = 1.2, AUTO_STUCK = 4, AUTO_BLOCK_JUMP = 0.5, AUTO_MOUNT_DIST = 40, AUTO_DISMOUNT_DIST = 8;
  const AUTO_WATER_LIMIT = 6;             // seconds of being walled off by water before swimming is allowed

  // ------------------------------------------------------------------------------------------------ state
  let player = null, rig = null, scene = null;
  let hotbarCodes = [];
  const horseRigs = {};                   // mount tid → CreatureRig (cached)
  let mountRig = null;

  const cam = P.cam = {
    yaw: 0, pitch: 0.28, dist: 7, targetDist: 7, shoulder: 0.35, height: 1.55,
    offset: new THREE.Vector3(0, 0, 0),   // extra pivot offset (world units)
    minDist: MIN_DIST, maxDist: MAX_DIST,
    lookAt: new THREE.Vector3(),          // the point the camera looks at (updated every frame)
    pivot: new THREE.Vector3(),
  };
  const camera = P.camera = new THREE.PerspectiveCamera(60, (window.innerWidth || 1280) / (window.innerHeight || 720), 0.1, 2500);
  camera.name = 'playerCamera';

  // per-frame scratch (module-level → zero allocations in update)
  const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3();
  const _fwd = new THREE.Vector3(), _right = new THREE.Vector3(), _desired = new THREE.Vector3(), _pivotT = new THREE.Vector3();
  const _moveVel = new THREE.Vector3();   // accelerated xz velocity we feed to physics (y used only when flying)
  const _prevPos = new THREE.Vector3();
  const _physOpts = { fly: false, noclip: false };
  const _qbuf = [], _qbuf2 = [], _pickList = [], _tabList = [];
  const _pickMap = new Map();
  const _ndc = new THREE.Vector2();
  const _ray = new THREE.Raycaster();
  const moveInput = P.moveInput = { x: 0, z: 0 };

  // controller state
  const S = {
    camLen: 7,                 // smoothed clamped camera distance (published as cam.dist)
    zoom: 7,                   // smoothed UNclamped zoom (follows cam.targetDist)
    distOut: 7,                // the cam.dist value we last published (a different value = an external write)
    pivotInit: false,
    camSnap: true,
    fp: false,
    lastMouseT: -10,           // time of the last mouse-look input
    settingDist: -1,
    jumpBuffer: 0, coyote: 0, wasGround: true,
    rolling: false, rollT: 0, rollDirX: 0, rollDirZ: -1,
    stride: 0, footSide: 1,
    swimSfxT: 0,
    faceTargetT: 0,            // face the target while > 0 (ranged shot / ability)
    rangedReady: 0, rangedPending: 0, rangedTarget: null,
    gallopLoop: false, gallopRetry: 0, mountDustT: 0,
    interactT: 0, zoneT: 0,
    manualMoveT: 0,            // time of the last manual movement input
    blockedT: 0,
    lastInterior: null,
    turnKeys: false,
    lmbWas: false,             // left button level last frame (own press-edge detection, see update)
    rmbHeld: false,            // right button held since a press that began on the canvas → block
    blockT: 0,                 // guard-pose blend 0..1
    resumeAuto: false,         // auto-attack was on when the guard went up → restore on release
    attackQueued: false, attackQueuedT: 0,   // LMB pressed while the swing timer was running
  };
  P.autoRun = false;
  P.rolling = false;
  P.firstPerson = false;
  P.inInterior = null;
  P.interactTarget = null;
  P.autoMoving = false;
  P.autoStuck = false;
  P.autoTarget = null;

  // auto-move state
  const A = {
    active: false, tx: 0, tz: 0, arrive: 1.5, mount: true, onArrive: null, timeout: 0, elapsed: 0,
    dirX: 0, dirZ: -1, steer: 0, avoid: 0, freeT: 0, bestDist: 1e9, progressT: 0, waterBlockT: 0, swimUntil: 0,
    targetOnLand: true, flipT: 0,
  };
  const _autoTarget = new THREE.Vector3();

  // ------------------------------------------------------------------------------------------------ small accessors
  Object.defineProperty(P, 'player', { get: function () { return player; }, enumerable: true });
  Object.defineProperty(P, 'rig', { get: function () { return rig; }, enumerable: true });
  Object.defineProperty(P, 'mountRig', { get: function () { return mountRig; }, enumerable: true });

  // Private right-button tracking (`_rmb*`, owned here — see the header note). G.Input.mouse.buttons is the shared
  // source of truth for click edges, but a HELD button must survive both a slow frame and pointer lock (where the
  // browser stops maintaining the buttons bitmask on the events core listens to), so the controller reads the button
  // straight from the DOM. Cleared on mouseup, window blur and tab hide so the guard can never stick.
  let _rmbRaw = false;
  function _onRawDown(e) { if (e && e.button === 2) _rmbRaw = true; }
  function _onRawUp(e) { if (e && e.button === 2) _rmbRaw = false; }
  function _clearRaw() { _rmbRaw = false; }
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('mousedown', _onRawDown, true);
    document.addEventListener('mouseup', _onRawUp, true);
    window.addEventListener('blur', _clearRaw);
    document.addEventListener('visibilitychange', function () { if (document.hidden) _clearRaw(); });
  }

  function uiOpen() { return !!(G.UI && typeof G.UI.anyOpen === 'function' && G.UI.anyOpen()); }
  function typing() { return !!(G.Input && G.Input.typing); }
  function sfx(name, o) { if (G.Audio && typeof G.Audio.sfx === 'function') { try { G.Audio.sfx(name, o); } catch (e) { /* audio never breaks the controller */ } } }
  function fx(kind, pos, o) { if (G.FX && typeof G.FX.spawn === 'function') { try { return G.FX.spawn(kind, pos, o); } catch (e) { return null; } } return null; }
  function notify(text, kind) { if (G.UI && typeof G.UI.notify === 'function') { try { G.UI.notify(text, kind || 'warning'); } catch (e) { /* ignore */ } } }
  function emit(evt, a, b) { if (typeof G.emit === 'function') G.emit(evt, a, b); }
  function terrainH(x, z) { return (G.Terrain && G.Terrain.height) ? G.Terrain.height(x, z) : 0; }
  function groundYAt(x, z) { return (G.Physics && G.Physics.groundY) ? G.Physics.groundY(x, z) : terrainH(x, z); }
  function isHostile(e) {
    if (!e || e === player) return false;
    if (G.Combat && typeof G.Combat.isHostile === 'function') { try { return !!G.Combat.isHostile(player, e); } catch (err) { /* fall through */ } }
    return !!(e.hostile || e.faction === 'enemy');
  }
  function livingHostile(e) { return !!(e && e.alive !== false && !e.dead && isHostile(e)); }
  function rigScale() { return rig && rig.height > 0 ? rig.height / 1.8 : 1; }
  function currentScene() {
    if (scene) return scene;
    if (G.Game && G.Game.scene) return (scene = G.Game.scene);
    return null;
  }
  function classData(id) { return (G.Data && G.Data.classById && G.Data.classById[id]) || null; }
  function raceData(id) { return (G.Data && G.Data.raceById && G.Data.raceById[id]) || null; }
  function mountTemplate(tid) { return (G.Items && typeof G.Items.template === 'function') ? G.Items.template(tid) : ((G.Data && G.Data.items) ? G.Data.items[tid] : null); }
  function mountSpeed(tid) {
    const t = mountTemplate(tid || (player && (player.activeMount || (player.mounts && player.mounts[0]))));
    const s = t && t.mount && t.mount.speed;
    return (typeof s === 'number' && s > 0) ? s : C.MOUNT_SPEED;
  }
  P.mountSpeed = mountSpeed;
  function activeMountId() {
    if (!player) return null;
    const list = Array.isArray(player.mounts) ? player.mounts : [];
    if (player.activeMount && list.indexOf(player.activeMount) >= 0) return player.activeMount;
    return list.length ? list[list.length - 1] : null;
  }

  // ------------------------------------------------------------------------------------------------ key codes
  function buildHotbarCodes() {
    const keys = C.HOTBAR_KEYS || [];
    hotbarCodes = new Array(keys.length);
    for (let i = 0; i < keys.length; i++) hotbarCodes[i] = (G.Input && typeof G.Input.codeOf === 'function') ? G.Input.codeOf(keys[i]) : String(keys[i]);
  }
  buildHotbarCodes();
  if (G.Input && typeof G.Input.bind === 'function') { G.Input.bind('ShiftLeft'); G.Input.bind('ControlLeft'); }

  // ================================================================================================ CREATE
  function create(spec) {
    spec = spec || {};
    if (player) dispose();
    const race = raceData(spec.race) ? spec.race : ((G.Data && G.Data.races && G.Data.races[0]) ? G.Data.races[0].id : 'man');
    const cls = classData(spec.cls) ? spec.cls : ((G.Data && G.Data.classes && G.Data.classes[0]) ? G.Data.classes[0].id : 'guardian');
    const cd = classData(cls), rd = raceData(race);
    const gender = spec.gender === 'female' ? 'female' : 'male';
    let name = String(spec.name || '').trim();
    if (!name) name = (G.Data && typeof G.Data.randomName === 'function') ? G.Data.randomName(race, gender) : 'Wanderer';
    const nSlots = C.INVENTORY_SLOTS || 200;
    const equipment = {};
    for (let i = 0; i < C.EQUIP_SLOTS.length; i++) equipment[C.EQUIP_SLOTS[i]] = null;
    const ent = {
      id: (typeof G.uid === 'function') ? G.uid() : 'player',
      kind: 'player', name: name, title: '', level: Math.max(1, num(spec.level, 1) | 0),
      race: race, cls: cls, gender: gender, typeId: null,
      skin: spec.skin, hair: spec.hair, hairColor: spec.hairColor, hairStyle: spec.hairStyle, eyes: spec.eyes != null ? spec.eyes : spec.eyeColor,
      heightScale: num(spec.height, 1), build: spec.build || (rd && rd.build) || 'normal',
      pos: new THREE.Vector3(0, 0, 0), yaw: 0, vel: new THREE.Vector3(0, 0, 0), radius: C.PLAYER_RADIUS || 0.4, height: 1.8,
      onGround: true, inWater: false, swimming: false, sliding: false, justLanded: 0, justSplashed: 0, waterDepth: 0, groundCollider: null,
      knockback: new THREE.Vector3(0, 0, 0),
      stats: {}, morale: 1, power: 1, alive: true, dead: false, deathTime: 0,
      effects: [], cooldowns: {},
      target: null, threat: {}, hostile: false, faction: 'free', autoAttack: false, invulnerable: false, casting: null, blocking: false,
      mesh: null, rig: null, anim: 'idle', animTime: 0, ai: null,
      xp: Math.max(0, num(spec.xp, 0)), gold: Math.max(0, num(spec.gold, 5 * ((C.MONEY && C.MONEY.SILVER) || 100)) | 0),
      inventory: new Array(nSlots).fill(null), equipment: equipment,
      abilities: new Set(), hotbar: new Array(20).fill(null),
      mounted: false, mountId: null, mounts: ['mount_starter'], activeMount: 'mount_starter', mountRig: null,
      titles: [], activeTitle: null, rollReady: 0, statBonus: null, statOverride: null,
    };
    if (!mountTemplate('mount_starter')) { ent.mounts = []; ent.activeMount = null; }
    player = ent;
    G.state.player = ent;

    // starter gear → equipped straight away (before the rig exists, so the rig is built with the final look)
    if (G.Items && typeof G.Items.starterGear === 'function' && typeof G.Items.equipDirect === 'function') {
      let gear = [];
      try { gear = G.Items.starterGear(cls) || []; } catch (e) { if (G.reportError) G.reportError(e, 'Player.create:starterGear'); }
      for (let i = 0; i < gear.length; i++) { try { G.Items.equipDirect(ent, gear[i]); } catch (e) { if (G.reportError) G.reportError(e, 'Player.create:equipDirect'); } }
    }
    // stats, pools
    computeStats(ent);
    ent.morale = ent.stats.maxMorale || 100;
    ent.power = ent.stats.maxPower || 100;

    // rig
    let r = null;
    if (G.Chars && typeof G.Chars.buildHumanoid === 'function') {
      try {
        r = G.Chars.buildHumanoid({
          race: race, gender: gender, cls: cls, name: name, level: ent.level,
          skin: spec.skin, hair: spec.hair, hairColor: spec.hairColor, hairStyle: spec.hairStyle, eyes: ent.eyes,
          height: ent.heightScale, build: ent.build, equipment: ent.equipment, armourType: cd ? cd.armourType : undefined,
          nameplate: false, player: true,
        });
      } catch (e) { if (G.reportError) G.reportError(e, 'Player.create:buildHumanoid'); r = null; }
    }
    rig = r;
    ent.rig = r;
    ent.mesh = r ? r.group : new THREE.Group();
    ent.mesh.name = 'player';
    ent.height = r && r.height > 0 ? Math.max(1.1, r.height) : 1.8;
    if (r && typeof r.setAnim === 'function') r.setAnim('idle', true);
    // nameplate (kept for the character panel / spectators; the player never sees their own plate)
    if (G.Chars && typeof G.Chars.nameplate === 'function') {
      try {
        const col = cd && cd.color != null ? cd.color : '#ffffff';
        const np = G.Chars.nameplate(name, col, { sub: 'Level ' + ent.level + (cd ? ' ' + cd.name : '') });
        if (np) { np.position.y = ent.height + 0.35; np.visible = false; ent.mesh.add(np); ent.nameplate = np; }
      } catch (e) { ent.nameplate = null; }
    }
    const sc = currentScene();
    if (sc) sc.add(ent.mesh);

    // abilities & hotbar
    grantStarterAbilities(ent);
    // warm the horse rig cache now (loading time) so the first H press never hitches
    ensureHorse(activeMountId());

    // world position
    if (typeof G.addEntity === 'function') G.addEntity(ent);
    else { G.state.entities.push(ent); G.state.byId[ent.id] = ent; if (G.Spatial && G.Spatial.insert) G.Spatial.insert(ent); }
    let sx = num(spec.x, NaN), sz = num(spec.z, NaN);
    if (sx !== sx || sz !== sz) {
      const sp = (G.Data && typeof G.Data.startPosFor === 'function') ? G.Data.startPosFor(race) : null;
      sx = sp ? sp.x : -60; sz = sp ? sp.z : -250;
    }
    spawnAt(sx, sz, num(spec.yaw, 0));
    resetController();
    if (G.log) G.log('Player created', name, race, cls);
    return ent;
  }

  function computeStats(ent) {
    if (G.Data && G.Data.stats && typeof G.Data.stats.compute === 'function') { try { G.Data.stats.compute(ent); } catch (e) { if (G.reportError) G.reportError(e, 'Player:stats.compute'); } }
    const st = ent.stats || (ent.stats = {});
    if (typeof st.speed !== 'number') st.speed = 1;
    if (typeof st.maxMorale !== 'number') st.maxMorale = 100;
    if (typeof st.maxPower !== 'number') st.maxPower = 100;
    return st;
  }

  function grantStarterAbilities(ent) {
    if (G.Progress && typeof G.Progress.grantStarterAbilities === 'function') { try { G.Progress.grantStarterAbilities(ent); return; } catch (e) { if (G.reportError) G.reportError(e, 'Player:grantStarterAbilities'); } }
    // fallback: every ability unlocked at the current level goes into the ability set and the first free hotbar slots
    if (!G.Data || typeof G.Data.abilitiesFor !== 'function') return;
    let list = [];
    try { list = G.Data.abilitiesFor(ent.cls) || []; } catch (e) { list = []; }
    for (let i = 0; i < list.length; i++) {
      const a = list[i]; if (!a || !a.id) continue;
      if ((a.level || 1) > ent.level) continue;
      ent.abilities.add(a.id);
      if (ent.hotbar.indexOf(a.id) < 0) { const free = ent.hotbar.indexOf(null); if (free >= 0) ent.hotbar[free] = a.id; }
    }
  }

  function dispose() {
    if (!player) return;
    autoStop(true);
    if (player.mounted) dismount(true);
    const sc = currentScene();
    if (player.mesh && player.mesh.parent) player.mesh.parent.remove(player.mesh);
    if (player.nameplate && G.Chars && typeof G.Chars.releaseNameplate === 'function') { try { G.Chars.releaseNameplate(player.nameplate); } catch (e) { /* ignore */ } }
    if (rig && typeof rig.dispose === 'function') { try { rig.dispose(); } catch (e) { /* ignore */ } }
    for (const k in horseRigs) { const h = horseRigs[k]; if (h && h.group && h.group.parent) h.group.parent.remove(h.group); if (h && typeof h.dispose === 'function') { try { h.dispose(); } catch (e) { /* ignore */ } } delete horseRigs[k]; }
    mountRig = null;
    if (typeof G.removeEntity === 'function') G.removeEntity(player);
    if (G.state.player === player) G.state.player = null;
    player = null; rig = null;
    P.interactTarget = null; P.inInterior = null;
    void sc;
  }

  function resetController() {
    S.jumpBuffer = 0; S.coyote = 0; S.wasGround = true; S.rolling = false; S.rollT = 0; P.rolling = false;
    S.stride = 0; S.swimSfxT = 0; S.faceTargetT = 0; S.rangedPending = 0; S.rangedTarget = null;
    S.blockedT = 0; S.interactT = 0; S.zoneT = 0; S.pivotInit = false; S.camSnap = true;
    S.zoom = cam.targetDist; S.camLen = cam.targetDist; cam.dist = cam.targetDist; S.distOut = cam.dist;
    _moveVel.set(0, 0, 0);
    if (player) { player.invulnerable = false; player.blocking = false; _prevPos.copy(player.pos); }
    S.rmbHeld = false; S.blockT = 0; S.resumeAuto = false; S.attackQueued = false; S.attackQueuedT = 0;
    P.autoRun = false;
  }

  // ================================================================================================ SPAWN / TELEPORT
  /** Enterable building whose footprint contains (x,z) — Physics.groundY without a feet height picks the HIGHEST
   *  floor collider (an upper storey / roof slab), so a teleport into a building must resolve the floor itself. */
  function buildingFootprintAt(x, z) {
    const B = G.Buildings; if (!B || typeof B.footprintAt !== 'function') return null;
    try { return B.footprintAt(x, z) || null; } catch (e) { return null; }
  }
  /** Ground-floor height inside `bld` at (x,z): the walkable top within a step of the building's floor level
   *  (its floor collider, or the terrain), never more than 2 m away from `bld.y`. */
  function interiorFloorY(bld, x, z) {
    const base = num(bld.y, terrainH(x, z));
    if (G.Physics && typeof G.Physics.groundY === 'function') {
      const g = G.Physics.groundY(x, z, base + 0.05);
      if (typeof g === 'number' && isFinite(g) && Math.abs(g - base) <= 2) return g;
    }
    return base;
  }
  function spawnAt(x, z, yaw) {
    if (!player) return false;
    x = num(x, 0); z = num(z, 0);
    let fx_ = x, fz = z, fy;
    const bld = buildingFootprintAt(x, z);
    if (bld) {
      fy = interiorFloorY(bld, x, z);                          // inside a building: land on ITS floor, not the roof
    } else {
      if (G.Physics && typeof G.Physics.nearestFree === 'function') {
        const f = G.Physics.nearestFree(x, z, player.radius || 0.4);
        if (f) { fx_ = num(f.x, x); fz = num(f.z, z); }
      }
      fy = groundYAt(fx_, fz);
    }
    player.pos.set(fx_, fy, fz);
    player.vel.set(0, 0, 0);
    if (player.knockback) player.knockback.set(0, 0, 0);
    player.onGround = true; player.swimming = false; player.inWater = false; player.sliding = false;
    if (typeof yaw === 'number' && isFinite(yaw)) player.yaw = wrapA(yaw);
    cam.yaw = player.yaw;
    _moveVel.set(0, 0, 0);
    _prevPos.copy(player.pos);
    S.camSnap = true; S.pivotInit = false;
    S.interactT = 0; S.stride = 0; S.blockedT = 0;              // refresh the prompt next frame
    if (G.Spatial && typeof G.Spatial.update === 'function') G.Spatial.update(player);
    placeRig();
    computeInteractTarget();
    checkZone(true);
    return true;
  }

  function fade(dur) {
    if (G.UI && typeof G.UI.fade === 'function') { try { G.UI.fade(dur); } catch (e) { /* the HUD decides how it fades */ } }
  }

  function teleport(x, z, yaw) {
    if (!player) return false;
    if (S.rolling) endRoll();
    fx('teleport', player.pos, { out: true, scale: 0.8 });
    fade(0.4);
    autoStop(true);
    const ok = spawnAt(x, z, typeof yaw === 'number' ? yaw : player.yaw);
    fx('teleport', player.pos, { scale: 1 });
    sfx('spell_cast', { vol: 0.5 });
    return ok;
  }

  function respawn() {
    if (!player) return false;
    let best = null, bestD = Infinity;
    const towns = (G.Data && G.Data.world && Array.isArray(G.Data.world.towns)) ? G.Data.world.towns : [];
    const zone = G.state.zone;
    const px = player.pos.x, pz = player.pos.z;
    for (let pass = 0; pass < 2 && !best; pass++) {
      for (let i = 0; i < towns.length; i++) {
        const t = towns[i]; if (!t) continue;
        if (pass === 0 && t.zone !== zone) continue;
        const rp = t.rallyPoint || t.pos; if (!rp) continue;
        const dx = rp.x - px, dz = rp.z - pz, d = dx * dx + dz * dz;
        if (d < bestD) { bestD = d; best = rp; }
      }
    }
    if (!best) { const sp = (G.Data && typeof G.Data.startPosFor === 'function') ? G.Data.startPosFor(player.race) : null; best = sp || { x: px, z: pz }; }
    if (player.mounted) dismount(true);
    player.alive = true; player.dead = false; player.deathTime = 0; player.target = null; player.autoAttack = false;
    player.invulnerable = false; player.casting = null; player.blocking = false; S.rmbHeld = false; S.blockT = 0; S.resumeAuto = false; S.attackQueued = false;
    computeStats(player);
    player.morale = Math.max(1, Math.round((player.stats.maxMorale || 100) * 0.1));
    player.power = Math.max(1, Math.round((player.stats.maxPower || 100) * 0.5));
    if (rig && typeof rig.setAnim === 'function') rig.setAnim('idle', true);
    teleport(best.x, best.z, player.yaw);
    emit('targetChanged', null);
    emit('playerRespawn', player);
    return true;
  }

  // ================================================================================================ CAMERA
  function getForward(out) {
    out = out || _v4;
    out.set(-Math.sin(cam.yaw), 0, -Math.cos(cam.yaw));
    return out;
  }
  function getRight(out) {
    out = out || _v4;
    out.set(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
    return out;
  }

  function cameraInput(dt, allowLook) {
    const I = G.Input; if (!I) return;
    const m = I.mouse, st = G.state.settings || EMPTY;
    // camera distance from settings (settings panel) ↔ wheel
    const sd = num(st.cameraDist, 7);
    if (sd !== S.settingDist) { S.settingDist = sd; cam.targetDist = clamp(sd, cam.minDist, cam.maxDist); }
    if (allowLook) {
      if (m.dx || m.dy) {
        const sens = MOUSE_SENS * num(st.mouseSens, 1);
        cam.yaw = wrapA(cam.yaw - m.dx * sens);
        cam.pitch = clamp(cam.pitch + m.dy * sens * (st.invertY ? -1 : 1), -PITCH_MAX, PITCH_MAX);
        S.lastMouseT = now();
      }
      if (m.wheel && (m.overCanvas || m.locked)) {
        cam.targetDist = clamp(cam.targetDist * Math.exp(m.wheel * 0.0012), cam.minDist, cam.maxDist);
        st.cameraDist = Math.round(cam.targetDist * 10) / 10; S.settingDist = st.cameraDist;
      }
      const tl = I.down('ArrowLeft'), tr = I.down('ArrowRight');
      if (tl || tr) { cam.yaw = wrapA(cam.yaw + (tl ? KEY_TURN : 0) * dt - (tr ? KEY_TURN : 0) * dt); S.lastMouseT = now(); }
    }
  }

  function updateCamera(dt) {
    if (!player) return;
    const pos = player.pos;
    const snap = S.camSnap; S.camSnap = false;
    // cam.dist is the ACTUAL camera distance (occlusion-clamped, what the player sees); the smoothed zoom lives in
    // S.zoom. Another module writing cam.dist directly (boat cinematic, admin god-view, a restored save) snaps the zoom.
    if (cam.dist !== S.distOut) S.zoom = clamp(num(cam.dist, cam.targetDist), 0.3, cam.maxDist);
    S.zoom = snap ? cam.targetDist : damp(S.zoom, cam.targetDist, 12, dt);
    const zoom = S.zoom;
    const fp = zoom < FP_DIST;
    if (fp !== S.fp) { S.fp = fp; P.firstPerson = fp; }
    const sc = rigScale();
    let ph = fp ? (rig ? rig.height * 0.92 : 1.65) : cam.height * sc;
    if (player.mounted) ph += mountLift();
    if (player.swimming) ph -= 0.45 * sc;
    _pivotT.set(pos.x + cam.offset.x, pos.y + ph + cam.offset.y, pos.z + cam.offset.z);
    const pv = cam.pivot;
    if (snap || !S.pivotInit) { pv.copy(_pivotT); S.pivotInit = true; }
    else {
      // lag-free in xz (no rubber band at mount speed), softened vertically (stairs, jumps, swells)
      pv.x = damp(pv.x, _pivotT.x, 45, dt); pv.z = damp(pv.z, _pivotT.z, 45, dt);
      pv.y = damp(pv.y, _pivotT.y, 9, dt);
      let dx = pv.x - _pivotT.x, dz = pv.z - _pivotT.z, dy = pv.y - _pivotT.y;
      const l = Math.sqrt(dx * dx + dz * dz);
      if (l > 0.3) { dx *= 0.3 / l; dz *= 0.3 / l; pv.x = _pivotT.x + dx; pv.z = _pivotT.z + dz; }
      if (dy > 1.0) pv.y = _pivotT.y + 1.0; else if (dy < -1.0) pv.y = _pivotT.y - 1.0;
    }
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    _fwd.set(-Math.sin(cam.yaw) * cp, -sp, -Math.cos(cam.yaw) * cp);       // camera → pivot direction
    _right.set(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
    const sh = fp ? 0 : cam.shoulder * clamp((zoom - FP_DIST) / 3, 0, 1);
    cam.lookAt.copy(pv).addScaledVector(_right, sh);
    _desired.copy(cam.lookAt).addScaledVector(_fwd, -zoom);
    let len = zoom;
    if (!fp && G.Physics && typeof G.Physics.cameraClamp === 'function') {
      const cpos = G.Physics.cameraClamp(cam.lookAt, _desired);
      if (cpos) { _v1.copy(cpos).sub(cam.lookAt); len = Math.min(zoom, _v1.dot(_fwd) * -1); if (!(len > 0.3)) len = 0.3; }
    }
    // pull in instantly, ease back out (no popping when the wall is left behind)
    if (snap || len < S.camLen) S.camLen = len; else S.camLen = Math.min(zoom, damp(S.camLen, len, 6, dt));
    if (!(S.camLen > 0.3)) S.camLen = 0.3;
    cam.dist = S.camLen; S.distOut = S.camLen;
    camera.position.copy(cam.lookAt).addScaledVector(_fwd, -S.camLen);
    const floor = terrainH(camera.position.x, camera.position.z) + 0.35;
    if (camera.position.y < floor) camera.position.y = floor;
    if (!(camera.position.x === camera.position.x)) camera.position.copy(_desired);
    camera.lookAt(cam.lookAt);
    camera.updateMatrixWorld();
    // rig visibility in first person
    if (rig && rig.group) rig.group.visible = !fp;
    if (mountRig && mountRig.group) mountRig.group.visible = !fp;
  }

  function mountLift() {
    if (!mountRig || !mountRig.parts || !mountRig.parts.saddle) return 1.2;
    mountRig.parts.saddle.getWorldPosition(_v3);
    const l = _v3.y - player.pos.y;
    return (l > 0.3 && l < 3) ? l : 1.2;
  }

  function snapCamera() { S.camSnap = true; S.pivotInit = false; if (player) cam.yaw = player.yaw; }
  function resize(w, h) {
    w = num(w, window.innerWidth || 1); h = num(h, window.innerHeight || 1);
    camera.aspect = w / Math.max(1, h); camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', function () { resize(window.innerWidth, window.innerHeight); });

  // ================================================================================================ TARGETING
  function setTarget(ent) {
    if (!player) return;
    if (ent && (ent === player || ent.dead || ent.alive === false)) ent = null;
    if (!ent) ent = null;
    if (player.target === ent) return;
    player.target = ent;
    player.autoAttack = livingHostile(ent);
    emit('targetChanged', ent);
  }

  function tabFilter(e) { return e !== player && e.kind === 'monster' && livingHostile(e) && e.pos; }
  function tabTarget() {
    if (!player || !G.Spatial) return null;
    const px = player.pos.x, pz = player.pos.z;
    G.Spatial.query(px, pz, 40, tabFilter, _tabList);
    if (!_tabList.length) return player.target;
    // sort by distance (insertion sort on the reused buffer)
    for (let i = 1; i < _tabList.length; i++) {
      const e = _tabList[i]; const de = (e.pos.x - px) * (e.pos.x - px) + (e.pos.z - pz) * (e.pos.z - pz);
      let j = i - 1;
      while (j >= 0) { const f = _tabList[j]; const df = (f.pos.x - px) * (f.pos.x - px) + (f.pos.z - pz) * (f.pos.z - pz); if (df <= de) break; _tabList[j + 1] = f; j--; }
      _tabList[j + 1] = e;
    }
    let idx = _tabList.indexOf(player.target);
    idx = (idx + 1) % _tabList.length;
    const t = _tabList[idx];
    _tabList.length = 0;
    setTarget(t);
    sfx('ui_click', { vol: 0.4 });
    return t;
  }

  function pickFilter(e) {
    if (e === player || !e.mesh || !e.mesh.visible || !e.pos) return false;
    const k = e.kind;
    return k === 'monster' || k === 'npc' || k === 'aiplayer' || k === 'chest' || k === 'node' || k === 'door' || k === 'boat' || k === 'fishspot' || k === 'mount';
  }
  function clickSelect(x, y) {
    if (!player || !G.Spatial) return null;
    const I = G.Input, canvas = I && I.canvas;
    let nx = 0, ny = 0;
    if (I && I.mouse.locked) { nx = 0; ny = 0; }
    else if (canvas) {
      const r = canvas.getBoundingClientRect();
      nx = ((num(x, r.left + r.width / 2) - r.left) / Math.max(1, r.width)) * 2 - 1;
      ny = -((num(y, r.top + r.height / 2) - r.top) / Math.max(1, r.height)) * 2 + 1;
    } else { nx = num(x, 0); ny = num(y, 0); }
    _ndc.set(nx, ny);
    _ray.setFromCamera(_ndc, camera);
    _ray.far = 120;
    G.Spatial.query(player.pos.x, player.pos.z, 60, pickFilter, _qbuf2);
    _pickList.length = 0; _pickMap.clear();
    for (let i = 0; i < _qbuf2.length; i++) { const e = _qbuf2[i]; _pickList.push(e.mesh); _pickMap.set(e.mesh, e); }
    _qbuf2.length = 0;
    let picked = null;
    if (_pickList.length) {
      const hits = _ray.intersectObjects(_pickList, true);
      for (let i = 0; i < hits.length && !picked; i++) {
        const h = hits[i];
        let o = h.object, ent = null;
        while (o && !ent) { ent = _pickMap.get(o) || null; o = o.parent; }
        if (!ent) continue;
        // occlusion: a wall/terrain between the camera and the hit hides it
        if (G.Physics && typeof G.Physics.raycast === 'function') {
          const occ = G.Physics.raycast(_ray.ray.origin, _ray.ray.direction, h.distance - 0.4);
          if (occ && occ.dist < h.distance - 0.5) continue;
        }
        picked = ent;
      }
    }
    _pickList.length = 0; _pickMap.clear();
    if (picked) { setTarget(picked); sfx('ui_click', { vol: 0.35 }); }
    return picked;
  }

  // ================================================================================================ INTERACTION
  function interactFilter(e) { return e !== player && !!e.interact && e.pos && !e.dead; }
  function computeInteractTarget() {
    if (!player || !G.Spatial) { P.interactTarget = null; return null; }
    const px = player.pos.x, py = player.pos.y, pz = player.pos.z;
    const fx_ = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    G.Spatial.query(px, pz, 6.5, interactFilter, _qbuf);
    let best = null, bestScore = Infinity;
    for (let i = 0; i < _qbuf.length; i++) {
      const e = _qbuf[i];
      const it = e.interact; if (!it || typeof it.fn !== 'function') continue;
      if (typeof it.enabled === 'function' && !it.enabled(e, player)) continue;
      const range = num(it.range, (e.kind === 'npc' || e.kind === 'aiplayer') ? (C.INTERACT_RANGE || 4) : 3);
      const dx = e.pos.x - px, dz = e.pos.z - pz, dy = e.pos.y - py;
      if (dy > 4 || dy < -4) continue;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > range + 0.4) continue;
      const dot = d > 1e-4 ? (dx * fx_ + dz * fz) / d : 1;
      let score = d - (dot > 0 ? 2.5 * dot : 0);
      if (dot < -0.2) score += 3;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    _qbuf.length = 0;
    if (best) {
      const it = best.interact;
      const label = typeof it.label === 'function' ? String(it.label(best, player) || 'Use') : String(it.label || 'Use');
      const cur = P.interactTarget;
      if (cur && cur.ent === best) { cur.label = label; cur.name = best.name || ''; }
      else P.interactTarget = { ent: best, label: label, name: best.name || '' };
    } else P.interactTarget = null;
    return P.interactTarget;
  }
  function interactLabel() {
    const t = P.interactTarget; if (!t) return '';
    const isNpc = t.ent && (t.ent.kind === 'npc' || t.ent.kind === 'aiplayer');
    return t.name && (isNpc || t.ent.kind === 'node' || t.ent.kind === 'chest' || t.ent.kind === 'fishspot' || t.ent.kind === 'boat') && t.label.indexOf(t.name) < 0 ? t.label + ' — ' + t.name : t.label;
  }
  function interact() {
    if (!player || !player.alive) return false;
    const t = computeInteractTarget();
    if (!t || !t.ent || !t.ent.interact) return false;
    const e = t.ent;
    // face it
    const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z;
    if (dx * dx + dz * dz > 0.04) { player.yaw = yawOf(dx, dz); }
    try { e.interact.fn(e, player); } catch (err) { if (G.reportError) G.reportError(err, 'Player.interact'); return false; }
    S.interactT = 0;
    return true;
  }

  // ================================================================================================ MOUNT
  function canMount() {
    if (!player || !player.alive || player.mounted) return false;
    if (player.swimming || (player.inWater && player.waterDepth > 0.8)) return false;
    if (P.inInterior) return false;
    if (S.rolling || player.casting) return false;
    if (!player.onGround) return false;
    return !!activeMountId();
  }
  function ensureHorse(id) {
    if (!id) return null;
    let h = horseRigs[id];
    if (h) return h;
    if (!G.Chars || typeof G.Chars.buildHorse !== 'function') return null;
    const t = mountTemplate(id);
    const color = t && t.mount && t.mount.color != null ? t.mount.color : 0x6b4a2e;
    try { h = G.Chars.buildHorse(color); } catch (e) { h = null; }
    if (!h || !h.group) return null;
    h.group.name = 'mount_' + id;
    horseRigs[id] = h;
    return h;
  }
  function mount(tid) {
    if (!player || player.mounted) return false;
    if (tid && Array.isArray(player.mounts) && player.mounts.indexOf(tid) >= 0) player.activeMount = tid;
    if (!canMount()) return false;
    const id = activeMountId(); if (!id) return false;
    const h = ensureHorse(id);
    if (!h) return false;
    const sc = currentScene() || (player.mesh && player.mesh.parent);
    mountRig = h; player.mountRig = h; player.mountId = id; player.mounted = true;
    if (rig && typeof rig.setMounted === 'function') rig.setMounted(true);
    if (rig && typeof rig.setAnim === 'function') rig.setAnim('ride', true);
    // rider onto the saddle
    if (player.mesh) {
      if (player.mesh.parent) player.mesh.parent.remove(player.mesh);
      const seat = h.parts && h.parts.saddle ? h.parts.saddle : h.group;
      seat.add(player.mesh);
      player.mesh.position.set(0, 0, 0); player.mesh.rotation.set(0, 0, 0); player.mesh.scale.set(1, 1, 1);
    }
    if (sc && h.group.parent !== sc) sc.add(h.group);
    h.group.visible = !S.fp;
    h.group.position.copy(player.pos); h.group.rotation.y = player.yaw;
    if (typeof h.setAnim === 'function') h.setAnim('idle', true);
    S.stride = 0; S.mountDustT = 0;
    fx('mount_dust', player.pos, { yaw: player.yaw, scale: 0.8 });
    sfx('horse_mount'); sfx('horse_neigh', { vol: 0.5 });
    emit('mounted', true);
    return true;
  }
  function dismount(silent) {
    if (!player || !player.mounted) return false;
    const h = mountRig;
    player.mounted = false; player.mountRig = null;
    if (rig && typeof rig.setMounted === 'function') rig.setMounted(false);
    if (rig && typeof rig.setAnim === 'function') rig.setAnim('idle', true);
    if (player.mesh) {
      if (player.mesh.parent) player.mesh.parent.remove(player.mesh);
      const sc = currentScene() || (h && h.group && h.group.parent);
      if (sc) sc.add(player.mesh);
      player.mesh.position.copy(player.pos); player.mesh.rotation.set(0, player.yaw, 0);
      player.mesh.visible = !S.fp;
    }
    if (h && h.group && h.group.parent) h.group.parent.remove(h.group);
    mountRig = null;
    stopGallop();
    if (!silent) { sfx('horse_mount', { pitch: 0.85, vol: 0.7 }); fx('dust', player.pos, { yaw: player.yaw, scale: 0.7 }); }
    emit('mounted', false);
    return true;
  }
  function toggleMount() {
    if (!player) return false;
    if (player.mounted) return dismount(false);
    if (!canMount()) {
      if (player.alive && !player.mounted) {
        if (P.inInterior) notify('You cannot summon a mount indoors.');
        else if (player.swimming || player.inWater) notify('You cannot summon a mount in water.');
        else if (!activeMountId()) notify('You have no mount.');
        sfx('ui_error', { vol: 0.5 });
      }
      return false;
    }
    return mount();
  }
  function startGallop() {
    if (S.gallopLoop) return;
    S.gallopLoop = true; S.gallopRetry = 0;
    sfx('horse_gallop', { loop: true, vol: 0.8 });
  }
  function stopGallop() {
    if (!S.gallopLoop) return;
    S.gallopLoop = false;
    if (G.Audio && typeof G.Audio.stopLoop === 'function') { try { G.Audio.stopLoop('horse_gallop', 0.25); } catch (e) { /* ignore */ } }
  }

  // ================================================================================================ ACTIONS
  function jump() {
    if (!player || !player.alive || S.rolling) return false;
    if (player.stats && (player.stats.rooted || player.stats.stunned)) return false;
    if (player.swimming) {
      // hop toward the shore when the water gets shallow ahead
      const ax = player.pos.x - Math.sin(player.yaw) * 1.2, az = player.pos.z - Math.cos(player.yaw) * 1.2;
      const depth = (G.Terrain && G.Terrain.waterDepth) ? G.Terrain.waterDepth(ax, az) : 0;
      if (depth < 1.3) { player.vel.y = C.JUMP_VEL * 0.75; player.onGround = false; player.swimming = false; sfx('splash', { vol: 0.4 }); return true; }
      return false;
    }
    if (!(player.onGround || S.coyote > 0)) return false;
    player.vel.y = C.JUMP_VEL;
    player.onGround = false; S.coyote = 0; S.jumpBuffer = 0;
    if (rig && typeof rig.setAnim === 'function' && !player.mounted) rig.setAnim('jump', true);
    sfx('jump', { vol: 0.7 });
    return true;
  }

  function dodgeRoll() {
    if (!player || !player.alive || S.rolling || player.mounted || player.swimming || !player.onGround) return false;
    if (now() < (player.rollReady || 0)) return false;
    if (player.stats && (player.stats.rooted || player.stats.stunned)) return false;
    let dx = moveInput.x, dz = moveInput.z;
    if (dx * dx + dz * dz < 1e-4) { dx = -Math.sin(player.yaw); dz = -Math.cos(player.yaw); }
    else { const l = Math.sqrt(dx * dx + dz * dz); dx /= l; dz /= l; }
    S.rolling = true; S.rollT = 0; S.rollDirX = dx; S.rollDirZ = dz; P.rolling = true;
    player.invulnerable = true;
    player.rollReady = now() + (C.ROLL_CD || 3);
    player.yaw = yawOf(dx, dz);
    if (rig && typeof rig.setAnim === 'function') rig.setAnim('roll', true);
    fx('dust', player.pos, { yaw: player.yaw, scale: 1 });
    sfx('roll');
    return true;
  }
  function endRoll() {
    S.rolling = false; P.rolling = false;
    if (player) player.invulnerable = false;
  }
  function rollCooldown() {
    if (!player) return 1;
    const cd = C.ROLL_CD || 3;
    return clamp(1 - ((player.rollReady || 0) - now()) / cd, 0, 1);
  }

  function rangedKind(v) {
    const s = v && v.subtype;
    if (s === 'bow' || s === 'crossbow') return 'arrow';
    if (s === 'javelin' || s === 'throwing') return 'stone';
    return 'bolt';
  }
  function frontHostile(range, minDot) {
    if (!G.Spatial || !player) return null;
    if (typeof minDot !== 'number') minDot = 0.2;
    const px = player.pos.x, pz = player.pos.z;
    const fx_ = -Math.sin(player.yaw), fz = -Math.cos(player.yaw);
    G.Spatial.query(px, pz, range, tabFilter, _qbuf2);
    let best = null, bestD = Infinity;
    for (let i = 0; i < _qbuf2.length; i++) {
      const e = _qbuf2[i]; const dx = e.pos.x - px, dz = e.pos.z - pz; const d = Math.sqrt(dx * dx + dz * dz);
      if (d < 1e-3) { best = e; break; }
      const dot = (dx * fx_ + dz * fz) / d; if (dot < minDot) continue;
      const score = d * (1.6 - dot);
      if (score < bestD) { bestD = score; best = e; }
    }
    _qbuf2.length = 0;
    return best;
  }
  function rangedAttack() {
    if (!player || !player.alive || S.rolling || player.blocking) return false;
    const inst = player.equipment && player.equipment.ranged;
    if (!inst) { notify('You need a ranged weapon equipped.'); sfx('ui_error', { vol: 0.5 }); return false; }
    if (now() < S.rangedReady) return false;
    if (player.stats && player.stats.stunned) return false;
    const range = C.RANGED_RANGE || 30;
    let t = player.target;
    if (!livingHostile(t) || dist2(t) > range * range) t = frontHostile(range);
    if (!t) { notify('No target in range.'); sfx('ui_error', { vol: 0.4 }); return false; }
    if (t !== player.target) setTarget(t);
    if (player.mounted) dismount(false);
    const dx = t.pos.x - player.pos.x, dz = t.pos.z - player.pos.z;
    player.yaw = yawOf(dx, dz);
    S.faceTargetT = 0.8;
    S.rangedReady = now() + RANGED_CD;
    S.rangedPending = RANGED_RELEASE; S.rangedTarget = t;
    player.autoAttack = true;
    if (rig && typeof rig.setAnim === 'function') rig.setAnim('attack_shoot', true);
    const v = (G.Items && typeof G.Items.get === 'function') ? G.Items.get(inst) : inst;
    const kind = rangedKind(v);
    sfx(kind === 'arrow' ? 'bow_shoot' : kind === 'stone' ? 'sword_swing' : 'spell_cast', { vol: 0.8 });
    return true;
  }
  function dist2(e) { const dx = e.pos.x - player.pos.x, dz = e.pos.z - player.pos.z; return dx * dx + dz * dz; }
  function releaseRanged() {
    const t = S.rangedTarget; S.rangedTarget = null;
    if (!player || !t || t.dead || t.alive === false || !t.pos) return;
    const inst = player.equipment && player.equipment.ranged; if (!inst) return;
    const v = (G.Items && typeof G.Items.get === 'function') ? G.Items.get(inst) : inst;
    const kind = rangedKind(v);
    const st = player.stats || EMPTY;
    const dmgT = v && v.dmg ? v.dmg : null;
    const lo = dmgT ? num(dmgT.min, 3) : 3, hi = dmgT ? num(dmgT.max, lo + 2) : 5;
    const rnd = (typeof G.rand === 'function') ? G.rand() : 0.5;
    let amount = lo + (hi - lo) * rnd + num(st.physMastery, 0) / 6;
    const critChance = num(st.critChance, 0);
    const crit = ((typeof G.rand === 'function') ? G.rand() * 100 : 50) < critChance;
    if (crit) amount *= 1.6;
    amount = Math.max(1, Math.round(amount));
    const dtype = (dmgT && dmgT.type) || 'common';
    handPos(_v1);
    const color = v && v.visual && v.visual.glow ? v.visual.glow : undefined;
    let fired = null;
    if (G.FX && typeof G.FX.projectile === 'function') {
      fired = G.FX.projectile({
        from: _v1, target: t, kind: kind, speed: kind === 'arrow' ? 42 : 28, color: color,
        onHit: function (point, ent) { rangedHit(t, amount, dtype, crit); },
      });
    }
    if (!fired) rangedHit(t, amount, dtype, crit);
  }
  function rangedHit(t, amount, dtype, crit) {
    if (!player || !t || t.dead || t.alive === false) return;
    if (G.Combat && typeof G.Combat.damage === 'function') { try { G.Combat.damage(player, t, amount, dtype, { crit: crit, ability: 'ranged' }); } catch (e) { if (G.reportError) G.reportError(e, 'Player.rangedHit'); } }
    else if (typeof t.morale === 'number') t.morale -= amount;
    sfx('arrow_hit', { pos: t.pos, vol: 0.7 });
  }

  // ================================================================================================ LMB ATTACK / RMB BLOCK
  /** Left click on the canvas. `picked` is what clickSelect hit (an NPC / door / node → selection only). Attacks the
   *  living hostile target, else the nearest living hostile in front within melee reach; a swing that cannot fire yet
   *  (weapon timer, range) is queued and fires at the next chance. With nothing in reach the swing is still visible. */
  function clickAttack(picked) {
    if (!player || !player.alive || S.rolling) return false;
    if (picked && !livingHostile(picked)) return false;
    if (player.blocking) return false;                                   // the guard is up: no attacks
    let t = livingHostile(player.target) ? player.target : null;
    if (!t) { t = frontHostile((C.MELEE_RANGE || 3.2) + 1, 0.3); if (t) setTarget(t); }
    if (t) {
      if (player.mounted) dismount(false);
      player.autoAttack = true;
      S.faceTargetT = 0.9;
      let ok = false;
      if (G.Combat && typeof G.Combat.basicAttack === 'function') { try { ok = !!G.Combat.basicAttack(player, t, EMPTY); } catch (e) { if (G.reportError) G.reportError(e, 'Player.clickAttack'); ok = false; } }
      if (!ok) { S.attackQueued = true; S.attackQueuedT = now() + 2.5; }
      return true;
    }
    if (rig && typeof rig.setAnim === 'function') rig.setAnim('attack_slash', true);
    sfx('sword_swing', { vol: 0.45 });
    return false;
  }
  function updateQueuedAttack() {
    if (!S.attackQueued) return;
    if (now() > S.attackQueuedT || !player.alive || player.blocking || !livingHostile(player.target)) { S.attackQueued = false; return; }
    if (!G.Combat || typeof G.Combat.basicAttack !== 'function') { S.attackQueued = false; return; }
    let ok = false;
    try { ok = !!G.Combat.basicAttack(player, player.target, EMPTY); } catch (e) { ok = false; S.attackQueued = false; }
    if (ok) S.attackQueued = false;
  }
  /** Right button held → player.blocking (G.Combat.damage: physical −60 %, tactical −30 %); movement at half speed,
   *  auto-attack paused while the guard is up and restored on release. Emits blockingChanged(bool). */
  function setBlocking(on) {
    if (!player) return false;
    on = !!on;
    if (player.blocking === on) return on;
    player.blocking = on;
    if (on) {
      S.resumeAuto = !!player.autoAttack; player.autoAttack = false;
      S.attackQueued = false;
      sfx('equip', { vol: 0.35, pitch: 0.85 });
    } else {
      if (S.resumeAuto && livingHostile(player.target)) player.autoAttack = true;
      S.resumeAuto = false;
    }
    emit('blockingChanged', on);
    return on;
  }
  // guard pose: shield arm raised across the chest, weapon arm drawn back, a little crouch — blended over the rig's
  // own animation after rig.play() (the humanoid rig has no 'block' clip; 'block' aliases the short 'hit' flinch)
  // joint conventions (14_characters): x = raise forward, left-arm z negative = out from the body (rest −0.22)
  const GUARD = { armL: [1.05, 0, -0.02], forearmL: [1.45, 0, 0.4], handL: [-0.3, 0, 0], armR: [0.3, 0, 0.35], forearmR: [0.9, 0, -0.05], torso: [0.06, -0.12, 0] };
  const GUARD_KEYS = Object.keys(GUARD);
  function guardPose() {
    const k = S.blockT;
    if (!(k > 0) || !rig || !rig.parts) return;
    for (let i = 0; i < GUARD_KEYS.length; i++) {
      const j = rig.parts[GUARD_KEYS[i]]; if (!j || !j.rotation) continue;
      const t = GUARD[GUARD_KEYS[i]], r = j.rotation;
      r.x += (t[0] - r.x) * k; r.y += (t[1] - r.y) * k; r.z += (t[2] - r.z) * k;
    }
  }

  function useHotbar(i) {
    if (!player || !player.alive) return false;
    const id = player.hotbar && player.hotbar[i]; if (!id) return false;
    if (player.blocking) { S.rmbHeld = false; setBlocking(false); }   // an ability lowers the guard (press RMB again to block)
    if (!G.Combat || typeof G.Combat.useAbility !== 'function') return false;
    let ok = false;
    try { ok = !!G.Combat.useAbility(player, id, player.target || undefined); } catch (e) { if (G.reportError) G.reportError(e, 'Player.useHotbar'); ok = false; }
    if (ok) { if (player.mounted) dismount(false); if (livingHostile(player.target)) S.faceTargetT = 0.9; }
    return ok;
  }

  function headPos(out) {
    out = out || _v4;
    if (!player) return out.set(0, 0, 0);
    let h = rig ? rig.height * 0.92 : 1.65;
    if (player.mounted) h += mountLift();
    if (player.swimming) h -= 0.5 * rigScale();
    return out.set(player.pos.x, player.pos.y + h, player.pos.z);
  }
  function handPos(out) {
    out = out || _v4;
    if (!player) return out.set(0, 0, 0);
    if (rig && rig.parts && rig.parts.handR && rig.group.visible && rig.group.parent) {
      rig.parts.handR.getWorldPosition(out);
      const dx = out.x - player.pos.x, dz = out.z - player.pos.z;
      if (dx * dx + dz * dz < 4 && out.y > player.pos.y - 0.5 && out.y < player.pos.y + 4) return out;
    }
    const h = (rig ? rig.height : 1.8) * 0.72 + (player.mounted ? mountLift() : 0);
    return out.set(player.pos.x + Math.cos(player.yaw) * 0.3, player.pos.y + h, player.pos.z - Math.sin(player.yaw) * 0.3);
  }

  function isBusy() {
    if (!player) return true;
    if (!player.alive || player.dead) return true;
    if (S.rolling || player.casting) return true;
    if (G.Boats && G.Boats.sailing) return true;
    if (G.Fishing && G.Fishing.state && G.Fishing.state !== 'idle') return true;
    return false;
  }

  // ================================================================================================ AUTO-MOVE
  function autoMove(target, opts) {
    if (!player || !target) return false;
    opts = opts || EMPTY;
    const tx = num(target.x, NaN), tz = num(target.z, NaN);
    if (tx !== tx || tz !== tz) return false;
    A.active = true; A.tx = tx; A.tz = tz;
    A.arrive = Math.max(0.3, num(opts.arrive, 1.5));
    A.mount = opts.mount !== false;
    A.onArrive = typeof opts.onArrive === 'function' ? opts.onArrive : null;
    A.timeout = num(opts.timeout, 0);
    A.elapsed = 0; A.steer = 0; A.avoid = 0; A.freeT = 0; A.bestDist = 1e9; A.progressT = now(); A.waterBlockT = 0; A.swimUntil = 0; A.flipT = 0;
    A.targetOnLand = !(G.Terrain && G.Terrain.waterDepth && G.Terrain.waterDepth(tx, tz) > 1.2);
    _autoTarget.set(tx, groundYAt(tx, tz), tz);
    P.autoMoving = true; P.autoStuck = false; P.autoTarget = _autoTarget;
    S.blockedT = 0;
    P.autoRun = false;
    return true;
  }
  function autoStop(silent) {
    if (!A.active) return;
    A.active = false; A.onArrive = null;
    P.autoMoving = false; P.autoTarget = null;
    if (!silent) emit('autoMoveStopped');
  }
  function probeBlocked(px, pz, feetY, checkWater) {
    // colliders that would stop a walking capsule (steppable ledges and floors under the feet are ignored)
    if (G.Physics && typeof G.Physics.overlapCircle === 'function') {
      const list = G.Physics.overlapCircle(px, pz, 0.55, feetY + 0.65, feetY + 1.7);
      if (list && list.length) return true;
    }
    if (G.Veg && typeof G.Veg.treesNear === 'function') { const tr = G.Veg.treesNear(px, pz, 0.6); if (tr && tr.length) return true; }
    if (G.Terrain) {
      if (checkWater && G.Terrain.waterDepth && G.Terrain.waterDepth(px, pz) > 1.0) return true;
      if (G.Terrain.slope && G.Terrain.height && G.Terrain.slope(px, pz) > 0.85 && G.Terrain.height(px, pz) > feetY + 0.5) return true;
    }
    return false;
  }
  const PROBE_ANGLES = [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4];
  function autoSteer(dt) {
    if (!A.active || !player) return false;
    const px = player.pos.x, pz = player.pos.z, py = player.pos.y;
    let dx = A.tx - px, dz = A.tz - pz;
    const dist = Math.sqrt(dx * dx + dz * dz);
    A.elapsed += dt;
    if (dist <= A.arrive) {
      const cb = A.onArrive;
      autoStop(true);
      P.autoStuck = false;
      emit('autoMoveArrived');
      if (cb) { try { cb(); } catch (e) { if (G.reportError) G.reportError(e, 'Player.autoMove:onArrive'); } }
      return false;
    }
    if (A.timeout > 0 && A.elapsed > A.timeout) { P.autoStuck = true; autoStop(false); return false; }
    // progress / stuck
    if (dist < A.bestDist - 0.5) { A.bestDist = dist; A.progressT = now(); if (P.autoStuck) P.autoStuck = false; }
    else if (now() - A.progressT > AUTO_STUCK) {
      P.autoStuck = true;
      if (now() - A.flipT > 2) { A.avoid = A.avoid <= 0 ? 1 : -1; A.flipT = now(); }
    }
    dx /= dist; dz /= dist;
    let chosen = 0;
    const checkWater = A.targetOnLand && now() > A.swimUntil && !player.swimming;
    if (dist > 2.5) {
      let found = false;
      for (let k = 0; k < PROBE_ANGLES.length && !found; k++) {
        let ang = PROBE_ANGLES[k];
        // prefer the side we are already avoiding toward (prevents left/right dithering)
        if (A.avoid !== 0 && k > 0 && (k & 1) === 1) { const alt = -PROBE_ANGLES[k]; if (Math.sign(alt) === A.avoid) ang = alt; }
        else if (A.avoid !== 0 && k > 0 && (k & 1) === 0) { const alt = -PROBE_ANGLES[k]; if (Math.sign(PROBE_ANGLES[k]) !== A.avoid) ang = PROBE_ANGLES[k]; else ang = alt; }
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const rx = dx * ca - dz * sa, rz = dx * sa + dz * ca;
        const far = Math.min(AUTO_PROBE, dist);
        let blocked = probeBlocked(px + rx * far, pz + rz * far, py, checkWater);
        if (!blocked && k === 0) blocked = probeBlocked(px + rx * AUTO_NEAR, pz + rz * AUTO_NEAR, py, checkWater);
        if (!blocked) { chosen = ang; found = true; }
      }
      if (!found) chosen = (A.avoid || 1) * 1.6;
      if (chosen !== 0) { if (A.avoid === 0) A.avoid = chosen > 0 ? 1 : -1; A.freeT = 0; }
      else { A.freeT += dt; if (A.freeT > 1.5) A.avoid = 0; }
      // water wall limit → allow swimming for a while
      if (checkWater && chosen !== 0) {
        const wx = px + dx * AUTO_PROBE, wz = pz + dz * AUTO_PROBE;
        if (G.Terrain && G.Terrain.waterDepth && G.Terrain.waterDepth(wx, wz) > 1.0) { A.waterBlockT += dt; if (A.waterBlockT > AUTO_WATER_LIMIT) { A.swimUntil = now() + 12; A.waterBlockT = 0; } }
        else A.waterBlockT = Math.max(0, A.waterBlockT - dt);
      }
    } else A.avoid = 0;
    A.steer = damp(A.steer, chosen, 9, dt);
    const ca = Math.cos(A.steer), sa = Math.sin(A.steer);
    A.dirX = dx * ca - dz * sa; A.dirZ = dx * sa + dz * ca;
    // mount management
    if (A.mount && !player.mounted && dist > AUTO_MOUNT_DIST && canMount()) mount();
    else if (player.mounted && dist < AUTO_DISMOUNT_DIST) dismount(false);
    // the camera follows the path when the player is not steering it
    if (now() - S.lastMouseT > 1.5) cam.yaw = adamp(cam.yaw, yawOf(A.dirX, A.dirZ), 2.5, dt);
    return true;
  }

  // ================================================================================================ MOVEMENT
  function currentGroundType() {
    if (!player) return 'grass';
    if (player.inWater && !player.swimming && player.waterDepth > 0.15) return 'water';
    if (P.inInterior) return 'wood';
    if (player.groundCollider && player.groundCollider.floor) return 'wood';
    return (G.Terrain && G.Terrain.groundType) ? G.Terrain.groundType(player.pos.x, player.pos.z) : 'grass';
  }

  function stepMovement(dt, controls, canLook) {
    const pl = player, I = G.Input, st = pl.stats || EMPTY;
    const pos = pl.pos;
    let ix = 0, iz = 0, fwdIn = 0, strIn = 0, haveInput = false;
    // ---- gather input
    if (A.active) {
      if (autoSteer(dt)) { ix = A.dirX; iz = A.dirZ; fwdIn = 1; haveInput = true; }
    }
    if (!A.active && controls && I) {
      if (I.down('KeyW') || I.down('ArrowUp')) fwdIn += 1;
      if (I.down('KeyS') || I.down('ArrowDown')) fwdIn -= 1;
      if (I.down('KeyD')) strIn += 1;
      if (I.down('KeyA')) strIn -= 1;
      if (I.mouseDown(0) && I.mouseDown(2)) fwdIn += 1;
      if (I.pressed('NumLock')) { P.autoRun = !P.autoRun; if (P.autoRun) sfx('ui_click', { vol: 0.3 }); }
      if ((I.pressed('KeyW') || I.pressed('KeyS') || I.pressed('ArrowUp') || I.pressed('ArrowDown')) && P.autoRun && !(I.pressed('NumLock'))) P.autoRun = false;
      if (P.autoRun && fwdIn === 0) fwdIn = 1;
      if (fwdIn > 1) fwdIn = 1;
      if (fwdIn || strIn) {
        getForward(_v1); getRight(_v2);
        ix = _v1.x * fwdIn + _v2.x * strIn; iz = _v1.z * fwdIn + _v2.z * strIn;
        const l = Math.sqrt(ix * ix + iz * iz); if (l > 1e-6) { ix /= l; iz /= l; }
        haveInput = true; S.manualMoveT = now();
      }
    } else if (A.active && controls && I && (I.down('KeyW') || I.down('KeyS') || I.down('KeyA') || I.down('KeyD') || I.down('ArrowUp') || I.down('ArrowDown'))) {
      autoStop(false);                                           // the player takes over
    }
    moveInput.x = ix; moveInput.z = iz;

    // ---- speed
    let speed = 0;
    const mounted = pl.mounted;
    if (haveInput && pl.alive) {
      const mul = num(st.speed, 1) * num(pl.speedMult, 1);
      if (mounted) speed = mountSpeed(pl.mountId) * mul * num(st.mountSpeedMult, 1);
      else if (pl.swimming) speed = C.SWIM_SPEED * mul * num(st.swimSpeedMult, 1);
      else speed = C.RUN_SPEED * mul;
      if (fwdIn < 0 && !mounted && !pl.swimming) speed *= 0.5;
      if (pl.blocking) speed *= 0.5;                             // guard up: half speed
      if (st.rooted || st.stunned) speed = 0;
      if (G.state.flyCam) speed *= 3;
    }
    _v1.set(ix * speed, 0, iz * speed);                          // desired velocity

    // ---- integrate the FULL game dt in sub-steps of ≤ SUB_DT. The main loop caps raw dt at 0.05 s but multiplies it by
    //      G.time.scale (×3 in the verifier, up to ×5 from the admin panel) → 0.15–0.25 s frames; the physics clamps its
    //      own dt at 0.1, so a single call would move the player slower than G.time advances (and slower than every
    //      monster). Sub-stepping keeps speed × game-time exact and the collision/jump integration accurate.
    const wasGround = pl.onGround, wasSwimming = pl.swimming;
    _prevPos.copy(pos);
    _physOpts.fly = !!G.state.flyCam; _physOpts.noclip = !!(G.state.noclip || G.state.flyCam);
    if (controls && I && I.pressed('Space') && !G.state.flyCam) S.jumpBuffer = JUMP_BUFFER;
    const nSub = dt > SUB_DT ? Math.min(MAX_SUB, Math.ceil(dt / SUB_DT - 1e-6)) : 1;
    const sdt = dt / nSub;
    let landed = 0, splashed = 0;
    for (let s = 0; s < nSub; s++) {
      // ---- rolling overrides everything
      if (S.rolling) {
        S.rollT += sdt;
        const t = S.rollT / (C.ROLL_TIME || 0.55);
        const rs = (C.ROLL_SPEED || 10) * (1 - 0.35 * t * t);
        _moveVel.x = S.rollDirX * rs; _moveVel.z = S.rollDirZ * rs;
        if (t >= 1 || !pl.alive || pl.swimming) endRoll();
      } else {
        // ---- acceleration toward the desired velocity
        const air = !(pl.onGround || pl.swimming);
        const curL = Math.sqrt(_moveVel.x * _moveVel.x + _moveVel.z * _moveVel.z);
        const accel = (speed > curL ? (mounted ? MOUNT_ACCEL : ACCEL) : (mounted ? MOUNT_DECEL : DECEL)) * (air ? AIR_CONTROL : 1);
        let ddx = _v1.x - _moveVel.x, ddz = _v1.z - _moveVel.z;
        const dl = Math.sqrt(ddx * ddx + ddz * ddz), maxStep = accel * sdt;
        if (dl <= maxStep || dl < 1e-6) { _moveVel.x = _v1.x; _moveVel.z = _v1.z; }
        else { _moveVel.x += ddx / dl * maxStep; _moveVel.z += ddz / dl * maxStep; }
      }
      // vertical (fly-cam only)
      if (G.state.flyCam && I) _moveVel.y = ((I.down('Space') ? 1 : 0) - (I.down('ShiftLeft') || I.down('ControlLeft') ? 1 : 0)) * Math.max(6, speed);
      else _moveVel.y = 0;

      // ---- jump (buffered + coyote)
      if (pl.onGround) S.coyote = COYOTE; else S.coyote = Math.max(0, S.coyote - sdt);
      if (S.jumpBuffer > 0) { S.jumpBuffer -= sdt; if (jump()) S.jumpBuffer = 0; }

      // ---- physics
      if (G.Physics && typeof G.Physics.moveEntity === 'function') G.Physics.moveEntity(pl, _moveVel, sdt, _physOpts);
      else { pos.x += _moveVel.x * sdt; pos.z += _moveVel.z * sdt; pos.y = terrainH(pos.x, pos.z); pl.onGround = true; }
      if (pl.justLanded > landed) landed = pl.justLanded;
      if (pl.justSplashed > splashed) splashed = pl.justSplashed;
    }
    pl.justLanded = landed; pl.justSplashed = splashed;         // per-frame events: a landing in an early sub-step is kept
    // actual horizontal velocity (so a wall stops the run animation and momentum is not stored into obstacles)
    let ax = 0, az = 0, actual = 0;
    if (dt > 1e-4) {
      ax = (pos.x - _prevPos.x) / dt; az = (pos.z - _prevPos.z) / dt;
      actual = Math.sqrt(ax * ax + az * az);
      if (actual > speed * 1.5 + 12) { ax = _moveVel.x; az = _moveVel.z; actual = Math.sqrt(ax * ax + az * az); }   // teleport / step artefacts
      pl.vel.x = ax; pl.vel.z = az;
      if (!pl.swimming && !S.rolling) {
        // blocked: bleed the stored velocity down to what actually happened
        const ml = Math.sqrt(_moveVel.x * _moveVel.x + _moveVel.z * _moveVel.z);
        if (actual < ml * 0.5 && ml > 0.5) { _moveVel.x = damp(_moveVel.x, ax, 20, dt); _moveVel.z = damp(_moveVel.z, az, 20, dt); }
      }
    }
    // blocked detection (auto-jump for the bot, stuck feel for the player)
    if (haveInput && speed > 1 && pl.onGround && actual < speed * 0.25) S.blockedT += dt; else S.blockedT = 0;
    if (A.active && S.blockedT > AUTO_BLOCK_JUMP && pl.onGround && !pl.mounted) { if (jump()) S.blockedT = 0; }
    else if (A.active && S.blockedT > 1.5 && pl.mounted) { dismount(false); S.blockedT = AUTO_BLOCK_JUMP; }

    // ---- landing / splash
    if (pl.justLanded > 0) {
      const v = pl.justLanded;
      sfx('land', { vol: clamp(0.3 + v * 0.06, 0.3, 1), pitch: 1 - clamp((v - 4) * 0.03, 0, 0.25) });
      fx('dust', pos, { yaw: pl.yaw, scale: clamp(0.5 + v * 0.08, 0.6, 2) });
      if (v > FALL_DMG_SPEED && !G.state.noclip && !pl.invulnerable && pl.alive) fallDamage(v);
      S.stride = 0;
    }
    if (pl.justSplashed > 0) { fx('splash', pos, { scale: clamp(0.6 + pl.justSplashed * 0.08, 0.6, 2) }); sfx('splash', { vol: 0.8 }); }
    if (!wasSwimming && pl.swimming) {
      if (pl.mounted) dismount(true);
      if (S.rolling) endRoll();
      if (rig && typeof rig.setAnim === 'function') rig.setAnim('swim', true);
    } else if (wasSwimming && !pl.swimming && rig && typeof rig.setAnim === 'function') rig.setAnim('idle', true);
    void wasGround;

    // ---- footsteps (distance based)
    if (pl.onGround && !pl.swimming && actual > 0.6) {
      S.stride += actual * dt;
      const stride = mounted ? STRIDE_HORSE : (actual > C.WALK_SPEED * 1.5 ? STRIDE_RUN : STRIDE_WALK);
      if (S.stride >= stride) {
        S.stride -= stride; S.footSide = -S.footSide;
        const gt = currentGroundType();
        if (G.Audio && typeof G.Audio.footstep === 'function') { try { G.Audio.footstep(gt, mounted ? { vol: 0.9, pitch: 0.8 } : { vol: clamp(actual / C.RUN_SPEED, 0.4, 1) }); } catch (e) { /* ignore */ } }
        _v2.set(pos.x + Math.cos(pl.yaw) * 0.16 * S.footSide, pos.y + 0.03, pos.z - Math.sin(pl.yaw) * 0.16 * S.footSide);
        fx('footstep', _v2, { ground: gt, yaw: pl.yaw, scale: mounted ? 1.4 : 1 });
      }
    } else if (!pl.onGround) S.stride = 0;
    // ---- swimming sounds
    if (pl.swimming) {
      S.swimSfxT -= dt;
      if (actual > 0.4 && S.swimSfxT <= 0) { S.swimSfxT = 1.3; sfx('swim', { vol: 0.5 }); fx('water_ring', pos, { scale: 0.6 }); }
    }
    // ---- mount sounds & dust
    if (mounted) {
      if (actual > 5.5 && pl.onGround) {
        startGallop();
        S.mountDustT -= dt;
        if (S.mountDustT <= 0) { S.mountDustT = 0.22; fx('mount_dust', pos, { yaw: pl.yaw, scale: 0.9 }); }
      } else if (S.gallopLoop && actual < 4.5) stopGallop();
      if (S.gallopLoop && G.Audio && !G.Audio.ready) { S.gallopRetry += dt; if (S.gallopRetry > 1) { S.gallopRetry = 0; sfx('horse_gallop', { loop: true, vol: 0.8 }); } }
    }
    return actual;
  }

  function fallDamage(v) {
    const st = player.stats || EMPTY;
    const frac = clamp((v - FALL_DMG_SPEED) / 14, 0, 1.5) * num(st.fallDamageMult, 1);
    const amount = Math.round((st.maxMorale || 100) * frac);
    if (amount <= 0) return;
    if (G.Combat && typeof G.Combat.damage === 'function') { try { G.Combat.damage(null, player, amount, 'common', { raw: true, ability: 'fall' }); } catch (e) { if (G.reportError) G.reportError(e, 'Player.fallDamage'); } }
    else { player.morale = Math.max(0, player.morale - amount); if (player.morale <= 0) { player.alive = false; player.dead = true; player.deathTime = now(); emit('playerDeath', player); } }
    sfx('hurt', { vol: 0.8 });
    if (rig && typeof rig.setAnim === 'function' && player.alive) rig.setAnim('hit', true);
    if (G.UI && typeof G.UI.floatText === 'function') { try { G.UI.floatText(headPos(_v3), '-' + amount, '#ff6a4a', { size: 1.1 }); } catch (e) { /* ignore */ } }
  }

  // ================================================================================================ BODY YAW & RIG
  function updateYaw(dt, moving, fwdIn) {
    const pl = player;
    if (!pl.alive) return;
    if (S.rolling) { pl.yaw = yawOf(S.rollDirX, S.rollDirZ); return; }
    if (S.fp) { pl.yaw = cam.yaw; return; }
    if (S.faceTargetT > 0) S.faceTargetT -= dt;
    const t = pl.target;
    const facingTarget = !moving && livingHostile(t) && (pl.autoAttack || S.faceTargetT > 0 || G.state.inCombat) && dist2(t) < 1600;
    if (moving) {
      let ty;
      if (fwdIn < 0 && !A.active) ty = cam.yaw;                                    // backpedal: keep facing away from the camera
      else {
        // face the movement direction, blended a little toward the camera (mouse steer)
        getForward(_v2);
        const bx = moveInput.x * 0.75 + _v2.x * 0.25, bz = moveInput.z * 0.75 + _v2.z * 0.25;
        ty = (bx * bx + bz * bz > 1e-6) ? yawOf(bx, bz) : cam.yaw;
      }
      pl.yaw = adamp(pl.yaw, ty, pl.mounted ? TURN_MOVE * 0.6 : TURN_MOVE, dt);
    } else if (facingTarget) {
      pl.yaw = adamp(pl.yaw, yawOf(t.pos.x - pl.pos.x, t.pos.z - pl.pos.z), TURN_TARGET, dt);
    } else if (!t || !livingHostile(t)) {
      pl.yaw = adamp(pl.yaw, cam.yaw, TURN_IDLE, dt);
    }
    pl.yaw = wrapA(pl.yaw);
  }

  function placeRig() {
    if (!player) return;
    if (player.mounted && mountRig && mountRig.group) {
      mountRig.group.position.copy(player.pos);
      mountRig.group.rotation.y = player.yaw;
    } else if (player.mesh) {
      player.mesh.position.copy(player.pos);
      player.mesh.rotation.y = player.yaw;
    }
  }

  function animate(dt) {
    const pl = player;
    if (pl.mounted && mountRig) {
      if (typeof mountRig.play === 'function') mountRig.play(dt, pl);
      mountRig.group.updateMatrixWorld(true);
    }
    if (rig && typeof rig.play === 'function') rig.play(dt, pl);
    guardPose();
    if (rig) { pl.anim = rig.anim || pl.anim; pl.animTime = rig.animT || 0; }
    if (!pl.mounted && pl.mesh) pl.mesh.updateMatrixWorld(true);
    if (pl.nameplate) pl.nameplate.visible = false;
  }

  // ================================================================================================ ZONE / INTERIOR
  function checkZone(force) {
    if (!player || !G.Terrain || typeof G.Terrain.zoneAt !== 'function') return;
    let z = null;
    try { z = G.Terrain.zoneAt(player.pos.x, player.pos.z); } catch (e) { z = null; }
    if (!z) return;
    if (z !== G.state.zone || force) {
      const changed = z !== G.state.zone;
      G.state.zone = z;
      if (changed) emit('zoneChanged', z);
    }
  }

  // ================================================================================================ UPDATE
  function update(dt) {
    if (!player) return;
    dt = num(dt, 0); if (dt <= 0) return; if (dt > MAX_DT) dt = MAX_DT;
    const pl = player, I = G.Input;
    if (G.state.stats) G.state.stats.playTime = num(G.state.stats.playTime, 0) + dt;

    // interior
    P.inInterior = (G.Buildings && typeof G.Buildings.isInside === 'function') ? (G.Buildings.isInside(pl.pos) || null) : null;
    if (P.inInterior && pl.mounted) dismount(false);

    // gating
    const open = uiOpen(), typ = typing();
    const sailing = !!(G.Boats && G.Boats.sailing);
    const fishing = !!(G.Fishing && G.Fishing.state && G.Fishing.state !== 'idle');
    const controls = !open && !typ && pl.alive && !sailing && !fishing;
    const canLook = !open && !typ && !sailing;
    if (open && I && I.mouse.locked && typeof I.exitLock === 'function') I.exitLock();

    // camera input first (mouse steer must affect this frame's movement)
    cameraInput(dt, canLook);

    // right button held = block; the RMB camera drag keeps working meanwhile. This reads the button LEVEL
    // (I.mouseDown(2)), never the press edge: an edge that lands mid-frame is cleared by Input.endFrame() before any
    // update sees it, which at a low frame rate loses the guard entirely.
    if (I) S.rmbHeld = (_rmbRaw || I.mouseDown(2)) && !open && !typ;
    setBlocking(S.rmbHeld && controls && !S.rolling && !pl.mounted && !pl.swimming && !pl.casting && G.state.phase === 'playing');
    S.blockT = clamp(S.blockT + (pl.blocking ? dt / 0.12 : -dt / 0.15), 0, 1);

    // left button = select + attack, and the pointer-lock request. The press edge is taken from Input OR from a
    // level change we track ourselves, so a button still held across a slow frame boundary cannot be missed.
    let lmbEdge = false;
    if (I) { const dn = I.mouseDown(0); lmbEdge = I.mousePressed(0) || (dn && !S.lmbWas); S.lmbWas = dn; }
    if (I && lmbEdge && I.mouse.overCanvas && !open && !typ && G.state.phase === 'playing') {
      const picked = clickSelect(I.mouse.x, I.mouse.y);
      if (controls) clickAttack(picked);
      if (!I.mouse.locked && typeof I.requestLock === 'function') I.requestLock();
    }
    updateQueuedAttack();

    // key actions
    if (controls && I) {
      if (I.pressed('KeyQ')) dodgeRoll();
      if (I.pressed('KeyH')) toggleMount();
      if (I.pressed('KeyE')) interact();
      if (I.pressed('KeyR')) rangedAttack();
      if (I.pressed('Tab')) { tabTarget(); I.consume('Tab'); }
    }
    if (!typ && pl.alive && I) {
      for (let i = 0; i < hotbarCodes.length; i++) if (I.pressed(hotbarCodes[i])) { if (useHotbar(i)) I.consume(hotbarCodes[i]); }
      if (I.pressed('Escape') && !open) {
        if (pl.target) { setTarget(null); I.consume('Escape'); }
        else if (A.active) { autoStop(false); I.consume('Escape'); }
      }
    }
    if (!pl.alive && A.active) autoStop(false);
    if (!pl.alive && S.rolling) endRoll();
    if (!pl.alive && pl.mounted) dismount(true);
    if (sailing) { if (pl.mounted) dismount(true); }

    // movement + physics
    let actual = 0;
    if (!sailing) actual = stepMovement(dt, controls, canLook);
    const moving = (moveInput.x !== 0 || moveInput.z !== 0) && (actual > 0.3 || S.rolling);
    let fwdIn = 0;
    if (I && !A.active) { if (I.down('KeyW') || I.down('ArrowUp') || P.autoRun) fwdIn += 1; if (I.down('KeyS') || I.down('ArrowDown')) fwdIn -= 1; } else if (A.active) fwdIn = 1;
    updateYaw(dt, moving, fwdIn);
    placeRig();
    animate(dt);

    // ranged release timing (arrow leaves the hand at the top of the draw)
    if (S.rangedPending > 0) { S.rangedPending -= dt; if (S.rangedPending <= 0) { S.rangedPending = 0; releaseRanged(); } }

    // camera
    updateCamera(dt);

    // interaction prompt (10 Hz), zone (2 Hz), auto-loot
    S.interactT -= dt;
    if (S.interactT <= 0) { S.interactT = INTERACT_PERIOD; computeInteractTarget(); }
    S.zoneT -= dt;
    if (S.zoneT <= 0) { S.zoneT = ZONE_PERIOD; checkZone(false); }
    if (G.Combat && typeof G.Combat.tryAutoLoot === 'function') { try { G.Combat.tryAutoLoot(); } catch (e) { /* combat's problem */ } }
  }

  // ================================================================================================ EVENTS
  if (typeof G.on === 'function') {
    G.on('playerDeath', function () {
      if (!player) return;
      autoStop(false);
      if (S.rolling) endRoll();
      if (player.mounted) dismount(true);
      player.autoAttack = false; player.invulnerable = false;
      P.autoRun = false;
      stopGallop();
    });
    G.on('init', function () { buildHotbarCodes(); if (G.Game && G.Game.scene) scene = G.Game.scene; });
    G.on('sceneReady', function () { if (G.Game && G.Game.scene) scene = G.Game.scene; });
    G.on('equipChanged', function (ent) { if (ent && ent === player) computeStats(player); });
    G.on('load', function () { S.camSnap = true; S.pivotInit = false; });
  }

  function setScene(sc) { if (sc && sc.isScene) { scene = sc; if (player && player.mesh && !player.mesh.parent) sc.add(player.mesh); } return scene; }

  // ================================================================================================ PUBLIC API
  P.create = create;
  P.dispose = dispose;
  P.spawnAt = spawnAt;
  P.teleport = teleport;
  P.respawn = respawn;
  P.update = update;
  P.getForward = getForward;
  P.getRight = getRight;
  P.interact = interact;
  P.interactLabel = interactLabel;
  P.dodgeRoll = dodgeRoll;
  P.jump = jump;
  P.toggleMount = toggleMount;
  P.mount = mount;
  P.dismount = function () { return dismount(false); };
  P.canMount = canMount;
  P.rangedAttack = rangedAttack;
  P.setTarget = setTarget;
  P.tabTarget = tabTarget;
  P.clickSelect = clickSelect;
  P.isBusy = isBusy;
  P.headPos = headPos;
  P.handPos = handPos;
  P.rollCooldown = rollCooldown;
  P.autoMove = autoMove;
  P.autoStop = function () { autoStop(false); };
  P.setScene = setScene;
  P.resize = resize;
  P.snapCamera = snapCamera;
  P.computeStats = function () { return player ? computeStats(player) : null; };
  P.checkZone = function () { checkZone(false); };
  P.groundType = currentGroundType;
  P.setCameraDistance = function (d) { cam.targetDist = clamp(num(d, cam.targetDist), cam.minDist, cam.maxDist); if (G.state.settings) G.state.settings.cameraDist = cam.targetDist; S.settingDist = cam.targetDist; };
  P.useHotbar = useHotbar;
  P.attack = clickAttack;                    // LMB behaviour, callable (picked entity optional)
  P.setBlocking = setBlocking;               // RMB behaviour, callable (player.blocking)

  if (G.log) G.log('player module ready');
})();
