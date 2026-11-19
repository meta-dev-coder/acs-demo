/**
 * One selected cruise inside the simulation: where its cars may park, what its parking cohort is,
 * and how much of a garage's demand is its own.
 *
 * Everything is read back from the run (`simulate`): its per-interval moves, which name the cohort
 * and garage of every car that parked, was turned away, or left. The contribution of one cohort is
 * therefore built from the same records the garage totals are summed from, so summing it over
 * every cohort gives the garage's own demand — the selected cruise is counted once, inside the
 * total, never added on top of it.
 */
import { INTERVAL_MS, PROVENANCE, distribute } from './turnaroundModel.js';
import { FOCUS } from './demandCapacity.js';
import { PROPOSED_SCOPE } from './cruiseAssumptions.js';

export const DIRECTION = Object.freeze({ DEPARTING: 'DEPARTING', RETURNING: 'RETURNING' });

const PARKED = new Set(['IN', 'SPILL', 'OVERFLOW']);

/**
 * The garages a terminal's cars may use, from the terminal → garage mapping, in allocation order
 * (priority, then id), and the overflow facilities a design opens to it. `primary` is the first
 * mapped garage; null when the terminal has none — the caller says "Garage assignment missing"
 * rather than picking another garage.
 */
export function eligibleGarages({ allocations, facilities }, code) {
  const mapped = (allocations[code] ?? []).map(r => facilities.find(f => f.id === r.facilityId)).filter(Boolean);
  const overflow = facilities.filter(f => !mapped.includes(f)
    && (f.scope === PROPOSED_SCOPE.ANY_TERMINAL || (Array.isArray(f.scope) && f.scope.includes(code)) || (f.proposed && f.servesTerminals?.includes(code))));
  return { mapped, overflow, primary: mapped[0] ?? null };
}

/** The cohort behind a cruise call in one direction: its new departure, or the cars returning to it. */
export function cohortFor(sim, callId, direction) {
  return direction === DIRECTION.RETURNING
    ? sim.cohorts.find(c => c.returnCallId === callId) ?? null
    : sim.cohorts.find(c => c.kind === 'DEPARTING' && c.callId === callId) ?? null;
}

/** Every move of one cohort, with the interval it happened in (-1: parked before the run starts). */
function movesOf(sim, cohortId) {
  const out = [];
  for (const m of sim.initialMoves ?? []) if (m.cohortId === cohortId) out.push({ ...m, i: -1 });
  sim.intervals.forEach((r, i) => { for (const m of r.moves) if (m.cohortId === cohortId) out.push({ ...m, i }); });
  return out;
}

/** Release plans of a cohort's turned-away stock, exactly as the engine schedules them. */
function releasePlan(sim, cohort, moves, test) {
  if (!Number.isFinite(cohort.exitStartMs) || cohort.exitStartMs >= sim.endMs) return new Map();
  const e = Math.max(0, Math.floor((cohort.exitStartMs - sim.startMs) / INTERVAL_MS));
  const pending = moves.filter(m => m.i < e && test(m)).reduce((t, m) => t + m.n, 0);
  return distribute(pending, cohort.exitStartMs, cohort.exitEndMs, sim.startMs, cohort.exitPeak);
}

/**
 * One cohort's share of a focus's demand through the day, interval by interval, in the same three
 * parts the focus's `required` is made of (demandVsCapacity):
 *   parked     its cars parked in the focus's garages at the end of the interval
 *   unmet      its cars turned away, still away on their voyage, if its terminal is in the focus
 *   unchecked  its cars meant for a focus garage with no published capacity, still away
 */
