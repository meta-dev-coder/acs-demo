import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1600, height: 950 } });
const errs = [];
p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:5188/?demo=i595&acsDemo=off', { waitUntil: 'load' });
await p.waitForTimeout(8000);
await p.selectOption('.app-role select', 'maintenanceTeam');
await p.waitForTimeout(18000);
console.log('demo card present:', await p.evaluate(() => Boolean(document.querySelector('.ws-kpi[data-kpi="acsDemoCases"]'))));
console.log('other cards:', await p.evaluate(() => [...document.querySelectorAll('.ws-kpis .ws-kpi')]
  .map(b => `${b.dataset.kpi}=${b.querySelector('[data-count]').textContent}`).join(' ')));
// a real class still opens and its ACS case still works
await p.click('.ws-kpi[data-kpi="workOrders"]');
await p.waitForTimeout(3000);
await p.click('.asset-explorer-host .MuiCard-root');
await p.waitForTimeout(1500);
await p.click('button[aria-label^="Open ACS case"]');
await p.waitForTimeout(2000);
console.log('real ACS dialog tabs:', await p.evaluate(() => [...document.querySelectorAll('.MuiDialog-root nav button')].map(b => b.textContent).join(', ')));
console.log('ERRORS', errs.slice(0, 5));
await b.close();
