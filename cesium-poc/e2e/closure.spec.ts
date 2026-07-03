/**
 * closure.spec.ts — TDD spec for Feature B: MUTCD/RILCA lane-closure TTC overlay + KPIs.
 *
 * RED before implementation (window.__closeLane / #wz-close / window.__kpi.workzone
 * do not exist yet). GREEN once B2-B5 land: live_server.py closeLane command,
 * kpi.py workzone() merged into stats, workzone.js TTC overlay (cones/signs),
 * main.js __closeLane hook, index.html/style.css #workzone-hud panel.
 *
 * Depends on Feature A (curved centerline) — cone/sign placement rides
 * window.__meta.centerline via window.__T, same as curved-road.spec.ts.
 *
 * Do NOT run this spec until the workzone UI exists — it stays red by design.
 * Run: cd cesium-poc && npm run e2e -- e2e/closure.spec.ts
 */
import { test, expect } from '@playwright/test';
import { waitForReady, shoot, centerlineOffset } from './helpers.js';

// MUTCD constants under test (mirrors sumo/test_rilca.py + closure_config.json).
const EXPECTED_N_CONES = 12;          // n_cones(720 ft, 60 ft) = 12
const EXPECTED_TAPER_M = 219;         // 720 ft * 0.3048 = 219.456 m
const TAPER_TOL_M = 5;
const EXPECTED_SIGN_STATIONS_M = [305, 457, 805]; // 1000/1500/2640 ft upstream

// ---------------------------------------------------------------------------
// Trigger the closure via the exposed hook (or the HUD button, once it exists).
// ---------------------------------------------------------------------------
async function closeLane(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__closeLane('ap_0', { offsetFt: 12, speedMph: 60 });
  });
  // Let the TTC overlay + KPI recompute settle.
  await page.waitForTimeout(300);
}

// ---------------------------------------------------------------------------
// CL1 — cone count matches kpi.workzone.nCones, all on-road, monotonic taper
// ---------------------------------------------------------------------------
test('CL1 — cone entities == kpi.workzone.nCones, on-road, monotonic taper offset', async ({ page }) => {
  await waitForReady(page);
  await closeLane(page);

  const kpi = await page.evaluate(() => (window as any).__kpi);
  expect(kpi?.workzone, 'window.__kpi.workzone must be set after closeLane').toBeTruthy();
  expect(kpi.workzone.nCones, 'kpi.workzone.nCones should be ~12 per MUTCD 60 ft spacing').toBe(EXPECTED_N_CONES);

  const cones = await page.evaluate(() => {
    const viewer = (window as any).__viewer;
    const T      = (window as any).__T;
    const meta   = (window as any).__meta;
    const ell    = viewer.scene.globe.ellipsoid;
    const time   = viewer.clock.currentTime;

    return viewer.entities.values
      .filter((e: any) => e.properties?.isCone?.getValue?.(time) === true)
      .map((e: any) => {
        const cart = e.position?.getValue(time);
        const carto = ell.cartesianToCartographic(cart);
        const lon = (carto.longitude * 180) / Math.PI;
        const lat = (carto.latitude  * 180) / Math.PI;
        const local = T.worldToSumo(lon, lat);
        return { x: local.x, y: local.y, cl: meta.centerline };
      });
  });

  expect(cones.length, 'cone entity count must equal kpi.workzone.nCones').toBe(EXPECTED_N_CONES);

  // On-road: every cone within roadHalfWidthM of the centerline.
  const meta = await page.evaluate(() => (window as any).__meta);
  for (const c of cones) {
    const off = centerlineOffset(meta.centerline, c.x, c.y);
    expect(off.offset, `cone at x=${c.x} must be within roadHalfWidthM of centerline`).toBeLessThanOrEqual(meta.roadHalfWidthM);
  }

  // Monotonically decreasing lateral offset along the taper (merging taper: full → 0).
  const sortedByX = [...cones].sort((a, b) => a.x - b.x);
  const offsets = sortedByX.map((c) => Math.abs(centerlineOffset(meta.centerline, c.x, c.y).offset));
  for (let i = 1; i < offsets.length; i++) {
    expect(offsets[i], `cone taper offsets must be monotonically non-increasing (index ${i})`).toBeLessThanOrEqual(offsets[i - 1] + 0.01);
  }

  await shoot(page, 'closure-cones');
});

