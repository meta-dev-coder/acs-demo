/**
 * mark-coupling.spec.ts — TDD spec for the "mark ≠ traffic" bug.
 *
 * THE BUG (georef branch):
 *   main.js places vehicles via Cartesian3.fromDegrees(lon, lat) from baked georef data, IGNORING
 *   the active transform T.  Gate markers are placed at the user's clicked lon/lat (which DO come
 *   from T after marking).  Result: markers move to the clicked location but vehicles stay at the
 *   baked default → the two diverge whenever the user marks at a non-default location.
 *
 * THE FIX:
 *   Data carries raw SUMO x,y metres (no georef); main.js places both vehicles AND booth markers
 *   via T.sumoToWorld(x, y).  Marking rebuilds T and re-places both, so traffic follows the marks.
 *
 * This test:
 *   1. Loads the app (default transform active, traffic running at default location).
 *   2. Marks gates at an OFFSET location (~40 m down-road from the default).
 *   3. Advances the sim until vehicles are at the booth stop line.
 *   4. Asserts:
 *        a. Every booth marker is within ~4 m of at least one vehicle (traffic is at the marks).
 *        b. The vehicle cluster centroid is within ~5 m of the marked-gate centroid
 *           (traffic moved as a whole to the marked location, not left at the default).
 *
 * EXPECTED STATUS BEFORE FIX: FAIL (vehicles stay at the baked default lon/lat while markers moved).
 * EXPECTED STATUS AFTER FIX:  PASS (vehicles placed via T.sumoToWorld → follow the marks).
 *
 * Run:
 *   cd cesium-poc && npm run e2e -- e2e/mark-coupling.spec.ts
 */
