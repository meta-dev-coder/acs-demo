/**
 * Claims Intelligence.
 *
 * Every claim in this application is synthetic, and most of these tests exist to keep it that way:
 * the production flag stays false, `demo: true` travels with every figure, and a case our own
 * validation found short is never described as a rejection by anybody.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { STAGE_STATUS } from '../src/qcqa/stageValidation.js';
import {
  CLAIM_DIMENSIONS, CLAIM_STATUS, PRODUCTION_CLAIMS, claimDimensionById, claimDossier,
  claimHistoryFor, claimRecords, claimStatusOf, claimsBy, claimsKpis, repeatedClaims, usd,
} from '../src/maintenance/claimsIntelligence.js';
import { buildDemoCases, loadDemoCases, resetDemoCases } from '../src/acs/acsDemoCases.js';
import { readFile } from 'node:fs/promises';

const fileFetcher = async path => {
  const body = await readFile(new URL(`../public/${path}`, import.meta.url), 'utf8');
  return { ok: true, json: async () => JSON.parse(body) };
};

/** The incident register stands in as seven located incidents, so every case gets a location. */
const incidents = Array.from({ length: 12 }, (unused, index) => ({
  id: `INC-${900 + index}`, title: 'Vehicle collision',
  longitude: -80.4 + index * 0.02, latitude: 26.07,
  segmentName: index % 2 ? 'Central Segment' : 'East Segment', createdDate: '2026-01-10',
  related: {},
}));

const built = await (async () => {
  resetDemoCases();
  const payload = await loadDemoCases(fileFetcher);
  return buildDemoCases(payload, incidents);
})();
const claims = claimRecords(built.records);

test('no production claims source exists, and that is recorded rather than implied', () => {
  assert.equal(PRODUCTION_CLAIMS.available, false);
  assert.match(PRODUCTION_CLAIMS.reason, /No claims system is connected/);
});

test('every demonstration case produces exactly one claim, all of them marked demo', () => {
  assert.equal(claims.length, 7);
  assert.ok(claims.every(claim => claim.demo === true));
  assert.ok(claims.every(claim => claim.demoLabel));
});

test('no claim reference can be mistaken for a production one', () => {
  for (const claim of claims) {
    if (claim.claimReference) assert.match(claim.claimReference, /^DEMO-/);
  }
});

test('money that has come back outranks money that was agreed', () => {
  assert.equal(claimStatusOf({ costs: { recoveredUSD: 100, approvedUSD: 100, claimedUSD: 100 } },
    { status: STAGE_STATUS.FAILED }), CLAIM_STATUS.SETTLED);
  assert.equal(claimStatusOf({ costs: { approvedUSD: 100, claimedUSD: 100 } }, { status: STAGE_STATUS.PASSED }),
    CLAIM_STATUS.APPROVED);
});

test('a failed claim stage means our validation found it short, not that it was rejected', () => {
  assert.equal(claimStatusOf({ costs: {} }, { status: STAGE_STATUS.FAILED }), CLAIM_STATUS.NEEDS_DOCUMENTATION);
});

test('a case that has not reached the claim yet is pending, never failed', () => {
  assert.equal(claimStatusOf({ costs: {} }, { status: STAGE_STATUS.PENDING }), CLAIM_STATUS.PENDING);
  assert.equal(claimStatusOf({ costs: {} }, null), CLAIM_STATUS.PENDING);
});

test('a claim held up by an earlier failure is BLOCKED, and is not counted as needing documents', () => {
  assert.equal(claimStatusOf({ costs: {} }, { status: STAGE_STATUS.BLOCKED }), CLAIM_STATUS.BLOCKED);
});

test('the seven cases produce the statuses the demonstration describes', () => {
  const byCase = Object.fromEntries(claims.map(claim => [claim.demoCaseId, claim.status]));
  assert.equal(byCase['ACS-DEMO-004'], CLAIM_STATUS.NEEDS_DOCUMENTATION);
  assert.equal(byCase['ACS-DEMO-005'], CLAIM_STATUS.SETTLED);
  assert.equal(byCase['ACS-DEMO-006'], CLAIM_STATUS.PENDING);
  assert.equal(byCase['ACS-DEMO-007'], CLAIM_STATUS.PENDING);
  for (const id of ['ACS-DEMO-001', 'ACS-DEMO-002', 'ACS-DEMO-003']) {
    assert.equal(byCase[id], CLAIM_STATUS.BLOCKED, `${id} is blocked upstream, not short of documents`);
  }
});

test('the figures add up to what the records hold, and say they are demonstration money', () => {
  const kpis = claimsKpis(claims);
  assert.equal(kpis.demo, true);
  assert.equal(kpis.total, 7);
  assert.equal(kpis.claimedUSD, claims.reduce((total, claim) => total + (claim.claimedUSD ?? 0), 0));
  assert.equal(kpis.outstandingUSD, kpis.claimedUSD - kpis.recoveredUSD);
});

test('an amount the case has not recorded is absent, not zero', () => {
  const pending = claims.find(claim => claim.demoCaseId === 'ACS-DEMO-001');
  assert.equal(pending.approvedUSD, null);
  assert.equal(pending.claimedUSD, null);
  assert.equal(pending.recoveredUSD, null);
  assert.equal(pending.outstandingUSD, null, 'nothing claimed means no exposure, not zero exposure');
  assert.equal(typeof pending.estimatedUSD, 'number');
});

test('an unrecorded amount contributes nothing rather than its estimate', () => {
  const kpis = claimsKpis([{ estimatedUSD: 1000, claimedUSD: null, recoveredUSD: null, status: CLAIM_STATUS.PENDING }]);
  assert.equal(kpis.claimedUSD, 0);
  assert.equal(kpis.estimatedUSD, 1000);
});

