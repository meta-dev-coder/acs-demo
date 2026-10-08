/**
 * What has happened at this place before.
 *
 * The TMC already answers "how risky is this incident". This answers the different question an
 * experienced controller asks next: is this a spot where things keep happening, and does the
 * pattern say anything about what to watch now.
 *
 * WHAT THE CONNECTED DATA ACTUALLY IS. The register (DataConnect class "Florida I595 Incidents",
 * 178 records) is an operational and asset-damage record with some crash attributes, NOT an official
 * crash report. Measured on it:
 *
 *   root_cause              0 / 178    there is no reported cause in this data, at all
 *   root_cause_category   152 / 178    a contributing circumstance, which is a different thing
 *   incident_type         178 / 178    the crash pattern
 *   injuries / fatalities 178 / 178    outcomes, from which severity is derived
 *   segment ID             68 / 178    direction, where it exists
 *   coordinates           178 / 178    but taken from the DAMAGED ASSET, not surveyed
 *
 * So this module reports patterns and never a cause. "Rear-end crashes are the most common pattern
 * here" is a count. "This location causes rear-end crashes" is a claim the data cannot support, and
 * nothing here produces wording like it.
 *
 * CORRELATION IS NOT CAUSATION, and the ratio below is a FREQUENCY COMPARISON, not an
 * exposure-adjusted crash rate: the register carries no AADT or VMT, so nothing is normalised by how
 * much traffic passes a point.
 *
 * Pure: records in, an analysis out. No DOM, no Cesium, no fetching.
 */
import { distanceMeters } from '../liveOps/eventPulseModel.js';
import { CARRIAGEWAYS } from '../liveOps/carriagewayModel.js';
import { eventInterval } from './temporalContext.js';
import {
  concentrationLevelFor, HISTORICAL_SAFETY_CONFIG, timeBucketFor,
} from './historicalSafetyConfig.js';

const text = value => (value == null ? '' : String(value).trim());
const known = value => text(value) !== '' && !/^(na|n\/a|-)$/i.test(text(value));
const attributesOf = record => record?.raw?.attributes ?? record?.raw ?? record?.attributes ?? {};

/**
 * Where a historical record's coordinates came from, and how much that is worth.
 *
 * The register publishes no geometry of its own (measured: 0 of 178 rows). Every position is the
 * location of the DAMAGED ASSET the record was filed against — a signpost, an attenuator, a light
 * column. That is a reasonable proxy for roughly where something happened and a poor one for where
 * a vehicle actually came to rest, and 178 records resolve to only 77 distinct points because many
 * share an asset.
 *
 * So a concentration computed from these is a concentration of RECORDS AROUND ASSETS. It is not
 * surveyed crash geometry, and this module never lets it be read as such.
 */
export const LOCATION_SOURCES = Object.freeze({
  ASSET: 'DAMAGED_ASSET',
  RECORD: 'RECORD',
  UNKNOWN: 'UNKNOWN',
});

export const LOCATION_SOURCE_LABELS = Object.freeze({
  DAMAGED_ASSET: 'Damaged asset location',
  RECORD: 'Record coordinates',
  UNKNOWN: 'Unknown',
});

/** What a record says about where its coordinates came from. Never inferred. */
export function locationSourceOf(record) {
  const basis = record?.liveOps?.spatialMatch?.basis ?? record?.locationSource ?? null;
  if (/asset/i.test(String(basis ?? ''))) return LOCATION_SOURCES.ASSET;
  if (/record/i.test(String(basis ?? ''))) return LOCATION_SOURCES.RECORD;
  return LOCATION_SOURCES.UNKNOWN;
}

/** The spatial confidence a record carries, as the corridor's own classifier states it. */
export const spatialConfidenceOf = record =>
  record?.liveOps?.spatialMatch?.confidence ?? null;

