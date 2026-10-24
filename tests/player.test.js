import { describe, it, expect, afterEach } from 'vitest';
import { createPlayer, findSpawn } from '../src/player/player.js';
import { createControls } from '../src/player/controls.js';
import { aabbIntersectsBlock } from '../src/player/physics.js';
import { World } from '../src/world/world.js';
import { toChunkCoord } from '../src/world/chunk.js';
import { isSolid } from '../src/blocks.js';
import {
  SEA_LEVEL, GEN_DISTANCE, PLAYER_WIDTH, PLAYER_HEIGHT, PLAYER_EYE, WORLD_HEIGHT,
} from '../src/config.js';

const HALF_W = PLAYER_WIDTH / 2;
const DEG = Math.PI / 180;
const DT = 1 / 60;

// ---- Fakes ---------------------------------------------------------------------

function makeCamera() {
  return {
    position: {
      x: 0, y: 0, z: 0,
      set(x, y, z) { this.x = x; this.y = y; this.z = z; },
    },
    rotation: {
      x: 0, y: 0, z: 0, order: 'XYZ',
      set(x, y, z, order) { this.x = x; this.y = y; this.z = z; if (order) this.order = order; },
    },
  };
}

function makeControls() {
  const held = new Set();
  const delta = { dx: 0, dy: 0 };
  let dx = 0;
  let dy = 0;
  let fly = false;
  return {
    hold(...codes) { held.clear(); for (const c of codes) held.add(c); },
    move(x, y) { dx += x; dy += y; },
    doubleTapSpace() { fly = true; },
    isDown: (code) => held.has(code),
    consumeMouseDelta() {
      delta.dx = dx; delta.dy = dy; dx = 0; dy = 0;
      return delta;
    },
    consumeFlyToggle() {
      const f = fly; fly = false;
      return f;
    },
  };
}

function setup(seed = 1337, genAt = [0, 0]) {
  const world = new World(seed);
  world.generateAround(genAt[0], genAt[1], GEN_DISTANCE);
  const camera = makeCamera();
  const controls = makeControls();
  const player = createPlayer({ camera, world, controls });
  return { world, camera, controls, player };
}

/** First solid cell the player's AABB overlaps, or null. */
function solidOverlap(world, s) {
  for (let x = Math.floor(s.x - HALF_W); x <= Math.floor(s.x + HALF_W); x++) {
    for (let y = Math.floor(s.y); y <= Math.floor(s.y + PLAYER_HEIGHT); y++) {
      for (let z = Math.floor(s.z - HALF_W); z <= Math.floor(s.z + HALF_W); z++) {
        if (isSolid(world.getBlock(x, y, z)) && aabbIntersectsBlock(s, x, y, z)) return [x, y, z];
      }
    }
  }
  return null;
}

/** Feet height that clears every column under the AABB at (x, z). */
function standHeight(world, x, z) {
  let top = -1;
  for (const ox of [-HALF_W, HALF_W]) {
    for (const oz of [-HALF_W, HALF_W]) top = Math.max(top, world.heightAt(x + ox, z + oz));
  }
  return top + 1.5;
}

/**
 * Run frames like the game loop (player.update, then world.update) and check after every frame
 * that the player is not inside a solid block and not below the terrain surface.
 * script(frame) may change keys/look and returns the dt for that frame.
 * Returns the number of chunk-border crossings.
 */
function simulate({ world, player }, frames, script) {
  const s = player.state;
  let crossings = 0;
  let lastCx = toChunkCoord(s.x);
  let lastCz = toChunkCoord(s.z);
  for (let i = 0; i < frames; i++) {
    const dt = script(i);
    player.update(dt, true);
    world.update(s.x, s.z);

    const overlap = solidOverlap(world, s);
    if (overlap) {
      throw new Error(`frame ${i}: player at (${s.x}, ${s.y}, ${s.z}) overlaps solid block ${overlap}`);
    }
    const surface = world.terrain.surfaceHeight(Math.floor(s.x), Math.floor(s.z));
    if (s.y < surface + 1 - 1e-6) {
      throw new Error(`frame ${i}: feet y ${s.y} below surface top ${surface + 1} at (${s.x}, ${s.z})`);
    }
    if (s.y < 0 || !Number.isFinite(s.x + s.y + s.z)) throw new Error(`frame ${i}: bad position`);

    const cx = toChunkCoord(s.x);
    const cz = toChunkCoord(s.z);
    if (cx !== lastCx) crossings++;
    if (cz !== lastCz) crossings++;
    lastCx = cx;
    lastCz = cz;
  }
  return crossings;
}

