// Hotbar: 9 slots at bottom center with isometric block icons (PROJECT.md section 7 HUD, Task 8).
//
// Pure helpers (wrapIndex, isoFaceMatrices, extractTile, snapAlpha) run in node for tests.
// DOM work happens only inside createHotbar().
//
// Icons: each block is drawn once onto a 64x64 canvas as a 2:1 isometric cube. Each 16x16 atlas
// tile is mapped onto its rhombus / parallelogram with ctx.setTransform (nearest neighbor, no
// smoothing). At 64 px every texel corner lands on a whole pixel, so the result is crisp, and
// at 32 CSS px (the desktop size) it maps 1:1 onto a 2x display. Side faces use pre-shaded
// copies of the tile (left 0.8, right 0.6) so transparency in leaves/glass is preserved.

import { TILE_SIZE } from '../config.js';
import { B, getBlockDef } from '../blocks.js';
import { tileOrigin } from '../render/tiles.js';

export const HOTBAR_SLOTS = 9;

/** Icon canvas size in px. A multiple of 4 * TILE_SIZE keeps every texel corner on a whole pixel. */
export const ICON_SIZE = 64;

/** Face brightness for icons (multiplies the tile's sRGB color, like the mesher's baked shading). */
export const ICON_SHADE = { top: 1, left: 0.8, right: 0.6, inside: 0.55 };

const NAME_VISIBLE_MS = 1300; // block name stays fully visible this long, then fades out (CSS)
const CLEAR_TILE_FRACTION = 0.5; // tiles with more clear pixels than this get a faint pane tint
const PANE_ALPHA = 46; // 0..255, opacity of that tint

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Wrap an integer index into 0..n-1 (works for negative i). Returns 0 when n < 1 or i isn't finite.
 * @param {number} i
 * @param {number} n
 */
export function wrapIndex(i, n) {
  if (!(n >= 1) || !Number.isFinite(i)) return 0;
  return ((Math.trunc(i) % n) + n) % n; // + n then % n also turns -0 into 0
}

/**
 * Affine matrices [a, b, c, d, e, f] (canvas setTransform order) that map a tile's pixel space
 * (u right, v down, 0..tile) onto the faces of a 2:1 isometric cube filling a size x size canvas.
 *
 * Silhouette: top vertex (size/2, 0), sides at y = size/4 .. 3*size/4, bottom vertex (size/2, size).
 * Side faces keep tile "up" pointing up, so grass sides and bark read correctly.
 * Back faces (backLeft, backRight, bottom) are only drawn for transparent blocks.
 *
 * @param {number} [size=ICON_SIZE]
 * @param {number} [tile=TILE_SIZE]
 */
export function isoFaceMatrices(size = ICON_SIZE, tile = TILE_SIZE) {
  const hx = size / 2 / tile; // screen x per texel along a horizontal cube edge
  const hy = size / 4 / tile; // screen y per texel along a horizontal cube edge
  const vy = size / 2 / tile; // screen y per texel down a vertical cube edge
  const cx = size / 2;
  const q = size / 4;
  return {
    top: [hx, hy, -hx, hy, cx, 0],
    left: [hx, hy, 0, vy, 0, q],
    right: [hx, -hy, 0, vy, cx, 2 * q],
    bottom: [hx, hy, -hx, hy, cx, 2 * q],
    backLeft: [hx, -hy, 0, vy, 0, q],
    backRight: [hx, hy, 0, vy, cx, 0],
  };
}

/**
 * Copy one tile out of an RGBA atlas buffer, multiplying RGB by `brightness` (alpha unchanged).
 * @param {Uint8ClampedArray|Uint8Array} atlas RGBA pixels, row 0 = top
 * @param {number} atlasWidth atlas width in px
 * @param {number} tileIndex
 * @param {number} [brightness=1]
 * @param {number} [tile=TILE_SIZE]
 * @returns {Uint8ClampedArray} tile * tile * 4 bytes
 */
export function extractTile(atlas, atlasWidth, tileIndex, brightness = 1, tile = TILE_SIZE) {
  const out = new Uint8ClampedArray(tile * tile * 4);
  const { x: ox, y: oy } = tileOrigin(tileIndex);
  for (let y = 0; y < tile; y++) {
    for (let x = 0; x < tile; x++) {
      const s = ((oy + y) * atlasWidth + ox + x) * 4;
      const d = (y * tile + x) * 4;
      out[d] = atlas[s] * brightness;
      out[d + 1] = atlas[s + 1] * brightness;
      out[d + 2] = atlas[s + 2] * brightness;
      out[d + 3] = atlas[s + 3];
    }
  }
  return out;
}

