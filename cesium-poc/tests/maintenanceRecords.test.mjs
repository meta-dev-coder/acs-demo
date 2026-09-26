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

test('a DataConnect record normalizes exactly as the same record from the export', () => {
  const exportRow = read('work_orders').find(row => row['Work Order ID'] === 'WO-900551');
  // The shape DataConnect returns: fields inside `attributes`, with the envelope around them.
  const apiRecord = {
    id: 'c0ffee', classId: 'class-work-orders', className: 'work_orders',
    keyInSource: 'WO-900551', valid: true, attributes: { ...exportRow },
  };
  const fromExport = normalizeAll('workOrders', [exportRow])[0];
  const fromApi = normalizeAll('workOrders', [apiRecord])[0];
  for (const key of ['id', 'type', 'title', 'status', 'priority', 'assetId', 'assetType', 'systemClass',
    'segmentName', 'createdDate', 'closedDate', 'description']) {
    assert.equal(fromApi[key], fromExport[key], key);
  }
  assert.deepEqual(fromApi.related, fromExport.related);
  // The whole DataConnect record is kept for debugging, envelope and all.
  assert.equal(fromApi.raw.classId, 'class-work-orders');
  assert.equal(fromApi.raw.keyInSource, 'WO-900551');
});

test('DataConnect spellings of the same field are the same field', () => {
  const snake = { attributes: { work_order_id: 'WO-1', work_order_status: 'Open', priority: 'High',
    asset_id: '11905', work_type: 'Field Restoration', related_ticket_id: 'TIC-1' } };
  const camel = { attributes: { workOrderId: 'WO-2', workOrderStatus: 'Closed', priority: 'Low', assetId: '12029' } };
  const [first, second] = normalizeAll('workOrders', [snake, camel]);
  assert.deepEqual([first.id, first.status, first.priority, first.assetId, first.title, first.related.ticketId],
    ['WO-1', 'Open', 'High', '11905', 'Field Restoration', 'TIC-1']);
  assert.deepEqual([second.id, second.status, second.assetId], ['WO-2', 'Closed', '12029']);
});

test('a record identified only by keyInSource still counts', () => {
  const record = normalizeAll('workOrders', [{ keyInSource: 'WO-ONLY', attributes: { 'Work Order Status': 'Open' } }])[0];
  assert.equal(record.id, 'WO-ONLY');
  assert.equal(record.status, 'Open');
});

test('an asset from DataConnect indexes and resolves a work order the same way', () => {
  const apiAssets = [{ id: 'a1', keyInSource: '11905', attributes: { 'Asset ID': '11905', 'Asset Category': 'Access Gate',
    'X Coordinates': -80.25, 'Y Coordinates': 26.1 } }];
  const index = assetIndex(apiAssets);
  assert.equal(index.get('11905').longitude, -80.25);
  const [order] = resolveLocations(normalizeAll('workOrders', [{ attributes: { 'Work Order ID': 'WO-9', 'Asset ID': '11905' } }]), index);
  assert.deepEqual([order.longitude, order.latitude, order.locationSource], [-80.25, 26.1, 'asset']);
});

test('a day-first date is read as written, not as a US month-first date', async () => {
  const { maintenanceDate } = await import('../src/assetExplorer/assetTypes.js');
  // The live classes write day-first. 04/11/2024 is 4 November; reading it as 11 April would be
  // silently wrong and is exactly what `new Date` does.
  assert.equal(maintenanceDate('04/11/2024'), 'Nov 4, 2024');
  assert.equal(maintenanceDate('17/11/2024'), 'Nov 17, 2024');
  assert.equal(maintenanceDate('23/01/2026'), 'Jan 23, 2026');
  // The committed export's ISO spelling still works.
  assert.equal(maintenanceDate('2024-04-16T00:00:00'), 'Apr 16, 2024');
  // Neither format: left exactly as written rather than reinterpreted.
  assert.equal(maintenanceDate('13/13/2024'), '13/13/2024');
  assert.equal(maintenanceDate(''), null);
});

test('inspections keep every class: identity falls back to the code each sheet does carry', () => {
  // The roadway and safety classes have no record_id — only the ITS sheet does.
  const rows = [
    { attributes: { record_id: 'ITSV3-1', inspection_form_family: 'ITS' }, keyInSource: 'ITSV3-1' },
    { attributes: { code: 'INSP-100098', inspection_form_family: 'Roadway' }, keyInSource: 'INSP-100098' },
    { attributes: { code: 'SAFE-000251', inspection_form_family: 'Safety' }, keyInSource: 'SAFE-000251' },
  ];
  const records = normalizeAll('inspections', rows);
  assert.deepEqual(records.map(r => r.id), ['ITSV3-1', 'INSP-100098', 'SAFE-000251']);
});

test('a reference shared by two classes still yields two distinct map keys', () => {
  // 115 roadway codes repeat in the ITS class; a repeated id would silently replace a marker.
  const rows = [
    { attributes: { code: 'INSP-100098', inspection_form_family: 'Roadway' }, keyInSource: 'INSP-100098' },
    { attributes: { code: 'INSP-100098', inspection_form_family: 'ITS' }, keyInSource: 'INSP-100098' },
    { attributes: { code: 'INSP-999', inspection_form_family: 'Roadway' }, keyInSource: 'INSP-999' },
  ];
  const records = normalizeAll('inspections', rows);
  assert.equal(new Set(records.map(r => r.id)).size, 3, 'every record has its own key');
  assert.deepEqual(records.map(r => r.sourceId), ['INSP-100098', 'INSP-100098', 'INSP-999'],
    'the shared reference is preserved');
  assert.equal(records[2].id, 'INSP-999', 'a record that does not clash is left untouched');
});

