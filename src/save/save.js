// Save/load (PROJECT.md section 7 "Save/load", Task 10). Pure module: no three.js. `localStorage` and
// `window` are only touched inside functions, and every storage function takes an injectable storage
// object (getItem/setItem/removeItem), so the module runs in node tests.
//
// What is saved: the seed, the player (feet position, yaw, pitch, fly state), the hotbar slot, the time
// of day and ONLY the player's block edits, in World.getEdits() format { "cx,cz": [[index, id], ...] }.
// Terrain regenerates from the seed and the edits are re-applied on top.
//
// How main.js restores a save (order matters):
//   1. const save = loadGame();                     // validated object, or null -> new world
//   2. const world = new World(save.seed);
//   3. world.applyEdits(save.edits);                 // BEFORE any chunk generates, so every chunk
//                                                    // generates with its edits already applied
//   4. world.generateAround(save.player.x, save.player.z, GEN_DISTANCE) and mesh the dirty chunks
//   5. player.teleport(x, y, z); player.setLook(yaw, pitch); player.state.flying = flying;
//   6. hotbar.setSelectedIndex(save.hotbarIndex);
//   7. timeOfDay = save.timeOfDay;
// save.player is null when the stored position was unusable (e.g. NaN): restore the world and its
// edits anyway, but put the player at the normal spawn point.

import { CHUNK_SIZE, WORLD_HEIGHT, DAY_START_TIME, AUTOSAVE_INTERVAL_MS } from '../config.js';
import { B, HOTBAR_BLOCKS } from '../blocks.js';

/** localStorage key that holds the save (one save slot). */
export const SAVE_KEY = 'voxel-sandbox-save';

/** Save format version. parseSave rejects any other version. */
export const SAVE_VERSION = 1;

/** Milliseconds between autosaves (defined in config.js, re-exported for callers and tests). */
export { AUTOSAVE_INTERVAL_MS };

/** Largest absolute pitch kept by parseSave: 89 degrees, in radians (same limit as the player). */
export const MAX_SAVED_PITCH = (89 * Math.PI) / 180;

const BLOCK_COUNT = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT; // valid edit indices are 0..BLOCK_COUNT-1
const HOTBAR_SIZE = HOTBAR_BLOCKS.length; // 9 slots
const KEY_RE = /^-?\d+,-?\d+$/;
const VALID_ID = new Set(Object.values(B));

/**
 * The save data shape (a plain JSON-serializable object).
 * @typedef {object} SaveData
 * @property {number} version SAVE_VERSION
 * @property {number} seed terrain seed (safe integer)
 * @property {{ x: number, y: number, z: number, yaw: number, pitch: number, flying: boolean } | null} player
 *   feet position and view (radians). null only in parsed saves whose position was unusable.
 * @property {number} hotbarIndex selected hotbar slot, 0..8
 * @property {number} timeOfDay in [0, 1); 0 = midnight, 0.5 = noon
 * @property {Object<string, Array<[number, number]>>} edits World.getEdits() format
 */

/**
 * Storage used when none is passed: globalThis.localStorage, or undefined if it is missing or its
 * getter throws (some browsers throw a SecurityError when site data is blocked).
 * @returns {Storage|undefined}
 */
function defaultStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** True for a non-null, non-array object. */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** `v` if it is a finite number, else `fallback`. */
function finiteOr(v, fallback) {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Serialize save data to a JSON string. Only the known fields are written, and `version` is always
 * SAVE_VERSION (this is the current-format writer). Does not validate: parseSave does that on read.
 * May throw on unserializable input (e.g. a circular edits object); saveGame catches that.
 * @param {SaveData} data
 * @returns {string}
 */
export function serializeSave(data) {
  const p = data.player;
  return JSON.stringify({
    version: SAVE_VERSION,
    seed: data.seed,
    player: p == null ? null : {
      x: p.x, y: p.y, z: p.z, yaw: p.yaw, pitch: p.pitch, flying: p.flying,
    },
    hotbarIndex: data.hotbarIndex,
    timeOfDay: data.timeOfDay,
    edits: data.edits,
  });
}

/**
 * Validate and normalize an edit map. Keys must look like "cx,cz" (integers, normalized so "01,-0"
 * becomes "1,0"; duplicates merge). Entries must be [index, id] with an integer index in
 * 0..CHUNK_SIZE*CHUNK_SIZE*WORLD_HEIGHT-1 and a block id from B. Bad keys and entries are dropped,
 * a repeated index keeps its last id, and chunks left with no entries are omitted.
 * @param {unknown} edits
 * @returns {Object<string, Array<[number, number]>>} always an object (empty when nothing is valid)
 */
export function normalizeEdits(edits) {
  const out = {};
  if (!isPlainObject(edits)) return out;
  const merged = new Map(); // normalized key -> Map(index -> id)
  try {
    collectEdits(edits, merged);
  } catch {
    return out; // only reachable with exotic input (throwing getters/proxies), never from JSON.parse
  }
  for (const [key, chunkEdits] of merged) {
    if (chunkEdits.size > 0) out[key] = Array.from(chunkEdits, ([index, id]) => [index, id]);
  }
  return out;
}

/**
 * normalizeEdits' validation pass: adds every valid entry of `edits` to `merged`
 * (normalized key -> Map(index -> id)). Throws only on exotic input; normalizeEdits catches.
 * @param {object} edits
 * @param {Map<string, Map<number, number>>} merged
 */
function collectEdits(edits, merged) {
  for (const key of Object.keys(edits)) {
    if (!KEY_RE.test(key)) continue;
    const comma = key.indexOf(',');
    const cx = Number(key.slice(0, comma)) + 0; // + 0 turns -0 into 0
    const cz = Number(key.slice(comma + 1)) + 0;
    if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cz)) continue;
    const list = edits[key];
    if (!Array.isArray(list)) continue;
    const normKey = `${cx},${cz}`;
    let chunkEdits = merged.get(normKey);
    for (const entry of list) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [index, id] = entry;
      if (!Number.isInteger(index) || index < 0 || index >= BLOCK_COUNT) continue;
      if (!Number.isInteger(id) || !VALID_ID.has(id)) continue;
      if (chunkEdits === undefined) {
        chunkEdits = new Map();
        merged.set(normKey, chunkEdits);
      }
      chunkEdits.set(index, id);
    }
  }
}

