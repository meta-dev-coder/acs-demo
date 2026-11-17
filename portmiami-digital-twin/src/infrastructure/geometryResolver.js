/**
 * One resolver: "which footprint belongs to this asset, and how firm is that claim?"
 *
 * Used by the planner, the garage highlight, the proposed massing and the details panels, so
 * those four cannot drift apart. It returns the geometry AND the metadata describing why that
 * geometry won, because a shape on a map with no provenance is the thing this project keeps
 * refusing to draw.
 *
 * PRIORITY — a lower tier can never displace a higher one:
 *
 *   1 AUTHORITATIVE   geometry explicitly recorded as official GIS for this asset
 *   2 USER_CONFIRMED  a reviewer-confirmed building footprint (BUILDING_GEOJSON)
 *   3 USER_CONFIRMED  a reviewer-confirmed traced outline (MANUALLY_DIGITIZED)
 *   4 CANDIDATE       the footprint the asset's address fronts onto — evidence only
 *
 * The candidate tier exists to show a reviewer where to look. For Garage A it is the TERMINAL's
 * polygon, because Garage A and Cruise Terminal A share the published address 2000 N Cruise Blvd;
 * it is drawn in amber, it is never confirmed automatically, and the moment any confirmed record
 * exists it stops being used.
 */
import { LINK_STATUS } from './assetLinks.js';

export const GEOMETRY_TIER = Object.freeze({
  AUTHORITATIVE: 'AUTHORITATIVE',
  CONFIRMED_GIS: 'CONFIRMED_GIS',
  CONFIRMED_TRACED: 'CONFIRMED_TRACED',
  CANDIDATE: 'CANDIDATE',
  NONE: 'NONE',
});

export const TIER_LABEL = Object.freeze({
  AUTHORITATIVE: 'Authoritative GIS geometry',
  CONFIRMED_GIS: 'Confirmed building footprint',
  CONFIRMED_TRACED: 'Confirmed traced outline — user-defined, not a survey',
  CANDIDATE: 'Unconfirmed candidate — evidence only',
  NONE: 'No footprint',
});

/** Server rows -> the records the Cesium layers take (`rings`, `bounds`, `groundAreaM2`). */
export function asFootprints(row) {
  if (!row?.geometry) return [];
  const parts = row.geometry.type === 'Polygon'
    ? [row.geometry.coordinates]
    : (row.geometry.coordinates ?? []);
  return parts.filter(part => part?.[0]?.length >= 4).map((rings, index) => {
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
    for (const [lon, lat] of rings[0]) {
      west = Math.min(west, lon); east = Math.max(east, lon);
      south = Math.min(south, lat); north = Math.max(north, lat);
    }
    return {
      objectId: row.buildingObjectIds?.[index] ?? null,
      shapeId: `${row.id}:${index}`,
      rings,
      groundAreaM2: parts.length === 1 ? row.areaM2 : null,
      partCount: 1,
      geometryType: 'Polygon',
      bounds: { west, south, east, north },
      centroid: [(west + east) / 2, (south + north) / 2],
    };
  });
}

const tierOf = row => {
  if (!row) return GEOMETRY_TIER.NONE;
  if (row.verificationStatus === 'AUTHORITATIVE') return GEOMETRY_TIER.AUTHORITATIVE;
  if (row.verificationStatus === 'USER_CONFIRMED') {
    return row.geometrySource === 'MANUALLY_DIGITIZED'
      ? GEOMETRY_TIER.CONFIRMED_TRACED : GEOMETRY_TIER.CONFIRMED_GIS;
  }
  return GEOMETRY_TIER.CANDIDATE;
};

/**
 * Resolve one asset's geometry.
 *
 * @param {object} input
 * @param {object|null} input.serverGeometry  `{geometries, active}` from the geometry service
 * @param {object|null} input.asset           the resolved registry asset (for its frontage candidate)
 * @param {Function} input.linksFor           the reviewer's links, for confirmed GIS footprints
 * @param {Map} input.buildingsById
 * @returns {{tier, footprints, geometrySource, verificationStatus, areaM2, geometryAvailable,
 *            reason, row, candidate}}
 */
export function resolveAssetGeometry({ assetId, serverGeometry, asset, linksFor, buildingsById }) {
  const none = {
    assetId,
    tier: GEOMETRY_TIER.NONE,
    footprints: [],
    geometrySource: null,
    verificationStatus: null,
    areaM2: null,
    geometryAvailable: false,
    row: null,
    candidate: null,
  };
  if (!assetId) return { ...none, reason: 'No asset selected.' };

  // 1 & 3: whatever the server says is active for this asset.
  const active = serverGeometry?.active ?? null;
  if (active && active.verificationStatus !== 'CANDIDATE') {
    const footprints = asFootprints(active);
    if (footprints.length) {
      const tier = tierOf(active);
      return {
        assetId,
        tier,
        footprints,
        geometrySource: active.geometrySource,
        verificationStatus: active.verificationStatus,
        areaM2: active.areaM2 ?? null,
        heightM: active.heightM ?? null,
        heightSource: active.heightSource ?? null,
        buildingObjectIds: active.buildingObjectIds ?? [],
        updatedAt: active.updatedAt ?? null,
        geometryAvailable: true,
        row: active,
        candidate: null,
        reason: `${TIER_LABEL[tier]}, stored on the server.`,
      };
    }
  }

  // 2: a reviewer-confirmed building link, which lives in the link store rather than the geometry
  // store — the registry's own review workflow, unchanged.
  const confirmed = (linksFor?.(assetId)?.buildingLinks ?? [])
    .filter(link => link.status === LINK_STATUS.CONFIRMED)
    .map(link => buildingsById?.get(link.buildingObjectId))
    .filter(building => building?.rings?.length);
  if (confirmed.length) {
    return {
      assetId,
      tier: GEOMETRY_TIER.CONFIRMED_GIS,
      footprints: confirmed,
      geometrySource: 'BUILDING_GEOJSON',
      verificationStatus: 'USER_CONFIRMED',
      areaM2: Math.round(confirmed.reduce((total, b) => total + (b.groundAreaM2 ?? 0), 0)),
      buildingObjectIds: confirmed.map(b => b.objectId),
      geometryAvailable: true,
      row: null,
      candidate: null,
      reason: `${confirmed.length} confirmed building footprint(s) linked in the registry.`,
    };
  }

  // 4: the address-frontage candidate. Shown, never confirmed on its own.
  const candidate = asset?.frontage ? buildingsById?.get(asset.frontage.objectId) ?? null : null;
  if (candidate?.rings?.length) {
    return {
      assetId,
      tier: GEOMETRY_TIER.CANDIDATE,
      footprints: [candidate],
      geometrySource: 'BUILDING_GEOJSON',
      verificationStatus: 'CANDIDATE',
      areaM2: Math.round(candidate.groundAreaM2 ?? 0),
      buildingObjectIds: [candidate.objectId],
      geometryAvailable: false,
      row: null,
      candidate,
      reason: `No confirmed footprint. OBJECTID ${candidate.objectId} is the footprint this `
        + 'asset’s address fronts onto — evidence, not a confirmation.',
    };
  }

  return { ...none, reason: 'No confirmed footprint and no candidate for this asset.' };
}
