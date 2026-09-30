/**
 * What an incident record actually says, in the words an operator would use.
 *
 * The incident classes are wide and flat — two dozen columns, most of them Yes/No — and reading one
 * as a column list makes an operator do the summarising. These helpers do it instead: the same
 * fields, grouped into the three questions that get asked about a crash (what happened, who was
 * hurt, what it is doing to traffic), with nothing invented where a column is empty.
 *
 * Pure: every function takes a normalized maintenance record and returns plain data.
 */

import { field } from '../maintenance/maintenanceRecords.js';
import { maintenanceDate } from './assetTypes.js';
import { crashSeverityTier, incidentSeverity } from './incidentTypes.js';
import { carriagewayLabel, segmentSpanLabel } from './incidentContext.js';

const text = value => {
  const string = value == null ? '' : String(value).trim();
  return string && string.toUpperCase() !== 'N/A' && string.toLowerCase() !== 'unknown' ? string : null;
};
const number = value => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));
const yes = value => /^y/i.test(String(value ?? ''));

/** A measured value with its unit, or null — "NA" and a blank are not measurements. */
const unit = (value, suffix) => {
  const n = number(value);
  return n == null ? null : `${n} ${suffix}`;
};

/**
 * Wind as one readable phrase.
 *
 * The feed publishes speed and bearing in separate columns; a bearing on its own means nothing to
 * a reader, so it is only shown attached to a speed.
 */
const windOf = (raw, record) => {
  const sdna = record?.related?.sdna ?? {};
  const speed = unit(field(raw, 'wind_speed_kmh') ?? sdna.wind_speed_kmh, 'km/h');
  if (!speed) return null;
  const degrees = number(field(raw, 'wind_direction_deg') ?? sdna.wind_direction_deg);
  return degrees == null ? speed : `${speed} ${compass(degrees)}`;
};

/**
 * A bearing as a compass label, to sixteen points.
 *
 * Sixteen and not eight because the feed's own weather line says "wind 6 km/h WNW" a few rows
 * above: rounding to NW here would have put two different directions for the same wind on one
 * panel, which reads as a bug whichever of them the operator believes.
 */
const COMPASS = Object.freeze(['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']);
const compass = degrees => COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16];

/**
 * One incident's columns, read through the field index so the committed export and the live
 * DataConnect envelope are the same shape here.
 *
 * @returns {{type: string|null, date: string|null, time: string|null, vehicles: number|null,
 *            injuries: boolean, hospitalizations: number|null, fatalities: number|null,
 *            laneClosure: boolean, closureHours: number|null, weather: string|null,
 *            traffic: string|null, rootCause: string|null, speeding: boolean,
 *            safetyDevices: string|null, damagedAssetId: string|null, damagedAsset: string|null,
 *            policeReport: string|null, recommendedAction: string|null, locationNotes: string|null,
 *            scenario: string|null, segment: string|null}}
 */
export function incidentFacts(record) {
  const raw = record?.raw ?? {};
  return {
    type: text(record?.title) ?? text(field(raw, 'incident_type')),
    date: text(record?.createdDate) ?? text(field(raw, 'incident_date')),
    time: text(field(raw, 'incident_time')),
    vehicles: number(field(raw, 'vehicle_count')),
    injuries: yes(field(raw, 'injuries_y_n')),
    hospitalizations: number(field(raw, 'hospitalizations')),
    fatalities: number(field(raw, 'fatalities')),
    laneClosure: yes(field(raw, 'lane_closure_y_n')),
    closureHours: number(field(raw, 'lane_closure_duration_hours')),
    // The register writes one word ("Clear"); the live feed writes a sentence with the temperature
    // and wind in it. Both are read, so an incident from either source answers "what was it like".
    weather: text(field(raw, 'weather')) ?? text(record?.related?.sdna?.weather_at_event),
    temperature: unit(field(raw, 'temperature_c') ?? record?.related?.sdna?.temperature_c, '°C'),
    humidity: unit(field(raw, 'relative_humidity_pct') ?? record?.related?.sdna?.relative_humidity_pct, '%'),
    wind: windOf(raw, record),
    precipitation: unit(field(raw, 'precipitation_mm') ?? record?.related?.sdna?.precipitation_mm, 'mm'),
    traffic: text(field(raw, 'traffic_conditions')) ?? text(record?.related?.sdna?.traffic_conditions),
    rootCause: text(field(raw, 'root_cause_category')) ?? text(field(raw, 'root_cause')),
    speeding: yes(field(raw, 'speeding_involved_y_n')),
    safetyDevices: text(field(raw, 'safety_devices_present')),
    damagedAssetId: text(record?.assetId) ?? text(field(raw, 'damaged_asset_id')),
    damagedAsset: text(record?.assetType) ?? text(field(raw, 'damaged_asset_description')),
    policeReport: text(field(raw, 'police_report_number')),
    recommendedAction: text(field(raw, 'recommended_next_action')),
    locationNotes: text(record?.description) ?? text(field(raw, 'location_notes')),
    scenario: text(field(raw, 'scenario_name')),
    segment: text(record?.segmentName) ?? text(field(raw, 'Segment')),
  };
}

