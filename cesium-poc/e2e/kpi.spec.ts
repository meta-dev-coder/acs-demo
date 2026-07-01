/**
 * kpi.spec.ts — Phase 0 TDD spec: KPI spine + revenue.
 *
 * Tests (written RED first, then implemented GREEN):
 *  1. revenue tile renders — #kpis has "Revenue/hr" tile with $-prefixed value > 0;
 *     window.__kpi.revenuePerHr > 0 and revenueByClass.{cash,etc,truck} all present.
 *     Stats payload has schemaVersion === 1 (forces shared kpi.py refactor).
 *  2. cash-vs-AET card present — #cash-aet-card has two columns; baseline shows
 *     cashVsAet.cash.avgWaitSec > cashVsAet.aet.avgWaitSec (cash lanes queue more).
 *  3. avg delay tile — "Avg delay" tile present with numeric seconds;
 *     window.__kpi.avgDelaySec >= 0 and distinct from avgWaitSec.
 *  4. booth utilisation tile — "Booth util" shows 0–100%; boothUtilisation.overall in [0,1]
 *     and perBooth has 10 lanes.
 *  5. before/after delta — load baseline then switch to intervention; revenue tile shows
 *     .d.good (+%), delay tile shows .d.good (-%).
 *
 * Run:
 *   cd cesium-poc && npm run e2e -- e2e/kpi.spec.ts
 *   (or full suite: npm run e2e)
 */
import { test, expect } from '@playwright/test';
import { waitForReady, shoot } from './helpers.js';

// ---------------------------------------------------------------------------
// Helper: read __kpi from the page (exposed by renderKpis)
// ---------------------------------------------------------------------------
async function kpi(page: any): Promise<any> {
  return page.evaluate(() => (window as any).__kpi);
}

// ---------------------------------------------------------------------------
// Helper: text content of the KPI panel
// ---------------------------------------------------------------------------
async function kpisText(page: any): Promise<string> {
  return page.locator('#kpis').textContent();
}

// ---------------------------------------------------------------------------
// 1. Revenue/hr tile — renders with $ value, revenuePerHr > 0, revenueByClass present
// ---------------------------------------------------------------------------
test('P0-1: revenue tile renders with $ value and window.__kpi.revenuePerHr > 0', async ({ page }) => {
  await waitForReady(page);

  // The stats payload must have schemaVersion=1 (forces shared kpi.py refactor).
  const kpiData = await kpi(page);
  expect(kpiData, 'window.__kpi must be set by renderKpis()').toBeTruthy();
  expect(kpiData.schemaVersion).toBe(1);

  // revenuePerHr must be a positive number.
  expect(typeof kpiData.revenuePerHr).toBe('number');
  expect(kpiData.revenuePerHr).toBeGreaterThan(0);

  // revenueByClass must have all three vType buckets.
  expect(kpiData.revenueByClass).toBeDefined();
  expect(typeof kpiData.revenueByClass.cash).toBe('number');
  expect(typeof kpiData.revenueByClass.etc).toBe('number');
  expect(typeof kpiData.revenueByClass.truck).toBe('number');

  // The KPI panel must contain a tile labelled "Revenue/hr" with a $ value.
  const text = await kpisText(page);
  expect(text).toContain('Revenue/hr');
  expect(text).toMatch(/\$[\d,]+/);

  await shoot(page, 'kpi-p0-1-revenue-tile');
});

// ---------------------------------------------------------------------------
// 2. Cash-vs-AET card — #cash-aet-card exists, baseline shows cash > aet wait time
// ---------------------------------------------------------------------------
test('P0-2: cash-vs-AET card present with cash waiting longer than AET', async ({ page }) => {
  await waitForReady(page);

  // The card container must exist in the DOM.
  await expect(page.locator('#cash-aet-card')).toBeVisible();

  // Both columns must be visible.
  const cols = page.locator('#cash-aet-card .cva-col');
  expect(await cols.count()).toBe(2);

  // Structured data must be available.
  const kpiData = await kpi(page);
  expect(kpiData).toBeTruthy();
  expect(kpiData.cashVsAet).toBeDefined();
  const { cash, aet } = kpiData.cashVsAet;
  expect(typeof cash.avgWaitSec).toBe('number');
  expect(typeof aet.avgWaitSec).toBe('number');
  // In baseline: cash lanes have a long queue; cash wait must be longer.
  expect(cash.avgWaitSec).toBeGreaterThan(aet.avgWaitSec);

  await shoot(page, 'kpi-p0-2-cva-card');
});

