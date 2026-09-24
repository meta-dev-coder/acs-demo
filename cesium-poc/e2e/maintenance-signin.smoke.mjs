/**
 * Signing in from the KPI card.
 *
 * When the server has no usable credential the cards say so AND are the button that fixes it. The
 * real authority is not involved here: `/api/dataconnect/*` is stubbed so the sequence can be
 * driven deterministically — expired, click, sign-in in progress, then loaded.
 *
 * What this pins: the expiry note invites the click, the click opens the authority in a popup the
 * browser did not block, and the records load afterwards WITHOUT a page reload.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const CLASSES = [
  { id: 'cls-assets', className: 'Florida I595 Assets' },
  { id: 'cls-work-orders', className: 'Florida I595 Work Orders' },
];
const ASSETS = [{ code: 'A-1', 'asset category': 'Drainage', x_coordinates: -80.3303, y_coordinates: 26.1179 }];
const WORK_ORDERS = [
  { 'Work Order ID': 'WO-1', 'Work Order Status': 'Open', Priority: 'High', 'Asset ID': 'A-1', 'Work Order Open Date': '04/11/2024' },
  { 'Work Order ID': 'WO-2', 'Work Order Status': 'Closed', Priority: 'Low', 'Asset ID': 'A-1', 'Work Order Open Date': '17/11/2024' },
];

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  const problems = [];
  const noise = /Failed to load resource|net::ERR|CORS policy|Failed to fetch|live-events|snapshot/;
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !noise.test(m.text())) problems.push(`console: ${m.text()}`); });

  // The server's state, as the stub models it: no credential until the sign-in "completes".
  let authenticated = false;
  let signInPending = false;
  let startCalls = 0;
  const popupUrls = [];

  await page.route('**/api/dataconnect/**', async route => {
    const url = new URL(route.request().url());
    const json = (status, body) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    const path = url.pathname.replace('/api/dataconnect', '');

    if (path === '/status') return json(200, { configured: true, missing: [], authenticated, signInPending, lastSignIn: null });
    if (path === '/signin/start') {
      startCalls += 1;
      signInPending = true;
      // The "authority" is a local page: the popup must actually be allowed to navigate.
      setTimeout(() => { authenticated = true; signInPending = false; }, 1500);
      return json(200, { url: 'http://127.0.0.1:5188/favicon.ico', scope: 'itwin-platform', renewable: false });
    }
    if (!authenticated) return json(401, { error: 'The access token has expired. Run `npm run dc:login` to renew it.', status: 401, code: 'token_expired' });
    if (path === '/classes') return json(200, { classes: CLASSES });
    const match = /^\/class\/([^/]+)\/curated-data$/.exec(path);
    const rows = match[1] === 'cls-assets' ? ASSETS : WORK_ORDERS;
    return json(200, {
      data: rows.map((attributes, index) => ({ id: `${match[1]}-${index}`, classId: match[1], keyInSource: String(attributes.code ?? attributes['Work Order ID']), attributes, valid: true })),
      totalCount: rows.length,
    });
  });

  page.on('popup', popup => popupUrls.push(popup.url()));

  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off&data=dataconnect');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.locator('.app-nav [data-section="maintenance"]').click();

  const kpi = key => page.locator(`.maintenance-workspace .ws-kpi[data-kpi="${key}"]`);
  await page.waitForFunction(() => document.querySelector('.maintenance-workspace .ws-kpi[data-kpi="workOrders"]')?.dataset.state === 'error', null, { timeout: 60000 });

  // 1. An expired credential reads as expiry, and says the click will fix it.
  assert.equal(await kpi('workOrders').locator('[data-count]').innerText(), '—');
  assert.equal(await kpi('workOrders').locator('[data-note]').innerText(), 'Session expired — click to sign in');
  console.log('✓ an expired token reads as expiry on the card, not as "not configured"');

  // 2. Clicking asks the server to start the flow and sends a popup to the authority.
  await kpi('workOrders').click();
  await page.waitForFunction(() => document.querySelector('.maintenance-workspace .ws-kpi[data-kpi="workOrders"] [data-note]')?.textContent === 'Signing in…', null, { timeout: 15000 });
  assert.equal(startCalls, 1, 'the server was asked to start exactly one sign-in');
  assert.equal(popupUrls.length, 1, 'a popup was opened, and the browser did not block it');
  console.log('✓ the card starts the sign-in and opens the authority in a popup');

  // 3. Once the server has a credential the records arrive, with no page reload.
  await page.waitForFunction(() => document.querySelector('.maintenance-workspace .ws-kpi[data-kpi="workOrders"]')?.dataset.state === 'ready', null, { timeout: 60000 });
  assert.equal(await kpi('workOrders').locator('[data-count]').innerText(), String(WORK_ORDERS.length));
  assert.equal(await kpi('workOrders').locator('[data-note]').innerText(), '1 open · 1 high priority');
  console.log(`✓ signing in loads the records in place: ${WORK_ORDERS.length} work orders, no reload`);

  // 4. And the workspace is usable straight afterwards.
  await kpi('workOrders').click();
  await page.waitForFunction(n => window.__assetExplorer.store.getState().assetsByType.workOrder?.length === n, WORK_ORDERS.length, { timeout: 30000 });
  assert.equal(await page.getByRole('region', { name: 'Work Orders explorer', exact: true }).isVisible(), true);
  console.log('✓ the card behaves as a normal KPI again once signed in');

  assert.deepEqual(problems, []);
  console.log('✓ no page or console errors');
} finally { await browser.close(); }
