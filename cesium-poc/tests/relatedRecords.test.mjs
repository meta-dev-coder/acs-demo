/**
 * The cross-class joins behind the Related tab, and the calendar keys behind the date filter.
 *
 * Both are asserted against the committed export: the point of the join is that it finds what the
 * real sheets actually reference, and a fixture would only prove the code agrees with itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { normalizeAll } from '../src/maintenance/maintenanceRecords.js';
import { RELATED_ORDER, liveEventRelatedGroups, relatedRecordCount, relatedRecordGroups } from '../src/assetExplorer/relatedRecords.js';
import { currentDateWindow, incidentTypeFilters, maintenanceDate, maintenanceDateKey, maintenanceDateParts, todayKey } from '../src/assetExplorer/assetTypes.js';

const read = async name =>
  JSON.parse(await readFile(fileURLToPath(new URL(`../public/dataconnect-data/${name}.json`, import.meta.url)), 'utf8'));

const byType = {
  incidentRecord: normalizeAll('incidents', await read('incidents_v3')),
  ticket: normalizeAll('tickets', await read('tickets')),
  task: normalizeAll('tasks', await read('tasks')),
  workOrder: normalizeAll('workOrders', await read('work_orders')),
  inspection: normalizeAll('inspections', await read('roadway_inspections_v3')),
  damagedAsset: [],
};
const lookup = assetType => byType[assetType] ?? [];

test('a work order finds the ticket and task it names, and says it named them', () => {
  const order = byType.workOrder.find(item => item.related?.ticketId && item.related?.taskId
    && byType.ticket.some(ticket => ticket.id === item.related.ticketId));
  assert.ok(order, 'the export should carry a work order naming both');
  const groups = relatedRecordGroups(order, lookup);
  const ticket = groups.find(group => group.assetType === 'ticket');
  const named = ticket.items.find(entry => entry.record.id === order.related.ticketId);
  assert.ok(named, 'the named ticket is in the ticket group');
  assert.equal(named.named, true);
  assert.equal(named.reason, 'Names this ticket');
});

test('the reference is found from the other end too: a ticket sees the work orders that name it', () => {
  const order = byType.workOrder.find(item => item.related?.ticketId
    && byType.ticket.some(ticket => ticket.id === item.related.ticketId));
  const ticket = byType.ticket.find(item => item.id === order.related.ticketId);
  const groups = relatedRecordGroups(ticket, lookup);
  const entry = groups.find(group => group.assetType === 'workOrder').items.find(item => item.record.id === order.id);
  assert.ok(entry, 'the ticket must see the work order that names it');
  assert.equal(entry.named, true);
  assert.equal(entry.reason, 'Named by this work order');
});

test('an incident reaches the other classes through its damaged asset, labelled as exactly that', () => {
  const incident = byType.incidentRecord.find(item => item.assetId
    && byType.workOrder.some(order => order.assetId === item.assetId));
  assert.ok(incident, 'the export should carry an incident whose damaged asset has work orders');
  const groups = relatedRecordGroups(incident, lookup);
  assert.ok(relatedRecordCount(groups) > 0);
  const orders = groups.find(group => group.assetType === 'workOrder');
  assert.ok(orders.items.every(entry => entry.record.assetId === incident.assetId));
  // Said as an observation about the asset, never as causation.
  assert.match(orders.items[0].reason, /^Same asset · /);
  assert.equal(orders.items[0].named, false);
});

test('a record never relates to itself, however many joins reach it', () => {
  for (const assetType of ['incidentRecord', 'ticket', 'task', 'workOrder']) {
    const record = lookup(assetType).find(item => item.assetId);
    const groups = relatedRecordGroups(record, lookup);
    const self = groups.find(group => group.assetType === assetType)?.items
      .some(entry => entry.record.id === record.id);
    assert.ok(!self, `${assetType} ${record.id} listed itself`);
  }
});

test('groups come back in the order work moves through the classes, and never empty', () => {
  const incident = byType.incidentRecord.find(item => relatedRecordCount(relatedRecordGroups(item, lookup)) > 3);
  const groups = relatedRecordGroups(incident, lookup);
  const order = groups.map(group => group.assetType);
  assert.deepEqual(order, RELATED_ORDER.filter(type => order.includes(type)));
  assert.ok(groups.every(group => group.items.length > 0));
});

test('a named reference outranks a shared asset when both reach the same record', () => {
  // A work order that names a ticket standing on its own asset is reached by both joins.
  const order = byType.workOrder.find(item => item.related?.ticketId
    && byType.ticket.some(ticket => ticket.id === item.related.ticketId && ticket.assetId === item.assetId));
  if (!order) return;   // the export need not contain one; the rule is asserted only when it does
  const entry = relatedRecordGroups(order, lookup).find(group => group.assetType === 'ticket').items
    .find(item => item.record.id === order.related.ticketId);
  assert.equal(entry.named, true, 'the stronger reason must win');
});

test('a record with no lookup, or no relations at all, produces no groups rather than throwing', () => {
  assert.deepEqual(relatedRecordGroups(null, lookup), []);
  assert.deepEqual(relatedRecordGroups(byType.ticket[0], null), []);
  const orphan = { id: 'X-1', type: 'TICKET', assetId: null, related: {} };
  assert.deepEqual(relatedRecordGroups(orphan, lookup), []);
});

test('both date spellings become the same calendar key, and an unreadable one becomes none', () => {
  assert.equal(maintenanceDateKey('2024-05-27T00:00:00'), '2024-05-27');
  // Day-first, which `new Date` would read as 4 November — the bug the key must not reintroduce.
  assert.equal(maintenanceDateKey('11/04/2024'), '2024-04-11');
  assert.equal(maintenanceDateKey('4/11/2024'), '2024-11-04');
  assert.equal(maintenanceDateKey(null), null);
  assert.equal(maintenanceDateKey('sometime last spring'), null);
  assert.equal(maintenanceDateParts('32/01/2024'), null, 'an impossible day is not a date');
  // The key and the printed date must describe the same day.
  assert.equal(maintenanceDate('11/04/2024'), 'Apr 11, 2024');
});

test('every class in the export produces keys that sort as calendar dates', () => {
  for (const [assetType, records] of Object.entries(byType)) {
    const keys = records.map(item => maintenanceDateKey(item.createdDate)).filter(Boolean);
    if (!keys.length) continue;
    assert.ok(keys.every(key => /^\d{4}-\d{2}-\d{2}$/.test(key)), `${assetType} produced a malformed key`);
    const sorted = [...keys].sort();
    assert.ok(sorted[0] >= '2000-01-01' && sorted[sorted.length - 1] <= '2100-01-01', `${assetType} dates out of range`);
  }
});

test('the default window is this calendar month and the five before it, ending today', () => {
  assert.deepEqual(currentDateWindow({ today: new Date(2026, 8, 28) }), { from: '2026-04-01', to: '2026-09-28' });
  // Across a year boundary, and on the first day of a month.
  assert.deepEqual(currentDateWindow({ today: new Date(2026, 1, 1) }), { from: '2025-09-01', to: '2026-02-01' });
  assert.deepEqual(currentDateWindow({ today: new Date(2026, 0, 31) }), { from: '2025-08-01', to: '2026-01-31' });
  assert.deepEqual(currentDateWindow({ months: 1, today: new Date(2026, 8, 28) }), { from: '2026-09-01', to: '2026-09-28' });
});

test('the window never reaches past today, so a record dated later is not shown as history', () => {
  const window = currentDateWindow({ today: new Date(2026, 8, 28) });
  assert.equal(window.to, '2026-09-28');
  assert.ok('2026-09-29' > window.to, 'tomorrow is outside the window');
  assert.ok('2026-12-01' > window.to, 'and so is a record dated months ahead');
  assert.equal(todayKey(new Date(2026, 8, 28)), '2026-09-28');
});

test('a record is in the window only when its own key falls inside it', () => {
  const inside = (key, window) => Boolean(key) && key >= window.from && key <= window.to;
  const window = currentDateWindow({ today: new Date(2026, 8, 28) });
  assert.equal(inside('2026-04-01', window), true, 'the first day of the earliest month is in');
  assert.equal(inside('2026-03-31', window), false, 'the day before it is out');
  assert.equal(inside('2026-09-28', window), true, 'today is in');
  assert.equal(inside('2026-09-29', window), false, 'tomorrow is out');
  assert.equal(inside(null, window), false, 'a record with no readable date is outside every window');
});

test('the type dropdown lists every type but counts only what the other filters leave on screen', () => {
  const asset = (id, title, date) => ({ id, assetType: 'incidentRecord', source: { title, createdDate: date } });
  const all = [
    asset('A', 'Vehicle fire', '2026-05-02T00:00:00'),
    asset('B', 'Vehicle fire', '2026-05-09T00:00:00'),
    asset('C', 'Rear-end crash', '2026-05-11T00:00:00'),
    asset('D', 'Guardrail strike', '2024-01-04T00:00:00'),
  ];
  const inRange = all.filter(item => maintenanceDateKey(item.source.createdDate) >= '2026-04-01');
  const filters = incidentTypeFilters(all, inRange);

  // Every type the class carries is still offered — the taxonomy does not shrink with the range.
  assert.deepEqual([...filters].map(entry => entry.label).sort(),
    ['Guardrail strike', 'Rear-end crash', 'Vehicle fire']);
  const count = label => filters.find(entry => entry.label === label).count;
  assert.equal(count('Vehicle fire'), 2);
  assert.equal(count('Rear-end crash'), 1);
  // Out of range entirely: listed, and honestly zero.
  assert.equal(count('Guardrail strike'), 0);
  // Ordered by what is actually on screen, so the common ones stay reachable first.
  assert.deepEqual(filters.map(entry => entry.label), ['Vehicle fire', 'Rear-end crash', 'Guardrail strike']);
  // The match itself is unaffected by the counting set.
  assert.equal(filters.find(entry => entry.label === 'Guardrail strike').match(all[3]), true);
});

test('with no counting set given, a value filter counts the records it was built from', () => {
  const asset = (id, title) => ({ id, source: { title } });
  const filters = incidentTypeFilters([asset('A', 'Vehicle fire'), asset('B', 'Vehicle fire')]);
  assert.equal(filters[0].count, 2);
});

/**
 * The live DataConnect chain, with the record shapes this instance actually produces: a road event,
 * the ticket raised for it, its three tasks, the work order, the inspection and the damaged asset.
 * Every one of them carries the event key in `source_event_id` (normalised to `related.eventId`);
 * the event itself IS that key. Ids and fields are copied from a live read, not invented.
 */
