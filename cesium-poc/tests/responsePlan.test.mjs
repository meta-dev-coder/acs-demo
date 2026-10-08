/**
 * Recommended attention, and the response timeline.
 *
 * The distinction worth protecting: a data gap is a reason to establish something, not a step an
 * operator can carry out. Listing "upstream cannot be assessed" as a mitigation action made the
 * list read as though the system had recommended doing nothing about it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendedAttention, responseTimeline } from '../src/tmc/responsePlan.js';
import { UPSTREAM_STATUS } from '../src/tmc/upstreamResolver.js';

const RESOLVED = { status: UPSTREAM_STATUS.RESOLVED, sections: [] };
const UNRESOLVED = { status: UPSTREAM_STATUS.UNRESOLVED, reason: 'Carriageway unresolved' };

const MITIGATION = [
  { id: 'review-closure', text: 'Review the lane closure status — 3 lanes blocked.', basis: 'LANE_CLOSURE' },
  { id: 'monitor-duration', text: 'Re-check the upstream approach — running 210 min.', basis: 'INCIDENT_DURATION' },
  { id: 'history-elevated', text: 'Treat this approach as a known cluster — 30 records.', basis: 'HISTORICAL_LOCATION' },
  { id: 'upstream-unresolved', text: 'Upstream conditions cannot be assessed — carriageway unresolved.', basis: 'UPSTREAM_UNRESOLVED' },
  { id: 'responder-unavailable', text: 'Responder status is not available from the connected data.', basis: 'UNAVAILABLE' },
];

test('recommendations are ranked, highest-bearing evidence first', () => {
  const ranked = recommendedAttention(MITIGATION, { upstream: UNRESOLVED });
  assert.deepEqual(ranked.map(item => item.priority),
    ['HIGH', 'HIGH', 'HIGH', 'MEDIUM', 'LOW']);
  assert.equal(ranked[0].action, 'Verify lane-closure status');
  // Last, because an unavailable field is the weakest call on an operator's attention.
  assert.equal(ranked.at(-1).action, 'Verify response status');
});

test('a data gap is an action to establish something, never a step already available', () => {
  const ranked = recommendedAttention(MITIGATION, { upstream: UNRESOLVED });
  const upstream = ranked.find(item => item.id === 'upstream-unresolved');
  assert.equal(upstream.action, 'Establish upstream conditions', 'an instruction, not a shrug');
  assert.ok(upstream.gap, 'and the gap behind it is carried separately');
  assert.match(upstream.gap, /carriageway unresolved/i);

  // A real action carries no gap.
  const closure = ranked.find(item => item.id === 'review-closure');
  assert.equal(closure.gap, null);
});

test('an unresolved upstream raises what depends on seeing upstream', () => {
  const blind = recommendedAttention(MITIGATION, { upstream: UNRESOLVED });
  const seeing = recommendedAttention(MITIGATION, { upstream: RESOLVED });
  assert.equal(blind.find(i => i.id === 'monitor-duration').priority, 'HIGH');
  assert.equal(seeing.find(i => i.id === 'monitor-duration').priority, 'MEDIUM');
});

test('equal priorities keep the order the mitigation engine chose', () => {
  const ranked = recommendedAttention(MITIGATION, { upstream: RESOLVED });
  const high = ranked.filter(item => item.priority === 'HIGH').map(item => item.id);
  assert.deepEqual(high, ['review-closure', 'upstream-unresolved'], 'stable within a priority');
});

test('an empty mitigation list is an empty plan, not an invented one', () => {
  assert.deepEqual(recommendedAttention([], { upstream: RESOLVED }), []);
  assert.deepEqual(recommendedAttention(null), []);
});

test('the timeline shows only stages the data evidences', () => {
  const at = Date.parse('2026-03-05T21:30:00Z');
  const timeline = responseTimeline({
    incident: { reportedAtMs: at, activeMinutes: 210, lanes: { stated: true }, clearedAtMs: null },
    risk: { factors: [{ type: 'LANE_CLOSURE', detail: '3 lanes blocked' }] },
    resources: { camera: null, sign: null }, upstream: UNRESOLVED, analysedAtMs: at + 210 * 60_000,
  });
  const byId = Object.fromEntries(timeline.stages.map(s => [s.id, s]));
  assert.equal(byId.detected.state, 'known');
  assert.equal(byId.detected.atMs, at);
  assert.equal(byId.assessed.state, 'known');
  assert.equal(byId.protected.state, 'known', 'a stated lane closure is evidence of lane protection');
  // Everything the feed cannot see stays unavailable — never "completed", never silently absent.
  assert.equal(byId.warned.state, 'unavailable');
  assert.equal(byId.responded.state, 'unavailable');
  assert.equal(byId.cleared.state, 'unavailable');
  assert.match(byId.responded.detail, /not available from the connected data/i);
  assert.equal(timeline.knownStages, 3);
  assert.equal(timeline.totalStages, 6);
});

test('an unknown start time is unavailable, not zero', () => {
  const timeline = responseTimeline({
    incident: { reportedAtMs: null, activeMinutes: null, lanes: { stated: false } },
    risk: { factors: [] }, resources: {}, upstream: UNRESOLVED, analysedAtMs: null,
  });
  const byId = Object.fromEntries(timeline.stages.map(s => [s.id, s]));
  assert.equal(byId.detected.state, 'unavailable');
  assert.equal(byId.detected.atMs, null);
  assert.match(byId.detected.detail, /not published/i);
  assert.equal(byId.protected.state, 'unavailable');
  assert.equal(timeline.knownStages, 0);
});

test('a resolved sign is named without claiming a warning was shown', () => {
  const timeline = responseTimeline({
    incident: { reportedAtMs: Date.now(), lanes: { stated: false } }, risk: { factors: [] },
    resources: { sign: { id: 'DMS-07' } }, upstream: { status: UPSTREAM_STATUS.RESOLVED }, analysedAtMs: Date.now(),
  });
  const warned = timeline.stages.find(s => s.id === 'warned');
  assert.equal(warned.state, 'unavailable', 'a nearby sign is not evidence that it warned anyone');
  assert.match(warned.detail, /DMS-07/);
  assert.match(warned.detail, /message content is not published/i);
});
