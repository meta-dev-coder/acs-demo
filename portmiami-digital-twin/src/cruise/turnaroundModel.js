/**
 * The cruise-turnaround parking model: cohorts of parked vehicles, simulated in 15-minute steps.
 *
 * A TURNAROUND IS TWO MOVEMENTS, NOT ONE NUMBER.
 *   Returning: the ship arrives, passengers disembark, and the vehicles they left for the voyage
 *              EXIT over the disembarkation window.
 *   Departing: new passengers arrive, some park, and those vehicles ENTER over the embarkation
 *              window — and stay, as a COHORT, until that voyage comes back.
 * Occupancy is therefore carried from interval to interval:
 *   occupancy(t+1) = occupancy(t) + served entries(t) − exits(t)
 * Passenger capacity is never added to a garage; only parked vehicles are, and only a stated
 * share of passengers parks.
 *
 * WHERE A COHORT'S RETURN COMES FROM. The Dock Report's arrival and departure on one day describe
 * a PORT CALL, not a voyage, so they are never used as a voyage length. A departing cohort's
 * return is, in order: the itinerary's scheduled return date where exactly one option returns to
 * Miami and the ship calls on that date; otherwise the configured policy — by default the same
 * ship's next call in the report. A return after November 30 keeps the cohort parked past the end
 * of the data; it is never dropped at month-end.
 *
 * WHERE A COHORT CANNOT BE RECONSTRUCTED. A ship arriving with no earlier departure in the report
 * carries passengers whose cars were parked for a sailing the report does not hold. Those vehicles
 * are an ESTIMATED returning cohort, from the separate returning-passenger assumptions, labelled as
 * estimated everywhere it appears. By default (`returningCohortPolicy`) the earlier sailing is
 * placed the assumed voyage length before the arrival, departing at an assumed 16:00: before
 * November 1 its cars are parked when the simulation starts; later, they enter on that day like
 * any departing cohort. The alternative policy parks them all from November 1 — which for a ship
 * first seen on November 22 holds its cars for three weeks it was not here.
 *
 * DETERMINISTIC. No randomness and no clock: windows are triangular profiles integrated exactly
 * over each interval and rounded to whole vehicles by largest remainder, ties broken by interval
 * order, so the same inputs reproduce the same run to the vehicle.
 */
import { NOV_END, isSimulable, localMidnightMs, localToUtcMs, nextDate, utcMsToLocal } from './cruiseCalls.js';
import { PROPOSED_SCOPE, RETURNING_COHORT_POLICY, VOYAGE_POLICY, cruiseAssumptions } from './cruiseAssumptions.js';

export const INTERVAL_MIN = 15;
export const INTERVAL_MS = INTERVAL_MIN * 60_000;

/** An assumed arrival time, used only when a return date is known but no call is in the report. */
const ASSUMED_RETURN_TIME = '07:00';
/** An assumed departure time for the earlier sailing an estimated returning cohort parked for. */
export const ASSUMED_DEPARTURE_TIME = '16:00';

/** `date` (YYYY-MM-DD) moved by whole days. */
const addDays = (date, days) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// ---- vehicles from passengers -------------------------------------------------------------------

/**
 * Parked cars for one sailing: passengers = capacity × occupancy (whole people), then
 * cars = ⌈passengers × long-stay share ÷ passengers per car⌉. No other factor is applied.
 * Capacity 5,360 at 90% is 4,824 passengers; 12% parking at 2.5 per car is ⌈231.55⌉ = 232.
 */
export function parkedVehicles(capacity, { occupancyPct, longStayPct, passengersPerVehicle }) {
  const passengers = Math.round((capacity * occupancyPct) / 100);
  const exact = (passengers * longStayPct) / 100 / passengersPerVehicle;
  return { passengers, exact, vehicles: Math.max(0, Math.ceil(exact - 1e-9)) };
}

// ---- spreading vehicles over a window --------------------------------------------------------------

/** Cumulative share of a triangular profile on [0, 1] peaking at `c`. */
const triangularCdf = (x, c) => {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x <= c ? (x * x) / c : 1 - ((1 - x) * (1 - x)) / (1 - c);
};

/** The share of a triangular window falling in [a, b): what the profile alone gives an interval. */
export function windowShare(startMs, endMs, a, b, peakFraction = 0.5) {
  const span = Math.max(1, endMs - startMs);
  const c = Math.min(0.99, Math.max(0.01, peakFraction));
  return Math.max(0, triangularCdf((Math.min(b, endMs) - startMs) / span, c) - triangularCdf((Math.max(a, startMs) - startMs) / span, c));
}

/**
 * Whole vehicles per interval for a window, summing to exactly `total`.
 *
 * Each interval's share is the profile integrated over the part of the window it covers; the
 * fractional vehicles are handed out by largest remainder, earliest interval first on a tie.
 * Intervals before `gridStartMs` collapse into the first one, so nothing is lost at the edge.
 *
 * @returns {Map<number, number>} interval index → vehicles
 */
export function distribute(total, startMs, endMs, gridStartMs, peakFraction = 0.5) {
  const out = new Map();
  if (!(total > 0)) return out;
  const span = Math.max(1, endMs - startMs);
  const c = Math.min(0.99, Math.max(0.01, peakFraction));
  const first = Math.floor((startMs - gridStartMs) / INTERVAL_MS);
  const last = Math.floor((endMs - 1 - gridStartMs) / INTERVAL_MS);
  const rows = [];
  for (let i = first; i <= last; i += 1) {
    const a = gridStartMs + i * INTERVAL_MS, b = a + INTERVAL_MS;
    const w = triangularCdf((Math.min(b, endMs) - startMs) / span, c) - triangularCdf((Math.max(a, startMs) - startMs) / span, c);
    if (w > 0) rows.push({ i: Math.max(0, i), exact: w * total });
  }
  const sum = rows.reduce((s, r) => s + r.exact, 0) || 1;
  rows.forEach(r => { r.exact = (r.exact / sum) * total; r.n = Math.floor(r.exact); });
  let left = total - rows.reduce((s, r) => s + r.n, 0);
  [...rows].sort((x, y) => (y.exact - y.n) - (x.exact - x.n) || x.i - y.i)
    .forEach(r => { if (left > 0) { r.n += 1; left -= 1; } });
  for (const r of rows) if (r.n) out.set(r.i, (out.get(r.i) ?? 0) + r.n);
  return out;
}

