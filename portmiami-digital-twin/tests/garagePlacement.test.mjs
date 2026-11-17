/**
 * The parametric garage placement: its coordinate frame, its edits, and what it refuses.
 *
 * The frame is the part worth testing hardest. A rectangle laid out in degrees looks right on a
 * north-up screenshot and is wrong everywhere else, and that is precisely the bug this module
 * replaced. So the tests check metres, not degrees: a 60 x 40 m building must measure 60 by 40
 * on the ground at any heading, and rotating it must not move its centre or change its size.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_HEIGHT_SOURCE, GEOMETRY_SOURCE, PLACEMENT_LIMITS, SNAP_TOLERANCE_DEG,
  buildingToEnu, capacityFeasibility, createPlacement, ecefToGeodetic, enuToBuilding, enuToLonLat,
  footprintAreaM2, geodeticToEcef, grossFloorAreaM2, lonLatToEnu, movePlacement, normaliseHeading,
  placementHandles, placementRing, resizePlacementTo, rotatePlacementToward, snapHeading,
  totalHeightM, validatePlacement, nudgePlacement, NUDGE_STEPS_M, PLACEMENT_KIND, isSurfaceLot,
} from '../src/scenarios/garagePlacement.js';

const SITE = [-80.1731, 25.7795];
const base = patch => createPlacement({ point: SITE, now: () => '2026-01-01T00:00:00.000Z', ...patch });
/** Ground distance between two [lon, lat], through the same ENU pair the module uses. */
const metresBetween = (a, b) => Math.hypot(...lonLatToEnu(a, b));

// ---- the coordinate frame --------------------------------------------------------------------

test('geodetic and ECEF are inverses of each other', () => {
  const [lon, lat, height] = ecefToGeodetic(geodeticToEcef(SITE[0], SITE[1], 37.5));
  assert.ok(Math.abs(lon - SITE[0]) < 1e-9, `lon ${lon}`);
  assert.ok(Math.abs(lat - SITE[1]) < 1e-9, `lat ${lat}`);
  assert.ok(Math.abs(height - 37.5) < 1e-6, `height ${height}`);
});

test('a metre east is a metre east, and a metre north is a metre north', () => {
  assert.ok(Math.abs(metresBetween(SITE, enuToLonLat(SITE, 100, 0)) - 100) < 1e-6);
  assert.ok(Math.abs(metresBetween(SITE, enuToLonLat(SITE, 0, 100)) - 100) < 1e-6);
  // East moves east and north moves north, each with no cross-component worth a millimetre.
  const east = enuToLonLat(SITE, 100, 0), north = enuToLonLat(SITE, 0, 100);
  assert.ok(east[0] > SITE[0] && Math.abs(lonLatToEnu(SITE, east)[1]) < 1e-3, JSON.stringify(east));
  assert.ok(north[1] > SITE[1] && Math.abs(lonLatToEnu(SITE, north)[0]) < 1e-3, JSON.stringify(north));
});

test('a degree of longitude is NOT a degree of latitude at this latitude', () => {
  // The bug the ENU frame exists to prevent: the old pad used one metres-per-degree constant for
  // latitude and a cosine-corrected one for longitude, applied to a square in degrees.
  const [eastM] = lonLatToEnu(SITE, [SITE[0] + 0.001, SITE[1]]);
  const [, northM] = lonLatToEnu(SITE, [SITE[0], SITE[1] + 0.001]);
  assert.ok(eastM < northM * 0.95, `${eastM} vs ${northM}`);
});

test('ENU and lon/lat round-trip', () => {
  for (const [e, n] of [[0, 0], [250, -80], [-1000, 1000], [12.5, 7.25]]) {
    const [backE, backN] = lonLatToEnu(SITE, enuToLonLat(SITE, e, n));
    // A tangent-plane frame, so a kilometre out round-trips to within a tenth of a millimetre.
    assert.ok(Math.abs(backE - e) < 1e-3 && Math.abs(backN - n) < 1e-3, `${backE},${backN}`);
  }
});

test('heading is clockwise from north, along the length axis', () => {
  // 0 deg: length runs north. 90 deg: length runs east. Width is 90 deg clockwise of length.
  const [e0, n0] = buildingToEnu(0, 10, 0);
  assert.ok(Math.abs(e0) < 1e-9 && Math.abs(n0 - 10) < 1e-9, `${e0},${n0}`);
  const [e90, n90] = buildingToEnu(90, 10, 0);
  assert.ok(Math.abs(e90 - 10) < 1e-9 && Math.abs(n90) < 1e-9, `${e90},${n90}`);
  const [eW, nW] = buildingToEnu(0, 0, 10);
  assert.ok(Math.abs(eW - 10) < 1e-9 && Math.abs(nW) < 1e-9, `${eW},${nW}`);
});

