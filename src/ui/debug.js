// F3 debug overlay (PROJECT.md section 7 HUD, Task 8).
//
// Pure helpers (facingFromYaw, formatTimeOfDay, createFrameStats, debugRows) run in node for
// tests. DOM work happens only inside createDebugOverlay().
//
// Cost: update(stats) only stores the stats object while hidden. While visible it rewrites the
// text at most every REFRESH_MS, so the main loop can call it every frame.

import { CHUNK_SIZE } from '../config.js';

const REFRESH_MS = 250; // text refresh interval while visible (~4 per second)
const TWO_PI = Math.PI * 2;
const QUARTER = Math.PI / 2;

// Camera convention (rotation order 'YXZ'): yaw 0 looks toward -Z, yaw +PI/2 toward -X, so the
// view direction is (-sin(yaw), 0, -cos(yaw)). Quadrants in increasing yaw:
const FACINGS = ['north (-Z)', 'west (-X)', 'south (+Z)', 'east (+X)'];

/**
 * Compass direction for a camera yaw (radians, any range).
 * @param {number} yaw
 * @returns {string} 'north (-Z)' | 'west (-X)' | 'south (+Z)' | 'east (+X)' ('-' if not finite)
 */
export function facingFromYaw(yaw) {
  if (!Number.isFinite(yaw)) return '-';
  let a = yaw % TWO_PI;
  if (a < 0) a += TWO_PI;
  return FACINGS[Math.round(a / QUARTER) % 4];
}

/**
 * Format a time of day as 24-hour "HH:MM". 0 = midnight, 0.25 = 06:00, 0.5 = noon, 0.75 = 18:00.
 * Values outside 0..1 wrap around.
 * @param {number} t
 */
export function formatTimeOfDay(t) {
  if (!Number.isFinite(t)) return '--:--';
  const f = t - Math.floor(t);
  // The epsilon keeps e.g. 0.35 * 1440 = 503.99999999999994 from rounding down a minute.
  let minutes = Math.floor(f * 1440 + 1e-6);
  if (minutes >= 1440) minutes -= 1440;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}

/**
 * Frame timing averaged over windows of about `windowSeconds`. tick() does no allocation.
 * Before the first window completes, the values are a running average.
 *
 * Feed it the real frame delta (before any physics clamp) so the numbers stay honest.
 *
 * @param {number} [windowSeconds=0.5]
 * @returns {{ tick: (dtSeconds: number) => void, fps: number, frameMs: number, maxFrameMs: number }}
 *   maxFrameMs is the slowest frame in the last completed window (spikes).
 */
export function createFrameStats(windowSeconds = 0.5) {
  let acc = 0;
  let frames = 0;
  let worst = 0;
  let warmingUp = true;
  const stats = {
    fps: 0,
    frameMs: 0,
    maxFrameMs: 0,
    tick(dt) {
      if (!(dt > 0) || dt === Infinity) return; // ignores 0, negatives, NaN
      acc += dt;
      frames++;
      if (dt > worst) worst = dt;
      if (acc >= windowSeconds - 1e-9) {
        stats.fps = frames / acc;
        stats.frameMs = (acc * 1000) / frames;
        stats.maxFrameMs = worst * 1000;
        acc = 0;
        frames = 0;
        worst = 0;
        warmingUp = false;
      } else if (warmingUp) {
        stats.fps = frames / acc;
        stats.frameMs = (acc * 1000) / frames;
        stats.maxFrameMs = worst * 1000;
      }
    },
  };
  return stats;
}

// ---------------------------------------------------------------------------
// Text formatting
// ---------------------------------------------------------------------------

