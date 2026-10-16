import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => document.querySelector('.si-loader')?.hidden === true,
  null, { timeout: 120000 });
await page.waitForTimeout(1500);
console.log(JSON.stringify(await page.evaluate(() => ({
  tabs: [...document.querySelectorAll('.si-tabs [role="tab"]')].map(b => b.textContent.trim()),
  kpis: [...document.querySelectorAll('[data-region="kpis"] *')]
    .filter(n => n.children.length === 0 && n.textContent.trim()).length > 0,
})), null, 1));
// Each remaining tab still opens its panel.
for (const id of ['secondary', 'assets', 'patrol', 'lab', 'accidents']) {
  await page.click(`[data-tab="${id}"]`);
  await page.waitForTimeout(900);
  const text = await page.evaluate(() =>
    document.querySelector('[data-region="analysis"]')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
  console.log(`${id.padEnd(10)} -> ${text}`);
}
await page.screenshot({ path: 'scratchpad/tabs.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
