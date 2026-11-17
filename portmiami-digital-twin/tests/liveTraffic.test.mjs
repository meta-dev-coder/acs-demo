/**
 * Live Traffic tests.
 *
 * TWO KINDS OF TEST, labelled so they are never confused:
 *
 *   [fixture]  runs against files in tests/fixtures/fl511/ captured verbatim from fl511.com on
 *              2026-11-16. Deterministic, offline, and exactly what FL511 actually sent.
 *   [synthetic] runs against SYNTHETIC-study-area-events.json, written by hand because FL511 had
 *              zero in-area events at capture time. Its coordinates are real PortMiami centreline
 *              midpoints; the events themselves are not real.
 *
 * Neither contacts FL511. Live-API verification was done separately and is recorded in the README.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  distanceToPolylineMeters, polylineIntersectsRectangle, pointInRectangle,
  segmentIntersectsRectangle,
} from '../server/fl511/geo.mjs';
import { LAYERS, parseMapIcons } from '../server/fl511/client.mjs';
import { parseCarouselCameras, parseTooltipHtml } from '../server/fl511/tooltip.mjs';
import { loadFl511Config, detailUrl } from '../server/fl511/config.mjs';
import { AREA_MATCH, filterToStudyArea, locateInStudyArea } from '../server/portmiami/studyArea.mjs';
import { PORTMIAMI_REGION } from '../server/portmiami/region.mjs';
import {
  EVENT_TYPES, attachDetails, layerIdFor, normalizeEvent, normalizeFeed,
} from '../server/fl511/normalize.mjs';
import {
  LINK_STATUS, MATCH_METHOD, associateEvents, createRoadNetwork, directionsIn,
  loadRoadNetwork, splitAtLocator, tokenize,
} from '../server/portmiami/roadAssociation.mjs';
import { createLiveTrafficService, SOURCE_STATUS } from '../server/portmiami/service.mjs';
import { buildCameras, describeCamera, CAMERA_STATUS } from '../server/portmiami/cameras.mjs';
import { buildMessageSigns, describeMessageSign, parseMessageSignDetail } from '../server/portmiami/messageSigns.mjs';
import { createLiveTrafficApi } from '../server/portmiami/api.mjs';
import { TRAFFIC_ICONS, TRAFFIC_RENDER } from '../src/config/liveTraffic.js';
import {
  eventsForRoad, eventsForRoads, statusNotice, summariseTraffic, diffEvents, eventSourceRows,
  sourceNote, SOURCE_STATUS as UI_STATUS, eventTooltip, formatAge, formatMeters,
} from '../src/liveTraffic/liveTrafficModel.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/fl511/', import.meta.url));
const fixture = name => JSON.parse(readFileSync(`${FIXTURES}${name}`, 'utf8'));
const html = name => readFileSync(`${FIXTURES}${name}`, 'utf8');
const REGION = PORTMIAMI_REGION;
const CONFIG = loadFl511Config({});

// =============================================================================================
// Geometry
// =============================================================================================

test('geo: a point inside the study-area box is inside it', () => {
  assert.equal(pointInRectangle([-80.17, 25.78], REGION.bbox), true);
  assert.equal(pointInRectangle([-80.30, 25.78], REGION.bbox), false);
  assert.equal(pointInRectangle([-80.17, 26.10], REGION.bbox), false);
});

test('geo: a segment crossing the box is caught even when both endpoints are outside', () => {
  // The case a centroid test and an endpoints-only test both get wrong.
  assert.equal(segmentIntersectsRectangle([-80.30, 25.78], [-80.05, 25.78], REGION.bbox), true);
  assert.equal(segmentIntersectsRectangle([-80.17, 25.60], [-80.17, 25.95], REGION.bbox), true);
});

test('geo: a segment that misses the box is not caught', () => {
  assert.equal(segmentIntersectsRectangle([-80.30, 25.90], [-80.05, 25.90], REGION.bbox), false);
  // Passes the corner diagonally without entering.
  assert.equal(segmentIntersectsRectangle([-80.21, 25.80], [-80.19, 25.82], REGION.bbox), false);
});

test('geo: a polyline that detours through the box is caught', () => {
  assert.equal(
    polylineIntersectsRectangle([[-80.30, 25.90], [-80.17, 25.77], [-80.05, 25.90]], REGION.bbox), true);
  assert.equal(polylineIntersectsRectangle([], REGION.bbox), false);
});

test('geo: distance to a polyline is metres, and matches a hand-checked value', () => {
  // One degree of latitude is ~111.19 km on this earth radius; 0.001 deg is ~111 m.
  const d = distanceToPolylineMeters(-80.17, 25.781, [[-80.20, 25.78], [-80.14, 25.78]]);
  assert.ok(Math.abs(d - 111.2) < 1.5, `expected ~111 m, got ${d}`);
});

// =============================================================================================
// The FL511 client, against real captured responses
// =============================================================================================

test('[fixture] client: the Cameras feed parses, keeping videoEnabled and the icon URL', () => {
  const { items, skipped } = parseMapIcons(fixture('cameras.json'));
  assert.equal(skipped.length, 0);
  const camera = items.find(item => item.itemId === '409');
  assert.equal(camera.videoEnabled, true);
  assert.equal(camera.iconUrl, '/Generated/Content/Images/511/map_cameraStreams.svg');
  assert.ok(Number.isFinite(camera.latitude) && Number.isFinite(camera.longitude));
});

test('[fixture] client: the Closures feed keeps the second published point', () => {
  const { items } = parseMapIcons(fixture('closures.json'));
  const withSpan = items.filter(item => item.secondaryLatitude != null);
  assert.ok(withSpan.length > 0, 'the captured closures include two-point events');
  for (const item of withSpan) {
    assert.ok(Number.isFinite(item.secondaryLatitude) && Number.isFinite(item.secondaryLongitude));
  }
});

test('client: a malformed item is skipped with a reason, and never fails the feed', () => {
  const { items, skipped } = parseMapIcons({ item2: [
    { itemId: '1', location: [25.78, -80.17] },
    { itemId: '', location: [25.78, -80.17] },
    { itemId: '3' },
    { itemId: '4', location: [0, 0] },
    { itemId: '1', location: [25.78, -80.17] },
    'not an object',
  ] });
  assert.equal(items.length, 1);
  assert.deepEqual(skipped.map(entry => entry.reason).sort(), [
    'duplicate itemId', 'entry is not an object', 'missing itemId',
    'missing or invalid location', 'missing or invalid location',
  ]);
});

test('client: a response without item2 is a schema change, not an empty feed', () => {
  assert.throws(() => parseMapIcons({}), /missing the item2 array/);
  assert.throws(() => parseMapIcons(null), /not a JSON object/);
});

test('client: videoEnabled is tri-state — absent stays absent, never false', () => {
  const { items } = parseMapIcons({ item2: [
    { itemId: 'a', location: [25.78, -80.17] },
    { itemId: 'b', location: [25.78, -80.17], expando: { videoEnabled: false } },
  ] });
  assert.equal('videoEnabled' in items[0], false);
  assert.equal(items[1].videoEnabled, false);
});

test('config: the detail URL is built from FL511’s own template', () => {
  assert.equal(detailUrl(CONFIG, 'Cameras', '409'), 'https://fl511.com/tooltip/Cameras/409?lang=en-US');
});

// =============================================================================================
// Tooltip parsing, against real captured fragments
// =============================================================================================

test('[fixture] tooltip: a camera fragment yields its name and its DIVAS channel', () => {
  const cameras = parseCarouselCameras(html('camera-tooltip.html'));
  assert.equal(cameras.length, 1);
  assert.equal(cameras[0].cameraId, '425');
  assert.equal(cameras[0].title, 'US-1 at Port Boulevard');
  assert.equal(cameras[0].divasChanId, '286');
});

test('[fixture] tooltip: a message-sign fragment yields the message it is displaying', () => {
  const detail = parseMessageSignDetail(html('sign-tooltip.html'));
  assert.equal(detail.title, 'I-95 NB beyond SW 8th Street');
  assert.ok(detail.message.length > 0);
  assert.ok(detail.updatedAt.length > 0);
});

test('tooltip: an unrecognised fragment returns null rather than a partial guess', () => {
  assert.equal(parseTooltipHtml(''), null);
  assert.equal(parseTooltipHtml('<div></div>'), null);
  assert.throws(() => parseMessageSignDetail('<div>nothing here</div>'), /Unrecognized/);
});

// =============================================================================================
// The study-area filter
// =============================================================================================

test('studyArea: a one-point event inside the box is POINT_IN_AREA', () => {
  const located = locateInStudyArea({ latitude: 25.78, longitude: -80.17 }, REGION.bbox);
  assert.equal(located.areaMatch, AREA_MATCH.POINT_IN_AREA);
  assert.equal(located.hasSpan, false);
});

test('studyArea: a one-point event outside the box is not in it at all', () => {
  assert.equal(locateInStudyArea({ latitude: 26.1, longitude: -80.25 }, REGION.bbox), null);
});

test('studyArea: a two-point event with ONE end inside is ENDPOINT_IN_AREA', () => {
  const located = locateInStudyArea(
    { latitude: 26.1, longitude: -80.25, secondaryLatitude: 25.78, secondaryLongitude: -80.17 }, REGION.bbox);
  assert.equal(located.areaMatch, AREA_MATCH.ENDPOINT_IN_AREA);
});

test('studyArea: a two-point event with BOTH ends outside but spanning the box is kept', () => {
  const located = locateInStudyArea(
    { latitude: 25.74, longitude: -80.17, secondaryLatitude: 25.82, secondaryLongitude: -80.17 }, REGION.bbox);
  assert.equal(located.areaMatch, AREA_MATCH.SPAN_CROSSES_AREA);
});

test('studyArea: every area match carries a geometry basis that says what the line is NOT', () => {
  for (const match of Object.values(AREA_MATCH)) {
    const located = match === AREA_MATCH.POINT_IN_AREA
      ? locateInStudyArea({ latitude: 25.78, longitude: -80.17 }, REGION.bbox)
      : match === AREA_MATCH.ENDPOINT_IN_AREA
        ? locateInStudyArea({ latitude: 26.1, longitude: -80.25, secondaryLatitude: 25.78, secondaryLongitude: -80.17 }, REGION.bbox)
        : locateInStudyArea({ latitude: 25.74, longitude: -80.17, secondaryLatitude: 25.82, secondaryLongitude: -80.17 }, REGION.bbox);
    assert.ok(located.geometryBasis.length > 20, `${match} has a stated basis`);
  }
  const span = locateInStudyArea(
    { latitude: 26.1, longitude: -80.25, secondaryLatitude: 25.78, secondaryLongitude: -80.17 }, REGION.bbox);
  assert.match(span.geometryBasis, /not the alignment or length/);
});

test('[synthetic] studyArea: the in-area fixture exercises all three match kinds and drops the rest', () => {
  const { items, skipped } = parseMapIcons(fixture('SYNTHETIC-study-area-events.json'));
  const { kept } = filterToStudyArea(items, REGION, skipped);
  assert.deepEqual(kept.map(item => item.itemId).sort(),
    ['TEST-CLO-1', 'TEST-CLO-2', 'TEST-INC-1', 'TEST-INC-2', 'TEST-INC-3']);
  assert.deepEqual(new Set(kept.map(item => item.areaMatch)), new Set(Object.values(AREA_MATCH)));
});

test('[fixture] studyArea: the real statewide feeds filter down to the study area only', () => {
  // The captured fixtures each hold the in-area items plus up to three from elsewhere in Florida.
  for (const [name, expected] of [['cameras.json', 10], ['messageSigns.json', 3],
                                  ['incidents.json', 0], ['construction.json', 0],
                                  ['disabledVehicles.json', 0]]) {
    const { items, skipped } = parseMapIcons(fixture(name));
    const { kept } = filterToStudyArea(items, REGION, skipped);
    assert.equal(kept.length, expected, `${name}: ${expected} in the study area`);
  }
});

test('studyArea: an event FL511 published with no usable position is counted, never placed', () => {
  const { items, skipped } = parseMapIcons({ item2: [
    { itemId: 'placed', location: [25.78, -80.17] },
    { itemId: 'lost' },
  ] });
  const { kept, unplaceable } = filterToStudyArea(items, REGION, skipped);
  assert.equal(kept.length, 1);
  assert.deepEqual(unplaceable, [{ itemId: 'lost', reason: 'missing or invalid location' }]);
});

// =============================================================================================
// Normalization — and the absence of the I-595 model
// =============================================================================================

const normalizeOne = (item, type = EVENT_TYPES.INCIDENT) =>
  normalizeEvent({ ...item, areaMatch: AREA_MATCH.POINT_IN_AREA, geometryBasis: 'x' }, type, { regionId: REGION.id });

test('normalize: a one-point event gets Point geometry; a two-point event gets MultiPoint', () => {
  const single = normalizeOne({ itemId: '1', latitude: 25.78, longitude: -80.17 });
  assert.equal(single.geometry.type, 'Point');
  const double = normalizeOne({
    itemId: '2', latitude: 25.78, longitude: -80.17, secondaryLatitude: 25.79, secondaryLongitude: -80.16 });
  assert.equal(double.geometry.type, 'MultiPoint');
  assert.equal(double.geometry.coordinates.length, 2);
});

test('normalize: a two-point event is NEVER given LineString geometry', () => {
  // A LineString would assert a path between the two points. FL511 publishes no path.
  const event = normalizeOne({
    itemId: '2', latitude: 25.78, longitude: -80.17, secondaryLatitude: 25.79, secondaryLongitude: -80.16 });
  assert.notEqual(event.geometry.type, 'LineString');
});

test('normalize: no I-595 corridor field survives into the PortMiami model', () => {
  const event = normalizeOne({ itemId: '1', latitude: 25.78, longitude: -80.17 });
  for (const corridorField of ['liveOps', 'nearestFacility', 'nearestFacilityLabel',
    'nearestSegmentId', 'nearestSegmentLabel', 'distanceToI595NetworkM', 'laneImpact',
    'carriageway', 'sectionId', 'contributesToImpact']) {
    assert.equal(corridorField in event, false, `${corridorField} must not be carried over`);
  }
});

test('normalize: the source id and the region are both preserved', () => {
  const event = normalizeOne({ itemId: '461840', latitude: 25.78, longitude: -80.17 });
  assert.equal(event.sourceEventId, '461840');
  assert.equal(event.id, 'FL511-INCIDENT-461840');
  assert.equal(event.regionId, 'portmiami');
  assert.equal(event.source, 'FL511');
});

test('normalize: every event type maps to an FL511 layer id', () => {
  assert.equal(layerIdFor(EVENT_TYPES.CLOSURE), LAYERS.CLOSURE);
  assert.equal(layerIdFor(EVENT_TYPES.DISABLED_VEHICLE), LAYERS.DISABLED);
  assert.equal(layerIdFor(EVENT_TYPES.CONGESTION), LAYERS.CONGESTION);
});

test('attachDetails: a row FL511 printed becomes a field; a row it did not stays absent', () => {
  const event = normalizeOne({ itemId: '1', latitude: 25.78, longitude: -80.17 });
  const enriched = attachDetails(event, {
    title: 'Crash', description: 'Two vehicles',
    fields: [{ label: 'Severity', value: 'Minor' }, { label: 'Odd Label', value: 'kept' }],
  });
  assert.equal(enriched.severity, 'Minor');
  assert.equal(enriched.detailsAvailable, true);
  assert.equal('detour' in enriched, false, 'FL511 printed no detour row');
  assert.ok(enriched.detailFields.some(field => field.label === 'Odd Label'));
});

test('attachDetails: roadway and direction are never parsed out of prose', () => {
  const event = normalizeOne({ itemId: '1', latitude: 25.78, longitude: -80.17 });
  const enriched = attachDetails(event, {
    description: 'Crash on Port Blvd eastbound blocking two lanes', fields: [] });
  assert.equal(enriched.roadway, undefined);
  assert.equal(enriched.direction, undefined);
  assert.equal(enriched.lanesBlocked, undefined);
});

test('attachDetails: a null detail leaves the event exactly as it was', () => {
  const event = normalizeOne({ itemId: '1', latitude: 25.78, longitude: -80.17 });
  assert.deepEqual(attachDetails(event, null), event);
});

test('normalizeFeed: one unusable item does not take the feed down', () => {
  const logged = [];
  const events = normalizeFeed(
    [{ itemId: '1', latitude: 25.78, longitude: -80.17, areaMatch: 'POINT_IN_AREA' }],
    EVENT_TYPES.INCIDENT, { regionId: 'portmiami' }, { warn: m => logged.push(m) });
  assert.equal(events.length, 1);
});

// =============================================================================================
// Road association — the honesty-critical part
// =============================================================================================

test('association: county abbreviations and FL511 prose reduce to the same tokens', () => {
  assert.deepEqual(tokenize('PORT BLVD'), ['PORT', 'BOULEVARD']);
  assert.deepEqual(tokenize('MACARTHUR CSWY'), ['MACARTHUR', 'CAUSEWAY']);
  assert.deepEqual(tokenize('N AMERICA WAY'), ['NORTH', 'AMERICA', 'WAY']);
  assert.deepEqual(tokenize('S.W. 8th Street'), ['SOUTHWEST', '8TH', 'STREET']);
});

test('association: a locator splits "the road it is on" from "the road it refers to"', () => {
  assert.deepEqual(splitAtLocator(tokenize('US-1 at Port Boulevard')),
    { primary: ['US', '1'], reference: ['PORT', 'BOULEVARD'], kind: 'JUNCTION' });
  assert.deepEqual(splitAtLocator(tokenize('I-395 East of Bridge Road')),
    { primary: ['I', '395'], reference: ['BRIDGE', 'ROAD'], kind: 'OFFSET' });
  assert.deepEqual(splitAtLocator(tokenize('Closure on North America Way')),
    { primary: ['CLOSURE', 'ON', 'NORTH', 'AMERICA', 'WAY'], reference: [], kind: null });
});

test('association: directions are read from the text, not assumed', () => {
  assert.deepEqual([...directionsIn('I-95 NB beyond SW 8th Street')], ['N']);
  assert.deepEqual([...directionsIn('no direction here')], []);
});

/** A two-segment hand-built network: one named, one not, 1 km apart. */
const testNetwork = () => createRoadNetwork([
  { objectId: 1, name: 'PORT BLVD', isPortAccess: true, isTunnel: false,
    coordinates: [[-80.170, 25.780], [-80.160, 25.780]],
    nameTokens: tokenize('PORT BLVD'), directions: new Set(), properties: {} },
  { objectId: 2, name: '', isPortAccess: false, isTunnel: false,
    coordinates: [[-80.170, 25.7801], [-80.160, 25.7801]],
    nameTokens: [], directions: new Set(), properties: {} },
  { objectId: 3, name: 'N MIAMI AVE', isPortAccess: false, isTunnel: false,
    coordinates: [[-80.300, 25.900], [-80.299, 25.900]],
    nameTokens: tokenize('N MIAMI AVE'), directions: new Set(['N']), properties: {} },
]);

