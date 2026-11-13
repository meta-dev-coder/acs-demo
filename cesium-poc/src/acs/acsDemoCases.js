/**
 * The seven ACS demo cases: a complete incident → inspection → repair → QC/QA → claim lifecycle,
 * built from synthetic records because no real one exists end to end.
 *
 * Everything in `data/acs-demo-cases.json` is invented except one thing: the LOCATION. Each case
 * is pinned to a real I-595 incident drawn from the corridor's own register at runtime, so the map
 * behaviour, the corridor position and the camera are the application's real ones. The synthetic
 * damage did not happen at that location, and every surface that shows a case says so.
 *
 * Nothing here evaluates a case by hand. The stage statuses come from `qcqa/stageValidation.js`
 * and the QC/QA checklist results come from the existing `qcqa/validationEngine.js` — the same two
 * engines every other record on this screen goes through. The JSON's own `declaredStatus` is the
 * narrative's claim about each stage; it is asserted against the derived value by the unit tests
 * and is never what the screen shows.
 */
import { STAGE_ORDER, STAGE_STATUS, STATUS, SUBMISSION, validateStage } from '../qcqa/stageValidation.js';
import { validateCase } from '../qcqa/validationEngine.js';
import { selectTemplates } from '../qcqa/applicability.js';
import { templateById } from '../qcqa/templateCatalog.js';
import { SYSTEMS } from './evidence/connectors.js';

export { STAGE_ORDER, STAGE_STATUS };

/** The demonstration is a feature, and features can be switched off (Phase 10, requirement 6). */
export const DEMO_FLAG_PARAM = 'acsDemo';

/**
 * Is the demonstration enabled?
 *
 * `?acsDemo=off` switches it off for one visit and `?acsDemo=on` forces it on; otherwise
 * `VITE_ACS_DEMO_CASES` decides, and it defaults to on because the feature exists to be shown.
 * With it off, no demo record is loaded, no card appears, and nothing else on the screen changes.
 */
export function demoCasesEnabled({ search = typeof location === 'undefined' ? '' : location.search,
  env = typeof import.meta === 'undefined' ? {} : (import.meta.env ?? {}) } = {}) {
  const override = new URLSearchParams(search).get(DEMO_FLAG_PARAM);
  if (override) return !/^(off|0|false|no)$/i.test(override);
  return !/^(off|0|false|no)$/i.test(String(env.VITE_ACS_DEMO_CASES ?? 'on'));
}

/** Overall workflow states, in the vocabulary the brief uses. */
export const OVERALL = Object.freeze({
  BLOCKED_AT_INSPECTION: 'BLOCKED_AT_INSPECTION',
  BLOCKED_AT_REPAIR: 'BLOCKED_AT_REPAIR',
  REWORK_REQUIRED: 'REWORK_REQUIRED',
  CLAIM_ACTION_REQUIRED: 'CLAIM_ACTION_REQUIRED',
  REPAIR_IN_PROGRESS: 'REPAIR_IN_PROGRESS',
  AWAITING_CLAIM: 'AWAITING_CLAIM',
  CLOSED: 'CLOSED',
});

/** How an overall state reads on a card, and which way it leans. */
export const OVERALL_PRESENTATION = Object.freeze({
  BLOCKED_AT_INSPECTION: { label: 'Blocked at inspection', tone: 'bad', group: 'blocked' },
  BLOCKED_AT_REPAIR: { label: 'Blocked at repair', tone: 'bad', group: 'blocked' },
  REWORK_REQUIRED: { label: 'Rework required', tone: 'bad', group: 'blocked' },
  CLAIM_ACTION_REQUIRED: { label: 'Claim action required', tone: 'bad', group: 'blocked' },
  REPAIR_IN_PROGRESS: { label: 'Repair in progress', tone: 'warn', group: 'open' },
  AWAITING_CLAIM: { label: 'Awaiting claim', tone: 'warn', group: 'open' },
  CLOSED: { label: 'Closed', tone: 'ok', group: 'closed' },
});

/** How a stage status reads, so one state means one thing everywhere it is drawn. */
export const STAGE_PRESENTATION = Object.freeze({
  PASSED: { label: 'Passed', tone: 'ok' },
  FAILED: { label: 'Failed', tone: 'bad' },
  IN_PROGRESS: { label: 'In progress', tone: 'warn' },
  PENDING: { label: 'Pending', tone: 'info' },
  BLOCKED: { label: 'Blocked', tone: 'bad' },
});

