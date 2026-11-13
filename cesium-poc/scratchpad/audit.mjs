import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage();
await p.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await p.waitForFunction(() => window.__maintenance, null, { timeout: 60000 });
await p.selectOption('.app-role select', 'maintenanceTeam');
await p.waitForFunction(() => (window.__maintenance.recordsOf('inspections')?.length ?? 0) > 0, null, { timeout: 180000 });
await p.waitForTimeout(2000);
console.log(JSON.stringify(await p.evaluate(() => {
  const at = r => r.raw?.attributes ?? r.raw ?? r;
  const out = {};
  for (const key of ['inspections', 'workOrders', 'tickets', 'tasks', 'assets']) {
    const recs = window.__maintenance.recordsOf(key) ?? [];
    if (!recs.length) { out[key] = 'none'; continue; }
    const keys = new Map();
    for (const r of recs) for (const [k, v] of Object.entries(at(r))) {
      const e = keys.get(k) ?? { filled: 0, uniq: new Set() };
      if (v != null && String(v).trim() !== '') { e.filled += 1; e.uniq.add(String(v)); }
      keys.set(k, e);
    }
    out[key] = { count: recs.length, fields: Object.fromEntries([...keys].map(([k, e]) =>
      [k, `${e.filled}/${recs.length} · ${e.uniq.size}u · ${[...e.uniq][0]?.slice(0, 32) ?? ''}`])) };
  }
  return out;
}), null, 1));
await b.close();
