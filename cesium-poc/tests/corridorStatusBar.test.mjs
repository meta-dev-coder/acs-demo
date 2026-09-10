import test from 'node:test';
import assert from 'node:assert/strict';
import { corridorStatusMetrics } from '../src/corridorStatusBar.js';

const segments = new Map([
  ['eb1', { beginPost: 0, endPost: 4.182, direction: 'EB' }],
  ['eb2', { beginPost: 4.182, endPost: 12.86, direction: 'EB' }],
  ['wb1', { beginPost: 0, endPost: 12.86, direction: 'WB' }],
]);
const labels = result => result.metrics.map(metric => metric.label);
const value = (result, label) => result.metrics.find(metric => metric.label === label)?.value;

test('corridor length comes from the FDOT mileposts already on the segments', () => {
  const result = corridorStatusMetrics({ staticSegments: segments });
  assert.equal(value(result, 'Corridor'), '12.9 mi');
});

test('with no traffic observations, speed metrics are omitted and the gap is stated', () => {
  const result = corridorStatusMetrics({ staticSegments: segments, segmentStatus: new Map(), events: [] });
  // No invented speeds, travel times or congestion counts.
  for (const absent of ['EB', 'WB', 'Congested', 'Travel time']) assert.ok(!labels(result).includes(absent), `${absent} must not be shown`);
  assert.match(result.note, /No traffic-condition feed connected/);
});

test('observed conditions are averaged per direction and congestion counted', () => {
  const status = new Map([
    ['a', { direction: 'EB', speedMph: 61, congestionLevel: 'FREE_FLOW' }],
    ['b', { direction: 'EB', speedMph: 65, congestionLevel: 'MODERATE' }],
    ['c', { direction: 'WB', speedMph: 24, congestionLevel: 'CONGESTED' }],
    ['d', { direction: 'WB', speedMph: 18, congestionLevel: 'SEVERE' }],
  ]);
  const result = corridorStatusMetrics({ staticSegments: segments, segmentStatus: status, events: [] });
  assert.equal(value(result, 'EB'), '63 mph');
  assert.equal(value(result, 'WB'), '21 mph');
  assert.equal(value(result, 'Congested'), '2 segments');
  assert.equal(result.note, null, 'with a feed connected there is nothing to apologise for');
});

test('a single congested segment reads in the singular, and zero is not an alert', () => {
  const quiet = new Map([['a', { direction: 'EB', speedMph: 64, congestionLevel: 'FREE_FLOW' }]]);
  const one = new Map([...quiet, ['b', { direction: 'EB', speedMph: 12, congestionLevel: 'HEAVY' }]]);
  assert.equal(value(corridorStatusMetrics({ segmentStatus: one }), 'Congested'), '1 segment');
  const calm = corridorStatusMetrics({ segmentStatus: quiet });
  assert.equal(value(calm, 'Congested'), '0 segments');
  assert.equal(calm.metrics.find(metric => metric.label === 'Congested').tone, undefined);
});

test('live events are counted by kind, and only a non-zero count is toned as an alert', () => {
  const busy = corridorStatusMetrics({ events: [{ type: 'INCIDENT' }, { type: 'CLOSURE' }, { type: 'CLOSURE' }] });
  assert.equal(value(busy, 'Incidents'), '1');
  assert.equal(value(busy, 'Closures'), '2');
  assert.equal(busy.metrics.find(metric => metric.label === 'Incidents').tone, 'alert');
  const quiet = corridorStatusMetrics({ events: [] });
  assert.equal(value(quiet, 'Incidents'), '0');
  assert.equal(quiet.metrics.find(metric => metric.label === 'Incidents').tone, undefined);
});

test('nothing loaded yet shows nothing rather than zeroes', () => {
  const empty = corridorStatusMetrics();
  assert.deepEqual(empty.metrics, []);
  assert.match(empty.note, /No traffic-condition feed/);
});
