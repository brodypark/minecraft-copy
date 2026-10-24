import { describe, it, expect } from 'vitest';
import { raycast, isTargetable, createHit } from '../src/world/raycast.js';
import { B } from '../src/blocks.js';
import { REACH, CHUNK_SIZE } from '../src/config.js';
import { World } from '../src/world/world.js';

// Sparse fake world: everything is AIR unless set. getBlock throws on non-integer coordinates, so
// the raycast must only ever ask for whole cells.
function makeWorld(entries = []) {
  const map = new Map();
  const world = {
    calls: 0,
    set(x, y, z, id) {
      map.set(`${x},${y},${z}`, id);
      return world;
    },
    getBlock(x, y, z) {
      world.calls++;
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
        throw new Error(`getBlock called with non-integer coords (${x}, ${y}, ${z})`);
      }
      return map.get(`${x},${y},${z}`) ?? B.AIR;
    },
  };
  for (const [x, y, z, id] of entries) world.set(x, y, z, id);
  world.get = (x, y, z) => world.getBlock(x, y, z);
  return world;
}

const cast = (w, o, d, maxDist, out) => raycast(w.get, o[0], o[1], o[2], d[0], d[1], d[2], maxDist, out);

function expectHit(hit, x, y, z, nx, ny, nz) {
  expect(hit).not.toBeNull();
  expect([hit.x, hit.y, hit.z]).toEqual([x, y, z]);
  // `+ 0` turns -0 into 0 so toEqual doesn't trip over signed zeros.
  expect([hit.nx + 0, hit.ny + 0, hit.nz + 0]).toEqual([nx + 0, ny + 0, nz + 0]);
}

// Deterministic PRNG (mulberry32), so the randomized tests are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('isTargetable', () => {
  it('rays pass through air and water only', () => {
    expect(isTargetable(B.AIR)).toBe(false);
    expect(isTargetable(B.WATER)).toBe(false);
    for (const id of [B.GRASS, B.DIRT, B.STONE, B.COBBLESTONE, B.SAND, B.LOG, B.PLANKS, B.LEAVES, B.GLASS, B.BEDROCK]) {
      expect(isTargetable(id)).toBe(true);
    }
  });
});

