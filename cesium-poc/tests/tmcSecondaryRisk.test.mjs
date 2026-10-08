/**
 * The secondary-incident risk engine.
 *
 * It is rule-based and must stay explainable: every point in a score traces to a factor an operator
 * can see, and anything the data cannot speak to is reported as unavailable rather than scored as
 * absent. These tests pin both halves of that.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { CARRIAGEWAYS } from '../src/liveOps/carriagewayModel.js';
import { UPSTREAM_STATUS } from '../src/tmc/upstreamResolver.js';
import { activeIncidents, normaliseIncident } from '../src/tmc/tmcIncidents.js';
import {
  assessSecondaryRisk, isElevated, levelFor, rankBySecondaryRisk, SECONDARY_RISK_CONFIG, UNAVAILABLE_FACTORS,
} from '../src/tmc/secondaryIncidentRisk.js';
import { mitigationFor } from '../src/tmc/riskMitigation.js';

const NOW = Date.parse('2026-10-05T12:00:00Z');

/** A live incident as the feed carries it. */
const liveIncident = ({
  id = 'INC-1', severity = 'Minor', minutesAgo = 5, lanes = null,
  carriageway = CARRIAGEWAYS.EB_GENERAL, sectionIndex = 4, cleared = false,
} = {}) => ({
  id, type: 'INCIDENT', title: 'Crash', severity, cleared,
  longitude: -80.22, latitude: 26.06,
  sdna: { reported_at: new Date(NOW - minutesAgo * 60_000).toISOString() },
  liveOps: {
    carriageway, direction: carriageway === CARRIAGEWAYS.WB_GENERAL ? 'WB' : 'EB',
    sectionId: sectionIndex == null ? null : `SECTION_0${sectionIndex}`,
    sectionIndex, sectionLabel: `Eastbound Section 0${sectionIndex}`,
    spatialMatch: { confidence: 'HIGH' },
    laneImpact: lanes ?? { blockedLanes: null, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'none' },
  },
});

const resolvedUpstream = { status: UPSTREAM_STATUS.RESOLVED, reason: null, sectionIds: ['SECTION_03', 'SECTION_02'], sections: [] };
const unresolvedUpstream = { status: UPSTREAM_STATUS.UNRESOLVED, reason: 'Carriageway unresolved', sectionIds: [], sections: [] };
const congestion = n => Array.from({ length: n }, (_, i) => ({ id: `CON-${i}`, type: 'CONGESTION' }));

test('a quiet incident with nothing around it is Low, not zero-risk theatre', () => {
  const risk = assessSecondaryRisk(normaliseIncident(liveIncident(), NOW), { upstream: resolvedUpstream });
  assert.equal(risk.level, 'LOW');
  assert.equal(risk.score, 0);
  assert.ok(risk.factors.every(f => !f.present));
});

test('a blocked lane is the single strongest piece of evidence', () => {
  const lanes = { blockedLanes: 2, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'parsed' };
  const risk = assessSecondaryRisk(normaliseIncident(liveIncident({ lanes }), NOW), { upstream: resolvedUpstream });
  const lane = risk.factors.find(f => f.type === 'LANE_CLOSURE');
  assert.equal(lane.present, true);
  assert.equal(lane.contribution, 36);
  assert.equal(lane.detail, '2 lanes blocked');
});

test('"the source did not say" is not "nothing is blocked"', () => {
  // 32 of 61 measured events carry source:'none'. Scoring those as clear would invent evidence.
  const risk = assessSecondaryRisk(normaliseIncident(liveIncident(), NOW), { upstream: resolvedUpstream });
  const lane = risk.factors.find(f => f.type === 'LANE_CLOSURE');
  assert.equal(lane.present, false);
  assert.equal(lane.detail, 'Lane impact not stated by the source');
});

test('a ramp or a shoulder is not the carriageway', () => {
  const ramp = { blockedLanes: null, fullClosure: false, rampClosure: true, shoulderOnly: false, source: 'parsed' };
  const shoulder = { blockedLanes: null, fullClosure: false, rampClosure: false, shoulderOnly: true, source: 'parsed' };
  const rampRisk = assessSecondaryRisk(normaliseIncident(liveIncident({ lanes: ramp }), NOW), { upstream: resolvedUpstream });
  const shoulderRisk = assessSecondaryRisk(normaliseIncident(liveIncident({ lanes: shoulder }), NOW), { upstream: resolvedUpstream });
  assert.equal(rampRisk.factors.find(f => f.type === 'LANE_CLOSURE').contribution, 8);
  assert.equal(shoulderRisk.factors.find(f => f.type === 'LANE_CLOSURE').present, false);
});

