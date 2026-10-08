/**
 * Secondary incident risk: how much EVIDENCE there is that conditions around an active incident
 * raise the chance of another one.
 *
 * This is not Operational Impact and must not be confused with it. Operational Impact answers "how
 * much disruption is on this road section" — a property of the section. This answers "given this
 * incident and what is around it, how much evidence of elevated secondary risk is there" — a
 * property of the incident. Impact is one input here, never the output.
 *
 * It is RULE-BASED, not a prediction. It produces a level and the factors behind it, so an operator
 * can see the reasoning and disagree with it. It does not produce a probability, because nothing
 * here has been validated against actual secondary-crash outcomes.
 *
 * Every factor is scored from a field that exists in the connected data. Factors with no source —
 * responder status, queue length, whether a DMS is actually warning about this incident — are
 * listed as unavailable rather than assumed absent, because "we cannot see it" and "it is not
 * happening" are different answers and an operator needs to know which they are getting.
 *
 * Pure: an incident and its context in, a score out. No DOM, no Cesium, no fetching.
 */
import { UPSTREAM_STATUS } from './upstreamResolver.js';
import { HISTORICAL_SAFETY_CONFIG } from './historicalSafetyConfig.js';

/**
 * The weights, stated openly so they can be argued with and changed in one place.
 *
 * Sized against what the corridor's data can actually show. Lane blockage leads because it is the
 * one factor that is both well evidenced (parsed from FL511 prose on 29 of 61 events measured) and
 * directly implicated in secondary crashes — traffic stopping where drivers do not expect it.
 * Duration is deliberately mild and capped: a long incident is a worse exposure, but it is weak
 * evidence next to a blocked lane.
 */
export const SECONDARY_RISK_CONFIG = Object.freeze({
  factors: Object.freeze({
    LANE_CLOSURE: Object.freeze({
      label: 'Lane closure or blockage',
      /** A full closure of the carriageway, then per blocked lane, then a ramp. */
      fullClosure: 40, perBlockedLane: 18, maxLanes: 2, rampClosure: 8,
    }),
    UPSTREAM_CONGESTION: Object.freeze({
      label: 'Upstream congestion',
      /** A queue upstream is traffic arriving into the back of something. */
      present: 30, perExtraEvent: 8, max: 46,
    }),
    OPERATIONAL_IMPACT: Object.freeze({
      label: 'Operational Impact of the affected section',
      /** One input among several — never the score itself. */
      levels: Object.freeze({ SEVERE: 24, HIGH: 16, MODERATE: 8, LOW: 0, NORMAL: 0 }),
    }),
    INCIDENT_SEVERITY: Object.freeze({
      label: 'Incident severity',
      /** FL511's own wording, lower-cased. Anything unrecognised scores nothing. */
      levels: Object.freeze({ major: 20, severe: 20, intermediate: 10, moderate: 10, minor: 0 }),
    }),
    INCIDENT_DURATION: Object.freeze({
      label: 'Time the incident has been active',
      /** Exposure grows with time, but mildly and with a ceiling. */
      fromMinutes: 20, per10Minutes: 4, max: 16,
    }),
    /**
     * Weather at the incident's own time — a contributor, never the whole score and never a cause.
     *
     * Thresholds are the conventional meteorological and driving boundaries rather than numbers
     * chosen to make a demo look dramatic:
     *   • rain rate   light below 2.5 mm/h, heavy from 7.6 mm/h (US National Weather Service)
     *   • visibility  reduced below 5 km, poor below 2 km, severe below 1 km
     *   • wind        strong from 40 km/h sustained, damaging gusts from 60 km/h
     *
     * Precipitation is scored ONCE, from `precipitation`, which already includes rain. `rain` is
     * carried for display only — scoring both would count the same water twice.
     *
     * The total is capped below a full carriageway closure: weather raises risk, it does not
     * outrank the road being blocked.
     */
    WEATHER: Object.freeze({
      label: 'Weather at incident time',
      precipitation: Object.freeze({ lightFromMm: 0.2, moderateFromMm: 2.5, heavyFromMm: 7.6, light: 6, moderate: 14, heavy: 22 }),
      visibility: Object.freeze({ reducedBelowM: 5_000, poorBelowM: 2_000, severeBelowM: 1_000, reduced: 6, poor: 14, severe: 20 }),
      wind: Object.freeze({ strongFromKmh: 40, gustFromKmh: 60, strong: 5, gust: 9 }),
      /** Conditions that compound: wet road AND poor sight line, worse again into a queue. */
      combined: Object.freeze({ rainAndReducedVisibility: 6, withUpstreamQueue: 6 }),
      max: 40,
    }),
    /**
     * What has happened at this place before.
     *
     * Scored from the NORMALISED concentration band, never from the raw crash count: "18 crashes
     * nearby" means nothing without knowing what a typical stretch of this corridor holds. The
     * recurring patterns (crash type, weather, time of day) are deliberately NOT scored — they are
     * context that shapes what to watch, and scoring historical wet weather on top of the incident's
     * own measured weather would count the same idea twice.
     *
     * Capped well below lane blockage. A location's history is background; what is on the road now
     * is the incident.
     */
    HISTORICAL_LOCATION: Object.freeze({
      /**
       * "Incident", not "crash", by default. The connected register is not a crash register: only
       * 88 of 178 records carry a police report number, so calling every one of them a crash would
       * be the application asserting something its source does not.
       */
      label: 'Historical incident concentration at this location',
      crashLabel: 'Historical crash concentration at this location',
      levels: Object.freeze({ VERY_HIGH: 18, HIGH: 12, ELEVATED: 6, NORMAL: 0 }),
      max: 18,
    }),
  }),
  /** Where each level begins. A single blocked lane alone should not read as HIGH. */
  levels: Object.freeze([
    Object.freeze({ id: 'SEVERE', label: 'Severe', from: 90 }),
    Object.freeze({ id: 'HIGH', label: 'High', from: 60 }),
    Object.freeze({ id: 'MODERATE', label: 'Moderate', from: 30 }),
    Object.freeze({ id: 'LOW', label: 'Low', from: 0 }),
  ]),
});