const STAGE_KEYS = Object.freeze({ INSPECTION: 'inspection', REPAIR: 'repair', QCQA: 'qualityAssurance', CLAIM: 'claim' });

let cache = null;

/** The case file, read once. Returns null when it cannot be read — never a partial set. */
export async function loadDemoCases(fetcher = typeof fetch === 'undefined' ? null : fetch) {
  if (!fetcher) return null;
  cache ??= Promise.resolve()
    .then(() => fetcher('data/acs-demo-cases.json'))
    .then(response => (response?.ok ? response.json() : null))
    .then(payload => {
      if (!payload?.cases?.length) return null;
      const problems = payload.cases.flatMap(validateCaseSchema);
      if (problems.length) {
        console.warn('[acs-demo] the demo case file does not match the schema; it is not loaded', problems);
        return null;
      }
      return Object.freeze(payload);
    })
    .catch(() => null);
  return cache;
}

/** Diagnostics and tests: forget the memoised read. */
export function resetDemoCases() { cache = null; }

/**
 * The case file's schema (Phase 10, requirement 8).
 *
 * Deliberately strict: an incomplete case would be drawn as a complete one with blanks in it, and
 * a blank in this screen reads as a finding. A case that does not validate takes the whole file
 * out rather than appearing half-formed.
 *
 * @returns {string[]} the problems, empty when the case is well formed
 */
export function validateCaseSchema(demoCase) {
  const problems = [];
  const need = (cond, message) => { if (!cond) problems.push(`${demoCase?.demoCaseId ?? '(no id)'}: ${message}`); };

  need(/^ACS-DEMO-\d{3}$/.test(demoCase?.demoCaseId ?? ''), 'demoCaseId must be ACS-DEMO-nnn');
  need(demoCase?.isDemo === true, 'isDemo must be true — nothing in this file may read as production');
  need(Boolean(demoCase?.demoLabel), 'demoLabel is required, so every surface can label the record');
  need(demoCase?.sourceIncidentId === null, 'sourceIncidentId must be null in the file; it is resolved from the register at runtime');
  need(Number.isInteger(demoCase?.locationPreference?.order), 'locationPreference.order is required');
  need(Boolean(demoCase?.incident?.incidentType), 'incident.incidentType is required');
  need(Boolean(demoCase?.incident?.reportedAt), 'incident.reportedAt is required');
  need(Boolean(demoCase?.incident?.description), 'incident.description is required');
  need(!demoCase?.incident?.location, 'the file must not carry coordinates of its own');
  need(Boolean(demoCase?.asset?.assetId) && Boolean(demoCase?.asset?.assetType), 'asset.assetId and asset.assetType are required');
  need(Boolean(demoCase?.qcqa?.templateId), 'qcqa.templateId is required');
  need(Boolean(templateById(demoCase?.qcqa?.templateId)),
    `qcqa.templateId "${demoCase?.qcqa?.templateId}" is not a checklist in the catalogue`);
  need(Boolean(demoCase?.workflow?.currentStage), 'workflow.currentStage is required');
  need(Array.isArray(demoCase?.auditTrail) && demoCase.auditTrail.length > 0, 'auditTrail must have at least one entry');

  for (const [stage, key] of Object.entries(STAGE_KEYS)) {
    const body = demoCase?.[key];
    need(Boolean(body), `${key} is required`);
    if (!body) continue;
    need(Object.values(SUBMISSION).includes(body.submission), `${key}.submission must be a SUBMISSION`);
    need(Boolean(body.declaredStatus), `${key}.declaredStatus is required`);
    need(Array.isArray(body.fields ?? []), `${key}.fields must be an array`);
    for (const field of body.fields ?? []) {
      need(Boolean(field.fieldId) && Boolean(field.label), `${key}: a field is missing fieldId or label`);
      need(typeof field.required === 'boolean' || stage === 'QCQA', `${key}/${field.fieldId}: required must be a boolean`);
    }
    if (body.submission === SUBMISSION.SUBMITTED && stage !== 'QCQA') {
      need((body.fields ?? []).length >= 8, `${key}: a submitted stage needs at least 8 fields to be worth validating`);
    }
  }
  for (const entry of demoCase?.auditTrail ?? []) {
    need(Boolean(entry.at) && Boolean(entry.event) && Boolean(entry.actor), 'every audit entry needs at, actor and event');
  }

  // The evidence-recovery block. A candidate with no system or no keys cannot be scored, and a
  // candidate that claims to resolve a field has to say which one.
  const recovery = demoCase?.evidenceRecovery;
  need(Boolean(recovery), 'evidenceRecovery is required');
  need(Boolean(recovery?.outcome), 'evidenceRecovery.outcome is required, so the demo states what this case shows');
  need(Array.isArray(recovery?.candidates), 'evidenceRecovery.candidates must be an array');
  need(Array.isArray(recovery?.notRecoverable), 'evidenceRecovery.notRecoverable must be an array');
  for (const entry of recovery?.notRecoverable ?? []) {
    need(Boolean(entry.fieldId) && Boolean(entry.reason),
      'every notRecoverable entry needs a fieldId and the reason a person must do it');
  }
  for (const candidate of recovery?.candidates ?? []) {
    const id = candidate.recordId ?? '(no id)';
    need(Boolean(candidate.recordId), 'a candidate is missing recordId');
    need(Object.values(SYSTEMS).includes(candidate.system), `${id}: system must be a known system`);
    need(Boolean(candidate.summary), `${id}: summary is required`);
    need(Boolean(candidate.keys), `${id}: keys are required, or it cannot be scored`);
    need(candidate.resolves != null || candidate.enriches === true,
      `${id}: a candidate either resolves a field or is marked as enrichment`);
  }
  for (const entry of recovery?.lineage ?? []) {
    need(Boolean(entry.fieldId) && Boolean(entry.system) && Boolean(entry.recordId),
      'every lineage entry needs a fieldId, a system and a recordId');
  }
  return problems;
}

