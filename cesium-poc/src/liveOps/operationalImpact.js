/**
 * Operational Impact: how much pressure each section of I-595 is under right now.
 *
 * This is an application-derived measure, not an observation. It is deliberately NOT called traffic
 * speed, traffic heat or safety risk: nothing here measures how fast anyone is travelling. It
 * combines the five live event types — incidents, closures, construction, congestion and disabled
 * vehicles — with whatever lane impact each one's own words state.
 *
 * Two rules the rest of Live Ops depends on:
 *
 *   Carriageways are scored apart. Eastbound Section 03 and Westbound Section 03 cover the same
 *   stretch of road in opposite directions; an eastbound crash says nothing about the westbound
 *   lanes, so their scores never combine.
 *
 *   Only evidenced events count. An event whose carriageway could not be read from the source, and
 *   an Express event (Express has no sections yet), stay on the map and out of every score. A
 *   section coloured by a guess is worse than a section left green.
 *
 * Weights live here, in one place, so the model can be read and tuned without touching Cesium.
 */
import { CARRIAGEWAYS } from './carriagewayModel.js';

/**
 * What one event contributes.
 *
 * FL511 publishes a `severity` on some events and nothing on others, so severity is used where it
 * exists and presence alone counts where it does not — rather than inventing a severity to make the
 * model look uniform. `base` is that "an incident is here" contribution.
 */
export const OPERATIONAL_IMPACT_WEIGHTS = Object.freeze({
  /** A crash: the heaviest single event, before anything it blocks. */
  INCIDENT: Object.freeze({ base: 40, severity: Object.freeze({ minor: 0, moderate: 20, major: 40 }) }),
  /** A closure is mostly its lane impact, so its base is modest and the lanes do the work. */
  CLOSURE: Object.freeze({ base: 20, severity: Object.freeze({ minor: 0, moderate: 10, major: 20 }) }),
  /** Planned work. Not assumed severe: much of it is off-peak or behind a barrier. */
  CONSTRUCTION: Object.freeze({ base: 12, severity: Object.freeze({ minor: 0, moderate: 8, major: 16 }) }),
  /** A queue is a real restriction but a symptom as often as a cause. */
  CONGESTION: Object.freeze({ base: 24, severity: Object.freeze({ minor: 0, moderate: 12, major: 24 }) }),
  /** A stopped vehicle: deliberately lighter than a crash or a multi-lane closure. */
  DISABLED: Object.freeze({ base: 10, severity: Object.freeze({ minor: 0, moderate: 5, major: 10 }) }),
});

/**
 * What the lanes add, on top of the event's own weight.
 *
 * Applied to whatever event states them, because two lanes blocked is two lanes blocked whether a
 * crash or a work zone is doing the blocking. A ramp is scored well below the carriageway: it
 * restricts access, not the through lanes. Nothing is added when the source stated no lane impact.
 */
export const LANE_IMPACT_WEIGHTS = Object.freeze({
  perBlockedLane: 25,
  fullClosure: 90,
  rampClosure: 8,
  shoulderOnly: 0,
});

/** The five levels, and the score at which each begins. */
export const OPERATIONAL_LEVELS = Object.freeze([
  Object.freeze({ id: 'SEVERE', label: 'Severe', from: 160 }),
  Object.freeze({ id: 'HIGH', label: 'High', from: 80 }),
  Object.freeze({ id: 'MODERATE', label: 'Moderate', from: 40 }),
  Object.freeze({ id: 'LOW', label: 'Low', from: 1 }),
  Object.freeze({ id: 'NORMAL', label: 'Normal', from: 0 }),
]);

/**
 * Level colours, taken from the corridor's existing traffic ramp so Live Ops looks like the rest of
 * the application rather than a second palette. NORMAL is the corridor's free-flow teal.
 */
export const OPERATIONAL_LEVEL_COLORS = Object.freeze({
  NORMAL: '#55d6ba',
  LOW: '#9ad97f',
  MODERATE: '#e5bc57',
  HIGH: '#ee9148',
  SEVERE: '#e66259',
});

export const levelFor = score =>
  (OPERATIONAL_LEVELS.find(level => score >= level.from) ?? OPERATIONAL_LEVELS.at(-1)).id;

/** FL511's severity wording, reduced to the keys the weights use. Unrecognised wording scores 0. */
export function severityKey(value) {
  const text = String(value ?? '').toLowerCase();
  if (!text.trim()) return null;
  if (/severe|major|serious/.test(text)) return 'major';
  if (/moderate|medium|intermediate/.test(text)) return 'moderate';
  if (/minor|minimal|low/.test(text)) return 'minor';
  return null;
}

/**
 * What one event adds to its section's score: its own weight, plus whatever it blocks.
 *
 * An event type with no weight contributes nothing at all, which is how a type is kept out of the
 * model rather than quietly given a default.
 */
export function eventScore(event) {
  const weights = OPERATIONAL_IMPACT_WEIGHTS[event?.type];
  if (!weights) return 0;
  const key = severityKey(event?.severity);
  return weights.base + (key ? weights.severity[key] ?? 0 : 0) + laneScore(event?.liveOps?.laneImpact);
}

