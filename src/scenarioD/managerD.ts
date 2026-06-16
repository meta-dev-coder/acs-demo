/*---------------------------------------------------------------------------------------------
 * Scenario D — Lane Closure orchestration manager.
 *
 * Places the closure/queue/SR-84 ribbons on the connector spine (schematic) and registers the
 * LaneClosureDecorator. Subscribes to storeD so the decorator recolors/repositions whenever the
 * closure event or Concept A before/after toggle changes. Concept B's rAF play loop (M6) will
 * reuse this same manager + the cached tickHistory.
 *
 * Reuses: buildClosureRibbon/buildQueueRibbon/buildSR84EbRibbon + queueTailEasting (placeClosure),
 *         getCenterline / corridorPoint (scene/place), storeD (storeD), store (scenarioA/store).
 *--------------------------------------------------------------------------------------------*/
import { IModelApp, type ScreenViewport } from "@itwin/core-frontend";
import { getCenterline, corridorPoint, type Centerline } from "../scene/place";
import {
  buildClosureRibbon,
  buildQueueRibbon,
  buildSR84EbRibbon,
  queueTailEasting,
} from "./placeClosure";
import { LaneClosureDecorator, type ClosureGraphics } from "./decorator";
import { storeD, type StateD } from "./storeD";
import { store } from "../scenarioA/store";
import config from "./closureConfig.json";
import segmentsData from "../scenarioB/data/segments.json";
import type { RawSegment } from "../scenarioB/types";

let decorator: LaneClosureDecorator | undefined;
let unsubscribeD: (() => void) | undefined;
let rafHandle: number | undefined; // reserved for the Concept B (M6) play loop

const METERS_PER_MILE = config.metersPerMile as number;
const SEG_CONN_FROM_E = config.segConnFromEasting as number;
const FALLBACK_SPAN_M = 1600; // schematic connector span when the segment isn't in segments.json
const FALLBACK_N = 2883000; // ignored by corridorPoint at lateralFactor=0; kept for completeness

const rawSegs = segmentsData.segments as unknown as RawSegment[];

const EMPTY_GRAPHICS: ClosureGraphics = {
  closure: [],
  queue: [],
  sr84: [],
  sr84Active: false,
  closureHead: null,
  queueTail: null,
  segmentId: null,
  queueLengthMi: 0,
};

/** Build the decorator graphics from the current storeD snapshot (empty in the 'before' view). */
function buildClosureGraphics(snap: StateD, cl: Centerline): ClosureGraphics {
  const event = snap.activeEvent;
  if (!event || snap.displayMode === "before") return EMPTY_GRAPHICS;

  const rawSeg = rawSegs.find((s) => s.segment_id === event.segment_id);
  const segCoords = rawSeg
    ? { fromE: rawSeg.from_e, toE: rawSeg.to_e, fromN: rawSeg.from_n, toN: rawSeg.to_n }
    : { fromE: SEG_CONN_FROM_E, toE: SEG_CONN_FROM_E + FALLBACK_SPAN_M, fromN: FALLBACK_N, toN: FALLBACK_N };

  const queueLengthMi = snap.kpi.maxQueueMi;
  const queueLengthMeters = queueLengthMi * METERS_PER_MILE;
  const pctDiverted = snap.conceptASnapshot?.diversionActive ? 1 : snap.kpi.pctDiverted;
  const sr84Active = (snap.conceptASnapshot?.diversionActive ?? false) || snap.kpi.pctDiverted > 0;
  void pctDiverted;

  const closure = buildClosureRibbon(cl, segCoords);
  const queue = buildQueueRibbon(
    cl,
    { fromE: segCoords.fromE, toE: segCoords.toE, fromN: segCoords.fromN },
    queueLengthMeters
  );
  const sr84 = buildSR84EbRibbon(cl);

  const closureHead = corridorPoint(cl, segCoords.fromE, segCoords.fromN, 6, 0);
  const queueTail =
    queueLengthMeters > 0
      ? corridorPoint(cl, queueTailEasting(segCoords.fromE, queueLengthMeters), segCoords.fromN, 6, 0)
      : null;

  return {
    closure,
    queue,
    sr84,
    sr84Active,
    closureHead,
    queueTail,
    segmentId: event.segment_id,
    queueLengthMi,
  };
}

export async function placeAndDecorateD(vp: ScreenViewport): Promise<void> {
  const iModel = vp.iModel;
  const cl = await getCenterline(iModel);

  if (!decorator) {
    decorator = new LaneClosureDecorator();
    IModelApp.viewManager.addDecorator(decorator);
  }
  decorator.setClosureGraphics(buildClosureGraphics(storeD.getSnapshot(), cl));

  // Recolor/reposition whenever the closure event or before/after toggle changes.
  unsubscribeD?.();
  unsubscribeD = storeD.subscribe(() => {
    if (store.getSnapshot().scenario !== "D") return;
    decorator!.setClosureGraphics(buildClosureGraphics(storeD.getSnapshot(), cl));
  });
}

export function getDDecorator(): LaneClosureDecorator | undefined {
  return decorator;
}

export function teardownD(): void {
  unsubscribeD?.();
  unsubscribeD = undefined;
  if (rafHandle !== undefined) {
    cancelAnimationFrame(rafHandle);
    rafHandle = undefined;
  }
  if (decorator) {
    IModelApp.viewManager.dropDecorator(decorator);
    decorator = undefined;
  }
}
