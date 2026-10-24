import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CHUNK_SIZE, WORLD_HEIGHT, RENDER_DISTANCE, GEN_DISTANCE, AO_FACTORS } from '../src/config.js';
import { B, BLOCKS, isTransparent } from '../src/blocks.js';
import { TILES, tileUV } from '../src/render/tiles.js';
import { buildChunkGeometry } from '../src/render/mesher.js';
import { createChunkMeshes } from '../src/render/chunkMeshes.js';
import { World } from '../src/world/world.js';

const CS = CHUNK_SIZE;
const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** getBlock over a sparse list of [x, y, z, id] world blocks; everything else is AIR. */
function blocksWorld(list) {
  const m = new Map(list.map(([x, y, z, id]) => [`${x},${y},${z}`, id]));
  return (x, y, z) => m.get(`${x},${y},${z}`) ?? B.AIR;
}

const DIRS = {
  '+x': [1, 0, 0], '-x': [-1, 0, 0],
  '+y': [0, 1, 0], '-y': [0, -1, 0],
  '+z': [0, 0, 1], '-z': [0, 0, -1],
};
const SHADE = { '+y': 1.0, '-y': 0.5, '+z': 0.8, '-z': 0.8, '+x': 0.65, '-x': 0.65 };

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Axis direction name ('+x', ...) of a vector, or null if it isn't axis-aligned. */
function dirName(n) {
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len < EPS) return null;
  for (const [name, d] of Object.entries(DIRS)) if (Math.abs(dot(n, d) / len - 1) < EPS) return name;
  return null;
}

const vert = (P, i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];

/**
 * Every triangle with its winding normal (cross product of its edges, so it points out of the
 * front face for counter-clockwise winding), centroid, and the block cell it belongs to.
 */
function triangles(group) {
  const { positions: P, indices: I } = group;
  const out = [];
  for (let t = 0; t < I.length; t += 3) {
    const ids = [I[t], I[t + 1], I[t + 2]];
    const [a, b, c] = ids.map((i) => vert(P, i));
    const normal = cross(sub(b, a), sub(c, a));
    const dir = dirName(normal);
    const centroid = [0, 1, 2].map((k) => (a[k] + b[k] + c[k]) / 3);
    const d = dir ? DIRS[dir] : [0, 0, 0];
    // The block the face belongs to sits half a block behind the face.
    const cell = [0, 1, 2].map((k) => Math.floor(centroid[k] - 0.5 * d[k]));
    out.push({ ids, normal, dir, centroid, cell });
  }
  return out;
}

/** Map of face key `${worldX},${y},${worldZ},${dir}` -> triangle count, for chunk (cx, cz). */
function faceMap(group, cx, cz) {
  const m = new Map();
  for (const t of triangles(group)) {
    const key = `${t.cell[0] + cx * CS},${t.cell[1]},${t.cell[2] + cz * CS},${t.dir}`;
    m.set(key, (m.get(key) || 0) + 1);
  }
  return m;
}

/** Face keys of a group; asserts every face is exactly two triangles. */
function faceSet(group, cx = 0, cz = 0) {
  const m = faceMap(group, cx, cz);
  expect([...m].filter(([, n]) => n !== 2)).toEqual([]);
  return new Set(m.keys());
}

const faceCount = (group) => group.indices.length / 6;
const vertexCount = (group) => group.positions.length / 3;

/** Reference face rule straight from PROJECT.md 5.5, evaluated block by block. */
function referenceFaces(getBlock, cx, cz) {
  const solid = new Set();
  const water = new Set();
  const get = (x, y, z) => (y < 0 || y >= WORLD_HEIGHT ? B.AIR : getBlock(x, y, z));
  for (let y = 0; y < WORLD_HEIGHT; y++) {
    for (let lz = 0; lz < CS; lz++) {
      for (let lx = 0; lx < CS; lx++) {
        const x = cx * CS + lx;
        const z = cz * CS + lz;
        const a = get(x, y, z);
        if (a === B.AIR) continue;
        for (const [name, d] of Object.entries(DIRS)) {
          const n = get(x + d[0], y + d[1], z + d[2]);
          if (n === B.AIR || (isTransparent(n) && n !== a)) {
            (a === B.WATER ? water : solid).add(`${x},${y},${z},${name}`);
          }
        }
      }
    }
  }
  return { solid, water };
}

/**
 * Reference AO level (0..3) for vertex `v` (chunk-local position) of a face of block `cell`
 * (chunk-local) facing `dir`, straight from the classic rule: opaque side/corner cells in the layer
 * in front of the face.
 */
function refAoLevel(getBlock, cx, cz, cell, dir, v) {
  const n = DIRS[dir];
  const axis = n.findIndex((c) => c !== 0);
  const [t1, t2] = [0, 1, 2].filter((a) => a !== axis);
  const front = [cell[0] + n[0], cell[1] + n[1], cell[2] + n[2]];
  const step = (a) => (v[a] - cell[a] === 1 ? 1 : -1);
  const at = (p) => {
    const y = p[1];
    const id = y < 0 || y >= WORLD_HEIGHT ? B.AIR : getBlock(p[0] + cx * CS, y, p[2] + cz * CS);
    return isTransparent(id) ? 0 : 1;
  };
  const p1 = [...front];
  p1[t1] += step(t1);
  const p2 = [...front];
  p2[t2] += step(t2);
  const pc = [...p1];
  pc[t2] += step(t2);
  const s1 = at(p1);
  const s2 = at(p2);
  return s1 && s2 ? 0 : 3 - (s1 + s2 + at(pc));
}

/**
 * Quads of a group (4 consecutive vertices each) with their vertex ids, which diagonal the two
 * triangles share (as a sorted pair of quad-local corner numbers), and both triangles.
 */
