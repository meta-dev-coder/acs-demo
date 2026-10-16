/**
 * What the screen has selected — one model, so nothing can disagree about it.
 *
 * Before this, the screen held TWO independent selections: `focusHotspot` (a concentration, which
 * narrowed every analysis) and `selectedId` (a queue entry, which filled the detail panel). They
 * were set in different places and could describe different locations at once, which is how a
 * concentration could still be narrowing the Secondary panel while the detail panel showed an
 * asset defect somewhere else entirely.
 *
 * One selection now. It names WHAT is selected and, separately, the SCOPE the analyses should
 * speak for — because those are not the same thing: selecting a single incident does not mean the
 * segment profile around it should collapse to that one record. A record keeps its parent section,
 * and the panels say which scope they are reporting.
 *
 * Pure: a selection is data, and every transition is a function of the previous selection.
 */

import { metresBetween } from './analytics/hotspots.js';

export const SELECTION_TYPES = Object.freeze({
  NONE: 'none',
  /** A milepost range of the corridor, from the FDOT segments. */
  SECTION: 'section',
  /** A concentration of records — a place the register points at, not a published boundary. */
  HOTSPOT: 'hotspot',
  /** One record in the register. */
  INCIDENT: 'incident',
  /** One asset with a safety-relevant work order. */
  ASSET: 'asset',
  /** One place where inspections recorded hazards. */
  HAZARD: 'hazard',
  /**
   * A map PLACE: everything the four domains report within one radius, as the badges count it.
   * Choosing a badge selects this, and the screen draws the place's members individually.
   */
  PLACE: 'place',
});

/**
 * The analytical scope a selection implies.
 *
 * SECTION — the analyses speak for a stretch of corridor.
 * PLACE   — they speak for a concentration or a hazard location, which is smaller than a section.
 * RECORD  — a single record is open; the analyses keep their SECTION scope and the record is
 *           assessed on its own, beside them. This is the distinction that stops one incident's
 *           score overwriting a segment's profile.
 */
export const SCOPES = Object.freeze({ CORRIDOR: 'CORRIDOR', SECTION: 'SECTION', PLACE: 'PLACE', RECORD: 'RECORD' });

export const EMPTY_SELECTION = Object.freeze({
  selectionType: SELECTION_TYPES.NONE,
  selectedId: null,
  /** The parent section, kept for every selection that has one. */
  sectionId: null,
  carriageway: null,
  incidentId: null,
  assetId: null,
  hazardId: null,
  hotspotId: null,
  placeId: null,
  /** Where the scope is centred and how far it reaches, when something narrower than a section. */
  anchor: null,
  /** What to call that scope on screen — the place's name, not the record's. */
  anchorLabel: null,
  priorityId: null,
  /** Where the analyses should speak for. */
  scope: SCOPES.CORRIDOR,
  /** Which queue entry, if the selection arrived from the priority list. */
  fromPriority: null,
  label: null,
});

const withDefaults = fields => Object.freeze({ ...EMPTY_SELECTION, ...fields });

/** The whole corridor: nothing selected. */
export const selectNothing = () => EMPTY_SELECTION;

export const selectSection = (section, { fromPriority = null } = {}) => withDefaults({
  selectionType: SELECTION_TYPES.SECTION,
  selectedId: section.id,
  sectionId: section.id,
  carriageway: section.carriageway ?? null,
  scope: SCOPES.SECTION,
  fromPriority,
  label: section.label ?? section.id,
});

export const selectHotspot = (cluster, { sectionId = null, fromPriority = null } = {}) => withDefaults({
  selectionType: SELECTION_TYPES.HOTSPOT,
  selectedId: cluster.id,
  hotspotId: cluster.id,
  sectionId,
  scope: SCOPES.PLACE,
  fromPriority,
  label: cluster.label ?? 'Records concentration',
});

/**
 * One record.
 *
 * The section comes with it and the scope stays SECTION: opening a record is a question about that
 * record, not an instruction to throw away the context it sits in.
 */
/**
 * One record.
 *
 * The section comes with it and the scope stays SECTION: opening a record is a question about that
 * record, not an instruction to throw away the context it sits in.
 *
 * `anchor` narrows that context. Choosing a record from INSIDE an opened place used to widen the
 * analyses from the place's handful of records to the whole milepost range — the map still showed
 * the place open while every panel beside it had quietly switched to a bigger stretch of road. With
 * the place's anchor carried through, reading one of its records keeps the place's scope.
 */
export const selectIncident = (fact, { sectionId = null, fromPriority = null, anchor = null,
  anchorLabel = null } = {}) => withDefaults({
  selectionType: SELECTION_TYPES.INCIDENT,
  selectedId: fact.id,
  incidentId: fact.id,
  sectionId,
  anchor,
  anchorLabel,
  scope: anchor ? SCOPES.PLACE : SCOPES.RECORD,
  fromPriority,
  label: `${fact.type} · ${fact.when?.dayKey ?? ''}`.trim(),
});

