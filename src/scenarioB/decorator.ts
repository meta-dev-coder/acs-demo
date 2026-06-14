/*---------------------------------------------------------------------------------------------
 * Scenario B — corridor safety segments as pickable WorldOverlay ribbons, colored by safety
 * risk band (recolored to the treated state when a countermeasure is toggled). Click a segment
 * to open its incident card. Only drawn when Scenario B is the active scenario.
 *--------------------------------------------------------------------------------------------*/
import {
  BeButton,
  type BeButtonEvent,
  type DecorateContext,
  type Decorator,
  EventHandled,
  GraphicType,
  type HitDetail,
  IModelApp,
  type IModelConnection,
} from "@itwin/core-frontend";
import { ColorDef, LinePixels } from "@itwin/core-common";
import { type Point3d } from "@itwin/core-geometry";
import type { Id64String } from "@itwin/core-bentley";
import type { ScoredSegment } from "./types";
import { bandMeta } from "./safetyScoring";
import { store } from "../scenarioA/store";
import { frameWorld } from "../scenarioA/viewportUtils";

export interface SegmentGraphic {
  segment: ScoredSegment;
  polyline: Point3d[];
}

export class SegmentRiskDecorator implements Decorator {
  public readonly useCachedDecorations = true as const;
  private segs: SegmentGraphic[] = [];
  private idToSeg = new Map<Id64String, SegmentGraphic>();

  constructor(private readonly iModel: IModelConnection) {}

  public setSegments(segs: SegmentGraphic[]): void {
    this.segs = segs;
    this.invalidate();
  }

  public invalidate(): void {
    IModelApp.viewManager.selectedView?.invalidateCachedDecorations(this);
  }

  public decorate(context: DecorateContext): void {
    const s = store.getSnapshot();
    if (s.scenario !== "B") return;
    if (!context.viewport.view.isSpatialView()) return;
    this.idToSeg.clear();

    for (const sg of this.segs) {
      const id = this.iModel.transientIds.getNext();
      this.idToSeg.set(id, sg);

      const treated = store.isTreated(sg.segment.segment_id) && !!sg.segment.delta;
      const band =
        treated && sg.segment.delta ? sg.segment.delta.afterBand : sg.segment.band;
      const color = ColorDef.fromString(bandMeta(band).color);
      const inspected = s.inspectedSegmentId === sg.segment.segment_id;

      const builder = context.createGraphic({
        type: GraphicType.WorldOverlay,
        pickable: { id },
      });
      builder.setSymbology(color, color, inspected ? 18 : 12, LinePixels.Solid);
      builder.addLineString(sg.polyline);
      context.addDecorationFromBuilder(builder);
    }
  }

  public testDecorationHit(id: string): boolean {
    return this.idToSeg.has(id);
  }

  public async getDecorationToolTip(hit: HitDetail): Promise<HTMLElement | string> {
    const sg = this.idToSeg.get(hit.sourceId);
    if (!sg) return "";
    return `${sg.segment.name} — ${bandMeta(sg.segment.band).label} (${Math.round(
      sg.segment.score * 100
    )}%)`;
  }

  public async onDecorationButtonEvent(
    hit: HitDetail,
    ev: BeButtonEvent
  ): Promise<EventHandled> {
    if (ev.button !== BeButton.Data || !ev.isDown) return EventHandled.No;
    const sg = this.idToSeg.get(hit.sourceId);
    if (!sg) return EventHandled.No;
    store.inspectSegment(sg.segment.segment_id);
    const mid = sg.polyline[Math.floor(sg.polyline.length / 2)] ?? sg.polyline[0];
    if (mid) frameWorld(mid, 240);
    IModelApp.viewManager.selectedView?.invalidateCachedDecorations(this);
    return EventHandled.Yes;
  }
}
