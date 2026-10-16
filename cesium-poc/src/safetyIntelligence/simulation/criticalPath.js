/**
 * What is actually controlling lane reopening, and what would change it.
 *
 * The Lab could already say which gate vehicle removal was waiting on. This answers the larger
 * question an operator brings: of the dozen things I could change, which ones MOVE the answer and
 * which ones only cost money? The difference matters — pulling a tow forward ten minutes while an
 * investigation hold is binding buys nothing and still pays for the tow.
 *
 * Two parts, both computed from the engine itself rather than from rules written here:
 *
 *   • The CRITICAL PATH — the chain of stages that, taken together, set the reopening time, and the
 *     slack on everything else.
 *   • A SENSITIVITY SWEEP — each lever is moved, on its own, through a stated range, and the
 *     simulation is re-run. Whatever the result is, it is what the model does, not what anybody
 *     expected it to do.
 *
 * Nothing here is hard-coded: give it a different incident and the answers change with it.
 */
import { DEFAULT_RESPONSE, RESPONSE_BOUNDS } from './responseTimeline.js';

/**
 * The levers worth testing, and the range each is swept through.
 *
 * `direction: -1` means smaller is the improvement (arrive sooner); `+1` means larger is (more
 * crews). The ranges are operationally plausible, not the full validation bounds — sweeping
 * detection from 1 to 60 minutes would answer a question nobody is asking.
 */
export const SENSITIVITY_LEVERS = Object.freeze([
  { key: 'detectionMinutes', label: 'Detection time', unit: 'min', range: [2, 4, 6, 10, 15], direction: -1 },
  { key: 'verificationMinutes', label: 'Verification time', unit: 'min', range: [1, 2, 3, 5], direction: -1 },
  { key: 'dispatchMinutes', label: 'Dispatch time', unit: 'min', range: [1, 2, 3, 5], direction: -1 },
  { key: 'rangerTravelMinutes', label: 'Road Ranger travel', unit: 'min', range: [5, 8, 12, 18, 25], direction: -1 },
  { key: 'towTravelMinutes', label: 'Tow travel', unit: 'min', range: [10, 16, 22, 30, 40], direction: -1 },
  { key: 'towDispatchOffsetMinutes', label: 'Tow rolled early', unit: 'min', range: [-15, -8, 0, 10], direction: -1 },
  { key: 'rangers', label: 'Road Rangers on scene', unit: 'units', range: [1, 2, 3, 4], direction: 1 },
  { key: 'towTrucks', label: 'Tow trucks', unit: 'units', range: [1, 2, 3], direction: 1 },
  { key: 'sceneProtectionMinutes', label: 'Scene protection', unit: 'min', range: [5, 10, 15, 25], direction: -1 },
  { key: 'vehicleRemovalMinutes', label: 'Vehicle removal', unit: 'min', range: [10, 18, 25, 40, 60], direction: -1 },
  { key: 'debrisClearanceMinutes', label: 'Debris clearance', unit: 'min', range: [3, 8, 12, 20, 30], direction: -1 },
  { key: 'partialReopenAfterProtectionMinutes', label: 'Partial reopening delay', unit: 'min', range: [0, 5, 15, 30], direction: -1 },
  { key: 'warningActivationMinutes', label: 'Warning activation', unit: 'min', range: [3, 6, 10, 20], direction: -1 },
]);

/** How the measures respond. Each reads one number off a run. */
export const MEASURES = Object.freeze([
  { id: 'reopening', label: 'Lane reopening', unit: 'min', read: run => run.timeline.roadwayClearanceMinutes },
  { id: 'dissipation', label: 'Queue recovery', unit: 'min', read: run => run.queue.queueDissipationMinutes ?? null },
  { id: 'delay', label: 'Vehicle-hours of delay', unit: 'veh-h', read: run => run.queue.vehicleHoursOfDelay },
  { id: 'cost', label: 'Total modelled cost', unit: 'USD', read: run => run.economics.totalModelledCostUSD },
  { id: 'exposure', label: 'Secondary exposure', unit: 'veh-h queued', read: run => run.exposure.vehicleHoursExposed },
]);

/**
 * The critical path through one run's timeline.
 *
 * Reopening is `removalStart + removal + debris`, and `removalStart` is the latest of four gates.
 * So the path is: whichever gate won, plus everything that gate itself depended on. Every other
 * stage has SLACK — the minutes by which it could slip before it started to matter.
 */
