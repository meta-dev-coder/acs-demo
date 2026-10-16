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
const widthBefore = await page.$eval('.si-analysis', el => Math.round(el.getBoundingClientRect().width));
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const f = si.analysis().hotspots.clusters[0].facts.find(x => x.weather && x.laneClosureHours)
    ?? si.analysis().hotspots.clusters[0].facts[0];
  si.selectIncidentById(f.id);
});
await page.waitForTimeout(3000);

const tabStrip = async () => page.$eval('.lab-tabs', el => ({
  clientWidth: Math.round(el.clientWidth), scrollWidth: Math.round(el.scrollWidth),
  overflows: el.scrollWidth > el.clientWidth + 1,
  lastTabRight: Math.round(el.lastElementChild.getBoundingClientRect().right),
  stripRight: Math.round(el.getBoundingClientRect().right),
}));
console.log('analysis width: register', widthBefore, '-> lab',
  await page.$eval('.si-analysis', el => Math.round(el.getBoundingClientRect().width)));
console.log('tab strip:', JSON.stringify(await tabStrip()));
console.log('lab-bar present:', (await page.$$('.lab-bar')).length);
console.log('overview facts:', await page.$$eval('.lab-fact em', ns => ns.map(n => n.textContent.trim())));
for (const id of ['traffic', 'response', 'economics', 'optimization']) {
  await page.click(`[data-lab-tab="${id}"]`);
  await page.waitForTimeout(350);
  const bars = (await page.$$('.lab-bar')).length;
  if (bars) console.log('LAB BAR REAPPEARED on', id);
}
await page.click('[data-lab-tab="optimization"]');
await page.waitForTimeout(400);
console.log('objective dropdown:', (await page.$$('[data-sim="objective"]')).length);
console.log('optimise button:', (await page.$$('[data-sim="optimise"]')).length);
await page.screenshot({ path: 'scratchpad/nohdr.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
