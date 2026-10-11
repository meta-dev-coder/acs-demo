import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStoreFromSnapshot, openTwinStore, SNAPSHOT_CLASSES, writeTwinStore } from '../server/ask/twinStore.mjs';
import { parseArgs } from '../tools/twin-store.mjs';

const SPEC = { className: 'Test Incidents', key: ['id'], at: ['date'], lon: ['x'], lat: ['y'], segment: ['seg'] };
const ROWS = [
  { id: 'I-1', date: '2024-01-02', x: -80.2, y: 26.1, seg: 'East', weather: 'Rain', note: '50% wet_road' },
  { id: 'I-2', date: '2024-03-01', x: '', y: null, seg: 'West', weather: 'Clear', note: 'dry' },
  { id: 'I-1', date: '2024-02-01', seg: 'East', weather: 'Rain', note: 'repeat id' },
  { date: '2024-04-01', weather: 'Rain' },
];

function withStore(fn, options) {
  const dir = mkdtempSync(join(tmpdir(), 'twin-store-'));
  const outPath = join(dir, 'twin.sqlite');
  try {
    const report = writeTwinStore({ outPath, classes: [{ spec: SPEC, rows: ROWS, source: 'test' }], asOf: '2026-10-01T00:00:00.000Z' });
    const store = openTwinStore(outPath, options);
    try { fn(store, report, dir); } finally { store.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('twin store: build', () => {
  test('keeps every row with an id, cites repeats as <id>#n, and skips rows with no id', () => withStore((store, report, dir) => {
    assert.deepEqual(report.classes, [{ className: 'Test Incidents', rowCount: 3, skipped: 1, duplicates: 1 }]);
    const keys = store.query('Test Incidents', { limit: 10 }).records.map(r => r.key).sort();
    assert.deepEqual(keys, ['I-1', 'I-1#2', 'I-2']);
    // The temp file is renamed into place: nothing half-built is left beside the store.
    assert.deepEqual(readdirSync(dir), ['twin.sqlite']);
  }));

  test('the repository snapshot builds every class it declares', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twin-store-'));
    try {
      const { classes } = buildStoreFromSnapshot({ snapshotDir: new URL('../public/dataconnect-data', import.meta.url).pathname, outPath: join(dir, 's.sqlite') });
      assert.deepEqual(classes.map(c => c.className), SNAPSHOT_CLASSES.map(c => c.className));
      for (const c of classes) assert.ok(c.rowCount > 0, `${c.className} loaded rows`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('twin store: read', () => {
  test('query filters by equals and contains (case-insensitive, wildcards literal), newest first', () => withStore(store => {
    const rain = store.query('test incidents', { filters: [{ field: 'weather', operator: 'equals', value: 'Rain' }] });
    assert.equal(rain.totalCount, 2);
    assert.deepEqual(rain.records.map(r => r.key), ['I-1#2', 'I-1']);
    assert.equal(rain.asOf, '2026-10-01T00:00:00.000Z');
    const literal = store.query('Test Incidents', { filters: [{ field: 'note', operator: 'contains', value: '50%' }] });
    assert.deepEqual(literal.records.map(r => r.key), ['I-1']);
    const underscore = store.query('Test Incidents', { filters: [{ field: 'note', operator: 'contains', value: 'T_ROAD' }] });
    assert.equal(underscore.totalCount, 1);
    assert.equal(store.query('Test Incidents', { filters: [{ field: 'note', operator: 'contains', value: 'w%t' }] }).totalCount, 0);
  }));

  test('fields narrows the record and empty values are dropped', () => withStore(store => {
    const { records } = store.query('Test Incidents', { filters: [{ field: 'key', operator: 'equals', value: 'I-2' }], fields: ['weather', 'x', 'nope'] });
    assert.deepEqual(records, [{ key: 'I-2', weather: 'Clear' }]);
  }));

  test('count groups by a field, largest first', () => withStore(store => {
    const result = store.count('Test Incidents', { groupBy: 'weather' });
    assert.equal(result.totalCount, 3);
    assert.deepEqual(result.groups, [{ value: 'Rain', count: 2 }, { value: 'Clear', count: 1 }]);
  }));

  test('an unknown field or operator is refused with the valid fields named', () => withStore(store => {
    assert.throws(() => store.query('Test Incidents', { filters: [{ field: 'bogus', operator: 'equals', value: 'x' }] }), /not a field.*weather/);
    assert.throws(() => store.query('Test Incidents', { filters: [{ field: 'weather', operator: 'like', value: 'x' }] }), /Operator/);
    assert.throws(() => store.count('Test Incidents', { groupBy: 'bogus' }), /not a field/);
  }));

  test('an unknown class, a missing store and a stale load are typed gaps, never empty answers', () => {
    withStore(store => {
      assert.equal(store.query('Nope').gap.type, 'not_ready');
      assert.match(store.query('Nope').gap.detail, /Test Incidents/);
    });
    withStore(store => {
      assert.equal(store.count('Test Incidents').gap.type, 'stale');
    }, { now: () => Date.parse('2026-10-03T00:00:00Z'), staleAfterMs: 86_400_000 });
    const missing = openTwinStore('/nonexistent/twin.sqlite');
    assert.equal(missing.query('Test Incidents').gap.type, 'not_ready');
    assert.match(missing.query('Test Incidents').gap.detail, /not been built/);
    assert.deepEqual(missing.classes(), []);
  });

  test('the store is opened read-only', () => withStore((store, report, dir) => {
    assert.ok(existsSync(join(dir, 'twin.sqlite')));
    assert.deepEqual(store.classes().map(c => [c.className, c.rowCount, c.source]), [['Test Incidents', 3, 'test']]);
  }));
});

test('twin-store CLI: a source is required and --out overrides the env default', () => {
  assert.throws(() => parseArgs([], {}), /--from-snapshot or --from-dataconnect/);
  assert.deepEqual(parseArgs(['--from-dataconnect', '--no-snapshot-fallback'], {}).snapshotFallback, false);
  assert.equal(parseArgs(['--from-dataconnect'], {}).source, 'dataconnect');
  assert.equal(parseArgs(['--from-snapshot'], { ASK_TWIN_STORE: '/x/y.sqlite' }).out, '/x/y.sqlite');
  assert.equal(parseArgs(['--from-snapshot', '--out', '/tmp/a.sqlite'], {}).out, '/tmp/a.sqlite');
  assert.throws(() => parseArgs(['--from-snapshot', '--bogus'], {}), /unknown argument/);
});
