/**
 * The Safety workspace: the live incident card over the map, opening the bottom browser for the
 * layer that already draws it. Closures and construction are restrictions on traffic and belong to
 * the Traffic workspace — `e2e/traffic.smoke.mjs` covers those.
 *
 * The FL511 feed is live, so the corridor may genuinely hold no incidents right now.
 * Expectations are taken from what the app received, never written here, and the empty case is
 * checked as its own behaviour rather than skipped.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  const problems = [];
  const networkNoise = /Failed to load resource|net::ERR|CORS policy|Failed to fetch|live-events|snapshot/;
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !networkNoise.test(m.text())) problems.push(`console: ${m.text()}`); });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off&data=mock');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.waitForTimeout(4000);   // the feed's first fetch

  // Each workspace has its own strip, so everything here is scoped to Safety's.
  const kpi = key => page.locator(`.safety-workspace .ws-kpi[data-kpi="${key}"]`);
  // 1. Safety shows its cards, counted from the live feed, and nothing is chosen on arrival.
  await page.locator('.app-nav [data-section="safety"]').click();
  await page.locator('.safety-workspace .ws-kpis').waitFor();
  // Closures and construction are restrictions on traffic, and live on the Traffic workspace.
  assert.deepEqual(await page.locator('.safety-workspace .ws-kpi-label').allInnerTexts(),
    ['Active incidents', 'Disabled vehicles', 'Recorded crashes']);
  assert.equal(await page.locator('.safety-workspace .ws-kpi[aria-pressed="true"]').count(), 0, 'nothing chosen on arrival');
  assert.equal(await page.locator('[role="region"][aria-label$="explorer"]').count(), 0, 'and no browser until asked for');

  // What the cards show must be the corridor's live events, counted by type — not a number of
  // their own.
  const expected = await page.evaluate(() => {
    const read = key => Number(document.querySelector(`.safety-workspace .ws-kpi[data-kpi="${key}"] [data-count]`).textContent.replace(/,/g, ''));
    return { incidents: read('incidents'), installed: Boolean(window.__safety) };
  });
  assert.ok(expected.installed, 'the workspace is installed');
  assert.match(await page.locator('.safety-workspace .ws-source').innerText(), /FL511/);
  console.log(`✓ Safety: Active incidents ${expected.incidents}, source ${await page.locator('.safety-workspace .ws-source').innerText()}`);

  // 2. Choosing a card switches its layer on and opens the bottom browser for it — or says the
  //    corridor has none, which is an answer rather than an error.
  for (const [key, layerControl, label] of [['incidents', '#live-events-incident', 'Incidents']]) {
    const count = Number((await kpi(key).locator('[data-count]').innerText()).replace(/,/g, ''));
    await kpi(key).click();
    await page.waitForTimeout(2500);
    assert.equal(await kpi(key).getAttribute('aria-pressed'), 'true', `${label} card reads as chosen`);
    assert.equal(await page.locator(layerControl).isChecked(), true, `${label} layer switched on`);
    if (count > 0) {
      await page.getByRole('region', { name: `${label} explorer`, exact: true }).waitFor({ timeout: 30000 });
      const inExplorer = await page.evaluate(() => window.__assetExplorer.store.getState().assetsByType.incident?.length ?? 0);
      assert.equal(inExplorer, count, `${label}: the browser holds the same ${count} the card counts`);
      // Card → selection → map, the same interaction the other workspaces use.
      await page.getByRole('region', { name: `${label} explorer`, exact: true }).locator('.MuiCardActionArea-root').first().click();
      await page.waitForTimeout(1500);
      const selected = await page.evaluate(() => window.__assetExplorer.store.getState().selectedAsset?.id ?? null);
      assert.ok(selected, `${label}: a card selects`);
      console.log(`✓ ${label}: card → layer on → browser with ${count}, selecting one works (${selected})`);
    } else {
      assert.match(await kpi(key).locator('[data-note]').innerText(), /None on the corridor now/);
      console.log(`✓ ${label}: the feed reports none on the corridor, and the card says so`);
    }
    // Choosing it again puts the layer away.
    await kpi(key).click();
    await page.waitForTimeout(1500);
    assert.equal(await kpi(key).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator(layerControl).isChecked(), false, `${label} layer switched off again`);
  }

  // 3. Leaving Safety puts back what it drew, and the map is never taken away.
  await kpi('incidents').click();
  await page.waitForTimeout(1500);
  await page.locator('.app-nav [data-section="overview"]').click();
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.safety-workspace .ws-kpis').isVisible(), false, 'the strip goes with the workspace');
  assert.equal(await page.locator('#live-events-incident').isChecked(), false, 'and so does its layer');
  const controls = await page.evaluate(() => { const c = window.__viewer.scene.screenSpaceCameraController; return [c.enableRotate, c.enableTranslate, c.enableZoom, c.enableTilt]; });
  assert.ok(controls.every(Boolean), 'pan, zoom, rotate and tilt are never taken away');

  // 4. Coming back starts clean.
  await page.locator('.app-nav [data-section="safety"]').click();
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.safety-workspace .ws-kpi[aria-pressed="true"]').count(), 0, 'returning chooses nothing');
  console.log('✓ leaving Safety puts its layer away, camera controls untouched, returning starts clean');

  // 5. The corridor is quiet right now, so the populated path is proven against a stubbed feed —
  //    the same endpoint the app already reads, shaped exactly as the service returns it.
  const stub = {
    source: 'FL511', sourceStatus: 'LIVE', lastUpdated: new Date().toISOString(),
    dataFreshness: { ageSeconds: 0, refreshSeconds: 60, staleAfterSeconds: 180 },
    counts: { total: 3, incidents: 2, closures: 1 },
    events: [
      { id: 'TEST-INC-1', rawSourceId: 'TEST-INC-1', type: 'INCIDENT', title: 'Multi-vehicle crash', severity: 'Major',
        description: 'Two lanes blocked', latitude: 26.0932, longitude: -80.1243, detailFields: [] },
      { id: 'TEST-INC-2', rawSourceId: 'TEST-INC-2', type: 'INCIDENT', title: 'Vehicle fire', severity: 'Minor',
        description: 'On the shoulder', latitude: 26.0951, longitude: -80.1601, detailFields: [] },
      { id: 'TEST-CLO-1', rawSourceId: 'TEST-CLO-1', type: 'CLOSURE', title: 'Ramp closure', severity: 'Minor',
        description: 'Off-ramp closed', latitude: 26.0889, longitude: -80.2098, detailFields: [] },
      { id: 'TEST-DV-1', rawSourceId: 'TEST-DV-1', type: 'DISABLED', title: 'Disabled vehicle', severity: 'Minor',
        description: 'On the right shoulder', latitude: 26.0951, longitude: -80.1601, detailFields: [] },
      { id: 'TEST-DV-2', rawSourceId: 'TEST-DV-2', type: 'DISABLED', title: 'Disabled truck', severity: 'Major',
        description: 'Blocking a lane', latitude: 26.1182, longitude: -80.3306, detailFields: [] },
    ],
  };
  await page.route('**/api/i595/live-events*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(stub) }));
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off&data=mock');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.locator('.app-nav [data-section="safety"]').click();
  await page.waitForFunction(() => document.querySelector('.safety-workspace .ws-kpi[data-kpi="incidents"] [data-count]')?.textContent === '2', null, { timeout: 60000 });
  assert.equal(await kpi('incidents').locator('[data-count]').innerText(), '2');
  assert.equal(await kpi('incidents').locator('[data-note]').innerText(), '1 major', 'the note counts what FL511 called major');
  console.log('✓ with a live feed carrying events, the card counts them by type and notes the severe ones');

  await kpi('incidents').click();
  await page.getByRole('region', { name: 'Incidents explorer', exact: true }).waitFor({ timeout: 30000 });
  const incidentCards = page.getByRole('region', { name: 'Incidents explorer', exact: true }).locator('.MuiCardActionArea-root');
  assert.equal(await page.evaluate(() => window.__assetExplorer.store.getState().assetsByType.incident.length), 2);
  await incidentCards.first().click();
  await page.waitForTimeout(2000);
  const chosen = await page.evaluate(() => window.__assetExplorer.store.getState().selectedAsset);
  assert.ok(['TEST-INC-1', 'TEST-INC-2'].includes(chosen.id), 'a card selects the incident it names');
  assert.equal(await page.locator('#live-events-incident').isChecked(), true);
  assert.equal(await page.evaluate(() => window.__viewer.dataSources.getByName('FL511 Live Road Events')[0]?.entities.values.filter(e => e.show).length ?? 0) > 0, true, 'its markers are on the map');
  console.log(`✓ Active incidents → browser with 2 cards, map markers on, selecting one works (${chosen.id})`);

  // 5b. Disabled vehicles: a live hazard, so it sits on Safety beside the active incidents.
  await page.waitForFunction(() => document.querySelector('.safety-workspace .ws-kpi[data-kpi="disabledVehicles"] [data-count]')?.textContent === '2', null, { timeout: 30000 });
  assert.equal(await kpi('disabledVehicles').locator('[data-note]').innerText(), '1 major',
    'a stopped vehicle blocking a lane is worth calling out');
  await kpi('disabledVehicles').click();
  const disabledList = page.getByRole('region', { name: 'Disabled Vehicles explorer', exact: true });
  await disabledList.waitFor({ timeout: 30000 });
  assert.equal(await page.locator('#live-events-disabled').isChecked(), true, 'its own layer switched on');
  assert.equal(await page.evaluate(() => window.__assetExplorer.store.getState().assetsByType.disabledVehicle.length), 2);
  await disabledList.locator('.MuiCardActionArea-root').first().click();
  await page.waitForTimeout(2000);
  const stopped = await page.evaluate(() => window.__assetExplorer.store.getState().selectedAsset);
  assert.ok(['TEST-DV-1', 'TEST-DV-2'].includes(stopped.id), 'a card selects the vehicle it names');
  const drawnDisabled = await page.evaluate(() => window.__viewer.dataSources.getByName('FL511 Live Road Events')[0]
    .entities.values.filter(e => e.show).map(e => e.id).sort());
  assert.deepEqual(drawnDisabled, ['TEST-DV-1', 'TEST-DV-2'], 'only the disabled-vehicle markers are drawn');
  console.log(`✓ Disabled vehicles: 2 counted, card → layer → slider, selecting one works (${stopped.id})`);
  await kpi('disabledVehicles').click();   // put the layer away again
  await page.waitForTimeout(1200);

  // 6. The recorded crash history: a DataConnect class on the Safety strip, filtered by crash type.
  await page.waitForFunction(() => document.querySelector('.safety-workspace .ws-kpi[data-kpi="crashes"]')?.dataset.state === 'ready', null, { timeout: 60000 });
  const crashes = kpi('crashes');
  const crashCount = Number((await crashes.locator('[data-count]').innerText()).replace(/,/g, ''));
  assert.ok(crashCount > 0, 'the crash class loaded');
  assert.match(await crashes.locator('[data-note]').innerText(), /with injuries|None with injuries/,
    'the note answers the safety question, not a generic one');
  await crashes.click();
  const crashList = page.getByRole('region', { name: 'Incidents explorer', exact: true });
  await crashList.waitFor({ timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__assetExplorer.store.getState().assetsByType.incidentRecord.length), crashCount,
    'the browser holds what the card counts');
  console.log(`✓ Recorded crashes: ${crashCount} from DataConnect, card → slider`);

  // The crash taxonomy is a dropdown, not chips: fifteen types would push the cards off screen.
  const typeSelect = crashList.locator('[aria-label="Incident type"]');
  assert.equal(await typeSelect.count(), 1, 'the slider offers an incident-type filter');
  await typeSelect.click();
  const options = await page.locator('li[role="option"]').allInnerTexts();
  assert.ok(options.length > 3, `the types come from the data (${options.length} options)`);
  assert.match(options[0], /^All incident types$/, 'choosing nothing is named, not blank');
  // Ordered by how many records carry each, so the counts descend.
  const counts = options.slice(1).map(text => Number(/\((\d+)\)$/.exec(text)?.[1] ?? 0));
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'commonest type first');
  await page.locator('li[role="option"]').nth(1).click();
  await page.waitForTimeout(1500);
  const shown = await page.evaluate(() => window.__assetExplorer.store.filteredAssets().length);
  assert.equal(shown, counts[0], 'the list narrows to exactly that type');
  assert.ok(shown < crashCount, 'which is fewer than all of them');
  assert.match(await crashList.innerText(), new RegExp(`${shown} of ${crashCount.toLocaleString('en-US')}`),
    'and the count says so');
  console.log(`✓ crash type filter: ${options.length - 1} types, narrowed ${crashCount} → ${shown}`);

  assert.deepEqual(problems, []);
  console.log('✓ no page or console errors');
} finally { await browser.close(); }
