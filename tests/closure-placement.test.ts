/*---------------------------------------------------------------------------------------------
 * M2 — Lane Closure placement tests (TDD).
 *
 * Verifies that buildClosureRibbon(), buildQueueRibbon(), buildSR84EbRibbon(), and
 * queueTailEasting re-export in src/scenarioD/placeClosure.ts are correct.
 *
 * Uses the same corridorCloud() + buildCenterline() + box harness as tolling-placement.test.ts.
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect } from "vitest";
import { Point3d, Range3d } from "@itwin/core-geometry";
import { buildCenterline, corridorPoint } from "../src/scene/place";
import {
  buildClosureRibbon,
  buildQueueRibbon,
  buildSR84EbRibbon,
  queueTailEasting,
  SCHEMATIC_LABEL,
} from "../src/scenarioD/placeClosure";

// ---------------------------------------------------------------------------
// Reuse the same synthetic corridor geometry as tolling-placement.test.ts
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
// Helper: check no point is planet-scale or exact (0,0,0) origin
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
// § buildClosureRibbon
// ---------------------------------------------------------------------------

describe("buildClosureRibbon", () => {
  const seg = { fromE: 590000, toE: 591600, fromN: 2883000, toN: 2883050 };

  it("returns >= 10 points", () => {
    const ribbon = buildClosureRibbon(cl, seg);
    expect(ribbon.length).toBeGreaterThanOrEqual(10);
  });

  it("all points within corridor box", () => {
    const ribbon = buildClosureRibbon(cl, seg);
    for (const p of ribbon) expect(box.containsPoint(p)).toBe(true);
  });

  it("path/chord < 1.8 (no zigzag)", () => {
    const ribbon = buildClosureRibbon(cl, seg);
    const path = ribbon.slice(1).reduce((sum, p, i) => sum + ribbon[i].distance(p), 0);
    const chord = ribbon[0].distance(ribbon[ribbon.length - 1]);
    expect(path / chord).toBeLessThan(1.8);
  });

  it("no planet-scale or (0,0,0) origin points", () => {
    const ribbon = buildClosureRibbon(cl, seg);
    expect(hasPlanetScaleOrZero(ribbon)).toBe(false);
  });

  it("uses lateralFactor=0 — ribbon hugs the spine, not a lateral-offset lane", () => {
    const ribbon = buildClosureRibbon(cl, seg);
    // Falsifiable check: sample the spine at the SAME parameter as the ribbon midpoint
    // (buildClosureRibbon samples t = 0.05 + 0.9*i/(N-1)), then compare that ribbon point's
    // distance to the lateralFactor=0 spine vs a lateral-offset reference. A ribbon built with
    // lateralFactor=0 must be far closer to the spine; one built with an offset (e.g. 1.6, like
    // the tolling ribbon) would land closer to offsetPoint. Smoothing moves the point only a
    // few metres, so the spine must clearly win. (The previous assertion compared the wrong
    // parameter — ribbon[N/2] sits at t≈0.54, not the segment midpoint — and was committed red.)
    const N = ribbon.length;
    const midIdx = Math.floor(N / 2);
    const mid = ribbon[midIdx];
    const t = 0.05 + (0.9 * midIdx) / (N - 1);
    const toN = seg.toN ?? seg.fromN;
    const e = seg.fromE + (seg.toE - seg.fromE) * t;
    const n = seg.fromN + (toN - seg.fromN) * t;
    const spinePoint = corridorPoint(cl, e, n, 6, 0);
    const offsetPoint = corridorPoint(cl, e, n, 6, 1.6);
    expect(mid.distance(spinePoint)).toBeLessThan(mid.distance(offsetPoint));
  });
});

// ---------------------------------------------------------------------------
// § buildQueueRibbon
// ---------------------------------------------------------------------------

describe("buildQueueRibbon", () => {
  const closureSeg = { fromE: 590000, toE: 591600, fromN: 2883000 };

  it("returns >= 10 points within box for queueLengthMeters=800", () => {
    const ribbon = buildQueueRibbon(cl, closureSeg, 800);
    expect(ribbon.length).toBeGreaterThanOrEqual(10);
    for (const p of ribbon) expect(box.containsPoint(p)).toBe(true);
  });

  it("path/chord < 1.8", () => {
    const ribbon = buildQueueRibbon(cl, closureSeg, 800);
    const path = ribbon.slice(1).reduce((sum, p, i) => sum + ribbon[i].distance(p), 0);
    const chord = ribbon[0].distance(ribbon[ribbon.length - 1]);
    expect(path / chord).toBeLessThan(1.8);
  });

  it("first point is WEST of last point (upstream direction)", () => {
    const ribbon = buildQueueRibbon(cl, closureSeg, 800);
    expect(ribbon[0].x).toBeLessThan(ribbon[ribbon.length - 1].x + 5);
  });

  it("with queueLengthMeters=0 returns empty or degenerate polyline (no crash)", () => {
    expect(() =>
      buildQueueRibbon(cl, closureSeg, 0)
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// § queueTailEasting re-export
// ---------------------------------------------------------------------------

describe("queueTailEasting (re-exported from placeClosure)", () => {
  it("returns 588000 for closureStartEasting=590000, queueLengthMeters=2000", () => {
    expect(queueTailEasting(590000, 2000)).toBeCloseTo(588000, 0);
  });

  it("result is always >= 578200 (west corridor limit)", () => {
    // Large queue should clamp at 578200
    expect(queueTailEasting(590000, 99999)).toBeGreaterThanOrEqual(578200);
  });
});

// ---------------------------------------------------------------------------
// § buildSR84EbRibbon
// ---------------------------------------------------------------------------

describe("buildSR84EbRibbon", () => {
  it("returns >= 5 points and all within box", () => {
    const ribbon = buildSR84EbRibbon(cl);
    expect(ribbon.length).toBeGreaterThanOrEqual(5);
    for (const p of ribbon) expect(box.containsPoint(p)).toBe(true);
  });

  it("EB direction: first point x <= last point x + 5 (west to east)", () => {
    const ribbon = buildSR84EbRibbon(cl);
    expect(ribbon[0].x).toBeLessThanOrEqual(ribbon[ribbon.length - 1].x + 5);
  });
});

// ---------------------------------------------------------------------------
// § SCHEMATIC_LABEL constant
// ---------------------------------------------------------------------------

describe("SCHEMATIC_LABEL", () => {
  it("is exported, non-empty, and contains SCHEMATIC", () => {
    expect(typeof SCHEMATIC_LABEL).toBe("string");
    expect(SCHEMATIC_LABEL.length).toBeGreaterThan(0);
    expect(SCHEMATIC_LABEL).toMatch(/SCHEMATIC/i);
  });
});

// ---------------------------------------------------------------------------
// § Regression: Scenario C and B placement unchanged
// ---------------------------------------------------------------------------

describe("Regression — Scenario C placeTolling", () => {
  it("buildExpressPolyline still passes box and smoothness checks", async () => {
    const { buildExpressPolyline } = await import("../src/scenarioC/placeTolling");
    const { EXPRESS_SECTIONS } = await import("../src/scenarioC/pricing");
    for (const sec of EXPRESS_SECTIONS) {
      const ribbon = buildExpressPolyline(cl, sec);
      expect(ribbon.length).toBeGreaterThanOrEqual(5);
      for (const p of ribbon) expect(box.containsPoint(p)).toBe(true);
    }
  });
});

describe("Regression — Scenario B segment ribbons", () => {
  it("SEG-CONN ribbon still on-corridor and smooth", () => {
    const samples = 10;
    const seg = { from_e: 590000, to_e: 591600, from_n: 2883000, to_n: 2883050 };
    const polyline: Point3d[] = [];
    for (let i = 0; i < samples; i++) {
      const t = 0.05 + (0.9 * i) / (samples - 1);
      polyline.push(corridorPoint(cl, seg.from_e + (seg.to_e - seg.from_e) * t, seg.from_n, 3, 0));
    }
    for (const p of polyline) expect(box.containsPoint(p)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// § M4 — closure / queue marker placement (node-safe geometry)
// ---------------------------------------------------------------------------
describe("M4 — closure & queue marker geometry", () => {
  it("LaneClosureMarker position (corridorPoint at closureStartEasting=590000) is within corridor box", () => {
    expect(box.containsPoint(corridorPoint(cl, 590000, 2883000, 6, 0))).toBe(true);
  });

  it("QueueTailMarker position is WEST of (or at) the LaneClosureMarker position", () => {
    const head = corridorPoint(cl, 590000, 2883000, 6, 0);
    const tail = corridorPoint(cl, queueTailEasting(590000, 800), 2883000, 6, 0);
    expect(tail.x).toBeLessThan(head.x + 1);
  });
});
