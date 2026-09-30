/**
 * How often crashes were reported, month by month.
 *
 * One series, one question: is the corridor getting better or worse? Every month in the window is
 * present even when nothing was reported in it — a missing column would read as "no data" when the
 * truthful answer is zero, and a trend with gaps in it is not a trend.
 *
 * A record's month comes from maintenanceDateKey — the app's own date normaliser, which already
 * reads the register's spellings (ISO, and the live classes' day-first "17/11/2024"). Deliberately
 * NOT a timezone conversion: these values are plain calendar dates with no time in them, and
 * pushing "2026-06-01" through an instant-to-New-York conversion moves it to 31 May. Every first of
 * the month would land in the month before.
 *
 * Pure: records in, buckets out. No DOM, no Cesium.
 */

import { maintenanceDateKey } from '../assetExplorer/assetTypes.js';
import { field } from '../maintenance/maintenanceRecords.js';

const MONTH_LABELS = Object.freeze(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);

/** "2026-09" for a record's reported date, or null when it carries none. */
export function monthKeyOf(value) {
  const key = maintenanceDateKey(value);
  return key ? key.slice(0, 7) : null;
}

/** The `count` months ending with `today`'s month, oldest first. */
export function monthsEnding(count, today = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
  }).formatToParts(today).map(part => [part.type, part.value]));
  const year = Number(parts.year), month = Number(parts.month);
  return Array.from({ length: count }, (_, index) => {
    const offset = count - 1 - index;
    const zero = (year * 12 + (month - 1)) - offset;
    const y = Math.floor(zero / 12), m = zero % 12;
    return { key: `${y}-${String(m + 1).padStart(2, '0')}`, label: MONTH_LABELS[m], year: y, month: m + 1 };
  });
}

/**
 * Crashes per month over the last `months` months, oldest first.
 *
 * @param {object[]} crashes incident records carrying `createdDate`
 * @returns {{points: {key,label,year,month,count,crashes}[], total: number, peak: number,
 *            outsideWindow: number, undated: number}}
 */
export function monthlyCrashTrend(crashes, { months = 10, today = new Date() } = {}) {
  const buckets = new Map(monthsEnding(months, today).map(month => [month.key, { ...month, count: 0, crashes: [] }]));
  let outsideWindow = 0, undated = 0;
  for (const crash of crashes ?? []) {
    const key = monthKeyOf(crash?.createdDate);
    if (!key) { undated += 1; continue; }
    const bucket = buckets.get(key);
    // A crash older than the window is not lost, it is simply not in this picture — and the panel
    // says how many, so a flat chart is never mistaken for a quiet corridor.
    if (!bucket) { outsideWindow += 1; continue; }
    bucket.count += 1;
    bucket.crashes.push(crash);
  }
  const points = [...buckets.values()];
  return {
    points,
    total: points.reduce((sum, point) => sum + point.count, 0),
    peak: points.reduce((most, point) => Math.max(most, point.count), 0),
    outsideWindow,
    undated,
  };
}

/**
 * What hour of the day a crash happened.
 *
 * NOT from the record's reported date: the register writes every historical incident as midnight
 * ("30/03/2026 00:00"), so bucketing on that would put 178 crashes in hour 0 and call it a night
 * shift. The hour lives in its own column — `incident_time` ("19:32"), with the live classes'
 * `incident_time_local` ("2026-09-29 9:27 PM EDT") as the fallback.
 *
 * @returns {number|null} 0-23, or null when the record carries no time
 */
export function hourOfDayOf(crash) {
  const plain = String(field(crash?.raw, 'incident_time') ?? '').trim();
  const clock = /^(\d{1,2}):(\d{2})/.exec(plain);
  if (clock) {
    const hour = Number(clock[1]);
    return hour >= 0 && hour <= 23 ? hour : null;
  }
  const local = String(field(crash?.raw, 'incident_time_local') ?? '').trim();
  const meridiem = /(\d{1,2}):(\d{2})\s*(AM|PM)/i.exec(local);
  if (meridiem) {
    const raw = Number(meridiem[1]) % 12;
    return /PM/i.test(meridiem[3]) ? raw + 12 : raw;
  }
  return null;
}

/**
 * Crashes by hour of day, midnight to 23:00.
 *
 * Every hour is present even at zero: a quiet hour is a fact about the corridor, and a missing
 * column would read as "no data". `untimed` says how many records carry no time at all, so a
 * thin-looking day is never mistaken for a safe one.
 *
 * @returns {{points: {hour,label,count,crashes}[], total: number, peak: number, untimed: number}}
 */
export function hourOfDayTrend(crashes) {
  const points = Array.from({ length: 24 }, (_, hour) => ({
    hour, label: String(hour).padStart(2, '0'), count: 0, crashes: [],
  }));
  let untimed = 0;
  for (const crash of crashes ?? []) {
    const hour = hourOfDayOf(crash);
    if (hour == null) { untimed += 1; continue; }
    points[hour].count += 1;
    points[hour].crashes.push(crash);
  }
  return {
    points,
    total: points.reduce((sum, point) => sum + point.count, 0),
    peak: points.reduce((most, point) => Math.max(most, point.count), 0),
    untimed,
  };
}