/**
 * Whether a record is a CONFIRMED crash record.
 *
 * The register mixes investigated crashes with asset-damage events. A police report number is the
 * only field in it that evidences an official crash report, and it is present on 88 of 178. Without
 * one, "crash" is the application's word, not the source's — so the counts are called historical
 * incidents instead.
 */
export const isConfirmedCrashRecord = record => known(attributesOf(record).police_report_number);

/** How confidently a historical crash was matched to the selected incident's place. */
export const MATCH_CONFIDENCE = Object.freeze({
  /** Same corridor, same carriageway, within the radius. */
  CARRIAGEWAY: 'CARRIAGEWAY_MATCHED',
  /** Within the radius, but the carriageway of one side or the other is unknown. */
  LOCATION: 'LOCATION_ONLY',
});


/** The instant a historical record happened, however it reached us. */
export const crashInstant = record => {
  const direct = record?.reportedAtMs ?? null;
  if (Number.isFinite(direct)) return direct;
  const { from } = eventInterval(record?.event ?? record);
  return Number.isFinite(from) ? from : null;
};

const placed = record => Number.isFinite(record?.longitude) && Number.isFinite(record?.latitude);

/**
 * The window a historical analysis may look at.
 *
 * Ends at the incident, never after it. Analysing a 1 October incident with crashes from 2 October
 * would be look-ahead leakage: the screen would be explaining the past with information nobody had
 * at the time, and any judgement about how the incident was handled would be unfair.
 */
export function analysisWindow(anchorMs, { lookbackMonths = HISTORICAL_SAFETY_CONFIG.lookbackMonths } = {}) {
  if (!Number.isFinite(anchorMs)) return null;
  const end = new Date(anchorMs);
  const start = new Date(anchorMs);
  start.setUTCMonth(start.getUTCMonth() - lookbackMonths);
  return { startMs: start.getTime(), endMs: end.getTime(), lookbackMonths };
}

/**
 * The historical crashes that count as "here", nearest first.
 *
 * Road-aware where the data allows it: when BOTH the selected incident and a historical record
 * state a carriageway, a record on the other carriageway is excluded even if it is closer, because
 * traffic on the opposite side is not approaching the same place. Where either side is unknown the
 * record is kept and the match is declared LOCATION_ONLY, never upgraded to a carriageway claim.
 */
export function crashesNear(selected, records, {
  radiusMeters = HISTORICAL_SAFETY_CONFIG.defaultRadiusMeters,
  window = null,
} = {}) {
  if (!placed(selected)) return [];
  const here = { latitude: selected.latitude, longitude: selected.longitude };
  const selectedWay = carriagewayOf(selected);
  const selectedId = text(selected.id);

  const out = [];
  for (const record of records ?? []) {
    if (!placed(record)) continue;
    // An incident is never part of its own location history: counting it would turn one crash into
    // "1 previous crash here".
    if (text(record.id) && text(record.id) === selectedId) continue;

    const at = crashInstant(record);
    if (window) {
      if (!Number.isFinite(at)) continue;
      // Strictly before the incident, and no earlier than the lookback.
      if (at >= window.endMs || at < window.startMs) continue;
    }

    const metres = distanceMeters(here, { latitude: record.latitude, longitude: record.longitude });
    if (!Number.isFinite(metres) || metres > radiusMeters) continue;

    const recordWay = carriagewayOf(record);
    const bothKnown = selectedWay && recordWay;
    if (bothKnown && selectedWay !== recordWay) continue;
    out.push({
      record,
      metres: Math.round(metres),
      atMs: at,
      matchConfidence: bothKnown ? MATCH_CONFIDENCE.CARRIAGEWAY : MATCH_CONFIDENCE.LOCATION,
    });
  }
  return out.sort((a, b) => a.metres - b.metres);
}

/** The carriageway a record states, or null. Never guessed from position. */
function carriagewayOf(record) {
  const way = record?.carriageway ?? record?.liveOps?.carriageway ?? null;
  if (way === CARRIAGEWAYS.EB_GENERAL || way === CARRIAGEWAYS.WB_GENERAL) return way;
  return null;
}

