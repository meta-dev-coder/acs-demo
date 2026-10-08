/**
 * The TMC's one deterministic answer service.
 *
 * Everything that ranks, scores or explains an incident goes through here: the workspace, the risk
 * panel and Ask the Twin all read the same assessment of the same corridor at the same moment. A
 * screen and a chat answer that disagreed about which incident is worst would be worse than either
 * alone.
 *
 * Ask the Twin calls this; it never reasons about raw incidents itself. The language model's job is
 * to explain what came back, not to work it out.
 *
 * Pure apart from the clock: events and corridor geometry in, assessments out.
 */
import { aggregateImpact } from '../liveOps/operationalImpact.js';
import { incidentsIn, ofType } from './tmcIncidents.js';
import { clockFor, describeTemporal, eventInterval, eventsFor, eventsOverlapping, incidentAnchor, isHistorical, liveContext, startedOnDate } from './temporalContext.js';
import { isUpstreamOf, upstreamSections, UPSTREAM_STATUS } from './upstreamResolver.js';
import { assessSecondaryRisk, isElevated, rankBySecondaryRisk } from './secondaryIncidentRisk.js';
import { mitigationFor } from './riskMitigation.js';
import { nearestUpstream } from './tmcResources.js';
import { analyzeHistoricalLocation } from './historicalLocationSafety.js';
import { buildHistoricalInsight, buildIncidentInsight, buildOpportunity, evidenceSources } from './tmcInsight.js';
import { recommendedAttention, responseTimeline } from './responsePlan.js';

/**
 * Assess the corridor as it stands.
 *
 * @param {object[]} events      the live feed
 * @param {{sections: object[], centerline: object[], cameras: object[], signs: object[], now?: number}} context
 * @returns {{incidents, assessments, ranked, highestRiskIncident, risk, mitigation, counts}}
 */
