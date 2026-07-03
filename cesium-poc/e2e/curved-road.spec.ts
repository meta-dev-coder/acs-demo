/**
 * curved-road.spec.ts — TDD spec for Feature A: Curved real-road SUMO net.
 *
 * RED before implementation (window.__meta not set, window.__kpi.onRoadPct absent).
 * GREEN after: road_centerline.py fetches/falls back to I-595 geometry, georef_nodes.py
 * repositions nodes A/B/F onto the centerline with edge shape attributes, fcd2json.py
 * embeds centerline + roadHalfWidthM in meta, main.js exposes window.__meta / window.__T.
 *
 * Invariants:
 *   CR1 — window.__meta carries centerline (> 2 pts) and roadHalfWidthM > 0
 *   CR2 — centerline bearing change first→last segment > 8° (proves real curve, not straight)
 *   CR3 — centerline max |y| in local metres > 10 m (road deviates from straight bearing axis)
 *   CR4 — every vehicle local-y offset from the centerline ≤ roadHalfWidthM + 2 m (on-road)
 *   CR5 — window.__kpi.onRoadPct ≥ 0.98 (lateral-clamp validation metric)
 *
 * Run:
 *   cd cesium-poc && npm run e2e -- e2e/curved-road.spec.ts
 */
import { test, expect } from '@playwright/test';
import { waitForReady, shoot, SITE_I595 } from './helpers.js';

// ---------------------------------------------------------------------------
// CR1 — centerline metadata present and well-formed
// ---------------------------------------------------------------------------
test('CR1 — window.__meta carries centerline (> 2 pts) and roadHalfWidthM > 0', async ({ page }) => {
  await waitForReady(page);

  const meta = await page.evaluate(() => (window as any).__meta);

  expect(meta,                          'window.__meta must be set by main.js').toBeTruthy();
  expect(Array.isArray(meta.centerline), 'meta.centerline must be an array').toBe(true);
  expect(meta.centerline.length,         'centerline needs > 2 points for curve detection').toBeGreaterThan(2);
  expect(typeof meta.roadHalfWidthM).toBe('number');
  expect(meta.roadHalfWidthM,            'roadHalfWidthM must be > 0').toBeGreaterThan(0);

  await shoot(page, 'cr1-meta-present');
});

// ---------------------------------------------------------------------------
// CR2 — bearing change from first to last centerline segment exceeds 8°
// ---------------------------------------------------------------------------
test('CR2 — centerline bearing change first→last segment > 8° (real curve)', async ({ page }) => {
  await waitForReady(page);

  // Pull meta.centerline — [[x0,y0],[x1,y1],...] in local SUMO metres.
  // x = along-corridor, y = lateral (perpendicular to bearing-104° reference axis).
  const cl: number[][] = await page.evaluate(() => (window as any).__meta?.centerline);

  expect(cl,         'meta.centerline must be present').toBeTruthy();
  expect(cl.length,  'need ≥ 3 points to compare first vs last segment').toBeGreaterThanOrEqual(3);

  // Bearing of first segment: atan2(Δy, Δx) in local (angle from x-axis, degrees).
  const firstBearing = Math.atan2(cl[1][1] - cl[0][1], cl[1][0] - cl[0][0]) * 180 / Math.PI;
  // Bearing of last segment.
  const n = cl.length;
  const lastBearing  = Math.atan2(cl[n-1][1] - cl[n-2][1], cl[n-1][0] - cl[n-2][0]) * 180 / Math.PI;

  // Wrap to shortest angular difference.
  let diff = Math.abs(firstBearing - lastBearing);
  if (diff > 180) diff = 360 - diff;

  expect(diff,
    `Centerline bearing change = ${diff.toFixed(1)}° (first=${firstBearing.toFixed(1)}°, ` +
    `last=${lastBearing.toFixed(1)}°) — must exceed 8° to prove a real curve`
  ).toBeGreaterThan(8);

  await shoot(page, 'cr2-bearing-change');
});

// ---------------------------------------------------------------------------
// CR3 — centerline max |y| > 10 m: road deviates from straight bearing axis
// ---------------------------------------------------------------------------
test('CR3 — centerline max |y| > 10 m (approach/departure curve away from straight axis)', async ({ page }) => {
  await waitForReady(page);

  const cl: number[][] = await page.evaluate(() => (window as any).__meta?.centerline);

  expect(cl, 'meta.centerline must be present').toBeTruthy();

  const maxAbsY = Math.max(...cl.map((pt) => Math.abs(pt[1])));

  expect(maxAbsY,
    `Centerline max |y| = ${maxAbsY.toFixed(1)} m — must exceed 10 m to prove a genuine curve ` +
    `(a perfectly straight road aligned with the bearing-104° axis would have max |y| ≈ 0)`
  ).toBeGreaterThan(10);

  await shoot(page, 'cr3-centerline-curve');
});

