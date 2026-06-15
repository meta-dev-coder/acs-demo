/*---------------------------------------------------------------------------------------------
 * React hook for Compare store — useSyncExternalStore wrapper.
 * Kept separate from compareStore.ts so compareStore.ts stays free of React/DOM imports.
 *--------------------------------------------------------------------------------------------*/
import { useSyncExternalStore } from "react";
import { compareStore } from "./compareStore";
import type { CompareState } from "./compareStore";

export function useCompareState(): CompareState {
  return useSyncExternalStore(
    compareStore.subscribe.bind(compareStore),
    compareStore.getSnapshot.bind(compareStore),
    compareStore.getSnapshot.bind(compareStore)
  );
}
