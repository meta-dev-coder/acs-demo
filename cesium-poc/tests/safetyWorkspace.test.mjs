import test from 'node:test';
import assert from 'node:assert/strict';
import { SAFETY_CARDS, safetyCard, sourceNote } from '../src/safetyWorkspace.js';

const [incidents, closures] = SAFETY_CARDS;

test('the two cards name the layers that already draw them', () => {
  assert.deepEqual(SAFETY_CARDS.map(card => [card.key, card.label, card.layerId, card.type]), [
    ['incidents', 'Active incidents', 'incidents', 'INCIDENT'],
    ['closures', 'Lane closures', 'closures', 'CLOSURE'],
  ]);
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
