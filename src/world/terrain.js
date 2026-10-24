// Deterministic terrain generator (PROJECT.md section 6).
// Pure module: no three.js and no world state, so it runs in node and can move into a Web Worker.
// The same seed always yields the same blocks, whatever order chunks are generated in.

import alea from 'alea';
import { createNoise2D } from 'simplex-noise';
import {
  CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL,
  TERRAIN_BASE as BASE, TERRAIN_DETAIL_SCALE as DETAIL_SCALE, TERRAIN_DETAIL_AMP as DETAIL_AMP,
  TERRAIN_HILL_SCALE as HILL_SCALE, TERRAIN_HILL_AMP as HILL_AMP,
  TERRAIN_MIN_HEIGHT as MIN_HEIGHT, TERRAIN_MAX_HEIGHT as MAX_HEIGHT,
  FBM_OCTAVES as OCTAVES, FBM_PERSISTENCE as PERSISTENCE, FBM_LACUNARITY as LACUNARITY,
  TREE_CHANCE,
} from '../config.js';
import { B } from '../blocks.js';
import { CHUNK_VOLUME } from './chunk.js';

// Height tuning constants live in config.js (TERRAIN_*, FBM_*, TREE_CHANCE).
const FBM_NORM = (1 - PERSISTENCE ** OCTAVES) / (1 - PERSISTENCE); // 1.875 for 4 octaves

// ---- Trees ---------------------------------------------------------------
const TREE_MARGIN = 2; // leaf radius: roots this far outside a chunk can still reach into it
const SALT_TREE = 0x51ed270b;
const SALT_TRUNK = 0x2545f491;
const SALT_CORNER = 0x6c8e9cf5;

const CS = CHUNK_SIZE;
const LAYER = CS * CS; // blocks per y layer in a chunk

/**
 * Reduce any seed (number or string) to a 32-bit integer for hashing. Platform stable.
 * @param {number|string} seed
 * @returns {number} int32
 */
function seedToInt(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    const s = Math.floor(seed);
    const lo = s % 4294967296; // low 32 bits (sign kept; |0 below normalizes)
    const hi = Math.floor(s / 4294967296);
    return (lo ^ Math.imul(hi | 0, 0x9e3779b1)) | 0;
  }
  const str = String(seed);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193);
  return h | 0;
}

