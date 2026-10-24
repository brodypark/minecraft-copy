// Sky, day/night, fog and underwater look (PROJECT.md section 7 "Day/night", Task 9).
//
// Time convention (shared with main.js and the HUD): timeOfDay t is in [0, 1),
// 0 = midnight, 0.25 = sunrise, 0.5 = noon, 0.75 = sunset.
//
// The curves are pure functions of t (no DOM, no WebGL) so they can be unit tested in node:
//   sunElevation(t)  sin(2*pi*(t - 0.25)): -1 at midnight, 0 at sunrise/sunset, 1 at noon
//   daylightAt(t)    0 (night) .. 1 (day), a smoothstep of the sun elevation
//   brightnessAt(t)  chunk material gray level, NIGHT_BRIGHTNESS .. DAY_BRIGHTNESS
//   skyColorAt(t)    night blue -> day blue, with an orange-pink tint while the sun is near the horizon
//   sunDirection(t)  unit vector; rises in the east (+X), sets in the west (-X); the moon is opposite
//
// createSky(scene) drives the scene: background and fog color, fog distances, sun and moon
// quads, stars, and the underwater look. It mutates scene.background (a THREE.Color) and
// scene.fog (a THREE.Fog) in place and allocates nothing per frame.

import * as THREE from 'three';
import alea from 'alea';
import {
  CHUNK_SIZE, RENDER_DISTANCE, FOG_NEAR_FACTOR, FOG_FAR_FACTOR,
  DAY_SKY_COLOR, NIGHT_SKY_COLOR, SUNSET_SKY_COLOR, SUNSET_TINT_STRENGTH, SUNSET_TINT_WIDTH,
  NIGHT_BRIGHTNESS, DAY_BRIGHTNESS, LIGHT_RAMP_LOW, LIGHT_RAMP_HIGH,
  SUN_ORBIT_TILT, SUN_DISTANCE, SUN_SIZE, MOON_SIZE, SKY_BODY_FADE_HIGH, SKY_BODY_FADE_LOW,
  STAR_COUNT, STAR_DISTANCE, STAR_SIZE, STAR_MAX_OPACITY, STAR_FADE_LOW, STAR_FADE_HIGH,
  UNDERWATER_FOG_COLOR, UNDERWATER_FOG_NEAR, UNDERWATER_FOG_FAR, DAY_START_TIME,
} from '../config.js';

const TAU = Math.PI * 2;
const COS_TILT = Math.cos(SUN_ORBIT_TILT);
const SIN_TILT = Math.sin(SUN_ORBIT_TILT);

const VIEW_RADIUS = RENDER_DISTANCE * CHUNK_SIZE; // blocks
const FOG_NEAR = VIEW_RADIUS * FOG_NEAR_FACTOR;
const FOG_FAR = VIEW_RADIUS * FOG_FAR_FACTOR;

/** 0xRRGGBB -> { r, g, b } in 0..1 (sRGB). */
function hexToRgb(hex) {
  return { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255 };
}

const DAY_RGB = hexToRgb(DAY_SKY_COLOR);
const NIGHT_RGB = hexToRgb(NIGHT_SKY_COLOR);
const SUNSET_RGB = hexToRgb(SUNSET_SKY_COLOR);
const UNDERWATER_RGB = hexToRgb(UNDERWATER_FOG_COLOR);

function smoothstep(edge0, edge1, x) {
  let k = (x - edge0) / (edge1 - edge0);
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  return k * k * (3 - 2 * k);
}

/** Wrap any finite t into [0, 1); non-finite input falls back to DAY_START_TIME. */
function wrapTime(t) {
  if (!Number.isFinite(t)) return DAY_START_TIME;
  return t - Math.floor(t);
}

// ---------------------------------------------------------------------------
// Pure curves
// ---------------------------------------------------------------------------

/**
 * Height of the sun on its (untilted) orbit: -1 at midnight, 0 at sunrise and sunset, 1 at noon.
 * @param {number} t time of day in [0, 1)
 * @returns {number}
 */
export function sunElevation(t) {
  return Math.sin(TAU * (t - 0.25));
}

/**
 * Daylight factor: 0 through the night, 1 in full day, smooth through dawn and dusk.
 * @param {number} t time of day in [0, 1)
 * @returns {number} 0..1
 */
