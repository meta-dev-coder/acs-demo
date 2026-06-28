/**
 * bugs.spec.ts — TDD "red" specs encoding user-reported bugs.
 *
 * Each test is written so that:
 *   - It FAILS when the bug is present (red = bug confirmed).
 *   - It PASSES once the bug is fixed (green = regression guard).
 *
 * Expected status TODAY (before any fix):
 *   Bug 1 — traffic-pauses-on-mark         : RED  (clock stays running)
 *   Bug 2 — no-cash-at-aet-gate            : RED  (orange vehicles can stop at green gates)
 *   Bug 3 — vehicles-in-lane-band          : RED  (vehicles appear between/outside booths)
 *   Bug 4 — vehicles-oriented-along-road   : RED  (vehicles rotate sideways / wrong heading)
 *   Bug 5 — no-sudden-lane-jump            : RED  (vehicles teleport across lanes)
 *   Bug 6 — vehicles-use-gltf-model        : RED  (vehicles rendered as boxes, not glTF)
 *
 * Run:
 *   cd cesium-poc && npm run e2e -- --project=chromium e2e/bugs.spec.ts
 */
import { test, expect } from '@playwright/test';
import {
  waitForReady,
  markGates,
  counts,
  clockAnimating,
  vehicleWorldPositions,
  shoot,
  SITE_I595,
  type LonLat,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Geometry helpers (pure JS, run in Node — no Cesium needed)
// ---------------------------------------------------------------------------

/** Degrees → radians. */
const toRad = (d: number) => (d * Math.PI) / 180;

/**
 * Approximate distance in metres between two lon/lat points (equirectangular).
 * Good enough within a ≈1 km plaza extent.
 */
function distMetres(a: LonLat, b: LonLat): number {
  const mLat = 110_540;
  const mLon = 111_320 * Math.cos(toRad((a.lat + b.lat) / 2));
  const dy = (b.lat - a.lat) * mLat;
  const dx = (b.lon - a.lon) * mLon;
  return Math.hypot(dx, dy);
}

/**
 * Compass bearing (deg, 0=N, CW) from point a to point b.
 */
function bearing(a: LonLat, b: LonLat): number {
  const mLat = 110_540;
  const mLon = 111_320 * Math.cos(toRad(a.lat));
  const north = (b.lat - a.lat) * mLat;
  const east  = (b.lon - a.lon) * mLon;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

/**
 * Signed lateral offset (metres, positive = left of road looking down-road) of point p
 * from the line defined by dir[0]→dir[1].
 */
function lateralOffset(p: LonLat, dir: [LonLat, LonLat]): number {
  const [up, dn] = dir;
  const mLat = 110_540;
  const mLon = 111_320 * Math.cos(toRad(up.lat));
  // Unit vector along road (east, north in metres)
  const roadE = (dn.lon - up.lon) * mLon;
  const roadN = (dn.lat - up.lat) * mLat;
  const roadLen = Math.hypot(roadE, roadN) || 1;
  const rE = roadE / roadLen, rN = roadN / roadLen;
  // Vector from up to p
  const pE = (p.lon - up.lon) * mLon;
  const pN = (p.lat - up.lat) * mLat;
  // Lateral = cross product (rE, rN) × (pE, pN)  (z component = signed lateral)
  return rE * pN - rN * pE;
}

// I-595 transform params (mirrors SITES[0] in main.js)
const I595_BEARING_DEG = 104;
// Booth span derived from SUMO bounds (-14.4 .. +14.4) × scale 0.5 = ±7.2 m total 14.4 m
const BOOTH_HALF_SPAN_M = 14.4 * 0.5 * 0.5 + 2.0; // 3.6 m half-span + 1 lane-width buffer
// A full lane width is ~2 m in SUMO; 1.2 lane widths = 2.4 m
const MAX_LATERAL_JUMP_M = 2.4;

// ============================================================================
// Bug 1 — traffic pauses when entering mark mode
// EXPECTED TODAY: RED — the app does NOT pause the clock when #btn-calib is clicked.
// FIX: main.js installMarking() should call viewer.clock.shouldAnimate = false on entry.
// ============================================================================
test('Bug 1 — traffic pauses when marking starts', async ({ page }) => {
  // BUG: clicking #btn-calib (Mark gates) to ENTER mark mode must pause the clock.
  // Currently it leaves shouldAnimate=true → test fails (which is correct red behaviour).
  await waitForReady(page);

  // Confirm clock is running before we start.
  const before = await clockAnimating(page);
  expect(before).toBe(true);

  // Click the "Mark gates" button to ENTER mark mode (first click = enter, second = finish).
  await page.click('#btn-calib');

  // Give main.js one JS tick to process the click handler.
  await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 150)));

  // BUG ASSERTION: clock must be paused while the user is picking points.
  const duringMark = await clockAnimating(page);
  // This will FAIL today (bug present) because the code doesn't pause.
  // It will PASS once the fix is applied.
  expect(duringMark).toBe(false);

  await shoot(page, 'bug1-mark-mode');
});

