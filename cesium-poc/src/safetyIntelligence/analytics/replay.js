/**
 * Historical replay: step the register through time.
 *
 * Replay is honest only if it shows what was RECORDED, at the resolution it was recorded. This
 * corpus gives a date and a time per record, so replay runs on a timeline of record instants. It
 * does not animate a crash, interpolate a vehicle, or place a record anywhere other than its
 * damaged asset. A record appears at its instant and stays visible for a stated dwell window so the
 * eye can catch it; that dwell is a display choice and is labelled as one.
 *
 * Deterministic and pure: same records plus same cursor gives the same frame, with no clock read
 * inside.
 */
const DAY = 86_400_000;

export const SPEEDS = Object.freeze([
  { id: 'day', label: 'A day per step', stepMs: DAY },
  { id: 'week', label: 'A week per step', stepMs: 7 * DAY },
  { id: 'month', label: 'A month per step', stepMs: 30 * DAY },
]);

/** The window in which a record stays lit after its instant. A display choice, not data. */
export const DWELL_MS = 7 * DAY;

/**
 * The timeline the replay runs on, from the records themselves.
 *
 * @param {object[]} facts incident facts
 */
export function buildTimeline(facts = [], { speedId = 'week' } = {}) {
  const located = facts.filter(fact => fact.when);
  if (!located.length) {
    return Object.freeze({ empty: true, startMs: null, endMs: null, steps: 0, stepMs: 0, speedId });
  }
  const instants = located.map(fact => fact.when.ms).sort((a, b) => a - b);
  const speed = SPEEDS.find(candidate => candidate.id === speedId) ?? SPEEDS[1];
  const startMs = instants[0];
  const endMs = instants.at(-1);
  return Object.freeze({
    empty: false,
    startMs,
    endMs,
    stepMs: speed.stepMs,
    speedId: speed.id,
    speedLabel: speed.label,
    steps: Math.max(1, Math.ceil((endMs - startMs) / speed.stepMs)),
    records: located.length,
    dwellMs: DWELL_MS,
    dwellNote: 'A record stays highlighted for seven days after its recorded time so it is visible '
      + 'while the replay runs. The dwell is a display choice, not part of the record.',
  });
}

/** Cursor time for a step index. */
export const cursorAt = (timeline, step) => (timeline.empty
  ? null
  : Math.min(timeline.endMs, timeline.startMs + step * timeline.stepMs));

/**
 * One frame: what had happened by the cursor, and what is lit right now.
 *
 * @param {object[]} facts incident facts
 * @param {object} timeline from buildTimeline()
 * @param {number} step 0-based step index
 */
export function frameAt(facts = [], timeline, step = 0) {
  if (!timeline || timeline.empty) {
    return Object.freeze({ cursorMs: null, step, active: Object.freeze([]), cumulative: Object.freeze([]),
      cumulativeCount: 0, activeCount: 0, severe: 0, label: 'No records' });
  }
  const cursorMs = cursorAt(timeline, step);
  const cumulative = facts.filter(fact => fact.when && fact.when.ms <= cursorMs);
  const active = cumulative.filter(fact => cursorMs - fact.when.ms <= timeline.dwellMs);
  const month = new Date(cursorMs).toISOString().slice(0, 7);
  return Object.freeze({
    step,
    cursorMs,
    label: month,
    active: Object.freeze(active),
    activeCount: active.length,
    cumulative: Object.freeze(cumulative),
    cumulativeCount: cumulative.length,
    severe: active.filter(fact => fact.severity.rank >= 2).length,
    atEnd: cursorMs >= timeline.endMs,
  });
}

/**
 * The per-step series behind the replay scrubber, so the timeline can be drawn before it is played.
 */
export function replaySeries(facts = [], timeline) {
  if (!timeline || timeline.empty) return Object.freeze([]);
  return Object.freeze(Array.from({ length: timeline.steps + 1 }, (_, step) => {
    const frame = frameAt(facts, timeline, step);
    return Object.freeze({
      step,
      cursorMs: frame.cursorMs,
      label: frame.label,
      count: frame.activeCount,
      cumulative: frame.cumulativeCount,
      severe: frame.severe,
    });
  }));
}

/**
 * How the corridor changed between two cursors — a comparison of counts in two windows of the same
 * length, which is as much as the corpus supports.
 *
 * It reports a difference in record counts. It does not attribute that difference to anything, and
 * it never calls a drop an improvement: this register's completeness over time is unknown.
 */
export function compareWindows(facts = [], { fromMs, toMs, spanMs }) {
  const within = (startMs, endMs) => facts.filter(fact => fact.when
    && fact.when.ms >= startMs && fact.when.ms < endMs);
  const earlier = within(fromMs, fromMs + spanMs);
  const later = within(toMs, toMs + spanMs);
  return Object.freeze({
    earlier: Object.freeze({ startMs: fromMs, records: earlier.length,
      severe: earlier.filter(fact => fact.severity.rank >= 2).length }),
    later: Object.freeze({ startMs: toMs, records: later.length,
      severe: later.filter(fact => fact.severity.rank >= 2).length }),
    difference: later.length - earlier.length,
    spanDays: Math.round(spanMs / DAY),
    caveat: 'A difference in how many records exist in two windows. Reporting completeness over time '
      + 'is unknown, so a change in count is not evidence that the corridor became safer or less safe.',
  });
}
