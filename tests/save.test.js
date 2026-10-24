import { describe, it, expect, vi, afterEach } from 'vitest';
import { CHUNK_SIZE, WORLD_HEIGHT, DAY_START_TIME } from '../src/config.js';
import { B } from '../src/blocks.js';
import { World } from '../src/world/world.js';
import { createPlayer } from '../src/player/player.js';
import {
  SAVE_KEY, SAVE_VERSION, AUTOSAVE_INTERVAL_MS, MAX_SAVED_PITCH,
  serializeSave, parseSave, normalizeSave, normalizeEdits, loadGame, saveGame, clearSave, createAutosaver,
} from '../src/save/save.js';

const SEED = 777;
const BLOCK_COUNT = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;

/** Map-backed stand-in for localStorage. */
function createFakeStorage() {
  const map = new Map();
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

function sampleData(overrides = {}) {
  return {
    seed: 123456789,
    player: { x: -12.25, y: 37.5, z: 1045.75, yaw: -2.5, pitch: 0.75, flying: true },
    hotbarIndex: 6,
    timeOfDay: 0.8125,
    edits: { '0,0': [[5, B.STONE], [BLOCK_COUNT - 1, B.AIR]], '-3,7': [[1234, B.GLASS]] },
    ...overrides,
  };
}

/** A save string built from a raw object (no serializeSave normalization), for corrupt-data tests. */
function rawSave(fields) {
  return JSON.stringify({ version: SAVE_VERSION, seed: 42, ...fields });
}

/** Index of the first differing element of two typed arrays, or -1. */
function firstDiff(a, b) {
  if (a.length !== b.length) return 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return i;
  return -1;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('save constants', () => {
  it('uses the documented key, version and interval', () => {
    expect(SAVE_KEY).toBe('voxel-sandbox-save');
    expect(SAVE_VERSION).toBe(1);
    expect(AUTOSAVE_INTERVAL_MS).toBe(10000);
    expect(MAX_SAVED_PITCH).toBeCloseTo((89 * Math.PI) / 180, 12);
  });
});

describe('edit map round trip', () => {
  const CHUNKS = [[0, 0], [-1, 0], [0, -1], [-1, -1], [2, -3]];

  function editedWorld() {
    const world = new World(SEED);
    for (const [cx, cz] of CHUNKS) world.ensureChunk(cx, cz);
    const edits = [
      [-1, 40, 0, B.GLASS],        // chunk (-1, 0) local x 15, on the border with chunk (0, 0)
      [0, 41, 0, B.PLANKS],        // chunk (0, 0) local (0, 0): border and corner
      [-16, 50, -16, B.LOG],       // chunk (-1, -1) local (0, 0)
      [35, 10, -44, B.COBBLESTONE], // chunk (2, -3)
      [0, 0, 0, B.STONE],          // index 0 (replaces bedrock)
      [15, 63, 15, B.LEAVES],      // last index of chunk (0, 0)
      [3, 35, 3, B.DIRT],
      [3, 35, 3, B.SAND],          // same cell twice: last write wins
    ];
    // Replace surface blocks with AIR (one in a negative chunk).
    for (const [x, z] of [[7, 9], [-5, -11]]) edits.push([x, world.heightAt(x, z), z, B.AIR]);
    for (const [x, y, z, id] of edits) expect(world.setBlock(x, y, z, id)).toBe(true);
    return world;
  }

  it('serializes and re-applies identically into a new World', () => {
    const original = editedWorld();
    const edits = original.getEdits();
    expect(Object.keys(edits).sort()).toEqual(['-1,-1', '-1,0', '0,0', '2,-3']);

    const text = serializeSave({ ...sampleData({ seed: SEED }), edits });
    const save = parseSave(text);
    expect(save).not.toBeNull();
    expect(save.seed).toBe(SEED);
    expect(save.edits).toEqual(edits);

    // Restore order: new World(seed) -> applyEdits BEFORE generating -> generate the chunks.
    const restored = new World(save.seed);
    const entryCount = Object.values(edits).reduce((n, list) => n + list.length, 0);
    expect(restored.applyEdits(save.edits)).toBe(entryCount);
    for (const [cx, cz] of [...CHUNKS].reverse()) restored.ensureChunk(cx, cz);

    for (const [cx, cz] of CHUNKS) {
      const a = original.getChunk(cx, cz).blocks;
      const b = restored.getChunk(cx, cz).blocks;
      expect(firstDiff(a, b), `chunk ${cx},${cz}`).toBe(-1);
    }
    expect(restored.getEdits()).toEqual(edits);

    // Sanity: the edits really changed the terrain, so the comparison above means something.
    const fresh = new World(SEED);
    for (const [cx, cz] of CHUNKS) fresh.ensureChunk(cx, cz);
    expect(fresh.getBlock(-1, 40, 0)).not.toBe(B.GLASS);
    expect(restored.getBlock(-1, 40, 0)).toBe(B.GLASS);
    expect(fresh.getBlock(0, 0, 0)).toBe(B.BEDROCK);
    expect(restored.getBlock(0, 0, 0)).toBe(B.STONE);
    expect(restored.getBlock(3, 35, 3)).toBe(B.SAND);
    const surface = fresh.heightAt(-5, -11);
    expect(fresh.getBlock(-5, surface, -11)).not.toBe(B.AIR);
    expect(restored.getBlock(-5, surface, -11)).toBe(B.AIR);
  });

  it('round-trips through storage too', () => {
    const original = editedWorld();
    const storage = createFakeStorage();
    expect(saveGame({ ...sampleData({ seed: SEED }), edits: original.getEdits() }, storage)).toBe(true);
    const save = loadGame(storage);
    const restored = new World(save.seed);
    restored.applyEdits(save.edits);
    for (const [cx, cz] of CHUNKS) {
      restored.ensureChunk(cx, cz);
      expect(firstDiff(original.getChunk(cx, cz).blocks, restored.getChunk(cx, cz).blocks)).toBe(-1);
    }
  });
});

describe('full save round trip', () => {
  it('preserves seed, player, hotbar index and time of day', () => {
    const storage = createFakeStorage();
    const data = sampleData();
    expect(saveGame(data, storage)).toBe(true);
    expect(typeof storage.map.get(SAVE_KEY)).toBe('string');
    expect(loadGame(storage)).toEqual({ version: SAVE_VERSION, ...data });

    const grounded = sampleData({
      seed: -5,
      player: { x: 0.5, y: 24, z: -0.5, yaw: 3.1, pitch: -MAX_SAVED_PITCH, flying: false },
      hotbarIndex: 0,
      timeOfDay: 0,
      edits: {},
    });
    expect(parseSave(serializeSave(grounded))).toEqual({ version: SAVE_VERSION, ...grounded });
  });

  it('writes the current version and only the known fields', () => {
    const data = { ...sampleData(), version: 99, extra: 'junk' };
    data.player = { ...data.player, vx: 3, onGround: true };
    const obj = JSON.parse(serializeSave(data));
    expect(obj.version).toBe(SAVE_VERSION);
    expect(Object.keys(obj).sort()).toEqual(['edits', 'hotbarIndex', 'player', 'seed', 'timeOfDay', 'version']);
    expect(Object.keys(obj.player).sort()).toEqual(['flying', 'pitch', 'x', 'y', 'yaw', 'z']);
  });

  it('restores into a real player (teleport + setLook + flying)', () => {
    const camera = { position: { set() {} }, rotation: { set() {}, order: 'YXZ' } };
    const controls = { isDown: () => false, consumeMouseDelta: () => ({ dx: 0, dy: 0 }), consumeFlyToggle: () => false };
    const world = new World(SEED);
    const a = createPlayer({ camera, world, controls });
    a.teleport(10.5, 30, -20.25);
    a.setLook(1.25, -0.5);
    a.state.flying = true;
    const s = a.state;
    const text = serializeSave({
      seed: SEED,
      player: { x: s.x, y: s.y, z: s.z, yaw: a.yaw, pitch: a.pitch, flying: s.flying },
      hotbarIndex: 4,
      timeOfDay: 0.5,
      edits: world.getEdits(),
    });

    const save = parseSave(text);
    const b = createPlayer({ camera, world: new World(save.seed), controls });
    const p = save.player;
    b.teleport(p.x, p.y, p.z);
    b.setLook(p.yaw, p.pitch);
    b.state.flying = p.flying;
    expect([b.state.x, b.state.y, b.state.z]).toEqual([10.5, 30, -20.25]);
    expect(b.yaw).toBe(a.yaw);
    expect(b.pitch).toBe(a.pitch);
    expect(b.state.flying).toBe(true);
  });
});

describe('corrupt or missing save data', () => {
  it('returns null for missing, non-JSON or non-object input without throwing', () => {
    for (const bad of [null, undefined, '', 'not json', '{', '{}', '[]', 'null', '42', '"text"', 'true', 7, {}]) {
      expect(() => parseSave(bad)).not.toThrow();
      expect(parseSave(bad)).toBeNull();
    }
  });

  it('returns null for a wrong or missing version', () => {
    expect(parseSave(rawSave({ version: 2 }))).toBeNull();
    expect(parseSave(rawSave({ version: '1' }))).toBeNull();
    expect(parseSave(rawSave({ version: undefined }))).toBeNull();
    expect(parseSave(rawSave({}))).not.toBeNull();
  });

  it('returns null for a bad seed', () => {
    for (const seed of ['123', 1.5, null, true, [], {}, 2 ** 60]) {
      expect(parseSave(rawSave({ seed }))).toBeNull();
    }
    expect(parseSave(JSON.stringify({ version: SAVE_VERSION }))).toBeNull();
    expect(normalizeSave({ version: SAVE_VERSION, seed: NaN })).toBeNull();
    expect(normalizeSave({ version: SAVE_VERSION, seed: Infinity })).toBeNull();
    expect(parseSave(rawSave({ seed: -17 })).seed).toBe(-17);
  });

  it('drops an unusable position but keeps the world', () => {
    const edits = { '1,1': [[3, B.STONE]] };
    // NaN becomes null in JSON; strings and missing fields are also unusable.
    for (const player of [
      { x: NaN, y: 30, z: 0, yaw: 0, pitch: 0, flying: false },
      { x: 0, y: '30', z: 0 },
      { x: 0, z: 0 },
      null,
      'here',
      [1, 2, 3],
    ]) {
      const save = parseSave(rawSave({ player, edits, hotbarIndex: 2, timeOfDay: 0.4 }));
      expect(save).not.toBeNull();
      expect(save.player).toBeNull();
      expect(save.edits).toEqual(edits);
      expect(save.hotbarIndex).toBe(2);
      expect(save.timeOfDay).toBe(0.4);
    }
    expect(normalizeSave({ version: SAVE_VERSION, seed: 1, player: { x: 0, y: Infinity, z: 0 } }).player).toBeNull();
  });

  it('falls back field by field for yaw, pitch and flying', () => {
    const save = parseSave(rawSave({ player: { x: 1, y: 2, z: 3, yaw: null, pitch: '0.5', flying: 'yes' } }));
    expect(save.player).toEqual({ x: 1, y: 2, z: 3, yaw: 0, pitch: 0, flying: false });
    expect(parseSave(rawSave({ player: { x: 1, y: 2, z: 3, yaw: 40, pitch: 3 } })).player)
      .toEqual({ x: 1, y: 2, z: 3, yaw: 40, pitch: MAX_SAVED_PITCH, flying: false });
    expect(parseSave(rawSave({ player: { x: 1, y: 2, z: 3, yaw: -7, pitch: -100, flying: true } })).player)
      .toEqual({ x: 1, y: 2, z: 3, yaw: -7, pitch: -MAX_SAVED_PITCH, flying: true });
  });

  it('falls back to slot 0 and the start time for bad hotbarIndex / timeOfDay', () => {
    for (const hotbarIndex of [9, -1, 2.5, '3', null, undefined]) {
      expect(parseSave(rawSave({ hotbarIndex })).hotbarIndex).toBe(0);
    }
    expect(parseSave(rawSave({ hotbarIndex: 8 })).hotbarIndex).toBe(8);
    for (const timeOfDay of [1, 1.5, -0.1, '0.5', null, undefined]) {
      expect(parseSave(rawSave({ timeOfDay })).timeOfDay).toBe(DAY_START_TIME);
    }
    expect(parseSave(rawSave({ timeOfDay: 0 })).timeOfDay).toBe(0);
    expect(parseSave(rawSave({ timeOfDay: 0.999 })).timeOfDay).toBe(0.999);
  });

  it('keeps valid edit entries and drops garbage keys and entries', () => {
    const text = `{
      "version": ${SAVE_VERSION}, "seed": 5,
      "edits": {
        "0,0": [[5, 1], [-1, 1], [5.5, 1], ["5", 1], [${BLOCK_COUNT}, 1], [1e12, 1], [${BLOCK_COUNT - 1}, 9],
                [10, 99], [11, -1], [12, 255], [13, 1.5], [14, null], [15], [16, 1, 2], "x", null, 42, {}],
        "a,b": [[1, 1]], "1,2,3": [[1, 1]], "1.5,2": [[1, 1]], " 1,2": [[1, 1]], "": [[1, 1]],
        "__proto__": [[1, 1]], "constructor": [[1, 1]], "99999999999999999999,0": [[1, 1]],
        "-3,4": "not an array", "5,5": [], "6,6": [[-4, 2]],
        "7,-8": [[0, 3], [0, 4]],
        "00,-0": [[2, 4]]
      }
    }`;
    const save = parseSave(text);
    expect(save).not.toBeNull();
    expect(save.edits).toEqual({
      '0,0': [[5, 1], [BLOCK_COUNT - 1, 9], [2, 4]], // "00,-0" merges into "0,0"
      '7,-8': [[0, 4]],                              // repeated index: last id wins
    });
    expect(Object.getPrototypeOf(save.edits)).toBe(Object.prototype);
    expect(new World(5).applyEdits(save.edits)).toBe(4);
  });

  it('treats a missing or non-object edit map as no edits', () => {
    for (const edits of [undefined, null, [], 'edits', 3, [[0, 1]]]) {
      const save = parseSave(rawSave({ edits }));
      expect(save).not.toBeNull();
      expect(save.edits).toEqual({});
    }
    expect(normalizeEdits(new Proxy({}, { ownKeys() { throw new Error('boom'); } }))).toEqual({});
  });

  it('never throws on truncated save text', () => {
    const text = serializeSave(sampleData());
    for (let i = 0; i < text.length; i++) {
      expect(() => parseSave(text.slice(0, i))).not.toThrow();
    }
    expect(normalizeSave(new Proxy({}, { get() { throw new Error('boom'); } }))).toBeNull();
  });
});

describe('storage failures', () => {
  it('loadGame returns null when getItem throws or the stored text is corrupt', () => {
    const throwing = { getItem() { throw new Error('denied'); }, setItem() {}, removeItem() {} };
    expect(loadGame(throwing)).toBeNull();
    const storage = createFakeStorage();
    expect(loadGame(storage)).toBeNull(); // nothing saved yet
    storage.setItem(SAVE_KEY, '{"version":1,"seed":');
    expect(loadGame(storage)).toBeNull();
  });

  it('saveGame returns false on QuotaExceededError and other setItem errors', () => {
    const full = {
      getItem: () => null,
      setItem() { throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); },
      removeItem() {},
    };
    expect(() => saveGame(sampleData(), full)).not.toThrow();
    expect(saveGame(sampleData(), full)).toBe(false);
    expect(saveGame(sampleData(), { setItem() { throw new TypeError('nope'); } })).toBe(false);
  });

  it('saveGame returns false for unserializable data', () => {
    const storage = createFakeStorage();
    const edits = {};
    edits.self = edits;
    expect(saveGame(sampleData({ edits }), storage)).toBe(false);
    expect(saveGame(sampleData({ seed: 10n }), storage)).toBe(false);
    expect(saveGame(null, storage)).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  it('clearSave removes the save and returns false when removeItem throws', () => {
    const storage = createFakeStorage();
    saveGame(sampleData(), storage);
    expect(clearSave(storage)).toBe(true);
    expect(loadGame(storage)).toBeNull();
    expect(clearSave({ removeItem() { throw new Error('denied'); } })).toBe(false);
  });

  it('works with no storage at all', () => {
    expect(loadGame(null)).toBeNull();
    expect(saveGame(sampleData(), null)).toBe(false);
    expect(clearSave(null)).toBe(false);
    vi.stubGlobal('localStorage', undefined);
    expect(loadGame()).toBeNull();
    expect(loadGame(undefined)).toBeNull();
    expect(saveGame(sampleData())).toBe(false);
    expect(saveGame(sampleData(), undefined)).toBe(false);
    expect(clearSave()).toBe(false);
  });

  it('works when the localStorage getter itself throws', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('Access is denied', 'SecurityError'); },
    });
    try {
      expect(loadGame()).toBeNull();
      expect(saveGame(sampleData())).toBe(false);
      expect(clearSave()).toBe(false);
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original);
      else delete globalThis.localStorage;
    }
  });

  it('defaults to globalThis.localStorage', () => {
    const storage = createFakeStorage();
    vi.stubGlobal('localStorage', storage);
    expect(saveGame(sampleData())).toBe(true);
    expect(storage.map.has(SAVE_KEY)).toBe(true);
    expect(loadGame().seed).toBe(sampleData().seed);
    expect(clearSave()).toBe(true);
    expect(storage.map.has(SAVE_KEY)).toBe(false);
  });
});

