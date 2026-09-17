/**
 * Application theme mode — light or dark.
 *
 * Framework-free on purpose. Almost all of this app's UI is plain DOM styled by i595Demo.css, and
 * only the Asset Explorer is React/MUI, so neither side can own the mode. This module owns it: it
 * writes `data-theme` on the document element, which is what the CSS custom properties key off, and
 * the MUI theme is derived from the same mode so the island cannot drift from the rest of the UI.
 *
 * The map is deliberately not part of this. Cesium's canvas, Google's tiles, the credits and every
 * semantic colour (traffic, severity, route) are unaffected by the mode: a theme is a property of
 * the application chrome, not of what the map means.
 */

export const THEME_STORAGE_KEY = 'i595-theme-mode';
export const THEME_MODES = Object.freeze({ LIGHT: 'light', DARK: 'dark' });
/** The application shipped dark, so that stays the default when nothing is stored. */
export const DEFAULT_THEME_MODE = THEME_MODES.DARK;

const isMode = value => value === THEME_MODES.LIGHT || value === THEME_MODES.DARK;

/** Reads the stored preference. Storage can throw (private mode, blocked cookies) — that is not fatal. */
export function storedThemeMode(storage = globalThis.localStorage) {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isMode(value) ? value : null;
  } catch {
    return null;
  }
}

export function createThemeMode({ root = document.documentElement, storage = globalThis.localStorage } = {}) {
  let mode = storedThemeMode(storage) ?? DEFAULT_THEME_MODE;
  const listeners = new Set();

  function apply() {
    // Dark is the stylesheet's base, so only light needs an attribute — but both are written so a
    // selector can target either explicitly without relying on absence.
    root.setAttribute('data-theme', mode);
  }
  apply();

  return {
    get mode() { return mode; },
    get isLight() { return mode === THEME_MODES.LIGHT; },
    set(next) {
      if (!isMode(next) || next === mode) return mode;
      mode = next;
      apply();
      try { storage?.setItem(THEME_STORAGE_KEY, mode); } catch { /* preference is a convenience */ }
      for (const listener of [...listeners]) listener(mode);
      return mode;
    },
    toggle() { return this.set(mode === THEME_MODES.DARK ? THEME_MODES.LIGHT : THEME_MODES.DARK); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { listeners.clear(); },
  };
}
