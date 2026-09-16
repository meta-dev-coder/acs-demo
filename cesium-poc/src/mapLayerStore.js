/**
 * The canonical view of which corridor layers are on.
 *
 * There is deliberately no second set of booleans here. Each layer's visibility already lives in
 * one place — the checkbox its own module owns and reacts to — so this is a facade over those
 * controls, not a copy of them. Setting a layer through the store does exactly what a click does:
 * tick the control and let the layer's own handler load and show its data. Reading a layer asks the
 * control. That is why the quick rail, the quick layers, a category view, a preset and the full
 * hierarchy can never disagree: they are all looking at, and writing to, the same control.
 *
 * Composite layers (Traffic Flow is the three mainline routes) resolve to `on`, `off` or `partial`.
 */

import { SIGN_STRUCTURE_TYPES } from './signStructureData.js';

/** @typedef {'on'|'off'|'partial'|'unavailable'} LayerState */

/**
 * Sign structures come from their own registry, so registering a new structure type gives it a
 * rail button, an explorer row and a count without touching the list below.
 */
const SIGN_STRUCTURE_LAYERS = SIGN_STRUCTURE_TYPES.map(type => Object.freeze({
  id: type.id, label: type.label, short: type.groupLabel, category: 'infrastructure',
  icon: type.icon, accent: type.accent, control: `#${type.control}`, count: type.id,
}));

/**
 * Every layer the corridor actually has. `members` makes a layer composite; `count` is read from
 * the owning module, and layers whose module exposes no count simply have none.
 */
export const CORRIDOR_LAYERS = Object.freeze([
  Object.freeze({ id: 'mainline-eb', label: 'I-595 Eastbound', short: 'Eastbound', category: 'roads', route: 'EB', control: '#i595_mainline_eb' }),
  Object.freeze({ id: 'mainline-wb', label: 'I-595 Westbound', short: 'Westbound', category: 'roads', route: 'WB', control: '#i595_mainline_wb' }),
  Object.freeze({ id: 'express', label: '595 Express', short: 'Express', category: 'roads', accent: '#ffba62', control: '#express-way' }),
  Object.freeze({ id: 'frontage', label: 'Frontage Roads', category: 'roads', control: '#frontage-all' }),
  Object.freeze({ id: 'ramps', label: 'Ramps & Connectors', category: 'roads', control: '#ramps-all' }),
  Object.freeze({ id: 'traffic-flow', label: 'Traffic Flow', category: 'traffic', icon: 'road', members: ['mainline-eb', 'mainline-wb', 'express'] }),
  Object.freeze({ id: 'direction', label: 'Direction', category: 'traffic', icon: 'direction', control: '#flow-direction' }),
  Object.freeze({ id: 'incidents', label: 'Incidents', category: 'traffic', icon: 'incident', control: '#live-events-all', count: 'incidents' }),
  Object.freeze({ id: 'closures', label: 'Closures', category: 'traffic', icon: 'closure', control: '#live-events-closure', count: 'closures' }),
  Object.freeze({ id: 'signals', label: 'Traffic Signals', category: 'infrastructure', icon: 'signal', control: '#signals-all', count: 'signals' }),
  // CCTV is two groups on the corridor — express-lane cameras on the gantries, and the mainline —
  // so the single tool folds them the way Traffic Flow folds its three routes.
  Object.freeze({ id: 'cameras-express', label: 'Express Lane Cameras', short: 'Express', category: 'infrastructure', control: '#cameras-express' }),
  Object.freeze({ id: 'cameras-mainline', label: 'Mainline Cameras', short: 'Mainline', category: 'infrastructure', control: '#cameras-mainline' }),
  Object.freeze({ id: 'cameras', label: 'Traffic Cameras', category: 'infrastructure', icon: 'camera', count: 'cameras', members: ['cameras-express', 'cameras-mainline'] }),
  Object.freeze({ id: 'structures', label: 'Bridges', category: 'infrastructure', icon: 'bridge', control: '#bridges-all', count: 'structures' }),
  Object.freeze({ id: 'gantries', label: 'Toll Gantries', category: 'infrastructure', icon: 'gantry', control: '#gantries-all', count: 'gantries' }),
  // A barrier arm is a different asset from an overhead gantry, so it is its own layer rather than
  // a sub-group of one.
  Object.freeze({ id: 'lane-barriers', label: 'Lane Barriers', category: 'infrastructure', icon: 'barrier', control: '#barriers-all', count: 'barriers' }),
  ...SIGN_STRUCTURE_LAYERS,
]);

/**
 * The tools on the quick rail — the one-click surface. Mile markers are absent because the corridor
 * has no such layer.
 */
export const RAIL_LAYER_IDS = Object.freeze(['traffic-flow', 'direction', 'incidents', 'closures', 'signals', 'cameras', 'structures',
  ...SIGN_STRUCTURE_LAYERS.map(layer => layer.id), 'gantries', 'lane-barriers']);

export const LAYER_CATEGORIES = Object.freeze([
  Object.freeze({ id: 'traffic', label: 'Traffic' }),
  Object.freeze({ id: 'roads', label: 'Roads' }),
  Object.freeze({ id: 'infrastructure', label: 'Infrastructure' }),
]);

/**
 * View presets. Each names the layers it turns on; every other listed layer goes off, so a preset
 * is a complete statement of the map rather than a set of nudges.
 */
