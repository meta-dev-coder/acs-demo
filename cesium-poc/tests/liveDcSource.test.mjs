/**
 * The browser half of the Live DataConnect view: records from the "SDNA Florida I595 Live *" classes are
 * normalised into the same shapes as the historical classes, flagged live, and merged beside them.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIVE_DC_CLASSES, LIVE_SOURCE_LABEL, CLEARED_WINDOW_MS, fetchLiveDc, createLiveDcFeed, liveDcEnabled,
  liveCardNote, liveDcConnection, mergeLiveRecords, normalizeLiveRows,
} from '../src/maintenance/liveDcSource.js';
import { normalizeTicket } from '../src/maintenance/maintenanceRecords.js';
import { ASSET_TYPES, assetTypeConfig, detailRows, maintenanceFilters } from '../src/assetExplorer/assetTypes.js';

const NOW = Date.parse('2026-09-25T14:00:00Z');
const wrap = (className, attributes, keyInSource = attributes.code) =>
  ({ id: `oid-${keyInSource}`, classId: 'cls', className, keyInSource, attributes, valid: true });

const EVENT_ACTIVE = wrap('SDNA Florida I595 Live Events', {
  code: 'FL511-868702', name: 'Crash', description: 'Crash on I-595 West at Davie Rd. 2 right lanes blocked.',
  event_type: 'INCIDENT', status: 'active', severity: 'Minor', start_time: '2026-09-25T11:58:00Z',
  first_seen_at: '2026-09-25T12:00:00.000Z', latitude: 26.093417, longitude: -80.226583,
  section_label: 'Davie Rd to University Dr', 'segment name': 'Segment_104W', full_closure: 'No',
  lane_impact_label: '2 right lanes blocked', fl511_item_id: '868702',
});
const EVENT_RECENTLY_CLEARED = wrap('SDNA Florida I595 Live Events', {
  code: 'FL511-900001', name: 'Disabled Vehicle', event_type: 'DISABLED', status: 'cleared',
  first_seen_at: '2026-09-25T12:10:00.000Z', cleared_at: '2026-09-25T13:30:00.000Z',
  x_coordinates: -80.2, y_coordinates: 26.1,
});
const EVENT_LONG_CLEARED = wrap('SDNA Florida I595 Live Events', {
  code: 'FL511-800000', name: 'Construction', event_type: 'CONSTRUCTION', status: 'cleared',
  cleared_at: new Date(NOW - CLEARED_WINDOW_MS - 60_000).toISOString(), latitude: 26.1, longitude: -80.3,
});
const TICKET = wrap('SDNA Florida I595 Live Tickets', {
  code: 'TIC-FL511-868702', 'Ticket ID': 'TIC-FL511-868702', 'Issue Summary': 'Crash - Crash', 'Issue Category': 'Incident Response',
  'Ticket Status': 'Assigned', Priority: 'Medium', 'Asset ID': '', Segment: 'Davie Rd to University Dr',
  'Ticket Opened Date': '25/09/2026', 'Detailed Notes': 'Crash on I-595 West', 'Source Signal': 'FL511 live event',
  'X Coordinate': -80.226583, 'Y Coordinate': 26.093417, source_event_id: 'FL511-868702',
});
const TASK = wrap('SDNA Florida I595 Live Tasks', {
  code: 'TSK-FL511-868702-01', 'Task ID': 'TSK-FL511-868702-01', 'Task Type': 'Traffic control', 'Task Status': 'In Progress',
  'Related Ticket ID': 'TIC-FL511-868702', 'Assigned Team': 'Road Ranger', 'Task Date': '25/09/2026',
  'X Coordinate': -80.226583, 'Y Coordinate': 26.093417, source_event_id: 'FL511-868702',
});
const WORK_ORDER = wrap('SDNA Florida I595 Live Work Orders', {
  code: 'WO-FL511-868702', 'Work Order ID': 'WO-FL511-868702', 'Work Type': 'Field Restoration', 'Work Order Status': 'Open',
  Priority: 'Medium', 'Asset ID': '', 'Work Order Open Date': '25/09/2026', 'Related Ticket ID': 'TIC-FL511-868702',
  'Related Task ID': 'TSK-FL511-868702-01', 'Repair Category': 'Guardrail', x_coordinates: -80.226583, y_coordinates: 26.093417,
  source_event_id: 'FL511-868702',
});
const INSPECTION = wrap('SDNA Florida I595 Live Inspections', {
  code: 'INSP-FL511-868702', record_id: 'INSP-FL511-868702', inspection_form_family: 'Post-incident inspection',
  inspection_date: '25/09/2026', inspector_name: 'J. Doe', asset_id: 'GR-0042', asset_type: 'Guardrail', pass_fail: 'Fail',
  risk_rating_1_5: 4, issue_summary: 'Guardrail GR-0042 damaged after crash (FL511-868702)', recommended_action: 'Schedule WO to repair',
  segment: 'Davie Rd to University Dr', x_coordinates: -80.2265, y_coordinates: 26.0934, source_event_id: 'FL511-868702',
});
const ASSET_STATUS = wrap('SDNA Florida I595 Live Asset Status', {
  code: 'AST-GR-0042', name: 'Guardrail GR-0042', description: 'Damaged: Guardrail GR-0042 damaged after crash',
  asset_id: 'GR-0042', asset_category: 'Guardrail', 'system class': 'Roadway', status: 'Damaged',
  damaged_at: '2026-09-25T13:40:00.000Z', source_inspection_id: 'INSP-FL511-868702', source_event_id: 'FL511-868702',
  x_coordinates: -80.2265, y_coordinates: 26.0934,
});

const RECORD_KEYS = Object.keys(normalizeTicket({ 'Ticket ID': 'T-1' })).sort();

test('every Live class maps to a Maintenance key, by exact class name', () => {
  assert.deepEqual(LIVE_DC_CLASSES.map(c => [c.className, c.maintenanceKey]), [
    ['SDNA Florida I595 Live Events', 'incidents'],
    ['SDNA Florida I595 Live Tickets', 'tickets'],
    ['SDNA Florida I595 Live Tasks', 'tasks'],
    ['SDNA Florida I595 Live Work Orders', 'workOrders'],
    ['SDNA Florida I595 Live Inspections', 'inspections'],
    ['SDNA Florida I595 Live Asset Status', 'damagedAssets'],
  ]);
});

test('live events become incident records: active and recently cleared, never long-cleared', () => {
  const records = normalizeLiveRows('incidents', [EVENT_ACTIVE, EVENT_RECENTLY_CLEARED, EVENT_LONG_CLEARED], { now: NOW });
  assert.deepEqual(records.map(r => r.id), ['FL511-868702', 'FL511-900001']);
  const [active, cleared] = records;
  assert.deepEqual(Object.keys(active).filter(k => k !== 'live' && k !== 'sourceLabel').sort(), RECORD_KEYS);
  assert.equal(active.type, 'INCIDENT');
  assert.equal(active.live, true);
  assert.equal(active.sourceLabel, LIVE_SOURCE_LABEL);
  assert.equal(active.title, 'Crash');
  assert.equal(active.status, 'Active');
  assert.equal(active.priority, 'Minor');
  assert.equal(active.segmentName, 'Davie Rd to University Dr');
  assert.equal(active.createdDate, '2026-09-25T11:58:00Z');
  assert.equal(active.related.laneClosure, 'No');
  assert.equal(active.related.laneImpact, '2 right lanes blocked');
  assert.equal(active.related.eventType, 'INCIDENT');
  assert.deepEqual([active.longitude, active.latitude, active.locationSource], [-80.226583, 26.093417, 'record']);
  assert.equal(cleared.status, 'Cleared');
  assert.equal(cleared.closedDate, '2026-09-25T13:30:00.000Z');
  assert.equal(cleared.title, 'Disabled Vehicle');
  assert.deepEqual([cleared.longitude, cleared.latitude], [-80.2, 26.1]);
});

test('live tickets, tasks, work orders and inspections reuse the historical mappings', () => {
  const [ticket] = normalizeLiveRows('tickets', [TICKET], { now: NOW });
  assert.equal(ticket.type, 'TICKET');
  assert.equal(ticket.id, 'TIC-FL511-868702');
  assert.equal(ticket.status, 'Assigned');
  assert.equal(ticket.assetId, null, 'an empty Asset ID is no asset');
  assert.equal(ticket.related.issueCategory, 'Incident Response');
  assert.equal(ticket.related.eventId, 'FL511-868702');
  assert.equal(ticket.live, true);
  assert.equal(ticket.latitude, 26.093417);

  const [task] = normalizeLiveRows('tasks', [TASK], { now: NOW });
  assert.equal(task.type, 'TASK');
  assert.equal(task.related.ticketId, 'TIC-FL511-868702');
  assert.equal(task.related.assignedTeam, 'Road Ranger');

  const [workOrder] = normalizeLiveRows('workOrders', [WORK_ORDER], { now: NOW });
  assert.equal(workOrder.type, 'WORK_ORDER');
  assert.equal(workOrder.related.taskId, 'TSK-FL511-868702-01');
  assert.deepEqual([workOrder.longitude, workOrder.latitude, workOrder.locationSource], [-80.226583, 26.093417, 'record'],
    'a live work order carries its own position');

  const [inspection] = normalizeLiveRows('inspections', [INSPECTION], { now: NOW });
  assert.equal(inspection.type, 'INSPECTION');
  assert.equal(inspection.id, 'INSP-FL511-868702');
  assert.equal(inspection.status, 'Fail');
  assert.equal(inspection.priority, 4);
  assert.equal(inspection.assetId, 'GR-0042');
  assert.equal(inspection.latitude, 26.0934);
});

test('live asset status becomes a damaged-asset record', () => {
  const [damaged] = normalizeLiveRows('damagedAssets', [ASSET_STATUS], { now: NOW });
  assert.equal(damaged.type, 'ASSET_STATUS');
  assert.equal(damaged.id, 'AST-GR-0042');
  assert.equal(damaged.status, 'Damaged');
  assert.equal(damaged.assetId, 'GR-0042');
  assert.equal(damaged.assetType, 'Guardrail');
  assert.equal(damaged.systemClass, 'Roadway');
  assert.equal(damaged.createdDate, '2026-09-25T13:40:00.000Z');
  assert.equal(damaged.related.inspectionId, 'INSP-FL511-868702');
  assert.equal(damaged.related.eventId, 'FL511-868702');
  assert.equal(damaged.live, true);
  assert.deepEqual(Object.keys(damaged).filter(k => k !== 'live' && k !== 'sourceLabel').sort(), RECORD_KEYS);
});

test('rows with no identifier are dropped, unknown keys are refused', () => {
  assert.deepEqual(normalizeLiveRows('tickets', [{ attributes: { 'Ticket Status': 'Open' } }], { now: NOW }), []);
  assert.throws(() => normalizeLiveRows('assets', [], { now: NOW }));
});

test('live records are merged beside the historical ones, live first, ids kept unique', () => {
  const historical = [normalizeTicket({ 'Ticket ID': 'TIC-500464' }), normalizeTicket({ 'Ticket ID': 'TIC-FL511-868702' })];
  const live = normalizeLiveRows('tickets', [TICKET], { now: NOW });
  const merged = mergeLiveRecords(historical, live);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].live, true);
  assert.equal(new Set(merged.map(r => r.id)).size, 3);
  assert.deepEqual(merged.slice(1), historical, 'historical records untouched');
  assert.equal(mergeLiveRecords(historical, []), historical);
});

test('the card note leads with the live count', () => {
  const live = normalizeLiveRows('tickets', [TICKET], { now: NOW });
  assert.equal(liveCardNote(live, '12 open'), '1 live · 12 open');
  assert.equal(liveCardNote([], '12 open'), '12 open');
  assert.equal(liveCardNote(live, null), '1 live');
});

test('enabled by ?live=, VITE_LIVE_DC, the DataConnect source, or dev', () => {
  assert.equal(liveDcEnabled({ search: '?live=1', env: {} }), true);
  assert.equal(liveDcEnabled({ search: '?live=0', env: { DEV: true, VITE_LIVE_DC: 'true' } }), false);
  assert.equal(liveDcEnabled({ search: '', env: { VITE_LIVE_DC: 'true' } }), true);
  assert.equal(liveDcEnabled({ search: '', env: { DEV: true, VITE_LIVE_DC: 'false' } }), false);
  assert.equal(liveDcEnabled({ search: '?data=dataconnect', env: {} }), true);
  assert.equal(liveDcEnabled({ search: '', env: { VITE_DATA_SOURCE: 'dataconnect' } }), true);
  assert.equal(liveDcEnabled({ search: '', env: { DEV: true } }), true);
  assert.equal(liveDcEnabled({ search: '', env: {} }), false);
});

function fakeFetch({ pageSize = 2 } = {}) {
  const byClass = {
    'SDNA Florida I595 Live Events': [EVENT_ACTIVE, EVENT_RECENTLY_CLEARED, EVENT_LONG_CLEARED],
    'SDNA Florida I595 Live Tickets': [TICKET], 'SDNA Florida I595 Live Tasks': [TASK],
    'SDNA Florida I595 Live Work Orders': [WORK_ORDER], 'SDNA Florida I595 Live Inspections': [INSPECTION],
    'SDNA Florida I595 Live Asset Status': [ASSET_STATUS],
  };
  const classes = Object.keys(byClass).map((className, i) => ({ id: `id${i}`, className }));
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url === '/api/live-dc/classes') return new Response(JSON.stringify({ classes }));
    const id = /\/class\/([^/]+)\/curated-data$/.exec(url)?.[1];
    const rows = byClass[classes.find(c => c.id === id)?.className] ?? [];
    const { page, filters = [], sort } = JSON.parse(options.body);
    const matching = serverSide(rows, filters, sort);
    return new Response(JSON.stringify({ data: matching.slice(page * pageSize, page * pageSize + pageSize), totalCount: matching.length }));
  };
  return { impl, calls };
}

/** What the curated-data endpoint (and server/liveDc/standin.mjs) does with `equals` filters and a sort. */
function serverSide(rows, filters, sort) {
  const value = (row, name) => row.attributes[name.replace(/^attributes\./, '')];
  const matching = rows.filter(row => filters.every(f => {
    assert.equal(f.operator, 'equals', 'only operators the stand-in supports');
    return String(value(row, f.field)) === String(f.value);
  }));
  if (!sort) return matching;
  const sign = sort.direction === 'desc' ? -1 : 1;
  return [...matching].sort((a, b) => sign * String(value(a, sort.field) ?? '').localeCompare(String(value(b, sort.field) ?? '')));
}

