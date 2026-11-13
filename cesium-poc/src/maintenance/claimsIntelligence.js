/**
 * Claims, read two ways.
 *
 * A claim is a step in the ACS lifecycle — the thing the Claim stage validates — and it is also a
 * record of what the corridor's damage has cost. The Claims Intelligence subtab is the second
 * reading: the same claims, grouped by asset, segment and status, so an operator can see where the
 * money and the repeated damage are.
 *
 * Every claim here comes from the seven synthetic demonstration cases. There is no production
 * claims system connected to this application (see PRODUCTION_CLAIMS), so every figure on that
 * subtab is demonstration money and says so. Nothing is added to a production total, and no
 * financial value is invented beyond the costs already recorded in the committed case file.
 */
import { STATUS } from '../qcqa/schema.js';
import { STAGE_ORDER, STAGE_STATUS } from '../qcqa/stageValidation.js';
import { ASSOCIATION, segmentOf } from './assetOpsModel.js';

/**
 * Whether a production claims source exists.
 *
 * Stated as data rather than left as an absence, so the panel can print the reason and a test can
 * hold it. The day a claims API is connected, this is the flag that changes.
 */
export const PRODUCTION_CLAIMS = Object.freeze({
  available: false,
  reason: 'No claims system is connected to this application. The ACS repair-task export carries '
    + 'third-party invoice references but no claim records, statuses or recovered amounts, and '
    + 'DataConnect publishes no claims class. Every claim below is from the synthetic demonstration cases.',
});

/** Where a claim stands. Derived from the recorded amounts and the validated claim stage. */
export const CLAIM_STATUS = Object.freeze({
  SETTLED: 'SETTLED',
  APPROVED: 'APPROVED',
  NEEDS_DOCUMENTATION: 'NEEDS_DOCUMENTATION',
  PENDING: 'PENDING',
  BLOCKED: 'BLOCKED',
});

export const CLAIM_STATUS_LABELS = Object.freeze({
  SETTLED: 'Settled', APPROVED: 'Approved', NEEDS_DOCUMENTATION: 'Requires documentation',
  PENDING: 'Pending', BLOCKED: 'Blocked upstream',
});

/**
 * One case's claim state.
 *
 * Order matters and is the point: money that has come back outranks money that was agreed, which
 * outranks a claim the validation says is short of documents. A claim is only BLOCKED when an
 * earlier stage failed — a case that simply has not reached the claim yet is PENDING, never
 * failed, and never counted as a rejection.
 *
 * Nothing here is an insurer's decision. The demonstration carries no synthetic insurer, so
 * "Requires documentation" means OUR validation found the claim short, not that anyone rejected it.
 */
export function claimStatusOf(claim, claimStage) {
  const costs = claim?.costs ?? {};
  if (Number(costs.recoveredUSD) > 0) return CLAIM_STATUS.SETTLED;
  const status = claimStage?.status ?? null;
  if (status === STAGE_STATUS.FAILED) return CLAIM_STATUS.NEEDS_DOCUMENTATION;
  if (status === STAGE_STATUS.BLOCKED) return CLAIM_STATUS.BLOCKED;
  if (Number(costs.approvedUSD) > 0 && Number(costs.claimedUSD) > 0) return CLAIM_STATUS.APPROVED;
  return CLAIM_STATUS.PENDING;
}

/**
 * A recorded amount, or null.
 *
 * `Number(null)` is 0 and finite, so the null check has to come first — without it every claim
 * with nothing approved yet reported "$0 approved", which is a decision rather than an absence.
 */
const money = value => (value == null || value === '' || !Number.isFinite(Number(value))
  ? null : Number(value));

/**
 * The claims, as records, from the built demo-case records.
 *
 * One claim per case, because every case carries a claim block — including the ones that have not
 * reached the claim stage, which appear as PENDING with no claimed amount rather than being left
 * out. Leaving them out would make the pipeline look shorter than it is.
 */