const liveChain = () => {
  const event = { id: 'FL511-999003', sourceId: 'FL511-999003', type: 'INCIDENT', live: true,
    title: 'Crash', status: 'Cleared', assetId: null, createdDate: '2026-09-27T20:10:00',
    related: { fl511ItemId: '999003', eventType: 'INCIDENT' } };
  const of = (id, type, extra = {}) => ({ id, sourceId: id, type, live: true, assetId: null,
    related: { eventId: 'FL511-999003' }, ...extra });
  return {
    incidentRecord: [event, { id: 'INC-200022', type: 'INCIDENT', assetId: '182', related: {} }],
    ticket: [of('TIC-FL511-999003', 'TICKET', { title: 'Crash - Crash', assetId: 'H63571',
      related: { eventId: 'FL511-999003' } })],
    task: ['01', '02', '03'].map((n, i) => of(`TSK-FL511-999003-${n}`, 'TASK', {
      title: ['Dispatch Field Crew', 'Temporary Mitigation', 'Inspect and Verify'][i],
      related: { eventId: 'FL511-999003', ticketId: 'TIC-FL511-999003' },
    })),
    workOrder: [of('WO-FL511-999003', 'WORK_ORDER', {
      related: { eventId: 'FL511-999003', ticketId: 'TIC-FL511-999003' } })],
    inspection: [of('INSP-FL511-999003', 'INSPECTION', { title: 'Live Post-Incident Inspection', status: 'Fail', assetId: 'H63571' })],
    damagedAsset: [of('AST-H63571', 'ASSET_STATUS', { title: 'Attenuetors', assetId: 'H63571' })],
  };
};

