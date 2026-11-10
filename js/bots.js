// Bot tanks: roaming rogues that hunt everyone, and squad tanks that follow a commander or defend a post.
'use strict';

const BOT = {
  SIGHT: 85,            // how far a bot can spot a target
  DISABLE_FRAC: 0.4,    // a roaming tank at or below this share of its armour is knocked out (recruitable)
  RECRUIT_RANGE: 10,
  SHELL_SPEED: 150,
};
const NO_GOAL = [null, 0];

class Bot {
  constructor(tank) {
    this.tank = tank;
    tank.bot = this;
    this.faction = null;      // null = rogue
    this.leader = null;       // commander tank a squad bot follows
    this.spread = 2.4;        // aiming error
    this.lead = false;        // aim ahead of a moving target
    this.keys = {};
    this.aim = [0, 0, 0];
    this.err = [0, 0, 0];
    this.target = null; this.los = false;
    this.thinkT = Math.random() * 0.3;
    this.wp = null; this.wpT = 0;
    this.order = 'follow'; this.post = null; this.slot = 0; this.followers = 1;
    this.disabledT = 0;
    this.path = null; this.pathGoal = null; this.pathI = 0; this.pathT = 0;
    this.avoidT = 0; this.avoidTurn = 1; this.avoidRev = true;
    this.stuckT = 0; this.lastX = tank.x; this.lastZ = tank.z; this.lastYaw = tank.yaw;
    this.progT = 0; this.progX = tank.x; this.progZ = tank.z;
    this._rollErr();
  }

  _rollErr() {
    const s = this.spread;
    this.err = [(Math.random() - 0.5) * 2 * s, (Math.random() - 0.5) * s, (Math.random() - 0.5) * 2 * s];
  }

  // Put a knocked-out tank back on its feet in faction F's squad.
  recruit(F) {
    const T = this.tank;
    T.setTeam(F.squadTeam);
    T.disabled = false;
    T.hp = Math.max(T.hp, T.maxHp * 0.75);
    T.reloadTime = 2.8;
    this.faction = F; this.leader = F.cmd;
    this.spread = 1.4;
    this.order = 'follow'; this.post = null;
    this.target = null; this.los = false; this.wp = null; this.path = null;
    this._rollErr();
  }

  setOrder(order, post) { this.order = order; this.post = post || null; }

  _frozen() { return false; }

  // Pick the nearest hostile and check whether the gun can see it.
  _think(G) {
    const T = this.tank;
    let best = null, bd = BOT.SIGHT;
    for (const e of G.ents) {
      if (e.side === T.side || e.disabled || !e.alive) continue;
      const d = Math.hypot(e.x - T.x, e.z - T.z);
      if (d < bd) { bd = d; best = e; }
    }
    this.target = best; this.los = false;
    if (best) {
      const p = best.hitPos(), o = T.gunPivot;
      const vx = p[0] - o[0], vy = p[1] - o[1], vz = p[2] - o[2];
      const d = Math.hypot(vx, vy, vz) || 1;
      const hit = G.world.raycast(o[0], o[1], o[2], vx / d, vy / d, vz / d, d, true, true);
      this.los = !hit || hit.t > d - 2.6;
    }
  }

  _wander(dt, G) {
    const T = this.tank;
    this.wpT -= dt;
    if (this.wp && this.wpT > 0 && Math.hypot(this.wp[0] - T.x, this.wp[1] - T.z) > 7) return;
    // now and then drift toward one of the commanders
    const c = G.cmds.length && Math.random() < 0.35 ? G.cmds[Math.random() * G.cmds.length | 0] : null;
    this.wp = c ? G.nav.randomNear(c.x, c.z, 15, 55) : G.nav.randomNear(T.x, T.z, 35, 100);
    this.wpT = this.wp ? 30 : 2;
  }

