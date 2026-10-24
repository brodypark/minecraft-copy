import { describe, it, expect } from 'vitest';
import {
  stepPlayer, createPlayerState, aabbIntersectsBlock,
  COLLISION_EPS, WATER_SINK_SPEED, SWIM_UP_SPEED,
} from '../src/player/physics.js';
import { B } from '../src/blocks.js';
import { PLAYER_WIDTH, PLAYER_HEIGHT, WALK_SPEED, SPRINT_SPEED, FLY_SPEED } from '../src/config.js';

const HALF_W = PLAYER_WIDTH / 2;
const FLOOR_TOP = 10; // fake world: stone at y = 0..9 everywhere, so the walkable surface is y = 10

// Fake in-memory world. `extra(x, y, z)` may return an id to override the default
// flat floor; `set` / `fill` place individual blocks on top of that.
// getBlock throws on non-integer coordinates so the physics must floor positions.
function makeWorld(extra) {
  const edits = new Map();
  const world = {
    calls: 0,
    getBlock(x, y, z) {
      world.calls++;
      if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) {
        throw new Error(`getBlock called with non-integer coords (${x}, ${y}, ${z})`);
      }
      const k = `${x},${y},${z}`;
      if (edits.has(k)) return edits.get(k);
      if (extra) {
        const id = extra(x, y, z);
        if (id !== undefined) return id;
      }
      return y >= 0 && y < FLOOR_TOP ? B.STONE : B.AIR;
    },
    set(x, y, z, id) {
      edits.set(`${x},${y},${z}`, id);
      return world;
    },
    fill(x0, y0, z0, x1, y1, z1, id) {
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          for (let z = z0; z <= z1; z++) world.set(x, y, z, id);
        }
      }
      return world;
    },
  };
  return world;
}

const NO_INPUT = Object.freeze({ forward: 0, strafe: 0, jump: false, sprint: false, down: false });
function input(over) {
  return { ...NO_INPUT, ...over };
}

// Runs `seconds` of simulation at a fixed dt; calls onStep(state, i) after each step.
function run(state, world, inp, seconds, dt = 1 / 60, onStep) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    stepPlayer(state, inp, world, dt);
    if (onStep) onStep(state, i);
  }
  return state;
}

// Jumps from standing on the floor and returns the apex height above the floor.
function measureJumpApex(dt) {
  const world = makeWorld();
  const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
  run(s, world, NO_INPUT, 0.5, dt); // settle
  expect(s.onGround).toBe(true);
  const base = s.y;
  let maxY = s.y;
  stepPlayer(s, input({ jump: true }), world, dt);
  maxY = Math.max(maxY, s.y);
  run(s, world, NO_INPUT, 1.5, dt, (st) => { maxY = Math.max(maxY, st.y); });
  expect(s.onGround).toBe(true);
  expect(s.y).toBeCloseTo(base, 3);
  return maxY - base;
}

describe('createPlayerState', () => {
  it('returns the contract shape', () => {
    expect(createPlayerState(1, 2, 3)).toEqual({
      x: 1, y: 2, z: 3, vx: 0, vy: 0, vz: 0, onGround: false, flying: false, inWater: false,
    });
  });
});

