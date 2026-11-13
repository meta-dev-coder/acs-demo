/**
 * ISO 8601 durations, converted only on a stated basis.
 *
 * OpenProject reports work as an ISO 8601 duration string: `P1DT16H` for the estimate on work
 * package 38, `P1DT6H` for what remains. Turning those into "40h" and "30h" requires knowing what
 * a `D` is worth, and that is a PROJECT SETTING, not a property of the string. ISO 8601 itself
 * defines the nominal day as 24 hours; a scheduling tool configured for an 8-hour working day
 * would mean something entirely different by the same text.
 *
 * So this module does three things and refuses to do a fourth:
 *
 *  - it PRESERVES the raw string, always. Whatever is displayed, the source value survives beside
 *    it for reconciliation.
 *  - it converts on an explicit `hoursPerDay`, and REPORTS which basis was used, so the screen can
 *    say "40h (ISO 8601 nominal 24 h/day)" rather than an unqualified "40h".
 *  - it refuses months and years. `P1M` is not a fixed number of hours in any calendar, and a
 *    plausible conversion of it would be a fabricated figure.
 *
 * It does not guess the basis. `basisFor()` takes what the instance actually told us, or says the
 * basis is an assumption.
 */

/**
 * Where an `hoursPerDay` came from. Printed next to every converted figure.
 *
 * In practice only `ISO_8601_NOMINAL` is used for WORK — see `basisFor()` for why — but the
 * distinction is kept because the basis is a fact the screen states, and a future instance that
 * genuinely serialized work on a working day would need the other value rather than a silent
 * wrong conversion.
 */
export const BASIS = Object.freeze({
  /** Read from OpenProject's own configuration endpoint. */
  FROM_INSTANCE: 'FROM_INSTANCE',
  /** ISO 8601's nominal 24-hour day, which is what an ISO duration literally means. */
  ISO_8601_NOMINAL: 'ISO_8601_NOMINAL',
});

export const BASIS_NOTE = Object.freeze({
  FROM_INSTANCE: 'hours per day read from the OpenProject instance configuration',
  ISO_8601_NOMINAL: 'ISO 8601 nominal 24-hour day — what an ISO 8601 duration means, and what '
    + "OpenProject's own estimate/remaining arithmetic reconciles against",
});

/** ISO 8601's nominal day. The default, and never silently so. */
export const NOMINAL_HOURS_PER_DAY = 24;

/**
 * One ISO 8601 duration.
 *
 * @param {string|null} raw the source value, kept verbatim in the result
 * @param {{hoursPerDay?: number, basis?: string}} [options]
 * @returns {{raw, hours, hoursPerDay, basis, components, exact, warning}|null}
 *   `null` only when there was nothing to parse. A value we cannot read comes back with
 *   `hours: null` and a warning — an unreadable duration must read as absent, never as zero.
 */
