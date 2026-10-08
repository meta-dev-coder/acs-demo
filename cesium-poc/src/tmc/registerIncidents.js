/**
 * The incident REGISTER as the TMC's historical source.
 *
 * Two different things are both called "incidents" here, and keeping them apart matters:
 *
 *   • the FL511 live feed — minute-by-minute operational records, but only as far back as the live
 *     sync has been running (62 records, late September 2026 onward). It carries lane counts,
 *     concurrent congestion and closures: everything the secondary-risk model wants.
 *   • the DataConnect class "Florida I595 Incidents" — 178 investigated records going back to
 *     May 2024. It carries injuries, weather, vehicle counts and closure durations, and NO
 *     operational context at all, because nothing was recording the corridor minute by minute then.
 *
 * A date before the live sync started can only be answered from the register, so the TMC reads
 * both. What the register cannot support is reported as unavailable rather than guessed — there is
 * no congestion record from December 2025, so no congestion factor is ever scored for that date.
 *
 * LOCATION comes from the damaged asset, not from the incident: the register publishes no geometry
 * of its own (measured: 0 of 178 rows). That is a real approximation and is declared as such
 * through a LOW placement confidence, the same signal the corridor already uses for a weak spatial
 * match, so nothing downstream treats these positions as surveyed.
 *
 * Pure: records in, live-event-shaped incidents out. No DOM, no Cesium, no fetching.
 */
import { CARRIAGEWAYS } from '../liveOps/carriagewayModel.js';
import { fromLocalInputValue } from './temporalContext.js';

/** Where a TMC incident came from, so a screen can say which record it is showing. */
export const INCIDENT_SOURCES = Object.freeze({ LIVE: 'live', REGISTER: 'register' });

const text = value => (value == null ? '' : String(value).trim());
const known = value => text(value) !== '' && !/^(na|n\/a|-)$/i.test(text(value));
const isYes = value => /^y(es)?$/i.test(text(value));

