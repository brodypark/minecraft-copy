// Block IDs and the block registry (PROJECT.md section 5.2).

export const B = {
  AIR: 0, GRASS: 1, DIRT: 2, STONE: 3, COBBLESTONE: 4, SAND: 5,
  LOG: 6, PLANKS: 7, LEAVES: 8, GLASS: 9, WATER: 10, BEDROCK: 11,
};

// Registry indexed by block id. `tiles` are atlas tile indices.
// TODO(Task 2): tiles are placeholders (all 0); Task 2 assigns the real atlas tiles.
export const BLOCKS = [
  { id: B.AIR,         name: 'Air',         solid: false, transparent: true,  placeable: false, breakable: false, tiles: { top: 0, bottom: 0, side: 0 } },
  { id: B.GRASS,       name: 'Grass',       solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: { top: 0, bottom: 0, side: 0 } },
  { id: B.DIRT,        name: 'Dirt',        solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: { top: 0, bottom: 0, side: 0 } },
  { id: B.STONE,       name: 'Stone',       solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: { top: 0, bottom: 0, side: 0 } },
  { id: B.COBBLESTONE, name: 'Cobblestone', solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: { top: 0, bottom: 0, side: 0 } },
  { id: B.SAND,        name: 'Sand',        solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: { top: 0, bottom: 0, side: 0 } },
  { id: B.LOG,         name: 'Log',         solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: { top: 0, bottom: 0, side: 0 } },
  { id: B.PLANKS,      name: 'Planks',      solid: true,  transparent: false, placeable: true,  breakable: true,  tiles: { top: 0, bottom: 0, side: 0 } },
  { id: B.LEAVES,      name: 'Leaves',      solid: true,  transparent: true,  placeable: true,  breakable: true,  tiles: { top: 0, bottom: 0, side: 0 } },
  { id: B.GLASS,       name: 'Glass',       solid: true,  transparent: true,  placeable: true,  breakable: true,  tiles: { top: 0, bottom: 0, side: 0 } },
  { id: B.WATER,       name: 'Water',       solid: false, transparent: true,  placeable: false, breakable: false, tiles: { top: 0, bottom: 0, side: 0 } },
  { id: B.BEDROCK,     name: 'Bedrock',     solid: true,  transparent: false, placeable: false, breakable: false, tiles: { top: 0, bottom: 0, side: 0 } },
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
