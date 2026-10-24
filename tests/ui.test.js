// Pure UI helpers (Task 8). Runs in node: importing the UI modules must not touch the DOM.
import { describe, it, expect } from 'vitest';
import { TILE_SIZE } from '../src/config.js';
import { HOTBAR_BLOCKS } from '../src/blocks.js';
import { paintAtlasPixels, ATLAS_SIZE, TILES, tileOrigin } from '../src/render/atlas.js';
import { wrapIndex, isoFaceMatrices, extractTile, snapAlpha, ICON_SIZE, HOTBAR_SLOTS } from '../src/ui/hotbar.js';
import { facingFromYaw, formatTimeOfDay, createFrameStats, debugRows } from '../src/ui/debug.js';
import { createHud } from '../src/ui/hud.js';

const PI = Math.PI;

describe('wrapIndex', () => {
  it('leaves in-range indices alone', () => {
    for (let i = 0; i < 9; i++) expect(wrapIndex(i, 9)).toBe(i);
  });

  it('wraps past either end', () => {
    expect(wrapIndex(9, 9)).toBe(0);
    expect(wrapIndex(10, 9)).toBe(1);
    expect(wrapIndex(-1, 9)).toBe(8);
    expect(wrapIndex(-9, 9)).toBe(0);
    expect(wrapIndex(-10, 9)).toBe(8);
    expect(wrapIndex(8 + 3 * 9, 9)).toBe(8);
  });

  it('is safe with degenerate input', () => {
    expect(wrapIndex(3, 0)).toBe(0);
    expect(wrapIndex(NaN, 9)).toBe(0);
    expect(wrapIndex(Infinity, 9)).toBe(0);
  });

  it('hotbar has 9 slots for the 9 placeable blocks', () => {
    expect(HOTBAR_SLOTS).toBe(9);
    expect(HOTBAR_BLOCKS).toHaveLength(HOTBAR_SLOTS);
  });
});

describe('facingFromYaw', () => {
  it('maps the four cardinal yaws (yaw 0 looks toward -Z, +PI/2 toward -X)', () => {
    expect(facingFromYaw(0)).toBe('north (-Z)');
    expect(facingFromYaw(PI / 2)).toBe('west (-X)');
    expect(facingFromYaw(PI)).toBe('south (+Z)');
    expect(facingFromYaw(-PI)).toBe('south (+Z)');
    expect(facingFromYaw((3 * PI) / 2)).toBe('east (+X)');
    expect(facingFromYaw(-PI / 2)).toBe('east (+X)');
  });

  it('picks the nearest direction for in-between angles', () => {
    expect(facingFromYaw(0.3)).toBe('north (-Z)');
    expect(facingFromYaw(-0.6)).toBe('north (-Z)');
    expect(facingFromYaw(PI / 4 + 0.1)).toBe('west (-X)');
    expect(facingFromYaw(PI / 2 + 0.6)).toBe('west (-X)');
    expect(facingFromYaw(PI - 0.5)).toBe('south (+Z)');
    expect(facingFromYaw(-PI + 0.5)).toBe('south (+Z)');
    expect(facingFromYaw(-PI / 2 - 0.5)).toBe('east (+X)');
    expect(facingFromYaw(-PI / 4 - 0.1)).toBe('east (+X)');
  });

  it('handles yaw beyond +-2PI', () => {
    expect(facingFromYaw(2 * PI)).toBe('north (-Z)');
    expect(facingFromYaw(2 * PI + PI)).toBe('south (+Z)');
    expect(facingFromYaw(4 * PI + PI / 2 + 0.2)).toBe('west (-X)');
    expect(facingFromYaw(-2 * PI - PI / 2)).toBe('east (+X)');
    expect(facingFromYaw(-6 * PI + 0.1)).toBe('north (-Z)');
  });

  it('agrees with the dominant axis of the view direction (-sin yaw, -cos yaw)', () => {
    for (let deg = -720; deg <= 720; deg += 7) {
      if (Math.abs((((deg % 90) + 90) % 90) - 45) < 2) continue; // skip near-diagonals
      const yaw = (deg * PI) / 180;
      const dx = -Math.sin(yaw);
      const dz = -Math.cos(yaw);
      const expected = Math.abs(dx) > Math.abs(dz)
        ? (dx > 0 ? 'east (+X)' : 'west (-X)')
        : (dz > 0 ? 'south (+Z)' : 'north (-Z)');
      expect(facingFromYaw(yaw), `yaw ${deg} deg`).toBe(expected);
    }
  });

  it('returns a placeholder for non-finite yaw', () => {
    expect(facingFromYaw(NaN)).toBe('-');
  });
});

