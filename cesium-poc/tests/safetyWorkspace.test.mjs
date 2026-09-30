import test from 'node:test';
import assert from 'node:assert/strict';
import * as safetyWorkspace from '../src/safetyWorkspace.js';
import { SAFETY_CARDS, TRAFFIC_CARDS, maintenanceCard, safetyCard } from '../src/safetyWorkspace.js';
import { liveEventSourceNote as sourceNote } from '../src/liveEventsData.js';

const [incidents] = SAFETY_CARDS;
const [closures, construction] = TRAFFIC_CARDS;

test('the cards name the layers that already draw them, split by what an operator is doing', () => {
  // Safety is what is happening TO the corridor; Traffic is the planned work restricting it.
  assert.deepEqual(SAFETY_CARDS.map(card => [card.key, card.label, card.layerId ?? card.assetType, card.type ?? card.source]), [
    ['incidents', 'Active incidents', 'incidents', 'INCIDENT'],
    ['disabledVehicles', 'Disabled vehicles', 'disabled-vehicles', 'DISABLED'],
    // Not a live event: the recorded crash history, from DataConnect, drawn by the Maintenance
    // workspace. It sits on Safety because it answers a safety question.
    ['crashes', 'Recorded crashes', 'incidentRecord', 'maintenance'],
  ]);
  assert.deepEqual(TRAFFIC_CARDS.map(card => [card.key, card.label, card.layerId, card.type]), [
    ['closures', 'Lane closures', 'closures', 'CLOSURE'],
    ['construction', 'Construction', 'construction', 'CONSTRUCTION'],
    ['congestion', 'Congestion', 'congestion', 'CONGESTION'],
  ]);
  // One feed, one card each: no layer is driven from two workspaces at once.
  const all = [...SAFETY_CARDS, ...TRAFFIC_CARDS].map(card => card.layerId).filter(Boolean);
  assert.equal(new Set(all).size, all.length);
});

test('counts come from the events themselves, by type', () => {
  const events = [
    { type: 'INCIDENT', severity: 'Major' }, { type: 'INCIDENT', severity: 'Minor' },
    { type: 'CLOSURE' }, { type: 'CLOSURE' }, { type: 'CLOSURE' },
  ];
  assert.deepEqual(safetyCard(events, incidents, {}), { state: 'ready', count: 2, note: '1 major' });
  assert.equal(safetyCard(events, closures, {}).count, 3);
});

test('nothing on the corridor is an answer, not a blank or an error', () => {
  assert.deepEqual(safetyCard([], incidents, {}), { state: 'ready', count: 0, note: 'None on the corridor now' });
  assert.deepEqual(safetyCard(undefined, closures, {}), { state: 'ready', count: 0, note: 'None on the corridor now' });
});

test('with no severity published, the note says when the feed last spoke', () => {
  const events = [{ type: 'CLOSURE' }];
  const card = safetyCard(events, closures, { lastUpdated: '2026-09-23T18:42:00Z' });
  assert.equal(card.count, 1);
  assert.match(card.note, /^Updated \d{1,2}:\d{2}/);
  assert.equal(safetyCard(events, closures, {}).note, 'On I-595 now');
});

test('the source is only called live when the feed says it is', () => {
  assert.deepEqual(sourceNote({ source: 'FL511', sourceStatus: 'LIVE' }), { text: 'FL511 · live', live: true });
  assert.deepEqual(sourceNote({ source: 'FL511', sourceStatus: 'STALE' }), { text: 'FL511 · stale', live: false });
  assert.deepEqual(sourceNote({}), { text: 'FL511', live: false });
  assert.equal(safetyWorkspace.sourceNote, undefined, 'the strips use liveEventSourceNote directly, no wrapper');
});

