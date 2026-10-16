import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForTimeout(4000);
console.log(JSON.stringify(await page.evaluate(() => {
  const l = document.querySelector('.si-loader');
  if (!l) return { missing: true };
  const r = l.getBoundingClientRect();
  const cs = getComputedStyle(l);
  const mid = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  return {
    rect: { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
    position: cs.position, zIndex: cs.zIndex, background: cs.backgroundColor,
    display: cs.display, opacity: cs.opacity, pointerEvents: cs.pointerEvents,
    parentPointerEvents: getComputedStyle(l.parentElement).pointerEvents,
    atCentre: mid?.className || mid?.tagName,
  };
}), null, 1));
await page.screenshot({ path: 'scratchpad/loader-now.png' });
await browser.close();
