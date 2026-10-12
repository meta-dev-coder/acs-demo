/**
 * Data-source toggles for Ask the Twin, like map layers (config/askTwin/sources.json). The selection
 * travels with each question as `screen.sources`; the server refuses lookups outside it and every
 * answer says what was toggled off. Persona presets only set the default selection.
 *
 * Pure apart from the try/catch localStorage helpers, so it is unit-tested in node.
 */
import CONFIG from '../config/askTwin/sources.json' with { type: 'json' };

export const SOURCES = Object.freeze(Object.entries(CONFIG.sources).map(([id, s]) => ({ id, label: s.label, short: s.short ?? s.label })));
export const SOURCE_IDS = Object.freeze(SOURCES.map(s => s.id));
const STORAGE_KEY = 'askTwin.sources.v1';

/** The persona's default sources, or every source for "General". */
export const presetFor = persona => [...(CONFIG.personaPresets[persona] ?? SOURCE_IDS)];

/** A valid, ordered selection; an empty or unknown one falls back to every source. */
export function normalizeSources(ids) {
  const picked = SOURCE_IDS.filter(id => Array.isArray(ids) && ids.includes(id));
  return picked.length ? picked : [...SOURCE_IDS];
}

/** Toggle one source, never leaving none selected (an empty scope would answer nothing). */
export function toggleSource(selected, id) {
  const next = selected.includes(id) ? selected.filter(s => s !== id) : [...selected, id];
  return next.length ? normalizeSources(next) : selected;
}

/** What goes in `screen.sources`: nothing for the de-siloed default, else the selection. */
export const sourcesForScreen = selected => (selected.length === SOURCE_IDS.length ? undefined : [...selected]);

/** One line for an answer: what it drew on and what the user had toggled off. */
export function scopeLine(scope) {
  if (!scope) return '';
  const parts = [];
  if (scope.used?.length) parts.push(`Answered from ${scope.used.join(', ')}`);
  if (scope.excluded?.length) parts.push(`Toggled off: ${scope.excluded.join(', ')}`);
  return parts.join(' · ');
}

export function loadSources(storage = globalThis.localStorage) {
  try { return normalizeSources(JSON.parse(storage?.getItem(STORAGE_KEY) ?? 'null')); } catch { return [...SOURCE_IDS]; }
}
export function saveSources(selected, storage = globalThis.localStorage) {
  try { storage?.setItem(STORAGE_KEY, JSON.stringify(selected)); } catch { /* blocked storage: per-session only */ }
}
