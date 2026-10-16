/**
 * Everything known about one selected place, assembled across the four domains.
 *
 * This is what turns five dashboards into one workspace: given a selection, it answers "what
 * happened here, what recurs, what secondary exposure is relevant, what assets and hazards are
 * associated, and what should be looked at next" — from one scope decision, so the answers cannot
 * contradict each other.
 *
 * Two separations it preserves, because collapsing either is how a safety screen starts lying:
 *
 *   • SCOPE. A section profile describes a stretch of corridor. A record assessment describes one
 *     record. Opening a record does not collapse the section profile into it — both are returned,
 *     labelled, and the panel shows the record BESIDE the stretch it sits in.
 *   • EVIDENCE KIND. Observed counts, associations by proximity, and modelled risk are kept apart
 *     and never summed.
 */
import { recommendationsFor } from './recommendations.js';
import { SCOPES, SELECTION_TYPES } from '../selection.js';
import { metresBetween } from './hotspots.js';

/** How far from a point counts as "here" when gathering the other domains' records. */
export const NEARBY_METERS = 300;

const near = (point, items, withinMeters) => items.filter(item =>
  Number.isFinite(item?.longitude) && Number.isFinite(item?.latitude)
  && Number.isFinite(point?.longitude) && metresBetween(point, item) <= withinMeters);

/**
 * One record, assessed on its own terms.
 *
 * Deliberately NOT a risk score. The TMC's secondary-risk model reads upstream congestion, the
 * segment's operational level and current weather; a register row from 2025 has none of those, and
 * feeding it absences would produce a number that looks like a risk and is not one. What a
 * historical record CAN support is its own recorded facts plus what the register says about the
 * place it happened — so that is what this returns, labelled as a historical assessment.
 */
export function incidentAssessment(fact, { sectionProfile = null, allFacts = [] } = {}) {
  if (!fact) return null;
  const sameHour = allFacts.filter(other => other.id !== fact.id
    && Math.abs(other.when.hour - fact.when.hour) <= 1).length;
  const nearby = near(fact, allFacts.filter(other => other.id !== fact.id), NEARBY_METERS);
  const within2h = nearby.filter(other =>
    Math.abs(other.when.ms - fact.when.ms) <= 2 * 3_600_000 && other.when.ms >= fact.when.ms);
  return Object.freeze({
    kind: 'HISTORICAL_RECORD',
    fact,
    recorded: Object.freeze({
      type: fact.type,
      severity: fact.severity,
      when: fact.when,
      laneClosure: fact.laneClosure,
      laneClosureHours: fact.laneClosureHours,
      weather: fact.weather,
      trafficConditions: fact.trafficConditions,
      speeding: fact.speeding,
      rootCauseCategory: fact.rootCauseCategory,
      safetyDevices: fact.safetyDevices,
      confirmed: fact.confirmed,
      policeReport: fact.policeReport,
      notes: fact.notes,
      recommendedNextAction: fact.recommendedNextAction,
    }),
    /** What the register says happened near it — co-occurrence, not a causal link. */
    followedBy: Object.freeze(within2h),
    nearbyRecords: nearby.length,
    sameHourCorridorRecords: sameHour,
    sectionLabel: sectionProfile?.section.label ?? null,
    /** Stated on the panel so the change of scope is never silent. */
    scopeNote: 'A historical record, assessed from what it itself records plus what the register '
      + 'holds around it. It is not a live risk score: the live model reads current congestion, '
      + 'weather and asset state, none of which exist for a past date.',
    unavailable: Object.freeze([
      { field: 'Detection and clearance times', reason: 'The register holds one incident time and a '
        + 'closure duration, not a detection, arrival or clearance timestamp.' },
      { field: 'Verified primary incident', reason: 'No field links a record to the incident that '
        + 'caused it, so a secondary label cannot be traced to a primary.' },
      { field: 'Traffic at the time', reason: 'Only the register’s own coarse `traffic_conditions` '
        + 'word. No measured volume or speed for that date.' },
    ]),
  });
}

/**
 * The full investigation for whatever is selected.
 *
 * @param {object} selection from selection.js
 * @param {{facts, sections, hotspots, defects, hazards, allFacts}} data
 */
