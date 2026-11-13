import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'maintenanceTeam');
await page.waitForFunction(() => (window.__maintenance.recordsOf('incidents')?.length ?? 0) > 0, null, { timeout: 180000 });
await page.waitForTimeout(2500);
// Pick a record whose case has a repair stage AND a cost, so the rich paths are exercised.
const target = await page.evaluate(async () => {
  const mod = await import('/src/acs/acsCases.js');
  const payload = await mod.loadAcsTasks();
  const recs = window.__maintenance.recordsOf('tickets');
  for (const rec of recs) {
    const c = mod.caseForIncident(rec, payload);
    if (c && mod.stageOf(c.task, 'REPAIR')
      && c.task.stages.some(s => s.thirdPartyCostUSD)) return { id: rec.id, caseId: c.caseId };
  }
  for (const rec of recs) {
    const c = mod.caseForIncident(rec, payload);
    if (c && mod.stageOf(c.task, 'REPAIR')) return { id: rec.id, caseId: c.caseId, noCost: true };
  }
  return null;
});
console.log('target', JSON.stringify(target));
await page.click('[data-kpi="tickets"]');
await page.waitForTimeout(1800);
await page.evaluate(id => window.__assetExplorer.revealRecord('ticket', id), target.id);
await page.waitForTimeout(2500);
await page.getByRole('button', { name: /Open ACS case/i }).first().click();
await page.waitForTimeout(1000);
for (const name of ['Repair', 'QC/QA', 'Claims']) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(700);
  const text = await page.evaluate(() => {
    const panes = document.querySelectorAll('.MuiDialog-root [class*="MuiDialogContent"] > div');
    return panes[panes.length - 1]?.textContent.replace(/\s+/g, ' ').trim();
  });
  console.log(`\n===== ${name} =====\n${text.slice(0, 620)}`);
  await page.screenshot({ path: `scratchpad/acs-${name.replace('/', '')}.png` });
}
console.log('\n' + (errors.length ? 'ERRORS\n' + errors.slice(0, 3).join('\n') : 'no page errors'));
await browser.close();
