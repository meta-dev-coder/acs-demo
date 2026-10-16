import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIncidentBaseline, BASELINE_MODES, calibration, PROVENANCE, provenanceSummary,
  TRAFFIC_ASSUMPTIONS } from '../src/safetyIntelligence/simulation/incidentBaseline.js';
import { buildTimeline, crewSpeedup, DEFAULT_RESPONSE, SAFETY_CONSTRAINTS, stageSpans,
  validateResponse } from '../src/safetyIntelligence/simulation/responseTimeline.js';
import { blockedAt, capacityFor, runQueue, saturationCheck,
  BUCKET_MINUTES } from '../src/safetyIntelligence/simulation/trafficQueue.js';
import { compareExposure, exposureFor } from '../src/safetyIntelligence/simulation/secondaryExposureModel.js';
import { compareEconomics, economicImpact, ECONOMIC_ASSUMPTIONS, responseCost, tollRevenueImpact,
  travelDelayCost } from '../src/safetyIntelligence/simulation/economicImpact.js';
import { candidates, checkFeasibility, DEFAULT_RESOURCES, OBJECTIVES, optimise,
  SEARCH_GRID } from '../src/safetyIntelligence/simulation/scenarioOptimizer.js';
import { SCENARIO_PRESETS, presetById } from '../src/safetyIntelligence/simulation/scenarioPresets.js';
import { createSimulationSession, MODEL_VERSION, openSimulation,
  runSimulation } from '../src/safetyIntelligence/simulation/simulationService.js';
import { answerSimulationQuestion, parseModification,
  parseSimulationQuestion } from '../src/safetyIntelligence/simulationAnswers.js';
import { economicsTab, labHeader, labTabs, LAB_TABS, optimizationSection, overviewTab, patrolsTab,
  responseInputsPanel, responseTab, trafficInputsPanel, trafficTab } from '../src/safetyIntelligence/simulationPanels.js';
import { ARRIVAL_FLOOR_MINUTES, comparePatrols, MINIMUM_CANDIDATES,
  patrolOptionsFor } from '../src/safetyIntelligence/simulation/patrolOptions.js';
import { assumptionBlock, baselineBlock, calibrationBlock, comparisonTable, criticalPathBlock,
  economicsBlock, explainBlock, exposureBlock, queueChart, recommendationBlock, sensitivityBlock,
  timelineChart } from '../src/safetyIntelligence/simulationPanels.js';
import { assumptionSensitivity, criticalPath, MEASURES, quickWins, sensitivity,
  SENSITIVITY_LEVERS, settingChanges } from '../src/safetyIntelligence/simulation/criticalPath.js';

/** Escape a literal for use in a RegExp, so section names with punctuation still match. */
const escapeRe = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Markup wraps, so assertions run against whitespace-collapsed HTML. Otherwise a template that
 * happens to break a line mid-sentence fails a test about content.
 */
const flat = html => String(html).replace(/\s+/g, ' ');

/* ============================================================================================
   Fixtures
   ============================================================================================ */

const factWith = (overrides = {}) => ({
  id: 'INC-TEST',
  when: { ms: Date.UTC(2025, 2, 15, 8, 30), dayKey: '2025-03-15', hour: 8, monthKey: '2025-03', weekday: 6 },
  type: 'Multi-vehicle crash',
  severity: { level: 'INJURY', label: 'Injury', rank: 2 },
  laneClosure: true,
  laneClosureHours: 1.5,
  weather: 'Clear',
  trafficConditions: 'Heavy',
  rootCauseCategory: 'Driver behavior',
  confirmed: true,
  policeReport: 'FHP-1',
  segmentName: 'Segment_101W',
  longitude: -80.3,
  latitude: 26.1,
  ...overrides,
});

const sectionProfile = {
  section: { label: 'MP 0.0–4.2', aadt: 108_000, aadtYear: 2025, carriageway: 'BOTH' },
  records: 111,
};

const baselineFor = (overrides = {}) =>
  buildIncidentBaseline(factWith(overrides), { sectionProfile, hotspotRecords: 12 });

/* ============================================================================================
   1. Baseline and provenance
   ============================================================================================ */

test('a baseline is a reconstruction, and says so', () => {
  const baseline = baselineFor();
  assert.equal(baseline.mode, BASELINE_MODES.RECONSTRUCTED);
  assert.match(baseline.modeNote, /not a record of how the incident was actually handled/);
});

test('every input is classified, and what the register lacks is listed rather than invented', () => {
  const baseline = baselineFor();
  assert.equal(baseline.observed.type.provenance, PROVENANCE.OBSERVED);
  assert.equal(baseline.traffic.lanesPerDirection.provenance, PROVENANCE.ASSUMED);
  assert.equal(baseline.traffic.demandVph.provenance, PROVENANCE.DERIVED);
  assert.equal(baseline.observed.carriageway.provenance, PROVENANCE.UNAVAILABLE);
  // The nine things a response simulation needs and this register has none of.
  const missing = baseline.unavailable.map(entry => entry.field);
  for (const field of ['Detection time', 'Dispatch time', 'Responder arrival', 'Tow arrival',
    'Lane reopening time', 'Blocked lane count', 'Measured traffic volume']) {
    assert.ok(missing.includes(field), `${field} must be declared missing`);
  }
});

test('demand is derived from published AADT by a stated rule, and absent without it', () => {
  const baseline = baselineFor();
  const expected = Math.round(108_000 * TRAFFIC_ASSUMPTIONS.peakHourFactorK
    * TRAFFIC_ASSUMPTIONS.directionalSplitD);
  assert.equal(baseline.traffic.demandVph.value, expected);
  assert.match(baseline.traffic.demandVph.note, /Neither factor is measured/);

  const noAadt = buildIncidentBaseline(factWith(), { sectionProfile: null });
  assert.equal(noAadt.traffic.demandVph.value, null);
  assert.equal(noAadt.traffic.demandVph.provenance, PROVENANCE.UNAVAILABLE);
});

test('a record with no lane closure has zero blocked lanes as an OBSERVED fact', () => {
  const open = baselineFor({ laneClosure: false });
  assert.equal(open.traffic.blockedLanes.value, 0);
  assert.equal(open.traffic.blockedLanes.provenance, PROVENANCE.OBSERVED);
  // With a closure, the count is an assumption — the register never records how many.
  assert.equal(baselineFor().traffic.blockedLanes.provenance, PROVENANCE.ASSUMED);
});

test('the provenance summary counts every field it shows', () => {
  const summary = provenanceSummary(baselineFor());
  const counted = Object.values(summary.counts).reduce((sum, value) => sum + value, 0);
  assert.equal(counted, summary.total);
  assert.ok(summary.counts.UNAVAILABLE >= 9, 'the nine missing operational inputs are counted');
  assert.ok(summary.observedShare < 0.5, 'most of what a simulation needs is not observed');
});

/* ============================================================================================
   2. The response timeline
   ============================================================================================ */

test('stages never run backwards and clearance is reported two ways', () => {
  const timeline = buildTimeline(baselineFor(), {});
  let previous = -1;
  for (const stage of timeline.stages) {
    if (stage.parallel) continue;
    assert.ok(stage.at >= previous, `${stage.id} went backwards`);
    previous = stage.at;
  }
  assert.ok(timeline.incidentClearanceMinutes > timeline.roadwayClearanceMinutes,
    'the scene is vacated after the lanes open');
  assert.match(timeline.clearanceNote, /different numbers/);
  for (const span of stageSpans(timeline)) assert.ok(span.minutes >= 0, `${span.id} has a negative span`);
});

test('a fatal incident cannot be cleared before its investigation hold', () => {
  const fatal = buildTimeline(baselineFor({ severity: { level: 'FATAL', label: 'Fatal', rank: 3 } }), {});
  const minor = buildTimeline(baselineFor({
    severity: { level: 'PROPERTY_DAMAGE', label: 'No injury recorded', rank: 1 } }), {});
  assert.ok(fatal.removalStart >= fatal.sceneProtected + SAFETY_CONSTRAINTS.investigationHoldMinutes.FATAL);
  assert.ok(fatal.roadwayClearanceMinutes > minor.roadwayClearanceMinutes);
  assert.ok(fatal.constraintsApplied.some(note => /Investigation hold of 90/.test(note)));
});

