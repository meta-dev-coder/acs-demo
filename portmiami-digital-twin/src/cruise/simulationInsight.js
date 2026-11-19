/**
 * Reading a cruise parking run back: what each cruise contributes, what happens when, and why an
 * interval's numbers are what they are.
 *
 * NOTHING HERE COMPUTES DEMAND. Every figure is read from the simulation's own records — the
 * cohorts it built and the per-interval `moves` it logged — and the arithmetic shown is the same
 * arithmetic `turnaroundModel.js` performed, re-stated with its inputs. If the two ever disagreed
 * the inspector's own equation check would fail, and the tests hold them together.
 *
 * Every input carries a SOURCE_KIND, so the workspace can keep reported dock data, published
 * capacity, assumptions, modelled movements and calculated outcomes visibly apart.
 */
import { localMidnightMs, nextDate, utcMsToLocal } from './cruiseCalls.js';
import { CRUISE_ASSUMPTIONS, SOURCE_KIND } from './cruiseAssumptions.js';
import { CAPACITY_STATUS_LABEL } from './vesselMaster.js';
import { ASSUMED_DEPARTURE_TIME, INTERVAL_MS, windowShare } from './turnaroundModel.js';

const hhmm = ms => utcMsToLocal(ms).time;
const dayMonth = ms => {
  const { date } = utcMsToLocal(ms);
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};
const dateLabel = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const n0 = v => Math.round(v).toLocaleString('en-US');
const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);

// ---- one cruise's calculation ---------------------------------------------------------------------

/** Where a cohort's return (or, for an estimated cohort, its parking) comes from, in words. */
export function returnBasisText(c, a) {
  const d = c.expectedReturnDate ? dateLabel(c.expectedReturnDate) : null;
  switch (c.basis) {
    case 'ITINERARY_MATCHED': return { text: `Returns ${d}: the itinerary's scheduled return matches this ship's call that day.`, source: SOURCE_KIND.REPORTED };
    case 'RETURNS_AFTER_DATASET': return { text: `Returns ${d}, after the data ends: these cars stay parked past November 30.`, source: SOURCE_KIND.REPORTED };
    case 'ITINERARY_DATE_ASSUMED_TIME': return { text: `Returns ${d} per the itinerary; no call that day is in the report, so a 07:00 arrival is assumed.`, source: SOURCE_KIND.ASSUMED };
    case 'NEXT_CALL': return { text: `Assumed to return at this ship's next call in the report (${d}). The voyage itself is not listed.`, source: SOURCE_KIND.ASSUMED };
    case 'NO_LATER_CALL': return { text: 'No later call of this ship in the report: the cars stay parked to the end of the data.', source: SOURCE_KIND.ASSUMED };
    case 'ASSUMED_NIGHTS_MATCHED': return { text: `Returns ${d}, the assumed ${a.assumedVoyageNights}-night voyage, which matches a call that day.`, source: SOURCE_KIND.ASSUMED };
    case 'ASSUMED_NIGHTS_ASSUMED_TIME': return { text: `Returns ${d}, the assumed ${a.assumedVoyageNights}-night voyage; arrival time assumed 07:00.`, source: SOURCE_KIND.ASSUMED };
    case 'RETURN_ALREADY_CLAIMED': return { text: 'The next call already brings back another sailing\'s cars, so this return is unknown; the cars stay parked.', source: SOURCE_KIND.ASSUMED };
    case 'ESTIMATED_ASSUMED_VOYAGE': return {
      text: `ESTIMATE. No earlier departure of this ship is in the report. Its passengers' cars are assumed parked for a sailing that left ${dayMonth(c.assumedDepartureMs)} at ${ASSUMED_DEPARTURE_TIME}, ${a.assumedVoyageNights} nights before this arrival${c.initial ? ' — before the data begins, so they are already parked on November 1' : ''}.`,
      source: SOURCE_KIND.ASSUMED,
    };
    case 'ESTIMATED_PARKED_AT_START': return { text: 'ESTIMATE. No earlier departure of this ship is in the report; its passengers\' cars are assumed parked since before November 1.', source: SOURCE_KIND.ASSUMED };
    default: return { text: 'Return not determined.', source: SOURCE_KIND.ASSUMED };
  }
}

const input = (label, value, unit, source, note) => ({ label, value, unit, source, note });
const dateShort = date => (date ? dateLabel(date) : '—');

/**
 * The passenger and vehicle arithmetic for one cohort, READ FROM THE COHORT: the inputs the engine
 * stored when it built it (`cohort.inputs`), never today's assumptions. A returning row for cars
 * parked by an earlier departure therefore shows that departure's values and date.
 * `check` recomputes the arithmetic from those inputs and confirms it gives the stored count.
 */