test('fetchLiveDc lists the classes once and pages through each one', async () => {
  const { impl, calls } = fakeFetch();
  const { byKey, errors } = await fetchLiveDc({ fetchImpl: impl, now: NOW, pageSize: 2 });
  assert.deepEqual(errors, {});
  assert.deepEqual(byKey.incidents.map(r => r.id), ['FL511-868702', 'FL511-900001']);
  assert.equal(byKey.tickets.length, 1);
  assert.equal(byKey.damagedAssets[0].id, 'AST-GR-0042');
  assert.equal(calls.filter(c => c.url === '/api/live-dc/classes').length, 1);
  assert.equal(calls.filter(c => c.url.endsWith('/curated-data')).length, 7, 'events took two pages');
  for (const call of calls) assert.ok(!call.options.headers?.authorization, 'the browser sends no token');
});

const EVENTS_ID = 'id0';
const eventBodies = calls => calls.filter(c => c.url === `/api/live-dc/class/${EVENTS_ID}/curated-data`).map(c => JSON.parse(c.options.body));

test('Live Events are filtered server-side: active, then cleared newest-first only back to the 6 h window', async () => {
  const longCleared = Array.from({ length: 20 }, (_, n) => wrap('SDNA Florida I595 Live Events', {
    ...EVENT_LONG_CLEARED.attributes, code: `FL511-7${n}`, cleared_at: new Date(NOW - CLEARED_WINDOW_MS - (n + 1) * 60_000).toISOString(),
  }));
  const { impl, calls } = fakeFetch({ pageSize: 2 });
  const withHistory = async (url, options) => {
    if (url !== `/api/live-dc/class/${EVENTS_ID}/curated-data`) return impl(url, options);
    calls.push({ url, options });
    const { page, filters, sort } = JSON.parse(options.body);
    const rows = serverSide([EVENT_ACTIVE, EVENT_RECENTLY_CLEARED, ...longCleared], filters, sort);
    return new Response(JSON.stringify({ data: rows.slice(page * 2, page * 2 + 2), totalCount: rows.length }));
  };
  const { byKey, errors } = await fetchLiveDc({ fetchImpl: withHistory, now: NOW, pageSize: 2 });
  assert.deepEqual(errors, {});
  assert.deepEqual(byKey.incidents.map(r => r.id), ['FL511-868702', 'FL511-900001']);
  const bodies = eventBodies(calls);
  assert.ok(bodies.every(body => body.filters.length > 0), 'Live Events is never read unfiltered');
  const active = bodies.filter(body => body.filters.some(f => f.value === 'active'));
  const cleared = bodies.filter(body => body.filters.some(f => f.value === 'cleared'));
  assert.equal(active.length, 1);
  assert.deepEqual(active[0].filters, [{ field: 'attributes.status', operator: 'equals', value: 'active' }]);
  assert.deepEqual(cleared[0].sort, { field: 'attributes.cleared_at', direction: 'desc' });
  assert.equal(cleared.length, 1, 'stops at the first page reaching past the window, not all 11 pages');
  const tickets = calls.filter(c => c.url === '/api/live-dc/class/id1/curated-data').map(c => JSON.parse(c.options.body));
  assert.deepEqual(tickets[0].filters, [], 'other classes are unchanged');
});