describe('raycast basics', () => {
  it('hits the first solid block along a line of blocks', () => {
    const w = makeWorld([[3, 0, 0, B.STONE], [4, 0, 0, B.DIRT], [5, 0, 0, B.SAND]]);
    const hit = cast(w, [0.5, 0.5, 0.5], [1, 0, 0]);
    expectHit(hit, 3, 0, 0, -1, 0, 0);
    expect(hit.id).toBe(B.STONE);
    expect(hit.distance).toBeCloseTo(2.5, 12);
  });

  it('gives the entered face normal for each of the 6 approach directions', () => {
    const T = [10, 10, 10]; // target block
    const w = makeWorld([[...T, B.COBBLESTONE]]);
    const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const d of axes) {
      // A few origins per direction: on the block's center line, off-center, and tilted rays.
      const perp = d.map((c) => (c === 0 ? 1 : 0));
      const variants = [
        { off: 0, tilt: 0 },
        { off: 0.3, tilt: 0 },
        { off: -0.4, tilt: 0 },
        { off: 0.1, tilt: 0.05 },
        { off: -0.2, tilt: -0.07 },
      ];
      for (const { off, tilt } of variants) {
        const o = T.map((c, i) => c + 0.5 - d[i] * 3 + perp[i] * off);
        const dir = d.map((c, i) => c + perp[i] * tilt);
        const hit = cast(w, o, dir);
        expectHit(hit, T[0], T[1], T[2], -d[0], -d[1], -d[2]);
        expect(hit.id).toBe(B.COBBLESTONE);
        if (tilt === 0) expect(hit.distance).toBeCloseTo(2.5, 12);
      }
    }
  });

  it('misses a block just beyond REACH and hits one just within (default maxDist = REACH)', () => {
    expect(REACH).toBe(5);
    const w = makeWorld([[6, 0, 0, B.STONE]]); // near face at x = 6
    expect(cast(w, [0.99, 0.5, 0.5], [1, 0, 0])).toBeNull(); // face at 5.01
    const within = cast(w, [1.01, 0.5, 0.5], [1, 0, 0]); // face at 4.99
    expectHit(within, 6, 0, 0, -1, 0, 0);
    expect(within.distance).toBeCloseTo(4.99, 12);
    const exact = cast(w, [1, 0.5, 0.5], [1, 0, 0]); // face exactly at REACH counts
    expectHit(exact, 6, 0, 0, -1, 0, 0);
    expect(exact.distance).toBe(5);
    // Explicit maxDist, and a diagonal ray: the face distance is what's compared, not the cell count.
    expect(cast(w, [1.01, 0.5, 0.5], [1, 0, 0], 4.9)).toBeNull();
    expectHit(cast(w, [1.01, 0.5, 0.5], [1, 0, 0], 10), 6, 0, 0, -1, 0, 0);
    const diag = makeWorld([[4, 4, 0, B.STONE]]);
    // From (0.5, 0.5) along (1, 1): enters (4, 4) at the corner-ish point (4, 4), distance 3.5 * sqrt(2).
    expect(cast(diag, [0.5, 0.5, 0.5], [1, 1, 0], 4.9)).toBeNull();
    const dh = cast(diag, [0.5, 0.5, 0.5], [1, 1, 0], 5);
    expect(dh).not.toBeNull();
    expect([dh.x, dh.y, dh.z]).toEqual([4, 4, 0]);
    expect(dh.distance).toBeCloseTo(3.5 * Math.SQRT2, 9);
  });

  it('ignores water: water in front of stone gives the stone hit with the right normal', () => {
    const w = makeWorld([[2, 5, 0, B.WATER], [3, 5, 0, B.WATER], [4, 5, 0, B.STONE]]);
    const hit = cast(w, [0.5, 5.5, 0.5], [1, 0, 0]);
    expectHit(hit, 4, 5, 0, -1, 0, 0);
    expect(hit.id).toBe(B.STONE);
    expect(hit.distance).toBeCloseTo(3.5, 12);
    // Looking down through a water column onto the sea floor.
    const sea = makeWorld([[0, 9, 0, B.SAND], [0, 10, 0, B.WATER], [0, 11, 0, B.WATER], [0, 12, 0, B.WATER]]);
    expectHit(cast(sea, [0.5, 13.5, 0.5], [0, -1, 0]), 0, 9, 0, 0, 1, 0);
    // Water alone is never a target, even with the camera inside it.
    const pool = makeWorld([[0, 0, 0, B.WATER], [1, 0, 0, B.WATER], [2, 0, 0, B.WATER]]);
    expect(cast(pool, [0.5, 0.5, 0.5], [1, 0, 0])).toBeNull();
  });

  it('ignores air: an empty world misses in every direction (including axis-aligned rays) without hanging', () => {
    const w = makeWorld();
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [1, -2, 3]];
    for (const d of dirs) {
      w.calls = 0;
      expect(cast(w, [0.5, 0.5, 0.5], d)).toBeNull();
      expect(w.calls).toBeLessThan(20); // a REACH-long ray visits a handful of cells
      // A huge maxDist is capped instead of looping forever.
      expect(cast(w, [0.5, 0.5, 0.5], d, Infinity)).toBeNull();
    }
    // An air gap between the origin and the first block is skipped.
    const gap = makeWorld([[0, 0, 4, B.LEAVES]]);
    expectHit(cast(gap, [0.5, 0.5, 0.5], [0, 0, 1]), 0, 0, 4, 0, 0, -1);
  });

  it('targets glass, leaves and bedrock', () => {
    for (const id of [B.GLASS, B.LEAVES, B.BEDROCK]) {
      const w = makeWorld([[0, 0, 2, id]]);
      const hit = cast(w, [0.5, 0.5, 0.5], [0, 0, 1]);
      expect(hit.id).toBe(id);
    }
  });

  it('works with negative coordinates', () => {
    const o = [-3.5, 10.5, -7.2];
    const w = makeWorld([
      [-6, 10, -8, B.STONE], // -X
      [-4, 10, -10, B.DIRT], // -Z
      [-1, 10, -8, B.SAND], // +X
      [-4, 7, -8, B.GLASS], // -Y
      [-4, 13, -8, B.LOG], // +Y
    ]);
    let hit = cast(w, o, [-1, 0, 0]);
    expectHit(hit, -6, 10, -8, 1, 0, 0);
    expect(hit.distance).toBeCloseTo(1.5, 12); // +X face of x = -6 is at x = -5
    hit = cast(w, o, [0, 0, -1]);
    expectHit(hit, -4, 10, -10, 0, 0, 1);
    expect(hit.distance).toBeCloseTo(1.8, 12); // +Z face of z = -10 is at z = -9
    hit = cast(w, o, [1, 0, 0]);
    expectHit(hit, -1, 10, -8, -1, 0, 0);
    expect(hit.distance).toBeCloseTo(2.5, 12);
    hit = cast(w, o, [0, -1, 0]);
    expectHit(hit, -4, 7, -8, 0, 1, 0);
    expect(hit.distance).toBeCloseTo(2.5, 12);
    hit = cast(w, o, [0, 1, 0]);
    expectHit(hit, -4, 13, -8, 0, -1, 0);
    expect(hit.distance).toBeCloseTo(2.5, 12);

    // Diagonal toward a block across the origin (x and z both cross 0 into negatives).
    const d = makeWorld([[-2, 0, -3, B.STONE]]);
    const dh = cast(d, [1.25, 0.5, 0.75], [-2.75, 0, -3.25]); // aims at the center of (-2, 0, -3)
    expect(dh).not.toBeNull();
    expect([dh.x, dh.y, dh.z]).toEqual([-2, 0, -3]);
  });

  it('returns the origin block with normal (0, 0, 0) when the origin is inside a targetable block', () => {
    const w = makeWorld([[2, 3, 4, B.STONE], [2, 3, 6, B.DIRT]]);
    const hit = cast(w, [2.5, 3.2, 4.9], [0, 0, 1]);
    expectHit(hit, 2, 3, 4, 0, 0, 0);
    expect(hit.id).toBe(B.STONE);
    expect(hit.distance).toBe(0);
    // Negative cell, any direction.
    const n = makeWorld([[-1, 5, -1, B.BEDROCK]]);
    expectHit(cast(n, [-0.3, 5.7, -0.9], [0.3, -1, 2]), -1, 5, -1, 0, 0, 0);
  });

  it('handles origins exactly on cell boundaries', () => {
    // On the top face of a block, looking down: enters it through that face at distance 0.
    const floor = makeWorld([[0, 4, 0, B.STONE]]);
    let hit = cast(floor, [0.5, 5, 0.5], [0, -1, 0]);
    expectHit(hit, 0, 4, 0, 0, 1, 0);
    expect(hit.distance).toBe(0);
    // Same spot looking up: the block below is behind the ray.
    expect(cast(floor, [0.5, 5, 0.5], [0, 1, 0])).toBeNull();
    // On the bottom face of a block, looking away from it (down) ignores it.
    const ceil = makeWorld([[0, 5, 0, B.STONE], [0, 1, 0, B.DIRT]]);
    hit = cast(ceil, [0.5, 5, 0.5], [0, -1, 0]);
    expectHit(hit, 0, 1, 0, 0, 1, 0);
    expect(hit.distance).toBeCloseTo(3, 12);
    // Integer x looking -X: starts in cell 1, not cell 2.
    const line = makeWorld([[0, 0, 0, B.STONE], [2, 0, 0, B.DIRT]]);
    hit = cast(line, [2, 0.5, 0.5], [-1, 0, 0]);
    expectHit(hit, 0, 0, 0, 1, 0, 0);
    expect(hit.distance).toBeCloseTo(1, 12);
    // Negative integer boundary.
    const neg = makeWorld([[-3, 0, 0, B.STONE]]);
    hit = cast(neg, [-2, 0.5, 0.5], [-1, 0, 0]);
    expectHit(hit, -3, 0, 0, 1, 0, 0);
    expect(hit.distance).toBe(0);
    hit = cast(neg, [-6, 0.5, 0.5], [1, 0, 0]);
    expectHit(hit, -3, 0, 0, -1, 0, 0);
    expect(hit.distance).toBeCloseTo(3, 12);
    // Origin on a lattice corner with a diagonal ray, and a ray running along a boundary plane.
    const corner = makeWorld([[2, 2, 2, B.STONE]]);
    hit = cast(corner, [0, 0, 0], [1, 1, 1]);
    expect(hit).not.toBeNull();
    expect([hit.x, hit.y, hit.z]).toEqual([2, 2, 2]);
    expect(hit.distance).toBeCloseTo(2 * Math.sqrt(3), 9);
    const plane = makeWorld([[3, 0, 0, B.STONE]]);
    hit = cast(plane, [0.5, 0, 0.5], [1, 0, 0]); // y = 0 exactly, dy = 0: stays in row y = 0
    expectHit(hit, 3, 0, 0, -1, 0, 0);
  });

  it('writes into `out` and returns the same object; leaves it untouched on a miss', () => {
    const w = makeWorld([[3, 0, 0, B.STONE], [0, 0, -3, B.PLANKS]]);
    const out = createHit();
    const a = cast(w, [0.5, 0.5, 0.5], [1, 0, 0], REACH, out);
    expect(a).toBe(out);
    expect(out).toMatchObject({ x: 3, y: 0, z: 0, id: B.STONE, nx: -1, ny: 0, nz: 0 });
    expect(out.distance).toBeCloseTo(2.5, 12);
    const b = cast(w, [0.5, 0.5, 0.5], [0, 0, -1], REACH, out);
    expect(b).toBe(out);
    expect(out).toMatchObject({ x: 0, y: 0, z: -3, id: B.PLANKS, nx: 0, ny: 0, nz: 1 });
    const snapshot = { ...out };
    expect(cast(w, [0.5, 0.5, 0.5], [0, 1, 0], REACH, out)).toBeNull();
    expect(out).toEqual(snapshot);
    // Without `out`, each hit is a fresh object.
    const c1 = cast(w, [0.5, 0.5, 0.5], [1, 0, 0]);
    const c2 = cast(w, [0.5, 0.5, 0.5], [1, 0, 0]);
    expect(c1).not.toBe(c2);
    expect(c1).toEqual(c2);
  });

  it('normalizes the direction and rejects zero-length or non-finite input', () => {
    const w = makeWorld([[3, 0, 0, B.STONE]]);
    const unit = cast(w, [0.5, 0.5, 0.5], [1, 0, 0]);
    const long = cast(w, [0.5, 0.5, 0.5], [250, 0, 0]);
    expect(long).toEqual(unit);
    expect(cast(w, [0.5, 0.5, 0.5], [0, 0, 0])).toBeNull();
    expect(cast(w, [0.5, 0.5, 0.5], [NaN, 0, 0])).toBeNull();
    expect(cast(w, [NaN, 0.5, 0.5], [1, 0, 0])).toBeNull();
    expect(cast(w, [0.5, 0.5, 0.5], [1, 0, 0], -1)).toBeNull();
  });
});

