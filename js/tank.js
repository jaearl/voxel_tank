// Tank (player and bots): voxel model, driving physics, terrain following, turret/gun aiming.
'use strict';

const TANK_VOX = 0.2; // size of one tank voxel in world units (world blocks are 1.0)
const TANK_PAL = {
  1: [98, 112, 60],   // body olive
  2: [68, 78, 42],    // dark olive
  3: [46, 44, 42],    // track
  4: [92, 92, 86],    // road wheel
  5: [28, 28, 26],    // black
  6: [122, 134, 76],  // light olive
  7: [80, 90, 52],    // barrel
  8: [235, 225, 170], // headlight
  9: [112, 84, 52],   // wood / stowage
};

// Per-team repaint of the body colours
const TEAM_PALS = {
  player: {},
  enemy: { 1: [152, 112, 74], 2: [112, 78, 52], 6: [180, 140, 96], 7: [124, 90, 60] },
  ally: { 1: [74, 106, 132], 2: [52, 76, 98], 6: [102, 136, 164], 7: [62, 90, 114] },
  redcmd: { 1: [150, 46, 40], 2: [104, 30, 28], 6: [186, 70, 58], 7: [120, 36, 32] },
  redsquad: { 1: [176, 88, 74], 2: [128, 60, 52], 6: [204, 118, 100], 7: [146, 70, 60] },
};
// blue = you and your squad, red = the enemy commander's side, rogue = roaming tanks (hostile to everyone)
const TEAM_SIDE = { player: 'blue', ally: 'blue', enemy: 'rogue', redcmd: 'red', redsquad: 'red' };

// Ground sample points in hull-local (x = side, z = forward)
const TANK_SAMPLES = [
  [-1.4, 2.5], [0, 2.6], [1.4, 2.5],
  [-1.4, -2.5], [0, -2.6], [1.4, -2.5],
  [1.5, -1.2], [1.5, 1.2], [-1.5, -1.2], [-1.5, 1.2], [0, 0],
];

function buildHullModel() {
  const m = new VoxModel(17, 7, 28);
  // tracks (both sides)
  for (const s of [0, 13]) {
    m.box(s, 1, 1, s + 3, 4, 26, 3);
    m.box(s, 0, 3, s + 3, 0, 24, 3);
    m.box(s, 2, 0, s + 3, 3, 0, 3);
    m.box(s, 2, 27, s + 3, 3, 27, 3);
    const ox = s === 0 ? 0 : 16;
    for (let wz = 3; wz <= 23; wz += 4) m.box(ox, 1, wz, ox, 2, wz + 1, 4);
    m.box(ox, 2, 25, ox, 3, 26, 4); // drive sprocket
    m.box(ox, 2, 1, ox, 3, 2, 4);   // idler
    m.box(s, 5, 0, s + 3, 5, 27, 2); // fender
  }
  // lower hull
  m.box(4, 1, 2, 12, 5, 21, 1);
  // sloped glacis
  for (let z = 22; z <= 26; z++) {
    const top = 5 - (z - 22);
    if (top >= 1) m.box(4, 1, z, 12, top, z, z === 22 ? 6 : 1);
  }
  // upper hull deck over tracks
  m.box(1, 6, 3, 15, 6, 21, 1);
  m.box(4, 6, 2, 12, 6, 22, 1);
  // rear plate & exhausts
  m.box(4, 1, 1, 12, 5, 1, 2);
  m.box(5, 4, 0, 6, 4, 0, 5); m.box(10, 4, 0, 11, 4, 0, 5);
  // engine grille
  for (let z = 3; z <= 8; z++) m.box(5, 6, z, 11, 6, z, z % 2 ? 5 : 2);
  // headlights
  m.set(4, 6, 22, 8); m.set(12, 6, 22, 8);
  // stowage boxes on fenders
  m.box(1, 6, 15, 3, 6, 19, 9);
  m.box(13, 6, 4, 15, 6, 7, 2);
  return m;
}