export function cohortCalculation(cohort, { call } = {}) {
  const x = cohort.inputs;
  const estimated = cohort.kind === 'ESTIMATED_RETURN';
  const who = x.side;
  const Who = who === 'departing' ? 'Departing' : 'Returning';
  const assumed = key => ((x.editedForCruise ?? []).includes(key)
    ? { source: SOURCE_KIND.CONFIGURED, note: `Edited for this cruise only (${call?.shipName ?? cohort.shipName}).` }
    : x.editedForDate.includes(key)
      ? { source: SOURCE_KIND.CONFIGURED, note: `Edited for ${dateShort(x.assumptionDate)} only.` }
      : { source: SOURCE_KIND.ASSUMED, note: CRUISE_ASSUMPTIONS[key].basis });
  const occ = assumed(`${who}OccupancyPct`), share = assumed(`${who}LongStayPct`), ppv = assumed(`${who}PassengersPerVehicle`);
  const steps = [
    {
      title: 'Estimated passengers',
      inputs: [
        input('Published passenger capacity', x.capacity, 'berths', SOURCE_KIND.PUBLISHED, 'From the enriched Dock Report. A capacity, not a passenger count.'),
        input(`${Who} ship occupancy (${dateShort(x.assumptionDate)})`, x.occupancyPct, '%', occ.source, occ.note),
      ],
      formula: `${n0(x.capacity)} × ${x.occupancyPct}% = ${(x.capacity * x.occupancyPct / 100).toFixed(1)} → ${n0(x.passengers)} (rounded to whole passengers)`,
      output: { value: x.passengers, unit: 'passengers', source: SOURCE_KIND.CALCULATED },
    },
    {
      title: 'Long-stay parked cars',
      inputs: [
        input('Estimated passengers', x.passengers, 'passengers', SOURCE_KIND.CALCULATED),
        input(`${Who} long-stay parking share (${dateShort(x.assumptionDate)})`, x.longStayPct, '%', share.source, share.note),
        input(`${Who} passengers per parked car (${dateShort(x.assumptionDate)})`, x.passengersPerVehicle, 'passengers', ppv.source, ppv.note),
      ],
      formula: `⌈${n0(x.passengers)} × ${x.longStayPct}% ÷ ${x.passengersPerVehicle}⌉ = ⌈${x.exact.toFixed(2)}⌉ = ${n0(x.vehicles)} (rounded up to whole cars)`,
      output: { value: x.vehicles, unit: 'cars', source: SOURCE_KIND.CALCULATED },
    },
  ];
  const timing = [];
  if (Number.isFinite(cohort.entryStartMs)) {
    const w = cohort.entryWindowInputs;
    timing.push({
      kind: 'ENTRY',
      title: estimated ? 'Parked for the earlier sailing (estimated)' : 'Cars arrive to park before departure',
      startMs: cohort.entryStartMs, endMs: cohort.entryEndMs,
      text: `${hhmm(cohort.entryStartMs)}–${hhmm(cohort.entryEndMs)} ${dayMonth(cohort.entryStartMs)}: ${w.startMin} to ${w.endMin} min before ${estimated ? `the assumed ${ASSUMED_DEPARTURE_TIME} departure` : `the reported ${hhmm(call?.departureMs ?? cohort.entryEndMs)} departure`}, peaking at ${Math.round(w.peak * 100)}% of the window.`,
      source: SOURCE_KIND.ASSUMED,
    });
  }
  if (Number.isFinite(cohort.exitStartMs)) {
    const w = cohort.exitWindowInputs;
    timing.push({
      kind: 'EXIT',
      title: 'Cars leave after disembarkation',
      startMs: cohort.exitStartMs, endMs: cohort.exitEndMs,
      text: `${hhmm(cohort.exitStartMs)}–${hhmm(cohort.exitEndMs)} ${dayMonth(cohort.exitStartMs)}: ${w.startMin} to ${w.endMin} min after the ship's arrival, peaking at ${Math.round(w.peak * 100)}% of the window.`,
      source: SOURCE_KIND.ASSUMED,
    });
  }
  const recomputed = Math.max(0, Math.ceil((Math.round((x.capacity * x.occupancyPct) / 100) * x.longStayPct) / 100 / x.passengersPerVehicle - 1e-9));
  return {
    cohortId: cohort.id,
    kind: cohort.kind,
    side: who,
    estimated,
    inputs: x,
    steps,
    passengers: x.passengers,
    vehicles: x.vehicles,
    check: recomputed === cohort.vehicles && x.vehicles === cohort.vehicles,
    timing,
    basis: returnBasisText(cohort, { assumedVoyageNights: cohort.assumedVoyageNights }),
  };
}