// One MurmurHash3 (x86_32) block step: mixes 32-bit word k into state h.
function murmurStep(h, k) {
  k = Math.imul(k, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  k = Math.imul(k, 0x1b873593);
  h ^= k;
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

/**
 * Deterministic 32-bit hash of (seed, x, z, salt): MurmurHash3 over the three words with the seed as
 * its seed. Integer-only (Math.imul, shifts), so results are identical on every platform.
 * @param {number} seedInt int32 seed
 * @param {number} x int32
 * @param {number} z int32
 * @param {number} salt int32, separates independent rolls for the same column
 * @returns {number} uint32
 */
export function hash3(seedInt, x, z, salt) {
  let h = seedInt | 0;
  h = murmurStep(h, x | 0);
  h = murmurStep(h, z | 0);
  h = murmurStep(h, salt | 0);
  h ^= 12; // input length in bytes
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Create a terrain generator for a seed.
 * @param {number|string} seed
 * @returns {{
 *   seed: number|string,
 *   surfaceHeight: (x: number, z: number) => number,
 *   treeAt: (x: number, z: number) => number,
 *   forEachTreeBlock: (x: number, z: number, fn: (x: number, y: number, z: number, id: number) => void) => boolean,
 *   generateChunk: (cx: number, cz: number, out?: Uint8Array) => Uint8Array,
 * }}
 */
export function createTerrain(seed) {
  const prng = alea(seed);
  const detailNoise = createNoise2D(prng);
  const hillNoise = createNoise2D(prng);
  const seedInt = seedToInt(seed);

  // Per-octave offsets decorrelate the octaves (otherwise every octave is 0 at the origin).
  function fbm(noise, x, z) {
    let sum = 0;
    let amp = 1;
    let freq = 1;
    for (let o = 0; o < OCTAVES; o++) {
      sum += amp * noise(x * freq + o * 31.7, z * freq - o * 17.3);
      amp *= PERSISTENCE;
      freq *= LACUNARITY;
    }
    return sum / FBM_NORM;
  }

  /**
   * Pure noise surface height h of column (x, z): the y of the top terrain block (grass/sand),
   * before trees and water. Integer in [4, WORLD_HEIGHT - 8].
   */
  function surfaceHeight(x, z) {
    const detail = fbm(detailNoise, x / DETAIL_SCALE, z / DETAIL_SCALE);
    const hill = Math.max(0, fbm(hillNoise, x / HILL_SCALE, z / HILL_SCALE));
    const h = Math.round(SEA_LEVEL + BASE + DETAIL_AMP * detail + HILL_AMP * hill * hill);
    return h < MIN_HEIGHT ? MIN_HEIGHT : h > MAX_HEIGHT ? MAX_HEIGHT : h;
  }

  /** Trunk height (4..6) if the hash puts a tree root at column (x, z), else 0. Ignores the surface. */
  function treeRoll(x, z) {
    if (hash3(seedInt, x, z, SALT_TREE) % TREE_CHANCE !== 0) return 0;
    return 4 + (hash3(seedInt, x, z, SALT_TRUNK) % 3);
  }

  /** Does a column with surface height h get grass (and so may grow a tree)? Lower surfaces are sand. */
  function isGrassHeight(h) {
    return h > SEA_LEVEL + 1;
  }

  /**
   * Trunk height (4..6) of the tree rooted at column (x, z), or 0 if there is none.
   * @param {number} x
   * @param {number} z
   * @returns {number}
   */
  function treeAt(x, z) {
    const trunk = treeRoll(x, z);
    if (trunk === 0) return 0;
    return isGrassHeight(surfaceHeight(x, z)) ? trunk : 0;
  }

  /**
   * Visit every block of the tree rooted at (x, z) (trunk LOG first, then LEAVES), given its surface
   * height h and trunk height. Leaves: radius 2 at top-2 and top-1, radius 1 at top and top+1, with
   * each corner trimmed by a deterministic hash bit. Positions above the world are skipped.
   */
  function visitTree(x, z, h, trunk, fn) {
    const top = h + trunk;
    for (let y = h + 1; y <= top; y++) fn(x, y, z, B.LOG);
    for (let layer = 0; layer < 4; layer++) {
      const y = top - 2 + layer;
      if (y >= WORLD_HEIGHT) break;
      const r = layer < 2 ? 2 : 1;
      const cornerBits = hash3(seedInt, x, z, SALT_CORNER + layer);
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx === 0 && dz === 0 && y <= top) continue; // trunk
          if ((dx === -r || dx === r) && (dz === -r || dz === r)) {
            const corner = (dx > 0 ? 1 : 0) + (dz > 0 ? 2 : 0);
            if ((cornerBits >>> corner) & 1) continue; // trimmed
          }
          fn(x + dx, y, z + dz, B.LEAVES);
        }
      }
    }
  }

  /**
   * Visit every block of the tree rooted at world column (x, z), if there is one.
   * @param {number} x
   * @param {number} z
   * @param {(x: number, y: number, z: number, id: number) => void} fn
   * @returns {boolean} true if a tree exists there
   */
  function forEachTreeBlock(x, z, fn) {
    const trunk = treeRoll(x, z);
    if (trunk === 0) return false;
    const h = surfaceHeight(x, z);
    if (!isGrassHeight(h)) return false;
    visitTree(x, z, h, trunk, fn);
    return true;
  }

  const heights = new Int32Array(CS * CS);

  /**
   * Generate the blocks of chunk (cx, cz).
   * @param {number} cx
   * @param {number} cz
   * @param {Uint8Array} [out] array of length CHUNK_VOLUME to fill (cleared first); a new one if omitted
   * @returns {Uint8Array} the filled block array, indexed (y * 16 + lz) * 16 + lx
   */
  function generateChunk(cx, cz, out) {
    const blocks = out || new Uint8Array(CHUNK_VOLUME);
    if (out) blocks.fill(B.AIR);
    const x0 = cx * CS;
    const z0 = cz * CS;

    // Terrain columns: bedrock, stone, dirt/sand, grass/sand, then water up to sea level.
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const h = surfaceHeight(x0 + lx, z0 + lz);
        heights[lz * CS + lx] = h;
        const col = lz * CS + lx;
        const beach = h <= SEA_LEVEL + 1;
        const topId = beach ? B.SAND : B.GRASS;
        const subId = beach ? B.SAND : B.DIRT;
        blocks[col] = B.BEDROCK;
        const stoneTop = h - 4;
        let y = 1;
        for (; y <= stoneTop; y++) blocks[y * LAYER + col] = B.STONE;
        for (; y < h; y++) blocks[y * LAYER + col] = (beach && y < h - 2) ? B.DIRT : subId;
        blocks[h * LAYER + col] = topId;
        for (y = h + 1; y <= SEA_LEVEL; y++) blocks[y * LAYER + col] = B.WATER;
      }
    }

    // Trees, including roots in a TREE_MARGIN band around the chunk so canopies cross borders.
    // Leaves only fill AIR; trunks fill AIR or LEAVES. Neither rule depends on write order.
    const write = (wx, wy, wz, id) => {
      const lx = wx - x0;
      const lz = wz - z0;
      if (lx < 0 || lx >= CS || lz < 0 || lz >= CS || wy < 0 || wy >= WORLD_HEIGHT) return;
      const i = wy * LAYER + lz * CS + lx;
      const cur = blocks[i];
      if (cur === B.AIR || (id === B.LOG && cur === B.LEAVES)) blocks[i] = id;
    };
    for (let wz = z0 - TREE_MARGIN; wz < z0 + CS + TREE_MARGIN; wz++) {
      for (let wx = x0 - TREE_MARGIN; wx < x0 + CS + TREE_MARGIN; wx++) {
        const trunk = treeRoll(wx, wz);
        if (trunk === 0) continue;
        const lx = wx - x0;
        const lz = wz - z0;
        const inside = lx >= 0 && lx < CS && lz >= 0 && lz < CS;
        const h = inside ? heights[lz * CS + lx] : surfaceHeight(wx, wz);
        if (!isGrassHeight(h)) continue;
        visitTree(wx, wz, h, trunk, write);
      }
    }
    return blocks;
  }

  return { seed, surfaceHeight, treeAt, forEachTreeBlock, generateChunk };
}
