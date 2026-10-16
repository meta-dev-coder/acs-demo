/**
 * What the register shows, counted — and nothing beyond counting.
 *
 * Every function here is a tally of records that happened to share an attribute. None of it is a
 * rate (there is no exposure denominator in this twin), none of it is a cause, and the weather and
 * traffic breakdowns are CO-OCCURRENCE: the condition written on the record, not a finding that
 * the condition contributed. The wording the screen uses comes from here so the two cannot drift.
 */

const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);

/** Counts by a key, largest first, with the share of the set each one represents. */
export function tally(facts = [], read, { label = 'value' } = {}) {
  const counts = new Map();
  for (const fact of facts) {
    const value = read(fact);
    if (value == null || value === '') continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  return Object.freeze([...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .map(([value, count]) => Object.freeze({
      label: String(value), count, share: total ? count / total : 0, of: label,
    })));
}

/** Records per calendar month, every month in the window present even when it holds none. */
export function monthlyTrend(facts = []) {
  const counts = new Map();
  for (const fact of facts) counts.set(fact.when.monthKey, (counts.get(fact.when.monthKey) ?? 0) + 1);
  const keys = [...counts.keys()].sort();
  if (!keys.length) return Object.freeze([]);
  const months = [];
  const [startYear, startMonth] = keys[0].split('-').map(Number);
  const [endYear, endMonth] = keys.at(-1).split('-').map(Number);
  for (let year = startYear, month = startMonth; year < endYear || (year === endYear && month <= endMonth);) {
    const key = `${year}-${String(month).padStart(2, '0')}`;
    // `label` as well as `monthKey`: every profile in this module carries the same `{label, count}`
    // shape, so one chart function can draw any of them without knowing which it was given.
    months.push(Object.freeze({ monthKey: key, label: key, count: counts.get(key) ?? 0 }));
    month += 1;
    if (month > 12) { month = 1; year += 1; }
  }
  return Object.freeze(months);
}

/** Records by hour of day, all 24 present. */
export const hourlyProfile = (facts = []) => Object.freeze(Array.from({ length: 24 }, (_, hour) =>
  Object.freeze({ hour, label: `${String(hour).padStart(2, '0')}:00`,
    count: facts.filter(fact => fact.when.hour === hour).length })));

/** Records by day of week, all 7 present. */
export const weekdayProfile = (facts = []) => Object.freeze(WEEKDAYS.map((label, index) =>
  Object.freeze({ weekday: index, label, count: facts.filter(fact => fact.when.weekday === index).length })));

/** How harm is distributed across the set. */
export function severityMix(facts = []) {
  const counts = { FATAL: 0, INJURY: 0, PROPERTY_DAMAGE: 0 };
  for (const fact of facts) counts[fact.severity.level] += 1;
  const total = facts.length;
  return Object.freeze({
    fatal: counts.FATAL, injury: counts.INJURY, propertyDamage: counts.PROPERTY_DAMAGE, total,
    injuryShare: total ? (counts.FATAL + counts.INJURY) / total : null,
    /**
     * A weighted index of THESE records (fatal 3, injury 2, otherwise 1) divided by their count.
     * A local ordering device, not a published severity index — the screen says so.
     */
    index: total ? Number((facts.reduce((sum, fact) => sum + fact.severity.rank, 0) / total).toFixed(2)) : null,
  });
}

/**
 * Conditions written on the records, beside how the whole set is distributed.
 *
 * Both are shown because one without the other misleads: "35 in clear weather" means nothing until
 * you know how many of the corpus are in clear weather at all.
 */
export function conditionBreakdown(facts = [], allFacts = facts) {
  const compare = (read, label) => {
    const subset = tally(facts, read, { label });
    const whole = new Map(tally(allFacts, read, { label }).map(row => [row.label, row.share]));
    return Object.freeze(subset.map(row => Object.freeze({
      ...row,
      corpusShare: whole.get(row.label) ?? null,
      /** Positive = over-represented here against the whole register. Association, never cause. */
      lift: whole.get(row.label) ? Number((row.share / whole.get(row.label) - 1).toFixed(2)) : null,
    })));
  };
  return Object.freeze({
    weather: compare(fact => fact.weather, 'weather'),
    traffic: compare(fact => fact.trafficConditions, 'traffic condition'),
    rootCauseCategory: compare(fact => fact.rootCauseCategory, 'assigned category'),
    incidentType: compare(fact => fact.type, 'incident type'),
    caveat: 'Conditions recorded on the incident, shown beside their share of the whole register. '
      + 'Over-representation is an association in these records, not a demonstrated cause.',
  });
}

/** The lane-closure exposure the register carries. */
export function closureExposure(facts = []) {
  const withClosure = facts.filter(fact => fact.laneClosure);
  const hours = withClosure.map(fact => fact.laneClosureHours).filter(value => Number.isFinite(value));
  const sorted = [...hours].sort((a, b) => a - b);
  return Object.freeze({
    incidents: facts.length,
    withClosure: withClosure.length,
    closureShare: facts.length ? withClosure.length / facts.length : null,
    hoursRecorded: hours.length,
    medianHours: sorted.length ? Number(sorted[Math.floor(sorted.length / 2)].toFixed(2)) : null,
    totalHours: hours.length ? Number(hours.reduce((sum, value) => sum + value, 0).toFixed(1)) : null,
    longest: sorted.length ? sorted.at(-1) : null,
  });
}
