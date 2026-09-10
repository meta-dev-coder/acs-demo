/**
 * 595 Express managed lanes: the corridor's third roadway now loads, styles, hovers, selects and
 * reports FDOT details like the mainline, ramps and frontage roads — it is no longer a silent
 * polyline. Verifies the supplied geometry and properties reach the map unchanged.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { expressDetails, expressFromProperties } from '../src/i595ExpressData.js';
import { openExplorer } from './i595Explorer.mjs';

const data = JSON.parse(readFileSync(new URL('../public/data/express-way.geojson', import.meta.url)));
const feature = data.features[0];
const expected = new Map(expressDetails(expressFromProperties(feature.properties)));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let requests = 0;
  page.on('request', request => { if (request.url().includes('/data/express-way.geojson')) requests++; });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace('viewer.animation.container', 'window.v = viewer; viewer.animation.container')
      .replace('import.meta.hot.dispose(() => {', 'window.express = expressLanes; import.meta.hot.dispose(() => {');
    await route.fulfill({ response, body });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await openExplorer(page);
  await page.locator('#express-way:not(:disabled)').waitFor({ state: 'attached', timeout: 60000 });
  await page.evaluate(async () => {
    const text = await (await fetch('/src/i595Demo.js')).text();
    window.C = await import(text.match(/from\s*"([^"]*cesium[^"]*)"/)[1]);
  });

  // ---- default off, one load, geometry preserved -----------------------------------------------
  assert.equal(requests, 0, '595 Express must not load until it is switched on');
  assert.equal(await page.locator('#express-way').isChecked(), false);
  await page.locator('#express-way').check();
  await page.waitForTimeout(1500);
  assert.equal(requests, 1);
  const drawn = await page.evaluate(() => {
    const source = window.v.dataSources.getByName('595 Express')[0];
    return source.entities.values.map(entity => ({
      show: entity.show, name: entity.name,
      points: entity.polyline.positions.getValue(window.v.clock.currentTime).map(p => {
        const c = window.C.Cartographic.fromCartesian(p);
        return [window.C.Math.toDegrees(c.longitude), window.C.Math.toDegrees(c.latitude)];
      }),
    }));
  });
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].show, true);
  assert.equal(drawn[0].name, '595 Express');
  assert.equal(drawn[0].points.length, feature.geometry.coordinates.length);
  drawn[0].points.forEach((point, i) => point.forEach((value, axis) =>
    assert.ok(Math.abs(value - feature.geometry.coordinates[i][axis]) < 1e-8, 'express geometry must be unchanged')));

  // ---- real hover and click on the drawn lanes -------------------------------------------------
  const target = await page.evaluate(async () => {
    const entity = window.v.dataSources.getByName('595 Express')[0].entities.values[0];
    const points = entity.polyline.positions.getValue(window.v.clock.currentTime);
    const position = points[Math.floor(points.length / 2)];
    const c = window.C.Cartographic.fromCartesian(position);
    window.v.camera.cancelFlight();
    window.v.camera.setView({
      destination: window.C.Cartesian3.fromRadians(c.longitude, c.latitude, 700),
      orientation: { heading: 0, pitch: window.C.Math.toRadians(-90), roll: 0 },
    });
    for (let i = 0; i < 60; i++) { window.v.scene.requestRender(); await new Promise(r => requestAnimationFrame(r)); }
    const screen = window.C.SceneTransforms.worldToWindowCoordinates(window.v.scene, position);
    for (let radius = 0; radius <= 8; radius++) for (const [dx, dy] of [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
      const point = new window.C.Cartesian2(Math.round(screen.x + dx), Math.round(screen.y + dy));
      if (window.v.scene.pick(point)?.id === entity) return { x: point.x, y: point.y };
    }
    return null;
  });
  assert.ok(target, '595 Express must be pickable at its own rendered coordinates');

  await page.evaluate(() => {
    const material = window.v.dataSources.getByName('595 Express')[0].entities.values[0].polyline.material;
    window.expressMaterialChanges = 0;
    material.definitionChanged.addEventListener(() => window.expressMaterialChanges++);
  });
  await page.mouse.move(target.x, target.y);
  const tooltip = page.getByRole('tooltip');
  await tooltip.filter({ hasText: '595 Express' }).waitFor({ timeout: 10000 });
  assert.match(await tooltip.textContent(), /Reversible · MP 0\.000 – 8\.796/);
  const hoverWidth = await page.evaluate(() => window.v.dataSources.getByName('595 Express')[0]
    .entities.values[0].polyline.width.getValue());
  assert.equal(hoverWidth, 3.5, 'hovering must preserve the ground-line pick geometry');
  for (let i = 0; i < 12; i++) {
    await page.mouse.move(target.x + (i % 2) * 0.1, target.y);
    await page.waitForTimeout(40);
    // Cesium batches ground polylines asynchronously, so a single frame may fall between builds.
    // What must hold is that hovering never *loses* the pick target — not that every frame has it.
    const picks = () => page.evaluate(p => window.v.scene.pick(p)?.id === window.v.dataSources.getByName('595 Express')[0].entities.values[0], target);
    let ok = false;
    for (const deadline = Date.now() + 4000; !ok && Date.now() < deadline;) ok = await picks();
    assert.ok(ok, 'hover must retain its pick target across frames');
  }

  assert.equal(await page.evaluate(() => window.expressMaterialChanges), 0, 'hover must not invalidate the ground material batch');
  // Clicking needs no extra delay for a hover-triggered geometry rebuild.
  await page.mouse.click(target.x, target.y);
  await page.locator('.express-details:not([hidden])').waitFor({ timeout: 10000 });
  assert.equal(await page.locator('.express-details h2').textContent(), 'Express Lane Details');
  const rows = await page.locator('.express-details dl').evaluate(dl => {
    const out = [];
    for (let i = 0; i < dl.children.length; i += 2) out.push([dl.children[i].textContent, dl.children[i + 1].textContent]);
    return out;
  });
  assert.deepEqual(new Map(rows), expected, 'details must come from the supplied FDOT properties');
  assert.equal(await page.evaluate(() => window.v.dataSources.getByName('595 Express')[0]
    .entities.values[0].polyline.width.getValue()), 3.5, 'selection must preserve the ground-line pick geometry');

  // ---- closing, and switching the layer off, clear the selection --------------------------------
  await page.locator('.express-details button').click();
  assert.equal(await page.locator('.express-details:not([hidden])').count(), 0);
  await page.waitForTimeout(600);
  await page.mouse.click(target.x, target.y);
  await page.locator('.express-details:not([hidden])').waitFor({ timeout: 10000 });
  await page.locator('#express-way').uncheck();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.express-details:not([hidden])').count(), 0, 'hiding the layer must close its panel');
  assert.equal(await page.evaluate(() => window.v.dataSources.getByName('595 Express')[0].entities.values[0].show), false);
  await page.locator('#express-way').check();
  await page.waitForTimeout(400);
  assert.equal(requests, 1, '595 Express must load exactly once');

  console.log('595 Express OK — unchanged geometry, one load, real hover/click, FDOT details, visibility');
} finally {
  await browser.close();
}
