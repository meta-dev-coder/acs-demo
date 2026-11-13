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
// An attenuator repair work order — the demonstration case the spec asks for.
const target = await page.evaluate(() => {
  const at = r => r.raw?.attributes ?? r.raw ?? r;
  const rec = window.__maintenance.recordsOf('workOrders')
    .find(r => at(r)['Asset Type'] === 'Attenuetors' && at(r)['Work Type'] === 'Corrective Repair');
  return rec ? { id: rec.id, assetType: at(rec)['Asset Type'], workType: at(rec)['Work Type'] } : null;
});
console.log('demo case:', JSON.stringify(target));
await page.click('[data-kpi="workOrders"]');
await page.waitForTimeout(1500);
await page.evaluate(id => window.__assetExplorer.revealRecord('workOrder', id), target.id);
await page.waitForTimeout(2500);
await page.getByRole('button', { name: /Open ACS case/i }).first().click();
await page.waitForTimeout(1200);
await page.getByRole('button', { name: 'QC/QA', exact: true }).click();
await page.waitForTimeout(3000);
const read = () => page.evaluate(() => {
  const d = document.querySelector('.MuiDialog-root [role="dialog"]');
  const panes = d.querySelectorAll('[class*="MuiDialogContent"] > div');
  return panes[panes.length - 1]?.textContent.replace(/\s+/g, ' ').trim();
});
console.log('\n=== QC/QA Overview ===\n' + (await read()).slice(0, 700));
await page.screenshot({ path: 'scratchpad/qcqa-overview.png' });
for (const view of ['Checklist', 'Findings', 'Approvals']) {
  await page.getByRole('button', { name: view, exact: true }).click();
  await page.waitForTimeout(800);
  console.log(`\n=== ${view} ===\n` + (await read()).slice(0, 460));
  if (view === 'Findings') await page.screenshot({ path: 'scratchpad/qcqa-findings.png' });
}
console.log('\n' + (errors.length ? 'ERRORS\n' + errors.slice(0, 3).join('\n') : 'no page errors'));
await browser.close();
