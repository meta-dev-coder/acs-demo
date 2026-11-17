/**
 * Durable storage for scenarios and their runs.
 *
 * Same architecture as the link store (`src/infrastructure/assetStore.js`) and the same honest
 * limit: this is a static Vite SPA with no backend, so `localStorage` is the persistence layer.
 * Scenarios survive a refresh and a restart; they are PER BROWSER, invisible on another machine,
 * and lost if site data is cleared. The UI says so. When this twin gains a backend, this file is
 * the only one that changes.
 *
 * What is never written here: the infrastructure registry, the road file or the building extract.
 * A scenario stores the ID of the garage it expands, not a copy of it, so editing a hypothetical
 * can never alter a verified record.
 *
 * Runs are capped and pruned oldest-first. A planner that fills storage silently stops saving,
 * which would be the worst possible failure for a tool whose whole point is reproducibility.
 */
import { MODEL_VERSION } from '../config/scenarioPlanner.js';

export const STORAGE_KEY = 'portmiami.parking.scenarios.v1';
export const SCHEMA_VERSION = 1;
/** Keep the most recent runs. Comfortably more than a demo needs, far short of a quota. */
export const MAX_RUNS = 60;

const empty = () => ({ version: SCHEMA_VERSION, scenarios: [], runs: [], weights: null });

/**
 * Read the store. Every failure — no storage, blocked storage, corrupt JSON, a future schema —
 * returns an empty store rather than throwing, because a demo must still open.
 */
export function loadScenarios(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== SCHEMA_VERSION) return empty();
    return {
      version: SCHEMA_VERSION,
      scenarios: Array.isArray(parsed.scenarios) ? parsed.scenarios : [],
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      weights: parsed.weights ?? null,
    };
  } catch {
    return empty();
  }
}

/** Write the store. Returns false when storage refused, so the UI can say it is not saving. */
export function saveScenarios(state, storage = globalThis.localStorage) {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify({
      version: SCHEMA_VERSION,
      scenarios: state.scenarios ?? [],
      runs: (state.runs ?? []).slice(-MAX_RUNS),
      weights: state.weights ?? null,
    }));
    return true;
  } catch {
    return false;
  }
}

/** Add or replace a scenario, keeping order stable. */
export function upsertScenario(state, scenario) {
  const scenarios = [...(state.scenarios ?? [])];
  const at = scenarios.findIndex(s => s.id === scenario.id);
  if (at >= 0) scenarios[at] = scenario; else scenarios.push(scenario);
  return { ...state, scenarios };
}

/** Remove a scenario and every run that belongs to it — an orphan run is unreadable. */
export function removeScenario(state, scenarioId) {
  return {
    ...state,
    scenarios: (state.scenarios ?? []).filter(s => s.id !== scenarioId),
    runs: (state.runs ?? []).filter(run => run.scenarioId !== scenarioId),
  };
}

/** Record a run, pruning oldest-first. One run per scenario is kept visible as "the latest". */
export function addRun(state, run) {
  return { ...state, runs: [...(state.runs ?? []), run].slice(-MAX_RUNS) };
}

/** The most recent run for each scenario, newest first. */
export function latestRuns(state) {
  const byScenario = new Map();
  for (const run of state.runs ?? []) {
    const held = byScenario.get(run.scenarioId);
    if (!held || run.executedAt >= held.executedAt) byScenario.set(run.scenarioId, run);
  }
  return [...byScenario.values()];
}

/**
 * Runs made by a different version of the formulas.
 *
 * Reported rather than hidden or silently migrated: comparing a run from one model version with a
 * run from another is a quiet way to get a wrong answer, and the planner says which are stale.
 */
export const outdatedRuns = state =>
  (state.runs ?? []).filter(run => run.modelVersion !== MODEL_VERSION);
