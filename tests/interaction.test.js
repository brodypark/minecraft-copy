import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { tryBreak, tryPlace, performAction } from '../src/player/interaction.js';
import { raycast } from '../src/world/raycast.js';
import { createPlayerState } from '../src/player/physics.js';
import { createTargetOutline } from '../src/render/outline.js';
import { B } from '../src/blocks.js';
import { WORLD_HEIGHT, PLAYER_EYE, PLAYER_WIDTH, CHUNK_SIZE } from '../src/config.js';
import { World } from '../src/world/world.js';

const SEED = 2024;
const FLOOR_Y = 40; // stone floor of the test arena; the player stands on it with feet at y = 41

// A real World with the 5x5 chunks around (0, 0) generated (so the inner 3x3 are meshable), and a
// cleared arena inside chunk (0, 0): stone floor at y = 40, air from y = 41 to 52, x/z 1..14.
function makeArena() {
  const world = new World(SEED);
  for (let cz = -2; cz <= 2; cz++) for (let cx = -2; cx <= 2; cx++) world.ensureChunk(cx, cz);
  for (let x = 1; x <= 14; x++) {
    for (let z = 1; z <= 14; z++) {
      world.setBlock(x, FLOOR_Y, z, B.STONE);
      for (let y = FLOOR_Y + 1; y <= FLOOR_Y + 12; y++) world.setBlock(x, y, z, B.AIR);
    }
  }
  world.consumeDirtyChunks(); // start every test with nothing queued for meshing
  const player = createPlayerState(5.5, FLOOR_Y + 1, 5.5);
  return { world, player };
}

// Raycast from the player's eye toward a world point.
function aim(world, player, tx, ty, tz) {
  const ex = player.x;
  const ey = player.y + PLAYER_EYE;
  const ez = player.z;
  return raycast((x, y, z) => world.getBlock(x, y, z), ex, ey, ez, tx - ex, ty - ey, tz - ez);
}