function quads(group) {
  const I = group.indices;
  const out = [];
  for (let f = 0; f < I.length / 6; f++) {
    const a = [I[f * 6], I[f * 6 + 1], I[f * 6 + 2]];
    const b = [I[f * 6 + 3], I[f * 6 + 4], I[f * 6 + 5]];
    const shared = a.filter((i) => b.includes(i)).map((i) => i - f * 4).sort();
    out.push({ base: f * 4, shared: shared.join('-') });
  }
  return out;
}

const srgbToLinear = (c) => (c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4));

// Real terrain shared by several tests.
const SEED = 20240611;
const world = new World(SEED);
world.generateAround(0, 0, 3);
const worldGet = (x, y, z) => world.getBlock(x, y, z);
const NEAR = [];
for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) NEAR.push([cx, cz]);

// ---------------------------------------------------------------------------
// Face counts and culling
// ---------------------------------------------------------------------------

describe('mesher face culling', () => {
  it('a single block in empty space gives 6 faces (24 vertices, 36 indices, 12 triangles)', () => {
    const g = buildChunkGeometry(blocksWorld([[5, 10, 5, B.STONE]]), 0, 0);
    expect(vertexCount(g.solid)).toBe(24);
    expect(g.solid.uvs.length).toBe(48);
    expect(g.solid.colors.length).toBe(72);
    expect(g.solid.indices.length).toBe(36);
    expect(triangles(g.solid).length).toBe(12);
    expect(faceSet(g.solid)).toEqual(new Set(Object.keys(DIRS).map((d) => `5,10,5,${d}`)));
    expect(g.water.positions.length).toBe(0);
    expect(g.water.indices.length).toBe(0);
  });

  it('empty chunks give zero-length typed arrays', () => {
    const g = buildChunkGeometry(() => B.AIR, 3, -2);
    for (const group of [g.solid, g.water]) {
      expect(group.positions).toBeInstanceOf(Float32Array);
      expect(group.uvs).toBeInstanceOf(Float32Array);
      expect(group.colors).toBeInstanceOf(Float32Array);
      expect(group.indices).toBeInstanceOf(Uint16Array);
      expect(group.positions.length + group.uvs.length + group.colors.length + group.indices.length).toBe(0);
    }
  });

  it('two adjacent blocks give 10 faces along every axis', () => {
    for (const [dx, dy, dz, shared] of [[1, 0, 0, '+x'], [0, 1, 0, '+y'], [0, 0, 1, '+z']]) {
      const g = buildChunkGeometry(blocksWorld([[5, 10, 5, B.DIRT], [5 + dx, 10 + dy, 5 + dz, B.STONE]]), 0, 0);
      expect(faceCount(g.solid)).toBe(10);
      expect(vertexCount(g.solid)).toBe(40);
      const faces = faceSet(g.solid);
      expect(faces.has(`5,10,5,${shared}`)).toBe(false);
      expect(faces.has(`${5 + dx},${10 + dy},${5 + dz},${shared.replace('+', '-')}`)).toBe(false);
    }
  });

  it('culls against blocks in the neighbor chunk (positive x and z borders)', () => {
    const gx = blocksWorld([[15, 10, 7, B.STONE], [16, 10, 7, B.STONE]]);
    const a = buildChunkGeometry(gx, 0, 0);
    expect(faceCount(a.solid)).toBe(5);
    expect(faceSet(a.solid, 0, 0).has('15,10,7,+x')).toBe(false);
    const b = buildChunkGeometry(gx, 1, 0);
    expect(faceCount(b.solid)).toBe(5);
    expect(faceSet(b.solid, 1, 0).has('16,10,7,-x')).toBe(false);

    const gz = blocksWorld([[7, 10, 15, B.STONE], [7, 10, 16, B.STONE]]);
    expect(faceSet(buildChunkGeometry(gz, 0, 0).solid, 0, 0).has('7,10,15,+z')).toBe(false);
    expect(faceSet(buildChunkGeometry(gz, 0, 1).solid, 0, 1).has('7,10,16,-z')).toBe(false);
    expect(faceCount(buildChunkGeometry(gz, 0, 1).solid)).toBe(5);
  });

  it('culls across borders of negative chunks (cx = -1)', () => {
    // World x = -1 is chunk -1, local 15; world x = 0 is chunk 0, local 0.
    const g = blocksWorld([[-1, 10, -1, B.STONE], [0, 10, -1, B.STONE], [-1, 10, 0, B.STONE]]);
    const m = buildChunkGeometry(g, -1, -1);
    expect(faceCount(m.solid)).toBe(4); // +x and +z faces culled by the neighbor chunks
    const faces = faceSet(m.solid, -1, -1);
    expect(faces.has('-1,10,-1,+x')).toBe(false);
    expect(faces.has('-1,10,-1,+z')).toBe(false);
    // Chunk-local positions: the block at world (-1, -1) is local (15, 15).
    const P = m.solid.positions;
    for (let i = 0; i < P.length; i += 3) {
      expect(P[i]).toBeGreaterThanOrEqual(15);
      expect(P[i]).toBeLessThanOrEqual(16);
      expect(P[i + 2]).toBeGreaterThanOrEqual(15);
      expect(P[i + 2]).toBeLessThanOrEqual(16);
    }
    expect(faceSet(buildChunkGeometry(g, 0, -1).solid, 0, -1).has('0,10,-1,-x')).toBe(false);

    // Local x = 0 of chunk -1 (world -16) against chunk -2 (world -17).
    const g2 = blocksWorld([[-16, 20, 4, B.STONE], [-17, 20, 4, B.STONE]]);
    const m2 = buildChunkGeometry(g2, -1, 0);
    expect(faceCount(m2.solid)).toBe(5);
    expect(faceSet(m2.solid, -1, 0).has('-16,20,4,-x')).toBe(false);
    // Without the neighbor the border face is drawn.
    expect(faceCount(buildChunkGeometry(blocksWorld([[-16, 20, 4, B.STONE]]), -1, 0).solid)).toBe(6);
  });

  it('draws faces at the bottom and top of the world', () => {
    const g = buildChunkGeometry(blocksWorld([[2, 0, 2, B.STONE], [3, WORLD_HEIGHT - 1, 3, B.STONE]]), 0, 0);
    const faces = faceSet(g.solid);
    expect(faces.size).toBe(12);
    expect(faces.has('2,0,2,-y')).toBe(true);
    expect(faces.has(`3,${WORLD_HEIGHT - 1},3,+y`)).toBe(true);
  });

  it('culls water-water faces and puts water in its own group', () => {
    const g = buildChunkGeometry(blocksWorld([[5, 10, 5, B.WATER], [6, 10, 5, B.WATER]]), 0, 0);
    expect(faceCount(g.water)).toBe(10);
    expect(faceCount(g.solid)).toBe(0);
    expect(g.solid.positions.length).toBe(0);
  });

  it('glass next to stone draws the stone face and culls the glass face', () => {
    const g = buildChunkGeometry(blocksWorld([[5, 10, 5, B.STONE], [6, 10, 5, B.GLASS]]), 0, 0);
    const faces = faceSet(g.solid);
    expect(faces.size).toBe(11);
    expect(faces.has('5,10,5,+x')).toBe(true); // stone toward glass
    expect(faces.has('6,10,5,-x')).toBe(false); // glass toward stone
  });

  it('stone next to water: stone face in solid, water face toward stone culled', () => {
    const g = buildChunkGeometry(blocksWorld([[5, 10, 5, B.STONE], [5, 11, 5, B.WATER]]), 0, 0);
    expect(faceSet(g.solid).has('5,10,5,+y')).toBe(true);
    expect(faceCount(g.solid)).toBe(6);
    expect(faceSet(g.water).has('5,11,5,-y')).toBe(false);
    expect(faceCount(g.water)).toBe(5);
  });

  it('culls leaves-leaves and glass-glass, but not leaves-glass', () => {
    const ll = buildChunkGeometry(blocksWorld([[5, 10, 5, B.LEAVES], [5, 10, 6, B.LEAVES]]), 0, 0);
    expect(faceCount(ll.solid)).toBe(10);
    const gg = buildChunkGeometry(blocksWorld([[5, 10, 5, B.GLASS], [5, 11, 5, B.GLASS]]), 0, 0);
    expect(faceCount(gg.solid)).toBe(10);
    const lg = buildChunkGeometry(blocksWorld([[5, 10, 5, B.LEAVES], [6, 10, 5, B.GLASS]]), 0, 0);
    expect(faceCount(lg.solid)).toBe(12);
  });

  it('matches the reference face rule on real terrain (9 chunks around the origin)', () => {
    for (const [cx, cz] of NEAR) {
      const g = buildChunkGeometry(worldGet, cx, cz);
      const ref = referenceFaces(worldGet, cx, cz);
      expect(ref.solid.size).toBeGreaterThan(256);
      expect(faceSet(g.solid, cx, cz)).toEqual(ref.solid);
      expect(faceSet(g.water, cx, cz)).toEqual(ref.water);
    }
  });
});

