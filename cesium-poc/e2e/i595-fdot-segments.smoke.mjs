// Run against local Vite: node cesium-poc/e2e/i595-fdot-segments.smoke.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openExplorer } from './i595Explorer.mjs';
const data = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url)));
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let combinedRequests = 0, oldRequests = 0;
  page.on('request', request => {
    if (request.url().includes('/data/i595_fdot_traffic_segments.geojson')) combinedRequests++;
    if (/\/data\/i595_(mainline_(eb|wb)|eastbound_fdot_segments|westbound_fdot_segments)\.geojson/.test(request.url())) oldRequests++;
  });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace('viewer.animation.container', 'window.fdotViewer = viewer; viewer.animation.container')
      .replace('if (import.meta.hot)', 'window.fdotLayer = mainlineSegments; if (import.meta.hot)');
    await route.fulfill({ response, body });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await openExplorer(page);
  await page.locator('#i595_mainline_eb:not(:disabled)').waitFor({ timeout: 60000 });
  assert.equal(await page.locator('.mainline-parent > summary input, .mainline-group > label input').count(), 3);
  assert.equal(await page.locator('.mainline-group input:checked').count(), 0);
  await page.locator('#i595_mainline_eb').check();
  await page.locator('#layer-status').filter({ hasText: '1 of 3 road layers visible' }).waitFor();
  await page.locator('#i595_mainline_wb').check();
  await page.locator('#layer-status').filter({ hasText: '2 of 3 road layers visible' }).waitFor();
  await page.evaluate(async () => {
    const text = await (await fetch('/src/i595Demo.js')).text();
    window.fdotCesium = await import(text.match(/from\s*"([^"]*cesium[^\"]*)"/)[1]);
    window.fdotOriginalEntities = [...window.fdotLayer.segmentById.values()];
  });
  const state = () => page.evaluate(() => ({
    counts: [...window.fdotLayer.segmentsByDirection].map(([direction, entities]) => [direction, entities.length, entities.filter(e => e.show).length]),
    dynamicCount: window.fdotLayer.segmentStatus.size,
  }));
  assert.deepEqual((await state()).counts, [['EB', 8, 8], ['WB', 8, 8]]);
  assert.equal((await state()).dynamicCount, 0);
  const actual = await page.evaluate(() => {
    const { Cartographic, Math: CMath } = window.fdotCesium;
    return [...window.fdotLayer.segmentById].map(([id, e]) => ({ id, properties: e.properties.getValue(), width: e.polyline.width.getValue(), color: e.polyline.material.getValue().color.toCssHexString(), alpha: +e.polyline.material.getValue().color.alpha.toFixed(2),
      points: e.polyline.positions.getValue().map(p => { const c = Cartographic.fromCartesian(p); return [CMath.toDegrees(c.longitude), CMath.toDegrees(c.latitude)]; }),
    }));
  });
  for (const feature of data.features) {
    const entity = actual.find(e => e.id === feature.properties.segment_id);
    assert.equal(entity.width, 3.5);
    // The route hue is unchanged; only the resting opacity is, so compare the RGB and the alpha.
    assert.equal(entity.color.slice(0, 7), feature.properties.direction === 'EB' ? '#52dcf5' : '#c49aff');
    assert.equal(entity.alpha, 0.8, 'the resting overlay is part-transparent so the roadway shows through');
    for (const key of ['segment_id', 'direction', 'begin_post', 'end_post', 'aadt', 'desc_from', 'desc_to']) assert.equal(entity.properties[key], feature.properties[key]);
    assert.equal(entity.points.length, feature.geometry.coordinates.length);
    entity.points.forEach((point, i) => point.forEach((v, axis) => assert.ok(Math.abs(v - feature.geometry.coordinates[i][axis]) < 1e-8)));
  }
  await page.locator('#i595_mainline_wb').uncheck();
  assert.deepEqual((await state()).counts, [['EB', 8, 8], ['WB', 8, 0]]);
  await page.locator('#i595_mainline_eb').uncheck();
  await page.locator('#i595_mainline_wb').check();
  assert.deepEqual((await state()).counts, [['EB', 8, 0], ['WB', 8, 8]]);
  await page.locator('#i595_mainline_eb').check();

  // Actual screen pixels on three different sections, including both carriageways.
  for (const [direction, beginPost] of [['EB', 6.68], ['EB', 5.142], ['WB', 6.68]]) {
    const feature = data.features.find(f => f.properties.direction === direction && f.properties.begin_post === beginPost);
    const [lon, lat] = feature.geometry.coordinates[Math.floor(feature.geometry.coordinates.length / 2)];
    await page.evaluate(({ lon, lat }) => {
      const { Cartesian3, Math: CMath } = window.fdotCesium;
      window.fdotViewer.camera.cancelFlight();
      window.fdotViewer.camera.setView({ destination: Cartesian3.fromDegrees(lon, lat, 1400), orientation: { heading: 0, pitch: CMath.toRadians(-90), roll: 0 } });
    }, { lon, lat });
    await page.waitForTimeout(1800);
    const point = await page.evaluate(id => {
      const viewer = window.fdotViewer, { SceneTransforms } = window.fdotCesium;
      const entity = window.fdotLayer.segmentById.get(id);
      for (const position of entity.polyline.positions.getValue()) {
        const xy = SceneTransforms.worldToWindowCoordinates(viewer.scene, position);
        if (xy && xy.x > 420 && xy.x < 1000 && xy.y > 120 && xy.y < 800 && viewer.scene.pick(xy)?.id === entity) return { x: xy.x, y: xy.y };
      }
      return null;
    }, feature.properties.segment_id);
    assert.ok(point, `Pickable section: ${feature.properties.segment_id}`);
    await page.mouse.move(point.x, point.y);
    await page.getByRole('tooltip').filter({ hasText: `MP ${beginPost.toFixed(3)}` }).waitFor();
    await page.mouse.click(point.x, point.y);
    await page.getByRole('region', { name: 'Road Segment Details' }).waitFor();
    assert.deepEqual(await page.locator('.segment-details dt').allTextContents(), ['Road', 'Direction', 'FDOT Roadway', 'FDOT Section', 'Milepost', 'From', 'To', 'AADT', 'AADT Year']);
    const values = await page.locator('.segment-details dd').allTextContents();
    assert.equal(values[1], direction === 'EB' ? 'Eastbound' : 'Westbound');
    assert.equal(values[4], `${beginPost.toFixed(3)} – ${feature.properties.end_post.toFixed(3)}`);
    assert.equal(values[5], feature.properties.desc_from);
    assert.equal(values[6], feature.properties.desc_to);
    assert.equal(values[7], `${feature.properties.aadt.toLocaleString('en-US')} vehicles/day`);
    assert.equal(values[8], '2025');
    assert.deepEqual(await page.evaluate(() => [...window.fdotLayer.segmentById.values()].filter(e => e.polyline.width.getValue() === 6.5).map(e => e.id)), [feature.properties.segment_id]);
    await page.mouse.move(950, 110);
  }
  await page.screenshot({ path: '/tmp/i595-fdot-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/i595-fdot-mobile.png' });
  await page.getByRole('button', { name: 'Close road segment details' }).click();
  assert.equal(await page.locator('.segment-details').isVisible(), false);
  assert.equal(await page.evaluate(() => [...window.fdotLayer.segmentById.values()].filter(e => e.polyline.width.getValue() === 6.5).length), 0);
  assert.ok(await page.evaluate(() => window.fdotOriginalEntities.every(e => e === window.fdotLayer.segmentById.get(e.id))));
  assert.equal(combinedRequests, 1);
  assert.equal(oldRequests, 0);
  assert.equal((await state()).dynamicCount, 0);
  await page.setViewportSize({ width: 1400, height: 900 });
  const groups = page.locator('.mainline-parent');
  assert.equal(await groups.count(), 2);
  assert.equal(await groups.nth(0).getAttribute('open'), null);
  assert.equal(await groups.nth(1).getAttribute('open'), null);
  for (let i = 0; i < 2; i++) {
    await groups.nth(i).locator('summary').click({position:{x:5,y:10}});
    assert.equal(await groups.nth(i).locator('.segment-row input').count(), 8);
    const names = await groups.nth(i).locator('.segment-select').allTextContents();
    const indexes = names.map(name => Number(name.match(/Segment (\d+)/)[1]));
    assert.deepEqual(indexes, i === 0 ? [1,2,3,4,5,6,7,8] : [8,7,6,5,4,3,2,1]);
  }
  const id = 'I595-EB-FDOT-006680-007350';
  const checkbox = page.locator(`input[data-segment-id="${id}"]`);
  const label = page.locator(`button[data-segment-id="${id}"]`);
  await checkbox.uncheck();
  assert.equal(await page.locator('.segment-details').isVisible(), false);
  assert.deepEqual((await state()).counts, [['EB',8,7],['WB',8,8]]);
  assert.ok(await page.locator('#i595_mainline_eb').evaluate(input => input.indeterminate));
  await label.hover();
  assert.equal(await page.evaluate(id => window.fdotLayer.segmentById.get(id).show, id), false);
  await checkbox.check();
  await label.hover();
  assert.equal(await page.evaluate(id => window.fdotLayer.segmentById.get(id).polyline.width.getValue(), id), 5);
  assert.equal(await page.locator('.segment-details').isVisible(), false);
  await label.click();
  await page.locator('.segment-details:not([hidden])').waitFor();
  assert.ok((await page.locator('.segment-details dd').allTextContents()).includes('4 of 8'));
  assert.deepEqual(await page.evaluate(() => [...window.fdotLayer.segmentById.values()].filter(e => e.polyline.width.getValue()===6.5).map(e=>e.id)),[id]);
  await checkbox.uncheck();
  assert.equal(await page.locator('.segment-details').isVisible(), false);
  await label.click();
  assert.ok(await checkbox.isChecked());
  for (const direction of ['eb','wb']) {
    await page.locator('#i595_mainline_'+direction).check();
    await page.locator('#i595_mainline_'+direction).uncheck();
    assert.equal(await page.evaluate(dir => window.fdotLayer.segmentsByDirection.get(dir).filter(e=>e.show).length,direction.toUpperCase()),0);
    await page.locator('#i595_mainline_'+direction).check();
  }
  await page.screenshot({path:'/tmp/i595-segment-tree-desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await label.scrollIntoViewIfNeeded();
  await page.screenshot({path:'/tmp/i595-segment-tree-mobile.png'});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth===innerWidth && document.documentElement.scrollHeight===innerHeight));
  assert.equal(combinedRequests,1);
  assert.ok(await page.evaluate(()=>window.fdotOriginalEntities.every(e=>e===window.fdotLayer.segmentById.get(e.id))));
  console.log('PASS: expandable EB/WB tree, travel order, per-segment visibility, indeterminate parents, sidebar hover/selection, compact mobile scrolling, one load.');
  console.log('PASS: one combined FDOT load, 8 EB/8 WB, original geometry/properties/colors, logical layer toggles, independent real hover/selection, FDOT details, empty dynamic state, desktop/mobile.');
} finally { await browser.close(); }
