// Run with the local Vite server on 5188: node cesium-poc/e2e/i595-ramps.smoke.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openExplorer } from './i595Explorer.mjs';

const data = JSON.parse(readFileSync(new URL('../public/data/i595_ramps_connectors_classified.geojson', import.meta.url)));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let requests = 0;
  page.on('request', request => { if (request.url().includes('/data/i595_ramps_connectors_classified.geojson')) requests++; });
  // Test-only access to the actual viewer; no production globals or alternate selection path.
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('viewer.animation.container', 'window.rampTestViewer = viewer; viewer.animation.container') });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await openExplorer(page);
  await page.locator('#ramps-all:not(:disabled)').waitFor({ timeout: 60000 });
  await page.waitForTimeout(1600);
  // Ramp styling is camera-distance driven (RAMP_INTERACTION_HEIGHT). The app opens close in, at the
  // western beginning of the corridor, so pull back to the full-corridor view before the far-camera
  // assertions below; the interaction half of this test flies back in for itself.
  await page.locator('#reset-view').click();
  await page.waitForTimeout(2000);
  await page.evaluate(async () => {
    const text = await (await fetch('/src/i595Demo.js')).text();
    window.rampTestCesium = await import(text.match(/from\s*"([^"]*cesium[^\"]*)"/)[1]);
  });
  const rampEntities = () => page.evaluate(() => {
    const viewer = window.rampTestViewer;
    const source = viewer.dataSources.getByName('I-595 Ramps & Connectors')[0];
    return source.entities.values.map(entity => ({ id: entity.id, show: entity.show, width: entity.polyline.width.getValue(), properties: entity.properties.getValue(viewer.clock.currentTime) }));
  });
  let entities = await rampEntities();
  assert.equal(entities.length, 165);
  assert.equal(entities.filter(entity => entity.show).length, 0);
  assert.equal(await page.locator('.ramp-group').getAttribute('open'), null);
  // No layer starts switched on. (Base Environment is a radio group, so one option is always
  // selected — that is its default basemap, not a layer.)
  assert.equal(await page.locator('input[type="checkbox"]:checked').count(), 0);
  assert.equal(await page.locator('input[name="base-environment"]:checked').getAttribute('value'), 'GOOGLE_PHOTOREALISTIC_3D',
    'the map opens in Photorealistic 3D; Base Environment is a radio group, not a data layer');
  assert.equal(await page.locator('#ramp-interchange option').count(), 12);

  // Mainline still loads independently, with original colors and source files.
  for (const [index, name] of ['I-595 Eastbound', 'I-595 Westbound', '595 Express'].entries()) {
    await page.getByRole('checkbox', { name, exact: true }).check();
    await page.locator('#layer-status').filter({ hasText: `${index + 1} of 3 road layers visible` }).waitFor();
  }
  for (const name of ['I-595 Eastbound', 'I-595 Westbound', '595 Express']) await page.getByRole('checkbox', { name, exact: true }).uncheck();
  await page.locator('#ramps-all').check();
  entities = await rampEntities();
  assert.equal(entities.filter(entity => entity.show).length, 165);
  assert.ok(entities.every(entity => entity.width === 2));
  for (const type of ['ENTRY_RAMP', 'EXIT_RAMP', 'INTERCHANGE_RAMP', 'INTERCHANGE_CONNECTOR', 'EXPRESS_CONNECTOR']) {
    await page.locator(`input[value="${type}"]`).uncheck();
    assert.ok((await rampEntities()).filter(entity => entity.properties.ramp_type === type).every(entity => !entity.show));
    await page.locator(`input[value="${type}"]`).check();
  }
  await page.locator('#ramps-all').uncheck();
  await page.getByRole('checkbox', { name: 'Exit / Off-ramps', exact: true }).check();
  assert.ok(await page.locator('#ramps-all').evaluate(input => input.indeterminate));
  await page.locator('#ramp-interchange').selectOption('FLAMINGO_RD');
  entities = (await rampEntities()).filter(entity => entity.show);
  const expected = data.features.filter(feature => feature.properties.ramp_type === 'EXIT_RAMP' && feature.properties.interchange === 'FLAMINGO_RD');
  assert.deepEqual(entities.map(entity => entity.properties.osm_way_id).sort(), expected.map(feature => feature.properties.osm_way_id).sort());
  assert.equal(requests, 1);

  // Verify every original coordinate is retained (Cartesian conversion tolerance only).
  const coordinates = await page.evaluate(() => {
    const { Cartographic, Math: CMath } = window.rampTestCesium;
    const v = window.rampTestViewer;
    return v.dataSources.getByName('I-595 Ramps & Connectors')[0].entities.values.map(e => ({
      id: e.properties.osm_way_id.getValue(),
      points: e.polyline.positions.getValue(v.clock.currentTime).map(p => { const c = Cartographic.fromCartesian(p); return [CMath.toDegrees(c.longitude), CMath.toDegrees(c.latitude)]; }),
    }));
  });
  for (const feature of data.features) {
    const actual = coordinates.find(record => record.id === feature.properties.osm_way_id).points;
    assert.equal(actual.length, feature.geometry.coordinates.length);
    actual.forEach((point, i) => point.forEach((value, axis) => assert.ok(Math.abs(value - feature.geometry.coordinates[i][axis]) < 1e-8)));
  }

  const target = expected.find(feature => feature.properties.structure_confidence === 'LOW');
  const [lon, lat] = target.geometry.coordinates[Math.floor(target.geometry.coordinates.length / 2)];
  await page.evaluate(({ lon, lat }) => {
    const { Cartesian3, Math: CMath } = window.rampTestCesium;
    window.rampTestViewer.camera.setView({ destination: Cartesian3.fromDegrees(lon, lat, 1400), orientation: { heading: 0, pitch: CMath.toRadians(-90), roll: 0 } });
  }, { lon, lat });
  await page.waitForTimeout(1800);
  // Find an actual rendered pixel for the source ramp, then drive real mouse input.
  const point = await page.evaluate(id => {
    const { SceneTransforms } = window.rampTestCesium;
    const viewer = window.rampTestViewer;
    const entity = viewer.dataSources.getByName('I-595 Ramps & Connectors')[0].entities.getById(`i595-ramp:${id}`);
    for (const position of entity.polyline.positions.getValue(viewer.clock.currentTime)) {
      const pixel = SceneTransforms.worldToWindowCoordinates(viewer.scene, position);
      if (pixel && pixel.x > 420 && pixel.x < 1000 && pixel.y > 120 && pixel.y < 800 && viewer.scene.pick(pixel)?.id === entity) return { x: pixel.x, y: pixel.y };
    }
    return null;
  }, target.properties.osm_way_id);
  assert.ok(point, 'Ramp must be pickable at its real rendered coordinates');
  await page.mouse.move(point.x, point.y);
  await page.getByRole('tooltip').filter({ hasText: 'Exit / Off-ramp' }).waitFor();
  assert.equal((await rampEntities()).find(entity => entity.id === `i595-ramp:${target.properties.osm_way_id}`).width, 5);
  await page.mouse.click(point.x, point.y);
  await page.getByRole('region', { name: 'Ramp details' }).waitFor();
  assert.deepEqual(await page.locator('.ramp-details dt').allTextContents(), ['Ramp Type', 'Direction', 'From', 'To', 'Interchange', 'Connected Facility', 'Source']);
  assert.ok(!(await page.locator('.ramp-details').textContent()).includes('confidence'));
  assert.equal((await rampEntities()).find(entity => entity.id === `i595-ramp:${target.properties.osm_way_id}`).width, 6);
  await page.mouse.move(900, 110);
  assert.equal((await rampEntities()).filter(entity => entity.width === 6).length, 1);
  await page.screenshot({ path: '/tmp/i595-ramps-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/i595-ramps-mobile.png' });
  await page.getByRole('button', { name: 'Close ramp details' }).click();
  assert.equal((await rampEntities()).filter(entity => entity.width === 6).length, 0);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.locator('#ramp-interchange').selectOption('');
  await page.locator('#ramps-all').check();
  await page.locator('#ramps-all').uncheck();
  assert.equal((await rampEntities()).filter(entity => entity.show).length, 0);
  assert.equal(requests, 1);
  await page.locator('#reset-view').click();
  await page.waitForTimeout(1600);
  const height = await page.evaluate(() => window.rampTestViewer.camera.positionCartographic.height);
  assert.ok(Math.abs(height - 24000) < 1);
  await page.locator('#zoom-in').click();
  assert.ok(await page.evaluate(() => window.rampTestViewer.camera.positionCartographic.height < 24000));
  console.log('PASS: 165 unchanged geometries, one load, mainline regression, category/parent/interchange filters, real hover/click, confidence, selection, mobile and camera controls.');
} finally {
  await browser.close();
}
