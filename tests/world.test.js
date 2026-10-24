import { describe, it, expect } from 'vitest';
import {
  CHUNK_SIZE, WORLD_HEIGHT, RENDER_DISTANCE, GEN_DISTANCE, UNLOAD_DISTANCE, CHUNK_GEN_PER_FRAME,
} from '../src/config.js';
import { B, isSolid } from '../src/blocks.js';
import { blockIndex, toChunkCoord, toLocalCoord, CHUNK_VOLUME } from '../src/world/chunk.js';
import { createTerrain } from '../src/world/terrain.js';
import { World } from '../src/world/world.js';

const SEED = 4242;

function circleCount(r) {
  let n = 0;
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dz * dz <= r * r) n++;
  return n;
}

const keysOf = (chunks) => chunks.map((c) => c.key).sort();

describe('World block access', () => {
  it('getBlock matches terrain data, including negative coordinates', () => {
    const w = new World(SEED);
    const t = createTerrain(SEED);
    for (const [cx, cz] of [[0, 0], [-1, -1], [-2, 3]]) {
      w.ensureChunk(cx, cz);
      const data = t.generateChunk(cx, cz);
      for (const [lx, y, lz] of [[0, 0, 0], [15, 10, 15], [7, 30, 3], [0, 63, 15]]) {
        const x = cx * CHUNK_SIZE + lx;
        const z = cz * CHUNK_SIZE + lz;
        expect(w.getBlock(x, y, z)).toBe(data[blockIndex(lx, y, lz)]);
      }
    }
    expect(w.getBlock(-1, 0, -1)).toBe(B.BEDROCK); // chunk (-1,-1), local (15, 15)
    expect(w.getBlock(-16, 0, -16)).toBe(B.BEDROCK); // chunk (-1,-1), local (0, 0)
  });

  it('returns AIR for out-of-range y and unloaded chunks', () => {
    const w = new World(SEED);
    w.ensureChunk(0, 0);
    expect(w.getBlock(3, -1, 3)).toBe(B.AIR);
    expect(w.getBlock(3, WORLD_HEIGHT, 3)).toBe(B.AIR);
    expect(w.getBlock(3, NaN, 3)).toBe(B.AIR);
    expect(w.getBlock(-1, 0, 0)).toBe(B.AIR); // chunk (-1, 0) not loaded
    expect(w.getBlock(16, 0, 0)).toBe(B.AIR);
    expect(w.getBlock(3 + 32768 * CHUNK_SIZE, 0, 3)).toBe(B.AIR); // numeric-key alias of (0,0)
    expect(w.getBlock(3, 0, 3)).toBe(B.BEDROCK);
  });

  it('setBlock/getBlock with negative coordinates', () => {
    const w = new World(SEED);
    w.ensureChunk(-1, -1);
    w.ensureChunk(-2, -2);
    expect(w.setBlock(-1, 40, -1, B.GLASS)).toBe(true);
    expect(w.getBlock(-1, 40, -1)).toBe(B.GLASS);
    expect(w.getChunk(-1, -1).get(15, 40, 15)).toBe(B.GLASS);
    expect(w.setBlock(-17, 41, -32, B.PLANKS)).toBe(true); // chunk (-2,-2), local (15, 0)
    expect(w.getChunk(-2, -2).get(15, 41, 0)).toBe(B.PLANKS);
    expect(w.getBlock(-17, 41, -32)).toBe(B.PLANKS);
  });

  it('setBlock ignores out-of-range y, unloaded chunks and invalid ids', () => {
    const w = new World(SEED);
    w.ensureChunk(0, 0);
    expect(w.setBlock(1, -1, 1, B.STONE)).toBe(false);
    expect(w.setBlock(1, WORLD_HEIGHT, 1, B.STONE)).toBe(false);
    expect(w.setBlock(100, 30, 100, B.STONE)).toBe(false);
    expect(w.setBlock(1, 30, 1, 99)).toBe(false);
    expect(w.setBlock(1.5, 30, 1, B.STONE)).toBe(false);
    expect(w.getEdits()).toEqual({});
  });

  it('heightAt returns the highest solid block, -1 when unloaded', () => {
    const w = new World(SEED);
    w.ensureChunk(0, 0);
    for (let x = 0; x < CHUNK_SIZE; x += 3) {
      for (let z = 0; z < CHUNK_SIZE; z += 3) {
        const h = w.heightAt(x, z);
        expect(h).toBeGreaterThanOrEqual(w.terrain.surfaceHeight(x, z));
        expect(isSolid(w.getBlock(x, h, z))).toBe(true);
        for (let y = h + 1; y < WORLD_HEIGHT; y++) expect(isSolid(w.getBlock(x, y, z))).toBe(false);
      }
    }
    expect(w.heightAt(-5, 3)).toBe(-1);
    w.setBlock(2, 60, 2, B.STONE);
    expect(w.heightAt(2, 2)).toBe(60);
  });
});

