/**
 * What one kind of incident looks like — colour, pictogram and severity family.
 *
 * The crash taxonomy is the operator's first read of a record: "fire" and "flooding spinout" call
 * for different people, different equipment and different messages on the signs. A single amber
 * triangle for all fifteen types says none of that, so each family gets its own colour and its own
 * glyph, used identically by the card, the type dropdown, the details panel and the map marker.
 *
 * Matched by rule rather than by a literal table: the committed export carries fifteen spellings and
 * the live DataConnect classes invent new ones ("Vehicle vs attenuator" alongside "Attenuator hit"),
 * so a type that has never been seen still lands in the right family instead of falling out of the
 * scheme. Order matters — the first rule that matches wins, so the specific ones come first.
 *
 * Pure on purpose (no DOM, no React, no Cesium): the map marker draws the glyph path onto an SVG,
 * the React island renders the same family with a Material icon, and both are unit-testable.
 */

/**
 * @typedef {object} IncidentVisual
 * @property {string} key        Stable family id — what the icon map and the tests key on.
 * @property {string} label      How the family reads when the record itself carries no type.
 * @property {string} color      The family's colour, chosen to read on both the dark and light surface.
 * @property {string} glyph      SVG path data in a 24×24 box, for the map marker.
 * @property {number} [rotate]   Degrees to turn the glyph by, for families that reuse another's shape.
 * @property {'critical'|'serious'|'moderate'} weight  How loudly the family is drawn.
 */

/** 24×24 pictograms, shared where two families genuinely look the same (a rollover IS a car, turned). */
const GLYPHS = Object.freeze({
  fire: 'M12 2.2c-.4 3-2.2 4.4-3.6 6.2A6.6 6.6 0 0 0 6.8 12.6a5.2 5.2 0 0 0 10.4 0c0-2-1-3.4-2.2-4.6.1 2-.7 3-1.6 3.4.7-3.8-.6-6.8-1.4-9.2Zm0 10.4c1.2 1 1.8 2 1.8 3a1.8 1.8 0 0 1-3.6 0c0-1 .6-2 1.8-3Z',
  car: 'M4.6 12.4 6.2 7.8A2 2 0 0 1 8.1 6.4h7.8a2 2 0 0 1 1.9 1.4l1.6 4.6v5.2a1 1 0 0 1-2 0v-1.4H6.6v1.4a1 1 0 0 1-2 0Zm2.2-.6h10.4l-1.1-3.2H7.9ZM7.6 13.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm8.8 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z',
  impact: 'M12 2.4l1.9 4.3 4.3-1.5-1.6 4.3 4.3 1.9-4.3 1.9 1.6 4.3-4.3-1.5L12 20.4l-1.9-4.3-4.3 1.5 1.6-4.3L3.1 11.4l4.3-1.9L5.8 5.2l4.3 1.5Z',
  barrier: 'M3 6.6h18v2.8H3Zm2.2 2.8h2.4v8.2H5.2Zm11.2 0h2.4v8.2h-2.4ZM9 11.6h6v2.2H9Z',
  shield: 'M12 2.4 4.4 5.2v6.2c0 4.6 3.2 8.4 7.6 10.2 4.4-1.8 7.6-5.6 7.6-10.2V5.2Zm0 3.6 4.4 1.6v3.8c0 2.8-1.8 5.2-4.4 6.4-2.6-1.2-4.4-3.6-4.4-6.4V7.6Z',
  water: 'M12 2.2c-.3 0-6.6 7-6.6 11.4a6.6 6.6 0 0 0 13.2 0C18.6 9.2 12.3 2.2 12 2.2Zm0 3.4c1.8 2.2 4.6 6.2 4.6 8a4.6 4.6 0 0 1-9.2 0c0-1.8 2.8-5.8 4.6-8Z',
  pedestrian: 'M13.4 2.2a2 2 0 1 1-2 2 2 2 0 0 1 2-2ZM11 7.4h2.2l3.4 4.6-1.6 1.2-2-2.6v2.8l2.6 3.8v4.4h-2.2v-3.8l-2.8-3.8-1.2 7.6H7.2l1.8-9.4-1.8 1.8v2.8H5.4v-3.6Z',
  debris: 'M2.6 18.6h6.2l-3.1-5.2Zm7.6 0h5.4l-2.7-4.4Zm6.4-5.8h4.8l-2.4-4ZM7.6 6.2l2.2 1.6-1.4 2.2-2.2-1.6Z',
  device: 'M4 4.6h16v9.6H4Zm2.2 2.2v5.2h11.6V6.8ZM11 14.2h2v5.2h3v2.2H8v-2.2h3Z',
  wrongWay: 'M9.2 21.4V9.6a2.8 2.8 0 0 1 5.6 0v11.8h-2.4V9.6a.4.4 0 0 0-.8 0v11.8ZM6.4 4.6 2.6 9.8h7.6Z',
  diverge: 'M10.8 21.4v-9.2L6 7.4v-2.8h2.8l4.4 4.4v12.4Zm7.4-16.8h-4.6l-3 3 1.6 1.6 2.4-2.4h3.6Z',
});

