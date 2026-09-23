/**
 * Clipping Polygon Editor and the saved polygons it produces.
 *
 * Two things matter beyond the drawing mechanics. A preview must never disturb the polygons already
 * saved in cesiumModels.json — an editor that silently unclips the other gantries while you work on
 * this one is worse than no editor. And the tool is development-only: a normal load must not carry
 * it, and must still apply whatever the configuration already saved.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openLayers } from './i595Explorer.mjs';

const SAVED = [
  { id: 'saved-a', name: 'Saved A', photorealisticReplacement: { enabled: true,
      clippingPolygon: [[-80.31690, 26.11535], [-80.31672, 26.11535], [-80.31672, 26.11525], [-80.31690, 26.11525]] } },
  { id: 'saved-b', name: 'Saved B', photorealisticReplacement: { enabled: true,
      clippingPolygon: [[-80.33455, 26.11878], [-80.33438, 26.11878], [-80.33438, 26.11868], [-80.33455, 26.11868]] } },
  { id: 'switched-off', photorealisticReplacement: { enabled: false,
      clippingPolygon: [[-80.3, 26.1], [-80.29, 26.1], [-80.29, 26.11]] } },
  { id: 'too-few-points', photorealisticReplacement: { enabled: true, clippingPolygon: [[-80.3, 26.1]] } },
];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text())
      .replace('viewer.animation.container', 'window.v=viewer; viewer.animation.container')
      .replace('import.meta.hot.dispose(() => {',
        'window.clip=photorealisticClipping; window.editor=clipEditor; window.models=corridorModels; window.modelConfigs=cesiumModels; import.meta.hot.dispose(() => {') });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.waitForFunction(() => window.clip != null, null, { timeout: 120000 });
  await openLayers(page);
  // Nothing can be clipped until the photorealistic tileset exists; refresh() reports when it does.
  await page.waitForFunction(() => window.clip.refresh() === true, null, { timeout: 120000 });
  // The app applies the configuration's own polygons once the base environment is up. Fixtures set
  // before that lands are silently replaced by it, so wait for it rather than race it.
  await page.waitForFunction(() => window.clip.state().appliedOnce === true, null, { timeout: 120000 });

  // ---- 1. the model list comes from the configuration, not a second hardcoded list -------------
  const editorPresent = await page.locator('.clip-editor').count() === 1;
  if (editorPresent) {
    const options = await page.$$eval('.clip-editor-select option', nodes => nodes.map(node => node.value));
    const configured = await page.evaluate(() => window.modelConfigs.map(config => config.id));
    assert.deepEqual(options, configured, 'the dropdown is the model configuration');
  }

  // ---- 2. saved polygons apply, and bad ones are reported rather than absorbed -----------------
  const applied = await page.evaluate(saved => window.clip.applySaved(saved), SAVED);
  assert.equal(applied.applied, 2, 'only the enabled, well-formed records clip');
  assert.deepEqual(applied.skipped.map(item => item.id), ['too-few-points']);
  const tilesetPolygons = () => page.evaluate(() => {
    const tileset = (window.v.scene.primitives._primitives || []).find(item => item && item.clippingPolygons);
    return tileset ? tileset.clippingPolygons.length : 0;
  });
  assert.equal(await tilesetPolygons(), 2, 'the tileset carries both saved polygons');

  // ---- 2b. the drawing overlay hides without touching the clip ---------------------------------
  if (editorPresent) {
    await page.evaluate(() => { document.querySelector('.clip-editor').open = true; });
    await page.evaluate(() => {
      for (const [longitude, latitude] of
        [[-80.31712, 26.11548], [-80.3169, 26.11548], [-80.3169, 26.11532], [-80.31712, 26.11532]]) {
        window.editor.addPoint(longitude, latitude, -20.1);
      }
    });
    await page.locator('[data-action="finish"]').click();
    await page.locator('[data-action="preview"]').click();
    await page.waitForTimeout(1200);

    const overlay = () => page.evaluate(() => {
      const drawing = window.v.dataSources.getByName('Clipping Polygon Editor')[0];
      return { show: drawing.show, entities: drawing.entities.values.length };
    });
    const clippedCount = () => page.evaluate(() => {
      const tileset = (window.v.scene.primitives._primitives || []).find(item => item && item.clippingPolygons);
      return tileset ? tileset.clippingPolygons.length : 0;
    });
    const shown = await overlay();
    assert.equal(shown.show, true);
    assert.ok(shown.entities > 0, 'the tracing marks are on screen while drawing');
    const clippingWhileDrawn = await clippedCount();

    await page.locator('[data-action="overlay"]').click();
    await page.waitForTimeout(600);
    const hidden = await overlay();
    assert.equal(hidden.show, false, 'the overlay hides');
    // The distinction that matters: hidden, not destroyed, and the clip untouched.
    assert.equal(hidden.entities, shown.entities, 'the drawing entities are kept, only made invisible');
    assert.equal(await clippedCount(), clippingWhileDrawn, 'hiding the overlay must not change the clipping');
    assert.equal((await page.evaluate(() => window.editor.state())).points, 4, 'the captured points remain');
    assert.match(await page.locator('[data-action="overlay"]').textContent(), /Show Drawing Overlay/);

    await page.locator('[data-action="overlay"]').click();
    await page.waitForTimeout(600);
    assert.deepEqual(await overlay(), shown, 'the same visualisation comes back');

    // Inspect Result: clipped, replacement shown, scaffolding hidden, camera back from Top View.
    await page.locator('[data-action="top"]').click();
    await page.waitForFunction(() => Math.round(window.v.camera.pitch * 180 / Math.PI) <= -88, null, { timeout: 30000 });
    await page.locator('[data-action="inspect"]').click();
    await page.waitForTimeout(2000);
    assert.equal((await overlay()).show, false, 'Inspect hides the scaffolding');
    assert.equal(await clippedCount(), clippingWhileDrawn, 'Inspect keeps the clip on');
    assert.equal((await page.evaluate(() => window.editor.state())).points, 4, 'Inspect changes no coordinates');
    assert.ok(Math.round(await page.evaluate(() => window.v.camera.pitch * 180 / Math.PI)) > -88,
      'Inspect restores the pre-Top-View camera');

    // Clear already switches the preview off, so Disable Preview is correctly unavailable here.
    await page.locator('[data-action="clear"]').click();
    await page.waitForTimeout(400);
    assert.equal(await page.locator('[data-action="disable"]').isDisabled(), true);
  }

  // ---- 3. a preview adds to the saved set and never replaces it --------------------------------
  await page.evaluate(() => window.clip.setPreview('being-edited',
    [[-80.33860, 26.12128], [-80.33818, 26.12126], [-80.33821, 26.12092], [-80.33859, 26.12092]]));
  let state = await page.evaluate(() => window.clip.state());
  assert.equal(state.saved.length, 2, 'previewing must not drop the saved polygons');
  assert.equal(state.preview.id, 'being-edited');
  assert.equal(await tilesetPolygons(), 3, 'saved + preview are both clipping');

  await page.evaluate(() => window.clip.clearPreview());
  state = await page.evaluate(() => window.clip.state());
  assert.equal(state.preview, null, 'the preview is gone');
  assert.deepEqual(state.saved.map(item => item.id), ['saved-a', 'saved-b'], 'every saved polygon survives');
  assert.equal(await tilesetPolygons(), 2, 'and stays applied to the tileset');

  // ---- 4. drawing: points, undo, clear, finish, and the JSON it produces ------------------------
  if (editorPresent) {
    // A quiet development tool: it opens collapsed, exactly as a user would find it.
    await page.evaluate(() => { document.querySelector('.clip-editor').open = true; });
    await page.evaluate(() => {
      const polygon = [[-80.3386, 26.12128], [-80.33818, 26.12126], [-80.33821, 26.12092], [-80.33859, 26.12092]];
      for (const [longitude, latitude] of polygon) window.editor.addPoint(longitude, latitude, -22.9);
    });
    assert.equal((await page.evaluate(() => window.editor.state())).points, 4);
    // Four markers, the closed outline, and the filled shape.
    assert.equal(await page.evaluate(() =>
      window.v.dataSources.getByName('Clipping Polygon Editor')[0].entities.values.length), 6);

    await page.locator('[data-action="undo"]').click();
    assert.equal((await page.evaluate(() => window.editor.state())).points, 3, 'undo removes one point only');

    await page.locator('[data-action="finish"]').click();
    assert.equal((await page.evaluate(() => window.editor.state())).finished, true);
    const json = await page.locator('.clip-editor-json').inputValue();
    const parsed = JSON.parse(`{${json}}`);
    assert.equal(parsed.photorealisticReplacement.enabled, true);
    assert.equal(parsed.photorealisticReplacement.clippingPolygon.length, 3);
    for (const [longitude, latitude] of parsed.photorealisticReplacement.clippingPolygon) {
      // Longitude first: the order Cartesian3.fromDegreesArray reads, and the easiest to invert.
      assert.ok(longitude < -80 && longitude > -81, `longitude ${longitude} is first`);
      assert.ok(latitude > 26 && latitude < 27, `latitude ${latitude} is second`);
    }

    await page.locator('[data-action="clear"]').click();
    assert.equal((await page.evaluate(() => window.editor.state())).points, 0);
    assert.equal(await page.evaluate(() =>
      window.v.dataSources.getByName('Clipping Polygon Editor')[0].entities.values.length), 0, 'Clear removes the drawing');
    const afterClear = await page.evaluate(() => window.clip.state());
    assert.equal(afterClear.saved.length, 2,
      `Clear must not touch the saved clipping polygons — state was ${JSON.stringify(afterClear)}`);
  }

  // ---- 4b. Top View / Restore View, and hiding just the replacement ----------------------------
  if (editorPresent) {
    const camera = () => page.evaluate(() => {
      const view = window.v.camera;
      const carto = window.v.scene.globe.ellipsoid.cartesianToCartographic(view.positionWC);
      return { height: Math.round(carto.height), pitch: Math.round(view.pitch * 180 / Math.PI),
        longitude: +(carto.longitude * 180 / Math.PI).toFixed(5), latitude: +(carto.latitude * 180 / Math.PI).toFixed(5) };
    });
    await page.locator('.clip-editor-select').selectOption('i595-gantry-2-toll-lane');
    assert.equal(await page.locator('[data-action="restore"]').isDisabled(), true,
      'there is nothing to restore until a view has been saved');

    const before = await camera();
    await page.locator('[data-action="top"]').click();
    await page.waitForFunction(() => Math.round(window.v.camera.pitch * 180 / Math.PI) <= -88, null, { timeout: 30000 });
    const top = await camera();
    assert.ok(top.pitch <= -88, `a near-vertical view, got ${top.pitch}°`);
    const config = await page.evaluate(() => window.modelConfigs.find(item => item.id === 'i595-gantry-2-toll-lane'));
    assert.ok(Math.abs(top.longitude - config.longitude) < 0.0005 && Math.abs(top.latitude - config.latitude) < 0.0005,
      'centred on the selected model’s configured position');
    // The height is derived, not fixed: it must differ from the Focus Model height.
    assert.notEqual(top.height, before.height, 'the top view works out its own distance');
    assert.equal(await page.locator('[data-action="restore"]').isDisabled(), false);

    // Hiding affects one model, leaves the rest, and deletes nothing.
    await page.click('.quick-rail [data-layer="gantries"]');
    await page.waitForFunction(() => !document.querySelector('[data-action="hide"]').disabled, null, { timeout: 15000 });
    await page.locator('[data-action="hide"]').click();
    assert.match(await page.locator('[data-action="hide"]').textContent(), /Show Replacement Model/);
    assert.equal(await page.evaluate(() => window.models.modelById.get('i595-gantry-2-toll-lane').show), false);
    assert.equal(await page.evaluate(() => [...window.models.modelById]
      .filter(([id]) => id.startsWith('i595-gantry') && id !== 'i595-gantry-2-toll-lane')
      .every(([, entity]) => entity.show === true)), true, 'the other models stay visible');
    assert.equal(await page.evaluate(() => window.models.modelById.size), 4, 'nothing is deleted');

    // Switching model must not strand the previous one invisible.
    await page.locator('.clip-editor-select').selectOption('i595-gantry-3-toll-lane');
    assert.equal(await page.evaluate(() => window.models.modelById.get('i595-gantry-2-toll-lane').show), true,
      'changing the selection restores whatever was hidden for it');

    await page.locator('[data-action="restore"]').click();
    await page.waitForFunction(pitch => Math.round(window.v.camera.pitch * 180 / Math.PI) === pitch,
      before.pitch, { timeout: 20000 });
    assert.deepEqual(await camera(), before, 'Restore View puts the camera back exactly');
    await page.click('.quick-rail [data-layer="gantries"]');
  }

  // ---- 4c. Model Placement: the same entity, moved in metres, reproducible on reload -----------
  if (editorPresent) {
    await page.locator('.clip-editor-select').selectOption('i595-gantry-1-toll-plaza');
    await page.click('.quick-rail [data-layer="gantries"]');
    await page.waitForFunction(() => window.models.modelById.get('i595-gantry-1-toll-plaza')?.show === true,
      null, { timeout: 30000 });

    // Start Placement must come alive on its own once the models are on the map — the dropdown is
    // already on Gantry 1, so nothing in the UI will be touched before this point.
    await page.waitForFunction(() => !document.querySelector('[data-place="start"]').disabled,
      null, { timeout: 30000 });
    assert.match(await page.locator('[data-place="status"]').textContent(), /Ready to place/,
      'the panel says why placement is or is not available');
    // Before placement starts only Start is live; nothing else is.
    for (const name of ['pick', 'reset', 'cancel', 'finish', 'copyPlacement', 'copyRecord']) {
      assert.equal(await page.locator(`[data-place="${name}"]`).isDisabled(), true, `${name} waits for Start`);
    }
    assert.equal(await page.locator('[data-move="north"]').isDisabled(), true);

    const before = await page.evaluate(() => window.models.modelById.size);
    await page.locator('[data-place="start"]').click();
    await page.waitForFunction(() => window.editor.placement.state().placing === true, null, { timeout: 30000 });
    assert.equal(await page.evaluate(() => window.models.modelById.size), before,
      'placement edits the loaded entity — it must not create a second model');
    // And now the editing controls are live.
    for (const name of ['pick', 'reset', 'cancel', 'finish', 'copyPlacement', 'copyRecord']) {
      assert.equal(await page.locator(`[data-place="${name}"]`).isDisabled(), false, `${name} is available while placing`);
    }
    assert.equal(await page.locator('[data-move="north"]').isDisabled(), false, 'fine movement without needing Place At Click');
    // Placement and drawing only conflict over the left click, and placement holds that
    // click solely while Place At Click is armed. Being mid-placement must not block drawing.
    assert.equal(await page.locator('[data-action="start"]').isDisabled(), false,
      'drawing stays available while a model is merely open for placement');
    await page.locator('[data-place="pick"]').click();
    await page.waitForFunction(() => window.editor.placement.state().picking === true, null, { timeout: 30000 });
    assert.equal(await page.locator('[data-action="start"]').isDisabled(), true,
      'drawing waits while Place At Click holds the click');
    assert.match(await page.locator('[data-action="start"]').getAttribute('title'), /Place At Click/,
      'the disabled button says why');
    await page.locator('[data-place="pick"]').click();
    await page.waitForFunction(() => window.editor.placement.state().picking === false, null, { timeout: 30000 });
    assert.equal(await page.locator('[data-action="start"]').isDisabled(), false,
      'cancelling Place At Click releases drawing again');

    const position = () => page.evaluate(() => {
      const point = window.models.modelById.get('i595-gantry-1-toll-plaza')
        .position.getValue(window.v.clock.currentTime);
      return [point.x, point.y, point.z];
    });
    const metresBetween = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

    // Movement is in metres through the local frame, not by nudging degrees.
    const start = await position();
    for (let step = 0; step < 4; step++) await page.locator('[data-move="north"]').click();
    await page.waitForTimeout(1500);
    const moved = metresBetween(start, await position());
    assert.ok(Math.abs(moved - 0.4) < 0.05, `4 x 0.10 m should move about 0.40 m, moved ${moved.toFixed(3)}`);

    await page.locator('[data-adjust="heading"][data-delta="10"]').click();
    await page.locator('[data-adjust="heightOffset"][data-delta="0.1"]').click();
    await page.locator('[data-adjust="scale"][data-delta="0.01"]').click();
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => window.models.modelById.get('i595-gantry-1-toll-plaza')
      .model.scale.getValue(window.v.clock.currentTime)), 1.01, 'scale reaches the model without reloading it');

    // The copied record carries the edited values and keeps everything it did not edit.
    await page.locator('[data-place="copyRecord"]').click();
    const record = JSON.parse(await page.locator('[data-place="json"]').inputValue());
    const original = await page.evaluate(() => window.modelConfigs.find(item => item.id === 'i595-gantry-1-toll-plaza'));
    assert.equal(record.modelKey, original.modelKey, 'the AWS object key survives');
    assert.equal(record.id, original.id);
    assert.equal(record.enabled, original.enabled);
    assert.ok(!('x' in record) && !('y' in record) && !('z' in record), 'no ECEF coordinates are written out');
    assert.notEqual(record.latitude, original.latitude, 'the record carries the moved position');

    // The whole point: those values must reproduce this placement on the next load. Both the editor
    // and the loader go through modelPlacement, so re-adding the record lands in the same place.
    const edited = await position();
    await page.locator('[data-place="finish"]').click();
    const reloaded = await page.evaluate(async config => {
      await window.models.addModel(config);
      const point = window.models.modelById.get(config.id).position.getValue(window.v.clock.currentTime);
      return [point.x, point.y, point.z];
    }, record);
    const drift = metresBetween(edited, reloaded);
    assert.ok(drift < 0.05, `reloading the copied record must land where it was, drifted ${drift.toFixed(4)} m`);

    // Reset returns to the configuration this session started from.
    await page.locator('[data-place="start"]').click();
    await page.waitForFunction(() => window.editor.placement.state().placing === true, null, { timeout: 30000 });
    await page.locator('[data-move="east"]').click();
    await page.waitForTimeout(600);
    await page.locator('[data-place="reset"]').click();
    await page.waitForTimeout(600);
    const reset = await page.evaluate(() => window.editor.placement.state());
    // Finish kept the model where it was put, so starting again resumes from there rather than
    // snapping back to the file — and Reset returns to that resumed baseline.
    // The copied JSON is rounded to seven places; the editor keeps full precision while working,
    // so these agree to the precision that is actually written out.
    assert.ok(Math.abs(reset.latitude - record.latitude) < 1e-7,
      `Reset restores the values this editing session began with, got ${reset.latitude} vs ${record.latitude}`);
    await page.locator('[data-place="cancel"]').click();
    assert.equal((await page.evaluate(() => window.editor.placement.state())).placing, false);
    await page.click('.quick-rail [data-layer="gantries"]');
  }

  // ---- 4d. Alignment Mode: compare the replacement against the original from above --------------
  if (editorPresent) {
    await page.locator('.clip-editor-select').selectOption('i595-gantry-1-toll-plaza');
    await page.evaluate(() => window.clip.applySaved([{
      id: 'i595-gantry-1-toll-plaza', name: 'G1',
      photorealisticReplacement: { enabled: true, clippingPolygon:
        [[-80.31712, 26.11548], [-80.31690, 26.11548], [-80.31690, 26.11532], [-80.31712, 26.11532]] },
    }]));
    const clippingCount = () => page.evaluate(() => {
      const tileset = (window.v.scene.primitives._primitives || []).find(item => item && item.clippingPolygons);
      return tileset ? tileset.clippingPolygons.length : 0;
    });
    assert.equal(await clippingCount(), 1, 'the model has a saved polygon to begin with');

    await page.waitForFunction(() => !document.querySelector('[data-place="start"]').disabled, null, { timeout: 30000 });
    await page.locator('[data-place="align"]').click();
    await page.waitForFunction(() => window.editor.placement.state().aligning === true, null, { timeout: 30000 });

    // One switch brings on everything the comparison needs.
    const aligned = await page.evaluate(() => window.editor.placement.state());
    assert.equal(aligned.placing, true, 'alignment implies a placement');
    assert.equal(aligned.showingOriginal, true, 'Google’s own structure is uncovered');
    assert.equal(await clippingCount(), 0, 'this model’s polygon is held back while aligning');
    assert.equal(await page.locator('[data-place="opacity"]').inputValue(), '0.5', 'half opacity by default');
    assert.equal(await page.evaluate(() => window.models.modelById.get('i595-gantry-1-toll-plaza')
      .model.color.getValue(window.v.clock.currentTime).alpha), 0.5);
    // Anchor plus the longitudinal axis and its cross tick.
    assert.equal(await page.evaluate(() =>
      window.v.dataSources.getByName('Model Placement Anchor')[0].entities.values.length), 3,
      'the model’s axes are drawn for comparison');

    // Horizontal work must not move the model vertically under the user's hands.
    const heldSurface = (await page.evaluate(() => window.editor.placement.state())).ground;
    for (let step = 0; step < 4; step++) await page.locator('[data-move="east"]').click();
    await page.waitForTimeout(2200);
    assert.equal((await page.evaluate(() => window.editor.placement.state())).ground, heldSurface,
      'the sampled surface is held steady while aligning horizontally');

    // A tenth of a degree, for matching the long axis.
    const beforeHeading = (await page.evaluate(() => window.editor.placement.state())).heading;
    await page.locator('[data-adjust="heading"][data-delta="0.1"]').click();
    await page.waitForTimeout(400);
    const afterHeading = (await page.evaluate(() => window.editor.placement.state())).heading;
    assert.ok(Math.abs(afterHeading - beforeHeading - 0.1) < 1e-9, `0.1 degree steps, got ${afterHeading - beforeHeading}`);
    assert.match(await page.locator('[data-readout="latitude"]').textContent(), /^-?\d+\.\d{7}$/, 'seven places of latitude');
    assert.match(await page.locator('[data-readout="longitude"]').textContent(), /^-?\d+\.\d{7}$/, 'seven places of longitude');
    assert.match(await page.locator('[data-readout="headingOut"]').textContent(), /\d\.\d{4}°/, 'heading is live');

    // Leaving alignment restores what it borrowed and re-measures the surface.
    // The polygon itself, not the transient suppressed flag that alignment toggles.
    const polygonBefore = await page.evaluate(() =>
      JSON.stringify(window.clip.state().saved.map(item => ({ id: item.id, points: item.points }))));
    await page.locator('[data-place="align"]').click();
    await page.waitForFunction(() => window.editor.placement.state().aligning === false, null, { timeout: 30000 });
    await page.waitForTimeout(2500);
    assert.equal(await clippingCount(), 1, 'the clipping polygon comes back');
    assert.equal(await page.evaluate(() =>
      JSON.stringify(window.clip.state().saved.map(item => ({ id: item.id, points: item.points })))), polygonBefore,
      'moving the model never moves its clipping polygon');
    assert.equal(await page.evaluate(() => window.models.modelById.get('i595-gantry-1-toll-plaza')
      .model.color?.getValue(window.v.clock.currentTime) ?? null), null, 'opacity is restored');
    assert.equal(await page.evaluate(() =>
      window.v.dataSources.getByName('Model Placement Anchor')[0].entities.values.length), 1,
      'the axes are removed, the anchor stays while placing');

    await page.locator('[data-place="cancel"]').click();
    await page.evaluate(() => window.clip.applySaved([]));
  }

  // ---- 4e. replacement strategies, and comparing them without editing anything ------------------
  {
    // A clipping polygon removes everything in its geographic column — road included — so a model
    // may declare OCCLUSION instead and let its mesh stand in front of the original. The polygon is
    // kept either way, so the decision is reversible without re-drawing.
    const applied = await page.evaluate(() => window.clip.applySaved([
      { id: 'occluder', name: 'Occluder', photorealisticReplacement: { enabled: true, strategy: 'OCCLUSION',
        clippingPolygon: [[-80.31712, 26.11548], [-80.3169, 26.11548], [-80.3169, 26.11532], [-80.31712, 26.11532]] } },
      { id: 'clipper', name: 'Clipper', photorealisticReplacement: { enabled: true, strategy: 'CLIPPING_POLYGON',
        clippingPolygon: [[-80.33455, 26.11878], [-80.33438, 26.11878], [-80.33438, 26.11868], [-80.33455, 26.11868]] } },
    ]));
    assert.equal(applied.applied, 1, 'only the clipping strategy reaches the tileset');
    assert.equal(await page.evaluate(() => window.clip.strategyOf('occluder')), 'OCCLUSION');
    assert.equal(await page.evaluate(() => window.clip.strategyOf('clipper')), 'CLIPPING_POLYGON');
    // The coordinates survive the choice not to use them.
    assert.equal(await page.evaluate(() => window.clip.polygonOf('occluder')?.length), 4,
      'an occluding model keeps its polygon for later');
    assert.deepEqual(await page.evaluate(() => window.clip.state().saved.map(item => item.id)), ['clipper']);
    await page.evaluate(() => window.clip.applySaved([]));
  }

  if (editorPresent) {
    // Three ways of looking at the same model. None of them writes to the configuration.
    const modes = await page.$$eval('[data-compare]', nodes => nodes.map(node => node.dataset.compare));
    assert.deepEqual(modes, ['original', 'overlay-glb', 'clipped'], 'the comparison offers all three');
    await page.locator('.clip-editor-select').selectOption('i595-gantry-1-toll-plaza');
    await page.waitForFunction(() => window.models.modelById.get('i595-gantry-1-toll-plaza') != null, null, { timeout: 30000 });
    await page.click('.quick-rail [data-layer="gantries"]');
    await page.waitForFunction(() => window.models.modelById.get('i595-gantry-1-toll-plaza').show === true,
      null, { timeout: 30000 });

    await page.locator('[data-compare="original"]').click();
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.models.modelById.get('i595-gantry-1-toll-plaza').show), false,
      'the original view hides the replacement');
    assert.equal(await page.locator('[data-compare="original"]').getAttribute('aria-pressed'), 'true');

    await page.locator('[data-compare="overlay-glb"]').click();
    await page.waitForTimeout(700);
    assert.equal(await page.evaluate(() => window.models.modelById.get('i595-gantry-1-toll-plaza').show), true,
      'the occlusion view shows the replacement over untouched tiles');
    assert.equal(await page.evaluate(() => window.clip.state().total), 0, 'and clips nothing');

    // The configuration is never touched by comparing.
    const record = await page.evaluate(() => window.modelConfigs.find(item => item.id === 'i595-gantry-1-toll-plaza'));
    assert.equal(record.photorealisticReplacement.strategy, 'OCCLUSION', 'comparing does not rewrite the record');
    await page.click('.quick-rail [data-layer="gantries"]');
  }

  // ---- 5. nothing else was displaced ------------------------------------------------------------
  // The GLB models arrive after the intro; clipping must not have disturbed them.
  await page.waitForFunction(() => window.models.modelById.size > 0, null, { timeout: 120000 });
  assert.equal(await page.evaluate(() => window.models.modelById.size), 4, 'the GLB models are still placed');
  assert.equal(await page.evaluate(() => {
    const controller = window.v.scene.screenSpaceCameraController;
    return controller.enableRotate && controller.enableZoom && controller.enableTilt && controller.enableTranslate;
  }), true, 'camera navigation is untouched');
  assert.equal(await page.evaluate(() => window.v.trackedEntity), undefined);
  assert.deepEqual(errors, [], 'the editor must not throw');

  console.log(`i595-clipping-editor.smoke: PASS${editorPresent ? '' : ' (editor disabled by env flag)'}`);
} finally {
  await browser.close();
}
