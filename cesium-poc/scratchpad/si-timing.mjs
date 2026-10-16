import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const net = [];
page.on('response', r => {
  const u = r.url();
  if (/dataconnect|curated-data|classes|fdot_traffic/.test(u)) {
    net.push({ url: u.replace(/^https?:\/\/[^/]+/, '').slice(0, 70), status: r.status(),
      at: Date.now() });
  }
});
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
const t0 = Date.now();
await page.selectOption('.app-role select', 'safetyIntel');
// When does anything appear, and when is it usable?
await page.waitForFunction(() => !document.querySelector('.si-workspace').hidden, null, { timeout: 30000 });
const tVisible = Date.now();
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 180000 });
const tReady = Date.now();
console.log(`visible after ${tVisible - t0} ms`);
console.log(`usable  after ${tReady - t0} ms`);
console.log('\nnetwork during load:');
for (const r of net) console.log(`  +${String(r.at - t0).padStart(6)} ms  ${r.status}  ${r.url}`);
console.log('\ncpu of one recompute:', await page.evaluate(() => {
  const t = performance.now();
  window.__safetyIntel.setTab('accidents');
  return Math.round(performance.now() - t) + ' ms';
}));
await browser.close();
