/**
 * Historical replay for the TMC.
 *
 * The corridor keeps no operational snapshots, so a past moment is reconstructed from the records'
 * own start and clear times. The danger that outranks all others here is mixing: a historical
 * incident scored against today's congestion would be a plausible-looking wrong answer on a safety
 * screen. These tests exist mostly to prove that cannot happen.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARRIAGEWAYS } from '../src/liveOps/carriagewayModel.js';
import {
  clockFor, dateKeyOf, dateLabel, describeTemporal, eventInterval, eventsActiveAt, eventsFor, eventsOnDate,
  dayBounds, fromLocalInputValue, historicalContext, historicalDate, isActiveAt, isHistorical, liveContext,
  recordedDates, recordedSpan, reportedDateKey, startedOnDate, TEMPORAL_MODES, toLocalInputValue,
} from '../src/tmc/temporalContext.js';
import { assessCorridor, getHighestSecondaryRiskIncident } from '../src/tmc/tmcService.js';
import { UPSTREAM_STATUS } from '../src/tmc/upstreamResolver.js';

const T = iso => Date.parse(iso);
const AT = T('2026-09-15T21:30:00Z');

const GEO = JSON.parse(readFileSync(new URL('../public/data/i595_fdot_traffic_segments.geojson', import.meta.url)));
const SECTIONS = GEO.features.map(f => {
  const p = f.properties;
  return {
    segmentId: p.segment_id,
    sectionId: `SECTION_${String(p.fdot_segment_index).padStart(2, '0')}`,
    sectionIndex: p.fdot_segment_index,
    sectionLabel: `${p.direction === 'WB' ? 'Westbound' : 'Eastbound'} Section ${String(p.fdot_segment_index).padStart(2, '0')}`,
    carriageway: p.direction === 'WB' ? CARRIAGEWAYS.WB_GENERAL : CARRIAGEWAYS.EB_GENERAL,
    travelOrder: p.travel_order,
    coordinates: f.geometry.coordinates,
  };
});
const section = (dir, index) => SECTIONS.find(s => s.carriageway === dir && s.sectionIndex === index);
const mid = s => s.coordinates[Math.floor(s.coordinates.length / 2)];

/** A record as the feed stores it: reported at one instant, cleared at another. */
const record = ({ id, type, from, to, index = 4, carriageway = CARRIAGEWAYS.EB_GENERAL, lanes = null, severity = 'Minor', cleared = true }) => {
  const sec = section(carriageway, index);
  const [lon, lat] = mid(sec);
  return {
    id, type, title: type === 'INCIDENT' ? 'Crash' : type, severity, cleared,
    longitude: lon, latitude: lat,
    clearedAt: to ? new Date(to).toISOString() : null,
    sdna: { reported_at: new Date(from).toISOString(), cleared_at_dt: to ? new Date(to).toISOString() : 'NA' },
    liveOps: {
      carriageway, direction: carriageway === CARRIAGEWAYS.WB_GENERAL ? 'WB' : 'EB',
      sectionId: sec.sectionId, sectionIndex: sec.sectionIndex, sectionLabel: sec.sectionLabel,
      segmentId: sec.segmentId, spatialMatch: { confidence: 'HIGH' },
      laneImpact: lanes ?? { blockedLanes: null, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'none' },
    },
  };
};

const BLOCKED = { blockedLanes: 2, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'parsed' };
const context = extra => ({ sections: SECTIONS, centerline: [], cameras: [], signs: [], now: T('2026-10-05T12:00:00Z'), ...extra });

test('an event is active at a moment between its start and its clearance', () => {
  const event = record({ id: 'E', type: 'INCIDENT', from: AT - 600_000, to: AT + 600_000 });
  assert.equal(isActiveAt(event, AT), true);
  assert.equal(isActiveAt(event, AT - 900_000), false, 'before it was reported');
  assert.equal(isActiveAt(event, AT + 900_000), false, 'after it cleared');
  // The clear instant itself is the end, not still running.
  assert.equal(isActiveAt(event, AT + 600_000), false);
});

test('an event that never cleared is still running at any later moment', () => {
  const open = record({ id: 'E', type: 'INCIDENT', from: AT - 60_000, to: null, cleared: false });
  assert.equal(eventInterval(open).to, null);
  assert.equal(isActiveAt(open, AT), true);
  assert.equal(isActiveAt(open, AT + 86_400_000), true);
});

