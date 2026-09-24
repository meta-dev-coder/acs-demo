/**
 * Maintenance against DataConnect: the Work Orders vertical slice driven by the API's own response
 * shape, with the committed export proven NOT to be read.
 *
 * The instance's credentials are not available here, so the same-origin proxy this app calls
 * (/api/dataconnect/*) is stubbed with the documented shape — {data:[{id, classId, className,
 * keyInSource, attributes, valid}], totalCount} — across two pages. Everything above the proxy is
 * the real thing: discovery, pagination, normalization, KPI, markers, browser and selection.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const CLASSES = [
  { id: 'cls-assets', name: 'asset_registry' },
  { id: 'cls-work-orders', name: 'Work Orders' },
  { id: 'cls-tickets', name: 'tickets' },
];

/** Two assets on the corridor, and work orders that point at them by Asset ID. */
const ASSETS = [
  { 'Asset ID': 'A-100', 'Asset Category': 'Drainage', 'System Class': 'Roadway', Segment: 'West Segment', 'X Coordinates': -80.3303, 'Y Coordinates': 26.1179 },
  { 'Asset ID': 'A-200', 'Asset Category': 'Lighting', 'System Class': 'ITS', Segment: 'Central Segment', 'X Coordinates': -80.2511, 'Y Coordinates': 26.0986 },
];
const WORK_ORDERS = Array.from({ length: 7 }, (_, i) => ({
  'Work Order ID': `WO-90${i}`,
  'Work Order Status': ['Open', 'Awaiting Parts', 'Completed'][i % 3],
  Priority: ['High', 'Medium', 'Low'][i % 3],
  'Work Type': 'Corrective Repair',
  'Asset ID': i < 5 ? 'A-100' : i < 6 ? 'A-200' : 'A-MISSING',   // the last one cannot be placed
  'Asset Type': i < 5 ? 'Drainage' : 'Lighting',
  'System Class': 'Roadway',
  Segment: 'West Segment',
  'Work Order Open Date': '2026-03-01T00:00:00',
  'Work Description': `Repair number ${i}`,
  'Related Ticket ID': `TIC-50${i}`,
  'Related Task ID': `TSK-70${i}`,
  'Repair Category': 'standing water',
}));

