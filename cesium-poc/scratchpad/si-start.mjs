import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => (window.__safetyIntel.analysis()?.hotspots.clusters.length ?? 0) > 0, null, { timeout: 180000 });
await page.waitForTimeout(2500);
const look = () => page.evaluate(() => ({
  sideCollapsed: window.__safetyIntel.state.collapsed.side,
  queueVisible: document.querySelector('.si-side-queue')?.offsetWidth > 0,
  investigationVisible: document.querySelector('.si-side-investigation')?.offsetWidth > 0,
  reopenStrip: document.querySelector('.si-side .si-reopen')?.offsetWidth > 0,
  mapWidth: Math.round(window.innerWidth
    - document.querySelector('.si-analysis').getBoundingClientRect().right
    - 46),
}));
console.log('on load        ', JSON.stringify(await look()));
await page.screenshot({ path: 'scratchpad/start-collapsed.png' });
// Selecting something must open it.
await page.evaluate(() => {
  const si = window.__safetyIntel;
  si.selectPlaceById(si.analysis().places[0].id);
});
await page.waitForTimeout(3500);
console.log('after selecting', JSON.stringify(await look()));
await page.screenshot({ path: 'scratchpad/start-selected.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
