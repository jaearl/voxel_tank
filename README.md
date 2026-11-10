# Voxel Tank

A voxel tank game for Windows desktop (WebGL2 rendering inside an Electron window).

## First-time setup
1. Install **Node.js LTS** from https://nodejs.org (default options are fine).
2. Open a terminal in this folder (in Explorer: click the address bar, type `cmd`, press Enter).
3. Run:
   ```
   npm install
   ```

## Play (development)
```
npm start
```
Opens the game in its own window. Code changes take effect the next time you run it.

## Build a standalone .exe
```
npm run build
```
Creates `dist\Voxel Tank 0.1.0.exe` — a single portable file you can run or share without Node.js.

## Controls
- W / S: drive forward / reverse
- A / D: turn the hull
- Mouse: look around; the turret follows your aim
- Left click: fire (or place, while building)
- 1 / 2: build a wall section / gun turret where you aim; R rotates a wall, Q or right click cancels
- E: recruit a knocked-out enemy tank you are next to
- F / G: squad follows you / defends the spot you aim at (aim at one tank to order just that one)
- H: repair your tank with scrap (you can't move or fire while repairing)
- U: tank upgrades (armour, autoloader, engine, gun; three levels each), only at your home base; 1-4 buy while the panel is open
- Esc: pause and open the settings (enemy numbers, spawn rate, costs, damage and more)

The start menu also has the game mode: skirmish (no winner), capture the flag (drive onto the enemy flag and bring it home; first to the set number of captures wins) or last man standing (no respawns; lose your tank and you lose). The start menu has the same settings plus map size (small, medium, large, huge), a random-map option and the enemy commander toggle.
- Mouse wheel: zoom camera
- P: toggle shadows, Esc: release mouse / pause
- F11: fullscreen, F12: developer tools

## Code layout
- `electron/main.js` – desktop window
- `index.html` – page, HUD and styles
- `js/math.js` – matrices, noise, random
- `js/mesher.js` – voxel grid -> triangle mesh (with ambient occlusion)
- `js/renderer.js` – WebGL2 renderer, shadow map, fog
- `js/world.js` – map generation, raycasts, craters, chunk meshing
- `js/tank.js` – tank model, driving, turret
- `js/effects.js` – shells and particles
- `js/main.js` – input, camera, game loop, HUD
