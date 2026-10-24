# Voxel Sandbox — PROJECT.md

A first-person voxel sandbox game that runs in the browser. Procedurally generated infinite-feeling terrain, break and place blocks, walking physics, day/night cycle, save/load. Built with Three.js + Vite.

This file is the single source of truth. The manager agent reads it, executes the tasks, and checks the boxes.

---

## 1. Manager operating rules (read first)

You are the **manager agent**. You plan, delegate to sub-agents, verify, commit, and update the dashboard. Do not ask the user questions; make reasonable decisions and log them in `DECISIONS.md`.

1. Use the **agent-dashboard** skill. Keep `status.json` updated: set an agent to `working` (with a short task) before you spawn it, and `done` or `failed` after you verify. **Only the manager edits `status.json`.** Sub-agents never touch it.
2. Maximum **6 sub-agents at once** (the dashboard has 6 boxes). Name boxes after the work, e.g. `Scaffold`, `Atlas`, `Terrain`, `Physics`, `Mesher`, `UI`.
3. Work in the order and parallel groups in section 9. Tasks in the same group may run at the same time; groups run one after another.
4. **File ownership:** each sub-agent only edits the files listed for its task. Parallel agents must **NOT** edit `src/main.js`. They export clean functions and report how they should be wired in. The manager (or the next integration task) does the wiring in `main.js`.
5. **Only the manager commits to git**, after a task or group is verified. Commit message format: `task N: short description`.
6. **Verify before checking a box.** A task is done only when every acceptance criterion passes AND both `npm test` and `npm run build` succeed. Run the commands yourself; don't trust a sub-agent's claim.
7. **No infinite loops.** If a task fails verification twice, simplify it, log what you cut in `DECISIONS.md`, and continue. If it still can't be made to work after a third attempt, mark it `[~]` with a one-line reason and move on. Never leave the build broken: if a change breaks the build and can't be fixed quickly, `git checkout` the broken files.
8. Things only a human can check (visuals, feel, performance) go in `MANUAL_CHECKS.md` as a checklist instead of being claimed as verified. Do not say "looks good" about anything you can't actually observe.
9. When all tasks are `[x]` or `[~]`, run the final QA task, then give the user a short summary: what works, what's `[~]`, and how to run it.

---

## 2. Tech stack (fixed, don't substitute)

- **Vite**, vanilla JavaScript with ES modules. No framework, no TypeScript.
- **three** (latest stable from npm).
- **simplex-noise** (v4, `createNoise2D` / `createNoise3D`) + **alea** for seeded randomness.
- **vitest** for unit tests.
- Any other runtime dependency needs a line in `DECISIONS.md` explaining why.

## 3. Hard constraints

- **No copyrighted material.** Do not use the word "Minecraft", its textures, sounds, fonts, or logos. Game title: **Voxel Sandbox**.
- **All textures are generated in code** at runtime on a `<canvas>` (see Task 2). No image files required.
- `npm install && npm run dev` must start the game. `npm run build` must pass. `npm test` must pass.
- Target 60 FPS on an integrated-GPU laptop at render distance 6.
- No console errors or warnings during normal play.

---

## 4. File layout

```
voxel-game/
  index.html
  package.json
  vite.config.js
  PROJECT.md            (this file)
  DECISIONS.md          (manager's decision log)
  MANUAL_CHECKS.md      (things a human must verify)
  README.md
  dashboard.html, status.json   (from agent-dashboard skill)
  src/
    main.js             boot + game loop + wiring (manager only)
    config.js           ALL constants
    blocks.js           block IDs + registry
    render/atlas.js     procedural texture atlas
    render/renderer.js  three.js renderer, camera, resize
    render/mesher.js    PURE function: chunk data -> geometry arrays
    render/chunkMeshes.js  creates/disposes three meshes from mesher output
    render/sky.js       sky color, sun/moon, fog, brightness
    world/chunk.js      Chunk class (block storage)
    world/world.js      chunk map, get/set block, streaming
    world/terrain.js    terrain generator
    world/raycast.js    voxel ray traversal
    player/physics.js   AABB movement + collision (no three.js dependency)
    player/controls.js  pointer lock + input state
    player/player.js    ties physics + controls + camera
    ui/hud.js           crosshair, pause overlay
    ui/hotbar.js        hotbar + isometric block icons
    ui/debug.js         F3 overlay
    ui/style.css
    save/save.js        localStorage save/load
  tests/
    *.test.js
```

