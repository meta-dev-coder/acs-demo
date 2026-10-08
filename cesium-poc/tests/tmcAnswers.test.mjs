/**
 * Ask the Twin's TMC answers.
 *
 * The point of these is that the ranking is NOT the model's to make. The question routes to the
 * deterministic service and the wording only reports what came back, so the chat and the screen can
 * never disagree about which incident is worst.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerTmcQuestion, parseTmcQuestion, TMC_INCIDENT_SUGGESTIONS, TMC_SUGGESTIONS } from '../src/tmc/tmcAnswers.js';
import { UPSTREAM_STATUS } from '../src/tmc/upstreamResolver.js';

const DEFAULT_INCIDENT = {
  id: 'INC-104', sectionLabel: 'Eastbound Section 04', carriageway: 'EB_GENERAL',
  activeMinutes: 24, segmentId: 'SEG-4', blocksTravelLanes: true,
};
const DEFAULT_RISK = {
  level: 'HIGH', levelLabel: 'High', score: 64,
  factors: [
    { type: 'LANE_CLOSURE', label: 'Lane closure or blockage', present: true, contribution: 18, detail: '1 lane blocked' },
    { type: 'UPSTREAM_CONGESTION', label: 'Upstream congestion', present: true, contribution: 30, detail: '1 congestion event upstream' },
    { type: 'INCIDENT_SEVERITY', label: 'Incident severity', present: false, contribution: 0, detail: 'Severity not published' },
  ],
  unavailableFactors: [{ type: 'RESPONDER_STATUS', label: 'Responder status', reason: 'Not available from the connected data' }],
};

/** `incident` and `risk` merge field by field; everything else an override gives replaces outright. */
const entry = (over = {}) => ({
  upstream: { status: UPSTREAM_STATUS.RESOLVED, reason: null, sections: [{ sectionId: 'SECTION_03', sectionLabel: 'Eastbound Section 03' }], sectionIds: ['SECTION_03'] },
  upstreamCongestion: [{ id: 'CON-1' }],
  impactLevel: 'HIGH',
  resources: {
    camera: { id: 'CAM-22', upstreamMeters: 320, upstreamMiles: 0.2, resource: { longitude: -80.23, latitude: 26.06 } },
    sign: { id: 'DMS-07', upstreamMeters: 1130, upstreamMiles: 0.7, resource: { longitude: -80.24, latitude: 26.06 } },
  },
  mitigation: [
    { id: 'verify-congestion', text: 'Verify upstream congestion using CAM-22.' },
    { id: 'responder-unavailable', text: 'Responder status is not available from the connected data.' },
  ],
  ...over,
  incident: { ...DEFAULT_INCIDENT, ...over.incident },
  risk: { ...DEFAULT_RISK, ...over.risk },
});

const assessed = (entries = [entry()]) => ({ assessments: entries, ranked: entries, tied: [], counts: {} });

test('the questions the screen offers are the ones it can answer', () => {
  for (const question of [...TMC_SUGGESTIONS, ...TMC_INCIDENT_SUGGESTIONS]) {
    assert.ok(parseTmcQuestion(question), `no route for: ${question}`);
  }
});

test('the primary question routes to the deterministic ranking', () => {
  assert.equal(parseTmcQuestion('Which active incident has the highest secondary-incident risk?'), 'HIGHEST_RISK');
  const answer = answerTmcQuestion('HIGHEST_RISK', assessed());
  assert.match(answer.answer, /Highest secondary-incident risk/);
  assert.match(answer.answer, /INC-104/);
  assert.match(answer.answer, /Eastbound Section 04/);
  assert.match(answer.answer, /Risk: High/);
  // The factors are the deterministic ones, reported — not reasoning the model did.
  assert.match(answer.answer, /Lane closure or blockage — 1 lane blocked/);
  assert.match(answer.answer, /Upstream congestion — 1 congestion event upstream/);
  assert.match(answer.answer, /Responder status is not available/);
  assert.equal(answer.incidentId, 'INC-104');
});

test('an answer offers the map actions it actually has somewhere to send', () => {
  const answer = answerTmcQuestion('HIGHEST_RISK', assessed());
  // A resource action names the resource it will fly to, so the operator knows before clicking.
  assert.deepEqual(answer.actions.map(a => a.label),
    ['View incident', 'View CAM-22', 'View DMS-07', 'Show affected section']);
  // And every action is structured, so the chat can validate it rather than manipulate the map.
  assert.deepEqual(answer.actions.map(a => a.type),
    ['SELECT_INCIDENT', 'FOCUS_RESOURCE', 'FOCUS_RESOURCE', 'FOCUS_AFFECTED_SECTION']);
  assert.deepEqual(answer.actions.filter(a => a.type === 'FOCUS_RESOURCE').map(a => a.resourceType), ['camera', 'sign']);

  const bare = entry({ resources: { camera: null, sign: null } });
  const without = answerTmcQuestion('HIGHEST_RISK', assessed([bare]));
  assert.deepEqual(without.actions.map(a => a.label), ['View incident', 'Show affected section']);
});

