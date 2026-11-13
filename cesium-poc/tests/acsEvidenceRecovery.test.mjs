/**
 * Evidence recovery and incident-time context.
 *
 * The cases the brief asks for are all here: a system that does not answer, evidence that
 * contradicts itself, a timestamp that does not line up, an ambiguous asset, missing historical
 * traffic, and a successful re-validation. So are the safety rules, which matter more than any of
 * them — nothing auto-passes a failed measurement, nothing overwrites an original record, and
 * nothing submits a claim.
 */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDemoCases, evaluateDemoCase, recoveryOutlook, withAttachments,
} from '../src/acs/acsDemoCases.js';
import {
  AUDIT_EVENTS, buildAttachments, createCaseEnrichmentOrchestrator, evidenceTypeOf,
  missingEvidence, searchForEvidence, validationDelta,
} from '../src/acs/evidence/orchestrator.js';
import {
  MATCH_RULES, MATCH_TIER, TIER_THRESHOLDS, maxCircumstantialScore, rankCandidates,
  scoreCandidate, warningsFor,
} from '../src/acs/evidence/matching.js';
import {
  ORIGIN, SEARCH_STATUS, SYSTEMS, apiConnector, assertConnector, createDataConnectConnector,
  createDemoConnectors, createSyntheticConnector,
} from '../src/acs/evidence/connectors.js';
import { createAuditLog } from '../src/acs/evidence/auditLog.js';
import {
  DATA_QUALITY, OBSERVATION_SOURCE, SPATIAL_MATCH, TRAFFIC_AVAILABILITY, annualAverage,
  congestionBand, corridorHour, createIncidentContextService, diurnalFactor,
  operationalImplications, registerFacts, syntheticTraffic, weatherObservations,
  weatherProvenance,
} from '../src/acs/incidentContext.js';
import { STAGE_STATUS, STATUS } from '../src/qcqa/stageValidation.js';

const payload = JSON.parse(await readFile(new URL('../public/data/acs-demo-cases.json', import.meta.url), 'utf8'));

const register = (count = 40) => Array.from({ length: count }, (unused, index) => ({
  id: `INC-${1000 + index}`,
  latitude: 26.06 + index * 0.0005,
  longitude: -80.35 + index * 0.004,
  segmentName: `${index % 2 ? 'I-595 EB' : 'I-595 WB'} segment ${index}`,
  title: 'Vehicle collision',
  createdDate: '01/01/2026',
  related: { laneClosure: 'Y', injuries: 'N', fatalities: 0 },
}));

const built = () => buildDemoCases(payload, register());
const recordFor = id => built().records.find(entry => entry.id === id);

const orchestratorFor = (maintenance = null) => createCaseEnrichmentOrchestrator({
  connectors: createDemoConnectors({ maintenance }),
  evaluate: evaluateDemoCase,
});

async function recoverFor(id, maintenance = null) {
  const record = recordFor(id);
  const engine = orchestratorFor(maintenance);
  const recovery = await engine.search(record.demoCase, record.evaluation);
  return { record, engine, recovery };
}

/** Accept the leading candidate for every gap a reviewer is allowed to fill. */
const acceptAll = recovery => Object.fromEntries(recovery.gaps
  .filter(gap => gap.best && !gap.humanOnly)
  .map(gap => [gap.fieldId, gap.best.recordId]));

/* --- the seven outcomes ------------------------------------------------------------------- */

test('001: two inspection records are found and two remain unresolved', async () => {
  const { record, engine, recovery } = await recoverFor('ACS-DEMO-001');
  assert.equal(recovery.summary.missing, 4);
  assert.equal(recovery.summary.recoverable, 2);
  assert.equal(recovery.summary.unresolved, 2);

  const applied = engine.apply(record.demoCase, record.evaluation, recovery, acceptAll(recovery));
  assert.equal(Object.keys(applied.attachments).length, 2);
  assert.equal(applied.evaluation.statuses.INSPECTION, STAGE_STATUS.FAILED,
    'two gaps and a failed value remain, so the inspection still fails');
  assert.equal(applied.evaluation.overall, 'BLOCKED_AT_INSPECTION');
});

