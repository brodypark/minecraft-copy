// Block editing rules: break and place (PROJECT.md section 7 Interaction).
// Pure module: no three.js, no DOM. Works on a raycast hit ({ x, y, z, id, nx, ny, nz, ... } from
// world/raycast.js) and the World API (getBlock / setBlock).
//
// World.setBlock already marks the edited chunk and any bordering neighbor chunks dirty + urgent,
// so world.consumeDirtyChunks() returns them the same frame regardless of the mesh budget. Nothing
// here touches remeshing.
//
// Both functions re-read the live block at the hit cell instead of trusting hit.id, so a stale hit
// (e.g. a second click handled in the same frame after the first one edited the world) can't break
// air or place a block against nothing. The caller should still re-raycast after each edit.

import { WORLD_HEIGHT } from '../config.js';
import { B, isBreakable, isPlaceable } from '../blocks.js';
import { aabbIntersectsBlock } from './physics.js';

/**
 * Break the hit block (instant). Refuses a null hit and unbreakable blocks (BEDROCK, WATER, AIR).
 *
 * @param {{ getBlock: Function, setBlock: Function }} world
 * @param {{ x: number, y: number, z: number } | null} hit raycast result
 * @returns {boolean} true if the block was removed
 */
export function tryBreak(world, hit) {
  if (!hit) return false;
  const id = world.getBlock(hit.x, hit.y, hit.z);
  if (!isBreakable(id)) return false;
  return world.setBlock(hit.x, hit.y, hit.z, B.AIR);
}

/**
 * Place `blockId` in the cell in front of the hit face (hit + normal).
 * Refuses (returns false, world unchanged) when:
 *   - hit is null, its normal is (0, 0, 0) (origin inside the block), or the hit cell no longer
 *     holds a targetable block (stale hit);
 *   - blockId is missing, AIR or not placeable (the "current slot is empty" case);
 *   - the target y is outside 0..WORLD_HEIGHT-1;
 *   - the target cell isn't AIR or WATER (placing into water replaces it);
 *   - the target cell intersects the player's AABB (touching faces are fine, so a block can go
 *     flush against the player, e.g. under their feet while jumping or beside them);
 *   - the chunk isn't loaded (setBlock returns false).
 *
 * @param {{ getBlock: Function, setBlock: Function }} world
 * @param {{ x: number, y: number, z: number, nx: number, ny: number, nz: number } | null} hit
 * @param {number | null | undefined} blockId block to place (e.g. the hotbar's selected block)
 * @param {{ x: number, y: number, z: number } | null} playerState physics state (feet position).
 *   Pass null only when there is no player body to protect.
 * @returns {boolean} true if the block was placed
 */
export function tryPlace(world, hit, blockId, playerState) {
  if (!hit) return false;
  const nx = hit.nx;
  const ny = hit.ny;
  const nz = hit.nz;
  if (nx === 0 && ny === 0 && nz === 0) return false;
  if (typeof blockId !== 'number' || blockId === B.AIR || !isPlaceable(blockId)) return false;

  const support = world.getBlock(hit.x, hit.y, hit.z);
  if (support === B.AIR || support === B.WATER) return false;

  const tx = hit.x + nx;
  const ty = hit.y + ny;
  const tz = hit.z + nz;
  if (ty < 0 || ty >= WORLD_HEIGHT) return false;

  const current = world.getBlock(tx, ty, tz);
  if (current !== B.AIR && current !== B.WATER) return false;
  if (playerState && aabbIntersectsBlock(playerState, tx, ty, tz)) return false;

  return world.setBlock(tx, ty, tz, blockId);
}

/**
 * Dispatch one action from controls.consumeActions().
 *
 * @param {'break' | 'place'} action
 * @param {{ getBlock: Function, setBlock: Function }} world
 * @param {object | null} hit raycast result for this action
 * @param {number | null | undefined} blockId selected block (used by 'place')
 * @param {{ x: number, y: number, z: number } | null} playerState physics state (used by 'place')
 * @returns {boolean} true if the world changed
 */
export function performAction(action, world, hit, blockId, playerState) {
  if (action === 'break') return tryBreak(world, hit);
  if (action === 'place') return tryPlace(world, hit, blockId, playerState);
  return false;
}