test('extra crews have diminishing returns and can never clear instantly', () => {
  const one = buildTimeline(baselineFor(), { rangers: 1, towTrucks: 1 });
  const two = buildTimeline(baselineFor(), { rangers: 2, towTrucks: 2 });
  const many = buildTimeline(baselineFor(), { rangers: 6, towTrucks: 4 });
  assert.ok(two.roadwayClearanceMinutes < one.roadwayClearanceMinutes);
  // Twice the crews is not twice as fast.
  const firstGain = one.roadwayClearanceMinutes - two.roadwayClearanceMinutes;
  const secondGain = two.roadwayClearanceMinutes - many.roadwayClearanceMinutes;
  assert.ok(secondGain < firstGain, 'returns must diminish');
  assert.ok(many.roadwayClearanceMinutes > 30, 'no number of crews clears a scene instantly');
  assert.ok(crewSpeedup(4) < crewSpeedup(1));
});

test('a hazardous load adds specialist time that cannot be optimised away', () => {
  const plain = buildTimeline(baselineFor(), { rangers: 3, towTrucks: 2 });
  const hazmat = buildTimeline(baselineFor(), { rangers: 3, towTrucks: 2 }, { hazmat: true });
  assert.equal(Math.round(hazmat.roadwayClearanceMinutes - plain.roadwayClearanceMinutes),
    SAFETY_CONSTRAINTS.hazmatAdditionalMinutes);
});

test('a lane is never given back before the scene is protected and the hold has run', () => {
  const timeline = buildTimeline(baselineFor(), { partialReopenAfterProtectionMinutes: 0 });
  assert.ok(timeline.partialReopen >= timeline.sceneProtected + timeline.investigationHold);
  assert.ok(timeline.partialReopen <= timeline.fullReopen, 'partial never after full');
});

test('the timeline names what removal is actually waiting on', () => {
  const timeline = buildTimeline(baselineFor(), { towTravelMinutes: 10 });
  assert.ok(['assessment', 'tow', 'medical', 'investigation'].includes(timeline.bindingConstraint.id));
  assert.equal(timeline.bindingConstraint.atMinute, Number(timeline.removalStart.toFixed(1)));
  // With a quick tow and an injury incident, the hold is what holds it.
  assert.equal(timeline.bindingConstraint.id, 'investigation');
  assert.match(timeline.bindingConstraint.note, /Pulling anything else forward/);
});

test('out-of-range inputs are rejected rather than silently clamped into a result', () => {
  assert.equal(validateResponse({ rangers: 2 }).ok, true);
  const bad = validateResponse({ rangers: 99, detectionMinutes: -5 });
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 2);
});

/* ============================================================================================
   3. The traffic queue
   ============================================================================================ */

const queueInput = (overrides = {}) => ({
  demandVph: 5000, lanes: 4, blockedLanes: 2, capacityPerLaneVph: 1900, penalty: 0.14,
  partialReopen: 60, fullReopen: 100, divertedShare: 0.15, lostShare: 0.02, ...overrides,
});

test('vehicles are conserved: demand = crossed + queued + diverted + abandoned', () => {
  for (const blocked of [0, 1, 2, 3, 4]) {
    const queue = runQueue(queueInput({ blockedLanes: blocked }));
    assert.ok(queue.conserved, `conservation failed with ${blocked} lanes blocked`);
    const sum = queue.crossed + queue.deferred + queue.diverted + queue.lost;
    assert.ok(Math.abs(queue.demand - sum) < 1e-6);
  }
});

test('blocking a lane costs more than that lane’s share, and a full block carries nothing', () => {
  const clean = capacityFor({ lanes: 4, blockedLanes: 0, capacityPerLaneVph: 1900, penalty: 0.14 });
  const blocked = capacityFor({ lanes: 4, blockedLanes: 1, capacityPerLaneVph: 1900, penalty: 0.14 });
  assert.equal(clean, 7600);
  assert.ok(blocked < 3 * 1900, 'the penalty applies beyond the blocked lane itself');
  assert.equal(capacityFor({ lanes: 4, blockedLanes: 4, capacityPerLaneVph: 1900, penalty: 0.14 }), 0);
});

test('a partial reopening gives back exactly one lane, and only between the two reopenings', () => {
  const phases = { blockedLanes: 3, partialReopen: 60, fullReopen: 100 };
  assert.equal(blockedAt(0, phases), 3);
  assert.equal(blockedAt(59, phases), 3);
  assert.equal(blockedAt(60, phases), 2, 'one lane back, not all of them');
  assert.equal(blockedAt(99, phases), 2);
  assert.equal(blockedAt(100, phases), 0);
});

test('reopening sooner reduces delay, and queue dissipation is measured from full reopening', () => {
  const slow = runQueue(queueInput({ partialReopen: 80, fullReopen: 140 }));
  const fast = runQueue(queueInput({ partialReopen: 40, fullReopen: 70 }));
  assert.ok(fast.vehicleHoursOfDelay < slow.vehicleHoursOfDelay);
  assert.ok(fast.queueDissipationMinutes >= 0);
  // Dissipation is time AFTER the lanes opened, not total queue time.
  assert.ok(fast.queueDissipationMinutes < fast.queueMinutes);
});

test('nothing blocked means no queue and no delay', () => {
  const queue = runQueue(queueInput({ blockedLanes: 0, partialReopen: 0, fullReopen: 0 }));
  assert.equal(queue.vehicleHoursOfDelay, 0);
  assert.equal(queue.maxQueueVehicles, 0);
  assert.equal(queue.diverted, 0);
});

test('demand over capacity is flagged, because then the queue is the assumptions’ doing', () => {
  const fine = saturationCheck({ demandVph: 5000, lanes: 4, capacityPerLaneVph: 1900 });
  assert.equal(fine.oversaturated, false);
  assert.equal(fine.warning, null);
  const broken = saturationCheck({ demandVph: 9000, lanes: 4, capacityPerLaneVph: 1900 });
  assert.equal(broken.oversaturated, true);
  assert.match(broken.warning, /result of the ASSUMPTIONS, not of the incident/);
});

test('only new arrivals may divert, so a standing queue is not charged again every bucket', () => {
  const queue = runQueue(queueInput({ divertedShare: 0.15 }));
  // If the whole queue were charged each bucket, diversion would exceed the share of demand by far.
  assert.ok(queue.diverted <= queue.demand * 0.15 + 1e-6,
    `diverted ${queue.diverted} exceeds 15% of demand ${queue.demand}`);
});

test('a queue still standing at the horizon is deferred, never counted as lost', () => {
  const queue = runQueue(queueInput({ demandVph: 9000, fullReopen: 400, horizonMinutes: 60 }));
  assert.ok(queue.deferred > 0);
  assert.equal(queue.truncated, true);
  assert.ok(queue.lost < queue.deferred, 'abandoned trips are not the queue');
});

/* ============================================================================================
   4. Secondary exposure
   ============================================================================================ */

test('exposure is a quantity, and the index is never a probability', () => {
  const timeline = buildTimeline(baselineFor(), {});
  const queue = runQueue(queueInput({ partialReopen: timeline.partialReopen, fullReopen: timeline.fullReopen }));
  const exposure = exposureFor({ queue, timeline, baseline: baselineFor() });
  assert.equal(exposure.vehicleHoursExposed, queue.vehicleHoursOfDelay);
  assert.equal(exposure.isProbability, false);
  assert.match(exposure.indexNote, /NOT a probability/);
  assert.ok(exposure.index >= 0 && exposure.index <= 100);
  assert.equal(exposure.components.length, 6);
});

test('a warning that comes after the queue is penalised, and the lead is signed', () => {
  const baseline = baselineFor();
  const late = buildTimeline(baseline, { warningActivationMinutes: 40 });
  const early = buildTimeline(baseline, { warningActivationMinutes: 3 });
  const queue = runQueue(queueInput());
  const lateExposure = exposureFor({ queue, timeline: late, baseline });
  const earlyExposure = exposureFor({ queue, timeline: early, baseline });
  assert.ok(earlyExposure.warningLeadMinutes > lateExposure.warningLeadMinutes);
  assert.ok(earlyExposure.index <= lateExposure.index);
});

test('comparing exposure reports a change, never accidents prevented', () => {
  const baseline = baselineFor();
  const timeline = buildTimeline(baseline, {});
  const slow = exposureFor({ queue: runQueue(queueInput({ fullReopen: 140 })), timeline, baseline });
  const fast = exposureFor({ queue: runQueue(queueInput({ fullReopen: 70 })), timeline, baseline });
  const comparison = compareExposure(fast, slow);
  assert.equal(comparison.direction, 'LOWER');
  assert.ok(comparison.vehicleHoursChangePercent < 0);
  assert.match(comparison.claim, /not a number of secondary incidents prevented/);
  assert.doesNotMatch(JSON.stringify(comparison), /probability/i);
});

