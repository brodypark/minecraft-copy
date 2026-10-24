// Target outline: a dark wireframe cube around the targeted block (PROJECT.md section 7 Interaction).
//
// Usage: const outline = createTargetOutline(scene); then each frame outline.update(hit) with the
// raycast result (or null). update() allocates nothing.

import * as THREE from 'three';
import { OUTLINE_SIZE, OUTLINE_COLOR, OUTLINE_OPACITY } from '../config.js';

/**
 * Create the outline, add it to the scene (hidden until something is targeted).
 *
 * @param {THREE.Object3D} scene
 * @returns {{
 *   object: THREE.LineSegments,
 *   update: (hit: { x: number, y: number, z: number } | null) => void,
 *   dispose: () => void,
 * }} update(hit) shows the outline around block (x, y, z), or hides it for null;
 *   dispose() removes it from the scene and frees its geometry and material.
 */
export function createTargetOutline(scene) {
  const box = new THREE.BoxGeometry(OUTLINE_SIZE, OUTLINE_SIZE, OUTLINE_SIZE);
  const geometry = new THREE.EdgesGeometry(box);
  box.dispose();
  const material = new THREE.LineBasicMaterial({
    color: OUTLINE_COLOR,
    transparent: true,
    opacity: OUTLINE_OPACITY,
  });
  const object = new THREE.LineSegments(geometry, material);
  object.name = 'targetOutline';
  object.visible = false;
  scene.add(object);

  function update(hit) {
    if (hit) {
      object.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);
      object.visible = true;
    } else {
      object.visible = false;
    }
  }

  function dispose() {
    scene.remove(object);
    geometry.dispose();
    material.dispose();
  }

  return { object, update, dispose };
}