/**
 * Factors the connected data cannot speak to, with why.
 *
 * Measured on the live feed: responder_status 0/61, responding_units 0/61, dms_message 0/61,
 * queue_length_mi 0/61, est_delay_min 0/61 — all marked `pending` in config/liveDc/eventFields.json
 * ("no source yet, always NA"). They are reported on every assessment so a low score is never
 * mistaken for a quiet corridor.
 */
export const WEATHER_UNAVAILABLE = Object.freeze({
  type: 'WEATHER', label: 'Weather at incident time', reason: 'Historical weather unavailable',
});

export const UNAVAILABLE_FACTORS = Object.freeze([
  Object.freeze({ type: 'RESPONDER_STATUS', label: 'Responder status', reason: 'Not available from the connected data' }),
  Object.freeze({ type: 'DMS_WARNING_ACTIVE', label: 'Upstream warning in place for this incident', reason: 'DMS message content is not published with the feed' }),
  Object.freeze({ type: 'QUEUE_LENGTH', label: 'Queue length', reason: 'Not available from the connected data' }),
  Object.freeze({ type: 'TRAFFIC_SPEED', label: 'Traffic speed or delay', reason: 'Not available from the connected data' }),
]);

export const levelFor = score =>
  (SECONDARY_RISK_CONFIG.levels.find(level => score >= level.from) ?? SECONDARY_RISK_CONFIG.levels.at(-1));

/**
 * Why a factor contributed nothing.
 *
 * The distinction §22 turns on: a factor that was EVALUATED and found to add nothing is a different
 * answer from one that could not be evaluated at all. Treating the second as the first is how a
 * screen quietly reports "no congestion upstream" when the truth is "we could not work out which
 * way upstream is".
 */
export const EVIDENCE = Object.freeze({
  CONTRIBUTING: 'CONTRIBUTING',
  NO_ADDED_RISK: 'NO_ADDED_RISK',
  UNKNOWN: 'UNKNOWN',
});