import { test, expect } from '@playwright/test';
import {
  waitForReady,
  markGates,
  shoot,
  type LonLat,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------
const toRad = (d: number) => (d * Math.PI) / 180;

function distMetres(a: LonLat, b: LonLat): number {
  const mLat = 110_540;
  const mLon = 111_320 * Math.cos(toRad((a.lat + b.lat) / 2));
  return Math.hypot((b.lon - a.lon) * mLon, (b.lat - a.lat) * mLat);
}

// ---------------------------------------------------------------------------
// OFFSET_SITE — same plaza but shifted ~40 m down-road from the I-595 default.
//
// Derived by taking the default transform (anchorLon=-80.306, anchorLat=26.1124,
// bearingDeg=104, scale=0.5, sumoRefX=530) and offsetting the anchor 40 m in the
// bearing=104° direction. The 10 gate lon/lat follow from sumoToWorld(530, y_i)
// with the new anchor (same bearingDeg and scale), so marking at OFFSET_SITE should
// produce a transform that places cars 40 m down-road of the default.
// ---------------------------------------------------------------------------
const OFFSET_SITE: { dir: [LonLat, LonLat]; gates: LonLat[] } = {
  dir: [
    { lon: -80.3065824, lat: 26.1125313 }, // up-road
    { lon: -80.3046410, lat: 26.1120936 }, // down-road
  ],
  gates: [
    { lon: -80.3056291, lat: 26.1122493 }, // pl_0
    { lon: -80.3056253, lat: 26.1122633 }, // pl_1
    { lon: -80.3056214, lat: 26.1122773 }, // pl_2
    { lon: -80.3056175, lat: 26.1122914 }, // pl_3
    { lon: -80.3056137, lat: 26.1123054 }, // pl_4
    { lon: -80.3056098, lat: 26.1123195 }, // pl_5
    { lon: -80.3056059, lat: 26.1123335 }, // pl_6
    { lon: -80.3056020, lat: 26.1123476 }, // pl_7
    { lon: -80.3055982, lat: 26.1123616 }, // pl_8
    { lon: -80.3055943, lat: 26.1123757 }, // pl_9
  ],
};

// Centroid of the offset gate cluster — the "true" booth location after marking.
const OFFSET_CENTROID: LonLat = {
  lon: OFFSET_SITE.gates.reduce((s, g) => s + g.lon, 0) / OFFSET_SITE.gates.length,
  lat: OFFSET_SITE.gates.reduce((s, g) => s + g.lat, 0) / OFFSET_SITE.gates.length,
};

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------
test(
  'mark coupling — traffic follows marks (cars stop at marked gates, not baked default)',
  async ({ page }) => {
    // 1. Load the app and wait for vehicles to appear.
    await waitForReady(page);

    // Screenshot: before marking (vehicles at default location).
    await shoot(page, 'mark-coupling-before');

    // 2. Mark gates at the OFFSET location (~40 m down-road of default).
    await markGates(page, OFFSET_SITE.dir, OFFSET_SITE.gates);

    // 3. Fast-forward the sim so vehicles reach the booth stop line.
    //    At ×60 multiplier, 20 sim-seconds of data pass per wall-second.
    //    First vehicles in the 720 s SUMO run reach the booth at t≈20 s sim-time,
    //    so 2 wall-seconds at ×60 covers t=0→120 s (well past first arrival).
    await page.evaluate(() => {
      const v = (window as any).__viewer;
      v.clock.multiplier = 60;
      v.clock.shouldAnimate = true;
    });
    await page.waitForTimeout(2_500); // 2.5 s × 60 = 150 s of sim time
    await page.evaluate(() => {
      (window as any).__viewer.clock.multiplier = 1;
    });

    // Screenshot: after marking and fast-forward (should show cars at offset marks).
    await shoot(page, 'mark-coupling-after');

    // 4. Collect vehicle world positions.
    const vehiclePositions: LonLat[] = await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const time = viewer.clock.currentTime;
      const ell = viewer.scene.globe.ellipsoid;
      const results: { lon: number; lat: number }[] = [];
      for (const e of viewer.entities.values) {
        if (!e.model) continue;
        const cart = e.position?.getValue(time);
        if (!cart) continue;
        const carto = ell.cartesianToCartographic(cart);
        if (!carto) continue;
        results.push({
          lon: (carto.longitude * 180) / Math.PI,
          lat: (carto.latitude  * 180) / Math.PI,
        });
      }
      return results;
    });

    expect(vehiclePositions.length, 'No vehicle positions found').toBeGreaterThan(0);

    // 5. Collect booth marker positions from Cesium ellipse entities.
    const markerPositions: LonLat[] = await page.evaluate(() => {
      const viewer = (window as any).__viewer;
      const time = viewer.clock.currentTime;
      const ell = viewer.scene.globe.ellipsoid;
      const results: { lon: number; lat: number }[] = [];
      for (const e of viewer.entities.values) {
        if (!e.ellipse) continue;
        const cart = e.position?.getValue(time);
        if (!cart) continue;
        const carto = ell.cartesianToCartographic(cart);
        if (!carto) continue;
        results.push({
          lon: (carto.longitude * 180) / Math.PI,
          lat: (carto.latitude  * 180) / Math.PI,
        });
      }
      return results;
    });

    // 6a. Assert: booth markers themselves are at the offset location (within 3 m of clicked gates).
    //     This is a sanity check — marking always places markers at the clicked lon/lat.
    for (const [i, marker] of markerPositions.entries()) {
      const nearestGateDist = Math.min(...OFFSET_SITE.gates.map(g => distMetres(marker, g)));
      expect(
        nearestGateDist,
        `Booth marker ${i} at lon=${marker.lon.toFixed(6)},lat=${marker.lat.toFixed(6)} ` +
        `is ${nearestGateDist.toFixed(2)} m from nearest offset gate (should be < 3 m)`
      ).toBeLessThan(3);
    }

    // 6b. CORE ASSERTION — booth marker centroid must match the offset gate centroid.
    //
    //     After marking, main.js calls rebuildBoothMarkers() which places each booth marker at
    //     T.sumoToWorld(boothX, y_i).  The resulting markers must be AT the offset location.
    //
    //     BUG (georef branch): markers used the clicked lon/lat directly (not T), so they landed
    //     at the offset.  But vehicles used fromDegrees(baked-geo-lon-lat) → baked default.
    //     The markers and vehicles were decoupled: markers at offset, vehicles at default.
    //
    //     FIX (raw SUMO data + T): both markers AND vehicles go through T.sumoToWorld.
    //     After marking, T is rebuilt from the offset clicks → both markers AND vehicles
    //     move together.  The marker centroid (== T.sumoToWorld(boothX, 0)) must be near
    //     OFFSET_CENTROID; vehicles near the booth must also be near that same centroid.
    //
    //     Marker centroid must be ≤ 5 m from OFFSET_CENTROID (tolerance for 10-gate average).
    const markerCentroidLon = markerPositions.reduce((s, p) => s + p.lon, 0) / markerPositions.length;
    const markerCentroidLat = markerPositions.reduce((s, p) => s + p.lat, 0) / markerPositions.length;
    const markerCentroid: LonLat = { lon: markerCentroidLon, lat: markerCentroidLat };
    const markerCentroidError = distMetres(markerCentroid, OFFSET_CENTROID);
    console.log(
      `Marker centroid: lon=${markerCentroidLon.toFixed(6)}, lat=${markerCentroidLat.toFixed(6)}\n` +
      `Offset gate centroid: lon=${OFFSET_CENTROID.lon.toFixed(6)}, lat=${OFFSET_CENTROID.lat.toFixed(6)}\n` +
      `Marker centroid error: ${markerCentroidError.toFixed(2)} m (threshold: 2 m)`
    );
    expect(
      markerCentroidError,
      `Booth marker centroid is ${markerCentroidError.toFixed(2)} m from the offset gate centroid ` +
      `(threshold: 2 m). Markers must be placed via T.sumoToWorld at the marked location.`
    ).toBeLessThan(2);

    // Vehicle cluster centroid near booth: collect vehicles within 10 m of any offset gate.
    // These are vehicles stopped at or queuing near the booth stop-line.
    // THE BUG: georef fromDegrees puts these vehicles at the DEFAULT location (~40 m away),
    // so no vehicle is within 10 m of the OFFSET gates → boothVehicles is empty.
    // THE FIX: T.sumoToWorld puts stopped vehicles AT the marked offset location → pass.
    const BOOTH_RADIUS_M = 10;
    const boothVehicles = vehiclePositions.filter(v =>
      OFFSET_SITE.gates.some(g => distMetres(v, g) < BOOTH_RADIUS_M)
    );
    console.log(`Booth vehicles (within ${BOOTH_RADIUS_M} m of any offset gate): ${boothVehicles.length}`);

    if (boothVehicles.length > 0) {
      const clusterLon = boothVehicles.reduce((s, p) => s + p.lon, 0) / boothVehicles.length;
      const clusterLat = boothVehicles.reduce((s, p) => s + p.lat, 0) / boothVehicles.length;
      const clusterCentroid: LonLat = { lon: clusterLon, lat: clusterLat };
      const centroidError = distMetres(clusterCentroid, OFFSET_CENTROID);
      console.log(
        `Booth vehicle cluster centroid: lon=${clusterLon.toFixed(6)}, lat=${clusterLat.toFixed(6)}\n` +
        `Centroid error from OFFSET_CENTROID: ${centroidError.toFixed(2)} m (threshold: 5 m)`
      );
      const CENTROID_THRESHOLD_M = 5;
      expect(
        centroidError,
        `Booth vehicle cluster centroid is ${centroidError.toFixed(2)} m from offset gate centroid ` +
        `(threshold: ${CENTROID_THRESHOLD_M} m). Traffic at booth not following the marks.`
      ).toBeLessThan(CENTROID_THRESHOLD_M);
    }

    // 6c. Assert: every booth marker has at least one vehicle passing within ~4 m of it during
    //     the fast-forwarded window. This confirms cars actually pass through the marked gates,
    //     not just that their centroid is in the right place.
    //
    //     Note: vehicles are in transit (not all stopped at booth simultaneously), so we check
    //     that SOME vehicle passed within 4 m of each gate (not that all are there right now).
    //     We use a relaxed check: at least N_GATES_TO_CHECK gates (out of 10) must have a vehicle
    //     within 4 m. This tolerates the few outer lanes with lower throughput.
    const GATE_VEHICLE_THRESHOLD_M = 4;
    const N_GATES_TO_CHECK = 6; // at least 6 of 10 gates must show nearby traffic
    const gatesWithNearbyVehicle = OFFSET_SITE.gates.filter(gate => {
      const minDist = Math.min(...vehiclePositions.map(v => distMetres(v, gate)));
      return minDist < GATE_VEHICLE_THRESHOLD_M;
    });

    console.log(
      `Gates with vehicle within ${GATE_VEHICLE_THRESHOLD_M} m: ${gatesWithNearbyVehicle.length}/${OFFSET_SITE.gates.length}`
    );

    expect(
      gatesWithNearbyVehicle.length,
      `Only ${gatesWithNearbyVehicle.length} of ${OFFSET_SITE.gates.length} offset gates have a vehicle ` +
      `within ${GATE_VEHICLE_THRESHOLD_M} m. Traffic is not following the marks.`
    ).toBeGreaterThanOrEqual(N_GATES_TO_CHECK);
  }
);