describe('standing and falling', () => {
  it('standing on a floor stays put', () => {
    const world = makeWorld();
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(s, world, NO_INPUT, 10, 1 / 60, (st, i) => {
      expect(Math.abs(st.y - FLOOR_TOP)).toBeLessThan(1e-3);
      if (i > 0) expect(st.onGround).toBe(true);
    });
    expect(s.onGround).toBe(true);
    expect(s.x).toBe(0.5);
    expect(s.z).toBe(0.5);
    expect(s.vy).toBe(0);
    expect(s.inWater).toBe(false);
  });

  it('falling lands on the ground and sets onGround', () => {
    const world = makeWorld();
    const s = createPlayerState(0.5, 20, 0.5);
    stepPlayer(s, NO_INPUT, world, 1 / 60);
    expect(s.onGround).toBe(false);
    expect(s.vy).toBeLessThan(0);
    run(s, world, NO_INPUT, 2);
    expect(s.onGround).toBe(true);
    expect(s.vy).toBe(0);
    expect(s.y).toBeGreaterThanOrEqual(FLOOR_TOP);
    expect(s.y).toBeLessThan(FLOOR_TOP + 1e-3);
  });

  it('does not tunnel through a 1-block platform at high fall speed and large dt', () => {
    const world = makeWorld(); // floor + a thin platform at y = 30
    world.fill(-2, 30, -2, 2, 30, 2, B.PLANKS);
    const s = createPlayerState(0.5, 60, 0.5);
    s.vy = -59;
    run(s, world, NO_INPUT, 3, 0.05);
    expect(s.onGround).toBe(true);
    expect(s.y).toBeCloseTo(31, 3);
  });

  it('walking off a ledge clears onGround and allows no mid-air jump', () => {
    const world = makeWorld((x, y) => (x >= 3 && y === 9 ? B.AIR : undefined)); // drop of 1 at x >= 3
    world.fill(3, 0, -5, 20, 8, 5, B.STONE);
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(s, world, NO_INPUT, 0.2);
    let leftGroundAt = -1;
    run(s, world, input({ strafe: 1 }), 1.2, 1 / 60, (st, i) => {
      if (leftGroundAt < 0 && !st.onGround) leftGroundAt = i;
    });
    expect(leftGroundAt).toBeGreaterThan(0);
    expect(s.y).toBeCloseTo(9, 3);
    expect(s.onGround).toBe(true);
  });
});

describe('walls and ceilings', () => {
  it('walking into a +X wall stops at the wall face', () => {
    const world = makeWorld();
    world.fill(3, FLOOR_TOP, -5, 3, FLOOR_TOP + 3, 5, B.STONE);
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(s, world, input({ strafe: 1, sprint: true }), 3, 1 / 60, (st) => {
      expect(st.x).toBeLessThanOrEqual(3 - HALF_W);
    });
    expect(s.x).toBeCloseTo(3 - HALF_W - COLLISION_EPS, 6);
    expect(s.vx).toBe(0);
    expect(s.onGround).toBe(true);
  });

  it('walking into -X, +Z and -Z walls stops too, also at dt 0.05', () => {
    const world = makeWorld();
    world.fill(-4, FLOOR_TOP, -6, -4, FLOOR_TOP + 2, 6, B.COBBLESTONE); // -X wall, face at x = -3
    world.fill(-6, FLOOR_TOP, 4, 6, FLOOR_TOP + 2, 4, B.GLASS);         // +Z wall, face at z = 4
    world.fill(-6, FLOOR_TOP, -3, 6, FLOOR_TOP + 2, -3, B.LEAVES);      // -Z wall, face at z = -2
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(s, world, input({ strafe: -1 }), 3, 0.05, (st) => expect(st.x).toBeGreaterThanOrEqual(-3 + HALF_W));
    expect(s.x).toBeCloseTo(-3 + HALF_W + COLLISION_EPS, 6);
    run(s, world, input({ forward: 1 }), 3, 0.05, (st) => expect(st.z).toBeLessThanOrEqual(4 - HALF_W));
    expect(s.z).toBeCloseTo(4 - HALF_W - COLLISION_EPS, 6);
    run(s, world, input({ forward: -1 }), 3, 1 / 60, (st) => expect(st.z).toBeGreaterThanOrEqual(-2 + HALF_W));
    expect(s.z).toBeCloseTo(-2 + HALF_W + COLLISION_EPS, 6);
  });

  it('water does not block movement', () => {
    const world = makeWorld();
    world.fill(2, FLOOR_TOP, -2, 2, FLOOR_TOP + 1, 2, B.WATER);
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(s, world, input({ strafe: 1 }), 3);
    expect(s.x).toBeGreaterThan(5);
  });

  it('a 1-block step blocks walking (no auto-step) but can be jumped onto', () => {
    const world = makeWorld();
    world.fill(3, FLOOR_TOP, -5, 10, FLOOR_TOP, 5, B.DIRT); // step up of 1 at x >= 3
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(s, world, input({ strafe: 1 }), 2);
    expect(s.x).toBeCloseTo(3 - HALF_W - COLLISION_EPS, 6);
    expect(s.y).toBeCloseTo(FLOOR_TOP, 3);
    run(s, world, input({ strafe: 1, jump: true }), 0.6);
    expect(s.x).toBeGreaterThan(3);
    run(s, world, NO_INPUT, 1);
    expect(s.y).toBeCloseTo(FLOOR_TOP + 1, 3);
    expect(s.onGround).toBe(true);
  });

  it("can't jump through a 2-block ceiling", () => {
    const world = makeWorld();
    world.fill(-3, 12, -3, 3, 12, 3, B.STONE);
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    let maxHead = 0;
    run(s, world, input({ jump: true }), 3, 1 / 60, (st) => {
      maxHead = Math.max(maxHead, st.y + PLAYER_HEIGHT);
      expect(st.y + PLAYER_HEIGHT).toBeLessThan(12);
    });
    expect(maxHead).toBeGreaterThan(12 - 0.01); // it did actually bump the ceiling
    run(s, world, NO_INPUT, 1);
    expect(s.y).toBeCloseTo(FLOOR_TOP, 3);
  });

  it('hitting a ceiling zeroes upward velocity', () => {
    const world = makeWorld();
    world.fill(-3, 12, -3, 3, 12, 3, B.STONE);
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(s, world, NO_INPUT, 0.1);
    stepPlayer(s, input({ jump: true }), world, 1 / 60);
    let bumped = false;
    run(s, world, NO_INPUT, 0.5, 1 / 60, (st) => {
      if (!bumped && st.y + PLAYER_HEIGHT > 12 - 1e-3) {
        bumped = true;
        expect(st.vy).toBeLessThanOrEqual(0);
      }
    });
    expect(bumped).toBe(true);
  });
});

