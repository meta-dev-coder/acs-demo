/**
 * Live Ops selection: choosing one record must never hide the others.
 *
 * This is the regression that prompted the rework. Selecting a closure made the other closures —
 * and the incidents and construction beside them — disappear, because the Asset Explorer enforces
 * one visible asset layer at a time everywhere else in the application. Live Ops opts out of that
 * rule, and this suite is what holds the opt-out in place.
 *
 * The feed is stubbed so the counts are deterministic; the enrichment is the shape the server
 * really produces, and its correctness is covered against the real geometry elsewhere.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const geo = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url)));
const eb = index => geo.features.find(f => f.properties.direction === 'EB' && f.properties.fdot_segment_index === index);
const at = feature => feature.geometry.coordinates[Math.floor(feature.geometry.coordinates.length / 2)];

const ops = (feature, extra = {}) => ({
  corridor: 'I-595', carriageway: 'EB_GENERAL', carriagewayLabel: 'Eastbound General Purpose', direction: 'EB',
  sectionId: `SECTION_0${feature.properties.fdot_segment_index}`, sectionIndex: feature.properties.fdot_segment_index,
  sectionLabel: `Eastbound Section 0${feature.properties.fdot_segment_index}`,
  segmentId: feature.properties.segment_id, contributesToImpact: true,
  laneImpact: { blockedLanes: 1, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'parsed' },
  laneImpactLabel: '1 lane blocked',
  spatialMatch: { method: 'stub', distanceMeters: 10, confidence: 'HIGH' }, ...extra,
});

/** Five closures spread along the corridor, plus one incident and one construction zone. */
const EVENTS = [
  ...[1, 2, 3, 4, 5].map(index => {
    const feature = eb(index);
    const [longitude, latitude] = at(feature);
    return { id: `CLS-10${index}`, rawSourceId: `CLS-10${index}`, type: 'CLOSURE', source: 'FL511',
      title: 'Lane closure', description: `Closure ${index}`, longitude, latitude,
      detailsAvailable: true, detailFields: [], liveOps: ops(feature) };
  }),
  (() => { const f = eb(6); const [lon, lat] = at(f); return { id: 'INC-900', rawSourceId: 'INC-900', type: 'INCIDENT',
    source: 'FL511', title: 'Crash', description: 'Crash', longitude: lon, latitude: lat, severity: 'Major',
    detailsAvailable: true, detailFields: [], liveOps: ops(f) }; })(),
  (() => { const f = eb(7); const [lon, lat] = at(f); return { id: 'CON-900', rawSourceId: 'CON-900', type: 'CONSTRUCTION',
    source: 'FL511', title: 'Road work', description: 'Work zone', longitude: lon, latitude: lat,
    detailsAvailable: true, detailFields: [], liveOps: ops(f) }; })(),
];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  const problems = [];
  const noise = /Failed to load resource|net::ERR|CORS policy|Failed to fetch|snapshot/;
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !noise.test(m.text())) problems.push(`console: ${m.text()}`); });

  await page.route('**/api/i595/live-events*', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ source: 'FL511', sourceStatus: 'LIVE', lastUpdated: new Date().toISOString(),
      counts: { total: EVENTS.length, incidents: 1, closures: 5, construction: 1, congestion: 0, disabledVehicles: 0 },
      events: EVENTS }),
  }));

  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off&data=mock');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.locator('.app-nav [data-section="liveOps"]').click();
  await page.waitForFunction(() => window.__liveOps?.impact?.size === 16, null, { timeout: 60000 });

  /** Every live-event marker currently drawn on the map, by id. */
  const drawn = () => page.evaluate(() => {
    const ds = window.__viewer.dataSources.getByName('FL511 Live Road Events')[0];
    return ds.entities.values.filter(e => e.show).map(e => e.id).sort();
  });

  // 1. Every enabled layer draws at once — the whole operational picture, not one category.
  await page.waitForFunction(() => {
    const ds = window.__viewer.dataSources.getByName('FL511 Live Road Events')[0];
    return ds && ds.entities.values.filter(e => e.show).length === 7;
  }, null, { timeout: 60000 });
  const all = await drawn();
  assert.deepEqual(all, ['CLS-101', 'CLS-102', 'CLS-103', 'CLS-104', 'CLS-105', 'CON-900', 'INC-900']);
  assert.equal(await page.locator('[role="region"][aria-label$="explorer"]').count(), 0,
    'and no category is chosen for the operator on arrival');
  console.log('✓ five closures, one incident and one construction zone all visible together');

  // 2. Browsing closures changes what is in the tray, not what is on the map.
  await page.locator('.liveops-workspace .ws-kpi[data-kpi="closures"]').click();
  await page.getByRole('region', { name: 'Closures explorer', exact: true }).waitFor({ timeout: 30000 });
  assert.deepEqual(await drawn(), all, 'choosing a KPI hid nothing');
  assert.equal(await page.evaluate(() => window.__assetExplorer.store.getState().activeExplorerType), 'closure');
  console.log('✓ choosing Closures browses them without hiding incidents or construction');

  // 3. Selecting one closure leaves the other four — and the other layers — on the map.
  const cards = page.getByRole('region', { name: 'Closures explorer', exact: true }).locator('.MuiCardActionArea-root');
  await cards.first().click();
  await page.waitForTimeout(2500);
  const firstSelected = await page.evaluate(() => window.__assetExplorer.store.getState().selectedAsset?.id);
  assert.ok(firstSelected?.startsWith('CLS-'), `a closure is selected (${firstSelected})`);
  assert.deepEqual(await drawn(), all, 'selecting one closure hid none of the others');
  console.log(`✓ selected ${firstSelected}: all seven records still drawn`);

  // 4. Selecting a second closure: the first returns to normal, it does not vanish.
  await page.evaluate(() => window.__assetExplorer.store.step?.(1));
  await page.waitForTimeout(2500);
  const secondSelected = await page.evaluate(() => window.__assetExplorer.store.getState().selectedAsset?.id);
  assert.notEqual(secondSelected, firstSelected, 'the selection moved on');
  const afterSecond = await drawn();
  assert.deepEqual(afterSecond, all, 'and the previously selected record is still on the map');
  assert.ok(afterSecond.includes(firstSelected), `${firstSelected} is visible but no longer selected`);
  console.log(`✓ stepped to ${secondSelected}: ${firstSelected} remains visible, unselected`);

  // 5. Cross-layer: the incident and the construction zone were never touched by any of this.
  assert.ok(afterSecond.includes('INC-900'), 'the incident layer is still drawn');
  assert.ok(afterSecond.includes('CON-900'), 'the construction layer is still drawn');
  const layersOn = await page.evaluate(() => [...document.querySelectorAll('[data-liveops-layer]')]
    .filter(input => input.checked).map(input => input.dataset.liveopsLayer).sort());
  assert.ok(layersOn.includes('incidents') && layersOn.includes('construction') && layersOn.includes('closures'),
    `all three layers still enabled (${layersOn.join(', ')})`);
  console.log('✓ incidents and construction remained enabled and visible throughout');

  // 6. The heat still explains itself, per carriageway.
  const explained = await page.evaluate(id => {
    const why = window.__liveOps.explain(id);
    return { level: why.level, summary: why.summary, ids: why.reasons.map(r => r.id) };
  }, eb(1).properties.segment_id);
  assert.equal(explained.ids.length, 1, 'only the record on that section');
  assert.match(explained.summary, /closure/);
  console.log(`✓ EB Section 01 explains itself: ${explained.level} — ${explained.summary}`);

  assert.deepEqual(problems, []);
  console.log('✓ no page or console errors');
} finally { await browser.close(); }