export const selectAsset = (defect, { sectionId = null, fromPriority = null, anchor = null,
  anchorLabel = null } = {}) => withDefaults({
  selectionType: SELECTION_TYPES.ASSET,
  selectedId: defect.assetId ?? defect.id,
  assetId: defect.assetId ?? null,
  sectionId,
  anchor,
  anchorLabel,
  scope: SCOPES.PLACE,
  fromPriority,
  label: `${defect.assetType ?? 'Asset'} ${defect.assetId ?? ''}`.trim(),
});

export const selectHazard = (place, { sectionId = null, fromPriority = null, anchor = null,
  anchorLabel = null } = {}) => withDefaults({
  selectionType: SELECTION_TYPES.HAZARD,
  selectedId: place.key,
  hazardId: place.key,
  sectionId,
  anchor,
  anchorLabel,
  scope: SCOPES.PLACE,
  fromPriority,
  label: place.label ?? 'Hazard location',
});

/**
 * A place on the map.
 *
 * The selection carries the place's CENTRE AND RADIUS rather than its member list, because the map's
 * places are rebuilt per tab — with Secondary open they hold only secondary-labelled records — and a
 * scope taken from that list would mean "this location" changed meaning when the reader changed tab.
 * A point and a radius is the same stretch of road whichever tab is open.
 */
export const selectPlace = (place, { sectionId = null, fromPriority = null } = {}) => withDefaults({
  selectionType: SELECTION_TYPES.PLACE,
  selectedId: place.id,
  placeId: place.id,
  anchor: Object.freeze({
    longitude: place.longitude,
    latitude: place.latitude,
    // Half the spread is the radius the members occupy; never smaller than the clustering radius,
    // so a place of one finding still scopes to its neighbourhood rather than to a point.
    radiusMeters: Math.max(250, Math.round((place.spreadMeters ?? 0) / 2)),
  }),
  sectionId,
  scope: SCOPES.PLACE,
  fromPriority,
  label: place.label ?? 'Findings here',
});

export const isEmpty = selection => !selection || selection.selectionType === SELECTION_TYPES.NONE;

/** Whether two selections point at the same thing, so a repeat click is not a recompute. */
export const sameSelection = (a, b) => a?.selectionType === b?.selectionType
  && a?.selectedId === b?.selectedId && a?.sectionId === b?.sectionId;

/**
 * The records an analysis should speak for, given the selection.
 *
 * This is the one place that decides, so the Accidents, Secondary, Assets and Hazards panels can
 * never disagree about which records they are describing.
 *
 * @param {object} selection
 * @param {{facts: object[], sections: object, hotspots: object}} data
 * @returns {{facts: object[], scope: string, label: string, basis: string}}
 */
export function scopedFacts(selection, { facts = [], sections = null, hotspots = null, places = [] } = {}) {
  const corridor = () => Object.freeze({
    facts, scope: SCOPES.CORRIDOR, label: 'the whole corridor',
    basis: 'Every record in the register for the selected period.',
  });
  if (isEmpty(selection)) return corridor();

  /**
   * Anything carrying an anchor scopes to it, whatever kind of thing is selected.
   *
   * A place sets one when it is opened; a record, asset or hazard chosen from inside that place
   * inherits it. That is what keeps the analyses on the place the operator is looking at instead of
   * silently widening to the milepost range the moment they open one of its records.
   */
  if (selection.anchor) {
    const anchor = selection.anchor;
    const within = facts.filter(fact => Number.isFinite(fact.longitude)
      && metresBetween(anchor, fact) <= anchor.radiusMeters);
    return Object.freeze({
      facts: within, scope: SCOPES.PLACE,
      label: selection.anchorLabel ?? selection.label,
      basis: `Records within ${anchor.radiusMeters} m of this place. Positions are asset-derived.`,
    });
  }
  if (selection.selectionType === SELECTION_TYPES.PLACE) return corridor();
  // A record keeps its section's scope: a single incident never becomes the corpus.
  if (selection.selectionType === SELECTION_TYPES.HOTSPOT) {
    const cluster = hotspots?.clusters?.find(entry => entry.id === selection.hotspotId);
    return cluster
      ? Object.freeze({ facts: cluster.facts, scope: SCOPES.PLACE, label: cluster.label,
        basis: `The ${cluster.records} records in this concentration, within ${cluster.radiusMeters} m.` })
      : corridor();
  }
  const sectionId = selection.sectionId;
  if (!sectionId) return corridor();
  const profile = sections?.byId?.get(sectionId);
  return profile
    ? Object.freeze({ facts: profile.facts, scope: SCOPES.SECTION, label: profile.section.label,
      basis: `Records positioned within 400 m of this milepost range’s centreline.` })
    : corridor();
}
