import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { eventPlace, parseTourCommand, parseTypeBrowse, isBareSegmentRequest, isolates, MAX_REMOTE_OFFSET_M, parseFlyRequest, parseRoadRequest, parseSegmentFollowUp, parseSegmentRequest, parseSegmentRequests, resolveFlyTarget, searchAssets, searchEntry, segmentPoint } from '../src/assetExplorer/assetSearch.js';
import { corridorPositionOf } from '../src/assetExplorer/corridorPosition.js';
import { normalizeAsset } from '../src/assetExplorer/assetTypes.js';
import { lightingRecords } from '../src/lightingData.js';

const rows = JSON.parse(readFileSync(new URL('../public/dataconnect-data/asset_registry.json', import.meta.url)));
const lights = lightingRecords(rows).map(r => normalizeAsset({ id: r.id, assetType: 'lighting', name: `Lighting ${r.id}`,
  longitude: r.longitude, latitude: r.latitude, source: { categoryId: r.categoryId, categoryLabel: r.categoryLabel, record: r.source } }));
const at = { longitude: -80.3, latitude: 26.1 };
// Shaped like the bridge layer's own records: id BRIDGE-860384, name "Bridge 860384".
const bridges = ['860384', '860391', '860665'].map(n => normalizeAsset({ id: `BRIDGE-${n}`, assetType: 'bridge', name: `Bridge ${n}`, ...at, source: { assetId: `BRIDGE-${n}` } }));
const cameras = [['1837', 'I-595 ~MP 8.5'], ['2023', 'I-595 ~MP 8.5'], ['1871', 'I-595 ~MP 1.1'], ['2004', 'I-595 ~MP 5.5'], ['4578', '5078 MP 7.8 (W of US-441)']]
  .map(([id, description]) => normalizeAsset({ id, assetType: 'camera', name: `Camera ${id}`, ...at, source: { camera_id: id, description } }));
const gantries = [normalizeAsset({ id: 'I595_GANTRY_037', assetType: 'gantry', name: 'Gantry 37 — Toll Lane', ...at, source: {} })];
const entries = [...lights, ...bridges, ...cameras, ...gantries].map(asset => searchEntry(asset));

const fly = question => {
  const request = parseFlyRequest(question);
  return request ? resolveFlyTarget(searchAssets(entries, request.target, request.types)) : null;
};
const flewTo = (question, type, id) => {
  const result = fly(question);
  assert.equal(result?.kind, 'fly', `${question} → ${JSON.stringify(result?.kind)}`);
  assert.deepEqual([result.asset.assetType, result.asset.id], [type, id], question);
};

test('fly-to phrasing is recognised; ordinary questions are left for the remote service', () => {
  for (const q of ['fly to 11063', 'Fly to bridge 860419', 'take me to camera 1837', 'please zoom to A 1 3-Z4', 'where is lighting 11063?', 'show me bridge 860384', 'go to the gantry 37', 'can you fly me to 11063'.replace(' me', '')])
    assert.ok(parseFlyRequest(q), q);
  for (const q of ['Any incidents on I-595 right now?', 'Are express lanes open eastbound?', 'Which cameras are near the Turnpike?', 'How long is I-595?'])
    assert.equal(parseFlyRequest(q), null, q);
  assert.equal(parseFlyRequest('fly to bridge 860419').target, 'bridge 860419');
});

test('an exact asset ID wins, however it is spaced or punctuated', () => {
  flewTo('fly to 11063', 'lighting', '11063');
  flewTo('fly to A 1 3-Z4', 'lighting', 'A 1 3-Z4');
  flewTo('fly to a13z4', 'lighting', 'A 1 3-Z4');
  // The ITS twin 11256 carries "A-1 -3-Z4" in its description; the record whose ID it is wins.
  flewTo('fly to lighting A-1 -3-Z4', 'lighting', 'A 1 3-Z4');
  flewTo('take me to camera 1837', 'camera', '1837');
});

test('a type word narrows the search, so a bridge number does not land on its under-deck lights', () => {
  // Lighting records carry 860384 as their Segment; "bridge" means the bridge.
  flewTo('go to bridge 860384', 'bridge', 'BRIDGE-860384');
  flewTo('fly to bridge 860391', 'bridge', 'BRIDGE-860391');
  flewTo('fly to BRIDGE-860391', 'bridge', 'BRIDGE-860391');
  flewTo('go to gantry 37', 'gantry', 'I595_GANTRY_037');
});

