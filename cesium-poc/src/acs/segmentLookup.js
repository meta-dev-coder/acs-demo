/**
 * Which FDOT traffic segment a point sits on.
 *
 * This exists so the incident-context panel can show the ONE real traffic figure this corridor
 * publishes — the segment's annual average daily traffic — instead of the blank it showed before.
 * `createIncidentContextService` has always accepted a `segmentFor`, and nothing supplied one, so
 * `annualAverage()` reported "No FDOT segment with a published AADT was matched to this location"
 * on every case. That message was true and permanent, which is the worst kind of true.
 *
 * MATCHED GEOMETRICALLY, NOT BY MILEPOST. The segments carry `begin_post`/`end_post`, which are
 * FDOT mileposts, and the figure this screen already shows beside a case is a DERIVED corridor
 * mile measured along the centerline. They are two different measures of position and the card
 * goes out of its way to label the derived one as derived; matching one against the other would
 * quietly equate them. The nearest line wins instead, and only within a stated distance.
 */
import { distanceMetres } from './nearbyCrashes.js';

/** Beyond this, the nearest segment is not the road the incident is on. */
export const MAX_MATCH_M = 120;
const SOURCE = 'data/i595_fdot_traffic_segments.geojson';

/** Shortest distance from a point to a segment of a polyline, in metres. */
function distanceToLine(point, [aLon, aLat], [bLon, bLat]) {
  // Locally planar: over a 1 km segment at this latitude the error is far below the 120 m gate.
  const scale = Math.cos(point.latitude * Math.PI / 180);
  const px = (point.longitude - aLon) * scale;
  const py = point.latitude - aLat;
  const vx = (bLon - aLon) * scale;
  const vy = bLat - aLat;
  const lengthSq = vx * vx + vy * vy;
  // A degenerate "segment" of two identical points is just that point.
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, (px * vx + py * vy) / lengthSq));
  return distanceMetres(point, {
    longitude: aLon + (t * vx) / (scale || 1),
    latitude: aLat + t * vy,
  });
}

/** The nearest point on a whole LineString. */
function distanceToPath(point, coordinates) {
  let best = Infinity;
  for (let index = 1; index < coordinates.length; index += 1) {
    const metres = distanceToLine(point, coordinates[index - 1], coordinates[index]);
    if (metres != null && metres < best) best = metres;
  }
  return Number.isFinite(best) ? best : null;
}

/** The fields `annualAverage()` reads, and the two it needs to say where the figure came from. */
const shape = (feature, metres) => {
  const p = feature.properties ?? {};
  return Object.freeze({
    segmentId: p.segment_id ?? null,
    direction: p.direction ?? null,
    facility: p.facility ?? null,
    road: p.road ?? null,
    aadt: Number.isFinite(Number(p.aadt)) ? Number(p.aadt) : null,
    aadtYear: Number.isFinite(Number(p.aadt_year)) ? Number(p.aadt_year) : null,
    matchedWithinM: Math.round(metres),
    source: SOURCE,
  });
};

/**
 * A lookup over the published segment layer.
 *
 * @param {{fetchImpl?, url?, maxMatchM?}} [options]
 * @returns {{segmentFor: (point) => Promise<object|null>, ready: Promise<number>}}
 *   `segmentFor` takes anything carrying `longitude`/`latitude` — an incident record does.
 */
export function createSegmentLookup({ fetchImpl = globalThis.fetch, url = null,
  maxMatchM = MAX_MATCH_M } = {}) {
  /*
   * `import.meta.env.BASE_URL`, exactly as every other data file in this app is loaded.
   *
   * The first version built this from `document.baseURI`, which on this page is
   * "http://localhost:5188/?demo=i595" — QUERY STRING AND ALL — so the request went to
   * ".../?demo=i595data/i595_fdot_traffic_segments.geojson" and 404'd. The layer then looked
   * empty and the AADT stayed unavailable, which is indistinguishable from "no segment matched".
   * BASE_URL also keeps a sub-path deployment working, which baseURI would not have.
   */
  const base = String(import.meta.env?.BASE_URL ?? '/');
  const href = url ?? `${base}${base.endsWith('/') ? '' : '/'}${SOURCE}`;
  let features = null;
  const ready = (async () => {
    try {
      const response = await fetchImpl(href);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      features = (body?.features ?? []).filter(feature =>
        feature?.geometry?.type === 'LineString' && Array.isArray(feature.geometry.coordinates));
      return features.length;
    } catch {
      // A layer that will not load leaves the AADT unavailable, which is what it already was.
      features = [];
      return 0;
    }
  })();

  async function segmentFor(point) {
    if (!Number.isFinite(point?.longitude) || !Number.isFinite(point?.latitude)) return null;
    await ready;
    let best = null;
    for (const feature of features ?? []) {
      const metres = distanceToPath(point, feature.geometry.coordinates);
      if (metres == null) continue;
      if (!best || metres < best.metres) best = { feature, metres };
    }
    if (!best) return null;
    if (best.metres <= maxMatchM) return shape(best.feature, best.metres);
    /*
     * Near miss, reported as one.
     *
     * Several register rows carry a coordinate close to a kilometre off the mapped mainline —
     * INC-200022 is 998 m away — and attaching that segment's AADT to them would be claiming the
     * incident happened on a road we have no evidence it happened on. Returning the distance
     * instead lets the panel say WHY the figure is missing, so a reader can tell a coarse
     * coordinate from a missing layer.
     */
    return Object.freeze({
      segmentId: null, aadt: null, aadtYear: null, matchedWithinM: null,
      nearestSegmentId: best.feature.properties?.segment_id ?? null,
      nearestM: Math.round(best.metres),
      source: SOURCE,
      unmatchedReason: `The nearest FDOT segment with a published average `
        + `(${best.feature.properties?.segment_id ?? 'unknown'}) is `
        + `${Math.round(best.metres)} m from this incident's recorded coordinate — beyond the `
        + `${maxMatchM} m used to say an incident is ON a segment. The register's coordinate is `
        + 'too coarse here to attribute a segment average to it.',
    });
  }

  return { segmentFor, ready, get count() { return features?.length ?? 0; } };
}
