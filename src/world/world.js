// World: loaded chunk map, block get/set, player edits, streaming and remesh bookkeeping
// (PROJECT.md sections 5.4 and 7). Pure module: no three.js.
//
// Per-frame cost: update(), consumeUnloadedChunks(), consumeDirtyChunks() and pendingMeshCount()
// allocate nothing when nothing changed since the previous frame. A version counter is bumped by
// every change that can affect the mesh queue (chunk loaded/unloaded, dirty/urgent marks, focus
// moved), so idle frames skip the dirty-set scan entirely. The arrays returned by
// consumeDirtyChunks() and consumeUnloadedChunks() are reused: each is valid only until the next
// call of the same method.

import {
  CHUNK_SIZE, WORLD_HEIGHT, RENDER_DISTANCE, GEN_DISTANCE, UNLOAD_DISTANCE, CHUNK_GEN_PER_FRAME,
} from '../config.js';
import { B, isSolid } from '../blocks.js';
import { Chunk, CHUNK_VOLUME, chunkKey, toChunkCoord } from './chunk.js';
import { createTerrain } from './terrain.js';

const CS = CHUNK_SIZE;
const LAYER = CS * CS;
const RENDER_SQ = RENDER_DISTANCE * RENDER_DISTANCE;
const UNLOAD_SQ = UNLOAD_DISTANCE * UNLOAD_DISTANCE;

// Valid block ids (values of B); anything else is rejected by setBlock/applyEdits.
const VALID_ID = new Uint8Array(256);
for (const id of Object.values(B)) VALID_ID[id] = 1;

// Chunk offsets within GEN_DISTANCE (circular), sorted nearest first. Built once; streaming walks it
// with a cursor, so nothing is re-sorted per frame.
const GEN_OFFSETS = (() => {
  const list = [];
  for (let dz = -GEN_DISTANCE; dz <= GEN_DISTANCE; dz++) {
    for (let dx = -GEN_DISTANCE; dx <= GEN_DISTANCE; dx++) {
      const d = dx * dx + dz * dz;
      if (d <= GEN_DISTANCE * GEN_DISTANCE) list.push([d, dx, dz]);
    }
  }
  list.sort((a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1]);
  const xs = new Int8Array(list.length);
  const zs = new Int8Array(list.length);
  list.forEach((e, i) => { xs[i] = e[1]; zs[i] = e[2]; });
  return { xs, zs, count: list.length };
})();

/**
 * Numeric map key for a chunk: 15 bits of cx and cz packed into a small integer (stays a V8 smi, so
 * lookups don't allocate). Coordinates 32768 chunks apart share a key, so every lookup also checks
 * chunk.cx/cz and insertion evicts a far-away chunk holding the same key.
 */
function numKey(cx, cz) {
  return ((cx & 0x7fff) << 15) | (cz & 0x7fff);
}

const KEY_RE = /^(-?\d+),(-?\d+)$/;

export class World {
  /**
   * @param {number|string} seed terrain seed
   */
  constructor(seed) {
    /** @type {number|string} */
    this.seed = seed;
    /** Terrain generator from createTerrain(seed). */
    this.terrain = createTerrain(seed);

    /** @type {Map<number, Chunk>} loaded chunks by numKey */
    this._chunks = new Map();
    /** @type {Map<string, Map<number, number>>} player edits: chunk key -> (block index -> id) */
    this._edits = new Map();
    /** @type {Set<Chunk>} chunks needing a (re)mesh */
    this._dirty = new Set();
    /** @type {Set<Chunk>} dirty chunks that skip the mesh budget and distance check (edits) */
    this._urgent = new Set();
    /** @type {string[]} keys of chunks unloaded since the last consumeUnloadedChunks() */
    this._unloaded = [];
    /** @type {string[]} the other buffer of the consumeUnloadedChunks() double buffer */
    this._unloadedSpare = [];

    // getBlock cache: last chunk looked up.
    this._lastChunk = null;

    // Streaming focus (player chunk) and the scan cursor into GEN_OFFSETS.
    this._hasFocus = false;
    this._focusCx = 0;
    this._focusCz = 0;
    this._genCursor = 0;

    // Mesh-queue bookkeeping (see the header comment).
    this._version = 0; // bumped by every change that can alter the mesh queue
    this._idleVersion = -1; // version at which consumeDirtyChunks last found nothing eligible
    this._pendingVersion = -1; // version at which _pendingCount was computed
    this._pendingCount = 0;
    this._result = []; // reused return value of consumeDirtyChunks
    this._candidates = []; // scratch for consumeDirtyChunks, kept sorted nearest first
    this._far = []; // scratch for _setFocus
  }

