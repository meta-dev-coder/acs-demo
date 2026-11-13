import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'maintenanceTeam');
await page.waitForFunction(() => (window.__maintenance.recordsOf('incidents')?.length ?? 0) > 0, null, { timeout: 180000 });
await page.waitForTimeout(3000);
console.log('cards:', JSON.stringify(await page.evaluate(() =>
  [...document.querySelectorAll('[data-kpi]')].map(b =>
    b.textContent.replace(/\s+/g, ' ').trim().slice(0, 34)))));

// Widen the period: the register runs to Apr 2026 and the default window is the last 6 months.
await page.selectOption('.maintenance-window-select', 'all');
await page.waitForTimeout(2000);
// 1. Click the Incidents KPI card, like a user.
await page.click('[data-kpi="incidents"]');
await page.waitForTimeout(2500);
await page.screenshot({ path: 'scratchpad/acs-step1-card.png' });

// 2. Click the first incident in the carousel.
const card = page.locator('.asset-explorer-host [class*="MuiCardActionArea"]').first();
console.log('carousel cards:', await page.locator('.asset-explorer-host [class*="MuiCardActionArea"]').count());
await card.click();
await page.waitForTimeout(2500);

// 3. The button must be there.
const btn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Open ACS Case/i.test(x.textContent));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { label: b.getAttribute('aria-label'), visible: r.width > 0 && r.height > 0,
    top: Math.round(r.top), left: Math.round(r.left) };
});
console.log('button:', JSON.stringify(btn));
await page.screenshot({ path: 'scratchpad/acs-step2-panel.png' });

if (btn) {
  await page.getByRole('button', { name: /Open ACS case/i }).first().click();
  await page.waitForTimeout(1200);
  console.log('dialog title:', await page.evaluate(() =>
    document.querySelector('#acs-case-title')?.textContent));
  await page.screenshot({ path: 'scratchpad/acs-step3-dialog.png' });
}
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