test('construction is a card of its own, counted from the same feed', () => {
  const card = TRAFFIC_CARDS.find(item => item.key === 'construction');
  assert.ok(card, 'Construction has a KPI card');
  assert.equal(card.type, 'CONSTRUCTION');
  assert.equal(card.layerId, 'construction', 'it drives its own Map Explorer layer');

  const events = [
    { type: 'CONSTRUCTION', severity: 'Major' },
    { type: 'CONSTRUCTION' },
    { type: 'CLOSURE', severity: 'Major' },
  ];
  // Planned roadwork reports freshness, not severity: FL511 marks whole work zones "Major" and
  // "1 major" would read as an emergency rather than as scheduled work.
  // The time is rendered in the viewer's own zone, so the shape is asserted, not a fixed clock.
  const roadwork = safetyCard(events, card, { lastUpdated: '2026-09-24T14:07:00Z' });
  assert.equal(roadwork.count, 2);
  assert.equal(roadwork.state, 'ready');
  assert.match(roadwork.note, /^Updated \d{1,2}:\d{2} (AM|PM)$/, 'roadwork reports freshness, not severity');
  // Incidents and closures keep the severity note.
  assert.equal(safetyCard(events, TRAFFIC_CARDS.find(c => c.key === 'closures'), {}).note, '1 major');
  // Nothing on the corridor still says so rather than showing a bare zero.
  assert.deepEqual(safetyCard([], card, {}), { state: 'ready', count: 0, note: 'None on the corridor now' });
});

test('the crash card counts a DataConnect class, and says how many were harmful', () => {
  const card = SAFETY_CARDS.find(item => item.key === 'crashes');
  const records = [
    { related: { injuries: 'Yes', fatalities: 1 } },
    { related: { injuries: 'Yes', fatalities: 0 } },
    { related: { injuries: 'No', fatalities: 0 } },
  ];
  const maintenance = { recordsForType: type => (type === 'incidentRecord' ? records : []) };
  assert.deepEqual(maintenanceCard(maintenance, card),
    { state: 'ready', count: 3, note: '2 with injuries · 1 fatal' });

  // No fatalities is worth saying plainly rather than printing "0 fatal".
  assert.equal(maintenanceCard({ recordsForType: () => [{ related: { injuries: 'Yes' } }] }, card).note, '1 with injuries');
  assert.equal(maintenanceCard({ recordsForType: () => [{ related: {} }] }, card).note, 'None with injuries');

  // A class that has not loaded says nothing rather than a zero it cannot vouch for.
  assert.deepEqual(maintenanceCard({ recordsForType: () => [] }, card), { state: 'loading' });
  assert.deepEqual(maintenanceCard(null, card), { state: 'loading' });
});

test('the crash card counts and reveals the register AND what is being reported now', async () => {
  const { safetyMaintenance } = await import('../src/safetyWorkspace.js');
  const { shownRecords } = await import('../src/maintenance/maintenanceWorkspace.js');
  const historical = [{ id: 'CR-1' }, { id: 'CR-2' }];
  // Two live rows: a crash, and one of the FL511 closures that has no business on a crash map.
  const liveCrash = { id: 'FL511-1', live: true, related: { eventType: 'INCIDENT' } };
  const liveClosure = { id: 'FL511-CLOSE', live: true, title: 'Closure', related: { eventType: 'CLOSURE' } };
  const entry = { state: 'ready', historical, records: [liveCrash, liveClosure, ...historical] };
  const calls = [];
  const narrowed = [];
  const workspace = {
    recordsForType: (type, options) => shownRecords(entry, options),
    reveal: (type, options) => { calls.push(options); return shownRecords(entry, options); },
    showOnly: (type, records) => { narrowed.push(records.map(r => r.id)); return true; },
    hide() {}, preload: () => Promise.resolve(),
  };
  const deps = safetyMaintenance(() => workspace);
  const [crashes] = SAFETY_CARDS.filter(card => card.source === 'maintenance');
  const shown = await deps.reveal(crashes.assetType);
  // The card counts the CRASHES, which is no longer the whole class the workspace reveals.
  assert.equal(maintenanceCard(deps, crashes).count, deps.recordsForType(crashes.assetType).length);
  assert.deepEqual(calls, [{ live: true }], 'Safety asks for the live records too, not the register alone');
  assert.equal(shown.length, 4, 'the workspace reveals the whole class');
  // ...but what Safety counts, draws and lists is the crashes within it: the closure is dropped.
  const counted = deps.recordsForType(crashes.assetType).map(record => record.id);
  assert.deepEqual(counted, ['FL511-1', 'CR-1', 'CR-2'], 'a live crash is in, a live closure is out');
  assert.deepEqual(narrowed, [counted], 'the bottom list is narrowed to exactly what the card counts');
  assert.equal(safetyMaintenance(() => null).recordsForType('incidentRecord').length, 0);
});