// ---------------------------------------------------------------------------
// CR4 — every vehicle local-y is within the road half-width of the centerline
// ---------------------------------------------------------------------------
test('CR4 — every vehicle stays within roadHalfWidthM + 2 m of the centerline (on-road)', async ({ page }) => {
  await waitForReady(page);

  // Advance sim so vehicles are distributed along the approach as well as the plaza.
  await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.clock.multiplier = 60;
    v.clock.shouldAnimate = true;
  });
  await page.waitForTimeout(500);   // ≈ 30 s sim at 60× multiplier
  await page.evaluate(() => { (window as any).__viewer.clock.multiplier = 1; });

  const violations: string[] = await page.evaluate(() => {
    const viewer  = (window as any).__viewer;
    const T       = (window as any).__T;
    const meta    = (window as any).__meta;
    if (!T || !meta) return ['__T or __meta not available'];

    const cl:   number[][] = meta.centerline;       // [[x, y], ...]
    const halfW: number    = meta.roadHalfWidthM;
    const SLOP  = 2.0;                              // metres of tolerance

    /** Linearly interpolate centerline y at a given x. */
    function clY(x: number): number {
      if (!cl || cl.length < 2) return 0;
      if (x <= cl[0][0])           return cl[0][1];
      if (x >= cl[cl.length - 1][0]) return cl[cl.length - 1][1];
      for (let i = 0; i < cl.length - 1; i++) {
        const [x0, y0] = cl[i], [x1, y1] = cl[i + 1];
        if (x >= x0 && x <= x1) {
          const t = (x - x0) / (x1 - x0);
          return y0 + t * (y1 - y0);
        }
      }
      return 0;
    }

    const time  = viewer.clock.currentTime;
    const ell   = viewer.scene.globe.ellipsoid;
    const viols: string[] = [];

    for (const e of viewer.entities.values) {
      if (!e.model) continue;
      const cart = e.position?.getValue(time);
      if (!cart) continue;
      const carto = ell.cartesianToCartographic(cart);
      if (!carto) continue;
      const lon = (carto.longitude * 180) / Math.PI;
      const lat = (carto.latitude  * 180) / Math.PI;

      // Convert world → local SUMO metres via the active transform.
      const local = T.worldToSumo(lon, lat);
      const refY  = clY(local.x);
      const offset = Math.abs(local.y - refY);

      if (offset > halfW + SLOP) {
        viols.push(
          `Vehicle at local(x=${local.x.toFixed(1)}, y=${local.y.toFixed(1)}) ` +
          `offset ${offset.toFixed(1)} m from centerline (refY=${refY.toFixed(1)}) — ` +
          `exceeds halfW(${halfW.toFixed(1)}) + slop(${SLOP})`
        );
      }
    }
    return viols;
  });

  await shoot(page, 'cr4-on-road-invariant');
  expect(violations, `Off-road vehicles:\n${violations.join('\n')}`).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// CR5 — onRoadPct ≥ 0.98 (lateral clamp keeps vehicles on the carriageway)
// ---------------------------------------------------------------------------
test('CR5 — window.__kpi.onRoadPct ≥ 0.98 (lateral clamp validation)', async ({ page }) => {
  await waitForReady(page);

  const kpi = await page.evaluate(() => (window as any).__kpi);

  expect(kpi,                     'window.__kpi must be set').toBeTruthy();
  expect(kpi.onRoadPct,           'kpi.onRoadPct must be a number').not.toBeUndefined();
  expect(typeof kpi.onRoadPct).toBe('number');
  expect(kpi.onRoadPct,
    `onRoadPct = ${kpi.onRoadPct} — must be ≥ 0.98 (lateral clamp must keep almost all vehicles on the carriageway)`
  ).toBeGreaterThanOrEqual(0.98);

  await shoot(page, 'cr5-on-road-pct');
});

// ---------------------------------------------------------------------------
// CR-BEFORE/AFTER — screenshot pair: before curve (straight overlay) vs after (curved)
// ---------------------------------------------------------------------------
test('CR-SHOT — before/after screenshots showing vehicles following the real curved road', async ({ page }) => {
  await waitForReady(page);

  // Top-down view of the full corridor.
  const before = await shoot(page, 'curve-approach-topdown');

  // Fast-forward so vehicles are visible in the approach and departure.
  await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.clock.multiplier = 60;
    v.clock.shouldAnimate = true;
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => { (window as any).__viewer.clock.multiplier = 1; });

  // Switch to oblique for a close-up of vehicles on the curved approach.
  const viewBtn = page.locator('#btn-view');
  if (await viewBtn.count() > 0) await viewBtn.click();
  await page.waitForTimeout(400);
  const after = await shoot(page, 'curve-approach-oblique');

  expect(before).toContain('curve-approach-topdown.png');
  expect(after).toContain('curve-approach-oblique.png');
});
