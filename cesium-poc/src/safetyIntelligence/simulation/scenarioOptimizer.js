/**
 * Search the feasible response strategies and rank them against one objective.
 *
 * Two rules decide what this is allowed to return:
 *
 *   • FEASIBILITY IS A CONSTRAINT, not a penalty. A strategy that needs five tow trucks where two
 *     are available is not a worse option — it is not an option, and it is excluded before ranking
 *     rather than scored down and left where somebody might pick it.
 *   • THE FASTEST IS NOT THE BEST. Clearing ten minutes sooner by standing four crews on a live
 *     carriageway costs money and puts more people on the road. The objective decides, and the
 *     trade-offs are reported whichever one is chosen.
 *
 * The search is a deterministic sweep of a stated grid, not a stochastic optimiser: the same
 * baseline and the same bounds always produce the same recommendation, which is what makes the
 * result defensible in a review.
 */

/** The levers, and the values the sweep tries for each. */
/**
 * The levers, and the values the sweep tries for each.
 *
 * It deliberately reaches BEYOND what the corridor can supply — four patrol units where three
 * exist, a three-minute patrol arrival that nothing could achieve — so that the feasibility check
 * has something to exclude and the operator can see what was ruled out and why. A grid that only
 * contained available options would make the constraints look decorative.
 */
export const SEARCH_GRID = Object.freeze({
  detectionMinutes: [2, 4, 6],
  dispatchMinutes: [1, 3],
  rangerTravelMinutes: [3, 5, 8, 12],
  towTravelMinutes: [10, 16, 22],
  towDispatchOffsetMinutes: [-8, 0],
  rangers: [1, 2, 4],
  towTrucks: [1, 3],
  warningActivationMinutes: [3, 10],
  partialReopenAfterProtectionMinutes: [5, 15],
});

export const OBJECTIVES = Object.freeze({
  CLEARANCE: { id: 'CLEARANCE', label: 'Fastest roadway clearance',
    read: result => result.timeline.roadwayClearanceMinutes },
  DELAY: { id: 'DELAY', label: 'Least vehicle-hours of delay',
    read: result => result.queue.vehicleHoursOfDelay },
  ECONOMIC: { id: 'ECONOMIC', label: 'Lowest total modelled cost',
    read: result => result.economics.totalModelledCostUSD },
  EXPOSURE: { id: 'EXPOSURE', label: 'Least secondary-incident exposure',
    read: result => result.exposure.vehicleHoursExposed },
  BALANCED: { id: 'BALANCED', label: 'Balanced outcome',
    /**
     * Total modelled cost already carries delay, response spend and lost revenue in dollars, which
     * is the only common unit these outcomes have. Exposure is added as a priced term so a strategy
     * cannot buy a few dollars by leaving traffic queued longer on a live motorway.
     */
    read: result => result.economics.totalModelledCostUSD + result.exposure.vehicleHoursExposed * 12 },
});

/** What the corridor can actually supply. Beyond this, a strategy is not an option. */
export const DEFAULT_RESOURCES = Object.freeze({
  maxRangers: 3,
  maxTowTrucks: 2,
  /** The quickest a unit could credibly reach this section. */
  minRangerTravelMinutes: 5,
  minTowTravelMinutes: 10,
  /** Detection cannot beat the time it takes a camera operator or a caller to see it. */
  minDetectionMinutes: 2,
  maxResponseBudgetUSD: null,
});

/**
 * Is this strategy available at all?
 *
 * @returns {{feasible: boolean, reasons: string[]}}
 */
