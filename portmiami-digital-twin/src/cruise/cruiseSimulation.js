/**
 * One cruise-driven run for one parking scenario: cohorts, facilities, simulation.
 *
 * The whole of November is always simulated, whichever day is being looked at, so vehicles
 * parked on earlier days are still in the garage on the day selected. Baseline, A, B and C are
 * run against the SAME cohorts — only the facilities differ — so they face identical demand.
 */
import { NOV_END, NOV_START, localMidnightMs, nextDate } from './cruiseCalls.js';
import { buildCohorts, simulate } from './turnaroundModel.js';
import { scenarioFacilities } from './parkingAllocation.js';

export const simulationWindow = () => ({
  startMs: localMidnightMs(NOV_START),
  endMs: localMidnightMs(nextDate(NOV_END)),
});

export function runCruiseScenario({ calls, assumptions, byDate = {}, byCruise = {}, allocations, allocationPolicy = 'PROPORTIONAL', baseFacilities, scenario = null, scopeFor = {}, cohortSet = null }) {
  const { cohorts, skipped } = cohortSet ?? buildCohorts(calls, assumptions, { byDate, byCruise });
  const facilities = scenarioFacilities(baseFacilities, scenario, { scopeFor });
  const { startMs, endMs } = simulationWindow();
  return { ...simulate({ cohorts, facilities, allocations, allocationPolicy, assumptions, startMs, endMs }), skipped };
}
