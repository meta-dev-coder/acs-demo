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
import { placePoints, type GeoPoint } from "../scene/place";
import type { RawSegment, SegIncident } from "./types";

let decorator: SegmentRiskDecorator | undefined;
const SAMPLES = 6;

export function scoreSegmentsIntoStore(): void {
  const segs = (segmentsData.segments as unknown) as RawSegment[];
  const incs = (incidentsData.incidents as unknown) as SegIncident[];
  const scored = scoreSegments(segs, incs);
  store.setSegments(scored);
  const reds = scored.filter((s) => s.band === "red").length;
  console.log(`[Scenario B] ${scored.length} segments scored — ${reds} high-risk.`);
}

export async function placeAndDecorateB(
  vp: ScreenViewport,
  segmentZ: number
): Promise<void> {
  const scored = store.getSnapshot().segments;

  const flat: GeoPoint[] = [];
  for (const s of scored) {
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / (SAMPLES - 1);
      flat.push({
        e: s.from_e + (s.to_e - s.from_e) * t,
        n: s.from_n + (s.to_n - s.from_n) * t,
        u: s.u_from + (s.u_to - s.u_from) * t,
        v: 0,
      });
    }
  }

  const { pts } = await placePoints(vp.iModel, flat, segmentZ);
  const graphics: SegmentGraphic[] = scored.map((s, si) => ({
    segment: s,
    polyline: pts.slice(si * SAMPLES, si * SAMPLES + SAMPLES),
  }));

  const mids = new Map<string, (typeof pts)[number]>();
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
