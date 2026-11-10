// Game settings: defaults, the sliders shown in the start/pause menu, and saving between runs.
'use strict';

const MAP_SIZES = { small: 256, medium: 384, large: 512, huge: 768 };
// How a game is won. Anything but skirmish needs the enemy commander.
const MODES = { skirmish: 'Skirmish (no winner)', ctf: 'Capture the flag', lms: 'Last man standing' };

// start: true => can only be changed on the start menu (needs a new game)
const CFG_SCHEMA = [
  { k: 'maxEnemies', label: 'Roaming tanks (most at once)', min: 0, max: 14, step: 1, def: 6 },
  { k: 'spawnTime', label: 'Seconds between new roaming tanks', min: 5, max: 120, step: 5, def: 40 },
  { k: 'botHp', label: 'Bot tank armour', min: 40, max: 300, step: 10, def: 100 },
  { k: 'playerHp', label: 'Commander armour (you and the enemy)', min: 60, max: 400, step: 10, def: 160 },
  { k: 'damage', label: 'Shell damage', min: 10, max: 120, step: 2, def: 34 },
  { k: 'recoverTime', label: 'Knocked-out roaming tanks recover after (seconds)', min: 10, max: 180, step: 5, def: 60 },
  { k: 'startScrap', label: 'Starting scrap', min: 0, max: 500, step: 10, def: 100, start: true },
  { k: 'crateScrap', label: 'Scrap per crate', min: 0, max: 60, step: 1, def: 15 },
  { k: 'killScrap', label: 'Scrap per kill', min: 0, max: 100, step: 5, def: 30 },
  { k: 'wallCost', label: 'Wall cost', min: 1, max: 40, step: 1, def: 8 },
  { k: 'turretCost', label: 'Turret cost', min: 10, max: 200, step: 5, def: 50 },
  { k: 'maxTurrets', label: 'Turret limit (each side)', min: 0, max: 12, step: 1, def: 6 },
  { k: 'maxSquad', label: 'Squad limit (each side)', min: 0, max: 20, step: 1, def: 4 },
  { k: 'healCost', label: 'Repair cost (scrap per 10 armour)', min: 0, max: 20, step: 1, def: 4 },
  { k: 'respawnTime', label: 'Commander respawn delay (seconds)', min: 0, max: 180, step: 5, def: 60 },
  { k: 'flagsToWin', label: 'Flag captures to win', min: 1, max: 10, step: 1, def: 3 },
];

const CFG = { mapSize: 'large', mode: 'skirmish', commander: true, randomMap: false };

function resetCfg() {
  CFG.mapSize = 'large'; CFG.mode = 'skirmish'; CFG.commander = true; CFG.randomMap = false;
  for (const s of CFG_SCHEMA) CFG[s.k] = s.def;
}

function saveCfg() {
  try { localStorage.setItem('voxeltank.cfg', JSON.stringify(CFG)); } catch (e) { /* storage unavailable: settings just don't persist */ }
}

(function loadCfg() {
  resetCfg();
  try {
    const saved = JSON.parse(localStorage.getItem('voxeltank.cfg') || '{}');
    if (MAP_SIZES[saved.mapSize]) CFG.mapSize = saved.mapSize;
    if (MODES[saved.mode]) CFG.mode = saved.mode;
    if (typeof saved.commander === 'boolean') CFG.commander = saved.commander;
    if (typeof saved.randomMap === 'boolean') CFG.randomMap = saved.randomMap;
    for (const s of CFG_SCHEMA) {
      const v = saved[s.k];
      if (typeof v === 'number' && isFinite(v)) CFG[s.k] = clamp(v, s.min, s.max);
    }
  } catch (e) { /* bad saved data: keep defaults */ }
})();
