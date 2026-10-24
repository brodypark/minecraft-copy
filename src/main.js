// Boot + game loop + wiring (PROJECT.md section 4: manager / integration tasks only).
//
// Sections:
//   1. Seed and save (restore)
//   2. Renderer, atlas, chunk meshes, sky, world
//   3. Spawn: generate + mesh the start area synchronously before the first frame
//   4. Controls + player
//   5. HUD (crosshair + pause menu), hotbar, debug overlay
//   6. Block targeting + editing
//   7. Save: autosave + "New World"
//   8. Game loop (fixed frame order)
//   9. Dev-only automation hook
//
// Frame order: dt -> input/player -> hotbar/F3 -> target + edits -> world streaming ->
// unload meshes -> mesh budget -> mesh visibility -> sky -> debug stats -> render.

import * as THREE from 'three';
import './ui/style.css';
import {
  GEN_DISTANCE, RENDER_DISTANCE, CHUNK_MESH_PER_FRAME, MAX_DT, REACH, DAY_START_TIME, DAY_LENGTH_SECONDS,
} from './config.js';
import { B, HOTBAR_BLOCKS, getBlockDef } from './blocks.js';
import { createRenderer } from './render/renderer.js';
import { createAtlas } from './render/atlas.js';
import { buildChunkGeometry } from './render/mesher.js';
import { createChunkMeshes } from './render/chunkMeshes.js';
import { createSky } from './render/sky.js';
import { createTargetOutline } from './render/outline.js';
import { World } from './world/world.js';
import { toChunkCoord } from './world/chunk.js';
import { raycast, createHit } from './world/raycast.js';
import { createControls } from './player/controls.js';
import { createPlayer, findSpawn } from './player/player.js';
import { performAction } from './player/interaction.js';
import { createHud } from './ui/hud.js';
import { createHotbar } from './ui/hotbar.js';
import { createDebugOverlay, createFrameStats } from './ui/debug.js';
import { loadGame, clearSave, createAutosaver } from './save/save.js';

// ---- 1. Seed and save -----------------------------------------------------------
// A valid save is restored. A `?seed=<int>` URL param that differs from the saved seed starts a
// fresh world with that seed (the old save is overwritten at the next autosave); a matching one
// restores the save, so reloading after "New World" (which leaves ?seed= in the URL) keeps progress.
// With neither, the seed is a random 31-bit int.

function randomSeed() {
  return Math.floor(Math.random() * 0x80000000);
}

function readUrlSeed() {
  const param = new URLSearchParams(window.location.search).get('seed');
  if (param !== null && /^\s*-?\d+\s*$/.test(param)) {
    const n = Number.parseInt(param, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  return null;
}

const urlSeed = readUrlSeed();
let save = loadGame();
if (save && urlSeed !== null && urlSeed !== save.seed) save = null;
const seed = save ? save.seed : (urlSeed ?? randomSeed());

// ---- 2. Renderer, atlas, chunk meshes, sky, world -------------------------------

const { renderer, scene, camera } = createRenderer(document.getElementById('app'));
const atlas = createAtlas();
const chunkMeshes = createChunkMeshes(scene, atlas.texture);
const sky = createSky(scene);
const world = new World(seed);
if (save) world.applyEdits(save.edits); // before any generation, so chunks generate with edits applied
let timeOfDay = save ? save.timeOfDay : DAY_START_TIME;

// Created once; the mesher calls it ~20k times per chunk.
const getBlock = (x, y, z) => world.getBlock(x, y, z);

function meshChunks(chunks) {
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i];
    chunkMeshes.setChunk(c.key, c.cx, c.cz, buildChunkGeometry(getBlock, c.cx, c.cz));
  }
}

// ---- 3. Spawn ---------------------------------------------------------------------
// Generate and mesh around the saved position (or the spawn point) before the first frame.

