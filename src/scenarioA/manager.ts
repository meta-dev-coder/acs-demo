/*---------------------------------------------------------------------------------------------
 * Scenario A orchestration. scoreAssetsIntoStore() runs synchronously on iModel connect (so the
 * legend populates immediately). placeAndDecorateA() runs after the viewport + reality mesh are
 * ready, placing markers at real coordinates (GCS) with an extents fallback.
 *--------------------------------------------------------------------------------------------*/
import {
  IModelApp,
  type IModelConnection,
  type ScreenViewport,
} from "@itwin/core-frontend";
import assetsData from "./data/assets.json";
import historyData from "./data/history.json";
import { scoreAssets } from "./scoring";
import { AssetDecorator } from "./decorator";
import { store } from "./store";
import { runDiscovery } from "./discovery";
import { getCenterline, corridorPoint, snapToRoad } from "../scene/place";
import type { Point3d } from "@itwin/core-geometry";
import type { HistoryRecord, RawAsset } from "./types";

let decorator: AssetDecorator | undefined;

export function scoreAssetsIntoStore(iModel: IModelConnection): void {
  const assets = (assetsData.assets as unknown) as RawAsset[];
  const history = (historyData.records as unknown) as HistoryRecord[];
  const scored = scoreAssets(assets, history);
  store.setAssets(scored);

  (window as unknown as { __acsDiscovery: () => Promise<void> }).__acsDiscovery = () =>
    runDiscovery(iModel);

  const reds = scored.filter((a) => a.band === "red").length;
  console.log(`[Scenario A] ${scored.length} ITS assets scored — ${reds} act-now.`);

  // Auto-run discovery once so the "[discovery-summary]" line appears without typing in the console.
  void runDiscovery(iModel);
}

export async function placeAndDecorateA(vp: ScreenViewport): Promise<void> {
  const scored = store.getSnapshot().assets;
  const cl = await getCenterline(vp.iModel);
  const worldByTag = new Map<string, Point3d>();
  // Place along the corridor (preserves each asset's u/lateral intent), then snap to the nearest
  // real road element so the pin always sits ON the highway, not on the median/embankment.
  scored.forEach((a) =>
    worldByTag.set(a.asset_tag, snapToRoad(corridorPoint(cl, a.coord_e, a.coord_n, 0), 8))
  );
  store.setWorldLocations(worldByTag, cl.pts.length > 1 ? "road" : "extents");

  if (!decorator) {
    decorator = new AssetDecorator();
    IModelApp.viewManager.addDecorator(decorator);
  }
  decorator.setAssets(scored, worldByTag);
  console.log(`[Scenario A] ${scored.length} markers placed on corridor centerline (${cl.pts.length} pts).`);
}
