/*---------------------------------------------------------------------------------------------
 * M2 — Lane Closure placement helper for Scenario D.
 *
 * Mirrors src/scenarioC/placeTolling.ts in structure.
 *
 * Provides:
 *  - buildClosureRibbon()   — the closed segment ribbon (hazard-amber), lateralFactor=0
 *  - buildQueueRibbon()     — upstream congestion ribbon from queue tail to closure head
 *  - buildSR84EbRibbon()    — EB SR-84 diversion ribbon (south of mainline)
 *  - queueTailEasting       — re-exported from closurePhysics (not reimplemented)
 *  - SCHEMATIC_LABEL        — required SCHEMATIC label constant (§4)
 *
 * Key constraints (§4 hard constraints):
 *  - Zero imports from @itwin/core-frontend or React (safe to test in Node)
 *  - All ribbon geometry uses corridorPoint() from src/scene/place (no SUMO/Cesium)
 *  - All ribbons labeled SCHEMATIC via SCHEMATIC_LABEL constant
 *  - lateralFactor=0 for all mainline ribbons (spine alignment)
 *  - queueTailEasting is re-exported from closurePhysics, not reimplemented
 *--------------------------------------------------------------------------------------------*/
import { Point3d } from "@itwin/core-geometry";
import type { Centerline } from "../scene/place";
import { corridorPoint, smoothPolyline } from "../scene/place";

// Re-export queueTailEasting from closurePhysics — NOT reimplemented here.
// Also import it directly so buildQueueRibbon can call it without duplicating logic.
export { queueTailEasting } from "./closurePhysics";
import { queueTailEasting } from "./closurePhysics";

// ---------------------------------------------------------------------------
// Exported SCHEMATIC_LABEL constant (§4: every ribbon/marker includes SCHEMATIC)
// Re-exported from placeClosure so geometry consumers don't need to import from physics.
// ---------------------------------------------------------------------------
export const SCHEMATIC_LABEL = "SCHEMATIC corridor context — NOT calibrated mainline geometry";

// ---------------------------------------------------------------------------
// Internal constants (§placeClosure conventions from plan §M2)
// ---------------------------------------------------------------------------

/** Number of sample points along each closure ribbon polyline. */
const POLYLINE_SAMPLES = 12;

/** Lift above road surface (meters) — same as Scenario C ribbon convention. */
const LIFT_Z = 6;

// SR-84 EB diversion ribbon endpoints (locked decisions §9):
//   WB SEG-SR84 in segments.json: from_e=582000, to_e=586500, from_n=2882700
//   EB representation: swap from/to easting, northing offset −30 (from_n − 30 = 2882670)
//   to draw a parallel EB ribbon south of the mainline.
const SR84_EB_FROM_E = 586500; // west end of EB ribbon (higher easting = start for west→east draw)
const SR84_EB_TO_E = 582000;   // east end of EB ribbon (lower easting = end for west→east draw)
const SR84_EB_FROM_N = 2882670; // from_n − 30 (locked decision §9, plan line 783)
// Note: from_e > to_e here because we sample t=0..1 and want west→east in the output.
// We'll sample from lower to higher easting by using min/max in buildSR84EbRibbon.

/** Lateral factor for SR-84 EB ribbon — places it south of the mainline (locked decision §9). */
const SR84_EB_LATERAL_FACTOR = 0.8;

// ---------------------------------------------------------------------------
// Segment coordinate type for closure/queue ribbons
// ---------------------------------------------------------------------------

export type ClosureSegCoords = {
  fromE: number;
  toE: number;
  fromN: number;
  toN?: number; // optional for queue ribbon (uses fromN for both ends)
};

// ---------------------------------------------------------------------------
// § buildClosureRibbon — the closed-lane segment ribbon
// ---------------------------------------------------------------------------

/**
 * Build a smooth polyline for the closed-lane segment, placed on the mainline spine
 * (lateralFactor=0). Used to render the hazard-amber ribbon over the closure segment.
 *
 * Plan conventions (M2):
 *  - POLYLINE_SAMPLES = 12, LIFT_Z = 6, t = 0.05 + 0.9 * i / (N-1) (5% trim)
 *  - lateralFactor=0 (mainline spine)
 *  - smoothPolyline(pts, 1)
 *
 * @param cl   Corridor centerline.
 * @param seg  Segment endpoint coordinates in UTM (easting/northing).
 * @returns    Array of Point3d forming the closure ribbon polyline.
 */
