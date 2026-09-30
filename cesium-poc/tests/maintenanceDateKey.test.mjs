/**
 * The register's date spellings, and the one that used to be dropped.
 *
 * `maintenanceDateKey` decides what counts as "dated" everywhere in the app — the period filters,
 * the maintenance windows and the crash trend all read it. A spelling it cannot parse is not an
 * error anyone sees; the record simply stops existing for every question that involves time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceDateKey, maintenanceDateParts } from '../src/assetExplorer/assetTypes.js';

test('a day-first date is read day-first, with or without a time after it', () => {
  // The bug this covers: the day-first pattern was anchored at the year, so a value carrying the
  // midnight the register writes returned null. 107 of the 182 crash records are spelled this way,
  // and every one of them counted as undated.
  assert.equal(maintenanceDateKey('30/03/2026 00:00'), '2026-03-30');
  assert.equal(maintenanceDateKey('30/03/2026'), '2026-03-30');
  assert.equal(maintenanceDateKey('30/03/2026T00:00'), '2026-03-30');
  // Day-first, never month-first: 4 November must not become 11 April.
  assert.equal(maintenanceDateKey('04/11/2026 00:00'), '2026-11-04');
});

test('the other spellings the classes use are unchanged', () => {
  assert.equal(maintenanceDateKey('2024-04-16T00:00:00'), '2024-04-16');
  assert.equal(maintenanceDateKey('2026-06-01'), '2026-06-01');
  assert.equal(maintenanceDateKey('Sep 29 2026, 9:27 PM'), '2026-09-29');
});

test('a value that is not a date stays unparsed rather than being invented', () => {
  assert.equal(maintenanceDateKey('13/13/2026'), null, 'month 13 is not a real date');
  assert.equal(maintenanceDateKey('not a date'), null);
  assert.equal(maintenanceDateKey(''), null);
  assert.equal(maintenanceDateKey(null), null);
  // A trailing time is allowed; trailing rubbish is not.
  assert.equal(maintenanceDateParts('30/03/2026xyz'), null);
});
