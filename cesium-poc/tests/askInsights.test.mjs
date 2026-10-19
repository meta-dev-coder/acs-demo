import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CARRIAGEWAYS } from '../src/liveOps/carriagewayModel.js';
import { createInsights, groupBySection, PLAYBOOK_WX1, sectionsFromGeojson } from '../server/ask/insights.mjs';
import { planPrefetch } from '../server/ask/prefetch.mjs';
import { finalizeAnswer } from '../server/ask/orchestrator.mjs';
import { openTwinStore, writeTwinStore } from '../server/ask/twinStore.mjs';

const layer = file => JSON.parse(readFileSync(new URL(`../public/data/${file}`, import.meta.url)));
const SECTIONS = sectionsFromGeojson(layer('i595_fdot_traffic_segments.geojson'));
const CENTERLINE = JSON.parse(readFileSync(new URL('../config/corridorCenterline.json', import.meta.url)));
const eb = index => SECTIONS.find(s => s.carriageway === CARRIAGEWAYS.EB_GENERAL && s.sectionIndex === index);
const mid = section => section.coordinates[Math.floor(section.coordinates.length / 2)];
const NOW = Date.parse('2026-10-05T12:00:00Z');

/** A live event placed on an eastbound section, shaped like the server's live payload. */
function liveEvent(type, index, { id, lanes = null, minutesAgo = 5 } = {}) {
  const section = eb(index);
  const [lon, lat] = mid(section);
  return {
    id, type, cleared: false, title: type === 'INCIDENT' ? 'Crash' : type, severity: 'Minor', longitude: lon, latitude: lat,
    sdna: { reported_at: new Date(NOW - minutesAgo * 60_000).toISOString() },
    liveOps: { carriageway: CARRIAGEWAYS.EB_GENERAL, direction: 'EB', sectionId: section.sectionId, sectionIndex: section.sectionIndex,
      sectionLabel: section.sectionLabel, segmentId: section.segmentId, spatialMatch: { confidence: 'HIGH' },
      laneImpact: lanes ?? { blockedLanes: null, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'none' } },
  };
}

/** A crash record on a section's midpoint (or with no position). */
const crash = (id, section, weather, extra = {}) => {
  const [lon, lat] = section ? mid(section) : [null, null];
  return { incident_id: id, incident_date: '2024-05-01', weather, Segment: 'East Segment', 'x_coordinate (from asset)': lon, 'y_coordinate (from asset)': lat,
    lane_closure_duration_hours: 2, injuries_y_n: 'No', ...extra };
};

