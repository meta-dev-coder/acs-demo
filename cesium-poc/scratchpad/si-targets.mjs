import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForTimeout(30000);
console.log(JSON.stringify(await page.evaluate(() => {
  const t = window.__safetyIntel.state.targets.records;
  const a = window.__safetyIntel.analysis();
  return { note: window.__safetyIntel.state.targets.note, n: t.length,
    all: t.map(r => [(r.attributes??r).name, (r.attributes??r).repair_times_days]),
    assetTypes: [...new Set(a.defects.map(d => d.assetType))] };
}), null, 1));
await browser.close();