---

## 5. Contracts (every agent must follow these exactly)

### 5.1 Constants (`src/config.js`)

```js
export const CHUNK_SIZE = 16;          // x and z footprint
export const WORLD_HEIGHT = 64;        // y range 0..63
export const SEA_LEVEL = 22;
export const RENDER_DISTANCE = 6;      // radius in chunks that get meshed
export const GEN_DISTANCE = RENDER_DISTANCE + 1;   // radius that gets block data (needed so border faces can be culled)
export const UNLOAD_DISTANCE = RENDER_DISTANCE + 3;
export const CHUNK_GEN_PER_FRAME = 2;
export const CHUNK_MESH_PER_FRAME = 2;

export const PLAYER_WIDTH = 0.6;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_EYE = 1.62;
export const GRAVITY = 32;             // blocks/s^2
export const JUMP_SPEED = 9.0;         // ~1.27 block jump
export const WALK_SPEED = 4.3;
export const SPRINT_SPEED = 5.6;
export const FLY_SPEED = 12;
export const REACH = 5;
export const FOV = 75;
export const MOUSE_SENSITIVITY = 0.0022;
export const DAY_LENGTH_SECONDS = 600;
export const TILE_SIZE = 16;           // px per texture tile
export const ATLAS_TILES = 16;         // tiles per row/column (256x256 atlas)
```

### 5.2 Block IDs (`src/blocks.js`)

```js
export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, COBBLESTONE: 4, SAND: 5,
  LOG: 6, PLANKS: 7, LEAVES: 8, GLASS: 9, WATER: 10, BEDROCK: 11,
};
```

Registry entry per block: `{ id, name, solid, transparent, placeable, breakable, tiles: { top, bottom, side } }` where tiles are atlas tile indices.

- `solid`: blocks the player. Air and water are not solid.
- `transparent`: neighbors' faces behind it must still be drawn (air, water, glass, leaves).
- Placeable (hotbar order, slots 1-9): GRASS, DIRT, STONE, COBBLESTONE, SAND, LOG, PLANKS, LEAVES, GLASS.
- Not placeable / not breakable: WATER (not targetable, rays pass through), BEDROCK (not breakable).
- Grass: top = grass tile, side = grass-side tile, bottom = dirt tile. Log: top/bottom = log-rings, side = bark.

### 5.3 Coordinates and storage

- Block data per chunk: `Uint8Array(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT)`.
- Index: `idx = (y * CHUNK_SIZE + z) * CHUNK_SIZE + x` with local x, z in `0..15`, y in `0..63`.
- World to chunk: `cx = Math.floor(x / CHUNK_SIZE)`, `lx = ((x % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE`. **Always use floor and a positive modulo; negative coordinates must work.**
- Chunk key string: `` `${cx},${cz}` ``.

### 5.4 World API (`src/world/world.js`)

```js
world.getBlock(x, y, z)          // number. AIR for y out of range or unloaded chunk
world.setBlock(x, y, z, id)      // marks chunk dirty; also marks neighbor chunks dirty when on a chunk border
world.getChunk(cx, cz)           // Chunk | undefined
world.hasChunkData(cx, cz)       // boolean
world.heightAt(x, z)             // y of the highest solid block, or -1
world.update(playerX, playerZ)   // schedules generation/unload around player (budgeted per frame)
world.consumeDirtyChunks()       // returns chunks needing a remesh
```

A chunk is meshed only when it and all 4 horizontal neighbors have block data. That prevents border faces from flickering when neighbors load.

### 5.5 Mesher (`src/render/mesher.js`) — PURE

```js
buildChunkGeometry(getBlock, cx, cz)  // getBlock(worldX, y, worldZ) -> id
// returns { solid: {positions, uvs, colors, indices}, water: {...} }  (typed arrays)
```

