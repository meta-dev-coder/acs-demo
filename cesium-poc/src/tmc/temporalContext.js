/**
 * When the TMC is looking at.
 *
 * The corridor keeps no operational snapshots — `server/liveDc/eventSnapshots.mjs` stores camera
 * JPEGs, not state — so a past moment is RECONSTRUCTED from the records themselves. Every live
 * event carries when it was reported and, once it ends, when it cleared, so what was running at a
 * given instant is a question the existing data can answer exactly:
 *
 *     active at T  ⟺  reported_at ≤ T < cleared_at        (an event with no clear time is still on)
 *
 * Measured on the connected feed: 59 of 62 records carry both ends, including 15 of 15 incidents
 * and 29 of 29 congestion events. This is replay of what was recorded, not a forecast and not a
 * simulation.
 *
 * Pure: events and an instant in, the events that were running then out.
 */

export const TEMPORAL_MODES = Object.freeze({ LIVE: 'LIVE', HISTORICAL: 'HISTORICAL' });

/** The live context — what is happening now. */
export const liveContext = () => Object.freeze({ mode: TEMPORAL_MODES.LIVE, date: null, timestamp: null });

/**
 * A past DAY, which is the TMC's historical question.
 *
 * The screen asks "what incidents happened on this date, and what risk surrounded each" — not
 * "what was running at 11:45". A point-in-time filter answered the second question and reported an
 * empty corridor on a date that plainly had incidents, because an incident lasting twenty minutes
 * is invisible at all but twenty of the day's minutes. Each incident supplies its OWN instant for
 * the analysis around it (see `incidentAnchor`), so time still matters — just not as the filter.
 */
export function historicalDate(date) {
  const key = String(date ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return liveContext();
  return Object.freeze({ mode: TEMPORAL_MODES.HISTORICAL, date: key, timestamp: null });
}

/** A past instant, for analysing the conditions around one incident. */
export function historicalContext(timestamp) {
  const at = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp ?? ''));
  if (!Number.isFinite(at)) return liveContext();
  return Object.freeze({ mode: TEMPORAL_MODES.HISTORICAL, date: dateKeyOf(at), timestamp: at });
}

export const isHistorical = temporal =>
  temporal?.mode === TEMPORAL_MODES.HISTORICAL && (Boolean(temporal.date) || Number.isFinite(temporal.timestamp));

/**
 * A calendar date in CORRIDOR time.
 *
 * The same rule `clearedDateKey` already applies to cleared events, so a date here means what it
 * means everywhere else in the application. Formatting in UTC instead would move anything in the
 * evening to the following day and make the TMC and Live Ops disagree about what happened when.
 */
