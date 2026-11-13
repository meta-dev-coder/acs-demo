import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => document.querySelector('.si-loader')?.hidden === true,
  null, { timeout: 180000 });
console.log(JSON.stringify(await page.evaluate(() => {
  const recs = window.__maintenance.recordsOf('incidents').filter(r => !r.live);
  const attrs = r => r.raw?.attributes ?? r.raw ?? r;
  const keys = new Map();
  for (const r of recs) for (const [k, v] of Object.entries(attrs(r))) {
    const e = keys.get(k) ?? { filled: 0, uniq: new Set() };
    if (v != null && String(v).trim() !== '') { e.filled += 1; e.uniq.add(String(v)); }
    keys.set(k, e);
  }
  const dates = recs.map(r => String(attrs(r).incident_date ?? '')).filter(Boolean).sort();
  return {
    total: recs.length,
    dateRange: [dates[0], dates[dates.length - 1]],
    sample: attrs(recs[0]),
    fields: Object.fromEntries([...keys].map(([k, e]) => [k,
      `${e.filled}/${recs.length} filled, ${e.uniq.size} distinct, e.g. ${[...e.uniq][0]?.slice(0, 40) ?? ''}`])),
  };
}), null, 1));
await browser.close();
