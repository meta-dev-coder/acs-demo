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
// Find an incident whose case is a task that has a cost AND coordinates.
const target = await page.evaluate(async () => {
  const mod = await import('/src/acs/acsCases.js');
  const payload = await mod.loadAcsTasks();
  const recs = window.__maintenance.recordsOf('incidents').filter(r => !r.live);
  const rich = task => task.latitude != null
    && task.stages.some(s => s.thirdPartyCostUSD) && task.policeCaseNumber;
  for (const rec of recs) {
    const c = mod.caseForIncident(rec, payload);
    if (c && rich(c.task)) return { incident: rec.id, caseId: c.caseId, task: c.task.taskNumber };
  }
  // Fall back to any task with a cost.
  for (const rec of recs) {
    const c = mod.caseForIncident(rec, payload);
    if (c && c.task.stages.some(s => s.thirdPartyCostUSD)) {
      return { incident: rec.id, caseId: c.caseId, task: c.task.taskNumber, partial: true };
    }
  }
  return null;
});
console.log('target', JSON.stringify(target));
await page.evaluate(id => window.__assetExplorer.revealRecord('incidentRecord', id), target.incident);
await page.waitForTimeout(3000);
await page.getByRole('button', { name: /Open ACS case/i }).first().click();
await page.waitForTimeout(1000);
for (const name of ['Claims', 'Related Assets', 'Repair']) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(600);
  console.log(`--- ${name} ---`);
  console.log((await page.evaluate(() => {
    const d = document.querySelector('.MuiDialog-root [role="dialog"]');
    const body = d.querySelectorAll('[class*="MuiDialogContent"] > div');
    return body[body.length - 1]?.textContent.replace(/\s+/g, ' ').trim().slice(0, 330);
  })));
  if (name === 'Claims') await page.screenshot({ path: 'scratchpad/acs-rich-claims.png' });
}
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
