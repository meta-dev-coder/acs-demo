import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gantryIndex, importIntoStore, normalizeTollRows, parseCsv, TOLL_CLASS } from '../tools/import-toll-transactions.mjs';
import { buildStoreFromSnapshot, openTwinStore } from '../server/ask/twinStore.mjs';
import { buildStoreFromDataConnect } from '../server/ask/dataConnectPull.mjs';
import { createPrioritizer } from '../server/ask/prioritize.mjs';
import { createScope } from '../server/ask/sources.mjs';

const SNAPSHOT = new URL('../public/dataconnect-data', import.meta.url).pathname;
const gantries = gantryIndex(JSON.parse(readFileSync(new URL('../public/data/i595_express_gantries.geojson', import.meta.url), 'utf8')));

test('CSV parsing: quotes, commas and CRLF', () => {
  assert.deepEqual(parseCsv('Gantry ID,Date,Transactions\r\n"GNT-M05","09/01/2026","1,200"\r\n'), [{ gantry_id: 'GNT-M05', date: '09/01/2026', transactions: '1,200' }]);
});

test('hourly rows sum to days; aliases; NA when there is no image split; unknown gantries reported', () => {
  const raw = [
    { plaza_id: 'GNT-M05', timestamp: '2026-09-01T07:00:00', volume: '1,000', video_transactions: 50, avg_toll: 2 },
    { plaza_id: 'GNT-M05', timestamp: '2026-09-01T08:00:00', volume: 1000, video_transactions: 70, avg_toll: 2.2 },
    { plaza_id: 'GNT-TP', timestamp: '09/01/2026', volume: 500, revenue: '$600' },
    { plaza_id: 'X-9', date: '2026-09-01', transactions: 10 },
    { plaza_id: '', date: '2026-09-01', transactions: 5 },
  ];
  const { rows, report } = normalizeTollRows(raw, { gantries });
  const m05 = rows.find(r => r.gantry_id === 'GNT-M05');
  assert.deepEqual([m05.date, m05.transactions, m05.image_dependent_transactions, m05.avg_toll_usd, m05.revenue_usd, m05.image_dependent_revenue_usd],
    ['2026-09-01', 2000, 120, 2.1, 4200, 252]);
  assert.equal(m05.lon, -80.2362);
  const tp = rows.find(r => r.gantry_id === 'GNT-TP');
  assert.deepEqual([tp.revenue_usd, tp.avg_toll_usd, tp.image_dependent_revenue_usd], [600, 1.2, null]);
  assert.deepEqual(report.unknownGantries, ['X-9']);
  assert.equal(report.withoutImageSplit, 2);
  assert.equal(report.errors.length, 1);
});

test('import replaces the synthetic class as "imported", keeps every other class, survives a refresh, and answers stop saying synthetic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'toll-import-'));
  try {
    const storePath = join(dir, 't.sqlite');
    buildStoreFromSnapshot({ snapshotDir: SNAPSHOT, outPath: storePath });
    const before = openTwinStore(storePath);
    const classesBefore = before.classes().length;
    before.close();
    const { rows } = normalizeTollRows([
      { gantry_id: 'GNT-M04', date: '2026-09-01', transactions: 20000, image_dependent_transactions: 4000, avg_toll_usd: 2 },
      { gantry_id: 'GNT-M05', date: '2026-09-01', transactions: 5000, image_dependent_transactions: 100, avg_toll_usd: 1 },
    ], { gantries });
    await importIntoStore({ storePath, rows, label: 'fdot.csv', snapshotDir: SNAPSHOT });
    let store = openTwinStore(storePath);
    const toll = store.classes().find(c => c.className === TOLL_CLASS);
    assert.equal(toll.source, 'import:fdot.csv');
    assert.equal(toll.rowCount, 2);
    assert.equal(store.classes().length, classesBefore);
    const { output, source } = createPrioritizer({ store, now: () => Date.parse('2026-10-12') })({}, { scope: createScope(null) });
    // With these (real-looking) figures, CCTV 5075's gantry carries far more image revenue.
    assert.equal(output.sites[0].site, 'CCTV 5075');
    assert.doesNotMatch(source, /synthetic/);
    assert.doesNotMatch(output.gaps.join(' '), /SYNTHETIC/);
    store.close();
    // A live-only DataConnect refresh keeps the imported class.
    const live = { liveClasses: async () => [{ id: 'Events', className: 'SDNA Florida I595 Live Events' }], curatedData: async () => ({ data: [{ keyInSource: 'E-1', attributes: {} }], totalCount: 1 }) };
    await buildStoreFromDataConnect({ liveDc: live, outPath: storePath, keepFrom: storePath, snapshotDir: SNAPSHOT });
    store = openTwinStore(storePath);
    assert.equal(store.classes().find(c => c.className === TOLL_CLASS).source, 'import:fdot.csv');
    store.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