export function claimRecords(demoRecords = []) {
  return Object.freeze((demoRecords ?? []).map(record => {
    const demoCase = record.demoCase;
    const claim = demoCase?.claim ?? {};
    const costs = claim.costs ?? {};
    const claimStage = record.evaluation?.stages?.CLAIM ?? null;
    const status = claimStatusOf(claim, claimStage);
    const claimedUSD = money(costs.claimedUSD);
    const recoveredUSD = money(costs.recoveredUSD);
    return Object.freeze({
      /** Prefixed DEMO- in the case file so it can never be mistaken for a production reference. */
      claimReference: claim.claimReference ?? null,
      demoCaseId: record.id,
      status,
      statusLabel: CLAIM_STATUS_LABELS[status],
      submission: claim.submission ?? null,
      assetId: demoCase?.asset?.assetId ?? null,
      assetName: demoCase?.asset?.assetName ?? null,
      assetType: demoCase?.asset?.assetType ?? null,
      /** The real incident the case's location came from — the only non-synthetic identifier here. */
      sourceIncidentId: record.related?.sourceIncidentId ?? null,
      sourceIncidentRelationship: record.related?.sourceIncidentId ? ASSOCIATION.CONFIRMED : ASSOCIATION.UNLINKED,
      incidentType: demoCase?.incident?.incidentType ?? null,
      // The register writes an unknown segment as "-", which is not a segment name.
      segment: segmentOf(record),
      reportedAt: demoCase?.incident?.reportedAt ?? null,
      estimatedUSD: money(costs.estimatedUSD),
      approvedUSD: money(costs.approvedUSD),
      claimedUSD,
      recoveredUSD,
      /** What is still out: claimed and not yet recovered. Null when nothing has been claimed. */
      outstandingUSD: claimedUSD == null ? null : claimedUSD - (recoveredUSD ?? 0),
      costBasis: claim.costBasis ?? null,
      longitude: record.longitude ?? null,
      latitude: record.latitude ?? null,
      /** Never absent, so no surface can draw a claim without being able to mark it. */
      demo: true,
      demoLabel: record.demoLabel,
      evaluation: record.evaluation,
    });
  }));
}

const sum = (claims, key) => claims.reduce((total, claim) => total + (claim[key] ?? 0), 0);

/**
 * The claims figures.
 *
 * `demo: true` travels with them, because all of them are. A money figure is the sum of what is
 * recorded; a claim with nothing recorded contributes nothing rather than an estimate standing in
 * for a claimed amount.
 */
export function claimsKpis(claims = []) {
  const count = status => claims.filter(claim => claim.status === status).length;
  return Object.freeze({
    total: claims.length,
    pending: count(CLAIM_STATUS.PENDING),
    needsDocumentation: count(CLAIM_STATUS.NEEDS_DOCUMENTATION),
    approved: count(CLAIM_STATUS.APPROVED),
    settled: count(CLAIM_STATUS.SETTLED),
    blocked: count(CLAIM_STATUS.BLOCKED),
    estimatedUSD: sum(claims, 'estimatedUSD'),
    claimedUSD: sum(claims, 'claimedUSD'),
    recoveredUSD: sum(claims, 'recoveredUSD'),
    /** Claimed and not yet back. Not an estimate of what will be recovered. */
    outstandingUSD: sum(claims, 'claimedUSD') - sum(claims, 'recoveredUSD'),
    demo: true,
  });
}

/** What the claims analysis can be cut by. Each reads a recorded field of the claim. */
export const CLAIM_DIMENSIONS = Object.freeze([
  Object.freeze({ id: 'assetType', label: 'Asset category', of: claim => claim.assetType }),
  Object.freeze({ id: 'segment', label: 'Corridor segment', of: claim => claim.segment }),
  Object.freeze({ id: 'incidentType', label: 'Incident type', of: claim => claim.incidentType }),
  Object.freeze({ id: 'status', label: 'Claim status', of: claim => claim.statusLabel }),
]);

export const claimDimensionById = id =>
  CLAIM_DIMENSIONS.find(entry => entry.id === id) ?? CLAIM_DIMENSIONS[0];

/**
 * Claims grouped by one dimension, with the money that goes with each group.
 *
 * Sorted by claimed amount and then by count, because the question this answers is "where is the
 * money going", and a group with nothing claimed yet still appears with its estimate.
 */
export function claimsBy(claims = [], dimension) {
  const read = dimension?.of ?? (claim => claim.statusLabel);
  const groups = new Map();
  for (const claim of claims) {
    const raw = read(claim);
    const value = raw == null || String(raw).trim() === '' ? 'Not recorded' : String(raw).trim();
    const group = groups.get(value) ?? { value, count: 0, estimatedUSD: 0, claimedUSD: 0, recoveredUSD: 0, assets: new Set() };
    group.count += 1;
    group.estimatedUSD += claim.estimatedUSD ?? 0;
    group.claimedUSD += claim.claimedUSD ?? 0;
    group.recoveredUSD += claim.recoveredUSD ?? 0;
    if (claim.assetId) group.assets.add(claim.assetId);
    groups.set(value, group);
  }
  const of = claims.length;
  return Object.freeze([...groups.values()]
    .map(group => Object.freeze({ ...group, of, assets: group.assets.size,
      share: of ? group.count / of : 0 }))
    .sort((a, b) => b.claimedUSD - a.claimedUSD || b.count - a.count
      || String(a.value).localeCompare(String(b.value))));
}

/**
 * Assets more than one claim names.
 *
 * On the seven demonstration cases each asset is distinct, so this is empty — and it says so
 * rather than showing a chart with nothing in it. The function is here because it is the analysis
 * the corridor needs the day real claims arrive, and it is the same shape as `repeatedDamage`.
 */
