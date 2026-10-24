// Boot + game loop + wiring (PROJECT.md section 4: manager / integration tasks only).
//
// Sections:
//   1. Seed
//   2. Renderer, atlas, chunk meshes, world
//   3. Spawn: generate + mesh the spawn area synchronously before the first frame
//   4. Controls + player
//   5. Pause overlay (TEMPORARY, replaced by the Task 8 HUD)
//   6. Game loop (fixed frame order)
//   7. Dev-only automation hook
//
// Frame order: dt -> input/player -> world streaming -> unload meshes -> mesh budget -> render.

import * as THREE from 'three';
import './ui/style.css';
import { GEN_DISTANCE, CHUNK_MESH_PER_FRAME, MAX_DT } from './config.js';
import { createRenderer } from './render/renderer.js';
import { createAtlas } from './render/atlas.js';
import { buildChunkGeometry } from './render/mesher.js';
import { createChunkMeshes } from './render/chunkMeshes.js';
import { World } from './world/world.js';
import { createControls } from './player/controls.js';
import { createPlayer, findSpawn } from './player/player.js';

// ---- 1. Seed -----------------------------------------------------------------
// `?seed=<int>` in the URL, otherwise a random 31-bit int. (Save/load, Task 10, will supply it.)

function readSeed() {
  const param = new URLSearchParams(window.location.search).get('seed');
  if (param !== null && /^\s*-?\d+\s*$/.test(param)) {
    const n = Number.parseInt(param, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  return Math.floor(Math.random() * 0x80000000);
}

const seed = readSeed();

// ---- 2. Renderer, atlas, chunk meshes, world -------------------------------------

const { renderer, scene, camera } = createRenderer(document.getElementById('app'));
const { texture } = createAtlas();
const chunkMeshes = createChunkMeshes(scene, texture);
const world = new World(seed);

// Created once; the mesher calls it ~20k times per chunk.
const getBlock = (x, y, z) => world.getBlock(x, y, z);

function meshChunks(chunks) {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    chunkMeshes.setChunk(c.key, c.cx, c.cz, buildChunkGeometry(getBlock, c.cx, c.cz));
  }
}

// ---- 3. Spawn ---------------------------------------------------------------------

const spawn = findSpawn(world);
world.generateAround(spawn.x, spawn.z, GEN_DISTANCE);
meshChunks(world.consumeDirtyChunks());
const spawnY = world.heightAt(spawn.x, spawn.z) + 2; // feet 2 blocks above the top solid block

// ---- 4. Controls + player -----------------------------------------------------------

const controls = createControls(renderer.domElement);
const player = createPlayer({ camera, world, controls });
player.setSpawn(spawn.x, spawnY, spawn.z);
player.teleport(spawn.x, spawnY, spawn.z);

// ---- 5. Pause overlay ----------------------------------------------------------------
// TEMPORARY: a minimal pause screen until Task 8 (ui/hud.js) replaces it with the real HUD
// and pause menu. Shown whenever the pointer isn't locked; clicking it re-locks.

const pauseOverlay = document.createElement('div');
pauseOverlay.className = 'temp-pause';
pauseOverlay.innerHTML = `
  <div class="temp-pause__panel">
    <h1>Voxel Sandbox</h1>
    <p class="temp-pause__cta">Click to play</p>
    <ul>
      <li><b>WASD</b> move</li>
      <li><b>Mouse</b> look</li>
      <li><b>Space</b> jump</li>
      <li><b>Space Space</b> toggle fly</li>
      <li><b>Shift</b> sprint / fly down</li>
      <li><b>F3</b> debug</li>
      <li><b>Esc</b> pause</li>
    </ul>
  </div>`;
pauseOverlay.addEventListener('click', () => controls.requestLock());
document.body.appendChild(pauseOverlay);

let paused = true;
let forcePlay = false; // dev automation only (section 7)

function setPaused(p) {
  if (p === paused) return;
  paused = p;
  pauseOverlay.classList.toggle('temp-pause--hidden', !p);
}

// ---- 6. Game loop ----------------------------------------------------------------------

const timer = new THREE.Timer();
timer.connect(document); // Page Visibility API: no huge dt after a tab switch

function frame(time) {
  // dt
  timer.update(time);
  const dt = Math.min(timer.getDelta(), MAX_DT);
  setPaused(!(controls.locked || forcePlay));

  // Input + player (mouse look, movement, physics, camera)
  player.update(dt, !paused);

  // One-shot inputs not wired yet: read and drop them every frame so they don't fire late.
  // Task 7: for each action in consumeActions(): raycast + break/place, remesh edited chunks now.
  // Task 8: consumeWheel() / consumeSlotKey() -> hotbar; consumeDebugToggle() -> F3 overlay.
  controls.consumeActions();
  controls.consumeWheel();
  controls.consumeSlotKey();
  controls.consumeDebugToggle();

  // World streaming: generate around the player, dispose meshes of unloaded chunks
  world.update(player.state.x, player.state.z);
  const unloaded = world.consumeUnloadedChunks();
  for (let i = 0; i < unloaded.length; i++) chunkMeshes.removeChunk(unloaded[i]);

  // Mesh budget (edited chunks bypass the limit inside consumeDirtyChunks)
  meshChunks(world.consumeDirtyChunks(CHUNK_MESH_PER_FRAME));

  // Task 9: sky.update(timeOfDay, camera.position); chunkMeshes.setBrightness(sky.brightness)
  // Task 8: hud/debug overlay update (stats: fps, position, chunks, queue, triangles, seed)

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(frame);

// ---- 7. Dev-only automation hook -----------------------------------------------------------
// Pointer lock can't be used headless. setForcePlay(true) runs the game unpaused without a lock,
// so synthetic key (and mouse) events drive the player. Stripped from production builds.

if (import.meta.env.DEV) {
  window.__game = {
    world, player, controls, renderer, scene, camera, chunkMeshes, seed,
    setForcePlay(on) {
      forcePlay = !!on;
      controls.setForceCapture(forcePlay);
    },
  };
}
