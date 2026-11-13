/**
 * Context-aware Ask the Twin for Asset Operations & Maintenance.
 *
 * The real seven cases through the real validation engine, the real evidence connectors and the
 * real claim model — so a status, a finding or an amount asserted here is the one the screen shows.
 *
 * Three things are being held:
 *
 *  1. The context is LIGHTWEIGHT and read from the application. Identifiers and derived stage
 *     statuses, never the case database, and never an id the model supplied without a lookup.
 *  2. BLOCKED is not FAILED, PENDING is not FAILED, a candidate is not a recovery, and synthetic is
 *     not production. Every one of those is a sentence the assistant must be able to say.
 *  3. Suggestions are derived. Two cases in different states never get the same four questions.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import { STAGE_STATUS } from '../src/qcqa/stageValidation.js';
import { buildDemoCases, loadDemoCases, resetDemoCases } from '../src/acs/acsDemoCases.js';
import { claimRecords, PRODUCTION_CLAIMS } from '../src/maintenance/claimsIntelligence.js';
import {
  ACTIVE_TABS, ASSET_OPS_WORKSPACE, assetOpsContextOf, assetOpsIds, caseContextOf,
  caseSuggestionsFor, contextIndicatorOf, describeAssetOps,
} from '../src/maintenance/assetOpsContext.js';
import { createCaseCapabilities, NEARBY_RADIUS_M, SYNTHETIC_NOTE, stageKeyOf } from '../src/maintenance/caseCapabilities.js';
import {
  caseCapabilityInput, caseIdIn, composeCaseAnswer, planCaseQuestion, stageIn,
} from '../src/maintenance/caseAnswers.js';
import { createDemoConnectors } from '../src/acs/evidence/connectors.js';
import { createCaseEnrichmentOrchestrator } from '../src/acs/evidence/orchestrator.js';
import { evaluateDemoCase } from '../src/acs/acsDemoCases.js';
import { buildTwinContext, describeTwinContext, isAuthorisedAction } from '../src/spatial/twinContext.js';
import { runInvestigation } from '../src/twin/orchestrator.js';
import { PROVENANCE } from '../src/twin/capabilities.js';

const fileFetcher = async path => {
  const body = await readFile(new URL(`../public/${path}`, import.meta.url), 'utf8');
  return { ok: true, json: async () => JSON.parse(body) };
};

/**
 * A register with two incidents close to each other, so "nearby" has something real to find and
 * the association rule has an asset to consider.
 */
const incidents = Array.from({ length: 12 }, (unused, index) => ({
  id: `INC-${900 + index}`, title: index === 1 ? 'Guardrail strike' : 'Vehicle collision',
  longitude: -80.4 + index * 0.02, latitude: 26.07,
  segmentName: index % 2 ? 'Central Segment' : 'East Segment',
  createdDate: '2026-10-16', related: {},
}));
// One extra incident 40 m from the first, two days later: within the default radius and window.
incidents.push({ id: 'INC-NEAR', title: 'Debris', longitude: -80.4 + 0.0004, latitude: 26.07,
  segmentName: 'East Segment', createdDate: '2026-10-18', related: { laneClosure: 'Yes' } });

const assets = new Map([['AST-1', { longitude: -80.4, latitude: 26.07, category: 'Guardrail', segment: 'East Segment' }]]);

resetDemoCases();
const records = buildDemoCases(await loadDemoCases(fileFetcher), incidents).records;
const byId = Object.fromEntries(records.map(record => [record.id, record]));
const claims = claimRecords(records);

/** The workspace adapter, with the real connectors behind it. */
const orchestrator = createCaseEnrichmentOrchestrator({
  connectors: createDemoConnectors({ maintenance: { recordsOf: () => [] } }),
  evaluate: evaluateDemoCase,
});

const adapterFor = (selectedCaseId = null, tab = 'cases') => ({
  cases: () => records,
  caseOf: id => byId[id] ?? null,
  claims: () => claims,
  claimOf: id => claims.find(claim => claim.demoCaseId === id) ?? null,
  claimsUnavailable: () => null,
  productionClaims: () => PRODUCTION_CLAIMS,
  incidents: () => incidents,
  assets: () => assets,
  recordsOf: () => [],
  selectedCaseId: () => selectedCaseId,
  positionOf: null,
  searchEvidence: record => orchestrator.search(record.demoCase, record.evaluation),
  // No network in a unit test: the weather tool is expected to report the absence, not invent one.
  readContext: null,
  tab: () => tab,
});