// ---- Randomized comparison against independent reference implementations ----------------------

const FIELD_MIN = -8;
const FIELD_N = 16; // cells [-8, 8) on each axis; AIR outside
const SOLIDS = [B.STONE, B.DIRT, B.GLASS, B.LEAVES, B.BEDROCK, B.LOG];

function makeRandomField(rand) {
  const cells = new Uint8Array(FIELD_N * FIELD_N * FIELD_N);
  for (let i = 0; i < cells.length; i++) {
    const r = rand();
    cells[i] = r < 0.68 ? B.AIR : r < 0.78 ? B.WATER : SOLIDS[Math.floor(rand() * SOLIDS.length)];
  }
  return (x, y, z) => {
    const ix = x - FIELD_MIN;
    const iy = y - FIELD_MIN;
    const iz = z - FIELD_MIN;
    if (ix < 0 || iy < 0 || iz < 0 || ix >= FIELD_N || iy >= FIELD_N || iz >= FIELD_N) return B.AIR;
    return cells[(iy * FIELD_N + iz) * FIELD_N + ix];
  };
}

// Entry/exit ray lengths of the unit cell (cx, cy, cz) by the slab method; null if the ray's line
// misses it. `d` must be normalized.
function slab(o, d, cx, cy, cz) {
  let tEnter = -Infinity;
  let tExit = Infinity;
  let axis = -1;
  const c = [cx, cy, cz];
  for (let i = 0; i < 3; i++) {
    if (d[i] === 0) {
      if (o[i] < c[i] || o[i] >= c[i] + 1) return null;
      continue;
    }
    let t0 = (c[i] - o[i]) / d[i];
    let t1 = (c[i] + 1 - o[i]) / d[i];
    if (t0 > t1) [t0, t1] = [t1, t0];
    if (t0 > tEnter) {
      tEnter = t0;
      axis = i;
    }
    if (t1 < tExit) tExit = t1;
  }
  if (tEnter > tExit) return null;
  return { tEnter, tExit, axis };
}

