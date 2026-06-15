/*---------------------------------------------------------------------------------------------
 * Scenario B — corridor safety segments as pickable WorldOverlay ribbons, colored by safety
 * risk band (recolored to the treated state when a countermeasure is toggled). Click a segment
 * to open its incident card. Only drawn when Scenario B is the active scenario.
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
  type IModelConnection,
  Marker,
  MarkerSet,
} from "@itwin/core-frontend";
import { ColorDef, LinePixels } from "@itwin/core-common";
import { Point2d, type Point3d } from "@itwin/core-geometry";
import type { Id64String } from "@itwin/core-bentley";
import type { ScoredSegment } from "./types";
import { bandMeta } from "./safetyScoring";
import { store } from "../scenarioA/store";
import { frameWorld } from "../scenarioA/viewportUtils";
import { drawPin } from "../scenarioA/decorator";

/** A pin that marks the single highest-risk corridor segment. */
class HotspotMarker extends Marker {
  constructor(loc: Point3d, color: string, title: string) {
    super(loc, Point2d.create(64, 96));
    this.setScaleFactor({ low: 0.8, high: 1.5 });
    this.title = title;
    this.drawFunc = (ctx) => drawPin(ctx, 26, color, { symbol: "!", label: "HOTSPOT" });
  }
}

class HotspotMarkerSet extends MarkerSet<HotspotMarker> {
  protected getClusterMarker(cluster: Cluster<HotspotMarker>): Marker {
    return cluster.markers[0]; // single marker — effectively never clusters
  }
}

export interface SegmentGraphic {
  segment: ScoredSegment;
  polyline: Point3d[];
}

export class SegmentRiskDecorator implements Decorator {
  public readonly useCachedDecorations = true as const;
  private segs: SegmentGraphic[] = [];
  private idToSeg = new Map<Id64String, SegmentGraphic>();
  private readonly hotspots = new HotspotMarkerSet();

  constructor(private readonly iModel: IModelConnection) {}

  public setSegments(segs: SegmentGraphic[]): void {
    this.segs = segs;
    // Pin the single highest-risk segment so the eye goes straight to the hotspot.
    this.hotspots.markers.clear();
    const worst = [...segs].sort((a, b) => b.segment.score - a.segment.score)[0];
    if (worst) {
      const mid =
        worst.polyline[Math.floor(worst.polyline.length / 2)] ?? worst.polyline[0];
      if (mid)
        this.hotspots.markers.add(
          new HotspotMarker(
            mid,
            bandMeta(worst.segment.band).color,
            `Top safety hotspot — ${worst.segment.name}`
          )
        );
    }
    this.hotspots.markDirty();
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

    const casingColor = ColorDef.from(8, 11, 16); // near-black outline so ribbons read over cyan edges + aerial

    for (const sg of this.segs) {
      const id = this.iModel.transientIds.getNext();
      this.idToSeg.set(id, sg);

      const treated = store.isTreated(sg.segment.segment_id) && !!sg.segment.delta;
      const band =
        treated && sg.segment.delta ? sg.segment.delta.afterBand : sg.segment.band;
      const color = ColorDef.fromString(bandMeta(band).color);
      const inspected = s.inspectedSegmentId === sg.segment.segment_id;

      // Width encodes risk (red reads boldest); inspected gets a boost.
      const baseW = band === "red" ? 15 : band === "amber" ? 11 : 8;
      const w = inspected ? baseW + 7 : baseW;

      // Dark casing under the colored ribbon so risk colour stands out over the model + map.
      const casing = context.createGraphic({ type: GraphicType.WorldOverlay, pickable: { id } });
      casing.setSymbology(casingColor, casingColor, w + 6, LinePixels.Solid);
      casing.addLineString(sg.polyline);
      context.addDecorationFromBuilder(casing);

      const builder = context.createGraphic({ type: GraphicType.WorldOverlay, pickable: { id } });
      builder.setSymbology(color, color, w, LinePixels.Solid);
      builder.addLineString(sg.polyline);
      context.addDecorationFromBuilder(builder);
    }

    // pin on the top hotspot segment
    this.hotspots.addDecoration(context);
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