export function parseIsoDuration(raw, {
  hoursPerDay = NOMINAL_HOURS_PER_DAY, basis = BASIS.ISO_8601_NOMINAL,
} = {}) {
  if (raw == null || raw === '') return null;
  const text = String(raw).trim();
  const blank = { raw: text, hours: null, hoursPerDay, basis, exact: false,
    components: null, warning: null };

  // Deliberately strict. Weeks are allowed (a fixed 7 days); months and years are not.
  const match = /^(-)?P(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/
    .exec(text);
  if (!match || text === 'P' || text === 'PT') {
    if (/\d+(?:\.\d+)?[MY]/.test(text.split('T')[0] ?? '')) {
      return { ...blank,
        warning: `"${text}" carries months or years, which are not a fixed number of hours. The `
          + 'raw value is shown and no conversion is offered.' };
    }
    return { ...blank, warning: `"${text}" is not an ISO 8601 duration this adapter can read.` };
  }

  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const n = value => (value == null ? 0 : Number(value));
  const components = { weeks: n(weeks), days: n(days), hours: n(hours), minutes: n(minutes),
    seconds: n(seconds) };

  const total = (components.weeks * 7 + components.days) * hoursPerDay
    + components.hours + components.minutes / 60 + components.seconds / 3600;
  const signed = (sign === '-' ? -1 : 1) * total;

  return {
    raw: text,
    /** Rounded to the minute. A duration reported to 12 decimal places is noise, not precision. */
    hours: Math.round(signed * 60) / 60,
    hoursPerDay,
    basis,
    /** True when no day/week component was involved, so the basis could not have changed it. */
    exact: components.weeks === 0 && components.days === 0,
    components,
    warning: null,
  };
}

/**
 * The basis for converting a WORK duration, and the instance settings beside it.
 *
 * CORRECTED after reading the live instance. The instance reports `hoursPerDay: 8`, and an
 * earlier version of this function adopted it — turning `P1DT6H` into 14 h. That was wrong, and
 * the instance's own data proves it:
 *
 *   estimatedTime P1DT16H, remainingTime P1DT6H, percentageDone 25
 *     at 24 h/day:  40 h x (1 - 25%) = 30 h  =  30 h reported    EXACT
 *     at  8 h/day:  24 h x (1 - 25%) = 18 h vs 14 h reported     no relationship
 *
 * `hoursPerDay` is a DISPLAY setting: it governs how OpenProject renders the day-denominated
 * scheduling `duration` field as days and hours. Work is stored in hours and serialized as a plain
 * ISO 8601 duration, in which `P1D` is 24 hours by definition. This instance also reports
 * `durationFormat: "hours_only"`, so it does not render work in days at all.
 *
 * So work always converts on the ISO nominal day, and `hoursPerDay` is carried as context the
 * screen can show — explicitly NOT applied to work.
 */
export function basisFor(configuration) {
  const raw = configuration?.hoursPerDay ?? configuration?.hours_per_day ?? null;
  const value = raw == null ? null : Number(raw);
  const instanceHoursPerDay = value != null && Number.isFinite(value) && value > 0 && value <= 24
    ? value : null;
  return {
    hoursPerDay: NOMINAL_HOURS_PER_DAY,
    basis: BASIS.ISO_8601_NOMINAL,
    note: BASIS_NOTE.ISO_8601_NOMINAL,
    /** What the instance reports, and what it actually governs. Shown, never applied to work. */
    instanceHoursPerDay,
    instanceDurationFormat: typeof configuration?.durationFormat === 'string'
      ? configuration.durationFormat : null,
    instanceNote: instanceHoursPerDay == null ? null
      : `The instance reports ${instanceHoursPerDay} h/day. That setting governs how OpenProject `
        + 'displays the day-denominated scheduling duration; work is serialized as a plain ISO '
        + '8601 duration and is not converted with it.',
  };
}

/**
 * An internal cross-check on the conversion, not a claim about the work.
 *
 * If an activity reports an estimate, a remaining amount and a percentage complete, then
 * `remaining ≈ estimate × (1 − pct)` holds whenever OpenProject derived one from the others. When
 * it holds, the `hoursPerDay` used is corroborated by the source's own arithmetic; when it does
 * not, the three values were set independently, which is normal and is NOT an error. Either way
 * this is reported as an observation, never used to adjust a figure.
 */
export function corroborate({ estimated, remaining, percentDone }) {
  if (estimated?.hours == null || remaining?.hours == null || percentDone == null) return null;
  if (estimated.hours === 0) return null;
  const implied = estimated.hours * (1 - Number(percentDone) / 100);
  const deltaHours = Math.round((remaining.hours - implied) * 60) / 60;
  // A minute of slack: OpenProject rounds, and so do we.
  const agrees = Math.abs(deltaHours) <= 0.02;
  return {
    agrees,
    impliedRemainingHours: Math.round(implied * 60) / 60,
    reportedRemainingHours: remaining.hours,
    deltaHours,
    note: agrees
      ? `Remaining work matches estimate × (1 − ${percentDone}%) at `
        + `${estimated.hoursPerDay} h/day, which corroborates the conversion basis.`
      : `Remaining work differs from estimate × (1 − ${percentDone}%) by ${deltaHours} h. The `
        + 'three values were set independently in OpenProject; this is not an error and nothing '
        + 'has been adjusted.',
  };
}