export function criticalPath(run) {
  const timeline = run?.timeline;
  if (!timeline) return null;
  const binding = timeline.bindingConstraint;

  /** What each gate depended on, so the chain can be walked back to the incident. */
  const CHAINS = Object.freeze({
    investigation: ['detected', 'verified', 'dispatched', 'rangerArrival', 'sceneProtected'],
    medical: ['detected', 'verified', 'dispatched', 'rangerArrival'],
    assessment: ['detected', 'verified', 'dispatched', 'rangerArrival', 'sceneProtected'],
    tow: ['detected', 'verified', 'dispatched', 'towArrival'],
  });
  const onPath = new Set([...(CHAINS[binding.id] ?? []), 'removalStart', 'removalDone', 'fullReopen']);

  const stages = timeline.stages.map(stage => {
    const critical = onPath.has(stage.id)
      || (stage.id === 'sceneProtected' && binding.id !== 'tow');
    /**
     * Slack: how far this stage could slip before it changed the answer.
     *
     * For a gate, that is the distance to the gate that actually won. For a stage off the path
     * entirely, it is how long it has before it would become the binding one.
     */
    const gate = timeline.gates.find(entry => entry.id === stage.id
      || (stage.id === 'towArrival' && entry.id === 'tow'));
    const slack = gate ? Number((binding.atMinute - gate.at).toFixed(1))
      : critical ? 0 : null;
    return Object.freeze({ ...stage, critical, slackMinutes: slack });
  });

  return Object.freeze({
    binding,
    stages: Object.freeze(stages),
    /** The gates, with how far each was from being the one that mattered. */
    gates: Object.freeze(timeline.gates.map(gate => Object.freeze({
      ...gate,
      binding: gate.id === binding.id,
      slackMinutes: Number((binding.atMinute - gate.at).toFixed(1)),
    })).sort((a, b) => b.at - a.at)),
    earliestReopening: Number((binding.atMinute
      + (timeline.fullReopen - timeline.removalStart)).toFixed(0)),
    /**
     * Said in the words an operator would use, because "the binding constraint is `investigation`"
     * is not an explanation.
     */
    explanation: `Lane reopening is ${Math.round(timeline.roadwayClearanceMinutes)} minutes because `
      + `vehicle removal could not begin until ${binding.label} finished at `
      + `${Math.round(binding.atMinute)} minutes, and removal plus debris clearance then took `
      + `${Math.round(timeline.fullReopen - timeline.removalStart)} minutes. `
      + (binding.slackMinutes > 0
        ? `The next thing in line — ${timeline.gates.filter(gate => gate.id !== binding.id)
          .sort((a, b) => b.at - a.at)[0]?.label ?? 'the next stage'} — was ready `
          + `${Math.round(binding.slackMinutes)} minutes earlier, so improving it changes nothing `
          + 'until the binding constraint moves.'
        : 'Two constraints finish together here, so both would have to move.'),
    constraints: timeline.constraintsApplied,
  });
}

/**
 * Move one lever at a time and see what the engine does.
 *
 * @param {(response: object) => object} run the simulation, injected so this never models anything
 *        itself — the numbers are the Lab's own
 * @param {object} baselineRun the run everything is measured against
 * @param {{levers?: object[]}} [options]
 */
