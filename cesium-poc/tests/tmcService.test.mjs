/**
 * The TMC's single deterministic answer service.
 *
 * The screen and Ask the Twin both read this, so what it says is what the operator sees in both
 * places. These cover the answers that matter most: the ranking, the honest empty corridor, and the
 * separation between Operational Impact and secondary risk.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARRIAGEWAYS } from '../src/liveOps/carriagewayModel.js';
import { assessCorridor, getHighestSecondaryRiskIncident, TMC_FILTERS } from '../src/tmc/tmcService.js';
import { UPSTREAM_STATUS } from '../src/tmc/upstreamResolver.js';

const NOW = Date.parse('2026-10-05T12:00:00Z');

/** Sections and centreline from the shipped corridor, so spatial behaviour is the real thing. */
const GEO = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url)));
const SECTIONS = GEO.features.map(f => {
  const p = f.properties;
  return {
    segmentId: p.segment_id,
    sectionId: `SECTION_${String(p.fdot_segment_index).padStart(2, '0')}`,
    sectionIndex: p.fdot_segment_index,
    sectionLabel: `${p.direction === 'WB' ? 'Westbound' : 'Eastbound'} Section ${String(p.fdot_segment_index).padStart(2, '0')}`,
    carriageway: p.direction === 'WB' ? CARRIAGEWAYS.WB_GENERAL : CARRIAGEWAYS.EB_GENERAL,
    travelOrder: p.travel_order,
    coordinates: f.geometry.coordinates,
  };
});
const CENTERLINE = GEO.features
  .filter(f => f.properties.direction === 'EB')
  .sort((a, b) => a.properties.travel_order - b.properties.travel_order)
  .flatMap(f => f.geometry.coordinates.map(([lon, lat]) => ({ lon, lat })));

const sectionAt = index => SECTIONS.find(s => s.carriageway === CARRIAGEWAYS.EB_GENERAL && s.sectionIndex === index);
const midpoint = section => section.coordinates[Math.floor(section.coordinates.length / 2)];

const event = (type, index, extra = {}) => {
  const section = sectionAt(index);
  const [lon, lat] = midpoint(section);
  return {
    id: extra.id ?? `${type}-${index}`, type, cleared: false,
    title: type === 'INCIDENT' ? 'Crash' : type, severity: extra.severity ?? 'Minor',
    longitude: lon, latitude: lat,
    sdna: { reported_at: new Date(NOW - (extra.minutesAgo ?? 5) * 60_000).toISOString() },
    liveOps: {
      carriageway: CARRIAGEWAYS.EB_GENERAL, direction: 'EB',
      sectionId: section.sectionId, sectionIndex: section.sectionIndex,
      sectionLabel: section.sectionLabel, segmentId: section.segmentId,
      spatialMatch: { confidence: 'HIGH' },
      laneImpact: extra.lanes ?? { blockedLanes: null, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'none' },
    },
  };
};

const context = { sections: SECTIONS, centerline: CENTERLINE, cameras: [], signs: [], now: NOW };

test('an empty corridor is a real answer, not an error', () => {
  const assessed = assessCorridor([], context);
  assert.deepEqual(assessed.incidents, []);
  assert.equal(assessed.highestRiskIncident, null);
  assert.equal(assessed.counts.activeIncidents, 0);

  const answer = getHighestSecondaryRiskIncident([], context);
  assert.equal(answer.available, false);
  assert.match(answer.reason, /No active I-595 incidents/);
  assert.equal(answer.counts.activeIncidents, 0);
});

test('congestion upstream of an incident is attributed; congestion past it is not', () => {
  const lanes = { blockedLanes: 1, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'parsed' };
  const assessed = assessCorridor([
    event('INCIDENT', 4, { id: 'INC-4', lanes }),
    event('CONGESTION', 3, { id: 'CON-upstream' }),
    event('CONGESTION', 6, { id: 'CON-downstream' }),
  ], context);
  const [entry] = assessed.assessments;
  assert.equal(entry.upstream.status, UPSTREAM_STATUS.RESOLVED);
  assert.deepEqual(entry.upstreamCongestion.map(e => e.id), ['CON-upstream'],
    'eastbound: section 3 is upstream of section 4, section 6 is not');
  assert.equal(assessed.counts.upstreamCongestion, 1);
});