test('the building frame round-trips through ENU at any heading', () => {
  for (const heading of [0, 17, 90, 183, 271, 359]) {
    const [east, north] = buildingToEnu(heading, 31, -12);
    const [along, across] = enuToBuilding(heading, east, north);
    assert.ok(Math.abs(along - 31) < 1e-9 && Math.abs(across + 12) < 1e-9, `${heading}: ${along},${across}`);
  }
});

// ---- the rectangle ----------------------------------------------------------------------------

test('the ring is a closed rectangle of the stated size, at any heading', () => {
  for (const headingDeg of [0, 30, 45, 137, 300]) {
    const ring = placementRing(base({ lengthM: 60, widthM: 40, headingDeg }));
    assert.equal(ring.length, 5, 'four corners, closed');
    assert.deepEqual(ring[0], ring[4]);
    const sides = [0, 1, 2, 3].map(i => metresBetween(ring[i], ring[i + 1]));
    assert.ok(Math.abs(sides[0] - 40) < 0.02, `${headingDeg}: width side ${sides[0]}`);
    assert.ok(Math.abs(sides[1] - 60) < 0.02, `${headingDeg}: length side ${sides[1]}`);
    assert.ok(Math.abs(sides[2] - 40) < 0.02, `${headingDeg}: width side ${sides[2]}`);
    assert.ok(Math.abs(sides[3] - 60) < 0.02, `${headingDeg}: length side ${sides[3]}`);
    // Diagonals equal: it is a rectangle, not a parallelogram.
    assert.ok(Math.abs(metresBetween(ring[0], ring[2]) - metresBetween(ring[1], ring[3])) < 0.02);
  }
});

test('a placement with no centre has no ring', () => {
  assert.equal(placementRing(createPlacement({})), null);
  assert.equal(placementRing(null), null);
});

test('rotating keeps the centre, the length and the width', () => {
  const before = base({ lengthM: 80, widthM: 35, headingDeg: 0 });
  const after = rotatePlacementToward(before, enuToLonLat(SITE, 100, 100), { snap: false });
  assert.ok(Math.abs(after.headingDegrees - 45) < 0.01, `${after.headingDegrees}`);
  assert.equal(after.centerLongitude, before.centerLongitude);
  assert.equal(after.centerLatitude, before.centerLatitude);
  assert.equal(after.lengthM, 80);
  assert.equal(after.widthM, 35);
});

test('a drag that lands on the centre is not read as an angle', () => {
  const before = base({ headingDeg: 20 });
  assert.equal(rotatePlacementToward(before, SITE, { snap: false }), before);
});

test('snapping takes the nearest listed angle, and only when close to it', () => {
  assert.equal(snapHeading(43, { enabled: true }), 45);
  assert.equal(snapHeading(43, { enabled: false }), 43);
  assert.equal(snapHeading(38, { enabled: true }), 38, 'outside the tolerance, left alone');
  assert.equal(snapHeading(358, { enabled: true }), 0, 'wraps across north');
  assert.ok(SNAP_TOLERANCE_DEG > 0);
});

test('headings wrap into 0-360', () => {
  assert.equal(normaliseHeading(-90), 270);
  assert.equal(normaliseHeading(450), 90);
  assert.equal(normaliseHeading(Number.NaN), 0);
});

// ---- the edits ---------------------------------------------------------------------------------

test('moving changes the centre and nothing else', () => {
  const before = base({ lengthM: 60, widthM: 40, headingDeg: 30 });
  const after = movePlacement(before, [-80.17, 25.78]);
  assert.equal(after.centerLongitude, -80.17);
  assert.equal(after.centerLatitude, 25.78);
  assert.equal(after.headingDegrees, before.headingDegrees);
  assert.equal(after.lengthM, before.lengthM);
  assert.equal(after.widthM, before.widthM);
});

test('a length handle changes the length, keeps the width, about a fixed centre', () => {
  const before = base({ lengthM: 60, widthM: 40, headingDeg: 55 });
  const handle = placementHandles(before).find(h => h.id === 'length-plus');
  // Drag the handle out to 50 m along the length axis: the length becomes 100.
  const [east, north] = buildingToEnu(before.headingDegrees, 50, 0);
  const after = resizePlacementTo(before, handle, enuToLonLat(SITE, east, north));
  assert.ok(Math.abs(after.lengthM - 100) < 0.02, `${after.lengthM}`);
  assert.equal(after.widthM, 40);
  assert.equal(after.headingDegrees, before.headingDegrees);
  assert.equal(after.centerLongitude, before.centerLongitude);
  assert.equal(after.centerLatitude, before.centerLatitude);
});

