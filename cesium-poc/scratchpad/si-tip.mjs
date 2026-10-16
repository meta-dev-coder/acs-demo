import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 120000 });
await page.waitForTimeout(3500);

const tipText = () => page.evaluate(() => {
  const t = document.querySelector('.si-tip');
  return t && !t.hidden ? t.textContent : null;
});
const hoverBar = async (selector, nth) => {
  const bar = (await page.$$(selector))[nth];
  if (!bar) return 'no bar';
  await bar.hover();
  await page.waitForTimeout(220);
  return tipText();
};

// Accidents charts first.
console.log('month bar 2 :', await hoverBar('.si-chart rect[data-tip]', 2));
console.log('month bar 9 :', await hoverBar('.si-chart rect[data-tip]', 9));
console.log('away        :', (await page.mouse.move(900, 600), await page.waitForTimeout(200), await tipText()));
console.log('back again  :', await hoverBar('.si-chart rect[data-tip]', 4));

// Re-render the panel, then hover again — this is what used to kill it.
await page.evaluate(() => {
  const si = window.__safetyIntel;
  si.selectIncidentById(si.analysis().hotspots.clusters[0].facts[0].id);
});
await page.waitForTimeout(3000);
console.log('lab tab:', await page.evaluate(() => window.__safetyIntel.state.tab),
  'queue bars:', await page.$$eval('.sim-queue rect[data-tip]', n => n.length).catch(() => 'none'),
  'tallest:', await page.$$eval('.sim-queue rect[data-tip]', ns => {
    let best = 0, idx = -1;
    ns.forEach((n, i) => { const h = Number(n.getAttribute('height')); if (h > best) { best = h; idx = i; } });
    return { idx, h: best };
  }).catch(() => null));
const tall = await page.$$eval('.sim-queue rect[data-tip]', ns => {
  let best = 0, idx = 0; ns.forEach((n, i) => { const h = Number(n.getAttribute('height')); if (h > best) { best = h; idx = i; } }); return idx;
}).catch(() => 0);
console.log('tallest queue bar:', await hoverBar('.sim-queue rect[data-tip]', tall));
await page.screenshot({ path: 'scratchpad/tip.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 5).join('\n') : 'no page errors');
await browser.close();
