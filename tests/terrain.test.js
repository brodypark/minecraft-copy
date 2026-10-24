import { describe, it, expect } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL } from '../src/config.js';
import { B } from '../src/blocks.js';
import { blockIndex, toChunkCoord, toLocalCoord, CHUNK_VOLUME } from '../src/world/chunk.js';
import { createTerrain, hash3 } from '../src/world/terrain.js';
import { World } from '../src/world/world.js';

const SEED = 12345;
const SAMPLE_CHUNKS = [[0, 0], [-1, -1], [3, -7], [-12, 9], [25, 25], [-40, -3]];
const VALID_IDS = new Set(Object.values(B));

/** Block at world coords from a { "cx,cz": Uint8Array } map of generated chunks (undefined if absent). */
function blockFrom(chunks, x, y, z) {
  const data = chunks.get(`${toChunkCoord(x)},${toChunkCoord(z)}`);
  if (!data) return undefined;
  return data[blockIndex(toLocalCoord(x), y, toLocalCoord(z))];
}

describe('terrain determinism', () => {
  it('same seed gives identical chunk data, including negative coords', () => {
    const a = createTerrain(SEED);
    const b = createTerrain(SEED);
    for (const [cx, cz] of SAMPLE_CHUNKS) {
      expect(a.generateChunk(cx, cz)).toEqual(b.generateChunk(cx, cz));
    }
  });

  it('generation order does not matter, and the out buffer is fully overwritten', () => {
    const a = createTerrain(SEED);
    const b = createTerrain(SEED);
    const forward = SAMPLE_CHUNKS.map(([cx, cz]) => a.generateChunk(cx, cz));
    const out = new Uint8Array(CHUNK_VOLUME).fill(B.GLASS);
    for (let i = SAMPLE_CHUNKS.length - 1; i >= 0; i--) {
      const [cx, cz] = SAMPLE_CHUNKS[i];
      const res = b.generateChunk(cx, cz, out);
      expect(res).toBe(out);
      expect(res).toEqual(forward[i]);
    }
  });

  it('different seeds differ', () => {
    const a = createTerrain(1);
    const b = createTerrain(2);
    let differing = 0;
    for (const [cx, cz] of SAMPLE_CHUNKS) {
      const da = a.generateChunk(cx, cz);
      const db = b.generateChunk(cx, cz);
      for (let i = 0; i < da.length; i++) if (da[i] !== db[i]) differing++;
    }
    expect(differing).toBeGreaterThan(1000);
    expect(a.surfaceHeight(100, 100) !== b.surfaceHeight(100, 100)
      || a.surfaceHeight(-50, 70) !== b.surfaceHeight(-50, 70)).toBe(true);
  });

  it('tree hash is integer-only and stable (fixed reference values)', () => {
    // These must never change across platforms or versions, or saved worlds would get different trees.
    const v = [hash3(12345, -7, 3, 1), hash3(12345, 7, -3, 1), hash3(1, 0, 0, 0), hash3(-1, 2147483647, -2147483648, 5)];
    expect(v).toEqual([2324452656, 35447690, 1262911408, 2805323647]);
    // Swapping/negating coordinates must not collide (a weakness of xor-combined hashes).
    const seen = new Set();
    for (let x = -20; x <= 20; x++) for (let z = -20; z <= 20; z++) seen.add(hash3(SEED, x, z, 7));
    expect(seen.size).toBe(41 * 41);
  });
});

