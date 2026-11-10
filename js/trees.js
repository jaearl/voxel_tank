// A tree that has been knocked or blasted loose: its voxels are lifted out of the world into a mesh
// that topples over about the base of the trunk, lies there for a while, then sinks away.
'use strict';

class FallenTree {
  // vox: flat [x, y, z, id, ...] in world coords. pivot: [x, y, z] the hinge. dir: [dx, dz] way it falls.
  constructor(renderer, world, vox, pivot, dir) {
    this.renderer = renderer;
    this.pivot = pivot;
    const l = Math.hypot(dir[0], dir[1]) || 1;
    this.dx = dir[0] / l; this.dz = dir[1] / l;
    this.ang = 0.04; this.vel = 0.25;
    this.maxAng = 1.42 + Math.random() * 0.1;
    this.settled = false; this.life = 28; this.sink = 0;
    this.alive = true;
    this.model = M4.create();

    const map = new Map();
    let x0 = 1e9, y0 = 1e9, z0 = 1e9, x1 = -1e9, y1 = -1e9, z1 = -1e9;
    for (let i = 0; i < vox.length; i += 4) {
      const x = vox[i], y = vox[i + 1], z = vox[i + 2];
      map.set(x + ',' + y + ',' + z, vox[i + 3]);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); z0 = Math.min(z0, z);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y); z1 = Math.max(z1, z);
    }
    const B = new MeshBuilder(2048);
    meshVoxels(B, (x, y, z) => map.get(x + ',' + y + ',' + z) || 0, x0, y0, z0, x1 + 1, y1 + 1, z1 + 1,
      (id, x, y, z, f, out) => world.blockColor(id, x, y, z, f, out),
      id => id !== 0, (id, nid) => nid === 0, () => false,
      1, pivot[0], pivot[1], pivot[2]);
    this.mesh = renderer.createMesh(B);
    this._pose();
  }

  _pose() {
    const c = Math.cos(this.ang), s = Math.sin(this.ang), dx = this.dx, dz = this.dz;
    // rotate "up" toward the fall direction by ang, about the horizontal axis a = (dz, 0, -dx)
    const ax = dz, az = -dx;
    const ex = [ax * ax + c * dx * dx, -s * dx, az * ax + c * dz * dx];
    const ey = [s * dx, c, s * dz];
    const ez = [ax * az + c * dx * dz, -s * dz, az * az + c * dz * dz];
    M4.fromBasis(this.model, ex, ey, ez, [this.pivot[0], this.pivot[1] - this.sink, this.pivot[2]]);
  }

  update(dt) {
    if (!this.settled) {
      this.vel += (0.8 + 6 * Math.sin(this.ang)) * dt;
      this.ang += this.vel * dt;
      if (this.ang >= this.maxAng) {
        this.ang = this.maxAng;
        if (this.vel > 0.9) this.vel = -this.vel * 0.22; else this.settled = true;
      }
    } else {
      this.life -= dt;
      if (this.life < 0) { this.sink += dt * 0.8; if (this.sink > 3.5) this.remove(); }
    }
    if (this.alive) this._pose();
  }

  remove() {
    if (!this.alive) return;
    this.alive = false;
    this.renderer.deleteMesh(this.mesh);
  }

  drawItem() { return { mesh: this.mesh, model: this.model, shadow: !this.settled || this.life > 0 }; }
}
