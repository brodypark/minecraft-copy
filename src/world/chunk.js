// Chunk block storage and world/chunk coordinate helpers (PROJECT.md section 5.3).
// Pure module: no three.js, safe to use in node and in a Web Worker.

import { CHUNK_SIZE, WORLD_HEIGHT } from '../config.js';
import { B } from '../blocks.js';

/** Number of blocks in one chunk (16 * 16 * 64). */
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;

/**
 * World block coordinate -> chunk coordinate. Floors, so negatives work (-1 -> -1, -16 -> -1, -17 -> -2).
 * @param {number} v integer world x or z
 * @returns {number}
 */
export function toChunkCoord(v) {
  return Math.floor(v / CHUNK_SIZE);
}

/**
 * World block coordinate -> local coordinate inside its chunk (0..CHUNK_SIZE-1). Positive modulo.
 * @param {number} v integer world x or z
 * @returns {number}
 */
export function toLocalCoord(v) {
  return ((v % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
}

/**
 * Chunk key string used by saves and the renderer: `${cx},${cz}`.
 * @param {number} cx
 * @param {number} cz
 * @returns {string}
 */
export function chunkKey(cx, cz) {
  return `${cx},${cz}`;
}

/**
 * Index into a chunk's block array: (y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx.
 * @param {number} lx local x 0..15
 * @param {number} y 0..63
 * @param {number} lz local z 0..15
 * @returns {number}
 */
export function blockIndex(lx, y, lz) {
  return (y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
}

/** One CHUNK_SIZE x WORLD_HEIGHT x CHUNK_SIZE column of blocks. */
export class Chunk {
  /**
   * @param {number} cx chunk x
   * @param {number} cz chunk z
   * @param {Uint8Array} [blocks] block ids, length CHUNK_VOLUME (a new zeroed array if omitted)
   */
  constructor(cx, cz, blocks) {
    if (blocks !== undefined && (!(blocks instanceof Uint8Array) || blocks.length !== CHUNK_VOLUME)) {
      throw new Error(`Chunk blocks must be a Uint8Array of length ${CHUNK_VOLUME}`);
    }
    /** @type {number} */
    this.cx = cx;
    /** @type {number} */
    this.cz = cz;
    /** @type {string} */
    this.key = chunkKey(cx, cz);
    /** @type {Uint8Array} */
    this.blocks = blocks || new Uint8Array(CHUNK_VOLUME);
  }

  /**
   * Block id at local coordinates; AIR when outside the chunk.
   * @returns {number}
   */
  get(lx, y, lz) {
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return B.AIR;
    return this.blocks[(y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx];
  }

  /**
   * Set a block at local coordinates. Raw storage write: no dirty tracking (use World.setBlock for edits).
   * @returns {boolean} false when outside the chunk
   */
  set(lx, y, lz, id) {
    if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 0 || y >= WORLD_HEIGHT) return false;
    this.blocks[(y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx] = id;
    return true;
  }
}