/* --- locations -------------------------------------------------------------------------------- */

/** EB/WB out of whatever the source incident states, or null. Never guessed. */
export function directionOf(incident) {
  const text = [incident?.segmentName, incident?.description, incident?.title].filter(Boolean).join(' ');
  if (/\b(eb|eastbound|east bound)\b/i.test(text)) return 'EB';
  if (/\b(wb|westbound|west bound)\b/i.test(text)) return 'WB';
  return null;
}

/**
 * Pin each case to a real incident.
 *
 * Deterministic by construction (Phase 10, requirement 7): the located incidents are sorted by
 * longitude and id, cut into as many buckets as there are cases, and each case takes the first
 * incident in its own bucket — preferring one whose source record states the direction the case
 * asks for, and otherwise taking the bucket's first. The same register always yields the same
 * seven, and spreading by bucket is what gives different segments and mileposts.
 *
 * @param {object[]} cases     the cases, in file order
 * @param {object[]} incidents the incident register's normalised records
 * @returns {{cases: object[], problems: string[]}} cases carrying `sourceIncident`, and whatever
 *          could not be resolved — reported, never fabricated
 */
export function resolveSourceIncidents(cases, incidents) {
  const located = (incidents ?? [])
    .filter(item => Number.isFinite(item?.latitude) && Number.isFinite(item?.longitude))
    .sort((a, b) => a.longitude - b.longitude || String(a.id).localeCompare(String(b.id)));
  const problems = [];
  if (located.length < cases.length) {
    problems.push(`The incident register supplied ${located.length} incidents with usable coordinates; `
      + `${cases.length} are needed, one per demo case. No coordinate has been invented, so the cases `
      + 'without one are listed without a location.');
  }
  const ordered = [...cases].sort((a, b) => a.locationPreference.order - b.locationPreference.order);
  const bucketSize = located.length ? located.length / ordered.length : 0;
  const taken = new Set();

  const resolved = ordered.map((demoCase, index) => {
    const from = Math.floor(index * bucketSize);
    const to = Math.max(from + 1, Math.floor((index + 1) * bucketSize));
    const bucket = located.slice(from, to).filter(item => !taken.has(item.id));
    const wanted = demoCase.locationPreference.direction ?? null;
    const pick = bucket.find(item => wanted && directionOf(item) === wanted) ?? bucket[0] ?? null;
    if (pick) taken.add(pick.id);
    else problems.push(`${demoCase.demoCaseId}: no unused incident with coordinates was available in its `
      + 'stretch of the corridor, so this case has no location.');
    return Object.freeze({ ...demoCase, sourceIncident: pick ?? null });
  });
  // Back to file order, so the slider and the dialog list the cases as the file does.
  resolved.sort((a, b) => String(a.demoCaseId).localeCompare(String(b.demoCaseId)));
  return { cases: Object.freeze(resolved), problems: Object.freeze(problems) };
}