describe('terrain content', () => {
  const t = createTerrain(SEED);
  const generated = SAMPLE_CHUNKS.map(([cx, cz]) => ({ cx, cz, data: t.generateChunk(cx, cz) }));

  it('has bedrock at y=0 everywhere and nowhere else', () => {
    for (const { data } of generated) {
      for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) expect(data[i]).toBe(B.BEDROCK);
      for (let i = CHUNK_SIZE * CHUNK_SIZE; i < data.length; i++) {
        if (data[i] === B.BEDROCK) throw new Error(`bedrock above y=0 at index ${i}`);
      }
    }
  });

  it('only uses ids from the B enum', () => {
    for (const { data } of generated) {
      for (let i = 0; i < data.length; i++) {
        if (!VALID_IDS.has(data[i])) throw new Error(`invalid id ${data[i]} at index ${i}`);
      }
    }
  });

  it('has water only at y <= SEA_LEVEL', () => {
    for (const { data } of generated) {
      for (let y = SEA_LEVEL + 1; y < WORLD_HEIGHT; y++) {
        for (let i = 0; i < CHUNK_SIZE * CHUNK_SIZE; i++) {
          if (data[y * CHUNK_SIZE * CHUNK_SIZE + i] === B.WATER) throw new Error(`water at y=${y}`);
        }
      }
    }
  });

  it('builds columns as bedrock, stone, dirt/sand, grass/sand, then water/air', () => {
    for (const { cx, cz, data } of generated) {
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const h = t.surfaceHeight(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
          expect(h).toBeGreaterThanOrEqual(4);
          expect(h).toBeLessThanOrEqual(WORLD_HEIGHT - 8);
          const at = (y) => data[blockIndex(lx, y, lz)];
          const beach = h <= SEA_LEVEL + 1;
          expect(at(h)).toBe(beach ? B.SAND : B.GRASS);
          expect(at(h - 1)).toBe(beach ? B.SAND : B.DIRT);
          expect(at(h - 2)).toBe(beach ? B.SAND : B.DIRT);
          expect(at(h - 3)).toBe(B.DIRT);
          for (let y = 1; y <= h - 4; y++) expect(at(y)).toBe(B.STONE);
          for (let y = h + 1; y < WORLD_HEIGHT; y++) {
            const id = at(y);
            if (y <= SEA_LEVEL) expect(id).toBe(B.WATER);
            else expect([B.AIR, B.LOG, B.LEAVES]).toContain(id);
          }
        }
      }
    }
  });

  it('height field: gentle slopes, hills around y 45, water below sea level', () => {
    let big = 0;
    let n = 0;
    let max = 0;
    let underwater = 0;
    for (let z = -1024; z < 1024; z += 4) {
      for (let x = -1024; x < 1024; x += 4) {
        const h = t.surfaceHeight(x, z);
        if (Math.abs(t.surfaceHeight(x + 1, z) - h) > 3) big++;
        if (Math.abs(t.surfaceHeight(x, z + 1) - h) > 3) big++;
        if (h < SEA_LEVEL) underwater++;
        max = Math.max(max, h);
        n++;
      }
    }
    expect(big / (2 * n)).toBeLessThan(0.01);
    expect(max).toBeGreaterThanOrEqual(42);
    expect(underwater / n).toBeGreaterThan(0.05);
    expect(underwater / n).toBeLessThan(0.5);
  });

  it('puts trees on about 1 in 110 grass columns, trunks 4-6 on grass', () => {
    let grass = 0;
    let trees = 0;
    for (let z = -300; z < 300; z++) {
      for (let x = -300; x < 300; x++) {
        const h = t.surfaceHeight(x, z);
        const trunk = t.treeAt(x, z);
        if (h > SEA_LEVEL + 1) {
          grass++;
          if (trunk > 0) {
            trees++;
            expect(trunk).toBeGreaterThanOrEqual(4);
            expect(trunk).toBeLessThanOrEqual(6);
          }
        } else {
          expect(trunk).toBe(0);
        }
      }
    }
    const ratio = grass / trees;
    expect(ratio).toBeGreaterThan(80);
    expect(ratio).toBeLessThan(150);
  });
});

/**
 * Find a lone tree whose canopy crosses the border between chunk `lo` and chunk `lo + 1` along `axis`
 * ('x' or 'z'): root within 2 blocks of the border, no other tree root within 6 blocks, canopy fully
 * in open air and inside one chunk along the other axis.
 */
function findBorderTree(t, axis, lo) {
  const border = (lo + 1) * CHUNK_SIZE; // first block of the higher chunk
  for (let along = -4000; along < 4000; along++) {
    const lz = toLocalCoord(along);
    if (lz < 2 || lz > CHUNK_SIZE - 3) continue;
    for (let off = -2; off <= 1; off++) {
      const x = axis === 'x' ? border + off : along;
      const z = axis === 'x' ? along : border + off;
      const trunk = t.treeAt(x, z);
      if (trunk === 0) continue;
      let lonely = true;
      for (let dz = -6; dz <= 6 && lonely; dz++) {
        for (let dx = -6; dx <= 6; dx++) {
          if ((dx || dz) && t.treeAt(x + dx, z + dz) > 0) { lonely = false; break; }
        }
      }
      if (!lonely) continue;
      const blocks = [];
      t.forEachTreeBlock(x, z, (bx, by, bz, id) => blocks.push([bx, by, bz, id]));
      const open = blocks.every(([bx, by, bz]) => t.surfaceHeight(bx, bz) < by && by < WORLD_HEIGHT);
      if (open) return { x, z, trunk, h: t.surfaceHeight(x, z), blocks };
    }
  }
  return null;
}

