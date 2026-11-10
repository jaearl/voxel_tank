// Game bootstrap: menus, input, third-person camera, main loop, combat, building, HUD.
'use strict';

(function () {
  const $ = id => document.getElementById(id);
  const canvas = $('c');
  const overlay = $('overlay'), goBtn = $('go');
  const gunMark = $('gunmark'), reloadFill = $('reloadfill'), infoEl = $('info'), fpsEl = $('fps');
  const hpFill = $('hpfill'), statsEl = $('stats'), foeEl = $('foe'), msgEl = $('msg'), promptEl = $('prompt');
  const b1 = $('b1'), b2 = $('b2'), b3 = $('b3'), tagsEl = $('tags'), mapEl = $('map'), goalEl = $('goal');

  let renderer;
  try { renderer = new Renderer(canvas); }
  catch (e) { goBtn.textContent = 'Could not start: ' + e.message; goBtn.disabled = true; return; }

  // ---- fixed tuning (the rest is in CFG, see config.js)
  const BUILD_RANGE = 42;
  const SPLASH_R = 5;
  const HEAL_RATE = 25;       // armour per second while repairing
  const VIEW_DIST = 380;      // fog has swallowed everything past this
  const MAX_FALLEN = 40;

  const SUN = V3.norm([0.45, 0.8, 0.35]);
  const FOG = [0.63, 0.78, 0.92];
  const FOG_DEN = 0.0062;
  const IDENT = M4.create();
  const NOKEYS = {};

  let world, nav, tank, effects, blue, red = null;
  const chunks = [];
  const bots = [];        // every non-commander tank: rogues and both squads
  const turrets = [];
  const crates = [];
  const fallen = [];
  const factions = [];
  const dirty = new Set();
  const builder = new MeshBuilder(32768);
  let started = false, ready = false, locked = false;
  let maxCrates = 28;

  let buildMode = null, wallFlip = false, plan = null;
  let over = false;                       // someone has won: the fighting stops
  let flags = null;                       // capture the flag: { blue: flag, red: flag }
  const score = { blue: 0, red: 0 };
  let flagItem, flagB, beaconItem, beaconB;
  let spawnT = 10, crateT = 15, msgT = 0;
  let ents = [];
  const G = {
    world: null, nav: null, effects: null, ents, cmds: [], crates, pathBudget: 0, api: null,
    farFromView: t => Math.hypot(t.x - tank.x, t.z - tank.z) > 70,
  };

  // camera state
  let camYaw = 0, camPitch = -0.22, camDist = 13, camCur = 13, shake = 0;
  const keys = {};
  let fireQueued = false, fireHeld = false;
  let D = [0, 0, 1], aimHit = null;

  const proj = M4.create(), view = M4.create(), vp = M4.create();
  const lightV = M4.create(), lightP = M4.create(), lightVP = M4.create();

  let ghost, crateItem, crateB, cratesDirty = true;
  const tags = [];
  const mapTerrain = document.createElement('canvas');
  const mctx = mapEl.getContext('2d');
  let mapT = 0;

  function say(text, secs = 3.5) { msgEl.textContent = text; msgEl.style.opacity = 1; msgT = secs; }

  // ------------------------------------------------------------------ world edits
  function remeshChunk(cx, cz) {
    world.buildChunk(builder, cx, cz);
    renderer.updateMesh(chunks[cx + cz * world.chunksX].mesh, builder);
  }
  // Call after changing blocks: refreshes pathfinding now and queues the chunk meshes for this frame.
  function touched(minX, maxX, minZ, maxZ) {
    world.recalcNav(minX, maxX, minZ, maxZ);
    nav.update(minX, maxX, minZ, maxZ);
    const cx0 = Math.max(0, Math.floor(minX / CHUNK)), cx1 = Math.min(world.chunksX - 1, Math.floor(maxX / CHUNK));
    const cz0 = Math.max(0, Math.floor(minZ / CHUNK)), cz1 = Math.min(world.chunksZ - 1, Math.floor(maxZ / CHUNK));
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) dirty.add(cx + cz * world.chunksX);
  }
  function flushDirty() {
    for (const i of dirty) remeshChunk(i % world.chunksX, Math.floor(i / world.chunksX));
    dirty.clear();
  }

  // ------------------------------------------------------------------ factions
  function makeFaction(side, cmdTeam, squadTeam, home) {
    const F = { side, cmdTeam, squadTeam, home, cmd: null, ai: null, scrap: CFG.startScrap, healing: false, deadT: 0, walls: 0 };
    factions.push(F);
    return F;
  }
  const factionOf = side => factions.find(F => F.side === side) || null;
  const squadOf = F => bots.filter(b => b.faction === F && b.tank.alive);
  const turretsOf = F => turrets.filter(t => t.faction === F && t.alive);
  const rogues = () => bots.filter(b => !b.faction && b.tank.alive);
  const homeSpot = F => [F.home.x + 0.5, F.home.z - 6.5];

  function init() {
    if (CFG.mode !== 'skirmish') CFG.commander = true;
    const size = MAP_SIZES[CFG.mapSize] || 512;
    const seed = CFG.randomMap ? (Math.random() * 1e9) | 0 : 1337;
    world = new World(size, 64, size, seed);
    world.generate();
    nav = new Nav(world);
    G.world = world; G.nav = nav;
    for (let cz = 0; cz < world.chunksZ; cz++) for (let cx = 0; cx < world.chunksX; cx++) {
      chunks[cx + cz * world.chunksX] = {
        mesh: renderer.createMesh(null), model: IDENT, shadow: true,
        x: cx * CHUNK + CHUNK / 2, z: cz * CHUNK + CHUNK / 2,
      };
      remeshChunk(cx, cz);
    }
    effects = new Effects(renderer, world);
    G.effects = effects;

    // homes: you get the site nearest the middle, the enemy commander the one farthest from you
    let home = world.sites[0];
    if (!home) { const sp = world.findSpawn(); home = { x: Math.floor(sp.x), z: Math.floor(sp.z) + 6, h: sp.y, r: 0 }; }
    blue = makeFaction('blue', 'player', 'ally', home);
    tank = new Tank(renderer, world, home.x + 0.5, home.h, home.z - 6.5, 'player');
    tank.hp = tank.maxHp = CFG.playerHp; tank.isCmd = true;
    blue.cmd = tank;

    if (CFG.commander) {
      let rh = null, bd = 0;
      for (const s of world.sites) { const d = Math.hypot(s.x - home.x, s.z - home.z); if (d > bd) { bd = d; rh = s; } }
      if (!rh || bd < 80) {
        const sp = findOpenSpot(world, home.x, home.z, size * 0.3, size * 0.45);
        if (sp) rh = { x: Math.floor(sp.x), z: Math.floor(sp.z) + 6, h: sp.y, r: 0 };
      }
      if (rh) {
        red = makeFaction('red', 'redcmd', 'redsquad', rh);
        const rt = new Tank(renderer, world, rh.x + 0.5, rh.h, rh.z - 6.5, 'redcmd');
        rt.hp = rt.maxHp = CFG.playerHp;
        red.cmd = rt;
        red.ai = new Commander(rt, red);
      }
    }

    G.api = {
      squadOf, turretsOf,
      enemyOf: F => (F === blue ? red : blue),
      recruitable: recruitableFor,
      recruit: F => { const b = recruitableFor(F, BOT.RECRUIT_RANGE); return !!b && doRecruit(F, b); },
      setHeal: (F, on) => { F.healing = on; },
      build(F, kind, x, z, alongX) {
        if (Math.hypot(x - F.cmd.x, z - F.cmd.z) > BUILD_RANGE) return false;
        const bx = Math.floor(x), bz = Math.floor(z);
        const p = planAt(F, kind, bx, bz, world.navH[bx + bz * world.sx], alongX);
        if (p.ok) doBuild(F, p);
        return p.ok;
      },
    };

    // game mode (falls back to skirmish if no enemy commander could be placed)
    G.mode = red ? CFG.mode : 'skirmish';
    if (G.mode === 'ctf') {
      flags = {};
      for (const F of factions) {   // each flag stands just behind its base's flagpole
        const sx = F.home.x + 0.5, sz = F.home.z + 5.5, sy = world.groundAt(sx, sz, world.sy).h;
        flags[F.side] = { owner: F, sx, sy, sz, x: sx, y: sy, z: sz, state: 'home', carrier: null, dropT: 0 };
      }
    }
    G.flags = flags;
    flagB = new MeshBuilder(1024); beaconB = new MeshBuilder(1024);
    flagItem = { mesh: renderer.createMesh(null, true), model: IDENT, shadow: true };
    beaconItem = { mesh: renderer.createMesh(null, true), model: IDENT, shadow: false, blend: true };

    ghost = { mesh: renderer.createMesh(null, true), model: IDENT, shadow: false, blend: true, B: new MeshBuilder(1024) };
    crateB = new MeshBuilder(2048);
    crateItem = { mesh: renderer.createMesh(null, true), model: IDENT, shadow: true };

    // a couple of crates at every base site, the rest scattered
    maxCrates = Math.round(7 * world.area);
    for (const s of world.sites) for (const a of [0.9, 4.0]) addCrate(s.x + Math.sin(a) * 7 + 0.5, s.z + Math.cos(a) * 7 + 0.5);
    for (let i = 0; i < Math.round(3.5 * world.area); i++) spawnCrate();
    for (let i = 0; i < Math.min(3, CFG.maxEnemies); i++) spawnRogue();

    for (let i = 0; i < 32; i++) {
      const el = document.createElement('div');
      el.className = 'tag';
      el.innerHTML = '<span></span><div class="tagbar"><div></div></div>';
      tagsEl.appendChild(el);
      tags.push({ el, txt: el.firstChild, fill: el.lastChild.firstChild });
    }
    bakeMap();
    $('hud').style.display = '';
    ready = true;
    applyCfg();
    window.__game = {
      world, nav, tank, effects, keys, bots, turrets, crates, fallen, blue, red, CFG, score,
      get flags() { return flags; }, get over() { return over; },
      setCam(y, p) { camYaw = y; camPitch = p; }, click() { fireQueued = true; }, spawnRogue, tick,
    };
  }

  // ------------------------------------------------------------------ crates & spawning
  function addCrate(x, z) {
    const g = world.groundAt(x, z, world.sy);
    if (g.id === BL.WATER || g.h <= WATER_LEVEL) return;
    crates.push({ x, y: g.h, z });
    cratesDirty = true;
  }
  function spawnCrate() {
    const p = findOpenSpot(world, world.sx / 2, world.sz / 2, 0, world.sx * 0.45);
    if (p && nav.ok(p.x, p.z)) addCrate(p.x, p.z);
  }
  // A roaming tank appears somewhere out of sight of both commanders (or at the given range from you).
  function spawnRogue(rMin, rMax) {
    let p = null;
    if (rMin !== undefined) p = findOpenSpot(world, tank.x, tank.z, rMin, rMax);
    else for (let i = 0; i < 12 && !p; i++) {
      const q = findOpenSpot(world, world.sx / 2, world.sz / 2, 0, world.sx * 0.45);
      if (q && nav.ok(q.x, q.z) && factions.every(F => Math.hypot(q.x - F.cmd.x, q.z - F.cmd.z) > 95)) p = q;
    }
    if (!p) return null;
    const t = new Tank(renderer, world, p.x, p.y, p.z, 'enemy');
    t.hp = t.maxHp = CFG.botHp;
    t.maxFwd = 7.5; t.reloadTime = 3.3;
    t.yaw = Math.random() * Math.PI * 2;
    const b = new Bot(t);
    bots.push(b);
    return b;
  }

  // ------------------------------------------------------------------ menus
  const setInputs = {};
  function buildMenu() {
    const sizes = $('sizes');
    for (const name in MAP_SIZES) {
      const b = document.createElement('button');
      b.textContent = name[0].toUpperCase() + name.slice(1);
      b.dataset.size = name;
      b.addEventListener('click', () => { if (!started) { CFG.mapSize = name; saveCfg(); refreshMenu(); } });
      sizes.appendChild(b);
    }
    const modes = $('modes');
    for (const name in MODES) {
      const b = document.createElement('button');
      b.textContent = MODES[name];
      b.dataset.mode = name;
      b.addEventListener('click', () => { if (!started) { CFG.mode = name; if (name !== 'skirmish') CFG.commander = true; saveCfg(); refreshMenu(); } });
      modes.appendChild(b);
    }
    $('cmdchk').addEventListener('change', e => { CFG.commander = e.target.checked; saveCfg(); });
    $('rndchk').addEventListener('change', e => { CFG.randomMap = e.target.checked; saveCfg(); });
    const box = $('settings');
    for (const s of CFG_SCHEMA) {
      const row = document.createElement('label');
      row.className = 'set';
      const name = document.createElement('span'); name.textContent = s.label;
      const inp = document.createElement('input');
      inp.type = 'range'; inp.min = s.min; inp.max = s.max; inp.step = s.step;
      const val = document.createElement('b');
      inp.addEventListener('input', () => { CFG[s.k] = +inp.value; val.textContent = inp.value; saveCfg(); applyCfg(); });
      row.append(name, inp, val);
      box.appendChild(row);
      setInputs[s.k] = { inp, val, s, row };
    }
    goBtn.addEventListener('click', () => {
      if (over) { location.reload(); return; }
      if (!started) startGame();
      else if (ready) { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); }
    });
    $('defaults').addEventListener('click', () => {
      const size = CFG.mapSize, cmd = CFG.commander, rnd = CFG.randomMap, scrap = CFG.startScrap, mode = CFG.mode;
      resetCfg();
      if (started) { CFG.mode = mode; CFG.mapSize = size; CFG.commander = cmd; CFG.randomMap = rnd; CFG.startScrap = scrap; }
      saveCfg(); refreshMenu(); applyCfg();
    });
    $('quit').addEventListener('click', () => location.reload());
    refreshMenu();
  }
  function refreshMenu() {
    for (const b of $('sizes').children) { b.className = b.dataset.size === CFG.mapSize ? 'on' : ''; b.disabled = started; }
    for (const b of $('modes').children) { b.className = b.dataset.mode === CFG.mode ? 'on' : ''; b.disabled = started; }
    $('cmdchk').checked = CFG.commander || CFG.mode !== 'skirmish';
    $('cmdchk').disabled = started || CFG.mode !== 'skirmish';   // the other modes are played against the commander
    $('rndchk').checked = CFG.randomMap; $('rndchk').disabled = started;
    for (const k in setInputs) {
      const { inp, val, s, row } = setInputs[k];
      inp.value = CFG[k]; val.textContent = CFG[k];
      inp.disabled = started && !!s.start;
      row.classList.toggle('off', inp.disabled);
    }
    $('quit').style.display = started ? '' : 'none';
    $('note').textContent = started ? 'Paused. Changes apply straight away. Game mode, map size, enemy commander and starting scrap need a new game.' : '';
  }
  // Push settings that live on existing things (commander armour, HUD prices) into the running game.
  function applyCfg() {
    b1.innerHTML = '<b>1</b> Wall &middot; ' + CFG.wallCost;
    b2.innerHTML = '<b>2</b> Turret &middot; ' + CFG.turretCost;
    b3.innerHTML = '<b>H</b> Repair &middot; ' + CFG.healCost + '/10';
    if (!ready) return;
    for (const F of factions) {
      const c = F.cmd;
      if (c.maxHp !== CFG.playerHp) { c.hp = c.hp / c.maxHp * CFG.playerHp; c.maxHp = CFG.playerHp; }
    }
  }
  function startGame() {
    started = true;
    goBtn.textContent = 'Generating terrain…'; goBtn.disabled = true;
    refreshMenu();
    // let the button text paint before the heavy work
    setTimeout(() => {
      try { init(); goBtn.textContent = 'Click to deploy'; goBtn.disabled = false; requestAnimationFrame(frame); }
      catch (e) { console.error(e); goBtn.textContent = 'Error: ' + e.message; }
    }, 50);
  }
  // for automated testing: start straight away with the given settings
  window.__start = over => { Object.assign(CFG, over || {}); started = true; init(); refreshMenu(); goBtn.textContent = 'Click to deploy'; return window.__game; };

  // ------------------------------------------------------------------ input
  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    overlay.style.display = locked ? 'none' : 'flex';
    if (!locked) { for (const k in keys) keys[k] = false; fireHeld = false; if (!over) { goBtn.textContent = 'Resume'; refreshMenu(); } }
  });
  document.addEventListener('mousemove', e => {
    if (!locked) return;
    camYaw -= e.movementX * 0.0024;
    camPitch = clamp(camPitch - e.movementY * 0.0024, -0.9, 0.5);
  });
  canvas.addEventListener('mousedown', e => {
    if (!locked) return;
    if (e.button === 0) { fireQueued = true; fireHeld = true; }
    if (e.button === 2) buildMode = null;
  });
  document.addEventListener('mouseup', e => { if (e.button === 0) fireHeld = false; });
  canvas.addEventListener('wheel', e => { camDist = clamp(camDist * (e.deltaY > 0 ? 1.1 : 0.9), 6, 28); e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', e => {
    if (e.repeat) return;
    keys[e.code] = true;
    if (e.code === 'KeyP') renderer.shadowsOn = !renderer.shadowsOn;
    if (locked && e.code.startsWith('Arrow')) e.preventDefault();
    if (!(locked || window.__sim) || !ready) return;
    if (e.code === 'Digit1') buildMode = buildMode === 'wall' ? null : 'wall';
    if (e.code === 'Digit2') buildMode = buildMode === 'turret' ? null : 'turret';
    if (e.code === 'KeyQ') buildMode = null;
    if (e.code === 'KeyR') wallFlip = !wallFlip;
    if (e.code === 'KeyE') recruit();
    if (e.code === 'KeyF') order('follow');
    if (e.code === 'KeyG') order('defend');
    if (e.code === 'KeyH') toggleHeal();
  });
  document.addEventListener('keyup', e => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
  canvas.addEventListener('contextmenu', e => e.preventDefault());

  // ------------------------------------------------------------------ squad
  // Nearest knocked-out tank from another side within range of F's commander.
  function recruitableFor(F, range) {
    const c = F.cmd;
    let best = null, bd = range;
    for (const b of bots) {
      const t = b.tank;
      if (!t.alive || !t.disabled || t.side === F.side) continue;
      const d = Math.hypot(t.x - c.x, t.z - c.z);
      if (d < bd) { bd = d; best = b; }
    }
    return best;
  }
  function doRecruit(F, b) {
    if (!F.cmd.alive || F.healing || squadOf(F).length >= CFG.maxSquad) return false;
    b.recruit(F);
    const col = F === blue ? [110, 190, 255] : [255, 110, 90];
    effects.burst([b.tank.x, b.tank.y + 2.5, b.tank.z], col[0], col[1], col[2], 26);
    return true;
  }
  function recruit() {
    if (blue.deadT > 0) return;
    const b = recruitableFor(blue, BOT.RECRUIT_RANGE);
    if (!b) return;
    if (blue.healing) { say("Can't recruit while repairing"); return; }
    if (squadOf(blue).length >= CFG.maxSquad) { say('Squad is full (' + CFG.maxSquad + ' tanks)'); return; }
    if (doRecruit(blue, b)) say('Tank recruited — F: follow me, G: defend where you aim');
  }

  // The squad tank under the crosshair, if any (orders then go to it alone).
  function aimedAlly() {
    const px = tank.x, py = tank.y + 3.4, pz = tank.z;
    let best = null, bb = 120;
    for (const b of squadOf(blue)) {
      const p = b.tank.hitPos();
      const vx = p[0] - px, vy = p[1] - py, vz = p[2] - pz;
      const along = vx * D[0] + vy * D[1] + vz * D[2];
      if (along < 3 || along > bb) continue;
      if (vx * vx + vy * vy + vz * vz - along * along < 9) { bb = along; best = b; }
    }
    return best;
  }
  function order(kind) {
    const all = squadOf(blue);
    if (!all.length) { say('No tanks in your squad yet — knock one out and recruit it'); return; }
    const one = aimedAlly();
    if (kind === 'follow') {
      for (const b of one ? [one] : all) b.setOrder('follow');
      say(one ? 'Tank following you' : 'Squad following you');
      return;
    }
    const who = one ? [one] : all.filter(b => b.order === 'follow');
    if (!who.length) { say('Nobody is following — press F first, or aim at a tank and press G'); return; }
    let x, z;
    if (one) { x = one.tank.x; z = one.tank.z; }                     // "stay where you are"
    else if (aimHit && aimHit.t < 150) { x = aimHit.px; z = aimHit.pz; }
    else { x = tank.x; z = tank.z; }
    who.forEach((b, i) => {
      const a = i / who.length * Math.PI * 2, r = who.length > 1 ? 5 : 0;
      b.setOrder('defend', [x + Math.sin(a) * r, z + Math.cos(a) * r]);
    });
    effects.burst([x, world.groundAt(x, z, world.sy).h + 1, z], 110, 190, 255, 20);
    say(who.length > 1 ? who.length + ' tanks defending that spot' : 'Tank defending that spot');
  }

  // ------------------------------------------------------------------ repairs
  function toggleHeal() {
    if (blue.deadT > 0) return;
    if (blue.healing) { blue.healing = false; return; }
    if (tank.hp >= tank.maxHp) { say('Armour is already full', 2); return; }
    if (CFG.healCost > 0 && blue.scrap < 1) { say('No scrap to repair with', 2); return; }
    blue.healing = true; buildMode = null;
  }
  // Repairing turns scrap into armour while the commander sits still.
  function healTick(F, dt) {
    const c = F.cmd, perHp = CFG.healCost / 10;
    let amt = Math.min(HEAL_RATE * dt, c.maxHp - c.hp);
    if (perHp > 0) amt = Math.min(amt, F.scrap / perHp);
    if (amt <= 0.0001) { F.healing = false; return; }
    c.hp += amt; F.scrap -= amt * perHp;
    if (Math.random() < dt * 14) effects.burst([c.x + (Math.random() - 0.5) * 3, c.y + 1.5, c.z + (Math.random() - 0.5) * 3], 150, 255, 140, 2);
    if (c.hp >= c.maxHp - 0.01) { c.hp = c.maxHp; F.healing = false; }
  }

  // ------------------------------------------------------------------ building
  const airy = id => id === BL.AIR || id === BL.LEAVES || id === BL.PINE;
  const tanksNear = (x, z, r) => ents.some(e => e.hitR > 2 && Math.hypot(e.x - x, e.z - z) < r);

  // Works out the blocks a wall section / turret pedestal would occupy around block (bx, bz) for faction F.
  function planAt(F, kind, bx, bz, refY, alongX) {
    const p = { kind, cells: [], ok: false, why: '' };
    let bad = '';
    if (kind === 'wall') {
      for (let i = -2; i <= 2; i++) {
        const x = bx + (alongX ? i : 0), z = bz + (alongX ? 0 : i);
        const g = world.groundAt(x + 0.5, z + 0.5, refY + 2.5);
        if (g.id === BL.WATER || g.id === -1) { bad = "Can't build on water"; continue; }
        if (Math.abs(g.h - refY) > 4 || g.h + 3 >= world.sy) { bad = 'Ground too uneven'; continue; }
        if (tanksNear(x + 0.5, z + 0.5, 2.6)) bad = 'A tank is in the way';
        for (let y = g.h; y < g.h + 3; y++) if (airy(world.get(x, y, z))) p.cells.push([x, y, z]);
      }
      if (!p.cells.length && !bad) bad = 'No room there';
    } else {
      let mn = 999, mx = -999;
      const hs = [];
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const g = world.groundAt(bx + dx + 0.5, bz + dz + 0.5, refY + 2.5);
        if (g.id === BL.WATER || g.id === -1) bad = "Can't build on water";
        hs.push([bx + dx, bz + dz, g.h]);
        mn = Math.min(mn, g.h); mx = Math.max(mx, g.h);
      }
      const top = mx + 2;
      if (!bad && (mx - mn > 2 || top + 4 >= world.sy)) bad = 'Ground too uneven';
      for (const [x, z, h] of hs) for (let y = h; y < top; y++) {
        if (airy(world.get(x, y, z))) p.cells.push([x, y, z]); else bad = bad || 'Something is in the way';
      }
      for (let y = top; y < top + 3; y++) if (!airy(world.get(bx, y, bz))) bad = bad || 'Something is in the way';
      if (tanksNear(bx + 0.5, bz + 0.5, 4.8)) bad = bad || 'A tank is in the way';
      if (turrets.some(t => Math.hypot(t.x - bx - 0.5, t.z - bz - 0.5) < 6)) bad = bad || 'Too close to another turret';
      if (turretsOf(F).length >= CFG.maxTurrets) bad = 'Turret limit reached (' + CFG.maxTurrets + ')';
      p.top = top; p.cx = bx; p.cz = bz;
    }
    const cost = kind === 'wall' ? CFG.wallCost : CFG.turretCost;
    if (!bad && F.scrap < cost) bad = 'Not enough scrap (need ' + cost + ')';
    p.cost = cost; p.why = bad; p.ok = !bad;
    return p;
  }

  // The player's plan follows the crosshair.
  function computePlan(hit) {
    if (!hit || hit.t > BUILD_RANGE) return { kind: buildMode, cells: [], ok: false, why: 'Too far away to build there' };
    if (hit.id === BL.WATER) return { kind: buildMode, cells: [], ok: false, why: "Can't build on water" };
    const bx = Math.floor(hit.px - D[0] * 0.05), bz = Math.floor(hit.pz - D[2] * 0.05);
    const alongX = (Math.abs(D[2]) >= Math.abs(D[0])) !== wallFlip;   // face the camera by default
    return planAt(blue, buildMode, bx, bz, hit.py, alongX);
  }

  function doBuild(F, p) {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    const id = p.kind === 'wall' ? BL.CONCRETE : BL.STEEL;
    for (const [x, y, z] of p.cells) {
      world.place(x, y, z, id);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    touched(minX - 1, maxX + 1, minZ - 1, maxZ + 1);
    F.scrap -= p.cost;
    const c = p.cells[p.cells.length >> 1];
    if (c) effects.burst([c[0] + 0.5, c[1] + 1, c[2] + 0.5], 160, 240, 130, 18);
    if (p.kind === 'turret') turrets.push(new Turret(renderer, world, p.cx + 0.5, p.top, p.cz + 0.5, p.cx, p.top - 1, p.cz, F));
    else F.walls++;
  }

  function tryBuild() {
    if (!plan) return;
    if (!plan.ok) { say(plan.why, 2); return; }
    doBuild(blue, plan);
  }

  function buildGhost() {
    const B = ghost.B;
    B.reset();
    if (plan) {
      const r = plan.ok ? 110 : 240, g = plan.ok ? 235 : 80, b = plan.ok ? 120 : 70;
      for (const c of plan.cells) B.cube(c[0] + 0.5, c[1] + 0.5, c[2] + 0.5, 0.52, r, g, b, true, 0.4);
      if (plan.kind === 'turret' && plan.top !== undefined) B.cube(plan.cx + 0.5, plan.top + 0.6, plan.cz + 0.5, 0.9, r, g, b, true, 0.4);
    }
    renderer.updateMesh(ghost.mesh, B);
  }

  // ------------------------------------------------------------------ trees
  // Knock a tree loose from height fromY up and let it topple the way of dir [dx, dz].
  function fellTree(idx, fromY, dir) {
    const t = world.trees[idx];
    const res = world.extractTree(idx, fromY);
    if (!res) return;
    touched(res.minX, res.maxX, res.minZ, res.maxZ);
    if (res.vox.length <= 12) {   // just a stump or a stick: splinters
      if (res.vox.length) effects.burst([t.x + 0.5, fromY + 0.5, t.z + 0.5], 120, 88, 56, 8);
      return;
    }
    fallen.push(new FallenTree(renderer, world, res.vox, [t.x + 0.5, Math.max(fromY, t.h), t.z + 0.5], dir));
    if (fallen.length > MAX_FALLEN) fallen.shift().remove();
    for (let i = 0; i < 8; i++) effects.dust([t.x + 0.5, fromY + 0.3, t.z + 0.5], 1);
  }

  // Tanks push over any tree their hull runs into.
  const CRUSH_FRONT = [[-1.5, 3.1], [-0.75, 3.1], [0, 3.1], [0.75, 3.1], [1.5, 3.1], [-1.75, 1.6], [1.75, 1.6]];
  const CRUSH_TURN = [[-1.75, 2.9], [1.75, 2.9], [-1.75, -2.9], [1.75, -2.9], [-1.8, 0], [1.8, 0]];
  function crushTrees(t) {
    const moving = Math.abs(t.speed) > 0.3;
    if (!moving && !t.turning) return;
    const c = Math.cos(t.yaw), s = Math.sin(t.yaw), dir = t.speed < 0 ? -1 : 1, y0 = Math.floor(t.y + 0.6);
    const check = (lx, lz) => {
      const x = Math.floor(t.x + c * lx + s * lz), z = Math.floor(t.z - s * lx + c * lz);
      if (x < 0 || z < 0 || x >= world.sx || z >= world.sz) return;
      const idx = world.treeAt[x + z * world.sx];
      if (!idx) return;
      for (let y = y0 - 1; y <= y0 + 1; y++) if (world.get(x, y, z) === BL.WOOD) {
        fellTree(idx - 1, world.trees[idx - 1].h, moving ? [s * dir, c * dir] : [x + 0.5 - t.x, z + 0.5 - t.z]);
        if (moving) t.speed *= 0.8;
        return;
      }
    };
    if (moving) for (const p of CRUSH_FRONT) check(p[0], p[1] * dir);
    if (t.turning) for (const p of CRUSH_TURN) check(p[0], p[1]);
  }

  // ------------------------------------------------------------------ combat
  function boom(x, y, z, r) {
    const res = world.explode(x, y, z, r);
    touched(res.minX, res.maxX, res.minZ, res.maxZ);
    // any tree that lost part of its trunk, or the ground under it, comes down away from the blast
    const rm = res.removed;
    for (let i = 0; i < rm.length; i += 4) {
      const bx = rm[i], by = rm[i + 1], bz = rm[i + 2];
      const idx = world.treeAt[bx + bz * world.sx];
      if (!idx) continue;
      const t = world.trees[idx - 1];
      if (t.dead || by < t.h - 1 || by > t.yTop) continue;
      fellTree(idx - 1, Math.max(by + 1, t.h), [bx + 0.5 - x || 0.01, bz + 0.5 - z || 0.01]);
    }
    return res;
  }

  function onImpact(p, dir, id, target, shell) {
    if (!target && id === BL.WATER) { effects.splash(p); return; }
    const res = boom(p[0] + dir[0] * 0.4, p[1] + dir[1] * 0.4, p[2] + dir[2] * 0.4, target ? 1.3 : 2.4);
    effects.explosion(p, res.removed);
    const d = Math.hypot(p[0] - tank.x, p[1] - tank.y, p[2] - tank.z);
    shake = Math.max(shake, 0.5 * Math.max(0, 1 - d / 60));
    for (const e of ents) {
      if (!e.alive || e.side === shell.side) continue;
      let dmg = 0;
      if (target && e === target.ref) dmg = CFG.damage;
      else {
        const h = e.hitPos(), sd = Math.hypot(h[0] - p[0], h[1] - p[1], h[2] - p[2]);
        if (sd < SPLASH_R) dmg = CFG.damage * 0.47 * (1 - sd / SPLASH_R);
      }
      if (dmg > 0.5) damage(e, dmg, shell);
    }
  }

  function damage(e, dmg, shell) {
    if (e.shieldT > 0) return;
    e.hp -= dmg; e.hurtT = 0;
    if (e.hp <= 0) { destroy(e, shell); return; }
    // Only roaming tanks get knocked out. A tank that has been recruited fights on until it is destroyed.
    if (e.bot && !e.isCmd && !e.bot.faction && !e.disabled && e.hp <= e.maxHp * BOT.DISABLE_FRAC) {
      e.disabled = true;
      e.bot.disabledT = CFG.recoverTime;
      if (Math.hypot(e.x - tank.x, e.z - tank.z) < 130) say('Tank knocked out — drive up to it and press E to recruit', 5);
    }
  }

  function destroy(e, shell) {
    if (!e.alive) return;
    e.alive = false;
    const p = e.hitPos();
    const res = boom(p[0], p[1] - 0.6, p[2], 1.8);
    effects.explosion(p, res.removed);
    effects.explosion([p[0], p[1] + 1, p[2]], []);
    const killer = shell ? factionOf(shell.side) : null;
    if (e.isCmd) {
      const F = factionOf(e.side);
      F.deadT = Math.max(0.5, CFG.respawnTime);
      F.healing = false;
      const lost = Math.floor(F.scrap * 0.25);
      F.scrap -= lost;
      if (killer && killer !== F) killer.scrap += CFG.killScrap * 2;
      if (F === blue) { buildMode = null; shake = 1; say('Your tank was destroyed' + (lost ? ' — lost ' + lost + ' scrap' : ''), 4); }
      else say('Enemy commander destroyed' + (killer === blue ? '  +' + CFG.killScrap * 2 + ' scrap' : ''), 4);
      if (flags) for (const side in flags) {       // a carried flag falls where its carrier died
        const fl = flags[side];
        if (fl.state !== 'carried' || fl.carrier !== F) continue;
        fl.state = 'dropped'; fl.carrier = null; fl.dropT = 30;
        fl.x = e.x; fl.z = e.z; fl.y = world.groundAt(e.x, e.z, e.y + 3).h;
      }
      if (G.mode === 'lms') endGame(F === blue ? red : blue, F === blue ? 'Your tank was destroyed.' : 'You destroyed the enemy commander.');
      return;
    }
    if (killer) killer.scrap += CFG.killScrap;
    if (e instanceof Turret) say(e.side === 'blue' ? 'One of your turrets was destroyed' : 'Enemy turret destroyed' + (killer === blue ? '  +' + CFG.killScrap + ' scrap' : ''));
    else if (e.side === 'blue') say('You lost a squad tank');
    else if (killer === blue) say('Tank destroyed  +' + CFG.killScrap + ' scrap');
  }

  function respawn(F) {
    const c = F.cmd, h = homeSpot(F);
    c.alive = true; c.hp = c.maxHp; c.hurtT = 99; c.shieldT = 6;
    c.yaw = 0; c.turretYaw = 0;
    c.teleport(h[0], h[1]);
    if (F === blue) { camYaw = 0; say('Back at your home base — shielded for a few seconds'); }
    else if (F.ai) { F.ai.path = null; F.ai.pathT = 0; }
  }

  // keep tanks from driving through each other
  function separate(list) {
    const nudge = (t, mx, mz) => { if (!t._probe(t.x + mx, t.z + mz, t.yaw).blocked) { t.x += mx; t.z += mz; } };
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const dx = b.x - a.x, dz = b.z - a.z, d = Math.hypot(dx, dz);
      if (d >= 4.6 || d < 0.01) continue;
      const push = (4.6 - d) / 2, ux = dx / d, uz = dz / d;
      nudge(a, -ux * push, -uz * push); nudge(b, ux * push, uz * push);
    }
  }

  // ------------------------------------------------------------------ winning
  const nearFlag = (c, f, r) => Math.abs(c.x - f.x) < r && Math.abs(c.z - f.z) < r && Math.abs(c.y - f.y) < 6;
  function flagHome(f) { f.state = 'home'; f.carrier = null; f.x = f.sx; f.y = f.sy; f.z = f.sz; }

  // Capture the flag: drive your commander onto the enemy flag to take it, then onto your own flag's
  // stand to score. A dropped flag goes home when its owner's commander touches it, or after 30 s.
  function flagTick(dt) {
    for (const F of factions) {
      const f = flags[F.side], E = F === blue ? red : blue;
      if (f.state === 'carried') {
        const k = E.cmd, stand = flags[E.side];
        f.x = k.x; f.z = k.z; f.y = k.y + 3.3;
        if (Math.abs(k.x - stand.sx) < 4.5 && Math.abs(k.z - stand.sz) < 4.5) {
          score[E.side]++;
          flagHome(f);
          effects.burst([stand.sx, stand.sy + 2, stand.sz], 255, 230, 120, 40);
          say(E === blue ? 'Flag captured!  ' + score.blue + ' : ' + score.red : 'The enemy captured your flag  ' + score.blue + ' : ' + score.red, 5);
          if (score[E.side] >= CFG.flagsToWin) endGame(E, E === blue ? 'You captured ' + score.blue + ' flags.' : 'The enemy commander captured ' + score.red + ' flags.');
        }
        continue;
      }
      if (E.cmd.alive && nearFlag(E.cmd, f, 3.5)) {
        f.state = 'carried'; f.carrier = E;
        say(E === blue ? 'You have the enemy flag — take it back to your base!' : 'The enemy commander has your flag!', 5);
      } else if (f.state === 'dropped') {
        f.dropT -= dt;
        if (f.dropT <= 0 || (F.cmd.alive && nearFlag(F.cmd, f, 3.5))) {
          flagHome(f);
          say(F === blue ? 'Your flag is back at your base' : 'The enemy flag went back to its base');
        }
      }
    }
  }

  // Flag meshes: a pole with a banner, a stand at each base, and a tall see-through beam so they can be found.
  function buildFlags() {
    flagB.reset(); beaconB.reset();
    if (flags) for (const side in flags) {
      const f = flags[side], c = side === 'blue' ? [60, 140, 255] : [255, 66, 54];
      flagB.cube(f.sx, f.sy + 0.2, f.sz, 0.55, 96, 96, 100, false);
      for (let i = 0; i < 14; i++) flagB.cube(f.x, f.y + 0.14 + i * 0.28, f.z, 0.14, 210, 210, 200, false);
      for (let bx = 0; bx < 3; bx++) for (let by = 0; by < 2; by++) flagB.cube(f.x + 0.44 + bx * 0.6, f.y + 2.9 + by * 0.6, f.z, 0.3, c[0], c[1], c[2], true);
      for (let i = 0; i < 28; i++) beaconB.cube(f.x, f.y + 5 + i, f.z, 0.5, c[0], c[1], c[2], true, 0.22);
    }
    renderer.updateMesh(flagItem.mesh, flagB);
    renderer.updateMesh(beaconItem.mesh, beaconB);
  }

  function endGame(winner, why) {
    if (over) return;
    over = true;
    const won = winner === blue;
    overlay.querySelector('h1').textContent = won ? 'VICTORY' : 'DEFEAT';
    overlay.querySelector('.sub').textContent = why;
    for (const id of ['settings', 'keys', 'defaults', 'quit', 'toprow', 'moderow']) $(id).style.display = 'none';
    $('note').textContent = '';
    goBtn.textContent = 'Main menu';
    overlay.style.display = 'flex';
    if (document.pointerLockElement) document.exitPointerLock();
  }

  // ------------------------------------------------------------------ minimap
  function bakeMap() {
    const N = 256;
    mapTerrain.width = mapTerrain.height = N;
    const ctx = mapTerrain.getContext('2d'), img = ctx.createImageData(N, N);
    for (let pz = 0; pz < N; pz++) for (let px = 0; px < N; px++) {
      const x = Math.floor(px * world.sx / N), z = Math.floor(pz * world.sz / N);
      const y = world.colTop[x + z * world.sx];
      const c = BLOCK_COLORS[world.get(x, y, z)] || [0, 0, 0];
      const s = 0.55 + y / world.sy * 0.9, i = (px + pz * N) * 4;
      img.data[i] = Math.min(255, c[0] * s); img.data[i + 1] = Math.min(255, c[1] * s); img.data[i + 2] = Math.min(255, c[2] * s); img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }

  function drawMap() {
    const S = mapEl.width, k = S / world.sx;
    mctx.drawImage(mapTerrain, 0, 0, S, S);
    const dot = (x, z, r, col) => { mctx.fillStyle = col; mctx.fillRect(x * k - r, z * k - r, r * 2, r * 2); };
    const near = t => Math.hypot(t.x - tank.x, t.z - tank.z) < 190;
    mctx.lineWidth = 1.5;
    for (const s of world.sites) {
      mctx.strokeStyle = s === blue.home ? '#9fe870' : red && s === red.home ? '#ff4a3a' : '#fff';
      mctx.beginPath(); mctx.arc(s.x * k, s.z * k, 5, 0, Math.PI * 2); mctx.stroke();
    }
    for (const c of crates) dot(c.x, c.z, 1, '#ffd84a');
    for (const t of turrets) if (t.side === 'blue' || near(t)) dot(t.x, t.z, 2, t.side === 'blue' ? '#9fe870' : '#ff4a3a');
    for (const b of bots) {
      const t = b.tank;
      if (!t.alive) continue;
      if (t.side === 'blue') dot(t.x, t.z, 2, t.disabled ? '#ffb040' : '#6cc4ff');
      else if (near(t)) dot(t.x, t.z, 2, t.disabled ? '#ffb040' : t.side === 'red' ? '#ff4a3a' : '#e8a868');
    }
    if (red && red.cmd.alive && near(red.cmd)) dot(red.cmd.x, red.cmd.z, 3, '#ff2a1a');
    if (flags) for (const side in flags) {      // flags: little pennants, always shown
      const f = flags[side], fx = f.x * k, fz = f.z * k;
      mctx.fillStyle = side === 'blue' ? '#4aa0ff' : '#ff4a3a'; mctx.strokeStyle = '#000'; mctx.lineWidth = 1;
      mctx.beginPath(); mctx.moveTo(fx, fz - 8); mctx.lineTo(fx + 7, fz - 5); mctx.lineTo(fx, fz - 2); mctx.closePath(); mctx.fill(); mctx.stroke();
      mctx.beginPath(); mctx.moveTo(fx, fz - 8); mctx.lineTo(fx, fz + 1); mctx.stroke();
    }
    // player: arrow along the view direction
    const a = Math.atan2(D[0], D[2]);
    mctx.save();
    mctx.translate(tank.x * k, tank.z * k); mctx.rotate(-a);
    mctx.fillStyle = '#fff'; mctx.strokeStyle = '#000'; mctx.lineWidth = 1;
    mctx.beginPath(); mctx.moveTo(0, 6); mctx.lineTo(4, -4); mctx.lineTo(-4, -4); mctx.closePath(); mctx.fill(); mctx.stroke();
    mctx.restore();
  }

  // ------------------------------------------------------------------ loop
  let last = performance.now(), fpsAcc = 0, fpsN = 0;
  const aim = [0, 0, 0];

  function frame(now) { requestAnimationFrame(frame); tick(now); }

  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    if (dt <= 0) return;
    last = now;
    if (!ready) return;
    renderer.resize();

    const cp = Math.cos(camPitch);
    D = [Math.sin(camYaw) * cp, Math.sin(camPitch), Math.cos(camYaw) * cp];

    if ((locked || window.__sim) && !over) {
      // where the crosshair is pointing in the world
      const px = tank.x, py = tank.y + 3.4, pz = tank.z;
      const hit = world.raycast(px + D[0] * 2, py + D[1] * 2, pz + D[2] * 2, D[0], D[1], D[2], 400);
      aimHit = hit;
      const t = hit ? Math.max(hit.t + 2, 6) : 400;
      aim[0] = px + D[0] * t; aim[1] = py + D[1] * t; aim[2] = pz + D[2] * t;

      const cmds = factions.map(F => F.cmd).filter(c => c.alive);
      ents = G.ents = cmds.concat(bots.map(b => b.tank), turrets).filter(e => e.alive);
      G.cmds = cmds;
      G.pathBudget = 3;
      plan = buildMode && blue.deadT <= 0 && !blue.healing ? computePlan(hit) : null;

      // ---- you
      if (blue.deadT > 0) { blue.deadT -= dt; if (blue.deadT <= 0) respawn(blue); }
      else if (blue.healing) { tank.update(dt, NOKEYS, aim); healTick(blue, dt); }
      else {
        tank.update(dt, keys, aim);
        if (buildMode) { if (fireQueued) tryBuild(); }
        else if (fireQueued || fireHeld) {
          const shot = tank.fire();
          if (shot) { effects.muzzleFlash(shot.pos, shot.dir); effects.fireShell(shot.pos, shot.dir, 'blue'); shake = Math.max(shake, 0.18); }
        }
        const sp = Math.abs(tank.speed);
        if (sp > 1.5) for (const p of tank.trackDustPoints()) effects.dust(p, sp / tank.maxFwd * 0.6);
      }
      fireQueued = false;

      // ---- the enemy commander
      if (red) {
        if (red.deadT > 0) { red.deadT -= dt; if (red.deadT <= 0) respawn(red); }
        else { red.ai.update(dt, G); if (red.healing) healTick(red, dt); }
      }

      // ---- squads and rogues
      for (const F of factions) {
        let n = 0;
        const followers = bots.filter(b => b.faction === F && b.tank.alive && b.order === 'follow');
        for (const b of followers) { b.slot = n++; b.followers = followers.length; }
      }
      for (const b of bots) if (b.tank.alive) b.update(dt, G);
      for (const tr of turrets) { tr.update(dt, G); if (tr.alive && tr.hp <= 0) destroy(tr, null); }
      const tanks = ents.filter(e => e.hitR > 2 && e.alive);
      separate(tanks);
      for (const tk of tanks) crushTrees(tk);
      for (let i = fallen.length - 1; i >= 0; i--) { fallen[i].update(dt); if (!fallen[i].alive) fallen.splice(i, 1); }

      // squad tanks and turrets slowly mend when left alone; commanders have to spend scrap (H)
      for (const e of ents) {
        e.hurtT = (e.hurtT || 0) + dt;
        if (e.shieldT > 0) e.shieldT -= dt;
        if (!e.isCmd && e.side !== 'rogue' && !e.disabled && e.hurtT > 10 && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + 2 * dt);
      }

      // scrap crates: either commander can drive over them
      for (const F of factions) {
        const c = F.cmd;
        if (!c.alive) continue;
        for (let i = crates.length - 1; i >= 0; i--) {
          const k = crates[i];
          if (Math.abs(k.x - c.x) < 2.8 && Math.abs(k.z - c.z) < 2.8 && Math.abs(k.y - c.y) < 4) {
            crates.splice(i, 1); cratesDirty = true;
            F.scrap += CFG.crateScrap;
            effects.burst([k.x, k.y + 0.6, k.z], 255, 216, 74, 18);
            if (F === blue) say('+' + CFG.crateScrap + ' scrap', 1.5);
          }
        }
      }
      if (flags) flagTick(dt);
      crateT -= dt;
      if (crateT <= 0) { crateT = 25; if (crates.length < maxCrates) spawnCrate(); }
      spawnT -= dt;
      if (spawnT <= 0) { spawnT = CFG.spawnTime * (0.75 + Math.random() * 0.5); if (rogues().length < CFG.maxEnemies) spawnRogue(); }

      const targets = ents.filter(e => e.alive).map(e => { const h = e.hitPos(); return { x: h[0], y: h[1], z: h[2], r: e.hitR, side: e.side, ref: e }; });
      effects.update(dt, onImpact, targets);

      for (let i = bots.length - 1; i >= 0; i--) if (!bots[i].tank.alive) bots.splice(i, 1);
      for (let i = turrets.length - 1; i >= 0; i--) if (!turrets[i].alive) turrets.splice(i, 1);
    }
    flushDirty();
    effects.buildMesh();
    buildGhost();
    if (cratesDirty) {
      crateB.reset();
      for (const c of crates) {
        crateB.cube(c.x, c.y + 0.45, c.z, 0.45, 176, 128, 58, false);
        crateB.cube(c.x, c.y + 0.98, c.z, 0.14, 255, 216, 74, true);
      }
      renderer.updateMesh(crateItem.mesh, crateB);
      cratesDirty = false;
    }
    buildFlags();

    // ---- camera (orbits a point above the tank; pulled in if terrain is in the way)
    const pivot = [tank.x, tank.y + 3.4, tank.z];
    const back = world.raycast(pivot[0], pivot[1], pivot[2], -D[0], -D[1], -D[2], camDist + 0.6);
    const want = back ? Math.max(1.2, back.t - 0.5) : camDist;
    // snap in immediately when blocked, ease back out
    camCur = want < camCur ? want : camCur + (want - camCur) * Math.min(1, dt * 4);
    const dist = camCur;
    shake *= Math.exp(-dt * 7);
    const sx = (Math.random() - 0.5) * shake, sy = (Math.random() - 0.5) * shake, sz = (Math.random() - 0.5) * shake;
    const cam = [pivot[0] - D[0] * dist + sx, pivot[1] - D[1] * dist + sy, pivot[2] - D[2] * dist + sz];
    const look = [pivot[0] + sx, pivot[1] + sy, pivot[2] + sz];
    M4.perspective(proj, 60 * Math.PI / 180, canvas.width / canvas.height, 0.2, 700);
    M4.lookAt(view, cam, look, [0, 1, 0]);
    M4.multiply(vp, proj, view);

    // ---- sun shadow frustum follows the tank (snapped to texels to avoid shimmer)
    const R = 70;
    const eye = [tank.x + SUN[0] * 200, tank.y + SUN[1] * 200, tank.z + SUN[2] * 200];
    M4.lookAt(lightV, eye, [tank.x, tank.y, tank.z], [0, 1, 0]);
    M4.ortho(lightP, -R, R, -R, R, 1, 400);
    M4.multiply(lightVP, lightP, lightV);
    const o = M4.transform(lightVP, 0, 0, 0), ts = renderer.shadowSize / 2;
    lightVP[12] += (Math.round(o[0] * ts) - o[0] * ts) / ts;
    lightVP[13] += (Math.round(o[1] * ts) - o[1] * ts) / ts;

    // ---- draw list: only chunks in front of the camera and inside the fog, shadows only near the tank
    const items = [];
    const fl = Math.hypot(D[0], D[2]) || 1, fx = D[0] / fl, fz = D[2] / fl;
    for (const c of chunks) {
      const vx = c.x - cam[0], vz = c.z - cam[2];
      if (vx * vx + vz * vz > VIEW_DIST * VIEW_DIST || vx * fx + vz * fz < -30) continue;
      c.shadow = Math.abs(c.x - tank.x) < 110 && Math.abs(c.z - tank.z) < 110;
      items.push(c);
    }
    const inView = t => Math.hypot(t.x - cam[0], t.z - cam[2]) < VIEW_DIST;
    for (const F of factions) if (F.cmd.alive && inView(F.cmd)) items.push(...F.cmd.drawItems());
    for (const b of bots) if (inView(b.tank)) items.push(...b.tank.drawItems());
    for (const tr of turrets) if (inView(tr)) items.push(...tr.drawItems());
    for (const f of fallen) items.push(f.drawItem());
    items.push(crateItem, flagItem, ghost, beaconItem, ...effects.drawItems());
    renderer.render(items, vp, cam, lightVP, SUN, FOG, FOG_DEN);

    // ---- HUD
    // gun marker: where the barrel is actually pointing
    const m = tank.muzzle, g = tank.gf;
    const gh = world.raycast(m[0], m[1], m[2], g[0], g[1], g[2], 400);
    const gt = gh ? gh.t : 400;
    const c = M4.transform(vp, m[0] + g[0] * gt, m[1] + g[1] * gt, m[2] + g[2] * gt);
    if (c[3] > 0.01 && blue.deadT <= 0) {
      gunMark.style.display = 'block';
      gunMark.style.left = ((c[0] / c[3] * 0.5 + 0.5) * 100) + '%';
      gunMark.style.top = ((1 - (c[1] / c[3] * 0.5 + 0.5)) * 100) + '%';
    } else gunMark.style.display = 'none';
    const rl = 1 - tank.reload / tank.reloadTime;
    reloadFill.style.width = (rl * 100) + '%';
    reloadFill.style.background = rl >= 1 ? '#9fe870' : '#f0b040';
    infoEl.textContent = Math.round(Math.abs(tank.speed) * 4.5) + ' km/h';

    const hp = Math.max(0, tank.hp / tank.maxHp);
    hpFill.style.width = (hp * 100) + '%';
    hpFill.style.background = hp > 0.5 ? '#9fe870' : hp > 0.25 ? '#f0b040' : '#ff5a48';
    statsEl.textContent = 'Scrap ' + Math.floor(blue.scrap) + '   Turrets ' + turretsOf(blue).length + '/' + CFG.maxTurrets + '   Squad ' + squadOf(blue).length + '/' + CFG.maxSquad;
    foeEl.textContent = red ? 'Enemy commander: ' + (red.cmd.alive ? 'armour ' + Math.round(red.cmd.hp / red.cmd.maxHp * 100) + '%' : 'destroyed') +
      '  scrap ' + Math.floor(red.scrap) + '  turrets ' + turretsOf(red).length + '  squad ' + squadOf(red).length : '';
    let goal = '';
    if (G.mode === 'lms') goal = 'Last man standing — no respawns';
    else if (flags) {
      goal = 'Flags   You ' + score.blue + ' : ' + score.red + ' Enemy   (first to ' + CFG.flagsToWin + ')';
      if (flags.red.carrier === blue) goal += '\nYou have their flag — take it home';
      else if (flags.blue.state === 'carried') goal += '\nThe enemy commander has your flag';
      else if (flags.blue.state === 'dropped') goal += '\nYour flag is lying out in the field';
      else if (flags.red.state === 'dropped') goal += '\nTheir flag is lying out in the field';
    }
    if (goalEl.textContent !== goal) goalEl.textContent = goal;
    b1.className = buildMode === 'wall' ? 'on' : '';
    b2.className = buildMode === 'turret' ? 'on' : '';
    b3.className = blue.healing ? 'on' : '';

    let prompt = '';
    if (blue.deadT > 0) prompt = 'Respawning in ' + Math.ceil(blue.deadT) + ' s';
    else if (blue.healing) prompt = 'Repairing — you can\'t move or fire (H to stop)';
    else if (buildMode) prompt = (plan && !plan.ok ? plan.why + ' — ' : 'Left click: place ' + buildMode + ' — ') + (buildMode === 'wall' ? 'R: rotate, ' : '') + 'Q: cancel';
    else if (recruitableFor(blue, BOT.RECRUIT_RANGE)) prompt = 'Press E to recruit this tank';
    else if (hp < 0.5 && blue.scrap >= 1) prompt = 'Press H to repair with scrap';
    promptEl.textContent = prompt;
    promptEl.style.display = prompt ? 'block' : 'none';
    if (msgT > 0) { msgT -= dt; if (msgT <= 0) msgEl.style.opacity = 0; }

    // name tags over other tanks
    let ti = 0;
    const tagFor = (t, b) => {
      if (ti >= tags.length || !t.alive) return;
      if (Math.hypot(t.x - tank.x, t.z - tank.z) > (t.side === 'blue' ? 170 : 110)) return;
      const q = M4.transform(vp, t.x, t.y + 4.4, t.z);
      if (q[3] < 0.5 || Math.abs(q[0]) > q[3] || Math.abs(q[1]) > q[3]) return;
      const T = tags[ti++];
      T.el.style.display = 'block';
      T.el.style.left = ((q[0] / q[3] * 0.5 + 0.5) * 100) + '%';
      T.el.style.top = ((1 - (q[1] / q[3] * 0.5 + 0.5)) * 100) + '%';
      const cls = 'tag ' + (t.disabled ? 'out' : t.side === 'blue' ? 'ally' : t.side === 'red' ? 'red' : 'foe');
      if (T.el.className !== cls) T.el.className = cls;
      const txt = t.disabled ? 'KNOCKED OUT' : t.isCmd ? 'ENEMY COMMANDER' : t.side === 'blue' ? (b.order === 'defend' ? 'DEFEND' : 'FOLLOW') : t.side === 'red' ? 'ENEMY' : '';
      if (T.txt.textContent !== txt) T.txt.textContent = txt;
      T.fill.style.width = (Math.max(0, t.hp / t.maxHp) * 100) + '%';
    };
    if (red) tagFor(red.cmd, red.ai);
    for (const b of bots) tagFor(b.tank, b);
    for (; ti < tags.length; ti++) tags[ti].el.style.display = 'none';

    mapT -= dt;
    if (mapT <= 0) { mapT = 0.12; drawMap(); }

    fpsAcc += dt; fpsN++;
    if (fpsAcc > 0.5) { fpsEl.textContent = Math.round(fpsN / fpsAcc) + ' fps'; fpsAcc = 0; fpsN = 0; }
  }

  $('hud').style.display = 'none';   // nothing to show until a game is running
  buildMenu();
  applyCfg();
})();
