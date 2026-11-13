/**
 * How a candidate record is judged to be the evidence a case is missing.
 *
 * The rules are DATA. Each one states what it looks at, what it is worth and whether it is an
 * identifier — and the engine below is the only thing that evaluates them. Tuning the matching for
 * a new source means editing `MATCH_RULES`, not writing another scorer.
 *
 * The distinction that matters most here is between an EXACT match and a possible one. An exact
 * match is one where an identifier the two records SHARE lines up: the incident id, the work order
 * id, the asset id. Everything else — same place, same hour, same carriageway — is circumstantial,
 * however much of it accumulates, and is never presented as certainty. A repair 20 m away and 40
 * minutes later is a good lead and is not proof, which is why no amount of circumstantial weight
 * is allowed to reach the EXACT tier.
 */

/** How sure the engine is that a candidate is the missing record. */
export const MATCH_TIER = Object.freeze({
  /** An identifier shared by both records lines up. */
  EXACT: 'EXACT',
  /** Strong circumstantial agreement, but nothing the two records both name. */
  PROBABLE: 'PROBABLE',
  /** Enough to be worth a look. */
  POSSIBLE: 'POSSIBLE',
  /** Found by the search, not worth proposing on its own. */
  WEAK: 'WEAK',
});

/** Tier thresholds, in points. Only an identifier rule can reach EXACT. */
export const TIER_THRESHOLDS = Object.freeze({ PROBABLE: 40, POSSIBLE: 25 });

/**
 * Two candidates within this many points of each other are not distinguishable by the rules, so a
 * reviewer decides rather than the engine.
 */
export const AMBIGUITY_MARGIN = 8;

/** A candidate this far from the incident in time is reported as a timestamp mismatch. */
export const TIME_MISMATCH_MINUTES = 1440;

/** A candidate this far from the incident in space is reported as a location mismatch. */
export const LOCATION_MISMATCH_M = 500;

const near = (value, limit) => Number.isFinite(value) && Math.abs(value) <= limit;
const same = (a, b) => Boolean(a) && Boolean(b) && String(a) === String(b);

/**
 * The most a candidate can score without matching on any identifier.
 *
 * Rules in the same `group` are mutually exclusive — a distance is either within 50 m or within
 * 150 m, never both — so the ceiling is the best rule from each group, not the sum of all of them.
 *
 * This is the number that makes the EXACT tier mean something: as long as it stays below
 * `TIER_THRESHOLDS.PROBABLE`, no pile of circumstantial agreement can be presented as a strong
 * match. A test holds it there, so raising a weight cannot quietly erode the guarantee.
 */
export function maxCircumstantialScore(rules = MATCH_RULES) {
  const best = new Map();
  for (const rule of rules) {
    if (rule.identifier) continue;
    const key = rule.group ?? rule.id;
    best.set(key, Math.max(best.get(key) ?? 0, rule.weight));
  }
  return [...best.values()].reduce((total, weight) => total + weight, 0);
}

/**
 * The matching rules, in the order they are reported.
 *
 * `identifier: true` means a hit proves the link rather than suggesting it.
 */
export const MATCH_RULES = Object.freeze([
  {
    id: 'incident-id', label: 'Incident ID', weight: 45, identifier: true,
    test: (keys, context) => same(keys.incidentId, context.incidentId),
    explain: keys => `The record names incident ${keys.incidentId}, which is this case's own incident.`,
  },
  {
    id: 'work-order-id', label: 'Work order ID', weight: 40, identifier: true,
    test: (keys, context) => same(keys.workOrderId, context.workOrderId),
    explain: keys => `The record names work order ${keys.workOrderId}, which is this case's own work order.`,
  },
  {
    id: 'asset-id', label: 'Asset ID', weight: 30, identifier: true,
    test: (keys, context) => same(keys.assetId, context.assetId),
    explain: keys => `The record names asset ${keys.assetId}, the asset this case is about.`,
  },
  {
    id: 'location-tight', group: 'location', label: 'Location (within 50 m)', weight: 15,
    test: keys => near(keys.locationDistanceM, 50),
    explain: keys => `Captured ${Math.round(keys.locationDistanceM)} m from the incident location.`,
  },
  {
    id: 'location-loose', group: 'location', label: 'Location (within 150 m)', weight: 8,
    test: keys => near(keys.locationDistanceM, 150) && !near(keys.locationDistanceM, 50),
    explain: keys => `Captured ${Math.round(keys.locationDistanceM)} m from the incident location.`,
  },
  {
    id: 'time-tight', group: 'time', label: 'Within 2 hours of the incident', weight: 12,
    test: keys => near(keys.minutesFromIncident, 120),
    explain: keys => `Recorded ${Math.abs(Math.round(keys.minutesFromIncident))} minutes from the incident time.`,
  },
  {
    id: 'time-loose', group: 'time', label: 'Within 12 hours of the incident', weight: 6,
    test: keys => near(keys.minutesFromIncident, 720) && !near(keys.minutesFromIncident, 120),
    explain: keys => `Recorded ${Math.abs(Math.round(keys.minutesFromIncident / 60))} hours from the incident time.`,
  },
  {
    id: 'direction', label: 'Same carriageway', weight: 5,
    test: (keys, context) => same(keys.direction, context.direction),
    explain: keys => `Same carriageway (${keys.direction}).`,
  },
].map(Object.freeze));

