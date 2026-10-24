import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  brightnessAt, skyColorAt, sunDirection, sunElevation, daylightAt, createSky,
  paintSunPixels, paintMoonPixels, SUN_TEX_SIZE, MOON_TEX_SIZE,
} from '../src/render/sky.js';
import {
  CHUNK_SIZE, RENDER_DISTANCE, FOG_NEAR_FACTOR, FOG_FAR_FACTOR, DAY_SKY_COLOR, NIGHT_SKY_COLOR,
  UNDERWATER_FOG_NEAR, UNDERWATER_FOG_FAR, DAY_START_TIME, SUN_DISTANCE,
} from '../src/config.js';

const hexToRgb = (hex) => ({ r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255 });
const colorDist = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);
const DAY = hexToRgb(DAY_SKY_COLOR);
const NIGHT = hexToRgb(NIGHT_SKY_COLOR);
const STEP = 1e-4;

describe('time convention and config', () => {
  it('the game starts in the morning (after sunrise, before noon)', () => {
    expect(DAY_START_TIME).toBeGreaterThan(0.25);
    expect(DAY_START_TIME).toBeLessThan(0.5);
    expect(brightnessAt(DAY_START_TIME)).toBeGreaterThan(0.6);
  });

  it('sun elevation is -1 at midnight, 0 at sunrise/sunset, 1 at noon', () => {
    expect(sunElevation(0)).toBeCloseTo(-1, 9);
    expect(sunElevation(0.25)).toBeCloseTo(0, 9);
    expect(sunElevation(0.5)).toBeCloseTo(1, 9);
    expect(sunElevation(0.75)).toBeCloseTo(0, 9);
  });
});

describe('brightnessAt', () => {
  it('is 1.0 at noon and 0.25 at midnight', () => {
    expect(Math.abs(brightnessAt(0.5) - 1)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(brightnessAt(0) - 0.25)).toBeLessThanOrEqual(0.01);
    expect(daylightAt(0.5)).toBe(1);
    expect(daylightAt(0)).toBe(0);
  });

  it('is strictly between at sunrise and sunset', () => {
    for (const t of [0.25, 0.75]) {
      const b = brightnessAt(t);
      expect(b, `t=${t}`).toBeGreaterThan(0.4);
      expect(b, `t=${t}`).toBeLessThan(0.8);
    }
  });

  it('stays low through the deep night and high through the middle of the day', () => {
    for (const t of [0.9, 0.95, 0, 0.05, 0.1]) expect(brightnessAt(t), `t=${t}`).toBeCloseTo(0.25, 6);
    for (const t of [0.4, 0.45, 0.5, 0.55, 0.6]) expect(brightnessAt(t), `t=${t}`).toBeCloseTo(1, 6);
  });

  it('rises through the morning and falls through the evening', () => {
    expect(brightnessAt(0.22)).toBeLessThan(brightnessAt(0.25));
    expect(brightnessAt(0.25)).toBeLessThan(brightnessAt(0.28));
    expect(brightnessAt(0.72)).toBeGreaterThan(brightnessAt(0.75));
    expect(brightnessAt(0.75)).toBeGreaterThan(brightnessAt(0.78));
  });

  it('is always within [0.25, 1] and continuous', () => {
    let prev = brightnessAt(0);
    let maxJump = 0;
    for (let t = STEP; t <= 1; t += STEP) {
      const b = brightnessAt(t);
      expect(b).toBeGreaterThanOrEqual(0.25);
      expect(b).toBeLessThanOrEqual(1);
      maxJump = Math.max(maxJump, Math.abs(b - prev));
      prev = b;
    }
    expect(maxJump).toBeLessThan(0.005);
  });

  it('is periodic', () => {
    expect(brightnessAt(1 - 1e-9)).toBeCloseTo(brightnessAt(0), 6);
    expect(brightnessAt(1.3)).toBeCloseTo(brightnessAt(0.3), 9);
  });
});