- No three.js imports. This keeps it unit-testable and ready to move into a Web Worker later.
- Face culling: draw a face of block A toward neighbor B if B is AIR, or B is transparent and `B.id !== A.id`.
- Counter-clockwise winding for front faces (wrong winding = invisible faces, a common bug).
- Per-face shading baked into vertex colors: top 1.0, north/south 0.8, east/west 0.65, bottom 0.5. Optional ambient occlusion multiplies on top (see Task 11).
- UVs inset by half a texel to prevent bleeding between atlas tiles.
- Two outputs: `solid` (opaque + leaves + glass, rendered with `alphaTest: 0.5`) and `water` (transparent, `depthWrite: false`, opacity ~0.7).

### 5.6 Physics (`src/player/physics.js`) — no three.js

```js
stepPlayer(state, input, world, dt)
// state: { x, y, z, vx, vy, vz, onGround, flying, inWater }  (x,y,z = feet position, center of the AABB base)
// input: { forward, strafe, jump, sprint, down }  (forward/strafe in -1..1, already rotated to world space by caller using yaw)
```

- AABB is `PLAYER_WIDTH` x `PLAYER_HEIGHT`.
- Clamp `dt` to 0.05 and substep at max 1/60 s.
- Resolve collisions one axis at a time (Y, then X, then Z). Set `onGround` when blocked moving down.
- No auto-step. No jumping in mid-air. Jump only when `onGround`.

---

## 6. World generation spec (`src/world/terrain.js`)

Deterministic from a numeric seed (use `alea(seed)` to build the noise functions). Same seed must produce identical blocks every time, regardless of the order chunks are generated.

- **Height:** `h = SEA_LEVEL + 2 + 14 * fbm(x/90, z/90) + 10 * max(0, fbm2(x/220, z/220))^2`, rounded and clamped to `[4, WORLD_HEIGHT - 8]`. `fbm` = 4 octaves, persistence 0.5, lacunarity 2. Tune constants so hills peak around y 45, oceans/lakes dip below sea level, and neighboring columns rarely differ by more than 3 blocks.
- **Layers (top to bottom):** y=0 BEDROCK; stone up to `h-4`; 3 layers of DIRT; surface block GRASS.
- **Beaches/underwater:** if surface `<= SEA_LEVEL + 1`, surface and 2 layers beneath are SAND instead of grass/dirt.
- **Water:** fill AIR with WATER from the terrain surface up to `SEA_LEVEL`.
- **Trees:** per-column deterministic hash of `(seed, x, z)`; about 1 in 110 grass columns above sea level+1 gets a tree. Trunk (LOG) height 4-6. Leaves (LEAVES): radius-2 square layers at `top-2` and `top-1`, radius-1 at `top` and `top+1`, with corners randomly trimmed. **Trees near chunk borders must generate correctly across the border:** when generating a chunk, also evaluate tree roots in a 2-block margin around the chunk and write only the blocks that fall inside this chunk. Never overwrite non-air blocks with leaves.
- **Caves (stretch, Task 11):** 3D simplex threshold carve, only between y=5 and `h-5`, never exposing water.

---

## 7. Game feel spec

**Controls**
- Click canvas: pointer lock. Esc: release + pause overlay with controls list and "Click to play". Re-click resumes.
- WASD move, mouse look (pitch clamped to +-89 degrees), Space jump, Shift sprint.
- Double-tap Space: toggle fly mode. In fly mode Space = up, Shift = down, no gravity.
- Left click: break block. Right click: place block. Number keys 1-9 and mouse wheel select hotbar slot.
- F3: toggle debug overlay.
- If the player falls below y = -20, teleport to spawn.

**Interaction**
- Voxel traversal raycast (Amanatides & Woo DDA), reach `REACH`. Returns `{ x, y, z, id, nx, ny, nz }` (hit block and face normal), ignoring AIR and WATER.
- Place at hit + normal. Refuse if the target cell would intersect the player's AABB, is out of world height, or the current slot is empty.
- Breaking is instant. BEDROCK can't be broken.
- Target outline: wireframe cube scaled 1.002 around the targeted block, hidden when nothing is targeted.
- After any edit, remesh the affected chunk (and bordering neighbor chunks) that same frame.

