/**
 * Phase 4: geometry, verified progress, earned value and the draft P6 update.
 *
 * What is held here:
 *
 *  1. PLANNED IS A CLAIM, VERIFIED IS EVIDENCE, and they never merge. A draft observation is not
 *     evidence and contributes nothing.
 *  2. A MEASUREMENT RULE IS DECLARED. Equal-weight counting applies only where configured.
 *  3. A MISSING FIGURE IS NOT A ZERO. No BOQ mapping means no earned value, with a reason.
 *  4. Every drawable element is a database row, and the worked example — A-1020, 12 of 20
 *     columns, 60% against P6's 80% — is exact.
 *  5. A prepared P6 update is a draft and nothing in this build can post it.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import { openConstructionDb } from '../server/construction/db.mjs';
import { buildSeed, seedSourceSystems } from '../server/construction/seed.mjs';
import { createMockAdapters } from '../server/construction/adapters.mjs';
import { runInboundSync } from '../server/construction/sync.mjs';
import { buildMappings } from '../server/construction/mapping.mjs';
import { storeValidation, validate } from '../server/construction/validation.mjs';
import { syncExceptions } from '../server/construction/exceptions.mjs';
import {
  A1020_VERIFIED, LEVELS, RULE, geometryFor, seedProgress,
} from '../server/construction/progressSeed.mjs';
import {
  activityDetail, activityList, activityProgress, activityValue, plannedAt, scheduleVariance,
  verifiedObservations,
} from '../server/construction/progress.mjs';
import { buildModel, listDrafts, modelFacets, prepareP6Draft } from '../server/construction/model.mjs';

function fixture() {
  const db = openConstructionDb({ path: ':memory:' });
  seedSourceSystems(db);
  runInboundSync(db, createMockAdapters(db));
  buildMappings(db);
  const findings = validate(db);
  storeValidation(db, findings);
  syncExceptions(db, findings);
  seedProgress(db);
  return db;
}

const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;

/* ── the model ─────────────────────────────────────────────────────────────────────────────── */

test('acceptance 1 — every drawable element is a database row', () => {
  const db = fixture();
  const model = buildModel(db);
  assert.equal(model.elements.length, count(db, "SELECT COUNT(*) AS n FROM element WHERE source_system = 'ACC'"));
  for (const element of model.elements) {
    const row = db.prepare("SELECT 1 AS ok FROM element WHERE source_system = 'ACC' AND source_id = ?")
      .get(element.elementId);
    assert.ok(row, `${element.elementId} is drawn but is not in the element table`);
    for (const key of ['x', 'y', 'z', 'sx', 'sy', 'sz']) {
      assert.ok(Number.isFinite(element[key]), `${element.elementId} has no ${key}`);
    }
  }
  // And every geometry row belongs to an element — nothing decorative.
  assert.equal(count(db, `SELECT COUNT(*) AS n FROM element_geometry g
    WHERE NOT EXISTS (SELECT 1 FROM element e WHERE e.source_id = g.element_id)`), 0);
});

test('geometry is deterministic and stored, not generated at render time', () => {
  const db = fixture();
  const element = { source_id: 'COL-021', category: 'Structural Columns', level: 'Level 2', zone: 'Zone A' };
  assert.deepEqual(geometryFor(element), geometryFor(element));
  const stored = db.prepare('SELECT * FROM element_geometry WHERE element_id = ?').get('COL-021');
  const computed = geometryFor(db.prepare(
    "SELECT source_id, category, level, zone FROM element WHERE source_id = 'COL-021'").get());
  assert.equal(stored.x, computed.x);
  assert.equal(stored.sz, computed.sz);
  assert.equal(stored.level_index, LEVELS.indexOf('Level 2'));
});

test('acceptance 4 — planned and actual are separate flags, never one blended state', () => {
  const db = fixture();
  const model = buildModel(db, { onDate: '2026-04-30' });
  for (const element of model.elements) {
    assert.equal(typeof element.plannedBuilt, 'boolean');
    assert.equal(typeof element.actualBuilt, 'boolean');
  }
  // Some are scheduled and not verified; that gap is the whole point of the comparison.
  assert.ok(model.elements.some(entry => entry.plannedBuilt && !entry.actualBuilt));
  assert.ok(model.counts.plannedBuilt !== model.counts.actualBuilt);
});

