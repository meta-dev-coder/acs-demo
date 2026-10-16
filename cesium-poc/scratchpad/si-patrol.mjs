import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => (window.__safetyIntel.analysis()?.hotspots.clusters.length ?? 0) > 0, null, { timeout: 180000 });
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const f = si.analysis().hotspots.clusters[0].facts.find(x => x.laneClosure) ?? si.analysis().hotspots.clusters[0].facts[0];
  si.selectIncidentById(f.id);
});
await page.waitForTimeout(3500);
console.log('tabs:', await page.$$eval('[data-lab-tab]', ns => ns.map(n => n.textContent.trim())));
await page.click('[data-lab-tab="patrols"]');
await page.waitForTimeout(1500);
console.log(JSON.stringify(await page.evaluate(() => {
  const d = window.__safetyIntel;
  const rows = [...document.querySelectorAll('.sim-patrols tbody tr')];
  const cmp = [...document.querySelectorAll('.sim-patrol-compare tbody tr')];
  return {
    fleet: rows.length,
    dispatchable: rows.filter(r => !r.classList.contains('is-out')).length,
    comparisonRows: cmp.length,
    simulatedBanner: /SIMULATED/.test(document.querySelector('.lab-panel').innerText),
    lede: document.querySelector('.lab-panel .si-lede')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 140),
  };
}), null, 1));
// Run with the nearest patrol
await page.click('[data-sim="patrol"]');
await page.waitForTimeout(2500);
console.log('after running nearest:', await page.evaluate(() => {
  const si = window.__safetyIntel;
  return { runs: si.state.simulation.all.length, active: si.activeSimulation.label,
    clearance: si.activeSimulation.headline.roadwayClearanceMinutes,
    cost: si.activeSimulation.headline.totalModelledCostUSD };
}));
await page.screenshot({ path: 'scratchpad/patrols.png' });
// Wide mode
const width = () => page.$eval('.si-analysis', el => Math.round(el.getBoundingClientRect().width));
const before = await width();
await page.click('[data-wide]');
await page.waitForTimeout(600);
const after = await width();
await page.click('[data-wide]');
await page.waitForTimeout(600);
console.log('panel width:', before, '-> wide', after, '-> back', await width());
await page.click('[data-wide]');
await page.waitForTimeout(600);
await page.screenshot({ path: 'scratchpad/patrols-wide.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
