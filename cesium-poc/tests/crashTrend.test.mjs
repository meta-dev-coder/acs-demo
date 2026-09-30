import test from 'node:test';
import assert from 'node:assert/strict';
import { hourOfDayOf, hourOfDayTrend, monthKeyOf, monthlyCrashTrend, monthsEnding } from '../src/safety/crashTrend.js';

const at = (id, date) => ({ id, createdDate: date });
const TODAY = new Date('2026-09-15T12:00:00Z');

test('a calendar date keeps the month it is written in', () => {
  // The register stores plain dates. Reading them as instants and converting to a timezone put
  // every first of the month into the month before — "2026-06-01" is June, not 31 May.
  assert.equal(monthKeyOf('2026-06-01'), '2026-06');
  assert.equal(monthKeyOf('2026-06-30'), '2026-06');
  assert.equal(monthKeyOf('2026-06-01T00:00:00'), '2026-06');
  // The live classes write day-first; the app's own normaliser already reads both.
  assert.equal(monthKeyOf('17/11/2024'), '2024-11');
  assert.equal(monthKeyOf('nonsense'), null);
  assert.equal(monthKeyOf(undefined), null);
});

test('the window is ten months ending with this one, oldest first', () => {
  const months = monthsEnding(10, TODAY);
  assert.equal(months.length, 10);
  assert.equal(months.at(-1).key, '2026-09', 'ends on the current month');
  assert.equal(months[0].key, '2025-12', 'starts nine months back');
  assert.deepEqual(months.map(m => m.label),
    ['Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep']);
});

test('a month with no crashes is a zero, never a gap', () => {
  const { points, total } = monthlyCrashTrend([at('A', '2026-09-02'), at('B', '2026-09-20')], { today: TODAY });
  assert.equal(points.length, 10);
  assert.equal(total, 2);
  assert.deepEqual(points.map(p => p.count), [0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
});

test('crashes outside the window are reported, not silently dropped', () => {
  const { total, outsideWindow, undated } = monthlyCrashTrend(
    [at('old', '2024-01-05'), at('now', '2026-09-05'), at('nodate', null)], { today: TODAY });
  assert.equal(total, 1);
  assert.equal(outsideWindow, 1);
  assert.equal(undated, 1);
});

test('peak is the tallest month, for scaling the axis', () => {
  const { peak, points } = monthlyCrashTrend(
    [at('a', '2026-08-01'), at('b', '2026-08-09'), at('c', '2026-08-30'), at('d', '2026-09-01')], { today: TODAY });
  assert.equal(peak, 3);
  assert.equal(points.at(-2).count, 3, 'August');
  assert.equal(points.at(-1).count, 1, 'September');
});

test('each month keeps its own crashes, so a point can be opened', () => {
  const { points } = monthlyCrashTrend([at('A', '2026-07-04'), at('B', '2026-07-05')], { today: TODAY });
  const july = points.find(p => p.key === '2026-07');
  assert.deepEqual(july.crashes.map(c => c.id), ['A', 'B']);
});

// ── time of day ──────────────────────────────────────────────────────────────────────────────
const withTime = (id, time) => ({ id, createdDate: '2026-06-01 00:00', raw: { attributes: { incident_time: time } } });
const withLocal = (id, local) => ({ id, createdDate: '2026-06-01 00:00', raw: { attributes: { incident_time_local: local } } });

test('the hour comes from its own column, not from the reported date', () => {
  // The register writes every historical incident as midnight; reading the hour off that would put
  // the whole register in hour 0.
  assert.equal(hourOfDayOf(withTime('a', '19:32')), 19);
  assert.equal(hourOfDayOf(withTime('b', '00:05')), 0);
  assert.equal(hourOfDayOf(withTime('c', '9:00')), 9);
  assert.equal(hourOfDayOf({ id: 'd', createdDate: '2026-06-01 00:00', raw: {} }), null);
});

test('the live classes write a 12-hour clock, and it is read as one', () => {
  assert.equal(hourOfDayOf(withLocal('a', '2026-09-29 9:27 PM EDT')), 21);
  assert.equal(hourOfDayOf(withLocal('b', '2026-09-29 12:05 AM EDT')), 0);
  assert.equal(hourOfDayOf(withLocal('c', '2026-09-29 12:05 PM EDT')), 12);
});

test('every hour is a column, and untimed records are reported', () => {
  const { points, total, peak, untimed } = hourOfDayTrend([
    withTime('a', '08:10'), withTime('b', '08:55'), withTime('c', '17:00'),
    { id: 'x', raw: {} },
  ]);
  assert.equal(points.length, 24, 'midnight to 23:00, none missing');
  assert.deepEqual(points.map(p => p.hour).slice(0, 3), [0, 1, 2]);
  assert.equal(points[8].count, 2);
  assert.equal(points[17].count, 1);
  assert.equal(points[3].count, 0, 'a quiet hour is a zero, not a gap');
  assert.equal(total, 3);
  assert.equal(peak, 2);
  assert.equal(untimed, 1);
});
