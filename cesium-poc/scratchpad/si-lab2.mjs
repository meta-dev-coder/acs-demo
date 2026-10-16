import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 180000 });
await page.waitForTimeout(3000);
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const fact = si.analysis().hotspots.clusters[0].facts.find(f => f.laneClosure && f.laneClosureHours);
  si.selectIncidentById(fact?.id ?? si.analysis().hotspots.clusters[0].facts[0].id);
});
await page.waitForTimeout(3500);
const text = await page.$eval('.si-analysis-body', el => el.innerText);
const has = p => new RegExp(p, 'i').test(text);
console.log(JSON.stringify({
  criticalPath: has('Critical path'),
  binding: has('binding'),
  sensitivity: has('Sensitivity'),
  costsNoBenefit: (await page.$$('.sim-verdict-COSTS_WITHOUT_REOPENING')).length,
  explain: has('Explain these numbers'),
  calibration: has('Recorded closure'),
  assumptions: has('How much rests on the assumptions'),
  gates: (await page.$$('.sim-gates tbody tr')).length,
  sensitivityRows: (await page.$$('.sim-sensitivity tbody tr')).length,
}, null, 1));
console.log('explanation:', (text.match(/Lane reopening is[^\n]+/) ?? ['-'])[0].slice(0, 200));
await page.screenshot({ path: 'scratchpad/lab-critical.png', fullPage: false });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 5).join('\n') : 'no page errors');
await browser.close();
