/**
 * Upstream resolution — the part every TMC risk answer rests on.
 *
 * Upstream is travel order, not distance. Getting it backwards would point an operator at the road
 * the traffic has already left, so these pin the direction on both carriageways against the shipped
 * corridor's own ordering.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARRIAGEWAYS } from '../src/liveOps/carriagewayModel.js';
import { isUpstreamOf, upstreamOffsetM, upstreamSections, UPSTREAM_STATUS } from '../src/tmc/upstreamResolver.js';

/**
 * The corridor's real sections, built from the shipped FDOT geometry.
 *
 * Measured there: EB runs index 1..8 with travel_order 1..8, WB runs index 1..8 with travel_order
 * 8..1 — both published west to east. A fixture inventing its own ordering would prove nothing.
 */
const SECTIONS = (() => {
  const geo = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url)));
  return geo.features.map(feature => {
    const p = feature.properties;
    const carriageway = p.direction === 'WB' ? CARRIAGEWAYS.WB_GENERAL : CARRIAGEWAYS.EB_GENERAL;
    return {
      sectionId: `SECTION_${String(p.fdot_segment_index).padStart(2, '0')}`,
      sectionIndex: p.fdot_segment_index,
      sectionLabel: `${p.direction === 'WB' ? 'Westbound' : 'Eastbound'} Section ${String(p.fdot_segment_index).padStart(2, '0')}`,
      carriageway,
      travelOrder: p.travel_order,
    };
  });
})();

const at = (carriageway, sectionIndex) => ({ carriageway, sectionIndex });

test('the shipped corridor really does order the two carriageways differently', () => {
  // The fact the resolver depends on. If FDOT ever republishes these, this test says so first.
  const eb = SECTIONS.filter(s => s.carriageway === CARRIAGEWAYS.EB_GENERAL).sort((a, b) => a.sectionIndex - b.sectionIndex);
  const wb = SECTIONS.filter(s => s.carriageway === CARRIAGEWAYS.WB_GENERAL).sort((a, b) => a.sectionIndex - b.sectionIndex);
  assert.deepEqual(eb.map(s => s.travelOrder), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(wb.map(s => s.travelOrder), [8, 7, 6, 5, 4, 3, 2, 1]);
});

test('eastbound traffic arrives from the lower sections', () => {
  const upstream = upstreamSections(at(CARRIAGEWAYS.EB_GENERAL, 4), SECTIONS);
  assert.equal(upstream.status, UPSTREAM_STATUS.RESOLVED);
  assert.deepEqual(upstream.sections.map(s => s.sectionIndex), [3, 2], 'nearest first, back along the road');
});

test('westbound traffic arrives from the HIGHER sections', () => {
  // The one that would be wrong if upstream were taken as "index minus one" on both carriageways.
  const upstream = upstreamSections(at(CARRIAGEWAYS.WB_GENERAL, 4), SECTIONS);
  assert.equal(upstream.status, UPSTREAM_STATUS.RESOLVED);
  assert.deepEqual(upstream.sections.map(s => s.sectionIndex), [5, 6]);
});

test('the corridor ends rather than wrapping round', () => {
  const eb = upstreamSections(at(CARRIAGEWAYS.EB_GENERAL, 1), SECTIONS);
  assert.deepEqual(eb.sections, [], 'nothing is upstream of the first section a driver meets');
  const wb = upstreamSections(at(CARRIAGEWAYS.WB_GENERAL, 8), SECTIONS);
  assert.deepEqual(wb.sections, []);
});

test('Express is unresolved — its direction is never inferred', () => {
  const upstream = upstreamSections(at(CARRIAGEWAYS.EXPRESS, 4), SECTIONS);
  assert.equal(upstream.status, UPSTREAM_STATUS.UNRESOLVED);
  assert.match(upstream.reason, /Express/);
  assert.deepEqual(upstream.sections, []);
});

test('an unresolved carriageway yields no upstream rather than a guess', () => {
  const unknown = upstreamSections(at(CARRIAGEWAYS.UNKNOWN, 4), SECTIONS);
  assert.equal(unknown.status, UPSTREAM_STATUS.UNRESOLVED);
  assert.match(unknown.reason, /unresolved/i);
  // Placed on a carriageway but with no section: still nothing to walk.
  const noSection = upstreamSections(at(CARRIAGEWAYS.EB_GENERAL, null), SECTIONS);
  assert.equal(noSection.status, UPSTREAM_STATUS.UNRESOLVED);
});

test('an event is upstream only on the same carriageway, never by being close', () => {
  const incident = at(CARRIAGEWAYS.EB_GENERAL, 4);
  const upstream = upstreamSections(incident, SECTIONS);
  const ebQueue = { liveOps: { carriageway: CARRIAGEWAYS.EB_GENERAL, sectionId: 'SECTION_03' } };
  const wbQueue = { liveOps: { carriageway: CARRIAGEWAYS.WB_GENERAL, sectionId: 'SECTION_03' } };
  const ebAhead = { liveOps: { carriageway: CARRIAGEWAYS.EB_GENERAL, sectionId: 'SECTION_05' } };
  assert.equal(isUpstreamOf(ebQueue, incident, upstream), true);
  assert.equal(isUpstreamOf(wbQueue, incident, upstream), false, 'the far carriageway is not upstream');
  assert.equal(isUpstreamOf(ebAhead, incident, upstream), false, 'past the incident is not upstream');
});

test('nothing is upstream when upstream itself is unresolved', () => {
  const unresolved = { status: UPSTREAM_STATUS.UNRESOLVED, sectionIds: [] };
  const queue = { liveOps: { carriageway: CARRIAGEWAYS.EB_GENERAL, sectionId: 'SECTION_03' } };
  assert.equal(isUpstreamOf(queue, at(CARRIAGEWAYS.EB_GENERAL, 4), unresolved), false);
});

test('upstream distance is signed by travel, so downstream comes back negative', () => {
  // Eastbound: traffic comes from the lower milepost, so a resource behind it is positive.
  assert.equal(upstreamOffsetM(5000, 4000, CARRIAGEWAYS.EB_GENERAL), 1000);
  assert.equal(upstreamOffsetM(5000, 6000, CARRIAGEWAYS.EB_GENERAL), -1000, 'ahead of the incident');
  // Westbound runs the other way.
  assert.equal(upstreamOffsetM(5000, 6000, CARRIAGEWAYS.WB_GENERAL), 1000);
  assert.equal(upstreamOffsetM(5000, 4000, CARRIAGEWAYS.WB_GENERAL), -1000);
  assert.equal(upstreamOffsetM(5000, 4000, CARRIAGEWAYS.EXPRESS), null);
});