test('an event with no readable start belongs to no moment rather than every moment', () => {
  const vague = { id: 'E', type: 'INCIDENT', longitude: -80.2, latitude: 26.06, sdna: {} };
  assert.equal(isActiveAt(vague, AT), false);
  assert.deepEqual(eventsActiveAt([vague], AT), []);
});

test('live scope reads the feed\'s own flag; historical scope ignores it', () => {
  const events = [
    record({ id: 'running', type: 'INCIDENT', from: AT - 60_000, to: null, cleared: false }),
    record({ id: 'ended', type: 'INCIDENT', from: AT - 600_000, to: AT + 60_000, cleared: true }),
  ];
  assert.deepEqual(eventsFor(events, liveContext()).map(e => e.id), ['running']);
  // Everything in a replay has since cleared; reading that flag would empty the screen.
  assert.deepEqual(eventsFor(events, historicalContext(AT)).map(e => e.id).sort(), ['ended', 'running']);
});

test('the assessment at a past moment uses only what was running then', () => {
  const events = [
    record({ id: 'INC-then', type: 'INCIDENT', from: AT - 600_000, to: AT + 600_000, lanes: BLOCKED }),
    record({ id: 'CON-then', type: 'CONGESTION', from: AT - 300_000, to: AT + 300_000, index: 3 }),
    // Today's congestion, long after the moment being replayed. It must not reach the score.
    record({ id: 'CON-today', type: 'CONGESTION', from: AT + 86_400_000, to: null, index: 3, cleared: false }),
    record({ id: 'INC-later', type: 'INCIDENT', from: AT + 86_400_000, to: null, cleared: false }),
  ];
  const past = assessCorridor(events, context({ temporal: historicalContext(AT) }));
  assert.deepEqual(past.incidents.map(i => i.id), ['INC-then'], 'only the incident running then');
  assert.equal(past.assessments[0].upstreamCongestion.length, 1);
  assert.equal(past.assessments[0].upstreamCongestion[0].id, 'CON-then', 'today\'s queue never reaches a past score');
  assert.equal(past.historical, true);

  // And live is unchanged by the presence of history.
  const live = assessCorridor(events, context({ temporal: liveContext() }));
  assert.deepEqual(live.incidents.map(i => i.id), ['INC-later']);
  assert.equal(live.historical, false);
});

test('a closure that had already cleared does not count at the moment after it', () => {
  const events = [
    record({ id: 'INC', type: 'INCIDENT', from: AT - 600_000, to: AT + 600_000 }),
    record({ id: 'CLO-earlier', type: 'CLOSURE', from: AT - 7_200_000, to: AT - 3_600_000 }),
    record({ id: 'CLO-now', type: 'CLOSURE', from: AT - 60_000, to: AT + 60_000 }),
  ];
  const past = assessCorridor(events, context({ temporal: historicalContext(AT) }));
  assert.equal(past.counts.laneClosures, 1, 'the closure that had already ended is not counted');
});

test('duration is measured at the replayed moment, not from today', () => {
  const events = [record({ id: 'INC', type: 'INCIDENT', from: AT - 1_800_000, to: AT + 600_000 })];
  const past = assessCorridor(events, context({ temporal: historicalContext(AT) }));
  assert.equal(past.incidents[0].activeMinutes, 30, 'thirty minutes into the incident, as it was then');
  assert.equal(clockFor(historicalContext(AT)), AT);
});