/** The component of the score a factor belongs to, for the breakdown. */
export const RISK_COMPONENTS = Object.freeze({
  TRAFFIC_EXPOSURE: 'trafficExposure',
  INCIDENT_LANE_IMPACT: 'incidentLaneImpact',
  ENVIRONMENT: 'environment',
  HISTORICAL_LOCATION: 'historicalLocation',
  OPERATIONAL_PROTECTION: 'operationalProtection',
});

const factor = (type, label, present, contribution, detail = null, {
  component = RISK_COMPONENTS.INCIDENT_LANE_IMPACT,
  evidence = present ? EVIDENCE.CONTRIBUTING : EVIDENCE.NO_ADDED_RISK,
} = {}) =>
  Object.freeze({ type, label, present, contribution: Math.round(contribution), detail, component, evidence });

/** What the lanes contribute, and how it reads. */
function laneFactor(incident) {
  const config = SECONDARY_RISK_CONFIG.factors.LANE_CLOSURE;
  const lanes = incident.lanes ?? {};
  // The source did not state lane impact — not the same as "nothing is blocked".
  // Not stated is UNKNOWN, not "nothing blocked".
  if (!lanes.stated) return factor('LANE_CLOSURE', config.label, false, 0, 'Lane impact not stated by the source', { evidence: EVIDENCE.UNKNOWN });
  if (lanes.fullClosure) return factor('LANE_CLOSURE', config.label, true, config.fullClosure, 'Full closure');
  if (Number.isFinite(lanes.blockedLanes) && lanes.blockedLanes > 0) {
    const counted = Math.min(lanes.blockedLanes, config.maxLanes);
    const plural = lanes.blockedLanes === 1 ? '' : 's';
    return factor('LANE_CLOSURE', config.label, true, counted * config.perBlockedLane,
      `${lanes.blockedLanes} lane${plural} blocked`);
  }
  if (lanes.rampClosure) return factor('LANE_CLOSURE', config.label, true, config.rampClosure, 'Ramp closure');
  // The incident register states THAT lanes closed and never how many. Scoring it as one lane is
  // the floor the record supports; the detail says so rather than implying a counted lane.
  if (lanes.closureStated) {
    return factor('LANE_CLOSURE', config.label, true, config.perBlockedLane,
      'Lane closure recorded — number of lanes not published');
  }
  if (lanes.shoulderOnly) return factor('LANE_CLOSURE', config.label, false, 0, 'Shoulder only');
  return factor('LANE_CLOSURE', config.label, false, 0, 'No lanes reported blocked');
}

function congestionFactor(upstreamCongestion, upstream) {
  const config = SECONDARY_RISK_CONFIG.factors.UPSTREAM_CONGESTION;
  // Upstream could not be worked out, so nothing here is evidence either way.
  // Upstream could not be worked out, so nothing here is evidence either way. Reported as UNKNOWN
  // rather than as an absence: "no congestion upstream" and "we cannot tell which way upstream is"
  // are different answers, and only one of them is reassuring.
  if (upstream?.status !== UPSTREAM_STATUS.RESOLVED) {
    return factor('UPSTREAM_CONGESTION', config.label, false, 0,
      `Unknown — upstream ${String(upstream?.reason ?? 'unresolved').toLowerCase()}`,
      { component: RISK_COMPONENTS.TRAFFIC_EXPOSURE, evidence: EVIDENCE.UNKNOWN });
  }
  const count = upstreamCongestion?.length ?? 0;
  if (!count) return factor('UPSTREAM_CONGESTION', config.label, false, 0, 'No congestion reported upstream',
    { component: RISK_COMPONENTS.TRAFFIC_EXPOSURE });
  const score = Math.min(config.max, config.present + (count - 1) * config.perExtraEvent);
  return factor('UPSTREAM_CONGESTION', config.label, true, score,
    `${count} congestion event${count === 1 ? '' : 's'} upstream`, { component: RISK_COMPONENTS.TRAFFIC_EXPOSURE });
}