// ============================================================================
// Bug 2 — no cash (orange) vehicle sits at an AET (green) gate
// EXPECTED TODAY: RED — orange vehicles can be seen stopped at green-marked gates.
// FIX: vehicle-to-gate assignment must respect lane type (CASH_LANES Set in main.js).
// ============================================================================
test('Bug 2 — no cash car sits at an AET gate', async ({ page }) => {
  // Mark the first 3 gates as cash, the remaining 5 as AET.
  // This mirrors main.js rebuildBoothMarkers: "i < 3" → cash.
  await waitForReady(page);
  await markGates(page, SITE_I595.dir, SITE_I595.gates);

  // Advance the sim a few seconds so vehicles have settled into gate positions.
  await page.evaluate(() => {
    const v = (window as any).__viewer;
    const Cesium = (window as any).Cesium;
    // Advance clock by 10 s without Cesium ref: nudge currentTime directly.
    const t = v.clock.currentTime;
    // JulianDate arithmetic: add seconds
    // We don't have Cesium on window, so use a CSS trick: set multiplier high, wait, restore.
    v.clock.multiplier = 60;
    v.clock.shouldAnimate = true;
  });
  await page.waitForTimeout(1_000); // 1 s wall time × 60 multiplier = 60 s sim time
  await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.clock.multiplier = 1;
  });

  // Collect gate positions and their types (cash = i<3).
  const gatePositions = SITE_I595.gates.map((g, i) => ({ ...g, cash: i < 3 }));

  // Collect vehicle positions and colours from Cesium.
  const vehicleData: Array<{ lon: number; lat: number; isCash: boolean; isEtc: boolean }> =
    await page.evaluate(({ cashHex, etcHex }) => {
      const viewer = (window as any).__viewer;
      const time = viewer.clock.currentTime;
      const ell = viewer.scene.globe.ellipsoid;
      function hexToF(h: string): [number, number, number] {
        const s = h.replace('#', '');
        return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255];
      }
      function colorMatches(colorProp: any, hex: string): boolean {
        if (!colorProp) return false;
        // model.color is a ConstantProperty wrapping a Color
        const c = colorProp.getValue ? colorProp.getValue(undefined) : colorProp;
        if (!c || typeof c.red !== 'number') return false;
        const [r, g, b] = hexToF(hex);
        const eps = 1 / 255 + 0.001;
        return Math.abs(c.red - r) < eps && Math.abs(c.green - g) < eps && Math.abs(c.blue - b) < eps;
      }
      const results: Array<{ lon: number; lat: number; isCash: boolean; isEtc: boolean }> = [];
      for (const e of viewer.entities.values) {
        if (!e.model) continue;
        const cart = e.position?.getValue(time);
        if (!cart) continue;
        const carto = ell.cartesianToCartographic(cart);
        if (!carto) continue;
        const lon = (carto.longitude * 180) / Math.PI;
        const lat = (carto.latitude  * 180) / Math.PI;
        const isCash = colorMatches(e.model.color, cashHex);
        const isEtc  = colorMatches(e.model.color, etcHex);
        results.push({ lon, lat, isCash, isEtc });
      }
      return results;
    }, { cashHex: '#ff9b1a', etcHex: '#1ccb40' });

  // For each vehicle within 3 m of a gate, assert lane-type matches.
  const GATE_PROXIMITY_M = 3;
  const violations: string[] = [];
  for (const veh of vehicleData) {
    for (const gate of gatePositions) {
      const d = distMetres(veh, gate);
      if (d < GATE_PROXIMITY_M) {
        if (veh.isCash && !gate.cash) {
          violations.push(
            `Cash vehicle at lon=${veh.lon.toFixed(6)},lat=${veh.lat.toFixed(6)} is within ${d.toFixed(1)} m of AET gate ${gate.lon.toFixed(6)},${gate.lat.toFixed(6)}`
          );
        }
        if (veh.isEtc && gate.cash) {
          violations.push(
            `AET vehicle at lon=${veh.lon.toFixed(6)},lat=${veh.lat.toFixed(6)} is within ${d.toFixed(1)} m of cash gate ${gate.lon.toFixed(6)},${gate.lat.toFixed(6)}`
          );
        }
      }
    }
  }

  await shoot(page, 'bug2-lane-type-mismatch');
  // BUG ASSERTION: expect no cross-type gate proximity violations.
  expect(violations, `Lane-type violations:\n${violations.join('\n')}`).toHaveLength(0);
});