// Yaw that makes W move toward a world direction.
const YAW = { posX: -Math.PI / 2, negX: Math.PI / 2, posZ: Math.PI, negZ: 0 };

// ---- findSpawn -------------------------------------------------------------------

describe('findSpawn', () => {
  it('returns a land column without a tree for several seeds', () => {
    for (const seed of [1, 42, 1337, 98765, 2024]) {
      const world = new World(seed);
      const { x, z } = findSpawn(world);
      const bx = Math.floor(x);
      const bz = Math.floor(z);
      expect(x - bx).toBe(0.5);
      expect(z - bz).toBe(0.5);
      expect(world.terrain.surfaceHeight(bx, bz)).toBeGreaterThan(SEA_LEVEL);
      expect(world.terrain.treeAt(bx, bz)).toBe(0);
      expect(Math.hypot(bx, bz)).toBeLessThan(256);
    }
  });

  it('is the nearest qualifying column (nothing nearer is land without a tree nearby)', () => {
    const world = new World(42);
    const { x, z } = findSpawn(world);
    const d2 = Math.floor(x) ** 2 + Math.floor(z) ** 2;
    const r = Math.ceil(Math.sqrt(d2));
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz >= d2) continue;
        let treeNear = false;
        for (let tz = -2; tz <= 2; tz++) for (let tx = -2; tx <= 2; tx++) if (world.terrain.treeAt(dx + tx, dz + tz)) treeNear = true;
        expect(world.terrain.surfaceHeight(dx, dz) > SEA_LEVEL && !treeNear).toBe(false);
      }
    }
  });
});

// ---- Chunk-border regression ------------------------------------------------------------

describe('player on chunk borders', () => {
  const STARTS = [[16, 16], [-16, -16], [-16, 16], [16, -16], [0, 0], [32, -32]];

  it('walking and sprinting back and forth across borders never enters a block or falls through', () => {
    for (const seed of [1337, 7]) {
      const ctx = setup(seed);
      let crossings = 0;
      for (const [sx, sz] of STARTS) {
        ctx.player.teleport(sx, standHeight(ctx.world, sx, sz), sz);
        ctx.player.state.flying = false;
        // Settle onto the ground first.
        crossings += simulate(ctx, 60, () => { ctx.controls.hold(); return DT; });
        expect(ctx.player.state.onGround || ctx.player.state.inWater).toBe(true);

        const dirs = [YAW.posX, YAW.negX, YAW.posZ, YAW.negZ, YAW.posX + Math.PI / 4, YAW.negX + Math.PI / 4];
        crossings += simulate(ctx, 1200, (i) => {
          const phase = Math.floor(i / 30); // 0.5 s per leg at 60 fps
          const yaw = dirs[phase % dirs.length] + (phase % 2 ? 0 : 0.03);
          ctx.player.setLook(yaw, 0);
          const keys = ['KeyW'];
          if (phase % 3 !== 0) keys.push('Space'); // hop up 1-block steps
          if (phase % 4 >= 2) keys.push('ShiftLeft'); // sprint
          ctx.controls.hold(...keys);
          return phase % 5 === 4 ? 0.05 : DT; // some low-fps frames
        });
        // Strafe across the exact border line too.
        crossings += simulate(ctx, 240, (i) => {
          ctx.player.setLook(0, 0);
          ctx.controls.hold(Math.floor(i / 20) % 2 ? 'KeyA' : 'KeyD', 'Space');
          return DT;
        });
      }
      expect(crossings).toBeGreaterThan(20);
    }
  });

  it('standing exactly on a border stays put', () => {
    const ctx = setup(1337);
    for (const [sx, sz] of STARTS) {
      ctx.player.teleport(sx, standHeight(ctx.world, sx, sz), sz);
      simulate(ctx, 120, () => { ctx.controls.hold(); return DT; });
      const s = ctx.player.state;
      if (!s.inWater) {
        expect(s.onGround).toBe(true);
        expect(s.x).toBeCloseTo(sx, 6);
        expect(s.z).toBeCloseTo(sz, 6);
      }
    }
  });

  it('flying fast across borders (and landing) never enters a block', () => {
    for (const seed of [1337, 7]) {
      const ctx = setup(seed);
      let crossings = 0;
      for (const [sx, sz] of STARTS) {
        ctx.player.teleport(sx, standHeight(ctx.world, sx, sz) + 3, sz);
        ctx.player.state.flying = true;
        crossings += simulate(ctx, 1500, (i) => {
          const phase = Math.floor(i / 90); // 1.5 s legs: ~18 blocks at FLY_SPEED
          const dirs = [YAW.posX, YAW.negX, YAW.posZ, YAW.negZ, YAW.posX + Math.PI / 4, YAW.negX + Math.PI / 4];
          ctx.player.setLook(dirs[phase % dirs.length], 0);
          const keys = ['KeyW'];
          const vertical = phase % 4;
          if (vertical === 1) keys.push('ShiftLeft'); // dive into terrain: lands, flight ends
          if (vertical === 2) keys.push('Space');
          ctx.controls.hold(...keys);
          if (!ctx.player.state.flying && i % 90 === 0) ctx.controls.doubleTapSpace(); // take off again
          return i % 7 === 0 ? 0.05 : DT;
        });
      }
      expect(crossings).toBeGreaterThan(30);
    }
  });
});

