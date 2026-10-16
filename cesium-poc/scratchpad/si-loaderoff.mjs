import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');

const state = () => page.evaluate(() => {
  const all = [...document.querySelectorAll('.si-loader')];
  const l = all[0];
  if (!l) return { count: 0 };
  const cs = getComputedStyle(l);
  const mid = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  return { count: all.length, hidden: l.hidden, display: cs.display, opacity: cs.opacity,
    // The real question: is anything of the loader under the pointer at the centre of the screen?
    coversCentre: Boolean(mid?.closest?.('.si-loader')),
    centre: mid?.className || mid?.tagName };
});
await page.waitForFunction(() => document.querySelector('.si-loader')?.hidden === true,
  null, { timeout: 120000 });
// Watch for 12 s AFTER it goes, which is where it came back before.
for (let i = 0; i < 6; i += 1) {
  await page.waitForTimeout(2000);
  console.log(`+${(i + 1) * 2}s`, JSON.stringify(await state()));
}
await page.screenshot({ path: 'scratchpad/after-load.png' });
// And a round trip away and back.
await page.selectOption('.app-role select', 'tmc');
await page.waitForTimeout(2500);
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForTimeout(3000);
console.log('after round trip', JSON.stringify(await state()));
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
