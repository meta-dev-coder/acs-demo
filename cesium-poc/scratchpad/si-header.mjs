import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => (window.__safetyIntel.analysis()?.hotspots.clusters.length ?? 0) > 0, null, { timeout: 180000 });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const fact = si.analysis().hotspots.clusters[0].facts.find(f => f.weather && f.laneClosureHours)
    ?? si.analysis().hotspots.clusters[0].facts[0];
  si.selectIncidentById(fact.id);
});
await page.waitForTimeout(3000);
console.log('screen KPI cards:', await page.$$eval('.si-kpi .si-kpi-label', ns => ns.map(n => n.textContent.trim())));
console.log('lab header facts:', await page.$$eval('.lab-fact em', ns => ns.map(n => n.textContent.trim())));
console.log('lab header has KPIs:', (await page.$$('.lab-kpi')).length);
console.log('run button in header:', (await page.$$('.lab-bar [data-sim="run"]')).length);
await page.click('[data-lab-tab="response"]');
await page.waitForTimeout(500);
console.log('run button on Response Analysis:', (await page.$$('.lab-run [data-sim="run"]')).length,
  '| scenario select:', (await page.$$('.lab-run [data-sim="preset"]')).length);
await page.screenshot({ path: 'scratchpad/header-fixed.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
