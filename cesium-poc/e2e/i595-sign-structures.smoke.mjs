/**
 * FDOT sign structures — Overlane, Cantilever, and whatever is registered next.
 *
 * The suite reads the structure-type registry from the running page rather than naming layers, so
 * registering a type is enough to bring it under test. Expected counts come from the GeoJSON files
 * themselves: the invariant that matters is that every feature in a file reaches the map, not that
 * a number written here still matches.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { revealLayerGroup } from './i595Explorer.mjs';

/** Stated in the request, so it is checked by name as well as by derivation. */
const KNOWN_COUNTS = { overlane: 54 };

const cameraPose = page => page.evaluate(() =>
  `${v.camera.heading.toFixed(6)}|${v.camera.positionCartographic.height.toFixed(3)}`);

/**
 * Wait for a flight to finish: the pose must first differ from `from`, then stop changing. A wait
 * for the height to drop is no good after the first structure — by then the camera is already at
 * inspection height, and the next flight levels off at much the same place.
 */
async function settleCamera(page, from) {
  await page.waitForFunction(previous => {
    const now = `${v.camera.heading.toFixed(6)}|${v.camera.positionCartographic.height.toFixed(3)}`;
    const settled = now !== previous && window.__pose === now;
    window.__pose = now;
    return settled;
  }, from, { timeout: 45000, polling: 400 });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const warnings = [];
  const pageErrors = [];
  page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
  // An exception in a store listener stops every later surface from updating, so it must fail here.
  page.on('pageerror', error => pageErrors.push(String(error)));
  const fetches = new Map();
  await page.route('**/data/structures/*.geojson', route => {
    const name = route.request().url().split('/').pop();
    fetches.set(name, (fetches.get(name) ?? 0) + 1);
    route.continue();
  });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    const body = (await response.text())
      .replace('viewer.animation.container', 'window.v=viewer; viewer.animation.container')
      .replace('import.meta.hot.dispose(() => {', 'window.signs=signStructureControls; window.structureTypes=SIGN_STRUCTURE_TYPES; window.store=layerStore; import.meta.hot.dispose(() => {');
    await route.fulfill({ response, body });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.waitForFunction(() => window.signs != null && window.structureTypes != null, null, { timeout: 120000 });

  const types = await page.evaluate(() => window.structureTypes.map(type => ({ ...type })));
  assert.ok(types.length >= 3, `expected at least Overlane, Cantilever and Unclassified, got ${types.length}`);
  assert.equal(new Set(types.map(type => type.id)).size, types.length, 'type ids are unique');
  assert.equal(new Set(types.map(type => type.accent)).size, types.length, 'each type is a different colour on the map');
  assert.equal(new Set(types.map(type => type.glyph)).size, types.length, 'each type draws its own shape, not one glyph recoloured');

  // ---- every layer is counted at startup, but none of them has drawn anything -------------------
  // The count is a fact about the corridor, so it must be on screen before anyone switches a layer
  // on — as it already is for bridges, cameras and signals. The markers themselves wait: a hundred
  // hidden billboards is real startup cost for a number the records already carry.
  await page.waitForFunction(ids => ids.every(id => window.signs.countFor(id) > 0),
    types.map(type => type.id), { timeout: 90000 });
  assert.equal(await page.evaluate(names => names.reduce((total, name) =>
    total + window.v.dataSources.getByName(name)[0].entities.values.length, 0),
    types.map(type => `I-595 ${type.groupLabel} Sign Structures`)), 0,
    'no markers are created until a layer is first shown');
  for (const type of types) {
    assert.equal(await page.evaluate(name => window.v.dataSources.getByName(name)[0].show,
      `I-595 ${type.groupLabel} Sign Structures`), false, `${type.label} must start hidden`);
    const rail = page.locator(`.quick-rail [data-layer="${type.id}"]`);
    assert.equal(await rail.count(), 1, `${type.label} needs a rail tool`);
    assert.equal(await rail.getAttribute('title'), type.label, 'the tooltip is the layer name');
    assert.equal(await rail.getAttribute('aria-pressed'), 'false');
  }
  // Every type is drawn with its own icon, so the rail cannot read as one repeated button.
  const glyphs = await page.$$eval('.quick-rail [data-layer] svg', nodes => nodes.map(node => node.innerHTML));
  assert.equal(new Set(glyphs).size, glyphs.length, 'every rail tool has a distinct icon');

  for (const type of types) {
    const file = type.source.split('/').pop();
    // Read from disk, not over HTTP: a fetch from the page would be counted as the app's own.
    const inFile = JSON.parse(await readFile(new URL(`../public/${type.source}`, import.meta.url), 'utf8')).features.length;

    // ---- every feature in the file reached the map, and the toolbar shows it --------------------
    await page.click(`.quick-rail [data-layer="${type.id}"]`);
    await page.waitForFunction(name => window.v.dataSources.getByName(name)[0].show === true,
      `I-595 ${type.groupLabel} Sign Structures`, { timeout: 60000 });
    const loaded = await page.evaluate(id => window.signs.countFor(id), type.id);
    assert.equal(loaded, inFile, `${type.label}: ${loaded} placed from a file of ${inFile}`);
    if (KNOWN_COUNTS[type.id]) assert.equal(loaded, KNOWN_COUNTS[type.id], `${type.label} should hold ${KNOWN_COUNTS[type.id]} structures`);
    assert.deepEqual(warnings.filter(text => text.includes(type.groupLabel)), [], `${type.label} loaded short and warned`);

    const sourceName = `I-595 ${type.groupLabel} Sign Structures`;
    assert.equal(await page.evaluate(name => [...window.v.dataSources.getByName(name)[0].entities.values]
      .filter(entity => entity.show && entity.billboard).length, sourceName), inFile, 'one visible billboard per structure');

    // ---- toolbar and Map Explorer are one state, not two ---------------------------------------
    await revealLayerGroup(page, `#${type.control}`);
    assert.equal(await page.locator(`#${type.control}`).isChecked(), true, 'the explorer checkbox follows the toolbar');
    assert.equal(await page.locator(`.quick-rail [data-layer="${type.id}"]`).getAttribute('aria-pressed'), 'true');
    const group = page.locator(`.${type.id}-group`);
    assert.equal(await group.locator('.badge').first().textContent(), String(inFile), 'count badge');
    assert.equal(await group.locator('.badge').first().textContent().then(text => text.includes('…')), false,
      'the badge shows a number, not a placeholder');
    assert.equal(await group.locator('.segment-row').count(), inFile, 'one explorer row per structure');
    assert.match(await group.locator('.segment-select').first().textContent(), /^\S+\s+MP \d+$/, 'rows are id and milepost');

    await page.locator(`#${type.control}`).uncheck();
    await page.waitForFunction(id => document.querySelector(`.quick-rail [data-layer="${id}"]`).getAttribute('aria-pressed') === 'false',
      type.id, { timeout: 20000 }).catch(async () => {
        const state = await page.evaluate(id => {
          const box = document.querySelector(`#${id}-all`);
          const button = document.querySelector(`.quick-rail [data-layer="${id}"]`);
          return { boxChecked: box?.checked, boxIndeterminate: box?.indeterminate,
            storeState: window.store.stateOf(id), pressed: button?.getAttribute('aria-pressed'),
            buttonDisabled: button?.disabled };
        }, type.id);
        throw new Error(`${type.label}: the rail tool did not follow the explorer checkbox — ${JSON.stringify(state)}`
          + (pageErrors.length ? `\n  page errors: ${pageErrors.join(' | ')}` : '\n  (no page errors)'));
      });
    assert.equal(await page.evaluate(name => window.v.dataSources.getByName(name)[0].show, sourceName), false,
      'switching off in the explorer hides the markers');

    // ---- back on: reuse, never refetch, never duplicate ----------------------------------------
    await page.click(`.quick-rail [data-layer="${type.id}"]`);
    await page.waitForFunction(control => document.querySelector(`#${control}`).checked, type.control, { timeout: 30000 })
      .catch(() => { throw new Error(`${type.label}: the explorer checkbox did not follow the rail tool`); });
    assert.equal(fetches.get(file), 1, `${file} must be fetched exactly once, was ${fetches.get(file)}`);
    assert.equal(await page.evaluate(id => window.signs.countFor(id), type.id), inFile, 'no duplicate entities on re-toggle');

    // ---- selecting from the explorer selects, flies, and hands the camera back -----------------
    const before = await cameraPose(page);
    await group.locator('.segment-select').first().click();
    await settleCamera(page, before);

    const panel = await page.locator('.structure-details:not([hidden])').innerText();
    assert.ok(panel.includes(`${type.groupLabel} Structure`), `the panel says this is a ${type.groupLabel} structure`);
    for (const row of ['ID', 'FDOT Object ID', 'HLID', 'Milepost', 'Roadway ID', 'Light Count', 'Latitude', 'Longitude', 'Verification Status']) {
      assert.ok(panel.includes(row), `the panel must show ${row}`);
    }
    assert.equal(panel.includes('{'), false, 'no raw JSON in the panel');

    const height = await page.evaluate(() => v.camera.positionCartographic.height);
    assert.ok(height > 20 && height < 400, `${type.label}: an inspection view, not on top of it (got ${Math.round(height)} m)`);
    assert.equal(await page.evaluate(() => v.trackedEntity), undefined, 'selection must never track the entity');
    assert.equal(await page.evaluate(() => {
      const controller = v.scene.screenSpaceCameraController;
      return controller.enableRotate && controller.enableZoom && controller.enableTilt && controller.enableTranslate;
    }), true, 'pan, orbit and zoom remain the user’s after the flight');

    // ---- the selected marker is told apart from the rest ---------------------------------------
    const images = await page.evaluate(name => {
      const time = window.v.clock.currentTime;
      return [...window.v.dataSources.getByName(name)[0].entities.values].map(entity => String(entity.billboard.image.getValue(time)));
    }, sourceName);
    assert.equal(new Set(images).size, inFile > 1 ? 2 : 1, 'exactly one marker is drawn differently from the others');
    // The unselected artwork must be this type's own, not another type's shape in a new colour.
    const resting = images.find(image => image !== images[0]) ?? images[0];
    assert.ok(decodeURIComponent(resting).includes(type.glyph.slice(0, 40)), `${type.label} markers draw the ${type.groupLabel} shape`);

    // Collapse this type's rows before moving on. Three open lists is 110 rows the panel keeps
    // laying out, which slows every later interaction to a crawl for no gain in coverage.
    await page.evaluate(id => { const group = document.querySelector(`.${id}-group`); if (group) group.open = false; }, type.id);
  }

  // ---- asset layers are mutually exclusive ------------------------------------------------------
  // Selecting a layer deselects the previous one, so only the type switched on last is drawn. The
  // loop above switched all three on in turn; the last one is the survivor.
  const shown = await page.evaluate(types => Object.fromEntries(types.map(type =>
    [type.id, window.v.dataSources.getByName(`I-595 ${type.groupLabel} Sign Structures`)[0].show])), types);
  const last = types[types.length - 1].id;
  assert.deepEqual(shown, Object.fromEntries(types.map(type => [type.id, type.id === last])),
    `only the most recently selected type stays on, expected ${last}`);

  // Switching a different type on takes over from it, rather than adding to it.
  await page.click(`.quick-rail [data-layer="${types[0].id}"]`);
  await page.waitForFunction(name => window.v.dataSources.getByName(name)[0].show === true,
    `I-595 ${types[0].groupLabel} Sign Structures`, { timeout: 20000 });
  assert.equal(await page.evaluate(name => window.v.dataSources.getByName(name)[0].show,
    `I-595 ${types[types.length - 1].groupLabel} Sign Structures`), false,
    'selecting a structure type deselects the one that was on');

  for (const control of ['#bridges-all', '#cameras-mainline', '#signals-all']) {
    assert.equal(await page.locator(control).count(), 1, `${control} must survive`);
  }

  // ---- the tree groups layers by what they are ---------------------------------------------------
  const placement = await page.evaluate(() => {
    const groupOf = selector => {
      for (let node = document.querySelector(selector); node; node = node.parentElement) {
        if (node.tagName === 'DETAILS' && node.matches('.roads, .its-group')) {
          return node.querySelector(':scope > summary').textContent.trim();
        }
      }
      return null;
    };
    return {
      frontage: groupOf('#frontage-layer-controls'),
      ramps: groupOf('#ramp-layer-controls'),
      structures: groupOf('#structure-layer-controls'),
      structuresOpen: document.querySelector('.structures-group')?.open === true,
    };
  });
  assert.equal(placement.frontage, 'Traffic', 'frontage roads carry traffic');
  assert.equal(placement.ramps, 'Traffic', 'ramps and connectors carry traffic');
  assert.equal(placement.structures, 'Infrastructure', 'structures stand over the road');
  assert.equal(placement.structuresOpen, true, 'the Structures group is open, so its layers are visible');

  assert.deepEqual(pageErrors, [], 'the page must not throw while layers are toggled');
  console.log(`i595-sign-structures.smoke: PASS — ${types.map(type => type.groupLabel).join(', ')}`);
} finally {
  await browser.close();
}
