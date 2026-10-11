import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStoreFromDataConnect, compactItem, pointOf, pullDataConnect } from '../server/ask/dataConnectPull.mjs';
import { configuredClients, createReloadingStore, createStoreRefresher, refreshFromEnv } from '../server/ask/storeRefresh.mjs';
import { openTwinStore, SNAPSHOT_CLASSES } from '../server/ask/twinStore.mjs';

const SNAPSHOT_DIR = new URL('../public/dataconnect-data', import.meta.url).pathname;
const item = (key, attributes = {}) => ({ keyInSource: key, attributes });

/** A fake read client: `pages[classId]` is the full item list, served `pageSize` at a time. */
function fakeClient(byClass, { fail = new Set(), calls = [] } = {}) {
  return {
    calls,
    async curatedData(id, { page, pageSize }) {
      calls.push({ id, page, pageSize });
      if (fail.has(id)) throw new Error(`503 ${id} unavailable`);
      const all = byClass[id] ?? [];
      return { data: all.slice(page * pageSize, (page + 1) * pageSize), totalCount: all.length };
    },
  };
}
const liveClient = (byClass, options) => Object.assign(fakeClient(byClass, options), {
  liveClasses: async () => Object.keys(byClass).map(id => ({ id, className: `SDNA Florida I595 Live ${id}` })),
});
const HIST = [{ id: 'inc', className: 'Florida I595 Incidents' }, { id: 'tix', className: 'Florida I595 Tickets' }];

function inDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'twin-refresh-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe('DataConnect pull: compaction', () => {
  test('drops empty, NA and object values, clips long text and keeps the key', () => {
    const { row, droppedFields } = compactItem(item('E-1', { status: 'Active', note: 'NA', blank: '', nested: { a: 1 }, text: 'x'.repeat(2500), n: 0 }));
    assert.equal(row.keyInSource, 'E-1');
    assert.equal(row.status, 'Active');
    assert.equal(row.n, 0);
    assert.equal(row.text.length, 2001);
    assert.equal('note' in row || 'blank' in row || 'nested' in row, false);
    assert.equal(droppedFields, 3);
    assert.equal(compactItem(item('NA', { a: 1 })), null);
  });

  test('a geometry becomes longitude/latitude only when the record has no plain coordinates', () => {
    assert.deepEqual(pointOf('POINT (-80.2 26.1)'), { lon: -80.2, lat: 26.1 });
    assert.deepEqual(pointOf({ type: 'LineString', coordinates: [[-80.3, 26.11], [-80.2, 26.1]] }), { lon: -80.3, lat: 26.11 });
    assert.equal(pointOf('not a geometry'), null);
    const fromGeometry = compactItem(item('E-2', { geometry: JSON.stringify({ type: 'Point', coordinates: [-80.25, 26.12] }) })).row;
    assert.deepEqual([fromGeometry.longitude, fromGeometry.latitude, 'geometry' in fromGeometry], [-80.25, 26.12, false]);
    const own = compactItem(item('E-3', { x_coordinates: -80.1, y_coordinates: 26.0, geometry: 'POINT (-81 27)' })).row;
    assert.equal(own.longitude, undefined);
  });
});

describe('DataConnect pull: paging and failures', () => {
  test('pages every class to the end, live and historical, and reports raw vs compact size', async () => {
    const live = liveClient({ Events: Array.from({ length: 5 }, (_, i) => item(`E-${i}`, { status: 'Active', empty: '' })) });
    const historical = fakeClient({ inc: [item('I-1', { Segment: 'East' })], tix: [] });
    const { classes, report } = await pullDataConnect({ liveDc: live, historical, historicalClasses: HIST, pageSize: 2 });
    assert.deepEqual(classes.map(c => [c.spec.className, c.rows.length, c.source]), [
      ['SDNA Florida I595 Live Events', 5, 'dataconnect:live'], ['Florida I595 Incidents', 1, 'dataconnect:historical'], ['Florida I595 Tickets', 0, 'dataconnect:historical']]);
    assert.equal(report[0].pages, 3);
    assert.ok(report[0].compactBytes < report[0].rawBytes);
  });

  test('a class that fails is reported and left out, never emptying the rest', async () => {
    const historical = fakeClient({ inc: [item('I-1')], tix: [item('T-1')] }, { fail: new Set(['tix']) });
    const { classes, report } = await pullDataConnect({ historical, historicalClasses: HIST });
    assert.deepEqual(classes.map(c => c.spec.className), ['Florida I595 Incidents']);
    assert.match(report.find(r => r.className === 'Florida I595 Tickets').error, /503/);
  });

  test('maxRows caps a class and marks it truncated', async () => {
    const historical = fakeClient({ inc: Array.from({ length: 7 }, (_, i) => item(`I-${i}`)) });
    const { classes, report } = await pullDataConnect({ historical, historicalClasses: [HIST[0]], pageSize: 3, maxRows: 4 });
    assert.equal(classes[0].rows.length, 4);
    assert.equal(report[0].truncated, true);
  });
});

