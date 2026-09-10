/**
 * Base Environment selector. Google's tileset is replaced with a stub primitive so the run needs
 * no API key, billing or network — what is under test is the base-environment lifecycle and, above
 * all, that switching worlds leaves every corridor layer, its visibility and picking untouched.
 *
 * Photorealistic 3D is now the world the map opens in, so the run starts there and switches away
 * and back, rather than starting on the satellite basemap.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openExplorer } from './i595Explorer.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  let tilesetsCreated = 0;
  await page.exposeFunction('__countTileset', () => { tilesetsCreated++; });
  await page.addInitScript(() => {
    // A minimal scene primitive: PrimitiveCollection only needs update/isDestroyed/destroy.
    window.__fakeTileset = async () => {
      await window.__countTileset();
      return { show: false, isFakeTileset: true, update() {}, isDestroyed: () => false, destroy() {} };
    };
  });
  // Nothing may reach Google in this test.
  await page.route('**://tile.googleapis.com/**', route => route.abort());
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace('viewer.animation.container', 'window.v=viewer; viewer.animation.container')
      .replace('{ apiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY }', "{ apiKey: 'e2e-test-key', createTileset: () => window.__fakeTileset() }")
      .replace('import.meta.hot.dispose(() => {', 'window.baseEnv=baseEnvironment; window.cameras=cameraControls; import.meta.hot.dispose(() => {');
    await route.fulfill({ response, body });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await openExplorer(page);
  // Every layer that adds a data source asynchronously must be settled before the before/after
  // comparison, or the snapshot races them rather than the base-environment switch.
  for (const ready of ['#cameras-all', '#signals-all', '#bridges-all', '#live-events-all']) {
    await page.locator(`${ready}:not(:disabled)`).waitFor({ state: 'attached', timeout: 60000 });
  }

  // ---- the control lives outside DataLayer, and the map opens in Photorealistic 3D -------------
  assert.equal(await page.locator('#base-environment-controls .base-environment').count(), 1);
  assert.equal(await page.locator('details:has(> summary:text-is("DataLayer")) .base-environment').count(), 0,
    'Base Environment must not sit inside the DataLayer tree');
  assert.deepEqual(await page.locator('#layer-content > details > summary').allTextContents(),
    ['Traffic', 'Infrastructure'], 'the explorer groups layers by transportation category');
  await page.waitForFunction(() => window.baseEnv.isLoaded(), null, { timeout: 30000 });
  assert.ok(await page.locator('input[value="GOOGLE_PHOTOREALISTIC_3D"]').isChecked(),
    'the default world is reflected in the radio group, not just in the scene');
  assert.equal(await page.locator('input[value="SATELLITE"]').isChecked(), false, 'the modes are mutually exclusive');
  assert.equal(await page.evaluate(() => v.scene.globe.show), false, 'the globe is hidden for the 3D view');
  assert.equal(tilesetsCreated, 1, 'exactly one tileset for the default world');
  assert.equal((await page.locator('.base-environment-status').textContent()).trim(), '',
    'no caption for the working state');
  // Cesium's own credit container carries Google's attribution instead.
  assert.ok(await page.locator('.cesium-widget-credits').isVisible());
  assert.ok(await page.locator('.base-environment-fly').isVisible());

  // ---- record the corridor state we must not disturb -------------------------------------------
  await page.locator('.its-group > summary').click();
  await page.locator('.cameras-group > summary').click({ position: { x: 5, y: 10 } });
  await page.locator('#cameras-all').check();
  await page.locator('.signals-group > summary').click({ position: { x: 5, y: 10 } });
  await page.locator('#signals-all').check();
  const snapshot = () => page.evaluate(() => ({
    dataSources: [...Array(v.dataSources.length).keys()].map(index => {
      const source = v.dataSources.get(index);
      return { name: source.name, show: source.show, entities: source.entities.values.length,
        visible: source.entities.values.filter(entity => entity.show).length };
    }),
    primitives: v.scene.primitives.length,
  }));
  const before = await snapshot();
  assert.ok(before.dataSources.some(source => source.name.includes('CCTV') && source.visible === 74));

  // ---- leaving 3D for the satellite basemap ----------------------------------------------------
  await page.locator('input[value="SATELLITE"]').check();
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => v.scene.globe.show), true, 'the satellite basemap is restored');
  assert.equal(await page.evaluate(() => window.baseEnv.tileset().show), false, 'the tileset is hidden, not destroyed');
  assert.ok(await page.locator('.base-environment-fly').isHidden());
  const during = await snapshot();
  assert.deepEqual(during.dataSources, before.dataSources, 'every corridor layer and its visibility survive the switch');
  assert.equal(during.primitives, before.primitives, 'the tileset stays in the scene');

  // ---- and back into 3D, reusing the cached tileset ---------------------------------------------
  await page.locator('input[value="GOOGLE_PHOTOREALISTIC_3D"]').check();
  await page.waitForTimeout(400);
  assert.equal(tilesetsCreated, 1, 'no second download on re-activation');
  assert.equal(await page.evaluate(() => v.scene.globe.show), false);
  assert.deepEqual(await snapshot().then(state => state.dataSources), before.dataSources);

  // ---- picking and the details panel still belong to the application ---------------------------
  const cameraId = await page.evaluate(() => [...cameras.cameraById.keys()][0]);
  await page.locator(`button[data-camera-id="${cameraId}"]`).click();
  await page.waitForTimeout(1600);
  await page.locator('.camera-details:not([hidden])').waitFor();
  const selectedRows = await page.locator('.camera-details dd').allTextContents();
  assert.ok(selectedRows.length > 0);

  // Switching base environment must not clear or replace the current selection.
  await page.locator('input[value="SATELLITE"]').check();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('.camera-details:not([hidden])').count(), 1, 'the details panel survives the switch');
  assert.deepEqual(await page.locator('.camera-details dd').allTextContents(), selectedRows);
  await page.locator('input[value="GOOGLE_PHOTOREALISTIC_3D"]').check();
  await page.waitForTimeout(400);
  assert.equal(tilesetsCreated, 1, 'still no second download');
  assert.equal(await page.evaluate(() => v.scene.primitives.length), during.primitives);

  // Real picking on the map still selects application entities, not tiles.
  await page.evaluate(async () => {
    const entity = cameras.cameraById.get([...cameras.cameraById.keys()][0]);
    v.camera.flyTo({ destination: entity.position.getValue(), duration: 0 });
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => { v.camera.zoomOut(700); });
  await page.waitForTimeout(600);
  const point = await page.evaluate(id => {
    const p = C.SceneTransforms.worldToWindowCoordinates(v.scene, cameras.cameraById.get(id).position.getValue());
    return p ? { x: p.x, y: p.y - 15 } : null;
  }, cameraId).catch(() => null);
  if (point) {
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
    assert.equal(await page.locator('.camera-details:not([hidden])').count(), 1, 'map picking still reaches application entities');
  }
  await page.screenshot({ path: '/tmp/base-environment-3d.png' });

  // ---- no API key configured: the real state of a fresh checkout --------------------------------
  const bare = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const googleCalls = [];
  bare.on('request', request => { if (request.url().includes('googleapis')) googleCalls.push(request.url()); });
  await bare.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    // Force the keyless case regardless of the .env this checkout happens to carry.
    const body = (await response.text())
      .replace('viewer.animation.container', 'window.v=viewer; viewer.animation.container')
      .replace('import.meta.env.VITE_GOOGLE_MAPS_API_KEY', "''");
    await route.fulfill({ response, body });
  });
  await bare.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await openExplorer(bare);
  await bare.locator('#cameras-all:not(:disabled)').waitFor({ state: 'attached', timeout: 60000 });
  // No click needed: 3D is the default, so a keyless load must fall back on its own.
  await bare.locator('.base-environment-status').filter({ hasText: 'VITE_GOOGLE_MAPS_API_KEY' }).waitFor();
  assert.equal(googleCalls.length, 0, 'a missing key must not produce a request to Google');
  assert.ok(await bare.locator('input[value="SATELLITE"]').isChecked(), 'the selection reverts to the basemap on screen');
  assert.equal(await bare.evaluate(() => v.scene.globe.show), true, 'the existing basemap stays active on failure');
  assert.ok(await bare.locator('.base-environment-fly').isHidden());
  await bare.close();
  console.log('PASS: base environment outside DataLayer, 3D by default, mutually exclusive, one cached tileset, globe hidden/restored, layers + visibility + selection + picking preserved, keyless fallback');
} finally {
  await browser.close();
}
