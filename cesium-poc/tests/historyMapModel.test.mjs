/**
 * What the map draws for a location's history.
 *
 * Two things here are easy to get wrong and hard to notice. The first is the gap between records
 * and symbols: these positions are damaged-asset locations, so several records share a coordinate,
 * and a map showing 20 symbols beside a panel saying 31 looks broken unless it says so. The second
 * is the corridor ribbon, which must never become an EB/WB claim the data cannot support.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONCENTRATION_CONFIG, centerlineSlice, corridorConcentration, locationSummary, mappedLocations,
  PATTERN_FAMILIES, patternFamily,
} from '../src/tmc/historyMapModel.js';

const AT = Date.parse('2026-03-06T15:00:00Z');
const DAY = 86_400_000;
const east = metres => -80.20 + metres / (111_320 * Math.cos(26.10 * Math.PI / 180));
const CENTERLINE = Array.from({ length: 81 }, (_, i) => [-80.22 + i * 0.0005, 26.10]);

const match = ({ id, metresEast = 0, offsetDeg = 0, type = 'Sideswipe merge conflict',
  injury = 'No', hosp = 'No', fatal = 'No', circumstance = 'Driver behavior', days = 10 }) => ({
  record: {
    id, longitude: east(metresEast), latitude: 26.10 + offsetDeg, severity: 'Minor',
    raw: { attributes: { incident_type: type, injuries_y_n: injury, hospitalizations: hosp,
      fatalities: fatal, root_cause_category: circumstance, damaged_asset_id: 'S-1' } },
  },
  atMs: AT - days * DAY,
});

test('source incident types map to a small marker vocabulary, and nothing is invented', () => {
  assert.equal(patternFamily('Sideswipe merge conflict').id, PATTERN_FAMILIES.MERGE.id);
  assert.equal(patternFamily('Rear-end crash').id, PATTERN_FAMILIES.REAR_END.id);
  assert.equal(patternFamily('Pedestrian roadside exposure event').id, PATTERN_FAMILIES.PEDESTRIAN.id);
  assert.equal(patternFamily('Attenuator hit').id, PATTERN_FAMILIES.ASSET.id);
  assert.equal(patternFamily('Guardrail strike').id, PATTERN_FAMILIES.ASSET.id);
  assert.equal(patternFamily('Single vehicle rollover').id, PATTERN_FAMILIES.DEPARTURE.id);
  // Anything unrecognised is OTHER rather than forced into a family it does not belong to.
  assert.equal(patternFamily('Vehicle fire').id, PATTERN_FAMILIES.OTHER.id);
  assert.equal(patternFamily('').id, PATTERN_FAMILIES.OTHER.id);
  assert.equal(patternFamily(null).id, PATTERN_FAMILIES.OTHER.id);
});

test('records sharing an asset coordinate become one mapped location carrying the count', () => {
  const matches = [
    match({ id: 'A', metresEast: 50 }),
    match({ id: 'B', metresEast: 50 }),
    match({ id: 'C', metresEast: 50 }),
    match({ id: 'D', metresEast: 200 }),
  ];
  const locations = mappedLocations(matches);
  assert.equal(locations.length, 2, 'four records, two places');
  assert.deepEqual(locations.map(place => place.count).sort(), [1, 3]);
  const summary = locationSummary(matches, locations);
  assert.deepEqual(summary, { records: 4, mappedLocations: 2, sharing: 2 });
});

test('the summary is the line the map owes the operator', () => {
  // 31 records on 20 coordinates is the real shape of this data; the map has to say both numbers.
  const matches = Array.from({ length: 31 }, (_, i) => match({ id: `R${i}`, metresEast: 20 + (i % 20) * 10 }));
  const locations = mappedLocations(matches);
  const summary = locationSummary(matches, locations);
  assert.equal(summary.records, 31);
  assert.equal(summary.mappedLocations, 20);
  assert.equal(summary.sharing, 11, 'the records that share a coordinate with another');
});

test('a location reports its dominant pattern, or declares itself mixed', () => {
  const dominant = mappedLocations([
    match({ id: 'A', metresEast: 50, type: 'Sideswipe merge conflict' }),
    match({ id: 'B', metresEast: 50, type: 'Sideswipe merge conflict' }),
    match({ id: 'C', metresEast: 50, type: 'Rear-end crash' }),
  ])[0];
  assert.equal(dominant.dominant.id, PATTERN_FAMILIES.MERGE.id);
  assert.equal(dominant.mixed, false);

  // An even split picks nothing rather than picking arbitrarily.
  const tied = mappedLocations([
    match({ id: 'A', metresEast: 50, type: 'Sideswipe merge conflict' }),
    match({ id: 'B', metresEast: 50, type: 'Rear-end crash' }),
  ])[0];
  assert.equal(tied.mixed, true);
  assert.equal(tied.dominant, null);
});

test('a location carries its source wording, outcomes and latest date for the popover', () => {
  const place = mappedLocations([
    match({ id: 'A', metresEast: 50, type: 'Sideswipe merge conflict', injury: 'Yes', days: 40 }),
    match({ id: 'B', metresEast: 50, type: 'Sideswipe merge conflict', injury: 'Yes', hosp: 'Yes', days: 5 }),
    match({ id: 'C', metresEast: 50, type: 'Pedestrian roadside exposure event', fatal: 'Yes', days: 90 }),
  ])[0];
  // Source categories, unchanged — the panel and the map agree on the words.
  assert.deepEqual(place.patterns, [
    { value: 'Sideswipe merge conflict', count: 2 },
    { value: 'Pedestrian roadside exposure event', count: 1 },
  ]);
  assert.deepEqual(place.outcomes, { injury: 2, hospitalisation: 1, fatality: 1 });
  assert.equal(place.latestMs, AT - 5 * DAY, 'the most recent record at this place');
  assert.equal(place.records.length, 3);
  // Contributing circumstance, never a cause: the register publishes no confirmed cause.
  assert.equal(place.contributingCircumstances[0].value, 'Driver behavior');
  assert.ok(!('cause' in place));
});

test('records are placed along one corridor axis, and far ones are not placed at all', () => {
  const matches = [
    match({ id: 'near-1', metresEast: 100, offsetDeg: 0.0003 }),    // ~33 m off the line
    match({ id: 'near-2', metresEast: 120, offsetDeg: 0.0003 }),
    match({ id: 'far', metresEast: 150, offsetDeg: 0.02 }),          // ~2.2 km off the line
  ];
  const result = corridorConcentration(matches, CENTERLINE);
  assert.equal(result.placed, 2);
  assert.equal(result.unplaced, 1, 'reported, not snapped onto the corridor');
  assert.ok(result.bins.length >= 1);
  assert.equal(result.bins.reduce((sum, bin) => sum + bin.count, 0), 2, 'every placed record is in a bin');
});

test('concentration bands are relative to the busiest stretch of this corridor', () => {
  // Both groups well inside the line, and each well inside one bin.
  const matches = [
    ...Array.from({ length: 9 }, (_, i) => match({ id: `hot${i}`, metresEast: 300 + i })),
    match({ id: 'cool', metresEast: 1_500 }),
  ];
  const result = corridorConcentration(matches, CENTERLINE);
  assert.equal(result.placed, 10, 'every record is on the corridor');
  const hottest = result.bins.reduce((best, bin) => (bin.count > best.count ? bin : best));
  const coolest = result.bins.reduce((best, bin) => (bin.count < best.count ? bin : best));
  assert.equal(hottest.band, 'HIGH');
  assert.equal(coolest.band, 'LOW');
  assert.ok(hottest.count > coolest.count);
  assert.equal(result.peak, hottest.count);
  // Counts of records, never a rate: the shape carries no denominator at all.
  for (const bin of result.bins) assert.equal(typeof bin.count, 'number');
});

test('no corridor and no records are reported rather than guessed', () => {
  const withoutLine = corridorConcentration([match({ id: 'A' })], []);
  assert.deepEqual(withoutLine.bins, []);
  assert.match(withoutLine.reason, /No corridor centreline/);
  assert.equal(withoutLine.unplaced, 1);

  const nothingNear = corridorConcentration([match({ id: 'A', offsetDeg: 0.05 })], CENTERLINE);
  assert.deepEqual(nothingNear.bins, []);
  assert.equal(nothingNear.placed, 0);
  assert.match(nothingNear.reason, /No records fall on this corridor/);
  assert.deepEqual(corridorConcentration([], CENTERLINE).bins, []);
});

test('nothing in the model claims a carriageway', () => {
  // The audit found segment id stated on only two thirds of records, so EB/WB is never derived.
  const result = corridorConcentration([match({ id: 'A', metresEast: 400, offsetDeg: 0.0002 })], CENTERLINE);
  const serialised = JSON.stringify(result);
  for (const forbidden of ['EB', 'WB', 'carriageway', 'direction']) {
    assert.ok(!serialised.includes(forbidden), `no "${forbidden}" in a corridor-position result`);
  }
  const place = JSON.stringify(mappedLocations([match({ id: 'A' })]));
  assert.ok(!place.includes('carriageway'));
});

test('a bin draws as the stretch of corridor it counted', () => {
  const slice = centerlineSlice(CENTERLINE, 400, 800);
  assert.ok(slice.length >= 2);
  const metres = (a, b) => {
    const k = Math.cos(((a.latitude + b.latitude) / 2) * Math.PI / 180);
    return Math.hypot((b.longitude - a.longitude) * k, b.latitude - a.latitude) * 111_320;
  };
  let length = 0;
  for (let i = 1; i < slice.length; i += 1) length += metres(slice[i - 1], slice[i]);
  assert.ok(Math.abs(length - 400) < 5, `${Math.round(length)} m drawn for a 400 m bin`);
  assert.equal(CONCENTRATION_CONFIG.binMeters, 400);
  assert.deepEqual(centerlineSlice([], 0, 400), []);
});
