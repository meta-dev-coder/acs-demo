/**
 * Which asset type the explorer should browse, given the layers currently drawn.
 *
 * Kept out of the React entry point so it stays plain JS: this is the rule that decides what the
 * user sees when they toggle layers, and it deserves tests that do not need a DOM or a bundler.
 */
import { ASSET_TYPES } from './assetTypes.js';

/** Map Explorer layer id -> asset type, for the layers this explorer can browse. */
export const LAYER_TO_ASSET_TYPE = Object.freeze(
  Object.fromEntries(Object.values(ASSET_TYPES).map(config => [config.layerId, config.id])));

/**
 * A layer the user just switched on wins, because that is the thing they were reaching for. With no
 * new layer, an already-browsed type is kept — toggling other layers should not yank the explorer
 * between datasets.
 *
 * Several types can appear from one click: Incidents is the parent checkbox of the Live Events
 * group, so ticking it also ticks Closures underneath. Registry order then decides, which is why
 * ASSET_TYPES lists incident before closure — clicking Incidents must show Incidents, and show its
 * own empty message when the corridor has none, rather than quietly switching to Closures.
 */
export function nextExplorerType(visibleTypes, previousTypes, current) {
  const appeared = visibleTypes.filter(type => !previousTypes.includes(type));
  if (appeared.length) return appeared[0];
  if (current && visibleTypes.includes(current)) return current;
  return visibleTypes[0] ?? null;
}