describe('DataConnect store build', () => {
  test('fills classes DataConnect did not return from the snapshot, and writes nothing when it returned none', () => inDir(async dir => {
    const outPath = join(dir, 't.sqlite');
    const historical = fakeClient({ inc: [item('I-1', { 'segment name': 'East', x_coordinates: -80.2, y_coordinates: 26.1 })] });
    const result = await buildStoreFromDataConnect({ historical, outPath, snapshotDir: SNAPSHOT_DIR });
    assert.equal(result.written, true);
    const store = openTwinStore(outPath);
    try {
      const incidents = store.classes().find(c => c.className === 'Florida I595 Incidents');
      // HISTORICAL_CLASSES' real ids are not in the fake, so every other class falls back to the snapshot.
      assert.ok(store.classes().length >= SNAPSHOT_CLASSES.length);
      assert.ok(incidents.source === 'dataconnect:historical' || incidents.source.startsWith('snapshot:'));
    } finally { store.close(); }
    const down = { curatedData: async () => { throw new Error('503'); } };
    const none = await buildStoreFromDataConnect({ historical: down, outPath: join(dir, 'none.sqlite'), snapshotDir: SNAPSHOT_DIR });
    assert.equal(none.written, false);
    assert.equal(existsSync(join(dir, 'none.sqlite')), false);
  }));

  test('a live-only refresh keeps the historical classes from the previous store with their own load time', () => inDir(async dir => {
    const outPath = join(dir, 't.sqlite');
    const live = liveClient({ Events: [item('E-1', { status: 'Active' })] });
    await buildStoreFromDataConnect({ liveDc: live, outPath, snapshotDir: SNAPSHOT_DIR, asOf: '2026-10-01T00:00:00.000Z' });
    const live2 = liveClient({ Events: [item('E-1'), item('E-2')] });
    const second = await buildStoreFromDataConnect({ liveDc: live2, outPath, keepFrom: outPath, snapshotDir: SNAPSHOT_DIR, asOf: '2026-10-02T00:00:00.000Z' });
    assert.ok(second.report.some(r => r.kind === 'kept' && r.className === 'Florida I595 Incidents'));
    assert.ok(!second.report.some(r => r.kind === 'snapshot'), 'nothing re-read from the snapshot once kept');
    const store = openTwinStore(outPath);
    try {
      const byName = Object.fromEntries(store.classes().map(c => [c.className, c]));
      assert.equal(byName['SDNA Florida I595 Live Events'].rowCount, 2);
      assert.equal(byName['SDNA Florida I595 Live Events'].asOf, '2026-10-02T00:00:00.000Z');
      assert.equal(byName['Florida I595 Incidents'].asOf, '2026-10-01T00:00:00.000Z');
      assert.ok(store.query('Florida I595 Incidents', { limit: 1 }).records.length === 1);
      assert.ok(byName['Florida I595 Incidents'].fields.length > 3, 'field names were kept too');
    } finally { store.close(); }
  }));
});

