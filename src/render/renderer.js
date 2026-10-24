// three.js renderer, scene, camera and window resize (PROJECT.md Task 6).
//
// The scene starts with a plain day-sky background and distance fog scaled to the
// render distance. The sky module (Task 9) updates scene.background and scene.fog
// colors each frame; it should mutate them (Color.copy / lerp), not replace them.

import * as THREE from 'three';
import {
  FOV, RENDER_DISTANCE, CHUNK_SIZE, MAX_PIXEL_RATIO, CAMERA_NEAR,
  DAY_SKY_COLOR, FOG_NEAR_FACTOR, FOG_FAR_FACTOR,
} from '../config.js';

// Render-side defaults; the sky module owns colors from Task 9 on. Tuning lives in config.js.
const VIEW_RADIUS = RENDER_DISTANCE * CHUNK_SIZE; // blocks
const FOG_NEAR = VIEW_RADIUS * FOG_NEAR_FACTOR;
const FOG_FAR = VIEW_RADIUS * FOG_FAR_FACTOR;
// Meshed chunks reach about (RENDER_DISTANCE + 1) chunks away horizontally, more along a
// diagonal and with world height on top; 2x the padded radius leaves room for sun/moon quads.
const CAMERA_FAR = (RENDER_DISTANCE + 2) * CHUNK_SIZE * 2;

/**
 * Create the WebGL renderer, scene and first-person camera, and keep them sized to the window.
 *
 * @param {HTMLElement} container element the canvas is appended to
 * @returns {{
 *   renderer: THREE.WebGLRenderer,
 *   scene: THREE.Scene,
 *   camera: THREE.PerspectiveCamera,
 *   resize: () => void,
 *   dispose: () => void,
 * }} resize() re-applies size and pixel ratio (called automatically on window resize);
 *   dispose() removes the resize listener and disposes the renderer.
 */
export function createRenderer(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(DAY_SKY_COLOR);
  scene.fog = new THREE.Fog(DAY_SKY_COLOR, FOG_NEAR, FOG_FAR);

  const camera = new THREE.PerspectiveCamera(FOV, 1, CAMERA_NEAR, CAMERA_FAR);
  camera.rotation.order = 'YXZ'; // yaw about Y first, then pitch about X (PROJECT.md section 10)

  function resize() {
    const width = container.clientWidth || window.innerWidth;
    const height = container.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO));
    renderer.setSize(width, height);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  resize();
  window.addEventListener('resize', resize);

  function dispose() {
    window.removeEventListener('resize', resize);
    renderer.dispose();
  }

  return { renderer, scene, camera, resize, dispose };
}