function buildTurretModel() {
  const m = new VoxModel(11, 7, 14);
  for (let z = 0; z <= 12; z++) {
    let inset = 0;
    if (z >= 10) inset = z - 9;
    if (z <= 1) inset = 2 - z;
    for (let x = inset; x <= 10 - inset; x++) {
      for (let y = 0; y <= 3; y++) {
        if (y === 3 && (x === inset || x === 10 - inset)) continue;
        m.set(x, y, z, y === 3 ? 6 : 1);
      }
    }
  }
  m.box(3, 0, 12, 7, 3, 13, 2);  // mantlet
  m.box(6, 4, 3, 8, 4, 6, 2);    // commander cupola
  m.box(7, 5, 4, 7, 5, 5, 5);
  m.box(2, 4, 4, 3, 4, 5, 2);    // loader hatch
  m.box(1, 4, 1, 1, 6, 1, 5);    // antenna base
  m.box(2, 1, 0, 8, 2, 0, 9);    // rear stowage
  return m;
}

function buildBarrelModel() {
  const m = new VoxModel(3, 3, 22);
  m.box(1, 1, 0, 1, 1, 21, 7);
  m.box(0, 0, 0, 2, 2, 2, 2);    // sleeve
  m.box(0, 0, 19, 2, 2, 21, 7);  // muzzle brake
  m.set(1, 1, 21, 5);
  return m;
}

function meshModel(renderer, model, ox, oy, oz, pal = TANK_PAL) {
  const B = new MeshBuilder(4096);
  meshVoxels(B, (x, y, z) => model.get(x, y, z), 0, 0, 0, model.sx, model.sy, model.sz,
    (id, x, y, z, f, out) => {
      const c = pal[id] || [255, 0, 255];
      const j = 0.95 + hash3(x + 11, y, z) * 0.1;
      out[0] = Math.min(255, c[0] * j); out[1] = Math.min(255, c[1] * j); out[2] = Math.min(255, c[2] * j);
    },
    id => id !== 0, (id, nid) => nid === 0, () => false,
    TANK_VOX, ox, oy, oz);
  return renderer.createMesh(B);
}

// Meshes are shared by every tank of a team.
const _tankMeshes = {};
function tankMeshes(renderer, team) {
  if (!_tankMeshes[team]) {
    const pal = Object.assign({}, TANK_PAL, TEAM_PALS[team]);
    _tankMeshes[team] = {
      hull: meshModel(renderer, buildHullModel(), 8.5 * TANK_VOX, 0, 14 * TANK_VOX, pal),
      turret: meshModel(renderer, buildTurretModel(), 5.5 * TANK_VOX, 0, 7 * TANK_VOX, pal),
      barrel: meshModel(renderer, buildBarrelModel(), 1.5 * TANK_VOX, 1.5 * TANK_VOX, 0, pal),
    };
  }
  return _tankMeshes[team];
}

class Tank {
  constructor(renderer, world, x, y, z, team = 'player') {
    this.world = world;
    this.renderer = renderer;
    this.setTeam(team);
    this.alive = true; this.disabled = false;
    this.hp = this.maxHp = 100;
    this.hurtT = 99;          // seconds since last damage
    this.hitR = 2.3;
    this.x = x; this.y = y; this.z = z;
    this.vy = 0;
    this.yaw = 0; this.speed = 0;
    this.pitch = 0; this.roll = 0;
    this.kickP = 0; this.kickR = 0;
    this.turretYaw = 0; this.gunElev = 0;
    this.reload = 0; this.reloadTime = 2.2;
    this.recoil = 0;
    this.trackPhase = 0;

    this.maxFwd = 10; this.maxRev = 4.5;

    this.hullM = M4.create(); this.turretM = M4.create(); this.barrelM = M4.create();
    this.r = [1, 0, 0]; this.u = [0, 1, 0]; this.f = [0, 0, 1];
    this.tr = [1, 0, 0]; this.tf = [0, 0, 1];
    this.gu = [0, 1, 0]; this.gf = [0, 0, 1];
    this.turretPos = [0, 0, 0]; this.gunPivot = [0, 0, 0]; this.muzzle = [0, 0, 0];

    const g = this._probe(x, z, 0, 50);
    this.y = g.targetY;
    this._pose(0);
  }

  setTeam(team) {
    this.team = team;
    this.side = TEAM_SIDE[team];
    this.meshes = tankMeshes(this.renderer, team);
  }

  hitPos() { return [this.x, this.y + 1.3, this.z]; }

  teleport(x, z) {
    this.x = x; this.z = z; this.speed = 0; this.vy = 0; this.pitch = 0; this.roll = 0;
    this.y = this.world.groundAt(x, z, this.world.sy).h;
    this.y = this._probe(x, z, this.yaw, 4).targetY;
    this._pose();
  }

