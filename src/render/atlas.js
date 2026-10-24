// Procedural texture atlas (PROJECT.md Task 2).
//
// All textures are painted in code: a 256x256 RGBA atlas of 16x16 pixel-art
// tiles, deterministic for a given seed. `paintAtlasPixels` is pure (no DOM,
// no WebGL) so it can be unit tested in node; `createAtlasCanvas` and
// `createAtlasTexture` wrap it for the browser.
//
// Tile layout and UV convention live in ./tiles.js (pure, shared with the mesher).

import { CanvasTexture, NearestFilter, SRGBColorSpace } from 'three';
import alea from 'alea';
import { TILE_SIZE } from '../config.js';
import { TILES, ATLAS_SIZE, tileOrigin } from './tiles.js';

export { TILES, ATLAS_SIZE, tileUV, tileUVInto, tileOrigin } from './tiles.js';

const S = TILE_SIZE;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** Pick from a dark-to-light palette with t in [0, 1]. */
function pick(palette, t) {
  const i = Math.floor(t * palette.length);
  return palette[i < 0 ? 0 : i >= palette.length ? palette.length - 1 : i];
}

/**
 * Smooth value noise in [0, 1] that wraps every TILE_SIZE pixels, so tiles
 * repeat seamlessly across neighbouring blocks. `cells` = grid cells per tile.
 */
function makeValueNoise(rng, cells) {
  const grid = new Float32Array(cells * cells);
  for (let i = 0; i < grid.length; i++) grid[i] = rng();
  const step = S / cells;
  const at = (i, j) => grid[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)];
  return (x, y) => {
    const fx = (x + 0.5) / step - 0.5;
    const fy = (y + 0.5) / step - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    let tx = fx - x0;
    let ty = fy - y0;
    tx = tx * tx * (3 - 2 * tx);
    ty = ty * ty * (3 - 2 * ty);
    const a = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
    const b = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
    return a + (b - a) * ty;
  };
}

/** Wrapped signed offset between two coordinates on a TILE_SIZE torus. */
function wrapDelta(d) {
  if (d > S / 2) return d - S;
  if (d < -S / 2) return d + S;
  return d;
}

// ---------------------------------------------------------------------------
// Palettes (dark to light)
// ---------------------------------------------------------------------------

const GRASS = [[62, 112, 36], [76, 132, 44], [89, 148, 52], [100, 161, 58], [116, 176, 68]];
const DIRT = [[96, 67, 45], [115, 82, 56], [134, 96, 67], [150, 109, 76]];
const BARK = [[70, 52, 32], [86, 65, 40], [103, 79, 49], [118, 92, 58]];
const LEAF = [[34, 84, 26], [46, 104, 32], [58, 122, 40], [74, 140, 50]];
const WATER = [[36, 72, 170], [44, 86, 190], [52, 98, 204], [64, 114, 214]];
const BEDROCK = [[16, 16, 16], [32, 32, 33], [50, 50, 51], [74, 74, 75], [100, 100, 101]];

// ---------------------------------------------------------------------------
// Tile painters. Each receives a seeded rng and set(x, y, r, g, b, a = 255),
// with (0, 0) at the tile's top-left pixel.
// ---------------------------------------------------------------------------

function setColor(set, x, y, c, f = 1, a = 255) {
  set(x, y, c[0] * f, c[1] * f, c[2] * f, a);
}

const jitter = (rng, amount) => 1 + (rng() * 2 - 1) * amount;

function paintGrassTop(rng, set) {
  const n = makeValueNoise(rng, 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = n(x, y) * 0.55 + rng() * 0.45;
      setColor(set, x, y, pick(GRASS, t), jitter(rng, 0.04));
    }
  }
}

