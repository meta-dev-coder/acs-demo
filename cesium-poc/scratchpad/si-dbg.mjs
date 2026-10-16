import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
page.on('pageerror', e => console.log('PAGEERROR', String(e).slice(0, 200)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => (window.__safetyIntel.analysis()?.hotspots.clusters.length ?? 0) > 0, null, { timeout: 180000 });
await page.waitForTimeout(1500);
const peek = async label => console.log(label, JSON.stringify(await page.evaluate(() => ({
  tab: window.__safetyIntel.state.tab,
  wide: window.__safetyIntel.state.wide,
  incidentId: window.__safetyIntel.selection.incidentId,
  classes: [...document.querySelector('.si-workspace').classList].filter(c => c.startsWith('is-')),
  width: Math.round(document.querySelector('.si-analysis').getBoundingClientRect().width),
}))));
await peek('start     ');
await page.click('[data-wide]');
await page.waitForTimeout(400);
await peek('after wide');
await page.click('[data-tab="lab"]');
await page.waitForTimeout(1500);
await peek('after lab ');
await browser.close();