export function cohortContribution(sim, dvc, cohortId) {
  const cohort = sim.cohorts.find(c => c.id === cohortId);
  if (!cohort || !dvc) return null;
  const ids = new Set(dvc.facilities.map(f => f.id));
  const ownTerminal = dvc.terminals.includes(cohort.terminalCode);
  const moves = movesOf(sim, cohortId);
  // Turned-away stock is released per garage (`n:`) and per terminal (`t:`) by the engine.
  const tPlan = releasePlan(sim, cohort, moves, m => m.type === 'UNSERVED');
  const nPlans = [...ids].map(fid => releasePlan(sim, cohort, moves, m => m.type === 'NO_CAPACITY_DATA' && m.facilityId === fid));
  const last = Math.floor((dvc.series.at(-1)?.startMs - sim.startMs) / INTERVAL_MS);
  let parked = 0, unmet = 0, unchecked = 0;
  const at = new Map();
  const byI = new Map();
  for (const m of moves) { if (!byI.has(m.i)) byI.set(m.i, []); byI.get(m.i).push(m); }
  for (let i = -1; i <= last; i += 1) {
    if (i >= 0) {
      unmet -= tPlan.get(i) ?? 0;
      for (const p of nPlans) unchecked -= p.get(i) ?? 0;
    }
    for (const m of byI.get(i) ?? []) {
      if (PARKED.has(m.type) && ids.has(m.facilityId)) parked += m.n;
      if (m.type === 'OUT' && ids.has(m.facilityId)) parked -= m.n;
      if (m.type === 'UNSERVED') unmet += m.n;
      if (m.type === 'NO_CAPACITY_DATA' && ids.has(m.facilityId)) unchecked += m.n;
    }
    at.set(i, { parked, unmet: ownTerminal ? Math.max(0, unmet) : 0, unchecked: Math.max(0, unchecked) });
  }
  const series = dvc.series.map(s => {
    const v = at.get(Math.round((s.startMs - sim.startMs) / INTERVAL_MS)) ?? { parked: 0, unmet: 0, unchecked: 0 };
    return { ...v, total: v.parked + v.unmet + v.unchecked };
  });
  return { cohortId, series, peak: Math.max(0, ...series.map(s => s.total)) };
}

/**
 * Where a cohort stands at the end of interval `index` of the day (`dvc.series[index]`): cars it
 * needs, admitted so far, denied (turned away or no garage), unchecked, still to arrive, left, and
 * still parked — by garage.
 */
export function cohortStatus(sim, cohortId, untilMs) {
  const cohort = sim.cohorts.find(c => c.id === cohortId);
  if (!cohort) return null;
  const moves = movesOf(sim, cohortId).filter(m => m.i === -1 || sim.intervals[m.i].startMs <= untilMs);
  const sum = test => moves.filter(test).reduce((t, m) => t + m.n, 0);
  const admitted = sum(m => PARKED.has(m.type));
  const denied = sum(m => m.type === 'UNSERVED' || m.type === 'UNALLOCATED');
  const unchecked = sum(m => m.type === 'NO_CAPACITY_DATA');
  const left = sum(m => m.type === 'OUT');
  const byGarage = {};
  for (const m of moves) {
    if (PARKED.has(m.type)) byGarage[m.facilityId] = (byGarage[m.facilityId] ?? 0) + m.n;
    if (m.type === 'OUT') byGarage[m.facilityId] = (byGarage[m.facilityId] ?? 0) - m.n;
  }
  return {
    required: cohort.vehicles, admitted, denied, unchecked, left,
    waiting: Math.max(0, cohort.vehicles - admitted - denied - unchecked),
    stillParked: admitted - left,
    byGarage: Object.fromEntries(Object.entries(byGarage).filter(([, n]) => n > 0)),
  };
}

/**
 * THE PARKING COHORT RECORD: one cohort in the fields the data model names, with where each value
 * comes from. `remainingParkedCars` is at `atMs` (default: the end of the run).
 */
export function cohortRecord(sim, cohort, calls, atMs = sim.endMs) {
  const callById = new Map(calls.map(c => [c.id, c]));
  const origin = cohort.kind === 'DEPARTING' ? callById.get(cohort.callId) : null;
  const ret = cohort.returnCallId ? callById.get(cohort.returnCallId) : null;
  const status = cohortStatus(sim, cohort.id, atMs);
  return {
    cohortId: cohort.id,
    cruiseCallId: cohort.kind === 'DEPARTING' ? cohort.callId : cohort.returnCallId,
    vesselId: cohort.vesselKey ?? null,
    originDepartureCallId: origin?.id ?? null,
    returnCallId: cohort.returnCallId ?? null,
    departureDateTime: origin?.departureLocal ?? (cohort.assumedDepartureMs ? new Date(cohort.assumedDepartureMs).toISOString() : null),
    expectedReturnDateTime: ret?.arrivalLocal ?? cohort.expectedReturnDate ?? null,
    terminalId: cohort.terminalCode,
    garageAllocations: cohort.served,
    estimatedPassengers: cohort.inputs.passengers,
    parkingShare: cohort.inputs.longStayPct,
    passengersPerCar: cohort.inputs.passengersPerVehicle,
    originalParkedCars: cohort.servedTotal,
    remainingParkedCars: status.stillParked,
    calculationProvenance: cohort.provenance ?? (cohort.kind === 'DEPARTING' ? PROVENANCE.ASSUMPTIONS : PROVENANCE.ESTIMATED),
    sourceAssumptions: { ...cohort.inputs },
    override: cohort.override ?? null,
  };
}

