// Shells and voxel particles (muzzle flash, smoke, debris, dust).
'use strict';

const MAX_PARTICLES = 3000;
const MUZZLE_SMOKE_ALPHA = 0.25;   // opacity of the smoke puff when the gun fires (1 = solid)

class Effects {
  constructor(renderer, world) {
    this.renderer = renderer;
    this.world = world;
    this.parts = [];
    this.shells = [];
    this.B = new MeshBuilder(16384);
    this.mesh = renderer.createMesh(null, true);
    this.BT = new MeshBuilder(4096);              // translucent particles (smoke)
    this.meshT = renderer.createMesh(null, true);
    this.model = M4.create();
  }

  add(x, y, z, vx, vy, vz, life, size, r, g, b, o = {}) {
    if (this.parts.length >= MAX_PARTICLES) return;
    this.parts.push({
      x, y, z, vx, vy, vz, life, max: life, size, r, g, b,
      alpha: o.alpha ?? 1, em: !!o.em, grav: o.grav ?? 18, drag: o.drag ?? 0.4, grow: o.grow ?? 0, shrink: o.shrink ?? true, bounce: o.bounce ?? true,
    });
  }

  muzzleFlash(p, d) {
    for (let i = 0; i < 14; i++) {
      const s = 4 + Math.random() * 10;
      this.add(p[0], p[1], p[2], d[0] * s + (Math.random() - 0.5) * 3, d[1] * s + (Math.random() - 0.5) * 3, d[2] * s + (Math.random() - 0.5) * 3,
        0.08 + Math.random() * 0.1, 0.18 + Math.random() * 0.12, 255, 200 + Math.random() * 55, 90, { em: true, grav: 0, drag: 3 });
    }
    for (let i = 0; i < 14; i++) {
      const s = 1 + Math.random() * 4, c = 150 + Math.random() * 40;
      this.add(p[0], p[1], p[2], d[0] * s + (Math.random() - 0.5) * 2, d[1] * s + Math.random(), d[2] * s + (Math.random() - 0.5) * 2,
        1.2 + Math.random() * 1.0, 0.15 + Math.random() * 0.1, c, c, c, { grav: -1.2, drag: 1.5, grow: 0.5, shrink: false, bounce: false, alpha: MUZZLE_SMOKE_ALPHA });
    }
  }

  // side: whose shell it is ('blue' | 'red'); it passes through targets on its own side
  fireShell(p, d, side = 'blue', speed = 150) {
    this.shells.push({ x: p[0], y: p[1], z: p[2], vx: d[0] * speed, vy: d[1] * speed, vz: d[2] * speed, life: 4, side });
  }

  // dark smoke from a knocked-out tank
  smoke(p) {
    const c = 36 + Math.random() * 40;
    this.add(p[0] + (Math.random() - 0.5), p[1], p[2] + (Math.random() - 0.5),
      (Math.random() - 0.5) * 0.6, 1.5 + Math.random(), (Math.random() - 0.5) * 0.6,
      1.4 + Math.random(), 0.16 + Math.random() * 0.12, c, c, c, { grav: -0.8, drag: 1, grow: 0.35, shrink: false, bounce: false, alpha: 0.45 });
  }

