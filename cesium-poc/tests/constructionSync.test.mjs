/**
 * Phase 2: the synthetic source systems, the adapters and the inbound sync.
 *
 * Four things are being held:
 *
 *  1. The data is DETERMINISTIC and internally consistent, and the proposal's worked example
 *     (COL-001 → A-1020 → WBS 1.2.3 → CON-045) actually holds together.
 *  2. Sync is IDEMPOTENT. A second run creates nothing and updates nothing.
 *  3. NOTHING IS RECORDED THAT DID NOT HAPPEN. A fresh database reports "never run"; there is no
 *     seeded run, no seeded audit event and no default timestamp.
 *  4. Write-back does not exist yet, and says so rather than quietly doing nothing.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  createMockAdapters, DIRECTION, INTERFACES, WRITE_BACK_STATUS, assertAdapter, interfaceById,
} from '../server/construction/adapters.mjs';
import { ALL_TABLES, clearConstructionDb, countRows, openConstructionDb } from '../server/construction/db.mjs';
import { buildSeed, PROJECT, SEEDED_SCENARIOS, seedSourceSystems } from '../server/construction/seed.mjs';
import {
  INBOUND_INTERFACES, RUN_STATUS, overview, runInboundSync, runInterface,
} from '../server/construction/sync.mjs';

/** A fresh in-memory database with the mock source systems seeded and nothing synced. */
function fixture() {
  const db = openConstructionDb({ path: ':memory:' });
  seedSourceSystems(db);
  return { db, adapters: createMockAdapters(db) };
}

