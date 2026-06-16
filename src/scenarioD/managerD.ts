/*---------------------------------------------------------------------------------------------
 * Scenario D — Lane Closure orchestration manager.
 *
 * Places the closure/queue/SR-84 ribbons on the connector spine (schematic) and registers the
 * LaneClosureDecorator. Subscribes to storeD so the decorator recolors/repositions on Concept A
 * toggles + scrubs. For Concept B playback (M6) it runs the rAF play loop: advanceTick() each
 * frame, redraw the decorator every tick via the decoratorNeedsUpdate flag, and notify React on
 * the store's coarse cadence only. This is the ONLY file with requestAnimationFrame /
 * invalidateCachedDecorations — storeD.ts has none.
 *
 * Reuses: buildClosureRibbon/buildQueueRibbon/buildSR84EbRibbon + queueTailEasting (placeClosure),
 *         getCenterline / corridorPoint (scene/place), storeD (storeD), store (scenarioA/store).
 *--------------------------------------------------------------------------------------------*/
import { IModelApp, type ScreenViewport } from "@itwin/core-frontend";
import { Point3d } from "@itwin/core-geometry";
import { getCenterline, corridorPoint, smoothPolyline, type Centerline } from "../scene/place";
import {
  buildClosureRibbon,
  buildQueueRibbon,
  buildSR84EbRibbon,
  queueTailEasting,
} from "./placeClosure";
import { selectableClosureSegments } from "./closurePhysics";
import { LaneClosureDecorator, type ClosureGraphics } from "./decorator";
import { storeD, type StateD } from "./storeD";
import { store } from "../scenarioA/store";
import config from "./closureConfig.json";
import segmentsData from "../scenarioB/data/segments.json";
import type { ClosureEvent, ClosureSimState } from "./typesD";
import type { RawSegment } from "../scenarioB/types";

let decorator: LaneClosureDecorator | undefined;
let unsubscribeD: (() => void) | undefined;
let rafHandle: number | undefined;
let centerline: Centerline | undefined;
let candidateRibbons: { segmentId: string; polyline: Point3d[] }[] = [];

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
  candidates: [],
};

/** Build faint, clickable candidate ribbons for every closure-selectable corridor segment (G1). */
function buildCandidates(cl: Centerline): { segmentId: string; polyline: Point3d[] }[] {
  const ids = new Set(selectableClosureSegments());
  return rawSegs
    .filter((s) => ids.has(s.segment_id))
    .map((s) => {
      const poly: Point3d[] = [];
      for (let i = 0; i < 10; i++) {
        const t = 0.05 + (0.9 * i) / 9;
        poly.push(corridorPoint(cl, s.from_e + (s.to_e - s.from_e) * t, s.from_n + (s.to_n - s.from_n) * t, 4, 0));
      }
      return { segmentId: s.segment_id, polyline: smoothPolyline(poly, 1) };
    });
}

/** Pick the sim tick to display: the scrubbed/playing tick in Concept B, else the Concept A view. */
function pickDisplayTick(snap: StateD): ClosureSimState | null {
  if (snap.playbackState !== "idle") return snap.tickHistory[snap.tickIndex] ?? null;
  if (snap.displayMode === "after") return snap.conceptASnapshot;
  return null; // Concept A "before" → open road (no overlays)
}

/** Build the decorator graphics for one sim tick (empty in the 'before'/no-event case). */
function buildGraphicsFromTick(
  tickState: ClosureSimState | null,
  event: ClosureEvent | null,
  cl: Centerline
): ClosureGraphics {
  if (!tickState || !event) return { ...EMPTY_GRAPHICS, candidates: candidateRibbons };

  const rawSeg = rawSegs.find((s) => s.segment_id === event.segment_id);
  const segCoords = rawSeg
    ? { fromE: rawSeg.from_e, toE: rawSeg.to_e, fromN: rawSeg.from_n, toN: rawSeg.to_n }
    : { fromE: SEG_CONN_FROM_E, toE: SEG_CONN_FROM_E + FALLBACK_SPAN_M, fromN: FALLBACK_N, toN: FALLBACK_N };

  const queueLengthMi = tickState.backOfQueue?.lengthMi ?? 0;
  const queueLengthMeters = queueLengthMi * METERS_PER_MILE;
  const sr84Active = tickState.diversionActive;

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
    candidates: candidateRibbons,
  };
}

