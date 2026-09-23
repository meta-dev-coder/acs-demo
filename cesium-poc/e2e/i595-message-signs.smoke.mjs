import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { openLayers } from './i595Explorer.mjs';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/i595Demo.js*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace(
      'window.__assetExplorer = assetExplorer;',
      'window.__assetExplorer = assetExplorer; window.__messageSignsViewer = viewer;') });
  });
  let detailCalls = 0;
  await page.route('**/api/i595/message-signs*', route => route.fulfill({ json: {
    source: 'FL511', sourceStatus: 'LIVE', signs: [
      { id: '169860', title: 'Message Sign 169860', longitude: -80.28, latitude: 26.106 },
      { id: '150361', title: 'Message Sign 150361', longitude: -80.31035, latitude: 26.113934 },
    ],
  } }));
  await page.route('**/api/i595/message-signs/*', async route => {
    detailCalls++;
    const id = route.request().url().split('/').at(-1);
    if (id === '169860') await new Promise(resolve => setTimeout(resolve, 500));
    await route.fulfill({ json: { id, title: `Sign ${id}`, message: id === '169860' ? '' : 'ROAD WORK AHEAD', updatedAt: 'Sep 17 2026, 3:46 AM', sourceStatus: 'LIVE' } });
  });
  await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
  await page.locator('body[data-startup="ready"]').waitFor({ timeout: 90000 });
  await openLayers(page);
  const toggle = page.locator('.quick-rail [data-layer="message-signs"]');
  await toggle.click();
  await page.getByRole('region', { name: 'Message Signs explorer', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Select Message Sign 169860', exact: true }).first().click();
  await page.getByText('No message displayed', { exact: true }).waitFor();
  assert.ok(detailCalls > 0);
  assert.equal(await page.evaluate(() => {
    const viewer = window.__messageSignsViewer;
    const source = viewer.dataSources.getByName('I-595 Message Signs')[0];
    return source.show && source.entities.values.length === 2;
  }), true, 'sign markers are visible in the Cesium data source');
  assert.match(await page.locator('.message-sign-details').innerText(), /Sep 17 2026/);
  await page.getByRole('button', { name: 'Select Message Sign 150361', exact: true }).first().click();
  await page.getByText('ROAD WORK AHEAD', { exact: true }).waitFor();
  // Late responses must never overwrite the most recently selected sign.
  await page.getByRole('button', { name: 'Select Message Sign 169860', exact: true }).first().click();
  await page.getByRole('button', { name: 'Select Message Sign 150361', exact: true }).first().click();
  await page.waitForTimeout(650);
  assert.match(await page.locator('.message-sign-details').innerText(), /ROAD WORK AHEAD/);
  const mapState = await page.evaluate(() => {
    const state = window.__assetExplorer.store.getState();
    const source = window.__assetExplorer.sources.find(source => source.assetType === 'messageSign');
    return { count: source.read().length, selected: state.selectedAsset.id };
  });
  assert.deepEqual(mapState, { count: 2, selected: '150361' });
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: 'Close message sign details', exact: true }).click();
  const point = await page.evaluate(() => {
    const viewer = window.__messageSignsViewer;
    const entity = viewer.dataSources.getByName('I-595 Message Signs')[0].entities.getById('message-sign-150361');
    const screen = viewer.scene.cartesianToCanvasCoordinates(entity.position.getValue(viewer.clock.currentTime));
    const rect = viewer.canvas.getBoundingClientRect();
    for (let dy = -70; dy <= 30; dy += 5) for (let dx = -30; dx <= 30; dx += 5) {
      const position = { x: screen.x + dx, y: screen.y + dy };
      if (viewer.scene.pick(position)?.id === entity) return { x: rect.left + position.x, y: rect.top + position.y };
    }
    throw new Error(`Marker not pickable near ${screen.x}, ${screen.y}`);
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => window.__assetExplorer.store.getState().selectedAsset?.id === '150361', null, { timeout: 5000 });
  await page.getByText('ROAD WORK AHEAD', { exact: true }).waitFor();
  await page.locator('.quick-rail [data-layer="cameras"]').click();
  await page.waitForFunction(() => document.querySelector('.message-sign-details').hidden);
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(errors, []);
  console.log('Message sign explorer, details, empty message and layer switching passed.');
} finally { await browser.close(); }
