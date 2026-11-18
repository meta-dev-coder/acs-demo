/**
 * Road widening: sections by measure, corridor generation, and what cannot be calculated.
 *
 * The audit finding drives half of these tests. The Miami-Dade centreline file publishes no width
 * and no lane count, so the cases that matter most are the ones where the honest answer is
 * "unknown" or "not calculable" — and the tests insist on that rather than on a plausible number.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSUMED_LANE_WIDTH_M, DEFAULT_PROPOSED_LANES, DEFAULT_PROPOSED_WIDTH_M, MIN_SECTION_M,
  PROVENANCE, WIDENING_SIDE, availableSides, measuresAlong, nearestMeasureTo, offsetCentreline,
  pointAtMeasure, sectionBetweenMeasures, sideAvailable, validateWidening, wideningCorridor,
  wideningQuantities,
} from '../src/designs/roadWidening.js';
import { enuToLonLat, lonLatToEnu } from '../src/scenarios/garagePlacement.js';

const ORIGIN = [-80.1731, 25.7795];
const at = (east, north) => enuToLonLat(ORIGIN, east, north);
const metresBetween = (a, b) => Math.hypot(...lonLatToEnu(a, b));
/** A 400 m straight running north. */
const STRAIGHT = [at(0, 0), at(0, 200), at(0, 400)];
/** An L: 200 m north, then 200 m east. */
const BENT = [at(0, 0), at(0, 200), at(200, 200)];

// ---- measures -------------------------------------------------------------------------------------

test('measures are ground distances along the alignment', () => {
  const { measures, totalM } = measuresAlong(STRAIGHT);
  assert.ok(Math.abs(measures[1] - 200) < 0.05, `${measures[1]}`);
  assert.ok(Math.abs(totalM - 400) < 0.05, `${totalM}`);
});

test('a point at a measure is interpolated within its segment, not snapped to a vertex', () => {
  const point = pointAtMeasure(STRAIGHT, 100);
  assert.ok(Math.abs(metresBetween(STRAIGHT[0], point) - 100) < 0.05);
  // Past the end clamps rather than extrapolating.
  assert.ok(metresBetween(pointAtMeasure(STRAIGHT, 9999), STRAIGHT[2]) < 0.05);
  assert.ok(metresBetween(pointAtMeasure(STRAIGHT, -50), STRAIGHT[0]) < 0.05);
});

test('a clicked point snaps to the measure of the nearest point ON the line', () => {
  // 30 m off to the side, halfway along: the measure is 100, not 0 or 200.
  const { measureM, distanceM } = nearestMeasureTo(STRAIGHT, at(30, 100));
  assert.ok(Math.abs(measureM - 100) < 0.1, `${measureM}`);
  assert.ok(Math.abs(distanceM - 30) < 0.1, `${distanceM}`);
});

test('snapping works around a bend', () => {
  const { measureM } = nearestMeasureTo(BENT, at(100, 230));
  assert.ok(Math.abs(measureM - 300) < 1, `${measureM}`);
});

// ---- sections -------------------------------------------------------------------------------------

test('a section is the part of the alignment between two measures', () => {
  const section = sectionBetweenMeasures(STRAIGHT, 100, 300);
  assert.ok(Math.abs(section.lengthM - 200) < 0.05);
  assert.ok(Math.abs(measuresAlong(section.coordinates).totalM - 200) < 0.05);
  assert.equal(section.startM, 100);
  assert.equal(section.endM, 300);
});

test('a section keeps the vertices between its ends, so a bend is not cut off', () => {
  const section = sectionBetweenMeasures(BENT, 100, 300);
  assert.equal(section.coordinates.length, 3, 'start, the corner, end');
  assert.ok(Math.abs(section.lengthM - 200) < 0.05);
});

test('reversed measures are normalised rather than refused', () => {
  const forward = sectionBetweenMeasures(STRAIGHT, 100, 300);
  const backward = sectionBetweenMeasures(STRAIGHT, 300, 100);
  assert.equal(backward.startM, forward.startM);
  assert.equal(backward.endM, forward.endM);
});

test('a section is clamped to the alignment and an empty one is null', () => {
  assert.ok(Math.abs(sectionBetweenMeasures(STRAIGHT, -50, 9999).lengthM - 400) < 0.05);
  assert.equal(sectionBetweenMeasures(STRAIGHT, 100, 100), null);
  assert.equal(sectionBetweenMeasures([at(0, 0)], 0, 10), null);
});

// ---- corridors ------------------------------------------------------------------------------------

