/*---------------------------------------------------------------------------------------------
 * Small viewport helpers: frame an asset, and enforce the "no background map" hard constraint.
 *--------------------------------------------------------------------------------------------*/
import { IModelApp, type ScreenViewport } from "@itwin/core-frontend";
import { BaseMapLayerSettings, ColorDef, GlobeMode, RenderMode } from "@itwin/core-common";
import { Point3d, Range3d } from "@itwin/core-geometry";

/** Smoothly frame a world point (used when an asset marker is clicked). */
export function frameWorld(world: Point3d, halfSize = 90): void {
  const vp = IModelApp.viewManager.selectedView;
  if (!vp) return;
  const r = Range3d.createXYZXYZ(
    world.x - halfSize,
    world.y - halfSize,
    world.z - halfSize,
    world.x + halfSize,
    world.y + halfSize,
    world.z + halfSize
  );
  vp.zoomToVolume(r, { animateFrustumChange: true });
}

/**
 * Make the scene read like an operational twin:
 *  - aerial background map ON (geographic context around the reality mesh) — per user request,
 *    overriding the original "map off" constraint
 *  - smooth-shaded surfaces, no grid, hide construction/alignment linework clutter
 */
export function applyCleanDisplay(vp: ScreenViewport): void {
  vp.viewFlags = vp.viewFlags.copy({
    renderMode: RenderMode.SmoothShade,
    backgroundMap: true,
    grid: false,
    acsTriad: false,
    constructions: false, // hides construction-class design linework
    visibleEdges: true,
  });
  try {
    // KEY-FREE aerial base map (Esri World Imagery) — avoids the Bing key requirement.
    // Reality mesh + iModel render on top of this.
    vp.displayStyle.backgroundMapBase = BaseMapLayerSettings.fromJSON({
      formatId: "ArcGIS",
      url: "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer",
      name: "Esri World Imagery",
    });
    vp.displayStyle.changeBackgroundMapProps({ globeMode: GlobeMode.Plane, applyTerrain: false });
    vp.displayStyle.backgroundColor = ColorDef.fromString("#0b1622");
    console.log("[display] base map set to Esri World Imagery (key-free)");
  } catch (e) {
    console.warn("[display] background map setup failed:", e);
  }
  vp.invalidateRenderPlan();
}

/** Turn the background map OFF (kept for the minimalist variant). */
export function enforceNoBackgroundMap(vp: ScreenViewport): void {
  vp.viewFlags = vp.viewFlags.with("backgroundMap", false);
  vp.invalidateRenderPlan();
}