// ---- the cruises of a day ----------------------------------------------------------------------------

/**
 * Every call on a date with what it moves: the cars leaving after it arrives, the cars parking for
 * its departure, and how complete the data behind both is.
 */
export function dayCruises(sim, calls, date, { skipped = [] } = {}) {
  const dayStart = localMidnightMs(date), dayEnd = localMidnightMs(nextDate(date));
  const callById = new Map(calls.map(c => [c.id, c]));
  return calls.filter(c => c.arrivalMs < dayEnd && c.departureMs >= dayStart)
    .sort((x, y) => x.arrivalMs - y.arrivalMs || x.shipName.localeCompare(y.shipName))
    .map(call => {
      const returning = sim.cohorts.find(c => c.returnCallId === call.id) ?? null;
      const departing = sim.cohorts.find(c => c.kind === 'DEPARTING' && c.callId === call.id) ?? null;
      const skip = skipped.find(s => s.callId === call.id) ?? null;
      // Where the returning cars come from: a departure in the report (reconstructed: its stored
      // count) or an estimate from this arrival's returning assumptions.
      const origin = returning?.kind === 'DEPARTING' ? callById.get(returning.callId) ?? null : null;
      const returningSource = !returning ? null : origin
        ? { kind: 'RECONSTRUCTED', label: `Reconstructed: parked by ${returning.shipName} departing ${dateShort(returning.departureDate)}`, originCallId: origin.id, originDockRequest: origin.dockRequestNumber, originDate: returning.departureDate }
        : { kind: 'ESTIMATED', label: 'Estimate: returning assumptions' };
      const completeness = !call.passengerCapacity
        ? { level: 'NONE', label: `${CAPACITY_STATUS_LABEL[call.capacityStatus] ?? CAPACITY_STATUS_LABEL.NOT_YET_SOURCED} — not modelled` }
        : skip ? { level: 'PARTIAL', label: 'One-way voyage — no parking for it' }
          : returning?.kind === 'ESTIMATED_RETURN' ? { level: 'PARTIAL', label: 'Returning cars estimated' }
            : departing && ['NEXT_CALL', 'NO_LATER_CALL', 'RETURN_ALREADY_CLAIMED', 'ASSUMED_NIGHTS_MATCHED', 'ASSUMED_NIGHTS_ASSUMED_TIME', 'ITINERARY_DATE_ASSUMED_TIME'].includes(departing.basis)
              ? { level: 'PARTIAL', label: 'Return date assumed' }
              : { level: 'FULL', label: 'Capacity and voyage from data' };
      return {
        call,
        returning,
        departing,
        originCall: origin,
        skipped: skip,
        returningSource,
        // Cars that actually leave: those of the cohort that found a space. Never more than the cohort.
        leavingVehicles: returning ? returning.servedTotal : null,
        // Where they are parked: the garages that cohort's cars went into, which they leave from.
        returningParkedByGarage: returning ? Object.entries(returning.served ?? {}).filter(([, n]) => n > 0)
          .map(([facilityId, n]) => ({ facilityId, name: sim.facilities.find(f => f.id === facilityId)?.name ?? facilityId, n })) : [],
        returningNoData: returning ? returning.noData : null,
        returningCohortVehicles: returning ? returning.vehicles : null,
        returningWithoutSpace: returning ? returning.unserved : null,
        enteringVehicles: departing?.vehicles ?? null,
        returningCalc: returning ? cohortCalculation(returning, { call: origin ?? call }) : null,
        departingCalc: departing ? cohortCalculation(departing, { call }) : null,
        completeness,
      };
    });
}

// ---- events -----------------------------------------------------------------------------------------

const EVENT_ORDER = ['ARRIVAL', 'EXITS_START', 'EXITS_END', 'ENTRIES_START', 'ENTRIES_END', 'DEPARTURE', 'NEAR_CAPACITY', 'CAPACITY', 'PEAK'];

/**
 * The day's events in time order, each pinned to the 15-minute interval it falls in.
 * Ship times are reported; parking windows are modelled from assumptions; peak and capacity
 * events are read from the simulated timeline.
 */
