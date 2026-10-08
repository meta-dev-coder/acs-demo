/**
 * Ask the Twin on location history.
 *
 * Every number in these answers must come from the services. The rule that matters most is the one
 * about cause: the connected register publishes no reported cause on any record, so the only
 * acceptable answer to "what caused this" is that we do not have one — never a historical pattern
 * dressed up as an explanation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerTmcQuestion, parseTmcQuestion } from '../src/tmc/tmcAnswers.js';

const HISTORY = {
  available: true,
  analysisWindow: { distanceMeters: 250, lookbackMonths: 12 },
  concentration: { level: 'HIGH', levelLabel: 'High', localValue: 18, corridorBaseline: 7, ratio: 2.6, reason: null },
  totals: { crashes: 18, severeCrashes: 4, fatalCrashes: 1, injuryCrashes: 9 },
  crashTypes: [{ value: 'Rear-end crash', count: 9, of: 18, share: 0.5 }, { value: 'Sideswipe merge conflict', count: 4, of: 18, share: 4 / 18 }],
  contributingFactors: [{ value: 'Driver behavior', count: 7, of: 16, share: 7 / 16 }],
  timePatterns: [{ value: 'PM peak', count: 8, of: 18, share: 8 / 18 }],
  weatherPatterns: [{ value: 'Rain', count: 5, of: 18, share: 5 / 18 }, { value: 'Clear', count: 13, of: 18, share: 13 / 18 }],
  selectedTimeBucket: { id: 'PM_PEAK', label: 'PM peak', share: 8 / 18, isMostCommon: true },
  matchBasis: { mode: 'LOCATION_ONLY', label: 'Location-based only', confidence: 'MEDIUM', reason: 'Incident carriageway could not be resolved' },
  provenance: {
    locationSource: 'DAMAGED_ASSET', locationSourceLabel: 'Damaged asset location',
    spatialConfidence: 'LOW', confirmedCrashRecords: 9, totalRecords: 18,
    recordNoun: 'historical incidents', surveyedCrashGeometry: false,
  },
  matches: [],
};

const RISK = {
  level: 'HIGH', levelLabel: 'High', score: 76,
  contributors: [{ type: 'LANE_CLOSURE', label: 'Lane closure or blockage', detail: '3 lanes blocked', contribution: 36 }],
  neutralFactors: [], unknownFactors: [{ type: 'UPSTREAM_CONGESTION', label: 'Upstream congestion', detail: 'Unknown — upstream carriageway unresolved' }],
  unavailableFactors: [{ type: 'QUEUE_LENGTH', label: 'Queue length', reason: 'Not available from the connected data' }],
  confidence: { level: 'MEDIUM', label: 'Medium', evaluated: 6, unknown: 2 },
  factors: [], weather: { condition: 'Clear' },
};

const entry = (over = {}) => ({
  incident: { id: 'INC-200101', severity: 'Major', sectionLabel: 'Eastbound Section 04', carriageway: 'EB_GENERAL', raw: { attributes: {} }, ...over.incident },
  risk: { ...RISK, ...over.risk },
  locationHistory: over.locationHistory === undefined ? HISTORY : over.locationHistory,
  upstream: { status: 'UNRESOLVED', reason: 'Carriageway unresolved' },
  upstreamCongestion: [], impactLevel: null, resources: { camera: null, sign: null }, mitigation: [],
});

const ask = (question, over = {}) => {
  const intent = parseTmcQuestion(question);
  const selected = entry(over);
  return { intent, ...answerTmcQuestion(intent, { historical: true, when: { label: 'Oct 1, 2026', mode: 'HISTORICAL' }, ranked: [selected], assessments: [selected] }, { selected }) };
};

test('"what caused this accident?" never answers with a historical pattern', () => {
  const { intent, answer } = ask('What caused this accident?');
  assert.equal(intent, 'ROOT_CAUSE');
  assert.match(answer, /does not provide a confirmed primary cause/i);
  assert.match(answer, /no reported-cause field/i);
  // It may list conditions, clearly labelled as conditions.
  assert.match(answer, /not a determination of cause/i);
  // And it must never reach for the history to explain this crash.
  assert.ok(!/rear-end/i.test(answer), 'the dominant historical pattern is not offered as the cause');
  assert.ok(!/caused by/i.test(answer));
});

test('"what caused this accident?" reports a reported cause when one exists', () => {
  const { answer } = ask('What caused this accident?', { incident: { raw: { attributes: { root_cause: 'Tyre failure' } } } });
  assert.match(answer, /The reported cause in the crash record is: Tyre failure/);
  assert.ok(!/does not provide/i.test(answer));
});

test('"is this a high-crash location?" leads with what cannot be confirmed', () => {
  // Positions come from the damaged asset, so an elevated concentration of records is exactly that.
  // Calling it a crash hotspot would assert something the source does not support.
  const { intent, answer } = ask('Is this a high-crash location?');
  assert.equal(intent, 'LOCATION_HISTORY');
  assert.match(answer, /elevated concentration of historical records near this location/i);
  assert.match(answer, /cannot confirm that this is a true crash hotspot/i);
  assert.match(answer, /derived from damaged assets rather than surveyed crash coordinates/i);
  // The counts are still there, named honestly, with how many are confirmed crash reports.
  assert.match(answer, /18 historical incident records were recorded within 250 m/);
  assert.match(answer, /9 carry a police report number/);
  assert.match(answer, /2\.6x the typical number of incident records/);
  assert.match(answer, /record-count comparison, not a validated crash rate/i);
  assert.match(answer, /Location source: Damaged asset location/);
  assert.match(answer, /spatial confidence low/);
  assert.match(answer, /weighted down/i);
  // And it never calls them "previous crashes".
  assert.ok(!/previous crash/i.test(answer));
});

test('a location with surveyed crash geometry gets a direct answer', () => {
  const surveyed = {
    ...HISTORY,
    provenance: { locationSource: 'RECORD', locationSourceLabel: 'Record coordinates', spatialConfidence: 'HIGH',
      confirmedCrashRecords: 18, totalRecords: 18, recordNoun: 'crashes', surveyedCrashGeometry: true },
  };
  const { answer } = ask('Is this a high-crash location?', { locationHistory: surveyed });
  assert.match(answer, /^HISTORICAL ANALYSIS\nOct 1, 2026\n\nYes — the connected crash records show a high concentration/);
  assert.ok(!/cannot confirm/i.test(answer), 'no hedge when the geometry supports the claim');
  assert.match(answer, /18 crashes were recorded/);
});

test('"what types of crashes usually happen here?" lists counts out of a stated total', () => {
  const { intent, answer } = ask('What types of crashes usually happen here?');
  assert.equal(intent, 'LOCATION_CRASH_TYPES');
  assert.match(answer, /Rear-end crash — 9 of 18 \(50%\)/);
  assert.match(answer, /do not establish the cause/i);
});

test('contributing circumstances are never called a reported cause', () => {
  const { intent, answer } = ask('What are the common historical contributing factors?');
  assert.equal(intent, 'LOCATION_FACTORS');
  assert.match(answer, /Driver behavior — 7 of 16/);
  assert.match(answer, /not a reported cause/i);
});

test('weather prevalence is reported as prevalence, not as effect', () => {
  const { answer } = ask('Is bad weather common in crashes here?');
  assert.match(answer, /Rain — 5 of 18/);
  assert.match(answer, /not a measure of what it caused/i);
  assert.ok(!/caused/i.test(answer.replace(/what it caused/i, '')), 'no causal claim');
});

test('time-of-day answers place the incident without blaming the hour', () => {
  const { intent, answer } = ask('Do crashes here happen more during peak periods?');
  assert.equal(intent, 'LOCATION_TIME');
  assert.match(answer, /PM peak — 8 of 18/);
  assert.match(answer, /most common historical crash period/i);
  assert.ok(!/caused/i.test(answer));
});

test('"what data is missing?" reports confidence and the gaps', () => {
  const { intent, answer } = ask('What data is missing?');
  assert.equal(intent, 'DATA_GAPS');
  assert.match(answer, /Data confidence for INC-200101: Medium/);
  assert.match(answer, /Upstream congestion — Unknown/);
  assert.match(answer, /Queue length/);
  assert.match(answer, /never scored as though conditions were benign/i);
});

test('"why is this incident high risk?" reports the score and only real contributors', () => {
  const { answer } = ask('Why is this incident high risk?');
  assert.match(answer, /High secondary-incident risk — 76 out of 100/);
  assert.match(answer, /Lane closure or blockage — 3 lanes blocked/);
  assert.match(answer, /Data confidence: Medium/);
});

test('an unanalysed location says so rather than inventing a history', () => {
  const { answer } = ask('Is this a high-crash location?', { locationHistory: null });
  assert.match(answer, /No location safety history has been computed/i);
  const empty = ask('What types of crashes usually happen here?',
    { locationHistory: { ...HISTORY, available: true, crashTypes: [] } });
  assert.match(empty.answer, /not available from the connected historical crash data/i);
});
