// Chunk mesher (PROJECT.md section 5.5). PURE module: no three.js, no DOM, so it
// runs in node tests and can move into a Web Worker unchanged.
//
// buildChunkGeometry(getBlock, cx, cz) turns one chunk's blocks into plain typed
// arrays; render/chunkMeshes.js wraps them in three.js meshes.
//
// Conventions
// - Positions are CHUNK-LOCAL: x and z in 0..CHUNK_SIZE, y in 0..WORLD_HEIGHT.
//   Block (lx, y, lz) spans [lx, lx+1] x [y, y+1] x [lz, lz+1]. The caller places
//   the mesh at world (cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE).
// - Every face is a quad of 4 vertices (two triangles, 6 indices), wound
//   counter-clockwise when seen from outside the block (three.js front face).
// - Vertex order inside a quad, as seen from outside: 0 bottom-left,
//   1 bottom-right, 2 top-right, 3 top-left. "Up" is +Y on side faces and -Z
//   (north) on the top and bottom faces.
// - UVs come from tiles.js (inset half a texel): u0 on the left vertices, u1 on
//   the right ones (so textures are not mirrored), v0 on the bottom vertices and
//   v1 on the top ones (v1 is the tile's top edge, so grass sides show grass on top).
// - Colors are gray (r = g = b) per-face shading: top 1.0, north/south 0.8,
//   east/west 0.65, bottom 0.5, times a per-vertex ambient occlusion factor
//   (AO_FACTORS in config.js; 1.0 for an unoccluded vertex and for every water
//   vertex). These are sRGB values; chunkMeshes converts them for three's linear
//   color pipeline at upload time.
// - Ambient occlusion (classic 3-neighbor rule): for each face vertex, look at the
//   two cells beside it and the one diagonal to it in the layer in front of the
//   face. Only opaque blocks occlude (leaves, glass and water don't).
//   level = (side1 && side2) ? 0 : 3 - (side1 + side2 + corner).
// - Each quad is split along the diagonal that avoids the anisotropy artifact:
//   0-2 normally, 1-3 when level0 + level2 > level1 + level3. Both splits wind
//   counter-clockwise from outside.
// - Faces: block A draws its face toward neighbor N when N is AIR, or N is
//   transparent and N !== A (water-water, glass-glass, leaves-leaves are culled).
//   WATER faces go to `water`, everything else (opaque, leaves, glass) to `solid`.

import { CHUNK_SIZE, WORLD_HEIGHT, AO_FACTORS } from '../config.js';
import { B, BLOCKS, isTransparent } from '../blocks.js';
import { tileUVInto } from './tiles.js';

const CS = CHUNK_SIZE;
const WH = WORLD_HEIGHT;

// ---------------------------------------------------------------------------
// Padded block copy: the chunk plus a 1-block border on every side (y = -1 and
// y = WORLD_HEIGHT are always AIR). y is the innermost axis:
//   pad index = (pz * PX + px) * PY + py,  px = lx + 1, py = y + 1, pz = lz + 1
// so the neighbor in direction (dx, dy, dz) is at i + dx*SX + dy*SY + dz*SZ.
// The corner columns hold the diagonal neighbors that ambient occlusion samples.
// A diagonal neighbor chunk that isn't loaded reads as AIR (no occlusion); World
// meshes only once the 4 edge neighbors exist, and an edit at a chunk corner
// also dirties the diagonal neighbor, so this only affects the outermost ring.
// ---------------------------------------------------------------------------
const PX = CS + 2;
const PY = WH + 2;
const PZ = CS + 2;
const SX = PY;
const SY = 1;
const SZ = PY * PX;
const pad = new Uint8Array(PX * PY * PZ);

// ---------------------------------------------------------------------------
// Face tables. Direction order: 0 +X east, 1 -X west, 2 +Y top, 3 -Y bottom,
// 4 +Z south, 5 -Z north.
// ---------------------------------------------------------------------------
const FACE_NEIGHBOR = Int32Array.of(SX, -SX, SY, -SY, SZ, -SZ);
const FACE_SHADE = Float32Array.of(0.65, 0.65, 1.0, 0.5, 0.8, 0.8);

