/**
 * Tolling: the gantry the screen opens on.
 *
 * The first version of this screen placed a gantry at coordinates that were handed over as a
 * guess. Measured afterwards, that point was 2.1 km south of the corridor — a toll gantry nowhere
 * near the road it tolls. It was replaced with OpenStreetMap node 3398439538, and these tests pin
 * the two things that made the replacement safe: the node is really on I-595, and everything the
 * screen says about it comes from the node's own tags.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { expressGantryRecords, OSM_ATTRIBUTION, paymentMethods, tollGantryRecords } from '../src/tolling/tollingGantries.js';

const osm = JSON.parse(readFileSync(new URL('../public/data/i595_toll_gantries_osm.geojson', import.meta.url)));
const gantry = osm.features[0];

const METRES_PER_DEGREE_LAT = 110_540;
const metresBetween = (a, b) => {
  const [lonA, latA] = a; const [lonB, latB] = b;
  const x = (lonA - lonB) * METRES_PER_DEGREE_LAT * Math.cos((latA * Math.PI) / 180);
  const y = (latA - latB) * METRES_PER_DEGREE_LAT;
  return Math.hypot(x, y);
};

test('the gantry is a published OSM toll gantry, not a placed demo point', () => {
  assert.equal(gantry.id, 'node/3398439538');
  assert.equal(gantry.properties.highway, 'toll_gantry');
  assert.equal(gantry.properties.operator, "Florida's Turnpike");
  // ODbL: the licence travels with the data, so the extract keeps its own copyright line.
  assert.match(osm.copyright, /ODbL/);
  assert.match(OSM_ATTRIBUTION, /OpenStreetMap/);
});

test('the gantry sits on the corridor, which the previous placement did not', () => {
  const corridor = JSON.parse(readFileSync(new URL('../public/data/i595_express_gantries.geojson', import.meta.url)));
  const nearest = corridor.features
    .map(feature => metresBetween(gantry.geometry.coordinates, feature.geometry.coordinates))
    .sort((a, b) => a - b)[0];
  // Not a claim that it IS an express gantry — those are different assets. Only that it is among
  // them rather than kilometres away, as the 26.0954/-80.3155 placement was.
  assert.ok(nearest < 2000, `nearest corridor gantry is ${Math.round(nearest)} m away`);
  const abandoned = metresBetween([-80.3155, 26.0954], gantry.geometry.coordinates);
  assert.ok(abandoned > 2000, 'the replaced demo point was over 2 km from this one');
});

test('only the payment methods the node declares are listed', () => {
  assert.deepEqual(paymentMethods(gantry.properties),
    ['SunPass', 'E-ZPass', 'Peach Pass', 'NC Quick Pass', 'Leeway', 'Toll-by-plate']);
  // A tag that is absent, "no", or anything other than yes is not a method this gantry accepts.
  assert.deepEqual(paymentMethods({ 'payment:sunpass': 'no', 'payment:e_zpass': 'yes' }), ['E-ZPass']);
  assert.deepEqual(paymentMethods({}), []);
  assert.deepEqual(paymentMethods(null), []);
});

// ------------------------------------------------------------------ the two datasets stay apart

test('each dataset is read into its own records, with nothing borrowed from the other', () => {
  const tollRecords = tollGantryRecords(osm);
  assert.equal(tollRecords.length, 1);
  assert.equal(tollRecords[0].kind, 'TOLL');
  assert.equal(tollRecords[0].sunpassCharge, '0.50 USD');

  const express = JSON.parse(readFileSync(new URL('../public/data/i595_express_gantries.geojson', import.meta.url)));
  const expressRecords = expressGantryRecords(express);
  assert.equal(expressRecords.length, 10);
  assert.equal(expressRecords[0].kind, 'EXPRESS');
  // The express extract publishes no toll charge, so no express record claims one — including the
  // ones that sit near the OSM gantry.
  assert.ok(expressRecords.every(record => record.sunpassCharge === undefined));
  assert.ok(expressRecords.every(record => record.attribution === 'FDOT / 595 Express Operations'));
});

test('a field the source does not publish stays absent rather than being filled in', () => {
  const [record] = expressGantryRecords({ features: [{
    properties: { gantry_id: 'GNT-X', type: 'ort_mainline', milepost: 'n/a', status: 'N/A' },
    geometry: { type: 'Point', coordinates: [-80.3, 26.1] },
  }] });
  assert.equal(record.milepost, null);
  assert.equal(record.status, null);
  assert.equal(record.dmsText, null);
  // With no name published, the id is the name — not a name invented from the road.
  assert.equal(record.name, 'GNT-X');
  // A feature with no usable geometry or identity is not a record at all.
  assert.equal(expressGantryRecords({ features: [{ properties: {}, geometry: null }] }).length, 0);
  assert.equal(tollGantryRecords({ features: [{ properties: { highway: 'crossing' },
    geometry: { type: 'Point', coordinates: [-80.3, 26.1] } }] }).length, 0);
});

// ------------------------------------------------------------------ the explorer's two sources

test('each gantry class reaches the explorer as its own type, and only while it is on screen', async () => {
  const { createAssetSources } = await import('../src/assetExplorer/assetSources.js');
  const toll = tollGantryRecords(osm);
  const express = expressGantryRecords(
    JSON.parse(readFileSync(new URL('../public/data/i595_express_gantries.geojson', import.meta.url))));
  let shown = null;
  const picks = [];
  const tolling = {
    recordsForType: type => (type === 'tollGantry' ? toll : type === 'expressGantry' ? express : []),
    shownType: () => shown,
    highlightById: id => picks.push(`highlight:${id}`),
    onSelection: () => {},
    reveal: async type => { shown = type; return true; },
  };
  const sources = createAssetSources({ tolling, centerline: [] });
  const tollSource = sources.find(source => source.assetType === 'tollGantry');
  const expressSource = sources.find(source => source.assetType === 'expressGantry');
  assert.ok(tollSource && expressSource, 'both classes are browsable');

  // Nothing is browsed yet, so neither source claims records the map is not drawing…
  assert.equal(tollSource.read().length, 0);
  assert.equal(expressSource.read().length, 0);
  // …but both are searchable, which is how "fly to GNT-W01" works before the card is ever opened.
  assert.equal(tollSource.readAll().length, 1);
  assert.equal(expressSource.readAll().length, 10);

  await tollSource.reveal();
  assert.equal(shown, 'tollGantry');
  assert.equal(tollSource.read().length, 1);
  assert.equal(expressSource.read().length, 0, 'the class that is not on screen stays empty');
  // The record keeps its own attributes through normalization, so the details panel has them.
  assert.equal(tollSource.read()[0].source.sunpassCharge, '0.50 USD');
  assert.equal(tollSource.read()[0].assetType, 'tollGantry');
});

test('a search for gantries offers all three gantry datasets, and "express" narrows to one', async () => {
  const { typeHints } = await import('../src/assetExplorer/assetSearch.js');
  assert.deepEqual(typeHints('toll gantry'), ['gantry', 'tollGantry', 'expressGantry']);
  // "express gantries" is matched first, so the narrower phrase is not swallowed by the general one.
  assert.deepEqual(typeHints('express gantries'), ['expressGantry']);
});

// ------------------------------------------------------------------ the 3D model behind a record

test('a toll gantry is matched to the placed model it stands at, by distance', async () => {
  const { modelForGantry } = await import('../src/tolling/tollingWorkspace.js');
  const models = JSON.parse(readFileSync(new URL('../config/cesiumModels.json', import.meta.url)));
  const [record] = tollGantryRecords(osm);

  const match = modelForGantry(record, models);
  assert.equal(match.config.id, 'i595-gantry-1-toll-plaza');
  assert.ok(match.distanceM < 20, `the model is ${Math.round(match.distanceM)} m from the OSM node`);

  // A gantry with no mesh near it gets none, rather than the closest one wherever it is.
  assert.equal(modelForGantry({ longitude: -80.25, latitude: 26.07 }, models), null);
  // Only gantry models, and only enabled ones — a barrier arm is not a toll gantry.
  const barrier = models.find(model => model.layer === 'lane-barriers');
  assert.equal(modelForGantry({ longitude: barrier.longitude, latitude: barrier.latitude }, models), null);
  assert.equal(modelForGantry(record, models.map(model => ({ ...model, enabled: false }))), null);
});
