import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIGNAL_DETAIL_FAR_M, SIGNAL_DETAIL_NEAR_M, SIGNAL_LOD, signalDetails, signalLodFor, signalSecondaryDetails,
} from '../src/trafficSignals.js';

test('the two levels are a small marker and the detailed signal head', () => {
  assert.ok(SIGNAL_LOD.COMPACT.width >= 8 && SIGNAL_LOD.COMPACT.width <= 18, 'the far marker stays unobtrusive');
  assert.ok(SIGNAL_LOD.DETAILED.width >= 22 && SIGNAL_LOD.DETAILED.width <= 28);
  assert.ok(SIGNAL_LOD.DETAILED.height >= 45 && SIGNAL_LOD.DETAILED.height <= 55);
  assert.ok(SIGNAL_LOD.DETAILED.width > SIGNAL_LOD.COMPACT.width);
  // Every level is the traffic-light housing, not a pin or a POI dot.
  for (const [name, level] of Object.entries(SIGNAL_LOD)) {
    const svg = decodeURIComponent(level.image);
    assert.ok(svg.startsWith('data:image/svg+xml'), `${name} must be a local asset`);
    assert.ok(svg.includes('#f44336') && svg.includes('#ffda16') && svg.includes('#07934c'),
      `${name} shows red, amber and green in a vertical housing`);
  }
  // The selected state is that same housing on a ring, drawn into the icon rather than added as a
  // second graphic: a clamped point on an entity that also has a billboard hides them both.
  assert.ok(SIGNAL_LOD.SELECTED.width > SIGNAL_LOD.DETAILED.width, 'the ring widens the selected icon');
  assert.equal(SIGNAL_LOD.SELECTED.height, SIGNAL_LOD.DETAILED.height);
  assert.ok(decodeURIComponent(SIGNAL_LOD.SELECTED.image).includes('#67f4e2'), 'the ring uses the accent colour');
});

test('level of detail switches by distance, with hysteresis across the band', () => {
  assert.ok(SIGNAL_DETAIL_NEAR_M < SIGNAL_DETAIL_FAR_M, 'the band must have width to damp flicker');
  assert.equal(signalLodFor(400, 'COMPACT'), 'DETAILED');
  assert.equal(signalLodFor(9000, 'DETAILED'), 'COMPACT');
  // Inside the band nothing changes, whichever way it was entered — this is what stops flicker.
  const middle = (SIGNAL_DETAIL_NEAR_M + SIGNAL_DETAIL_FAR_M) / 2;
  assert.equal(signalLodFor(middle, 'DETAILED'), 'DETAILED');
  assert.equal(signalLodFor(middle, 'COMPACT'), 'COMPACT');
  // A slow approach flips exactly once, at the near bound.
  const flips = [];
  let level = 'COMPACT';
  for (let d = SIGNAL_DETAIL_FAR_M + 400; d > 200; d -= 25) {
    const next = signalLodFor(d, level);
    if (next !== level) flips.push(d);
    level = next;
  }
  assert.equal(flips.length, 1);
  assert.ok(flips[0] <= SIGNAL_DETAIL_NEAR_M);
  // Nudging back and forth across the near bound must not oscillate.
  let jitter = 'DETAILED', changes = 0;
  for (let i = 0; i < 20; i++) {
    const next = signalLodFor(SIGNAL_DETAIL_NEAR_M + (i % 2 ? 40 : -40), jitter);
    if (next !== jitter) changes++;
    jitter = next;
  }
  assert.equal(changes, 0, 'jitter around the near bound must not flip the level');
  assert.equal(signalLodFor(NaN, 'DETAILED'), 'DETAILED', 'an unknown distance holds the current level');
});

const properties = {
  signal_type: 'Traffic Signal', cross_street: 'S 2300 BLOCK', signal_id: '3391', roadway_id: '86220000',
  begin_post: 8.404, section_status: 'ON', effective_date: '24-OCT-1989', county: 'Broward', district: '4',
  source: 'FDOT RCI Traffic Signals',
};

test('the panel leads with the operational fields and defers the administrative ones', () => {
  assert.deepEqual(signalDetails(properties).map(([name]) => name),
    ['Type', 'Cross Street', 'FDOT Signal ID', 'FDOT Roadway', 'FDOT Reference Post', 'Status', 'Effective Date', 'Source']);
  assert.deepEqual(signalSecondaryDetails(properties), [['County', 'Broward'], ['District', '4']]);
  // Nothing is lost by the split, and nothing is duplicated across the two sections.
  const primary = signalDetails(properties).map(([name]) => name);
  assert.deepEqual(primary.filter(name => ['County', 'District'].includes(name)), []);
});

test('missing or N/A values are dropped rather than shown as blanks', () => {
  const sparse = { ...properties, county: 'N/A', district: '  ', cross_street: null, begin_post: undefined };
  assert.deepEqual(signalSecondaryDetails(sparse), []);
  assert.deepEqual(signalDetails(sparse).map(([name]) => name),
    ['Type', 'FDOT Signal ID', 'FDOT Roadway', 'Status', 'Effective Date', 'Source']);
});