test('acceptance 5 — timeline playback is deterministic', () => {
  const db = fixture();
  const at = date => JSON.stringify(buildModel(db, { onDate: date }).counts);
  assert.equal(at('2026-04-30'), at('2026-04-30'));
  // And monotonic: later never un-schedules something.
  const early = buildModel(db, { onDate: '2026-02-01' }).counts.plannedBuilt;
  const late = buildModel(db, { onDate: '2026-12-01' }).counts.plannedBuilt;
  assert.ok(late >= early);
});

test('a date alone never makes an element built', () => {
  const db = fixture();
  // Far beyond every planned finish: everything is scheduled, but actual still follows evidence.
  const model = buildModel(db, { onDate: '2027-06-01' });
  assert.equal(model.counts.plannedBuilt, model.elements.filter(e => e.activityId).length);
  assert.ok(model.counts.actualBuilt < model.counts.plannedBuilt);
  assert.equal(model.counts.actualBuilt,
    count(db, "SELECT COUNT(DISTINCT element_id) AS n FROM progress_observation WHERE status = 'VERIFIED'"));
});

/* ── the worked example ────────────────────────────────────────────────────────────────────── */

test('acceptance 7 — A-1020 is 20 columns, 12 verified, 60% against P6’s 80%', () => {
  const db = fixture();
  const progress = activityProgress(db, 'A-1020');
  assert.equal(progress.name, 'Cast Level 2 columns');
  assert.equal(progress.rule, RULE.EQUAL_WEIGHT_ELEMENTS);
  assert.equal(progress.totalElements, 20);
  assert.equal(progress.verifiedElements, A1020_VERIFIED);
  assert.equal(progress.verifiedPct, 60);
  assert.equal(progress.p6ReportedPct, 80);
  assert.equal(progress.variancePct, -20);
  // All twenty are Level 2 structural columns — an activity builds what it names.
  const elements = db.prepare(
    `SELECT e.category, e.level FROM mapping m JOIN element e ON e.source_id = m.element_id
      WHERE m.activity_id = 'A-1020'`).all();
  assert.equal(elements.length, 20);
  assert.deepEqual([...new Set(elements.map(row => row.category))], ['Structural Columns']);
  assert.deepEqual([...new Set(elements.map(row => row.level))], ['Level 2']);
});

test('acceptance 3 — COL-001 resolves to the activity that builds it', () => {
  const db = fixture();
  const mapping = db.prepare('SELECT * FROM mapping WHERE element_id = ?').get('COL-001');
  assert.equal(mapping.activity_id, 'A-1020');
  assert.equal(mapping.p6_wbs_code, '1.2.3');
  assert.equal(mapping.boq_code, 'CON-045');
  const detail = activityDetail(db, mapping.activity_id);
  assert.ok(detail.elements.some(row => row.element_id === 'COL-001'));
});

test('acceptance 2 — an activity’s elements are exactly the ones it builds', () => {
  const db = fixture();
  const detail = activityDetail(db, 'A-1020');
  const ids = detail.elements.map(row => row.element_id).sort();
  const expected = db.prepare(
    "SELECT element_id FROM mapping WHERE activity_id = 'A-1020' ORDER BY element_id")
    .all().map(row => row.element_id);
  assert.deepEqual(ids, expected);
  assert.equal(ids.length, 20);
});

/* ── evidence ──────────────────────────────────────────────────────────────────────────────── */

