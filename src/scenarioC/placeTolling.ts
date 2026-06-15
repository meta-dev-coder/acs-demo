/*---------------------------------------------------------------------------------------------
 * M2 — Central-lane placement helper for Scenario C (Dynamic Tolling).
 *
 * Places the express sub-sections (EXP-W / EXP-C / EXP-E) on the CENTRAL reversible express
 * lanes by calling corridorPoint() with a small clamped lateral median offset so the express
 * ribbon visibly rides the median, distinct from the GP mainline ribbons which render at
 * lateralFactor=0 on the same spine.
 *
 * Key design rules (from the spec / §6 issue 2):
 *  - Express sub-sections are interpolated along SEG-EXP-RVS (u 0.30→0.78) endpoints.
 *  - A small, clamped lateral offset (EXPRESS_MEDIAN_LATERAL) is applied via corridorPoint().
 *  - The final polyline is passed through smoothPolyline() for a clean ribbon.
 *  - No new geometry is loaded; everything goes through the same corridorPoint() path as
 *    Scenario B ribbons so the overlay is guaranteed to stay on the corridor.
 *  - Tolling must NEVER render off the central corridor.
 *--------------------------------------------------------------------------------------------*/
import { Point3d } from "@itwin/core-geometry";
import type { Centerline } from "../scene/place";
import { corridorPoint, smoothPolyline } from "../scene/place";
import type { ExpressSection } from "./types";

/** Number of sample points along each express sub-section polyline. */
const POLYLINE_SAMPLES = 10;

/** Lift above road surface (meters) — matches Scenario B ribbon call convention. */
const LIFT_Z = 3;

// ---------------------------------------------------------------------------
// corridorPoint lateral factor (dimensionless)
//
// corridorPoint(cl, e, n, liftZ, lateralFactor) applies:
//   lateral = (n - CORRIDOR.nRef) * CORRIDOR.latScale * lateralFactor   (clamped to ±95 m)
//
// The SEG-EXP-RVS northing (2883015→2883020) is only 15–20 m north of nRef (2883000),
// so (n - nRef) ≈ 15. With latScale=0.32, the raw offset = 15 × 0.32 ≈ 4.8 m per unit.
//
// We derive the factor empirically: the express northings are ~2883015, nRef = 2883000,
// so (n - nRef) = ~15. latScale = 0.32. Target ≈ 7.7 m on the median → factor = 1.6.
// We round to 1.6 to keep it well within the clamped range (latMax = 95 m).
//
// Resulting placement: ~7.7 m off the mainline spine — sits visibly on the median
// pavement and is distinct from the GP mainline (lateralFactor=0) in a top-down view.
// ---------------------------------------------------------------------------

/**
 * Dimensionless lateral scale factor passed to corridorPoint() for every express sub-section
 * polyline sample.  corridorPoint multiplies this by (n − nRef) × latScale to get a lateral
 * displacement in metres; with typical express northings (~2883015) and latScale=0.32 this
 * produces ≈ 7.7 m of lateral offset, placing the ribbon on the barrier-separated median
 * and making it visually distinct from the GP mainline (which uses lateralFactor=0).
 *
 * NOT a metre value — it is a dimensionless multiplier for the corridorPoint formula.
 */
export const EXPRESS_LATERAL_FACTOR = 1.6;

/**
 * Build a smooth polyline for one express sub-section, placed on the central reversible
 * lanes with a lateral median offset so it is visually distinct from the GP mainline.
 *
 * @param cl   - Corridor centerline (from getCenterline or buildCenterline in tests).
 * @param section - One of the three EXP-W / EXP-C / EXP-E sub-sections.
 * @returns Array of Point3d forming the smooth express ribbon polyline.
 */
export function buildExpressPolyline(cl: Centerline, section: ExpressSection): Point3d[] {
  const raw: Point3d[] = [];
  for (let i = 0; i < POLYLINE_SAMPLES; i++) {
    const t = i / (POLYLINE_SAMPLES - 1);
    const e = section.fromE + (section.toE - section.fromE) * t;
    const n = section.fromN + (section.toN - section.fromN) * t;
    raw.push(corridorPoint(cl, e, n, LIFT_Z, EXPRESS_LATERAL_FACTOR));
  }
  // Two passes of smoothPolyline give a clean ribbon (same as Scenario B decorator)
  return smoothPolyline(raw, 2);
}