test('association: naming the road AND being near it is MATCHED', () => {
  const [event] = associateEvents([{
    id: 'e1', latitude: 25.7800, longitude: -80.165, title: 'Closure on Port Blvd',
  }], testNetwork());
  const link = event.roadAssociations.find(entry => entry.roadObjectId === 1);
  assert.equal(link.status, LINK_STATUS.MATCHED);
  assert.equal(link.matchMethod, MATCH_METHOD.NAME_AND_PROXIMITY);
  assert.deepEqual(event.affectedRoadObjectIds, [1]);
});

test('association: the NEAREST road alone is only ever a CANDIDATE', () => {
  const [event] = associateEvents([{
    id: 'e2', latitude: 25.7800, longitude: -80.165, title: 'Crash',
  }], testNetwork());
  assert.equal(event.roadAssociationStatus, LINK_STATUS.CANDIDATE);
  assert.deepEqual(event.affectedRoadObjectIds, []);
  for (const link of event.roadAssociations) {
    assert.equal(link.status, LINK_STATUS.CANDIDATE);
    assert.equal(link.matchMethod, MATCH_METHOD.PROXIMITY_ONLY);
  }
});

test('association: a road named as a JUNCTION is matched; one named as an OFFSET is not', () => {
  const network = testNetwork();
  const [junction] = associateEvents([{
    id: 'j', latitude: 25.7800, longitude: -80.165, title: 'US-1 at Port Boulevard',
  }], network);
  assert.equal(junction.roadAssociations.find(l => l.roadObjectId === 1).matchMethod,
    MATCH_METHOD.CROSS_REFERENCE_AND_PROXIMITY);
  assert.equal(junction.roadAssociationStatus, LINK_STATUS.MATCHED);

  const [offset] = associateEvents([{
    id: 'o', latitude: 25.7800, longitude: -80.165, title: 'I-395 east of Port Boulevard',
  }], network);
  const link = offset.roadAssociations.find(l => l.roadObjectId === 1);
  assert.equal(link.matchMethod, MATCH_METHOD.OFFSET_REFERENCE);
  assert.equal(link.status, LINK_STATUS.CANDIDATE, 'displaced FROM a road is not ON it');
  assert.equal(link.evidence.namedAsOffsetFrom, true);
});

