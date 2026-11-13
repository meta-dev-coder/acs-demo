import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'maintenanceTeam');
await page.waitForFunction(() => (window.__maintenance.recordsOf('incidents')?.length ?? 0) > 0,
  null, { timeout: 180000 });
await page.waitForTimeout(2500);
// Select an incident the way the app does.
const picked = await page.evaluate(async () => {
  const rec = window.__maintenance.recordsOf('incidents').find(r => !r.live);
  await window.__assetExplorer.revealRecord('incidentRecord', rec.id);
  return rec.id;
});
console.log('selected', picked);
await page.waitForTimeout(3000);
const btn = await page.evaluate(() => {
  const b = [...document.querySelectorAll('button')].find(x => /Open ACS Case/i.test(x.textContent));
  return b ? { text: b.textContent.trim(), label: b.getAttribute('aria-label') } : null;
});
console.log('button:', JSON.stringify(btn));
if (btn) {
  await page.getByRole('button', { name: /Open ACS case/i }).first().click();
  await page.waitForTimeout(1200);
  console.log(JSON.stringify(await page.evaluate(() => {
    const d = document.querySelector('.MuiDialog-root [role="dialog"]');
    if (!d) return { dialog: false };
    return {
      dialog: true,
      title: d.querySelector('#acs-case-title')?.textContent,
      badge: [...d.querySelectorAll('.MuiChip-label')].map(c => c.textContent).slice(0, 3),
      nav: [...d.querySelectorAll('nav button')].map(b => b.textContent.trim()),
      notRecorded: [...d.querySelectorAll('*')].filter(n => n.children.length === 0
        && /Not recorded/.test(n.textContent)).length,
      text: d.textContent.replace(/\s+/g, ' ').slice(0, 300),
    };
  }), null, 1));
  await page.screenshot({ path: 'scratchpad/acs-case.png' });
  // Walk every section.
  await page.screenshot({ path: 'scratchpad/acs-inspection.png' });
  for (const name of ['Overview', 'Repair', 'QC/QA', 'Claims', 'Related Assets']) {
    await page.getByRole('button', { name, exact: true }).click();
    await page.waitForTimeout(500);
    const head = await page.evaluate(() => document.querySelector('[role="dialog"] [class*="MuiDialogContent"] > div:last-child')?.textContent.replace(/\s+/g, ' ').slice(0, 90));
    console.log(`${name.padEnd(15)} -> ${head}`);
  }
  await page.screenshot({ path: 'scratchpad/acs-claims.png' });
}
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