/** The register writes an unknown segment as "-", which is not a segment name. */
const segmentName = value => {
  const text = String(value ?? '').trim();
  return text && text !== '-' ? text : null;
};

/** What is actually known about where a case sits, with the unknowns named. */
export function locationOf(demoCase) {
  const incident = demoCase?.sourceIncident ?? null;
  return Object.freeze({
    sourceIncidentId: incident?.id ?? null,
    latitude: incident?.latitude ?? null,
    longitude: incident?.longitude ?? null,
    roadway: 'I-595',
    segmentId: segmentName(incident?.segmentName),
    direction: incident ? directionOf(incident) : null,
    /** The register publishes no milepost. The corridor distance is derived and labelled as such. */
    milepost: null,
    sourceIncidentType: incident?.title ?? null,
    sourceIncidentDate: incident?.createdDate ?? null,
    note: incident
      ? 'This is the location of a real incident in the corridor register. The synthetic damage, '
        + 'repair and claim described in this case did not happen here.'
      : 'No incident with usable coordinates was available for this case, so it has no location. '
        + 'Nothing has been invented to fill it.',
  });
}

/* --- evaluation ------------------------------------------------------------------------------- */

/**
 * The checklist responses a case recorded, as the engine expects them.
 *
 * Only responses the case actually holds. An unanswered question stays unanswered, so the engine
 * reports it MISSING rather than being handed a quiet pass.
 */
export const qcResponsesOf = demoCase => demoCase?.qualityAssurance?.responses ?? null;

/** The canonical case the existing checklist engine reads. Built by hand because the demo records
 *  are not DataConnect rows and have no adapter — the SHAPE is the contract, not the source. */
export function canonicalFor(demoCase, attachments = null) {
  const repair = demoCase.repair ?? {};
  const inspection = demoCase.inspection ?? {};
  const photos = [...(inspection.fields ?? []), ...(repair.fields ?? [])]
    .filter(field => field.dataType === 'attachment' && field.value)
    .length;
  return Object.freeze({
    caseId: demoCase.demoCaseId,
    incident: Object.freeze({
      id: demoCase.sourceIncident?.id ?? null,
      type: demoCase.incident.incidentType,
      date: demoCase.incident.reportedAt,
      source: 'ACS demo (synthetic)',
    }),
    workOrder: repair.workOrderId
      ? Object.freeze({
        id: repair.workOrderId,
        assetId: demoCase.asset.assetId,
        assetType: demoCase.asset.assetType,
        assetTypeRaw: demoCase.asset.assetType,
        workActivity: demoCase.qcqa.workActivity,
        status: repair.physicalWorkComplete ? 'Closed' : 'In progress',
        closedDate: repair.completedAt ?? null,
        source: 'ACS demo (synthetic)',
      })
      : null,
    inspection: null,
    asset: Object.freeze({
      id: demoCase.asset.assetId,
      assetType: demoCase.asset.assetType,
      subtype: demoCase.asset.assetSubtype ?? null,
      source: 'ACS demo (synthetic)',
    }),
    /** No ACS repair-form task is involved, so there is no illustrative link to warn about. */
    acsTask: Object.freeze({ photoCount: photos, evidenceFilesSupplied: false, linkEvidence: 'DEMO',
      qcSignatory: demoCase.qualityAssurance?.approvals?.qc?.signatory ?? null }),
    qcInspection: Object.keys(qcResponsesOf(demoCase) ?? {}).length
      ? Object.freeze({ responses: qcResponsesOf(demoCase) }) : null,
    approvals: Object.freeze(demoCase.qualityAssurance?.approvals ?? { qc: null, qa: null }),
    /**
     * Files a reviewer accepted for this case's evidence questions.
     *
     * An attached file moves a question from MISSING to NEEDS_VERIFICATION in the engine — never
     * to PASS. Finding the document is not the same as checking it is the right document, and the
     * engine says so in its own words.
     *
     * An approval is never here: `notRecoverable` keeps sign-offs out, so a recovered file can
     * never stand in for somebody accepting the work.
     */
    evidence: Object.freeze(Object.entries(attachments ?? {})
      .filter(([fieldId]) => fieldId.endsWith('-EVIDENCE'))
      .map(([fieldId, attached]) => Object.freeze({ fieldId, ...attached }))),
    classification: Object.freeze({
      assetType: demoCase.asset.assetType,
      assetSubtype: demoCase.asset.assetSubtype ?? null,
      workActivity: demoCase.qcqa.workActivity,
      incidentType: demoCase.incident.incidentType,
      workOrderId: repair.workOrderId ?? null,
    }),
  });
}