describe('jumping', () => {
  it('jump apex is about 1.2-1.3 blocks at 60 fps', () => {
    const apex = measureJumpApex(1 / 60);
    expect(apex).toBeGreaterThan(1.2);
    expect(apex).toBeLessThan(1.3);
  });

  it('jump apex is stable at dt 0.05 and irregular frame times', () => {
    for (const dt of [0.05, 1 / 30, 1 / 144, 0.023]) {
      const apex = measureJumpApex(dt);
      expect(apex, `dt=${dt}`).toBeGreaterThan(1.2);
      expect(apex, `dt=${dt}`).toBeLessThan(1.3);
    }
  });

  it("can't jump while airborne", () => {
    const world = makeWorld();
    const s = createPlayerState(0.5, 14, 0.5);
    let prevY = s.y;
    let landed = false;
    // Jump held the whole fall: no upward motion until the first landing.
    run(s, world, input({ jump: true }), 0.6, 1 / 60, (st) => {
      if (st.onGround) landed = true;
      if (!landed) {
        expect(st.vy).toBeLessThanOrEqual(0);
        expect(st.y).toBeLessThanOrEqual(prevY);
      }
      prevY = st.y;
    });
    expect(landed).toBe(true);
  });

  it('pressing jump again mid-air does not add height', () => {
    const world = makeWorld();
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(s, world, NO_INPUT, 0.2);
    stepPlayer(s, input({ jump: true }), world, 1 / 60);
    let maxY = s.y;
    for (let i = 0; i < 90; i++) {
      // tap jump on and off while airborne
      stepPlayer(s, i % 10 < 5 && !s.onGround ? input({ jump: true }) : NO_INPUT, world, 1 / 60);
      maxY = Math.max(maxY, s.y);
    }
    expect(maxY - FLOOR_TOP).toBeLessThan(1.3);
  });
});

describe('horizontal movement', () => {
  it('sprinting is faster than walking, and speeds approach the config values', () => {
    const world = makeWorld();
    const walk = createPlayerState(0.5, FLOOR_TOP, 0.5);
    const sprint = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(walk, world, NO_INPUT, 0.1);
    run(sprint, world, NO_INPUT, 0.1);
    run(walk, world, input({ forward: 1 }), 2);
    run(sprint, world, input({ forward: 1, sprint: true }), 2);
    expect(sprint.z - 0.5).toBeGreaterThan(walk.z - 0.5 + 2);
    expect(walk.vz).toBeCloseTo(WALK_SPEED, 2);
    expect(sprint.vz).toBeCloseTo(SPRINT_SPEED, 2);
  });

  it('diagonal input is normalized', () => {
    const world = makeWorld();
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(s, world, input({ forward: 1, strafe: 1 }), 2);
    expect(Math.hypot(s.vx, s.vz)).toBeCloseTo(WALK_SPEED, 2);
  });

  it('stops when input is released', () => {
    const world = makeWorld();
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(s, world, input({ strafe: 1 }), 1);
    run(s, world, NO_INPUT, 1);
    expect(Math.abs(s.vx)).toBeLessThan(1e-3);
  });
});

