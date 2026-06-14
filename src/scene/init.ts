/*---------------------------------------------------------------------------------------------
 * Scene orchestration shared by both scenarios. onIModelConnected scores the synthetic data;
 * configureViewport applies the clean display, attaches the photoreal reality mesh, places both
 * scenarios' overlays at real coordinates, frames the corridor, and keeps decorations live as
 * the store changes.
 *--------------------------------------------------------------------------------------------*/
import {
  FitViewTool,
  IModelApp,
  type IModelConnection,
  type ScreenViewport,
} from "@itwin/core-frontend";
import { applyCleanDisplay } from "../scenarioA/viewportUtils";
import { attachRealityModels, getRealityRange } from "./realityModels";
import { markerZLevel } from "./place";
import { scoreAssetsIntoStore, placeAndDecorateA } from "../scenarioA/manager";
import {
  scoreSegmentsIntoStore,
  placeAndDecorateB,
  getBDecorator,
} from "../scenarioB/manager";
import { store } from "../scenarioA/store";

export function onIModelConnected(iModel: IModelConnection): void {
  scoreAssetsIntoStore(iModel);
  scoreSegmentsIntoStore();
}

let liveWired = false;

export function configureViewport(vp: ScreenViewport): void {
  applyCleanDisplay(vp);

  // Ensure scoring has run (in case configureViewport fires before onIModelConnected).
  if (store.getSnapshot().assets.length === 0) scoreAssetsIntoStore(vp.iModel);
  if (store.getSnapshot().segments.length === 0) scoreSegmentsIntoStore();

  void (async () => {
    try {
      const models = attachRealityModels(vp);
      console.log(`[reality] attached ${models.length} reality model(s); waiting for tiles…`);
      const range = await getRealityRange(models);
      if (range.isNull)
        console.warn(
          "[reality] tile range still NULL — mesh did not load (likely auth scope / 401 on tile fetch, or still streaming). Check Network tab for reality-data 401s."
        );
      else console.log("[reality] mesh loaded; world range:", range.low.toJSON(), range.high.toJSON());

      const markerZ = markerZLevel(vp.iModel, range);
      const segmentZ = !range.isNull
        ? range.low.z + (range.high.z - range.low.z) * 0.15
        : vp.iModel.projectExtents.low.z + 5;

      await placeAndDecorateA(vp, markerZ);
      await placeAndDecorateB(vp, segmentZ);

      if (!range.isNull) vp.zoomToVolume(range);
      else void IModelApp.tools.run(FitViewTool.toolId, vp, true, false);
    } catch (e) {
      console.warn("[scene] configure failed; fitting view:", e);
      void IModelApp.tools.run(FitViewTool.toolId, vp, true, false);
    }

    // Keep decorations in sync with store changes (selection, package, treated, scenario).
    if (!liveWired) {
      liveWired = true;
      store.subscribe(() => {
        const v = IModelApp.viewManager.selectedView;
        v?.invalidateDecorations();
        getBDecorator()?.invalidate();
      });
    }
  })();
}