/** Split whole vehicles across shares (percent), exactly, largest remainder. */
export function splitByShare(n, rows) {
  if (!rows.length || n <= 0) return rows.map(r => ({ ...r, n: 0 }));
  const total = rows.reduce((s, r) => s + Number(r.sharePct || 0), 0) || 1;
  const parts = rows.map((r, i) => {
    const exact = (n * Number(r.sharePct || 0)) / total;
    return { ...r, exact, n: Math.floor(exact), i };
  });
  let left = n - parts.reduce((s, p) => s + p.n, 0);
  [...parts].sort((x, y) => (y.exact - y.n) - (x.exact - x.n) || x.i - y.i)
    .forEach(p => { if (left > 0) { p.n += 1; left -= 1; } });
  return parts;
}

// ---- cohorts ------------------------------------------------------------------------------------

/**
 * The vessel a call belongs to, for matching a departure to its return: the IMO number where the
 * vessel master supplied one, else its vessel id, and only then the normalised ship name. The same
 * name on two hulls (or a renamed ship) is never matched by name when an IMO is known.
 */
export const vesselKey = call => (call.vesselImo ? `IMO:${call.vesselImo}`
  : call.vesselId ? `ID:${call.vesselId}` : `NAME:${String(call.shipName ?? '').trim().toUpperCase()}`);

/**
 * How far occupancy may go above 100% for a capacity basis. A double-occupancy (lower-berth)
 * capacity counts two guests per cabin, so upper berths and sofa beds can carry more: up to the
 * validated 110%. A published MAXIMUM already counts every berth, so occupancy is capped at 100%.
 */
export const OCCUPANCY_LIMIT_BY_BASIS = Object.freeze({ double_occupancy: 110, lower_berth: 110, maximum: 100 });

/** Where a cohort's car count comes from. */
export const PROVENANCE = Object.freeze({
  ASSUMPTIONS: 'ASSUMPTIONS',            // departing: published capacity × assumptions
  RECONCILED: 'RECONCILED',              // departing: a recorded reconciliation adjustment
  ESTIMATED: 'ESTIMATED',                // returning, no departure in the report: returning assumptions
  MANUAL_ESTIMATE: 'MANUAL_ESTIMATE',    // returning, no departure in the report: a recorded manual estimate
});

export const PROVENANCE_LABEL = Object.freeze({
  ASSUMPTIONS: 'Estimated from assumptions',
  RECONCILED: 'Reconciled manually',
  ESTIMATED: 'Estimated from returning assumptions',
  MANUAL_ESTIMATE: 'Manually estimated',
});

/**
 * The parked-vehicle cohorts the calls imply.
 *
 * EACH COHORT IS COMPUTED ONCE, FROM ITS OWN DATE. A departing cohort's cars come from the
 * departing assumptions in force on its departure date; an estimated returning cohort's from the
 * returning assumptions in force on its arrival date. The inputs used are stored on the cohort
 * (`inputs`), so the cars a November 15 departure parked keep that count when they return on
 * November 22 whatever is later set for November 22. Exit windows come from the arrival date's
 * values, entry windows from the departure date's.
 *
 * @param {object[]} calls  normalised calls (any; only those with capacity create cohorts)
 * @param {object} a        the month's cruise assumptions
 * A call's OWN edits (`byCruise[callId]`) sit on top of its date's: a departing cohort takes its
 * departure call's, an exit window its arrival call's. An estimated returning cohort takes its
 * arrival call's returning values; the earlier sailing it parked for is not a call in the report,
 * so its entry window uses the plain values of that assumed date.
 *
 * @param {{ byDate?: Record<string, object>, byCruise?: Record<string, object> }} options
 *        per-date and per-call edits (`cruiseAssumptions`)
 * @returns {{ cohorts: object[], skipped: object[] }}
 */