export function dayEvents({ sim, summary, calls, date, redPct = 90 }) {
  const dayStart = localMidnightMs(date), dayEnd = localMidnightMs(nextDate(date));
  const within = ms => Number.isFinite(ms) && ms >= dayStart && ms < dayEnd;
  const indexOf = ms => Math.min(summary.timeline.length - 1, Math.max(0, Math.floor((ms - dayStart) / INTERVAL_MS)));
  const name = id => sim.facilities.find(f => f.id === id)?.name ?? id;
  const events = [];
  const push = (kind, ms, text, extra = {}) => events.push({ id: `${kind}-${events.length}`, kind, ms, index: indexOf(ms), time: hhmm(ms), text, ...extra });

  for (const call of calls.filter(c => c.arrivalMs < dayEnd && c.departureMs >= dayStart)) {
    const modelled = Boolean(call.passengerCapacity);
    if (within(call.arrivalMs)) push('ARRIVAL', call.arrivalMs, `${call.shipName} arrives at Terminal ${call.terminalCode}`, { callId: call.id, source: SOURCE_KIND.REPORTED, modelled });
    if (within(call.departureMs)) push('DEPARTURE', call.departureMs, `${call.shipName} departs Terminal ${call.terminalCode}`, { callId: call.id, source: SOURCE_KIND.REPORTED, modelled });
  }
  for (const c of sim.cohorts) {
    const moved = c.servedTotal + c.unserved;
    if (within(c.exitStartMs) && c.servedTotal > 0) {
      push('EXITS_START', c.exitStartMs, `${c.shipName}: ${n0(c.servedTotal)} parked cars start leaving (until ${hhmm(c.exitEndMs)})`, { callId: c.returnCallId, cohortId: c.id, source: SOURCE_KIND.MODELLED, estimated: c.kind === 'ESTIMATED_RETURN' });
    }
    if (within(c.exitEndMs) && c.servedTotal > 0) {
      push('EXITS_END', c.exitEndMs, `${c.shipName}: last returning cars have left`, { callId: c.returnCallId, cohortId: c.id, source: SOURCE_KIND.MODELLED });
    }
    if (!c.initial && within(c.entryStartMs) && moved > 0) {
      const label = c.kind === 'ESTIMATED_RETURN'
        ? `Estimated: ${n0(moved)} cars park for an earlier ${c.shipName} sailing not in the report (until ${hhmm(c.entryEndMs)})`
        : `${c.shipName}: ${n0(moved)} cars start arriving to park for the voyage (until ${hhmm(c.entryEndMs)})`;
      push('ENTRIES_START', c.entryStartMs, label, { callId: c.callId, cohortId: c.id, source: SOURCE_KIND.MODELLED, estimated: c.kind === 'ESTIMATED_RETURN' });
    }
    if (!c.initial && within(c.entryEndMs) && moved > 0) {
      push('ENTRIES_END', c.entryEndMs, `${c.shipName}: parking arrivals end`, { callId: c.callId, cohortId: c.id, source: SOURCE_KIND.MODELLED });
    }
  }

  // Capacity: the first interval a facility crosses the red threshold, and the first it is full
  // or turns a car away.
  const seenRed = new Set(), seenFull = new Set();
  summary.timeline.forEach((t, i) => {
    for (const f of summary.facilities) {
      const r = t.facilities[f.id];
      if (!r || !Number.isFinite(f.capacity) || !f.capacity) continue;
      const pct = (r.end / f.capacity) * 100;
      if ((r.end >= f.capacity || r.unserved > 0) && !seenFull.has(f.id)) {
        seenFull.add(f.id);
        events.push({ id: `CAPACITY-${f.id}`, kind: 'CAPACITY', ms: t.startMs, index: i, time: t.time, source: SOURCE_KIND.CALCULATED,
          text: r.unserved > 0 ? `${name(f.id)} is full: ${n0(r.unserved)} cars cannot be parked there` : `${name(f.id)} reaches capacity (${n0(f.capacity)})` });
      } else if (pct >= redPct && !seenRed.has(f.id) && !seenFull.has(f.id)) {
        seenRed.add(f.id);
        events.push({ id: `NEAR-${f.id}`, kind: 'NEAR_CAPACITY', ms: t.startMs, index: i, time: t.time, source: SOURCE_KIND.CALCULATED,
          text: `${name(f.id)} passes ${redPct}% occupied` });
      }
    }
  });
  if (summary.peakTime) {
    const i = summary.timeline.findIndex(t => t.time === summary.peakTime);
    if (i >= 0) events.push({ id: 'PEAK', kind: 'PEAK', ms: summary.timeline[i].startMs, index: i, time: summary.peakTime, source: SOURCE_KIND.CALCULATED,
      text: `Peak parking occupancy: ${n0(summary.peakOccupied)} cars` });
  }
  return events.sort((x, y) => x.ms - y.ms || EVENT_ORDER.indexOf(x.kind) - EVENT_ORDER.indexOf(y.kind));
}

// ---- one interval -------------------------------------------------------------------------------------

/**
 * Everything that happened in one 15-minute interval of the day, from the simulation's own
 * records: totals with the occupancy equation, then each facility, then each cohort's moves with
 * the window weight and allocation that produced them.
 */