describe('fly mode', () => {
  it('ignores gravity: y stays constant with no input', () => {
    const world = makeWorld();
    const s = createPlayerState(0.5, 20, 0.5);
    s.flying = true;
    run(s, world, NO_INPUT, 3);
    expect(s.y).toBe(20);
    expect(s.flying).toBe(true);
    expect(s.onGround).toBe(false);
  });

  it('rises with jump and descends with down', () => {
    const world = makeWorld();
    const s = createPlayerState(0.5, 20, 0.5);
    s.flying = true;
    run(s, world, input({ jump: true }), 1);
    expect(s.y).toBeGreaterThan(25);
    expect(s.vy).toBeCloseTo(FLY_SPEED, 1);
    const top = s.y;
    run(s, world, input({ down: true }), 0.5);
    expect(s.y).toBeLessThan(top - 2);
    expect(s.flying).toBe(true);
  });

  it('flies horizontally at FLY_SPEED', () => {
    const world = makeWorld();
    const s = createPlayerState(0.5, 20, 0.5);
    s.flying = true;
    run(s, world, input({ strafe: -1 }), 2);
    expect(s.vx).toBeCloseTo(-FLY_SPEED, 1);
    expect(s.y).toBe(20);
  });

  it('collides while flying, and landing turns flying off', () => {
    const world = makeWorld();
    world.fill(-3, 25, -3, 3, 25, 3, B.STONE);
    const s = createPlayerState(0.5, 20, 0.5);
    s.flying = true;
    run(s, world, input({ jump: true }), 1, 1 / 60, (st) => {
      expect(st.y + PLAYER_HEIGHT).toBeLessThan(25);
    });
    expect(s.flying).toBe(true);
    run(s, world, input({ down: true }), 3);
    expect(s.flying).toBe(false);
    expect(s.onGround).toBe(true);
    expect(s.y).toBeCloseTo(FLOOR_TOP, 3);
  });
});

describe('dt handling', () => {
  it('a dt of 5 s behaves exactly like 0.05 s', () => {
    const world = makeWorld();
    const a = createPlayerState(0.5, 20, 0.5);
    const b = createPlayerState(0.5, 20, 0.5);
    const inp = input({ strafe: 1, forward: 0.5 });
    for (let i = 0; i < 10; i++) {
      stepPlayer(a, inp, world, 5);
      stepPlayer(b, inp, world, 0.05);
      expect(a).toEqual(b);
    }
  });

  it('zero, negative and NaN dt leave the player in place', () => {
    const world = makeWorld();
    const s = createPlayerState(0.5, 20, 0.5);
    for (const dt of [0, -1, NaN]) {
      stepPlayer(s, input({ strafe: 1 }), world, dt);
      expect(s.x).toBe(0.5);
      expect(s.y).toBe(20);
    }
  });

  it('missing input fields read as no input', () => {
    const world = makeWorld();
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(s, world, {}, 1);
    expect(s.x).toBe(0.5);
    expect(s.y).toBeCloseTo(FLOOR_TOP, 3);
  });
});