function refreshDecorator(): void {
  if (!decorator || !centerline) return;
  const snap = storeD.getSnapshot();
  decorator.setClosureGraphics(buildGraphicsFromTick(pickDisplayTick(snap), snap.activeEvent, centerline));
}

export async function placeAndDecorateD(vp: ScreenViewport): Promise<void> {
  centerline = await getCenterline(vp.iModel);
  candidateRibbons = buildCandidates(centerline);

  if (!decorator) {
    decorator = new LaneClosureDecorator();
    IModelApp.viewManager.addDecorator(decorator);
  }
  refreshDecorator();

  // Concept A toggles + scrubs update the decorator here; the rAF loop owns updates during play.
  unsubscribeD?.();
  unsubscribeD = storeD.subscribe(() => {
    if (store.getSnapshot().scenario !== "D") return;
    if (storeD.getSnapshot().playbackState === "playing") return; // rAF owns play updates
    refreshDecorator();
  });
}

// ---- Concept B rAF play loop (the ONLY rAF / invalidate site) ----

// Wall-clock pacing: advance ONE sim tick per perTickMs of real time (not per frame). perTickMs
// is derived at play-start so the FULL closure window plays in ~TARGET_PLAYBACK_MS (~30 s per the
// scope) regardless of how many ticks the closure spans — the shockwave crawl + recovery stay
// legible (an un-throttled rAF would race the whole sim in ~4 s).
const TARGET_PLAYBACK_MS = 30_000;
let perTickMs = 125;
let lastTickTs = 0;

function rafLoop(ts: number): void {
  const snap = storeD.getSnapshot();
  if (snap.playbackState !== "playing" || snap.tickIndex >= snap.maxTicks) {
    rafHandle = undefined;
    return; // pause / end → stop the loop (leaves the model on the current tick, not blank)
  }
  if (lastTickTs === 0) lastTickTs = ts;
  if (ts - lastTickTs >= perTickMs) {
    lastTickTs = ts;
    storeD.advanceTick(); // increments tick + sets decoratorNeedsUpdate; notifies React coarsely
    const s = storeD.getSnapshot();
    if (s.decoratorNeedsUpdate && decorator && centerline) {
      decorator.setClosureGraphics(
        buildGraphicsFromTick(s.tickHistory[s.tickIndex] ?? null, s.activeEvent, centerline)
      );
      storeD.clearDecoratorFlag();
    }
  }
  rafHandle = requestAnimationFrame(rafLoop);
}

/** Start the Concept B animation loop (called alongside storeD.play()). */
export function startPlayLoop(): void {
  if (rafHandle !== undefined) cancelAnimationFrame(rafHandle);
  // Pace so the whole window (maxTicks) plays in ~TARGET_PLAYBACK_MS, divided by the speed
  // multiplier (1×/2×/4×), regardless of closure length.
  const snap = storeD.getSnapshot();
  const ticks = Math.max(1, snap.maxTicks);
  const speed = snap.playbackSpeed || 1;
  perTickMs = Math.max(16, Math.round(TARGET_PLAYBACK_MS / ticks / speed));
  lastTickTs = 0;
  rafHandle = requestAnimationFrame(rafLoop);
}

/** Stop the Concept B animation loop (called alongside storeD.pause()). */
export function stopPlayLoop(): void {
  if (rafHandle !== undefined) {
    cancelAnimationFrame(rafHandle);
    rafHandle = undefined;
  }
}

export function getDDecorator(): LaneClosureDecorator | undefined {
  return decorator;
}

export function teardownD(): void {
  stopPlayLoop();
  unsubscribeD?.();
  unsubscribeD = undefined;
  if (decorator) {
    IModelApp.viewManager.dropDecorator(decorator);
    decorator = undefined;
  }
  centerline = undefined;
  candidateRibbons = [];
}