const count = (db, table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

/* ── the synthetic project ─────────────────────────────────────────────────────────────────── */

test('one synthetic project, at the counts the brief asks for', () => {
  const data = buildSeed();
  assert.equal(PROJECT.name, 'Tower A — Commercial Building Construction');
  assert.equal(PROJECT.synthetic, true);
  assert.equal(data.p6Activities.length, 150);
  // DISTINCT elements. A row exists per model version an element appears in, and the newer
  // published architectural version carries most of them a second time.
  assert.equal(new Set(data.accElements.map(row => row.element_id)).size, 500);
  assert.equal(data.sapBoq.length, 50);
  assert.equal(data.p6Wbs.length, 21);
  // SAP carries one WBS code P6 does not — that mismatch is scenario 3, on purpose.
  assert.equal(data.sapWbs.length, 22);
});

test('the data is deterministic: two builds are byte-identical', () => {
  assert.equal(JSON.stringify(buildSeed()), JSON.stringify(buildSeed()));
});

test('the proposal’s worked example holds together', () => {
  const data = buildSeed();
  const element = data.accElements.find(row => row.element_id === 'COL-001');
  const activity = data.p6Activities.find(row => row.activity_id === 'A-1020');
  const boq = data.sapBoq.find(row => row.code === 'CON-045');
  assert.equal(element.level, 'Level 2');
  assert.equal(element.activity_ref, 'A-1020');
  assert.equal(activity.name, 'Cast Level 2 columns');
  assert.equal(activity.wbs_code, '1.2.3');
  assert.equal(boq.sap_wbs_code, '1.2.3');
  // The WBS node they both point at is the one the example names.
  assert.equal(data.p6Wbs.find(row => row.code === '1.2.3').name, 'Columns');
  assert.equal(data.sapWbs.find(row => row.code === '1.2.3').name, 'Columns');
  // An activity that is 80% done has not finished.
  assert.equal(activity.pct_complete, 80);
  assert.equal(activity.actual_finish, null);
});

test('the deliberate inconsistencies are declared, so none reads as a defect', () => {
  const data = buildSeed();
  assert.equal(SEEDED_SCENARIOS.length, 8);
  for (const entry of SEEDED_SCENARIOS) assert.ok(entry.detail.length > 20);
  assert.equal(new Set(data.accElements.filter(row => !row.activity_ref).map(row => row.element_id)).size, 5);
  assert.ok(data.sapWbs.some(row => row.code === '1.6'));
  assert.equal(data.p6Wbs.some(row => row.code === '1.6'), false);
  assert.ok(data.accModelVersions.some(row => row.state === 'WORK_IN_PROGRESS'));
});

/* ── adapters ──────────────────────────────────────────────────────────────────────────────── */

test('the five pilot interfaces, numbered as the proposal numbers them', () => {
  assert.deepEqual(INTERFACES.map(entry => entry.id), ['INT-01', 'INT-02', 'INT-03', 'INT-04', 'INT-05']);
  assert.deepEqual(INBOUND_INTERFACES, ['INT-01', 'INT-03', 'INT-04']);
  assert.equal(interfaceById('INT-02').approver, 'Project Planner (P6)');
  assert.equal(interfaceById('INT-05').approver, 'Finance Controller');
});

test('every adapter satisfies the contract a real client would have to', () => {
  const { adapters } = fixture();
  for (const [id, adapter] of adapters) {
    assert.doesNotThrow(() => assertAdapter(adapter, id));
    assert.equal(adapter.origin, 'MOCK');
    assert.ok(adapter.describe().note.length > 10, `${id} must say what replaces it`);
  }
});

test('the outbound interfaces refuse to post rather than pretending', () => {
  const { adapters } = fixture();
  for (const id of ['INT-02', 'INT-05']) {
    const adapter = adapters.get(id);
    assert.equal(adapter.direction, DIRECTION.OUTBOUND);
    // The adapter still refuses: posting has exactly one path and it runs through the approval
    // gate in destinations.mjs, not through here.
    assert.equal(adapter.writeBack.simulated, true);
    assert.throws(() => adapter.post(), /approval gate/);
  }
  assert.equal(WRITE_BACK_STATUS.simulated, true);
});

test('an outbound interface cannot be run as a sync', () => {
  const { db, adapters } = fixture();
  assert.throws(() => runInterface(db, adapters.get('INT-02')), /outbound and approval-controlled/);
  // And nothing was recorded for the attempt.
  assert.equal(count(db, 'sync_run'), 0);
});

test('ACC never offers an unpublished model version', () => {
  const { db, adapters } = fixture();
  const batches = adapters.get('INT-03').fetch();
  const versions = batches.find(batch => batch.entity === 'model_version').records;
  assert.equal(versions.length, 4);
  assert.equal(versions.some(row => row.state !== 'PUBLISHED'), false);
  // And no element of the work-in-progress version comes through with them.
  const elements = batches.find(batch => batch.entity === 'element').records;
  assert.equal(elements.some(row => row.model_version_id === 'TOWERA-STR-v6'), false);
  assert.equal(count(db, 'src_acc_model_version'), 5, 'the WIP version still exists in the source');
});

/* ── nothing recorded that did not happen ──────────────────────────────────────────────────── */

test('a freshly seeded database has synced nothing and says so', () => {
  const { db, adapters } = fixture();
  assert.equal(count(db, 'sync_run'), 0);
  assert.equal(count(db, 'audit_event'), 0);
  assert.equal(count(db, 'activity'), 0);
  const report = overview(db, { adapters });
  for (const entry of report.interfaces) {
    if (entry.direction === DIRECTION.INBOUND) {
      assert.equal(entry.health, 'NEVER_RUN', `${entry.id} must not claim a run`);
      assert.equal(entry.lastRunAt, null);
      assert.equal(entry.lastSuccessAt, null);
      // Never run is not zero records: it is unknown, and reported as null.
      assert.equal(entry.recordsRead, null);
    } else {
      // Nothing has been proposed yet, which is its own state — not "no approval gate exists".
      assert.equal(entry.health, 'NOTHING_PROPOSED');
      assert.equal(entry.pendingApprovals, 0);
      assert.equal(entry.postedCount, 0);
      // Write-back exists and is simulated; the gate is what the health state is about.
      assert.equal(entry.writeBack.simulated, true);
    }
  }
  assert.equal(report.source.activities, 150, 'the source systems are loaded');
});

/* ── running the sync ──────────────────────────────────────────────────────────────────────── */

test('the three inbound interfaces bring everything across', () => {
  const { db, adapters } = fixture();
  const runs = runInboundSync(db, adapters);
  assert.deepEqual(runs.map(run => run.interfaceId), ['INT-01', 'INT-03', 'INT-04']);
  for (const run of runs) {
    assert.equal(run.status, RUN_STATUS.SUCCESS, `${run.interfaceId}: ${JSON.stringify(run.errors)}`);
    assert.equal(run.records_skipped, 0);
  }
  assert.equal(count(db, 'activity'), 150);
  assert.equal(count(db, 'element'), 500);
  assert.equal(count(db, 'boq_item'), 50);
  assert.equal(count(db, 'model_version'), 4, 'only the published versions');
  assert.equal(count(db, 'cost'), 16);
  // P6 and SAP each publish their own WBS, kept apart so the mismatch is visible.
  assert.equal(count(db, 'wbs'), 21 + 22);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wbs WHERE source_system = 'P6'").get().n, 21);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM wbs WHERE source_system = 'SAP'").get().n, 22);
});

test('a second run creates nothing and updates nothing — sync is idempotent', () => {
  const { db, adapters } = fixture();
  runInboundSync(db, adapters);
  const after = countRows(db, ['activity', 'element', 'boq_item', 'wbs', 'cost', 'model_version']);

  const second = runInboundSync(db, adapters);
  assert.deepEqual(countRows(db, Object.keys(after)), after, 'no duplicate rows');
  for (const run of second) {
    assert.equal(run.records_created, 0, `${run.interfaceId} created rows on a repeat run`);
    assert.equal(run.records_updated, 0, `${run.interfaceId} rewrote unchanged rows`);
    assert.equal(run.records_unchanged, run.records_read);
  }
  // A third, for good measure.
  runInboundSync(db, adapters);
  assert.deepEqual(countRows(db, Object.keys(after)), after);
});