test('the whole live chain is visible from its ticket — event, tasks, work order, inspection, damaged asset', () => {
  const chain = liveChain();
  const look = assetType => chain[assetType] ?? [];
  const ticket = chain.ticket[0];
  const groups = Object.fromEntries(relatedRecordGroups(ticket, look)
    .map(group => [group.assetType, group.items.map(entry => entry.record.id)]));

  assert.deepEqual(groups.incidentRecord, ['FL511-999003'], 'the road event it was raised for');
  assert.deepEqual([...groups.task].sort(), ['TSK-FL511-999003-01', 'TSK-FL511-999003-02', 'TSK-FL511-999003-03']);
  assert.deepEqual(groups.workOrder, ['WO-FL511-999003']);
  // These two name the event, not the ticket — the links that were missing before.
  assert.deepEqual(groups.inspection, ['INSP-FL511-999003']);
  assert.deepEqual(groups.damagedAsset, ['AST-H63571']);
  assert.equal(relatedRecordCount(relatedRecordGroups(ticket, look)), 7);
});

test('every member of a chain sees the whole of it, whichever one is opened', () => {
  const chain = liveChain();
  const look = assetType => chain[assetType] ?? [];
  const all = ['FL511-999003', 'TIC-FL511-999003', 'TSK-FL511-999003-01', 'TSK-FL511-999003-02',
    'TSK-FL511-999003-03', 'WO-FL511-999003', 'INSP-FL511-999003', 'AST-H63571'];
  for (const assetType of ['incidentRecord', 'ticket', 'task', 'workOrder', 'inspection', 'damagedAsset']) {
    const record = look(assetType).find(item => item.related?.eventId === 'FL511-999003' || item.id === 'FL511-999003');
    const seen = relatedRecordGroups(record, look).flatMap(group => group.items.map(entry => entry.record.id));
    assert.deepEqual([...seen, record.id].sort(), [...all].sort(), `${record.id} must see the whole chain`);
  }
});

