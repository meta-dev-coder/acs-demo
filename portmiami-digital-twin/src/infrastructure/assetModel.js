/**
 * Assets, resolved against the loaded GIS.
 *
 * Takes the static registry (src/config/infrastructure.js) plus the road and building records that
 * are already in memory, and produces the asset as the UI sees it: a derived location where the
 * address geocodes, candidate links, and whatever the reviewer has confirmed.
 *
 * Pure: no React, no Cesium, no storage. The hook feeds it and the components read it.
 */
import { ASSET_CATEGORIES, ASSET_SOURCES, INFRASTRUCTURE_ASSETS } from '../config/infrastructure.js';
import { geocodeAddress } from './assetGeocode.js';
import { buildingCandidates, roadCandidates } from './assetCandidates.js';
import { frontageFootprint } from './assetFrontage.js';
import { buildingLink, LINK_STATUS, MATCH_METHODS, roadLink } from './assetLinks.js';

export const categoryOf = id => ASSET_CATEGORIES.find(category => category.id === id) ?? null;
export const categoryLabel = id => categoryOf(id)?.label ?? id;
export const groupOf = id => categoryOf(id)?.group ?? 'OTHER';
export const sourceById = id => ASSET_SOURCES[id] ?? null;

/** The registry ids, for the store's integrity check. */
export const assetIds = () => new Set(INFRASTRUCTURE_ASSETS.map(asset => asset.id));

/**
 * Resolve every asset against the GIS.
 *
 * @param {object} options
 * @param {import('../roads/roadModel.js').RoadSegment[]} options.segments
 * @param {import('../buildings/buildingModel.js').Building[]} options.buildings
 */
export function resolveAssets({ segments, buildings }) {
  const ready = segments.length > 0 && buildings.length > 0;
  return INFRASTRUCTURE_ASSETS.map(asset => {
    const geocode = asset.attributes.address && segments.length > 0
      ? geocodeAddress(asset.attributes.address, segments)
      : null;

    // A derived location is the ONLY way an asset gets a position in this build. It is the street
    // frontage for the address, not the building, and it is labelled DERIVED everywhere it shows.
    const location = geocode?.matched
      ? {
        status: 'DERIVED',
        longitude: geocode.point[0],
        latitude: geocode.point[1],
        basis: geocode.reason,
      }
      : asset.location;

    const point = location.longitude != null ? [location.longitude, location.latitude] : null;

    // Which footprint the address fronts onto, when the asset is a structure at all and the walk
    // off the addressed side of the street reaches one. The street point stays the asset's
    // `point` — geocoding, candidates and evidence are all claims about the ADDRESS — and the
    // frontage is carried alongside it, for the map marker to stand on. Null is the normal case
    // for a surface lot, for an unbuilt terminal, and wherever the ray finds nothing.
    const frontage = ready && asset.attributes.structure === 'BUILDING'
      ? frontageFootprint(geocode, segments, buildings)
      : null;

    return {
      ...asset,
      location,
      point,
      frontage,
      group: groupOf(asset.category),
      geocode,
      candidates: ready && point
        ? {
          buildings: buildingCandidates(point, buildings),
          roads: roadCandidates(point, segments),
        }
        : { buildings: [], roads: [] },
    };
  });
}

/**
 * The links this build proposes before anyone has reviewed anything.
 *
 * Two kinds, and the difference matters:
 *   - ADDRESS_RANGE: the asset's verified street address falls inside that road segment's own
 *     address range in the county file. Strong evidence — and still a candidate.
 *   - GIS_ROAD_NAME: the asset records the road's name in the GIS (the tunnel and the bridge).
 *
 * Proximity alone proposes NO link. Nearby footprints and nearby roads are offered in the UI as
 * things to look at, not as links waiting to be rubber-stamped.
 */
export function proposedLinks(assets) {
  const roadLinks = [];
  for (const asset of assets) {
    if (asset.geocode?.matched) {
      roadLinks.push(roadLink({
        assetId: asset.id,
        roadObjectId: asset.geocode.roadObjectId,
        relationship: 'DIRECT_ACCESS',
        status: LINK_STATUS.CANDIDATE,
        matchMethod: MATCH_METHODS.ADDRESS_RANGE,
        evidence: asset.geocode.reason,
        id: `proposed-road-${asset.id}-${asset.geocode.roadObjectId}`,
      }));
    }
  }
  return { buildingLinks: [], roadLinks };
}

/** Index links by asset id, keeping proposals behind anything a reviewer has stored. */
export function linksByAsset(stored, proposed) {
  const index = new Map();
  const add = (link, key) => {
    const entry = index.get(link.assetId) ?? { buildingLinks: [], roadLinks: [] };
    entry[key].push(link);
    index.set(link.assetId, entry);
  };
  for (const link of stored.buildingLinks) add(link, 'buildingLinks');
  for (const link of stored.roadLinks) add(link, 'roadLinks');
  // A proposal is dropped once a stored link covers the same pair: the reviewer's word wins.
  const storedRoadPairs = new Set(stored.roadLinks.map(l => `${l.assetId}:${l.roadObjectId}`));
  for (const link of proposed.roadLinks) {
    if (!storedRoadPairs.has(`${link.assetId}:${link.roadObjectId}`)) add(link, 'roadLinks');
  }
  return index;
}

export const linksFor = (index, assetId) => index.get(assetId) ?? { buildingLinks: [], roadLinks: [] };

const confirmed = links => links.filter(link => link.status === LINK_STATUS.CONFIRMED);