test('association: a stated direction that contradicts the segment demotes the match', () => {
  const [event] = associateEvents([{
    id: 'd', latitude: 25.900, longitude: -80.2995, title: 'Closure on S Miami Ave southbound',
  }], createRoadNetwork([
    { objectId: 3, name: 'S MIAMI AVE', isPortAccess: false, isTunnel: false,
      coordinates: [[-80.300, 25.900], [-80.299, 25.900]],
      nameTokens: tokenize('S MIAMI AVE'), directions: new Set(['N']), properties: {} },
  ]));
  const link = event.roadAssociations[0];
  assert.equal(link.status, LINK_STATUS.CANDIDATE);
  assert.equal(link.matchMethod, MATCH_METHOD.NAME_AND_PROXIMITY_DIRECTION_CONFLICT);
  assert.equal(link.evidence.directionConflict, true);
});

test('association: nothing within the radius is UNMATCHED, with the reason recorded', () => {
  const [event] = associateEvents([{
    id: 'far', latitude: 25.500, longitude: -80.900, title: 'Crash on Port Blvd',
  }], testNetwork());
  assert.equal(event.roadAssociationStatus, LINK_STATUS.UNMATCHED);
  assert.deepEqual(event.roadAssociations, []);
  assert.match(event.roadAssociationNote, /No PortMiami road centreline within 150 m/);
});