/** The families themselves, most specific rule first. */
const FAMILIES = Object.freeze([
  { key: 'fire', label: 'Vehicle fire', match: /fire|burn|smoke/i, color: '#E0492B', glyph: GLYPHS.fire, weight: 'critical' },
  { key: 'pedestrian', label: 'Pedestrian exposure', match: /pedestrian|cyclist|person|worker/i, color: '#D6296E', glyph: GLYPHS.pedestrian, weight: 'critical' },
  { key: 'wrongWay', label: 'Wrong-way event', match: /wrong[-\s]?way/i, color: '#8B3FD1', glyph: GLYPHS.wrongWay, weight: 'critical' },
  { key: 'multiVehicle', label: 'Multi-vehicle crash', match: /multi[-\s]?vehicle|pile[-\s]?up|secondary collision/i, color: '#D22D33', glyph: GLYPHS.impact, weight: 'critical' },
  { key: 'rearEnd', label: 'Rear-end crash', match: /rear[-\s]?end/i, color: '#E06A2B', glyph: GLYPHS.car, weight: 'serious' },
  { key: 'rollover', label: 'Rollover', match: /rollover|overturn/i, color: '#C2410C', glyph: GLYPHS.car, rotate: 150, weight: 'critical' },
  { key: 'attenuator', label: 'Attenuator impact', match: /attenuator|crash cushion/i, color: '#7C5CD6', glyph: GLYPHS.shield, weight: 'serious' },
  { key: 'guardrail', label: 'Guardrail strike', match: /guardrail|guard rail/i, color: '#A16207', glyph: GLYPHS.barrier, weight: 'moderate' },
  { key: 'barrier', label: 'Barrier impact', match: /barrier|wall|median/i, color: '#B45309', glyph: GLYPHS.barrier, weight: 'serious' },
  { key: 'flooding', label: 'Weather-related loss of control', match: /flood|spinout|hydroplan|rain|storm|ice/i, color: '#1D8FD1', glyph: GLYPHS.water, weight: 'serious' },
  { key: 'debris', label: 'Debris event', match: /debris|object|evasive/i, color: '#5C8A1E', glyph: GLYPHS.debris, weight: 'moderate' },
  { key: 'device', label: 'ITS device strike', match: /device|sign|cabinet|pole|gantry|camera/i, color: '#2563EB', glyph: GLYPHS.device, weight: 'moderate' },
  { key: 'sideswipe', label: 'Sideswipe / merge conflict', match: /sideswipe|merge|lane change/i, color: '#C99700', glyph: GLYPHS.diverge, weight: 'moderate' },
  { key: 'laneDeparture', label: 'Lane departure', match: /lane departure|run[-\s]?off|off[-\s]?road/i, color: '#D97706', glyph: GLYPHS.diverge, rotate: 180, weight: 'serious' },
  { key: 'crash', label: 'Crash', match: /crash|collision|struck|hit|vs\b/i, color: '#D2453C', glyph: GLYPHS.car, weight: 'serious' },
]);

/** Anything the rules do not recognise: named, coloured and drawn rather than left blank. */
export const UNCLASSIFIED = Object.freeze({
  key: 'other', label: 'Incident', color: '#64748B', glyph: GLYPHS.impact, weight: 'moderate',
});

/** Every family, in the order the rules are tried — what a legend would list. */
export const INCIDENT_FAMILIES = Object.freeze([...FAMILIES.map(({ match, ...rest }) => Object.freeze(rest)), UNCLASSIFIED]);