// ---------------------------------------------------------------------------
// Winding, shading, UVs, bounds
// ---------------------------------------------------------------------------

describe('mesher vertex data', () => {
  it('every triangle of a single block winds counter-clockwise (normal points out of the block)', () => {
    const g = buildChunkGeometry(blocksWorld([[5, 10, 5, B.STONE]]), 0, 0);
    const seen = new Set();
    for (const t of triangles(g.solid)) {
      // Which side of the block the triangle lies on, from its position alone.
      const off = sub(t.centroid, [5.5, 10.5, 5.5]);
      const k = [0, 1, 2].find((a) => Math.abs(Math.abs(off[a]) - 0.5) < EPS);
      const expected = [0, 0, 0];
      expected[k] = Math.sign(off[k]);
      expect(t.dir).toBe(dirName(expected));
      seen.add(t.dir);
    }
    expect(seen.size).toBe(6);
  });

  it('winds counter-clockwise for both quad diagonals (AO flips) on all 6 faces', () => {
    // One opaque block diagonal to each corner of each face in turn: the corner cell darkens exactly
    // one vertex of that face, which flips the diagonal for two of its four corners.
    const seenDiagonals = new Set();
    for (const [name, n] of Object.entries(DIRS)) {
      const axis = n.findIndex((c) => c !== 0);
      const [t1, t2] = [0, 1, 2].filter((a) => a !== axis);
      for (const [s1, s2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const occ = [5 + n[0], 10 + n[1], 5 + n[2]];
        occ[t1] += s1;
        occ[t2] += s2;
        const g = buildChunkGeometry(blocksWorld([[5, 10, 5, B.STONE], [...occ, B.DIRT]]), 0, 0);
        const P = g.solid.positions;
        let checked = 0;
        for (const t of triangles(g.solid)) {
          if (t.cell.join(',') !== '5,10,5') continue;
          const off = sub(t.centroid, [5.5, 10.5, 5.5]);
          const k = [0, 1, 2].find((a) => Math.abs(Math.abs(off[a]) - 0.5) < EPS);
          const expected = [0, 0, 0];
          expected[k] = Math.sign(off[k]);
          expect(t.dir).toBe(dirName(expected));
          checked++;
        }
        expect(checked).toBe(12);
        // The face toward the occluder's layer used the diagonal through its darkened vertex.
        const face = quads(g.solid).find((q) => {
          const t = triangles({ positions: P, indices: Uint32Array.of(q.base, q.base + 1, q.base + 2) })[0];
          return t.dir === name && t.cell.join(',') === '5,10,5';
        });
        seenDiagonals.add(face.shared);
      }
    }
    expect(seenDiagonals).toEqual(new Set(['0-2', '1-3']));
  });

  it('every triangle on real terrain faces from its block toward a visible neighbor', () => {
    const diagonals = { '0-2': 0, '1-3': 0 };
    for (const [cx, cz] of [[0, 0], [-1, -1], [1, -1]]) {
      const g = buildChunkGeometry(worldGet, cx, cz);
      for (const q of quads(g.solid)) diagonals[q.shared]++;
      for (const [group, water] of [[g.solid, false], [g.water, true]]) {
        const bad = [];
        for (const t of triangles(group)) {
          if (t.dir === null) {
            bad.push(t);
            continue;
          }
          const d = DIRS[t.dir];
          const x = t.cell[0] + cx * CS;
          const z = t.cell[2] + cz * CS;
          const a = world.getBlock(x, t.cell[1], z);
          const n = world.getBlock(x + d[0], t.cell[1] + d[1], z + d[2]);
          const ok = a !== B.AIR && (a === B.WATER) === water && (n === B.AIR || (isTransparent(n) && n !== a));
          if (!ok) bad.push(t);
        }
        expect(bad).toEqual([]);
        expect(triangles(group).length).toBe(group.indices.length / 3);
      }
    }
    // Real terrain has plenty of AO-flipped quads, and they wind correctly too.
    expect(diagonals['0-2']).toBeGreaterThan(100);
    expect(diagonals['1-3']).toBeGreaterThan(100);
  });

  it('bakes per-face shading into gray vertex colors (isolated blocks: every AO factor is 1)', () => {
    const g = buildChunkGeometry(blocksWorld([[5, 10, 5, B.GRASS], [8, 10, 5, B.WATER]]), 0, 0);
    for (const group of [g.solid, g.water]) {
      const C = group.colors;
      for (const t of triangles(group)) {
        for (const i of t.ids) {
          expect(C[i * 3]).toBeCloseTo(SHADE[t.dir], 6);
          expect(C[i * 3 + 1]).toBe(C[i * 3]);
          expect(C[i * 3 + 2]).toBe(C[i * 3]);
        }
      }
    }
  });

  it('UVs use the right tile, stay inside its inset rect, and are not mirrored', () => {
    for (const def of BLOCKS) {
      if (def.id === B.AIR) continue;
      const g = buildChunkGeometry(blocksWorld([[5, 10, 5, def.id]]), 0, 0);
      const group = def.id === B.WATER ? g.water : g.solid;
      const P = group.positions;
      const U = group.uvs;
      expect(faceCount(group)).toBe(6);
      for (const t of triangles(group)) {
        const tile = t.dir === '+y' ? def.tiles.top : t.dir === '-y' ? def.tiles.bottom : def.tiles.side;
        const r = tileUV(tile);
        const n = DIRS[t.dir];
        // Texture "up": +Y on side faces, north (-Z) on top/bottom. "Right" as seen from outside.
        const up = t.dir === '+y' || t.dir === '-y' ? [0, 0, -1] : [0, 1, 0];
        const right = cross([-n[0], -n[1], -n[2]], up);
        const center = [5.5 + 0.5 * n[0], 10.5 + 0.5 * n[1], 5.5 + 0.5 * n[2]];
        for (const i of t.ids) {
          const u = U[i * 2];
          const v = U[i * 2 + 1];
          expect(u).toBeGreaterThanOrEqual(r.u0 - EPS);
          expect(u).toBeLessThanOrEqual(r.u1 + EPS);
          expect(v).toBeGreaterThanOrEqual(r.v0 - EPS);
          expect(v).toBeLessThanOrEqual(r.v1 + EPS);
          const rel = sub(vert(P, i), center);
          expect(u).toBeCloseTo(dot(rel, right) > 0 ? r.u1 : r.u0, 6);
          expect(v).toBeCloseTo(dot(rel, up) > 0 ? r.v1 : r.v0, 6);
        }
      }
    }
  });

  it('grass side faces put v1 (tile top edge) on the top vertices', () => {
    const g = buildChunkGeometry(blocksWorld([[5, 10, 5, B.GRASS]]), 0, 0);
    const r = tileUV(TILES.GRASS_SIDE);
    let sides = 0;
    for (const t of triangles(g.solid)) {
      if (t.dir === '+y' || t.dir === '-y') continue;
      sides++;
      for (const i of t.ids) {
        const y = g.solid.positions[i * 3 + 1];
        const v = g.solid.uvs[i * 2 + 1];
        expect(v).toBeCloseTo(y === 11 ? r.v1 : r.v0, 6);
      }
    }
    expect(sides).toBe(8);
    expect(r.v1).toBeGreaterThan(r.v0);
  });

  it('all positions are chunk-local and indices are in range', () => {
    for (const [cx, cz] of [[0, 0], [-1, -1], [1, 0], [-1, 1]]) {
      const g = buildChunkGeometry(worldGet, cx, cz);
      for (const group of [g.solid, g.water]) {
        const P = group.positions;
        const out = [];
        for (let i = 0; i < P.length; i += 3) {
          const ok = P[i] >= 0 && P[i] <= CS && P[i + 1] >= 0 && P[i + 1] <= WORLD_HEIGHT &&
            P[i + 2] >= 0 && P[i + 2] <= CS;
          if (!ok) out.push(vert(P, i / 3));
        }
        expect(out).toEqual([]);
        const nv = vertexCount(group);
        expect(group.uvs.length).toBe(nv * 2);
        expect(group.colors.length).toBe(nv * 3);
        expect(group.indices).toBeInstanceOf(Uint16Array);
        expect(group.indices.every((i) => i < nv)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Ambient occlusion
// ---------------------------------------------------------------------------

describe('mesher ambient occlusion', () => {
  /** Color of the vertex at chunk-local position `p` on face `dir` of block `cell` (chunk 0,0). */
  function vertexColor(group, cell, dir, p) {
    const P = group.positions;
    for (const t of triangles(group)) {
      if (t.dir !== dir || t.cell.join(',') !== cell.join(',')) continue;
      for (const i of t.ids) {
        if (P[i * 3] === p[0] && P[i * 3 + 1] === p[1] && P[i * 3 + 2] === p[2]) return group.colors[i * 3];
      }
    }
    throw new Error(`no vertex ${p} on ${dir} of ${cell}`);
  }

  it('uses the configured factors, ordered from dark (level 0) to open (level 3 = 1.0)', () => {
    expect(AO_FACTORS.length).toBe(4);
    expect(AO_FACTORS[3]).toBe(1);
    for (let i = 1; i < 4; i++) expect(AO_FACTORS[i]).toBeGreaterThan(AO_FACTORS[i - 1]);
  });

  it('a block in a corner (floor + two walls) has darker vertices than an exposed block', () => {
    // Floor y = 9 over x, z in 2..8; walls at x = 4 and z = 4 (y 10..11); the block sits at (5, 10, 5)
    // in the corner. A second block at (5, 20, 5) floats in open air.
    const list = [[5, 10, 5, B.STONE], [5, 20, 5, B.STONE]];
    for (let x = 2; x <= 8; x++) for (let z = 2; z <= 8; z++) list.push([x, 9, z, B.STONE]);
    for (let y = 10; y <= 11; y++) {
      for (let k = 2; k <= 8; k++) {
        list.push([4, y, k, B.STONE]);
        if (k !== 4) list.push([k, y, 4, B.STONE]);
      }
    }
    const g = buildChunkGeometry(blocksWorld(list), 0, 0);
    const corner = [5, 10, 5];
    const open = [5, 20, 5];

    // Exposed block: every vertex keeps its plain face shade.
    for (const t of triangles(g.solid)) {
      if (t.cell.join(',') !== open.join(',')) continue;
      for (const i of t.ids) expect(g.solid.colors[i * 3]).toBeCloseTo(SHADE[t.dir], 6);
    }

    // Top face of the cornered block: the corner vertex sees both walls (level 0), the two vertices
    // along one wall see a side and the corner (level 1), the far vertex is open (level 3).
    expect(vertexColor(g.solid, corner, '+y', [5, 11, 5])).toBeCloseTo(1.0 * AO_FACTORS[0], 6);
    expect(vertexColor(g.solid, corner, '+y', [6, 11, 5])).toBeCloseTo(1.0 * AO_FACTORS[1], 6);
    expect(vertexColor(g.solid, corner, '+y', [5, 11, 6])).toBeCloseTo(1.0 * AO_FACTORS[1], 6);
    expect(vertexColor(g.solid, corner, '+y', [6, 11, 6])).toBeCloseTo(1.0, 6);
    expect(vertexColor(g.solid, corner, '+y', [5, 11, 5])).toBeLessThan(vertexColor(g.solid, open, '+y', [5, 21, 5]));

    // East face (+x, toward open air at x = 6): the bottom vertices touch the floor, the one next to
    // the z = 4 wall even more so; the top vertex away from the wall is open.
    expect(vertexColor(g.solid, corner, '+x', [6, 10, 5])).toBeCloseTo(0.65 * AO_FACTORS[0], 6);
    expect(vertexColor(g.solid, corner, '+x', [6, 10, 6])).toBeCloseTo(0.65 * AO_FACTORS[1], 6);
    expect(vertexColor(g.solid, corner, '+x', [6, 11, 5])).toBeCloseTo(0.65 * AO_FACTORS[1], 6);
    expect(vertexColor(g.solid, corner, '+x', [6, 11, 6])).toBeCloseTo(0.65, 6);
    // The faces against the walls and the floor are culled.
    const faces = faceSet(g.solid);
    for (const d of ['-x', '-z', '-y']) expect(faces.has(`5,10,5,${d}`)).toBe(false);
  });

  it('only opaque blocks occlude: glass, leaves and water cast no AO; water faces get none', () => {
    for (const id of [B.GLASS, B.LEAVES, B.WATER]) {
      // Transparent blocks on all 4 sides of the top layer, plus one on the diagonal.
      const list = [[5, 10, 5, B.STONE], [4, 11, 5, id], [6, 11, 5, id], [5, 11, 4, id], [5, 11, 6, id], [4, 11, 4, id]];
      const g = buildChunkGeometry(blocksWorld(list), 0, 0);
      for (const t of triangles(g.solid)) {
        if (t.cell.join(',') !== '5,10,5') continue;
        for (const i of t.ids) expect(g.solid.colors[i * 3]).toBeCloseTo(SHADE[t.dir], 6);
      }
    }
    // A water block in a stone corner keeps plain face shading on every face.
    const list = [[5, 10, 5, B.WATER]];
    for (let x = 3; x <= 7; x++) for (let z = 3; z <= 7; z++) list.push([x, 9, z, B.STONE]);
    for (let k = 3; k <= 7; k++) list.push([4, 11, k, B.STONE], [k, 11, 4, B.STONE]);
    const g = buildChunkGeometry(blocksWorld(list), 0, 0);
    expect(faceCount(g.water)).toBeGreaterThan(0);
    for (const t of triangles(g.water)) for (const i of t.ids) expect(g.water.colors[i * 3]).toBeCloseTo(SHADE[t.dir], 6);
  });

  it('flips the diagonal through the darkened vertex when AO is anisotropic; both triangles face out', () => {
    // An opaque block diagonally above each corner of the top face of (5, 10, 5) darkens just that
    // vertex (corner only: level 2). Top face corners in mesher order: 0 (x0, z1), 1 (x1, z1),
    // 2 (x1, z0), 3 (x0, z0). Split 0-2 unless level0 + level2 > level1 + level3.
    const cases = [
      { occ: [4, 11, 6], dark: [5, 11, 6], diagonal: '0-2' },
      { occ: [6, 11, 6], dark: [6, 11, 6], diagonal: '1-3' },
      { occ: [6, 11, 4], dark: [6, 11, 5], diagonal: '0-2' },
      { occ: [4, 11, 4], dark: [5, 11, 5], diagonal: '1-3' },
    ];
    for (const { occ, dark, diagonal } of cases) {
      const g = buildChunkGeometry(blocksWorld([[5, 10, 5, B.STONE], [...occ, B.STONE]]), 0, 0);
      const P = g.solid.positions;
      const C = g.solid.colors;
      const top = quads(g.solid).find((q) => {
        const t = triangles({ positions: P, indices: Uint32Array.of(q.base, q.base + 1, q.base + 2) })[0];
        return t.dir === '+y' && t.cell.join(',') === '5,10,5';
      });
      expect(top.shared).toBe(diagonal);
      // The shared diagonal runs through the darkened vertex.
      const sharedIds = top.shared.split('-').map((k) => top.base + Number(k));
      const darkIds = sharedIds.filter((i) => vert(P, i).join(',') === dark.join(','));
      expect(darkIds.length).toBe(1);
      expect(C[darkIds[0] * 3]).toBeCloseTo(AO_FACTORS[2], 6);
      // Both triangles of the face wind counter-clockwise (normal +Y).
      const tris = triangles({ positions: P, indices: g.solid.indices.subarray((top.base / 4) * 6, (top.base / 4) * 6 + 6) });
      expect(tris.map((t) => t.dir)).toEqual(['+y', '+y']);
    }
  });

  it('matches the reference AO rule at every vertex of real terrain (9 chunks)', () => {
    for (const [cx, cz] of NEAR) {
      const g = buildChunkGeometry(worldGet, cx, cz);
      for (const [group, water] of [[g.solid, false], [g.water, true]]) {
        const P = group.positions;
        const C = group.colors;
        const bad = [];
        for (const t of triangles(group)) {
          for (const i of t.ids) {
            const level = water ? 3 : refAoLevel(worldGet, cx, cz, t.cell, t.dir, vert(P, i));
            const expected = SHADE[t.dir] * AO_FACTORS[level];
            if (Math.abs(C[i * 3] - expected) > 1e-6) bad.push({ cell: t.cell, dir: t.dir, v: vert(P, i), got: C[i * 3], expected });
          }
        }
        expect(bad.slice(0, 5)).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Input/output mechanics
// ---------------------------------------------------------------------------

describe('mesher mechanics', () => {
  it('calls getBlock once per padded cell, only with in-range y', () => {
    for (const [cx, cz] of [[0, 0], [-1, 2]]) {
      const seen = new Set();
      const bad = [];
      let calls = 0;
      buildChunkGeometry((x, y, z) => {
        calls++;
        const ok = y >= 0 && y < WORLD_HEIGHT &&
          x >= cx * CS - 1 && x <= cx * CS + CS && z >= cz * CS - 1 && z <= cz * CS + CS;
        if (!ok) bad.push([x, y, z]);
        seen.add(`${x},${y},${z}`);
        return B.AIR;
      }, cx, cz);
      expect(bad).toEqual([]);
      expect(calls).toBe((CS + 2) * (CS + 2) * WORLD_HEIGHT);
      expect(seen.size).toBe(calls);
    }
  });

  it('returns fresh arrays that later calls do not overwrite', () => {
    const one = blocksWorld([[5, 10, 5, B.STONE]]);
    const a = buildChunkGeometry(one, 0, 0);
    const copy = Array.from(a.solid.positions);
    const b = buildChunkGeometry(blocksWorld([[1, 1, 1, B.SAND], [9, 9, 9, B.LOG]]), 0, 0);
    expect(Array.from(a.solid.positions)).toEqual(copy);
    expect(a.solid.positions.buffer).not.toBe(b.solid.positions.buffer);
    const c = buildChunkGeometry(one, 0, 0);
    expect(c.solid.positions).toEqual(a.solid.positions);
    expect(c.solid.uvs).toEqual(a.solid.uvs);
    expect(c.solid.colors).toEqual(a.solid.colors);
    expect(c.solid.indices).toEqual(a.solid.indices);
  });

  it('switches to Uint32Array indices for huge meshes, then back to Uint16Array', () => {
    // 3D checkerboard: every block is isolated, 8192 blocks * 6 faces * 4 vertices = 196608 vertices.
    const g = buildChunkGeometry((x, y, z) => ((x + y + z) & 1 ? B.STONE : B.AIR), 0, 0);
    const blocks = (CS * CS * WORLD_HEIGHT) / 2;
    expect(vertexCount(g.solid)).toBe(blocks * 24);
    expect(g.solid.indices).toBeInstanceOf(Uint32Array);
    expect(g.solid.indices.length).toBe(blocks * 36);
    let max = 0;
    for (const i of g.solid.indices) if (i > max) max = i;
    expect(max).toBe(blocks * 24 - 1);

    const small = buildChunkGeometry(blocksWorld([[5, 10, 5, B.STONE]]), 0, 0);
    expect(small.solid.indices).toBeInstanceOf(Uint16Array);
    expect(vertexCount(small.solid)).toBe(24);
  });

  it('meshes real terrain chunks in a few ms', () => {
    let vertices = 0;
    let tris = 0;
    const cold0 = performance.now();
    for (const [cx, cz] of NEAR) buildChunkGeometry(worldGet, cx, cz);
    const coldMs = (performance.now() - cold0) / NEAR.length;

    const passes = 5;
    const t0 = performance.now();
    for (let p = 0; p < passes; p++) {
      for (const [cx, cz] of NEAR) {
        const g = buildChunkGeometry(worldGet, cx, cz);
        if (p === 0) {
          vertices += vertexCount(g.solid) + vertexCount(g.water);
          tris += (g.solid.indices.length + g.water.indices.length) / 3;
        }
      }
    }
    const ms = (performance.now() - t0) / (passes * NEAR.length);
    console.log(
      `mesher: ${ms.toFixed(3)} ms/chunk warm, ${coldMs.toFixed(3)} ms/chunk cold; ` +
        `avg ${Math.round(vertices / NEAR.length)} vertices, ${Math.round(tris / NEAR.length)} triangles per chunk`,
    );
    expect(ms).toBeLessThan(20);
    expect(coldMs).toBeLessThan(20);
  });

  it('meshes the whole spawn area (with AO and caves) well under the 6 ms/chunk budget', () => {
    // Every chunk within RENDER_DISTANCE, as at spawn. Max includes any GC pause that lands inside.
    for (const seed of [SEED, 4242]) {
      const w = new World(seed);
      w.generateAround(8, 8, GEN_DISTANCE);
      const chunks = [...w.consumeDirtyChunks()];
      const get = (x, y, z) => w.getBlock(x, y, z);
      for (let i = 0; i < 10; i++) buildChunkGeometry(get, chunks[i].cx, chunks[i].cz); // warm up
      let total = 0;
      let max = 0;
      let tris = 0;
      for (const c of chunks) {
        const t0 = performance.now();
        const g = buildChunkGeometry(get, c.cx, c.cz);
        const dt = performance.now() - t0;
        total += dt;
        if (dt > max) max = dt;
        tris += (g.solid.indices.length + g.water.indices.length) / 3;
      }
      const avg = total / chunks.length;
      console.log(
        `mesher (AO + caves): seed ${seed}, ${chunks.length} chunks, avg ${avg.toFixed(3)} ms, ` +
          `max ${max.toFixed(3)} ms per chunk, ${Math.round(tris / chunks.length)} triangles per chunk`,
      );
      expect(chunks.length).toBeGreaterThan(100);
      expect(avg).toBeLessThan(6);
    }
  });
});

// ---------------------------------------------------------------------------
// chunkMeshes (three.js objects only; no WebGL needed)
// ---------------------------------------------------------------------------

describe('chunkMeshes', () => {
  const twoGroups = () =>
    buildChunkGeometry(blocksWorld([[-10, 5, 3, B.STONE], [-8, 5, 3, B.WATER]]), -1, 0);

  it('creates the two materials as specified', () => {
    const texture = new THREE.Texture();
    const cm = createChunkMeshes(new THREE.Scene(), texture);
    expect(cm.solidMaterial).toBeInstanceOf(THREE.MeshBasicMaterial);
    expect(cm.solidMaterial.map).toBe(texture);
    expect(cm.solidMaterial.vertexColors).toBe(true);
    expect(cm.solidMaterial.alphaTest).toBe(0.5);
    expect(cm.solidMaterial.transparent).toBe(false);
    expect(cm.waterMaterial.map).toBe(texture);
    expect(cm.waterMaterial.vertexColors).toBe(true);
    expect(cm.waterMaterial.transparent).toBe(true);
    expect(cm.waterMaterial.opacity).toBe(0.7);
    expect(cm.waterMaterial.depthWrite).toBe(false);
    expect(cm.waterMaterial.side).toBe(THREE.DoubleSide);
  });

  it('setChunk adds positioned, cull-ready meshes and tracks triangles', () => {
    const scene = new THREE.Scene();
    const cm = createChunkMeshes(scene, new THREE.Texture());
    const data = twoGroups();
    const solidColors = Array.from(data.solid.colors);
    cm.setChunk('-1,0', -1, 0, data);
    expect(cm.has('-1,0')).toBe(true);
    expect(cm.chunkCount()).toBe(1);
    expect(cm.triangleCount()).toBe(24);
    expect(scene.children.length).toBe(2);

    const solid = scene.children.find((m) => m.material === cm.solidMaterial);
    const water = scene.children.find((m) => m.material === cm.waterMaterial);
    for (const mesh of [solid, water]) {
      expect(mesh.position.toArray()).toEqual([-CS, 0, 0]);
      expect(mesh.matrixAutoUpdate).toBe(false);
      expect(mesh.matrix.elements[12]).toBe(-CS);
      expect(mesh.geometry.boundingSphere).not.toBeNull();
      expect(mesh.geometry.boundingBox).not.toBeNull();
      expect(mesh.geometry.index.array).toBeInstanceOf(Uint16Array);
    }
    expect(water.renderOrder).toBe(1);
    expect(solid.renderOrder).toBe(0);
    expect(solid.geometry.boundingBox.min.toArray()).toEqual([6, 5, 3]);
    expect(solid.geometry.attributes.position.array).toBe(data.solid.positions);

    // Colors are converted sRGB -> linear on upload; the mesher output is left untouched.
    const linear = solid.geometry.attributes.color.array;
    expect(Array.from(data.solid.colors)).toEqual(solidColors);
    for (let i = 0; i < linear.length; i++) expect(linear[i]).toBeCloseTo(srgbToLinear(solidColors[i]), 5);
  });

  it('replacing and removing chunks disposes old geometry; unknown keys are a no-op', () => {
    const scene = new THREE.Scene();
    const cm = createChunkMeshes(scene, new THREE.Texture());
    cm.setChunk('-1,0', -1, 0, twoGroups());
    let disposed = 0;
    for (const m of scene.children) m.geometry.addEventListener('dispose', () => disposed++);

    cm.setChunk('-1,0', -1, 0, buildChunkGeometry(blocksWorld([[-10, 5, 3, B.STONE]]), -1, 0));
    expect(disposed).toBe(2);
    expect(scene.children.length).toBe(1); // empty water group gets no mesh
    expect(cm.triangleCount()).toBe(12);

    cm.setChunk('0,0', 0, 0, buildChunkGeometry(blocksWorld([[1, 1, 1, B.WATER]]), 0, 0));
    expect(cm.chunkCount()).toBe(2);
    expect(cm.triangleCount()).toBe(24);

    cm.removeChunk('5,5');
    expect(cm.chunkCount()).toBe(2);

    for (const m of scene.children) m.geometry.addEventListener('dispose', () => disposed++);
    cm.removeChunk('-1,0');
    expect(disposed).toBe(3);
    expect(cm.has('-1,0')).toBe(false);
    expect(cm.triangleCount()).toBe(12);
    expect(scene.children.length).toBe(1);
    cm.removeChunk('-1,0');
    expect(cm.chunkCount()).toBe(1);
  });

  it('converts AO-shaded colors exactly (cached lookup) and keeps the mesher output untouched', () => {
    const scene = new THREE.Scene();
    const cm = createChunkMeshes(scene, new THREE.Texture());
    const list = [[5, 10, 5, B.STONE]];
    for (let x = 3; x <= 7; x++) for (let z = 3; z <= 7; z++) list.push([x, 9, z, B.STONE]);
    for (let k = 3; k <= 7; k++) list.push([4, 10, k, B.STONE], [k, 10, 4, B.STONE], [4, 11, k, B.DIRT]);
    for (let pass = 0; pass < 2; pass++) { // the second pass reads every value from the cache
      const data = buildChunkGeometry(blocksWorld(list), 0, 0);
      const before = Array.from(data.solid.colors);
      expect(new Set(before).size).toBeGreaterThan(6); // AO really adds levels beyond the 4 face shades
      cm.setChunk('0,0', 0, 0, data);
      expect(Array.from(data.solid.colors)).toEqual(before);
      const linear = scene.children.find((m) => m.material === cm.solidMaterial).geometry.attributes.color.array;
      expect(linear).not.toBe(data.solid.colors);
      expect(linear.length).toBe(before.length);
      const bad = [];
      for (let i = 0; i < linear.length; i++) {
        if (Math.abs(linear[i] - srgbToLinear(before[i])) > 1e-6) bad.push([i, before[i], linear[i]]);
      }
      expect(bad).toEqual([]);
    }
  });

  it('remeshing reuses the chunk meshes and disposes every replaced geometry (no leak)', () => {
    const scene = new THREE.Scene();
    const cm = createChunkMeshes(scene, new THREE.Texture());
    const both = () => twoGroups();
    const solidOnly = () => buildChunkGeometry(blocksWorld([[-10, 5, 3, B.STONE]]), -1, 0);
    cm.setChunk('-1,0', -1, 0, both());
    const solidMesh = scene.children.find((m) => m.material === cm.solidMaterial);
    const live = new Set();
    let created = 0;
    const track = () => {
      for (const m of scene.children) {
        if (live.has(m.geometry)) continue;
        created++;
        live.add(m.geometry);
        const geo = m.geometry;
        geo.addEventListener('dispose', () => live.delete(geo));
      }
    };
    track();
    for (let i = 0; i < 50; i++) {
      cm.setChunk('-1,0', -1, 0, i % 3 === 2 ? solidOnly() : both());
      track();
      expect(live.size).toBe(scene.children.length); // every geometry not in the scene was disposed
      expect(live.size).toBeLessThanOrEqual(2);
      expect(scene.children.includes(solidMesh)).toBe(true); // same Mesh object, new geometry
    }
    expect(created).toBeGreaterThan(50);
    expect(cm.chunkCount()).toBe(1);
    expect(cm.triangleCount()).toBe(24); // the last remesh (i = 49) had both groups
    const water = scene.children.find((m) => m.material === cm.waterMaterial);
    expect(water.renderOrder).toBe(1);
    expect(water.position.toArray()).toEqual([-CS, 0, 0]);
    cm.removeChunk('-1,0');
    expect(live.size).toBe(0);
    expect(scene.children.length).toBe(0);
    expect(cm.triangleCount()).toBe(0);
  });

  it('setBrightness sets both material colors as sRGB gray', () => {
    const cm = createChunkMeshes(new THREE.Scene(), new THREE.Texture());
    cm.setBrightness(0.25);
    for (const mat of [cm.solidMaterial, cm.waterMaterial]) {
      expect(mat.color.r).toBeCloseTo(srgbToLinear(0.25), 6);
      expect(mat.color.getHexString(THREE.SRGBColorSpace)).toBe('404040');
    }
    cm.setBrightness(1);
    expect(cm.solidMaterial.color.r).toBeCloseTo(1, 6);
  });

  it('dispose releases every geometry and both materials', () => {
    const scene = new THREE.Scene();
    const cm = createChunkMeshes(scene, new THREE.Texture());
    cm.setChunk('-1,0', -1, 0, twoGroups());
    cm.setChunk('0,0', 0, 0, buildChunkGeometry(blocksWorld([[1, 1, 1, B.LOG]]), 0, 0));
    let disposed = 0;
    for (const m of scene.children) m.geometry.addEventListener('dispose', () => disposed++);
    cm.solidMaterial.addEventListener('dispose', () => disposed++);
    cm.waterMaterial.addEventListener('dispose', () => disposed++);
    cm.dispose();
    expect(disposed).toBe(5);
    expect(scene.children.length).toBe(0);
    expect(cm.chunkCount()).toBe(0);
    expect(cm.triangleCount()).toBe(0);
  });
});