/** The lane contribution alone. Zero when the source said nothing about lanes. */
export function laneScore(impact) {
  if (!impact || impact.source === 'none') return 0;
  if (impact.fullClosure) return LANE_IMPACT_WEIGHTS.fullClosure;
  if (impact.rampClosure) return LANE_IMPACT_WEIGHTS.rampClosure;
  if (impact.shoulderOnly) return LANE_IMPACT_WEIGHTS.shoulderOnly;
  return (impact.blockedLanes ?? 0) * LANE_IMPACT_WEIGHTS.perBlockedLane;
}

/** @deprecated kept for callers that only ever scored incidents. */
export const incidentScore = eventScore;

/**
 * Score every section from the events currently on the corridor.
 *
 * A section is keyed by carriageway AND band, never by band alone, so the two directions of one
 * band stay apart.
 *
 * @param {object[]} events   live events carrying the server's `liveOps` enrichment
 * @param {{sectionId: string, sectionIndex: number, sectionLabel: string, carriageway: string,
 *          segmentId: string}[]} sections  every section of the corridor, scored or not
 * @returns {{bySegmentId: Map<string, object>, sections: object[], excluded: object}}
 */
export function aggregateImpact(events, sections) {
  const bySegmentId = new Map();
  for (const section of sections ?? []) {
    bySegmentId.set(section.segmentId, {
      ...section, events: [], incidents: [], operationalScore: 0, operationalLevel: 'NORMAL',
      byType: countByType([]),
    });
  }

  const excluded = { express: 0, unknown: 0, unsectioned: 0, notScored: 0 };
  for (const event of events ?? []) {
    // A type with no weight is not part of the model; it stays on the map and out of every score.
    if (!OPERATIONAL_IMPACT_WEIGHTS[event?.type]) { excluded.notScored += 1; continue; }
    const ops = event.liveOps;
    if (ops?.carriageway === CARRIAGEWAYS.EXPRESS) { excluded.express += 1; continue; }
    if (!ops || ops.carriageway === CARRIAGEWAYS.UNKNOWN) { excluded.unknown += 1; continue; }
    const section = ops.segmentId ? bySegmentId.get(ops.segmentId) : null;
    // Classified to a carriageway but off every one of its sections — a ramp or an interchange.
    if (!section || section.carriageway !== ops.carriageway || ops.contributesToImpact === false || ops.spatialMatch?.confidence === 'LOW') { excluded.unsectioned += 1; continue; }
    section.events.push(event);
    if (event.type === 'INCIDENT') section.incidents.push(event);
  }

  for (const section of bySegmentId.values()) {
    section.operationalScore = section.events.reduce((total, event) => total + eventScore(event), 0);
    section.operationalLevel = levelFor(section.operationalScore);
    section.byType = countByType(section.events);
    for (const [field, type] of Object.entries({ incidents: 'INCIDENT', closures: 'CLOSURE', disabledVehicles: 'DISABLED', congestion: 'CONGESTION', construction: 'CONSTRUCTION' })) {
      section[field] = section.events.filter(event => event.type === type);
    }
    section.score = section.operationalScore;
    section.level = section.operationalLevel;
    section.reasons = explainImpact(section).reasons;
  }
  return { bySegmentId, sections: [...bySegmentId.values()], excluded };
}

/**
 * Why a section is at the level it is, in the words of the events that put it there.
 *
 * A coloured section must always be able to answer this; a colour with no reason behind it is not
 * something an operator can act on.
 */
export function explainImpact(section) {
  if (!section || !section.events?.length) {
    return { level: 'NORMAL', reasons: [], byType: countByType([]), summary: 'Nothing active on this section.' };
  }
  const reasons = section.events.map(event => ({
    id: event.id,
    type: event.type,
    title: event.title ?? TYPE_LABELS[event.type] ?? 'Event',
    description: event.description ?? event.title ?? null,
    severity: event.severity ?? null,
    laneImpact: event.liveOps?.laneImpactLabel ?? null,
    points: eventScore(event),
  })).sort((a, b) => b.points - a.points);
  // Named in the order an operator reads them, and only the types actually present.
  const summary = Object.entries(section.byType)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${count} ${TYPE_LABELS[type]}${count === 1 ? '' : 's'}`)
    .join(' · ');
  return { level: section.operationalLevel, reasons, byType: section.byType, summary };
}

export const TYPE_LABELS = Object.freeze({
  INCIDENT: 'incident', CLOSURE: 'closure', CONSTRUCTION: 'construction',
  CONGESTION: 'congestion', DISABLED: 'disabled vehicle',
});

function countByType(events) {
  const counts = { INCIDENT: 0, CLOSURE: 0, CONSTRUCTION: 0, CONGESTION: 0, DISABLED: 0 };
  for (const event of events) if (counts[event.type] != null) counts[event.type] += 1;
  return counts;
}
