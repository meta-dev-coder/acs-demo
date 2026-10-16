import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 120000 });
const out = await page.evaluate(() => {
  const a = window.__safetyIntel.analysis();
  const rows = {};
  for (const [key, kpis] of Object.entries(a.kpis)) {
    rows[key] = kpis.map(k => ({ id: k.id, label: k.label, status: k.status, value: k.value,
      unit: k.unit, basis: k.basis, requires: k.requires }));
  }
  return { rows, summary: a.summary, hazards: { h: a.hazards.hazards, i: a.hazards.inspections, l: a.hazards.locations },
    secondary: a.secondary.observed.count, corpus: a.provenance.records,
    closure: a.kpis.accidents.find(k => k.id === 'closureHours') };
});
for (const [row, kpis] of Object.entries(out.rows)) {
  console.log('\n=== ' + row.toUpperCase());
  for (const k of kpis) {
    console.log(` ${k.status === 'AVAILABLE' ? '✓' : '✗'} ${k.label}: ${k.value ?? '—'} ${k.unit ?? ''}`);
    console.log(`    ${k.basis ?? 'NEEDS: ' + k.requires}`);
  }
}
console.log('\nSUMMARY', JSON.stringify(out.summary));
console.log('HAZ', JSON.stringify(out.hazards), 'SEC', out.secondary, 'CORPUS', out.corpus);
await browser.close();