test('a proposed corridor is the stated width, running north and running east alike', () => {
  const north = wideningCorridor({ coordinates: [at(0, 0), at(0, 300)], totalWidthM: 10 });
  const east = wideningCorridor({ coordinates: [at(0, 0), at(300, 0)], totalWidthM: 10 });
  assert.ok(Math.abs(metresBetween(north.ring[0], north.ring[3]) - 10) < 0.03);
  assert.ok(Math.abs(metresBetween(east.ring[0], east.ring[3]) - 10) < 0.03);
});

test('a corridor follows the selected section, not the whole road', () => {
  const whole = wideningCorridor({ coordinates: STRAIGHT, totalWidthM: 10 });
  const part = wideningCorridor({ coordinates: STRAIGHT, startM: 100, endM: 200, totalWidthM: 10 });
  assert.ok(Math.abs(measuresAlong(part.centreline).totalM - 100) < 0.05);
  assert.ok(measuresAlong(whole.centreline).totalM > measuresAlong(part.centreline).totalM);
});

test('a corridor follows a bend rather than cutting the corner', () => {
  const corridor = wideningCorridor({ coordinates: BENT, totalWidthM: 10 });
  assert.ok(corridor.centreline.length >= 3, 'the corner vertex is kept');
  assert.ok(Math.abs(measuresAlong(corridor.centreline).totalM - 400) < 0.1);
});

test('BOTH keeps the published centreline — nothing is shifted', () => {
  const corridor = wideningCorridor({ coordinates: STRAIGHT, totalWidthM: 10, side: WIDENING_SIDE.BOTH });
  assert.equal(corridor.shiftM, 0);
  assert.ok(metresBetween(corridor.centreline[0], STRAIGHT[0]) < 0.01);
});

// ---- the unknown-width rules ---------------------------------------------------------------------

test('with no stated existing width, only BOTH is offered', () => {
  assert.deepEqual(availableSides(null), [WIDENING_SIDE.BOTH]);
  assert.equal(sideAvailable(WIDENING_SIDE.LEFT, null), false);
  assert.equal(sideAvailable(WIDENING_SIDE.BOTH, null), true);
});

test('a one-sided widening without a stated width is refused, not approximated', () => {
  assert.equal(wideningCorridor({
    coordinates: STRAIGHT, totalWidthM: 10, side: WIDENING_SIDE.LEFT, baselineWidthM: null,
  }), null);
  const check = validateWidening({
    coordinates: STRAIGHT, totalWidthM: 10, laneCount: 2, side: WIDENING_SIDE.RIGHT,
  });
  assert.equal(check.ok, false);
  assert.ok(check.errors.some(e => /cannot be inferred from a centreline/.test(e)));
});

test('a stated existing width unlocks one-sided widening and shifts the centreline by half', () => {
  assert.deepEqual(availableSides(7), [WIDENING_SIDE.BOTH, WIDENING_SIDE.LEFT, WIDENING_SIDE.RIGHT]);
  const left = wideningCorridor({
    coordinates: STRAIGHT, totalWidthM: 11, side: WIDENING_SIDE.LEFT, baselineWidthM: 7,
  });
  // The increase is 4 m, so the centreline moves 2 m left to keep the right edge where it was.
  assert.ok(Math.abs(left.shiftM - 2) < 1e-9, `${left.shiftM}`);
  const [east] = lonLatToEnu(STRAIGHT[0], left.centreline[0]);
  assert.ok(east < -1.9 && east > -2.1, `left of a northbound road is west: ${east}`);

  const right = wideningCorridor({
    coordinates: STRAIGHT, totalWidthM: 11, side: WIDENING_SIDE.RIGHT, baselineWidthM: 7,
  });
  assert.ok(Math.abs(right.shiftM + 2) < 1e-9, `${right.shiftM}`);
});

test('offsetting an alignment moves it sideways by exactly the metres asked for', () => {
  const shifted = offsetCentreline([at(0, 0), at(0, 300)], 5);
  const [east, north] = lonLatToEnu(at(0, 0), shifted[0]);
  assert.ok(Math.abs(east + 5) < 0.02 && Math.abs(north) < 0.02, `${east}, ${north}`);
});

// ---- quantities -------------------------------------------------------------------------------------

test('with no existing width, the increment is NOT CALCULABLE — never zero', () => {
  const q = wideningQuantities({ coordinates: STRAIGHT, totalWidthM: 10, laneCount: 2 });
  assert.equal(q.baseline.widthM.value, null);
  assert.equal(q.baseline.widthM.provenance, PROVENANCE.UNKNOWN);
  assert.equal(q.baseline.surfaceAreaM2.value, null);
  assert.equal(q.difference.incrementalPavementM2.value, null);
  assert.equal(q.difference.incrementalPavementM2.provenance, PROVENANCE.NOT_CALCULABLE);
  assert.equal(q.difference.widthChangeM.provenance, PROVENANCE.NOT_CALCULABLE);
  assert.equal(q.difference.laneChange.provenance, PROVENANCE.NOT_CALCULABLE);
  // The proposal itself is still measurable.
  assert.ok(q.proposed.corridorAreaM2.value > 3900, `${q.proposed.corridorAreaM2.value}`);
  assert.equal(q.proposed.corridorAreaM2.provenance, PROVENANCE.CALCULATED);
});