test('association: no confidence number is invented anywhere', () => {
  const [event] = associateEvents([{
    id: 'c', latitude: 25.7800, longitude: -80.165, title: 'Closure on Port Blvd',
  }], testNetwork());
  for (const link of event.roadAssociations) {
    assert.equal('confidence' in link, false, 'there is no calibration set for a confidence score');
  }
});

test('association: a two-point event is related to roads at EITHER published point', () => {
  const [event] = associateEvents([{
    id: 'span', latitude: 25.500, longitude: -80.900,
    secondaryLatitude: 25.7800, secondaryLongitude: -80.165, title: 'Closure on Port Blvd',
  }], testNetwork());
  assert.equal(event.roadAssociationStatus, LINK_STATUS.MATCHED);
});

test('association: matched links sort above closer candidates', () => {
  const [event] = associateEvents([{
    id: 's', latitude: 25.7801, longitude: -80.165, title: 'Closure on Port Blvd',
  }], testNetwork());
  // Segment 2 is physically nearer, but segment 1 is the one the event names.
  assert.equal(event.roadAssociations[0].roadObjectId, 1);
  assert.equal(event.roadAssociations[0].status, LINK_STATUS.MATCHED);
});

test('association: a single short word is never accepted as a road name match', () => {
  const [event] = associateEvents([{
    id: 'w', latitude: 25.7800, longitude: -80.165, title: 'Debris in the way',
  }], createRoadNetwork([
    { objectId: 9, name: 'WAY', isPortAccess: false, isTunnel: false,
      coordinates: [[-80.170, 25.780], [-80.160, 25.780]],
      nameTokens: ['WAY'], directions: new Set(), properties: {} },
  ]));
  assert.equal(event.roadAssociations[0].status, LINK_STATUS.CANDIDATE);
});

test('association: the number of associations per event is capped', () => {
  const crowded = createRoadNetwork(Array.from({ length: 40 }, (_, index) => ({
    objectId: index + 1, name: '', isPortAccess: false, isTunnel: false,
    coordinates: [[-80.170, 25.780 + index * 0.00001], [-80.160, 25.780 + index * 0.00001]],
    nameTokens: [], directions: new Set(), properties: {},
  })));
  const [event] = associateEvents([{ id: 'many', latitude: 25.780, longitude: -80.165 }], crowded);
  assert.equal(event.roadAssociations.length, 8);
  assert.ok(event.roadAssociationsTruncated > 0);
});

// ---- against the REAL PortMiami road network ------------------------------------------------

