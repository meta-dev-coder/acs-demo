import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForTimeout(38000);

const snap = async label => page.evaluate(l => {
  const a = window.__safetyIntel.analysis();
  const kpi = [...document.querySelectorAll('.si-kpi')];
  return {
    label: l,
    visible: !document.querySelector('.si-workspace').hidden,
    loaded: Boolean(a),
    records: a?.provenance.records ?? null,
    clusters: a?.hotspots.clusters.length ?? null,
    clustered: a?.hotspots.clustered ?? null,
    queue: a?.queue.total ?? null,
    bands: a?.queue.counts ?? null,
    byDomain: a?.byDomain ?? a?.queue.byDomain ?? null,
    defects: a?.defects.length ?? null,
    openDefects: a?.summary.openDefects ?? null,
    mttr: a?.summary.mttrDays ?? null,
    targets: window.__safetyIntel.state.targets.records.length,
    hazards: a?.hazards.hazards ?? null,
    secondary: a?.secondary.observed.count ?? null,
    modelled: a?.secondary.modelled?.count ?? null,
    kpiTiles: kpi.length,
    kpiUnavailable: kpi.filter(k => k.classList.contains('si-kpi-out')).length,
    queueRows: document.querySelectorAll('.si-queue-item').length,
    replay: document.querySelector('.si-scrub')?.max ?? null,
    mapMarks: (() => { const v = window.__viewer; for (let i = 0; i < v.dataSources.length; i++) {
      const s = v.dataSources.get(i); if (s.name === 'I-595 Safety Intelligence') return s.entities.values.length; } return 0; })(),
    selected: window.__safetyIntel.state.selectedId,
    focus: window.__safetyIntel.state.focusHotspot,
    tab: window.__safetyIntel.state.tab,
  };
}, label);

console.log(JSON.stringify(await snap('arrival'), null, 1));
await page.screenshot({ path: 'scratchpad/si-arrival.png' });

// Click the first queue entry.
await page.click('.si-queue-item');
await page.waitForTimeout(3500);
console.log(JSON.stringify(await snap('entry-selected'), null, 1));
await page.screenshot({ path: 'scratchpad/si-entry.png' });

// Each tab renders.
for (const tab of ['secondary', 'assets', 'patrol', 'outcomes', 'accidents']) {
  await page.click(`[data-tab="${tab}"]`);
  await page.waitForTimeout(900);
  const text = await page.$eval('.si-analysis-body', el => el.innerText.length);
  console.log(`tab ${tab}: ${text} chars`);
  await page.screenshot({ path: `scratchpad/si-${tab}.png` });
}

// Replay.
await page.click('.si-play');
await page.waitForTimeout(4000);
const playing = await page.evaluate(() => window.__safetyIntel.state.replay);
console.log('replay', JSON.stringify(playing));
await page.click('.si-play');
await page.screenshot({ path: 'scratchpad/si-replay.png' });

// Hotspot focus from the list.
await page.click('[data-tab="accidents"]');
await page.waitForTimeout(600);
const hotspot = await page.$('[data-hotspot]');
if (hotspot) { await hotspot.click(); await page.waitForTimeout(4000); }
console.log(JSON.stringify(await snap('hotspot-focus'), null, 1));
await page.screenshot({ path: 'scratchpad/si-hotspot.png' });

// Does the TMC still work after this screen existed? Switch to it and read its own state.
await page.selectOption('.app-role select', 'tmc');
await page.waitForTimeout(8000);
console.log('tmc after:', JSON.stringify(await page.evaluate(() => ({
  section: document.body.dataset.section,
  siHidden: document.querySelector('.si-workspace').hidden,
  tmcVisible: Boolean(document.querySelector('.tmc-workspace')) && !document.querySelector('.tmc-workspace').hidden,
}))));

console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 12).join('\n') : 'no page errors');
await browser.close();
