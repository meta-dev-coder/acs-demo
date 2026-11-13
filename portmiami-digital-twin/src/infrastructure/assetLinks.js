/**
 * The relationship model: which footprints and which roads belong to which asset.
 *
 * Kept apart from both the registry and the GIS. A link holds a stable internal `assetId` and a
 * GIS OBJECTID as a REFERENCE — never the other way round, so a GIS refresh can be checked against
 * the links rather than silently redefining them.
 */

export const BUILDING_RELATIONSHIPS = Object.freeze({
  PRIMARY_FOOTPRINT: 'Primary footprint',
  SECONDARY_FOOTPRINT: 'Secondary footprint',
  ASSOCIATED_STRUCTURE: 'Associated structure',
});

export const ROAD_RELATIONSHIPS = Object.freeze({
  DIRECT_ACCESS: 'Direct access',
  APPROACH_ROAD: 'Approach road',
  SERVICE_ACCESS: 'Service access',
  NEARBY_ROAD: 'Nearby road',
});

export const LINK_STATUS = Object.freeze({
  CANDIDATE: 'CANDIDATE',
  CONFIRMED: 'CONFIRMED',
  REJECTED: 'REJECTED',
  /** Set by the integrity check when the OBJECTID a link points at is no longer in the GIS. */
  NEEDS_REVIEW: 'NEEDS_REVIEW',
});

export const MATCH_METHODS = Object.freeze({
  ADDRESS_RANGE: 'ADDRESS_RANGE',
  DERIVED_POINT_PROXIMITY: 'DERIVED_POINT_PROXIMITY',
  MAP_SELECTION: 'MAP_SELECTION',
  GIS_ROAD_NAME: 'GIS_ROAD_NAME',
});

export const MATCH_METHOD_LABELS = Object.freeze({
  ADDRESS_RANGE: 'Address range in the county road file',
  DERIVED_POINT_PROXIMITY: 'Near the address-derived street point',
  MAP_SELECTION: 'Selected on the map by a reviewer',
  GIS_ROAD_NAME: 'Road name recorded on the asset',
});

let counter = 0;
/** A link id that is unique within a session and stable once stored. */
const newId = prefix => `${prefix}-${Date.now().toString(36)}-${(counter += 1).toString(36)}`;

export function buildingLink({ assetId, buildingObjectId, relationship = 'PRIMARY_FOOTPRINT',
  status = LINK_STATUS.CANDIDATE, matchMethod, evidence = null, reviewedAt = null, id = null }) {
  return {
    id: id ?? newId('bl'),
    assetId,
    buildingObjectId,
    relationship,
    status,
    matchMethod,
    evidence,
    reviewedAt,
  };
}

export function roadLink({ assetId, roadObjectId, relationship = 'NEARBY_ROAD',
  status = LINK_STATUS.CANDIDATE, matchMethod, evidence = null, reviewedAt = null, id = null }) {
  return {
    id: id ?? newId('rl'),
    assetId,
    roadObjectId,
    relationship,
    status,
    matchMethod,
    evidence,
    reviewedAt,
  };
}

/** A link is settled once a human has ruled on it. */
export const isReviewed = link => link.status === LINK_STATUS.CONFIRMED || link.status === LINK_STATUS.REJECTED;

/** One review event, for the history the Evidence tab shows. */
export const reviewEntry = ({ linkId, assetId, kind, objectId, from, to, note = null }) => ({
  id: newId('rv'),
  at: new Date().toISOString(),
  linkId, assetId, kind, objectId, from, to, note,
});