test('a calendar date does not shift with the machine timezone', async () => {
  const { maintenanceDate } = await import('../src/assetExplorer/assetTypes.js');
  // The export's ISO values carry no zone. Read as a local instant they slide a day either side of
  // Greenwich, so the same record would show two different dates on two developers' machines.
  for (const tz of ['UTC', 'Asia/Kolkata', 'Pacific/Kiritimati', 'America/Los_Angeles']) {
    process.env.TZ = tz;
    assert.equal(maintenanceDate('2024-04-16T00:00:00'), 'Apr 16, 2024', `ISO in ${tz}`);
    assert.equal(maintenanceDate('04/11/2024'), 'Nov 4, 2024', `day-first in ${tz}`);
  }
});

test('a class shipping x and y the wrong way round is read the only way that makes sense', async () => {
  const { coordinateSwaps, resetCoordinateSwaps } = await import('../src/maintenance/maintenanceRecords.js');
  resetCoordinateSwaps();
  const inspection = (x, y) => normalizeAll('inspections', [{ attributes: { record_id: 'R', x_coordinates: x, y_coordinates: y } }])[0];

  // The safety and ITS classes are correct and must be left alone.
  const correct = inspection(-80.3295, 26.1177);
  assert.deepEqual([correct.longitude, correct.latitude], [-80.3295, 26.1177]);
  assert.equal(coordinateSwaps(), 0, 'a correct pair is not touched');

  // The roadway class holds latitude in x. Read as written it is off Antarctica; only the swap is
  // on the corridor, so only the swap can be what was meant.
  const swapped = inspection(26.1177, -80.3295);
  assert.deepEqual([swapped.longitude, swapped.latitude], [-80.3295, 26.1177]);
  assert.equal(coordinateSwaps(), 1, 'and the correction is counted, not silent');

  // A pair that reads as nowhere near I-595 either way is unusable: this is a corridor application,
  // and the export really does contain a longitude that lost a digit (-8.33 for -80.33). The record
  // is still listed; it simply has no position, like any other unplaceable one.
  const elsewhere = inspection(-0.1276, 51.5072);          // London
  assert.equal(elsewhere.longitude, null);
  assert.equal(elsewhere.latitude, null);
  const truncated = inspection(26.1176701, -8.32952785);   // the real defect, from the export
  assert.equal(truncated.latitude, null, 'a corrupt coordinate is dropped, not drawn 9,000 km away');
  // A pair that reads sensibly both ways is never second-guessed.
  const ambiguous = inspection(-80.2, 26.1);
  assert.deepEqual([ambiguous.longitude, ambiguous.latitude], [-80.2, 26.1]);
  assert.equal(coordinateSwaps(), 1, 'nothing else was swapped');
});

test('incident type filters are built from the data, ordered by how many records carry each', async () => {
  const { incidentTypeFilters, assetTypeConfig } = await import('../src/assetExplorer/assetTypes.js');
  const asset = (title, id) => ({ id, source: { title }, coordinates: { latitude: 26.1, longitude: -80.3 } });
  const assets = [
    asset('Vehicle fire', 'A'), asset('Vehicle fire', 'B'), asset('Vehicle fire', 'C'),
    asset('Rear-end crash', 'D'), asset('Multi-vehicle crash', 'E'), asset(null, 'F'),
  ];
  const filters = incidentTypeFilters(assets);
  // Commonest first, so the types worth looking at are reachable without scrolling. A record with
  // no type contributes no filter rather than an empty one.
  assert.deepEqual(filters.map(f => [f.label, f.count]),
    [['Vehicle fire', 3], ['Multi-vehicle crash', 1], ['Rear-end crash', 1]]);
  assert.deepEqual(filters.map(f => f.id),
    ['incident-type:vehicle-fire', 'incident-type:multi-vehicle-crash', 'incident-type:rear-end-crash']);
  // The `group` is what makes the explorer offer these as a dropdown instead of fifteen chips.
  assert.ok(filters.every(f => f.group === 'Incident type'));
  assert.deepEqual(assets.filter(filters[0].match).map(a => a.id), ['A', 'B', 'C']);

  // They reach the incident type's own filter list, alongside the plain chips.
  const all = assetTypeConfig('incidentRecord').getFilters(assets);
  assert.ok(all.some(f => f.id === 'incident-type:vehicle-fire'), 'incidents offer their types');
  assert.ok(all.some(f => f.id === 'unplaced' || !f.group), 'and still offer the shared filters');
  // Other maintenance classes are unchanged: no type dropdown where there is no taxonomy.
  assert.deepEqual(assetTypeConfig('workOrder').getFilters(assets).filter(f => f.group), []);
});

test('a cleared record is not counted as open', () => {
  const records = [{ id: 'T-1', status: 'Open' }, { id: 'T-2', status: 'Cleared' }];
  assert.equal(summarize(records, 'tickets').note, '1 open');
});
