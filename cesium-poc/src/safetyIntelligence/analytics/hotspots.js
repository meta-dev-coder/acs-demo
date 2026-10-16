/**
 * Where the register concentrates.
 *
 * Greedy radius clustering over the records' positions, seeded from the busiest point outward, so
 * a cluster is "these records are within R of each other" and nothing more. It is deliberately not
 * a kernel density, a hot-spot statistic or a crash-rate surface: those need exposure data and
 * surveyed coordinates, and this corpus has neither.
 *
 * The caveat that governs the whole module: a record's position is its damaged ASSET's position.
 * A concentration of records is therefore first a concentration of damaged assets, which is a
 * useful place to look and not a measured crash location. Every cluster carries that, plus how
 * many of its records have a police report behind them.
 */

const EARTH = 6_371_000;
const toRadians = degrees => (degrees * Math.PI) / 180;

/** Metres between two points. Fine at corridor scale. */
export function metresBetween(a, b) {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat = toRadians((a.latitude + b.latitude) / 2);
  const x = dLon * Math.cos(lat);
  return Math.hypot(x, dLat) * EARTH;
}

const positioned = fact => Number.isFinite(fact.longitude) && Number.isFinite(fact.latitude);

/**
 * Clusters of records within `radiusMeters` of a seed.
 *
 * @param {object[]} facts from incidentFacts()
 * @param {{radiusMeters?: number, minimumRecords?: number}} [options]
 */
export function findHotspots(facts = [], { radiusMeters = 250, minimumRecords = 3 } = {}) {
  const available = facts.filter(positioned);
  const remaining = new Set(available.map((_, index) => index));
  const neighbours = index => available
    .map((fact, other) => ({ other, distance: metresBetween(available[index], fact) }))
    .filter(entry => entry.distance <= radiusMeters && remaining.has(entry.other));

  const clusters = [];
  for (;;) {
    let best = null;
    for (const index of remaining) {
      const found = neighbours(index);
      if (!best || found.length > best.found.length) best = { index, found };
    }
    if (!best || best.found.length < minimumRecords) break;
    const members = best.found.map(entry => available[entry.other]);
    for (const entry of best.found) remaining.delete(entry.other);
    clusters.push(summarise(members, available[best.index], radiusMeters));
  }
  return Object.freeze({
    clusters: Object.freeze(clusters.sort((a, b) => b.records - a.records || b.severityIndex - a.severityIndex)),
    radiusMeters,
    minimumRecords,
    clustered: clusters.reduce((total, cluster) => total + cluster.records, 0),
    unclustered: remaining.size,
    located: available.length,
    withoutPosition: facts.length - available.length,
    /** Said once, where the clusters are shown, so a circle on the map cannot be read as a crash site. */
    caveat: 'A concentration of RECORDS at asset-derived positions. Several records on one damaged '
      + 'asset share a position exactly, so a cluster can be one location reported many times rather '
      + 'than a stretch of road. It is not surveyed crash geometry.',
  });
}

function summarise(members, seed, radiusMeters) {
  const confirmed = members.filter(fact => fact.confirmed).length;
  const severe = members.filter(fact => fact.severity.level !== 'PROPERTY_DAMAGE').length;
  const types = new Map();
  const causes = new Map();
  for (const fact of members) {
    types.set(fact.type, (types.get(fact.type) ?? 0) + 1);
    if (fact.rootCauseCategory) causes.set(fact.rootCauseCategory, (causes.get(fact.rootCauseCategory) ?? 0) + 1);
  }
  const top = map => [...map.entries()].sort((a, b) => b[1] - a[1])[0] ?? null;
  const segments = [...new Set(members.map(fact => fact.segmentName).filter(Boolean))];
  const centre = {
    longitude: members.reduce((sum, fact) => sum + fact.longitude, 0) / members.length,
    latitude: members.reduce((sum, fact) => sum + fact.latitude, 0) / members.length,
  };
  return Object.freeze({
    id: `HS-${seed.id ?? members[0].id}`,
    /**
     * What to call it on screen: the segment the register itself names, else the dominant type,
     * else nothing invented — a coordinate pair, which is at least true.
     */
    label: segments[0]
      ?? (top(types)?.[0] ? `${top(types)[0]} concentration` : null)
      ?? `${centre.latitude.toFixed(4)}, ${centre.longitude.toFixed(4)}`,
    /** How far apart the members actually are — a cluster can be much tighter than the radius. */
    spreadMeters: Number(Math.max(...members.map(fact => metresBetween(centre, fact)), 0).toFixed(0)) * 2,
    longitude: members.reduce((sum, fact) => sum + fact.longitude, 0) / members.length,
    latitude: members.reduce((sum, fact) => sum + fact.latitude, 0) / members.length,
    radiusMeters,
    records: members.length,
    facts: Object.freeze(members),
    severeRecords: severe,
    severityIndex: Number((members.reduce((sum, fact) => sum + fact.severity.rank, 0) / members.length).toFixed(2)),
    confirmedRecords: confirmed,
    /** Share of this cluster with a police report behind it — the cluster's own evidence strength. */
    confirmationRate: Number((confirmed / members.length).toFixed(2)),
    dominantType: top(types)?.[0] ?? null,
    dominantCause: top(causes)?.[0] ?? null,
    segments: Object.freeze(segments),
    firstMonth: members.map(fact => fact.when.monthKey).sort()[0],
    lastMonth: members.map(fact => fact.when.monthKey).sort().at(-1),
    locationBasis: 'Centroid of asset-derived record positions, not a surveyed crash location.',
  });
}

/** Records grouped by the segment name the register itself carries, where it carries one. */
export function segmentConcentration(facts = []) {
  const bySegment = new Map();
  for (const fact of facts) {
    if (!fact.segmentName) continue;
    const entry = bySegment.get(fact.segmentName) ?? { segment: fact.segmentName, facts: [] };
    entry.facts.push(fact);
    bySegment.set(fact.segmentName, entry);
  }
  return Object.freeze([...bySegment.values()]
    .map(entry => Object.freeze({
      segment: entry.segment,
      records: entry.facts.length,
      severeRecords: entry.facts.filter(fact => fact.severity.level !== 'PROPERTY_DAMAGE').length,
      facts: Object.freeze(entry.facts),
    }))
    .sort((a, b) => b.records - a.records));
}

/** How much of the register the segment view can speak for. */
export const segmentCoverage = (facts = []) => Object.freeze({
  withSegment: facts.filter(fact => fact.segmentName).length,
  total: facts.length,
  note: 'Only records that carry a segment name can be grouped this way; the rest are excluded from '
    + 'the segment view rather than assigned to a nearby one.',
});