  // ---- Lookup -------------------------------------------------------------

  /**
   * Loaded chunk at chunk coords, or undefined.
   * @param {number} cx
   * @param {number} cz
   * @returns {Chunk|undefined}
   */
  getChunk(cx, cz) {
    const last = this._lastChunk;
    if (last !== null && last.cx === cx && last.cz === cz) return last;
    const chunk = this._chunks.get(numKey(cx, cz));
    if (chunk === undefined || chunk.cx !== cx || chunk.cz !== cz) return undefined;
    this._lastChunk = chunk;
    return chunk;
  }

  /**
   * Does chunk (cx, cz) have block data loaded?
   * @returns {boolean}
   */
  hasChunkData(cx, cz) {
    return this.getChunk(cx, cz) !== undefined;
  }

  /**
   * Block id at integer world coords. AIR for y outside 0..WORLD_HEIGHT-1 or an unloaded chunk.
   * Hot path: no allocations (numeric keys + last-chunk cache).
   * @returns {number}
   */
  getBlock(x, y, z) {
    if (!(y >= 0 && y < WORLD_HEIGHT)) return B.AIR; // also rejects NaN
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const chunk = this.getChunk(cx, cz);
    if (chunk === undefined) return B.AIR;
    return chunk.blocks[(Math.floor(y) * CS + (Math.floor(z) - cz * CS)) * CS + (Math.floor(x) - cx * CS)];
  }