test('fetchLiveDc reports an unavailable service as an error for every key', async () => {
  const impl = async () => new Response(JSON.stringify({ error: 'Live DataConnect is unavailable.' }), { status: 503 });
  const { byKey, errors } = await fetchLiveDc({ fetchImpl: impl, now: NOW });
  assert.deepEqual(byKey, {});
  assert.deepEqual(Object.keys(errors).sort(), ['damagedAssets', 'incidents', 'inspections', 'tasks', 'tickets', 'workOrders']);
  assert.match(errors.incidents, /unavailable/);
});

test('an unreachable /api/live-dc is "not connected", with the reason; a later success reconnects', async () => {
  const down = async () => new Response(JSON.stringify({ error: 'Live DataConnect is unavailable.' }), { status: 503 });
  const failed = await fetchLiveDc({ fetchImpl: down, now: NOW });
  assert.equal(failed.unavailable, 'Live DataConnect is unavailable.');
  assert.deepEqual(liveDcConnection(failed), { connected: false, reason: 'Live DataConnect is unavailable.' });
  const offline = await fetchLiveDc({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); }, now: NOW });
  assert.deepEqual(liveDcConnection(offline), { connected: false, reason: 'Live DataConnect is unreachable.' });
  const recovered = await fetchLiveDc({ fetchImpl: fakeFetch().impl, now: NOW });
  assert.equal(recovered.unavailable, undefined);
  assert.deepEqual(liveDcConnection(recovered), { connected: true, reason: null });
});

