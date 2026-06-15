/*---------------------------------------------------------------------------------------------
 * Corridor placement unit tests. Reproduces the real failure mode (a large fraction of element
 * origins parked at (0,0,0)) and asserts the centerline + marker/segment mapping stay on-corridor.
 *--------------------------------------------------------------------------------------------*/
import { describe, it, expect } from "vitest";
import { Point3d, Range3d } from "@itwin/core-geometry";
import { buildCenterline, corridorPoint, orderAlongChord, snapToRoad } from "../src/scene/place";
import assetsData from "../src/scenarioA/data/assets.json";
import segData from "../src/scenarioB/data/segments.json";

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

describe("centerline is robust to (0,0,0) origin strays", () => {
  it("is binned (>5 pts), NOT the 2-pt planet-scale fallback", () => {
    expect(cl.pts.length).toBeGreaterThan(5);
    expect(cl.total).toBeGreaterThan(2000);
    expect(cl.total).toBeLessThan(3500);
  });

  it("stays within the model bounds (strays clipped)", () => {
    const r = Range3d.createArray(cl.pts);
    expect(r.low.x).toBeGreaterThanOrEqual(pe.low.x - 50);
    expect(r.high.x).toBeLessThanOrEqual(pe.high.x + 50);
    expect(r.low.y).toBeGreaterThanOrEqual(pe.low.y - 50);
    expect(r.high.y).toBeLessThanOrEqual(pe.high.y + 50);
  });
});

describe("markers + ribbons map onto the corridor", () => {
  it("every asset lands on-corridor and advances monotonically with u (no scatter)", () => {
    const placed = (assetsData.assets as Array<{ u: number; coord_e: number; coord_n: number }>).map(
      (a) => ({ u: a.u, w: corridorPoint(cl, a.coord_e, a.coord_n, 8) })
    );
    for (const p of placed) expect(box.containsPoint(p.w)).toBe(true);
    const byU = [...placed].sort((a, b) => a.u - b.u);
    for (let i = 1; i < byU.length; i++) expect(byU[i].w.x).toBeGreaterThanOrEqual(byU[i - 1].w.x - 50);
  });

  it("every segment ribbon is smooth (path/chord < 1.8) and on-corridor (no zigzag)", () => {
    for (const s of segData.segments as Array<{ from_e: number; from_n: number; to_e: number; to_n: number }>) {
      const poly: Point3d[] = [];
      for (let i = 0; i < 10; i++) {
        const t = i / 9;
        poly.push(corridorPoint(cl, s.from_e + (s.to_e - s.from_e) * t, s.from_n + (s.to_n - s.from_n) * t, 3, 0));
      }
      let len = 0;
      for (let i = 1; i < poly.length; i++) len += poly[i - 1].distanceXY(poly[i]);
      const chord = poly[0].distanceXY(poly[poly.length - 1]) || 1;
      expect(len / chord).toBeLessThan(1.8);
      for (const p of poly) expect(box.containsPoint(p)).toBe(true);
    }
  });
});

describe("Scenario B ribbon helpers keep ribbons on the road", () => {
  it("orderAlongChord makes scrambled samples monotonic along the chord and dedupes near-points", () => {
    const a = Point3d.create(0, 0, 0);
    const b = Point3d.create(100, 0, 0);
    const scrambled = [
      Point3d.create(50, 5, 0),
      a,
      Point3d.create(20, -3, 0),
      b,
      Point3d.create(20.5, -3, 0), // near-duplicate of (20,-3) → should collapse
      Point3d.create(80, 2, 0),
    ];
    const ordered = orderAlongChord(scrambled);
    const xs = ordered.map((p) => p.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
    expect(ordered.length).toBeLessThan(scrambled.length);
  });

  it("snapToRoad pulls an off-road point onto the nearest road element, lifted", () => {
    const road = [Point3d.create(0, 0, 5), Point3d.create(10, 0, 5), Point3d.create(20, 0, 5)];
    const snapped = snapToRoad(Point3d.create(11, 40, 0), 3, road); // 40 m off to the side
    expect(snapped.x).toBe(10);
    expect(snapped.y).toBe(0);
    expect(snapped.z).toBe(8); // road z 5 + liftZ 3
  });
});
