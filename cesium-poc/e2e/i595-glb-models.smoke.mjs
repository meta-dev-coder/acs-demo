/**
 * Data-driven GLB placement.
 *
 * Google's tileset is stubbed, so this run needs no API key, billing or network; what is under test
 * is the pipeline — JSON → service → height sampling → position → orientation → entity — plus the
 * two things that would quietly break the map: placement must never move the camera, and a second
 * JSON record must render with no change to the loader.
 *
 * The 76 MB gantry is served from a stand-in so the run stays fast; the real file is checked
 * separately, over HTTP, for the thing that actually matters about it — that it resolves.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

/**
 * Wait for a camera flight to finish: the pose must first differ from `from`, then stop changing.
 * Settling alone is not enough — sampled the instant after a click, the camera has not moved yet.
 */
const cameraPose = page => page.evaluate(() =>
  `${v.camera.heading.toFixed(6)}|${v.camera.positionCartographic.height.toFixed(3)}`);
async function settleCamera(page, from) {
  await page.waitForFunction(previous => {
    const now = `${v.camera.heading.toFixed(6)}|${v.camera.positionCartographic.height.toFixed(3)}`;
    const moved = now !== previous;
    const settled = moved && window.__pose === now;
    window.__pose = now;
    return settled;
  }, from, { timeout: 40000, polling: 400 });
}