test('acceptance 6 — only verified observations count', () => {
  const db = fixture();
  const before = activityProgress(db, 'A-1020').verifiedPct;
  assert.equal(before, 60);
  // Six more drafts must change nothing.
  const spare = db.prepare(
    `SELECT m.element_id FROM mapping m WHERE m.activity_id = 'A-1020'
       AND m.element_id NOT IN (SELECT element_id FROM progress_observation
                                 WHERE activity_id = 'A-1020' AND status = 'VERIFIED')
      LIMIT 6`).all();
  for (const row of spare) {
    db.prepare(`INSERT OR REPLACE INTO progress_observation (activity_id, element_id, observed_on,
        verified_quantity, completion, source, reviewer, evidence_ref, status, created_at)
      VALUES ('A-1020', ?, '2026-05-01', 1, 'COMPLETE', 'test', 'test', 'test', 'DRAFT', '2026-05-01')`)
      .run(row.element_id);
  }
  assert.equal(activityProgress(db, 'A-1020').verifiedPct, before);
  assert.ok(activityProgress(db, 'A-1020').draftObservations >= 6);
  // Verifying one of them does move it.
  db.prepare(`UPDATE progress_observation SET status = 'VERIFIED'
    WHERE activity_id = 'A-1020' AND element_id = ?`).run(spare[0].element_id);
  assert.equal(activityProgress(db, 'A-1020').verifiedPct, 65);
});

test('every observation carries the evidence the brief asks for', () => {
  const db = fixture();
  for (const row of verifiedObservations(db, 'A-1020')) {
    for (const field of ['activity_id', 'element_id', 'observed_on', 'completion', 'source',
      'reviewer', 'evidence_ref', 'status']) {
      assert.ok(row[field], `an observation is missing ${field}`);
    }
    assert.equal(row.status, 'VERIFIED');
  }
});

/* ── measurement rules ─────────────────────────────────────────────────────────────────────── */

test('equal-weight counting applies only where it is configured', () => {
  const db = fixture();
  const rules = db.prepare('SELECT rule, COUNT(*) AS n FROM measurement_rule GROUP BY rule').all();
  const byRule = Object.fromEntries(rules.map(row => [row.rule, row.n]));
  assert.ok(byRule[RULE.EQUAL_WEIGHT_ELEMENTS] > 0);
  assert.ok(byRule[RULE.NOT_MEASURABLE] > 0, 'an activity with no elements is not measurable');
  for (const row of db.prepare(
    `SELECT activity_id FROM measurement_rule WHERE rule = ?`).all(RULE.EQUAL_WEIGHT_ELEMENTS)) {
    const categories = db.prepare(
      `SELECT DISTINCT e.category FROM mapping m JOIN element e ON e.source_id = m.element_id
        WHERE m.activity_id = ?`).all(row.activity_id).map(entry => entry.category);
    assert.equal(categories.length, 1,
      `${row.activity_id} counts mixed categories equally, which is not comparable`);
  }
  // Every rule states why it is the rule.
  for (const row of db.prepare('SELECT * FROM measurement_rule').all()) {
    assert.ok(row.note.length > 25, `${row.activity_id} does not explain its rule`);
  }
});

test('an activity with nothing to measure reports that, not zero', () => {
  const db = fixture();
  const row = db.prepare('SELECT activity_id FROM measurement_rule WHERE rule = ? LIMIT 1')
    .get(RULE.NOT_MEASURABLE);
  const progress = activityProgress(db, row.activity_id);
  assert.equal(progress.verifiedPct, null);
  assert.equal(progress.variancePct, null);
  assert.match(progress.unavailable, /Not available/);
});

/* ── money ─────────────────────────────────────────────────────────────────────────────────── */

test('acceptance 9 — earned value uses approved rates and verified quantities', () => {
  const db = fixture();
  const value = activityValue(db, 'A-1020');
  const priced = db.prepare(
    `SELECT e.quantity, b.unit_rate, m.element_id FROM mapping m
       JOIN element e ON e.source_id = m.element_id
       JOIN boq_item b ON b.source_id = m.boq_code WHERE m.activity_id = 'A-1020'`).all();
  const verified = new Set(verifiedObservations(db, 'A-1020').map(row => row.element_id));
  const expected = Math.round(priced
    .filter(row => verified.has(row.element_id))
    .reduce((sum, row) => sum + row.quantity * row.unit_rate, 0));
  assert.equal(value.earnedValueUSD, expected);
  assert.ok(value.earnedValueUSD < value.budgetValueUSD, 'partly built work is worth less than all of it');
});

