import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
p.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 300)); });
await p.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await p.waitForTimeout(8000);
// switch to the maintenance role
const roles = await p.evaluate(() => [...document.querySelectorAll('.app-role select option')].map(o => o.value));
console.log('roles', roles);
await p.selectOption('.app-role select', 'maintenanceTeam');
await p.waitForTimeout(20000);
const cards = await p.evaluate(() => [...document.querySelectorAll('.ws-kpi')].map(btn => ({
  key: btn.dataset.kpi, label: btn.querySelector('.ws-kpi-label')?.textContent,
  badge: btn.querySelector('.ws-kpi-badge')?.textContent ?? null,
  count: btn.querySelector('[data-count]')?.textContent,
  countLabel: btn.querySelector('[data-count-label]')?.textContent,
  note: btn.querySelector('[data-note]')?.textContent, state: btn.dataset.state })));
console.log(JSON.stringify(cards, null, 1));
await p.click('.ws-kpi[data-kpi="acsDemoCases"]');
await p.waitForTimeout(4000);
console.log('explorer', JSON.stringify(await p.evaluate(() => {
  const s = window.__assetExplorer?.getState?.() ?? window.__assetExplorer?.store?.getState?.();
  return { type: s?.activeExplorerType, count: (s?.assetsByType?.acsDemoCase ?? []).length, filter: s?.filter };
})));
await p.screenshot({ path: 'scratchpad/demo-kpi.png' });
// select the first card
const titles = await p.evaluate(() => [...document.querySelectorAll('.asset-explorer-host .MuiCard-root')].map(c => c.innerText.replace(/\n/g, ' | ')));
console.log('cards', JSON.stringify(titles, null, 1));
await p.click('.asset-explorer-host .MuiCard-root');
await p.waitForTimeout(2500);
const panel = await p.evaluate(() => {
  const el = document.querySelector('[role="complementary"][aria-label^="Demo case"]');
  return el ? el.innerText : null;
});
console.log('--- PANEL ---\n' + panel);
await p.screenshot({ path: 'scratchpad/demo-panel.png' });
await p.click('button[aria-label^="Open ACS case"]');
await p.waitForTimeout(2000);
const dlg = await p.evaluate(() => {
  const el = [...document.querySelectorAll('.MuiDialog-root [role="dialog"]')].at(-1);
  return el ? { tabs: [...el.querySelectorAll('nav button')].map(b => b.textContent), text: el.innerText.slice(0, 2200) } : null;
});
console.log('--- DIALOG ---\n' + JSON.stringify(dlg, null, 1));
await p.screenshot({ path: 'scratchpad/demo-dialog.png' });
for (const tab of ['Inspection', 'Repair', 'QC/QA', 'Claim', 'Audit Trail']) {
  await p.click(`.MuiDialog-root nav button:text-is("${tab}")`);
  await p.waitForTimeout(900);
  const txt = await p.evaluate(() => [...document.querySelectorAll('.MuiDialog-root [role="dialog"]')].at(-1).innerText.slice(0, 700));
  console.log(`\n=== ${tab} ===\n` + txt);
  await p.screenshot({ path: `scratchpad/demo-${tab.replace(/[^a-z]/gi, '')}.png` });
}
console.log('\nERRORS', JSON.stringify(errs.slice(0, 8), null, 1));
await b.close();
