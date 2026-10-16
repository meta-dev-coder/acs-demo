import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
const requests = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('request', r => { if (/curated-data|classes|geojson/.test(r.url())) requests.push(r.url()); });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => (window.__safetyIntel.analysis()?.hotspots.clusters.length ?? 0) > 0, null, { timeout: 180000 });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const si = window.__safetyIntel;
  const fact = si.analysis().hotspots.clusters[0].facts.find(f => f.laneClosure && f.laneClosureHours)
    ?? si.analysis().hotspots.clusters[0].facts[0];
  si.selectIncidentById(fact.id);
});
await page.waitForTimeout(3000);

const EXPECT = {
  overview: ['Weather on the record', 'Police report', 'What the model found', 'Recommended action'],
  traffic: ['Demand and capacity', 'Queue over time', 'Secondary-incident exposure', 'not yet modelled'],
  response: ['Response timeline', 'Critical path', 'Sensitivity', 'Explain these numbers',
    'Finding a better response', 'Scenario comparison'],
  economics: ['Economic impact', 'Reconciliation', 'How much rests on the assumptions'],
};
const text = () => page.$eval('.lab-panel', el => el.innerText);
const show = async id => {
  await page.click(`[data-lab-tab="${id}"]`);
  await page.waitForTimeout(400);
  return text();
};

// 1. every tab shows its own sections
for (const [id, wants] of Object.entries(EXPECT)) {
  const body = await show(id);
  const missing = wants.filter(w => !new RegExp(w, 'i').test(body));
  console.log(`${id.padEnd(13)} ${missing.length ? 'MISSING ' + missing.join(' | ') : 'ok'}`);
}

// 2. the header persists and carries 4 KPIs
console.log('header KPIs:', await page.$$eval('.lab-kpi-label', ns => ns.map(n => n.textContent)));
console.log('lab header removed (should be 0):', (await page.$$('.lab-bar')).length);

// 3. inputs survive a tab change
await show('response');
await page.fill('[data-sim-input="towTravelMinutes"]', '9');
await show('traffic');
await page.fill('[data-sim-traffic="blockedLanes"]', '3');
await show('response');
const tow = await page.inputValue('[data-sim-input="towTravelMinutes"]');
await show('traffic');
const blocked = await page.inputValue('[data-sim-traffic="blockedLanes"]');
console.log('inputs persisted across tabs:', { tow, blocked });

// 4. tab switching does not rerun or refetch
const before = await page.evaluate(() => ({
  runs: window.__safetyIntel.state.simulation.all.length,
  id: window.__safetyIntel.activeSimulation.id,
  headline: JSON.stringify(window.__safetyIntel.activeSimulation.headline),
}));
const netBefore = requests.length;
for (const id of ['overview', 'economics', 'response', 'traffic', 'overview']) await show(id);
const after = await page.evaluate(() => ({
  runs: window.__safetyIntel.state.simulation.all.length,
  id: window.__safetyIntel.activeSimulation.id,
  headline: JSON.stringify(window.__safetyIntel.activeSimulation.headline),
}));
console.log('no rerun:', before.runs === after.runs && before.id === after.id
  && before.headline === after.headline, '| network requests during switching:', requests.length - netBefore);

// 5. optimiser results persist across navigation
await show('response');
await page.click('[data-sim="optimise"]');
await page.waitForTimeout(3500);
const hasRec = await page.$$eval('.sim-recommend', n => n.length);
await show('traffic'); await show('overview'); await show('response');
const stillThere = await page.$$eval('.sim-recommend', n => n.length);
console.log('optimiser result survives navigation:', { afterRun: hasRec, afterNavigating: stillThere });

// 6. keyboard
await page.focus('[data-lab-tab="overview"]');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(300);
console.log('arrow key moves tab:', await page.evaluate(() => window.__safetyIntel.state.simTab));
await page.screenshot({ path: 'scratchpad/lab-tabs.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 5).join('\n') : 'no page errors');
await browser.close();
