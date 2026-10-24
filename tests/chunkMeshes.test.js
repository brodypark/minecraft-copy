import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createChunkMeshes } from '../src/render/chunkMeshes.js';
import { buildChunkGeometry } from '../src/render/mesher.js';
import { B } from '../src/blocks.js';

// One stone block at the origin of every chunk, so each chunk gets a solid mesh.
const getBlock = (x, y, z) => (((x % 16) + 16) % 16 === 0 && ((z % 16) + 16) % 16 === 0 && y === 10 ? B.STONE : B.AIR);

function meshesOf(scene) {
  return scene.children.filter((o) => o.isMesh);
}

describe('chunkMeshes render radius', () => {
  it('hides meshes of chunks beyond the visible radius and shows them again when back in range', () => {
    const scene = new THREE.Scene();
    const cm = createChunkMeshes(scene, new THREE.Texture());
    for (let cx = -8; cx <= 8; cx += 4) cm.setChunk(`${cx},0`, cx, 0, buildChunkGeometry(getBlock, cx, 0));
    cm.setVisibleRadius(0, 0, 6);
    const visibleX = meshesOf(scene).filter((m) => m.visible).map((m) => m.position.x / 16).sort((a, b) => a - b);
    expect(visibleX).toEqual([-4, 0, 4]);
    cm.setVisibleRadius(8, 0, 6);
    const visibleX2 = meshesOf(scene).filter((m) => m.visible).map((m) => m.position.x / 16).sort((a, b) => a - b);
    expect(visibleX2).toEqual([4, 8]);
  });

  it('applies the current radius to chunks meshed later', () => {
    const scene = new THREE.Scene();
    const cm = createChunkMeshes(scene, new THREE.Texture());
    cm.setVisibleRadius(0, 0, 6);
    cm.setChunk('7,0', 7, 0, buildChunkGeometry(getBlock, 7, 0));
    cm.setChunk('2,2', 2, 2, buildChunkGeometry(getBlock, 2, 2));
    const byX = Object.fromEntries(meshesOf(scene).map((m) => [m.position.x / 16, m.visible]));
    expect(byX[7]).toBe(false);
    expect(byX[2]).toBe(true);
  });
});