export function inspectInterval({ sim, summary, calls, index }) {
  const t = summary.timeline[index];
  if (!t) return null;
  const rec = sim.intervals.find(r => r.startMs === t.startMs);
  const callById = new Map(calls.map(c => [c.id, c]));
  const cohortById = new Map(sim.cohorts.map(c => [c.id, c]));
  const facilities = summary.facilities.map(f => {
    const r = t.facilities[f.id];
    const moves = rec.moves.filter(m => m.facilityId === f.id);
    return {
      id: f.id, name: f.name, capacity: f.capacity, proposed: f.proposed, addedSpaces: f.addedSpaces,
      start: r.start, served: r.served, exits: r.exits, end: r.end, unserved: r.unserved, overflowIn: r.overflowIn,
      remaining: Number.isFinite(f.capacity) ? f.capacity - r.end : null,
      utilisationPct: Number.isFinite(f.capacity) && f.capacity ? (r.end / f.capacity) * 100 : null,
      moves,
    };
  });
  const totals = {
    start: sum(facilities, f => f.start),
    served: sum(facilities, f => f.served),
    exits: sum(facilities, f => f.exits),
    end: sum(facilities, f => f.end),
    unserved: sum(facilities, f => f.unserved) + (rec.unallocated ?? 0),
    capacity: summary.capacity,
  };
  totals.remaining = totals.capacity - sum(facilities.filter(f => Number.isFinite(f.capacity)), f => f.end);
  const equation = { ...totals, ok: totals.end === totals.start + totals.served - totals.exits };

  // Per cohort: what it did in this interval and why that many.
  const ids = [...new Set(rec.moves.map(m => m.cohortId))];
  const cohorts = ids.map(id => {
    const c = cohortById.get(id);
    const moves = rec.moves.filter(m => m.cohortId === id);
    const call = callById.get(c.callId);
    const calc = cohortCalculation(c, { call });
    const entering = moves.filter(m => m.type !== 'OUT');
    const leaving = moves.filter(m => m.type === 'OUT');
    const out = { cohort: c, call, calc, moves };
    if (entering.length) {
      const share = windowShare(c.entryStartMs, c.entryEndMs, t.startMs, t.startMs + INTERVAL_MS, c.entryPeak);
      const n = sum(entering, m => m.n);
      out.entry = {
        weightPct: share * 100, exact: share * c.vehicles, vehicles: n,
        allocation: (sim.allocations[c.terminalCode] ?? []).map(r => ({ facilityId: r.facilityId, name: sim.facilities.find(f => f.id === r.facilityId)?.name ?? r.facilityId, sharePct: r.sharePct })),
        placed: entering.map(m => ({ ...m, name: m.facilityId ? (sim.facilities.find(f => f.id === m.facilityId)?.name ?? m.facilityId) : null })),
      };
    }
    if (leaving.length) {
      out.exit = leaving.map(m => {
        const parked = c.served[m.facilityId] ?? 0;
        const share = windowShare(c.exitStartMs, c.exitEndMs, t.startMs, t.startMs + INTERVAL_MS, c.exitPeak);
        return { facilityId: m.facilityId, name: sim.facilities.find(f => f.id === m.facilityId)?.name ?? m.facilityId, parked, weightPct: share * 100, exact: share * parked, vehicles: m.n };
      });
    }
    return out;
  });
  return { index, time: t.time, endTime: hhmm(t.startMs + INTERVAL_MS), startMs: t.startMs, totals, equation, facilities, cohorts };
}

/**
 * "What's happening at this time?" — sentences generated from the interval's records and the
 * reported ship times. Nothing is written that the data or the run does not contain.
 */