function impactFactor(impactLevel) {
  const config = SECONDARY_RISK_CONFIG.factors.OPERATIONAL_IMPACT;
  // An unresolved section is not a NORMAL one. Scoring zero is unavoidable — there is nothing to
  // score — but it is declared UNKNOWN so nothing reads it as a quiet road.
  if (!impactLevel) return factor('OPERATIONAL_IMPACT', config.label, false, 0, 'Unknown — section impact not resolved',
    { component: RISK_COMPONENTS.TRAFFIC_EXPOSURE, evidence: EVIDENCE.UNKNOWN });
  const score = config.levels[impactLevel] ?? 0;
  return factor('OPERATIONAL_IMPACT', config.label, score > 0, score, `Operational Impact ${impactLevel}`,
    { component: RISK_COMPONENTS.TRAFFIC_EXPOSURE });
}

function severityFactor(incident) {
  const config = SECONDARY_RISK_CONFIG.factors.INCIDENT_SEVERITY;
  const word = String(incident.severity ?? '').trim().toLowerCase();
  if (!word) return factor('INCIDENT_SEVERITY', config.label, false, 0, 'Severity not published', { evidence: EVIDENCE.UNKNOWN });
  const score = config.levels[word] ?? 0;
  return factor('INCIDENT_SEVERITY', config.label, score > 0, score, `Reported ${incident.severity}`);
}

function durationFactor(incident) {
  const config = SECONDARY_RISK_CONFIG.factors.INCIDENT_DURATION;
  const minutes = incident.activeMinutes;
  if (minutes == null) return factor('INCIDENT_DURATION', config.label, false, 0, 'Start time not published',
    { component: RISK_COMPONENTS.TRAFFIC_EXPOSURE, evidence: EVIDENCE.UNKNOWN });
  if (minutes < config.fromMinutes) {
    return factor('INCIDENT_DURATION', config.label, false, 0, `Active ${minutes} min`, { component: RISK_COMPONENTS.TRAFFIC_EXPOSURE });
  }
  const over = minutes - config.fromMinutes;
  const score = Math.min(config.max, Math.floor(over / 10) * config.per10Minutes + config.per10Minutes);
  return factor('INCIDENT_DURATION', config.label, true, score, `Active ${minutes} min`, { component: RISK_COMPONENTS.TRAFFIC_EXPOSURE });
}

/**
 * What the weather at the incident's time contributes.
 *
 * Returns a list, not one factor, because "it was bad weather" is not something an operator can act
 * on: rain, a short sight line and a gusting crosswind call for different responses, so each is
 * weighed and reported separately. A reading that shows nothing operationally relevant produces a
 * single present:false factor rather than four quiet zeros.
 *
 * A null reading means it was never obtained. Nothing is scored, and the caller reports it as
 * unavailable — treating "we do not know" as "it was fine" is the one mistake that would make this
 * factor actively misleading.
 */