export function daylightAt(t) {
  return smoothstep(LIGHT_RAMP_LOW, LIGHT_RAMP_HIGH, sunElevation(t));
}

/**
 * Global light level for chunk materials (chunkMeshes.setBrightness):
 * 1.0 around noon, 0.25 through the deep night, continuous and periodic.
 * @param {number} t time of day in [0, 1)
 * @returns {number} NIGHT_BRIGHTNESS (0.25) .. DAY_BRIGHTNESS (1.0)
 */
export function brightnessAt(t) {
  return NIGHT_BRIGHTNESS + (DAY_BRIGHTNESS - NIGHT_BRIGHTNESS) * daylightAt(t);
}

/**
 * Sky (and fog) color at time t, as sRGB components in 0..1: night blue -> day blue,
 * blended toward an orange-pink tint while the sun is near the horizon. Continuous and periodic.
 * @param {number} t time of day in [0, 1)
 * @param {{ r: number, g: number, b: number }} [out] written and returned (a THREE.Color works too)
 * @returns {{ r: number, g: number, b: number }} out
 */
export function skyColorAt(t, out = { r: 0, g: 0, b: 0 }) {
  const e = sunElevation(t);
  const d = smoothstep(LIGHT_RAMP_LOW, LIGHT_RAMP_HIGH, e);
  let r = NIGHT_RGB.r + (DAY_RGB.r - NIGHT_RGB.r) * d;
  let g = NIGHT_RGB.g + (DAY_RGB.g - NIGHT_RGB.g) * d;
  let b = NIGHT_RGB.b + (DAY_RGB.b - NIGHT_RGB.b) * d;
  const s = SUNSET_TINT_STRENGTH * (1 - smoothstep(0, SUNSET_TINT_WIDTH, Math.abs(e)));
  r += (SUNSET_RGB.r - r) * s;
  g += (SUNSET_RGB.g - g) * s;
  b += (SUNSET_RGB.b - b) * s;
  out.r = r;
  out.g = g;
  out.b = b;
  return out;
}

/**
 * Unit vector from the viewer toward the sun. The sun rises in the east (+X) at 0.25, is
 * near the zenith at 0.5 (the orbit leans SUN_ORBIT_TILT toward +Z), sets in the west (-X)
 * at 0.75 and is below the horizon (y < 0) at night. The moon direction is the negation.
 * @param {number} t time of day in [0, 1)
 * @param {{ x: number, y: number, z: number }} [out] written and returned (a THREE.Vector3 works too)
 * @returns {{ x: number, y: number, z: number }} out
 */
export function sunDirection(t, out = { x: 0, y: 0, z: 0 }) {
  const a = TAU * (t - 0.25);
  const s = Math.sin(a);
  out.x = Math.cos(a);
  out.y = s * COS_TILT;
  out.z = s * SIN_TILT;
  return out;
}

// ---------------------------------------------------------------------------
// Procedural sun / moon pixels (pure; RGBA, row 0 = top)
// ---------------------------------------------------------------------------

export const SUN_TEX_SIZE = 32;
export const MOON_TEX_SIZE = 16;

/** Chebyshev (square) distance of pixel (x, y) from the center of a size x size image. */
function squareDist(x, y, size) {
  const c = size / 2;
  return Math.max(Math.abs(x + 0.5 - c), Math.abs(y + 0.5 - c));
}

/**
 * Sun: a warm white-yellow square core with a stepped, soft square glow ring around it.
 * @returns {{ data: Uint8ClampedArray, size: number }}
 */
export function paintSunPixels() {
  const size = SUN_TEX_SIZE;
  const data = new Uint8ClampedArray(size * size * 4);
  const CORE = 7; // core half-size in px (14 x 14 core)
  const GLOW = 8; // glow ring width in px
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = squareDist(x, y, size);
      if (d < CORE - 2) {
        data.set([255, 253, 232, 255], i);
      } else if (d < CORE) {
        data.set([255, 238, 168, 255], i);
      } else if (d < CORE + GLOW) {
        // Quadratic falloff quantized to 1/8 steps so the glow reads as pixel-art bands.
        const k = 1 - (d - CORE) / GLOW;
        const a = Math.round(k * k * 8) / 8;
        data.set([255, 246, 210, Math.round(a * 0.6 * 255)], i);
      }
    }
  }
  return { data, size };
}

