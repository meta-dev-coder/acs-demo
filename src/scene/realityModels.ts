/*---------------------------------------------------------------------------------------------
 * Attach BST409's Bentley-hosted (ContextShare) reality meshes read-only to the viewport, to
 * give the demo a PHOTOREAL base instead of CAD linework. Display-only: the customer's data is
 * never modified, and these context models live on the in-memory display style (re-attach each
 * time the view is created). EPSG:32617-georeferenced, so they align with the iModel + markers.
 *--------------------------------------------------------------------------------------------*/
import {
  RealityDataFormat,
  RealityDataProvider,
  type ContextRealityModelProps,
  type RealityDataSourceKey,
} from "@itwin/core-common";
import {
  type ContextRealityModelState,
  type ScreenViewport,
} from "@itwin/core-frontend";
import { Range3d } from "@itwin/core-geometry";

/** The iTwin that OWNS the reality data (the customer BST409 project; different from our copy
 * iModel's iTwin). Configurable via env so it isn't hard-coded in source. */
const BST409_ITWIN_ID =
  import.meta.env.IMJS_REALITY_ITWIN_ID ?? "51d743bf-661b-4d14-99be-c4a4ca838ad2";

interface RealityModelSpec {
  id: string;
  name: string;
}

/** Photoreal terrain + corridor mesh. (Orthophoto tiles could be added the same way.) */
const REALITY_MODELS: RealityModelSpec[] = [
  { id: "8b81e01b-9ffc-4520-b8a7-29146b0f928b", name: "Existing Ground (reality mesh)" },
  {
    id: "c233bdfa-0976-4855-91bc-5402dc4e5618",
    name: "I-595 Corridor (reality mesh)",
  },
];

export function attachRealityModels(vp: ScreenViewport): ContextRealityModelState[] {
  const style = vp.displayStyle;
  const attached: ContextRealityModelState[] = [];
  for (const m of REALITY_MODELS) {
    const rdSourceKey: RealityDataSourceKey = {
      provider: RealityDataProvider.ContextShare,
      format: RealityDataFormat.ThreeDTile,
      id: m.id,
      iTwinId: BST409_ITWIN_ID,
    };
    const props: ContextRealityModelProps = { tilesetUrl: "", rdSourceKey, name: m.name };
    try {
      attached.push(style.attachRealityModel(props));
    } catch (e) {
      console.warn(`[reality] failed to attach ${m.name}:`, e);
    }
  }
  vp.invalidateScene();
  return attached;
}

/**
 * Wait for the reality models' tile trees to stream in, then return their union world range
 * (also used to choose a marker elevation and to frame the camera). Resolves a null range on
 * timeout.
 */
export async function getRealityRange(
  models: ContextRealityModelState[],
  timeoutMs = 25000
): Promise<Range3d> {
  const start = Date.now();
  const union = Range3d.createNull();
  for (;;) {
    union.setNull();
    let allReady = models.length > 0;
    for (const model of models) {
      const r = model.treeRef.computeWorldContentRange();
      if (r.isNull) {
        allReady = false;
        break;
      }
      union.extendRange(r);
    }
    if (allReady && !union.isNull) return union;
    if (Date.now() - start > timeoutMs) return union;
    await new Promise((res) => setTimeout(res, 200));
  }
}
