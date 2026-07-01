/**
 * weather.spec.ts — Phase 1 TDD spec: weather presets + capacity KPI.
 *
 * Tests (written RED first, then implemented GREEN):
 *  W1. weather dropdown present (offline) — #weather-select exists with 5 options in order
 *      (Clear / Light Rain / Heavy Rain / Fog / Snow-Ice).
 *  W2. capacity + saturation tiles (offline) — #kpis has "Plaza capacity" and "Saturation"
 *      tiles; window.__kpi.capacityVph > 0 and satRatio > 0.
 *  W3. weather overlay tint toggles (client-side, offline) — selecting "Heavy Rain" adds
 *      #weather-overlay with class weather-heavyrain; "Clear" removes/hides it; "Fog"
 *      shows weather-fog overlay and sets window.__weather = 'fog'.
 *  W4. heavy rain cuts capacity (LIVE — requires ws://localhost:8765) — start live mode,
 *      record clearCapacity under Clear, select Heavy Rain, wait for capacityVph to drop
 *      ≥ 8%; capacity tile shows .d.bad chip.
 *  W5. no deadlock under snow-ice (LIVE) — vehicles keep moving 3 s after switching to
 *      snow-ice; running count > 0 and positions change.
 *
 * Run:
 *   cd cesium-poc && npm run e2e -- e2e/weather.spec.ts
 *   (or full suite: npm run e2e)
 */
import { test, expect } from '@playwright/test';
import { waitForReady, vehicleWorldPositions, shoot } from './helpers.js';

// ---------------------------------------------------------------------------
// W1: weather dropdown present (offline)
// ---------------------------------------------------------------------------
test('W1: weather dropdown present with 5 options in order', async ({ page }) => {
  await waitForReady(page);

  const sel = page.locator('#weather-select');
  await expect(sel).toBeVisible({ timeout: 5_000 });

  const options = sel.locator('option');
  await expect(options).toHaveCount(5);

  const texts = await options.allTextContents();
  expect(texts[0]).toMatch(/clear/i);
  expect(texts[1]).toMatch(/light\s*rain/i);
  expect(texts[2]).toMatch(/heavy\s*rain/i);
  expect(texts[3]).toMatch(/fog/i);
  expect(texts[4]).toMatch(/snow/i);

  await shoot(page, 'weather-w1-dropdown');
});

// ---------------------------------------------------------------------------
// W2: Plaza capacity + Saturation tiles (offline)
// ---------------------------------------------------------------------------
test('W2: plaza capacity and saturation tiles render with positive values', async ({ page }) => {
  await waitForReady(page);

  const kpisText = await page.locator('#kpis').textContent();
  expect(kpisText).toContain('Plaza capacity');
  expect(kpisText).toContain('Saturation');

  const kpiData = await page.evaluate(() => (window as any).__kpi);
  expect(kpiData).toBeTruthy();
  expect(typeof kpiData.capacityVph).toBe('number');
  expect(kpiData.capacityVph).toBeGreaterThan(0);
  expect(typeof kpiData.satRatio).toBe('number');
  expect(kpiData.satRatio).toBeGreaterThan(0);

  await shoot(page, 'weather-w2-capacity-tiles');
});

// ---------------------------------------------------------------------------
// W3: weather overlay tint toggles (client-side, no live server needed)
// ---------------------------------------------------------------------------
test('W3: weather overlay tint appears for heavy rain, clears for clear, tints for fog', async ({ page }) => {
  await waitForReady(page);

  // Heavy Rain → overlay appears with correct class
  await page.selectOption('#weather-select', 'heavyrain');
  const overlay = page.locator('#weather-overlay');
  await expect(overlay).toBeVisible({ timeout: 3_000 });
  const clsHeavy = await overlay.getAttribute('class') ?? '';
  expect(clsHeavy).toContain('weather-heavyrain');
  expect(await page.evaluate(() => (window as any).__weather)).toBe('heavyrain');
  await shoot(page, 'weather-w3-heavyrain');

  // Clear → overlay hidden
  await page.selectOption('#weather-select', 'clear');
  await expect(overlay).not.toBeVisible({ timeout: 3_000 });
  expect(await page.evaluate(() => (window as any).__weather)).toBe('clear');
  await shoot(page, 'weather-w3-clear');

  // Fog → overlay + window.__weather = 'fog'
  await page.selectOption('#weather-select', 'fog');
  await expect(overlay).toBeVisible({ timeout: 3_000 });
  const clsFog = await overlay.getAttribute('class') ?? '';
  expect(clsFog).toContain('weather-fog');
  expect(await page.evaluate(() => (window as any).__weather)).toBe('fog');
  await shoot(page, 'weather-w3-fog');
});

// ---------------------------------------------------------------------------
// Helpers for live tests
// ---------------------------------------------------------------------------
async function checkLiveServer(page: any): Promise<boolean> {
  return page.evaluate(() =>
    new Promise<boolean>((resolve) => {
      try {
        const ws = new WebSocket('ws://localhost:8765');
        const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(false); }, 3_000);
        ws.onopen  = () => { clearTimeout(timer); ws.close(); resolve(true); };
        ws.onerror = () => { clearTimeout(timer); resolve(false); };
      } catch {
        resolve(false);
      }
    })
  );
}

