/**
 * End-to-end: the decision-focused Cruise Parking Simulation, in a real browser, on the November
 * 2026 data — the client demonstration plus the honest-data cases.
 *
 *   Nov 19, Peak — Norwegian Jewel at Terminal B: Garage B denies 148 cars from 10:45 (a garage
 *                  shortage day). Expanding Garage B by 100 spaces partly reduces it (48 left);
 *                  by 148 it is fully resolved.
 *   Nov 21, Peak — Norwegian Luna at Terminal B → Garage B; Garage B's 148 unmet are Norwegian
 *                  Jewel's cars denied on Nov 19 (a backlog, not a new shortage).
 *   Nov 21, Typical — Garage B has no shortage: no expansion needed.
 *   Terminal AAA — no garage mapped; Garage AA — no published capacity.
 *
 * Not part of `npm test` (it needs a running dev server, a browser and the 3D tiles). Run:
 *   npm run dev
 *   BASE_URL=http://localhost:5200/ npm run test:e2e
 * Playwright is not a dependency of this app: set PW_MODULE to a playwright install
 * (e.g. ../cesium-poc/node_modules/playwright/index.mjs) and CHROME to a Chromium binary if the
 * bundled one is not installed. SHOTS=<dir> saves screenshots. The browser profile is fresh each run.
 */
import { strict as assert } from 'node:assert';

