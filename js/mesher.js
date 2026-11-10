// Voxel mesher: turns a voxel grid into a triangle mesh with per-vertex ambient occlusion.
// Vertex layout (20 bytes): pos float32x3 | normal int8x3 + transparency int8 (0 = opaque, 127 = invisible) | color uint8x4 (alpha = AO)
'use strict';

class MeshBuilder {
  constructor(cap = 8192) { this.buf = null; this._alloc(cap); this.vc = 0; this.ic = 0; }

  _alloc(cap) {
    const buf = new ArrayBuffer(cap * 20);
    const u8 = new Uint8Array(buf);
    const idx = new Uint32Array(Math.ceil(cap * 1.5));
    if (this.buf) { u8.set(this.u8.subarray(0, this.vc * 20)); idx.set(this.idx.subarray(0, this.ic)); }
    this.buf = buf; this.u8 = u8; this.f32 = new Float32Array(buf); this.i8 = new Int8Array(buf);
    this.idx = idx; this.cap = cap;
  }

  reset() { this.vc = 0; this.ic = 0; }

  _v(x, y, z, nx, ny, nz, r, g, b, a, t) {
    const v = this.vc++;
    const f = v * 5;
    this.f32[f] = x; this.f32[f + 1] = y; this.f32[f + 2] = z;
    const o = v * 20 + 12;
    this.i8[o] = nx; this.i8[o + 1] = ny; this.i8[o + 2] = nz; this.i8[o + 3] = t;
    this.u8[o + 4] = r; this.u8[o + 5] = g; this.u8[o + 6] = b; this.u8[o + 7] = a;
  }

  // corners: base, base+u, base+u+v, base+v  (u x v must equal the face normal => CCW from outside)
  quad(bx, by, bz, ux, uy, uz, vx, vy, vz, nx, ny, nz, r, g, b, a0, a1, a2, a3, t = 0) {
    if (this.vc + 4 > this.cap) this._alloc(this.cap * 2);
    const s = this.vc;
    this._v(bx, by, bz, nx, ny, nz, r, g, b, a0, t);
    this._v(bx + ux, by + uy, bz + uz, nx, ny, nz, r, g, b, a1, t);
    this._v(bx + ux + vx, by + uy + vy, bz + uz + vz, nx, ny, nz, r, g, b, a2, t);
    this._v(bx + vx, by + vy, bz + vz, nx, ny, nz, r, g, b, a3, t);
    const I = this.idx; let i = this.ic;
    if (a0 + a2 > a1 + a3) { I[i++] = s; I[i++] = s + 1; I[i++] = s + 2; I[i++] = s; I[i++] = s + 2; I[i++] = s + 3; }
    else { I[i++] = s + 1; I[i++] = s + 2; I[i++] = s + 3; I[i++] = s + 1; I[i++] = s + 3; I[i++] = s; }
    this.ic = i;
  }

  // Axis aligned cube centered at (x,y,z) with half size s. emissive => zero normal (shader skips lighting)
  // alpha: 1 = opaque, 0 = invisible (only has an effect on meshes drawn in the renderer's blended pass)
  cube(x, y, z, s, r, g, b, emissive, alpha = 1) {
    const d = s * 2;
    const t = Math.round((1 - Math.max(0, Math.min(1, alpha))) * 127);
    for (let f = 0; f < 6; f++) {
      const F = FACES[f];
      const n = emissive ? 0 : 127;
      this.quad(
        x - s + F[9] * d, y - s + F[10] * d, z - s + F[11] * d,
        F[3] * d, F[4] * d, F[5] * d, F[6] * d, F[7] * d, F[8] * d,
        F[0] * n, F[1] * n, F[2] * n, r, g, b, 255, 255, 255, 255, t);
    }
  }
}

// normal(3), u(3), v(3), base offset(3)
const FACES = [
  [1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 0, 0],
  [-1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0],
  [0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0],
  [0, -1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0],
  [0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 0, 1],
  [0, 0, -1, 0, 1, 0, 1, 0, 0, 0, 0, 0],
];
const AO_LEVELS = [105, 160, 212, 255];

function aoAt(get, op, px, py, pz, ux, uy, uz, vx, vy, vz, su, sv) {
  const s1 = op(get(px + ux * su, py + uy * su, pz + uz * su)) ? 1 : 0;
  const s2 = op(get(px + vx * sv, py + vy * sv, pz + vz * sv)) ? 1 : 0;
  if (s1 && s2) return AO_LEVELS[0];
  const c = op(get(px + ux * su + vx * sv, py + uy * su + vy * sv, pz + uz * su + vz * sv)) ? 1 : 0;
  return AO_LEVELS[3 - s1 - s2 - c];
}

/**
 * Mesh voxels in [x0,x1) x [y0,y1) x [z0,z1).
 * get(x,y,z) -> id, isOpaque(id), faceVisible(id, neighborId), colorOf(id,x,y,z,face,out[3]), noAO(id)
 */
function meshVoxels(B, get, x0, y0, z0, x1, y1, z1, colorOf, isOpaque, faceVisible, noAO, scale, ox, oy, oz) {
  const col = [0, 0, 0];
  for (let y = y0; y < y1; y++) {
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        const id = get(x, y, z);
        if (!id) continue;
        for (let f = 0; f < 6; f++) {
          const F = FACES[f];
          const nx = F[0], ny = F[1], nz = F[2];
          if (!faceVisible(id, get(x + nx, y + ny, z + nz))) continue;
          colorOf(id, x, y, z, f, col);
          const ux = F[3], uy = F[4], uz = F[5], vx = F[6], vy = F[7], vz = F[8];
          let a0 = 255, a1 = 255, a2 = 255, a3 = 255;
          if (!noAO(id)) {
            const px = x + nx, py = y + ny, pz = z + nz;
            a0 = aoAt(get, isOpaque, px, py, pz, ux, uy, uz, vx, vy, vz, -1, -1);
            a1 = aoAt(get, isOpaque, px, py, pz, ux, uy, uz, vx, vy, vz, 1, -1);
            a2 = aoAt(get, isOpaque, px, py, pz, ux, uy, uz, vx, vy, vz, 1, 1);
            a3 = aoAt(get, isOpaque, px, py, pz, ux, uy, uz, vx, vy, vz, -1, 1);
          }
          B.quad(
            (x + F[9]) * scale - ox, (y + F[10]) * scale - oy, (z + F[11]) * scale - oz,
            ux * scale, uy * scale, uz * scale, vx * scale, vy * scale, vz * scale,
            nx * 127, ny * 127, nz * 127,
            col[0], col[1], col[2], a0, a1, a2, a3);
        }
      }
    }
  }
}

// Simple voxel grid for models (tank parts etc.)
class VoxModel {
  constructor(sx, sy, sz) { this.sx = sx; this.sy = sy; this.sz = sz; this.d = new Uint8Array(sx * sy * sz); }
  get(x, y, z) {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return 0;
    return this.d[x + this.sx * (y + this.sy * z)];
  }
  set(x, y, z, v) {
    if (x < 0 || y < 0 || z < 0 || x >= this.sx || y >= this.sy || z >= this.sz) return;
    this.d[x + this.sx * (y + this.sy * z)] = v;
  }
  box(x0, y0, z0, x1, y1, z1, v) {
    for (let z = z0; z <= z1; z++) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, z, v);
  }
}