test('liveDcConnection: unknown before the first read, connected while any class reads, not when none does', () => {
  assert.equal(liveDcConnection(null), null);
  assert.deepEqual(liveDcConnection({ byKey: { tickets: [] }, errors: { tasks: 'x not found' } }), { connected: true, reason: null });
  assert.deepEqual(liveDcConnection({ byKey: {}, errors: { tasks: 'SDNA Florida I595 Live Tasks not found' } }),
    { connected: false, reason: 'SDNA Florida I595 Live Tasks not found' });
});

test('a missing Live class is reported for its own key only', async () => {
  const { impl } = fakeFetch();
  const without = async (url, options) => {
    if (url === '/api/live-dc/classes') {
      const { classes } = await (await impl(url, options)).json();
      return new Response(JSON.stringify({ classes: classes.filter(c => c.className !== 'SDNA Florida I595 Live Tasks') }));
    }
    return impl(url, options);
  };
  const { byKey, errors } = await fetchLiveDc({ fetchImpl: without, now: NOW });
  assert.deepEqual(Object.keys(errors), ['tasks']);
  assert.equal(byKey.tickets.length, 1);
});

test('the feed refreshes on its interval and stops cleanly', async () => {
  const { impl } = fakeFetch();
  const updates = [];
  const timers = [];
  const feed = createLiveDcFeed({
    fetchImpl: impl, intervalMs: 60_000, onUpdate: result => updates.push(result), now: () => NOW,
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: id => { timers[id - 1].cleared = true; },
  });
  await feed.start();
  assert.equal(updates.length, 1);
  assert.equal(timers[0].ms, 60_000);
  await timers[0].fn();
  assert.equal(updates.length, 2);
  feed.stop();
  assert.equal(timers[0].cleared, true);
});