function withInsights(rows, deps, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ask-insights-'));
  const outPath = join(dir, 'twin.sqlite');
  writeTwinStore({ outPath, asOf: '2026-10-01T00:00:00.000Z', classes: [{ source: 'snapshot:test',
    spec: { className: 'Florida I595 Incidents', key: ['incident_id'], at: ['incident_date'], lon: ['x_coordinate (from asset)'], lat: ['y_coordinate (from asset)'], segment: ['Segment'] },
    rows }] });
  const store = openTwinStore(outPath);
  const insights = createInsights({ store, readLayer: layer, centerline: CENTERLINE, now: () => NOW, ...deps });
  return Promise.resolve(fn(insights.handlers)).finally(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
}

const forecastFetch = probabilities => async () => ({ ok: true, json: async () => ({ hourly: {
  time: probabilities.map((_, i) => `2026-10-05T${String(12 + i).padStart(2, '0')}:00`), precipitation_probability: probabilities, precipitation: probabilities.map(p => p / 50) } }) });

describe('explain_incident and rank_incidents use the TMC risk model', () => {
  const lanes = { blockedLanes: 2, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'parsed' };
  const events = [liveEvent('INCIDENT', 4, { id: 'INC-4', lanes }), liveEvent('CONGESTION', 3, { id: 'CON-3' }), liveEvent('INCIDENT', 8, { id: 'INC-8' })];
  const getLiveEvents = async () => ({ lastUpdated: '2026-10-05T11:59:00Z', events });

  test('the ranking matches the screen’s service and the selected incident is explained with its drivers', () => withInsights([], { getLiveEvents }, async h => {
    const ranked = await h.rank_incidents({});
    assert.equal(ranked.output.activeIncidents, 2);
    assert.equal(ranked.output.ranked[0].id, 'INC-4');
    assert.equal(ranked.source, 'Twin insight · TMC risk model (live events)');
    const explained = await h.explain_incident({ incident_id: 'INC-4' });
    assert.equal(explained.output.risk.rank, 1);
    assert.equal(explained.output.risk.of, 2);
    assert.ok(explained.output.risk.score > ranked.output.ranked[1].score);
    assert.ok(explained.output.risk.drivers.length > 0);
    assert.deepEqual(explained.output.upstream.congestion, ['CON-3']);
    assert.ok(explained.output.notEvaluated.length > 0, 'what could not be evaluated is listed, never scored as fine');
    assert.match(explained.summary, /rank 1 of 2/);
  }));

  test('an incident not in the live feed, a historical date, or no feed at all is a typed gap', () => withInsights([], { getLiveEvents }, async h => {
    assert.match((await h.explain_incident({ incident_id: 'GONE' })).output.gap.detail, /not among the 2 active/);
    assert.match((await h.explain_incident({ incident_id: 'INC-4', temporal: { mode: 'HISTORICAL', date: '2026-09-14' } })).output.gap.detail, /TMC screen only/);
  }).then(() => withInsights([], { getLiveEvents: async () => null }, async h => {
    assert.equal((await h.rank_incidents({})).output.gap.type, 'not_ready');
  })));
});

describe('crash hotspots and the weather forecast scenario', () => {
  const rows = [
    crash('C1', eb(5), 'Light Rain'), crash('C2', eb(5), 'Heavy Rain'), crash('C3', eb(5), 'Thunderstorm'), crash('C4', eb(5), 'Clear'),
    crash('C5', eb(7), 'Clear'), crash('C6', eb(7), 'Light Rain'), crash('C7', null, 'Rain'),
  ];

  test('crashes are placed on FDOT sections; unplaced ones are counted, never ranked', () => {
    const { groups, unplaced } = groupBySection(rows, SECTIONS);
    assert.equal(unplaced, 1);
    assert.equal(groups.get(eb(5).sectionLabel).crashes, 4);
    assert.equal(groups.get(eb(5).sectionLabel).wet, 3);
  });

  test('hotspots rank sections, filter by weather, point at a spot on the road and state the gap', () => withInsights(rows, {}, async h => {
    const wet = h.crash_hotspots({ weather: 'wet' });
    assert.equal(wet.output.totalCrashes, 5);
    assert.equal(wet.output.hotspots[0].section, eb(5).sectionLabel);
    assert.equal(wet.output.hotspots[0].crashes, 3);
    assert.deepEqual([wet.output.hotspots[0].lon, wet.output.hotspots[0].lat], mid(eb(5)).map(v => Number(v.toFixed(4))));
    assert.match(wet.output.gaps[0], /1 of 5 crashes have no position/);
  }));

  test('rain above the threshold fires P-WX-1 for the wettest section, with a baseline and stated gaps', () => withInsights(rows, { fetchImpl: forecastFetch([20, 65, 40]) }, async h => {
    const result = await h.weather_risk_forecast({ hours: 3 });
    const out = result.output;
    assert.equal(out.forecast.peakRainProbability, 65);
    assert.equal(out.recommendation.rule, PLAYBOOK_WX1.id);
    assert.match(out.recommendation.action, new RegExp(eb(5).sectionLabel));
    assert.equal(out.baseline.crashesOnRecord, 7);
    assert.ok(out.gaps.some(g => /exposure/.test(g)));
    assert.match(result.summary, /P-WX-1 recommends/);
  }));

  test('dry forecasts and unreadable forecasts do not fire the rule, and say why', () => withInsights(rows, { fetchImpl: forecastFetch([10, 20]) }, async h => {
    const out = (await h.weather_risk_forecast({ hours: 2 })).output;
    assert.equal(out.recommendation, null);
    assert.match(out.ruleNotFired, /forecast peak 20%/);
  }).then(() => withInsights(rows, { fetchImpl: async () => { throw new Error('offline'); } }, async h => {
    const out = (await h.weather_risk_forecast({})).output;
    assert.equal(out.forecast, null);
    assert.match(out.gaps[0], /could not be read/);
  })));
});

test('a playbook recommendation reaches the answer only from a cited insight result', () => {
  const recommendation = { rule: 'P-WX-1', title: 't', action: 'Pre-position a patrol at X.', basis: 'b', location: { lon: -80.2, lat: 26.1 } };
  const calls = [{ ref: 'R1', name: 'weather_risk_forecast', status: 'ok', evidence: true, source: 'Twin insight', output: { recommendation } }];
  assert.deepEqual(finalizeAnswer(JSON.stringify({ answer: 'a', basis: [{ claim: 'c', refs: ['R1'] }] }), calls).recommendations, [recommendation]);
  assert.deepEqual(finalizeAnswer(JSON.stringify({ answer: 'a', basis: [{ claim: 'c', refs: [] }] }), calls).recommendations, []);
});

describe('prefetch plans the obvious insight first', () => {
  const env = (question, screen = {}) => ({ question, screen });
  test('a question about the selected incident explains it, carrying the screen’s time mode', () => {
    assert.deepEqual(planPrefetch(env('Why is this one high risk?', { selection: { type: 'incident', id: 'FL511-1' }, temporal: { mode: 'LIVE' } })),
      [{ name: 'explain_incident', input: { incident_id: 'FL511-1', temporal: { mode: 'LIVE' } }, why: 'Assessing the selected incident FL511-1 with the TMC risk model first.' }]);
  });
  test('ranking, hotspot and rain-risk questions get their insight; anything else is left to the model', () => {
    assert.deepEqual(planPrefetch(env('Which incident is riskiest?')).map(p => p.name), ['rank_incidents']);
    assert.deepEqual(planPrefetch(env('Where are the crash hotspots in wet weather?')).map(p => [p.name, p.input.weather]), [['crash_hotspots', 'wet']]);
    assert.deepEqual(planPrefetch(env('Rain is coming this afternoon — where should we pre-position patrols?')).map(p => p.name), ['weather_risk_forecast']);
    assert.deepEqual(planPrefetch(env('How long is I-595?')), []);
    assert.deepEqual(planPrefetch(env('Why is this high risk?')), [], 'no selection, no incident to explain');
  });
  test('an incident-history question about a named interchange counts incidents around its ramps', () => {
    const [plan] = planPrefetch(env('What is the incident history at the Turnpike interchange?'));
    assert.equal(plan.name, 'records_near');
    assert.deepEqual(plan.input.place, { layer: 'i595_ramps_connectors_classified.geojson', text: 'Turnpike' });
    assert.equal(planPrefetch(env('How many crashes near SR-7?'))[0].input.place.text, 'US-441');
    assert.deepEqual(planPrefetch(env('Is the Turnpike ramp open?')), [], 'a status question is not a history question');
    assert.deepEqual(planPrefetch(env('Crash hotspots near I-95')).map(p => p.name), ['crash_hotspots']);
  });
  test('every configured place text matches a ramp in the layer', async () => {
    const { readFileSync } = await import('node:fs');
    const places = JSON.parse(readFileSync(new URL('../config/askTwin/places.json', import.meta.url), 'utf8'));
    const ramps = JSON.parse(readFileSync(new URL(`../public/data/${places.layer}`, import.meta.url), 'utf8'));
    const text = ramps.features.map(f => Object.values(f.properties ?? {}).join(' ').toLowerCase()).join('\n');
    for (const p of places.places) assert.ok(text.includes(p.text.toLowerCase()), `${p.name}: '${p.text}' not in ${places.layer}`);
  });
});

describe('explain_incident for a recorded incident', () => {
  test('a register id is explained from the record and its section history, labelled as not the live model', () => withInsights([
    crash('INC-200014', eb(4), 'Light Rain', { incident_type: 'Vehicle vs barrier', lane_closure_y_n: 'Yes', recommended_next_action: 'Inspect barrier' }),
    crash('INC-2', eb(4), 'Clear'), crash('INC-3', eb(8), 'Rain'), crash('INC-4', null, 'Clear'),
  ], {}, async h => {
    const out = await h.explain_incident({ incident_id: 'INC-200014' });
    assert.equal(out.source, 'Twin insight · crash register (recorded incident)');
    assert.equal(out.output.incident.type, 'Vehicle vs barrier');
    assert.equal(out.output.incident.section, eb(4).sectionLabel);
    assert.equal(out.output.section.crashes, 2);
    assert.equal(out.output.section.rankOnCorridor, 1);
    assert.match(out.output.basis, /Not the live TMC risk model/);
    assert.equal(out.output.incident.recommendedNextAction, 'Inspect barrier');
    // Historical mode explains the record too.
    assert.equal((await h.explain_incident({ incident_id: 'INC-200014', temporal: { mode: 'HISTORICAL', date: '2024-05-01' } })).output.incident.id, 'INC-200014');
    // A record with no position says why its section history is missing.
    assert.match((await h.explain_incident({ incident_id: 'INC-4' })).output.gaps[0], /no position/);
  }));
});