/* ============================================================================================
   5. Economics
   ============================================================================================ */

test('delay cost weights heavy vehicles separately', () => {
  const cost = travelDelayCost(100, ECONOMIC_ASSUMPTIONS);
  assert.equal(cost.passengerVehicleHours + cost.heavyVehicleHours, 100);
  assert.equal(cost.totalUSD, cost.passengerCostUSD + cost.heavyCostUSD);
  assert.equal(cost.bearer, 'ROAD_USERS');
  assert.equal(travelDelayCost(0).totalUSD, 0);
});

test('response cost rises with crews and with time on scene', () => {
  const base = buildTimeline(baselineFor(), { rangers: 1, towTrucks: 1 });
  const more = buildTimeline(baselineFor(), { rangers: 3, towTrucks: 2 });
  assert.ok(responseCost(more).totalUSD > responseCost(base).totalUSD,
    'more units cost more even when they clear sooner');
  assert.equal(responseCost(base).bearer, 'OPERATING_AGENCY');
});

test('deferred toll revenue is never counted as lost', () => {
  const queue = runQueue(queueInput());
  const toll = tollRevenueImpact(queue, ECONOMIC_ASSUMPTIONS);
  assert.ok(toll.deferredUSD >= 0);
  assert.ok(toll.unrecoveredUSD >= 0);
  assert.match(toll.separation, /never summed/);
  // The total excludes deferred revenue by design.
  const impact = economicImpact({ queue, timeline: buildTimeline(baselineFor(), {}) });
  assert.equal(impact.totalModelledCostUSD,
    impact.delay.totalUSD + impact.response.totalUSD + impact.toll.unrecoveredUSD);
  assert.doesNotMatch(String(impact.totalNote), /deferred revenue is included/i);
});

test('toll revenue is conserved across its four accounts', () => {
  const queue = runQueue(queueInput());
  const toll = tollRevenueImpact(queue, { ...ECONOMIC_ASSUMPTIONS, divertedTollLossShare: 0.6 });
  const total = toll.collectedUSD + toll.deferredUSD + toll.unrecoveredUSD + toll.unresolvedUSD;
  const eligible = queue.demand * ECONOMIC_ASSUMPTIONS.tollEligibleShare * ECONOMIC_ASSUMPTIONS.averageTollUSD;
  assert.ok(Math.abs(total - eligible) < 5, `${total} vs ${eligible}: revenue must not be invented or lost`);
});

test('the comparison splits the benefit by who bears it', () => {
  const timeline = buildTimeline(baselineFor(), {});
  const slow = economicImpact({ queue: runQueue(queueInput({ fullReopen: 140 })), timeline });
  const fast = economicImpact({
    queue: runQueue(queueInput({ fullReopen: 70 })),
    timeline: buildTimeline(baselineFor(), { rangers: 3 }),
  });
  const comparison = compareEconomics(fast, slow);
  assert.ok(comparison.avoidedDelayCostUSD > 0);
  assert.ok(comparison.byBearer.OPERATING_AGENCY <= 0, 'more crews cost the agency more');
  assert.equal(comparison.netBenefitUSD,
    comparison.avoidedDelayCostUSD + comparison.recoveredTollRevenueUSD
    - comparison.incrementalResponseCostUSD);
  assert.match(comparison.note, /not a forecast saving/);
});

/* ============================================================================================
   6. The optimizer
   ============================================================================================ */

test('the grid is deterministic and complete', () => {
  const first = [...candidates(SEARCH_GRID)];
  const second = [...candidates(SEARCH_GRID)];
  const expected = Object.values(SEARCH_GRID).reduce((total, values) => total * values.length, 1);
  assert.equal(first.length, expected);
  assert.deepEqual(first[0], second[0]);
  assert.deepEqual(first.at(-1), second.at(-1));
});

test('infeasible strategies are excluded before ranking, with a reason', () => {
  const beyond = { rangers: 9, towTrucks: 9, rangerTravelMinutes: 1, towTravelMinutes: 1,
    detectionMinutes: 1 };
  const check = checkFeasibility(beyond, null, DEFAULT_RESOURCES);
  assert.equal(check.feasible, false);
  assert.equal(check.reasons.length, 5);
  assert.ok(check.reasons.every(reason => reason.length > 20), 'each reason must say what is wrong');
  assert.equal(checkFeasibility({ ...DEFAULT_RESPONSE, rangers: 2, towTrucks: 1,
    rangerTravelMinutes: 8, towTravelMinutes: 16, detectionMinutes: 4 }, null).feasible, true);
});

test('a budget constraint excludes strategies that exceed it', () => {
  const settings = { ...DEFAULT_RESPONSE, rangers: 2, towTrucks: 1, rangerTravelMinutes: 8,
    towTravelMinutes: 16, detectionMinutes: 4 };
  const result = { economics: { response: { totalUSD: 5000 } } };
  const check = checkFeasibility(settings, result, { ...DEFAULT_RESOURCES, maxResponseBudgetUSD: 1000 });
  assert.equal(check.feasible, false);
  assert.match(check.reasons[0], /exceeds the configured budget/);
});

test('each objective picks the strategy that is best at ITS measure', () => {
  const baseline = baselineFor();
  const run = settings => runSimulation(baseline, { response: settings });
  const grid = { rangers: [1, 2], towTravelMinutes: [10, 22],
    partialReopenAfterProtectionMinutes: [5, 15], detectionMinutes: [2, 6] };
  const byClearance = optimise(run, { objective: 'CLEARANCE', grid });
  const byCost = optimise(run, { objective: 'ECONOMIC', grid });
  assert.ok(byClearance.best && byCost.best);
  const clearances = byClearance.ranked.map(entry => entry.result.timeline.roadwayClearanceMinutes);
  assert.deepEqual(clearances, [...clearances].sort((a, b) => a - b), 'ranked by its own objective');
  const costs = byCost.ranked.map(entry => entry.result.economics.totalModelledCostUSD);
  assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
  // The fastest is not automatically the cheapest — that is the whole point of having objectives.
  assert.ok(byClearance.best.result.timeline.roadwayClearanceMinutes
    <= byCost.best.result.timeline.roadwayClearanceMinutes);
});

test('the optimizer repeats exactly, and reports what it rejected', () => {
  const baseline = baselineFor();
  const run = settings => runSimulation(baseline, { response: settings });
  const grid = { rangers: [1, 4], rangerTravelMinutes: [3, 8] };
  const first = optimise(run, { grid });
  const second = optimise(run, { grid });
  assert.deepEqual(first.best.settings, second.best.settings);
  assert.equal(first.best.score, second.best.score);
  assert.ok(first.rejected > 0, 'the grid must reach beyond what is available');
  assert.ok(first.rejectedExamples[0].reasons.length);
});

test('the Pareto set contains nothing that another strategy beats on every measure', () => {
  const baseline = baselineFor();
  const found = optimise(settings => runSimulation(baseline, { response: settings }), {
    grid: { rangers: [1, 2], towTravelMinutes: [10, 22], detectionMinutes: [2, 6] },
  });
  const axes = result => [result.timeline.roadwayClearanceMinutes, result.queue.vehicleHoursOfDelay,
    result.economics.totalModelledCostUSD, result.exposure.vehicleHoursExposed];
  for (const entry of found.pareto) {
    const dominated = found.ranked.some(other => {
      if (other === entry) return false;
      const mine = axes(entry.result);
      const theirs = axes(other.result);
      return theirs.every((value, index) => value <= mine[index])
        && theirs.some((value, index) => value < mine[index]);
    });
    assert.equal(dominated, false, 'a dominated strategy reached the Pareto set');
  }
});

/* ============================================================================================
   7. The service, and lineage
   ============================================================================================ */

test('a run carries its inputs, its model version and its lineage', () => {
  const session = openSimulation(factWith(), { sectionProfile });
  const run = session.run({ presetId: 'standard' });
  assert.equal(run.modelVersion, MODEL_VERSION);
  assert.equal(run.baselineId, 'INC-TEST');
  assert.equal(run.parentId, null);
  assert.ok(run.inputs.response.detectionMinutes);
  assert.ok(run.headline.roadwayClearanceMinutes > 0);
});

test('identical inputs give identical results', () => {
  const baseline = baselineFor();
  const a = runSimulation(baseline, { response: { rangers: 2 }, id: 'fixed' });
  const b = runSimulation(baseline, { response: { rangers: 2 }, id: 'fixed' });
  assert.deepEqual(a.headline, b.headline);
  assert.deepEqual(a.queue.buckets.length, b.queue.buckets.length);
});

