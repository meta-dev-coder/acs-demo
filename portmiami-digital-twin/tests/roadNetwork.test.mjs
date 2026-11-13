/**
 * Tests for the road network's pure layer: the model, the classification and the filters.
 *
 * These run against the REAL file in public/data, not a fixture, because the things most worth
 * pinning down are facts about that file — 2,362 segments, 176 port access, sparse OBJECTIDs, the
 * 0-to-0 address sentinel. A fixture would let the file change underneath without a failure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildRoadSegments, classifyPortAccess, displayName, readableName, roadClasses,
  roadClassLabel, roadMunicipalities, summariseRoads, unnamedLabel, validateRoadCollection,
} from '../src/roads/roadModel.js';
import { filterRoads, GROUPS, isFiltered, matchesQuery, sortRoads } from '../src/roads/roadFilters.js';
import { ROAD_SOURCE } from '../src/config/roadNetwork.js';

const source = JSON.parse(readFileSync(
  fileURLToPath(new URL('../public/data/portmiami_roads_merged.geojson', import.meta.url)), 'utf8'));
const segments = buildRoadSegments(source);

// ---- validation -------------------------------------------------------------------------
test('the shipped file validates with no errors or warnings', () => {
  const report = validateRoadCollection(source, { expectedFeatureCount: ROAD_SOURCE.expectedFeatureCount });
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.featureCount, 2362);
});

test('validation reports rather than throws on a broken collection', () => {
  const report = validateRoadCollection({ type: 'FeatureCollection', features: [
    { type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] }, properties: { OBJECTID: 1 } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: {} },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { OBJECTID: 7 } },
    { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { OBJECTID: 7 } },
  ] }, { expectedFeatureCount: 99 });
  assert.equal(report.ok, false);
  assert.match(report.errors.join(' '), /not LineStrings/);
  assert.match(report.errors.join(' '), /no OBJECTID/);
  assert.match(report.errors.join(' '), /duplicate OBJECTID/);
  assert.match(report.warnings.join(' '), /Expected 99 features, found 4/);
});

test('a non-FeatureCollection is rejected without throwing', () => {
  assert.equal(validateRoadCollection(null).ok, false);
  assert.equal(validateRoadCollection({ type: 'Feature' }).ok, false);
});

// ---- model ------------------------------------------------------------------------------
test('every feature becomes exactly one segment with a unique OBJECTID', () => {
  assert.equal(segments.length, 2362);
  assert.equal(new Set(segments.map(s => s.objectId)).size, 2362);
});

test('OBJECTIDs are sparse, so an index is never an id', () => {
  const ids = segments.map(s => s.objectId).sort((a, b) => a - b);
  assert.equal(ids[0], 1);
  assert.equal(ids[ids.length - 1], 99569);
  // The ones that tripped up a first pass at the search test.
  assert.equal(ids.includes(35), false);
  assert.equal(ids.includes(2362), false);
});

test('the source properties object is carried through untouched', () => {
  const segment = segments.find(s => s.objectId === 9519);
  const feature = source.features.find(f => f.properties.OBJECTID === 9519);
  assert.equal(segment.properties, feature.properties, 'same object, not a copy');
  assert.equal(segment.properties.GlobalID, feature.properties.GlobalID);
});

test('building segments does not mutate the source collection', () => {
  const before = JSON.stringify(source.features.slice(0, 50));
  buildRoadSegments(source);
  sortRoads(filterRoads(segments, { query: 'port', group: GROUPS.PORT }), 'port');
  assert.equal(JSON.stringify(source.features.slice(0, 50)), before);
});

test('readableName joins the four parts in source order and skips blanks', () => {
  assert.equal(readableName({ PRE_DIR: 'N', ST_NAME: 'CRUISE', ST_TYPE: 'BLVD', SUF_DIR: null }), 'N CRUISE BLVD');
  assert.equal(readableName({ PRE_DIR: null, ST_NAME: 'PORT', ST_TYPE: 'BLVD' }), 'PORT BLVD');
  assert.equal(readableName({ PRE_DIR: ' ', ST_NAME: 'null', ST_TYPE: '' }), '');
  assert.equal(readableName({}), '');
  assert.equal(readableName(undefined), '');
});

test('unnamed segments fall back to their OBJECTID', () => {
  assert.equal(unnamedLabel(1), 'Unnamed Road · ID 1');
  const unnamed = segments.filter(s => !s.name);
  assert.equal(unnamed.length, 86);
  for (const segment of unnamed) assert.match(displayName(segment), /^Unnamed Road · ID \d+$/);
});

test('summary counts come out of the data', () => {
  assert.deepEqual(summariseRoads(segments), {
    total: 2362, portAccess: 176, surrounding: 2186, named: 2276, unnamed: 86, tunnels: 14,
  });
});

test('CLASS is reported as the code, never as an invented label', () => {
  assert.deepEqual(roadClasses(segments).map(c => c.code), ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
  assert.equal(roadClasses(segments).reduce((n, c) => n + c.count, 0), 2362);
  assert.equal(roadClassLabel('5'), 'CLASS 5');
  assert.equal(roadClassLabel(''), 'No class');
});

test('municipalities are listed with both sides when they differ', () => {
  const names = roadMunicipalities(segments).map(m => m.name);
  assert.ok(names.includes('MIAMI'));
  assert.ok(names.includes('MIAMI BEACH / UNINCORPORATED MIAMI-DADE'));
});

test('each segment carries bounds that contain its own midpoint', () => {
  for (const segment of segments) {
    const [lon, lat] = segment.midpoint;
    assert.ok(lon >= segment.bounds.west && lon <= segment.bounds.east, `lon ${segment.objectId}`);
    assert.ok(lat >= segment.bounds.south && lat <= segment.bounds.north, `lat ${segment.objectId}`);
  }
});

// ---- classification ---------------------------------------------------------------------
test('port access is derived from the name, with the reason recorded', () => {
  assert.deepEqual(classifyPortAccess('PORT BLVD', 1), { isPortAccess: true, reason: 'Name contains PORT' });
  assert.deepEqual(classifyPortAccess('N CRUISE BLVD', 2), { isPortAccess: true, reason: 'Name contains CRUISE' });
  assert.deepEqual(classifyPortAccess('CARIBBEAN WAY', 3), { isPortAccess: true, reason: 'Listed PortMiami terminal street' });
  assert.equal(classifyPortAccess('ALTON RD', 4).isPortAccess, false);
});

test('the names deliberately NOT classified as port access stay out', () => {
  // Each of these sits on or beside Dodge Island; proximity is not the rule.
  for (const name of ['SR 887', 'MACARTHUR CSWY', 'TERMINAL ISLAND', 'STAR ISLAND DR', 'PARROT JUNGLE TRL']) {
    const matching = segments.filter(s => s.name === name);
    assert.ok(matching.length > 0, `${name} should exist in the data`);
    for (const segment of matching) {
      assert.equal(segment.isPortAccess, false, `${name} (${segment.objectId}) must not be port access`);
    }
  }
});

test('port access covers exactly the expected road names', () => {
  const names = [...new Set(segments.filter(s => s.isPortAccess).map(s => s.name))].sort();
  assert.deepEqual(names, [
    'AFRICA WAY', 'ASIA WAY', 'ATLANTIC WAY', 'AUSTRALIA WAY', 'CARIBBEAN WAY', 'CRUISE BLVD',
    'E PORT BLVD', 'EUROPE WAY', 'FLORIDA WAY', 'N AMERICA WAY', 'N CRUISE BLVD', 'PORT BLVD',
    'PORT MIAMI RETURN', 'PORT MIAMI TUNNEL', 'S AMERICA WAY', 'S CRUISE BLVD', 'W CRUISE BLVD',
  ]);
});

test('only the tunnel centrelines are flagged as tunnels', () => {
  const tunnels = segments.filter(s => s.isTunnel);
  assert.equal(tunnels.length, 14);
  for (const segment of tunnels) assert.equal(segment.name, 'PORT MIAMI TUNNEL');
});

// ---- filters ----------------------------------------------------------------------------
const segment = objectId => segments.find(s => s.objectId === objectId);

test('search is case-insensitive over the readable name', () => {
  assert.equal(matchesQuery(segment(9519), 'e port blvd'), true);
  assert.equal(matchesQuery(segment(9519), 'E PORT'), true);
  assert.equal(matchesQuery(segment(9519), '  port  '), true);
  assert.equal(matchesQuery(segment(9519), 'alton'), false);
});

test('an all-digit term matches an OBJECTID exactly, not as a substring', () => {
  assert.equal(matchesQuery(segment(1), '1'), true);
  // 9519 contains "95" but is not OBJECTID 95.
  assert.equal(matchesQuery(segment(9519), '95'), false);
});

test('an empty query matches everything', () => {
  assert.equal(filterRoads(segments, { query: '   ' }).length, 2362);
  assert.equal(filterRoads(segments).length, 2362);
});

test('group filters split the network with nothing lost', () => {
  const port = filterRoads(segments, { group: GROUPS.PORT });
  const surrounding = filterRoads(segments, { group: GROUPS.SURROUNDING });
  assert.equal(port.length, 176);
  assert.equal(surrounding.length, 2186);
  assert.equal(port.length + surrounding.length, segments.length);
});

test('class and municipality filters combine with the search', () => {
  assert.equal(filterRoads(segments, { classCode: '0' }).length, 143);
  assert.equal(filterRoads(segments, { municipality: 'MIAMI BEACH' }).length, 680);
  const combined = filterRoads(segments, { group: GROUPS.PORT, classCode: '0' });
  assert.equal(combined.length, 14, 'the tunnel is the only CLASS 0 port access road');
  for (const road of combined) assert.equal(road.name, 'PORT MIAMI TUNNEL');
});

test('isFiltered knows when the list is showing everything', () => {
  assert.equal(isFiltered({ query: '', group: GROUPS.ALL, classCode: '', municipality: '' }), false);
  assert.equal(isFiltered({ query: ' ', group: GROUPS.ALL }), false);
  assert.equal(isFiltered({ query: 'port' }), true);
  assert.equal(isFiltered({ group: GROUPS.PORT }), true);
  assert.equal(isFiltered({ classCode: '5' }), true);
});

test('an exact OBJECTID search puts that segment first', () => {
  // The bug this pins: sorting port access first buried the exact match below the visible window.
  for (const id of [1, 9519, 27822, 41, 99569]) {
    const results = sortRoads(filterRoads(segments, { query: String(id) }), String(id));
    assert.equal(results[0].objectId, id, `OBJECTID ${id} should lead its own search`);
  }
});

test('without an id match, port access leads and names sort naturally', () => {
  const results = sortRoads(filterRoads(segments, { query: 'way' }), 'way');
  assert.equal(results[0].isPortAccess, true);
  const portNames = results.filter(r => r.isPortAccess).map(displayName);
  assert.deepEqual(portNames, [...portNames].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })));
});

test('sorting returns a new array and leaves the input order alone', () => {
  const input = filterRoads(segments, { group: GROUPS.PORT });
  const before = input.map(r => r.objectId);
  const sorted = sortRoads(input, '');
  assert.notEqual(sorted, input);
  assert.deepEqual(input.map(r => r.objectId), before);
});

// ---- the facts the details panel depends on ---------------------------------------------
test('0-to-0 address ranges are a sentinel, not an address', () => {
  const zeroes = segments.filter(s => s.properties.L_ADD_FROM === 0 && s.properties.L_ADD_TO === 0);
  assert.equal(zeroes.length, 705);
  const real = segments
    .map(s => s.properties.L_ADD_FROM)
    .filter(v => v !== null && v !== 0);
  assert.equal(Math.min(...real), 1, 'every real range starts at 1 or above');
});

test('impedance tracks length and carries a -1 sentinel, so it is not travel time', () => {
  const pairs = segments
    .filter(s => s.properties.FROM_TO_IMP != null && s.lengthFeet > 1)
    .map(s => s.properties.FROM_TO_IMP / s.lengthFeet)
    .sort((a, b) => a - b);
  const median = pairs[Math.floor(pairs.length / 2)];
  assert.ok(Math.abs(median - 1) < 0.01, `median impedance/length ratio was ${median}`);
  assert.ok(segments.some(s => s.properties.FROM_TO_IMP === -1), 'the -1 sentinel is present');
});