export function sensitivity(run, baselineRun, { levers = SENSITIVITY_LEVERS } = {}) {
  const base = baselineRun.inputs.response;
  const baseline = Object.fromEntries(MEASURES.map(measure => [measure.id, measure.read(baselineRun)]));

  const rows = levers.map(lever => {
    const points = lever.range
      .filter(value => {
        const bounds = RESPONSE_BOUNDS[lever.key];
        return !bounds || (value >= bounds[0] && value <= bounds[1]);
      })
      .map(value => {
        const result = run({ ...base, [lever.key]: value });
        return Object.freeze({
          value,
          measures: Object.fromEntries(MEASURES.map(measure => [measure.id, measure.read(result)])),
        });
      });

    /** The best this lever can do on its own, within the range tested. */
    const bestReopening = Number(Math.min(...points.map(point => point.measures.reopening)).toFixed(0));
    const bestCost = Math.min(...points.map(point => point.measures.cost));
    const reopeningRange = Number((Math.max(...points.map(point => point.measures.reopening))
      - bestReopening).toFixed(0));
    const costRange = Math.round(Math.max(...points.map(point => point.measures.cost)) - bestCost);

    return Object.freeze({
      key: lever.key,
      label: lever.label,
      unit: lever.unit,
      baselineValue: base[lever.key] ?? DEFAULT_RESPONSE[lever.key],
      points: Object.freeze(points),
      /** Does moving this lever alone change when the lanes open? */
      movesReopening: reopeningRange > 0.5,
      reopeningRangeMinutes: reopeningRange,
      bestReopeningMinutes: bestReopening,
      costRangeUSD: costRange,
      bestCostUSD: bestCost,
      /** The whole point of the table: a lever that costs and does not help. */
      verdict: reopeningRange > 0.5 ? 'MOVES_REOPENING'
        : costRange > 0.5 ? 'COSTS_WITHOUT_REOPENING'
          : 'NO_EFFECT_MODELLED',
    });
  });

  const movers = rows.filter(row => row.movesReopening)
    .sort((a, b) => b.reopeningRangeMinutes - a.reopeningRangeMinutes);

  return Object.freeze({
    baseline,
    rows: Object.freeze(rows.sort((a, b) => b.reopeningRangeMinutes - a.reopeningRangeMinutes
      || b.costRangeUSD - a.costRangeUSD)),
    movers: Object.freeze(movers),
    /** Levers that change nothing about when the lanes open. */
    inert: Object.freeze(rows.filter(row => !row.movesReopening)),
    method: 'Each input is moved on its own through a stated range with everything else held, and '
      + 'the simulation is re-run for every point. One-at-a-time: it shows which inputs matter now, '
      + 'not how they interact once several change together.',
  });
}

/**
 * How much the answer depends on inputs nobody measured.
 *
 * Traffic demand, lane count and value of time are assumptions, and the delay and cost figures are
 * linear-ish in all three. If a recommendation survives the plausible range of each, it is robust;
 * if a small change in demand reverses the ranking, the screen should say so rather than present a
 * single number.
 *
 * @param {(overrides: object) => object} runWith takes {traffic, economics} overrides
 */
export function assumptionSensitivity(runWith, { demandFactors = [0.7, 0.85, 1, 1.15, 1.3],
  laneCounts = [3, 4, 5], valueOfTimeFactors = [0.6, 1, 1.5] } = {}) {
  const baseline = runWith({});
  const point = (label, group, overrides) => {
    const result = runWith(overrides);
    return Object.freeze({
      label, group,
      delay: result.queue.vehicleHoursOfDelay,
      cost: result.economics.totalModelledCostUSD,
      reopening: result.timeline.roadwayClearanceMinutes,
      changeCostPercent: baseline.economics.totalModelledCostUSD
        ? Number((((result.economics.totalModelledCostUSD - baseline.economics.totalModelledCostUSD)
          / baseline.economics.totalModelledCostUSD) * 100).toFixed(0)) : null,
    });
  };

  const demand = demandFactors.map(factor => point(`${Math.round(factor * 100)}% of assumed demand`,
    'demand', { traffic: { demandVph: Math.round(baseline.inputs.traffic.demandVph * factor) } }));
  const lanes = laneCounts.map(count => point(`${count} lanes`, 'lanes',
    { traffic: { lanesPerDirection: count } }));
  const vot = valueOfTimeFactors.map(factor => point(`${Math.round(factor * 100)}% value of time`,
    'valueOfTime', { economics: {
      valueOfTimePassengerUSD: 19.5 * factor, valueOfTimeHeavyUSD: 48 * factor } }));

  const spread = points => {
    const costs = points.map(entry => entry.cost);
    return Math.round(Math.max(...costs) - Math.min(...costs));
  };
  const groups = Object.freeze([
    { id: 'demand', label: 'Traffic demand', points: Object.freeze(demand), costSpreadUSD: spread(demand) },
    { id: 'lanes', label: 'Lane count', points: Object.freeze(lanes), costSpreadUSD: spread(lanes) },
    { id: 'valueOfTime', label: 'Value of time', points: Object.freeze(vot), costSpreadUSD: spread(vot) },
  ].sort((a, b) => b.costSpreadUSD - a.costSpreadUSD));

  return Object.freeze({
    baselineCostUSD: baseline.economics.totalModelledCostUSD,
    groups,
    mostInfluential: groups[0]?.label ?? null,
    caveat: 'A deterministic sweep of assumption ranges, not a confidence interval. None of these '
      + 'inputs is measured on this corridor, so the spread shows how much the answer rests on them '
      + '— it does not say which value is right.',
    method: 'Each assumption is varied alone, with the response strategy held constant.',
  });
}