test('a stated existing width makes the increment calculable, and says it was assumed', () => {
  const q = wideningQuantities({
    coordinates: STRAIGHT, totalWidthM: 10, laneCount: 2, baselineWidthM: 7, baselineLanes: 2,
    baselineWidthSource: PROVENANCE.USER_ASSUMED,
  });
  assert.equal(q.baseline.widthM.provenance, PROVENANCE.USER_ASSUMED);
  assert.ok(Math.abs(q.difference.widthChangeM.value - 3) < 1e-9);
  assert.equal(q.difference.laneChange.value, 0);
  // 400 m x 3 m of new pavement, within the mitre at the ends.
  assert.ok(Math.abs(q.difference.incrementalPavementM2.value - 1200) < 40,
    `${q.difference.incrementalPavementM2.value}`);
});

test('quantities follow the selected section, and the total length is still reported', () => {
  const q = wideningQuantities({ coordinates: STRAIGHT, startM: 100, endM: 300, totalWidthM: 10, laneCount: 2 });
  assert.ok(Math.abs(q.proposed.affectedLengthM.value - 200) < 0.05);
  assert.ok(Math.abs(q.baseline.totalLengthM.value - 400) < 0.05);
  assert.equal(q.baseline.totalLengthM.provenance, PROVENANCE.MEASURED_GIS);
});

test('every reported figure carries where it came from', () => {
  const q = wideningQuantities({ coordinates: STRAIGHT, totalWidthM: 10, laneCount: 2 });
  for (const group of [q.baseline, q.proposed, q.difference]) {
    for (const [key, entry] of Object.entries(group)) {
      assert.ok(Object.values(PROVENANCE).includes(entry.provenance), `${key}: ${entry.provenance}`);
    }
  }
});

// ---- validation -------------------------------------------------------------------------------------

test('zero, negative and absurd widths are refused', () => {
  for (const width of [0, -5, Number.NaN, 400]) {
    const check = validateWidening({ coordinates: STRAIGHT, totalWidthM: width, laneCount: 2 });
    assert.equal(check.ok, false, `width ${width} was accepted`);
  }
});

test('a lane count must be a whole number of at least one', () => {
  for (const lanes of [0, -2, 2.5, 99]) {
    assert.equal(validateWidening({ coordinates: STRAIGHT, totalWidthM: 10, laneCount: lanes }).ok,
      false, `lanes ${lanes} were accepted`);
  }
});

test('a section shorter than the minimum is refused, with the measurement', () => {
  const check = validateWidening({
    coordinates: STRAIGHT, startM: 100, endM: 102, totalWidthM: 10, laneCount: 2,
  });
  assert.equal(check.ok, false);
  assert.ok(check.errors.some(e => new RegExp(`minimum is ${MIN_SECTION_M}`).test(e)),
    check.errors.join(' | '));
});

test('no road selected is refused by name', () => {
  assert.ok(validateWidening({ coordinates: null, totalWidthM: 10, laneCount: 2 })
    .errors.some(e => /No road is selected/.test(e)));
});

test('a narrowing is flagged as an advisory, not refused', () => {
  const check = validateWidening({
    coordinates: STRAIGHT, totalWidthM: 6, laneCount: 2, baselineWidthM: 9,
  });
  assert.equal(check.ok, true);
  assert.ok(check.advisories.some(a => /narrowing, not a widening/.test(a)));
});

test('a lane advisory states the assumption it used rather than citing a standard', () => {
  const check = validateWidening({ coordinates: STRAIGHT, totalWidthM: 10, laneCount: 4 });
  assert.equal(check.ok, true, 'it is advisory, not blocking');
  const advisory = check.advisories.find(a => /per lane/.test(a));
  assert.ok(advisory, check.advisories.join(' | '));
  assert.match(advisory, new RegExp(String(ASSUMED_LANE_WIDTH_M)));
  assert.match(advisory, /holds no design standard/);
});

test('the defaults are the ones the brief asked for, and are just defaults', () => {
  assert.equal(DEFAULT_PROPOSED_WIDTH_M, 10);
  assert.equal(DEFAULT_PROPOSED_LANES, 2);
  const q = wideningQuantities({ coordinates: STRAIGHT });
  assert.equal(q.proposed.totalWidthM.value, 10);
  assert.equal(q.proposed.lanes.value, 2);
  assert.equal(q.proposed.totalWidthM.provenance, PROVENANCE.USER_ASSUMED,
    'a default is an assumption, not a measurement');
});
