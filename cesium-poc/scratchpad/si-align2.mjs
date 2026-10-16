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
await page.waitForTimeout(3500);
console.log(JSON.stringify(await page.evaluate(() => {
  const box = el => { const r = el.getBoundingClientRect();
    return { text: el.textContent.trim(), top: Math.round(r.top), bottom: Math.round(r.bottom),
      h: Math.round(r.height), left: Math.round(r.left), w: Math.round(r.width) }; };
  const rows = [...document.querySelectorAll('.sim-actions')].map(row => ({
    buttons: [...row.querySelectorAll('button')].map(box),
  }));
  const runRow = document.querySelector('.lab-run');
  return { rows, runRow: runRow ? [...runRow.querySelectorAll('select,button')].map(box) : null };
}), null, 1));
await page.screenshot({ path: 'scratchpad/align2.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
