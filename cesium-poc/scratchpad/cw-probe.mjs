import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0, 200)));
page.on('console', m => { if (m.type() === 'error' && !/status of (404|403|502)/.test(m.text())) errors.push('console: ' + m.text().slice(0,160)); });
await page.goto('http://localhost:5188/?demo=i595&acsDemo=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'maintenanceTeam');
await page.waitForFunction(() => (window.__maintenance.recordsOf('acsDemoCases')?.length ?? 0) > 0, null, { timeout: 180000 });
await page.waitForTimeout(2500);
await page.getByRole('tab', { name: 'Case Management' }).click();
await page.waitForTimeout(4000);

const snap = () => page.evaluate(() => {
  const wb = document.querySelector('.case-workbench');
  const sections = [...wb.querySelectorAll('.cw-main h3')].map(n => n.textContent);
  const open = [...wb.querySelectorAll('.cw-timeline details')].map(d =>
    `${d.querySelector('.cw-tl-name').textContent}:${d.open ? 'open' : 'closed'}:${d.querySelector('.cw-tl-state').textContent}`);
  return {
    visible: !wb.hidden,
    queueRows: [...wb.querySelectorAll('.cw-row')].map(r => r.dataset.case),
    buckets: [...wb.querySelectorAll('.cw-bucket')].map(b => b.textContent.replace(/\s+/g,' ').trim()),
    selected: wb.querySelector('.cw-row[aria-current="true"]')?.dataset.case,
    header: wb.querySelector('.cw-head h2')?.textContent,
    stages: [...wb.querySelectorAll('.cw-stages li')].map(l => l.textContent.replace(/\s+/g,' ').trim()),
    sections, open,
    actionLead: wb.querySelector('.cw-action-lead')?.textContent.trim().slice(0, 110),
    evidencePills: [...wb.querySelectorAll('.cw-section-action .cw-pill')].map(p => p.textContent.trim()),
    inlineEvidence: wb.querySelectorAll('.cw-checks .cw-evidence').length,
    sliderShown: !!document.querySelector('.asset-explorer-host')?.offsetHeight,
    detailsPanel: !!document.querySelector('.asset-explorer-host .MuiPaper-root'),
    modal: !!document.querySelector('.MuiDialog-root'),
    stripCards: [...document.querySelectorAll('.maintenance-workspace [data-kpi]')].filter(b => !b.hidden).length,
    aomPanel: (document.querySelector('.aom-panel')?.innerHTML ?? '').length,
  };
});
console.log('CASE MGMT', JSON.stringify(await snap(), null, 1));
await page.screenshot({ path: 'scratchpad/cw-workbench.png' });
console.log('ERRORS', errors.slice(0, 5));
await browser.close();
