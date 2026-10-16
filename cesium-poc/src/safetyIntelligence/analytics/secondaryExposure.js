/**
 * Secondary incidents: what the register RECORDED, kept apart from what the TMC engine PREDICTS.
 *
 * Two different things get confused on safety dashboards, so they are separated here by type:
 *
 *   OBSERVED  — 40 of 178 records carry the assigned category "Secondary collision". That is a
 *               label a person put on a row. It is a count of records, nothing more.
 *   MODELLED  — the TMC screen's risk engine scores a LIVE incident's risk of causing another one.
 *               It is a prediction, and it never contributes to an observed count.
 *
 * The screen shows both and names which is which. Neither is a validated secondary-crash rate: the
 * corpus has no exposure data and no investigated causation.
 */
import { isElevated } from '../../tmc/secondaryIncidentRisk.js';
import { metresBetween } from './hotspots.js';

export const EVIDENCE_KIND = Object.freeze({
  OBSERVED: 'OBSERVED',
  MODELLED: 'MODELLED',
});

const isSecondaryLabelled = fact => /secondary/i.test(fact?.rootCauseCategory ?? '');

/**
 * The observed side: records the register itself labelled secondary, and how they differ from the
 * rest in the fields that are actually present.
 */
export function observedSecondary(facts = []) {
  const secondary = facts.filter(isSecondaryLabelled);
  const others = facts.filter(fact => !isSecondaryLabelled(fact));
  const share = collection => (collection.length
    ? Number(((collection.filter(fact => fact.laneClosure).length / collection.length) * 100).toFixed(0))
    : null);
  const severe = collection => (collection.length
    ? Number(((collection.filter(fact => fact.severity.rank >= 2).length / collection.length) * 100).toFixed(0))
    : null);
  return Object.freeze({
    kind: EVIDENCE_KIND.OBSERVED,
    records: Object.freeze(secondary),
    count: secondary.length,
    corpus: facts.length,
    laneClosureShare: share(secondary),
    laneClosureShareOthers: share(others),
    severeShare: severe(secondary),
    severeShareOthers: severe(others),
    byType: Object.freeze([...secondary.reduce((map, fact) => map.set(fact.type, (map.get(fact.type) ?? 0) + 1), new Map())]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)),
    basis: 'Records whose assigned root-cause category names a secondary collision.',
    caveat: 'A category assigned on the record, not an investigated finding. The register’s '
      + '`root_cause` field is empty on every record.',
  });
}

/**
 * Records that sit close in space and soon after another record — the register's own pattern of
 * one incident following another.
 *
 * This is a CO-OCCURRENCE search, and the wording says so. The positions are asset-derived, so two
 * records sharing a damaged asset share a position exactly, which is why `samePosition` is reported
 * separately from a genuine spatial neighbourhood.
 *
 * @param {object[]} facts incident facts in time order
 * @param {{withinMeters?: number, withinMinutes?: number}} [options]
 */
export function coOccurrences(facts = [], { withinMeters = 500, withinMinutes = 120 } = {}) {
  const located = facts.filter(fact => Number.isFinite(fact.longitude) && Number.isFinite(fact.latitude));
  const pairs = [];
  for (let i = 0; i < located.length; i += 1) {
    for (let j = i + 1; j < located.length; j += 1) {
      const minutes = (located[j].when.ms - located[i].when.ms) / 60_000;
      if (minutes < 0) continue;
      if (minutes > withinMinutes) break;
      const metres = metresBetween(located[i], located[j]);
      if (metres > withinMeters) continue;
      pairs.push(Object.freeze({
        first: located[i],
        second: located[j],
        minutesApart: Number(minutes.toFixed(0)),
        metresApart: Math.round(metres),
        samePosition: metres < 1,
        sameAsset: located[i].assetId && located[i].assetId === located[j].assetId,
        labelledSecondary: isSecondaryLabelled(located[j]),
      }));
    }
  }
  return Object.freeze({
    kind: EVIDENCE_KIND.OBSERVED,
    /** CANDIDATE pairs. Nothing in the register links one record to another. */
    pairs: Object.freeze(pairs),
    count: pairs.length,
    labelledSecondary: pairs.filter(pair => pair.labelledSecondary).length,
    /**
     * Verified primary-secondary relationships: none, and not because none happened.
     *
     * The register carries no field linking a record to the incident that caused it. A verified
     * pair needs that link, so this is null rather than zero, and a secondary RATE — which would
     * need both verified pairs and a defensible denominator — is not calculated anywhere.
     */
    verifiedPairs: null,
    verifiedPairsNote: 'No field in the register links a secondary record to its primary incident, '
      + 'so no pair here is verified and no secondary-incident rate is calculated.',
    window: Object.freeze({ withinMeters, withinMinutes }),
    basis: `Record pairs within ${withinMeters} m and ${withinMinutes} minutes of each other.`,
    caveat: 'Co-occurrence in the register. Because positions are asset-derived, two records on the '
      + 'same damaged asset share a position exactly — that is a shared asset, not a measured distance.',
  });
}

/**
 * The modelled side: the TMC's OWN assessments, read as they are.
 *
 * The model is defined for a live incident — it reads upstream congestion, concurrent closures, the
 * segment's operational level and the current weather. A historical register row carries none of
 * that, so running the engine over the corpus would be feeding it absences and reading the result
 * as risk. Instead this takes the TMC workspace's current assessments (`tmc.assessment`) unchanged,
 * so the two screens cannot disagree about a score, and reports how many LIVE incidents the model
 * currently puts at elevated risk. When the TMC has assessed nothing, this is null and the screen
 * says the model has nothing live to score rather than showing a zero.
 *
 * @param {object[]|null} assessments from assessCorridor() — `{incident, risk}` each
 */
export function modelledRisk(assessments = null) {
  if (!Array.isArray(assessments)) return null;
  const scored = assessments.filter(entry => entry?.risk?.level);
  const byLevel = new Map();
  for (const entry of scored) byLevel.set(entry.risk.level, (byLevel.get(entry.risk.level) ?? 0) + 1);
  return Object.freeze({
    kind: EVIDENCE_KIND.MODELLED,
    count: scored.length,
    elevated: scored.filter(entry => isElevated(entry.risk.level)).length,
    byLevel: Object.freeze([...byLevel].map(([level, count]) => Object.freeze({ level, count }))
      .sort((a, b) => b.count - a.count)),
    basis: 'The TMC screen’s secondary-risk model, as it has already scored the incidents live on '
      + 'the corridor now. Not run over the historical register, which carries none of the live '
      + 'conditions the model reads.',
    caveat: 'A prediction about live incidents, not a count of incidents that happened. Never add it '
      + 'to the observed secondary count.',
  });
}

/**
 * Both sides, side by side, with the distinction stated rather than implied.
 *
 * Three different things, never added together:
 *   1. how many records carry a secondary LABEL,
 *   2. how many pairs are candidates by closeness in time and space,
 *   3. what the live model scores for incidents running now.
 */
export function secondaryExposure(facts = [], { assessments = null } = {}) {
  const observed = observedSecondary(facts);
  return Object.freeze({
    observed,
    coOccurring: coOccurrences(facts),
    modelled: modelledRisk(assessments),
    distinction: 'Observed counts come from labels on past records. Modelled risk is a forward-looking '
      + 'score for a live incident. They answer different questions and are never summed.',
  });
}