function paintDirt(rng, set) {
  const n = makeValueNoise(rng, 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = rng();
      let c;
      if (r < 0.06) c = [78, 55, 37];        // dark speck
      else if (r < 0.09) c = [168, 128, 92]; // light speck
      else if (r < 0.11) c = [122, 116, 108]; // tiny pebble
      else c = pick(DIRT, n(x, y) * 0.5 + rng() * 0.5);
      setColor(set, x, y, c, jitter(rng, 0.03));
    }
  }
}

function paintGrassSide(rng, set) {
  paintDirt(rng, set);
  // Jagged green fringe hanging from the top edge: mostly 3-4 px, a few drips.
  for (let x = 0; x < S; x++) {
    let depth = 3 + (rng() < 0.5 ? 1 : 0);
    if (rng() < 0.12) depth += 2;
    else if (rng() < 0.1) depth -= 1;
    for (let y = 0; y < depth; y++) {
      const c = y === depth - 1 ? GRASS[0] : pick(GRASS, 0.2 + rng() * 0.8);
      setColor(set, x, y, c, jitter(rng, 0.04));
    }
  }
}

function paintStone(rng, set) {
  const n1 = makeValueNoise(rng, 4);
  const n2 = makeValueNoise(rng, 8);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let g = 128 + (rng() * 2 - 1) * 9;
      const m = n1(x, y) * 0.65 + n2(x, y) * 0.35;
      if (m < 0.33) g -= 24;      // darker blotch
      else if (m < 0.4) g -= 11;  // blotch rim
      else if (m > 0.74) g += 10; // lighter patch
      if (rng() < 0.04) g = 96;   // speck
      set(x, y, g, g, g + 2);
    }
  }
}

function paintCobblestone(rng, set) {
  // Wrapping Voronoi cells = rounded stones; cell borders = dark mortar.
  const grid = 3;
  const cell = S / grid;
  const stones = [];
  for (let j = 0; j < grid; j++) {
    for (let i = 0; i < grid; i++) {
      stones.push({
        x: (i + 0.2 + rng() * 0.6) * cell,
        y: (j + 0.2 + rng() * 0.6) * cell,
        tone: 104 + rng() * 44,
      });
    }
  }
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let d1 = Infinity;
      let d2 = Infinity;
      let near = null;
      let ox = 0;
      let oy = 0;
      for (const s of stones) {
        const dx = wrapDelta(x + 0.5 - s.x);
        const dy = wrapDelta(y + 0.5 - s.y);
        const d = Math.hypot(dx, dy);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          near = s;
          ox = dx;
          oy = dy;
        } else if (d < d2) {
          d2 = d;
        }
      }
      const edge = d2 - d1;
      let g;
      if (edge < 1.1) {
        g = 56 + rng() * 12; // mortar
      } else {
        g = near.tone - ((ox + oy) / cell) * 22; // lit from the top-left
        if (edge < 2.1) g -= 14;                 // darken rim: rounded look
        g *= jitter(rng, 0.05);
      }
      set(x, y, g, g, g + 1);
    }
  }
}

function paintSand(rng, set) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const r = rng();
      let c = [219, 207, 160];
      if (r < 0.07) c = [198, 184, 136];
      else if (r < 0.1) c = [234, 225, 184];
      else if (r < 0.11) c = [172, 160, 128];
      setColor(set, x, y, c, jitter(rng, 0.025));
    }
  }
}

function paintLogSide(rng, set) {
  // Vertical bark stripes 1-2 px wide alternating dark and light.
  const colTone = new Int8Array(S);
  let x = 0;
  let dark = rng() < 0.5;
  while (x < S) {
    const w = 1 + Math.floor(rng() * 2);
    const tone = dark ? Math.floor(rng() * 2) : 2 + Math.floor(rng() * 2);
    for (let k = 0; k < w && x < S; k++, x++) colTone[x] = tone;
    dark = !dark;
  }
  for (let y = 0; y < S; y++) {
    for (let x2 = 0; x2 < S; x2++) {
      let t = colTone[x2];
      const r = rng();
      if (r < 0.08) t = Math.max(0, t - 1);
      else if (r < 0.14) t = Math.min(BARK.length - 1, t + 1);
      const c = rng() < 0.035 ? [54, 40, 24] : BARK[t]; // occasional crack
      setColor(set, x2, y, c, jitter(rng, 0.03));
    }
  }
}