/**
 * How many crashes a comparable stretch of this corridor holds.
 *
 * Same-sized windows sampled along the centreline, so a 250 m circle is compared with other 250 m
 * circles. See the config for why empty stretches are left out of the median.
 */
export function corridorBaseline(records, centerline, {
  radiusMeters = HISTORICAL_SAFETY_CONFIG.defaultRadiusMeters,
  window = null,
  config = HISTORICAL_SAFETY_CONFIG.baseline,
} = {}) {
  const points = sampleCorridor(centerline, config.sampleSpacingMeters);
  if (!points.length) return { value: null, windows: 0, reason: 'No corridor centreline available' };

  const inWindow = (records ?? []).filter(record => {
    if (!placed(record)) return false;
    if (!window) return true;
    const at = crashInstant(record);
    return Number.isFinite(at) && at < window.endMs && at >= window.startMs;
  });

  const counts = [];
  for (const [longitude, latitude] of points) {
    let n = 0;
    for (const record of inWindow) {
      if (distanceMeters({ latitude, longitude }, { latitude: record.latitude, longitude: record.longitude }) <= radiusMeters) n += 1;
    }
    counts.push(n);
  }
  const considered = (config.ignoreEmptyWindows ? counts.filter(n => n > 0) : counts).sort((a, b) => a - b);
  if (considered.length < config.minimumWindows) {
    return { value: null, windows: considered.length, reason: 'Too few comparable stretches to form a baseline' };
  }
  return {
    value: considered[Math.floor(considered.length / 2)],
    windows: considered.length,
    reason: null,
  };
}

/** Points along the corridor at a fixed spacing, for the baseline windows. */
function sampleCorridor(centerline, spacingMeters) {
  // The corridor is carried as {lon, lat} in this application, as [lon, lat] in GeoJSON, and as
  // {longitude, latitude} by the event model. All three are accepted rather than requiring callers
  // to convert — reading only one of them silently produced "no corridor centreline available".
  const line = (centerline ?? []).map(point => (Array.isArray(point)
    ? point
    : [point?.longitude ?? point?.lon, point?.latitude ?? point?.lat]))
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
  if (line.length < 2) return [];
  const out = [line[0]];
  let carried = 0;
  for (let i = 1; i < line.length; i += 1) {
    const step = distanceMeters(
      { longitude: line[i - 1][0], latitude: line[i - 1][1] },
      { longitude: line[i][0], latitude: line[i][1] });
    carried += Number.isFinite(step) ? step : 0;
    if (carried >= spacingMeters) { out.push(line[i]); carried = 0; }
  }
  return out;
}

/** Count by a key, as a sorted list with shares. Returns [] when nothing states the field. */
function tally(matches, read, { top = HISTORICAL_SAFETY_CONFIG.topPatterns } = {}) {
  const counts = new Map();
  let stated = 0;
  for (const match of matches) {
    const value = read(match.record);
    if (!known(value)) continue;
    stated += 1;
    counts.set(text(value), (counts.get(text(value)) ?? 0) + 1);
  }
  if (!stated) return [];
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count, share: count / stated, of: stated }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, top);
}

/** Whether a record records a harmful outcome. Uses the register's own yes/no fields only. */
const isYes = value => /^y(es)?$/i.test(text(value));

/**
 * Analyse the location around a selected incident.
 *
 * @param {{selectedIncident: object, historicalCrashes: object[], centerline: any[],
 *          radiusMeters?: number, lookbackMonths?: number, now?: number}} input
 */
