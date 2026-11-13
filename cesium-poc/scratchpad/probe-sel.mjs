import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1680, height: 980 } });
const errs = []; p.on('pageerror', e => errs.push(String(e)));
await p.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await p.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await p.selectOption('.app-role select', 'maintenanceTeam');
await p.waitForFunction(() => (window.__maintenance.recordsOf('incidents')?.length ?? 0) > 0, null, { timeout: 180000 });
await p.waitForTimeout(3000);
console.log(JSON.stringify(await p.evaluate(() => ({
  globals: Object.keys(window).filter(k => /asset|explorer|store/i.test(k)),
  host: Boolean(document.querySelector('.asset-explorer-host')),
  cards: document.querySelectorAll('.asset-explorer-host [class*="MuiCardActionArea"]').length,
  acsFetch: 'n/a',
})), null, 1));
// Does the data file serve?
console.log('acs json status', (await p.evaluate(() => fetch('data/acs-repair-tasks.json').then(r => r.status))));
await b.close();
