/**
 * Which longitudinal section of I-595 an already-classified event sits in.
 *
 * The corridor is cut into eight FDOT AADT bands, and both carriageways use the SAME eight bands:
 * an eastbound and a westbound segment sharing `fdot_segment_index` cover the same stretch of road
 * in opposite directions. That shared index is the corridor's own longitudinal model, so Live Ops
 * uses it rather than inventing a G01/G02 scheme — `SECTION_03` is simply FDOT band 3, and the real
 * FDOT segment id is carried alongside it, never replaced.
 *
 * Sharing the band is not sharing the state: EB SECTION_03 and WB SECTION_03 are two separate
 * operational sections that happen to lie side by side, and their scores are never merged.
 *
 * The one rule this module exists to enforce: candidates are restricted to the carriageway the
 * classifier already decided. Geometry chooses WHERE along a carriageway, never WHICH carriageway —
 * the lines are 17–40 m apart, so letting geometry choose between them assigns the wrong one.
 */
import { distanceToPolylineMeters } from './geo.mjs';
import { CARRIAGEWAYS } from './carriageway.mjs';

/**
 * How far off a segment's own geometry an event may sit and still belong to it.
 *
 * FL511 anchors an event at a point that can be a lane or a shoulder away from the centreline this
 * repo draws, and the two geometries come from different surveys (FDOT mileposts projected onto OSM
 * carriageways). 120 m is the tolerance the corridor association already uses; it is generous
 * enough for that disagreement and, because candidates are restricted to one carriageway first, it
 * can no longer reach across to the opposite one.
 */
export const DEFAULT_SECTION_TOLERANCE_M = 120;

/** The FDOT direction token for each general-purpose carriageway. */
const DIRECTION_OF = Object.freeze({
  [CARRIAGEWAYS.EB_GENERAL]: 'EB',
  [CARRIAGEWAYS.WB_GENERAL]: 'WB',
});

export const sectionIdFor = index => (Number.isFinite(index) ? `SECTION_${String(index).padStart(2, '0')}` : null);

/** @returns {string} "Eastbound Section 03" — how a person refers to one of these. */
export const sectionLabelFor = (carriageway, index) => {
  const side = carriageway === CARRIAGEWAYS.WB_GENERAL ? 'Westbound' : 'Eastbound';
  return Number.isFinite(index) ? `${side} Section ${String(index).padStart(2, '0')}` : side;
};

/**
 * Every section of the corridor, as Live Ops addresses them: the eight FDOT bands on each
 * general-purpose carriageway. Express is deliberately absent — it is a different roadway with its
 * own milepost system (86095900, MP 0–8.796 against the general-purpose 86095000, MP 0–12.86), so
 * its sections cannot be borrowed from these and are not derived in this version.
 *
 * @param {{segmentId: string, direction: string, index: number}[]} segments
 */
export function corridorSections(segments) {
  return (segments ?? [])
    .filter(segment => segment.direction === 'EB' || segment.direction === 'WB')
    .map(segment => {
      const carriageway = segment.direction === 'WB' ? CARRIAGEWAYS.WB_GENERAL : CARRIAGEWAYS.EB_GENERAL;
      return Object.freeze({
        sectionId: sectionIdFor(segment.index),
        sectionIndex: Number.isFinite(segment.index) ? segment.index : null,
        sectionLabel: sectionLabelFor(carriageway, segment.index),
        carriageway,
        segmentId: segment.segmentId,
      });
    });
}

/**
 * Resolve one classified event to a section of its own carriageway.
 *
 * @param {{longitude: number, latitude: number}} point
 * @param {string} carriageway  what the classifier decided — NOT a guess from geometry
 * @param {{segmentId: string, direction: string, index: number, coordinates: number[][]}[]} segments
 * @param {{toleranceMeters?: number}} [options]
 * @returns {{sectionId: string|null, sectionIndex: number|null, sectionLabel: string|null,
 *            segmentId: string|null, method: string, distanceMeters: number|null,
 *            candidateCount: number, runnerUpMeters: number|null}}
 */
export function resolveSection(point, carriageway, segments, { toleranceMeters = DEFAULT_SECTION_TOLERANCE_M } = {}) {
  const none = method => ({
    sectionId: null, sectionIndex: null, sectionLabel: null, segmentId: null,
    method, distanceMeters: null, candidateCount: 0, runnerUpMeters: null,
  });

  const direction = DIRECTION_OF[carriageway];
  // Express and UNKNOWN resolve to no section on purpose. Express has no sections in this version,
  // and an unresolved carriageway must not be handed to whichever segment happens to be nearest.
  if (!direction) return none(carriageway === CARRIAGEWAYS.EXPRESS ? 'express-no-sections' : 'carriageway-unknown');
  if (!Number.isFinite(point?.longitude) || !Number.isFinite(point?.latitude)) return none('no-coordinates');

  const candidates = (segments ?? []).filter(segment => segment.direction === direction);
  if (!candidates.length) return none('no-candidate-segments');

  const ranked = candidates
    .map(segment => ({ segment, distance: distanceToPolylineMeters(point.longitude, point.latitude, segment.coordinates) }))
    .filter(entry => Number.isFinite(entry.distance))
    .sort((a, b) => a.distance - b.distance);

  const best = ranked[0];
  if (!best || best.distance > toleranceMeters) {
    // On this carriageway but off every one of its sections — a ramp, an interchange, or past the
    // end of the sectioned length. The carriageway stands; the section does not.
    return { ...none('beyond-tolerance'), candidateCount: candidates.length, distanceMeters: best ? round(best.distance) : null };
  }

  return {
    sectionId: sectionIdFor(best.segment.index),
    sectionIndex: Number.isFinite(best.segment.index) ? best.segment.index : null,
    sectionLabel: sectionLabelFor(carriageway, best.segment.index),
    segmentId: best.segment.segmentId,
    method: 'classified-carriageway+nearest-line',
    distanceMeters: round(best.distance),
    candidateCount: candidates.length,
    // How much better the winner was than the next section along. A few metres means the event sits
    // on a band boundary, which is worth seeing in diagnostics rather than hiding behind a winner.
    runnerUpMeters: ranked[1] ? round(ranked[1].distance) : null,
  };
}

const round = value => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
