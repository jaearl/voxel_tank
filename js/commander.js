// The enemy commander: an AI that plays by the player's rules. It drives and shoots, collects scrap
// crates, builds turrets and walls at its base, knocks out roaming tanks and recruits them, gives its
// squad orders, repairs itself with scrap (standing still while it does), raids, and plays the flag.
'use strict';

class Commander extends Bot {
  constructor(tank, faction) {
    super(tank);
    this.faction = faction;
    tank.isCmd = true;
    this.spread = 1.5;
    this.lead = true;                         // aims ahead of moving targets
    this.planT = 0.5;
    this.mode = 'patrol'; this.mGoal = null; this.mStop = 4;
    this.attackT = 60 + Math.random() * 50;   // countdown to the next raid
    this.attackLeft = 0;                      // seconds the current raid has left
    this.buildT = 0;
    this.seed = Math.random() * 6.283;
    this.patrol = null;
    this.strafeDir = 1; this.strafeT = 0; this.sg = [0, 0];
    this._rollErr();
  }

  _frozen() { return this.faction.healing; }

  _set(mode, goal, stop) { this.mode = mode; this.mGoal = goal; this.mStop = stop; }

  _canSee(G, e) {
    const p = e.hitPos(), o = this.tank.gunPivot;
    const vx = p[0] - o[0], vy = p[1] - o[1], vz = p[2] - o[2], d = Math.hypot(vx, vy, vz) || 1;
    const hit = G.world.raycast(o[0], o[1], o[2], vx / d, vy / d, vz / d, d, true, true);
    return !hit || hit.t > d - 2.6;
  }

  // Target choice: not just the nearest. It favours the other commander and whatever is closest to
  // dying, and of its top picks takes the first one it has a clear shot at.
  _think(G) {
    const T = this.tank, list = [];
    for (const e of G.ents) {
      if (e.side === T.side || e.disabled || !e.alive) continue;
      const d = Math.hypot(e.x - T.x, e.z - T.z);
      if (d >= BOT.SIGHT) continue;
      list.push([d - (e.isCmd ? 18 : 0) - (1 - e.hp / e.maxHp) * 22, e]);
    }
    list.sort((a, b) => a[0] - b[0]);
    this.target = null; this.los = false;
    for (let i = 0; i < Math.min(3, list.length); i++) {
      const e = list[i][1], see = this._canSee(G, e);
      if (!this.target) { this.target = e; this.los = see; }
      if (see) { this.target = e; this.los = true; break; }
    }
  }

