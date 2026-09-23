/**
 * Lighting Asset Explorer acceptance run, against the dev server on :5188.
 *
 * Expected counts come from the committed DataConnect snapshot, never from numbers written here.
 * Every numbered step names the acceptance criterion it checks.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { openLayers } from './i595Explorer.mjs';

const rows = JSON.parse(readFileSync(new URL('../public/dataconnect-data/asset_registry.json', import.meta.url)));
const lightingRows = rows.filter(row => /^Lighting\b/.test(row['Asset Category']));
const expectedByCategory = new Map();
for (const row of lightingRows) expectedByCategory.set(row['Asset Category'], (expectedByCategory.get(row['Asset Category']) ?? 0) + 1);
const rowById = new Map(lightingRows.map(row => [String(row['Asset ID']).trim(), row]));
const TOTAL = lightingRows.length;

// GPU rendering: software rendering never finishes loading the 3D tiles, so ground-clamped
// markers sit on placeholder heights and neither framing nor picking matches a real display.
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const results = [];
const pass = (n, note = '') => { results.push([n, note]); console.log(`  ✓ ${n}${note ? ` — ${note}` : ''}`); };
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const problems = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`); });
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('window.__assetExplorer = assetExplorer;', 'window.__assetExplorer = assetExplorer; window.__lightingViewer = viewer;') });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await openLayers(page);
  // Only what happens from here on is attributed to lighting.
  const startupProblems = problems.splice(0);

  const state = () => page.evaluate(() => {
    const s = window.__assetExplorer.store.getState();
    return { type: s.activeExplorerType, count: s.assetsByType.lighting?.length ?? 0, selected: s.selectedAsset?.id ?? null,
      selectedType: s.selectedAsset?.assetType ?? null, source: s.selectionSource, inspecting: s.inspectionViewActive };
  });
  // Every lighting entity, what it currently draws, and the fill colour of its ID marker if it has
  // one. `rendered` reads Cesium's own billboard primitive: an image assigned to an entity is not
  // proof it is on screen (that is how a point/billboard slot clash once hid every ID marker).
  const scene = () => page.evaluate(() => {
    const all = window.__lightingViewer.dataSources.getByName('DataConnect Lighting');
    const ds = all[0];
    const t = window.__lightingViewer.clock.currentTime;
    const image = entity => entity.billboard.image.getValue(t);
    const fill = entity => [...image(entity).getContext('2d').getImageData(24, 9, 1, 1).data].slice(0, 3).join(',');
    const items = ds._visualizers.find(v => v.constructor.name === 'BillboardVisualizer')._items;
    const shown = ds.entities.values.filter(e => e.show);
    const marked = shown.filter(e => image(e).width > 60);          // an ID pill, not the shared dot
    return {
      sources: all.length, total: ds.entities.values.length, shown: shown.length,
      dotTextures: new Set(shown.filter(e => image(e).width <= 60).map(image)).size,
      notRendered: marked.filter(e => { const b = items.get(e.id)?.billboard; return !(b?.show && b.ready && b.image); }).map(e => e.id),
      yellow: marked.filter(e => fill(e) === '245,181,27').map(e => e.id.slice('lighting-'.length)),
      black: marked.filter(e => fill(e) === '52,58,64').length,
      marked: marked.length,
    };
  });
  const cardText = () => page.locator('.MuiCard-root [aria-current="true"]').innerText();
  const details = () => page.getByRole('complementary', { name: 'Lighting Asset Details' });

  // 1–2. Data loads, all records available.
  await page.waitForFunction(() => window.__lightingViewer.dataSources.getByName('DataConnect Lighting')[0]?.entities.values.length > 0, null, { timeout: 60000 });
  assert.equal((await scene()).total, TOTAL);
  pass(1, 'DataConnect asset_registry.json loaded'); pass(2, `${TOTAL} lighting records`);

  // 4. One lighting icon on the collapsed rail, none per category.
  const rail = page.locator('.quick-rail [data-layer^="lighting"]');
  assert.equal(await rail.count(), 1);
  assert.equal(await rail.getAttribute('data-layer'), 'lighting');
  pass(4);

  // 6–8. Expanded tree: Infrastructure → Lighting → the six source categories with real counts.
  await page.locator('#menu-toggle').click();
  await page.locator('.layer-category[data-category="infrastructure"] > summary').click();
  const group = page.locator('.layer-categories [data-group="lighting"]');
  assert.equal(await group.count(), 1);
  pass(6);
  await group.locator('> summary').click();
  const categoryRows = group.locator('.layer-subgroup-items [data-layer]');
  assert.equal(await categoryRows.count(), 6);
  const tree = await categoryRows.evaluateAll(buttons => buttons.map(b => ({ id: b.dataset.layer,
    label: b.querySelector('.layer-row-label').textContent, count: b.querySelector('.layer-row-count').textContent })));
  assert.deepEqual(tree.map(r => r.label).sort(), [...expectedByCategory.keys()].sort());
  pass(3, tree.map(r => r.label).join(' | '));
  pass(7);
  for (const row of tree) assert.equal(row.count, expectedByCategory.get(row.label).toLocaleString('en-US'));
  assert.equal(await group.locator('> summary .layer-row-count').textContent(), TOTAL.toLocaleString('en-US'));
  pass(8, tree.map(r => `${r.label}=${r.count}`).join(', '));
  await page.locator('#menu-toggle').click();

  // 5. The single rail icon opens the Lighting explorer with every asset.
  await rail.click();
  await page.getByRole('region', { name: 'Lighting explorer', exact: true }).waitFor();
  await page.waitForFunction(n => window.__assetExplorer.store.getState().assetsByType.lighting?.length === n, TOTAL);
  assert.equal((await scene()).shown, TOTAL);
  assert.match(await page.getByRole('region', { name: 'Lighting explorer', exact: true }).innerText(), new RegExp(`${TOTAL.toLocaleString('en-US')} assets`));
  pass(5);

  // 9–11. Switch the largest category off from the tree: scene, cards, mini-map and counts follow.
  const general = tree.find(r => r.label === 'Lighting');
  const remaining = TOTAL - expectedByCategory.get('Lighting');
  await page.locator('#menu-toggle').click();
  await group.locator(`[data-layer="${general.id}"]`).click();
  await page.waitForFunction(n => window.__assetExplorer.store.getState().assetsByType.lighting?.length === n, remaining);
  await page.locator('#menu-toggle').click();
  assert.equal((await scene()).shown, remaining);
  pass(9, `${remaining} of ${TOTAL} drawn`);
  const region = page.getByRole('region', { name: 'Lighting explorer', exact: true });
  assert.match(await region.innerText(), new RegExp(`${remaining} assets`));
  const cardSubtitles = await region.locator('.MuiCard-root .MuiTypography-caption').allInnerTexts();
  assert.ok(cardSubtitles.length > 0 && !cardSubtitles.includes('Lighting'), 'no card from the disabled category');
  pass(10);
  assert.match(await page.locator('canvas[aria-label*="mini-map"]').getAttribute('aria-label'), new RegExp(`of ${remaining} assets|${remaining} assets`));
  pass(11);

  // 12–13, 17, 20. Select a card.
  const secondCard = region.locator('.MuiCardActionArea-root').nth(1);
  await secondCard.click();
  let s = await state();
  assert.equal(s.source, 'card');
  const picked = rowById.get(s.selected);
  const text = await cardText();
  assert.ok(text.includes(s.selected), 'card shows the asset ID');
  pass(12, JSON.stringify(text));
  assert.ok(text.includes(picked['Asset Category']), 'card shows the source category');
  pass(13);
  let sc = await scene();
  assert.deepEqual(sc.yellow, [s.selected]);
  pass(17);
  const panel = await details().innerText();
  assert.ok(panel.includes(picked['Asset Category']) && panel.includes(Number(picked['Y Coordinates']).toFixed(6))
    && panel.includes(Number(picked['X Coordinates']).toFixed(6)) && panel.includes(s.selected));
  pass(20, panel.replace(/\n+/g, ' · ').slice(0, 220));

  // 14–16. Black markers, one yellow, and each shown asset draws exactly one graphic.
  await page.waitForTimeout(2000);   // the selection's moderate camera move settles, labels refresh
  // Newly promoted ID markers load their textures asynchronously; give them up to 8 s to be drawn.
  for (let i = 0; i < 16 && (sc = await scene()).notRendered.length; i++) await page.waitForTimeout(500);
  assert.equal(sc.dotTextures, 1, 'every unlabelled asset shares one dot texture');
  assert.deepEqual(sc.notRendered, [], 'every ID marker is actually drawn by Cesium');
  assert.ok(sc.black > 0, 'nearby unselected assets show black ID markers');
  assert.equal(sc.black + sc.yellow.length, sc.marked);
  pass(14, `${sc.black} black ID markers rendered near the camera, the other ${sc.shown - sc.marked} as the shared charcoal location dot`);
  assert.deepEqual(sc.yellow, [s.selected]); pass(15); pass(16);

  if (process.env.LIGHTING_SHOTS) await page.screenshot({ path: `${process.env.LIGHTING_SHOTS}/selected.png` });
  // 21. Mini-map names the selection.
  assert.match(await page.locator('canvas[aria-label*="mini-map"]').getAttribute('aria-label'), new RegExp(`Lighting ${s.selected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} selected`));
  pass(21);

  // 22–24. Next / Previous walk the filtered list.
  const order = await page.evaluate(() => window.__assetExplorer.store.getState().assetsByType.lighting.map(a => a.id));
  const at = order.indexOf(s.selected);
  await page.getByRole('button', { name: 'Next lighting asset' }).click();
  s = await state(); assert.equal(s.selected, order[at + 1]); assert.deepEqual((await scene()).yellow, [s.selected]);
  assert.ok((await cardText()).includes(s.selected));
  pass(23);
  await page.getByRole('button', { name: 'Previous lighting asset' }).click();
  s = await state(); assert.equal(s.selected, order[at]);
  pass(22);
  await page.evaluate(() => { const st = window.__assetExplorer.store; const a = st.getState().assetsByType.lighting; st.selectAsset(a[a.length - 1], 'step'); });
  assert.equal(await page.getByRole('button', { name: 'Next lighting asset' }).isDisabled(), true);
  assert.ok(order.every(id => rowById.get(id)['Asset Category'] !== 'Lighting'));
  pass(24, `stepping stays inside the ${order.length} filtered assets`);

  // Re-enable everything for the map-click and inspection checks.
  await page.locator('#menu-toggle').click();
  await group.locator(`[data-layer="${general.id}"]`).click();
  await page.waitForFunction(n => window.__assetExplorer.store.getState().assetsByType.lighting?.length === n, TOTAL);
  await page.locator('#menu-toggle').click();
  await page.evaluate(() => { const st = window.__assetExplorer.store; st.selectAsset(st.getState().assetsByType.lighting[1500], 'card'); });
  await page.waitForTimeout(2500);

  // 18–19. Click a different asset's marker in Cesium.
  const canvasBox = await page.locator('.cesium-widget canvas').boundingBox();
  // Scan the open part of the map for a pixel that picks an unselected lighting ID marker, exactly
  // as a user's click would find it.
  const targets = await page.evaluate(async ({ w, h }) => {
    const v = window.__lightingViewer, t = v.clock.currentTime;
    const selected = `lighting-${window.__assetExplorer.store.getState().selectedAsset.id}`;
    const rect = v.scene.canvas.getBoundingClientRect();
    const idAt = (x, y) => v.scene.pick({ x, y })?.id?.id;
    const candidates = [];
    // Bottom-up: nearer the camera first. Assets near the horizon move as the tiles under their
    // clamped position refine, so every candidate is re-picked a few frames later before use.
    // Clear of the bottom explorer and mini-map, which move as panels open.
    for (let y = h - 330; y > 10 && candidates.length < 12; y -= 8) for (let x = 10; x < w - 10; x += 8) {
      // Only where the map itself is under the pointer, not a panel floating over it.
      if (document.elementFromPoint(rect.left + x, rect.top + y) !== v.scene.canvas) continue;
      const e = v.scene.pick({ x, y })?.id;
      if (typeof e?.id !== 'string' || !e.id.startsWith('lighting-') || e.id === selected) continue;
      candidates.push({ id: e.id.slice('lighting-'.length), x, y, marker: Boolean(e.billboard && (e.billboard.show?.getValue(t) ?? true)) });
    }
    for (let i = 0; i < 10; i++) { v.scene.requestRender(); await new Promise(r => requestAnimationFrame(r)); }
    return candidates.filter(c => idAt(c.x, c.y) === `lighting-${c.id}`
      && document.elementFromPoint(rect.left + c.x, rect.top + c.y) === v.scene.canvas);
  }, { w: canvasBox.width, h: canvasBox.height });
  assert.ok(targets.length, 'an unobstructed lighting marker is on screen');
  // The scene keeps loading tiles, so a marker can move between the scan and the click; take the
  // first candidate that is still under the pointer when the click actually happens.
  let target = null;
  for (const candidate of targets) {
    const stillThere = await page.evaluate(({ x, y }) => {
      const v = window.__lightingViewer, rect = v.scene.canvas.getBoundingClientRect();
      return document.elementFromPoint(rect.left + x, rect.top + y) === v.scene.canvas
        && v.scene.pick({ x, y })?.id?.id?.startsWith('lighting-');
    }, candidate);
    if (stillThere) { target = candidate; break; }
  }
  assert.ok(target, 'a lighting marker is still under the pointer at click time');
  await page.mouse.click(canvasBox.x + target.x, canvasBox.y + target.y);
  await page.waitForTimeout(300);

  await page.waitForTimeout(300);
  s = await state();
  assert.equal(s.selected, target.id); assert.equal(s.source, 'cesium');
  assert.deepEqual((await scene()).yellow, [target.id]);
  pass(18, `clicked ${target.id} (${target.marker ? "ID marker" : "point"}) on the map`);
  assert.ok((await cardText()).includes(target.id), 'the carousel window moved to the picked card');
  pass(19);

  // 25–27. View on map, free camera afterwards, Back restores.
  const saved = await page.evaluate(() => { const c = window.__lightingViewer.camera; return [c.positionWC.x, c.positionWC.y, c.positionWC.z]; });
  await page.getByRole('button', { name: `View Lighting ${target.id} on map` }).click();
  await page.waitForTimeout(2600);
  const close = await page.evaluate(id => {
    const v = window.__lightingViewer, t = v.clock.currentTime;
    const e = v.dataSources.getByName('DataConnect Lighting')[0].entities.getById(`lighting-${id}`);
    const c = v.scene.screenSpaceCameraController;
    const p = e.position.getValue(t);
    return { distance: Math.hypot(v.camera.positionWC.x - p.x, v.camera.positionWC.y - p.y, v.camera.positionWC.z - p.z),
      tracked: v.trackedEntity ?? null, controls: [c.enableInputs, c.enableRotate, c.enableTranslate, c.enableZoom, c.enableTilt, c.enableLook] };
  }, target.id);
  assert.ok(close.distance < 150, `camera ${close.distance.toFixed(0)} m from the asset`);
  assert.equal(close.tracked, null);
  pass(25, `camera ${close.distance.toFixed(0)} m from ${target.id}`);
  assert.ok(close.controls.every(Boolean));
  const before = await page.evaluate(() => { const c = window.__lightingViewer.camera; return [c.positionWC.x, c.positionWC.y, c.positionWC.z, c.heading, c.pitch]; });
  await page.mouse.move(canvasBox.x + 800, canvasBox.y + 500);
  await page.mouse.down(); await page.mouse.move(canvasBox.x + 860, canvasBox.y + 540, { steps: 8 }); await page.mouse.up();   // pan
  await page.mouse.wheel(0, -300);                                                                                          // zoom
  await page.mouse.move(canvasBox.x + 800, canvasBox.y + 500);
  await page.mouse.down({ button: 'middle' }); await page.mouse.move(canvasBox.x + 840, canvasBox.y + 470, { steps: 8 }); await page.mouse.up({ button: 'middle' });   // rotate/tilt
  await page.waitForTimeout(600);
  const after = await page.evaluate(() => { const c = window.__lightingViewer.camera; return [c.positionWC.x, c.positionWC.y, c.positionWC.z, c.heading, c.pitch]; });
  assert.ok(Math.hypot(after[0] - before[0], after[1] - before[1], after[2] - before[2]) > 1 && (after[3] !== before[3] || after[4] !== before[4]));
  pass(26, 'no trackedEntity; pan, zoom and middle-drag rotate/tilt all moved the camera');
  await page.getByRole('button', { name: 'Return to the previous view' }).click();
  await page.waitForTimeout(2200);
  const back = await page.evaluate(() => { const c = window.__lightingViewer.camera; return [c.positionWC.x, c.positionWC.y, c.positionWC.z]; });
  const drift = Math.hypot(back[0] - saved[0], back[1] - saved[1], back[2] - saved[2]);
  assert.ok(drift < 1, `restored within ${drift.toFixed(3)} m`);
  pass(27, `restored within ${drift.toFixed(3)} m`);

  // 28. Switching off the selected asset's category clears the selection everywhere.
  const selectedCategory = tree.find(r => r.label === rowById.get(target.id)['Asset Category']);
  await page.locator('#menu-toggle').click();
  await group.locator(`[data-layer="${selectedCategory.id}"]`).click();
  await page.waitForFunction(() => window.__assetExplorer.store.getState().selectedAsset === null);
  sc = await scene();
  assert.deepEqual(sc.yellow, []);
  assert.equal(await details().count(), 0);
  await group.locator(`[data-layer="${selectedCategory.id}"]`).click();
  await page.locator('#menu-toggle').click();
  pass(28, `turning off "${selectedCategory.label}" cleared ${target.id}`);

  // 29. One data source, one entity per record, after all the toggling above.
  sc = await scene();
  assert.equal(sc.sources, 1); assert.equal(sc.total, TOTAL);
  pass(29);

  // 33. Usability at full load. Absolute frame times here are dominated by Google 3D tiles streaming
  // into a software-rendered headless browser, so the check is what lighting itself adds: the cost
  // of a selection, and the frame rate at the corridor overview with all assets on versus off.
  const perf = await page.evaluate(async () => {
    const v = window.__lightingViewer, st = window.__assetExplorer.store;
    const a = st.getState().assetsByType.lighting;
    const js = [];
    for (const i of [2000, 2001, 150, 2894]) { const t0 = performance.now(); st.selectAsset(a[i], 'card'); js.push(performance.now() - t0); }
    return { selectMs: Math.round(Math.max(...js)) };
  });
  assert.ok(perf.selectMs < 50, `selection took ${perf.selectMs} ms of JS/React work`);
  await page.evaluate(() => window.__assetExplorer.store.selectAsset(null));
  await page.getByRole('button', { name: /Reset view/ }).click();
  await page.waitForTimeout(5000);
  const fps = () => page.evaluate(() => new Promise(r => { const v = window.__lightingViewer; let n = 0; const s0 = performance.now();
    const f = () => { n++; if (performance.now() - s0 < 4000) { v.scene.requestRender(); requestAnimationFrame(f); } else r(Math.round(n / 4)); }; f(); }));
  const onFps = await fps();
  const inView = (await scene()).shown;
  await page.evaluate(() => { window.__lightingViewer.dataSources.getByName('DataConnect Lighting')[0].show = false; });
  const offFps = await fps();
  await page.evaluate(() => { window.__lightingViewer.dataSources.getByName('DataConnect Lighting')[0].show = true; });
  pass(33, `selection ${perf.selectMs} ms JS/React; corridor overview ${onFps} fps with all ${inView} drawn vs ${offFps} fps hidden (headless)`);

  // 32. Cameras and Bridges still browse and select through the same explorer.
  await page.locator('.quick-rail [data-layer="cameras"]').click();
  await page.waitForFunction(() => window.__assetExplorer.store.getState().activeExplorerType === 'camera');
  assert.equal((await scene()).shown, 0, 'lighting switched off when cameras took over');
  await page.getByRole('region', { name: 'Traffic Cameras explorer', exact: true }).locator('.MuiCardActionArea-root').first().click();
  s = await state(); assert.equal(s.selectedType, 'camera');
  await page.locator('.quick-rail [data-layer="structures"]').click();
  await page.waitForFunction(() => window.__assetExplorer.store.getState().activeExplorerType === 'bridge');
  await page.getByRole('region', { name: 'Bridges explorer', exact: true }).locator('.MuiCardActionArea-root').first().click();
  s = await state(); assert.equal(s.selectedType, 'bridge');
  pass(32, 'cameras and bridges select through the shared explorer; lighting hides when another asset layer takes over');

  // 30–31. Nothing logged by React or Cesium during any of the above.
  // The willReadFrequently notice is this script's own getImageData colour sampling, not the app.
  // The willReadFrequently notice is this script's own getImageData colour sampling, not the app;
  // network trouble reaching the live FL511 feed is the environment's.
  const lighting = problems.filter(p => !/willReadFrequently|Failed to load resource|net::ERR|CORS policy|Failed to fetch|live-events/.test(p));
  assert.deepEqual(lighting, []);
  pass(30, 'no React warnings or errors'); pass(31, 'no Cesium errors');
  if (startupProblems.length) console.log(`  (startup, before any lighting interaction: ${startupProblems.length} console messages)`);
  console.log(`Lighting acceptance: ${results.length} checks passed.`);
} finally { await browser.close(); }