describe('placing', () => {
  it("can't place inside the player", () => {
    const { world, player } = makeArena();
    // Looking straight down at the floor under the feet: the target cell holds the player's legs.
    const hit = aim(world, player, 5.5, FLOOR_Y, 5.5);
    expect(hit).toMatchObject({ x: 5, y: FLOOR_Y, z: 5, nx: 0, ny: 1, nz: 0 });
    expect(tryPlace(world, hit, B.DIRT, player)).toBe(false);
    expect(world.getBlock(5, FLOOR_Y + 1, 5)).toBe(B.AIR);
    // A ceiling block above the head; placing under it would fill the head cell (y 42, AABB top 42.8).
    world.setBlock(5, FLOOR_Y + 3, 5, B.STONE);
    const up = aim(world, player, 5.5, FLOOR_Y + 3, 5.5);
    expect(up).toMatchObject({ x: 5, y: FLOOR_Y + 3, z: 5, nx: 0, ny: -1, nz: 0 });
    expect(tryPlace(world, up, B.DIRT, player)).toBe(false);
    expect(world.getBlock(5, FLOOR_Y + 2, 5)).toBe(B.AIR);
    // Straddling a cell border: the AABB overlaps the neighbor column too.
    const straddle = createPlayerState(6.1, FLOOR_Y + 1, 5.5); // x span 5.8..6.4
    const side = { x: 5, y: FLOOR_Y, z: 5, nx: 0, ny: 1, nz: 0 };
    expect(tryPlace(world, side, B.DIRT, straddle)).toBe(false);
  });

  it('can place flush next to the player', () => {
    const { world, player } = makeArena();
    player.x = 5 + PLAYER_WIDTH / 2; // AABB x span exactly 5.0..5.6: touches cell x = 4, no overlap
    const hit = aim(world, player, 4.5, FLOOR_Y + 0.999, 5.5);
    expect(hit).toMatchObject({ x: 4, y: FLOOR_Y, z: 5, nx: 0, ny: 1, nz: 0 });
    expect(tryPlace(world, hit, B.COBBLESTONE, player)).toBe(true);
    expect(world.getBlock(4, FLOOR_Y + 1, 5)).toBe(B.COBBLESTONE);
    // And the block the player stands on can be placed while airborne right above it (touching).
    world.setBlock(5, FLOOR_Y, 5, B.AIR);
    const floorSide = { x: 4, y: FLOOR_Y, z: 5, nx: 1, ny: 0, nz: 0 }; // east face of (4, 40, 5)
    player.y = FLOOR_Y + 1; // feet exactly on the top of cell y = 40
    expect(tryPlace(world, floorSide, B.STONE, player)).toBe(true);
    expect(world.getBlock(5, FLOOR_Y, 5)).toBe(B.STONE);
  });

  it("can't place with an empty slot (null / undefined / AIR) or a non-placeable block", () => {
    const { world, player } = makeArena();
    const hit = { x: 8, y: FLOOR_Y, z: 8, id: B.STONE, nx: 0, ny: 1, nz: 0, distance: 3 };
    for (const id of [null, undefined, B.AIR, B.WATER, B.BEDROCK, 200, 'stone']) {
      expect(tryPlace(world, hit, id, player)).toBe(false);
    }
    expect(world.getBlock(8, FLOOR_Y + 1, 8)).toBe(B.AIR);
    expect(tryPlace(world, hit, B.GLASS, player)).toBe(true); // sanity: same hit works with a block
  });

  it("can't place out of world height", () => {
    const { world, player } = makeArena();
    world.setBlock(9, WORLD_HEIGHT - 1, 9, B.STONE);
    // Looking down at it from above the world: rays read y >= WORLD_HEIGHT as air.
    const hit = raycast((x, y, z) => world.getBlock(x, y, z), 9.5, WORLD_HEIGHT + 3, 9.5, 0, -1, 0);
    expect(hit).toMatchObject({ x: 9, y: WORLD_HEIGHT - 1, z: 9, nx: 0, ny: 1, nz: 0 });
    expect(tryPlace(world, hit, B.DIRT, player)).toBe(false); // target y = WORLD_HEIGHT
    // Below the world: the bottom face of bedrock at y = 0.
    const bottom = { x: 9, y: 0, z: 9, id: B.BEDROCK, nx: 0, ny: -1, nz: 0 };
    expect(world.getBlock(9, 0, 9)).toBe(B.BEDROCK);
    expect(tryPlace(world, bottom, B.DIRT, player)).toBe(false); // target y = -1
  });

  it('placing into water replaces it (the ray passes through the water to the floor)', () => {
    const { world, player } = makeArena();
    world.setBlock(6, FLOOR_Y + 1, 5, B.WATER);
    const hit = aim(world, player, 6.5, FLOOR_Y + 0.9, 5.5);
    expect(hit).toMatchObject({ x: 6, y: FLOOR_Y, z: 5, nx: 0, ny: 1, nz: 0 });
    expect(tryPlace(world, hit, B.PLANKS, player)).toBe(true);
    expect(world.getBlock(6, FLOOR_Y + 1, 5)).toBe(B.PLANKS);
  });

  it("refuses an occupied target cell, a (0, 0, 0) normal, a stale hit and an unloaded chunk", () => {
    const { world, player } = makeArena();
    world.setBlock(9, FLOOR_Y + 1, 9, B.SAND);
    const occupied = { x: 9, y: FLOOR_Y, z: 9, nx: 0, ny: 1, nz: 0 };
    expect(tryPlace(world, occupied, B.DIRT, player)).toBe(false);
    expect(world.getBlock(9, FLOOR_Y + 1, 9)).toBe(B.SAND);

    const inside = { x: 9, y: FLOOR_Y + 1, z: 9, nx: 0, ny: 0, nz: 0 };
    expect(tryPlace(world, inside, B.DIRT, player)).toBe(false);
    expect(tryPlace(world, null, B.DIRT, player)).toBe(false);

    // Stale hit: the block it pointed at was broken earlier in the same frame.
    const stale = { x: 10, y: FLOOR_Y, z: 10, nx: 0, ny: 1, nz: 0 };
    expect(tryBreak(world, stale)).toBe(true);
    expect(tryPlace(world, stale, B.DIRT, player)).toBe(false);
    expect(world.getBlock(10, FLOOR_Y + 1, 10)).toBe(B.AIR);

    // Target in chunk (3, 0), which was never generated: setBlock refuses.
    const edge = 3 * CHUNK_SIZE - 1;
    world.setBlock(edge, 62, 5, B.STONE);
    expect(world.hasChunkData(3, 0)).toBe(false);
    expect(tryPlace(world, { x: edge, y: 62, z: 5, nx: 1, ny: 0, nz: 0 }, B.DIRT, player)).toBe(false);
  });

  it('placing marks the chunk dirty so consumeDirtyChunks() returns it even with limit 0', () => {
    const { world, player } = makeArena();
    expect(world.consumeDirtyChunks(0)).toEqual([]);
    expect(tryPlace(world, { x: 8, y: FLOOR_Y, z: 8, nx: 0, ny: 1, nz: 0 }, B.LOG, player)).toBe(true);
    const dirty = world.consumeDirtyChunks(0);
    expect(dirty.map((c) => c.key)).toEqual(['0,0']);
    expect(world.consumeDirtyChunks(0)).toEqual([]);
    // On a chunk border the neighbor chunk is remeshed too (its face toward the edit changes).
    expect(tryPlace(world, { x: 1, y: FLOOR_Y, z: 8, nx: -1, ny: 0, nz: 0 }, B.LOG, player)).toBe(true);
    expect(world.getBlock(0, FLOOR_Y, 8)).toBe(B.LOG);
    expect(world.consumeDirtyChunks(0).map((c) => c.key).sort()).toEqual(['-1,0', '0,0']);
    // Breaking does the same.
    expect(tryBreak(world, { x: 8, y: FLOOR_Y + 1, z: 8 })).toBe(true);
    expect(world.consumeDirtyChunks(0).map((c) => c.key)).toEqual(['0,0']);
  });
});

