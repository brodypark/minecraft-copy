import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../src/config.js';
import { B } from '../src/blocks.js';
import {
  toChunkCoord, toLocalCoord, chunkKey, blockIndex, Chunk, CHUNK_VOLUME,
} from '../src/world/chunk.js';

describe('world <-> chunk/local coordinates', () => {
  it('maps the documented negative cases', () => {
    expect([toChunkCoord(-1), toLocalCoord(-1)]).toEqual([-1, 15]);
    expect([toChunkCoord(-16), toLocalCoord(-16)]).toEqual([-1, 0]);
    expect([toChunkCoord(-17), toLocalCoord(-17)]).toEqual([-2, 15]);
    expect([toChunkCoord(0), toLocalCoord(0)]).toEqual([0, 0]);
    expect([toChunkCoord(15), toLocalCoord(15)]).toEqual([0, 15]);
    expect([toChunkCoord(16), toLocalCoord(16)]).toEqual([1, 0]);
  });

  it('round-trips world -> (chunk, local) -> world for many values', () => {
    const values = [];
    for (let v = -1000; v <= 1000; v++) values.push(v);
    values.push(-123456789, 123456789, -1048576, 1048575);
    for (const v of values) {
      const c = toChunkCoord(v);
      const l = toLocalCoord(v);
      expect(Number.isInteger(c)).toBe(true);
      expect(l).toBeGreaterThanOrEqual(0);
      expect(l).toBeLessThan(CHUNK_SIZE);
      expect(c * CHUNK_SIZE + l).toBe(v);
    }
  });

  it('chunk keys are "cx,cz" strings', () => {
    expect(chunkKey(0, 0)).toBe('0,0');
    expect(chunkKey(-3, 7)).toBe('-3,7');
    expect(chunkKey(toChunkCoord(-1), toChunkCoord(-17))).toBe('-1,-2');
  });
});

describe('blockIndex', () => {
  it('follows (y * 16 + z) * 16 + x', () => {
    expect(blockIndex(0, 0, 0)).toBe(0);
    expect(blockIndex(1, 0, 0)).toBe(1);
    expect(blockIndex(0, 0, 1)).toBe(CHUNK_SIZE);
    expect(blockIndex(0, 1, 0)).toBe(CHUNK_SIZE * CHUNK_SIZE);
    expect(blockIndex(15, 63, 15)).toBe(CHUNK_VOLUME - 1);
  });

  it('is unique and covers 0..volume-1 exactly', () => {
    expect(CHUNK_VOLUME).toBe(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
    const seen = new Uint8Array(CHUNK_VOLUME);
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const i = blockIndex(x, y, z);
          expect(i >= 0 && i < CHUNK_VOLUME).toBe(true);
          seen[i]++;
        }
      }
    }
    expect(seen.every((n) => n === 1)).toBe(true);
  });
});

describe('Chunk', () => {
  it('stores blocks in a Uint8Array of the right size', () => {
    const c = new Chunk(-2, 5);
    expect(c.cx).toBe(-2);
    expect(c.cz).toBe(5);
    expect(c.key).toBe('-2,5');
    expect(c.blocks).toBeInstanceOf(Uint8Array);
    expect(c.blocks.length).toBe(CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT);
  });

  it('get/set use blockIndex and reject out-of-range coords', () => {
    const c = new Chunk(0, 0);
    expect(c.set(3, 10, 7, B.STONE)).toBe(true);
    expect(c.get(3, 10, 7)).toBe(B.STONE);
    expect(c.blocks[blockIndex(3, 10, 7)]).toBe(B.STONE);
    expect(c.set(16, 0, 0, B.STONE)).toBe(false);
    expect(c.set(0, 64, 0, B.STONE)).toBe(false);
    expect(c.get(-1, 0, 0)).toBe(B.AIR);
    expect(c.get(0, -1, 0)).toBe(B.AIR);
  });

  it('wraps a provided block array without copying', () => {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    blocks[blockIndex(1, 2, 3)] = B.DIRT;
    const c = new Chunk(1, 1, blocks);
    expect(c.blocks).toBe(blocks);
    expect(c.get(1, 2, 3)).toBe(B.DIRT);
    expect(() => new Chunk(0, 0, new Uint8Array(10))).toThrow();
  });
});
