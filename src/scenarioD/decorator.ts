/*---------------------------------------------------------------------------------------------
 * Scenario D — Lane Closure decorator.
 *
 * Draws (only when Scenario D is active):
 *   - the closed-lane segment as a hazard-amber ribbon (#ff8f00),
 *   - the upstream congestion queue as an LOS-F dark-red ribbon (schematic, on the connector),
 *   - the EB SR-84 diversion ribbon (blue) when VMS diversion is active,
 *   - a LaneClosureMarker (closure head) and QueueTailMarker (back of queue).
 *
 * Reuses the SegmentRiskDecorator WorldOverlay polyline + drawPin pattern (Scenario B) and the
 * LOS_COLORS palette from Scenario C. Every tooltip/marker includes SCHEMATIC_LABEL (§4). Click
 * dispatches to storeD.inspectClosure(segmentId).
 *--------------------------------------------------------------------------------------------*/
import {
  BeButton,
  type BeButtonEvent,
  type Cluster,
  type DecorateContext,
  type Decorator,
  EventHandled,
  GraphicType,
  type HitDetail,
  IModelApp,
  Marker,
  MarkerSet,
} from "@itwin/core-frontend";
import { ColorDef, LinePixels } from "@itwin/core-common";
import { Point2d, type Point3d } from "@itwin/core-geometry";
import type { Id64String } from "@itwin/core-bentley";
import { store } from "../scenarioA/store";
import { storeD } from "./storeD";
import { drawPin } from "../scenarioA/decorator";
import { LOS_COLORS } from "../scenarioC/decorator";
import { SCHEMATIC_LABEL } from "./placeClosure";

const HAZARD_AMBER = "#ff8f00";
// Diversion route color — scope: "diverted route lights up an LOS color (suggested orange,
// distinct from the queue red)". Orange, clearly distinct from the dark-red (#7b0000) queue.
const SR84_ORANGE = "#ff6f00";
const CASING = ColorDef.from(8, 11, 16); // near-black casing (shared with Scenario C)

// ---------------------------------------------------------------------------
// Markers (closure head + back of queue) — drawPin pattern from Scenario A/B
// ---------------------------------------------------------------------------
class LaneClosureMarker extends Marker {
  constructor(loc: Point3d, segmentId: string) {
    super(loc, Point2d.create(72, 100));
    this.setScaleFactor({ low: 0.7, high: 1.4 });
    this.title = `Lane closure — ${segmentId} · ${SCHEMATIC_LABEL}`;
    this.drawFunc = (ctx) => drawPin(ctx, 26, HAZARD_AMBER, { symbol: "X", label: "CLOSED" });
  }
}

class QueueTailMarker extends Marker {
  constructor(loc: Point3d, lengthMi: number) {
    super(loc, Point2d.create(64, 92));
    this.setScaleFactor({ low: 0.7, high: 1.3 });
    this.title = `Back of queue — ${lengthMi.toFixed(1)} mi (schematic) · ${SCHEMATIC_LABEL}`;
    this.drawFunc = (ctx) =>
      drawPin(ctx, 22, LOS_COLORS["F"] ?? "#7b0000", { symbol: "Q", label: `${lengthMi.toFixed(1)} mi` });
  }
}

class ClosureMarkerSet extends MarkerSet<Marker> {
  protected getClusterMarker(cluster: Cluster<Marker>): Marker {
    return cluster.markers[0];
  }
}

// ---------------------------------------------------------------------------
// Graphics payload (built by managerD from the storeD snapshot)
// ---------------------------------------------------------------------------
export interface ClosureGraphics {
  /** Closed-lane segment ribbon (hazard-amber). Empty when displayMode='before' / no event. */
  closure: Point3d[];
  /** Upstream congestion queue ribbon (LOS-F). Empty when no queue. */
  queue: Point3d[];
  /** EB SR-84 diversion ribbon. Drawn only when sr84Active. */
  sr84: Point3d[];
  /** True when the VMS diversion threshold is exceeded. */
  sr84Active: boolean;
  /** Closure-head marker position, or null. */
  closureHead: Point3d | null;
  /** Back-of-queue marker position, or null. */
  queueTail: Point3d | null;
  /** Segment id under closure (for click→inspect), or null. */
  segmentId: string | null;
  /** Queue length in miles (for the queue marker label). */
  queueLengthMi: number;
}

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