test('002: repair documentation is recovered but the technician confirmation is not', async () => {
  const { record, engine, recovery } = await recoverFor('ACS-DEMO-002');
  const signoff = recovery.gaps.find(gap => gap.fieldId === 'rep_technician_signoff');
  assert.ok(signoff.humanOnly, 'a sign-off is an act, not a document');
  assert.equal(signoff.candidates.length, 0);

  const applied = engine.apply(record.demoCase, record.evaluation, recovery, acceptAll(recovery));
  assert.equal(Object.keys(applied.attachments).length, 3);
  assert.equal(applied.evaluation.statuses.REPAIR, STAGE_STATUS.FAILED,
    'the paperwork gap closed; the missing confirmation still fails the stage');
  assert.equal(applied.evaluation.stages.REPAIR.summary.missing, 1);
});

test('003: QA/QC records are retrieved and the failed measurement is preserved', async () => {
  const { record, engine, recovery } = await recoverFor('ACS-DEMO-003');
  const applied = engine.apply(record.demoCase, record.evaluation, recovery, acceptAll(recovery));

  // The two certificates stop being MISSING, and become NEEDS_VERIFICATION rather than PASS.
  const findings = applied.evaluation.stages.QCQA.findings;
  const evidence = findings.filter(entry => entry.fieldId?.endsWith('-EVIDENCE'));
  assert.equal(evidence.length, 2);
  for (const entry of evidence) {
    assert.equal(entry.status, STATUS.NEEDS_VERIFICATION,
      'a recovered file is not a checked file');
  }
  // The two failed spacing answers are untouched.
  const failed = findings.filter(entry => entry.status === STATUS.FAIL).map(entry => entry.fieldId);
  assert.deepEqual(failed.sort(), ['ACS-537.1-Q05', 'ACS-537.1-Q08']);
  assert.equal(applied.evaluation.statuses.QCQA, STAGE_STATUS.FAILED);
  assert.equal(applied.evaluation.overall, 'REWORK_REQUIRED');
});

test('004: claim attachments are recovered and the cost discrepancy is not', async () => {
  const { record, engine, recovery } = await recoverFor('ACS-DEMO-004');
  const thirdParty = recovery.gaps.find(gap => gap.fieldId === 'clm_third_party_details');
  assert.ok(thirdParty.best);
  assert.equal(thirdParty.requiresReview, true, 'no shared identifier, so a person decides');

  const applied = engine.apply(record.demoCase, record.evaluation, recovery, acceptAll(recovery));
  const reconciliation = applied.evaluation.stages.CLAIM.fields
    .find(field => field.fieldId === 'clm_cost_reconciliation');
  assert.equal(reconciliation.status, STATUS.FAIL,
    'a recovered document cannot reconcile two amounts that do not agree');
  assert.equal(applied.evaluation.overall, 'CLAIM_ACTION_REQUIRED');
});

test('005: a closed case has no gaps and shows its evidence lineage instead', async () => {
  const { recovery } = await recoverFor('ACS-DEMO-005');
  assert.equal(recovery.gaps.length, 0);
  assert.ok(recovery.lineage.length >= 5);
  for (const entry of recovery.lineage) {
    assert.ok(entry.system && entry.recordId && entry.filedAt && entry.filedBy);
  }
});

test('006: an active repair is enriched with related maintenance records', async () => {
  const { recovery } = await recoverFor('ACS-DEMO-006');
  assert.equal(recovery.gaps.length, 0, 'nothing is missing — the outstanding records are pending');
  assert.equal(recovery.enrichment.length, 3);
  for (const entry of recovery.enrichment) assert.equal(entry.resolves, null);
});

test('007: claim-supporting evidence is gathered and the package is only marked ready', async () => {
  const { record, recovery } = await recoverFor('ACS-DEMO-007');
  assert.equal(recovery.enrichment.length, 3);
  const outcome = record.demoCase.evidenceRecovery.packageOutcome;
  assert.equal(outcome.status, 'READY_FOR_REVIEW');
  assert.match(outcome.note, /does not/i);
  // Nothing about the claim stage changes: it is still awaiting a claims officer.
  assert.equal(record.evaluation.statuses.CLAIM, STAGE_STATUS.PENDING);
  assert.equal(record.evaluation.overall, 'AWAITING_CLAIM');
});

/* --- the failure modes the brief names ------------------------------------------------------ */