/**
 * The visual identity for one incident type, by the words the record uses for it.
 *
 * @param {string|null|undefined} incidentType e.g. "Flooding-related spinout"
 * @returns {IncidentVisual}
 */
export function incidentVisual(incidentType) {
  const text = String(incidentType ?? '').trim();
  if (!text) return UNCLASSIFIED;
  const family = FAMILIES.find(entry => entry.match.test(text));
  if (!family) return UNCLASSIFIED;
  const { match, ...visual } = family;
  return Object.freeze(visual);
}

/** The same lookup from a normalized maintenance record, whose `title` IS its incident type. */
export const incidentVisualOf = record => incidentVisual(record?.title);

/**
 * How severe one incident reads, from what the record actually carries rather than from its type.
 *
 * A fatality or an injury outranks everything; a lane closure is the next thing an operator acts on.
 * Nothing is inferred where the fields are absent — an incident with neither is "Reported", not "Low".
 *
 * @returns {{level: 'High'|'Moderate'|'Reported', label: string, tone: 'danger'|'warning'|'muted'}}
 */
/**
 * How bad one crash was, in four tiers.
 *
 * The incident register carries no severity column — it records what HAPPENED — so severity is read
 * from fatalities, injuries and lane closures, in that order of seriousness. This is the single
 * place that rule lives: the details panel prints it, and Safety's crash hotspots weight their
 * colour by it, so a crash cannot be "High" in one place and something else in the other.
 */
export const CRASH_SEVERITY_TIERS = Object.freeze(['severe', 'high', 'intermediate', 'minor']);

/**
 * Live event types that are NOT a crash, however they are filed.
 *
 * The FL511 feed files closures, roadworks and congestion under the same incident class as crashes.
 * They are real events and belong on Live Ops, but the Safety screen answers one question — where
 * has this corridor hurt people — and a ramp closed for construction is not an answer to it. Four
 * such closures put themselves on the crash map and made the recent periods look busy.
 */
const NON_CRASH_EVENT_TYPES = Object.freeze(new Set(['CLOSURE', 'CONSTRUCTION', 'CONGESTION']));

/**
 * Whether a record is a crash, and so belongs in the safety picture.
 *
 * The register's own 178 records carry no event type at all — the class IS the crash register, and
 * every row in it is a crash ("Multi-vehicle crash", "Vehicle fire", "Guardrail strike"). Only the
 * live rows merged in from FL511 carry one, so the rule is stated the honest way round: a record is
 * a crash unless its live event type says it is something else. Anything that reports injuries or
 * a fatality counts regardless of how it was filed — harm is the thing being mapped.
 */
export function isCrashRecord(record) {
  const related = record?.related ?? {};
  if ((Number(related.fatalities) || 0) > 0 || /^y/i.test(related.injuries ?? '')) return true;
  const eventType = String(related.eventType ?? '').trim().toUpperCase();
  return !NON_CRASH_EVENT_TYPES.has(eventType);
}

export function crashSeverityTier(record) {
  // A record may state its own tier. The live feed publishes Minor/Intermediate/Major and no injury
  // columns at all, so the rule below cannot grade it; carrying the tier is how a feed crash keeps
  // the severity FL511 actually published instead of being flattened to "minor".
  if (CRASH_SEVERITY_TIERS.includes(record?.crashTier)) return record.crashTier;
  const related = record?.related ?? {};
  if ((Number(related.fatalities) || 0) > 0) return 'severe';
  if (/^y/i.test(related.injuries ?? '')) return 'high';
  if (/^y/i.test(related.laneClosure ?? '')) return 'intermediate';
  return 'minor';
}

/** The tier as the panel shows it: a short level, what it is based on, and a tone. */
export function incidentSeverity(record) {
  const related = record?.related ?? {};
  const fatalities = Number(related.fatalities) || 0;
  switch (crashSeverityTier(record)) {
    case 'severe':
      return { level: 'High', label: fatalities === 1 ? '1 fatality' : `${fatalities} fatalities`, tone: 'danger' };
    case 'high':
      return { level: 'High', label: 'Injuries reported', tone: 'danger' };
    case 'intermediate':
      return { level: 'Moderate', label: 'Lane closure', tone: 'warning' };
    default:
      return { level: 'Reported', label: 'No injuries reported', tone: 'muted' };
  }
}
