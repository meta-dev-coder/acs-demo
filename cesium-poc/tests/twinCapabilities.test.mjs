/**
 * The capability registry and the investigation orchestrator.
 *
 * The behaviour these pin, in order of how badly it would hurt to lose:
 *
 *   1. A compound question is not answered by its first clause alone. That was the actual defect:
 *      "why is this high risk, and which patrol should respond?" answered the risk and silently
 *      discarded the patrol question.
 *   2. Simulated output is never labelled observed, and a mixed result is labelled mixed.
 *   3. "Could not look" is never reported as "nothing there".
 *   4. One failing or slow capability does not lose the others.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  capabilityAvailable, createCapabilityRegistry, ok, PROVENANCE, unavailable,
} from '../src/twin/capabilities.js';
import {
  isCompoundQuestion, ORCHESTRATION_LIMITS, planFor, runInvestigation,
} from '../src/twin/orchestrator.js';

const INCIDENT_MS = Date.parse('2026-10-01T06:21:00Z');

const tmcDouble = (overrides = {}) => ({
  selectedIncidentId: 'FL511-INCIDENT-882157',
  temporal: { mode: 'HISTORICAL', date: '2026-10-01' },
  assessment: { assessments: [{
    incident: { id: 'FL511-INCIDENT-882157', sectionLabel: 'Westbound Section 02', carriageway: 'WB_GENERAL', severity: 'Minor' },
    risk: {
      score: 29, level: 'LOW', levelLabel: 'Low',
      confidence: { level: 'HIGH', label: 'High', evaluated: 9, unknown: 0 },
      contributors: [{ type: 'LANE_CLOSURE', label: 'Lane closure', detail: '1 lane blocked', contribution: 18 }],
      neutralFactors: [], unknownFactors: [],
      unavailableFactors: [{ type: 'QUEUE_LENGTH', label: 'Queue length', reason: 'Not available' }],
      weatherState: 'available',
    },
  }] },
  upstreamProtection: {
    incidentId: 'FL511-INCIDENT-882157', incidentTimestamp: INCIDENT_MS,
    upstreamResolution: { resolved: true, reason: null }, upstreamSections: [{ sectionLabel: 'Westbound Section 03' }],
    trafficObservationStatus: 'NOT_OBSERVED', traffic: { detail: 'No congestion reported' },
    queueObservationStatus: 'UNAVAILABLE', queue: { detail: 'Not published' },
    nearestDms: { id: '168189', upstreamMiles: 0.1 }, nearestCamera: { id: '5014', upstreamMiles: 0.2 },
    warningActivationStatus: 'UNKNOWN', warningActivation: { detail: 'No activation records' },
    dataConfidence: { level: 'MEDIUM', label: 'Medium', known: 2, total: 4 },
  },
  patrolScenario: {
    incident: { id: 'FL511-INCIDENT-882157' }, anchorMs: INCIDENT_MS,
    availability: { total: 6, available: 4, busy: 1, outOfService: 1, engaged: 0 },
    eligible: [{ patrol: { id: 'SIM-RR-04' }, travelSeconds: 180, route: { distanceMeters: 3600, confidence: 'APPROXIMATE' } }],
    options: [
      { patrol: { id: 'SIM-RR-04' }, eligible: true, travelSeconds: 180, route: { distanceMeters: 3600, confidence: 'APPROXIMATE' } },
      { patrol: { id: 'SIM-RR-02' }, eligible: false, ineligibleReason: 'Patrol is past the incident' },
    ],
    suggested: { patrol: { id: 'SIM-RR-04' }, travelSeconds: 180, route: { distanceMeters: 3600, confidence: 'APPROXIMATE' } },
  },
  warningScenario: {
    resolved: true, earlierByMinutes: 6, queueModelUnchanged: true,
    scenarioA: { delayMinutes: 10, simulatedQueueMiles: 0.87 },
    scenarioB: { delayMinutes: 4, simulatedQueueMiles: 0.42 },
  },
  ...overrides,
});

const WORK_ORDERS = [
  { id: 'WO-1', title: 'Replace lamp', status: 'Open', priority: 'High', assetId: 'A-1' },
  { id: 'WO-2', title: 'Inspect cabinet', status: 'Closed', assetId: 'A-1' },
  { id: 'WO-3', title: 'Clean lens', status: 'In progress', assetId: 'A-2' },
];
const registryFor = (tmc = tmcDouble(), lookup = null) => createCapabilityRegistry({
  tmc,
  maintenanceRecords: lookup ?? (type => (type === 'workOrder' ? WORK_ORDERS : [])),
});
const contextFor = (tmc = tmcDouble()) => ({
  screen: 'tmc',
  tmc: { selectedIncidentId: tmc.selectedIncidentId, mode: tmc.temporal?.mode ?? null },
});

// ───────────────────────────────────────────────────── the defect this exists for

test('a compound question plans every clause, not just the first', () => {
  const question = 'Why is this incident high risk, which upstream resources are available, '
    + 'and what would change if we dispatched a Road Ranger five minutes earlier?';
  const plan = planFor(question);
  assert.deepEqual(plan, [
    'get_incident_analysis', 'analyze_upstream_protection',
    'get_patrol_response_options', 'compare_response_scenarios',
  ]);
  assert.equal(isCompoundQuestion(question), true);
});

test('a single-clause question is not inflated into an investigation', () => {
  assert.equal(isCompoundQuestion('Why is this incident high risk?'), false);
  assert.deepEqual(planFor('Why is this incident high risk?'), ['get_incident_analysis']);
});

test('a question matching nothing produces an empty plan rather than a guess', () => {
  assert.deepEqual(planFor('What is a DMS?'), []);
  assert.equal(isCompoundQuestion('What is a DMS?'), false);
});

test('the whole compound investigation runs end to end', async () => {
  const registry = registryFor();
  const question = 'Why is this high risk, which upstream resources are available, and what if we dispatched 5 minutes earlier?';
  const run = await runInvestigation(planFor(question), registry, contextFor());
  assert.equal(run.steps.filter(step => step.status === 'ok').length, 4, 'all four clauses answered');
  assert.equal(run.grounded, true);
  assert.equal(run.results.get_incident_analysis.data.score, 29);
  assert.equal(run.results.analyze_upstream_protection.data.nearestDms.id, '168189');
  assert.equal(run.results.get_patrol_response_options.data.suggested, 'SIM-RR-04');
  assert.ok(run.results.compare_response_scenarios.data.warning.earlierByMinutes === 6);
});

// ───────────────────────────────────────────────────── provenance

test('simulated results are never labelled observed', async () => {
  const registry = registryFor();
  const run = await runInvestigation(['get_patrol_response_options', 'compare_response_scenarios'],
    registry, contextFor());
  for (const name of ['get_patrol_response_options', 'compare_response_scenarios']) {
    assert.equal(run.results[name].provenance, PROVENANCE.SIMULATED, name);
    assert.ok(run.results[name].limitations.some(line => /SIMULATED|hypothetical/i.test(line)));
  }
});

test('an investigation mixing observed and simulated is labelled mixed', async () => {
  const run = await runInvestigation(['get_incident_analysis', 'get_patrol_response_options'],
    registryFor(), contextFor());
  assert.equal(run.results.get_incident_analysis.provenance, PROVENANCE.OBSERVED);
  assert.equal(run.provenance, PROVENANCE.MIXED, 'the investigation as a whole is mixed');
});

test('upstream protection is mixed in itself, because its own parts differ', async () => {
  const run = await runInvestigation(['analyze_upstream_protection'], registryFor(), contextFor());
  const result = run.results.analyze_upstream_protection;
  assert.equal(result.provenance, PROVENANCE.MIXED);
  assert.equal(result.data.queue.status, 'UNAVAILABLE');
  assert.equal(result.data.warningActivation.status, 'UNKNOWN');
  assert.ok(result.limitations.some(line => /does not establish that it displayed a warning/i.test(line)));
});

test('no capability claims a crash probability or a clearance saving', async () => {
  const run = await runInvestigation(planFor('why high risk, patrol, what if earlier'), registryFor(), contextFor());
  const text = JSON.stringify(run).toLowerCase();
  // Testing for the HARM, not the words: the disclaimers legitimately contain "crash probability"
  // precisely to say there isn't one, so a substring ban would fail on its own safeguard. What
  // must never appear is a NUMBER attached to such a claim.
  for (const claim of [
    /\d+\s*(%|percent)[^.]{0,30}(fewer|reduction|reduced|prevent)/,
    /\d+\s+(crash|collision)\w*\s+(prevented|avoided|saved)/,
    /(probability|likelihood)\s+(of\s+)?(a\s+)?(crash|collision)\w*\s+(is|was|=|:)\s*\d/,
    /clearance[^.]{0,20}(saved|reduced by)\s*\d/,
  ]) {
    assert.ok(!claim.test(text), `must not make a quantified claim matching ${claim}`);
  }
  // And the safeguards themselves must be present.
  assert.ok(run.limitations.some(line => /not a crash probability/i.test(line)));
  assert.ok(run.limitations.some(line => /does NOT shorten the queue/i.test(line)));
  assert.ok(run.limitations.some(line => /not estimated/i.test(line)));
});

// ───────────────────────────────────────────────────── availability vs emptiness

test('"could not look" is distinct from "nothing there"', async () => {
  // No work-order class loaded at all.
  const registry = createCapabilityRegistry({ tmc: tmcDouble(), maintenanceRecords: () => [] });
  const run = await runInvestigation(['search_work_orders'], registry, contextFor());
  assert.equal(run.results.search_work_orders.status, 'unavailable');
  assert.match(run.results.search_work_orders.reason, /not loaded/i);

  // Loaded, but nothing matches: that is a real answer with status ok.
  const empty = await runInvestigation(['search_work_orders'],
    registryFor(tmcDouble(), type => (type === 'workOrder' ? WORK_ORDERS : [])),
    { ...contextFor(), capabilityInput: { search_work_orders: { assetId: 'A-999' } } });
  assert.equal(empty.results.search_work_orders.status, 'ok');
  assert.equal(empty.results.search_work_orders.data.total, 0);
});

test('overdue is never inferred when no due date is published', async () => {
  const run = await runInvestigation(['search_work_orders'], registryFor(), contextFor());
  const result = run.results.search_work_orders;
  assert.equal(result.data.total, 2, 'two open work orders');
  assert.ok(result.limitations.some(line => /overdue status cannot be determined/i.test(line)));
  assert.ok(!JSON.stringify(result.data).includes('overdue'));
});

test('a capability needing a selection refuses when there is none', async () => {
  const tmc = tmcDouble({ selectedIncidentId: null, assessment: { assessments: [] } });
  const run = await runInvestigation(['get_incident_analysis'], registryFor(tmc),
    { screen: 'tmc', tmc: { selectedIncidentId: null, mode: 'HISTORICAL' } });
  assert.equal(run.steps[0].status, 'unavailable');
  assert.match(run.steps[0].reason, /No incident is selected/);
  assert.ok(run.limitations.some(line => /No incident is selected/.test(line)));
});

test('a historical-only capability is refused in live mode', () => {
  const registry = registryFor();
  const { available, reason } = capabilityAvailable(registry.get_patrol_response_options,
    { screen: 'tmc', tmc: { selectedIncidentId: 'X', mode: 'LIVE' } });
  assert.equal(available, false);
  assert.match(reason, /historical date only/i);
});

test('a TMC capability is refused on another screen', () => {
  const { available, reason } = capabilityAvailable(registryFor().get_incident_analysis,
    { screen: 'maintenance', tmc: null });
  assert.equal(available, false);
  assert.match(reason, /tmc screen/i);
});

// ───────────────────────────────────────────────────── robustness

test('one failing capability does not lose the others', async () => {
  const registry = {
    ...registryFor(),
    broken: { name: 'broken', screens: ['*'], requires: [], handler() { throw new Error('boom'); } },
  };
  const run = await runInvestigation(['broken', 'get_incident_analysis'], registry, contextFor());
  assert.equal(run.steps[0].status, 'error');
  assert.equal(run.steps[1].status, 'ok', 'the next step still ran');
  assert.equal(run.results.get_incident_analysis.data.score, 29);
  assert.ok(run.limitations.some(line => /broken: failed to run/.test(line)));
});

test('a hanging capability times out without hanging the investigation', async () => {
  const registry = {
    ...registryFor(),
    slow: { name: 'slow', screens: ['*'], requires: [], handler: () => new Promise(() => {}) },
  };
  const run = await runInvestigation(['slow', 'get_incident_analysis'], registry, contextFor(),
    { limits: { ...ORCHESTRATION_LIMITS, perStepTimeoutMs: 40 } });
  assert.equal(run.steps[0].status, 'timeout');
  assert.equal(run.steps[1].status, 'ok');
});

test('a capability runs once per investigation', async () => {
  let calls = 0;
  const registry = {
    counted: { name: 'counted', screens: ['*'], requires: [], handler() { calls++; return ok({ data: {} }); } },
  };
  const run = await runInvestigation(['counted', 'counted', 'counted'], registry, contextFor());
  assert.equal(calls, 1);
  assert.equal(run.steps.filter(step => step.status === 'skipped').length, 2);
});

test('a plan is capped at the step limit', () => {
  const everything = 'why risk upstream dms patrol dispatch what if earlier work order asset history repeated';
  assert.ok(planFor(everything).length <= ORCHESTRATION_LIMITS.maxSteps);
});

test('an unknown capability name is reported, not silently dropped', async () => {
  const run = await runInvestigation(['no_such_thing'], registryFor(), contextFor());
  assert.equal(run.steps[0].status, 'unknown');
  assert.equal(run.grounded, false);
});

test('every step is accounted for in the trace', async () => {
  const traced = [];
  await runInvestigation(['get_incident_analysis', 'no_such_thing'], registryFor(), contextFor(),
    { trace: entry => traced.push(entry) });
  assert.equal(traced.length, 1);
  assert.equal(traced[0].steps.length, 2, 'a trace covers every planned step');
  // The trace carries durations and record counts, not record contents.
  assert.ok(Number.isFinite(traced[0].steps[0].ms));
  assert.ok(!JSON.stringify(traced[0]).includes('Westbound Section 02'));
});

// ───────────────────────────────────────────────────── result shape

test('results carry evidence with real record identifiers', async () => {
  const run = await runInvestigation(['get_incident_analysis', 'get_asset_history'], registryFor(),
    { ...contextFor(), capabilityInput: { get_asset_history: { assetId: 'A-1' } } });
  const risk = run.results.get_incident_analysis;
  assert.equal(risk.evidence[0].entityId, 'FL511-INCIDENT-882157');
  assert.equal(risk.evidence[0].source, 'DataConnect');
  const history = run.results.get_asset_history;
  assert.equal(history.data.total, 2, 'two records name asset A-1');
  assert.ok(history.evidence.every(item => item.entityId));
  assert.ok(history.limitations.some(line => /nothing is inferred from proximity/i.test(line)));
});

test('actions are offered once even when two capabilities suggest the same one', async () => {
  const registry = {
    a: { name: 'a', screens: ['*'], requires: [], handler: () => ok({ data: {}, actions: [{ type: 'SHOW_PATROLS' }] }) },
    b: { name: 'b', screens: ['*'], requires: [], handler: () => ok({ data: {}, actions: [{ type: 'SHOW_PATROLS' }] }) },
  };
  const run = await runInvestigation(['a', 'b'], registry, contextFor());
  assert.equal(run.actions.length, 1);
});

test('the unavailable helper never masquerades as an empty success', () => {
  const result = unavailable('No data loaded.');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.provenance, PROVENANCE.UNAVAILABLE);
  assert.equal(result.data, null);
});
