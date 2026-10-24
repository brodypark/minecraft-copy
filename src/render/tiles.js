// Atlas tile indices and UV lookup. PURE module: no three.js, no DOM, so the
// pure mesher (and a future Web Worker) can import it.
//
// Atlas layout: ATLAS_TILES x ATLAS_TILES tiles of TILE_SIZE px each (256x256).
// Tile t sits at column t % ATLAS_TILES, row floor(t / ATLAS_TILES), with row 0
// at the TOP of the canvas.

import { TILE_SIZE, ATLAS_TILES } from '../config.js';

export const TILES = Object.freeze({
  GRASS_TOP: 0,
  GRASS_SIDE: 1,
  DIRT: 2,
  STONE: 3,
  COBBLESTONE: 4,
  SAND: 5,
  LOG_SIDE: 6,
  LOG_TOP: 7,
  PLANKS: 8,
  LEAVES: 9,
  GLASS: 10,
  WATER: 11,
  BEDROCK: 12,
});

/** Atlas width/height in pixels. */
export const ATLAS_SIZE = TILE_SIZE * ATLAS_TILES;

const W = ATLAS_SIZE;
const INSET = 0.5; // half a texel, in pixels

/**
 * Write the inset UV rect of a tile into `out` (no allocation; for hot loops).
 *
 * Orientation: the atlas texture keeps three.js's default `flipY = true`, so
 * v = 1 is the TOP of the canvas. Therefore:
 *   - u0 = left edge,   u1 = right edge   (u0 < u1)
 *   - v0 = BOTTOM edge, v1 = TOP edge     (v0 < v1)
 * Mesher: map the TOP vertices of side faces to v1 and the bottom vertices to
 * v0, otherwise tiles like GRASS_SIDE render upside down.
 *
 * Each edge is inset by half a texel to stop neighbouring tiles bleeding in.
 *
 * @param {number} tileIndex integer in 0..ATLAS_TILES*ATLAS_TILES-1
 * @param {{u0:number,v0:number,u1:number,v1:number}} out
 * @returns the same `out` object
 */
export function tileUVInto(tileIndex, out) {
  const col = tileIndex % ATLAS_TILES;
  const row = Math.floor(tileIndex / ATLAS_TILES);
  out.u0 = (col * TILE_SIZE + INSET) / W;
  out.u1 = ((col + 1) * TILE_SIZE - INSET) / W;
  out.v1 = 1 - (row * TILE_SIZE + INSET) / W;       // top edge of the tile
  out.v0 = 1 - ((row + 1) * TILE_SIZE - INSET) / W; // bottom edge of the tile
  return out;
}

/**
 * Inset UV rect `{ u0, v0, u1, v1 }` of a tile. v1 is the tile's TOP edge and
 * v0 its BOTTOM edge (see tileUVInto for the full convention).
 * @param {number} tileIndex
 */
export function tileUV(tileIndex) {
  return tileUVInto(tileIndex, { u0: 0, v0: 0, u1: 0, v1: 0 });
}

/** Pixel origin (top-left corner, canvas coordinates) of a tile in the atlas. */
export function tileOrigin(tileIndex) {
  return {
    x: (tileIndex % ATLAS_TILES) * TILE_SIZE,
    y: Math.floor(tileIndex / ATLAS_TILES) * TILE_SIZE,
  };
}