const contextFor = (caseId, tab = 'cases') => assetOpsContextOf({
  tab,
  selectedCaseId: caseId,
  caseContext: caseId ? caseContextOf(byId[caseId], claims.find(claim => claim.demoCaseId === caseId)) : null,
  caseCount: records.length,
  claimCount: claims.length,
  productionClaims: PRODUCTION_CLAIMS,
});

/** Run a question the way `answerAboutCase` does, so the tests exercise the real path. */
async function ask(question, caseId, tab = 'cases') {
  const screen = contextFor(caseId, tab);
  const plan = planCaseQuestion(question, screen);
  const capabilities = createCaseCapabilities(adapterFor(caseId, tab));
  const run = await runInvestigation(plan, capabilities,
    { screen: 'maintenance', assetOps: screen, capabilityInput: caseCapabilityInput(question, screen, plan) });
  return { plan, run, screen, answer: composeCaseAnswer(run, screen) };
}

/* ── Phase 1/2: the context ──────────────────────────────────────────────────────────────────── */

test('the seven cases still carry the statuses the engine gives them', () => {
  assert.equal(records.length, 7);
  assert.deepEqual(Object.fromEntries(records.map(r => [r.id, r.evaluation.presentation.label])), {
    'ACS-DEMO-001': 'Blocked at inspection',
    'ACS-DEMO-002': 'Blocked at repair',
    'ACS-DEMO-003': 'Rework required',
    'ACS-DEMO-004': 'Claim action required',
    'ACS-DEMO-005': 'Closed',
    'ACS-DEMO-006': 'Repair in progress',
    'ACS-DEMO-007': 'Awaiting claim',
  });
});

test('the case context is lightweight: identifiers and derived statuses, not the case file', () => {
  const context = contextFor('ACS-DEMO-005');
  assert.equal(context.workspace, ASSET_OPS_WORKSPACE);
  assert.equal(context.activeTab, ACTIVE_TABS.cases);
  assert.equal(context.selectedCaseId, 'ACS-DEMO-005');
  assert.equal(context.case.workflow.overall, 'CLOSED');
  // The things that would make this the case database rather than a context.
  for (const key of ['demoCase', 'evaluation', 'stages', 'findings', 'auditTrail', 'responses']) {
    assert.equal(key in context.case, false, `the context must not carry ${key}`);
  }
  assert.equal(JSON.stringify(context).length < 1600, true, 'the context must stay small');
});

test('every case says it is synthetic, in the context and in the sentences', () => {
  for (const record of records) {
    assert.equal(caseContextOf(record).isSynthetic, true);
  }
  const lines = describeAssetOps(contextFor('ACS-DEMO-001')).join('\n');
  assert.match(lines, /SYNTHETIC/);
  assert.match(lines, /did not happen/);
});

test('the workflow block carries the four stages the contract names', () => {
  const workflow = contextFor('ACS-DEMO-005').case.workflow;
  assert.deepEqual(Object.keys(workflow), ['inspection', 'repair', 'qaQc', 'claim', 'overall']);
  assert.equal(workflow.inspection, STAGE_STATUS.PASSED);
});

test('blocked is not failed: the gate is named, in the context and in the prose', () => {
  // ACS-DEMO-002 is blocked at repair. Its later stages are BLOCKED, not FAILED.
  const context = contextFor('ACS-DEMO-002');
  const blocked = Object.entries(context.case.blockedBy);
  assert.equal(blocked.length > 0, true, 'this case should have at least one blocked stage');
  for (const [, gate] of blocked) assert.ok(gate, 'a blocked stage must name its gate');
  const prose = describeAssetOps(context).join('\n');
  assert.match(prose, /BLOCKED, not failed/);
  assert.match(prose, /no findings of its own/);
});

test('with no case selected the context says so rather than inventing one', () => {
  const context = contextFor(null);
  assert.equal(context.case, null);
  assert.equal(context.selectedCaseId, null);
  assert.match(describeAssetOps(context).join('\n'), /No case is selected/);
  assert.match(describeAssetOps(context).join('\n'), /do not assume a case/i);
});