// ---- update(): freeze, respawn, look, input mapping ----------------------------------------------

describe('player update', () => {
  it('freezes physics while the chunk under the player has no data', () => {
    const world = new World(1337);
    world.ensureChunk(0, 0);
    const camera = makeCamera();
    const controls = makeControls();
    const player = createPlayer({ camera, world, controls });

    for (const [x, z] of [[40.5, 40.5], [-0.5, 0.5], [0.5, -0.5]]) { // (2,2), (-1,0), (0,-1): not loaded
      player.teleport(x, 70, z);
      controls.hold('KeyW', 'Space');
      for (let i = 0; i < 30; i++) player.update(DT, true);
      expect(player.state.x).toBe(x);
      expect(player.state.y).toBe(70);
      expect(player.state.z).toBe(z);
      expect(camera.position.y).toBe(70 + PLAYER_EYE);
    }

    world.ensureChunk(2, 2); // data arrives: gravity applies
    player.teleport(40.5, 70, 40.5);
    controls.hold();
    for (let i = 0; i < 10; i++) player.update(DT, true);
    expect(player.state.y).toBeLessThan(70);
  });

  it('respawns at the spawn point after falling below y = -20', () => {
    const { world, player } = setup(1337);
    const spawn = findSpawn(world);
    const sy = world.heightAt(spawn.x, spawn.z) + 2;
    player.setSpawn(spawn.x, sy, spawn.z);
    player.teleport(0.5, -25, 0.5);
    player.state.flying = true;
    player.state.vy = -30;
    player.update(DT, true);
    expect(player.state.x).toBe(spawn.x);
    expect(player.state.y).toBe(sy);
    expect(player.state.z).toBe(spawn.z);
    expect(player.state.vy).toBe(0);
    expect(player.state.flying).toBe(false);
    expect(player.spawnPoint).toEqual({ x: spawn.x, y: sy, z: spawn.z });
  });

  it('clamps pitch to +-89 degrees under huge mouse deltas', () => {
    const { controls, player, camera } = setup(1337);
    controls.move(0, 1e7);
    player.update(DT, true);
    expect(player.pitch).toBeCloseTo(-89 * DEG, 10);
    controls.move(0, -1e9);
    player.update(DT, true);
    expect(player.pitch).toBeCloseTo(89 * DEG, 10);
    expect(camera.rotation.x).toBe(player.pitch);
    player.setLook(0, 5);
    expect(player.pitch).toBeCloseTo(89 * DEG, 10);
  });

  it('mouse right turns right (yaw decreases), mouse down looks down', () => {
    const { controls, player } = setup(1337);
    controls.move(100, 50);
    player.update(DT, true);
    expect(player.yaw).toBeLessThan(0);
    expect(player.pitch).toBeLessThan(0);
  });

  it('maps W to -Z at yaw 0 and to -X at yaw PI/2; D strafes to +X at yaw 0', () => {
    const cases = [
      { yaw: 0, key: 'KeyW', axis: 'z', sign: -1 },
      { yaw: Math.PI / 2, key: 'KeyW', axis: 'x', sign: -1 },
      { yaw: 0, key: 'KeyD', axis: 'x', sign: 1 },
      { yaw: 0, key: 'KeyS', axis: 'z', sign: 1 },
    ];
    for (const c of cases) {
      const { controls, player } = setup(1337);
      player.teleport(8.5, WORLD_HEIGHT + 6, 8.5); // above everything: nothing to bump into
      player.state.flying = true;
      player.setLook(c.yaw, 0);
      controls.hold(c.key);
      for (let i = 0; i < 30; i++) player.update(DT, true);
      const other = c.axis === 'x' ? 'z' : 'x';
      expect((player.state[c.axis] - 8.5) * c.sign).toBeGreaterThan(1);
      expect(Math.abs(player.state[other] - 8.5)).toBeLessThan(1e-6);
    }
  });

  it('syncs the camera to the eye position with YXZ rotation', () => {
    const { player, camera } = setup(1337);
    player.teleport(3.5, 40, -7.5);
    player.setLook(1.2, -0.4);
    player.update(DT, false);
    expect(camera.position).toMatchObject({ x: 3.5, y: 40 + PLAYER_EYE, z: -7.5 });
    expect(camera.rotation).toMatchObject({ x: -0.4, y: 1.2, z: 0, order: 'YXZ' });
  });

  it('double-tap Space toggles flight with vy = 0; Shift descends while flying', () => {
    const { controls, player } = setup(1337);
    player.teleport(8.5, WORLD_HEIGHT + 6, 8.5);
    player.state.vy = -5;
    controls.doubleTapSpace();
    player.update(DT, true);
    expect(player.state.flying).toBe(true);
    expect(player.state.vy).toBe(0);

    const y0 = player.state.y;
    controls.hold('ShiftLeft');
    for (let i = 0; i < 20; i++) player.update(DT, true);
    expect(player.state.y).toBeLessThan(y0 - 0.5);

    controls.doubleTapSpace();
    player.update(DT, true);
    expect(player.state.flying).toBe(false);
  });

  it('applies no input and no physics while inactive, and drops one-shot input', () => {
    const { controls, player } = setup(1337);
    player.teleport(8.5, WORLD_HEIGHT + 6, 8.5);
    controls.hold('KeyW', 'Space');
    controls.move(500, 500);
    controls.doubleTapSpace();
    for (let i = 0; i < 20; i++) player.update(DT, false);
    expect(player.state).toMatchObject({ x: 8.5, y: WORLD_HEIGHT + 6, z: 8.5, flying: false });
    expect(player.yaw).toBe(0);
    expect(player.pitch).toBe(0);
    controls.hold();
    player.update(DT, true); // the paused double-tap and mouse movement must not apply now
    expect(player.state.flying).toBe(false);
    expect(player.yaw).toBe(0);
  });
});

