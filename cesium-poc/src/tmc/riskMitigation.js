/**
 * What an operator could do about an elevated risk, derived from the factors that were detected.
 *
 * These are POTENTIAL MITIGATION ACTIONS, not automated ones. Nothing here dispatches a Road
 * Ranger, changes a sign, closes a lane or claims an action has been taken — the application has no
 * authorised write API for any of that, and a screen that implied otherwise during an incident
 * would be dangerous. Every line is something a person does, phrased as something a person does.
 *
 * Each suggestion is tied to a factor that was actually found and a resource that actually exists.
 * No upstream camera means no "verify with the camera" line, rather than a line naming a camera
 * that is not there.
 *
 * Pure: a risk assessment and its resources in, suggestions out.
 */
import { UPSTREAM_STATUS } from './upstreamResolver.js';

const found = (risk, type) => risk?.factors?.find(entry => entry.type === type && entry.present) ?? null;

/**
 * Suggestions for one assessed incident.
 *
 * @param {object} risk       from assessSecondaryRisk()
 * @param {{camera: object|null, sign: object|null, upstream: object}} resources
 * @returns {{id: string, text: string, basis: string}[]}
 */
/**
 * A weather factor's label as a condition inside a sentence.
 *
 * The labels end in "at incident time" so they read correctly as a list of factors; repeating that
 * inside a recommendation produced "rain at incident time at the incident time".
 */
const condition = factorEntry => String(factorEntry.label).replace(/\s+at incident time$/i, '').toLowerCase();