test('the context travels only on its own screen', () => {
  const screen = contextFor('ACS-DEMO-005');
  assert.equal(buildTwinContext({ screen: 'maintenance', assetOps: screen }).assetOps, screen);
  assert.equal(buildTwinContext({ screen: 'tmc', assetOps: screen }).assetOps, null);
  assert.match(describeTwinContext(buildTwinContext({ screen: 'maintenance', assetOps: screen })),
    /Asset Operations & Maintenance is open/);
});

test('only identifiers the workspace offered can be acted on', () => {
  const screen = contextFor('ACS-DEMO-005');
  const ids = assetOpsIds(screen);
  assert.ok(ids.includes('ACS-DEMO-005'));
  const context = buildTwinContext({ screen: 'maintenance', assetOps: screen });
  const allowed = new Set(['VIEW_CASE_ON_MAP']);
  assert.equal(isAuthorisedAction({ type: 'VIEW_CASE_ON_MAP', entityId: 'ACS-DEMO-005' }, context, allowed), true);
  // An id the model composed matches nothing the context offered.
  assert.equal(isAuthorisedAction({ type: 'VIEW_CASE_ON_MAP', entityId: 'ACS-DEMO-999' }, context, allowed), false);
  // A type outside the vocabulary is refused whatever it points at.
  assert.equal(isAuthorisedAction({ type: 'CLOSE_CASE', entityId: 'ACS-DEMO-005' }, context, allowed), false);
});

/* ── Phase 7: suggestions ────────────────────────────────────────────────────────────────────── */

test('suggestions are derived, and no two differently-placed cases share them', () => {
  const sets = new Map(records.map(record => [record.id, caseSuggestionsFor(contextFor(record.id))]));
  for (const [id, suggestions] of sets) {
    assert.equal(suggestions.length, 4, `${id} should offer four questions`);
  }
  assert.match(sets.get('ACS-DEMO-001').join(' '), /inspection/i);
  assert.match(sets.get('ACS-DEMO-003').join(' '), /criteria|checks|reinspection/i);
  assert.deepEqual([...sets.get('ACS-DEMO-005')][0], 'Summarize the complete case.');
  // The closed case and a blocked one must not be offered the same list.
  assert.notDeepEqual(sets.get('ACS-DEMO-005'), sets.get('ACS-DEMO-001'));
});

test('a stage blocked by an earlier failure is offered the failing stage’s questions', () => {
  // ACS-DEMO-002 is held at repair; the FAILED stage is what the operator needs to act on.
  const context = contextFor('ACS-DEMO-002');
  const failed = Object.entries(context.case.workflow)
    .find(([, status]) => status === STAGE_STATUS.FAILED);
  const suggestions = caseSuggestionsFor(context).join(' ').toLowerCase();
  if (failed) assert.match(suggestions, new RegExp(failed[0].replace('qaQc', 'q')));
});

test('the claims subtab asks about claims, with nothing selected', () => {
  const suggestions = caseSuggestionsFor(contextFor(null, 'claims'));
  assert.match(suggestions.join(' '), /claims/i);
  assert.equal(contextIndicatorOf(contextFor(null, 'claims')), `Claims Intelligence · ${claims.length} claims · none selected`);
});

test('the indicator is the case’s own three facts', () => {
  assert.equal(contextIndicatorOf(contextFor('ACS-DEMO-005')),
    `ACS-DEMO-005 · ${byId['ACS-DEMO-005'].demoCase.asset.assetType} · Closed`);
  assert.equal(contextIndicatorOf(contextFor(null, 'operations')), 'Operations Overview');
});

/* ── Phase 8: parsing ────────────────────────────────────────────────────────────────────────── */

test('a case id is read out of a question, and nothing else is', () => {
  assert.equal(caseIdIn('Why did inspection fail for ACS-DEMO-001?'), 'ACS-DEMO-001');
  assert.equal(caseIdIn('why did inspection fail for acs-demo-003'), 'ACS-DEMO-003');
  assert.equal(caseIdIn('Why did inspection fail for case 12?'), null);
  assert.equal(caseIdIn('DROP TABLE cases'), null);
});