test('a clone changes one field and inherits everything else', () => {
  const session = openSimulation(factWith(), { sectionProfile });
  const parent = session.run({ presetId: 'prepositionedRanger' });
  const child = session.clone(parent.id, { response: { towTravelMinutes: 8 } });
  assert.equal(child.parentId, parent.id);
  assert.equal(child.inputs.response.towTravelMinutes, 8);
  // Everything the parent had set is still set.
  assert.equal(child.inputs.response.rangerTravelMinutes, parent.inputs.response.rangerTravelMinutes);
  assert.equal(child.inputs.response.rangers, parent.inputs.response.rangers);
  assert.deepEqual(child.changedFromParent, { towTravelMinutes: 8 });
});

test('the session keeps every run and can compare any two', () => {
  const session = openSimulation(factWith(), { sectionProfile });
  const standard = session.run({ presetId: 'standard' });
  const coordinated = session.run({ presetId: 'coordinated' });
  assert.equal(session.all.length, 2);
  const comparison = session.compare(standard.id, coordinated.id);
  assert.ok(comparison.timeline.roadwayClearanceChange < 0, 'the coordinated response is faster');
  assert.ok(comparison.delay.vehicleHoursChange < 0);
  assert.ok(Object.keys(comparison.changedInputs).length > 3);
});

test('every preset is a set of changes, never a set of results', () => {
  for (const preset of SCENARIO_PRESETS) {
    assert.ok(preset.summary && preset.requires, `${preset.id} does not say what it would take`);
    assert.equal(typeof preset.changes, 'object');
    assert.ok(!('results' in preset));
  }
  assert.deepEqual(presetById('standard').changes, {});
  assert.equal(presetById('nope'), null);
});

test('running all the presets gives a comparable row per scenario', () => {
  const session = openSimulation(factWith(), { sectionProfile });
  const runs = session.runAllPresets();
  assert.equal(runs.length, SCENARIO_PRESETS.length);
  const standard = runs.find(run => run.presetId === 'standard');
  const coordinated = runs.find(run => run.presetId === 'coordinated');
  assert.ok(coordinated.headline.vehicleHoursOfDelay < standard.headline.vehicleHoursOfDelay);
  assert.ok(coordinated.headline.responseCostUSD > standard.headline.responseCostUSD,
    'the better outcome costs the agency more — which is the trade-off to show');
});

test('an incident with no AADT simulates nothing rather than inventing demand', () => {
  const session = openSimulation(factWith(), { sectionProfile: null });
  const run = session.run({ presetId: 'standard' });
  assert.equal(run.queue.demand, 0);
  assert.equal(run.headline.vehicleHoursOfDelay, 0);
  assert.equal(run.saturation, null);
  // The timeline is still real: the response does not depend on the traffic.
  assert.ok(run.headline.roadwayClearanceMinutes > 0);
});

/* ============================================================================================
   8. Ask the Twin
   ============================================================================================ */

test('a follow-up is read as a modification of the run being discussed', () => {
  assert.equal(parseSimulationQuestion('What if the tow truck arrived 10 minutes earlier?'), 'modify');
  assert.equal(parseSimulationQuestion('Which strategy gives the best balance?'), 'optimise');
  assert.equal(parseSimulationQuestion('How much congestion could we avoid?'), 'congestion');
  assert.equal(parseSimulationQuestion('Fly to bridge 860384'), null);
});

test('a modification names one lever and a number, or asks rather than guessing', () => {
  const current = { towTravelMinutes: 22, rangerTravelMinutes: 12 };
  const change = parseModification('What if the tow truck arrived 10 minutes earlier?', current);
  assert.equal(change.lever, 'towTravelMinutes');
  assert.equal(change.value, 12);
  assert.equal(parseModification('What if it were better?', current), null, 'no lever, no guess');
  assert.equal(parseModification('What if the tow were earlier?', current), null, 'no number, no guess');
});

test('the assistant answers from the engine and preserves lineage across a conversation', () => {
  const session = openSimulation(factWith(), { sectionProfile });
  session.run({ presetId: 'standard' });

  const first = answerSimulationQuestion('modify', session,
    'What if the Road Ranger arrived 6 minutes earlier?');
  assert.ok(first.runId);
  const firstRun = session.get(first.runId);
  assert.equal(firstRun.inputs.response.rangerTravelMinutes, DEFAULT_RESPONSE.rangerTravelMinutes - 6);

  // The follow-up clones THAT run, not the baseline: the earlier change must survive.
  const second = answerSimulationQuestion('modify', session,
    'And what if the tow truck arrived another 10 minutes earlier?');
  const secondRun = session.get(second.runId);
  assert.equal(secondRun.parentId, firstRun.id);
  assert.equal(secondRun.inputs.response.rangerTravelMinutes, firstRun.inputs.response.rangerTravelMinutes,
    'the earlier change was lost');
  assert.equal(secondRun.inputs.response.towTravelMinutes, DEFAULT_RESPONSE.towTravelMinutes - 10);
});

test('a change that moves nothing says why, rather than reporting a bare zero', () => {
  const session = openSimulation(factWith(), { sectionProfile });
  session.run({ presetId: 'standard' });
  const answer = answerSimulationQuestion('modify', session,
    'What if the tow truck arrived 2 minutes earlier?');
  assert.match(answer.answer, /No change to clearance/);
  assert.match(answer.answer, /investigation hold|tow arrival|medical hold|scene assessment/);
});

test('with no session open the assistant refuses rather than inventing a simulation', () => {
  const answer = answerSimulationQuestion('congestion', null, 'how much delay?');
  assert.match(answer.answer, /No incident is open/);
  assert.equal(answerSimulationQuestion(null, null, ''), null);
});

test('every quoted figure exists in the run it came from', () => {
  const session = openSimulation(factWith(), { sectionProfile });
  session.run({ presetId: 'standard' });
  const answer = answerSimulationQuestion('economics', session, 'what did it cost?');
  const run = session.get(answer.runId);
  for (const value of [run.economics.delay.totalUSD, run.economics.response.totalUSD,
    run.economics.totalModelledCostUSD]) {
    assert.ok(answer.answer.includes(`$${Math.round(value).toLocaleString('en-US')}`),
      `${value} is quoted but not in the run`);
  }
});

/* ============================================================================================
   9. The panels
   ============================================================================================ */

test('the Lab renders the baseline, the caveats and the conservation check', () => {
  const session = openSimulation(factWith(), { sectionProfile });
  const run = session.run({ presetId: 'standard' });
  const baselineHtml = baselineBlock(session.baseline, provenanceSummary(session.baseline));
  assert.match(baselineHtml, /not a record of how the incident was actually handled/);
  assert.match(baselineHtml, /Data quality/);
  assert.match(baselineHtml, /Not in the register at all/);

  assert.match(queueChart(run), /Conservation check/);
  assert.match(queueChart(run), /holds/);
  assert.match(timelineChart(run), /Roadway clearance is when the lanes are open/);
  assert.match(economicsBlock(run), /Paid later by the same vehicle. Not a loss/);
  assert.match(exposureBlock(run), /NOT a probability/);
  assert.match(comparisonTable(session.all, {}), /Scenario comparison/);
});

test('the recommendation says what it would take and claims no accident reduction', () => {
  const session = openSimulation(factWith(), { sectionProfile });
  session.run({ presetId: 'standard' });
  const found = session.optimise({
    objective: 'BALANCED',
    grid: { rangers: [1, 2], towTravelMinutes: [10, 22], detectionMinutes: [2, 6] },
  });
  const html = recommendationBlock(found, null);
  assert.match(html, /What it would take/);
  assert.match(html, /patrol unit/);
  assert.match(html, /excluded as unavailable|feasible strategies evaluated/);
  assert.match(html, /No\s+reduction in accidents is predicted/);
  assert.equal(recommendationBlock(null, null), '');
});

test('no panel presents a modelled figure as something that was observed', () => {
  const session = openSimulation(factWith(), { sectionProfile });
  const run = session.run({ presetId: 'coordinated' });
  const html = [timelineChart(run), queueChart(run), economicsBlock(run), exposureBlock(run)].join('');
  assert.doesNotMatch(html, /\bactual(ly)? (cleared|arrived|reopened)\b/i);
  assert.doesNotMatch(html, /\bwas recorded as\b/i);
});

test('run ids never collide, however fast the runs are made', () => {
  // Ids were a millisecond timestamp, and a preset sweep made several inside one millisecond: they
  // took the same id and overwrote each other in the session's map.
  const session = openSimulation(factWith(), { sectionProfile });
  const runs = session.runAllPresets();
  assert.equal(new Set(runs.map(run => run.id)).size, runs.length);
  assert.equal(session.all.length, runs.length);
});