export function buildCohorts(calls, a, { byDate = {}, byCruise = {}, overrides = {} } = {}) {
  const eff = (date, callId = null) => cruiseAssumptions(a, byDate, byCruise, date, callId);
  const editedFor = (callId, test) => Object.keys(byCruise?.[callId] ?? {}).filter(test);
  const byShip = new Map();
  for (const call of calls) {
    const key = vesselKey(call);
    if (!byShip.has(key)) byShip.set(key, []);
    byShip.get(key).push(call);
  }
  for (const list of byShip.values()) list.sort((x, y) => x.arrivalMs - y.arrivalMs);

  const usable = calls.filter(isSimulable);
  const cohorts = [];
  const skipped = [];
  const claimed = new Set();

  /** The passenger → car arithmetic for one side on one date, with every input kept. */
  const carsFor = (who, call, date) => {
    const callId = call.id, capacity = call.passengerCapacity;
    const e = eff(date, callId);
    const assumedOccupancyPct = Number(e[`${who}OccupancyPct`]);
    const limit = OCCUPANCY_LIMIT_BY_BASIS[call.capacityType] ?? 100;
    const occupancyPct = Math.min(assumedOccupancyPct, limit);
    const longStayPct = Number(e[`${who}LongStayPct`]);
    const passengersPerVehicle = Number(e[`${who}PassengersPerVehicle`]);
    const { passengers, exact, vehicles } = parkedVehicles(capacity, { occupancyPct, longStayPct, passengersPerVehicle });
    return {
      side: who, assumptionDate: date, capacity, occupancyPct, passengers, longStayPct, passengersPerVehicle, exact, vehicles,
      // The capacity basis and the policy applied to it; passengers are ESTIMATED, never observed.
      capacityBasis: call.capacityType ?? null, occupancyLimitPct: limit,
      occupancyCappedFrom: assumedOccupancyPct > limit ? assumedOccupancyPct : null,
      manifestPassengers: call.actualPassengers ?? null,
      editedForDate: Object.keys(byDate?.[date] ?? {}).filter(k => k.startsWith(who)),
      editedForCruise: editedFor(callId, k => k.startsWith(who)),
      callId,
    };
  };
  const exitWindow = (arrivalMs, date, callId = null) => {
    const e = eff(date, callId);
    return {
      exitStartMs: arrivalMs + Number(e.exitStartAfterArrivalMin) * 60_000,
      exitEndMs: arrivalMs + Number(e.exitEndAfterArrivalMin) * 60_000,
      exitPeak: Number(e.exitPeakFraction),
      exitWindowInputs: { date, callId, startMin: Number(e.exitStartAfterArrivalMin), endMin: Number(e.exitEndAfterArrivalMin), peak: Number(e.exitPeakFraction),
        editedForDate: Object.keys(byDate?.[date] ?? {}).filter(k => k.startsWith('exit')), editedForCruise: editedFor(callId, k => k.startsWith('exit')) },
    };
  };
  const entryWindow = (departureMs, date, callId = null) => {
    const e = eff(date, callId);
    return {
      entryStartMs: departureMs - Number(e.entryStartBeforeDepartureMin) * 60_000,
      entryEndMs: departureMs - Number(e.entryEndBeforeDepartureMin) * 60_000,
      entryPeak: Number(e.entryPeakFraction),
      entryWindowInputs: { date, callId, startMin: Number(e.entryStartBeforeDepartureMin), endMin: Number(e.entryEndBeforeDepartureMin), peak: Number(e.entryPeakFraction),
        editedForDate: Object.keys(byDate?.[date] ?? {}).filter(k => k.startsWith('entry')), editedForCruise: editedFor(callId, k => k.startsWith('entry')) },
    };
  };
  const assumedArrival = date => localToUtcMs(`${date}T${ASSUMED_RETURN_TIME}:00`);

  for (const call of usable) {
    const options = call.voyageOptions ?? [];
    const oneWay = options.length > 0 && options.every(o => !o.returnsToMiami);
    if (oneWay && !a.oneWayVoyagesPark) {
      skipped.push({ callId: call.id, reason: `Every itinerary option ends away from Miami (${options.map(o => o.endsIn).filter(Boolean).join(', ') || 'another port'}), so no long-stay parking is assumed.` });
      continue;
    }
    const later = (byShip.get(vesselKey(call)) ?? []).filter(x => x.arrivalMs > call.departureMs);
    const returning = options.filter(o => o.returnsToMiami && o.scheduledReturnDate);
    let ret = null;

    if (options.length === 1 && returning.length === 1) {
      const date = returning[0].scheduledReturnDate;
      const match = later.find(x => x.arrivalDate === date);
      if (match) ret = { basis: 'ITINERARY_MATCHED', returnCallId: match.id, expectedReturnDate: date, ...exitWindow(match.arrivalMs, date, match.id) };
      else if (date > NOV_END) ret = { basis: 'RETURNS_AFTER_DATASET', returnCallId: null, expectedReturnDate: date };
      else ret = { basis: 'ITINERARY_DATE_ASSUMED_TIME', returnCallId: null, expectedReturnDate: date, ...exitWindow(assumedArrival(date), date) };
    } else if (a.voyagePolicy === VOYAGE_POLICY.EXCLUDE) {
      skipped.push({ callId: call.id, reason: options.length > 1
        ? 'Several itinerary options and the policy excludes ambiguous voyages.'
        : 'No itinerary and the policy excludes voyages without one.' });
      continue;
    } else if (a.voyagePolicy === VOYAGE_POLICY.ASSUMED_NIGHTS) {
      const date = addDays(call.departureDate, Number(a.assumedVoyageNights));
      const match = later.find(x => x.arrivalDate === date);
      ret = match
        ? { basis: 'ASSUMED_NIGHTS_MATCHED', returnCallId: match.id, expectedReturnDate: date, ...exitWindow(match.arrivalMs, date, match.id) }
        : date > NOV_END
          ? { basis: 'RETURNS_AFTER_DATASET', returnCallId: null, expectedReturnDate: date }
          : { basis: 'ASSUMED_NIGHTS_ASSUMED_TIME', returnCallId: null, expectedReturnDate: date, ...exitWindow(assumedArrival(date), date) };
    } else {
      const next = later[0];
      ret = next
        ? { basis: 'NEXT_CALL', returnCallId: next.id, expectedReturnDate: next.arrivalDate, ...exitWindow(next.arrivalMs, next.arrivalDate, next.id) }
        : { basis: 'NO_LATER_CALL', returnCallId: null, expectedReturnDate: null };
    }
    // One return per call: a second departure claiming the same return cannot be right.
    if (ret.returnCallId && claimed.has(ret.returnCallId)) {
      ret = { basis: 'RETURN_ALREADY_CLAIMED', returnCallId: null, expectedReturnDate: ret.expectedReturnDate };
    }
    if (ret.returnCallId) claimed.add(ret.returnCallId);

    const inputs = carsFor('departing', call, call.departureDate);
    cohorts.push({
      id: `dep-${call.id}`,
      kind: 'DEPARTING',
      callId: call.id,
      vesselKey: vesselKey(call),
      provenance: PROVENANCE.ASSUMPTIONS,
      shipName: call.shipName,
      terminalCode: call.terminalCode,
      departureDate: call.departureDate,
      passengers: inputs.passengers,
      vehicles: inputs.vehicles,
      inputs,
      ...entryWindow(call.departureMs, call.departureDate, call.id),
      ambiguous: options.length > 1,
      assumedVoyageNights: a.voyagePolicy === VOYAGE_POLICY.ASSUMED_NIGHTS ? Number(a.assumedVoyageNights) : null,
      ...ret,
    });
  }

  // Every call whose returning passengers no earlier departure accounts for gets an ESTIMATED
  // cohort, from the RETURNING assumptions of its arrival date.
  const atStart = a.returningCohortPolicy === RETURNING_COHORT_POLICY.PARKED_AT_START;
  for (const call of usable) {
    if (claimed.has(call.id)) continue;
    const inputs = carsFor('returning', call, call.arrivalDate);
    const assumedDate = atStart ? null : addDays(call.arrivalDate, -Number(a.assumedVoyageNights));
    const assumedDepartureMs = atStart ? null : localToUtcMs(`${assumedDate}T${ASSUMED_DEPARTURE_TIME}:00`);
    cohorts.push({
      id: `ret-${call.id}`,
      kind: 'ESTIMATED_RETURN',
      callId: call.id,
      vesselKey: vesselKey(call),
      provenance: PROVENANCE.ESTIMATED,
      returnCallId: call.id,
      shipName: call.shipName,
      terminalCode: call.terminalCode,
      passengers: inputs.passengers,
      vehicles: inputs.vehicles,
      inputs,
      basis: atStart ? 'ESTIMATED_PARKED_AT_START' : 'ESTIMATED_ASSUMED_VOYAGE',
      assumedDepartureMs,
      assumedVoyageNights: atStart ? null : Number(a.assumedVoyageNights),
      ...(assumedDepartureMs === null ? {} : entryWindow(assumedDepartureMs, assumedDate)),
      ...exitWindow(call.arrivalMs, call.arrivalDate, call.id),
    });
  }
  return { cohorts: cohorts.map(c => applyOverride(c, overrides[c.id], calls)), skipped };
}

