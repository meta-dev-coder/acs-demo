import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage();
await p.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await p.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await p.selectOption('.app-role select', 'maintenanceTeam');
await p.waitForFunction(() => (window.__maintenance.recordsOf('workOrders')?.length ?? 0) > 0, null, { timeout: 180000 });
await p.waitForTimeout(1500);
console.log(JSON.stringify(await p.evaluate(() => {
  const at = r => r.raw?.attributes ?? r.raw ?? r;
  const vals = (key, field) => [...new Set((window.__maintenance.recordsOf(key) ?? [])
    .map(r => at(r)[field]).filter(Boolean))].sort();
  return {
    woAssetType: vals('workOrders', 'Asset Type'),
    woWorkType: vals('workOrders', 'Work Type'),
    woRepairCategory: vals('workOrders', 'Repair Category'),
    inspAssetType: vals('inspections', 'asset_type'),
    inspFormFamily: vals('inspections', 'inspection_form_family'),
    inspResult: vals('inspections', 'inspection_result'),
    passFail: vals('inspections', 'pass_fail'),
    assetCategories: [...new Set([...window.__maintenance.assetIndex().values()]
      .map(a => a.category).filter(Boolean))].sort(),
  };
}), null, 1));
await b.close();
