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

for (const kpi of ['incidents', 'tickets', 'workOrders', 'inspections', 'atRiskAssets']) {
  await page.click(`[data-kpi="${kpi}"]`);
  await page.waitForTimeout(2200);
  const cards = page.locator('.asset-explorer-host [class*="MuiCardActionArea"]');
  if (await cards.count() === 0) { console.log(`${kpi.padEnd(13)} no records in window`); continue; }
  await cards.first().click();
  await page.waitForTimeout(2000);
  const found = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find(x => /Open ACS Case/i.test(x.textContent));
    const head = document.querySelector('.asset-explorer-host h6, .asset-explorer-host [class*="MuiTypography-subtitle"]');
    return { panel: head?.textContent?.trim().slice(0, 28) ?? '?',
      button: b?.getAttribute('aria-label') ?? null };
  });
  console.log(`${kpi.padEnd(13)} panel="${found.panel}"  button=${found.button ?? 'ABSENT'}`);
  if (found.button) {
    await page.getByRole('button', { name: /Open ACS case/i }).first().click();
    await page.waitForTimeout(900);
    const title = await page.evaluate(() => document.querySelector('#acs-case-title')?.textContent);
    console.log(`${''.padEnd(13)}   -> dialog ${title}`);
    if (kpi === 'tickets') await page.screenshot({ path: 'scratchpad/acs-ticket.png' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
}
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 3).join('\n') : 'no page errors');
await browser.close();
