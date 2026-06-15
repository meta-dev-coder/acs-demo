/*---------------------------------------------------------------------------------------------
 * React hook for Presentation store — useSyncExternalStore wrapper.
 * Kept separate from presentationStore.ts so presentationStore.ts stays free of React/DOM imports.
 *--------------------------------------------------------------------------------------------*/
import { useSyncExternalStore } from "react";
import { presentationStore } from "./presentationStore";
import type { PresentationState } from "./presentationStore";

export function usePresentationState(): PresentationState {
  return useSyncExternalStore(
    presentationStore.subscribe.bind(presentationStore),
    presentationStore.getSnapshot.bind(presentationStore),
    presentationStore.getSnapshot.bind(presentationStore)
  );
}