function weatherFactors(weather, { congestionPresent = false } = {}) {
  const config = SECONDARY_RISK_CONFIG.factors.WEATHER;
  if (!weather) return [];
  const out = [];
  const env = { component: RISK_COMPONENTS.ENVIRONMENT };

  // Precipitation, scored once. `rain` is shown alongside but never added again.
  const mm = Number.isFinite(weather.precipitation) ? weather.precipitation : null;
  let wet = false;
  if (mm == null) {
    out.push(factor('WEATHER_PRECIPITATION', 'Precipitation at incident time', false, 0, 'Not published for that hour', env));
  } else if (mm >= config.precipitation.heavyFromMm) {
    wet = true;
    out.push(factor('WEATHER_PRECIPITATION', 'Heavy rain at incident time', true, config.precipitation.heavy, `${mm.toFixed(1)} mm in the hour`, env));
  } else if (mm >= config.precipitation.moderateFromMm) {
    wet = true;
    out.push(factor('WEATHER_PRECIPITATION', 'Rain at incident time', true, config.precipitation.moderate, `${mm.toFixed(1)} mm in the hour`, env));
  } else if (mm >= config.precipitation.lightFromMm) {
    wet = true;
    out.push(factor('WEATHER_PRECIPITATION', 'Light rain at incident time', true, config.precipitation.light, `${mm.toFixed(1)} mm in the hour`, env));
  } else {
    out.push(factor('WEATHER_PRECIPITATION', 'Precipitation at incident time', false, 0, 'No measurable rain', env));
  }

  // Visibility.
  const metres = Number.isFinite(weather.visibility) ? weather.visibility : null;
  let dim = false;
  const km = metres == null ? null : (metres / 1000).toFixed(1);
  if (metres == null) {
    out.push(factor('WEATHER_VISIBILITY', 'Visibility at incident time', false, 0, 'Not published for that hour', env));
  } else if (metres < config.visibility.severeBelowM) {
    dim = true;
    out.push(factor('WEATHER_VISIBILITY', 'Severely reduced visibility', true, config.visibility.severe, `${km} km`, env));
  } else if (metres < config.visibility.poorBelowM) {
    dim = true;
    out.push(factor('WEATHER_VISIBILITY', 'Poor visibility', true, config.visibility.poor, `${km} km`, env));
  } else if (metres < config.visibility.reducedBelowM) {
    dim = true;
    out.push(factor('WEATHER_VISIBILITY', 'Reduced visibility', true, config.visibility.reduced, `${km} km`, env));
  } else {
    out.push(factor('WEATHER_VISIBILITY', 'Visibility at incident time', false, 0, `${km} km — clear`, env));
  }

  // Wind, scored from the gust where one is published: a gust is what moves a vehicle, not the mean.
  const gust = Number.isFinite(weather.windGust) ? weather.windGust : null;
  const mean = Number.isFinite(weather.windSpeed) ? weather.windSpeed : null;
  if (gust != null && gust >= config.wind.gustFromKmh) {
    out.push(factor('WEATHER_WIND', 'Strong gusts', true, config.wind.gust, `Gusting ${Math.round(gust)} km/h`, env));
  } else if (mean != null && mean >= config.wind.strongFromKmh) {
    out.push(factor('WEATHER_WIND', 'Strong wind', true, config.wind.strong, `${Math.round(mean)} km/h`, env));
  } else if (gust == null && mean == null) {
    out.push(factor('WEATHER_WIND', 'Wind at incident time', false, 0, 'Not published for that hour', env));
  } else {
    out.push(factor('WEATHER_WIND', 'Wind at incident time', false, 0, `${Math.round(mean ?? gust)} km/h — not operationally significant`, env));
  }

  // Conditions that compound. A wet road with a short sight line is worse than either alone, and
  // worse again when traffic is already queueing into it.
  if (wet && dim) {
    const extra = config.combined.rainAndReducedVisibility + (congestionPresent ? config.combined.withUpstreamQueue : 0);
    out.push(factor('WEATHER_COMBINED', 'Rain with reduced visibility', true, extra,
      congestionPresent ? 'Wet road and short sight line into an existing upstream queue' : 'Wet road and short sight line', env));
  }
  return out;
}

/**
 * What this location's history contributes.
 *
 * ONLY the normalised concentration band is scored. The recurring patterns the analysis also finds —
 * crash type, weather prevalence, time of day — are returned as evidence and left unscored on
 * purpose:
 *
 *   • historical wet-weather prevalence would double-count the incident's own measured weather,
 *     which is already an environment factor;
 *   • historical severe-crash counts are a different concept from THIS incident's severity, which
 *     is already scored, and adding both would score the place and the event as if they were one
 *     thing.
 *
 * An analysis that could not be produced is UNKNOWN, never zero: "we have no crash history for this
 * spot" is not "nothing has ever happened here".
 */