/* ============================================================================================
   10. Critical path, sensitivity and calibration
   ============================================================================================ */

const runFor = (baseline, response = {}) => runSimulation(baseline, { response });

test('the critical path names the gate that is binding and the slack on the rest', () => {
  const baseline = baselineFor();
  const path = criticalPath(runFor(baseline));
  assert.ok(path.gates.length === 4);
  const binding = path.gates.filter(gate => gate.binding);
  assert.equal(binding.length, 1, 'exactly one gate is binding');
  assert.equal(binding[0].slackMinutes, 0);
  // Every other gate was ready earlier, so each has positive slack.
  for (const gate of path.gates.filter(gate => !gate.binding)) {
    assert.ok(gate.slackMinutes > 0, `${gate.id} should have slack`);
  }
  assert.match(path.explanation, /Lane reopening is \d+ minutes because/);
  assert.equal(path.earliestReopening, Math.round(runFor(baseline).timeline.roadwayClearanceMinutes));
});

test('an injury incident is held by its investigation, a property-damage one is not', () => {
  const injury = criticalPath(runFor(baselineFor()));
  assert.equal(injury.binding.id, 'investigation');
  const minor = criticalPath(runFor(baselineFor({
    severity: { level: 'PROPERTY_DAMAGE', label: 'No injury recorded', rank: 1 } })));
  assert.notEqual(minor.binding.id, 'investigation', 'no hold applies without injury');
});

test('sensitivity finds the levers that move reopening and the ones that only cost money', () => {
  const baseline = baselineFor();
  const base = runFor(baseline);
  const sweep = sensitivity(response => runFor(baseline, response), base);
  assert.equal(sweep.rows.length, SENSITIVITY_LEVERS.length);

  // Vehicle removal is on the critical path for every incident: it must move the answer.
  const removal = sweep.rows.find(row => row.key === 'vehicleRemovalMinutes');
  assert.equal(removal.verdict, 'MOVES_REOPENING');
  assert.ok(removal.reopeningRangeMinutes > 0);

  // With an investigation hold binding, the tow is not on the path — it costs and does not help.
  const tow = sweep.rows.find(row => row.key === 'towTravelMinutes');
  assert.equal(tow.movesReopening, false);
  assert.equal(tow.verdict, 'COSTS_WITHOUT_REOPENING');
  assert.ok(tow.costRangeUSD > 0, 'moving it still changes what the response costs');

  // Sorted so what matters is first.
  const ranges = sweep.rows.map(row => row.reopeningRangeMinutes);
  assert.deepEqual(ranges, [...ranges].sort((a, b) => b - a));
  assert.ok(sweep.movers.length && sweep.inert.length);
});

test('a lever that is NOT on the critical path cannot improve reopening — the model’s own claim', () => {
  const baseline = baselineFor();
  const base = runFor(baseline);
  const path = criticalPath(base);
  const sweep = sensitivity(response => runFor(baseline, response), base);
  // Whatever the binding gate is, the gates with slack must map to inert levers.
  if (path.binding.id === 'investigation') {
    for (const key of ['towTravelMinutes', 'towDispatchOffsetMinutes']) {
      const row = sweep.rows.find(entry => entry.key === key);
      assert.equal(row.movesReopening, false,
        `${key} moved reopening while the investigation hold was binding`);
    }
  }
});

test('sensitivity is deterministic and runs from the engine, not from a table', () => {
  const baseline = baselineFor();
  const base = runFor(baseline);
  const first = sensitivity(response => runFor(baseline, response), base);
  const second = sensitivity(response => runFor(baseline, response), base);
  assert.deepEqual(first.rows.map(row => [row.key, row.reopeningRangeMinutes, row.costRangeUSD]),
    second.rows.map(row => [row.key, row.reopeningRangeMinutes, row.costRangeUSD]));
  // Every point carries the measures it was read from, so nothing is hard-coded.
  for (const row of first.rows) {
    for (const point of row.points) {
      assert.ok(Number.isFinite(point.measures.reopening));
      assert.ok(Number.isFinite(point.measures.cost));
    }
  }
});

test('assumption sensitivity reports which unmeasured input moves the answer most', () => {
  const baseline = baselineFor();
  const found = assumptionSensitivity(overrides => runSimulation(baseline, {
    response: {}, traffic: overrides.traffic ?? {}, economics: overrides.economics ?? {},
  }));
  assert.equal(found.groups.length, 3);
  // Sorted by influence, so the most important uncertainty is first.
  const spreads = found.groups.map(group => group.costSpreadUSD);
  assert.deepEqual(spreads, [...spreads].sort((a, b) => b - a));
  assert.ok(found.mostInfluential);
  assert.match(found.caveat, /not a confidence interval/);
});

test('calibration reports the gap and refuses to call it an error', () => {
  const baseline = baselineFor({ laneClosureHours: 2 });
  const run = runFor(baseline);
  const found = calibration(baseline, run);
  assert.equal(found.recordedMinutes, 120);
  assert.equal(found.reconstructedMinutes, Math.round(run.timeline.roadwayClearanceMinutes));
  assert.equal(found.differenceMinutes, found.reconstructedMinutes - 120);
  assert.equal(found.comparable, false, 'the two are not the same measurement');
  assert.ok(found.whyNotComparable.length >= 4);
  assert.ok(found.wouldNeed.length >= 3);
  assert.match(found.note, /Nothing here is adjusted to make the model match/);
  // The partial-reopening value is offered because it may be the comparable one.
  assert.equal(found.reconstructedToPartialMinutes, Math.round(run.timeline.partialReopen));
});

test('a record with no closure duration has nothing to calibrate against', () => {
  const baseline = baselineFor({ laneClosure: false, laneClosureHours: null });
  const found = calibration(baseline, runFor(baseline));
  assert.equal(found.recordedMinutes, null);
  assert.match(found.reason, /nothing to compare/);
});

/* ============================================================================================
   11. Reconciliation — every total equals the sum of what is shown
   ============================================================================================ */

test('each economic total reconciles with its own displayed components', () => {
  const baseline = baselineFor();
  for (const preset of ['standard', 'coordinated', 'prepositionedRanger', 'earlyDetection']) {
    const run = runSimulation(baseline, { response: presetById(preset).changes });
    const economics = run.economics;
    // The response total was rounded from the raw sum while its parts were each rounded, so a
    // $727 total sat beside three figures adding to $728.
    assert.equal(economics.response.totalUSD,
      economics.response.rangerUSD + economics.response.towUSD + economics.response.tmcUSD,
      `${preset}: response total does not equal its parts`);
    assert.equal(economics.delay.totalUSD,
      economics.delay.passengerCostUSD + economics.delay.heavyCostUSD,
      `${preset}: delay total does not equal its parts`);
    assert.equal(economics.totalModelledCostUSD,
      economics.delay.totalUSD + economics.response.totalUSD + economics.toll.unrecoveredUSD,
      `${preset}: grand total does not equal its parts`);
  }
});

test('vehicle-hours are reproducible from the buckets the chart draws', () => {
  const baseline = baselineFor();
  const run = runFor(baseline);
  const fromBuckets = run.queue.buckets
    .reduce((sum, bucket) => sum + bucket.queued * run.queue.bucketMinutes, 0) / 60;
  assert.ok(Math.abs(fromBuckets - run.queue.vehicleHoursOfDelay) < 0.05,
    `chart says ${fromBuckets.toFixed(1)}, headline says ${run.queue.vehicleHoursOfDelay}`);
});

test('the panels state the critical path, the inert levers and the calibration gap', () => {
  const baseline = baselineFor();
  const run = runFor(baseline);
  const path = criticalPath(run);
  const sweep = sensitivity(response => runFor(baseline, response), run);
  assert.match(criticalPathBlock(path), /what is controlling\s+reopening/i);
  assert.match(criticalPathBlock(path), /binding/);
  // Collapsible now: the heading moved into the disclosure summary with the finding in it.
  assert.match(flat(sensitivityBlock(sweep)), /<summary>Sensitivity — /);
  // The markup wraps, so the assertion tolerates the line break rather than the product changing.
  assert.match(sensitivityBlock(sweep), /without moving\s+the reopening time/);
  assert.match(explainBlock(run, path), /Why is queue recovery later than reopening/);
  assert.match(calibrationBlock(calibration(baseline, run)), /not the same measurement/i);
  assert.equal(criticalPathBlock(null), '');
  assert.equal(sensitivityBlock(null), '');
});

