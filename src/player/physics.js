// Player physics: AABB movement and voxel collision (PROJECT.md section 5.6).
// Pure logic, no three.js. The world is only read through world.getBlock(x, y, z)
// with integer block coordinates, and solidity comes from isSolid() in blocks.js
// (leaves and glass are solid; air, water and unknown ids are not).
//
// CONVENTIONS
//
// state: { x, y, z, vx, vy, vz, onGround, flying, inWater }
//   (x, y, z) is the FEET position: the center of the bottom face of the player's AABB.
//   The AABB spans [x - W/2, x + W/2] x [y, y + PLAYER_HEIGHT] x [z - W/2, z + W/2]
//   with W = PLAYER_WIDTH. Velocities are in blocks per second.
//
// input: { forward, strafe, jump, sprint, down }   (missing fields read as 0 / false)
//   The CALLER has already rotated movement into world space using the camera yaw:
//     strafe  = desired world-X component of horizontal movement (-1..1)
//     forward = desired world-Z component of horizontal movement (-1..1)
//   If the (strafe, forward) vector is longer than 1 it is normalized, so diagonals
//   are not faster. For a three.js camera (looks down -Z, yaw about +Y) with key axes
//   f = W - S and r = D - A:
//     strafe  = r * Math.cos(yaw) - f * Math.sin(yaw)
//     forward = -r * Math.sin(yaw) - f * Math.cos(yaw)
//   jump   = Space held: jump when on ground, swim up in water, ascend in fly mode.
//   sprint = Shift held while walking: SPRINT_SPEED instead of WALK_SPEED.
//   down   = descend in fly mode (the caller maps Shift to this while flying).
//
// BEHAVIOR SUMMARY
//   - dt is clamped to MAX_DT (0.05 s) and split into equal substeps of at most 1/60 s.
//   - Horizontal velocity approaches the target speed exponentially: snappy on the
//     ground, weaker in the air, medium in water and in fly mode.
//   - Vertical motion uses the trapezoid rule, which is exact under constant gravity,
//     so the jump apex is ~1.27 blocks at any frame rate.
//   - Collisions are resolved one axis at a time (Y, then X, then Z) with a swept test
//     over every cell between the old and new position (no tunneling at high speed).
//     On a hit the AABB is snapped COLLISION_EPS away from the block face and that
//     velocity component is zeroed. onGround is set when blocked moving down.
//   - Jump only when onGround and not in water. No auto-step, no mid-air jumps.
//   - Fly mode: no gravity, vy approaches (jump - down) * FLY_SPEED, horizontal speed
//     FLY_SPEED, collisions still apply, water has no effect on movement.
//     Landing on the ground while flying (blocked moving down) turns flying OFF
//     (state.flying = false), so the caller must read state.flying back each frame.
//   - Water: state.inWater is true when the block at (x, y + 0.4, z) is WATER. In water:
//     30% gravity, sinking is slowed toward WATER_SINK_SPEED, horizontal speed is
//     halved, and holding jump swims up at SWIM_UP_SPEED. Shoreline exit: holding jump
//     while the feet are in water near the surface and the player is horizontally
//     blocked gives an upward boost (WATER_EXIT_SPEED), enough to climb onto a block
//     whose top is up to 1 block above the water surface. A taller wall cannot be
//     climbed this way (the player just bobs against it).
//
// stepPlayer allocates nothing per call; it only touches numbers and the state object.

import {
  PLAYER_WIDTH, PLAYER_HEIGHT, GRAVITY, JUMP_SPEED,
  WALK_SPEED, SPRINT_SPEED, FLY_SPEED,
  MAX_DT, MAX_SUBSTEP, COLLISION_EPS, GROUND_ACCEL,
  AIR_ACCEL, WATER_ACCEL, FLY_ACCEL, MAX_FALL_SPEED,
  WATER_SAMPLE_HEIGHT, WATER_GRAVITY_SCALE, WATER_SPEED_SCALE, WATER_SINK_SPEED,
  WATER_DRAG, SWIM_UP_SPEED, SWIM_ACCEL, WATER_EXIT_SPEED,
  LANDING_ENDS_FLIGHT, SKIN_TOL,
} from '../config.js';
import { B, isSolid } from '../blocks.js';

// Tuning constants live in config.js; re-exported here for tests and callers.
export {
  MAX_DT, MAX_SUBSTEP, COLLISION_EPS, GROUND_ACCEL,
  AIR_ACCEL, WATER_ACCEL, FLY_ACCEL, MAX_FALL_SPEED,
  WATER_SAMPLE_HEIGHT, WATER_GRAVITY_SCALE, WATER_SPEED_SCALE, WATER_SINK_SPEED,
  WATER_DRAG, SWIM_UP_SPEED, SWIM_ACCEL, WATER_EXIT_SPEED,
  LANDING_ENDS_FLIGHT,
};