  // Strategy, once a second. G.api is the same set of actions the player has.
  _plan(G) {
    const F = this.faction, T = this.tank, A = G.api, home = F.home, E = A.enemyOf(F);
    const hpF = T.hp / T.maxHp, seen = !!this.target && this.los;
    const lms = G.mode === 'lms';
    const canHeal = CFG.healCost > 0 ? F.scrap >= 8 : true;

    // ---- repairs: only once it has broken contact, unless it is about to die anyway
    if (F.healing) {
      if (hpF >= 0.97 || F.scrap < 1 || (seen && hpF > 0.6)) A.setHeal(F, false);
      return;
    }
    if (hpF < 0.55 && canHeal && (!seen || hpF < 0.22)) { A.setHeal(F, true); return; }

    A.recruit(F);   // does nothing unless a knocked-out tank is right alongside
    const squad = A.squadOf(F);
    const dHome = Math.hypot(T.x - home.x, T.z - home.z);

    // is the other side at its base?
    let homeThreat = false;
    for (const e of G.ents) if (e.side === E.side && Math.hypot(e.x - home.x, e.z - home.z) < 48) { homeThreat = true; break; }

    // ---- raids: sooner with a bigger squad; in last man standing only when the odds look good
    if (this.attackLeft > 0) this.attackLeft--;
    else {
      this.attackT -= 1 + squad.length * 0.25;
      if (this.attackT <= 0 && hpF > 0.65 && (!lms || squad.length >= 2 || T.hp >= E.cmd.hp)) {
        this.attackLeft = 60 + Math.random() * 40;
        this.attackT = (80 + Math.random() * 70) * (G.flags ? 0.5 : 1);
      }
    }

    const nT = A.turretsOf(F).length;
    const wantT = nT < CFG.maxTurrets && F.scrap >= CFG.turretCost * (nT < 4 ? 1 : 2.5);   // extra turrets only when flush
    const wantW = !wantT && F.walls < 5 && nT >= Math.min(CFG.maxTurrets, 2) && F.scrap >= CFG.wallCost + CFG.turretCost * 0.4;
    // tank upgrades once the base has a couple of turrets: cheapest level first, keeping turret money back
    let upK = null, upC = 1e9;
    for (const k of ['armour', 'gun', 'loader', 'engine']) { const c = A.upCost(F, k); if (c < upC) { upC = c; upK = k; } }
    const wantU = !!upK && nT >= Math.min(CFG.maxTurrets, 2) && F.scrap >= upC + (nT < Math.min(CFG.maxTurrets, 4) ? CFG.turretCost : 0);
    const room = squad.length < CFG.maxSquad;
    const rec = room ? A.recruitable(F, 130) : null;

    // capture the flag: bring theirs home, fetch ours back, chase whoever has it, go for theirs on a raid
    let ctf = null, mine = null;
    if (G.flags) {
      mine = G.flags[F.side];
      const theirs = G.flags[E.side];
      if (theirs.state === 'carried' && theirs.carrier === F) ctf = ['score', [mine.sx, mine.sz], 1];
      else if (mine.state === 'dropped') ctf = ['return', [mine.x, mine.z], 1];
      else if (mine.state === 'carried') ctf = ['chase', [mine.x, mine.z], 25];
      else if (this.attackLeft > 0 && hpF > 0.45) ctf = ['flag', [theirs.x, theirs.z], 1];
    }

    const hs = [home.x + 0.5, home.z - 6.5];
    if (ctf && ctf[0] === 'score') this._set('score', ctf[1], ctf[2]);
    // badly hurt, or hurt and under fire with scrap to spend: fall back to its turrets and get out of sight
    else if (hpF < (lms ? 0.4 : 0.3) || (hpF < 0.55 && seen && canHeal)) this._set('retreat', hs, 5);
    else if (ctf && ctf[0] !== 'flag') this._set(ctf[0], ctf[1], ctf[2]);
    else if (homeThreat && dHome > 40) this._set('defend', hs, 14);
    else if (rec) this._set('recruit', [rec.tank.x, rec.tank.z], 6);
    else if (wantT || wantW) {
      this._set('build', hs, 6);
      if (dHome < 24 && --this.buildT <= 0) {
        this.buildT = 2;
        const toward = Math.atan2(E.home.x - home.x, E.home.z - home.z);
        for (let i = 0; i < 8; i++) {
          // first tries face the enemy's side of the base (or cover the flag), then anywhere that fits
          const a = i < 4 ? toward + (Math.random() - 0.5) * 3 : Math.random() * 6.283;
          if (wantT) {
            const c = mine && nT % 2 === 1 ? [mine.sx, mine.sz, 6] : [home.x, home.z, 8.5];
            if (A.build(F, 'turret', c[0] + Math.sin(a) * c[2], c[1] + Math.cos(a) * c[2], false)) break;
          } else {
            const r = 15 + Math.random() * 3;   // just outside the ramparts, side-on to the base
            if (A.build(F, 'wall', home.x + Math.sin(a) * r, home.z + Math.cos(a) * r, Math.abs(Math.cos(a)) >= Math.abs(Math.sin(a)))) break;
          }
        }
      }
    } else if (wantU) {
      this._set('build', hs, 6);          // upgrades are fitted at home
      if (dHome < 18) A.upgrade(F, upK);
    } else if (ctf) this._set('flag', ctf[1], ctf[2]);
    else if (this.attackLeft > 0 && hpF > 0.45) {
      // go for the commander; if he's dead, knock down his nearest turret; failing that, sit on his base
      let t = E.cmd.alive ? E.cmd : null;
      if (!t) { let bd = 1e9; for (const tr of A.turretsOf(E)) { const d = Math.hypot(tr.x - T.x, tr.z - T.z); if (d < bd) { bd = d; t = tr; } } }
      if (!t) t = E.home;
      this._set('attack', [t.x, t.z], 30);
    } else {
      // squad not full and fit to fight: go and knock out a roaming tank to recruit
      let prey = null, pd = 150;
      if (room && hpF > 0.6) for (const e of G.ents) {
        if (e.side !== 'rogue' || e.disabled) continue;
        const d = Math.hypot(e.x - T.x, e.z - T.z);
        if (d < pd) { pd = d; prey = e; }
      }
      // otherwise the nearest scrap crate
      let crate = null, cd = 170;
      for (const c of G.crates) { const d = Math.hypot(c.x - T.x, c.z - T.z); if (d < cd) { cd = d; crate = c; } }
      if (prey && (!crate || pd < cd * 1.5 || F.scrap > CFG.turretCost * 2)) this._set('hunt', [prey.x, prey.z], 36);
      else if (crate) this._set('gather', [crate.x, crate.z], 0.6);
      else {
        if (!this.patrol || Math.hypot(this.patrol[0] - T.x, this.patrol[1] - T.z) < 6) this.patrol = G.nav.randomNear(home.x, home.z, 8, 35) || hs;
        this._set('patrol', this.patrol, 4);
      }
    }

    // ---- squad orders: everyone comes along on a raid; otherwise half stay to guard the base (or the flag)
    const out = this.mode === 'attack' || this.mode === 'flag' || this.mode === 'score' || this.mode === 'chase';
    const guards = out ? 0 : Math.floor((squad.length + (mine ? 1 : 0)) / 2);
    const gc = mine ? [mine.sx, mine.sz] : [home.x, home.z];
    squad.forEach((b, i) => {
      if (i < guards) {
        if (b.order !== 'defend') { const a = this.seed + i * 2.4, r = 8 + (i % 3) * 3; b.setOrder('defend', [gc[0] + Math.sin(a) * r, gc[1] + Math.cos(a) * r]); }
      } else if (b.order !== 'follow') b.setOrder('follow');
    });
  }

