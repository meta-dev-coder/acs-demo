/**
 * Saved scenarios, in the browser's own storage.
 *
 * Inputs are saved, never results: a scenario is a question, and a question re-asked of a changed
 * engine or changed assumptions should produce the engine's current answer rather than a stale one
 * replayed from disk. So loading recalculates.
 *
 * The assumptions travel with the scenario — a saved question is not reproducible without the
 * numbers it was asked against — and so does a version, so a file written by an older build can be
 * recognised rather than misread.
 *
 * An asset that no longer exists is reported, never remapped: silently moving a failure onto a
 * different antenna would quietly change what the saved scenario meant.
 */
import { normaliseScenario } from './scenarioState.js';

export const STORE_KEY = 'i595.gantry.scenarios.v1';
export const STORE_VERSION = 1;

const storage = () => {
  try {
    // Private windows, blocked site data and the odd kiosk all throw here rather than returning
    // null, so every call site treats storage as something that may simply not be there.
    const area = globalThis.localStorage;
    return area && typeof area.getItem === 'function' ? area : null;
  } catch { return null; }
};

const read = () => {
  const area = storage();
  if (!area) return [];
  try {
    const parsed = JSON.parse(area.getItem(STORE_KEY) ?? '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
};

const write = entries => {
  const area = storage();
  if (!area) return false;
  try { area.setItem(STORE_KEY, JSON.stringify(entries)); return true; } catch { return false; }
};

/** Every saved scenario, newest first. */
export function listScenarios() {
  return read()
    .filter(entry => entry?.scenario)
    .sort((a, b) => String(b.savedAt ?? '').localeCompare(String(a.savedAt ?? '')));
}

/**
 * Save a scenario under a name, with the assumptions it was asked against.
 *
 * Saving the same name twice replaces it: a named scenario is a thing an operator keeps editing,
 * not a growing pile of near-identical copies.
 */
export function saveScenario({ name, scenario, assumptions, savedAt = Date.now() } = {}) {
  if (!scenario) return null;
  const label = String(name ?? scenario.name ?? 'Scenario').trim() || 'Scenario';
  const entry = {
    id: `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name: label,
    version: STORE_VERSION,
    savedAt: new Date(savedAt).toISOString(),
    scenario: { ...scenario, name: label },
    assumptions,
  };
  const entries = read().filter(item => item.id !== entry.id);
  entries.push(entry);
  return write(entries) ? entry : null;
}

export function deleteScenario(id) {
  const entries = read().filter(entry => entry.id !== id);
  return write(entries);
}

/** A copy under a new name, so one can be varied without losing the original. */
export function duplicateScenario(id, { name = null, savedAt = Date.now() } = {}) {
  const entry = read().find(item => item.id === id);
  if (!entry) return null;
  return saveScenario({
    name: name ?? `${entry.name} copy`, scenario: entry.scenario, assumptions: entry.assumptions, savedAt });
}

/**
 * Load one, checking it against the equipment that exists now.
 *
 * @returns {{scenario, assumptions, warnings: string[]}|null}
 */
export function loadScenario(id, { inventory = [] } = {}) {
  const entry = read().find(item => item.id === id);
  if (!entry) return null;
  const known = new Set(inventory.map(asset => asset.assetId));
  const warnings = [];
  if (entry.version !== STORE_VERSION) {
    warnings.push(`Saved with version ${entry.version}; this build reads version ${STORE_VERSION}.`);
  }
  for (const failure of entry.scenario?.failures ?? entry.scenario?.equipmentFailures ?? []) {
    if (!known.has(failure.assetId)) {
      warnings.push(`${failure.assetId} is no longer on this gantry. It is kept as saved, not remapped.`);
    }
  }
  return Object.freeze({
    entry,
    scenario: normaliseScenario(entry.scenario),
    assumptions: entry.assumptions ?? null,
    warnings: Object.freeze(warnings),
  });
}