/**
 * The record's date and time as one line: "May 27, 2024 · 04:00". Either half may be missing.
 *
 * Formatted through `maintenanceDate` rather than `new Date`, which reads "2024-07-16T00:00:00" as
 * LOCAL midnight: east of Greenwich that is the 15th in UTC, and the panel disagreed with the card
 * beside it by a day. These are calendar dates, so their components are taken as written.
 */
export function reportedAt(facts) {
  return [maintenanceDate(facts.date) ?? facts.date, facts.time].filter(Boolean).join(' · ') || null;
}

/**
 * The three numbers the heading carries, as a card each. Only the ones the record answers: an
 * incident with no vehicle count shows two cards rather than a dash.
 *
 * @returns {{value: string, label: string, tone: 'danger'|'warning'|'muted'}[]}
 */
export function incidentHeadline(facts) {
  const cards = [];
  if (facts.fatalities != null && facts.fatalities > 0) {
    cards.push({ value: String(facts.fatalities), label: facts.fatalities === 1 ? 'Fatality' : 'Fatalities', tone: 'danger' });
  } else if (facts.injuries) {
    cards.push({ value: facts.hospitalizations != null ? String(facts.hospitalizations) : 'Yes',
      label: facts.hospitalizations != null ? 'Hospitalized' : 'Injuries reported', tone: 'danger' });
  }
  if (facts.closureHours != null) {
    cards.push({ value: `${facts.closureHours} h`, label: 'Lanes closed for', tone: 'warning' });
  } else if (facts.laneClosure) {
    cards.push({ value: 'Yes', label: 'Lane closure', tone: 'warning' });
  }
  if (facts.vehicles != null) cards.push({ value: String(facts.vehicles), label: facts.vehicles === 1 ? 'Vehicle involved' : 'Vehicles involved', tone: 'muted' });
  return cards;
}

/**
 * The incident in prose — what the Traffic Impact tab leads with.
 *
 * Assembled only from columns the record carries, so a sparse record produces a short sentence
 * rather than a padded one. No duration, speed or delay is estimated: this corridor's incident
 * classes are historical records, and an invented "42 min delay" would read exactly like a measured
 * one.
 *
 * @returns {string[]} one or more sentences
 */
export function incidentNarrative(record, place = null) {
  const facts = incidentFacts(record);
  const sentences = [];
  const where = place?.resolved
    ? `on ${carriagewayLabel(place)}${facts.segment ? ` in the ${facts.segment}` : ''}`
    : facts.segment ? `in the ${facts.segment}` : 'on the I-595 corridor';
  const involving = facts.vehicles != null ? ` involving ${facts.vehicles} ${facts.vehicles === 1 ? 'vehicle' : 'vehicles'}` : '';
  sentences.push(`${facts.type ?? 'Incident'}${involving} ${where}${reportedAt(facts) ? `, reported ${reportedAt(facts)}` : ''}.`);

  if (facts.laneClosure) {
    sentences.push(facts.closureHours != null
      ? `Lanes were closed for ${facts.closureHours} ${facts.closureHours === 1 ? 'hour' : 'hours'}, so traffic was carried on the remaining lanes for that period.`
      : 'Lanes were closed while the incident was worked.');
  } else {
    sentences.push('No lane closure was recorded, so the carriageway stayed open throughout.');
  }

  const conditions = [facts.traffic ? `${facts.traffic.toLowerCase()} traffic` : null, facts.weather ? `${facts.weather.toLowerCase()} conditions` : null]
    .filter(Boolean).join(' and ');
  if (conditions) sentences.push(`Recorded in ${conditions}.`);

  const contributing = [facts.rootCause ? `root cause ${facts.rootCause.toLowerCase()}` : null, facts.speeding ? 'speeding involved' : null]
    .filter(Boolean).join('; ');
  if (contributing) sentences.push(`Contributing factors: ${contributing}.`);

  const harm = facts.fatalities ? `${facts.fatalities} ${facts.fatalities === 1 ? 'fatality' : 'fatalities'}` : null;
  const hurt = facts.hospitalizations ? `${facts.hospitalizations} hospitalized` : facts.injuries ? 'injuries reported' : null;
  if (harm || hurt) sentences.push(`Casualties: ${[harm, hurt].filter(Boolean).join(', ')}.`);
  if (facts.damagedAsset) sentences.push(`Asset damage: ${facts.damagedAsset}${facts.damagedAssetId ? ` (${facts.damagedAssetId})` : ''}.`);
  return sentences;
}

