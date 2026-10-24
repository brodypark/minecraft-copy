// Player: ties physics, controls and the camera together (PROJECT.md Task 6, section 7).
// No three.js import: the camera is passed in and only its position/rotation are written.
//
// Per frame, update(dt, active):
//   1. Mouse look (active only): yaw -= dx * MOUSE_SENSITIVITY, pitch -= dy * MOUSE_SENSITIVITY,
//      pitch clamped to +-89 degrees.
//   2. Space double-tap (active only) toggles state.flying and zeroes vy.
//   3. WASD -> f = W - S, r = D - A, rotated into world space by yaw (formula in physics.js).
//      Space = jump / fly up; Shift = sprint when walking, descend when flying.
//   4. stepPlayer, unless the chunk under the player has no block data yet (frozen, so the
//      player never falls through terrain that hasn't generated).
//   5. Void respawn below VOID_Y.
//   6. Camera at feet + PLAYER_EYE, rotation (pitch, yaw, 0) in 'YXZ' order.
// While inactive (paused) one-shot inputs are still read and dropped, so they don't fire on
// resume, and the camera still syncs.
//
// Physics writes state.flying (landing ends flight), so always read it from state.

import { PLAYER_EYE, MOUSE_SENSITIVITY, SEA_LEVEL, VOID_Y, PITCH_LIMIT } from '../config.js';
import { createPlayerState, stepPlayer } from './physics.js';
import { toChunkCoord } from '../world/chunk.js';

const SPAWN_SEARCH_RADIUS = 256; // blocks; findSpawn gives up beyond this
const SPAWN_TREE_CLEARANCE = 2;  // no tree root within this many blocks (leaf radius), so no canopy overhead
const TWO_PI = Math.PI * 2;

/**
 * Find the land column nearest to (0, 0): surface above sea level and no tree within
 * SPAWN_TREE_CLEARANCE blocks (so the player isn't put inside or on top of a tree).
 * Spirals outward in square rings and returns the Euclidean-nearest match.
 * Uses only the pure terrain functions, so no chunks need to be loaded.
 *
 * @param {{ terrain: { surfaceHeight: (x: number, z: number) => number, treeAt: (x: number, z: number) => number } }} world
 * @returns {{ x: number, z: number }} block center (bx + 0.5, bz + 0.5); (0.5, 0.5) if nothing found
 */
export function findSpawn(world) {
  const terrain = world.terrain;

  function treeNear(bx, bz) {
    const r = SPAWN_TREE_CLEARANCE;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (terrain.treeAt(bx + dx, bz + dz) !== 0) return true;
      }
    }
    return false;
  }

  function good(bx, bz) {
    return terrain.surfaceHeight(bx, bz) > SEA_LEVEL && !treeNear(bx, bz);
  }

  let bestX = 0;
  let bestZ = 0;
  let bestD2 = Infinity;
  for (let ring = 0; ring <= SPAWN_SEARCH_RADIUS; ring++) {
    if (ring * ring >= bestD2) break; // no column in this ring is nearer than the best match
    for (let dz = -ring; dz <= ring; dz++) {
      const edge = dz === -ring || dz === ring;
      const step = edge ? 1 : 2 * ring; // interior rows: only the two side columns
      for (let dx = -ring; dx <= ring; dx += step || 1) {
        const d2 = dx * dx + dz * dz;
        if (d2 >= bestD2) continue;
        if (good(dx, dz)) {
          bestX = dx;
          bestZ = dz;
          bestD2 = d2;
        }
      }
    }
  }
  if (bestD2 === Infinity) return { x: 0.5, z: 0.5 };
  return { x: bestX + 0.5, z: bestZ + 0.5 };
}

/**
 * Create the player.
 *
 * @param {{
 *   camera: { position: { set: Function }, rotation: { set: Function, order: string } },
 *   world: { getBlock: Function, hasChunkData: (cx: number, cz: number) => boolean },
 *   controls: { isDown: (code: string) => boolean, consumeMouseDelta: () => { dx: number, dy: number }, consumeFlyToggle: () => boolean },
 * }} deps
 */