export function dateKeyOf(ms) {
  if (!Number.isFinite(ms)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The corridor date an event was reported on. */
export const reportedDateKey = event => dateKeyOf(eventInterval(event).from);

/**
 * The instants a corridor date begins and ends.
 *
 * Resolved through `fromLocalInputValue`, so the day is 23, 24 or 25 hours long exactly when
 * daylight saving says it is, rather than a fixed 86 400 000 that would drift the boundary twice a
 * year.
 */
export function dayBounds(date) {
  const from = fromLocalInputValue(`${date}T00:00`);
  if (from == null) return { from: null, to: null };
  // Midnight of the following day, named as a date rather than computed by adding 24 hours.
  const [year, month, day] = String(date).split('-').map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  const key = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  return { from, to: fromLocalInputValue(`${key}T00:00`) };
}

/**
 * Every event that was ON THE CORRIDOR on a calendar date.
 *
 * Not "reported that day". An incident reported at 4:14 AM on the 26th and cleared at 11:34 PM on
 * the 27th was on the road for the whole of the 27th, and a TMC asking what happened that day has
 * to see it — Live Ops already shows that same crash under the 27th, because its cleared list is
 * keyed on the clear time. Filing a record under one single date makes the two screens contradict
 * each other whichever date is chosen; overlap is the rule under which they agree.
 */
export function eventsOnDate(events, date) {
  const day = dayBounds(date);
  if (day.from == null || day.to == null) return [];
  return (events ?? []).filter(event => intervalsOverlap(eventInterval(event), { from: day.from, to: day.to }));
}

/** Whether an event BEGAN on this date, as opposed to running into it from an earlier one. */
export const startedOnDate = (event, date) => reportedDateKey(event) === date;

/**
 * The instant one incident's analysis is anchored to: when it was reported.
 *
 * The operator never types this. The incident carries it, which is the whole point — conditions are
 * reconstructed around when it actually happened, not around a clock the operator had to guess.
 */
export const incidentAnchor = incident => incident?.reportedAtMs ?? eventInterval(incident?.event ?? incident).from;

const known = value => value != null && String(value).trim() !== '' && !/^na$/i.test(String(value).trim());
const parse = value => (known(value) ? (Date.parse(String(value)) || null) : null);

/**
 * When an event began and ended, in milliseconds.
 *
 * `sdna.reported_at` is the instant the source published it and is present on every record;
 * `startTime` is a display string and the fallback. A null end means it had not cleared — still
 * running at any time after it started.
 */
export function eventInterval(event) {
  const from = parse(event?.sdna?.reported_at) ?? parse(event?.startTime) ?? parse(event?.lastUpdated);
  const to = parse(event?.sdna?.cleared_at_dt) ?? parse(event?.clearedAt);
  return { from, to };
}

/**
 * Whether an event was running at an instant.
 *
 * An event with no readable start is OUT of every historical moment: "we do not know when this
 * began" is not "it had begun by then", and a replay that guessed would put events on a map at
 * times they may never have been there.
 */
export function isActiveAt(event, timestamp) {
  const { from, to } = eventInterval(event);
  if (!Number.isFinite(from) || !Number.isFinite(timestamp)) return false;
  if (timestamp < from) return false;
  return to == null || timestamp < to;
}

/**
 * Whether two events' lives overlapped at all.
 *
 * The rule for "was this condition relevant to that incident". An instant test is too strict: a
 * queue that forms four minutes after a crash is exactly the condition a secondary-incident screen
 * cares about, yet it is not running at the moment the crash was reported. Overlap captures that
 * without inventing a tolerance — a closure from 15:35 to 16:10 overlaps an incident at 15:42
 * because it genuinely did, not because of a ±15-minute rule someone chose.
 *
 * An open-ended event (never cleared) runs to infinity, so it overlaps anything after it began.
 */
export function intervalsOverlap(a, b) {
  if (!Number.isFinite(a?.from) || !Number.isFinite(b?.from)) return false;
  const aTo = a.to ?? Infinity;
  const bTo = b.to ?? Infinity;
  return a.from < bTo && b.from < aTo;
}

/** Every event whose life overlapped the given one — the conditions around an incident. */
export const eventsOverlapping = (events, interval) =>
  (events ?? []).filter(event => intervalsOverlap(eventInterval(event), interval));

/** Every event that was running at an instant. */
export const eventsActiveAt = (events, timestamp) =>
  (events ?? []).filter(event => isActiveAt(event, timestamp));

/**
 * The events a temporal context says are current.
 *
 * Live means the feed's own notion — not cleared. Historical means running at the chosen instant,
 * which deliberately ignores the `cleared` flag: everything in a replay has since cleared, and
 * reading that flag would empty the screen.
 */
export function eventsFor(events, temporal) {
  if (!isHistorical(temporal)) return (events ?? []).filter(event => !event?.cleared);
  // A date asks about everything reported that day; an instant asks what was running then.
  if (temporal.date && !Number.isFinite(temporal.timestamp)) return eventsOnDate(events, temporal.date);
  return eventsActiveAt(events, temporal.timestamp);
}

/** The instant a context measures durations against: the chosen moment, or now. */
export const clockFor = (temporal, now = Date.now()) => (isHistorical(temporal) ? temporal.timestamp : now);

/** How the moment reads on screen, in the corridor's own timezone. */
export function describeTemporal(temporal) {
  if (!isHistorical(temporal)) return { mode: TEMPORAL_MODES.LIVE, label: 'Live', date: null, timestamp: null };
  if (temporal.date && !Number.isFinite(temporal.timestamp)) {
    return { mode: TEMPORAL_MODES.HISTORICAL, label: dateLabel(temporal.date), date: temporal.date, timestamp: null };
  }
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(temporal.timestamp));
  return {
    mode: TEMPORAL_MODES.HISTORICAL, label: formatted.replace(' at ', ' · '),
    date: temporal.date ?? dateKeyOf(temporal.timestamp), timestamp: temporal.timestamp,
  };
}

/** "Oct 1, 2026" from a corridor date key, read as that date rather than as an instant. */
export function dateLabel(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!match) return String(date ?? '');
  const [, year, month, day] = match.map(Number);
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(Date.UTC(year, month - 1, day)));
}

/** The time of day an incident happened, for a card or a panel heading. */
export function timeLabel(ms) {
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(ms));
}

/** The dates the records actually cover, newest first — what a date picker may honestly offer. */
export function recordedDates(events) {
  const seen = new Set();
  for (const event of events ?? []) {
    const key = reportedDateKey(event);
    if (key) seen.add(key);
  }
  return [...seen].sort().reverse();
}

/**
 * The value a `datetime-local` input needs, in corridor time.
 *
 * Built from the formatted parts rather than toISOString(), which would hand the browser a UTC
 * instant and show an operator a time that is not the one the corridor runs on.
 */
export function toLocalInputValue(timestamp) {
  if (!Number.isFinite(timestamp)) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
}

/** What a `datetime-local` value means as an instant, read in corridor time. */
export function fromLocalInputValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  // Corridor time is America/New_York, whose offset moves with daylight saving. Resolve it by
  // asking what that zone calls a candidate instant and correcting by the difference.
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const seen = new Date(guess);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(seen).map(part => [part.type, part.value]));
  const asZoned = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === '24' ? 0 : Number(parts.hour), Number(parts.minute));
  return guess + (guess - asZoned);
}

/**
 * The span the records can speak to, so a picker cannot ask for a moment nothing covers.
 *
 * @returns {{from: number|null, to: number|null}}
 */
export function recordedSpan(events) {
  let from = null, to = null;
  for (const event of events ?? []) {
    const interval = eventInterval(event);
    if (Number.isFinite(interval.from)) from = from == null ? interval.from : Math.min(from, interval.from);
    const end = interval.to ?? interval.from;
    if (Number.isFinite(end)) to = to == null ? end : Math.max(to, end);
  }
  return { from, to };
}