describe('World dirty tracking and meshing queue', () => {
  it('only returns meshable chunks (chunk + 4 neighbors loaded); others stay queued', () => {
    const w = new World(SEED);
    w.ensureChunk(0, 0);
    expect(w.consumeDirtyChunks()).toEqual([]);
    expect(w.pendingMeshCount()).toBe(1);
    w.ensureChunk(1, 0);
    w.ensureChunk(-1, 0);
    w.ensureChunk(0, 1);
    expect(w.consumeDirtyChunks()).toEqual([]);
    w.ensureChunk(0, -1);
    const got = w.consumeDirtyChunks();
    expect(keysOf(got)).toEqual(['0,0']);
    expect(got[0]).toBe(w.getChunk(0, 0));
    expect(w.pendingMeshCount()).toBe(4); // the 4 neighbors still lack their own neighbors
    expect(w.consumeDirtyChunks()).toEqual([]);
  });

  it('honors limit nearest-first and skips chunks beyond RENDER_DISTANCE', () => {
    const w = new World(SEED);
    w.generateAround(8, 8, RENDER_DISTANCE + 1); // focus chunk (0,0)
    const first = w.consumeDirtyChunks(1);
    expect(keysOf(first)).toEqual(['0,0']);
    const next = w.consumeDirtyChunks(4);
    expect(keysOf(next)).toEqual(['-1,0', '0,-1', '0,1', '1,0']);
    const rest = w.consumeDirtyChunks();
    expect(1 + 4 + rest.length).toBe(circleCount(RENDER_DISTANCE));
    for (const c of rest) expect(c.cx * c.cx + c.cz * c.cz).toBeLessThanOrEqual(RENDER_DISTANCE ** 2);
    // Order is nearest first.
    for (let i = 1; i < rest.length; i++) {
      const d0 = rest[i - 1].cx ** 2 + rest[i - 1].cz ** 2;
      const d1 = rest[i].cx ** 2 + rest[i].cz ** 2;
      expect(d1).toBeGreaterThanOrEqual(d0);
    }
    expect(w.pendingMeshCount()).toBe(0);
    expect(w.consumeDirtyChunks()).toEqual([]);
  });

  it('setBlock marks the chunk urgent; border edits also mark the neighbor; urgent ignores limit', () => {
    const w = new World(SEED);
    w.generateAround(8, 8, 4);
    w.consumeDirtyChunks();
    expect(w.consumeDirtyChunks()).toEqual([]);

    // Glass never occurs in terrain, so every edit below really changes a block.
    // Interior edit: only its own chunk.
    expect(w.setBlock(5, 40, 5, B.GLASS)).toBe(true);
    expect(keysOf(w.consumeDirtyChunks(0))).toEqual(['0,0']);

    // Edge edits: lx=0 -> west neighbor, lx=15 -> east, lz=0 -> north, lz=15 -> south.
    w.setBlock(0, 40, 5, B.GLASS);
    expect(keysOf(w.consumeDirtyChunks(0))).toEqual(['-1,0', '0,0']);
    w.setBlock(15, 40, 5, B.GLASS);
    expect(keysOf(w.consumeDirtyChunks(0))).toEqual(['0,0', '1,0']);
    w.setBlock(5, 40, 0, B.GLASS);
    expect(keysOf(w.consumeDirtyChunks(0))).toEqual(['0,-1', '0,0']);
    w.setBlock(5, 40, -1, B.GLASS); // local z 15 of chunk (0,-1) -> neighbor (0,0)
    expect(keysOf(w.consumeDirtyChunks(0))).toEqual(['0,-1', '0,0']);

    // Corner edit: both edge neighbors plus the diagonal one.
    w.setBlock(-1, 40, -1, B.GLASS);
    expect(keysOf(w.consumeDirtyChunks(0))).toEqual(['-1,-1', '-1,0', '0,-1', '0,0']);
  });

  it('edited chunks are returned regardless of limit and distance, before the rest', () => {
    const w = new World(SEED);
    w.generateAround(8, 8, RENDER_DISTANCE + 1);
    // Far chunk (3,3) and a normal backlog; with limit 1 we still get every edited chunk.
    w.setBlock(3 * 16 + 5, 40, 3 * 16 + 5, B.GLASS);
    w.setBlock(-2 * 16 + 5, 40, 1 * 16 + 5, B.GLASS);
    const got = w.consumeDirtyChunks(1);
    expect(got.length).toBe(3);
    expect(keysOf(got.slice(0, 2))).toEqual(['-2,1', '3,3']);
    expect(got[2].key).toBe('0,0');

    w.consumeDirtyChunks();
    expect(w.pendingMeshCount()).toBe(0);

    // Chunk (0,7) is outside RENDER_DISTANCE: once meshable it is still not returned...
    const far = RENDER_DISTANCE + 1;
    for (const [cx, cz] of [[0, far + 1], [1, far], [-1, far]]) w.ensureChunk(cx, cz);
    expect(keysOf(w.consumeDirtyChunks())).not.toContain(`0,${far}`);
    // ...unless it was edited.
    expect(w.setBlock(5, 40, far * 16 + 5, B.GLASS)).toBe(true);
    expect(keysOf(w.consumeDirtyChunks(0))).toEqual([`0,${far}`]);
  });

  it('newly generated chunks are dirty; non-meshable urgent chunks wait for neighbors', () => {
    const w = new World(SEED);
    w.ensureChunk(0, 0);
    w.ensureChunk(1, 0);
    expect(w.setBlock(15, 40, 3, B.GLASS)).toBe(true); // marks (0,0) and (1,0) urgent
    expect(w.consumeDirtyChunks(0)).toEqual([]); // neither has all 4 neighbors yet
    for (const [cx, cz] of [[-1, 0], [0, 1], [0, -1]]) w.ensureChunk(cx, cz);
    expect(keysOf(w.consumeDirtyChunks(0))).toEqual(['0,0']); // urgent, so limit 0 does not block it
  });
});