test('upstream congestion counts only when upstream was actually resolved', () => {
  const incident = normaliseIncident(liveIncident(), NOW);
  const withUpstream = assessSecondaryRisk(incident, { upstream: resolvedUpstream, upstreamCongestion: congestion(2) });
  assert.equal(withUpstream.factors.find(f => f.type === 'UPSTREAM_CONGESTION').contribution, 38);

  // Unresolved upstream: the queue cannot be attributed, so it scores nothing and says why.
  const without = assessSecondaryRisk(incident, { upstream: unresolvedUpstream, upstreamCongestion: congestion(2) });
  const factor = without.factors.find(f => f.type === 'UPSTREAM_CONGESTION');
  assert.equal(factor.present, false);
  assert.equal(factor.contribution, 0);
  assert.match(factor.detail, /unresolved/i);
});

test('Operational Impact is an input, never the score', () => {
  const incident = normaliseIncident(liveIncident(), NOW);
  const risk = assessSecondaryRisk(incident, { upstream: resolvedUpstream, impactLevel: 'SEVERE' });
  const impact = risk.factors.find(f => f.type === 'OPERATIONAL_IMPACT');
  assert.equal(impact.contribution, 24);
  // A SEVERE section alone does not make a SEVERE secondary risk — they are different questions.
  assert.notEqual(risk.level, 'SEVERE');
  assert.equal(risk.score, 24);
});

test('duration only counts once an incident has been running a while, and is capped', () => {
  const short = assessSecondaryRisk(normaliseIncident(liveIncident({ minutesAgo: 10 }), NOW), { upstream: resolvedUpstream });
  assert.equal(short.factors.find(f => f.type === 'INCIDENT_DURATION').present, false);
  const long = assessSecondaryRisk(normaliseIncident(liveIncident({ minutesAgo: 240 }), NOW), { upstream: resolvedUpstream });
  const factor = long.factors.find(f => f.type === 'INCIDENT_DURATION');
  assert.equal(factor.contribution, SECONDARY_RISK_CONFIG.factors.INCIDENT_DURATION.max);
  assert.match(factor.detail, /Active 240 min/);
});

test('an incident with no published start is not a zero-minute incident', () => {
  const event = liveIncident();
  delete event.sdna;
  const incident = normaliseIncident(event, NOW);
  assert.equal(incident.activeMinutes, null);
  const risk = assessSecondaryRisk(incident, { upstream: resolvedUpstream });
  assert.equal(risk.factors.find(f => f.type === 'INCIDENT_DURATION').detail, 'Start time not published');
});

test('everything together reaches the high end, and the level is explainable from the factors', () => {
  const lanes = { blockedLanes: 3, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'parsed' };
  const risk = assessSecondaryRisk(
    normaliseIncident(liveIncident({ lanes, severity: 'Major', minutesAgo: 60 }), NOW),
    { upstream: resolvedUpstream, upstreamCongestion: congestion(1), impactLevel: 'HIGH' },
  );
  assert.equal(risk.level, 'SEVERE');
  assert.equal(risk.score, risk.factors.reduce((t, f) => t + f.contribution, 0), 'the score is its factors, nothing hidden');
  assert.ok(isElevated(risk.level));
});

test('what the data cannot see is always reported, never scored as absent', () => {
  const risk = assessSecondaryRisk(normaliseIncident(liveIncident(), NOW), { upstream: resolvedUpstream });
  // Weather is enrichment, fetched only when an incident is opened. Until it arrives it joins the
  // list of things that could not be seen — never a silent zero that reads as fine weather.
  assert.deepEqual(risk.unavailableFactors.map(f => f.type),
    ['RESPONDER_STATUS', 'DMS_WARNING_ACTIVE', 'QUEUE_LENGTH', 'TRAFFIC_SPEED', 'WEATHER']);
  assert.equal(risk.weatherState, 'not-requested');
  for (const entry of risk.unavailableFactors) assert.ok(entry.reason, `${entry.type} says why`);

  // With a reading in hand, weather is assessed and drops off the unavailable list.
  const withWeather = assessSecondaryRisk(normaliseIncident(liveIncident(), NOW), {
    upstream: resolvedUpstream,
    weather: { precipitation: 0, visibility: 16_000, windSpeed: 9, windGust: 14 },
  });
  assert.deepEqual(withWeather.unavailableFactors, UNAVAILABLE_FACTORS);
  assert.equal(withWeather.weatherState, 'available');
});

