/**
 * Every Live class and relationship type carries the "SDNA" prefix so they filter quickly in
 * DataConnect; the old unprefixed names are no longer Live and the writer refuses them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_CLASS, LIVE_CLASS_NAMES, LIVE_RELATIONSHIP_TYPES, REF, isLiveClassName } from '../server/liveDc/classes.mjs';
import { WRITER_ERRORS, assertWritable } from '../server/liveDc/dcWriter.mjs';
import { LIVE_DC_CLASSES } from '../src/maintenance/liveDcSource.js';

const OLD_NAMES = ['Events', 'Tickets', 'Tasks', 'Work Orders', 'Inspections', 'Asset Status'].map(n => `Florida I595 Live ${n}`);
const liveDto = (className, i) => ({ id: `b${i}`.padEnd(24, '0'), classId: 101 + i, className, classType: 'DATA_CLASS' });

test('the six Live class names are SDNA-prefixed', () => {
  assert.deepEqual([...LIVE_CLASS_NAMES], OLD_NAMES.map(n => `SDNA ${n}`));
  assert.equal(LIVE_CLASS.EVENTS, 'SDNA Florida I595 Live Events');
  for (const name of LIVE_CLASS_NAMES) assert.ok(name.startsWith('SDNA '), name);
});

test('every relationship type and label is SDNA-prefixed', () => {
  assert.equal(LIVE_RELATIONSHIP_TYPES.length, 12);
  for (const t of LIVE_RELATIONSHIP_TYPES) {
    assert.match(t.type, /^SDNA_Live_/, t.type);
    assert.match(t.externalLabel, /^SDNA Live /, t.externalLabel);
    assert.match(t.internalLabel, /^SDNA Live /, t.internalLabel);
  }
});

test('historical reference names keep their names', () => {
  assert.equal(REF.ASSETS, 'Florida I595 Assets');
  assert.equal(REF.SEGMENTS, 'Florida i595 Roadway Segments');
});

test('the old unprefixed names are not Live and the writer refuses them', () => {
  OLD_NAMES.forEach((name, i) => {
    assert.equal(isLiveClassName(name), false, name);
    assert.throws(() => assertWritable(liveDto(name, i), 'Incremental'), e => e.code === WRITER_ERRORS.NOT_ALLOWLISTED, name);
  });
  LIVE_CLASS_NAMES.forEach((name, i) => assertWritable(liveDto(name, i), 'Incremental'));
});

test('the browser reads the same SDNA names', () => {
  assert.deepEqual(LIVE_DC_CLASSES.map(c => c.className), [...LIVE_CLASS_NAMES]);
  assert.deepEqual(LIVE_DC_CLASSES.map(c => c.key), Object.keys(LIVE_CLASS));
});
