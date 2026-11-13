/**
 * Search and filtering for the Road Network Explorer. Pure functions over the segment records —
 * they return a new array and never touch the records or the source GeoJSON.
 */
import { displayName } from './roadModel.js';

export const GROUPS = Object.freeze({ ALL: 'ALL', PORT: 'PORT', SURROUNDING: 'SURROUNDING' });
export const GROUP_LABELS = Object.freeze({
  [GROUPS.ALL]: 'All roads',
  [GROUPS.PORT]: 'Port access',
  [GROUPS.SURROUNDING]: 'Surrounding',
});

/** Any filter active? Used to decide whether "showing all" or "showing N of M". */
/** Always a boolean: the group term alone would yield `undefined` when no group is set. */
export const isFiltered = ({ query, group, classCode, municipality }) => Boolean(
  query?.trim() || (group && group !== GROUPS.ALL) || classCode || municipality);

/**
 * Match a segment against a search term. Case-insensitive, and an all-digit term also matches an
 * OBJECTID exactly — so "35" finds OBJECTID 35, not the 400 roads with a 35 somewhere in them,
 * while still matching any name containing "35".
 */
export function matchesQuery(segment, rawQuery) {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  if (String(segment.objectId) === query) return true;
  if (displayName(segment).toLowerCase().includes(query)) return true;
  return segment.globalId.toLowerCase().includes(query);
}

/**
 * @param {import('./roadModel.js').RoadSegment[]} segments
 * @param {{query?: string, group?: string, classCode?: string, municipality?: string}} filters
 */
export function filterRoads(segments, { query = '', group = GROUPS.ALL, classCode = '', municipality = '' } = {}) {
  return segments.filter(segment => {
    if (group === GROUPS.PORT && !segment.isPortAccess) return false;
    if (group === GROUPS.SURROUNDING && segment.isPortAccess) return false;
    if (classCode && segment.classCode !== classCode) return false;
    if (municipality && segment.municipality !== municipality) return false;
    return matchesQuery(segment, query);
  });
}

/**
 * List order: an exact OBJECTID match first, then port access, then by name, then by OBJECTID.
 * A stable order matters because the list is windowed — rows must not move under the scroll
 * position between renders.
 *
 * The exact-ID rule earns its place: searching "35" also matches the twenty-odd roads with "35"
 * in their names, and sorting port access first buried OBJECTID 35 below the fold of a windowed
 * list. Someone who types a bare number wants that segment, so it goes to the top.
 */
export function sortRoads(segments, query = '') {
  const exactId = /^\d+$/.test(query.trim()) ? Number(query.trim()) : null;
  return [...segments].sort((a, b) => {
    if (exactId !== null) {
      const aExact = a.objectId === exactId, bExact = b.objectId === exactId;
      if (aExact !== bExact) return aExact ? -1 : 1;
    }
    if (a.isPortAccess !== b.isPortAccess) return a.isPortAccess ? -1 : 1;
    const byName = displayName(a).localeCompare(displayName(b), 'en', { numeric: true });
    return byName !== 0 ? byName : a.objectId - b.objectId;
  });
}
