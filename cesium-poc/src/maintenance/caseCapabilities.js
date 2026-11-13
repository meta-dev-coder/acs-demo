/**
 * The read-only capabilities Ask the Twin uses to investigate an ACS case.
 *
 * WHY THESE ARE CLIENT-SIDE, which the audit settled before anything was written: the server's
 * tool layer (`server/liveDc/askTools.mjs`) reads DataConnect, and none of this material is in
 * DataConnect. The seven cases come from a committed JSON file, their stage statuses come from
 * `qcqa/stageValidation.js` and `qcqa/validationEngine.js`, their evidence search comes from
 * `acs/evidence/orchestrator.js`, and their incident context from `acs/incidentContext.js` — all of
 * which run in the browser against the records the screen is already showing. A server tool named
 * `get_case_validation` would be a tool the server could not run.
 *
 * So these join the existing client registry in `twin/capabilities.js`, in its shape, with its
 * `ok`/`unavailable` results and its provenance vocabulary. The consequence worth stating: an
 * answer and the Case Workbench can never disagree, because they are the same call.
 *
 * Nothing here writes. There is no approve, submit, close or attach — a recovered candidate is
 * reported as a candidate and the stage status is left exactly as the engine derived it.
 */
import { ok, unavailable, PROVENANCE } from '../twin/capabilities.js';
import { STAGE_LABELS, STAGE_ORDER, STAGE_STATUS } from '../qcqa/stageValidation.js';
import { STATUS } from '../qcqa/schema.js';
import {
  actionRequiredOf, bucketCounts, filterQueue, headerOf, lastActivityOf, QUEUE_FILTERS, queueRow,
  validationTimeline,
} from './caseWorkbenchModel.js';
import { CLAIM_STATUS, claimDossier, claimsBy, claimsKpis, claimDimensionById, repeatedClaims, usd } from './claimsIntelligence.js';
import {
  ASSOCIATION, ASSOCIATION_LABELS, CANDIDATE_RADIUS_M, associateIncident, associateIncidents,
  associationCounts, operationsKpis, repeatedDamage, severityOf,
} from './assetOpsModel.js';
import { metresBetween } from '../assetExplorer/corridorPosition.js';
import { maintenanceDateKey } from '../assetExplorer/assetTypes.js';

/** A calendar day key as milliseconds, so two days can be compared. Null stays null. */
const dayMs = key => (key ? Date.parse(`${key}T00:00:00Z`) || null : null);

/** Every synthetic answer says so, in one sentence, in one place. */
const SYNTHETIC_NOTE = 'This case is SYNTHETIC demonstration data. The damage, inspection, repair, '
  + 'QC/QA and claim did not happen, and none of its figures belong in a production total.';

/** What a recovered candidate is, and is not. Repeated nowhere else. */
const CANDIDATE_NOTE = 'A candidate record is a possible match for a human to confirm or reject. '
  + 'Nothing has been attached, and no stage status has changed because a candidate was found.';

const evidenceOf = (entityType, entityId, source, timestamp = null) =>
  Object.freeze({ source, entityType, entityId: String(entityId), timestamp });

/** How far either side of the case's own incident "nearby" reaches, unless asked otherwise. */
export const NEARBY_RADIUS_M = 500;
/**
 * And how long, in DAYS rather than hours.
 *
 * The register publishes `incident_date` at day granularity — a 72-hour window would be filtering
 * on precision the records do not carry. Three days either side, and the answer says so.
 */
export const NEARBY_WINDOW_DAYS = 3;