/**
 * Snap alpha to 0 or 255 in place (threshold 50%). Canvas anti-aliases the edges of transformed
 * images even with smoothing off; snapping gives hard pixel-art edges and closes hairline seams
 * between adjacent faces. Atlas alpha is already strictly 0 or 255, so tile content is unchanged.
 * @param {Uint8ClampedArray} data RGBA
 * @returns the same array
 */
export function snapAlpha(data) {
  for (let i = 3; i < data.length; i += 4) data[i] = data[i] >= 128 ? 255 : 0;
  return data;
}

/** Fraction of fully transparent pixels in an RGBA tile buffer, and the mean color of the rest. */
function tileClarity(rgba) {
  let clear = 0;
  let r = 0;
  let g = 0;
  let b = 0;
  const n = rgba.length / 4;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) {
      clear++;
    } else {
      r += rgba[i];
      g += rgba[i + 1];
      b += rgba[i + 2];
    }
  }
  const solid = n - clear || 1;
  return { clearFraction: clear / n, r: r / solid, g: g / solid, b: b / solid };
}

/** Fill still-transparent pixels inside the cube silhouette with a faint tint (glass panes). */
function tintPane(data, size, color) {
  const cx = size / 2;
  const q = size / 4;
  for (let y = 0; y < size; y++) {
    const py = y + 0.5;
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (data[i + 3] !== 0) continue;
      const t = Math.abs(x + 0.5 - cx) / cx; // 0 at the center line, 1 at the sides
      if (t > 1 || py < q * t || py > size - q * t) continue;
      data[i] = color.r;
      data[i + 1] = color.g;
      data[i + 2] = color.b;
      data[i + 3] = PANE_ALPHA;
    }
  }
}

// ---------------------------------------------------------------------------
// Icon rendering (browser only)
// ---------------------------------------------------------------------------

/** Builds and caches pre-shaded 16x16 tile canvases from one read of the atlas. */
function createTileSource(atlasCanvas) {
  const w = atlasCanvas.width;
  // One readback of the whole atlas (several small reads trigger a Chrome performance warning).
  const pixels = atlasCanvas.getContext('2d').getImageData(0, 0, w, atlasCanvas.height).data;
  const cache = new Map();
  return {
    pixels,
    width: w,
    get(tileIndex, brightness) {
      const key = `${tileIndex}:${brightness}`;
      let canvas = cache.get(key);
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = TILE_SIZE;
        canvas.height = TILE_SIZE;
        const data = extractTile(pixels, w, tileIndex, brightness);
        canvas.getContext('2d').putImageData(new ImageData(data, TILE_SIZE, TILE_SIZE), 0, 0);
        cache.set(key, canvas);
      }
      return canvas;
    },
  };
}

function drawFace(ctx, src, m) {
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  ctx.drawImage(src, 0, 0);
}

/** Draw block `id` as an isometric cube onto a size x size canvas context. */
function drawBlockIcon(ctx, tiles, id, size) {
  const def = getBlockDef(id);
  const m = isoFaceMatrices(size, TILE_SIZE);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, size, size);
  if (def.id === B.AIR) return;
  ctx.imageSmoothingEnabled = false;

  const { top, side, bottom } = def.tiles;
  if (def.transparent) {
    // Insides seen through holes / clear panes: back walls and floor, darker.
    drawFace(ctx, tiles.get(side, ICON_SHADE.inside), m.backLeft);
    drawFace(ctx, tiles.get(side, ICON_SHADE.inside), m.backRight);
    drawFace(ctx, tiles.get(bottom, ICON_SHADE.inside), m.bottom);
  }
  drawFace(ctx, tiles.get(top, ICON_SHADE.top), m.top);
  drawFace(ctx, tiles.get(side, ICON_SHADE.left), m.left);
  drawFace(ctx, tiles.get(side, ICON_SHADE.right), m.right);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const image = ctx.getImageData(0, 0, size, size);
  snapAlpha(image.data);
  if (def.transparent) {
    const clarity = tileClarity(extractTile(tiles.pixels, tiles.width, side));
    if (clarity.clearFraction > CLEAR_TILE_FRACTION) tintPane(image.data, size, clarity);
  }
  ctx.putImageData(image, 0, 0);
}