test('a width handle changes the width and keeps the length', () => {
  const before = base({ lengthM: 60, widthM: 40, headingDeg: 55 });
  const handle = placementHandles(before).find(h => h.id === 'width-plus');
  const [east, north] = buildingToEnu(before.headingDegrees, 0, 15);
  const after = resizePlacementTo(before, handle, enuToLonLat(SITE, east, north));
  assert.ok(Math.abs(after.widthM - 30) < 0.02, `${after.widthM}`);
  assert.equal(after.lengthM, 60);
});

test('a corner handle changes both', () => {
  const before = base({ lengthM: 60, widthM: 40, headingDeg: 0 });
  const handle = placementHandles(before).find(h => h.id === 'corner-ne');
  const after = resizePlacementTo(before, handle, enuToLonLat(SITE, 25, 45));
  assert.ok(Math.abs(after.lengthM - 90) < 0.02, `${after.lengthM}`);
  assert.ok(Math.abs(after.widthM - 50) < 0.02, `${after.widthM}`);
});

test('a drag past the limit stops at the limit instead of inverting the building', () => {
  const before = base({ lengthM: 60, widthM: 40, headingDeg: 0 });
  const handle = placementHandles(before).find(h => h.id === 'length-plus');
  const tiny = resizePlacementTo(before, handle, enuToLonLat(SITE, 0, 0.1));
  assert.equal(tiny.lengthM, PLACEMENT_LIMITS.lengthM.min);
  const huge = resizePlacementTo(before, handle, enuToLonLat(SITE, 0, 5000));
  assert.equal(huge.lengthM, PLACEMENT_LIMITS.lengthM.max);
});

test('the handles sit where the building is, and the rotation handle stands clear of it', () => {
  const placement = base({ lengthM: 60, widthM: 40, headingDeg: 0 });
  const handles = placementHandles(placement);
  assert.deepEqual(handles.map(h => h.kind).filter((k, i, a) => a.indexOf(k) === i),
    ['MOVE', 'LENGTH', 'WIDTH', 'CORNER', 'ROTATE']);
  const move = handles.find(h => h.id === 'move');
  assert.ok(metresBetween(move.point, SITE) < 1e-6, 'the move handle is the centre');
  const rotate = handles.find(h => h.kind === 'ROTATE');
  assert.ok(metresBetween(rotate.point, SITE) > 30 + 1, 'outside the footprint');
});

test('the handles follow the heading', () => {
  const north = placementHandles(base({ lengthM: 60, widthM: 40, headingDeg: 0 }))
    .find(h => h.id === 'length-plus').point;
  const east = placementHandles(base({ lengthM: 60, widthM: 40, headingDeg: 90 }))
    .find(h => h.id === 'length-plus').point;
  assert.ok(north[1] > SITE[1] && Math.abs(north[0] - SITE[0]) < 1e-9, 'heading 0 puts it north');
  assert.ok(east[0] > SITE[0] && Math.abs(east[1] - SITE[1]) < 1e-9, 'heading 90 puts it east');
});

// ---- what a placement implies -------------------------------------------------------------------

test('areas and heights are the stated products', () => {
  const placement = base({ lengthM: 60, widthM: 40, floors: 6, floorHeightM: 3.2 });
  assert.equal(footprintAreaM2(placement), 2400);
  assert.equal(grossFloorAreaM2(placement), 14400);
  assert.ok(Math.abs(totalHeightM(placement) - 19.2) < 1e-9);
});

test('capacity is estimated from the geometry and never overwrites the target', () => {
  const placement = base({ lengthM: 60, widthM: 40, floors: 6 });
  const feasibility = capacityFeasibility(placement, { targetSpaces: 2000, grossAreaPerSpaceM2: 32 });
  assert.equal(feasibility.grossFloorAreaM2, 14400);
  assert.equal(feasibility.estimatedSpaces, 450);
  assert.equal(feasibility.targetSpaces, 2000, 'the target is reported back unchanged');
  assert.equal(feasibility.differenceSpaces, -1550);
  assert.equal(feasibility.meetsTarget, false);
  assert.equal(feasibility.usesTargetInSimulation, true,
    'the simulation still runs on the requested figure, and says so');
});