/**
 * A recorded override on one cohort (see `cohortOverrides.js`). Only two kinds exist:
 *   MANUAL_ESTIMATE  an ESTIMATED returning cohort (no departure in the report): its cars and,
 *                    optionally, its exit window. The cars still enter on their assumed earlier
 *                    sailing (or are parked from the start) and leave on this arrival.
 *   RECONCILIATION   a departing cohort the report holds: its parked cars are adjusted AT THE
 *                    DEPARTURE, so the same cars enter then and leave on the return. No vehicle is
 *                    created or removed in between.
 * Any other combination is ignored: a known cohort is never changed silently.
 */
function applyOverride(cohort, o, calls) {
  if (!o || !(Number(o.vehicles) >= 0) || !String(o.reason ?? '').trim()) return cohort;
  const vehicles = Math.round(Number(o.vehicles));
  if (o.kind === 'MANUAL_ESTIMATE' && cohort.kind === 'ESTIMATED_RETURN') {
    const call = calls.find(c => c.id === cohort.callId);
    const exit = call && Number.isFinite(o.exitStartMin) && Number.isFinite(o.exitEndMin) && o.exitEndMin > o.exitStartMin
      ? { exitStartMs: call.arrivalMs + o.exitStartMin * 60_000, exitEndMs: call.arrivalMs + o.exitEndMin * 60_000,
        exitWindowInputs: { ...cohort.exitWindowInputs, startMin: o.exitStartMin, endMin: o.exitEndMin, overridden: true } }
      : {};
    return { ...cohort, ...exit, vehicles, calculatedVehicles: cohort.vehicles, provenance: PROVENANCE.MANUAL_ESTIMATE, override: o };
  }
  if (o.kind === 'RECONCILIATION' && cohort.kind === 'DEPARTING') {
    return { ...cohort, vehicles, calculatedVehicles: cohort.vehicles, provenance: PROVENANCE.RECONCILED, override: o };
  }
  return cohort;
}

// ---- the simulation -------------------------------------------------------------------------------

/**
 * Run the cohorts through the facilities, 15 minutes at a time.
 *
 * EVENT ORDER IN AN INTERVAL. Exits first, then entries: a space freed at 08:00–08:15 can be taken
 * by a car arriving in the same 15 minutes. Aggregating to 15 minutes this way can only overstate
 * availability within the interval by the cars leaving in it; it never lets occupancy exceed
 * capacity at the end of an interval.
 *
 * COMPETING CRUISES. Every cohort draws on the same garages and the same free spaces. Within one
 * interval cohorts are served in order of departure (earliest first), ties by cohort id — a stated
 * rule, not array order. Each space is taken once: a car placed reduces `free` before the next.
 *
 * WHERE A CAR GOES. Only to garages its terminal is mapped to (`allocations`, built from the
 * terminal → garage mapping), then to facilities configured to take that terminal's overflow:
 *   PROPORTIONAL  the interval's cars are split by each garage's share; what does not fit at its
 *                 share's garage tries the terminal's other garages in priority order, then overflow
 *   PRIORITY      cars fill the terminal's garages in priority order, then overflow
 * A garage's optional maximum share caps the cars of one cohort it takes. A garage with no
 * published capacity is never treated as unlimited: cars meant for it that fit nowhere else are
 * recorded as NO_CAPACITY_DATA, neither parked nor counted as a shortage. Cars of a terminal with
 * no mapped garage are UNALLOCATED. Cars that fit nowhere are UNSERVED, recorded at the garage
 * they were meant for, and never parked.
 */