const { chromium } = await import(process.env.PW_MODULE ?? 'playwright');
const BASE = process.env.BASE_URL ?? 'http://localhost:5200/';
const browser = await chromium.launch({
  ...(process.env.CHROME ? { executablePath: process.env.CHROME } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.setDefaultTimeout(60000);
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error' && !/tile|cesium|google|ion|net::/i.test(m.text())) errors.push(m.text()); });
const dialog = page.getByRole('dialog');
const num = async loc => Number((await loc.innerText()).replace(/[^\d-]/g, ''));
const step = (n, text) => console.log(`ok ${n} - ${text}`);
const shot = async name => { if (process.env.SHOTS) await dialog.screenshot({ path: `${process.env.SHOTS}/${name}.png` }); };
const tab = name => dialog.getByRole('tab', { name });
const crumb = () => page.locator('.cd-crumb-path').innerText();
const metric = k => page.locator('.cx-metrics > div').nth(k);
const card = name => page.locator('.cx-card').filter({ hasText: name });
const reco = () => page.locator('.cx-reco');

try {
  await page.goto(BASE);
  await page.waitForTimeout(8000);
  await page.getByRole('button', { name: /Parking Scenario Planner/ }).first().click();
  assert.deepEqual(await page.locator('.scenario-launchers button').allInnerTexts(), ['Cruise demand', 'Plan & simulate']);
  await page.getByRole('button', { name: /Plan & simulate/ }).click();
  await page.locator('.scenario-launchers').getByRole('button', { name: 'Cruise demand', exact: true }).click();
  await dialog.waitFor();
  assert.equal(await dialog.locator('#cw-title').innerText(), 'Cruise Parking Simulation');
  assert.equal(await dialog.getByRole('tab').count(), 4);
  step(1, 'opened from the map; four tabs');

  // ---- the client demonstration: Nov 19, Peak, Norwegian Jewel ---------------------------------------
  await dialog.getByLabel('Simulation date').selectOption('2026-11-19');
  await dialog.getByRole('button', { name: 'Peak', exact: true }).click();
  await tab(/Cruise Activity/).click();
  assert.deepEqual(await page.locator('.cx-calls thead th').allInnerTexts(), ['Cruise', 'Terminal', 'Arrival', 'Departure', 'Passenger capacity', 'Modelled']);
  assert.equal(await page.locator('.cx-stats > div').count(), 4);
  await page.locator('.cx-calls tbody tr').filter({ hasText: 'Norwegian Jewel' }).click();
  assert.equal(await page.locator('.cx-calls tbody tr').filter({ hasText: 'Norwegian Jewel' }).getAttribute('aria-selected'), 'true');
  await page.locator('summary', { hasText: 'Data sources and missing data' }).click();
  assert.match(await page.locator('.cw-fold').first().innerText(), /Dock Report/);
  await shot('1-activity');
  step(2, 'Cruise Activity: six columns, four summary numbers, Norwegian Jewel selected, sources in a fold');

  await tab(/Demand & Turnover/).click();
  assert.match(await page.locator('.cx-flow-card h3').innerText(), /Norwegian Jewel · Terminal B/);
  const flow = k => num(page.locator('.cx-flowstats > div').nth(k).locator('b'));
  const [leaving, entering] = [await flow(0), await flow(1)];
  assert.ok(leaving > 0 && entering > 0);
  // At Peak, Garage B is full when Jewel's cars arrive: only some park, and only those count.
  assert.match(await page.locator('.cx-flowstats > div').nth(1).innerText(), /only (\d+) find a space — 148 denied parking/);
  const parkedIn = Number((await page.locator('.cx-flowstats > div').nth(1).innerText()).match(/only (\d+) find a space/)[1]);
  assert.equal(await flow(2), parkedIn - leaving, 'net change = cars parked − cars leaving, never denied cars');
  assert.match(await page.locator('.cx-flow').innerText(), /Returning passengers[\s\S]*garage spaces freed[\s\S]*Departing passengers[\s\S]*garage spaces occupied/);
  assert.equal(await page.locator('.cd-rows').isVisible(), false, 'the per-cruise table is a drill-down');
  await shot('2-turnover');
  await page.locator('summary', { hasText: 'Edit assumptions' }).click();
  const ed = page.locator('.cx-edit .cd-roweditor').first();
  await ed.getByLabel('departing ship occupancy').fill('80');
  await ed.getByRole('button', { name: 'Apply to this cruise' }).click();
  assert.ok(await flow(1) < entering, 'departing cars follow the edit');
  assert.equal(await flow(0), leaving, 'returning cars do not');
  await ed.getByRole('button', { name: 'Reset to defaults' }).click();
  assert.equal(await flow(1), entering);
  step(3, `Demand & Turnover: Jewel ${leaving} leaving, ${entering} entering; a departing edit leaves returning cars alone`);

  await page.getByRole('button', { name: /View impact on garage/ }).click();
  assert.match(await crumb(), /Norwegian Jewel[\s\S]*Terminal B[\s\S]*Garage B[\s\S]*Nov 19/);
  assert.equal(await page.locator('.cx-metrics > div').count(), 3, 'three headline numbers');
  assert.equal(await num(metric(0).locator('b')), 957);
  assert.equal(await num(metric(1).locator('b')), 809);
  assert.equal(await num(metric(2).locator('b')), 148);
  assert.match(await metric(2).innerText(), /148 cars denied today, first at 10:45/);
  await dialog.getByRole('button', { name: 'First shortage', exact: true }).click();
  assert.equal(await page.locator('.cw-clock b').innerText(), '10:45');
  assert.match(await page.locator('.cx-explain').innerText(), /At 10:45, Garage B has 809 spaces[\s\S]*arriving cars cannot be accommodated now/);
  await page.locator('.cd-chart svg').scrollIntoViewIfNeeded();
  const box = await page.locator('.cd-chart svg').boundingBox();
  await page.mouse.click(box.x + box.width * 0.75, box.y + box.height / 2);
  assert.notEqual(await page.locator('.cw-clock b').innerText(), '10:45', 'clicking the chart moves the time');
  await dialog.getByRole('button', { name: 'Peak demand', exact: true }).click();
  await shot('3-time');
  for (const t of [/Compare Designs/, /Cruise Activity/, /Demand & Turnover/, /Time Simulation/]) await tab(t).click();
  assert.match(await crumb(), /Norwegian Jewel[\s\S]*Garage B[\s\S]*Nov 19/, 'cruise, garage and date survive every tab');
  step(4, 'Time Simulation: Jewel → Terminal B → Garage B; 957 required, 809 capacity, 148 denied from 10:45');

  // Drill-downs stay one click away.
  await dialog.getByRole('button', { name: 'Garage details' }).click();
  assert.match(await page.locator('.cx-garage-details .cd-equation').innerText(), /Parked: [\d,]+ \+ [\d,]+ − [\d,]+ = [\d,]+/);
  assert.equal(await page.locator('.cx-garage-details .cd-status').count(), 1);
  await page.waitForTimeout(1500);
  await shot('3b-time-garage-details');
  await dialog.getByRole('button', { name: 'Hide garage details' }).click();
  await dialog.getByRole('button', { name: 'How was this calculated?' }).click();
  assert.equal(await page.locator('.cd-drawer').count(), 1);
  await page.getByRole('button', { name: 'Close details' }).click();
  step(5, 'Garage details (breakdown, equations, status, map) and calculation details open on demand');

  // ---- Compare Designs: partly reduced, then fully resolved -----------------------------------------
  await dialog.getByRole('button', { name: /Compare solutions/ }).click();
  assert.equal(await page.locator('.cx-card').count(), 4);
  for (const name of ['Existing parking', 'A. Expand', 'B. New Garage', 'C. Optimise']) {
    assert.match(await card(name).innerText(), /Peak demand\s*957/, `${name}: same demand baseline`);
  }
  assert.match(await card('Existing parking').innerText(), /Shortage[\s\S]*Maximum unmet demand\s*148/);
  await card('A. Expand').getByRole('button', { name: 'Edit capacity' }).click();
  const panel = page.locator('.cd-editpanel');
  await panel.getByLabel('spaces added to Garage B', { exact: true }).fill('100');
  assert.match(await card('A. Expand').innerText(), /Partly reduced[\s\S]*Added parking spaces\s*\+100[\s\S]*Total eligible capacity\s*909[\s\S]*Maximum unmet demand\s*48/);
  assert.match(await reco().locator('h3').innerText(), /No alternative fully solves the problem — A\. Expand Existing Garage reduces it most/);
  assert.match(await panel.locator('.de-ba').innerText(), /Maximum unmet demand\s*148\s*→\s*48[\s\S]*Shortage duration/);
  await shot('4a-compare-partial');
  await panel.getByLabel('spaces added to Garage B', { exact: true }).fill('148');
  assert.match(await card('A. Expand').innerText(), /Shortage resolved[\s\S]*Maximum unmet demand\s*0/);
  assert.match(await reco().locator('h3').innerText(), /Only feasible modelled option: A\. Expand Existing Garage/);
  const why = await reco().locator('.cx-why').innerText();
  assert.match(why, /Cars denied parking: 148 → 0/);
  assert.match(why, /Maximum unmet demand: 148 → 0/);
  assert.match(why, /Added spaces usable here: \+148/);
  assert.doesNotMatch(await reco().innerText(), /cheapest|best overall/i, 'no unsupported cost claim');
  await panel.getByRole('button', { name: 'Save design' }).click();
  await panel.getByRole('button', { name: 'Close the design editor' }).click();
  await shot('4b-compare-resolved');
  await page.locator('summary', { hasText: 'Detailed comparison' }).click();
  assert.equal(await page.locator('.cd-cmp tbody tr').count(), 4);
  await tab(/Time Simulation/).click();
  await dialog.getByLabel('Parking design', { exact: true }).selectOption({ index: 1 });
  assert.equal(await num(metric(2).locator('b')), 0, 'the Time Simulation follows the saved design');
  await dialog.getByLabel('Parking design', { exact: true }).selectOption({ index: 0 });
  step(6, 'Compare: +100 at Garage B partly reduces (148 → 48); +148 resolves it; recommendation and "why" follow');

  await dialog.getByRole('button', { name: 'View on map' }).first().click();
  await page.locator('.cd-mapbar').waitFor();
  assert.match(await page.locator('.scenario-list').innerText(), /\+148 spaces/, 'the planner shows the saved design');
  await page.getByRole('button', { name: 'Back to simulation' }).click();
  await dialog.waitFor();
  step(7, 'View on map shows the saved design in the planner; Back returns');

  // ---- Norwegian Luna, Nov 21: the right garage, and an honest backlog -------------------------------
  await dialog.getByLabel('Simulation date').selectOption('2026-11-21');
  await tab(/Demand & Turnover/).click();
  await page.getByLabel('Cruise', { exact: true }).selectOption({ label: 'Norwegian Luna · Terminal B' });
  await page.getByRole('button', { name: /View impact on garage/ }).click();
  assert.match(await crumb(), /Norwegian Luna[\s\S]*Terminal B[\s\S]*Garage B[\s\S]*Nov 21/);
  assert.match(await metric(2).innerText(), /none denied today — 148 still unmet from earlier days/);
  assert.match(await page.locator('.cx-explain').innerText(), /Norwegian Jewel, denied Nov 19/);
  assert.doesNotMatch(await page.locator('.cx-explain').innerText(), /cannot be accommodated now/);
  step(8, 'Norwegian Luna → Garage B; the 148 unmet are named as Jewel\'s Nov 19 denials, not a new shortage');

  // ---- no shortage, missing mapping, unknown capacity ------------------------------------------------
  await dialog.getByRole('button', { name: 'Typical', exact: true }).click();
  assert.equal(await num(metric(2).locator('b')), 0);
  await tab(/Compare Designs/).click();
  assert.match(await reco().locator('h3').innerText(), /No expansion needed under the current model/);
  step(9, 'Nov 21 Typical: no shortage, no expansion recommended');

  await dialog.getByLabel('Garage or terminal').selectOption('TERMINAL:AAA');
  assert.match(await reco().locator('h3').innerText(), /Garage assignment needed for Terminal AAA/);
  assert.match(await reco().innerText(), /Data needed[\s\S]*A garage for Terminal AAA/);
  await tab(/Time Simulation/).click();
  assert.match(await page.locator('.cx-metrics').innerText(), /Garage assignment missing/);
  assert.match(await crumb(), /Garage assignment missing/);
  await dialog.getByLabel('Garage or terminal').selectOption('GARAGE:parking-garage-aa');
  await tab(/Compare Designs/).click();
  assert.match(await reco().locator('h3').innerText(), /Capacity not published for Garage AA/);
  assert.match(await reco().innerText(), /A verified space count for Garage AA/);
  step(10, 'missing mapping (Terminal AAA) and unknown capacity (Garage AA): no recommendation, data needed named');

  await dialog.getByRole('button', { name: 'Data & Assumptions' }).click();
  const assumptions = page.locator('.cd-drawer details', { hasText: 'Passenger and parking assumptions' }).first();
  if (!(await assumptions.evaluate(el => el.open))) await assumptions.locator('summary').first().click();
  assert.ok(await page.locator('.cd-drawer .cw-modes').count() > 0, 'all assumptions are still available');
  await dialog.getByRole('button', { name: 'Reset all to defaults' }).click();
  await page.getByRole('button', { name: 'Close details' }).click();
  step(11, 'Data & Assumptions remains one click away');

  // ---- no clipping at desktop sizes, with every drill-down open ---------------------------------------
  await dialog.getByLabel('Simulation date').selectOption('2026-11-19');
  await dialog.getByRole('button', { name: 'Peak', exact: true }).click();
  await dialog.getByLabel('Garage or terminal').selectOption('GARAGE:parking-garage-b');
  for (const size of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size);
    for (const t of [/Cruise Activity/, /Demand & Turnover/, /Time Simulation/, /Compare Designs/]) {
      await tab(t).click();
      for (const s of await page.locator('.cd-body details:not([open]) > summary').all()) await s.click();
      if (await dialog.getByRole('button', { name: 'Garage details' }).count()) await dialog.getByRole('button', { name: 'Garage details' }).click();
      await page.waitForTimeout(300);
      const over = await page.evaluate(() => [...document.querySelectorAll('.cd-shell, .cd-body, .cd-card, .cx-card, .cx-metrics > div, .cx-stats > div, .cd-garage, .cd-crumb, .cx-reco, .cw-fold')]
        .filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto')
        .map(el => `${el.className} ${el.scrollWidth}>${el.clientWidth}`));
      assert.deepEqual(over, [], `${size.width}×${size.height} ${t}`);
    }
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
  step(12, 'no horizontal overflow at 1366, 1440 and 1920 on any tab, with drill-downs open');

  // ---- the planner and Cesium are intact ----------------------------------------------------------------
  await dialog.getByRole('button', { name: 'View on map' }).first().click();
  await page.locator('.cd-mapbar').waitFor();
  await page.locator('.scenario-panel').getByRole('button', { name: 'Close planner' }).click();
  await page.getByRole('button', { name: /Plan & simulate/ }).click();
  assert.equal(await page.locator('.cd-mapbar').count(), 0, 'opening the planner closes the simulation bar');
  await page.getByRole('radio').nth(1).check();
  await page.getByRole('tab', { name: 'Simulate' }).click();
  assert.equal(await page.locator('.cesium-widget canvas').count() > 0, true, 'the Cesium viewer is still there');
  step(13, 'the Parking Expansion Planner and the 3D view still work');

  assert.deepEqual(errors, []);
  console.log('# pass 13');
} finally {
  await browser.close();
}