const MODEL_ID = 'i595-gantry-1-toll-plaza';
const MODEL_URL = '/models/i595/gantry-1-toll-plaza.glb';
const LON = -80.3168131, LAT = 26.1153108;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // ---- 1. the real GLB resolves: no 404, and it is a real glTF binary ---------------------------
  const head = await page.request.get(`http://127.0.0.1:5188${MODEL_URL}`, { headers: { Range: 'bytes=0-11' } });
  assert.ok(head.ok(), `${MODEL_URL} must resolve, got ${head.status()}`);
  assert.equal((await head.body()).toString('ascii', 0, 4), 'glTF', 'the served file is a binary glTF');

  await page.addInitScript(() => {
    window.__fakeTileset = async () => ({ show: false, update() {}, isDestroyed: () => false, destroy() {} });
  });
  await page.route('**://tile.googleapis.com/**', route => route.abort());
  // Stand-in mesh: the assertions are about where the entity is, not what it looks like.
  await page.route('**/models/i595/*.glb', async route => {
    const response = await route.fetch({ url: 'http://127.0.0.1:5188/models/car.glb' });
    await route.fulfill({ response });
  });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text())
      // Vite has already resolved the bare "cesium" specifier by the time this rewrite runs, so the
      // namespace the assertions need is widened out of the module's own import rather than
      // re-imported here.
      .replace('import { Color, GeoJsonDataSource, Cartesian3, Math as CMath, CameraEventType }',
        'import { Color, GeoJsonDataSource, Cartesian3, Math as CMath, CameraEventType, Cartographic, Transforms, HeadingPitchRoll, Quaternion }')
      .replace('viewer.animation.container', 'window.v=viewer; window.cesiumNs={Cartographic, Transforms, HeadingPitchRoll, Quaternion, Math: CMath}; window.modelMaths={medianHeight, groundSamplePoints}; viewer.animation.container')
      .replace('{ apiKey: import.meta.env.VITE_GOOGLE_MAPS_API_KEY }', "{ apiKey: 'e2e-test-key', createTileset: () => window.__fakeTileset() }")
      // Vite has already rewritten the module specifier, so only the binding list is matched here.
      .replace('import { createCesiumModelService }', 'import { createCesiumModelService, medianHeight, groundSamplePoints }')
      .replace('import.meta.hot.dispose(() => {', 'window.models=corridorModels; window.modelLayers=corridorModelLayers; window.modelConfigs=cesiumModels; import.meta.hot.dispose(() => {');
    await route.fulfill({ response, body });
  });

  const debugLogs = [];
  page.on('console', message => { if (message.text().startsWith('[Cesium Models]')) debugLogs.push(message.text()); });

  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.waitForFunction(() => window.models != null, null, { timeout: 60000 });

  // ---- 2. the camera the user is looking through is untouched by model loading ------------------
  const before = await page.evaluate(() => {
    const { longitude, latitude, height } = v.camera.positionCartographic;
    return { longitude, latitude, height };
  });
  await page.waitForFunction(id => window.models.modelById.has(id), MODEL_ID, { timeout: 60000 });
  const after = await page.evaluate(() => {
    const { longitude, latitude, height } = v.camera.positionCartographic;
    return { longitude, latitude, height };
  });
  assert.deepEqual(after, before, 'placing a model must never fly or zoom the camera');

  // ---- 3. the JSON is the source of truth -------------------------------------------------------
  const config = await page.evaluate(() => window.modelConfigs[0]);
  assert.equal(config.longitude, LON);
  assert.equal(config.latitude, LAT);
  assert.equal(config.modelUrl, MODEL_URL);
  assert.equal(config.enabled, true);

  const placed = await page.evaluate(id => {
    const { Cartographic, Math: CMath, Transforms, HeadingPitchRoll, Quaternion } = window.cesiumNs;
    const entity = window.models.modelById.get(id);
    const time = v.clock.currentTime;
    const position = entity.position.getValue(time);
    const carto = Cartographic.fromCartesian(position);
    const config = window.modelConfigs.find(record => record.id === id);
    const expected = Transforms.headingPitchRollQuaternion(position, new HeadingPitchRoll(
      CMath.toRadians(config.heading), CMath.toRadians(config.pitch), CMath.toRadians(config.roll)));
    const read = name => entity.properties[name].getValue(time);
    return {
      lon: CMath.toDegrees(carto.longitude), lat: CMath.toDegrees(carto.latitude), height: carto.height,
      scale: entity.model.scale.getValue(time),
      uri: String(entity.model.uri.getValue(time)),
      orientationMatches: Quaternion.equalsEpsilon(entity.orientation.getValue(time), expected, 1e-9),
      identityOrientation: Quaternion.equalsEpsilon(entity.orientation.getValue(time), Quaternion.IDENTITY, 1e-9),
      assetType: read('assetType'), latitude: read('latitude'), longitude: read('longitude'),
      heightOffset: read('heightOffset'), groundHeight: read('groundHeight'), heightSource: read('groundHeightSource'),
      picked: v.dataSources.getByName('Corridor Models')[0].entities.contains(entity),
    };
  }, MODEL_ID);

  // ---- 4. lon/lat are not reversed, and height is ground + offset -------------------------------
  assert.ok(Math.abs(placed.lon - LON) < 1e-7, `longitude ${placed.lon} must be ${LON}`);
  assert.ok(Math.abs(placed.lat - LAT) < 1e-7, `latitude ${placed.lat} must be ${LAT}`);
  assert.equal(placed.longitude, LON, 'the entity carries its configured longitude');
  assert.equal(placed.latitude, LAT, 'the entity carries its configured latitude');
  // Millimetre tolerance: the height is read back through a Cartesian3 round-trip, which is exact
  // only to about that at this radius.
  assert.ok(Math.abs(placed.height - (placed.groundHeight + placed.heightOffset)) < 1e-3,
    'final height is the sampled ground height plus the configured offset');
  // With Google's tiles stubbed out there is no photogrammetry to sample: the fallback must hold.
  assert.ok(['SCENE', 'GLOBE', 'ELLIPSOID'].includes(placed.heightSource), `unexpected height source ${placed.heightSource}`);

  // ---- 5. orientation and scale come from the JSON, and picking can identify the model ----------
  assert.ok(placed.orientationMatches, 'orientation is headingPitchRollQuaternion of the configured HPR');
  assert.equal(placed.identityOrientation, false, 'a configured heading actually rotates the model');
  assert.equal(placed.scale, config.scale);
  assert.ok(placed.uri.endsWith(MODEL_URL), `model uri ${placed.uri} resolves to the configured file`);
  assert.equal(placed.assetType, 'GLB_MODEL');
  assert.equal(placed.picked, true, 'the model is a real scene entity, not an HTML overlay');

  // ---- 6. every enabled record is placed, with one concise debug line each ----------------------
  const configured = await page.evaluate(() => window.modelConfigs.filter(record => record.enabled !== false).map(record => record.id));
  assert.deepEqual(await page.evaluate(() => [...window.models.modelById.keys()]), configured,
    'every enabled record in the JSON is placed');
  assert.equal(debugLogs.length, configured.length, `expected one debug line per model, got ${debugLogs.length}`);

  // ---- 7. a second JSON record renders with no change to the loader -----------------------------
  const second = await page.evaluate(async () => {
    const { Cartographic, Math: CMath } = window.cesiumNs;
    await window.models.loadModels([
      { id: 'model-002', name: 'Second', type: 'GLB_MODEL', modelUrl: '/models/i595/gantry-1-toll-plaza.glb',
        latitude: 26.116, longitude: -80.317, heightOffset: 0.5, heading: 145, pitch: 0, roll: 0, scale: 0.8, enabled: true },
      { id: 'model-003-disabled', modelUrl: '/models/i595/gantry-1-toll-plaza.glb',
        latitude: 26.117, longitude: -80.318, enabled: false },
      // Unplaceable records are rejected individually — they must not take the batch down with them.
      { id: 'model-004-no-file', latitude: 26.118, longitude: -80.319 },
      { id: 'model-005-off-globe', modelUrl: '/models/i595/gantry-1-toll-plaza.glb', latitude: 126.118, longitude: -80.319 },
    ]);
    const entity = window.models.modelById.get('model-002');
    const time = v.clock.currentTime;
    const carto = Cartographic.fromCartesian(entity.position.getValue(time));
    return {
      lon: CMath.toDegrees(carto.longitude), lat: CMath.toDegrees(carto.latitude),
      scale: entity.model.scale.getValue(time),
      offset: carto.height - entity.properties.groundHeight.getValue(time),
      ids: [...window.models.modelById.keys()],
    };
  });
  assert.ok(Math.abs(second.lon - -80.317) < 1e-7 && Math.abs(second.lat - 26.116) < 1e-7, 'the second record places at its own coordinate');
  assert.equal(second.scale, 0.8, 'scale is per-record');
  assert.ok(Math.abs(second.offset - 0.5) < 1e-3, `heightOffset is per-record, got ${second.offset}`);
  assert.deepEqual(second.ids, [...configured, 'model-002'], 'disabled and invalid records are skipped, valid ones are not');

  // ---- 8. removal, and the rest of the map is untouched -----------------------------------------
  assert.equal(await page.evaluate(() => window.models.removeModel('model-002')), true);
  assert.equal(await page.evaluate(() => window.models.modelById.has('model-002')), false);
  assert.equal(await page.evaluate(() => v.trackedEntity), undefined, 'models never take over the camera');
  for (const control of ['#reset-view', '.map-nav']) {
    assert.equal(await page.locator(control).count(), 1, `${control} must survive model loading`);
  }
  assert.equal(await page.evaluate(() => v.scene.screenSpaceCameraController.enableZoom
    && v.scene.screenSpaceCameraController.enableRotate && v.scene.screenSpaceCameraController.enableTilt), true,
    'camera controls are still enabled');

  // ---- 9. gantries and lane barriers are two layers, not one -----------------------------------
  const railTools = await page.$$eval('.quick-rail [data-layer]', nodes => nodes.map(node => node.dataset.layer));
  assert.ok(railTools.includes('gantries'), 'gantries have a quick-rail tool');
  assert.ok(railTools.includes('lane-barriers'), 'lane barriers have a quick-rail tool of their own');
  const railIcons = await page.$$eval('.quick-rail [data-layer="gantries"] svg, .quick-rail [data-layer="lane-barriers"] svg', nodes => nodes.map(node => node.innerHTML));
  assert.equal(new Set(railIcons).size, 2, 'the two layers are drawn with different icons');
  for (const control of ['#gantries-all', '#barriers-all']) {
    assert.equal(await page.locator(control).count(), 1, `${control} must exist`);
    assert.equal(await page.locator(control).isDisabled(), false, `${control} is live once its models are placed`);
  }
  const shownByLayer = () => page.evaluate(() => {
    const byLayer = {};
    for (const config of window.modelConfigs) {
      const entity = window.models.modelById.get(config.id);
      if (entity) (byLayer[config.layer] ??= []).push(entity.show);
    }
    return byLayer;
  });
  // The map opens clean — these are data layers, so they start off like every other one.
  assert.deepEqual(await shownByLayer(), { gantries: [false, false, false], 'lane-barriers': [false] },
    'no model layer may switch itself on at startup');
  // Toggling one layer must leave the other exactly as it was.
  await page.click('.quick-rail [data-layer="gantries"]');
  await page.waitForFunction(() => window.models.modelById.get('i595-gantry-1-toll-plaza').show, null, { timeout: 10000 });
  assert.deepEqual(await shownByLayer(), { gantries: [true, true, true], 'lane-barriers': [false] },
    'the gantry tool must not touch the lane barrier');
  await page.click('.quick-rail [data-layer="lane-barriers"]');
  await page.waitForFunction(() => window.models.modelById.get('i595-lane-barrier-arm-1').show, null, { timeout: 10000 });
  assert.deepEqual(await shownByLayer(), { gantries: [true, true, true], 'lane-barriers': [true] });

  // ---- 10. selecting an asset flies to it and says what it is ----------------------------------
  const heightBefore = await page.evaluate(() => v.camera.positionCartographic.height);
  await page.evaluate(() => { window.__pose = null; });
  await page.evaluate(() => window.modelLayers.select(window.models.modelById.get('i595-gantry-3-toll-lane')));
  await page.waitForFunction(h => v.camera.positionCartographic.height < h / 2, heightBefore, { timeout: 30000 });
  await settleCamera(page, null);
  const details = await page.locator('.model-details:not([hidden])').innerText();
  assert.ok(details.includes('i595-gantry-3-toll-lane'), 'the details panel names the selected asset');
  assert.ok(details.includes('Toll Gantries'), 'the details panel names its layer');
  // The camera must face the gantry's front, not simply point north: a structure that spans the
  // road is edge-on from the north, which is what the fixed heading used to give.
  const view = await page.evaluate(() => {
    const toDeg = r => (r * 180 / Math.PI + 360) % 360;
    const model = window.modelConfigs.find(record => record.id === 'i595-gantry-3-toll-lane');
    return { camera: toDeg(v.camera.heading), expected: (model.heading + 270) % 360 };
  });
  const apart = Math.abs(((view.camera - view.expected + 540) % 360) - 180);
  assert.ok(apart < 2, `camera heading ${view.camera.toFixed(1)}° must face the gantry (${view.expected.toFixed(1)}°)`);
  assert.ok(Math.min(view.camera, 360 - view.camera) > 10, 'the focus camera is no longer locked to north');
  // The asset lands in the map area the explorer and the details panel leave clear.
  const where = await page.evaluate(() => {
    const point = v.scene.cartesianToCanvasCoordinates(
      window.models.modelById.get('i595-gantry-3-toll-lane').position.getValue(v.clock.currentTime));
    return point ? { x: point.x, y: point.y, width: v.canvas.clientWidth, height: v.canvas.clientHeight } : null;
  });
  assert.ok(where, 'the focused asset is on screen');
  assert.ok(where.y > where.height * 0.25 && where.y < where.height * 0.75,
    `the focused asset must be framed, not at an edge (y=${Math.round(where.y)} of ${where.height})`);

  // A record may state its own view direction — a gantry whose signage hangs on the other face.
  const overridden = await page.evaluate(() => window.modelConfigs.find(record => Number.isFinite(record.viewHeading)));
  if (overridden) {
    const fromPose = await cameraPose(page);
    await page.evaluate(id => window.modelLayers.select(window.models.modelById.get(id)), overridden.id);
    await settleCamera(page, fromPose);
    const actual = await page.evaluate(() => (v.camera.heading * 180 / Math.PI + 360) % 360);
    const off = Math.abs(((actual - overridden.viewHeading + 540) % 360) - 180);
    assert.ok(off < 2, `${overridden.id}: viewHeading ${overridden.viewHeading}° must win over the derived default, got ${actual.toFixed(1)}°`);
  }


  // ---- 11. a model sits on the ground, not on what happens to be above it --------------------
  // Photogrammetry contains real sign gantries and mast arms. A single downward ray through one
  // reports the structure as "ground" and leaves the model hanging in the air — which is exactly
  // what happened to two gantries. The ring of samples must outvote that ray.
  const maths = await page.evaluate(() => {
    const { medianHeight, groundSamplePoints } = window.modelMaths;
    const points = groundSamplePoints(-80.334469, 26.118724);
    const toDeg = r => r * 180 / Math.PI;
    return {
      count: points.length,
      centreLon: toDeg(points[0].longitude), centreLat: toDeg(points[0].latitude),
      // A road at -22 with a few rays up on a structure at -11 must still read as the road.
      outvoted: medianHeight([-22.1, -22.0, -21.9, -22.2, -11.4, -11.2]),
      empty: medianHeight([Number.NaN, undefined]),
    };
  });
  assert.equal(maths.count, 17, 'the point itself plus two rings of eight');
  assert.ok(Math.abs(maths.centreLon - -80.334469) < 1e-9 && Math.abs(maths.centreLat - 26.118724) < 1e-9,
    'the first sample is the model’s own point');
  assert.ok(maths.outvoted < -21, `a minority of overhead rays must not lift the ground, got ${maths.outvoted}`);
  assert.equal(maths.empty, null, 'no usable sample yields no height, not a wrong one');

  // End to end, against the real placement path: a spike on the centre ray only.
  const seated = await page.evaluate(async () => {
    const scene = v.scene;
    Object.defineProperty(scene, 'sampleHeightSupported', { value: true, configurable: true });
    const original = scene.sampleHeightMostDetailed;
    // Centre ray lands on a structure 11 m up; every ring ray lands on the road.
    scene.sampleHeightMostDetailed = async points => {
      points.forEach((point, index) => { point.height = index === 0 ? -11 : -22; });
      return points;
    };
    try {
      const entity = await window.models.addModel({
        id: 'seating-probe', name: 'Seating probe', layer: 'gantries',
        modelUrl: '/models/i595/gantry-3-toll-lane.glb',
        latitude: 26.118724, longitude: -80.334469, heightOffset: 0, heading: 0, scale: 1, enabled: true,
      });
      const height = entity.properties.groundHeight.getValue(v.clock.currentTime);
      window.models.removeModel('seating-probe');
      return height;
    } finally {
      scene.sampleHeightMostDetailed = original;
    }
  });
  assert.equal(seated, -22, `the model must sit on the road (-22), not on the structure above it (got ${seated})`);

  console.log('i595-glb-models.smoke: PASS');
} finally {
  await browser.close();
}
