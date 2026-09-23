/**
 * The left navigation bar: four workspaces, Layers at the foot opening the Map Explorer, and both
 * themes. Every workspace shows the same I-595 view for now, so what is checked here is that the map
 * keeps running and the choice is recorded — not that anything about the view changes.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const problems = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  // Network trouble reaching the live FL511 feed is the environment's, not the bar's.
  const networkNoise = /Failed to load resource|net::ERR|CORS policy|Failed to fetch|live-events|snapshot/;
  page.on('console', m => { if (m.type() === 'error' && !networkNoise.test(m.text())) problems.push(`console: ${m.text()}`); });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });

  const nav = page.locator('.app-nav');
  const items = nav.locator('.app-nav-sections .app-nav-item');
  const layers = nav.locator('[data-action="layers"]');
  const panel = page.locator('.layers');

  // 1. The four workspaces, with Layers kept separate at the foot.
  assert.deepEqual(await items.allInnerTexts(), ['Overview', 'Traffic', 'Maintenance', 'Safety']);
  assert.equal(await layers.innerText(), 'Layers');
  assert.ok((await layers.boundingBox()).y > (await items.last().boundingBox()).y, 'Layers sits at the bottom');
  assert.equal(await items.first().getAttribute('aria-current'), 'page', 'Overview is chosen on load');
  console.log('✓ four workspaces (Overview, Traffic, Maintenance, Safety) with Layers at the foot');

  // 2. The map is there from the start and stays through every workspace.
  const mapRunning = () => page.evaluate(() => {
    const canvas = document.querySelector('.cesium-widget canvas');
    return Boolean(canvas && canvas.clientWidth > 600 && document.querySelector('#cesiumContainer'));
  });
  assert.ok(await mapRunning());
  for (const name of ['Traffic', 'Maintenance', 'Safety', 'Overview']) {
    await nav.getByRole('button', { name, exact: true }).click();
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => document.body.dataset.section), name.toLowerCase());
    assert.equal(await nav.getByRole('button', { name, exact: true }).getAttribute('aria-current'), 'page');
    assert.equal(await nav.locator(String.raw`.app-nav-sections .app-nav-item[aria-current="page"]`).count(), 1, "exactly one workspace is chosen");
    assert.ok(await mapRunning(), `the I-595 view is still shown under ${name}`);
  }
  assert.deepEqual(problems, []);
  console.log('✓ each workspace opens the I-595 Cesium view and is marked as the chosen one');

  // 3. Layers opens the Map Explorer collapsed to its rail, expands, and closes again.
  assert.equal(await panel.isVisible(), false, 'the explorer starts closed');
  assert.equal(await layers.getAttribute('aria-pressed'), 'false');
  await layers.click();
  await panel.waitFor({ state: 'visible' });
  assert.equal(await layers.getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('.quick-rail').isVisible(), true, 'opens on the rail');
  assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false', 'collapsed to begin with');
  await page.locator('#menu-toggle').click();
  assert.equal(await page.locator('#layer-content').isVisible(), true, 'the tree expands as before');
  await layers.click();
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await layers.getAttribute('aria-pressed'), 'false');
  console.log('✓ Layers opens the Map Explorer (collapsed rail → expanded tree) and closes it again');

  // 4. A layer switched on from the rail stays on when the explorer is closed again.
  await layers.click();
  await page.locator('.quick-rail [data-layer="cameras"]').click();
  await page.waitForFunction(() => window.__assetExplorer?.store.getState().activeExplorerType === 'camera', null, { timeout: 60000 });
  await layers.click();
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await page.evaluate(() => window.__assetExplorer.store.getState().activeExplorerType), 'camera');
  assert.equal(await page.getByRole('region', { name: 'Traffic Cameras explorer', exact: true }).isVisible(), true);
  console.log('✓ closing Layers leaves the layers themselves alone');

  // 5. The bar does not cover the map furniture that sits against the left edge.
  const navBox = await nav.boundingBox();
  for (const [name, locator] of [['corridor status strip', page.locator('.corridor-status')], ['asset explorer mini-map', page.locator('canvas[aria-label*="mini-map"]')]]) {
    if (!await locator.count() || !await locator.first().isVisible()) continue;
    const box = await locator.first().boundingBox();
    assert.ok(box.x >= navBox.width, `${name} clears the bar (${Math.round(box.x)} ≥ ${Math.round(navBox.width)})`);
  }
  console.log('✓ the panels along the left edge sit beside the bar, not under it');

  // 6. Both themes: the bar is painted from the theme tokens, so it follows the app's own switch.
  const paint = () => page.evaluate(() => {
    const style = getComputedStyle(document.querySelector('.app-nav'));
    const chosen = getComputedStyle(document.querySelector('.app-nav-item[aria-current="page"]'));
    return { theme: document.documentElement.dataset.theme, background: style.backgroundColor, text: chosen.color, tint: chosen.backgroundColor };
  });
  const dark = await paint();
  assert.equal(dark.theme, 'dark');
  await page.locator('#theme-toggle').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.waitForTimeout(400);   // the bar eases between colours; read it once it has settled
  const light = await paint();
  assert.notEqual(light.background, dark.background, 'the bar repaints');
  assert.notEqual(light.text, dark.text, 'the chosen workspace repaints');
  // Light is light and dark is dark, rather than merely different.
  const luminance = colour => colour.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  assert.ok(luminance(light.background) > 180, `light bar is light (${light.background})`);
  assert.ok(luminance(dark.background) < 60, `dark bar is dark (${dark.background})`);
  assert.notEqual(light.tint, 'rgba(0, 0, 0, 0)', 'the chosen workspace keeps its tint in light mode');
  await page.locator('#theme-toggle').click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  console.log(`✓ both themes: bar ${dark.background} → ${light.background}, chosen workspace ${dark.text} → ${light.text}`);

  assert.deepEqual(problems, []);
  console.log('✓ no page or console errors');
} finally { await browser.close(); }
