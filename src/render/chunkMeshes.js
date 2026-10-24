// Chunk meshes (PROJECT.md Task 5): turns buildChunkGeometry output (render/mesher.js)
// into three.js meshes, keeps one solid + one water mesh per chunk key, and disposes
// geometry when a chunk is replaced or removed.
//
// Color management: three treats vertex colors as linear while the atlas texture is
// sRGB, so the mesher's gray shading values (spec values, e.g. 0.5 for bottom faces)
// would come out much brighter on screen. setChunk converts them from sRGB to linear
// on upload, so the on-screen face shading matches the spec values. Material
// brightness goes through Color.setRGB(..., SRGBColorSpace) for the same reason.

import * as THREE from 'three';
import { CHUNK_SIZE } from '../config.js';

const _color = new THREE.Color();

/** New Float32Array with each value converted sRGB -> linear (three's working space). */
function colorsToLinear(src) {
  const out = new Float32Array(src.length);
  let lastIn = NaN;
  let lastOut = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== lastIn) {
      // Faces repeat the same few gray levels, so a one-entry memo skips most conversions.
      lastIn = c;
      lastOut = _color.setRGB(c, c, c, THREE.SRGBColorSpace).r;
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

  /** @type {Map<string, { solid: THREE.Mesh|null, water: THREE.Mesh|null, triangles: number }>} */
  const entries = new Map();
  let triangles = 0;

  function buildMesh(group, material, cx, cz) {
    if (!group || group.indices.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(group.positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(group.uvs, 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(colorsToLinear(group.colors), 3));
    geometry.setIndex(new THREE.BufferAttribute(group.indices, 1));
    geometry.computeBoundingSphere();
    geometry.computeBoundingBox();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(cx * CHUNK_SIZE, 0, cz * CHUNK_SIZE);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    scene.add(mesh);
    return mesh;
  }

  function dropMesh(mesh) {
    if (mesh === null) return;
    scene.remove(mesh);
    mesh.geometry.dispose();
  }

  /**
   * Show the geometry for chunk `key`, replacing (and disposing) any meshes it had.
   * The typed arrays in `data` are handed to three.js; don't modify them afterwards.
   * Empty groups get no mesh. After this call has(key) is true even if both groups were empty.
   * @param {string} key chunk key `${cx},${cz}`
   * @param {number} cx
   * @param {number} cz
   * @param {{ solid: object, water: object }} data buildChunkGeometry(...) output
   */
  function setChunk(key, cx, cz, data) {
    removeChunk(key);
    const solid = buildMesh(data.solid, solidMaterial, cx, cz);
    const water = buildMesh(data.water, waterMaterial, cx, cz);
    if (water !== null) water.renderOrder = 1; // after solid geometry
    const tris = (data.solid.indices.length + data.water.indices.length) / 3;
    entries.set(key, { solid, water, triangles: tris });
    triangles += tris;
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
