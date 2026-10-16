import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
const seen = new Set();
for (let i = 0; i < 50; i++) {
  const t = await page.evaluate(() => document.querySelector('.si-loading')?.textContent ?? null);
  if (t) seen.add(t);
  if (await page.evaluate(() => Boolean(window.__safetyIntel.analysis()))) break;
  await page.waitForTimeout(700);
}
console.log('progress messages shown:', [...seen]);
await browser.close();
