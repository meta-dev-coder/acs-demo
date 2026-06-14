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
import { placePoints } from "../scene/place";
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
}

export async function placeAndDecorateA(
  vp: ScreenViewport,
  zLevel: number
): Promise<void> {
  const scored = store.getSnapshot().assets;
  const { pts, mode } = await placePoints(
    vp.iModel,
    scored.map((a) => ({ e: a.coord_e, n: a.coord_n, u: a.u, v: a.v })),
    zLevel
  );
  const worldByTag = new Map<string, (typeof pts)[number]>();
  scored.forEach((a, i) => worldByTag.set(a.asset_tag, pts[i]));
  store.setWorldLocations(worldByTag, mode);

  if (!decorator) {
    decorator = new AssetDecorator();
    IModelApp.viewManager.addDecorator(decorator);
  }
  decorator.setAssets(scored, worldByTag);
  console.log(`[Scenario A] markers placed via ${mode}.`);
}