describe('store refresh', () => {
  test('refreshFromEnv and configuredClients', () => {
    assert.equal(refreshFromEnv({ ASK_TWIN_REFRESH: 'off' }), false);
    assert.deepEqual(refreshFromEnv({ ASK_TWIN_LIVE_REFRESH_MIN: '2', ASK_TWIN_HISTORICAL_REFRESH_H: 'x' }), { liveEveryMs: 120_000, historicalEveryMs: 86_400_000 });
    assert.deepEqual(configuredClients({ liveDc: { config: {} }, historical: { missing: () => ['DC_BASE_URL'] } }), { liveDc: null, historical: null });
    const live = { config: { baseUrl: 'https://x' } }, hist = { missing: () => [] };
    assert.deepEqual(configuredClients({ liveDc: live, historical: hist }), { liveDc: live, historical: hist });
  });

  test('start pulls historical once, the live timer pulls live only, and the reopened store serves the new rows', () => inDir(async dir => {
    const storePath = join(dir, 't.sqlite');
    let events = [item('E-1')];
    const live = { liveClasses: async () => [{ id: 'Events', className: 'SDNA Florida I595 Live Events' }],
      curatedData: async (id, { page }) => ({ data: page ? [] : events, totalCount: events.length }) };
    const histCalls = [];
    const historical = fakeClient({}, { calls: histCalls });
    await buildStoreFromDataConnect({ liveDc: live, outPath: storePath, snapshotDir: SNAPSHOT_DIR });
    const store = createReloadingStore(storePath);
    const timers = [];
    const logs = [];
    const refresher = createStoreRefresher({ store, storePath, liveDc: live, historical, snapshotDir: SNAPSHOT_DIR,
      logger: { log: m => logs.push(m), warn: m => logs.push(m) }, setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: () => {} });
    try {
      await refresher.start();
      assert.ok(histCalls.length > 0, 'the first refresh read historical classes');
      assert.deepEqual(timers.map(t => t.ms), [300_000, 86_400_000]);
      const v = store.version;
      events = [item('E-1'), item('E-2'), item('E-3')];
      histCalls.length = 0;
      timers[0].fn();
      await refresher.refresh();
      assert.equal(histCalls.length, 0, 'the live timer does not page historical classes');
      assert.ok(store.version > v);
      assert.equal(store.count('SDNA Florida I595 Live Events').totalCount, 3);
    } finally { refresher.stop(); store.close(); }
  }));

  test('a failed refresh keeps the last good store serving', () => inDir(async dir => {
    const storePath = join(dir, 't.sqlite');
    const good = liveClient({ Events: [item('E-1')] });
    await buildStoreFromDataConnect({ liveDc: good, outPath: storePath });
    const store = createReloadingStore(storePath);
    const broken = { config: {}, liveClasses: async () => { throw new Error('503 unconfigured'); }, curatedData: async () => ({}) };
    const warnings = [];
    const refresher = createStoreRefresher({ store, storePath, liveDc: broken, logger: { log: m => warnings.push(m), warn: m => warnings.push(m) } });
    try {
      const result = await refresher.refresh();
      assert.equal(result.written, false);
      assert.equal(store.version, 0);
      assert.equal(store.count('SDNA Florida I595 Live Events').totalCount, 1);
      assert.match(refresher.status.lastError, /class list could not be read|no class/);
      assert.ok(warnings.some(m => /NOT refreshed/.test(m)));
      const thrown = createStoreRefresher({ store, storePath, liveDc: good, build: async () => { throw new Error('disk full'); }, logger: { log() {}, warn: m => warnings.push(m) } });
      assert.equal((await thrown.refresh()).written, false);
      assert.ok(warnings.some(m => /last good store keeps serving: disk full/.test(m)));
    } finally { store.close(); }
  }));
});

describe('live vs historical labelling', () => {
  test('describe_store, the system prompt and the insight source say where each class came from', () => inDir(async dir => {
    const { createTools } = await import('../server/ask/tools.mjs');
    const { systemPrompt } = await import('../server/ask/prompt.mjs');
    const { createInsights } = await import('../server/ask/insights.mjs');
    const outPath = join(dir, 't.sqlite');
    const live = liveClient({ Events: [item('E-1', { status: 'Active' })] });
    await buildStoreFromDataConnect({ liveDc: live, historical: null, outPath, snapshotDir: SNAPSHOT_DIR });
    const store = openTwinStore(outPath);
    try {
      const tools = createTools({ store });
      const described = await tools.run('describe_store', {});
      const origins = Object.fromEntries(described.output.classes.map(c => [c.className, c.origin]));
      assert.equal(origins['SDNA Florida I595 Live Events'], 'live');
      assert.equal(origins['Florida I595 Incidents'], 'snapshot');
      const prompt = systemPrompt({ classes: store.classes() });
      assert.match(prompt, /SDNA Florida I595 Live Events \[LIVE, SDNA/);
      assert.match(prompt, /Florida I595 Incidents \[historical, snapshot\]/);
      const insights = createInsights({ store, readLayer: () => null, centerline: [] });
      const hotspots = insights.handlers.crash_hotspots({});
      assert.match(hotspots.source ?? '', /crash register \(DataConnect snapshot\)/);
    } finally { store.close(); }
  }));
});
