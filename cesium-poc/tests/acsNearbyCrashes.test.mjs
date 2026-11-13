/**
 * Accident history at a case's location.
 *
 * The register is real, so the tests are about the two ways a count like this misleads: counting
 * the case's own incident as its own history, and presenting exposure as risk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_RADIUS_M, boundsOf, crashesNear, distanceLabel, distanceMetres, summarise,
} from '../src/acs/nearbyCrashes.js';

/** A point on I-595, and crashes at known offsets from it. */
const HERE = { longitude: -80.2, latitude: 26.07 };
/** Offsets built on the SAME sphere the module measures with, so a 500 m offset is 500 m. */
const METRES_PER_DEGREE_LAT = 6_371_000 * (Math.PI / 180);
const north = (metres, extra = {}) => ({
  longitude: HERE.longitude, latitude: HERE.latitude + metres / METRES_PER_DEGREE_LAT, ...extra,
});

const crash = (id, metres, overrides = {}) => north(metres, {
  id, title: 'Vehicle collision', createdDate: '2025-03-04',
  segmentName: 'I-595 EB', description: null, assetId: null, assetType: null,
  related: { rootCause: null, laneClosure: 'N', injuries: 'N', fatalities: 0 },
  ...overrides,
});

test('distance is measured, not guessed', () => {
  assert.equal(Math.round(distanceMetres(HERE, north(500))), 500);
  assert.equal(distanceMetres(HERE, { longitude: null, latitude: 1 }), null);
});

test('only incidents inside the radius are counted, nearest first', () => {
  const found = crashesNear(HERE, [crash('A', 900), crash('B', 50), crash('C', 250)],
    { radiusM: 400 });
  assert.deepEqual(found.records.map(r => r.id), ['B', 'C']);
  assert.equal(found.total, 2);
  assert.equal(found.records[0].distanceM, 50);
});

test("the case's own incident is not reported back as its own history", () => {
  // A demo case borrows a real incident's coordinates, so that incident sits at distance zero.
  const all = [crash('INC-200051', 0), crash('OTHER', 80)];
  const found = crashesNear(HERE, all, { excludeIds: ['INC-200051'] });
  assert.deepEqual(found.records.map(r => r.id), ['OTHER']);
});

test('a case with no coordinates says so instead of counting nothing', () => {
  // "0 previous incidents" and "we do not know where this is" are different answers.
  const found = crashesNear({ longitude: null, latitude: null }, [crash('A', 10)]);
  assert.equal(found.available, false);
  assert.equal(found.total, undefined);
  assert.match(found.reason, /no located source incident/);
});

test('the register\'s "Y"/"N" strings become real flags', () => {
  const found = crashesNear(HERE, [
    crash('A', 10, { related: { injuries: 'Y', laneClosure: 'Y', fatalities: 2, rootCause: 'Speed' } }),
    crash('B', 20, { related: { injuries: 'N', laneClosure: 'n', fatalities: 0, rootCause: null } }),
  ]);
  const [a, b] = found.records;
  assert.equal(a.injuries, true);
  assert.equal(a.laneClosure, true);
  assert.equal(a.fatalities, 2);
  assert.equal(a.rootCause, 'Speed');
  assert.equal(b.injuries, false);
  assert.equal(b.laneClosure, false);
});

test('the aggregate counts harm, closures, types and years', () => {
  const found = crashesNear(HERE, [
    crash('A', 10, { title: 'Vehicle collision', createdDate: '2024-01-02',
      related: { injuries: 'Y', laneClosure: 'Y', fatalities: 1 } }),
    crash('B', 20, { title: 'Vehicle collision', createdDate: '2025-06-02',
      related: { injuries: 'N', laneClosure: 'Y', fatalities: 0 } }),
    crash('C', 30, { title: 'Debris', createdDate: '2025-07-02',
      related: { injuries: 'N', laneClosure: 'N', fatalities: 0 } }),
  ]);
  const stats = summarise(found);
  assert.equal(stats.total, 3);
  assert.equal(stats.withInjuries, 1);
  assert.equal(stats.fatalities, 1);
  assert.equal(stats.withLaneClosure, 2);
  assert.deepEqual(stats.byType, [{ key: 'Vehicle collision', count: 2 }, { key: 'Debris', count: 1 }]);
  assert.deepEqual(stats.byYear, [{ key: 2025, count: 2 }, { key: 2024, count: 1 }]);
  assert.equal(stats.earliestYear, 2024);
  assert.equal(stats.latestYear, 2025);
  assert.equal(stats.nearestM, 10);
});