test('a stage is read where the question names one', () => {
  assert.equal(stageIn('which QA/QC criteria failed?'), 'QCQA');
  assert.equal(stageIn('why did the inspection fail?'), 'INSPECTION');
  assert.equal(stageIn('why did repair validation fail?'), 'REPAIR');
  assert.equal(stageIn('is it ready for claim submission?'), 'CLAIM');
  assert.equal(stageIn('summarize the case'), null);
  assert.equal(stageKeyOf('qa/qc'), 'QCQA');
  assert.equal(stageKeyOf('nonsense'), null);
});

test('planning is additive: a two-clause question keeps both clauses', async () => {
  const screen = contextFor('ACS-DEMO-001');
  const plan = planCaseQuestion('Why did inspection fail and what evidence is missing?', screen);
  assert.ok(plan.includes('get_case_validation'));
  assert.ok(plan.includes('get_case_evidence'));
});

test('a question with no case and nothing selected plans nothing about a case', () => {
  const plan = planCaseQuestion('Why did inspection fail?', contextFor(null));
  assert.deepEqual(plan, []);
});

/* ── Phase 11: the acceptance questions, against the real engines ────────────────────────────── */

test('1. why inspection failed for ACS-DEMO-001', async () => {
  const { answer, run } = await ask('Why did inspection fail?', 'ACS-DEMO-001');
  assert.equal(run.results.get_case_validation.status, 'ok');
  assert.match(answer, /Inspection: FAILED/);
  assert.match(answer, /SYNTHETIC|synthetic/);
  assert.match(answer, /Corrective action:/);
});

test('2. why repair failed for ACS-DEMO-002, without calling a blocked stage failed', async () => {
  const { answer } = await ask('Why did repair validation fail?', 'ACS-DEMO-002');
  // The question named one stage, so one stage is reported — on its own findings.
  assert.match(answer, /Repair: FAILED/);
  assert.match(answer, /MISSING/);
  // Asked about the whole case, the stages repair holds up are reported as held, never as failed.
  const { answer: whole } = await ask('Which stages passed and which are blocked?', 'ACS-DEMO-002');
  assert.match(whole, /BLOCKED — held by the REPAIR stage/);
  assert.doesNotMatch(whole, /QC\/QA: FAILED/);
});

test('3. which QA/QC criteria failed for ACS-DEMO-003', async () => {
  const { answer, run } = await ask('Which QA/QC criteria failed?', 'ACS-DEMO-003');
  const stages = run.results.get_case_validation.data.stages;
  assert.deepEqual(stages.map(stage => stage.key), ['QCQA'], 'the question named one stage');
  assert.match(answer, /QC\/QA: FAILED/);
});

test('4. why claim validation failed for ACS-DEMO-004', async () => {
  const { answer, run } = await ask('Why did claim validation fail?', 'ACS-DEMO-004');
  assert.equal(run.results.get_case_validation.status, 'ok');
  assert.match(answer, /Claim: FAILED/);
});

test('5. the closed ACS-DEMO-005 summarises, and claims nothing outstanding', async () => {
  const { answer, run } = await ask('Summarize the complete case.', 'ACS-DEMO-005');
  assert.equal(run.results.get_case_summary.data.overall, 'CLOSED');
  assert.match(answer, /ACS-DEMO-005/);
  assert.match(answer, /Nothing outstanding/);
});

test('6. what remains to complete ACS-DEMO-006', async () => {
  const { plan, answer } = await ask('What remains to complete this case?', 'ACS-DEMO-006');
  assert.ok(plan.includes('get_case_summary'));
  assert.match(answer, /Next action:/);
  // A stage that is merely unfinished is PENDING or IN PROGRESS, never reported as a failure.
  assert.doesNotMatch(answer, /Repair: FAILED/);
});

test('7. whether ACS-DEMO-007 is ready for claim submission', async () => {
  const { answer, run } = await ask('Is this case ready for claim submission?', 'ACS-DEMO-007');
  assert.equal(run.results.get_case_claim.status, 'ok');
  // Nothing has been raised yet, so the claim has no reference and nothing is reported as claimed.
  assert.match(answer, /Claim \(no reference\) — Pending/);
  assert.match(answer, /claimed not recorded/);
  assert.match(answer, /No insurer|nobody rejected/i);
});

