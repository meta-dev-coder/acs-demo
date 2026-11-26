/**
 * Select Area on the server: which of a model version's elements an area holds, resolved from the cached
 * elements (never from ids the page sends) through the placement the area was drawn on (the map's own
 * IFC → world transform). Used by POST /api/ifc-spatial/area and to scope area reports (api.mjs).
 */
import { facilityOutlines, namedZoneOf, resolveAreaMembership, selectionIdOf, validateAreaGeometry } from '../../src/ifcSpatial/areaQuery.js';
import { modelToLonLatFor, PLACEMENT_MODE } from '../../src/ifcSpatial/placement.js';

export class AreaError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * @param {object} o
 * @param {object[]} o.elements the version's elements (elements.json)
 * @param {object|null} o.georef the version's georeferenced placement (diagnostics.json → placement)
 * @param {object} o.placement a validated placement ({mode, lon, lat, heightOffset, headingDeg, scale})
 * @param {object} o.body {geometry, nearM?, zones?}
 * @param {string} o.key the version's cache key; fileName, versionNumber for the result
 */
export function resolveAreaFor({ elements, georef, placement, body, key, fileName = null, versionNumber = null }) {
  const area = validateAreaGeometry(body?.geometry);
  if (!area.ok) throw new AreaError('INVALID_AREA', area.message);
  if (placement.mode === PLACEMENT_MODE.GEOREFERENCED && georef?.mode !== PLACEMENT_MODE.GEOREFERENCED) throw new AreaError('INVALID_PLACEMENT', 'This version has no georeferencing to place the area with.');
  const nearM = Number.isFinite(Number(body?.nearM)) && Number(body.nearM) > 0 ? Math.min(Number(body.nearM), 5000) : null;
  const toLonLat = modelToLonLatFor(placement, georef, 0);
  const m = resolveAreaMembership({ elements, ring: area.ring, toLonLat, facilities: facilityOutlines(elements, toLonLat), nearM });
  const zones = (Array.isArray(body?.zones) ? body.zones : []).slice(0, 50).map(z => ({ name: String(z?.name ?? '').slice(0, 80), lon: Number(z?.lon), lat: Number(z?.lat) })).filter(z => z.name);
  return {
    selectionId: selectionIdOf(area.ring, key), key, fileName, versionNumber, coordinateSystem: 'EPSG:4326',
    geometry: { type: 'Polygon', coordinates: [[...area.ring, area.ring[0]]] }, areaM2: Math.round(area.areaM2), placementMode: placement.mode,
    zone: namedZoneOf(area.ring, zones), relations: m.relations,
    within: m.within, intersects: m.intersects, crosses: m.crosses, unknown: m.unknown, near: m.near, outside: m.outside, nearM,
    resolvedAt: new Date().toISOString(),
  };
}
