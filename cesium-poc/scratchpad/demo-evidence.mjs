import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await p.waitForTimeout(8000);
await p.selectOption('.app-role select', 'maintenanceTeam');
await p.waitForTimeout(20000);
const kpi = await p.evaluate(() => {
  const b = document.querySelector('.ws-kpi[data-kpi="acsDemoCases"]');
  return { count: b.querySelector('[data-count]').textContent, note: b.querySelector('[data-note]').textContent };
});
console.log('KPI:', JSON.stringify(kpi));
await p.click('.ws-kpi[data-kpi="acsDemoCases"]');
await p.waitForTimeout(3500);
console.log('cards:', JSON.stringify(await p.evaluate(() =>
  [...document.querySelectorAll('.asset-explorer-host .MuiCard-root')].map(c => c.innerText.replace(/\n/g,' | ')))  , null, 1));
await p.screenshot({ path: 'scratchpad/ev-slider.png' });

for (const id of ['ACS-DEMO-001','ACS-DEMO-003','ACS-DEMO-005']) {
  await p.evaluate(t => { const s = window.__assetExplorer.store ?? window.__assetExplorer;
    s.selectAsset((s.getState().assetsByType.acsDemoCase ?? []).find(a => a.id === t), 'card'); }, id);
  await p.waitForTimeout(1500);
  if (id === 'ACS-DEMO-001') await p.screenshot({ path: 'scratchpad/ev-panel.png' });
  await p.click('button[aria-label^="Open ACS case"]');
  await p.waitForTimeout(1200);
  await p.click('.MuiDialog-root nav button:text-is("Evidence Recovery")');
  await p.waitForTimeout(3000);
  const dlg = () => p.evaluate(() => [...document.querySelectorAll('.MuiDialog-root [role="dialog"]')].at(-1).innerText);
  console.log(`\n##### ${id} EVIDENCE #####\n` + (await dlg()).split('Audit Trail')[1].slice(0, 1700));
  await p.screenshot({ path: `scratchpad/ev-${id}-recovery.png` });
  // accept + revalidate
  const applyBtn = await p.$('.MuiDialog-root button:has-text("and re-validate")');
  if (applyBtn) {
    const radios = await p.$$('.MuiDialog-root input[type="radio"]');
    for (const r of radios.slice(0, 3)) { await r.check().catch(()=>{}); }
    await p.waitForTimeout(400);
    await (await p.$('.MuiDialog-root button:has-text("and re-validate")')).click();
    await p.waitForTimeout(1200);
    const txt = await dlg();
    console.log('--- revalidation ---\n' + txt.slice(txt.indexOf('Re-validation')).slice(0, 600));
    await p.screenshot({ path: `scratchpad/ev-${id}-applied.png` });
  }
  await p.click('.MuiDialog-root nav button:text-is("Incident Context")');
  await p.waitForTimeout(5000);
  const ctx = await dlg();
  console.log(`\n##### ${id} CONTEXT #####\n` + ctx.split('Audit Trail')[1].slice(0, 1500));
  await p.screenshot({ path: `scratchpad/ev-${id}-context.png` });
  await p.keyboard.press('Escape');
  await p.waitForTimeout(600);
}
console.log('\nPAGE ERRORS', errs.slice(0,5));
await b.close();