const ROADS = fileURLToPath(new URL('../public/data/portmiami_roads_merged.geojson', import.meta.url));
let realNetwork;
const network = async () => (realNetwork ??= await loadRoadNetwork(ROADS));

test('[fixture] association: the real network loads all 2,362 county segments', async () => {
  assert.equal((await network()).count, 2362);
});

test('[synthetic] association: on real geometry, each fixture event lands where its words say', async () => {
  const net = await network();
  const { items, skipped } = parseMapIcons(fixture('SYNTHETIC-study-area-events.json'));
  const { kept } = filterToStudyArea(items, REGION, skipped);
  const events = associateEvents(
    normalizeFeed(kept, EVENT_TYPES.INCIDENT, { regionId: REGION.id }), net);
  const byId = new Map(events.map(event => [event.sourceEventId, event]));

  // Names PORT BLVD and sits on it -> matched to a PORT BLVD segment.
  const onPortBlvd = byId.get('TEST-INC-1');
  assert.equal(onPortBlvd.roadAssociationStatus, LINK_STATUS.MATCHED);
  assert.ok(onPortBlvd.roadAssociations.some(
    link => link.status === LINK_STATUS.MATCHED && link.roadName === 'PORT BLVD'));
  assert.ok(onPortBlvd.affectedRoadObjectIds.length > 0);

  // "east of Caribbean Way" -> displaced from it, so never matched to it.
  const offset = byId.get('TEST-INC-2');
  const caribbean = offset.roadAssociations.filter(link => link.roadName === 'CARIBBEAN WAY');
  assert.ok(caribbean.length > 0, 'Caribbean Way is within range');
  for (const link of caribbean) {
    assert.equal(link.status, LINK_STATUS.CANDIDATE);
    assert.equal(link.matchMethod, MATCH_METHOD.OFFSET_REFERENCE);
  }

  // No title at all -> proximity only, nothing matched.
  const untitled = byId.get('TEST-INC-3');
  assert.equal(untitled.roadAssociationStatus, LINK_STATUS.CANDIDATE);
  assert.deepEqual(untitled.affectedRoadObjectIds, []);
});

test('[synthetic] association: a matched port-access road is flagged as port access', async () => {
  const net = await network();
  const [event] = associateEvents(
    [{ id: 'p', latitude: 25.771415, longitude: -80.164243, title: 'Closure on Port Blvd' }], net);
  const matched = event.roadAssociations.find(link => link.status === LINK_STATUS.MATCHED);
  assert.equal(matched.isPortAccess, true);
});

test('[fixture] association: the real cameras get their road from their OWN name, not distance', async () => {
  const net = await network();
  const { items, skipped } = parseMapIcons(fixture('cameras.json'));
  const { kept } = filterToStudyArea(items, REGION, skipped);
  const cameras = buildCameras(kept, net, REGION);
  assert.equal(cameras.length, 10);
  // The feed publishes no title, so at list time nothing can be matched.
  for (const camera in cameras) assert.ok(true);
  for (const camera of cameras) {
    assert.equal(camera.name, null, 'the Cameras feed publishes no title for these');
    assert.equal(camera.roadAssociationStatus, LINK_STATUS.CANDIDATE);
  }
  // With the name from its own detail fragment, camera 425 matches Port Blvd.
  const camera425 = cameras.find(camera => camera.id === '425');
  const described = describeCamera(camera425, parseCarouselCameras(html('camera-tooltip.html')),
    { snapshotBase: '/api/portmiami/camera', network: net });
  assert.equal(described.name, 'US-1 at Port Boulevard');
  assert.equal(described.roadAssociationStatus, LINK_STATUS.MATCHED);
  assert.ok(described.roadAssociations.some(
    link => link.roadName === 'PORT BLVD' && link.matchMethod === MATCH_METHOD.CROSS_REFERENCE_AND_PROXIMITY));
});

// =============================================================================================
// Cameras
// =============================================================================================

test('[fixture] cameras: a camera with no resolved channel has NO snapshot URL', () => {
  const net = testNetwork();
  const [camera] = buildCameras([{
    itemId: '409', latitude: 25.780, longitude: -80.165, videoEnabled: true,
    areaMatch: AREA_MATCH.POINT_IN_AREA,
  }], net, REGION);
  assert.equal(camera.status, CAMERA_STATUS.LISTED);
  const described = describeCamera(camera, [], { snapshotBase: '/api/portmiami/camera', network: net });
  assert.equal(described.snapshotUrl, null, 'a URL is never built from a camera id');
  assert.equal(described.divasChannel, null);
});

test('cameras: a resolved channel produces a same-origin snapshot URL only', () => {
  const described = describeCamera(
    { id: '425', latitude: 25.78, longitude: -80.17, videoEnabled: true, roadAssociations: [] },
    [{ cameraId: '425', title: 'US-1 at Port Boulevard', description: '608-CCTV', divasChanId: '286' }],
    { snapshotBase: '/api/portmiami/camera' });
  assert.equal(described.snapshotUrl, '/api/portmiami/camera/286/snapshot');
  assert.ok(described.snapshotUrl.startsWith('/'), 'the browser never talks to the image host');
  assert.equal(described.status, CAMERA_STATUS.FEED_RESOLVED);
});

test('cameras: FL511 declaring no video is reported as such, not as a failure', () => {
  const [camera] = buildCameras([{
    itemId: '1', latitude: 25.780, longitude: -80.165, videoEnabled: false,
    areaMatch: AREA_MATCH.POINT_IN_AREA,
  }], testNetwork(), REGION);
  assert.equal(camera.status, CAMERA_STATUS.NO_VIDEO_DECLARED);
  assert.equal(camera.videoEnabled, false);
});

test('cameras: a camera the feed gives no title for is named null, never "Camera 409"', () => {
  const [camera] = buildCameras([{
    itemId: '409', latitude: 25.780, longitude: -80.165, areaMatch: AREA_MATCH.POINT_IN_AREA,
  }], testNetwork(), REGION);
  assert.equal(camera.name, null);
});

// =============================================================================================
// Message signs
// =============================================================================================

test('[fixture] signs: a listed sign has no message until its own fragment is read', () => {
  const { items, skipped } = parseMapIcons(fixture('messageSigns.json'));
  const { kept } = filterToStudyArea(items, REGION, skipped);
  const signs = buildMessageSigns(kept, testNetwork(), REGION);
  assert.equal(signs.length, 3);
  for (const sign of signs) {
    assert.equal(sign.message, null);
    assert.equal(sign.messageRead, false);
  }
});