/* ============================================================================================
   12. The Lab's five sub-tabs
   --------------------------------------------------------------------------------------------
   These are regression tests for the restructuring: the Lab was one long column, and splitting it
   into tabs must not lose a section, must not change a number, and must not make a tab change
   expensive.
   ============================================================================================ */

const labFixture = () => {
  const baseline = baselineFor({ laneClosureHours: 2 });
  const session = createSimulationSession({ baseline });
  const standard = session.run({ presetId: 'standard' });
  const run = session.run({ presetId: 'coordinated' });
  const path = criticalPath(run);
  const sweep = sensitivity(response => runSimulation(baseline, { response }), run);
  const assumptions = assumptionSensitivity(overrides => runSimulation(baseline, {
    response: run.inputs.response, traffic: overrides.traffic ?? {},
    economics: overrides.economics ?? {},
  }));
  return { baseline, session, standard, run, path, sweep, assumptions,
    comparison: session.compare(standard.id, run.id) };
};

test('the Lab offers its views in order', () => {
  // Optimization was a tab of its own; its search, comparison and recommendation are now a section
  // of Response Analysis, beside the timeline they change. Patrols was added after it.
  assert.deepEqual(LAB_TABS.map(tab => tab.label),
    ['Overview', 'Traffic Impact', 'Response Analysis', 'Patrols', 'Economics']);
});

test('the Lab has no header of its own — Overview owns the incident’s facts', () => {
  // It used to carry the same seven fields as Overview, on every tab.
  assert.equal(labHeader(), '');
});

test('Overview states every fact about the incident, compactly and in one place', () => {
  const { baseline } = labFixture();
  const html = flat(baselineBlock(baseline, provenanceSummary(baseline), null));
  assert.match(html, new RegExp(escapeRe(baseline.fact.type)));
  for (const label of ['Severity', 'When', 'Where', 'Carriageway', 'Lane closure',
    'Weather on the record', 'Traffic on the record', 'Police report', 'Demand modelled']) {
    assert.match(html, new RegExp(escapeRe(label)), `${label} is missing from Overview`);
  }
  assert.match(html, new RegExp(escapeRe(baseline.observed.weather.value)));
});

test('a record with no weather says so rather than leaving the field out', () => {
  const baseline = baselineFor({ weather: null, trafficConditions: null });
  const html = flat(baselineBlock(baseline, null, null));
  assert.match(html, /Weather on the record<\/em>Not recorded/);
  assert.match(html, /Traffic on the record<\/em>Not recorded/);
  assert.match(html, /Police report<\/em>/);
});

test('the scenario select and Run live on Response Analysis, with the inputs they act on', () => {
  const { run, path, sweep } = labFixture();
  const html = flat(responseTab({ run, path, sweep, responseInputs: '', presetId: 'coordinated',
    runs: [], activeId: null }));
  assert.match(html, /data-sim="preset"/);
  assert.match(html, /data-sim="run"/);
  assert.match(html, /value="coordinated" selected/, 'the chosen scenario survives a tab change');
  // And nowhere else.
  for (const other of [trafficTab({ run, trafficInputs: '' }),
    economicsTab({ run, assumptions: null })]) {
    assert.doesNotMatch(flat(other), /data-sim="run"/);
  }
});

test('the tab strip marks the open view and is keyboard-navigable', () => {
  const html = labTabs('response');
  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/role="tab"/g) ?? []).length, LAB_TABS.length);
  assert.match(html, /data-lab-tab="response"[^>]*aria-selected="true"[^>]*tabindex="0"/s);
  // Roving tabindex: only the selected tab is in the tab order.
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, LAB_TABS.length - 1);
  assert.match(html, /aria-controls="lab-panel"/);
});

test('every section of the old single column lands in exactly one tab', () => {
  const fixture = labFixture();
  const panels = {
    overview: overviewTab({ baseline: fixture.baseline, provenance: provenanceSummary(fixture.baseline),
      calibration: calibration(fixture.baseline, fixture.run), run: fixture.run, path: fixture.path,
      sweep: fixture.sweep, comparison: fixture.comparison, optimisation: null }),
    traffic: trafficTab({ run: fixture.run, trafficInputs: trafficInputsPanel(fixture.run, {}) }),
    response: responseTab({ run: fixture.run, path: fixture.path, sweep: fixture.sweep,
      responseInputs: responseInputsPanel(fixture.run, {}),
      runs: fixture.session.all, activeId: fixture.run.id }),
    economics: economicsTab({ run: fixture.run, assumptions: fixture.assumptions }),
  };

  /**
   * Each section that existed before, and the one tab it must now appear in.
   *
   * Matched on the HEADING, not on the phrase anywhere in the markup: "secondary-incident exposure"
   * is also the name of an optimiser objective in a dropdown, which is a different thing entirely.
   */
  const SECTIONS = [
    ['Data quality', 'overview'],
    ['Recorded closure', 'overview'],
    ['Demand and capacity', 'traffic'],
    // The queue and the exposure are RESULTS of the response, so they sit with it. Measured: they
    // change with every scenario while the demand/capacity table does not change at all.
    ['Queue over time', 'response'],
    ['Secondary-incident exposure', 'response'],
    ['Response timeline', 'response'],
    ['Critical path', 'response'],
    ['Sensitivity', 'response'],
    ['Explain these numbers', 'response'],
    ['Economic impact', 'economics'],
    ['How much rests on the assumptions', 'economics'],
    ['Scenario comparison', 'response'],
    ['Finding a better response', 'response'],
  ];
  for (const [section, tab] of SECTIONS) {
    // A heading or a disclosure summary opens the section; both start right after a '>'.
    const pattern = new RegExp(`>\\s*${escapeRe(section)}`, 'i');
    assert.match(flat(panels[tab]), pattern, `"${section}" is missing from ${tab}`);
    const elsewhere = Object.entries(panels)
      .filter(([id, html]) => id !== tab && pattern.test(flat(html))).map(([id]) => id);
    assert.deepEqual(elsewhere, [], `"${section}" also appears in ${elsewhere.join(', ')}`);
  }
});

test('the scenario inputs render from stored state, not from whatever is on screen', () => {
  const { run } = labFixture();
  // A value typed on another tab is still in state, and must be what the field shows.
  const response = flat(responseInputsPanel(run, { towTravelMinutes: 9 }));
  assert.match(response, /data-sim-input="towTravelMinutes" value="9"/);
  const traffic = flat(trafficInputsPanel(run, { blockedLanes: 3 }));
  assert.match(traffic, /data-sim-traffic="blockedLanes" value="3"/);
  // With nothing stored it falls back to the run's own inputs rather than to a blank.
  assert.match(flat(responseInputsPanel(run, {})),
    new RegExp(`data-sim-input="towTravelMinutes" value="${run.inputs.response.towTravelMinutes}"`));
});

test('rendering a tab does not run a simulation or change the session', () => {
  const fixture = labFixture();
  const before = fixture.session.all.map(run => run.id);
  const headline = JSON.stringify(fixture.run.headline);
  for (let i = 0; i < 3; i += 1) {
    overviewTab({ baseline: fixture.baseline, provenance: provenanceSummary(fixture.baseline),
      calibration: null, run: fixture.run, path: fixture.path, sweep: fixture.sweep,
      comparison: fixture.comparison, optimisation: null });
    trafficTab({ run: fixture.run, trafficInputs: '' });
    responseTab({ run: fixture.run, path: fixture.path, sweep: fixture.sweep, responseInputs: '',
      runs: fixture.session.all, activeId: fixture.run.id });
    economicsTab({ run: fixture.run, assumptions: fixture.assumptions });
    optimizationSection({ runs: fixture.session.all, activeId: fixture.run.id, optimisation: null,
      comparison: null });
  }
  assert.deepEqual(fixture.session.all.map(run => run.id), before, 'a render created a run');
  assert.equal(JSON.stringify(fixture.run.headline), headline, 'a render changed the numbers');
});

test('the optimizer’s results are shown when present and prompted for when not', () => {
  const fixture = labFixture();
  const empty = flat(optimizationSection({ runs: fixture.session.all, activeId: fixture.run.id,
    optimisation: null, comparison: null }));
  assert.match(empty, /Run the optimisation/);
  // The objective control is gone: three of the five objectives are the same objective in this
  // model, and the other two differ by tens of dollars. The panel says so.
  assert.doesNotMatch(empty, /data-sim="objective"/);
  assert.match(empty, /secondary exposure IS vehicle-hours queued/);

  const found = fixture.session.optimise({ objective: 'ECONOMIC',
    grid: { rangers: [1, 2], towTravelMinutes: [10, 22] } });
  const filled = optimizationSection({ runs: fixture.session.all, activeId: fixture.run.id,
    optimisation: found, comparison: null });
  assert.match(filled, /What it would take/);
  assert.match(filled, /feasible strategies evaluated|excluded as unavailable/);
});

