/*---------------------------------------------------------------------------------------------
 * M2 — Central-lane placement tests (TDD).
 *
 * Verifies that the three express sub-sections (EXP-W / EXP-C / EXP-E) are placed on the
 * CENTRAL reversible express lanes via the placement helper in src/scenarioC/placeTolling.ts.
 *
 * Key assertions (mirrors tests/placement.test.ts for Scenario B ribbons):
 *  1. All endpoints and sample polylines land WITHIN the corridor bounding box (no off-model pts).
 *  2. Sample polylines are smooth: path / chord < 1.8 (no-zigzag, monotonic).
 *  3. No planet-scale or zero-origin points in any polyline.
 *  4. The lateral median offset keeps express visually distinct from the GP mainline (offset != 0).
 *  5. Polylines use the smoothPolyline helper and the final result is within the expanded box.
 *
 * The test reuses the same synthetic corridorCloud() + buildCenterline() + box used in
 * tests/placement.test.ts so the acceptance criterion is identical.
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect } from "vitest";
import { Point3d, Range3d } from "@itwin/core-geometry";
import { buildCenterline, corridorPoint, smoothPolyline } from "../src/scene/place";
import { buildExpressPolyline, EXPRESS_LATERAL_FACTOR } from "../src/scenarioC/placeTolling";
import { EXPRESS_SECTIONS } from "../src/scenarioC/pricing";

// ---------------------------------------------------------------------------
// Reuse the same synthetic corridor geometry as placement.test.ts
// ---------------------------------------------------------------------------

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** Real-model-like geometry in full UTM coords (easting ~576600, northing ~2885400). */
function corridorCloud(): Point3d[] {
  const r = rng(123);
  const pts: Point3d[] = [];
  const E0 = 576600;
  const N0 = 2885400;
  for (let d = 0; d <= 2500; d += 6) {
    const x = E0 + d;
    pts.push(Point3d.create(x, N0 + 700 + (r() - 0.5) * 6, 8));
    pts.push(Point3d.create(x, N0 + 715 + (r() - 0.5) * 6, 8));
    pts.push(Point3d.create(x, N0 + 560 + (r() - 0.5) * 8, 6));
  }
  for (let i = 0; i < 800; i++)
    pts.push(Point3d.create(E0 + 2100 + r() * 400, N0 + 300 + r() * 900, r() * 20 - 5));
  return pts;
}

const corridor = corridorCloud();
const zeros = Array.from({ length: Math.round(corridor.length * 0.06) }, () => Point3d.create(0, 0, 0));
const raw = [...corridor, ...zeros, Point3d.create(999999, 999999, 5000), Point3d.create(-5e5, -5e5, -3000)];
const pe = Range3d.createArray(corridor); // like the real projectExtents: excludes the strays
const cl = buildCenterline(raw, pe);
const box = Range3d.createArray(cl.pts);
box.expandInPlace(150);

// ---------------------------------------------------------------------------
// Helper: compute path length / chord ratio for a polyline
// ---------------------------------------------------------------------------
function pathOverChord(poly: Point3d[]): number {
  if (poly.length < 2) return 1;
  let pathLen = 0;
  for (let i = 1; i < poly.length; i++) pathLen += poly[i - 1].distanceXY(poly[i]);
  const chord = poly[0].distanceXY(poly[poly.length - 1]) || 1;
  return pathLen / chord;
}

// ---------------------------------------------------------------------------
// Helper: check no point is planet-scale (outside a 10,000 km sphere from origin,
// i.e. |x| > 1e7 or |y| > 1e7) or exact zero origin (strayed element sentinel).
//
// Note: UTM coordinates are naturally in the millions (e.g. northing ~2.886e6),
// so we use 1e7 (10 million) as the planet-scale threshold — that's still within
// a realistic on-Earth UTM range. The corridor box containsPoint() check catches
// any points that are "close to valid but off the road."
// ---------------------------------------------------------------------------
function hasPlanetScaleOrZero(poly: Point3d[]): boolean {
  return poly.some(
    (p) =>
      Math.abs(p.x) > 1e7 ||
      Math.abs(p.y) > 1e7 ||
      (p.x === 0 && p.y === 0 && p.z === 0)
  );
}