const spawn = findSpawn(world);
const savedPlayer = save ? save.player : null; // null when the save had no usable position
world.generateAround(savedPlayer ? savedPlayer.x : spawn.x, savedPlayer ? savedPlayer.z : spawn.z, GEN_DISTANCE);
meshChunks(world.consumeDirtyChunks());
// Feet 2 blocks above the top solid block. A restored player far from spawn may not have the spawn
// chunk loaded (heightAt -1), so fall back to the terrain height there.
const spawnTop = world.heightAt(spawn.x, spawn.z);
const spawnY = (spawnTop >= 0 ? spawnTop : world.terrain.surfaceHeight(Math.floor(spawn.x), Math.floor(spawn.z))) + 2;

// ---- 4. Controls + player -----------------------------------------------------------

const controls = createControls(renderer.domElement);
const player = createPlayer({ camera, world, controls });
player.setSpawn(spawn.x, spawnY, spawn.z);
if (savedPlayer) {
  player.teleport(savedPlayer.x, savedPlayer.y, savedPlayer.z);
  player.setLook(savedPlayer.yaw, savedPlayer.pitch);
  player.state.flying = savedPlayer.flying;
} else {
  player.teleport(spawn.x, spawnY, spawn.z);
}

// ---- 5. HUD, hotbar, debug overlay ----------------------------------------------------

const hud = createHud(document.body, {
  onResume: () => controls.requestLock(),
  onNewWorld: startNewWorld,
});
const hotbar = createHotbar(document.body, { atlasCanvas: atlas.canvas, blocks: HOTBAR_BLOCKS });
if (save) hotbar.setSelectedIndex(save.hotbarIndex);
const debug = createDebugOverlay(document.body);
const frameStats = createFrameStats();

// One stats object, mutated in place every frame; the overlay reads it a few times per second.
const stats = {
  fps: 0, frameMs: 0, frameMaxMs: 0, x: 0, y: 0, z: 0, cx: 0, cz: 0, yaw: 0,
  loadedChunks: 0, meshQueue: 0, triangles: 0, drawCalls: 0, geometries: 0,
  seed, timeOfDay, flying: false, selectedBlock: '',
};

function updateStats() {
  const s = player.state;
  stats.fps = frameStats.fps;
  stats.frameMs = frameStats.frameMs;
  stats.frameMaxMs = frameStats.maxFrameMs;
  stats.x = s.x;
  stats.y = s.y;
  stats.z = s.z;
  stats.cx = toChunkCoord(s.x);
  stats.cz = toChunkCoord(s.z);
  stats.yaw = player.yaw;
  stats.loadedChunks = world.loadedChunkCount();
  stats.meshQueue = world.pendingMeshCount();
  stats.triangles = chunkMeshes.triangleCount();
  stats.drawCalls = renderer.info.render.calls; // from the previous frame's render
  stats.geometries = renderer.info.memory.geometries;
  stats.timeOfDay = timeOfDay;
  stats.flying = s.flying;
  stats.selectedBlock = getBlockDef(hotbar.getSelectedBlock()).name;
}

let paused = true;
let forcePlay = false; // dev automation only (section 9)

function setPaused(p) {
  if (p === paused) return;
  paused = p;
  hud.setPaused(p);
}

// ---- 6. Block targeting + editing -----------------------------------------------------

const outline = createTargetOutline(scene);
const lookDir = new THREE.Vector3();
const targetHit = createHit();

// The camera has no parent, so its position is the eye in world space.
function queryTarget() {
  camera.getWorldDirection(lookDir);
  const p = camera.position;
  return raycast(getBlock, p.x, p.y, p.z, lookDir.x, lookDir.y, lookDir.z, REACH, targetHit);
}

// ---- 7. Save: autosave every 10 s and on beforeunload; "New World" -----------------------

const autosaver = createAutosaver({
  collect() {
    const s = player.state;
    return {
      seed,
      player: { x: s.x, y: s.y, z: s.z, yaw: player.yaw, pitch: player.pitch, flying: s.flying },
      hotbarIndex: hotbar.getSelectedIndex(),
      timeOfDay,
      edits: world.getEdits(),
    };
  },
});
autosaver.start();