export function assessCorridor(events, {
  sections = [], centerline = [], cameras = [], signs = [], now = Date.now(), temporal = liveContext(),
  /**
   * Weather readings already obtained, by incident id: `{ [id]: reading|null }`.
   *
   * Enrichment, fetched when an operator opens an incident, so the corridor is never assessed with
   * a weather request per incident on every refresh. An id present with a null value means the
   * fetch was tried and failed, which the risk engine reports differently from never asking.
   */
  weatherByIncident = null,
  /**
   * The register records the location analysis compares against, and whether to run it.
   *
   * Like weather, this is only computed for an incident an operator has opened: the baseline walks
   * the whole corridor, which is not work to repeat for every incident on a busy date.
   */
  historicalCrashes = null,
  analyzeLocationFor = null,
} = {}) {
  // One decision about WHEN, made here and applied to everything downstream. Mixing a historical
  // incident with today's congestion would be the worst possible answer on a safety screen, so the
  // whole operational picture is taken from a single moment.
  // WHAT is being assessed. Live means what is running now; a historical date means every incident
  // REPORTED that day, however briefly each one lasted.
  const scope = eventsFor(events, temporal);
  const historical = isHistorical(temporal);
  const clock = clockFor(temporal, now);
  /**
   * What instant each incident's duration is measured to.
   *
   * Live: now — how long it has been running. A replayed INSTANT: that instant, which is how long
   * it had been running by then. A DATE: its own clear time, because "how long did it run" is the
   * question a date asks, and measuring to today would report a December 2025 crash as having been
   * active for 418,584 minutes.
   */
  const untilCleared = event => {
    if (!historical) return null;
    if (Number.isFinite(clock)) return clock;
    const { from, to } = eventInterval(event);
    return Number.isFinite(to) ? to : (Number.isFinite(from) ? from : null);
  };
  const incidents = incidentsIn(scope, clock ?? now, { clockFor: untilCleared });
  const closures = ofType(scope, 'CLOSURE');

  /**
   * WHEN each incident is judged.
   *
   * Live: the corridor as it is now, shared by every incident. Historical: each incident's own
   * reported time, because conditions around a 06:13 incident are not the conditions around one at
   * 11:36, and judging both against the day as a whole would attribute a queue to an incident that
   * had cleared hours before it. The operator never types this instant — the incident carries it.
   */
  const momentFor = incident => {
    if (!historical) return { at: clock ?? now, events: scope };
    const at = incidentAnchor(incident);
    if (!Number.isFinite(at)) return { at: null, events: [] };
    // Conditions that OVERLAPPED this incident's life, not merely those running at the instant it
    // was reported — see intervalsOverlap for why an instant test is the wrong question here.
    const life = eventInterval(incident.event ?? incident);
    return { at, events: eventsOverlapping(events, life) };
  };

  const assessments = incidents.map(incident => {
    const moment = momentFor(incident);
    // Operational Impact comes from the corridor's own module, fed the events of THAT moment, so a
    // historical level is as valid as a live one and neither is ever the other.
    const impact = aggregateImpact(moment.events, sections);
    const levelBySegment = new Map();
    for (const section of impact?.sections ?? []) levelBySegment.set(section.segmentId, section.operationalLevel);

    const upstream = upstreamSections(incident, sections);
    const upstreamCongestion = ofType(moment.events, 'CONGESTION')
      .filter(event => isUpstreamOf(event, incident, upstream));
    const concurrentClosures = ofType(moment.events, 'CLOSURE');
    const impactLevel = incident.segmentId ? levelBySegment.get(incident.segmentId) ?? null : null;
    const weather = weatherByIncident?.[incident.id] ?? null;
    const weatherRequested = Boolean(weatherByIncident && incident.id in weatherByIncident);
    // The location's own history, anchored to the incident's time so nothing after it is used.
    const locationHistory = analyzeLocationFor === incident.id && historicalCrashes
      ? analyzeHistoricalLocation({
        selectedIncident: incident, historicalCrashes, centerline, anchorMs: moment.at ?? incident.reportedAtMs ?? null,
      })
      : null;
    const risk = assessSecondaryRisk(incident, {
      upstream, upstreamCongestion, impactLevel, weather, weatherRequested, locationHistory,
    });
    const camera = nearestUpstream(cameras, incident, upstream, { centerline });
    const sign = nearestUpstream(signs, incident, upstream, { centerline });
    const mitigation = mitigationFor(risk, { camera: camera?.resource, sign: sign?.resource, upstream, locationHistory });
    return {
      incident,
      /** The instant this incident's conditions were read at, and what was running then. */
      moment,
      /**
       * On a date: whether it BEGAN that day, or ran into it from an earlier one. Null when the
       * question does not apply, so a screen can tell "no" from "not asked".
       */
      startedOnDate: temporal?.date ? startedOnDate(incident.event ?? incident, temporal.date) : null,
      upstream,
      upstreamCongestion,
      concurrentClosures,
      impactLevel,
      risk,
      /**
       * Where each part of this score came from, so a result can be argued with later.
       *
       * Deliberately records the two timestamps separately: the incident's own time and the hour
       * the weather was actually read from are not the same minute, and a validation of this score
       * months from now needs to know which hour was used.
       */
      riskFactors: Object.freeze({
        incident: Object.freeze({ id: incident.id, severity: incident.severity ?? null, lanes: incident.lanes ?? null, reportedAtMs: incident.reportedAtMs ?? null }),
        traffic: Object.freeze({ upstreamCongestion: upstreamCongestion.map(event => event.id), concurrentClosures: concurrentClosures.map(event => event.id) }),
        roadway: Object.freeze({ carriageway: incident.carriageway ?? null, sectionId: incident.sectionId ?? null, upstreamStatus: upstream.status, impactLevel }),
        temporal: Object.freeze({ mode: temporal?.mode ?? null, date: temporal?.date ?? null, assessedAt: moment.at ?? null }),
        historicalLocation: locationHistory
          ? Object.freeze({
            source: 'DataConnect · Florida I595 Incidents',
            radiusMeters: locationHistory.analysisWindow?.distanceMeters ?? null,
            lookbackMonths: locationHistory.analysisWindow?.lookbackMonths ?? null,
            windowEndMs: locationHistory.analysisWindow?.endMs ?? null,
            matchBasis: locationHistory.matchBasis?.mode ?? null,
            previousCrashes: locationHistory.totals?.crashes ?? null,
            concentration: locationHistory.concentration ?? null,
          })
          : Object.freeze({ state: 'not-requested' }),
        weather: weather
          ? Object.freeze({
            source: weather.source ?? 'Open-Meteo',
            endpoint: weather.endpoint ?? null,
            requestedIncidentTime: weather.requestedIncidentTime ?? null,
            matchedWeatherTime: weather.matchedWeatherTime ?? null,
            timeZone: weather.timeZone ?? null,
            units: weather.units ?? null,
            values: weather,
          })
          : Object.freeze({ source: 'Open-Meteo', state: weatherRequested ? 'unavailable' : 'not-requested' }),
      }),
      resources: { camera, sign },
      locationHistory,
      mitigation,
      /**
       * The twin's own reading of all of the above, in sentences.
       *
       * Built here rather than in the panel so one statement of what this incident means reaches
       * the screen, Ask the Twin and the tests alike — not three that can drift apart.
       */
      insight: buildIncidentInsight({ incident, risk, locationHistory, upstream }),
      historicalInsight: buildHistoricalInsight(locationHistory),
      opportunity: buildOpportunity({ locationHistory, upstream, resources: { camera, sign }, risk }),
      evidence: evidenceSources({ risk, locationHistory, upstream, resources: { camera, sign } }),
      /** Ranked recommendations and the response motion, for the Response tab. */
      attention: recommendedAttention(mitigation, { upstream }),
      timeline: responseTimeline({ incident, risk, resources: { camera, sign }, upstream, analysedAtMs: moment.at ?? null }),
    };
  });

  const ranked = rankBySecondaryRisk(assessments);
  return {
    temporal,
    when: describeTemporal(temporal),
    historical: isHistorical(temporal),
    incidents,
    assessments,
    ranked: ranked.ranked,
    highestRiskIncident: ranked.highestRiskIncident,
    risk: ranked.risk,
    tied: ranked.tied,
    mitigation: ranked.ranked[0]?.mitigation ?? [],
    counts: counts(assessments, closures, scope),
    /** Everything running at this moment, for the map and the context counts. */
    scope,
  };
}

