/**
 * Hypothetical outage scenarios, held apart from the registry.
 *
 * The asset registry and its connectivity are frozen when the session is created and never
 * written: a scenario is a separate, immutable description (what is offline, which switches are
 * set) applied on top. Nothing here is persisted and nothing is recorded as an incident; "Reset"
 * is simply returning to the baseline description.
 */
import {
  baselineScenario, compareScenario, createNetwork, ENGINE_LIMITATIONS, SWITCH, SWITCHING_TYPES, withOutage, withSwitch,
} from './electricalGraph.js';

const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
};

/**
 * @param {{ assets: object[], edges: object[], notes?: object }} inventory
 * @param {(state) => void} [onChange]  called with the session state after every change
 */
export function createScenarioSession(inventory, { onChange = () => {} } = {}) {
  const frozen = deepFreeze({ assets: inventory.assets.map(a => ({ ...a })), edges: inventory.edges.map(e => ({ ...e })) });
  // A network may describe its own sources (`notes`, see ifcSpatial/ifcNetwork.js); Ask the Twin reads them.
  const network = inventory.notes ? Object.freeze({ ...createNetwork(frozen), notes: inventory.notes }) : createNetwork(frozen);
  let scenario = null;        // null = baseline (no scenario active)
  let result = null;

  const describe = () => {
    if (!scenario) return 'Baseline';
    const parts = [
      ...scenario.offline.map(id => `${network.assets.get(id)?.name ?? id} ${network.assets.get(id)?.assetType === 'FEEDER' ? 'disconnected' : 'offline'}`),
      ...Object.entries(scenario.switches).map(([id, s]) => `${network.assets.get(id)?.name ?? id} ${s === SWITCH.OPEN ? 'opened' : 'closed'}`),
    ];
    return parts.join(' · ') || 'Baseline';
  };
  const state = () => ({ active: Boolean(scenario), scenario, result, label: describe(), limitations: ENGINE_LIMITATIONS });
  const apply = next => {
    scenario = next;
    result = compareScenario(network, scenario);
    onChange(state());
    return state();
  };

  return {
    network,
    state,
    /** Take one asset out (a breaker is opened). Adds to an active scenario. */
    outage(assetId) {
      if (!network.assets.has(assetId)) return null;
      return apply(withOutage(network, scenario ?? baselineScenario(), assetId));
    },
    /** Set a switching device OPEN or CLOSED in the scenario (e.g. close normally-open tie TB1). */
    setSwitch(assetId, position) {
      const a = network.assets.get(assetId);
      if (!a || !SWITCHING_TYPES.has(a.assetType) || !Object.values(SWITCH).includes(position)) return null;
      return apply(withSwitch(scenario ?? baselineScenario(), assetId, position));
    },
    /** Back to the baseline: no scenario, nothing changed. */
    reset() {
      scenario = null;
      result = null;
      onChange(state());
      return state();
    },
  };
}