describe('World edits persistence', () => {
  it('edits survive unload and regeneration', () => {
    const w = new World(SEED);
    w.generateAround(0, 0, 1);
    expect(w.setBlock(-3, 35, 4, B.COBBLESTONE)).toBe(true);
    expect(w.setBlock(2, 0, 2, B.AIR)).toBe(true); // even bedrock can be overwritten by the edit API
    w.consumeUnloadedChunks();

    // Move far away: (0,0) and (-1,0) unload.
    w.update(40 * CHUNK_SIZE, 0);
    expect(w.hasChunkData(0, 0)).toBe(false);
    expect(w.hasChunkData(-1, 0)).toBe(false);
    expect(w.getBlock(-3, 35, 4)).toBe(B.AIR);
    const unloaded = w.consumeUnloadedChunks();
    expect(unloaded).toContain('0,0');
    expect(unloaded).toContain('-1,0');

    // Come back: regenerated chunks have the edits re-applied on top of terrain.
    w.ensureChunk(-1, 0);
    w.ensureChunk(0, 0);
    expect(w.getBlock(-3, 35, 4)).toBe(B.COBBLESTONE);
    expect(w.getBlock(2, 0, 2)).toBe(B.AIR);
    expect(w.getBlock(3, 0, 3)).toBe(B.BEDROCK);
  });

  it('getEdits/applyEdits round-trip through JSON', () => {
    const a = new World(SEED);
    a.generateAround(0, 0, 3);
    const changes = [
      [-1, 30, -1, B.GLASS], [0, 31, 0, B.PLANKS], [17, 45, -20, B.LOG], [5, 1, 5, B.AIR], [-30, 50, 12, B.SAND],
    ];
    for (const [x, y, z, id] of changes) expect(a.setBlock(x, y, z, id)).toBe(true);
    a.setBlock(0, 31, 0, B.LEAVES); // overwrite: last edit wins
    const saved = JSON.parse(JSON.stringify(a.getEdits()));

    // Format: { "cx,cz": [[index, id], ...] }
    expect(saved['-1,-1']).toEqual([[blockIndex(15, 30, 15), B.GLASS]]);
    expect(saved['0,0']).toContainEqual([blockIndex(0, 31, 0), B.LEAVES]);

    // Applied before generation: edits appear when chunks generate.
    const b = new World(SEED);
    b.applyEdits(saved);
    b.generateAround(0, 0, 3);
    for (const [x, y, z] of changes) expect(b.getBlock(x, y, z)).toBe(a.getBlock(x, y, z));
    expect(b.getBlock(0, 31, 0)).toBe(B.LEAVES);
    expect(b.getEdits()).toEqual(a.getEdits());

    // Applied after generation: loaded chunks update immediately and are marked dirty.
    const c = new World(SEED);
    c.generateAround(0, 0, 3);
    c.consumeDirtyChunks();
    expect(c.applyEdits(saved)).toBe(5);
    for (const [x, y, z] of changes) expect(c.getBlock(x, y, z)).toBe(a.getBlock(x, y, z));
    expect(c.consumeDirtyChunks().map((ch) => ch.key)).toContain('0,0');
  });

  it('applyEdits tolerates malformed input without throwing', () => {
    const w = new World(SEED);
    w.ensureChunk(0, 0);
    const before = w.getChunk(0, 0).blocks.slice();
    const bad = [
      null, undefined, 42, 'edits', [], [[1, 2]], { '0,0': 'x' }, { '0,0': null }, { 'a,b': [[0, 1]] },
      { '0;0': [[0, 1]] }, { '1.5,0': [[0, 1]] },
      { '0,0': [null, 5, 'x', [], [1], [-1, 1], [CHUNK_VOLUME, 1], [1.5, 1], [3, 99], [3, -1], [3, 1.5], ['3', 1], [3, '1']] },
    ];
    for (const input of bad) expect(() => w.applyEdits(input)).not.toThrow();
    expect(w.getEdits()).toEqual({});
    expect(w.getChunk(0, 0).blocks).toEqual(before);

    // Good entries next to bad ones are still applied.
    expect(w.applyEdits({ '0,0': [[blockIndex(1, 40, 1), B.GLASS], ['bad'], [blockIndex(2, 40, 2), 77]], nope: 1 })).toBe(1);
    expect(w.getBlock(1, 40, 1)).toBe(B.GLASS);
    expect(w.getBlock(2, 40, 2)).not.toBe(77);

    const throwing = {};
    Object.defineProperty(throwing, '0,0', { enumerable: true, get() { throw new Error('boom'); } });
    expect(() => w.applyEdits(throwing)).not.toThrow();
  });

  it('clearEdits forgets recorded edits', () => {
    const w = new World(SEED);
    w.ensureChunk(0, 0);
    w.setBlock(1, 40, 1, B.GLASS);
    w.clearEdits();
    expect(w.getEdits()).toEqual({});
  });
});

