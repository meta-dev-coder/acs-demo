/*---------------------------------------------------------------------------------------------
 * Scenario A′ orchestration — mirrors ../scenarioA/manager.ts's shape, adapted for a fetched
 * (not built-in JSON) dataset with native WGS84 coordinates instead of a synthetic EPSG:32617
 * frame:
 *
 *   loadAssetsPrime() (dataSource.ts) fetches + adapts + scores DataConnect's asset_registry
 *   into storeAPrime (three-tier fallback, keep-previous-on-failure — see dataSource.ts's doc
 *   comment). placeAndDecorateAPrime() then places a pin per asset:
 *
 *     1) PREFERRED — "gcs": DataConnect's lon/lat are real-world WGS84, so convert them straight
 *        to iModel spatial coordinates via scene/geo.ts's wgs84ToSpatial() (goes through the
 *        iModel's GCS if one is defined, else its ecefLocation — the same geolocation the reality
 *        mesh uses). This is NOT the synthetic-frame corridorPoint() mapping Scenario A's own CSV
 *        sources need (their coord_e/coord_n don't line up with this particular model) — A′'s
 *        coordinates are the genuine article, so a direct geographic conversion is the correct
 *        (and simpler) path.
 *     2) Each converted point is clamped into projectExtents (scene/place.ts's clampToExtents) so
 *        a bad/out-of-range conversion can never place a pin (or, via the shared reframe path,
 *        fling the camera) off the model, then snapped to the nearest real road element
 *        (scene/place.ts's snapToRoad, the SAME helper + cached road points Scenario A uses) so
 *        the pin sits ON the carriageway.
 *     3) FALLBACK — "extents": if the iModel isn't geolocated at all (wgs84ToSpatial throws),
 *        fall back to spreading pins evenly along the corridor centerline (scene/place.ts's
 *        corridorPoint), exactly the degraded path Scenario A's own placement.ts documents for an
 *        uncalibrated model — so A′ still renders pins on any loaded iModel, geolocated or not.
 *--------------------------------------------------------------------------------------------*/
import {
  IModelApp,
  type IModelConnection,
  type ScreenViewport,
} from "@itwin/core-frontend";
import { Point3d } from "@itwin/core-geometry";
import { loadAssetsPrime } from "./dataSource";
import { storeAPrime } from "./storeAPrime";
import { AssetPrimeDecorator } from "./decorator";
import { clampToExtents, getCenterline, snapToRoad } from "../scene/place";
import { wgs84ToSpatial } from "../scene/geo";
import type { ScoredAssetPrime } from "./types";

let decorator: AssetPrimeDecorator | undefined;

export function getAPrimeDecorator(): AssetPrimeDecorator | undefined {
  return decorator;
}

/** Convert each asset's native WGS84 lon/lat to spatial via the iModel's GCS/ecefLocation, clamp
 *  into projectExtents, then snap onto the nearest real road element. Throws if the iModel isn't
 *  geolocated (caller falls back to the extents/centerline placement). */
async function placeByGcs(
  iModel: IModelConnection,
  assets: ScoredAssetPrime[]
): Promise<Map<string, Point3d>> {
  if (!iModel.isGeoLocated) throw new Error("iModel is not geolocated");
  const spatial = await wgs84ToSpatial(
    iModel,
    assets.map((a) => ({ lon: a.lon, lat: a.lat }))
  );
  const extents = iModel.projectExtents;
  const worldByTag = new Map<string, Point3d>();
  assets.forEach((a, i) => {
    const p = spatial[i];
    if (!p) return;
    worldByTag.set(a.asset_tag, snapToRoad(clampToExtents(p, extents), 8));
  });
  return worldByTag;
}

/** Degraded fallback for an ungeolocated iModel: spread pins evenly along the corridor
 *  centerline (same spine Scenario A's own extents fallback would ride), still snapped to the
 *  nearest road element. A′ has no synthetic (easting, northing) frame to feed corridorPoint(),
 *  so this walks the centerline directly by arc-length fraction (index order stands in for
 *  along-corridor position — good enough for the "model has no GCS at all" degraded case). */
async function placeByExtentsFallback(
  iModel: IModelConnection,
  assets: ScoredAssetPrime[]
): Promise<Map<string, Point3d>> {
  const cl = await getCenterline(iModel);
  const worldByTag = new Map<string, Point3d>();
  const n = Math.max(1, assets.length);
  assets.forEach((a, i) => {
    const u = (i + 0.5) / n;
    worldByTag.set(a.asset_tag, snapToRoad(pointAtFraction(cl, u), 8));
  });
  return worldByTag;
}

function pointAtFraction(cl: Awaited<ReturnType<typeof getCenterline>>, u: number): Point3d {
  const { pts, cum, total } = cl;
  if (pts.length === 0) return Point3d.create(0, 0, 0);
  if (pts.length === 1) return pts[0];
  const s = Math.max(0, Math.min(1, u)) * total;
  let i = 0;
  while (i < pts.length - 2 && cum[i + 1] <= s) i++;
  const segLen = cum[i + 1] - cum[i] || 1;
  const f = Math.max(0, Math.min(1, (s - cum[i]) / segLen));
  const a = pts[i];
  const b = pts[i + 1];
  return Point3d.create(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f, a.z + (b.z - a.z) * f);
}

export async function placeAndDecorateAPrime(vp: ScreenViewport): Promise<void> {
  if (storeAPrime.getSnapshot().assets.length === 0) await loadAssetsPrime();
  const scored = storeAPrime.getSnapshot().assets;

  let worldByTag: Map<string, Point3d>;
  let placementMode: "gcs" | "extents";
  try {
    worldByTag = await placeByGcs(vp.iModel, scored);
    placementMode = "gcs";
  } catch (e) {
    console.warn("[Scenario A′] GCS placement unavailable, falling back to centerline spread:", e);
    worldByTag = await placeByExtentsFallback(vp.iModel, scored);
    placementMode = "extents";
  }
  storeAPrime.setWorldLocations(worldByTag, placementMode);

  if (!decorator) {
    decorator = new AssetPrimeDecorator();
    IModelApp.viewManager.addDecorator(decorator);
  }
  decorator.setAssets(scored, worldByTag);
  console.log(
    `[Scenario A′] ${scored.length} DataConnect markers placed (${placementMode}) — tier: ${
      storeAPrime.getSnapshot().tier
    }.`
  );
}