// ---------------------------------------------------------------------------
// W4: heavy rain lowers capacity (LIVE)
// ---------------------------------------------------------------------------
test('W4: heavy rain lowers plaza capacity ≥8% vs clear (live)', async ({ page }) => {
  await waitForReady(page);

  const serverUp = await checkLiveServer(page);
  if (!serverUp) {
    test.skip(true, 'Live SUMO server not running on ws://localhost:8765');
    return;
  }

  // Switch to live mode
  await page.click('#btn-live');

  // Explicitly reset to Clear weather so we get a deterministic baseline
  // (the server might be in a non-clear state from a previous test run).
  await page.selectOption('#weather-select', 'clear');
  await page.waitForTimeout(200);  // brief pause so onchange fires

  // Wait for the first KPI frame with theoretical capacity (available from step 10 on)
  // and with weather confirmed as 'clear'.
  await page.waitForFunction(
    () => {
      const k = (window as any).__kpi;
      return k?.schemaVersion === 1 && typeof k.capacityVph === 'number'
        && k.capacityVph > 0 && k.weather === 'clear';
    },
    { timeout: 30_000, polling: 500 },
  );

  const clearCapacity: number = await page.evaluate(() => (window as any).__kpi.capacityVph);
  expect(clearCapacity).toBeGreaterThan(0);
  await shoot(page, 'weather-w4-clear-capacity');

  // Switch to heavy rain
  await page.selectOption('#weather-select', 'heavyrain');

  // Wait for capacity to drop by ≥8% (preset-based theoretical capacity applied immediately)
  await page.waitForFunction(
    (cap: number) => {
      const k = (window as any).__kpi;
      return k?.capacityVph > 0 && k.capacityVph <= cap * 0.92;
    },
    clearCapacity,
    { timeout: 30_000, polling: 500 },
  );

  const rainCapacity: number = await page.evaluate(() => (window as any).__kpi.capacityVph);
  const dropFraction = (clearCapacity - rainCapacity) / clearCapacity;

  await shoot(page, 'weather-w4-heavyrain-capacity');

  expect(dropFraction).toBeGreaterThanOrEqual(0.08);
  console.log(`Clear=${clearCapacity} vph → Rain=${rainCapacity} vph (−${(dropFraction * 100).toFixed(1)}%)`);

  // Capacity tile must show a .d.bad chip (rain < clear)
  const capTile = page.locator('#kpis .kpi').filter({ hasText: 'Plaza capacity' });
  await expect(capTile.locator('.d.bad')).toBeVisible({ timeout: 5_000 });
});

// ---------------------------------------------------------------------------
// W5: no deadlock under snow-ice (LIVE)
// ---------------------------------------------------------------------------
test('W5: vehicles keep moving under snow-ice preset (no deadlock)', async ({ page }) => {
  await waitForReady(page);

  const serverUp = await checkLiveServer(page);
  if (!serverUp) {
    test.skip(true, 'Live SUMO server not running on ws://localhost:8765');
    return;
  }

  // Start live mode and wait for vehicles
  await page.click('#btn-live');
  await page.waitForFunction(
    () => {
      const v = (window as any).__viewer;
      return v && v.entities.values.some((e: any) => e.model != null);
    },
    { timeout: 30_000, polling: 500 },
  );

  // Switch to snow-ice
  await page.selectOption('#weather-select', 'snowice');
  await page.waitForTimeout(500);  // brief pause for command to register

  // Sample positions before
  const pos1 = await vehicleWorldPositions(page);
  expect(pos1.length, 'No vehicles found before snow-ice wait').toBeGreaterThan(0);

  await page.waitForTimeout(3_000);  // 3 s real time = 30 sim steps at 10 Hz

  // Running count must still be > 0 (no deadlock wipeout)
  const kpiData = await page.evaluate(() => (window as any).__kpi);
  // If KPI available, check running; otherwise check entity count
  if (kpiData?.running != null) {
    expect(kpiData.running, 'All vehicles gone (possible deadlock)').toBeGreaterThan(0);
  }

  // Positions must have changed
  const pos2 = await vehicleWorldPositions(page);
  expect(pos2.length, 'No vehicles after snow-ice period').toBeGreaterThan(0);

  // At least some entities moved (sum abs delta of positions)
  const matchCount = Math.min(pos1.length, pos2.length);
  const totalDelta = pos2.slice(0, matchCount).reduce((sum, p2, i) => {
    const p1 = pos1[i];
    return sum + Math.abs(p2.lon - p1.lon) + Math.abs(p2.lat - p1.lat);
  }, 0);
  expect(totalDelta, 'Vehicles appear frozen (possible deadlock)').toBeGreaterThan(1e-5);

  await shoot(page, 'weather-w5-snowice-moving');
});
