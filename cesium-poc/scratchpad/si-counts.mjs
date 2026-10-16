import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => document.querySelector('.si-loader')?.hidden === true,
  null, { timeout: 180000 });
await page.waitForTimeout(1500);
console.log(JSON.stringify(await page.evaluate(() => {
  const si = window.__safetyIntel;
  const a = si.analysis();
  const facts = a.hotspots.clusters.flatMap(c => c.facts);
  const ids = facts.map(f => f.id);
  return {
    assets: window.__maintenance?.assetIndex?.().size,
    facts: facts.length,
    positioned: facts.filter(f => Number.isFinite(f.longitude)).length,
    hotspots: a.hotspots.clusters.length,
    queue: a.queue.entries.length,
    sections: a.sections.rows.length,
    // Order must be stable across reads, not just the count.
    firstThree: ids.slice(0, 3),
    duplicateIds: ids.length - new Set(ids).size,
  };
}), null, 1));
console.log(errors.length ? 'ERRORS\n' + errors.slice(0, 4).join('\n') : 'no page errors');
await browser.close();
