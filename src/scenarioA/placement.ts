/*---------------------------------------------------------------------------------------------
 * Marker placement.
 *
 * DEFAULT MODE ("extents") works on ANY loaded iModel with zero calibration: it lays each
 * asset out along the model's longest horizontal axis (the corridor) using its u/v/zHint.
 * This is the safe demo path and the reason Scenario A does not depend on the ITS assets
 * existing as discrete model elements.
 *
 * CALIBRATED MODE ("epsg32617") is the upgrade path once Phase-0 discovery confirms the
 * iModel's georeferencing: place markers at true UTM-17N coordinates. Fill in the affine
 * offset measured against 2-3 known landmarks (see TODO) and flip PLACEMENT_MODE.
 *--------------------------------------------------------------------------------------------*/
import { Point3d, Range3d } from "@itwin/core-geometry";
import type { RawAsset } from "./types";

export type PlacementMode = "extents" | "epsg32617";
export const PLACEMENT_MODE: PlacementMode = "extents";

/** TODO(calibration): after discovery, set this so worldX = coord_e - originE, etc.
 *  Measure originE/originN by reading the spatial coords of a known bridge/landmark and
 *  subtracting its EPSG:32617 easting/northing. */
const EPSG_ORIGIN = { e: 0, n: 0, z: 0 };

function placeByExtents(a: RawAsset, range: Range3d): Point3d {
  const dx = range.high.x - range.low.x;
  const dy = range.high.y - range.low.y;
  const dz = Math.max(1, range.high.z - range.low.z);
  const alongX = dx >= dy;
  const alongLen = alongX ? dx : dy;
  const acrossLen = alongX ? dy : dx;
  const acrossMid = alongX
    ? (range.low.y + range.high.y) / 2
    : (range.low.x + range.high.x) / 2;

  const along = (alongX ? range.low.x : range.low.y) + a.u * alongLen;
  const across = acrossMid + a.v * 0.1 * acrossLen;
  const z = range.low.z + (0.12 + a.zHint * 0.22) * dz + 4;
  return alongX ? Point3d.create(along, across, z) : Point3d.create(across, along, z);
}

function placeByEpsg(a: RawAsset): Point3d {
  return Point3d.create(
    a.coord_e - EPSG_ORIGIN.e,
    a.coord_n - EPSG_ORIGIN.n,
    EPSG_ORIGIN.z + a.zHint * 12 + 6
  );
}

export function computeWorldLocations(
  assets: RawAsset[],
  projectExtents: Range3d
): Map<string, Point3d> {
  const out = new Map<string, Point3d>();
  for (const a of assets) {
    const p =
      PLACEMENT_MODE === "epsg32617"
        ? placeByEpsg(a)
        : placeByExtents(a, projectExtents);
    out.set(a.asset_tag, p);
  }
  return out;
}