// Crater pixels, relative to the moon body's top-left pixel (body is 10 x 10).
const CRATERS = [
  [2, 1], [3, 1], [2, 2], [3, 2], [7, 2], [6, 4], [1, 6], [2, 6], [1, 7],
  [6, 6], [7, 6], [6, 7], [7, 7], [8, 7], [4, 8], [8, 3],
];

/**
 * Moon: a pale gray square with a slightly darker rim, darker crater pixels and a faint glow.
 * @returns {{ data: Uint8ClampedArray, size: number }}
 */
export function paintMoonPixels() {
  const size = MOON_TEX_SIZE;
  const data = new Uint8ClampedArray(size * size * 4);
  const BODY = 5; // body half-size in px (10 x 10 body)
  const origin = size / 2 - BODY;
  const craters = new Set(CRATERS.map(([cx, cy]) => (cy + origin) * size + (cx + origin)));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = squareDist(x, y, size);
      if (d < BODY) {
        if (craters.has(y * size + x)) data.set([150, 156, 172, 255], i);
        else if (d > BODY - 1) data.set([196, 201, 212, 255], i);
        else data.set([222, 226, 234, 255], i);
      } else if (d < BODY + 1) {
        data.set([210, 220, 240, 64], i);
      } else if (d < BODY + 2) {
        data.set([210, 220, 240, 28], i);
      }
    }
  }
  return { data, size };
}

/**
 * Pixel-crisp sRGB texture from painted pixels: a CanvasTexture in the browser, or a
 * DataTexture when there is no DOM (node tests; never uploaded there).
 */
function makeTexture({ data, size }) {
  let texture = null;
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const image = ctx.createImageData(size, size);
      image.data.set(data);
      ctx.putImageData(image, 0, 0);
      texture = new THREE.CanvasTexture(canvas);
    }
  }
  if (texture === null) {
    texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  }
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function makeBody(pixels, size) {
  const texture = makeTexture(pixels);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    fog: false,
    depthWrite: false, // depthTest stays on, so terrain occludes it
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
  mesh.renderOrder = -1; // before water and other transparent geometry
  return mesh;
}

