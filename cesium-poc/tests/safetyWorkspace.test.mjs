import test from 'node:test';
import assert from 'node:assert/strict';
import { SAFETY_CARDS, TRAFFIC_CARDS, safetyCard, sourceNote } from '../src/safetyWorkspace.js';

const [incidents] = SAFETY_CARDS;
const [closures, construction] = TRAFFIC_CARDS;

test('the cards name the layers that already draw them, split by what an operator is doing', () => {
  // Safety is what is happening TO the corridor; Traffic is the planned work restricting it.
  assert.deepEqual(SAFETY_CARDS.map(card => [card.key, card.label, card.layerId, card.type]), [
    ['incidents', 'Active incidents', 'incidents', 'INCIDENT'],
  ]);
  assert.deepEqual(TRAFFIC_CARDS.map(card => [card.key, card.label, card.layerId, card.type]), [
    ['closures', 'Lane closures', 'closures', 'CLOSURE'],
    ['construction', 'Construction', 'construction', 'CONSTRUCTION'],
  ]);
  // One feed, one card each: no layer is driven from two workspaces at once.
  const all = [...SAFETY_CARDS, ...TRAFFIC_CARDS].map(card => card.layerId);
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
