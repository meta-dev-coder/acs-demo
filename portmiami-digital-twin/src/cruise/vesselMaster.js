/**
 * The vessel master: one record per ship, and the join from Dock Report calls to it.
 *
 * ONE SOURCE OF PASSENGER CAPACITY. A call's capacity comes from its ship's master record and
 * nowhere else. A capacity carried in an older file is kept only as provenance and compared: if it
 * disagrees with the master, the call is flagged, not silently overwritten either way.
 *
 * MATCHING. IMO is the preferred key, used whenever both sides carry one. The Dock Report prints
 * names only, so a call is otherwise matched by its NORMALISED name against each record's
 * canonical name and aliases — exact equality after normalisation, never similarity. Two records
 * that normalise to the same name, or share an IMO, are an error in the master, reported before
 * anything is joined; a name that matches more than one record is ambiguous and left unmatched.
 *
 * WHAT CAN BE SIMULATED. Only a positive capacity whose definition is double occupancy (lower
 * berths) and whose record is verified. A "maximum" or unstated definition is kept and shown, but
 * the occupancy assumptions are percentages of double-occupancy capacity, so applying them to a
 * different definition would mislead; those calls are excluded with the reason recorded.
 */

export const CAPACITY_TYPE = Object.freeze({
  DOUBLE_OCCUPANCY: 'double_occupancy',   // the same thing as lower berths
  LOWER_BERTH: 'lower_berth',
  MAXIMUM: 'maximum',
  UNSPECIFIED: 'unspecified',
});

export const CAPACITY_TYPE_LABEL = Object.freeze({
  double_occupancy: 'Double occupancy',
  lower_berth: 'Lower berths',
  maximum: 'Maximum',
  unspecified: 'Definition not stated',
});

export const VESSEL_STATUS = Object.freeze({
  VERIFIED_OFFICIAL: 'VERIFIED_OFFICIAL',
  VERIFIED_SECONDARY: 'VERIFIED_SECONDARY',
  CONFLICT: 'CONFLICT',
  UNRESOLVED: 'UNRESOLVED',
});

/** A call's capacity status after the join, and what the app shows for it. */
export const CAPACITY_STATUS = Object.freeze({
  VALIDATED: 'VALIDATED',
  NOT_YET_SOURCED: 'NOT_YET_SOURCED',
  DEFINITION_NOT_COMPARABLE: 'DEFINITION_NOT_COMPARABLE',
  CONFLICT: 'CONFLICT',
  UNMATCHED_VESSEL: 'UNMATCHED_VESSEL',
});

export const CAPACITY_STATUS_LABEL = Object.freeze({
  VALIDATED: 'Capacity validated',
  NOT_YET_SOURCED: 'Capacity not yet sourced',
  DEFINITION_NOT_COMPARABLE: 'Only a maximum or unstated capacity is published',
  CONFLICT: 'Conflicting capacity sources — under review',
  UNMATCHED_VESSEL: 'Ship not in the vessel master',
});

const SIMULABLE_TYPES = new Set([CAPACITY_TYPE.DOUBLE_OCCUPANCY, CAPACITY_TYPE.LOWER_BERTH]);
const VERIFIED = new Set([VESSEL_STATUS.VERIFIED_OFFICIAL, VESSEL_STATUS.VERIFIED_SECONDARY]);