export function simulate({ cohorts, facilities, allocations, allocationPolicy = 'PROPORTIONAL', assumptions: a, startMs, endMs }) {
  const N = Math.ceil((endMs - startMs) / INTERVAL_MS);
  const byId = new Map(facilities.map(f => [f.id, f]));
  const occ = new Map(), background = new Map();
  for (const f of facilities) {
    const bg = Number.isFinite(f.capacity) ? Math.floor((f.capacity * (Number(a.backgroundOccupancyPct) || 0)) / 100) : 0;
    occ.set(f.id, bg);
    background.set(f.id, bg);
  }
  const free = f => (Number.isFinite(f.capacity) ? Math.max(0, f.capacity - occ.get(f.id)) : Infinity);
  // Facilities that take a terminal's overflow: proposed or expanded spaces configured for any
  // terminal, or for a list that includes it. Existing garages before proposed ones, then by id.
  const overflowFor = (code, own) => facilities.filter(f => !own.some(r => r.facilityId === f.id)
    && (f.scope === PROPOSED_SCOPE.ANY_TERMINAL || (Array.isArray(f.scope) && f.scope.includes(code))
      || (f.proposed && f.servesTerminals.includes(code))))
    .sort((x, y) => Number(x.proposed) - Number(y.proposed) || x.id.localeCompare(y.id));

  // An estimated returning cohort whose earlier sailing left before the simulation starts is
  // already parked; one whose parking window opens inside it enters like a departing cohort.
  const enters = c => Number.isFinite(c.entryEndMs) && c.entryEndMs > startMs;
  const state = cohorts.map(c => ({
    cohort: c, served: new Map(), unserved: 0, noData: 0, exits: null, released: 0, pending: new Map(),
    initial: c.kind === 'ESTIMATED_RETURN' && !enters(c),
  }));
  const entriesAt = new Map();
  const exitsStartAt = new Map();
  for (const s of state) {
    const c = s.cohort;
    if (c.kind === 'DEPARTING' || (c.kind === 'ESTIMATED_RETURN' && !s.initial)) {
      for (const [i, n] of distribute(c.vehicles, c.entryStartMs, c.entryEndMs, startMs, c.entryPeak ?? a.entryPeakFraction)) {
        if (i >= N) continue;
        if (!entriesAt.has(i)) entriesAt.set(i, []);
        entriesAt.get(i).push({ s, n });
      }
    }
    if (Number.isFinite(c.exitStartMs) && c.exitStartMs < endMs) {
      const i = Math.max(0, Math.floor((c.exitStartMs - startMs) / INTERVAL_MS));
      if (!exitsStartAt.has(i)) exitsStartAt.set(i, []);
      exitsStartAt.get(i).push(s);
    }
  }
  // Competing cohorts in one interval: earliest departure first, then cohort id.
  const departureOrder = (x, y) => (x.s.cohort.entryEndMs - y.s.cohort.entryEndMs) || String(x.s.cohort.id).localeCompare(String(y.s.cohort.id));
  for (const list of entriesAt.values()) list.sort(departureOrder);

  // DEMAND THAT DID NOT PARK. A car turned away still needs a space until its voyage returns:
  // it is held as a stock against the garage that refused it (f:), the garage whose capacity is
  // unknown (n:), or the terminal with no garage (u:), and released over the cohort's exit window.
  // Occupancy never includes these cars; "spaces required" is occupancy plus the f: and n: stocks.
  const stock = new Map();
  const hold = (s, key, n) => {
    s.pending.set(key, (s.pending.get(key) ?? 0) + n);
    stock.set(key, (stock.get(key) ?? 0) + n);
  };

  /** Place `n` cars of a cohort under the allocation policy (see the header). */
  const place = (s, n, rec) => {
    const code = s.cohort.terminalCode;
    const id = s.cohort.id;
    // Every car asking for a space is counted once, here, whatever garage it ends up in: the
    // demand of an interval does not depend on the facilities a design provides.
    if (rec) rec.requested += n;
    const rows = (allocations[code] ?? []).filter(r => byId.has(r.facilityId));
    const spill = overflowFor(code, rows);
    if (!rows.length && !spill.length) {
      s.unserved += n;
      hold(s, `u:${code}`, n);
      if (rec) { rec.unallocated += n; rec.moves.push({ cohortId: id, facilityId: null, n, type: 'UNALLOCATED' }); }
      return;
    }
    const capLeft = (row, f) => (row?.maxSharePct === null || row?.maxSharePct === undefined ? Infinity
      : Math.max(0, Math.floor((s.cohort.vehicles * row.maxSharePct) / 100) - (s.served.get(f.id) ?? 0)));
    // Unknown capacity is not unlimited: no car is placed where space cannot be checked.
    const room = (f, row) => (Number.isFinite(f.capacity) ? Math.min(free(f), capLeft(row, f)) : 0);
    const put = (f, k, type, from) => {
      occ.set(f.id, occ.get(f.id) + k);
      s.served.set(f.id, (s.served.get(f.id) ?? 0) + k);
      if (!rec) return;
      rec.facilities[f.id].served += k;
      if (type === 'OVERFLOW') rec.facilities[f.id].overflowIn += k;
      rec.moves.push({ cohortId: id, facilityId: f.id, n: k, type, ...(from && from !== f.id ? { fromFacilityId: from } : {}) });
    };
    const chain = [...rows.map(r => ({ f: byId.get(r.facilityId), row: r, own: true })), ...spill.map(f => ({ f, row: null, own: false }))];
    const parts = !rows.length ? [{ facilityId: null, n }]
      : allocationPolicy === 'PRIORITY' ? [{ facilityId: rows[0].facilityId, n }]
        : splitByShare(n, rows).map(p => ({ facilityId: p.facilityId, n: p.n }));
    for (const part of parts) {
      let left = part.n;
      if (!left) continue;
      const home = part.facilityId ? byId.get(part.facilityId) : null;
      if (rec && home) rec.facilities[home.id].demand += left;
      const order = home ? [chain.find(c => c.f.id === home.id), ...chain.filter(c => c.f.id !== home.id)] : chain;
      for (const c of order) {
        if (!left) break;
        const t = Math.min(left, room(c.f, c.row));
        if (t > 0) {
          put(c.f, t, c.f.id === home?.id ? 'IN' : c.own ? 'SPILL' : 'OVERFLOW', home?.id);
          left -= t;
        }
      }
      if (left > 0) {
        const at = home ?? spill[0];
        if (!Number.isFinite(at.capacity)) {
          s.noData += left;
          hold(s, `n:${at.id}`, left);
          if (rec) { rec.facilities[at.id].noData += left; rec.moves.push({ cohortId: id, facilityId: at.id, n: left, type: 'NO_CAPACITY_DATA' }); }
        } else {
          s.unserved += left;
          hold(s, `f:${at.id}`, left);
          hold(s, `t:${code}`, left);   // the same cars, by the terminal they came from
          if (rec) { rec.facilities[at.id].unserved += left; rec.moves.push({ cohortId: id, facilityId: at.id, n: left, type: 'UNSERVED' }); }
        }
      }
    }
  };

  // Vehicles already parked when the simulation begins: estimated returning cohorts. Their
  // placements are recorded (`initialMoves`) so each car can be traced to the garage it is in.
  const initialRec = { index: -1, startMs, requested: 0, unallocated: 0, moves: [],
    facilities: Object.fromEntries(facilities.map(f => [f.id, { start: 0, exits: 0, demand: 0, served: 0, overflowIn: 0, unserved: 0, noData: 0, end: 0 }])) };
  for (const s of state) if (s.initial) place(s, s.cohort.vehicles, initialRec);
  let unservedActive = state.reduce((t, s) => t + (s.initial ? s.unserved : 0), 0);
  const initialOccupied = [...occ.values()].reduce((t, v) => t + v, 0);

  const intervals = [];
  let conservationOk = true;
  for (let i = 0; i < N; i += 1) {
    // `moves` records which cohort moved how many vehicles where, so any interval can be explained.
    const rec = { index: i, startMs: startMs + i * INTERVAL_MS, requested: 0, unallocated: 0, facilities: {}, moves: [] };
    for (const f of facilities) {
      rec.facilities[f.id] = { start: occ.get(f.id), exits: 0, demand: 0, served: 0, overflowIn: 0, unserved: 0, noData: 0, end: 0 };
    }
    // Exit schedules are fixed when a cohort's window opens: by then its entries are complete.
    for (const s of exitsStartAt.get(i) ?? []) {
      const c = s.cohort;
      s.exits = new Map();
      for (const [fid, n] of s.served) {
        for (const [j, k] of distribute(n, c.exitStartMs, c.exitEndMs, startMs, c.exitPeak ?? a.exitPeakFraction)) {
          if (!s.exits.has(j)) s.exits.set(j, []);
          s.exits.get(j).push({ fid, n: k });
        }
      }
      s.phantom = distribute(s.unserved, c.exitStartMs, c.exitEndMs, startMs, c.exitPeak ?? a.exitPeakFraction);
      s.release = [...s.pending].map(([key, n]) => [key, distribute(n, c.exitStartMs, c.exitEndMs, startMs, c.exitPeak ?? a.exitPeakFraction)]);
    }
    for (const s of state) {
      if (!s.exits) continue;
      for (const { fid, n } of s.exits.get(i) ?? []) {
        const take = Math.min(n, occ.get(fid) - background.get(fid), (s.served.get(fid) ?? 0));
        occ.set(fid, occ.get(fid) - take);
        rec.facilities[fid].exits += take;
        s.released += take;
        if (take > 0) rec.moves.push({ cohortId: s.cohort.id, facilityId: fid, n: take, type: 'OUT' });
      }
      const u = s.phantom?.get(i) ?? 0;
      unservedActive -= u;
      for (const [key, plan] of s.release ?? []) {
        const k = plan.get(i) ?? 0;
        if (k) stock.set(key, Math.max(0, (stock.get(key) ?? 0) - k));
      }
    }
    for (const { s, n } of entriesAt.get(i) ?? []) {
      place(s, n, rec);
    }
    let newlyUnserved = rec.unallocated;
    for (const f of facilities) {
      const r = rec.facilities[f.id];
      r.end = occ.get(f.id);
      newlyUnserved += r.unserved;
      if (r.end !== r.start + r.served - r.exits || r.end < 0
        || (Number.isFinite(f.capacity) && r.end > f.capacity)) conservationOk = false;
    }
    unservedActive += newlyUnserved;
    rec.unservedActive = Math.max(0, unservedActive);
    for (const f of facilities) {
      const r = rec.facilities[f.id];
      r.shortActive = stock.get(`f:${f.id}`) ?? 0;     // turned away here, still away
      r.noDataActive = stock.get(`n:${f.id}`) ?? 0;    // meant for here, capacity unknown
      r.required = r.end + r.shortActive + r.noDataActive;
    }
    rec.unallocatedActive = Object.fromEntries([...stock].filter(([k, v]) => k.startsWith('u:') && v > 0).map(([k, v]) => [k.slice(2), v]));
    rec.terminalShort = Object.fromEntries([...stock].filter(([k, v]) => k.startsWith('t:') && v > 0).map(([k, v]) => [k.slice(2), v]));
    intervals.push(rec);
  }

  const parkedAtEnd = state.filter(s => (s.cohort.kind === 'DEPARTING' || s.initial)
    && !(Number.isFinite(s.cohort.exitStartMs) && s.cohort.exitStartMs < endMs))
    .reduce((t, s) => t + [...s.served.values()].reduce((x, v) => x + v, 0), 0);

  return {
    startMs, endMs, intervals, facilities, allocations, allocationPolicy,
    cohorts: state.map(s => ({
      ...s.cohort,
      initial: s.initial,
      served: Object.fromEntries(s.served),
      servedTotal: [...s.served.values()].reduce((t, v) => t + v, 0),
      unserved: s.unserved,
      noData: s.noData,
      released: s.released,
    })),
    initialOccupied,
    initialMoves: initialRec.moves,
    backgroundOccupancyPct: Number(a.backgroundOccupancyPct) || 0,
    parkedAtEnd,
    checks: { conservationOk },
  };
}