/**
 * One stage's record with accepted evidence laid over it.
 *
 * The case itself is frozen and is never written to. A field that already carries a value keeps
 * it: recovered evidence fills gaps and never overwrites what was originally recorded, so a value
 * that FAILED its rule still fails it however many documents turn up afterwards.
 */
export function withAttachments(stage, attachments) {
  const fields = stage?.fields ?? [];
  if (!fields.length || !Object.keys(attachments ?? {}).length) return stage;
  return {
    ...stage,
    fields: fields.map(field => {
      const attached = attachments[field.fieldId];
      const blank = field.value === null || field.value === undefined
        || (typeof field.value === 'string' && field.value.trim() === '');
      if (!attached || !blank) return field;
      return {
        ...field,
        value: attached.value,
        note: `Recovered from ${attached.system} record ${attached.recordId}`
          + `${attached.synthetic ? ' (synthetic source)' : ''}. The original record remains blank; `
          + 'this value is held beside it.',
        recoveredFrom: attached,
      };
    }),
  };
}

/**
 * What recovery is likely to achieve, without querying anything.
 *
 * The KPI card and the slider need counts the moment the cases load, and a connector round trip
 * per case would make the strip wait on work nobody has asked for yet. This counts the same data
 * the synthetic connectors answer from, so the indicator and the Evidence Recovery tab agree.
 */
export function recoveryOutlook(demoCase, evaluation) {
  const recovery = demoCase.evidenceRecovery ?? {};
  const blocked = new Set((recovery.notRecoverable ?? []).map(entry => entry.fieldId));
  const resolvable = new Set((recovery.candidates ?? [])
    .filter(candidate => candidate.resolves).map(candidate => candidate.resolves));

  const missing = STAGE_ORDER.flatMap(stage =>
    (evaluation.stages[stage].findings ?? [])
      .filter(field => field.status === STATUS.MISSING)
      .map(field => field.fieldId));

  const recoverable = missing.filter(id => resolvable.has(id) && !blocked.has(id));
  return Object.freeze({
    missing: missing.length,
    recoverable: recoverable.length,
    unresolved: missing.length - recoverable.length,
    humanOnly: missing.filter(id => blocked.has(id)).length,
    enrichment: (recovery.candidates ?? []).filter(candidate => !candidate.resolves).length
      + (recovery.lineage ?? []).length,
    /** Weather and traffic can be assembled whenever the case has a located source incident. */
    contextAvailable: Boolean(demoCase.sourceIncident),
    outcome: recovery.outcome ?? null,
    packageOutcome: recovery.packageOutcome ?? null,
  });
}

/** One checklist finding, reshaped as a stage field so every stage summarises the same way. */
const asStageField = finding => Object.freeze({
  fieldId: finding.ruleId,
  label: finding.question,
  required: finding.status !== STATUS.NOT_APPLICABLE && finding.status !== STATUS.NOT_EVALUATED,
  dataType: 'checklist',
  validationType: finding.validationType,
  value: finding.actual ?? null,
  unit: null,
  expected: finding.expected ?? null,
  status: finding.status,
  message: finding.reason,
  note: finding.recommendedAction ?? null,
  section: finding.section ?? null,
  sourceTemplate: finding.sourceTemplate ?? null,
  sourcePage: finding.sourcePage ?? null,
});

/**
 * Run the full lifecycle validation for one case.
 *
 * @returns {object} the stage statuses, the overall state, the next action, the checklist review
 *          and the business-value explanation — all derived, none declared
 */
