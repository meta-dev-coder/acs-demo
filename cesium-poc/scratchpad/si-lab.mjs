import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 120000 });
await page.waitForTimeout(4000);

// Lab with nothing selected: must refuse rather than invent a baseline.
await page.click('[data-tab="lab"]');
await page.waitForTimeout(1200);
console.log('no incident:', await page.$eval('.si-analysis-body', el => el.innerText.slice(0, 90)));

// Select an incident, then open the Lab.
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const fact = si.analysis().hotspots.clusters[0].facts.find(f => f.laneClosure);
  si.selectIncidentById(fact.id);
});
await page.waitForTimeout(3000);
await page.click('[data-tab="lab"]');
await page.waitForTimeout(2500);

const snap = async label => page.evaluate(l => {
  const si = window.__safetyIntel;
  const run = si.activeSimulation;
  return { label: l,
    runs: si.state.simulation?.all.length ?? 0,
    active: run?.label ?? null,
    headline: run?.headline ?? null,
    conserved: run?.queue.conserved,
    binding: run?.timeline.bindingConstraint.id,
    kpis: [...document.querySelectorAll('.si-kpi-label')].map(e => e.textContent.trim()),
    hasQuality: /Data quality/.test(document.querySelector('.si-analysis-body').innerText),
    rows: document.querySelectorAll('.sim-compare tbody tr').length };
}, label);

console.log('1 opened  ', JSON.stringify(await snap('opened')));
await page.screenshot({ path: 'scratchpad/lab-1.png' });

// Run the coordinated preset.
await page.selectOption('[data-sim="preset"]', 'coordinated');
await page.click('[data-sim="run"]');
await page.waitForTimeout(1800);
console.log('2 coord   ', JSON.stringify(await snap('coordinated')));
await page.screenshot({ path: 'scratchpad/lab-2.png' });

// Optimise.
await page.selectOption('[data-sim="objective"]', 'ECONOMIC');
await page.click('[data-sim="optimise"]');
await page.waitForTimeout(4000);
console.log('3 optimise', JSON.stringify(await page.evaluate(() => ({
  opt: window.__safetyIntel.state.optimisation
    ? { evaluated: window.__safetyIntel.state.optimisation.evaluated,
        rejected: window.__safetyIntel.state.optimisation.rejected,
        best: window.__safetyIntel.state.optimisation.best.result.headline.roadwayClearanceMinutes }
    : null,
  recommendVisible: Boolean(document.querySelector('.sim-recommend')),
}))));
await page.screenshot({ path: 'scratchpad/lab-3.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 6).join('\n') : 'no page errors');
await browser.close();