// ---- reading one day ----------------------------------------------------------------------------

const hhmm = ms => utcMsToLocal(ms).time;

/**
 * One local day of a run: the timeline and the figures the panels show.
 *
 * Totals are over the facilities that matter to the day: those allocated to a terminal with a
 * call, plus any that take overflow. Port-wide totals would dilute a full Garage G with the empty
 * garages of terminals that had no ship.
 */
export function summarizeDay(sim, date, { calls = [], redPct = 90 } = {}) {
  const dayStart = localMidnightMs(date), dayEnd = localMidnightMs(nextDate(date));
  const rows = sim.intervals.filter(r => r.startMs >= dayStart && r.startMs < dayEnd);
  const dayCalls = calls.filter(c => c.arrivalMs < dayEnd && c.departureMs >= dayStart);
  // Terminals with MODELLED vehicle movement on the day. A call without a published capacity
  // moves no modelled vehicle, so it does not bring its garages into the day's capacity.
  const activeCodes = new Set(sim.cohorts
    .filter(c => (c.entryStartMs < dayEnd && c.entryEndMs >= dayStart) || (c.exitStartMs < dayEnd && c.exitEndMs >= dayStart))
    .map(c => c.terminalCode));
  const callCodes = new Set(dayCalls.map(c => c.terminalCode));
  // What a terminal can reach under the access rules: its allocated facilities, then any facility
  // that takes its overflow. Capacity a terminal cannot reach is never counted toward its demand.
  const reach = code => sim.facilities.filter(f => (sim.allocations[code] ?? []).some(r => r.facilityId === f.id)
    || f.scope === PROPOSED_SCOPE.ANY_TERMINAL || (Array.isArray(f.scope) && f.scope.includes(code))
    || (f.proposed && f.servesTerminals.includes(code)));
  const accessible = new Set([...activeCodes].flatMap(code => reach(code).map(f => f.id)));
  // A facility matters to the day if an active terminal can reach it, or if it is holding parked
  // vehicles — cars left on earlier days are still there on a quiet one.
  const relevant = sim.facilities.filter(f => accessible.has(f.id)
    || rows.some(r => r.facilities[f.id].start > 0 || r.facilities[f.id].end > 0));
  const known = relevant.filter(f => Number.isFinite(f.capacity));
  const capacity = known.reduce((t, f) => t + f.capacity, 0);

  const timeline = rows.map(r => {
    const sum = key => relevant.reduce((t, f) => t + r.facilities[f.id][key], 0);
    const occupied = known.reduce((t, f) => t + r.facilities[f.id].end, 0);
    return {
      startMs: r.startMs, time: hhmm(r.startMs),
      exits: sum('exits'), entries: sum('served'), demand: r.requested ?? sum('demand') + r.unallocated,
      unserved: sum('unserved') + r.unallocated, garageUnserved: sum('unserved'), unallocated: r.unallocated, occupied, capacity,
      utilisationPct: capacity ? (occupied / capacity) * 100 : null,
      shortage: r.unservedActive,
      facilities: Object.fromEntries(relevant.map(f => [f.id, r.facilities[f.id]])),
    };
  });
  const sum2 = (r, key) => relevant.reduce((t, f) => t + (r.facilities[f.id][key] ?? 0), 0);
  const peak = timeline.reduce((best, t) => (t.occupied > (best?.occupied ?? -1) ? t : best), null);
  const peakShort = timeline.reduce((best, t) => (t.shortage > (best?.shortage ?? 0) ? t : best), null);
  const total = key => timeline.reduce((t, r) => t + r[key], 0);
  const demand = total('demand');
  const served = total('entries');

  const perFacility = relevant.map(f => {
    const series = rows.map(r => r.facilities[f.id]);
    const peakEnd = Math.max(0, ...series.map(s => Math.max(s.start, s.end)));
    const peakAt = series.findIndex(s => Math.max(s.start, s.end) === peakEnd);
    const full = Number.isFinite(f.capacity) && f.capacity > 0
      ? series.map((s, i) => (s.end >= f.capacity || s.unserved > 0 ? i : -1)).filter(i => i >= 0) : [];
    // Why this facility's capacity is counted for the day.
    const servesActive = [...activeCodes].filter(code => (sim.allocations[code] ?? []).some(r => r.facilityId === f.id));
    const overflowFor = [...activeCodes].filter(code => !servesActive.includes(code) && reach(code).some(x => x.id === f.id));
    return {
      peakTime: peakEnd > 0 && peakAt >= 0 ? hhmm(rows[peakAt].startMs) : null,
      firstFullTime: full.length ? hhmm(rows[full[0]].startMs) : null,
      lastFullTime: full.length ? hhmm(rows[full.at(-1)].startMs) : null,
      requested: series.reduce((t, s) => t + s.demand, 0),
      noData: series.reduce((t, s) => t + (s.noData ?? 0), 0),
      capacitySource: f.capacitySource ?? null,
      inPlayBecause: servesActive.length ? `Mapped to Terminal ${servesActive.join(', ')}`
        : overflowFor.length ? `Takes overflow from Terminal ${overflowFor.join(', ')}`
          : 'Holds cars parked on earlier days',
      id: f.id, name: f.name, capacity: f.capacity, proposed: f.proposed, addedSpaces: f.addedSpaces,
      servesTerminals: f.servesTerminals, scope: f.scope,
      peakOccupied: peakEnd,
      peakUtilisationPct: Number.isFinite(f.capacity) && f.capacity > 0 ? (peakEnd / f.capacity) * 100 : null,
      minAvailable: Number.isFinite(f.capacity) ? Math.min(...series.map(s => f.capacity - Math.max(s.start, s.end))) : null,
      entries: series.reduce((t, s) => t + s.served, 0),
      exits: series.reduce((t, s) => t + s.exits, 0),
      unserved: series.reduce((t, s) => t + s.unserved, 0),
    };
  });

  const affectedTerminals = [...activeCodes].filter(code => (sim.allocations[code] ?? []).some(row => {
    const f = perFacility.find(p => p.id === row.facilityId);
    return f && ((f.peakUtilisationPct ?? 0) >= redPct || f.unserved > 0);
  }) || !(sim.allocations[code] ?? []).length).sort();

  return {
    date,
    timeline,
    startOccupied: rows.length ? known.reduce((t, f) => t + rows[0].facilities[f.id].start, 0) : 0,
    endOccupied: timeline.at(-1)?.occupied ?? 0,
    exits: total('exits'),
    entries: served,
    demand,
    unserved: total('unserved'),
    netChange: served - total('exits'),
    capacity,
    peakOccupied: peak?.occupied ?? 0,
    peakTime: peak?.time ?? null,
    peakUtilisationPct: capacity && peak ? (peak.occupied / capacity) * 100 : null,
    peakShortage: peakShort?.shortage ?? 0,
    peakShortageTime: peakShort?.time ?? null,
    demandServedPct: demand ? (served / demand) * 100 : null,
    facilities: perFacility,
    activeTerminals: [...activeCodes].sort(),
    callTerminals: [...callCodes].sort(),
    accessibleCapacity: sim.facilities.filter(f => accessible.has(f.id) && Number.isFinite(f.capacity)).reduce((t, f) => t + f.capacity, 0),
    terminalAccess: [...activeCodes].sort().map(code => {
      const list = reach(code);
      return {
        code,
        facilities: list.map(f => ({ id: f.id, name: f.name, capacity: f.capacity, overflow: !(sim.allocations[code] ?? []).some(r => r.facilityId === f.id) })),
        capacity: list.filter(f => Number.isFinite(f.capacity)).reduce((t, f) => t + f.capacity, 0),
        unknownCapacity: list.some(f => !Number.isFinite(f.capacity)),
      };
    }),
    affectedTerminals,
    unknownCapacity: relevant.filter(f => !Number.isFinite(f.capacity)).map(f => f.name),
    noCapacityData: timeline.reduce((t, r) => t + sum2(r, 'noData'), 0),
    garagesAtCapacity: perFacility.filter(f => f.firstFullTime).length,
    // A garage shortage (a mapped garage full) is kept apart from cars whose terminal has no
    // garage at all (unallocated) and cars meant for a garage with no published capacity.
    firstShortageTime: timeline.find(r => r.garageUnserved > 0)?.time ?? null,
    garageUnserved: timeline.reduce((t, r) => t + r.garageUnserved, 0),
    unallocated: timeline.reduce((t, r) => t + r.unallocated, 0),
    unallocatedTerminals: [...new Set(rows.flatMap(r => r.moves.filter(m => m.type === 'UNALLOCATED'))
      .map(m => sim.cohorts.find(c => c.id === m.cohortId)?.terminalCode).filter(Boolean))].sort(),
    allocationPolicy: sim.allocationPolicy ?? 'PROPORTIONAL',
  };
}

