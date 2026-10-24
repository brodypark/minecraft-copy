import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, RENDER_DISTANCE, GEN_DISTANCE, CAVE_MIN_Y, CAVE_SURFACE_GAP,
} from '../src/config.js';
import { B } from '../src/blocks.js';
import { blockIndex, toChunkCoord, toLocalCoord, CHUNK_VOLUME } from '../src/world/chunk.js';
import { createTerrain, hash3 } from '../src/world/terrain.js';
import { World } from '../src/world/world.js';
import { buildChunkGeometry } from '../src/render/mesher.js';

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

  // Task 11 changed this test: caves may turn stone into AIR, but only between CAVE_MIN_Y and
  // caveTop (= min of the column's and its 4 neighbors' surface heights - CAVE_SURFACE_GAP).
  it('builds columns as bedrock, stone (or cave air), dirt/sand, grass/sand, then water/air', () => {
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
          const caveTop = t.caveTop(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
          expect(caveTop).toBeLessThanOrEqual(h - CAVE_SURFACE_GAP);
          for (let y = 1; y <= h - 4; y++) {
            if (y >= CAVE_MIN_Y && y <= caveTop) expect([B.STONE, B.AIR]).toContain(at(y));
            else expect(at(y)).toBe(B.STONE);
          }
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

describe('caves', () => {
  const CAVE_CHUNKS = [...SAMPLE_CHUNKS, [1, 0], [0, 1], [-5, 4], [8, -2], [-20, -20]];

  /** Number of cave AIR cells (AIR below h - 4) in a generated chunk. */
  function caveCells(t, cx, cz, data) {
    let n = 0;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const h = t.surfaceHeight(cx * CHUNK_SIZE + lx, cz * CHUNK_SIZE + lz);
        for (let y = 1; y < h - 4; y++) if (data[blockIndex(lx, y, lz)] === B.AIR) n++;
      }
    }
    return n;
  }

  it('exist, but only as AIR between y = CAVE_MIN_Y (5) and h - 5 (and caveTop)', () => {
    expect(CAVE_MIN_Y).toBe(5);
    expect(CAVE_SURFACE_GAP).toBe(5);
    const t = createTerrain(SEED);
    expect(t.caves).toBe(true);
    let caves = 0;
    for (const [cx, cz] of CAVE_CHUNKS) {
      const data = t.generateChunk(cx, cz);
      for (let lz = 0; lz < CHUNK_SIZE; lz++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          const x = cx * CHUNK_SIZE + lx;
          const z = cz * CHUNK_SIZE + lz;
          const h = t.surfaceHeight(x, z);
          const top = t.caveTop(x, z);
          for (let y = 0; y <= h; y++) {
            if (data[blockIndex(lx, y, lz)] !== B.AIR) continue;
            caves++;
            if (y < 5 || y > h - 5 || y > top) throw new Error(`cave air out of range at ${x},${y},${z} (h ${h}, top ${top})`);
          }
        }
      }
    }
    // Caves really exist: on average more than 100 cave cells per sample chunk.
    expect(caves).toBeGreaterThan(100 * CAVE_CHUNKS.length);
  });

  it('only replace STONE with AIR: everything else matches terrain without caves', () => {
    const withCaves = createTerrain(SEED);
    const without = createTerrain(SEED, { caves: false });
    expect(without.caves).toBe(false);
    for (const [cx, cz] of CAVE_CHUNKS) {
      const a = withCaves.generateChunk(cx, cz);
      const b = without.generateChunk(cx, cz);
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i] && !(a[i] === B.AIR && b[i] === B.STONE)) throw new Error(`index ${i}: ${a[i]} vs ${b[i]}`);
      }
    }
    for (let x = -50; x <= 50; x += 7) {
      for (let z = -50; z <= 50; z += 7) expect(withCaves.surfaceHeight(x, z)).toBe(without.surfaceHeight(x, z));
    }
  });

  it('never touch WATER: no cave AIR cell (below h - 4) has a WATER neighbor, in coastal areas', () => {
    let caves = 0;
    let water = 0;
    let nearWater = 0; // cave cells within 3 columns of a column with water above it
    for (const [ox, oz] of [[0, 0], [100, -60], [-150, 200]]) {
      const w = new World(SEED);
      w.generateAround(ox, oz, 3);
      const t = w.terrain;
      const cx0 = toChunkCoord(ox);
      const cz0 = toChunkCoord(oz);
      // The 5x5 chunks around the center: all of their neighbors are generated (radius 3).
      for (let x = (cx0 - 2) * CHUNK_SIZE; x < (cx0 + 3) * CHUNK_SIZE; x++) {
        for (let z = (cz0 - 2) * CHUNK_SIZE; z < (cz0 + 3) * CHUNK_SIZE; z++) {
          const h = t.surfaceHeight(x, z);
          for (let y = 1; y < WORLD_HEIGHT; y++) {
            const id = w.getBlock(x, y, z);
            if (id === B.WATER) water++;
            if (id !== B.AIR || y >= h - 4) continue;
            caves++;
            for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
              if (w.getBlock(x + dx, y + dy, z + dz) === B.WATER) {
                throw new Error(`cave cell ${x},${y},${z} touches water at ${x + dx},${y + dy},${z + dz}`);
              }
            }
            let near = false;
            for (let dx = -3; dx <= 3 && !near; dx++) {
              for (let dz = -3; dz <= 3; dz++) if (t.surfaceHeight(x + dx, z + dz) < SEA_LEVEL) { near = true; break; }
            }
            if (near) nearWater++;
          }
        }
      }
    }
    // The areas really have water, caves, and caves close to water (so the rule is exercised).
    expect(water).toBeGreaterThan(5000);
    expect(caves).toBeGreaterThan(5000);
    expect(nearWater).toBeGreaterThan(500);
  });

  it('are deterministic and independent of generation order; different seeds differ', () => {
    const a = createTerrain(SEED);
    const b = createTerrain(SEED);
    const forward = CAVE_CHUNKS.map(([cx, cz]) => a.generateChunk(cx, cz));
    let caves = 0;
    for (let i = CAVE_CHUNKS.length - 1; i >= 0; i--) {
      const [cx, cz] = CAVE_CHUNKS[i];
      const data = b.generateChunk(cx, cz);
      expect(data).toEqual(forward[i]);
      caves += caveCells(b, cx, cz, data);
    }
    expect(caves).toBeGreaterThan(1000);

    // Through the World, in two different orders.
    const w1 = new World(SEED);
    const w2 = new World(SEED);
    for (const [cx, cz] of CAVE_CHUNKS) w1.ensureChunk(cx, cz);
    for (const [cx, cz] of [...CAVE_CHUNKS].reverse()) w2.ensureChunk(cx, cz);
    for (const [cx, cz] of CAVE_CHUNKS) expect(w2.getChunk(cx, cz).blocks).toEqual(w1.getChunk(cx, cz).blocks);

    // Cave layouts differ between seeds. Below y = 20 (under sea level) AIR can only be cave air:
    // above a column's surface there is water, so comparing AIR there compares caves alone.
    const c = createTerrain(SEED + 1);
    const below = 20 * CHUNK_SIZE * CHUNK_SIZE;
    let differ = 0;
    for (const [cx, cz] of CAVE_CHUNKS) {
      const da = a.generateChunk(cx, cz);
      const dc = c.generateChunk(cx, cz);
      for (let i = 0; i < below; i++) if ((da[i] === B.AIR) !== (dc[i] === B.AIR)) differ++;
    }
    expect(differ).toBeGreaterThan(1000);
  });

  it('add at most ~50% triangles to the meshed spawn area', () => {
    const results = [];
    for (const seed of [SEED, 20240611, 987654321]) {
      const tris = [];
      for (const caves of [false, true]) {
        const w = new World(seed);
        w.terrain = createTerrain(seed, { caves });
        w.generateAround(8, 8, GEN_DISTANCE);
        const chunks = [...w.consumeDirtyChunks()];
        expect(chunks.length).toBeGreaterThan(100); // every chunk within RENDER_DISTANCE
        let n = 0;
        for (const ch of chunks) {
          const g = buildChunkGeometry((x, y, z) => w.getBlock(x, y, z), ch.cx, ch.cz);
          n += (g.solid.indices.length + g.water.indices.length) / 3;
        }
        tris.push(n);
      }
      results.push(tris[1] / tris[0]);
      console.log(
        `caves: seed ${seed}, spawn area (radius ${RENDER_DISTANCE}) triangles ${tris[0]} without caves, ` +
          `${tris[1]} with (+${((tris[1] / tris[0] - 1) * 100).toFixed(1)}%)`,
      );
    }
    for (const r of results) {
      expect(r).toBeGreaterThan(1.05); // caves are visible in the mesh at all
      expect(r).toBeLessThan(1.5);
    }
  });
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