test('upstream resolves the same way in history, on both carriageways', () => {
  const eb = assessCorridor([
    record({ id: 'INC-EB', type: 'INCIDENT', from: AT - 60_000, to: AT + 60_000, index: 4 }),
    record({ id: 'CON-EB', type: 'CONGESTION', from: AT - 60_000, to: AT + 60_000, index: 3 }),
    record({ id: 'CON-EB-ahead', type: 'CONGESTION', from: AT - 60_000, to: AT + 60_000, index: 6 }),
  ], context({ temporal: historicalContext(AT) }));
  assert.equal(eb.assessments[0].upstream.status, UPSTREAM_STATUS.RESOLVED);
  assert.deepEqual(eb.assessments[0].upstreamCongestion.map(e => e.id), ['CON-EB']);

  const wb = assessCorridor([
    record({ id: 'INC-WB', type: 'INCIDENT', from: AT - 60_000, to: AT + 60_000, index: 4, carriageway: CARRIAGEWAYS.WB_GENERAL }),
    record({ id: 'CON-WB', type: 'CONGESTION', from: AT - 60_000, to: AT + 60_000, index: 5, carriageway: CARRIAGEWAYS.WB_GENERAL }),
    record({ id: 'CON-WB-ahead', type: 'CONGESTION', from: AT - 60_000, to: AT + 60_000, index: 3, carriageway: CARRIAGEWAYS.WB_GENERAL }),
  ], context({ temporal: historicalContext(AT) }));
  assert.deepEqual(wb.assessments[0].upstreamCongestion.map(e => e.id), ['CON-WB'], 'westbound arrives from the higher section');
});

test('historical risk is the same engine, with the same unavailable factors', () => {
  const events = [record({ id: 'INC', type: 'INCIDENT', from: AT - 1_800_000, to: AT + 600_000, lanes: BLOCKED, severity: 'Major' })];
  const past = assessCorridor(events, context({ temporal: historicalContext(AT) }));
  const risk = past.assessments[0].risk;
  // Nothing about the engine changes between modes; the score is still its own factors.
  assert.equal(risk.score, risk.factors.reduce((t, f) => t + f.contribution, 0));
  assert.deepEqual(risk.unavailableFactors.map(f => f.type),
    ['RESPONDER_STATUS', 'DMS_WARNING_ACTIVE', 'QUEUE_LENGTH', 'TRAFFIC_SPEED', 'WEATHER'],
    'no historical DMS message or responder state exists either, and weather arrives on selection');
});

test('a moment with nothing running is an honest empty answer', () => {
  const events = [record({ id: 'INC', type: 'INCIDENT', from: AT + 3_600_000, to: AT + 7_200_000 })];
  const quiet = historicalContext(AT);
  const assessed = assessCorridor(events, context({ temporal: quiet }));
  assert.equal(assessed.counts.activeIncidents, 0);
  const answer = getHighestSecondaryRiskIncident(events, context({ temporal: quiet }));
  assert.equal(answer.available, false);
  assert.match(answer.reason, /No I-595 incidents were active at/);
  assert.equal(answer.historical, true);
});

test('the live empty answer keeps its own wording', () => {
  const answer = getHighestSecondaryRiskIncident([], context({ temporal: liveContext() }));
  assert.match(answer.reason, /No active I-595 incidents are currently available/);
  assert.equal(answer.historical, false);
});

test('a moment is described in corridor time, and survives a round trip through the picker', () => {
  const described = describeTemporal(historicalContext(AT));
  assert.equal(described.mode, TEMPORAL_MODES.HISTORICAL);
  // 21:30 UTC on 15 September is 5:30 PM in New York (daylight saving).
  assert.match(described.label, /Sep 15, 2026/);
  assert.match(described.label, /5:30 PM/);
  const value = toLocalInputValue(AT);
  assert.equal(value, '2026-09-15T17:30');
  assert.equal(fromLocalInputValue(value), AT, 'the picker round-trips to the same instant');
  assert.equal(fromLocalInputValue('nonsense'), null);
});

test('an unreadable timestamp falls back to live rather than to a silent wrong moment', () => {
  assert.equal(isHistorical(historicalContext('not a date')), false);
  assert.equal(historicalContext('not a date').mode, TEMPORAL_MODES.LIVE);
  assert.equal(describeTemporal(liveContext()).label, 'Live');
});

test('the recorded span is what the picker can honestly offer', () => {
  const span = recordedSpan([
    record({ id: 'a', type: 'INCIDENT', from: AT - 3_600_000, to: AT }),
    record({ id: 'b', type: 'INCIDENT', from: AT, to: AT + 3_600_000 }),
  ]);
  assert.equal(span.from, AT - 3_600_000);
  assert.equal(span.to, AT + 3_600_000);
  assert.deepEqual(recordedSpan([]), { from: null, to: null });
});

// ── Date-based historical analysis ──────────────────────────────────────────────────────────────
// The TMC's historical question is "what happened on this date", not "what was running at 11:45".