test('ties are offered as choices rather than guessed; nonsense matches nothing', () => {
  const result = fly('fly to camera MP 8.5');
  assert.equal(result.kind, 'choose');
  assert.deepEqual(result.assets.map(a => a.id).sort(), ['1837', '2023']);
  // A milepost is one number: "MP 8.5" is not "MP 5.5" or "MP 7.8" on a stray 5 or 8.
  assert.equal(fly('fly to camera MP 5.5').asset.id, '2004');
  assert.equal(fly('fly to Mars').kind, 'none');
  // Every word must be found: 860399 is no bridge, and must not fall back to a near miss.
  assert.equal(fly('fly to bridge 860399').kind, 'none');
});

test('segment requests: number or word, which end, and direction only when said', () => {
  const seg = q => parseSegmentRequest(parseFlyRequest(q).target);
  assert.deepEqual(seg('Fly to area where segment one ends'), { index: 1, part: 'end', direction: null });
  assert.deepEqual(seg('fly to segment 3'), { index: 3, part: 'whole', direction: null });
  assert.deepEqual(seg('go to westbound segment 2 start'), { index: 2, part: 'start', direction: 'WB' });
  assert.deepEqual(seg('take me to the third section'), { index: 3, part: 'whole', direction: null });
  assert.equal(seg('fly to camera 1837'), null);
  assert.equal(seg('fly to segment'), null);
});

test('a segment ends at its east end eastbound and its west end westbound', () => {
  // FDOT geometry runs in milepost order, west to east, in both directions.
  const west = { x: 'west' }, middle = { x: 'mid' }, east = { x: 'east' };
  const line = [west, middle, east];
  assert.equal(segmentPoint(line, 'end', 'EB'), east);
  assert.equal(segmentPoint(line, 'start', 'EB'), west);
  assert.equal(segmentPoint(line, 'end', 'WB'), west);
  assert.equal(segmentPoint(line, 'start', 'WB'), east);
  assert.equal(segmentPoint(line, 'whole', 'EB'), null);
});

test('the remote guess for "where segment one ends" is rejected; the real end is not', () => {
  const centerline = JSON.parse(readFileSync(new URL('../config/corridorCenterline.json', import.meta.url)));
  const segments = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url))).features;
  const eb1 = segments.find(f => f.properties.direction === 'EB' && f.properties.fdot_segment_index === 1);
  const [lon, lat] = eb1.geometry.coordinates.at(-1);
  assert.ok(corridorPositionOf(lon, lat, centerline).offsetM < MAX_REMOTE_OFFSET_M);
  // What the remote service actually returned: -80.35, 26.07, in Weston, off the corridor.
  assert.ok(corridorPositionOf(-80.35, 26.07, centerline).offsetM > MAX_REMOTE_OFFSET_M);
});

test('a short follow-up amends the last segment request; a real question does not', () => {
  const last = parseSegmentRequest(parseFlyRequest('show me area near segment 2').target);
  assert.deepEqual(parseSegmentFollowUp('westbound', last), { index: 2, part: 'whole', direction: 'WB' });
  assert.deepEqual(parseSegmentFollowUp('WB', last), { index: 2, part: 'whole', direction: 'WB' });
  assert.deepEqual(parseSegmentFollowUp('where does it end?', last), { index: 2, part: 'end', direction: null });
  const wb = parseSegmentFollowUp('westbound', last);
  assert.equal(parseSegmentFollowUp('the other direction', wb).direction, 'EB');
  for (const q of ['westbound incidents?', 'Are express lanes open eastbound?', 'How long is I-595?'])
    assert.equal(parseSegmentFollowUp(q, last), null, q);
  assert.equal(parseSegmentFollowUp('westbound', null), null, 'nothing to follow up');
});

test('whole-carriageway requests, in the words people use', () => {
  assert.deepEqual(parseRoadRequest('i want to highlight westbound i595'), { direction: 'WB', isolate: true });
  assert.deepEqual(parseRoadRequest('highlight westbound'), { direction: 'WB', isolate: true });
  assert.deepEqual(parseRoadRequest('show only eastbound'), { direction: 'EB', isolate: true });
  assert.deepEqual(parseRoadRequest('show westbound I-595'), { direction: 'WB', isolate: false });
  assert.deepEqual(parseRoadRequest('show all of I-595'), { direction: null, isolate: false });
  assert.deepEqual(parseRoadRequest('show both directions'), { direction: null, isolate: false });
  // Numbered segments, assets and ordinary questions are not carriageway requests.
  for (const q of ['highlight just westbound segment 2', 'show me incidents', 'fly to camera 1837', 'Any incidents on I-595 right now?'])
    assert.equal(parseRoadRequest(q), null, q);
  // "just" isolates a segment too; "only" inside the preposition slot is not swallowed.
  assert.equal(isolates('highlight just westbound segment 2'), true);
  assert.equal(parseFlyRequest('show only eastbound').target, 'only eastbound');
});