// Exact brute force: test every cell in the ray segment's bounding box, take the targetable cell
// with the smallest entry distance. Also reports the runner-up distance to detect near-ties.
function exactFirstHit(getBlock, o, d, maxDist) {
  const ox = Math.floor(o[0]);
  const oy = Math.floor(o[1]);
  const oz = Math.floor(o[2]);
  const id0 = getBlock(ox, oy, oz);
  if (isTargetable(id0)) return { x: ox, y: oy, z: oz, n: [0, 0, 0], distance: 0, runnerUp: Infinity };
  const lo = [0, 1, 2].map((i) => Math.floor(Math.min(o[i], o[i] + d[i] * maxDist)));
  const hi = [0, 1, 2].map((i) => Math.floor(Math.max(o[i], o[i] + d[i] * maxDist)));
  let best = null;
  let runnerUp = Infinity;
  for (let x = lo[0]; x <= hi[0]; x++) {
    for (let y = lo[1]; y <= hi[1]; y++) {
      for (let z = lo[2]; z <= hi[2]; z++) {
        if (!isTargetable(getBlock(x, y, z))) continue;
        const s = slab(o, d, x, y, z);
        if (s === null || s.tEnter < 0 || s.tEnter > maxDist) continue;
        if (best === null || s.tEnter < best.distance) {
          if (best !== null) runnerUp = best.distance;
          const n = [0, 0, 0];
          n[s.axis] = -Math.sign(d[s.axis]);
          best = { x, y, z, n, distance: s.tEnter, tExit: s.tExit };
        } else if (s.tEnter < runnerUp) {
          runnerUp = s.tEnter;
        }
      }
    }
  }
  if (best !== null) best.runnerUp = runnerUp;
  return best;
}

