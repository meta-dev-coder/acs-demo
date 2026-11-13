/**
 * ACS repair cases, read from the General Accident and Repair Form.
 *
 * The 23 tasks in `data/acs-repair-tasks.json` are REAL ACS form submissions: real inspectors,
 * real work descriptions, real police case numbers, real third-party invoices, real photo counts.
 *
 * What is NOT real is the pairing of a case to an incident. The assessment in
 * `docs/acs-repair-link-assessment.md` found no shared identifier between the ACS form and the
 * incident register, and same-day matching performed below chance — so a case is attached to an
 * incident here for demonstration only, and every surface that shows one has to say so. The day
 * ACS supplies the event number for each task, `caseForIncident` is the one function that changes:
 * it looks the task up by `eventNumber` instead of by a hash, and `evidence` stops saying
 * ILLUSTRATIVE.
 */

/** How a case came to be attached to an incident. Only one of these is a real link. */
export const CASE_EVIDENCE = Object.freeze({
  /** Paired for demonstration. No field in either record connects them. */
  ILLUSTRATIVE: 'ILLUSTRATIVE',
  /** The ACS form's Event # matched the incident's id. Not reachable with today's data. */
  EVENT_NUMBER: 'EVENT_NUMBER',
});

/** Fields the ACS export does not carry, so the UI shows them as absent rather than as zero. */
export const ABSENT_FIELDS = Object.freeze([
  { key: 'labourHours', label: 'Labor' },
  { key: 'serviceVehicle', label: 'Service Vehicle' },
  { key: 'equipment', label: 'Equipment' },
  { key: 'materials', label: 'Materials' },
]);

const STAGE_LABELS = Object.freeze({
  INSPECTION: 'Initial inspection',
  REPAIR: 'Repair / maintenance',
  QC: 'QC / QA',
  UNKNOWN: 'Unspecified stage',
});

let cache = null;

/** The task file, read once. Returns null when it cannot be read — never a partial set. */
export async function loadAcsTasks() {
  if (cache) return cache;
  cache = fetch('data/acs-repair-tasks.json')
    .then(response => (response.ok ? response.json() : null))
    .then(payload => (payload?.tasks?.length ? Object.freeze(payload) : null))
    .catch(() => null);
  return cache;
}

/** Diagnostics and tests: forget the memoised read. */
export function resetAcsTasks() { cache = null; }

/**
 * A stable number for a string.
 *
 * It has to be stable across reloads, because an operator who opens the same incident twice and
 * gets two different cases would reasonably conclude the whole screen is invented.
 */
