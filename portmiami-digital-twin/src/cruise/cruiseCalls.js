/**
 * November 2026 cruise vessel calls, read from the enriched PortMiami Dock Report files.
 *
 * WHAT THE FILES ARE. `portmiami_november_2026_dock_enriched_all.json` holds the 149 vessel calls
 * the Dock Report lists for November 1–30; `…_with_capacity.json` is the 29 of them whose ship has
 * a published passenger capacity. Both share one schema (`metadata` + `cruise_calls`), inspected
 * field by field before this was written. Neither is complete port traffic: the report itself
 * says it may not carry every movement, and 120 of the 149 calls have no capacity.
 *
 * WHAT IS KEPT. Every call stays a separate record — the same ship on four dates is four calls —
 * with its source identifiers (`id`, dock request number, PDF page), every berth movement, every
 * voyage option and the raw record itself, so a figure can be traced back to the report.
 *
 * TIME. Every local timestamp is converted to an absolute instant with the America/New_York rules
 * in this file, not the browser's zone, so a run gives the same answer on any machine. November
 * 1, 2026 is the day daylight saving ends: 01:00–01:59 happens twice. A wall-clock time in that
 * hour is read as its FIRST occurrence (EDT); the report gives no way to tell the two apart, and
 * the choice is stated rather than left to whatever a library does.
 */

export const DATASET_VERSION = 'portmiami-dock-2026-11-enriched-v2';

export const NOV_START = '2026-11-01';
export const NOV_END = '2026-11-30';

// ---- America/New_York -------------------------------------------------------------------------

/** The nth Sunday of a month, as a day of the month (1-based). */
const nthSunday = (year, month, n) => {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((7 - first) % 7) + (n - 1) * 7;
};

/** US Eastern rules since 2007: DST from the 2nd Sunday of March 02:00 to the 1st Sunday of November 02:00. */
export function easternOffsetMinutes(year, month, day, hour, minute) {
  const start = nthSunday(year, 3, 2);
  const end = nthSunday(year, 11, 1);
  const stamp = ((month * 100 + day) * 100 + hour) * 100 + minute;
  const dstStart = ((3 * 100 + start) * 100 + 2) * 100;
  // The repeated hour 01:00–01:59 on the last day is read as EDT: DST ends at 02:00 local EDT.
  const dstEnd = ((11 * 100 + end) * 100 + 2) * 100;
  return stamp >= dstStart && stamp < dstEnd ? -240 : -300;
}

/** "2026-11-01T05:55:00" (America/New_York wall clock) to epoch milliseconds. */
export function localToUtcMs(local) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(local ?? ''));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(v => Number(v ?? 0));
  const offset = easternOffsetMinutes(y, mo, d, h, mi);
  return Date.UTC(y, mo - 1, d, h, mi, s) - offset * 60_000;
}

/**
 * Epoch milliseconds to the America/New_York wall clock: `{ date, time, offsetMinutes }`.
 *
 * Decided by the instant, not the wall clock, so the repeated hour on November 1 is told apart:
 * DST runs from 02:00 EST on its start day (07:00 UTC) to 02:00 EDT on its end day (06:00 UTC).
 */
export function utcMsToLocal(ms) {
  const year = new Date(ms).getUTCFullYear();
  const startUtc = Date.UTC(year, 2, nthSunday(year, 3, 2), 7);
  const endUtc = Date.UTC(year, 10, nthSunday(year, 11, 1), 6);
  const offset = ms >= startUtc && ms < endUtc ? -240 : -300;
  const local = new Date(ms + offset * 60_000);
  const pad = n => String(n).padStart(2, '0');
  return {
    date: `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`,
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
    offsetMinutes: offset,
  };
}

/** Midnight at the start of a local date, as epoch ms. */
export const localMidnightMs = date => localToUtcMs(`${date}T00:00:00`);

/** The next calendar date, as `YYYY-MM-DD`. */
export const nextDate = date => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

// ---- normalising one call ---------------------------------------------------------------------

const positive = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null);

/**
 * One Dock Report call in the twin's own shape.
 *
 * Field names are read as they appear in the files; nothing is inferred. A voyage option keeps
 * whether it returns to Miami and its scheduled return date only where the file states them.
 */
