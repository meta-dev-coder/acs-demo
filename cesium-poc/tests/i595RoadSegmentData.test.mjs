import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { roadSegmentFromProperties, roadSegmentDetails, roadSegmentTooltip, formatAadt } from '../src/i595RoadSegmentData.js';

const data = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url)));
test('combined FDOT file has 8 uniquely identified sections per direction with original FDOT metadata', () => {
  assert.equal(new Set(data.features.map(f => f.properties.segment_id)).size, 16);
  for (const direction of ['EB', 'WB']) {
    const segments = data.features.filter(f => f.properties.direction === direction).map(f => roadSegmentFromProperties(f.properties));
    assert.equal(segments.length, 8);
    assert.deepEqual(segments.map(s => s.travelOrder).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(segments.every(s => s.fdotRoadway === '86095000' && s.aadtYear === 2025 && Object.isFrozen(s)));
    assert.ok(segments.every(s => !('averageSpeedMph' in s) && !('congestionLevel' in s)));
  }
});
test('details format mileposts and AADT while preserving original FDOT descriptions', () => {
  const feature = data.features.find(f => f.properties.direction === 'EB' && f.properties.begin_post === 6.68);
  const segment = roadSegmentFromProperties(feature.properties);
  const rows = new Map(roadSegmentDetails(segment));
  assert.equal(rows.get('Milepost'), '6.680 – 7.350');
  assert.equal(rows.get('AADT'), '229,000 vehicles/day');
  assert.equal(rows.get('AADT Year'), '2025');
  assert.equal(rows.get('From'), feature.properties.desc_from);
  assert.equal(rows.get('To'), feature.properties.desc_to);
  assert.equal(roadSegmentTooltip(segment), 'I-595 Eastbound\nMP 6.680 – 7.350');
  assert.deepEqual([...rows.keys()], ['Road', 'Direction', 'FDOT Roadway', 'FDOT Section', 'Milepost', 'From', 'To', 'AADT', 'AADT Year']);
  assert.equal(formatAadt(undefined), 'Unknown');
});
