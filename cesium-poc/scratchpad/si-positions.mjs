import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage();
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'load' });
await page.waitForFunction(() => window.__safetyIntel, null, { timeout: 60000 });
await page.selectOption('.app-role select', 'safetyIntel');
await page.waitForFunction(() => window.__safetyIntel.analysis(), null, { timeout: 120000 });
console.log(JSON.stringify(await page.evaluate(() => {
  const facts = window.__safetyIntel.state.facts;
  const byPos = new Map();
  const byAsset = new Map();
  for (const f of facts) {
    const k = `${f.longitude?.toFixed(6)},${f.latitude?.toFixed(6)}`;
    byPos.set(k, (byPos.get(k) ?? 0) + 1);
    byAsset.set(f.assetId, (byAsset.get(f.assetId) ?? 0) + 1);
  }
  const counts = [...byPos.values()].sort((a, b) => b - a);
  const positioned = facts.filter(f => Number.isFinite(f.longitude)).length;
  return {
    records: facts.length,
    positioned,
    distinctPositions: byPos.size,
    distinctAssets: byAsset.size,
    largestStack: counts[0],
    stacksOf2plus: counts.filter(c => c > 1).length,
    recordsInStacks: counts.filter(c => c > 1).reduce((s, c) => s + c, 0),
    singletons: counts.filter(c => c === 1).length,
    topStacks: [...byPos.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([pos, n]) => ({ pos, records: n })),
    topAssets: [...byAsset.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([id, n]) => ({ assetId: id, records: n })),
  };
}), null, 1));
await browser.close();