function makeStars() {
  const rng = alea('voxel-sandbox-stars');
  const positions = new Float32Array(STAR_COUNT * 3);
  const colors = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    // Uniform over the sky dome above y = 0.05 (y uniform on a sphere gives uniform area).
    const y = 0.05 + 0.95 * rng();
    const r = Math.sqrt(1 - y * y);
    const a = TAU * rng();
    positions[i * 3] = Math.cos(a) * r * STAR_DISTANCE;
    positions[i * 3 + 1] = y * STAR_DISTANCE;
    positions[i * 3 + 2] = Math.sin(a) * r * STAR_DISTANCE;
    const g = 0.45 + 0.55 * rng() * rng(); // mostly faint, a few bright
    colors[i * 3] = g;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = g;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  const material = new THREE.PointsMaterial({
    size: STAR_SIZE,
    sizeAttenuation: false,
    vertexColors: true,
    transparent: true,
    opacity: 0,
    fog: false,
    depthWrite: false,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = -2; // before the moon, so the moon covers stars behind it
  points.visible = false;
  return points;
}

// ---------------------------------------------------------------------------
// Scene driver
// ---------------------------------------------------------------------------

const ORIGIN = Object.freeze({ x: 0, y: 0, z: 0 });

/**
 * Create the sky: drives scene.background, scene.fog, sun/moon quads and stars.
 *
 * @param {THREE.Scene} scene should already have a THREE.Color background and a THREE.Fog
 *   (renderer.js creates both); missing ones are created once here. They are mutated in place.
 * @returns {{
 *   update: (timeOfDay: number, cameraPos: {x: number, y: number, z: number}, cameraInWater?: boolean) => void,
 *   brightness: number,
 *   dispose: () => void,
 *   sun: THREE.Mesh, moon: THREE.Mesh, stars: THREE.Points,
 * }}
 *   update() sets sky/fog color and distances, places the sun/moon/stars around cameraPos and
 *   refreshes `brightness` (pass it to chunkMeshes.setBrightness). With cameraInWater the fog
 *   turns deep blue-green and short, and the sun, moon and stars are hidden.
 *   dispose() removes the sun/moon/stars and frees their GPU resources; update() is then a no-op.
 */
export function createSky(scene) {
  if (!(scene.background && scene.background.isColor)) scene.background = new THREE.Color(DAY_SKY_COLOR);
  if (!scene.fog) scene.fog = new THREE.Fog(DAY_SKY_COLOR, FOG_NEAR, FOG_FAR);

  const sun = makeBody(paintSunPixels(), SUN_SIZE);
  const moon = makeBody(paintMoonPixels(), MOON_SIZE);
  const stars = makeStars();
  scene.add(stars, sun, moon);

  // Reused every frame (no per-frame allocations).
  const rgb = { r: 0, g: 0, b: 0 };
  const sunDir = new THREE.Vector3();
  const cam = new THREE.Vector3();
  let disposed = false;

  /** Place a sky body at cam + dir * sign * SUN_DISTANCE, facing the camera, faded near the horizon. */
  function placeBody(mesh, sign, hidden) {
    const dy = sunDir.y * sign;
    const opacity = hidden ? 0 : smoothstep(SKY_BODY_FADE_LOW, SKY_BODY_FADE_HIGH, dy);
    mesh.visible = opacity > 0.001;
    if (!mesh.visible) return;
    mesh.material.opacity = opacity;
    mesh.position.set(
      cam.x + sunDir.x * sign * SUN_DISTANCE,
      cam.y + dy * SUN_DISTANCE,
      cam.z + sunDir.z * sign * SUN_DISTANCE,
    );
    mesh.lookAt(cam); // PlaneGeometry faces +Z; lookAt turns +Z toward the camera
  }

  function update(timeOfDay, cameraPos = ORIGIN, cameraInWater = false) {
    if (disposed) return;
    const t = wrapTime(timeOfDay);
    const brightness = brightnessAt(t);
    sky.brightness = brightness;

    if (cameraInWater) {
      rgb.r = UNDERWATER_RGB.r * brightness;
      rgb.g = UNDERWATER_RGB.g * brightness;
      rgb.b = UNDERWATER_RGB.b * brightness;
    } else {
      skyColorAt(t, rgb);
    }

    const background = scene.background;
    if (background && background.isColor) background.setRGB(rgb.r, rgb.g, rgb.b, THREE.SRGBColorSpace);
    const fog = scene.fog;
    if (fog) {
      fog.color.setRGB(rgb.r, rgb.g, rgb.b, THREE.SRGBColorSpace);
      if (fog.isFog) {
        fog.near = cameraInWater ? UNDERWATER_FOG_NEAR : FOG_NEAR;
        fog.far = cameraInWater ? UNDERWATER_FOG_FAR : FOG_FAR;
      }
    }

    cam.set(cameraPos.x, cameraPos.y, cameraPos.z);
    sunDirection(t, sunDir);

    // Sun: slightly orange while low, white-yellow when high.
    const high = smoothstep(0, 0.35, sunDir.y);
    sun.material.color.setRGB(1, 0.72 + 0.28 * high, 0.5 + 0.5 * high, THREE.SRGBColorSpace);
    placeBody(sun, 1, cameraInWater);
    placeBody(moon, -1, cameraInWater);

    const starAlpha = cameraInWater ? 0 : STAR_MAX_OPACITY * (1 - smoothstep(STAR_FADE_LOW, STAR_FADE_HIGH, sunElevation(t)));
    stars.visible = starAlpha > 0.001;
    if (stars.visible) {
      stars.material.opacity = starAlpha;
      stars.position.copy(cam);
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    scene.remove(stars, sun, moon);
    for (const obj of [sun, moon, stars]) {
      obj.geometry.dispose();
      if (obj.material.map) obj.material.map.dispose();
      obj.material.dispose();
    }
  }

  const sky = {
    update,
    /** Chunk material gray level for the last update (0.25 night .. 1.0 noon). */
    brightness: brightnessAt(DAY_START_TIME),
    dispose,
    sun,
    moon,
    stars,
  };
  return sky;
}