/** Case, punctuation and spacing removed: "MSC SEASIDE", "Msc Seaside" and "MSC  Seaside" agree. */
export function normalizeVesselName(name) {
  return String(name ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Is this record's capacity usable by the simulation? With the reason when it is not. */
export function capacityStatusOf(vessel) {
  if (!vessel) return CAPACITY_STATUS.UNMATCHED_VESSEL;
  if (vessel.status === VESSEL_STATUS.CONFLICT) return CAPACITY_STATUS.CONFLICT;
  if (!VERIFIED.has(vessel.status) || !(Number(vessel.passenger_capacity) > 0)) return CAPACITY_STATUS.NOT_YET_SOURCED;
  if (!SIMULABLE_TYPES.has(vessel.capacity_type)) return CAPACITY_STATUS.DEFINITION_NOT_COMPARABLE;
  return CAPACITY_STATUS.VALIDATED;
}

/**
 * Problems with the master itself: duplicate IDs, IMOs or names; capacities without a source;
 * malformed IMOs. An empty list means it can be joined.
 */
export function validateVesselMaster(master) {
  const problems = [];
  const ids = new Map(), imos = new Map(), names = new Map();
  for (const v of master) {
    if (!v.vessel_id) problems.push(`A record has no vessel_id: ${v.canonical_name}`);
    if (ids.has(v.vessel_id)) problems.push(`Duplicate vessel_id ${v.vessel_id}`);
    ids.set(v.vessel_id, v);
    if (v.imo !== null && v.imo !== undefined) {
      if (!/^\d{7}$/.test(String(v.imo))) problems.push(`${v.canonical_name}: IMO "${v.imo}" is not 7 digits`);
      else if (!imoCheckDigitOk(String(v.imo))) problems.push(`${v.canonical_name}: IMO ${v.imo} fails its check digit`);
      if (imos.has(String(v.imo))) problems.push(`IMO ${v.imo} is on two records: ${imos.get(String(v.imo)).canonical_name} and ${v.canonical_name}`);
      imos.set(String(v.imo), v);
    }
    for (const n of new Set([v.canonical_name, ...(v.aliases ?? [])].map(normalizeVesselName))) {
      if (!n) continue;
      if (names.has(n) && names.get(n) !== v) problems.push(`The name "${n}" belongs to two records: ${names.get(n).canonical_name} and ${v.canonical_name}`);
      names.set(n, v);
    }
    if (Number(v.passenger_capacity) > 0) {
      if (!v.capacity_source_url && !v.capacity_source_title) problems.push(`${v.canonical_name}: a capacity without a source`);
      if (!Object.values(CAPACITY_TYPE).includes(v.capacity_type)) problems.push(`${v.canonical_name}: unknown capacity type "${v.capacity_type}"`);
      if (!Number.isInteger(Number(v.passenger_capacity))) problems.push(`${v.canonical_name}: capacity is not a whole number`);
    }
  }
  return problems;
}

/** The IMO check digit: the first six digits weighted 7..2, summed; the last digit of the sum. */
export function imoCheckDigitOk(imo) {
  const d = String(imo).split('').map(Number);
  const sum = d.slice(0, 6).reduce((t, x, i) => t + x * (7 - i), 0);
  return sum % 10 === d[6];
}

/** Name → record lookup, built once; ambiguous names map to every candidate. */
export function vesselIndex(master) {
  const byName = new Map(), byImo = new Map();
  for (const v of master) {
    if (v.imo) byImo.set(String(v.imo), v);
    for (const n of new Set([v.canonical_name, ...(v.aliases ?? [])].map(normalizeVesselName))) {
      if (!n) continue;
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(v);
    }
  }
  return { byName, byImo };
}

/** The master record for a call: by IMO if the call has one, else by exact normalised name. */
export function matchVessel(call, index) {
  const imo = call.vessel_imo ?? call.imo ?? null;
  if (imo && index.byImo.has(String(imo))) return { vessel: index.byImo.get(String(imo)), method: 'IMO' };
  const hits = index.byName.get(normalizeVesselName(call.ship_name)) ?? [];
  if (hits.length === 1) return { vessel: hits[0], method: 'NAME' };
  return { vessel: null, method: hits.length > 1 ? 'AMBIGUOUS' : 'NONE', candidates: hits.map(v => v.vessel_id) };
}

/**
 * Join the master to the calls. Every original field is kept; capacity fields are set from the
 * master; an older capacity on the call is moved to `original_passenger_capacity` and compared.
 * `passenger_capacity` is set only when the capacity is VALIDATED, so a consumer that reads only
 * that field can never simulate an unvalidated figure.
 */
export function enrichCalls(calls, master) {
  const index = vesselIndex(master);
  return calls.map(call => {
    const { vessel, method } = matchVessel(call, index);
    let status = capacityStatusOf(vessel);
    const original = Number(call.passenger_capacity) > 0 ? Number(call.passenger_capacity) : null;
    const conflict = vessel && original !== null && Number(vessel.passenger_capacity) > 0 && original !== Number(vessel.passenger_capacity);
    if (conflict) status = CAPACITY_STATUS.CONFLICT;
    const capacity = vessel && Number(vessel.passenger_capacity) > 0 ? Number(vessel.passenger_capacity) : null;
    return {
      ...call,
      vessel_id: vessel?.vessel_id ?? null,
      vessel_imo: vessel?.imo ?? null,
      vessel_match: method,
      cruise_line: call.cruise_line ?? vessel?.operator ?? null,
      cruise_line_source: call.cruise_line ? 'dock_report_file' : vessel?.operator ? 'vessel_master' : null,
      passenger_capacity: status === CAPACITY_STATUS.VALIDATED ? capacity : null,
      published_capacity: capacity,
      capacity_type: vessel?.capacity_type ?? null,
      capacity_status: status,
      passenger_capacity_source: vessel && capacity ? {
        title: vessel.capacity_source_title ?? null,
        url: vessel.capacity_source_url ?? null,
        kind: vessel.capacity_source_kind ?? null,
        source_date: vessel.source_date ?? null,
        verified_on: vessel.verified_on ?? null,
        vessel_status: vessel.status,
      } : null,
      original_passenger_capacity: original,
      original_passenger_capacity_source: original !== null ? call.passenger_capacity_source ?? null : null,
      capacity_conflict: conflict ? { master: capacity, original } : null,
    };
  });
}

/** Coverage at call and vessel level, with the calls each unresolved ship affects. */
export function coverageReport(calls) {
  const vessels = new Map();
  for (const c of calls) {
    const key = c.vessel_id ?? `unmatched:${normalizeVesselName(c.ship_name)}`;
    if (!vessels.has(key)) vessels.set(key, { vessel_id: c.vessel_id, ship_name: c.ship_name, imo: c.vessel_imo, status: c.capacity_status, capacity: c.published_capacity, capacity_type: c.capacity_type, calls: [] });
    vessels.get(key).calls.push(c.id ?? c.dock_request_number);
  }
  const list = [...vessels.values()];
  const modelled = calls.filter(c => c.capacity_status === CAPACITY_STATUS.VALIDATED);
  const byDate = {};
  for (const c of calls) {
    const d = c.arrival_date;
    byDate[d] ??= { calls: 0, modelled: 0 };
    byDate[d].calls += 1;
    if (c.capacity_status === CAPACITY_STATUS.VALIDATED) byDate[d].modelled += 1;
  }
  return {
    total_calls: calls.length,
    unique_vessels: list.length,
    modelled_calls: modelled.length,
    modelled_vessels: list.filter(v => v.status === CAPACITY_STATUS.VALIDATED).length,
    calls_by_status: Object.fromEntries(Object.values(CAPACITY_STATUS).map(s => [s, calls.filter(c => c.capacity_status === s).length])),
    vessels_by_status: Object.fromEntries(Object.values(CAPACITY_STATUS).map(s => [s, list.filter(v => v.status === s).length])),
    unresolved_vessels: list.filter(v => v.status !== CAPACITY_STATUS.VALIDATED)
      .sort((a, b) => b.calls.length - a.calls.length)
      .map(v => ({ ship_name: v.ship_name, vessel_id: v.vessel_id, status: v.status, published_capacity: v.capacity, capacity_type: v.capacity_type, calls_affected: v.calls.length, call_ids: v.calls })),
    conflicts: calls.filter(c => c.capacity_conflict).map(c => ({ id: c.id, ship_name: c.ship_name, ...c.capacity_conflict })),
    by_arrival_date: byDate,
  };
}