test('a system that does not answer is reported, never read as "holds nothing"', async () => {
  const { recovery } = await recoverFor('ACS-DEMO-001');
  const sunguide = recovery.searches.find(search => search.system === SYSTEMS.SUNGUIDE);
  assert.equal(sunguide.status, SEARCH_STATUS.UNAVAILABLE);
  assert.match(sunguide.error, /did not respond/i);
  assert.equal(sunguide.count, 0);

  const nothing = recovery.searches.find(search => search.status === SEARCH_STATUS.NO_MATCH);
  assert.notEqual(nothing?.status, SEARCH_STATUS.UNAVAILABLE,
    'nothing-found and no-response are different statuses');
});

test('a real connector with no client refuses rather than returning an empty result', async () => {
  const connector = apiConnector({ system: SYSTEMS.OFFICE_TRACK });
  const result = await connector.search({});
  assert.equal(result.status, SEARCH_STATUS.UNAVAILABLE);
  assert.equal(result.origin, ORIGIN.LIVE);
  assert.match(result.error, /no endpoint or credentials/i);
  assert.match(result.error, /not a report that the system holds nothing/i);
  assert.equal(connector.available, false);
});

test('conflicting evidence forces a human decision even when the leader is an exact match', async () => {
  const { recovery } = await recoverFor('ACS-DEMO-001');
  const photos = recovery.gaps.find(gap => gap.fieldId === 'insp_damage_photos');
  assert.equal(photos.best.tier, MATCH_TIER.EXACT);
  assert.equal(photos.requiresReview, true);
  assert.match(photos.reviewReason, /contradicts/i);
  assert.equal(photos.preselected.length, 0, 'a contested gap is never pre-ticked');
});

test('an ambiguous asset match is reported on the candidate that causes it', async () => {
  const { recovery } = await recoverFor('ACS-DEMO-001');
  const photos = recovery.gaps.find(gap => gap.fieldId === 'insp_damage_photos');
  const other = photos.candidates.find(entry => entry.recordId === 'MIMS-PH-5521');
  const kinds = other.warnings.map(warning => warning.kind);
  assert.ok(kinds.includes('ASSET_MISMATCH'));
  assert.ok(kinds.includes('CONFLICTING_EVIDENCE'));
  assert.notEqual(other.tier, MATCH_TIER.EXACT, 'a different asset id is not an identifier match');
});

test('a timestamp mismatch is raised only when time is part of why the records were matched', () => {
  const far = { recordId: 'X', keys: { minutesFromIncident: 5000, locationDistanceM: 10 } };
  // No identifier: the time gap is the whole reason to doubt it.
  assert.ok(warningsFor(far, {}, { identifierMatched: false })
    .some(warning => warning.kind === 'TIMESTAMP_MISMATCH'));
  // An identifier matched: a repair filed days after the crash it answers is normal.
  assert.deepEqual(warningsFor(far, {}, { identifierMatched: true }), []);
});

test('a candidate far from the incident with no identifier is flagged on location', () => {
  const scored = scoreCandidate(
    { recordId: 'Y', keys: { locationDistanceM: 900, minutesFromIncident: 10 } }, {});
  assert.ok(scored.warnings.some(warning => warning.kind === 'LOCATION_MISMATCH'));
  assert.equal(scored.tier, MATCH_TIER.WEAK);
});

test('missing historical traffic is stated as a fact about the deployment', () => {
  assert.equal(TRAFFIC_AVAILABILITY.historicalSpeed, false);
  assert.equal(TRAFFIC_AVAILABILITY.historicalVolume, false);
  assert.equal(TRAFFIC_AVAILABILITY.historicalCongestion, false);
  assert.equal(TRAFFIC_AVAILABILITY.historicalLaneClosure, true,
    'the register does record whether an incident closed lanes');
  for (const source of ['FL511', 'SunGuide', 'DataConnect']) {
    assert.ok(TRAFFIC_AVAILABILITY.checkedSources.includes(source), `${source} was checked`);
  }
  assert.match(TRAFFIC_AVAILABILITY.note, /synthetic/i);
});