function paintLogTop(rng, set) {
  const c = (S - 1) / 2;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (x === 0 || y === 0 || x === S - 1 || y === S - 1) {
        setColor(set, x, y, BARK[Math.floor(rng() * 3)], jitter(rng, 0.04)); // bark edge
        continue;
      }
      const dist = Math.hypot(x - c, y - c) + (rng() - 0.5) * 0.5;
      let col;
      if (dist < 1.1) col = [128, 96, 56]; // pith
      else col = Math.floor(dist / 1.5) % 2 === 0 ? [182, 148, 94] : [150, 116, 70];
      setColor(set, x, y, col, jitter(rng, 0.035));
    }
  }
}

function paintPlanks(rng, set) {
  const board = 4; // px per board, including its 1 px seam row
  const seam = [92, 70, 42];
  const nail = [62, 48, 30];
  const boards = S / board;
  for (let b = 0; b < boards; b++) {
    const shade = 0.93 + rng() * 0.12;
    const joint = (b % 2 === 0 ? 4 : 12) + Math.floor(rng() * 3) - 1;
    for (let r = 0; r < board; r++) {
      const y = b * board + r;
      const rowShade = 0.96 + rng() * 0.08;
      for (let x = 0; x < S; x++) {
        if (r === board - 1) {
          setColor(set, x, y, seam, jitter(rng, 0.04));
        } else if (x === joint) {
          setColor(set, x, y, seam, jitter(rng, 0.04));
        } else {
          const grain = rng() < 0.1 ? 0.88 : 1;
          setColor(set, x, y, [165, 132, 80], shade * rowShade * grain * jitter(rng, 0.025));
        }
      }
    }
    // A few nail dots next to the joint.
    const ny = b * board + 1;
    setColor(set, (joint + 2) % S, ny, nail);
    if (rng() < 0.5) setColor(set, (joint + S - 2) % S, ny, nail);
  }
}

function paintLeaves(rng, set) {
  const n = makeValueNoise(rng, 4);
  // Exactly 25% of pixels become fully transparent holes.
  const order = Array.from({ length: S * S }, (_, i) => i);
  const holes = Math.round(S * S * 0.25);
  for (let i = 0; i < holes; i++) {
    const j = i + Math.floor(rng() * (order.length - i));
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  const isHole = new Uint8Array(S * S);
  for (let i = 0; i < holes; i++) isHole[order[i]] = 1;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      if (isHole[y * S + x]) {
        setColor(set, x, y, LEAF[0], 1, 0); // keep a leaf color under the hole to avoid halos
        continue;
      }
      const t = n(x, y) * 0.4 + rng() * 0.6;
      setColor(set, x, y, pick(LEAF, t), jitter(rng, 0.05));
    }
  }
}

function paintGlass(rng, set) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const edgeX = x === 0 || x === S - 1;
      const edgeY = y === 0 || y === S - 1;
      if (edgeX && edgeY) setColor(set, x, y, [176, 202, 212]);                    // corner
      else if (edgeX || edgeY) setColor(set, x, y, [208, 230, 238], jitter(rng, 0.03)); // frame
      else setColor(set, x, y, [220, 236, 242], 1, 0);                              // clear pane
    }
  }
  // Glints: a short diagonal streak near the top-left and a dot near the bottom-right.
  const glint = [255, 255, 255];
  setColor(set, 3, 5, glint);
  setColor(set, 4, 4, glint);
  setColor(set, 5, 3, glint);
  setColor(set, 11, 12, glint);
  setColor(set, 12, 11, glint);
}