test('a date returns every incident reported that day, however briefly each lasted', () => {
  const events = [
    record({ id: 'INC-morning', type: 'INCIDENT', from: T('2026-10-01T10:13:00Z'), to: T('2026-10-01T10:31:00Z') }),
    record({ id: 'INC-midday', type: 'INCIDENT', from: T('2026-10-01T15:36:00Z'), to: T('2026-10-01T15:58:00Z') }),
    record({ id: 'INC-other-day', type: 'INCIDENT', from: T('2026-10-02T15:36:00Z'), to: T('2026-10-02T15:58:00Z') }),
  ];
  const day = assessCorridor(events, context({ temporal: historicalDate('2026-10-01') }));
  assert.deepEqual(day.incidents.map(i => i.id).sort(), ['INC-midday', 'INC-morning']);
  assert.equal(day.counts.activeIncidents, 2);
  // The point-in-time version reported zero here, because no single instant contains both.
  assert.equal(assessCorridor(events, context({ temporal: historicalContext(T('2026-10-01T12:00:00Z')) })).incidents.length, 0);
});

test('dates are corridor dates, so a late-evening incident stays on its own day', () => {
  // 02:30 UTC on 2 October is 10:30 PM on 1 October in New York. Formatting in UTC would file it
  // under the wrong day and make the TMC disagree with Live Ops about when things happened.
  assert.equal(dateKeyOf(T('2026-10-02T02:30:00Z')), '2026-10-01');
  const evening = record({ id: 'INC-late', type: 'INCIDENT', from: T('2026-10-02T02:30:00Z'), to: T('2026-10-02T03:00:00Z') });
  assert.equal(reportedDateKey(evening), '2026-10-01');
  assert.deepEqual(eventsOnDate([evening], '2026-10-01').map(e => e.id), ['INC-late']);
});

test('each incident is judged against the conditions around ITS OWN time', () => {
  const morning = T('2026-10-01T10:13:00Z');
  const midday = T('2026-10-01T15:36:00Z');
  const events = [
    record({ id: 'INC-morning', type: 'INCIDENT', from: morning, to: morning + 1_200_000, index: 4, lanes: BLOCKED }),
    record({ id: 'INC-midday', type: 'INCIDENT', from: midday, to: midday + 1_200_000, index: 4, lanes: BLOCKED }),
    // A queue upstream during the MORNING incident only.
    record({ id: 'CON-morning', type: 'CONGESTION', from: morning + 240_000, to: morning + 900_000, index: 3 }),
  ];
  const day = assessCorridor(events, context({ temporal: historicalDate('2026-10-01') }));
  const byId = Object.fromEntries(day.assessments.map(a => [a.incident.id, a]));
  assert.equal(byId['INC-morning'].upstreamCongestion.length, 1, 'the queue that overlapped it');
  assert.equal(byId['INC-midday'].upstreamCongestion.length, 0, 'hours later, and not its congestion');
  // Each carries the instant it was judged at, so the panel can say so.
  assert.equal(byId['INC-morning'].moment.at, morning);
  assert.equal(byId['INC-midday'].moment.at, midday);
});

test('a condition that began after the incident still counts if it overlapped its life', () => {
  // The case an instant test gets wrong: a queue forming four minutes after a crash is exactly the
  // condition this screen exists to notice.
  const at = T('2026-10-01T15:42:00Z');
  const events = [
    record({ id: 'INC', type: 'INCIDENT', from: at, to: at + 1_800_000, index: 4 }),
    record({ id: 'CON-after', type: 'CONGESTION', from: at + 240_000, to: at + 900_000, index: 3 }),
    record({ id: 'CON-unrelated', type: 'CONGESTION', from: at + 7_200_000, to: at + 7_800_000, index: 3 }),
  ];
  const day = assessCorridor(events, context({ temporal: historicalDate('2026-10-01') }));
  assert.deepEqual(day.assessments[0].upstreamCongestion.map(e => e.id), ['CON-after']);
});

test('a date with no incidents says so rather than reporting a live number', () => {
  const events = [record({ id: 'INC', type: 'INCIDENT', from: T('2026-10-03T12:00:00Z'), to: T('2026-10-03T12:30:00Z') })];
  const empty = assessCorridor(events, context({ temporal: historicalDate('2026-10-01') }));
  assert.equal(empty.counts.activeIncidents, 0);
  const answer = getHighestSecondaryRiskIncident(events, context({ temporal: historicalDate('2026-10-01') }));
  assert.equal(answer.available, false);
  assert.match(answer.reason, /Oct 1, 2026/);
});

