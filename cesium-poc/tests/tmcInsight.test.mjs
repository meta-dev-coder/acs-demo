/**
 * The twin's written conclusion.
 *
 * This is the part of the screen most likely to be read aloud to a client, so the failure that
 * matters is a sentence that sounds reassuring about something nobody checked. These tests mostly
 * exist to prove the four states — none, known-negative, unknown, unresolved — stay distinct in
 * prose, where they are easiest to blur.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHistoricalInsight, buildIncidentInsight, buildOpportunity, evidenceSources } from '../src/tmc/tmcInsight.js';
import { UPSTREAM_STATUS } from '../src/tmc/upstreamResolver.js';

const RESOLVED = { status: UPSTREAM_STATUS.RESOLVED, sections: [] };
const UNRESOLVED = { status: UPSTREAM_STATUS.UNRESOLVED, reason: 'Carriageway unresolved' };

const factor = (type, label, contribution, detail) => ({ type, label, contribution, detail, present: true, evidence: 'CONTRIBUTING' });

const RISK = {
  level: 'HIGH', levelLabel: 'High', score: 62,
  contributors: [
    factor('LANE_CLOSURE', 'Lane closure or blockage', 36, '3 lanes blocked'),
    factor('INCIDENT_SEVERITY', 'Incident severity', 20, 'Reported Major'),
    factor('INCIDENT_DURATION', 'Time the incident has been active', 8, 'Active 210 min'),
  ],
  neutralFactors: [{ type: 'WEATHER_PRECIPITATION', label: 'Precipitation at incident time', detail: 'No measurable rain', contribution: 0, evidence: 'NO_ADDED_RISK' }],
  unknownFactors: [{ type: 'UPSTREAM_CONGESTION', label: 'Upstream congestion', detail: 'Unknown', evidence: 'UNKNOWN' }],
  unavailableFactors: [{ type: 'QUEUE_LENGTH', label: 'Queue length', reason: 'Not available from the connected data' }],
  weather: { condition: 'Clear', matchedWeatherTime: '2026-03-05T17:00' }, weatherState: 'available',
  factors: [],
};

const HISTORY = {
  available: true,
  analysisWindow: { distanceMeters: 250, lookbackMonths: 12 },
  concentration: { level: 'VERY_HIGH', levelLabel: 'Very high', localValue: 30, corridorBaseline: 3, ratio: 10 },
  totals: { crashes: 30, severeCrashes: 18, fatalCrashes: 1, injuryCrashes: 20 },
  crashTypes: [{ value: 'Sideswipe merge conflict', count: 7, of: 30, share: 7 / 30 }, { value: 'Attenuator hit', count: 4, of: 30, share: 4 / 30 }],
  contributingFactors: [{ value: 'Construction / work zone', count: 6, of: 27, share: 6 / 27 }],
  timePatterns: [], weatherPatterns: [], matches: [],
  provenance: { recordNoun: 'historical incidents', spatialConfidence: 'LOW', locationSourceLabel: 'Damaged asset location', surveyedCrashGeometry: false },
};

const INCIDENT = { id: 'INC-1', sectionLabel: 'Eastbound Section 04', carriageway: 'EB_GENERAL', segmentId: 'SEG-1' };

test('the summary names the real drivers and nothing neutral', () => {
  const insight = buildIncidentInsight({ incident: INCIDENT, risk: RISK, locationHistory: null, upstream: RESOLVED });
  assert.match(insight.summary, /high secondary-incident risk on Eastbound Section 04/);
  assert.match(insight.summary, /the lane closure/);
  assert.match(insight.summary, /the incident severity/);
  assert.match(insight.summary, /how long it has been running/);
  // A neutral condition is context, never a reason.
  assert.ok(!/no measurable rain/i.test(insight.summary));
  assert.ok(!/precipitation/i.test(insight.summary));
  assert.deepEqual(insight.primaryDrivers.map(d => d.type), ['LANE_CLOSURE', 'INCIDENT_SEVERITY', 'INCIDENT_DURATION']);
  assert.equal(insight.headline, 'High secondary-incident risk — 62 out of 100.');
});

test('what could not be assessed gets said, not quietly dropped', () => {
  const insight = buildIncidentInsight({ incident: INCIDENT, risk: RISK, locationHistory: null, upstream: UNRESOLVED });
  assert.match(insight.summary, /upstream conditions cannot be assessed because the carriageway unresolved|upstream conditions cannot be assessed/i);
  // The wording an unresolved upstream must never produce.
  assert.ok(!/no upstream congestion/i.test(insight.summary));
  assert.ok(!/none reported/i.test(insight.summary));
  assert.ok(insight.limitations.length > 0);
});

test('missing weather is a limitation, present weather is not a driver', () => {
  const blind = buildIncidentInsight({ incident: INCIDENT, risk: { ...RISK, weather: null, weatherState: 'unavailable' }, upstream: RESOLVED });
  assert.match(blind.summary, /no weather reading could be retrieved/i);
  const clear = buildIncidentInsight({ incident: INCIDENT, risk: RISK, upstream: RESOLVED });
  assert.ok(!/clear/i.test(clear.summary), 'fine weather is context, not a reason');
});

test('history is reported as a concentration of records, never as a cause', () => {
  const withHistory = {
    ...RISK,
    contributors: [...RISK.contributors, factor('HISTORICAL_LOCATION', 'Historical incident concentration at this location: Very high', 9, '30 records')],
  };
  const insight = buildIncidentInsight({ incident: INCIDENT, risk: withHistory, locationHistory: HISTORY, upstream: RESOLVED });
  assert.match(insight.summary, /Historical incident records are also concentrated around this location/);
  assert.ok(!/caused/i.test(insight.summary));
  assert.ok(!/crash rate/i.test(insight.summary));
  // The history is supporting evidence, not one of the three primary drivers.
  assert.ok(!insight.primaryDrivers.some(d => d.type === 'HISTORICAL_LOCATION'));
  assert.ok(insight.supportingEvidence.some(e => e.type === 'HISTORICAL_LOCATION'));
});

test('the same inputs always produce the same words', () => {
  const once = buildIncidentInsight({ incident: INCIDENT, risk: RISK, locationHistory: HISTORY, upstream: UNRESOLVED });
  const twice = buildIncidentInsight({ incident: INCIDENT, risk: RISK, locationHistory: HISTORY, upstream: UNRESOLVED });
  assert.deepEqual(once, twice);
});

test('evidence lists only sources that contributed, and names the rest as unavailable', () => {
  const used = evidenceSources({ risk: RISK, locationHistory: HISTORY, upstream: RESOLVED, resources: { camera: { id: 'CAM-22' }, sign: null } });
  const byId = Object.fromEntries(used.map(s => [s.id, s]));
  assert.equal(byId.incident.state, 'used');
  assert.equal(byId.history.state, 'used');
  assert.equal(byId.weather.state, 'used');
  assert.equal(byId.weather.source, 'Open-Meteo');
  assert.equal(byId.traffic.state, 'used');
  assert.equal(byId.resources.state, 'used');

  // With upstream unresolved, traffic and roadway are named unavailable rather than implied.
  const blind = evidenceSources({ risk: { ...RISK, weather: null, weatherState: 'unavailable' }, locationHistory: null, upstream: UNRESOLVED, resources: {} });
  const blindById = Object.fromEntries(blind.map(s => [s.id, s]));
  assert.equal(blindById.traffic.state, 'unavailable');
  assert.equal(blindById.roadway.state, 'unavailable');
  assert.equal(blindById.weather.state, 'unavailable');
  assert.equal(blindById.resources.state, 'unavailable');
  assert.equal(blindById.history, undefined, 'a source that was never consulted is not listed at all');
});

test('the historical insight reports ties as ties', () => {
  const tied = { ...HISTORY, crashTypes: [
    { value: 'Sideswipe merge conflict', count: 7, of: 30, share: 7 / 30 },
    { value: 'Rear-end crash', count: 7, of: 30, share: 7 / 30 },
    { value: 'Attenuator hit', count: 4, of: 30, share: 4 / 30 },
  ] };
  const insight = buildHistoricalInsight(tied);
  assert.match(insight.summary, /Sideswipe merge conflict and Rear-end crash are equally the most common/);
  assert.ok(!/is the most commonly recorded/.test(insight.summary));
  // A clear winner reads as one.
  assert.match(buildHistoricalInsight(HISTORY).summary, /Sideswipe merge conflict is the most commonly recorded pattern/);
});

test('the historical insight carries its own spatial caveat', () => {
  const insight = buildHistoricalInsight(HISTORY);
  assert.match(insight.summary, /10× the typical concentration/);
  assert.match(insight.summary, /damaged asset location/i);
  assert.match(insight.summary, /not a validated crash-rate estimate/i);
  assert.ok(insight.limitations.length > 0);
});

test('no history is not a claim of safety', () => {
  const empty = buildHistoricalInsight({ ...HISTORY, totals: { crashes: 0, severeCrashes: 0, fatalCrashes: 0, injuryCrashes: 0 }, crashTypes: [] });
  assert.match(empty.summary, /No historical incident records were found/);
  assert.match(empty.summary, /not evidence that the location is safe/i);
  assert.ok(!/safe location/i.test(empty.summary.replace(/not evidence that the location is safe/i, '')));
});

test('an opportunity appears only where evidence supports one', () => {
  // Nothing recurring, upstream resolved, resources present: no opportunity to report.
  const quiet = buildOpportunity({
    locationHistory: { ...HISTORY, concentration: { ...HISTORY.concentration, level: 'NORMAL' }, contributingFactors: [] },
    upstream: RESOLVED, resources: { camera: { id: 'CAM-1' }, sign: { id: 'DMS-1' } }, risk: RISK,
  });
  assert.equal(quiet, null);

  const found = buildOpportunity({ locationHistory: HISTORY, upstream: UNRESOLVED, resources: {}, risk: RISK });
  assert.match(found.summary, /recurring incident concentration/);
  assert.match(found.summary, /limited upstream observability/);
  assert.match(found.summary, /review monitoring coverage/i);
  assert.ok(found.evidence.length >= 2);
  assert.ok(found.limitations.length >= 2);
});

test('an opportunity never prescribes capital spend or claims a cause', () => {
  const found = buildOpportunity({ locationHistory: HISTORY, upstream: UNRESOLVED, resources: {}, risk: RISK });
  const words = `${found.summary} ${found.evidence.join(' ')} ${found.limitations.join(' ')}`.toLowerCase();
  for (const forbidden of ['install', 'build a', 'procure', 'caused by', 'will prevent', 'proves']) {
    assert.ok(!words.includes(forbidden), `never says "${forbidden}"`);
  }
  assert.match(found.limitations.join(' '), /derived from damaged-asset coordinates/i);
});

test('internal reason labels are rewritten as English', () => {
  // It read "because carriageway unresolved", which is a label dropped into a sentence.
  const insight = buildIncidentInsight({ incident: INCIDENT, risk: RISK, upstream: UNRESOLVED });
  assert.match(insight.summary, /because the carriageway could not be determined for this incident/);
  assert.ok(!/because carriageway unresolved/.test(insight.summary));

  const bySection = buildIncidentInsight({ incident: INCIDENT, risk: RISK,
    upstream: { status: 'UNRESOLVED', reason: 'Section unresolved' } });
  assert.match(bySection.summary, /the corridor section could not be resolved/);

  // No stated reason still produces a sentence rather than a gap.
  const silent = buildIncidentInsight({ incident: INCIDENT, risk: RISK, upstream: { status: 'UNRESOLVED' } });
  assert.match(silent.summary, /the direction of travel could not be determined/);
});