test('levels begin where the config says, with no gaps', () => {
  assert.equal(levelFor(0).id, 'LOW');
  assert.equal(levelFor(29).id, 'LOW');
  assert.equal(levelFor(30).id, 'MODERATE');
  assert.equal(levelFor(60).id, 'HIGH');
  assert.equal(levelFor(90).id, 'SEVERE');
  assert.equal(levelFor(1000).id, 'SEVERE');
});

test('ranking puts the worst first and says when two are tied', () => {
  const mk = (id, score) => ({ incident: { id, activeMinutes: 10 }, risk: { score } });
  const ranked = rankBySecondaryRisk([mk('a', 10), mk('b', 70), mk('c', 70), mk('d', 5)]);
  assert.equal(ranked.highestRiskIncident.id, 'b');
  assert.deepEqual(ranked.tied.map(e => e.incident.id), ['b', 'c'], 'a tie is reported, not broken by a coin flip');
  assert.deepEqual(ranked.ranked.map(e => e.incident.id), ['b', 'c', 'a', 'd']);
});

test('no incidents ranks to nothing rather than throwing', () => {
  const empty = rankBySecondaryRisk([]);
  assert.equal(empty.highestRiskIncident, null);
  assert.equal(empty.risk, null);
  assert.deepEqual(empty.tied, []);
  assert.deepEqual(rankBySecondaryRisk(null).ranked, []);
});

test('only active, placed incidents are assessed', () => {
  const events = [
    liveIncident({ id: 'live' }),
    liveIncident({ id: 'cleared', cleared: true }),
    { ...liveIncident({ id: 'nowhere' }), longitude: null, latitude: null },
    { id: 'closure', type: 'CLOSURE', cleared: false, longitude: -80.2, latitude: 26.06, liveOps: {} },
  ];
  assert.deepEqual(activeIncidents(events, NOW).map(i => i.id), ['live']);
});

test('mitigation only suggests what the detected factors and real resources support', () => {
  const lanes = { blockedLanes: 1, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'parsed' };
  const risk = assessSecondaryRisk(
    normaliseIncident(liveIncident({ lanes, minutesAgo: 60 }), NOW),
    { upstream: resolvedUpstream, upstreamCongestion: congestion(1), impactLevel: 'HIGH' },
  );
  const withResources = mitigationFor(risk, { camera: { id: 'CAM-22' }, sign: { id: 'DMS-07' }, upstream: resolvedUpstream });
  const text = withResources.map(m => m.text).join('\n');
  assert.match(text, /Verify upstream congestion using CAM-22\./);
  assert.match(text, /Review the nearest upstream sign DMS-07/);
  assert.match(text, /Responder status is not available/);

  // No resources: no line names one that is not there.
  const bare = mitigationFor(risk, { camera: null, sign: null, upstream: resolvedUpstream });
  assert.ok(!bare.some(m => /CAM-|DMS-/.test(m.text)), 'never names a resource that does not exist');
  assert.ok(bare.some(m => /no upstream camera is available/i.test(m.text)));
});

test('mitigation never claims an action was taken, or tells a sign what to say', () => {
  const risk = assessSecondaryRisk(normaliseIncident(liveIncident(), NOW), { upstream: unresolvedUpstream });
  const lines = mitigationFor(risk, { camera: { id: 'CAM-1' }, sign: { id: 'DMS-1' }, upstream: unresolvedUpstream })
    .map(m => m.text).join('\n');
  assert.ok(!/dispatch|activate|set .*DMS|closing|I recommend changing/i.test(lines), lines);
  assert.match(lines, /cannot be assessed/i, 'unresolved upstream is said out loud');
});
