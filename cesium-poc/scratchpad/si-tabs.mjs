import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 120000 });
await page.waitForTimeout(5000);

const check = async tab => {
  await page.click(`[data-tab="${tab}"]`);
  await page.waitForTimeout(1600);
  return page.evaluate(label => {
    const si = window.__safetyIntel; const a = si.analysis(); const v = window.__viewer;
    let badges = 0;
    for (let i = 0; i < v.dataSources.length; i++) {
      const s = v.dataSources.get(i);
      if (s.name === 'I-595 Safety Intelligence') {
        badges = s.entities.values.filter(e => String(e.id).startsWith('place:')).length;
      }
    }
    const kpi = [...document.querySelectorAll('.si-kpi')][0];
    return { tab: label, badges, totals: a.placeTotals,
      firstKpi: kpi ? `${kpi.querySelector('.si-kpi-label').textContent.trim()} = ${kpi.querySelector('.si-kpi-value').textContent.trim()}` : null,
      matches: a.placeTotals.counted === Number(kpi?.querySelector('.si-kpi-value').textContent.replace(/,/g, '')) };
  }, tab);
};
for (const tab of ['accidents', 'secondary', 'assets', 'patrol']) {
  console.log(JSON.stringify(await check(tab)));
  await page.screenshot({ path: `scratchpad/tab-${tab}.png` });
}
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 5).join('\n') : 'no page errors');
await browser.close();