  // Sample terrain under the footprint at a candidate position/heading.
  _probe(x, z, yaw, fromAbove) {
    const W = this.world;
    const c = Math.cos(yaw), s = Math.sin(yaw);
    let hF = -1e9, hB = -1e9, hL = -1e9, hR = -1e9, hMax = -1e9, blocked = false;
    if (x < 3 || z < 3 || x > W.sx - 3 || z > W.sz - 3) blocked = true;
    const from = fromAbove !== undefined ? this.y + fromAbove : this.y + 2.5;
    for (const [lx, lz] of TANK_SAMPLES) {
      const wx = x + c * lx + s * lz, wz = z - s * lx + c * lz;
      const g = W.groundAt(wx, wz, from);
      if (g.id === BL.WATER || g.id === -1) blocked = true;
      if (g.h - this.y > 1.6) blocked = true;
      const h = g.h;
      if (lz > 2) hF = Math.max(hF, h);
      if (lz < -2) hB = Math.max(hB, h);
      if (lx > 1) hL = Math.max(hL, h);
      if (lx < -1) hR = Math.max(hR, h);
      hMax = Math.max(hMax, h);
    }
    const targetY = Math.max((hF + hB) / 2, (hL + hR) / 2, hMax - 0.7);
    return { hF, hB, hL, hR, hMax, blocked, targetY };
  }

  update(dt, keys, aim) {
    // ---- driving
    const fwdIn = (keys.KeyW || keys.ArrowUp ? 1 : 0) - (keys.KeyS || keys.ArrowDown ? 1 : 0);
    let turnIn = (keys.KeyA || keys.ArrowLeft ? 1 : 0) - (keys.KeyD || keys.ArrowRight ? 1 : 0);
    this.turning = turnIn !== 0;

    if (fwdIn > 0) this.speed = Math.min(this.maxFwd, this.speed + (this.speed < 0 ? 18 : 6) * dt);
    else if (fwdIn < 0) this.speed = Math.max(-this.maxRev, this.speed - (this.speed > 0 ? 18 : 5) * dt);
    else { const dec = 9 * dt; this.speed = Math.abs(this.speed) <= dec ? 0 : this.speed - Math.sign(this.speed) * dec; }
    // gravity along slope
    this.speed -= Math.sin(this.pitch) * 7 * dt;
    if (this.speed < -0.3 && fwdIn < 0) turnIn = -turnIn; // car-style reversing

    const turnRate = 1.25 * (1 - Math.min(Math.abs(this.speed) / this.maxFwd, 1) * 0.3);
    const newYaw = this.yaw + turnIn * turnRate * dt;
    const nx = this.x + Math.sin(newYaw) * this.speed * dt;
    const nz = this.z + Math.cos(newYaw) * this.speed * dt;

    const ok = (x, z, yaw) => !this._probe(x, z, yaw).blocked;
    if (ok(nx, nz, newYaw)) { this.x = nx; this.z = nz; this.yaw = newYaw; }
    else if (ok(this.x, this.z, newYaw)) {
      this.yaw = newYaw;
      if (ok(nx, this.z, newYaw)) { this.x = nx; this.speed *= 0.97; }
      else if (ok(this.x, nz, newYaw)) { this.z = nz; this.speed *= 0.97; }
      else this.speed *= -0.15;
    } else if (ok(nx, nz, this.yaw)) { this.x = nx; this.z = nz; }
    else this.speed *= -0.15;

    this.trackPhase += this.speed * dt;

    // ---- terrain following
    const g = this._probe(this.x, this.z, this.yaw);
    if (g.targetY < this.y - 0.05) {
      this.vy -= 28 * dt;
      this.y += this.vy * dt;
      if (this.y < g.targetY) { this.y = g.targetY; this.vy = 0; }
    } else {
      this.vy = 0;
      this.y += (g.targetY - this.y) * Math.min(1, dt * 12);
    }
    const tp = clamp(Math.atan2(g.hF - g.hB, 5.0), -0.6, 0.6);
    const tr = clamp(Math.atan2(g.hL - g.hR, 2.9), -0.5, 0.5);
    const k = Math.min(1, dt * 7);
    this.pitch += (tp - this.pitch) * k;
    this.roll += (tr - this.roll) * k;
    // speed-based squat + idle wobble
    const decay = Math.exp(-dt * 5);
    this.kickP *= decay; this.kickR *= decay;

    this.reload = Math.max(0, this.reload - dt);
    this.recoil = Math.max(0, this.recoil - dt * 1.4);

    this._pose(0);

    // ---- turret & gun aim (in hull-local space)
    if (aim) {
      const d = V3.sub(aim, this.gunPivot);
      const lx = V3.dot(d, this.r), ly = V3.dot(d, this.u), lz = V3.dot(d, this.f);
      const ty = Math.atan2(lx, lz);
      const diff = wrapAngle(ty - this.turretYaw);
      const maxStep = 1.15 * dt;
      this.turretYaw = wrapAngle(this.turretYaw + clamp(diff, -maxStep, maxStep));
      const te = clamp(Math.atan2(ly, Math.hypot(lx, lz)), -0.15, 0.38);
      this.gunElev += clamp(te - this.gunElev, -0.7 * dt, 0.7 * dt);
      this._pose(0);
    }
  }

