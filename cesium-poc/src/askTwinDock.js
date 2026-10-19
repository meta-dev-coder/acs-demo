/**
 * Docking for the Ask the Twin panel: a full-height column on the right of the whole application.
 *
 * The map and every overlay on it are absolutely positioned against <body>, so docking narrows the
 * body and makes it their containing block: the map, the navigation controls, the TMC panel and the
 * detail cards all move left with it instead of sitting under the panel. Undocking restores both.
 *
 * Width, the reading (expanded) mode and the panel's settings are per-viewer conveniences, kept in
 * localStorage behind try/catch: a private window simply starts from the defaults.
 */
export const MIN_WIDTH = 340;
export const DEFAULT_WIDTH = 420;
/** Docked, the map keeps at least this share of the window; reading mode may take more. */
export const MAX_DOCK_SHARE = 0.5;
export const EXPANDED_SHARE = 0.72;
const STORAGE_KEY = 'askTwin.panel.v1';

export const DEFAULT_SETTINGS = Object.freeze({
  /** Move the map on its own for a high-confidence answer whose target a lookup returned. */
  autoRunMap: true,
  /** Keep each answer's activity log open after the answer arrives. */
  keepActivityOpen: true,
});

/** Saved width and settings, or the defaults when storage is empty, blocked or corrupt. */
export function loadPrefs(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null');
    return {
      width: Number.isFinite(saved?.width) ? saved.width : DEFAULT_WIDTH,
      settings: { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(saved?.settings ?? {}).filter(([k, v]) => k in DEFAULT_SETTINGS && typeof v === 'boolean')) },
    };
  } catch {
    return { width: DEFAULT_WIDTH, settings: { ...DEFAULT_SETTINGS } };
  }
}

export function savePrefs(prefs, storage = globalThis.localStorage) {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* storage blocked: defaults next time */ }
}

/** The docked width actually used for a requested width and window width. */
export function clampWidth(width, windowWidth, { expanded = false } = {}) {
  if (expanded) return Math.round(windowWidth * EXPANDED_SHARE);
  const max = Math.max(MIN_WIDTH, Math.round(windowWidth * MAX_DOCK_SHARE));
  return Math.min(max, Math.max(MIN_WIDTH, Math.round(width)));
}

/**
 * @param {HTMLElement} panel   the docked panel
 * @param {HTMLElement} handle  the drag handle on its left edge
 * @param {{onResize?: () => void}} [options]  called after the dock changes width (the map re-renders)
 */
export function createDock(panel, handle, { onResize = () => {} } = {}) {
  const prefs = loadPrefs();
  let docked = false, expanded = false;
  const root = document.documentElement;

  function apply() {
    const width = docked ? clampWidth(prefs.width, window.innerWidth, { expanded }) : 0;
    root.style.setProperty('--ask-twin-dock', `${width}px`);
    document.body.classList.toggle('ask-twin-docked', docked);
    panel.classList.toggle('ask-twin-panel--expanded', expanded);
    onResize();
  }

  // Drag the left edge; the width is saved when the drag ends.
  handle.addEventListener('pointerdown', down => {
    if (expanded) return;
    down.preventDefault();
    handle.setPointerCapture(down.pointerId);
    const move = event => { prefs.width = clampWidth(window.innerWidth - event.clientX, window.innerWidth); apply(); };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      savePrefs(prefs);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
  // Keyboard resizing for the same handle.
  handle.addEventListener('keydown', event => {
    const step = event.key === 'ArrowLeft' ? 24 : event.key === 'ArrowRight' ? -24 : 0;
    if (!step || expanded) return;
    event.preventDefault();
    prefs.width = clampWidth(prefs.width + step, window.innerWidth);
    apply();
    savePrefs(prefs);
  });
  const onWindowResize = () => { if (docked) apply(); };
  window.addEventListener('resize', onWindowResize);

  return {
    get settings() { return prefs.settings; },
    get expanded() { return expanded; },
    setDocked(next) { docked = next; if (!next) expanded = false; apply(); },
    setExpanded(next) { expanded = next; apply(); },
    setSetting(key, value) { if (key in DEFAULT_SETTINGS) { prefs.settings[key] = Boolean(value); savePrefs(prefs); } },
    destroy() {
      window.removeEventListener('resize', onWindowResize);
      docked = false; expanded = false;
      root.style.removeProperty('--ask-twin-dock');
      document.body.classList.remove('ask-twin-docked');
    },
  };
}