  _goal(dt, G, tg) {
    this.planT -= dt;
    if (this.planT <= 0) { this.planT = 1; this._plan(G); }
    // When it has a shot and nothing more urgent to do it fights, but never sitting still: it keeps
    // crossing the target's line of fire, holding about 32 blocks off.
    const busy = this.mode === 'retreat' || this.mode === 'recruit' || this.mode === 'score' || this.mode === 'return' || this.mode === 'flag';
    if (tg && this.los && !busy) {
      const T = this.tank, dx = tg.x - T.x, dz = tg.z - T.z, d = Math.hypot(dx, dz) || 1;
      if (d <= 48) {
        this.strafeT -= dt;
        if (this.strafeT <= 0) { this.strafeT = 2.5 + Math.random() * 3; if (Math.random() < 0.5) this.strafeDir = -this.strafeDir; }
        const ux = dx / d, uz = dz / d, k = this.strafeDir, r = d < 26 ? -0.6 : d > 38 ? 0.6 : 0;
        const gx = T.x + (-uz * k + ux * r) * 10, gz = T.z + (ux * k + uz * r) * 10;
        if (G.nav.ok(gx, gz)) { this.sg[0] = gx; this.sg[1] = gz; return [this.sg, 2]; }
        this.strafeDir = -k;      // blocked that way: try the other side next frame
        return NO_GOAL;
      }
    }
    return [this.mGoal, this.mStop];
  }
}