test('a successful re-validation is reported with what changed', () => {
  const before = { statuses: { INSPECTION: STAGE_STATUS.FAILED, REPAIR: STAGE_STATUS.BLOCKED },
    overall: 'BLOCKED_AT_INSPECTION' };
  const after = { statuses: { INSPECTION: STAGE_STATUS.PASSED, REPAIR: STAGE_STATUS.PENDING },
    overall: 'AWAITING_REPAIR', attachments: { a: {}, b: {} } };
  const audit = createAuditLog();
  const delta = validationDelta(before, after, { audit, caseId: 'X' });
  assert.equal(delta.overallChanged, true);
  assert.equal(delta.changes.length, 2);
  assert.deepEqual(delta.closed, ['a', 'b']);
  assert.ok(audit.all().some(entry => entry.event === AUDIT_EVENTS.VALIDATION_CHANGED));
});

/* --- the safety rules ------------------------------------------------------------------------ */

test('only a MISSING field is ever searched for', () => {
  const record = recordFor('ACS-DEMO-006');
  const gaps = missingEvidence(record.evaluation);
  assert.equal(gaps.length, 0, 'pending and blocked fields are not gaps');

  const all = missingEvidence(recordFor('ACS-DEMO-001').evaluation);
  for (const gap of all) {
    const field = recordFor('ACS-DEMO-001').evaluation.stages[gap.stage].findings
      .find(entry => entry.fieldId === gap.fieldId);
    assert.equal(field.status, STATUS.MISSING);
  }
});

test('recovered evidence never overwrites a value the case already records', () => {
  const stage = {
    submission: 'SUBMITTED',
    fields: [
      { fieldId: 'kept', label: 'Kept', required: true, value: 'original' },
      { fieldId: 'filled', label: 'Filled', required: true, value: null },
    ],
  };
  const overlaid = withAttachments(stage, {
    kept: { value: 'recovered', recordId: 'R1', system: 'MIMS' },
    filled: { value: 'recovered', recordId: 'R2', system: 'MIMS' },
  });
  assert.equal(overlaid.fields[0].value, 'original', 'the original record is untouched');
  assert.equal(overlaid.fields[0].recoveredFrom, undefined);
  assert.equal(overlaid.fields[1].value, 'recovered');
  assert.equal(overlaid.fields[1].recoveredFrom.recordId, 'R2');
  // The case itself is frozen and was not written to.
  assert.equal(stage.fields[1].value, null);
});

test('a human-only field cannot be filled even if a reviewer accepts a record for it', () => {
  const audit = createAuditLog();
  const recovery = {
    gaps: [{
      fieldId: 'rep_technician_signoff', label: 'Technician sign-off',
      humanOnly: { reason: 'An attestation, not a document.' },
      candidates: [{ recordId: 'FAKE-1', value: 'signed', system: 'MIMS' }],
    }],
  };
  const attachments = buildAttachments(recovery, { rep_technician_signoff: 'FAKE-1' },
    { audit, caseId: 'X' });
  assert.deepEqual(attachments, {});
  assert.ok(audit.all().some(entry => entry.event === AUDIT_EVENTS.BLOCKED_BY_POLICY));
});

test('no QC/QA failure is ever cleared by recovered documentation', async () => {
  const { record, engine, recovery } = await recoverFor('ACS-DEMO-003');
  // Accept everything the engine will allow, then try to force the approvals too.
  const forced = { ...acceptAll(recovery),
    'ACS-537.1-APPROVAL-QC': 'anything', 'ACS-537.1-APPROVAL-QA': 'anything' };
  const applied = engine.apply(record.demoCase, record.evaluation, recovery, forced);
  assert.equal(applied.evaluation.statuses.QCQA, STAGE_STATUS.FAILED);
  assert.equal(applied.evaluation.review.approved, false);
});

test('nothing is attached without an explicit decision', async () => {
  const { record, engine, recovery } = await recoverFor('ACS-DEMO-002');
  const applied = engine.apply(record.demoCase, record.evaluation, recovery, {});
  assert.deepEqual(applied.attachments, {});
  assert.deepEqual(applied.evaluation.statuses, record.evaluation.statuses);
});

test('only an unambiguous exact match is pre-selected, and pre-selection is not attachment', async () => {
  const { recovery } = await recoverFor('ACS-DEMO-002');
  for (const gap of recovery.gaps) {
    if (!gap.preselected.length) continue;
    assert.equal(gap.best.tier, MATCH_TIER.EXACT);
    assert.equal(gap.requiresReview, false);
  }
  const possible = (await recoverFor('ACS-DEMO-004')).recovery.gaps
    .find(gap => gap.fieldId === 'clm_third_party_details');
  assert.deepEqual(possible.preselected, [], 'a circumstantial match is never pre-ticked');
});

