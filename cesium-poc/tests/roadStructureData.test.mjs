import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roadStructureFromProperties, structureOverlapsSegment, bridgeDetails } from '../src/roadStructureData.js';
import { roadSegmentFromProperties } from '../src/i595RoadSegmentData.js';
const structures = JSON.parse(readFileSync(new URL('../public/data/i595_bridges.geojson', import.meta.url))).features.map(f => roadStructureFromProperties(f.properties));
const segments = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url))).features.map(f => roadSegmentFromProperties(f.properties));
test('23 distinct structures preserve road-side metadata without converting it to direction', () => {
  assert.equal(structures.length, 23); assert.equal(new Set(structures.map(s => s.assetId)).size, 23);
  for (const s of structures) {
    const rows = new Map(bridgeDetails(s));
    assert.equal(rows.get('FDOT Road Side'), s.roadSide);
    assert.equal(rows.has('Direction'), false);
    assert.equal(rows.has('asset_id'), false);
  }
});
test('boundary-spanning bridge 860648 links both sections, in both directions', () => {
  const s = structures.find(s => s.structureId === '860648');
  const matches = segments.filter(segment => structureOverlapsSegment(s, segment));
  assert.equal(matches.length, 4);
  assert.deepEqual([...new Set(matches.map(s => s.fdotSegmentIndex))], [1, 2]);
  const rows = new Map(bridgeDetails(s, matches));
  assert.equal(rows.get('Length'), '102.6 m');
  assert.equal(rows.get('FDOT Traffic Sections'), 'Segment 1 · MP 0.000–4.182\nSegment 2 · MP 4.182–5.142');
  assert.equal(structureOverlapsSegment(s, {...matches[0], fdotRoadway: 'different'}), false);
  assert.equal(structureOverlapsSegment(s, {...matches[0], beginPost: s.endPost, endPost: s.endPost + 1}), true);
});