test('acceptance 8 — no BOQ mapping means no money, with a reason', () => {
  const db = fixture();
  const bare = db.prepare(
    `SELECT a.source_id FROM activity a WHERE a.source_system = 'P6'
       AND NOT EXISTS (SELECT 1 FROM mapping m WHERE m.activity_id = a.source_id
                         AND m.boq_code IS NOT NULL) LIMIT 1`).get();
  const value = activityValue(db, bare.source_id);
  assert.equal(value.earnedValueUSD, null, 'an absent figure must be null, never 0');
  assert.equal(value.budgetValueUSD, null);
  assert.match(value.unavailable, /Not available — mapping incomplete/);
});

test('earned value and SAP actual cost are never confused', () => {
  const db = fixture();
  const value = activityValue(db, 'A-1020');
  assert.ok(value.earnedValueUSD > 0);
  assert.ok(value.wbsActualCostUSD > 0);
  assert.notEqual(value.earnedValueUSD, value.wbsActualCostUSD);
  // The SAP figure is the WBS's, and the response says which WBS.
  assert.equal(value.wbsCode, '1.2.3');
  assert.equal(value.wbsActualCostUSD,
    db.prepare("SELECT actual_cost AS c FROM cost WHERE source_id = '1.2.3'").get().c);
});

test('partial pricing is reported rather than extrapolated', () => {
  const db = fixture();
  const value = activityValue(db, 'A-1020');
  assert.ok(value.pricedElements < value.totalElements);
  assert.match(value.unavailable, /Partial — \d+ of \d+/);
});

/* ── schedule ──────────────────────────────────────────────────────────────────────────────── */

test('planned progress follows the planned dates and nothing else', () => {
  const activity = { planned_start: '2026-04-06', planned_finish: '2026-04-26' };
  assert.equal(plannedAt(activity, '2026-04-01'), 0);
  assert.equal(plannedAt(activity, '2026-04-16'), 50);
  assert.equal(plannedAt(activity, '2026-05-01'), 100);
});

test('the two variances answer different questions and are both reported', () => {
  const db = fixture();
  const progress = activityProgress(db, 'A-1020');
  assert.equal(progress.variancePct, -20, 'verified against what P6 claims');
  assert.equal(progress.scheduleLineVariancePct, -40, 'verified against the schedule line');
  assert.notEqual(progress.variancePct, progress.scheduleLineVariancePct);
  assert.ok(scheduleVariance(db, 'A-1020').days < 0);
});

/* ── mapping and exceptions are Phase 3's ──────────────────────────────────────────────────── */

test('acceptance 10 and 11 — Phase 3 results are reused, not recalculated', () => {
  const db = fixture();
  const detail = activityDetail(db, 'A-1020');
  for (const row of detail.validation) {
    assert.ok(db.prepare('SELECT 1 AS ok FROM validation_result WHERE result_key = ?')
      .get(`${row.rule_id}:${row.subject_id}`), 'a finding was invented rather than read');
  }
  // An R11 warning carries the evidence behind it.
  const sequence = db.prepare(
    "SELECT * FROM validation_result WHERE rule_id = 'R11_SEQUENCE_INCONSISTENT' LIMIT 1").get();
  if (sequence) {
    assert.ok(sequence.expected && sequence.actual);
    assert.match(sequence.explanation, /before any|Level/);
  }
  // Progress never resolves an exception.
  const open = count(db, "SELECT COUNT(*) AS n FROM exception WHERE status <> 'RESOLVED'");
  activityProgress(db, 'A-1020');
  activityValue(db, 'A-1020');
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM exception WHERE status <> 'RESOLVED'"), open);
});

test('approved mapping overrides survive the progress build', () => {
  const db = fixture();
  const unmapped = db.prepare('SELECT element_id FROM mapping WHERE activity_id IS NULL LIMIT 1').get();
  db.prepare(`INSERT INTO mapping_proposal (element_id, field, current_value, proposed_value,
      reason, requester, requester_role, status, created_at, applied_at)
    VALUES (?, 'activity_id', NULL, 'A-1020', 'test', 'x', 'bimCoordinator', 'APPLIED', '2026-01-01', '2026-01-01')`)
    .run(unmapped.element_id);
  buildMappings(db);
  seedProgress(db);
  assert.equal(db.prepare('SELECT activity_id FROM mapping WHERE element_id = ?')
    .get(unmapped.element_id).activity_id, 'A-1020');
  assert.equal(db.prepare('SELECT activity_basis FROM mapping WHERE element_id = ?')
    .get(unmapped.element_id).activity_basis, 'APPROVED');
});

