/*---------------------------------------------------------------------------------------------
 * Scenario C — Dynamic Tolling decorator.
 *
 * Colors the central reversible express sub-sections (EXP-W/C/E) by LOS density band (cool→hot)
 * or by posted rate (color-by toggle), always labels each section with its posted rate on a
 * floating gantry-style price tag (drawPin), and recolors connected mainline red when the
 * safety flag fires.
 *
 * Reuses the SegmentRiskDecorator WorldOverlay polyline + drawPin pattern from Scenario B.
 * Only drawn when Scenario C is the active scenario.
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
import { store } from "../scenarioA/store";
import { storeC } from "./storeC";
import { drawPin } from "../scenarioA/decorator";
import type { SectionPricingResult } from "./types";

// ---------------------------------------------------------------------------
// LOS → color mapping (cool→hot: blue → green → yellow → orange → red → dark-red)
// ---------------------------------------------------------------------------
export const LOS_COLORS: Record<string, string> = {
  A: "#2196f3", // blue — uncongested
  B: "#4caf50", // green — stable flow
  C: "#ffeb3b", // yellow — some restrictions
  D: "#ff9800", // orange — approaching unstable
  E: "#f44336", // red — unstable, approaching capacity
  F: "#7b0000", // dark-red — breakdown
};

/** Map a posted rate ($0.50–$10.00) to a cool→hot color for the rate-coloring mode. */
function rateColor(rate: number): string {
  // $0.50 → blue, $3.00 → red, $10.00 → dark-red
  const t = Math.max(0, Math.min(1, (rate - 0.50) / (3.00 - 0.50)));
  if (t < 0.25) return "#2196f3"; // LOS A blue
  if (t < 0.50) return "#4caf50"; // LOS B green
  if (t < 0.65) return "#ffeb3b"; // LOS C yellow
  if (t < 0.80) return "#ff9800"; // LOS D orange
  if (t < 1.00) return "#f44336"; // LOS E red
  return "#7b0000";               // LOS F dark-red
}

/** Bright-red used for the mainline safety-flag recolor. */
const SAFETY_RED = "#cc0000";

// ---------------------------------------------------------------------------
// Gantry price-tag marker (replaces the ScenarioB HotspotMarker pattern)
// ---------------------------------------------------------------------------
class GantryPriceMarker extends Marker {
  constructor(loc: Point3d, private rate: number, private los: string, sectionName: string) {
    super(loc, Point2d.create(72, 100));
    this.setScaleFactor({ low: 0.7, high: 1.4 });
    this.title = `${sectionName} — LOS ${los} · $${rate.toFixed(2)} posted`;
    this.drawFunc = (ctx) =>
      drawPin(ctx, 26, LOS_COLORS[los] ?? "#888", {
        symbol: `$${rate.toFixed(2)}`,
        label: `LOS ${los}`,
      });
  }
}

class GantryMarkerSet extends MarkerSet<GantryPriceMarker> {
  protected getClusterMarker(cluster: Cluster<GantryPriceMarker>): Marker {
    return cluster.markers[0];
  }
}

// ---------------------------------------------------------------------------
// Section graphic holder
// ---------------------------------------------------------------------------
export interface SectionGraphic {
  sectionId: string;
  sectionName: string;
  polyline: Point3d[];
  pricing: SectionPricingResult;
}

// ---------------------------------------------------------------------------
// Mainline safety-flag graphic holder
// ---------------------------------------------------------------------------
export interface MainlineGraphic {
  segmentId: string;
  polyline: Point3d[];
  safetyFlag: boolean;
}

// ---------------------------------------------------------------------------
// Main decorator
// ---------------------------------------------------------------------------
export class TollingDecorator implements Decorator {
  public readonly useCachedDecorations = true as const;
  private sections: SectionGraphic[] = [];
  private mainlines: MainlineGraphic[] = [];
  private readonly gantryMarkers = new GantryMarkerSet();
  private idToSection = new Map<Id64String, SectionGraphic>();

  constructor(private readonly iModel: IModelConnection) {}

