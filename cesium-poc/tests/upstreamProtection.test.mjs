/**
 * Upstream warning and queue protection.
 *
 * The whole module exists to keep four answers apart, and these tests exist to stop them merging:
 *
 *   CONFIRMED     we looked, and it is there
 *   NOT_OBSERVED  we looked, and it is not
 *   UNKNOWN       we could not work out where to look
 *   UNAVAILABLE   the source does not publish this, for anyone, ever
 *
 * Measured against the connected data before any of this was written: CONGESTION events exist
 * (47 of 98 loaded events), while queue_length_mi, traffic_conditions, est_delay_min, recovery_eta,
 * dms_message and nearby_dms_ids are populated on 0 of 98. So traffic is observable, queue extent
 * is not, and DMS activation is not — and those are three different sentences.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CARRIAGEWAYS } from '../src/liveOps/carriagewayModel.js';
import { UPSTREAM_STATUS } from '../src/tmc/upstreamResolver.js';
import {
  assessUpstreamProtection, OBSERVATION, QUEUE_FIELDS_UNAVAILABLE, WARNING_FIELDS_UNAVAILABLE,
} from '../src/tmc/upstreamProtection/upstreamProtectionService.js';
import {
  compareWarningScenarios, resolveWarningAssumptions, simulatedQueueExtent, simulatedQueueMetersAt,
  WARNING_ASSUMPTIONS,
} from '../src/tmc/upstreamProtection/warningScenario.js';
import {
  availableUpstreamMeters, resourceVersusQueueTail, simulatedQueueGeometry,
} from '../src/tmc/upstreamProtection/queueGeometry.js';
import { assessSecondaryRisk } from '../src/tmc/secondaryIncidentRisk.js';
import { parseTmcQuestion, answerTmcQuestion, TWIN_ACTIONS } from '../src/tmc/tmcAnswers.js';

const CENTERLINE = Array.from({ length: 60 }, (_, i) => ({ lon: -80.40 + i * 0.0035, lat: 26.06 }));
const ANCHOR = Date.parse('2026-03-06T15:00:00Z');
const sectionsFor = carriageway => Array.from({ length: 8 }, (_, i) => ({
  segmentId: `SEG-${i + 1}`, sectionId: `S0${i + 1}`, sectionIndex: i + 1,
  travelOrder: carriageway === CARRIAGEWAYS.WB_GENERAL ? 8 - i : i + 1,
  sectionLabel: `Section 0${i + 1}`, carriageway,
}));
const SIGNS = [{ id: 'DMS-07', longitude: -80.30, latitude: 26.06, record: {} }];
const CAMERAS = [{ id: 'CAM-12', longitude: -80.29, latitude: 26.06, record: {} }];
const incidentOn = (carriageway, sectionIndex = 5) => ({
  id: 'INC-TEST', longitude: -80.26, latitude: 26.06, carriageway, sectionIndex,
});
const assess = (carriageway, extra = {}) => assessUpstreamProtection(incidentOn(carriageway), {
  sections: sectionsFor(carriageway), centerline: CENTERLINE, cameras: CAMERAS, signs: SIGNS,
  anchorMs: ANCHOR, ...extra,
});

// ------------------------------------------------------------------ upstream resolution

test('an eastbound incident resolves its approach from the corridor travel order', () => {
  const result = assess(CARRIAGEWAYS.EB_GENERAL);
  assert.equal(result.upstreamResolution.resolved, true);
  assert.equal(result.upstreamResolution.status, UPSTREAM_STATUS.RESOLVED);
  assert.ok(result.upstreamSections.length > 0);
});

test('a westbound incident resolves the other way, from the higher travel order', () => {
  const result = assess(CARRIAGEWAYS.WB_GENERAL);
  assert.equal(result.upstreamResolution.resolved, true);
  // Westbound traffic arrives from the higher section index on the same published geometry.
  const indices = result.upstreamSections.map(section => section.sectionIndex);
  assert.ok(indices.every(index => index > 5), `expected higher indices, got ${indices}`);
});

test('an unresolved carriageway refuses, and nothing downstream of it is assessed', () => {
  const result = assess(CARRIAGEWAYS.UNKNOWN);
  assert.equal(result.upstreamResolution.resolved, false);
  assert.match(result.upstreamResolution.reason, /carriageway unresolved/i);
  assert.equal(result.trafficObservationStatus, OBSERVATION.UNKNOWN);
  assert.deepEqual([...result.dmsResources], [], 'no sign may be called upstream without a direction');
  assert.deepEqual([...result.cameraResources], []);
  assert.equal(result.patrolProtectionApplies, false);
});

test('Express refuses with its own reason — the corridor does not publish its direction', () => {
  const result = assess(CARRIAGEWAYS.EXPRESS);
  assert.equal(result.upstreamResolution.resolved, false);
  assert.match(result.upstreamResolution.reason, /express/i);
});

// ------------------------------------------------------------------ traffic and queue

test('congestion upstream is CONFIRMED, and no congestion is NOT_OBSERVED — not UNKNOWN', () => {
  const withQueueing = assess(CARRIAGEWAYS.EB_GENERAL, { upstreamCongestion: [{ id: 'C1' }, { id: 'C2' }] });
  assert.equal(withQueueing.trafficObservationStatus, OBSERVATION.CONFIRMED);
  assert.equal(withQueueing.traffic.events.length, 2);
  assert.equal(withQueueing.traffic.source, 'FL511 congestion events');

  const quiet = assess(CARRIAGEWAYS.EB_GENERAL, { upstreamCongestion: [] });
  assert.equal(quiet.trafficObservationStatus, OBSERVATION.NOT_OBSERVED,
    'we looked and found nothing — that is not the same as not knowing');
});

test('queue extent is UNAVAILABLE always, and names the fields that would change that', () => {
  for (const carriageway of [CARRIAGEWAYS.EB_GENERAL, CARRIAGEWAYS.WB_GENERAL, CARRIAGEWAYS.UNKNOWN]) {
    const result = assess(carriageway);
    assert.equal(result.queueObservationStatus, OBSERVATION.UNAVAILABLE);
    assert.equal(result.queue.extentMeters, null, 'no queue length may ever be produced from real data');
    assert.equal(result.queue.observedAt, null);
  }
  const fields = QUEUE_FIELDS_UNAVAILABLE.map(entry => entry.field);
  assert.deepEqual(fields, ['queue_length_mi', 'traffic_conditions', 'est_delay_min', 'recovery_eta']);
});

test('a confirmed queue is never inferred from congestion being present', () => {
  const result = assess(CARRIAGEWAYS.EB_GENERAL, { upstreamCongestion: [{ id: 'C1' }] });
  assert.equal(result.trafficObservationStatus, OBSERVATION.CONFIRMED);
  assert.equal(result.queueObservationStatus, OBSERVATION.UNAVAILABLE,
    'knowing traffic is slowing does not tell us how far back it reaches');
});

// ------------------------------------------------------------------ warning resources

test('an upstream DMS is located, but its activation stays UNKNOWN', () => {
  const result = assess(CARRIAGEWAYS.EB_GENERAL);
  assert.equal(result.nearestDms?.id, 'DMS-07');
  assert.equal(result.nearestDms.upstream, true);
  assert.ok(result.nearestDms.upstreamMeters > 0);
  // The sign's presence is not evidence of a warning.
  assert.equal(result.warningActivationStatus, OBSERVATION.UNKNOWN);
  assert.match(result.warningActivation.detail, /does not confirm a warning/i);
  assert.deepEqual(result.warningActivation.missingFields.map(f => f.field), ['dms_message', 'dms_activated_at']);
  assert.deepEqual(WARNING_FIELDS_UNAVAILABLE.map(f => f.field), ['dms_message', 'dms_activated_at']);
});

test('a downstream sign is never reported as upstream', () => {
  // A sign east of an eastbound incident is behind the traffic, not in front of it.
  const result = assessUpstreamProtection(incidentOn(CARRIAGEWAYS.EB_GENERAL), {
    sections: sectionsFor(CARRIAGEWAYS.EB_GENERAL), centerline: CENTERLINE, anchorMs: ANCHOR,
    signs: [{ id: 'DMS-DOWN', longitude: -80.21, latitude: 26.06, record: {} }], cameras: [],
  });
  assert.equal(result.nearestDms, null);
  assert.equal(result.warningActivationStatus, OBSERVATION.UNKNOWN);
});

test('a camera is located upstream, but no historical footage is claimed', () => {
  const result = assess(CARRIAGEWAYS.EB_GENERAL);
  assert.equal(result.nearestCamera?.id, 'CAM-12');
  assert.equal(result.cameraCoverage.status, OBSERVATION.CONFIRMED);
  assert.equal(result.cameraCoverage.historicalFootage.status, OBSERVATION.UNAVAILABLE);
  assert.match(result.cameraCoverage.historicalFootage.detail, /live only/i);
});

// ------------------------------------------------------------------ confidence and attention

test('data coverage is its own axis and counts only what was established', () => {
  const result = assess(CARRIAGEWAYS.EB_GENERAL, { upstreamCongestion: [{ id: 'C1' }] });
  // traffic CONFIRMED + camera CONFIRMED known; queue UNAVAILABLE + warning UNKNOWN not.
  assert.equal(result.dataConfidence.known, 2);
  assert.equal(result.dataConfidence.total, 4);
  assert.equal(result.dataConfidence.label, 'Medium');
});

test('recommended attention marks a data gap as a gap, never as an available action', () => {
  const result = assess(CARRIAGEWAYS.EB_GENERAL, { upstreamCongestion: [{ id: 'C1' }] });
  const queueItem = result.recommendedAttention.find(item => /not measurable/i.test(item.action));
  assert.equal(queueItem.gap, true);
  const dmsItem = result.recommendedAttention.find(item => /Confirm warning status/i.test(item.action));
  assert.equal(dmsItem.gap, true);
  for (const item of result.recommendedAttention) assert.ok(item.evidence, `${item.action} must name its evidence`);
  // Highest priority first.
  const order = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  const ranks = result.recommendedAttention.map(item => order[item.priority]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
});

test('an unresolved approach makes establishing it the first recommendation', () => {
  const result = assess(CARRIAGEWAYS.UNKNOWN);
  assert.match(result.recommendedAttention[0].action, /Establish the upstream approach/i);
  assert.equal(result.recommendedAttention[0].gap, true);
});

// ------------------------------------------------------------------ warning scenario

test('the simulated queue is deterministic and capped at the assumed incident duration', () => {
  assert.equal(simulatedQueueMetersAt(0), WARNING_ASSUMPTIONS.initialQueueMeters);
  assert.equal(simulatedQueueMetersAt(10), 200 + 120 * 10);
  // Past the assumed duration it stops growing rather than running away.
  assert.equal(simulatedQueueMetersAt(45), simulatedQueueMetersAt(500));
  // Same input, same output, every time.
  assert.equal(simulatedQueueMetersAt(17), simulatedQueueMetersAt(17));
  assert.equal(simulatedQueueMetersAt(-1), null);
});

test('the queue is never drawn without a resolved direction', () => {
  assert.equal(simulatedQueueExtent({ minutesSinceIncident: 10, upstreamResolved: false }), null);
  const extent = simulatedQueueExtent({ minutesSinceIncident: 10, upstreamResolved: true });
  assert.equal(extent.simulated, true);
  assert.ok(extent.metres > 0);
});

test('comparing activation delays changes exactly one assumption', () => {
  const result = compareWarningScenarios({ anchorMs: ANCHOR, dmsUpstreamMeters: 4000, dmsId: 'DMS-07' });
  assert.equal(result.resolved, true);
  assert.equal(result.simulated, true);
  assert.equal(result.changedAssumption, 'warningActivationDelayMinutes');
  assert.equal(result.earlierByMinutes,
    WARNING_ASSUMPTIONS.warningActivationDelayMinutes - WARNING_ASSUMPTIONS.fasterActivationDelayMinutes);
  // The earlier warning meets a queue that has grown less — which is NOT the queue being shortened.
  assert.ok(result.queueAtActivationA > result.queueAtActivationB);
  assert.equal(result.queueModelUnchanged, true);
  assert.equal(result.queueShorterByMeters, undefined,
    'a field named "queue shorter" invites reading the warning as acting on the queue');
  assert.ok(result.held.includes('queueGrowthMetersPerMinute'));
  assert.ok(result.held.includes('approachSpeedKmh'));
  assert.equal(result.scenarioA.simulated, true);
  assert.equal(result.scenarioB.simulated, true);
});

test('without an upstream sign, reaching the tail is null — not false', () => {
  const result = compareWarningScenarios({ anchorMs: ANCHOR, dmsUpstreamMeters: null });
  assert.equal(result.scenarioA.reachesQueueTail, null, '"cannot say" must not read as "no"');
  assert.equal(result.scenarioA.warningLeadSeconds, null);
  assert.match(result.caveat, /No upstream sign was resolved/i);
});

test('a sign closer than the queue tail does not reach it', () => {
  // The tail at 10 minutes is 1400 m; a sign 800 m upstream is already inside the queue.
  const result = compareWarningScenarios({ anchorMs: ANCHOR, dmsUpstreamMeters: 800 });
  assert.equal(result.scenarioA.reachesQueueTail, false);
  // The earlier warning, meeting a 680 m queue, does reach it.
  assert.equal(result.scenarioB.reachesQueueTail, true);
});

test('the warning scenario never produces a crash probability or an avoided collision', () => {
  const result = compareWarningScenarios({ anchorMs: ANCHOR, dmsUpstreamMeters: 4000 });
  const text = JSON.stringify(result).toLowerCase();
  for (const forbidden of ['crash probability', 'crashes avoided', 'collisions avoided', 'crashes prevented', 'roi']) {
    assert.ok(!text.includes(forbidden), `must not claim "${forbidden}"`);
  }
  assert.match(result.caveat, /hypothetical/i);
});

test('assumptions are overridable and reported with the result', () => {
  const custom = resolveWarningAssumptions({ queueGrowthMetersPerMinute: 60, nonsense: 'x' });
  assert.equal(custom.queueGrowthMetersPerMinute, 60);
  assert.equal(custom.initialQueueMeters, WARNING_ASSUMPTIONS.initialQueueMeters);
  assert.equal(custom.nonsense, undefined, 'only declared assumptions are accepted');
  const result = compareWarningScenarios({ anchorMs: ANCHOR, dmsUpstreamMeters: 4000, assumptions: { queueGrowthMetersPerMinute: 60 } });
  assert.equal(result.assumptions.queueGrowthMetersPerMinute, 60);
});

test('no timestamp means no scenario, rather than one anchored to now', () => {
  assert.equal(compareWarningScenarios({ anchorMs: null }).resolved, false);
});

// ------------------------------------------------------------------ isolation from risk

test('the upstream assessment cannot move the Secondary Incident Risk score', () => {
  const incident = {
    id: 'INC-TEST', severity: 'Major', activeMinutes: 60,
    carriageway: CARRIAGEWAYS.EB_GENERAL, sectionIndex: 3, lanes: { stated: true, blockedLanes: 2 },
  };
  const before = assessSecondaryRisk(incident, { impactLevel: 'HIGH' });
  const after = assessSecondaryRisk(incident, {
    impactLevel: 'HIGH',
    upstreamProtection: assess(CARRIAGEWAYS.EB_GENERAL, { upstreamCongestion: [{ id: 'C1' }] }),
    warningScenario: compareWarningScenarios({ anchorMs: ANCHOR, dmsUpstreamMeters: 4000 }),
    simulatedQueueMeters: 1400,
  });
  assert.equal(after.score, before.score);
  assert.equal(after.level, before.level);
  assert.deepEqual({ ...after.confidence }, { ...before.confidence });
  assert.ok(!after.factors.some(factor => /queue|warning|dms/i.test(factor.type)));
});

test('an unknown queue is never scored as no congestion', () => {
  const result = assess(CARRIAGEWAYS.UNKNOWN);
  assert.notEqual(result.queueObservationStatus, OBSERVATION.NOT_OBSERVED);
  assert.notEqual(result.trafficObservationStatus, OBSERVATION.NOT_OBSERVED);
});

// ------------------------------------------------------------------ Ask the Twin

const selectedFor = carriageway => ({
  incident: { id: 'INC-TEST', carriageway, sectionLabel: 'Section 05' },
  risk: { factors: [], contributors: [], unavailableFactors: [], unknownFactors: [] },
  upstream: { status: UPSTREAM_STATUS.RESOLVED }, upstreamCongestion: [], resources: {}, mitigation: [],
});
const ASSESSED = { assessments: [], historical: true, when: { label: '6 Mar 2026' } };

test('the upstream questions each parse to their own intent', () => {
  assert.equal(parseTmcQuestion('Show the upstream approach.'), 'UPSTREAM_APPROACH');
  assert.equal(parseTmcQuestion('Is there a queue forming?'), 'QUEUE_STATUS');
  assert.equal(parseTmcQuestion('Which DMS is upstream?'), 'UPSTREAM_DMS');
  assert.equal(parseTmcQuestion('Is an upstream warning active?'), 'WARNING_STATUS');
  assert.equal(parseTmcQuestion('What can the operator do to protect approaching traffic?'), 'PROTECT_APPROACH');
  assert.equal(parseTmcQuestion('What if the warning was activated earlier?'), 'WARNING_EARLIER');
  assert.equal(parseTmcQuestion('Compare patrol and warning response.'), 'PATROL_AND_WARNING');
});

test('the upstream intents do not swallow the existing or patrol questions', () => {
  assert.equal(parseTmcQuestion('Compare patrol response times.'), 'PATROL_COMPARE');
  assert.equal(parseTmcQuestion('Show historical crashes here'), 'LOCATION_HISTORY');
  assert.equal(parseTmcQuestion('What data is missing for this incident?'), 'DATA_GAPS');
  assert.equal(parseTmcQuestion('Why does this require attention?'), 'WHY_RISK');
});

test('the queue answer says UNAVAILABLE and names the missing fields', () => {
  const answer = answerTmcQuestion('QUEUE_STATUS', ASSESSED, {
    selected: selectedFor(CARRIAGEWAYS.EB_GENERAL),
    upstreamProtection: assess(CARRIAGEWAYS.EB_GENERAL, { upstreamCongestion: [{ id: 'C1' }] }),
  });
  assert.match(answer.answer, /UNAVAILABLE/);
  assert.match(answer.answer, /queue_length_mi/);
  assert.match(answer.answer, /CONFIRMED/, 'what IS observed must still be stated');
});

test('the warning answer never claims a warning was shown', () => {
  const answer = answerTmcQuestion('WARNING_STATUS', ASSESSED, {
    selected: selectedFor(CARRIAGEWAYS.EB_GENERAL),
    upstreamProtection: assess(CARRIAGEWAYS.EB_GENERAL),
  });
  assert.match(answer.answer, /UNKNOWN/);
  assert.match(answer.answer, /not evidence that a warning was shown/i);
  assert.match(answer.answer, /dms_message/);
});

test('an unresolved approach refuses navigation instead of guessing a direction', () => {
  const answer = answerTmcQuestion('UPSTREAM_APPROACH', ASSESSED, {
    selected: selectedFor(CARRIAGEWAYS.UNKNOWN),
    upstreamProtection: assess(CARRIAGEWAYS.UNKNOWN),
  });
  assert.match(answer.answer, /UNKNOWN/);
  assert.match(answer.answer, /will not guess/i);
  assert.deepEqual(answer.actions, [], 'no Inspect Upstream action when there is no upstream');
});

test('the earlier-warning answer is labelled simulated and claims no avoided crash', () => {
  const answer = answerTmcQuestion('WARNING_EARLIER', ASSESSED, {
    selected: selectedFor(CARRIAGEWAYS.EB_GENERAL),
    upstreamProtection: assess(CARRIAGEWAYS.EB_GENERAL),
    warning: compareWarningScenarios({ anchorMs: ANCHOR, dmsUpstreamMeters: 4000, dmsId: 'DMS-07' }),
  });
  assert.match(answer.answer, /SIMULATED/);
  assert.match(answer.answer, /assumptions/i);
  assert.match(answer.answer, /Effect on actual collisions: not estimated/i);
  // The answer must not let an earlier warning read as shortening the queue.
  assert.match(answer.answer, /does NOT shorten the queue/i);
});

test('the combined answer keeps patrol and warning independent', () => {
  const answer = answerTmcQuestion('PATROL_AND_WARNING', ASSESSED, {
    selected: selectedFor(CARRIAGEWAYS.EB_GENERAL),
    upstreamProtection: assess(CARRIAGEWAYS.EB_GENERAL),
    patrol: { eligible: [], suggested: null },
  });
  assert.match(answer.answer, /does not operate a sign/i);
  assert.match(answer.answer, /SIMULATED/);
  assert.match(answer.answer, /UNKNOWN/);
  assert.match(answer.answer, /UNAVAILABLE/);
});

test('upstream actions come from the closed action vocabulary', () => {
  const known = new Set(Object.values(TWIN_ACTIONS));
  for (const intent of ['UPSTREAM_APPROACH', 'QUEUE_STATUS', 'UPSTREAM_DMS', 'WARNING_STATUS', 'PROTECT_APPROACH']) {
    const answer = answerTmcQuestion(intent, ASSESSED, {
      selected: selectedFor(CARRIAGEWAYS.EB_GENERAL),
      upstreamProtection: assess(CARRIAGEWAYS.EB_GENERAL),
    });
    for (const action of answer.actions) assert.ok(known.has(action.type), `${action.type} is not declared`);
  }
});

test('an answer without an assessment says so rather than inventing conditions', () => {
  const answer = answerTmcQuestion('QUEUE_STATUS', ASSESSED, {
    selected: selectedFor(CARRIAGEWAYS.EB_GENERAL), upstreamProtection: null,
  });
  assert.match(answer.answer, /No upstream assessment is available/i);
  assert.deepEqual(answer.actions, []);
});

// ------------------------------------------------------------------ queue geometry and clipping

test('the queue model is identical in both scenarios at any common time', () => {
  // The defect this guards: presenting "queue shorter by N m" made an earlier warning look as
  // though it acted on the queue. It does not — only the activation moment moves.
  const result = compareWarningScenarios({ anchorMs: ANCHOR, dmsUpstreamMeters: 4000 });
  assert.equal(result.queueModelUnchanged, true);
  for (const minute of [0, 5, 12, 30, 45]) {
    assert.equal(simulatedQueueMetersAt(minute), simulatedQueueMetersAt(minute),
      'one queue model, shared by both scenarios');
  }
  assert.match(result.caveat, /does not shorten it/i);
  assert.match(result.caveat, /not estimated/i);
});

test('a queue that runs off the corridor reports the clip rather than hiding it', () => {
  // Measured defect: a 5,000 m queue near the west end rendered as 501 m while the panel went on
  // claiming 5 km. The two lengths are now separate values and the clip is stated.
  const incident = { id: 'I', longitude: CENTERLINE[1].lon, latitude: 26.06, carriageway: CARRIAGEWAYS.EB_GENERAL };
  const queue = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, modelledMeters: 5000, upstreamResolved: true, elapsedMinutes: 40,
  });
  assert.equal(queue.resolved, true);
  assert.equal(queue.modelledMeters, 5000, 'the scenario keeps its own number');
  assert.ok(queue.renderedMeters < 5000, 'the map only draws what exists');
  assert.equal(queue.clipped, true);
  assert.ok(queue.clippedByMeters > 0);
  assert.match(queue.clipNotice, /clipped to available geometry/i);
});

test('a queue with room is not clipped, and its tail is placed upstream', () => {
  const incident = { id: 'I', longitude: -80.26, latitude: 26.06, carriageway: CARRIAGEWAYS.EB_GENERAL };
  const queue = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, modelledMeters: 2400, upstreamResolved: true, elapsedMinutes: 18,
  });
  assert.equal(queue.clipped, false);
  assert.equal(queue.renderedMeters, 2400);
  assert.equal(queue.tail.upstreamMeters, 2400);
  assert.equal(queue.tail.upstreamKm, 2.4);
  assert.equal(queue.tail.elapsedMinutes, 18);
  assert.equal(queue.tail.simulated, true);
  // Eastbound traffic arrives from the west, so the tail is west of the incident.
  assert.ok(queue.tail.longitude < incident.longitude);
  assert.ok(queue.path.length > 1);
});

test('a westbound queue runs the other way along the same shared centerline', () => {
  const incident = { id: 'I', longitude: -80.26, latitude: 26.06, carriageway: CARRIAGEWAYS.WB_GENERAL };
  const queue = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, modelledMeters: 2400, upstreamResolved: true, elapsedMinutes: 18,
  });
  assert.equal(queue.resolved, true);
  assert.ok(queue.tail.longitude > incident.longitude, 'westbound traffic arrives from the east');
});

test('no queue is placed without a resolved approach', () => {
  const incident = { id: 'I', longitude: -80.26, latitude: 26.06, carriageway: CARRIAGEWAYS.UNKNOWN };
  const unresolvedApproach = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, modelledMeters: 2400, upstreamResolved: false,
  });
  assert.equal(unresolvedApproach.resolved, false);
  assert.equal(unresolvedApproach.tail, null, 'no tail may be placed without a direction');
  assert.match(unresolvedApproach.reason, /unresolved/i);
  // Even claiming the approach is resolved cannot rescue an unknown carriageway.
  const stillNothing = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, modelledMeters: 2400, upstreamResolved: true,
  });
  assert.equal(stillNothing.resolved, false);
});

test('the queue states that it is a corridor-axis approximation, not a lane footprint', () => {
  const incident = { id: 'I', longitude: -80.26, latitude: 26.06, carriageway: CARRIAGEWAYS.EB_GENERAL };
  const queue = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, modelledMeters: 2400, upstreamResolved: true,
  });
  assert.match(queue.approximation, /corridor-axis approximation/i);
  assert.match(queue.approximation, /not which lanes it occupies/i);
});

test('available upstream room depends on which way the traffic came', () => {
  // 5 km along a 20 km corridor: eastbound has 5 km behind it, westbound has 15 km.
  assert.equal(availableUpstreamMeters(5000, 20000, CARRIAGEWAYS.EB_GENERAL), 5000);
  assert.equal(availableUpstreamMeters(5000, 20000, CARRIAGEWAYS.WB_GENERAL), 15000);
  assert.equal(availableUpstreamMeters(5000, 20000, CARRIAGEWAYS.UNKNOWN), null);
});

test('a DMS is compared to the queue tail as geometry, never as effectiveness', () => {
  const incident = { id: 'I', longitude: -80.26, latitude: 26.06, carriageway: CARRIAGEWAYS.EB_GENERAL };
  const queue = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, modelledMeters: 2400, upstreamResolved: true, elapsedMinutes: 18,
  });
  const beyond = resourceVersusQueueTail({ resourceUpstreamMeters: 4000, queue });
  assert.equal(beyond.upstreamOfTail, true);
  assert.match(beyond.statement, /DMS lies upstream of simulated queue tail/);
  assert.match(beyond.statement, /activation unknown/i);
  assert.match(beyond.caveat, /does not establish message activation/i);

  const inside = resourceVersusQueueTail({ resourceUpstreamMeters: 900, queue });
  assert.equal(inside.upstreamOfTail, false);
  assert.match(inside.statement, /extends beyond this DMS position/);

  // Nothing to compare against is said plainly rather than answered.
  assert.equal(resourceVersusQueueTail({ resourceUpstreamMeters: null, queue }).comparable, false);
  assert.equal(resourceVersusQueueTail({ resourceUpstreamMeters: 4000, queue: null }).comparable, false);
});

test('queue geometry is deterministic across repeated calls', () => {
  const incident = { id: 'I', longitude: -80.26, latitude: 26.06, carriageway: CARRIAGEWAYS.EB_GENERAL };
  const once = simulatedQueueGeometry({ incident, centerline: CENTERLINE, modelledMeters: 2400, upstreamResolved: true });
  const twice = simulatedQueueGeometry({ incident, centerline: CENTERLINE, modelledMeters: 2400, upstreamResolved: true });
  assert.deepEqual(once, twice);
});

// ------------------------------------------------------------------ carriageway geometry

/**
 * A westbound carriageway path, built the way the workspace builds one: in TRAVEL order, which for
 * westbound means east to west. Offset north of the shared centerline so the two are tellable apart.
 */