// ---------------------------------------------------------------------------
// Hotbar UI
// ---------------------------------------------------------------------------

/**
 * Create the hotbar.
 *
 * @param {HTMLElement} container element to append the hotbar to (e.g. document.body)
 * @param {object} options
 * @param {HTMLCanvasElement} options.atlasCanvas the painted atlas canvas (createAtlas().canvas)
 * @param {number[]} options.blocks block ids for slots 1-9 (HOTBAR_BLOCKS); missing = empty slot
 * @returns {{
 *   getSelectedIndex: () => number,
 *   setSelectedIndex: (i: number) => void,
 *   getSelectedBlock: () => number,
 *   scroll: (steps: number) => void,
 *   dispose: () => void,
 * }}
 *   getSelectedBlock() returns the selected slot's block id, or B.AIR (0) for an empty slot.
 *   scroll(steps): positive = right, wraps around. setSelectedIndex clamps out-of-range numbers
 *   and ignores non-numbers. Changing the selection shows the block name briefly.
 */
export function createHotbar(container, { atlasCanvas, blocks = [] } = {}) {
  const slotBlocks = [];
  for (let i = 0; i < HOTBAR_SLOTS; i++) slotBlocks.push(getBlockDef(blocks[i] ?? B.AIR).id);

  const root = document.createElement('div');
  root.className = 'vs-ui vs-hotbar-wrap';

  const nameEl = document.createElement('div');
  nameEl.className = 'vs-hotbar__name';
  nameEl.setAttribute('aria-live', 'polite');
  root.appendChild(nameEl);

  const bar = document.createElement('div');
  bar.className = 'vs-hotbar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Hotbar');
  root.appendChild(bar);

  const tiles = atlasCanvas ? createTileSource(atlasCanvas) : null;
  const slotEls = [];
  for (let i = 0; i < HOTBAR_SLOTS; i++) {
    const id = slotBlocks[i];
    const slot = document.createElement('div');
    slot.className = 'vs-slot';
    if (id === B.AIR) slot.classList.add('vs-slot--empty');
    slot.title = id === B.AIR ? '' : getBlockDef(id).name;

    const num = document.createElement('span');
    num.className = 'vs-slot__num';
    num.textContent = String(i + 1);
    slot.appendChild(num);

    if (id !== B.AIR && tiles) {
      const canvas = document.createElement('canvas');
      canvas.className = 'vs-slot__icon';
      canvas.width = ICON_SIZE;
      canvas.height = ICON_SIZE;
      // willReadFrequently: one getImageData per icon without Chrome's readback warning.
      drawBlockIcon(canvas.getContext('2d', { willReadFrequently: true }), tiles, id, ICON_SIZE);
      slot.appendChild(canvas);
    }

    bar.appendChild(slot);
    slotEls.push(slot);
  }

  container.appendChild(root);

  let selected = 0;
  let nameTimer = 0;
  slotEls[selected].classList.add('is-selected');

  function showName(id) {
    clearTimeout(nameTimer);
    if (id === B.AIR) {
      nameEl.classList.remove('is-visible');
      return;
    }
    nameEl.textContent = getBlockDef(id).name;
    nameEl.classList.add('is-visible');
    nameTimer = setTimeout(() => nameEl.classList.remove('is-visible'), NAME_VISIBLE_MS);
  }

  function select(i) {
    if (i === selected) return;
    slotEls[selected].classList.remove('is-selected');
    selected = i;
    slotEls[selected].classList.add('is-selected');
    showName(slotBlocks[selected]);
  }

  return {
    getSelectedIndex() {
      return selected;
    },

    setSelectedIndex(i) {
      if (typeof i !== 'number' || Number.isNaN(i)) return;
      const n = Math.trunc(Math.min(HOTBAR_SLOTS - 1, Math.max(0, i)));
      select(n);
    },

    getSelectedBlock() {
      return slotBlocks[selected];
    },

    scroll(steps) {
      if (typeof steps !== 'number' || !Number.isFinite(steps)) return;
      const s = Math.trunc(steps);
      if (s !== 0) select(wrapIndex(selected + s, HOTBAR_SLOTS));
    },

    dispose() {
      clearTimeout(nameTimer);
      root.remove();
    },
  };
}
