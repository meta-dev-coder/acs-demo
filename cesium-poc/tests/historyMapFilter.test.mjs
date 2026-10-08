/**
 * The History tab's map filters.
 *
 * They narrow what is DRAWN and nothing else. The thing worth proving is that a filter can never
 * reach the numbers above it: the counts, the concentration and the risk score are all computed
 * from the full matched set before any filter exists, so clicking a bar cannot change them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeHistoricalLocation, clusterMatchesByPlace, filteredMatches, HISTORY_FILTERS, matchesHistoryFilter,
} from '../src/tmc/historicalLocationSafety.js';

const AT = Date.parse('2026-06-01T21:00:00Z');   // 17:00 corridor time
const DAY = 86_400_000;
const CENTERLINE = Array.from({ length: 81 }, (_, i) => [-80.22 + i * 0.0005, 26.10]);
const east = metres => -80.20 + metres / (111_320 * Math.cos(26.10 * Math.PI / 180));

const record = ({ id, metresEast = 20, hour = 12, type = 'Rear-end crash', hosp = 'No', fatal = 'No', injury = 'No', weather = 'Clear' }) => {
  const at = new Date(AT - 10 * DAY);
  at.setUTCHours(hour + 4);
  return {
    id, type: 'INCIDENT', longitude: east(metresEast), latitude: 26.10, reportedAtMs: at.getTime(),
    sdna: { reported_at: new Date(at).toISOString() }, liveOps: {},
    raw: { attributes: { incident_type: type, hospitalizations: hosp, fatalities: fatal, injuries_y_n: injury, weather, root_cause_category: 'Driver behavior' } },
  };
};

const RECORDS = [
  record({ id: 'A', type: 'Rear-end crash', hour: 17, hosp: 'Yes', injury: 'Yes' }),
  record({ id: 'B', type: 'Rear-end crash', hour: 3, injury: 'Yes' }),
  record({ id: 'C', type: 'Sideswipe merge conflict', hour: 17, fatal: 'Yes', hosp: 'Yes', injury: 'Yes' }),
  record({ id: 'D', type: 'Sideswipe merge conflict', hour: 12 }),
  record({ id: 'E', type: 'Attenuator hit', hour: 8 }),
];

const analysis = analyzeHistoricalLocation({
  selectedIncident: { id: 'SEL', longitude: east(0), latitude: 26.10, reportedAtMs: AT, sdna: { reported_at: new Date(AT).toISOString() }, liveOps: {}, raw: { attributes: {} } },
  historicalCrashes: RECORDS, centerline: CENTERLINE,
});

const ids = filter => filteredMatches(analysis, filter).map(m => m.record.id).sort();

test('no filter shows everything', () => {
  assert.equal(analysis.totals.crashes, 5);
  assert.deepEqual(ids(null), ['A', 'B', 'C', 'D', 'E']);
  assert.deepEqual(ids({ type: null }), ['A', 'B', 'C', 'D', 'E']);
});

test('filtering by pattern shows only that pattern', () => {
  assert.deepEqual(ids({ type: HISTORY_FILTERS.TYPE, value: 'Rear-end crash' }), ['A', 'B']);
  assert.deepEqual(ids({ type: HISTORY_FILTERS.TYPE, value: 'Sideswipe merge conflict' }), ['C', 'D']);
  // A category nothing matches shows nothing, rather than silently showing everything.
  assert.deepEqual(ids({ type: HISTORY_FILTERS.TYPE, value: 'Not a category' }), []);
});

test('filtering by time bucket uses corridor local time', () => {
  // 17:00 corridor time is PM peak; 03:00 is overnight. Both are stored as UTC instants.
  assert.deepEqual(ids({ type: HISTORY_FILTERS.TIME, value: 'PM peak' }), ['A', 'C']);
  assert.deepEqual(ids({ type: HISTORY_FILTERS.TIME, value: 'Overnight' }), ['B']);
  assert.deepEqual(ids({ type: HISTORY_FILTERS.TIME, value: 'AM peak' }), ['E']);
});

test('severity filters are not mutually exclusive, and say so by overlapping', () => {
  assert.deepEqual(ids({ type: HISTORY_FILTERS.SEVERITY, value: 'fatal' }), ['C']);
  assert.deepEqual(ids({ type: HISTORY_FILTERS.SEVERITY, value: 'severe' }), ['A', 'C'], 'hospitalisation or fatality');
  assert.deepEqual(ids({ type: HISTORY_FILTERS.SEVERITY, value: 'injury' }), ['A', 'B', 'C']);
});

test('a filter never changes what was counted', () => {
  // The totals and the concentration come from the analysis, which knows nothing about filters.
  const before = JSON.stringify({ totals: analysis.totals, concentration: analysis.concentration, types: analysis.crashTypes });
  filteredMatches(analysis, { type: HISTORY_FILTERS.TYPE, value: 'Rear-end crash' });
  filteredMatches(analysis, { type: HISTORY_FILTERS.SEVERITY, value: 'fatal' });
  assert.equal(JSON.stringify({ totals: analysis.totals, concentration: analysis.concentration, types: analysis.crashTypes }), before);
});

test('a record missing the field a filter asks about is excluded, not assumed', () => {
  const vague = { id: 'V', type: 'INCIDENT', longitude: east(20), latitude: 26.10, reportedAtMs: null, sdna: {}, raw: { attributes: {} } };
  assert.equal(matchesHistoryFilter({ record: vague }, { type: HISTORY_FILTERS.TIME, value: 'PM peak' }), false);
  assert.equal(matchesHistoryFilter({ record: vague }, { type: HISTORY_FILTERS.TYPE, value: 'Rear-end crash' }), false);
  assert.equal(matchesHistoryFilter({ record: vague }, { type: HISTORY_FILTERS.SEVERITY, value: 'fatal' }), false);
});

test('clustering preserves the exact source count', () => {
  // Two records share one asset coordinate, one sits elsewhere.
  const places = clusterMatchesByPlace(analysis.matches);
  const total = places.reduce((sum, place) => sum + place.count, 0);
  assert.equal(total, analysis.totals.crashes, 'every record is in exactly one cluster');
  assert.ok(places.length <= analysis.matches.length);
});

test('a filtered map shows filtered counts, never the unfiltered ones', () => {
  // The bug this pins: clustering the full set and dimming the rest left a place holding several
  // records showing its FULL count while the panel beside it reported only the matching ones.
  const filter = { type: HISTORY_FILTERS.TYPE, value: 'Rear-end crash' };
  const matching = filteredMatches(analysis, filter);
  const places = clusterMatchesByPlace(matching);
  const drawn = places.reduce((sum, place) => sum + place.count, 0);
  assert.equal(drawn, matching.length, 'the numbers on the map add up to the number in the panel');
  assert.ok(drawn < analysis.totals.crashes, 'and it is fewer than the unfiltered total');

  // Clustering the WRONG set is what produced the contradiction.
  const wrong = clusterMatchesByPlace(analysis.matches).reduce((sum, place) => sum + place.count, 0);
  assert.notEqual(wrong, matching.length);
});

test('clusters are ordered west to east, so leader heights can alternate', () => {
  const places = clusterMatchesByPlace(analysis.matches);
  for (let i = 1; i < places.length; i += 1) {
    assert.ok(places[i].longitude >= places[i - 1].longitude, 'ascending longitude');
  }
});

test('a record with no usable position is left out rather than clustered at zero', () => {
  const broken = [{ record: { id: 'X', longitude: null, latitude: 26.1 } }, ...analysis.matches];
  assert.equal(clusterMatchesByPlace(broken).reduce((s, p) => s + p.count, 0), analysis.totals.crashes);
  assert.deepEqual(clusterMatchesByPlace(null), []);
});

test('an outcome filter actually filters, and an unknown one matches nothing', () => {
  // The bug: the UI passed the row LABEL ("Injury recorded") while the predicate expected "injury",
  // and the fallback returned true — so a severity filter silently kept all 31 of 31 records while
  // the row beside it said 21.
  assert.deepEqual(ids({ type: HISTORY_FILTERS.SEVERITY, value: 'injury' }), ['A', 'B', 'C']);
  assert.deepEqual(ids({ type: HISTORY_FILTERS.SEVERITY, value: 'Injury recorded' }), [],
    'a label is not a filter key, and must not fall through to matching everything');
  assert.deepEqual(ids({ type: HISTORY_FILTERS.SEVERITY, value: 'nonsense' }), []);
  // An unrecognised filter TYPE likewise matches nothing rather than everything.
  assert.deepEqual(ids({ type: 'not-a-filter', value: 'x' }), []);
});
