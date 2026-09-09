/**
 * The presentation layer of the hero view: the status card's numbers are the layers' real counts,
 * the context labels behave like map labelling rather than POI pins, and the infrastructure markers
 * stay subordinate to the corridor they sit on.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openExplorer } from './i595Explorer.mjs';
import { LABEL_VISIBLE_TO_M } from '../src/i595ContextLabels.js';
import { contextLabelPlacements } from '../src/i595ShieldData.js';
import { SIGNAL_LOD } from '../src/trafficSignals.js';

const corridor = JSON.parse(readFileSync(new URL('../config/corridorCenterline.json', import.meta.url)));
const placements = contextLabelPlacements(corridor);
const cameraCount = JSON.parse(readFileSync(new URL('../public/data/i595_corridor_cameras.geojson', import.meta.url))).features.length;
const signalCount = JSON.parse(readFileSync(new URL('../public/data/i595_corridor_traffic_signals.geojson', import.meta.url))).features.length;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text())
      .replace('viewer.animation.container', 'window.v = viewer; viewer.animation.container')
      .replace('if (import.meta.hot)', 'window.shields = roadShields; window.labels = contextLabels; window.events = liveEventControls; if (import.meta.hot)') });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.locator('#cameras-all:not(:disabled)').waitFor({ state: 'attached', timeout: 60000 });
  await page.locator('#signals-all:not(:disabled)').waitFor({ state: 'attached', timeout: 60000 });
  await page.evaluate(async () => {
    const text = await (await fetch('/src/i595Demo.js')).text();
    window.C = await import(text.match(/from\s*"([^"]*cesium[^"]*)"/)[1]);
  });

  // ---- the status card carries real counts, and nothing else -----------------------------------
  const hud = page.locator('.twin-hud');
  await hud.waitFor({ timeout: 30000 });
  assert.equal(await hud.locator('h1').textContent(), 'I-595 Digital Twin');
  assert.equal(await hud.locator('.twin-hud-place').textContent(), 'Broward County, Florida');
  const width = (await hud.boundingBox()).width;
  assert.ok(width >= 220 && width <= 260, `status card must stay compact, was ${Math.round(width)} px`);
  // It sits outside Map Explorer, not inside it.
  assert.equal(await page.locator('.layers .twin-hud').count(), 0);

  await page.waitForFunction(count => document.querySelector('[data-metric="cameras"]')?.textContent === String(count),
    cameraCount, { timeout: 30000 });
  const metrics = await page.evaluate(() => Object.fromEntries(
    [...document.querySelectorAll('[data-metric]')].map(cell => [cell.dataset.metric, cell.textContent])));
  assert.equal(metrics.cameras, String(cameraCount), 'the CCTV count is the layer’s own');
  assert.equal(metrics.signals, String(signalCount), 'the signal count is the layer’s own');
  // The live-event count is whatever the feed currently holds — not a number invented for the card.
  const feed = await page.evaluate(() => window.events.events.length);
  assert.equal(metrics.events, String(feed), 'the live-event count is the feed’s own');
  // There is no LIVE badge: only FL511 events are a live feed, while the CCTV and signal counts are
  // static FDOT inventories, so a badge over the card would overstate what the twin is.
  assert.equal(await hud.locator('.twin-hud-live, .twin-hud-dot').count(), 0, 'the card must not claim to be live');
  // A quiet corridor is stated, never highlighted.
  const quiet = await page.locator('[data-metric="events"]').getAttribute('data-quiet');
  assert.equal(quiet, String(feed === 0), 'an empty live-event count must be understated');
  // No fabricated conditions anywhere on the card.
  const hudText = (await hud.innerText()).toLowerCase();
  for (const invented of ['congest', 'mph', 'km/h', 'delay', 'speed', 'incident', 'weather', 'flow'])
    assert.ok(!hudText.includes(invented), `the status card must not state "${invented}"`);

  // ---- context labels: map labelling, held back at corridor scale --------------------------------
  const labels = await page.evaluate(now => [...window.labels.labelById.values()].map(entity => ({
    id: entity.id, text: entity.label.text.getValue(now), hasBillboard: entity.billboard != null,
    hasPoint: entity.point != null, far: entity.label.distanceDisplayCondition.getValue(now).far,
  })), null);
  assert.equal(labels.length, placements.length);
  assert.deepEqual(labels.map(label => label.text), placements.map(item => item.interchange));
  assert.ok(labels.every(label => !label.hasBillboard && !label.hasPoint), 'labels must be text, never pins');
  assert.ok(labels.every(label => label.far === LABEL_VISIBLE_TO_M), 'labels must fade out by distance');

  // Cesium decides label visibility from the camera-to-label distance against the display
  // condition, so drive the camera and check that contract rather than poking at private fields.
  const labelShownAt = height => page.evaluate(async metres => {
    const label = [...window.labels.labelById.values()][0];
    const position = label.position.getValue(window.v.clock.currentTime);
    const c = window.C.Cartographic.fromCartesian(position);
    window.v.camera.cancelFlight();
    window.v.camera.setView({ destination: window.C.Cartesian3.fromRadians(c.longitude, c.latitude, metres),
      orientation: { heading: 0, pitch: window.C.Math.toRadians(-90), roll: 0 } });
    for (let i = 0; i < 30; i++) { window.v.scene.requestRender(); await new Promise(r => requestAnimationFrame(r)); }
    const distance = window.C.Cartesian3.distance(window.v.camera.positionWC, position);
    const condition = label.label.distanceDisplayCondition.getValue();
    return distance >= condition.near && distance <= condition.far;
  }, height);
  assert.equal(await labelShownAt(2000), true, 'labels are shown at working distance');
  assert.equal(await labelShownAt(24000), false, 'labels are not shown at corridor scale');

  // ---- infrastructure markers stay subordinate to the corridor ----------------------------------
  await openExplorer(page);
  await page.locator('.its-group > summary').click();
  await page.locator('.cameras-group > summary').click({ position: { x: 5, y: 10 } });
  await page.locator('#cameras-all').check();
  await page.locator('.signals-group > summary').click({ position: { x: 5, y: 10 } });
  await page.locator('#signals-all').check();
  await page.waitForTimeout(1200);
  const markers = await page.evaluate(() => {
    const now = window.v.clock.currentTime;
    const camera = window.v.dataSources.getByName('I-595 Corridor CCTV Cameras')[0].entities.values[0];
    const signal = window.v.dataSources.getByName('I-595 Corridor Traffic Signals')[0].entities.values[0];
    const shield = [...window.shields.shieldById.values()][0];
    const read = billboard => ({ width: billboard.width.getValue(now), height: billboard.height.getValue(now),
      far: billboard.distanceDisplayCondition?.getValue(now)?.far ?? null,
      farScale: billboard.scaleByDistance.getValue(now).farValue });
    return {
      camera: read(camera.billboard), shield: read(shield.billboard), signal: read(signal.billboard),
    };
  });
  assert.ok(markers.camera.width >= 22 && markers.camera.width <= 28, `CCTV marker ${markers.camera.width} px`);
  assert.ok(markers.camera.farScale <= 0.3, 'CCTV markers must shrink away with distance');
  assert.ok(markers.camera.far > 0 && markers.camera.far <= 20000, 'CCTV markers must disappear at corridor scale');
  // At this distance signals are drawn at their compact level; the detailed head belongs close in
  // and is covered, with its hysteresis, by i595-navigation.smoke.mjs.
  assert.equal(markers.signal.width, SIGNAL_LOD.COMPACT.width, 'signals stay compact at corridor distance');
  // Priority: the route shield reads larger than the asset markers it shares the corridor with.
  assert.ok(markers.shield.width > markers.camera.width, 'the route shield outranks the CCTV marker');
  assert.ok(markers.shield.width > markers.signal.width, 'the route shield outranks the signal marker');
  // A route label, not a POI: bigger than the asset markers, still nowhere near a pin.
  assert.ok(markers.shield.width >= 24 && markers.shield.width <= 44, `shield ${markers.shield.width} px`);

  console.log(`hero presentation OK — HUD ${cameraCount}/${signalCount}/${feed}, ${labels.length} labels, CCTV ${markers.camera.width}px vs shield ${markers.shield.width}px`);
} finally {
  await browser.close();
}
