/**
 * The unified Safety Priority Queue.
 *
 * The temptation is a single number: weigh crash history, asset condition and hazard findings, add
 * them up, sort descending, call it a safety score. That number would be indefensible — the three
 * domains have no common unit, no validated weights exist for combining them, and the incident
 * positions are asset-derived rather than surveyed. A ranked list carrying a fabricated score is
 * worse than no list, because it looks authoritative.
 *
 * So the queue is built the other way round:
 *
 *   • Each entry comes from ONE domain and carries only that domain's own evidence.
 *   • Urgency is an ORDINAL BAND (IMMEDIATE / NEAR_TERM / MONITOR) from rules written below in
 *     plain terms, not a continuous score, and the rule that fired is attached to the entry.
 *   • Ordering within a band is by that domain's own countable quantity, which is named on screen.
 *   • Cross-domain entries exist only where two domains point at the same place, and they say
 *     "two domains point here" — they do not multiply or add the two.
 *
 * Nothing here estimates a benefit. Every entry answers "why is this on the list?" and nothing else.
 */
import { metresBetween } from './hotspots.js';
import { CONFIDENCE, OWNERS, STALE_DEFECT_DAYS, URGENCY as ACTION_URGENCY } from './recommendations.js';

/**
 * The band an entry sits in.
 *
 * Kept as the coarse sort, but it is no longer what the row SAYS. "Look at now" on every entry in
 * the top band told an operator nothing: a fatal concentration and a work order open for 900 days
 * both read as emergencies demanding the same response. The row now shows the entry's
 * `actionUrgency` — the KIND of attention wanted — and the band only orders them.
 */
export const URGENCY = Object.freeze({
  IMMEDIATE: { id: 'IMMEDIATE', label: 'Act or inspect', rank: 3 },
  NEAR_TERM: { id: 'NEAR_TERM', label: 'Plan', rank: 2 },
  MONITOR: { id: 'MONITOR', label: 'Watch', rank: 1 },
});

export { CONFIDENCE, OWNERS };
/** The five kinds of attention a finding can want. Re-exported so one vocabulary serves both. */
export const ACTION = ACTION_URGENCY;

export const DOMAIN = Object.freeze({
  ACCIDENT: { id: 'ACCIDENT', label: 'Incident records' },
  ASSET: { id: 'ASSET', label: 'Asset condition' },
  HAZARD: { id: 'HAZARD', label: 'Inspection findings' },
  SECONDARY: { id: 'SECONDARY', label: 'Secondary incidents' },
  /**
   * Kept as a label for the "two domains agree" FILTER. No entry has this domain: agreement is
   * written on the entry that already exists, so nothing is counted twice.
   */
  CROSS: { id: 'CROSS', label: 'Two domains agree' },
});

/**
 * One entry.
 *
 * `actionUrgency`, `confidence`, `owner` and `sourceRecords` are required of every entry: a finding
 * an operator cannot act on, cannot weigh and cannot trace back to a record is not worth a row.
 */
const entry = fields => Object.freeze({
  sourceRecords: Object.freeze([]),
  sectionId: null,
  carriageway: null,
  ...fields,
  /** Stated so the UI can never render this as a computed safety score. */
  score: null,
  scoreBasis: 'Ordinal band from a stated rule. No cross-domain numeric score is computed.',
});

/** Which corridor section a positioned entry falls in, for filtering and for the investigation. */
const sectionOf = (point, sections) => (sections && Number.isFinite(point?.longitude)
  ? sections.rows.find(row => row.facts.includes(point) || row.defects.includes(point))?.id ?? null
  : null);

/**
 * Hotspot entries.
 *
 * Rule: a concentration with a fatal record, or with an injury record and five or more records
 * overall, is IMMEDIATE. Five or more records is NEAR_TERM. Anything else that clustered is MONITOR.
 */
