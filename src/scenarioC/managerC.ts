/*---------------------------------------------------------------------------------------------
 * Scenario C — Dynamic Tolling orchestration manager.
 *
 * Places the express sub-sections (EXP-W/C/E) on the central reversible lanes and registers
 * the TollingDecorator. Wires the storeC subscription so the decorator recolors whenever
 * strategy, time-block, or overrides change.
 *
 * Reuses: buildExpressPolyline (placeTolling.ts), TollingDecorator (decorator.ts),
 *         getCenterline / corridorPoint / smoothPolyline (scene/place.ts), storeC (storeC.ts).
 *--------------------------------------------------------------------------------------------*/
import {
  IModelApp,
  type ScreenViewport,
} from "@itwin/core-frontend";
import { Point3d } from "@itwin/core-geometry";
import { getCenterline, corridorPoint, smoothPolyline } from "../scene/place";
import { EXPRESS_SECTIONS } from "./pricing";
import { buildExpressPolyline } from "./placeTolling";
import { TollingDecorator, type SectionGraphic, type MainlineGraphic } from "./decorator";
import { storeC } from "./storeC";
import { store } from "../scenarioA/store";
import segmentsData from "../scenarioB/data/segments.json";
import type { RawSegment } from "../scenarioB/types";

let decorator: TollingDecorator | undefined;
let unsubscribeC: (() => void) | undefined;

/** Segment ids that serve as connected mainlines for the EXP sections. */
const MAINLINE_SEGMENT_IDS = new Set(["SEG-MN-W", "SEG-MN-C", "SEG-MN-E"]);

const MAINLINE_SAMPLES = 10;

export async function placeAndDecorateC(vp: ScreenViewport): Promise<void> {
  const iModel = vp.iModel;
  const cl = await getCenterline(iModel);

  // 1. Build express sub-section polylines (on the central lanes with lateral median offset).
  const sectionGraphics: SectionGraphic[] = EXPRESS_SECTIONS.map((sec) => ({
    sectionId: sec.sectionId,
    sectionName: sec.name,
    polyline: buildExpressPolyline(cl, sec),
    pricing: storeC.getSnapshot().pricedSections.find((p) => p.sectionId === sec.sectionId)!,
  }));

  // 2. Build mainline polylines for the GP segments connected to express sections.
  const rawSegs = segmentsData.segments as unknown as RawSegment[];
  const mainlineGraphics: MainlineGraphic[] = rawSegs
    .filter((s) => MAINLINE_SEGMENT_IDS.has(s.segment_id))
    .map((s) => {
      const polyline: Point3d[] = [];
      for (let i = 0; i < MAINLINE_SAMPLES; i++) {
        const t = 0.05 + (0.9 * i) / (MAINLINE_SAMPLES - 1);
        const e = s.from_e + (s.to_e - s.from_e) * t;
        const n = s.from_n + (s.to_n - s.from_n) * t;
        polyline.push(corridorPoint(cl, e, n, 3, 0));
      }
      const safetyFlag = storeC
        .getSnapshot()
        .pricedSections.some(
          (p) => p.connectedMainlineUtilization > 0.95 && p.sectionId && expressConnectedTo(p.sectionId, s.segment_id)
        );
      return {
        segmentId: s.segment_id,
        polyline: smoothPolyline(polyline, 1),
        safetyFlag,
      };
    });

  // 3. Register / update decorator.
  if (!decorator) {
    decorator = new TollingDecorator(iModel);
    IModelApp.viewManager.addDecorator(decorator);
  }
  decorator.setSections(sectionGraphics);
  decorator.setMainlines(mainlineGraphics);

  // 4. Subscribe to storeC to recolor whenever pricing state changes.
  unsubscribeC?.();
  unsubscribeC = storeC.subscribe(() => {
    if (store.getSnapshot().scenario !== "C") return;
    const snap = storeC.getSnapshot();

    // Refresh section graphics with updated pricing.
    const updated: SectionGraphic[] = sectionGraphics.map((sg) => ({
      ...sg,
      pricing: snap.pricedSections.find((p) => p.sectionId === sg.sectionId) ?? sg.pricing,
    }));
    decorator!.setSections(updated);

    // Refresh mainline safety flags.
    const updatedMainlines = mainlineGraphics.map((ml) => ({
      ...ml,
      safetyFlag: snap.pricedSections.some(
        (p) => p.safetyFlag && expressConnectedTo(p.sectionId, ml.segmentId)
      ),
    }));
    decorator!.setMainlines(updatedMainlines);
  });
}

/** True when a given express section sheds demand onto the given mainline segment id. */
function expressConnectedTo(sectionId: string, mainlineId: string): boolean {
  const sec = EXPRESS_SECTIONS.find((s) => s.sectionId === sectionId);
  return sec?.connectedMainlineSegmentId === mainlineId;
}

export function getCDecorator(): TollingDecorator | undefined {
  return decorator;
}

export function teardownC(): void {
  unsubscribeC?.();
  unsubscribeC = undefined;
  if (decorator) {
    IModelApp.viewManager.dropDecorator(decorator);
    decorator = undefined;
  }
}
