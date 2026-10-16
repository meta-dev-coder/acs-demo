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
await page.click('[data-lab-tab="patrols"]');
await page.waitForTimeout(4500);
const labels = () => page.evaluate(() => {
  const t = window.__viewer.clock.currentTime;
  const src = window.__viewer.dataSources.getByName('I-595 Safety Intelligence')[0];
  return src.entities.values.filter(e => e.label && e.label.text)
    .map(e => `${e.id} :: ${e.label.text.getValue(t)}`);
});
console.log('MAP LABELS', JSON.stringify(await labels(), null, 1));
console.log('queue entities', JSON.stringify(await page.evaluate(() => {
  const src = window.__viewer.dataSources.getByName('I-595 Safety Intelligence')[0];
  return src.entities.values.filter(e => String(e.id).startsWith('queue:')).map(e => String(e.id));
})));

// Click a fleet row -> the card opens.
await page.click('.sim-patrols tbody tr:nth-child(3)');
await page.waitForTimeout(1200);
console.log('CARD', JSON.stringify(await page.evaluate(() => ({
  title: document.querySelector('.sim-patrol-card h4')?.textContent.trim(),
  facts: [...document.querySelectorAll('.sim-patrol-facts div')].map(d =>
    `${d.querySelector('dt').textContent}: ${d.querySelector('dd').textContent}`),
  effect: document.querySelector('.sim-patrol-card .si-lede')?.textContent.replace(/\s+/g, ' ').trim(),
})), null, 1));
await page.screenshot({ path: 'scratchpad/patrol-card.png' });

// And the real map-click path: click the canvas where SIM-RR-05's billboard is.
const at = await page.evaluate(() => {
  const viewer = window.__viewer;
  const src = viewer.dataSources.getByName('I-595 Safety Intelligence')[0];
  const e = src.entities.getById('patrol:SIM-RR-05');
  const p = e.position.getValue(viewer.clock.currentTime);
  const w = viewer.scene.cartesianToCanvasCoordinates(p);
  const r = viewer.canvas.getBoundingClientRect();
  return w ? { x: r.left + w.x, y: r.top + w.y } : null;
});
console.log('clicking at', JSON.stringify(at));
if (at) { await page.mouse.click(at.x, at.y); await page.waitForTimeout(1500); }
console.log('AFTER MAP CLICK', JSON.stringify(await page.evaluate(() => ({
  title: document.querySelector('.sim-patrol-card h4')?.textContent.trim(),
  travel: [...document.querySelectorAll('.sim-patrol-facts div')]
    .find(d => d.querySelector('dt').textContent.includes('Travel'))?.textContent,
  tab: document.querySelector('.lab-tabs [aria-selected="true"]')?.textContent.trim(),
})), null, 1));
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