test('the aggregate never reports a rate or a risk score', () => {
  // Counting crashes in a circle is exposure. Without volume per location it cannot become a
  // rate, and a score invented from it would be exactly the kind of number this app refuses.
  const stats = summarise(crashesNear(HERE, [crash('A', 10)]));
  for (const forbidden of ['rate', 'risk', 'score', 'perMillion', 'severityIndex']) {
    assert.ok(!(forbidden in stats), `${forbidden} must not be reported`);
  }
  assert.match(stats.caveat, /exposure, not a crash rate/);
});

test('an incident with no readable date still counts, without inventing a year', () => {
  const stats = summarise(crashesNear(HERE, [crash('A', 10, { createdDate: 'not a date' })]));
  assert.equal(stats.total, 1);
  assert.deepEqual(stats.byYear, []);
  assert.equal(stats.earliestYear, null);
});

test('distances read as a person would say them', () => {
  assert.equal(distanceLabel(240), '240 m away');
  assert.equal(distanceLabel(1400), '1.4 km away');
  assert.equal(distanceLabel(null), 'distance unknown');
});

test('the bounding box covers the radius it was asked for', () => {
  const box = boundsOf(HERE, DEFAULT_RADIUS_M);
  const northEdge = distanceMetres(HERE, { longitude: HERE.longitude, latitude: box.north });
  assert.ok(Math.abs(northEdge - DEFAULT_RADIUS_M) < 2, `${northEdge} ≈ ${DEFAULT_RADIUS_M}`);
  assert.equal(boundsOf({ longitude: null, latitude: null }, 100), null);
});

/* ── the FDOT segment lookup, which supplies the one real traffic figure ─────────────────── */

const { createSegmentLookup, MAX_MATCH_M } = await import('../src/acs/segmentLookup.js');

/** Two short EB segments with published averages, as the real layer shapes them. */
const LAYER = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: { segment_id: 'SEG-A', direction: 'EB', road: 'I-595',
      facility: 'general_purpose_mainline', aadt: 108000, aadt_year: 2025 },
    geometry: { type: 'LineString', coordinates: [[-80.30, 26.07], [-80.25, 26.07]] } },
    { type: 'Feature', properties: { segment_id: 'SEG-B', direction: 'EB', road: 'I-595',
      facility: 'general_purpose_mainline', aadt: 154256, aadt_year: 2025 },
    geometry: { type: 'LineString', coordinates: [[-80.25, 26.07], [-80.20, 26.07]] } },
    { type: 'Feature', properties: { segment_id: 'NOT-A-LINE' }, geometry: { type: 'Point', coordinates: [0, 0] } },
  ],
};
const layerFetch = () => Promise.resolve({ ok: true, json: async () => LAYER });

test('a point on the road matches its own segment, with the published average', async () => {
  const lookup = createSegmentLookup({ fetchImpl: layerFetch, url: 'x' });
  const segment = await lookup.segmentFor({ longitude: -80.22, latitude: 26.07 });
  assert.equal(segment.segmentId, 'SEG-B');
  assert.equal(segment.aadt, 154256);
  assert.equal(segment.aadtYear, 2025);
  assert.ok(segment.matchedWithinM <= 2, `${segment.matchedWithinM} m`);
});

