/**
 * Map navigation and the traffic-signal level of detail.
 *
 * Covers the whole interaction contract: the hero view loads, every navigation button does what it
 * says while preserving the rest of the camera, manual navigation is never disabled, and — most
 * importantly — selecting a signal neither hides it nor locks the camera.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openExplorer } from './i595Explorer.mjs';
import { MAX_PITCH_DEG, MIN_PITCH_DEG, ROTATE_STEP_DEG } from '../src/mapNavigationControls.js';
import { SIGNAL_DETAIL_FAR_M, SIGNAL_DETAIL_NEAR_M, SIGNAL_LOD } from '../src/trafficSignals.js';
import { heroView } from '../src/i595CorridorViews.js';

const corridor = JSON.parse(readFileSync(new URL('../config/corridorCenterline.json', import.meta.url)));
const signals = JSON.parse(readFileSync(new URL('../public/data/i595_corridor_traffic_signals.geojson', import.meta.url)));
const hero = heroView(corridor);

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text())
      .replace('viewer.animation.container', 'window.v = viewer; viewer.animation.container')
      .replace('import.meta.hot.dispose(() => {', 'window.signals = signalControls; import.meta.hot.dispose(() => {') });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.evaluate(async () => {
    const text = await (await fetch('/src/i595Demo.js')).text();
    window.C = await import(text.match(/from\s*"([^"]*cesium[^"]*)"/)[1]);
    window.cam = () => {
      const c = window.C.Cartographic.fromCartesian(window.v.camera.position);
      const deg = window.C.Math.toDegrees;
      return { lon: deg(c.longitude), lat: deg(c.latitude), height: c.height,
        heading: deg(window.v.camera.heading), pitch: deg(window.v.camera.pitch) };
    };
    window.settle = async (frames = 45) => {
      for (let i = 0; i < frames; i++) { window.v.scene.requestRender(); await new Promise(r => requestAnimationFrame(r)); }
    };
  });
  const cam = () => page.evaluate(() => window.cam());
  // Some controls animate (the compass swings to north), so let the motion finish before reading.
  const press = async id => { await page.locator(`#${id}`).click(); await page.waitForTimeout(900); await page.evaluate(() => window.settle()); };

  // ---- A. the hero view is what loads ----------------------------------------------------------
  const start = await cam();
  // The opening frame is heroView() tightened by the map's own zoom, so check what makes it the
  // hero view — a low oblique on the hero bearing — rather than the module's untightened numbers.
  assert.ok(start.height > 500 && start.height < 1400, `hero altitude ${Math.round(start.height)} m`);
  assert.ok(Math.abs(start.pitch - hero.pitchDeg) < 3, `hero pitch ${start.pitch}`);
  assert.ok(Math.abs(start.heading - hero.headingDeg) < 1, `hero heading ${start.heading}`);

  // ---- B/C. proportional zoom, at hero altitude and again far out ------------------------------
  for (const [label, setHeight] of [['hero', null], ['corridor', 24000]]) {
    if (setHeight) {
      await page.evaluate(async metres => {
        const c = window.C.Cartographic.fromCartesian(window.v.camera.position);
        window.v.camera.cancelFlight();
        window.v.camera.setView({ destination: window.C.Cartesian3.fromRadians(c.longitude, c.latitude, metres),
          orientation: { heading: window.v.camera.heading, pitch: window.v.camera.pitch, roll: 0 } });
        await window.settle();
      }, setHeight);
    }
    const before = await cam();
    await press('zoom-in');
    const zoomedIn = await cam();
    assert.ok(zoomedIn.height < before.height * 0.95, `${label}: + must zoom in (${Math.round(before.height)} → ${Math.round(zoomedIn.height)})`);
    await press('zoom-out');
    const zoomedOut = await cam();
    assert.ok(zoomedOut.height > zoomedIn.height * 1.05, `${label}: − must zoom out`);
  }

  // Back to the hero view for the orbit checks: tilting towards the horizon from 24 km asks the
  // photorealistic tileset for half the state, which is not what these controls are for.
  const toHero = () => page.evaluate(async view => {
    window.v.camera.cancelFlight();
    window.v.camera.setView({ destination: window.C.Cartesian3.fromDegrees(view.lon, view.lat, view.height),
      orientation: { heading: window.C.Math.toRadians(view.headingDeg), pitch: window.C.Math.toRadians(view.pitchDeg), roll: 0 } });
    await window.settle();
  }, { lon: hero.lon, lat: hero.lat, height: hero.height, headingDeg: hero.headingDeg, pitchDeg: hero.pitchDeg });
  await toHero();

  // ---- D/E. rotate turns the view without moving it or changing the tilt -----------------------
  const beforeRotate = await cam();
  await press('rotate-right');
  const right = await cam();
  const delta = ((right.heading - beforeRotate.heading + 540) % 360) - 180;
  assert.ok(Math.abs(delta - ROTATE_STEP_DEG) < 2, `rotate right must turn ~${ROTATE_STEP_DEG}°, turned ${delta.toFixed(1)}°`);
  assert.ok(Math.abs(right.pitch - beforeRotate.pitch) < 1.5, 'rotating must preserve the tilt');
  await press('rotate-left');
  const back = await cam();
  assert.ok(Math.abs(((back.heading - beforeRotate.heading + 540) % 360) - 180) < 2, 'rotate left must undo rotate right');

  // ---- F/G. tilt, clamped so the camera can never end up unusable -------------------------------
  const beforeTilt = await cam();
  await press('tilt-down');
  const tiltedDown = await cam();
  assert.ok(tiltedDown.pitch > beforeTilt.pitch, 'tilt down must raise the pitch towards the horizon');
  await press('tilt-up');
  assert.ok((await cam()).pitch < tiltedDown.pitch, 'tilt up must lower the pitch towards the ground');
  for (let i = 0; i < 20; i++) await press('tilt-down');
  const shallowest = await cam();
  assert.ok(shallowest.pitch <= MAX_PITCH_DEG + 1.5 && shallowest.pitch >= MAX_PITCH_DEG - 1.5,
    `tilt must clamp at ${MAX_PITCH_DEG}°, reached ${shallowest.pitch.toFixed(1)}°`);
  for (let i = 0; i < 20; i++) await press('tilt-up');
  const steepest = await cam();
  assert.ok(steepest.pitch >= MIN_PITCH_DEG - 1.5 && steepest.pitch <= MIN_PITCH_DEG + 1.5,
    `tilt must clamp at ${MIN_PITCH_DEG}°, reached ${steepest.pitch.toFixed(1)}°`);
  assert.ok(steepest.pitch < 0, 'the camera can never end up upside down');

  // ---- H. north-up turns the view without moving it, and is not Reset View ----------------------
  await toHero();
  await press('rotate-right');
  await press('tilt-down');
  const beforeNorth = await cam();
  await press('north-up');
  const north = await cam();
  assert.ok(Math.abs(north.heading) < 1 || Math.abs(north.heading - 360) < 1, `north-up must face north, got ${north.heading}`);
  assert.ok(Math.abs(north.pitch - beforeNorth.pitch) < 2, 'north-up must keep the current tilt');
  const metres = Math.hypot((north.lon - beforeNorth.lon) * Math.cos(north.lat * Math.PI / 180), north.lat - beforeNorth.lat) * 111320;
  assert.ok(metres < 1, `north-up turns on the spot, moved ${metres.toFixed(1)} m`);
  assert.ok(Math.abs(north.height - beforeNorth.height) < 1, 'north-up must keep the altitude');
  // ...and Reset View is still a different action.
  await page.locator('#reset-view').click();
  await page.waitForTimeout(2200);
  assert.ok((await cam()).height > 20000, 'Reset View still returns to the corridor overview');

  // ---- H2. the compass reads the camera's heading and is not Reset View ------------------------
  await toHero();
  const bearing = () => page.locator('#north-up').getAttribute('title');
  assert.match(await bearing(), /Heading \d+°/, 'the compass reports the current bearing');
  const needleAt = () => page.locator('.map-nav-needle').evaluate(el => el.style.transform);
  const turned = await needleAt();
  await press('rotate-right');
  assert.notEqual(await needleAt(), turned, 'the needle turns with the camera');
  await press('north-up');
  assert.match(await bearing(), /Facing north/);
  assert.equal(await page.locator('#north-up').getAttribute('data-aligned'), '', 'the compass marks itself aligned');
  assert.equal(await needleAt(), 'rotate(0deg)');

  // ---- I. manual navigation is never disabled ---------------------------------------------------
  const controller = await page.evaluate(() => {
    const c = window.v.scene.screenSpaceCameraController;
    return { rotate: c.enableRotate, translate: c.enableTranslate, zoom: c.enableZoom, tilt: c.enableTilt, look: c.enableLook };
  });
  for (const [name, enabled] of Object.entries(controller)) assert.equal(enabled, true, `enable${name} must stay on`);
  // The camera is never left attached to a reference frame, which would lock panning and orbiting.
  assert.equal(await page.evaluate(() => window.C.Matrix4.equals(window.v.camera.transform, window.C.Matrix4.IDENTITY)), true,
    'the camera must not be left on a transform');

  // ---- J/K/L. signals: compact along the corridor, detailed close in ----------------------------
  await openExplorer(page);
  await page.locator('.its-group > summary').click();
  await page.locator('.signals-group > summary').click({ position: { x: 5, y: 10 } });
  await page.locator('#signals-all').check();
  await page.waitForTimeout(1500);
  const levelAt = height => page.evaluate(async metres => {
    const entity = [...window.signals.trafficSignalById.values()][0];
    const c = window.C.Cartographic.fromCartesian(entity.position.getValue(window.v.clock.currentTime));
    window.v.camera.cancelFlight();
    window.v.camera.setView({ destination: window.C.Cartesian3.fromRadians(c.longitude, c.latitude, metres),
      orientation: { heading: 0, pitch: window.C.Math.toRadians(-60), roll: 0 } });
    await window.settle(60);
    const now = window.v.clock.currentTime;
    return { width: entity.billboard.width.getValue(now), height: entity.billboard.height.getValue(now),
      distance: window.C.Cartesian3.distance(window.v.camera.positionWC, entity.position.getValue(now)) };
  }, height);
  const far = await levelAt(9000);
  assert.ok(far.distance > SIGNAL_DETAIL_FAR_M);
  assert.equal(far.width, SIGNAL_LOD.COMPACT.width, 'at corridor distance signals stay compact');
  assert.ok(far.width <= 18, 'the far marker must not dominate the freeway');
  const near = await levelAt(700);
  assert.ok(near.distance < SIGNAL_DETAIL_NEAR_M);
  assert.equal(near.width, SIGNAL_LOD.DETAILED.width, 'close in, the detailed signal head appears');
  assert.ok(near.width >= 22 && near.width <= 28 && near.height >= 45 && near.height <= 55,
    `detailed signal ${near.width}x${near.height}`);
  // Hysteresis: inside the band the level holds rather than flickering.
  const inBand = await levelAt((SIGNAL_DETAIL_NEAR_M + SIGNAL_DETAIL_FAR_M) / 2 * Math.sin(Math.PI / 3));
  assert.equal(inBand.width, SIGNAL_LOD.DETAILED.width, 'the level holds inside the hysteresis band');

  // ---- M/N/O/P. selecting a signal keeps it visible and the camera free -------------------------
  const id = signals.features[0].properties.asset_id;
  await page.locator(`button[data-signal-id="${id}"]`).click();
  await page.locator('.signal-details:not([hidden])').waitFor({ timeout: 20000 });
  await page.waitForTimeout(2600);
  const selected = await page.evaluate(sid => {
    const entity = window.signals.trafficSignalById.get(sid);
    const now = window.v.clock.currentTime;
    const position = entity.position.getValue(now);
    const pixel = window.C.SceneTransforms.worldToWindowCoordinates(window.v.scene, position);
    const raw = Object.getPrototypeOf(window.v.scene).pick;
    const renderedRows = [];
    for (let dy = 4; dy >= -40; dy -= 4) {
      if (raw.call(window.v.scene, new window.C.Cartesian2(Math.round(pixel.x), Math.round(pixel.y + dy)))?.id?.id === sid) renderedRows.push(dy);
    }
    return { show: entity.show, width: entity.billboard.width.getValue(now), scale: entity.billboard.scale.getValue(now),
      hasPoint: entity.point != null, renderedRows,
      distance: window.C.Cartesian3.distance(window.v.camera.positionWC, entity.position.getValue(now)) };
  }, id);
  assert.equal(selected.show, true, 'a selected signal must not be hidden');
  assert.equal(selected.hasPoint, false,
    'the selection ring belongs in the icon: a clamped point collides with the billboard and hides the signal');
  assert.ok(selected.renderedRows.length > 0, 'the selected signal must actually be drawn at its own position');
  assert.equal(selected.width, SIGNAL_LOD.SELECTED.width, 'a selected signal keeps a detailed head, on its selection ring');
  assert.ok(selected.scale > 1 && selected.scale <= 1.2, `selection is a subtle lift, got scale ${selected.scale}`);
  // 13: an oblique feature view that keeps the surroundings, not a close top-down.
  const focused = await cam();
  assert.ok(focused.height >= 600 && focused.height <= 1000, `feature focus altitude ${Math.round(focused.height)} m`);
  assert.ok(focused.pitch >= -45 && focused.pitch <= -35, `feature focus pitch ${focused.pitch.toFixed(1)}`);

  // The camera is still free with the panel open.
  const openPanelBefore = await cam();
  await press('rotate-right');
  assert.notEqual((await cam()).heading.toFixed(2), openPanelBefore.heading.toFixed(2), 'rotation must work with the panel open');
  await press('tilt-down');
  await press('zoom-in');
  assert.ok((await cam()).height < openPanelBefore.height, 'zoom must work with the panel open');
  assert.equal(await page.locator('.signal-details:not([hidden])').count(), 1, 'navigating must not close the panel');
  assert.equal(await page.evaluate(() => window.C.Matrix4.equals(window.v.camera.transform, window.C.Matrix4.IDENTITY)), true,
    'the camera must still be free after focusing a feature');
  await page.evaluate(() => window.v.scene.camera.moveBackward(50));

  // P. closing the panel restores the resting presentation.
  await page.locator('.signal-details button').click();
  await page.waitForTimeout(600);
  const cleared = await page.evaluate(sid => {
    const entity = window.signals.trafficSignalById.get(sid);
    return { scale: entity.billboard.scale.getValue(window.v.clock.currentTime), show: entity.show };
  }, id);
  assert.equal(cleared.scale, 1, 'closing the panel restores the resting scale');
  assert.equal(cleared.show, true, 'and the signal is still on the map');
  await page.screenshot({ path: '/tmp/i595-navigation.png' });

  console.log('navigation OK — zoom/rotate/tilt/north-up, signal LOD compact→detailed, selection keeps the signal and frees the camera');
} finally {
  await browser.close();
}
