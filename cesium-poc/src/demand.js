/*---------------------------------------------------------------------------------------------
 * demand.js — UC1 P2-a: synthetic 15-minute traffic demand curve (spec §2 "Demand model").
 *
 * Pure module: no DataConnect/DOM/network. All curve shape lives in config/demandProfile.json
 * (baseVph, trough/shoulder multipliers, weekday/weekend peak windows) — this file only applies
 * it, per the repo's config-driven rule (nothing shape-related hardcoded here).
 *
 * `segments` (the per-segment demandScale multiplier, owned by config/segments.json) is taken as
 * an init arg rather than imported directly, so this module stays fs-agnostic/pure and testable
 * with fixture segments independent of the real registry (see spec §2 + §0).
 *
 * Interface is shaped as a swappable stand-in for a live OpenPath feed (see spec §2) — the
 * returned model is SYNTHETIC and should be labelled as such wherever it surfaces in the UI.
 *--------------------------------------------------------------------------------------------*/
import defaultProfile from "../config/demandProfile.json" with { type: "json" };

const QUARTER_HOURS_PER_DAY = 96;

function toDate(dateInput) {
  return dateInput instanceof Date ? dateInput : new Date(dateInput);
}

// Saturday (6) / Sunday (0), UTC — keeps demo results host-timezone-independent.
function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

// quarterHour is a 0..95 slice index within the day (0 = 00:00-00:15, 95 = 23:45-24:00),
// wrapped so callers can pass values outside that range (getWindowDemand relies on this).
function quarterHourToHourFloat(quarterHour) {
  const q = ((quarterHour % QUARTER_HOURS_PER_DAY) + QUARTER_HOURS_PER_DAY) % QUARTER_HOURS_PER_DAY;
  return q / 4;
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// Daytime baseline (shoulder) vs night trough, from config's dayStartHour/dayEndHour band.
function baseLevel(hourFloat, profile) {
  if (hourFloat >= profile.dayStartHour && hourFloat < profile.dayEndHour) {
    return profile.shoulderMultiplier;
  }
  return profile.troughMultiplier;
}

// Trapezoidal bump for one peak window: null outside its ramp+plateau span, ramps from the
// daytime shoulder up to peakMultiplier and back down. Returning null (not the shoulder value)
// outside the span is load-bearing — it lets night hours fall through to baseLevel's trough
// instead of being pulled up to the shoulder by an unrelated peak's default.
function peakContribution(hourFloat, peak, shoulderMultiplier) {
  const rampHours = peak.rampHours ?? 1;
  const { startHour, endHour, peakMultiplier } = peak;
  const rampStart = startHour - rampHours;
  const rampEnd = endHour + rampHours;
  if (hourFloat < rampStart || hourFloat > rampEnd) return null;
  if (hourFloat >= startHour && hourFloat <= endHour) return peakMultiplier;
  if (hourFloat < startHour) {
    const t = (hourFloat - rampStart) / (startHour - rampStart);
    return lerp(shoulderMultiplier, peakMultiplier, t);
  }
  const t = (rampEnd - hourFloat) / (rampEnd - endHour);
  return lerp(shoulderMultiplier, peakMultiplier, t);
}

function hourMultiplier(hourFloat, profile, weekend) {
  let level = baseLevel(hourFloat, profile);
  const peaks = weekend ? profile.weekendPeaks : profile.weekdayPeaks;
  for (const peak of peaks) {
    const contribution = peakContribution(hourFloat, peak, profile.shoulderMultiplier);
    if (contribution != null) level = Math.max(level, contribution);
  }
  return level;
}

function segmentScale(segments, segmentId) {
  const seg = segments.find((s) => s.id === segmentId);
  return seg ? seg.demandScale : 1;
}

/**
 * createDemandModel(profileConfig = demandProfile.json, segments = []) -> {
 *   getDemand(segmentId, date, quarterHour) -> vph,
 *   getWindowDemand(segmentId, startDate, durationHours) -> vph[] (15-min slices),
 * }
 */
export function createDemandModel(profileConfig = defaultProfile, segments = []) {
  function getDemand(segmentId, date, quarterHour) {
    const weekend = isWeekend(toDate(date));
    const hourFloat = quarterHourToHourFloat(quarterHour);
    const multiplier = hourMultiplier(hourFloat, profileConfig, weekend);
    const scale = segmentScale(segments, segmentId);
    return profileConfig.baseVph * multiplier * scale;
  }

  // getWindowDemandSeries(segmentId, startDate, durationHours) -> [{timestamp: Date, vph}]
  //
  // One entry per 15-min slice starting at startDate, timestamps advancing by exactly 15 min each
  // (real elapsed time, not a floored/rebuilt date) — the low-level primitive both getWindowDemand
  // (below, now a thin delegate) and windowAssembly.js's weekDemandSeries() (UC1 deck-parity item 2
  // planner picker) build on, per the plan's conflict-resolution #3 ("one primitive, not duplicated").
  function getWindowDemandSeries(segmentId, startDate, durationHours) {
    const start = toDate(startDate);
    const sliceCount = Math.round(durationHours * 4);
    const out = [];
    for (let i = 0; i < sliceCount; i++) {
      const timestamp = new Date(start.getTime() + i * 15 * 60 * 1000);
      const quarterHour = timestamp.getUTCHours() * 4 + Math.floor(timestamp.getUTCMinutes() / 15);
      out.push({ timestamp, vph: getDemand(segmentId, timestamp, quarterHour) });
    }
    return out;
  }

  // getWindowDemand(segmentId, startDate, durationHours) -> vph[] (15-min slices)
  //
  // Unchanged signature/behavior — now delegates to getWindowDemandSeries() rather than
  // re-deriving slice dates itself (regression-guarded by demand.test.mjs's byte-identical test).
  function getWindowDemand(segmentId, startDate, durationHours) {
    return getWindowDemandSeries(segmentId, startDate, durationHours).map((s) => s.vph);
  }

  return { getDemand, getWindowDemand, getWindowDemandSeries, profileConfig, segments };
}

export default createDemandModel;
