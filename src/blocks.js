// Block IDs and the block registry (PROJECT.md section 5.2).
// Pure module: no three.js or DOM imports (the mesher and physics use it).

import { TILES as T } from './render/tiles.js';

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, COBBLESTONE: 4, SAND: 5,
  LOG: 6, PLANKS: 7, LEAVES: 8, GLASS: 9, WATER: 10, BEDROCK: 11,
};

// Registry indexed by block id. `tiles` are atlas tile indices (see render/tiles.js).
// Air is never meshed, so its tiles are unused placeholders.
const all = (t) => ({ top: t, bottom: t, side: t });
export const BLOCKS = [
  { id: B.AIR,         name: 'Air',         solid: false, transparent: true,  placeable: false, breakable: false, tiles: { top: 0, bottom: 0, side: 0 } /* unused */ },
  { id: B.GRASS,       name: 'Grass',       solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: { top: T.GRASS_TOP, bottom: T.DIRT, side: T.GRASS_SIDE } },
  { id: B.DIRT,        name: 'Dirt',        solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: all(T.DIRT) },
  { id: B.STONE,       name: 'Stone',       solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: all(T.STONE) },
  { id: B.COBBLESTONE, name: 'Cobblestone', solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: all(T.COBBLESTONE) },
  { id: B.SAND,        name: 'Sand',        solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: all(T.SAND) },
  { id: B.LOG,         name: 'Log',         solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: { top: T.LOG_TOP, bottom: T.LOG_TOP, side: T.LOG_SIDE } },
  { id: B.PLANKS,      name: 'Planks',      solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: all(T.PLANKS) },
  { id: B.LEAVES,      name: 'Leaves',      solid: true,  transparent: true,  placeable: true,  breakable: true,  tiles: all(T.LEAVES) },
  { id: B.GLASS,       name: 'Glass',       solid: true,  transparent: true,  placeable: true,  breakable: true,  tiles: all(T.GLASS) },
  { id: B.WATER,       name: 'Water',       solid: false, transparent: true,  placeable: false, breakable: false, tiles: all(T.WATER) },
  { id: B.BEDROCK,     name: 'Bedrock',     solid: true,  transparent: false, placeable: false, breakable: false, tiles: all(T.BEDROCK) },
];

// Hotbar order, slots 1-9.
export const HOTBAR_BLOCKS = [B.GRASS, B.DIRT, B.STONE, B.COBBLESTONE, B.SAND, B.LOG, B.PLANKS, B.LEAVES, B.GLASS];

// Flat lookup tables for the mesher/physics hot loops, built once from BLOCKS.
// Unknown ids behave like air: not solid, transparent, not placeable, not breakable.
const SOLID = new Uint8Array(256);
const OPAQUE = new Uint8Array(256); // stored inverted so unknown ids (0 or out of range) read as transparent
const PLACEABLE = new Uint8Array(256);
const BREAKABLE = new Uint8Array(256);
for (const def of BLOCKS) {
  SOLID[def.id] = def.solid ? 1 : 0;
  OPAQUE[def.id] = def.transparent ? 0 : 1;
  PLACEABLE[def.id] = def.placeable ? 1 : 0;
  BREAKABLE[def.id] = def.breakable ? 1 : 0;
}

export function getBlockDef(id) {
  return BLOCKS[id] || BLOCKS[B.AIR];
}

export function isSolid(id) {
  return SOLID[id] === 1;
}

export function isTransparent(id) {
  return OPAQUE[id] !== 1;
}

export function isPlaceable(id) {
  return PLACEABLE[id] === 1;
}

export function isBreakable(id) {
  return BREAKABLE[id] === 1;
}