function paintWater(rng, set) {
  const n = makeValueNoise(rng, 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = n(x, y) * 0.6 + rng() * 0.4;
      setColor(set, x, y, pick(WATER, t), jitter(rng, 0.03));
    }
  }
  // Wavy highlight streaks (alpha stays 255; the water material sets opacity).
  for (let k = 0; k < 4; k++) {
    const baseRow = k * 4 + 1;
    const phase = rng() * Math.PI * 2;
    const start = Math.floor(rng() * S);
    const len = 4 + Math.floor(rng() * 3);
    for (let i = 0; i < len; i++) {
      const x = (start + i) % S;
      const y = (((baseRow + Math.round(Math.sin((2 * Math.PI * x) / 8 + phase))) % S) + S) % S;
      setColor(set, x, y, [104, 154, 230], jitter(rng, 0.03));
    }
  }
}

function paintBedrock(rng, set) {
  const n1 = makeValueNoise(rng, 4);
  const n2 = makeValueNoise(rng, 8);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const t = n1(x, y) * 0.45 + n2(x, y) * 0.25 + rng() * 0.3;
      setColor(set, x, y, pick(BEDROCK, t * t * 1.25), jitter(rng, 0.05));
    }
  }
}

const PAINTERS = {
  GRASS_TOP: paintGrassTop,
  GRASS_SIDE: paintGrassSide,
  DIRT: paintDirt,
  STONE: paintStone,
  COBBLESTONE: paintCobblestone,
  SAND: paintSand,
  LOG_SIDE: paintLogSide,
  LOG_TOP: paintLogTop,
  PLANKS: paintPlanks,
  LEAVES: paintLeaves,
  GLASS: paintGlass,
  WATER: paintWater,
  BEDROCK: paintBedrock,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Paint every tile into an RGBA buffer. PURE: no DOM, deterministic per seed.
 * Unused atlas cells are left fully transparent (0, 0, 0, 0).
 * @param {number} [seed=1337]
 * @returns {Uint8ClampedArray} ATLAS_SIZE * ATLAS_SIZE * 4 bytes, row 0 = top
 */
export function paintAtlasPixels(seed = 1337) {
  const W = ATLAS_SIZE;
  const data = new Uint8ClampedArray(W * W * 4);
  for (const [name, index] of Object.entries(TILES)) {
    const painter = PAINTERS[name];
    if (!painter) throw new Error(`No painter for tile ${name}`);
    const { x: ox, y: oy } = tileOrigin(index);
    // Each tile gets its own stream so tiles don't shift when another changes.
    const rng = alea(seed, name);
    const set = (x, y, r, g, b, a = 255) => {
      const i = ((oy + y) * W + (ox + x)) * 4;
      data[i] = clamp255(r);
      data[i + 1] = clamp255(g);
      data[i + 2] = clamp255(b);
      data[i + 3] = clamp255(a);
    };
    painter(rng, set);
  }
  return data;
}

/**
 * A 256x256 canvas holding the painted atlas (browser only).
 * @param {number} [seed=1337]
 * @returns {HTMLCanvasElement}
 */
export function createAtlasCanvas(seed = 1337) {
  const canvas = document.createElement('canvas');
  canvas.width = ATLAS_SIZE;
  canvas.height = ATLAS_SIZE;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(ATLAS_SIZE, ATLAS_SIZE);
  image.data.set(paintAtlasPixels(seed));
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Wrap an atlas canvas in a pixel-crisp texture: nearest filtering, no
 * mipmaps (prevents bleeding between tiles), sRGB, default flipY = true
 * (tiles.js UVs assume it).
 * @param {HTMLCanvasElement} canvas
 * @returns {CanvasTexture}
 */
export function createAtlasTexture(canvas) {
  const texture = new CanvasTexture(canvas);
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Convenience: build the canvas and its texture together.
 * @param {number} [seed=1337]
 * @returns {{ canvas: HTMLCanvasElement, texture: CanvasTexture }}
 */
export function createAtlas(seed = 1337) {
  const canvas = createAtlasCanvas(seed);
  return { canvas, texture: createAtlasTexture(canvas) };
}