  // little coloured pop (pickups, building, recruiting)
  burst(p, r, g, b, n = 16) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 1 + Math.random() * 4;
      this.add(p[0], p[1], p[2], Math.cos(a) * s, 2 + Math.random() * 5, Math.sin(a) * s,
        0.4 + Math.random() * 0.4, 0.1 + Math.random() * 0.08, r, g, b, { em: true, grav: 12, drag: 1 });
    }
  }

  explosion(p, removed) {
    for (let i = 0; i < 30; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 1.2, s = 3 + Math.random() * 9;
      this.add(p[0], p[1], p[2], Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s, Math.sin(a) * Math.cos(e) * s,
        0.2 + Math.random() * 0.3, 0.3 + Math.random() * 0.3, 255, 120 + Math.random() * 120, 30, { em: true, grav: -2, drag: 3 });
    }
    for (let i = 0; i < 26; i++) {
      const c = 50 + Math.random() * 50;
      this.add(p[0] + (Math.random() - 0.5) * 2, p[1] + Math.random(), p[2] + (Math.random() - 0.5) * 2,
        (Math.random() - 0.5) * 3, 1.5 + Math.random() * 3, (Math.random() - 0.5) * 3,
        2 + Math.random() * 2, 0.35 + Math.random() * 0.3, c, c * 0.95, c * 0.9, { grav: -0.6, drag: 1.2, grow: 0.7, shrink: false, bounce: false, alpha: 0.55 });
    }
    // debris chunks colored like what got blown away
    const n = removed.length / 4;
    const step = Math.max(1, Math.floor(n / 70));
    for (let i = 0; i < n; i += step) {
      const id = removed[i * 4 + 3];
      const c = BLOCK_COLORS[id] || [120, 120, 120];
      const x = removed[i * 4] + 0.5, y = removed[i * 4 + 1] + 0.5, z = removed[i * 4 + 2] + 0.5;
      const dx = x - p[0], dz = z - p[2];
      this.add(x, y, z, dx * 3 + (Math.random() - 0.5) * 5, 5 + Math.random() * 9, dz * 3 + (Math.random() - 0.5) * 5,
        1.5 + Math.random() * 1.5, 0.15 + Math.random() * 0.2, c[0], c[1], c[2], { grav: 22, drag: 0.3 });
    }
  }

  splash(p) {
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, s = Math.random() * 4;
      this.add(p[0], p[1] + 0.5, p[2], Math.cos(a) * s, 6 + Math.random() * 10, Math.sin(a) * s,
        1 + Math.random(), 0.15 + Math.random() * 0.15, 190, 215, 240, { grav: 20, drag: 0.5 });
    }
  }

  dust(p, amount) {
    if (Math.random() > amount) return;
    const c = 120 + Math.random() * 30;
    this.add(p[0] + (Math.random() - 0.5), p[1], p[2] + (Math.random() - 0.5),
      (Math.random() - 0.5) * 1.5, 0.6 + Math.random(), (Math.random() - 0.5) * 1.5,
      0.6 + Math.random() * 0.6, 0.05 + Math.random() * 0.05, c, c * 0.88, c * 0.7, { grav: -0.3, drag: 1.5, grow: 0.12, shrink: false, bounce: false });
  }

  // targets: [{x, y, z, r, side, ref}] spheres a shell can hit. onImpact(point, dir, blockId, target, shell)
  update(dt, onImpact, targets = []) {
    const W = this.world;
    // shells
    for (let i = this.shells.length - 1; i >= 0; i--) {
      const s = this.shells[i];
      s.vy -= 9.8 * dt;
      const sp = Math.hypot(s.vx, s.vy, s.vz);
      const dx = s.vx / sp, dy = s.vy / sp, dz = s.vz / sp;
      const L = sp * dt;
      const hit = W.raycast(s.x, s.y, s.z, dx, dy, dz, L);
      let tHit = hit ? hit.t : Infinity, tgt = null;
      for (const T of targets) {
        if (T.side === s.side) continue;
        const ox = T.x - s.x, oy = T.y - s.y, oz = T.z - s.z;
        const b = ox * dx + oy * dy + oz * dz;
        if (b < -T.r || b > L + T.r) continue;
        const c2 = ox * ox + oy * oy + oz * oz - b * b;
        if (c2 > T.r * T.r) continue;
        const t = Math.max(0, b - Math.sqrt(T.r * T.r - c2));
        if (t <= L && t < tHit) { tHit = t; tgt = T; }
      }
      if (tgt) {
        this.shells.splice(i, 1);
        onImpact([s.x + dx * tHit, s.y + dy * tHit, s.z + dz * tHit], [dx, dy, dz], 0, tgt, s);
        continue;
      }
      if (hit) {
        this.shells.splice(i, 1);
        onImpact([hit.px, hit.py, hit.pz], [dx, dy, dz], hit.id, null, s);
        continue;
      }
      // tracer trail
      for (let k = 0; k < 3; k++) {
        const t = k / 3 * dt;
        this.add(s.x + s.vx * t, s.y + s.vy * t, s.z + s.vz * t, 0, 0, 0, 0.12, 0.09, 255, 210, 120, { em: true, grav: 0 });
      }
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      s.life -= dt;
      if (s.life <= 0 || s.y < -5) this.shells.splice(i, 1);
    }

    // particles
    const P = this.parts;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i];
      p.life -= dt;
      if (p.life <= 0) { P[i] = P[P.length - 1]; P.pop(); continue; }
      p.vy -= p.grav * dt;
      const dr = Math.max(0, 1 - p.drag * dt);
      p.vx *= dr; p.vy *= dr; p.vz *= dr;
      const ny = p.y + p.vy * dt;
      if (p.bounce && W.isSolid(p.x, ny, p.z)) {
        p.vy = -p.vy * 0.3; p.vx *= 0.6; p.vz *= 0.6;
      } else p.y = ny;
      p.x += p.vx * dt; p.z += p.vz * dt;
      p.size += p.grow * dt;
    }
  }

  buildMesh() {
    const B = this.B, BT = this.BT;
    B.reset(); BT.reset();
    for (const p of this.parts) {
      const s = p.shrink ? p.size * Math.min(1, p.life / p.max * 2) : p.size * Math.min(1, p.life / 0.4);
      if (s <= 0.005) continue;
      if (p.alpha < 1) BT.cube(p.x, p.y, p.z, s, p.r, p.g, p.b, p.em, p.alpha * Math.min(1, p.life / p.max * 1.5));
      else B.cube(p.x, p.y, p.z, s, p.r, p.g, p.b, p.em);
    }
    for (const s of this.shells) B.cube(s.x, s.y, s.z, 0.14, 255, 230, 150, true);
    this.renderer.updateMesh(this.mesh, B);
    this.renderer.updateMesh(this.meshT, BT);
  }

  drawItems() {
    return [
      { mesh: this.mesh, model: this.model, shadow: false },
      { mesh: this.meshT, model: this.model, shadow: false, blend: true },
    ];
  }
}
