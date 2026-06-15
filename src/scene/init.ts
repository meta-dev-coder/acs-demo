/*---------------------------------------------------------------------------------------------
 * Scene orchestration shared by both scenarios. onIModelConnected scores the synthetic data;
 * configureViewport applies the clean display, places both scenarios' overlays snapped to the
 * real road geometry, frames the corridor tightly (so markers de-cluster), and attaches the
 * photoreal reality mesh in the background (non-blocking).
 *--------------------------------------------------------------------------------------------*/
import {
  FitViewTool,
  IModelApp,
  type IModelConnection,
  type ScreenViewport,
  StandardViewId,
} from "@itwin/core-frontend";
import { Range3d } from "@itwin/core-geometry";
import { applyCleanDisplay } from "../scenarioA/viewportUtils";
import { attachRealityModels, getRealityRange } from "./realityModels";
import { scoreAssetsIntoStore, placeAndDecorateA } from "../scenarioA/manager";
import {
  scoreSegmentsIntoStore,
  placeAndDecorateB,
  getBDecorator,
} from "../scenarioB/manager";
import { placeAndDecorateC, teardownC } from "../scenarioC/managerC";
import { registerReDecorate, store, type Scenario } from "../scenarioA/store";

export function onIModelConnected(iModel: IModelConnection): void {
  scoreAssetsIntoStore(iModel);
  scoreSegmentsIntoStore();
}

let liveWired = false;
/** The viewport last configured — used to re-place overlays when the active dataset changes. */
let activeVp: ScreenViewport | undefined;

/** Re-run the existing placement pipeline for one scenario against the store's current data,
 *  then re-frame on the new overlays. Called by the store when a CSV source is swapped in. */
async function reDecorate(scenario: Scenario): Promise<void> {
  const vp = activeVp ?? IModelApp.viewManager.selectedView ?? undefined;
  if (!vp) return;
  try {
    if (scenario === "A") await placeAndDecorateA(vp);
    else if (scenario === "B") await placeAndDecorateB(vp);
    else await placeAndDecorateC(vp);
    reframeOnActiveData(vp, scenario);
  } catch (e) {
    console.warn("[scene] re-decorate after data change failed:", e);
  }
}

/** Frame the corridor on the active scenario's freshly-placed overlays (top-down), clamped to the
 *  model extents so a stray placement can never throw the camera off-corridor. */
function reframeOnActiveData(vp: ScreenViewport, scenario: Scenario): void {
  const snap = store.getSnapshot();
  const focus =
    scenario === "A"
      ? [...snap.worldByTag.values()]
      : [...snap.segmentMidById.values()];
  const pe = vp.iModel.projectExtents;
  let frame: Range3d | undefined;
  if (focus.length > 0) {
    frame = Range3d.createArray(focus);
    if (!pe.isNull) {
      frame.low.x = Math.max(frame.low.x, pe.low.x);
      frame.low.y = Math.max(frame.low.y, pe.low.y);
      frame.low.z = Math.max(frame.low.z, pe.low.z);
      frame.high.x = Math.min(frame.high.x, pe.high.x);
      frame.high.y = Math.min(frame.high.y, pe.high.y);
      frame.high.z = Math.min(frame.high.z, pe.high.z);
      if (frame.isNull || frame.low.x > frame.high.x || frame.low.y > frame.high.y)
        frame = pe.clone();
    }
  } else if (!pe.isNull) {
    frame = pe.clone();
  }
  vp.view.setStandardRotation(StandardViewId.Top);
  if (frame && !frame.isNull) {
    frame.expandInPlace(140);
    vp.zoomToVolume(frame, { animateFrustumChange: true });
  }
}

export function configureViewport(vp: ScreenViewport): void {
  applyCleanDisplay(vp);
  activeVp = vp;
  // Let the store trigger a re-place + re-frame when the active dataset (CSV source) changes.
  registerReDecorate((scenario) => void reDecorate(scenario));

  if (store.getSnapshot().assets.length === 0) scoreAssetsIntoStore(vp.iModel);
  if (store.getSnapshot().segments.length === 0) scoreSegmentsIntoStore();

  void (async () => {
    try {
      // 1) Place overlays on the real road + frame on them FIRST (fast — no waiting on tiles).
      await placeAndDecorateA(vp);
      await placeAndDecorateB(vp);
      await placeAndDecorateC(vp);

      const snap = store.getSnapshot();
      // Frame the whole corridor top-down as the start view: western assets spread out as distinct
      // pins, only the genuinely co-located interchange devices remain grouped.
      const focus = [...snap.worldByTag.values()];
      const margin = 140;

      const pe = vp.iModel.projectExtents;
      let frame: Range3d | undefined;
      if (focus.length > 0) {
        frame = Range3d.createArray(focus);
        // Clamp into the model's own bounds so a single stray placement can never fling the
        // camera out to the globe — the camera stays on the corridor no matter what.
        if (!pe.isNull) {
          frame.low.x = Math.max(frame.low.x, pe.low.x);
          frame.low.y = Math.max(frame.low.y, pe.low.y);
          frame.low.z = Math.max(frame.low.z, pe.low.z);
          frame.high.x = Math.min(frame.high.x, pe.high.x);
          frame.high.y = Math.min(frame.high.y, pe.high.y);
          frame.high.z = Math.min(frame.high.z, pe.high.z);
          if (frame.isNull || frame.low.x > frame.high.x || frame.low.y > frame.high.y)
            frame = pe.clone();
        }
      } else if (!pe.isNull) {
        frame = pe.clone();
      }
      // Start from a clean TOP-DOWN (plan) view — clearest for reading asset/segment positions.
      vp.view.setStandardRotation(StandardViewId.Top);
      if (frame && !frame.isNull) {
        frame.expandInPlace(margin); // meters of margin around the focus
        vp.zoomToVolume(frame, { animateFrustumChange: false });
      } else {
        void IModelApp.tools.run(FitViewTool.toolId, vp, true, false);
      }
    } catch (e) {
      console.warn("[scene] place/frame failed; fitting view:", e);
      void IModelApp.tools.run(FitViewTool.toolId, vp, true, false);
    }

    // 2) Attach the photoreal reality mesh in the BACKGROUND (never blocks the camera).
    try {
      const models = await attachRealityModels(vp);
      void getRealityRange(models, 60000).then((range) => {
        if (range.isNull)
          console.warn(
            "[reality] mesh tiles didn't resolve — the Esri aerial basemap is serving as the photoreal layer."
          );
        else console.log("[reality] mesh loaded.");
      });
    } catch (e) {
      console.warn("[reality] attach failed:", e);
    }

    // 3) Keep decorations in sync with store changes (selection, package, treated, scenario).
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