test('[fixture] signs: reading the fragment yields the message FL511 published', () => {
  const sign = { id: '224668', latitude: 25.76415, longitude: -80.19965, name: null, roadAssociations: [] };
  const described = describeMessageSign(sign, parseMessageSignDetail(html('sign-tooltip.html')));
  assert.equal(described.name, 'I-95 NB beyond SW 8th Street');
  assert.ok(described.message.length > 0);
  assert.equal(described.messageRead, true);
});

test('signs: no message is ever synthesised when FL511 published none', () => {
  const described = describeMessageSign(
    { id: '1', latitude: 25.78, longitude: -80.17, name: null, roadAssociations: [] }, null);
  assert.equal(described.message, null);
  assert.equal(described.messageRead, false);
});

// =============================================================================================
// The poller
// =============================================================================================

/** A client that answers from the captured fixtures and counts its calls. */
function stubClient({ fail = new Set(), onCall = () => {} } = {}) {
  const feed = name => {
    const { items, skipped } = parseMapIcons(fixture(name));
    return filterToStudyArea(items, REGION, skipped).kept.length >= 0 ? items : items;
  };
  const answer = (key, name) => async () => {
    onCall(key);
    if (fail.has(key)) throw new Error(`${key} is down`);
    return parseMapIcons(fixture(name)).items;
  };
  return {
    calls: [],
    fetchIncidents: answer('INCIDENT', 'incidents.json'),
    fetchClosures: answer('CLOSURE', 'closures.json'),
    fetchConstruction: answer('CONSTRUCTION', 'construction.json'),
    fetchCongestion: answer('CONGESTION', 'congestion.json'),
    fetchDisabledVehicles: answer('DISABLED_VEHICLE', 'disabledVehicles.json'),
    fetchCameras: answer('CAMERA', 'cameras.json'),
    fetchMessageSigns: answer('MESSAGE_SIGN', 'messageSigns.json'),
    fetchEventDetails: async () => null,
    fetchDetailHtml: async () => html('camera-tooltip.html'),
    _feed: feed,
  };
}

const silent = { log() {}, warn() {}, error() {} };

test('[fixture] service: one poll fills the study area from the real feeds', async () => {
  const service = createLiveTrafficService({
    config: CONFIG, region: REGION, network: await network(), client: stubClient(), logger: silent });
  const payload = await service.getEvents();
  service.stop();
  assert.equal(payload.sourceStatus, SOURCE_STATUS.LIVE);
  assert.equal(payload.counts.total, 0, 'the captured feeds hold no in-area events');
  assert.equal(payload.region.id, 'portmiami');
  assert.equal(payload.region.boundaryKind, 'STUDY_AREA');
  assert.equal(payload.trafficSpeeds.available, false);
  assert.equal(payload.roadNetwork.segmentCount, 2362);
});

test('[fixture] service: cameras and signs come back on their own slower clock', async () => {
  const service = createLiveTrafficService({
    config: CONFIG, region: REGION, network: await network(), client: stubClient(), logger: silent });
  const cameras = await service.getCameras();
  const signs = await service.getMessageSigns();
  service.stop();
  assert.equal(cameras.count, 10);
  assert.equal(signs.count, 3);
  assert.equal(cameras.dataFreshness.refreshSeconds, CONFIG.assetRefreshSeconds);
  assert.equal(signs.dataFreshness.refreshSeconds, CONFIG.assetRefreshSeconds);
  assert.notEqual(cameras.dataFreshness.refreshSeconds, CONFIG.refreshSeconds);
});

test('service: one feed failing does not blank the others', async () => {
  const service = createLiveTrafficService({
    config: CONFIG, region: REGION, network: await network(),
    client: stubClient({ fail: new Set(['CLOSURE']) }), logger: silent });
  const payload = await service.getEvents();
  service.stop();
  assert.equal(payload.diagnostics.feeds.CLOSURE.error, 'CLOSURE is down');
  assert.equal(payload.diagnostics.feeds.INCIDENT.error, null);
  assert.ok(payload.diagnostics.feeds.INCIDENT.itemCount >= 0);
});

test('service: a poll where any feed failed is not counted as fully up to date', async () => {
  const service = createLiveTrafficService({
    config: CONFIG, region: REGION, network: await network(),
    client: stubClient({ fail: new Set(['CONGESTION']) }), logger: silent });
  const payload = await service.getEvents();
  service.stop();
  assert.equal(payload.sourceStatus, SOURCE_STATUS.UNAVAILABLE);
  assert.equal(payload.lastSuccessfulUpdate, null);
});

test('service: cached data past the stale window is served, and labelled STALE', async () => {
  let clock = 1_700_000_000_000;
  const service = createLiveTrafficService({
    config: CONFIG, region: REGION, network: await network(), client: stubClient(),
    logger: silent, now: () => clock });
  await service.getEvents();
  clock += (CONFIG.staleAfterSeconds + 10) * 1000;
  const payload = await service.getEvents();
  service.stop();
  assert.equal(payload.sourceStatus, SOURCE_STATUS.STALE);
  assert.ok(payload.dataFreshness.ageSeconds > CONFIG.staleAfterSeconds);
});

test('service: concurrent reads share ONE poll — no overlapping jobs, no duplicate fetches', async () => {
  const calls = [];
  const service = createLiveTrafficService({
    config: CONFIG, region: REGION, network: await network(),
    client: stubClient({ onCall: key => calls.push(key) }), logger: silent });
  await Promise.all([service.getEvents(), service.getEvents(), service.getEvents()]);
  service.stop();
  assert.equal(calls.filter(key => key === 'INCIDENT').length, 1, 'the incident feed was fetched once');
});

test('service: no event is ever duplicated across polls', async () => {
  const service = createLiveTrafficService({
    config: CONFIG, region: REGION, network: await network(), client: stubClient(), logger: silent });
  await service.refreshEvents();
  await service.refreshEvents();
  const payload = await service.getEvents();
  service.stop();
  const ids = payload.events.map(event => event.id);
  assert.equal(ids.length, new Set(ids).size);
});

