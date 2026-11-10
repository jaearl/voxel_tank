// Gun turret built by either commander: a tank turret on a steel pedestal that shoots enemies on its own.
'use strict';

const TURRET_RANGE = 80;

class Turret {
  // (x, z) centre of the pedestal, y its top. (bx, by, bz) is the pedestal's top-centre block:
  // if that block gets blown away the turret goes with it.
  constructor(renderer, world, x, y, z, bx, by, bz, faction) {
    this.world = world;
    this.faction = faction;
    this.team = faction.cmdTeam; this.side = faction.side;
    this.alive = true; this.disabled = false;
    this.hp = this.maxHp = 90;
    this.hitR = 1.7;
    this.x = x; this.y = y; this.z = z;
    this.bx = bx; this.by = by; this.bz = bz;
    this.yaw = 0; this.elev = 0;
    this.reload = 1; this.reloadTime = 2.6; this.recoil = 0;
    this.meshes = tankMeshes(renderer, faction.cmdTeam);
    this.turretM = M4.create(); this.barrelM = M4.create();
    this.gunPivot = [0, 0, 0]; this.muzzle = [0, 0, 0]; this.gf = [0, 0, 1];
    this.target = null; this.los = false; this.thinkT = Math.random() * 0.3;
    this._pose();
  }

  hitPos() { return [this.x, this.y + 0.7, this.z]; }

  _pose() {
    const st = Math.sin(this.yaw), ct = Math.cos(this.yaw);
    const tf = [st, 0, ct], tr = [ct, 0, -st];
    M4.fromBasis(this.turretM, tr, [0, 1, 0], tf, [this.x, this.y, this.z]);
    const ce = Math.cos(this.elev), se = Math.sin(this.elev);
    const gf = [tf[0] * ce, se, tf[2] * ce], gu = [-tf[0] * se, ce, -tf[2] * se];
    this.gf = gf;
    const gp = this.gunPivot;
    gp[0] = this.x + tf[0]; gp[1] = this.y + 0.4; gp[2] = this.z + tf[2];
    M4.fromBasis(this.barrelM, tr, gu, gf, [gp[0] - gf[0] * this.recoil, gp[1] - gf[1] * this.recoil, gp[2] - gf[2] * this.recoil]);
    const L = 22 * TANK_VOX - this.recoil;
    for (let i = 0; i < 3; i++) this.muzzle[i] = gp[i] + gf[i] * L;
  }

  // G: { world, effects, ents }
  update(dt, G) {
    if (this.world.get(this.bx, this.by, this.bz) !== BL.STEEL) { this.hp = 0; return; }
    this.reload = Math.max(0, this.reload - dt);
    this.recoil = Math.max(0, this.recoil - dt * 1.4);

    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.3;
      let best = null, bd = TURRET_RANGE;
      for (const e of G.ents) {
        if (e.side === this.side || e.disabled || !e.alive) continue;
        const d = Math.hypot(e.x - this.x, e.z - this.z);
        if (d < bd) { bd = d; best = e; }
      }
      this.target = best; this.los = false;
      if (best) {
        const p = best.hitPos(), o = this.gunPivot;
        const vx = p[0] - o[0], vy = p[1] - o[1], vz = p[2] - o[2], d = Math.hypot(vx, vy, vz) || 1;
        const hit = this.world.raycast(o[0], o[1], o[2], vx / d, vy / d, vz / d, d, true, true);
        this.los = !hit || hit.t > d - 2.6;
      }
    }

    const tg = this.target && this.target.alive && !this.target.disabled ? this.target : null;
    if (tg) {
      const p = tg.hitPos(), o = this.gunPivot;
      const dx = p[0] - o[0], dz = p[2] - o[2], hd = Math.hypot(dx, dz);
      const d = Math.hypot(hd, p[1] - o[1]), tof = d / BOT.SHELL_SPEED;
      const dy = p[1] + 4.9 * tof * tof - o[1];
      this.yaw = wrapAngle(this.yaw + clamp(wrapAngle(Math.atan2(dx, dz) - this.yaw), -1.8 * dt, 1.8 * dt));
      this.elev += clamp(clamp(Math.atan2(dy, hd), -0.25, 0.5) - this.elev, -dt, dt);
      this._pose();
      if (this.los && this.reload <= 0) {
        const v = V3.norm([p[0] - this.gunPivot[0], dy, p[2] - this.gunPivot[2]]);
        if (V3.dot(v, this.gf) > 0.9993) {
          this.reload = this.reloadTime; this.recoil = 0.6;
          G.effects.muzzleFlash(this.muzzle, this.gf);
          G.effects.fireShell(this.muzzle, this.gf, this.side);
        }
      }
    } else this._pose();
  }

  drawItems() {
    return [
      { mesh: this.meshes.turret, model: this.turretM, shadow: true },
      { mesh: this.meshes.barrel, model: this.barrelM, shadow: true },
    ];
  }
}