const HALF_W = PLAYER_WIDTH / 2;

export function createPlayerState(x, y, z) {
  return { x, y, z, vx: 0, vy: 0, vz: 0, onGround: false, flying: false, inWater: false };
}

// True if the player's AABB overlaps the unit cell [bx,bx+1) x [by,by+1) x [bz,bz+1).
// Touching faces do not count, so a block may be placed flush against the player
// (for example the block they stand on, or a wall they lean on).
export function aabbIntersectsBlock(state, bx, by, bz) {
  return state.x - HALF_W < bx + 1 && state.x + HALF_W > bx &&
         state.y < by + 1 && state.y + PLAYER_HEIGHT > by &&
         state.z - HALF_W < bz + 1 && state.z + HALF_W > bz;
}

// Advances the player by dt seconds, mutating state in place.
export function stepPlayer(state, input, world, dt) {
  if (!(dt > 0)) { // 0, negative, NaN: no time passes
    state.inWater = waterAt(world, state.x, state.y + WATER_SAMPLE_HEIGHT, state.z);
    return;
  }
  if (dt > MAX_DT) dt = MAX_DT;
  const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP - 1e-9));
  const h = dt / steps;

  let ix = +input.strafe || 0;
  let iz = +input.forward || 0;
  const len2 = ix * ix + iz * iz;
  if (len2 > 1) {
    const inv = 1 / Math.sqrt(len2);
    ix *= inv;
    iz *= inv;
  }
  const jump = !!input.jump;
  const sprint = !!input.sprint;
  const down = !!input.down;

  for (let i = 0; i < steps; i++) {
    const inWater = waterAt(world, state.x, state.y + WATER_SAMPLE_HEIGHT, state.z);
    state.inWater = inWater;

    // ---- Horizontal velocity: approach the target speed ----
    let speed;
    let accel;
    if (state.flying) {
      speed = FLY_SPEED;
      accel = FLY_ACCEL;
    } else {
      speed = sprint ? SPRINT_SPEED : WALK_SPEED;
      if (inWater) {
        speed *= WATER_SPEED_SCALE;
        accel = WATER_ACCEL;
      } else {
        accel = state.onGround ? GROUND_ACCEL : AIR_ACCEL;
      }
    }
    const k = Math.min(1, accel * h);
    state.vx += (ix * speed - state.vx) * k;
    state.vz += (iz * speed - state.vz) * k;

    // ---- Vertical velocity ----
    let v0 = state.vy;
    if (state.flying) {
      const target = ((jump ? 1 : 0) - (down ? 1 : 0)) * FLY_SPEED;
      state.vy += (target - state.vy) * Math.min(1, FLY_ACCEL * h);
    } else if (inWater) {
      if (jump) {
        if (state.vy < SWIM_UP_SPEED) state.vy = Math.min(SWIM_UP_SPEED, state.vy + SWIM_ACCEL * h);
        else state.vy = Math.max(SWIM_UP_SPEED, state.vy - GRAVITY * h);
      } else if (state.vy > -WATER_SINK_SPEED) {
        // Reduced gravity, but never past the terminal sink speed.
        state.vy = Math.max(-WATER_SINK_SPEED, state.vy - GRAVITY * WATER_GRAVITY_SCALE * h);
      }
      // Entered the water faster than the sink speed: drag it down smoothly.
      if (state.vy < -WATER_SINK_SPEED) {
        state.vy += (-WATER_SINK_SPEED - state.vy) * Math.min(1, WATER_DRAG * h);
      }
    } else {
      if (jump && state.onGround) {
        state.vy = JUMP_SPEED;
        v0 = JUMP_SPEED;
      }
      state.vy -= GRAVITY * h;
      if (state.vy < -MAX_FALL_SPEED) state.vy = -MAX_FALL_SPEED;
    }

    // ---- Move and collide: Y, then X, then Z ----
    const hitY = sweepY(state, world, 0.5 * (v0 + state.vy) * h);
    state.onGround = hitY < 0;
    if (hitY < 0 && state.flying && LANDING_ENDS_FLIGHT) state.flying = false;
    const blockedX = sweepX(state, world, state.vx * h);
    const blockedZ = sweepZ(state, world, state.vz * h);

    // ---- Shoreline exit: jump + pushing into a wall + feet in water near the surface ----
    if (jump && !state.flying && (blockedX || blockedZ) &&
        waterAt(world, state.x, state.y, state.z) &&
        !waterAt(world, state.x, state.y + 1, state.z)) {
      if (state.vy < WATER_EXIT_SPEED) state.vy = WATER_EXIT_SPEED;
    }
  }

  state.inWater = waterAt(world, state.x, state.y + WATER_SAMPLE_HEIGHT, state.z);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function waterAt(world, x, y, z) {
  return world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z)) === B.WATER;
}