/** The register writes dates day-first ("18/12/2025 00:00") and the time of day separately. */
export function registerInstant(dateValue, timeValue) {
  const date = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(text(dateValue));
  if (!date) return null;
  const [, day, month, year] = date;
  const time = /^(\d{1,2}):(\d{2})/.exec(text(timeValue));
  const hour = time ? time[1].padStart(2, '0') : '00';
  const minute = time ? time[2] : '00';
  // Read in corridor time, like every other date in this application.
  return fromLocalInputValue(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour}:${minute}`);
}

/**
 * How severe the register says an incident was.
 *
 * FL511's own vocabulary, so the risk model reads one scale rather than two. The register does not
 * publish a severity word; it publishes outcomes, and these are the outcomes in severity order.
 */
export function registerSeverity(attributes) {
  if (isYes(attributes?.fatalities)) return 'Major';
  if (isYes(attributes?.hospitalizations) || isYes(attributes?.injuries_y_n)) return 'Intermediate';
  return 'Minor';
}

/**
 * What the register says about lanes.
 *
 * It answers yes or no and never how many, so `blockedLanes` stays null: "a lane closure happened"
 * is not "one lane was closed", and writing 1 would invent a number the source does not have.
 */
export function registerLaneImpact(attributes) {
  if (!known(attributes?.lane_closure_y_n)) {
    return { blockedLanes: null, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'none' };
  }
  return {
    blockedLanes: null, fullClosure: false, rampClosure: false, shoulderOnly: false,
    // Stated, but not quantified — the risk model has a case for exactly this.
    closureStated: isYes(attributes.lane_closure_y_n),
    source: 'register',
  };
}

/** The register's own segment scheme ("101E", "103W") carries the direction as a suffix. */
export function registerCarriageway(segmentId) {
  const match = /([EW])\s*$/i.exec(text(segmentId));
  if (!match) return null;
  return match[1].toUpperCase() === 'E' ? CARRIAGEWAYS.EB_GENERAL : CARRIAGEWAYS.WB_GENERAL;
}

const toRadians = degrees => (degrees * Math.PI) / 180;
const metresApart = (aLon, aLat, bLon, bLat) => {
  const k = Math.cos(toRadians((aLat + bLat) / 2));
  return Math.hypot((bLon - aLon) * k, bLat - aLat) * 111_320;
};

/**
 * The corridor section nearest a point, on a given carriageway.
 *
 * Without a carriageway there is no answer: the two run alongside each other, so "nearest" would
 * pick whichever happens to be a few metres closer and hand the upstream resolver a direction the
 * register never stated.
 */
export function nearestSection(sections, longitude, latitude, carriageway) {
  if (!carriageway || !Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  let best = null;
  for (const section of sections ?? []) {
    if (section.carriageway !== carriageway) continue;
    for (const [lon, lat] of section.coordinates ?? []) {
      const metres = metresApart(longitude, latitude, lon, lat);
      if (!best || metres < best.metres) best = { section, metres };
    }
  }
  return best?.section ?? null;
}

/**
 * One register record as the TMC's incident shape.
 *
 * @param {object} record   a normalised maintenance record (id, longitude, latitude, raw)
 * @param {{sections?: object[]}} [context]
 * @returns {object|null} null when the record cannot be placed or dated
 */
export function registerIncident(record, { sections = [] } = {}) {
  const attributes = record?.raw?.attributes ?? record?.raw ?? {};
  const from = registerInstant(attributes.incident_date, attributes.incident_time);
  if (from == null) return null;
  if (!Number.isFinite(record?.longitude) || !Number.isFinite(record?.latitude)) return null;

  // The register times the CLOSURE, not the incident. Where a closure was recorded, that is how
  // long the corridor was affected; where it was not, the record is a single moment and is left as
  // one rather than given an invented length.
  const hours = Number(attributes.lane_closure_duration_hours);
  const closed = isYes(attributes.lane_closure_y_n);
  const to = closed && Number.isFinite(hours) && hours > 0 ? from + hours * 3_600_000 : from;

  const carriageway = registerCarriageway(attributes['segment ID']);
  const section = nearestSection(sections, record.longitude, record.latitude, carriageway);
  const type = text(attributes.incident_type) || 'Incident';

  return {
    id: text(record.id) || text(attributes.code),
    type: 'INCIDENT',
    source: INCIDENT_SOURCES.REGISTER,
    // The register's own row, carried through so location analysis can read crash type, outcomes
    // and contributing circumstance. Dropping it made every one of those fields invisible.
    raw: record.raw ?? { attributes },
    title: type,
    description: text(attributes.description) || type,
    severity: registerSeverity(attributes),
    longitude: record.longitude,
    latitude: record.latitude,
    cleared: true,
    clearedAt: new Date(to).toISOString(),
    sdna: {
      reported_at: new Date(from).toISOString(),
      cleared_at_dt: new Date(to).toISOString(),
      // Published by the register and by nothing in the live feed — worth carrying through.
      weather: text(attributes.weather) || null,
      traffic_conditions: text(attributes.traffic_conditions) || null,
      vehicles_involved: known(attributes.vehicle_count) ? text(attributes.vehicle_count) : null,
      injuries: text(attributes.injuries_y_n) || null,
      fatalities: text(attributes.fatalities) || null,
      police_report_number: text(attributes.police_report_number) || null,
    },
    liveOps: {
      carriageway: carriageway ?? CARRIAGEWAYS.UNKNOWN,
      direction: carriageway === CARRIAGEWAYS.WB_GENERAL ? 'WB' : carriageway === CARRIAGEWAYS.EB_GENERAL ? 'EB' : null,
      sectionId: section?.sectionId ?? null,
      sectionIndex: section?.sectionIndex ?? null,
      sectionLabel: section?.sectionLabel ?? null,
      segmentId: section?.segmentId ?? null,
      // The position is the damaged asset's, not the incident's. Saying so is the whole point.
      spatialMatch: { confidence: 'LOW', basis: record.locationSource === 'record' ? 'record' : 'damaged asset' },
      laneImpact: registerLaneImpact(attributes),
    },
  };
}

/** Every register record the TMC can place and date, as incidents. */
export const registerIncidents = (records, context) =>
  (records ?? []).map(record => registerIncident(record, context)).filter(Boolean);
