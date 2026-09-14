/**
 * Street View as a mode of the digital twin, entered the way Google Maps does it: pick the tool,
 * then drop it on the corridor. The CCTV popup keeps a shortcut, but it is not the way in.
 *
 * Uses Cesium's own GoogleStreetViewCubeMapPanoramaProvider, so the panorama is a primitive in the
 * existing scene rather than an embedded page. What matters here: entering from a real feature,
 * an interactive 360° view, honest imagery labelling, an exact return to the view you left, and no
 * accumulation of primitives, overlays or listeners across repeated trips.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openExplorer, revealLayerGroup } from './i595Explorer.mjs';

/**
 * Compare views by position and viewing direction rather than heading: at a near-nadir camera the
 * heading is numerically ill-conditioned, so two identical views can report headings degrees apart.
 * Direction and up fully determine what is on screen and are stable.
 */
function assertSameView(actual, expected, message) {
  const metres = Math.hypot(actual.x - expected.x, actual.y - expected.y, actual.z - expected.z);
  assert.ok(metres < 1, `${message} — camera moved ${metres.toFixed(2)} m`);
  // Where the camera looks must come back essentially exactly.
  const aim = Math.hypot(...[0, 1, 2].map(i => actual.direction[i] - expected.direction[i]));
  assert.ok(aim < 0.001, `${message} — aim drifted by ${aim.toFixed(6)}`);
  // Roll is allowed a hair more slack: looking straight down, the up axis is degenerate — there is
  // no north to hold it against — so Cesium's own normalisation can land a fraction of a degree
  // away. Under a degree of roll on a nadir view is not something a viewer can see.
  const roll = Math.hypot(...[0, 1, 2].map(i => actual.up[i] - expected.up[i]));
  assert.ok(roll < 0.02, `${message} — roll drifted by ${roll.toFixed(4)}`);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text())
      .replace('viewer.animation.container', 'window.v = viewer; viewer.animation.container')
      .replace('import.meta.hot.dispose(() => {', 'window.sv = streetViewMode; window.cams = cameraControls; window.place = streetViewPlacement; import.meta.hot.dispose(() => {') });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.locator('#cameras-mainline:not(:disabled)').waitFor({ state: 'attached', timeout: 60000 });
  await page.evaluate(async () => {
    const text = await (await fetch('/src/i595Demo.js')).text();
    window.C = await import(text.match(/from\s*"([^"]*cesium[^"]*)"/)[1]);
    window.cam = () => {
      const p = window.v.camera.positionWC, d = window.v.camera.directionWC, u = window.v.camera.upWC;
      return { x: p.x, y: p.y, z: p.z, direction: [d.x, d.y, d.z], up: [u.x, u.y, u.z],
        heading: Math.round(window.C.Math.toDegrees(window.v.camera.heading)) };
    };
    window.scene = () => ({
      panoramas: [...Array(window.v.scene.primitives.length).keys()]
        .map(i => window.v.scene.primitives.get(i).constructor.name).filter(name => /Panorama/.test(name)).length,
      primitives: window.v.scene.primitives.length,
      tilesetShown: [...Array(window.v.scene.primitives.length).keys()].map(i => window.v.scene.primitives.get(i))
        .some(p => p.constructor.name === 'Cesium3DTileset' && p.show),
      dataSourcesShown: [...Array(window.v.dataSources.length).keys()].map(i => window.v.dataSources.get(i)).filter(s => s.show).length,
      rotate: window.v.scene.screenSpaceCameraController.enableRotate,
      look: window.v.scene.screenSpaceCameraController.enableLook,
    });
  });

  // ---- the primary way in: the toolbar tool, with no layer switched on ---------------------------
  assert.equal(await page.locator('#cameras-mainline').isChecked(), false, 'Street View must not need CCTV');
  assert.equal(await page.locator('#street-view').count(), 1, 'the toolbar carries a permanent Street View tool');
  assert.equal(await page.locator('#street-view').getAttribute('title'), 'Street View');

  await page.locator('#street-view').click();
  await page.waitForTimeout(500);
  assert.equal(await page.evaluate(() => window.place.active), true, 'placement mode is entered, not a panorama');
  assert.equal(await page.evaluate(() => window.sv.mode), 'digital-twin', 'clicking the tool must not open a panorama');
  assert.equal(await page.locator('#street-view').getAttribute('aria-pressed'), 'true', 'the tool reads as on');
  // The instruction must match the behaviour: a drop is not restricted to the highlighted corridor.
  assert.match(await page.locator('.street-view-placement').textContent(), /Click anywhere to drop Street View/);
  assert.equal(await page.evaluate(() => window.v.canvas.style.cursor), 'crosshair');
  // Coverage is a temporary overlay in its own source; the traffic layers are untouched.
  const overlay = () => page.evaluate(() => window.v.dataSources.getByName('Street View placement')?.[0]?.entities.values.length ?? 0);
  assert.ok(await overlay() > 0, 'the corridor is highlighted while placing');

  // Escape cancels, and leaves nothing behind.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  assert.equal(await page.evaluate(() => window.place.active), false, 'Escape cancels placement');
  assert.equal(await page.locator('.street-view-placement').isHidden(), true);
  assert.equal(await overlay(), 0, 'the coverage overlay is removed on cancel');
  assert.equal(await page.evaluate(() => window.v.canvas.style.cursor), '', 'the cursor is restored');

  // The tool button also toggles placement off.
  await page.locator('#street-view').click();
  await page.waitForTimeout(300);
  await page.locator('#street-view').click();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.place.active), false, 'the tool toggles placement off');

  // ---- dropping on I-595 opens a panorama facing along the road ---------------------------------
  await page.locator('#street-view').click();
  await page.waitForTimeout(400);
  const drop = await page.evaluate(async () => {
    const corridor = await (await fetch('/config/corridorCenterline.json')).json();
    const point = corridor[Math.floor(corridor.length / 2)];
    const c = window.C.Cartographic.fromDegrees(point.lon, point.lat);
    window.v.camera.cancelFlight();
    window.v.camera.setView({ destination: window.C.Cartesian3.fromRadians(c.longitude, c.latitude, 900),
      orientation: { heading: 0, pitch: window.C.Math.toRadians(-90), roll: 0 } });
    for (let i = 0; i < 90; i++) { window.v.scene.requestRender(); await new Promise(r => requestAnimationFrame(r)); }
    const pixel = window.C.SceneTransforms.worldToWindowCoordinates(window.v.scene, window.C.Cartesian3.fromDegrees(point.lon, point.lat));
    return { x: Math.round(pixel.x), y: Math.round(pixel.y) };
  });
  const beforeDrop = await page.evaluate(() => window.cam());
  await page.mouse.click(drop.x, drop.y);
  await page.locator('.street-view[data-state="active"]').waitFor({ timeout: 45000 });
  await page.waitForTimeout(2000);
  assert.equal(await page.evaluate(() => window.place.active), false, 'placement ends when a panorama opens');
  assert.equal(await overlay(), 0, 'the placement overlay is cleared when the panorama opens');
  // The heading comes from the corridor's own geometry, not a constant.
  const facingOnEntry = await page.evaluate(() => Math.round(window.C.Math.toDegrees(window.v.camera.heading)));
  assert.ok(facingOnEntry > 45 && facingOnEntry < 135,
    `a drop on the corridor should face along it, got ${facingOnEntry}°`);
  assert.match(await page.locator('.street-view-context').textContent(), /I-595/);
  await page.screenshot({ path: '/tmp/i595-street-view-placement.png' });

  await page.locator('.street-view-return').click();
  await page.waitForTimeout(1200);
  assertSameView(await page.evaluate(() => window.cam()), beforeDrop, 'a dropped panorama returns to the drop view');

  // A location with no imagery keeps placement alive so the next click can be elsewhere.
  await page.locator('#street-view').click();
  await page.waitForTimeout(300);
  await page.evaluate(() => window.place.stop());

  // ---- the CCTV popup keeps its shortcut ---------------------------------------------------------
  await openExplorer(page);
  await page.locator('.quick-rail [data-layer="cameras"]').click();
  await page.waitForTimeout(2500);
  await revealLayerGroup(page, '.cameras-mainline-group');
  await page.locator('.cameras-mainline-group > summary').click({ position: { x: 5, y: 10 } });
  const id = await page.evaluate(() => [...window.cams.cameraById.keys()][0]);
  await page.locator(`button[data-camera-id="${id}"]`).click();
  await page.locator('.camera-details:not([hidden])').waitFor({ timeout: 20000 });
  await page.waitForTimeout(2500);

  // Street View sits alongside the camera's own details; it does not replace them.
  assert.equal(await page.locator('.camera-street-view').count(), 1, 'the camera popup offers Street View');
  assert.ok((await page.locator('.camera-details').innerText()).includes('Camera ID'), 'the camera details remain');

  const twinBefore = await page.evaluate(() => window.cam());
  const sceneBefore = await page.evaluate(() => window.scene());
  await page.locator('.camera-street-view').click();
  await page.locator('.street-view[data-state="active"]').waitFor({ timeout: 45000 });
  await page.waitForTimeout(2500);

  // ---- an interactive panorama, not a picture ----------------------------------------------------
  const inside = await page.evaluate(() => ({ ...window.scene(), mode: window.sv.mode }));
  assert.equal(inside.mode, 'street-view');
  assert.equal(inside.panoramas, 1, 'the panorama is a primitive in the existing scene');
  assert.equal(inside.look, true, 'looking around is enabled');
  assert.equal(inside.rotate, false, 'globe rotation is not what a panorama needs');
  assert.equal(inside.tilesetShown, false, 'the tileset would otherwise draw in front of the panorama');
  const facing = (await page.evaluate(() => window.cam())).heading;
  await page.mouse.move(800, 450);
  await page.mouse.down();
  await page.mouse.move(480, 450, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(600);
  assert.notEqual((await page.evaluate(() => window.cam())).heading, facing, 'dragging must look around');

  // ---- honest labelling, and the attribution Google requires -------------------------------------
  const bar = await page.locator('.street-view-bar').innerText();
  assert.match(bar, /Street View imagery: [A-Z][a-z]{2} \d{4}/, 'the imagery date is stated');
  assert.ok(!/\blive\b/i.test(bar), 'Street View is never labelled live');
  assert.match(bar, /Return to Digital Twin/);
  assert.equal(await page.locator('.cesium-widget-credits').isVisible(), true, 'Google’s attribution stays on screen');
  // The twin's own panels get out of the way rather than sitting over the panorama.
  for (const panel of ['.layers', '.map-nav', '.corridor-status', '.camera-details']) {
    assert.equal(await page.locator(panel).isVisible(), false, `${panel} must not overlay the panorama`);
  }
  await page.screenshot({ path: '/tmp/i595-street-view.png' });

  // ---- returning puts everything back exactly ----------------------------------------------------
  await page.locator('.street-view-return').click();
  await page.waitForTimeout(1200);
  assertSameView(await page.evaluate(() => window.cam()), twinBefore, 'the camera returns to where it left');
  const sceneAfter = await page.evaluate(() => window.scene());
  assert.equal(sceneAfter.panoramas, 0, 'the panorama is removed');
  assert.equal(sceneAfter.tilesetShown, sceneBefore.tilesetShown, 'the 3D tileset is restored');
  assert.equal(sceneAfter.dataSourcesShown, sceneBefore.dataSourcesShown, 'every layer is restored');
  assert.equal(sceneAfter.rotate, true, 'map navigation works again');
  assert.equal(await page.locator('#cameras-mainline').isChecked(), true, 'layer visibility is untouched');
  assert.equal(await page.evaluate(() => window.sv.mode), 'digital-twin');

  // ---- Escape closes it too ----------------------------------------------------------------------
  const place = await page.evaluate(sid => {
    const c = window.C.Cartographic.fromCartesian(window.cams.cameraById.get(sid).position.getValue(window.v.clock.currentTime));
    return { longitude: window.C.Math.toDegrees(c.longitude), latitude: window.C.Math.toDegrees(c.latitude), label: 'Escape check' };
  }, id);
  await page.evaluate(p => window.sv.enter(p), place);
  await page.locator('.street-view[data-state="active"]').waitFor({ timeout: 45000 });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.sv.mode), 'digital-twin', 'Escape returns to the twin');

  // ---- repeated trips leak nothing ---------------------------------------------------------------
  for (let trip = 0; trip < 6; trip++) {
    await page.evaluate(p => window.sv.enter(p), place);
    await page.locator('.street-view[data-state="active"]').waitFor({ timeout: 45000 });
    await page.evaluate(() => window.sv.exit());
    await page.waitForTimeout(200);
  }
  const settled = await page.evaluate(() => ({ ...window.scene(), overlays: document.querySelectorAll('.street-view').length, mode: window.sv.mode }));
  assert.equal(settled.mode, 'digital-twin');
  assert.equal(settled.panoramas, 0, 'no panorama survives a return');
  assert.equal(settled.primitives, sceneBefore.primitives, 'the scene gains no primitives across trips');
  assert.equal(settled.overlays, 1, 'one overlay, however many trips');
  assert.equal(settled.rotate, true, 'the camera controls still work after repeated trips');

  // ---- a location with no imagery is reported, and leaves the twin alone --------------------------
  const nowhere = await page.evaluate(() => window.sv.enter({ longitude: -80.42, latitude: 26.28, label: 'open water' }));
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.message, /available/i);
  assert.equal(await page.evaluate(() => window.sv.mode), 'digital-twin', 'a failed lookup must not change mode');
  assert.equal((await page.evaluate(() => window.scene())).tilesetShown, sceneBefore.tilesetShown, 'the twin is untouched by a failed lookup');
  assertSameView(await page.evaluate(() => window.cam()), twinBefore, 'and the camera has not moved');

  console.log('street view OK — toolbar placement drops on I-595 and faces along it, CCTV shortcut still works, exact return, no leaks');
} finally {
  await browser.close();
}