/* ── the draft P6 update ───────────────────────────────────────────────────────────────────── */

test('acceptance 12 — a prepared update is a draft and is never posted', () => {
  const db = fixture();
  const before = JSON.stringify(db.prepare(
    "SELECT * FROM src_p6_activity WHERE activity_id = 'A-1020'").get());
  const result = prepareP6Draft(db, 'A-1020', { actor: 'tester' });
  assert.equal(result.ok, true);
  assert.equal(result.draft.status, 'DRAFT');
  assert.equal(result.draft.current_pct, 80);
  assert.equal(result.draft.proposed_pct, 60);
  assert.match(result.note, /must be raised as an INT-02|Approval Center/);
  // Its evidence names the observations and says the drafts were left out.
  assert.equal(result.draft.evidence.verifiedElements, A1020_VERIFIED);
  assert.ok(result.draft.evidence.observations.length > 0);
  assert.ok(result.draft.evidence.draftObservationsExcluded >= 1);
  // And P6 itself is untouched.
  assert.equal(JSON.stringify(db.prepare(
    "SELECT * FROM src_p6_activity WHERE activity_id = 'A-1020'").get()), before);
  assert.equal(db.prepare("SELECT pct_complete AS p FROM activity WHERE source_id = 'A-1020'").get().p, 80);
  assert.deepEqual(listDrafts(db, { activityId: 'A-1020' }).map(row => row.status), ['DRAFT']);
});

test('an activity with no verified progress cannot be drafted', () => {
  const db = fixture();
  const bare = db.prepare('SELECT activity_id FROM measurement_rule WHERE rule = ? LIMIT 1')
    .get(RULE.NOT_MEASURABLE);
  const result = prepareP6Draft(db, bare.activity_id);
  assert.equal(result.ok, false);
  assert.match(result.error, /no verified progress/);
  assert.equal(listDrafts(db, { activityId: bare.activity_id }).length, 0);
});

/* ── lists and facets ──────────────────────────────────────────────────────────────────────── */

test('the activity list reports both figures for every row', () => {
  const db = fixture();
  const rows = activityList(db);
  assert.equal(rows.length, 150);
  for (const row of rows) {
    assert.ok('plannedPct' in row && 'verifiedPct' in row && 'p6ReportedPct' in row);
    if (row.verifiedPct == null) assert.ok(row.unavailable, `${row.activityId} is silent about why`);
  }
  // A filter narrows to the activities that touch it.
  const level2 = activityList(db, { level: 'Level 2' });
  assert.ok(level2.length > 0 && level2.length < rows.length);
  assert.ok(level2.some(row => row.activityId === 'A-1020'));
});

test('the facets and the timeline bounds come from the data', () => {
  const db = fixture();
  const facets = modelFacets(db);
  assert.deepEqual(facets.level, [...LEVELS]);
  assert.equal(facets.category.length, 5);
  assert.ok(facets.timeline.from < facets.timeline.to);
  assert.equal(facets.dataDate, '2026-09-30');
});

test('acceptance 14 — reset clears Phase 4 state and the seed rebuilds identically', async () => {
  const db = fixture();
  const { clearConstructionDb } = await import('../server/construction/db.mjs');
  const before = activityProgress(db, 'A-1020');
  prepareP6Draft(db, 'A-1020');

  clearConstructionDb(db);
  for (const table of ['element_geometry', 'progress_observation', 'measurement_rule', 'p6_update_draft']) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table}`), 0, `${table} survived the reset`);
  }
  seedSourceSystems(db, buildSeed());
  runInboundSync(db, createMockAdapters(db));
  buildMappings(db);
  seedProgress(db);
  const after = activityProgress(db, 'A-1020');
  assert.equal(after.verifiedPct, before.verifiedPct);
  assert.equal(after.totalElements, before.totalElements);
  assert.equal(listDrafts(db).length, 0);
});
