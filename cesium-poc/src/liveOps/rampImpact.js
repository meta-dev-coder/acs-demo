/**
 * Operational Impact for ramps and connectors.
 *
 * The mainline overlay scores FDOT's EB/WB sections, and an event that cannot be placed on one of
 * them is deliberately left out of every score (aggregateImpact's `unsectioned` exclusion) — which
 * is exactly what happens to an event on a ramp or inside an interchange. Those events were on the
 * map and in no score at all. This scores them against the ramp geometry the corridor already
 * draws, using the SAME weights, severity model and levels as the carriageways, so one colour means
 * one thing everywhere on the screen.
 *
 * Two rules carried over from the mainline model:
 *
 *   Nothing is scored twice. Only events the mainline could not place are offered here, so an
 *   event already colouring a GP section never also colours a ramp beneath it.
 *
 *   A guess is worse than no colour. An event further than `toleranceMeters` from every ramp stays
 *   unmatched and uncoloured rather than being attached to the nearest thing on screen.
 */
import { distanceToCorridorM } from '../uc1Data.js';
import { eventScore, levelFor, explainImpact } from './operationalImpact.js';

/**
 * How close an event has to be to a ramp to be counted as on it.
 *
 * Ramps sit tens of metres apart inside an interchange, and FL511 publishes a single point for an
 * event rather than the extent of it. 60 m is wide enough for that point to land beside the ramp it
 * describes and tight enough that it does not reach the next ramp in a stack.
 */
export const RAMP_MATCH_METERS = 60;

const countByType = events => {
  const counts = { INCIDENT: 0, CLOSURE: 0, CONSTRUCTION: 0, CONGESTION: 0, DISABLED: 0 };
  for (const event of events) if (counts[event.type] != null) counts[event.type] += 1;
  return counts;
};

/**
 * The ramp nearest to one event, or null when every ramp is further away than `toleranceMeters`.
 *
 * @param {{longitude: number, latitude: number}} event
 * @param {{id: string, path: {lon: number, lat: number}[]}[]} ramps
 */
export function nearestRamp(event, ramps, toleranceMeters = RAMP_MATCH_METERS) {
  let best = null;
  for (const ramp of ramps ?? []) {
    const metres = distanceToCorridorM(event?.longitude, event?.latitude, ramp.path);
    // null is "unmeasurable" (no coordinates, no geometry) — a distinct case from "far away".
    if (metres == null || metres > toleranceMeters) continue;
    if (!best || metres < best.metres) best = { ramp, metres };
  }
  return best;
}

/**
 * Score every ramp from the events that could not be placed on a carriageway section.
 *
 * @param {object[]} events  live events the mainline model left unsectioned
 * @param {{id: string, label: string, rampType: string, path: {lon, lat}[]}[]} ramps
 * @returns {{byRampId: Map<string, object>, matched: number, unmatched: number}}
 */
export function aggregateRampImpact(events, ramps, { toleranceMeters = RAMP_MATCH_METERS } = {}) {
  const byRampId = new Map();
  for (const ramp of ramps ?? []) {
    byRampId.set(ramp.id, {
      rampId: ramp.id, sectionLabel: ramp.label, rampType: ramp.rampType,
      events: [], operationalScore: 0, operationalLevel: 'NORMAL', byType: countByType([]),
    });
  }

  let matched = 0, unmatched = 0;
  for (const event of events ?? []) {
    const hit = nearestRamp(event, ramps, toleranceMeters);
    if (!hit) { unmatched += 1; continue; }
    byRampId.get(hit.ramp.id).events.push(event);
    matched += 1;
  }

  for (const section of byRampId.values()) {
    section.operationalScore = section.events.reduce((total, event) => total + eventScore(event), 0);
    section.operationalLevel = levelFor(section.operationalScore);
    section.byType = countByType(section.events);
    section.score = section.operationalScore;
    section.level = section.operationalLevel;
    section.reasons = explainImpact(section).reasons;
  }
  return { byRampId, matched, unmatched };
}
