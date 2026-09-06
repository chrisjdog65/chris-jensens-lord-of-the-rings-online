/* ==== 15_physics.js — G.Physics: cheap, robust character physics for the whole world. Static colliders
   (axis-aligned boxes with an optional `floor` flag, vertical cylinders whose base sits on the terrain,
   and oriented wall segments) live in a 16 m spatial hash so every query only touches nearby shapes.
   Entities move as vertical capsules (`ent.pos.y` = feet) with sliding collision response, sub-stepping
   (no tunnelling at mount speed), smooth step-up of ledges ≤ 0.6 m, ceilings, gravity, analytic terrain
   with steep-slope sliding, shallow water / swimming, knockback impulses and world-bounds clamping.
   Also: raycast (adaptive terrain march + bisection, exact box/cylinder/wall intersection, allocation-free),
   camera occlusion clamp (padded sphere-cast), line of sight, arrow sweep, circle overlap queries,
   nearest-free-point search for spawns/teleports and a wireframe debug view for the admin panel.

   Public API (everything is defensive — bad/missing arguments return gracefully):
     init()                                             — idempotent; reads G.C, hooks the debug refresher
     addBox(minX,minY,minZ,maxX,maxY,maxZ, tag?)        — tag: string | {tag, floor:true, userData}; returns integer id
     addCylinder(x,z,radius,height, tag?)               — base y = G.Terrain.height(x,z) (sunk 1 m); returns id
     addWall(x1,z1,x2,z2,height,thickness, tag?)        — oriented box (base from terrain at the ends); returns id
     remove(id), clearTag(tag), get(id), list(), colliderCount()
     moveEntity(ent, desiredVel (Vector3-like; xz, y only when fly), dt, opts={fly,noclip})
        sets ent.onGround, inWater, swimming, sliding, justLanded (fall m/s, 0 otherwise), justSplashed,
        groundCollider (collider|null), waterDepth; updates ent.pos/ent.vel; decays ent.knockback {x,y,z}
     groundY(x,z, feetY?)  → walkable y (terrain ∨ box/wall tops; without feetY only `floor` colliders count);
                             G.Physics.lastGround = {y, collider} after each call
     terrainY(x,z)         → G.Terrain.height (0 without terrain)
     raycast(origin, dir, maxDist, opts={skipCylinders,skipTerrain,tag}) → {dist, point, normal, collider, terrain}|null (reused object)
     cameraClamp(target, desiredCamPos) → pooled Vector3 in front of walls/terrain (ignores cylinders = trees)
     lineOfSight(a, b)     → bool (terrain + all colliders)
     sweep(from, to, radius) → first hit of a moving sphere (arrows) | null (separate reused object)
     overlapCircle(x,z,r, minY?, maxY?) → reused array of colliders overlapping the circle
     isFree(x,z,r)         → bool (no blocking collider, not water, walkable slope, inside world)
     nearestFree(x,z,r)    → {x,z,y} nearby free point (spiral search, ≤ 48 m), original point if none
     debugMesh(scene)      → toggles wireframe colliders around the player (3 draw calls); returns the group
     STEP_HEIGHT, SLOPE_LIMIT, SWIM_DEPTH, CAM_PAD, WORLD_LIMIT (tunables), cameraIgnoresCylinders (bool)
   Assumes G.Terrain.height/normal/slope exist at runtime (falls back to flat ground otherwise). ==== */