describe('breaking', () => {
  it("can't break bedrock", () => {
    const { world, player } = makeArena();
    // Natural bedrock at y = 0.
    expect(world.getBlock(3, 0, 3)).toBe(B.BEDROCK);
    expect(tryBreak(world, { x: 3, y: 0, z: 3, id: B.BEDROCK, nx: 0, ny: 1, nz: 0 })).toBe(false);
    expect(world.getBlock(3, 0, 3)).toBe(B.BEDROCK);
    // Bedrock is targetable, it just can't be broken.
    world.setBlock(9, FLOOR_Y + 1, 6, B.BEDROCK);
    const hit = aim(world, player, 9.5, FLOOR_Y + 1.5, 6.5);
    expect(hit).toMatchObject({ x: 9, y: FLOOR_Y + 1, z: 6, id: B.BEDROCK });
    expect(tryBreak(world, hit)).toBe(false);
    expect(performAction('break', world, hit, B.DIRT, player)).toBe(false);
    expect(world.getBlock(9, FLOOR_Y + 1, 6)).toBe(B.BEDROCK);
  });

  it('can break dirt (it becomes AIR)', () => {
    const { world, player } = makeArena();
    world.setBlock(8, FLOOR_Y + 1, 5, B.DIRT);
    const hit = aim(world, player, 8.5, FLOOR_Y + 1.5, 5.5);
    expect(hit).toMatchObject({ x: 8, y: FLOOR_Y + 1, z: 5, id: B.DIRT, nx: -1, ny: 0, nz: 0 });
    expect(tryBreak(world, hit)).toBe(true);
    expect(world.getBlock(8, FLOOR_Y + 1, 5)).toBe(B.AIR);
    // Breaking the same (now stale) hit again does nothing.
    expect(tryBreak(world, hit)).toBe(false);
  });

  it('the ray ignores water: break targets the block behind the water', () => {
    const { world, player } = makeArena();
    world.setBlock(7, FLOOR_Y + 1, 5, B.WATER);
    world.setBlock(8, FLOOR_Y + 1, 5, B.WATER);
    world.setBlock(9, FLOOR_Y + 1, 5, B.DIRT);
    const hit = aim(world, player, 9.5, FLOOR_Y + 1.5, 5.5);
    expect(hit).toMatchObject({ x: 9, y: FLOOR_Y + 1, z: 5, id: B.DIRT, nx: -1, ny: 0, nz: 0 });
    expect(performAction('break', world, hit, null, player)).toBe(true);
    expect(world.getBlock(9, FLOOR_Y + 1, 5)).toBe(B.AIR);
    expect(world.getBlock(7, FLOOR_Y + 1, 5)).toBe(B.WATER);
    expect(world.getBlock(8, FLOOR_Y + 1, 5)).toBe(B.WATER);
    // Water itself is never broken, even with a hand-made hit.
    expect(tryBreak(world, { x: 7, y: FLOOR_Y + 1, z: 5 })).toBe(false);
    expect(tryBreak(world, null)).toBe(false);
    expect(tryBreak(world, { x: 12, y: FLOOR_Y + 5, z: 12 })).toBe(false); // air
  });
});

describe('performAction', () => {
  it("dispatches 'break' and 'place' and ignores anything else", () => {
    const { world, player } = makeArena();
    const hit = { x: 8, y: FLOOR_Y, z: 8, id: B.STONE, nx: 0, ny: 1, nz: 0 };
    expect(performAction('jump', world, hit, B.DIRT, player)).toBe(false);
    expect(performAction('place', world, hit, B.DIRT, player)).toBe(true);
    expect(world.getBlock(8, FLOOR_Y + 1, 8)).toBe(B.DIRT);
    expect(performAction('break', world, { x: 8, y: FLOOR_Y + 1, z: 8 }, B.DIRT, player)).toBe(true);
    expect(world.getBlock(8, FLOOR_Y + 1, 8)).toBe(B.AIR);
  });
});

describe('target outline', () => {
  it('is a hidden 1.002 wireframe cube until something is targeted', () => {
    const scene = new THREE.Scene();
    const outline = createTargetOutline(scene);
    const obj = outline.object;
    expect(obj).toBeInstanceOf(THREE.LineSegments);
    expect(obj.parent).toBe(scene);
    expect(obj.visible).toBe(false);
    expect(obj.geometry.getAttribute('position').count).toBe(24); // 12 edges
    obj.geometry.computeBoundingBox();
    expect(obj.geometry.boundingBox.max.x).toBeCloseTo(0.501, 6);
    expect(obj.material.transparent).toBe(true);

    outline.update({ x: -4, y: 12, z: 7 });
    expect(obj.visible).toBe(true);
    expect(obj.position.toArray()).toEqual([-3.5, 12.5, 7.5]);
    outline.update(null);
    expect(obj.visible).toBe(false);

    outline.dispose();
    expect(obj.parent).toBe(null);
  });
});