test('rejecting every candidate leaves the gap standing and is recorded', async () => {
  const { record, engine, recovery } = await recoverFor('ACS-DEMO-002');
  const applied = engine.apply(record.demoCase, record.evaluation, recovery,
    { rep_materials_record: '' });
  assert.deepEqual(applied.attachments, {});
  const rejected = engine.audit.all().find(entry =>
    entry.event === AUDIT_EVENTS.REVIEWER_DECISION && entry.decision === 'REJECTED');
  assert.ok(rejected, 'the rejection is in the log');
});

/* --- provenance and audit -------------------------------------------------------------------- */

test('every synthetic record is stamped, and the real connector is not', async () => {
  const { recovery } = await recoverFor('ACS-DEMO-002');
  const all = [...recovery.gaps.flatMap(gap => gap.candidates), ...recovery.enrichment];
  assert.ok(all.length > 0);
  for (const candidate of all) {
    if (candidate.system === SYSTEMS.DATACONNECT) {
      assert.equal(candidate.synthetic, false);
      assert.equal(candidate.origin, ORIGIN.LIVE);
    } else {
      assert.equal(candidate.synthetic, true, `${candidate.recordId} must be stamped synthetic`);
      assert.equal(candidate.origin, ORIGIN.SYNTHETIC);
    }
  }
  for (const search of recovery.searches) {
    assert.ok([ORIGIN.LIVE, ORIGIN.SYNTHETIC].includes(search.origin));
  }
});

test('the DataConnect connector matches only on identifiers the records themselves carry', async () => {
  const maintenance = {
    recordsOf: key => (key === 'workOrders' ? [{
      id: 'WO-1', title: 'Guardrail repair', status: 'Closed', assetId: 'DEMO-ASSET-006',
      createdDate: '01/02/2026', raw: { attributes: { 'Work Order ID': 'WO-1', 'Asset ID': 'DEMO-ASSET-006' } },
    }, {
      id: 'WO-2', title: 'Unrelated', status: 'Open', assetId: 'OTHER-ASSET',
      createdDate: '01/02/2026', raw: { attributes: { 'Work Order ID': 'WO-2', 'Asset ID': 'OTHER-ASSET' } },
    }] : []),
  };
  const connector = createDataConnectConnector({ maintenance });
  const result = await connector.search({ context: { assetId: 'DEMO-ASSET-006' } });
  assert.equal(result.origin, ORIGIN.LIVE);
  assert.equal(result.status, SEARCH_STATUS.OK);
  assert.deepEqual(result.records.map(entry => entry.recordId), ['WO-1']);
  assert.equal(result.records[0].synthetic, false);
});

test('the DataConnect connector reports unavailable when the workspace has not loaded', async () => {
  const result = await createDataConnectConnector({}).search({ context: {} });
  assert.equal(result.status, SEARCH_STATUS.UNAVAILABLE);
  assert.equal(result.records.length, 0);
});

test('every retrieval, match, decision and status change reaches the audit log', async () => {
  const { record, engine, recovery } = await recoverFor('ACS-DEMO-002');
  engine.apply(record.demoCase, record.evaluation, recovery, acceptAll(recovery));
  const events = new Set(engine.audit.forCase('ACS-DEMO-002').map(entry => entry.event));
  for (const expected of [AUDIT_EVENTS.SEARCH_STARTED, AUDIT_EVENTS.SOURCE_RESPONSE,
    AUDIT_EVENTS.MATCH_PROPOSED, AUDIT_EVENTS.REVIEWER_DECISION, AUDIT_EVENTS.EVIDENCE_ATTACHED,
    AUDIT_EVENTS.VALIDATION_CHANGED]) {
    assert.ok(events.has(expected), `${expected} is logged`);
  }
  const entries = engine.audit.all();
  assert.deepEqual(entries.map(entry => entry.sequence), entries.map((unused, i) => i + 1),
    'the log is append-only and in order');
});

test('a connector that throws is reported, not allowed to fail the whole search', async () => {
  const broken = assertConnector({
    system: SYSTEMS.MIMS, origin: ORIGIN.LIVE,
    search: async () => { throw new Error('socket hang up'); },
  });
  const record = recordFor('ACS-DEMO-001');
  const recovery = await searchForEvidence(record.demoCase, record.evaluation,
    { connectors: [broken] });
  const result = recovery.searches.find(search => search.system === SYSTEMS.MIMS);
  assert.equal(result.status, SEARCH_STATUS.UNAVAILABLE);
  assert.match(result.error, /socket hang up/);
});

