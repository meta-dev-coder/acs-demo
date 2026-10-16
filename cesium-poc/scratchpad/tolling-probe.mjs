import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__tolling, null, { timeout: 60000 });
await page.waitForTimeout(16000);
// The role switch opens the section; a second click would land on the canvas and deselect.
await page.selectOption('.app-role select', 'tolling');
const snap = async label => page.evaluate(l => {
  const v = window.__viewer; const c = v.camera.positionCartographic; const d = r => r * 180 / Math.PI;
  const s = window.__assetExplorer.store.getState();
  let markers = 0;
  for (let i = 0; i < v.dataSources.length; i++) if (v.dataSources.get(i).name === 'I-595 Tolling') markers = v.dataSources.get(i).entities.values.length;
  return { label: l, layer: window.__layerStore.stateOf('gantries'),
    model: window.__cesiumModels.modelById.get('i595-gantry-1-toll-plaza')?.show ?? null,
    type: s.activeExplorerType, selected: s.selectedAsset?.id ?? null, markers,
    counts: Object.fromEntries(Object.entries(s.assetsByType).filter(([k]) => /gantr/i.test(k)).map(([k, a]) => [k, a.length])),
    heading: Math.round(d(v.camera.heading)), height: Math.round(c.height) };
}, label);
await page.waitForTimeout(12000);
console.log(JSON.stringify(await snap('arrival')));
await page.screenshot({ path: 'scratchpad/tolling-arrival.png' });
await page.click('.ws-kpis [data-kpi="express"]');
await page.waitForTimeout(6000);
console.log(JSON.stringify(await snap('express')));
await page.screenshot({ path: 'scratchpad/tolling-express.png' });
await page.click('.ws-kpis [data-kpi="tollGantries"]');
await page.waitForTimeout(9000);
console.log(JSON.stringify(await snap('toll')));
await page.screenshot({ path: 'scratchpad/tolling-toll.png' });
await page.click('.ws-kpis [data-kpi="payment"]');
await page.waitForTimeout(5000);
console.log(JSON.stringify(await snap('payment')));
console.log(errors.length ? 'ERRORS ' + [...new Set(errors)].slice(0, 4).join(' | ') : 'no page errors');
await browser.close();