test('a chain link is reported as the identifier column it is, never as a shared asset', () => {
  const chain = liveChain();
  const look = assetType => chain[assetType] ?? [];
  const entries = relatedRecordGroups(chain.ticket[0], look).flatMap(group => group.items);
  assert.ok(entries.every(entry => entry.named), 'every chain link is a named reference');
  const reasons = new Set(entries.map(entry => entry.reason));
  assert.ok(reasons.has('Raised for this incident'), 'the event says what it is');
  assert.ok([...reasons].some(reason => reason.startsWith('Same road event · FL511-999003')));
  assert.ok(![...reasons].some(reason => reason.startsWith('Same asset')), 'the stronger reason wins');
});

test('a historical incident is not chained to anything by its own id', () => {
  const chain = liveChain();
  const look = assetType => chain[assetType] ?? [];
  const historical = chain.incidentRecord[1];
  const seen = relatedRecordGroups(historical, look).flatMap(group => group.items.map(entry => entry.record.id));
  // It shares asset 182 with nothing here, and no live record names INC-200022 as its event.
  assert.deepEqual(seen, []);
});

test('an FL511 live event reaches the register through its own item id', () => {
  const chain = liveChain();
  const look = assetType => chain[assetType] ?? [];
  const event = { id: 'FL511-INCIDENT-999003', rawSourceId: '999003', type: 'INCIDENT' };
  const groups = liveEventRelatedGroups(event, look);
  const byType = Object.fromEntries(groups.map(group => [group.assetType, group.items.map(entry => entry.record.id)]));
  assert.deepEqual(byType.incidentRecord, ['FL511-999003'], 'the register row for this event leads');
  assert.equal(groups.find(group => group.assetType === 'incidentRecord').items[0].reason, 'This event in the register');
  assert.deepEqual(byType.damagedAsset, ['AST-H63571']);
  assert.deepEqual(byType.inspection, ['INSP-FL511-999003']);
  assert.equal(relatedRecordCount(groups), 8, 'the event plus the seven records raised for it');
  // An event the register has never heard of gets nothing rather than a guess.
  assert.deepEqual(liveEventRelatedGroups({ id: 'FL511-CLOSURE-1', rawSourceId: '1' }, look), []);
});
