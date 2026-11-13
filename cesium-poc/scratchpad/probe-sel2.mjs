import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1680, height: 980 } });
await p.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await p.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await p.selectOption('.app-role select', 'maintenanceTeam');
await p.waitForFunction(() => (window.__maintenance.recordsOf('incidents')?.length ?? 0) > 0, null, { timeout: 180000 });
await p.waitForTimeout(2500);
console.log(JSON.stringify(await p.evaluate(() => ({
  explorer: Object.keys(window.__assetExplorer ?? {}),
  layerStore: Object.keys(window.__layerStore ?? {}),
  maint: Object.keys(window.__maintenance ?? {}),
})), null, 1));
await b.close();