export function explainInterval({ sim, summary, calls, index, amberPct = 70, redPct = 90 }) {
  const t = summary.timeline[index];
  if (!t) return [];
  const a = t.startMs, b = a + INTERVAL_MS;
  const rec = sim.intervals.find(r => r.startMs === a);
  const name = id => sim.facilities.find(f => f.id === id)?.name ?? id;
  const cohortById = new Map(sim.cohorts.map(c => [c.id, c]));
  const out = [];
  const say = (kind, text, source) => out.push({ kind, text, source });

  const inPort = calls.filter(c => c.arrivalMs < b && c.departureMs > a);
  for (const c of calls.filter(x => x.arrivalMs >= a && x.arrivalMs < b)) {
    say('ARRIVAL', `${c.shipName} arrives at Terminal ${c.terminalCode} at ${hhmm(c.arrivalMs)}.${c.passengerCapacity ? '' : ` ${CAPACITY_STATUS_LABEL[c.capacityStatus] ?? CAPACITY_STATUS_LABEL.NOT_YET_SOURCED}, so its passengers are not modelled.`}`, SOURCE_KIND.REPORTED);
  }
  for (const c of calls.filter(x => x.departureMs >= a && x.departureMs < b)) {
    say('DEPARTURE', `${c.shipName} departs Terminal ${c.terminalCode} at ${hhmm(c.departureMs)}.`, SOURCE_KIND.REPORTED);
  }
  const alongside = inPort.filter(c => !(c.arrivalMs >= a && c.arrivalMs < b) && !(c.departureMs >= a && c.departureMs < b));
  if (alongside.length) {
    say('IN_PORT', `In port: ${alongside.map(c => `${c.shipName} (Terminal ${c.terminalCode}, ${hhmm(c.arrivalMs)}–${hhmm(c.departureMs)})`).join('; ')}.`, SOURCE_KIND.REPORTED);
  }

  const byCohort = new Map();
  for (const m of rec.moves) {
    if (!byCohort.has(m.cohortId)) byCohort.set(m.cohortId, { OUT: 0, IN: 0, OVERFLOW: 0, UNSERVED: 0, UNALLOCATED: 0, facilities: new Set() });
    const g = byCohort.get(m.cohortId);
    g[m.type] += m.n;
    if (m.facilityId) g.facilities.add(name(m.facilityId));
  }
  for (const [id, g] of byCohort) {
    const c = cohortById.get(id);
    const where = [...g.facilities].join(', ');
    if (g.OUT) {
      say('EXITS', `Passengers from ${c.shipName} are disembarking: ${n0(g.OUT)} cars leave ${where} (exit window ${hhmm(c.exitStartMs)}–${hhmm(c.exitEndMs)}${c.kind === 'ESTIMATED_RETURN' ? '; these cars are an estimate' : ''}).`, SOURCE_KIND.MODELLED);
    }
    const entered = g.IN + g.OVERFLOW;
    if (entered || g.UNSERVED || g.UNALLOCATED) {
      const dep = calls.find(x => x.id === c.callId);
      const why = c.kind === 'ESTIMATED_RETURN'
        ? `for an earlier ${c.shipName} sailing not in the report (estimate)`
        : `for ${c.shipName}, departing ${hhmm(dep.departureMs)} from Terminal ${c.terminalCode}`;
      const parts = [`${n0(entered)} cars park ${why}`];
      if (g.OVERFLOW) parts.push(`${n0(g.OVERFLOW)} of them overflow to another facility`);
      if (g.UNSERVED) parts.push(`${n0(g.UNSERVED)} find no space`);
      if (g.UNALLOCATED) parts.push(`${n0(g.UNALLOCATED)} have no garage linked to Terminal ${c.terminalCode}`);
      say('ENTRIES', `${parts.join('; ')}${where ? ` (${where})` : ''}.`, SOURCE_KIND.MODELLED);
    }
  }
  // Departing ships whose parking window is open but which moved nothing this interval are not
  // mentioned: the sentence would carry no number.

  const start = sum(summary.facilities, f => t.facilities[f.id]?.start ?? 0);
  const end = sum(summary.facilities, f => t.facilities[f.id]?.end ?? 0);
  if (!rec.moves.length) {
    say('QUIET', `No modelled cruise vehicle moves between ${t.time} and ${hhmm(b)}. ${n0(end)} cars remain parked.`, SOURCE_KIND.CALCULATED);
  } else {
    const delta = end - start;
    say('OCCUPANCY', `Occupancy goes from ${n0(start)} to ${n0(end)} cars (${delta >= 0 ? '+' : '−'}${n0(Math.abs(delta))}).`, SOURCE_KIND.CALCULATED);
  }
  const hot = summary.facilities
    .map(f => ({ f, r: t.facilities[f.id] }))
    .filter(({ f, r }) => r && Number.isFinite(f.capacity) && f.capacity && (r.end / f.capacity) * 100 >= amberPct)
    .map(({ f, r }) => `${f.name} ${Math.round((r.end / f.capacity) * 100)}% (${n0(f.capacity - r.end)} free)`);
  if (hot.length) say('CAPACITY', `Approaching capacity (≥ ${amberPct}%): ${hot.join('; ')}.${hot.some(h => Number(h.match(/ (\d+)%/)?.[1]) >= redPct) ? ` At or above the ${redPct}% red threshold.` : ''}`, SOURCE_KIND.CALCULATED);
  else if (summary.facilities.some(f => Number.isFinite(f.capacity))) say('CAPACITY', `No garage is above ${amberPct}% occupied.`, SOURCE_KIND.CALCULATED);
  return out;
}

// ---- one cruise against the garages ----------------------------------------------------------------------

