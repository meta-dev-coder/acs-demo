/**
 * The eleven deterministic validation rules.
 *
 * SERVER-SIDE, and the results are stored: a finding is a row with a first-seen date, an expected
 * and an actual value, and a status — not something a screen works out on the way to drawing it.
 * Two readers looking at the same element therefore see the same finding.
 *
 * THREE SEVERITIES, and keeping them apart is most of the point:
 *
 *   ERROR    a definite failure. The chain is broken or contradicts itself.
 *   WARNING  something a person must look at. It may be correct.
 *   EXCLUDED policy, not a fault. A work-in-progress model is not a failed import, and reporting
 *            it as one would have a BIM coordinator chasing a problem that does not exist.
 *
 * A field that is simply absent from the synthetic source is NOT a failure. `element.quantity` is
 * optional in this dataset, so its absence produces nothing; only a quantity that contradicts the
 * BOQ does.
 *
 * Each rule is a pure function of the database. Running them twice produces the same rows.
 */
import { MAPPING_STATUS } from './mapping.mjs';
import { recordAudit } from './sync.mjs';

export const SEVERITY = Object.freeze({
  ERROR: 'ERROR', WARNING: 'WARNING', EXCLUDED: 'EXCLUDED',
});

export const RESULT_STATUS = Object.freeze({ OPEN: 'OPEN', CLEARED: 'CLEARED' });

/**
 * Who owns each kind of finding.
 *
 * It matters because the proposal's own principle is that source data is corrected at source: a
 * mapping gap is the integration layer's to propose, a WBS structure mismatch is not.
 */
export const OWNER = Object.freeze({
  BIM: 'bimCoordinator',
  PLANNER: 'planner',
  FINANCE: 'financeController',
  INTEGRATION: 'integrationLead',
});

const text = value => (value == null ? null : String(value));

/** A finding. `key` is what makes a repeat run update rather than append. */
const finding = ({ ruleId, subjectType, subjectId, severity, expected, actual, explanation,
  sourceRev = null, owner, interfaceId = null, suggestedAction }) => Object.freeze({
  key: `${ruleId}:${subjectId}`,
  ruleId, subjectType, subjectId, severity,
  expected: text(expected), actual: text(actual),
  explanation, sourceRev, owner, interfaceId, suggestedAction,
});

/**
 * The rules.
 *
 * `actionable` says whether a finding becomes an exception. An EXCLUDED finding is recorded and
 * shown, but nobody is asked to fix it.
 */
export const RULES = Object.freeze([
  Object.freeze({ id: 'R01_BIM_NO_ACTIVITY', label: 'BIM element without P6 activity',
    severity: SEVERITY.ERROR, owner: OWNER.BIM, interfaceId: 'INT-03', actionable: true }),
  Object.freeze({ id: 'R02_P6_ACTIVITY_NOT_FOUND', label: 'Referenced P6 activity does not exist',
    severity: SEVERITY.ERROR, owner: OWNER.PLANNER, interfaceId: 'INT-01', actionable: true }),
  Object.freeze({ id: 'R03_P6_WBS_MISSING', label: 'P6 activity carries no WBS',
    severity: SEVERITY.ERROR, owner: OWNER.PLANNER, interfaceId: 'INT-01', actionable: true }),
  Object.freeze({ id: 'R04_SAP_WBS_MISMATCH', label: 'P6 and SAP WBS do not correspond',
    severity: SEVERITY.ERROR, owner: OWNER.FINANCE, interfaceId: 'INT-04', actionable: true }),
  Object.freeze({ id: 'R05_BOQ_MISSING', label: 'No BOQ item under the SAP WBS',
    severity: SEVERITY.ERROR, owner: OWNER.FINANCE, interfaceId: 'INT-04', actionable: true }),
  Object.freeze({ id: 'R06_UNIT_INCOMPATIBLE', label: 'Model and BOQ units of measure disagree',
    severity: SEVERITY.WARNING, owner: OWNER.FINANCE, interfaceId: 'INT-04', actionable: true }),
  Object.freeze({ id: 'R07_LOCATION_INCONSISTENT', label: 'Work package does not match the WBS',
    severity: SEVERITY.WARNING, owner: OWNER.BIM, interfaceId: 'INT-03', actionable: true }),
  Object.freeze({ id: 'R08_DUPLICATE_MAPPING', label: 'Conflicting mapping proposals',
    severity: SEVERITY.ERROR, owner: OWNER.INTEGRATION, interfaceId: null, actionable: true }),
  Object.freeze({ id: 'R09_UNPUBLISHED_MODEL', label: 'Model version is not published',
    severity: SEVERITY.EXCLUDED, owner: OWNER.BIM, interfaceId: 'INT-03', actionable: false }),
  Object.freeze({ id: 'R10_ELEMENT_REMOVED', label: 'Element absent from a newer published version',
    severity: SEVERITY.WARNING, owner: OWNER.BIM, interfaceId: 'INT-03', actionable: true }),
  Object.freeze({ id: 'R11_SEQUENCE_INCONSISTENT', label: 'Activity sequence contradicts the build order',
    severity: SEVERITY.WARNING, owner: OWNER.PLANNER, interfaceId: 'INT-01', actionable: true }),
]);