describe('World per-frame methods (allocation-free steady state)', () => {
  it('consumeDirtyChunks returns one reused array, valid until the next call', () => {
    const w = new World(SEED);
    w.generateAround(8, 8, RENDER_DISTANCE + 1);
    const a = w.consumeDirtyChunks(2);
    expect(a.length).toBe(2);
    const keysA = keysOf(a);
    const b = w.consumeDirtyChunks(2);
    expect(b).toBe(a); // same array object, refilled
    expect(keysOf(b)).not.toEqual(keysA);
    w.consumeDirtyChunks();
    const idle = w.consumeDirtyChunks();
    expect(idle).toBe(a);
    expect(idle).toEqual([]);
  });

  it('idle frames skip the dirty-set scan; any change makes the next call scan again', () => {
    const w = new World(SEED);
    while (w.update(8, 8) > 0);
    w.consumeDirtyChunks();
    // The outer ring (beyond RENDER_DISTANCE) stays dirty forever: never meshed from here.
    expect(w.pendingMeshCount()).toBe(0);
    let scans = 0;
    const isMeshable = w._isMeshable.bind(w);
    w._isMeshable = (chunk) => { scans++; return isMeshable(chunk); };

    expect(w.consumeDirtyChunks(2)).toEqual([]); // first idle call scans once and remembers
    const firstScan = scans;
    expect(firstScan).toBeGreaterThan(0);
    for (let frame = 0; frame < 100; frame++) {
      expect(w.update(8 + (frame % 5), 8)).toBe(0); // moving inside the same chunk changes nothing
      expect(w.consumeUnloadedChunks()).toEqual([]);
      expect(w.consumeDirtyChunks(2)).toEqual([]);
      expect(w.pendingMeshCount()).toBe(0);
    }
    expect(scans).toBe(firstScan);

    // An edit is picked up on the very next call.
    expect(w.setBlock(5, 40, 5, B.GLASS)).toBe(true);
    expect(w.pendingMeshCount()).toBe(1);
    expect(keysOf(w.consumeDirtyChunks(2))).toEqual(['0,0']);
    expect(scans).toBeGreaterThan(firstScan);
    expect(w.pendingMeshCount()).toBe(0);

    // Crossing into a new chunk: new chunks generate, and the queue fills as they become meshable.
    expect(w.update(8 + CHUNK_SIZE, 8)).toBeGreaterThan(0);
    while (w.update(8 + CHUNK_SIZE, 8) > 0);
    expect(w.pendingMeshCount()).toBeGreaterThan(0);
    const got = w.consumeDirtyChunks();
    expect(got.length).toBeGreaterThan(0);
    for (const c of got) expect((c.cx - 1) ** 2 + c.cz ** 2).toBeLessThanOrEqual(RENDER_DISTANCE ** 2);
    expect(w.pendingMeshCount()).toBe(0);
  });

  it('limit selection is nearest first and stable, like a full sort', () => {
    const w = new World(SEED);
    w.generateAround(8, 8, RENDER_DISTANCE + 1);
    const all = [];
    for (;;) {
      const batch = w.consumeDirtyChunks(3);
      if (batch.length === 0) break;
      expect(batch.length).toBeLessThanOrEqual(3);
      all.push(...batch);
    }
    expect(all.length).toBe(circleCount(RENDER_DISTANCE));
    const d = (c) => c.cx * c.cx + c.cz * c.cz;
    for (let i = 1; i < all.length; i++) expect(d(all[i])).toBeGreaterThanOrEqual(d(all[i - 1]));

    // limit 0 returns nothing but keeps the chunks queued (and does not count as idle).
    const w2 = new World(SEED);
    w2.generateAround(8, 8, 2);
    expect(w2.consumeDirtyChunks(0)).toEqual([]);
    expect(keysOf(w2.consumeDirtyChunks(1))).toEqual(['0,0']);
  });

  it('consumeUnloadedChunks double-buffers: the result survives until the next call', () => {
    const w = new World(SEED);
    while (w.update(0, 0) > 0);
    const empty = w.consumeUnloadedChunks();
    expect(empty).toEqual([]);
    expect(w.consumeUnloadedChunks()).toBe(empty); // nothing new: same empty array, no swap

    w.update(5 * CHUNK_SIZE, 0);
    const first = w.consumeUnloadedChunks();
    const firstKeys = [...first];
    expect(firstKeys.length).toBeGreaterThan(0);
    w.update(10 * CHUNK_SIZE, 0); // more unloads while `first` is still being read
    expect(first).toEqual(firstKeys);
    const second = w.consumeUnloadedChunks();
    expect(second).not.toBe(first);
    expect(second.length).toBeGreaterThan(0);
    for (const key of second) expect(firstKeys).not.toContain(key);
    expect(w.consumeUnloadedChunks()).toEqual([]);
  });
});

