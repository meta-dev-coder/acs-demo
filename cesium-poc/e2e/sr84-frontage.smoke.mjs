// Run with Vite on port 5188: node cesium-poc/e2e/sr84-frontage.smoke.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openExplorer } from './i595Explorer.mjs';

const data = JSON.parse(readFileSync(new URL('../public/data/sr84_frontage_roads.geojson', import.meta.url)));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let requests = 0;
  page.on('request', request => { if (request.url().includes('/data/sr84_frontage_roads.geojson')) requests++; });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('viewer.animation.container', 'window.frontageTestViewer = viewer; viewer.animation.container') });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await openExplorer(page);
  await page.locator('#frontage-all:not(:disabled)').waitFor({ timeout: 60000 });
  await page.waitForTimeout(1600);
  await page.evaluate(async () => {
    const text = await (await fetch('/src/i595Demo.js')).text();
    window.frontageTestCesium = await import(text.match(/from\s*"([^"]*cesium[^\"]*)"/)[1]);
    window.frontageTestSource = window.frontageTestViewer.dataSources.getByName('SR 84 Frontage Roads')[0];
    window.frontageTestEntities = [...window.frontageTestSource.entities.values];
  });
  const visibleCount = () => page.evaluate(() => window.frontageTestSource.entities.values.filter(entity => entity.show).length);
  assert.equal(await page.locator('.frontage-group').getAttribute('open'), null);
  assert.equal(await page.locator('.frontage-categories input').count(), 2);
  assert.equal(await visibleCount(), 0);
  await page.locator('#frontage-all').check();
  assert.equal(await visibleCount(), 185);
  await page.locator('#SR84_WB').uncheck();
  assert.equal(await visibleCount(), 101);
  assert.ok(await page.locator('#frontage-all').evaluate(input => input.indeterminate));
  await page.locator('#SR84_EB').uncheck();
  await page.locator('#SR84_WB').check();
  assert.equal(await visibleCount(), 84);
  await page.locator('#frontage-all').check();
  assert.equal(await visibleCount(), 185);
  const points = await page.evaluate(() => {
    const { Cartographic, Math: CMath } = window.frontageTestCesium;
    return window.frontageTestSource.entities.values.map(e => ({ id: e.properties['@id'].getValue(), points: e.polyline.positions.getValue().map(p => {
      const c = Cartographic.fromCartesian(p); return [CMath.toDegrees(c.longitude), CMath.toDegrees(c.latitude)];
    }) }));
  });
  for (const feature of data.features) {
    const actual = points.find(record => record.id === feature.properties['@id']).points;
    assert.equal(actual.length, feature.geometry.coordinates.length);
    actual.forEach((point, i) => point.forEach((value, axis) => assert.ok(Math.abs(value - feature.geometry.coordinates[i][axis]) < 1e-8)));
  }
  // Real map picking in both directions, with compact allowlisted details only.
  for (const direction of ['EB', 'WB']) {
    const feature = data.features.find(f => f.properties.direction === direction && f.geometry.coordinates.length > 10);
    const [lon, lat] = feature.geometry.coordinates[Math.floor(feature.geometry.coordinates.length / 2)];
    await page.evaluate(({ lon, lat }) => {
      const { Cartesian3, Math: CMath } = window.frontageTestCesium;
      window.frontageTestViewer.camera.setView({ destination: Cartesian3.fromDegrees(lon, lat, 1400), orientation: { heading: 0, pitch: CMath.toRadians(-90), roll: 0 } });
    }, { lon, lat });
    await page.waitForTimeout(1600);
    const point = await page.evaluate(id => {
      const v = window.frontageTestViewer, { SceneTransforms } = window.frontageTestCesium;
      const entity = window.frontageTestSource.entities.getById(`sr84-frontage:${id}`);
      for (const p of entity.polyline.positions.getValue()) {
        const xy = SceneTransforms.worldToWindowCoordinates(v.scene, p);
        if (xy && xy.x > 420 && xy.x < 1000 && xy.y > 120 && xy.y < 800 && v.scene.pick(xy)?.id === entity) return { x: xy.x, y: xy.y };
      }
      return null;
    }, feature.properties['@id']);
    assert.ok(point, `${direction} must be pickable on its actual geometry`);
    const label = direction === 'EB' ? 'SR 84 Eastbound' : 'SR 84 Westbound';
    await page.mouse.move(point.x, point.y);
    await page.getByRole('tooltip').filter({ hasText: label }).waitFor();
    await page.mouse.click(point.x, point.y);
    await page.getByRole('region', { name: 'Road details' }).waitFor();
    assert.deepEqual(await page.locator('.road-details dt').allTextContents(), ['Road', 'Facility', 'Direction', 'Corridor', 'Source']);
    assert.deepEqual(await page.locator('.road-details dd').allTextContents(), ['SR 84', 'Frontage Road', direction === 'EB' ? 'Eastbound' : 'Westbound', 'I-595', 'OpenStreetMap']);
    assert.equal(await page.evaluate(() => window.frontageTestSource.entities.values.filter(e => e.polyline.width.getValue() === 5).length), 1);
  }
  await page.screenshot({ path: '/tmp/sr84-frontage-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/sr84-frontage-mobile.png' });
  await page.locator('#frontage-all').uncheck();
  assert.equal(await visibleCount(), 0);
  assert.equal(await page.locator('.road-details').isVisible(), false);
  assert.ok(await page.evaluate(() => window.frontageTestEntities.every((e, i) => e === window.frontageTestSource.entities.values[i])));
  assert.equal(requests, 1);
  console.log('PASS: 185 unchanged segments, one source load, preserved entities, direction/parent toggles, real EB/WB hover/click, clean details and mobile layout.');
} finally { await browser.close(); }