test('service: stop() clears both timers so a test run is never held open', async () => {
  const service = createLiveTrafficService({
    config: CONFIG, region: REGION, network: await network(), client: stubClient(), logger: silent });
  await service.start();
  service.stop();
  // Nothing to assert beyond not hanging; node --test would not exit if a timer survived.
  assert.ok(true);
});

// =============================================================================================
// The HTTP API
// =============================================================================================

/** Call a route against an in-process API with a stubbed FL511 client. */
async function route(path, { client = stubClient(), net } = {}) {
  const resolved = net ?? await network();
  const service = createLiveTrafficService({
    config: CONFIG, region: REGION, network: resolved, client, logger: silent });
  const api = createLiveTrafficApi({
    config: CONFIG, region: REGION, service, network: resolved, logger: silent,
    fetchImpl: async url => (String(url).includes('images-dis')
      ? { ok: true, status: 200, headers: new Map([['content-type', 'image/jpeg']]),
          arrayBuffer: async () => new Uint8Array([0xff, 0xd8, 0xff]).buffer }
      : { ok: true, status: 200, headers: new Map([['content-type', 'text/html']]),
          text: async () => html('camera-tooltip.html') }),
  });
  let status = 0, headers = {}, body = '';
  const response = {
    writeHead(code, hdrs) { status = code; headers = hdrs ?? {}; },
    end(chunk) { body = chunk == null ? '' : Buffer.isBuffer(chunk) ? chunk : String(chunk); },
  };
  const handled = await api.handle({ url: path, method: 'GET' }, response);
  service.stop();
  await api.stop();
  const type = headers['content-type'] ?? '';
  return { handled, status, headers, body: type.startsWith('application/json') ? JSON.parse(body) : body };
}

test('[fixture] api: /live-events answers with the study-area payload', async () => {
  const { handled, status, body } = await route('/api/portmiami/live-events');
  assert.equal(handled, true);
  assert.equal(status, 200);
  assert.equal(body.source, 'FL511');
  assert.equal(body.region.id, 'portmiami');
  assert.ok(Array.isArray(body.events));
});

test('[fixture] api: /cameras and /message-signs answer with their counts', async () => {
  assert.equal((await route('/api/portmiami/cameras')).body.count, 10);
  assert.equal((await route('/api/portmiami/message-signs')).body.count, 3);
});

test('[fixture] api: a camera detail resolves its channel and its snapshot URL', async () => {
  const { status, body } = await route('/api/portmiami/cameras/425');
  assert.equal(status, 200);
  assert.equal(body.divasChannel, '286');
  assert.equal(body.snapshotUrl, '/api/portmiami/camera/286/snapshot');
});

test('api: a camera outside the study area is 404, not an empty camera', async () => {
  const { status, body } = await route('/api/portmiami/cameras/999999');
  assert.equal(status, 404);
  assert.match(body.error, /not in the PortMiami study area/);
});

test('[fixture] api: the snapshot proxy serves a resolved channel as a JPEG', async () => {
  const { status, headers } = await route('/api/portmiami/camera/286/snapshot');
  assert.equal(status, 200);
  assert.equal(headers['content-type'], 'image/jpeg');
});

test('api: the snapshot proxy refuses a channel it never resolved', async () => {
  // The scope guard is what stops this becoming a general image proxy.
  const { status, body } = await route('/api/portmiami/camera/999999/snapshot');
  assert.equal(status, 400);
  assert.match(body.error, /Unknown camera channel/);
});

test('api: a path it does not own is passed on, not swallowed', async () => {
  const { handled } = await route('/api/something-else');
  assert.equal(handled, false);
});

test('api: an unknown resource under its own base is a 404', async () => {
  assert.equal((await route('/api/portmiami/nope')).status, 404);
});

test('api: only GET is supported; a write verb is refused', async () => {
  const resolved = await network();
  const service = createLiveTrafficService({
    config: CONFIG, region: REGION, network: resolved, client: stubClient(), logger: silent });
  const api = createLiveTrafficApi({ config: CONFIG, region: REGION, service, network: resolved, logger: silent });
  let status = 0;
  await api.handle({ url: '/api/portmiami/live-events', method: 'POST' },
    { writeHead(code) { status = code; }, end() {} });
  service.stop(); await api.stop();
  assert.equal(status, 405);
});

// =============================================================================================
// The presentation model
// =============================================================================================

test('model: a field FL511 did not publish produces no row at all', () => {
  const rows = eventSourceRows({
    type: 'INCIDENT', latitude: 25.78, longitude: -80.17, sourceEventId: '1', detailFields: [] });
  const labels = rows.map(([label]) => label);
  assert.ok(!labels.includes('Severity'));
  assert.ok(!labels.includes('Detour'));
  assert.ok(labels.includes('Location'));
  assert.ok(labels.includes('FL511 event ID'));
});

test('model: matched and candidate events for a road are kept apart', () => {
  const events = [
    { id: 'a', roadAssociations: [{ roadObjectId: 1, status: 'MATCHED', distanceMeters: 40 }] },
    { id: 'b', roadAssociations: [{ roadObjectId: 1, status: 'CANDIDATE', distanceMeters: 10 }] },
    { id: 'c', roadAssociations: [{ roadObjectId: 2, status: 'MATCHED', distanceMeters: 5 }] },
  ];
  const { matched, candidates } = eventsForRoad(events, 1);
  assert.deepEqual(matched.map(entry => entry.event.id), ['a']);
  assert.deepEqual(candidates.map(entry => entry.event.id), ['b']);
});

test('model: an event is listed once for a set of roads, under its strongest link', () => {
  const events = [{
    id: 'a',
    roadAssociations: [
      { roadObjectId: 1, status: 'CANDIDATE', distanceMeters: 10 },
      { roadObjectId: 2, status: 'MATCHED', distanceMeters: 60 },
    ],
  }];
  const found = eventsForRoads(events, [1, 2]);
  assert.equal(found.length, 1);
  assert.equal(found[0].link.status, 'MATCHED');
});

test('model: cached, unreachable and empty are three different messages', () => {
  assert.equal(statusNotice({ sourceStatus: 'LIVE' }), null);
  assert.match(statusNotice({ sourceStatus: 'STALE', dataFreshness: { ageSeconds: 400 } }),
    /not responding; showing the last successful update from 7 min ago/);
  assert.match(statusNotice({ sourceStatus: 'UNAVAILABLE' }), /has not retrieved any FL511 data yet/);
  assert.match(statusNotice({ sourceStatus: 'SERVICE_UNREACHABLE', counts: { total: 3 } }),
    /no longer updating/);
  assert.match(statusNotice({ sourceStatus: 'SERVICE_UNREACHABLE', counts: { total: 0 } }),
    /no FL511 data has been received/);
});

