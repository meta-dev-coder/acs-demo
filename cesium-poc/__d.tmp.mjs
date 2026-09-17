import { chromium } from 'playwright';
import { revealLayerGroup } from './e2e/i595Explorer.mjs';
const b = await chromium.launch({ channel: 'chrome', headless: true });
const page = await b.newPage({ viewport: { width: 1500, height: 940 } });
page.on('pageerror', e => console.log('PAGEERROR:', String(e).slice(0, 200)));
await page.addInitScript(() => { window.__declutterDebug = true; });
await page.route('**/src/i595Demo.js*', async r => { const res = await r.fetch();
  await r.fulfill({ response: res, body: (await res.text())
    .replace('import.meta.hot.dispose(() => {', 'window.shields=roadShields; import.meta.hot.dispose(() => {') }); });
await page.goto('http://127.0.0.1:5188/?demo=i595&intro=off');
await revealLayerGroup(page, '#gantries-all');
await page.locator('#gantries-all:not(:disabled)').waitFor({ state: 'attached', timeout: 150000 });
await page.locator('#gantries-all').check({ force: true });
await page.waitForTimeout(4500);
await page.evaluate(() => document.querySelector('#menu-toggle')?.click());
await page.waitForTimeout(600);
await page.locator('[role="region"][aria-label*="explorer"] .MuiCard-root').nth(1).click();
await page.waitForTimeout(3000);
console.log('declutter:', JSON.stringify(await page.evaluate(() => window.__declutterState)));
console.log('136th shield shown:', await page.evaluate(() =>
  [...window.shields.shieldById.entries()].find(([id]) => id.includes('136th'))[1].show));
await b.close();
