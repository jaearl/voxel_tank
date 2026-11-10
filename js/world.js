// Voxel world: generation, queries, raycasting, destruction, chunk meshing.
'use strict';

const BL = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, SAND: 4, WATER: 5, WOOD: 6, LEAVES: 7,
  SNOW: 8, BRICK: 9, SCORCH: 10, BEDROCK: 11, PINE: 12,
  CONCRETE: 13, STEEL: 14, FLAG: 15, PAVE: 16,
};
const BLOCK_COLORS = [
  null,
  [96, 152, 64],   // grass
  [124, 88, 60],   // dirt
  [128, 128, 134], // stone
  [212, 194, 138], // sand
  [56, 116, 176],  // water
  [104, 74, 48],   // wood
  [60, 124, 50],   // leaves
  [236, 240, 246], // snow
  [156, 82, 64],   // brick
  [46, 41, 37],    // scorch
  [60, 60, 64],    // bedrock
  [40, 92, 58],    // pine needles
  [178, 178, 170], // concrete (player walls)
  [74, 84, 94],    // steel (turret pedestals)
  [214, 62, 48],   // flag
  [152, 148, 138], // paving (base site centre)
];
const SITE_R = 13;      // radius of the flat top of a base site
const SITE_BLEND = 9;   // width of the ramp around it
const WATER_LEVEL = 13;
const CHUNK = 32;

class World {
  constructor(sx = 256, sy = 64, sz = 256, seed = 1337) {
    this.sx = sx; this.sy = sy; this.sz = sz; this.seed = seed;
    this.data = new Uint8Array(sx * sy * sz);
    this.colTop = new Uint8Array(sx * sz);
    this.tint = new Float32Array(sx * sz);
    this.chunksX = Math.ceil(sx / CHUNK);
    this.chunksZ = Math.ceil(sz / CHUNK);
  }

  idx(x, y, z) { return x + this.sx * (z + this.sz * y); }

  get(x, y, z) {
    if (y < 0) return BL.BEDROCK;
    if (x < 0 || z < 0 || y >= this.sy || x >= this.sx || z >= this.sz) return 0;
    return this.data[x + this.sx * (z + this.sz * y)];
  }

  set(x, y, z, v) {
    if (x < 0 || z < 0 || y < 0 || y >= this.sy || x >= this.sx || z >= this.sz) return;
    this.data[x + this.sx * (z + this.sz * y)] = v;
  }

  // Put a block and keep the column-top cache right (set() alone is only safe for removing).
  place(x, y, z, v) {
    if (x < 0 || z < 0 || y < 0 || y >= this.sy || x >= this.sx || z >= this.sz) return;
    this.data[x + this.sx * (z + this.sz * y)] = v;
    const i = x + z * this.sx;
    if (v && y > this.colTop[i]) this.colTop[i] = y;
  }