export function normalizeCall(raw) {
  const arrivalLocal = raw.arrival_datetime_local ?? null;
  const departureLocal = raw.departure_datetime_local ?? null;
  const voyageOptions = (raw.voyage_options ?? []).map(option => ({
    nights: positive(option.duration_nights),
    name: option.itinerary_name ?? null,
    endDate: option.end_date ?? null,
    returnsToMiami: option.returns_to_miami === true,
    scheduledReturnDate: option.scheduled_return_date ?? (option.returns_to_miami === true ? option.end_date ?? null : null),
    endsIn: option.ends_in ?? null,
  }));
  return {
    id: raw.id,
    dockRequestNumber: raw.dock_request_number ?? null,
    shipName: raw.ship_name,
    cruiseLine: raw.cruise_line ?? null,
    terminalCode: raw.terminal_code ?? null,
    scheduledTerminalCode: raw.scheduled_terminal_code ?? null,
    arrivalLocal,
    departureLocal,
    arrivalMs: localToUtcMs(arrivalLocal),
    departureMs: localToUtcMs(departureLocal),
    arrivalDate: raw.arrival_date ?? arrivalLocal?.slice(0, 10) ?? null,
    departureDate: raw.departure_date ?? departureLocal?.slice(0, 10) ?? null,
    // Only a VALIDATED capacity is simulable. Files built from the vessel master say so in
    // `capacity_status`; an older file without it carries only capacities it vouched for.
    passengerCapacity: !raw.capacity_status || raw.capacity_status === 'VALIDATED' ? positive(raw.passenger_capacity) : null,
    publishedCapacity: positive(raw.published_capacity ?? raw.passenger_capacity),
    capacityType: raw.capacity_type ?? null,
    capacityStatus: raw.capacity_status ?? (positive(raw.passenger_capacity) ? 'VALIDATED' : 'NOT_YET_SOURCED'),
    passengerCapacitySource: raw.passenger_capacity_source ?? null,
    vesselId: raw.vessel_id ?? null,
    vesselImo: raw.vessel_imo ?? null,
    actualPassengers: positive(raw.actual_passengers),
    berthMovements: (raw.berth_movements ?? []).map(move => ({
      terminalCode: move.terminal_code ?? null,
      berthPosition: move.berth_position ?? null,
      berthingSide: move.berthing_side_code ?? null,
      arrivalLocal: move.berth_arrival_local ?? null,
      departureLocal: move.berth_departure_local ?? null,
      arrivalMs: localToUtcMs(move.berth_arrival_local),
      departureMs: localToUtcMs(move.berth_departure_local),
      rawLabel: move.raw_label ?? null,
    })),
    voyageOptions,
    itineraryMatchStatus: raw.itinerary_match_status ?? null,
    portStayMinutes: positive(raw.reported_port_stay_minutes),
    source: {
      report: 'PortMiami November 2026 Dock Report',
      pdfPage: raw.source_pdf_page ?? null,
      terminalAssignment: raw.terminal_assignment_source ?? null,
      notes: raw.notes ?? [],
    },
    raw,
  };
}

/**
 * Normalise a whole file, ordered by arrival then id so every run sees the same order.
 *
 * @returns {{ metadata: object, calls: object[] }}
 */
export function importDockReport(file) {
  const calls = (file?.cruise_calls ?? []).map(normalizeCall)
    .sort((a, b) => (a.arrivalMs ?? 0) - (b.arrivalMs ?? 0) || String(a.id).localeCompare(String(b.id)));
  return { metadata: file?.metadata ?? {}, calls };
}

/** Calls the simulation may use: a positive passenger capacity and both timestamps. */
export const isSimulable = call => Boolean(call.passengerCapacity && Number.isFinite(call.arrivalMs)
  && Number.isFinite(call.departureMs));

/**
 * How much of the report the simulation can actually use, for the coverage indicator.
 *
 * `knownTerminalCodes` are the codes the registry holds a terminal for; any other code (the
 * report's "AAA", for one) is listed as unresolved rather than remapped.
 */
export function coverage(calls, { knownTerminalCodes = [], mappedTerminalCodes = [] } = {}) {
  const usable = calls.filter(isSimulable);
  const codes = [...new Set(calls.map(c => c.terminalCode).filter(Boolean))].sort();
  // A ship is one vessel however many calls it makes: counted by vessel id, else by name.
  const vesselKey = c => c.vesselId ?? `name:${String(c.shipName).trim().toUpperCase()}`;
  const vessels = new Set(calls.map(vesselKey));
  const modelledVessels = new Set(usable.map(vesselKey));
  return {
    totalCalls: calls.length,
    withCapacity: usable.length,
    excluded: calls.length - usable.length,
    totalVessels: vessels.size,
    modelledVessels: modelledVessels.size,
    terminals: codes,
    unknownTerminals: codes.filter(code => !knownTerminalCodes.includes(code)),
    unmappedTerminals: codes.filter(code => !mappedTerminalCodes.includes(code)),
  };
}

/** Calls with any port time on a local date (arriving, departing, or alongside through it). */
export function callsOnDate(calls, date) {
  const start = localMidnightMs(date), end = localMidnightMs(nextDate(date));
  return calls.filter(c => c.arrivalMs < end && c.departureMs >= start);
}