// ============================================================================
// Bug 3 — vehicles stay within the plaza lane band (not in dividers)
// EXPECTED TODAY: RED — some vehicles land outside the booth span.
// FIX: SUMO Y assignment must stay within [minY, maxY]; no clamping to outer dividers.
// ============================================================================
test('Bug 3 — vehicles stay within the plaza lane band (not in dividers)', async ({ page }) => {
  await waitForReady(page);
  await markGates(page, SITE_I595.dir, SITE_I595.gates);

  // Fast-forward the sim.
  await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.clock.multiplier = 60;
    v.clock.shouldAnimate = true;
  });
  await page.waitForTimeout(800);
  await page.evaluate(() => { (window as any).__viewer.clock.multiplier = 1; });

  const positions = await vehicleWorldPositions(page);

  // The plaza centre is the mean of all gate lats/lons.
  const gateLons = SITE_I595.gates.map(g => g.lon);
  const gateLats = SITE_I595.gates.map(g => g.lat);
  const centreLon = gateLons.reduce((s, v) => s + v, 0) / gateLons.length;
  const centreLat = gateLats.reduce((s, v) => s + v, 0) / gateLats.length;
  const centre: LonLat = { lon: centreLon, lat: centreLat };

  // Compute the span of marked gates perpendicular to the road.
  const laterals = SITE_I595.gates.map(g => lateralOffset(g, SITE_I595.dir));
  const gateMinLat = Math.min(...laterals);
  const gateMaxLat = Math.max(...laterals);
  // Allow one lane-width (≈2 m) of slop on each side.
  const SLOP_M = 2.0;
  const loBound = gateMinLat - SLOP_M;
  const hiBound = gateMaxLat + SLOP_M;

  const out: string[] = [];
  for (const p of positions) {
    const lat = lateralOffset(p, SITE_I595.dir);
    if (lat < loBound || lat > hiBound) {
      out.push(
        `Vehicle at lon=${p.lon.toFixed(6)},lat=${p.lat.toFixed(6)} has lateral=${lat.toFixed(2)} m outside [${loBound.toFixed(2)}, ${hiBound.toFixed(2)}]`
      );
    }
  }

  await shoot(page, 'bug3-lane-band');
  expect(out, `Vehicles outside lane band:\n${out.join('\n')}`).toHaveLength(0);
});

// ============================================================================
// Bug 4 — vehicles are oriented along the corridor
// EXPECTED TODAY: RED — entity.orientation does not match road bearing.
// FIX: headingRad() in main.js must add bearingDeg correctly; currently can be 90° off.
// ============================================================================
test('Bug 4 — vehicles are oriented along the corridor', async ({ page }) => {
  await waitForReady(page);

  // Road bearing from SITE_I595.dir.
  const roadBearing = bearing(SITE_I595.dir[0], SITE_I595.dir[1]);
  // 45° tolerance: vehicles during lane changes in the fan-out/fan-in can be at up to ~30-40° to
  // the main road bearing. The FCD angle changes smoothly through lane changes. The test confirms
  // no gross misorientation (e.g. 90° sideways or pointing backwards in the wrong direction).
  const MAX_HEADING_ERROR_DEG = 45;

  // Read orientation quaternion for each vehicle entity in the page.
  const headings: number[] = await page.evaluate(() => {
    const viewer = (window as any).__viewer;
    const time = viewer.clock.currentTime;
    const results: number[] = [];

    for (const e of viewer.entities.values) {
      if (!e.model) continue;
      // orientation may be a CallbackProperty or a quaternion directly
      let q: any = null;
      if (e.orientation) {
        if (typeof e.orientation.getValue === 'function') {
          q = e.orientation.getValue(time);
        } else {
          q = e.orientation;
        }
      }
      if (!q || typeof q.w !== 'number') continue;

      // Convert quaternion to heading (yaw around the z-axis in ENU frame is tricky;
      // use the standard formula: heading from quaternion in ENU = atan2(2*(qw*qz + qx*qy), 1 - 2*(qy^2 + qz^2))
      // Cesium uses a different convention (HPR); derive heading component:
      // For a HeadingPitchRoll rotation, the quaternion maps as:
      //   heading = atan2(2(qw*qz - qx*qy), 1 - 2(qy² + qz²))  [approx for pitch=roll=0]
      const sinH_cosP = 2 * (q.w * q.z - q.x * q.y);
      const cosH_cosP = 1 - 2 * (q.y * q.y + q.z * q.z);
      const headingRad = Math.atan2(sinH_cosP, cosH_cosP);
      // Convert Cesium heading (radians from east, CCW) to compass degrees (CW from north).
      const compassDeg = ((90 - headingRad * 180 / Math.PI) + 360) % 360;
      results.push(compassDeg);
    }
    return results;
  });

  expect(headings.length, 'No vehicle orientations found').toBeGreaterThan(0);

  const violations: string[] = [];
  for (const h of headings) {
    // Angle difference on a circle (handles wrap-around).
    let diff = Math.abs(h - roadBearing) % 360;
    if (diff > 180) diff = 360 - diff;
    // Vehicles travel in either direction along the corridor, so also check the reverse bearing.
    const reverseBearing = (roadBearing + 180) % 360;
    let diffRev = Math.abs(h - reverseBearing) % 360;
    if (diffRev > 180) diffRev = 360 - diffRev;
    const minDiff = Math.min(diff, diffRev);
    if (minDiff > MAX_HEADING_ERROR_DEG) {
      violations.push(`Heading ${h.toFixed(1)}° is ${minDiff.toFixed(1)}° off road bearing ${roadBearing.toFixed(1)}°`);
    }
  }

  await shoot(page, 'bug4-vehicle-orientation');
  expect(violations, `Orientation violations:\n${violations.join('\n')}`).toHaveLength(0);
});

