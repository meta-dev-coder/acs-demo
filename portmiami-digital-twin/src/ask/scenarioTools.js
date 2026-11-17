/**
 * Ask the Twin's read-only view of the scenario planner.
 *
 * The rule that matters: the assistant READS saved ScenarioRuns. It never runs the model, never
 * adjusts a figure, and never produces a number of its own. Every value it quotes was computed by
 * `src/scenarios/simulation.js` and persisted — so an answer and the Compare tab cannot disagree,
 * and no model is anywhere near the arithmetic.
 *
 * An unrun scenario is reported as unrun. "I don't have a result for that yet" is the honest
 * answer and it is the one given, rather than running the model implicitly to have something to
 * say.
 */
import { compareRuns, metricsOf, recommend } from '../scenarios/comparison.js';
import { ASSUMPTIONS } from '../config/scenarioPlanner.js';
import { GAP } from './tools.js';

const gap = (kind, message) => ({ ok: false, gap: kind, message });

export const SCENARIO_SOURCE = Object.freeze({
  name: 'Parking scenario runs (synthetic model)',
});

/** Every scenario, with whether it has been run. */
export function listScenarios(view) {
  const scenarios = view.scenarios ?? [];
  if (scenarios.length === 0) return gap(GAP.NOT_LOADED, 'The scenario planner has no scenarios yet.');
  const runs = view.scenarioRuns ?? [];
  return {
    ok: true,
    scenarios: scenarios.map(scenario => {
      const run = [...runs].reverse().find(r => r.scenarioId === scenario.id) ?? null;
      return {
        id: scenario.id, key: scenario.key, name: scenario.name, type: scenario.type,
        additionalSpaces: scenario.assumptions?.additionalSpaces ?? null,
        run, hasRun: Boolean(run),
      };
    }),
    source: SCENARIO_SOURCE,
  };
}

/** Resolve a scenario by key ("A"), by name, or by a loose mention. */
export function findScenario(view, query) {
  const listed = listScenarios(view);
  if (!listed.ok) return listed;
  const needle = String(query ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!needle) return gap(GAP.NOT_FOUND, 'No scenario was named.');

  const byKey = listed.scenarios.filter(s => s.key && needle === `scenario ${s.key.toLowerCase()}`);
  const bare = listed.scenarios.filter(s => s.key && needle === s.key.toLowerCase());
  const byName = listed.scenarios.filter(s => s.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().includes(needle));
  const matches = byKey.length ? byKey : bare.length ? bare : byName;
  if (matches.length === 0) return gap(GAP.NOT_FOUND, `No scenario matches “${query}”.`);
  if (matches.length > 1) {
    return { ok: false, gap: GAP.AMBIGUOUS, message: `“${query}” matches ${matches.map(m => m.name).join(', ')}.`, options: matches };
  }
  return { ok: true, scenario: matches[0], source: SCENARIO_SOURCE };
}

/** One scenario's latest results, straight from the saved run. */
export function getScenarioResult(view, query) {
  const found = findScenario(view, query);
  if (!found.ok) return found;
  if (!found.scenario.hasRun) {
    return gap(GAP.NOT_LOADED,
      `${found.scenario.name} has not been simulated yet, so there are no results to read. `
      + 'Run it in the Simulate tab — I report saved runs rather than producing numbers myself.');
  }
  return {
    ok: true, scenario: found.scenario, run: found.scenario.run,
    metrics: metricsOf(found.scenario.run), source: SCENARIO_SOURCE,
  };
}

/** The comparison across every scenario that has been run. */
export function getScenarioComparison(view) {
  const runs = (view.scenarioRuns ?? []);
  const latest = new Map();
  for (const run of runs) {
    const held = latest.get(run.scenarioId);
    if (!held || run.executedAt >= held.executedAt) latest.set(run.scenarioId, run);
  }
  const rows = compareRuns([...latest.values()]);
  if (rows.length === 0) {
    return gap(GAP.NOT_LOADED, 'No scenario has been simulated yet, so there is nothing to compare.');
  }
  return { ok: true, rows, recommendation: recommend([...latest.values()]), source: SCENARIO_SOURCE };
}

/** The assumptions a run used — from its own snapshot, not from the scenario as it stands now. */
export function getRunAssumptions(view, query) {
  const found = getScenarioResult(view, query);
  if (!found.ok) return found;
  const snapshot = found.run.inputSnapshot?.assumptions ?? {};
  return {
    ok: true,
    scenario: found.scenario,
    modelVersion: found.run.modelVersion,
    dataMode: found.run.dataMode,
    executedAt: found.run.executedAt,
    assumptions: Object.entries(snapshot).map(([key, value]) => ({
      key, value, label: ASSUMPTIONS[key]?.label ?? key, unit: ASSUMPTIONS[key]?.unit ?? '',
      basis: ASSUMPTIONS[key]?.basis ?? null,
    })),
    source: SCENARIO_SOURCE,
  };
}