describe('formatTimeOfDay', () => {
  it('formats key times as 24-hour HH:MM', () => {
    expect(formatTimeOfDay(0)).toBe('00:00');
    expect(formatTimeOfDay(0.25)).toBe('06:00');
    expect(formatTimeOfDay(0.5)).toBe('12:00');
    expect(formatTimeOfDay(0.75)).toBe('18:00');
    expect(formatTimeOfDay(0.999)).toBe('23:58');
  });

  it('does not lose a minute to float error', () => {
    expect(formatTimeOfDay(0.35)).toBe('08:24');
    expect(formatTimeOfDay(8.5 / 24)).toBe('08:30');
    expect(formatTimeOfDay(1 / 1440)).toBe('00:01');
  });

  it('wraps values outside 0..1', () => {
    expect(formatTimeOfDay(1)).toBe('00:00');
    expect(formatTimeOfDay(1.25)).toBe('06:00');
    expect(formatTimeOfDay(-0.25)).toBe('18:00');
    expect(formatTimeOfDay(NaN)).toBe('--:--');
  });
});

describe('createFrameStats', () => {
  it('reports ~60 fps for 60 ticks of 1/60 s', () => {
    const fs = createFrameStats();
    for (let i = 0; i < 60; i++) fs.tick(1 / 60);
    expect(fs.fps).toBeCloseTo(60, 3);
    expect(fs.frameMs).toBeCloseTo(1000 / 60, 3);
  });

  it('averages over a window and tracks the slowest frame', () => {
    const fs = createFrameStats(0.5);
    // 0.5 s of 20 ms frames with one 100 ms spike.
    for (let i = 0; i < 20; i++) fs.tick(0.02);
    fs.tick(0.1);
    expect(fs.fps).toBeCloseTo(21 / 0.5, 6);
    expect(fs.maxFrameMs).toBeCloseTo(100, 6);
    // The next window forgets the spike.
    for (let i = 0; i < 30; i++) fs.tick(1 / 60);
    expect(fs.fps).toBeCloseTo(60, 3);
    expect(fs.maxFrameMs).toBeCloseTo(1000 / 60, 3);
  });

  it('gives a running estimate before the first window and ignores bad deltas', () => {
    const fs = createFrameStats();
    fs.tick(1 / 30);
    expect(fs.fps).toBeCloseTo(30, 6);
    fs.tick(0);
    fs.tick(-1);
    fs.tick(NaN);
    fs.tick(Infinity);
    expect(fs.fps).toBeCloseTo(30, 6);
  });

  it('works when tick is called unbound', () => {
    const fs = createFrameStats();
    const { tick } = fs;
    for (let i = 0; i < 40; i++) tick(1 / 60);
    expect(fs.fps).toBeCloseTo(60, 3);
  });
});

describe('debugRows', () => {
  const stats = {
    fps: 59.6, frameMs: 16.78, x: -3.14159, y: 40, z: 17.5, cx: -1, cz: 1, yaw: PI / 2,
    loadedChunks: 225, meshQueue: 3, triangles: 312480, seed: 12345, timeOfDay: 0.5,
  };
  const rows = Object.fromEntries(debugRows(stats));

  it('shows XYZ to 2 decimals, chunk coords, facing and time', () => {
    expect(rows.FPS).toContain('60 fps');
    expect(rows.FPS).toContain('16.8 ms');
    expect(rows.XYZ).toBe('-3.14 / 40.00 / 17.50');
    expect(rows.Chunk).toBe('-1, 1  (in 12, 1)');
    expect(rows.Facing).toContain('west (-X)');
    expect(rows.Facing).toContain('90.0');
    expect(rows.Time).toBe('12:00');
    expect(rows.Chunks).toContain('225 loaded');
    expect(rows.Chunks).toContain('3 to mesh');
    expect(rows.Render).toContain('312,480 tris');
    expect(rows.Seed).toBe('12345');
  });

  it('adds optional rows only when given', () => {
    expect(rows.Mode).toBeUndefined();
    expect(rows.Holding).toBeUndefined();
    const more = Object.fromEntries(debugRows({
      ...stats, flying: true, selectedBlock: 'Glass', drawCalls: 140, geometries: 290, frameMaxMs: 22.4,
    }));
    expect(more.Mode).toBe('flying');
    expect(more.Holding).toBe('Glass');
    expect(more.Render).toContain('140 draws');
    expect(more.Render).toContain('290 geo');
    expect(more.FPS).toContain('max 22.4');
  });

  it('does not throw on missing stats', () => {
    expect(() => debugRows({})).not.toThrow();
  });
});