const has = (v) => typeof v === 'number' && Number.isFinite(v);
const fixed = (v, digits) => (has(v) ? v.toFixed(digits) : '-');
const int = (v) => (has(v) ? String(Math.round(v)) : '-');
const count = (v) => (has(v) ? Math.round(v).toLocaleString('en-US') : '-');
const localCoord = (v) => ((Math.floor(v) % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;

/**
 * The overlay's rows as [label, value] pairs. Optional rows are left out when their stat is
 * missing. Called only at refresh time (a few times per second), never per frame.
 *
 * @param {object} s stats, see createDebugOverlay
 * @returns {Array<[string, string]>}
 */
export function debugRows(s) {
  const rows = [];

  let fps = `${int(s.fps)} fps  ${fixed(s.frameMs, 1)} ms`;
  if (has(s.frameMaxMs)) fps += `  (max ${fixed(s.frameMaxMs, 1)})`;
  rows.push(['FPS', fps]);

  rows.push(['XYZ', `${fixed(s.x, 2)} / ${fixed(s.y, 2)} / ${fixed(s.z, 2)}`]);

  let chunk = `${int(s.cx)}, ${int(s.cz)}`;
  if (has(s.x) && has(s.z)) chunk += `  (in ${localCoord(s.x)}, ${localCoord(s.z)})`;
  rows.push(['Chunk', chunk]);

  let facing = facingFromYaw(s.yaw);
  if (has(s.yaw)) {
    let deg = ((s.yaw * 180) / Math.PI) % 360;
    if (deg < 0) deg += 360;
    facing += `  ${deg.toFixed(1)}°`;
  }
  rows.push(['Facing', facing]);

  rows.push(['Time', formatTimeOfDay(s.timeOfDay)]);
  rows.push(['Chunks', `${int(s.loadedChunks)} loaded  ${int(s.meshQueue)} to mesh`]);

  let render = `${count(s.triangles)} tris`;
  if (has(s.drawCalls)) render += `  ${count(s.drawCalls)} draws`;
  if (has(s.geometries)) render += `  ${count(s.geometries)} geo`;
  rows.push(['Render', render]);

  rows.push(['Seed', s.seed === undefined || s.seed === null ? '-' : String(s.seed)]);
  if (typeof s.flying === 'boolean') rows.push(['Mode', s.flying ? 'flying' : 'walking']);
  if (s.selectedBlock) rows.push(['Holding', String(s.selectedBlock)]);
  return rows;
}

// ---------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------

/**
 * Create the F3 debug overlay (top-left, hidden by default).
 *
 * stats fields (numbers unless noted): fps, frameMs, x, y, z, cx, cz, yaw (radians), loadedChunks,
 * meshQueue, triangles, seed, timeOfDay (0..1, 0 = midnight, 0.5 = noon).
 * Optional: frameMaxMs, drawCalls, geometries, flying (boolean), selectedBlock (name string).
 * Passing the same object every frame (mutated in place) is fine; it is only read at refresh time.
 *
 * @param {HTMLElement} container element to append the overlay to (e.g. document.body)
 * @returns {{
 *   toggle: () => void,
 *   setVisible: (visible: boolean) => void,
 *   isVisible: () => boolean,
 *   update: (stats: object) => void,
 *   dispose: () => void,
 * }}
 */
export function createDebugOverlay(container) {
  const root = document.createElement('div');
  root.className = 'vs-ui vs-debug is-hidden';
  root.setAttribute('aria-hidden', 'true');

  const header = document.createElement('div');
  header.className = 'vs-debug__header';
  header.textContent = 'Minecraft Copy';
  const hint = document.createElement('span');
  hint.className = 'vs-debug__hint';
  hint.textContent = 'F3';
  header.appendChild(hint);
  root.appendChild(header);

  const body = document.createElement('div');
  body.className = 'vs-debug__rows';
  root.appendChild(body);
  container.appendChild(root);

  // Row elements are created on demand and reused, keyed by label.
  const rowEls = new Map();
  let visible = false;
  let latest = null;
  let lastRefresh = -Infinity;

  function rowFor(label) {
    let row = rowEls.get(label);
    if (!row) {
      const el = document.createElement('div');
      el.className = 'vs-debug__row';
      const l = document.createElement('span');
      l.className = 'vs-debug__label';
      l.textContent = label;
      const v = document.createElement('span');
      v.className = 'vs-debug__value';
      el.append(l, v);
      row = { el, value: v, text: '' };
      rowEls.set(label, row);
    }
    return row;
  }

  function refresh() {
    if (!latest) return;
    const rows = debugRows(latest);
    // Rebuild order only when the set of rows changes (optional rows appear or disappear).
    const labels = rows.map((r) => r[0]).join('|');
    if (labels !== body.dataset.labels) {
      body.replaceChildren(...rows.map(([label]) => rowFor(label).el));
      body.dataset.labels = labels;
    }
    for (const [label, text] of rows) {
      const row = rowFor(label);
      if (row.text !== text) {
        row.value.textContent = text;
        row.text = text;
      }
    }
  }

  function setVisible(v) {
    const next = !!v;
    if (next === visible) return;
    visible = next;
    root.classList.toggle('is-hidden', !visible);
    if (visible) {
      // Draw right away if stats are in; otherwise let the next update() draw immediately.
      lastRefresh = latest ? performance.now() : -Infinity;
      refresh();
    }
  }

  return {
    toggle() {
      setVisible(!visible);
    },

    setVisible,

    isVisible() {
      return visible;
    },

    update(stats) {
      latest = stats;
      if (!visible) return;
      const now = performance.now();
      if (now - lastRefresh < REFRESH_MS) return;
      lastRefresh = now;
      refresh();
    },

    dispose() {
      root.remove();
      rowEls.clear();
      latest = null;
    },
  };
}
