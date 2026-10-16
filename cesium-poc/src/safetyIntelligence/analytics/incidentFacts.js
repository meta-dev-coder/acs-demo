/**
 * The incident register, read as safety facts.
 *
 * One place decides what a record SAYS, so every number on the Safety Intelligence screen comes
 * from the same reading of the same corpus. The register is 178 records covering May 2024 to April
 * 2026 in the DataConnect class `Florida I595 Incidents`.
 *
 * What the audit of that corpus established, and what this module therefore refuses to pretend:
 *
 *   • A record carries NO crash coordinates. Its position is its damaged ASSET's position, which
 *     is where the asset stands, not where the vehicle came to rest. Every fact carries that
 *     provenance, and the screen says "asset-derived location" wherever it plots one.
 *   • 88 of 178 carry a police report number; the rest do not. That is the only field in the
 *     corpus that suggests an official record behind the row, so it is reported as a confirmation
 *     rate rather than assumed for all of them.
 *   • `root_cause` is empty in all 178. `root_cause_category` is present in 152 and is a CATEGORY
 *     somebody assigned, not an investigator's finding.
 *   • Nothing here is an official FDOT crash statistic. The provenance block says so in words.
 */
import { locationSourceOf, spatialConfidenceOf } from '../../tmc/historicalLocationSafety.js';

const attributesOf = record => record?.attributes ?? record?.raw?.attributes ?? record ?? {};
const text = value => {
  const string = String(value ?? '').trim();
  return string && string.toUpperCase() !== 'N/A' && string !== '1900-01-00' ? string : null;
};
const yes = value => /^y(es)?$/i.test(String(value ?? '').trim());
const number = value => (Number.isFinite(Number(value)) && text(value) !== null ? Number(value) : null);

/** `30/03/2026 00:00` plus `19:32` → one instant, read as the corridor's local day. */
export function instantOf(record) {
  const attributes = attributesOf(record);
  const date = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(String(attributes.incident_date ?? ''));
  if (!date) return null;
  const [, day, month, year] = date;
  const time = /^(\d{1,2}):(\d{2})/.exec(String(attributes.incident_time ?? '')) ?? [, '0', '0'];
  return {
    ms: Date.UTC(Number(year), Number(month) - 1, Number(day), Number(time[1]), Number(time[2])),
    dayKey: `${year}-${month}-${day}`,
    monthKey: `${year}-${month}`,
    hour: Number(time[1]),
    /** 0 = Sunday, as `Date` counts it. */
    weekday: new Date(Date.UTC(Number(year), Number(month) - 1, Number(day))).getUTCDay(),
  };
}

/** How badly it went, from the two fields that record harm. */
export function severityOf(record) {
  const attributes = attributesOf(record);
  const fatalities = yes(attributes.fatalities) || number(attributes.fatalities) > 0;
  const injuries = yes(attributes.injuries_y_n);
  return {
    level: fatalities ? 'FATAL' : injuries ? 'INJURY' : 'PROPERTY_DAMAGE',
    label: fatalities ? 'Fatal' : injuries ? 'Injury' : 'No injury recorded',
    /** Ordering only — not a cost, and not a published severity index. */
    rank: fatalities ? 3 : injuries ? 2 : 1,
  };
}

/**
 * One register record as a fact.
 *
 * @param {object} record a maintenance `incidentRecord`
 * @param {Map<string, {longitude: number, latitude: number}>} [assetIndex] asset id -> position
 */
export function incidentFact(record, assetIndex = null) {
  const attributes = attributesOf(record);
  const when = instantOf(record);
  const assetId = text(attributes.damaged_asset_id);
  const asset = assetId && assetIndex ? assetIndex.get(assetId) ?? null : null;
  const longitude = Number.isFinite(record?.longitude) ? record.longitude : asset?.longitude ?? null;
  const latitude = Number.isFinite(record?.latitude) ? record.latitude : asset?.latitude ?? null;
  return Object.freeze({
    id: text(attributes.code) ?? record?.id ?? null,
    record,
    when,
    type: text(attributes.incident_type) ?? 'Unclassified',
    severity: severityOf(record),
    laneClosure: yes(attributes.lane_closure_y_n),
    laneClosureHours: number(attributes.lane_closure_duration_hours),
    speeding: yes(attributes.speeding_involved_y_n),
    weather: text(attributes.weather),
    trafficConditions: text(attributes.traffic_conditions),
    /** A category somebody assigned. Not an investigator's cause — `root_cause` is empty corpus-wide. */
    rootCauseCategory: text(attributes.root_cause_category),
    safetyDevices: text(attributes.safety_devices_present),
    segmentName: text(attributes['segment name']),
    assetId,
    longitude,
    latitude,
    /** Where the position came from, and how much to trust it. */
    locationSource: locationSourceOf(record),
    spatialConfidence: spatialConfidenceOf(record),
    /** The only hint of an official record behind the row. */
    policeReport: text(attributes.police_report_number),
    confirmed: Boolean(text(attributes.police_report_number)),
    notes: text(attributes.notes),
    recommendedNextAction: text(attributes.recommended_next_action),
  });
}

/** Asset id -> position, from the asset register. Built once and shared by every analysis. */
export function assetPositionIndex(assets = []) {
  const index = new Map();
  for (const asset of assets) {
    const attributes = attributesOf(asset);
    const id = text(attributes.code) ?? text(attributes.asset_id) ?? asset?.id;
    const longitude = Number.isFinite(asset?.longitude) ? asset.longitude : Number(attributes.x_coordinates);
    const latitude = Number.isFinite(asset?.latitude) ? asset.latitude : Number(attributes.y_coordinates);
    if (!id || !Number.isFinite(longitude) || !Number.isFinite(latitude)) continue;
    index.set(String(id), {
      longitude, latitude,
      category: text(attributes['asset category']),
      systemClass: text(attributes['system class']),
      criticality: text(attributes.criticality),
      description: text(attributes.description),
    });
  }
  return index;
}

/** Every record as a fact, in time order. */
export function incidentFacts(records = [], assetIndex = null) {
  return records
    .map(record => incidentFact(record, assetIndex))
    .filter(fact => fact.when)
    .sort((a, b) => a.when.ms - b.when.ms);
}

/**
 * What this corpus is, in the words the screen shows beside its numbers.
 *
 * Counted from the records in hand rather than stated, so it cannot drift from them.
 */
export function provenanceOf(facts = []) {
  const months = new Set(facts.map(fact => fact.when.monthKey));
  const located = facts.filter(fact => Number.isFinite(fact.longitude) && Number.isFinite(fact.latitude));
  const confirmed = facts.filter(fact => fact.confirmed);
  const sorted = [...facts].sort((a, b) => a.when.ms - b.when.ms);
  return Object.freeze({
    records: facts.length,
    source: 'DataConnect · Florida I595 Incidents',
    firstMonth: sorted[0]?.when.monthKey ?? null,
    lastMonth: sorted.at(-1)?.when.monthKey ?? null,
    months: months.size,
    located: located.length,
    /** Positions come from the damaged asset, not from a crash survey. */
    locationBasis: 'Asset-derived: each record is plotted at its damaged asset, not at a surveyed crash point.',
    confirmed: confirmed.length,
    confirmationBasis: 'A police report number is present on this many records; the rest carry none.',
    statisticalStanding: 'An operational register, not an official crash statistic. Counts describe these '
      + 'records only and must not be read as FDOT crash rates.',
  });
}
