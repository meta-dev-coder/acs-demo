/**
 * The map action contract.
 *
 * Ask the Twin never touches Cesium. It emits typed actions from this file, each one checked
 * against the data actually loaded before it is allowed to leave the orchestrator, and the
 * dispatcher in App.jsx turns a valid action into a call on the EXISTING layer handles — the same
 * `flyTo`, `select` and `setEmphasis` the explorers already use. There is no generated JavaScript,
 * no free-form coordinate, and no second selection engine.
 *
 * Validation is the point. An id that is not in the loaded registry, road file, building extract
 * or current FL511 payload is dropped, and the answer says what it dropped. That holds whether the
 * id came from a deterministic tool (where it cannot be wrong) or from a model (where it can).
 */

export const ACTION = Object.freeze({
  FLY_TO_ASSET: 'FLY_TO_ASSET',
  OPEN_ASSET_DETAILS: 'OPEN_ASSET_DETAILS',
  SELECT_BUILDING: 'SELECT_BUILDING',
  SELECT_ROAD: 'SELECT_ROAD',
  SHOW_BUILDINGS: 'SHOW_BUILDINGS',
  SHOW_ROADS: 'SHOW_ROADS',
  SHOW_CAMERAS: 'SHOW_CAMERAS',
  SHOW_TRAFFIC_EVENTS: 'SHOW_TRAFFIC_EVENTS',
});

/** How many features one action may highlight. A hundred emphasised roads is not a highlight. */
export const MAX_ACTION_IDS = 25;

/** Trim a registry name to something that fits on a button. */
const shortLabel = name => {
  const text = String(name ?? '').split(/[\u2014\u2013]/)[0].trim();
  return text.length > 28 ? `${text.slice(0, 27)}\u2026` : text;
};

const ints = ids => [...new Set((Array.isArray(ids) ? ids : [])
  .map(Number).filter(Number.isInteger))].slice(0, MAX_ACTION_IDS);
const strings = ids => [...new Set((Array.isArray(ids) ? ids : [])
  .map(id => String(id ?? '').trim()).filter(Boolean))].slice(0, MAX_ACTION_IDS);

export const flyToAsset = assetId => ({ type: ACTION.FLY_TO_ASSET, assetId });
export const openAssetDetails = assetId => ({ type: ACTION.OPEN_ASSET_DETAILS, assetId });
export const selectBuilding = objectId => ({ type: ACTION.SELECT_BUILDING, objectId });
export const selectRoad = objectId => ({ type: ACTION.SELECT_ROAD, objectId });
export const showBuildings = objectIds => ({ type: ACTION.SHOW_BUILDINGS, objectIds: ints(objectIds) });
export const showRoads = objectIds => ({ type: ACTION.SHOW_ROADS, objectIds: ints(objectIds) });
export const showCameras = cameraIds => ({ type: ACTION.SHOW_CAMERAS, cameraIds: strings(cameraIds) });
export const showTrafficEvents = eventIds => ({ type: ACTION.SHOW_TRAFFIC_EVENTS, eventIds: strings(eventIds) });

/** A short label for the button that runs the action. */
export function actionLabel(action, { count } = {}) {
  switch (action?.type) {
    case ACTION.FLY_TO_ASSET: return 'View on map';
    case ACTION.OPEN_ASSET_DETAILS:
      return action.label ? `Open ${shortLabel(action.label)}` : 'Open in Infrastructure';
    case ACTION.SELECT_BUILDING: return 'Select building';
    case ACTION.SELECT_ROAD: return 'Select road';
    case ACTION.SHOW_BUILDINGS: return `Highlight ${count ?? action.objectIds.length} buildings`;
    case ACTION.SHOW_ROADS: return `Highlight ${count ?? action.objectIds.length} roads`;
    case ACTION.SHOW_CAMERAS: return `Show ${count ?? action.cameraIds.length} cameras`;
    case ACTION.SHOW_TRAFFIC_EVENTS: return `Show ${count ?? action.eventIds.length} events`;
    default: return 'Show on map';
  }
}

/**
 * Check one action against the loaded data.
 *
 * @returns {{ok: true, action: object}|{ok: false, reason: string}}
 */
export function validateAction(action, view) {
  const type = action?.type;
  if (!Object.values(ACTION).includes(type)) {
    return { ok: false, reason: `Unknown action type ${JSON.stringify(type)}.` };
  }

  const keepRoads = ids => ints(ids).filter(id => view.roadsById?.has(id));
  const keepBuildings = ids => ints(ids).filter(id => view.buildingsById?.has(id));
  const keepCameras = ids => strings(ids).filter(id => view.traffic?.camerasById?.has(id));
  const keepEvents = ids => strings(ids).filter(id => view.traffic?.eventsById?.has(id));

  switch (type) {
    case ACTION.FLY_TO_ASSET:
    case ACTION.OPEN_ASSET_DETAILS: {
      const asset = view.assets?.find(a => a.id === action.assetId);
      if (!asset) {
        return { ok: false, reason: `No asset ${JSON.stringify(action.assetId)} is in the registry.` };
      }
      // The button's name is read from the REGISTRY record here, never taken from the caller:
      // four buttons all reading "Open in Infrastructure" say nothing about which is which, and
      // a caller-supplied label would be one more string that has to be trusted.
      return { ok: true, action: { type, assetId: asset.id, label: asset.name } };
    }
    case ACTION.SELECT_ROAD: {
      const [objectId] = keepRoads([action.objectId]);
      return objectId == null
        ? { ok: false, reason: `Road ${action.objectId} is not in the loaded road file.` }
        : { ok: true, action: { type, objectId } };
    }
    case ACTION.SELECT_BUILDING: {
      const [objectId] = keepBuildings([action.objectId]);
      return objectId == null
        ? { ok: false, reason: `Building ${action.objectId} is not in the loaded footprint extract.` }
        : { ok: true, action: { type, objectId } };
    }
    case ACTION.SHOW_ROADS: {
      const objectIds = keepRoads(action.objectIds);
      return objectIds.length
        ? { ok: true, action: { type, objectIds } }
        : { ok: false, reason: 'None of those road ids are in the loaded road file.' };
    }
    case ACTION.SHOW_BUILDINGS: {
      const objectIds = keepBuildings(action.objectIds);
      return objectIds.length
        ? { ok: true, action: { type, objectIds } }
        : { ok: false, reason: 'None of those building ids are in the loaded footprint extract.' };
    }
    case ACTION.SHOW_CAMERAS: {
      const cameraIds = keepCameras(action.cameraIds);
      return cameraIds.length
        ? { ok: true, action: { type, cameraIds } }
        : { ok: false, reason: 'None of those camera ids are in the current FL511 camera list.' };
    }
    case ACTION.SHOW_TRAFFIC_EVENTS: {
      const eventIds = keepEvents(action.eventIds);
      return eventIds.length
        ? { ok: true, action: { type, eventIds } }
        : { ok: false, reason: 'None of those event ids are in the current FL511 event list.' };
    }
    default:
      return { ok: false, reason: `Unhandled action type ${type}.` };
  }
}

/** Validate a list, keeping what survives and reporting what did not. */
export function validateActions(actions, view) {
  const kept = [], dropped = [];
  for (const action of actions ?? []) {
    const result = validateAction(action, view);
    if (result.ok) kept.push(result.action); else dropped.push(result.reason);
  }
  return { actions: kept, dropped };
}