// ---------------------------------------------------------------------------
// CL2 — 3 advance-warning signs upstream + END ROAD WORK downstream
// ---------------------------------------------------------------------------
test('CL2 — 3 advance-warning signs at ~305/457/805 m upstream + END ROAD WORK downstream', async ({ page }) => {
  await waitForReady(page);
  await closeLane(page);

  const signs = await page.evaluate(() => {
    const viewer = (window as any).__viewer;
    const time = viewer.clock.currentTime;
    return viewer.entities.values
      .filter((e: any) => e.billboard != null && e.properties?.signText != null)
      .map((e: any) => ({
        text: e.properties.signText.getValue(time),
        stationM: e.properties.stationM?.getValue(time),
      }));
  });

  const advanceSigns = signs.filter((s: any) => s.text !== 'END ROAD WORK');
  expect(advanceSigns.length, 'expect exactly 3 advance-warning signs').toBe(3);

  const stations = advanceSigns.map((s: any) => Math.abs(s.stationM)).sort((a: number, b: number) => a - b);
  EXPECTED_SIGN_STATIONS_M.forEach((expected, i) => {
    expect(stations[i], `sign ${i} station should be ~${expected} m upstream`).toBeGreaterThan(expected - 15);
    expect(stations[i], `sign ${i} station should be ~${expected} m upstream`).toBeLessThan(expected + 15);
  });

  const endRoadWork = signs.filter((s: any) => s.text === 'END ROAD WORK');
  expect(endRoadWork.length, 'expect exactly 1 END ROAD WORK sign downstream').toBe(1);

  await shoot(page, 'closure-signs');
});

// ---------------------------------------------------------------------------
// CL3 — taperLengthM ≈ 219 m, permissible badge reflects kpi.workzone.permissible
// ---------------------------------------------------------------------------
test('CL3 — kpi.workzone.taperLengthM ≈ 219 m (±5) and HUD permissibility badge matches', async ({ page }) => {
  await waitForReady(page);
  await closeLane(page);

  const kpi = await page.evaluate(() => (window as any).__kpi);
  expect(kpi.workzone.taperLengthM, `taperLengthM = ${kpi.workzone.taperLengthM}`).toBeGreaterThan(EXPECTED_TAPER_M - TAPER_TOL_M);
  expect(kpi.workzone.taperLengthM, `taperLengthM = ${kpi.workzone.taperLengthM}`).toBeLessThan(EXPECTED_TAPER_M + TAPER_TOL_M);

  expect(['green', 'red']).toContain(kpi.workzone.permissible);

  const badge = page.locator('#wz-permissible-badge');
  await expect(badge, '#wz-permissible-badge must exist in the workzone HUD').toBeVisible();
  const badgeText = (await badge.textContent())?.toLowerCase() ?? '';
  expect(badgeText, `badge text should mention "${kpi.workzone.permissible}"`).toContain(kpi.workzone.permissible);

  await shoot(page, 'closure-hud-badge');
});

// ---------------------------------------------------------------------------
// CL4 — physics reacted: queue forms and measured capacity drops after closure
// ---------------------------------------------------------------------------
test('CL4 — after closure, maxQueueVeh > 0 and measured capacityVph drops vs pre-closure', async ({ page }) => {
  await waitForReady(page);

  const preKpi = await page.evaluate(() => (window as any).__kpi);
  const preCapacity = preKpi.capacityVph;

  await closeLane(page);

  // Let sim run forward so the queue/capacity measurement reflects the closure.
  await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.clock.multiplier = 60;
    v.clock.shouldAnimate = true;
  });
  await page.waitForTimeout(1500);
  await page.evaluate(() => { (window as any).__viewer.clock.multiplier = 1; });

  const postKpi = await page.evaluate(() => (window as any).__kpi);

  expect(postKpi.workzone?.maxQueueVeh, 'maxQueueVeh should be > 0 once the lane is closed under demand').toBeGreaterThan(0);
  expect(postKpi.capacityVph, `post-closure capacityVph (${postKpi.capacityVph}) should be less than pre-closure (${preCapacity})`).toBeLessThan(preCapacity);

  await shoot(page, 'closure-queue-capacity');
});
