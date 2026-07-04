/*---------------------------------------------------------------------------------------------
 * Scenario A′ in-scene markers — same Marker/MarkerSet/Decorator shape as ../scenarioA/decorator
 * (drawPin() is REUSED, not re-implemented, so A′ pins read identically to A's: teardrop pin,
 * colored by risk band, clustered when crowded). Two differences from A's decorator:
 *   - gates on `scenario === "A'"` (the shared tab-selection store, ../scenarioA/store) instead
 *     of "A", and reads/writes A′'s OWN store (storeAPrime.ts) for inspect/highlight state.
 *   - the DataConnect export's "Asset Category" universe is broader than Scenario A's 9-class
 *     enum (see adapter.ts's CATEGORY_TO_ASSET_CLASS comment), so the pin label falls back to a
 *     short slug of the asset_class for any class outside CLASS_ABBR instead of omitting it.
 *--------------------------------------------------------------------------------------------*/
import {
  BeButton,
  type BeButtonEvent,
  Cluster,
  type DecorateContext,
  type Decorator,
  IModelApp,
  Marker,
  MarkerSet,
} from "@itwin/core-frontend";
import { Point2d, type Point3d } from "@itwin/core-geometry";
import type { RiskBand } from "../scenarioA/types";
import { bandMeta } from "../scenarioA/scoring";
import { drawPin } from "../scenarioA/decorator";
import { store } from "../scenarioA/store";
import { storeAPrime } from "./storeAPrime";
import { frameWorld } from "../scenarioA/viewportUtils";
import type { ScoredAssetPrime } from "./types";

const BAND_RANK: Record<RiskBand, number> = { red: 3, amber: 2, green: 1 };
const DIAMETER: Record<RiskBand, number> = { red: 34, amber: 28, green: 22 };

const CLASS_ABBR: Record<string, string> = {
  toll_gantry: "GANTRY",
  access_gate: "GATE",
  lane_control: "LANE CTRL",
  ramp_signal: "RAMP",
  detector: "DETECTOR",
  dms: "DMS",
  cctv: "CCTV",
  lighting: "LIGHT",
  controller_cabinet: "CABINET",
};

/** Short pin label for any asset_class, including the DataConnect categories outside Scenario
 *  A's original enum (falls back to an upper-cased slug, truncated so the pill stays readable). */
function classAbbr(assetClass: string): string {
  const known = CLASS_ABBR[assetClass];
  if (known) return known;
  return assetClass.replace(/_/g, " ").toUpperCase().slice(0, 14);
}

export class AssetPrimeMarker extends Marker {
  constructor(public asset: ScoredAssetPrime, world: Point3d) {
    const d = DIAMETER[asset.band];
    super(world, Point2d.create(d + 24, d * 2.9));
    this.setScaleFactor({ low: 0.85, high: 1.5 });
    this.title = `${asset.label}\n${bandMeta(asset.band).label} · risk ${Math.round(
      asset.score * 100
    )}% (DataConnect)`;
    this.drawFunc = (ctx) => {
      const highlighted = storeAPrime.getSnapshot().inspectedTag === asset.asset_tag;
      drawPin(ctx, d / 2, bandMeta(asset.band).color, {
        highlighted,
        symbol: asset.band === "red" ? "!" : undefined,
        label: asset.band === "green" ? undefined : classAbbr(asset.asset_class),
      });
    };
  }

  public override onMouseButton(ev: BeButtonEvent): boolean {
    if (ev.button === BeButton.Data && ev.isDown) {
      storeAPrime.inspect(this.asset.asset_tag);
      frameWorld(this.worldLocation);
      const vp = IModelApp.viewManager.selectedView;
      vp?.invalidateDecorations();
      return true;
    }
    return false;
  }
}

class AssetPrimeClusterMarker extends Marker {
  constructor(location: Point3d, cluster: Cluster<AssetPrimeMarker>) {
    super(location, Point2d.create(44, 44));
    const worst = cluster.markers.reduce<RiskBand>(
      (acc, m) => (BAND_RANK[m.asset.band] > BAND_RANK[acc] ? m.asset.band : acc),
      "green"
    );
    const count = cluster.markers.length;
    const reds = cluster.markers.filter((m) => m.asset.band === "red").length;
    this.title = `${count} DataConnect assets${reds ? ` · ${reds} act-now` : ""}`;
    this.drawFunc = (ctx) => {
      drawPin(ctx, 24, bandMeta(worst).color, { symbol: String(count) });
    };
  }
}

class AssetPrimeMarkerSet extends MarkerSet<AssetPrimeMarker> {
  constructor() {
    super();
    this.minimumClusterSize = 3;
  }
  protected getClusterMarker(cluster: Cluster<AssetPrimeMarker>): Marker {
    return new AssetPrimeClusterMarker(cluster.getClusterLocation(), cluster);
  }
}

export class AssetPrimeDecorator implements Decorator {
  public readonly markerSet = new AssetPrimeMarkerSet();

  public setAssets(assets: ScoredAssetPrime[], worldByTag: Map<string, Point3d>): void {
    this.markerSet.markers.clear();
    for (const a of assets) {
      const world = worldByTag.get(a.asset_tag);
      if (world) this.markerSet.markers.add(new AssetPrimeMarker(a, world));
    }
    this.markerSet.markDirty();
    IModelApp.viewManager.selectedView?.invalidateDecorations();
  }

  /** Force a redraw without changing the marker set — used by scene/init.ts's storeAPrime
   *  subscription (mirrors getBDecorator()/getCDecorator()'s invalidate(), adapted to A's own
   *  non-cached Marker/MarkerSet convention — this decorator does not set
   *  `useCachedDecorations`, same as ../scenarioA/decorator.ts's AssetDecorator) so A′ highlight
   *  state stays in sync when storeAPrime.inspect() fires from the list panel, not just from a
   *  map click (which already zooms the camera, forcing a redraw on its own). */
  public invalidate(): void {
    this.markerSet.markDirty();
    IModelApp.viewManager.selectedView?.invalidateDecorations();
  }

  public decorate(context: DecorateContext): void {
    if (store.getSnapshot().scenario !== "A'") return;
    if (context.viewport.view.isSpatialView()) this.markerSet.addDecoration(context);
  }
}