describe('autosaver', () => {
  function setup(options = {}) {
    vi.useFakeTimers();
    const storage = createFakeStorage();
    const target = new EventTarget();
    let t = 0;
    const collect = vi.fn(() => sampleData({ timeOfDay: (t += 0.125) % 1 }));
    const saver = createAutosaver({ collect, storage, target, ...options });
    return { storage, target, collect, saver };
  }

  const unload = (target) => target.dispatchEvent(new Event('beforeunload'));

  it('saves every interval after start()', () => {
    const { storage, collect, saver } = setup();
    vi.advanceTimersByTime(30000);
    expect(collect).not.toHaveBeenCalled(); // nothing before start()
    saver.start();
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS - 1);
    expect(collect).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(loadGame(storage).timeOfDay).toBe(0.125);
    vi.advanceTimersByTime(2 * AUTOSAVE_INTERVAL_MS);
    expect(collect).toHaveBeenCalledTimes(3);
    expect(loadGame(storage).timeOfDay).toBe(0.375);
    saver.stop();
  });

  it('honors a custom interval', () => {
    const { collect, saver } = setup({ intervalMs: 2500 });
    saver.start();
    vi.advanceTimersByTime(10000);
    expect(collect).toHaveBeenCalledTimes(4);
    saver.stop();
  });

  it('saves on beforeunload', () => {
    const { storage, target, collect, saver } = setup();
    saver.start();
    unload(target);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(loadGame(storage)).not.toBeNull();
    saver.stop();
  });

  it('stop() prevents both interval and beforeunload saves (New World flow)', () => {
    const { storage, target, collect, saver } = setup();
    saver.start();
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    expect(collect).toHaveBeenCalledTimes(1);

    // New World: stop -> clearSave -> reload. The unload must not re-save the old world.
    saver.stop();
    expect(clearSave(storage)).toBe(true);
    vi.advanceTimersByTime(5 * AUTOSAVE_INTERVAL_MS);
    unload(target);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(storage.map.has(SAVE_KEY)).toBe(false);
  });

  it('start() and stop() are idempotent and can restart', () => {
    const { target, collect, saver } = setup();
    saver.start();
    saver.start();
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    expect(collect).toHaveBeenCalledTimes(1); // one interval, not two
    unload(target);
    expect(collect).toHaveBeenCalledTimes(2); // one listener, not two
    saver.stop();
    saver.stop();
    unload(target);
    expect(collect).toHaveBeenCalledTimes(2);
    saver.start();
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    unload(target);
    expect(collect).toHaveBeenCalledTimes(4);
    saver.stop();
  });

  it('saveNow saves immediately and never throws', () => {
    const { storage, collect, saver } = setup();
    expect(saver.saveNow()).toBe(true);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(loadGame(storage)).not.toBeNull();

    const failing = createAutosaver({ collect: () => { throw new Error('collect failed'); }, storage });
    expect(() => failing.saveNow()).not.toThrow();
    expect(failing.saveNow()).toBe(false);

    const full = { setItem() { throw new DOMException('full', 'QuotaExceededError'); } };
    expect(createAutosaver({ collect, storage: full }).saveNow()).toBe(false);
    expect(createAutosaver().saveNow()).toBe(false); // no collect at all
  });

  it('a throwing collect() does not escape the interval or the beforeunload handler', () => {
    vi.useFakeTimers();
    const target = new EventTarget();
    const collect = vi.fn(() => { throw new Error('collect failed'); });
    const saver = createAutosaver({ collect, storage: createFakeStorage(), target });
    saver.start();
    expect(() => vi.advanceTimersByTime(3 * AUTOSAVE_INTERVAL_MS)).not.toThrow();
    expect(() => unload(target)).not.toThrow();
    expect(collect).toHaveBeenCalledTimes(4);
    saver.stop();
  });

  it('works without an event target (node has no window)', () => {
    vi.useFakeTimers();
    const storage = createFakeStorage();
    const saver = createAutosaver({ collect: () => sampleData(), storage });
    expect(() => saver.start()).not.toThrow();
    vi.advanceTimersByTime(AUTOSAVE_INTERVAL_MS);
    expect(loadGame(storage)).not.toBeNull();
    expect(() => saver.stop()).not.toThrow();
  });
});
