/*---------------------------------------------------------------------------------------------
 * React hook for the Scenario A′ store — useSyncExternalStore wrapper.
 * Kept separate from storeAPrime.ts so storeAPrime.ts stays free of React/DOM imports
 * (node-env safe), same split as scenarioC/useScenarioCState.ts.
 *--------------------------------------------------------------------------------------------*/
import { useSyncExternalStore } from "react";
import { storeAPrime, type StateAPrime } from "./storeAPrime";

export function useScenarioAPrimeState(): StateAPrime {
  return useSyncExternalStore(
    storeAPrime.subscribe.bind(storeAPrime),
    storeAPrime.getSnapshot.bind(storeAPrime),
    storeAPrime.getSnapshot.bind(storeAPrime)
  );
}