/** The calls on a day, with the vehicles each one moves and how firmly that is known. */
export function callActivity(sim, calls, date) {
  const dayStart = localMidnightMs(date), dayEnd = localMidnightMs(nextDate(date));
  return calls.filter(c => c.arrivalMs < dayEnd && c.departureMs >= dayStart).map(call => {
    const returning = sim.cohorts.find(c => c.returnCallId === call.id && (c.kind === 'ESTIMATED_RETURN' || c.kind === 'DEPARTING'));
    const departing = sim.cohorts.find(c => c.kind === 'DEPARTING' && c.callId === call.id);
    return {
      call,
      returningVehicles: returning ? returning.servedTotal + returning.unserved : null,
      returningBasis: returning ? (returning.kind === 'ESTIMATED_RETURN' ? 'Estimated' : `From ${returning.callId.replace('PMIA-DOCK-', 'call ')}`) : null,
      newVehicles: departing?.vehicles ?? null,
      departingBasis: departing?.basis ?? null,
      expectedReturnDate: departing?.expectedReturnDate ?? null,
      confidence: !call.passengerCapacity ? 'No capacity — not simulated'
        : returning?.kind === 'ESTIMATED_RETURN' ? 'Returning cars estimated' : 'Cohort reconstructed',
    };
  });
}