export function mitigationFor(risk, { camera = null, sign = null, upstream = null, locationHistory = null } = {}) {
  const out = [];
  const add = (id, text, basis) => out.push({ id, text, basis });

  const congestion = found(risk, 'UPSTREAM_CONGESTION');
  const rain = found(risk, 'WEATHER_PRECIPITATION');
  const sight = found(risk, 'WEATHER_VISIBILITY');
  const gusts = found(risk, 'WEATHER_WIND');
  const lanes = found(risk, 'LANE_CLOSURE');
  const impact = found(risk, 'OPERATIONAL_IMPACT');
  const duration = found(risk, 'INCIDENT_DURATION');

  // Seeing it for yourself is the first thing, and only offered when there is something to look
  // through. The camera is upstream, so it shows traffic approaching the incident.
  if (congestion && camera) {
    add('verify-congestion', `Verify upstream congestion using ${camera.id}.`, 'UPSTREAM_CONGESTION');
  } else if (congestion) {
    add('verify-congestion-nocam', 'Verify upstream congestion — no upstream camera is available on this approach.', 'UPSTREAM_CONGESTION');
  } else if (camera) {
    add('check-approach', `Check the upstream approach using ${camera.id}.`, 'MONITORING');
  }
  if (!camera && upstream?.status === UPSTREAM_STATUS.RESOLVED) {
    add('no-camera', 'No upstream camera could be resolved for this incident within range.', 'UNAVAILABLE');
  }
  if (!sign && upstream?.status === UPSTREAM_STATUS.RESOLVED) {
    add('no-sign', 'No upstream DMS could be resolved for this incident within range.', 'UNAVAILABLE');
  }

  // Warning coverage. Deliberately "review", never "set": the feed does not publish what a sign is
  // showing, so this cannot know whether drivers are already being warned.
  if ((lanes || congestion) && sign) {
    add('review-dms', `Review the nearest upstream sign ${sign.id} for warning coverage on this approach.`, lanes ? 'LANE_CLOSURE' : 'UPSTREAM_CONGESTION');
  }

  if (lanes) {
    add('review-closure', `Review the lane closure status — ${String(lanes.detail ?? 'lanes blocked').toLowerCase()}.`, 'LANE_CLOSURE');
  }
  if (impact) {
    add('monitor-impact', `Monitor the affected section — ${impact.detail}.`, 'OPERATIONAL_IMPACT');
  }
  if (duration) {
    // "Continue monitoring" told an operator nothing. Name what to look at and why.
    add('monitor-duration', camera
      ? `Re-check the upstream approach on ${camera.id} — the incident has been running ${duration.detail?.replace(/^Active /, '') ?? 'some time'}.`
      : `Re-check the upstream approach — the incident has been running ${duration.detail?.replace(/^Active /, '') ?? 'some time'}, and no upstream camera could be resolved for it.`,
      'INCIDENT_DURATION');
  }

  /**
   * What this location's history says to prioritise.
   *
   * Every line below names the pattern it came from, so an operator can see it is a recurring
   * pattern at a place and not a claim about what happened here today.
   */
  if (locationHistory?.available) {
    const elevated = ['ELEVATED', 'HIGH', 'VERY_HIGH'].includes(locationHistory.concentration?.level);
    // "Crashes" only where the records are confirmed crash reports — see historicalLocationSafety.
    const noun = locationHistory.provenance?.recordNoun === 'crashes' ? 'crashes' : 'historical incident records';
    const topType = locationHistory.crashTypes?.[0];
    const share = topType ? Math.round(topType.share * 100) : 0;
    const dominant = topType && topType.share >= 0.2 ? topType : null;

    // A recurring rear-end pattern plus lanes blocked is the queue-exposure case this screen exists
    // for, and it matters most when nobody can confirm a warning is up.
    if (elevated && dominant && /rear|follow/i.test(dominant.value) && (lanes || congestion)) {
      add('history-queue-priority',
        `Prioritise verifying upstream queue and warning coverage — ${share}% of the ${locationHistory.totals.crashes} ${noun} within `
        + `${locationHistory.analysisWindow.distanceMeters} m were ${dominant.value.toLowerCase()}, and lanes are affected now. `
        + 'A recurring pattern at this location, not a cause of this incident.',
        'HISTORICAL_LOCATION');
    } else if (elevated) {
      add('history-elevated',
        `Treat this approach as a known cluster — ${locationHistory.totals.crashes} ${noun} within `
        + `${locationHistory.analysisWindow.distanceMeters} m in ${locationHistory.analysisWindow.lookbackMonths} months, `
        + `${locationHistory.concentration.ratio}x the typical concentration of incident records on this corridor.`,
        'HISTORICAL_LOCATION');
    }

    // Historical wet-weather prevalence is only raised when it is ALSO raining now: on its own it
    // is background, and acting on it in the dry would be acting on a correlation.
    const wetShare = (locationHistory.weatherPatterns ?? [])
      .filter(entry => /rain|storm/i.test(entry.value))
      .reduce((total, entry) => total + entry.share, 0);
    if (rain && wetShare >= 0.2) {
      add('history-wet-weather',
        `Increase monitoring of approaching traffic — it is raining now, and ${Math.round(wetShare * 100)}% of the ${noun} `
        + 'here were recorded in wet conditions. A recurring pattern, not a cause.',
        'HISTORICAL_LOCATION');
    }

    if (locationHistory.selectedTimeBucket?.isMostCommon && locationHistory.selectedTimeBucket.share >= 0.2) {
      add('history-time-of-day',
        `This incident falls in the ${locationHistory.selectedTimeBucket.label} period, the most common historical period here `
        + `(${Math.round(locationHistory.selectedTimeBucket.share * 100)}% of the ${noun}).`,
        'HISTORICAL_LOCATION');
    }
  }

  /**
   * Weather-driven actions.
   *
   * Each one is tied to a condition that was actually detected in the reading — a wet road, a short
   * sight line, a gust — so an operator can trace every line back to a number in the panel above
   * it. Nothing here is offered because the weather was merely "bad".
   */
  if (rain || sight) {
    const conditions = [rain && condition(rain), sight && condition(sight)].filter(Boolean).join(' and ');
    add('weather-advisory-speed', `Consider a reduced advisory speed on the approach — ${conditions} at the incident time.`, 'WEATHER');
    if (sign) {
      add('weather-dms-warning', `Warn approaching traffic on ${sign.id} about conditions at the incident — ${conditions}.`, 'WEATHER');
    }
  }
  if (sight) {
    // A short sight line is the case where the standard warning distance is the thing that fails.
    add('weather-warning-distance', `Increase the upstream warning distance — ${condition(sight)}${sight.detail ? `, ${sight.detail}` : ''}, at the incident time.`, 'WEATHER');
  }
  if (rain && congestion) {
    add('weather-queue-growth', 'Monitor queue growth closely — traffic is arriving into a queue on a wet road.', 'WEATHER');
    add('weather-road-ranger', 'Consider a Road Ranger patrol on the upstream approach while these conditions last.', 'WEATHER');
  }
  if (gusts) {
    add('weather-wind', `Consider a high-wind advisory for high-sided vehicles — ${gusts.detail ?? condition(gusts)}.`, 'WEATHER');
  }

  // Upstream could not be worked out at all: say so, because every upstream suggestion above is
  // missing for a reason the operator should know.
  if (upstream?.status !== UPSTREAM_STATUS.RESOLVED) {
    add('upstream-unresolved',
      `Upstream conditions cannot be assessed for this incident — ${String(upstream?.reason ?? 'upstream unresolved').toLowerCase()}.`,
      'UPSTREAM_UNRESOLVED');
  }

  // Weather that was never obtained is said once, for the same reason: an operator should know the
  // conditions were not assessed rather than assume they were fine.
  if (risk?.weatherState === 'unavailable') {
    add('weather-unavailable', 'Historical weather for this incident is unavailable — conditions were not assessed.', 'UNAVAILABLE');
  }

  // Always last, and always said: the absence of responder information is itself operational
  // information, and leaving it out would let the list read as a complete picture.
  add('responder-unavailable', 'Responder status is not available from the connected data.', 'UNAVAILABLE');
  return out;
}