test('resizing moves the estimate, not the target', () => {
  const small = capacityFeasibility(base({ lengthM: 60, widthM: 40, floors: 6 }),
    { targetSpaces: 2000, grossAreaPerSpaceM2: 32 });
  const large = capacityFeasibility(base({ lengthM: 160, widthM: 90, floors: 6 }),
    { targetSpaces: 2000, grossAreaPerSpaceM2: 32 });
  assert.equal(small.targetSpaces, large.targetSpaces);
  assert.ok(large.estimatedSpaces > small.estimatedSpaces);
  assert.equal(large.meetsTarget, true);
});

test('more floors means more estimated capacity, same target', () => {
  const six = capacityFeasibility(base({ lengthM: 120, widthM: 70, floors: 6 }),
    { targetSpaces: 2000, grossAreaPerSpaceM2: 32 });
  const ten = capacityFeasibility(base({ lengthM: 120, widthM: 70, floors: 10 }),
    { targetSpaces: 2000, grossAreaPerSpaceM2: 32 });
  assert.ok(ten.estimatedSpaces > six.estimatedSpaces);
  assert.equal(ten.targetSpaces, 2000);
});

test('a missing assumption is Not evaluated, never zero', () => {
  const feasibility = capacityFeasibility(base({}), { targetSpaces: 2000, grossAreaPerSpaceM2: 0 });
  assert.equal(feasibility.estimatedSpaces, null);
  assert.equal(feasibility.meetsTarget, null);
  assert.match(feasibility.reason, /Not evaluated/);
});

// ---- validation ---------------------------------------------------------------------------------

test('a fresh placement on a picked point is valid', () => {
  const check = validatePlacement(base({}));
  assert.equal(check.ok, true, check.errors.join(' | '));
});

test('zero, negative, NaN and infinite dimensions are all refused, with reasons', () => {
  for (const bad of [0, -20, Number.NaN, Number.POSITIVE_INFINITY]) {
    const check = validatePlacement(base({ lengthM: bad }));
    assert.equal(check.ok, false, `length ${bad} was accepted`);
    assert.ok(check.errors.some(e => /Length/.test(e)), check.errors.join(' | '));
  }
});

test('validation reports every problem at once, not the first', () => {
  const check = validatePlacement(base({ lengthM: 2, widthM: 2, floors: 0 }));
  assert.equal(check.ok, false);
  assert.ok(check.errors.length >= 3, check.errors.join(' | '));
});

test('a centre outside the study area is refused', () => {
  const check = validatePlacement(base({ point: [-0.12, 51.5] }));
  assert.equal(check.ok, false);
  assert.ok(check.errors.some(e => /study area/.test(e)), check.errors.join(' | '));
});

test('a placement with no centre is refused by name', () => {
  const check = validatePlacement(createPlacement({}));
  assert.equal(check.ok, false);
  assert.ok(check.errors.some(e => /no centre/.test(e)));
});

test('a placement says what it is and where its elevation came from', () => {
  const placement = base({});
  assert.equal(placement.geometrySource, GEOMETRY_SOURCE);
  assert.equal(placement.baseHeightSource, BASE_HEIGHT_SOURCE.UNKNOWN);
  assert.equal(placement.baseHeightM, null, 'no elevation is invented at pick time');
});

test('the starting size is a shape, not the capacity target', () => {
  // 60 x 40 x 6 floors is 450 spaces at 32 m²/space — nowhere near Scenario B's 2,000. That is
  // the point: the editor must not size the building to make the target come out right.
  const placement = base({});
  assert.equal(placement.lengthM, 60);
  assert.equal(placement.widthM, 40);
  const feasibility = capacityFeasibility(placement, { targetSpaces: 2000, grossAreaPerSpaceM2: 32 });
  assert.ok(feasibility.estimatedSpaces < 2000);
});

// ---- nudging ------------------------------------------------------------------------------------

test('a nudge moves the building by exactly the metres asked for', () => {
  const before = base({ lengthM: 60, widthM: 40, headingDeg: 0 });
  const forward = nudgePlacement(before, 10, 0);
  const [east, north] = lonLatToEnu(SITE, [forward.centerLongitude, forward.centerLatitude]);
  assert.ok(Math.abs(east) < 1e-3 && Math.abs(north - 10) < 1e-3, `${east}, ${north}`);
  assert.equal(forward.lengthM, 60);
  assert.equal(forward.widthM, 40);
  assert.equal(forward.headingDegrees, 0);
});