export function evaluateDemoCase(demoCase, { attachments = null } = {}) {
  const statuses = {};
  const stages = {};
  const attached = attachments ?? {};

  // The checklist review, from the engine every other record uses. Run only once the QC/QA record
  // has been handed in: an unsubmitted checklist has nothing to evaluate, and running it anyway
  // would fill the stage with MISSING findings against work nobody has inspected yet.
  const canonical = canonicalFor(demoCase, attached);
  const declaredTemplate = demoCase.qcqa.templateId;
  const engineSelection = selectTemplates(canonical.classification);
  const review = demoCase.qualityAssurance?.submission === SUBMISSION.SUBMITTED
    ? validateCase(canonical, { templateIds: [declaredTemplate], includeUniversal: false })
    : null;

  for (const stage of STAGE_ORDER) {
    const body = withAttachments(demoCase[STAGE_KEYS[stage]]
      ?? { submission: SUBMISSION.NOT_SUBMITTED, fields: [] }, attached);
    // BLOCKED is reserved for a stage held up by a FAILURE. A stage waiting on work that is merely
    // unfinished is PENDING — that is the pending-is-not-failed distinction, in one place.
    const failedEarlier = STAGE_ORDER.slice(0, STAGE_ORDER.indexOf(stage))
      .find(earlier => statuses[earlier] === STAGE_STATUS.FAILED) ?? null;
    const extraFindings = stage === 'QCQA' && review
      ? [...review.templates.flatMap(entry => entry.findings), ...review.consistency].map(asStageField)
      : [];
    const evaluated = validateStage(body, { gatedBy: failedEarlier, extraFindings });
    statuses[stage] = evaluated.status;
    stages[stage] = Object.freeze({
      ...evaluated,
      stage,
      declaredStatus: body.declaredStatus ?? null,
      /** Everything the case records about the stage beyond its fields, for the dialog to draw. */
      record: body,
    });
  }

  const overall = overallStatusOf(statuses);
  const nextAction = nextActionFor(demoCase, stages, statuses, overall);
  return Object.freeze({
    demoCaseId: demoCase.demoCaseId,
    /** The accepted evidence this evaluation was produced with. Empty on the first pass. */
    attachments: Object.freeze({ ...attached }),
    statuses: Object.freeze(statuses),
    stages: Object.freeze(stages),
    overall,
    presentation: OVERALL_PRESENTATION[overall],
    nextAction,
    review,
    /** What the selection engine would have chosen, beside what the case declares it used. */
    checklist: Object.freeze({
      declared: declaredTemplate,
      declaredTitle: templateById(declaredTemplate)?.title ?? null,
      engineSelection,
      agrees: engineSelection.selectedTemplates.includes(declaredTemplate),
    }),
    explanation: explainDemoCase(demoCase, stages, statuses, overall),
    location: locationOf(demoCase),
  });
}

/**
 * The overall state, from the first stage that has not passed.
 *
 * A rule table, not seven branches: adding a stage or a state means adding a row.
 */
export function overallStatusOf(statuses) {
  const first = STAGE_ORDER.find(stage => statuses[stage] !== STAGE_STATUS.PASSED);
  if (!first) return OVERALL.CLOSED;
  const status = statuses[first];
  if (status === STAGE_STATUS.FAILED) {
    return first === 'QCQA' ? OVERALL.REWORK_REQUIRED
      : first === 'CLAIM' ? OVERALL.CLAIM_ACTION_REQUIRED
        : `BLOCKED_AT_${first}`;
  }
  if (status === STAGE_STATUS.BLOCKED) return `BLOCKED_AT_${first}`;
  if (status === STAGE_STATUS.IN_PROGRESS) return `${first}_IN_PROGRESS`;
  return `AWAITING_${first === 'QCQA' ? 'QCQA' : first}`;
}

/** The one thing to do next, named from the findings rather than from a per-case string. */
export function nextActionFor(demoCase, stages, statuses, overall) {
  if (overall === OVERALL.CLOSED) {
    return Object.freeze({ role: null, team: null,
      text: 'Nothing outstanding. Every mandatory check passed and the recovery is reconciled.' });
  }
  const stageKey = STAGE_ORDER.find(stage => statuses[stage] !== STAGE_STATUS.PASSED);
  const stage = stages[stageKey];
  const role = demoCase.workflow?.assignedRole ?? null;
  const team = demoCase.workflow?.assignedTeam ?? null;

  if (stage.status === STAGE_STATUS.BLOCKED) {
    const blocker = stages[stage.gatedBy];
    return Object.freeze({ role, team,
      text: `Resolve ${STAGE_ORDER.indexOf(stage.gatedBy) >= 0 ? stage.gatedBy.toLowerCase() : 'the earlier'} `
        + `stage first: ${blocker.blocking.slice(0, 3).join(', ')}${blocker.blocking.length > 3 ? ', and others' : ''}.` });
  }
  const ncrs = (demoCase.qualityAssurance?.nonConformances ?? []).filter(entry => entry.status === 'OPEN');
  if (stageKey === 'QCQA' && ncrs.length) {
    return Object.freeze({ role, team,
      text: `Close ${ncrs.length} open non-conformance${ncrs.length === 1 ? '' : 's'}: `
        + `${ncrs.map(entry => entry.correctiveAction).join(' ')} Then repeat the QC/QA inspection.` });
  }
  if (stage.blocking.length) {
    return Object.freeze({ role, team,
      text: `Complete ${stage.blocking.length} outstanding record${stage.blocking.length === 1 ? '' : 's'} `
        + `on the ${stageKey.toLowerCase()} stage: ${stage.blocking.slice(0, 4).join(', ')}`
        + `${stage.blocking.length > 4 ? ', and others' : ''}.` });
  }
  if (stage.status === STAGE_STATUS.IN_PROGRESS) {
    return Object.freeze({ role, team,
      text: `Finish the work and submit the ${stageKey.toLowerCase()} record. `
        + `${stage.summary.pending} field${stage.summary.pending === 1 ? '' : 's'} are not due yet.` });
  }
  return Object.freeze({ role, team, text: `Raise and submit the ${stageKey.toLowerCase()} record.` });
}

