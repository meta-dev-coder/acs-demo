/**
 * Area answers, and the one confusion they must never reproduce.
 *
 * The map's Safety layer badges count HISTORICAL crash records; the area answer was reading only
 * LIVE events. An operator saw a red "23" inside their selection and was told "No incidents are
 * inside the selected area." Both statements were true about different datasets, and nothing on
 * screen said so. These tests pin that the two are always distinguished.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerAreaQuestion, areaSummaryLines, describeIncidents, describeIncidentWeather, describeSummary,
  filterAreaRecords, isMapInstruction, summariseHistoricalRecords, AREA_SUGGESTIONS,
} from '../src/spatial/areaAnswers.js';
import { parseAreaQuestion } from '../src/spatial/areaAnswers.js';

const EMPTY_EVENTS = {
  incidents: [], closures: [], disabledVehicles: [], congestion: [], construction: [],
};
const EMPTY_MAINTENANCE = {
  workOrders: [], tickets: [], tasks: [], inspections: [], incidents: [], damagedAssets: [],
};
const contextWith = ({ live = [], historical = [] } = {}) => ({
  selection: { type: 'RECTANGLE' },
  roadway: { intersectsI595: true, includesExpress: false, segments: [
    { carriageway: 'EB_GENERAL', sectionLabel: 'Eastbound Section 01' }] },
  liveEvents: { ...EMPTY_EVENTS, incidents: live },
  assets: { total: 120, byCategory: {}, records: [] },
  maintenance: { ...EMPTY_MAINTENANCE, incidents: historical },
  totals: { events: live.length, assets: 120, maintenance: historical.length, openWorkOrders: 8, sections: 2 },
});
const record = (id, title, assetId = 'A-1', reported = null) =>
  ({ id, title, locatedVia: 'asset', assetId, reported });

test('the exact reported case: no live incidents, but historical records are present', () => {
  const historical = Array.from({ length: 23 }, (_, i) => record(`INC-${i + 1}`, 'Crash'));
  const answer = describeIncidents(contextWith({ live: [], historical }));
  // The live position is still stated plainly...
  assert.match(answer, /No live incidents are inside the selected area/);
  // ...and the 23 the operator can see on the map is accounted for.
  assert.match(answer, /23 historical incident records/);
  assert.match(answer, /past records, not current conditions/);
  assert.match(answer, /hotspot badges count/, 'must point at where the number came from');
});

test('the records are grouped, not listed as ids', () => {
  // The complaint this fixes: eight record ids and "…and 15 more" said nothing about what the
  // records had in common, which is the only reason anyone asks about them.
  const historical = [
    ...Array.from({ length: 5 }, (_, i) => record(`A${i}`, 'Attenuator hit', 'S-33015A', '18/12/2025 00:00')),
    ...Array.from({ length: 4 }, (_, i) => record(`B${i}`, 'Single-vehicle lane departure', 'S-32026', '03/01/2026 00:00')),
    ...Array.from({ length: 2 }, (_, i) => record(`C${i}`, 'Vehicle fire', 'S-32026', '06/03/2026 00:00')),
  ];
  const answer = describeIncidents(contextWith({ historical }));
  assert.match(answer, /What they are/);
  assert.match(answer, /5 × Attenuator hit/);
  assert.match(answer, /4 × Single-vehicle lane departure/);
  assert.match(answer, /Where they cluster/);
  assert.match(answer, /6 at asset S-32026/);
  assert.match(answer, /5 at asset S-33015A/);
  assert.match(answer, /When/);
  assert.match(answer, /Dec 2025 – Mar 2026/);
  // The old shape must be gone.
  assert.ok(!/…and \d+ more/.test(answer), 'no truncated id dump');
  assert.ok(!/• A0/.test(answer), 'record ids are not the answer');
});

test('the summary counts types, assets and the period without rewriting source wording', () => {
  const summary = summariseHistoricalRecords([
    record('1', 'Attenuator hit', 'S-1', '18/12/2025 00:00'),
    record('2', 'Attenuator hit', 'S-2', '03/01/2026 00:00'),
    record('3', 'Vehicle fire', 'S-1', null),
  ]);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byType[0], ['Attenuator hit', 2], 'source wording, counted as-is');
  assert.equal(summary.distinctTypes, 2);
  assert.equal(summary.distinctAssets, 2);
  assert.equal(summary.datedRecords, 2, 'an undated record is not given a date');
  assert.equal(summary.viaAsset, 3);
  assert.ok(summary.from < summary.to);
});

test('undated records are declared rather than hidden', () => {
  const historical = [
    record('1', 'Attenuator hit', 'S-1', '18/12/2025 00:00'),
    record('2', 'Vehicle fire', 'S-1', null),
  ];
  assert.match(describeIncidents(contextWith({ historical })), /1 without a reported date/);
});

test('records with no dates at all say so instead of inventing a period', () => {
  const historical = [record('1', 'Attenuator hit', 'S-1', null)];
  const answer = describeIncidents(contextWith({ historical }));
  assert.match(answer, /No reported dates on these records/);
});

test('the provenance caveats survive the regrouping', () => {
  const historical = [record('1', 'Attenuator hit', 'S-1', '18/12/2025 00:00')];
  const answer = describeIncidents(contextWith({ historical }));
  assert.match(answer, /positioned at the damaged asset rather than at surveyed coordinates/);
  assert.match(answer, /does not confirm every one as a crash/);
  assert.match(answer, /concentration of reports, not a measured crash rate/);
});

test('an empty area says nothing is there, without inventing history', () => {
  // It still must not describe records that are not there — but silence is not acceptable
  // either, because silence reads as "none" when the register may simply not be loaded.
  const answer = describeIncidents({ ...contextWith({}), maintenanceCorpus: { incidents: 181 } });
  assert.match(answer, /No live incidents are inside the selected area/);
  assert.match(answer, /None of the 181 incident records/);
  assert.ok(!/× /.test(answer), 'no grouped record list when there are no records');
});

test('live incidents are reported as live, and history alongside them', () => {
  const answer = describeIncidents(contextWith({
    live: [{ title: 'FL511-1', severity: 'Minor', status: 'Active', carriagewayLabel: 'Westbound' }],
    historical: [record('INC-9', 'Rear-end')],
  }));
  assert.match(answer, /1 live incident inside the selected area/);
  assert.match(answer, /FL511-1 · Minor · Active · Westbound/);
  assert.match(answer, /1 historical incident record/);
});

test('many distinct types are rolled up rather than listed in full', () => {
  const historical = Array.from({ length: 10 }, (_, i) => record(`INC-${i}`, `Type ${i}`, `S-${i}`));
  const answer = describeIncidents(contextWith({ historical }));
  // Four named, the remainder counted — a readable list, not ten bullets.
  assert.match(answer, /across 6 other types/);
  assert.match(answer, /spread across 10 distinct asset locations in all/);
});

test('the incidents intent routes to the combined answer', () => {
  const historical = [record('INC-1', 'Crash')];
  const context = contextWith({ historical });
  for (const question of ['Are there any incidents here?', 'Have there been crashes here before?']) {
    // parseAreaQuestion only engages when an area is actually drawn.
    const intent = parseAreaQuestion(question, true);
    assert.equal(intent, 'incidents', question);
    assert.match(answerAreaQuestion(intent, context), /historical incident record/);
  }
});

test('the drawn-area summary labels both counts, one per row', () => {
  const lines = areaSummaryLines(contextWith({ historical: [record('INC-1'), record('INC-2')] }));
  assert.ok(lines.some(line => line === '• 0 live incidents'), `got ${JSON.stringify(lines)}`);
  assert.ok(lines.some(line => line === '• 2 historical incident records'));
  // Each fact is its own entry, so the bubble can render it as its own row.
  assert.ok(lines.includes('Roadway') && lines.includes('In this area'), 'grouped under headings');
  assert.ok(lines.filter(line => line.startsWith('• ')).length >= 6);
});

test('the summary distinguishes zero records from a register still loading', () => {
  // Loaded, genuinely none here.
  const loaded = areaSummaryLines({ ...contextWith({}), maintenanceCorpus: { incidents: 181 } });
  assert.ok(loaded.some(line => line === '• 0 historical incident records'));
  // Not loaded: never reported as a zero.
  const loading = areaSummaryLines({ ...contextWith({}), maintenanceCorpus: { incidents: 0 } });
  assert.ok(loading.some(line => /register still loading/.test(line)));
  assert.ok(!loading.some(line => line === '• 0 historical incident records'));
});

test('the whole-picture summary says "live incident", never a bare "incident"', () => {
  const summary = describeSummary(contextWith({ historical: [record('INC-1')] }));
  assert.match(summary, /0 live incidents/);
  assert.match(summary, /1 historical incident record \(past records, not current conditions\)/);
});

test('a suggestion exists for the historical question', () => {
  assert.ok(AREA_SUGGESTIONS.includes('Have there been crashes here before?'));
});

// ─────────────────────────────────────── the two kinds of empty

test('an unloaded register is never reported as "no records here"', () => {
  // The register loads lazily — measured at zero for ~12 s after the screen opens. A question
  // asked in that window used to get silence about history, which reads as "there is none".
  const answer = describeIncidents({
    ...contextWith({}), maintenanceCorpus: { incidents: 0 },
  });
  assert.match(answer, /No live incidents are inside the selected area/);
  assert.match(answer, /has not finished loading/i);
  assert.ok(!/None of the/.test(answer), 'must not claim a count it could not take');
});

test('a loaded register with nothing in the box says so, with the corpus size', () => {
  const answer = describeIncidents({
    ...contextWith({}), maintenanceCorpus: { incidents: 181 },
  });
  assert.match(answer, /None of the 181 incident records in the register fall inside/);
  assert.ok(!/has not finished loading/.test(answer));
});

test('records present still take precedence over either empty message', () => {
  const answer = describeIncidents({
    ...contextWith({ historical: [record('INC-1', 'Attenuator hit', 'S-1', '18/12/2025 00:00')] }),
    maintenanceCorpus: { incidents: 181 },
  });
  assert.match(answer, /1 historical incident record/);
  assert.ok(!/None of the 181/.test(answer));
  assert.ok(!/has not finished loading/.test(answer));
});

test('a bare historical follow-up routes to the incidents answer', () => {
  // "I am asking historical" carries no incident word and used to reach the remote model.
  for (const question of ['I am asking historical', 'historical please', 'what about the past?']) {
    assert.equal(parseAreaQuestion(question, true), 'incidents', question);
  }
  // Without an area drawn it is still not an area question.
  assert.equal(parseAreaQuestion('I am asking historical', false), null);
});

// ─────────────────────────────────── reconciling the map's hotspot badges

const withCrashes = (overrides = {}) => ({
  ...contextWith({}),
  maintenanceCorpus: { incidents: 181 },
  crashes: { available: true, total: 2, fromRegister: 0, fromFeed: 2, records: [] },
  ...overrides,
});

test('a hotspot badge the register cannot account for is explained, not contradicted', () => {
  // The reported case: a "2 crashes within 100 m" badge over a box holding zero register records.
  // Both numbers were right; nothing said they came from different corpora.
  const answer = describeIncidents(withCrashes());
  assert.match(answer, /None of the 181 incident records in the register/);
  assert.match(answer, /2 crash records inside the area on the Safety layer/);
  assert.match(answer, /0 from the incident register, 2 derived from the live FL511 feed/);
  assert.match(answer, /hotspot badges count/);
});

test('the crash line is omitted when the two corpora already agree', () => {
  const agreeing = withCrashes({
    maintenance: { ...contextWith({}).maintenance, incidents: [record('INC-1', 'Crash', 'S-1', '18/12/2025 00:00')] },
    crashes: { available: true, total: 1, fromRegister: 1, fromFeed: 0, records: [] },
  });
  const answer = describeIncidents(agreeing);
  assert.match(answer, /1 historical incident record/);
  // The phrase "Safety layer" legitimately appears in the normal grouped text, so the assertion
  // targets the reconciliation sentence itself.
  assert.ok(!/crash records inside the area on the Safety layer/.test(answer),
    'no reconciliation needed when the counts match');
});

test('no crash corpus available means no claim about one', () => {
  const answer = describeIncidents({ ...contextWith({}), maintenanceCorpus: { incidents: 181 } });
  assert.ok(!/crash records inside the area on the Safety layer/.test(answer));
});

test('the summary carries the hotspot count when it differs from the register', () => {
  const lines = areaSummaryLines(withCrashes());
  assert.ok(lines.some(line => line === '• 0 historical incident records'));
  assert.ok(lines.some(line => line === '• 2 crash records on the Safety layer (2 from the live feed)'));
});

// ─────────────────────────────────── "how are these crashes correlated?"

const crashRecord = (id, title, severity, iso, source = 'feed') =>
  ({ id, title, severity, reportedAtMs: iso ? Date.parse(iso) : null, source });

test('asking how crashes correlate gets the relations, not just a count', () => {
  const answer = describeIncidents({
    ...contextWith({}), maintenanceCorpus: { incidents: 181 },
    crashes: { available: true, total: 2, fromRegister: 0, fromFeed: 2, records: [
      crashRecord('FL511-1', 'Crash', 'Minor', '2026-10-01T06:13:00Z'),
      crashRecord('FL511-2', 'Incident', 'Minor', '2026-10-01T06:21:00Z'),
    ] },
  });
  assert.match(answer, /What they have in common/);
  assert.match(answer, /Type: all different — Crash, Incident/);
  assert.match(answer, /Severity: 2 × Minor/);
  assert.match(answer, /Reported on the same day/);
  // The correlation must never be stated as a cause.
  assert.match(answer, /proximity, not a common cause/);
  assert.match(answer, /Nothing in these records links one to another/);
});

test('repeated types are counted rather than listed as all different', () => {
  const answer = describeIncidents({
    ...contextWith({}), maintenanceCorpus: { incidents: 181 },
    crashes: { available: true, total: 3, fromRegister: 1, fromFeed: 2, records: [
      crashRecord('A', 'Rear-end', 'Minor', '2026-01-02T00:00:00Z', 'register'),
      crashRecord('B', 'Rear-end', 'Major', '2026-03-02T00:00:00Z'),
      crashRecord('C', 'Vehicle fire', 'Minor', '2026-03-05T00:00:00Z'),
    ] },
  });
  assert.match(answer, /Type: 2 × Rear-end, 1 × Vehicle fire/);
  assert.match(answer, /Severity: 2 × Minor, 1 × Major/);
  assert.match(answer, /Reported 62 days apart/);
  assert.match(answer, /Source: 2 × feed, 1 × register/);
});

test('a single crash is not given a pattern it cannot have', () => {
  const answer = describeIncidents({
    ...contextWith({}), maintenanceCorpus: { incidents: 181 },
    crashes: { available: true, total: 1, fromRegister: 0, fromFeed: 1,
      records: [crashRecord('FL511-9', 'Crash', 'Minor', '2026-10-01T06:13:00Z')] },
  });
  assert.ok(!/What they have in common/.test(answer), 'one record has nothing to correlate with');
  assert.match(answer, /The one record is FL511-9 · Crash/);
});

test('records with no published times say so rather than being ordered', () => {
  const answer = describeIncidents({
    ...contextWith({}), maintenanceCorpus: { incidents: 181 },
    crashes: { available: true, total: 2, fromRegister: 0, fromFeed: 2, records: [
      crashRecord('A', 'Crash', 'Minor', null), crashRecord('B', 'Crash', 'Minor', null),
    ] },
  });
  assert.match(answer, /No reported times are published on these records/);
  assert.ok(!/days apart/.test(answer));
});

// ─────────────────────────────────── "how are these related in terms of weather?"

const weatherRecord = (id, weather) =>
  ({ id, title: 'Rear-end crash', assetId: 'A-1', reported: '18/12/2025 00:00', locatedVia: 'asset', weather });
const weatherContext = records => ({
  ...contextWith({ historical: records }), maintenanceCorpus: { incidents: 181 },
});

test('a weather question gets a weather answer, not the generic breakdown', () => {
  // The reported case: asking about weather returned the type-and-location grouping instead.
  assert.equal(parseAreaQuestion('how are 23 historical incidents related in terms of weather', true),
    'incidentWeather');
  const answer = describeIncidentWeather(weatherContext([
    weatherRecord('A', 'Clear'), weatherRecord('B', 'Clear'), weatherRecord('C', 'Rain'),
  ]));
  assert.match(answer, /2 × Clear/);
  assert.match(answer, /1 × Rain/);
  assert.ok(!/Where they cluster/.test(answer), 'not the generic grouping');
});

test('the weather intent is matched before the general incidents one', () => {
  for (const question of ['what weather were these incidents recorded in?', 'did it rain?',
    'were these crashes in the rain?']) {
    assert.equal(parseAreaQuestion(question, true), 'incidentWeather', question);
  }
  // A plain incidents question is untouched.
  assert.equal(parseAreaQuestion('how many historical incidents in selected area?', true), 'incidents');
});

test('records without a condition are counted out of the denominator, not guessed', () => {
  const answer = describeIncidentWeather(weatherContext([
    weatherRecord('A', 'Clear'), weatherRecord('B', null), weatherRecord('C', null),
  ]));
  assert.match(answer, /1 carry a recorded weather condition, 2 do not/);
  assert.match(answer, /• 1 × Clear — 100%/, 'shares are of the records that have one');
});

test('no conditions at all is said plainly rather than shown as an empty chart', () => {
  const answer = describeIncidentWeather(weatherContext([weatherRecord('A', null), weatherRecord('B', null)]));
  assert.match(answer, /none of them carries a recorded weather condition/i);
  assert.match(answer, /nothing is inferred from the date/i);
});

test('the weather answer never implies the weather caused anything', () => {
  const answer = describeIncidentWeather(weatherContext([
    weatherRecord('A', 'Rain'), weatherRecord('B', 'Rain'), weatherRecord('C', 'Clear'),
  ]));
  assert.match(answer, /does not establish that the weather contributed/i);
  assert.match(answer, /not the same as the most dangerous/i);
  assert.match(answer, /No exposure denominator is available/i);
  assert.ok(!/caused|because of the weather/i.test(answer));
});

test('an empty area distinguishes a loading register from genuinely none', () => {
  const loading = describeIncidentWeather({ ...contextWith({}), maintenanceCorpus: { incidents: 0 } });
  assert.match(loading, /has not finished loading/);
  const none = describeIncidentWeather({ ...contextWith({}), maintenanceCorpus: { incidents: 181 } });
  assert.match(none, /None of the 181 incident records/);
  assert.match(none, /nothing to group by weather/);
});

// ─────────────────────────────────── "show them on the map"

const placed = (id, title, weather, lon = -80.26, lat = 26.06) =>
  ({ id, title, weather, longitude: lon, latitude: lat, assetId: 'A-1', locatedVia: 'asset' });

test('a show-on-map instruction is recognised as an instruction, not a question', () => {
  for (const question of ['show on cesium view the one with light rain', 'show them on the map',
    'highlight the rear-end crashes on the map', 'plot these on the globe']) {
    assert.equal(parseAreaQuestion(question, true), 'showRecords', question);
  }
  // It must not be answered in prose; the caller performs it.
  assert.equal(answerAreaQuestion('showRecords', contextWith({})), null);
});

test('listing questions are not mistaken for map instructions', () => {
  assert.equal(parseAreaQuestion('show open work orders', true), 'workOrders');
  assert.equal(parseAreaQuestion('show me the incidents here', true), 'incidents');
});

test('a weather qualifier picks exactly those records', () => {
  const context = { maintenance: { incidents: [
    placed('A', 'Rear-end crash', 'Light Rain'), placed('B', 'Rear-end crash', 'Rain'),
    placed('C', 'Attenuator hit', 'Clear'),
  ] }, maintenanceCorpus: { incidents: 181 } };
  // "light rain" must win over "rain", which is a substring of it.
  const light = filterAreaRecords(context, 'show on cesium view the one with light rain');
  assert.deepEqual(light.records.map(r => r.id), ['A']);
  assert.match(light.label, /Light Rain/);
  const rain = filterAreaRecords(context, 'show the rain ones on the map');
  assert.deepEqual(rain.records.map(r => r.id), ['B']);
});

test('a type qualifier works when no weather matches', () => {
  const context = { maintenance: { incidents: [
    placed('A', 'Rear-end crash', 'Clear'), placed('B', 'Rear-end crash', 'Clear'),
    placed('C', 'Attenuator hit', 'Clear'),
  ] }, maintenanceCorpus: { incidents: 181 } };
  const result = filterAreaRecords(context, 'show rear-end crash on the map');
  assert.deepEqual(result.records.map(r => r.id), ['A', 'B']);
});

test('an unqualified instruction means all of them', () => {
  const context = { maintenance: { incidents: [
    placed('A', 'x', 'Clear'), placed('B', 'y', 'Rain'),
  ] }, maintenanceCorpus: { incidents: 181 } };
  const result = filterAreaRecords(context, 'show them on the map');
  assert.equal(result.records.length, 2);
  assert.equal(result.matched, false, 'nothing was named, so nothing was filtered');
});

test('a filter is only ever drawn from values the records actually carry', () => {
  const context = { maintenance: { incidents: [placed('A', 'Rear-end crash', 'Clear')] },
    maintenanceCorpus: { incidents: 181 } };
  // "Snow" is not a condition in this set, so it selects nothing special rather than inventing one.
  const result = filterAreaRecords(context, 'show the snow ones on the map');
  assert.equal(result.matched, false);
  assert.equal(result.records.length, 1, 'falls back to all, never to a fabricated match');
});

test('nothing to show says why, distinguishing a loading register', () => {
  const loading = filterAreaRecords({ maintenance: { incidents: [] }, maintenanceCorpus: { incidents: 0 } }, 'show them');
  assert.equal(loading.records.length, 0);
  assert.match(loading.reason, /has not finished loading/);
  const none = filterAreaRecords({ maintenance: { incidents: [] }, maintenanceCorpus: { incidents: 181 } }, 'show them');
  assert.match(none.reason, /no incident records fall inside/);
});

// ─────────────────────────────────── recognising a map instruction

test('"fly" is a map verb — the phrasing the application itself uses', () => {
  // Its absence meant "fly to the windy incidents on the cesium map" was answered in prose.
  for (const question of ['fly to the windy incidents on the cesium map',
    'zoom to them on the map', 'take me to those on the globe', 'locate them on the map']) {
    assert.equal(parseAreaQuestion(question, true), 'showRecords', question);
  }
});

test('a named subset makes a verb enough, without a map word', () => {
  // "show me 6 windy incidents for this region" is plainly an instruction.
  assert.equal(isMapInstruction('show me 6 windy incident for this region', { qualified: true }), true);
  // The same verb with nothing named is a request to list, not to draw.
  assert.equal(isMapInstruction('show me the incidents here', { qualified: false }), false);
});

test('a map word covers a mistyped verb when a subset is named', () => {
  // "fky … mao" — guessing at spellings is worse than reading the noun.
  assert.equal(isMapInstruction('fky to 6 windy incidents on cesium mao', { qualified: true }), true);
  // But a map word alone, with nothing named, is not an instruction.
  assert.equal(isMapInstruction('what does the cesium map show?', { qualified: false }), false);
});

test('an explicit map word and verb needs no qualifier', () => {
  assert.equal(isMapInstruction('show them on the map', { qualified: false }), true);
});

test('listing and explaining questions are still not instructions', () => {
  for (const question of ['show open work orders', 'what weather were these in?',
    'how many historical incidents in selected area?']) {
    assert.equal(isMapInstruction(question, { qualified: false }), false, question);
  }
});
