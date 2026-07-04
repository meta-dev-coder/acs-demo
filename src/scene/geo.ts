/*---------------------------------------------------------------------------------------------
 * Convert EPSG:32617 (UTM 17N) coordinates to iModel SPATIAL Point3d via the backend GCS
 * converter, so overlays align with the georeferenced reality mesh + iModel. Batches in one
 * round-trip. Spatial XY != UTM easting/northing (globalOrigin offset) — must go through GCS.
 *--------------------------------------------------------------------------------------------*/
import type { IModelConnection } from "@itwin/core-frontend";
import { Cartographic, type GeographicCRSProps } from "@itwin/core-common";
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

export interface WgsPoint {
  /** WGS84 longitude, in degrees. */
  lon: number;
  /** WGS84 latitude, in degrees. */
  lat: number;
  /** Height above the ellipsoid, in meters (defaults to 0 — ground level). */
  elevation?: number;
}

/**
 * Convert native WGS84 lon/lat points (e.g. Scenario A′'s DataConnect asset_registry export) to
 * iModel spatial Point3d[] (same order). Unlike `utm17nToSpatial` (which requires a full GCS
 * definition for the EPSG:32617 frame), this goes through `IModelConnection.spatialFromCartographic`,
 * which iTwin.js resolves via the iModel's GCS when one is defined, and otherwise falls back to the
 * iModel's `ecefLocation` — the same geolocation the reality mesh uses to sit correctly on the
 * globe. So this works on any real-world-located model even without an explicit horizontal CRS.
 * Throws if the iModel is not geolocated at all (`isGeoLocated` false) or a point can't convert;
 * callers should treat that as "GCS placement unavailable" and fall back to the extents/centerline
 * placement Scenario A uses.
 */
export async function wgs84ToSpatial(
  iModel: IModelConnection,
  pts: WgsPoint[]
): Promise<Point3d[]> {
  const cartographic = pts.map((p) =>
    Cartographic.fromDegrees({ longitude: p.lon, latitude: p.lat, height: p.elevation ?? 0 })
  );
  return iModel.spatialFromCartographic(cartographic);
}