**Spawn**
- Generate and mesh the spawn chunks synchronously before the game starts. Find the nearest land column to (0,0) by spiraling outward, spawn 2 blocks above `heightAt`. Freeze physics until the chunk under the player has block data so the player never falls through the world.

**Streaming**
- Each frame: generate at most `CHUNK_GEN_PER_FRAME` chunks and build at most `CHUNK_MESH_PER_FRAME` meshes, nearest-to-player first. Unload (and **dispose** geometry/materials) beyond `UNLOAD_DISTANCE`. Edited chunks are exempt from the per-frame mesh limit.

**Day/night**
- Full cycle every `DAY_LENGTH_SECONDS`, starting in the morning. Sky color and fog color lerp between day blue, orange sunset, and dark night blue. Fog near/far scales with `RENDER_DISTANCE`. Chunk materials' `color` (gray level 0.25 at night to 1.0 at noon) multiplies the baked vertex colors, so no per-vertex relighting is needed. Visible sun and moon (simple flat quads or sprites orbiting the player).

**HUD**
- Crosshair centered. Hotbar of 9 slots at bottom center, selected slot highlighted. Icons are small isometric cubes drawn on a canvas using the block's top and two side tiles from the atlas (nearest-neighbor, no blur). F3 overlay shows FPS, frame ms, XYZ, chunk coords, facing direction, loaded chunk count, mesh queue length, triangle count, seed, time of day.

**Save/load**
- Save: seed, player position/yaw/pitch/fly state, hotbar selection, time of day, and **only edited blocks** as `{ "cx,cz": [[index, id], ...] }`. Terrain regenerates from the seed; edits are re-applied on top.
- Autosave every 10 seconds and on `beforeunload`. Wrap storage in try/catch (quota errors must not crash the game). Pause menu has a "New World" button (confirm first) that picks a new random seed and clears the save.

---

## 8. Testing spec (`tests/*.test.js`, run with `npm test`)

Pure logic must have unit tests. The mesher, physics, raycast, terrain, and save code are designed to run without a browser or WebGL.

- **blocks:** every tile index is within `ATLAS_TILES * ATLAS_TILES`; every block id in `B` has a registry entry; exactly 9 placeable blocks.
- **coords:** world to chunk/local conversion round-trips, including negative coordinates (e.g. x = -1 maps to chunk -1, local 15).
- **terrain:** same seed gives identical chunk data; different seeds differ; bedrock at y=0 everywhere; no block ids outside the enum; a tree that crosses a chunk border is complete when both chunks are generated, in either generation order.
- **mesher:** a single block in empty space produces 6 faces (12 triangles); two adjacent blocks produce 10 faces; a block at a chunk border culls correctly against the neighbor chunk's blocks; water-water faces are culled; glass next to stone draws the stone face.
- **raycast:** hits the first solid block, correct face normal for each of the 6 directions, misses beyond `REACH`, ignores water, works with negative coordinates.
- **physics (fake flat world):** standing on a floor stays put; falling lands on the ground and sets `onGround`; walking into a wall stops; can't jump through a 2-block ceiling; jump apex is about 1.2-1.3 blocks; can't jump while airborne; fly mode ignores gravity.
- **save:** edit map serializes and re-applies identically; corrupt or missing save data falls back to a new world without throwing.

If Playwright can be installed and a headless browser can run, add one smoke test that loads the dev server and asserts no console errors for 5 seconds. If it can't run in this environment, skip it and add "load the game and watch the console" to `MANUAL_CHECKS.md`.

---

## 9. Tasks

Parallel groups run in order. Tasks within a group can run at the same time. Each task lists owned files, work, and acceptance criteria.

### Group A

- [x] **1. Scaffold and contracts** — files: everything at repo root, `src/config.js`, `src/blocks.js` (IDs + empty registry), `src/main.js`, `index.html`, `src/ui/style.css`, `tests/`
  - Vite + three + simplex-noise + alea + vitest installed. Scripts: `dev`, `build`, `test`. `.gitignore` (node_modules, dist). Create `DECISIONS.md` and `MANUAL_CHECKS.md`.
  - Create `config.js` and the block ID enum exactly as in section 5.
  - `main.js` renders a spinning test cube with the renderer, handles window resize, caps pixel ratio at 2.
  - Acceptance: `npm run build` and `npm test` pass (a trivial test is fine); dev server starts; README has run instructions.

