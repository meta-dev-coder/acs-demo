import test from 'node:test';
import assert from 'node:assert/strict';
import { CLEARED_CARD, STRIP_CARDS, LIVE_OPS_CARDS, liveOpsCard } from '../src/liveOps/liveOpsWorkspace.js';
import { clearedAtLabel } from '../src/liveEventsData.js';
import { assetTypeConfig } from '../src/assetExplorer/assetTypes.js';

const ev = (id, type, cleared, clearedAt) => ({ id, type, ...(cleared ? { cleared: true, clearedAt } : {}) });
const events = [
  ev('a', 'CLOSURE', false),
  ev('disabled', 'DISABLED', false),
  ev('b', 'CLOSURE', true, '2026-09-28T22:08:32.437Z'),
  ev('c', 'CONGESTION', true, '2026-09-28T13:45:09.411Z'),
  ev('d', 'INCIDENT', true, '2026-09-28T03:34:54.463Z'),
];

test('cleared events are browsable by the day they cleared, in corridor time', () => {
  const config = assetTypeConfig('clearedEvent');
  assert.equal(config.dateLabel, 'Cleared');
  // 22:08 UTC is still the 28th on I-595; keyed from UTC it would file under the 29th and fall out
  // of a range that should hold it.
  assert.equal(config.getDateKey({ source: { clearedAt: '2026-09-28T22:08:32.437Z' } }), '2026-09-28');
  assert.equal(config.getDateKey({ source: { clearedAt: '2026-09-29T02:00:00.000Z' } }), '2026-09-28');
  // No readable stamp is OUT of every range, never silently inside one.
  assert.equal(config.getDateKey({ source: {} }), null);
});

test('the cleared card opens the clearedEvent explorer type, which owns no map layer', () => {
  assert.equal(CLEARED_CARD.assetType, 'clearedEvent');
  const config = assetTypeConfig('clearedEvent');
  assert.equal(config.label, 'Cleared Events');
  // Cleared events have no layer of their own: Live Ops swaps the live-event layer into cleared
  // mode instead, so there is nothing here for the explorer to switch on.
  assert.equal(config.layerId, null);
});

test('the Event type dropdown counts each kind and is one grouped filter', () => {
  const config = assetTypeConfig('clearedEvent');
  const assets = events.filter(e => e.cleared).map(e => ({ name: e.id, source: e }));
  const filters = config.getFilters(assets);
  assert.ok(filters.every(f => f.group === 'Event type'), 'every filter is in one group, so it renders as a dropdown');
  assert.deepEqual(filters.map(f => [f.label, f.count]).sort(), [['Closure', 1], ['Congestion', 1], ['Incident', 1]]);
  // A filter must actually select its own kind.
  const closures = filters.find(f => f.label === 'Closure');
  assert.deepEqual(assets.filter(closures.match).map(a => a.name), ['b']);
});

test('a cleared card states which kind it was, since the list mixes all five', () => {
  const config = assetTypeConfig('clearedEvent');
  const closure = events.find(event => event.id === 'b');
  assert.match(config.getSubtitle({ name: 'b', source: closure }), /Closure/);
  // The chip carries severity; the cleared time is the card's date, so neither repeats the other.
  assert.equal(config.getStatus({ source: { ...closure, severity: 'Minor' } }).label, 'Minor');
  assert.equal(config.getCardDate({ source: closure }), 'Sep 28, 6:08 PM EDT');
});

test('live cards never count a cleared event and Incidents includes disabled vehicles', () => {
  const closures = LIVE_OPS_CARDS.find(c => c.key === 'closures');
  // one live closure + one cleared closure -> the card shows 1
  assert.equal(liveOpsCard(events, closures).count, 1);
  const incidents = LIVE_OPS_CARDS.find(c => c.key === 'incidents');
  assert.equal(liveOpsCard(events, incidents).count, 1);
  assert.equal(liveOpsCard(events, incidents).note, '1 disabled');
});

test('the strip folds Disabled into Incidents and ends with Cleared', () => {
  assert.equal(STRIP_CARDS.length, LIVE_OPS_CARDS.length);
  assert.ok(!STRIP_CARDS.some(card => card.key === 'disabledVehicles'));
  assert.equal(STRIP_CARDS.at(-1).key, CLEARED_CARD.key);
  assert.equal(CLEARED_CARD.type, undefined, 'the cleared card must carry no event type');
});

test('clearedAtLabel reports CORRIDOR time, not the machine\'s, and refuses junk', () => {
  // 22:08 UTC is 6:08 PM in Florida. Asserted absolutely so a machine in any timezone — which is
  // exactly how this demo gets run — still proves the corridor convention holds.
  assert.equal(clearedAtLabel({ clearedAt: '2026-09-28T22:08:32.437Z' }), 'Sep 28, 6:08 PM EDT');
  assert.equal(clearedAtLabel({}), null);
  assert.equal(clearedAtLabel({ clearedAt: 'not a date' }), null);
});
