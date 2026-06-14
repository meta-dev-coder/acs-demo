/*---------------------------------------------------------------------------------------------
 * Shared placement: map synthetic points (EPSG:32617 easting/northing + normalized u along the
 * corridor) to iModel spatial Point3d. Prefers the real GCS conversion (so overlays sit on the
 * reality mesh at true positions); falls back to extents-normalized layout if the iModel has no
 * usable GCS. A single marker elevation (zLevel) is used — the corridor is flat, and this is
 * robust to vertical-datum differences between the synthetic data and the mesh.
 *--------------------------------------------------------------------------------------------*/
import type { IModelConnection } from "@itwin/core-frontend";
import { Point3d, Range3d } from "@itwin/core-geometry";
import { gcsAvailable, utm17nToSpatial } from "./geo";

export interface GeoPoint {
  e: number; // EPSG:32617 easting
  n: number; // EPSG:32617 northing
  u: number; // 0..1 along corridor (fallback)
  v: number; // lane offset across (fallback)
}

export type PlacementMode = "gcs" | "extents";

function extentsPoint(p: GeoPoint, range: Range3d, zLevel: number): Point3d {
  const dx = range.high.x - range.low.x;
  const dy = range.high.y - range.low.y;
  const alongX = dx >= dy;
  const alongLen = alongX ? dx : dy;
  const acrossLen = alongX ? dy : dx;
  const acrossMid = alongX
    ? (range.low.y + range.high.y) / 2
    : (range.low.x + range.high.x) / 2;
  const along = (alongX ? range.low.x : range.low.y) + p.u * alongLen;
  const across = acrossMid + p.v * 0.1 * acrossLen;
  return alongX ? Point3d.create(along, across, zLevel) : Point3d.create(across, along, zLevel);
}

/**
 * Convert points to spatial. `zLevel` is the spatial Z to place them at (e.g. just above the
 * reality-mesh top so markers float visibly over the corridor). Returns the placement map and
 * which mode was used.
 */
export async function placePoints(
  iModel: IModelConnection,
  points: GeoPoint[],
  zLevel: number
): Promise<{ pts: Point3d[]; mode: PlacementMode }> {
  if (gcsAvailable(iModel)) {
    try {
      const spatial = await utm17nToSpatial(
        iModel,
        points.map((p) => ({ easting: p.e, northing: p.n, elevation: 0 }))
      );
      return {
        pts: spatial.map((s) => Point3d.create(s.x, s.y, zLevel)),
        mode: "gcs",
      };
    } catch (e) {
      console.warn("[place] GCS conversion failed; falling back to extents:", e);
    }
  }
  const range = iModel.projectExtents;
  return {
    pts: points.map((p) => extentsPoint(p, range, zLevel)),
    mode: "extents",
  };
}

/** Marker elevation: just above GROUND so pins sit ON the corridor, not floating above it.
 * Uses the low end of the reality-mesh range (≈ ground), else the iModel extents low. */
export function markerZLevel(iModel: IModelConnection, realityRange?: Range3d): number {
  const r = realityRange && !realityRange.isNull ? realityRange : iModel.projectExtents;
  const span = r.high.z - r.low.z;
  return r.low.z + Math.min(8, Math.max(2, span * 0.08));
}