describe('negative coordinates', () => {
  it('stands on a single block at negative x/z (floor, not truncation)', () => {
    const world = makeWorld(() => B.AIR); // void everywhere...
    world.set(-1, 9, -1, B.STONE); // ...except one block spanning x,z in [-1, 0)
    const s = createPlayerState(-0.5, FLOOR_TOP, -0.5);
    run(s, world, NO_INPUT, 3);
    expect(s.y).toBeCloseTo(FLOOR_TOP, 3);
    expect(s.onGround).toBe(true);
  });

  it('walls at x < 0 and z < 0 stop the player identically', () => {
    const world = makeWorld();
    world.fill(-9, FLOOR_TOP, -20, -9, FLOOR_TOP + 2, 0, B.STONE);  // face at x = -8
    world.fill(-20, FLOOR_TOP, -13, 0, FLOOR_TOP + 2, -13, B.STONE); // face at z = -12
    const s = createPlayerState(-5.5, FLOOR_TOP, -7.5);
    run(s, world, NO_INPUT, 1);
    expect(s.y).toBeCloseTo(FLOOR_TOP, 3);
    run(s, world, input({ strafe: -1, forward: -1 }), 4, 1 / 60, (st) => {
      expect(st.x).toBeGreaterThanOrEqual(-8 + HALF_W);
      expect(st.z).toBeGreaterThanOrEqual(-12 + HALF_W);
    });
    expect(s.x).toBeCloseTo(-8 + HALF_W + COLLISION_EPS, 6);
    expect(s.z).toBeCloseTo(-12 + HALF_W + COLLISION_EPS, 6);
    expect(s.onGround).toBe(true);
  });

  it('a ceiling at negative coordinates blocks a jump', () => {
    const world = makeWorld();
    world.fill(-6, 12, -6, -1, 12, -1, B.STONE);
    const s = createPlayerState(-3.5, FLOOR_TOP, -3.5);
    run(s, world, input({ jump: true }), 2, 1 / 60, (st) => {
      expect(st.y + PLAYER_HEIGHT).toBeLessThan(12);
    });
  });
});

describe('water', () => {
  // Deep water from the floor (y = 10) up to y = 39 (surface at y = 40).
  const deepWater = () => makeWorld((x, y) => (y >= 10 && y < 40 ? B.WATER : undefined));

  it('sets inWater in water and clears it on land', () => {
    const s = createPlayerState(0.5, 30, 0.5);
    stepPlayer(s, NO_INPUT, deepWater(), 1 / 60);
    expect(s.inWater).toBe(true);
    const dry = createPlayerState(0.5, FLOOR_TOP, 0.5);
    stepPlayer(dry, NO_INPUT, makeWorld(), 1 / 60);
    expect(dry.inWater).toBe(false);
  });

  it('water reduces fall speed', () => {
    const wet = createPlayerState(0.5, 38, 0.5);
    const dry = createPlayerState(0.5, 38, 0.5);
    run(wet, deepWater(), NO_INPUT, 1);
    run(dry, makeWorld(), NO_INPUT, 1);
    expect(wet.vy).toBeGreaterThanOrEqual(-WATER_SINK_SPEED - 1e-9);
    expect(38 - wet.y).toBeLessThan(2.5);
    expect(38 - dry.y).toBeGreaterThan(10);
  });

  it('a fast fall into water is slowed to sink speed', () => {
    const s = createPlayerState(0.5, 60, 0.5);
    let minVy = 0;
    // Reaches the surface (y = 40) at ~1.1 s, falling at ~35 blocks/s.
    run(s, deepWater(), NO_INPUT, 1.2, 1 / 60, (st) => { minVy = Math.min(minVy, st.vy); });
    expect(s.inWater).toBe(true);
    expect(minVy).toBeLessThan(-30);
    expect(s.vy).toBeGreaterThan(minVy); // already slowing
    run(s, deepWater(), NO_INPUT, 1);
    expect(s.vy).toBeGreaterThanOrEqual(-WATER_SINK_SPEED - 0.01);
    expect(s.y).toBeGreaterThan(FLOOR_TOP);
  });

  it('holding jump swims up at a moderate speed', () => {
    const s = createPlayerState(0.5, 15, 0.5);
    run(s, deepWater(), input({ jump: true }), 2);
    expect(s.vy).toBeCloseTo(SWIM_UP_SPEED, 3);
    expect(s.y).toBeGreaterThan(20);
    expect(s.y).toBeLessThan(23);
  });

  it('swimming up stops at the surface (bobs, does not fly out)', () => {
    const s = createPlayerState(0.5, 30, 0.5);
    let maxY = 0;
    run(s, deepWater(), input({ jump: true }), 8, 1 / 60, (st, i) => {
      if (i > 300) maxY = Math.max(maxY, st.y);
    });
    expect(maxY).toBeGreaterThan(39);
    expect(maxY).toBeLessThan(40);
  });

  it('water halves horizontal speed', () => {
    const s = createPlayerState(0.5, FLOOR_TOP, 0.5);
    run(s, deepWater(), input({ forward: 1 }), 2);
    expect(Math.abs(s.vz)).toBeCloseTo(WALK_SPEED * 0.5, 1);
  });

  // Pool for x < 0: stone up to y = 6, water y = 7..9 (surface at y = 10).
  // Land for x >= 0 is the flat floor (top at 10), plus `lip` extra blocks on top.
  function shoreWorld(lip) {
    return makeWorld((x, y) => {
      if (x < 0) {
        if (y >= 7 && y <= 9) return B.WATER;
        if (y > 9) return B.AIR;
      } else if (y >= FLOOR_TOP && y < FLOOR_TOP + lip) {
        return B.SAND;
      }
      return undefined;
    });
  }

  for (const lip of [0, 1]) {
    it(`swims out onto a shore whose top is ${lip} block(s) above the water surface`, () => {
      const world = shoreWorld(lip);
      const s = createPlayerState(-3.5, 7, 0.5);
      run(s, world, input({ strafe: 1, jump: true }), 6);
      expect(s.x).toBeGreaterThan(0.5);
      run(s, world, NO_INPUT, 1);
      expect(s.onGround).toBe(true);
      expect(s.inWater).toBe(false);
      expect(s.y).toBeCloseTo(FLOOR_TOP + lip, 3);
    });
  }

  it('cannot climb a wall 2 blocks above the water surface', () => {
    const world = shoreWorld(2);
    const s = createPlayerState(-3.5, 7, 0.5);
    run(s, world, input({ strafe: 1, jump: true }), 6, 1 / 60, (st) => {
      expect(st.x).toBeLessThanOrEqual(-HALF_W);
    });
  });
});