export function checkFeasibility(settings, result, resources = DEFAULT_RESOURCES) {
  const reasons = [];
  if (settings.rangers > resources.maxRangers) {
    reasons.push(`Needs ${settings.rangers} patrol units; ${resources.maxRangers} are available.`);
  }
  if (settings.towTrucks > resources.maxTowTrucks) {
    reasons.push(`Needs ${settings.towTrucks} tow units; ${resources.maxTowTrucks} are available.`);
  }
  if (settings.rangerTravelMinutes < resources.minRangerTravelMinutes) {
    reasons.push(`Assumes a patrol ${settings.rangerTravelMinutes} min away; the quickest credible `
      + `arrival on this section is ${resources.minRangerTravelMinutes} min.`);
  }
  if (settings.towTravelMinutes < resources.minTowTravelMinutes) {
    reasons.push(`Assumes a tow ${settings.towTravelMinutes} min away; the quickest credible `
      + `arrival is ${resources.minTowTravelMinutes} min.`);
  }
  if (settings.detectionMinutes < resources.minDetectionMinutes) {
    reasons.push(`Assumes detection in ${settings.detectionMinutes} min, faster than this corridor `
      + 'can see an incident.');
  }
  if (resources.maxResponseBudgetUSD != null
    && result?.economics?.response.totalUSD > resources.maxResponseBudgetUSD) {
    reasons.push(`Response cost $${result.economics.response.totalUSD} exceeds the configured `
      + `budget of $${resources.maxResponseBudgetUSD}.`);
  }
  return Object.freeze({ feasible: reasons.length === 0, reasons: Object.freeze(reasons) });
}

/** Every combination of the grid. Deterministic order. */
export function* candidates(grid = SEARCH_GRID) {
  const keys = Object.keys(grid);
  const counters = new Array(keys.length).fill(0);
  for (;;) {
    yield Object.freeze(Object.fromEntries(keys.map((key, index) => [key, grid[key][counters[index]]])));
    let position = keys.length - 1;
    while (position >= 0) {
      counters[position] += 1;
      if (counters[position] < grid[keys[position]].length) break;
      counters[position] = 0;
      position -= 1;
    }
    if (position < 0) return;
  }
}

/**
 * Run the sweep.
 *
 * @param {(settings: object) => object} run the simulation, injected so the optimizer never builds
 *        a model of its own — the ranked numbers are the same ones the Lab shows.
 * @param {{objective?: string, grid?: object, resources?: object, limit?: number}} options
 */
export function optimise(run, { objective = 'BALANCED', grid = SEARCH_GRID,
  resources = DEFAULT_RESOURCES, limit = 12 } = {}) {
  const target = OBJECTIVES[objective] ?? OBJECTIVES.BALANCED;
  const evaluated = [];
  const rejected = [];
  for (const settings of candidates(grid)) {
    const result = run(settings);
    const feasibility = checkFeasibility(settings, result, resources);
    if (!feasibility.feasible) {
      rejected.push(Object.freeze({ settings, reasons: feasibility.reasons }));
      continue;
    }
    evaluated.push(Object.freeze({ settings, result, score: target.read(result) }));
  }
  const ranked = evaluated.sort((a, b) => a.score - b.score);

  /**
   * The strategies no other strategy beats on every axis at once.
   *
   * Worth showing beside the winner: the recommended strategy is the best for ONE objective, and an
   * operator weighing cost against clearance deserves to see the alternatives that are not simply
   * worse.
   */
  const axes = result => [
    result.timeline.roadwayClearanceMinutes,
    result.queue.vehicleHoursOfDelay,
    result.economics.totalModelledCostUSD,
    result.exposure.vehicleHoursExposed,
  ];
  const pareto = ranked.filter(entry => !ranked.some(other => {
    if (other === entry) return false;
    const mine = axes(entry.result);
    const theirs = axes(other.result);
    return theirs.every((value, index) => value <= mine[index])
      && theirs.some((value, index) => value < mine[index]);
  }));

  return Object.freeze({
    objective: target.id,
    objectiveLabel: target.label,
    evaluated: evaluated.length,
    rejected: rejected.length,
    rejectedExamples: Object.freeze(rejected.slice(0, 5)),
    best: ranked[0] ?? null,
    ranked: Object.freeze(ranked.slice(0, limit)),
    pareto: Object.freeze(pareto.slice(0, limit)),
    method: 'A deterministic sweep of a stated grid of response levers. Infeasible strategies are '
      + 'excluded before ranking, not scored down. The same inputs always give the same answer.',
  });
}
