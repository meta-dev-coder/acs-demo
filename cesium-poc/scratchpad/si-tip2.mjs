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
console.log(JSON.stringify(await page.evaluate(() => {
  const rects = [...document.querySelectorAll('.sim-queue rect[data-tip]')];
  const tall = rects.reduce((best, n) => (Number(n.getAttribute('height')) > Number(best.getAttribute('height')) ? n : best), rects[0]);
  const box = tall.getBoundingClientRect();
  const atPoint = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  return {
    bars: rects.length,
    box: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
    elementAtCentre: atPoint ? `${atPoint.tagName}.${atPoint.getAttribute('class') ?? ''}` : null,
    hasTip: Boolean(atPoint?.closest?.('[data-tip]')),
    svgPointerEvents: getComputedStyle(document.querySelector('.sim-queue')).pointerEvents,
    rectPointerEvents: getComputedStyle(tall).pointerEvents,
  };
}), null, 1));
await browser.close();