const stageKeyOf = value => {
  const wanted = String(value ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (!wanted) return null;
  return STAGE_ORDER.find(stage => stage === wanted)
    ?? STAGE_ORDER.find(stage => stage.startsWith(wanted.slice(0, 4)))
    ?? (wanted.startsWith('QA') || wanted.startsWith('QC') ? 'QCQA' : null);
};

/**
 * Build the case capabilities against the workspace's own services.
 *
 * @param {object} assetOps the adapter `maintenanceWorkspace` returns from `askServices()`
 */
export function createCaseCapabilities(assetOps = null) {
  /**
   * Resolve a case id to the record the screen holds.
   *
   * The id may come from the model, so it is never trusted: it is looked up, and an id that
   * resolves to nothing is reported as unknown rather than answered about. With no id at all the
   * selected case is used, which is what makes "why did inspection fail?" work with no id typed.
   */
  const resolve = input => {
    if (!assetOps) return { error: 'The Asset Operations workspace is not loaded.' };
    const wanted = input?.caseId ? String(input.caseId).trim() : assetOps.selectedCaseId?.() ?? null;
    if (!wanted) {
      return { error: 'No case is selected and no case id was given, so there is nothing to read. '
        + 'Pick a case in the queue first.' };
    }
    const record = assetOps.caseOf?.(wanted) ?? null;
    if (!record) {
      const known = (assetOps.cases?.() ?? []).map(entry => entry.id);
      return { error: `There is no case ${wanted} on this screen.`
        + (known.length ? ` The cases loaded are: ${known.join(', ')}.` : '') };
    }
    return { record };
  };

  /** The same frozen shell every case answer carries: who it is about and that it is synthetic. */
  const about = record => Object.freeze({
    caseId: record.id,
    isSynthetic: record.demo !== false,
    demoLabel: record.demoLabel ?? null,
  });

  const DEFINITIONS = {
    /* ── the case ──────────────────────────────────────────────────────────────────────────── */
    get_case_summary: {
      category: 'ACS_CASE',
      description: 'One ACS case: its incident, the affected asset, the stage it is held at, its '
        + 'overall status, the outstanding action and where each part came from.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'EITHER',
      handler(input = {}) {
        const { record, error } = resolve(input);
        if (error) return unavailable(error);
        // The workbench's own header and action section, not a second reading of the same case.
        const header = headerOf(record, { positionOf: assetOps.positionOf ?? null });
        const action = actionRequiredOf(record);
        return ok({
          data: {
            ...about(record),
            incident: Object.freeze({
              type: record.demoCase.incident.incidentType,
              reportedAt: record.demoCase.incident.reportedAt,
              severity: record.demoCase.incident.severity,
              description: record.demoCase.incident.description,
            }),
            asset: Object.freeze({
              assetId: record.demoCase.asset.assetId,
              assetType: record.demoCase.asset.assetType,
              assetName: record.demoCase.asset.assetName,
              /** Null on every demo case: the asset is synthetic too, and nothing is inferred. */
              sourceAssetId: record.demoCase.asset.sourceAssetId ?? null,
            }),
            location: header.location,
            status: header.status,
            overall: record.evaluation.overall,
            blockingStage: header.blockingStage,
            blockingStageLabel: header.blockingStageLabel,
            stages: header.stages.map(stage => ({
              key: stage.key, label: stage.label, status: stage.status,
              blockedBy: stage.blockedBy, counts: stage.counts,
            })),
            outstanding: Object.freeze({
              action: action.action,
              recommended: action.recommended,
              role: action.role, team: action.team,
              failed: action.failed.length, missing: action.counts.missing,
              nonConformancesOpen: action.nonConformances.length,
            }),
            provenanceNote: record.demo !== false ? SYNTHETIC_NOTE : null,
          },
          evidence: [
            evidenceOf('acsDemoCase', record.id, 'data/acs-demo-cases.json (synthetic)'),
            ...(header.location.sourceIncidentId
              ? [evidenceOf('incident', header.location.sourceIncidentId, 'DataConnect incident register')]
              : []),
          ],
          provenance: PROVENANCE.SIMULATED,
          limitations: [
            SYNTHETIC_NOTE,
            'Only the LOCATION is real: it is borrowed from an incident in the corridor register, '
              + 'and the synthetic damage did not occur there.',
            'Every stage status is derived by the shared validation engine from the recorded field '
              + 'data — none is declared by the case file.',
          ],
          actions: [
            { type: 'VIEW_CASE_ON_MAP', caseId: record.id, label: `Show ${record.id} on the map` },
            { type: 'SHOW_AUDIT_HISTORY', caseId: record.id, label: 'Show the audit history' },
          ],
        });
      },
    },

    get_case_validation: {
      category: 'ACS_CASE',
      description: 'A case\'s validation: each stage\'s checks, what failed, what is missing, the '
        + 'rule and message behind each finding, and the corrective action.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'EITHER',
      handler(input = {}) {
        const { record, error } = resolve(input);
        if (error) return unavailable(error);
        const wanted = stageKeyOf(input.stage);
        if (input.stage && !wanted) {
          return unavailable(`"${input.stage}" is not one of the four stages `
            + `(${STAGE_ORDER.join(', ')}).`);
        }
        const timeline = validationTimeline(record).filter(stage => !wanted || stage.key === wanted);
        const evaluation = record.evaluation;
        const review = evaluation.review;
        return ok({
          data: {
            ...about(record),
            stages: timeline.map(stage => ({
              key: stage.key, label: stage.label, status: stage.status,
              /** Blocked is not failed, and the gate is named so an answer cannot blur them. */
              gatedBy: stage.gatedBy,
              summary: stage.summary,
              failed: stage.findings.filter(field => field.status === STATUS.FAIL)
                .map(field => ({ fieldId: field.fieldId, label: field.label, message: field.message ?? null,
                  rule: field.rule ?? null, value: field.value ?? null })),
              missing: stage.findings.filter(field => field.status === STATUS.MISSING && field.required)
                .map(field => ({ fieldId: field.fieldId, label: field.label, message: field.message ?? null })),
              pending: stage.findings.filter(field => field.status === STATUS.PENDING)
                .map(field => ({ fieldId: field.fieldId, label: field.label })),
              passed: stage.findings.filter(field => field.status === STATUS.PASS)
                .map(field => ({ fieldId: field.fieldId, label: field.label, value: field.value ?? null })),
            })),
            /** The checklist the case declares, beside what the selection engine would choose. */
            checklist: Object.freeze({
              declared: evaluation.checklist.declared,
              declaredTitle: evaluation.checklist.declaredTitle,
              engineWouldSelect: evaluation.checklist.engineSelection?.selectedTemplates ?? [],
              agrees: evaluation.checklist.agrees,
            }),
            nonConformances: (record.demoCase.qualityAssurance?.nonConformances ?? [])
              .map(entry => ({ id: entry.id ?? null, status: entry.status,
                description: entry.description ?? null, correctiveAction: entry.correctiveAction ?? null })),
            correctiveAction: evaluation.nextAction.text,
            reviewRun: Boolean(review),
            provenanceNote: record.demo !== false ? SYNTHETIC_NOTE : null,
          },
          evidence: [evidenceOf('acsDemoCase', record.id, 'qcqa validation engine')],
          provenance: PROVENANCE.SIMULATED,
          limitations: [
            SYNTHETIC_NOTE,
            'A BLOCKED stage has no findings of its own: an earlier stage is holding it, and the '
              + 'gate is named. It has not been checked and found wanting.',
            'PENDING means required, not recorded and not yet due. It is not a failure.',
            ...(review ? [] : ['The QC/QA checklist has not been submitted, so the checklist engine '
              + 'was not run — its checks are not reported as passing or failing.']),
          ],
          actions: timeline.filter(stage => stage.status !== STAGE_STATUS.PASSED).map(stage => ({
            type: 'OPEN_VALIDATION_STAGE', caseId: record.id, stage: stage.key,
            label: `Open the ${stage.label} stage`,
          })),
        });
      },
    },

    get_case_evidence: {
      category: 'ACS_CASE',
      description: 'What evidence a case holds and what it is short of: each record\'s source '
        + 'system, the validation field it answers, its verification status, and the gaps.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'EITHER',
      handler(input = {}) {
        const { record, error } = resolve(input);
        if (error) return unavailable(error);
        const wanted = stageKeyOf(input.stage);
        const timeline = validationTimeline(record).filter(stage => !wanted || stage.key === wanted);
        const held = [];
        const missing = [];
        for (const stage of timeline) {
          for (const field of stage.findings) {
            if (field.status === STATUS.PASS && field.value != null) {
              held.push({ stage: stage.key, fieldId: field.fieldId, label: field.label,
                value: field.value, verification: 'RECORDED_IN_CASE' });
            }
            if (field.status === STATUS.MISSING && field.required) {
              missing.push({ stage: stage.key, fieldId: field.fieldId, label: field.label,
                message: field.message ?? null, verification: 'NOT_HELD' });
            }
          }
        }
        const lineage = record.demoCase.evidenceRecovery?.lineage ?? [];
        const notRecoverable = record.demoCase.evidenceRecovery?.notRecoverable ?? [];
        return ok({
          data: {
            ...about(record),
            held: Object.freeze(held),
            missing: Object.freeze(missing),
            /** Where evidence the case already holds came from, where the case records it. */
            lineage: Object.freeze(lineage.map(entry => ({ ...entry }))),
            /** Fields no recovered record may ever satisfy, and why. Policy, not confidence. */
            humanOnly: Object.freeze(notRecoverable.map(entry => ({ ...entry }))),
            counts: Object.freeze({ held: held.length, missing: missing.length,
              humanOnly: notRecoverable.length }),
            provenanceNote: record.demo !== false ? SYNTHETIC_NOTE : null,
          },
          evidence: [evidenceOf('acsDemoCase', record.id, 'data/acs-demo-cases.json (synthetic)')],
          provenance: PROVENANCE.SIMULATED,
          limitations: [
            SYNTHETIC_NOTE,
            'This is what the case file holds. Nothing has been searched for — use '
              + 'search_missing_evidence to ask the connected systems.',
          ],
          actions: missing.length
            ? [{ type: 'SHOW_MISSING_EVIDENCE', caseId: record.id, label: 'Show the missing evidence' }]
            : [],
        });
      },
    },

    get_case_activity: {
      category: 'ACS_CASE',
      description: 'A case\'s audit trail: status changes, reviews, evidence events and their times.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'EITHER',
      handler(input = {}) {
        const { record, error } = resolve(input);
        if (error) return unavailable(error);
        const trail = record.demoCase.auditTrail ?? [];
        return ok({
          data: {
            ...about(record),
            entries: Object.freeze(trail.map(entry => ({ ...entry }))),
            firstActivity: trail[0]?.at ?? null,
            lastActivity: lastActivityOf(record.demoCase),
            total: trail.length,
            provenanceNote: record.demo !== false ? SYNTHETIC_NOTE : null,
          },
          evidence: [evidenceOf('acsDemoCase', record.id, 'data/acs-demo-cases.json (synthetic)')],
          provenance: PROVENANCE.SIMULATED,
          limitations: [
            SYNTHETIC_NOTE,
            'Every actor, role and timestamp in this trail is invented for the demonstration.',
            ...(trail.length ? [] : ['This case records no audit trail.']),
          ],
          actions: trail.length
            ? [{ type: 'SHOW_AUDIT_HISTORY', caseId: record.id, label: 'Show the audit history' }]
            : [],
        });
      },
    },

    get_case_claim: {
      category: 'ACS_CASE',
      description: 'A case\'s claim: status, estimated, claimed, approved and recovered amounts, '
        + 'the documents it holds and what is outstanding.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'EITHER',
      handler(input = {}) {
        const { record, error } = resolve(input);
        if (error) return unavailable(error);
        const claim = assetOps.claimOf?.(record.id) ?? null;
        if (!claim) return unavailable(`No claim record was assembled for ${record.id}.`);
        const dossier = claimDossier(record, claim);
        return ok({
          data: {
            ...about(record),
            claimReference: claim.claimReference,
            status: claim.status,
            statusLabel: claim.statusLabel,
            submission: claim.submission,
            /** Five distinct figures. Collapsing them is how a claim looks settled when it is not. */
            financial: Object.freeze({
              estimatedUSD: claim.estimatedUSD,
              claimedUSD: claim.claimedUSD,
              approvedUSD: claim.approvedUSD,
              recoveredUSD: claim.recoveredUSD,
              outstandingUSD: claim.outstandingUSD,
              varianceUSD: dossier.financial.varianceUSD,
              basis: claim.costBasis,
              formatted: Object.freeze({
                estimated: usd(claim.estimatedUSD), claimed: usd(claim.claimedUSD),
                approved: usd(claim.approvedUSD), recovered: usd(claim.recoveredUSD),
                outstanding: usd(claim.outstandingUSD),
              }),
            }),
            documents: dossier.evidence,
            findings: dossier.findings,
            outstanding: dossier.outstanding,
            provenanceNote: SYNTHETIC_NOTE,
          },
          evidence: [evidenceOf('claim', claim.claimReference ?? record.id, 'data/acs-demo-cases.json (synthetic)')],
          provenance: PROVENANCE.SIMULATED,
          limitations: [
            SYNTHETIC_NOTE,
            'There is no insurer in this demonstration. "Requires documentation" means OUR '
              + 'validation found the claim short — nobody rejected it.',
            'A null amount is not zero: it means nothing has been recorded under that heading yet.',
          ],
          actions: [{ type: 'OPEN_CLAIM', caseId: record.id, label: `Open the claim for ${record.id}` }],
        });
      },
    },

    /* ── Operations Overview: the corridor's own records, not the synthetic cases ──────────── */
    get_operations_overview: {
      category: 'ACS_OPERATIONS',
      description: 'The Operations Overview figures for the corridor: incident-to-asset links, '
        + 'assets with repeated damage, open repairs and unresolved inspection issues, each with '
        + 'the basis it was counted on.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'EITHER',
      handler() {
        const incidents = assetOps?.incidents?.() ?? [];
        const assets = assetOps?.assets?.() ?? new Map();
        if (!incidents.length && !assets.size) {
          return unavailable('The incident register and the asset registry are not loaded yet.');
        }
        const workOrders = assetOps?.recordsOf?.('workOrder') ?? [];
        const inspections = assetOps?.recordsOf?.('inspection') ?? [];
        const associations = associateIncidents(incidents, assets);
        // The screen's own model, not a second count of the same records.
        const kpis = operationsKpis({ incidents, associations, workOrders, inspections, assets });
        return ok({
          data: {
            incidents: incidents.length,
            assets: assets.size,
            kpis: kpis.map(entry => ({ id: entry.id, label: entry.label, value: entry.value,
              available: entry.available, basis: entry.basis, note: entry.note, demo: entry.demo })),
            associations: associationCounts(associations),
            repeatedDamage: repeatedDamage(associations, assets, incidents)
              .map(entry => ({ ...entry, incidentIds: [...entry.incidentIds] })),
            candidateRadiusM: CANDIDATE_RADIUS_M,
          },
          evidence: [evidenceOf('incidentRegister', 'Florida I595 Incidents', 'DataConnect')],
          provenance: PROVENANCE.OBSERVED,
          limitations: [
            'These are the corridor\'s own records. The seven synthetic ACS cases are NOT counted '
              + 'in any of them.',
            `A CANDIDATE link is proximity only — an asset within ${CANDIDATE_RADIUS_M} m, offered `
              + 'for review. It is not counted as asset-linked and nothing classifies it as damaged.',
            'Unresolved inspection issues are INFERRED: the inspection and work-order classes share '
              + 'no reference, so the link is deduced from asset id and date.',
            ...kpis.filter(entry => !entry.available).map(entry => `${entry.label}: ${entry.note}`),
          ],
        });
      },
    },

    /* ── the queue ─────────────────────────────────────────────────────────────────────────── */
    search_cases: {
      category: 'ACS_CASE',
      description: 'The case queue: which cases need action, are in progress or are closed, which '
        + 'stage is holding each one up, and how many sit in each bucket.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'EITHER',
      handler(input = {}) {
        const all = assetOps?.cases?.() ?? [];
        if (!all.length) {
          return unavailable(assetOps?.claimsUnavailable?.()
            ?? 'No ACS cases are loaded on this screen.');
        }
        const bucket = input.bucket ? String(input.bucket).trim().toLowerCase() : null;
        if (bucket && !QUEUE_FILTERS.some(filter => filter.id === bucket)) {
          return unavailable(`"${input.bucket}" is not one of the queue's buckets `
            + `(${QUEUE_FILTERS.map(filter => filter.id).join(', ')}).`);
        }
        const stage = stageKeyOf(input.stage);
        if (input.stage && !stage) {
          return unavailable(`"${input.stage}" is not one of the four stages (${STAGE_ORDER.join(', ')}).`);
        }
        // The queue's own row and the queue's own filter. The assistant reads the list the
        // operator is looking at, rather than re-deciding what each case's state is.
        const rows = all.map(record => queueRow(record, { positionOf: assetOps.positionOf ?? null }));
        const matches = filterQueue(rows, {
          bucket, stage,
          assetType: input.assetType ?? null,
          incidentType: input.incidentType ?? null,
          query: input.query ?? null,
        });
        // Which stage is holding up the most. Counted, never written down.
        const byStage = STAGE_ORDER
          .map(key => ({ stage: key, label: STAGE_LABELS[key],
            count: rows.filter(row => row.blockingStage === key).length }))
          .filter(entry => entry.count > 0)
          .sort((a, b) => b.count - a.count);
        return ok({
          data: {
            total: matches.length,
            of: rows.length,
            counts: bucketCounts(rows),
            byBlockingStage: Object.freeze(byStage),
            cases: matches.map(row => ({
              caseId: row.caseId, status: row.status, bucket: row.bucket,
              assetType: row.assetType, incidentType: row.incidentType,
              segment: row.segment, corridorMile: row.corridorMile,
              blockingStage: row.blockingStage, blockingStageLabel: row.blockingStageLabel,
              lastActivity: row.lastActivity, reportedAt: row.reportedAt,
            })),
            demo: true,
          },
          filtersApplied: { bucket, stage, assetType: input.assetType ?? null,
            incidentType: input.incidentType ?? null, query: input.query ?? null },
          evidence: matches.slice(0, 10)
            .map(row => evidenceOf('acsDemoCase', row.caseId, 'data/acs-demo-cases.json (synthetic)')),
          provenance: PROVENANCE.SIMULATED,
          limitations: [
            'All seven cases are synthetic demonstration data. This queue is not a corridor '
              + 'maintenance backlog and none of its counts belongs in an operational total.',
            '"Needs action" means a FAILURE is holding the case. A case merely waiting on '
              + 'unfinished work is "in progress" — nobody is late.',
            'The blocking stage is the first stage that has not passed, as the validation engine '
              + 'derived it.',
          ],
          actions: matches.slice(0, 3).map(row => ({
            type: 'OPEN_RELATED_CASE', caseId: row.caseId, label: `Open ${row.caseId}`,
          })),
        });
      },
    },

    /* ── evidence discovery ────────────────────────────────────────────────────────────────── */
    search_missing_evidence: {
      category: 'ACS_EVIDENCE',
      description: 'Search the connected systems (Office Track, MIMS, DataConnect, SunGuide) for '
        + 'records that could fill a case\'s validation gaps. Read-only: it proposes candidates '
        + 'and attaches nothing.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'EITHER',
      async handler(input = {}) {
        const { record, error } = resolve(input);
        if (error) return unavailable(error);
        if (!assetOps.searchEvidence) {
          return unavailable('The evidence connectors are not available in this session.');
        }
        const recovery = await assetOps.searchEvidence(record);
        const wantedField = input.fieldId ? String(input.fieldId).trim() : null;
        const wantedSystem = input.sourceSystem ? String(input.sourceSystem).trim().toUpperCase() : null;
        let gaps = recovery.gaps;
        if (wantedField) gaps = gaps.filter(gap => gap.fieldId === wantedField);
        if (wantedField && !gaps.length) {
          return unavailable(`${wantedField} is not one of this case's missing fields. `
            + `Its gaps are: ${recovery.gaps.map(gap => gap.fieldId).join(', ') || 'none'}.`);
        }
        const candidateOf = candidate => ({
          recordId: candidate.recordId,
          system: candidate.system,
          origin: candidate.origin,
          tier: candidate.tier,
          confidence: candidate.confidence,
          /** The rules that fired, in their own words — never a bare score. */
          matchedRules: (candidate.matchedRules ?? []).map(rule => rule.label),
          explanation: candidate.explanation ?? null,
          warnings: (candidate.warnings ?? []).map(warning => warning.text),
          /** Always. Nothing found by a search is verified by having been found. */
          verification: 'UNVERIFIED_CANDIDATE',
          requiresHumanReview: true,
        });
        return ok({
          data: {
            ...about(record),
            searches: recovery.searches.map(search => ({
              system: search.system, label: search.label,
              /** UNAVAILABLE is the contract's SOURCE_UNAVAILABLE: no endpoint, not "nothing found". */
              status: search.status, origin: search.origin,
              records: search.count, error: search.error ?? null,
            })),
            gaps: gaps.map(gap => ({
              stage: gap.stage, fieldId: gap.fieldId, label: gap.label,
              evidenceType: gap.evidenceType,
              reason: gap.reason,
              humanOnly: gap.humanOnly ?? null,
              resolvable: gap.resolvable,
              requiresReview: gap.requiresReview ?? false,
              reviewReason: gap.reviewReason ?? null,
              best: gap.best ? candidateOf(gap.best) : null,
              candidates: (wantedSystem
                ? gap.candidates.filter(candidate => candidate.system === wantedSystem)
                : gap.candidates).map(candidateOf),
            })),
            enrichment: recovery.enrichment.map(entry => ({
              recordId: entry.recordId, system: entry.system, origin: entry.origin,
              summary: entry.summary ?? null,
            })),
            summary: recovery.summary,
            provenanceNote: SYNTHETIC_NOTE,
          },
          evidence: [evidenceOf('acsDemoCase', record.id, 'evidence connectors')],
          // Genuinely mixed: the DataConnect connector queries real loaded records; Office Track,
          // MIMS and SunGuide have no endpoint here and answer with deterministic stand-ins.
          provenance: PROVENANCE.MIXED,
          limitations: [
            CANDIDATE_NOTE,
            'A found candidate does NOT make a failed inspection or QC/QA stage pass. The stage '
              + 'status is unchanged.',
            'Only the DataConnect connector queries real data. Office Track, MIMS and SunGuide '
              + 'have no endpoint or credentials in this deployment and answer with synthetic '
              + 'stand-ins, stamped as such.',
            ...recovery.searches.filter(search => search.status !== 'OK' && search.status !== 'NO_MATCH')
              .map(search => `${search.label}: SOURCE_UNAVAILABLE${search.error ? ` — ${search.error}` : ''}.`),
            ...(recovery.summary.humanOnly
              ? [`${recovery.summary.humanOnly} field(s) cannot be satisfied by any recovered record `
                + 'as a matter of policy — they need a person.'] : []),
          ],
          actions: gaps.length
            ? [{ type: 'SHOW_MISSING_EVIDENCE', caseId: record.id, label: 'Show the missing evidence' }]
            : [],
        });
      },
    },

    /* ── incident context ──────────────────────────────────────────────────────────────────── */
    get_incident_weather: {
      category: 'ACS_CONTEXT',
      description: 'The weather at the case incident\'s coordinates and hour, from the Open-Meteo '
        + 'historical service, with units, the matched observation time and its provenance.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'HISTORICAL',
      async handler(input = {}) {
        const { record, error } = resolve(input);
        if (error) return unavailable(error);
        if (!assetOps.readContext) return unavailable('The incident context service is not available.');
        const context = await assetOps.readContext(record);
        const weather = context.weather;
        if (!weather.available) return unavailable(weather.unavailableReason);
        return ok({
          data: {
            ...about(record),
            requestedFor: context.incidentAt,
            matchedObservationAt: weather.reading.matchedWeatherTime,
            localHour: context.incidentHourLabel,
            observations: weather.observations.map(entry => ({
              label: entry.label, value: entry.value, unit: entry.unit,
              source: entry.source, quality: entry.quality, spatialMatch: entry.spatialMatch,
              observedAt: entry.observedAt, note: entry.note,
            })),
            provenance: weather.provenance,
            coordinates: context.location,
            implications: context.implications,
          },
          evidence: [evidenceOf('weather', weather.reading.matchedWeatherTime, weather.reading.source,
            weather.reading.matchedWeatherTime)],
          // The reading is real, which is why this one is OBSERVED rather than SIMULATED.
          provenance: PROVENANCE.OBSERVED,
          limitations: [
            'This is a MODELLED reanalysis value at a weather-model grid cell, not a roadside '
              + 'sensor reading at the incident.',
            'The case is synthetic; the coordinates and the hour it was asked about are the real '
              + 'source incident\'s.',
            'Nothing here claims the weather caused the damage.',
          ],
        });
      },
    },

    get_incident_traffic: {
      category: 'ACS_CONTEXT',
      description: 'What is actually known about traffic at the case incident\'s hour: the '
        + 'register\'s own lane-closure, injury and fatality flags, the segment\'s published annual '
        + 'average, and which measurements no connected system holds.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'HISTORICAL',
      async handler(input = {}) {
        const { record, error } = resolve(input);
        if (error) return unavailable(error);
        if (!assetOps.readContext) return unavailable('The incident context service is not available.');
        const context = await assetOps.readContext(record);
        const traffic = context.traffic;
        const availability = traffic.availability;
        const row = entry => (entry ? ({
          label: entry.label, value: entry.value, unit: entry.unit, source: entry.source,
          quality: entry.quality, observedAt: entry.observedAt, spatialMatch: entry.spatialMatch,
          synthetic: entry.synthetic, note: entry.note,
        }) : null);
        return ok({
          data: {
            ...about(record),
            /** Real, and the only real traffic facts here. */
            recorded: Object.freeze((traffic.register ?? []).map(row)),
            annualAverage: row(traffic.annualAverage),
            /** Synthetic, labelled on every value. Never presented as an observation. */
            synthetic: Object.freeze({
              speed: row(traffic.speed), congestion: row(traffic.congestion),
              volume: row(traffic.volume),
            }),
            availability: Object.freeze({ ...availability }),
            /** Said as data so an answer cannot imply a feed that does not exist. */
            historicalObservationsAvailable: false,
            sourcesChecked: availability.checkedSources,
          },
          evidence: context.location.sourceIncidentId
            ? [evidenceOf('incident', context.location.sourceIncidentId, 'DataConnect incident register')]
            : [],
          provenance: PROVENANCE.MIXED,
          limitations: [
            availability.note,
            'No timestamped historical speed, volume or congestion observation exists for this '
              + 'corridor in any connected system, so none is reported as one.',
            'Current FL511 conditions are NOT used as historical traffic.',
            'The lane-closure, injury and fatality flags and the segment annual average are real '
              + 'and belong to the source incident and the FDOT network, not to the synthetic case.',
          ],
        });
      },
    },

    get_nearby_incidents: {
      category: 'ACS_CONTEXT',
      description: 'Register incidents near the case incident, by distance and time window, each '
        + 'with the criteria it matched on.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'EITHER',
      handler(input = {}) {
        const { record, error } = resolve(input);
        if (error) return unavailable(error);
        const location = record.evaluation.location;
        if (!Number.isFinite(location?.longitude) || !Number.isFinite(location?.latitude)) {
          return unavailable('This case has no located source incident, so there is nothing to '
            + 'search around.');
        }
        const incidents = assetOps.incidents?.() ?? [];
        if (!incidents.length) return unavailable('The incident register is not loaded.');
        const radiusM = Math.min(5000, Math.max(50, Number(input.radiusM) || NEARBY_RADIUS_M));
        const windowDays = Math.min(365, Math.max(1, Number(input.windowDays) || NEARBY_WINDOW_DAYS));
        // Day keys, not instants: the register records the DAY, and comparing it as a timestamp
        // would be filtering on precision that is not in the data.
        const anchorDay = dayMs(maintenanceDateKey(record.demoCase.incident.reportedAt));
        const found = [];
        for (const incident of incidents) {
          if (String(incident.id) === String(location.sourceIncidentId)) continue;
          if (!Number.isFinite(incident.longitude) || !Number.isFinite(incident.latitude)) continue;
          const distanceM = metresBetween(location.longitude, location.latitude,
            incident.longitude, incident.latitude);
          if (distanceM > radiusM) continue;
          // Time filters only where both records carry a readable date. An unreadable one is
          // reported as unknown rather than silently dropped or counted as a match.
          const atDay = dayMs(maintenanceDateKey(incident.createdDate));
          const withinWindow = anchorDay != null && atDay != null
            ? Math.abs(atDay - anchorDay) <= windowDays * 86_400_000 : null;
          if (withinWindow === false) continue;
          found.push({
            incidentId: String(incident.id),
            distanceM: Math.round(distanceM),
            dateKnown: withinWindow !== null,
            at: incident.createdDate ?? null,
            type: incident.title ?? null,
            severity: severityOf(incident),
            segment: incident.segmentName ?? incident.segment ?? null,
            matchedOn: withinWindow === null
              ? `within ${radiusM} m (this record carries no readable date)`
              : `within ${radiusM} m and ${windowDays} day(s)`,
          });
        }
        found.sort((a, b) => a.distanceM - b.distanceM);
        return ok({
          data: {
            ...about(record),
            anchorIncidentId: location.sourceIncidentId,
            radiusM, windowDays,
            total: found.length,
            incidents: Object.freeze(found.slice(0, 15)),
            searchedRecords: incidents.length,
          },
          filtersApplied: { radiusM, windowDays },
          evidence: found.slice(0, 10)
            .map(entry => evidenceOf('incident', entry.incidentId, 'DataConnect incident register')),
          provenance: PROVENANCE.OBSERVED,
          limitations: [
            'These are real register incidents near the location the synthetic case borrows. '
              + 'Proximity in space and time does not establish that any of them involved the same '
              + 'asset or is related to this case.',
            'The register records the DAY an incident happened, not the minute, so the time window '
              + 'is measured in days. Records with no readable date are included on distance alone '
              + 'and say so.',
          ],
        });
      },
    },

    get_related_assets: {
      category: 'ACS_CONTEXT',
      description: 'The assets related to the case: the one the case names, and corridor registry '
        + 'assets near its incident — confirmed links kept separate from spatial candidates.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'EITHER',
      handler(input = {}) {
        const { record, error } = resolve(input);
        if (error) return unavailable(error);
        const assets = assetOps.assets?.() ?? new Map();
        const location = record.evaluation.location;
        const demoAsset = record.demoCase.asset;
        const named = Object.freeze({
          assetId: demoAsset.assetId,
          assetType: demoAsset.assetType,
          assetName: demoAsset.assetName,
          /** The case names it, so the link is recorded — but the asset itself is synthetic. */
          relationship: ASSOCIATION.CONFIRMED,
          relationshipLabel: ASSOCIATION_LABELS[ASSOCIATION.CONFIRMED],
          inRegistry: assets.has(String(demoAsset.assetId)),
          reason: 'The case names this asset as the damaged one. It is a synthetic asset and the '
            + 'corridor registry does not carry it.',
        });
        // What the register itself says about the real incident whose location is borrowed. This is
        // the application's own association rule, not a second opinion about it.
        const incidents = assetOps.incidents?.() ?? [];
        const sourceIncident = incidents.find(item => String(item.id) === String(location?.sourceIncidentId)) ?? null;
        const association = sourceIncident ? associateIncident(sourceIncident, assets) : null;
        const candidate = association && association.assetId
          ? (() => {
            const asset = assets.get(association.assetId) ?? null;
            return Object.freeze({
              assetId: association.assetId,
              assetType: asset?.category ?? null,
              segment: asset?.segment ?? null,
              relationship: association.relationship,
              relationshipLabel: ASSOCIATION_LABELS[association.relationship],
              distanceM: association.distanceM,
              reason: association.reason,
            });
          })()
          : null;
        return ok({
          data: {
            ...about(record),
            namedAsset: named,
            sourceIncidentId: location?.sourceIncidentId ?? null,
            /** The register's own link for the real incident — confirmed, candidate or unlinked. */
            sourceIncidentAsset: candidate,
            sourceIncidentRelationship: association?.relationship ?? ASSOCIATION.UNLINKED,
            candidateRadiusM: CANDIDATE_RADIUS_M,
            registrySize: assets.size,
          },
          evidence: [
            evidenceOf('acsDemoCase', record.id, 'data/acs-demo-cases.json (synthetic)'),
            ...(location?.sourceIncidentId
              ? [evidenceOf('incident', location.sourceIncidentId, 'DataConnect incident register')]
              : []),
          ],
          provenance: PROVENANCE.MIXED,
          limitations: [
            'The case\'s own asset is synthetic. It is not in the corridor registry and has no '
              + 'real maintenance history.',
            `A CANDIDATE link is proximity only — an asset within ${CANDIDATE_RADIUS_M} m of the `
              + 'incident, offered for review. It is not a damaged asset and nothing classifies it '
              + 'as one.',
            'CONFIRMED means a record names the asset. INFERRED, CANDIDATE and UNLINKED are '
              + 'different claims and are never merged.',
          ],
          actions: candidate && candidate.relationship === ASSOCIATION.CONFIRMED
            ? [{ type: 'HIGHLIGHT_ASSET', assetId: candidate.assetId,
              label: `Highlight asset ${candidate.assetId}` }]
            : [],
        });
      },
    },

    /* ── claims intelligence ───────────────────────────────────────────────────────────────── */
    search_claims: {
      category: 'ACS_CLAIMS',
      description: 'The demonstration claims, filtered by status, asset type, segment, or whether '
        + 'our validation found the claim short of documents.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'EITHER',
      handler(input = {}) {
        const claims = assetOps?.claims?.() ?? [];
        if (!claims.length) {
          return unavailable(assetOps?.claimsUnavailable?.()
            ?? 'No claim records are loaded on this screen.');
        }
        const status = input.status ? String(input.status).trim().toUpperCase() : null;
        if (status && !Object.hasOwn(CLAIM_STATUS, status)) {
          return unavailable(`"${input.status}" is not a claim status. The statuses are: `
            + `${Object.keys(CLAIM_STATUS).join(', ')}.`);
        }
        const matches = claims.filter(claim => {
          if (status && claim.status !== status) return false;
          if (input.assetType && claim.assetType !== input.assetType) return false;
          if (input.segment && claim.segment !== input.segment) return false;
          if (input.missingDocuments && claim.status !== CLAIM_STATUS.NEEDS_DOCUMENTATION) return false;
          return true;
        });
        return ok({
          data: {
            total: matches.length,
            of: claims.length,
            claims: matches.map(claim => ({
              claimReference: claim.claimReference, caseId: claim.demoCaseId,
              status: claim.status, statusLabel: claim.statusLabel,
              assetId: claim.assetId, assetType: claim.assetType, segment: claim.segment,
              incidentType: claim.incidentType, reportedAt: claim.reportedAt,
              estimatedUSD: claim.estimatedUSD, claimedUSD: claim.claimedUSD,
              approvedUSD: claim.approvedUSD, recoveredUSD: claim.recoveredUSD,
              outstandingUSD: claim.outstandingUSD,
              sourceIncidentId: claim.sourceIncidentId,
            })),
            demo: true,
          },
          filtersApplied: { status, assetType: input.assetType ?? null, segment: input.segment ?? null,
            missingDocuments: Boolean(input.missingDocuments) },
          evidence: matches.slice(0, 10).map(claim =>
            evidenceOf('claim', claim.claimReference ?? claim.demoCaseId, 'data/acs-demo-cases.json (synthetic)')),
          provenance: PROVENANCE.SIMULATED,
          limitations: [
            'Every claim here is synthetic demonstration money. None of it is a production figure '
              + 'and none of it may be added to one.',
            'NEEDS_DOCUMENTATION is our own validation finding the claim short. No insurer has '
              + 'reviewed or rejected anything.',
          ],
          actions: matches.slice(0, 3).map(claim => ({
            type: 'OPEN_CLAIM', caseId: claim.demoCaseId,
            label: `Open ${claim.claimReference ?? claim.demoCaseId}`,
          })),
        });
      },
    },

    get_claims_summary: {
      category: 'ACS_CLAIMS',
      description: 'The claims totals and a grouping: counts by status, the estimated, claimed, '
        + 'approved, recovered and outstanding money, the highest-cost groups and repeated claims.',
      screens: ['maintenance'],
      requires: [],
      temporal: 'EITHER',
      handler(input = {}) {
        const claims = assetOps?.claims?.() ?? [];
        if (!claims.length) {
          return unavailable(assetOps?.claimsUnavailable?.()
            ?? 'No claim records are loaded on this screen.');
        }
        const dimension = claimDimensionById(input.dimension ?? 'segment');
        const kpis = claimsKpis(claims);
        const groups = claimsBy(claims, dimension);
        const repeated = repeatedClaims(claims);
        const production = assetOps?.productionClaims?.() ?? null;
        return ok({
          data: {
            counts: Object.freeze({ total: kpis.total, pending: kpis.pending,
              needsDocumentation: kpis.needsDocumentation, approved: kpis.approved,
              settled: kpis.settled, blocked: kpis.blocked }),
            money: Object.freeze({
              estimatedUSD: kpis.estimatedUSD, claimedUSD: kpis.claimedUSD,
              recoveredUSD: kpis.recoveredUSD, outstandingUSD: kpis.outstandingUSD,
              formatted: Object.freeze({
                estimated: usd(kpis.estimatedUSD), claimed: usd(kpis.claimedUSD),
                recovered: usd(kpis.recoveredUSD), outstanding: usd(kpis.outstandingUSD),
              }),
            }),
            groupedBy: Object.freeze({ id: dimension.id, label: dimension.label }),
            groups: groups.map(group => ({ ...group })),
            repeatedClaims: repeated.map(entry => ({ ...entry })),
            /** Why these figures are not corridor figures. Stated, not left to be inferred. */
            productionClaims: production,
            demo: true,
          },
          filtersApplied: { dimension: dimension.id },
          evidence: claims.slice(0, 10).map(claim =>
            evidenceOf('claim', claim.claimReference ?? claim.demoCaseId, 'data/acs-demo-cases.json (synthetic)')),
          provenance: PROVENANCE.SIMULATED,
          limitations: [
            'These totals cover the seven synthetic demonstration cases only. They are NOT '
              + 'corridor financial exposure and must not be mixed with a production total.',
            production?.available === false && production?.reason ? production.reason
              : 'No production claims system is connected to this application.',
            'Estimated, claimed, approved, recovered and outstanding are five different figures. '
              + 'A null amount means nothing has been recorded under that heading, not zero.',
            ...(repeated.length ? [] : ['No asset is named by more than one claim in this set, so '
              + 'there is no repeated-claim pattern to report.']),
          ],
        });
      },
    },
  };

  return Object.freeze(Object.fromEntries(Object.entries(DEFINITIONS)
    .map(([name, definition]) => [name, Object.freeze({ name, readOnly: true, ...definition })])));
}

/** The vocabulary of safe navigation actions these capabilities may return. */
export const CASE_ACTIONS = Object.freeze({
  VIEW_CASE_ON_MAP: 'VIEW_CASE_ON_MAP',
  OPEN_VALIDATION_STAGE: 'OPEN_VALIDATION_STAGE',
  SHOW_MISSING_EVIDENCE: 'SHOW_MISSING_EVIDENCE',
  OPEN_CLAIM: 'OPEN_CLAIM',
  OPEN_RELATED_CASE: 'OPEN_RELATED_CASE',
  HIGHLIGHT_ASSET: 'HIGHLIGHT_ASSET',
  SHOW_AUDIT_HISTORY: 'SHOW_AUDIT_HISTORY',
});

export { SYNTHETIC_NOTE, CANDIDATE_NOTE, stageKeyOf };
