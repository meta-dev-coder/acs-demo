import { chromium } from '@playwright/test';
const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1700, height: 950 } });
page.on('pageerror', e => console.log('PAGE ERROR:', e.message));
await page.goto('http://localhost:5188/?demo=i595', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__liveOps && window.__liveEvents, null, { timeout: 90000 });
await page.locator('.app-nav [data-section="liveOps"]').click();
await page.waitForTimeout(3500);
await page.locator('.liveops-history-select').selectOption('all');
await page.waitForTimeout(4000);
await page.locator('.liveops-workspace .ws-kpi[data-kpi="cleared"]').click();
await page.waitForTimeout(3000);

const snap = async label => console.log(label.padEnd(16), JSON.stringify(await page.evaluate(() => ({
  type: window.__assetExplorer.store.getState().activeExplorerType,
  range: window.__liveEvents.clearedRange,
  cards: window.__assetExplorer.store.filteredAssets().length,
  pins: [...window.__liveEvents.entityById.values()].filter(e => e.isShowing).length,
  heat: [...window.__liveOps.impact.values()].filter(s => s.events.length).map(s => `${s.sectionLabel} ${s.operationalScore}`),
}))));

await snap('no range:');
await page.evaluate(() => window.__assetExplorer.store.setFilter({ from: '2026-09-27', to: '2026-09-27' }));
await page.waitForTimeout(1500);
await snap('27th only:');
await page.evaluate(() => window.__assetExplorer.store.setFilter({ from: '2026-09-28', to: '2026-09-28' }));
await page.waitForTimeout(1500);
await snap('28th only:');
await page.evaluate(() => window.__assetExplorer.store.setFilter({ from: null, to: null }));
await page.waitForTimeout(1500);
await snap('cleared:');
console.log('date UI present:', await page.locator('input[type="date"]').count());
await browser.close();