test('the nearer of two adjoining segments wins', async () => {
  const lookup = createSegmentLookup({ fetchImpl: layerFetch, url: 'x' });
  assert.equal((await lookup.segmentFor({ longitude: -80.28, latitude: 26.07 })).segmentId, 'SEG-A');
});

test('a point off the road yields no AADT, and says how far the nearest segment was', async () => {
  // Without the gate, an incident on a frontage road would borrow the interstate's AADT. Several
  // real register rows sit ~1 km off the mapped mainline, so this is the common case, not an edge.
  const lookup = createSegmentLookup({ fetchImpl: layerFetch, url: 'x' });
  const far = await lookup.segmentFor({ longitude: -80.22, latitude: 26.09 });
  assert.equal(far.aadt, null, 'no average is borrowed from a road it is not on');
  assert.equal(far.segmentId, null);
  assert.ok(far.nearestM > MAX_MATCH_M, `${far.nearestM} m`);
  assert.match(far.unmatchedReason, /beyond the 120 m used to say an incident is ON a segment/);
});

test('a layer that will not load leaves the figure unavailable, it does not throw', async () => {
  const lookup = createSegmentLookup({ fetchImpl: async () => { throw new Error('offline'); }, url: 'x' });
  assert.equal(await lookup.segmentFor({ longitude: -80.22, latitude: 26.07 }), null);
  assert.equal(lookup.count, 0);
});

test('a non-LineString feature is skipped rather than crashing the match', async () => {
  const lookup = createSegmentLookup({ fetchImpl: layerFetch, url: 'x' });
  await lookup.ready;
  assert.equal(lookup.count, 2, 'the Point feature is not a segment');
});

test('the match gate is stated, not hidden', () => {
  assert.ok(Number.isFinite(MAX_MATCH_M) && MAX_MATCH_M > 0);
});

test('a matched segment turns the AADT row from unavailable into a real figure', async () => {
  const { annualAverage, DATA_QUALITY, OBSERVATION_SOURCE } =
    await import('../src/acs/incidentContext.js');
  const none = annualAverage(null);
  assert.equal(none.quality, DATA_QUALITY.UNAVAILABLE);

  const lookup = createSegmentLookup({ fetchImpl: layerFetch, url: 'x' });
  const real = annualAverage(await lookup.segmentFor({ longitude: -80.22, latitude: 26.07 }));
  assert.equal(real.value, 154256);
  // A published annual average is NOT a measurement at the incident hour, and says so.
  assert.equal(real.source, OBSERVATION_SOURCE.PUBLISHED_AVERAGE);
  assert.equal(real.synthetic, false);
  assert.match(real.note, /annual average over all days, not a measurement at the incident hour/);
});

/* ── the map pins ────────────────────────────────────────────────────────────────────────── */

test('a lone pin on the case\'s own coordinate is offset clear of the case marker', async () => {
  const { offsetFor } = await import('../src/maintenance/crashHistoryLayer.js');
  // One history pin PLUS the case marker is two things in one place: the fan has to move it.
  const shared = offsetFor(1, 2);
  assert.ok(Math.hypot(shared.x, shared.y) > 10, `moved ${Math.hypot(shared.x, shared.y)} px`);
  // A pin standing alone somewhere else is not overlapping anything and must not drift.
  const alone = offsetFor(0, 1);
  assert.equal(alone.x, 0);
  assert.equal(alone.y, 0);
});

test('a crowd on one coordinate fans wider than a pair, and every pin gets its own place',
  async () => {
    const { offsetFor } = await import('../src/maintenance/crashHistoryLayer.js');
    const spread = total => Math.hypot(offsetFor(1, total).x, offsetFor(1, total).y);
    assert.ok(spread(8) > spread(2), 'eight pins need a wider arc than two');
    const places = new Set();
    for (let index = 0; index < 8; index += 1) {
      const offset = offsetFor(index, 8);
      places.add(`${offset.x.toFixed(2)},${offset.y.toFixed(2)}`);
    }
    assert.equal(places.size, 8, 'no two pins land on the same spot');
  });
