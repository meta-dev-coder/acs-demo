/**
 * The Maintenance workspace's Live DataConnect wiring: polled only while shown, redrawn on any
 * change to what a card shows, and never left badged LIVE while a card is not ready.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  liveBadge, liveFeedControl, liveOnlyCard, liveRedrawNeeded, liveSignature, maintenanceSourceNote, mergeLiveEntry, nextLiveSnapshot,
  shownRecords,
} from '../src/maintenance/maintenanceWorkspace.js';

const base = { id: 'TIC-1', status: 'Open', latitude: 26.1, longitude: -80.2, description: 'a', priority: 'Low', closedDate: null, live: true };

test('the live signature changes with any rendered field, not just id, status and latitude', () => {
  const before = liveSignature([base]);
  for (const change of [{ description: 'b' }, { priority: 'High' }, { closedDate: '2026-09-25' }, { longitude: -80.3 }]) {
    assert.notEqual(liveSignature([{ ...base, ...change }]), before, JSON.stringify(change));
  }
  assert.equal(liveSignature([{ ...base }]), before);
  assert.notEqual(liveSignature([base], 'Live feed unavailable'), before);
});

test('a card that is not ready is never badged live', () => {
  const records = [base];
  assert.equal(liveBadge({ state: 'ready', records }), 'true');
  assert.equal(liveBadge({ state: 'ready', records: [{ ...base, live: false }] }), 'false');
  assert.equal(liveBadge({ state: 'loading', records }), 'false');
  assert.equal(liveBadge({ state: 'error', records }), 'false');
});

test('the live feed polls only while the workspace is shown', async () => {
  const log = [];
  const feed = { start: async () => { log.push('start'); }, stop: () => log.push('stop') };
  const control = liveFeedControl(feed);
  assert.deepEqual(log, [], 'installing does not poll');
  await control.show();
  control.hide();
  await control.show();
  assert.deepEqual(log, ['start', 'stop', 'start']);
  const failing = liveFeedControl({ start: () => Promise.reject(new Error('down')), stop() {} }, { onError: error => log.push(error.message) });
  await failing.show();
  assert.equal(log.at(-1), 'down');
  assert.doesNotThrow(() => liveFeedControl(null).hide());
});

test('the Damaged (live) card: loading, connected, not connected with a warning, then recovered', () => {
  const records = [base];
  assert.deepEqual(liveOnlyCard({ connection: null }), { state: 'loading', note: null });
  assert.deepEqual(liveOnlyCard({ records, connection: { connected: true, reason: null } }), { state: 'ready', note: null });
  const down = { connected: false, reason: 'Live DataConnect is unavailable.' };
  assert.deepEqual(liveOnlyCard({ records, error: 'x', connection: down }),
    { state: 'error', note: 'DataConnect not connected', warning: true, title: 'Live DataConnect is unavailable.' },
    'cached records never stand in for a connection that is gone');
  assert.deepEqual(liveOnlyCard({ records, connection: { connected: true, reason: null } }), { state: 'ready', note: null });
  assert.deepEqual(liveOnlyCard({ error: 'Read 2 of 4 rows', connection: { connected: true, reason: null } }),
    { state: 'error', note: 'Live feed unavailable', title: 'Read 2 of 4 rows' });
});

test('the Maintenance source label warns while Live DataConnect is not connected', () => {
  const connected = { connected: true, reason: null };
  assert.deepEqual(maintenanceSourceNote({ base: 'DataConnect export', live: false, liveShown: true, connection: connected }),
    { text: 'DataConnect export + Live DataConnect', live: true });
  assert.deepEqual(maintenanceSourceNote({ base: 'DataConnect export', live: false, liveShown: false, connection: null }),
    { text: 'DataConnect export', live: false });
  assert.deepEqual(maintenanceSourceNote({ base: 'DataConnect export', live: false, liveShown: true, connection: { connected: false, reason: 'down' } }),
    { text: 'DataConnect export · DataConnect not connected', live: false, warning: true, title: 'down' });
});

test('the live signature changes when the connection does', () => {
  assert.notEqual(liveSignature([base], null, { connected: false }), liveSignature([base], null, { connected: true }));
});

test('a disconnect drops every live record (cards, map, search); historical stay; recovery restores them', () => {
  const historical = { ...base, id: 'TIC-9', live: false };
  const liveTicket = { ...base, id: 'TIC-FL511-1' };
  const damaged = { ...base, id: 'AST-1', type: 'ASSET_STATUS' };
  const up = { byKey: { tickets: [liveTicket], damagedAssets: [damaged] }, errors: {} };
  const down = { byKey: {}, errors: { tickets: 'Live DataConnect is unavailable.', damagedAssets: 'Live DataConnect is unavailable.' },
    unavailable: 'Live DataConnect is unavailable.' };

  let snapshot = nextLiveSnapshot({ byKey: {}, errors: {} }, up);
  assert.equal(snapshot.connection.connected, true);
  const ticketEntry = { state: 'ready', historical: [historical] };
  const damagedEntry = { state: 'loading', historical: [] };
  const merge = (entry, key, liveOnly) => Object.assign(entry, mergeLiveEntry(entry, key, {
    live: snapshot.live, connection: snapshot.connection, liveOnly }));
  merge(ticketEntry, 'tickets', false);
  merge(damagedEntry, 'damagedAssets', true);
  assert.deepEqual(shownRecords(ticketEntry).map(r => r.id), ['TIC-FL511-1', 'TIC-9']);
  assert.equal(damagedEntry.state, 'ready');
  assert.deepEqual(shownRecords(damagedEntry).map(r => r.id), ['AST-1']);

  // A class that failed while still connected keeps its last good records.
  const partial = nextLiveSnapshot(snapshot.live, { byKey: { damagedAssets: [damaged] }, errors: { tickets: 'x' } });
  assert.deepEqual(partial.live.byKey.tickets, [liveTicket]);

  snapshot = nextLiveSnapshot(snapshot.live, down);
  assert.equal(snapshot.connection.connected, false);
  assert.deepEqual(snapshot.live.byKey, {}, 'no live record survives a disconnect');
  merge(ticketEntry, 'tickets', false);
  merge(damagedEntry, 'damagedAssets', true);
  assert.deepEqual(shownRecords(ticketEntry).map(r => r.id), ['TIC-9'], 'historical records stay');
  assert.equal(damagedEntry.state, 'error');
  assert.equal(damagedEntry.note, 'DataConnect not connected');
  assert.deepEqual(shownRecords(damagedEntry), [], 'the map gets no stale damaged assets');
  assert.equal(liveRedrawNeeded(damagedEntry), true, 'an errored live card still redraws, clearing the map');
  assert.equal(liveRedrawNeeded({ state: 'loading' }), false);

  snapshot = nextLiveSnapshot(snapshot.live, up);
  merge(ticketEntry, 'tickets', false);
  merge(damagedEntry, 'damagedAssets', true);
  assert.deepEqual(shownRecords(ticketEntry).map(r => r.id), ['TIC-FL511-1', 'TIC-9']);
  assert.equal(damagedEntry.state, 'ready');
  assert.deepEqual(shownRecords(damagedEntry).map(r => r.id), ['AST-1']);
});