// Corner offsets (x, y, z) within the unit block, 4 per face in the order
// bottom-left, bottom-right, top-right, top-left as seen from outside.
// prettier-ignore
const FACE_CORNERS = Int8Array.of(
  1, 0, 1,  1, 0, 0,  1, 1, 0,  1, 1, 1, // +X: right = -Z
  0, 0, 0,  0, 0, 1,  0, 1, 1,  0, 1, 0, // -X: right = +Z
  0, 1, 1,  1, 1, 1,  1, 1, 0,  0, 1, 0, // +Y: right = +X, up = -Z
  1, 0, 1,  0, 0, 1,  0, 0, 0,  1, 0, 0, // -Y: right = -X, up = -Z
  0, 0, 1,  1, 0, 1,  1, 1, 1,  0, 1, 1, // +Z: right = +X
  1, 0, 0,  0, 0, 0,  0, 1, 0,  1, 1, 0, // -Z: right = -X
);

// Ambient occlusion sample offsets in `pad`, relative to the block's own index:
// 3 per corner (side1, side2, diagonal), 4 corners per face, in FACE_CORNERS order.
// All three cells lie in the layer in front of the face; along each of the face's
// two tangent axes the corner at coordinate 0 looks toward -1, at 1 toward +1.
const AO_OFFSET = new Int32Array(6 * 4 * 3);
{
  const stride = [SX, SY, SZ];
  for (let d = 0; d < 6; d++) {
    const axis = d >> 1; // 0 x, 1 y, 2 z
    const t1 = (axis + 1) % 3;
    const t2 = (axis + 2) % 3;
    for (let k = 0; k < 4; k++) {
      const c = (d * 4 + k) * 3;
      const s1 = (FACE_CORNERS[c + t1] ? 1 : -1) * stride[t1];
      const s2 = (FACE_CORNERS[c + t2] ? 1 : -1) * stride[t2];
      const o = (d * 4 + k) * 3;
      AO_OFFSET[o] = FACE_NEIGHBOR[d] + s1;
      AO_OFFSET[o + 1] = FACE_NEIGHBOR[d] + s2;
      AO_OFFSET[o + 2] = FACE_NEIGHBOR[d] + s1 + s2;
    }
  }
}
const AO_FACTOR = Float32Array.from(AO_FACTORS); // AO level 0..3 -> brightness factor

// Per-id lookups, built once from the registry. Unknown ids behave like air:
// they make no faces and neighbors draw their faces toward them.
const MESHED = new Uint8Array(256); // 1 = this id makes faces
const SEE_THROUGH = new Uint8Array(256); // 1 = transparent (air, water, glass, leaves, unknown)
const OCCLUDES = new Uint8Array(256); // 1 = casts ambient occlusion (opaque blocks only)
const FACE_UV = new Float32Array(256 * 6 * 4); // [id][dir] -> u0, v0, u1, v1
{
  const rect = { u0: 0, v0: 0, u1: 0, v1: 0 };
  for (let id = 0; id < 256; id++) {
    SEE_THROUGH[id] = isTransparent(id) ? 1 : 0;
    OCCLUDES[id] = 1 - SEE_THROUGH[id];
  }
  for (const def of BLOCKS) {
    if (def.id === B.AIR) continue;
    MESHED[def.id] = 1;
    for (let d = 0; d < 6; d++) {
      const tile = d === 2 ? def.tiles.top : d === 3 ? def.tiles.bottom : def.tiles.side;
      tileUVInto(tile, rect);
      const o = (def.id * 6 + d) * 4;
      FACE_UV[o] = rect.u0;
      FACE_UV[o + 1] = rect.v0;
      FACE_UV[o + 2] = rect.u1;
      FACE_UV[o + 3] = rect.v1;
    }
  }
}