test('8. searching for missing evidence proposes candidates and recovers nothing', async () => {
  const { answer, run } = await ask('Can you find the missing inspection records?', 'ACS-DEMO-001');
  const data = run.results.search_missing_evidence.data;
  assert.ok(data.searches.length >= 1);
  // Every candidate is unverified and needs a person. Not one of them is a recovery.
  for (const gap of data.gaps) {
    for (const candidate of gap.candidates) {
      assert.equal(candidate.verification, 'UNVERIFIED_CANDIDATE');
      assert.equal(candidate.requiresHumanReview, true);
    }
  }
  assert.match(answer, /Nothing has been attached/);
  assert.match(run.limitations.join('\n'), /does NOT make a failed inspection or QC\/QA stage pass/);
  // And the stage is still exactly what the engine said before the search.
  assert.equal(byId['ACS-DEMO-001'].evaluation.statuses.INSPECTION, STAGE_STATUS.FAILED);
});

test('8b. an unavailable source is SOURCE_UNAVAILABLE, not "nothing found"', async () => {
  const { run } = await ask('Search Office Track for the missing records.', 'ACS-DEMO-001');
  const data = run.results.search_missing_evidence.data;
  const synthetic = data.searches.filter(search => search.origin === 'SYNTHETIC');
  assert.ok(synthetic.length >= 1, 'the stand-in connectors must declare themselves synthetic');
  assert.match(run.limitations.join('\n'), /no endpoint or credentials/);
});

test('9. weather provenance is reported rather than guessed when no service is reachable', async () => {
  const { run } = await ask('What was the weather at the incident?', 'ACS-DEMO-001');
  const result = run.results.get_incident_weather;
  // No weather service is wired into the unit-test adapter, so this must report the absence.
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /context service is not available/);
});

test('10. traffic is identified as unavailable or synthetic, never as a measurement', async () => {
  // The traffic tool needs the context service too; the point here is the declared position.
  const { run } = await ask('What was the traffic like at the time?', 'ACS-DEMO-001');
  assert.equal(run.results.get_incident_traffic.status, 'unavailable');
  const { TRAFFIC_AVAILABILITY } = await import('../src/acs/incidentContext.js');
  assert.equal(TRAFFIC_AVAILABILITY.historicalSpeed, false);
  assert.equal(TRAFFIC_AVAILABILITY.historicalCongestion, false);
  assert.equal(TRAFFIC_AVAILABILITY.historicalVolume, false);
  assert.match(TRAFFIC_AVAILABILITY.note, /FL511 publishes current events only/);
});

/* ── the rest of the tool layer ──────────────────────────────────────────────────────────────── */

test('nearby incidents are matched on day, not on an invented timestamp', async () => {
  const { run } = await ask('Were there other incidents nearby?', 'ACS-DEMO-001');
  const result = run.results.get_nearby_incidents;
  assert.equal(result.status, 'ok');
  assert.equal(result.data.radiusM, NEARBY_RADIUS_M);
  assert.ok(result.data.windowDays >= 1);
  assert.match(result.limitations.join('\n'), /records the DAY an incident happened/);
  assert.match(result.limitations.join('\n'), /does not establish/);
  for (const entry of result.data.incidents) assert.match(entry.matchedOn, /within \d+ m/);
});

test('related assets keep confirmed links apart from spatial candidates', async () => {
  const { run } = await ask('Which asset is related to this case?', 'ACS-DEMO-001');
  const data = run.results.get_related_assets.data;
  assert.equal(data.namedAsset.inRegistry, false, 'a synthetic asset is not in the registry');
  assert.match(run.results.get_related_assets.limitations.join('\n'), /proximity only/);
  if (data.sourceIncidentAsset) {
    assert.ok(['CONFIRMED', 'CANDIDATE', 'INFERRED'].includes(data.sourceIncidentAsset.relationship));
  }
});

test('a case’s audit trail is read from the case and labelled invented', async () => {
  const { run } = await ask('Show the audit history.', 'ACS-DEMO-005');
  const result = run.results.get_case_activity;
  assert.equal(result.status, 'ok');
  assert.equal(result.data.total, byId['ACS-DEMO-005'].demoCase.auditTrail.length);
  assert.match(result.limitations.join('\n'), /invented for the demonstration/);
});

