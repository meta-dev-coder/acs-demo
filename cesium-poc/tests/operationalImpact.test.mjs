/**
 * Operational Impact scoring.
 *
 * The two properties that matter are isolation and restraint: the two directions of one corridor
 * band never share a score, and an event whose carriageway could not be evidenced never moves one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateImpact, eventScore, explainImpact, laneScore, levelFor, severityKey } from '../src/liveOps/operationalImpact.js';

const SECTIONS = [
  { sectionId: 'SECTION_03', sectionIndex: 3, sectionLabel: 'Eastbound Section 03', carriageway: 'EB_GENERAL', segmentId: 'EB-3' },
  { sectionId: 'SECTION_03', sectionIndex: 3, sectionLabel: 'Westbound Section 03', carriageway: 'WB_GENERAL', segmentId: 'WB-3' },
  { sectionId: 'SECTION_04', sectionIndex: 4, sectionLabel: 'Eastbound Section 04', carriageway: 'EB_GENERAL', segmentId: 'EB-4' },
];
const incident = (id, liveOps, severity) => ({ id, type: 'INCIDENT', title: 'Crash', severity, liveOps });

test('severity is used where FL511 states it and never invented where it does not', () => {
  assert.equal(severityKey('Major'), 'major');
  assert.equal(severityKey('severe delays'), 'major');
  assert.equal(severityKey('Moderate'), 'moderate');
  assert.equal(severityKey('Minor'), 'minor');
  // Unstated or unrecognised wording contributes nothing extra rather than a made-up middle value.
  assert.equal(severityKey(''), null);
  assert.equal(severityKey(undefined), null);
  assert.equal(severityKey('unspecified'), null);

  assert.equal(eventScore({ type: 'INCIDENT', severity: 'Major' }), 80, 'base plus severity');
  assert.equal(eventScore({ type: 'INCIDENT' }), 40, 'presence alone still counts');
});

test('the two directions of one band are scored apart', () => {
  const events = [
    incident('EB-INC', { carriageway: 'EB_GENERAL', segmentId: 'EB-3' }, 'Major'),
    incident('WB-INC', { carriageway: 'WB_GENERAL', segmentId: 'WB-3' }),
  ];
  const { bySegmentId } = aggregateImpact(events, SECTIONS);
  // Same corridor band, opposite carriageways: each holds only its own incident.
  assert.deepEqual(bySegmentId.get('EB-3').incidents.map(e => e.id), ['EB-INC']);
  assert.deepEqual(bySegmentId.get('WB-3').incidents.map(e => e.id), ['WB-INC']);
  assert.equal(bySegmentId.get('EB-3').operationalScore, 80);
  assert.equal(bySegmentId.get('WB-3').operationalScore, 40);
  // And a band with nothing on it stays normal rather than inheriting a neighbour's colour.
  assert.equal(bySegmentId.get('EB-4').operationalLevel, 'NORMAL');
});

test('express and unresolved incidents never move a score', () => {
  const events = [
    incident('EXP', { carriageway: 'EXPRESS', segmentId: null }, 'Major'),
    incident('UNK', { carriageway: 'UNKNOWN', segmentId: null }, 'Major'),
    // Classified, but off every section of its carriageway — a ramp or interchange.
    incident('RAMP', { carriageway: 'EB_GENERAL', segmentId: null }, 'Major'),
    { id: 'NOT-SCORED', type: 'DMS', liveOps: { carriageway: 'EB_GENERAL', segmentId: 'EB-3' } },
  ];
  const { bySegmentId, excluded } = aggregateImpact(events, SECTIONS);
  for (const section of bySegmentId.values()) {
    assert.equal(section.operationalScore, 0, `${section.segmentId} stayed at zero`);
    assert.equal(section.operationalLevel, 'NORMAL');
  }
  assert.deepEqual(excluded, { express: 1, unknown: 1, unsectioned: 1, notScored: 1 });
});

test('every live event type contributes, weighted by what it actually blocks', () => {
  const lanes = n => ({ blockedLanes: n, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'parsed' });
  const on = (type, severity, laneImpact) =>
    ({ id: type, type, severity, liveOps: { carriageway: 'EB_GENERAL', segmentId: 'EB-3', laneImpact } });

  // A closure's weight is mostly its lanes: 20 base + 2 × 25.
  assert.equal(eventScore(on('CLOSURE', null, lanes(2))), 70);
  // A full closure outweighs any lane count.
  assert.equal(laneScore({ fullClosure: true, source: 'parsed' }), 90);
  // A ramp restricts access, not the through lanes, so it scores far below the carriageway.
  assert.equal(laneScore({ rampClosure: true, source: 'parsed' }), 8);
  // Said nothing about lanes: adds nothing rather than a default.
  assert.equal(laneScore({ source: 'none' }), 0);

  // A stopped vehicle must stay lighter than a major crash and a multi-lane closure.
  assert.ok(eventScore(on('DISABLED')) < eventScore(on('INCIDENT', 'Major')));
  assert.ok(eventScore(on('DISABLED')) < eventScore(on('CLOSURE', null, lanes(2))));
  // Planned work is not assumed severe.
  assert.ok(eventScore(on('CONSTRUCTION')) < eventScore(on('INCIDENT')));

  // And they accumulate on the section they share.
  const { bySegmentId } = aggregateImpact([on('CLOSURE', null, lanes(2)), on('CONSTRUCTION')], SECTIONS);
  const section = bySegmentId.get('EB-3');
  assert.equal(section.operationalScore, 82);
  assert.equal(section.operationalLevel, 'HIGH');
  assert.deepEqual(section.byType, { INCIDENT: 0, CLOSURE: 1, CONSTRUCTION: 1, CONGESTION: 0, DISABLED: 0 });
});

test('levels rise with the score', () => {
  assert.equal(levelFor(0), 'NORMAL');
  assert.equal(levelFor(40), 'MODERATE');
  assert.equal(levelFor(80), 'HIGH');
  assert.equal(levelFor(160), 'SEVERE');
  assert.equal(levelFor(1), 'LOW');
});

test('a coloured section can always say why', () => {
  const events = [
    incident('INC-100', { carriageway: 'EB_GENERAL', segmentId: 'EB-3' }, 'Major'),
    incident('INC-108', { carriageway: 'EB_GENERAL', segmentId: 'EB-3' }),
  ];
  const { bySegmentId } = aggregateImpact(events, SECTIONS);
  const why = explainImpact(bySegmentId.get('EB-3'));
  assert.equal(why.summary, '2 incidents');
  // Heaviest first, so the reason at the top is the reason.
  assert.deepEqual(why.reasons.map(r => r.id), ['INC-100', 'INC-108']);
  assert.equal(why.reasons[0].points, 80);
  // A quiet section says so rather than showing an empty explanation.
  assert.equal(explainImpact(bySegmentId.get('EB-4')).summary, 'Nothing active on this section.');
});

test('an incident card says which carriageway and section it is on', async () => {
  const { liveOpsPlace } = await import('../src/assetExplorer/assetTypes.js');
  const asset = liveOps => ({ source: { liveOps } });
  assert.equal(liveOpsPlace(asset({ carriageway: 'EB_GENERAL', sectionLabel: 'Eastbound Section 03' })), 'Eastbound Section 03');
  assert.equal(liveOpsPlace(asset({ carriageway: 'EXPRESS', direction: 'EB' })), 'I-595 Express · EB');
  // Reversible and unstated — no direction is shown rather than a default one.
  assert.equal(liveOpsPlace(asset({ carriageway: 'EXPRESS', direction: null })), 'I-595 Express');
  assert.equal(liveOpsPlace(asset({ carriageway: 'UNKNOWN' })), 'Carriageway unresolved');
  // Not enriched: the caller keeps whatever it showed before.
  assert.equal(liveOpsPlace({ source: {} }), null);
  assert.equal(liveOpsPlace(null), null);
});


test('rejects mismatched direction, low confidence, and explicitly excluded records', () => {
  const events = [
    incident('wrong-direction', { carriageway: 'WB_GENERAL', segmentId: 'EB-3' }),
    incident('low-confidence', { carriageway: 'EB_GENERAL', segmentId: 'EB-3', spatialMatch: { confidence: 'LOW' } }),
    incident('excluded', { carriageway: 'EB_GENERAL', segmentId: 'EB-3', contributesToImpact: false }),
  ];
  assert.ok(aggregateImpact(events, SECTIONS).sections.every(section => section.score === 0));
});

test('all event arrays and reasons refresh without retaining disappeared events', () => {
  const events = ['INCIDENT', 'CLOSURE', 'DISABLED', 'CONGESTION', 'CONSTRUCTION'].map(type => ({
    id: type, type, description: 'Actual source words', liveOps: { carriageway: 'EB_GENERAL', segmentId: 'EB-3' },
  }));
  const section = aggregateImpact(events, SECTIONS).bySegmentId.get('EB-3');
  for (const field of ['incidents', 'closures', 'disabledVehicles', 'congestion', 'construction']) assert.equal(section[field].length, 1);
  assert.equal(section.reasons.length, 5);
  assert.equal(section.reasons[0].description, 'Actual source words');
  assert.equal(aggregateImpact([], SECTIONS).bySegmentId.get('EB-3').level, 'NORMAL');
});
