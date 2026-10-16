import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
const t0 = Date.now();
await page.selectOption('.app-role select', 'safetyIntel');

const snap = () => page.evaluate(() => {
  const loader = document.querySelector('.si-loader');
  return {
    covered: loader && !loader.hidden && !loader.classList.contains('is-going'),
    step: document.querySelector('[data-region="loader-step"]')?.textContent.trim(),
    steps: [...document.querySelectorAll('.si-loader-steps li')].map(li =>
      `${li.className || 'waiting'}: ${li.textContent.replace(/\s+/g, ' ').trim()}`),
  };
});
for (let i = 0; i < 7; i += 1) {
  await page.waitForTimeout(3500);
  const s = await snap();
  console.log(`${String((Date.now() - t0) / 1000).padStart(5)}s covered=${s.covered} step="${s.step}"`);
  if (i === 2) await page.screenshot({ path: 'scratchpad/loader.png' });
  if (!s.covered) break;
}
console.log(JSON.stringify(await snap(), null, 1));
await page.waitForFunction(() => {
  const l = document.querySelector('.si-loader');
  return l && l.hidden;
}, null, { timeout: 120000 });
console.log(`uncovered after ${(Date.now() - t0) / 1000}s; loader hidden =`,
  await page.evaluate(() => document.querySelector('.si-loader').hidden));
// The screen behind it must be complete, not half-read.
console.log(JSON.stringify(await page.evaluate(() => ({
  kpis: document.querySelectorAll('.si-header .kpi-tile, .si-header [class*="kpi"]').length,
  queueEntries: document.querySelectorAll('[data-region="queue"] [data-entry]').length,
  analysisText: document.querySelector('[data-region="analysis"]')?.textContent.slice(0, 80).replace(/\s+/g, ' '),
})), null, 1));
await page.screenshot({ path: 'scratchpad/loaded.png' });
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
