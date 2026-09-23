/**
 * The normalization and spatial resolution, against the committed DataConnect export — the same
 * records the workspace loads. Field names are asserted here so a schema change fails loudly
 * rather than quietly emptying the UI.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assetIndex, getAssetActivity, hasLocation, MAINTENANCE_TYPES, normalizeAll,
  relatedRecords, resolveLocations, summarize,
} from '../src/maintenance/maintenanceRecords.js';

const read = name => JSON.parse(readFileSync(new URL(`../public/dataconnect-data/${name}.json`, import.meta.url)));
const assets = assetIndex(read('asset_registry'));
const workOrders = resolveLocations(normalizeAll('workOrders', read('work_orders')), assets);

test('the asset registry indexes by id, numeric ids included', () => {
  assert.ok(assets.size > 4000);
  const numeric = [...assets.values()].find(asset => /^\d+$/.test(asset.id));
  assert.ok(numeric && Number.isFinite(numeric.longitude) && Number.isFinite(numeric.latitude));
});

test('work orders map the fields the class actually carries', () => {
  assert.equal(workOrders.length, 854);
  const order = workOrders.find(item => item.id === 'WO-900551');
  assert.equal(order.type, MAINTENANCE_TYPES.WORK_ORDER);
  assert.equal(order.title, 'Field Restoration');
  assert.equal(order.status, 'Closed');
  assert.equal(order.priority, 'Low');
  assert.equal(order.assetId, '11905');
  assert.equal(order.assetType, 'Access Gate');
  assert.equal(order.segmentName, 'East Segment');
  assert.equal(order.related.ticketId, 'TIC-500673');
  assert.equal(order.related.taskId, 'TSK-700673');
  assert.match(order.description, /preventive maintenance/);
  assert.ok(order.raw, 'the source row is kept');
  // Only real statuses and priorities exist.
  assert.deepEqual([...new Set(workOrders.map(item => item.status))].sort(),
    ['Assigned', 'Awaiting Parts', 'Closed', 'Completed', 'In Progress', 'Open', 'Pending Review']);
  assert.deepEqual([...new Set(workOrders.map(item => item.priority))].sort(), ['High', 'Low', 'Medium']);
});

test('a work order has no coordinates of its own and takes its asset\'s', () => {
  const raw = normalizeAll('workOrders', read('work_orders'));
  assert.ok(raw.every(item => !hasLocation(item)), 'the class carries no coordinates');
  const located = workOrders.filter(hasLocation);
  assert.equal(located.length, 853);
  assert.ok(located.every(item => item.locationSource === 'asset'));
  // The one that cannot be placed is kept, without a position.
  const unresolved = workOrders.filter(item => !hasLocation(item));
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].locationSource, null);
  // Its position is its asset's, exactly.
  const order = located[0], asset = assets.get(order.assetId);
  assert.deepEqual([order.longitude, order.latitude], [asset.longitude, asset.latitude]);
});

test('KPI counts come from the records, never from a constant', () => {
  const summary = summarize(workOrders, 'workOrders');
  assert.equal(summary.total, 854);
  assert.equal(summary.located, 853);
  assert.equal(summary.linked, 854);
  const open = workOrders.filter(item => !['Closed', 'Completed'].includes(item.status)).length;
  const high = workOrders.filter(item => item.priority === 'High').length;
  assert.equal(summary.note, `${open} open · ${high} high priority`);
  assert.deepEqual(summarize([], 'workOrders'), { total: 0, note: null, located: 0, linked: 0 });
});

test('tickets and tasks keep their own coordinates; inspections read three sheets', () => {
  const tickets = resolveLocations(normalizeAll('tickets', read('tickets')), assets);
  assert.equal(tickets.length, 1021);
  assert.ok(tickets.filter(hasLocation).length >= 1019);
  const inspections = resolveLocations(
    normalizeAll('inspections', ['roadway_inspections_v3', 'safety_inspections_v3', 'its_inspections_v3'].flatMap(read)), assets);
  assert.equal(inspections.length, 1548, 'all three sheets, none dropped');
  assert.ok(inspections.some(item => /fail/i.test(item.status ?? '')), 'pass_fail is mapped');
  assert.ok(inspections.every(item => item.id && item.type === MAINTENANCE_TYPES.INSPECTION));
  // inspection_id repeats across the roadway and ITS sheets; each sheet's own record id does not.
  assert.equal(new Set(inspections.map(item => item.id)).size, 1548, 'identities are unique');
  const shared = inspections.find(item => item.related.inspectionRef);
  assert.match(shared.id, /^ITSV3-|^SAFE-/);
});

test('asset activity joins on identifiers the records carry', () => {
  const tickets = resolveLocations(normalizeAll('tickets', read('tickets')), assets);
  const order = workOrders.find(item => tickets.some(ticket => ticket.id === item.related.ticketId));
  const activity = getAssetActivity(order.assetId, { assets, records: { workOrders, tickets } });
  assert.equal(activity.asset.id, order.assetId);
  assert.ok(activity.workOrders.some(item => item.id === order.id));
  assert.ok(activity.workOrders.every(item => item.assetId === order.assetId));
  assert.deepEqual([activity.incidents, activity.tasks, activity.inspections].map(list => list.length), [0, 0, 0]);
  const related = relatedRecords(order, { tickets });
  assert.equal(related.ticket.id, order.related.ticketId);
});