test('live conditions never reach a historical date', () => {
  const at = T('2026-10-01T15:42:00Z');
  const events = [
    record({ id: 'INC-then', type: 'INCIDENT', from: at, to: at + 1_800_000, index: 4, lanes: BLOCKED }),
    // Running right now, never cleared — the live corridor.
    record({ id: 'CON-now', type: 'CONGESTION', from: Date.now() - 600_000, to: null, index: 3, cleared: false }),
    record({ id: 'CLO-now', type: 'CLOSURE', from: Date.now() - 600_000, to: null, cleared: false }),
  ];
  const day = assessCorridor(events, context({ temporal: historicalDate('2026-10-01') }));
  assert.equal(day.assessments[0].upstreamCongestion.length, 0, "today's queue is not that day's evidence");
  assert.equal(day.counts.laneClosures, 0, "today's closure is not counted on a past date");
});

test('the date label and the recorded dates read as dates, not instants', () => {
  assert.equal(dateLabel('2026-10-01'), 'Oct 1, 2026');
  assert.equal(describeTemporal(historicalDate('2026-10-01')).label, 'Oct 1, 2026');
  assert.equal(describeTemporal(historicalDate('2026-10-01')).timestamp, null, 'a date is not an instant');
  const dates = recordedDates([
    record({ id: 'a', type: 'INCIDENT', from: T('2026-10-01T12:00:00Z'), to: null }),
    record({ id: 'b', type: 'INCIDENT', from: T('2026-09-29T12:00:00Z'), to: null }),
  ]);
  assert.deepEqual(dates, ['2026-10-01', '2026-09-29'], 'newest first');
});

test('an unusable date falls back to live rather than showing an empty day', () => {
  assert.equal(historicalDate('nonsense').mode, 'LIVE');
  assert.equal(historicalDate('').mode, 'LIVE');
});

test('an incident that ran across a date appears on that date, not only on the one it began', () => {
  // The real case: FL511-INCIDENT-999003 was reported 4:14 AM on the 26th and cleared 11:34 PM on
  // the 27th. Live Ops lists it under the 27th (its cleared list is keyed on the clear time), so a
  // TMC that filed it only under the 26th made the two screens contradict each other.
  const spanning = record({
    id: 'INC-spanning', type: 'INCIDENT', severity: 'Major',
    from: T('2026-09-26T08:14:32Z'), to: T('2026-09-28T03:34:54Z'),
  });
  for (const day of ['2026-09-26', '2026-09-27']) {
    assert.deepEqual(eventsOnDate([spanning], day).map(e => e.id), ['INC-spanning'], day);
  }
  // It had cleared before the 28th began in corridor time (11:34 PM on the 27th).
  assert.deepEqual(eventsOnDate([spanning], '2026-09-28'), []);
  // And the screen can still tell "began today" from "still running from earlier".
  assert.equal(startedOnDate(spanning, '2026-09-26'), true);
  assert.equal(startedOnDate(spanning, '2026-09-27'), false);
});

test('a carried-over incident is still anchored to its own report time', () => {
  const spanning = record({
    id: 'INC-spanning', type: 'INCIDENT',
    from: T('2026-09-26T08:14:32Z'), to: T('2026-09-28T03:34:54Z'), index: 4, lanes: BLOCKED,
  });
  const day = assessCorridor([spanning], context({ temporal: historicalDate('2026-09-27') }));
  assert.equal(day.counts.activeIncidents, 1);
  // Not midnight on the 27th, and not the moment the operator opened the screen.
  assert.equal(day.assessments[0].moment.at, T('2026-09-26T08:14:32Z'));
});

test('a day is as long as the clocks say, across a daylight-saving change', () => {
  // 1 November 2026 is the US fall-back: that corridor day is 25 hours long.
  const november = dayBounds('2026-11-01');
  assert.equal(november.to - november.from, 25 * 3_600_000);
  const march = dayBounds('2026-03-08');
  assert.equal(march.to - march.from, 23 * 3_600_000, 'spring forward');
  const ordinary = dayBounds('2026-10-01');
  assert.equal(ordinary.to - ordinary.from, 24 * 3_600_000);
});