  // Where this bot wants to be: [[x, z] or null, stop distance]
  _goal(dt, G, tg) {
    const T = this.tank;
    if (this.faction) {
      if (this.order === 'defend' && this.post) return [this.post, 2.5];
      const L = this.leader;
      if (!L || !L.alive) { const h = this.faction.home; return [[h.x + 0.5, h.z - 6.5], 8]; }
      // formation behind the leader: rows of five
      const row = Math.floor(this.slot / 5), col = this.slot % 5, inRow = Math.min(5, this.followers - row * 5);
      const a = L.yaw + Math.PI + (col - (inRow - 1) / 2) * 0.55, r = 10 + row * 6;
      return [[L.x + Math.sin(a) * r, L.z + Math.cos(a) * r], 3.5];
    }
    if (tg) {
      if (!this.los) return [[tg.x, tg.z], 12];
      if (Math.hypot(tg.x - T.x, tg.z - T.z) > 42) return [[tg.x, tg.z], 38];
      return NO_GOAL;
    }
    this._wander(dt, G);
    return [this.wp, 6];
  }

  // The point to steer at right now on the way to goal: the next waypoint of a route round obstacles.
  _steer(dt, G, goal) {
    const T = this.tank, nav = G.nav;
    this.pathT -= dt;
    const d = Math.hypot(goal[0] - T.x, goal[1] - T.z);
    if (d < 12 && nav.clearLine(T.x, T.z, goal[0], goal[1])) return goal;
    const shifted = !this.pathGoal || Math.hypot(goal[0] - this.pathGoal[0], goal[1] - this.pathGoal[1]) > Math.max(6, d * 0.25);
    if ((this.pathT <= 0 || shifted) && G.pathBudget > 0) {
      G.pathBudget--;
      this.path = nav.path(T.x, T.z, goal[0], goal[1]);
      this.pathGoal = [goal[0], goal[1]]; this.pathI = 0; this.pathT = 4 + Math.random() * 3;
    }
    const p = this.path;
    if (!p) return goal;
    while (this.pathI < p.length - 1 && Math.hypot(p[this.pathI][0] - T.x, p[this.pathI][1] - T.z) < 3.5) this.pathI++;
    const w = p[this.pathI];
    if (this.pathI === p.length - 1 && Math.hypot(w[0] - T.x, w[1] - T.z) < 3.5) { this.pathT = 0; return goal; }
    return w;
  }

  _mark() { const T = this.tank; this.stuckT = 0; this.lastX = T.x; this.lastZ = T.z; this.lastYaw = T.yaw; }

  // Steer toward target [x, z]. If it is trying to move or turn and getting nowhere (wedged against
  // something) it backs or pushes out on a swing, then plans a fresh route.
  _drive(dt, target) {
    const T = this.tank, k = this.keys;
    if (this.avoidT > 0) {
      this.avoidT -= dt;
      if ((this.avoidT > 1.2) === this.avoidRev) k.KeyS = true; else k.KeyW = true;
      k[this.avoidTurn > 0 ? 'KeyA' : 'KeyD'] = true;
      if (this.avoidT <= 0) { this._mark(); this.pathT = 0; }
      return;
    }
    if (!target) { this._mark(); return; }
    const diff = wrapAngle(Math.atan2(target[0] - T.x, target[1] - T.z) - T.yaw);
    if (diff > 0.08) k.KeyA = true; else if (diff < -0.08) k.KeyD = true;
    if (Math.abs(diff) < 0.9) k.KeyW = true;
    this.stuckT += dt;
    if (this.stuckT > 1.2) {
      const moved = Math.hypot(T.x - this.lastX, T.z - this.lastZ), turned = Math.abs(wrapAngle(T.yaw - this.lastYaw));
      if (moved < 0.6 && turned < 0.15) {
        this.avoidT = 2.2; this.avoidTurn = Math.random() < 0.5 ? 1 : -1; this.avoidRev = Math.random() < 0.7;
      }
      this._mark();
    }
  }

