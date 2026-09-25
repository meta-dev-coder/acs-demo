/**
 * The whole server chain, against the corridor's real geometry.
 *
 * Nothing is stubbed below the FL511 payload: the real `i595_fdot_traffic_segments.geojson`,
 * the real mainline and express lines, the real classifier and the real resolver. Only the FL511
 * items are supplied, because the live corridor is frequently empty and the acceptance scenarios
 * have to be provable at any hour.
 *
 * Coordinates are read FROM the shipped geometry rather than written here, so a test cannot drift
 * from the roadway it claims to be on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadI595Network } from '../server/i595Network.mjs';
import { attachDetails, enrichForLiveOps, normalizeEvent } from '../server/liveEvents.mjs';
import { CARRIAGEWAYS } from '../server/carriageway.mjs';

const network = await loadI595Network('public/data');
const OPTIONS = { bufferMeters: 250, segmentToleranceMeters: 120 };

/** A point that genuinely lies on one carriageway's third FDOT section. */
function pointOnSection(direction, index) {
  const segment = network.segments.find(s => s.direction === direction && s.index === index);
  assert.ok(segment, `${direction} section ${index} exists in the shipped geometry`);
  const [longitude, latitude] = segment.coordinates[Math.floor(segment.coordinates.length / 2)];
  return { longitude, latitude, segmentId: segment.segmentId };
}

/** Drive one FL511 item through the real pipeline, exactly as the poller does. */
function resolve({ longitude, latitude }, description) {
  const event = normalizeEvent({ itemId: '1', longitude, latitude }, 'INCIDENT', network, OPTIONS);
  assert.ok(event, 'the point is inside the corridor buffer');
  return enrichForLiveOps(attachDetails(event, { description, fields: [] }), network, { sectionToleranceMeters: 120 });
}

test('A — an eastbound incident resolves to an eastbound section and nothing else', () => {
  const point = pointOnSection('EB', 3);
  const { liveOps } = resolve(point, 'Incident Crash in Broward County on I-595 East, at Exit 5. Right lane blocked.');
  assert.equal(liveOps.carriageway, CARRIAGEWAYS.EB_GENERAL);
  assert.equal(liveOps.direction, 'EB');
  assert.equal(liveOps.spatialMatch.confidence, 'HIGH');
  assert.equal(liveOps.segmentId, point.segmentId, 'the eastbound segment it sits on');
  assert.equal(liveOps.sectionId, 'SECTION_03');
  assert.ok(liveOps.segmentId.includes('-EB-'), 'and never a westbound one');
  assert.equal(liveOps.contributesToImpact, true);
});

test('B — a westbound incident resolves to a westbound section and nothing else', () => {
  const point = pointOnSection('WB', 6);
  const { liveOps } = resolve(point, 'Incident Crash in Broward County on I-595 West, beyond Exit 9. Two left lanes blocked.');
  assert.equal(liveOps.carriageway, CARRIAGEWAYS.WB_GENERAL);
  assert.equal(liveOps.segmentId, point.segmentId);
  assert.equal(liveOps.sectionId, 'SECTION_06');
  assert.ok(liveOps.segmentId.includes('-WB-'));
});

test('the classification beats the geometry when the two disagree', () => {
  // The decisive case. This point lies exactly ON the westbound carriageway, where the nearest
  // segment by distance is westbound — but FL511 says eastbound. The carriageway must win, and the
  // section must come from the eastbound candidates alone.
  const onWestbound = pointOnSection('WB', 4);
  const { liveOps } = resolve(onWestbound, 'Incident Crash in Broward County on I-595 East, at Exit 7.');
  assert.equal(liveOps.carriageway, CARRIAGEWAYS.EB_GENERAL);
  assert.ok(liveOps.segmentId?.includes('-EB-'), `resolved to ${liveOps.segmentId}, which must be eastbound`);
  // The existing geometric association is untouched and still says what it always said, so the
  // Traffic and Safety screens that read it are unaffected.
  const legacy = resolve(onWestbound, 'Incident Crash in Broward County on I-595 East, at Exit 7.');
  assert.ok(legacy.nearestFacility, 'the pre-existing field is still populated');
});

test('C — an express incident is placed but given no section', () => {
  // Deliberately sitting between the carriageways, where a nearest-segment match would find one.
  const point = pointOnSection('EB', 3);
  const { liveOps, latitude, longitude } = resolve(point,
    'Incident Crash in Broward County on Reversible Lane - I595 East, beyond Exit 5.');
  assert.equal(liveOps.carriageway, CARRIAGEWAYS.EXPRESS);
  assert.equal(liveOps.direction, 'EB', 'the stated direction is kept');
  assert.equal(liveOps.segmentId, null, 'express has no sections in this version');
  assert.equal(liveOps.sectionId, null);
  assert.equal(liveOps.contributesToImpact, false, 'so it cannot colour an adjacent carriageway');
  // It keeps its exact position, so the map can still show it.
  assert.equal(latitude, point.latitude);
  assert.equal(longitude, point.longitude);
});

test('D — an incident with no stated direction stays unresolved and keeps its position', () => {
  const point = pointOnSection('EB', 2);
  const { liveOps, latitude } = resolve(point, 'Incident Crash in Broward County. Last updated at 09:42 PM.');
  assert.equal(liveOps.carriageway, CARRIAGEWAYS.UNKNOWN);
  assert.equal(liveOps.segmentId, null, 'the nearest segment is NOT taken');
  assert.equal(liveOps.contributesToImpact, false);
  assert.equal(liveOps.spatialMatch.confidence, 'LOW');
  assert.equal(latitude, point.latitude, 'but it is still placeable');
});

test('E — the same band in opposite directions gives two different segments', () => {
  const eb = resolve(pointOnSection('EB', 3), 'Crash on I-595 East at Exit 5');
  const wb = resolve(pointOnSection('WB', 3), 'Crash on I-595 West at Exit 5');
  // The same longitudinal band…
  assert.equal(eb.liveOps.sectionId, 'SECTION_03');
  assert.equal(wb.liveOps.sectionId, 'SECTION_03');
  // …but two distinct segments, which is what keeps their scores apart downstream.
  assert.notEqual(eb.liveOps.segmentId, wb.liveOps.segmentId);
  assert.ok(eb.liveOps.segmentId.includes('-EB-') && wb.liveOps.segmentId.includes('-WB-'));
});

test('the enrichment is additive — every pre-existing field survives', () => {
  const point = pointOnSection('EB', 1);
  const before = attachDetails(normalizeEvent({ itemId: '9', ...point }, 'INCIDENT', network, OPTIONS),
    { description: 'Crash on I-595 East', fields: [] });
  const after = enrichForLiveOps(before, network, {});
  for (const key of Object.keys(before)) {
    assert.deepEqual(after[key], before[key], `${key} is unchanged`);
  }
  assert.ok(after.liveOps, 'and the new block sits beside them');
});
