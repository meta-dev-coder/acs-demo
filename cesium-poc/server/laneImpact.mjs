/**
 * What an FL511 event says about lanes, read from its prose.
 *
 * FL511 states lane impact in the same sentence as everything else — "2 Right lanes blocked",
 * "Ramp closed", "All lanes closed" — and publishes no structured field for it. Measured against
 * the live feed, 76% of detail fragments say something about lanes, so it is worth reading; the
 * remaining quarter simply have no lane information and must not be given one.
 *
 * Two things this deliberately does NOT do:
 *
 *   It never infers a total lane count. "2 lanes blocked" does not say whether that is two of three
 *   or two of five, and the corridor's own lane counts are not in this data. `blockedLanes` is a
 *   count of what is blocked, nothing more.
 *
 *   It never upgrades a vague phrase. "Road closed" is recorded as a full closure; "delays" is
 *   recorded as nothing at all.
 */

/** @typedef {{blockedLanes: number|null, fullClosure: boolean, rampClosure: boolean,
 *             shoulderOnly: boolean, source: 'parsed'|'none'}} LaneImpact */

export const NO_LANE_IMPACT = Object.freeze({
  blockedLanes: null, fullClosure: false, rampClosure: false, shoulderOnly: false, source: 'none',
});

const WORD_NUMBERS = Object.freeze({ one: 1, two: 2, three: 3, four: 4, five: 5 });

/** "2 Left lanes blocked", "Left lane blocked", "Two lanes closed". */
const LANES = /\b(\d+|one|two|three|four|five)?\s*(?:left|right|center|centre|inside|outside|thru|through)?\s*lanes?\s+(?:are\s+)?(blocked|closed)\b/gi;
/** "All lanes closed", "Road closed", "Full closure". */
const FULL_SOURCE = /\ball\s+lanes?\s+(?:are\s+)?(?:blocked|closed)\b|\broad\s+closed\b|\bfull\s+closure\b|\bclosed\s+in\s+both\s+directions\b/;
const FULL = new RegExp(FULL_SOURCE.source, 'i');
const FULL_ALL = new RegExp(FULL_SOURCE.source, 'gi');
/** "Ramp closed", "On-ramp closed", "Off-ramp right lane blocked". */
const RAMP = /\b(?:on|off)?[- ]?ramp\s+(?:[a-z ]{0,18}?)?(?:blocked|closed)\b/i;
const SHOULDER = /\bshoulder\s+(?:blocked|closed)\b|\bon\s+the\s+(?:right|left)?\s*shoulder\b/i;

/**
 * @param {string} text  everything FL511 wrote about one event
 * @returns {LaneImpact}
 */
export function parseLaneImpact(text) {
  const prose = String(text ?? '');
  if (!prose.trim()) return NO_LANE_IMPACT;

  const fullClosure = FULL.test(prose);
  const rampClosure = RAMP.test(prose);
  const shoulderOnly = !fullClosure && !rampClosure && SHOULDER.test(prose);

  // The largest stated count, because a description can mention lanes more than once
  // ("2 left lanes blocked … right lane blocked") and the worst of them is the impact.
  // "All lanes closed" also reads as a lane phrase; it is a full closure, not one blocked lane, so
  // it is taken out before counting.
  let blockedLanes = null;
  for (const match of prose.replace(FULL_ALL, ' ').matchAll(LANES)) {
    const token = match[1]?.toLowerCase();
    const count = token ? (WORD_NUMBERS[token] ?? Number(token)) : 1;
    if (!Number.isFinite(count) || count < 1 || count > 12) continue;
    blockedLanes = Math.max(blockedLanes ?? 0, count);
  }

  const known = fullClosure || rampClosure || shoulderOnly || blockedLanes != null;
  return Object.freeze({
    blockedLanes, fullClosure, rampClosure, shoulderOnly,
    source: known ? 'parsed' : 'none',
  });
}

/** How a person reads it. Null when the source said nothing about lanes. */
export function laneImpactLabel(impact) {
  if (!impact || impact.source === 'none') return null;
  if (impact.fullClosure) return 'All lanes closed';
  if (impact.rampClosure) return impact.blockedLanes ? `Ramp · ${impact.blockedLanes} lane${impact.blockedLanes === 1 ? '' : 's'} blocked` : 'Ramp closed';
  if (impact.blockedLanes) return `${impact.blockedLanes} lane${impact.blockedLanes === 1 ? '' : 's'} blocked`;
  if (impact.shoulderOnly) return 'Shoulder only';
  return null;
}