/** Everything the explorer and the data-quality report count. */
export function summariseAssets(assets, index) {
  let withBuilding = 0, withRoad = 0, candidateLinks = 0, confirmedLinks = 0, needsReview = 0, geocoded = 0;
  const byStatus = { VERIFIED: 0, PROVISIONAL: 0, UNVERIFIED: 0 };
  for (const asset of assets) {
    byStatus[asset.verificationStatus] = (byStatus[asset.verificationStatus] ?? 0) + 1;
    if (asset.geocode?.matched) geocoded += 1;
    const { buildingLinks, roadLinks } = linksFor(index, asset.id);
    if (confirmed(buildingLinks).length > 0) withBuilding += 1;
    if (confirmed(roadLinks).length > 0) withRoad += 1;
    for (const link of [...buildingLinks, ...roadLinks]) {
      if (link.status === LINK_STATUS.CANDIDATE) candidateLinks += 1;
      if (link.status === LINK_STATUS.CONFIRMED) confirmedLinks += 1;
      if (link.status === LINK_STATUS.NEEDS_REVIEW) needsReview += 1;
    }
  }
  return {
    total: assets.length,
    byStatus,
    geocoded,
    withoutLocation: assets.length - geocoded,
    withBuilding,
    withoutBuilding: assets.length - withBuilding,
    withRoad,
    withoutRoad: assets.length - withRoad,
    candidateLinks,
    confirmedLinks,
    needsReview,
  };
}

/** The asset a building is confirmed to belong to, or null. Used by the Building Details panel. */
export function assetForBuilding(assets, index, buildingObjectId) {
  for (const asset of assets) {
    const { buildingLinks } = linksFor(index, asset.id);
    const link = buildingLinks.find(
      l => l.buildingObjectId === buildingObjectId && l.status === LINK_STATUS.CONFIRMED);
    if (link) return { asset, link };
  }
  return null;
}

/** Create the link a reviewer makes by picking a footprint on the map. */
export const linkFromMapSelection = (assetId, buildingObjectId, relationship) => buildingLink({
  assetId,
  buildingObjectId,
  relationship,
  status: LINK_STATUS.CANDIDATE,
  matchMethod: MATCH_METHODS.MAP_SELECTION,
  evidence: `Footprint OBJECTID ${buildingObjectId} chosen on the map by a reviewer.`,
});

export { LINK_STATUS };

/**
 * The point that best represents an asset, and how it was arrived at.
 *
 * Three tiers, strongest first. Each is a different KIND of claim, and the `basis` string says
 * which, so a reader is never shown a coordinate without being told what produced it:
 *
 *   FOOTPRINT  the centroid of a footprint a reviewer CONFIRMED. The only tier derived from
 *              building geometry rather than from an address, and the only one that is about the
 *              building itself. With several confirmed footprints, the centroid of their combined
 *              extent — a terminal spanning two polygons has no single one to point at.
 *   FRONTAGE   the footprint the address fronts onto: the first building entered by a short walk
 *              perpendicular from the street point onto the SIDE the county address range states.
 *              Still a candidate rather than a confirmation — but it is on the structure, which is
 *              what someone asking "where is Garage K" is looking for.
 *   DERIVED    the geocoded street address. A point ON THE ROAD, interpolated into a block's
 *              address range; the facility stands back from it by an unknown distance.
 *   UNKNOWN    no confirmed footprint and no address that geocodes. There is no point, and none
 *              is invented.
 *
 * @param {object} asset           a resolved asset
 * @param {{buildingLinks: object[]}} links  that asset's links
 * @param {Map<number, object>} buildingsById
 */
export function representativePoint(asset, links, buildingsById) {
  const confirmed = (links?.buildingLinks ?? [])
    .filter(link => link.status === LINK_STATUS.CONFIRMED)
    .map(link => buildingsById?.get(link.buildingObjectId))
    .filter(building => building?.bounds);

  if (confirmed.length > 0) {
    // The combined extent of every confirmed footprint, so a two-polygon terminal is represented
    // between its parts rather than at whichever one happened to be linked first.
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const { bounds } of confirmed) {
      west = Math.min(west, bounds.west); south = Math.min(south, bounds.south);
      east = Math.max(east, bounds.east); north = Math.max(north, bounds.north);
    }
    return {
      point: [(west + east) / 2, (south + north) / 2],
      status: 'FOOTPRINT',
      basis: confirmed.length === 1
        ? `Centroid of confirmed building footprint OBJECTID ${confirmed[0].objectId}.`
        : `Centre of the combined extent of ${confirmed.length} confirmed footprints (OBJECTID ${confirmed.map(b => b.objectId).join(', ')}).`,
      buildingObjectIds: confirmed.map(building => building.objectId),
    };
  }

  if (asset?.frontage) {
    return {
      point: asset.frontage.point,
      status: 'FRONTAGE',
      basis: asset.frontage.reason,
      buildingObjectIds: [asset.frontage.objectId],
    };
  }

  if (asset?.point) {
    return {
      point: asset.point,
      status: 'DERIVED',
      basis: asset.location?.basis ?? 'Derived from the street address.',
      buildingObjectIds: [],
    };
  }
  return { point: null, status: 'UNKNOWN', basis: asset?.geocode?.reason ?? null, buildingObjectIds: [] };
}

/** How a representative point was arrived at, in words for a panel. */
export const POINT_STATUS_LABELS = Object.freeze({
  FOOTPRINT: 'From confirmed building footprint',
  FRONTAGE: 'On the footprint the address fronts onto',
  DERIVED: 'Derived from street address',
  UNKNOWN: 'No location established',
});
