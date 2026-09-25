/**
 * The Traffic workspace: the two restriction cards — lane closures and construction — over the map,
 * each opening the bottom browser for the layer that already draws it.
 *
 * Safety and Traffic share one implementation and one FL511 feed, so this also proves the split:
 * each layer is driven from exactly one workspace, and leaving puts back what it drew.
 *
 * The feed is live, so the corridor may genuinely hold none of either right now. Expectations are
 * taken from what the app received, never written here, and the populated path is proven against a
 * stubbed feed shaped exactly as the service returns it.
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
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.waitForTimeout(4000);   // the feed's first fetch

  const kpi = key => page.locator(`.traffic-workspace .ws-kpi[data-kpi="${key}"]`);

  // 1. Traffic carries the restriction cards, and nothing is chosen on arrival.
  await page.locator('.app-nav [data-section="traffic"]').click();
  await page.locator('.traffic-workspace .ws-kpis').waitFor();
  assert.deepEqual(await page.locator('.traffic-workspace .ws-kpi-label').allInnerTexts(), ['Lane closures', 'Construction', 'Congestion']);
  assert.equal(await page.locator('.traffic-workspace .ws-kpi[aria-pressed="true"]').count(), 0, 'nothing chosen on arrival');
  assert.equal(await page.locator('[role="region"][aria-label$="explorer"]').count(), 0, 'and no browser until asked for');
  assert.match(await page.locator('.traffic-workspace .ws-source').innerText(), /FL511/);
  const counts = await page.evaluate(() => {
    const read = key => Number(document.querySelector(`.traffic-workspace .ws-kpi[data-kpi="${key}"] [data-count]`).textContent.replace(/,/g, ''));
    return { closures: read('closures'), construction: read('construction'), congestion: read('congestion'), installed: Boolean(window.__traffic) };
  });
  assert.ok(counts.installed, 'the workspace is installed');
  console.log(`✓ Traffic: Lane closures ${counts.closures}, Construction ${counts.construction}, Congestion ${counts.congestion}, source ${await page.locator('.traffic-workspace .ws-source').innerText()}`);

  // 2. Each card switches its own layer on and opens the browser for it — or says the corridor has
  //    none, which is an answer rather than an error.
  for (const [key, layerControl, label, assetType] of [
    ['closures', '#live-events-closure', 'Closures', 'closure'],
    ['construction', '#live-events-construction', 'Construction', 'construction'],
    ['congestion', '#live-events-congestion', 'Congestion', 'congestion'],
  ]) {
    const count = Number((await kpi(key).locator('[data-count]').innerText()).replace(/,/g, ''));
    await kpi(key).click();
    await page.waitForTimeout(2500);
    assert.equal(await kpi(key).getAttribute('aria-pressed'), 'true', `${label} card reads as chosen`);
    assert.equal(await page.locator(layerControl).isChecked(), true, `${label} layer switched on`);
    if (count > 0) {
      await page.getByRole('region', { name: `${label} explorer`, exact: true }).waitFor({ timeout: 30000 });
      const inExplorer = await page.evaluate(type => window.__assetExplorer.store.getState().assetsByType[type]?.length ?? 0, assetType);
      assert.equal(inExplorer, count, `${label}: the browser holds the same ${count} the card counts`);
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

  // 3. Safety no longer carries these: one layer, one workspace.
  await page.locator('.app-nav [data-section="safety"]').click();
  await page.locator('.safety-workspace .ws-kpis').waitFor();
  // Safety keeps the live incidents and the recorded crash history; neither is a restriction.
  assert.deepEqual(await page.locator('.safety-workspace .ws-kpi-label').allInnerTexts(),
    ['Active incidents', 'Disabled vehicles', 'Recorded crashes'], 'closures and construction moved off Safety');
  assert.equal(await page.locator('.traffic-workspace .ws-kpis').isVisible(), false, 'only one strip is on screen at a time');
  console.log('✓ closures and construction are on Traffic only; Safety keeps incidents');

  // 4. Leaving Traffic puts back what it drew, and the map is never taken away.
  await page.locator('.app-nav [data-section="traffic"]').click();
  await kpi('construction').click();
  await page.waitForTimeout(1500);
  await page.locator('.app-nav [data-section="overview"]').click();
  await page.waitForTimeout(1500);
  assert.equal(await page.locator('.traffic-workspace .ws-kpis').isVisible(), false, 'the strip goes with the workspace');
  assert.equal(await page.locator('#live-events-construction').isChecked(), false, 'and so does its layer');
  const controls = await page.evaluate(() => { const c = window.__viewer.scene.screenSpaceCameraController; return [c.enableRotate, c.enableTranslate, c.enableZoom, c.enableTilt]; });
  assert.ok(controls.every(Boolean), 'pan, zoom, rotate and tilt are never taken away');
  await page.locator('.app-nav [data-section="traffic"]').click();
  await page.waitForTimeout(800);
  assert.equal(await page.locator('.traffic-workspace .ws-kpi[aria-pressed="true"]').count(), 0, 'returning chooses nothing');
  console.log('✓ leaving Traffic puts its layer away, camera controls untouched, returning starts clean');

  // 5. The populated path, against the endpoint the app already reads.
  const stub = {
    source: 'FL511', sourceStatus: 'LIVE', lastUpdated: new Date().toISOString(),
    dataFreshness: { ageSeconds: 0, refreshSeconds: 60, staleAfterSeconds: 180 },
    counts: { total: 3, incidents: 0, closures: 1, construction: 2 },
    events: [
      { id: 'TEST-CLO-1', rawSourceId: 'TEST-CLO-1', type: 'CLOSURE', title: 'Ramp closure', severity: 'Major',
        description: 'Off-ramp closed', latitude: 26.0889, longitude: -80.2098, detailFields: [] },
      { id: 'TEST-CON-1', rawSourceId: 'TEST-CON-1', type: 'CONSTRUCTION', title: 'Planned construction', severity: 'Major',
        description: 'Two right lanes closed', latitude: 26.1182, longitude: -80.3306, detailFields: [] },
      { id: 'TEST-CON-2', rawSourceId: 'TEST-CON-2', type: 'CONSTRUCTION', title: 'Resurfacing', severity: 'Minor',
        description: 'Shoulder work', latitude: 26.0951, longitude: -80.1601, detailFields: [] },
    ],
  };
  await page.route('**/api/i595/live-events*', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(stub) }));
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.locator('.app-nav [data-section="traffic"]').click();
  await page.waitForFunction(() => document.querySelector('.traffic-workspace .ws-kpi[data-kpi="construction"] [data-count]')?.textContent === '2', null, { timeout: 60000 });
  assert.equal(await kpi('closures').locator('[data-count]').innerText(), '1');
  assert.equal(await kpi('construction').locator('[data-count]').innerText(), '2');
  // The two cards deliberately note different things. A closure FL511 called major is reported as
  // such; roadwork is not, because FL511 marks whole work zones "Major" and "1 major" there would
  // read as an emergency rather than as scheduled work. Both stubbed events are Major, so this
  // distinguishes the rules rather than merely observing them.
  assert.equal(await kpi('closures').locator('[data-note]').innerText(), '1 major');
  assert.match(await kpi('construction').locator('[data-note]').innerText(), /^Updated /);
  console.log('✓ each card counts its own type; a major closure says so, major roadwork reports freshness');

  await kpi('construction').click();
  await page.getByRole('region', { name: 'Construction explorer', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.evaluate(() => window.__assetExplorer.store.getState().assetsByType.construction.length), 2);
  await page.getByRole('region', { name: 'Construction explorer', exact: true }).locator('.MuiCardActionArea-root').first().click();
  await page.waitForTimeout(2000);
  const chosen = await page.evaluate(() => window.__assetExplorer.store.getState().selectedAsset);
  assert.ok(['TEST-CON-1', 'TEST-CON-2'].includes(chosen.id), 'a card selects the work zone it names');
  assert.equal(await page.locator('#live-events-construction').isChecked(), true);
  const shown = await page.evaluate(() => window.__viewer.dataSources.getByName('FL511 Live Road Events')[0]?.entities.values.filter(e => e.show).map(e => e.id) ?? []);
  assert.deepEqual(shown.sort(), ['TEST-CON-1', 'TEST-CON-2'], 'only the construction markers are drawn');
  console.log(`✓ Construction → browser with 2 cards, only its markers on the map, selecting one works (${chosen.id})`);

  assert.deepEqual(problems, []);
  console.log('✓ no page or console errors');
} finally { await browser.close(); }
