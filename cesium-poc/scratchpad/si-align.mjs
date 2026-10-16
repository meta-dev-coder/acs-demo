import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => (window.__safetyIntel.analysis()?.hotspots.clusters.length ?? 0) > 0, null, { timeout: 180000 });
await page.evaluate(() => {
  const si = window.__safetyIntel;
  si.selectIncidentById(si.analysis().hotspots.clusters[0].facts[0].id);
});
await page.waitForTimeout(2500);
await page.click('[data-lab-tab="response"]');
await page.waitForTimeout(500);
console.log(JSON.stringify(await page.evaluate(() => {
  const box = el => { const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
  const row = document.querySelector('.lab-run');
  const label = row.querySelector('.lab-run-field');
  const span = label.querySelector('span') ?? label;
  const select = row.querySelector('select');
  const button = row.querySelector('.si-action');
  const cs = getComputedStyle(label);
  return { row: box(row), label: box(label), span: box(span), select: box(select), button: box(button),
    labelDisplay: cs.display, labelAlign: cs.alignItems, rowAlign: getComputedStyle(row).alignItems,
    buttonMargin: getComputedStyle(button).margin };
}), null, 1));
await browser.close();