export function buildClosureRibbon(cl: Centerline, seg: ClosureSegCoords): Point3d[] {
  const N = POLYLINE_SAMPLES;
  const toN = seg.toN ?? seg.fromN;
  const raw: Point3d[] = [];

  for (let i = 0; i < N; i++) {
    const t = 0.05 + 0.9 * i / (N - 1);
    const e = seg.fromE + (seg.toE - seg.fromE) * t;
    const n = seg.fromN + (toN - seg.fromN) * t;
    raw.push(corridorPoint(cl, e, n, LIFT_Z, 0));
  }

  return smoothPolyline(raw, 1);
}

// ---------------------------------------------------------------------------
// § buildQueueRibbon — upstream congestion ribbon
// ---------------------------------------------------------------------------

/**
 * Build a smooth polyline from the queue tail (upstream) to the closure head (fromE),
 * representing the upstream congestion ribbon.
 *
 * Uses queueTailEasting to locate the tail, then samples from tail→closure head
 * at lateralFactor=0 (mainline spine).
 *
 * Returns empty array when queueLengthMeters=0 (no queue yet — no crash).
 *
 * @param cl                  Corridor centerline.
 * @param seg                 Closure segment coordinates (fromE used as closure head easting).
 * @param queueLengthMeters   Queue length in meters upstream of closure head.
 * @returns                   Array of Point3d forming the queue ribbon (west→east).
 */
export function buildQueueRibbon(
  cl: Centerline,
  seg: { fromE: number; toE: number; fromN: number },
  queueLengthMeters: number
): Point3d[] {
  if (queueLengthMeters <= 0) {
    return [];
  }

  // Plan §M2 line 782: "from queueTailEasting to seg.fromE" — call the shared helper
  // so future constant changes in closurePhysics (CORRIDOR_EASTING_MIN etc.) propagate here.
  const tailE = queueTailEasting(seg.fromE, queueLengthMeters);
  const headE = seg.fromE;
  const fromN = seg.fromN;

  // Edge case: tail at corridor limit — still build a ribbon if there's any span
  if (Math.abs(headE - tailE) < 1) {
    return [];
  }

  const N = POLYLINE_SAMPLES;
  const raw: Point3d[] = [];

  // Sample west→east: from tailE (queue tail, upstream/west) to headE (closure head, east)
  for (let i = 0; i < N; i++) {
    const t = 0.05 + 0.9 * i / (N - 1);
    const e = tailE + (headE - tailE) * t;
    raw.push(corridorPoint(cl, e, fromN, LIFT_Z, 0));
  }

  return smoothPolyline(raw, 1);
}

// ---------------------------------------------------------------------------
// § buildSR84EbRibbon — EB SR-84 diversion ribbon
// ---------------------------------------------------------------------------

/**
 * Build a smooth polyline for the EB SR-84 diversion representation.
 *
 * Uses swapped endpoints + northing offset (locked decision §9):
 *  - WB SEG-SR84: from_e=582000, to_e=586500, from_n=2882700
 *  - EB ribbon: sample from lower easting (582000) to higher easting (586500)
 *               using from_n=2882670 (= WB from_n − 30)
 *  - lateralFactor=0.8 to place south of the mainline spine
 *
 * The output goes west→east (ribbon[0].x ≤ ribbon[-1].x), representing EB traffic.
 * Labeled "SR-84 EB diversion — Illustrative" per plan §1.
 *
 * @param cl  Corridor centerline.
 * @returns   Array of Point3d forming the EB SR-84 ribbon (west→east).
 */
export function buildSR84EbRibbon(cl: Centerline): Point3d[] {
  // Sample west→east: from lower easting to higher easting
  const fromE = Math.min(SR84_EB_FROM_E, SR84_EB_TO_E); // 582000
  const toE = Math.max(SR84_EB_FROM_E, SR84_EB_TO_E);   // 586500
  const fromN = SR84_EB_FROM_N; // 2882670

  const N = POLYLINE_SAMPLES;
  const raw: Point3d[] = [];

  for (let i = 0; i < N; i++) {
    const t = 0.05 + 0.9 * i / (N - 1);
    const e = fromE + (toE - fromE) * t;
    raw.push(corridorPoint(cl, e, fromN, LIFT_Z, SR84_EB_LATERAL_FACTOR));
  }

  return smoothPolyline(raw, 1);
}
