import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 120000 });
console.log('after arrival:', JSON.stringify(await page.evaluate(() =>
  ['mainline-eb', 'mainline-wb', 'express'].map(id => [id, window.__layerStore.stateOf(id)]))));
console.log('manual hide  :', JSON.stringify(await page.evaluate(async () => {
  await Promise.all(['mainline-eb', 'mainline-wb', 'express'].map(id => window.__layerStore.setVisible(id, false)));
  return ['mainline-eb', 'mainline-wb', 'express'].map(id => [id, window.__layerStore.stateOf(id)]);
})));
await browser.close();
