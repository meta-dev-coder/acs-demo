/**
 * Search and filtering for the Building Explorer. Pure, like the road filters, and the same shape
 * so the two explorers behave identically.
 */
import { buildingLabel } from './buildingModel.js';

export const HEIGHT_FILTER = Object.freeze({ ANY: 'ANY', WITH: 'WITH', WITHOUT: 'WITHOUT' });
export const HEIGHT_LABELS = Object.freeze({
  [HEIGHT_FILTER.ANY]: 'Any height',
  [HEIGHT_FILTER.WITH]: 'Has height',
  [HEIGHT_FILTER.WITHOUT]: 'No height',
});

/** Always a boolean: the height term alone would yield `undefined` when no height filter is set. */
export const isFiltered = ({ query, year, type, height }) => Boolean(
  query?.trim() || year || type || (height && height !== HEIGHT_FILTER.ANY));

/**
 * Search over OBJECTID, UNIQUEID and GlobalID, case-insensitive.
 *
 * An all-digit term matches an OBJECTID exactly rather than as a substring — the same rule the
 * road explorer uses, and for the same reason: typing an id should find that record, not the
 * hundreds whose ids happen to contain those digits.
 */
export function matchesQuery(building, rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;

  if (/^\d+$/.test(query)) {
    // A bare number is an identifier, so it is matched as one: the OBJECTID, or the building
    // number at the end of a UNIQUEID like "D3_MDC_Building_10817". Both exactly.
    //
    // Substring matching here is actively unhelpful. GlobalID is a hex UUID, so every digit
    // appears in thousands of them, and a loose UNIQUEID match puts "6" in front of 1,504
    // buildings. Someone typing a number wants that record, not a quarter of the dataset.
    if (String(building.objectId) === query) return true;
    return building.uniqueId.split('_').pop().toLowerCase() === query;
  }

  if (building.uniqueId.toLowerCase().includes(query)) return true;
  if (building.globalId.toLowerCase().includes(query)) return true;
  return buildingLabel(building).toLowerCase().includes(query);
}

export function filterBuildings(buildings, { query = '', year = '', type = '', height = HEIGHT_FILTER.ANY } = {}) {
  return buildings.filter(building => {
    if (year && String(building.yearUpdate ?? '') !== year) return false;
    if (type && building.type !== type) return false;
    if (height === HEIGHT_FILTER.WITH && building.height === null) return false;
    if (height === HEIGHT_FILTER.WITHOUT && building.height !== null) return false;
    return matchesQuery(building, query);
  });
}

/**
 * List order: an exact OBJECTID match first, then curated assets, then by OBJECTID. Stable,
 * because the list is windowed and rows must not move under the scroll position.
 */
export function sortBuildings(buildings, query = '') {
  const exactId = /^\d+$/.test(query.trim()) ? Number(query.trim()) : null;
  return [...buildings].sort((a, b) => {
    if (exactId !== null) {
      const aExact = a.objectId === exactId, bExact = b.objectId === exactId;
      if (aExact !== bExact) return aExact ? -1 : 1;
    }
    if (Boolean(a.asset) !== Boolean(b.asset)) return a.asset ? -1 : 1;
    return a.objectId - b.objectId;
  });
}