test('each tab still prints the warnings that belong to it', () => {
  const fixture = labFixture();
  // Progressive disclosure must not have hidden the caveats.
  const traffic = flat(trafficTab({ run: fixture.run, trafficInputs: '' }));
  assert.match(traffic, /is measured on this corridor/);
  assert.match(traffic, /not yet modelled/);
  assert.match(traffic, /do not change\s*when a scenario is run/);
  assert.match(flat(economicsTab({ run: fixture.run, assumptions: fixture.assumptions })),
    /Paid later by the same vehicle/);
  assert.match(flat(overviewTab({ baseline: fixture.baseline,
    provenance: provenanceSummary(fixture.baseline), calibration: null, run: fixture.run,
    path: fixture.path, sweep: fixture.sweep, comparison: fixture.comparison, optimisation: null })),
  /not a record of how the incident was actually handled/);
});

test('economics reconciles on screen, and says so if it ever stops', () => {
  const fixture = labFixture();
  const html = economicsTab({ run: fixture.run, assumptions: null });
  assert.match(html, /Reconciliation/);
  assert.match(flat(html), /which is the total shown above/);
  assert.doesNotMatch(html, /do not use these figures/);
});

test('the five objectives collapse to the same recommendation, which is why the control went', () => {
  // Measured, not asserted from the UI: exposure IS vehicle-hours queued and both follow clearance,
  // so three of the five objectives are one objective. This test exists so that if a future measure
  // makes them genuinely different, it fails and the control can come back.
  const baseline = baselineFor();
  const session = createSimulationSession({ baseline });
  const grid = { rangers: [1, 2], towTravelMinutes: [10, 22], detectionMinutes: [2, 6] };
  const best = {};
  for (const objective of ['CLEARANCE', 'DELAY', 'EXPOSURE', 'ECONOMIC', 'BALANCED']) {
    best[objective] = session.optimise({ objective, grid }).best;
  }
  const clearanceOf = entry => entry.result.timeline.roadwayClearanceMinutes;
  assert.equal(clearanceOf(best.CLEARANCE), clearanceOf(best.DELAY));
  assert.equal(clearanceOf(best.CLEARANCE), clearanceOf(best.EXPOSURE));
  assert.equal(best.DELAY.result.queue.vehicleHoursOfDelay,
    best.EXPOSURE.result.exposure.vehicleHoursExposed,
    'exposure and delay are the same quantity, so they cannot be different objectives');
  // The cost-led answer differs only marginally, and never on clearance.
  assert.equal(clearanceOf(best.ECONOMIC), clearanceOf(best.CLEARANCE));
});

test('nothing still points at the Optimization tab, which no longer exists', () => {
  const fixture = labFixture();
  const panels = [
    overviewTab({ baseline: fixture.baseline, provenance: provenanceSummary(fixture.baseline),
      calibration: null, run: fixture.run, path: fixture.path, sweep: fixture.sweep,
      comparison: fixture.comparison, optimisation: null }),
    overviewTab({ baseline: fixture.baseline, provenance: provenanceSummary(fixture.baseline),
      calibration: null, run: fixture.run, path: fixture.path, sweep: fixture.sweep,
      comparison: fixture.comparison,
      optimisation: fixture.session.optimise({ grid: { rangers: [1, 2] } }) }),
    responseTab({ run: fixture.run, path: fixture.path, sweep: fixture.sweep, responseInputs: '',
      runs: fixture.session.all, activeId: fixture.run.id }),
    trafficTab({ run: fixture.run, trafficInputs: '' }),
    economicsTab({ run: fixture.run, assumptions: null }),
  ];
  for (const html of panels) assert.doesNotMatch(flat(html), /Optimization tab/i);
});

test('one inert lever reads as singular, several as plural', () => {
  const fixture = labFixture();
  const one = { movers: [], inert: [{ verdict: 'COSTS_WITHOUT_REOPENING', label: 'Tow travel' }],
    rows: [], method: '' };
  const two = { movers: [], rows: [], method: '',
    inert: [{ verdict: 'COSTS_WITHOUT_REOPENING', label: 'Tow travel' },
      { verdict: 'COSTS_WITHOUT_REOPENING', label: 'Tow rolled early' }] };
  const render = sweep => flat(overviewTab({ baseline: fixture.baseline, provenance: null,
    calibration: null, run: fixture.run, path: fixture.path, sweep, comparison: null,
    optimisation: null }));
  assert.match(render(one), /tow travel changes what the response costs/);
  assert.match(render(two), /tow travel and tow rolled early change what the response costs/);
});

test('Traffic Impact holds only what does NOT change when a scenario is run', () => {
  // The split is justified by measurement, so the measurement is the test: inputs are stable
  // across scenarios, results are not, and each belongs with its own kind.
  const baseline = baselineFor();
  const session = createSimulationSession({ baseline });
  const standard = session.run({ presetId: 'standard' });
  const coordinated = session.run({ presetId: 'coordinated' });

  const traffic = run => flat(trafficTab({ run, trafficInputs: '' }));
  assert.equal(traffic(standard), traffic(coordinated),
    'Traffic Impact changed between scenarios — a result has leaked back into it');

  const response = run => flat(responseTab({ run, path: criticalPath(run),
    sweep: sensitivity(r => runSimulation(baseline, { response: r }), run),
    responseInputs: '', runs: session.all, activeId: run.id }));
  assert.notEqual(response(standard), response(coordinated),
    'Response Analysis did not change between scenarios');
  // And the numbers that moved are the ones that should have.
  assert.notEqual(standard.queue.vehicleHoursOfDelay, coordinated.queue.vehicleHoursOfDelay);
  assert.equal(JSON.stringify(standard.inputs.traffic), JSON.stringify(coordinated.inputs.traffic));
});

test('the queue chart sits on Response Analysis, below the timeline, and not in two places', () => {
  const fixture = labFixture();
  const response = flat(responseTab({ run: fixture.run, path: fixture.path, sweep: fixture.sweep,
    responseInputs: '', runs: fixture.session.all, activeId: fixture.run.id }));
  const timelineAt = response.indexOf('Response timeline');
  const queueAt = response.indexOf('Queue over time');
  assert.ok(timelineAt >= 0 && queueAt > timelineAt, 'the queue must follow the timeline');
  assert.doesNotMatch(flat(trafficTab({ run: fixture.run, trafficInputs: '' })), />\s*Queue over time/);
});

/* ============================================================================================
   13. Patrols
   ============================================================================================ */

/** A short stretch of centreline, enough for the fleet to stand on. */
const CENTERLINE = Array.from({ length: 60 }, (_, index) => ({
  lon: -80.34 + index * 0.0015, lat: 26.1,
}));

const patrolFixture = () => {
  const fact = factWith({ longitude: -80.30, latitude: 26.1002 });
  const baseline = buildIncidentBaseline(fact, { sectionProfile });
  const session = createSimulationSession({ baseline });
  const run = session.run({ presetId: 'standard' });
  const options = patrolOptionsFor(fact, { centerline: CENTERLINE });
  const comparison = comparePatrols(options,
    response => runSimulation(baseline, { response }), run);
  return { fact, baseline, session, run, options, comparison };
};

test('the fleet comes from the TMC, and always leaves enough patrols to compare', () => {
  const { options } = patrolFixture();
  assert.equal(options.available, true);
  assert.equal(options.fleetSize, 6);
  assert.ok(options.candidates.length >= MINIMUM_CANDIDATES,
    `only ${options.candidates.length} dispatchable — a comparison needs at least ${MINIMUM_CANDIDATES}`);
  // Ineligible ones are kept, with the reason, rather than filtered out of sight.
  const ineligible = options.patrols.filter(patrol => !patrol.dispatchable);
  assert.ok(ineligible.length >= 1);
  assert.ok(ineligible.every(patrol => patrol.ineligibleReason));
});

test('the same incident always produces the same fleet', () => {
  const { fact } = patrolFixture();
  const first = patrolOptionsFor(fact, { centerline: CENTERLINE });
  const second = patrolOptionsFor(fact, { centerline: CENTERLINE });
  assert.deepEqual(first.patrols.map(patrol => [patrol.id, patrol.status, patrol.distanceMetres]),
    second.patrols.map(patrol => [patrol.id, patrol.status, patrol.distanceMetres]));
});