export function analyzeHistoricalLocation({
  selectedIncident,
  historicalCrashes = [],
  centerline = [],
  radiusMeters = HISTORICAL_SAFETY_CONFIG.defaultRadiusMeters,
  lookbackMonths = HISTORICAL_SAFETY_CONFIG.lookbackMonths,
  anchorMs = null,
} = {}) {
  const unavailable = reason => Object.freeze({
    available: false, reason,
    location: null, analysisWindow: null,
    totals: Object.freeze({ crashes: 0, severeCrashes: 0, fatalCrashes: 0, injuryCrashes: 0 }),
    concentration: Object.freeze({ level: 'UNKNOWN', levelLabel: 'Unknown', localValue: null, corridorBaseline: null, ratio: null, reason }),
    crashTypes: [], contributingFactors: [], timePatterns: [], weatherPatterns: [], severityPatterns: [],
    matches: [], matchBasis: null,
    provenance: Object.freeze({ locationSource: LOCATION_SOURCES.UNKNOWN, locationSourceLabel: LOCATION_SOURCE_LABELS.UNKNOWN,
      spatialConfidence: 'LOW', confirmedCrashRecords: 0, recordNoun: 'historical incidents', surveyedCrashGeometry: false }),
    dataQuality: Object.freeze({ availableFields: [], unavailableFields: [], confidence: 'LOW' }),
  });

  if (!placed(selectedIncident)) return unavailable('The selected incident has no usable coordinates');
  const anchor = Number.isFinite(anchorMs) ? anchorMs : crashInstant(selectedIncident);
  if (!Number.isFinite(anchor)) return unavailable('The selected incident has no usable timestamp');
  if (!(historicalCrashes ?? []).length) return unavailable('No historical crash records are connected');

  const window = analysisWindow(anchor, { lookbackMonths });
  const matches = crashesNear(selectedIncident, historicalCrashes, { radiusMeters, window });

  // How the matching was done, said plainly. An unresolved carriageway does not stop the analysis;
  // it changes what the analysis is allowed to claim.
  const carriagewayMatched = matches.length > 0 && matches.every(m => m.matchConfidence === MATCH_CONFIDENCE.CARRIAGEWAY);
  const matchBasis = Object.freeze({
    mode: carriagewayMatched ? MATCH_CONFIDENCE.CARRIAGEWAY : MATCH_CONFIDENCE.LOCATION,
    label: carriagewayMatched ? 'Corridor and carriageway matched' : 'Location-based only',
    confidence: carriagewayMatched ? 'HIGH' : 'MEDIUM',
    reason: carriagewayMatched ? null
      : carriagewayOf(selectedIncident)
        ? 'Some nearby records do not state a carriageway'
        : 'Incident carriageway could not be resolved',
  });

  const baseline = corridorBaseline(historicalCrashes, centerline, { radiusMeters, window });
  const local = matches.length;
  const ratio = baseline.value ? local / baseline.value : null;
  const bandable = local >= HISTORICAL_SAFETY_CONFIG.concentration.minimumLocalCrashes && Number.isFinite(ratio);
  const band = bandable ? concentrationLevelFor(ratio) : null;

  /**
   * Where these coordinates came from, and what the records actually are.
   *
   * Both are reported rather than assumed, and both constrain what the concentration below is
   * allowed to claim. The weakest source among the matched records wins: one asset-derived position
   * in the set is enough to stop the whole thing being called surveyed crash geometry.
   */
  const sources = new Set(matches.map(m => locationSourceOf(m.record)));
  const selectedSource = locationSourceOf(selectedIncident);
  const locationSource = sources.has(LOCATION_SOURCES.ASSET) || selectedSource === LOCATION_SOURCES.ASSET
    ? LOCATION_SOURCES.ASSET
    : sources.has(LOCATION_SOURCES.UNKNOWN) || selectedSource === LOCATION_SOURCES.UNKNOWN
      ? LOCATION_SOURCES.UNKNOWN
      : LOCATION_SOURCES.RECORD;
  const confidences = [spatialConfidenceOf(selectedIncident), ...matches.map(m => spatialConfidenceOf(m.record))].filter(Boolean);
  const spatialConfidence = confidences.includes('LOW') || locationSource !== LOCATION_SOURCES.RECORD ? 'LOW'
    : confidences.includes('MEDIUM') ? 'MEDIUM' : confidences.length ? 'HIGH' : 'LOW';
  const confirmedCrashRecords = matches.filter(m => isConfirmedCrashRecord(m.record)).length;
  // Only call them crashes when every matched record carries evidence of an official crash report.
  const allConfirmed = matches.length > 0 && confirmedCrashRecords === matches.length;
  const provenance = Object.freeze({
    locationSource,
    locationSourceLabel: LOCATION_SOURCE_LABELS[locationSource],
    spatialConfidence,
    confirmedCrashRecords,
    totalRecords: matches.length,
    recordNoun: allConfirmed ? 'crashes' : 'historical incidents',
    /** True only when positions are the records' own, not an asset's. */
    surveyedCrashGeometry: locationSource === LOCATION_SOURCES.RECORD && spatialConfidence === 'HIGH',
  });

  const severe = matches.filter(m => isYes(attributesOf(m.record).hospitalizations) || isYes(attributesOf(m.record).fatalities)).length;
  const fatal = matches.filter(m => isYes(attributesOf(m.record).fatalities)).length;
  const injury = matches.filter(m => isYes(attributesOf(m.record).injuries_y_n)).length;

  const timePatterns = tally(matches, record => timeBucketFor(hourOf(record))?.label ?? null,
    { top: HISTORICAL_SAFETY_CONFIG.timeBuckets.length });
  const selectedBucket = timeBucketFor(hourOf(selectedIncident, anchor));

  // Fields this analysis could and could not read, so the panel never implies more than it has.
  const availableFields = [];
  const unavailableFields = [];
  const note = (name, present) => (present ? availableFields : unavailableFields).push(name);
  const crashTypes = tally(matches, record => attributesOf(record).incident_type);
  const contributingFactors = tally(matches, record => attributesOf(record).root_cause_category);
  const weatherPatterns = tally(matches, record => attributesOf(record).weather);
  note('Crash type', crashTypes.length > 0);
  note('Severity outcomes', matches.length > 0);
  note('Contributing circumstance', contributingFactors.length > 0);
  note('Time of day', timePatterns.length > 0);
  note('Weather recorded with the crash', weatherPatterns.length > 0);
  // Measured as empty on every record in the connected register.
  unavailableFields.push('Reported cause', 'Road surface', 'Lighting', 'Work zone indicator', 'Distracted driving indicator', 'Alcohol or drug indicator');

  return Object.freeze({
    available: true,
    reason: null,
    location: Object.freeze({ latitude: selectedIncident.latitude, longitude: selectedIncident.longitude }),
    analysisWindow: Object.freeze({
      distanceMeters: radiusMeters,
      startMs: window.startMs, endMs: window.endMs, lookbackMonths,
    }),
    totals: Object.freeze({ crashes: local, severeCrashes: severe, fatalCrashes: fatal, injuryCrashes: injury }),
    concentration: Object.freeze({
      level: band?.id ?? 'UNKNOWN',
      levelLabel: band?.label ?? 'Unknown',
      localValue: local,
      corridorBaseline: baseline.value,
      ratio: Number.isFinite(ratio) ? Math.round(ratio * 10) / 10 : null,
      baselineWindows: baseline.windows,
      reason: band ? null : (baseline.reason
        ?? `Fewer than ${HISTORICAL_SAFETY_CONFIG.concentration.minimumLocalCrashes} nearby crashes — too few to compare`),
    }),
    crashTypes,
    contributingFactors,
    timePatterns,
    weatherPatterns,
    severityPatterns: Object.freeze([
      { value: 'Hospitalisation or fatality', count: severe, share: local ? severe / local : 0, of: local },
      { value: 'Injury reported', count: injury, share: local ? injury / local : 0, of: local },
    ]),
    /** Whether the selected incident's own hour is a common one here. A pattern, not a cause. */
    selectedTimeBucket: selectedBucket
      ? Object.freeze({
        id: selectedBucket.id, label: selectedBucket.label,
        share: timePatterns.find(entry => entry.value === selectedBucket.label)?.share ?? 0,
        isMostCommon: timePatterns[0]?.value === selectedBucket.label && timePatterns.length > 0,
      })
      : null,
    matches,
    matchBasis,
    provenance,
    dataQuality: Object.freeze({
      availableFields, unavailableFields,
      confidence: matchBasis.confidence === 'HIGH' && local >= 5 ? 'HIGH' : local > 0 ? 'MEDIUM' : 'LOW',
    }),
  });
}