// ---------------------------------------------------------------------------
// 3. Avg delay tile — present, non-negative, distinct from avgWaitSec
// ---------------------------------------------------------------------------
test('P0-3: avg delay tile present and distinct from avg wait', async ({ page }) => {
  await waitForReady(page);

  const text = await kpisText(page);
  expect(text).toContain('Avg delay');

  const kpiData = await kpi(page);
  expect(kpiData).toBeTruthy();
  expect(typeof kpiData.avgDelaySec).toBe('number');
  expect(kpiData.avgDelaySec).toBeGreaterThanOrEqual(0);
  // avgDelaySec (timeLoss) and avgWaitSec (stopTime at zero speed) must be different.
  expect(kpiData.avgDelaySec).not.toBe(kpiData.avgWaitSec);

  await shoot(page, 'kpi-p0-3-delay-tile');
});

// ---------------------------------------------------------------------------
// 4. Booth utilisation tile — present, 0–100%, perBooth has 10 lanes
// ---------------------------------------------------------------------------
test('P0-4: booth utilisation tile present with 10-lane perBooth', async ({ page }) => {
  await waitForReady(page);

  const text = await kpisText(page);
  expect(text).toContain('Booth util');

  const kpiData = await kpi(page);
  expect(kpiData).toBeTruthy();
  expect(kpiData.boothUtilisation).toBeDefined();

  const overall = kpiData.boothUtilisation.overall;
  expect(typeof overall).toBe('number');
  expect(overall).toBeGreaterThanOrEqual(0);
  expect(overall).toBeLessThanOrEqual(1);

  const perBooth = kpiData.boothUtilisation.perBooth;
  expect(perBooth).toBeDefined();
  const lanes = Object.keys(perBooth);
  expect(lanes.length).toBe(10);
  // All lane keys should be pl_0..pl_9.
  for (let i = 0; i < 10; i++) {
    expect(lanes).toContain(`pl_${i}`);
  }

  await shoot(page, 'kpi-p0-4-booth-util');
});

// ---------------------------------------------------------------------------
// 5. Before/after delta — baseline vs intervention: revenue ↑ (green), delay ↓ (green)
// ---------------------------------------------------------------------------
test('P0-5: switching baseline→intervention shows revenue+% and delay-% (both green)', async ({ page }) => {
  await waitForReady(page);

  // 1. Load baseline explicitly (it's the default, but click to ensure baselineStats are captured).
  await page.click('#btn-baseline');
  // Wait for KPIs to settle after scenario switch.
  await page.waitForFunction(() => !!(window as any).__kpi?.schemaVersion, { timeout: 15_000 });
  const baseKpi = await kpi(page);
  expect(baseKpi.revenuePerHr).toBeGreaterThan(0);

  await shoot(page, 'kpi-p0-5-baseline');

  // 2. Switch to intervention.
  await page.click('#btn-intervention');
  await page.waitForFunction(
    () => {
      const k = (window as any).__kpi;
      return k && k.throughputVph !== (window as any).__baselineKpiForTest?.throughputVph;
    },
    { timeout: 15_000 },
  );
  // Re-read after switch.
  const intKpi = await kpi(page);
  expect(intKpi.revenuePerHr).toBeGreaterThan(0);

  // 3. Revenue tile must show a green '+%' chip (intervention > baseline).
  const revenueGoodChip = page.locator('#kpis .kpi').filter({ hasText: 'Revenue/hr' }).locator('.d.good');
  await expect(revenueGoodChip).toBeVisible({ timeout: 5_000 });

  // 4. Delay tile must show a green '-%' chip (intervention < baseline).
  const delayGoodChip = page.locator('#kpis .kpi').filter({ hasText: 'Avg delay' }).locator('.d.good');
  await expect(delayGoodChip).toBeVisible({ timeout: 5_000 });

  await shoot(page, 'kpi-p0-5-intervention');
});
