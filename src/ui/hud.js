// Crosshair and pause menu (PROJECT.md section 7 Controls / HUD / Save-load, Task 8).
//
// No DOM access at import time; everything happens inside createHud().
//
// Pause menu: shown while paused. Clicking anywhere on it except the New World area calls
// onResume() (a user gesture, so the caller can request pointer lock there). "New World" asks
// for confirmation inline; only "Yes, new world" calls onNewWorld().

const CONTROLS = [
  [['W', 'A', 'S', 'D'], 'Move'],
  [['Mouse'], 'Look'],
  [['Space'], 'Jump'],
  [['Space', '\u00d72'], 'Toggle fly'], // double-tap
  [['Space', '/', 'Shift'], 'Fly up / down'],
  [['Shift'], 'Sprint'],
  [['Left click'], 'Break block'],
  [['Right click'], 'Place block'],
  [['1-9', '/', 'Wheel'], 'Select block'],
  [['F3'], 'Debug overlay'],
  [['Esc'], 'Pause'],
];

const SEPARATORS = new Set(['/', '\u00d72']); // rendered as plain text between key caps

// A small generic isometric cube for the title (no external assets).
const EMBLEM_SVG = `
<svg class="vs-pause__emblem" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
  <path d="M16 2 30 9 16 16 2 9Z" fill="#7cc75a"/>
  <path d="M2 9 16 16v14L2 23Z" fill="#8a5f3e"/>
  <path d="M30 9 16 16v14l14-7Z" fill="#6b4930"/>
  <path d="M2 9 16 16 30 9v3L16 19 2 12Z" fill="#5fa645"/>
</svg>`;

// White plus with a darker outline so it reads on bright sky and in dark caves.
// Integer rects in a 22x22 box keep the lines crisp.
const CROSSHAIR_SVG = `
<svg viewBox="0 0 22 22" width="22" height="22" aria-hidden="true" focusable="false" shape-rendering="crispEdges">
  <g fill="#000" opacity="0.55"><rect x="9" y="1" width="4" height="20"/><rect x="1" y="9" width="20" height="4"/></g>
  <g fill="#fff"><rect x="10" y="2" width="2" height="18"/><rect x="2" y="10" width="18" height="2"/></g>
</svg>`;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function buildControlsList() {
  const list = el('ul', 'vs-controls');
  for (const [keys, action] of CONTROLS) {
    const item = el('li', 'vs-controls__item');
    const keyBox = el('span', 'vs-controls__keys');
    for (const k of keys) {
      if (SEPARATORS.has(k)) keyBox.appendChild(el('span', 'vs-controls__sep', k));
      else keyBox.appendChild(el('kbd', 'vs-key', k));
    }
    item.append(keyBox, el('span', 'vs-controls__action', action));
    list.appendChild(item);
  }
  return list;
}

/**
 * Create the crosshair and pause menu. Starts paused (menu visible, crosshair hidden).
 *
 * @param {HTMLElement} container element to append the HUD to (e.g. document.body)
 * @param {object} callbacks
 * @param {() => void} callbacks.onResume called on a click on the pause menu (outside the
 *   New World controls). Request pointer lock here; it needs this user gesture.
 * @param {() => void} callbacks.onNewWorld called after the player confirms "Yes, new world".
 * @returns {{ setPaused: (paused: boolean) => void, dispose: () => void }}
 */
export function createHud(container, { onResume, onNewWorld } = {}) {
  const root = el('div', 'vs-ui vs-hud');

  // ---- Crosshair ----
  const crosshair = el('div', 'vs-crosshair');
  crosshair.innerHTML = CROSSHAIR_SVG;
  root.appendChild(crosshair);

  // ---- Pause menu ----
  const overlay = el('div', 'vs-pause');
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', 'Paused');

  const panel = el('div', 'vs-pause__panel');
  const title = el('h1', 'vs-pause__title');
  title.innerHTML = EMBLEM_SVG;
  title.appendChild(el('span', '', 'Voxel Sandbox'));
  const cta = el('div', 'vs-pause__cta', 'Click to play');
  const controlsHeading = el('h2', 'vs-pause__heading', 'Controls');
  const controlsList = buildControlsList();

  const footer = el('div', 'vs-pause__footer');
  const newWorldBtn = el('button', 'vs-btn vs-btn--quiet', 'New World');
  newWorldBtn.type = 'button';

  const confirm = el('div', 'vs-confirm');
  confirm.hidden = true;
  confirm.setAttribute('role', 'alertdialog');
  confirm.appendChild(el('p', 'vs-confirm__text', 'Start a new world? This deletes your current world.'));
  const confirmButtons = el('div', 'vs-confirm__buttons');
  const yesBtn = el('button', 'vs-btn vs-btn--danger', 'Yes, new world');
  yesBtn.type = 'button';
  const cancelBtn = el('button', 'vs-btn', 'Cancel');
  cancelBtn.type = 'button';
  confirmButtons.append(yesBtn, cancelBtn);
  confirm.appendChild(confirmButtons);

  footer.append(newWorldBtn, confirm);
  panel.append(title, cta, controlsHeading, controlsList, footer);
  overlay.appendChild(panel);
  root.appendChild(overlay);
  container.appendChild(root);

  // ---- State ----
  let paused = true;

  function setConfirming(on) {
    newWorldBtn.hidden = on;
    confirm.hidden = !on;
  }

  function blurInside() {
    const active = document.activeElement;
    if (active && active !== document.body && root.contains(active)) active.blur();
  }

  function applyPaused() {
    overlay.classList.toggle('is-hidden', !paused);
    crosshair.classList.toggle('is-hidden', paused);
    setConfirming(false);
    // A focused button must not catch Space/Enter during play.
    if (!paused) blurInside();
  }

  // ---- Events ----
  const onOverlayClick = () => {
    if (paused && typeof onResume === 'function') onResume();
  };
  const stop = (e) => e.stopPropagation();
  const onNewWorldClick = (e) => {
    e.stopPropagation();
    setConfirming(true);
    cancelBtn.focus({ preventScroll: true });
  };
  const onYesClick = (e) => {
    e.stopPropagation();
    setConfirming(false);
    if (typeof onNewWorld === 'function') onNewWorld();
  };
  const onCancelClick = (e) => {
    e.stopPropagation();
    setConfirming(false);
    newWorldBtn.focus({ preventScroll: true });
  };

  const listeners = [
    [overlay, 'click', onOverlayClick],
    [confirm, 'click', stop],
    [newWorldBtn, 'click', onNewWorldClick],
    [yesBtn, 'click', onYesClick],
    [cancelBtn, 'click', onCancelClick],
  ];
  for (const [target, type, fn] of listeners) target.addEventListener(type, fn);

  applyPaused();

  return {
    /** Show the pause menu (true) or the crosshair (false). Re-pausing resets the confirm step. */
    setPaused(p) {
      const next = !!p;
      if (next === paused) return;
      paused = next;
      applyPaused();
    },

    dispose() {
      for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
      root.remove();
    },
  };
}