export function hotspotEntries(hotspots = null, { sections = null } = {}) {
  if (!hotspots?.clusters?.length) return [];
  return hotspots.clusters.map(cluster => {
    const fatal = cluster.facts.filter(fact => fact.severity.level === 'FATAL').length;
    const injury = cluster.facts.filter(fact => fact.severity.level === 'INJURY').length;
    const urgency = fatal > 0 || (injury > 0 && cluster.records >= 5) ? URGENCY.IMMEDIATE
      : cluster.records >= 5 ? URGENCY.NEAR_TERM : URGENCY.MONITOR;
    const section = sections?.rows.find(row => row.facts.some(fact => cluster.facts.includes(fact)));
    return entry({
      id: `hotspot:${cluster.id}`,
      domain: DOMAIN.ACCIDENT,
      urgency,
      // A concentration of past records is never an emergency call-out: it is a place to send an
      // engineering review, or an inspection where somebody has been killed.
      actionUrgency: fatal > 0 ? ACTION.URGENT_INSPECTION : ACTION.PLANNED_ASSESSMENT,
      confidence: cluster.confirmationRate >= 0.5 ? CONFIDENCE.OBSERVED : CONFIDENCE.UNVERIFIED,
      owner: OWNERS.TRAFFIC_ENGINEERING,
      title: cluster.label ?? `${cluster.records} records within ${hotspots.radiusMeters} m`,
      quantity: cluster.records,
      quantityLabel: 'records',
      rule: fatal > 0 ? 'A fatal record in this concentration.'
        : injury > 0 && cluster.records >= 5 ? 'An injury record and five or more records here.'
          : cluster.records >= 5 ? 'Five or more records here.' : 'Records concentrate here.',
      evidence: `${cluster.records} records, ${fatal} fatal, ${injury} with injuries, `
        + `${Math.round(cluster.confirmationRate * 100)}% with a police report number.`,
      caveat: 'Positions are asset-derived, so this is where damaged assets concentrate.',
      longitude: cluster.longitude,
      latitude: cluster.latitude,
      sectionId: section?.id ?? null,
      carriageway: section?.section.carriageway ?? null,
      target: Object.freeze({ kind: 'hotspot', id: cluster.id }),
      facts: cluster.facts,
      sourceRecords: Object.freeze(cluster.facts.slice(0, 10).map(fact => Object.freeze({
        kind: 'incident', id: fact.id, label: `${fact.type} · ${fact.when.dayKey}` }))),
    });
  });
}

/**
 * Asset entries.
 *
 * Rule: open past the published class target is IMMEDIATE, open with a high-priority flag is
 * NEAR_TERM, otherwise open is MONITOR. Where no target is published, the entry says so instead of
 * being judged against an invented one.
 */
export function assetEntries(defects = [], { sections = null } = {}) {
  return defects.filter(defect => defect.open).map(defect => {
    const urgent = defect.overdue;
    const high = /high|urgent|critical|1/i.test(defect.priority ?? '');
    // Open for over a year, this is more likely a record nobody closed than a fault still on the
    // road — so it asks for validation, not a crew. Treating it as a live failure would send one.
    const stale = (defect.ageDays ?? 0) > STALE_DEFECT_DAYS;
    const section = sections?.rows.find(row => row.defects.includes(defect));
    return entry({
      id: `defect:${defect.id}`,
      domain: DOMAIN.ASSET,
      urgency: urgent ? URGENCY.IMMEDIATE : high ? URGENCY.NEAR_TERM : URGENCY.MONITOR,
      actionUrgency: stale ? ACTION.DATA_VALIDATION
        : urgent ? ACTION.OVERDUE_MAINTENANCE : ACTION.PLANNED_ASSESSMENT,
      confidence: stale ? CONFIDENCE.UNVERIFIED : CONFIDENCE.OBSERVED,
      owner: OWNERS.MAINTENANCE,
      title: `${defect.assetType ?? 'Asset'} ${defect.assetId ?? ''}`.trim(),
      quantity: defect.ageDays,
      quantityLabel: 'days open',
      rule: stale ? `Open ${defect.ageDays} days — long enough that the record needs checking before a crew is sent.`
        : urgent ? `Open ${defect.ageDays} days against a ${defect.targetDays}-day class target.`
          : high ? `Priority ${defect.priority} and still open.` : 'Open work order on a safety-relevant asset.',
      evidence: defect.description ?? `Work order ${defect.id}.`,
      caveat: defect.targetDays == null
        ? 'No repair-time target is published for this asset category, so age is reported without a target.'
        : stale ? 'Age alone does not establish that the asset is still faulty.' : null,
      longitude: defect.longitude,
      latitude: defect.latitude,
      sectionId: section?.id ?? null,
      carriageway: section?.section.carriageway ?? null,
      target: Object.freeze({ kind: 'workOrder', id: defect.id, assetId: defect.assetId }),
      defect,
      sourceRecords: Object.freeze([Object.freeze({ kind: 'workOrder', id: defect.id,
        label: `Work order ${defect.id}` }),
        ...(defect.assetId ? [Object.freeze({ kind: 'asset', id: defect.assetId,
          label: `Asset ${defect.assetId}` })] : [])]),
    });
  });
}

/**
 * Hazard entries.
 *
 * Rule: a failed inspection with a hazard, or a risk rating of 4–5, is IMMEDIATE. Two or more
 * hazard findings at one place is NEAR_TERM. One finding is MONITOR.
 */
