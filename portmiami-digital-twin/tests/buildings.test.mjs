/**
 * Tests for the building footprints' pure layer, run against the REAL shipped file — the facts
 * worth pinning are facts about that file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  buildBuildings, buildingLabel, buildingSourceLabel, buildingTypeLabel, groundMeasures, ringsOf,
  summariseBuildings, typeDistribution, validateBuildingCollection, yearDistribution,
} from '../src/buildings/buildingModel.js';
import {
  filterBuildings, HEIGHT_FILTER, isFiltered, matchesQuery, sortBuildings,
} from '../src/buildings/buildingFilters.js';
import { BUILDING_ASSETS, BUILDING_SOURCE, MERCATOR_NOTE } from '../src/config/buildings.js';

const source = JSON.parse(readFileSync(
  fileURLToPath(new URL('../public/data/portmiami_buildings_partial_6000.geojson', import.meta.url)), 'utf8'));
const buildings = buildBuildings(source);
const byId = id => buildings.find(b => b.objectId === id);

// ---- validation -------------------------------------------------------------------------
test('the shipped file validates with no errors or warnings', () => {
  const report = validateBuildingCollection(source, { expectedFeatureCount: BUILDING_SOURCE.expectedFeatureCount });
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, []);
  assert.equal(report.featureCount, 6000);
});

test('validation catches bad geometry, ids and coordinates without throwing', () => {
  const ring = [[0, 0], [0, 1], [1, 1], [0, 0]];
  const report = validateBuildingCollection({ type: 'FeatureCollection', features: [
    { geometry: { type: 'LineString', coordinates: ring }, properties: { OBJECTID: 1 } },
    { geometry: { type: 'Polygon', coordinates: [ring] }, properties: {} },
    { geometry: { type: 'Polygon', coordinates: [ring] }, properties: { OBJECTID: 5 } },
    { geometry: { type: 'Polygon', coordinates: [ring] }, properties: { OBJECTID: 5 } },
    { geometry: { type: 'Polygon', coordinates: [[[999, 0], [0, 1], [1, 1], [999, 0]]] }, properties: { OBJECTID: 6 } },
    { geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 1]]] }, properties: { OBJECTID: 7 } },
  ] });
  assert.equal(report.ok, false);
  assert.match(report.errors.join(' '), /not Polygon or MultiPolygon/);
  assert.match(report.errors.join(' '), /no OBJECTID/);
  assert.match(report.errors.join(' '), /duplicate OBJECTID/);
  assert.match(report.errors.join(' '), /outside the valid longitude\/latitude range/);
  assert.match(report.warnings.join(' '), /fewer than four positions/);
});

test('an unclosed ring is warned about and then closed on load', () => {
  const open = [[-80.16, 25.77], [-80.16, 25.771], [-80.159, 25.771], [-80.159, 25.77]];
  const collection = { type: 'FeatureCollection', features: [
    { geometry: { type: 'Polygon', coordinates: [open] }, properties: { OBJECTID: 1 } }] };
  assert.match(validateBuildingCollection(collection).warnings.join(' '), /not closed/);
  const [built] = buildBuildings(collection);
  const ring = built.rings[0];
  assert.deepEqual(ring[0], ring[ring.length - 1]);
});

// ---- model ------------------------------------------------------------------------------
test('exactly 6,000 buildings load with unique OBJECTIDs', () => {
  assert.equal(buildings.length, 6000);
  assert.equal(new Set(buildings.map(b => b.objectId)).size, 6000);
});

test('both Polygon and MultiPolygon are modelled', () => {
  const counts = buildings.reduce((acc, b) => ({ ...acc, [b.geometryType]: (acc[b.geometryType] ?? 0) + 1 }), {});
  assert.deepEqual(counts, { Polygon: 5927, MultiPolygon: 73 });
  const multi = buildings.find(b => b.geometryType === 'MultiPolygon');
  assert.ok(multi.partCount > 1);
  assert.ok(multi.rings.length >= multi.partCount);
});

test('ringsOf flattens a MultiPolygon and ignores anything else', () => {
  assert.equal(ringsOf({ type: 'Polygon', coordinates: [[1], [2]] }).length, 2);
  assert.equal(ringsOf({ type: 'MultiPolygon', coordinates: [[[1], [2]], [[3]]] }).length, 3);
  assert.deepEqual(ringsOf({ type: 'Point', coordinates: [0, 0] }), []);
  assert.deepEqual(ringsOf(null), []);
});

test('holes are counted and subtracted from the ground area', () => {
  const withHoles = buildings.filter(b => b.holeCount > 0);
  assert.equal(withHoles.length > 0, true);
  // A 100m square with a 50m square hole: 10,000 - 2,500 m².
  const m = 1 / 111320;
  const outer = [[0, 0], [0, 100 * m], [100 * m, 100 * m], [100 * m, 0], [0, 0]];
  const hole = [[25 * m, 25 * m], [25 * m, 75 * m], [75 * m, 75 * m], [75 * m, 25 * m], [25 * m, 25 * m]];
  const { areaM2 } = groundMeasures({ type: 'Polygon', coordinates: [outer, hole] });
  assert.ok(Math.abs(areaM2 - 7500) < 60, `expected ~7500 m², got ${Math.round(areaM2)}`);
});

test('the source properties object comes through untouched and unmutated', () => {
  const feature = source.features.find(f => f.properties.OBJECTID === 69);
  assert.equal(byId(69).properties, feature.properties, 'same object, not a copy');
  const before = JSON.stringify(source.features.slice(0, 40));
  buildBuildings(source);
  sortBuildings(filterBuildings(buildings, { query: '69' }), '69');
  assert.equal(JSON.stringify(source.features.slice(0, 40)), before);
});

test('null HEIGHT stays null and is never turned into a number', () => {
  const summary = summariseBuildings(buildings);
  assert.equal(summary.withHeight, 577);
  assert.equal(summary.withoutHeight, 5423);
  for (const building of buildings) {
    assert.ok(building.height === null || Number.isFinite(building.height));
  }
  assert.equal(byId(69).height, null);
});

test('summary counts come out of the data', () => {
  assert.deepEqual(summariseBuildings(buildings), {
    total: 6000, withHeight: 577, withoutHeight: 5423, multiPart: 73, curated: 0,
  });
});

test('the year and type distributions match the file', () => {
  assert.deepEqual(yearDistribution(buildings), [{ value: '2015', count: 4426 }, { value: '2023', count: 1574 }]);
  assert.deepEqual(typeDistribution(buildings), [
    { value: '', count: 1677 }, { value: 'L', count: 2787 }, { value: 'S', count: 1536 },
  ]);
});

test('codes are shown as codes, never as invented labels', () => {
  assert.equal(buildingTypeLabel('L'), 'TYPE L');
  assert.equal(buildingTypeLabel(''), 'No type');
  assert.equal(buildingSourceLabel('P'), 'SOURCE P');
  assert.equal(buildingSourceLabel(''), 'Not available');
});

test('a building with no curated record is named by its OBJECTID, not guessed', () => {
  assert.equal(BUILDING_ASSETS[69], undefined);
  assert.equal(byId(69).asset, null);
  assert.equal(buildingLabel(byId(69)), 'Building · ID 69');
});

test('a curated record, when one exists, supplies the name', () => {
  const curated = { ...byId(69), asset: { assetId: 'X', name: 'Cruise Terminal F', category: 'CRUISE_TERMINAL', source: 'test' } };
  assert.equal(buildingLabel(curated), 'Cruise Terminal F');
});

test('every building centroid sits inside its own bounds', () => {
  for (const b of buildings) {
    assert.ok(b.centroid[0] >= b.bounds.west && b.centroid[0] <= b.bounds.east, `lon ${b.objectId}`);
    assert.ok(b.centroid[1] >= b.bounds.south && b.centroid[1] <= b.bounds.north, `lat ${b.objectId}`);
  }
});

// ---- the units finding the details panel depends on --------------------------------------
test('Shape__* are Web Mercator units, not ground measures', () => {
  // The claim the panel makes: Shape__Length / ground metres == 1/cos(latitude).
  const ratios = buildings
    .filter(b => b.groundPerimeterM > 5 && b.sourceLength != null)
    .map(b => (b.sourceLength / b.groundPerimeterM) / MERCATOR_NOTE.lengthFactorAt(b.centroid[1]))
    .sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  assert.ok(Math.abs(median - 1) < 0.001, `median was ${median}, so the Web Mercator claim is wrong`);
  // And the inflation really is material, which is why both figures are shown.
  assert.ok(MERCATOR_NOTE.lengthFactorAt(25.778) > 1.11);
  assert.ok(MERCATOR_NOTE.lengthFactorAt(25.778) ** 2 > 1.23);
});

test('ground area differs from Shape__Area by the square of the scale factor', () => {
  const b = buildings.find(x => x.groundAreaM2 > 500 && x.holeCount === 0);
  const expected = b.groundAreaM2 * MERCATOR_NOTE.lengthFactorAt(b.centroid[1]) ** 2;
  assert.ok(Math.abs(b.sourceArea - expected) / expected < 0.01,
    `Shape__Area ${b.sourceArea} vs expected ${expected}`);
});

// ---- filters ----------------------------------------------------------------------------
test('search matches OBJECTID exactly, and UNIQUEID and GlobalID by substring', () => {
  const b = buildings.find(x => x.uniqueId);
  assert.equal(matchesQuery(b, String(b.objectId)), true);
  assert.equal(matchesQuery(b, b.uniqueId.toLowerCase()), true);
  assert.equal(matchesQuery(b, b.globalId.slice(0, 8).toUpperCase()), true);
  assert.equal(matchesQuery(byId(69), '6'), false, 'a digit must not match OBJECTID 69 as a substring');
  assert.equal(matchesQuery(byId(69), ''), true);
  // A bare number must not fall through to the hex GlobalID, or "6" would match most of the file.
  const digitNoise = buildings.filter(x => matchesQuery(x, '6')).length;
  assert.ok(digitNoise <= 2, `"6" matched ${digitNoise} buildings; a bare number is an identifier`);
  // ...but the numeric tail of a UNIQUEID is still findable.
  const tail = b.uniqueId.split('_').pop();
  assert.equal(matchesQuery(b, tail), true, `UNIQUEID tail ${tail} should match`);
});

test('height filters split the dataset with nothing lost', () => {
  const withHeight = filterBuildings(buildings, { height: HEIGHT_FILTER.WITH });
  const without = filterBuildings(buildings, { height: HEIGHT_FILTER.WITHOUT });
  assert.equal(withHeight.length, 577);
  assert.equal(without.length, 5423);
  assert.equal(withHeight.length + without.length, buildings.length);
  for (const b of withHeight) assert.notEqual(b.height, null);
  for (const b of without) assert.equal(b.height, null);
});

test('year and type filters combine', () => {
  assert.equal(filterBuildings(buildings, { year: '2015' }).length, 4426);
  assert.equal(filterBuildings(buildings, { year: '2023' }).length, 1574);
  assert.equal(filterBuildings(buildings, { type: 'L' }).length, 2787);
  // The 2023 batch carries no TYPE at all, so these two cannot overlap.
  assert.equal(filterBuildings(buildings, { year: '2023', type: 'L' }).length, 0);
});

test('isFiltered knows when the list is showing everything', () => {
  assert.equal(isFiltered({ query: '', year: '', type: '', height: HEIGHT_FILTER.ANY }), false);
  assert.equal(isFiltered({ query: '  ' }), false);
  assert.equal(isFiltered({ height: HEIGHT_FILTER.WITH }), true);
  assert.equal(isFiltered({ year: '2015' }), true);
});

test('an exact OBJECTID search puts that building first', () => {
  for (const id of [69, 820097, buildings[3000].objectId]) {
    const results = sortBuildings(filterBuildings(buildings, { query: String(id) }), String(id));
    assert.equal(results[0].objectId, id);
  }
});

test('sorting returns a new array and leaves the input alone', () => {
  const input = filterBuildings(buildings, { year: '2023' });
  const before = input.map(b => b.objectId);
  const sorted = sortBuildings(input, '');
  assert.notEqual(sorted, input);
  assert.deepEqual(input.map(b => b.objectId), before);
});

// ---- replaceability ----------------------------------------------------------------------
test('nothing outside the config hard-codes the partial feature count', () => {
  assert.equal(BUILDING_SOURCE.expectedFeatureCount, 6000);
  assert.equal(BUILDING_SOURCE.completeFeatureCount, 6673);
  // A larger file loads and models without touching any code.
  const bigger = { type: 'FeatureCollection', features: [...source.features, {
    geometry: source.features[0].geometry,
    properties: { ...source.features[0].properties, OBJECTID: 999999 },
  }] };
  const report = validateBuildingCollection(bigger, { expectedFeatureCount: 6673 });
  assert.equal(report.ok, true, 'extra features are not an error');
  assert.match(report.warnings.join(' '), /Expected 6673 features, found 6001/);
  assert.equal(buildBuildings(bigger).length, 6001);
});