/** Whether a cruise's cars may use a garage, and if not, which garages they may use. */
export function garageEligibility(sim, code, focus) {
  const { mapped, overflow, primary } = eligibleGarages(sim, code);
  if (focus.kind !== FOCUS.GARAGE) return { eligible: null, mapped, overflow, primary };
  return { eligible: [...mapped, ...overflow].some(f => f.id === focus.id), mapped, overflow, primary };
}

/**
 * THE GARAGE LEDGER at one moment: which cohorts' cars physically occupy a set of garages at the
 * end of interval `absIndex` (an index into `sim.intervals`), how many each, when each parked and
 * when it is due to leave — and the cohorts whose cars were denied and are still unmet.
 *
 * Built by one chronological pass over the run's own moves (initial placements, then every
 * interval up to `absIndex`), so the parked counts sum to the garages' closing occupancy, less any
 * configured background occupancy, which is reported on its own line.
 */
export function garageLedger(sim, facilityIds, absIndex, { terminals = [] } = {}) {
  const ids = new Set(facilityIds);
  const parked = new Map(), denied = new Map(), deniedNow = new Map();
  const add = (map, id, n) => map.set(id, (map.get(id) ?? 0) + n);
  const take = m => {
    if (!m.facilityId || !ids.has(m.facilityId)) return;
    if (PARKED.has(m.type)) add(parked, m.cohortId, m.n);
    if (m.type === 'OUT') add(parked, m.cohortId, -m.n);
  };
  for (const m of sim.initialMoves ?? []) take(m);
  const last = Math.min(absIndex, sim.intervals.length - 1);
  for (let i = 0; i <= last; i += 1) for (const m of sim.intervals[i].moves) take(m);
  const atMs = sim.intervals[last]?.startMs ?? sim.startMs;
  const endMs = atMs + INTERVAL_MS;
  const byId = new Map(sim.cohorts.map(c => [c.id, c]));
  const row = (id, n) => {
    const c = byId.get(id);
    return {
      cohortId: id, shipName: c.shipName, terminalCode: c.terminalCode, cars: n,
      kind: c.kind, estimated: c.kind === 'ESTIMATED_RETURN', provenance: c.provenance ?? null,
      parkedFrom: c.initial ? null : c.entryStartMs ?? null,         // null: parked before the replay starts
      releaseFromMs: Number.isFinite(c.exitStartMs) ? c.exitStartMs : null,
      releaseToMs: Number.isFinite(c.exitEndMs) ? c.exitEndMs : null,
      leaving: Number.isFinite(c.exitStartMs) && c.exitStartMs < endMs,
      returnCallId: c.returnCallId ?? null,
    };
  };
  const active = [...parked].filter(([, n]) => n > 0).map(([id, n]) => row(id, n))
    .sort((a, b) => b.cars - a.cars || a.cohortId.localeCompare(b.cohortId));
  const background = [...ids].reduce((t, fid) => {
    const f = sim.facilities.find(x => x.id === fid);
    return t + (Number.isFinite(f?.capacity) ? Math.floor((f.capacity * (Number(sim.backgroundOccupancyPct) || 0)) / 100) : 0);
  }, 0);
  const upcoming = active.filter(r => r.releaseFromMs !== null && r.releaseFromMs >= endMs).sort((a, b) => a.releaseFromMs - b.releaseFromMs);
  // Unmet demand by cohort: cars of these terminals denied and still away on their voyage.
  for (const c of sim.cohorts) {
    if (!terminals.includes(c.terminalCode) || !(c.unserved > 0)) continue;
    const moves = movesOf(sim, c.id).filter(m => m.i <= last);
    const plan = releasePlan(sim, c, movesOf(sim, c.id), m => m.type === 'UNSERVED');
    const released = [...plan].filter(([j]) => j <= last).reduce((t, [, k]) => t + k, 0);
    const n = moves.filter(m => m.type === 'UNSERVED').reduce((t, m) => t + m.n, 0) - released;
    const now = moves.filter(m => m.type === 'UNSERVED' && m.i === last).reduce((t, m) => t + m.n, 0);
    if (n > 0) { denied.set(c.id, n); if (now) deniedNow.set(c.id, now); }
  }
  const unmet = [...denied].map(([id, n]) => ({ ...row(id, n), newNow: deniedNow.get(id) ?? 0 }))
    .sort((a, b) => b.cars - a.cars);
  return {
    atMs, active, background,
    parkedTotal: active.reduce((t, r) => t + r.cars, 0),
    estimatedCars: active.filter(r => r.estimated).reduce((t, r) => t + r.cars, 0),
    nextRelease: upcoming[0] ?? null,
    unmet,
  };
}
