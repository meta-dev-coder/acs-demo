/**
 * Ask the Twin: intents, entity resolution, spatial queries, conversation context, tool
 * execution, action validation and unavailable-data handling.
 *
 * Every test runs against the REAL data files this app ships — the county road extract, the
 * building footprints and the registry — so a passing test says the assistant works on the data
 * the demo will use, not on a fixture shaped to suit it.
 *
 * The FL511 payloads are the exception, and deliberately so: a live feed cannot be a test oracle
 * (it is empty at 11am and busy at 5pm). The payloads below are HAND-WRITTEN, labelled here, and
 * never served to the application — they exist to exercise the stale, unreachable and non-empty
 * paths, which are the ones a live feed will not reproduce on demand.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildRoadSegments } from '../src/roads/roadModel.js';
import { buildBuildings } from '../src/buildings/buildingModel.js';
import { linksByAsset, linksFor, proposedLinks, resolveAssets } from '../src/infrastructure/assetModel.js';
import { createDataView } from '../src/ask/dataView.js';
import { INTENT, readRadius, routeIntent } from '../src/ask/intents.js';
import { answerQuestion } from '../src/ask/askTwin.js';
import { buildTwinContext } from '../src/ask/twinContext.js';
import { SUBJECT, createSession, rememberAnswer, resolveSubject } from '../src/ask/session.js';
import {
  ACTION, flyToAsset, showBuildings, showCameras, showRoads, validateAction, validateActions,
} from '../src/ask/actions.js';
import {
  GAP, getAssetCounts, getLiveTrafficEvents, getNearbyBuildings, getNearbyCameras, getNearbyRoads,
  getRoadsForAsset, searchInfrastructureAssets,
} from '../src/ask/tools.js';
import {
  distanceToFootprintM, distanceToPolylineM, readableMetres, withinRadius,
} from '../src/ask/spatial.js';
import { SUGGESTED_QUESTIONS } from '../src/config/askTwin.js';
import {
  ALLOWED_INTENTS, interpretQuestion, sanitizeInterpretation,
} from '../../portmiami-digital-twin/server/portmiami/askInterpreter.mjs';

const read = name => JSON.parse(readFileSync(fileURLToPath(new URL(`../public/data/${name}`, import.meta.url)), 'utf8'));
const segments = buildRoadSegments(read('portmiami_roads_merged.geojson'));
const buildings = buildBuildings(read('portmiami_buildings_partial_6000.geojson'));
const assets = resolveAssets({ segments, buildings });
const index = linksByAsset({ buildingLinks: [], roadLinks: [], history: [] }, proposedLinks(assets));
const buildingsById = new Map(buildings.map(b => [b.objectId, b]));

// ---- hand-written FL511 payloads, never served to the app ------------------------------------
const CAMERA_LIVE = {
  sourceStatus: 'LIVE', lastSuccessfulUpdate: '2026-11-16T11:50:14.255Z',
  dataFreshness: { ageSeconds: 12 },
  cameras: [
    { id: '468', name: 'NW 2 AVE at Port Blvd', longitude: -80.18500, latitude: 25.77900, videoEnabled: true },
    { id: '409', name: null, longitude: -80.151245, latitude: 25.771976, videoEnabled: true },
    { id: '999', name: 'Far away', longitude: -80.40000, latitude: 25.60000, videoEnabled: null },
  ],
};
const EVENTS_LIVE = {
  sourceStatus: 'LIVE', lastSuccessfulUpdate: '2026-11-16T11:50:14.255Z',
  dataFreshness: { ageSeconds: 20 },
  events: [
    { id: 'FL511-1', type: 'CLOSURE', title: 'Road closed', roadName: 'PORT BLVD', longitude: -80.1795, latitude: 25.7795 },
    { id: 'FL511-2', type: 'CONSTRUCTION', title: 'Roadwork', roadName: 'NW 2 AVE', longitude: -80.1960, latitude: 25.7810 },
  ],
};
const EVENTS_EMPTY = { sourceStatus: 'LIVE', lastSuccessfulUpdate: '2026-11-16T11:50:14.255Z', dataFreshness: { ageSeconds: 9 }, events: [] };
const EVENTS_STALE = { ...EVENTS_LIVE, sourceStatus: 'STALE', dataFreshness: { ageSeconds: 900 } };
const EVENTS_DOWN = { sourceStatus: 'SERVICE_UNREACHABLE', events: [] };

const trafficFrom = (eventsPayload, camerasPayload = CAMERA_LIVE) => ({
  events: eventsPayload.events ?? [], cameras: camerasPayload.cameras ?? [], signs: [],
  eventsById: new Map((eventsPayload.events ?? []).map(e => [e.id, e])),
  camerasById: new Map((camerasPayload.cameras ?? []).map(c => [c.id, c])),
  signsById: new Map(),
  eventsPayload, camerasPayload, signsPayload: { sourceStatus: 'LIVE', signs: [] },
});

const makeView = (traffic = trafficFrom(EVENTS_LIVE)) => createDataView({
  assets, segments, buildings, buildingsById, traffic, linksFor: id => linksFor(index, id),
});

const emptyContext = () => buildTwinContext({
  selection: null, infra: { selected: null, linksFor: id => linksFor(index, id) },
  roads: { segments }, buildings: { buildings }, traffic: trafficFrom(EVENTS_LIVE),
  explorer: 'NONE', viewer: null, buildingsById,
});

const ask = (question, { view = makeView(), context = emptyContext(), memory = createSession(), route } = {}) =>
  answerQuestion({ question, context, view, memory, route });

// ---- intent recognition -----------------------------------------------------------------------

test('every suggested question routes to a real intent, not the fallback', () => {
  for (const suggestion of SUGGESTED_QUESTIONS) {
    const { intent } = routeIntent(suggestion.text);
    assert.notEqual(intent, INTENT.UNSUPPORTED, `“${suggestion.text}” was not recognised`);
  }
});

test('the router reads the kind asked for from the left of “near”, and the place from the right', () => {
  // "parking garages near Terminal B" is a parking question anchored on a terminal. Reading the
  // category from the whole sentence would make it a question about cruise terminals.
  const { intent, slots } = routeIntent('Show parking garages near Terminal B.');
  assert.equal(intent, INTENT.NEARBY_ASSETS);
  assert.equal(slots.category, 'PARKING');
  assert.equal(slots.name, 'Terminal B');
});

test('a traffic word wins over the place in it', () => {
  assert.equal(routeIntent('Are there closures near Terminal A?').intent, INTENT.CLOSURES);
  assert.equal(routeIntent('Show cameras near Terminal A').intent, INTENT.NEARBY_CAMERAS);
});

test('a question with no bearing on this twin is UNSUPPORTED, not a guess', () => {
  for (const q of ['what is the capital of France?', 'write me a poem', 'how is the weather in Rome']) {
    assert.equal(routeIntent(q).intent, INTENT.UNSUPPORTED, q);
  }
});

test('an explicit radius is read and clamped; otherwise the documented default applies', () => {
  assert.deepEqual(readRadius('buildings within 200 meters of this road', 250), { radiusM: 200, explicit: true, clamped: false });
  assert.equal(readRadius('cameras within 2 km', 1000).radiusM, 2000);
  assert.equal(readRadius('within 99999 km', 1000).radiusM, 5000);      // clamped
  assert.deepEqual(readRadius('show cameras', 1000), { radiusM: 1000, explicit: false });
});

// ---- entity resolution -------------------------------------------------------------------------

test('“Terminal A” resolves to Terminal A, not to Terminal AA', () => {
  const found = searchInfrastructureAssets(makeView(), 'Terminal A');
  assert.ok(found.ok);
  assert.equal(found.matches.length, 1, found.matches.map(a => a.name).join(' / '));
  assert.equal(found.matches[0].id, 'terminal-a');
  // And the other one is still reachable by its own designation.
  assert.equal(searchInfrastructureAssets(makeView(), 'Terminal AA').matches[0].id, 'terminal-aa');
});

test('a name nothing matches is a gap, never the nearest-looking record', () => {
  const found = searchInfrastructureAssets(makeView(), 'Terminal Z');
  assert.equal(found.ok, false);
  assert.equal(found.gap, GAP.NOT_FOUND);
});

test('an ambiguous name asks which one, and offers them', () => {
  const subject = resolveSubject({
    slots: { name: 'Terminal' }, context: emptyContext(), memory: createSession(), view: makeView(),
  });
  assert.equal(subject.ok, false);
  assert.equal(subject.needs, 'CHOICE');
  assert.ok(subject.options.length > 1);
});

test('a pronoun with nothing selected asks rather than guessing', () => {
  const subject = resolveSubject({
    slots: { referent: true, raw: 'what roads are near this terminal?', anchorText: 'this terminal' },
    context: emptyContext(), memory: createSession(), view: makeView(),
  });
  assert.equal(subject.ok, false);
  assert.equal(subject.needs, 'SELECTION');
  assert.match(subject.message, /Select an asset, road or building/);
});

test('“this road” resolves to the SELECTED road even when an asset is also selected', () => {
  const road = segments.find(s => s.name);
  const context = buildTwinContext({
    selection: { kind: 'road', id: road.objectId },
    infra: { selected: assets.find(a => a.id === 'terminal-b'), linksFor: id => linksFor(index, id) },
    roads: { segments }, buildings: { buildings }, traffic: trafficFrom(EVENTS_LIVE),
    explorer: 'ROADS', viewer: null, buildingsById,
  });
  const subject = resolveSubject({
    slots: { referent: true, raw: 'buildings near this road', anchorText: 'this road' },
    context, memory: createSession(), view: makeView(),
  });
  assert.equal(subject.ok, true);
  assert.equal(subject.kind, SUBJECT.ROAD);
  assert.equal(subject.objectId, road.objectId);
});

// ---- spatial queries ----------------------------------------------------------------------------

test('distance is measured to an edge, not to the nearest vertex', () => {
  // A long two-vertex segment, and a point 100 m from its middle. Vertex distance would be ~500 m.
  const line = [[-80.19, 25.78], [-80.18, 25.78]];
  const beside = [-80.185, 25.7809];
  const toEdge = distanceToPolylineM(beside, line);
  assert.ok(toEdge > 90 && toEdge < 110, `${toEdge} m`);
});

test('a point inside a footprint is at distance zero, and one outside is measured to its wall', () => {
  const building = buildings.find(b => b.groundAreaM2 > 2000);
  assert.equal(distanceToFootprintM(building.centroid, building), 0);
  const outside = [building.bounds.west - 0.002, building.bounds.south - 0.002];
  assert.ok(distanceToFootprintM(outside, building) > 100);
});

test('withinRadius reports the full total and returns only the page it names', () => {
  const point = [-80.1795, 25.7795];
  const { within, total } = withinRadius(buildings, point, 400, {
    measure: (b, from) => distanceToFootprintM(from, b), bounds: b => b.bounds, limit: 5,
  });
  assert.ok(total >= within.length);
  assert.ok(within.length <= 5);
  // Sorted nearest first.
  for (let i = 1; i < within.length; i += 1) assert.ok(within[i].distanceM >= within[i - 1].distanceM);
});

test('nearby roads and buildings come back as real OBJECTIDs from the loaded files', () => {
  const view = makeView();
  const terminal = assets.find(a => a.id === 'terminal-a');
  const point = view.anchorFor(terminal).point;
  const roads = getNearbyRoads(view, point, { radiusM: 300 });
  const footprints = getNearbyBuildings(view, point, { radiusM: 250 });
  assert.ok(roads.ok && roads.total > 0);
  assert.ok(footprints.ok && footprints.total > 0);
  for (const row of roads.roads) assert.ok(view.roadsById.has(row.objectId));
  for (const row of footprints.buildings) assert.ok(view.buildingsById.has(row.objectId));
});

test('metres are written the way an answer should state them', () => {
  assert.equal(readableMetres(94), '90 m');
  assert.equal(readableMetres(1240), '1.2 km');
  assert.equal(readableMetres(NaN), 'unknown');
});

// ---- tool execution -------------------------------------------------------------------------------

test('counts come from the registry, and separate verified from located', () => {
  const counts = getAssetCounts(makeView(), { category: 'CRUISE_TERMINAL' });
  assert.ok(counts.ok);
  assert.equal(counts.total, assets.filter(a => a.category === 'CRUISE_TERMINAL').length);
  assert.equal(counts.total, 10);
  assert.ok(counts.located <= counts.total);
  assert.equal(counts.withConfirmedFootprint, 0, 'no footprint is confirmed in a fresh session');
});

test('roads for an asset keep confirmed access apart from mere proximity', () => {
  const result = getRoadsForAsset(makeView(), 'terminal-a', { radiusM: 300 });
  assert.ok(result.ok);
  assert.deepEqual(result.confirmed, [], 'nothing is confirmed in a fresh session');
  assert.ok(result.nearby.ok && result.nearby.total > 0);
  // A proposal is a candidate, never reported as confirmed.
  for (const row of result.proposed) assert.ok(row.objectId);
});

test('cameras report FL511’s own video field, including “not stated”', () => {
  const view = makeView();
  const near = getNearbyCameras(view, [-80.1850, 25.7790], { radiusM: 1000 });
  assert.ok(near.ok);
  assert.equal(near.cameras[0].id, '468');
  assert.equal(near.cameras[0].videoEnabled, true);
  const all = getNearbyCameras(view, [-80.40, 25.60], { radiusM: 1000 });
  assert.equal(all.cameras[0].videoEnabled, null, 'a camera FL511 says nothing about stays null');
});

// ---- unavailable data ------------------------------------------------------------------------------

test('an unreachable feed is a gap, never “no closures”', () => {
  const view = makeView(trafficFrom(EVENTS_DOWN));
  const result = getLiveTrafficEvents(view, { types: ['CLOSURE'] });
  assert.equal(result.ok, false);
  assert.equal(result.gap, GAP.FEED_DOWN);
  const { response } = ask('Are there any road closures near PortMiami?', { view });
  assert.match(response.message, /cannot reach the live-traffic service/);
  assert.doesNotMatch(response.message, /No road closures were returned/);
  assert.equal(response.confidence, 'LOW');
});

test('an empty live feed says FL511 reported none, with the caveat attached', () => {
  const { response } = ask('Are there any road closures near PortMiami?', { view: makeView(trafficFrom(EVENTS_EMPTY)) });
  assert.match(response.message, /No road closures were returned by the latest available FL511 data/);
  assert.ok(response.warnings.some(w => /not a statement that conditions are normal/.test(w)));
});

test('a stale feed answers, and says the answer is not current', () => {
  const { response } = ask('Are there any road closures near PortMiami?', { view: makeView(trafficFrom(EVENTS_STALE)) });
  assert.match(response.message, /FL511 reports 1 road closure/);
  assert.match(response.message, /not responding|last data this app received|not the situation now/);
  assert.equal(response.confidence, 'LOW');
});

test('a spatial question about an asset with no location is answered as a gap', () => {
  // Seaboard Marine has no published address, so nothing can be measured from it.
  const { response } = ask('Show buildings near Seaboard Marine', { view: makeView() });
  assert.match(response.message, /no established position|could not|no position/i);
  assert.equal(response.actions.length, 0);
});

// ---- action validation ------------------------------------------------------------------------------

test('an action naming data that does not exist is dropped', () => {
  const view = makeView();
  assert.equal(validateAction(flyToAsset('terminal-a'), view).ok, true);
  assert.equal(validateAction(flyToAsset('terminal-zz'), view).ok, false);
  assert.equal(validateAction({ type: 'EVAL_JAVASCRIPT', code: 'alert(1)' }, view).ok, false);
});

test('a partly-valid id list keeps the real ids and drops the rest', () => {
  const view = makeView();
  const realRoad = segments[0].objectId;
  const result = validateActions([showRoads([realRoad, 99999999]), showCameras(['468', 'nope'])], view);
  assert.deepEqual(result.actions[0].objectIds, [realRoad]);
  assert.deepEqual(result.actions[1].cameraIds, ['468']);
});

test('every action an answer emits names data that is loaded', () => {
  const view = makeView();
  for (const suggestion of SUGGESTED_QUESTIONS) {
    const { response } = ask(suggestion.text, { view });
    for (const action of response.actions) {
      assert.equal(validateAction(action, view).ok, true,
        `${suggestion.text} emitted an unvalidatable ${action.type}`);
    }
  }
});

test('a building highlight is capped rather than emitting hundreds of ids', () => {
  const huge = showBuildings(buildings.slice(0, 400).map(b => b.objectId));
  assert.ok(huge.objectIds.length <= 25);
});

// ---- conversation context ---------------------------------------------------------------------------

test('a follow-up uses the subject of the previous answer', () => {
  const view = makeView();
  let memory = createSession();
  const first = answerQuestion({ question: 'Show me Cruise Terminal B.', context: emptyContext(), view, memory });
  memory = first.memory;
  assert.equal(memory.lastAssetId, 'terminal-b');

  const second = answerQuestion({ question: 'What cameras are near it?', context: emptyContext(), view, memory });
  assert.equal(second.response.intent, INTENT.NEARBY_CAMERAS);
  assert.match(second.response.message, /Terminal B/);
});

test('“show them on the map” acts on what the last answer returned, and nothing else', () => {
  const view = makeView();
  let memory = createSession();
  const first = answerQuestion({ question: 'Show cameras near Terminal A', context: emptyContext(), view, memory });
  memory = first.memory;
  const ids = first.response.data.cameras.map(c => c.id);

  const second = answerQuestion({ question: 'Show them on the map', context: emptyContext(), view, memory });
  assert.equal(second.response.intent, INTENT.SHOW_LAST);
  assert.equal(second.response.actions[0].type, ACTION.SHOW_CAMERAS);
  assert.deepEqual(second.response.actions[0].cameraIds, ids);
});

test('with nothing asked before, “show them” says so instead of showing something', () => {
  const { response } = ask('Show them on the map');
  assert.match(response.message, /nothing from a previous answer/i);
  assert.equal(response.actions.length, 0);
});

test('clearing the conversation forgets the subject', () => {
  const remembered = rememberAnswer(createSession(), {
    intent: INTENT.FIND_ASSET, subject: { kind: SUBJECT.ASSET, assetId: 'terminal-a', label: 'A' },
  });
  assert.equal(remembered.lastAssetId, 'terminal-a');
  assert.equal(createSession().lastAssetId, null);
});

// ---- answers ------------------------------------------------------------------------------------------

test('a found asset reports its position WITH the tier that produced it', () => {
  const { response } = ask('Show me Cruise Terminal A.');
  assert.equal(response.intent, INTENT.FIND_ASSET);
  assert.match(response.message, /Cruise Terminal A/);
  assert.match(response.message, /FRONTAGE|DERIVED|FOOTPRINT/);
  assert.ok(response.actions.some(a => a.type === ACTION.FLY_TO_ASSET));
  assert.ok(response.warnings.some(w => /not a surveyed location/.test(w)));
});

test('a confidence label never travels without its documented basis', () => {
  for (const suggestion of SUGGESTED_QUESTIONS) {
    const { response } = ask(suggestion.text);
    if (response.confidence) {
      assert.ok(response.confidenceBasis, `${suggestion.text} gave a label with no basis`);
      assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(response.confidence));
    }
  }
});

test('sources are attached by the tools, and name the data actually read', () => {
  const live = ask('Show cameras near Terminal A').response;
  assert.ok(live.sources.some(s => /FL511/.test(s.name)));
  assert.ok(live.sources.some(s => s.timestamp === CAMERA_LIVE.lastSuccessfulUpdate));

  const registry = ask('How many cruise terminals are registered?').response;
  assert.ok(registry.sources.some(s => /registry/i.test(s.name)));
  assert.ok(!registry.sources.some(s => /FL511/.test(s.name)), 'a registry answer cites no live feed');
});

test('proximity is never described as a confirmed access road', () => {
  const view = makeView();
  const context = buildTwinContext({
    selection: null, infra: { selected: assets.find(a => a.id === 'terminal-a'), linksFor: id => linksFor(index, id) },
    roads: { segments }, buildings: { buildings }, traffic: trafficFrom(EVENTS_LIVE),
    explorer: 'INFRA', viewer: null, buildingsById,
  });
  const { response } = ask('What roads are near this terminal?', { view, context });
  assert.match(response.message, /no reviewer-confirmed access road/);
  assert.match(response.message, /Proximity is not access/);
});

test('an unsupported question offers the capabilities instead of an answer', () => {
  const { response } = ask('What is the capital of France?');
  assert.equal(response.intent, INTENT.UNSUPPORTED);
  assert.equal(response.actions.length, 0);
  assert.match(response.message, /can’t answer that one/);
});

// ---- the optional model ---------------------------------------------------------------------------------

test('with no key configured the interpreter answers 503 and says the twin still works', async () => {
  const { status, body } = await interpretQuestion('is the port busy', { env: {} });
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  assert.match(body.reason, /supported questions are answered without one/);
});

test('a model reply outside the contract is rejected, not executed', () => {
  assert.equal(sanitizeInterpretation({ intent: 'DROP_TABLE' }).ok, false);
  assert.equal(sanitizeInterpretation({ intent: 'FIND_ASSET', name: 'Terminal A' }).ok, true);
  // Prose around the JSON is tolerated; anything that is not JSON at all is not.
  assert.equal(sanitizeInterpretation('Sure! {"intent":"CLOSURES"}').ok, true);
  assert.equal(sanitizeInterpretation('I think it is about closures.').ok, false);
  for (const intent of ALLOWED_INTENTS) assert.equal(sanitizeInterpretation({ intent }).ok, true);
});

test('a model-chosen intent still produces facts from the tools alone', async () => {
  // The model picks the intent; it supplies no count, no name resolution and no action.
  const stub = async () => JSON.stringify({ intent: 'ASSET_SUMMARY', category: 'PARKING' });
  const { status, body } = await interpretQuestion('what about the car parks', {
    env: { ANTHROPIC_API_KEY: 'test-key-not-a-real-credential' }, call: stub,
  });
  assert.equal(status, 200);
  assert.equal(body.intent, 'ASSET_SUMMARY');

  const { response } = ask('what about the car parks', { route: body });
  assert.equal(response.intent, INTENT.ASSET_SUMMARY);
  assert.match(response.message, /parking facilities in the registry/);
  // The number is the registry's, not the model's.
  assert.match(response.message, new RegExp(`^${assets.filter(a => a.category === 'PARKING').length} `));
});

test('a model that cannot be reached leaves the deterministic answer standing', async () => {
  const boom = async () => { throw new Error('network down'); };
  const { status, body } = await interpretQuestion('something odd', {
    env: { ANTHROPIC_API_KEY: 'test-key-not-a-real-credential' }, call: boom,
  });
  assert.equal(status, 502);
  assert.equal(body.ok, false);
});
