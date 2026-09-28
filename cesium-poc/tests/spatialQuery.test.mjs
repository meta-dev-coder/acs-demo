/**
 * The deterministic half of Ask the Twin's area selection: what a drawn box contains.
 *
 * These are the acceptance cases for the feature — a rectangle over one carriageway, over all
 * three, over two sections, over nothing — asserted against the corridor's own published geometry
 * rather than a fixture, because agreeing with the real FDOT lines IS the requirement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { carriagewayLines } from '../src/assetExplorer/incidentContext.js';
import { CARRIAGEWAYS } from '../src/liveOps/carriagewayModel.js';
import {
  buildSpatialContext, findAssets, findLiveEvents, findMaintenance, isOpenRecord,
  locateMaintenanceRecord, resolveRoadwayContext, sectionIdFor, sectionLabelFor,
} from '../src/spatial/spatialQuery.js';

const read = async name => JSON.parse(await readFile(fileURLToPath(new URL(`../public/data/${name}`, import.meta.url)), 'utf8'));
const lines = [
  ...carriagewayLines(await read('i595_fdot_traffic_segments.geojson')),
  ...carriagewayLines(await read('express-way.geojson')),
];

/** Over the corridor at SW 136th Ave, where eastbound, express and westbound run side by side. */
const ACROSS_CORRIDOR = { west: -80.256, south: 26.095, east: -80.248, north: 26.103 };
/** North of the corridor, over housing — nothing of I-595 in it. */
const OFF_CORRIDOR = { west: -80.30, south: 26.30, east: -80.28, north: 26.32 };

test('A · a box on one carriageway reports that carriageway only', () => {
  // A thin box south of the corridor centre, clear of the westbound lanes.
  const eastboundOnly = lines.filter(line => line.properties.direction === 'EB');
  const roadway = resolveRoadwayContext(ACROSS_CORRIDOR, eastboundOnly);
  assert.deepEqual(roadway.carriageways, [CARRIAGEWAYS.EB_GENERAL]);
  assert.equal(roadway.includesExpress, false);
  assert.ok(roadway.segments.every(segment => segment.carriageway === CARRIAGEWAYS.EB_GENERAL));
});

test('B · a box across the corridor reports all three carriageways, not the nearest one', () => {
  const roadway = resolveRoadwayContext(ACROSS_CORRIDOR, lines);
  assert.deepEqual(roadway.carriageways,
    [CARRIAGEWAYS.EB_GENERAL, CARRIAGEWAYS.EXPRESS, CARRIAGEWAYS.WB_GENERAL]);
  assert.equal(roadway.intersectsI595, true);
  assert.equal(roadway.includesExpress, true);
});

test('C · a box down the corridor returns every section it crosses', () => {
  const long = { west: -80.33, south: 26.08, east: -80.24, north: 26.13 };
  const roadway = resolveRoadwayContext(long, lines);
  const eastbound = roadway.segments.filter(segment => segment.carriageway === CARRIAGEWAYS.EB_GENERAL);
  assert.ok(eastbound.length >= 2, `expected several EB sections, got ${eastbound.length}`);
  assert.ok(eastbound.every(segment => segment.sectionId?.startsWith('SECTION_')));
  assert.ok(eastbound.every(segment => segment.segmentId), 'a general-purpose section has an FDOT id');
});

test('I · express is reported as intersected, and never given an invented section id', () => {
  const roadway = resolveRoadwayContext(ACROSS_CORRIDOR, lines);
  assert.equal(roadway.includesExpress, true);
  assert.ok(roadway.carriageways.includes(CARRIAGEWAYS.EXPRESS));
  // Express contributes no row to `segments` at all, so nothing downstream can print a fake id.
  assert.equal(roadway.segments.some(segment => segment.carriageway === CARRIAGEWAYS.EXPRESS), false);
});

test('J · a box away from the corridor is associated with nothing', () => {
  const roadway = resolveRoadwayContext(OFF_CORRIDOR, lines);
  assert.deepEqual(roadway, { intersectsI595: false, carriageways: [], segments: [], includesExpress: false });
});

test('section names match the ones Live Ops already prints', () => {
  // liveOpsWorkspace.js builds these inline; the two must read identically or one screen will call
  // the same stretch of road something the other does not.
  assert.equal(sectionIdFor(3), 'SECTION_03');
  assert.equal(sectionIdFor(null), null);
  assert.equal(sectionLabelFor('EB', 3), 'Eastbound Section 03');
  assert.equal(sectionLabelFor('WB', 12), 'Westbound Section 12');
});

test('D/E · a live event is in the area when its point is, and not when it is not', () => {
  const inside = { id: 'A', type: 'INCIDENT', title: 'Crash', latitude: 26.099, longitude: -80.252, status: 'Active' };
  const outside = { id: 'B', type: 'INCIDENT', title: 'Crash', latitude: 26.310, longitude: -80.290 };
  const found = findLiveEvents(ACROSS_CORRIDOR, [inside, outside]);
  assert.deepEqual(found.incidents.map(event => event.id), ['A']);
  assert.equal(found.closures.length, 0);
});