export function hazardEntries(hazards = null, { sections = null } = {}) {
  if (!hazards?.places?.length) return [];
  return hazards.places.map(place => {
    const failed = place.observations.some(observation => observation.failed);
    const severe = (place.worstRating ?? 0) >= 4;
    const section = sections?.rows.find(row => place.observations.some(observation =>
      row.hazards.includes(observation)));
    return entry({
      id: `hazard:${place.key}`,
      domain: DOMAIN.HAZARD,
      urgency: failed || severe ? URGENCY.IMMEDIATE
        : place.hazards >= 2 ? URGENCY.NEAR_TERM : URGENCY.MONITOR,
      actionUrgency: failed || severe ? ACTION.URGENT_INSPECTION : ACTION.PLANNED_ASSESSMENT,
      confidence: CONFIDENCE.OBSERVED,
      owner: OWNERS.FIELD,
      title: place.label,
      quantity: place.hazards,
      quantityLabel: 'hazard findings',
      rule: failed ? 'An inspection at this location failed with a hazard recorded.'
        : severe ? `Inspector risk rating ${place.worstRating} of 5.`
          : place.hazards >= 2 ? 'More than one hazard finding here.' : 'A hazard finding here.',
      evidence: place.observations.flatMap(observation => observation.hazards).join(', '),
      caveat: 'An inspector’s observation on a date, not a live hazard report, and not a record of '
        + 'anything being cleared.',
      longitude: place.longitude,
      latitude: place.latitude,
      sectionId: section?.id ?? null,
      carriageway: section?.section.carriageway ?? null,
      target: Object.freeze({ kind: 'inspection', id: place.key }),
      sourceRecords: Object.freeze(place.observations.slice(0, 10).map(observation => Object.freeze({
        kind: 'inspection', id: observation.id,
        label: `${observation.inspectedOn ?? 'Inspection'} · ${observation.hazards.join(', ')}` }))),
    });
  });
}

/**
 * Secondary-incident entries, from the OBSERVED side only.
 *
 * Rule: a location with two or more secondary-labelled records is NEAR_TERM; one is MONITOR. The
 * modelled risk score never produces a queue entry, because it is about a live incident rather than
 * a place that needs attention.
 */
export function secondaryEntries(observed = null, { sections = null } = {}) {
  if (!observed?.records?.length) return [];
  const places = new Map();
  for (const fact of observed.records) {
    const key = fact.segmentName ?? fact.assetId ?? fact.id;
    const found = places.get(key) ?? { key, label: fact.segmentName ?? `Asset ${fact.assetId}`, facts: [] };
    found.facts.push(fact);
    found.longitude ??= fact.longitude;
    found.latitude ??= fact.latitude;
    places.set(key, found);
  }
  return [...places.values()].map(place => {
    const section = sections?.rows.find(row => place.facts.some(fact => row.facts.includes(fact)));
    return entry({
      id: `secondary:${place.key}`,
      domain: DOMAIN.SECONDARY,
      urgency: place.facts.length >= 2 ? URGENCY.NEAR_TERM : URGENCY.MONITOR,
      actionUrgency: ACTION.PLANNED_ASSESSMENT,
      // The label is somebody's category, and no field links it to a primary incident.
      confidence: CONFIDENCE.UNVERIFIED,
      owner: OWNERS.OPERATIONS,
      title: place.label,
      quantity: place.facts.length,
      quantityLabel: 'secondary-labelled records',
      rule: place.facts.length >= 2
        ? 'More than one record here is categorised as a secondary collision.'
        : 'A record here is categorised as a secondary collision.',
      evidence: place.facts.map(fact => fact.type).join(', '),
      caveat: 'The secondary label is an assigned category, not an investigated finding, and nothing '
        + 'links it to a primary incident.',
      longitude: place.longitude,
      latitude: place.latitude,
      sectionId: section?.id ?? null,
      carriageway: section?.section.carriageway ?? null,
      target: Object.freeze({ kind: 'secondary', id: place.key }),
      facts: Object.freeze(place.facts),
      sourceRecords: Object.freeze(place.facts.slice(0, 10).map(fact => Object.freeze({
        kind: 'incident', id: fact.id, label: `${fact.type} · ${fact.when.dayKey}` }))),
    });
  });
}

/**
 * Places where two domains independently point at the same spot.
 *
 * This is the only cross-domain claim the screen makes, and it is deliberately weak: "an open
 * defect sits inside a records concentration" is a reason to send one person to look at both.
 *
 * It ANNOTATES the existing entries rather than adding rows. Adding a row per pair was the first
 * version, and on the real corpus it produced 190 cross entries against 155 real ones — the same
 * finding counted several times, which is exactly the inflation a priority list must not have. An
 * entry now carries who else points at its location, the queue total still counts each finding
 * once, and the urgency band is untouched: agreement is a reason to look, not an escalation.
 *
 * @param {object[]} entries the domain entries
 * @returns {object[]} the same entries, each with `alsoFlaggedBy` and `agrees`
 */