/**
 * Validate and normalize an already-parsed save object (see parseSave for the rules). Never throws.
 * @param {unknown} obj
 * @returns {SaveData|null}
 */
export function normalizeSave(obj) {
  try {
    if (!isPlainObject(obj)) return null;
    if (obj.version !== SAVE_VERSION) return null;
    if (!Number.isSafeInteger(obj.seed)) return null;

    let player = null;
    const p = obj.player;
    if (isPlainObject(p) && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)) {
      const pitch = finiteOr(p.pitch, 0);
      player = {
        x: p.x,
        y: p.y,
        z: p.z,
        yaw: finiteOr(p.yaw, 0),
        pitch: Math.max(-MAX_SAVED_PITCH, Math.min(MAX_SAVED_PITCH, pitch)),
        flying: p.flying === true,
      };
    }

    const h = obj.hotbarIndex;
    const hotbarIndex = Number.isInteger(h) && h >= 0 && h < HOTBAR_SIZE ? h : 0;

    const t = obj.timeOfDay;
    const timeOfDay = typeof t === 'number' && t >= 0 && t < 1 ? t : DAY_START_TIME;

    return {
      version: SAVE_VERSION,
      seed: obj.seed,
      player,
      hotbarIndex,
      timeOfDay,
      edits: normalizeEdits(obj.edits),
    };
  } catch {
    return null;
  }
}

/**
 * Parse and validate a save string. Never throws. Returns null when the text is missing, isn't JSON,
 * isn't an object, has a different version, or its seed isn't a safe integer. Everything else falls
 * back field by field instead of failing the whole save:
 * - player: null if x/y/z aren't all finite numbers; otherwise yaw must be finite (else 0), pitch is
 *   finite (else 0) and clamped to +-89 degrees, flying must be true (anything else is false);
 * - hotbarIndex: integer 0..8, else 0;
 * - timeOfDay: number in [0, 1), else DAY_START_TIME;
 * - edits: see normalizeEdits (bad keys/entries dropped, missing or invalid map -> {}).
 * @param {unknown} text
 * @returns {SaveData|null}
 */
export function parseSave(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  return normalizeSave(obj);
}

/**
 * Read and validate the save. Never throws: a missing storage, a throwing getItem and corrupt JSON
 * all return null (start a new world).
 * @param {Storage} [storage=globalThis.localStorage]
 * @returns {SaveData|null}
 */
export function loadGame(storage = defaultStorage()) {
  try {
    return parseSave(storage.getItem(SAVE_KEY));
  } catch {
    return null;
  }
}

/**
 * Write the save. Never throws: a missing storage, QuotaExceededError (or any other setItem error)
 * and unserializable data all return false.
 * @param {SaveData} data
 * @param {Storage} [storage=globalThis.localStorage]
 * @returns {boolean} true if the save was written
 */
export function saveGame(data, storage = defaultStorage()) {
  try {
    storage.setItem(SAVE_KEY, serializeSave(data));
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete the save. Never throws.
 * @param {Storage} [storage=globalThis.localStorage]
 * @returns {boolean} true if removeItem succeeded
 */
export function clearSave(storage = defaultStorage()) {
  try {
    storage.removeItem(SAVE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Autosave every `intervalMs` and on `beforeunload`.
 *
 * Call stop() before starting a new world (stop -> clearSave -> reload): it clears the interval AND
 * removes the beforeunload listener, so the old world isn't saved again while the page unloads.
 * start() and stop() are idempotent. Nothing is saved until start() is called.
 *
 * @param {object} options
 * @param {() => SaveData} options.collect returns the current save data (called at every save)
 * @param {Storage} [options.storage] storage to write to; omitted = globalThis.localStorage
 * @param {number} [options.intervalMs=AUTOSAVE_INTERVAL_MS] autosave period in ms
 * @param {EventTarget} [options.target=globalThis.window] receives the beforeunload listener
 * @returns {{ start: () => void, stop: () => void, saveNow: () => boolean }}
 *   saveNow() saves immediately and returns saveGame's result; it also returns false (never throws)
 *   when collect() throws.
 */
export function createAutosaver({
  collect, storage, intervalMs = AUTOSAVE_INTERVAL_MS, target = globalThis.window,
} = {}) {
  const period = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : AUTOSAVE_INTERVAL_MS;
  let timer = null;

  function saveNow() {
    try {
      return saveGame(collect(), storage);
    } catch {
      return false;
    }
  }

  // Never calls preventDefault, so leaving the page never shows a "leave site?" prompt.
  function onBeforeUnload() {
    saveNow();
  }

  function start() {
    if (timer !== null) return;
    timer = setInterval(saveNow, period);
    if (target && typeof target.addEventListener === 'function') {
      target.addEventListener('beforeunload', onBeforeUnload);
    }
  }

  function stop() {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
    if (target && typeof target.removeEventListener === 'function') {
      target.removeEventListener('beforeunload', onBeforeUnload);
    }
  }

  return { start, stop, saveNow };
}