export function investigate(selection, {
  scoped = null, sections = null, hotspots = null, defects = [], hazards = null, allFacts = [],
  place = null,
} = {}) {
  if (!selection || selection.selectionType === SELECTION_TYPES.NONE) return null;

  const sectionProfile = selection.sectionId ? sections?.byId?.get(selection.sectionId) ?? null : null;
  const cluster = selection.hotspotId
    ? hotspots?.clusters?.find(entry => entry.id === selection.hotspotId) ?? null : null;
  const fact = selection.incidentId
    ? allFacts.find(entry => entry.id === selection.incidentId) ?? null : null;
  const defect = selection.assetId
    ? defects.find(entry => entry.assetId === selection.assetId) ?? null : null;
  const hazardPlace = selection.hazardId
    ? hazards?.places?.find(place => place.key === selection.hazardId) ?? null : null;

  /** The point everything else is gathered around. */
  const anchor = place ?? cluster ?? fact ?? defect ?? hazardPlace
    ?? (sectionProfile?.facts?.[0] ?? null);

  // At section scope the section's own assignment decides; at place scope, distance from the anchor.
  const atSection = selection.scope === SCOPES.SECTION && sectionProfile;
  const facts = place ? place.facts : scoped?.facts ?? sectionProfile?.facts ?? [];
  // A place already knows its own members: it was built by gathering them.
  const localDefects = place ? place.defects
    : atSection ? sectionProfile.defects
      : anchor ? near(anchor, defects, NEARBY_METERS) : [];
  const localHazardPlaces = place ? place.hazards : atSection
    ? (hazards?.places ?? []).filter(place => sectionProfile.hazards
      .some(observation => place.observations?.includes(observation)))
    : anchor ? (hazards?.places ?? []).filter(place => Number.isFinite(place.longitude)
      && metresBetween(anchor, place) <= NEARBY_METERS) : [];

  const severe = facts.filter(entry => entry.severity.rank >= 2);
  const secondaryRecords = facts.filter(entry => /secondary/i.test(entry.rootCauseCategory ?? ''));
  const openDefects = localDefects.filter(entry => entry.open);

  return Object.freeze({
    selection,
    /* A — what is selected */
    context: Object.freeze({
      type: selection.selectionType,
      label: selection.label,
      sectionLabel: sectionProfile?.section.label ?? null,
      sectionWhere: sectionProfile?.section.where ?? null,
      carriageway: sectionProfile?.section.carriageway ?? selection.carriageway ?? null,
      carriagewayBasis: sectionProfile?.section.carriagewayBasis ?? null,
      longitude: anchor?.longitude ?? null,
      latitude: anchor?.latitude ?? null,
      scope: selection.scope,
      scopeLabel: scoped?.label ?? sectionProfile?.section.label ?? selection.label,
      scopeBasis: scoped?.basis ?? null,
      locationConfidence: 'Positions are asset-derived: a record is plotted at the asset it damaged, '
        + 'not at a surveyed point.',
    }),

    /* B — the safety summary, only what is supported */
    summary: Object.freeze({
      records: facts.length,
      severeRecords: severe.length,
      fatalRecords: facts.filter(entry => entry.severity.level === 'FATAL').length,
      confirmedRecords: facts.filter(entry => entry.confirmed).length,
      secondaryRecords: secondaryRecords.length,
      laneClosures: facts.filter(entry => entry.laneClosure).length,
      hazardFindings: localHazardPlaces.reduce((sum, place) => sum + place.hazards, 0),
      safetyAssets: new Set(localDefects.map(entry => entry.assetId).filter(Boolean)).size,
      openDefects: openDefects.length,
      overdueDefects: openDefects.filter(entry => entry.overdue).length,
      exposureVehicleMiles: sectionProfile?.exposureVehicleMiles ?? null,
      perHundredMillionVmt: sectionProfile?.perHundredMillionVmt ?? null,
      severePerHundredMillionVmt: sectionProfile?.severePerHundredMillionVmt ?? null,
    }),

    /* C — the four domains, each with its own records */
    domains: Object.freeze({
      accidents: Object.freeze({
        records: Object.freeze(facts),
        byType: groupCount(facts, entry => entry.type),
        byHour: groupCount(facts, entry => `${String(entry.when.hour).padStart(2, '0')}:00`),
        circumstances: groupCount(facts, entry => entry.rootCauseCategory),
      }),
      secondary: Object.freeze({
        labelled: Object.freeze(secondaryRecords),
        /** Pairs are candidates: nothing in the register links a secondary record to a primary. */
        verifiedPairs: null,
        verifiedPairsNote: 'The register has no field linking a secondary record to the incident '
          + 'that caused it, so no verified primary-secondary pair can be produced here.',
      }),
      hazards: Object.freeze({
        places: Object.freeze(localHazardPlaces),
        findings: localHazardPlaces.reduce((sum, place) => sum + place.hazards, 0),
      }),
      assets: Object.freeze({
        defects: Object.freeze(localDefects),
        open: Object.freeze(openDefects),
      }),
    }),

    /* The record open beside the stretch, when one is */
    record: fact ? incidentAssessment(fact, { sectionProfile, allFacts }) : null,

    /* D — what to do about it */
    recommendations: recommendationsFor({
      facts, defects: localDefects, hazards: localHazardPlaces,
      sectionProfile, label: sectionProfile?.section.label ?? selection.label ?? 'this location',
    }),
  });
}

const groupCount = (items, read) => Object.freeze([...items.reduce((map, item) => {
  const key = read(item);
  return key ? map.set(key, (map.get(key) ?? 0) + 1) : map;
}, new Map())].map(([label, count]) => Object.freeze({ label, count }))
  .sort((a, b) => b.count - a.count));
