/*---------------------------------------------------------------------------------------------
 * In-scene asset markers (Marker / MarkerSet / Decorator), colored by risk band and placed by
 * coordinate. This is the PRIMARY Scenario A visual — it works even if the ITS assets are not
 * discrete model elements (the likely case for BST409). Clicking a marker inspects + frames it.
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
import type { RiskBand, ScoredAsset } from "./types";
import { bandMeta } from "./scoring";
import { store } from "./store";
import { frameWorld } from "./viewportUtils";

const BAND_RANK: Record<RiskBand, number> = { red: 3, amber: 2, green: 1 };
const DIAMETER: Record<RiskBand, number> = { red: 50, amber: 40, green: 28 };

/** Draw a map-pin (teardrop) whose TIP sits on the asset, body + symbol above it. */
function drawPin(
  ctx: CanvasRenderingContext2D,
  radius: number,
  color: string,
  opts: { highlighted?: boolean; symbol?: string; label?: string } = {}
) {
  const r = radius;
  const cy = -(r + 8); // pin body center, above the tip at (0,0)

  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.55)";
  ctx.shadowBlur = 9;
  ctx.shadowOffsetY = 3;

  // stem (triangle from body down to the tip)
  ctx.beginPath();
  ctx.moveTo(-r * 0.62, cy + r * 0.5);
  ctx.lineTo(0, 0);
  ctx.lineTo(r * 0.62, cy + r * 0.5);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();

  // body
  ctx.beginPath();
  ctx.arc(0, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  if (opts.highlighted) {
    ctx.beginPath();
    ctx.arc(0, cy, r + 6, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  if (opts.symbol) {
    ctx.fillStyle = "#ffffff";
    ctx.font = `bold ${Math.round(r * 1.15)}px "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(opts.symbol, 0, cy + 1);
  }

  // label pill above the pin
  if (opts.label) {
    ctx.font = `600 12px "Segoe UI", sans-serif`;
    const tw = ctx.measureText(opts.label).width;
    const pad = 6;
    const ly = cy - r - 13;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = "#10151c";
    const x = -tw / 2 - pad;
    const w = tw + pad * 2;
    const h = 18;
    const rad = 5;
    ctx.beginPath();
    ctx.moveTo(x + rad, ly - h / 2);
    ctx.arcTo(x + w, ly - h / 2, x + w, ly + h / 2, rad);
    ctx.arcTo(x + w, ly + h / 2, x, ly + h / 2, rad);
    ctx.arcTo(x, ly + h / 2, x, ly - h / 2, rad);
    ctx.arcTo(x, ly - h / 2, x + w, ly - h / 2, rad);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(opts.label, 0, ly);
  }
  ctx.restore();
}

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

export class AssetMarker extends Marker {
  constructor(public asset: ScoredAsset, world: Point3d) {
    const d = DIAMETER[asset.band];
    super(world, Point2d.create(d + 24, d * 2.9));
    this.setScaleFactor({ low: 0.85, high: 1.5 });
    this.title = `${asset.label}\n${bandMeta(asset.band).label} · risk ${Math.round(
      asset.score * 100
    )}%`;
    this.drawFunc = (ctx) => {
      const s = store.getSnapshot();
      const highlighted = s.inspectedTag === asset.asset_tag;
      const inPackage = s.packageTags.includes(asset.asset_tag);
      drawPin(ctx, d / 2, bandMeta(asset.band).color, {
        highlighted: highlighted || inPackage,
        symbol: inPackage ? "✓" : asset.band === "red" ? "!" : undefined,
        label: asset.band === "green" ? undefined : CLASS_ABBR[asset.asset_class],
      });
    };
  }

  public override onMouseButton(ev: BeButtonEvent): boolean {
    if (ev.button === BeButton.Data && ev.isDown) {
      store.inspect(this.asset.asset_tag);
      frameWorld(this.worldLocation);
      const vp = IModelApp.viewManager.selectedView;
      vp?.invalidateDecorations();
      return true;
    }
    return false;
  }
}

class AssetClusterMarker extends Marker {
  constructor(location: Point3d, cluster: Cluster<AssetMarker>) {
    super(location, Point2d.create(44, 44));
    const worst = cluster.markers.reduce<RiskBand>(
      (acc, m) => (BAND_RANK[m.asset.band] > BAND_RANK[acc] ? m.asset.band : acc),
      "green"
    );
    const count = cluster.markers.length;
    const reds = cluster.markers.filter((m) => m.asset.band === "red").length;
    this.title = `${count} assets${reds ? ` · ${reds} act-now` : ""}`;
    this.drawFunc = (ctx) => {
      drawPin(ctx, 24, bandMeta(worst).color, { symbol: String(count) });
    };
  }
}

class AssetMarkerSet extends MarkerSet<AssetMarker> {
  constructor() {
    super();
    this.minimumClusterSize = 3;
  }
  protected getClusterMarker(cluster: Cluster<AssetMarker>): Marker {
    return new AssetClusterMarker(cluster.getClusterLocation(), cluster);
  }
}

export class AssetDecorator implements Decorator {
  public readonly markerSet = new AssetMarkerSet();

  public setAssets(assets: ScoredAsset[], worldByTag: Map<string, Point3d>): void {
    this.markerSet.markers.clear();
    for (const a of assets) {
      const world = worldByTag.get(a.asset_tag);
      if (world) this.markerSet.markers.add(new AssetMarker(a, world));
    }
    this.markerSet.markDirty();
    IModelApp.viewManager.selectedView?.invalidateDecorations();
  }

  public decorate(context: DecorateContext): void {
    if (store.getSnapshot().scenario !== "A") return;
    if (context.viewport.view.isSpatialView())
      this.markerSet.addDecoration(context);
  }
}