test('the highest-risk incident is the one with the most evidence behind it', () => {
  const lanes = { blockedLanes: 2, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'parsed' };
  const assessed = assessCorridor([
    event('INCIDENT', 2, { id: 'INC-quiet' }),
    event('INCIDENT', 4, { id: 'INC-bad', lanes, severity: 'Major', minutesAgo: 90 }),
    event('CONGESTION', 3, { id: 'CON-1' }),
  ], context);
  assert.equal(assessed.highestRiskIncident.id, 'INC-bad');
  assert.ok(assessed.risk.score > 0);
  assert.equal(assessed.counts.activeIncidents, 2);
  // The quiet one is still assessed and still on the list — ranking never drops an incident.
  assert.equal(assessed.ranked.length, 2);
});

test('Operational Impact and secondary risk stay different numbers', () => {
  const assessed = assessCorridor([event('INCIDENT', 4, { id: 'INC-1', severity: 'Major' })], context);
  const [entry] = assessed.assessments;
  // The section carries an impact level from the corridor's own module...
  assert.ok(entry.impactLevel === null || typeof entry.impactLevel === 'string');
  // ...and the risk score is its own figure, built from its own factors.
  assert.equal(entry.risk.score, entry.risk.factors.reduce((t, f) => t + f.contribution, 0));
  assert.ok(entry.risk.factors.some(f => f.type === 'OPERATIONAL_IMPACT'), 'impact is one factor among several');
});

test('an Express incident is assessed and shown, with upstream unresolved', () => {
  const express = event('INCIDENT', 4, { id: 'INC-express' });
  express.liveOps.carriageway = CARRIAGEWAYS.EXPRESS;
  express.liveOps.sectionId = null;
  express.liveOps.sectionIndex = null;
  const assessed = assessCorridor([express], context);
  assert.equal(assessed.incidents.length, 1, 'never hidden');
  const [entry] = assessed.assessments;
  assert.equal(entry.upstream.status, UPSTREAM_STATUS.UNRESOLVED);
  assert.match(entry.upstream.reason, /Express/);
  assert.equal(assessed.counts.upstreamUnresolved, 1);
  assert.ok(entry.mitigation.some(m => /cannot be assessed/i.test(m.text)));
});

test('the KPI filters narrow the same list rather than changing the data', () => {
  const lanes = { blockedLanes: 1, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'parsed' };
  const assessed = assessCorridor([
    event('INCIDENT', 2, { id: 'INC-quiet' }),
    event('INCIDENT', 4, { id: 'INC-lanes', lanes }),
    event('CONGESTION', 3),
  ], context);
  const all = assessed.assessments.filter(TMC_FILTERS.all.match);
  const closures = assessed.assessments.filter(TMC_FILTERS.closures.match);
  assert.equal(all.length, 2);
  assert.deepEqual(closures.map(e => e.incident.id), ['INC-lanes']);
  assert.equal(assessed.assessments.length, 2, 'filtering reads the list, it does not shrink it');
});

test('upstream resources are offered only when upstream is resolved', () => {
  const cameras = [{ id: 'CAM-up', ...Object.fromEntries(['longitude', 'latitude'].map((k, i) => [k, midpoint(sectionAt(3))[i]])) }];
  const withDirection = assessCorridor([event('INCIDENT', 4, { id: 'INC-1' })], { ...context, cameras });
  assert.equal(withDirection.assessments[0].resources.camera?.id, 'CAM-up');

  const unknown = event('INCIDENT', 4, { id: 'INC-2' });
  unknown.liveOps.carriageway = CARRIAGEWAYS.UNKNOWN;
  unknown.liveOps.sectionIndex = null;
  const without = assessCorridor([unknown], { ...context, cameras });
  assert.equal(without.assessments[0].resources.camera, null, 'no direction, no upstream camera');
});

test('a cleared incident is history and is not assessed', () => {
  const cleared = { ...event('INCIDENT', 4, { id: 'INC-done' }), cleared: true, clearedAt: new Date(NOW).toISOString() };
  assert.equal(assessCorridor([cleared], context).counts.activeIncidents, 0);
});