describe('World streaming', () => {
  it('generates at most CHUNK_GEN_PER_FRAME chunks per update, nearest first, up to GEN_DISTANCE', () => {
    const w = new World(SEED);
    expect(w.update(8, 8)).toBe(CHUNK_GEN_PER_FRAME);
    expect(w.loadedChunkCount()).toBe(CHUNK_GEN_PER_FRAME);
    expect(w.hasChunkData(0, 0)).toBe(true); // the player's own chunk comes first

    let frames = 1;
    while (w.update(8, 8) > 0) {
      frames++;
      expect(w.loadedChunkCount()).toBeLessThanOrEqual(frames * CHUNK_GEN_PER_FRAME);
      if (frames > 1000) throw new Error('streaming never finished');
    }
    const expected = circleCount(GEN_DISTANCE);
    expect(w.loadedChunkCount()).toBe(expected);
    expect(frames).toBe(Math.ceil(expected / CHUNK_GEN_PER_FRAME));
    w.forEachChunk((c) => expect(c.cx * c.cx + c.cz * c.cz).toBeLessThanOrEqual(GEN_DISTANCE ** 2));
    expect(w.consumeUnloadedChunks()).toEqual([]);

    // Generation order: nearer chunks never arrive after farther ones.
    const w2 = new World(SEED);
    const order = [];
    const seen = new Set();
    for (let i = 0; i < 40; i++) {
      w2.update(8, 8);
      w2.forEachChunk((c) => { if (!seen.has(c.key)) { seen.add(c.key); order.push(c.cx * c.cx + c.cz * c.cz); } });
    }
    for (let i = 1; i < order.length; i++) expect(order[i]).toBeGreaterThanOrEqual(order[i - 1]);
  });

  it('unloads chunks beyond UNLOAD_DISTANCE and reports them once', () => {
    const w = new World(SEED);
    while (w.update(0, 0) > 0);
    const before = new Set();
    w.forEachChunk((c) => before.add(c.key));

    // Move 5 chunks east: chunks farther than UNLOAD_DISTANCE from chunk (5,0) unload.
    w.update(5 * CHUNK_SIZE + 1, 0);
    const unloaded = w.consumeUnloadedChunks();
    expect(unloaded.length).toBeGreaterThan(0);
    for (const key of unloaded) {
      expect(before.has(key)).toBe(true);
      const [cx, cz] = key.split(',').map(Number);
      expect((cx - 5) ** 2 + cz ** 2).toBeGreaterThan(UNLOAD_DISTANCE ** 2);
      expect(w.hasChunkData(cx, cz)).toBe(false);
    }
    w.forEachChunk((c) => expect((c.cx - 5) ** 2 + c.cz ** 2).toBeLessThanOrEqual(UNLOAD_DISTANCE ** 2));
    expect(w.consumeUnloadedChunks()).toEqual([]);

    // Small moves inside the same chunk never unload anything.
    w.update(5 * CHUNK_SIZE + 9, 7);
    expect(w.consumeUnloadedChunks()).toEqual([]);
  });

  it('unloaded chunks leave the dirty queue; meshing resumes as streaming fills in', () => {
    const w = new World(SEED);
    for (let i = 0; i < 200; i++) w.update(0, 0);
    w.consumeDirtyChunks();
    expect(w.pendingMeshCount()).toBe(0);
    w.update(-30 * CHUNK_SIZE, 0); // everything unloads, 2 new chunks generate
    expect(w.loadedChunkCount()).toBe(CHUNK_GEN_PER_FRAME);
    expect(w.consumeUnloadedChunks().length).toBe(circleCount(GEN_DISTANCE));
    expect(w.pendingMeshCount()).toBe(CHUNK_GEN_PER_FRAME); // waiting, not meshable yet
    expect(w.consumeDirtyChunks()).toEqual([]);
    while (w.update(-30 * CHUNK_SIZE, 0) > 0);
    const meshed = w.consumeDirtyChunks();
    expect(meshed.length).toBe(circleCount(RENDER_DISTANCE));
    for (const c of meshed) expect((c.cx + 30) ** 2 + c.cz ** 2).toBeLessThanOrEqual(RENDER_DISTANCE ** 2);
  });

  it('local helpers agree with world lookups at chunk borders', () => {
    const w = new World(SEED);
    w.generateAround(0, 0, 2);
    for (const x of [-17, -16, -1, 0, 15, 16]) {
      const c = w.getChunk(toChunkCoord(x), 0);
      expect(w.getBlock(x, 0, 0)).toBe(c.get(toLocalCoord(x), 0, 0));
    }
  });
});

describe('World corner remesh (ambient occlusion)', () => {
  it('generating a chunk re-dirties its loaded diagonal neighbors, so corner AO is rebuilt', () => {
    const w = new World(SEED);
    w.generateAround(8, 8, 2); // focus on chunk (0, 0)
    // Mesh everything that is meshable now, so nothing is pending.
    w.consumeDirtyChunks();
    expect(w.consumeDirtyChunks()).toEqual([]);
    // Chunk (1,0) was meshed (its 4 edge neighbors are inside radius 2), but its diagonal (2,1) is
    // missing, so its corner AO read AIR there. Generating (2,1) must queue (1,0) for a rebuild.
    expect(w.hasChunkData(2, 1)).toBe(false);
    w.ensureChunk(2, 1);
    const keys = keysOf(w.consumeDirtyChunks());
    expect(keys).toContain('1,0');
  });

  it('does not queue already-meshed chunks that are not diagonal neighbors', () => {
    const w = new World(SEED);
    w.generateAround(8, 8, 2);
    w.consumeDirtyChunks();
    w.ensureChunk(2, 1);
    const keys = keysOf(w.consumeDirtyChunks());
    expect(keys).not.toContain('0,0');
    expect(keys).not.toContain('-1,-1');
  });
});
