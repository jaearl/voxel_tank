// Navigation grid + A* so bot tanks route round water, cliffs, walls and rocks instead of bumping into them.
// A cell is NAV_CS x NAV_CS blocks. It is drivable when the ground under it (plus a one block margin)
// is dry and has no step taller than one block. Trees don't count: tanks knock them over.
'use strict';

const NAV_CS = 4;

class Nav {
  constructor(world) {
    this.W = world;
    this.nx = Math.ceil(world.sx / NAV_CS);
    this.nz = Math.ceil(world.sz / NAV_CS);
    const n = this.nx * this.nz;
    this.walk = new Uint8Array(n);
    this.ch = new Int16Array(n);        // average ground height of the cell
    this.gs = new Float32Array(n); this.fs = new Float32Array(n);
    this.from = new Int32Array(n);
    this.seen = new Uint32Array(n); this.closed = new Uint32Array(n);
    this.sid = 0;
    this.heap = [];
    for (let cz = 0; cz < this.nz; cz++) for (let cx = 0; cx < this.nx; cx++) this._cell(cx, cz);
  }

  _cell(cx, cz) {
    const W = this.W, H = W.navH, sx = W.sx, i = cx + cz * this.nx;
    const x0 = cx * NAV_CS - 1, z0 = cz * NAV_CS - 1, x1 = x0 + NAV_CS + 2, z1 = z0 + NAV_CS + 2;
    this.walk[i] = 0; this.ch[i] = 0;
    if (x0 < 3 || z0 < 3 || x1 > W.sx - 3 || z1 > W.sz - 3) return;
    let sum = 0;
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const h = H[x + z * sx];
      if (h < 0) return;
      if (x + 1 < x1 && Math.abs(h - H[x + 1 + z * sx]) > 1) return;
      if (z + 1 < z1 && Math.abs(h - H[x + (z + 1) * sx]) > 1) return;
      sum += h;
    }
    this.walk[i] = 1;
    this.ch[i] = Math.round(sum / ((NAV_CS + 2) * (NAV_CS + 2)));
  }

  // Re-evaluate the cells touching a block region after the world changed there.
  update(minX, maxX, minZ, maxZ) {
    const c0 = Math.max(0, Math.floor((minX - 2) / NAV_CS)), c1 = Math.min(this.nx - 1, Math.floor((maxX + 2) / NAV_CS));
    const d0 = Math.max(0, Math.floor((minZ - 2) / NAV_CS)), d1 = Math.min(this.nz - 1, Math.floor((maxZ + 2) / NAV_CS));
    for (let cz = d0; cz <= d1; cz++) for (let cx = c0; cx <= c1; cx++) this._cell(cx, cz);
  }

  cellOf(x, z) {
    const cx = Math.floor(x / NAV_CS), cz = Math.floor(z / NAV_CS);
    if (cx < 0 || cz < 0 || cx >= this.nx || cz >= this.nz) return -1;
    return cx + cz * this.nx;
  }

  ok(x, z) { const c = this.cellOf(x, z); return c >= 0 && this.walk[c] === 1; }

  // Closest drivable cell to (x, z) within maxR cells, or -1.
  nearestWalk(x, z, maxR) {
    const cx = Math.floor(x / NAV_CS), cz = Math.floor(z / NAV_CS);
    for (let r = 0; r <= maxR; r++) {
      let best = -1, bd = 1e9;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const ax = cx + dx, az = cz + dz;
        if (ax < 0 || az < 0 || ax >= this.nx || az >= this.nz || !this.walk[ax + az * this.nx]) continue;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; best = ax + az * this.nx; }
      }
      if (best >= 0) return best;
    }
    return -1;
  }

  center(c) { return [(c % this.nx + 0.5) * NAV_CS, (Math.floor(c / this.nx) + 0.5) * NAV_CS]; }

  // A random drivable point between rMin and rMax blocks from (x, z), or null.
  randomNear(x, z, rMin, rMax, tries = 24) {
    for (let i = 0; i < tries; i++) {
      const a = Math.random() * Math.PI * 2, r = rMin + Math.random() * (rMax - rMin);
      const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
      if (this.ok(px, pz)) return this.center(this.cellOf(px, pz));
    }
    return null;
  }

  // Is the straight line between two points drivable all the way?
  clearLine(ax, az, bx, bz) {
    const d = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(d / 1.5));
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (!this.ok(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
    }
    return true;
  }

  _push(i) {
    const h = this.heap, f = this.fs;
    let p = h.length; h.push(i);
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (f[h[q]] <= f[i]) break;
      h[p] = h[q]; p = q;
    }
    h[p] = i;
  }
  _pop() {
    const h = this.heap, f = this.fs, top = h[0], last = h.pop();
    const n = h.length;
    if (n) {
      let p = 0;
      for (;;) {
        let c = p * 2 + 1;
        if (c >= n) break;
        if (c + 1 < n && f[h[c + 1]] < f[h[c]]) c++;
        if (f[h[c]] >= f[last]) break;
        h[p] = h[c]; p = c;
      }
      h[p] = last;
    }
    return top;
  }

  // Route from (x0, z0) to (x1, z1) as a short list of [x, z] waypoints, or null when there is none.
  // If the goal can't be reached within the search budget the route leads as close as it got.
  path(x0, z0, x1, z1, maxNodes = 5000) {
    const s = this.nearestWalk(x0, z0, 3), g = this.nearestWalk(x1, z1, 6);
    if (s < 0 || g < 0) return null;
    if (s === g) return [[x1, z1]];
    const nx = this.nx, nz = this.nz, walk = this.walk, ch = this.ch, gs = this.gs, fs = this.fs;
    const seen = this.seen, closed = this.closed, from = this.from, sid = ++this.sid;
    const gx = g % nx, gz = Math.floor(g / nx);
    const heur = i => { const dx = Math.abs(i % nx - gx), dz = Math.abs(Math.floor(i / nx) - gz); return dx + dz - 0.586 * Math.min(dx, dz); };
    this.heap.length = 0;
    gs[s] = 0; fs[s] = heur(s); seen[s] = sid; from[s] = -1; this._push(s);
    let best = s, bestH = fs[s], n = 0, found = false;
    while (this.heap.length) {
      const c = this._pop();
      if (closed[c] === sid) continue;
      closed[c] = sid;
      if (c === g) { found = true; break; }
      if (++n > maxNodes) break;
      const cx = c % nx, cz = Math.floor(c / nx);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const ax = cx + dx, az = cz + dz;
        if (ax < 0 || az < 0 || ax >= nx || az >= nz) continue;
        const ni = ax + az * nx;
        if (!walk[ni] || closed[ni] === sid || Math.abs(ch[ni] - ch[c]) > 4) continue;
        if (dx && dz && (!walk[c + dx] || !walk[c + dz * nx])) continue;   // no cutting corners
        const ng = gs[c] + (dx && dz ? 1.414 : 1);
        if (seen[ni] === sid && ng >= gs[ni]) continue;
        seen[ni] = sid; gs[ni] = ng; from[ni] = c;
        const hh = heur(ni);
        fs[ni] = ng + hh;
        if (hh < bestH) { bestH = hh; best = ni; }
        this._push(ni);
      }
    }
    const end = found ? g : best;
    if (end === s) return null;
    const pts = [];
    for (let i = end; i !== -1 && i !== s; i = from[i]) pts.push(this.center(i));
    pts.reverse();
    if (found && this.cellOf(x1, z1) === g) pts[pts.length - 1] = [x1, z1];
    // drop waypoints that a straight drivable line makes unnecessary
    const out = [];
    let ax = x0, az = z0, i = 0;
    while (i < pts.length) {
      let j = i;
      for (let k = Math.min(pts.length - 1, i + 10); k > i; k--) if (this.clearLine(ax, az, pts[k][0], pts[k][1])) { j = k; break; }
      out.push(pts[j]); ax = pts[j][0]; az = pts[j][1]; i = j + 1;
    }
    return out;
  }
}