test('every segment a request names, each with its own direction', () => {
  const segs = q => parseSegmentRequests(q)?.segments.map(x => `${x.direction}${x.index}`);
  assert.deepEqual(segs('eastbound segment 3'), ['EB3']);
  assert.deepEqual(segs('easbound segment 2 and westbound segment 7'), ['EB2', 'WB7']);      // the typo from the report
  assert.deepEqual(segs('segment 2 eastbound and segment 7 westbound'), ['EB2', 'WB7']);
  assert.deepEqual(segs('eastbound segment 2 and segment 7 westbound'), ['EB2', 'WB7']);
  assert.deepEqual(segs('westbound segments 2, 3 and 5'), ['WB2', 'WB3', 'WB5']);
  assert.deepEqual(segs('eastbound segments 2 to 4'), ['EB2', 'EB3', 'EB4']);
  assert.deepEqual(segs('segment 3 both directions'), ['EB3', 'WB3']);
  assert.deepEqual(segs('the third segment westbound'), ['WB3']);
  assert.deepEqual(segs('segment 2 and 7'), ['null2', 'null7']);
  assert.equal(parseSegmentRequests('area where segment one ends').part, 'end');
  assert.equal(parseSegmentRequests('segment 2 and 7 end').part, 'whole', 'two sections have no single end');
  // "east end" names an end, not a direction.
  assert.deepEqual(segs('segment 2 east end'), ['null2']);
  assert.equal(parseSegmentRequests('camera 1837'), null);
});

test('a bare list of segments is a request; a question about a segment is not', () => {
  for (const q of ['eastbound segment 3', 'easbound segment 2 and westbound segment 7', 'just segment 3 on the map', 'segments 2 to 4 westbound'])
    assert.equal(isBareSegmentRequest(q), true, q);
  for (const q of ['what is the AADT of segment 3?', 'is segment 2 congested', 'How long is I-595?'])
    assert.equal(isBareSegmentRequest(q), false, q);
});

test('a whole type — typos included — is a browse request; a specific asset or a question is not', () => {
  assert.equal(parseTypeBrowse('fly to the clousers'), 'closure');                // the report's spelling
  assert.equal(parseTypeBrowse('show incidents'), 'incident');
  assert.equal(parseTypeBrowse('closures'), 'closure');
  assert.equal(parseTypeBrowse('take me to the cameras'), 'camera');
  assert.equal(parseTypeBrowse('show all the bridges'), 'bridge');
  for (const q of ['fly to camera 1837', 'Any incidents on I-595 right now?', 'Which cameras are near the Turnpike?', 'show both directions'])
    assert.equal(parseTypeBrowse(q), null, q);
});

test('stepping through a list: next, previous, a number, show all', () => {
  for (const q of ['next', 'yes', 'yes please', 'next closure please', 'show the next incident']) assert.deepEqual(parseTourCommand(q), { command: 'next' }, q);
  for (const q of ['previous', 'ok the previous one']) assert.deepEqual(parseTourCommand(q), { command: 'previous' }, q);
  assert.deepEqual(parseTourCommand('2'), { command: 'goto', index: 2 });
  assert.deepEqual(parseTourCommand('the second one'), { command: 'goto', index: 2 });
  assert.deepEqual(parseTourCommand('go to the last one'), { command: 'goto', index: -1 });
  assert.deepEqual(parseTourCommand('show all'), { command: 'all' });
  for (const q of ['westbound', 'How long is I-595?', 'fly to camera 1837']) assert.equal(parseTourCommand(q), null, q);
});

test('a live event named only "Closure" is described by where it is and what is closed', () => {
  assert.equal(eventPlace('Planned construction in Broward County on I-95 South, ramp to Exit 25: SR-84 W/SW 24th St/Marina Mile Blvd. Off-ramp closed. Last updated at 11:03 PM.'),
    'I-95 South, ramp to Exit 25: SR-84 W/SW 24th St/Marina Mile Blvd · Off-ramp closed');
  assert.equal(eventPlace(''), null);
});