  /**
   * Y of the highest solid block in column (x, z), or -1 if none / chunk not loaded.
   * Trees count (leaves and logs are solid); water does not.
   * @returns {number}
   */
  heightAt(x, z) {
    x = Math.floor(x);
    z = Math.floor(z);
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const chunk = this.getChunk(cx, cz);
    if (chunk === undefined) return -1;
    const col = (z - cz * CS) * CS + (x - cx * CS);
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      if (isSolid(chunk.blocks[y * LAYER + col])) return y;
    }
    return -1;
  }

  /** Number of loaded chunks. */
  loadedChunkCount() {
    return this._chunks.size;
  }

  /**
   * Call fn(chunk) for every loaded chunk (debugging / tests).
   * @param {(chunk: Chunk) => void} fn
   */
  forEachChunk(fn) {
    for (const chunk of this._chunks.values()) fn(chunk);
  }

  // ---- Editing ------------------------------------------------------------

  /**
   * Player edit. Sets the block, records it in the edit map (so it survives unload/regeneration and
   * can be saved), and marks the chunk dirty + urgent; bordering neighbor chunks (including the
   * diagonal one at a corner) are marked dirty + urgent too.
   * @param {number} x integer world x
   * @param {number} y
   * @param {number} z integer world z
   * @param {number} id block id from B
   * @returns {boolean} false if y is out of range, the chunk isn't loaded, or id is invalid
   */
  setBlock(x, y, z, id) {
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return false;
    if (y < 0 || y >= WORLD_HEIGHT || !(id >= 0 && id < 256 && VALID_ID[id] === 1)) return false;
    const cx = Math.floor(x / CS);
    const cz = Math.floor(z / CS);
    const chunk = this.getChunk(cx, cz);
    if (chunk === undefined) return false;
    const lx = x - cx * CS;
    const lz = z - cz * CS;
    const idx = (y * CS + lz) * CS + lx;
    if (chunk.blocks[idx] === id) return true;
    chunk.blocks[idx] = id;

    let edits = this._edits.get(chunk.key);
    if (edits === undefined) {
      edits = new Map();
      this._edits.set(chunk.key, edits);
    }
    edits.set(idx, id);

    this._markUrgent(chunk);
    const nx = lx === 0 ? -1 : lx === CS - 1 ? 1 : 0;
    const nz = lz === 0 ? -1 : lz === CS - 1 ? 1 : 0;
    if (nx !== 0) this._markUrgentAt(cx + nx, cz);
    if (nz !== 0) this._markUrgentAt(cx, cz + nz);
    if (nx !== 0 && nz !== 0) this._markUrgentAt(cx + nx, cz + nz); // corner: for AO across the diagonal
    return true;
  }

  /**
   * All recorded edits as a plain JSON-serializable object: { "cx,cz": [[index, id], ...] },
   * index = blockIndex(lx, y, lz) within that chunk.
   * @returns {Object<string, Array<[number, number]>>}
   */
  getEdits() {
    const out = {};
    for (const [key, edits] of this._edits) {
      if (edits.size === 0) continue;
      const list = [];
      for (const [idx, id] of edits) list.push([idx, id]);
      out[key] = list;
    }
    return out;
  }

  /**
   * Merge edits (getEdits() format) into the edit map. Edits for loaded chunks are applied now and
   * those chunks (plus loaded neighbors) are marked dirty; the rest apply when the chunk generates.
   * Malformed keys/entries are skipped; never throws.
   * @param {unknown} editsObj
   * @returns {number} number of edit entries accepted
   */
  applyEdits(editsObj) {
    if (editsObj === null || typeof editsObj !== 'object' || Array.isArray(editsObj)) return 0;
    let accepted = 0;
    let keys;
    try {
      keys = Object.keys(editsObj);
    } catch {
      return 0;
    }
    for (const key of keys) {
      const m = KEY_RE.exec(key);
      if (m === null) continue;
      const cx = Number(m[1]);
      const cz = Number(m[2]);
      if (!Number.isSafeInteger(cx) || !Number.isSafeInteger(cz)) continue;
      let list;
      try {
        list = editsObj[key];
      } catch {
        continue;
      }
      if (!Array.isArray(list)) continue;
      const normKey = chunkKey(cx, cz); // "-0,01" style keys normalize to "0,1"
      const chunk = this.getChunk(cx, cz);
      let edits = this._edits.get(normKey);
      let changed = false;
      for (const entry of list) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const idx = entry[0];
        const id = entry[1];
        if (!Number.isInteger(idx) || idx < 0 || idx >= CHUNK_VOLUME) continue;
        if (!Number.isInteger(id) || id < 0 || id > 255 || VALID_ID[id] !== 1) continue;
        if (edits === undefined) {
          edits = new Map();
          this._edits.set(normKey, edits);
        }
        edits.set(idx, id);
        accepted++;
        if (chunk !== undefined && chunk.blocks[idx] !== id) {
          chunk.blocks[idx] = id;
          changed = true;
        }
      }
      if (changed) {
        this._markDirty(chunk);
        this._markDirtyAt(cx - 1, cz);
        this._markDirtyAt(cx + 1, cz);
        this._markDirtyAt(cx, cz - 1);
        this._markDirtyAt(cx, cz + 1);
      }
    }
    return accepted;
  }

  /** Forget all recorded edits. Loaded chunks keep their current blocks until regenerated. */
  clearEdits() {
    this._edits.clear();
  }

  // ---- Generation and streaming ---------------------------------------------

  /**
   * Generate chunk (cx, cz) synchronously if it isn't loaded (terrain + recorded edits) and return it.
   * A newly generated chunk is marked dirty.
   * @returns {Chunk}
   */
  ensureChunk(cx, cz) {
    const existing = this.getChunk(cx, cz);
    if (existing !== undefined) return existing;
    const chunk = new Chunk(cx, cz, this.terrain.generateChunk(cx, cz));
    const edits = this._edits.get(chunk.key);
    if (edits !== undefined) {
      const blocks = chunk.blocks;
      for (const [idx, id] of edits) blocks[idx] = id;
    }
    const nk = numKey(cx, cz);
    const clash = this._chunks.get(nk);
    if (clash !== undefined) this._unloadChunk(clash); // 32768 chunks away; see numKey
    this._chunks.set(nk, chunk);
    this._dirty.add(chunk);
    this._version++;
    return chunk;
  }

  /**
   * Synchronously generate every chunk within `radius` chunks (circular: dx*dx + dz*dz <= r*r) of
   * world position (x, z), e.g. for spawn. Also makes (x, z) the streaming focus, which
   * consumeDirtyChunks uses for its distance check, and unloads chunks beyond UNLOAD_DISTANCE of it.
   * @param {number} x world x
   * @param {number} z world z
   * @param {number} radius in chunks
   * @returns {number} number of chunks generated
   */
  generateAround(x, z, radius) {
    const pcx = toChunkCoord(Math.floor(x));
    const pcz = toChunkCoord(Math.floor(z));
    this._setFocus(pcx, pcz);
    const r = Math.max(0, Math.floor(radius));
    let generated = 0;
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz > r * r) continue;
        if (!this.hasChunkData(pcx + dx, pcz + dz)) {
          this.ensureChunk(pcx + dx, pcz + dz);
          generated++;
        }
      }
    }
    return generated;
  }

  /**
   * Streaming step; call once per frame with the player position. Generates at most `budget` missing
   * chunks within GEN_DISTANCE (circular), nearest first, and when the player enters a new chunk
   * unloads chunks beyond UNLOAD_DISTANCE (reported by consumeUnloadedChunks).
   * @param {number} playerX
   * @param {number} playerZ
   * @param {number} [budget=CHUNK_GEN_PER_FRAME]
   * @returns {number} number of chunks generated this call
   */
  update(playerX, playerZ, budget = CHUNK_GEN_PER_FRAME) {
    const pcx = toChunkCoord(Math.floor(playerX));
    const pcz = toChunkCoord(Math.floor(playerZ));
    this._setFocus(pcx, pcz);
    const { xs, zs, count } = GEN_OFFSETS;
    let generated = 0;
    // Chunks before the cursor are known to be loaded: nothing unloads them until the focus changes,
    // which resets the cursor.
    while (generated < budget && this._genCursor < count) {
      const i = this._genCursor;
      const cx = pcx + xs[i];
      const cz = pcz + zs[i];
      if (!this.hasChunkData(cx, cz)) {
        this.ensureChunk(cx, cz);
        generated++;
      }
      this._genCursor++;
    }
    return generated;
  }

  /**
   * Chunks that need a (re)mesh, removed from the dirty set. Only "meshable" chunks are returned: the
   * chunk and its 4 horizontal neighbors have data. Urgent (edited) chunks come first and ignore
   * `limit` and distance; the rest must be within RENDER_DISTANCE (circular) of the streaming focus
   * and are capped at `limit`, nearest first. Non-meshable chunks stay queued.
   *
   * The returned array is reused: it is only valid until the next consumeDirtyChunks() call. Allocates
   * nothing, and returns immediately when nothing changed since a call that found no eligible chunk.
   * @param {number} [limit=Infinity]
   * @returns {Chunk[]}
   */
  consumeDirtyChunks(limit = Infinity) {
    const result = this._result;
    result.length = 0;
    if (this._dirty.size === 0 || this._version === this._idleVersion) return result;
    const cands = this._candidates;
    cands.length = 0;
    const max = limit > 0 ? limit : 0;
    let eligible = 0;
    for (const chunk of this._dirty) {
      if (!this._isMeshable(chunk)) continue;
      if (this._urgent.has(chunk)) {
        result.push(chunk);
        continue;
      }
      const dist = this._dist(chunk); // from chunk (0,0) until a focus is set, as before
      if (this._hasFocus && dist > RENDER_SQ) continue;
      eligible++;
      // Keep the `max` nearest in `cands`, sorted by distance (stable: ties keep dirty-set order).
      // Insertion instead of sort(): no comparator closure, and max is tiny per frame.
      if (max === 0 || (cands.length >= max && this._dist(cands[cands.length - 1]) <= dist)) continue;
      let j = cands.length < max ? cands.length : cands.length - 1;
      while (j > 0 && this._dist(cands[j - 1]) > dist) {
        cands[j] = cands[j - 1];
        j--;
      }
      cands[j] = chunk;
    }
    if (result.length === 0 && eligible === 0) {
      // Nothing can come out until something changes (load/unload, dirty mark, focus move).
      this._idleVersion = this._version;
      return result;
    }
    for (let i = 0; i < result.length; i++) {
      this._dirty.delete(result[i]);
      this._urgent.delete(result[i]);
    }
    for (let i = 0; i < cands.length; i++) {
      result.push(cands[i]);
      this._dirty.delete(cands[i]);
    }
    cands.length = 0;
    if (result.length > 0) this._version++;
    return result;
  }

  /**
   * Number of dirty chunks waiting for a mesh that will be meshed from the current position
   * (urgent ones, or within RENDER_DISTANCE of the focus). For the debug overlay. Cached until the
   * queue changes, so calling it every frame costs nothing.
   * @returns {number}
   */
  pendingMeshCount() {
    if (this._pendingVersion === this._version) return this._pendingCount;
    let n = 0;
    if (!this._hasFocus) {
      n = this._dirty.size;
    } else {
      for (const chunk of this._dirty) {
        if (this._dist(chunk) <= RENDER_SQ || this._urgent.has(chunk)) n++;
      }
    }
    this._pendingCount = n;
    this._pendingVersion = this._version;
    return n;
  }

  /**
   * Keys (`cx,cz`) of chunks unloaded since the last call, so the renderer can dispose their meshes.
   * The returned array is reused (double buffer): it is only valid until the next call. No allocation.
   * @returns {string[]}
   */
  consumeUnloadedChunks() {
    const out = this._unloaded;
    if (out.length === 0) return out;
    const next = this._unloadedSpare;
    next.length = 0;
    this._unloaded = next;
    this._unloadedSpare = out;
    return out;
  }

  // ---- Internals ------------------------------------------------------------

  /** Squared chunk distance from the streaming focus. */
  _dist(chunk) {
    const dx = chunk.cx - this._focusCx;
    const dz = chunk.cz - this._focusCz;
    return dx * dx + dz * dz;
  }

  _isMeshable(chunk) {
    const cx = chunk.cx;
    const cz = chunk.cz;
    return this.hasChunkData(cx - 1, cz) && this.hasChunkData(cx + 1, cz)
      && this.hasChunkData(cx, cz - 1) && this.hasChunkData(cx, cz + 1);
  }

  _markDirty(chunk) {
    this._dirty.add(chunk);
    this._version++;
  }

  _markDirtyAt(cx, cz) {
    const chunk = this.getChunk(cx, cz);
    if (chunk !== undefined) this._markDirty(chunk);
  }

  _markUrgent(chunk) {
    this._dirty.add(chunk);
    this._urgent.add(chunk);
    this._version++;
  }

  _markUrgentAt(cx, cz) {
    const chunk = this.getChunk(cx, cz);
    if (chunk !== undefined) this._markUrgent(chunk);
  }

  _setFocus(pcx, pcz) {
    if (this._hasFocus && pcx === this._focusCx && pcz === this._focusCz) return;
    this._hasFocus = true;
    this._focusCx = pcx;
    this._focusCz = pcz;
    this._genCursor = 0;
    this._version++;
    const far = this._far;
    far.length = 0;
    for (const chunk of this._chunks.values()) {
      const dx = chunk.cx - pcx;
      const dz = chunk.cz - pcz;
      if (dx * dx + dz * dz > UNLOAD_SQ) far.push(chunk);
    }
    for (let i = 0; i < far.length; i++) this._unloadChunk(far[i]);
    far.length = 0;
  }

  _unloadChunk(chunk) {
    const nk = numKey(chunk.cx, chunk.cz);
    if (this._chunks.get(nk) !== chunk) return;
    this._chunks.delete(nk);
    this._dirty.delete(chunk);
    this._urgent.delete(chunk);
    if (this._lastChunk === chunk) this._lastChunk = null;
    this._unloaded.push(chunk.key);
    this._version++;
  }
}
