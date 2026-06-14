/*---------------------------------------------------------------------------------------------
 * Convert EPSG:32617 (UTM 17N) coordinates to iModel SPATIAL Point3d via the backend GCS
 * converter, so overlays align with the georeferenced reality mesh + iModel. Batches in one
 * round-trip. Spatial XY != UTM easting/northing (globalOrigin offset) — must go through GCS.
 *--------------------------------------------------------------------------------------------*/
import type { IModelConnection } from "@itwin/core-frontend";
import { type GeographicCRSProps } from "@itwin/core-common";
import { Point3d, type XYAndZ } from "@itwin/core-geometry";

export interface Utm17nPoint {
  easting: number;
  northing: number;
  elevation: number;
}

const EPSG_32617: GeographicCRSProps = {
  horizontalCRS: { epsg: 32617 },
  verticalCRS: { id: "ELLIPSOID" },
};

export function gcsAvailable(iModel: IModelConnection): boolean {
  const m = iModel as IModelConnection & { noGcsDefined?: boolean };
  return iModel.isGeoLocated && m.noGcsDefined !== true;
}

/** Convert UTM 17N points to iModel spatial Point3d[] (same order). Throws if no GCS. */
export async function utm17nToSpatial(
  iModel: IModelConnection,
  pts: Utm17nPoint[]
): Promise<Point3d[]> {
  const geoCoords: XYAndZ[] = pts.map((p) => ({
    x: p.easting,
    y: p.northing,
    z: p.elevation,
  }));
  const api = iModel as IModelConnection & {
    toSpatialFromGcs: (
      coords: XYAndZ[],
      crs?: GeographicCRSProps
    ) => Promise<Point3d[]>;
  };
  return api.toSpatialFromGcs(geoCoords, EPSG_32617);
}