describe('skyColorAt', () => {
  it('is day blue at noon and night blue at midnight', () => {
    expect(colorDist(skyColorAt(0.5, {}), DAY)).toBeLessThan(0.02);
    expect(colorDist(skyColorAt(0, {}), NIGHT)).toBeLessThan(0.02);
  });

  it('is warm (r > b) at sunrise and sunset', () => {
    for (const t of [0.25, 0.75]) {
      const c = skyColorAt(t, {});
      expect(c.r, `t=${t}`).toBeGreaterThan(c.b);
      expect(colorDist(c, DAY), `t=${t}`).toBeGreaterThan(0.2);
      expect(colorDist(c, NIGHT), `t=${t}`).toBeGreaterThan(0.2);
    }
  });

  it('writes into and returns out, with components in [0, 1]', () => {
    const out = { r: -1, g: -1, b: -1 };
    expect(skyColorAt(0.3, out)).toBe(out);
    for (let t = 0; t < 1; t += 0.01) {
      skyColorAt(t, out);
      for (const k of ['r', 'g', 'b']) {
        expect(out[k]).toBeGreaterThanOrEqual(0);
        expect(out[k]).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is continuous and periodic', () => {
    const prev = skyColorAt(0, {});
    const cur = { r: 0, g: 0, b: 0 };
    let maxJump = 0;
    for (let t = STEP; t <= 1; t += STEP) {
      skyColorAt(t, cur);
      maxJump = Math.max(maxJump, colorDist(cur, prev));
      prev.r = cur.r;
      prev.g = cur.g;
      prev.b = cur.b;
    }
    expect(maxJump).toBeLessThan(0.005);
    expect(colorDist(skyColorAt(1 - 1e-9, {}), skyColorAt(0, {}))).toBeLessThan(1e-6);
  });
});

describe('sunDirection', () => {
  it('is a unit vector at every time', () => {
    const out = { x: 0, y: 0, z: 0 };
    for (let t = 0; t < 1; t += 0.01) {
      sunDirection(t, out);
      expect(Math.hypot(out.x, out.y, out.z)).toBeCloseTo(1, 9);
    }
  });

  it('is high at noon (tilted, not straight up) and below the horizon at midnight', () => {
    const noon = sunDirection(0.5, { x: 0, y: 0, z: 0 });
    expect(noon.y).toBeGreaterThan(0.9);
    expect(noon.y).toBeLessThan(1);
    expect(Math.abs(noon.z)).toBeGreaterThan(0.05);
    expect(sunDirection(0, {}).y).toBeLessThan(0);
  });

  it('rises in the east (+X) and sets in the west (-X)', () => {
    for (const t of [0.24, 0.25, 0.26, 0.3]) expect(sunDirection(t, {}).x, `t=${t}`).toBeGreaterThan(0);
    for (const t of [0.7, 0.74, 0.75, 0.76]) expect(sunDirection(t, {}).x, `t=${t}`).toBeLessThan(0);
    expect(sunDirection(0.24, {}).y).toBeLessThan(0);
    expect(sunDirection(0.26, {}).y).toBeGreaterThan(0);
    expect(sunDirection(0.74, {}).y).toBeGreaterThan(0);
    expect(sunDirection(0.76, {}).y).toBeLessThan(0);
  });

  it('writes into a THREE.Vector3', () => {
    const v = new THREE.Vector3();
    expect(sunDirection(0.5, v)).toBe(v);
    expect(v.length()).toBeCloseTo(1, 9);
  });
});

describe('sun and moon pixels', () => {
  const alpha = (p, x, y) => p.data[(y * p.size + x) * 4 + 3];

  it('sun: opaque warm core, translucent glow, transparent corners', () => {
    const p = paintSunPixels();
    const c = SUN_TEX_SIZE / 2;
    expect(p.data.length).toBe(SUN_TEX_SIZE * SUN_TEX_SIZE * 4);
    expect(alpha(p, c, c)).toBe(255);
    const i = (c * p.size + c) * 4;
    expect(p.data[i]).toBeGreaterThanOrEqual(p.data[i + 2]); // warm: r >= b
    const glow = alpha(p, c, c - 9);
    expect(glow).toBeGreaterThan(0);
    expect(glow).toBeLessThan(255);
    expect(alpha(p, 0, 0)).toBe(0);
  });

  it('moon: opaque gray body with darker crater pixels', () => {
    const p = paintMoonPixels();
    expect(p.data.length).toBe(MOON_TEX_SIZE * MOON_TEX_SIZE * 4);
    const grays = new Set();
    for (let y = 0; y < p.size; y++) {
      for (let x = 0; x < p.size; x++) {
        if (alpha(p, x, y) === 255) grays.add(p.data[(y * p.size + x) * 4]);
      }
    }
    expect(grays.size).toBeGreaterThanOrEqual(3); // body, rim, craters
    expect(Math.min(...grays)).toBeLessThan(Math.max(...grays) - 40);
    expect(alpha(p, 0, 0)).toBe(0);
  });
});

describe('createSky (node smoke test)', () => {
  const VIEW = RENDER_DISTANCE * CHUNK_SIZE;

  function makeScene() {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(DAY_SKY_COLOR);
    scene.fog = new THREE.Fog(DAY_SKY_COLOR, 1, 2);
    return scene;
  }

  it('drives background, fog and brightness without replacing the scene objects', () => {
    const scene = makeScene();
    const background = scene.background;
    const fog = scene.fog;
    const sky = createSky(scene);
    const cam = new THREE.Vector3(10, 30, -5);

    sky.update(0.5, cam, false);
    expect(scene.background).toBe(background);
    expect(scene.fog).toBe(fog);
    expect(sky.brightness).toBeCloseTo(1, 6);
    expect(fog.near).toBeCloseTo(VIEW * FOG_NEAR_FACTOR, 6);
    expect(fog.far).toBeCloseTo(VIEW * FOG_FAR_FACTOR, 6);
    const noonHex = background.getHex();
    expect(fog.color.getHex()).toBe(noonHex);
    expect(noonHex).toBe(DAY_SKY_COLOR);

    sky.update(0, cam, false);
    expect(sky.brightness).toBeCloseTo(0.25, 6);
    expect(background.getHex()).not.toBe(noonHex);
    expect(background.getHex()).toBe(NIGHT_SKY_COLOR);

    for (const t of [0.1, 0.25, 0.3, 0.75, 0.99, 1.5, -0.2]) {
      sky.update(t, cam, false);
      expect(sky.brightness).toBeGreaterThanOrEqual(0.25);
      expect(sky.brightness).toBeLessThanOrEqual(1);
    }
    sky.dispose();
  });

  it('places the sun by day and the moon by night, around the camera', () => {
    const scene = makeScene();
    const sky = createSky(scene);
    const cam = new THREE.Vector3(100, 40, -200);

    sky.update(0.5, cam, false);
    expect(sky.sun.visible).toBe(true);
    expect(sky.moon.visible).toBe(false);
    expect(sky.sun.position.distanceTo(cam)).toBeCloseTo(SUN_DISTANCE, 4);
    expect(sky.sun.position.y).toBeGreaterThan(cam.y);
    expect(SUN_DISTANCE).toBeLessThanOrEqual(200);
    // The quad's +Z (its front face) points back at the camera.
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(sky.sun.quaternion);
    const toCam = cam.clone().sub(sky.sun.position).normalize();
    expect(normal.dot(toCam)).toBeGreaterThan(0.999);

    sky.update(0, cam, false);
    expect(sky.sun.visible).toBe(false);
    expect(sky.moon.visible).toBe(true);
    expect(sky.moon.position.y).toBeGreaterThan(cam.y);
    expect(sky.stars.visible).toBe(true);

    sky.update(0.5, cam, false);
    expect(sky.stars.visible).toBe(false);
    sky.dispose();
  });

  it('switches to the underwater look and back', () => {
    const scene = makeScene();
    const sky = createSky(scene);
    const cam = { x: 0, y: 20, z: 0 };

    sky.update(0.5, cam, false);
    const airHex = scene.background.getHex();

    sky.update(0.5, cam, true);
    expect(scene.fog.near).toBeCloseTo(UNDERWATER_FOG_NEAR, 6);
    expect(scene.fog.far).toBeCloseTo(UNDERWATER_FOG_FAR, 6);
    expect(UNDERWATER_FOG_NEAR).toBeCloseTo(0.5, 6);
    expect(UNDERWATER_FOG_FAR).toBeCloseTo(14, 6);
    const waterHex = scene.background.getHex();
    expect(waterHex).not.toBe(airHex);
    expect(scene.fog.color.getHex()).toBe(waterHex);
    const c = scene.fog.color;
    expect(c.g).toBeGreaterThan(c.r); // blue-green
    expect(c.b).toBeGreaterThan(c.r);
    expect(sky.sun.visible).toBe(false);

    sky.update(0.5, cam, false);
    expect(scene.background.getHex()).toBe(airHex);
    expect(scene.fog.near).toBeCloseTo(VIEW * FOG_NEAR_FACTOR, 6);
    expect(scene.fog.far).toBeCloseTo(VIEW * FOG_FAR_FACTOR, 6);
    expect(sky.sun.visible).toBe(true);
    sky.dispose();
  });

  it('dispose removes the sun, moon and stars and frees their resources', () => {
    const scene = makeScene();
    const before = scene.children.length;
    const sky = createSky(scene);
    expect(scene.children.length).toBeGreaterThan(before);
    sky.update(0.4, new THREE.Vector3(), false);

    const disposed = [];
    for (const obj of [sky.sun, sky.moon, sky.stars]) {
      obj.geometry.addEventListener('dispose', () => disposed.push('geometry'));
      obj.material.addEventListener('dispose', () => disposed.push('material'));
      if (obj.material.map) obj.material.map.addEventListener('dispose', () => disposed.push('texture'));
    }
    sky.dispose();
    expect(scene.children.length).toBe(before);
    for (const obj of [sky.sun, sky.moon, sky.stars]) expect(scene.children).not.toContain(obj);
    expect(disposed.filter((d) => d === 'geometry')).toHaveLength(3);
    expect(disposed.filter((d) => d === 'material')).toHaveLength(3);
    expect(disposed.filter((d) => d === 'texture')).toHaveLength(2);

    expect(() => sky.dispose()).not.toThrow();
    expect(() => sky.update(0.5, new THREE.Vector3(), false)).not.toThrow();
  });

  it('creates a background color and fog once if the scene has none', () => {
    const scene = new THREE.Scene();
    const sky = createSky(scene);
    expect(scene.background.isColor).toBe(true);
    expect(scene.fog.isFog).toBe(true);
    const bg = scene.background;
    sky.update(0.3, { x: 0, y: 0, z: 0 }, false);
    expect(scene.background).toBe(bg);
    sky.dispose();
  });
});
