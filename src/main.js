// Boot + game loop. Task 5 manager wiring: a static terrain patch viewed from above
// (temporary; Task 6 replaces this with the real player and streaming loop).
import * as THREE from 'three';
import './ui/style.css';
import { FOV, CHUNK_SIZE, GEN_DISTANCE, SEA_LEVEL } from './config.js';
import { createAtlas } from './render/atlas.js';
import { buildChunkGeometry } from './render/mesher.js';
import { createChunkMeshes } from './render/chunkMeshes.js';
import { World } from './world/world.js';

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87b8ff);
scene.fog = new THREE.Fog(0x87b8ff, 60, 110);
const camera = new THREE.PerspectiveCamera(FOV, window.innerWidth / window.innerHeight, 0.1, 1000);

const world = new World(1337);
const { texture } = createAtlas();
const chunkMeshes = createChunkMeshes(scene, texture);
world.generateAround(0, 0, GEN_DISTANCE);
const getBlock = world.getBlock.bind(world);
for (const chunk of world.consumeDirtyChunks()) {
  chunkMeshes.setChunk(chunk.key, chunk.cx, chunk.cz, buildChunkGeometry(getBlock, chunk.cx, chunk.cz));
}
camera.position.set(-40, SEA_LEVEL + 40, -40);
camera.lookAt(CHUNK_SIZE / 2, SEA_LEVEL, CHUNK_SIZE / 2);
window.__debug = { world, chunkMeshes, renderer, camera };

window.addEventListener('resize', () => {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

renderer.setAnimationLoop(() => renderer.render(scene, camera));