export const MAP_VIEW_PRESETS = Object.freeze([
  Object.freeze({ id: 'traffic', label: 'Traffic', on: ['traffic-flow', 'direction', 'incidents', 'cameras'] }),
  Object.freeze({ id: 'operations', label: 'Operations', on: ['traffic-flow', 'direction', 'incidents', 'signals', 'cameras'] }),
  Object.freeze({ id: 'infrastructure', label: 'Infrastructure', on: ['traffic-flow', 'signals', 'cameras', 'structures'] }),
  Object.freeze({ id: 'clean', label: 'Clean', on: ['traffic-flow', 'direction'] }),
]);

/** Layers a preset governs — everything a preset could turn on or off. */
export const PRESET_SCOPE = Object.freeze([...new Set(MAP_VIEW_PRESETS.flatMap(preset => preset.on))]);

/**
 * Fold member states into a composite state. Pure, so the rule is testable on its own.
 * @param {LayerState[]} states
 * @returns {LayerState}
 */
export function combineStates(states) {
  const known = states.filter(state => state !== 'unavailable');
  if (!known.length) return 'unavailable';
  if (known.every(state => state === 'on')) return 'on';
  if (known.every(state => state === 'off')) return 'off';
  return 'partial';
}

/**
 * Which preset, if any, the given layer states correspond to. A user who changes one layer after
 * picking a preset is not forced back into it — the answer simply becomes null, and the caller
 * shows "Custom".
 * @param {(id: string) => LayerState} stateOf
 * @returns {string|null}
 */
export function matchingPreset(stateOf) {
  for (const preset of MAP_VIEW_PRESETS) {
    const matches = PRESET_SCOPE.every(id => {
      const state = stateOf(id);
      if (state === 'unavailable') return true;
      return preset.on.includes(id) ? state === 'on' : state === 'off';
    });
    if (matches) return preset.id;
  }
  return null;
}

/**
 * @param {{root?: ParentNode, counts?: Record<string, () => number|null|undefined>}} [options]
 */
export function createMapLayerStore({ root = document, counts = {} } = {}) {
  const byId = new Map(CORRIDOR_LAYERS.map(layer => [layer.id, layer]));
  const listeners = new Set();
  const control = layer => (layer.control ? root.querySelector(layer.control) : null);

  /** @returns {LayerState} */
  function stateOf(id) {
    const layer = byId.get(id);
    if (!layer) return 'unavailable';
    if (layer.members) return combineStates(layer.members.map(stateOf));
    const input = control(layer);
    if (!input) return 'unavailable';
    if (input.indeterminate) return 'partial';
    return input.checked ? 'on' : 'off';
  }

  /** True once the layer's own module has enabled its control. */
  const isReady = id => {
    const layer = byId.get(id);
    if (!layer) return false;
    if (layer.members) return layer.members.some(isReady);
    const input = control(layer);
    return !!input && !input.disabled;
  };

  async function setVisible(id, on) {
    const layer = byId.get(id);
    if (!layer) return;
    if (layer.members) {
      // Sequential on purpose: several of these load data, and the modules are not written to be
      // driven concurrently through the same handler.
      for (const member of layer.members) await setVisible(member, on);
      return;
    }
    const input = control(layer);
    if (!input || input.disabled) return;
    if (!input.indeterminate && input.checked === on) return;
    input.indeterminate = false;
    input.checked = on;
    // Exactly what a click does — the module's own handler owns the loading and the Cesium update.
    await input.onchange?.();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    notify();
  }

  const toggle = id => setVisible(id, stateOf(id) !== 'on');

  async function applyPreset(presetId) {
    const preset = MAP_VIEW_PRESETS.find(item => item.id === presetId);
    if (!preset) return;
    for (const id of PRESET_SCOPE) await setVisible(id, preset.on.includes(id));
    notify();
  }

  function countOf(id) {
    const layer = byId.get(id);
    const value = layer?.count ? counts[layer.count]?.() : undefined;
    return Number.isFinite(value) ? value : null;
  }

  /** Every notification re-baselines the poll, so a change cannot be announced and then forgotten. */
  function notify() {
    signature = currentSignature();
    for (const listener of listeners) listener();
  }

  // The layer modules also set their own checkboxes directly (a "select all" parent syncing its
  // children, a load finishing). `checked` is a property, not an attribute, so it cannot be
  // observed — a light poll of a handful of booleans keeps every surface honest without touching
  // Cesium or re-rendering anything that has not changed.
  //
  // `notify` re-reads the signature rather than leaving it to the poll. It used to be the poll's
  // job alone, which lost any change that was made and undone inside one 400 ms window: a direct
  // notify rendered the new state, the baseline still held the old one, and the next poll compared
  // the restored state against that stale baseline, saw no difference and stayed silent — leaving
  // every surface showing a layer as on after it had been switched off.
  const currentSignature = () =>
    CORRIDOR_LAYERS.map(layer => `${layer.id}:${stateOf(layer.id)}:${isReady(layer.id) ? 1 : 0}:${countOf(layer.id)}`).join('|');
  let signature = '';
  const tick = () => {
    if (currentSignature() === signature) return;
    notify();
  };
  const timer = setInterval(tick, 400);

  return {
    layers: CORRIDOR_LAYERS,
    categories: LAYER_CATEGORIES,
    presets: MAP_VIEW_PRESETS,
    get: byId.get.bind(byId),
    stateOf, isReady, setVisible, toggle, applyPreset, countOf,
    /** Which preset the map currently matches, or null once the user has customised it. */
    activePreset: () => matchingPreset(stateOf),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    destroy() { clearInterval(timer); listeners.clear(); },
  };
}