test('a throw in onUpdate on an interval tick goes to onError, never an unhandled rejection', async () => {
  const { impl } = fakeFetch();
  const timers = [], errors = [];
  let calls = 0;
  const feed = createLiveDcFeed({
    fetchImpl: impl, intervalMs: 60_000, now: () => NOW,
    onUpdate: () => { if (++calls > 1) throw new Error('render failed'); },
    onError: error => errors.push(error.message),
    setInterval: fn => { timers.push(fn); return 1; }, clearInterval() {},
  });
  await feed.start();
  await assert.doesNotReject(async () => timers[0]());
  assert.deepEqual(errors, ['render failed']);
  await timers[0]();
  assert.deepEqual(errors, ['render failed', 'render failed']);
  feed.stop();
});

test('the explorer shows live records as LIVE, with a Live filter and a damaged-asset type', () => {
  const [ticket] = normalizeLiveRows('tickets', [TICKET], { now: NOW });
  const asset = { id: ticket.id, assetType: 'ticket', source: ticket };
  assert.match(ASSET_TYPES.ticket.getCardStatus(asset).label, /^LIVE · Assigned/);
  assert.ok(detailRows(asset).some(([label, value]) => label === 'Source' && value === LIVE_SOURCE_LABEL));
  assert.ok(detailRows(asset).some(([label, value]) => label === 'FL511 event' && value === 'FL511-868702'));
  const historical = normalizeTicket({ 'Ticket ID': 'TIC-1', 'Ticket Status': 'Open' });
  const historicalAsset = { id: 'TIC-1', assetType: 'ticket', source: historical };
  assert.equal(ASSET_TYPES.ticket.getCardStatus(historicalAsset).label, 'Open', 'historical cards unchanged');
  assert.ok(!detailRows(historicalAsset).some(([label]) => label === 'Source'));
  const filters = maintenanceFilters([asset, historicalAsset]);
  const live = filters.find(f => f.id === 'live');
  assert.ok(live);
  assert.equal(live.match(asset), true);
  assert.equal(live.match(historicalAsset), false);
  assert.ok(!maintenanceFilters([historicalAsset]).some(f => f.id === 'live'));

  const [damaged] = normalizeLiveRows('damagedAssets', [ASSET_STATUS], { now: NOW });
  const config = assetTypeConfig('damagedAsset');
  assert.ok(config);
  assert.equal(config.layerId, null);
  const damagedAsset = { id: damaged.id, assetType: 'damagedAsset', source: damaged };
  assert.equal(config.getCardStatus(damagedAsset).tone, 'warn');
  const rows = Object.fromEntries(detailRows(damagedAsset));
  assert.equal(rows.Status, 'Damaged');
  assert.equal(rows.Inspection, 'INSP-FL511-868702');
  assert.equal(rows.Asset, 'GR-0042');

  const [event] = normalizeLiveRows('incidents', [EVENT_RECENTLY_CLEARED], { now: NOW });
  const eventRows = Object.fromEntries(detailRows({ id: event.id, assetType: 'incidentRecord', source: event }));
  assert.equal(eventRows.Status, 'Cleared');
  assert.ok(eventRows.Cleared);
});

