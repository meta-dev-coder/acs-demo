/**
 * React's view of the framework-free selection store.
 *
 * useSyncExternalStore rather than an effect-plus-setState: the store is written to from Cesium
 * event handlers outside React's control, and this is the subscription React itself can tear.
 */
import { useSyncExternalStore } from 'react';

export function useAssetStore(store) {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