export function hashOf(text) {
  let hash = 0;
  for (let index = 0; index < String(text).length; index += 1) {
    hash = (hash * 31 + String(text).charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/** `CASE-001` for the first task in file order, and so on. */
export const caseIdFor = index => `CASE-${String(index + 1).padStart(3, '0')}`;

/** The stage rows of a task, in the order the work happens rather than the order they were filed. */
const ORDER = { INSPECTION: 0, REPAIR: 1, QC: 2, UNKNOWN: 3 };
export function stagesOf(task) {
  return [...(task?.stages ?? [])]
    .map(stage => ({ ...stage, stageLabel: STAGE_LABELS[stage.stage] ?? STAGE_LABELS.UNKNOWN }))
    .sort((a, b) => (ORDER[a.stage] ?? 3) - (ORDER[b.stage] ?? 3)
      || String(a.date).localeCompare(String(b.date)));
}

/** The first stage of a kind, or null. */
export const stageOf = (task, kind) => stagesOf(task).find(stage => stage.stage === kind) ?? null;

/**
 * What the form says is missing, as findings rather than as blanks.
 *
 * This is the panel's "AI Check": it is a completeness check over the record in front of it, not a
 * prediction and not an opinion about the work. Every finding names the field it is about.
 */
export function completenessFindings(task) {
  const findings = [];
  const stages = stagesOf(task);
  const repair = stageOf(task, 'REPAIR');
  const cost = stages.reduce((total, stage) => total + (stage.thirdPartyCostUSD ?? 0), 0);

  findings.push({
    kind: 'absent',
    text: 'Labor, service vehicle, equipment and material records are referenced by the form but '
      + 'were not included in the export, so no resource or cost total can be produced for this task.',
  });
  if (repair && cost === 0) {
    findings.push({
      kind: 'absent',
      text: 'A repair stage was filed with no cost of any kind recorded against it.',
    });
  }
  if (cost > 0) {
    findings.push({
      kind: 'present',
      text: `Third-party invoice of $${cost.toLocaleString('en-US', { minimumFractionDigits: 2 })} `
        + 'recorded. This is the only cost in the form; it is not the cost of the task.',
    });
  }
  if (!task?.latitude) {
    findings.push({
      kind: 'absent',
      text: `Location is free text ("${task?.siteLocationText ?? 'not stated'}") with no coordinates, `
        + 'so this task cannot be placed on the map.',
    });
  }
  if (!task?.eventNumber) {
    findings.push({
      kind: 'absent',
      text: 'No Event # on this task. That is the field that would tie it to a traffic incident; '
        + 'without it the link above is illustrative.',
    });
  }
  if (!stageOf(task, 'QC')) {
    findings.push({ kind: 'absent', text: 'No QC/QA stage has been filed for this task.' });
  }
  return Object.freeze(findings);
}

/**
 * The ACS case to show for one incident.
 *
 * @param {object} incident the selected incident record
 * @param {object} payload  the loaded task file
 * @returns {object|null} the case, or null when the tasks are unavailable
 */
export function caseForIncident(incident, payload) {
  const tasks = payload?.tasks ?? [];
  if (!tasks.length || !incident) return null;

  const key = incident.id ?? incident.sourceId ?? incident.code ?? '';
  // When a task's Event # ever matches the incident, that is a real link and takes precedence.
  const byEvent = tasks.findIndex(task => task.eventNumber
    && String(incident.id ?? '').includes(String(task.eventNumber)));
  const index = byEvent >= 0 ? byEvent : hashOf(key) % tasks.length;
  const task = tasks[index];

  return Object.freeze({
    caseId: caseIdFor(index),
    task,
    stages: stagesOf(task),
    findings: completenessFindings(task),
    evidence: byEvent >= 0 ? CASE_EVIDENCE.EVENT_NUMBER : CASE_EVIDENCE.ILLUSTRATIVE,
    /** Said in full wherever the case is shown. */
    evidenceNote: byEvent >= 0
      ? `Linked by Event # ${task.eventNumber}.`
      : 'This ACS case is shown against this incident for illustration. Nothing in either record '
        + 'links them: the form carries no identifier the incident register also holds. The task '
        + 'itself, and everything in it, is a real ACS submission.',
    absentFields: ABSENT_FIELDS,
    sourceNote: payload.note,
  });
}

/* --- the Repair, QC/QA and Claims sections ---------------------------------------------------
 *
 * Each of these is built from the form's own fields. Where the client's design shows a figure the
 * export does not carry — crew hours, material quantities, traffic-control type, checklist results,
 * a missing-cost total — the builder returns an absence with the reason, and the panel draws that
 * absence. None of them invents a number to fill the shape.
 */

/** Work-order style status, derived from which stages were actually filed. */
export function repairSummary(task, record = null) {
  const repair = stageOf(task, 'REPAIR');
  const inspection = stageOf(task, 'INSPECTION');
  const qc = stageOf(task, 'QC');
  const status = qc ? 'QC filed' : repair ? 'Repair filed' : inspection ? 'Inspection only' : 'No stage filed';
  return Object.freeze({
    /** The record this case was opened from, when it is a work order — otherwise the ACS task. */
    workOrderId: record?.type === 'WORK_ORDER' || /^WO-/i.test(record?.id ?? '')
      ? record.id : null,
    taskNumber: task.taskNumber,
    workPerformed: repair?.workDescription ?? repair?.itemsRepaired ?? null,
    itemsRepaired: repair?.itemsRepaired ?? null,
    repairBy: repair?.repairBy ?? null,
    completedDate: repair?.date ?? null,
    status,
    /** Repair stage filed and nothing after it, so completion is filed rather than verified. */
    statusIsFiledNotVerified: Boolean(repair) && !qc,
    photos: (repair?.repairPhotos ?? 0) + (inspection?.inspectionPhotos ?? 0),
    thirdPartyName: repair?.thirdPartyName ?? null,
    thirdPartyCostUSD: repair?.thirdPartyCostUSD ?? null,
  });
}

/**
 * QC and QA state.
 *
 * The form has a QC/QA section and a signatory field. It does not export the checklist items or
 * their results, so `checklist` is always null and the panel says what would be needed. A set of
 * plausible guardrail questions with plausible answers would look exactly like the real thing and
 * be entirely invented.
 */
export function qcStatus(task) {
  const qc = stageOf(task, 'QC');
  const signatory = stagesOf(task).map(stage => stage.qcBy).find(Boolean) ?? null;
  return Object.freeze({
    qcState: qc ? 'FILED' : signatory ? 'SIGNED_NOT_FILED' : 'NOT_FILED',
    qcLabel: qc ? 'QC stage filed' : signatory ? 'Signed, no QC stage' : 'Not filed',
    qaState: qc ? 'PENDING' : 'NOT_REACHED',
    qaLabel: qc ? 'Pending' : 'Not reached',
    signatory,
    qcDate: qc?.date ?? null,
    /** Item-level results are not in the export. Never a fabricated list. */
    checklist: null,
    checklistNote: 'The form carries a QC/QA section, but the export contains no checklist items '
      + 'and no per-item results — only whether the stage was filed and who signed it. Item-level '
      + 'pass/fail needs ACS to export the checklist rows.',
  });
}

/** One row of the claim-readiness review. */
const docRow = (label, state, note) => Object.freeze({ label, state, note });

/** Documentation states, in the order they degrade. */
export const DOC_STATE = Object.freeze({
  AVAILABLE: 'AVAILABLE', VERIFY: 'VERIFY', PENDING: 'PENDING', MISSING: 'MISSING',
});

/**
 * Whether this task could support a damage claim, judged only on what the record holds.
 *
 * The documented cost is real and comes from the form. The "missing" cost the client's design
 * shows is deliberately NOT produced: with no labour, equipment or material lines there is no
 * basis for a figure, and an invented one would be the number a claim is argued over.
 */
export function claimReadiness(task) {
  const inspection = stageOf(task, 'INSPECTION');
  const repair = stageOf(task, 'REPAIR');
  const qc = qcStatus(task);
  const photos = stagesOf(task)
    .reduce((total, stage) => total + stage.inspectionPhotos + stage.repairPhotos, 0);
  const documentedUSD = stagesOf(task)
    .reduce((total, stage) => total + (stage.thirdPartyCostUSD ?? 0), 0);

  const rows = [
    docRow('Incident report (SunGuide / FL511)',
      task.eventNumber ? DOC_STATE.AVAILABLE : DOC_STATE.MISSING,
      task.eventNumber ? `Event # ${task.eventNumber}` : 'No Event # on this form'),
    docRow('Police case number',
      task.policeCaseNumber ? DOC_STATE.AVAILABLE : DOC_STATE.MISSING,
      task.policeCaseNumber ?? 'Not recorded'),
    docRow('Inspection record and photos',
      inspection ? (photos > 0 ? DOC_STATE.AVAILABLE : DOC_STATE.VERIFY) : DOC_STATE.MISSING,
      inspection ? `${photos} photo${photos === 1 ? '' : 's'} recorded; files not supplied`
        : 'No inspection stage filed'),
    docRow('Repair record',
      repair ? DOC_STATE.AVAILABLE : DOC_STATE.MISSING,
      repair ? `Filed ${repair.date ?? 'undated'}` : 'No repair stage filed'),
    docRow('QC/QA approval',
      qc.qcState === 'FILED' ? DOC_STATE.PENDING
        : qc.qcState === 'SIGNED_NOT_FILED' ? DOC_STATE.VERIFY : DOC_STATE.MISSING,
      qc.signatory ? `Signed by ${qc.signatory}` : 'No QC stage and no signatory'),
    docRow('Labor documentation', DOC_STATE.MISSING, 'Sub-table not included in the export'),
    docRow('Service vehicle documentation', DOC_STATE.MISSING, 'Sub-table not included in the export'),
    docRow('Equipment and traffic control', DOC_STATE.MISSING, 'Sub-table not included in the export'),
    docRow('Material quantities and invoices',
      documentedUSD > 0 ? DOC_STATE.VERIFY : DOC_STATE.MISSING,
      documentedUSD > 0 ? 'A third-party invoice is recorded; material lines are not'
        : 'No material lines and no invoice'),
  ];

  const missing = rows.filter(row => row.state === DOC_STATE.MISSING).length;
  return Object.freeze({
    rows: Object.freeze(rows),
    documentedUSD,
    missingCount: missing,
    /** Ready only when nothing is outstanding. On this export that is never true. */
    ready: missing === 0 && rows.every(row => row.state === DOC_STATE.AVAILABLE),
    /** Said instead of a figure, because no figure is derivable. */
    undocumentedCostNote: 'Not quantifiable. Labour, equipment and material lines are absent from '
      + 'the export, so the value of what is undocumented cannot be estimated — only the number of '
      + 'missing documents is known.',
  });
}