  /** Update express section graphics + pricing. Call after every store update. */
  public setSections(sections: SectionGraphic[]): void {
    this.sections = sections;

    // Rebuild gantry price tags at the midpoint of each section.
    this.gantryMarkers.markers.clear();
    for (const sg of sections) {
      const mid = sg.polyline[Math.floor(sg.polyline.length / 2)] ?? sg.polyline[0];
      if (mid) {
        this.gantryMarkers.markers.add(
          new GantryPriceMarker(mid, sg.pricing.postedRate, sg.pricing.los, sg.sectionName)
        );
      }
    }
    this.gantryMarkers.markDirty();
    this.invalidate();
  }

  /** Update mainline safety-flag overlays. Call when safety flags change. */
  public setMainlines(mainlines: MainlineGraphic[]): void {
    this.mainlines = mainlines;
    this.invalidate();
  }

  public invalidate(): void {
    IModelApp.viewManager.selectedView?.invalidateCachedDecorations(this);
  }

  public decorate(context: DecorateContext): void {
    const scenarioState = store.getSnapshot();
    if (scenarioState.scenario !== "C") return;
    if (!context.viewport.view.isSpatialView()) return;

    this.idToSection.clear();

    const cState = storeC.getSnapshot();
    const colorMode = cState.colorMode;

    const casingColor = ColorDef.from(8, 11, 16); // near-black casing

    // Draw express sub-section ribbons
    for (const sg of this.sections) {
      const id = this.iModel.transientIds.getNext();
      this.idToSection.set(id, sg);

      const color = colorMode === "rate"
        ? ColorDef.fromString(rateColor(sg.pricing.postedRate))
        : ColorDef.fromString(LOS_COLORS[sg.pricing.los] ?? "#888");

      const inspected = cState.inspectedSectionId === sg.sectionId;
      const baseW = sg.pricing.los === "E" || sg.pricing.los === "F" ? 16 : 12;
      const w = inspected ? baseW + 6 : baseW;

      // Casing
      const casing = context.createGraphic({ type: GraphicType.WorldOverlay, pickable: { id } });
      casing.setSymbology(casingColor, casingColor, w + 6, LinePixels.Solid);
      casing.addLineString(sg.polyline);
      context.addDecorationFromBuilder(casing);

      // Colored ribbon
      const builder = context.createGraphic({ type: GraphicType.WorldOverlay, pickable: { id } });
      builder.setSymbology(color, color, w, LinePixels.Solid);
      builder.addLineString(sg.polyline);
      context.addDecorationFromBuilder(builder);
    }

    // Draw mainline safety-flag overlays (red when flag fires)
    for (const ml of this.mainlines) {
      if (!ml.safetyFlag) continue;
      const mlColor = ColorDef.fromString(SAFETY_RED);
      const mlId = this.iModel.transientIds.getNext();

      const mlCasing = context.createGraphic({ type: GraphicType.WorldOverlay, pickable: { id: mlId } });
      mlCasing.setSymbology(casingColor, casingColor, 24, LinePixels.Solid);
      mlCasing.addLineString(ml.polyline);
      context.addDecorationFromBuilder(mlCasing);

      const mlBuilder = context.createGraphic({ type: GraphicType.WorldOverlay, pickable: { id: mlId } });
      mlBuilder.setSymbology(mlColor, mlColor, 18, LinePixels.Solid);
      mlBuilder.addLineString(ml.polyline);
      context.addDecorationFromBuilder(mlBuilder);
    }

    // Gantry price tags
    this.gantryMarkers.addDecoration(context);
  }

  public testDecorationHit(id: string): boolean {
    return this.idToSection.has(id);
  }

  public async getDecorationToolTip(hit: HitDetail): Promise<HTMLElement | string> {
    const sg = this.idToSection.get(hit.sourceId);
    if (!sg) return "";
    return (
      `${sg.sectionName} — LOS ${sg.pricing.los} · $${sg.pricing.postedRate.toFixed(2)} ` +
      `· density ${sg.pricing.density.toFixed(1)} veh/mi/ln ` +
      `· util ${(sg.pricing.utilization * 100).toFixed(0)}%`
    );
  }

  public async onDecorationButtonEvent(
    hit: HitDetail,
    ev: BeButtonEvent
  ): Promise<EventHandled> {
    if (ev.button !== BeButton.Data || !ev.isDown) return EventHandled.No;
    const sg = this.idToSection.get(hit.sourceId);
    if (!sg) return EventHandled.No;
    storeC.inspectSection(sg.sectionId);
    this.invalidate();
    return EventHandled.Yes;
  }
}
