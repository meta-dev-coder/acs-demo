/**
 * The one place a simulation is run.
 *
 * Everything that wants a number — the Simulation Lab, Ask the Twin, the Cesium overlay — comes
 * through here, so a figure quoted in the chat is the same figure on the screen. There is no second
 * implementation and no path by which a model could compute one of these numbers itself.
 *
 * Each run keeps its lineage: which baseline it came from, which run it was cloned from, exactly
 * which inputs were changed and which were inherited. That is what lets "and what if the tow were
 * another ten minutes earlier?" mean something — it clones the run being discussed and changes one
 * field, rather than starting again from defaults and quietly losing the rest of the conversation.
 */
import { buildIncidentBaseline, TRAFFIC_ASSUMPTIONS } from './incidentBaseline.js';
import { buildTimeline, DEFAULT_RESPONSE, stageSpans, validateResponse } from './responseTimeline.js';
import { runQueue, saturationCheck } from './trafficQueue.js';
import { compareExposure, exposureFor } from './secondaryExposureModel.js';
import { compareEconomics, economicImpact, ECONOMIC_ASSUMPTIONS } from './economicImpact.js';
import { optimise, DEFAULT_RESOURCES, OBJECTIVES } from './scenarioOptimizer.js';
import { presetById, SCENARIO_PRESETS } from './scenarioPresets.js';

/** Bumped whenever a calculation changes, so a stored result can never be compared across versions. */
export const MODEL_VERSION = '1.0.0';

/**
 * A counter, not a timestamp.
 *
 * Ids were `Date.now()` in base 36, and two runs started in the same millisecond — which is what
 * happens when a preset sweep runs — took the same id and overwrote each other in the session's map.
 * A monotonic counter cannot collide however fast the runs are made.
 */
let sequence = 0;

/** Only the fields that differ from the parent, so a clone's lineage reads as the change it was. */
const diffOf = (settings, parent) => Object.freeze(Object.fromEntries(
  Object.entries(settings).filter(([key, value]) => parent[key] !== value)));

/**
 * One simulation run.
 *
 * @param {object} baseline from buildIncidentBaseline()
 * @param {{response?: object, economics?: object, traffic?: object, hazmat?: boolean}} scenario
 */
export function runSimulation(baseline, {
  response = {}, economics = {}, traffic = {}, hazmat = false, label = 'Scenario',
  presetId = null, id = null, parentId = null,
} = {}) {
  const validation = validateResponse(response);
  const settings = { ...DEFAULT_RESPONSE, ...response };
  const trafficAssumptions = { ...TRAFFIC_ASSUMPTIONS, ...baseline.assumptions, ...traffic };
  const economicAssumptions = { ...ECONOMIC_ASSUMPTIONS, ...economics };

  const timeline = buildTimeline(baseline, settings, { hazmat });

  const demandVph = traffic.demandVph ?? baseline.traffic.demandVph.value;
  const lanes = trafficAssumptions.lanesPerDirection;
  const blockedLanes = traffic.blockedLanes ?? baseline.traffic.blockedLanes.value;

  const saturation = demandVph
    ? saturationCheck({ demandVph, lanes, capacityPerLaneVph: trafficAssumptions.capacityPerLaneVph })
    : null;

  const queue = runQueue({
    demandVph: demandVph ?? 0,
    lanes,
    blockedLanes,
    capacityPerLaneVph: trafficAssumptions.capacityPerLaneVph,
    penalty: trafficAssumptions.incidentCapacityPenalty,
    partialReopen: timeline.partialReopen,
    fullReopen: timeline.fullReopen,
    divertedShare: trafficAssumptions.divertedShare,
    lostShare: trafficAssumptions.lostShare,
  });

  const exposure = exposureFor({
    queue, timeline, baseline,
    hotspotRecords: baseline.context.hotspotRecords.value,
  });
  const economicsResult = economicImpact({ queue, timeline, assumptions: economicAssumptions });

  return Object.freeze({
    id: id ?? `SIM-${baseline.incidentId}-${(sequence += 1).toString(36).padStart(3, '0')}`,
    parentId,
    baselineId: baseline.incidentId,
    label,
    presetId,
    modelVersion: MODEL_VERSION,
    /** Inputs, in full, so a result can always be reproduced from what it carries. */
    inputs: Object.freeze({
      response: Object.freeze(settings),
      traffic: Object.freeze({ demandVph, lanes, blockedLanes, ...trafficAssumptions }),
      economics: Object.freeze(economicAssumptions),
      hazmat,
    }),
    validation,
    saturation,
    timeline,
    stageSpans: stageSpans(timeline),
    queue,
    exposure,
    economics: economicsResult,
    /** The handful of figures everything else quotes. */
    headline: Object.freeze({
      roadwayClearanceMinutes: Number(timeline.roadwayClearanceMinutes.toFixed(0)),
      incidentClearanceMinutes: Number(timeline.incidentClearanceMinutes.toFixed(0)),
      partialReopenMinutes: Number(timeline.partialReopen.toFixed(0)),
      queueDissipationMinutes: queue.queueDissipationMinutes,
      vehicleHoursOfDelay: queue.vehicleHoursOfDelay,
      maxQueueVehicles: queue.maxQueueVehicles,
      exposureVehicleHours: exposure.vehicleHoursExposed,
      exposureIndex: exposure.index,
      delayCostUSD: economicsResult.delay.totalUSD,
      responseCostUSD: economicsResult.response.totalUSD,
      deferredTollUSD: economicsResult.toll.deferredUSD,
      unrecoveredTollUSD: economicsResult.toll.unrecoveredUSD,
      totalModelledCostUSD: economicsResult.totalModelledCostUSD,
    }),
  });
}

