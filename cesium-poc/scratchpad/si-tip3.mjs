import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 120000 });
await page.evaluate(() => {
  const si = window.__safetyIntel;
  si.selectIncidentById(si.analysis().hotspots.clusters[0].facts[0].id);
});
await page.waitForTimeout(3500);
const tipText = () => page.evaluate(() => {
  const t = document.querySelector('.si-tip');
  return t && !t.hidden ? t.textContent : null;
});
// Hover eight consecutive queue bars without leaving the chart: this is the "works once" case.
const bars = await page.$$('.sim-queue rect[data-tip]');
await bars[9].hover();
await page.waitForTimeout(250);
const seen = [];
for (const i of [3, 5, 7, 9, 11, 13, 15, 17]) {
  const box = await bars[i].boundingBox();
  if (!box) { seen.push('offscreen'); continue; }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(140);
  seen.push(await tipText());
}
console.log(seen.map((t, i) => ` ${i}: ${t}`).join('\n'));
console.log('distinct:', new Set(seen.filter(Boolean)).size, 'of', seen.length);
await page.screenshot({ path: 'scratchpad/tip-queue.png' });
await browser.close();
