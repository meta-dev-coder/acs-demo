/**
 * Weather as one input to secondary-incident risk.
 *
 * The two mistakes worth guarding against: letting weather run away with the score, and letting a
 * weather lookup that never succeeded read as a fine afternoon. Both produce a number an operator
 * would act on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { assessSecondaryRisk, SECONDARY_RISK_CONFIG, levelFor } from '../src/tmc/secondaryIncidentRisk.js';
import { mitigationFor } from '../src/tmc/riskMitigation.js';
import { UPSTREAM_STATUS } from '../src/tmc/upstreamResolver.js';

const INCIDENT = { id: 'INC-1', severity: 'Minor', activeMinutes: 0, lanes: { stated: false } };
const RESOLVED = { status: UPSTREAM_STATUS.RESOLVED, sections: [] };
const UNRESOLVED = { status: UPSTREAM_STATUS.UNRESOLVED, reason: 'Carriageway unresolved' };
const clear = { precipitation: 0, rain: 0, visibility: 24_000, windSpeed: 12, windGust: 18, temperature: 27, condition: 'Clear' };
const assess = (weather, over = {}) =>
  assessSecondaryRisk({ ...INCIDENT, ...over.incident }, {
    upstream: over.upstream ?? UNRESOLVED, upstreamCongestion: over.congestion ?? [],
    impactLevel: over.impactLevel ?? null, weather, weatherRequested: true,
  });
const weight = (risk, type) => risk.factors.find(f => f.type === type);

test('a clear hour contributes nothing, and says so rather than staying silent', () => {
  const risk = assess(clear);
  assert.equal(risk.score, 0);
  assert.equal(weight(risk, 'WEATHER_PRECIPITATION').present, false);
  assert.equal(weight(risk, 'WEATHER_VISIBILITY').present, false);
  assert.equal(weight(risk, 'WEATHER_WIND').present, false);
  assert.equal(risk.weatherState, 'available');
});

test('rain is weighed by how hard it was raining, not as a boolean', () => {
  const config = SECONDARY_RISK_CONFIG.factors.WEATHER.precipitation;
  // The US National Weather Service boundaries: light below 2.5 mm/h, heavy from 7.6 mm/h.
  const light = assess({ ...clear, precipitation: 0.6 });
  const moderate = assess({ ...clear, precipitation: 3.0 });
  const heavy = assess({ ...clear, precipitation: 9.0 });
  assert.equal(weight(light, 'WEATHER_PRECIPITATION').contribution, config.light);
  assert.equal(weight(moderate, 'WEATHER_PRECIPITATION').contribution, config.moderate);
  assert.equal(weight(heavy, 'WEATHER_PRECIPITATION').contribution, config.heavy);
  assert.ok(light.score < moderate.score && moderate.score < heavy.score);
  // A trace below the light threshold is not rain.
  assert.equal(weight(assess({ ...clear, precipitation: 0.1 }), 'WEATHER_PRECIPITATION').present, false);
});

test('rain and precipitation are not both counted', () => {
  // `rain` is carried for display and must never add a second time: the same 2.4 mm scores once.
  const withBoth = assess({ ...clear, precipitation: 3.0, rain: 3.0 });
  const precipitationOnly = assess({ ...clear, precipitation: 3.0, rain: 0 });
  assert.equal(withBoth.score, precipitationOnly.score);
  assert.equal(withBoth.factors.filter(f => f.type.startsWith('WEATHER_PRECIPITATION')).length, 1);
});

test('visibility is weighed in bands, worst first', () => {
  const config = SECONDARY_RISK_CONFIG.factors.WEATHER.visibility;
  assert.equal(weight(assess({ ...clear, visibility: 4_000 }), 'WEATHER_VISIBILITY').contribution, config.reduced);
  assert.equal(weight(assess({ ...clear, visibility: 1_500 }), 'WEATHER_VISIBILITY').contribution, config.poor);
  assert.equal(weight(assess({ ...clear, visibility: 600 }), 'WEATHER_VISIBILITY').contribution, config.severe);
  assert.equal(weight(assess({ ...clear, visibility: 20_000 }), 'WEATHER_VISIBILITY').present, false);
});

test('wind is scored from the gust, which is what moves a vehicle', () => {
  const config = SECONDARY_RISK_CONFIG.factors.WEATHER.wind;
  assert.equal(weight(assess({ ...clear, windSpeed: 16, windGust: 65 }), 'WEATHER_WIND').contribution, config.gust);
  assert.equal(weight(assess({ ...clear, windSpeed: 45, windGust: 50 }), 'WEATHER_WIND').contribution, config.strong);
  assert.equal(weight(assess({ ...clear, windSpeed: 16, windGust: 31 }), 'WEATHER_WIND').present, false);
});

test('combinations matter: rain with a short sight line beats either alone', () => {
  const rainOnly = assess({ ...clear, precipitation: 2.4 });
  const dimOnly = assess({ ...clear, visibility: 2_100 });
  const both = assess({ ...clear, precipitation: 2.4, visibility: 2_100 });
  assert.ok(both.score > rainOnly.score + dimOnly.score, 'the combination adds beyond the parts');
  assert.equal(weight(both, 'WEATHER_COMBINED').present, true);

  // And worse again when traffic is already queueing into it.
  const intoQueue = assess({ ...clear, precipitation: 2.4, visibility: 2_100 },
    { upstream: RESOLVED, congestion: [{ id: 'CON-1' }] });
  const combined = SECONDARY_RISK_CONFIG.factors.WEATHER.combined;
  assert.equal(weight(intoQueue, 'WEATHER_COMBINED').contribution,
    combined.rainAndReducedVisibility + combined.withUpstreamQueue);
});

test('weather raises the score but never outranks the road being blocked', () => {
  const worst = assess({ ...clear, precipitation: 30, visibility: 200, windSpeed: 60, windGust: 90 });
  const weatherTotal = worst.factors.filter(f => f.type.startsWith('WEATHER_')).reduce((t, f) => t + f.contribution, 0);
  assert.ok(weatherTotal <= SECONDARY_RISK_CONFIG.factors.WEATHER.max, `${weatherTotal} within the cap`);
  // A full carriageway closure still outweighs the worst weather on record.
  assert.ok(SECONDARY_RISK_CONFIG.factors.LANE_CLOSURE.fullClosure >= weatherTotal);
});

test('the existing risk bands are preserved, not replaced', () => {
  // 0-29 Low, 30-59 Moderate, 60-89 High, 90+ Severe. The top band is the application's own name
  // for it; introducing a second vocabulary would make two screens disagree about the same score.
  assert.equal(levelFor(0).id, 'LOW');
  assert.equal(levelFor(29).id, 'LOW');
  assert.equal(levelFor(30).id, 'MODERATE');
  assert.equal(levelFor(60).id, 'HIGH');
  assert.equal(levelFor(90).id, 'SEVERE');
});

test('weather that could not be obtained is declared, never scored as fine', () => {
  const failed = assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, weather: null, weatherRequested: true });
  assert.equal(failed.weatherState, 'unavailable');
  assert.ok(failed.unavailableFactors.some(f => f.type === 'WEATHER'));
  assert.equal(failed.factors.filter(f => f.type.startsWith('WEATHER_')).length, 0, 'nothing scored either way');

  // And the rest of the analysis still happens: weather is enrichment, not a prerequisite.
  const withLanes = assessSecondaryRisk(
    { ...INCIDENT, lanes: { stated: true, blockedLanes: 2 }, severity: 'Major' },
    { upstream: UNRESOLVED, weather: null, weatherRequested: true });
  assert.ok(withLanes.score > 0);
  assert.equal(withLanes.level, levelFor(withLanes.score).id);

  // "Never asked" and "asked and failed" are different answers.
  assert.equal(assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED }).weatherState, 'not-requested');
});

test('mitigation follows the conditions that were actually detected', () => {
  const risk = assess({ ...clear, precipitation: 2.4, visibility: 2_100 },
    { upstream: RESOLVED, congestion: [{ id: 'CON-1' }] });
  const actions = mitigationFor(risk, { sign: { id: 'DMS-9' }, upstream: RESOLVED }).map(m => m.id);
  assert.ok(actions.includes('weather-advisory-speed'));
  assert.ok(actions.includes('weather-warning-distance'), 'a short sight line is what breaks warning distance');
  assert.ok(actions.includes('weather-dms-warning'));
  assert.ok(actions.includes('weather-queue-growth'));
  assert.ok(actions.includes('weather-road-ranger'));

  // A clear hour offers none of them — recommendations are traceable, not decorative.
  const dry = mitigationFor(assess(clear, { upstream: RESOLVED }), { sign: { id: 'DMS-9' }, upstream: RESOLVED }).map(m => m.id);
  for (const id of ['weather-advisory-speed', 'weather-warning-distance', 'weather-queue-growth', 'weather-road-ranger']) {
    assert.ok(!dry.includes(id), `${id} not offered in clear weather`);
  }

  // When weather is unavailable, that is said once and nothing weather-driven is suggested.
  const blind = mitigationFor(assessSecondaryRisk(INCIDENT, { upstream: RESOLVED, weather: null, weatherRequested: true }),
    { upstream: RESOLVED }).map(m => m.id);
  assert.ok(blind.includes('weather-unavailable'));
  assert.ok(!blind.some(id => id.startsWith('weather-') && id !== 'weather-unavailable'));
});

test('no wording claims weather caused anything', () => {
  const risk = assess({ ...clear, precipitation: 9, visibility: 900 });
  const words = [...risk.factors.map(f => `${f.label} ${f.detail ?? ''}`),
    ...mitigationFor(risk, { upstream: UNRESOLVED }).map(m => m.text)].join(' ').toLowerCase();
  for (const forbidden of ['caused by', 'cause of', 'probability', '% chance', 'due to rain']) {
    assert.ok(!words.includes(forbidden), `never says "${forbidden}"`);
  }
});

test('a recommendation names the condition once', () => {
  // It read "rain at incident time at the incident time": the factor label already ends in
  // "at incident time", so the sentence repeated it.
  const risk = assess({ ...clear, precipitation: 4.0, visibility: 2_100 }, { upstream: RESOLVED });
  for (const action of mitigationFor(risk, { upstream: RESOLVED })) {
    assert.ok(!/at incident time at the incident time/i.test(action.text), action.text);
    assert.ok(!/\bat (the )?incident time\b.*\bat (the )?incident time\b/i.test(action.text), action.text);
  }
  const speed = mitigationFor(risk, { upstream: RESOLVED }).find(m => m.id === 'weather-advisory-speed');
  // 2.1 km is the "reduced" band (2-5 km); "poor" begins below 2 km.
  assert.equal(speed.text, 'Consider a reduced advisory speed on the approach — rain and reduced visibility at the incident time.');
  const distance = mitigationFor(risk, { upstream: RESOLVED }).find(m => m.id === 'weather-warning-distance');
  assert.equal(distance.text, 'Increase the upstream warning distance — reduced visibility, 2.1 km, at the incident time.');
});

// ── Historical location as a risk input ────────────────────────────────────────────────────────

test('location history contributes through the banded concentration, never the raw count', () => {
  const config = SECONDARY_RISK_CONFIG.factors.HISTORICAL_LOCATION;
  const history = level => ({
    available: true,
    analysisWindow: { distanceMeters: 250, lookbackMonths: 12 },
    concentration: { level, levelLabel: level, localValue: 18, corridorBaseline: 7, ratio: 2.6 },
    crashTypes: [], contributingFactors: [], weatherPatterns: [], timePatterns: [], matches: [],
  });
  const score = level => assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, locationHistory: history(level) }).score;
  assert.equal(score('NORMAL'), config.levels.NORMAL);
  assert.equal(score('ELEVATED'), config.levels.ELEVATED);
  assert.equal(score('HIGH'), config.levels.HIGH);
  assert.equal(score('VERY_HIGH'), config.levels.VERY_HIGH);

  // Doubling the raw count without changing the band changes nothing: the count is not the input.
  const many = { ...history('HIGH'), totals: { crashes: 400 } };
  assert.equal(assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, locationHistory: many }).score, config.levels.HIGH);
  assert.ok(config.max <= SECONDARY_RISK_CONFIG.factors.LANE_CLOSURE.fullClosure, 'history never outranks the road');
});

test('historical patterns are evidence, not extra score — no double counting', () => {
  const base = {
    available: true,
    analysisWindow: { distanceMeters: 250, lookbackMonths: 12 },
    concentration: { level: 'HIGH', levelLabel: 'High', localValue: 18, corridorBaseline: 7, ratio: 2.6 },
    crashTypes: [], contributingFactors: [], weatherPatterns: [], timePatterns: [], matches: [],
  };
  // A location where it is historically often wet, assessed on a day when it is also raining now.
  const wet = { ...base, weatherPatterns: [{ value: 'Rain', count: 9, of: 18, share: 0.5 }] };
  const rainNow = { precipitation: 4.0, visibility: 20_000, windSpeed: 10, windGust: 15 };
  const withPattern = assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, weather: rainNow, weatherRequested: true, locationHistory: wet });
  const withoutPattern = assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, weather: rainNow, weatherRequested: true, locationHistory: base });
  assert.equal(withPattern.score, withoutPattern.score, 'historical wet weather adds nothing on top of measured rain');
  // Likewise historical severity is not added to the incident's own severity.
  const severeHistory = { ...base, totals: { crashes: 18, severeCrashes: 9, fatalCrashes: 2 } };
  assert.equal(assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, locationHistory: severeHistory }).score, withoutPattern.score - 14);
});

test('an unanalysed or unusable location is UNKNOWN, not a safe location', () => {
  const none = assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, locationHistory: null });
  const factor = none.factors.find(f => f.type === 'HISTORICAL_LOCATION');
  assert.equal(factor.contribution, 0);
  assert.equal(factor.evidence, 'UNKNOWN');
  assert.ok(none.unknownFactors.includes(factor), 'it appears under data gaps, not under other conditions');
  assert.ok(!none.neutralFactors.includes(factor));

  const failed = assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED,
    locationHistory: { available: false, reason: 'No historical crash records are connected', concentration: { level: 'UNKNOWN' } } });
  assert.equal(failed.factors.find(f => f.type === 'HISTORICAL_LOCATION').evidence, 'UNKNOWN');
});

test('unresolved upstream is UNKNOWN, never "no congestion"', () => {
  const risk = assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, upstreamCongestion: [] });
  const congestion = risk.factors.find(f => f.type === 'UPSTREAM_CONGESTION');
  assert.equal(congestion.evidence, 'UNKNOWN');
  assert.match(congestion.detail, /^Unknown/);
  assert.ok(!/none reported/i.test(congestion.detail));

  // Resolved with nothing upstream IS an absence, and reads as one.
  const clearUpstream = assessSecondaryRisk(INCIDENT, { upstream: RESOLVED, upstreamCongestion: [] });
  const found = clearUpstream.factors.find(f => f.type === 'UPSTREAM_CONGESTION');
  assert.equal(found.evidence, 'NO_ADDED_RISK');
  assert.match(found.detail, /No congestion reported upstream/);
});

test('unresolved Operational Impact is UNKNOWN, never NORMAL', () => {
  const risk = assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, impactLevel: null });
  const impact = risk.factors.find(f => f.type === 'OPERATIONAL_IMPACT');
  assert.equal(impact.evidence, 'UNKNOWN');
  assert.match(impact.detail, /^Unknown/);
  // A genuinely NORMAL section is a different answer, and scores zero as an evaluated fact.
  const normal = assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, impactLevel: 'NORMAL' });
  assert.equal(normal.factors.find(f => f.type === 'OPERATIONAL_IMPACT').evidence, 'NO_ADDED_RISK');
});

test('the score breaks down into components that add up', () => {
  const risk = assessSecondaryRisk(
    { ...INCIDENT, severity: 'Major', activeMinutes: 34, lanes: { stated: true, blockedLanes: 3 } },
    { upstream: UNRESOLVED,
      weather: { precipitation: 4.0, visibility: 20_000, windSpeed: 10, windGust: 15 }, weatherRequested: true,
      locationHistory: { available: true, analysisWindow: { distanceMeters: 250, lookbackMonths: 12 },
        concentration: { level: 'HIGH', levelLabel: 'High', localValue: 18, corridorBaseline: 7, ratio: 2.6 },
        crashTypes: [], contributingFactors: [], weatherPatterns: [], timePatterns: [], matches: [] } });
  const summed = Object.values(risk.components).reduce((total, c) => total + c.score, 0);
  assert.equal(summed, risk.score, 'the components are the score, not a parallel number');
  assert.equal(risk.components.incidentLaneImpact.score, 36 + 20);
  assert.equal(risk.components.environment.score, 14);
  assert.equal(risk.components.historicalLocation.score, 12);
  // Every contributor is a factor that actually added, and nothing neutral or unknown is in there.
  assert.ok(risk.contributors.every(f => f.contribution > 0));
  assert.ok(risk.neutralFactors.every(f => f.contribution === 0 && f.evidence === 'NO_ADDED_RISK'));
});

test('low confidence never downgrades a well-evidenced risk', () => {
  // Three lanes blocked on a Major incident, with almost nothing else known.
  const risk = assessSecondaryRisk(
    { ...INCIDENT, severity: 'Major', activeMinutes: 34, lanes: { stated: true, blockedLanes: 3 } },
    { upstream: UNRESOLVED, impactLevel: null, locationHistory: null });
  assert.equal(risk.score, 64);
  assert.equal(risk.level, 'HIGH', 'the evidence that exists is strong, so the level stands');
  assert.ok(['LOW', 'MEDIUM'].includes(risk.confidence.level), 'and confidence reports how much was missing');
  assert.ok(risk.confidence.unknown > 0);
});

test('asset-derived coordinates do not score like surveyed crash geometry', () => {
  // The register publishes no geometry: every position is the damaged ASSET's, and 178 records
  // resolve to 77 points. That is real evidence of where conflicts happen and weaker evidence than
  // a surveyed crash location, so it is weighted down rather than taken at face value.
  const base = {
    available: true,
    analysisWindow: { distanceMeters: 250, lookbackMonths: 12 },
    concentration: { level: 'VERY_HIGH', levelLabel: 'Very high', localValue: 30, corridorBaseline: 3, ratio: 10 },
    crashTypes: [], contributingFactors: [], weatherPatterns: [], timePatterns: [], matches: [],
  };
  const withProvenance = spatialConfidence => ({
    ...base,
    provenance: { spatialConfidence, locationSource: 'DAMAGED_ASSET', locationSourceLabel: 'Damaged asset location', recordNoun: 'historical incidents' },
  });
  const scoreAt = c => assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, locationHistory: withProvenance(c) }).score;
  const full = SECONDARY_RISK_CONFIG.factors.HISTORICAL_LOCATION.levels.VERY_HIGH;
  assert.equal(scoreAt('HIGH'), full);
  assert.equal(scoreAt('MEDIUM'), Math.round(full * 0.7));
  assert.equal(scoreAt('LOW'), Math.round(full * 0.5));
  assert.ok(scoreAt('LOW') < scoreAt('HIGH'), 'weaker geometry, smaller contribution');
  assert.ok(scoreAt('LOW') > 0, 'reduced, never erased — the records still mean something');

  // And the panel wording says so, and calls them incidents rather than crashes.
  const factor = assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, locationHistory: withProvenance('LOW') })
    .factors.find(f => f.type === 'HISTORICAL_LOCATION');
  assert.match(factor.label, /Historical incident concentration/);
  assert.ok(!/crash/i.test(factor.label), 'not called a crash concentration without crash records');
  assert.match(factor.detail, /30 historical incidents within 250 m/);
  assert.match(factor.detail, /typical concentration of incident records/);
  assert.match(factor.detail, /weighted down for low spatial confidence \(Damaged asset location\)/);
  assert.ok(!/crash rate/i.test(factor.detail));
});

test('confirmed crash records are allowed to be called crashes', () => {
  const confirmed = {
    available: true,
    analysisWindow: { distanceMeters: 250, lookbackMonths: 12 },
    concentration: { level: 'HIGH', levelLabel: 'High', localValue: 10, corridorBaseline: 4, ratio: 2.5 },
    crashTypes: [], contributingFactors: [], weatherPatterns: [], timePatterns: [], matches: [],
    provenance: { spatialConfidence: 'HIGH', locationSource: 'RECORD', locationSourceLabel: 'Record coordinates', recordNoun: 'crashes' },
  };
  const factor = assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, locationHistory: confirmed })
    .factors.find(f => f.type === 'HISTORICAL_LOCATION');
  assert.match(factor.label, /Historical crash concentration/);
  assert.match(factor.detail, /10 crashes within 250 m/);
  assert.ok(!/weighted down/.test(factor.detail), 'nothing to discount at high confidence');
});

test('mitigation never calls unconfirmed records "previous crashes"', () => {
  const history = {
    available: true,
    analysisWindow: { distanceMeters: 250, lookbackMonths: 12 },
    concentration: { level: 'VERY_HIGH', levelLabel: 'Very high', localValue: 30, corridorBaseline: 3, ratio: 10 },
    totals: { crashes: 30, severeCrashes: 18, fatalCrashes: 1 },
    crashTypes: [], contributingFactors: [], weatherPatterns: [], timePatterns: [], matches: [],
    provenance: { recordNoun: 'historical incident records', spatialConfidence: 'LOW', locationSourceLabel: 'Damaged asset location' },
  };
  const risk = assessSecondaryRisk(INCIDENT, { upstream: UNRESOLVED, locationHistory: history });
  for (const action of mitigationFor(risk, { upstream: UNRESOLVED, locationHistory: history })) {
    assert.ok(!/previous crash/i.test(action.text), action.text);
    assert.ok(!/crash rate/i.test(action.text), action.text);
  }
  const cluster = mitigationFor(risk, { upstream: UNRESOLVED, locationHistory: history }).find(m => m.id === 'history-elevated');
  assert.match(cluster.text, /30 historical incident records within 250 m/);
  assert.match(cluster.text, /typical concentration of incident records/);
});