// True if any cell in the inclusive integer box is solid.
function anySolid(world, x0, x1, y0, y1, z0, z1) {
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        if (isSolid(world.getBlock(x, y, z))) return true;
      }
    }
  }
  return false;
}

// Cell ranges for an interval [min, max]: first = floor(min), last = ceil(max) - 1,
// so a face exactly on a cell boundary does not count as overlapping that cell.

// Moves along Y by dy. Returns -1 if blocked moving down, 1 if blocked moving up, else 0.
function sweepY(state, world, dy) {
  if (dy === 0) return 0;
  const x0 = Math.floor(state.x - HALF_W);
  const x1 = Math.ceil(state.x + HALF_W) - 1;
  const z0 = Math.floor(state.z - HALF_W);
  const z1 = Math.ceil(state.z + HALF_W) - 1;
  if (dy < 0) {
    const oldMin = state.y;
    const end = Math.floor(oldMin + dy);
    for (let by = Math.floor(oldMin + SKIN_TOL) - 1; by >= end; by--) {
      if (anySolid(world, x0, x1, by, by, z0, z1)) {
        state.y = by + 1 + COLLISION_EPS;
        state.vy = 0;
        return -1;
      }
    }
  } else {
    const oldMax = state.y + PLAYER_HEIGHT;
    const end = Math.ceil(oldMax + dy) - 1;
    for (let by = Math.ceil(oldMax - SKIN_TOL); by <= end; by++) {
      if (anySolid(world, x0, x1, by, by, z0, z1)) {
        state.y = by - PLAYER_HEIGHT - COLLISION_EPS;
        if (state.vy > 0) state.vy = 0;
        return 1;
      }
    }
  }
  state.y += dy;
  return 0;
}

// Moves along X by dx. Returns true if blocked.
function sweepX(state, world, dx) {
  if (dx === 0) return false;
  const y0 = Math.floor(state.y);
  const y1 = Math.ceil(state.y + PLAYER_HEIGHT) - 1;
  const z0 = Math.floor(state.z - HALF_W);
  const z1 = Math.ceil(state.z + HALF_W) - 1;
  if (dx > 0) {
    const oldMax = state.x + HALF_W;
    const end = Math.ceil(oldMax + dx) - 1;
    for (let bx = Math.ceil(oldMax - SKIN_TOL); bx <= end; bx++) {
      if (anySolid(world, bx, bx, y0, y1, z0, z1)) {
        state.x = bx - HALF_W - COLLISION_EPS;
        state.vx = 0;
        return true;
      }
    }
  } else {
    const oldMin = state.x - HALF_W;
    const end = Math.floor(oldMin + dx);
    for (let bx = Math.floor(oldMin + SKIN_TOL) - 1; bx >= end; bx--) {
      if (anySolid(world, bx, bx, y0, y1, z0, z1)) {
        state.x = bx + 1 + HALF_W + COLLISION_EPS;
        state.vx = 0;
        return true;
      }
    }
  }
  state.x += dx;
  return false;
}

// Moves along Z by dz. Returns true if blocked.
function sweepZ(state, world, dz) {
  if (dz === 0) return false;
  const x0 = Math.floor(state.x - HALF_W);
  const x1 = Math.ceil(state.x + HALF_W) - 1;
  const y0 = Math.floor(state.y);
  const y1 = Math.ceil(state.y + PLAYER_HEIGHT) - 1;
  if (dz > 0) {
    const oldMax = state.z + HALF_W;
    const end = Math.ceil(oldMax + dz) - 1;
    for (let bz = Math.ceil(oldMax - SKIN_TOL); bz <= end; bz++) {
      if (anySolid(world, x0, x1, y0, y1, bz, bz)) {
        state.z = bz - HALF_W - COLLISION_EPS;
        state.vz = 0;
        return true;
      }
    }
  } else {
    const oldMin = state.z - HALF_W;
    const end = Math.floor(oldMin + dz);
    for (let bz = Math.floor(oldMin + SKIN_TOL) - 1; bz >= end; bz--) {
      if (anySolid(world, x0, x1, y0, y1, bz, bz)) {
        state.z = bz + 1 + HALF_W + COLLISION_EPS;
        state.vz = 0;
        return true;
      }
    }
  }
  state.z += dz;
  return false;
}
