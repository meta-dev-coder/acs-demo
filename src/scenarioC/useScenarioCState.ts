/*---------------------------------------------------------------------------------------------
 * React hook for Scenario C store — useSyncExternalStore wrapper.
 * Kept separate from storeC.ts so storeC.ts stays free of React/DOM imports (node-env safe).
 *--------------------------------------------------------------------------------------------*/
import { useSyncExternalStore } from "react";
import { storeC, type StateC } from "./storeC";

export function useScenarioCState(): StateC {
  return useSyncExternalStore(
    storeC.subscribe.bind(storeC),
    storeC.getSnapshot.bind(storeC),
    storeC.getSnapshot.bind(storeC)
  );
}