// ============================================================================
// Bug 5 — no sudden multi-lane jump between consecutive frames
// EXPECTED TODAY: RED — vehicles teleport 2+ lanes laterally in a single step.
// FIX: SUMO trajectory interpolation (Hermite) must be applied; raw SUMO step data
//      should not snap vehicles abruptly to a new Y position.
// ============================================================================
test('Bug 5 — no sudden multi-lane jump', async ({ page }) => {
  await waitForReady(page);
  await markGates(page, SITE_I595.dir, SITE_I595.gates);

  // Run at clock multiplier=1 so we sample near real time.
  await page.evaluate(() => {
    const v = (window as any).__viewer;
    v.clock.multiplier = 1;
    v.clock.shouldAnimate = true;
  });

  // Sample vehicle lateral offsets at t=0 and t+500 ms.
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
  await page.waitForTimeout(500); // ~0.5 s wall = 0.5 s sim time at multiplier 1
  const frame2 = await sample();

  // Build a map of lateral offsets by entity id from both frames.
  const map1 = new Map(frame1.map(v => [v.id, v.lateral]));
  const violations: string[] = [];
  for (const { id, lateral: lat2 } of frame2) {
    const lat1 = map1.get(id);
    if (lat1 === undefined) continue; // new entity, skip
    const jump = Math.abs(lat2 - lat1);
    if (jump > MAX_LATERAL_JUMP_M) {
      violations.push(`Entity ${id}: lateral jumped ${jump.toFixed(2)} m (>${MAX_LATERAL_JUMP_M} m) in 0.5 s`);
    }
  }

  await shoot(page, 'bug5-lane-jump');
  expect(violations, `Sudden lane jumps:\n${violations.join('\n')}`).toHaveLength(0);
});

// ============================================================================
// Bug 6 — vehicles render as glTF models, not boxes
// EXPECTED TODAY: RED — vehicles are Cesium box entities, not glTF model entities.
// FIX: replace the .box graphic with a .model graphic pointing to a glTF car asset.
// ============================================================================
test('Bug 6 — vehicles render as glTF models, not boxes', async ({ page }) => {
  // This test will be RED until the rebuild replaces box graphics with model graphics.
  await waitForReady(page);

  const result = await page.evaluate(() => {
    const viewer = (window as any).__viewer;
    const entities: any[] = viewer.entities.values;

    const boxCount   = entities.filter((e: any) => e.box   != null).length;
    const modelCount = entities.filter((e: any) => e.model != null).length;
    return { boxCount, modelCount };
  });

  await shoot(page, 'bug6-vehicle-graphics');

  // BUG ASSERTION: no box entities for vehicles, must be model entities.
  // Currently FAILS because all vehicles use .box.
  expect(result.boxCount, `${result.boxCount} box-vehicle entities still present`).toBe(0);
  expect(result.modelCount, `Expected glTF model entities, got ${result.modelCount}`).toBeGreaterThan(0);
});