test('a connector missing its interface is refused at construction', () => {
  assert.throws(() => assertConnector({ system: SYSTEMS.MIMS }), /missing connector methods/);
  assert.throws(() => assertConnector({ search: async () => {} }), /must declare the system/);
});

/* --- matching rules --------------------------------------------------------------------------- */

test('an identifier match reaches EXACT and circumstantial weight never does', () => {
  const byId = scoreCandidate({ recordId: 'A', keys: { workOrderId: 'WO-9' } }, { workOrderId: 'WO-9' });
  assert.equal(byId.tier, MATCH_TIER.EXACT);

  // Every circumstantial rule satisfied at once, and it still only reaches POSSIBLE. That is the
  // invariant worth holding: the non-identifier rules cannot sum past the PROBABLE threshold, so
  // "same place, same minute, same carriageway" can never be presented as a strong match, let
  // alone a certain one.
  const circumstantial = scoreCandidate(
    { recordId: 'B', keys: { locationDistanceM: 5, minutesFromIncident: 10, direction: 'EB' } },
    { direction: 'EB' });
  assert.equal(circumstantial.tier, MATCH_TIER.POSSIBLE);
  assert.ok(circumstantial.matchedRules.every(rule => !rule.identifier));

  // Rules in a group are mutually exclusive, so the ceiling is the best of each group.
  const maxCircumstantial = maxCircumstantialScore();
  assert.equal(maxCircumstantial, circumstantial.score, 'the ceiling is reachable');
  assert.ok(maxCircumstantial < TIER_THRESHOLDS.PROBABLE,
    `circumstantial rules sum to ${maxCircumstantial}, which must stay below the PROBABLE threshold`);
});

test('two identifier matches for one slot always need a reviewer', () => {
  const ranked = rankCandidates([
    { recordId: 'A', keys: { assetId: 'X' } },
    { recordId: 'B', keys: { assetId: 'X' } },
  ], { assetId: 'X' });
  assert.equal(ranked.requiresReview, true);
  assert.match(ranked.reviewReason, /only one can be the right record/);
});

test('the rules are data and can be replaced per deployment', () => {
  const ranked = rankCandidates([{ recordId: 'A', keys: { assetId: 'X' } }], { assetId: 'X' },
    [{ id: 'none', label: 'None', weight: 1, test: () => false, explain: () => '' }]);
  assert.equal(ranked.best.tier, MATCH_TIER.WEAK);
  assert.ok(MATCH_RULES.every(rule => typeof rule.test === 'function' && rule.weight > 0));
});

test('confidence never reads as certainty', () => {
  const everything = scoreCandidate({
    recordId: 'A',
    keys: { incidentId: 'I', workOrderId: 'W', assetId: 'A', locationDistanceM: 1,
      minutesFromIncident: 1, direction: 'EB' },
  }, { incidentId: 'I', workOrderId: 'W', assetId: 'A', direction: 'EB' });
  assert.ok(everything.confidence <= 99);
});

test('an evidence type is named for every field type a gap can have', () => {
  for (const dataType of ['attachment', 'approval', 'currency', 'date', 'number', 'text', 'checklist']) {
    assert.ok(evidenceTypeOf({ dataType }).length > 3);
  }
  assert.ok(evidenceTypeOf({ dataType: 'something-new' }).length > 3, 'an unknown type still reads');
});

/* --- incident context --------------------------------------------------------------------------- */

test('synthetic traffic is coherent with the incident hour and stable across runs', () => {
  assert.ok(diurnalFactor(8) < diurnalFactor(3), 'the morning peak is slower than the small hours');
  assert.ok(diurnalFactor(17) < diurnalFactor(11), 'the evening peak is slower than mid-morning');

  const night = syntheticTraffic({ demoCaseId: 'T1', incident: { reportedAt: '2026-05-19T04:05:00-04:00' } });
  const peak = syntheticTraffic({ demoCaseId: 'T2', incident: { reportedAt: '2026-05-19T17:45:00-04:00' } });
  assert.ok(night.speed.value > peak.speed.value, 'an 04:05 incident is not congested');
  assert.equal(night.hour, 4);
  assert.equal(peak.hour, 17);

  const again = syntheticTraffic({ demoCaseId: 'T1', incident: { reportedAt: '2026-05-19T04:05:00-04:00' } });
  assert.equal(again.speed.value, night.speed.value, 'the same case always gives the same figure');
});