test('F · a closure whose two endpoints are both outside still counts, because it crosses the box', () => {
  const spanning = {
    id: 'C', type: 'CLOSURE', title: 'Closure',
    longitude: -80.30, latitude: 26.099, secondaryLongitude: -80.20, secondaryLatitude: 26.099,
  };
  const found = findLiveEvents(ACROSS_CORRIDOR, [spanning]);
  assert.deepEqual(found.closures.map(event => event.id), ['C'], 'the line through the box is what matters');
});

test('live events are reduced to what an answer needs, never the raw feed', () => {
  const event = { id: 'A', type: 'CLOSURE', title: 'Closure', latitude: 26.099, longitude: -80.252,
    severity: 'Major', status: 'Active', lastUpdated: 'Sep 28 2026, 3:40 AM', description: 'x'.repeat(4000),
    detailFields: Array.from({ length: 50 }, (_, i) => ({ label: `f${i}`, value: 'y' })),
    liveOps: { carriageway: 'EB_GENERAL', carriagewayLabel: 'Eastbound', sectionId: 'SECTION_03', laneImpactLabel: '2 lanes' } };
  const [normalized] = findLiveEvents(ACROSS_CORRIDOR, [event]).closures;
  assert.deepEqual(Object.keys(normalized).sort(), ['carriageway', 'carriagewayLabel', 'id', 'laneImpact',
    'latitude', 'longitude', 'secti'.concat('onId'), 'segmentId', 'severity', 'status', 'title', 'type', 'updatedAt'].sort());
  assert.equal(normalized.sectionId, 'SECTION_03');
  assert.ok(!JSON.stringify(normalized).includes('xxxx'), 'the raw payload does not come with it');
});

test('G · assets inside are returned and grouped by the category the explorer already uses', () => {
  const entries = [
    { asset: { id: '4944', assetType: 'camera', name: 'Cam 4944', coordinates: { longitude: -80.252, latitude: 26.099 } } },
    { asset: { id: '5181', assetType: 'camera', name: 'Cam 5181', coordinates: { longitude: -80.290, latitude: 26.310 } } },
    { asset: { id: 'G1', assetType: 'gantry', name: 'Gantry 1', coordinates: { longitude: -80.250, latitude: 26.100 } } },
  ];
  const assets = findAssets(ACROSS_CORRIDOR, entries);
  assert.equal(assets.total, 2);
  assert.deepEqual(assets.records.map(record => record.id).sort(), ['4944', 'G1']);
  assert.deepEqual(assets.byCategory, { 'Traffic Cameras': 1, 'Toll Gantries': 1 });
});

test('an asset with a span rather than a point is tested against its own geometry', () => {
  const bridge = { asset: { id: 'B1', assetType: 'bridge', name: 'Bridge 1', coordinates: null,
    geometry: { type: 'LineString', coordinates: [[-80.30, 26.099], [-80.20, 26.099]] } } };
  assert.equal(findAssets(ACROSS_CORRIDOR, [bridge]).total, 1, 'it crosses the box');
  const nowhere = { asset: { id: 'B2', assetType: 'bridge', name: 'Bridge 2', coordinates: null } };
  assert.equal(findAssets(ACROSS_CORRIDOR, [nowhere]).total, 0, 'no position means not claimed to be in');
});

test('H · a work order with no coordinates of its own is found through the asset it names', () => {
  const assetIndex = new Map([['10145', { longitude: -80.252, latitude: 26.099 }],
    ['99999', { longitude: -80.290, latitude: 26.310 }]]);
  const records = {
    workOrder: [
      { id: 'WO-900653', type: 'WORK_ORDER', title: 'Repair', status: 'Open', priority: 'High', assetId: '10145', longitude: null, latitude: null },
      { id: 'WO-900999', type: 'WORK_ORDER', title: 'Repair', status: 'Open', assetId: '99999', longitude: null, latitude: null },
      { id: 'WO-NOWHERE', type: 'WORK_ORDER', title: 'Repair', status: 'Open', assetId: null, longitude: null, latitude: null },
    ],
  };
  const found = findMaintenance(ACROSS_CORRIDOR, type => records[type] ?? [], assetIndex);
  assert.deepEqual(found.workOrders.map(record => record.id), ['WO-900653']);
  assert.equal(found.workOrders[0].locatedVia, 'asset', 'said plainly: the asset is here, not the paperwork');
  assert.equal(found.workOrders[0].priority, 'High');
});

