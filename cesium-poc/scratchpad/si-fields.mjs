import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForTimeout(22000);
console.log(JSON.stringify(await page.evaluate(() => {
  const rows = window.__maintenance.recordsForType('inspection', { live: false });
  const sample = rows.slice(0, 3).map(r => Object.keys(r));
  const attrs = rows.slice(0, 2).map(r => r.attributes ?? r.raw?.attributes ?? null);
  const keys = new Set();
  for (const r of rows.slice(0, 60)) for (const k of Object.keys(r.raw?.attributes ?? r.attributes ?? {})) keys.add(k);
  const wo = window.__maintenance.recordsForType('workOrder', { live: false })[0];
  return { count: rows.length, sample, attrKeys: [...keys], attrs0: attrs[0], woKeys: Object.keys(wo ?? {}),
    woAttrs: Object.keys(wo?.raw?.attributes ?? wo?.attributes ?? {}) };
}), null, 1));
await browser.close();