function cappedFetch({ rows, cap, className = 'SDNA Florida I595 Live Tickets' }) {
  const classes = LIVE_DC_CLASSES.map((entry, i) => ({ id: `id${i}`, className: entry.className }));
  const calls = [];
  const impl = async (url, options = {}) => {
    if (url === '/api/live-dc/classes') return new Response(JSON.stringify({ classes }));
    const id = /\/class\/([^/]+)\/curated-data$/.exec(url)?.[1];
    const mine = classes.find(c => c.id === id)?.className === className ? rows : [];
    const { page, pageSize } = JSON.parse(options.body);
    const size = Math.min(pageSize, cap);
    if (mine.length) calls.push(page);
    return new Response(JSON.stringify({ data: mine.slice(page * size, page * size + size), totalCount: mine.length }));
  };
  return { impl, calls };
}
const ticketRows = n => Array.from({ length: n }, (_, i) => wrap('SDNA Florida I595 Live Tickets',
  { ...TICKET.attributes, code: `TIC-${i}`, 'Ticket ID': `TIC-${i}` }));

test('fetchLiveDc pages by totalCount when the server caps the page size below the one asked for', async () => {
  const { impl, calls } = cappedFetch({ rows: ticketRows(5), cap: 2 });
  const { byKey, errors } = await fetchLiveDc({ fetchImpl: impl, now: NOW, pageSize: 500 });
  assert.deepEqual(byKey.tickets.map(r => r.id), ['TIC-0', 'TIC-1', 'TIC-2', 'TIC-3', 'TIC-4']);
  assert.deepEqual(calls, [0, 1, 2]);
  assert.equal(errors.tickets, undefined);
});

test('fetchLiveDc keeps what it read but reports a class cut short by the page limit', async () => {
  const { impl } = cappedFetch({ rows: ticketRows(5), cap: 2 });
  const { byKey, errors } = await fetchLiveDc({ fetchImpl: impl, now: NOW, pageSize: 2, maxPages: 2 });
  assert.equal(byKey.tickets.length, 4);
  assert.match(errors.tickets, /4 of 5/);
});

test('a cleared live incident is not counted or filtered as open', () => {
  const incidents = normalizeLiveRows('incidents', [EVENT_ACTIVE, EVENT_RECENTLY_CLEARED], { now: NOW });
  assert.deepEqual(incidents.map(item => item.status), ['Active', 'Cleared']);
  const assets = incidents.map(item => ({ id: item.id, assetType: 'incidentRecord', source: item }));
  const open = maintenanceFilters(assets).find(filter => filter.id === 'open');
  assert.deepEqual(assets.filter(open.match).map(asset => asset.id), ['FL511-868702']);
});
