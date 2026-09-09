/**
 * Startup camera + I-595 route shields.
 *
 * Covers the things that could regress silently: the app opens north-up on the I-75 / Sawgrass
 * interchange at the western beginning of the corridor (not the old county-wide overview), Reset
 * view still returns the full corridor, and the shields — including with Google's photorealistic
 * base active — stay visible, shrink with distance and are completely transparent to picking.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { corridorOverview, heroView } from '../src/i595CorridorViews.js';
import { shieldPlacements } from '../src/i595ShieldData.js';
import { openExplorer } from './i595Explorer.mjs';

const corridor = JSON.parse(readFileSync(new URL('../config/corridorCenterline.json', import.meta.url)));
const placements = shieldPlacements(corridor);
const hero = heroView(corridor), overview = corridorOverview(corridor);
const DETAIL_PANELS = ['.ramp-details', '.road-details', '.segment-details', '.bridge-details', '.signal-details', '.camera-details', '.live-event-details'];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.addInitScript(() => {
    window.__fakeTileset = async () => ({ show: false, isFakeTileset: true, update() {}, isDestroyed: () => false, destroy() {} });
  });
  await page.route('**://tile.googleapis.com/**', route => route.abort());
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace('viewer.animation.container', 'window.v = viewer; viewer.animation.container')
      .replace('{ apiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY }', "{ apiKey: 'e2e-test-key', createTileset: () => window.__fakeTileset() }")
      .replace('if (import.meta.hot)', 'window.shields = roadShields; window.baseEnv = baseEnvironment; window.mainline = mainlineSegments; if (import.meta.hot)');
    await route.fulfill({ response, body });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await openExplorer(page);
  for (const ready of ['#cameras-all', '#signals-all', '#bridges-all', '#live-events-all']) {
    await page.locator(`${ready}:not(:disabled)`).waitFor({ state: 'attached', timeout: 60000 });
  }
  await page.evaluate(async () => {
    const text = await (await fetch('/src/i595Demo.js')).text();
    window.C = await import(text.match(/from\s*"([^"]*cesium[^"]*)"/)[1]);
    window.corridor = await (await fetch('/config/corridorCenterline.json')).json();
    window.camera = () => {
      const c = window.C.Cartographic.fromCartesian(window.v.camera.position);
      const deg = window.C.Math.toDegrees;
      return { lon: deg(c.longitude), lat: deg(c.latitude), height: c.height, heading: deg(window.v.camera.heading), pitch: deg(window.v.camera.pitch) };
    };
    // Ground primitives are built asynchronously; render until the scene has caught up.
    window.settle = async (frames = 60) => {
      for (let i = 0; i < frames; i++) {
        window.v.scene.requestRender();
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    };
    await window.shields.ready;
  });

  // ---- 1. the app opens at the western beginning of I-595, not the corridor overview -----------
  const start = await page.evaluate(() => window.camera());
  assert.ok(Math.abs(start.lon - hero.lon) < 0.002 && Math.abs(start.lat - hero.lat) < 0.002, `startup at ${start.lon},${start.lat}`);
  assert.ok(start.height > 700 && start.height < 1400, `startup height ${start.height}`);
  assert.ok(start.pitch > -28 && start.pitch < -20, `the hero view must be oblique, got pitch ${start.pitch}`);
  assert.ok(Math.abs(start.heading - hero.headingDeg) < 1, `startup heading ${start.heading}`);
  // Close enough to read individual structures: the corridor cannot fit on screen at this altitude.
  assert.ok(start.height < overview.height / 10);

  // The hero view is built around the I-75 / Sawgrass interchange, and its shield is in frame.
  const framed = await page.evaluate(() => [...window.shields.shieldById.values()]
    .map(shield => {
      const pixel = window.C.SceneTransforms.worldToWindowCoordinates(window.v.scene, shield.position.getValue(window.v.clock.currentTime));
      return pixel && pixel.x >= 0 && pixel.y >= 0 && pixel.x <= window.v.canvas.clientWidth && pixel.y <= window.v.canvas.clientHeight
        ? shield.id : null;
    }).filter(Boolean));
  assert.ok(framed.includes('i595-shield-i75-sawgrass'), `the hero interchange shield must be in frame, saw ${framed.join(', ')}`);

  // I-595 crosses the frame rather than pointing straight up it: the corridor's own vertices in
  // view must move further horizontally than vertically.
  const onScreen = await page.evaluate(() => window.corridor
    .map(p => {
      const pixel = window.C.SceneTransforms.worldToWindowCoordinates(window.v.scene, window.C.Cartesian3.fromDegrees(p.lon, p.lat));
      return pixel && pixel.x >= 0 && pixel.x <= window.v.canvas.clientWidth && pixel.y >= 0 && pixel.y <= window.v.canvas.clientHeight
        ? { x: pixel.x, y: pixel.y } : null;
    })
    .filter(Boolean));
  assert.ok(onScreen.length > 5, 'the corridor must be on screen at startup');
  const spanX = Math.max(...onScreen.map(p => p.x)) - Math.min(...onScreen.map(p => p.x));
  const spanY = Math.max(...onScreen.map(p => p.y)) - Math.min(...onScreen.map(p => p.y));
  // Diagonally into the distance, not straight up the middle: an oblique view gives the corridor
  // vertical extent too, so what matters is that it still crosses the frame rather than climbing it.
  assert.ok(spanX > spanY, `I-595 must cross the frame, got ${Math.round(spanX)}x${Math.round(spanY)} px`);
  // West is on the left: the western-most vertex draws left of the eastern-most.
  assert.ok(onScreen[0].x < onScreen.at(-1).x, 'west must be on the left of the screen');

  // Photorealistic 3D is the app's default world, but this run stubs the tileset so it needs no
  // Google key — and a stub draws no surface for clamped ground geometry to classify onto. Do the
  // map work on the satellite basemap, then switch the stub on again for the 3D checks in part 6.
  await page.evaluate(() => window.baseEnv.disable());
  await page.waitForTimeout(500);
  await page.screenshot({ path: '/tmp/i595-startup-western.png' });

  // ---- 2. Reset view still shows the full corridor ---------------------------------------------
  await page.locator('#reset-view').click();
  await page.waitForTimeout(2000);
  const reset = await page.evaluate(() => window.camera());
  assert.ok(Math.abs(reset.lon - overview.lon) < 0.002 && Math.abs(reset.lat - overview.lat) < 0.002, `reset at ${reset.lon},${reset.lat}`);
  assert.ok(Math.abs(reset.height - overview.height) < 500, `reset height ${reset.height}`);
  assert.ok(reset.pitch < -85, `reset pitch ${reset.pitch}`);
  await page.screenshot({ path: '/tmp/i595-reset-corridor.png' });

  // ---- 3. shields: count, geometry-derived positions, depth behaviour, distance scaling ---------
  const shields = await page.evaluate(() => [...window.shields.shieldById.values()].map(e => {
    const c = window.C.Cartographic.fromCartesian(e.position.getValue(window.v.clock.currentTime));
    const b = e.billboard, now = window.v.clock.currentTime;
    return {
      id: e.id, lon: window.C.Math.toDegrees(c.longitude), lat: window.C.Math.toDegrees(c.latitude),
      assetType: e.properties.assetType.getValue(now), uiOnly: e.properties.uiOnly.getValue(now),
      image: b.image.getValue(now), show: e.isShowing,
      verticalOrigin: b.verticalOrigin.getValue(now), horizontalOrigin: b.horizontalOrigin.getValue(now),
      disableDepthTestDistance: b.disableDepthTestDistance.getValue(now),
      heightReference: b.heightReference.getValue(now), scaleByDistance: b.scaleByDistance.getValue(now),
    };
  }));
  assert.equal(shields.length, placements.length);
  assert.ok(shields.length >= 5 && shields.length <= 7);
  for (const placement of placements) {
    const shield = shields.find(s => s.id === placement.id);
    assert.ok(shield, `missing shield ${placement.id}`);
    assert.ok(Math.abs(shield.lon - placement.lon) < 1e-6 && Math.abs(shield.lat - placement.lat) < 1e-6);
    assert.equal(shield.assetType, 'ROAD_SHIELD');
    assert.equal(shield.uiOnly, true);
    assert.equal(shield.show, true);
    // A local Interstate shield asset — not a pin, not a hotlinked provider icon.
    assert.equal(shield.image, '/icons/interstate-595.svg');
    assert.equal(shield.verticalOrigin, 0, 'VerticalOrigin.CENTER: a map label, not a dropped pin');
    assert.equal(shield.horizontalOrigin, 0, 'HorizontalOrigin.CENTER');
    assert.equal(shield.disableDepthTestDistance, Number.POSITIVE_INFINITY, 'must survive photogrammetry occlusion');
    assert.ok(shield.scaleByDistance.farValue < shield.scaleByDistance.nearValue, 'shields must shrink with distance');
  }
  assert.equal(await page.evaluate(() => [...window.shields.shieldById.values()].every(e => e.position.getValue(window.v.clock.currentTime) && e.billboard.heightReference.getValue(window.v.clock.currentTime) === window.C.HeightReference.CLAMP_TO_GROUND)), true);
  // No textual "I-595" label entity next to the icons.
  assert.equal(await page.evaluate(() => [...window.shields.shieldById.values()].filter(e => e.label).length), 0);
  await page.screenshot({ path: '/tmp/i595-shields-corridor.png' });

  // ---- 4. shields never intercept a pick, and existing picking still works --------------------
  // With no data layer under it, clicking a shield must select nothing at all: it is not an asset.
  await page.evaluate(async () => {
    const shield = [...window.shields.shieldById.values()][3];
    const c = window.C.Cartographic.fromCartesian(shield.position.getValue(window.v.clock.currentTime));
    window.v.camera.cancelFlight();
    window.v.camera.setView({
      destination: window.C.Cartesian3.fromRadians(c.longitude, c.latitude, 900),
      orientation: { heading: 0, pitch: window.C.Math.toRadians(-90), roll: 0 },
    });
    await window.settle();
  });
  await page.mouse.click(700, 430);
  await page.waitForTimeout(400);
  for (const panel of DETAIL_PANELS) {
    assert.equal(await page.locator(`${panel}:not([hidden])`).count(), 0, `clicking a road shield opened ${panel}`);
  }

  // Turn the mainline on, so there is a real, selectable road drawn underneath the shields.
  // Clamped ground polylines build asynchronously, and the 3D tileset is streaming alongside them.
  await page.locator('#i595_mainline_eb').check();
  await page.waitForTimeout(4000);

  // A known-pickable entity is placed directly beneath a shield, so "the pick falls through the
  // shield to whatever it covers" is proven outright rather than inferred from road geometry.
  const overShield = async index => page.evaluate(async i => {
    const shield = [...window.shields.shieldById.values()][i];
    const position = shield.position.getValue(window.v.clock.currentTime);
    const cartographic = window.C.Cartographic.fromCartesian(position);
    const lon = window.C.Math.toDegrees(cartographic.longitude), lat = window.C.Math.toDegrees(cartographic.latitude);
    const probes = new window.C.CustomDataSource('e2e-probe');
    probes.entities.add({
      id: 'e2e-under-shield',
      rectangle: {
        coordinates: window.C.Rectangle.fromDegrees(lon - 0.003, lat - 0.003, lon + 0.003, lat + 0.003),
        height: 0, material: window.C.Color.RED.withAlpha(0.6),
      },
    });
    await window.v.dataSources.add(probes);
    window.v.camera.cancelFlight();
    // Straight down on the shield: the billboard is drawn over the probe it covers.
    window.v.camera.setView({
      destination: window.C.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 900),
      orientation: { heading: 0, pitch: window.C.Math.toRadians(-90), roll: 0 },
    });
    await window.settle();
    const screen = window.C.SceneTransforms.worldToWindowCoordinates(window.v.scene, position);
    const isShield = id => window.shields.shieldById.has(id?.id);
    // The unpatched Scene.prototype.pick reports what is really topmost on screen; the app's
    // scene.pick is the shield module's filtered one. Comparing the two is the whole test.
    const rawPick = Object.getPrototypeOf(window.v.scene).pick;
    const samples = [];
    // Sample inside the icon's footprint: it is centred on the anchor pixel.
    for (const dy of [-8, 0, 8]) for (const dx of [-8, 0, 8]) {
      const point = new window.C.Cartesian2(Math.round(screen.x + dx), Math.round(screen.y + dy));
      samples.push({
        dx, dy,
        drawnShield: isShield(rawPick.call(window.v.scene, point)?.id),
        pickedShield: isShield(window.v.scene.pick(point)?.id),
        pickedId: window.v.scene.pick(point)?.id?.id ?? null,
        drilledShields: window.v.scene.drillPick(point).filter(hit => isShield(hit?.id)).length,
        drilledProbe: window.v.scene.drillPick(point).some(hit => hit?.id?.id === 'e2e-under-shield'),
      });
    }
    window.v.dataSources.remove(probes, true);
    return { shieldId: shield.id, samples };
  }, index);

  for (const index of [0, 3, 6]) {
    const { shieldId, samples } = await overShield(index);
    // The shield really is drawn over the probe — otherwise the rest of this proves nothing.
    assert.ok(samples.every(s => s.drawnShield), `${shieldId}: the shield was not drawn on the sampled pixels`);
    assert.ok(samples.every(s => s.pickedShield === false), `${shieldId}: scene.pick returned a road shield`);
    assert.ok(samples.every(s => s.drilledShields === 0), `${shieldId}: drillPick returned a road shield`);
    // Every pixel the shield is drawn on still picks the entity underneath it.
    assert.ok(samples.every(s => s.pickedId === 'e2e-under-shield'), `${shieldId}: pick did not fall through the shield`);
    assert.ok(samples.every(s => s.drilledProbe), `${shieldId}: drillPick lost the entity under the shield`);
  }

  // Existing picking is unchanged: a visible mainline segment still picks at its own location.
  // Clamped ground polylines classify onto the photorealistic tileset, so they only become
  // pickable once the tiles under them have streamed in — poll rather than guess a fixed wait.
  const findSegment = () => page.evaluate(async () => {
    const entity = [...window.mainline.segmentById.values()].find(e => e.show);
    const points = entity.polyline.positions.getValue(window.v.clock.currentTime);
    const position = points[Math.floor(points.length / 2)];
    const cartographic = window.C.Cartographic.fromCartesian(position);
    window.v.camera.cancelFlight();
    window.v.camera.setView({
      destination: window.C.Cartesian3.fromRadians(cartographic.longitude, cartographic.latitude, 600),
      orientation: { heading: 0, pitch: window.C.Math.toRadians(-90), roll: 0 },
    });
    await window.settle(60);
    const screen = window.C.SceneTransforms.worldToWindowCoordinates(window.v.scene, position);
    for (let radius = 0; radius <= 10; radius++) {
      for (const [dx, dy] of [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius]]) {
        const point = new window.C.Cartesian2(Math.round(screen.x + dx), Math.round(screen.y + dy));
        const picked = window.v.scene.pick(point);
        if (window.mainline.segmentById.has(picked?.id?.id)) return { id: picked.id.id, x: point.x, y: point.y };
      }
    }
    return null;
  });
  let segmentPick = null;
  for (const deadline = Date.now() + 40000; !segmentPick && Date.now() < deadline;) segmentPick = await findSegment();
  assert.ok(segmentPick, 'an FDOT mainline segment must still be pickable on the map');

  // ---- 5. a real mouse click still drives the existing details panel ---------------------------
  // Section 4 proved the hit test falls through a shield; this drives the actual handler chain.
  await page.mouse.click(segmentPick.x, segmentPick.y);
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.segment-details:not([hidden])').count(), 1,
    'clicking a mainline segment must still open the segment details panel');
  assert.equal(await page.locator('.segment-details h2').textContent(), 'Road Segment Details');
  await page.evaluate(() => window.mainline.clearSelection());
  assert.equal(await page.locator('.segment-details:not([hidden])').count(), 0);

  // ---- 6. shields stay with Google Photorealistic 3D active -------------------------------------
  await page.evaluate(() => window.baseEnv.enable());
  await page.waitForTimeout(600);
  assert.equal(await page.evaluate(() => window.v.scene.globe.show), false, 'photorealistic base is active');
  assert.equal(await page.evaluate(() => window.shields.visible && [...window.shields.shieldById.values()].every(e => e.isShowing)), true,
    'shields must remain visible over photogrammetry');
  assert.equal(await page.evaluate(() => [...window.shields.shieldById.values()]
    .every(e => e.billboard.disableDepthTestDistance.getValue(window.v.clock.currentTime) === Number.POSITIVE_INFINITY)), true);
  await page.screenshot({ path: '/tmp/i595-shields-google3d.png' });
  await page.evaluate(() => window.baseEnv.disable());

  console.log(`road shields OK — ${shields.length} shields, startup ${start.lon.toFixed(4)},${start.lat.toFixed(4)} @ ${Math.round(start.height)} m`);
} finally {
  await browser.close();
}