/**
 * The three sentences the brief asks for (Phase 9), built from the findings.
 *
 * Deterministic and local: no model is called, and nothing is said that the findings do not
 * already contain.
 */
export function explainDemoCase(demoCase, stages, statuses, overall) {
  if (overall === OVERALL.CLOSED) {
    const totals = STAGE_ORDER.reduce((sum, stage) => sum + stages[stage].summary.passed, 0);
    return Object.freeze({
      detection: `All four stages passed validation: ${totals} checks satisfied and no finding raised.`,
      impact: 'The case carries a complete, self-consistent evidence trail: the claimed amount '
        + 'equals the approved repair cost and the recovery reconciles against it.',
      action: 'None. The case is closed and is the reference for what a complete record looks like.',
    });
  }
  const stageKey = STAGE_ORDER.find(stage => statuses[stage] !== STAGE_STATUS.PASSED);
  const stage = stages[stageKey];
  const label = stageKey.toLowerCase();
  const ncrs = demoCase.qualityAssurance?.nonConformances ?? [];

  if (stage.status === STAGE_STATUS.FAILED && stageKey === 'QCQA') {
    const failed = stage.findings.filter(field => field.status === STATUS.FAIL);
    return Object.freeze({
      detection: `QC/QA failed: ${failed.length} checklist item${failed.length === 1 ? '' : 's'} on `
        + `${demoCase.qcqa.templateId} recorded as not satisfying the check`
        + `${ncrs.length ? `, and ${ncrs.length} non-conformance${ncrs.length === 1 ? '' : 's'} raised` : ''}.`,
      impact: 'The repair cannot be accepted while a non-conformance is open, so the asset is not '
        + 'yet back in a verified condition and the repair cost is not final.',
      action: `Assign corrective work, capture new measurements and repeat the ${demoCase.qcqa.templateId} inspection.`,
    });
  }
  if (stage.status === STAGE_STATUS.FAILED) {
    const missing = stage.findings.filter(field => field.status === STATUS.MISSING);
    const failed = stage.findings.filter(field => field.status === STATUS.FAIL);
    const parts = [
      missing.length ? `${missing.length} mandatory record${missing.length === 1 ? '' : 's'} absent` : null,
      failed.length ? `${failed.length} recorded value${failed.length === 1 ? '' : 's'} outside its rule` : null,
    ].filter(Boolean).join(' and ');
    const physical = demoCase.repair?.physicalWorkComplete === true && stageKey === 'REPAIR';
    return Object.freeze({
      detection: `The ${label} record failed validation: ${parts} — ${stage.blocking.slice(0, 3).join(', ')}`
        + `${stage.blocking.length > 3 ? ', and others' : ''}.`,
      impact: physical
        ? 'The physical work is recorded as complete; its documentation is not. Nothing downstream '
          + 'can proceed, because QC/QA has to check what was fitted and the record does not say.'
        : `Every later stage is held: ${STAGE_ORDER.slice(STAGE_ORDER.indexOf(stageKey) + 1)
          .map(key => key.toLowerCase()).join(', ')} cannot be relied on until this is complete.`,
      action: `Complete the outstanding ${label} records, then re-run validation.`,
    });
  }
  if (stage.status === STAGE_STATUS.BLOCKED) {
    return Object.freeze({
      detection: `The ${label} stage has no record and cannot be started: the ${stage.gatedBy.toLowerCase()} `
        + 'stage failed validation.',
      impact: 'This is a blocked stage, not a late one. Nothing is outstanding from the team that '
        + `owns ${label} until the ${stage.gatedBy.toLowerCase()} record is put right.`,
      action: `Clear the ${stage.gatedBy.toLowerCase()} findings first.`,
    });
  }
  if (stage.status === STAGE_STATUS.IN_PROGRESS) {
    return Object.freeze({
      detection: `The ${label} stage is under way: ${stage.summary.passed} of ${stage.summary.required} `
        + `mandatory records are in and ${stage.summary.pending} are not due yet.`,
      impact: 'Nothing is wrong with this case. The records that do not exist yet are reported as '
        + 'pending rather than missing, so an unfinished job is not shown as a failing one.',
      action: stage.record?.progressNote
        ? `Continue the work: ${stage.record.progressNote}`
        : `Continue the work and submit the ${label} record on completion.`,
    });
  }
  return Object.freeze({
    detection: `Every stage before ${label} has passed and no ${label} record exists yet.`,
    impact: 'The case is ready for the next step. Pending is not a failure and nothing is overdue.',
    action: `Raise the ${label} record. The evidence pack the ${label} stage needs is already complete.`,
  });
}

