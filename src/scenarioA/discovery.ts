/*---------------------------------------------------------------------------------------------
 * Phase-0 discovery. Run this FIRST against the replica to learn the model's real structure
 * before committing the demo's placement/coloring approach. Answers:
 *   - which ECClasses/categories exist, and counts (are there discrete ITS asset elements?)
 *   - what UserLabel / CodeValue conventions exist (can we join asset_tag to elements?)
 *   - spatial extents + geolocation (does EPSG:32617 calibration make sense?)
 *
 * Usage: open the app, then in the browser console run:  await __acsDiscovery()
 * (it is also called once automatically and logged on first iModel connect in dev).
 *--------------------------------------------------------------------------------------------*/
import type { IModelConnection } from "@itwin/core-frontend";
import { QueryRowFormat } from "@itwin/core-common";

async function rows(iModel: IModelConnection, ecsql: string): Promise<any[]> {
  const out: any[] = [];
  try {
    const reader = iModel.createQueryReader(ecsql, undefined, {
      rowFormat: QueryRowFormat.UseJsPropertyNames,
    });
    for await (const row of reader) out.push(row.toRow());
  } catch (e) {
    console.warn("[discovery] query failed:", ecsql, e);
  }
  return out;
}

export async function runDiscovery(iModel: IModelConnection): Promise<void> {
  console.group("%cACS I-595 — Phase-0 discovery", "font-weight:bold;color:#1b6ec2");

  console.log("iModelId:", iModel.iModelId, "iTwinId:", iModel.iTwinId);
  try {
    const e = iModel.projectExtents;
    console.log("projectExtents (spatial, meters):", {
      low: e.low.toJSON(),
      high: e.high.toJSON(),
      xLen: +(e.high.x - e.low.x).toFixed(1),
      yLen: +(e.high.y - e.low.y).toFixed(1),
    });
    console.log("isGeoLocated:", (iModel as { isGeoLocated?: boolean }).isGeoLocated);
  } catch {
    /* ignore */
  }

  const classCounts = await rows(
    iModel,
    "SELECT ec_classname(ECClassId) AS cls, COUNT(*) AS n FROM bis.GeometricElement3d GROUP BY ECClassId ORDER BY n DESC"
  );
  console.log("%cGeometricElement3d classes (discrete 3D elements):", "font-weight:bold");
  console.table(classCounts);
  // One copyable line (easy to paste back) summarising the load-bearing fact:
  console.log(
    "%c[discovery-summary] COPY THIS LINE → ",
    "font-weight:bold;color:#2f8fe0",
    classCounts.length
      ? `GeometricElement3d classes: ${classCounts
          .map((r: { cls?: string; n?: number }) => `${r.cls}=${r.n}`)
          .join(", ")}`
      : "GeometricElement3d: NONE — ITS assets are NOT discrete elements (markers are correct)."
  );
  if (classCounts.length === 0)
    console.warn(
      "No GeometricElement3d rows — the ITS assets are almost certainly NOT discrete elements. " +
        "Stay on marker placement (PLACEMENT_MODE='extents'). This is expected."
    );

  console.log("%cSpatial categories:", "font-weight:bold");
  console.table(
    await rows(iModel, "SELECT CodeValue AS category FROM bis.SpatialCategory ORDER BY CodeValue")
  );

  console.log(
    "%cSample UserLabel / CodeValue (can we join asset_tag to elements?):",
    "font-weight:bold"
  );
  console.table(
    await rows(
      iModel,
      "SELECT ECInstanceId AS id, UserLabel AS label, CodeValue AS code FROM bis.GeometricElement3d WHERE UserLabel IS NOT NULL OR CodeValue IS NOT NULL LIMIT 40"
    )
  );

  console.log("%cModels:", "font-weight:bold");
  console.table(
    await rows(
      iModel,
      "SELECT ec_classname(ECClassId) AS cls, COUNT(*) AS n FROM bis.Model GROUP BY ECClassId ORDER BY n DESC"
    )
  );

  console.groupEnd();
}