export const ruleById = id => RULES.find(rule => rule.id === id) ?? null;

const LEVEL_ORDER = ['Level 1', 'Level 2', 'Level 3', 'Level 4', 'Level 5'];

/**
 * Run every rule. Pure: it reads and returns findings, and writes nothing.
 *
 * @returns {object[]} findings, in rule order
 */
export function validate(db) {
  const findings = [];
  const mappings = db.prepare('SELECT * FROM mapping ORDER BY element_id').all();
  const elements = new Map(db.prepare("SELECT * FROM element WHERE source_system = 'ACC'").all()
    .map(row => [row.source_id, row]));
  const activities = new Map(db.prepare("SELECT * FROM activity WHERE source_system = 'P6'").all()
    .map(row => [row.source_id, row]));
  const p6Wbs = new Map(db.prepare("SELECT * FROM wbs WHERE source_system = 'P6'").all()
    .map(row => [row.source_id, row]));
  const sapWbs = new Map(db.prepare("SELECT * FROM wbs WHERE source_system = 'SAP'").all()
    .map(row => [row.source_id, row]));
  const boq = new Map(db.prepare('SELECT * FROM boq_item').all().map(row => [row.source_id, row]));

  for (const mapping of mappings) {
    const element = elements.get(mapping.element_id) ?? null;
    const rev = mapping.source_rev;

    // R01 — nothing in the model says which activity builds this.
    if (!mapping.activity_id) {
      findings.push(finding({ ruleId: 'R01_BIM_NO_ACTIVITY', subjectType: 'element',
        subjectId: mapping.element_id, severity: SEVERITY.ERROR, owner: OWNER.BIM,
        interfaceId: 'INT-03', sourceRev: rev,
        expected: 'A P6 activity id', actual: 'none',
        explanation: `${mapping.element_id} carries no activity reference, so nothing in the `
          + 'schedule builds it and it cannot appear in a 4D sequence.',
        suggestedAction: 'Review the candidate activities and propose a mapping for approval.' }));
      continue;
    }

    // R02 — it names one, and P6 does not have it.
    const activity = activities.get(mapping.activity_id) ?? null;
    if (!activity) {
      findings.push(finding({ ruleId: 'R02_P6_ACTIVITY_NOT_FOUND', subjectType: 'element',
        subjectId: mapping.element_id, severity: SEVERITY.ERROR, owner: OWNER.PLANNER,
        interfaceId: 'INT-01', sourceRev: rev,
        expected: `Activity ${mapping.activity_id} in P6`, actual: 'not in the synced schedule',
        explanation: `${mapping.element_id} references activity ${mapping.activity_id}, which the `
          + 'P6 schedule does not carry. Either the model is stale or the activity was deleted.',
        suggestedAction: 'Confirm with the planner whether the activity was removed, then remap.' }));
      continue;
    }

    // R03 — the activity exists but sits under no WBS the schedule published.
    if (!mapping.p6_wbs_code) {
      findings.push(finding({ ruleId: 'R03_P6_WBS_MISSING', subjectType: 'activity',
        subjectId: mapping.activity_id, severity: SEVERITY.ERROR, owner: OWNER.PLANNER,
        interfaceId: 'INT-01', sourceRev: rev,
        expected: 'A WBS code present in the P6 breakdown',
        actual: activity.wbs_code ?? 'none',
        explanation: `Activity ${mapping.activity_id} is not under a WBS node the schedule `
          + 'published, so its work cannot be rolled up or costed.',
        suggestedAction: 'The planner corrects the breakdown in P6; it is not an integration fix.' }));
      continue;
    }

    // R04 — P6 has a code SAP does not. Source-owned: nothing here may invent a counterpart.
    if (!mapping.sap_wbs_code) {
      findings.push(finding({ ruleId: 'R04_SAP_WBS_MISMATCH', subjectType: 'wbs',
        subjectId: mapping.p6_wbs_code, severity: SEVERITY.ERROR, owner: OWNER.FINANCE,
        interfaceId: 'INT-04', sourceRev: rev,
        expected: `SAP WBS ${mapping.p6_wbs_code}`, actual: 'no counterpart in SAP',
        explanation: `P6 WBS ${mapping.p6_wbs_code} has no SAP counterpart, so schedule and cost `
          + 'cannot be compared like for like under it.',
        suggestedAction: 'Finance aligns the structure in SAP. The integration layer must not '
          + 'invent a counterpart.' }));
      continue;
    }

    // R05 — the cost structure exists but carries nothing measurable.
    if (mapping.boq_candidates === 0) {
      findings.push(finding({ ruleId: 'R05_BOQ_MISSING', subjectType: 'wbs',
        subjectId: mapping.sap_wbs_code, severity: SEVERITY.ERROR, owner: OWNER.FINANCE,
        interfaceId: 'INT-04', sourceRev: rev,
        expected: 'At least one BOQ item under the SAP WBS', actual: 'none',
        explanation: `SAP WBS ${mapping.sap_wbs_code} carries no BOQ item, so no quantity or rate `
          + 'can be attached to the work under it.',
        suggestedAction: 'Finance confirms whether the WBS is measured work or an overhead.' }));
      continue;
    }

    // R06 — units. Only compared where BOTH are recorded: an absent quantity is not a failure.
    const chosen = mapping.boq_code ? boq.get(mapping.boq_code) ?? null : null;
    if (chosen && element?.unit && chosen.unit && element.unit !== chosen.unit) {
      findings.push(finding({ ruleId: 'R06_UNIT_INCOMPATIBLE', subjectType: 'element',
        subjectId: mapping.element_id, severity: SEVERITY.WARNING, owner: OWNER.FINANCE,
        interfaceId: 'INT-04', sourceRev: rev,
        expected: `BOQ ${chosen.source_id} measured in ${chosen.unit}`,
        actual: `${mapping.element_id} modelled in ${element.unit}`,
        explanation: `${mapping.element_id} is modelled in ${element.unit} and BOQ item `
          + `${chosen.source_id} is measured in ${chosen.unit}. Quantity × unit rate cannot be `
          + 'relied on across a unit change without a conversion Finance recognises.',
        suggestedAction: 'Confirm the conversion with Finance, or map to a BOQ item in the same unit.' }));
    }

    // R07 — the element says it belongs to one package and the WBS is another.
    const wbsNode = p6Wbs.get(mapping.p6_wbs_code) ?? null;
    if (element?.work_package && wbsNode?.name && element.work_package !== wbsNode.name) {
      findings.push(finding({ ruleId: 'R07_LOCATION_INCONSISTENT', subjectType: 'element',
        subjectId: mapping.element_id, severity: SEVERITY.WARNING, owner: OWNER.BIM,
        interfaceId: 'INT-03', sourceRev: rev,
        expected: `Work package "${wbsNode.name}" (WBS ${mapping.p6_wbs_code})`,
        actual: `"${element.work_package}"`,
        explanation: `${mapping.element_id} declares work package "${element.work_package}" but its `
          + `activity sits under WBS ${mapping.p6_wbs_code} "${wbsNode.name}". One of the two is wrong.`,
        suggestedAction: 'The BIM coordinator confirms the element property against the schedule.' }));
    }

    // R11 — a higher level built before the one under it.
    if (element?.level && activity.planned_start) {
      const index = LEVEL_ORDER.indexOf(element.level);
      if (index > 0) {
        const below = LEVEL_ORDER[index - 1];
        const earliestBelow = db.prepare(
          `SELECT MIN(a.planned_start) AS at FROM element e
             JOIN mapping m ON m.element_id = e.source_id
             JOIN activity a ON a.source_id = m.activity_id AND a.source_system = 'P6'
            WHERE e.level = ? AND e.discipline = ?`).get(below, element.discipline)?.at ?? null;
        if (earliestBelow && activity.planned_start < earliestBelow) {
          findings.push(finding({ ruleId: 'R11_SEQUENCE_INCONSISTENT', subjectType: 'element',
            subjectId: mapping.element_id, severity: SEVERITY.WARNING, owner: OWNER.PLANNER,
            interfaceId: 'INT-01', sourceRev: rev,
            expected: `Start on or after ${earliestBelow} (${below}, ${element.discipline})`,
            actual: `${activity.planned_start} (${element.level})`,
            explanation: `${mapping.element_id} is on ${element.level} and its activity `
              + `${mapping.activity_id} starts ${activity.planned_start}, before any `
              + `${element.discipline.toLowerCase()} work on ${below}. A 4D sequence built from this `
              + 'would show the upper level going up first.',
            suggestedAction: 'The planner confirms the logic, or the element is mapped to the right activity.' }));
        }
      }
    }
  }

  // R04, the other direction: a SAP cost structure P6 does not carry. No element maps to it, so
  // the per-element pass above can never see it — and the seeded mismatch is exactly this shape.
  for (const row of db.prepare(
    `SELECT s.source_id, s.name FROM wbs s WHERE s.source_system = 'SAP'
        AND NOT EXISTS (SELECT 1 FROM wbs p WHERE p.source_system = 'P6' AND p.source_id = s.source_id)
      ORDER BY s.source_id`).all()) {
    findings.push(finding({ ruleId: 'R04_SAP_WBS_MISMATCH', subjectType: 'wbs',
      subjectId: row.source_id, severity: SEVERITY.ERROR, owner: OWNER.FINANCE,
      interfaceId: 'INT-04',
      expected: `P6 WBS ${row.source_id}`, actual: 'no counterpart in P6',
      explanation: `SAP carries WBS ${row.source_id} "${row.name}" and the P6 breakdown does not. `
        + 'Cost booked against it has no schedule to compare with, and no activity can roll up to it.',
      suggestedAction: 'Finance and the planner agree which structure is right. The integration '
        + 'layer must not create a P6 node to match it.' }));
  }

  // R08 — two undecided proposals for the same field of the same element.
  for (const row of db.prepare(
    `SELECT element_id, field, COUNT(*) AS n FROM mapping_proposal
      WHERE status IN ('PROPOSED', 'PENDING_REVIEW') GROUP BY element_id, field HAVING n > 1`).all()) {
    findings.push(finding({ ruleId: 'R08_DUPLICATE_MAPPING', subjectType: 'element',
      subjectId: row.element_id, severity: SEVERITY.ERROR, owner: OWNER.INTEGRATION,
      expected: 'One open proposal per field', actual: `${row.n} open proposals for ${row.field}`,
      explanation: `${row.n} undecided proposals change ${row.field} on ${row.element_id}. `
        + 'Approving either would silently discard the other.',
      suggestedAction: 'Withdraw the proposals that are not wanted, then approve one.' }));
  }

  // R09 — excluded by policy, recorded so the exclusion is visible and explained.
  for (const row of db.prepare(
    "SELECT * FROM src_acc_model_version WHERE state <> 'PUBLISHED' ORDER BY version_id").all()) {
    findings.push(finding({ ruleId: 'R09_UNPUBLISHED_MODEL', subjectType: 'modelVersion',
      subjectId: row.version_id, severity: SEVERITY.EXCLUDED, owner: OWNER.BIM,
      interfaceId: 'INT-03',
      expected: 'PUBLISHED before it may be synchronised', actual: row.state,
      explanation: `${row.version_id} (${row.model_name} v${row.version}) is ${row.state}. `
        + 'ISO 19650 keeps work in progress inside the authoring team, so INT-03 excludes it. '
        + 'This is a policy exclusion and not a failed import.',
      suggestedAction: 'None. It synchronises when the BIM coordinator publishes it.' }));
  }

  // R10 — mapped to an element a newer published version of the same model no longer contains.
  for (const row of db.prepare(
    `SELECT m.element_id, m.model_version_id, v.model_name, v.version AS mapped_version,
            newest.source_id AS newest_version, newest.version AS newest_number
       FROM mapping m
       JOIN model_version v ON v.source_id = m.model_version_id AND v.source_system = 'ACC'
       JOIN model_version newest ON newest.model_name = v.model_name AND newest.source_system = 'ACC'
      WHERE newest.version > v.version
        AND NOT EXISTS (SELECT 1 FROM element e WHERE e.source_system = 'ACC'
                          AND e.source_id = m.element_id AND e.model_version_id = newest.source_id)
      ORDER BY m.element_id`).all()) {
    findings.push(finding({ ruleId: 'R10_ELEMENT_REMOVED', subjectType: 'element',
      subjectId: row.element_id, severity: SEVERITY.WARNING, owner: OWNER.BIM,
      interfaceId: 'INT-03',
      expected: `${row.element_id} present in ${row.newest_version}`,
      actual: `only in ${row.model_version_id} (v${row.mapped_version})`,
      explanation: `${row.element_id} is mapped against ${row.model_name} v${row.mapped_version}, `
        + `but v${row.newest_number} no longer contains it. The mapping may be stale.`,
      suggestedAction: 'The BIM coordinator confirms whether the element was removed or renamed.' }));
  }

  return findings;
}

