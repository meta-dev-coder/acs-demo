import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
await page.goto('http://localhost:5188/?demo=i595&acsDemo=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'maintenanceTeam');
await page.waitForFunction(() => (window.__maintenance.recordsOf('acsDemoCases')?.length ?? 0) > 0, null, { timeout: 180000 });
await page.waitForTimeout(2000);
await page.getByRole('tab', { name: 'Case Management' }).click();
await page.waitForTimeout(2500);

for (const id of ['ACS-DEMO-001','ACS-DEMO-002','ACS-DEMO-003','ACS-DEMO-004','ACS-DEMO-005','ACS-DEMO-006','ACS-DEMO-007']) {
  await page.click(`.cw-row[data-case="${id}"]`);
  await page.waitForTimeout(5000);
  const r = await page.evaluate(() => {
    const wb = document.querySelector('.case-workbench');
    const dupes = [...wb.querySelectorAll('.cw-checks > li')].filter(li => {
      const notes = [...li.querySelectorAll('.cw-check-note')].map(n => n.textContent.trim().toLowerCase());
      return new Set(notes).size !== notes.length;
    }).length;
    return {
      id: wb.querySelector('.cw-head h2').textContent,
      status: wb.querySelector('.cw-status').textContent,
      action: wb.querySelector('.cw-action-lead').textContent.trim().slice(0, 80),
      open: [...wb.querySelectorAll('.cw-timeline details')].filter(d => d.open)
        .map(d => `${d.querySelector('.cw-tl-name').textContent}:${d.querySelector('.cw-tl-state').textContent}`),
      claim: [...wb.querySelectorAll('.cw-money span')].map(s => s.textContent).join(' / '),
      weather: wb.querySelector('.cw-section:nth-of-type(1)') ? null : null,
      contextRows: wb.querySelectorAll('.cw-table tbody tr').length,
      trail: wb.querySelectorAll('.cw-trail > li').length,
      inlineEvidence: wb.querySelectorAll('.cw-checks .cw-evidence').length,
      dupes,
    };
  });
  console.log(JSON.stringify(r));
}
console.log('ERRORS', errors.slice(0, 4));
await browser.close();
