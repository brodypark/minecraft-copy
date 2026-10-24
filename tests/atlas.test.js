import { describe, it, expect } from 'vitest';
import { TILE_SIZE } from '../src/config.js';
import { paintAtlasPixels, TILES, ATLAS_SIZE, tileOrigin } from '../src/render/atlas.js';

const pixels = paintAtlasPixels(1337);
const S = TILE_SIZE;

/** Copy one tile's RGBA pixels out of the atlas buffer. */
function tilePixels(data, tile) {
  const { x: ox, y: oy } = tileOrigin(tile);
  const out = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    const start = ((oy + y) * ATLAS_SIZE + ox) * 4;
    out.set(data.subarray(start, start + S * 4), y * S * 4);
  }
  return out;
}

const alphaAt = (tile, x, y) => tile[(y * S + x) * 4 + 3];

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

describe('atlas pixels', () => {
  it('is a 256x256 RGBA buffer', () => {
    expect(pixels).toBeInstanceOf(Uint8ClampedArray);
    expect(pixels.length).toBe(256 * 256 * 4);
    expect(ATLAS_SIZE).toBe(256);
  });

  it('is deterministic for the same seed and differs for another seed', () => {
    expect(sameBytes(paintAtlasPixels(1337), pixels)).toBe(true);
    expect(sameBytes(paintAtlasPixels(42), pixels)).toBe(false);
  });

  it('default seed is 1337', () => {
    expect(sameBytes(paintAtlasPixels(), pixels)).toBe(true);
  });

  it('every used tile is distinct from every other used tile', () => {
    const entries = Object.entries(TILES).map(([name, t]) => [name, tilePixels(pixels, t)]);
    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        expect(sameBytes(entries[i][1], entries[j][1]), `${entries[i][0]} vs ${entries[j][0]}`).toBe(false);
      }
    }
  });

  it('every used tile is painted (not blank)', () => {
    for (const [name, t] of Object.entries(TILES)) {
      const tile = tilePixels(pixels, t);
      let opaque = 0;
      for (let i = 3; i < tile.length; i += 4) if (tile[i] === 255) opaque++;
      expect(opaque, name).toBeGreaterThan(0);
    }
  });

  it('opaque tiles have alpha 255 everywhere (water included)', () => {
    for (const [name, t] of Object.entries(TILES)) {
      if (name === 'LEAVES' || name === 'GLASS') continue;
      const tile = tilePixels(pixels, t);
      for (let i = 3; i < tile.length; i += 4) {
        if (tile[i] !== 255) throw new Error(`${name} has alpha ${tile[i]} at pixel ${(i - 3) / 4}`);
      }
    }
  });

  it('alpha is binary (0 or 255) in cutout tiles so alphaTest is clean', () => {
    for (const name of ['LEAVES', 'GLASS']) {
      const tile = tilePixels(pixels, TILES[name]);
      for (let i = 3; i < tile.length; i += 4) expect([0, 255]).toContain(tile[i]);
    }
  });

  it('leaves have roughly 20-30% transparent holes', () => {
    for (const seed of [1337, 1, 99999]) {
      const tile = tilePixels(paintAtlasPixels(seed), TILES.LEAVES);
      let holes = 0;
      for (let i = 3; i < tile.length; i += 4) if (tile[i] === 0) holes++;
      const frac = holes / (S * S);
      expect(frac).toBeGreaterThanOrEqual(0.2);
      expect(frac).toBeLessThanOrEqual(0.3);
    }
  });

  it('glass has an opaque 1px border and a mostly transparent interior', () => {
    const tile = tilePixels(pixels, TILES.GLASS);
    let clear = 0;
    let interior = 0;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const border = x === 0 || y === 0 || x === S - 1 || y === S - 1;
        if (border) {
          expect(alphaAt(tile, x, y)).toBe(255);
        } else {
          interior++;
          if (alphaAt(tile, x, y) === 0) clear++;
        }
      }
    }
    expect(clear / interior).toBeGreaterThan(0.9);
    expect(clear).toBeLessThan(interior); // a few glint pixels
  });

  it('grass side has a green top fringe over a brown dirt body', () => {
    const tile = tilePixels(pixels, TILES.GRASS_SIDE);
    const rgb = (x, y) => tile.subarray((y * S + x) * 4, (y * S + x) * 4 + 3);
    for (let x = 0; x < S; x++) {
      const [r, g, b] = rgb(x, 0);
      expect(g, `top row x=${x}`).toBeGreaterThan(r);
      expect(g).toBeGreaterThan(b);
      const [r2, g2] = rgb(x, S - 1);
      expect(r2, `bottom row x=${x}`).toBeGreaterThan(g2 - 1);
    }
  });

  it('unused atlas cells stay fully transparent', () => {
    const used = new Set(Object.values(TILES));
    const unused = [...Array(256).keys()].filter((t) => !used.has(t));
    for (const t of unused.slice(0, 20)) {
      const tile = tilePixels(pixels, t);
      expect(tile.every((v) => v === 0)).toBe(true);
    }
  });
});