// ---------------------------------------------------------------------------
// Decorator
// ---------------------------------------------------------------------------
export class LaneClosureDecorator implements Decorator {
  public readonly useCachedDecorations = true as const;
  private graphics: ClosureGraphics = EMPTY_GRAPHICS;
  private readonly markers = new ClosureMarkerSet();
  private idToSeg = new Map<Id64String, string>();

  /** Update the closure/queue/SR-84 graphics + markers. Call after every store update. */
  public setClosureGraphics(g: ClosureGraphics): void {
    this.graphics = g;

    this.markers.markers.clear();
    if (g.closureHead && g.segmentId) {
      this.markers.markers.add(new LaneClosureMarker(g.closureHead, g.segmentId));
    }
    if (g.queueTail && g.queueLengthMi > 0) {
      this.markers.markers.add(new QueueTailMarker(g.queueTail, g.queueLengthMi));
    }
    this.markers.markDirty();
    this.invalidate();
  }

  public invalidate(): void {
    IModelApp.viewManager.selectedView?.invalidateCachedDecorations(this);
  }

  public decorate(context: DecorateContext): void {
    if (store.getSnapshot().scenario !== "D") return;
    if (!context.viewport.view.isSpatialView()) return;

    const iModel = context.viewport.iModel;
    this.idToSeg.clear();
    const g = this.graphics;

    const ribbon = (poly: Point3d[], colorHex: string, width: number, pickable: boolean): void => {
      if (poly.length < 2) return;
      const color = ColorDef.fromString(colorHex);
      const id = pickable ? iModel.transientIds.getNext() : undefined;
      if (id && g.segmentId) this.idToSeg.set(id, g.segmentId);

      const casing = context.createGraphic({
        type: GraphicType.WorldOverlay,
        pickable: id ? { id } : undefined,
      });
      casing.setSymbology(CASING, CASING, width + 6, LinePixels.Solid);
      casing.addLineString(poly);
      context.addDecorationFromBuilder(casing);

      const builder = context.createGraphic({
        type: GraphicType.WorldOverlay,
        pickable: id ? { id } : undefined,
      });
      builder.setSymbology(color, color, width, LinePixels.Solid);
      builder.addLineString(poly);
      context.addDecorationFromBuilder(builder);
    };

    // Queue (drawn first, underneath) → closure head ribbon on top → SR-84 diversion.
    ribbon(g.queue, LOS_COLORS["F"] ?? "#7b0000", 14, true);
    ribbon(g.closure, HAZARD_AMBER, 16, true);
    if (g.sr84Active) ribbon(g.sr84, SR84_ORANGE, 10, false);

    this.markers.addDecoration(context);
  }

  public testDecorationHit(id: string): boolean {
    return this.idToSeg.has(id);
  }

  public async getDecorationToolTip(hit: HitDetail): Promise<HTMLElement | string> {
    const segId = this.idToSeg.get(hit.sourceId);
    if (!segId) return "";
    const g = this.graphics;
    return (
      `Lane closure — ${segId} · back of queue ${g.queueLengthMi.toFixed(1)} mi` +
      `${g.sr84Active ? " · VMS diversion active" : ""} · ${SCHEMATIC_LABEL}`
    );
  }

  public async onDecorationButtonEvent(hit: HitDetail, ev: BeButtonEvent): Promise<EventHandled> {
    if (ev.button !== BeButton.Data || !ev.isDown) return EventHandled.No;
    const segId = this.idToSeg.get(hit.sourceId);
    if (!segId) return EventHandled.No;
    storeD.inspectClosure(segId);
    this.invalidate();
    return EventHandled.Yes;
  }
}