// Small-step march: sample floor(o + d * t) every `step` along the ray.
function marchFirstHit(getBlock, o, d, maxDist, step) {
  const n = Math.floor(maxDist / step);
  for (let i = 0; i <= n; i++) {
    const t = i * step;
    const x = Math.floor(o[0] + d[0] * t);
    const y = Math.floor(o[1] + d[1] * t);
    const z = Math.floor(o[2] + d[2] * t);
    if (isTargetable(getBlock(x, y, z))) return { x, y, z };
  }
  return null;
}

function randomRays(seed, count) {
  const rand = mulberry32(seed);
  const rays = [];
  for (let i = 0; i < count; i++) {
    const o = [rand() * 10 - 5, rand() * 10 - 5, rand() * 10 - 5];
    let d;
    do {
      d = [rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1];
    } while (Math.hypot(...d) > 1 || Math.hypot(...d) < 1e-3);
    // Some rays lie in an axis plane or along an axis (tDelta = Infinity on those axes).
    if (i % 7 === 3) d[i % 3] = 0;
    if (i % 11 === 5) {
      d[i % 3] = 0;
      d[(i + 1) % 3] = 0;
    }
    const len = Math.hypot(...d);
    d = d.map((c) => c / len);
    const maxDist = i % 5 === 0 ? 9 : REACH;
    rays.push({ o, d, maxDist });
  }
  return rays;
}