### Group B (parallel; each depends only on Task 1)

- [x] **2. Texture atlas and block registry** — files: `src/render/atlas.js`, `src/blocks.js`, `tests/blocks.test.js`
  - Generate a 256x256 canvas atlas of 16x16 tiles with pixel-art style procedural textures: grass top, grass side, dirt, stone, cobblestone, sand, log side (bark), log top (rings), planks, leaves (with transparent holes), glass (transparent with border), water, bedrock. Seeded noise for variation so it's deterministic.
  - `THREE.CanvasTexture` with `NearestFilter`, no mipmaps, `colorSpace = SRGBColorSpace`.
  - Fill in the full registry (section 5.2). Export `tileUV(tileIndex)` returning inset UV rect.
  - Acceptance: blocks tests pass; a temporary debug page or test confirms every tile index is distinct and in range. Add "inspect atlas visually" to `MANUAL_CHECKS.md`.

- [x] **3. World storage and terrain generation** — files: `src/world/chunk.js`, `src/world/world.js`, `src/world/terrain.js`, `tests/coords.test.js`, `tests/terrain.test.js`
  - Implement the World API from 5.4 (streaming logic with budgets, dirty tracking, border-neighbor dirtying) and terrain per section 6. Use the block ID enum from `blocks.js` (don't wait for the full registry).
  - Acceptance: coords and terrain tests pass, including determinism, negative coordinates, and cross-border trees; generating a 13x13 chunk area completes in under 1.5 s in a test (log the time).

- [x] **4. Player physics and collision** — files: `src/player/physics.js`, `tests/physics.test.js`
  - Implement `stepPlayer` per 5.6 with walking, sprint, jump, gravity, fly mode, and basic water behavior (in water: reduced gravity, slower movement, Space swims up). Tested against a fake in-memory world.
  - Acceptance: every physics test in section 8 passes.

### Group C

- [x] **5. Mesher and chunk rendering** — files: `src/render/mesher.js`, `src/render/chunkMeshes.js`, `tests/mesher.test.js`
  - Pure `buildChunkGeometry` per 5.5. `chunkMeshes.js` converts output to `THREE.BufferGeometry` + meshes (solid with `alphaTest`, water transparent), sets bounding spheres so frustum culling works, and disposes geometry on removal.
  - Acceptance: mesher tests pass; a manager-wired scene renders a visible terrain patch (note visual check in `MANUAL_CHECKS.md`).

### Group D

- [x] **6. Controls, camera, game loop integration** — files: `src/player/controls.js`, `src/player/player.js`, `src/render/renderer.js`, `src/main.js` (this task may edit `main.js`)
  - Pointer lock + input state, yaw/pitch camera, spawn logic from section 7, streaming loop wired (generate, mesh, unload), fixed-order frame: input, physics, world.update, mesh budget, render. Pause on pointer-lock loss. Void-fall respawn.
  - Acceptance: build passes; the game boots into terrain, the player can walk/jump/fly, collides with terrain, doesn't fall through the world on load or while moving fast across chunk borders (add a regression test for "player on a chunk border" if physics allows). Add feel checks to `MANUAL_CHECKS.md`.

### Group E (parallel; manager wires `main.js` after the group)

- [x] **7. Raycast and block editing** — files: `src/world/raycast.js`, `tests/raycast.test.js`, edit logic exported from `src/player/player.js` or a new `src/player/interaction.js`
  - DDA raycast, break/place rules, target outline mesh factory, selected-slot input. Remesh edited chunks immediately.
  - Acceptance: raycast tests pass; placing/breaking logic has unit tests for "can't place inside player", "can't break bedrock", "ray ignores water".

- [x] **8. HUD, hotbar, pause menu, debug overlay** — files: `src/ui/hud.js`, `src/ui/hotbar.js`, `src/ui/debug.js`, `src/ui/style.css`
  - Per section 7 HUD. Pause overlay with controls list. Isometric cube icons from the atlas. F3 overlay fed by a stats object the manager passes in.
  - Acceptance: build passes; modules export `createHud`, `createHotbar`, `createDebugOverlay` with documented parameters; icons render for all 9 placeable blocks (visual check logged in `MANUAL_CHECKS.md`).

- [x] **9. Sky, day/night, fog, water look** — files: `src/render/sky.js`
  - `createSky(scene, renderer)` returning `update(timeOfDay, playerPos)`. Handles sky/fog colors, sun and moon, and exposes a `brightness` value (0.25-1.0) the manager applies to chunk materials. Underwater tint when the camera is inside water.
  - Acceptance: build passes; unit test for the color/brightness curve (continuous, correct at dawn/noon/dusk/midnight).

### Group F (parallel)

- [x] **10. Save/load** — files: `src/save/save.js`, `tests/save.test.js`
  - Per section 7: serialize/deserialize edits + player state, autosave hooks, "New World" support, crash-safe parsing.
  - Acceptance: save tests pass; manager-wired game restores position and edited blocks after a page reload (log in `MANUAL_CHECKS.md`).

- [ ] **11. Polish and performance** — files: `src/render/mesher.js`, `src/render/chunkMeshes.js`, `src/world/terrain.js`, `src/world/world.js` (coordinate with Task 10 via the manager; no overlapping edits)
  - Baked ambient occlusion per vertex (fix the quad-flip artifact by choosing the diagonal based on AO values).
  - Reuse typed arrays and vectors in hot paths; no per-frame allocations in the main loop.
  - Optional caves (section 6).
  - Measure frame time spikes with the debug overlay budget numbers; if meshing exceeds ~6 ms per chunk, reduce per-frame mesh count or move meshing to a Web Worker (the mesher is already pure). Log the decision.
  - Acceptance: all tests still pass; AO test (a block in a corner has darker vertices than an exposed one); no memory growth when moving around (dispose verified by checking `renderer.info.memory.geometries` stays bounded; log the numbers).

### Group G

- [ ] **12. Final QA and cleanup**
  - Run `npm test` and `npm run build` clean. Remove dead code, debug logs, and unused files. Make sure no file references the word "Minecraft".
  - Spawn an **independent reviewer sub-agent** that hasn't seen the build process. It reads the code and this file, checks every acceptance criterion and the contracts in section 5, and reports mismatches. Fix what it finds (re-verify).
  - Finish `README.md`: controls, how to run, how to build, project structure, known limitations.
  - Make sure `MANUAL_CHECKS.md` lists everything a human should test (movement feel, block break/place, chunk borders, day/night, save/reload, F3 numbers, window resize, tab-switch while playing).
  - Acceptance: the repo builds from a fresh clone with `npm install && npm run build`; final summary delivered to the user.

---

## 10. Known pitfalls (check these before claiming done)

- Negative-coordinate modulo bugs (use floor + positive modulo).
- Inverted triangle winding makes faces invisible.
- Texture bleeding at atlas tile edges (inset UVs; `NearestFilter`; no mipmaps).
- Water z-fighting and sorting: `depthWrite: false`, render water after solid.
- Pointer lock only works from a user gesture.
- Geometry leaks on chunk unload (`geometry.dispose()`).
- Huge `dt` after tab switch (clamp it).
- Holes at chunk borders from meshing before neighbors have data.
- Player falling through the world while chunks are still generating.
- Mouse look feeling wrong from yaw/pitch order (apply yaw about Y, then pitch about X, `rotation.order = 'YXZ'`).
- `devicePixelRatio` of 3 tanking FPS (cap at 2).
- Placing a block into your own body.

## 11. Definition of done

- Every task is `[x]` (or `[~]` with a logged reason).
- `npm install && npm run build` and `npm test` pass from a clean state.
- The game loads into a generated world, the player can move, jump, fly, break and place blocks, and the world streams in around them.
- Day/night, hotbar, F3 overlay, and save/load all work.
- `README.md`, `DECISIONS.md`, and `MANUAL_CHECKS.md` are complete and honest.
- The user gets a short final summary and run instructions.
