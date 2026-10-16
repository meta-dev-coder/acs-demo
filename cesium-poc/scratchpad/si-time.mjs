import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const calls = [];
const started = new Map();
page.on('request', r => { if (r.url().includes('/curated-data')) started.set(r, Date.now()); });
page.on('requestfinished', r => {
  if (!started.has(r)) return;
  let body = {}; try { body = JSON.parse(r.postData() ?? '{}'); } catch {}
  calls.push({ cls: r.url().split('/class/')[1]?.split('/')[0], page: body.page,
    ms: Date.now() - started.get(r), at: started.get(r) });
});
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
const t0 = Date.now();
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => document.querySelector('.si-loader')?.hidden === true,
  null, { timeout: 180000 });
console.log(`total cover time ${(Date.now() - t0) / 1000}s, ${calls.length} curated-data calls`);
const byClass = {};
for (const c of calls) {
  byClass[c.cls] ??= { pages: 0, totalMs: 0, slowest: 0, first: c.at, last: 0 };
  byClass[c.cls].pages += 1;
  byClass[c.cls].totalMs += c.ms;
  byClass[c.cls].slowest = Math.max(byClass[c.cls].slowest, c.ms);
  byClass[c.cls].last = Math.max(byClass[c.cls].last, c.at + c.ms);
}
for (const [cls, v] of Object.entries(byClass)) {
  console.log(`${cls}  pages=${String(v.pages).padStart(2)}  sum=${String(v.totalMs).padStart(6)}ms  ` +
    `slowest=${String(v.slowest).padStart(5)}ms  wall=${String(v.last - v.first).padStart(6)}ms  ` +
    `startedAt=+${v.first - t0}ms`);
}
await browser.close();
