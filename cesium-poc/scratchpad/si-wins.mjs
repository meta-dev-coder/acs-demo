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
  const c = si.analysis().hotspots.clusters[0];
  si.selectIncidentById((c.facts.find(x => x.laneClosure) ?? c.facts[0]).id);
});
await page.waitForTimeout(3000);
await page.click('[data-lab-tab="response"]');
await page.waitForTimeout(3000);
const before = await page.evaluate(() => ({
  heading: document.querySelector('.sim-quick h4')?.textContent.trim(),
  rows: [...document.querySelectorAll('.sim-quick-list li')].map(li =>
    li.textContent.replace(/\s+/g, ' ').trim()),
  quickAboveControls: (() => {
    const q = document.querySelector('.sim-quick'), c = document.querySelector('.lab-run');
    return q && c ? q.getBoundingClientRect().top < c.getBoundingClientRect().top : null;
  })(),
  changesTable: document.querySelectorAll('.sim-changes').length,
}));
console.log('BEFORE OPTIMISE', JSON.stringify(before, null, 1));
await page.screenshot({ path: 'scratchpad/wins.png' });

await page.click('[data-sim="optimise"]');
await page.waitForTimeout(9000);
console.log('AFTER OPTIMISE', JSON.stringify(await page.evaluate(() => ({
  changesHeading: [...document.querySelectorAll('.sim-recommend h5')].map(h => h.textContent.trim()),
  changes: [...document.querySelectorAll('.sim-changes tbody tr')].map(tr =>
    [...tr.children].map(c => c.textContent.trim()).join(' | ')),
  note: document.querySelector('.sim-changes + .si-note')?.textContent.replace(/\s+/g, ' ').trim().slice(0, 110),
})), null, 1));
await page.screenshot({ path: 'scratchpad/opt-changes.png', fullPage: false });

await page.click('[data-lab-tab="patrols"]');
await page.waitForTimeout(4000);
console.log('PATROL LABELS', JSON.stringify(await page.evaluate(() => {
  const t = window.__viewer.clock.currentTime;
  const src = window.__viewer.dataSources.getByName('I-595 Safety Intelligence')[0];
  return src.entities.values.filter(e => /^patrol:[^:]+$/.test(String(e.id)) && e.label).map(e => ({
    text: e.label.text.getValue(t),
    plate: e.label.backgroundColor.getValue(t).toCssHexString(),
    ink: e.label.fillColor.getValue(t).toCssHexString(),
    offsetY: e.label.pixelOffset.getValue(t).y,
  }));
}), null, 1));
await page.screenshot({ path: 'scratchpad/best-label.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