describe('aabbIntersectsBlock', () => {
  const s = createPlayerState(0.5, 10, 0.5); // AABB x,z in [0.2, 0.8], y in [10, 11.8]

  it('detects the feet and head cells', () => {
    expect(aabbIntersectsBlock(s, 0, 10, 0)).toBe(true);
    expect(aabbIntersectsBlock(s, 0, 11, 0)).toBe(true);
  });

  it('does not count the block under the feet or above the head', () => {
    expect(aabbIntersectsBlock(s, 0, 9, 0)).toBe(false);
    expect(aabbIntersectsBlock(s, 0, 12, 0)).toBe(false);
  });

  it('does not count neighbors the AABB does not reach', () => {
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
      expect(aabbIntersectsBlock(s, dx, 10, dz)).toBe(false);
    }
  });

  it('counts a neighbor the AABB straddles, but not one it only touches', () => {
    const straddle = createPlayerState(1.0, 10, 0.5); // x in [0.7, 1.3]
    expect(aabbIntersectsBlock(straddle, 0, 10, 0)).toBe(true);
    expect(aabbIntersectsBlock(straddle, 1, 10, 0)).toBe(true);
    const touching = createPlayerState(0.7, 10, 0.5); // x in [0.4, 1.0]: touches x = 1 exactly
    expect(aabbIntersectsBlock(touching, 1, 10, 0)).toBe(false);
  });

  it('works at negative coordinates', () => {
    const n = createPlayerState(-0.5, 10, -0.5); // x,z in [-0.8, -0.2]
    expect(aabbIntersectsBlock(n, -1, 10, -1)).toBe(true);
    expect(aabbIntersectsBlock(n, 0, 10, 0)).toBe(false);
    expect(aabbIntersectsBlock(n, -1, 10, 0)).toBe(false);
    expect(aabbIntersectsBlock(n, -1, 9, -1)).toBe(false);
  });

  it('a player resting on a floor never intersects it', () => {
    const world = makeWorld();
    const p = createPlayerState(-2.5, 12, 3.5);
    run(p, world, NO_INPUT, 2);
    expect(aabbIntersectsBlock(p, -3, 9, 3)).toBe(false);
    expect(aabbIntersectsBlock(p, -3, 10, 3)).toBe(true);
  });
});
