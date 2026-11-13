/**
 * Reconciliation: does what arrived match what the sources hold?
 *
 * Every number is a COUNT(*) over the SQLite tables at the moment the check runs. Nothing here is
 * a demo counter, and no total is written down anywhere.
 *
 * EXCLUDED IS NOT FAILED, and it has its own column for that reason. The work-in-progress model
 * version is deliberately kept out of the inbound sync; counting it as an unmatched record would
 * send a BIM coordinator looking for an import failure that never happened.
 *
 * Each check states `checked = matched + unmatched + excluded`, and a test holds that identity.
 */

import { recordAudit } from './sync.mjs';

export const CHECK_STATUS = Object.freeze({ PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' });

const nowIso = () => new Date().toISOString();

const one = (db, sql, ...params) => db.prepare(sql).get(...params);
const n = (db, sql, ...params) => one(db, sql, ...params).n;

/**
 * Run every check. Pure read; returns the results rather than storing them.
 */
export function reconcile(db) {
  /*
   * One accounting model for every check:
   *
   *   checked = matched + unmatched + excluded      (always, and a test holds it)
   *   warnings is a SUBSET of unmatched             (not a third bucket)
   *
   * So the status falls out: anything unmatched that is NOT merely a warning is a failure; a
   * check whose only unmatched records are warnings warns; everything else passes. Counting
   * warnings on their own axis is what broke the identity on two checks.
   */
  const check = ({ id, label, checked, matched, unmatched = 0, warnings = 0, excluded = 0, detail }) => {
    const hard = unmatched - warnings;
    const status = hard > 0 ? CHECK_STATUS.FAIL
      : warnings > 0 ? CHECK_STATUS.WARN : CHECK_STATUS.PASS;
    return { id, label, checked, matched, unmatched, warnings, excluded, status, detail };
  };
  const checks = [];

  // 1. Activities: every P6 row arrived.
  const srcActivities = n(db, 'SELECT COUNT(*) AS n FROM src_p6_activity');
  const gotActivities = n(db, "SELECT COUNT(*) AS n FROM activity WHERE source_system = 'P6'");
  checks.push(check({ id: 'ACTIVITY_COUNT', label: 'P6 activity count',
    checked: srcActivities, matched: gotActivities, unmatched: srcActivities - gotActivities,
    detail: `${gotActivities} of ${srcActivities} P6 activities are in SYNCHRO 4D.` }));

  // 2. Elements: published versions only, and the exclusion is stated rather than subtracted.
  // DISTINCT element ids, not source rows: an element appears once per model version it is in,
  // and 694 rows describe 500 elements. Comparing rows to elements reported 194 phantom failures.
  const srcElements = n(db, 'SELECT COUNT(DISTINCT element_id) AS n FROM src_acc_element');
  const expectedElements = n(db,
    `SELECT COUNT(DISTINCT e.element_id) AS n FROM src_acc_element e
       JOIN src_acc_model_version v ON v.version_id = e.version_id WHERE v.state = 'PUBLISHED'`);
  const excludedElements = srcElements - expectedElements;
  const gotElements = n(db, "SELECT COUNT(*) AS n FROM element WHERE source_system = 'ACC'");
  checks.push(check({ id: 'ELEMENT_COUNT', label: 'BIM element count',
    checked: srcElements, matched: gotElements,
    unmatched: expectedElements - gotElements, excluded: excludedElements,
    detail: `${gotElements} of ${expectedElements} element(s) in a published model version are in `
      + `SYNCHRO 4D; ${excludedElements} exist only in an unpublished version and are excluded by `
      + 'policy. An excluded element is not a failed import.' }));

  // 3. Model versions, published against held back.
  const srcVersions = n(db, 'SELECT COUNT(*) AS n FROM src_acc_model_version');
  const wip = n(db, "SELECT COUNT(*) AS n FROM src_acc_model_version WHERE state <> 'PUBLISHED'");
  const gotVersions = n(db, "SELECT COUNT(*) AS n FROM model_version WHERE source_system = 'ACC'");
  checks.push(check({ id: 'MODEL_VERSION_STATE', label: 'Published versus unpublished model versions',
    checked: srcVersions, matched: gotVersions, unmatched: srcVersions - wip - gotVersions,
    excluded: wip,
    detail: `${gotVersions} published version(s) synchronised; ${wip} held back as `
      + 'WORK_IN_PROGRESS under ISO 19650. Correct, not an error.' }));

  // 4. WBS coverage on both sides.
  const srcP6Wbs = n(db, 'SELECT COUNT(*) AS n FROM src_p6_wbs');
  const gotP6Wbs = n(db, "SELECT COUNT(*) AS n FROM wbs WHERE source_system = 'P6'");
  const srcSapWbs = n(db, 'SELECT COUNT(*) AS n FROM src_sap_wbs');
  const gotSapWbs = n(db, "SELECT COUNT(*) AS n FROM wbs WHERE source_system = 'SAP'");
  checks.push(check({ id: 'WBS_COVERAGE', label: 'WBS coverage',
    checked: srcP6Wbs + srcSapWbs, matched: gotP6Wbs + gotSapWbs,
    unmatched: (srcP6Wbs - gotP6Wbs) + (srcSapWbs - gotSapWbs),
    detail: `${gotP6Wbs} of ${srcP6Wbs} P6 nodes and ${gotSapWbs} of ${srcSapWbs} SAP nodes are `
      + 'in SYNCHRO 4D. The two structures are kept apart; whether they correspond is the next check.' }));

  // 5. Element → activity coverage.
  const mapped = n(db, 'SELECT COUNT(*) AS n FROM mapping WHERE activity_id IS NOT NULL');
  const unmappedElements = n(db, 'SELECT COUNT(*) AS n FROM mapping WHERE activity_id IS NULL');
  checks.push(check({ id: 'ELEMENT_ACTIVITY_COVERAGE', label: 'Element-to-activity mapping coverage',
    checked: mapped + unmappedElements, matched: mapped, unmatched: unmappedElements,
    detail: `${unmappedElements} element(s) carry no activity reference, so nothing in the `
      + 'schedule builds them.' }));

  // 6. Activity → WBS coverage.
  const activitiesWithWbs = n(db,
    `SELECT COUNT(*) AS n FROM activity a WHERE a.source_system = 'P6'
       AND EXISTS (SELECT 1 FROM wbs w WHERE w.source_system = 'P6' AND w.source_id = a.wbs_code)`);
  checks.push(check({ id: 'ACTIVITY_WBS_COVERAGE', label: 'Activity-to-WBS mapping coverage',
    checked: gotActivities, matched: activitiesWithWbs, unmatched: gotActivities - activitiesWithWbs,
    detail: `${activitiesWithWbs} of ${gotActivities} activities sit under a published P6 WBS node.` }));

  // 7. P6 ↔ SAP correspondence. The one real mismatch in the seed lives here.
  const correspondence = db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM wbs p WHERE p.source_system = 'P6'
          AND EXISTS (SELECT 1 FROM wbs s WHERE s.source_system = 'SAP' AND s.source_id = p.source_id)) AS both,
       (SELECT COUNT(*) FROM wbs p WHERE p.source_system = 'P6'
          AND NOT EXISTS (SELECT 1 FROM wbs s WHERE s.source_system = 'SAP' AND s.source_id = p.source_id)) AS p6Only,
       (SELECT COUNT(*) FROM wbs s WHERE s.source_system = 'SAP'
          AND NOT EXISTS (SELECT 1 FROM wbs p WHERE p.source_system = 'P6' AND p.source_id = s.source_id)) AS sapOnly`).get();
  checks.push(check({ id: 'WBS_CORRESPONDENCE', label: 'P6-to-SAP WBS correspondence',
    checked: correspondence.both + correspondence.p6Only + correspondence.sapOnly,
    matched: correspondence.both, unmatched: correspondence.p6Only + correspondence.sapOnly,
    detail: `${correspondence.both} code(s) in both systems; ${correspondence.p6Only} only in P6, `
      + `${correspondence.sapOnly} only in SAP. A code on one side alone cannot be compared like `
      + 'for like, and the integration layer must not invent its counterpart.' }));

  // 8. BOQ coverage: a mapping is only complete when the BOQ item is settled.
  const withBoq = n(db, 'SELECT COUNT(*) AS n FROM mapping WHERE boq_code IS NOT NULL');
  const needsSelection = n(db, "SELECT COUNT(*) AS n FROM mapping WHERE status = 'NEEDS_SELECTION'");
  const noBoqPath = n(db, 'SELECT COUNT(*) AS n FROM mapping WHERE boq_code IS NULL AND boq_candidates = 0');
  // `warnings` is a SUBSET of `unmatched`, not a third bucket: a mapping awaiting a choice is
  // genuinely not matched, and counting it on its own axis broke checked = matched + unmatched
  // + excluded.
  const totalMappings = n(db, 'SELECT COUNT(*) AS n FROM mapping');
  checks.push(check({ id: 'BOQ_COVERAGE', label: 'BOQ mapping coverage',
    checked: totalMappings, matched: withBoq,
    unmatched: totalMappings - withBoq, warnings: needsSelection,
    detail: `${withBoq} mapped to a BOQ item; ${needsSelection} await a choice among the `
      + `candidates their WBS offers; ${noBoqPath} have no BOQ item to reach at all.` }));

  // 9. Units, compared only where both sides record one.
  const comparable = n(db,
    `SELECT COUNT(*) AS n FROM mapping m JOIN element e ON e.source_id = m.element_id
       JOIN boq_item b ON b.source_id = m.boq_code
      WHERE e.unit IS NOT NULL AND b.unit IS NOT NULL`);
  const unitMismatch = n(db,
    `SELECT COUNT(*) AS n FROM mapping m JOIN element e ON e.source_id = m.element_id
       JOIN boq_item b ON b.source_id = m.boq_code
      WHERE e.unit IS NOT NULL AND b.unit IS NOT NULL AND e.unit <> b.unit`);
  checks.push(check({ id: 'UNIT_CONSISTENCY', label: 'Quantity and unit consistency',
    checked: comparable, matched: comparable - unitMismatch,
    unmatched: unitMismatch, warnings: unitMismatch,
    detail: `${unitMismatch} mapping(s) measure the model and the BOQ in different units. `
      + 'Compared only where both record one; an absent quantity is not a failure.' }));

  // 10. Source revision consistency: is every mapping built from the records now stored?
  const stale = n(db,
    `SELECT COUNT(*) AS n FROM mapping m
       LEFT JOIN activity a ON a.source_id = m.activity_id AND a.source_system = 'P6'
      WHERE m.activity_id IS NOT NULL
        AND m.source_rev <> ('e' || (SELECT source_rev FROM element e WHERE e.source_id = m.element_id
              AND e.source_system = 'ACC') || '/a' || COALESCE(a.source_rev, 0))`);
  const total = n(db, 'SELECT COUNT(*) AS n FROM mapping');
  checks.push(check({ id: 'SOURCE_REVISION', label: 'Source revision consistency',
    checked: total, matched: total - stale, unmatched: stale, warnings: stale,
    detail: stale === 0
      ? 'Every mapping was built from the record revisions currently stored.'
      : `${stale} mapping(s) were built from an earlier revision and need rebuilding.` }));

  return checks;
}

/**
 * Run the checks and store them, so a reconciliation has a time and a history.
 *
 * It records an audit event of its own. Before Phase 6 a standalone reconciliation wrote its run
 * and left no trace in the trail, so "when was this last reconciled, and by whom?" could only be
 * answered from inside the reconciliation screen.
 */
export function storeReconciliation(db, checks, { actor = 'Integration service', now = nowIso } = {}) {
  const at = now();
  const runId = db.prepare(
    'INSERT INTO reconciliation_run (at, actor, checks, passed, warnings, failed) VALUES (?, ?, ?, ?, ?, ?)')
    .run(at, actor, checks.length,
      checks.filter(entry => entry.status === CHECK_STATUS.PASS).length,
      checks.filter(entry => entry.status === CHECK_STATUS.WARN).length,
      checks.filter(entry => entry.status === CHECK_STATUS.FAIL).length).lastInsertRowid;
  const insert = db.prepare(
    `INSERT INTO reconciliation_check (run_id, check_id, label, checked, matched, unmatched,
        warnings, excluded, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const entry of checks) {
    insert.run(runId, entry.id, entry.label, entry.checked, entry.matched, entry.unmatched,
      entry.warnings, entry.excluded, entry.status, entry.detail);
  }
  const failed = checks.filter(entry => entry.status === CHECK_STATUS.FAIL).length;
  recordAudit(db, { at, actor, event: 'RECONCILIATION', subject: `run-${runId}`,
    result: failed ? `${failed} check(s) failed` : 'All checks passed',
    detail: { runId: Number(runId), checks: checks.length,
      passed: checks.filter(e => e.status === CHECK_STATUS.PASS).length,
      warnings: checks.filter(e => e.status === CHECK_STATUS.WARN).length, failed } });
  return Object.freeze({ runId: Number(runId), at, checks });
}

/** The latest reconciliation, with its checks. Null before one has ever run. */
export function latestReconciliation(db) {
  const run = db.prepare('SELECT * FROM reconciliation_run ORDER BY id DESC LIMIT 1').get();
  if (!run) return null;
  return { run, checks: db.prepare('SELECT * FROM reconciliation_check WHERE run_id = ? ORDER BY id').all(run.id) };
}
