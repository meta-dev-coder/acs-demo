import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 200)); });
await p.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await p.waitForTimeout(8000);
await p.selectOption('.app-role select', 'maintenanceTeam');
await p.waitForTimeout(20000);
await p.click('.ws-kpi[data-kpi="acsDemoCases"]');
await p.waitForTimeout(3500);
await p.screenshot({ path: 'scratchpad/demo-slider.png' });
for (const id of ['ACS-DEMO-003', 'ACS-DEMO-005', 'ACS-DEMO-006']) {
  await p.evaluate(target => {
    const s = window.__assetExplorer.store ?? window.__assetExplorer;
    const asset = (s.getState().assetsByType.acsDemoCase ?? []).find(a => a.id === target);
    s.selectAsset(asset, 'card');
  }, id);
  await p.waitForTimeout(1800);
  await p.screenshot({ path: `scratchpad/demo-panel-${id}.png` });
  await p.click('button[aria-label^="Open ACS case"]');
  await p.waitForTimeout(1500);
  for (const tab of ['Overview', 'QC/QA', 'Claim', 'Repair']) {
    await p.click(`.MuiDialog-root nav button:text-is("${tab}")`);
    await p.waitForTimeout(800);
    await p.screenshot({ path: `scratchpad/demo-${id}-${tab.replace(/[^a-z]/gi, '')}.png` });
    if (tab === 'QC/QA') {
      const txt = await p.evaluate(() => [...document.querySelectorAll('.MuiDialog-root [role="dialog"]')].at(-1)
        .innerText.split('Audit Trail')[1]?.slice(0, 1600));
      console.log(`\n##### ${id} ${tab} #####\n` + txt);
    }
  }
  await p.keyboard.press('Escape');
  await p.waitForTimeout(600);
}
console.log('\nERRORS', JSON.stringify(errs.slice(0, 8), null, 1));
await b.close();
