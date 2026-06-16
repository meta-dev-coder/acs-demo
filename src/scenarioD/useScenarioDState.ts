/*---------------------------------------------------------------------------------------------
 * React hook for Scenario D store — useSyncExternalStore wrapper.
 * Kept separate from storeD.ts so storeD.ts stays free of React/DOM imports (node-env safe).
 *--------------------------------------------------------------------------------------------*/
import { useSyncExternalStore } from "react";
import { storeD, type StateD } from "./storeD";

export function useScenarioDState(): StateD {
  return useSyncExternalStore(
    storeD.subscribe.bind(storeD),
    storeD.getSnapshot.bind(storeD),
    storeD.getSnapshot.bind(storeD)
  );
}