/**
 * A session's runs, with their lineage.
 *
 * Deliberately in memory and per session: a stored result from an older model version would be
 * compared against a newer one without either of them saying so.
 */
export function createSimulationSession({ baseline } = {}) {
  const runs = new Map();
  let activeId = null;

  const remember = run => {
    runs.set(run.id, run);
    activeId = run.id;
    return run;
  };

  return {
    baseline,
    get active() { return activeId ? runs.get(activeId) ?? null : null; },
    get all() { return Object.freeze([...runs.values()]); },
    get(id) { return runs.get(id) ?? null; },

    /** Run a preset, or a bare set of changes, against the baseline. */
    run({ presetId = 'standard', response = {}, label = null, ...rest } = {}) {
      const preset = presetById(presetId);
      return remember(runSimulation(baseline, {
        ...rest,
        presetId: preset?.id ?? null,
        label: label ?? preset?.label ?? 'Custom scenario',
        response: { ...(preset?.changes ?? {}), ...response },
      }));
    },

    /**
     * Clone a run and change only what was asked for.
     *
     * This is what makes a conversation work: the parent's inputs are carried over in full, the
     * change is recorded as a diff, and the lineage says where the number came from.
     */
    clone(parentId, { response = {}, label = null, ...rest } = {}) {
      const parent = runs.get(parentId) ?? (activeId ? runs.get(activeId) : null);
      if (!parent) return null;
      const merged = { ...parent.inputs.response, ...response };
      const run = runSimulation(baseline, {
        ...rest,
        parentId: parent.id,
        presetId: parent.presetId,
        label: label ?? `${parent.label} + change`,
        response: merged,
        economics: { ...parent.inputs.economics, ...(rest.economics ?? {}) },
        traffic: { ...parent.inputs.traffic, ...(rest.traffic ?? {}) },
        hazmat: rest.hazmat ?? parent.inputs.hazmat,
      });
      return remember(Object.freeze({ ...run, changedFromParent: diffOf(merged, parent.inputs.response) }));
    },

    select(id) { if (runs.has(id)) activeId = id; return runs.get(id) ?? null; },

    /** Every preset, run once. The comparison table's rows. */
    runAllPresets(options = {}) {
      return SCENARIO_PRESETS.map(preset => this.run({ presetId: preset.id, ...options }));
    },

    /**
     * Search for the best feasible strategy.
     *
     * The optimizer is handed THIS session's run function, so what it ranks is what the screen
     * would show for the same settings.
     */
    optimise({ objective = 'BALANCED', resources = DEFAULT_RESOURCES, ...rest } = {}) {
      const found = optimise(
        settings => runSimulation(baseline, { response: settings, label: 'Candidate', ...rest }),
        { objective, resources, ...rest });
      if (found.best) {
        remember(Object.freeze({
          ...found.best.result,
          id: `SIM-${baseline.incidentId}-optimised-${objective}`,
          label: `Optimised — ${found.objectiveLabel.toLowerCase()}`,
          optimised: true,
        }));
      }
      return found;
    },

    /** Two runs, side by side, per bearer and per outcome. */
    compare(aId, bId) {
      const a = runs.get(aId);
      const b = runs.get(bId);
      if (!a || !b) return null;
      return Object.freeze({
        baseline: a,
        scenario: b,
        timeline: Object.freeze({
          roadwayClearanceChange: Number((b.timeline.roadwayClearanceMinutes
            - a.timeline.roadwayClearanceMinutes).toFixed(0)),
          partialReopenChange: Number((b.timeline.partialReopen - a.timeline.partialReopen).toFixed(0)),
          queueDissipationChange: b.queue.queueDissipationMinutes != null
            && a.queue.queueDissipationMinutes != null
            ? b.queue.queueDissipationMinutes - a.queue.queueDissipationMinutes : null,
        }),
        delay: Object.freeze({
          vehicleHoursChange: Number((b.queue.vehicleHoursOfDelay - a.queue.vehicleHoursOfDelay).toFixed(1)),
          percentChange: a.queue.vehicleHoursOfDelay > 0
            ? Number((((b.queue.vehicleHoursOfDelay - a.queue.vehicleHoursOfDelay)
              / a.queue.vehicleHoursOfDelay) * 100).toFixed(1)) : null,
        }),
        exposure: compareExposure(b.exposure, a.exposure),
        economics: compareEconomics(b.economics, a.economics),
        changedInputs: diffOf(b.inputs.response, a.inputs.response),
      });
    },
  };
}

/** Build a baseline and a session for one incident, in one call. */
export function openSimulation(fact, context = {}) {
  const baseline = buildIncidentBaseline(fact, context);
  if (!baseline) return null;
  return createSimulationSession({ baseline });
}

export { OBJECTIVES, SCENARIO_PRESETS, DEFAULT_RESOURCES };
