/**
 * The same question asked four ways: baseline, equipment only, weather only, both.
 *
 * All four cases share one baseline, one demand, one rate card, one duration and one horizon. Only
 * the condition under test differs — which is what makes the difference between them attributable
 * to that condition and nothing else.
 *
 * The interaction term is the point of the exercise:
 *
 *     interaction = combined − equipment-only − weather-only
 *
 * Negative means the combination hurts more than the two separately; positive means less. It is
 * not assumed to be either: a gantry whose cameras are already struggling in rain has less left to
 * lose when an antenna fails, and the arithmetic says so.
 */
import { runScenario } from './scenarioEngine.js';
import { withConditions } from './scenarioState.js';

/** The cases a comparison runs. `trafficIncident` joins the combined case when one is configured. */
export const COMPARISON_CASES = Object.freeze(['equipment', 'weather', 'incident', 'combined']);

const deltaOf = result => result?.revenueImpact?.delta ?? null;

/**
 * @param {object} scenario the combined scenario as configured
 * @param {{inventory, zones, baseline, sensitivity}} context
 * @returns {{cases: object[], interaction: object|null}}
 */
export function compareScenario(scenario, context = {}) {
  const { inventory = [], zones = [], baseline, sensitivity } = context;
  const run = (label, variant) => {
    const result = runScenario(variant, {
      inventory, ranAt: 0,
      tolling: { baseline, zones, weather: variant.weather, incident: variant.trafficIncident, sensitivity },
    });
    return Object.freeze({ label, scenario: variant, result, money: result.revenueImpact });
  };

  const bare = withConditions({ ...scenario, failures: scenario.failures }, { weather: null, trafficIncident: null });
  const cases = [];
  if (scenario.failures.length) cases.push(run('Equipment only', bare));
  if (scenario.weather) {
    cases.push(run('Weather only', withConditions({ ...scenario, failures: [] },
      { weather: scenario.weather, trafficIncident: null })));
  }
  if (scenario.trafficIncident) {
    cases.push(run('Incident only', withConditions({ ...scenario, failures: [] },
      { weather: null, trafficIncident: scenario.trafficIncident })));
  }
  cases.push(run('Combined', scenario));

  // Only meaningful when both halves were actually run.
  const equipment = cases.find(item => item.label === 'Equipment only');
  const weather = cases.find(item => item.label === 'Weather only');
  const combined = cases.find(item => item.label === 'Combined');
  let interaction = null;
  if (equipment && weather && combined) {
    const net = (deltaOf(combined.result)?.netContributionUSD ?? 0)
      - (deltaOf(equipment.result)?.netContributionUSD ?? 0)
      - (deltaOf(weather.result)?.netContributionUSD ?? 0);
    interaction = Object.freeze({
      netContributionUSD: Number(net.toFixed(2)),
      unrecovered: Number(((deltaOf(combined.result)?.unrecovered ?? 0)
        - (deltaOf(equipment.result)?.unrecovered ?? 0)
        - (deltaOf(weather.result)?.unrecovered ?? 0)).toFixed(1)),
      // Signed the same way as every other figure: negative is worse for the operator.
      reading: net < -0.005 ? 'The combination is worse than the two conditions separately.'
        : net > 0.005 ? 'The combination is less damaging than the two separately, because they '
          + 'compete for the same transactions.'
          : 'The two conditions are additive in this model.',
    });
  }

  return Object.freeze({ cases: Object.freeze(cases), interaction });
}

/** The comparison as rows a table can print, straight from the engine's own figures. */
export function comparisonRows(comparison) {
  const metrics = [
    ['Crossings', money => money.scenario.transactions.crossings, money => money.baseline.transactions.crossings],
    ['Transponder reads', money => money.scenario.transactions.rfidSuccess, money => money.baseline.transactions.rfidSuccess],
    ['Video attempts', money => money.scenario.transactions.videoAttempts, money => money.baseline.transactions.videoAttempts],
    ['Recovered on video', money => money.scenario.transactions.videoRecovered, money => money.baseline.transactions.videoRecovered],
    ['Unrecovered', money => money.scenario.transactions.unrecovered, money => money.baseline.transactions.unrecovered],
    ['Collected revenue', money => money.scenario.money.collectedRevenueUSD, money => money.baseline.money.collectedRevenueUSD],
    ['Processing costs', money => money.scenario.money.processingCostUSD, money => money.baseline.money.processingCostUSD],
    ['Net contribution', money => money.scenario.money.netContributionUSD, money => money.baseline.money.netContributionUSD],
  ];
  const first = comparison.cases[0]?.money;
  return metrics.map(([label, read, readBaseline]) => Object.freeze({
    metric: label,
    baseline: first ? readBaseline(first) : null,
    values: Object.freeze(comparison.cases.map(item => (item.money?.scenario ? read(item.money) : null))),
  }));
}