// ---- Controls (with a minimal fake DOM) ---------------------------------------------------------

describe('controls', () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  let controls = null;

  afterEach(() => {
    if (controls) controls.dispose();
    controls = null;
    globalThis.window = saved.window;
    globalThis.document = saved.document;
  });

  function ev(type, props = {}) {
    const e = new Event(type, { cancelable: true });
    for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
    return e;
  }

  function fakeDom() {
    const win = new EventTarget();
    const doc = new EventTarget();
    doc.pointerLockElement = null;
    doc.hidden = false;
    const canvas = new EventTarget();
    canvas.lockMode = 'grant';
    canvas.requestPointerLock = () => {
      if (canvas.lockMode === 'reject') return Promise.reject(new Error('relocked too soon'));
      doc.pointerLockElement = canvas;
      doc.dispatchEvent(new Event('pointerlockchange'));
      return Promise.resolve();
    };
    const unlock = () => {
      doc.pointerLockElement = null;
      doc.dispatchEvent(new Event('pointerlockchange'));
    };
    globalThis.window = win;
    globalThis.document = doc;
    controls = createControls(canvas);
    const key = (type, code, t = 0, repeat = false) => win.dispatchEvent(ev(type, { code, timeStamp: t, repeat }));
    return { win, doc, canvas, unlock, key };
  }

  it('records held keys even when unlocked and clears them on blur', () => {
    const { win, key } = fakeDom();
    key('keydown', 'KeyW');
    key('keydown', 'ShiftLeft');
    expect(controls.locked).toBe(false);
    expect(controls.isDown('KeyW')).toBe(true);
    key('keyup', 'KeyW');
    expect(controls.isDown('KeyW')).toBe(false);
    expect(controls.isDown('ShiftLeft')).toBe(true);
    win.dispatchEvent(new Event('blur'));
    expect(controls.isDown('ShiftLeft')).toBe(false);
  });

  it('locks on canvas click; mouse input only while locked; lock loss clears keys', () => {
    const { doc, canvas, unlock, key } = fakeDom();
    const changes = [];
    controls.onLockChange((l) => changes.push(l));

    doc.dispatchEvent(ev('mousemove', { movementX: 50, movementY: 5 }));
    canvas.dispatchEvent(ev('mousedown', { button: 0 }));
    expect(controls.consumeMouseDelta()).toEqual({ dx: 0, dy: 0 });
    expect(controls.consumeActions()).toEqual([]);

    canvas.dispatchEvent(ev('click'));
    expect(controls.locked).toBe(true);
    expect(changes).toEqual([true]);

    doc.dispatchEvent(ev('mousemove', { movementX: 3, movementY: -2 }));
    doc.dispatchEvent(ev('mousemove', { movementX: 4, movementY: 1 }));
    const d = controls.consumeMouseDelta();
    expect(d).toEqual({ dx: 7, dy: -1 });
    expect(controls.consumeMouseDelta()).toBe(d); // same object, reset
    expect(d).toEqual({ dx: 0, dy: 0 });

    canvas.dispatchEvent(ev('mousedown', { button: 0 }));
    canvas.dispatchEvent(ev('mousedown', { button: 2 }));
    canvas.dispatchEvent(ev('mousedown', { button: 1 }));
    expect([...controls.consumeActions()]).toEqual(['break', 'place']);
    expect(controls.consumeActions()).toEqual([]);

    const menu = ev('contextmenu');
    canvas.dispatchEvent(menu);
    expect(menu.defaultPrevented).toBe(true);

    key('keydown', 'KeyD');
    unlock();
    expect(controls.locked).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(controls.isDown('KeyD')).toBe(false);
  });

  it('swallows a rejected pointer-lock request', async () => {
    const { canvas } = fakeDom();
    canvas.lockMode = 'reject';
    canvas.dispatchEvent(ev('click'));
    await new Promise((r) => setTimeout(r, 0)); // an unhandled rejection would fail the run
    expect(controls.locked).toBe(false);
  });

  it('detects a Space double-tap within 300 ms, ignoring auto-repeat', () => {
    const { key } = fakeDom();
    key('keydown', 'Space', 1000);
    key('keydown', 'Space', 1100, true); // auto-repeat
    key('keyup', 'Space', 1150);
    expect(controls.consumeFlyToggle()).toBe(false);
    key('keydown', 'Space', 1250);
    expect(controls.consumeFlyToggle()).toBe(true);
    expect(controls.consumeFlyToggle()).toBe(false);

    key('keydown', 'Space', 1400); // third tap starts a new pair
    expect(controls.consumeFlyToggle()).toBe(false);
    key('keydown', 'Space', 2000); // too slow
    expect(controls.consumeFlyToggle()).toBe(false);
    key('keydown', 'Space', 2200);
    expect(controls.consumeFlyToggle()).toBe(true);
  });

  it('reports slot keys, F3 and wheel steps once', () => {
    const { win, canvas, key } = fakeDom();
    key('keydown', 'Digit3');
    key('keydown', 'Digit9');
    expect(controls.consumeSlotKey()).toBe(8);
    expect(controls.consumeSlotKey()).toBe(-1);

    const f3 = ev('keydown', { code: 'F3', repeat: false, timeStamp: 0 });
    win.dispatchEvent(f3);
    expect(f3.defaultPrevented).toBe(true);
    expect(controls.consumeDebugToggle()).toBe(true);
    expect(controls.consumeDebugToggle()).toBe(false);

    canvas.dispatchEvent(ev('wheel', { deltaY: 100, timeStamp: 0 })); // ignored: unlocked
    expect(controls.consumeWheel()).toBe(0);
    canvas.dispatchEvent(ev('click'));
    canvas.dispatchEvent(ev('wheel', { deltaY: 100, timeStamp: 1000 }));
    canvas.dispatchEvent(ev('wheel', { deltaY: 3, timeStamp: 1020 })); // same burst: dropped
    canvas.dispatchEvent(ev('wheel', { deltaY: 100, timeStamp: 1100 }));
    expect(controls.consumeWheel()).toBe(2);
    canvas.dispatchEvent(ev('wheel', { deltaY: -100, timeStamp: 1110 }));
    expect(controls.consumeWheel()).toBe(-1);
    expect(controls.consumeWheel()).toBe(0);
  });

  it('dispose removes the listeners', () => {
    const { key } = fakeDom();
    controls.dispose();
    key('keydown', 'KeyW');
    expect(controls.isDown('KeyW')).toBe(false);
  });
});