/**
 * What the KPI strip shows. Every figure is counted from the assessments, never estimated.
 *
 * `byType` counts everything that was running at the moment, not only incidents: at a replayed
 * time an operator is asking what the corridor looked like, and an incident count alone answers a
 * narrower question than the one being asked.
 */
export function counts(assessments, closures, scope = []) {
  const byType = {};
  for (const event of scope) byType[event.type] = (byType[event.type] ?? 0) + 1;
  return {
    activeIncidents: assessments.length,
    elevatedRisk: assessments.filter(entry => isElevated(entry.risk.level)).length,
    laneClosures: (closures ?? []).length,
    upstreamCongestion: assessments.filter(entry => entry.upstreamCongestion.length > 0).length,
    highImpact: assessments.filter(entry => entry.impactLevel === 'HIGH' || entry.impactLevel === 'SEVERE').length,
    upstreamUnresolved: assessments.filter(entry => entry.upstream.status !== UPSTREAM_STATUS.RESOLVED).length,
    byType,
    allEvents: scope.length,
  };
}

/**
 * The deterministic tool Ask the Twin routes "which incident has the highest secondary risk" to.
 *
 * Returns a plain structure the model can put into words — including the honest empty answer, which
 * is a real result on this corridor rather than an edge case.
 */
export function getHighestSecondaryRiskIncident(events, context) {
  const assessed = assessCorridor(events, context);
  if (!assessed.highestRiskIncident) {
    return {
      available: false,
      when: assessed.when,
      historical: assessed.historical,
      reason: assessed.historical
        ? `No I-595 incidents were active at ${assessed.when.label}.`
        : 'No active I-595 incidents are currently available to assess for secondary-incident risk.',
      counts: assessed.counts,
    };
  }
  const top = assessed.ranked[0];
  return {
    available: true,
    when: assessed.when,
    historical: assessed.historical,
    incident: top.incident,
    risk: top.risk,
    upstream: top.upstream,
    impactLevel: top.impactLevel,
    resources: top.resources,
    mitigation: top.mitigation,
    tied: assessed.tied.map(entry => entry.incident.id),
    counts: assessed.counts,
  };
}

/** The KPI filters, kept here so the strip and Ask the Twin narrow by the same rules. */
export const TMC_FILTERS = Object.freeze({
  all: { label: 'Active incidents', match: () => true },
  elevated: { label: 'High secondary risk', match: entry => isElevated(entry.risk.level) },
  closures: { label: 'Lane closures', match: entry => entry.incident.blocksTravelLanes },
  congestion: { label: 'Upstream congestion', match: entry => entry.upstreamCongestion.length > 0 },
  impact: { label: 'High Operational Impact', match: entry => entry.impactLevel === 'HIGH' || entry.impactLevel === 'SEVERE' },
});
