import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../src/config.js';
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

  it('every triangle on real terrain faces from its block toward a visible neighbor', () => {
    for (const [cx, cz] of [[0, 0], [-1, -1], [1, -1]]) {
      const g = buildChunkGeometry(worldGet, cx, cz);
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
  });

  it('bakes per-face shading into gray vertex colors', () => {
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