function historicalLocationFactor(analysis) {
  const config = SECONDARY_RISK_CONFIG.factors.HISTORICAL_LOCATION;
  if (!analysis) {
    return factor('HISTORICAL_LOCATION', config.label, false, 0, 'Not evaluated',
      { component: RISK_COMPONENTS.HISTORICAL_LOCATION, evidence: EVIDENCE.UNKNOWN });
  }
  if (!analysis.available || analysis.concentration?.level === 'UNKNOWN') {
    return factor('HISTORICAL_LOCATION', config.label, false, 0,
      `Unknown — ${String(analysis.reason ?? analysis.concentration?.reason ?? 'no comparable history').toLowerCase()}`,
      { component: RISK_COMPONENTS.HISTORICAL_LOCATION, evidence: EVIDENCE.UNKNOWN });
  }
  const level = analysis.concentration.level;
  const { localValue, corridorBaseline, ratio } = analysis.concentration;
  const provenance = analysis.provenance ?? {};
  // Weighted by how much the coordinates are worth. Asset-derived positions are real evidence of
  // where conflicts happen, but they are not surveyed crash geometry and must not score as if they
  // were — see spatialConfidenceWeight for the reasoning.
  const weight = HISTORICAL_SAFETY_CONFIG.spatialConfidenceWeight[provenance.spatialConfidence] ?? 1;
  const full = Math.min(config.max, config.levels[level] ?? 0);
  const score = Math.round(full * weight);
  const noun = provenance.recordNoun ?? 'historical incidents';
  const detail = `${localValue} ${noun} within ${analysis.analysisWindow.distanceMeters} m in `
    + `${analysis.analysisWindow.lookbackMonths} months`
    + (Number.isFinite(ratio) ? ` · ${ratio}x the typical concentration of incident records on this corridor (${corridorBaseline})` : '')
    + (weight < 1 ? ` · weighted down for ${String(provenance.spatialConfidence ?? 'low').toLowerCase()} spatial confidence (${provenance.locationSourceLabel ?? 'derived location'})` : '');
  const label = provenance.recordNoun === 'crashes' ? config.crashLabel : config.label;
  return factor('HISTORICAL_LOCATION', `${label}: ${analysis.concentration.levelLabel}`,
    score > 0, score, detail, { component: RISK_COMPONENTS.HISTORICAL_LOCATION });
}

/** Weather may raise the score but never run away with it. */
function cappedWeather(factors) {
  const config = SECONDARY_RISK_CONFIG.factors.WEATHER;
  const total = factors.reduce((sum, entry) => sum + entry.contribution, 0);
  if (total <= config.max) return factors;
  // Trim the smallest contributions first, so the headline condition keeps its full weight.
  const scale = config.max / total;
  return factors.map(entry => (entry.contribution > 0
    ? factor(entry.type, entry.label, entry.present, Math.floor(entry.contribution * scale), entry.detail)
    : entry));
}

/**
 * Assess one incident.
 *
 * @param {object} incident                     from normaliseIncident()
 * @param {{upstream: object, upstreamCongestion: object[], impactLevel: string|null}} context
 * @returns {{incidentId, carriageway, sectionId, upstreamStatus, score, level, levelLabel,
 *            factors: object[], unavailableFactors: object[]}}
 */
export function assessSecondaryRisk(incident, {
  upstream = null, upstreamCongestion = [], impactLevel = null,
  /** A normalised reading from historicalWeather, or null when it was not obtained. */
  weather = null,
  /** Whether weather was even asked for. Distinguishes "not fetched yet" from "fetch failed". */
  weatherRequested = false,
  /** From analyzeHistoricalLocation(), or null when the location was not analysed. */
  locationHistory = null,
} = {}) {
  const factors = [
    laneFactor(incident),
    congestionFactor(upstreamCongestion, upstream),
    impactFactor(impactLevel),
    severityFactor(incident),
    durationFactor(incident),
    ...cappedWeather(weatherFactors(weather, { congestionPresent: (upstreamCongestion ?? []).length > 0 })),
    historicalLocationFactor(locationHistory),
  ];
  const score = factors.reduce((total, entry) => total + entry.contribution, 0);
  const level = levelFor(score);
  const components = componentScores(factors);
  const confidence = dataConfidence(factors);
  return Object.freeze({
    incidentId: incident.id,
    carriageway: incident.carriageway,
    sectionId: incident.sectionId,
    sectionLabel: incident.sectionLabel,
    upstreamStatus: upstream?.status ?? UPSTREAM_STATUS.UNRESOLVED,
    score,
    level: level.id,
    levelLabel: level.label,
    factors,
    /**
     * The score broken down, so "why High" can be answered without re-deriving it.
     *
     * Each component carries what it contributed AND whether anything in it could not be evaluated,
     * because a component scoring zero for want of data is not the same as one scoring zero because
     * conditions were benign.
     */
    components,
    /** Only the factors that actually added to the score — what "Why this risk" should show. */
    contributors: factors.filter(entry => entry.evidence === EVIDENCE.CONTRIBUTING),
    /** Evaluated, and found to add nothing. Context, not a reason. */
    neutralFactors: factors.filter(entry => entry.evidence === EVIDENCE.NO_ADDED_RISK),
    /** Could not be evaluated. Never counted as "fine". */
    unknownFactors: factors.filter(entry => entry.evidence === EVIDENCE.UNKNOWN),
    /**
     * How much of the picture we actually had. A SEPARATE axis from risk: a High score built on
     * known lane blockage and known severity stays High even when half the context is missing.
     */
    confidence,
    /** The location history behind the historical factor, for the panel and for Ask the Twin. */
    locationHistory,
    /** The reading the weather factors came from, for the panel and for lineage. */
    weather,
    weatherState: weather ? 'available' : weatherRequested ? 'unavailable' : 'not-requested',
    // Weather that could not be obtained is declared, never scored as a quiet zero.
    unavailableFactors: weather ? UNAVAILABLE_FACTORS : [...UNAVAILABLE_FACTORS, WEATHER_UNAVAILABLE],
  });
}