const WB_LANE = Array.from({ length: 40 }, (_, i) => ({ lon: -80.19 - i * 0.0052, lat: 26.0625 }));

test('the queue follows the incident carriageway when its geometry is published', () => {
  const incident = { id: 'I', longitude: -80.26, latitude: 26.06, carriageway: CARRIAGEWAYS.WB_GENERAL };
  const queue = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, carriagewayPath: WB_LANE,
    modelledMeters: 2400, upstreamResolved: true, elapsedMinutes: 20,
  });
  assert.equal(queue.resolved, true);
  assert.equal(queue.onCarriageway, true, 'carriageway geometry must win over the shared centerline');
  // Drawn on the lane, not the centerline: every vertex sits at the lane latitude.
  for (const point of queue.path) assert.ok(Math.abs(point.lat - 26.0625) < 1e-6);
  assert.match(queue.approximation, /westbound carriageway sections/i);
  assert.match(queue.approximation, /not which lanes it occupies/i, 'still a length model');
});

test('upstream stays east for westbound whichever geometry is used', () => {
  const incident = { id: 'I', longitude: -80.26, latitude: 26.06, carriageway: CARRIAGEWAYS.WB_GENERAL };
  const onLane = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, carriagewayPath: WB_LANE,
    modelledMeters: 2400, upstreamResolved: true,
  });
  const onCenterline = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, modelledMeters: 2400, upstreamResolved: true,
  });
  // Westbound traffic arrives from the east, so the tail is east of the incident either way.
  assert.ok(onLane.tail.longitude > incident.longitude, 'lane path must not flip the direction');
  assert.ok(onCenterline.tail.longitude > incident.longitude);
  assert.equal(onLane.tail.upstreamMeters, onCenterline.tail.upstreamMeters, 'same length model');
});