(function () {
  'use strict';
  const G = window.G;

  // ---------------------------------------------------------------- tunables
  const CELL = 16, INV_CELL = 1 / CELL;
  const STEP_HEIGHT = 0.6;      // ledges up to this height are stepped onto instead of blocking
  const STEP_SPEED = 7;         // m/s at which the feet rise while stepping up (smooth, not a pop)
  const SNAP_DOWN = 0.45;       // stay glued to ground when it drops by at most this per step
  const SLOPE_LIMIT = 0.85;     // G.Terrain.slope above this → slide downhill
  const SLIDE_SPEED = 5.5;      // m/s downhill slide on steep terrain
  const SWIM_DEPTH = 1.2;       // water deeper than this → swimming
  const SWIM_RATIO = 0.55;      // feet sit at SEA − height·ratio while swimming
  const SHALLOW_SPEED = 0.7;    // walking speed multiplier in shallow water
  const CAM_PAD = 0.35;         // camera sphere radius
  const WORLD_LIMIT = 2040;
  const TERMINAL_VEL = -60;
  const MAX_SUBSTEPS = 8;
  const MAX_TERRAIN_Y = 900;    // an upward ray above this can never hit terrain
  const KNOCKBACK_DECAY = 5;    // per-second exponential decay of knockback impulses
  const T_BOX = 0, T_CYL = 1, T_WALL = 2;

  // ---------------------------------------------------------------- terrain access (defensive)
  function terrainH(x, z) { const T = G.Terrain; return (T && T.height) ? T.height(x, z) : 0; }
  const _tn = new THREE.Vector3();
  function terrainNormal(x, z, out) {
    const T = G.Terrain;
    if (T && T.normal) { T.normal(x, z, out); return out; }
    const e = 0.5;
    out.x = terrainH(x - e, z) - terrainH(x + e, z);
    out.y = 2 * e;
    out.z = terrainH(x, z - e) - terrainH(x, z + e);
    const l = Math.sqrt(out.x * out.x + out.y * out.y + out.z * out.z) || 1;
    out.x /= l; out.y /= l; out.z /= l;
    return out;
  }
  function terrainSlope(x, z) {
    const T = G.Terrain;
    if (T && T.slope) return T.slope(x, z);
    terrainNormal(x, z, _tn);
    return 1 - _tn.y;
  }
  function seaLevel() { const C = G.C; return (C && typeof C.SEA_LEVEL === 'number') ? C.SEA_LEVEL : 0; }
  function gravity() { const C = G.C; return (C && typeof C.GRAVITY === 'number') ? C.GRAVITY : -20; }

  // ---------------------------------------------------------------- collider store + spatial hash
  function Collider(id, type) {
    this.id = id; this.type = type; this.tag = null; this.floor = false; this.userData = null;
    this.minX = 0; this.minY = 0; this.minZ = 0; this.maxX = 0; this.maxY = 0; this.maxZ = 0; // AABB / hash bounds
    this.x = 0; this.z = 0; this.r = 0;                 // cylinder centre+radius, wall centre
    this.ax = 1; this.az = 0; this.hl = 0; this.ht = 0; // wall unit axis, half length, half thickness
    this._s = 0;                                        // query stamp (dedupe)
  }
  const cells = new Map();
  const byId = new Map();
  const byTag = new Map();
  let nextId = 1, count = 0, dirty = false;

  function ckey(cx, cz) { return (cx + 4096) * 8192 + (cz + 4096); }
  function hashInsert(c) {
    const cx0 = Math.floor(c.minX * INV_CELL), cx1 = Math.floor(c.maxX * INV_CELL);
    const cz0 = Math.floor(c.minZ * INV_CELL), cz1 = Math.floor(c.maxZ * INV_CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const k = ckey(cx, cz);
      let arr = cells.get(k);
      if (!arr) { arr = []; cells.set(k, arr); }
      arr.push(c);
    }
  }
  function hashRemove(c) {
    const cx0 = Math.floor(c.minX * INV_CELL), cx1 = Math.floor(c.maxX * INV_CELL);
    const cz0 = Math.floor(c.minZ * INV_CELL), cz1 = Math.floor(c.maxZ * INV_CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const k = ckey(cx, cz);
      const arr = cells.get(k);
      if (!arr) continue;
      const i = arr.indexOf(c);
      if (i >= 0) { arr[i] = arr[arr.length - 1]; arr.pop(); }
      if (arr.length === 0) cells.delete(k);
    }
  }
  function register(c, tagArg) {
    if (tagArg && typeof tagArg === 'object') {
      if (tagArg.tag !== undefined && tagArg.tag !== null) c.tag = String(tagArg.tag);
      if (tagArg.floor) c.floor = true;
      if (tagArg.userData !== undefined) c.userData = tagArg.userData;
    } else if (tagArg !== undefined && tagArg !== null) {
      c.tag = String(tagArg);
    }
    byId.set(c.id, c);
    if (c.tag !== null) {
      let set = byTag.get(c.tag);
      if (!set) { set = new Set(); byTag.set(c.tag, set); }
      set.add(c);
    }
    hashInsert(c);
    count++; dirty = true;
    return c.id;
  }
  function unregister(c) {
    hashRemove(c);
    byId.delete(c.id);
    if (c.tag !== null) {
      const set = byTag.get(c.tag);
      if (set) { set.delete(c); if (set.size === 0) byTag.delete(c.tag); }
    }
    count--; dirty = true;
  }
  function num(v, d) { return (typeof v === 'number' && isFinite(v)) ? v : d; }

  function addBox(minX, minY, minZ, maxX, maxY, maxZ, tag) {
    minX = num(minX, 0); minY = num(minY, 0); minZ = num(minZ, 0);
    maxX = num(maxX, minX); maxY = num(maxY, minY); maxZ = num(maxZ, minZ);
    if (maxX < minX) { const t = minX; minX = maxX; maxX = t; }
    if (maxY < minY) { const t = minY; minY = maxY; maxY = t; }
    if (maxZ < minZ) { const t = minZ; minZ = maxZ; maxZ = t; }
    const c = new Collider(nextId++, T_BOX);
    c.minX = minX; c.minY = minY; c.minZ = minZ; c.maxX = maxX; c.maxY = maxY; c.maxZ = maxZ;
    c.x = (minX + maxX) * 0.5; c.z = (minZ + maxZ) * 0.5;
    return register(c, tag);
  }
  function addCylinder(x, z, radius, height, tag) {
    x = num(x, 0); z = num(z, 0); radius = Math.max(0.02, num(radius, 0.3)); height = Math.max(0.05, num(height, 2));
    const base = terrainH(x, z);
    const c = new Collider(nextId++, T_CYL);
    c.x = x; c.z = z; c.r = radius;
    c.minY = base - 1; c.maxY = base + height;
    c.minX = x - radius; c.maxX = x + radius; c.minZ = z - radius; c.maxZ = z + radius;
    return register(c, tag);
  }
  function addWall(x1, z1, x2, z2, height, thickness, tag) {
    x1 = num(x1, 0); z1 = num(z1, 0); x2 = num(x2, x1); z2 = num(z2, z1);
    height = Math.max(0.05, num(height, 3)); thickness = Math.max(0.02, num(thickness, 0.3));
    let dx = x2 - x1, dz = z2 - z1;
    let len = Math.sqrt(dx * dx + dz * dz);
    if (len < 1e-6) { dx = 1; dz = 0; len = 1e-6; }
    const c = new Collider(nextId++, T_WALL);
    c.x = (x1 + x2) * 0.5; c.z = (z1 + z2) * 0.5;
    c.ax = dx / len; c.az = dz / len;
    c.hl = len * 0.5 + thickness * 0.5;   // extend by half thickness so corners of adjoining walls close
    c.ht = thickness * 0.5;
    const h1 = terrainH(x1, z1), h2 = terrainH(x2, z2);
    c.minY = Math.min(h1, h2) - 1; c.maxY = Math.max(h1, h2) + height;
    // xz bounds from the four corners
    const ex = Math.abs(c.ax * c.hl) + Math.abs(c.az * c.ht);
    const ez = Math.abs(c.az * c.hl) + Math.abs(c.ax * c.ht);
    c.minX = c.x - ex; c.maxX = c.x + ex; c.minZ = c.z - ez; c.maxZ = c.z + ez;
    return register(c, tag);
  }
  function remove(id) {
    const c = byId.get(id);
    if (!c) return false;
    unregister(c);
    return true;
  }
  function clearTag(tag) {
    const set = byTag.get(String(tag));
    if (!set) return 0;
    const arr = Array.from(set);
    for (let i = 0; i < arr.length; i++) unregister(arr[i]);
    return arr.length;
  }

  // ---------------------------------------------------------------- nearby-collider gathering (reused buffer)
  const near = [];
  let nearCount = 0, stamp = 0;
  function gather(minX, minZ, maxX, maxZ) {
    stamp++; nearCount = 0;
    const cx0 = Math.floor(minX * INV_CELL), cx1 = Math.floor(maxX * INV_CELL);
    const cz0 = Math.floor(minZ * INV_CELL), cz1 = Math.floor(maxZ * INV_CELL);
    for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) {
      const arr = cells.get(ckey(cx, cz));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i++) {
        const c = arr[i];
        if (c._s === stamp) continue;
        c._s = stamp;
        if (c.maxX < minX || c.minX > maxX || c.maxZ < minZ || c.minZ > maxZ) continue;
        near[nearCount++] = c;
      }
    }
    return nearCount;
  }

  // ---------------------------------------------------------------- 2D circle vs shape (push-out vector in pushX/pushZ)
  let pushX = 0, pushZ = 0;
  function circleVsBox(px, pz, r, c) {
    const qx = px < c.minX ? c.minX : (px > c.maxX ? c.maxX : px);
    const qz = pz < c.minZ ? c.minZ : (pz > c.maxZ ? c.maxZ : pz);
    const dx = px - qx, dz = pz - qz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) return false;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2), k = (r - d) / d;
      pushX = dx * k; pushZ = dz * k;
      return true;
    }
    // centre inside the box: leave through the nearest face
    const l = px - c.minX, rr = c.maxX - px, b = pz - c.minZ, t = c.maxZ - pz;
    let m = l; pushX = -(l + r); pushZ = 0;
    if (rr < m) { m = rr; pushX = rr + r; pushZ = 0; }
    if (b < m) { m = b; pushX = 0; pushZ = -(b + r); }
    if (t < m) { pushX = 0; pushZ = t + r; }
    return true;
  }
  function circleVsWall(px, pz, r, c) {
    const rx = px - c.x, rz = pz - c.z;
    const u = rx * c.ax + rz * c.az, v = -rx * c.az + rz * c.ax;
    const qu = u < -c.hl ? -c.hl : (u > c.hl ? c.hl : u);
    const qv = v < -c.ht ? -c.ht : (v > c.ht ? c.ht : v);
    const du = u - qu, dv = v - qv;
    const d2 = du * du + dv * dv;
    if (d2 >= r * r) return false;
    let lu, lv;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2), k = (r - d) / d;
      lu = du * k; lv = dv * k;
    } else {
      const pu = c.hl - Math.abs(u), pv = c.ht - Math.abs(v);
      if (pv <= pu) { lu = 0; lv = (v >= 0 ? 1 : -1) * (pv + r); }
      else { lu = (u >= 0 ? 1 : -1) * (pu + r); lv = 0; }
    }
    pushX = lu * c.ax - lv * c.az; pushZ = lu * c.az + lv * c.ax;
    return true;
  }
  function circleVsCyl(px, pz, r, c) {
    const dx = px - c.x, dz = pz - c.z, rr = r + c.r;
    const d2 = dx * dx + dz * dz;
    if (d2 >= rr * rr) return false;
    if (d2 > 1e-10) {
      const d = Math.sqrt(d2), k = (rr - d) / d;
      pushX = dx * k; pushZ = dz * k;
    } else { pushX = rr; pushZ = 0; }
    return true;
  }
  function circleVs(px, pz, r, c) {
    if (c.type === T_BOX) return circleVsBox(px, pz, r, c);
    if (c.type === T_CYL) return circleVsCyl(px, pz, r, c);
    return circleVsWall(px, pz, r, c);
  }
  // is the xz point within the footprint of a box/wall, inflated by `inner`?
  function xzInside(c, x, z, inner) {
    if (c.type === T_BOX) return x >= c.minX - inner && x <= c.maxX + inner && z >= c.minZ - inner && z <= c.maxZ + inner;
    if (c.type === T_WALL) {
      const rx = x - c.x, rz = z - c.z;
      const u = rx * c.ax + rz * c.az, v = -rx * c.az + rz * c.ax;
      return Math.abs(u) <= c.hl + inner && Math.abs(v) <= c.ht + inner;
    }
    const dx = x - c.x, dz = z - c.z, rr = c.r + inner;
    return dx * dx + dz * dz <= rr * rr;
  }

  // ---------------------------------------------------------------- ground / ceiling from the gathered set
  let gCollider = null;
  // Highest walkable surface under (x,z): terrain, or a box/wall top that is at most STEP_HEIGHT above the
  // feet (feetY given) — or, when feetY is undefined (teleport/spawn queries), any `floor` collider.
  function groundFrom(x, z, feetY, n, inner, th) {
    let best = th;
    gCollider = null;
    const anyFloor = feetY === undefined || feetY === null;
    const lim = anyFloor ? Infinity : feetY + STEP_HEIGHT;
    for (let i = 0; i < n; i++) {
      const c = near[i];
      if (c.type === T_CYL) continue;
      const top = c.maxY;
      if (top <= best || top > lim) continue;
      if (anyFloor && !c.floor) continue;
      if (!xzInside(c, x, z, inner)) continue;
      best = top; gCollider = c;
    }
    return best;
  }
  // Lowest box/wall underside above the head that the capsule would poke into; Infinity if none.
  function ceilingFrom(x, z, feet, top, n, inner) {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const c = near[i];
      if (c.type === T_CYL) continue;
      const bottom = c.minY;
      if (bottom <= feet + STEP_HEIGHT || bottom >= top || bottom >= best) continue;
      if (!xzInside(c, x, z, inner)) continue;
      best = bottom;
    }
    return best;
  }
  // Push the capsule's circle out of every blocking collider (those overlapping the body above the step
  // height). Three relaxation passes handle corners and gaps between adjacent shapes.
  function resolveHorizontal(pos, r, feet, top, n) {
    const lo = feet + STEP_HEIGHT;
    for (let it = 0; it < 3; it++) {
      let any = false;
      for (let i = 0; i < n; i++) {
        const c = near[i];
        if (c.maxY <= lo || c.minY >= top) continue;
        if (!circleVs(pos.x, pos.z, r, c)) continue;
        pos.x += pushX; pos.z += pushZ;
        any = true;
      }
      if (!any) break;
    }
  }

  // ---------------------------------------------------------------- moveEntity
  const _nv = new THREE.Vector3();
  function moveEntity(ent, desired, dt, opts) {
    if (!ent || !ent.pos) return;
    if (!ent.vel) ent.vel = new THREE.Vector3();
    const pos = ent.pos, vel = ent.vel;
    const r = (ent.radius > 0) ? ent.radius : 0.4;
    const h = (ent.height > 0) ? ent.height : 1.8;
    const fly = !!(opts && opts.fly), noclip = !!(opts && opts.noclip);
    if (!(dt > 0)) dt = 0; else if (dt > 0.1) dt = 0.1;
    const SEA = seaLevel(), GRAV = gravity();
    const inner = r * 0.5;
    ent.justLanded = 0; ent.justSplashed = 0;
    if (!isFinite(pos.x) || !isFinite(pos.y) || !isFinite(pos.z)) { pos.x = 0; pos.z = 0; pos.y = terrainH(0, 0); }

    let vx = desired ? (desired.x || 0) : 0;
    let vz = desired ? (desired.z || 0) : 0;
    let vy = vel.y || 0;

    // knockback impulse: applied on top of the desired velocity and decayed exponentially
    const kb = ent.knockback;
    if (kb && (kb.x || kb.y || kb.z)) {
      vx += kb.x; vz += kb.z;
      if (kb.y > 0) { if (vy < kb.y) vy = kb.y; kb.y = 0; ent.onGround = false; }
      const decay = Math.exp(-KNOCKBACK_DECAY * dt);
      kb.x *= decay; kb.z *= decay;
      if (kb.x * kb.x + kb.z * kb.z < 0.01) { kb.x = 0; kb.z = 0; }
    }

    // environment at the current position
    gather(pos.x - r - 1, pos.z - r - 1, pos.x + r + 1, pos.z + r + 1);
    const th0 = terrainH(pos.x, pos.z);
    let ground = noclip ? th0 : groundFrom(pos.x, pos.z, pos.y, nearCount, inner, th0);
    const onFloor0 = !noclip && gCollider !== null;
    const depth = SEA - th0;
    const swimLevel = SEA - h * SWIM_RATIO;
    let inWater = false, swimming = false, moving = (vx !== 0 || vz !== 0);
    if (!fly && !onFloor0 && depth > 0 && pos.y < SEA + 0.02) {
      inWater = true;
      if (depth >= SWIM_DEPTH && pos.y <= swimLevel + 0.2 && vy <= 0.01) {
        swimming = true;
        if (!ent.swimming && vy < -2) ent.justSplashed = -vy;
      }
    }
    if (swimming) {
      const k = 1 - Math.exp(-5 * dt);              // sluggish response in water
      vx = vel.x + (vx - vel.x) * k;
      vz = vel.z + (vz - vel.z) * k;
      vy = (swimLevel - pos.y) * 6;                 // settle onto the swim line, gravity off
      if (vy < -3) vy = -3; else if (vy > 3) vy = 3;
      moving = true;
    } else if (inWater) {
      vx *= SHALLOW_SPEED; vz *= SHALLOW_SPEED;
    }
    if (fly) vy = (desired && typeof desired.y === 'number') ? desired.y : 0;
    else if (!swimming) { vy += GRAV * dt; if (vy < TERMINAL_VEL) vy = TERMINAL_VEL; }
    vel.x = vx; vel.z = vz; vel.y = vy;

    // sub-step so no single move exceeds ~0.9 radius (prevents tunnelling through thin walls)
    const speed = Math.sqrt(vx * vx + vz * vz + vy * vy);
    let steps = Math.ceil(speed * dt / (r * 0.9));
    if (steps < 1) steps = 1; else if (steps > MAX_SUBSTEPS) steps = MAX_SUBSTEPS;
    const sdt = dt / steps;
    let onGround = !!ent.onGround, sliding = false, landed = 0, groundCol = null, slideCheck = moving || !!ent.sliding;

    for (let s = 0; s < steps; s++) {
      const feet0 = pos.y;
      pos.x += vel.x * sdt; pos.z += vel.z * sdt;
      if (pos.x < -WORLD_LIMIT) pos.x = -WORLD_LIMIT; else if (pos.x > WORLD_LIMIT) pos.x = WORLD_LIMIT;
      if (pos.z < -WORLD_LIMIT) pos.z = -WORLD_LIMIT; else if (pos.z > WORLD_LIMIT) pos.z = WORLD_LIMIT;
      gather(pos.x - r - 1, pos.z - r - 1, pos.x + r + 1, pos.z + r + 1);
      if (!noclip) resolveHorizontal(pos, r, feet0, feet0 + h, nearCount);

      pos.y += vel.y * sdt;
      const th = terrainH(pos.x, pos.z);
      if (noclip) { ground = th; gCollider = null; }
      else ground = groundFrom(pos.x, pos.z, feet0, nearCount, inner, th);
      groundCol = gCollider;

      if (fly) { onGround = false; continue; }
      if (swimming) {
        if (pos.y < ground) pos.y = ground;
        onGround = false;
        continue;
      }
      if (pos.y <= ground) {
        if (!onGround && vel.y < -2) landed = -vel.y;
        const rise = ground - feet0;
        if (onGround && rise > 0.04) {
          const maxRise = STEP_SPEED * sdt;
          pos.y = rise > maxRise ? feet0 + maxRise : ground;   // smooth step-up
        } else pos.y = ground;
        vel.y = 0; onGround = true;
      } else if (onGround && vel.y <= 0 && pos.y - ground <= SNAP_DOWN) {
        pos.y = ground; vel.y = 0;                            // glued to ground walking downhill
      } else {
        onGround = false;
      }
      if (vel.y > 0 && !noclip) {                             // head against a ceiling / box underside
        const ceil = ceilingFrom(pos.x, pos.z, pos.y, pos.y + h, nearCount, r * 0.6);
        if (ceil !== Infinity) { pos.y = ceil - h; vel.y = 0; }
      }
      if (onGround && groundCol === null && slideCheck && terrainSlope(pos.x, pos.z) > SLOPE_LIMIT) {
        terrainNormal(pos.x, pos.z, _nv);
        let nx = _nv.x, nz = _nv.z;
        const nl = Math.sqrt(nx * nx + nz * nz);
        if (nl > 1e-4) {
          nx /= nl; nz /= nl;
          const up = vel.x * nx + vel.z * nz;                 // strip any uphill component of the walk
          if (up < 0) { vel.x -= up * nx; vel.z -= up * nz; }
          pos.x += nx * SLIDE_SPEED * sdt; pos.z += nz * SLIDE_SPEED * sdt;
          if (pos.x < -WORLD_LIMIT) pos.x = -WORLD_LIMIT; else if (pos.x > WORLD_LIMIT) pos.x = WORLD_LIMIT;
          if (pos.z < -WORLD_LIMIT) pos.z = -WORLD_LIMIT; else if (pos.z > WORLD_LIMIT) pos.z = WORLD_LIMIT;
          pos.y = terrainH(pos.x, pos.z);
          sliding = true;
        }
      }
    }

    ent.onGround = onGround;
    ent.inWater = inWater;
    ent.swimming = swimming;
    ent.sliding = sliding;
    ent.justLanded = landed;
    ent.groundCollider = groundCol;
    ent.waterDepth = inWater ? Math.max(0, SEA - pos.y) : 0;
    const S = G.Spatial;
    if (S && S.update) S.update(ent);
  }

  // ---------------------------------------------------------------- ray vs shapes (results in hT / hN*)
  let hT = 0, hNx = 0, hNy = 1, hNz = 0;
  function rayBox(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ, tMax) {
    let t0 = 0, t1 = tMax, axis = -1, sign = -1;
    if (dx > -1e-9 && dx < 1e-9) { if (ox < minX || ox > maxX) return false; }
    else {
      const inv = 1 / dx; let ta = (minX - ox) * inv, tb = (maxX - ox) * inv, s = -1;
      if (ta > tb) { const t = ta; ta = tb; tb = t; s = 1; }
      if (ta > t0) { t0 = ta; axis = 0; sign = s; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    if (dy > -1e-9 && dy < 1e-9) { if (oy < minY || oy > maxY) return false; }
    else {
      const inv = 1 / dy; let ta = (minY - oy) * inv, tb = (maxY - oy) * inv, s = -1;
      if (ta > tb) { const t = ta; ta = tb; tb = t; s = 1; }
      if (ta > t0) { t0 = ta; axis = 1; sign = s; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    if (dz > -1e-9 && dz < 1e-9) { if (oz < minZ || oz > maxZ) return false; }
    else {
      const inv = 1 / dz; let ta = (minZ - oz) * inv, tb = (maxZ - oz) * inv, s = -1;
      if (ta > tb) { const t = ta; ta = tb; tb = t; s = 1; }
      if (ta > t0) { t0 = ta; axis = 2; sign = s; }
      if (tb < t1) t1 = tb;
      if (t0 > t1) return false;
    }
    hT = t0;
    if (axis === 0) { hNx = sign; hNy = 0; hNz = 0; }
    else if (axis === 1) { hNx = 0; hNy = sign; hNz = 0; }
    else if (axis === 2) { hNx = 0; hNy = 0; hNz = sign; }
    else { hNx = -dx; hNy = -dy; hNz = -dz; }      // origin inside: face the ray back
    return true;
  }
  function rayCyl(ox, oy, oz, dx, dy, dz, c, tMax, inflate) {
    const R = c.r + inflate, minY = c.minY - inflate, maxY = c.maxY + inflate;
    const fx = ox - c.x, fz = oz - c.z;
    const a = dx * dx + dz * dz, b = 2 * (fx * dx + fz * dz), k = fx * fx + fz * fz - R * R;
    let best = Infinity, kind = 0;                 // kind 0 side, 1 top, 2 bottom
    if (k < 0 && oy >= minY && oy <= maxY) {       // origin inside the cylinder
      hT = 0; hNx = -dx; hNy = -dy; hNz = -dz; return true;
    }
    if (a > 1e-9) {
      const disc = b * b - 4 * a * k;
      if (disc >= 0) {
        const sq = Math.sqrt(disc);
        let t = (-b - sq) / (2 * a);
        if (t < 0) t = (-b + sq) / (2 * a);
        if (t >= 0 && t <= tMax) {
          const y = oy + dy * t;
          if (y >= minY && y <= maxY) { best = t; kind = 0; }
        }
      }
    }
    if (dy < -1e-9 || dy > 1e-9) {
      const capY = dy < 0 ? maxY : minY;
      const t = (capY - oy) / dy;
      if (t >= 0 && t <= tMax && t < best) {
        const px = ox + dx * t - c.x, pz = oz + dz * t - c.z;
        if (px * px + pz * pz <= R * R) { best = t; kind = dy < 0 ? 1 : 2; }
      }
    }
    if (best === Infinity) return false;
    hT = best;
    if (kind === 0) {
      const px = ox + dx * best - c.x, pz = oz + dz * best - c.z;
      const l = Math.sqrt(px * px + pz * pz) || 1;
      hNx = px / l; hNy = 0; hNz = pz / l;
    } else { hNx = 0; hNy = kind === 1 ? 1 : -1; hNz = 0; }
    return true;
  }
  function rayWall(ox, oy, oz, dx, dy, dz, c, tMax, inflate) {
    const rx = ox - c.x, rz = oz - c.z;
    const ou = rx * c.ax + rz * c.az, ov = -rx * c.az + rz * c.ax;
    const du = dx * c.ax + dz * c.az, dv = -dx * c.az + dz * c.ax;
    if (!rayBox(ou, oy, ov, du, dy, dv, -c.hl - inflate, c.minY - inflate, -c.ht - inflate, c.hl + inflate, c.maxY + inflate, c.ht + inflate, tMax)) return false;
    const nu = hNx, nv = hNz;
    hNx = nu * c.ax - nv * c.az; hNz = nu * c.az + nv * c.ax;
    return true;
  }
  function rayCollider(ox, oy, oz, dx, dy, dz, c, tMax, inflate) {
    if (c.type === T_BOX) return rayBox(ox, oy, oz, dx, dy, dz, c.minX - inflate, c.minY - inflate, c.minZ - inflate, c.maxX + inflate, c.maxY + inflate, c.maxZ + inflate, tMax);
    if (c.type === T_CYL) return rayCyl(ox, oy, oz, dx, dy, dz, c, tMax, inflate);
    return rayWall(ox, oy, oz, dx, dy, dz, c, tMax, inflate);
  }

  // ---------------------------------------------------------------- generic cast (colliders via cell DDA + terrain march)
  function makeHit() { return { dist: 0, point: new THREE.Vector3(), normal: new THREE.Vector3(0, 1, 0), collider: null, terrain: false }; }
  const hitA = makeHit(), hitB = makeHit();
  let bestT = 0, bestC = null, bestNx = 0, bestNy = 1, bestNz = 0;

  function castColliders(ox, oy, oz, dx, dy, dz, maxDist, inflate, skipCyl, tag) {
    stamp++;
    const inf = inflate + 0.01;
    let cx = Math.floor(ox * INV_CELL), cz = Math.floor(oz * INV_CELL);
    const stepX = dx > 1e-9 ? 1 : (dx < -1e-9 ? -1 : 0), stepZ = dz > 1e-9 ? 1 : (dz < -1e-9 ? -1 : 0);
    const adx = Math.abs(dx), adz = Math.abs(dz);
    let tMaxX = stepX === 0 ? Infinity : (stepX > 0 ? ((cx + 1) * CELL - ox) : (ox - cx * CELL)) / adx;
    let tMaxZ = stepZ === 0 ? Infinity : (stepZ > 0 ? ((cz + 1) * CELL - oz) : (oz - cz * CELL)) / adz;
    const tDX = stepX === 0 ? Infinity : CELL / adx, tDZ = stepZ === 0 ? Infinity : CELL / adz;
    // inflated casts also need the neighbouring cells; visit a 3×3 block around the DDA cell when inflated
    const ring = inf > 0.02 ? 1 : 0;
    let guard = 0;
    for (;;) {
      for (let ix = -ring; ix <= ring; ix++) for (let iz = -ring; iz <= ring; iz++) {
        const arr = cells.get(ckey(cx + ix, cz + iz));
        if (!arr) continue;
        for (let i = 0; i < arr.length; i++) {
          const c = arr[i];
          if (c._s === stamp) continue;
          c._s = stamp;
          if (skipCyl && c.type === T_CYL) continue;
          if (tag !== null && c.tag !== tag) continue;
          if (!rayCollider(ox, oy, oz, dx, dy, dz, c, bestT, inflate)) continue;
          if (hT < bestT) { bestT = hT; bestC = c; bestNx = hNx; bestNy = hNy; bestNz = hNz; }
        }
      }
      let t;
      if (tMaxX < tMaxZ) { t = tMaxX; cx += stepX; tMaxX += tDX; }
      else { t = tMaxZ; cz += stepZ; tMaxZ += tDZ; }
      if (t - inf > bestT || t > maxDist || ++guard > 1024) break;
    }
  }
  // March along the ray with steps proportional to the clearance above the ground (0.5–4 m), then bisect.
  function castTerrain(ox, oy, oz, dx, dy, dz, maxDist, offset) {
    const T = G.Terrain;
    if (!T || !T.height) return false;
    let h = T.height(ox, oz);
    let prevAbove = oy - offset - h;
    if (prevAbove <= 0) { bestT = 0; bestC = null; bestNx = 0; bestNy = 1; bestNz = 0; return true; }
    let prevT = 0, t = 0;
    const limit = Math.min(maxDist, bestT);
    while (t < limit) {
      let step = prevAbove * 0.6;
      if (step < 0.5) step = 0.5; else if (step > 4) step = 4;
      t += step;
      if (t > limit) t = limit;
      const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
      if (dy > 0 && py > MAX_TERRAIN_Y) return false;
      h = T.height(px, pz);
      const above = py - offset - h;
      if (above < 0) {
        let lo = prevT, hi = t;
        for (let i = 0; i < 7; i++) {
          const mid = (lo + hi) * 0.5;
          const my = oy + dy * mid - offset - T.height(ox + dx * mid, oz + dz * mid);
          if (my < 0) hi = mid; else lo = mid;
        }
        bestT = lo; bestC = null;
        terrainNormal(ox + dx * lo, oz + dz * lo, _tn);
        bestNx = _tn.x; bestNy = _tn.y; bestNz = _tn.z;
        return true;
      }
      if (t >= limit) break;
      prevT = t; prevAbove = above;
    }
    return false;
  }
  function cast(ox, oy, oz, dx, dy, dz, maxDist, inflate, skipCyl, skipTerrain, tag, out) {
    bestT = maxDist; bestC = null;
    let hit = false;
    if (count > 0) { castColliders(ox, oy, oz, dx, dy, dz, maxDist, inflate, skipCyl, tag); hit = bestT < maxDist; }
    let terrainHit = false;
    if (!skipTerrain) { terrainHit = castTerrain(ox, oy, oz, dx, dy, dz, maxDist, inflate); hit = hit || terrainHit; }
    if (!hit) return false;
    out.dist = bestT;
    out.point.set(ox + dx * bestT, oy + dy * bestT, oz + dz * bestT);
    out.normal.set(bestNx, bestNy, bestNz);
    out.collider = bestC;
    out.terrain = terrainHit && bestC === null;
    return true;
  }

  // ---------------------------------------------------------------- public casts
  function raycast(origin, dir, maxDist, opts) {
    if (!origin || !dir) return null;
    let dx = dir.x || 0, dy = dir.y || 0, dz = dir.z || 0;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(l > 1e-9)) return null;
    dx /= l; dy /= l; dz /= l;
    if (!(maxDist > 0)) maxDist = 1000;
    const skipCyl = !!(opts && opts.skipCylinders), skipTerrain = !!(opts && opts.skipTerrain);
    const tag = (opts && opts.tag !== undefined && opts.tag !== null) ? String(opts.tag) : null;
    return cast(origin.x, origin.y, origin.z, dx, dy, dz, maxDist, 0, skipCyl, skipTerrain, tag, hitA) ? hitA : null;
  }
  function sweep(from, to, radius) {
    if (!from || !to) return null;
    let dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(l > 1e-9)) return null;
    dx /= l; dy /= l; dz /= l;
    const r = (radius > 0) ? radius : 0;
    return cast(from.x, from.y, from.z, dx, dy, dz, l, r, false, false, null, hitB) ? hitB : null;
  }
  function lineOfSight(a, b) {
    if (!a || !b) return false;
    let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const l = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (l < 0.05) return true;
    dx /= l; dy /= l; dz /= l;
    return !cast(a.x, a.y, a.z, dx, dy, dz, l - 0.02, 0, false, false, null, hitB);
  }
  const _camOut = new THREE.Vector3();
  let cameraIgnoresCylinders = true;
  function cameraClamp(target, desired) {
    if (!target) { _camOut.set(0, 0, 0); return _camOut; }
    if (!desired) { _camOut.copy(target); return _camOut; }
    let dx = desired.x - target.x, dy = desired.y - target.y, dz = desired.z - target.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (!(len > 1e-6)) { _camOut.set(desired.x, desired.y, desired.z); return _camOut; }
    dx /= len; dy /= len; dz /= len;
    let d = len;
    if (cast(target.x, target.y, target.z, dx, dy, dz, len + CAM_PAD, CAM_PAD, cameraIgnoresCylinders, false, null, hitB)) {
      d = hitB.dist - CAM_PAD;
      if (d < 0.5) d = 0.5;
      if (d > len) d = len;
    }
    _camOut.set(target.x + dx * d, target.y + dy * d, target.z + dz * d);
    const floor = terrainH(_camOut.x, _camOut.z) + CAM_PAD;
    if (_camOut.y < floor) _camOut.y = floor;
    return _camOut;
  }