test('every synthetic traffic value says it is synthetic', () => {
  const traffic = syntheticTraffic({ demoCaseId: 'T', incident: { reportedAt: '2026-05-19T09:00:00-04:00' } });
  for (const key of ['speed', 'congestion', 'volume']) {
    assert.equal(traffic[key].synthetic, true);
    assert.equal(traffic[key].source, OBSERVATION_SOURCE.SYNTHETIC);
    assert.equal(traffic[key].quality, DATA_QUALITY.SYNTHETIC);
    assert.match(traffic[key].note, /synthetic/i);
  }
});

test('congestion bands follow the speed', () => {
  assert.equal(congestionBand(60), 'FREE_FLOW');
  assert.equal(congestionBand(45), 'MODERATE');
  assert.equal(congestionBand(30), 'HEAVY');
  assert.equal(congestionBand(15), 'SEVERE');
  assert.equal(congestionBand(null), null);
});

test('the register\'s own flags are reported as real and attributed to the source incident', () => {
  const facts = registerFacts({ id: 'INC-1', createdDate: '01/01/2026',
    related: { laneClosure: 'Y', injuries: 'N', fatalities: 0 } });
  const closure = facts.find(entry => entry.label === 'Lane closure');
  assert.equal(closure.value, 'Yes');
  assert.equal(closure.synthetic, false);
  assert.equal(closure.source, OBSERVATION_SOURCE.OBSERVED);
  assert.equal(closure.spatialMatch, SPATIAL_MATCH.EXACT);
  assert.match(closure.note, /not about this case's synthetic damage/i);
});

test('a register row with no flags reports absence rather than "No"', () => {
  const facts = registerFacts({ id: 'INC-2', related: {} });
  for (const entry of facts) {
    assert.equal(entry.value, null);
    assert.equal(entry.quality, DATA_QUALITY.UNAVAILABLE);
  }
});

test('AADT is reported as a published average, never as an observation', () => {
  const average = annualAverage({ segmentId: 'S1', aadt: 182000, aadtYear: 2024 });
  assert.equal(average.value, 182000);
  assert.equal(average.source, OBSERVATION_SOURCE.PUBLISHED_AVERAGE);
  assert.equal(average.observedAt, '2024');
  assert.match(average.note, /not a measurement at the incident hour/i);
  assert.equal(annualAverage(null).quality, DATA_QUALITY.UNAVAILABLE);
});

test('weather observations carry their units and a missing reading is not invented', () => {
  const none = weatherObservations(null);
  assert.equal(none[0].value, null);
  assert.equal(none[0].quality, DATA_QUALITY.UNAVAILABLE);
  assert.match(none[0].note, /Nothing has been substituted/i);

  const reading = {
    source: 'Open-Meteo', condition: 'Clear', temperature: 24, precipitation: 0, visibility: 16000,
    windSpeed: 11, windGust: 18, humidity: 70, cloudCover: 10,
    matchedWeatherTime: '2026-05-19T04:00', requestedIncidentTime: '2026-05-19T04:05',
    units: { temperature: '°C', precipitation: 'mm', visibility: 'm', windSpeed: 'km/h',
      windGust: 'km/h', humidity: '%', cloudCover: '%' },
  };
  const observed = weatherObservations(reading);
  const temperature = observed.find(entry => entry.label === 'Temperature');
  assert.equal(temperature.unit, '°C');
  assert.equal(temperature.quality, DATA_QUALITY.MODELLED, 'reanalysis, not a roadside sensor');
  assert.equal(temperature.spatialMatch, SPATIAL_MATCH.GRID_CELL);
  // The provenance is said once for the panel, and names the hour actually matched.
  assert.match(weatherProvenance(reading), /Asked for 2026-05-19T04:05, matched 2026-05-19T04:00/);
  assert.match(weatherProvenance(reading), /not a roadside sensor/);
  assert.equal(weatherProvenance(null), null);
});

test('implications are drawn only from readings that exist', () => {
  const quiet = operationalImplications({ reading: null, traffic: null, register: [] });
  assert.equal(quiet.length, 1);
  assert.match(quiet[0], /Nothing in the available readings/);

  const wet = operationalImplications({
    reading: { precipitation: 1.4, visibility: 3000, windGust: 55 },
    traffic: { congestion: { value: 'HEAVY' } },
    register: [{ label: 'Lane closure', value: 'Yes' }],
  });
  assert.ok(wet.some(line => /wet pavement/i.test(line)));
  assert.ok(wet.some(line => /Visibility 3000 m/.test(line)));
  assert.ok(wet.some(line => /Gusts to 55/.test(line)));
  assert.ok(wet.some(line => /traffic control already in place/i.test(line)));
  assert.ok(wet.some(line => /synthetic/i.test(line)), 'the synthetic one says so');
});

test('the context service asks the weather provider for the incident hour and caches it', async () => {
  const asked = [];
  const service = createIncidentContextService({
    weatherService: {
      weatherAt: async point => { asked.push(point); return null; },
    },
  });
  const record = recordFor('ACS-DEMO-005');
  const context = await service.contextFor(record.demoCase);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].latitude, record.demoCase.sourceIncident.latitude);
  assert.equal(asked[0].timestampMs, Date.parse(record.demoCase.incident.reportedAt));
  assert.equal(context.weather.available, false);
  assert.match(context.weather.unavailableReason, /no reading/i);

  await service.contextFor(record.demoCase);
  assert.equal(asked.length, 1, 'the second read comes from the cache');
});

