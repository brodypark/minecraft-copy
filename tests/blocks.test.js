import { describe, it, expect } from 'vitest';
import { ATLAS_TILES, TILE_SIZE } from '../src/config.js';
import { B, BLOCKS, HOTBAR_BLOCKS, getBlockDef } from '../src/blocks.js';
import { TILES, ATLAS_SIZE, tileUV, tileUVInto, tileOrigin } from '../src/render/tiles.js';

const MAX_TILE = ATLAS_TILES * ATLAS_TILES - 1;
const FACES = ['top', 'bottom', 'side'];

describe('blocks registry', () => {
  it('has an entry for every id in B', () => {
    for (const [name, id] of Object.entries(B)) {
      const def = BLOCKS[id];
      expect(def, name).toBeDefined();
      expect(def.id, name).toBe(id);
      expect(getBlockDef(id), name).toBe(def);
      expect(typeof def.name).toBe('string');
      for (const key of ['solid', 'transparent', 'placeable', 'breakable']) {
        expect(typeof def[key], `${name}.${key}`).toBe('boolean');
      }
    }
  });

  it('every tile index is an integer within the atlas', () => {
    for (const def of BLOCKS) {
      for (const face of FACES) {
        const t = def.tiles[face];
        expect(Number.isInteger(t), `${def.name}.${face}`).toBe(true);
        expect(t).toBeGreaterThanOrEqual(0);
        expect(t).toBeLessThanOrEqual(MAX_TILE);
      }
    }
  });

  it('every non-air block uses a real atlas tile', () => {
    const used = new Set(Object.values(TILES));
    for (const def of BLOCKS) {
      if (def.id === B.AIR) continue;
      for (const face of FACES) expect(used.has(def.tiles[face]), `${def.name}.${face}`).toBe(true);
    }
  });

  it('has exactly 9 placeable blocks, matching the hotbar', () => {
    const placeable = BLOCKS.filter((d) => d.placeable).map((d) => d.id);
    expect(placeable.length).toBe(9);
    expect(placeable.sort((a, b) => a - b)).toEqual([...HOTBAR_BLOCKS].sort((a, b) => a - b));
  });

  it('maps grass and log faces as specified', () => {
    expect(BLOCKS[B.GRASS].tiles).toEqual({ top: TILES.GRASS_TOP, side: TILES.GRASS_SIDE, bottom: TILES.DIRT });
    expect(BLOCKS[B.LOG].tiles).toEqual({ top: TILES.LOG_TOP, side: TILES.LOG_SIDE, bottom: TILES.LOG_TOP });
  });

  it('maps single-texture blocks to their tile on every face', () => {
    const single = {
      DIRT: 'DIRT', STONE: 'STONE', COBBLESTONE: 'COBBLESTONE', SAND: 'SAND', PLANKS: 'PLANKS',
      LEAVES: 'LEAVES', GLASS: 'GLASS', WATER: 'WATER', BEDROCK: 'BEDROCK',
    };
    for (const [block, tile] of Object.entries(single)) {
      for (const face of FACES) expect(BLOCKS[B[block]].tiles[face], `${block}.${face}`).toBe(TILES[tile]);
    }
  });
});

describe('atlas tiles', () => {
  it('has 13 distinct tile indices in range', () => {
    const values = Object.values(TILES);
    expect(values.length).toBe(13);
    expect(new Set(values).size).toBe(values.length);
    for (const t of values) {
      expect(Number.isInteger(t)).toBe(true);
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(MAX_TILE);
    }
  });

  it('atlas size matches config', () => {
    expect(ATLAS_SIZE).toBe(TILE_SIZE * ATLAS_TILES);
    expect(ATLAS_SIZE).toBe(256);
  });

  it('tileOrigin is row-major with row 0 at the top', () => {
    expect(tileOrigin(0)).toEqual({ x: 0, y: 0 });
    expect(tileOrigin(1)).toEqual({ x: TILE_SIZE, y: 0 });
    expect(tileOrigin(ATLAS_TILES)).toEqual({ x: 0, y: TILE_SIZE });
    expect(tileOrigin(ATLAS_TILES + 3)).toEqual({ x: 3 * TILE_SIZE, y: TILE_SIZE });
  });

  it('tileUV returns a half-texel inset rect strictly inside the tile cell', () => {
    const texel = 1 / ATLAS_SIZE;
    const cell = TILE_SIZE / ATLAS_SIZE;
    for (const t of [...Object.values(TILES), ATLAS_TILES, ATLAS_TILES + 5, MAX_TILE]) {
      const { u0, v0, u1, v1 } = tileUV(t);
      const col = t % ATLAS_TILES;
      const row = Math.floor(t / ATLAS_TILES);
      // Cell bounds in UV space (flipY: canvas row 0 is at v = 1).
      const cu0 = col * cell;
      const cu1 = (col + 1) * cell;
      const cvTop = 1 - row * cell;
      const cvBottom = 1 - (row + 1) * cell;

      expect(u0).toBeLessThan(u1);
      expect(v0).toBeLessThan(v1);
      expect(u0).toBeGreaterThan(cu0);
      expect(u1).toBeLessThan(cu1);
      expect(v0).toBeGreaterThan(cvBottom);
      expect(v1).toBeLessThan(cvTop);
      expect(u0 - cu0).toBeCloseTo(texel / 2, 10);
      expect(cu1 - u1).toBeCloseTo(texel / 2, 10);
      expect(cvTop - v1).toBeCloseTo(texel / 2, 10); // v1 = top edge of the tile
      expect(v0 - cvBottom).toBeCloseTo(texel / 2, 10);
    }
  });

  it('tile 0 sits in the top-left corner of the texture (v near 1)', () => {
    const { u0, v1 } = tileUV(0);
    expect(u0).toBeCloseTo(0.5 / 256, 10);
    expect(v1).toBeCloseTo(1 - 0.5 / 256, 10);
  });

  it('tileUVInto writes into and returns the given object', () => {
    const out = { u0: 0, v0: 0, u1: 0, v1: 0 };
    const res = tileUVInto(TILES.PLANKS, out);
    expect(res).toBe(out);
    expect(out).toEqual(tileUV(TILES.PLANKS));
  });
});