export function repeatedClaims(claims = []) {
  const byAsset = new Map();
  for (const claim of claims) {
    if (!claim.assetId) continue;
    const list = byAsset.get(claim.assetId) ?? [];
    list.push(claim);
    byAsset.set(claim.assetId, list);
  }
  return Object.freeze([...byAsset]
    .filter(([, list]) => list.length > 1)
    .map(([assetId, list]) => Object.freeze({
      assetId, assetName: list[0].assetName, count: list.length,
      claimedUSD: sum(list, 'claimedUSD'), recoveredUSD: sum(list, 'recoveredUSD'),
      demoCaseIds: Object.freeze(list.map(claim => claim.demoCaseId).sort()),
    }))
    .sort((a, b) => b.count - a.count || b.claimedUSD - a.claimedUSD));
}

/**
 * What a claim adds to the history of its asset.
 *
 * This is the "claims as an intelligence source" reading: for one asset, what has been claimed
 * against it, what came back, and which incidents are behind it. The link to the incident is the
 * case's own source incident id — a recorded identifier, never a proximity guess.
 */
export function claimHistoryFor(assetId, claims = []) {
  const mine = claims.filter(claim => claim.assetId === assetId);
  if (!mine.length) return null;
  return Object.freeze({
    assetId,
    claims: Object.freeze(mine),
    count: mine.length,
    claimedUSD: sum(mine, 'claimedUSD'),
    recoveredUSD: sum(mine, 'recoveredUSD'),
    incidentIds: Object.freeze([...new Set(mine.map(claim => claim.sourceIncidentId).filter(Boolean))]),
    demo: true,
  });
}

/**
 * US dollars, whole, with the thousands separator the rest of the app uses.
 *
 * `null` is not zero. `Number(null)` is 0 and finite, so the null check has to come first —
 * without it a claim with nothing recorded printed "$0", which is a claim for nothing rather than
 * no claim.
 */
export const usd = value => (value == null || value === '' || !Number.isFinite(Number(value))
  ? '\u2014' : `$${Math.round(Number(value)).toLocaleString('en-US')}`);

/**
 * Everything the inline claim detail shows, for one case.
 *
 * Built from the claim record and the case's own CLAIM stage, so the findings here are the ones
 * the validation engine produced rather than a second opinion about the same claim.
 */
export function claimDossier(record, claim) {
  const evaluation = record?.evaluation ?? null;
  const stage = evaluation?.stages?.CLAIM ?? null;
  const fields = stage?.findings ?? [];
  const blocking = STAGE_ORDER.find(key => evaluation?.statuses?.[key] !== STAGE_STATUS.PASSED) ?? null;

  return Object.freeze({
    claim,
    /** The identifiers that tie the four records together. Recorded, never inferred. */
    links: Object.freeze({
      claimReference: claim.claimReference,
      caseId: claim.demoCaseId,
      sourceIncidentId: claim.sourceIncidentId,
      assetId: claim.assetId,
      assetName: claim.assetName,
      incidentType: claim.incidentType,
      /** The real incident's own type, which is not the case's. */
      sourceIncidentType: evaluation?.location?.sourceIncidentType ?? null,
    }),
    financial: Object.freeze({
      estimatedUSD: claim.estimatedUSD, approvedUSD: claim.approvedUSD,
      claimedUSD: claim.claimedUSD, recoveredUSD: claim.recoveredUSD,
      outstandingUSD: claim.outstandingUSD,
      /** Claimed against approved. A gap is a reconciliation question, not an error on its own. */
      varianceUSD: claim.claimedUSD == null || claim.approvedUSD == null
        ? null : claim.claimedUSD - claim.approvedUSD,
      basis: claim.costBasis,
    }),
    /** What the claim actually holds — the stage fields that passed, with their values. */
    evidence: Object.freeze(fields.filter(field => field.status === STATUS.PASS)
      .map(field => Object.freeze({ fieldId: field.fieldId, label: field.label, value: field.value }))),
    /** What the engine found wrong or absent. Our validation, not an insurer's decision. */
    findings: Object.freeze(fields.filter(field =>
      field.status === STATUS.FAIL || (field.status === STATUS.MISSING && field.required))
      .map(field => Object.freeze({
        fieldId: field.fieldId, label: field.label, status: field.status, message: field.message ?? null,
      }))),
    /** Nothing is outstanding on a claim an earlier stage is holding; that stage is. */
    outstanding: Object.freeze({
      blockingStage: blocking,
      isClaimStage: blocking === 'CLAIM',
      action: evaluation?.nextAction?.text ?? null,
      role: record?.demoCase?.workflow?.assignedRole?.replace(/_/g, ' ') ?? null,
      team: record?.demoCase?.workflow?.assignedTeam ?? null,
    }),
    demo: true,
  });
}