test('an eastbound carriageway path runs the other way', () => {
  const ebLane = Array.from({ length: 40 }, (_, i) => ({ lon: -80.40 + i * 0.0052, lat: 26.0575 }));
  const incident = { id: 'I', longitude: -80.26, latitude: 26.06, carriageway: CARRIAGEWAYS.EB_GENERAL };
  const queue = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, carriagewayPath: ebLane,
    modelledMeters: 2400, upstreamResolved: true,
  });
  assert.equal(queue.onCarriageway, true);
  assert.ok(queue.tail.longitude < incident.longitude, 'eastbound traffic arrives from the west');
  assert.match(queue.approximation, /eastbound carriageway sections/i);
});

test('without carriageway geometry it falls back and says so', () => {
  const incident = { id: 'I', longitude: -80.26, latitude: 26.06, carriageway: CARRIAGEWAYS.WB_GENERAL };
  const queue = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, carriagewayPath: [],
    modelledMeters: 2400, upstreamResolved: true,
  });
  assert.equal(queue.onCarriageway, false);
  assert.match(queue.approximation, /corridor-axis approximation/i);
  assert.match(queue.approximation, /shared by both directions/i);
});

test('clipping still applies on a carriageway path', () => {
  // An incident near the upstream end of the lane has little room behind it.
  const incident = { id: 'I', longitude: WB_LANE[1].lon, latitude: 26.0625, carriageway: CARRIAGEWAYS.WB_GENERAL };
  const queue = simulatedQueueGeometry({
    incident, centerline: CENTERLINE, carriagewayPath: WB_LANE,
    modelledMeters: 9000, upstreamResolved: true,
  });
  assert.equal(queue.clipped, true);
  assert.equal(queue.modelledMeters, 9000);
  assert.ok(queue.renderedMeters < 9000);
  assert.match(queue.clipNotice, /clipped to available geometry/i);
});