/** The corridor-local hour a record happened. */
function hourOf(record, fallbackMs = null) {
  const at = crashInstant(record) ?? fallbackMs;
  if (!Number.isFinite(at)) return null;
  const hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(at)).find(part => part.type === 'hour')?.value;
  return hour == null ? null : Number(hour);
}

/**
 * The display filters the History tab offers over the matched records.
 *
 * Presentation only: these narrow what is DRAWN, never what was counted. The risk score, the
 * concentration and the patterns are all computed from the full matched set before any filter is
 * applied, so clicking a bar can never change a number on the screen above it.
 */
export const HISTORY_FILTERS = Object.freeze({
  TYPE: 'type',
  TIME: 'time',
  SEVERITY: 'severity',
});

/** Whether one matched record passes a display filter. A null filter passes everything. */
export function matchesHistoryFilter(match, filter) {
  if (!filter?.type) return true;
  const attributes = attributesOf(match?.record);
  if (filter.type === HISTORY_FILTERS.TYPE) return text(attributes.incident_type) === filter.value;
  if (filter.type === HISTORY_FILTERS.TIME) {
    const at = crashInstant(match?.record);
    if (!Number.isFinite(at)) return false;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(at)).find(part => part.type === 'hour')?.value);
    return timeBucketFor(hour)?.label === filter.value;
  }
  if (filter.type === HISTORY_FILTERS.SEVERITY) {
    const yes = value => /^y(es)?$/i.test(text(value));
    if (filter.value === 'fatal') return yes(attributes.fatalities);
    if (filter.value === 'severe') return yes(attributes.hospitalizations) || yes(attributes.fatalities);
    if (filter.value === 'injury') return yes(attributes.injuries_y_n);
    // An outcome this does not recognise matches nothing. Returning true here meant a severity
    // filter silently kept every record: the map showed 31 of 31 while the row said 21.
    return false;
  }
  return false;
}