describe('trees across chunk borders', () => {
  for (const [axis, lo] of [['x', -1], ['z', -1], ['x', 2], ['z', 4]]) {
    it(`a tree crossing the ${axis} border between chunks ${lo} and ${lo + 1} is complete in either order`, () => {
      const t = createTerrain(SEED);
      const tree = findBorderTree(t, axis, lo);
      expect(tree, 'no suitable border tree found').not.toBeNull();
      const { x, z, trunk, h, blocks } = tree;
      const ccx = toChunkCoord(x);
      const ccz = toChunkCoord(z);
      const chunkA = axis === 'x' ? [lo, ccz] : [ccx, lo];
      const chunkB = axis === 'x' ? [lo + 1, ccz] : [ccx, lo + 1];

      // The tree really spans both chunks.
      const keyOf = (bx, bz) => `${toChunkCoord(bx)},${toChunkCoord(bz)}`;
      const keys = new Set(blocks.map(([bx, , bz]) => keyOf(bx, bz)));
      expect(keys).toEqual(new Set([chunkA.join(','), chunkB.join(',')]));

      // Order 1: A then B (fresh generator). Order 2: B then A (another fresh generator).
      const g1 = createTerrain(SEED);
      const order1 = new Map();
      order1.set(chunkA.join(','), g1.generateChunk(...chunkA));
      order1.set(chunkB.join(','), g1.generateChunk(...chunkB));
      const g2 = createTerrain(SEED);
      const order2 = new Map();
      order2.set(chunkB.join(','), g2.generateChunk(...chunkB));
      order2.set(chunkA.join(','), g2.generateChunk(...chunkA));
      for (const k of order1.keys()) expect(order2.get(k)).toEqual(order1.get(k));

      // Each chunk alone already holds its part of the tree (no dependency on the neighbor existing).
      for (const c of [chunkA, chunkB]) {
        const alone = new Map([[c.join(','), createTerrain(SEED).generateChunk(...c)]]);
        for (const [bx, by, bz, id] of blocks) {
          if (keyOf(bx, bz) === c.join(',')) expect(blockFrom(alone, bx, by, bz)).toBe(id);
        }
      }

      // Oracle 1: every block the tree defines is present after both chunks exist.
      for (const [bx, by, bz, id] of blocks) expect(blockFrom(order1, bx, by, bz)).toBe(id);

      // Oracle 2 (independent of the corner-trim hash): the full trunk plus every non-corner leaf cell.
      const top = h + trunk;
      expect(blockFrom(order1, x, h, z)).toBe(B.GRASS);
      for (let y = h + 1; y <= top; y++) expect(blockFrom(order1, x, y, z)).toBe(B.LOG);
      expect(blockFrom(order1, x, top + 1, z)).toBe(B.LEAVES);
      for (let layer = 0; layer < 4; layer++) {
        const y = top - 2 + layer;
        const r = layer < 2 ? 2 : 1;
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (dx === 0 && dz === 0) continue;
            const corner = Math.abs(dx) === r && Math.abs(dz) === r;
            const id = blockFrom(order1, x + dx, y, z + dz);
            if (corner) expect([B.AIR, B.LEAVES]).toContain(id);
            else expect(id).toBe(B.LEAVES);
          }
        }
      }
      // Nothing of the tree above top+1 or outside its 5x5 footprint (the tree is lonely, so any
      // log/leaves there would be a bug). Cells outside the two generated chunks are skipped.
      const isTreeBlock = (id) => id === B.LOG || id === B.LEAVES;
      for (let dz = -3; dz <= 3; dz++) {
        for (let dx = -3; dx <= 3; dx++) {
          const ring = Math.abs(dx) === 3 || Math.abs(dz) === 3;
          for (let y = h + 1; y <= top + 2; y++) {
            if (!ring && y <= top + 1) continue;
            const id = blockFrom(order1, x + dx, y, z + dz);
            if (id !== undefined) expect(isTreeBlock(id), `tree block at ${x + dx},${y},${z + dz}`).toBe(false);
          }
        }
      }

      // Same result through the World API in both orders.
      const w1 = new World(SEED);
      w1.ensureChunk(...chunkA);
      w1.ensureChunk(...chunkB);
      const w2 = new World(SEED);
      w2.ensureChunk(...chunkB);
      w2.ensureChunk(...chunkA);
      for (const [bx, by, bz, id] of blocks) {
        expect(w1.getBlock(bx, by, bz)).toBe(id);
        expect(w2.getBlock(bx, by, bz)).toBe(id);
      }
    });
  }
});

describe('terrain performance', () => {
  it('generates a 13x13 chunk area in under 1.5 s', () => {
    const t = createTerrain(987654321);
    const start = performance.now();
    let checksum = 0;
    for (let cz = -6; cz <= 6; cz++) {
      for (let cx = -6; cx <= 6; cx++) checksum += t.generateChunk(cx, cz)[0];
    }
    const ms = performance.now() - start;
    console.log(`terrain: generated 13x13 chunks in ${ms.toFixed(1)} ms`);
    expect(checksum).toBe(169 * B.BEDROCK);
    expect(ms).toBeLessThan(1500);
  });
});
