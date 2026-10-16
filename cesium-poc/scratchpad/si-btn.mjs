import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => (window.__safetyIntel.analysis()?.hotspots.clusters.length ?? 0) > 0, null, { timeout: 180000 });
await page.evaluate(() => {
  const si = window.__safetyIntel;
  si.selectIncidentById(si.analysis().hotspots.clusters[0].facts[0].id);
});
await page.waitForTimeout(2500);
await page.click('[data-lab-tab="response"]');
await page.waitForTimeout(600);
console.log(JSON.stringify(await page.evaluate(() => {
  const btns = [...document.querySelectorAll('.lab-optimise .sim-actions .si-action')];
  return btns.map(b => { const r = b.getBoundingClientRect();
    return { text: b.textContent.trim(), top: Math.round(r.top), bottom: Math.round(r.bottom),
      h: Math.round(r.height) }; });
}), null, 1));
await page.screenshot({ path: 'scratchpad/btn.png', clip: await page.$eval('.lab-optimise', el => {
  const r = el.getBoundingClientRect();
  return { x: r.x - 4, y: r.y - 4, width: Math.min(r.width + 8, 620), height: r.height + 8 };
}) });
await browser.close();
