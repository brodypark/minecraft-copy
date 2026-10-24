# Voxel Sandbox

A first-person voxel sandbox game that runs in the browser. Explore procedurally generated, endless-feeling terrain with hills, lakes, beaches, trees and caves. Break and place blocks, walk, swim or fly, and watch a full day/night cycle. Your world saves automatically.

Built with [three.js](https://threejs.org/) and [Vite](https://vite.dev/), in vanilla JavaScript. Every texture is generated in code at startup; the project ships no image files.

## Run it

Requires Node.js 22.12 or newer (Vitest 5 needs ^22.12, ^24 or >=26; Vite 8 needs ^20.19 or >=22.12).

```sh
npm install
npm run dev       # start the dev server, then open the URL it prints (usually http://localhost:5173)
```

Click the game to capture the mouse and start playing.

### Other commands

```sh
npm run build       # production build into dist/
npm run preview     # serve the production build locally
npm test            # unit tests (vitest, runs once)
npm run test:smoke  # browser smoke test: loads the game in headless Chrome and fails on any console
                    # error or warning within 5 s (skipped if Google Chrome isn't installed)
```

## Controls

| Input | Action |
| --- | --- |
| Click | Capture the mouse / resume |
| W A S D | Move |
| Mouse | Look |
| Space | Jump (swim up in water) |
| Space twice quickly | Toggle fly mode |
| Space / Shift (flying) | Fly up / down |
| Shift | Sprint |
| Left click | Break block |
| Right click | Place the selected block |
| 1–9 or mouse wheel | Select a hotbar block |
| F3 | Debug overlay (FPS, position, chunks, triangles, seed, time) |
| Esc | Release the mouse and pause |

The pause menu lists the controls and has a **New World** button (it asks for confirmation first).

## Saving

The game saves to `localStorage` every 10 seconds and when the page closes. A save stores the seed, the player's position, view and fly state, the hotbar slot, the time of day, and only the blocks you changed. Terrain regenerates from the seed and your edits are applied on top. Corrupt or missing save data falls back to a new world.

Adding `?seed=<number>` to the URL starts a world with that seed. If it matches the current save's seed, the save is restored instead.

## Project structure

```
index.html            page shell
src/
  main.js             boot, game loop and wiring of all modules
  config.js           all tunable constants (world size, physics, terrain, sky, AO, caves)
  blocks.js           block ids and registry (solid/transparent/placeable/breakable, atlas tiles)
  render/
    tiles.js          atlas tile indices + inset UV lookup (pure)
    atlas.js          procedural 256x256 texture atlas -> three.js CanvasTexture
    mesher.js         pure chunk mesher: face culling, face shading, ambient occlusion
    chunkMeshes.js    three.js meshes per chunk (create, swap, dispose), brightness
    renderer.js       WebGL renderer, scene, camera, resize, pixel-ratio cap
    sky.js            sky/fog colors, sun, moon, stars, day/night brightness, underwater fog
    outline.js        target-block wireframe outline
  world/
    chunk.js          chunk storage and coordinate helpers (floor + positive modulo)
    terrain.js        deterministic terrain: fbm height, layers, beaches, water, trees, caves
    world.js          chunk map, get/set block, edit tracking, streaming and mesh scheduling
    raycast.js        voxel DDA raycast (Amanatides & Woo)
  player/
    physics.js        AABB movement and collision, gravity, jumping, flying, swimming (pure)
    controls.js       pointer lock, keyboard, mouse, wheel, F3, double-tap detection
    player.js         spawn search, mouse look, input -> physics, camera, void respawn
    interaction.js    break/place rules (pure)
  ui/
    hud.js            crosshair and pause menu
    hotbar.js         hotbar with isometric block icons drawn from the atlas
    debug.js          F3 overlay and frame stats
    style.css
  save/
    save.js           save format, validation, localStorage load/save, autosave
tests/                vitest unit tests for the pure modules (plus tests/smoke/ for the browser test)
```

The world is 16x16 columns per chunk and 64 blocks tall. Chunks generate within 7 chunks of the player, mesh and draw within 6, and unload beyond 9. Each frame generates and meshes at most 2 chunks each, nearest first; edited chunks remesh immediately.

Supporting docs: `PROJECT.md` (the spec), `DECISIONS.md` (design decisions and measurements), and `MANUAL_CHECKS.md` (things a human should verify by playing). `dashboard.html` and `status.json` are the agent dashboard used while building the project. Serve the folder (e.g. `python3 -m http.server 8000`) and open `/dashboard.html` to view it. Neither file is part of the game.

## Known limitations

- **No lighting propagation.** Caves and overhangs are lit like the surface; only ambient occlusion and a global day/night brightness darken things.
- **Water is static.** It doesn't flow into holes you dig, and its surface is a flat full block.
- **Caves never reach the surface.** You find them by digging.
- **Saves live in one browser.** There's a single save slot in `localStorage` for this browser profile; private windows or cleared site data lose it.
- **Fixed render distance.** It's 6 chunks; change it with `RENDER_DISTANCE` in `src/config.js`.
- **Desktop only.** It needs a mouse and keyboard with pointer lock; there are no touch controls.
- **Performance is unmeasured on real hardware.** The 60 FPS target on an integrated-GPU laptop couldn't be checked in the headless build environment, and is listed in `MANUAL_CHECKS.md`.