/**
 * Everything the engine noticed about one candidate that a reviewer should not have to spot.
 *
 * These never change the score. A warning is a reason to look, not a reason to score lower: a
 * record that is genuinely the right one can still have been filed a day late.
 */
export function warningsFor(candidate, context, { identifierMatched = false } = {}) {
  const keys = candidate.keys ?? {};
  const out = [];
  // Time and distance are only worth warning about when they are part of WHY the engine thinks
  // these records belong together. A repair filed three days after the crash it answers is normal,
  // and saying so against a record whose work-order id matches exactly would be noise that teaches
  // a reviewer to ignore the warnings that matter.
  if (!identifierMatched
    && Number.isFinite(keys.minutesFromIncident) && Math.abs(keys.minutesFromIncident) > TIME_MISMATCH_MINUTES) {
    out.push({
      kind: 'TIMESTAMP_MISMATCH',
      text: `The record is timestamped ${Math.abs(Math.round(keys.minutesFromIncident / 1440))} day(s) `
        + 'from the incident. It may belong to different work at the same place.',
    });
  }
  if (!identifierMatched
    && Number.isFinite(keys.locationDistanceM) && keys.locationDistanceM > LOCATION_MISMATCH_M) {
    out.push({
      kind: 'LOCATION_MISMATCH',
      text: `The record was captured ${Math.round(keys.locationDistanceM)} m from the incident, `
        + 'which is further than this corridor\'s assets are apart.',
    });
  }
  if (keys.assetId && context.assetId && String(keys.assetId) !== String(context.assetId)) {
    out.push({
      kind: 'ASSET_MISMATCH',
      text: `The record names asset ${keys.assetId}; this case is about ${context.assetId}. `
        + 'One of the two is wrong, or the record is about a neighbouring asset.',
    });
  }
  if (candidate.conflict) {
    out.push({ kind: 'CONFLICTING_EVIDENCE', text: candidate.conflict });
  }
  return Object.freeze(out);
}

/**
 * Score one candidate against the case.
 *
 * @param {object} candidate  a record a connector returned
 * @param {{incidentId?: string, assetId?: string, workOrderId?: string, direction?: string}} context
 * @param {object[]} [rules]  the rule set, overridable per deployment
 */
export function scoreCandidate(candidate, context, rules = MATCH_RULES) {
  const keys = candidate?.keys ?? {};
  const matched = rules.filter(rule => {
    try { return rule.test(keys, context) === true; } catch { return false; }
  });
  const score = matched.reduce((total, rule) => total + rule.weight, 0);
  const identifierHit = matched.some(rule => rule.identifier);

  const tier = identifierHit ? MATCH_TIER.EXACT
    : score >= TIER_THRESHOLDS.PROBABLE ? MATCH_TIER.PROBABLE
      : score >= TIER_THRESHOLDS.POSSIBLE ? MATCH_TIER.POSSIBLE
        : MATCH_TIER.WEAK;

  return Object.freeze({
    ...candidate,
    score,
    tier,
    /** Capped below certainty on purpose: nothing here is ever 100%. */
    confidence: Math.min(99, score),
    matchedRules: Object.freeze(matched.map(rule =>
      Object.freeze({ id: rule.id, label: rule.label, weight: rule.weight, identifier: Boolean(rule.identifier) }))),
    /** Why the engine thinks so, in the rules' own words. */
    explanation: matched.length
      ? matched.map(rule => rule.explain(keys, context)).join(' ')
      : 'The search returned this record, but no matching rule is satisfied by it.',
    warnings: warningsFor(candidate, context, { identifierMatched: identifierHit }),
  });
}

/**
 * Rank the candidates that could resolve one missing field.
 *
 * `requiresReview` is the question "can the engine tell these apart on its own?" — not "is the top
 * one good?". A single exact match needs no review; two strong candidates for one slot always do,
 * because picking the higher score would be the engine inventing a tie-break it does not have.
 */
export function rankCandidates(candidates, context, rules = MATCH_RULES) {
  const scored = candidates
    .map(candidate => scoreCandidate(candidate, context, rules))
    .sort((a, b) => b.score - a.score || String(a.recordId).localeCompare(String(b.recordId)));

  const [best, second] = scored;
  const tooClose = Boolean(second) && best.score - second.score <= AMBIGUITY_MARGIN;
  const exactCount = scored.filter(entry => entry.tier === MATCH_TIER.EXACT).length;
  // A conflict ANYWHERE in the group is a reason to stop, not just a conflict on the front runner:
  // two records that contradict each other mean one of them is wrong about this asset, and which
  // one is not a question a score can settle.
  const conflicting = scored.filter(entry =>
    entry.warnings.some(warning => warning.kind === 'CONFLICTING_EVIDENCE'));
  const requiresReview = !best ? false
    : best.warnings.length > 0
      || conflicting.length > 0
      || best.tier !== MATCH_TIER.EXACT
      || exactCount > 1
      || (tooClose && second.tier === MATCH_TIER.EXACT);

  return Object.freeze({
    candidates: Object.freeze(scored),
    best: best ?? null,
    requiresReview,
    reviewReason: !best ? null
      : best.warnings.length ? best.warnings[0].text
        : conflicting.length
          ? `${conflicting[0].recordId} contradicts the leading record: ${conflicting[0].conflict}`
          : exactCount > 1 ? `${exactCount} records each match on an identifier; only one can be the right record.`
            : best.tier !== MATCH_TIER.EXACT
              ? 'No identifier shared by both records matches, so the link is circumstantial.'
              : null,
  });
}