test('candidates are ordered by travel time, and the nearest is the nearest', () => {
  const { options } = patrolFixture();
  const times = options.candidates.map(patrol => patrol.travelMinutes);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.equal(options.nearest.id, options.candidates[0].id);
  assert.ok(options.nearest.travelMinutes <= options.furthest.travelMinutes);
});

test('each patrol is a full re-run, so the comparison is in minutes and dollars', () => {
  const { options, comparison, run } = patrolFixture();
  assert.equal(comparison.rows.length, options.candidates.length);
  for (const row of comparison.rows) {
    assert.ok(Number.isFinite(row.roadwayClearanceMinutes));
    assert.ok(Number.isFinite(row.totalModelledCostUSD));
    // The change is measured against the run on screen, not against the best candidate.
    assert.equal(row.costChange, row.totalModelledCostUSD - run.headline.totalModelledCostUSD);
  }
  // Ranked by cost, so the cheapest is first.
  const costs = comparison.rows.map(row => row.totalModelledCostUSD);
  assert.deepEqual(costs, [...costs].sort((a, b) => a - b));
});

test('a closer patrol does not automatically open the lanes sooner — the binding gate decides', () => {
  const { options, comparison } = patrolFixture();
  // Whatever the result, it must be the ENGINE's: clearance can only improve while the patrol is
  // what the incident is waiting on.
  const nearest = comparison.rows.find(row => row.patrol.id === options.nearest.id);
  const furthest = comparison.rows.find(row => row.patrol.id === options.furthest.id);
  assert.ok(nearest.roadwayClearanceMinutes <= furthest.roadwayClearanceMinutes);
  if (!comparison.choiceMatters) {
    assert.equal(comparison.clearanceSpreadMinutes, 0,
      'if the choice does not matter the spread must be zero, not merely small');
  }
});

test('nothing about the patrols is presented as observed', () => {
  const { options, comparison } = patrolFixture();
  assert.match(options.standing, /No Road Ranger dataset exists/);
  assert.match(options.basis, /not a routed path/);
  assert.match(options.disclaimer, /Not actual FDOT or ACS dispatch data/);
  const html = flat(patrolsTab({ options, comparison }));
  assert.match(html, /SIMULATED/);
  assert.match(html, /No Road Ranger dataset exists/);
  assert.match(html, /not a dispatch recommendation/);
  // The carriageway caveat: the TMC filters by direction, this screen cannot.
  assert.match(html, /direction it was travelling cannot be established/);
});

test('with no centreline there is no fleet, and the panel says why', () => {
  const { fact } = patrolFixture();
  const options = patrolOptionsFor(fact, { centerline: [] });
  assert.equal(options.available, false);
  assert.match(options.reason, /centreline is not loaded/);
  assert.match(flat(patrolsTab({ options, comparison: null })), /centreline is not loaded/);
  assert.equal(comparePatrols(options, () => null, null), null);
});

test('the Lab offers five views, with Patrols between Response Analysis and Economics', () => {
  assert.deepEqual(LAB_TABS.map(tab => tab.id),
    ['overview', 'traffic', 'response', 'patrols', 'economics']);
});

test('a patrol closer than the model’s arrival floor is reported, not silently clamped', () => {
  // Patrols within about 2.5 km all drive it in under two minutes, which is below the response
  // model's minimum arrival time. They were all floored to the same value and the comparison
  // showed four identical rows that looked like a coincidence.
  const near = { lon: -80.3001, lat: 26.1 };
  const centerline = Array.from({ length: 40 }, (_, index) => ({ lon: -80.31 + index * 0.0005, lat: 26.1 }));
  const options = patrolOptionsFor(factWith({ longitude: near.lon, latitude: near.lat }), { centerline });
  const floored = options.candidates.filter(patrol => patrol.floored);
  for (const patrol of floored) {
    assert.ok(patrol.driveMinutes < ARRIVAL_FLOOR_MINUTES);
    assert.equal(patrol.travelMinutes, ARRIVAL_FLOOR_MINUTES, 'the floor still applies');
  }
  assert.equal(options.flooredCandidates, floored.length);
  assert.equal(options.arrivalFloorMinutes, ARRIVAL_FLOOR_MINUTES);
});

test('clearance is compared to a tenth of a minute, so near patrols are told apart', () => {
  const { comparison } = patrolFixture();
  // Whole minutes rounded two patrols thirty seconds apart into the same number.
  for (const row of comparison.rows) {
    assert.equal(row.roadwayClearanceMinutes,
      Number(row.result.timeline.roadwayClearanceMinutes.toFixed(1)));
  }
  const distinct = new Set(comparison.rows.map(row => row.patrol.travelMinutes));
  if (distinct.size > 1) {
    const clearances = new Set(comparison.rows.map(row => row.roadwayClearanceMinutes));
    assert.ok(clearances.size > 1,
      'patrols with different travel times produced identical clearance times');
  }
});

test('each patrol carries what the map needs to draw and label it', () => {
  const { options } = patrolFixture();
  for (const patrol of options.patrols) {
    assert.ok(Number.isFinite(patrol.longitude) && Number.isFinite(patrol.latitude));
    assert.ok(patrol.colour.startsWith('#'), 'a status colour for the marker');
    // The label says the travel time for a patrol that could come, and the status for one that
    // could not — a number on an unavailable vehicle would read as a promise.
    assert.ok(patrol.dispatchable ? Number.isFinite(patrol.travelMinutes) : patrol.ineligibleReason);
  }
});

test('quickWins ranks single changes by the minutes they take off reopening', () => {
  const baseline = baselineFor();
  const base = runFor(baseline);
  const sweep = sensitivity(response => runFor(baseline, response), base);
  const wins = quickWins(sweep);

  assert.ok(wins.length > 0 && wins.length <= 5, 'at most five, and not empty for this incident');
  // Ranked, and every row is a real saving measured against where the lever sits now.
  for (let index = 1; index < wins.length; index += 1) {
    assert.ok(wins[index - 1].savedMinutes >= wins[index].savedMinutes, 'ordered by minutes saved');
  }
  assert.ok(wins.every(win => win.savedMinutes > 0), 'a row that saves nothing is not a win');
  assert.ok(wins.every(win => win.reopeningMinutes < sweep.baseline.reopening));
  // It is a shortlist of the sweep, so it may never contain a lever the sweep calls inert.
  const inert = new Set(sweep.inert.map(row => row.key));
  assert.ok(wins.every(win => !inert.has(win.key)), 'no lever that cannot move reopening');
  // Deterministic.
  assert.deepEqual(quickWins(sweep), wins);
  assert.deepEqual(quickWins(null), []);
});

test('settingChanges reports only the inputs the optimiser moved, with both values', () => {
  const from = { ...DEFAULT_RESPONSE };
  const to = { ...DEFAULT_RESPONSE, rangers: DEFAULT_RESPONSE.rangers + 1,
    detectionMinutes: DEFAULT_RESPONSE.detectionMinutes - 2 };
  const changes = settingChanges(from, to);

  assert.deepEqual(changes.map(change => change.key).sort(), ['detectionMinutes', 'rangers']);
  const detection = changes.find(change => change.key === 'detectionMinutes');
  assert.equal(detection.from, DEFAULT_RESPONSE.detectionMinutes);
  assert.equal(detection.to, DEFAULT_RESPONSE.detectionMinutes - 2);
  assert.equal(detection.delta, -2);
  assert.equal(detection.tightened, true, 'less detection time is the improving direction');
  assert.equal(changes.find(change => change.key === 'rangers').tightened, true,
    'more rangers is the improving direction for a units lever');

  assert.deepEqual(settingChanges(from, from), [], 'nothing moved, nothing reported');
  assert.deepEqual(settingChanges(null, to), []);
});

test('the recommendation names what the search changed when a baseline is given', () => {
  const baseline = baselineFor();
  const best = runFor(baseline, { ...DEFAULT_RESPONSE, rangers: DEFAULT_RESPONSE.rangers + 1 });
  const optimisation = { best: { result: best, settings: best.inputs.response },
    objectiveLabel: 'Balanced', evaluated: 12, rejected: 3, rejectedExamples: [], pareto: [],
    method: 'test' };

  const withBase = recommendationBlock(optimisation, null, DEFAULT_RESPONSE);
  assert.match(withBase, /What the search changed/);
  assert.match(withBase, /Road Rangers on scene/);
  // Without one it must not invent a comparison.
  const without = recommendationBlock(optimisation, null, null);
  assert.ok(!/<table class="sim-table sim-changes">/.test(without));
});
