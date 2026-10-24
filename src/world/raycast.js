// Voxel ray traversal (PROJECT.md section 7 Interaction): Amanatides & Woo grid DDA.
// Pure module: no three.js, no DOM. The world is read only through getBlock(x, y, z) with integer
// block coordinates (World.getBlock returns AIR outside 0..WORLD_HEIGHT-1 and in unloaded chunks).
//
// Targeting: rays pass through AIR and WATER; every other block is a target (BEDROCK can be
// targeted, it just can't be broken; glass and leaves are targets too).
//
// Hit result: { x, y, z, id, nx, ny, nz, distance }
//   (x, y, z)    integer coords of the hit block
//   id           its block id
//   (nx, ny, nz) outward normal of the face the ray entered through (one component is +-1), so the
//                cell in front of that face is (x + nx, y + ny, z + nz). (0, 0, 0) when the origin
//                is inside the block (camera clipped into it).
//   distance     distance along the ray from the origin to the entered face (0 when inside)
//
// Origins exactly on a cell boundary: the starting cell along each axis is the one the ray moves
// into (for a negative direction component and an integer origin coordinate that is origin - 1).
// If that starting cell is a target, the ray entered it through the boundary face at distance 0,
// so the result carries that face's normal instead of (0, 0, 0).

import { REACH } from '../config.js';
import { B } from '../blocks.js';

const MAX_STEPS = 4096; // hard cap on cells visited by one ray (only matters for huge maxDist)

/**
 * Can the ray stop at this block? Everything except AIR and WATER.
 * @param {number} id block id
 * @returns {boolean}
 */
export function isTargetable(id) {
  return id !== B.AIR && id !== B.WATER;
}

/** A fresh hit object, for callers that want one reusable `out` target. */
export function createHit() {
  return { x: 0, y: 0, z: 0, id: B.AIR, nx: 0, ny: 0, nz: 0, distance: 0 };
}

function writeHit(out, x, y, z, id, nx, ny, nz, distance) {
  const hit = out || createHit();
  hit.x = x;
  hit.y = y;
  hit.z = z;
  hit.id = id;
  hit.nx = nx;
  hit.ny = ny;
  hit.nz = nz;
  hit.distance = distance;
  return hit;
}

/**
 * Cast a ray through the voxel grid and return the first targetable block within maxDist.
 * Allocates nothing when `out` is given.
 *
 * @param {(x: number, y: number, z: number) => number} getBlock block id at integer world coords
 * @param {number} ox origin x (world units, e.g. the camera/eye position)
 * @param {number} oy origin y
 * @param {number} oz origin z
 * @param {number} dx direction x (any length; normalized internally)
 * @param {number} dy direction y
 * @param {number} dz direction z
 * @param {number} [maxDist=REACH] longest distance to search along the ray
 * @param {{x:number,y:number,z:number,id:number,nx:number,ny:number,nz:number,distance:number}} [out]
 *   object to write the hit into (returned on a hit; left untouched on a miss)
 * @returns {{x:number,y:number,z:number,id:number,nx:number,ny:number,nz:number,distance:number}|null}
 *   the hit, or null if nothing is targeted (also for a zero-length/non-finite direction or origin)
 */
export function raycast(getBlock, ox, oy, oz, dx, dy, dz, maxDist = REACH, out) {
  if (!Number.isFinite(ox) || !Number.isFinite(oy) || !Number.isFinite(oz)) return null;
  if (!(maxDist >= 0)) return null; // negative or NaN
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(len > 0) || !Number.isFinite(len)) return null;
  dx /= len;
  dy /= len;
  dz /= len;

  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0;

  // Starting cell: the cell the ray occupies just after t = 0 (see the boundary note above).
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);
  const onX = stepX !== 0 && x === ox;
  const onY = stepY !== 0 && y === oy;
  const onZ = stepZ !== 0 && z === oz;
  if (onX && stepX < 0) x -= 1;
  if (onY && stepY < 0) y -= 1;
  if (onZ && stepZ < 0) z -= 1;

  let id = getBlock(x, y, z);
  if (isTargetable(id)) {
    // Origin on a face of the starting cell: the ray entered through that face at distance 0.
    if (onX) return writeHit(out, x, y, z, id, -stepX, 0, 0, 0);
    if (onY) return writeHit(out, x, y, z, id, 0, -stepY, 0, 0);
    if (onZ) return writeHit(out, x, y, z, id, 0, 0, -stepZ, 0);
    return writeHit(out, x, y, z, id, 0, 0, 0, 0); // origin inside the block
  }

  // tDelta: ray length to cross one whole cell along the axis. tMax: ray length to the first
  // boundary crossing along the axis. Infinity for an axis the ray doesn't move along, so that
  // axis is never chosen (no division by zero, no endless stepping).
  const tDeltaX = stepX !== 0 ? 1 / Math.abs(dx) : Infinity;
  const tDeltaY = stepY !== 0 ? 1 / Math.abs(dy) : Infinity;
  const tDeltaZ = stepZ !== 0 ? 1 / Math.abs(dz) : Infinity;
  let tMaxX = stepX > 0 ? (x + 1 - ox) * tDeltaX : stepX < 0 ? (ox - x) * tDeltaX : Infinity;
  let tMaxY = stepY > 0 ? (y + 1 - oy) * tDeltaY : stepY < 0 ? (oy - y) * tDeltaY : Infinity;
  let tMaxZ = stepZ > 0 ? (z + 1 - oz) * tDeltaZ : stepZ < 0 ? (oz - z) * tDeltaZ : Infinity;

  // Each step crosses one cell boundary; a ray of length L crosses at most L * sqrt(3) + 3 of them
  // (plus the one step that finds the next face out of reach). The cap also bounds maxDist = Infinity.
  const maxSteps = Math.min(Math.ceil(maxDist) * 3 + 4, MAX_STEPS);

  for (let i = 0; i < maxSteps; i++) {
    let t;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        t = tMaxX;
        x += stepX;
        tMaxX += tDeltaX;
        nx = -stepX;
      } else {
        t = tMaxZ;
        z += stepZ;
        tMaxZ += tDeltaZ;
        nz = -stepZ;
      }
    } else if (tMaxY < tMaxZ) {
      t = tMaxY;
      y += stepY;
      tMaxY += tDeltaY;
      ny = -stepY;
    } else {
      t = tMaxZ;
      z += stepZ;
      tMaxZ += tDeltaZ;
      nz = -stepZ;
    }
    if (!(t <= maxDist)) return null; // next face is out of reach (also catches t = Infinity)

    id = getBlock(x, y, z);
    if (isTargetable(id)) return writeHit(out, x, y, z, id, nx, ny, nz, t);
  }
  return null;
}
