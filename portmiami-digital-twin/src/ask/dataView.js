/**
 * The data view: one object holding everything the tools may read.
 *
 * It is assembled from what the application has ALREADY loaded — the same `assets` array the
 * Infrastructure explorer lists, the same segments the road layer draws, the same FL511 payloads
 * the poller holds. Nothing here fetches, parses or caches a second copy, so an answer can never
 * describe a different dataset from the one on screen.
 *
 * It is also the whole surface the tools have. A tool cannot reach the network, the DOM or Cesium,
 * because none of those is in here.
 */
import { distanceMetres } from '../infrastructure/assetGeocode.js';
import { anchorFor } from './tools.js';

export function createDataView({ assets, segments, buildings, roadsById, buildingsById, linksFor, traffic }) {
  const view = {
    assets: assets ?? [],
    segments: segments ?? [],
    buildings: buildings ?? [],
    roadsById: roadsById ?? new Map((segments ?? []).map(s => [s.objectId, s])),
    buildingsById: buildingsById ?? new Map((buildings ?? []).map(b => [b.objectId, b])),
    linksFor: linksFor ?? (() => ({ buildingLinks: [], roadLinks: [] })),
    traffic: traffic ?? {
      events: [], cameras: [], signs: [],
      eventsById: new Map(), camerasById: new Map(), signsById: new Map(),
      eventsPayload: null, camerasPayload: null, signsPayload: null,
    },
    distanceMetres,
  };
  /** An asset's position and the tier that produced it, bound to this view. */
  view.anchorFor = asset => anchorFor(view, asset);
  return view;
}

/** Is there enough loaded to answer anything at all? */
export const viewReady = view =>
  Boolean(view?.assets?.length && view?.segments?.length && view?.buildings?.length);