/** The matched records a filter leaves visible. */
export const filteredMatches = (analysis, filter) =>
  (analysis?.matches ?? []).filter(match => matchesHistoryFilter(match, filter));

/**
 * Matched records grouped by the place they share.
 *
 * These records are positioned on damaged assets, so many of them resolve to the same coordinate —
 * 178 records across 77 distinct points on the connected register. Drawing one marker per record
 * stacks a dozen identical circles on one asset; drawing one per PLACE, carrying its count, says
 * the same thing legibly.
 *
 * The caller must pass the records it intends to DISPLAY. Clustering the full set and then dimming
 * the non-matching ones produced counts that contradicted the filter: a place holding five records
 * of which two matched still showed five.
 *
 * Ordered west to east, which is what lets a caller alternate leader heights so neighbouring
 * bubbles never land at the same height.
 */
export function clusterMatchesByPlace(matches) {
  const byPlace = new Map();
  for (const match of matches ?? []) {
    const record = match?.record;
    if (!Number.isFinite(record?.longitude) || !Number.isFinite(record?.latitude)) continue;
    const key = `${record.latitude.toFixed(5)},${record.longitude.toFixed(5)}`;
    const seen = byPlace.get(key);
    if (seen) seen.count += 1;
    else byPlace.set(key, { key, count: 1, match, longitude: record.longitude, latitude: record.latitude });
  }
  return [...byPlace.values()].sort((a, b) => a.longitude - b.longitude);
}
