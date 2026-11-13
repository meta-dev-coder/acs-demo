import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'maintenanceTeam');
await page.waitForFunction(() => (window.__maintenance.recordsOf('workOrders')?.length ?? 0) > 0, null, { timeout: 180000 });
await page.waitForTimeout(2500);
await page.click('[data-kpi="workOrders"]');
await page.waitForTimeout(1800);
await page.locator('.asset-explorer-host [class*="MuiCardActionArea"]').first().click();
await page.waitForTimeout(2000);
await page.getByRole('button', { name: /Open ACS case/i }).first().click();
await page.waitForTimeout(1200);
console.log(JSON.stringify(await page.evaluate(() => {
  const paper = document.querySelector('.MuiDialog-root .MuiPaper-root');
  const btn = [...document.querySelectorAll('.MuiDialog-root button')]
    .find(b => /Close the ACS case/.test(b.getAttribute('aria-label') ?? ''));
  const p = paper.getBoundingClientRect(); const b = btn.getBoundingClientRect();
  const title = document.querySelector('#acs-case-title').getBoundingClientRect();
  return {
    gapFromRightEdge: Math.round(p.right - b.right),
    gapFromTopEdge: Math.round(b.top - p.top),
    buttonRightOfTitle: Math.round(b.left - title.right),
    overlapsTitle: b.left < title.right && b.top < title.bottom && b.bottom > title.top,
  };
}), null, 1));
await page.screenshot({ path: 'scratchpad/close-btn.png', clip: { x: 390, y: 80, width: 900, height: 150 } });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 3).join('\n') : 'no page errors');
await browser.close();