test('a nudge is in the building frame, so a rotated building moves along its own axes', () => {
  // Heading 90: forward is east, right is south.
  const turned = base({ headingDeg: 90 });
  const [east, north] = lonLatToEnu(SITE, (() => {
    const p = nudgePlacement(turned, 10, 0);
    return [p.centerLongitude, p.centerLatitude];
  })());
  assert.ok(Math.abs(east - 10) < 1e-3 && Math.abs(north) < 1e-3, `${east}, ${north}`);
  const right = nudgePlacement(turned, 0, 10);
  const [e2, n2] = lonLatToEnu(SITE, [right.centerLongitude, right.centerLatitude]);
  assert.ok(Math.abs(e2) < 1e-3 && Math.abs(n2 + 10) < 1e-3, `${e2}, ${n2}`);
});

test('forward then back returns the building to where it started', () => {
  const before = base({ headingDeg: 37 });
  const there = nudgePlacement(before, 25, 0);
  const back = nudgePlacement(there, -25, 0);
  const [east, north] = lonLatToEnu(SITE, [back.centerLongitude, back.centerLatitude]);
  assert.ok(Math.hypot(east, north) < 1e-3, `${east}, ${north}`);
});

test('nudging a placement with no centre does nothing rather than throwing', () => {
  const empty = createPlacement({});
  assert.equal(nudgePlacement(empty, 10, 0), empty);
});

test('the nudge steps are offered in metres, smallest first', () => {
  assert.deepEqual([...NUDGE_STEPS_M], [...NUDGE_STEPS_M].sort((a, b) => a - b));
  assert.ok(NUDGE_STEPS_M.every(step => step > 0));
});

// ---- surface lots -------------------------------------------------------------------------------

test('a surface lot is an area: no floors, no height', () => {
  const lot = base({ kind: PLACEMENT_KIND.SURFACE_LOT, floors: 6, floorHeightM: 3.2 });
  assert.equal(isSurfaceLot(lot), true);
  assert.equal(lot.floors, 0, 'floors are zeroed on the record, not just hidden in the UI');
  assert.equal(lot.floorHeightM, 0);
  assert.equal(totalHeightM(lot), 0);
});

test('a surface lot starts large enough to be a lot rather than a building plate', () => {
  const lot = base({ kind: PLACEMENT_KIND.SURFACE_LOT });
  assert.ok(lot.lengthM >= 160 && lot.widthM >= 90, `${lot.lengthM} x ${lot.widthM}`);
});

test('a surface lot does not stack: its parking area is its footprint', () => {
  const lot = base({ kind: PLACEMENT_KIND.SURFACE_LOT, lengthM: 200, widthM: 100 });
  assert.equal(footprintAreaM2(lot), 20000);
  assert.equal(grossFloorAreaM2(lot), 20000, 'not multiplied by a floor count of zero or one');
});

test('a surface lot is still moved, rotated and resized exactly like a building', () => {
  const lot = base({ kind: PLACEMENT_KIND.SURFACE_LOT, lengthM: 200, widthM: 100, headingDeg: 0 });
  const turned = rotatePlacementToward(lot, enuToLonLat(SITE, 100, 100), { snap: false });
  assert.ok(Math.abs(turned.headingDegrees - 45) < 0.01);
  assert.equal(turned.lengthM, 200);
  const nudged = nudgePlacement(lot, 10, 0);
  const [east, north] = lonLatToEnu(SITE, [nudged.centerLongitude, nudged.centerLatitude]);
  assert.ok(Math.abs(east) < 1e-3 && Math.abs(north - 10) < 1e-3);
  const handle = placementHandles(lot).find(h => h.id === 'width-plus');
  const [e, n] = buildingToEnu(0, 0, 60);
  assert.ok(Math.abs(resizePlacementTo(lot, handle, enuToLonLat(SITE, e, n)).widthM - 120) < 0.05);
});

test('a surface lot is valid with zero floors, which a building is not', () => {
  const lot = base({ kind: PLACEMENT_KIND.SURFACE_LOT });
  assert.equal(validatePlacement(lot).ok, true, validatePlacement(lot).errors.join(' | '));
  const building = base({ floors: 0 });
  assert.equal(validatePlacement(building).ok, false);
});

test("a surface lot's capacity comes from its land, at its own area-per-space assumption", () => {
  const lot = base({ kind: PLACEMENT_KIND.SURFACE_LOT, lengthM: 200, widthM: 100 });
  const feasibility = capacityFeasibility(lot, { targetSpaces: 1500, grossAreaPerSpaceM2: 28 });
  assert.equal(feasibility.grossFloorAreaM2, 20000);
  assert.equal(feasibility.estimatedSpaces, Math.floor(20000 / 28));
  assert.equal(feasibility.targetSpaces, 1500, 'the target is still never rewritten');
});
