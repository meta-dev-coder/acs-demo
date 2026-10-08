/**
 * The images the corridor draws.
 *
 * Canvas output cannot be asserted pixel by pixel without becoming a change-detector test, so these
 * check the contract that matters: the right size for the content, caching that actually caches,
 * and — the part worth protecting — that a marker never invents a value it was not given.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// A minimal canvas, enough for the measuring and drawing these helpers do.
const strokes = [];
function stubCanvas() {
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({
        scale() {}, beginPath() {}, moveTo() {}, lineTo() {}, arcTo() {}, arc() {}, closePath() {},
        fill() {}, stroke() {}, save() {}, restore() {},
        fillText(text) { strokes.push(String(text)); },
        measureText: text => ({ width: String(text).length * 6 }),
        set font(v) {}, get font() { return ''; },
        set fillStyle(v) {}, get fillStyle() { return ''; },
        set strokeStyle(v) {}, get strokeStyle() { return ''; },
        set lineWidth(v) {}, set lineCap(v) {}, set lineJoin(v) {},
        set textAlign(v) {}, set textBaseline(v) {}, set globalAlpha(v) {}, get globalAlpha() { return 1; },
      }),
    }),
  };
  globalThis.window = { devicePixelRatio: 2 };
}
stubCanvas();
const { RISK_INK, clearMarkerCache, historyCluster, incidentCallout, mapChip, pickClearSpot, travelChevron } =
  await import('../src/tmc/tmcMapMarkers.js');

test('the incident callout carries exactly the values it was given', () => {
  strokes.length = 0;
  const callout = incidentCallout({
    id: 'INC-200177', level: 'MODERATE', levelLabel: 'Moderate',
    lines: ['Lane closure recorded', 'Active 300 min', 'Westbound Section 01'],
  });
  assert.ok(callout.width > 0 && callout.height > 0);
  assert.ok(strokes.includes('INC-200177'));
  assert.ok(strokes.includes('MODERATE SECONDARY RISK'));
  assert.ok(strokes.includes('Active 300 min'));
  assert.ok(strokes.includes('Westbound Section 01'));
  // Nothing beyond what was passed: no invented lane count, no invented duration.
  assert.equal(strokes.filter(text => /lanes blocked/i.test(text)).length, 0);
});

test('a callout with no supporting lines is shorter than one with three', () => {
  const bare = incidentCallout({ id: 'INC-1', level: 'LOW', levelLabel: 'Low', lines: [] });
  const full = incidentCallout({ id: 'INC-1', level: 'LOW', levelLabel: 'Low', lines: ['a', 'b', 'c'] });
  assert.ok(full.height > bare.height, 'the card grows with what is actually known');
});

test('every risk level has its own ink, and the level word is drawn too', () => {
  // Colour is never the only carrier: the word is painted onto the card beside it.
  for (const [level, label] of [['LOW', 'Low'], ['MODERATE', 'Moderate'], ['HIGH', 'High'], ['SEVERE', 'Severe']]) {
    assert.ok(RISK_INK[level], `${level} has a colour`);
    strokes.length = 0;
    incidentCallout({ id: `X-${level}`, level, levelLabel: label, lines: [] });
    assert.ok(strokes.some(text => text === `${label.toUpperCase()} SECONDARY RISK`));
  }
});

test('a cluster shows its count only when it stands for more than one record', () => {
  strokes.length = 0;
  historyCluster({ count: 1, stem: 20 });
  assert.equal(strokes.length, 0, 'a lone record is a dot, not a label reading "1"');
  strokes.length = 0;
  historyCluster({ count: 7, stem: 20 });
  assert.deepEqual(strokes, ['7'], 'the exact source count, never rounded or bucketed');
});

test('staggered stems produce taller images, which is how labels avoid each other', () => {
  const low = historyCluster({ count: 3, stem: 18 });
  const high = historyCluster({ count: 3, stem: 46 });
  assert.ok(high.height > low.height);
});

test('markers are cached by content, so a redraw is not a re-render', () => {
  clearMarkerCache();
  const once = incidentCallout({ id: 'INC-9', level: 'HIGH', levelLabel: 'High', lines: ['x'] });
  const twice = incidentCallout({ id: 'INC-9', level: 'HIGH', levelLabel: 'High', lines: ['x'] });
  assert.equal(once, twice, 'the same card is built once');
  const other = incidentCallout({ id: 'INC-9', level: 'HIGH', levelLabel: 'High', lines: ['y'] });
  assert.notEqual(once, other, 'different content is a different card');
  assert.equal(travelChevron('#fff'), travelChevron('#fff'));
  assert.notEqual(travelChevron('#fff'), travelChevron('#000'));
});

test('a chip renders the text it is given, with an optional second line', () => {
  strokes.length = 0;
  mapChip('WESTBOUND SECTION 01');
  assert.deepEqual(strokes, ['WESTBOUND SECTION 01']);
  strokes.length = 0;
  const withSub = mapChip('5010', { sub: 'Nearest upstream camera · 0.4 mi upstream' });
  assert.deepEqual(strokes, ['5010', 'Nearest upstream camera · 0.4 mi upstream']);
  assert.ok(withSub.height > mapChip('5010').height);
});

test('a label goes where it is furthest from everything already placed', () => {
  // The bug: each label had its own fixed position rule, and both the section name and the road
  // name resolved to the incident's own spot — the road band is centred on the incident, so its
  // midpoint IS the incident, every time.
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const candidates = [[0, 0], [10, 0], [50, 0]];
  // Nothing placed yet: the caller's first preference wins.
  assert.deepEqual(pickClearSpot(candidates, [], d), [0, 0]);
  // With the incident at the origin, the furthest candidate wins.
  assert.deepEqual(pickClearSpot(candidates, [[0, 0]], d), [50, 0]);
  // A second label already at 50 pushes the next one back to the middle.
  assert.deepEqual(pickClearSpot(candidates, [[0, 0], [50, 0]], d), [10, 0]);
  // A candidate is only as good as its NEAREST obstacle, not its average one.
  assert.deepEqual(pickClearSpot([[0, 0], [25, 0]], [[0, 0], [60, 0]], d), [25, 0]);
});

test('placement degrades safely rather than throwing', () => {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  assert.equal(pickClearSpot([], [[0, 0]], d), null);
  assert.equal(pickClearSpot(null, null, d), null);
  assert.deepEqual(pickClearSpot([null, [4, 4]], [[0, 0]], d), [4, 4], 'empty candidates are skipped');
});