  // G: { world, nav, effects, ents, cmds, crates, pathBudget, farFromView(tank), api }
  update(dt, G) {
    const T = this.tank, k = this.keys, aim = this.aim;
    k.KeyW = k.KeyS = k.KeyA = k.KeyD = false;

    if (T.disabled) {
      this.disabledT -= dt;
      if (Math.random() < dt * 7) G.effects.smoke([T.x, T.y + 2.2, T.z]);
      if (this.disabledT <= 0) { T.disabled = false; T.hp = Math.max(T.hp, T.maxHp * 0.6); }
      T.update(dt, k, null);
      return;
    }
    if (this._frozen()) {       // commander repairing: can't move or shoot
      T.update(dt, k, null);
      return;
    }

    this.thinkT -= dt;
    if (this.thinkT <= 0) { this.thinkT = 0.3; this._think(G); }
    const tg = this.target && this.target.alive && !this.target.disabled ? this.target : null;

    // ---- movement
    const gs = this._goal(dt, G, tg), goal = gs[0];
    const want = !!goal && Math.hypot(goal[0] - T.x, goal[1] - T.z) >= gs[1];
    this._drive(dt, want ? this._steer(dt, G, goal) : null);

    // last resort for a bot that has been trying to get somewhere for a long while and hasn't budged:
    // if nobody is looking, hop it to open ground nearby
    if (want) {
      this.progT += dt;
      if (this.progT > 12) {
        if (Math.hypot(T.x - this.progX, T.z - this.progZ) < 4 && G.farFromView(T)) {
          const c = G.nav.randomNear(T.x, T.z, 8, 22);
          if (c) { T.teleport(c[0], c[1]); this.path = null; this.pathT = 0; }
        }
        this.progT = 0; this.progX = T.x; this.progZ = T.z;
      }
    } else { this.progT = 0; this.progX = T.x; this.progZ = T.z; }

    // ---- gun
    if (tg) {
      const p = tg.hitPos(), o = T.gunPivot;
      const d = Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2]);
      const tof = d / BOT.SHELL_SPEED, s = d / 50, e = this.err;
      if (this.lead && tg.speed) { p[0] += Math.sin(tg.yaw) * tg.speed * tof; p[2] += Math.cos(tg.yaw) * tg.speed * tof; }
      aim[0] = p[0] + e[0] * s; aim[1] = p[1] + 4.9 * tof * tof + e[1] * s; aim[2] = p[2] + e[2] * s;
      T.update(dt, k, aim);
      if (this.los && T.reload <= 0) {
        const v = V3.norm(V3.sub(aim, T.gunPivot));
        if (V3.dot(v, T.gf) > 0.9993) {
          const shot = T.fire();
          if (shot) { G.effects.muzzleFlash(shot.pos, shot.dir); G.effects.fireShell(shot.pos, shot.dir, T.side, BOT.SHELL_SPEED, T.dmgMul || 1); this._rollErr(); }
        }
      }
    } else {
      aim[0] = T.x + T.f[0] * 30; aim[1] = T.y + 2.2; aim[2] = T.z + T.f[2] * 30;   // gun back to front
      T.update(dt, k, aim);
    }
  }
}

// A dry, roughly level, uncluttered spot between rMin and rMax from (cx, cz). Returns {x, y, z} or null.
function findOpenSpot(world, cx, cz, rMin, rMax, rnd = Math.random) {
  for (let i = 0; i < 80; i++) {
    const a = rnd() * Math.PI * 2, r = rMin + rnd() * (rMax - rMin);
    const x = Math.floor(cx + Math.sin(a) * r) + 0.5, z = Math.floor(cz + Math.cos(a) * r) + 0.5;
    if (x < 36 || z < 36 || x > world.sx - 36 || z > world.sz - 36) continue;
    const g = world.groundAt(x, z, world.sy);
    if (g.h <= WATER_LEVEL || g.id === BL.WATER || g.id === BL.WOOD || g.id === BL.BRICK || g.id === BL.CONCRETE || g.id === BL.STEEL) continue;
    let ok = true;
    for (const [dx, dz] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, -2], [2, -2], [-2, 2]]) {
      const n = world.groundAt(x + dx, z + dz, world.sy);
      if (Math.abs(n.h - g.h) > 1 || n.id === BL.WATER) { ok = false; break; }
    }
    if (ok) return { x, y: g.h, z };
  }
  return null;
}
