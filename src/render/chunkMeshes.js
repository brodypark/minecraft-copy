// Chunk meshes (PROJECT.md Task 5): turns buildChunkGeometry output (render/mesher.js)
// into three.js meshes, keeps one solid + one water mesh per chunk key, and disposes
// geometry when a chunk is replaced or removed.
//
// Allocation policy: a remesh necessarily creates one BufferGeometry (plus its attributes and
// bounds) per non-empty group and disposes the one it replaces. Everything else is reused: a
// chunk keeps its Mesh objects and its bookkeeping entry across remeshes, and the sRGB -> linear
// conversion goes through a fixed-size cache instead of allocating.
//
// Color management: three treats vertex colors as linear while the atlas texture is
// sRGB, so the mesher's gray shading values (spec values, e.g. 0.5 for bottom faces)
// would come out much brighter on screen. setChunk converts them from sRGB to linear
// on upload, so the on-screen face shading matches the spec values. Material
// brightness goes through Color.setRGB(..., SRGBColorSpace) for the same reason.

import * as THREE from 'three';
import { CHUNK_SIZE } from '../config.js';

const _color = new THREE.Color();

// sRGB -> linear cache. The mesher emits only a few dozen distinct gray levels (face shade times
// AO factor), so each value is converted once and then looked up. Slots are picked by quantizing
// the value; a slot keeps the exact float32 input it was computed for, so the result is always
// exact (a collision just recomputes and takes over the slot). Module-level and fixed-size, so a
// remesh allocates nothing here besides the output array three.js needs.
const LUT_SIZE = 1024;
const lutIn = new Float32Array(LUT_SIZE).fill(NaN); // NaN never equals an input, so empty slots miss
const lutOut = new Float32Array(LUT_SIZE);

function srgbToLinearCached(c) {
  let slot = (c * (LUT_SIZE - 1) + 0.5) | 0;
  if (slot < 0) slot = 0;
  else if (slot >= LUT_SIZE) slot = LUT_SIZE - 1;
  if (lutIn[slot] === c) return lutOut[slot];
  const out = _color.setRGB(c, c, c, THREE.SRGBColorSpace).r;
  lutIn[slot] = c;
  lutOut[slot] = out;
  return out;
}

/** New Float32Array with each value converted sRGB -> linear (three's working space). */
function colorsToLinear(src) {
  const out = new Float32Array(src.length);
  let lastIn = NaN;
  let lastOut = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== lastIn) {
      // r = g = b per vertex, so a one-entry memo skips two of every three lookups.
      lastIn = c;
      lastOut = srgbToLinearCached(c);
    }
    out[i] = lastOut;
  }
  return out;
}

/**
 * Create the chunk mesh manager.
 *
 * @param {THREE.Scene|THREE.Object3D} scene parent the meshes are added to
 * @param {THREE.Texture} texture atlas texture (not disposed by this module)
 */
export function createChunkMeshes(scene, texture) {
  const solidMaterial = new THREE.MeshBasicMaterial({ map: texture, vertexColors: true, alphaTest: 0.5 });
  const waterMaterial = new THREE.MeshBasicMaterial({
    map: texture,
    vertexColors: true,
    transparent: true,
    opacity: 0.7,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  /** @type {Map<string, { cx: number, cz: number, solid: THREE.Mesh|null, water: THREE.Mesh|null, triangles: number }>} */
  const entries = new Map();
  let triangles = 0;

  /** New geometry for a non-empty mesher group (chunk-local positions, cull-ready bounds). */
  function buildGeometry(group) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(group.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(group.uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(colorsToLinear(group.colors), 3));
    geometry.setIndex(new THREE.BufferAttribute(group.indices, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return geometry;
  }

  /**
   * Point `mesh` (or null) at `group`'s geometry and return the mesh to keep: the old geometry is
   * disposed, an existing mesh is reused, a mesh is created only when needed, and an empty group
   * removes the mesh from the scene.
   */
  function updateMesh(mesh, group, material, cx, cz) {
    const empty = !group || group.indices.length === 0;
    if (mesh !== null) {
      mesh.geometry.dispose();
      if (empty) {
        scene.remove(mesh);
        return null;
      }
      mesh.geometry = buildGeometry(group);
      return mesh;
    }
    if (empty) return null;
    const created = new THREE.Mesh(buildGeometry(group), material);
    created.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    created.matrixAutoUpdate = false;
    created.updateMatrix();
    if (material === waterMaterial) created.renderOrder = 1; // after solid geometry
    scene.add(created);
    return created;
  }

  function dropMesh(mesh) {
    if (mesh === null) return;
    scene.remove(mesh);
    mesh.geometry.dispose();
  }

  /**
   * Show the geometry for chunk `key`, replacing (and disposing) any geometry it had.
   * The typed arrays in `data` are handed to three.js; don't modify them afterwards.
   * Empty groups get no mesh. After this call has(key) is true even if both groups were empty.
   * @param {string} key chunk key `${cx},${cz}`
   * @param {number} cx
   * @param {number} cz
   * @param {{ solid: object, water: object }} data buildChunkGeometry(...) output
   */
  function setChunk(key, cx, cz, data) {
    let entry = entries.get(key);
    if (entry !== undefined && (entry.cx !== cx || entry.cz !== cz)) {
      removeChunk(key); // same key, different position: start over
      entry = undefined;
    }
    if (entry === undefined) {
      entry = { cx, cz, solid: null, water: null, triangles: 0 };
      entries.set(key, entry);
    }
    entry.solid = updateMesh(entry.solid, data.solid, solidMaterial, cx, cz);
    entry.water = updateMesh(entry.water, data.water, waterMaterial, cx, cz);
    const tris = (data.solid.indices.length + data.water.indices.length) / 3;
    triangles += tris - entry.triangles;
    entry.triangles = tris;
  }

  /**
   * Remove chunk `key`'s meshes from the scene and dispose their geometry. Unknown keys are a no-op.
   * @param {string} key
   */
  function removeChunk(key) {
    const entry = entries.get(key);
    if (entry === undefined) return;
    dropMesh(entry.solid);
    dropMesh(entry.water);
    triangles -= entry.triangles;
    entries.delete(key);
  }

  /**
   * Global light level multiplied into the vertex colors: 0.25 (night) to 1.0 (noon).
   * Interpreted as an sRGB gray so it reads perceptually.
   * @param {number} b
   */
  function setBrightness(b) {
    solidMaterial.color.setRGB(b, b, b, THREE.SRGBColorSpace);
    waterMaterial.color.setRGB(b, b, b, THREE.SRGBColorSpace);
  }

  /** Remove every chunk mesh and dispose all geometries and both materials (not the texture). */
  function dispose() {
    for (const key of [...entries.keys()]) removeChunk(key);
    triangles = 0;
    solidMaterial.dispose();
    waterMaterial.dispose();
  }

  return {
    solidMaterial,
    waterMaterial,
    setChunk,
    removeChunk,
    setBrightness,
    dispose,
    /** @param {string} key @returns {boolean} true once setChunk ran for key (until removeChunk) */
    has: (key) => entries.has(key),
    /** @returns {number} chunks with geometry set */
    chunkCount: () => entries.size,
    /** @returns {number} triangles across all chunk meshes (tracked incrementally) */
    triangleCount: () => triangles,
  };
}