export const PARKING_OUTCOME = Object.freeze({
  ALL: 'ALL',
  PARTIAL: 'PARTIAL',
  NONE: 'NONE',
  ASSIGNMENT_MISSING: 'ASSIGNMENT_MISSING',
  CAPACITY_DATA_UNAVAILABLE: 'CAPACITY_DATA_UNAVAILABLE',
  NOT_MODELLED: 'NOT_MODELLED',
  NO_PARKING_DEMAND: 'NO_PARKING_DEMAND',
  NOT_USED: 'NOT_USED',
});

export const PARKING_OUTCOME_LABEL = Object.freeze({
  ALL: 'All requested cars accommodated',
  PARTIAL: 'Partially accommodated',
  NONE: 'No available capacity',
  ASSIGNMENT_MISSING: 'Garage assignment missing',
  CAPACITY_DATA_UNAVAILABLE: 'Capacity data unavailable',
  NOT_MODELLED: 'Not modelled — passenger capacity not validated',
  NO_PARKING_DEMAND: 'No parking demand for this cruise',
  NOT_USED: 'Not needed — the cruise’s cars fit elsewhere first',
});

const PARKED = new Set(['IN', 'SPILL', 'OVERFLOW']);

/**
 * How one cruise's departing cars meet the garages, read from the run's own records:
 * which garages it may use and why, how full each was when its cars began to arrive, how many of
 * its cars each took, how many found no space, which other cruises were parking there at the same
 * time, and — at the selected interval — the garage's start, exits, entries and free spaces.
 *
 * Never reports success where data is missing: no mapped garage, an unvalidated passenger capacity
 * or an unpublished garage capacity each produce their own outcome.
 */
