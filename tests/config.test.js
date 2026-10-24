import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT, RENDER_DISTANCE, GEN_DISTANCE, UNLOAD_DISTANCE } from '../src/config.js';
import {
  B, BLOCKS, HOTBAR_BLOCKS,
  getBlockDef, isSolid, isTransparent, isPlaceable, isBreakable,
} from '../src/blocks.js';

describe('config', () => {
  it('has the contract values', () => {
    expect(CHUNK_SIZE).toBe(16);
    expect(WORLD_HEIGHT).toBe(64);
    expect(GEN_DISTANCE).toBe(RENDER_DISTANCE + 1);
    expect(UNLOAD_DISTANCE).toBe(RENDER_DISTANCE + 3);
  });
});

describe('block registry skeleton', () => {
  it('has an entry for every id in B, with matching id', () => {
    for (const [name, id] of Object.entries(B)) {
      expect(BLOCKS[id], name).toBeDefined();
      expect(BLOCKS[id].id, name).toBe(id);
    }
    expect(BLOCKS.length).toBe(Object.keys(B).length);
  });

  it('hotbar holds the 9 placeable blocks in order', () => {
    expect(HOTBAR_BLOCKS).toEqual([B.GRASS, B.DIRT, B.STONE, B.COBBLESTONE, B.SAND, B.LOG, B.PLANKS, B.LEAVES, B.GLASS]);
    expect(BLOCKS.filter((d) => d.placeable).map((d) => d.id).sort((a, b) => a - b))
      .toEqual([...HOTBAR_BLOCKS].sort((a, b) => a - b));
  });

  it('flags follow section 5.2', () => {
    expect(isSolid(B.AIR)).toBe(false);
    expect(isSolid(B.WATER)).toBe(false);
    expect(isSolid(B.STONE)).toBe(true);
    for (const id of [B.AIR, B.WATER, B.GLASS, B.LEAVES]) expect(isTransparent(id)).toBe(true);
    expect(isTransparent(B.STONE)).toBe(false);
    expect(isPlaceable(B.WATER)).toBe(false);
    expect(isPlaceable(B.BEDROCK)).toBe(false);
    expect(isBreakable(B.BEDROCK)).toBe(false);
    expect(isBreakable(B.WATER)).toBe(false);
    expect(isBreakable(B.AIR)).toBe(false);
    expect(isBreakable(B.DIRT)).toBe(true);
  });

  it('unknown ids behave like air', () => {
    for (const id of [99, 255, 1000, -1]) {
      expect(getBlockDef(id)).toBe(BLOCKS[B.AIR]);
      expect(isSolid(id)).toBe(false);
      expect(isTransparent(id)).toBe(true);
      expect(isPlaceable(id)).toBe(false);
      expect(isBreakable(id)).toBe(false);
    }
  });
});
