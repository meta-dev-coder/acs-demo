/**
 * The carriageway vocabulary, browser side.
 *
 * Mirrors `server/carriageway.mjs` the way `liveEventsData.js` mirrors the server's event types:
 * the server decides what an event IS, and this side only needs the names to render and group by.
 * `tests/carriageway.test.mjs` asserts the two lists cannot drift apart.
 */

/** @typedef {'EB_GENERAL'|'WB_GENERAL'|'EXPRESS'|'UNKNOWN'} Carriageway */
export const CARRIAGEWAYS = Object.freeze({
  EB_GENERAL: 'EB_GENERAL', WB_GENERAL: 'WB_GENERAL', EXPRESS: 'EXPRESS', UNKNOWN: 'UNKNOWN',
});

export const CARRIAGEWAY_LABELS = Object.freeze({
  EB_GENERAL: 'Eastbound General Purpose',
  WB_GENERAL: 'Westbound General Purpose',
  EXPRESS: 'I-595 Express',
  UNKNOWN: 'Unresolved',
});

/** Short form, for a card where the full label would wrap. */
export const CARRIAGEWAY_SHORT = Object.freeze({
  EB_GENERAL: 'Eastbound', WB_GENERAL: 'Westbound', EXPRESS: 'Express', UNKNOWN: 'Unresolved',
});

/** Only the general-purpose carriageways carry sections in this version. */
export const hasSections = carriageway =>
  carriageway === CARRIAGEWAYS.EB_GENERAL || carriageway === CARRIAGEWAYS.WB_GENERAL;

/**
 * How a record's place on the corridor reads in a card or a details row. Express states its
 * direction only when the source did; "Unresolved" is said plainly rather than left blank.
 */
export function placeLabel(liveOps) {
  if (!liveOps) return 'Unresolved';
  if (liveOps.carriageway === CARRIAGEWAYS.EXPRESS) {
    return liveOps.direction ? `I-595 Express · ${liveOps.direction}` : 'I-595 Express';
  }
  if (liveOps.carriageway === CARRIAGEWAYS.UNKNOWN) return 'Carriageway unresolved';
  return liveOps.sectionLabel ?? CARRIAGEWAY_SHORT[liveOps.carriageway] ?? 'Unresolved';
}