export function cruiseGarageImpact({ sim, summary, calls, call, index }) {
  if (!call) return null;
  const dep = sim.cohorts.find(c => c.kind === 'DEPARTING' && c.callId === call.id) ?? null;
  const ret = sim.cohorts.find(c => c.returnCallId === call.id) ?? null;
  const code = call.terminalCode;
  const byId = new Map(sim.facilities.map(f => [f.id, f]));
  const mapped = (sim.allocations[code] ?? []).filter(r => byId.has(r.facilityId));
  const overflow = sim.facilities.filter(f => !mapped.some(r => r.facilityId === f.id)
    && (f.scope === 'ANY_TERMINAL' || (Array.isArray(f.scope) && f.scope.includes(code)) || (f.proposed && f.servesTerminals.includes(code))))
    .sort((x, y) => Number(x.proposed) - Number(y.proposed) || x.id.localeCompare(y.id));
  const cohortById = new Map(sim.cohorts.map(c => [c.id, c]));
  const t = summary.timeline[index] ?? null;
  const recAt = t ? sim.intervals.find(r => r.startMs === t.startMs) : null;

  // The departing cohort's parking window, as simulation intervals.
  const window = dep && Number.isFinite(dep.entryStartMs)
    ? sim.intervals.filter(r => r.startMs + INTERVAL_MS > dep.entryStartMs && r.startMs < dep.entryEndMs) : [];
  const depMoves = window.flatMap(r => r.moves.filter(m => m.cohortId === dep.id));
  const sumMoves = (list, pred) => list.filter(pred).reduce((s, m) => s + m.n, 0);

  const garages = [...mapped.map(r => ({ f: byId.get(r.facilityId), row: r, role: 'MAPPED' })), ...overflow.map(f => ({ f, row: null, role: 'OVERFLOW' }))]
    .map(({ f, row, role }) => {
      const first = window[0]?.facilities[f.id], last = window.at(-1)?.facilities[f.id];
      const accommodated = sumMoves(depMoves, m => m.facilityId === f.id && PARKED.has(m.type));
      const unserved = sumMoves(depMoves, m => m.facilityId === f.id && m.type === 'UNSERVED');
      const noData = sumMoves(depMoves, m => m.facilityId === f.id && m.type === 'NO_CAPACITY_DATA');
      const competing = new Map();
      for (const r of window) {
        for (const m of r.moves) {
          if (m.facilityId !== f.id || m.cohortId === dep?.id || !PARKED.has(m.type)) continue;
          const c = cohortById.get(m.cohortId);
          competing.set(c.shipName, (competing.get(c.shipName) ?? 0) + m.n);
        }
      }
      const releasing = window.reduce((s, r) => s + r.facilities[f.id].exits, 0);
      const known = Number.isFinite(f.capacity);
      const outcome = !known ? PARKING_OUTCOME.CAPACITY_DATA_UNAVAILABLE
        : accommodated + unserved === 0 ? PARKING_OUTCOME.NOT_USED
          : unserved === 0 ? PARKING_OUTCOME.ALL : accommodated > 0 ? PARKING_OUTCOME.PARTIAL : PARKING_OUTCOME.NONE;
      const now = recAt?.facilities[f.id];
      const cruiseNow = recAt ? recAt.moves.filter(m => m.cohortId === dep?.id && m.facilityId === f.id) : [];
      return {
        id: f.id, name: f.name, role, priority: row?.priority ?? null, sharePct: row?.sharePct ?? null, maxSharePct: row?.maxSharePct ?? null,
        capacity: f.capacity, capacitySource: f.capacitySource ?? null, addedSpaces: f.addedSpaces, proposed: f.proposed,
        occupiedBefore: first?.start ?? null,
        availableBefore: known && first ? Math.max(0, f.capacity - first.start) : null,
        releasingDuringWindow: releasing,
        accommodated, unserved, noData,
        occupiedAfter: last?.end ?? null,
        availableAfter: known && last ? Math.max(0, f.capacity - last.end) : null,
        competing: [...competing].map(([ship, cars]) => ({ ship, cars })).sort((a, b) => b.cars - a.cars || a.ship.localeCompare(b.ship)),
        outcome,
        now: now ? {
          start: now.start, exits: now.exits, entries: now.served, requested: now.demand, end: now.end, unserved: now.unserved,
          available: known ? Math.max(0, f.capacity - now.end) : null,
          utilisationPct: known && f.capacity ? (now.end / f.capacity) * 100 : null,
          cruiseRequested: cruiseNow.filter(m => m.type !== 'OUT').reduce((s, m) => s + m.n, 0),
          cruiseAccommodated: sumMoves(cruiseNow, m => PARKED.has(m.type)),
          cruiseUnserved: sumMoves(cruiseNow, m => m.type === 'UNSERVED'),
        } : null,
      };
    });

  const requested = dep?.vehicles ?? 0;
  const accommodated = garages.reduce((s, g) => s + g.accommodated, 0);
  const unserved = sumMoves(depMoves, m => m.type === 'UNSERVED');
  const unallocated = sumMoves(depMoves, m => m.type === 'UNALLOCATED');
  const noData = sumMoves(depMoves, m => m.type === 'NO_CAPACITY_DATA');
  const overflowCars = sumMoves(depMoves, m => m.type === 'OVERFLOW');
  const outcome = !call.passengerCapacity ? PARKING_OUTCOME.NOT_MODELLED
    : !dep || requested === 0 ? PARKING_OUTCOME.NO_PARKING_DEMAND
      : !garages.length ? PARKING_OUTCOME.ASSIGNMENT_MISSING
        : noData > 0 && accommodated === 0 ? PARKING_OUTCOME.CAPACITY_DATA_UNAVAILABLE
          : unserved + unallocated + noData === 0 ? PARKING_OUTCOME.ALL
            : accommodated > 0 ? PARKING_OUTCOME.PARTIAL : PARKING_OUTCOME.NONE;

  // The explanation, from the numbers above.
  const policy = sim.allocationPolicy === 'PRIORITY' ? 'fill-in-priority-order' : 'split-by-share';
  const lines = [];
  if (dep && requested) {
    lines.push(`${n0(requested)} cars are estimated to require long-stay parking for ${call.shipName}, arriving ${hhmm(dep.entryStartMs)}–${hhmm(dep.entryEndMs)} for its ${hhmm(call.departureMs)} departure.`);
    const avail = garages.filter(g => g.availableBefore !== null);
    if (avail.length) lines.push(`When its cars begin to arrive, ${avail.map(g => `${g.name} has ${n0(g.availableBefore)} free of ${n0(g.capacity)}`).join('; ')}.`);
    const others = garages.flatMap(g => g.competing.map(c => `${c.ship} (${n0(c.cars)} into ${g.name})`));
    if (others.length) lines.push(`Competing for the same spaces in that window: ${others.join(', ')}.`);
    lines.push(`Under the ${policy} policy, ${n0(accommodated)} cars are accommodated${overflowCars ? ` (${n0(overflowCars)} as overflow)` : ''}${unserved ? ` and ${n0(unserved)} find no space` : ''}${noData ? `; ${n0(noData)} go to a garage with no published capacity and cannot be checked` : ''}${unallocated ? `; ${n0(unallocated)} have no garage mapped to Terminal ${code}` : ''}.`);
  }
  return {
    call, departing: dep, returning: ret, terminalCode: code,
    requested, accommodated, unserved, unallocated, noData, overflow: overflowCars,
    releasing: ret ? ret.servedTotal : 0,
    windowStart: dep && Number.isFinite(dep.entryStartMs) ? hhmm(dep.entryStartMs) : null,
    windowEnd: dep && Number.isFinite(dep.entryEndMs) ? hhmm(dep.entryEndMs) : null,
    garages, outcome, explanation: lines,
  };
}