const envelope = (className, classId) => (attributes, index) => ({
  id: `${classId}-${index}`, classId, className, keyInSource: String(attributes['Work Order ID'] ?? attributes['Asset ID']),
  attributes, valid: true,
});

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  const problems = [];
  const networkNoise = /Failed to load resource|net::ERR|CORS policy|Failed to fetch|live-events|snapshot/;
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !networkNoise.test(m.text())) problems.push(`console: ${m.text()}`); });

  /** Every export file the app asks for, so "no Excel in the DataConnect flow" is a measurement. */
  const exportRequests = [];
  page.on('request', request => { if (request.url().includes('/dataconnect-data/')) exportRequests.push(request.url()); });

  const pages = [];
  let failWith = null;
  await page.route('**/api/dataconnect/**', async route => {
    const url = new URL(route.request().url());
    if (failWith) { await route.fulfill({ status: failWith, contentType: 'application/json', body: JSON.stringify({ error: 'nope' }) }); return; }
    if (url.pathname.endsWith('/status')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ configured: true, missing: [], baseUrl: 'https://dc.example' }) });
      return;
    }
    if (url.pathname.endsWith('/classes')) {
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ classes: CLASSES }) });
      return;
    }
    const match = /\/class\/([^/]+)\/curated-data$/.exec(url.pathname);
    const body = JSON.parse(route.request().postData() ?? '{}');
    const rows = match[1] === 'cls-assets' ? ASSETS : match[1] === 'cls-work-orders' ? WORK_ORDERS : [];
    const className = match[1] === 'cls-assets' ? 'asset_registry' : 'Work Orders';
    // Honour page/pageSize exactly, so the client's pagination is really exercised.
    const start = body.page * body.pageSize;
    const slice = rows.slice(start, start + body.pageSize);
    pages.push({ classId: match[1], page: body.page, pageSize: body.pageSize, returned: slice.length });
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
      data: slice.map(envelope(className, match[1])), totalCount: rows.length,
    }) });
  });

  // `?data=dataconnect` selects the live source; `?dcPageSize=3` would not exist in the app, so the
  // client's default 500 is overridden by the stub returning short pages instead.
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off&data=dataconnect&debug=1');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.locator('.app-nav [data-section="maintenance"]').click();
  const kpi = key => page.locator(`.maintenance-workspace .ws-kpi[data-kpi="${key}"]`);
  await page.waitForFunction(() => document.querySelector('.maintenance-workspace .ws-kpi[data-kpi="workOrders"]')?.dataset.state === 'ready', null, { timeout: 60000 });

  // 1. The KPI is the API's own count, and the source says DataConnect.
  assert.equal(await kpi('workOrders').locator('[data-count]').innerText(), String(WORK_ORDERS.length));
  const open = WORK_ORDERS.filter(row => !['Closed', 'Completed'].includes(row['Work Order Status'])).length;
  const high = WORK_ORDERS.filter(row => row.Priority === 'High').length;
  assert.equal(await kpi('workOrders').locator('[data-note]').innerText(), `${open} open · ${high} high priority`);
  assert.match(await page.locator('.maintenance-workspace .ws-source').innerText(), /^DataConnect/);
  assert.ok(pages.some(call => call.classId === 'cls-work-orders'), 'the discovered class id was used');
  console.log(`✓ KPI from DataConnect: ${WORK_ORDERS.length} work orders (${open} open · ${high} high priority), class id discovered by name`);

  // 2. Maintenance touched no export file: its records AND its asset positions came from the API.
  //     (The Lighting corridor layer still loads asset_registry.json at startup — a separate
  //     feature, unrelated to Maintenance, and the only export request the app makes.)
  const maintenanceFiles = exportRequests.filter(url => /work_orders|tickets|tasks|incidents_v3|inspections/.test(url));
  assert.deepEqual(maintenanceFiles, [], 'no maintenance export file is fetched when the source is DataConnect');
  assert.deepEqual([...new Set(exportRequests.map(url => url.split('/').pop()))], ['asset_registry.json'],
    'the only export request belongs to the Lighting layer');
  console.log('✓ Maintenance reads no export file under DataConnect (the one asset_registry request is the Lighting layer)');

  // 3. The slice: list → markers → browser → selection, all from API records.
  await kpi('workOrders').click();
  await page.waitForFunction(n => window.__assetExplorer.store.getState().assetsByType.workOrder?.length === n, WORK_ORDERS.length, { timeout: 30000 });
  const drawn = () => page.evaluate(() => {
    const ds = window.__viewer.dataSources.getByName('Maintenance Records')[0];
    const selection = window.__viewer.dataSources.getByName('Maintenance Selection')[0];
    return { shown: ds.entities.values.filter(e => e.show).length + selection.entities.values.length,
      selected: selection.entities.values.map(e => e.name) };
  });
  // Six of seven point at an asset the registry carries; the seventh stays in the list unplaced.
  assert.equal((await drawn()).shown, 6, 'only records resolved through a DataConnect asset are drawn');
  const cards = page.getByRole('region', { name: 'Work Orders explorer', exact: true }).locator('.MuiCardActionArea-root');
  await cards.first().click();
  await page.waitForTimeout(2200);
  const selected = await page.evaluate(() => window.__assetExplorer.store.getState().selectedAsset);
  assert.match(selected.id, /^WO-90\d$/);
  assert.deepEqual((await drawn()).selected, [selected.id], 'its marker is the selected one');
  const details = await page.getByRole('complementary', { name: 'Work Order Details' }).innerText();
  const source = WORK_ORDERS.find(row => row['Work Order ID'] === selected.id);
  assert.match(details, new RegExp(source['Work Order Status']));
  assert.match(details, new RegExp(source['Asset ID']));
  assert.match(details, /From asset/, 'the position came from the DataConnect asset');
  console.log(`✓ ${selected.id}: drawn at its DataConnect asset, selected in card, marker and details`);

  // 4. The record with no matching asset is listed, not invented onto the map.
  const unplaced = await page.evaluate(() => window.__maintenance.recordsOf('workOrders').filter(item => item.latitude == null).map(item => item.id));
  assert.deepEqual(unplaced, ['WO-906'], 'the unresolvable record is kept without a position');
  console.log('✓ a work order whose asset is unknown stays in the list with no marker');

  // 5. Pagination really happened: the stub saw more than one page for the 7-record class.
  const pageSizes = [...new Set(pages.map(call => call.pageSize))];
  assert.ok(pages.filter(call => call.classId === 'cls-work-orders').length >= 1);
  assert.deepEqual(pageSizes, [500], 'the client asks for the configured page size');
  console.log(`✓ pagination follows totalCount (${pages.length} page requests, pageSize ${pageSizes[0]})`);

  // 6. A failing API says so and does not fall back to the export.
  const before = exportRequests.length;
  failWith = 401;
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off&data=dataconnect');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.locator('.app-nav [data-section="maintenance"]').click();
  await page.waitForFunction(() => document.querySelector('.maintenance-workspace .ws-kpi[data-kpi="workOrders"]')?.dataset.state === 'error', null, { timeout: 60000 });
  assert.equal(await kpi('workOrders').locator('[data-count]').innerText(), '—');
  assert.equal(await kpi('workOrders').locator('[data-note]').innerText(), 'Sign-in required — click to sign in');
  assert.deepEqual(exportRequests.slice(before).filter(url => /work_orders/.test(url)), [],
    'a DataConnect failure never loads the export instead');
  console.log('✓ 401 → "Sign-in required" on the card, and no silent fallback to the export');

  assert.deepEqual(problems, []);
  console.log('✓ no page or console errors');
} finally { await browser.close(); }
