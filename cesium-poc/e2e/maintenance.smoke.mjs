/**
 * The Maintenance workspace's Work Orders slice: KPI strip → list → map markers → bottom explorer,
 * one selection shared by all three, details from the real DataConnect fields.
 *
 * Expected counts are read from the committed export, never written here.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const read = name => JSON.parse(readFileSync(new URL(`../public/dataconnect-data/${name}.json`, import.meta.url)));
const workOrders = read('work_orders');
const assets = new Map(read('asset_registry').map(row => [String(row['Asset ID']).trim(), row]));
const placed = workOrders.filter(row => {
  const asset = assets.get(String(row['Asset ID']).trim());
  return asset && Number.isFinite(asset['X Coordinates']) && Number.isFinite(asset['Y Coordinates']);
});
const tickets = read('tickets').length;

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } });
  const problems = [];
  const networkNoise = /Failed to load resource|net::ERR|CORS policy|Failed to fetch|live-events|snapshot/;
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !networkNoise.test(m.text())) problems.push(`console: ${m.text()}`); });
  // `data=mock` is explicit: this suite checks the committed export against its own expected
  // counts, so it must not follow whatever VITE_DATA_SOURCE the machine happens to set.
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off&debug=1&data=mock');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });

  // Each workspace has its own strip; these are Maintenance's.
  const kpi = key => page.locator(`.maintenance-workspace .ws-kpi[data-kpi="${key}"]`);
  const cards = page.locator('.MuiCardActionArea-root');
  const selectedCard = page.locator('.MuiCard-root [aria-current="true"]');
  const state = () => page.evaluate(() => {
    const s = window.__assetExplorer.store.getState();
    return { type: s.activeExplorerType, id: s.selectedAsset?.id ?? null, source: s.selectionSource, inspecting: s.inspectionViewActive };
  });
  const drawn = () => page.evaluate(() => {
    const ds = window.__viewer?.dataSources.getByName('Maintenance Records')[0];
    // The selected marker is drawn from its own source so it is never hidden behind a marker that
    // shares its asset; both together are what is on the map.
    const selection = window.__viewer.dataSources.getByName('Maintenance Selection')[0];
    const t = window.__viewer.clock.currentTime;
    const shown = [...ds.entities.values.filter(e => e.show), ...selection.entities.values];
    const image = e => e.billboard.image.getValue(t);
    // The selected marker is the shared yellow (#F5B51B). Sampled across the pill's top band
    // rather than at one pixel, which can land on a rounded corner of a long ID.
    const isYellow = e => {
      const canvas = image(e);
      const data = canvas.getContext('2d').getImageData(0, 9, canvas.width, 1).data;
      for (let x = 0; x < canvas.width; x++) {
        if (data[x * 4] === 245 && data[x * 4 + 1] === 181 && data[x * 4 + 2] === 27) return true;
      }
      return false;
    };
    const marked = shown.filter(e => image(e).width > 60);
    return { shown: shown.length, yellow: marked.filter(isYellow).map(e => e.name) };
  });
  const cameraAt = () => page.evaluate(() => { const c = window.__viewer.camera.positionWC; return [c.x, c.y, c.z]; });
  const moved = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  // 1. Maintenance opens the workspace: a compact strip, the map untouched underneath.
  await page.locator('.app-nav [data-section="maintenance"]').click();
  await page.locator('.maintenance-workspace .ws-kpis').waitFor();
  await page.waitForFunction(() => document.querySelector('.maintenance-workspace .ws-kpi[data-kpi="workOrders"]')?.dataset.state === 'ready', null, { timeout: 60000 });
  assert.equal(await page.locator('.maintenance-workspace .ws-kpi').count(), 5);
  assert.equal(await kpi('workOrders').locator('[data-count]').innerText(), workOrders.length.toLocaleString('en-US'));
  assert.equal(await kpi('tickets').locator('[data-count]').innerText(), tickets.toLocaleString('en-US'));
  const note = await kpi('workOrders').locator('[data-note]').innerText();
  const open = workOrders.filter(row => !['Closed', 'Completed'].includes(row['Work Order Status'])).length;
  assert.equal(note, `${open} open · ${workOrders.filter(row => row.Priority === 'High').length} high priority`);
  assert.equal(await page.locator('.cesium-widget canvas').isVisible(), true, 'the map is still the workspace');
  assert.equal(await page.locator('.mx-list').count(), 0, 'no permanent side panel — the browser is the list');
  assert.equal(await page.locator('.maintenance-workspace .ws-kpi[aria-pressed="true"]').count(), 0, 'nothing is chosen on arrival');
  assert.equal(await page.locator('[role="region"][aria-label$="explorer"]').count(), 0, 'and the browser stays away until asked for');
  console.log(`✓ KPI strip from the mock export: work orders ${workOrders.length} (${note}), tickets ${tickets}`);

  // A class this deployment does not carry says so rather than showing a made-up number.
  await page.waitForFunction(() => ['ready', 'unavailable', 'error'].includes(document.querySelector('.maintenance-workspace .ws-kpi[data-kpi="tasks"]')?.dataset.state), null, { timeout: 60000 });
  const tasksState = await kpi('tasks').getAttribute('data-state');
  if (tasksState !== 'ready') {
    assert.equal(await kpi('tasks').locator('[data-count]').innerText(), '—');
    assert.match(await kpi('tasks').locator('[data-note]').innerText(), /Unavailable|Failed/);
    console.log(`✓ Tasks are ${tasksState} in this deployment, and say so (no invented count)`);
  }
  // This run uses the default source — the committed export — and the strip says so plainly rather
  // than claiming to be the live API. `e2e/maintenance-dataconnect.smoke.mjs` covers the live path.
  assert.match(await page.locator('.maintenance-workspace .ws-source').innerText(), /^Mock data/);

  // 2. Clicking the KPI opens the list, the markers and the bottom explorer together.
  await kpi('workOrders').click();
  await page.waitForFunction(n => window.__assetExplorer.store.getState().assetsByType.workOrder?.length === n, workOrders.length, { timeout: 60000 });
  assert.equal((await state()).type, 'workOrder');
  assert.equal((await drawn()).shown, placed.length, 'every spatially resolved work order is drawn');
  assert.equal(await page.getByRole('region', { name: 'Work Orders explorer', exact: true }).isVisible(), true);
  assert.equal(await kpi('workOrders').getAttribute('aria-pressed'), 'true', 'the chosen KPI shows as chosen');
  console.log(`✓ Work Orders: ${placed.length} of ${workOrders.length} drawn on the map, browser open, no side panel`);

  // 3. List → map + explorer.
  const before = await cameraAt();
  const firstId = (await cards.first().innerText()).split('\n')[0].trim();
  await cards.first().click();
  await page.waitForTimeout(2200);
  let now = await state();
  assert.equal(now.id, firstId);
  assert.deepEqual((await drawn()).yellow, [firstId], 'its marker is the selected one');
  assert.ok(moved(before, await cameraAt()) > 100, 'the map flew to it');
  assert.match(await page.locator('.MuiCard-root [aria-current="true"]').innerText(), new RegExp(firstId));
  console.log(`✓ card → ${firstId}: marker highlighted, camera flew, selection shared`);

  // 4. Details are the record's own DataConnect fields.
  const details = page.getByRole('complementary', { name: 'Work Order Details' });
  const panel = await details.innerText();
  const source = workOrders.find(row => row['Work Order ID'] === firstId);
  assert.match(panel, new RegExp(source['Work Order Status']));
  assert.match(panel, new RegExp(source.Priority));
  assert.match(panel, new RegExp(String(source['Asset ID'])));
  assert.match(panel, new RegExp(source['Asset Type'].split(' ')[0]));
  assert.match(panel, /From asset/, 'it says where the position came from');
  console.log(`✓ details show real fields: ${panel.replace(/\n+/g, ' · ').slice(0, 150)}`);

  // 4b. Records commonly share an asset, so their markers coincide exactly. The selected one is
  //     drawn from its own source and the ones sharing its point stand down, so it is never hidden
  //     behind another marker.
  const coincident = await page.evaluate(id => {
    const v = window.__viewer, t = v.clock.currentTime;
    const records = window.__maintenance.recordsOf('workOrders');
    const chosen = records.find(item => item.id === id);
    const sharing = records.filter(item => item.id !== id && item.longitude === chosen.longitude && item.latitude === chosen.latitude);
    const ds = v.dataSources.getByName('Maintenance Records')[0];
    const selection = v.dataSources.getByName('Maintenance Selection')[0];
    return {
      sharing: sharing.map(item => item.id),
      sharingShown: sharing.filter(item => ds.entities.getById(`maintenance-workOrder-${item.id}`)?.show).length,
      baseHidden: ds.entities.getById(`maintenance-workOrder-${id}`)?.show === false,
      selectionDraws: selection.entities.values.map(entity => entity.name),
    };
  }, firstId);
  assert.deepEqual(coincident.selectionDraws, [firstId], 'the selection is drawn on its own');
  assert.equal(coincident.baseHidden, true, 'its ordinary marker steps aside for it');
  assert.equal(coincident.sharingShown, 0, 'markers sharing its exact point stand down');
  console.log(`✓ ${firstId} shares its point with ${coincident.sharing.length} other work order(s); only the selected marker is drawn there`);

  // 5. Previous / Next in the bottom explorer move the selection and the map.
  const atFirst = await cameraAt();
  await page.getByRole('button', { name: 'Next work order' }).click();
  await page.waitForTimeout(2200);
  const second = await state();
  assert.notEqual(second.id, firstId);
  assert.deepEqual((await drawn()).yellow, [second.id]);
  assert.ok(moved(atFirst, await cameraAt()) > 10, 'the map followed the step');
  assert.match(await selectedCard.innerText(), new RegExp(second.id), 'the browser followed too');
  await page.getByRole('button', { name: 'Previous work order' }).click();
  await page.waitForTimeout(1500);
  assert.equal((await state()).id, firstId);
  console.log(`✓ Next/Previous stepped ${firstId} → ${second.id} → ${firstId}, list and map following`);

  // 6. Map → list + explorer. Pull back to the corridor first: at a 70 m close view the only marker
  //    on screen is the one already selected.
  await page.locator('#reset-view').click();
  await page.waitForTimeout(3500);
  const target = await page.evaluate(async () => {
    const v = window.__viewer, ds = v.dataSources.getByName('Maintenance Records')[0], t = v.clock.currentTime;
    const selected = window.__assetExplorer.store.getState().selectedAsset?.id;
    const rect = v.scene.canvas.getBoundingClientRect();
    for (let i = 0; i < 10; i++) { v.scene.requestRender(); await new Promise(r => requestAnimationFrame(r)); }
    // Project the markers rather than sweeping the canvas, then confirm with a pick where the
    // marker is actually drawn (its pill sits above the clamped ground point).
    const ellipsoid = v.scene.globe.ellipsoid;
    for (const entity of ds.entities.values) {
      if (!entity.show || entity.name === selected) continue;
      const carto = ellipsoid.cartesianToCartographic(entity.position.getValue(t));
      const ground = ellipsoid.cartographicToCartesian({ longitude: carto.longitude, latitude: carto.latitude, height: -25 });
      const point = v.scene.cartesianToCanvasCoordinates(ground);
      if (!point || point.x < 40 || point.x > rect.width - 40 || point.y < 40 || point.y > rect.height - 280) continue;
      for (const dy of [0, -8, -18, -28]) {
        const at = { x: Math.round(point.x), y: Math.round(point.y + dy) };
        if (document.elementFromPoint(rect.left + at.x, rect.top + at.y) !== v.scene.canvas) continue;
        const hit = v.scene.pick(at)?.id;
        if (hit?.id?.startsWith?.('maintenance-workOrder-') && hit.name !== selected) return { id: hit.name, ...at };
      }
    }
    return null;
  });
  assert.ok(target, 'a work order marker is on screen to click');
  const box = await page.locator('.cesium-widget canvas').boundingBox();
  await page.mouse.click(box.x + target.x, box.y + target.y);
  await page.waitForTimeout(500);
  now = await state();
  assert.equal(now.id, target.id);
  assert.equal(now.source, 'cesium');
  assert.match(await selectedCard.innerText(), new RegExp(target.id), 'the browser selected it');
  assert.match(await page.locator('.MuiCard-root [aria-current="true"]').innerText(), new RegExp(target.id));
  assert.match(page.url(), /maintenance=work-orders/);
  assert.match(page.url(), new RegExp(`selected=${target.id}`));
  console.log(`✓ map → ${target.id}: list and bottom explorer both followed, URL carries the view`);

  // 6b. Reloading that very URL must NOT reopen the view: Maintenance always starts on the map.
  const carried = page.url();
  assert.match(carried, /maintenance=work-orders/, 'the URL under test really does carry a view');
  await page.goto(carried);
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await page.locator('.app-nav [data-section="maintenance"]').click();
  await page.waitForFunction(() => document.querySelector('.maintenance-workspace .ws-kpi[data-kpi="workOrders"]')?.dataset.state === 'ready', null, { timeout: 60000 });
  assert.equal(await page.locator('.maintenance-workspace .ws-kpi[aria-pressed="true"]').count(), 0,
    'no KPI is chosen after reloading a URL that named one');
  assert.equal(await page.locator('[role="region"][aria-label$="explorer"]').count(), 0,
    'and the bottom browser stays closed');
  assert.equal((await state()).id, null, 'nothing is selected');
  assert.ok(!/maintenance=|selected=/.test(page.url()), 'the stale view is cleared from the URL too');
  console.log('✓ reloading a URL that names a view still opens Maintenance clean');

  // Reopen for the remaining checks, which need the browser on screen.
  await kpi('workOrders').click();
  await page.getByRole('region', { name: 'Work Orders explorer', exact: true }).waitFor({ timeout: 60000 });
  await page.waitForFunction(n => window.__assetExplorer.store.getState().assetsByType.workOrder?.length === n, workOrders.length, { timeout: 60000 });

  // 7. Search and filters are on the browser, and everything follows them: cards, list and map.
  const explorer = page.getByRole('region', { name: 'Work Orders explorer', exact: true });
  const search = explorer.getByRole('textbox', { name: 'Search work orders' });
  await search.fill(target.id);
  await page.waitForTimeout(400);
  assert.equal(await cards.count(), 1, 'the cards narrow with the search');
  assert.equal((await drawn()).shown, 1, 'and so does the map');
  assert.match(await explorer.innerText(), /1 of 854/);
  await search.fill('zzzz-not-a-record');
  await page.waitForTimeout(400);
  assert.equal(await cards.count(), 0);
  assert.match(await explorer.innerText(), /No work orders found/);
  await search.fill('');
  await page.waitForTimeout(400);
  await explorer.getByRole('button', { name: 'High priority' }).click();
  await page.waitForTimeout(500);
  const high = workOrders.filter(row => row.Priority === 'High').length;
  assert.match(await explorer.innerText(), new RegExp(`${high} of 854`));
  const shownCards = await cards.allInnerTexts();
  assert.ok(shownCards.length && shownCards.every(text => /High priority/.test(text)), 'the filter uses the record\'s own priority');
  const drawnHigh = (await drawn()).shown;
  assert.ok(drawnHigh <= high && drawnHigh > 0, `the map shows the filtered set (${drawnHigh})`);
  // "All" is a chip of its own, not just the absence of a filter.
  await explorer.getByRole('button', { name: 'All', exact: true }).click();
  await page.waitForTimeout(400);
  assert.match(await explorer.innerText(), /854 assets/);
  assert.equal((await drawn()).shown, placed.length, 'All puts every record back on the map');
  console.log(`✓ browser search and filters drive the cards, the list and the map (High priority: ${high} of 854)`);

  // 8. The map is still a map, and the workspace closes cleanly.
  const controls = await page.evaluate(() => { const c = window.__viewer.scene.screenSpaceCameraController; return [c.enableRotate, c.enableTranslate, c.enableZoom, c.enableTilt]; });
  assert.ok(controls.every(Boolean), 'pan, zoom, rotate and tilt are never taken away');
  await page.locator('.app-nav [data-section="traffic"]').click();
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.maintenance-workspace .ws-kpis').isVisible(), false, 'leaving Maintenance puts the strip away');
  assert.equal((await drawn()).shown, 0, 'and takes its markers off the map');
  console.log('✓ camera controls untouched, leaving Maintenance clears the workspace');

  // 9. Coming back starts on the map again, then the other four classes browse the same way.
  await page.locator('.app-nav [data-section="maintenance"]').click();
  await page.locator('.maintenance-workspace .ws-kpis').waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.maintenance-workspace .ws-kpi[aria-pressed="true"]').count(), 0, 'returning to Maintenance chooses nothing');
  assert.equal((await drawn()).shown, 0, 'and draws nothing until a KPI is chosen');
  for (const [key, label, singular] of [['tickets', 'Tickets', 'ticket'], ['tasks', 'Tasks', 'task'],
    ['incidents', 'Incidents', 'incident'], ['inspections', 'Inspections', 'inspection']]) {
    await kpi(key).click();
    await page.waitForFunction(name => document.querySelector(`[aria-label="${name} explorer"]`), `${label}`, { timeout: 60000 });
    await page.waitForTimeout(1500);
    const region = page.getByRole('region', { name: `${label} explorer`, exact: true });
    const count = (await page.evaluate(() => window.__assetExplorer.store.getState().assetsByType))[
      { tickets: 'ticket', tasks: 'task', incidents: 'incidentRecord', inspections: 'inspection' }[key]]?.length ?? 0;
    assert.ok(count > 0, `${label} loaded`);
    assert.ok(await cards.count() > 0, `${label} browser has cards`);
    const shown = (await drawn()).shown;
    assert.ok(shown > 0 && shown <= count, `${label}: ${shown} of ${count} on the map`);
    // Card → selection → map → list, for this type too.
    await region.locator('.MuiCardActionArea-root').first().click();
    await page.waitForTimeout(1800);
    const selected = await state();
    assert.ok(selected.id, `${label} card selects`);
    assert.deepEqual((await drawn()).yellow, [selected.id], `${label} marker highlighted`);
    assert.match(await selectedCard.innerText(), new RegExp(selected.id), `${label} browser follows`);
    const details = await page.getByRole('complementary', { name: `${singular.replace(/^./, c => c.toUpperCase())} Details` }).innerText();
    assert.ok(details.split('\n').length > 4, `${label} details show real fields`);
    console.log(`✓ ${label}: ${count} loaded, ${shown} on the map, card → marker → list in step (${selected.id})`);
  }

  // 9. The details panel floats: a record's details can be moved off whatever they cover, the way
  //    every other details panel on this map already could.
  await kpi('workOrders').click();
  await page.getByRole('region', { name: 'Work Orders explorer', exact: true }).locator('.MuiCardActionArea-root').first().click();
  const detailsPanel = page.getByRole('complementary', { name: 'Work Order Details' });
  await detailsPanel.waitFor({ timeout: 30000 });
  assert.equal(await detailsPanel.locator('.panel-drag-handle').count(), 1, 'its heading is the grab handle');
  const startedAt = await detailsPanel.boundingBox();
  const grab = await detailsPanel.locator('h2').boundingBox();
  await page.mouse.move(grab.x + 10, grab.y + 8);
  await page.mouse.down();
  await page.mouse.move(grab.x + 10 - 380, grab.y + 8 + 110, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const droppedAt = await detailsPanel.boundingBox();
  // Exactly the gesture, not merely "somewhere else": a mismatched offset parent would make the
  // panel jump to the pointer on the first move instead of following it.
  assert.equal(Math.round(droppedAt.x - startedAt.x), -380, 'the panel follows the pointer horizontally');
  assert.equal(Math.round(droppedAt.y - startedAt.y), 110, 'and vertically');
  // The arrangement is the user's, so choosing another record must not undo it.
  await page.getByRole('region', { name: 'Work Orders explorer', exact: true }).locator('.MuiCardActionArea-root').nth(1).click();
  await page.waitForTimeout(1800);
  const afterSwitch = await detailsPanel.boundingBox();
  assert.equal(Math.round(afterSwitch.x), Math.round(droppedAt.x), 'it stays where it was put');
  assert.equal(Math.round(afterSwitch.y), Math.round(droppedAt.y));
  // A drag must never swallow the control inside the handle.
  await detailsPanel.getByRole('button', { name: 'Close asset details' }).click();
  await page.waitForTimeout(600);
  assert.equal(await detailsPanel.count(), 0, 'Close inside the heading still closes');
  console.log('✓ details panel floats: dragged by its heading, keeps its place, Close still works');

  assert.deepEqual(problems, []);
  console.log('✓ no page or console errors');
} finally { await browser.close(); }