// ---------------------------------------------------------------------------
// Reusable, growable output scratch (one per group). Steady-state meshing
// allocates only the trimmed copies returned to the caller. Not re-entrant,
// which is fine: meshing is synchronous and each Worker gets its own module.
// ---------------------------------------------------------------------------
function createScratch(faceCap) {
  return {
    faces: 0,
    cap: faceCap,
    pos: new Float32Array(faceCap * 12),
    uv: new Float32Array(faceCap * 8),
    col: new Float32Array(faceCap * 12),
    idx: new Uint32Array(faceCap * 6),
  };
}

function grow(s) {
  const cap = s.cap * 2;
  const pos = new Float32Array(cap * 12);
  const uv = new Float32Array(cap * 8);
  const col = new Float32Array(cap * 12);
  const idx = new Uint32Array(cap * 6);
  pos.set(s.pos);
  uv.set(s.uv);
  col.set(s.col);
  idx.set(s.idx);
  s.pos = pos;
  s.uv = uv;
  s.col = col;
  s.idx = idx;
  s.cap = cap;
}

const solidScratch = createScratch(4096);
const waterScratch = createScratch(1024);

/**
 * Write the 6 indices of quad `v..v+3` at `o`. Both diagonals keep the
 * counter-clockwise winding: flip = false splits along 0-2, flip = true along 1-3.
 * emitFace picks `flip` from the corner AO levels to avoid the anisotropy artifact.
 */
function writeQuadIndices(idx, o, v, flip) {
  if (flip) {
    idx[o] = v + 1; idx[o + 1] = v + 2; idx[o + 2] = v + 3;
    idx[o + 3] = v + 1; idx[o + 4] = v + 3; idx[o + 5] = v;
  } else {
    idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
    idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
  }
}

/**
 * AO level 0..3 of one face corner: block at pad index `i`, corner samples at AO_OFFSET[a..a+2].
 * 3 = open, 0 = both side cells occlude (the corner cell can't be seen then, so it doesn't count).
 */
function aoLevel(i, a) {
  const s1 = OCCLUDES[pad[i + AO_OFFSET[a]]];
  const s2 = OCCLUDES[pad[i + AO_OFFSET[a + 1]]];
  if (s1 === 1 && s2 === 1) return 0;
  return 3 - s1 - s2 - OCCLUDES[pad[i + AO_OFFSET[a + 2]]];
}

/**
 * Append one face of block `id` at chunk-local (x, y, z) facing direction `d`.
 * `i` is the block's index in `pad`, for sampling neighbors (ambient occlusion).
 */
function emitFace(s, d, id, x, y, z, i) {
  if (s.faces === s.cap) grow(s);
  const f = s.faces++;

  // Positions.
  const pos = s.pos;
  let p = f * 12;
  let c = d * 12;
  for (let k = 0; k < 4; k++, p += 3, c += 3) {
    pos[p] = x + FACE_CORNERS[c];
    pos[p + 1] = y + FACE_CORNERS[c + 1];
    pos[p + 2] = z + FACE_CORNERS[c + 2];
  }

  // UVs: bottom-left (u0,v0), bottom-right (u1,v0), top-right (u1,v1), top-left (u0,v1).
  const t = (id * 6 + d) * 4;
  const u0 = FACE_UV[t];
  const v0 = FACE_UV[t + 1];
  const u1 = FACE_UV[t + 2];
  const v1 = FACE_UV[t + 3];
  const uv = s.uv;
  const q = f * 8;
  uv[q] = u0; uv[q + 1] = v0;
  uv[q + 2] = u1; uv[q + 3] = v0;
  uv[q + 4] = u1; uv[q + 5] = v1;
  uv[q + 6] = u0; uv[q + 7] = v1;

  // Colors: face shade times a per-corner ambient occlusion factor (water: none).
  const shade = FACE_SHADE[d];
  let c0 = shade;
  let c1 = shade;
  let c2 = shade;
  let c3 = shade;
  let flip = false;
  if (id !== B.WATER) {
    const a = d * 12; // AO_OFFSET base for this face
    const l0 = aoLevel(i, a);
    const l1 = aoLevel(i, a + 3);
    const l2 = aoLevel(i, a + 6);
    const l3 = aoLevel(i, a + 9);
    c0 *= AO_FACTOR[l0];
    c1 *= AO_FACTOR[l1];
    c2 *= AO_FACTOR[l2];
    c3 *= AO_FACTOR[l3];
    flip = l0 + l2 > l1 + l3;
  }
  const col = s.col;
  const o = f * 12;
  col[o] = c0; col[o + 1] = c0; col[o + 2] = c0;
  col[o + 3] = c1; col[o + 4] = c1; col[o + 5] = c1;
  col[o + 6] = c2; col[o + 7] = c2; col[o + 8] = c2;
  col[o + 9] = c3; col[o + 10] = c3; col[o + 11] = c3;

  writeQuadIndices(s.idx, f * 6, f * 4, flip);
}

