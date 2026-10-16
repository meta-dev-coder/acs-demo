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
console.log(JSON.stringify(await page.evaluate(() => {
  const side = document.querySelector('.si-side').getBoundingClientRect();
  const queue = document.querySelector('.si-side-queue').getBoundingClientRect();
  return {
    detailPane: document.querySelectorAll('.si-side-detail').length,
    detailRegion: document.querySelectorAll('[data-region="detail"]').length,
    sideHeight: Math.round(side.height), queueHeight: Math.round(queue.height),
    queueFillsColumn: Math.round(queue.height) >= Math.round(side.height) - 2,
    rowsVisible: [...document.querySelectorAll('.si-queue-item')]
      .filter(n => { const r = n.getBoundingClientRect(); return r.top >= queue.top && r.bottom <= queue.bottom; }).length,
  };
}), null, 1));
await page.screenshot({ path: 'scratchpad/queue-tall.png' });
// clicking an entry still opens the investigation
await page.click('.si-queue-item');
await page.waitForTimeout(3000);
console.log('investigation opens on click:',
  await page.evaluate(() => !document.querySelector('[data-region="investigation"]').hidden));
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