test('no incidents is answered plainly, not with an invented one', () => {
  for (const intent of ['HIGHEST_RISK', 'WHY_RISK', 'MITIGATION', 'UPSTREAM_CAMERAS']) {
    const answer = answerTmcQuestion(intent, { assessments: [], ranked: [] });
    assert.match(answer.answer, /No active I-595 incidents/);
    assert.deepEqual(answer.actions, []);
  }
});

test('"what can we do" reports the deterministic mitigation and claims nothing was done', () => {
  const answer = answerTmcQuestion('MITIGATION', assessed());
  assert.match(answer.answer, /1\. Verify upstream congestion using CAM-22\./);
  assert.match(answer.answer, /Nothing here is carried out automatically/);
  assert.ok(!/I recommend changing|dispatched|activated/i.test(answer.answer));
});

test('a nearby sign is never reported as a warning that is in place', () => {
  const answer = answerTmcQuestion('UPSTREAM_SIGNS', assessed());
  assert.match(answer.answer, /DMS-07/);
  assert.match(answer.answer, /0\.7 mi upstream/);
  assert.match(answer.answer, /does not publish sign messages/);
  assert.ok(!/warning (is )?active/i.test(answer.answer));
});

test('a nearby camera is never reported as showing the incident', () => {
  const answer = answerTmcQuestion('UPSTREAM_CAMERAS', assessed());
  assert.match(answer.answer, /CAM-22/);
  assert.match(answer.answer, /Proximity only/);
});

test('unresolved upstream is said, not papered over', () => {
  const unresolved = entry({
    upstream: { status: UPSTREAM_STATUS.UNRESOLVED, reason: 'Express direction is not published', sections: [], sectionIds: [] },
    upstreamCongestion: [], resources: { camera: null, sign: null },
  });
  const congestion = answerTmcQuestion('UPSTREAM_CONGESTION', assessed([unresolved]));
  assert.match(congestion.answer, /cannot be assessed/i);
  assert.match(congestion.answer, /express direction is not published/i);
  const cameras = answerTmcQuestion('UPSTREAM_CAMERAS', assessed([unresolved]));
  assert.match(cameras.answer, /express direction is not published/i);
});

test('the contextual questions answer about the selected incident, not the worst one', () => {
  const worst = entry({ incident: { id: 'INC-worst' } });
  const chosen = entry({ incident: { id: 'INC-chosen', activeMinutes: 7 } });
  const answer = answerTmcQuestion('DURATION', assessed([worst, chosen]), { selected: chosen });
  assert.match(answer.answer, /INC-chosen has been active for 7 minutes/);
});

test('an incident with no published start does not report a duration', () => {
  const nostart = entry({ incident: { id: 'INC-x', activeMinutes: null } });
  const answer = answerTmcQuestion('DURATION', assessed([nostart]));
  assert.match(answer.answer, /no published start time/);
});

test('list questions count across every active incident', () => {
  const blocking = entry({ incident: { id: 'INC-a', blocksTravelLanes: true } });
  const clear = entry({ incident: { id: 'INC-b', blocksTravelLanes: false }, impactLevel: 'LOW' });
  const lanes = answerTmcQuestion('LANE_CLOSURES', assessed([blocking, clear]));
  assert.match(lanes.answer, /1 active incident with lanes blocked/);
  assert.match(lanes.answer, /INC-a/);
  assert.ok(!lanes.answer.includes('INC-b'));

  const impact = answerTmcQuestion('HIGH_IMPACT', assessed([blocking, clear]));
  assert.match(impact.answer, /1 active incident/);
  assert.match(impact.answer, /INC-a — Eastbound Section 04 \(HIGH\)/);
});

test('a question that is not a TMC one is left for the other routes', () => {
  assert.equal(parseTmcQuestion('How long is I-595?'), null);
  assert.equal(parseTmcQuestion('Fly to bridge 860384'), null);
  assert.equal(parseTmcQuestion(''), null);
  assert.equal(answerTmcQuestion(null, assessed()), null);
});
