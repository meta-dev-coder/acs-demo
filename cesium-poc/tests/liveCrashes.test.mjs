/**
 * The feed's crashes, as the safety picture counts them.
 *
 * Safety reads two sources: the DataConnect incident register, and the FL511 feed. An incident that
 * happened this week is in the feed — cleared — long before it reaches the register, so a screen
 * that reads only the register is empty of exactly the events it exists to show.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { crashesFromLiveEvents, liveCrashTier, mergeCrashSources } from '../src/safety/liveCrashes.js';
import { crashSeverityTier } from '../src/assetExplorer/incidentTypes.js';

/** The four the corridor was actually carrying, as the feed published them. */
const FEED = [
  { id: 'FL511-INCIDENT-879720', type: 'INCIDENT', title: 'Incident', severity: 'Minor',
    longitude: -80.329417, latitude: 26.118889, cleared: true, startTime: 'Sep 29 2026, 4:25 PM' },
  { id: 'FL511-INCIDENT-879514', type: 'INCIDENT', title: 'Incident', severity: 'Intermediate',
    longitude: -80.31, latitude: 26.11, cleared: true, startTime: 'Sep 29 2026, 2:41 PM' },
  { id: 'FL511-INCIDENT-999003', type: 'INCIDENT', title: 'Crash', severity: 'Major',
    longitude: -80.25, latitude: 26.07, cleared: true, startTime: 'Sep 27 2026, 11:34 PM' },
  { id: 'FL511-880124', type: 'CLOSURE', title: 'Closure', severity: 'Major',
    longitude: -80.2, latitude: 26.06, cleared: false },
];

test('only the crashes come through, cleared ones included', () => {
  const crashes = crashesFromLiveEvents(FEED);
  assert.deepEqual(crashes.map(crash => crash.id),
    ['FL511-INCIDENT-879720', 'FL511-INCIDENT-879514', 'FL511-INCIDENT-999003']);
  // A cleared crash still happened there: the question is where the corridor hurts people, not
  // what is blocking it this minute.
  assert.ok(crashes.every(crash => crash.cleared));
  assert.ok(!crashes.some(crash => crash.id === 'FL511-880124'), 'a closure is not a crash');
});

test('an event with no coordinates is dropped, never placed at (0,0)', () => {
  assert.deepEqual(crashesFromLiveEvents([{ id: 'x', type: 'INCIDENT', title: 'Incident' }]), []);
  assert.deepEqual(crashesFromLiveEvents(null), []);
});

test('the feed keeps the severity it published instead of being flattened to minor', () => {
  // The feed carries no injury or fatality columns, so the register's grading rule cannot read it;
  // without the carried tier every live crash would score as the mildest thing on the map.
  const [minor, intermediate, major] = crashesFromLiveEvents(FEED);
  assert.deepEqual([minor, intermediate, major].map(crashSeverityTier), ['minor', 'intermediate', 'high']);
  assert.equal(liveCrashTier('Major'), 'high');
  assert.equal(liveCrashTier('minor'), 'minor');
  assert.equal(liveCrashTier('anything else'), 'minor', 'an unknown word makes the mildest claim');
  // `severe` means a death, and the feed never says so.
  assert.ok(!Object.values({ ...FEED }).some(() => liveCrashTier('Major') === 'severe'));
});

test('a crash is dated when it was reported, not when it cleared', () => {
  const [first] = crashesFromLiveEvents(FEED);
  assert.equal(first.createdDate, 'Sep 29 2026, 4:25 PM');
});

test('an incident in both sources is counted once, with the feed winning', () => {
  const register = [{ id: 'FL511-INCIDENT-999003', title: 'stale copy' }, { id: 'INC-1', title: 'Rear-end crash' }];
  const merged = mergeCrashSources(register, crashesFromLiveEvents(FEED));
  assert.equal(merged.filter(crash => crash.id === 'FL511-INCIDENT-999003').length, 1);
  assert.equal(merged.find(crash => crash.id === 'FL511-INCIDENT-999003').title, 'Crash', 'the fresher copy');
  assert.ok(merged.some(crash => crash.id === 'INC-1'), 'the register is still there');
  assert.equal(merged.length, 4);
});
