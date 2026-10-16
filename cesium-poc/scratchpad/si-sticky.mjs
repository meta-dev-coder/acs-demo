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
  const f = si.analysis().hotspots.clusters[0].facts.find(x => x.weather && x.laneClosureHours)
    ?? si.analysis().hotspots.clusters[0].facts[0];
  si.selectIncidentById(f.id);
});
await page.waitForTimeout(3000);
console.log('tabs:', await page.$$eval('[data-lab-tab]', ns => ns.map(n => n.textContent.trim())));
// Scroll the panel and check nothing shows above the sticky strip.
await page.evaluate(() => { document.querySelector('.si-analysis-body').scrollTop = 600; });
await page.waitForTimeout(400);
console.log(JSON.stringify(await page.evaluate(() => {
  const strip = document.querySelector('.lab-tabs').getBoundingClientRect();
  const body = document.querySelector('.si-analysis-body').getBoundingClientRect();
  const above = [...document.querySelectorAll('.lab-panel *')].filter(el => {
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.bottom > body.top && r.bottom < strip.top + 1 && el.textContent.trim();
  });
  return { stripTop: Math.round(strip.top), bodyTop: Math.round(body.top),
    gapAboveStrip: Math.round(strip.top - body.top),
    contentVisibleAboveStrip: above.length,
    stripOpaque: getComputedStyle(document.querySelector('.lab-tabs')).backgroundColor };
}), null, 1));
await page.screenshot({ path: 'scratchpad/sticky.png' });
await page.click('[data-lab-tab="response"]');
await page.waitForTimeout(500);
console.log('run controls aligned:', JSON.stringify(await page.evaluate(() => {
  const select = document.querySelector('.lab-run select').getBoundingClientRect();
  const button = document.querySelector('.lab-run .si-action').getBoundingClientRect();
  return { selectBottom: Math.round(select.bottom), buttonBottom: Math.round(button.bottom),
    selectHeight: Math.round(select.height), buttonHeight: Math.round(button.height) };
})));
console.log('response tab has comparison:',
  /Scenario comparison/i.test(await page.$eval('.lab-panel', el => el.innerText)),
  '| optimise button:', (await page.$$('[data-sim="optimise"]')).length);
await page.screenshot({ path: 'scratchpad/response-all.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