test('a changed source record is updated, and only that one', () => {
  const { db, adapters } = fixture();
  runInboundSync(db, adapters);
  db.prepare('UPDATE src_p6_activity SET pct_complete = 95, rev = rev + 1 WHERE activity_id = ?')
    .run('A-1020');

  const [run] = runInboundSync(db, adapters, { only: 'INT-01' });
  assert.equal(run.records_created, 0);
  assert.equal(run.records_updated, 1);
  assert.equal(run.records_unchanged, run.records_read - 1);
  assert.equal(db.prepare("SELECT pct_complete FROM activity WHERE source_id = 'A-1020'").get().pct_complete, 95);
  assert.equal(count(db, 'activity'), 150);
});

test('a run is recorded with the counts it actually produced, and audited once', () => {
  const { db, adapters } = fixture();
  const runs = runInboundSync(db, adapters);
  const rows = db.prepare('SELECT * FROM sync_run ORDER BY id').all();
  assert.equal(rows.length, 3);
  for (const [index, row] of rows.entries()) {
    assert.equal(row.status, RUN_STATUS.SUCCESS);
    assert.ok(row.finished_at, 'a finished run must carry its finish time');
    assert.equal(row.records_read, runs[index].records_read);
    assert.equal(row.error_count, 0);
  }
  const events = db.prepare("SELECT * FROM audit_event WHERE event = 'SYNC_RUN'").all();
  assert.equal(events.length, 3);
  assert.equal(count(db, 'sync_error'), 0);
});

test('a failing adapter is recorded as FAILED and writes nothing', () => {
  const { db, adapters } = fixture();
  const broken = { ...adapters.get('INT-01'),
    fetch() { throw new Error('P6 did not answer'); } };
  const run = runInterface(db, broken);
  assert.equal(run.status, RUN_STATUS.FAILED);
  assert.equal(count(db, 'activity'), 0, 'a failed run leaves nothing behind');
  const errors = db.prepare('SELECT * FROM sync_error').all();
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /P6 did not answer/);
  assert.equal(db.prepare('SELECT status FROM sync_run').get().status, RUN_STATUS.FAILED);
});

test('the overview is derived, never written down', () => {
  const { db, adapters } = fixture();
  runInboundSync(db, adapters);
  const report = overview(db, { adapters });
  const int01 = report.interfaces.find(entry => entry.id === 'INT-01');
  assert.equal(int01.health, 'HEALTHY');
  assert.ok(int01.lastRunAt);
  assert.equal(int01.recordsRead, 171, '21 WBS + 150 activities');
  assert.equal(report.totals.activities, 150);
  assert.equal(report.totals.syncRuns, 3);
  assert.equal(report.synthetic, true);
  // Every count in the report is a real count of a real table.
  assert.equal(report.totals.elements, count(db, 'element'));
});

/* ── reset ─────────────────────────────────────────────────────────────────────────────────── */

test('reset clears this project’s synced state and reseeds its sources, and nothing else', () => {
  const { db, adapters } = fixture();
  runInboundSync(db, adapters);
  assert.ok(count(db, 'activity') > 0);

  clearConstructionDb(db);
  for (const table of ALL_TABLES) assert.equal(count(db, table), 0, `${table} should be empty`);
  seedSourceSystems(db);

  assert.equal(count(db, 'src_p6_activity'), 150);
  assert.equal(count(db, 'activity'), 0, 'the synced side stays empty until a run');
  assert.equal(count(db, 'sync_run'), 0, 'reset must not manufacture a run');
  const report = overview(db, { adapters });
  assert.equal(report.interfaces.find(entry => entry.id === 'INT-01').health, 'NEVER_RUN');

  // And it runs cleanly again afterwards, at the same counts.
  runInboundSync(db, adapters);
  assert.equal(count(db, 'activity'), 150);
});

test('the seeded scenarios travel with every overview, not only the first read', () => {
  const { db, adapters } = fixture();
  // Before a sync, after a sync, and after a second — the panel must not vanish because syncing
  // returned a different shape. The flaws are still in the data either way.
  const before = overview(db, { adapters });
  runInboundSync(db, adapters);
  const after = overview(db, { adapters });
  for (const report of [before, after]) {
    assert.equal(report.seededScenarios.length, 8);
    assert.equal(report.writeBack.simulated, true);
    assert.equal(report.project.name, PROJECT.name);
  }
});