export function withCrossDomainLinks(entries = [], { withinMeters = 300 } = {}) {
  const located = entries.filter(row => Number.isFinite(row.longitude) && Number.isFinite(row.latitude));
  const links = new Map();
  for (const left of located) {
    for (const right of located) {
      if (left.id === right.id || left.domain.id === right.domain.id) continue;
      if (metresBetween(left, right) > withinMeters) continue;
      const found = links.get(left.id) ?? new Map();
      const seen = found.get(right.domain.id) ?? { domain: right.domain, count: 0, ids: [] };
      seen.count += 1;
      if (seen.ids.length < 6) seen.ids.push(right.id);
      found.set(right.domain.id, seen);
      links.set(left.id, found);
    }
  }
  return entries.map(row => {
    const found = links.get(row.id);
    if (!found) return row;
    const others = [...found.values()];
    return Object.freeze({
      ...row,
      alsoFlaggedBy: Object.freeze(others.map(other => Object.freeze({
        domain: other.domain.label, findings: other.count, entryIds: Object.freeze(other.ids),
      }))),
      agrees: others.length,
      agreementNote: `Within ${withinMeters} m: `
        + `${others.map(other => `${other.count} from ${other.domain.label.toLowerCase()}`).join(', ')}. `
        + 'Two domains agreeing on a location is a reason to inspect it — not evidence that one '
        + 'caused the other, and the findings are not added together.',
    });
  });
}

/**
 * The whole queue.
 *
 * Sorted by urgency band, then by the domain's own quantity. Entries keep their domain so the UI
 * can filter to one, and the band rule travels with each row.
 */
export function buildPriorityQueue({
  hotspots = null, defects = [], hazards = null, observedSecondary: observed = null,
  sections = null, includeCrossDomain = true, limit = null,
} = {}) {
  const domainEntries = [
    ...hotspotEntries(hotspots, { sections }),
    ...assetEntries(defects, { sections }),
    ...hazardEntries(hazards, { sections }),
    ...secondaryEntries(observed, { sections }),
  ];
  const all = includeCrossDomain ? withCrossDomainLinks(domainEntries) : domainEntries;
  const sorted = all.sort((a, b) => b.urgency.rank - a.urgency.rank
    // Within a band, a location two domains point at comes first: same urgency, more to see.
    || (b.agrees ?? 0) - (a.agrees ?? 0)
    || (b.quantity ?? 0) - (a.quantity ?? 0)
    || String(a.title).localeCompare(String(b.title)));
  const counts = Object.fromEntries(Object.values(URGENCY)
    .map(band => [band.id, sorted.filter(row => row.urgency.id === band.id).length]));
  return Object.freeze({
    entries: Object.freeze(limit ? sorted.slice(0, limit) : sorted),
    total: sorted.length,
    counts: Object.freeze(counts),
    /** How many want each KIND of attention — what an operator actually plans around. */
    byAction: Object.freeze(Object.fromEntries(Object.values(ACTION)
      .map(action => [action.id, sorted.filter(row => row.actionUrgency?.id === action.id).length]))),
    byConfidence: Object.freeze(Object.fromEntries(Object.values(CONFIDENCE)
      .map(level => [level.id, sorted.filter(row => row.confidence?.id === level.id).length]))),
    bySection: Object.freeze(Object.fromEntries([...new Set(sorted.map(row => row.sectionId).filter(Boolean))]
      .map(id => [id, sorted.filter(row => row.sectionId === id).length]))),
    byDomain: Object.freeze(Object.fromEntries(Object.values(DOMAIN)
      .filter(domain => domain.id !== 'CROSS')
      .map(domain => [domain.id, sorted.filter(row => row.domain.id === domain.id).length]))),
    /** Entries that more than one domain points at — a filter, not an extra set of rows. */
    agreeing: sorted.filter(row => row.agrees).length,
    methodology: Object.freeze({
      summary: 'Each entry comes from one domain, is placed in an ordinal urgency band by a stated '
        + 'rule, and is ordered within that band by that domain’s own count.',
      noCompositeScore: 'No cross-domain numeric safety score is calculated. The domains share no unit '
        + 'and no validated weighting exists, so combining them into one number would be invented.',
      bands: Object.freeze(Object.values(URGENCY).map(band => band.label)),
      actions: 'Each entry also states the KIND of attention it wants — immediate response, urgent '
        + 'inspection, overdue maintenance, planned assessment or data validation — because a '
        + 'single "look now" on every top-band finding says nothing about what to do.',
      crossDomain: 'Where two domains point at the same location the entry says so. It is not '
        + 'listed twice and its urgency is not raised.',
      positions: 'Incident positions are asset-derived; defect and inspection positions come from the '
        + 'asset register.',
    }),
  });
}