test('grouping keeps every claim, including the ones a dimension cannot read', () => {
  for (const dimension of CLAIM_DIMENSIONS) {
    const groups = claimsBy(claims, dimension);
    assert.equal(groups.reduce((total, group) => total + group.count, 0), claims.length, dimension.id);
  }
  assert.equal(claimDimensionById('nope').id, CLAIM_DIMENSIONS[0].id);
});

test('no asset in the demonstration set carries two claims, and that is reported as none', () => {
  assert.deepEqual(repeatedClaims(claims), []);
});

test('repeated claims are found when they exist', () => {
  const twice = [
    { assetId: 'A-1', assetName: 'Pole', claimedUSD: 10, recoveredUSD: 0, demoCaseId: 'C1' },
    { assetId: 'A-1', assetName: 'Pole', claimedUSD: 20, recoveredUSD: 5, demoCaseId: 'C2' },
    { assetId: 'A-2', assetName: 'Rail', claimedUSD: 30, recoveredUSD: 0, demoCaseId: 'C3' },
  ];
  const repeated = repeatedClaims(twice);
  assert.equal(repeated.length, 1);
  assert.deepEqual(repeated[0].demoCaseIds, ['C1', 'C2']);
  assert.equal(repeated[0].claimedUSD, 30);
});

test('an asset\'s claim history links through the recorded incident id, never through proximity', () => {
  const claim = claims.find(entry => entry.sourceIncidentId);
  const history = claimHistoryFor(claim.assetId, claims);
  assert.ok(history.incidentIds.includes(claim.sourceIncidentId));
  assert.equal(claimHistoryFor('NOT-AN-ASSET', claims), null);
});

test('a null amount prints as absent, not as zero dollars', () => {
  assert.equal(usd(null), '—');
  assert.equal(usd(0), '$0');
  assert.equal(usd(7260), '$7,260');
});

/* ── the inline claim detail ─────────────────────────────────────────────────────────────────── */

test('the register\'s "-" is not a segment name on a claim either', () => {
  for (const claim of claims) assert.notEqual(claim.segment, '-');
});

test('a dossier keeps the four identifiers that tie the records together', () => {
  const record = built.records.find(entry => entry.id === 'ACS-DEMO-004');
  const claim = claims.find(entry => entry.demoCaseId === 'ACS-DEMO-004');
  const dossier = claimDossier(record, claim);
  assert.equal(dossier.links.caseId, 'ACS-DEMO-004');
  assert.equal(dossier.links.claimReference, claim.claimReference);
  assert.equal(dossier.links.sourceIncidentId, record.related.sourceIncidentId);
  assert.equal(dossier.links.assetId, record.demoCase.asset.assetId);
});

test('the dossier distinguishes the case\'s incident from the real one whose location it reuses', () => {
  const record = built.records.find(entry => entry.id === 'ACS-DEMO-002');
  const dossier = claimDossier(record, claims.find(entry => entry.demoCaseId === 'ACS-DEMO-002'));
  assert.equal(dossier.links.incidentType, record.demoCase.incident.incidentType);
  assert.equal(dossier.links.sourceIncidentType, record.evaluation.location.sourceIncidentType);
});

test('the findings are the claim stage\'s own, and only the ones that matter', () => {
  const record = built.records.find(entry => entry.id === 'ACS-DEMO-004');
  const dossier = claimDossier(record, claims.find(entry => entry.demoCaseId === 'ACS-DEMO-004'));
  assert.ok(dossier.findings.length > 0);
  for (const finding of dossier.findings) {
    const field = record.evaluation.stages.CLAIM.findings.find(entry => entry.fieldId === finding.fieldId);
    assert.ok(['FAIL', 'MISSING'].includes(field.status));
  }
  for (const entry of dossier.evidence) {
    const field = record.evaluation.stages.CLAIM.findings.find(item => item.fieldId === entry.fieldId);
    assert.equal(field.status, 'PASS');
  }
});

test('a claim held by an earlier stage says so rather than claiming work of its own', () => {
  const record = built.records.find(entry => entry.id === 'ACS-DEMO-001');
  const dossier = claimDossier(record, claims.find(entry => entry.demoCaseId === 'ACS-DEMO-001'));
  assert.equal(dossier.outstanding.isClaimStage, false);
  assert.equal(dossier.outstanding.blockingStage, 'INSPECTION');
});

test('the claim variance is the reconciliation question, not an error', () => {
  const record = built.records.find(entry => entry.id === 'ACS-DEMO-004');
  const dossier = claimDossier(record, claims.find(entry => entry.demoCaseId === 'ACS-DEMO-004'));
  assert.equal(dossier.financial.varianceUSD, 2450);
  const settled = built.records.find(entry => entry.id === 'ACS-DEMO-005');
  assert.equal(claimDossier(settled, claims.find(e => e.demoCaseId === 'ACS-DEMO-005')).financial.varianceUSD, 0);
});

test('a claim with nothing claimed has no variance rather than a variance of zero', () => {
  const record = built.records.find(entry => entry.id === 'ACS-DEMO-001');
  assert.equal(claimDossier(record, claims.find(e => e.demoCaseId === 'ACS-DEMO-001')).financial.varianceUSD, null);
});

test('every case produces a dossier, and all of them are marked demo', () => {
  for (const record of built.records) {
    const dossier = claimDossier(record, claims.find(entry => entry.demoCaseId === record.id));
    assert.equal(dossier.demo, true, record.id);
    assert.ok(dossier.outstanding.action, record.id);
  }
});