test('a case with no located incident gets no weather and says why', async () => {
  const none = buildDemoCases(payload, []);
  const service = createIncidentContextService({
    weatherService: { weatherAt: async () => { throw new Error('should not be asked'); } },
  });
  const context = await service.contextFor(none.records[0].demoCase);
  assert.equal(context.weather.available, false);
  assert.match(context.weather.unavailableReason, /no coordinate/i);
  assert.equal(context.location.latitude, null);
});

test('corridorHour reads the corridor timezone, not the machine\'s', () => {
  assert.equal(corridorHour('2026-10-15T09:35:00-04:00'), 9);
  assert.equal(corridorHour('2026-10-15T13:35:00Z'), 9);
  assert.equal(corridorHour('not a date'), null);
});

/* --- the outlook the KPI and slider read ------------------------------------------------------- */

test('the outlook agrees with what the search actually finds', async () => {
  for (const record of built().records) {
    const outlook = recoveryOutlook(record.demoCase, record.evaluation);
    const engine = orchestratorFor();
    const recovery = await engine.search(record.demoCase, record.evaluation);
    assert.equal(outlook.missing, recovery.summary.missing, `${record.id} missing`);
    assert.equal(outlook.recoverable, recovery.summary.recoverable, `${record.id} recoverable`);
    assert.equal(outlook.unresolved, recovery.summary.unresolved, `${record.id} unresolved`);
  }
});

test('every record carries the outlook the card and the panel draw', () => {
  for (const record of built().records) {
    assert.ok(record.outlook, `${record.id} has an outlook`);
    assert.equal(record.outlook.contextAvailable, true);
    assert.equal(typeof record.outlook.outcome, 'string');
  }
});

test('the demo connector set is DataConnect plus three synthetic stand-ins', () => {
  const connectors = createDemoConnectors({});
  assert.equal(connectors.length, 4);
  assert.equal(connectors.filter(entry => entry.origin === ORIGIN.SYNTHETIC).length, 3);
  const live = connectors.find(entry => entry.system === SYSTEMS.DATACONNECT);
  assert.equal(live.origin, ORIGIN.LIVE);

  // Supplying a client swaps a synthetic stand-in for the real adapter, which then refuses.
  const withClient = createDemoConnectors({ clients: { [SYSTEMS.MIMS]: {} } });
  assert.equal(withClient.find(entry => entry.system === SYSTEMS.MIMS).origin, ORIGIN.LIVE);
});

test('a synthetic connector returns only its own system\'s records', async () => {
  const connector = createSyntheticConnector({ system: SYSTEMS.MIMS });
  const demoCase = payload.cases.find(entry => entry.demoCaseId === 'ACS-DEMO-001');
  const result = await connector.search({ demoCase });
  assert.ok(result.records.length > 0);
  for (const candidate of result.records) assert.equal(candidate.system, SYSTEMS.MIMS);
});