test('the five claim figures stay five figures, and null is not zero', async () => {
  const { run } = await ask('What has been claimed and recovered?', 'ACS-DEMO-007');
  const financial = run.results.get_case_claim.data.financial;
  for (const key of ['estimatedUSD', 'claimedUSD', 'approvedUSD', 'recoveredUSD', 'outstandingUSD']) {
    assert.ok(key in financial, `${key} must be stated separately`);
  }
  // A claim with nothing recovered reports an em dash, never $0.
  const unrecovered = claims.find(claim => claim.recoveredUSD == null);
  if (unrecovered) {
    const { run: other } = await ask('What has been recovered?', unrecovered.demoCaseId);
    assert.equal(other.results.get_case_claim.data.financial.formatted.recovered, '—');
  }
});

test('claims totals are demonstration money and say so', async () => {
  const { answer, run } = await ask('What is the total recovered amount?', null, 'claims');
  const result = run.results.get_claims_summary;
  assert.equal(result.status, 'ok');
  assert.equal(result.data.counts.total, claims.length);
  assert.equal(result.data.productionClaims.available, false);
  assert.match(result.limitations.join('\n'), /NOT\s*\n?\s*corridor financial exposure|NOT corridor financial exposure/);
  assert.match(answer, /demonstration claims/);
});

test('pending claims are searched by status, not guessed', async () => {
  const { run } = await ask('Which claims are still pending?', null, 'claims');
  const result = run.results.search_claims;
  assert.equal(result.status, 'ok');
  assert.equal(result.filtersApplied.status, 'PENDING');
  for (const claim of result.data.claims) assert.equal(claim.status, 'PENDING');
});

test('an unknown case id is refused with what the screen actually holds', async () => {
  const capabilities = createCaseCapabilities(adapterFor(null));
  const result = capabilities.get_case_summary.handler({ caseId: 'ACS-DEMO-999' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /no case ACS-DEMO-999/);
  assert.match(result.reason, /ACS-DEMO-001/);
});

test('a stale selection, with the case gone, is refused rather than answered', () => {
  const empty = { ...adapterFor('ACS-DEMO-001'), caseOf: () => null, cases: () => [] };
  const result = createCaseCapabilities(empty).get_case_summary.handler({});
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /no case ACS-DEMO-001/);
});