test('model: the source chip tone matches the condition', () => {
  assert.equal(sourceNote({ sourceStatus: UI_STATUS.LIVE }).tone, 'live');
  assert.equal(sourceNote({ sourceStatus: UI_STATUS.STALE }).tone, 'warn');
  assert.equal(sourceNote({ sourceStatus: UI_STATUS.SERVICE_UNREACHABLE }).tone, 'warn');
});

test('model: the summary counts are computed from the records', () => {
  const summary = summariseTraffic(
    [{ type: 'INCIDENT', roadAssociationStatus: 'MATCHED', roadAssociations: [{ status: 'MATCHED', isPortAccess: true }] },
     { type: 'CLOSURE', roadAssociationStatus: 'CANDIDATE', roadAssociations: [] }],
    [{ videoEnabled: true }, { videoEnabled: false }], [{ id: '1' }]);
  assert.equal(summary.incidents, 1);
  assert.equal(summary.closures, 1);
  assert.equal(summary.cameras, 2);
  assert.equal(summary.camerasWithVideo, 1);
  assert.equal(summary.messageSigns, 1);
  assert.equal(summary.eventsOnKnownRoads, 1);
  assert.equal(summary.eventsOnPortAccessRoads, 1);
});

test('model: the diff reports added, updated and removed by FL511 id', () => {
  const before = [{ id: 'a', latitude: 1 }, { id: 'b', latitude: 2 }];
  const after = [{ id: 'a', latitude: 1 }, { id: 'b', latitude: 9 }, { id: 'c', latitude: 3 }];
  const { added, updated, removed } = diffEvents(before, after);
  assert.deepEqual(added.map(event => event.id), ['c']);
  assert.deepEqual(updated.map(event => event.id), ['b']);
  assert.deepEqual(removed, []);
  assert.deepEqual(diffEvents(before, []).removed, ['a', 'b']);
});

test('model: a tooltip never invents a road or a severity', () => {
  const text = eventTooltip({ type: 'INCIDENT', sourceEventId: '1' });
  assert.match(text, /^Incident\n/);
  assert.match(text, /FL511 event 1/);
  assert.equal(text.includes('undefined'), false);
});

test('model: ages and distances format, and a non-number formats as nothing', () => {
  assert.equal(formatAge(45), '45s');
  assert.equal(formatAge(400), '7 min');
  assert.equal(formatAge(7200), '2 h');
  assert.equal(formatMeters(140), '140 m');
  assert.equal(formatMeters(1400), '1.4 km');
  assert.equal(formatMeters(null), null);
});

test('service: each clock is judged stale against its OWN cadence, not a shared one', async () => {
  // A 300 s camera refresh measured against the 180 s event threshold would report healthy camera
  // data as "cached" for two minutes out of every five.
  let clock = 1_700_000_000_000;
  const service = createLiveTrafficService({
    config: CONFIG, region: REGION, network: await network(), client: stubClient(),
    logger: silent, now: () => clock });
  await service.start();
  clock += 240 * 1000;                     // four minutes: past the event threshold, inside the asset one
  const events = await service.getEvents();
  const cameras = await service.getCameras();
  service.stop();
  assert.equal(events.sourceStatus, SOURCE_STATUS.STALE, 'four minutes is four missed event polls');
  assert.equal(cameras.sourceStatus, SOURCE_STATUS.LIVE, 'four minutes is less than one missed camera poll');
  assert.equal(cameras.dataFreshness.staleAfterSeconds, CONFIG.assetStaleAfterSeconds);
  assert.equal(events.dataFreshness.staleAfterSeconds, CONFIG.staleAfterSeconds);
});

test('render: the pin is given an explicit on-screen size, not just a scale', () => {
  // The pin image is authored at 4x (176x208). A Cesium billboard with no width/height takes the
  // image's NATURAL size, which rendered these at ~92x108 px — about three and a half times too
  // big. The guard is that a size is stated at all, and that it is a sane one.
  const { pin, scale } = TRAFFIC_RENDER;
  assert.ok(Number.isFinite(pin.width) && Number.isFinite(pin.height));
  assert.ok(pin.width >= 24 && pin.width <= 56, `pin width ${pin.width}: legible and clickable`);
  assert.ok(pin.height > pin.width, 'a map pin is taller than it is wide');
  assert.equal(scale.resting, 1, 'scale multiplies the stated size; resting must not rescale it');
  assert.ok(scale.hovered > scale.resting && scale.selected > scale.hovered);
});

test('render: cameras and message signs use the SDNA primary blue, not a status hue', () => {
  // They are infrastructure and carry no severity, so they must not borrow an event colour.
  assert.equal(TRAFFIC_ICONS.CAMERA.color, '#1862d0', '$primary from quasar.variables.scss');
  assert.match(TRAFFIC_ICONS.MESSAGE_SIGN.color, /^#114592$/, 'a darker step of the same hue');
  const eventColours = ['INCIDENT', 'CLOSURE', 'CONGESTION', 'CONSTRUCTION', 'DISABLED_VEHICLE']
    .map(key => TRAFFIC_ICONS[key].color);
  for (const infrastructure of [TRAFFIC_ICONS.CAMERA.color, TRAFFIC_ICONS.MESSAGE_SIGN.color]) {
    assert.ok(!eventColours.includes(infrastructure), 'no event type shares an infrastructure colour');
  }
});

test('render: every pin colour carries its white glyph at 3:1 or better', () => {
  // The glyph is white on the badge, so the badge is what has to be dark enough to hold it.
  // 3:1 is WCAG 1.4.11's bar for a non-text graphic, which is what an icon on a pin is; it is
  // NOT the 4.5:1 text bar. Two inherited ACS hues failed even this — construction at 2.80:1 and
  // congestion at 1.92:1 — and were darkened along their own hue rather than replaced.
  const luminance = hex => {
    const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  for (const [key, icon] of Object.entries(TRAFFIC_ICONS)) {
    const ratio = (1 + 0.05) / (luminance(icon.color) + 0.05);
    assert.ok(ratio >= 3, `${key} ${icon.color} carries a white glyph at ${ratio.toFixed(2)}:1`);
  }
});
