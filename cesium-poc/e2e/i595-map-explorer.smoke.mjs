/**
 * Map Explorer: one-click operation, and one canonical layer state behind every surface.
 *
 * The point of the redesign is that the quick rail, a category view and the full hierarchy are three
 * windows onto the same state — so this drives each one in turn and checks the others agree,
 * including the checkbox the layer's own module reacts to.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openExplorer, revealLayerGroup, openLayers } from './i595Explorer.mjs';
import { RAIL_LAYER_IDS } from '../src/mapLayerStore.js';

const signalCount = JSON.parse(readFileSync(new URL('../public/data/i595_corridor_traffic_signals.geojson', import.meta.url))).features.length;
const cameraCount = JSON.parse(readFileSync(new URL('../public/data/i595_corridor_cameras.geojson', import.meta.url))).features.length;
/** The control each logical layer ultimately writes to — the module's own checkbox. */
const CONTROLS = { signals: '#signals-all', cameras: '#cameras-mainline', incidents: '#live-events-incident', direction: '#flow-direction' };

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  // Reach the segment layer, to check that the direction option really drives the arrows.
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text())
      .replace('import.meta.hot.dispose(() => {', 'window.mainline = mainlineSegments; import.meta.hot.dispose(() => {') });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.locator('#signals-all:not(:disabled)').waitFor({ state: 'attached', timeout: 60000 });
  await page.locator('#cameras-mainline:not(:disabled)').waitFor({ state: 'attached', timeout: 60000 });

  /** Every surface's opinion of one layer, plus the underlying control. */
  const opinionsOf = id => page.evaluate(({ layerId, control }) => ({
    rail: document.querySelector(`.quick-rail [data-layer="${layerId}"]`)?.getAttribute('aria-pressed'),
    rail2: document.querySelector(`.quick-rail [data-layer="${layerId}"]`)?.getAttribute('aria-pressed'),
    category: document.querySelector(`.layer-categories [data-layer="${layerId}"]`)?.getAttribute('aria-pressed'),
    control: control ? document.querySelector(control)?.checked : null,
  }), { layerId: id, control: CONTROLS[id] ?? null });
  const agreed = async (id, expected) => {
    const opinions = await opinionsOf(id);
    for (const [surface, value] of Object.entries(opinions)) {
      if (value == null) continue;
      const asBoolean = typeof value === 'string' ? value === 'true' : value;
      assert.equal(asBoolean, expected, `${surface} disagrees about "${id}" (expected ${expected})`);
    }
  };

  // ---- collapsed: the quick rail is the interface, and one click is enough ----------------------
  // The Map Explorer now belongs to the left bar's Layers button, and opens on its rail.
  assert.equal(await page.locator('.layers').isVisible(), false, 'it starts closed, behind Layers');
  await openLayers(page);
  assert.equal(await page.locator('#layer-content').isHidden(), true, 'the panel starts closed');
  assert.equal(await page.locator('.quick-rail').isVisible(), true, 'the quick rail stays on screen');
  const railWidth = (await page.locator('.quick-rail').boundingBox()).width;
  assert.ok(railWidth >= 44 && railWidth <= 60, `the rail stays narrow, was ${Math.round(railWidth)} px`);
  for (const id of RAIL_LAYER_IDS) {
    assert.equal(await page.locator(`.quick-rail [data-layer="${id}"]`).count(), 1, `${id} must be one click away`);
    assert.ok(await page.locator(`.quick-rail [data-layer="${id}"]`).getAttribute('title'), `${id} needs a tooltip`);
  }

  await agreed('signals', false);
  await page.locator('.quick-rail [data-layer="signals"]').click();
  await page.waitForTimeout(2500);
  await agreed('signals', true);
  assert.equal(await page.locator('#signals-all').isChecked(), true, 'the rail writes through to the layer’s own control');

  // ---- expanded: quick layers near the top, real counts, and the same state --------------------
  await openExplorer(page);
  const panelWidth = (await page.locator('#layer-content').boundingBox()).width;
  assert.ok(panelWidth >= 300 && panelWidth <= 380, `the panel stays compact, was ${Math.round(panelWidth)} px`);
  // The panel leads with categories: no preset row, no quick-layer list.
  assert.equal(await page.locator('.view-presets, .quick-layers').count(), 0, 'the panel is categories and All layers');
  await page.locator('.layer-category[data-category="infrastructure"] > summary').click();
  assert.equal(await page.locator('.layer-categories [data-count="signals"]').textContent(), String(signalCount));
  // Cameras fold into express and mainline groups, the way Traffic Flow folds its routes: the
  // category view lists the two, and the rail keeps one tool for both.
  assert.equal(await page.locator('.layer-categories [data-layer="cameras-express"]').count(), 1);
  assert.equal(await page.locator('.layer-categories [data-layer="cameras-mainline"]').count(), 1);
  assert.equal(await page.locator('.quick-rail [data-layer="cameras"]').count(), 1, 'one camera tool on the rail');

  // Toggling from a category reaches the hierarchy, and vice versa.
  await page.locator('.quick-rail [data-layer="cameras"]').click();
  await page.waitForTimeout(2000);
  await agreed('cameras', true);
  // ...and back the other way, from the hierarchy itself.
  await revealLayerGroup(page, '.cameras-mainline-group');
  await page.locator('#cameras-mainline').uncheck();
  await page.waitForTimeout(900);
  await agreed('cameras', false);

  // ---- categories are one click deep, no Mainline level in between ------------------------------
  await page.locator('.layer-category[data-category="roads"] > summary').click();
  const roadRows = await page.locator('.layer-category[data-category="roads"] [data-layer]').evaluateAll(
    nodes => nodes.map(node => node.dataset.layer));
  assert.deepEqual(roadRows, ['mainline-eb', 'mainline-wb', 'express', 'frontage', 'ramps']);
  await page.locator('.layer-category[data-category="roads"] [data-layer="mainline-eb"]').click();
  await page.waitForTimeout(2500);
  assert.equal(await page.locator('#i595_mainline_eb').isChecked(), true, 'a category row drives the real layer');

  // ---- bridges are reachable in one click from the rail --------------------------------------
  assert.equal(await page.locator('.quick-rail [data-layer="structures"]').count(), 1, 'bridges sit on the rail');
  await page.locator('.quick-rail [data-layer="structures"]').click();
  await page.waitForTimeout(3000);
  await agreed('structures', true);
  assert.equal(await page.locator('#bridges-all').isChecked(), true, 'the rail drives the real bridges layer');

  // ---- the direction option is a display toggle, not a data layer -------------------------------
  // It has no geojson of its own; being treated as one left it disabled and reset it on every click.
  assert.equal(await page.evaluate(() => document.querySelector('#flow-direction').disabled), false,
    'the direction toggle must be usable');
  await page.locator('.quick-rail [data-layer="traffic-flow"]').click();
  await page.waitForTimeout(4000);
  const arrows = () => page.evaluate(() => [...window.mainline.segmentById.values()]
    .filter(entity => entity.show).filter(entity => entity.polyline.material?.arrows).length);
  assert.ok(await arrows() > 0, 'direction arrows are drawn when the option is on');
  await page.locator('.quick-rail [data-layer="direction"]').click();
  await page.waitForTimeout(1200);
  assert.equal(await arrows(), 0, 'turning direction off must actually stop the arrows');
  assert.equal(await page.evaluate(() => document.querySelector('#flow-direction').checked), false);
  await page.locator('.quick-rail [data-layer="direction"]').click();
  await page.waitForTimeout(1200);
  assert.ok(await arrows() > 0, 'and turning it back on must restore them');
  assert.equal(await page.evaluate(() => document.querySelector('#flow-direction').checked), true,
    'the toggle must hold its state rather than resetting');

  // ---- the complete hierarchy is still there, under All layers ----------------------------------
  const advanced = page.locator('.all-layers');
  assert.equal(await advanced.count(), 1);
  for (const group of ['.roads', '.mainline-group', '.its-group', '.ramp-group', '.frontage-group', '.structures-group', '.live-events-group']) {
    assert.equal(await page.locator(`.all-layers ${group}`).count(), 1, `${group} must survive under All layers`);
  }
  // And "DataLayer" is nowhere in the user-facing interface.
  assert.equal((await page.locator('#layer-content').innerText()).includes('DataLayer'), false);

  // ---- closing restores the rail and keeps every layer exactly as it was -------------------------
  const stateBefore = await page.evaluate(() => [...document.querySelectorAll('#layer-content input[type=checkbox]')]
    .map(input => `${input.id}:${input.checked}`).join('|'));
  await page.locator('#menu-toggle').click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('#layer-content').isHidden(), true);
  assert.equal(await page.locator('.quick-rail').isVisible(), true, 'closing restores the quick rail');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#layer-content input[type=checkbox]')]
    .map(input => `${input.id}:${input.checked}`).join('|')), stateBefore, 'collapsing preserves layer visibility');

  console.log('map explorer OK — rail one-click incl. bridges, direction really toggles, categories, All layers preserved, one canonical state');
} finally {
  await browser.close();
}
