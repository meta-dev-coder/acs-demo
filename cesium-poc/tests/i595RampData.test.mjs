import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { rampFromProperties, rampDetails, matchesRamp, RAMP_CATEGORIES } from '../src/i595RampData.js';

const data = JSON.parse(readFileSync(new URL('../public/data/i595_ramps_connectors_classified.geojson', import.meta.url)));
const ramps = data.features.map(feature => rampFromProperties(feature.properties));

test('all 165 source ramps have unique OSM identities across the five categories and 11 interchanges', () => {
  assert.equal(ramps.length, 165);
  assert.equal(new Set(ramps.map(ramp => ramp.id)).size, 165);
  assert.equal(new Set(ramps.map(ramp => ramp.interchange)).size, 11);
  assert.deepEqual(RAMP_CATEGORIES.map(category => ramps.filter(ramp => ramp.rampType === category.type).length), [15, 12, 43, 85, 10]);
});

test('category and interchange filters intersect without inventing membership', () => {
  const types = new Set(['EXIT_RAMP']);
  const actual = ramps.filter(ramp => matchesRamp(ramp, types, 'FLAMINGO_RD')).map(ramp => ramp.id);
  const expected = data.features.filter(feature => feature.properties.ramp_type === 'EXIT_RAMP' && feature.properties.interchange === 'FLAMINGO_RD').map(feature => feature.properties.osm_way_id);
  assert.ok(expected.length);
  assert.deepEqual(actual, expected);
  assert.equal(ramps.filter(ramp => matchesRamp(ramp, new Set(), '')).length, 0);
});

test('details omit unverified structures and format source and facility labels', () => {
  for (const ramp of ramps.filter(ramp => ramp.structureConfidence === 'LOW')) {
    assert.equal(new Map(rampDetails(ramp)).has('Structure'), false);
    assert.equal(new Map(rampDetails(ramp)).has('Elevated'), false);
  }
  const ramp = rampFromProperties({ osm_way_id: 'way/test', ramp_type: 'ENTRY_RAMP', elevated: 'UNKNOWN', structure_type: 'UNKNOWN' });
  const details = new Map(rampDetails(ramp));
  assert.equal(details.has('Elevated'), false);
  assert.equal(details.get('From'), 'Unknown');
  assert.equal(details.has('Structure'), false);
  assert.ok(!JSON.stringify(rampDetails(ramps[0])).includes('validation_rule'));
  const high = ramps.find(ramp => ramp.structureConfidence === 'HIGH');
  assert.equal(new Map(rampDetails(high)).get('Structure'), high.structureType);
  assert.equal(new Map(rampDetails(high)).get('Elevated'), 'Yes');
  assert.equal(new Map(rampDetails({ ...high, elevated: false })).has('Structure'), false);
  assert.equal(new Map(rampDetails({ ...high, structureType: 'UNKNOWN' })).has('Structure'), false);
  const eb = ramps.find(ramp => ramp.connectedFacility === 'I595_GP_EB');
  assert.equal(new Map(rampDetails(eb)).get('Connected Facility'), 'I-595 EB');
  assert.equal(new Map(rampDetails(eb)).get('Source'), 'OpenStreetMap');
  assert.equal(new Map(rampDetails(high)).get('Ramp Type'), 'Freeway Connector');
});