function startNewWorld() {
  autosaver.stop(); // also removes the beforeunload save, so the old world isn't re-saved on unload
  clearSave();
  window.location.assign(`${window.location.pathname}?seed=${randomSeed()}`);
}

// ---- 8. Game loop ----------------------------------------------------------------------

const timer = new THREE.Timer();
timer.connect(document); // Page Visibility API: no huge dt after a tab switch

// Chunk the player was in last frame: meshes beyond RENDER_DISTANCE of it are hidden.
let viewCx = NaN;
let viewCz = NaN;

function frame(time) {
  // dt (raw delta feeds the FPS counter; the simulation uses the clamped one)
  timer.update(time);
  const rawDt = timer.getDelta();
  frameStats.tick(rawDt);
  const dt = Math.min(rawDt, MAX_DT);
  setPaused(!(controls.locked || forcePlay));

  // Input + player (mouse look, movement, physics, camera)
  player.update(dt, !paused);

  // Hotbar selection and F3
  const wheel = controls.consumeWheel();
  const slot = controls.consumeSlotKey();
  if (!paused) {
    if (wheel !== 0) hotbar.scroll(wheel);
    if (slot >= 0) hotbar.setSelectedIndex(slot);
  }
  if (controls.consumeDebugToggle()) debug.toggle();

  // Target + edits. Edited chunks are marked urgent, so the mesh step below rebuilds them this frame.
  const actions = controls.consumeActions();
  let target = paused ? null : queryTarget();
  if (!paused) {
    for (let i = 0; i < actions.length; i++) {
      if (performAction(actions[i], world, target, hotbar.getSelectedBlock(), player.state)) {
        target = queryTarget(); // re-aim after each edit
      }
    }
  }
  outline.update(target);

  // World streaming: generate around the player, dispose meshes of unloaded chunks
  world.update(player.state.x, player.state.z);
  const unloaded = world.consumeUnloadedChunks();
  for (let i = 0; i < unloaded.length; i++) chunkMeshes.removeChunk(unloaded[i]);

  // Mesh budget (edited chunks bypass the limit inside consumeDirtyChunks)
  meshChunks(world.consumeDirtyChunks(CHUNK_MESH_PER_FRAME));
  const pcx = toChunkCoord(player.state.x);
  const pcz = toChunkCoord(player.state.z);
  if (pcx !== viewCx || pcz !== viewCz) {
    viewCx = pcx;
    viewCz = pcz;
    chunkMeshes.setVisibleRadius(pcx, pcz, RENDER_DISTANCE);
  }

  // Sky: time advances only while playing; brightness dims the chunk materials
  if (!paused) timeOfDay = (timeOfDay + dt / DAY_LENGTH_SECONDS) % 1;
  const eye = camera.position;
  sky.update(timeOfDay, eye, world.getBlock(eye.x, eye.y, eye.z) === B.WATER);
  chunkMeshes.setBrightness(sky.brightness);

  // Debug overlay (reads the stats object only a few times per second)
  updateStats();
  debug.update(stats);

  renderer.render(scene, camera);
}

renderer.setAnimationLoop(frame);

// ---- 9. Dev-only automation hook -----------------------------------------------------------
// Pointer lock can't be used headless. setForcePlay(true) runs the game unpaused without a lock,
// so synthetic key (and mouse) events drive the player. Stripped from production builds.

if (import.meta.env.DEV) {
  window.__game = {
    world, player, controls, renderer, scene, camera, chunkMeshes, sky, hotbar, debug, seed, autosaver,
    getTimeOfDay: () => timeOfDay,
    setTimeOfDay(t) { timeOfDay = ((t % 1) + 1) % 1; },
    getTarget: () => (paused ? null : queryTarget()),
    setForcePlay(on) {
      forcePlay = !!on;
      controls.setForceCapture(forcePlay);
    },
  };
}
