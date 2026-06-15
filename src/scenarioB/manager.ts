/*---------------------------------------------------------------------------------------------
 * Scenario B orchestration: score segments into the store, build segment polylines at real
 * coordinates (GCS, extents fallback), and register the pickable segment decorator.
 *--------------------------------------------------------------------------------------------*/
import {
  IModelApp,
  type ScreenViewport,
} from "@itwin/core-frontend";
import segmentsData from "./data/segments.json";
import incidentsData from "./data/segmentIncidents.json";
import { scoreSegments } from "./safetyScoring";
import { SegmentRiskDecorator, type SegmentGraphic } from "./decorator";
import { store } from "../scenarioA/store";
import { getCenterline, corridorPoint, smoothPolyline } from "../scene/place";
import { Point3d } from "@itwin/core-geometry";
import type { RawSegment, SegIncident } from "./types";

let decorator: SegmentRiskDecorator | undefined;
const SAMPLES = 14;

export function scoreSegmentsIntoStore(): void {
  const segs = (segmentsData.segments as unknown) as RawSegment[];
  const incs = (incidentsData.incidents as unknown) as SegIncident[];
  const scored = scoreSegments(segs, incs);
  store.setSegments(scored);
  const reds = scored.filter((s) => s.band === "red").length;
  console.log(`[Scenario B] ${scored.length} segments scored — ${reds} high-risk.`);
}

export async function placeAndDecorateB(vp: ScreenViewport): Promise<void> {
  const scored = store.getSnapshot().segments;
  const cl = await getCenterline(vp.iModel);

  const graphics: SegmentGraphic[] = scored.map((s) => {
    // Sample along the segment (ends trimmed to avoid overshoot past the pavement), snap each onto
    // the real road surface, order along the chord, then smooth — so the ribbon runs ON the
    // pavement and reads cleanly (no median strip, no zigzag, no overshoot into grass/water).
    // Ribbons ride the carriageway-tracking centerline (lateralFactor 0). Ends trimmed to avoid
    // overshoot past the pavement; lightly smoothed. The centerline now follows a single carriageway,
    // so this stays ON the pavement without the per-vertex snapping that caused zigzag.
    const polyline: Point3d[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const t = 0.05 + (0.9 * i) / (SAMPLES - 1);
      const e = s.from_e + (s.to_e - s.from_e) * t;
      const n = s.from_n + (s.to_n - s.from_n) * t;
      polyline.push(corridorPoint(cl, e, n, 3, 0));
    }
    return { segment: s, polyline: smoothPolyline(polyline, 1) };
  });

  const mids = new Map<string, Point3d>();
  graphics.forEach((g) => {
    const mid = g.polyline[Math.floor(g.polyline.length / 2)] ?? g.polyline[0];
    if (mid) mids.set(g.segment.segment_id, mid);
  });
  store.setSegmentMids(mids);

  if (!decorator) {
    decorator = new SegmentRiskDecorator(vp.iModel);
    IModelApp.viewManager.addDecorator(decorator);
  }
  decorator.setSegments(graphics);
}

export function getBDecorator(): SegmentRiskDecorator | undefined {
  return decorator;
}