/** The Traffic Impact tab's measured rows — each one a column the record actually carries. */
export function impactRows(record, place = null) {
  const facts = incidentFacts(record);
  return [
    ['Lane closure', facts.laneClosure ? 'Yes' : facts.laneClosure === false ? 'No' : null],
    ['Closure duration', facts.closureHours == null ? null : `${facts.closureHours} ${facts.closureHours === 1 ? 'hour' : 'hours'}`],
    ['Traffic conditions', facts.traffic],
    ['Weather', facts.weather],
    ['Vehicles involved', facts.vehicles == null ? null : String(facts.vehicles)],
    ['Carriageway', place?.resolved ? carriagewayLabel(place) : null],
    ['Between', segmentSpanLabel(place)],
    ['Severity', incidentSeverity(record).label],
  ].filter(([, value]) => value != null);
}

/** The Details tab — the record's own columns, in the order an operator reads them. */
/**
 * The register's own segment name, or the FDOT segment the point actually falls on.
 *
 * carriagewayAt() already resolved that from the coordinates, so leaving the row blank hid an
 * answer the app had. A dash is treated as blank: the register writes "-" where it has no segment,
 * and a placeholder is not a value — that dash was why the fallback never fired.
 */
const BLANK = /^[-\u2013\u2014\s]*$/;
function segmentRow(facts, place) {
  const own = BLANK.test(String(facts.segment ?? '')) ? null : facts.segment;
  return own ?? (place?.resolved ? place.segmentId : null);
}

/** "High · Injuries reported" — the tier that colours the map, and what it is based on. */
const TIER_LABELS = Object.freeze({ severe: 'Severe', high: 'High', intermediate: 'Intermediate', minor: 'Minor' });
function severityRow(record) {
  const tier = crashSeverityTier(record);
  const basis = incidentSeverity(record).label;
  return basis ? `${TIER_LABELS[tier]} · ${basis}` : TIER_LABELS[tier];
}

export function detailFacts(record, place = null) {
  const facts = incidentFacts(record);
  return [
    ['Incident ID', record?.id ?? null],
    ['Incident type', facts.type],
    ['Reported', reportedAt(facts)],
    ['Location', place?.resolved ? carriagewayLabel(place) : null],
    ['Between', segmentSpanLabel(place)],
    // Severity is not a column in the register; it is what the crash DID — see crashSeverityTier.
    // Named the same way Safety's hotspot colours are, so a red circle and this row agree.
    ['Severity', severityRow(record)],
    // The register's own segment name where it has one, otherwise the FDOT segment the point
    // actually falls on — carriagewayAt() already resolved it from the coordinates, and leaving
    // the row as "—" hid an answer the app already had.
    ['Segment', segmentRow(facts, place)],
    ['Location notes', facts.locationNotes],
    // What it was like out there. The register carries one condition word and the traffic state;
    // the live feed carries a whole observation (temperature, wind, humidity), which its own panel
    // already prints. Both are shown here for the same reason — a crash is read against the
    // conditions it happened in, and the Safety screen now groups crashes by exactly this column.
    ['Weather', facts.weather],
    ['Temperature', facts.temperature],
    ['Humidity', facts.humidity],
    ['Wind', facts.wind],
    ['Precipitation', facts.precipitation],
    ['Traffic conditions', facts.traffic],
    ['Time of day', facts.time],
    ['Root cause', facts.rootCause],
    ['Speeding involved', facts.speeding ? 'Yes' : null],
    ['Safety devices', facts.safetyDevices],
    ['Damaged asset', facts.damagedAsset ? `${facts.damagedAsset}${facts.damagedAssetId ? ` · ${facts.damagedAssetId}` : ''}` : null],
    ['Police report', facts.policeReport],
    ['Scenario', facts.scenario],
    ['Recorded action', facts.recommendedAction],
    ['Source', record?.live ? 'DataConnect · live' : 'DataConnect · I-595 incident register'],
  ].filter(([, value]) => value != null);
}

/**
 * Placeholder next steps.
 *
 * Deliberately static for now: each of these is a real question the Twin will be asked to answer,
 * and wiring them to a model that cannot yet answer them would be worse than showing the shape.
 * They carry `pending: true` so nothing here can be mistaken for a computed recommendation.
 */
export const RECOMMENDED_STEPS = Object.freeze([
  Object.freeze({ id: 'recovery', icon: 'analysis', label: 'How long until traffic recovers?', pending: true }),
  Object.freeze({ id: 'dms', icon: 'sign', label: 'Should we update the DMS message?', pending: true }),
  Object.freeze({ id: 'reroute', icon: 'route', label: 'Show alternate routing options', pending: true }),
]);
