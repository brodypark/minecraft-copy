// Pointer lock and raw input state (PROJECT.md Task 6, section 7 Controls).
//
// This module only records input; the game decides what to do with it each frame.
//   - Held keys (by KeyboardEvent.code) are recorded whether or not the pointer is locked.
//   - Mouse movement, mouse buttons and the wheel are recorded only while locked
//     (or while setForceCapture(true) is on, for headless automation in dev builds).
//   - One-shot inputs are read with consume*() calls, which reset them. Read each one
//     every frame (even while paused, and drop the value) so nothing fires late on resume.
//
// Events consumed by later tasks:
//   consumeActions()      -> block editing (Task 7)
//   consumeWheel(), consumeSlotKey() -> hotbar (Task 8)
//   consumeDebugToggle()  -> F3 overlay (Task 8)
//   consumeFlyToggle()    -> player.js

import { DOUBLE_TAP_MS, WHEEL_STEP_MS } from '../config.js';

const SLOT_CODES = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9'];

function isEditableTarget(t) {
  if (!t) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Attach input listeners. Clicking `domElement` requests pointer lock.
 *
 * @param {HTMLElement} domElement the game canvas (pointer lock target)
 * @returns {{
 *   readonly locked: boolean,
 *   requestLock: () => void,
 *   onLockChange: (fn: (locked: boolean) => void) => () => void,
 *   isDown: (code: string) => boolean,
 *   consumeMouseDelta: () => { dx: number, dy: number },
 *   consumeActions: () => Array<'break'|'place'>,
 *   consumeWheel: () => number,
 *   consumeSlotKey: () => number,
 *   consumeDebugToggle: () => boolean,
 *   consumeFlyToggle: () => boolean,
 *   setForceCapture: (on: boolean) => void,
 *   dispose: () => void,
 * }}
 */
export function createControls(domElement) {
  const doc = document;
  const win = window;

  let locked = false;
  let forceCapture = false;
  const lockListeners = [];

  const keys = new Set();

  const mouseDelta = { dx: 0, dy: 0 }; // returned object (reused)
  let accDx = 0;
  let accDy = 0;

  // Double-buffered action queue: consumeActions() hands out one array and records into the other.
  let actions = [];
  let actionsOut = [];

  let wheelSteps = 0;
  let lastWheelTime = -Infinity;
  let lastWheelSign = 0;

  let slotKey = -1;
  let debugToggle = false;
  let flyToggle = false;
  let lastSpaceTime = -Infinity;

  const capturing = () => locked || forceCapture;

  function clearHeld() {
    keys.clear();
  }

  function clearMouse() {
    accDx = 0;
    accDy = 0;
    actions.length = 0;
    wheelSteps = 0;
  }

  // ---- Pointer lock ---------------------------------------------------------

  /** Request pointer lock. Must run inside a user gesture (click); failures are swallowed. */
  function requestLock() {
    if (locked || typeof domElement.requestPointerLock !== 'function') return;
    try {
      const result = domElement.requestPointerLock();
      // Newer browsers return a Promise that rejects e.g. when re-locking too soon after Esc.
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Older implementations may throw synchronously; nothing useful to do.
    }
  }

  function onPointerLockChange() {
    const now = doc.pointerLockElement === domElement;
    if (now === locked) return;
    locked = now;
    if (!locked) {
      // Esc or tab switch: nothing may stay held, and stale mouse input must not apply later.
      clearHeld();
      clearMouse();
    }
    for (const fn of lockListeners) fn(locked);
  }

  function onPointerLockError() {
    // Lock was refused (e.g. clicked again too soon after Esc). The next click retries.
  }

  function onCanvasClick() {
    if (!locked) requestLock();
  }

  // ---- Mouse ----------------------------------------------------------------

  function onMouseMove(e) {
    if (!capturing()) return;
    accDx += e.movementX || 0;
    accDy += e.movementY || 0;
  }

  function onMouseDown(e) {
    if (!capturing()) return;
    if (e.button === 0) actions.push('break');
    else if (e.button === 2) actions.push('place');
  }

  function onContextMenu(e) {
    e.preventDefault();
  }

  // One step per wheel event in the direction of deltaY (positive = scroll down). Trackpads
  // and smooth-scrolling wheels fire many small events, so a burst in the same direction is
  // throttled to one step per WHEEL_STEP_MS.
  function onWheel(e) {
    if (!capturing()) return;
    const sign = Math.sign(e.deltaY);
    if (sign === 0) return;
    const t = e.timeStamp;
    if (sign === lastWheelSign && t - lastWheelTime < WHEEL_STEP_MS) return;
    lastWheelSign = sign;
    lastWheelTime = t;
    wheelSteps += sign;
  }

  // ---- Keyboard -------------------------------------------------------------

  function onKeyDown(e) {
    if (isEditableTarget(e.target)) return;
    const code = e.code;
    if (code === 'F3') {
      e.preventDefault(); // browser "find" otherwise
      if (!e.repeat) debugToggle = true;
      return;
    }
    keys.add(code);
    if (e.repeat) return;
    if (code === 'Space') {
      const t = e.timeStamp;
      if (t - lastSpaceTime <= DOUBLE_TAP_MS) {
        flyToggle = true;
        lastSpaceTime = -Infinity; // a third tap starts a new pair
      } else {
        lastSpaceTime = t;
      }
      return;
    }
    const slot = SLOT_CODES.indexOf(code);
    if (slot !== -1) slotKey = slot;
  }

  function onKeyUp(e) {
    keys.delete(e.code);
  }

  function onBlur() {
    clearHeld();
  }

  function onVisibilityChange() {
    if (doc.hidden) clearHeld();
  }

  // ---- Wiring ---------------------------------------------------------------

  const listeners = [
    [domElement, 'click', onCanvasClick],
    [domElement, 'mousedown', onMouseDown],
    [domElement, 'contextmenu', onContextMenu],
    [domElement, 'wheel', onWheel],
    [doc, 'mousemove', onMouseMove],
    [doc, 'pointerlockchange', onPointerLockChange],
    [doc, 'pointerlockerror', onPointerLockError],
    [doc, 'visibilitychange', onVisibilityChange],
    [win, 'keydown', onKeyDown],
    [win, 'keyup', onKeyUp],
    [win, 'blur', onBlur],
  ];
  for (const [target, type, fn] of listeners) target.addEventListener(type, fn);

  function dispose() {
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    lockListeners.length = 0;
    clearHeld();
    clearMouse();
  }

  return {
    /** True while the pointer is locked to the canvas. */
    get locked() {
      return locked;
    },

    requestLock,

    /**
     * Register fn(locked), called whenever pointer lock is gained or lost.
     * @returns {() => void} unsubscribe
     */
    onLockChange(fn) {
      lockListeners.push(fn);
      return () => {
        const i = lockListeners.indexOf(fn);
        if (i !== -1) lockListeners.splice(i, 1);
      };
    },

    /** Is the key with this KeyboardEvent.code held? (KeyW, Space, ShiftLeft, ...) */
    isDown(code) {
      return keys.has(code);
    },

    /**
     * Mouse movement (pixels) accumulated since the last call, then reset.
     * The same object is returned every call; read it right away.
     */
    consumeMouseDelta() {
      mouseDelta.dx = accDx;
      mouseDelta.dy = accDy;
      accDx = 0;
      accDy = 0;
      return mouseDelta;
    },

    /**
     * Mouse presses since the last call, in order: 'break' (left) or 'place' (right).
     * The returned array is reused and only valid until the next call.
     */
    consumeActions() {
      const out = actions;
      actions = actionsOut;
      actions.length = 0;
      actionsOut = out;
      return out;
    },

    /** Wheel steps since the last call (integer; positive = scroll down), then reset. */
    consumeWheel() {
      const steps = wheelSteps;
      wheelSteps = 0;
      return steps;
    },

    /** Last Digit1..Digit9 pressed since the last call as 0..8, or -1. */
    consumeSlotKey() {
      const slot = slotKey;
      slotKey = -1;
      return slot;
    },

    /** True once per F3 press. */
    consumeDebugToggle() {
      const t = debugToggle;
      debugToggle = false;
      return t;
    },

    /** True once per Space double-tap (two non-repeat presses within DOUBLE_TAP_MS). */
    consumeFlyToggle() {
      const t = flyToggle;
      flyToggle = false;
      return t;
    },

    /**
     * Record mouse movement, buttons and wheel even without pointer lock (headless automation;
     * main.js only calls this in dev builds).
     */
    setForceCapture(on) {
      forceCapture = !!on;
      if (!capturing()) clearMouse();
    },

    dispose,
  };
}
