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
await page.waitForTimeout(3000);
await page.click('[data-lab-tab="patrols"]');
await page.waitForTimeout(4500);
console.log(JSON.stringify(await page.evaluate(() => {
  const t = window.__viewer.clock.currentTime;
  const src = window.__viewer.dataSources.getByName('I-595 Safety Intelligence')[0];
  const labels = src.entities.values.filter(e => /^patrol:[^:]+$/.test(String(e.id)) && e.label);
  const deltas = [...document.querySelectorAll('.sim-delta')];
  // One client rect per rendered line of text.
  const lineCount = el => { const r = document.createRange(); r.selectNodeContents(el);
    return r.getClientRects().length; };
  return {
    labelsWithPlate: labels.filter(e => e.label.showBackground?.getValue?.(t) === true).length,
    labelTexts: labels.map(e => e.label.text.getValue(t)),
    recommendedLine: document.querySelector('.sim-recommend-line')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 120),
    bestTagsInTables: document.querySelectorAll('.sim-pick-tag').length,
    deltaText: deltas.map(n => n.textContent.trim()),
    deltaLines: deltas.map(lineCount),
    deltaOverflows: deltas.map(n => n.scrollWidth > n.clientWidth + 1),
    flooredTags: document.querySelectorAll('.sim-floored').length,
  };
}), null, 1));
await page.screenshot({ path: 'scratchpad/pick.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