describe('isometric icon geometry', () => {
  const S = ICON_SIZE;
  const T = TILE_SIZE;
  const m = isoFaceMatrices(S, T);
  const apply = ([a, b, c, d, e, f], u, v) => [a * u + c * v + e, b * u + d * v + f];

  it('maps tile corners onto the cube faces inside the canvas', () => {
    // Top rhombus: back corner at the top center, front corner at the canvas center.
    expect(apply(m.top, 0, 0)).toEqual([S / 2, 0]);
    expect(apply(m.top, T, 0)).toEqual([S, S / 4]);
    expect(apply(m.top, 0, T)).toEqual([0, S / 4]);
    expect(apply(m.top, T, T)).toEqual([S / 2, S / 2]);
    // Left face: tile top edge runs from the left corner to the front corner, tile up stays up.
    expect(apply(m.left, 0, 0)).toEqual([0, S / 4]);
    expect(apply(m.left, T, 0)).toEqual([S / 2, S / 2]);
    expect(apply(m.left, T, T)).toEqual([S / 2, S]);
    // Right face shares the front vertical edge with the left face.
    expect(apply(m.right, 0, 0)).toEqual([S / 2, S / 2]);
    expect(apply(m.right, T, 0)).toEqual([S, S / 4]);
    expect(apply(m.right, T, T)).toEqual([S, (3 * S) / 4]);
  });

  it('puts every texel corner on a whole pixel at ICON_SIZE', () => {
    for (const k of Object.keys(m)) {
      for (const v of m[k]) expect(Number.isInteger(v), `${k}: ${m[k]}`).toBe(true);
    }
  });
});

describe('icon pixel helpers', () => {
  const atlas = paintAtlasPixels(1337);

  it('extractTile copies a tile and shades RGB only', () => {
    const full = extractTile(atlas, ATLAS_SIZE, TILES.LEAVES, 1);
    const dark = extractTile(atlas, ATLAS_SIZE, TILES.LEAVES, 0.5);
    const { x: ox, y: oy } = tileOrigin(TILES.LEAVES);
    let holes = 0;
    for (let y = 0; y < TILE_SIZE; y++) {
      for (let x = 0; x < TILE_SIZE; x++) {
        const s = ((oy + y) * ATLAS_SIZE + ox + x) * 4;
        const d = (y * TILE_SIZE + x) * 4;
        for (let c = 0; c < 4; c++) expect(full[d + c]).toBe(atlas[s + c]);
        expect(Math.abs(dark[d] - atlas[s] * 0.5)).toBeLessThanOrEqual(0.5);
        expect(dark[d + 3]).toBe(atlas[s + 3]);
        if (atlas[s + 3] === 0) holes++;
      }
    }
    expect(holes).toBeGreaterThan(0); // leaves keep their holes
  });

  it('snapAlpha makes edges hard', () => {
    const px = new Uint8ClampedArray([9, 9, 9, 0, 9, 9, 9, 100, 9, 9, 9, 128, 9, 9, 9, 255]);
    snapAlpha(px);
    expect([px[3], px[7], px[11], px[15]]).toEqual([0, 0, 255, 255]);
  });
});

describe('module loading', () => {
  it('UI modules import in node without touching the DOM', () => {
    expect(typeof createHud).toBe('function');
    expect(typeof document).toBe('undefined');
  });
});