export function createPlayer({ camera, world, controls }) {
  const state = createPlayerState(0, 0, 0);
  const input = { forward: 0, strafe: 0, jump: false, sprint: false, down: false };
  let snapToGround = false; // set by respawn(): re-place the feet once the spawn chunk has data
  const spawnPoint = { x: 0.5, y: 0, z: 0.5 };

  const player = {
    /** Physics state { x, y, z, vx, vy, vz, onGround, flying, inWater }; (x, y, z) = feet. */
    state,
    /** Radians about +Y; 0 looks toward -Z, positive turns left (toward -X). */
    yaw: 0,
    /** Radians about X; positive looks up. Clamped to +-89 degrees. */
    pitch: 0,
    /** Where respawn() puts the player (feet position). */
    spawnPoint,
    update,
    teleport,
    respawn,
    setLook,
    setSpawn,
  };

  function clampPitch(p) {
    return p > PITCH_LIMIT ? PITCH_LIMIT : p < -PITCH_LIMIT ? -PITCH_LIMIT : p;
  }

  function wrapYaw(y) {
    // Keep yaw in [-PI, PI) so it never loses precision after long play.
    return y - TWO_PI * Math.floor((y + Math.PI) / TWO_PI);
  }

  function syncCamera() {
    camera.position.set(state.x, state.y + PLAYER_EYE, state.z);
    camera.rotation.set(player.pitch, player.yaw, 0, 'YXZ');
  }

  /**
   * Advance one frame.
   * @param {number} dt seconds (stepPlayer clamps and substeps it)
   * @param {boolean} active false while paused: no input, no physics, camera still syncs
   */
  function update(dt, active) {
    const mouse = controls.consumeMouseDelta();
    const flyToggle = controls.consumeFlyToggle();

    if (active) {
      if (mouse.dx !== 0 || mouse.dy !== 0) {
        player.yaw = wrapYaw(player.yaw - mouse.dx * MOUSE_SENSITIVITY);
        player.pitch = clampPitch(player.pitch - mouse.dy * MOUSE_SENSITIVITY);
      }

      if (flyToggle) {
        state.flying = !state.flying;
        state.vy = 0;
      }

      const f = (controls.isDown('KeyW') ? 1 : 0) - (controls.isDown('KeyS') ? 1 : 0);
      const r = (controls.isDown('KeyD') ? 1 : 0) - (controls.isDown('KeyA') ? 1 : 0);
      const sin = Math.sin(player.yaw);
      const cos = Math.cos(player.yaw);
      input.strafe = r * cos - f * sin;
      input.forward = -r * sin - f * cos;
      const shift = controls.isDown('ShiftLeft') || controls.isDown('ShiftRight');
      input.jump = controls.isDown('Space');
      input.sprint = shift && !state.flying;
      input.down = shift && state.flying;

      if (world.hasChunkData(toChunkCoord(state.x), toChunkCoord(state.z))) {
        if (snapToGround) {
          // The spawn column may have changed since the spawn point was set (the player built over it):
          // stand on whatever is there now.
          snapToGround = false;
          const top = world.heightAt(Math.floor(state.x), Math.floor(state.z));
          if (top >= 0) state.y = top + 2;
        }
        stepPlayer(state, input, world, dt);
      }

      if (state.y < VOID_Y) respawn();
    }

    syncCamera();
  }

  /** Move the feet to (x, y, z) and stop all motion. Fly mode is kept. */
  function teleport(x, y, z) {
    state.x = x;
    state.y = y;
    state.z = z;
    state.vx = 0;
    state.vy = 0;
    state.vz = 0;
    state.onGround = false;
    syncCamera();
  }

  /**
   * Teleport to the spawn point and leave fly mode. Once the spawn chunk has data, the next update
   * re-places the feet 2 blocks above the column's current top block.
   */
  function respawn() {
    state.flying = false;
    teleport(spawnPoint.x, spawnPoint.y, spawnPoint.z);
    snapToGround = true;
  }

  /** Set the view direction (radians); pitch is clamped to +-89 degrees. */
  function setLook(yaw, pitch) {
    player.yaw = wrapYaw(Number(yaw) || 0);
    player.pitch = clampPitch(Number(pitch) || 0);
    syncCamera();
  }

  /** Set the spawn point (feet position) used by respawn(). */
  function setSpawn(x, y, z) {
    spawnPoint.x = x;
    spawnPoint.y = y;
    spawnPoint.z = z;
  }

  syncCamera();
  return player;
}