describe('raycast vs. brute force (seeded random rays in a random block field)', () => {
  it('matches a small-step march on the first hit cell', () => {
    const STEP = 1e-3;
    const getBlock = makeRandomField(mulberry32(1234));
    let hits = 0;
    let slivers = 0;
    for (const { o, d, maxDist } of randomRays(99, 600)) {
      const got = raycast(getBlock, o[0], o[1], o[2], d[0], d[1], d[2], maxDist);
      const ref = marchFirstHit(getBlock, o, d, maxDist, STEP);
      if (got !== null) hits++;
      const same = got === null ? ref === null : ref !== null && got.x === ref.x && got.y === ref.y && got.z === ref.z;
      if (same) continue;
      // The only acceptable disagreement: the ray clips the DDA's cell (or the end of reach) for
      // less than one march step, so the march stepped over it. Never the other way round.
      expect(got).not.toBeNull();
      const s = slab(o, d, got.x, got.y, got.z);
      expect(s).not.toBeNull();
      expect(Math.min(s.tExit, maxDist) - s.tEnter).toBeLessThan(STEP);
      slivers++;
    }
    expect(hits).toBeGreaterThan(200); // the field is dense enough that the test means something
    expect(slivers).toBeLessThan(10);
  });

  it('matches an exact slab-test brute force on cell, face normal and distance', () => {
    const getBlock = makeRandomField(mulberry32(777));
    let hits = 0;
    let checked = 0;
    for (const { o, d, maxDist } of randomRays(4321, 1500)) {
      const out = createHit();
      const got = raycast(getBlock, o[0], o[1], o[2], d[0], d[1], d[2], maxDist, out);
      const ref = exactFirstHit(getBlock, o, d, maxDist);
      if (ref !== null && ref.runnerUp - ref.distance < 1e-9) continue; // ray through an edge: ambiguous
      checked++;
      if (ref === null) {
        expect(got).toBeNull();
        continue;
      }
      hits++;
      expect(got).toBe(out);
      expect([got.x, got.y, got.z]).toEqual([ref.x, ref.y, ref.z]);
      expect([got.nx + 0, got.ny + 0, got.nz + 0]).toEqual(ref.n.map((c) => c + 0));
      expect(got.distance).toBeCloseTo(ref.distance, 9);
      expect(got.id).toBe(getBlock(ref.x, ref.y, ref.z));
    }
    expect(checked).toBeGreaterThan(1450);
    expect(hits).toBeGreaterThan(500);
  });
});

describe('raycast with a real World', () => {
  it('works across chunk borders at negative coordinates via world.getBlock', () => {
    const world = new World(31337);
    world.ensureChunk(-1, 0);
    world.ensureChunk(0, 0);
    // Clear the ray paths explicitly (a tall tree could reach this high), then place the target.
    for (let x = -2; x <= 1; x++) world.setBlock(x, 62, 5, B.AIR);
    world.setBlock(-3, 63, 5, B.AIR);
    expect(world.setBlock(-3, 62, 5, B.PLANKS)).toBe(true);
    const getBlock = (x, y, z) => world.getBlock(x, y, z);
    const hit = raycast(getBlock, 1.5, 62.5, 5.5, -1, 0, 0);
    expectHit(hit, -3, 62, 5, 1, 0, 0);
    expect(hit.id).toBe(B.PLANKS);
    expect(hit.distance).toBeCloseTo(3.5, 12); // +X face of x = -3 is at x = -2
    expect(Math.floor(-3 / CHUNK_SIZE)).toBe(-1); // really in the neighbor chunk
    // From above the world (y >= WORLD_HEIGHT reads as AIR) straight down onto the block.
    const down = raycast(getBlock, -2.5, 66, 5.5, 0, -1, 0);
    expectHit(down, -3, 62, 5, 0, 1, 0);
    expect(down.distance).toBeCloseTo(3, 12);
  });
});
