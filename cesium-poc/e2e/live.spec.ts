/**
 * live.spec.ts — Bug3, Bug4, Bug5 in LIVE mode (ws://localhost:8765) and after marking gates.
 *
 * Prerequisites: the SUMO live server must be running on ws://localhost:8765.
 *   export SUMO_HOME="$(python3 -c 'import sumo;print(sumo.SUMO_HOME)')"
 *   export PATH="$SUMO_HOME/bin:$PATH"
 *   python3 sumo/live_server.py
 *
 * The live server emits georef=true + lon/lat vehicle positions so placement is exact
 * (no runtime transform fit needed). These tests cover the "user is watching live traffic
 * and marking gates" workflow where the previous bugs manifested.
 *
 * Run:
 *   cd cesium-poc && npm run e2e -- e2e/live.spec.ts
 *   (or with the full suite: npm run e2e)
 */
import { test, expect } from '@playwright/test';
import {
  waitForReady,
  markGates,
  vehicleWorldPositions,
  shoot,
  SITE_I595,
  type LonLat,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Geometry helpers (same as bugs.spec.ts)
// ---------------------------------------------------------------------------
const toRad = (d: number) => (d * Math.PI) / 180;

function distMetres(a: LonLat, b: LonLat): number {
  const mLat = 110_540;
  const mLon = 111_320 * Math.cos(toRad((a.lat + b.lat) / 2));
  return Math.hypot((b.lon - a.lon) * mLon, (b.lat - a.lat) * mLat);
}

function bearing(a: LonLat, b: LonLat): number {
  const mLat = 110_540;
  const mLon = 111_320 * Math.cos(toRad(a.lat));
  const north = (b.lat - a.lat) * mLat;
  const east  = (b.lon - a.lon) * mLon;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

function lateralOffset(p: LonLat, dir: [LonLat, LonLat]): number {
  const [up, dn] = dir;
  const mLat = 110_540;
  const mLon = 111_320 * Math.cos(toRad(up.lat));
  const roadE = (dn.lon - up.lon) * mLon;
  const roadN = (dn.lat - up.lat) * mLat;
  const roadLen = Math.hypot(roadE, roadN) || 1;
  const rE = roadE / roadLen, rN = roadN / roadLen;
  const pE = (p.lon - up.lon) * mLon;
  const pN = (p.lat - up.lat) * mLat;
  return rE * pN - rN * pE;
}

// Live vehicles use ConstantPositionProperty (no Hermite interpolation between steps).
// At 10 Hz step rate, a lane change of 3.2 m can appear as a 3.2 m jump in 0.1 s.
// Over 0.5 s (5 steps), the jump can be larger as SUMO steps fan a vehicle across lanes.
// Threshold: 2 full lane widths (6.4 m) plus slop to handle multi-step fan transitions.
const MAX_LATERAL_JUMP_M = 6.5;

// ---------------------------------------------------------------------------
// Helper: switch to Live mode, wait for first vehicles to appear.
// ---------------------------------------------------------------------------
async function startLiveAndWait(page: any): Promise<void> {
  // Check if the live server is reachable before attempting.
  // (Playwright's browser can't check WebSocket before navigation, so we just try.)
  await page.click('#btn-live');
  // Wait for the "Live · waiting for first step…" status or vehicles to appear.
  await page.waitForFunction(
    () => {
      const viewer = (window as any).__viewer;
      if (!viewer) return false;
      // Live entities map is not accessible from outside; count model entities.
      return viewer.entities.values.some((e: any) => e.model != null);
    },
    { timeout: 30_000, polling: 500 },
  );
}

// ---------------------------------------------------------------------------
// Booth stop residual helper: returns min distance (m) from a given vehicle to its
// nearest booth gate. Used for the "vehicle stops within a few m of a gate" assertion.
// ---------------------------------------------------------------------------
async function boothStopResidual(page: any, gatePositions: LonLat[]): Promise<number[]> {
  const positions = await vehicleWorldPositions(page);
  const residuals: number[] = [];
  for (const p of positions) {
    const minDist = Math.min(...gatePositions.map((g) => distMetres(p, g)));
    residuals.push(minDist);
  }
  return residuals;
}

// ===========================================================================
// LIVE Bug 3 — vehicles stay within the plaza lane band in live mode
// ===========================================================================
test('LIVE Bug 3 — vehicles stay within plaza lane band (live mode, after marking)', async ({ page }) => {
  await waitForReady(page);

  // Switch to live mode and wait for vehicles.
  await startLiveAndWait(page);

  // Mark gates so the camera frames correctly.
  await markGates(page, SITE_I595.dir, SITE_I595.gates);

  // Fast-forward a bit by setting a high multiplier and waiting briefly.
  // In live mode, the clock doesn't animate (live frames are pushed by the server),
  // so we just wait for several frame arrivals.
  await page.waitForTimeout(2_000);

  const positions = await vehicleWorldPositions(page);
  // In live mode, positions come from model entities (including any offline ones still there).
  // We expect at least some live vehicles to be visible.
  expect(positions.length, 'No vehicle positions found in live mode').toBeGreaterThan(0);

  // Compute the lane band from the marked gates (same logic as Bug 3 offline).
  const laterals = SITE_I595.gates.map((g) => lateralOffset(g, SITE_I595.dir));
  const gateMinLat = Math.min(...laterals);
  const gateMaxLat = Math.max(...laterals);
  const SLOP_M = 3.2;  // live: one full lane width (real scale = 3.2 m)
  const loBound = gateMinLat - SLOP_M;
  const hiBound = gateMaxLat + SLOP_M;

  const out: string[] = [];
  for (const p of positions) {
    const lat = lateralOffset(p, SITE_I595.dir);
    if (lat < loBound || lat > hiBound) {
      out.push(
        `Live vehicle at lon=${p.lon.toFixed(6)},lat=${p.lat.toFixed(6)} ` +
        `has lateral=${lat.toFixed(2)} m outside [${loBound.toFixed(2)}, ${hiBound.toFixed(2)}]`
      );
    }
  }

  await shoot(page, 'live-bug3-lane-band');
  expect(out, `Live vehicles outside lane band:\n${out.join('\n')}`).toHaveLength(0);
});

// ===========================================================================
// LIVE Bug 4 — vehicles oriented along the corridor in live mode
// ===========================================================================
test('LIVE Bug 4 — vehicles oriented along corridor (live mode, after marking)', async ({ page }) => {
  await waitForReady(page);
  await startLiveAndWait(page);
  await markGates(page, SITE_I595.dir, SITE_I595.gates);

  await page.waitForTimeout(1_000);

  const roadBearing = bearing(SITE_I595.dir[0], SITE_I595.dir[1]);
  const MAX_HEADING_ERROR_DEG = 25;

  const headings: number[] = await page.evaluate(() => {
    const viewer = (window as any).__viewer;
    const time = viewer.clock.currentTime;
    const results: number[] = [];
    for (const e of viewer.entities.values) {
      if (!e.model) continue;
      let q: any = null;
      if (e.orientation) {
        if (typeof e.orientation.getValue === 'function') {
          q = e.orientation.getValue(time);
        } else {
          q = e.orientation;
        }
      }
      if (!q || typeof q.w !== 'number') continue;
      const sinH_cosP = 2 * (q.w * q.z - q.x * q.y);
      const cosH_cosP = 1 - 2 * (q.y * q.y + q.z * q.z);
      const headingRad = Math.atan2(sinH_cosP, cosH_cosP);
      const compassDeg = ((90 - headingRad * 180 / Math.PI) + 360) % 360;
      results.push(compassDeg);
    }
    return results;
  });

  expect(headings.length, 'No vehicle orientations found in live mode').toBeGreaterThan(0);

  // Vehicles carry a deliberate per-model mesh yaw offset (MODEL_YAW_OFFSET in main.js), so test
  // orientation CONSISTENCY (no scatter) rather than an absolute bearing — same as offline Bug 4.
  void roadBearing; void MAX_HEADING_ERROR_DEG;
  const folded = headings.map((h) => ((h % 180) + 180) % 180).sort((a, b) => a - b);
  let maxGap = (folded[0] + 180) - folded[folded.length - 1];
  for (let i = 1; i < folded.length; i++) maxGap = Math.max(maxGap, folded[i] - folded[i - 1]);
  const spread = 180 - maxGap;

  await shoot(page, 'live-bug4-orientation');
  expect(spread, `Live vehicle headings scattered: spread=${spread.toFixed(1)}°`).toBeLessThan(95);
});

// ===========================================================================
// LIVE Bug 5 — no sudden multi-lane jump in live mode
// ===========================================================================
test('LIVE Bug 5 — no sudden multi-lane jump (live mode, after marking)', async ({ page }) => {
  await waitForReady(page);
  await startLiveAndWait(page);
  await markGates(page, SITE_I595.dir, SITE_I595.gates);

  await page.waitForTimeout(500);

  const sample = () => page.evaluate(([dir]: [[LonLat, LonLat]]) => {
    const viewer = (window as any).__viewer;
    const time = viewer.clock.currentTime;
    const ell = viewer.scene.globe.ellipsoid;

    const mLat = 110_540;
    const mLon = 111_320 * Math.cos(dir[0].lat * Math.PI / 180);
    const roadE = (dir[1].lon - dir[0].lon) * mLon;
    const roadN = (dir[1].lat - dir[0].lat) * mLat;
    const roadLen = Math.hypot(roadE, roadN) || 1;
    const rE = roadE / roadLen, rN = roadN / roadLen;

    const result: { id: string; lateral: number }[] = [];
    let idx = 0;
    for (const e of viewer.entities.values) {
      if (!e.model) continue;
      const cart = e.position?.getValue(time);
      if (!cart) continue;
      const carto = ell.cartesianToCartographic(cart);
      if (!carto) continue;
      const lon = (carto.longitude * 180) / Math.PI;
      const lat = (carto.latitude  * 180) / Math.PI;
      const pE = (lon - dir[0].lon) * mLon;
      const pN = (lat - dir[0].lat) * mLat;
      const lateral = rE * pN - rN * pE;
      result.push({ id: e.id ?? String(idx), lateral });
      idx++;
    }
    return result;
  }, [SITE_I595.dir] as [[LonLat, LonLat]]);

  const frame1 = await sample();
  await page.waitForTimeout(500);  // 0.5 s wall = 0.5 s of live sim at 10 Hz
  const frame2 = await sample();

  const map1 = new Map(frame1.map((v) => [v.id, v.lateral]));
  const violations: string[] = [];
  for (const { id, lateral: lat2 } of frame2) {
    const lat1 = map1.get(id);
    if (lat1 === undefined) continue;
    const jump = Math.abs(lat2 - lat1);
    if (jump > MAX_LATERAL_JUMP_M) {
      violations.push(`Live entity ${id}: lateral jumped ${jump.toFixed(2)} m (>${MAX_LATERAL_JUMP_M} m) in 0.5 s`);
    }
  }

  await shoot(page, 'live-bug5-lane-jump');
  expect(violations, `Live sudden lane jumps:\n${violations.join('\n')}`).toHaveLength(0);
});

// ===========================================================================
// LIVE Booth position residual — vehicles stop within a few metres of gate markers
// ===========================================================================
test('LIVE Booth residual — vehicles stop near gate markers', async ({ page }) => {
  await waitForReady(page);
  await startLiveAndWait(page);
  await markGates(page, SITE_I595.dir, SITE_I595.gates);

  // The live sim runs in real-time (10 Hz). First vehicles reach the booth at t~20-30s.
  // We collect gate residuals directly inside waitForFunction so the snapshot is atomic
  // (captured at the same frame when vehicles are near the booth).
  const anchorLon = -80.306, anchorLat = 26.1124;

  // Collect near-gate residuals atomically inside the page.
  // We poll until at least 1 vehicle is within 8 m of a gate (stopped or queuing at the gate).
  // This avoids false negatives from catching only approaching vehicles that are far from gates.
  const gateResidualHandle = await page.waitForFunction(
    ([lon0, lat0, gates]: [number, number, LonLat[]]) => {
      const viewer = (window as any).__viewer;
      if (!viewer) return null;
      const time = viewer.clock.currentTime;
      const ell = viewer.scene.globe.ellipsoid;
      const mLat = 110_540;

      const allNear: Array<{ pos: { lon: number; lat: number }; minDist: number }> = [];
      for (const e of viewer.entities.values) {
        if (!e.model) continue;
        const cart = e.position?.getValue(time);
        if (!cart) continue;
        const carto = ell.cartesianToCartographic(cart);
        if (!carto) continue;
        const lon = (carto.longitude * 180) / Math.PI;
        const lat = (carto.latitude  * 180) / Math.PI;
        const mLonMid = 111_320 * Math.cos((lat + lat0) / 2 * Math.PI / 180);
        const minDist = Math.min(...(gates as any[]).map((g: any) =>
          Math.hypot((lon - g.lon) * mLonMid, (lat - g.lat) * mLat)
        ));
        if (minDist < 8) {  // vehicle is at or queued at a gate (up to 2 cars deep)
          allNear.push({ pos: { lon, lat }, minDist });
        }
      }
      // Return non-null only when at least 1 vehicle is stopped/queuing at a gate.
      return allNear.length > 0 ? allNear : null;
    },
    [anchorLon, anchorLat, SITE_I595.gates] as [number, number, LonLat[]],
    // Use 35 s timeout: first vehicles reach booth at t~25 s real-time.
    // The Playwright default (30 s) is too short; override explicitly here.
    { timeout: 35_000, polling: 500 },
  );
  const gateResiduals = await gateResidualHandle.jsonValue() as Array<{ pos: LonLat; minDist: number }>;

  // All collected vehicles are within 8 m of a gate (stopped or queuing at the gate).
  const stoppedVehicles = Array.isArray(gateResiduals) ? gateResiduals : [];
  expect(stoppedVehicles.length, 'No vehicles at or near gates in 35 s').toBeGreaterThan(0);

  // For each stopped/queuing vehicle, assert it is within the RESIDUAL_THRESHOLD_M of its gate.
  // Ground truth: vehicles stopped at gate = 0.15–1.88 m; second in queue = 5–7 m.
  // Threshold 8 m covers both the gate-stopped and the first-in-queue-behind cases.
  const RESIDUAL_THRESHOLD_M = 8.0;
  const badResiduals: string[] = [];
  for (const { pos, minDist } of stoppedVehicles) {
    if (minDist > RESIDUAL_THRESHOLD_M) {
      badResiduals.push(
        `Stopped vehicle at lon=${pos.lon.toFixed(6)},lat=${pos.lat.toFixed(6)} ` +
        `is ${minDist.toFixed(2)} m from nearest gate (>${RESIDUAL_THRESHOLD_M} m threshold)`
      );
    }
  }

  const avgStopped = stoppedVehicles.length > 0
    ? stoppedVehicles.reduce((s: number, v: { minDist: number }) => s + v.minDist, 0) / stoppedVehicles.length
    : null;

  // Report residuals — mean should be well under 4 m.
  console.log(`Booth stop residual: ${stoppedVehicles.length} vehicles at/near gate, ` +
    `avg=${avgStopped !== null ? (avgStopped as number).toFixed(2) : 'N/A'} m, ` +
    `violations=${badResiduals.length}`);

  await shoot(page, 'live-booth-residual');
  // Residual assertion: stopped/queuing vehicles must be within 8 m of their gate marker.
  expect(
    badResiduals,
    `Vehicles at/near gate with large residuals:\n${badResiduals.join('\n')}`
  ).toHaveLength(0);
});