/**
 * Store the findings.
 *
 * An existing finding has its `last_seen` moved and keeps its `first_seen`; one that no longer
 * appears is CLEARED rather than deleted, so the history survives.
 */
export function storeValidation(db, findings, { actor = 'Integration service', now = () => new Date().toISOString() } = {}) {
  const startedAt = now();
  const runId = db.prepare('INSERT INTO validation_run (started_at, actor) VALUES (?, ?)')
    .run(startedAt, actor).lastInsertRowid;
  const seen = new Set(findings.map(entry => entry.key));

  const upsert = db.prepare(
    `INSERT INTO validation_result (result_key, rule_id, subject_type, subject_id, severity,
        expected, actual, explanation, source_rev, status, first_seen, last_seen, cleared_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, NULL)
     ON CONFLICT(result_key) DO UPDATE SET
       severity = excluded.severity, expected = excluded.expected, actual = excluded.actual,
       explanation = excluded.explanation, source_rev = excluded.source_rev,
       status = 'OPEN', last_seen = excluded.last_seen, cleared_at = NULL`);

  db.exec('BEGIN');
  try {
    for (const entry of findings) {
      upsert.run(entry.key, entry.ruleId, entry.subjectType, entry.subjectId, entry.severity,
        entry.expected, entry.actual, entry.explanation, entry.sourceRev, startedAt, startedAt);
    }
    // Anything open that this run did not produce has stopped being true.
    const open = db.prepare("SELECT result_key FROM validation_result WHERE status = 'OPEN'").all();
    const clear = db.prepare(
      "UPDATE validation_result SET status = 'CLEARED', cleared_at = ? WHERE result_key = ?");
    let cleared = 0;
    for (const row of open) {
      if (!seen.has(row.result_key)) { clear.run(startedAt, row.result_key); cleared += 1; }
    }
    const by = severity => findings.filter(entry => entry.severity === severity).length;
    db.prepare(`UPDATE validation_run SET finished_at = ?, subjects_checked = ?, failures = ?,
        warnings = ?, excluded = ?, cleared = ? WHERE id = ?`)
      .run(now(), db.prepare('SELECT COUNT(*) AS n FROM mapping').get().n,
        by(SEVERITY.ERROR), by(SEVERITY.WARNING), by(SEVERITY.EXCLUDED), cleared, runId);
    // The run leaves its own trace, so "when was this last validated?" is answerable from the
    // trail rather than only from inside the validation screen.
    recordAudit(db, { at: startedAt, actor, event: 'VALIDATION_RUN', subject: `run-${runId}`,
      result: `${by(SEVERITY.ERROR)} error(s), ${by(SEVERITY.WARNING)} warning(s)`,
      detail: { runId: Number(runId), total: findings.length, cleared } });
    db.exec('COMMIT');
    return Object.freeze({ runId: Number(runId), total: findings.length,
      errors: by(SEVERITY.ERROR), warnings: by(SEVERITY.WARNING), excluded: by(SEVERITY.EXCLUDED), cleared });
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export { MAPPING_STATUS };