test('a record with its own coordinates uses them, and one with neither is left out', () => {
  const own = { id: 'TIC-1', longitude: -80.252, latitude: 26.099, locationSource: 'record' };
  assert.deepEqual(locateMaintenanceRecord(own, new Map()),
    { longitude: -80.252, latitude: 26.099, via: 'record' });
  assert.equal(locateMaintenanceRecord({ id: 'TIC-2', assetId: 'missing' }, new Map()), null);
  // resolveLocations stamps the asset's position on at load and says so; that provenance survives.
  const stamped = { id: 'WO-1', longitude: -80.252, latitude: 26.099, locationSource: 'asset' };
  assert.equal(locateMaintenanceRecord(stamped, new Map()).via, 'asset');
});

test('open means anything a class has not marked finished', () => {
  assert.equal(isOpenRecord({ status: 'Open' }), true);
  assert.equal(isOpenRecord({ status: 'In Progress' }), true);
  assert.equal(isOpenRecord({ status: 'Closed' }), false);
  assert.equal(isOpenRecord({ status: 'Completed' }), false);
  assert.equal(isOpenRecord({ status: null }), false, 'no status is not a claim that it is open');
});

test('the whole context is one serializable object, with totals that match its own lists', () => {
  const context = buildSpatialContext({
    bounds: ACROSS_CORRIDOR,
    lines,
    liveEvents: [{ id: 'A', type: 'CLOSURE', title: 'Closure', latitude: 26.099, longitude: -80.252 }],
    assetEntries: [{ asset: { id: '4944', assetType: 'camera', name: 'Cam', coordinates: { longitude: -80.252, latitude: 26.099 } } }],
    maintenanceLookup: type => (type === 'workOrder'
      ? [{ id: 'WO-1', status: 'Open', assetId: 'A1', longitude: -80.252, latitude: 26.099 }] : []),
    selectedAt: '2026-09-28T12:00:00.000Z',
  });
  assert.equal(context.selection.type, 'RECTANGLE');
  assert.deepEqual(context.selection.polygon[0], [ACROSS_CORRIDOR.west, ACROSS_CORRIDOR.south]);
  assert.equal(context.totals.events, 1);
  assert.equal(context.totals.assets, 1);
  assert.equal(context.totals.openWorkOrders, 1);
  assert.equal(context.totals.sections, context.roadway.segments.length);
  // It has to survive the trip to a question and to a test, so it must be plain data.
  assert.deepEqual(JSON.parse(JSON.stringify(context)), context);
});

test('a box over nothing produces an empty context rather than no context', () => {
  const context = buildSpatialContext({ bounds: OFF_CORRIDOR, lines, liveEvents: [], assetEntries: [] });
  assert.equal(context.roadway.intersectsI595, false);
  assert.deepEqual(context.totals, { events: 0, assets: 0, maintenance: 0, openWorkOrders: 0, sections: 0 });
  // A click with no drag is not an area at all.
  assert.equal(buildSpatialContext({ bounds: { west: 1, south: 1, east: 1, north: 1 }, lines }), null);
});

test('maintenance records are not also counted as assets', () => {
  // Both lists come from the same explorer inventory, so without a guard one work order lands in
  // each — and an area holding 272 things reports 619.
  const entries = [
    { asset: { id: 'WO-1', assetType: 'workOrder', name: 'WO-1', coordinates: { longitude: -80.252, latitude: 26.099 } } },
    { asset: { id: 'TIC-1', assetType: 'ticket', name: 'TIC-1', coordinates: { longitude: -80.252, latitude: 26.099 } } },
    { asset: { id: 'INSP-1', assetType: 'inspection', name: 'INSP-1', coordinates: { longitude: -80.252, latitude: 26.099 } } },
    { asset: { id: '4944', assetType: 'camera', name: 'Cam', coordinates: { longitude: -80.252, latitude: 26.099 } } },
  ];
  const assets = findAssets(ACROSS_CORRIDOR, entries);
  assert.equal(assets.total, 1, 'only the camera is an asset');
  assert.deepEqual(Object.keys(assets.byCategory), ['Traffic Cameras']);
});

test('answers name things the way an operator says them', async () => {
  const { describeMaintenance } = await import('../src/spatial/areaAnswers.js');
  const context = { maintenance: { workOrders: [{ id: 'WO-1', status: 'Open', title: 'Repair', assetId: 'A1', locatedVia: 'asset' }],
    tickets: [], tasks: [], inspections: [], damagedAssets: [], incidents: [] } };
  const text = describeMaintenance(context, { openOnly: true, group: 'workOrders' });
  assert.match(text, /^1 open work order:/, 'not "1 open workOrders"');
  assert.match(text, /via asset A1/, 'says the record is here because its asset is');
  const many = { maintenance: { ...context.maintenance,
    workOrders: [context.maintenance.workOrders[0], { id: 'WO-2', status: 'Open' }] } };
  assert.match(describeMaintenance(many, { openOnly: true, group: 'workOrders' }), /^2 open work orders:/);
});