/* --- the KPI card and the records the map draws ----------------------------------------------- */

/**
 * The card's breakdown, counted from the data (Phase 5) rather than written into the component.
 */
export function kpiBreakdown(evaluations = [], outlooks = []) {
  const group = key => evaluations.filter(entry => entry.presentation?.group === key).length;
  const sum = key => outlooks.reduce((total, outlook) => total + (outlook?.[key] ?? 0), 0);
  return Object.freeze({
    total: evaluations.length,
    blocked: group('blocked'),
    open: group('open'),
    closed: group('closed'),
    /** Evidence indicators, counted across the seven cases. */
    missingEvidence: sum('missing'),
    recoverableEvidence: sum('recoverable'),
    unresolvedEvidence: sum('unresolved'),
    contextAvailable: outlooks.filter(outlook => outlook?.contextAvailable).length,
  });
}

/**
 * One demo case as a maintenance-shaped record.
 *
 * The same shape every other class on this screen produces, so the map layer, the asset source,
 * the carousel, the rail and the mini-map need no knowledge of it at all. `demo: true` and the
 * label travel with the record, so no surface can draw it without being able to mark it.
 */
export function demoCaseRecord(demoCase, evaluation) {
  const incident = demoCase.sourceIncident ?? null;
  const outlook = recoveryOutlook(demoCase, evaluation);
  return Object.freeze({
    id: demoCase.demoCaseId,
    sourceId: demoCase.demoCaseId,
    type: 'ACS_DEMO_CASE',
    title: `${demoCase.incident.incidentType} · ${demoCase.asset.assetName}`,
    status: evaluation.presentation.label,
    priority: null,
    assetId: demoCase.asset.assetId,
    assetType: demoCase.asset.assetType,
    systemClass: null,
    segmentName: incident?.segmentName ?? null,
    createdDate: demoCase.incident.reportedAt,
    closedDate: evaluation.overall === OVERALL.CLOSED
      ? demoCase.auditTrail[demoCase.auditTrail.length - 1]?.at ?? null : null,
    description: demoCase.incident.description,
    related: Object.freeze({ sourceIncidentId: incident?.id ?? null }),
    latitude: incident?.latitude ?? null,
    longitude: incident?.longitude ?? null,
    locationSource: incident ? 'demo-source-incident' : null,
    /** Never absent, so nothing can render this record without the badge. */
    demo: true,
    demoLabel: demoCase.demoLabel,
    demoCase,
    evaluation,
    /** Compact counts for the KPI card and the slider; the tab runs the real search. */
    outlook,
    raw: null,
  });
}

/**
 * Everything the workspace needs: the cases pinned to real incidents, evaluated, and as records.
 *
 * @param {object} payload   the loaded case file
 * @param {object[]} incidents the incident register's normalised records
 */
export function buildDemoCases(payload, incidents) {
  if (!payload?.cases?.length) return Object.freeze({ records: Object.freeze([]), problems: Object.freeze([]), breakdown: kpiBreakdown([]) });
  const { cases, problems } = resolveSourceIncidents(payload.cases, incidents);
  const evaluations = cases.map(demoCase => evaluateDemoCase(demoCase));
  const records = cases.map((demoCase, index) => demoCaseRecord(demoCase, evaluations[index]));
  return Object.freeze({
    records: Object.freeze(records),
    problems,
    breakdown: kpiBreakdown(evaluations, records.map(record => record.outlook)),
    note: payload.note,
    assumptions: Object.freeze(payload.assumptions ?? []),
  });
}