  // Build hull/turret/gun bases and model matrices.
  _pose() {
    const p = this.pitch + this.kickP, rl = this.roll + this.kickR;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const f = V3.norm([sy * Math.cos(p), Math.sin(p), cy * Math.cos(p)]);
    const r0 = [cy * Math.cos(rl), Math.sin(rl), -sy * Math.cos(rl)];
    const u = V3.norm(V3.cross(f, r0));
    const r = V3.cross(u, f);
    this.r = r; this.u = u; this.f = f;
    const pos = [this.x, this.y, this.z];
    M4.fromBasis(this.hullM, r, u, f, pos);

    // turret
    const ct = Math.cos(this.turretYaw), st = Math.sin(this.turretYaw);
    const tf = [f[0] * ct + r[0] * st, f[1] * ct + r[1] * st, f[2] * ct + r[2] * st];
    const tr = [r[0] * ct - f[0] * st, r[1] * ct - f[1] * st, r[2] * ct - f[2] * st];
    this.tf = tf; this.tr = tr;
    const tp = this.turretPos;
    for (let i = 0; i < 3; i++) tp[i] = pos[i] + u[i] * 1.4 + f[i] * 0.3;
    M4.fromBasis(this.turretM, tr, u, tf, tp);

    // gun
    const ce = Math.cos(this.gunElev), se = Math.sin(this.gunElev);
    const gf = [tf[0] * ce + u[0] * se, tf[1] * ce + u[1] * se, tf[2] * ce + u[2] * se];
    const gu = [u[0] * ce - tf[0] * se, u[1] * ce - tf[1] * se, u[2] * ce - tf[2] * se];
    this.gf = gf; this.gu = gu;
    const gp = this.gunPivot;
    for (let i = 0; i < 3; i++) gp[i] = tp[i] + u[i] * 0.4 + tf[i] * 1.0;
    const bp = [gp[0] - gf[0] * this.recoil, gp[1] - gf[1] * this.recoil, gp[2] - gf[2] * this.recoil];
    M4.fromBasis(this.barrelM, tr, gu, gf, bp);
    const L = 22 * TANK_VOX - this.recoil;
    for (let i = 0; i < 3; i++) this.muzzle[i] = gp[i] + gf[i] * L;
  }

  fire() {
    if (this.reload > 0) return null;
    this.reload = this.reloadTime;
    this.recoil = 0.6;
    this.kickP = 0.06 * Math.cos(this.turretYaw);
    this.kickR = 0.06 * Math.sin(this.turretYaw);
    const shot = { pos: [this.muzzle[0], this.muzzle[1], this.muzzle[2]], dir: [this.gf[0], this.gf[1], this.gf[2]] };
    this._pose();
    return shot;
  }

  // Points behind the tracks for dust
  trackDustPoints() {
    const pts = [];
    for (const side of [-1.45, 1.45]) {
      const zOff = this.speed >= 0 ? -2.7 : 2.7;
      pts.push([this.x + this.r[0] * side + this.f[0] * zOff, this.y + 0.2, this.z + this.r[2] * side + this.f[2] * zOff]);
    }
    return pts;
  }

  drawItems() {
    return [
      { mesh: this.meshes.hull, model: this.hullM, shadow: true },
      { mesh: this.meshes.turret, model: this.turretM, shadow: true },
      { mesh: this.meshes.barrel, model: this.barrelM, shadow: true },
    ];
  }
}
