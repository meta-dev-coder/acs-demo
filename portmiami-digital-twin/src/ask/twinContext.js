/**
 * The Twin Context: what the operator is looking at, in one object.
 *
 * This is a READING of the application's existing state, never a second copy of it. The app
 * already has exactly one selection (`{kind, id}` in App.jsx, plus the infrastructure registry's
 * own `selectedAssetId`), one set of layer toggles and one camera. This module reads those and
 * flattens them into the shape the tools and the optional model consume. Nothing here can change
 * a selection, so the panel can never disagree with the map about what is selected.
 *
 * The camera is read HERE, at ask time, from the viewer ref — deliberately not subscribed to.
 * App.jsx notes that nothing subscribes to the camera so that panning re-renders no React, and an
 * assistant panel is not a reason to give that up.
 */
import { representativePoint } from '../infrastructure/assetModel.js';

/**
 * Radians to degrees, done here rather than imported.
 *
 * This module deliberately imports nothing from Cesium: it reads plain numbers off the viewer
 * (`camera.positionCartographic` is already a Cartographic, and a view rectangle is four radian
 * fields), which keeps the context buildable — and testable — without loading the engine.
 */
const DEGREES = radians => (radians * 180) / Math.PI;

/** The camera's own position, in degrees and metres. Null when there is no live viewer. */
export function readCamera(viewer) {
  if (!viewer || viewer.isDestroyed?.()) return null;
  const carto = viewer.camera?.positionCartographic;
  if (!carto || !Number.isFinite(carto.longitude)) return null;
  return {
    latitude: Number(DEGREES(carto.latitude).toFixed(6)),
    longitude: Number(DEGREES(carto.longitude).toFixed(6)),
    height: Math.round(carto.height),
  };
}

/**
 * What the camera can currently see, as a lon/lat box.
 *
 * A null is passed on rather than replaced with a guess, and the tools treat a missing box as
 * "no view filter" instead of inventing one.
 */
export function readViewBounds(viewer) {
  if (!viewer || viewer.isDestroyed?.()) return null;
  const rectangle = viewer.camera?.computeViewRectangle?.(viewer.scene?.globe?.ellipsoid);
  // Null when the horizon is in shot — an oblique view over a port often is.
  if (!rectangle || !Number.isFinite(rectangle.west)) return null;
  return {
    west: Number(DEGREES(rectangle.west).toFixed(6)),
    south: Number(DEGREES(rectangle.south).toFixed(6)),
    east: Number(DEGREES(rectangle.east).toFixed(6)),
    north: Number(DEGREES(rectangle.north).toFixed(6)),
  };
}

/** Which layers are drawn, by the names the layer rail uses. */
function readLayers({ roads, buildings, infra, traffic }) {
  const visible = [];
  if (roads?.visible) visible.push('ROAD_NETWORK');
  if (buildings?.visible) visible.push('BUILDINGS');
  if (infra?.selected) visible.push('INFRASTRUCTURE_MARKER');
  for (const [key, on] of Object.entries(traffic?.layers ?? {})) if (on) visible.push(`TRAFFIC_${key}`);
  return visible;
}

/**
 * When each source was last known good, so an answer can say how old its data is.
 * The live payloads carry their own freshness; the GIS files are static and say so.
 */
function readTimestamps({ traffic, roads, buildings }) {
  // `lastSuccessfulUpdate` is when the SERVER last got data out of FL511 — the age of the data,
  // not the age of this page's last request. `dataFreshness.ageSeconds` goes with it.
  const stamp = payload => payload?.lastSuccessfulUpdate ?? null;
  const out = {};
  if (stamp(traffic?.eventsPayload)) out.fl511Events = stamp(traffic.eventsPayload);
  if (stamp(traffic?.camerasPayload)) out.fl511Cameras = stamp(traffic.camerasPayload);
  if (stamp(traffic?.signsPayload)) out.fl511MessageSigns = stamp(traffic.signsPayload);
  if (roads?.segments?.length) out.roadNetwork = 'static extract loaded in this session';
  if (buildings?.buildings?.length) out.buildings = 'static extract loaded in this session';
  return out;
}

/**
 * Build the context.
 *
 * @param {object} state  the live hooks and the one shared selection, exactly as App holds them
 * @returns {object} the context, plus `resolved`: the selected records themselves, so a tool does
 *                   not have to look them up again from ids it was just handed.
 */
export function buildTwinContext({
  selection, infra, roads, buildings, traffic, explorer, viewer, buildingsById,
}) {
  const selectedAsset = infra?.selected ?? null;
  const selectedRoadObjectId = selection?.kind === 'road' ? selection.id : null;
  const selectedBuildingObjectId = selection?.kind === 'building' ? selection.id : null;

  const where = selectedAsset
    ? representativePoint(selectedAsset, infra.linksFor(selectedAsset.id), buildingsById)
    : null;

  return {
    selectedAssetId: selectedAsset?.id ?? null,
    selectedBuildingObjectId,
    selectedRoadObjectId,
    selectedTrafficEventId: selection?.kind === 'traffic-event' ? selection.id : null,
    selectedCameraId: selection?.kind === 'traffic-camera' ? selection.id : null,
    selectedMessageSignId: selection?.kind === 'traffic-sign' ? selection.id : null,

    visibleLayers: readLayers({ roads, buildings, infra, traffic }),
    cameraPosition: readCamera(viewer),
    currentMapBounds: readViewBounds(viewer),
    activeWorkspace: explorer ?? 'NONE',
    dataTimestamps: readTimestamps({ traffic, roads, buildings }),

    /** The records themselves. Not part of the published shape; convenience for the tool layer. */
    resolved: {
      asset: selectedAsset,
      assetPoint: where?.point ?? null,
      assetPointStatus: where?.status ?? null,
      road: selectedRoadObjectId != null
        ? roads?.segments?.find(s => s.objectId === selectedRoadObjectId) ?? null : null,
      building: selectedBuildingObjectId != null
        ? buildingsById?.get(selectedBuildingObjectId) ?? null : null,
    },
  };
}

/**
 * Everything currently selected, for the line that tells the operator what "this" will mean.
 *
 * All of them, not the first: an asset and a road can be selected at once, and in that state
 * "this road" and "this terminal" resolve to different records. Showing only one would promise a
 * resolution the session does not actually make.
 */
export function describeContext(context) {
  const { resolved } = context ?? {};
  const found = [];
  if (resolved?.asset) found.push({ kind: 'asset', label: resolved.asset.name });
  if (resolved?.road) found.push({ kind: 'road', label: resolved.road.name || `Unnamed road · ${resolved.road.objectId}` });
  if (resolved?.building) found.push({ kind: 'building', label: `Building · ID ${resolved.building.objectId}` });
  if (context?.selectedCameraId) found.push({ kind: 'camera', label: `FL511 camera ${context.selectedCameraId}` });
  if (context?.selectedTrafficEventId) found.push({ kind: 'event', label: 'the selected traffic event' });
  if (context?.selectedMessageSignId) found.push({ kind: 'sign', label: 'the selected message sign' });
  return found;
}