  // ---------------------------------------------------------------- generation
  generate() {
    const { sx, sy, sz } = this;
    const rnd = mulberry32(this.seed);
    const N = makeNoise(this.seed);
    const H = new Int16Array(sx * sz);
    this.heights = H;
    this.area = (sx * sz) / (256 * 256);   // feature counts scale with map area
    this.siteMask = new Uint8Array(sx * sz);
    this.sites = [];

    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const n = N.fbm(x * 0.0085, z * 0.0085, 5);
        const m = N.fbm(x * 0.003 + 100, z * 0.003 + 100, 3);
        let h = 6 + Math.pow(n, 1.5) * 34 * (0.45 + m) + N.fbm(x * 0.06, z * 0.06, 2) * 2.5;
        const e = Math.min(x, z, sx - 1 - x, sz - 1 - z);
        if (e < 28) { const t = 1 - e / 28; h += t * t * 34; }
        h = Math.max(2, Math.min(sy - 12, Math.floor(h)));
        H[x + z * sx] = h;
        this.tint[x + z * sx] = 0.88 + N.fbm(x * 0.03 + 50, z * 0.03 - 70, 3) * 0.24;
      }
    }

    this._pickSites(rnd, H);

    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const h = H[x + z * sx];
        let top;
        if (this.siteMask[x + z * sx] === 2) top = BL.GRASS;
        else if (h <= WATER_LEVEL + 1) top = BL.SAND;
        else if (h >= 40) top = BL.SNOW;
        else if (h >= 33) top = BL.STONE;
        else top = BL.GRASS;
        for (let y = 0; y < h; y++) {
          let id;
          if (y === 0) id = BL.BEDROCK;
          else if (y < h - 4) id = BL.STONE;
          else if (y < h - 1) id = top === BL.SAND ? BL.SAND : BL.DIRT;
          else id = top;
          this.data[this.idx(x, y, z)] = id;
        }
        for (let y = h; y < WATER_LEVEL; y++) this.data[this.idx(x, y, z)] = BL.WATER;
      }
    }

    this._decorateSites(rnd);
    this._ruins(rnd, H);
    this._rocks(rnd, H);
    this._trees(rnd, H, N);
    this._computeColTops();
    this._computeNav();
  }

  // Base sites: flat, slightly raised plateaus with a ramp all round. sites[0] is the one nearest the map centre.
  _pickSites(rnd, H) {
    const { sx, sz } = this;
    const want = Math.max(2, Math.round(1.75 * this.area));
    const margin = Math.min(62, Math.round(sx * 0.2));
    const apart = Math.min(115, sx * 0.36);
    for (let a = 0; a < 6000 && this.sites.length < want; a++) {
      let cx, cz;
      if (!this.sites.length && a < 1500) { cx = (sx / 2 + (rnd() - 0.5) * sx * 0.3) | 0; cz = (sz / 2 + (rnd() - 0.5) * sz * 0.3) | 0; }
      else { cx = margin + (rnd() * (sx - 2 * margin) | 0); cz = margin + (rnd() * (sz - 2 * margin) | 0); }
      if (cx < margin || cz < margin || cx >= sx - margin || cz >= sz - margin) continue;
      if (this.sites.some(s => Math.hypot(s.x - cx, s.z - cz) < apart)) continue;
      let mn = 999, mx = -999, sum = 0, n = 0;
      const R = SITE_R + SITE_BLEND;
      for (let dz = -R; dz <= R; dz += 2) for (let dx = -R; dx <= R; dx += 2) {
        if (dx * dx + dz * dz > R * R) continue;
        const h = H[cx + dx + (cz + dz) * sx];
        mn = Math.min(mn, h); mx = Math.max(mx, h);
        if (dx * dx + dz * dz <= SITE_R * SITE_R) { sum += h; n++; }
      }
      if (mn <= WATER_LEVEL + 1 || mx > 30 || mx - mn > 6) continue;
      this.sites.push({ x: cx, z: cz, r: SITE_R, h: Math.round(sum / n) + 1 });
    }
    for (const s of this.sites) {
      const R = SITE_R + SITE_BLEND;
      for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const d = Math.hypot(dx, dz);
        if (d > R) continue;
        const i = s.x + dx + (s.z + dz) * sx;
        if (d <= SITE_R) { H[i] = s.h; this.siteMask[i] = 2; }
        else {
          const t = (d - SITE_R) / SITE_BLEND, k = t * t * (3 - 2 * t);
          H[i] = Math.round(s.h * (1 - k) + H[i] * k);
          this.siteMask[i] = 1;
        }
      }
    }
  }

  nearSite(x, z, pad) {
    for (const s of this.sites) if (Math.hypot(s.x - x, s.z - z) < s.r + pad) return true;
    return false;
  }

  // Paved centre with a flagpole, and broken stone ramparts round the rim with three gaps to drive through.
  _decorateSites(rnd) {
    for (const s of this.sites) {
      const phase = rnd() * Math.PI * 2;
      for (let dz = -SITE_R; dz <= SITE_R; dz++) for (let dx = -SITE_R; dx <= SITE_R; dx++) {
        const d = Math.hypot(dx, dz), x = s.x + dx, z = s.z + dz;
        if (d < 3.6) this.set(x, s.h - 1, z, BL.PAVE);
        if (Math.abs(d - (SITE_R - 0.5)) < 0.75 && Math.sin(Math.atan2(dz, dx) * 3 + phase) > 0.3) {
          this.set(x, s.h, z, BL.STONE);
          if (rnd() < 0.8) this.set(x, s.h + 1, z, BL.STONE);
        }
      }
      for (let y = s.h; y < s.h + 10; y++) this.set(s.x, y, s.z, BL.WOOD);
      for (let i = 1; i <= 3; i++) { this.set(s.x + i, s.h + 9, s.z, BL.FLAG); this.set(s.x + i, s.h + 8, s.z, BL.FLAG); }
    }
  }

  _ruins(rnd, H) {
    const { sx } = this;
    let made = 0;
    const want = Math.round(9 * this.area);
    for (let a = 0; a < 200 * this.area && made < want; a++) {
      const w = 8 + (rnd() * 7 | 0), d = 8 + (rnd() * 7 | 0);
      const x0 = 36 + (rnd() * (this.sx - 72 - w) | 0), z0 = 36 + (rnd() * (this.sz - 72 - d) | 0);
      let mn = 999, mx = -999;
      for (let z = z0; z < z0 + d; z++) for (let x = x0; x < x0 + w; x++) {
        const h = H[x + z * sx]; mn = Math.min(mn, h); mx = Math.max(mx, h);
      }
      if (mx - mn > 2 || mn <= WATER_LEVEL + 1 || mx > 32) continue;
      if (this.nearSite(x0 + w / 2, z0 + d / 2, SITE_BLEND + 12)) continue;
      const base = mx;
      const wh = 4 + (rnd() * 3 | 0);
      const door = rnd() * 4 | 0;
      for (let z = z0; z < z0 + d; z++) for (let x = x0; x < x0 + w; x++) {
        const edge = x === x0 || x === x0 + w - 1 || z === z0 || z === z0 + d - 1;
        // level the floor
        for (let y = H[x + z * sx]; y < base; y++) this.set(x, y, z, edge ? BL.BRICK : BL.DIRT);
        if (!edge) { if (H[x + z * sx] < base) this.set(x, base - 1, z, BL.GRASS); continue; }
        const midX = x0 + (w >> 1), midZ = z0 + (d >> 1);
        const colH = wh - (rnd() < 0.45 ? (1 + (rnd() * 3 | 0)) : 0);
        for (let y = base; y < base + colH; y++) {
          const ly = y - base;
          // doorway
          if (ly < 3) {
            if (door === 0 && z === z0 && Math.abs(x - midX) <= 1) continue;
            if (door === 1 && z === z0 + d - 1 && Math.abs(x - midX) <= 1) continue;
            if (door === 2 && x === x0 && Math.abs(z - midZ) <= 1) continue;
            if (door === 3 && x === x0 + w - 1 && Math.abs(z - midZ) <= 1) continue;
          }
          // windows
          if (ly === 2 && ((x - x0) % 3 === 1 || (z - z0) % 3 === 1) && rnd() < 0.7) continue;
          if (rnd() < 0.06) continue; // random damage
          this.set(x, y, z, BL.BRICK);
        }
      }
      made++;
    }
  }

  _rocks(rnd, H) {
    for (let i = 0; i < 90 * this.area; i++) {
      const cx = 20 + rnd() * (this.sx - 40), cz = 20 + rnd() * (this.sz - 40);
      if (this.nearSite(cx, cz, 3)) continue;
      const h = H[(cx | 0) + (cz | 0) * this.sx];
      if (h < WATER_LEVEL) continue;
      const rx = 1 + rnd() * 1.8, ry = 0.8 + rnd() * 1.4, rz = 1 + rnd() * 1.8;
      const cy = h - 0.5;
      for (let y = Math.floor(cy - ry); y <= cy + ry; y++)
        for (let z = Math.floor(cz - rz); z <= cz + rz; z++)
          for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
            const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry, dz = (z + 0.5 - cz) / rz;
            if (dx * dx + dy * dy + dz * dz < 1 && y > 0) this.set(x, y, z, BL.STONE);
          }
    }
  }

  _trees(rnd, H, N) {
    const { sx, sz } = this;
    let count = 0;
    this.trees = [];                          // {x, z, h (trunk base), yTop, rad, dead, felled}
    this.treeAt = new Int32Array(sx * sz);    // trunk column -> index into trees + 1
    for (let a = 0; a < 6000 * this.area && count < 520 * this.area; a++) {
      const x = 4 + (rnd() * (sx - 8) | 0), z = 4 + (rnd() * (sz - 8) | 0);
      if (this.nearSite(x, z, 4)) continue;
      const forest = N.fbm(x * 0.015 + 300, z * 0.015 - 200, 3);
      if (rnd() > (forest > 0.55 ? 0.9 : 0.06)) continue;
      const h = H[x + z * sx];
      const ground = this.get(x, h - 1, z);
      if (ground !== BL.GRASS && ground !== BL.STONE) continue;
      if (this.get(x, h, z) !== BL.AIR) continue;
      if (h > 38) continue;
      // keep some room between trunks
      let near = false;
      for (let dz = -2; dz <= 2 && !near; dz++) for (let dx = -2; dx <= 2; dx++) if (this.get(x + dx, h + 1, z + dz) === BL.WOOD) { near = true; break; }
      if (near) continue;

      const pine = h > 25 || rnd() < 0.25;
      const th = (pine ? 5 : 4) + (rnd() * 3 | 0);
      const top = h + th;
      if (pine) {
        for (let ly = 0; ly <= th; ly++) {
          const y = h + 2 + ly;
          const r = Math.max(0, Math.round((th - ly) * 0.45));
          for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) + Math.abs(dz) > r + (r > 1 ? 1 : 0)) continue;
            if (this.get(x + dx, y, z + dz) === BL.AIR) this.set(x + dx, y, z + dz, BL.PINE);
          }
        }
        this.set(x, top + 2, z, BL.PINE);
      } else {
        const r = 2 + (rnd() < 0.45 ? 1 : 0);
        for (let ly = -2; ly <= r; ly++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
          const d = dx * dx + dz * dz + ly * ly * 1.3;
          if (d > r * r + 0.6) continue;
          if (d > (r - 0.7) * (r - 0.7) && rnd() < 0.3) continue;
          if (this.get(x + dx, top + ly, z + dz) === BL.AIR) this.set(x + dx, top + ly, z + dz, BL.LEAVES);
        }
      }
      for (let y = h; y < top + (pine ? 1 : 0); y++) this.set(x, y, z, BL.WOOD);
      this.trees.push({ x, z, h, yTop: top + (pine ? 2 : 3), rad: pine ? Math.round(th * 0.45) + 1 : 3, dead: false, felled: false });
      this.treeAt[x + z * sx] = this.trees.length;
      count++;
    }
  }

  _computeColTops() {
    const { sx, sy, sz } = this;
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      let y = sy - 1;
      while (y > 0 && this.data[this.idx(x, y, z)] === 0) y--;
      this.colTop[x + z * sx] = y;
    }
  }

  // Lift a tree out of the world from height fromY upward (the trunk below that stays as a stump).
  // Returns the removed voxels as flat [x, y, z, id, ...] plus the block bounds touched, or null.
  extractTree(idx, fromY) {
    const t = this.trees[idx];
    if (!t || t.dead) return null;
    const vox = [];
    const y0 = Math.max(fromY, t.h);
    for (let y = y0; y <= t.yTop + 1; y++) {
      if (this.get(t.x, y, t.z) === BL.WOOD) { vox.push(t.x, y, t.z, BL.WOOD); this.set(t.x, y, t.z, 0); }
    }
    if (!t.felled) {
      const R = t.rad + 1;
      for (let y = Math.max(y0, t.h + 1); y <= t.yTop + 1; y++) for (let dz = -R; dz <= R; dz++) for (let dx = -R; dx <= R; dx++) {
        const id = this.get(t.x + dx, y, t.z + dz);
        if (id === BL.LEAVES || id === BL.PINE) { vox.push(t.x + dx, y, t.z + dz, id); this.set(t.x + dx, y, t.z + dz, 0); }
      }
    }
    t.felled = true;
    if (fromY <= t.h) { t.dead = true; this.treeAt[t.x + t.z * this.sx] = 0; }
    return { vox, minX: t.x - t.rad - 2, maxX: t.x + t.rad + 2, minZ: t.z - t.rad - 2, maxZ: t.z + t.rad + 2 };
  }

  // Ground height a tank would drive on in one column: -1 for water. Leaves and standing trunks are ignored.
  _navCol(x, z) {
    const i = x + z * this.sx, tree = this.treeAt[i] !== 0;
    for (let y = this.colTop[i]; y >= 0; y--) {
      const id = this.data[x + this.sx * (z + this.sz * y)];
      if (!id || id === BL.LEAVES || id === BL.PINE || (tree && id === BL.WOOD)) continue;
      return id === BL.WATER ? -1 : y + 1;
    }
    return 0;
  }

  _computeNav() {
    const { sx, sz } = this;
    this.navH = new Int16Array(sx * sz);
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) this.navH[x + z * sx] = this._navCol(x, z);
  }

  recalcNav(minX, maxX, minZ, maxZ) {
    const x0 = Math.max(0, minX), x1 = Math.min(this.sx - 1, maxX), z0 = Math.max(0, minZ), z1 = Math.min(this.sz - 1, maxZ);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.navH[x + z * this.sx] = this._navCol(x, z);
  }

  // Nearest open, flat, tree-free grass to the map centre.
  findSpawn() {
    const cx = this.sx / 2, cz = this.sz / 2;
    let best = null, bestD = 1e9;
    for (const clear of [8, 5, 3]) {
      for (let z = 30; z < this.sz - 30; z += 2) for (let x = 30; x < this.sx - 30; x += 2) {
        const d = (x - cx) * (x - cx) + (z - cz) * (z - cz);
        if (d >= bestD) continue;
        const g = this.groundAt(x + 0.5, z + 0.5, this.sy);
        if (g.id !== BL.GRASS) continue;
        let ok = true;
        for (let dz = -clear; dz <= clear && ok; dz++) for (let dx = -clear; dx <= clear; dx++) {
          const top = this.colTop[x + dx + (z + dz) * this.sx] + 1;
          if (Math.abs(top - g.h) > 1 || this.get(x + dx, top - 1, z + dz) !== BL.GRASS) { ok = false; break; }
        }
        if (ok) { best = { x: x + 0.5, y: g.h, z: z + 0.5 }; bestD = d; }
      }
      if (best) return best;
    }
    return { x: cx, y: this.sy - 2, z: cz };
  }

  // ---------------------------------------------------------------- queries
  // Highest supporting surface at or below fromY. Leaves don't support (tank pushes through them).
  groundAt(x, z, fromY) {
    const ix = Math.floor(x), iz = Math.floor(z);
    if (ix < 0 || iz < 0 || ix >= this.sx || iz >= this.sz) return { h: 999, id: -1 };
    let y = Math.min(this.sy - 1, Math.floor(fromY));
    for (; y >= 0; y--) {
      const id = this.data[ix + this.sx * (iz + this.sz * y)];
      if (id && id !== BL.LEAVES && id !== BL.PINE) return { h: y + 1, id };
    }
    return { h: 0, id: BL.BEDROCK };
  }

  isSolid(x, y, z) {
    const id = this.get(Math.floor(x), Math.floor(y), Math.floor(z));
    return id !== 0 && id !== BL.WATER;
  }

  // DDA voxel raycast. dir must be normalized. Returns {id,x,y,z,t,px,py,pz,face} or null.
  raycast(ox, oy, oz, dx, dy, dz, maxD, skipLeaves = false, skipWater = false) {
    let x = Math.floor(ox), y = Math.floor(oy), z = Math.floor(oz);
    const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? (x + 1 - ox) : (ox - x)) * tdx : Infinity;
    let tmy = dy !== 0 ? (dy > 0 ? (y + 1 - oy) : (oy - y)) * tdy : Infinity;
    let tmz = dz !== 0 ? (dz > 0 ? (z + 1 - oz) : (oz - z)) * tdz : Infinity;
    let t = 0, face = -1;
    for (let i = 0; i < 2000; i++) {
      const id = this.get(x, y, z);
      if (id && !(skipLeaves && (id === BL.LEAVES || id === BL.PINE)) && !(skipWater && id === BL.WATER)) {
        return { id, x, y, z, t, px: ox + dx * t, py: oy + dy * t, pz: oz + dz * t, face };
      }
      if (tmx < tmy && tmx < tmz) { x += stepX; t = tmx; tmx += tdx; face = 0; }
      else if (tmy < tmz) { y += stepY; t = tmy; tmy += tdy; face = 1; }
      else { z += stepZ; t = tmz; tmz += tdz; face = 2; }
      if (t > maxD) return null;
      if (y >= this.sy && dy >= 0) return null;
      if ((x < -1 && dx <= 0) || (x > this.sx && dx >= 0) || (z < -1 && dz <= 0) || (z > this.sz && dz >= 0)) return null;
    }
    return null;
  }

  // Blast a roughly spherical crater. Returns removed voxels and affected bounds.
  explode(cx, cy, cz, r, rnd = Math.random) {
    const removed = [];
    const R = Math.ceil(r + 1.5);
    const bx = Math.floor(cx), by = Math.floor(cy), bz = Math.floor(cz);
    for (let y = by - R; y <= by + R; y++) for (let z = bz - R; z <= bz + R; z++) for (let x = bx - R; x <= bx + R; x++) {
      if (y <= 0) continue;
      const id = this.get(x, y, z);
      if (!id || id === BL.WATER || id === BL.BEDROCK) continue;
      const dx = x + 0.5 - cx, dy = (y + 0.5 - cy) * 1.15, dz = z + 0.5 - cz;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const tough = id === BL.CONCRETE || id === BL.STEEL;   // built structures shrug off most of a blast
      if (d < r * (tough ? 0.5 : 0.8 + rnd() * 0.35)) {
        removed.push(x, y, z, id);
        this.set(x, y, z, 0);
      } else if (d < r + 1.3 && rnd() < 0.65 &&
        (id === BL.GRASS || id === BL.DIRT || id === BL.SAND || id === BL.STONE || id === BL.SNOW || id === BL.BRICK)) {
        this.set(x, y, z, BL.SCORCH);
      }
    }
    return { removed, minX: bx - R - 1, maxX: bx + R + 1, minZ: bz - R - 1, maxZ: bz + R + 1 };
  }

  // ---------------------------------------------------------------- meshing
  blockColor(id, x, y, z, f, out) {
    const c = BLOCK_COLORS[id];
    let j = 0.92 + hash3(x, y, z) * 0.16;
    if (id === BL.GRASS || id === BL.LEAVES || id === BL.PINE) j *= this.tint[x + z * this.sx] || 1;
    let r = c[0], g = c[1], b = c[2];
    if (id === BL.GRASS && f !== 2) { r = 104; g = 112; b = 60; } // grass side
    if (id === BL.WATER) { j = 0.96 + hash3(x, 0, z) * 0.08; }
    out[0] = Math.min(255, r * j); out[1] = Math.min(255, g * j); out[2] = Math.min(255, b * j);
  }

  buildChunk(B, cx, cz) {
    B.reset();
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const x1 = Math.min(x0 + CHUNK, this.sx), z1 = Math.min(z0 + CHUNK, this.sz);
    let top = 0;
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) top = Math.max(top, this.colTop[x + z * this.sx]);
    const W = BL.WATER;
    const get = (x, y, z) => this.get(x, y, z);
    meshVoxels(B, get, x0, 0, z0, x1, Math.min(this.sy, top + 1), z1,
      (id, x, y, z, f, out) => this.blockColor(id, x, y, z, f, out),
      id => id !== 0 && id !== W,
      (id, nid) => id === W ? nid === 0 : (nid === 0 || nid === W),
      id => id === W,
      1, 0, 0, 0);
  }
}
