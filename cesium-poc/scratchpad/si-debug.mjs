import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForTimeout(20000);
console.log(JSON.stringify(await page.evaluate(() => ({
  error: window.__safetyIntel.state.error,
  loaded: window.__safetyIntel.state.loaded,
  incidents: window.__maintenance?.recordsForType?.('incidentRecord', { live: false })?.length ?? 'nofn',
  workOrders: window.__maintenance?.recordsForType?.('workOrder', { live: false })?.length ?? 'nofn',
  inspections: window.__maintenance?.recordsForType?.('inspection', { live: false })?.length ?? 'nofn',
  assets: window.__maintenance?.assetIndex?.()?.size ?? 'nofn',
  provenanceText: document.querySelector('[data-region="provenance"]')?.textContent?.trim()?.slice(0, 200),
})), null, 1));
// Force a reload of the screen's own data and see what it throws.
console.log('reload:', JSON.stringify(await page.evaluate(async () => {
  try { await window.__safetyIntel.reload(); return { ok: true, loaded: window.__safetyIntel.state.loaded,
    records: window.__safetyIntel.analysis()?.provenance.records ?? null }; }
  catch (e) { return { ok: false, error: String(e), stack: String(e?.stack).slice(0, 900) }; }
})));
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 8).join('\n') : 'no page errors');
await browser.close();