/** What each component of the score contributed, and whether anything in it was unknown. */
function componentScores(factors) {
  const out = {};
  for (const name of Object.values(RISK_COMPONENTS)) {
    out[name] = { score: 0, known: 0, unknown: 0 };
  }
  for (const entry of factors) {
    const bucket = out[entry.component] ?? out[RISK_COMPONENTS.INCIDENT_LANE_IMPACT];
    bucket.score += entry.contribution;
    if (entry.evidence === EVIDENCE.UNKNOWN) bucket.unknown += 1; else bucket.known += 1;
  }
  return Object.freeze(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, Object.freeze(v)])));
}

/**
 * How complete the evidence was.
 *
 * Counted over the factors that were actually evaluated against the ones that could not be. This is
 * NOT a discount on the risk: a High score stands on the evidence that produced it, and an operator
 * is told separately how much of the picture was missing.
 */
export function dataConfidence(factors) {
  const evaluated = factors.filter(entry => entry.evidence !== EVIDENCE.UNKNOWN).length;
  const unknown = factors.filter(entry => entry.evidence === EVIDENCE.UNKNOWN).length;
  const total = evaluated + unknown + UNAVAILABLE_FACTORS.length;
  const share = total ? evaluated / total : 0;
  const level = share >= 0.6 ? 'HIGH' : share >= 0.35 ? 'MEDIUM' : 'LOW';
  return Object.freeze({
    level,
    label: level === 'HIGH' ? 'High' : level === 'MEDIUM' ? 'Medium' : 'Low',
    evaluated, unknown, share: Math.round(share * 100) / 100,
  });
}

/** Whether a level counts as needing attention, for the KPI that counts them. */
export const isElevated = level => level === 'HIGH' || level === 'SEVERE';

/**
 * Rank assessed incidents, highest risk first.
 *
 * Ties are kept rather than broken arbitrarily: two incidents on the same score are both the
 * highest, and the caller is told so. An operator choosing where to look should not have a coin
 * flip presented as a ranking.
 *
 * @returns {{highestRiskIncident: object|null, risk: object|null, tied: object[], ranked: object[]}}
 */
export function rankBySecondaryRisk(assessments) {
  const ranked = [...(assessments ?? [])].sort((a, b) =>
    b.risk.score - a.risk.score
    // Then by severity of the incident itself, then by how long it has been running — both only
    // where published, so an unpublished field never silently sorts an incident down.
    || (b.incident.activeMinutes ?? 0) - (a.incident.activeMinutes ?? 0)
    || String(a.incident.id).localeCompare(String(b.incident.id)));
  if (!ranked.length) return { highestRiskIncident: null, risk: null, tied: [], ranked };
  const top = ranked[0];
  const tied = ranked.filter(entry => entry.risk.score === top.risk.score);
  return {
    highestRiskIncident: top.incident,
    risk: top.risk,
    tied: tied.length > 1 ? tied : [],
    ranked,
  };
}