/**
 * Trimmed copies of a scratch group; indices are Uint16 when every index fits. These copies are
 * the only allocations of a steady-state meshing call (they are handed over to three.js).
 */
function finish(s) {
  const nv = s.faces * 4;
  const ni = s.faces * 6;
  let indices;
  if (nv <= 65535) {
    indices = new Uint16Array(ni);
    const src = s.idx;
    for (let k = 0; k < ni; k++) indices[k] = src[k];
  } else {
    indices = s.idx.slice(0, ni);
  }
  return {
    positions: s.pos.slice(0, nv * 3),
    uvs: s.uv.slice(0, nv * 2),
    colors: s.col.slice(0, nv * 3),
    indices,
  };
}

/** Copy chunk (cx, cz) plus a 1-block border into `pad`, one getBlock call per in-range cell. */
function fillPadded(getBlock, cx, cz) {
  const wx0 = cx * CS - 1;
  const wz0 = cz * CS - 1;
  for (let pz = 0; pz < PZ; pz++) {
    const wz = wz0 + pz;
    for (let px = 0; px < PX; px++) {
      const wx = wx0 + px;
      const base = (pz * PX + px) * PY;
      pad[base] = B.AIR; // y = -1
      for (let y = 0; y < WH; y++) pad[base + 1 + y] = getBlock(wx, y, wz);
      pad[base + PY - 1] = B.AIR; // y = WORLD_HEIGHT
    }
  }
}

/**
 * @typedef {Object} GeometryGroup
 * @property {Float32Array} positions xyz per vertex, chunk-local
 * @property {Float32Array} uvs uv per vertex (atlas coordinates)
 * @property {Float32Array} colors rgb per vertex (gray: face shade times AO factor, sRGB values)
 * @property {Uint16Array|Uint32Array} indices 6 per face; Uint16Array when vertexCount <= 65535
 */

/**
 * Build the geometry of chunk (cx, cz).
 *
 * @param {(x: number, y: number, z: number) => number} getBlock block id at integer WORLD
 *   coordinates. Called exactly once per cell of the chunk plus a 1-block border, only with
 *   y in 0..WORLD_HEIGHT-1; it should return AIR for unloaded chunks.
 * @param {number} cx chunk x
 * @param {number} cz chunk z
 * @returns {{ solid: GeometryGroup, water: GeometryGroup }} fresh arrays owned by the caller;
 *   empty groups have zero-length arrays. Positions are chunk-local (see the header comment).
 */
export function buildChunkGeometry(getBlock, cx, cz) {
  fillPadded(getBlock, cx, cz);
  const solid = solidScratch;
  const water = waterScratch;
  solid.faces = 0;
  water.faces = 0;

  for (let z = 0; z < CS; z++) {
    for (let x = 0; x < CS; x++) {
      let i = ((z + 1) * PX + (x + 1)) * PY + 1; // pad index of (x, 0, z)
      for (let y = 0; y < WH; y++, i++) {
        const id = pad[i];
        if (MESHED[id] === 0) continue;
        const s = id === B.WATER ? water : solid;
        for (let d = 0; d < 6; d++) {
          const n = pad[i + FACE_NEIGHBOR[d]];
          // AIR is transparent and never equal to a meshed id, so this is exactly
          // "N is AIR, or N is transparent and N !== A".
          if (SEE_THROUGH[n] === 1 && n !== id) emitFace(s, d, id, x, y, z, i);
        }
      }
    }
  }

  return { solid: finish(solid), water: finish(water) };
}