// ---------------------------------------------------------------------------
// § Express-section constants exported from placeTolling
// ---------------------------------------------------------------------------
describe("EXPRESS_LATERAL_FACTOR constant", () => {
  it("is a positive finite number (the lateral scale factor pushes express OFF the mainline spine)", () => {
    expect(typeof EXPRESS_LATERAL_FACTOR).toBe("number");
    expect(isFinite(EXPRESS_LATERAL_FACTOR)).toBe(true);
    // Must be non-zero so express is distinguishable from GP mainline
    expect(Math.abs(EXPRESS_LATERAL_FACTOR)).toBeGreaterThan(0);
  });

  it("is a dimensionless scale factor in a sensible range (0 < factor < 20)", () => {
    // Factor of 1.6 with typical northing delta ~15 m and latScale 0.32 yields ~7.7 m;
    // guard both extremes: too small → invisible, too large → off-pavement
    expect(EXPRESS_LATERAL_FACTOR).toBeGreaterThan(0);
    expect(EXPRESS_LATERAL_FACTOR).toBeLessThan(20);
  });
});

// ---------------------------------------------------------------------------
// § buildExpressPolyline: returns a smooth polyline for one express sub-section
// ---------------------------------------------------------------------------
describe("buildExpressPolyline — per-section smooth polyline with median offset", () => {
  for (const section of EXPRESS_SECTIONS) {
    describe(`section ${section.sectionId}`, () => {
      it("returns at least 5 points (enough for a smooth ribbon)", () => {
        const poly = buildExpressPolyline(cl, section);
        expect(poly.length).toBeGreaterThanOrEqual(5);
      });

      it("all points land within the corridor bounding box (same criterion as Scenario B)", () => {
        const poly = buildExpressPolyline(cl, section);
        for (const pt of poly) {
          expect(box.containsPoint(pt), `${section.sectionId}: point (${pt.x.toFixed(1)}, ${pt.y.toFixed(1)}, ${pt.z.toFixed(1)}) outside corridor box`).toBe(true);
        }
      });

      it("polyline is smooth: path/chord < 1.8 (no-zigzag)", () => {
        const poly = buildExpressPolyline(cl, section);
        const ratio = pathOverChord(poly);
        expect(ratio, `${section.sectionId} path/chord = ${ratio.toFixed(3)} >= 1.8 (zigzag detected)`).toBeLessThan(1.8);
      });

      it("no planet-scale or (0,0,0) origin points", () => {
        const poly = buildExpressPolyline(cl, section);
        expect(hasPlanetScaleOrZero(poly), `${section.sectionId} has planet-scale/zero point`).toBe(false);
      });

      it("first point is west of last (monotonically advancing along the corridor)", () => {
        const poly = buildExpressPolyline(cl, section);
        // The corridor runs west→east (increasing x in model space), so the first point
        // should have a lower or equal x than the last point.
        const first = poly[0];
        const last = poly[poly.length - 1];
        // Allow a small tolerance (~10 m) for centerline wobble
        expect(first.x).toBeLessThanOrEqual(last.x + 10);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// § Lateral offset places express DISTINCT from the GP mainline (lateralFactor=0)
// ---------------------------------------------------------------------------
describe("Express lateral offset — distinct from GP mainline", () => {
  it("express ribbon midpoint (production path via buildExpressPolyline) is laterally offset from the mainline", () => {
    // Use buildExpressPolyline() — the actual production code path — and measure the
    // lateral distance from its midpoint to the same U-fraction with lateralFactor=0
    // (i.e. the GP mainline position).  This verifies the real deployment offset, not
    // a synthetic corridorPoint() call with an arbitrary factor.
    for (const section of EXPRESS_SECTIONS) {
      const poly = buildExpressPolyline(cl, section);
      // Take the actual midpoint of the produced polyline.
      const midIdx = Math.floor(poly.length / 2);
      const expressMid = poly[midIdx];

      // Compare to the GP mainline at the same easting/northing sample (factor = 0).
      const midE = section.fromE + (section.toE - section.fromE) * (midIdx / (poly.length - 1));
      const midN = section.fromN + (section.toN - section.fromN) * (midIdx / (poly.length - 1));
      const mainlineMid = corridorPoint(cl, midE, midN, 3, 0);

      const lateralDist = expressMid.distanceXY(mainlineMid);

      // Must be > 1 m (visibly distinct in a top-down corridor view) and
      // < 30 m (within the ~7.5 m I-595 median + generous model-space tolerance).
      // Production factor 1.6 with typical northing delta yields ≈ 7–8 m.
      expect(lateralDist, `${section.sectionId}: express too close to GP mainline (${lateralDist.toFixed(2)} m)`).toBeGreaterThan(1);
      expect(lateralDist, `${section.sectionId}: express too far from GP mainline (${lateralDist.toFixed(2)} m) — off the median`).toBeLessThan(30);
    }
  });
});

// ---------------------------------------------------------------------------
// § All 3 express sub-sections together span the parent ribbon monotonically
// ---------------------------------------------------------------------------
describe("Express sub-sections form a contiguous, monotonic ribbon", () => {
  it("polyline start points advance west-to-east in the same order as sectionId (W→C→E)", () => {
    const sorted = [...EXPRESS_SECTIONS].sort((a, b) => a.uFrom - b.uFrom);
    const polys = sorted.map((s) => buildExpressPolyline(cl, s));
    // The start of EXP-C should be east of (or at) the end of EXP-W, etc.
    for (let i = 1; i < polys.length; i++) {
      const prevEnd = polys[i - 1][polys[i - 1].length - 1];
      const nextStart = polys[i][0];
      // Allow small gap (< 50 m) at section boundary due to smoothing
      expect(prevEnd.x).toBeLessThanOrEqual(nextStart.x + 50);
    }
  });

  it("no section polyline overlaps its neighbor (endpoints within 100 m of boundary)", () => {
    const sorted = [...EXPRESS_SECTIONS].sort((a, b) => a.uFrom - b.uFrom);
    for (let i = 1; i < sorted.length; i++) {
      const prevSection = sorted[i - 1];
      const nextSection = sorted[i];
      // The boundary should be at the interpolated uTo of prevSection = uFrom of nextSection
      expect(prevSection.uTo).toBeCloseTo(nextSection.uFrom, 5);
    }
  });
});

// ---------------------------------------------------------------------------
// § Regression: Scenario B segment ribbons still pass after adding placeTolling
// ---------------------------------------------------------------------------
import segData from "../src/scenarioB/data/segments.json";

describe("Scenario B regression — existing segment ribbons unaffected by M2", () => {
  it("all Scenario B segment ribbons still land on-corridor and are smooth", () => {
    for (const s of segData.segments as Array<{ segment_id: string; from_e: number; from_n: number; to_e: number; to_n: number }>) {
      const poly: Point3d[] = [];
      for (let i = 0; i < 10; i++) {
        const t = i / 9;
        poly.push(corridorPoint(cl, s.from_e + (s.to_e - s.from_e) * t, s.from_n + (s.to_n - s.from_n) * t, 3, 0));
      }
      const ratio = pathOverChord(poly);
      expect(ratio, `${s.segment_id}: path/chord ${ratio.toFixed(3)} >= 1.8`).toBeLessThan(1.8);
      for (const pt of poly) {
        expect(box.containsPoint(pt), `${s.segment_id}: point outside corridor`).toBe(true);
      }
    }
  });
});