test('an invalid stage is refused, not silently answered about all four', () => {
  const result = createCaseCapabilities(adapterFor('ACS-DEMO-001'))
    .get_case_validation.handler({ stage: 'procurement' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.reason, /not one of the four stages/);
});

test('every case capability is read-only and declares its screen', () => {
  const capabilities = createCaseCapabilities(adapterFor('ACS-DEMO-001'));
  const expected = ['get_case_summary', 'get_case_validation', 'get_case_evidence',
    'get_case_activity', 'get_case_claim', 'search_cases', 'search_missing_evidence',
    'get_incident_weather', 'get_incident_traffic', 'get_nearby_incidents', 'get_related_assets',
    'search_claims', 'get_claims_summary', 'get_operations_overview'];
  assert.deepEqual(Object.keys(capabilities).sort(), [...expected].sort());
  for (const [name, capability] of Object.entries(capabilities)) {
    assert.equal(capability.readOnly, true, `${name} must be read-only`);
    assert.deepEqual(capability.screens, ['maintenance'], `${name} must declare its screen`);
    // Nothing in the vocabulary may change a record.
    assert.doesNotMatch(name, /approve|submit|close|attach|update|write|delete|set_/);
  }
});

test('a case answer never hands back a bare provenance: synthetic is stated and limitations travel', async () => {
  const { answer, run } = await ask('Summarize the complete case.', 'ACS-DEMO-003');
  assert.match(answer, /^ACS-DEMO-003 is synthetic demonstration data/);
  assert.match(answer, /Limitations/);
  assert.ok([PROVENANCE.SIMULATED, PROVENANCE.MIXED].includes(run.provenance));
  assert.match(run.limitations.join('\n'), new RegExp(SYNTHETIC_NOTE.slice(0, 40)));
});

test('a step that could not run is reported, not dropped', async () => {
  const { answer } = await ask('What was the weather, and summarize the case?', 'ACS-DEMO-001');
  assert.match(answer, /Could not be answered:/);
  assert.match(answer, /get_incident_weather/);
});

/* ── the queue: every suggested question must have a capability behind it ────────────────────── */

test('a queue question is answered about the queue, not about the selected case', async () => {
  // With a case selected, "Which cases are closed?" is still a question about the SET. Answering it
  // with that case's detail is how the assistant starts replying to a question nobody asked.
  const { plan, run, answer } = await ask('Which cases are closed?', 'ACS-DEMO-001');
  assert.deepEqual(plan, ['search_cases']);
  const data = run.results.search_cases.data;
  assert.equal(data.counts.closed, 1);
  assert.deepEqual(data.cases.map(row => row.caseId), ['ACS-DEMO-005']);
  assert.match(answer, /1 of 7 ACS case\(s\) match/);
  assert.doesNotMatch(answer, /ACS-DEMO-001 —/);
});

test('each queue bucket is read from the question, and “needs action” is not “waiting”', async () => {
  const action = await ask('Which cases need action?', null);
  assert.equal(action.run.results.search_cases.filtersApplied.bucket, 'action');
  const progress = await ask('Which cases are in progress?', null);
  assert.equal(progress.run.results.search_cases.filtersApplied.bucket, 'progress');
  // A case merely waiting is never counted as needing action.
  const counts = action.run.results.search_cases.data.counts;
  assert.equal(counts.action + counts.progress + counts.closed, counts.all);
  assert.match(action.run.results.search_cases.limitations.join('\n'), /nobody is late/);
});

test('“which stage holds up the most cases” is counted, not written down', async () => {
  const { run } = await ask('Which stage holds up the most cases?', null);
  const byStage = run.results.search_cases.data.byBlockingStage;
  assert.ok(byStage.length > 0);
  for (let i = 1; i < byStage.length; i += 1) assert.ok(byStage[i - 1].count >= byStage[i].count);
  const held = records.filter(record => record.evaluation.overall !== 'CLOSED').length;
  assert.equal(byStage.reduce((total, entry) => total + entry.count, 0), held);
});

test('every suggested question plans at least one capability', () => {
  const screens = [contextFor(null, 'cases'), contextFor(null, 'claims'), contextFor(null, 'operations'),
    ...records.map(record => contextFor(record.id))];
  for (const screen of screens) {
    for (const question of caseSuggestionsFor(screen)) {
      const plan = planCaseQuestion(question, screen);
      assert.ok(plan.length > 0,
        `"${question}" (${screen.activeTab}, case ${screen.selectedCaseId ?? 'none'}) plans nothing`);
    }
  }
});

test('a per-case question still reaches the case when the queue rules do not fire', async () => {
  for (const question of ['Why did inspection fail?', 'Summarize the complete case.',
    'What evidence is missing?', 'Is this case ready for claim submission?',
    'What is the next required action?', 'Show the audit history.']) {
    const plan = planCaseQuestion(question, contextFor('ACS-DEMO-001'));
    assert.ok(plan.length > 0, `"${question}" plans nothing`);
    assert.ok(!plan.includes('search_cases'), `"${question}" is about one case, not the queue`);
  }
});

test('Operations Overview answers from the corridor’s records, and excludes the synthetic cases', async () => {
  const { run, answer } = await ask('How many incidents are linked to a corridor asset?', null, 'operations');
  const result = run.results.get_operations_overview;
  assert.equal(result.status, 'ok');
  assert.equal(result.data.incidents, incidents.length);
  // Seven synthetic cases exist; not one of them is in this count.
  assert.equal(result.data.kpis.find(kpi => kpi.id === 'totalIncidents').value, incidents.length);
  assert.match(result.limitations.join('\n'), /seven synthetic ACS cases are NOT counted/);
  assert.match(result.limitations.join('\n'), /proximity only/);
  // An absent figure is reported as unavailable with the reason, never as zero.
  const missing = result.data.kpis.find(kpi => kpi.id === 'missingEvidence');
  assert.equal(missing.available, false);
  assert.equal(missing.value, null);
  assert.match(answer, /not available/);
});
